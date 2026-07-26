---
title: "Connector 体系——Hive、Iceberg 与联邦查询"
date: 2026-03-05
tags: [Connector, Hive, Iceberg, SPI, Trino, 中间件, 数据湖, 联邦查询, 谓词下推]
aliases: []
---

# Connector 体系——Hive、Iceberg 与联邦查询

## 摘要

**Connector** 是 Trino 实现"存储计算分离"和"联邦查询"能力的核心抽象。每种外部存储系统（Hive Metastore、Iceberg、MySQL、Kafka、Elasticsearch 等）通过实现 Trino 的 **Connector SPI（Service Provider Interface）** 接入 Trino，Trino 的查询优化器和执行引擎只与 SPI 交互，对底层存储的细节完全无感知。本文深度解析 Connector SPI 的设计哲学与核心接口，重点剖析两个最重要的生产级 Connector：**Hive Connector**（传统数据仓库，理解 Split 生成和分区裁剪）和 **Iceberg Connector**（现代表格式，理解文件级别的元数据、时间旅行和 Schema 演变），并系统介绍 Trino 如何通过跨 Catalog 的 SQL JOIN 实现真正的**联邦查询**，以及联邦查询中下推优化的局限性与工程取舍。

---

## 第 1 章 Connector 的设计哲学

### 1.1 存储多样性的工程挑战

互联网企业的数据通常分散在多个异构系统中：用户行为数据在 Hive/HDFS，订单数据在 MySQL，实时日志在 Kafka，产品信息在 Elasticsearch，ML 特征在 HBase。若要回答"哪些用户在过去 7 天内下单且浏览了超过 10 个商品"，需要 JOIN Hive 的行为日志和 MySQL 的订单表——在 Trino 之前，这需要先将 MySQL 数据导入 Hive，再执行 Hive SQL，数据准备延迟以小时计。

Trino 的 Connector 体系从根本上解决了这个问题：通过统一的 SPI 接口，将不同存储系统的数据抽象为"表"，Trino 的查询优化器和执行引擎看到的是统一的表抽象，JOIN 跨系统的数据与 JOIN 同一系统的数据没有任何区别（从 SQL 语法层面）。

### 1.2 Catalog——Connector 的挂载点

Trino 通过 **Catalog** 将 Connector 挂载到查询命名空间中。每个 Catalog 对应一个 Connector 实例的配置，有唯一的名称（如 `hive`、`mysql_prod`、`iceberg_datalake`）。

表的完整引用格式为：`catalog.schema.table`。例如：
- `hive.user_db.behavior_log`：Hive Catalog 下的用户行为日志表
- `mysql_prod.orders.order_items`：MySQL 生产库的订单明细表
- `iceberg_datalake.analytics.daily_metrics`：Iceberg 数据湖中的每日指标表

Catalog 的配置文件存放在 Coordinator 的 `etc/catalog/` 目录下，每个 `.properties` 文件对应一个 Catalog：

```properties
# etc/catalog/hive.properties
connector.name=hive
hive.metastore.uri=thrift://metastore-host:9083
hive.config.resources=/etc/hadoop/core-site.xml,/etc/hadoop/hdfs-site.xml
hive.max-partitions-per-scan=1000000

# etc/catalog/mysql_prod.properties
connector.name=mysql
connection-url=jdbc:mysql://mysql-host:3306
connection-user=trino_reader
connection-password=...

# etc/catalog/iceberg_datalake.properties
connector.name=iceberg
iceberg.catalog.type=hive_metastore
hive.metastore.uri=thrift://metastore-host:9083
```

### 1.3 SPI 的设计原则

Connector SPI 遵循三个设计原则：

**原则一：元数据抽象**——Connector 必须能回答"有哪些 Schema、Table、Column，每个 Column 的类型是什么"。不同存储系统的元数据存储方式完全不同（Hive 用 Metastore，MySQL 用 `information_schema`，Kafka 用 Schema Registry），SPI 统一了查询接口。

