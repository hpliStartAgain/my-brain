---
title: "为什么需要 Lakehouse：数据仓库与数据湖的架构演进"
date: 2026-02-28
tags: [Delta Lake, Lakehouse, 数据仓库, 数据湖, 架构演进, ACID, Lambda架构]
aliases: []
---

# 01 为什么需要 Lakehouse：数据仓库与数据湖的架构演进

## 摘要

数据工程领域在过去二十年经历了三次重大架构范式转变：从**企业数据仓库**（EDW）到**数据湖**，再到如今的 **Lakehouse**。每次演进都是在解决上一代架构积累的根本性矛盾——而不是简单的技术迭代。本文从第一性原理出发，深入分析企业数据仓库为什么在大数据时代遭遇瓶颈、数据湖解决了哪些问题却又引入了哪些新问题，以及 Lakehouse 架构（以 Delta Lake 为代表）如何通过在廉价对象存储之上构建事务语义层，实现"鱼和熊掌兼得"——同时满足数仓的可靠性与数据湖的低成本和灵活性。理解这段演进史，是深刻理解 Delta Lake 每一个设计决策背后动机的前提。

---

## 第 1 章 第一代：企业数据仓库的辉煌与局限

### 1.1 数据仓库解决了什么问题

20 世纪 90 年代，企业的业务数据分散在各个 OLTP 系统（ERP、CRM、销售系统）中，这些系统为事务处理优化，不适合跨系统的分析查询——在 Oracle 生产库上运行一条全表扫描的报表 SQL，会把在线业务拖垮。

**数据仓库**（Enterprise Data Warehouse，EDW）的出现解决了这个核心矛盾：将分析负载从 OLTP 系统剥离，建立一套专门为分析查询优化的独立系统（[[Teradata]]、[[Netezza]]、Oracle Exadata）。数据仓库的核心特征：

- **面向分析**：列式存储、位图索引、MPP（大规模并行处理）架构，专门为聚合查询优化
- **ACID 保证**：事务语义确保数据的一致性，ETL 作业失败不会留下脏数据
- **Schema on Write**：数据入库时必须符合预定义的 Schema，保证数据质量
- **成熟的工具生态**：BI 工具（Tableau、MicroStrategy）与数据仓库深度集成

数据仓库在 2000 年代支撑了大量企业的 BI 报表需求，这是它存在的核心价值。

### 1.2 数据仓库的根本局限

随着互联网的兴起和数据规模的爆炸式增长，数据仓库的几个根本局限变得无法接受：

**局限一：成本不可扩展**

传统数仓是专有硬件 + 专有软件的紧耦合架构，计算和存储紧密绑定。存储 1PB 数据需要购买价值数百万美元的 Teradata 机器。数据规模从 TB 增长到 PB，成本以数量级增加，超出了绝大多数企业的承受能力。

**局限二：只支持结构化数据**

数仓的 Schema on Write 机制要求数据必须是结构化的（可以定义为关系表）。互联网时代产生了大量非结构化数据（用户行为日志、图片、文本、视频），这些数据无法进入数仓，大量有价值的分析信号被浪费。

**局限三：不支持机器学习工作负载**

ML/DL 模型训练需要直接读取原始数据（日志、图片、时间序列），通常使用 Python/TensorFlow/PyTorch 框架——这些工具无法直接对接数仓。数据科学家需要把数据从数仓导出到文件系统，再用 ML 框架训练，数据流转繁琐且难以保证一致性。

**局限四：封闭的专有生态**

Teradata SQL 方言与标准 SQL 不完全兼容，数据格式是专有的，从一个数仓迁移到另一个数仓的成本极高——企业被厂商绑定（Vendor Lock-in）。

> [!note] 设计哲学
> 数据仓库的局限不是技术能力不够强，而是**架构的根本性矛盾**：专有硬件的紧耦合带来了高性能，但同时也带来了高成本和封闭性。这是无法通过简单的技术升级解决的——在专有架构的框架内，性能、成本、开放性三者无法同时优化。这就是为什么数据湖的出现不是对数仓的改进，而是一次架构的重构。

---

## 第 2 章 第二代：数据湖的崛起与沼泽化

