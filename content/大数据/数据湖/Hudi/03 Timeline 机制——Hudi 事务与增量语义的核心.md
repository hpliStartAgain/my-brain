---
title: "Timeline 机制——Hudi 事务与增量语义的核心"
date: 2026-03-02
tags: [ACID, Commit, Compaction, Hudi, Rollback, Timeline, 事务, 增量语义, 状态机]
aliases: ["Hudi Timeline", "Hudi事务机制", "Hudi增量语义", "Timeline状态机"]
---

**摘要：**

**Timeline** 是 Apache Hudi 区别于所有其他数据湖方案的核心架构创新。它不仅仅是一个事务日志（[[Delta Lake]] 的 `_delta_log` 也是事务日志），更是一个**全局有序的操作历史记录**，赋予了 Hudi 独特的**增量消费语义**——下游系统可以精确查询"在时间 T1 到 T2 之间，哪些记录发生了变化"。本文深入解析 Timeline 的文件结构、五种 Action 类型、三阶段提交协议的状态转移、并发写入的冲突处理，以及 Timeline 如何从底层支撑 Snapshot Query 和 Incremental Query 两种读取模式。理解 Timeline 是理解 Hudi 一切行为的关键——它既是事务保证的基础，也是增量语义的承载者。

---

## 第 1 章 为什么 Timeline 是 Hudi 的核心

### 1.1 Delta Log vs Timeline：同为日志，设计目标不同

[[Delta Lake]] 也有类似的事务日志机制——`_delta_log/` 目录下的 JSON 文件记录每次操作。那么 Hudi 的 Timeline 有什么本质不同？

答案在于两者的**设计目标优先级**不同：

```
Delta Log 的设计目标（按优先级）：
  1. 快照一致性（给我版本 N 的完整文件列表）
  2. ACID 事务保证（并发写入的冲突检测）
  3. 时间旅行（回退到历史版本）

Timeline 的设计目标（按优先级）：
  1. 增量消费语义（给我 T1~T2 之间变更的文件列表）
  2. 操作原子性（Commit 要么全成功要么全回滚）
  3. 多 Action 类型的协同（Commit、Compaction、Clean 如何并发执行不互相干扰）
```

这个目标差异体现在：

- **Delta Log** 存储的是文件级 `Add`/`Remove` Action，侧重于"文件版本管理"
- **Timeline** 存储的是操作级事件，侧重于"操作历史可查询"，且每个事件记录了操作影响的**全部文件及其统计信息**，使得增量查询可以精确知道哪些记录变了

### 1.2 Timeline 的位置与初始化

Timeline 物理上存储在表根目录的 `.hoodie/` 目录：

```bash
# 查看一张 Hudi 表的 Timeline
hdfs dfs -ls s3://my-bucket/trips/.hoodie/

# 典型输出：
# 20240101120000000.commit.requested     ← 写入开始（REQUESTED）
# 20240101120000000.commit               ← 写入完成（COMPLETED）
# 20240101130000000.commit.requested
# 20240101130000000.commit.inflight      ← 写入进行中（INFLIGHT）
# 20240101140000000.compaction.requested
# 20240101140000000.compaction           ← Compaction 完成
# 20240101100000000.clean                ← 清理完成
# hoodie.properties                      ← 表级配置
# .aux/                                  ← 辅助目录（存储 REQUESTED 阶段的计划文件）
# metadata/                              ← 元数据表（Metadata Table，可选）
```

表在首次写入时由 `HoodieTableMetaClient.initTableAndGetMetaClient()` 初始化，创建 `.hoodie/` 目录并写入 `hoodie.properties`：

```properties
# hoodie.properties 核心内容
hoodie.table.name=trips
hoodie.table.type=MERGE_ON_READ       # 或 COPY_ON_WRITE
hoodie.table.version=6                # 表格式版本号
hoodie.archivelog.folder=archived     # 已归档的 Timeline 目录
hoodie.timeline.layout.version=1      # Timeline 文件布局版本
hoodie.record.key.fields=trip_id      # 主键字段
hoodie.partition.fields=date          # 分区字段
hoodie.populate.meta.fields=true      # 是否写入 Hudi 元字段（_hoodie_commit_time 等）
```

---

## 第 2 章 Timeline 的状态机

