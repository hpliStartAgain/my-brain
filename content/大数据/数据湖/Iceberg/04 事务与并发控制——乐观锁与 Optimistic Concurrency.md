---
title: "事务与并发控制——乐观锁与 Optimistic Concurrency"
date: 2026-03-02
tags: [Iceberg, 事务, ACID, 并发控制, 乐观锁, Snapshot隔离, OCC, 多写冲突, Catalog]
aliases: ["Iceberg事务", "Iceberg并发控制", "乐观并发控制", "Snapshot隔离", "OCC"]
---

**摘要：**

[[Apache Iceberg]] 的事务机制建立在一个简洁而优雅的基础上：**原子地切换 Catalog 中"当前元数据文件"的指针**。这个操作要么成功（新 Snapshot 对所有读者可见），要么失败（原 Snapshot 不受任何影响）——永远不存在"写了一半"的中间状态。在此基础上，Iceberg 通过**乐观并发控制（OCC）**处理多个 Writer 的并发冲突：先各自写入，最后提交时检查是否有冲突，无冲突则成功，有冲突则按策略重试或失败。本文深入剖析 Iceberg 事务的底层实现（Catalog 原子操作如何保证 ACID）、OCC 的冲突检测算法（哪些操作互相兼容、哪些不兼容）、Snapshot 隔离级别的语义，并与 [[Delta Lake]] 的事务隔离级别机制做精准的机制对比。

---

## 第 1 章 Iceberg 事务的物理基础

### 1.1 一切事务的根基：Catalog 的原子指针切换

在 [[Apache Iceberg]] 的架构中，"提交一个事务"在物理层面等价于：**原子地将 Catalog 中某张表的元数据指针，从旧版本的 `metadata.json` 切换到新版本的 `metadata.json`**。

```
事务提交前：
  Catalog（如 HMS）中记录：
    table: analytics.events
    metadata_location: s3://bucket/events/metadata/v41.metadata.json

写操作（写入新数据）：
  Step 1：创建新的数据文件（Parquet）
  Step 2：创建新的 Manifest 文件（记录新数据文件的统计信息）
  Step 3：创建新的 ManifestList 文件（Snapshot，包含所有 Manifest）
  Step 4：创建 v42.metadata.json（在 v41 基础上增加新 Snapshot 的引用）
  Step 5：原子地更新 Catalog：
    metadata_location: s3://bucket/events/metadata/v42.metadata.json

事务提交后：
  Catalog 中记录：
    table: analytics.events
    metadata_location: s3://bucket/events/metadata/v42.metadata.json
```

Step 5 的原子性是整个事务机制的基础。如果 Step 5 成功，v42 对所有读者立刻可见；如果 Step 5 失败（如 Catalog 写入超时），v42.metadata.json 文件仍然存在于 S3 上，但没有任何人能"找到"它（因为 Catalog 还指向 v41），等价于事务完全没有发生。

### 1.2 不同 Catalog 实现的原子性保证

Iceberg 支持多种 Catalog 后端，原子性的实现方式略有差异：

**Hive Metastore（HMS）Catalog**：

利用 HMS 中关系数据库（MySQL/PostgreSQL）的事务能力，通过一条 `UPDATE` SQL 语句原子地修改 `metadata_location`：

```sql
-- HMS 内部执行的原子更新（简化）
UPDATE TABLE_PARAMS
SET PARAM_VALUE = 's3://bucket/events/metadata/v42.metadata.json'
WHERE TBL_ID = 12345
  AND PARAM_KEY = 'metadata_location'
  AND PARAM_VALUE = 's3://bucket/events/metadata/v41.metadata.json'; -- CAS 操作！
```

注意这里是 **CAS（Compare-And-Swap）操作**：只有当前值是 v41 时才更新为 v42。如果另一个 Writer 已经将值改为 v42，这个 UPDATE 影响行数为 0，触发冲突检测。

**AWS Glue Catalog**：

利用 AWS Glue API 的条件更新（`PutTable` 接口的 `VersionId` 条件），通过 AWS 的分布式一致性保证实现原子切换。

**REST Catalog（Iceberg 推荐标准）**：

REST Catalog 服务在内部实现原子提交，通常基于关系数据库或分布式 KV 存储（如 etcd），对外暴露：

