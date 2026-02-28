---
title: "多引擎生态：Spark、Presto、Flink 与 Hive 的互操作"
date: 2026-02-28
tags: [Delta Lake, 多引擎, Presto, Flink, Hive, UniForm, Iceberg, Delta协议, 互操作, 开放格式]
aliases: []
---

# 11 多引擎生态：Spark、Presto、Flink 与 Hive 的互操作

## 摘要

Lakehouse 架构的核心承诺之一是**开放性**——同一份数据（存储在 S3/HDFS 的 Parquet 文件上），可以被不同计算引擎读取和写入，不被任何单一引擎锁定。Delta Lake 在设计之初就将开放性作为第一优先级：Delta Log 是基于标准 JSON 和 Parquet 格式的公开规范（Delta Protocol），任何能读写这两种格式的引擎都可以实现 Delta Lake 的读写支持。本文系统梳理 Delta Lake 与主流计算引擎的互操作现状：**Presto/Trino**（最常见的 Delta 只读查询引擎）、**Apache Flink**（流式写入 Delta 的主要替代方案）、**Apache Hive**（遗留引擎的向后兼容）。更重要的是，介绍 Delta Lake 3.0 推出的 **UniForm（Universal Format）**——通过在 Delta 表中同时维护 Iceberg 和 Hudi 的元数据，让不支持 Delta 协议但支持 Iceberg/Hudi 的引擎（如 AWS Athena、Snowflake）也能透明地读取 Delta 数据。UniForm 代表了 Lakehouse 生态从"各自为战"走向"协议互通"的重要一步。

---

## 第 1 章 Delta Protocol：开放的技术基础

### 1.1 Delta Protocol 是什么

**Delta Protocol**（Delta Lake 协议规范）是 Delta Lake 数据格式的完整公开规范，定义了：
- `_delta_log/` 目录的结构和命名约定
- JSON Action 的类型和字段语义（`add`、`remove`、`commitInfo`、`metaData`、`protocol`）
- Checkpoint 文件的格式（Parquet 文件的 Schema）
- 并发控制的语义（OCC 的冲突检测规则）
- 各个特性（Column Mapping、Deletion Vector、Change Data Feed）的协议版本要求

协议规范公开发布在 GitHub（`delta-io/delta/PROTOCOL.md`），任何第三方都可以基于这个规范实现 Delta Lake 的读写客户端，无需任何专有许可证。

**协议版本控制**：每张 Delta 表的 `protocol` Action 记录了该表要求的最低读写协议版本：

```json
{
  "protocol": {
    "minReaderVersion": 3,    // 读取该表需要的最低客户端协议版本
    "minWriterVersion": 7     // 写入该表需要的最低客户端协议版本
    // Delta 3.0 引入了 reader/writer features 的细粒度声明
    // "readerFeatures": ["deletionVectors", "columnMapping"],
    // "writerFeatures": ["deletionVectors", "columnMapping", "mergeSchema"]
  }
}
```

当引擎不支持某个协议版本时，应当拒绝读取/写入该表（而不是静默产生错误数据）。这是 Delta Protocol 向前兼容性的保证机制——新特性不会悄无声息地破坏旧客户端。

### 1.2 当前主要引擎的 Delta 支持矩阵

| 引擎 | 读 | 写 | 协议版本支持 | 备注 |
|-----|---|---|-----------|-----|
| **Apache Spark + delta-spark** | ✅ | ✅ | 最新（参考实现）| 官方实现，功能最全 |
| **Presto/Trino** | ✅ | ⚠️（有限）| Reader v2/v3 | 主要用于只读 BI 查询 |
| **Apache Flink** | ✅ | ✅ | Reader v2，Writer v5+ | `flink-connector-delta` |
| **Apache Hive** | ✅（只读）| ❌ | Reader v1/v2 | `delta-hive` 连接器 |
| **DuckDB** | ✅ | ❌ | Reader v2 | 嵌入式分析引擎 |
| **Pandas/PyArrow** | ✅ | ✅（基础）| Reader/Writer v2 | `delta-rs`（Rust 实现）|
| **Rust（delta-rs）** | ✅ | ✅ | 大部分特性 | 独立 Rust 实现 |
| **Snowflake** | ✅（通过 UniForm/Iceberg）| ❌ | N/A（通过 Iceberg 协议）| UniForm 桥接 |
| **AWS Athena** | ✅（通过 UniForm/Iceberg）| ❌ | N/A | UniForm 桥接 |