### 2.1 三种状态（State）

Timeline 中每个 Action 都有且只能处于三种状态之一，对应三种文件后缀：

```
REQUESTED → INFLIGHT → COMPLETED

文件后缀对应：
  .action.requested  ← REQUESTED 状态
  .action.inflight   ← INFLIGHT 状态
  .action            ← COMPLETED 状态（无额外后缀）

例子：
  20240101120000000.commit.requested   ← Commit 操作已计划，尚未开始
  20240101120000000.commit.inflight    ← Commit 正在执行中
  20240101120000000.commit             ← Commit 已完成，对读者可见
```

**为什么需要三个阶段，两个（INFLIGHT + COMPLETED）不够吗？**

REQUESTED 阶段的引入是为了解决**两个独立 Job 并发写同一张表**的问题。当 Job A 和 Job B 同时想要 Commit，它们各自在 REQUESTED 阶段先"占位"——在分布式文件系统上创建一个 `.requested` 文件是原子操作。Hudi 通过检查 REQUESTED 文件的存在，可以在 INFLIGHT 阶段进行冲突检测（判断 Job B 的写入是否与 Job A 的写入产生了文件覆盖冲突），而不是等到写完数据之后才发现冲突——这节省了大量无效的数据写入开销。

### 2.2 五种 Action 类型

| Action | Timeline 文件名格式 | 触发时机 | 核心作用 |
|--------|------------------|---------|---------|
| `commit` | `{timestamp}.commit` | CoW 表的 Upsert/Insert/Delete 完成 | 记录本次写入的文件列表和统计信息 |
| `deltacommit` | `{timestamp}.deltacommit` | MoR 表的增量写入完成 | 记录本次写入的日志文件信息 |
| `compaction` | `{timestamp}.compaction` | MoR 表的 Compaction 任务完成 | 记录日志文件合并到 Parquet 的结果 |
| `clean` | `{timestamp}.clean` | 清理超出版本保留数的旧文件 | 记录被删除的文件列表（用于审计）|
| `rollback` | `{timestamp}.rollback` | Commit/DeltaCommit 失败后回滚 | 记录被回滚（删除）的文件列表 |
| `savepoint` | `{timestamp}.savepoint` | 用户手动创建保存点 | 阻止 Clean 删除该版本，类似 Tag |
| `indexing` | `{timestamp}.indexing` | Record-Level Index 构建 | Hudi 1.x 新增，元数据索引管理 |

> [!info] commit vs deltacommit 的区分
> `commit` 用于 CoW 表，因为每次写入都会产生新的 Parquet 文件（真正的"提交"了一个新的文件版本）。`deltacommit` 用于 MoR 表，它只提交了增量日志文件，还没有合并到 Parquet——这个区分帮助读取引擎知道是否需要做日志合并。

### 2.3 Commit 的完整状态转移

以一次 CoW 表的 Upsert 为例，展示三阶段提交的完整生命周期：

