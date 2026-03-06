---
title: "存储类型深度解析——CoW vs MoR 的设计权衡与适用场景"
date: 2026-03-02
tags: [Hudi, CoW, MoR, Copy-on-Write, Merge-on-Read, 存储类型, 性能权衡, Compaction]
aliases: ["Hudi CoW", "Hudi MoR", "Copy-on-Write vs Merge-on-Read"]
---

**摘要：**

当你创建一张 Hudi 表时，必须做的第一个架构决策是：选择 **Copy-on-Write（CoW）** 还是 **Merge-on-Read（MoR）**？这不是一个细节配置，而是影响写入吞吐量、读取延迟、存储放大率和运维复杂度的根本性架构选择。本文从文件布局的物理结构出发，深入剖析两种存储类型的写入路径、读取路径和 Compaction 机制，并给出清晰的选型决策框架。理解 CoW vs MoR 的权衡，本质上是理解**"把写放大的代价放在写入时还是读取时"**这一经典存储系统设计哲学。

---

## 第 1 章 为什么存在两种存储类型

### 1.1 数据湖 Upsert 的根本困境

在 [[Apache Hudi]] 的语境里，每次 Upsert 操作都面临一个基本困境：**Parquet 文件是不可变的（immutable）**。你无法"打开一个 Parquet 文件，找到第 1234 行，修改 status 字段，然后保存"——这在 HDFS 和 S3 的文件模型中根本不支持。

既然不能原地修改，那么对一条已存在记录的更新，只有两条路可走：

**路径 A：写入时合并（Write-Time Merge）**
> 每次更新，立刻重写包含该记录的整个 Parquet 文件，生成新版本。
> 代价集中在写入时：写放大（Write Amplification）= 更新 1 条记录，重写整个文件（可能 128MB）。
> 好处：读取时无需任何额外工作，直接读 Parquet，性能最优。

**路径 B：读取时合并（Read-Time Merge）**
> 更新只追加到一个轻量日志文件（Avro 格式），不动原始 Parquet 文件。
> 好处：写入极快（追加日志，无需重写大文件）。
> 代价集中在读取时：查询时需要将日志文件中的 delta 合并到基础 Parquet 文件上，有额外计算开销。

Hudi 的 **Copy-on-Write（CoW）** 就是路径 A，**Merge-on-Read（MoR）** 就是路径 B。它们代表了**把写放大代价安置在不同时间点**的两种截然不同的策略。

### 1.2 类比：数据库的 MVCC 也有类似权衡

这个写入时合并 vs 读取时合并的权衡，在数据库领域同样存在：

- **PostgreSQL 的 MVCC**：更新时写新版本行（类似 CoW），旧版本行保留直到 VACUUM 清理——写放大，但读取时无需合并
- **[[RocksDB]] / LevelDB（LSM-Tree）**：更新写入 MemTable，后台 Compaction 合并——类似 MoR，写入快，读取时需要合并多层 SST 文件

Hudi 把同样的权衡搬到了数据湖的文件级别。

---

## 第 2 章 Copy-on-Write（CoW）深度解析

### 2.1 文件布局

CoW 表的文件组织非常简洁，**只有 Parquet 文件，没有日志文件**：

```
表根目录/
├── .hoodie/
│   ├── 20240101.commit      ← Commit 1 元数据
│   ├── 20240102.commit      ← Commit 2 元数据
│   └── hoodie.properties
├── date=2024-01-01/
│   ├── 4c13f878-xxx_0-1_0.parquet   ← FileGroup 1，版本 0（初始写入）
│   ├── 4c13f878-xxx_0-2_0.parquet   ← FileGroup 1，版本 0（Commit 1 后新文件）
│   └── a9d4c2b1-yyy_0-1_0.parquet   ← FileGroup 2，版本 0
├── date=2024-01-02/
│   └── ...
```

Hudi 文件命名规范：`{fileId}_{writeToken}_{commitTimestamp}.parquet`

- **fileId**：全局唯一的文件组 ID（UUID），代表一个逻辑"文件槽位"
- **writeToken**：写入会话标识（用于冲突检测）
- **commitTimestamp**：生成该版本的 Commit 时间戳

**同一个 fileId 在不同 Commit 后会有多个版本文件**——这正是"Copy-on-Write"名称的由来：写入时，将受影响记录所在的旧文件完整复制一份，在新副本上合并更新，写出新版本文件。

### 2.2 写入路径详解

一次 CoW Upsert 的完整路径：

