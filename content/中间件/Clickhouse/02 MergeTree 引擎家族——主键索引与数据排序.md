---
title: "02 MergeTree 引擎家族——主键索引与数据排序"
date: 2026-03-05
tags: [ClickHouse, MergeTree, 稀疏索引, Primary Key, 排序键, ReplacingMergeTree, AggregatingMergeTree, 列式存储]
aliases: []
---

# 02 MergeTree 引擎家族——主键索引与数据排序

## 摘要

MergeTree 是 ClickHouse 最重要的存储引擎家族，是生产中 99% 的 ClickHouse 表的基础。本文深入剖析 MergeTree 的物理存储结构——为什么数据按主键排序存储、稀疏索引（Primary Key Index）如何定位数据范围、Mark 文件如何将逻辑 Granule 定位到物理字节偏移，以及 ReplacingMergeTree、AggregatingMergeTree、CollapsingMergeTree 等变体引擎在数据去重和预聚合场景中的设计逻辑。

---

## 第 1 章 MergeTree 的核心设计——LSM-Tree 的 OLAP 变体

### 1.1 写入性能 vs 查询性能的权衡

理解 MergeTree 的设计，首先要理解它面临的核心权衡：**如何在保证高写入吞吐的同时，实现高效的范围查询**。

ClickHouse 的典型写入模式是批量 INSERT（每批几万到几十万行），而不是单行 INSERT。每次批量 INSERT，ClickHouse 在磁盘上创建一个新的 **Part**（数据片段）——一个独立的目录，包含这批数据的所有列文件和索引文件。

如果数据到来时就立即保持全局有序（像 B+Tree 那样维护所有页面按主键有序），每次插入都需要在已有数据中"找位置插入"，代价极高（大量随机 IO）。

MergeTree 借鉴了 [[01 LevelDB 全局架构——LSM-Tree 的写优化设计|LSM-Tree]] 的思路：**每次写入创建一个新的有序 Part，后台异步将多个小 Part 合并（Merge）成更大的 Part**。每个 Part 内部是有序的，但 Part 之间可能有重叠的主键范围（直到 Merge 完成后才消除重叠）。

这种"写入时创建有序小 Part + 后台合并"的机制，使得 ClickHouse 的写入吞吐非常高（每秒可以写入数千万行），同时通过稀疏索引实现高效的主键范围查询。

> [!info] 核心概念：Part vs Segment
> ClickHouse 的 Part 与 [[Elasticsearch]] 的 Segment、[[Leveldb|LevelDB]] 的 SSTable 是同类概念——都是"不可变的、有序的数据文件"，通过后台合并来优化查询性能和存储空间。这是 LSM-Tree 思想在不同系统中的实例化。

### 1.2 Part 的物理文件结构

一个 Part 对应磁盘上的一个目录，典型结构如下：

```
20240305_1_100_3/          # Part 目录名：{partition}_{min_block}_{max_block}_{level}
├── date.bin               # date 列的压缩数据
├── date.mrk3              # date 列的 Mark 文件（Granule 到字节偏移的映射）
├── user_id.bin            # user_id 列的压缩数据
├── user_id.mrk3
├── amount.bin             # amount 列的压缩数据
├── amount.mrk3
├── primary.idx            # 稀疏主键索引
├── minmax_date.idx        # date 列的 min/max 索引（用于分区剪枝）
├── checksums.txt          # 所有文件的校验和
└── columns.txt            # 列定义（列名和类型）
```

**关键文件解析**：

- **`*.bin`**：列数据文件，存储某一列所有行的压缩值。数据按主键排序后写入，同一列的所有值连续存储。
- **`*.mrk3`**：Mark 文件，是稀疏索引的导航数据。每个 Mark 条目记录一个 Granule（8192 行）的起始位置在 `*.bin` 文件中的字节偏移和解压偏移。
- **`primary.idx`**：稀疏主键索引，每隔 8192 行（1个 Granule）存储一个主键值，文件极小，通常完全驻留内存。
- **`minmax_*.idx`**：分区键/排序键的最小最大值索引，用于分区剪枝（整个 Part 不符合查询条件时可以直接跳过）。

---

## 第 2 章 稀疏主键索引——高效范围查询的秘密

### 2.1 为什么是"稀疏"索引

传统 B+Tree 是**密集索引**——每行数据都有一个索引条目，通过索引可以精确定位任意一行。这对 OLTP 的点查非常高效，但对海量数据的 OLAP 有两个问题：

1. 索引大小与行数成正比：10 亿行的 B+Tree 索引可能需要数十 GB 内存，无法完全驻留内存
2. 维护索引的代价高（插入时需要维护 B+Tree 结构）

**稀疏索引**（Sparse Index）的思路完全不同：**不为每行建立索引，而是每隔固定行数（`index_granularity`，默认 8192）才存储一个索引条目**。