```
阶段 1：REQUESTED（计划阶段）
───────────────────────────
时机：HoodieWriteClient.startCommit() 被调用时
操作：
  1. 生成 commitTimestamp（精度到毫秒，格式 yyyyMMddHHmmssSSS）
  2. 在 .hoodie/ 目录创建 {timestamp}.commit.requested 文件
     文件内容：JSON，包含 schema 信息和写入操作类型（UPSERT/INSERT）
  3. 同时在 .hoodie/.aux/requests/ 创建辅助文件（记录写入计划详情）

目的：
  - "抢占"这个 timestamp，防止其他 Writer 使用相同 timestamp
  - 为后续的冲突检测提供基础（已有哪些 REQUESTED 操作）

─────────────────────────────────────
阶段 2：INFLIGHT（执行阶段）
─────────────────────────────────────
时机：Executor 开始实际写入数据文件时
操作：
  1. 将 {timestamp}.commit.requested 重命名为 {timestamp}.commit.inflight
     （HDFS 的 rename 是原子操作）
  2. Executor 开始：
     a. 执行 Index Lookup（查找记录所在文件）
     b. Shuffle 数据（按 fileId 分组）
     c. 写入新版本的 Parquet 文件（CoW 场景）
  3. 如果 Driver 在此阶段崩溃：
     → .inflight 文件残留，.commit 文件不存在
     → 下次 startCommit() 时会检测到孤立的 inflight 并触发 Rollback

─────────────────────────────────────
阶段 3：COMPLETED（提交阶段）
─────────────────────────────────────
时机：所有数据文件写入完成，Driver 汇总写入结果时
操作：
  1. 创建 {timestamp}.commit 文件（这是最终的元数据文件）
     文件内容：JSON，记录本次写入的详细信息
  2. 删除 {timestamp}.commit.inflight 文件

{timestamp}.commit 文件内容示例：
{
  "partitionToWriteStats": {
    "date=2024-01-01": [
      {
        "fileId": "4c13f878-xxxx",
        "path": "date=2024-01-01/4c13f878-xxxx_0-1_20240101120000.parquet",
        "prevCommit": "20240101110000",          ← 被替换的旧文件版本
        "numWrites": 987654,                     ← 本次写入的记录数
        "numUpdateWrites": 823456,               ← 其中更新的记录数
        "numInserts": 164198,                    ← 其中新插入的记录数
        "numDeletes": 0,
        "totalWriteBytes": 134217728,            ← 写入字节数（128MB）
        "totalRecordsWritten": 987654,
        "minEventTime": "2024-01-01T12:00:00",   ← 本次写入记录的最小业务时间
        "maxEventTime": "2024-01-01T12:59:59",   ← 最大业务时间
        "columnStats": { ... }                   ← 列级统计信息（用于 Data Skipping）
      }
    ]
  },
  "commitTime": "20240101120000000",
  "operationType": "UPSERT",
  "extraMetadata": {}
}
```

---

## 第 3 章 Timeline 的并发控制

### 3.1 Hudi 的并发模式

Hudi 支持三种并发写入模式，对应不同的冲突处理策略：

**模式 1：单 Writer（SINGLE_WRITER）**

最简单也最常见的模式，同一时间只有一个 Spark 任务在写表。这在大多数批处理场景下已经足够——流式写入 Job 每分钟 Commit 一次，Compaction Job 独立运行，两者通过 REQUESTED 阶段的文件检测来避免冲突。

**模式 2：多 Writer（MULTI_WRITER）**

多个独立的 Spark Job 同时写入同一张表（如：5 个并行的数据摄入 Job 各负责一个业务域）。Hudi 使用**乐观并发控制（OCC）**检测冲突：

```
冲突检测逻辑（发生在 INFLIGHT → COMPLETED 的转换时）：

当前 Writer 的 Commit 要完成时：
  1. 读取 Timeline，找到在 "我的 REQUESTED 时间点" 之后已经 COMPLETED 的其他 Commit
  2. 检查这些 Commit 是否修改了 "我也修改过的文件"
     → 文件级冲突检测（不是记录级！）
  3. 如果有冲突：当前 Commit 失败，需要重试
  4. 如果无冲突：正常提交

冲突场景示例：
  Job A（timestamp=10:00）和 Job B（timestamp=10:01）同时写分区 date=2024-01-01
  Job A 先完成：fileId=xxx_0.parquet 被替换为 xxx_10:00.parquet
  Job B 也要修改 fileId=xxx_0.parquet（同一个文件！）
  → Job B 在提交时检测到冲突，失败并重试

注意：如果 Job A 和 Job B 写的是不同分区（不同文件），不会有冲突！
```

**模式 3：乐观并发 + 协调服务（基于 ZooKeeper 或 HiveMetastore 锁）**

```python
# 启用基于 ZooKeeper 的分布式锁（用于 Hudi 0.8+ 的多写场景）
spark.write.format("hudi") \
    .option("hoodie.write.concurrency.mode", "OPTIMISTIC_CONCURRENCY_CONTROL") \
    .option("hoodie.cleaner.policy.failed.writes", "LAZY") \
    .option("hoodie.write.lock.provider",
            "org.apache.hudi.client.transaction.lock.ZookeeperBasedLockProvider") \
    .option("hoodie.write.lock.zookeeper.url", "zk-host:2181") \
    .option("hoodie.write.lock.zookeeper.base.path", "/hudi-locks") \
    .save("s3://bucket/trips/")
```

### 3.2 Rollback 机制

当一个 INFLIGHT 的操作被检测到（下次启动时），Hudi 会执行 Rollback：

