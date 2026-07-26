---
title: "元数据三层架构——Snapshot、Manifest List 与 Manifest File"
date: 2026-03-02
tags: [Data Skipping, Iceberg, Manifest, Snapshot, 元数据架构, 列统计, 快照隔离, 文件列表]
aliases: ["Iceberg元数据", "Snapshot快照", "Manifest File", "Manifest List", "Iceberg三层架构"]
---

**摘要：**

[[Apache Iceberg]] 最核心的工程创新，不是它的事务机制，也不是它的 Hidden Partitioning，而是这一切的物理基础——**三层元数据架构（Snapshot → Manifest List → Manifest File）**。这套分层设计解决了 [[Hive Metastore]] 在大规模场景下的根本性扩展性问题：不再需要查询数百万行的分区表，而是通过元数据文件的层层剪枝，在毫秒级内定位到需要扫描的少量数据文件。本文深入解析三层架构的每一层文件结构、读取路径、列统计如何驱动 Data Skipping，以及这个设计如何天然支持快照隔离和 Time Travel，并与 Delta Lake 的事务日志机制做精准对比。

---

## 第 1 章 为什么需要三层元数据

### 1.1 单层文件列表的扩展性问题

设想最简单的元数据设计：**用一个文件记录当前表的所有数据文件**。

```
simple_table_manifest.json:
{
  "files": [
    {"path": "s3://bucket/events/part-0000.parquet", "size": 134217728},
    {"path": "s3://bucket/events/part-0001.parquet", "size": 134217728},
    ... （100 万个文件，每个 100 字节记录 → 文件大小 100MB）
  ]
}
```

问题立刻出现：

- **读取整个清单文件才能开始查询**：100MB 的 JSON 文件，光解析就需要几秒钟
- **每次写入都需要重写整个文件**：新增一个 part-1000000.parquet，要重写 100MB 的文件
- **无法做细粒度剪枝**：要过滤 `WHERE date = '2024-01-01'`，必须扫描全部 100 万条记录才能找出日期匹配的文件

这就是 HMS 的本质——它把所有分区信息存在 MySQL 的 PARTITIONS 表里，查询时要扫描这张可能有数百万行的关系表。

### 1.2 分而治之：层次化元数据

Iceberg 的解法是**层次化（hierarchical）**——把一个扁平的大文件列表，组织成多个小文件的树形结构。读取时自顶向下，每层做过滤（剪枝），最终只读取少量叶子节点文件。

这个设计的灵感来自于文件系统本身的 inode 层次结构，以及数据库 B-Tree 索引的分层思想。

```
三层结构的层次剪枝示例：

查询：WHERE date = '2024-01-01'

Layer 1：metadata.json（表级）
  → 快速找到最新 Snapshot ID（毫秒级）
  → 1 个小文件（通常 < 100KB）

Layer 2：ManifestList（快照级，~100KB）
  → 记录了本快照包含的所有 Manifest 文件
  → 每个 Manifest 条目有 partition_summary（分区摘要）
  → 根据 partition_summary 过滤：只有 3 个 Manifest 包含 date=2024-01-01 的文件
  → 从 1000 个 Manifest 文件缩减为 3 个

Layer 3：Manifest File（~1MB 每个）
  → 每个 Manifest 包含约 1000 个数据文件的详细信息
  → 每个文件条目有列级 Min/Max 统计
  → 进一步用列统计过滤：只有 120 个文件需要实际扫描
  → 从 3000 个文件缩减为 120 个

实际数据扫描：120 个 Parquet 文件
```

---

## 第 2 章 第一层：metadata.json（表级元数据）

### 2.1 文件内容与结构

每次表结构变更（Schema 变化、分区规范变化）或 Snapshot 创建，都会生成一个新版本的 `metadata.json`（版本号递增，如 `v1.metadata.json`, `v2.metadata.json`）。

典型的 `metadata.json` 内容（简化展示）：