```
输入：100 万条 Upsert 记录（其中 80 万条是更新，20 万条是新插入）

Step 1：Index Lookup（索引查找）
  → 查询 Bloom Filter（或其他索引），确定每条记录的位置
  → 80 万条 UPDATE 记录映射到具体的 fileId
  → 20 万条 INSERT 记录：fileId 为 null（新记录）

Step 2：Record Tagging（记录标记）
  → 将 UPDATE 记录与其目标文件 fileId 关联

Step 3：Shuffle by FileId（按文件分组）
  → Spark shuffle：所有属于同一个 fileId 的 UPDATE 记录聚合到同一个 Executor

Step 4：File Merge（文件合并，这是 CoW 的核心代价）
  → 对每个有更新的 fileId：
    a. 读取旧 Parquet 文件（全量，哪怕只更新 1 条记录）
    b. 将旧记录与新 UPDATE 记录合并（新记录覆盖旧记录）
    c. 将合并结果写出新 Parquet 文件（新版本，带新 commitTimestamp）

Step 5：INSERT 处理
  → 20 万条新记录按文件大小（默认 128MB）分组
  → 写入全新的 Parquet 文件

Step 6：Commit
  → 在 .hoodie/ 目录写 commit 文件，记录本次新增/修改的文件列表
```

**写放大示例**：

```
假设：一个 Parquet 文件 128MB，包含 100 万条记录
本次更新：其中 1000 条记录需要更新
写放大比 = 128MB / (1000条 × 平均记录大小)
         = 128MB / (1000 × 0.1KB)
         = 128MB / 0.1MB
         = 1280x 写放大！

即：为了更新 0.1MB 的数据，重写了 128MB 的文件。
这就是 CoW 写放大的极端案例。
```

> [!warning] 写放大是 CoW 的核心代价
> 在 Upsert 频繁且更新比例高的场景（如 CDC 同步），CoW 的写放大会极其严重，既消耗大量 CPU/IO 资源，也导致写入吞吐量低。这是 MoR 出现的根本原因。

### 2.3 读取路径

CoW 表的读取是最简单的：**直接读取 Parquet 文件，无任何合并操作**。

```python
# Snapshot Query（读最新快照）
# 内部逻辑：找到每个 fileId 最新 commitTimestamp 的 Parquet 文件，直接扫描
df = spark.read.format("hudi").load("s3://bucket/trips/")
# 等价于：读取所有分区中，每个 fileId 的最新版本 Parquet 文件
```

**读取性能**：与直接读取普通 Parquet 表几乎没有区别，Parquet 的 Column Pruning、Predicate Pushdown 完全可以使用。这是 CoW 最大的优势。

### 2.4 CoW 适用场景总结

CoW 适合以下场景：

```
✅ 写入频率低，读取频率高（典型的"一次写，多次读"）
✅ 每次 Upsert 批量较大（如每天一次大批量 CDC 同步）
✅ BI 报表和 SQL 分析是主要查询模式（对查询性能要求高）
✅ 可以接受较慢的写入，但无法容忍查询时的额外合并开销

❌ 高频小批量 Upsert（写放大代价太高）
❌ 近实时数仓（写入等待时间太长，无法做到分钟级数据新鲜度）
```

---

## 第 3 章 Merge-on-Read（MoR）深度解析

### 3.1 文件布局

MoR 表的文件组织更复杂，**同时包含 Parquet 基础文件和 Avro 日志文件（.log）**：

```
表根目录/
├── .hoodie/
│   ├── 20240101120000.deltacommit   ← 增量写入（不是 .commit，是 .deltacommit）
│   ├── 20240101130000.deltacommit
│   ├── 20240101140000.compaction.requested
│   ├── 20240101140000.compaction    ← Compaction 完成
│   └── hoodie.properties
├── date=2024-01-01/
│   ├── 4c13f878-xxx_0-1_0.parquet      ← FileGroup 1 的基础 Parquet 文件
│   ├── .4c13f878-xxx_20240101120000_1.log.1   ← FileGroup 1 的增量日志（deltacommit 1）
│   ├── .4c13f878-xxx_20240101130000_1.log.2   ← FileGroup 1 的增量日志（deltacommit 2）
│   └── a9d4c2b1-yyy_0-1_0.parquet      ← FileGroup 2 的基础 Parquet 文件
```

**关键区分**：

- `.parquet` 文件：基础文件，包含某个时间点的完整压缩数据（经过 Compaction）
- `.log` 文件：增量日志文件，以 Avro 格式追加写入，每次 deltacommit 追加一段

### 3.2 写入路径详解

MoR 的写入路径比 CoW 轻得多：

```
输入：100 万条 Upsert 记录（其中 80 万条是更新，20 万条是新插入）

Step 1：Index Lookup（与 CoW 相同）
  → 80 万条 UPDATE 记录映射到具体 fileId

Step 2：Record Tagging（与 CoW 相同）

Step 3：写入日志文件（核心差异！）
  → 对每个有更新的 fileId：
    ✅ 直接将本次更新的记录（Avro 格式）追加到该 fileId 的 .log 文件末尾
    ✅ 不读取旧 Parquet 文件！不重写旧 Parquet 文件！
    → 写入速度极快（顺序追加，无读-修改-写循环）

Step 4：INSERT 处理
  → 新记录写入新 Parquet 基础文件（与 CoW 相同）

Step 5：DeltaCommit
  → 在 .hoodie/ 目录写 .deltacommit 文件（而不是 .commit）
  → 记录本次写入的日志文件信息
```