```
Rollback 流程：

1. 检测孤立的 INFLIGHT 操作
   → HoodieWriteClient 在启动时调用 rollbackInflightCommits()
   → 扫描 .hoodie/ 目录，找到所有 .inflight 文件

2. 确定需要删除的数据文件
   → 读取 .inflight 文件的内容（包含本次写入的文件列表）
   → 如果 .inflight 文件是空的（REQUESTED 阶段崩溃），则无数据文件需要删除

3. 删除数据文件
   → 删除本次写入生成的所有 .parquet 或 .log 文件

4. 删除 .inflight 文件
   → Timeline 恢复到干净状态

5. 写入 Rollback 记录
   → 创建 {new_timestamp}.rollback 文件
   → 记录被回滚的操作 timestamp 和删除的文件列表（用于审计）
```

> [!warning] 与 Delta Lake Rollback 的差异
> Delta Lake 的 Rollback 是"不写"——失败的事务不会写入事务日志，所以没有需要清理的"中间状态"（通过乐观锁和原子写 JSON 文件保证）。
> Hudi 的 Rollback 是"主动清理"——因为数据文件已经写了一部分，需要主动删除，这使得 Hudi 的故障恢复逻辑更复杂，但也使它能更好地处理大规模分布式写入中的部分失败场景。

---

## 第 4 章 Timeline 如何驱动两种读取模式

### 4.1 Snapshot Query 的文件解析逻辑

读取器在执行 Snapshot Query 时，需要回答的问题是：**"当前时刻，每个分区每个 FileGroup 的最新文件版本是哪个？"**

```python
# Timeline-based 文件解析（简化逻辑）
def resolve_latest_files(table_path, as_of_timestamp=None):
    timeline = read_timeline(table_path + "/.hoodie/")

    # 只看 COMPLETED 的 Commit（排除 INFLIGHT 和 REQUESTED）
    completed_commits = [
        c for c in timeline
        if c.state == "COMPLETED"
        and c.action in ("commit", "deltacommit", "compaction")
        and (as_of_timestamp is None or c.timestamp <= as_of_timestamp)
    ]

    # 按时间倒序遍历，为每个 fileId 找到最新版本
    file_versions = {}  # fileId → 最新文件路径
    for commit in sorted(completed_commits, reverse=True):
        for partition, stats in commit.partitionToWriteStats.items():
            for stat in stats:
                fid = stat["fileId"]
                if fid not in file_versions:
                    file_versions[fid] = stat["path"]  # 记录最新版本
                # 如果 fileId 已经找到更新的版本，旧版本忽略

    return list(file_versions.values())
```

这里有一个关键点：**Timeline 决定了哪些文件"有效"（可见），这是数据一致性的来源**。一个正在写入但尚未 Commit 的文件，即使已经存在于 HDFS 上，也不会被 Snapshot Query 看到——因为它对应的 Commit 还是 INFLIGHT 状态。

### 4.2 Incremental Query 的时间范围解析

增量查询的文件解析逻辑相对简单，利用了 Timeline 的有序性：

```python
def resolve_incremental_files(table_path, begin_time, end_time):
    timeline = read_timeline(table_path + "/.hoodie/")

    # 找到 begin_time ~ end_time 之间的所有 COMPLETED Commit
    incremental_commits = [
        c for c in timeline
        if c.state == "COMPLETED"
        and c.action in ("commit", "deltacommit")
        and begin_time < c.timestamp <= end_time
    ]

    # 汇总这些 Commit 影响的文件（可能有重叠，取最新版本）
    affected_files = set()
    for commit in incremental_commits:
        for partition, stats in commit.partitionToWriteStats.items():
            for stat in stats:
                affected_files.add(stat["path"])

    return list(affected_files)
```

然后在 SQL 层面，增量查询还会加一个谓词过滤器：

```sql
-- 自动添加的谓词（用户看不到，Hudi 内部注入）
SELECT * FROM trips_incremental
WHERE _hoodie_commit_time > '20240101120000000'
  AND _hoodie_commit_time <= '20240101130000000'
```

`_hoodie_commit_time` 是 Hudi 在每条记录上自动写入的元字段，记录该记录最后一次被写入的 Commit 时间戳。这使得即使多个 Commit 影响了同一个文件，也能从文件内部精确过滤出在时间范围内的记录。