### 2.1 Hadoop 生态：数据湖的第一次实现

2006 年前后，[[Apache Hadoop]] 生态（HDFS + MapReduce）提供了一个新的选择：用廉价的商用服务器集群（每台 3-5 万元）构建 PB 级存储和计算系统，成本仅为传统数仓的 1/10。

**数据湖的核心思想**：

1. **存储与计算分离**：HDFS 只负责存储，计算由 MapReduce/Spark/Hive 等框架负责，可以独立扩展
2. **Schema on Read**：数据以原始格式（CSV、JSON、Parquet）存储，读取时再解析 Schema，支持任意格式的数据
3. **开放格式**：[[Parquet]]、[[ORC]] 等开放列式格式，任何支持这些格式的引擎都可以读取
4. **低成本**：利用廉价的 x86 服务器，后来进化为更便宜的云对象存储（S3、OSS）

**数据湖的早期成功**：Facebook（Meta）在 2012 年就建立了基于 HDFS 的数据湖，存储了 PB 级的用户行为日志，同时支持 Spark 的 ETL 分析和 ML 特征工程，成本比传统数仓低一个数量级。

### 2.2 数据湖的沼泽化：五大可靠性问题

然而，大规模生产实践暴露了数据湖的严重问题——业界开始用 **"Data Swamp"（数据沼泽）** 来描述失控的数据湖：

**问题一：没有 ACID 事务，读写冲突导致数据污染**

Parquet 文件一旦写入就不可修改（Immutable）。"更新"一条记录的唯一方式是读出所有数据、修改后、写入新文件、删除旧文件——这个过程不是原子的。如果 Spark 写入作业在写完一半文件时崩溃，表中同时存在新旧版本的数据，下游查询读到不一致的结果。

```
写入过程（非原子）：
  t=0: 读取所有旧数据
  t=1: 开始写入新 Parquet 文件（part-00000, part-00001, ...）
  t=2: 写入 part-00000 完成（此时有读者读取，会同时看到旧的 part-00001 和新的 part-00000）
  t=3: 作业崩溃，剩余文件未写完

读取方看到的数据：新旧混合，不一致 ← 数据污染
```

**问题二：UPDATE/DELETE 代价极高**

Parquet 文件不支持原地修改（in-place update）。要在数据湖上执行 `UPDATE users SET email=... WHERE id=123`，必须：
1. 全表扫描找到包含该记录的所有文件
2. 将这些文件全部读入内存
3. 修改对应记录后重写成新文件
4. 删除旧文件

对一个 TB 级的表做单条记录更新，代价与全表重写相当——这让 CDC（Change Data Capture）和 GDPR 数据删除请求几乎无法实现。

**问题三：没有 Schema Enforcement，数据质量无保障**

Schema on Read 的灵活性是双刃剑：上游 ETL 作业可以随意写入任何格式的数据，甚至是错误格式。错误数据只有在下游查询时才会被发现，可能已经污染了大量下游报表。

```python
# 上游 ETL 作业的 Bug：将 order_amount（金额）写成了字符串 "N/A"
df.write.parquet("s3://bucket/orders/")

# 下游报表查询时发现数据异常
# SUM(order_amount) 的结果完全错误，但上游作业已经成功运行了数周
```

**问题四：没有 Time Travel，数据无法回溯**

数据湖没有版本控制。如果一个 ETL 作业写入了错误数据，覆盖了昨天的分区，就再也无法恢复昨天的数据（除非有单独的备份）。数据发现问题后的恢复代价极高。

**问题五：元数据管理混乱**

数据湖中通常有数百个目录、数千个 Parquet 文件，Hive Metastore 是唯一的元数据存储，但它无法追踪文件级别的变化（哪些文件属于某个事务的结果？哪些文件是垃圾文件？）。`MSCK REPAIR TABLE`（同步 Hive 分区元数据）成为大量工程师每天必须执行的运维操作。

---

## 第 3 章 Lambda 架构：在两代架构之间的妥协

### 3.1 Lambda 架构的出现

面对数据湖的可靠性问题，2011 年 Nathan Marz 提出了 **Lambda 架构**：

