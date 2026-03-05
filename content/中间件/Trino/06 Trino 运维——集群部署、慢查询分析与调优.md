---
title: "Trino 运维——集群部署、慢查询分析与调优"
date: 2026-03-05
tags: [中间件, Trino, 运维, 部署, 慢查询, 调优, 监控, Kubernetes, 性能]
aliases: []
---

# Trino 运维——集群部署、慢查询分析与调优

## 摘要

将 Trino 从单机测试推进到支撑生产业务的集群，需要解决三类工程问题：**如何正确规划和部署 Trino 集群**（节点规格选型、JVM 配置、Coordinator HA）；**如何在查询出现性能问题时快速定位根因**（通过 Trino Web UI、EXPLAIN ANALYZE、慢查询日志分析执行计划、Stage 耗时、数据倾斜等）；以及**如何针对不同业务场景做系统性调优**（参数配置、资源组规划、数据格式优化）。本文系统覆盖上述三个维度，提供可直接参考的生产配置样例、慢查询排查的标准流程，以及常见生产问题的根因分析与解决方案，帮助工程师建立对 Trino 生产运维的完整认知。

---

## 第 1 章 集群规划与节点规格选型

### 1.1 Coordinator 与 Worker 的职责再确认

在规划集群时，首先明确两类节点的资源特点：

**Coordinator** 的资源消耗特点：
- **CPU 占用**：SQL 解析、执行计划生成、任务调度——这些操作的计算量与查询复杂度成正比，而非数据量。即使扫描 1TB 数据，Coordinator 的 CPU 占用也远低于 Worker
- **内存占用**：主要是查询状态（每个活跃查询的执行计划、任务状态、临时结果缓冲）。在高并发场景（100+ 并发查询），Coordinator 内存可能成为瓶颈
- **推荐规格**：16~32 核 CPU，64~128 GB 内存，普通 SATA SSD 即可

**Worker** 的资源消耗特点：
- **CPU 占用**：算子计算（Filter、Aggregation、HashJoin、Sort）——CPU 密集型，高配多核 CPU 有直接收益
- **内存占用**：Hash Table、Sort Buffer、Exchange Buffer——越大越好，大内存减少 Spill 频率
- **磁盘**：主要用于 Spill（溢写到磁盘的临时数据），要求高 IOPS 的 NVMe SSD
- **网络**：Stage 间 Shuffle 通过网络传输，高带宽网络（25GbE/100GbE）对 Shuffle 密集型查询有显著提升
- **推荐规格**：32~64 核 CPU，256~512 GB 内存，NVMe SSD（用于 Spill），25GbE 网卡

### 1.2 集群规模与节点数量规划

集群规模的规划依据有三个维度：

**并发查询数量**：每个并发查询至少需要 1 个 Driver 线程在 Worker 上运行（通常远不止 1 个）。粗略估算：若目标支持 50 个并发查询，每个查询平均占用 20 个 Driver 线程，总需 1000 个 Driver 线程。若每个 Worker 有 32 核，配置 `task.concurrency=32`（Driver 线程数 = 32），则约需 1000/32 ≈ 32 个 Worker。

**内存需求**：每个 Worker 的内存需满足：
```
Worker 内存 >= (并发查询数 / Worker 数) × 单查询峰值内存
例：50 并发查询，32 个 Worker，单查询峰值内存 8GB：
每个 Worker 约同时处理 50/32 ≈ 2 个查询 × 8GB = 16GB 峰值
建议 Worker 内存：16 × 2（安全系数）= 32GB（最低）
```

**吞吐量（扫描速度）**：若业务要求某类查询在 10 秒内完成，该查询需扫描 10TB 数据，则：
```
每个 Worker 的 HDFS/S3 读取速度约 500 MB/s（实际受网络、Connector 限制）
需要读取 10TB / 10s = 1 TB/s
需要 Worker 数 = 1TB/s / 500MB/s = 2000 个 Worker（显然过多）
→ 说明此查询需要优化（分区裁剪、动态过滤）而非靠堆 Worker 解决
```

### 1.3 JVM 配置

Trino Worker 的 JVM 配置直接影响性能稳定性，`jvm.config` 关键配置：

