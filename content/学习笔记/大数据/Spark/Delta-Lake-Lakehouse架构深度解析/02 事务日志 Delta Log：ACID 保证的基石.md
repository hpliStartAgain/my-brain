---
title: "事务日志 Delta Log：ACID 保证的基石"
date: 2026-02-28
tags: [Delta Lake, Delta Log, 事务日志, ACID, Checkpoint, Action, 元数据, 乐观并发]
aliases: []
---

# 02 事务日志 Delta Log：ACID 保证的基石

## 摘要

Delta Lake 的全部魔法——ACID 事务、Time Travel、Schema Evolution、并发控制——都建立在一个极为简单的数据结构之上：**Delta Log**（也叫 Transaction Log）。Delta Log 是一个位于 Delta 表目录下的 `_delta_log/` 子目录，里面存储了该表从创建至今每一次写操作的完整记录，是整个表的"操作账本"。从本质上说，Delta Lake 将一个普通的 Parquet 文件目录升级为一个有事务语义的表，靠的就是在文件系统层面维护这份账本。本文从 Delta Log 的物理文件布局入手，逐层解析 JSON Action 的语义（`add`、`remove`、`commitInfo`、`protocol`、`metaData`），分析一次 `INSERT`、`UPDATE`、`DELETE` 操作如何转化为 Delta Log 条目，以及 Checkpoint 机制如何解决日志文件无限增长和元数据读取性能劣化的问题。理解 Delta Log 是理解整个 Delta Lake 的钥匙。

---

## 第 1 章 Delta Log 的物理布局

### 1.1 一张 Delta 表在文件系统上的样子

```bash
# 一张名为 orders 的 Delta 表，存储在 S3
s3://bucket/delta/orders/
  _delta_log/
    00000000000000000000.json    # 版本 0 的提交日志
    00000000000000000001.json    # 版本 1 的提交日志
    00000000000000000002.json    # 版本 2
    ...
    00000000000000000009.json    # 版本 9
    00000000000000000010.checkpoint.parquet  # 第 10 个版本的 Checkpoint
    00000000000000000010.json    # 版本 10
    00000000000000000011.json    # 版本 11
    ...
    _last_checkpoint             # 指向最新 Checkpoint 的元数据文件（JSON）
  part-00000-3a5f7b12.snappy.parquet   # 实际数据文件（Parquet 格式）
  part-00001-7c2e4d89.snappy.parquet
  part-00002-5b1a3c66.snappy.parquet
  ...
```

几个关键观察：

1. **数据文件（Parquet）与日志文件（`_delta_log/`）位于同一目录**，任何能访问 S3 的引擎都能读取两者
2. **日志文件命名是严格递增的 20 位零填充数字**，表示版本号（version）。版本号从 0 开始，每次成功提交（commit）递增 1
3. **日志文件默认每 10 个版本生成一次 Checkpoint**（可配置），Checkpoint 是 Parquet 格式（比 JSON 更紧凑，读取更快）
4. **`_last_checkpoint` 文件**：一个很小的 JSON 文件，只记录最新 Checkpoint 的版本号，让读取者快速定位最新 Checkpoint

### 1.2 版本与 Snapshot 的关系

Delta Lake 的核心抽象是 **Snapshot（快照）**：版本 N 的 Snapshot 是该表在提交版本 N 后所有有效数据文件的集合（即"在版本 N 时这张表包含哪些 Parquet 文件"）。

读取版本 N 的 Snapshot 的方法：

```
1. 读取最新 Checkpoint（如 version=10 的 Checkpoint）
2. 从 Checkpoint 的版本+1 开始，顺序读取 JSON 日志（version=11, 12, ... N）
3. 将 Checkpoint 的文件列表与后续 JSON 日志的 add/remove actions 合并
4. 最终得到版本 N 的有效文件集合
```

这就是为什么 Checkpoint 每 10 个版本生成一次很重要——如果没有 Checkpoint，读取版本 1000 的 Snapshot 需要读取 1000 个 JSON 文件，元数据读取延迟不可接受。

---