ClickHouse 的稀疏索引（`primary.idx`）内容示例：

```
Granule 0  → 主键值 (2024-01-01, 1001)     ← 前 8192 行中最小的主键
Granule 1  → 主键值 (2024-01-01, 9998)
Granule 2  → 主键值 (2024-01-02, 502)
Granule 3  → 主键值 (2024-01-02, 8801)
Granule 4  → 主键值 (2024-01-03, 123)
...
```

稀疏索引的大小 = 总行数 / 8192 × 每条索引的大小。对于 10 亿行、16 字节主键的表：索引大小 ≈ `1,000,000,000 / 8192 × 16 = 2MB`。整个索引完全放在内存中，查询时不需要磁盘 IO。

### 2.2 稀疏索引的查询流程

对于查询 `WHERE date = '2024-01-02' AND user_id BETWEEN 500 AND 9000`：

**Step 1：二分查找索引**

在 `primary.idx` 中二分查找，找到满足条件的 Granule 范围：
- 下界：找到第一个 `(date, user_id) >= (2024-01-02, 500)` 的 Granule → Granule 2
- 上界：找到最后一个 `(date, user_id) <= (2024-01-02, 9000)` 的 Granule → Granule 3
- 需要读取的 Granule 范围：[2, 3]（共 2 个 Granule，即 16384 行）

**Step 2：通过 Mark 文件定位字节偏移**

查找 `date.mrk3` 和 `user_id.mrk3` 中 Granule 2 和 Granule 3 的字节偏移，直接 seek 到对应位置读取数据。

**Step 3：解压并过滤**

读取 2 个 Granule 的 `date` 和 `user_id` 列数据，在内存中用 SIMD 向量化过滤，找到满足条件的行，再读取这些行对应的其他列。

稀疏索引不能精确定位单行（精度是 Granule 粒度），但对于范围查询，大量 Granule 被剪枝掉，实际读取的数据量极小。

### 2.3 主键与排序键的区别

ClickHouse 中有两个相关但不同的概念：

**`ORDER BY`（排序键）**：决定数据在 Part 内的物理排序顺序，也是稀疏索引构建的依据。所有写入的数据在 Part 内按 `ORDER BY` 键的顺序存储。

**`PRIMARY KEY`**（主键索引键）：稀疏索引使用的键。如果不显式指定，默认等于 `ORDER BY`。但可以将 `PRIMARY KEY` 设置为 `ORDER BY` 键的前缀（前几列），使主键更短，索引更小，更容易驻留缓存。

```sql
-- 数据按 (date, user_id, event_type) 排序存储
-- 但索引只使用 (date, user_id) 前两列
CREATE TABLE events (
    date       Date,
    user_id    UInt64,
    event_type String,
    amount     Float64
) ENGINE = MergeTree()
ORDER BY (date, user_id, event_type)
PRIMARY KEY (date, user_id);  -- 索引前缀，比完整排序键更紧凑
```

这种设计让你在保持高效范围查询（通过主键）的同时，数据物理上按更细粒度的键排序（利于 Granule 内过滤）。

> [!warning] 生产避坑：主键基数与查询模式要匹配
> 稀疏索引的剪枝效果依赖于查询条件与主键的匹配程度。如果查询经常按 `user_id` 过滤，但主键是 `(date, user_id)`，当查询只有 `WHERE user_id = 12345` 时（没有 `date` 条件），稀疏索引无法剪枝——`user_id` 在 `date` 的不同值范围内都可能出现，每个 Granule 都可能包含 `user_id=12345` 的数据。
> 这种情况需要引入**跳数索引**（见第 6 章），或者为不同查询模式创建不同的物化视图。

---

## 第 3 章 MergeTree 变体引擎——解决数据更新与预聚合

### 3.1 为什么需要变体引擎

MergeTree 本身是"追加写入"（append-only）的——新数据总是写入新的 Part，不更新已有数据。对于 OLAP 场景，这非常好（写入速度快），但很多业务需求需要处理以下情况：

- **数据去重**：同一个事件可能因为网络重试被写入多次，需要保留最新一条
- **数据修正**：历史数据需要修改（如账单金额更正），直接更新代价高
- **预聚合**：实时查询太多导致 CPU 压力大，希望写入时就做部分聚合

这些需求催生了 MergeTree 的变体引擎家族。

### 3.2 ReplacingMergeTree——按主键去重

**ReplacingMergeTree** 在 Merge 时，对于具有相同主键（`ORDER BY` 键）的行，只保留版本最高（或写入最晚）的一行，删除旧版本。