---

## 第 2 章 Presto/Trino：最常见的 Delta 查询引擎

### 2.1 为什么 Presto/Trino 读 Delta 而不用 Spark

在 Lakehouse 生产环境中，一个常见的架构模式是：

- **Spark**：负责 ETL 写入（MERGE、UPSERT）和批处理计算（数据转换、ML 特征工程）
- **Presto/Trino**：负责交互式 BI 查询（报表、临时分析）

使用 Presto 而不是 Spark 做 BI 查询的原因：
1. **更低的查询延迟**：Presto 是全内存流水线计算，没有 Spark 的 Stage 切换开销，对于简单的聚合查询延迟更低（秒级 vs 分钟级）
2. **更好的多并发支持**：Presto 支持同时执行数百个并发查询（通过 Query Queue 管理资源），适合 BI 工具（Tableau、Superset）的多用户并发场景
3. **BI 工具集成**：JDBC/ODBC 接口完善，与 Tableau、PowerBI 等 BI 工具集成更成熟

**同时使用两个引擎**不会产生数据一致性问题——Presto 只读 Delta 表（Snapshot Isolation），Spark 写入时的原子提交保证 Presto 永远看到一致的快照。

### 2.2 Trino 的 Delta 连接器配置

```properties
# Trino 的 Delta Lake 连接器配置（catalog.properties）
connector.name=delta_lake
hive.metastore.uri=thrift://hive-metastore:9083
delta.hive-catalog-name=delta_catalog

# S3 配置
hive.s3.aws-access-key=...
hive.s3.aws-secret-key=...

# Delta 特定配置
delta.max-splits-per-second=200          # 最大并发文件读取速度
delta.target-max-file-size=1GB           # 期望的 Split 大小
delta.statistics-enabled=true           # 启用 Delta 统计信息供 CBO 使用
```

**在 Trino 中查询 Delta 表**：

```sql
-- Trino SQL（查询 S3 上的 Delta 表）
SELECT 
    order_date,
    category,
    SUM(amount) AS total_revenue,
    COUNT(DISTINCT customer_id) AS unique_customers
FROM delta.orders.fact_orders
WHERE order_date BETWEEN DATE '2026-01-01' AND DATE '2026-01-31'
GROUP BY 1, 2
ORDER BY total_revenue DESC
LIMIT 100;
```

Trino 的 Delta 连接器会：
1. 读取 `_delta_log/` 确定有效文件列表
2. 利用分区裁剪和 Data Skipping 过滤文件（利用 Delta Log 中的列统计信息）
3. 将剩余文件分配给 Trino Worker 并行读取

> [!warning] 生产避坑
> **Trino 的 Delta 写入支持有限**：Trino 的 Delta 连接器主要针对读取场景优化，写入支持（INSERT INTO）存在功能限制，特别是不支持 MERGE 和 UPDATE。生产中应当明确规定：Delta 表只能通过 Spark 写入，Trino 只做只读查询。混用写入引擎可能导致协议版本不一致（Trino 写入的版本可能比 Spark 低，导致某些特性的元数据不正确）。

---

## 第 3 章 Apache Flink：流式写入 Delta Lake

### 3.1 Flink 写入 Delta 的场景

[[Apache Flink]] 是另一个常见的流处理引擎，在某些场景下比 Spark Structured Streaming 更适合：

- **低延迟流处理**（毫秒级）：Flink 的原生流处理（逐条处理，非微批）延迟比 Spark Micro-batch 低 10-100 倍
- **复杂有状态流处理**：Flink 的 State Backend 和 ProcessFunction 比 Spark 的 `flatMapGroupsWithState` 更灵活
- **已有 Flink 基础设施**：企业已有成熟的 Flink 集群，不想为 Spark Streaming 维护额外的集群

