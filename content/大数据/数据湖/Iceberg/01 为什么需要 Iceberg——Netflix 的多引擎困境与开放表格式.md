---
title: "为什么需要 Iceberg——Netflix 的多引擎困境与开放表格式"
date: 2026-03-02
tags: [Iceberg, 数据湖, 开放表格式, Netflix, Hive元存储, 多引擎, 分区, HMS]
aliases: ["Iceberg诞生背景", "开放表格式", "Hive元存储瓶颈", "多引擎数据湖"]
---

**摘要：**

本文从 Netflix 工程团队在 2018 年面临的真实工程困境出发，揭示 [[Apache Iceberg]] 诞生的深层原因——不是"数据湖缺 ACID"（这是 [[Delta Lake]] 解决的问题），也不是"更新效率低"（这是 [[Apache Hudi]] 解决的问题），而是**传统 Hive 元存储（HMS）模型在 10PB 级多引擎数据湖上的根本性扩展性失败**。理解这个起点，才能理解 Iceberg 为什么把"与引擎解耦"和"元数据架构"放在设计的最高优先级，而不是像竞争对手那样专注于写入性能或事务机制。

---

## 第 1 章 Hive 元存储：撑起了大数据时代，但也留下了历史债务

### 1.1 HMS 的工作原理回顾

[[Apache Hive]] 是大数据时代的第一个 SQL-on-Hadoop 方案，其元数据模型（Hive Metastore，HMS）至今仍是 Hadoop 生态的事实标准。理解 HMS 的工作方式，是理解它的局限性的前提。

HMS 将表的元数据（表名、列定义、分区信息、文件路径）存储在一个传统关系数据库（通常是 MySQL 或 PostgreSQL）中。当你对一张 Hive 表执行查询时，典型的元数据查询流程如下：

```
SELECT * FROM orders WHERE order_date = '2024-01-01';

1. 查 HMS（MySQL）：
   SELECT * FROM PARTITIONS
   WHERE tbl_id = 12345
   AND part_key_val = '2024-01-01';
   → 返回分区路径：hdfs:///data/orders/order_date=2024-01-01/

2. 列出 HDFS 目录（FileSystem.listStatus()）：
   hdfs dfs -ls hdfs:///data/orders/order_date=2024-01-01/
   → 返回文件列表：[part-00000.parquet, part-00001.parquet, ...]

3. 执行 Parquet 扫描
```

这套流程在分区数量少（几百到几千个）时工作良好。问题在于，随着业务增长，分区数量爆炸式增长——而 HMS + HDFS 的双重查询架构在大量分区下暴露了严重的扩展性问题。

### 1.2 Netflix 的 10PB 困境

2018 年，Netflix 的数据规模大约是：
- 核心事件追踪表：**数百 PB** 的历史数据
- 分区数量：某些表有 **数百万个分区**（按 `date`、`hour`、`country`、`device_type` 四级分区）
- 并发引擎：Spark（批处理 ETL）、Presto（即席查询）、Hive（遗留 ETL）同时访问

**在这个规模下，HMS 发生了什么？**

**问题 1：分区列举变成了性能噩梦**

```
查询：SELECT date, COUNT(*) FROM events GROUP BY date

执行步骤：
  1. HMS 查询：列出 events 表的所有分区（100 万个！）
     → MySQL 查询返回 100 万条记录
     → 耗时：30-60 秒（MySQL 全表扫描 PARTITIONS 表）

  2. HDFS 路径解析：
     → 100 万次（或批量）HDFS API 调用
     → NameNode 压力极大

  3. 实际查询才开始执行...

总元数据解析时间：1-5 分钟
即使查询本身只需要 30 秒，元数据解析也占了整体时间的 60-80%
```

**问题 2：分区演进（Partition Evolution）几乎不可能**

假设某张表最初按 `date`（天）分区，随着数据量增长，需要改为按 `date + hour`（小时）分区——在 HMS 的世界里，这意味着：

```
方案一：重写整张表（重新分区）
  → 需要重写 100PB 的历史数据
  → 耗时数天，期间数据服务中断

方案二：新旧分区混存（部分新分区按小时，旧分区仍按天）
  → 查询引擎需要知道每个分区的"分区方案"不同
  → Spark/Presto 的分区剪裁逻辑失效
  → 实际上没有任何查询引擎支持这种"混合分区"表
```