```json
{
  "format-version": 2,
  "table-uuid": "9c12d441-03fe-4693-9a96-a0705ddf69c2",
  "location": "s3://bucket/events",

  "last-sequence-number": 42,    ← 全局单调递增序号（用于并发控制）
  "last-updated-ms": 1704067200000,
  "last-column-id": 8,

  "current-schema-id": 0,
  "schemas": [                   ← Schema 历史版本（支持 Schema Evolution）
    {
      "schema-id": 0,
      "fields": [
        {"id": 1, "name": "event_id", "type": "string", "required": true},
        {"id": 2, "name": "user_id",  "type": "long"},
        {"id": 3, "name": "event_type", "type": "string"},
        {"id": 4, "name": "event_ts", "type": "timestamptz"},
        {"id": 5, "name": "date",    "type": "date"}
      ]
    }
  ],

  "default-spec-id": 0,
  "partition-specs": [           ← 分区规范历史版本（支持 Partition Evolution）
    {
      "spec-id": 0,
      "fields": [
        {"source-id": 5, "field-id": 1000, "name": "date", "transform": "identity"}
      ]
    }
  ],

  "current-snapshot-id": 3055729675574597004,
  "snapshots": [                 ← 历史 Snapshot 列表（Time Travel 的基础）
    {
      "snapshot-id": 3055729675574597004,
      "parent-snapshot-id": 3051774107949218754,
      "sequence-number": 42,
      "timestamp-ms": 1704067200000,
      "manifest-list": "s3://bucket/events/metadata/snap-3055729675574597004.avro",
      "summary": {
        "operation": "append",
        "added-data-files": "5",
        "added-records": "2341156"
      }
    },
    {
      "snapshot-id": 3051774107949218754,
      "sequence-number": 41,
      ...
    }
  ],

  "snapshot-log": [...],         ← Snapshot 操作历史（用于审计和 Time Travel）
  "metadata-log": [...]          ← metadata.json 版本历史
}
```

**关键设计点：列 ID（Field ID）机制**

注意每个 Schema 字段有独立的 `id`（如 `event_id` 是 `1`，`user_id` 是 `2`）。这是 Iceberg Schema Evolution 优于其他方案的核心原因：

```
传统方案（Hive/Delta Lake）的列识别方式：
  列名（name）作为列的唯一标识
  重命名列 → 旧名字的历史数据无法用新名字读取
  → 需要重写历史数据，或者维护复杂的列名映射

Iceberg 的列识别方式：
  列 ID（field-id）作为列的唯一标识，名字只是别名
  重命名列 → 只改 name 字段，field-id 不变
  → 旧 Parquet 文件里的列用 field-id 1 写入
  → 新 Schema 里 field-id 1 对应新名字
  → Iceberg 读取时按 field-id 匹配，自动适配新列名
  → 历史数据无需重写！
```

### 2.2 Catalog 与 metadata.json 的关系

Catalog 存储的是表名到**最新** `metadata.json` 路径的映射。每次写操作完成后，Catalog 原子地将指针从旧版本切换到新版本：

```
写操作前：
  Catalog: events → s3://bucket/events/metadata/v41.metadata.json

写操作（添加新数据）：
  1. 创建新的 Manifest、ManifestList 文件
  2. 创建 v42.metadata.json（包含新 Snapshot）
  3. 原子更新 Catalog：events → s3://bucket/events/metadata/v42.metadata.json

写操作后：
  Catalog: events → s3://bucket/events/metadata/v42.metadata.json
  v41.metadata.json 仍然存在（旧快照，Time Travel 用）
```

这个"原子指针切换"是 Iceberg 事务性的核心——要么切换成功（新数据可见），要么不切换（旧数据仍有效），永远不会有中间状态。

---

## 第 3 章 第二层：Manifest List（快照文件清单）

### 3.1 什么是 Manifest List

**Manifest List** 是每个 Snapshot 对应的一个 Avro 文件（通常命名为 `snap-{snapshot-id}.avro`），记录了**本快照包含的所有 Manifest 文件的元数据**。

注意区分：
- **Manifest File**（清单文件）：记录一批数据文件的详细信息（路径、大小、列统计）
- **Manifest List**（清单列表）：记录某个 Snapshot 包含哪些 Manifest 文件

### 3.2 Manifest List 的内容

Manifest List 是 Avro 格式，每个条目（一行）代表一个 Manifest 文件：