```
# Worker jvm.config
-server
-Xmx128G                                    # 堆内存，通常为物理内存的 70%~80%
-XX:+UseG1GC                                # G1 GC（推荐，低停顿）
-XX:G1HeapRegionSize=32M                    # G1 Region 大小（大堆用大 Region）
-XX:+ExplicitGCInvokesConcurrent            # 显式 GC 也走并发模式
-XX:+ExitOnOutOfMemoryError                 # OOM 时立即退出（由进程管理器重启，避免僵死状态）
-XX:+HeapDumpOnOutOfMemoryError             # OOM 时生成堆转储（便于事后分析）
-XX:HeapDumpPath=/var/trino/heap-dump/
-XX:InitialRAMPercentage=70.0
-XX:MaxRAMPercentage=80.0
-Djdk.attach.allowAttachSelf=true           # 允许 JVM 自我诊断（jstack 等工具需要）
-Djdk.nio.maxCachedBufferSize=2000000       # NIO 缓冲区优化

# 禁用 JVM 默认的内存限制（让 Trino 自己管理）
-XX:-UseBiasedLocking
```

**G1 GC vs ZGC**：对于超大堆（> 256 GB），ZGC（Java 15+）的暂停时间更短（< 1ms），优于 G1 的百毫秒级暂停。但 ZGC 的 CPU 开销略高（并发 GC 线程持续占用 CPU）。对于 Trino Worker 而言，短暂的 GC 暂停会导致 Driver 执行中断，影响查询 P99 延迟——若 Worker 内存超过 128GB，建议考虑 ZGC。

---

## 第 2 章 生产配置文件参考

### 2.1 完整的 config.properties 配置

```properties
# ===== Coordinator config.properties =====
coordinator=true
node-scheduler.include-coordinator=false    # Coordinator 不参与查询执行（生产建议）
http-server.http.port=8080
discovery.uri=http://coordinator-host:8080

# 查询内存限制
query.max-memory=200GB                      # 单查询全集群内存上限
query.max-memory-per-node=16GB             # 单查询单节点内存上限
query.max-total-memory-per-node=32GB        # 单查询单节点总内存（含系统内存）
query.max-total-memory=400GB

# 查询超时
query.max-execution-time=4h                # 单个查询最大执行时间
query.max-run-time=8h

# 并发控制
query.queue-config-file=/etc/trino/resource-groups.json

# 优化器配置
optimizer.join-reordering-strategy=AUTOMATIC
optimizer.use-cost-based-optimizer=true

# 动态过滤
enable-dynamic-filtering=true
dynamic-filtering.large-broadcast.max-size-per-driver=100MB

# Exchange 配置
exchange.client-threads=25
exchange.max-buffer-size=32MB

# 节点管理
node-manager.expire-interval=30s           # Worker 心跳超时
node-manager.heartbeat-interval=5s
```

```properties
# ===== Worker config.properties =====
coordinator=false
http-server.http.port=8080
discovery.uri=http://coordinator-host:8080

# 内存
query.max-memory-per-node=16GB
query.max-total-memory-per-node=32GB
memory.heap-headroom-per-node=20GB        # 为系统保留 20GB（JVM 自身、Netty、Connector 缓冲）

# 任务执行
task.concurrency=32                        # Worker 的 Driver 执行线程数，通常等于 CPU 核数
task.max-driver-run-time=1s               # 每个 Driver 每次执行的最大时间片

# Spill 配置
spill-enabled=true
spill-path=/data/trino-spill              # NVMe SSD 路径
max-spill-per-node=200GB
query.max-spill-per-node=50GB

# 网络
http-server.http.port=8080
internal-communication.https.required=false  # 内网可以关闭 HTTPS
```

### 2.2 Kubernetes 部署

对于云原生部署，Trino 官方提供了 Helm Chart：

