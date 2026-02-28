---
title: "DML 操作深度解析：MERGE、UPDATE 与 DELETE 的实现机制"
date: 2026-02-28
tags: [Delta Lake, MERGE, UPDATE, DELETE, Copy-on-Write, Merge-on-Read, Deletion Vector, DML, CDC, UPSERT]
aliases: []
---

# 04 DML 操作深度解析：MERGE、UPDATE 与 DELETE 的实现机制

## 摘要

`MERGE`、`UPDATE`、`DELETE` 是 Lakehouse 场景的三个核心 DML 操作，它们使数据湖终于能够支持像数仓一样的数据变更语义——CDC（Change Data Capture）同步、GDPR 合规删除、SCD（Slowly Changing Dimension）维护。然而，在 Parquet 文件不可原地修改的约束下，这三个操作的实现代价相当高昂：传统的 Copy-on-Write 模式需要将包含目标记录的整个 Parquet 文件读出、修改后重写，一条记录的更新可能引发数 GB 文件的重写。Delta Lake 2.0 引入的 **Deletion Vector（DV）** 机制从根本上改变了这一局面：删除/更新一行时，只在 Parquet 文件旁边创建一个极小的位图文件（标记哪些行被删除），无需重写文件本体——将"重写整个文件"的代价降低到"写入几 KB 位图"。本文系统讲解 MERGE/UPDATE/DELETE 的执行计划生成、Copy-on-Write 与 Merge-on-Read 两种写入模式的本质差异、Deletion Vector 的物理格式与读取时的合并逻辑，以及 Change Data Feed（CDF）如何捕获行级别的变更用于下游增量消费。

---

## 第 1 章 MERGE：Lakehouse 的核心操作

### 1.1 MERGE 是什么，为什么 Lakehouse 需要它

**MERGE**（也叫 UPSERT）是"如果匹配则更新，否则插入"语义的原子操作。在数据仓库中这是非常基础的操作（Oracle 的 `MERGE INTO`，SQL Server 的 `MERGE`），但在传统数据湖中几乎无法高效实现——因为 Parquet 文件不支持原地更新。

**MERGE 的典型生产场景**：

1. **CDC 同步**：MySQL binlog 变更流通过 Kafka → Flink 消费，生成增量变更数据（包含 INSERT/UPDATE/DELETE 类型的记录），每隔 5 分钟批量 MERGE 到 Delta Lake 目标表
2. **SCD Type 2**：维度表中某个字段发生变化时，将旧记录的有效期关闭（UPDATE），同时插入新版本记录（INSERT）
3. **去重写入**：在 Exactly-once 语义不完全可靠的场景下，用 MERGE 替代 INSERT——如果目标表中已存在相同主键记录则跳过（`WHEN MATCHED THEN DO NOTHING`）

### 1.2 MERGE 的 SQL 语法

```sql
-- 标准 MERGE 语法
MERGE INTO target_table AS T
USING source_data AS S
ON T.order_id = S.order_id              -- 匹配条件（Join 键）
WHEN MATCHED AND S.op = 'U' THEN        -- 匹配到：更新
  UPDATE SET T.amount = S.amount,
             T.updated_at = S.updated_at
WHEN MATCHED AND S.op = 'D' THEN        -- 匹配到：删除
  DELETE
WHEN NOT MATCHED AND S.op = 'I' THEN   -- 未匹配到：插入
  INSERT (order_id, amount, created_at, updated_at)
  VALUES (S.order_id, S.amount, S.created_at, S.updated_at)
```

```python
# PySpark DataFrame API 的 MERGE
from delta.tables import DeltaTable

target = DeltaTable.forPath(spark, "s3://bucket/delta/orders/")
source = spark.read.format("kafka").load()  # CDC 增量数据

target.alias("T").merge(
    source.alias("S"),
    "T.order_id = S.order_id"
).whenMatchedUpdate(
    condition="S.op = 'U'",
    set={"amount": "S.amount", "updated_at": "S.updated_at"}
).whenMatchedDelete(
    condition="S.op = 'D'"
).whenNotMatchedInsert(
    condition="S.op = 'I'",
    values={"order_id": "S.order_id", "amount": "S.amount", "created_at": "S.created_at"}
).execute()
```

### 1.3 MERGE 的执行计划：两阶段扫描

MERGE 的 Spark 执行计划分为两个阶段：

**阶段一：找出需要变更的目标文件（Touch Files）**

```
Source 数据（CDC 增量）
  ↓ 与 Target 表进行 Join（匹配键：order_id）
  ↓ 找出 Target 表中哪些 Parquet 文件包含了 Source 中出现的 order_id
  → 这些文件称为 "touched files"（需要被修改的文件）
```