## 第 2 章 JSON Action：Delta Log 的基本单位

### 2.1 每个 JSON 文件的结构

每个版本的 JSON 日志文件包含一行或多行 JSON，每行是一个 **Action**。同一次提交的所有 Action 都在同一个 JSON 文件中（每行一个 JSON 对象，即 NDJSON 格式）。

一次典型的 `INSERT` 操作对应的 JSON 日志：

```json
// 00000000000000000001.json（版本 1，INSERT 操作）
{"commitInfo":{"timestamp":1677571200000,"operation":"WRITE","operationParameters":{"mode":"Append","partitionBy":"[]"},"isBlindAppend":true,"version":1}}
{"add":{"path":"part-00000-3a5f7b12.snappy.parquet","partitionValues":{},"size":12345678,"modificationTime":1677571195000,"dataChange":true,"stats":"{\"numRecords\":100000,\"minValues\":{\"order_id\":1,\"order_date\":\"2026-01-01\"},\"maxValues\":{\"order_id\":100000,\"order_date\":\"2026-01-31\"},\"nullCount\":{\"order_id\":0,\"order_date\":0}}"}}
{"add":{"path":"part-00001-7c2e4d89.snappy.parquet","partitionValues":{},"size":11234567,"modificationTime":1677571196000,"dataChange":true,"stats":"{\"numRecords\":98000,...}"}}
```

### 2.2 五种核心 Action 详解

**Action 一：`add`**

`add` Action 表示向表中添加一个新的数据文件（Parquet）。

```json
{
  "add": {
    "path": "part-00000-3a5f7b12.snappy.parquet",   // 文件相对路径（相对于表根目录）
    "partitionValues": {"year": "2026", "month": "02"},  // 分区列的值
    "size": 12345678,                               // 文件大小（字节）
    "modificationTime": 1677571195000,              // 文件修改时间（毫秒时间戳）
    "dataChange": true,                             // 是否包含新增/修改的数据（OPTIMIZE 时为 false）
    "stats": "{                                     // 文件级别的列统计信息（JSON 字符串）
      \"numRecords\": 100000,                       // 该文件包含的记录数
      \"minValues\": {\"order_id\": 1},             // 每列的最小值（用于 Data Skipping）
      \"maxValues\": {\"order_id\": 100000},        // 每列的最大值
      \"nullCount\": {\"order_id\": 0}              // 每列的 NULL 计数
    }"
  }
}
```

`stats` 字段是 Delta Lake **数据跳过（Data Skipping）** 的基础——查询 `WHERE order_id = 500` 时，引擎读取所有 `add` Action 的 `stats`，只有 `minValues.order_id ≤ 500 ≤ maxValues.order_id` 的文件才需要实际读取，大量文件可以直接跳过。

**Action 二：`remove`**

`remove` Action 表示某个数据文件不再属于当前有效 Snapshot（被更新或删除操作替换）。注意：`remove` 并不立即删除物理文件，物理删除由 `VACUUM` 命令完成。

```json
{
  "remove": {
    "path": "part-00000-oldfile.snappy.parquet",
    "deletionTimestamp": 1677571300000,   // 标记为删除的时间戳（VACUUM 的参考基准）
    "dataChange": true                    // 是否是数据变更导致的删除（非 OPTIMIZE）
  }
}
```

**为什么不立即物理删除**：Delta Lake 的 Time Travel 依赖于保留历史文件。如果立即删除，就无法查询历史版本。`VACUUM` 命令清理超过保留期限（默认 7 天）的物理文件，这期间历史版本仍然可以查询。

**Action 三：`commitInfo`**

`commitInfo` 记录本次提交的元数据，用于审计和调试：

```json
{
  "commitInfo": {
    "timestamp": 1677571200000,         // 提交时间戳
    "userId": "user@company.com",
    "operation": "MERGE",               // 操作类型：WRITE / MERGE / UPDATE / DELETE / OPTIMIZE
    "operationParameters": {
      "predicate": "order_id = 123",
      "matchedPredicates": "[{\"actionType\":\"update\"}]"
    },
    "notebook": {"notebookId": "123"},  // 可选：调用来源（Notebook/Job）
    "clusterId": "spark-cluster-001",
    "readVersion": 10,                  // 读取的版本（乐观并发控制的基准版本）
    "isolationLevel": "WriteSerializable",
    "isBlindAppend": false,
    "version": 11
  }
}
```