**写放大对比**：

```
同样场景：更新 128MB Parquet 文件中的 1000 条记录

CoW 写放大：
  写入量 = 128MB（整个文件重写）+ 日志文件

MoR 写放大：
  写入量 = 1000 × 0.1KB ≈ 0.1MB（只写日志）
  写放大比 = 1.0x（几乎没有写放大！）
```

### 3.3 读取路径与合并代价

MoR 的读取需要实时合并，这是它的核心代价：

```
Snapshot Query（读最新快照）内部逻辑：

对每个 FileGroup：
  1. 读取基础 Parquet 文件（经过 Compaction 的历史数据）
  2. 读取所有关联的 .log 文件（最新的增量变更）
  3. 执行 Merge：
     - 扫描 Parquet 文件中的每条记录
     - 对每条记录，检查 .log 文件中是否有更新版本（按 recordKey 匹配）
     - 如果有，用 .log 中的最新版本覆盖
     - 如果没有，直接输出 Parquet 中的版本
     - 输出 .log 中有但 Parquet 中没有的新记录（INSERT 在 log 中）

这个合并操作 = 读 Parquet + 读所有 .log + HashJoin
代价：随 .log 文件数量增多而线性增加！
```

**这就是 MoR 读取变慢的根源**：随着 deltacommit 增多，.log 文件越来越多，每次 Snapshot Query 需要合并的数据量越来越大，读取延迟线性上升。

### 3.4 Compaction：解决 MoR 读取退化的关键

**Compaction** 是 MoR 的后台异步任务，定期将积累的 .log 文件合并到基础 Parquet 文件中，生成新版本的 Parquet 文件并清空对应的 .log 文件：

```
Compaction 前（3 次 deltacommit 积累）：
  FileGroup 1:
    4c13f878.parquet         ← 基础文件（昨天的数据，128MB）
    .4c13f878.log.1          ← deltacommit 1 的增量（5MB）
    .4c13f878.log.2          ← deltacommit 2 的增量（5MB）
    .4c13f878.log.3          ← deltacommit 3 的增量（5MB）

Compaction 后：
  FileGroup 1:
    4c13f878_new.parquet     ← 新的基础文件（合并了所有 log，135MB）
    （log 文件被清理）
```

**Compaction 执行方式**（两种）：

**同步 Compaction（Inline Compaction）**：

```python
# 在每次 deltacommit 后，检查是否需要触发 Compaction
spark.write.format("hudi") \
    .option("hoodie.compact.inline", "true") \
    .option("hoodie.compact.inline.max.delta.commits", "5")  # 每 5 次 deltacommit 触发一次
    .save("s3://bucket/trips/")
```

好处：控制精确，保证 .log 文件数量不超过阈值。
代价：会暂时阻塞写入流程，写入延迟增加。

**异步 Compaction（Async Compaction）**：

```python
# 写入 Job：只写 deltacommit，不做 Compaction
# Compaction Job：独立 Spark 任务，定期（如每小时）运行

# 方案：用 HoodieMultiTableCompactor 作为独立调度任务
spark-submit com.uber.hoodie.utilities.HoodieCompactor \
    --base-path s3://bucket/trips/ \
    --table-name trips \
    --parallelism 200
```

好处：写入 Job 不受 Compaction 阻塞，写入延迟稳定。
代价：两个独立 Job 的资源调度复杂度增加。

> [!note] Compaction 间隔的选择
> Compaction 间隔越短 → .log 文件越少 → 读取越快 → 但 Compaction 本身消耗资源多
> Compaction 间隔越长 → .log 文件越多 → 读取越慢 → 但写入更高效
> 经验法则：对于每小时写入的 MoR 表，每 4-6 小时执行一次 Compaction 是合理的起点。

### 3.5 三种查询模式的对应关系

MoR 支持所有三种查询模式，不同模式读取不同的数据集：

```
Read-Optimized Query（读优化查询）：
  → 只读最新的基础 Parquet 文件，忽略所有 .log 文件
  → 数据新鲜度：上次 Compaction 时间点的数据（可能有几小时延迟）
  → 性能：最好（等同于读普通 Parquet 表）
  → 适合：对数据实时性要求不高的 BI 查询

Snapshot Query（快照查询）：
  → 读 Parquet + 合并所有 .log 文件
  → 数据新鲜度：最新（包含最近一次 deltacommit 的数据）
  → 性能：取决于 .log 文件数量
  → 适合：需要最新数据的查询

Incremental Query（增量查询）：
  → 读指定时间范围内的 deltacommit 对应文件
  → 只处理变化的数据（最高效）
  → 适合：增量 ETL 管道
```