```
Manifest List 条目字段（Avro Schema）：
  manifest_path      : string  ← Manifest 文件路径
  manifest_length    : long    ← Manifest 文件大小（字节）
  partition_spec_id  : int     ← 使用的分区规范版本
  content            : int     ← 0=DATA（数据文件），1=DELETES（删除文件）
  sequence_number    : long    ← 写入序号（用于并发控制）
  added_snapshot_id  : long    ← 该 Manifest 首次被哪个 Snapshot 添加

  ← 以下是 Partition Summary（分区摘要，用于 ManifestList 级别的剪枝）：
  added_rows_count   : long    ← 本 Manifest 新增的记录数
  existing_rows_count: long    ← 本 Manifest 未改变的记录数
  deleted_rows_count : long    ← 本 Manifest 删除的记录数

  partitions: array of {       ← 每个分区维度的统计（关键！）
    contains_null  : boolean,
    contains_nan   : boolean,
    lower_bound    : bytes,    ← 该 Manifest 中该分区字段的最小值
    upper_bound    : bytes     ← 该 Manifest 中该分区字段的最大值
  }
```

**`partitions` 字段的价值**：对于按 `date` 分区的表，每个 Manifest 条目记录了"本 Manifest 中数据的 date 最小值和最大值"。查询 `WHERE date = '2024-01-01'` 时，只需读取 Manifest List（通常 < 1MB），然后过滤 `lower_bound ≤ '2024-01-01' ≤ upper_bound` 的条目，大多数 Manifest 文件可以直接跳过，无需读取。

### 3.3 Manifest 的复用机制

Iceberg 的一个重要设计是：**写操作不需要重写所有 Manifest，只需要创建新的 Manifest 并在 ManifestList 中引用它们**。

```
初始状态（Snapshot 1，包含 Manifest A、B、C）：
  ManifestList-1:
    [Manifest-A, Manifest-B, Manifest-C]

新增数据（创建 Snapshot 2，只新增了一批文件）：
  1. 创建新的 Manifest-D（只包含新增的文件）
  2. 创建 ManifestList-2（复用 A、B、C，新增 D）：
     [Manifest-A, Manifest-B, Manifest-C, Manifest-D]
  3. 不重写 Manifest-A、B、C！

好处：
  写操作只需写一个新的 Manifest 文件（小）
  旧 Manifest 文件被复用，无需重写（零写放大！）

对比 Hudi CoW：
  每次 Upsert 都要重写被修改文件所在的 Parquet（写放大严重）

对比 Delta Lake：
  Delta Log 记录的是 Add/Remove 操作日志，实际文件列表需要从头重放所有日志
  而 Iceberg 的 Manifest 直接是完整的文件列表，无需重放历史
```

---

## 第 4 章 第三层：Manifest File（数据文件清单）

### 4.1 Manifest File 的内容

**Manifest File** 是 Iceberg 元数据的"叶子节点"，记录了一批数据文件（或删除文件）的详细信息。这是 Data Skipping 的核心依赖。

Manifest File 也是 Avro 格式，每个条目代表一个数据文件（Parquet/ORC）：

```
Manifest File 条目字段：
  status         : int    ← 0=EXISTING（未改变），1=ADDED（新增），2=DELETED（已删除）
  snapshot_id    : long   ← 该文件由哪个 Snapshot 添加
  sequence_number: long   ← 写入序号（用于并发控制和时间序）
  file_sequence_number: long

  data_file: {
    content       : int    ← 0=DATA，1=POSITION DELETES，2=EQUALITY DELETES
    file_path     : string ← S3/HDFS 路径
    file_format   : string ← PARQUET / ORC / AVRO
    partition     : struct ← 分区值（根据 partition_spec 不同而变化）
    record_count  : long   ← 文件内的记录数
    file_size_in_bytes: long
    column_sizes  : map<int, long>   ← 每列压缩后的大小（按 field_id）

    ← 以下是列级统计信息（Data Skipping 的核心）：
    value_counts  : map<int, long>   ← 每列的非 null 值数量
    null_value_counts: map<int, long> ← 每列的 null 值数量
    nan_value_counts : map<int, long>

    lower_bounds  : map<int, bytes>  ← 每列的最小值（按 field_id 映射，二进制编码）
    upper_bounds  : map<int, bytes>  ← 每列的最大值

    ← 可选：Bloom Filter 统计（Puffin 文件中存储，Iceberg 1.x 新增）
    key_metadata  : bytes
    split_offsets : list<long>       ← 文件内分割点（用于并行读取）
  }
```