**Action 四：`metaData`**

`metaData` Action 记录表的 Schema 和配置变更，在以下情况出现：
- 表首次创建（version=0）
- Schema 发生变化（添加列、修改列类型）
- 表属性变更（`TBLPROPERTIES`）

```json
{
  "metaData": {
    "id": "3f8a7b2c-1234-5678-abcd-ef0123456789",   // 表的唯一 ID（UUID）
    "name": "orders",
    "description": "Order table",
    "format": {"provider": "parquet", "options": {}},
    "schemaString": "{\"type\":\"struct\",\"fields\":[{\"name\":\"order_id\",\"type\":\"long\",\"nullable\":false},{\"name\":\"amount\",\"type\":\"double\",\"nullable\":true}]}",
    "partitionColumns": ["year", "month"],
    "configuration": {
      "delta.enableChangeDataFeed": "true",
      "delta.autoOptimize.optimizeWrite": "true"
    },
    "createdTime": 1677500000000
  }
}
```

**Action 五：`protocol`**

`protocol` Action 记录 Delta Lake 协议版本，用于前向兼容性检查：

```json
{
  "protocol": {
    "minReaderVersion": 1,    // 读取该表需要的最低 Delta 读协议版本
    "minWriterVersion": 2     // 写入该表需要的最低 Delta 写协议版本
  }
}
```

当启用某些高级特性（如 Column Mapping、Deletion Vectors）时，协议版本会提升，旧版本的 Delta Lake 客户端将无法读取/写入该表，避免数据损坏。

---

## 第 3 章 三种 DML 操作的 Delta Log 变化

### 3.1 INSERT（追加写入）

```sql
INSERT INTO orders VALUES (1001, '2026-02-28', 199.99), (1002, '2026-02-28', 299.99)
```

对应的 Delta Log（version N+1）：

```json
{"commitInfo": {"operation": "WRITE", "operationParameters": {"mode": "Append"}, "isBlindAppend": true}}
{"add": {"path": "part-new-xxx.snappy.parquet", "dataChange": true, ...}}
```

**Append-only 写入是最简单的情况**：只有 `add` Action，没有 `remove`，`isBlindAppend=true`。这意味着写入不可能与其他并发写入产生数据冲突（追加写入不修改任何现有数据），乐观并发控制直接成功。

### 3.2 UPDATE（更新记录）

```sql
UPDATE orders SET amount = 299.99 WHERE order_id = 1001
```

Delta Lake 的 UPDATE 实现是 **Copy-on-Write（CoW）**（默认模式）：

```
1. 找到包含 order_id=1001 的所有文件（通过 Data Skipping + 实际扫描）
2. 读取这些文件的全部数据
3. 修改满足条件的记录
4. 将修改后的数据写入新文件
5. 在 Delta Log 中：add 新文件 + remove 旧文件
```

对应的 Delta Log（version N+1）：

```json
{"commitInfo": {"operation": "UPDATE", "operationParameters": {"predicate": "(order_id = 1001)"}}}
{"remove": {"path": "part-00000-oldfile.snappy.parquet", "dataChange": true}}
{"add": {"path": "part-00000-newfile.snappy.parquet", "dataChange": true, ...}}
```

**CoW 的代价**：即使只更新一行，包含该行的整个 Parquet 文件（可能几百 MB）都需要被重写。这对高频小批量更新（如 CDC 场景）代价极高。Delta Lake 的 Merge-on-Read（MoR）模式通过 Deletion Vectors 解决这个问题（第 04 篇详述）。

### 3.3 DELETE（删除记录）

```sql
DELETE FROM orders WHERE order_id = 1001
```

Delete 的 Delta Log 结构与 Update 类似（CoW 模式）：