```
POST /v1/namespaces/analytics/tables/events/transactions/commit
Body: {
  "current-snapshot-id": 3051774107949218754,  ← 期望的当前 Snapshot（CAS 条件）
  "updates": [{
    "action": "add-snapshot",
    "snapshot": { "snapshot-id": 3055729675574597004, ... }
  }, {
    "action": "set-current-snapshot",
    "snapshot-id": 3055729675574597004
  }],
  "requirements": [{
    "type": "assert-current-snapshot-id",
    "snapshot-id": 3051774107949218754  ← 如果当前 Snapshot 不是这个，拒绝提交
  }]
}
```

REST API 返回 `200 OK` = 提交成功，`409 Conflict` = 有并发写入，需要重试。

### 1.3 为什么这种设计能保证 Atomicity 和 Isolation

**原子性（Atomicity）**：

所有数据文件在 Catalog 指针切换之前就已经完整写入 S3。如果写数据文件的过程中 Job 崩溃，Catalog 指针不会切换，这些"孤儿"数据文件不会被任何 Snapshot 引用——它们对任何读者都不可见，等价于写操作从未发生。（定期的 `remove_orphan_files` 操作会清理这些孤儿文件。）

**隔离性（Isolation）**：

读操作在开始时确定一个 Snapshot ID（通常是最新的），然后基于这个 Snapshot 的文件列表执行。无论读操作进行多久，它看到的数据都是那个 Snapshot 时刻的完整快照，不受同期进行的写操作影响——这是 **Snapshot Isolation（快照隔离）** 的标准定义。

---

## 第 2 章 乐观并发控制（OCC）

### 2.1 为什么选择乐观并发控制

Iceberg 没有使用悲观锁（在写入之前锁定整张表）——原因是在分布式大数据场景下，写操作可能需要几十分钟（如重写一张 10TB 的大表），悲观锁会导致整张表在这段时间内对其他写者不可用，极大地降低系统吞吐量。

**乐观并发控制（OCC, Optimistic Concurrency Control）** 的基本思想是：

```
悲观锁（Pessimistic Lock）的逻辑：
  1. 获取锁（其他人等待）
  2. 读取数据
  3. 修改数据
  4. 写入数据
  5. 释放锁
  → 串行化，安全但低效

乐观并发控制（OCC）的逻辑：
  1. 读取数据（记录此时的版本号/Snapshot ID）
  2. 修改数据（在本地，不影响他人）
  3. 提交时：检查当前版本是否还是 Step 1 读到的版本
     → 是：提交成功（没有人并发修改）
     → 否：检测到冲突，根据策略处理（重试或失败）
  → 大多数情况下提交成功，少数冲突时有重试开销
  → 高并发场景下吞吐量远优于悲观锁
```

在大数据场景中，同一张表的并发写入冲突率通常很低（不同 Job 写不同分区、不同文件）——OCC 的乐观假设往往成立，是正确的默认选择。

### 2.2 冲突检测算法

当两个 Writer（A 和 B）几乎同时向同一张表提交时，Iceberg 的 OCC 实现如下：

```
时间线：
  t=0: Writer A 读取 Snapshot v41（current）
  t=0: Writer B 读取 Snapshot v41（current）
  t=5: Writer A 写完数据文件，准备提交
        → A 尝试 CAS：(v41 → v42)
        → 成功！Catalog 现在指向 v42
  t=6: Writer B 写完数据文件，准备提交
        → B 尝试 CAS：(v41 → v43)
        → 失败！Catalog 现在是 v42，不是 v41
        → 触发冲突处理逻辑
```

冲突处理的核心在于：**Writer B 的操作与 Writer A 的操作是否真的冲突？**

Iceberg 区分了可以自动合并的"不冲突的并发操作"和必须失败的"真正冲突操作"：

**可以自动重试合并的操作**：

```
场景 1：两个 Writer 写不同分区
  A 写分区 date=2024-01-01（v41 → v42）
  B 写分区 date=2024-01-02
  → B 可以基于 v42 重新提交（把 B 的 Manifest 加入 v42 的 ManifestList）
  → 无真正冲突，自动重试成功

场景 2：追加写（Append-only）没有任何重叠
  A 追加新文件（v41 → v42）
  B 也追加新文件（与 A 的文件没有任何重叠）
  → B 可以基于 v42 重新追加
  → 自动重试成功
```