**数据跳过优化**：如果 Target 表有分区（如 `PARTITIONED BY (date)`），且 MERGE 条件包含分区列，Spark 可以通过分区裁剪直接确定 Touched Files，避免全表扫描。

**阶段二：重写 Touched Files（Copy-on-Write 模式）**

```
对每个 Touched File：
  1. 读取完整文件内容
  2. 与 Source 数据进行行级别 Join
  3. 根据 MATCHED/NOT MATCHED 条件处理每一行：
     - MATCHED + UPDATE：更新字段值
     - MATCHED + DELETE：删除该行（不写入新文件）
     - NOT MATCHED + INSERT：原有行保留
  4. 将处理后的行写入新 Parquet 文件
  
Delta Log：
  add 新文件
  remove 旧 Touched Files
  add Source 中 NOT MATCHED 的插入数据（追加到表中）
```

**MERGE 的性能瓶颈**：当 Source 数据（CDC 增量）很小（只有几千行），但 Target 表的一个 Parquet 文件很大（1GB），MERGE 需要读取并重写整个 1GB 文件只为了修改几行——I/O 放大比极高。

---

## 第 2 章 Copy-on-Write vs Merge-on-Read

### 2.1 Copy-on-Write（CoW）：写时代价高，读时无代价

**Copy-on-Write（CoW）** 是 Delta Lake 1.x 时代的默认写入模式：任何修改（UPDATE/DELETE/MERGE）都会将包含目标记录的 Parquet 文件完整重写。

```
CoW 的写入流程：
  1. 找到包含目标行的文件 F1（大小：500MB）
  2. 读取 F1 的全部 100 万行
  3. 修改其中 100 行
  4. 将修改后的 100 万行写入新文件 F1'（大小：500MB）
  5. Delta Log：add F1'，remove F1

I/O 代价：读 500MB + 写 500MB = 1000MB，只为了修改 100 行（100 × 几十字节）
I/O 放大比：1000MB / 几KB ≈ 10 万倍
```

**CoW 的优点**：读取时完全没有额外开销——每个 Parquet 文件都是"干净"的（没有已删除但未清理的行），读取时无需额外过滤，查询性能与普通 Parquet 完全一致。

**CoW 的缺点**：高频小批量 UPSERT 场景（如每分钟一批 CDC 变更）代价极高，I/O 放大严重，Parquet 文件大小频繁变化导致小文件问题。

### 2.2 Merge-on-Read（MoR）：写时代价低，读时需合并

**Merge-on-Read（MoR）** 的思路是：写入时只记录变更（不重写文件），读取时合并原始文件和变更记录。这是 [[Apache Hudi]] 的原始设计，Delta Lake 2.0 通过 **Deletion Vector** 引入了 MoR 语义的部分特性。

MoR 的写入模式：
- **DELETE/UPDATE**：不重写 Parquet 文件，只在旁边创建一个 Delta 文件（记录哪些行被删除/修改）
- **INSERT**：直接追加新 Parquet 文件

读取时：原始 Parquet 文件 + Delta 文件合并 → 最终结果

```
MoR 的写入流程（DELETE 100 行）：
  1. 找到包含目标行的文件 F1（大小：500MB）
  2. 记录这 100 行在 F1 中的行号（offset）
  3. 写入 Deletion Vector 文件（位图，记录被删除的行号，大小：几 KB）
  4. Delta Log：修改 F1 的 add Action，关联 Deletion Vector 文件

I/O 代价：写入几 KB 的 Deletion Vector
I/O 放大比：几 KB / 几 KB ≈ 1（无放大）
```

**MoR 的代价转移到读取**：每次读取 F1 时，需要先读取对应的 Deletion Vector，过滤掉已删除的行。对于频繁被修改的热文件，DV 可能积累大量删除标记，读取时的过滤代价显著增加。

### 2.3 CoW vs MoR 的适用场景

| 维度 | Copy-on-Write | Merge-on-Read (Deletion Vector) |
|-----|-------------|--------------------------------|
| **写入代价** | 高（重写整个文件）| 低（只写几 KB DV）|
| **读取代价** | 无（文件是干净的）| 有（需读 DV 并过滤）|
| **写入频率** | 低频大批量 UPSERT | 高频小批量 UPSERT |
| **读取频率** | 频繁查询的表 | 写多读少的表 |
| **OPTIMIZE 后** | 无区别（CoW 在写时已清理）| OPTIMIZE 会清除 DV（文件重写）|
| **CDC 场景** | 不推荐 | **推荐** |
| **BI 查询场景** | **推荐** | 需要定期 OPTIMIZE |

---

## 第 3 章 Deletion Vector：Delta Lake 2.0 的革命性优化