```json
{"commitInfo": {"operation": "DELETE", "operationParameters": {"predicate": "(order_id = 1001)"}}}
{"remove": {"path": "part-00000-oldfile.snappy.parquet", "dataChange": true}}
{"add": {"path": "part-00000-newfile-without-1001.snappy.parquet", "dataChange": true, ...}}
```

**特殊情况：整个文件的行都满足 DELETE 条件**。如果某个 Parquet 文件中的所有记录都满足删除条件，只需要 `remove` 这个文件，不需要创建新的 `add` 文件（文件直接被标记为删除，无需重写）。

---

## 第 4 章 Checkpoint：解决日志文件无限增长

### 4.1 为什么需要 Checkpoint

假设一张 Delta 表经过了 1000 次写操作（version=0 到 999），每次操作平均涉及 5 个 `add` 或 `remove` Action。

读取当前 Snapshot（version=999）需要：
1. 读取 1000 个 JSON 文件（每个文件一次 HTTP GET 请求，对象存储每次请求约 10ms）
2. 总延迟：1000 × 10ms = **10 秒**，仅元数据读取就需要 10 秒

**这是不可接受的**。Checkpoint 的引入就是为了解决这个问题。

### 4.2 Checkpoint 的生成时机与内容

Delta Lake 默认每 **10 次提交**生成一次 Checkpoint（可通过 `delta.checkpointInterval` 配置）。Checkpoint 是一个 Parquet 文件，包含截至该版本的**所有有效 `add` Action 的完整快照**（即：所有曾经被 `add` 过但还没被 `remove` 的文件的 Action 信息）。

Checkpoint Parquet 文件的内容（每行是一个 Action）：

```
row 1: {"add": {"path": "part-00000-aaa.parquet", "stats": {...}, ...}}
row 2: {"add": {"path": "part-00001-bbb.parquet", "stats": {...}, ...}}
row 3: {"metaData": {"schemaString": "...", "partitionColumns": [...], ...}}
row 4: {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}}
```

注意：Checkpoint 只包含当前有效的 `add` Action（已被 `remove` 的文件不包含），因此 Checkpoint 的大小正比于表中当前有效文件的数量。

### 4.3 读取 Snapshot 的完整流程（有 Checkpoint）

```
读取版本 999 的 Snapshot：

Step 1：读取 `_last_checkpoint` 文件
  内容：{"version": 990, "size": 5000}
  → 最新 Checkpoint 在 version=990

Step 2：读取 `00000000000000000990.checkpoint.parquet`
  → 获得 version=990 时所有有效文件的列表（5000 条 add Action）
  → 耗时：1 次 HTTP GET（读一个 Parquet 文件），约 100ms

Step 3：顺序读取 version=991 到 999 的 JSON 文件（9 个文件）
  → 应用增量的 add/remove Action
  → 耗时：9 × 10ms = 90ms

Step 4：合并 Checkpoint 的文件列表与增量 JSON 的变更
  → 得到 version=999 的完整有效文件集合
  → 总耗时：约 200ms（对比无 Checkpoint 的 10 秒，快 50 倍）
```

**`_last_checkpoint` 文件的作用**：避免了"从 version=0 向前扫描寻找最新 Checkpoint"的开销，直接定位到最新 Checkpoint 版本。

### 4.4 Multi-Part Checkpoint

当 Delta 表有数十万个有效 Parquet 文件时，单个 Checkpoint Parquet 文件可能非常大（几十 GB），读取单个大 Parquet 文件本身就很慢。

Delta Lake 2.0+ 支持 **Multi-Part Checkpoint**：将 Checkpoint 拆分成多个 Parquet 文件并行读取：

```
00000000000000000990.checkpoint.0000000001.0000000005.parquet  # 第 1 个分片
00000000000000000990.checkpoint.0000000002.0000000005.parquet  # 第 2 个分片
...
00000000000000000990.checkpoint.0000000005.0000000005.parquet  # 第 5 个分片（共 5 个分片）
```

