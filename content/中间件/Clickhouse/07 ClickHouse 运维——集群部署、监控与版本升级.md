---
title: "07 ClickHouse 运维——集群部署、监控与版本升级"
date: 2026-03-05
tags: [ClickHouse, Doris, Prometheus, StarRocks, system表, 版本升级, 监控, 运维, 集群部署]
aliases: []
---

# 07 ClickHouse 运维——集群部署、监控与版本升级

## 摘要

ClickHouse 的运维复杂度介于 MySQL 和 Ceph 之间——比单节点数据库复杂（需要管理 Shard/Replica 拓扑、ZooKeeper 协调层），但比 Ceph 简单（守护进程种类少，故障模式相对可预期）。本文从 SRE 视角梳理 ClickHouse 的生产运维体系：Shard+Replica 拓扑规划、`system.*` 表的监控体系、Prometheus 关键指标与告警、滚动升级策略，以及与 [[Doris]]/StarRocks 的选型决策框架。

---

## 第 1 章 集群部署拓扑规划

### 1.1 硬件选型原则

ClickHouse 是 IO 密集型 + 计算密集型的混合负载，硬件配置直接决定了查询性能上限：

**CPU**：ClickHouse 的向量化执行充分利用多核，建议 32-96 核的高核数服务器。支持 AVX2 或 AVX-512 的 CPU 能显著提升 SIMD 计算性能（在购买服务器时需确认 CPU 型号支持的指令集）。

**内存**：内存大小决定了可以缓存的数据量和 GROUP BY 聚合的规模。经验值：每 TB SSD 存储配置 8-16GB 内存；对于高并发场景（同时执行几十个查询），需要更多内存（每个查询可能占用数 GB HashTable）。

**磁盘**：
- **热数据（近 3 个月）**：NVMe SSD，提供低延迟随机读（稀疏索引查找需要随机 seek）
- **冷数据（3 个月以上）**：SATA SSD 或 HDD（通过 Storage Policy 将旧分区自动迁移）
- **RAID**：ClickHouse 通过副本（ReplicatedMergeTree）提供可靠性，不需要硬件 RAID。单块磁盘的 RAID-0 性能最好；如果需要比副本更强的本地保护，可用 RAID-10

**网络**：节点间数据传输（副本同步、Distributed 查询结果合并）需要低延迟网络，建议 25GbE 或 100GbE。

### 1.2 Shard 与 Replica 数量规划

**Shard 数量**决定了存储容量的水平扩展上限和查询的最大并行度：

```
Shard 数量 = ceil(总数据量 / 单 Shard 目标存储量)

单 Shard 目标存储量经验值：
  - 热数据：NVMe SSD 容量 × 70%（留 30% 空余用于 Merge 操作）
  - 全量：单节点 SSD+HDD 总容量 × 70%
```

查询并行度最大值 = Shard 数量 × 每 Shard 的 CPU 线程数。

**Replica 数量**决定了可用性级别：
- **1 Replica（无副本）**：单点故障时数据不可用，适用于可以接受短暂中断的非关键业务
- **2 Replica**：最常见配置，单节点故障时自动切换，无数据丢失
- **3 Replica**：最高可用性，支持两个节点同时故障，适用于关键生产系统

### 1.3 ClickHouse Keeper 的部署

ClickHouse 22.x+ 推荐使用内置的 **ClickHouse Keeper** 替代外部 ZooKeeper，简化运维：

```xml
<!-- 在独立节点或 ClickHouse 节点上启用 Keeper -->
<keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>  <!-- 每个 Keeper 节点唯一 ID -->
    <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
    <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
    <coordination_settings>
        <operation_timeout_ms>10000</operation_timeout_ms>
        <session_timeout_ms>30000</session_timeout_ms>
    </coordination_settings>
    <raft_configuration>
        <server>
            <id>1</id>
            <hostname>keeper-1</hostname>
            <port>9234</port>
        </server>
        <server>
            <id>2</id>
            <hostname>keeper-2</hostname>
            <port>9234</port>
        </server>
        <server>
            <id>3</id>
            <hostname>keeper-3</hostname>
            <port>9234</port>
        </server>
    </raft_configuration>
</keeper_server>
```

Keeper 采用 Raft 共识协议，建议部署 3 或 5 个节点（奇数），可以与 ClickHouse 节点共存（小集群）或独立部署（大集群）。

