---
type: task
status: done
priority: P1
deadline: 2026-03-28
domain: 集群日常运维
lifecycle: engineering
progress: "100"
completed_date: 2026-03-26
started_date: 2026-03-26
---

# 冷存 RM 节点日志目录迁移与滚动配置

## 背景

冷存集群 ResourceManager 节点 `/var` 文件系统使用率超过 90%，`/var/log/hadoop-yarn` 日志目录占用 6.8G，且未配置日志滚动。需将日志目录迁移至数据盘，并开启 RollingFileAppender，避免日志持续撑爆 `/var`。

- **rm1（原 Active）**：ddn130111
- **rm2（原 Standby）**：dnn130161（先操作）
- 冷存集群可执行停服操作

---

## 变更内容

| 变更项 | 详情 |
|---|---|
| 日志目录 | `/var/log/hadoop-yarn` → 软链至 `/data_b/log/hadoop-yarn` |
| 日志滚动 | `yarn-env.sh` 显式 `export HADOOP_ROOT_LOGGER=INFO,RFA` |
| 变更方式 | Ambari `yarn-env.sh` 模板 + 手动建链 + RM 重启 |

---

## 前置检查

```bash
# 确认 /var 使用率
df -h /var

# 确认当前日志目录大小与结构
du -sh /var/log/hadoop-yarn/*
ls -la /var/log/hadoop-yarn

# 确认数据盘可用空间
df -h /data_b

# 确认当前 RM 状态（Active/Standby）
yarn rmadmin -getServiceState rm1
yarn rmadmin -getServiceState rm2
```

---

## 实际执行记录（2026-03-26）

### Step 1：Ambari 修改 yarn-env.sh

在 Ambari → YARN → Configs → Advanced yarn-env → `yarn-env.sh` 中修改：

```bash
# 在 HADOOP_OPTS 赋值行之前加上显式 export，覆盖 hadoop-env.sh 中的预设值
# ⚠️ 坑：${HADOOP_ROOT_LOGGER:-INFO,RFA} 仅在变量未设置时生效，
#         hadoop-env.sh 已将其设为 INFO,console，导致 :- 默认值永远不生效
#         必须用显式 export 覆盖，不能只改 :- 默认值
export HADOOP_ROOT_LOGGER=INFO,RFA

HADOOP_OPTS="$HADOOP_OPTS -Dhadoop.root.logger=${HADOOP_ROOT_LOGGER:-INFO,RFA}"
HADOOP_OPTS="$HADOOP_OPTS -Dyarn.root.logger=${HADOOP_ROOT_LOGGER:-INFO,RFA}"
```

保存配置，**暂不点 Restart**。

---

### Step 2：Standby RM（dnn130161）建软链 ✅

```bash
# 1. Ambari Stop dnn130161 的 ResourceManager

# 2. 创建目标目录并设置属主
#    ⚠️ 坑：必须 chown 目标目录本身，chown -h 只改软链节点，不影响目标目录
mkdir -p /data_b/log/hadoop-yarn
chown -R yarn:hadoop /data_b/log/hadoop-yarn

# 3. rsync 历史日志（先同步再建链，避免历史日志断档）
rsync -a /var/log/hadoop-yarn/ /data_b/log/hadoop-yarn/
find /var/log/hadoop-yarn -type f | wc -l
find /data_b/log/hadoop-yarn -type f | wc -l  # 确认数量一致

# 4. 替换为软链
mv /var/log/hadoop-yarn /var/log/hadoop-yarn.bak.20260326
ln -s /data_b/log/hadoop-yarn /var/log/hadoop-yarn
# 结果：lrwxrwxrwx 1 root root 23 Mar 26 10:29 hadoop-yarn -> /data_b/log/hadoop-yarn
# 软链属主 root:root 是预期内的，内核穿透软链检查目标目录权限，不影响 yarn 写入

# 5. Ambari Start dnn130161 的 ResourceManager
```

### Step 3：验证 rm2 变更生效 ✅

```bash
# 日志已写入新路径，文件名变为 hadoop.log（非原来的 .out 文件）
# ⚠️ 注意：切换到 RFA 后日志文件名变化：
#   - console 模式：stdout 被重定向到 hadoop-yarn-resourcemanager-{hostname}.out
#   - RFA 模式：直接写 $HADOOP_LOG_DIR/hadoop.log（由 HADOOP_LOGFILE 变量控制）
tail -f /data_b/log/hadoop-yarn/yarn/hadoop.log

# RM 进入 Standby 正常
yarn rmadmin -getServiceState rm2  # standby

# /var/log/hadoop-yarn.bak.20260326 已确认 rsync 完整后删除
rm -rf /var/log/hadoop-yarn.bak.20260326
```

---

### Step 4：HA 主备切换

> 目的：rm2（130161）提升为 Active，rm1（130111）降为 Standby。

**踩坑记录**：