**问题 3：多引擎数据一致性**

当 Spark 正在写入一个新分区时，Presto 可能在同一时刻读取该表。在 HMS 模型下：

```
Spark 写入流程：
  1. 写 HDFS 文件（文件已可见）
  2. 向 HMS 注册新分区（元数据更新有延迟）

问题：步骤 1 完成但步骤 2 尚未完成时：
  - Presto 查询：HMS 看不到新分区，查询不到新数据（数据丢失幻觉）
  - 文件层已有：HDFS 文件存在，但没有元数据指向

反之，步骤 2 完成但步骤 1 部分失败时：
  - Presto 查询：HMS 显示分区存在，但部分文件不完整（数据损坏幻觉）

Hive 通过行级锁（Hive Lock）缓解这个问题，但性能极差
```

### 1.3 治标不治本的补丁

面对上述问题，工业界尝试了各种补丁：

**补丁 1：分区发现（Partition Discovery）**

很多 Spark 作业绕过 HMS，直接用 `MSCK REPAIR TABLE` 或 `spark.sql.hive.metastorePartitionPruning=false` 来做路径级分区发现——放弃 HMS 的分区管理，直接让 Spark 扫描 HDFS 目录树来"自动发现分区"。

```
代价：
  每次查询都要列举 HDFS 目录（可能是数百万个目录）
  延迟从分钟级变成十分钟级
  完全放弃了 HMS 的分区剪裁能力
```

**补丁 2：预计算分区统计信息**

提前运行 `ANALYZE TABLE ... COMPUTE STATISTICS`，让 HMS 存储每个分区的记录数和文件大小，供查询引擎使用。

```
代价：
  需要单独运行统计计算任务（每次写入后都要运行）
  统计信息可能过期（写入后未及时更新）
  列级统计信息（Min/Max）HMS 存储得极不可靠
```

**补丁 3：分区裁剪的"谓词下推"到 HMS**

配置 Presto 将过滤条件（如 `WHERE date = '2024-01-01'`）下推到 HMS 查询，只返回匹配的分区。

```
代价：
  仅对分区键的等值过滤有效
  对非分区键的过滤（如 `WHERE user_id = 12345`）完全无效
  对"分区键的函数"（如 `WHERE MONTH(date) = 1`）无效 ← 常见陷阱！
```

Netflix 的工程师 Ryan Blue 和 Dan Weeks 在尝试了所有这些补丁之后，得出了一个结论：**HMS 的根本问题不是实现质量，而是架构设计**——把表格式与 HDFS 目录结构耦合，把元数据存储与计算引擎耦合，这两个设计决策在大规模场景下都是错误的。于是他们开始设计 Iceberg。

---

## 第 2 章 Iceberg 的设计答案

### 2.1 核心洞察：表应该是文件的集合，而不是目录的层次结构

Iceberg 的第一个核心洞察是：**表的本质是一个文件集合（set of files），而不是一个目录层次结构（directory hierarchy）**。

这个洞察的价值在于：一旦从"文件集合"的视角定义表，就不再需要依赖文件系统的目录结构来表示分区——分区信息可以存储在元数据文件中，文件路径可以是任意的（甚至可以是 UUID 命名的随机路径）。

```
Hive/HMS 的表定义方式（目录层次结构）：
  表 = HDFS 路径（/data/events/）
  分区 = 子目录（/data/events/date=2024-01-01/）
  文件 = 目录内的文件（/data/events/date=2024-01-01/part-00000.parquet）

Iceberg 的表定义方式（文件集合）：
  表 = 一个元数据文件指针
  快照 = 一个文件列表（包含每个文件的路径、大小、列统计）
  分区 = 元数据中的字段（不反映在文件路径上！）
  文件 = 任意路径的 Parquet 文件（路径不携带分区信息）
```

**这个看似简单的视角转换，带来了深远的工程影响**：

1. **不再需要 MSCK REPAIR TABLE**：Iceberg 的元数据完整记录了所有文件，无需通过扫描目录"发现"文件
2. **分区可以在元数据层演进**：修改分区策略只需更新元数据规则，旧文件按旧规则、新文件按新规则，查询引擎根据元数据自动处理
3. **文件移动不破坏表结构**：文件路径只是元数据中的一个字符串，移动文件后更新元数据即可

### 2.2 核心洞察二：元数据应该与引擎无关

