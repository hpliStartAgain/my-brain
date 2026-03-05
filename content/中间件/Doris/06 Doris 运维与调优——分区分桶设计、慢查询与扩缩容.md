---
title: "06 Doris 运维与调优——分区分桶设计、慢查询与扩缩容"
date: 2026-03-05
tags: [Doris, 运维, 分区设计, 分桶设计, 慢查询, 扩缩容, Compaction, 监控, SRE]
aliases: []
---

# 06 Doris 运维与调优——分区分桶设计、慢查询与扩缩容

## 摘要

Doris 的运维体系围绕三个核心问题展开：如何设计合理的分区分桶策略（影响查询并行度和数据倾斜）、如何快速定位和优化慢查询（利用 Profile 和 audit_log 工具链）、以及如何平稳地进行 BE 节点扩缩容（数据均衡与副本迁移）。本文从 SRE 视角系统梳理 Doris 生产运维的关键操作和调优思路，重点阐明每个操作背后的"为什么"，而不仅仅是"怎么做"。

---

## 第 1 章 分区分桶设计——建表最重要的决策

### 1.1 分区策略设计

分区（Partition）是 Doris 数据管理的粗粒度单元，合理的分区设计同时影响查询剪枝效果和数据生命周期管理（过期删除）。

**按时间分区（最常见模式）**：

```sql
-- 范围分区（RANGE）：最常用，适合时序数据
CREATE TABLE orders (
    date        DATE NOT NULL,
    order_id    BIGINT,
    user_id     BIGINT,
    amount      DECIMAL(10, 2),
    status      VARCHAR(20)
) ENGINE = OLAP
DUPLICATE KEY(date, order_id)
-- 手动建立分区
PARTITION BY RANGE(date) (
    PARTITION p202401 VALUES LESS THAN ('2024-02-01'),
    PARTITION p202402 VALUES LESS THAN ('2024-03-01'),
    PARTITION p202403 VALUES LESS THAN ('2024-04-01')
)
-- 动态分区：自动创建未来分区、自动删除过期分区
PROPERTIES (
    "dynamic_partition.enable" = "true",
    "dynamic_partition.time_unit" = "MONTH",
    "dynamic_partition.start" = "-6",       -- 保留过去 6 个月
    "dynamic_partition.end" = "1",          -- 提前创建未来 1 个月
    "dynamic_partition.prefix" = "p",
    "dynamic_partition.buckets" = "32"
)
DISTRIBUTED BY HASH(user_id) BUCKETS 32;
```

**动态分区（Dynamic Partition）**是生产中的最佳实践：FE 后台自动创建新分区（防止未来数据写入失败）和删除过期分区（实现数据 TTL），无需人工干预。

**分区粒度的选择原则**：

| 数据量 | 推荐分区粒度 | 理由 |
| :---: | :---: | :--- |
| 每天 < 1亿行 | 按月分区 | 分区内数据量适中，分区文件数不会太多 |
| 每天 1-10亿行 | 按周分区 | 周分区平衡分区数量和分区内数据量 |
| 每天 > 10亿行 | 按天分区 | 单分区数据量过大，需要细化 |

分区粒度过细（如 10 亿行数据按天分区，每天数亿行）会导致 Tablet 数量爆炸（分区数 × 分桶数），FE 元数据压力大，Compaction 线程分散，反而降低性能。

### 1.2 分桶策略设计

分桶（Bucket）决定了数据在 BE 节点间的分布，直接影响查询并行度和 JOIN 性能。

**分桶键的选择**：

分桶键应选择**高基数**（不同值多）且**高频出现在 WHERE 条件或 JOIN 条件**中的列：

```sql
-- 用户分析场景：大量查询按 user_id 过滤
DISTRIBUTED BY HASH(user_id) BUCKETS 32;

-- 订单场景：经常 JOIN orders 和 order_items
-- 两张表都按 order_id 分桶，JOIN 时数据本地（Collocate Join）
-- orders 表：
DISTRIBUTED BY HASH(order_id) BUCKETS 32;
-- order_items 表：
DISTRIBUTED BY HASH(order_id) BUCKETS 32;
-- 建立 Collocate Group，相同 order_id 的数据在同一 BE
PROPERTIES ("colocate_with" = "order_group");
```

**分桶数量的计算**：

