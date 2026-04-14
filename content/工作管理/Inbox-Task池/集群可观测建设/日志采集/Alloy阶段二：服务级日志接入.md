---
type: task
status: done
priority: P1
deadline: 2026-03-27
domain: 集群可观测建设
lifecycle: engineering
progress: "100"
completed_date: 2026-03-26
started_date: 2026-03-26
---

## 🎯 目标与验收标准

在阶段一（系统日志）稳定运行后，逐步为各节点追加服务级日志采集（`host_jobs`），按集群、按组件分步下发。

**前置条件**：[[Alloy阶段一：全集群系统日志上线]] 完成，Alloy 在所有节点运行正常。

- [x] 第1步：H3离线 Hadoop（NameNode、DataNode、ResourceManager、NodeManager）日志接入 ✅ 2026-03-26
- [x] 第2步：H3离线 Hive（HiveServer2、HiveMetaStore）日志接入 ✅ 2026-03-26
- [x] 第3步：H3离线其他组件（HBase RegionServer、ZooKeeper）日志接入 ✅ 2026-03-26
- [x] 第4步：H3实时集群服务级日志接入 ✅ 2026-03-26
- [ ] 第5步：冷存集群服务级日志接入
- [x] Loki 中各服务可按 `{service_name, cluster, role}` 精确查询，多行聚合生效 ✅ 2026-03-26

## ⚙️ 执行路径

### 追加服务日志的标准流程

**Step 1**：确认 minion ID 与日志路径（已由预部署验证完成）

**Step 2**：确认 `host_jobs.sls` 中对应主机的配置无 TODO 标记

**Step 3**：下发配置（仅更新 pillar，触发 alloy 重启）

```bash
# 以 H3离线 NameNode 为例
salt 'dnn014023' state.apply install_alloy
```

**Step 4**：验证日志写入

```bash
# 等待 30s 后查询 Loki
# {service_name="hadoop-hdfs", cluster="H3离线", role="namenode", instance="dnn014023"}
```

### 按步骤下发计划

#### 第1步：H3离线 Hadoop

```bash
# NameNode 节点
salt -L 'dnn014023,dnn014024,...,dnn014030' state.apply install_alloy

# ResourceManager 节点
salt -L 'drm014016,drm014017' state.apply install_alloy

# DataNode/NodeManager 节点（按批）
salt -G 'cluster:h3offline and roles:datanode' state.apply install_alloy
```

验证：
```logql
{service_name="hadoop-hdfs", cluster="H3离线"} | limit 20
{service_name="hadoop-yarn", cluster="H3离线"} | limit 20
```

#### 第2步：H3离线 Hive

```bash
salt -L 'dnn014012,dnn014013,dnn014014,dnn014015,dsrv014020,dsrv014021,dsrv014022' state.apply install_alloy
```

验证：
```logql
{service_name="hive-hs2", cluster="H3离线"} | limit 20
{service_name="hive-hms", cluster="H3离线"} | limit 20
```

#### 第3步：H3离线 HBase/ZooKeeper

```bash
# HBase RegionServer（30+ 节点，分批）
salt -G 'cluster:h3offline and roles:regionserver' state.apply install_alloy
```

验证：
```logql
{service_name="hbase", role="regionserver", log_type="service"} | limit 20
{service_name="hbase", log_type="gc"} |= "Full GC" | limit 20
```

#### 第4步：H3实时集群

```bash
salt 'rtrm*' state.apply install_alloy
```

#### 第5步：冷存集群

```bash
salt -G 'cluster:ec' state.apply install_alloy
```

## 📝 注意事项

- GC 日志 glob 使用年份前缀 `gc-2026*.log`，**2027年初需更新**
- 每批下发后观察 `journalctl -u alloy -n 50` 无报错再继续下一批
- 若某节点 `host_jobs` 中服务日志路径不存在，alloy 会静默跳过（不报错），需通过 Loki 查询确认数据写入

## 🐛 踩坑日志 (Troubleshooting)
-