**必须失败的操作**：

```
场景：两个 Writer 修改同一批文件（如 OVERWRITE 同一分区）
  A: OVERWRITE partition date=2024-01-01（v41 → v42，替换了该分区的文件）
  B: OVERWRITE partition date=2024-01-01（也要替换同一分区的文件）
  → B 基于 v41 的文件已经被 A 替换，无法安全合并
  → B 提交失败，抛出 CommitFailedException

正确处理：
  B 需要重新读取 v42 的数据（包含 A 的修改），基于新状态重新计算，然后再次提交
```

### 2.3 Iceberg 内置的冲突策略

Iceberg 为不同的写入类型提供了不同的冲突策略配置：

```java
// Iceberg Java API（Spark 内部使用的底层接口）

// 策略 1：仅追加（AppendFiles），最宽松
// 任何追加操作之间不会冲突（不同文件互不干扰）
AppendFiles append = table.newAppend();
append.appendFile(dataFile);
append.commit();  // 自动重试，几乎永远成功

// 策略 2：覆写（ReplacePartitions），基于分区隔离
// 不同分区的 OverWrite 可以并发，相同分区不行
OverwriteFiles overwrite = table.newOverwrite();
overwrite.overwriteByRowFilter(Expressions.equal("date", "2024-01-01"));
overwrite.addFile(newDataFile);
overwrite.commit();  // 同分区的并发覆写会冲突

// 策略 3：行级删除（RowDelta），最宽松之一
// 行级删除文件（Equality/Position Delete）之间通常不冲突
RowDelta rowDelta = table.newRowDelta();
rowDelta.addRows(newDataFile);
rowDelta.addDeletes(deleteFile);
rowDelta.commit();
```

**重试逻辑**（Iceberg 内置）：

```java
// Iceberg 的提交重试机制（简化）
for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
        buildAndCommit();  // 构建并提交事务
        return;            // 成功
    } catch (CommitStateUnknownException e) {
        throw e;           // 状态未知（网络超时），不安全重试
    } catch (CommitFailedException e) {
        // 冲突检测：判断是否可以安全重试
        if (canRetry(e)) {
            cleanUpFailedCommit();  // 清理本次写入的临时文件
            rebuildCommit();        // 基于最新 Snapshot 重新构建
        } else {
            throw e;  // 真正冲突（如 OVERWRITE 同一分区），直接失败
        }
    }
}
```

---

## 第 3 章 Snapshot 隔离的语义

### 3.1 读者看到什么

Iceberg 提供的隔离级别是 **Snapshot Isolation（快照隔离）**，这是一种比 Read Committed 更强、比 Serializable 略弱的隔离级别：

```
Read Committed（读已提交）：
  读操作每次读取都看到最新的已提交数据
  → 同一事务内的两次 SELECT 可能看到不同的结果（不可重复读）

Snapshot Isolation（快照隔离）：
  读操作在开始时确定一个 Snapshot，整个读操作期间始终看到这个 Snapshot 的数据
  → 同一事务内的两次 SELECT 永远看到相同的结果（可重复读）
  → 不会看到幻读（因为文件集合在 Snapshot 确定后不变）

Serializable（可序列化）：
  所有事务按串行顺序执行，最强隔离
  → Iceberg 不提供此级别（成本太高）
```

**Snapshot Isolation 的实际体验**：

```python
# 场景：大型查询（需要 30 分钟完成）与并发写操作

# t=0: 读操作开始，确定 Snapshot v41
reader_df = spark.read.format("iceberg").load("s3://bucket/events/")
# reader_df 基于 Snapshot v41 的文件列表（10000 个文件）

# t=5: Writer A 提交新数据（v41 → v42，新增 100 个文件）
# t=10: Writer B 删除旧数据（v42 → v43，删除 50 个旧文件）
# ...

# t=30: 读操作完成（30 分钟后）
# 结果：仍然是 Snapshot v41 的完整数据，不受 v42/v43 的影响
#       即使 v43 已经删除了 v41 的 50 个文件，这 50 个文件在物理上仍然存在
#       （Iceberg 的 expire_snapshots 不会在长期读操作进行中删除正在使用的文件）
result = reader_df.count()
```