**原则二：数据分片（Split）**——Connector 负责将数据切分为可并行读取的 Split，并告知 Trino 每个 Split 的"首选读取节点"（用于数据本地性调度）。Split 的粒度和定义由 Connector 自行决定。

**原则三：谓词下推（Predicate Pushdown）**——Connector 可以声明自己能处理哪些过滤条件，Trino 的优化器将这些条件下推给 Connector，让 Connector 在数据读取阶段就过滤掉不满足条件的数据，减少传输到 Trino 引擎的数据量。

---

## 第 2 章 Hive Connector——传统数据仓库的接入

### 2.1 Hive 表的存储模型

理解 Hive Connector 的工作机制，必须先理解 Hive 表的存储模型：

**Hive 表的分区机制**：Hive 支持**分区表（Partitioned Table）**，将数据按指定列（如 `dt`、`region`）的值分割为独立的目录。例如，`behavior_log` 表按日期分区：

```
HDFS 路径结构：
/warehouse/behavior_log/
    dt=2024-01-01/
        part-00000.orc  (128MB)
        part-00001.orc  (128MB)
        ...
    dt=2024-01-02/
        part-00000.orc
        ...
    dt=2024-01-03/
        ...
```

每个分区对应 HDFS 上的一个目录，目录下有若干个文件（ORC/Parquet/TextFile 格式）。

**Hive Metastore（HMS）** 存储这个表的元数据：
- 表的 Schema（列名、列类型、序列化格式）
- 分区列的名称和值
- 每个分区对应的 HDFS 路径

### 2.2 Split 的生成过程

Hive Connector 的 Split 生成是理解其性能特性的关键，完整流程：

```
1. Trino 优化器调用 HiveMetadata.getTableLayouts()
   - 传入 constraint（如 "dt >= '2024-01-01' AND dt <= '2024-01-07'"）
   - HiveMetadata 连接 HMS，根据 constraint 过滤分区
   - 返回匹配的分区列表（7 个分区，而不是全部分区）
   → 分区裁剪（Partition Pruning）完成，跳过所有不在日期范围内的分区

2. Trino 调度器调用 HiveSplitManager.getSplits()
   - 对每个匹配的分区，列举 HDFS 目录下的所有文件
   - 对每个文件，按文件块大小（默认 128MB）切分为 Split
   - 每个 Split 记录：HDFS 路径 + 偏移量 + 长度 + 首选节点列表
   → 假设每个分区 100 个文件，每个文件 128MB，7 个分区共产生 700 个 Split

3. Coordinator 将 700 个 Split 分发给 Worker，
   每个 Worker 读取若干个 Split（约 700/Worker数量 个）

4. Worker 上的 HivePageSourceFactory 为每个 Split 创建 OrcPageSource
   - OrcPageSource 利用 ORC 的列存索引（Row Group Statistics）
   - 根据剩余未下推的过滤条件（非分区列的过滤，如 user_age > 25）
   - 跳过不满足条件的 Row Group（ORC Row Group 级别过滤，每 10000 行一组）
```

**分区裁剪的巨大价值**：假设 `behavior_log` 有 3 年的历史数据（1095 个分区），WHERE 子句中包含 `dt >= '2024-01-01' AND dt <= '2024-01-07'`，分区裁剪使 Trino 只扫描 7 个分区（1/156 的数据），IO 减少超过 99%。这是大数据分析性能的基石。

### 2.3 ORC/Parquet 文件格式的利用

Hive Connector 能充分利用 ORC 和 Parquet 的内置元数据做进一步过滤：

**ORC Row Group Statistics**：ORC 文件每 10000 行有一个 Row Group（Stripe），每个 Stripe 记录每列的最小值和最大值。若查询条件是 `user_age > 60`，而某个 Stripe 的 `user_age` 最大值是 45，则该 Stripe 可以直接跳过（不读取）。