### 3.1 Deletion Vector 是什么

**Deletion Vector（DV）** 是 Delta Lake 2.0（2022 年）引入的关键特性，通过在 Parquet 文件旁边存储一个极小的位图文件来标记已删除的行，无需重写原始 Parquet 文件。

**物理格式**：DV 使用 **RoaringBitmap**（压缩位图数据结构）存储被删除行的行号（offset）：

```
F1 文件包含 100 万行（行号 0 到 999999）
删除了行号 1000, 2000, 5000 的三行

DV 文件（F1.dv）：
  RoaringBitmap{1000, 2000, 5000}
  序列化后大小：约 20 字节（极小！）
```

**RoaringBitmap** 是一种高效的压缩位图，针对稀疏集合（少量被删除行）占用空间极小，针对连续大范围删除也有很好的压缩率。

### 3.2 Delta Log 中 DV 的表示

```json
// 使用 DV 的 add Action（Delta 2.0+）
{
  "add": {
    "path": "part-00000-abc123.snappy.parquet",
    "size": 524288000,
    "dataChange": false,
    "stats": "...",
    "deletionVector": {
      "storageType": "u",          // "u" = 与数据文件同目录
      "pathOrInlineDv": "deletion_vector_abc123.bin",  // DV 文件名
      "offset": 1,                 // DV 文件内的偏移量（支持多个 DV 共享同一文件）
      "sizeInBytes": 48,           // DV 的字节大小
      "cardinality": 3             // 被标记删除的行数
    }
  }
}
```

### 3.3 读取时的 DV 合并逻辑

当读取包含 DV 的 Parquet 文件时，Delta Lake 的读取路径会自动处理：

```
读取 F1：
  1. 读取 F1 的 Parquet 文件内容（100 万行）
  2. 读取对应的 DV 文件（RoaringBitmap）
  3. 在 Parquet 的列式读取阶段，应用行号过滤：
     跳过 bitmap 中标记的行（行号 1000, 2000, 5000）
  4. 返回过滤后的 999997 行

性能优化：Parquet 的 Row Group 级别跳过
  如果 DV 标记的所有删除行都在 Row Group 0（行号 0-65535），
  而当前查询只涉及 Row Group 1+，则连 DV 都不需要读取
```

**Spark 层的 DV 感知**：Spark 的 `DeltaParquetFileFormat` 在读取 Parquet 文件时会自动检查是否存在关联的 DV，如果有，则在向量化读取阶段插入行过滤逻辑（使用 Arrow 的 Selection Vector 实现零拷贝过滤）。

### 3.4 DV 的积累与清理

随着时间推移，对同一个 Parquet 文件的多次 DELETE/UPDATE 操作会积累多个 DV（或 DV 中的标记越来越多）。当 DV 标记的行数占文件总行数的比例超过阈值（默认 25%）时，应该触发文件重写（将 DV 中的删除标记物化到 Parquet 文件中，生成不含已删除行的新文件）。

**通过 `OPTIMIZE` 清理 DV**：

```sql
-- OPTIMIZE 会自动对 DV 密集的文件进行重写，清理已删除行
OPTIMIZE orders;

-- 查看哪些文件有 DV 以及 DV 的密度
SELECT path, deletionVector.cardinality AS deleted_rows, 
       numRecords, 
       deletionVector.cardinality / numRecords AS deletion_ratio
FROM (
  DESCRIBE DETAIL orders
);
```

> [!info] 核心概念
> DV 的引入改变了 Delta Lake DML 操作的性能特征，但没有改变最终的正确性：无论用 CoW 还是 DV，查询结果完全一致（DV 标记的行在读取时被透明过滤）。DV 只是将"写时代价"延迟到"定期 OPTIMIZE 时"，通过 I/O 时间的重新分配来优化高频 UPSERT 场景。

---

## 第 4 章 Change Data Feed：捕获行级别变更

### 4.1 Change Data Feed 是什么，为什么需要

**Change Data Feed（CDF）** 是 Delta Lake 1.1 引入的特性：在每次 DML 操作执行时，将行级别的变更（插入/更新前/更新后/删除）写入独立的 Change Data 文件，下游可以读取这些 Change Data 进行增量处理——无需每次全量扫描目标表。

**没有 CDF 时的增量读取困境**：

```
目标表：orders（Delta Lake）
下游任务：将 orders 的变更同步到 Elasticsearch

方案一（全量扫描）：
  每小时读取 orders 全量数据 → 全量写入 ES
  问题：orders 有 1TB，每小时全量扫描代价极高

方案二（Time Travel 差异计算）：
  比较 version=N 和 version=N-1 的差异 → 只同步变更
  问题：差异计算需要读取两个版本的全量数据并进行 Join，
       代价约等于读取 2TB 数据

方案三（CDF）：
  直接读取 version=N-1 到 version=N 的 Change Data
  只有实际变更的行，数据量可能只有几 MB
  代价极低！
```