| 命令 | 结果 |
|---|---|
| `yarn rmadmin -failover rm1 rm2` | 命令不存在，此版本无该子命令 |
| `yarn rmadmin -transitionToActive --forcemanual rm2` | ZKFC 开启时拒绝：`Refusing to manually manage HA state` |

**实际可用方式**：

```bash
# 方式一：先降 rm1，ZKFC 自动提升 rm2（rm2 重启后 ZKFC 已完成自动切换）
yarn rmadmin -transitionToStandby rm1

# 方式二：显式强制提升 rm2
yarn rmadmin -transitionToActive --forceactive rm2

# 验证
yarn rmadmin -getServiceState rm1   # standby
yarn rmadmin -getServiceState rm2   # active
```

> **观察**：rm2 重启进入健康状态后，ZKFC 已自动将 rm1 降为 Standby，切换可能在 Step 3 后即已完成。

---

### Step 5：原 Active RM（ddn130111）建软链（进行中）

等待高峰期作业结束期间，提前完成不需要停服的预操作：

```bash
# 在 130.111 执行（RM 仍在运行，不影响）
mkdir -p /data_b/log/hadoop-yarn
chown -R yarn:hadoop /data_b/log/hadoop-yarn
df -h /data_b   # 确认空间

# 预 rsync（先做一遍大头，停服后只需增量同步，缩短停机窗口）
rsync -a /var/log/hadoop-yarn/ /data_b/log/hadoop-yarn/
```

待作业结束后：

```bash
# Stop ddn130111 的 ResourceManager
# 增量 rsync
rsync -a /var/log/hadoop-yarn/ /data_b/log/hadoop-yarn/
# 建链
mv /var/log/hadoop-yarn /var/log/hadoop-yarn.bak.$(date +%Y%m%d)
ln -s /data_b/log/hadoop-yarn /var/log/hadoop-yarn
# Start ResourceManager
```

### Step 6：验收与清理（待执行）

```bash
# 两台节点验证
yarn rmadmin -getServiceState rm1
yarn rmadmin -getServiceState rm2
df -h /var                          # 使用率应降至 70% 以下
ls -la /var/log/hadoop-yarn         # 应为软链
tail -f /data_b/log/hadoop-yarn/yarn/hadoop.log

# 确认正常后清理 130.111 备份
rm -rf /var/log/hadoop-yarn.bak.*
```

---

## 验收标准

- [x] `/var` 文件系统使用率降至 70% 以下（两台） ✅ 2026-03-26
- [x] dnn130161 `/var/log/hadoop-yarn` 为软链 → `/data_b/log/hadoop-yarn`
- [x] ddn130111 `/var/log/hadoop-yarn` 为软链 → `/data_b/log/hadoop-yarn` ✅ 2026-03-26
- [x] rm2 日志写入 `/data_b/log/hadoop-yarn/yarn/hadoop.log`，RFA 生效
- [x] rm1 日志写入数据盘，RFA 生效 ✅ 2026-03-26
- [x] 两台 RM 正常一主一备，HA 未受影响 ✅ 2026-03-26
- [x] Ambari yarn-env.sh 配置无橙标残留 ✅ 2026-03-26

---

## 回滚方案

```bash
# 停止 RM
# 删除软链，恢复备份目录
rm /var/log/hadoop-yarn
mv /var/log/hadoop-yarn.bak.YYYYMMDD /var/log/hadoop-yarn
# Ambari 回滚 yarn-env.sh（删除 export HADOOP_ROOT_LOGGER=INFO,RFA）
# 重启 RM
```

---

## 经验教训

1. **`${VAR:-default}` 陷阱**：`hadoop-env.sh` 已预设 `HADOOP_ROOT_LOGGER=INFO,console`，`:-` 默认值不会覆盖已设置的变量，必须显式 `export HADOOP_ROOT_LOGGER=INFO,RFA`。
2. **`chown -h` 陷阱**：只改软链文件节点本身的属主，不影响目标目录，RM 写入时会 Permission Denied。必须 `chown -R` 目标目录。
3. **RFA 模式日志文件名变化**：切换后不再产生 `.out` 文件，日志写入 `hadoop.log`，文件名由 `HADOOP_LOGFILE` 控制，可显式设置为更有辨识度的名称。
4. **HA 切换命令**：此版本无 `-failover` 子命令；ZKFC 开启时 `--forcemanual` 被拒，可用 `-transitionToStandby rm1` 或 `--forceactive`。
5. **软链属主 root:root 正常**：内核解析路径时穿透软链，权限检查在目标目录，软链属主不影响访问控制。
6. **rsync 后再建链**：先 rsync 历史日志到新目录再建软链，避免 YARN Web UI 历史作业日志断档；停服后做增量 rsync 缩短停机时间。

---

## 关联信息

- 参考：`/var/log/hadoop` 已是软链 → `/data_b/ambari-log/hadoop`，本次保持一致风格
- RFA 默认：256MB 滚动，保留 20 个文件，上限约 5GB
