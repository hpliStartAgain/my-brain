---
title: "04 Doris 数据模型——Duplicate、Aggregate 与 Unique"
date: 2026-03-05
tags: [Aggregate Key, Delete Bitmap, Doris, Duplicate Key, Unique Key, UPSERT, 主键模型, 数据模型]
aliases: []
---

# 04 Doris 数据模型——Duplicate、Aggregate 与 Unique

## 摘要

Doris 提供三种数据模型，分别针对不同的业务场景：**Duplicate Key（明细模型）** 保留所有历史写入、**Aggregate Key（聚合模型）** 写入时自动聚合、**Unique Key（唯一模型）** 支持高效 UPSERT。三种模型的选择本质上是在"存储空间/写入代价/查询灵活性"之间做权衡。本文深入剖析每种模型的内部实现机制——尤其是 Unique Key 的 Delete Bitmap 如何在列式存储中实现行级实时更新，以及 Merge-on-Read vs Write-on-Read 两种 Unique Key 实现模式的差异。

---

## 第 1 章 三种数据模型概览

### 1.1 为什么需要不同的数据模型

OLAP 场景中，数据写入和查询的模式差异巨大：

**日志类数据（日志埋点、用户行为事件）**：每条记录代表一次独立事件，不需要也不允许修改历史记录，查询时需要看到所有原始事件。

**指标聚合类数据（业务 KPI、监控指标）**：同一维度组合（如"北京地区，2024-01-01，UV"）的多条记录在业务上表示同一件事的不同观察，写入时希望自动累加（不存储每次更新的中间状态），查询时直接得到聚合结果。

**业务实体数据（用户信息、订单状态）**：一个业务实体（如一个用户、一张订单）在时间轴上会发生状态变更（用户更改地址、订单从"待支付"变为"已支付"），需要支持按主键的高效更新，查询时只返回最新状态。

针对这三类需求，Doris 设计了三种数据模型。

### 1.2 三种模型的核心特征

```
CREATE TABLE events (
    date    DATE,
    user_id BIGINT,
    region  VARCHAR,
    amount  DECIMAL(10, 2)
) ENGINE = OLAP
-- 选择一种数据模型：
DUPLICATE KEY(date, user_id)    -- 明细模型
-- 或 AGGREGATE KEY(date, user_id)
-- 或 UNIQUE KEY(date, user_id)
DISTRIBUTED BY HASH(user_id) BUCKETS 32;
```

| 模型 | Key 列 | Value 列 | 写入语义 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **Duplicate** | 排序列（可重复） | 任意列 | 保留所有写入行 | 日志、事件、不需去重 |
| **Aggregate** | 聚合 Key（可重复） | 聚合函数列 | 相同 Key 自动聚合 | 预聚合指标，固定维度统计 |
| **Unique** | 唯一主键 | 其余所有列 | 相同 Key 最新值覆盖（UPSERT） | 业务实体，需要实时更新 |

---

## 第 2 章 Duplicate Key 模型——最简单的明细存储

### 2.1 行为语义

Duplicate Key 模型不对数据做任何去重或聚合处理，每次写入的每行数据都被完整保留：

```sql
-- 表定义
CREATE TABLE page_views (
    date       DATE,
    page_id    INT,
    user_id    BIGINT,
    duration   INT
) ENGINE = OLAP
DUPLICATE KEY(date, page_id)
DISTRIBUTED BY HASH(user_id) BUCKETS 32;

-- 连续写入两行相同的数据
INSERT INTO page_views VALUES ('2024-01-01', 1001, 88888, 30);
INSERT INTO page_views VALUES ('2024-01-01', 1001, 88888, 30);

-- 查询返回两行（不去重）
SELECT * FROM page_views WHERE user_id = 88888;
-- 返回：(2024-01-01, 1001, 88888, 30), (2024-01-01, 1001, 88888, 30)
```

`DUPLICATE KEY` 的列只是**排序键**，决定数据在 Segment 内的物理存储顺序，不做任何去重。