**Parquet Row Group / Page Index**：Parquet 有类似的 Row Group Statistics，以及 Parquet 1.12+ 引入的 Column Index（更精细的 Page 级别统计）。Trino 的 Parquet Reader 能利用这些统计信息跳过不相关的 Row Group 和 Page。

**谓词下推到文件格式层（三层过滤架构）**：

```
第一层：分区裁剪（Connector 元数据层）
  → 跳过不匹配分区（目录级别，跳过 99%+ 的数据）

第二层：文件级统计过滤（ORC/Parquet Row Group Statistics）
  → 跳过不匹配的 Row Group（万行级别）

第三层：Trino FilterOperator
  → 行级别精确过滤（无法下推的复杂条件）
```

### 2.4 Hive Connector 的配置要点

```properties
# HMS 连接配置
hive.metastore.uri=thrift://hms-host:9083
hive.metastore-timeout=10s

# 分区扫描上限（防止分区数量过多导致 Coordinator 超时）
hive.max-partitions-per-scan=1000000

# ORC 配置
hive.orc.use-column-names=true       # 按列名读取（兼容 Schema 演变）
hive.orc.bloom-filters.enabled=true  # 启用 Bloom Filter 过滤

# Parquet 配置
hive.parquet.use-column-names=true

# S3 配置（若数据在 S3）
hive.s3.path-style-access=true
hive.s3.endpoint=https://s3.amazonaws.com

# 动态过滤（重要性能配置）
hive.dynamic-filtering.wait-timeout=1s
```

> [!warning] 生产避坑
> `hive.max-partitions-per-scan` 默认值为 100000，若表的分区数量超过此限制，查询会报错。对于按小时分区的表（每天 24 个分区，3 年约 26000 个分区），通常不会触发。但对于按事件 ID 分区（高基数分区列）的表，可能需要调高此参数或重新设计分区策略。

---

## 第 3 章 Iceberg Connector——现代数据湖格式

### 3.1 Iceberg 解决的问题——Hive 表格式的局限

传统 Hive 表格式（以 HMS + HDFS 目录结构组织数据）在生产中有几个关键局限：

**局限一：没有 ACID 事务**。Hive 表不支持原子性更新——若 ETL 写入一半时失败，会留下不完整的数据文件，后续查询可能读到部分数据。处理这个问题需要额外的"写前重命名"等工程手段，复杂且容易出错。

**局限二：全量分区扫描的 Metastore 压力**。查询一个有 100 万个分区的表时，Hive 需要从 HMS 获取所有 100 万个分区的路径，再过滤出相关的。HMS 的查询压力随分区数量线性增长，成为性能瓶颈。

**局限三：Schema 演变困难**。Hive 支持添加列（在尾部追加），但不支持删除列、重命名列、改变列顺序——这些操作会导致历史数据与新 Schema 不兼容。

**局限四：没有文件级别的统计信息**。Hive 的分区统计（Row Count、Column Stats）需要手动执行 `ANALYZE TABLE` 才能更新，且粒度是分区级别，无法做文件级别的精细过滤。

**Apache Iceberg** 是 Netflix 开源的开放表格式（Open Table Format），从根本上重新设计了"表是什么"的概念，解决了上述所有局限。

### 3.2 Iceberg 的元数据层次

Iceberg 表的元数据以**层次化文件结构**存储（与 Hive 的 Metastore 数据库存储完全不同）：

```
Iceberg 表的元数据文件结构：

s3://bucket/warehouse/my_db/my_table/
    metadata/
        v1.metadata.json    ← 表的第 1 个快照的元数据
        v2.metadata.json    ← 表的第 2 个快照的元数据（最新）
        v3.metadata.json    ← 执行 INSERT/DELETE/UPDATE 后生成新版本
        ...
        snap-001.avro       ← Snapshot 清单列表（Manifest List）
        snap-002.avro
        ...
    data/
        00000.parquet       ← 实际数据文件
        00001.parquet
        ...
    ...
```

**Iceberg 元数据的三层结构**：