```
分桶数 = ceil(分区预期数据量 / 单 Tablet 目标大小)
单 Tablet 目标大小：100MB-1GB（建议 200-400MB）

示例：每月 100GB 数据
分桶数 = ceil(100GB / 300MB) ≈ 333 → 取最近的 2 的幂次或整百 → 256 或 320
```

> [!warning] 生产避坑：分桶数不可变
> Doris 的分桶数（BUCKETS）在建表后**无法直接修改**（需要重建表并重新导入数据）。建表时必须根据数据量预估合理的分桶数，预留一定的增长空间（建议按预期最大数据量计算，而不是当前数据量）。
> 分桶数过少：随着数据增长，单 Tablet 越来越大，查询并行度不足；Compaction 每次处理的数据量大，耗时长。
> 分桶数过多：Tablet 数量多，FE 元数据开销大；单 Tablet 数据量少，每次查询需要打开大量小 Tablet 文件，IO 开销反而高。

### 1.3 Colocate Join——消除分布式 JOIN 的 Shuffle

当两张频繁 JOIN 的大表按相同的分桶键和相同的分桶数分布时，相同键值的数据必然在同一 BE 节点上，JOIN 时完全不需要网络 Shuffle（两侧数据都在本地），性能可以提升 5-10 倍。

```sql
-- 建立 Collocate Group
CREATE TABLE orders (
    order_id  BIGINT,
    ...
) ENGINE = OLAP
DISTRIBUTED BY HASH(order_id) BUCKETS 32
PROPERTIES ("colocate_with" = "order_group");

CREATE TABLE order_items (
    order_id  BIGINT,
    ...
) ENGINE = OLAP
DISTRIBUTED BY HASH(order_id) BUCKETS 32
PROPERTIES ("colocate_with" = "order_group");  -- 同一 group

-- 查询时自动使用 Colocate Join（无 Shuffle）
SELECT o.*, i.*
FROM orders o JOIN order_items i
ON o.order_id = i.order_id;
```

**Colocate Join 的约束**：
- 两表的分桶键必须相同（类型也要相同）
- 两表的分桶数必须相同
- 两表都在同一个 `colocate_with` 分组中

---

## 第 2 章 慢查询分析与优化

### 2.1 Query Profile——查询执行的 X 光片

Doris 的 **Query Profile** 是分析查询性能问题的核心工具，记录了查询执行的每个算子的时间消耗、数据处理量、内存使用等详细信息。

```sql
-- 开启 Profile 收集（Session 级别）
SET enable_profile = true;

-- 执行查询
SELECT region, SUM(amount) FROM orders WHERE date >= '2024-01-01' GROUP BY region;

-- 在 Doris WebUI 查看 Profile（http://fe_host:8030/QueryProfile）
-- 或通过 SQL 查询
SELECT query_id, sql, query_start_time, query_end_time, state
FROM information_schema.active_queries
ORDER BY query_start_time DESC LIMIT 10;
```

Profile 的关键节点分析：

**找出最耗时的算子**：Profile 以树形结构展示每个 Fragment 内每个 Operator 的耗时，耗时最长的节点就是优化重点。常见的热点算子：

- **OlapScanNode 耗时长**：数据扫描量大，说明分区剪枝或索引未生效。检查 `RowsRead` 与 `RowsReturned` 的比例——如果读取 1 亿行但只返回 10 万行，说明过滤效率低（ZoneMap/BloomFilter 未充分利用）。
- **HASH JOIN 耗时长**：检查 HashTable 构建的内存量（`BuildRows`）。如果 Build 侧远大于预期，可能是 CBO 选错了 BUILD/PROBE 侧，可以用 Hint 强制小表作为 Build 侧：`SELECT ... FROM orders JOIN [BROADCAST] users ON ...`
- **Exchange 耗时长**：Shuffle 数据量大，说明 JOIN 未能使用 Colocate 或 Broadcast，需要重新检查分桶设计

### 2.2 audit_log——历史慢查询分析

Doris FE 的 `audit_log` 记录所有 SQL 查询的执行信息：

```bash
# audit_log 文件位置（FE 节点）
/opt/doris/fe/log/fe.audit.log

# 解析慢查询（执行时间 > 10 秒）
grep "QueryTime" fe.audit.log | awk -F"|" '$5 > 10000' | sort -t"|" -k5 -nr | head 20
```

也可以通过 SQL 查询 FE 内存中的审计日志：