### 4.2 开启 CDF

```sql
-- 在表创建时开启 CDF
CREATE TABLE orders (
  order_id BIGINT,
  amount DOUBLE,
  status STRING
) USING DELTA
TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');

-- 或对已有表开启
ALTER TABLE orders 
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');
```

### 4.3 CDF 的物理实现

开启 CDF 后，每次 DML 操作除了正常写入数据文件外，还会在 `_change_data/` 目录写入 Change Data 文件：

```
s3://bucket/delta/orders/
  _delta_log/
    00000000000000000015.json
  _change_data/
    part-00000-cdf-abc123.snappy.parquet   # 版本 15 的 Change Data
```

Change Data 文件是特殊的 Parquet 文件，包含目标表的所有列，外加一个 `_change_type` 列：

| `_change_type` 值 | 含义 |
|----------------|-----|
| `insert` | 新插入的行 |
| `update_preimage` | 更新前的行（旧值）|
| `update_postimage` | 更新后的行（新值）|
| `delete` | 被删除的行 |

**一次 MERGE 操作产生的 CDF 数据示例**：

```
order_id | amount | status | _change_type
1001     | 100.0  | 'open' | update_preimage    ← 更新前
1001     | 150.0  | 'paid' | update_postimage   ← 更新后
1002     | 200.0  | 'open' | delete             ← 被删除
1003     | 300.0  | 'open' | insert             ← 新插入
```

### 4.4 读取 CDF 数据

```python
# 读取特定版本范围的变更数据
changes = (spark.read
  .format("delta")
  .option("readChangeFeed", "true")
  .option("startingVersion", 10)   # 从 version=10 开始
  .option("endingVersion", 20)     # 到 version=20
  .table("orders"))

changes.show()
# +--------+--------+------+--------------+
# |order_id|  amount|status|_change_type  |
# +--------+--------+------+--------------+
# |    1001|   100.0|  open|update_preimage|
# |    1001|   150.0|  paid|update_postimage|
# ...

# 在 Structured Streaming 中使用 CDF（增量流式处理）
stream = (spark.readStream
  .format("delta")
  .option("readChangeFeed", "true")
  .option("startingVersion", "latest")
  .table("orders"))

# stream 是一个 Streaming DataFrame，包含 _change_type 列
# 可以对不同类型的变更做不同处理
stream.filter("_change_type = 'insert'").writeStream...
```

> [!note] 设计哲学
> CDF 与 Delta Log 的关系值得深思：Delta Log 记录的是**文件级别**的变更（哪些 Parquet 文件被 add/remove），而 CDF 记录的是**行级别**的变更（哪些具体的业务记录被 insert/update/delete）。Delta Log 是存储引擎的内部日志，CDF 是面向业务消费者的变更流。两者各自服务于不同的目的，共同构成了 Delta Lake 完整的可观测性体系。

---

## 小结

Delta Lake 的 DML 实现体系：

- **MERGE 操作**：两阶段执行（找 Touched Files + 重写 Touched Files）；分区裁剪可大幅减少 Touched Files 范围；Source 数据小但目标文件大时 I/O 放大严重
- **Copy-on-Write（CoW）**：传统模式，写时重写整个文件；读取无额外代价；适合低频大批量写入 + 高频查询的场景
- **Deletion Vector（DV，Delta 2.0+）**：写时只创建几 KB 的 RoaringBitmap 位图；读时透明过滤被删除行；大幅降低高频小批量 UPSERT 的写放大；需定期 OPTIMIZE 清理 DV
- **Change Data Feed（CDF）**：将行级别变更（insert/update_preimage/update_postimage/delete）写入独立 Change Data 文件；下游可直接读取增量变更，无需全量扫描；完美适配 CDC 同步场景

第 05 篇深入 Schema Evolution 与 Schema Enforcement：Delta Lake 如何在写入时强制校验 Schema（防止脏数据）、如何安全地向表中添加列/修改列类型（Schema 合并规则）、以及 Column Mapping 如何支持列重命名而不需要重写数据。

---

## 参考资料

- [Delta Lake Deletion Vectors 官方文档](https://docs.delta.io/latest/delta-deletion-vectors.html)
- [Delta Lake Change Data Feed 官方文档](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Delta Lake 2.0 发布说明（Databricks Blog）](https://www.databricks.com/blog/2022/10/25/delta-lake-2-0-released.html)
- Armbrust et al. Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores. VLDB 2020.