> [!warning] 长期读操作与 Snapshot 保留的冲突
> Iceberg 的 `expire_snapshots` 操作可能删除旧数据文件。如果一个长期运行的读操作（如大型 Spark Job）正在使用某个 Snapshot 的文件，而 `expire_snapshots` 恰好删除了这些文件，读操作会失败（`FileNotFoundException`）。
> 最佳实践：配置合理的 Snapshot 保留时间（`min-snapshots-to-keep` 和 `max-snapshot-age-ms`），确保不会在长期查询期间删除正在使用的文件。

### 3.2 写者的隔离保证

写操作的隔离也是 Snapshot Isolation：

```
两个并发写操作：
  A：MERGE INTO events（读 Snapshot v41，修改 100 条记录）
  B：APPEND events（向 Snapshot v41 追加 10000 条新记录）

  A 在执行 MERGE 时，看到的是 Snapshot v41 的数据（B 追加的数据不可见）
  B 在追加时，与 A 的 MERGE 完全隔离（A 修改哪些文件对 B 不可见）

  提交时：
  B 先提交（v41 → v42，追加的 Manifest 加入 ManifestList）
  A 后提交：
    → 检测到 v41 被修改（现在是 v42）
    → A 的操作是 MERGE（修改现有记录）：检查 A 修改的文件是否被 B 改动过
    → B 是纯追加，没有动 A 修改的文件
    → 自动合并：A 在 v42 的基础上提交（v42 → v43），包含 A 的修改 + B 的新增
    → 成功！
```

### 3.3 与 Delta Lake 事务隔离级别的对比

[[Delta Lake]] 提供了更细粒度的事务隔离级别配置（Databricks Delta Lake 的特性）：

**Delta Lake 的三种隔离级别**：

```
Write Serializable（默认）：
  写操作之间串行化
  读操作使用 Snapshot Isolation
  → 适合大多数数仓场景（保证写操作顺序的同时允许高效读）

Serializable（最强）：
  读写操作全部串行化
  → 适合需要强一致性的场景（如金融数据）
  → 性能最差

Snapshot Isolation（最弱写隔离）：
  写操作也使用 Snapshot Isolation（允许写写并发）
  → 适合只追加场景（不允许并发覆写同一文件）
```

| 对比项 | Iceberg OCC | Delta Lake 隔离级别 |
|-------|-------------|-------------------|
| **默认隔离** | Snapshot Isolation | Write Serializable |
| **读隔离** | Snapshot | Snapshot |
| **写写并发** | OCC（冲突时重试）| 可配置（Write Serializable 或 Snapshot）|
| **配置灵活性** | 中（通过操作类型隐式决定）| 高（三种级别显式配置）|
| **多写场景** | 追加操作自动合并，覆写需重试 | 通过 `isolationLevel` 配置 |
| **Multi-Catalog 并发** | REST Catalog 统一处理 | 依赖 Delta Log 的版本号机制 |

**根本差异**：

Delta Lake 的并发控制是基于**全局版本号**（`_delta_log/00000.json`, `00001.json`...）的线性序列——任何两个并发写操作必须争夺同一个版本号，必然有一个先成功、一个后重试。这使得 Delta Lake 的并发写入是"先到先得"的串行化模型。

Iceberg 的 OCC 更细粒度——基于**操作语义**判断是否真正冲突（追加 vs 追加 = 不冲突，可以并发成功；覆写 vs 覆写同一分区 = 冲突）。这使得 Iceberg 在追加密集的场景下吞吐量更高（多个 Writer 可以并发追加而不互相阻塞）。

---

## 第 4 章 并发写入的工程实践

### 4.1 多 Writer 的正确配置

在 Spark 中配置 Iceberg 的并发写入：