```
Catalog（Hive Metastore / REST Catalog）
    → 指向最新的 metadata.json 路径

metadata.json（表元数据）
    → Schema 定义（当前 + 历史版本）
    → 快照列表（Snapshot List）
    → 当前快照 ID
    → 分区规范（Partition Spec，按列+转换函数定义）

Manifest List（snap-xxx.avro）
    → 本次快照涉及的所有 Manifest File 的路径
    → 每个 Manifest File 的 Partition 统计信息（用于分区裁剪）

Manifest File（manifests/*.avro）
    → 本次快照中增加或删除的数据文件列表
    → 每个数据文件的：路径、行数、文件大小、每列的最小/最大值（用于文件级别过滤）

Data File（data/*.parquet）
    → 实际的 Parquet/ORC/Avro 数据文件
```

### 3.3 Iceberg 相对 Hive 的核心优势

**优势一：文件级别的统计信息（无需 ANALYZE）**。每个数据文件的最小值/最大值在写入时自动记录在 Manifest File 中，查询时无需扫描文件本身就能判断是否包含目标数据。Trino 的 Iceberg Connector 利用这些统计信息做精细的文件裁剪（File Pruning），比 Hive 的行组级别过滤效率更高。

**优势二：时间旅行（Time Travel）**。Iceberg 的快照机制使得每次写入都产生一个新的不可变快照，历史快照被保留（受 `write.metadata.delete-after-commit.enabled` 控制）。用户可以查询历史某个时刻的数据：

```sql
-- 查询 2024-01-15 12:00:00 时的数据状态
SELECT * FROM iceberg_catalog.my_db.my_table
FOR TIMESTAMP AS OF TIMESTAMP '2024-01-15 12:00:00';

-- 查询某个快照 ID 时的数据
SELECT * FROM iceberg_catalog.my_db.my_table
FOR VERSION AS OF 8439729893128120;
```

**优势三：真正的 Schema 演变**。Iceberg 通过**列 ID（Column ID）** 追踪列的身份——列名可以改变，但 ID 不变，历史数据文件按 ID 读取正确的列，而不是按位置或名称。支持的操作：
- `ADD COLUMN`：在任意位置添加列
- `DROP COLUMN`：删除列（历史数据中该列变为 null）
- `RENAME COLUMN`：重命名列（历史数据透明兼容）
- `CHANGE COLUMN TYPE`：有限制的类型升级（如 int → long）

**优势四：并发写入安全（Optimistic Concurrency Control）**。多个写入任务并发写入同一个 Iceberg 表时，通过**乐观锁机制**保证原子性：
1. 每个写入任务读取当前 metadata.json 的版本号（如 v2）
2. 写入数据文件，生成新的 Manifest，构建新的 metadata.json（v3）
3. 原子地替换 Catalog 中的当前版本指针（v2 → v3）
4. 若另一个写入任务同时生成了 v3，则产生冲突，失败者重试

这使得 Iceberg 支持多个 ETL 任务并发写入同一张表，无需外部加锁协调。

### 3.4 Trino 的 Iceberg Connector 查询优化

Trino 的 Iceberg Connector 充分利用 Iceberg 的元数据做多层优化：

**分区裁剪（Partition Pruning，Manifest List 层）**：
- Iceberg 的分区是"隐式分区"——分区列通常是对数据列的转换（如 `days(event_date)` 表示按天分区）
- Manifest List 中记录了每个 Manifest File 覆盖的分区范围
- 查询 `WHERE event_date = '2024-01-15'` 时，Trino 只需读取覆盖该日期的 Manifest File，而不是所有 Manifest File

**文件级别裁剪（File-Level Pruning，Manifest File 层）**：
- Manifest File 中记录了每个数据文件的每列的最小值和最大值
- `WHERE user_age > 50` 时，Trino 跳过所有 `user_age` 最大值 ≤ 50 的数据文件
- 这比 Hive 的 Row Group Statistics 粒度更细（文件级别 vs Row Group 级别）