```sql
CREATE TABLE user_profiles (
    user_id    UInt64,
    name       String,
    email      String,
    updated_at DateTime
) ENGINE = ReplacingMergeTree(updated_at)  -- updated_at 作为版本列
ORDER BY user_id;

-- 写入初始数据
INSERT INTO user_profiles VALUES (1, 'Alice', 'alice@old.com', now());

-- 更新 Email（写入新 Part，不修改旧行）
INSERT INTO user_profiles VALUES (1, 'Alice', 'alice@new.com', now() + 1);

-- 查询时可能返回两行（Merge 尚未发生）
SELECT * FROM user_profiles WHERE user_id = 1;
-- 返回：
-- (1, 'Alice', 'alice@old.com', ...)
-- (1, 'Alice', 'alice@new.com', ...)

-- 强制去重（生产中不推荐，有性能问题，推荐等 Merge 或加 FINAL）
SELECT * FROM user_profiles FINAL WHERE user_id = 1;
-- 返回（去重后）：
-- (1, 'Alice', 'alice@new.com', ...)
```

**关键注意事项**：

ReplacingMergeTree 的去重**不是即时的**，而是发生在 Merge 期间（后台异步合并 Part 时）。在 Merge 完成之前，查询可能返回重复行。

使用 `SELECT ... FINAL` 可以在查询时强制去重，但 FINAL 会禁用并行查询，性能大幅下降（通常比普通查询慢 5-10 倍）。

生产中的推荐做法：对于需要精确去重的场景，在应用层做去重（如在 SQL 中用 `argMax` 函数）：

```sql
-- 使用 argMax 获取每个 user_id 的最新 email（无需 FINAL，利用索引高效执行）
SELECT 
    user_id,
    argMax(email, updated_at) AS latest_email
FROM user_profiles
GROUP BY user_id;
```

### 3.3 AggregatingMergeTree——写入时预聚合

**AggregatingMergeTree** 在 Merge 时对相同主键的行进行聚合，将多行合并成一行（存储聚合状态），而不是简单保留一行。

这个引擎通常与**物化视图**配合使用，实现写入时的增量预聚合：

```sql
-- 原始事件表
CREATE TABLE events_raw (
    date     Date,
    region   String,
    amount   Float64
) ENGINE = MergeTree() ORDER BY (date, region);

-- 按 (date, region) 预聚合的物化视图，使用 AggregatingMergeTree
CREATE MATERIALIZED VIEW events_daily
ENGINE = AggregatingMergeTree()
ORDER BY (date, region)
AS SELECT
    date,
    region,
    sumState(amount) AS amount_sum,      -- sumState 存储聚合中间状态
    countState()     AS event_count
FROM events_raw
GROUP BY date, region;

-- 查询预聚合结果（用 sumMerge 合并聚合状态）
SELECT
    date,
    region,
    sumMerge(amount_sum) AS total_amount,
    countMerge(event_count) AS total_events
FROM events_daily
GROUP BY date, region;
```

`sumState()` 不直接存储最终的 sum 值，而是存储聚合的**中间状态**（对于 sum 就是当前的和，但对于 HLL、quantile 等复杂聚合函数，中间状态比最终结果更复杂）。查询时用 `sumMerge()` 将中间状态合并成最终结果。

**AggregatingMergeTree 的价值**：对于每秒百万行写入的实时系统，如果每次查询都做全量聚合，CPU 压力极大。通过 AggregatingMergeTree 物化视图，写入时就完成部分聚合，查询时只需合并预聚合结果，查询延迟从秒级降到毫秒级。

### 3.4 SummingMergeTree——数值列累加

**SummingMergeTree** 是 AggregatingMergeTree 的简化版：对相同主键的行，直接对指定的数值列求和合并，不需要复杂的聚合状态机制。

```sql
CREATE TABLE daily_revenue (
    date     Date,
    region   String,
    revenue  Float64,
    orders   UInt64
) ENGINE = SummingMergeTree((revenue, orders))  -- 对这两列求和
ORDER BY (date, region);
```

适用于简单累加场景，比 AggregatingMergeTree 实现更简单，但灵活性不如后者。

### 3.5 CollapsingMergeTree——支持行级删除

**CollapsingMergeTree** 通过"标记消除"实现逻辑删除。每行有一个 `sign` 列（值为 +1 或 -1），Merge 时相同主键的 sign 互相抵消：

```sql
CREATE TABLE orders (
    order_id   UInt64,
    amount     Float64,
    status     String,
    sign       Int8  -- +1 表示插入，-1 表示删除
) ENGINE = CollapsingMergeTree(sign)
ORDER BY order_id;

-- 插入订单
INSERT INTO orders VALUES (1001, 500.0, 'paid', 1);

-- 修改订单金额（先写 -1 消除旧行，再写 +1 写入新行）
INSERT INTO orders VALUES (1001, 500.0, 'paid', -1);  -- 取消旧行
INSERT INTO orders VALUES (1001, 600.0, 'paid', 1);   -- 写入新行
```