### 2.2 适用场景

- **日志分析**：每次用户操作生成一条日志事件，事件天然不重复（或允许重复），需要完整保留
- **埋点事件流**：用户行为埋点（点击、浏览、购买），每条事件都有独立意义
- **临时数据暂存**：先全量写入，再通过 SQL 做聚合分析，不需要在写入阶段预处理

Duplicate Key 是 Doris 三种模型中**查询最灵活**的——因为原始数据完整保留，可以做任意维度的聚合分析。代价是存储空间最大（没有聚合压缩）。

---

## 第 3 章 Aggregate Key 模型——写入时预聚合

### 3.1 行为语义

Aggregate Key 模型在每次 Compaction 时，对具有相同 Key 列的行做聚合合并：

```sql
-- 定义聚合模型：按 (date, region) 预聚合
CREATE TABLE daily_region_stats (
    date          DATE,         -- Key 列
    region        VARCHAR(50),  -- Key 列
    total_amount  DECIMAL SUM,  -- Value 列：多行相加
    order_count   BIGINT SUM,   -- Value 列：多行相加
    avg_amount    DECIMAL REPLACE  -- Value 列：保留最新值
) ENGINE = OLAP
AGGREGATE KEY(date, region)
DISTRIBUTED BY HASH(region) BUCKETS 16;

-- 写入两批数据
INSERT INTO daily_region_stats VALUES ('2024-01-01', 'Beijing', 500.0, 5, 100.0);
INSERT INTO daily_region_stats VALUES ('2024-01-01', 'Beijing', 300.0, 3, 100.0);

-- 查询时，相同 Key 的行被合并：
-- total_amount = 500 + 300 = 800
-- order_count  = 5 + 3 = 8
-- avg_amount   = 100（REPLACE 保留最新写入的值）
SELECT * FROM daily_region_stats WHERE date = '2024-01-01' AND region = 'Beijing';
```

### 3.2 支持的聚合函数类型

| 函数 | 语义 | 典型用途 |
| :--- | :--- | :--- |
| **SUM** | 累加 | 销售额、事件次数 |
| **MAX/MIN** | 取最大/最小值 | 最高价格、最低温度 |
| **REPLACE** | 保留最后写入的值（按写入顺序） | 最新状态、最新值 |
| **REPLACE_IF_NOT_NULL** | 非 NULL 时覆盖 | 稀疏列的增量更新 |
| **HLL_UNION** | HyperLogLog 合并 | 近似 COUNT DISTINCT |
| **BITMAP_UNION** | Bitmap 合并 | 精确 COUNT DISTINCT（适合整数型用户 ID） |

### 3.3 局限性

Aggregate Key 模型的核心局限：**聚合维度固定**。一旦建表时确定了 Key 列（聚合维度），就无法对其他维度组合做聚合查询。

例如，如果表按 `(date, region)` 聚合，查询"按城市聚合"（城市比地区更细粒度）就无法从该表直接得到正确结果——因为数据已经被聚合到地区级别，丢失了城市维度信息。

这也是 Aggregate Key 模型的定位：适合**维度固定、查询模式固定**的预聚合场景（如 Doris 中的物化视图），而不是需要灵活 Ad-hoc 分析的场景。

---

## 第 4 章 Unique Key 模型——高效 UPSERT 的核心

### 4.1 为什么 OLAP 系统实现 UPSERT 很难

传统 OLAP 系统（如 ClickHouse、Hive）的存储模型是 append-only 的——数据一旦写入就不可变。这在 IO 效率上非常好（顺序写，不需要随机更新），但处理数据更新（如 MySQL 的 CDC 流）非常麻烦。

ClickHouse 通过 `ReplacingMergeTree` 处理更新：写入时允许重复，Merge 时去重（只保留最新版本）。但 Merge 是后台异步的，在 Merge 完成之前查询可能看到旧数据，需要用 `SELECT ... FINAL` 强制去重（性能代价大）。