---

## 第 2 章 system.* 表——内置监控体系

ClickHouse 的 `system` 数据库包含数十张只读系统表，是最直接的运维和诊断工具，不需要外部监控工具即可完成大多数日常诊断。

### 2.1 核心系统表速查

**`system.parts`**——Part 状态监控：

```sql
-- 查看各表的 Part 数量和总大小
SELECT
    database,
    table,
    partition,
    count()              AS parts_count,
    sum(rows)            AS total_rows,
    formatReadableSize(sum(bytes_on_disk)) AS disk_size,
    max(modification_time) AS last_modified
FROM system.parts
WHERE active = 1  -- 只看活跃 Part（未被合并的）
GROUP BY database, table, partition
ORDER BY parts_count DESC
LIMIT 20;
```

`parts_count` 过高（> 100 per partition）说明 Merge 跟不上写入速度，需要降低写入频率或增加 Merge 线程数。

**`system.merges`**——后台合并监控：

```sql
-- 查看正在进行的 Merge
SELECT
    table,
    partition,
    elapsed,
    progress,
    formatReadableSize(total_size_bytes_compressed) AS size,
    num_parts,
    result_part_name
FROM system.merges
ORDER BY elapsed DESC;
```

**`system.query_log`**——历史查询分析：

```sql
-- 慢查询分析（过去 1 小时）
SELECT
    user,
    query_duration_ms,
    read_rows,
    formatReadableSize(read_bytes) AS read_bytes,
    formatReadableSize(memory_usage) AS memory,
    query
FROM system.query_log
WHERE type = 'QueryFinish'
    AND query_start_time >= now() - INTERVAL 1 HOUR
    AND query_duration_ms > 5000
ORDER BY query_duration_ms DESC
LIMIT 20;
```

**`system.replicas`**——副本同步状态：

```sql
-- 检查副本同步延迟
SELECT
    database, table, replica_name,
    is_leader,
    inserts_in_queue,
    merges_in_queue,
    log_max_index - log_pointer AS replication_lag
FROM system.replicas
WHERE replication_lag > 0 OR inserts_in_queue > 0
ORDER BY replication_lag DESC;
```

**`system.mutations`**——Mutation 进度：

```sql
-- 查看未完成的 Mutation
SELECT
    database, table, mutation_id,
    command,
    create_time,
    parts_to_do,
    is_done
FROM system.mutations
WHERE is_done = 0
ORDER BY create_time;
```

**`system.processes`**——当前正在运行的查询：

```sql
-- 查看正在运行的查询及资源消耗
SELECT
    query_id,
    user,
    elapsed,
    read_rows,
    formatReadableSize(memory_usage) AS memory,
    formatReadableSize(peak_memory_usage) AS peak_memory,
    query
FROM system.processes
ORDER BY memory_usage DESC;

-- 终止长时间运行的查询
KILL QUERY WHERE query_id = 'xxx-yyy-zzz';
```

---

## 第 3 章 Prometheus 监控体系

### 3.1 启用 Prometheus Exporter

ClickHouse 内置了 Prometheus 格式的指标暴露端口，在 `config.xml` 中启用：

```xml
<prometheus>
    <endpoint>/metrics</endpoint>
    <port>9363</port>
    <metrics>true</metrics>
    <events>true</events>
    <asynchronous_metrics>true</asynchronous_metrics>
</prometheus>
```

### 3.2 关键监控指标

**集群整体健康**：

```promql
# 正在运行的查询数（应保持在合理范围内，通常 < 20）
ClickHouseMetrics_Query

# 后台 Merge 任务数
ClickHouseMetrics_BackgroundPoolTask

# 副本同步队列大小（应保持接近 0）
ClickHouseMetrics_ReplicatedChecks
```

**存储健康**：

```promql
# 磁盘使用率（按表、磁盘分类）
ClickHouseDiskDataBytes / ClickHouseDiskTotalBytes

# Part 数量告警（分区内 Part 过多）
ClickHouseMetrics_PartsActive
```

**查询性能**：

```promql
# 查询执行时间 P99（ms）
histogram_quantile(0.99, rate(ClickHouseProfileEvents_QueryTimeMicroseconds_bucket[5m])) / 1000

# 每秒读取行数
rate(ClickHouseProfileEvents_SelectedRows[1m])

# 每秒 Merge 的字节数（后台 Merge 压力）
rate(ClickHouseProfileEvents_MergedRows[1m])
```