**Flink 写入 Delta Lake 的架构**：

```
Kafka → Flink Job（流处理）→ Delta Lake（作为 Flink Sink）
```

### 3.2 Flink Delta Connector 配置

```xml
<!-- Maven 依赖 -->
<dependency>
    <groupId>io.delta</groupId>
    <artifactId>delta-flink</artifactId>
    <version>3.0.0</version>
</dependency>
```

```java
// Flink 写入 Delta Lake（Java API）
import io.delta.flink.sink.DeltaSink;
import org.apache.flink.core.fs.Path;

// 定义 Delta Sink
DeltaSink<RowData> deltaSink = DeltaSink
    .forRowData(
        new Path("s3://bucket/delta/orders/"),   // Delta 表路径
        hadoopConf,                              // Hadoop 配置（包含 S3 凭证）
        rowType                                  // Flink RowType（对应 Delta Schema）
    )
    .withPartitionColumns("order_date")          // 分区列
    .build();

// 将 Sink 添加到 Flink DataStream
DataStream<RowData> orders_stream = ...;
orders_stream.sinkTo(deltaSink);
```

**Flink Delta Connector 的 Exactly-once 实现**：Flink 利用其 **Checkpoint 机制**（两阶段提交协议）实现对 Delta Lake 的 Exactly-once 写入：

```
阶段一（Pre-commit）：
  Flink Checkpoint 触发时，各个 Task 将已写入的 Parquet 文件路径记录到 State
  但此时 Delta Log 还没有提交（文件是"游离"的，不在任何版本的 Snapshot 中）

阶段二（Commit）：
  Flink Checkpoint 完成后（所有 Task 的 State 都已持久化），
  DeltaSink 的 Committer 将所有 Pre-commit 的文件路径批量写入 Delta Log（原子提交）
  此时文件才真正成为 Delta 表的一部分

崩溃恢复：
  如果在 Pre-commit 阶段崩溃 → Checkpoint 回滚 → 游离文件被重新写入（幂等）
  如果在 Commit 阶段崩溃 → 从 Checkpoint 恢复 → Committer 重新提交（幂等）
```

### 3.3 Flink 读取 Delta Lake（Source）

```java
// Flink 读取 Delta Lake（Source）
import io.delta.flink.source.DeltaSource;

DeltaSource<RowData> deltaSource = DeltaSource
    .forBoundedRowData(
        new Path("s3://bucket/delta/orders/"),
        hadoopConf
    )
    .build();
// Bounded Source：读取表的最新版本（全量批处理）

// 或 Unbounded Source（流式，类似 Spark Delta Source）
DeltaSource<RowData> deltaStreamSource = DeltaSource
    .forContinuousRowData(
        new Path("s3://bucket/delta/orders/"),
        hadoopConf
    )
    .startingVersion(0L)      // 从 version=0 开始读取
    .build();
```

---

## 第 4 章 Apache Hive：遗留引擎的 Delta 只读支持

### 4.1 为什么还需要 Hive 支持 Delta

在很多大型互联网公司，[[Apache Hive]] 依然是重要的 SQL 查询引擎：
- 大量历史 ETL 脚本和报表 SQL 是用 HiveQL 编写的，迁移代价高
- 运营和数据分析团队熟悉 Hive 的 SQL 方言
- 与 Hadoop 生态（YARN、HDFS）集成成熟

通过 `delta-hive` 连接器，Hive 可以将 Delta 表注册为外部表，实现只读查询：

```sql
-- 在 Hive 中注册 Delta 表为外部表
CREATE EXTERNAL TABLE hive_orders
STORED BY 'io.delta.hive.DeltaStorageHandler'
WITH SERDEPROPERTIES (
    'path' = 's3://bucket/delta/orders/'
);

-- 查询（只读）
SELECT order_date, SUM(amount) 
FROM hive_orders 
WHERE order_date = '2026-01-15'
GROUP BY order_date;
```