```bash
helm repo add trino https://trinodb.github.io/charts
helm repo update

# 创建 values.yaml
cat > trino-values.yaml << 'EOF'
coordinator:
  replicas: 1
  resources:
    requests:
      cpu: "16"
      memory: "64Gi"
    limits:
      cpu: "32"
      memory: "128Gi"
  jvm:
    maxHeapSize: "96G"
    gcMethod:
      type: "UseG1GC"
      g1:
        heapRegionSize: "32M"
  config:
    query.max-memory: "200GB"
    query.max-memory-per-node: "16GB"

worker:
  replicas: 20
  resources:
    requests:
      cpu: "32"
      memory: "256Gi"
    limits:
      cpu: "64"
      memory: "384Gi"
  jvm:
    maxHeapSize: "280G"
  config:
    task.concurrency: "64"
    spill-enabled: "true"

  # 挂载 NVMe SSD 用于 Spill
  extraVolumes:
    - name: spill-volume
      hostPath:
        path: /mnt/nvme/trino-spill

  extraVolumeMounts:
    - name: spill-volume
      mountPath: /data/trino-spill

additionalCatalogs:
  hive: |
    connector.name=hive
    hive.metastore.uri=thrift://hive-metastore:9083
  iceberg: |
    connector.name=iceberg
    iceberg.catalog.type=hive_metastore
    hive.metastore.uri=thrift://hive-metastore:9083
EOF

helm install trino trino/trino --namespace trino --create-namespace -f trino-values.yaml
```

### 2.3 Coordinator 高可用（HA）

生产环境必须为 Coordinator 配置 HA，防止单点故障导致集群不可用。Trino 支持基于**共享状态存储**的 Active-Standby HA：

```properties
# Coordinator HA 配置（Trino 414+）
# Active Coordinator
coordinator=true
node-scheduler.include-coordinator=false

# HA 配置
query-tracker.enabled=true
# 将查询状态持久化到外部存储（MySQL 或 PostgreSQL）
query-state-store-provider=jdbc
query-state-store.db.url=jdbc:mysql://ha-db-host:3306/trino_state
query-state-store.db.user=trino
query-state-store.db.password=...
```

当 Active Coordinator 宕机，Standby Coordinator 检测到（通过外部存储的心跳锁）后切换为 Active，已完成的查询状态可以从外部存储恢复，未完成的查询需要重新提交（Trino 目前不支持查询的透明恢复）。

---

## 第 3 章 Trino Web UI——运维的第一窗口

### 3.1 Web UI 的核心功能

Trino 内置了功能强大的 Web UI（`http://coordinator:8080/ui/`），是日常运维的首要工具：

**查询列表视图（Query List）**：
- 显示所有活跃查询和历史查询（默认保留最近 100 个）
- 每个查询显示：查询 ID、提交用户、状态（RUNNING/FINISHED/FAILED）、已扫描行数、内存使用、CPU 时间、墙钟时间
- 支持按状态过滤（找所有 RUNNING 或 FAILED 的查询）
- 点击查询 ID 进入详情页

**查询详情视图（Query Detail）**：
- **Overview Tab**：查询的 SQL 文本、Session 参数、资源消耗总览（CPU 时间、扫描行数、峰值内存）
- **Live Plan Tab**：执行计划的实时可视化图（各 Stage 之间的数据流，节点颜色表示执行进度）
- **Stage Performance Tab**：每个 Stage 的时间分布（输入行数、输出行数、CPU 时间、阻塞时间）
- **Tasks Tab**：每个 Task 的详细信息（在哪个 Worker 上执行、耗时、数据量）
- **Split Tab**：Split 的调度和执行情况

### 3.2 通过 Web UI 识别问题

**识别数据倾斜**：在 Stage Performance Tab 中，若某个 Stage 的各 Task 耗时差异很大（如 P50=5s，P99=120s），说明存在**数据倾斜**——某些 Task 处理的数据量远多于其他 Task。

常见原因：
- GROUP BY key 的值分布不均（某个 key 的记录数远多于其他 key）
- JOIN key 存在热点值（如大量 `null` 值被路由到同一 Task）

**识别 Exchange 瓶颈**：若某个 Stage 的 `Blocked Time`（阻塞时间）很长，通常说明该 Stage 的 Task 在等待上游 Stage 的数据（Exchange 缓冲区为空）或下游 Task 消费速度过慢（Exchange 缓冲区满）。

**识别内存问题**：在 Overview Tab 的 `Peak Memory Usage` 中，若某个查询的内存峰值接近 `query.max-memory`，说明查询接近内存上限，可能会触发 Spill 甚至 OOM。

---

## 第 4 章 慢查询分析方法论

### 4.1 慢查询分析的标准流程

当用户反馈某个查询很慢时，按以下步骤分析：

**Step 1：确认是慢还是失败**

通过 Web UI 找到对应查询，确认状态（FINISHED 但耗时长 vs FAILED）。若是 FAILED，查看错误信息（通常是 OOM、超时或 Connector 异常）。

**Step 2：查看查询的资源消耗概况**