**删除向量支持（Delete Files，Merge-on-Read）**：
Iceberg 的删除操作有两种模式：
- **Copy-on-Write（CoW）**：删除时重写整个数据文件（去掉被删除的行），读性能好，写代价高
- **Merge-on-Read（MoR）**：删除时只写一个"删除文件"（记录被删除行的主键），读时合并数据文件和删除文件，写代价低，读有额外开销

Trino 同时支持两种模式，对于 MoR 模式，读取时会自动合并数据文件和删除文件，对用户透明。

---

## 第 4 章 联邦查询——跨系统 JOIN 的实现

### 4.1 跨 Catalog 查询语法

Trino 的联邦查询通过在表名前加 Catalog 前缀来引用不同系统的表：

```sql
-- 跨系统联邦查询示例：
-- 关联 Hive 的行为日志 + MySQL 的用户表 + Iceberg 的订单数据
SELECT
    u.user_name,
    u.age_group,
    count(DISTINCT b.session_id) AS sessions,
    sum(o.order_amount) AS total_spend
FROM
    hive.analytics.behavior_log AS b          -- Hive 表（HDFS）
    JOIN mysql_prod.users.user_profile AS u    -- MySQL 表
        ON b.user_id = u.user_id
    JOIN iceberg_datalake.orders.order_facts AS o  -- Iceberg 表（S3）
        ON b.user_id = o.user_id
WHERE
    b.dt = '2024-01-15'                       -- Hive 分区裁剪
    AND u.country = 'CN'                       -- MySQL 谓词下推
    AND o.order_date = DATE '2024-01-15'
GROUP BY u.user_name, u.age_group
ORDER BY total_spend DESC
LIMIT 100;
```

Trino 的优化器会自动处理跨 Catalog 的 JOIN——它不关心每个表来自哪个存储系统，只关心如何生成最优的执行计划（如将小表广播 JOIN，将大表 Hash 分区 JOIN）。

### 4.2 联邦查询的执行策略

跨系统 JOIN 面临一个根本问题：**数据在不同系统中，无法直接在存储层 JOIN，必须将所有数据拉取到 Trino 的 Worker 内存中处理**。

Trino 采用以下策略优化联邦 JOIN 的性能：

**谓词下推到各 Connector**：
- `b.dt = '2024-01-15'` → 下推到 Hive Connector，只读取该分区
- `u.country = 'CN'` → 下推到 MySQL Connector，生成 `WHERE country='CN'` 的 SQL 发给 MySQL
- `o.order_date = DATE '2024-01-15'` → 下推到 Iceberg Connector，做文件级别裁剪

**小表广播 JOIN**：
- `user_profile` 通常比 `behavior_log` 小很多，Trino 优化器（CBO）根据行数统计信息，决定将 `user_profile` 作为广播表（所有 Worker 各自保存一份完整副本，不做 Shuffle）
- `behavior_log` 的 Split 分散在各 Worker，每个 Worker 直接用本地的 `user_profile` Hash Table 做 Lookup，避免了一次 Shuffle

**投影下推（Column Pruning）**：
- 每个 Connector 只读取查询需要的列，不读取无关列
- 对于 Parquet/ORC 等列存格式，这减少了大量 IO

### 4.3 联邦查询的局限性

联邦查询并非万能，有几个重要局限：

**局限一：无法下推 JOIN 计算**。Trino 不能将 JOIN 下推到存储层——它无法告诉 MySQL "请帮我和 HDFS 的数据做 JOIN"。所有 JOIN 必须在 Trino Worker 内存中执行，这意味着 JOIN 的两侧数据都必须读取到 Trino 内存，可能产生大量网络传输。

**局限二：MySQL 等 OLTP 系统的全表扫描压力**。若 MySQL 表很大（如千万行），Trino 对其全表扫描会给 MySQL 带来极大压力，可能影响在线业务。实践中应避免在 Trino 中对生产 MySQL 数据库做大规模扫描，改用从 MySQL 同步到 Hive/Iceberg 的副本。