**Hive 连接器的限制**：
- 只读（不支持写入）
- 不支持 Time Travel
- Delta 的高级特性（Deletion Vector、Column Mapping）可能不支持（取决于连接器版本）
- 性能不如 Presto/Trino（Hive 的 MapReduce/Tez 执行引擎比 Presto 的全内存管道慢）

---

## 第 5 章 UniForm：打破引擎壁垒的终极方案

### 5.1 格式碎片化的问题

Lakehouse 生态中存在三个相互竞争的开放格式：Delta Lake、Apache Iceberg、Apache Hudi。虽然三者都基于 Parquet 存储，但元数据协议完全不同——一张 Delta 表只能被支持 Delta 协议的引擎读取，不支持 Iceberg 协议的引擎（如 AWS Athena 的原生 Iceberg 支持，或 Snowflake 的 Iceberg Tables）无法直接读取 Delta 格式的数据。

这种格式碎片化的后果：
- 企业为了让不同引擎访问同一数据，不得不维护多份数据副本（Delta 一份 + Iceberg 一份），存储成本翻倍
- 数据一致性问题：两份数据的同步存在延迟，可能导致不同引擎看到不一致的结果
- 运维复杂度：维护两套数据管道、两套权限体系、两套监控

### 5.2 UniForm：一份数据，多协议读取

**UniForm（Universal Format）** 是 Delta Lake 3.0（2023 年）推出的特性：在写入 Delta 表时，**自动生成对应的 Iceberg 元数据**（Iceberg manifest 文件），使 Delta 表可以被原生 Iceberg 客户端透明读取——不需要数据复制，不需要额外的同步作业，一份数据，两种协议。

**UniForm 的工作原理**：

```
用 Spark 写入 Delta 表（正常的 Delta 写入流程）：
  写入 Parquet 文件
  更新 _delta_log/（Delta 元数据）
  ↓ UniForm 同步触发
  自动生成 Iceberg manifest 文件（存储在 Delta 表目录下的 metadata/ 子目录）

Iceberg 客户端（AWS Athena / Snowflake）读取：
  看到 metadata/ 目录下的 Iceberg 元数据
  以 Iceberg 协议读取 Parquet 数据文件
  → 与直接读取 Iceberg 表无区别
```

**开启 UniForm**：

```sql
-- 创建表时开启 UniForm（同时生成 Delta 和 Iceberg 元数据）
CREATE TABLE orders (
    order_id BIGINT,
    amount DOUBLE,
    order_date DATE
) USING DELTA
TBLPROPERTIES (
    'delta.universalFormat.enabledFormats' = 'iceberg'
);

-- 对已有表开启 UniForm
ALTER TABLE orders SET TBLPROPERTIES (
    'delta.universalFormat.enabledFormats' = 'iceberg'
);
-- 注意：开启后需要执行一次全量 OPTIMIZE 来生成历史数据的 Iceberg 元数据
```

### 5.3 UniForm 的架构约束与局限性

**约束一：Column Mapping 必须开启**

UniForm 要求 Delta 表开启 Column Mapping（`delta.columnMapping.mode = 'name'`），因为 Iceberg 协议需要物理列名是稳定的 UUID 标识，而不是可以随时变化的逻辑列名。

**约束二：元数据同步的延迟**

UniForm 的 Iceberg 元数据是**异步生成**的——每次 Delta 提交后，UniForm 服务（后台线程）异步更新 Iceberg 元数据。在 Iceberg 元数据更新完成前，Iceberg 客户端看到的数据可能落后于最新的 Delta 版本（通常延迟 < 1 分钟）。

**约束三：只支持读取，不支持双写**

UniForm 只支持 Delta 作为主写入协议，Iceberg 客户端只读。不支持 Iceberg 客户端写入数据（因为 Iceberg 的元数据格式与 Delta Log 不同，双写会导致两套元数据不一致）。

**约束四：协议版本提升**

开启 UniForm 会提升表的协议版本（需要 `minReaderVersion=3`，`minWriterVersion=7`），旧版本的 Delta 客户端将无法读取这张表。

### 5.4 UniForm 的生态价值