第二个核心洞察是：**表格式规范（table format spec）应该是一个中立的、引擎无关的标准**，而不是某个特定框架（Spark/Hive）的内部数据结构。

这个洞察催生了 Iceberg 规范（Iceberg Table Spec）——一份描述表格式的文档，规定了元数据文件的 JSON 结构、Avro 模式、Parquet 文件的布局要求等。任何遵守这个规范的引擎，都能读写 Iceberg 表：

```
Iceberg 规范定义了：
  - metadata.json 的 JSON 结构（表级元数据）
  - Snapshot 的 Avro 模式（快照级元数据）
  - Manifest List 的 Avro 模式（文件组级元数据）
  - Manifest File 的 Avro 模式（文件级元数据，含列统计）
  - 分区规范（partition spec）的表示格式
  - 数据类型系统（与 Parquet/ORC/Avro 的类型映射）
  - Schema 演进的规则（列 ID 机制）

遵守规范的引擎（均有官方实现）：
  Spark（spark-iceberg）
  Flink（flink-iceberg）
  Trino（内置 Iceberg 连接器）
  Presto（Iceberg 连接器）
  Hive（Iceberg StorageHandler）
  StarRocks / Doris（Iceberg 外表）
  DuckDB（Iceberg 扩展）
```

> [!note] 开放规范 vs 开源实现的区别
> Delta Lake 也是开源的，但它的"格式规范"直接耦合了 Spark 的实现细节（如依赖 `org.apache.spark` 包中的类型系统）。非 Spark 引擎要读 Delta 表，必须理解并重新实现这些 Spark 特定的细节，导致多引擎支持质量参差不齐。
> Iceberg 的规范则是一份独立的文档（`https://iceberg.apache.org/spec/`），用 JSON 和 Avro 模式定义，与任何特定语言或框架无关——Trino 用 Java、DuckDB 用 C++ 都能完整实现这个规范。

### 2.3 Iceberg 解决的三类问题

综合 Netflix 的工程困境，Iceberg 的设计目标可以归纳为三类：

**问题类型 A：元数据扩展性（Scalability）**

HMS 在数百万分区下的性能崩溃。Iceberg 的解法：用层次化的元数据文件（三层：metadata.json → Snapshot → Manifest List → Manifest File）替代 HMS，每层文件只需读取少量数据即可完成分区剪裁，彻底避免了"列举所有分区"的全量扫描。

**问题类型 B：正确性（Correctness）**

多引擎并发读写的数据一致性问题。Iceberg 的解法：引入 Snapshot 快照隔离——每次写操作原子地创建一个新 Snapshot，读操作始终看到某个完整的 Snapshot（不会看到"写了一半"的数据）。

**问题类型 C：可进化性（Evolvability）**

分区演进、Schema 演进的困难。Iceberg 的解法：Hidden Partitioning（分区规则存在元数据中，不编码在文件路径里）+ 列 ID 机制（Schema 演进时列用 ID 标识，而不是列名）。

---

## 第 3 章 Iceberg 的整体架构全景

### 3.1 四层元数据结构

Iceberg 的元数据组织成四层结构，每层有明确的职责：

```
物理存储（S3 / HDFS）
│
├── Catalog（目录服务，记录"当前元数据文件在哪里"）
│   ├── Hive Metastore（最常用）
│   ├── REST Catalog（Iceberg 推荐的现代方式）
│   ├── Glue Catalog（AWS 原生）
│   └── JDBC Catalog（关系数据库）
│
├── metadata/
│   ├── v1.metadata.json    ← 表级元数据（Schema + 分区规范 + 历史 Snapshot 列表）
│   ├── v2.metadata.json
│   ├── snap-12345.avro     ← Snapshot（快照）：记录本次写入覆盖的 ManifestList
│   ├── manifest-list-12345.avro  ← ManifestList：本次写入的 Manifest 文件列表
│   └── manifest-abc.avro   ← Manifest：一批数据文件的详细信息（含列统计）
│
└── data/
    ├── 2024-01-01/         ← 分区目录（不是必须，但常用）
    │   ├── 00000-1-abc.parquet
    │   └── 00000-2-def.parquet
    └── 2024-01-02/
        └── 00000-3-ghi.parquet
```

这个四层结构的设计逻辑将在下一篇[[02 元数据三层架构——Snapshot、Manifest List 与 Manifest File]]中深入解析。

### 3.2 Catalog：引擎与表之间的桥梁

