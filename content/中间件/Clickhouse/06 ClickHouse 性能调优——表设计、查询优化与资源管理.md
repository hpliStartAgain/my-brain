---
title: "06 ClickHouse 性能调优——表设计、查询优化与资源管理"
date: 2026-03-05
tags: [ClickHouse, 性能调优, 主键设计, 跳数索引, 物化视图, 资源管理, 查询优化]
aliases: []
---

# 06 ClickHouse 性能调优——表设计、查询优化与资源管理

## 摘要

ClickHouse 的性能调优分为三个层次：**表设计**（主键选择、分区策略、跳数索引的合理使用）、**查询优化**（避免全表扫描、物化视图预聚合、SQL 写法优化）和**资源管理**（线程数限制、内存配额、并发控制）。本文系统梳理这三个层次的调优方法，重点阐明每个优化手段的原理和边界——不是"这样做更快"的操作手册，而是"为什么这样做更快"的深度分析。

---

## 第 1 章 表设计调优——性能的源头

### 1.1 主键与排序键的设计原则

ClickHouse 的主键（`PRIMARY KEY` / `ORDER BY`）是最重要的性能决策，直接决定了查询的索引剪枝效果。

**原则一：高频过滤列放在主键最左侧**

稀疏索引支持**最左前缀匹配**——查询条件必须匹配排序键的最左列，才能有效利用索引剪枝。

```sql
-- 表设计：ORDER BY (date, region, user_id)
-- 查询 1：WHERE date = '2024-01-01' → ✅ 有效剪枝（date 是第一列）
-- 查询 2：WHERE date = '2024-01-01' AND region = 'BJ' → ✅ 有效剪枝（前两列）
-- 查询 3：WHERE region = 'BJ' → ❌ 无法剪枝（region 不是第一列，date 条件缺失）
-- 查询 4：WHERE user_id = 12345 → ❌ 无法剪枝
```

如果业务上 `region` 维度的查询比 `date` 更频繁，应将 `region` 放在第一位。但对于时序数据，`date` 通常作为第一列——时间范围是最常见的过滤条件，且连续时间数据的物理存储局部性好（时间连续的 Granule 可能在磁盘上相邻）。

**原则二：主键列基数不宜太高**

主键列基数（不同值的数量）不宜过高。高基数列作为主键意味着相邻的 Granule 之间主键值差异很大，稀疏索引的剪枝精度下降。

- `date`（低基数，几千个不同日期值）：非常适合作为主键第一列，每个 `date` 值对应的数据在连续的 Granule 中，剪枝极准
- `user_id`（高基数，数亿个不同用户）：适合放在主键后几位，作为在日期范围内进一步过滤的依据
- `session_id`（极高基数，全局唯一）：不适合作为主键，无法有效剪枝；如果需要按 session_id 查询，应使用跳数索引

**原则三：主键越短越好**

主键越短，稀疏索引的内存占用越小，更容易完整缓存在 OS Page Cache 中，查询时的内存 IO 更少。

### 1.2 分区策略的选择

分区是粗粒度剪枝，通常按时间维度分区：

```sql
-- 日志类数据（高写入频率，每天新增数亿行）
PARTITION BY toDate(timestamp)  -- 按天分区

-- 业务数据（适中写入量，历史数据需要长期保留）
PARTITION BY toYYYYMM(date)     -- 按月分区

-- 不需要分区（小表，几百万行以内）
-- 不设置 PARTITION BY，或 PARTITION BY tuple()
```

分区设计的关键：**分区的数据量不能太小**，每个分区至少应包含几十万行数据，否则每个分区只有少数几个 Part，Merge 效果差，查询时 Part 文件 open/close 开销占比高。

### 1.3 跳数索引——主键之外的二级过滤

当查询条件不能利用主键进行剪枝时，**跳数索引（Skip Index）** 可以在 Granule 级别提供额外过滤。

跳数索引不是传统的 B+Tree 索引，而是**对每个 Granule 存储简化的统计信息**，查询时根据统计信息决定是否可以跳过该 Granule。

**MinMax 索引**（适合低基数数值列或有序列）：

```sql
CREATE TABLE events (
    date    Date,
    user_id UInt64,
    region  String,
    amount  Float64,
    INDEX idx_region region TYPE minmax GRANULARITY 4
    -- 每 4 个 Granule 存储 region 列的最小最大值
) ENGINE = MergeTree() ORDER BY (date, user_id);
```

查询 `WHERE region = 'Beijing'` 时，如果某个 Granule 组的 minmax 统计显示 `region` 的值范围不包含 `Beijing`，这些 Granule 被跳过，不读取数据。

**Set 索引**（适合低基数列的精确匹配）：

```sql
INDEX idx_status status TYPE set(100)  -- 每个 Granule 存储最多 100 个不同的 status 值
GRANULARITY 1
```

**Bloom Filter 索引**（适合高基数列的等值过滤）：

```sql
INDEX idx_request_id request_id TYPE bloom_filter(0.01)  -- 1% 误判率
GRANULARITY 1
```