**局限三：跨系统谓词下推的有限性**。动态过滤（Dynamic Filtering，将 Join 的小表结果动态下推到大表的扫描条件）只在同一个 Connector 内有效——若大表在 Hive，小表在 MySQL，动态过滤可以将 MySQL 查询结果（如用户 ID 列表）下推到 Hive 扫描；但若大小表来自完全不同类型的 Connector，动态过滤的效果可能受限。

> [!note] 设计哲学
> 联邦查询的本质是"以 CPU 和内存换取数据不移动"——不需要先 ETL 数据再查询，而是在查询时实时从各系统拉取数据在内存中处理。这对于数据量不太大（总数据几十 GB 以内）、需要跨系统实时关联的场景非常适合；对于数百 GB 以上的大表 JOIN，仍然建议提前将数据同步到统一的数据湖（Iceberg），再用 Trino 在单一 Catalog 内高效查询。

---

## 第 5 章 其他重要 Connector

### 5.1 Delta Lake Connector

**[[Delta Lake]]** 是 Databricks 开源的表格式，类似于 Iceberg，提供 ACID 事务、Schema 演变、时间旅行能力。与 Iceberg 的主要区别：
- Delta Lake 使用 `_delta_log/` 目录下的 JSON 文件记录事务日志（Transaction Log），而非 Iceberg 的 Avro Manifest 文件
- Delta Lake 的社区和 Databricks 生态绑定更紧（Databricks Runtime 是首要支持目标）
- Trino 的 Delta Lake Connector 支持读取 Delta 表，包括时间旅行查询

### 5.2 MySQL/PostgreSQL Connector（JDBC Connector）

JDBC Connector 是 Trino 连接关系型数据库的通用实现，其 Split 生成策略与 Hive 截然不同：

**单 Split 模式**：默认情况下，MySQL 表的查询只有 1 个 Split（一次全表扫描），不能并行。这是因为 MySQL 没有类似 HDFS 的分布式块存储，无法天然切分为多个并行任务。

**多 Split 模式**（通过 `domain-compaction-threshold` 和表级配置）：Trino 支持将 MySQL 表按主键范围切分为多个 Split，实现并行扫描（需要配置 `join-pushdown.enabled=true` 等参数）。但要注意并发扫描对 MySQL 的压力。

**谓词下推到 SQL**：MySQL Connector 将 Trino 的过滤条件转换为 SQL WHERE 子句，直接发给 MySQL 执行。`user_age > 25 AND country = 'CN'` 会变成 `SELECT ... FROM table WHERE user_age > 25 AND country = 'CN'`，MySQL 自身的索引被利用，性能远好于 Trino 层面的行过滤。

### 5.3 Kafka Connector

Kafka Connector 允许直接将 Kafka Topic 作为 Trino 表查询，每条消息是一行，Split 对应一个 Partition 的一段 Offset 范围。

实用场景：对最近一小时的实时日志做即席分析（不需要先消费到 Hive/Iceberg），结合 Trino 的 SQL 能力快速聚合分析。

**局限**：Kafka 的数据是无 Schema 的（默认是字节流），需要通过 Trino 的 Kafka Table Definition（JSON 配置文件）或 Schema Registry 定义表结构。且 Kafka 不支持谓词下推——所有消息都会被读取到 Trino，在 Worker 内存中过滤，对大 Partition 性能较差。

---

## 第 6 章 Connector 开发——自定义 Connector

### 6.1 什么时候需要自定义 Connector

Trino 内置了约 30 种 Connector，覆盖了主流存储系统。以下场景可能需要自定义 Connector：
- 企业内部的自研存储系统（如自研的分布式 KV 存储）
- 需要访问特定 REST API 作为数据源
- 对现有 Connector 的深度定制（如添加自定义的谓词下推逻辑）

### 6.2 自定义 Connector 的最小实现

一个最小化的只读 Connector 需要实现：