Spark 可以并行读取这 5 个 Checkpoint 分片，元数据加载速度线性提升。

---

## 第 5 章 ACID 的实现机制：从 Delta Log 到事务语义

### 5.1 原子性（Atomicity）

**一次提交要么完全成功，要么完全失败**。

实现原理：Delta Lake 利用对象存储的**原子性单文件写入**（S3/OSS 的 PUT 操作是原子的）。一次提交的所有 Action 都写入同一个 JSON 文件（如 `00000000000000000011.json`），这个文件的写入要么成功（文件存在且完整）要么失败（文件不存在）。

读取者通过枚举 `_delta_log/` 目录中存在的 JSON 文件，只能看到已完成提交的版本，看不到进行中的提交。Spark 写入过程中崩溃 → JSON 文件不存在 → 该版本从未被读取者看到 → 原子性保证。

> [!info] 核心概念
> 这里有一个微妙的问题：S3 的 PUT 操作是原子的（要么完整写入，要么不写），但 S3 的 LIST 操作存在**最终一致性**问题（旧版 S3，新版 S3 Strong Consistency 已解决）。Delta Lake 依赖 S3 Strong Consistency（AWS S3 在 2020 年 12 月宣布支持），或者用 [[DynamoDB]] 作为外部 Lock Provider 实现强一致性（`delta.dynamoDbLogStore`）。

### 5.2 持久性（Durability）

写入 Delta Log JSON 文件后，数据就持久化在对象存储上（S3/HDFS 的持久性由云服务商/HDFS 副本机制保证）。Delta Lake 本身不提供额外的持久性机制，依赖底层存储。

### 5.3 隔离性（Isolation Level）

Delta Lake 支持两种隔离级别：

- **Serializable**：最强隔离，所有并发事务等价于某种顺序执行，读操作也参与冲突检测
- **WriteSerializable**（默认）：写操作之间 Serializable，读操作不参与冲突检测（允许读-写并发，读操作不阻塞写，写操作不阻塞读）

隔离性通过**乐观并发控制（OCC）**实现（第 03 篇详述）。

### 5.4 一致性（Consistency）

Delta Lake 通过 Schema Enforcement 保证数据一致性：写入数据的 Schema 必须与表的 `metaData` Action 中记录的 Schema 兼容，否则写操作被拒绝（第 05 篇详述）。

---

## 小结

Delta Log 是 Delta Lake 的核心——它将无状态的 Parquet 文件集合升级为有状态的、有版本的 ACID 表：

- **物理结构**：`_delta_log/` 下的 NDJSON 文件（每个版本一个），按版本号严格递增命名
- **五种 Action**：`add`（有效文件）、`remove`（失效文件）、`commitInfo`（提交元数据）、`metaData`（Schema/配置）、`protocol`（协议版本）
- **三种 DML 的实现**：INSERT 只有 `add`；UPDATE 和 DELETE 是 CoW——新建包含修改数据的文件（`add`）+ 标记旧文件为失效（`remove`）
- **Checkpoint**：每 10 次提交生成一次，将历史增量 JSON 压缩为单个 Parquet 快照，元数据读取从 O(N) 变为 O(1)（读 Checkpoint + 读少量增量 JSON）
- **ACID 基础**：原子性依赖对象存储的原子 PUT；持久性依赖底层存储；一致性依赖 Schema Enforcement；隔离性依赖乐观并发控制（下篇详述）

第 03 篇深入 MVCC 与乐观并发控制：当两个 Spark 作业同时尝试写入同一张 Delta 表时，如何通过版本号竞争、冲突检测（Conflict Detection）来判断哪个事务可以成功，哪个需要重试——以及什么情况下两个并发写入是真正冲突的，什么情况下可以安全地并发。

---

## 参考资料

- [Delta Lake Protocol Specification（GitHub）](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)
- Armbrust et al. Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores. VLDB 2020.
- [Delta Lake 源码：DeltaLog.scala（GitHub）](https://github.com/delta-io/delta/blob/master/core/src/main/scala/org/apache/spark/sql/delta/DeltaLog.scala)