```python
# 场景：多个 Spark Streaming 微批同时向同一张 Iceberg 表追加数据

# Spark Session 配置
spark = SparkSession.builder \
    .config("spark.sql.extensions",
            "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.hive_prod",
            "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.hive_prod.type", "hive") \
    .config("spark.sql.catalog.hive_prod.uri", "thrift://metastore:9083") \
    # 并发写入重试配置
    .config("spark.sql.iceberg.handle-timestamp-without-timezone", "true") \
    .getOrCreate()

# 追加写入（多个并发 Job 可以同时运行，Iceberg 自动合并）
streaming_query = spark.readStream.format("kafka") \
    .option("subscribe", "events") \
    .load() \
    .writeStream \
    .format("iceberg") \
    .option("path", "hive_prod.analytics.events") \
    .option("checkpointLocation", "s3://bucket/checkpoints/events/") \
    # Iceberg 追加写入的重试配置
    .option("fanout-enabled", "true") \  # 允许多分区并行写
    .trigger(processingTime="1 minute") \
    .start()
```

### 4.2 Row-level Delete 的并发安全性

Iceberg 1.x 引入了行级删除（Row-level Delete），通过两种 Delete File 实现：

**Position Delete File**：记录"哪个文件的哪一行需要被删除"

```
Position Delete 文件内容：
  file_path: s3://bucket/events/data/00000-abc.parquet
  pos: 1234  ← 第 1234 行被删除
  row: {...} ← 可选：被删除行的原始数据
```

**Equality Delete File**：记录"满足某个条件的行需要被删除"

```
Equality Delete 文件内容（按主键删除）：
  event_id: "ev-12345"  ← 删除这条记录
```

这两种删除文件可以与并发的追加操作安全共存——Delete File 是追加写的（不修改任何现有文件），多个并发的 Delete 操作之间也不冲突（只要它们不删除同一批文件的同一行）。

> [!info] 删除文件的合并（Compaction）
> 随着时间推移，Delete File 会积累。查询时需要将 Delete File 应用到数据文件（过滤被删除的行），当 Delete File 过多时查询性能下降。定期运行 `CALL system.rewrite_data_files(table => 'db.events')` 将 Delete File 合并到数据文件中，消除这个查询开销——这与 Hudi MoR 的 Compaction 有相似的目的，但实现机制不同。

---

## 小结

Iceberg 事务机制的设计精髓是**简单而正确**：

- **原子指针切换**：Catalog 的 CAS 操作是所有 ACID 保证的物理基础，实现极简但正确性完备
- **OCC 而非悲观锁**：追加操作自动合并，真正冲突才失败，高并发场景吞吐最优
- **Snapshot Isolation**：读操作基于固定快照，即使写操作并发进行也不影响读取一致性

与 Delta Lake 相比，Iceberg 的事务机制**不是全面超越，而是不同取舍**：Delta Lake 提供了更精细的事务隔离级别配置（3 种选项），适合对一致性要求极高的场景；Iceberg 的 OCC 在追加密集的场景下并发吞吐更高，且与多种 Catalog 后端（HMS/Glue/REST）的集成更加标准化。

下一篇 [[05 查询优化——Partition Pruning、Column Metrics 与 Row-level Delete]] 将聚焦 Iceberg 的查询端优化：多层过滤如何将"扫描 10 万个文件"压缩为"扫描 100 个文件"，以及行级删除的两种实现如何在最小化写放大的同时维持查询性能。


> [!note] 思考题
> 1. Iceberg 的事务原子性依赖 Catalog 的原子指针切换。在使用 Hive Metastore 作为 Catalog 时，这个原子更新通过 HMS 的 `alterTable` API（MySQL 中带乐观锁的 UPDATE）实现。如果 MySQL 在 `alterTable` 执行期间宕机，Iceberg 事务的原子性如何保证？MySQL 的 InnoDB 事务在这里扮演什么角色？
> 2. Iceberg 的冲突检测粒度是文件级别。两个 APPEND 操作向同一分区写入（产生新文件，不修改现有文件），它们是否冲突？Iceberg 的冲突检测逻辑是否能区分"不同分区的并发写入无冲突"和"同分区的并发 DELETE 有冲突"？
> 3. 在 Flink 持续写入 + Spark 批量 Compaction 的并发场景中，Compaction 删除了流式 Writer 正在读取的文件时，Iceberg 的 OCC 如何处理这种"读-删冲突"？是 Compaction 失败重试，还是流式 Writer 读到不一致数据？