```sql
-- 查看最近 1 小时的慢查询（需要安装 audit_log plugin）
SELECT
    `timestamp`,
    user,
    db,
    query_time,
    scan_rows,
    scan_bytes,
    stmt
FROM doris_audit_db__.doris_slow_log_tbl__
WHERE `timestamp` >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
  AND query_time > 5000  -- 超过 5 秒
ORDER BY query_time DESC
LIMIT 20;
```

### 2.3 常见慢查询场景与解决方案

**问题一：分区剪枝未生效**

症状：Profile 中 `OlapScanNode.RowsRead` 远大于预期，`Partitions` 显示扫描了所有分区。

原因：WHERE 条件写法导致 Doris 无法推导分区范围。

```sql
-- ❌ 函数包裹分区列，导致无法剪枝
SELECT * FROM orders WHERE YEAR(date) = 2024;

-- ✅ 改写为范围条件，正确剪枝
SELECT * FROM orders WHERE date BETWEEN '2024-01-01' AND '2024-12-31';

-- ❌ 隐式类型转换，导致无法剪枝
SELECT * FROM orders WHERE date = '2024-01-01';  -- 如果 date 是 DATETIME 类型

-- ✅ 显式使用正确类型
SELECT * FROM orders WHERE date >= '2024-01-01 00:00:00' AND date < '2024-01-02 00:00:00';
```

**问题二：Runtime Filter 未生效**

症状：Profile 显示大表 Scan 的 `RowsRead` 很大，但实际满足条件的行很少。

解决方案：检查 Runtime Filter 是否正确生成：

```sql
-- 查看执行计划中是否有 RuntimeFilter
EXPLAIN VERBOSE SELECT o.*, u.name
FROM orders o JOIN users u ON o.user_id = u.user_id
WHERE u.segment = 'VIP';
-- 输出中应包含 "RF000[bloom_filter] -> [user_id]" 说明 Runtime Filter 已生效
```

**问题三：Compaction 积压导致查询慢**

症状：查询时 Profile 中 `OlapScanNode` 的 `SegmentIteratorNum` 很大（每个 Tablet 有大量 Rowset 需要合并），导致读取时多路归并开销大。

诊断：

```sql
-- 查看 Tablet 的 Rowset 数量
ADMIN SHOW REPLICA STATUS FROM table_name;
-- 或通过 BE 的 HTTP 接口
curl "http://be_host:8040/api/tablets/10001"
```

解决：触发手动 Compaction（临时）或增大 `max_compaction_threads`（根本解决）。

---

## 第 3 章 集群扩缩容

### 3.1 BE 节点扩容

向 Doris 集群添加新 BE 节点的流程：

```bash
# Step 1：在新节点上安装并启动 Doris BE
./bin/start_be.sh --daemon

# Step 2：在 FE 上注册新 BE
mysql -h fe_host -P 9030 -u root
ALTER SYSTEM ADD BACKEND "new_be_host:9050";

# Step 3：查看 BE 状态（Alive=true 说明注册成功）
SHOW PROC '/backends';
```

**数据均衡过程**：新 BE 加入后，FE 的 Tablet Scheduler 会自动将已有 BE 上的 Tablet 副本迁移到新 BE，使集群数据均衡。这个过程是自动的，但可能持续数小时（取决于数据量和网络带宽）。

```sql
-- 查看数据均衡进度
SHOW PROC '/cluster_balance/working_slots';
-- 或
SHOW PROC '/statistic';
-- 关注 DecommissionBackendTabletNum（待迁移 Tablet 数）
```

**均衡限速**：大规模数据均衡可能占用大量网络带宽，影响业务 IO。可以通过调整迁移速率限制：

```sql
-- 限制每个 BE 的 Tablet 迁移吞吐（字节/秒）
ADMIN SET FRONTEND CONFIG ("tablet_sched_max_migration_task_sent_once" = "5");

-- 查看当前均衡配置
SHOW FRONTEND CONFIG LIKE 'tablet_sched%';
```

### 3.2 BE 节点缩容（下线节点）

下线 BE 节点时，Doris 需要先将该节点上的所有 Tablet 副本迁移到其他节点，确保数据不丢失：

```bash
# Step 1：将 BE 节点设置为 DECOMMISSION（开始迁移，不立即下线）
ALTER SYSTEM DECOMMISSION BACKEND "be_host:9050";

# Step 2：监控迁移进度（等待 TabletNum 降为 0）
SHOW PROC '/backends';
# 当 TabletNum = 0 时，该节点已安全下线

# 也可以查看待处理任务数
SHOW PROC '/cluster_balance/working_slots';
```