### 3.3 告警规则示例

```yaml
groups:
  - name: clickhouse
    rules:
      # 查询延迟过高
      - alert: ClickHouseSlowQueries
        expr: histogram_quantile(0.99, rate(ClickHouseProfileEvents_QueryTimeMicroseconds_bucket[5m])) / 1e6 > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "ClickHouse P99 查询延迟超过 30 秒"

      # Part 数量过多（可能导致 too many parts）
      - alert: ClickHouseTooManyParts
        expr: ClickHouseMetrics_PartsActive > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "ClickHouse Part 总数超过 10000，可能发生 too many parts"

      # 副本同步积压
      - alert: ClickHouseReplicationLag
        expr: ClickHouseMetrics_ReplicatedChecks > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "ClickHouse 副本同步积压，超过 100 个待同步操作"

      # 磁盘空间告警
      - alert: ClickHouseDiskUsageHigh
        expr: ClickHouseDiskDataBytes / ClickHouseDiskTotalBytes > 0.8
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "ClickHouse 磁盘使用率超过 80%"
```

---

## 第 4 章 版本升级——滚动重启策略

### 4.1 ClickHouse 的版本管理

ClickHouse 的版本号格式：`YY.M.PATCH`（如 `24.3.2.23`）。每年 3 月和 8 月发布 **LTS（Long-Term Support）版本**，维护周期 1 年；其他月份发布常规版本，只维护 3-6 个月。

**生产建议**：生产集群使用 LTS 版本（如 23.8、24.3），避免频繁跟进非 LTS 版本带来的兼容性风险。

### 4.2 滚动升级流程

ClickHouse 支持在线滚动升级（不需要停机），但需要按 Replica 逐个升级，确保集群高可用：

```bash
# Step 1：检查集群当前状态，确保无副本同步积压
clickhouse-client --query "SELECT database, table, replica_name, replication_lag FROM system.replicas WHERE replication_lag > 0;"

# Step 2：在一个节点上升级（以节点 node-1b 为例）
# 先停止 ClickHouse 服务
systemctl stop clickhouse-server

# 安装新版本（deb 包）
dpkg -i clickhouse-server_24.3.2.23_amd64.deb
dpkg -i clickhouse-client_24.3.2.23_amd64.deb

# 启动新版本
systemctl start clickhouse-server

# Step 3：等待该节点的副本同步完成（replication_lag 归零）
clickhouse-client --query "SELECT replication_lag FROM system.replicas LIMIT 5;"

# Step 4：验证该节点查询正常
clickhouse-client --query "SELECT count() FROM system.tables;"

# Step 5：重复 Step 2-4，升级集群内所有其他节点
```

**升级注意事项**：
- 每次只升级一个节点，等前一个节点完全恢复后再升级下一个
- ClickHouse 版本跨度不宜太大（最好逐个次版本升级，不要跳版本），防止数据格式不兼容
- 升级前备份 `config.xml` 和 `users.xml`，新版本可能有配置项变更
- 注意 ZooKeeper/Keeper 的路径格式变化（部分版本升级需要迁移 ZooKeeper 数据）

> [!warning] 生产避坑：升级前检查 Breaking Changes
> ClickHouse 每个版本都有 Changelog，其中标注了 Breaking Changes（不向后兼容的变更）。升级前必须阅读目标版本的 Changelog，重点关注：
> - 函数行为变化（如某些 SQL 函数在新版本返回不同类型）
> - 配置项重命名或废弃
> - 存储格式变化（通常有向后兼容，但某些极少数情况不兼容）
> 建议在测试环境充分验证后再在生产集群升级。

---

## 第 5 章 ClickHouse vs Doris vs StarRocks——选型决策框架

在 OLAP 系统选型中，ClickHouse、[[Doris]]、StarRocks 三者功能重叠度高，如何选择是工程团队常见的困惑。

### 5.1 核心差异分析