```java
// 1. 注册 Connector 工厂
public class MyConnectorPlugin implements Plugin {
    @Override
    public Iterable<ConnectorFactory> getConnectorFactories() {
        return ImmutableList.of(new MyConnectorFactory());
    }
}

// 2. Connector 工厂（从配置创建 Connector 实例）
public class MyConnectorFactory implements ConnectorFactory {
    @Override
    public String getName() { return "my_connector"; }

    @Override
    public Connector create(String catalogName, Map<String, String> config, ...) {
        return new MyConnector(config);
    }
}

// 3. Connector 主类（注册各组件）
public class MyConnector implements Connector {
    @Override
    public ConnectorTransactionHandle beginTransaction(...) { ... }

    @Override
    public ConnectorMetadata getMetadata(...) { return new MyMetadata(); }

    @Override
    public ConnectorSplitManager getSplitManager() { return new MySplitManager(); }

    @Override
    public ConnectorPageSourceProvider getPageSourceProvider() { return new MyPageSourceProvider(); }
}
```

实现上述三个核心类（`MyMetadata`、`MySplitManager`、`MyPageSourceProvider`）后，就能在 Trino 中通过 SQL 查询自定义数据源。

---

## 第 7 章 小结

### 7.1 Connector 体系的工程价值

Trino Connector 体系的核心工程价值在于：**将"如何读取数据"与"如何处理数据"彻底解耦**。

Trino 的查询优化器和执行引擎永远只与 SPI 接口交互，不关心数据存储在哪里、以什么格式存储、如何读取。这使得：
1. 新增数据源只需实现 Connector，不需要修改 Trino 核心
2. Trino 的优化技术（CBO、动态过滤、谓词下推框架）对所有 Connector 统一适用
3. 用户通过统一的 SQL 接口访问所有数据源，不需要学习每个数据源的专有查询语言

### 7.2 Hive vs Iceberg 的选型建议

| 场景 | 推荐格式 | 理由 |
|------|---------|------|
| 历史遗留 Hive 数仓，无需改造 | 继续用 Hive 格式 + Trino Hive Connector | 改造成本不合理 |
| 新建数据湖，需要 ACID + Schema 演变 | Iceberg | 功能完整，社区活跃 |
| Databricks 主导的架构 | Delta Lake | 与 Databricks 生态集成更好 |
| 需要时间旅行和增量读取 | Iceberg | 原生支持，语法简洁 |
| 超高写入吞吐，接受读时合并代价 | Iceberg MoR 模式 | 写代价最低 |

### 7.3 后续章节导引

- **[[04 内存管理与资源调度]]**：深入 Trino 的分级内存管理，以及资源组如何在多租户场景下实现查询隔离
- **[[05 查询优化——CBO、动态过滤与索引下推]]**：解析 Trino 的基于代价的优化器（CBO）如何选择最优 Join 策略，以及动态过滤如何在运行时进一步减少数据扫描量

---

> [!note] 思考题
> 1. Hive Connector 是 Trino 最常用的 Connector——读取 HDFS/S3 上的 Parquet/ORC 文件。Trino 的列裁剪（Column Pruning）只读取查询需要的列——对于列式存储格式（Parquet/ORC），这意味着大量数据无需从磁盘读取。在一个 100 列的表中查询 3 列，数据读取量减少了多少？
> 2. JDBC Connector 连接关系型数据库（MySQL、PostgreSQL）。Trino 将 SQL 翻译为目标数据库的方言并下推执行。但并非所有函数都能下推——如果 Trino SQL 中使用了目标数据库不支持的函数，该函数在 Trino 端执行。你如何判断哪些操作被下推了（`EXPLAIN` 输出中查看 ScanFilterProject 节点）？
> 3. Iceberg Connector 支持 Time Travel 查询（查询历史版本的数据）和 Schema Evolution（列的增删改不影响已有数据）。这些能力是 Iceberg 表格式本身提供的还是 Trino Connector 实现的？Trino 读取 Iceberg 表时的 Metadata 解析开销有多大？