UniForm 开启了 Delta Lake 与云原生数据服务的互操作：

| 服务 | 通过 UniForm 读取 Delta |
|-----|----------------------|
| **AWS Athena** | ✅ 原生支持 Iceberg，通过 UniForm 读取 Delta |
| **Snowflake External Tables** | ✅ 支持 Iceberg 格式的外部表，通过 UniForm |
| **Google BigLake** | ✅ 支持 Iceberg 元存储，通过 UniForm |
| **Apache Doris** | ✅ 支持 Iceberg 外表，通过 UniForm |
| **DuckDB** | ✅ 支持 Iceberg，通过 UniForm |

**这意味着什么**：一个企业可以用 Spark 写入 Delta Lake，同时允许 Snowflake 的用户（如财务团队）和 AWS Athena 的用户（如数据科学团队）直接查询同一份数据，零数据复制，零同步延迟（除 UniForm 的异步延迟外）。

---

## 第 6 章 多引擎架构的设计原则

### 6.1 写入引擎的统一

**核心原则：一张表应该只有一个主写入引擎**（Spark 或 Flink），其他引擎只读。混用写入引擎（Spark + Flink 同时写入同一张 Delta 表）虽然技术上可行（OCC 会处理并发冲突），但会带来：
- 协议版本协商问题（两个引擎支持的 Delta 协议版本可能不同）
- 调试复杂度（某个写入错误来自哪个引擎？）
- Checkpoint 管理复杂（Streaming Source 的 Offset 如何协调？）

**推荐架构**：

```
写入路径：
  Flink（低延迟流处理）→ Delta Lake（raw_events）
  Spark（ETL 聚合）→ Delta Lake（fact_orders）

读取路径：
  Spark SQL / Spark Batch → Delta Lake（full feature support）
  Trino/Presto → Delta Lake（only read, BI queries）
  AWS Athena → Delta Lake（through UniForm/Iceberg, adhoc queries）
  Flink → Delta Lake（streaming source, incremental processing）
```

### 6.2 权限隔离

多引擎读取同一份数据时，需要统一的权限管理：

```python
# Unity Catalog（Databricks）的多引擎权限管理
# 所有引擎通过 Unity Catalog 访问 Delta 表，统一的 RBAC

# AWS Lake Formation + Glue 的多引擎权限管理
# Spark、Athena、Redshift 共享 Lake Formation 的列级别权限控制
```

---

## 小结

Delta Lake 的多引擎生态体系建立在开放协议（Delta Protocol）的基础上：

- **Delta Protocol 规范**：公开的 JSON+Parquet 元数据格式，任何引擎可独立实现；协议版本控制保证向前兼容性
- **Presto/Trino**：Delta 只读查询的最佳选择，低延迟交互式查询；生产中明确 Spark 写、Trino 读的分工
- **Apache Flink**：通过两阶段提交实现 Exactly-once 写入 Delta；适合毫秒级低延迟流处理场景
- **Apache Hive**：遗留引擎的只读支持，适合迁移过渡期；功能有限，长期应迁移到 Presto/Spark
- **UniForm**：Delta Lake 3.0 的革命性特性，一份数据同时支持 Delta 和 Iceberg 协议读取；解决 Lakehouse 格式碎片化问题；开启了与 AWS Athena、Snowflake、BigLake 等云原生服务的无缝互操作

第 12 篇（收官）讲解生产运维手册：Delta 表的健康度监控指标体系、数据质量约束（Constraints）的生产实践、备份与灾难恢复方案，以及 Delta Sharing——跨组织安全地共享 Delta 数据的开放协议。

---

## 参考资料

- [Delta Lake Protocol 规范（GitHub）](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)
- [Delta UniForm 官方文档](https://docs.delta.io/latest/delta-uniform.html)
- [Flink Delta Connector（GitHub）](https://github.com/delta-io/delta/tree/master/connectors/flink)
- [Trino Delta Lake 连接器文档](https://trino.io/docs/current/connector/delta-lake.html)
- [delta-rs（Rust 实现的 Delta 客户端）](https://github.com/delta-io/delta-rs)