**Catalog** 是 Iceberg 中一个容易被忽视但极其重要的概念。它是引擎"找到表"的入口——Catalog 知道表名到最新 metadata.json 文件路径的映射：

```
查询执行流程（Trino 查询 Iceberg 表）：

1. Trino 向 Catalog 查询：
   "SELECT metadata_file_path FROM catalog WHERE table = 'events'"
   → 返回：s3://bucket/events/metadata/v42.metadata.json

2. Trino 读取 v42.metadata.json：
   → 获取最新 Snapshot ID：snap-98765
   → 获取 Schema、分区规范

3. Trino 读取 snap-98765 的 ManifestList：
   → 获取本次快照包含的 Manifest 文件列表

4. 根据查询条件（WHERE date = '2024-01-01'），过滤 Manifest：
   → 只读包含 date=2024-01-01 分区数据的 Manifest

5. 读取筛选出的 Manifest，获取实际数据文件列表

6. 扫描 Parquet 文件执行查询
```

**REST Catalog（Iceberg 推荐标准）**：

Iceberg 社区提出了 REST Catalog 标准——通过 HTTP REST API 提供 Catalog 服务，实现了 Catalog 与具体存储（HMS/Glue/自研数据库）的完全解耦：

```
REST Catalog API 示例：
  GET  /v1/namespaces/analytics/tables/events
  → 返回 metadata.json 的位置

  POST /v1/namespaces/analytics/tables/events/transactions/commit
  → 原子地更新 metadata.json 指针（提交新 Snapshot）
```

这使得各云厂商可以提供自己的 Catalog 服务（AWS 的 S3 Tables、Snowflake Open Catalog），同时与所有 Iceberg 兼容的引擎互操作——这是 Iceberg 生态的核心竞争力。

---

## 第 4 章 Iceberg 与 Hudi/Delta Lake 的本质差异

### 4.1 "表格式规范" vs "数据湖框架"

理解三者的本质差异，需要区分两个概念：

- **数据湖框架**：包含一套完整的"写入 API + 读取 API + 元数据管理"的实现，特定于某些计算引擎（Hudi 对 Spark/Flink，Delta Lake 对 Spark）
- **开放表格式规范**：只定义"数据如何在存储层组织"的标准，不包含任何计算引擎的具体 API

Iceberg 选择了后者。这意味着：

- **Iceberg 没有"HoodieWriteClient"这样的写入框架**——写入完全由引擎（Spark/Flink）的 Iceberg 连接器实现
- **Iceberg 没有"Timeline"这样的操作日志**——只有 Snapshot，没有记录"谁在什么时候用什么方式写入"的操作元数据
- **Iceberg 没有记录级索引**——它的查询加速完全依赖于 Manifest 中的列统计信息，不能精准定位单条记录

这些"没有"不是缺陷，而是设计选择——**专注于格式规范，把写入优化留给引擎**。

### 4.2 三者的场景互补

| 场景 | 最佳选择 | 原因 |
|-----|---------|-----|
| 多引擎数据湖 | **Iceberg** | REST Catalog + 规范统一，Trino/Spark/Flink 无缝切换 |
| 高频 CDC Upsert | **Hudi** | 记录级 Index，Upsert 效率最高 |
| Databricks 平台 DML | **Delta Lake** | 平台原生深度优化 |
| 云原生（Athena/Glue）| **Iceberg** | AWS 原生集成最好 |
| 分区演进需求 | **Iceberg** | Hidden Partitioning 是同类最强 |

---

## 小结

Iceberg 不是"更好的 Hudi"，也不是"更开放的 Delta Lake"——它是一个**不同层次**的解法。Hudi 和 Delta Lake 是"数据湖框架"，解决写入效率和 ACID 事务；Iceberg 是"表格式规范"，解决多引擎互操作和元数据扩展性。

Netflix 的 10PB 困境暴露了 HMS 模型的根本缺陷，而 Iceberg 的回答是：**把表的定义从"文件系统目录结构"提升到"与引擎无关的元数据规范"**。

下一篇 [[02 元数据三层架构——Snapshot、Manifest List 与 Manifest File]] 将深入 Iceberg 最核心的技术创新——三层元数据结构，解析为什么这个设计能将"列举 100 万个分区"的元数据查询时间从数分钟压缩到毫秒级，以及 Snapshot 如何实现无锁的快照隔离。