| 维度 | ClickHouse | Doris | StarRocks |
| :--- | :--- | :--- | :--- |
| **单表大数据量聚合** | 极佳（稀疏索引+向量化） | 好 | 好 |
| **多表关联查询** | 一般（分布式 JOIN 能力弱） | 好（完整 CBO + Shuffle JOIN） | 极佳（全向量化 CBO） |
| **实时数据写入** | 好（批量写入高吞吐） | 极好（Stream Load、Routine Load） | 极好（Primary Key 实时更新） |
| **数据更新/删除** | 差（Mutation 异步重写） | 好（Unique Key 模型） | 好（Primary Key 实时更新） |
| **运维复杂度** | 中（ZooKeeper/Keeper + 手动 DDL） | 中（FE/BE 两种进程） | 中（FE/BE 两种进程） |
| **SQL 兼容性** | 良（大量方言，与标准 SQL 有差异） | 好（兼容 MySQL 语法） | 好（兼容 MySQL 语法） |
| **生态成熟度** | 很高（早期开源，社区大） | 高（Apache 项目） | 中（较新，快速发展） |
| **云原生支持** | 一般（存算不分离） | 好（存算分离版 Doris 3.0） | 好（存算分离 Shared-Nothing/Shared-Data） |

### 5.2 选型建议

**选 ClickHouse 的场景**：
- **日志分析、监控指标存储**：时序单表查询为主，高吞吐写入，不需要频繁更新删除（如 [[Elasticsearch]] 的替代方案）
- **事件追踪、点击流分析**：用户行为数据，超大数据量单表聚合（按 user_id/date 分组统计）
- **已有 ClickHouse 积累**：团队有 ClickHouse 运维经验，不需要迁移

**选 Doris 的场景**：
- **多维数据分析**：宽表模型 + 复杂多表 JOIN，如数据仓库中的业务报表
- **实时数据对接**：Flink CDC 实时同步 MySQL 变更数据（Doris 的 Unique Key 模型天然支持 UPSERT）
- **替代 Hive 做 OLAP 加速**：通过 Hive Catalog 直接查询 Hive 数据，零迁移成本

**选 StarRocks 的场景**：
- **高并发点查 + OLAP 混合**：StarRocks 对并发查询的优化更好（Primary Key 表的点查接近 Redis 量级）
- **超大规模集群**：StarRocks 的存算分离架构对 Kubernetes 原生支持更好，弹性扩缩容更容易
- **极致的复杂查询性能**：StarRocks 的 CBO 和全向量化执行在多表关联场景接近或超越 ClickHouse 的单表查询性能

---

## 第 6 章 小结

ClickHouse 的运维重点是：

1. **Part 健康监控**：通过 `system.parts` 持续监控 Part 数量，防止 too many parts 问题
2. **副本同步监控**：通过 `system.replicas` 监控 `replication_lag`，及时发现副本落后
3. **慢查询治理**：定期分析 `system.query_log`，发现并优化慢查询
4. **磁盘空间预警**：在达到 80% 之前启动扩容或清理流程

版本升级采用滚动重启策略，逐节点升级，充分利用 ReplicatedMergeTree 的高可用能力实现零停机升级。

在 OLAP 系统选型时，ClickHouse 是单表大数据量聚合的最优选择，Doris/StarRocks 在多表 JOIN 和实时数据更新场景更具优势——三者互补而非完全竞争。

---

**延伸阅读**：
- [[05 分布式表与数据分片]]
- [[01 Doris 全局架构——FE BE 分离与 MPP 执行]]
- [[01 Trino 全局架构——Coordinator Worker 与 MPP 执行]]

---

> [!note] 思考题
> 1. SharedMergeTree 是 ClickHouse Cloud 的核心引擎——数据存储在对象存储（S3）上，计算节点无状态。这实现了计算与存储分离——计算节点可以弹性扩缩容。与传统的 ReplicatedMergeTree（每个副本存储完整数据）相比，SharedMergeTree 的存储成本降低了多少？但对象存储的延迟（~10ms）比本地 NVMe（~100μs）高 100 倍——SharedMergeTree 如何通过本地缓存弥补这个差距？
> 2. 计算存储分离后，多个计算节点共享同一份数据。并发写入（INSERT）时，不同节点可能同时创建新 part——需要协调避免冲突。SharedMergeTree 使用什么机制来协调并发写入？与 Delta Lake/Iceberg 的乐观并发控制相比有什么异同？
> 3. ClickHouse 正在从单机数据库演进为云原生数据平台。这种演进对开源社区版本意味着什么？社区版是否能使用 SharedMergeTree？开源版本与商业云版本的功能差异如何影响用户的选型决策？