对于查询 `WHERE request_id = 'abc-123'`，Bloom Filter 能以 99% 的概率正确判断某个 Granule 中不存在这个值，从而跳过该 Granule。

> [!warning] 生产避坑：跳数索引的代价
> 跳数索引在写入时增加额外的计算和存储开销（每次 Part 写入/Merge 都需要更新索引）。不要为所有列都创建跳数索引——只为确实有高频点查需求且主键无法覆盖的列创建。
> 可以用 `EXPLAIN INDEXES` 验证查询是否实际利用了跳数索引。

---

## 第 2 章 查询优化——SQL 写法与物化视图

### 2.1 避免全表扫描的三个手段

**手段一：确保 WHERE 条件匹配主键前缀**

见 1.1 节，主键最左前缀匹配是最根本的查询优化。

**手段二：分区裁剪**

对于分区表，WHERE 条件应包含分区列：

```sql
-- ✅ 分区裁剪有效（只扫描 2024-01 和 2024-02 两个分区）
SELECT * FROM events WHERE date BETWEEN '2024-01-01' AND '2024-02-28';

-- ❌ 分区裁剪无效（函数包裹分区列，ClickHouse 无法识别范围）
SELECT * FROM events WHERE toYYYYMM(date) = 202401;

-- ✅ 改写为（使用 date 列直接过滤，ClickHouse 自动推导分区范围）
SELECT * FROM events WHERE date >= '2024-01-01' AND date < '2024-02-01';
```

**手段三：避免 SELECT \***

`SELECT *` 会读取所有列，即使查询只需要 2-3 列。列存储的列剪枝必须在 SQL 层显式指定需要的列才能生效：

```sql
-- ❌ 读取所有列（100 列全部解压）
SELECT * FROM events WHERE user_id = 12345;

-- ✅ 只读取需要的列
SELECT date, amount, event_type FROM events WHERE user_id = 12345;
```

### 2.2 物化视图预聚合——以空间换时间

对于高频执行的聚合查询，可以用物化视图（Materialized View）将聚合结果预计算并持续更新：

```sql
-- 实时事件表（原始数据）
CREATE TABLE events (
    timestamp DateTime,
    date      Date ALIAS toDate(timestamp),
    region    String,
    event_type String,
    amount    Float64
) ENGINE = MergeTree() ORDER BY (timestamp, region);

-- 物化视图：实时维护按 (date, region) 的聚合统计
CREATE MATERIALIZED VIEW events_daily_mv
ENGINE = AggregatingMergeTree()
ORDER BY (date, region)
AS SELECT
    toDate(timestamp) AS date,
    region,
    sumState(amount)       AS total_amount,
    countState()           AS event_count,
    uniqState(user_id)     AS unique_users
FROM events
GROUP BY date, region;

-- 查询聚合结果（毫秒级响应，不需要扫描原始数据）
SELECT
    date,
    region,
    sumMerge(total_amount)  AS total_amount,
    countMerge(event_count) AS event_count,
    uniqMerge(unique_users) AS unique_users
FROM events_daily_mv
GROUP BY date, region;
```

物化视图的工作原理：每次向 `events` 表写入数据时，ClickHouse 自动触发物化视图的更新查询，将新数据的聚合结果写入 `events_daily_mv`（使用 AggregatingMergeTree 合并聚合状态）。查询时直接读预聚合结果，数据量极小。

**物化视图的适用场景**：
- 高频聚合查询（每分钟执行数百次的 Grafana Dashboard 查询）
- 聚合维度固定（`GROUP BY date, region` 这样的固定分组）
- 原始数据量大但聚合后数据量小（百亿行聚合后只有几千行）

**物化视图的局限**：
- 存储开销（额外存储聚合结果）
- 维度固定（物化视图只预计算了特定的 GROUP BY 组合，其他维度的聚合仍需查原始数据）
- 延迟（物化视图的更新是同步的，可能略微增加写入延迟）

### 2.3 合理使用子查询与 IN

ClickHouse 对 `IN` 子查询的优化不如 Trino 完善，大集合的 `IN` 查询可能导致性能问题：

```sql
-- ❌ 大集合 IN（可能导致内存溢出或慢查询）
SELECT * FROM events WHERE user_id IN (SELECT user_id FROM users WHERE segment = 'VIP');
-- 如果 VIP 用户有数百万，这个 IN 集合会很大

-- ✅ 改为 JOIN（更可控，可以利用索引）
SELECT e.*
FROM events e
JOIN (SELECT user_id FROM users WHERE segment = 'VIP') vip
ON e.user_id = vip.user_id;

-- ✅ 或使用 GLOBAL IN（分布式场景）
SELECT * FROM events WHERE user_id GLOBAL IN (SELECT user_id FROM users WHERE segment = 'VIP');
```

---

## 第 3 章 资源管理——多用户并发的隔离

### 3.1 Settings Profile 与 Quota

ClickHouse 通过 **Settings Profile** 和 **Quota** 实现多用户的资源隔离：