### 4.3 Archive：Timeline 的历史归档

Timeline 不能无限增长（否则每次读取 `.hoodie/` 目录都要扫描海量文件）。Hudi 有一个 **Archive** 机制，定期将超出保留窗口的 Commit 元数据归档到 `.hoodie/archived/` 目录下的 Avro 文件中：

```
Timeline 文件数量管理：
  hoodie.keep.min.commits = 20   ← 保留最近 20 个 Commit 的文件在 .hoodie/ 目录
  hoodie.keep.max.commits = 30   ← 超过 30 个时触发 Archive，将旧的移到 archived/

Archive 后的结构：
  .hoodie/
    最近 20-30 个操作的文件（仍在 .hoodie/ 根目录）
    archived/
      .commits_.archive.1_1-0-1.avro   ← 归档的历史 Commit 元数据
      .commits_.archive.2_1-0-1.avro
```

> [!warning] Archive 对增量查询的影响
> 如果增量查询的 begin_time 对应的 Commit 已经被 Archive，Hudi 会从 archived/ 目录读取元数据，但性能会下降（需要解析 Avro 格式的归档文件）。因此，增量消费的 Checkpoint 不应该落后太多——通常建议 begin_time 不早于 48 小时前。

---

## 第 5 章 Timeline vs Delta Log 核心对比

经过深度解析，可以做一个精准的对比：

| 维度 | Hudi Timeline | Delta Lake `_delta_log` |
|-----|--------------|------------------------|
| **文件格式** | 每个 Action 对应独立文件（大量小文件）| 顺序编号的 JSON 文件（`00000.json`、`00001.json`）|
| **并发控制** | 基于文件创建原子性 + OCC | 基于事务日志顺序写 + OCC |
| **冲突粒度** | 文件级（同一 fileId 冲突）| 文件级（同一 Parquet 路径冲突）|
| **增量查询** | 原生支持（核心设计目标）| 通过 CDF（Change Data Feed）支持，非原生 |
| **多 Action 协同** | Commit、Compaction、Clean 可并发（不同 Action 类型不互斥）| 所有操作串行化（通过事务日志版本号）|
| **状态机** | 三状态（REQUESTED/INFLIGHT/COMPLETED）| 两状态（提交/未提交）|
| **归档机制** | Archive 到 Avro 格式 | 自动 Checkpoint（将 N 个 JSON 合并为 Parquet）|
| **故障恢复** | 主动 Rollback（删除已写数据文件）| 幂等重试（未完成的操作不可见，无需清理）|

---

## 小结

Timeline 是 Hudi 的"神经中枢"——它的三阶段提交保证了写入的原子性，它的全序事件日志赋予了增量消费的语义，它的 Action 状态机使 Commit、Compaction、Clean 三类任务可以在分布式环境下协同运行而互不干扰。

理解 Timeline 后，下一篇 [[04 Upsert 写入路径——Index 机制、HoodieKey 与 Bucket Index]] 将聚焦 Upsert 的"第一步"——如何利用索引在海量数据中精准定位每条更新记录的存储位置。这是 Hudi 相比 Delta Lake 最核心的工程差异，也是 Hudi 能高效处理 CDC 更新的根本原因。


> [!note] 思考题
> 1. Hudi Timeline 的 INFLIGHT 状态对应 Writer 正在执行的事务。如果 Writer 在 INFLIGHT 阶段崩溃（写了部分数据但未完成 Commit），其他 Writer 或 Rollback 进程如何检测这个"孤儿 INFLIGHT"并清理？`HoodieCleanService` 和 `HoodieRollbackCommand` 各扮演什么角色？
> 2. Hudi 的 Multi-Writer 并发写入依赖乐观并发控制和文件系统的 `create-if-not-exists` 原子操作。在 S3 上，这个操作是否真正原子？在什么条件下，Hudi 的 Multi-Writer 模式可能产生数据不一致？
> 3. Timeline 的 Instant Time 格式依赖机器时钟（`yyyyMMddHHmmssSSS`）。如果两台 Spark 作业所在机器时钟不同步，可能产生"时钟回退"问题，破坏 Timeline 的时序顺序。Hudi 有没有机制检测和处理这种时钟不同步问题？