```
数据源
  ├─→ 批处理层（Spark Batch）→ 批次视图（Parquet in HDFS/S3）
  │                               ↓
  └─→ 速度层（Kafka + Storm）→ 实时视图（Redis / HBase）
                                 ↓
                          服务层（合并批次视图 + 实时视图）→ 查询结果
```

Lambda 架构的思路：用批处理层（高延迟但准确）保证最终一致性，用速度层（低延迟但近似）满足实时查询，服务层合并两者的结果。

**Lambda 架构的根本问题**：系统复杂度翻倍。同一套业务逻辑必须实现两遍（批处理版本 + 流处理版本），且必须保证两套逻辑产生完全一致的结果——实践中这极难保证，批流结果不一致是 Lambda 架构最常见的 Bug。

### 3.2 Kappa 架构：以流处理统一

2014 年 Jay Kreps 提出 Kappa 架构：去掉批处理层，所有数据处理都用流处理实现，重算历史数据也通过回放 Kafka Topic 的流来完成。

Kappa 架构简化了系统，但对流处理引擎的要求极高（需要高吞吐、支持历史数据回放），且 SQL 分析、ML 训练等批处理场景依然不适合用流处理实现。

**这两种架构都是在打补丁**，根本矛盾（存储层缺乏事务语义）没有被解决。

---

## 第 4 章 第三代：Lakehouse 架构

### 4.1 Lakehouse 的核心思想

**Lakehouse** 这个概念由 Databricks 在 2020 年正式提出（论文《Lakehouse: A New Generation of Open Platforms that Unify Data Warehousing and Advanced Analytics》，CIDR 2021）。其核心思想简单而深刻：

> 在廉价的对象存储（S3/OSS）之上，通过一个**事务元数据层**，赋予数据湖数仓级的事务语义和管理能力——用开放格式、低成本存储，同时支持 BI 查询和 ML 训练。

```
数仓的优势：ACID 事务、Schema 管理、高可靠性
数据湖的优势：低成本存储、开放格式、支持多种计算引擎

Lakehouse = 数据湖的存储模型 + 数仓的管理语义
```

**关键洞察**：数仓的高可靠性不是来自专有硬件，而是来自**事务语义**——只要在开放存储上构建正确的事务协议，就能同时获得可靠性和低成本。

### 4.2 Delta Lake：Lakehouse 的开源实现

**Delta Lake**（2019 年 Databricks 开源）是第一个生产级的 Lakehouse 开源实现。它的核心设计：

1. **事务日志（Transaction Log / Delta Log）**：在 Parquet 数据文件目录中维护一个 `_delta_log/` 目录，用 JSON 文件记录每次写操作（Add File、Remove File、Commit Info），将无事务语义的 Parquet 文件集合升级为有 ACID 语义的表
2. **MVCC（Multi-Version Concurrency Control）**：每次写操作创建新版本（version），读操作读取指定版本的快照，实现读写不互相阻塞
3. **Schema Enforcement + Schema Evolution**：写入时验证 Schema，同时支持向后兼容的 Schema 变更（添加列、重命名列等）
4. **开放协议**：Delta Log 基于 JSON + Parquet，任何语言都可以实现 Delta Lake 的读写（Hive Connector、Flink Connector、PyArrow、Rust 实现等）

### 4.3 三代架构对比

| 维度 | 数据仓库（EDW）| 数据湖（Parquet/ORC）| Lakehouse（Delta Lake）|
|-----|-------------|-------------------|----------------------|
| **存储成本** | 极高（专有硬件）| 极低（对象存储）| 极低（对象存储）|
| **ACID 事务** | ✅ 完整支持 | ❌ 无 | ✅ 完整支持 |
| **Schema 管理** | ✅ 严格 | ❌ 宽松（Schema on Read）| ✅ 可配置（强制或宽松）|
| **Time Travel** | ❌ 通常不支持 | ❌ 无 | ✅ 完整支持 |
| **UPDATE/DELETE** | ✅ 高效 | ❌ 极低效（全表重写）| ✅ 支持（Copy-on-Write / MoR）|
| **开放格式** | ❌ 专有格式 | ✅ Parquet/ORC | ✅ Parquet + Delta Log |
| **ML 工作负载** | ❌ 难以集成 | ✅ 原生支持 | ✅ 原生支持 |
| **流处理集成** | ❌ 难 | ⚠️ 有限 | ✅ 原生支持 |
| **小文件问题** | ❌ 需要管理 | ❌ 严重 | ⚠️ 需要定期 OPTIMIZE |
| **多引擎支持** | ❌ 专有 | ✅ 任意引擎 | ✅ Spark/Presto/Flink/Hive |