Merge 时，sign=+1 和 sign=-1 的相同 order_id 行互相抵消，只保留净效果。

CollapsingMergeTree 的应用场景：实现类似于 [[Doris]] Unique Key 模型的数据更新语义，但不需要 Doris 那样的精确点更新能力——ClickHouse 通过"写入增量变化"的方式模拟更新。

---

## 第 4 章 Partition——数据管理的粗粒度单元

### 4.1 分区（Partition）的作用

MergeTree 支持按某个键进行**分区**（Partition）。分区是粗粒度的数据组织单元——同一个 Part 只属于一个分区，不同分区的 Part 不会被合并在一起。

```sql
CREATE TABLE events (
    date     Date,
    user_id  UInt64,
    amount   Float64
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)  -- 按月分区
ORDER BY (date, user_id);
```

分区带来三个好处：

**1. 分区剪枝**：查询中如果有分区键的过滤条件（如 `WHERE date BETWEEN '2024-01-01' AND '2024-01-31'`），ClickHouse 直接跳过不相关的分区目录，不扫描任何文件。对于按时间分区的表，时间范围查询效率极高。

**2. 分区 DROP**：数据过期时，直接 `ALTER TABLE DROP PARTITION '202312'` 瞬间删除整个分区目录，比逐行 DELETE 快数个量级（本质上是删除目录）。

**3. 分区 Attach/Detach**：可以将一个表的分区"移动"到另一个表（秒级完成，不拷贝数据），用于数据归档或跨表迁移。

### 4.2 分区设计原则

分区粒度的选择直接影响性能：

- **分区太粗**（如按年分区）：单个分区内数据量过大，分区剪枝效果差
- **分区太细**（如按天分区，写入频繁）：Part 数量爆炸，每个分区内的 Part 数量多但每个 Part 很小，导致"too many parts" 问题（ClickHouse 有 Part 数量上限保护，超限后写入会报错）

**经验建议**：

- 日志/事件类数据（每天数亿行）→ 按天分区（`PARTITION BY toDate(date)`）
- 用户行为/订单类数据（每月十亿行）→ 按月分区（`PARTITION BY toYYYYMM(date)`）
- 固定维表（几百万行，很少增长）→ 无需分区

---

## 第 5 章 小结

MergeTree 的设计精妙体现在几个层次的协同：

- **数据按主键有序存储**，使范围查询能够连续读取磁盘，IO 高效
- **稀疏索引**：极小的索引文件常驻内存，查询时快速定位 Granule 范围
- **Mark 文件**：将逻辑 Granule 编号映射到物理字节偏移，实现精准 seek
- **后台 Merge**：将多个小 Part 合并成大 Part，优化查询性能（减少需要扫描的 Part 数量）和存储效率

MergeTree 变体引擎（Replacing/Aggregating/Summing/Collapsing）在 Merge 阶段添加数据语义处理，实现去重、预聚合等功能，是 ClickHouse 在 append-only 约束下实现数据"更新"的工程化解法。

理解 MergeTree 的物理存储结构，是进行 ClickHouse 表设计（主键选择、分区策略）和查询优化（如何利用稀疏索引剪枝）的必要前提。

---

**延伸阅读**：
- [[01 ClickHouse 全局架构——列式存储与 MPP 执行引擎]]
- [[03 数据写入与 Part 合并]]
- [[06 ClickHouse 性能调优——表设计、查询优化与资源管理]]

---

> [!note] 思考题
> 1. MergeTree 的排序键（ORDER BY）定义了数据在磁盘上的排列顺序。查询如果使用了排序键的前缀作为过滤条件，可以利用主键索引快速定位数据。但如果查询过滤的列不在排序键中（如对非排序列做精确匹配），就需要扫描所有 granule。Data Skipping Index（如 `minmax`、`set`、`bloom_filter`）如何在这种场景下减少扫描量？
> 2. MergeTree 的数据是'先写入临时 part，后台异步合并（merge）'的模式。合并操作类似 LSM-Tree 的 Compaction——将多个小 part 合并为大 part。如果写入速度远大于合并速度，part 数量会持续增长——查询时需要扫描更多 part，性能下降。`parts_to_throw_insert` 参数在什么时候触发？你如何通过调优合并策略避免 part 积压？
> 3. 分区键（PARTITION BY）将数据按时间（如按天/按月）分割到不同分区。分区裁剪（partition pruning）使得查询 `WHERE date = '2024-01-15'` 只扫描对应分区。但分区过多（如按秒分区）会导致每个分区的 part 过小——合并效率低且文件数过多。分区粒度如何选择？在时序数据场景中，按天分区和按月分区各适合什么数据量级？