Doris 的 Unique Key 模型需要在以下目标中找平衡：
- 写入速度：能接受高频 UPSERT（每秒数万到数十万次更新）
- 查询正确性：查询始终返回正确的最新数据，不需要 `FINAL` 等特殊处理
- 查询性能：UPSERT 对查询性能的影响尽量小

### 4.2 Merge-on-Read 模式（旧实现）

早期 Doris 的 Unique Key 实现是 **Merge-on-Read（MoR）**：写入时允许旧版本和新版本同时存在（不立即合并），查询时在读取阶段合并多个版本，保留最新版本。

MoR 的优点：写入速度快（不需要实时去重）。
MoR 的缺点：查询时需要扫描多个版本并做多路归并，查询开销随版本数增加而增大。对于频繁更新的列（如订单状态），一行数据可能有几十个历史版本，查询时每次都要遍历和合并所有版本，效率很低。

### 4.3 Delete Bitmap（Merge-on-Write 模式）——现代 Unique Key 实现

Doris 1.2 引入了基于 **Delete Bitmap** 的 **Merge-on-Write（MoW）** 模式，解决了 MoR 的查询性能问题：

**核心思想**：在**写入时**就标记被覆盖的旧行为"已删除"（通过 Delete Bitmap），查询时无需做版本合并，直接跳过已删除行。

**写入流程（UPSERT `user_id = 12345`）**：

1. 新数据写入新的 Delta Rowset（追加写入，不修改旧 Rowset）
2. **在写入完成后**，搜索历史 Rowset 中所有 `user_id = 12345` 的行
3. 将找到的旧行在 Delete Bitmap 中标记为"已删除"（设置对应 bit 为 1）
4. Delete Bitmap 持久化到磁盘

**查询流程**：

1. 扫描 Rowset 中的数据
2. 对每行检查 Delete Bitmap——如果该行的 bit 为 1（已删除），直接跳过
3. 只返回 Delete Bitmap 中未标记的行（即最新版本）

```
Rowset 1（旧数据）:
  Row 0: user_id=12345, name="Alice", email="old@example.com"  ← Delete Bitmap bit[0]=1（被标记删除）
  Row 1: user_id=99999, name="Bob",   email="bob@example.com"

Rowset 2（新写入）:
  Row 0: user_id=12345, name="Alice", email="new@example.com"  ← 最新版本，可见
```

**Delete Bitmap 的实现**：Delete Bitmap 使用 **Roaring Bitmap**（高效的稀疏位图数据结构），每个 Rowset 对应一个 Bitmap，标记该 Rowset 中哪些行被后续写入覆盖。Roaring Bitmap 的存储效率极高（对于稀疏的删除标记，存储开销很小），且查找速度极快（O(1) 检查单个 bit）。

### 4.4 Delete Bitmap 的性能特征

**写入代价**：每次 UPSERT 写入新行后，需要在历史 Rowset 中查找旧行并更新 Delete Bitmap。如果历史数据量大（大量 Rowset），查找旧行的开销可能显著（需要查询每个 Rowset 的索引）。

优化手段：Compaction 将多个 Rowset 合并，减少历史 Rowset 数量，降低写入时的 Delete Bitmap 更新开销。因此，对于高频 UPSERT 场景，Compaction 的及时性非常重要。

**查询代价**：查询时只需要检查 Delete Bitmap（位图查找，O(1)），不需要做多版本合并，查询性能与 Duplicate Key 模型接近。这是 MoW 相比 MoR 的最大优势。

> [!info] 核心概念：Roaring Bitmap
> Roaring Bitmap 是一种自适应的压缩位图数据结构，对稀疏（大多数 bit 为 0）和密集（大多数 bit 为 1）两种情况都有良好的空间效率：
> - 稀疏时：用有序数组存储 bit=1 的位置（类似稀疏集合）
> - 密集时：用标准位图（每 8 位存一个 byte）
> - 中等密度时：用 Run-Length Encoding
> Delete Bitmap 使用 Roaring Bitmap 意味着：即使 Tablet 中有 10 亿行，但只有 100 万行被更新（Delete Bitmap 中 100 万个 bit=1），Roaring Bitmap 的存储开销只有约 4MB，极为紧凑。