---

## 第 4 章 CoW vs MoR 全面对比与选型决策

### 4.1 多维度量化对比

| 维度 | CoW | MoR |
|-----|-----|-----|
| **写入吞吐量** | 低（需重写整个文件）| 高（只追加日志）|
| **写入延迟** | 高（同步重写文件）| 低（异步追加）|
| **读取性能（Snapshot）** | 高（直接读 Parquet）| 中（需合并 .log）|
| **读取性能（Read-Optimized）** | 不适用 | 高（只读 Parquet）|
| **数据新鲜度** | 中（每次 Commit 后更新）| 高（deltacommit 即可见）|
| **存储放大** | 中（旧文件保留到 Clean）| 低（log 文件写放大小）|
| **运维复杂度** | 低（无 Compaction）| 高（需调度 Compaction）|
| **Schema Evolution** | 支持 | 支持（略复杂）|
| **小文件问题** | 无（每次 Commit 重写，文件大小可控）| 有（.log 文件可能碎片化）|

### 4.2 选型决策框架

```
问题 1：你的写入是否对延迟敏感？
  是（需要分钟级数据新鲜度）→ MoR
  否（小时级 / 天级即可）→ CoW 或 MoR 均可

问题 2：写入更新比例是多少？
  高更新比例（> 30%，典型 CDC）→ MoR（避免 CoW 的写放大）
  低更新比例（< 10%，主要是插入）→ CoW 更简单

问题 3：读写比例是怎样的？
  读多写少（如数仓查询）→ CoW（读性能最优）
  写多读少（如数据摄入管道）→ MoR

问题 4：是否有额外的运维能力支持 Compaction 调度？
  有→ MoR
  无（希望尽量简单）→ CoW

典型场景映射：
  实时 CDC 摄入（每分钟写入）→ MoR
  每日批量同步（每天一次大批量）→ CoW
  近实时数仓（每 15 分钟写入，分析师查询）→ MoR + 高频 Compaction
  数据质量订正（偶发少量更新）→ CoW
```

### 4.3 与 Delta Lake 存储模型的对比

理解 CoW/MoR 后，可以更清晰地看到 Hudi 与 [[Delta Lake]] 的存储层差异：

**Delta Lake 只有一种存储模型**，类似 Hudi 的 CoW，但有重要差异：

- Delta Lake 的 UPDATE/DELETE 默认也是重写 Parquet 文件（类似 CoW），但通过 **Deletion Vectors**（Delta Lake 2.x+）可以只标记删除，延迟实际重写
- Delta Lake 没有类似 MoR 的日志文件追加机制，所有更改最终都是 Parquet 文件重写
- Delta Lake 的流式写入（Structured Streaming）通过高频 Commit 实现低延迟，而不是通过日志追加

这意味着：**在高频小批量 Upsert 场景，MoR Hudi 的写入效率远优于 Delta Lake**，而在查询密集的批量分析场景，两者性能接近（CoW Hudi ≈ Delta Lake）。

---

## 小结

CoW 与 MoR 的选择本质上是**将写放大代价放在写入时（CoW）还是读取时（MoR）**的权衡：

- **CoW**：写慢读快，运维简单，适合写少读多的批量分析场景
- **MoR**：写快读稍慢，运维复杂（需要 Compaction 调度），适合高频 CDC 摄入和近实时数仓

下一篇 [[03 Timeline 机制——Hudi 事务与增量语义的核心]] 将深入 Timeline 的完整状态机，包括各 Action 的状态转移规则、并发控制机制，以及 Hudi 如何在分布式环境下保证跨 Executor 的 Commit 原子性。


> [!note] 思考题
> 1. MoR 表将更新写入增量日志（Avro Log 文件），查询时实时合并。Log 文件数量会随时间增长直到 Compaction 清除。在写入频率极高（每秒数千次 Upsert）场景下，如果 Compaction 追不上写入速度，查询性能会如何退化？有没有机制动态调整 Compaction 触发频率？
> 2. 在同一个工作负载下（写入 QPS、查询 QPS、更新与插入比例已知），如何量化 CoW 和 MoR 两种存储类型的总体 I/O 成本？有没有"临界点"——在什么参数组合下，两者的总体代价相等？
> 3. 如果查询引擎（如某版本的 Presto）不支持 Hudi 的 MoR 读路径，只能读取 Parquet Base 文件（未合并 Log），读到的是旧数据。在业务依赖最新数据做决策的场景下，这种"引擎只读 CoW 视图"的行为有多危险？如何在运维层面防范这种静默的数据滞后？