### 4.2 列统计驱动的 Data Skipping

`lower_bounds` 和 `upper_bounds` 是 Iceberg 查询优化的核心。对于查询 `WHERE user_id = 12345`：

```
查询：SELECT * FROM events WHERE user_id = 12345

Manifest File 中有 1000 个数据文件条目。
对每个条目检查 lower_bounds[user_id] 和 upper_bounds[user_id]：

  文件 1：lower=1000, upper=5000   → 12345 不在范围内，跳过
  文件 2：lower=10000, upper=20000 → 12345 不在范围内，跳过
  文件 3：lower=10000, upper=15000 → 12345 不在范围内，跳过
  ...
  文件 47：lower=12000, upper=12500 → 12345 在范围内，需要扫描
  文件 48：lower=12300, upper=13000 → 12345 在范围内，需要扫描
  ...

结果：1000 个文件中，只有约 5-10 个文件需要实际扫描
跳过率：99%+（如果数据有一定的局部性）
```

这是 Iceberg 查询优化的"第二级剪枝"（第一级是 ManifestList 级别的分区摘要过滤）。

> [!info] 与 Parquet 内置行组统计的区别
> Parquet 文件内部的每个 Row Group 也有列统计（Min/Max），但要使用这个统计，需要先打开 Parquet 文件读取 Footer。
> Iceberg 的 Manifest 统计存储在**元数据文件**中（不在数据文件里），无需打开任何数据文件即可完成文件级别的剪枝——这是显著的 IO 节省，特别是在对象存储（S3）上，打开文件的 GET 请求有 10-50ms 的延迟。

### 4.3 分区值的存储方式

注意 Manifest 条目中有 `partition` 字段，存储了该文件所属的分区值。这就是 Hidden Partitioning 的物理基础：

```
对于按 month(event_ts) 分区的表：
  partition_spec:
    source_id: 4 (event_ts 字段)
    transform: "month"

Manifest 中文件 A 的条目：
  partition: {month(event_ts) = 649}  ← 649 = 2024年1月（从 epoch 算起的月数）
  lower_bounds: {4: 2024-01-01T00:00:00}
  upper_bounds: {4: 2024-01-31T23:59:59}

查询：WHERE event_ts > '2024-01-15'
  → 分区过滤：month(event_ts) 分区值 >= 649（2024年1月）
  → 读取对应 Manifest 条目
  → 再用文件级 upper_bounds 检查：哪些文件的最大 event_ts > '2024-01-15'
  → 精确定位到需要扫描的文件
```

用户查询时完全不需要知道"数据是按 month 分区的"——只需要写 `WHERE event_ts > '2024-01-15'`，Iceberg 自动做分区转换和文件过滤。这正是 Hidden Partitioning 的核心体验。

---

## 第 5 章 三层架构的 Time Travel 实现

### 5.1 Snapshot 的历史保留

`metadata.json` 保留了所有历史 Snapshot 的列表（直到 `expire_snapshots` 操作清理）。Time Travel 的实现非常直接：

```sql
-- 按 Snapshot ID 查询历史版本
SELECT * FROM catalog.events VERSION AS OF 3051774107949218754;

-- 按时间戳查询历史版本
SELECT * FROM catalog.events TIMESTAMP AS OF '2024-01-01 12:00:00';
```

内部实现：

```
按时间戳查询时：
  1. 读取 metadata.json，找到 snapshot-log
  2. 在 snapshot-log 中，找到 timestamp <= 目标时间戳 的最后一个 Snapshot ID
  3. 用该 Snapshot ID 对应的 manifest-list 路径读取 ManifestList
  4. 后续流程与普通查询相同

这个实现比 Delta Lake 的 Time Travel 简单得多：
  Delta Lake 需要"重放"历史 Delta Log 来重建某个时间点的文件状态
  Iceberg 每个 Snapshot 已经是完整的文件状态，无需重放
```

### 5.2 Snapshot 清理（Expire Snapshots）

旧 Snapshot 占用存储，需要定期清理：

```sql
-- 清理 7 天前的旧 Snapshot
CALL system.expire_snapshots('analytics.events', TIMESTAMP '2024-01-01 00:00:00');
```

清理逻辑：

