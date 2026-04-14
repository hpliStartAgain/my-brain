---
type: task
status: done
priority: P0
deadline: 2026-03-27
domain: 集群可观测建设
lifecycle: engineering
progress: "100"
completed_date: 2026-03-26
started_date: 2026-03-23
---

## 🎯 目标与验收标准

Alloy 正式部署前的四项前置验证，消除 `host_jobs.sls` 中所有 TODO 标记，确保上线不踩坑。

- [x] `[TODO-MINION-ID]` 各集群所有目标主机的 `grains['id']` 已核实，与 `host_jobs.sls` 中的 key 完全一致 ✅ 2026-03-26
- [x] `[TODO-PATH]` 所有服务日志路径（HDFS/YARN/Hive/HBase/ZK）已在目标主机确认存在 ✅ 2026-03-26
- [x] `[TODO-GC]` GC 日志文件名格式已确认（`gc-2026*.log` 还是 `gc.log-2026*`），`host_jobs.sls` 中的 glob 已更新 ✅ 2026-03-26
- [x] `alloy` 用户对各服务日志目录有读权限（`su -s /bin/sh alloy -c "cat <log_path>"` 通过） ✅ 2026-03-26

## ⚙️ 执行路径

### Step 1：批量获取 grains['id']

```bash
# H3 离线集群
salt -G 'cluster:h3offline' grains.get id

# H3 实时集群
salt 'rtrm*' grains.get id

# H3/H2 冷存
salt -G 'cluster:ec' grains.get id
```

对比输出与 `host_jobs.sls` 的 key，**大小写和连字符都要一致**。

### Step 2：批量验证日志路径

```bash
# 抽查 NameNode 节点
salt 'dnn014023' cmd.run 'ls /var/log/hadoop/hdfs/'

# 抽查 ResourceManager
salt 'drm014016' cmd.run 'ls /var/log/hadoop/yarn/'

# 抽查 HiveServer2
salt 'dsrv014020' cmd.run 'ls /var/log/hive/'

# 抽查 HBase RegionServer（GC 日志格式确认）
salt 'ddn013031' cmd.run 'ls /var/log/hbase/ | head -20'
```

### Step 3：确认 alloy 用户权限

```bash
# 确认 alloy 用户存在并能读日志（在 alloy 已安装的测试节点执行）
salt '<test-node>' cmd.run 'su -s /bin/sh alloy -c "cat /var/log/hadoop/hdfs/*.log" | head -5'
```

若权限不足，处理方式：
```bash
# 方式一：将 alloy 加入 hadoop 组
usermod -aG hadoop alloy

# 方式二：setfacl 追加读权限（不修改原始权限）
setfacl -R -m u:alloy:r-x /var/log/hadoop/
```

### Step 4：更新 host_jobs.sls 中的 TODO

验证完毕后，替换 `host_jobs.sls` 中所有 `[TODO-*]` 标记并提交：

```bash
cd salt-states
git add src/install_alloy/_pillar/install_alloy/host_jobs.sls
git commit -m "fix(alloy): 验证并修正 minion-id、日志路径与 GC glob"
```

## 🐛 踩坑日志 (Troubleshooting)
-