> [!warning] 生产避坑：不要强制下线（DROP BACKEND）
> `ALTER SYSTEM DROP BACKEND "be_host:9050"` 会**立即强制删除** BE 节点，不等待数据迁移完成。如果该 BE 上有某些 Tablet 的唯一副本（只有 1 个副本），强制删除会导致数据永久丢失。
>
> 生产中**必须使用 DECOMMISSION**，等待数据安全迁移后，BE 会自动从集群中移除。只有在确认数据有充足副本保护（副本数 ≥ 3 且其他节点健康）的情况下，才可以考虑强制操作。

### 3.3 FE 节点扩缩容

**添加 FE Follower**：

```sql
ALTER SYSTEM ADD FOLLOWER "new_fe_host:9010";
```

新 FE Follower 加入后，通过 Raft 协议从 Leader 同步全量元数据（Checkpoint + 增量日志），同步完成后可以开始处理读查询。

**FE 角色说明**：
- **Leader**（1 个）：处理所有元数据写操作（DDL、数据导入事务等）
- **Follower**（通常 1-2 个，总数为奇数）：参与 Raft 投票，可以处理读查询
- **Observer**（可选，任意数量）：只读，不参与投票，用于扩展读查询并发

---

## 第 4 章 关键监控指标

### 4.1 FE 监控

```sql
-- 查看 FE 整体状态
SHOW FRONTENDS;

-- 查看 Load Job 状态（是否有积压）
SHOW LOAD ORDER BY CreateTime DESC LIMIT 20;

-- 查看事务状态（长事务可能导致 FE 元数据膨胀）
SHOW PROC '/transactions';
```

**Prometheus 关键指标**（通过 FE 的 `/metrics` 接口）：

```promql
# 查询 QPS
rate(doris_fe_query_total[1m])

# 查询 P99 延迟
histogram_quantile(0.99, rate(doris_fe_query_latency_ms_bucket[5m]))

# 导入事务 TPS
rate(doris_fe_txn_committed_total[1m])

# FE 堆内存使用
doris_fe_jvm_heap_size_bytes{type="used"} / doris_fe_jvm_heap_size_bytes{type="max"}
```

### 4.2 BE 监控

```promql
# BE 磁盘使用率（应 < 80%）
doris_be_disks_data_used_capacity / doris_be_disks_total_capacity

# Compaction 速率（应持续进行）
rate(doris_be_compaction_bytes_total[5m])

# Tablet 数量（过多说明分桶设计不合理）
doris_be_tablet_count

# 查询扫描行数
rate(doris_be_scanner_rows_total[1m])
```

### 4.3 关键告警

```yaml
groups:
  - name: doris
    rules:
      # BE 磁盘接近满
      - alert: DorisBEDiskHigh
        expr: doris_be_disks_data_used_capacity / doris_be_disks_total_capacity > 0.8
        labels:
          severity: warning
        annotations:
          summary: "Doris BE 磁盘使用率超过 80%，需要扩容"

      # FE Leader 切换（说明原 Leader 宕机）
      - alert: DorisFELeaderChange
        expr: changes(doris_fe_is_master[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Doris FE Leader 发生切换"

      # 导入延迟升高
      - alert: DorisLoadLatencyHigh
        expr: doris_fe_txn_load_duration_ms > 30000  # 30 秒
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Doris 导入任务延迟超过 30 秒"
```

---

## 第 5 章 小结

Doris 的运维核心是三件事：

1. **建表设计要一次做对**：分区粒度、分桶键和分桶数是建表时必须深思熟虑的决策，后期修改代价极高（需要重建表）。Colocate Join 是消除大表 JOIN Shuffle 的关键设计，应在建表时统一规划。

2. **慢查询通过 Profile 定位**：Doris 的 Query Profile 提供了执行引擎级别的细粒度诊断，能精确定位是 Scan（索引未生效）、JOIN（BUILD/PROBE 侧选错）还是 Exchange（Shuffle 过多）导致查询慢。

3. **扩缩容使用官方流程**：BE 扩容后等待数据均衡（自动），BE 缩容必须使用 DECOMMISSION 而非 DROP，等待数据迁移完成后才能物理下线节点，防止数据丢失。

---

**延伸阅读**：
- [[01 Doris 全局架构——FE BE 分离与 MPP 执行]]
- [[02 Doris 存储引擎——Tablet、Rowset 与 Compaction]]