在查询详情的 Overview Tab：
- `Total CPU Time`：所有 Worker 消耗的 CPU 总时长。若 CPU Time >> Wall Clock Time × Worker 数，说明计算密集型（可能是大量 Shuffle 或 Hash Join）；若 CPU Time << Wall Clock Time × Worker 数，说明 IO 或网络阻塞
- `Input Rows / Input Data`：实际扫描的数据量。若与预期不符（如预期扫描 1GB，实际扫描 1TB），说明分区裁剪未生效
- `Peak Memory Usage`：内存峰值。若接近或超过 `query.max-memory`，Spill 可能是主要延迟来源

**Step 3：用 EXPLAIN ANALYZE 分析执行计划**

```sql
EXPLAIN ANALYZE SELECT ...（慢查询的 SQL）;
```

EXPLAIN ANALYZE 会实际执行查询，并在执行计划的每个节点上标注运行时统计（实际输入/输出行数、CPU 时间等）。重点关注：

- **行数估算误差**：若某个节点的估算行数（Estimates）与实际行数（Actual）差异超过 10 倍，说明统计信息不准确，CBO 可能做出了错误的决策
- **哪个 Stage 消耗了最多 CPU**：CPU 时间最长的 Stage 通常是优化的重点
- **哪个 Operator 的输出行数异常大**：若某个 FilterOperator 的输出行数远大于预期（说明过滤条件没有生效），需要检查过滤条件是否正确推到了 TableScan

**Step 4：检查是否有数据倾斜**

在 Stage Performance Tab 的 Tasks 列表，查看各 Task 的 `Input Rows` 和 `CPU Time`：

```
Task 0: Input Rows = 100M,  CPU Time = 120s  ← 热点 Task
Task 1: Input Rows = 1M,    CPU Time = 2s
Task 2: Input Rows = 2M,    CPU Time = 3s
...
Task N: Input Rows = 1.5M,  CPU Time = 2s
```

若 Task 0 的处理量远超其他 Task，整个 Stage 的完成时间由 Task 0 决定，其他 Task 完成后都在等待 Task 0。

**Step 5：检查 Connector 行为**

若 TableScan 的 `Input Rows` 远超预期，检查：
- 分区裁剪是否生效（通过 EXPLAIN 的 IO 类型：`EXPLAIN (TYPE IO) ...`）
- 是否使用了正确的分区列（WHERE 子句中的列名是否与分区列完全匹配）
- 统计信息是否最新（`SHOW STATS FOR table_name`）

### 4.2 典型慢查询场景与解决方案

**场景一：分区裁剪失效**

```sql
-- 问题 SQL（分区列 dt 是 VARCHAR，但传入的是 DATE 类型）
SELECT * FROM behavior_log
WHERE dt = DATE '2024-01-15';   -- 类型不匹配，导致无法分区裁剪

-- 修复
WHERE dt = '2024-01-15';        -- VARCHAR 类型直接传字符串
```

**场景二：GROUP BY 数据倾斜**

```sql
-- 按 event_type 分组，但某个 event_type 有 90% 的数据（如 'page_view'）
SELECT event_type, count(*) FROM behavior_log GROUP BY event_type;
```

解决方案：

```sql
-- 方案 1：两阶段随机分桶聚合（打散热点 key）
SELECT event_type, sum(cnt)
FROM (
    SELECT event_type, count(*) AS cnt,
           cast(rand() * 100 AS int) AS bucket    -- 随机分桶
    FROM behavior_log
    GROUP BY event_type, bucket                    -- 第一阶段：带桶的部分聚合
) GROUP BY event_type;                             -- 第二阶段：合并各桶

-- 方案 2：使用 approx_distinct 或 HyperLogLog 避免精确聚合
SELECT event_type, approx_distinct(user_id) AS approx_uv
FROM behavior_log GROUP BY event_type;
```

**场景三：大表 JOIN 没有触发动态过滤**

通过 EXPLAIN 发现大表的 TableScan 没有动态过滤应用（没有 `DynamicFilter` 节点），检查：
1. JOIN 类型是否为 Inner JOIN（Left JOIN 不触发动态过滤）
2. Build 侧（小表）估算大小是否超过了 `dynamic-filtering.large-broadcast.max-size-per-driver`
3. 统计信息是否准确（若小表行数被高估，CBO 可能认为太大而不触发广播）