```
1. 找到所有 timestamp < 目标时间 的 Snapshot ID
2. 从 metadata.json 中移除这些 Snapshot 记录
3. 找出只被这些旧 Snapshot 引用的 Manifest 文件和数据文件
   （被任何保留 Snapshot 引用的文件不能删除）
4. 删除不再被任何保留 Snapshot 引用的文件

注意：需要小心多 Snapshot 之间的 Manifest 共享！
  ManifestList 复用意味着一个 Manifest 可能被多个 Snapshot 引用
  只有引用计数为 0 时，才能删除 Manifest 文件
```

---

## 第 6 章 与 Delta Lake 事务日志的对比

理解了三层架构后，可以做一个精准的与 Delta Lake 的对比：

| 维度 | Iceberg 三层元数据 | Delta Lake `_delta_log` |
|-----|------------------|------------------------|
| **元数据格式** | 独立的 Avro/JSON 文件（分层）| 顺序编号的 JSON 文件（线性日志）|
| **读取开销** | 按需读取（三层剪枝，只读必要的 Manifest）| 需要累积应用所有 Delta Log（或读 Checkpoint）|
| **写入开销** | 只写新 Manifest + 新 ManifestList（旧 Manifest 复用）| 追加新 JSON 日志（轻量）|
| **Time Travel** | 直接索引 Snapshot，O(1) 访问 | 需要从最近 Checkpoint 重放日志 |
| **文件级列统计** | 存于 Manifest（不需要打开数据文件）| 存于 `_delta_log` JSON 的 addFile stats（类似）|
| **分区信息** | Manifest 中的 partition 字段（Hidden Partitioning）| 数据文件路径中（传统分区目录）|
| **多引擎支持** | 规范统一，任何引擎实现相同逻辑 | Spark 深度绑定，其他引擎通过 Delta Protocol 适配 |

**根本差异**：

Delta Lake 的 `_delta_log` 是一个**操作日志（operation log）**——记录"做了什么操作"，状态需要通过重放日志重建。

Iceberg 的三层元数据是一个**状态快照（state snapshot）**——每个 Snapshot 直接记录"当前是什么状态"，无需重放。

这使得 Iceberg 在 Time Travel、跨引擎读取等场景下更高效——任何引擎读取某个 Snapshot，只需根据 manifest-list 路径找到文件列表，完全不需要理解"历史上发生了什么操作"。

---

## 小结

Iceberg 三层元数据架构的设计精髓在于**层次化剪枝与状态直存**：

- **层次化剪枝**：ManifestList → Manifest File 的两级过滤，将"列举所有文件"变为"只读需要的文件"
- **状态直存**：每个 Snapshot 是完整的文件状态，无需重放历史操作，Time Travel 和多引擎读取性能最优
- **Manifest 复用**：写操作只需追加新 Manifest，旧 Manifest 被多个 Snapshot 共享，写放大最小

下一篇 [[03 Hidden Partitioning——告别分区列陷阱]] 将深入 Iceberg 对用户体验影响最大的设计——Hidden Partitioning。我们将解析为什么传统分区的"分区列陷阱"是一个设计缺陷，以及 Iceberg 如何通过把分区规则存在元数据而不是文件路径里，彻底消除这个陷阱，并实现无缝的 Partition Evolution。


> [!note] 思考题
> 1. 在频繁小批次写入场景（每分钟一次 Commit），每次 Commit 产生新的 Snapshot + Manifest List + 若干 Manifest File。`metadata.json` 中的 Snapshot 列表会不断增长。Iceberg 的 `expire_snapshots` 操作是如何清理旧 Snapshot 对应的元数据文件的？清理操作是否是原子的？
> 2. Manifest File 中的列统计信息由 Writer 在文件写入时计算。如果 Writer 是不支持精确统计的引擎（如某些版本的 Trino 只记录 Min/Max 但不记录 NullCount），包含 NULL 值的查询（`WHERE col IS NULL`）在 Manifest 级别的过滤会发生什么？
> 3. Compaction 将多个小文件合并为大文件时，包含旧文件信息的 Manifest 需要被重写（旧文件标记为 DELETED，新文件标记为 ADDED）。如果 Compaction 的目标文件非常多（合并 10000 个小文件），重写 Manifest 的代价是多少？有没有优化手段避免完全重写整个 Manifest？