---

## 第 5 章 三种模型的选型指南

| 业务场景 | 推荐模型 | 原因 |
| :--- | :--- | :--- |
| 用户行为日志、埋点事件 | **Duplicate Key** | 原始事件完整保留，查询灵活 |
| 固定维度的实时累加指标（如按地区统计销售额） | **Aggregate Key** | 写入时预聚合，减少存储量，查询速度极快 |
| MySQL CDC 实时同步（订单/用户状态更新） | **Unique Key（MoW）** | UPSERT 语义，查询始终返回最新状态 |
| 高并发点查（按主键精确查询单行） | **Unique Key（MoW）** | Delete Bitmap 使得点查无需合并多版本 |
| 数据仓库 DWD 层（保留全部明细，按需聚合） | **Duplicate Key** | 不限制查询维度 |
| 指标宽表（已知查询模式固定） | **Aggregate Key** | 存储效率高，查询无需现场聚合 |

> [!warning] 生产避坑：Unique Key 模型不适合超高频点更新
> Unique Key MoW 模式在每次写入后需要更新 Delete Bitmap（查找旧行并标记）。如果每秒有数万行更新且 Tablet 历史数据量大（数十亿行），每次写入需要在大量历史 Rowset 中查找旧行，写入延迟可能升高。
> 对于超高频点更新（> 10 万 TPS），应考虑：
> 1. 减少 Tablet 的 Rowset 碎片化（通过 Compaction 及时合并）
> 2. 增大分桶数，减少单 Tablet 的数据量，加速 Delete Bitmap 查找
> 3. 评估是否真的需要 Doris——高频点更新场景，专门的 OLTP 数据库（MySQL/TiDB）可能更合适

---

## 第 6 章 小结

Doris 三种数据模型是在"存储空间/写入灵活性/查询灵活性"三者之间的工程权衡：

- **Duplicate Key**：存储空间最大，写入最简单，查询最灵活——适合日志和事件分析
- **Aggregate Key**：存储空间最小，写入时自动聚合，查询维度受限——适合固定维度的预聚合
- **Unique Key（MoW）**：通过 Delete Bitmap 实现高效 UPSERT，查询性能接近 Duplicate Key——适合实时数据同步和业务实体管理

三种模型的设计，使 Doris 能够在同一套系统中同时满足日志分析、预聚合查询和实时数据更新三类截然不同的业务需求，无需为每类需求部署独立的存储系统。

---

**延伸阅读**：
- [[02 Doris 存储引擎——Tablet、Rowset 与 Compaction]]
- [[05 Doris 实时数据导入——Stream Load、Routine Load 与 Flink Connector]]

---

> [!note] 思考题
> 1. Stream Load 是 Doris 的主要批量导入方式——通过 HTTP PUT 将数据直接发送到 BE。单次 Stream Load 的数据量建议在 100MB-1GB 之间。过小（如 1MB/次）导致大量小文件和频繁合并，过大增加失败重试成本。在 Flink 实时写入场景中，Checkpoint 间隔如何影响每次 Stream Load 的数据量？
> 2. Routine Load 持续从 Kafka 消费数据写入 Doris——提供了 exactly-once 语义（通过 Kafka offset 和 Doris 事务的协调）。如果 Kafka 的消费速度跟不上生产速度，Routine Load 的延迟会持续增大。你如何监控和调优 Routine Load 的消费速率？增加 Routine Load Task 的并发数有什么限制？
> 3. Doris 的 INSERT INTO ... SELECT 支持从外部表（如 Hive、Iceberg、JDBC）直接导入数据。在一个从 Hive 迁移到 Doris 的项目中，你如何设计全量导入 + 增量同步的方案？全量导入 TB 级数据时的资源消耗如何控制以避免影响线上查询？