```sql
-- 创建 Settings Profile（SQL 方式，ClickHouse 22.x+）
CREATE SETTINGS PROFILE analytics_profile SETTINGS
    max_threads = 8,                    -- 查询最多使用 8 个线程
    max_memory_usage = 10737418240,     -- 最多使用 10GB 内存
    max_execution_time = 60,            -- 查询超时 60 秒
    max_result_rows = 1000000,          -- 结果行数限制
    max_rows_to_read = 10000000000;     -- 最多读取 100 亿行（防止笛卡尔积等误操作）

-- 创建 Quota（限制时间窗口内的累计资源消耗）
CREATE QUOTA analytics_quota
    FOR INTERVAL 1 HOUR MAX queries = 100, read_rows = 100000000000
    TO analytics_role;

-- 为用户分配 Profile
ALTER USER analyst SETTINGS PROFILE 'analytics_profile';
```

### 3.2 内存溢出（OOM）的防范

ClickHouse 的聚合操作（GROUP BY、DISTINCT）在内存中构建 HashTable，当 GROUP BY 的基数极高时，HashTable 可能耗尽内存，导致进程被 OOM Killer 终止。

**两阶段磁盘溢写（Spilling to Disk）**：

```sql
-- 启用内存不足时溢写到磁盘（牺牲性能，防止 OOM）
SET max_bytes_before_external_group_by = 3221225472;  -- 超过 3GB 时溢写
SET max_bytes_before_external_sort = 3221225472;      -- 排序超过 3GB 时溢写
```

启用溢写后，当 HashTable 大小超过阈值，ClickHouse 将中间数据写入临时文件，通过多次 Merge 完成聚合，类似 MapReduce 的 Shuffle 机制。性能下降显著（可能慢 5-10 倍），但不会 OOM。

### 3.3 CPU 资源管理

```sql
-- 全局限制同时执行的查询数（防止高并发时 CPU 过载）
max_concurrent_queries = 100  -- config.xml 中配置

-- 每个查询的线程数上限（用户级别控制）
SET max_threads = 4;

-- 查询优先级（数值越小优先级越高，0 = 最高优先级）
SET priority = 1;  -- 低优先级查询（Grafana Dashboard 等低重要度查询）
```

---

## 第 4 章 诊断工具速查

```sql
-- 1. 查看当前正在运行的查询
SELECT query_id, user, elapsed, read_rows, memory_usage, query
FROM system.processes ORDER BY elapsed DESC;

-- 终止某个慢查询
KILL QUERY WHERE query_id = 'xxx-yyy-zzz';

-- 2. 查看 Part 状态（too many parts 排查）
SELECT table, partition, count() AS parts_count, sum(rows) AS total_rows
FROM system.parts WHERE active = 1
GROUP BY table, partition ORDER BY parts_count DESC LIMIT 20;

-- 3. 查看后台 Merge 进度
SELECT table, elapsed, progress, num_parts, result_part_name
FROM system.merges ORDER BY elapsed DESC;

-- 4. 查看 Mutation 进度
SELECT table, mutation_id, command, is_done, parts_to_do
FROM system.mutations WHERE is_done = 0;

-- 5. 分析查询日志中的慢查询
SELECT query, query_duration_ms, read_rows, read_bytes
FROM system.query_log
WHERE type = 'QueryFinish' AND query_duration_ms > 5000
ORDER BY query_duration_ms DESC LIMIT 20
SETTINGS log_queries = 1;
```

---

## 第 5 章 小结

ClickHouse 的性能调优是一个系统工程，核心是：

1. **表设计先行**：主键选择决定了 80% 的查询性能上限，主键设计错误无法通过后期优化弥补
2. **物化视图是高频查询的最佳武器**：用写入时的增量计算换取查询时的极低延迟
3. **跳数索引补充主键的盲区**：针对高频的非主键列点查创建 Bloom Filter 索引
4. **资源隔离防止鲸鱼查询**：通过 Settings Profile 限制单个查询的线程数和内存，保护其他查询的响应时间

---

**延伸阅读**：
- [[02 MergeTree 引擎家族——主键索引与数据排序]]
- [[03 数据写入与 Part 合并]]
- [[04 查询执行引擎——向量化与 Pipeline]]

---

> [!note] 思考题
> 1. ClickHouse 集群的容量规划需要考虑：数据量（压缩后磁盘占用）、查询 QPS 和并发数、写入吞吐量。列式存储的压缩比通常在 5:1 到 20:1（取决于数据类型和重复度）。如果原始数据每天 1TB（JSON 格式），写入 ClickHouse 后约占多少磁盘空间？保留 90 天的数据需要多少存储？
> 2. ClickHouse 的备份方案包括：`ALTER TABLE ... FREEZE PARTITION`（硬链接快照）、`clickhouse-backup` 工具（增量备份到 S3）和副本冗余。在一个 100TB 的集群中，全量备份到 S3 需要多长时间（假设 1Gbps 网络带宽）？增量备份如何减少备份窗口？
> 3. ClickHouse Keeper 是 ZooKeeper 的替代——用 C++ 实现，资源占用更少且部署更简单。在新部署的集群中，你会选择 ClickHouse Keeper 还是 ZooKeeper？从 ZooKeeper 迁移到 ClickHouse Keeper 的风险是什么？