---

## 第 5 章 Delta Lake、Apache Iceberg 与 Apache Hudi 的对比

### 5.1 三大 Lakehouse 格式

Delta Lake 并不是唯一的 Lakehouse 格式，Apache 基金会下有两个竞争方案：

**Apache Iceberg**（Netflix 开源，2018）：同样在 Parquet 之上构建事务语义，但元数据层设计更加精细（Manifest 文件层次化索引），特别擅长 PB 级大表的分区管理和 Schema 演进。Flink 和 Trino（PrestoSQL）社区对 Iceberg 的支持更原生。

**Apache Hudi**（Uber 开源，2016）：解决 Uber 的 CDC 场景——如何将数据库的增量变更（CDC 流）高效写入数据湖。Hudi 的 Merge-on-Read（MoR）设计天然适合高频小批量 UPSERT 场景。

| 维度 | Delta Lake | Apache Iceberg | Apache Hudi |
|-----|-----------|---------------|------------|
| **开源时间** | 2019 | 2018 | 2016 |
| **背后公司** | Databricks | Netflix | Uber |
| **Spark 集成** | 最成熟（原生）| 成熟 | 成熟 |
| **Flink 集成** | 一般 | 最好 | 好 |
| **UPSERT 性能** | 好 | 一般 | 最好（MoR）|
| **元数据扩展性** | 中（单目录 JSON）| 最好（层次化 Manifest）| 中 |
| **社区活跃度** | 高（Databricks 驱动）| 高（Apache 生态）| 中 |
| **AWS 推荐** | — | ✅（AWS Glue、Athena 原生）| — |
| **Azure 推荐** | ✅（Azure Databricks 集成）| — | — |

**本专栏聚焦 Delta Lake** 的原因：Delta Lake 与 Spark 的集成最深（同属 Databricks 生态），Delta Log 的设计最简洁清晰，是学习 Lakehouse 内部原理最好的切入点。

---

## 小结

理解为什么需要 Lakehouse，关键是理解三代架构各自解决的问题和留下的矛盾：

- **数据仓库**：解决了分析与事务的隔离问题，但专有架构带来了高成本和封闭性，无法承载大数据时代的规模和多样性
- **数据湖**：解决了成本和灵活性问题，但开放存储（Parquet/S3）缺乏事务语义，导致数据可靠性问题（脏读、不可原子更新、无版本控制）
- **Lambda/Kappa 架构**：是在不改变存储层的前提下打补丁，根本矛盾未解决，系统复杂度翻倍
- **Lakehouse（Delta Lake）**：通过在对象存储之上构建事务元数据层（Delta Log），在不牺牲开放性和低成本的前提下，获得了 ACID 语义、Schema 管理、Time Travel——这是唯一正确解决根本矛盾的方式

第 02 篇深入 Delta Log 的数据结构：`_delta_log/` 目录下的每一个文件的格式和语义，一次 `INSERT`/`UPDATE`/`DELETE` 操作如何转化为 Delta Log 的 Action，以及 Checkpoint 机制如何加速元数据读取。

---

## 参考资料

- Armbrust et al. [Lakehouse: A New Generation of Open Platforms that Unify Data Warehousing and Advanced Analytics.](https://www.cidrdb.org/cidr2021/papers/cidr2021_paper17.pdf) CIDR 2021.
- Armbrust et al. [Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores.](https://dl.acm.org/doi/10.14778/3415478.3415560) VLDB 2020.
- [Delta Lake 官方文档](https://docs.delta.io/latest/index.html)
- [The Data Lakehouse Platform（Databricks Blog）](https://www.databricks.com/product/data-lakehouse)