```sql
-- 检查是否有动态过滤应用
EXPLAIN (TYPE DISTRIBUTED) SELECT ...;
-- 若 TableScan 节点下有 "DynamicFilter" 显示，则已启用动态过滤
```

**场景四：Spill 导致查询极慢**

```sql
-- 通过查询 API 确认是否发生了 Spill
SELECT query_id, spilled_bytes, total_cpu_time
FROM system.runtime.queries
WHERE query_id = '20240315_001_...'
  AND spilled_bytes > 0;
```

若 `spilled_bytes` 很大，说明查询内存不足。解决方案：
1. 增大 `query.max-memory-per-node`（若 Worker 有空闲内存）
2. 改用压缩率更高的聚合近似算法（`approx_distinct` 代替 `count(distinct)`）
3. 在资源组中降低该查询类型的并发数，确保每个查询有足够内存

---

## 第 5 章 监控体系建设

### 5.1 关键 Prometheus 指标

Trino 通过 JMX 暴露指标，可以通过 `jmx_exporter` 导出到 Prometheus。关键指标：

**集群健康指标**：

| 指标 | 含义 | 告警阈值建议 |
|------|------|------------|
| `trino_cluster_active_workers` | 活跃 Worker 数量 | < 预期 Worker 数 |
| `trino_cluster_queued_queries` | 排队中的查询数 | > 50（持续 5 分钟） |
| `trino_cluster_running_queries` | 运行中的查询数 | - |
| `trino_cluster_failed_queries_total` | 失败查询总数（Counter） | 增速异常时告警 |

**查询性能指标**：

| 指标 | 含义 | 告警阈值建议 |
|------|------|------------|
| `trino_query_execution_time_p99` | 查询执行时间 P99 | > 业务 SLA 的 2 倍 |
| `trino_query_peak_memory_bytes_p99` | 查询峰值内存 P99 | > `query.max-memory × 70%` |
| `trino_query_spilled_bytes_total` | Spill 总量 | 持续增长时告警 |

**Worker 资源指标**：

| 指标 | 含义 | 告警阈值建议 |
|------|------|------------|
| `jvm_memory_bytes_used{area="heap"}` | JVM 堆内存使用 | > 85% 堆大小 |
| `jvm_gc_collection_seconds_p99` | GC 停顿时间 P99 | > 500ms（对于 G1 GC） |
| `process_cpu_usage` | CPU 使用率 | > 90%（持续 5 分钟） |

### 5.2 Grafana Dashboard 配置

推荐使用 Trino 社区维护的 Grafana Dashboard（GitHub: `trinodb/trino` 的 `docker/trino-grafana` 目录），导入后可以看到：

- **Cluster Overview**：活跃 Worker 数、QPS、P99 延迟、内存使用趋势
- **Query Analysis**：查询成功/失败率、排队时间分布、内存分布
- **Worker Details**：各 Worker 的 CPU/内存/GC 状态
- **Resource Group**：各资源组的并发查询数、排队情况、内存使用

### 5.3 慢查询日志

配置 Trino 的慢查询日志，记录超过阈值的查询：

```properties
# coordinator config.properties
# 记录执行时间超过 60 秒的查询
query.slow-query-log-enabled=true
query.slow-query-log-threshold=60s
```

慢查询日志格式（JSON）：
```json
{
  "queryId": "20240315_001_...",
  "user": "analyst_alice",
  "source": "dbeaver",
  "query": "SELECT ...",
  "queryState": "FINISHED",
  "wallTime": "120s",
  "cpuTime": "3600s",
  "inputRows": 1000000000,
  "inputBytes": 1048576000000,
  "peakMemory": "32GB",
  "spilledBytes": 0,
  "failureMessage": null
}
```

---

## 第 6 章 常见生产问题排查手册

### 6.1 查询 OOM（EXCEEDED_GLOBAL_MEMORY_LIMIT）

**错误信息**：
```
Query failed: EXCEEDED_GLOBAL_MEMORY_LIMIT:
Query exceeded per-node user memory limit of 16.00GB [Allocated: 15.87GB, Delta: 1.00GB]
```

**排查步骤**：
1. 通过 Web UI 查看该查询的内存分配明细（Tasks Tab → 找到内存最高的 Task）
2. 确认哪个 Operator 消耗了大量内存（通常是 HashAggregation 或 HashBuild）
3. 检查 GROUP BY / JOIN 的 key 基数——若 key 基数很高，内存占用与 NDV 成正比
4. 若可以接受近似结果，改用 `approx_distinct`、`approx_percentile` 等近似函数

**修复方案**：
```sql
-- 方案 1：增大内存（Session 级别临时调大，需要资源组允许）
SET SESSION query_max_memory_per_node = '32GB';

-- 方案 2：启用 Spill
SET SESSION spill_enabled = true;
SET SESSION operator_memory_limit_before_spill = '8GB';

-- 方案 3：改用近似函数
-- 原：count(distinct user_id)
-- 改：approx_distinct(user_id)
```

### 6.2 查询挂起（RUNNING 但无进展）

**现象**：查询显示 RUNNING 状态，但长时间没有输出，CPU 使用极低。

**可能原因**：

1. **死锁（非常罕见）**：两个 Stage 互相等待对方的 Exchange 数据。检查 Stage 的 `Input Rows` 是否长时间为 0
2. **Connector 连接超时**：HiveConnector 连接 HMS 超时（HMS 过载），导致 Split 生成卡住。检查 Coordinator 日志中是否有 HMS 连接超时的警告
3. **Worker 磁盘 Spill 慢**：Spill 到磁盘时，磁盘 IO 成为瓶颈，导致 Driver 进入 BLOCKED 状态，外观看起来像挂起。检查 Worker 的磁盘 IO 使用率

### 6.3 集群 Worker 频繁掉线

**现象**：Web UI 中 Worker 数量周期性减少，日志中有 `Worker node xxx has been inactive for xxx seconds` 的记录。

**可能原因**：

1. **Worker GC Pause 过长**：G1 GC 的 Full GC 可能暂停数十秒，超过 `node-manager.expire-interval=30s`。检查 Worker 的 GC 日志，若有频繁 Full GC，说明内存配置不当（堆内存分配过多导致 GC 开销大）
2. **网络抖动**：Worker 与 Coordinator 之间的网络不稳定，心跳包丢失。检查网络监控
3. **Worker OOM 后重启**：若配置了 `-XX:+ExitOnOutOfMemoryError`，OOM 后 Worker 立即退出，由进程管理器重启（Kubernetes 的 Liveness Probe 也会重启 OOM 的 Pod）。检查 Worker 的 OOM 日志

---

## 第 7 章 本专栏回顾

### 7.1 Trino 专栏知识体系总结

本 Trino 专栏从架构全局出发，逐层深入到执行引擎、存储接入、资源管理、查询优化，最终以运维实战收尾：

- **[[01 Trino 全局架构——Coordinator Worker 与 MPP 执行]]**：MPP 内存流水线为何比 Hive 的磁盘物化快 10~100 倍，Coordinator-Worker 主从架构的职责划分
- **[[02 查询执行引擎——Stage、Task 与 Pipeline]]**：六层执行层次（Query → Stage → Task → Split → Pipeline → Driver → Operator），Pull 驱动模型与背压机制
- **[[03 Connector 体系——Hive、Iceberg 与联邦查询]]**：Connector SPI 的三大原则，Hive 的分区裁剪与 ORC 文件级过滤，Iceberg 的元数据层次与核心优势
- **[[04 内存管理与资源调度]]**：三级内存配额体系，资源组多租户隔离，Spill 的触发机制与代价
- **[[05 查询优化——CBO、动态过滤与索引下推]]**：RBO 规则集，CBO 的统计信息与 JOIN 重排序，动态过滤的运行时谓词下推
- **本文**：集群部署规划，慢查询分析五步法，生产问题排查手册

### 7.2 Trino 的核心工程价值

Trino 的工程价值在于：**通过内存流水线执行和存储无关的 Connector 体系，在不移动数据的前提下，为分散在多个异构存储中的数据提供统一的、接近实时的 SQL 分析能力**。这在数据量超过单机能力、数据分散在多个系统、业务需要 ad-hoc 探索的企业数据分析场景中，是当前技术栈最合理的选择之一。

理解 Trino 的关键洞见是：**它的性能优势来自于"减少不必要的 IO 和 Shuffle"（分区裁剪、动态过滤、列裁剪），而非"更快地处理已经读取的数据"**。大多数慢查询的根因都是数据读取量过大，而非 CPU 计算慢。这个认识是所有 Trino 调优工作的出发点。
