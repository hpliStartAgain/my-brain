---
title: "RDD Checkpoint：截断 Lineage 的工程权衡"
date: 2026-02-28
tags: [Spark, RDD, Checkpoint, Lineage, 容错, 迭代算法, HDFS, localCheckpoint, persist]
aliases: []
---

# 03 RDD Checkpoint：截断 Lineage 的工程权衡

## 摘要

Lineage 容错在 Lineage 链短、输入可重放的场景下几乎是完美的。但当 Lineage 链极长（如机器学习的百次迭代训练）、或 Shuffle 前的计算极其昂贵（重算代价与整个作业相当）时，纯 Lineage 容错就会从"免费"变成"极贵"。RDD Checkpoint 是对 Lineage 容错的核心补充：它将一个 RDD 的数据物化到**可靠外部存储（通常是 HDFS）**，然后截断该 RDD 的 Lineage——从 Checkpoint 点往后的 RDD 只需要知道"数据在 HDFS 的哪个路径"，不再需要追溯到数据源。这相当于在 Lineage 链中插入了一个"保存点"，将容错的重算代价从"从头到尾"缩减为"从最近保存点到当前位置"。本文系统讲解 Checkpoint 的实现机制（可靠 Checkpoint vs 本地 Checkpoint）、与 `persist/cache` 的本质区别、何时 Checkpoint 以及如何正确使用，以及 Checkpoint 引入的新代价与工程权衡。

---

## 第 1 章 Lineage 容错的边界：何时 Lineage 还不够

### 1.1 迭代算法：Lineage 无限增长的陷阱

机器学习算法（如梯度下降训练、ALS 矩阵分解、PageRank）的一个共同特征是**迭代**：从一个初始状态出发，反复执行相同的计算步骤，每步的输出作为下一步的输入，直到收敛。

在 Spark 中，每次迭代通常会产生若干个新的 RDD（对上一次迭代的 RDD 做 `map`、`join` 等操作）。经过 100 次迭代后，最终的 RDD 的 Lineage 可能包含数百个 RDD 节点，形成一条极长的依赖链。

**问题出在哪里？**

假设一个 PageRank 算法经过 50 次迭代，第 50 次迭代产生的 RDD（记为 `R50`）的 Lineage 回溯到：

```
R50 ← R49 ← R48 ← ... ← R1 ← R0 ← 原始图数据（HDFS）
```

如果在第 50 次迭代运行时，某个节点宕机，`R49` 的某个分区需要重算。Spark 会从 Lineage 追溯，发现需要重算 `R49` 的该分区，而 `R49` 又需要 `R48`……以此类推，可能一直追溯到 `R0`，重算整条 49 次迭代的计算链。

重算代价：原本只需要几分钟的故障恢复，变成了重跑 49 次迭代——相当于重跑了大半个作业。

更严重的是，Lineage 链的增长对 Driver 内存也有影响：每个 RDD 对象（包含其依赖关系和计算函数的引用）都占用 Driver 的堆内存。1000 次迭代后，Driver 可能因为维护过长的 Lineage 链而 OOM。

### 1.2 宽依赖前的高代价计算

对于包含多个 Shuffle Stage 的 ETL 作业，如果靠后的 Shuffle Stage 发生故障，按照 Stage 回滚机制，需要重跑失败的 Map Stage。

但问题在于：如果这个 Map Stage 本身也有很长的 Lineage（它是多个算子作用后的结果），重跑它需要从更上游的数据重新计算。整个链路下来，恢复一次故障的代价可能等于作业总计算量的 30-50%。

**结论**：Lineage 容错在以下两类场景下，恢复代价会超出可接受范围：
1. **Lineage 深度超过 20 个 Stage**（通常是迭代算法场景）
2. **包含高代价 Shuffle 前的长计算链**（每次 Stage 回滚代价巨大）

这两类场景都需要 Checkpoint 来截断 Lineage，降低恢复代价。

---

## 第 2 章 RDD Checkpoint 的工作原理

### 2.1 可靠 Checkpoint 的完整生命周期

**可靠 Checkpoint**（Reliable Checkpoint）将 RDD 数据写入可靠的外部存储（通常是 [[HDFS]]），是 Checkpoint 的标准形式。其生命周期分为三个阶段：

**阶段一：标记（Mark）**

调用 `rdd.checkpoint()` 时，Spark 并不立即执行任何实际操作，只是在 RDD 对象上设置一个标记，表示"这个 RDD 需要被 Checkpoint"：

```scala
// 用户代码
sc.setCheckpointDir("hdfs://nameservice/spark-checkpoints/job-001")
val model = computeIteratively(data, iterations = 100)
model.checkpoint()  // 仅标记，不执行写入

// 然后触发 Action
model.count()       // 真正触发 Checkpoint 写入
```

注意：`checkpoint()` 必须在 Action 之前调用，因为 Checkpoint 写入发生在 Action 触发的计算过程中。

**阶段二：写入（Materialize）**

当 Action 触发计算时，`DAGScheduler` 检测到 Lineage 中有被标记为 Checkpoint 的 RDD，会在该 RDD 的计算完成后，将其数据序列化并写入 HDFS（`checkpointDir/rdd-{id}/part-{partitionId}`）。

**写入的触发机制**：在 `DAGScheduler.submitStage()` 中，对于 Lineage 中标记了 Checkpoint 的 RDD，Spark 会在对应的 Stage 完成后，**立即提交一个额外的 CheckpointRDD Stage** 来执行实际的写入工作。这个额外的 Stage 会读取刚完成计算的 RDD 数据，序列化后写到 HDFS。

**阶段三：截断 Lineage（Truncate）**

Checkpoint 数据写入成功后，Spark 调用 `rdd.markCheckpointed()`，将这个 RDD 的 `dependencies` 替换为一个 `CheckpointRDD`（指向 HDFS 上的 Checkpoint 文件路径）。原来的父 RDD 引用链被彻底切断——从此这个 RDD 的 Lineage 只有一个节点：HDFS 上的文件。

```
Checkpoint 前的 Lineage：
model(R100) ← R99 ← ... ← R1 ← R0 ← HDFS原始数据

Checkpoint 后的 Lineage（对 R50 做了 Checkpoint）：
model(R100) ← R99 ← ... ← R51 ← CheckpointRDD(HDFS: .../rdd-50/)
                                  （R50 之前的所有依赖被切断）
```

**Lineage 截断对 GC 的意义**：`R1 ~ R49` 的 RDD 对象以及它们持有的函数闭包（包含对用户数据的引用）都可以被 JVM GC 回收，Driver 的内存占用显著下降。在长迭代场景中，这对防止 Driver OOM 至关重要。

### 2.2 Checkpoint 的存储格式

Checkpoint 数据以 Partition 为单位写入 HDFS，每个 Partition 对应一个文件：

```
hdfs://nameservice/spark-checkpoints/job-001/
  └── rdd-42/
        ├── part-00000    （Partition 0 的序列化数据）
        ├── part-00001    （Partition 1 的序列化数据）
        ├── part-00002
        └── ...
```

写入格式是 Spark 内部的对象序列化格式（使用配置的 `spark.serializer`，Kryo 或 Java 序列化），**不是** Parquet、ORC 等列式格式，也不是 CSV/JSON 等文本格式。这意味着 Checkpoint 文件只能被 Spark 本身读取，不能被其他工具（如 Hive、Presto）直接访问。

### 2.3 CheckpointRDD：读取 Checkpoint 的入口

Lineage 截断后，原来被 Checkpoint 的 RDD 被替换为 `CheckpointRDD`（`ReliableCheckpointRDD` 或 `LocalCheckpointRDD`）。这个特殊的 RDD 的 `compute()` 方法不执行任何转换逻辑，而是直接从 HDFS 路径读取序列化数据并反序列化，返回原始数据：

```scala
// ReliableCheckpointRDD.compute 的核心逻辑（简化）
override def compute(split: Partition, context: TaskContext): Iterator[T] = {
  val file = new Path(checkpointPath, ReliableCheckpointRDD.checkpointFileName(split.index))
  val env = SparkEnv.get
  val fs = file.getFileSystem(sc.hadoopConfiguration)
  // 从 HDFS 打开文件，反序列化读取
  val in = fs.open(file)
  val serializer = env.serializer.newInstance()
  serializer.deserializeStream(in).asIterator.asInstanceOf[Iterator[T]]
}
```

这个设计保证了 Checkpoint 的透明性：上游 RDD 无论是通过 Lineage 重算得到，还是从 HDFS Checkpoint 读取，对下游 RDD 来说完全等价。

---

## 第 3 章 本地 Checkpoint：速度优先的轻量级方案

### 3.1 本地 Checkpoint 是什么

**本地 Checkpoint**（Local Checkpoint，`rdd.localCheckpoint()`）是 Spark 1.6 引入的一种轻量级 Checkpoint 变体，它将 RDD 数据持久化到 **Executor 的本地磁盘**（`spark.local.dir` 目录），而不是 HDFS。

从效果上看，本地 Checkpoint 同样会截断 Lineage——Checkpoint 后的 RDD 不再追溯其祖先。但存储位置从可靠的 HDFS 变成了不可靠的本地磁盘。

**本地 Checkpoint 的本质**：它是 `persist(StorageLevel.DISK_ONLY)` + Lineage 截断的组合。

```scala
// 本地 Checkpoint 的用法
rdd.localCheckpoint()
rdd.count()  // 触发计算，数据写入 Executor 本地磁盘，Lineage 被截断
```

### 3.2 本地 Checkpoint vs 可靠 Checkpoint vs persist

三者的核心区别：

| 维度 | `persist/cache` | `localCheckpoint` | 可靠 `checkpoint` |
|------|----------------|-------------------|-----------------|
| **存储位置** | Executor 内存 / 本地磁盘 | Executor 本地磁盘 | HDFS（外部可靠存储） |
| **是否截断 Lineage** | ❌ 否 | ✅ 是 | ✅ 是 |
| **是否需要 setCheckpointDir** | ❌ 否 | ❌ 否 | ✅ 是 |
| **Executor 宕机后数据是否存活** | ❌ 否 | ❌ 否 | ✅ 是 |
| **Driver 重启后是否可用** | ❌ 否 | ❌ 否 | ✅ 是 |
| **写入速度** | 最快（内存）/ 快（本地磁盘） | 快（本地磁盘） | 慢（HDFS 网络传输） |
| **主要用途** | 多次 Action 复用、提升性能 | 截断 Lineage 降低 Driver 内存 | 可靠容错、Driver 崩溃恢复 |

**关键结论**：
- `persist` 不截断 Lineage，用于**性能优化**（避免重复计算），不用于容错
- `localCheckpoint` 截断 Lineage 但不可靠，适合**降低 Driver 内存开销**（无需 HDFS 可靠性时）
- 可靠 `checkpoint` 截断 Lineage 且数据持久，适合**真正的容错场景**（Driver 崩溃恢复、长迭代训练）

### 3.3 本地 Checkpoint 的适用场景与风险

**适用场景**：
- 长迭代 ML 训练，主要目的是**防止 Driver OOM**（Lineage 链过长导致内存泄漏），而不是要求在 Executor 宕机后精确恢复
- 作业运行在稳定集群上（Executor 很少宕机），Lineage 截断的主要目的是**减少 GC 压力**和 Lineage 追溯的计算开销，而非真正的数据保护

**风险**：
如果使用本地 Checkpoint 后，Executor 宕机，该 Executor 上的本地 Checkpoint 数据丢失，且 Lineage 已被截断，无法重算。此时 Spark 会抛出 `SparkException: Failed to get broadcast_X or SparkException: Missing an output location for shuffle X`，作业失败。

> [!warning] 生产避坑
> **不要在需要高可靠容错的场景下使用 `localCheckpoint`**。如果集群使用 Spot 实例（Executor 随时被回收），或者作业运行时间极长（故障概率高），请使用可靠 `checkpoint` 到 HDFS。`localCheckpoint` 的 Lineage 截断特性会成为陷阱：截断后发生 Executor 宕机，不仅数据丢失，连重算的能力也没有了。

---

## 第 4 章 Checkpoint 的代价：写入开销与二次计算

### 4.1 Checkpoint 的写入开销

可靠 Checkpoint 的最大代价是**额外的写入开销**：

**代价一：RDD 被计算两次**

这是 Checkpoint 最常被忽视的代价。回顾 Checkpoint 的工作流程：

1. Action 触发 RDD 的计算，数据在 Executor 内存中产生
2. Checkpoint 写入阶段：从 Executor 内存中读取数据，序列化后写入 HDFS

问题在于：步骤 1 中产生的数据如果没有被 `persist` 缓存，在步骤 2 的 CheckpointRDD Stage 运行时，**原始数据可能已经被 GC 回收**（因为 Spark 采用懒计算，数据只在需要时产生，产生后如果没有 Cache 则不保留）。这时，Spark 不得不**重新触发原 RDD 的计算**，才能获取到数据来写入 Checkpoint。

结论：**如果没有 Cache 的配合，Checkpoint 会导致 RDD 被计算两次**——一次用于正常的 Action 计算，一次用于 Checkpoint 写入。

**最佳实践**：在 `checkpoint()` 之前先 `persist()`，确保数据在内存（或本地磁盘）中有缓存，Checkpoint 写入时直接从缓存读取，不需要重新计算。

```scala
// 错误做法（RDD 会被计算两次）
rdd.checkpoint()
rdd.count()

// 正确做法（先 persist，再 checkpoint）
rdd.persist(StorageLevel.MEMORY_AND_DISK)
rdd.checkpoint()
rdd.count()
// 可选：Checkpoint 完成后释放缓存
rdd.unpersist()
```

**代价二：HDFS 写入延迟**

HDFS 写入涉及序列化、网络传输、DataNode 三副本写入，速度远低于本地磁盘写入。对于一个 10GB 的 RDD，写入 HDFS 可能需要几分钟，这段时间会增加整个作业的完成时间。

**代价三：存储空间占用**

Checkpoint 数据会持久保存在 HDFS 上，除非手动清理。对于长期运行的 Streaming 应用，需要定期清理过期的 Checkpoint 数据，防止 HDFS 空间持续增长。

### 4.2 Checkpoint 频率的工程权衡

Checkpoint 不是越频繁越好。频率的选择需要权衡：

**容错代价（减小）vs 写入开销（增大）**：

```
Checkpoint 频率高：
  ✓ 故障恢复只需重算最近一个 Checkpoint 到当前的少量迭代
  ✗ 每次 Checkpoint 都有 HDFS 写入开销
  ✗ 存储占用多（需要保存多个 Checkpoint 版本）

Checkpoint 频率低：
  ✓ 写入开销少
  ✗ 故障恢复可能需要重算很多迭代
```

**经验法则**：

对于机器学习迭代训练（每次迭代 < 1 分钟），推荐每 **10-20 次迭代** Checkpoint 一次。这样故障恢复最多重跑 10-20 次迭代（通常 < 10 分钟），而 Checkpoint 写入的频率也不会过高。

```scala
// ML 迭代训练中的 Checkpoint 示例
val checkpointInterval = 10

for (iteration <- 1 to 100) {
  weights = updateWeights(data, weights)
  
  if (iteration % checkpointInterval == 0) {
    weights.persist(StorageLevel.MEMORY_AND_DISK)
    weights.checkpoint()
    weights.count()  // 触发 Checkpoint 写入
    weights.unpersist()
  }
}
```

---

## 第 5 章 Checkpoint 在不同场景下的应用

### 5.1 机器学习：迭代训练的必备

[[Apache Spark MLlib]] 的内置算法（如 `ALS`、`KMeans`、`GradientBoostingTrees`）已经内置了自动 Checkpoint 逻辑，通过 `checkpointInterval` 参数控制：

```scala
import org.apache.spark.ml.recommendation.ALS

val als = new ALS()
  .setMaxIter(50)
  .setCheckpointInterval(10)  // 每 10 次迭代 Checkpoint 一次
  .setRank(10)

sc.setCheckpointDir("hdfs://path/to/checkpoints")
val model = als.fit(trainingData)
```

对于自定义迭代算法，需要手动实现 Checkpoint 逻辑（如上文示例）。

### 5.2 复杂 ETL 管道：在高代价 Shuffle 前 Checkpoint

对于包含多个 Shuffle 的复杂 ETL 作业，在计算代价特别高（如需要几十分钟的 aggregation）的 Stage 输出前设置 Checkpoint，使后续 Stage 的故障恢复不需要重跑这些昂贵的 Stage：

```scala
val expensiveAggregation = rawData
  .filter(...)           // 大量过滤
  .groupByKey()          // 高代价 Shuffle
  .flatMap(...)          // 复杂逻辑
  .reduceByKey(_ + _)    // 再次 Shuffle

// 这里是结果，代价极高
// 在后续 join 前先 Checkpoint，防止后续 Stage 失败导致整个作业重跑
expensiveAggregation.persist()
expensiveAggregation.checkpoint()
expensiveAggregation.count()  // 触发 Checkpoint

// 后续操作
val result = expensiveAggregation.join(otherData)
```

### 5.3 Spark Streaming（DStream）中的 Checkpoint

这是 Checkpoint 在流处理中的应用（Structured Streaming 的 Checkpoint 在第 04 篇详解）。

传统 Spark Streaming（DStream 模式）使用 Checkpoint 来：

1. **保存 DStreamGraph 元数据**：即流处理的计算逻辑图，Driver 重启后从 Checkpoint 恢复计算拓扑
2. **保存有状态 DStream 的状态数据**：如 `updateStateByKey` 维护的累计状态，需要定期 Checkpoint 以防 Driver 崩溃后状态丢失

```scala
// DStream Checkpoint 配置
val ssc = StreamingContext.getOrCreate(
  checkpointDirectory,  // HDFS 路径
  () => {
    val newSsc = new StreamingContext(sc, Seconds(5))
    val stream = newSsc.socketTextStream("localhost", 9999)
    val wordCounts = stream.flatMap(_.split(" "))
      .map((_, 1))
      .updateStateByKey(updateFunction)  // 有状态操作
    
    newSsc.checkpoint(checkpointDirectory)  // 设置 Checkpoint 目录
    newSsc
  }
)
ssc.start()
```

---

## 第 6 章 Checkpoint 的生命周期管理

### 6.1 Checkpoint 目录的清理策略

Spark 本身对旧 Checkpoint 数据不做自动清理（除 Structured Streaming 外，会自动管理 Checkpoint 版本）。对于批处理作业，Checkpoint 文件会永久留在 HDFS 上，需要外部干预清理。

**实践建议**：
1. 为每个作业实例使用独立的 Checkpoint 目录（包含 JobId 或时间戳）
2. 作业成功完成后，自动清理本次的 Checkpoint 目录
3. 通过 HDFS 的目录配额或外部定时清理任务控制整体存储占用

```scala
// 使用带时间戳的 Checkpoint 目录
val checkpointDir = s"hdfs://path/to/checkpoints/job-${System.currentTimeMillis()}"
sc.setCheckpointDir(checkpointDir)

// 作业完成后清理（在 finally 块中）
try {
  runJob()
} finally {
  val fs = FileSystem.get(sc.hadoopConfiguration)
  fs.delete(new Path(checkpointDir), true)  // 递归删除
}
```

### 6.2 Checkpoint 文件的副本数

Checkpoint 文件存储在 HDFS 上，受 HDFS 副本数控制（默认 3 副本）。对于一次性的批处理作业，3 副本可能过于保守（增加写入开销和存储占用）。可以在创建 Checkpoint 之前通过 Hadoop Configuration 调整：

```scala
// 降低 Checkpoint 文件副本数（适合批处理，不适合需要高可靠恢复的 Streaming）
sc.hadoopConfiguration.setInt("dfs.replication", 1)
sc.setCheckpointDir("hdfs://path/to/checkpoints/")
```

> [!note] 设计哲学
> RDD Checkpoint 体现了分布式系统设计中"以空间换时间"的经典权衡：用额外的 HDFS 存储空间（代价）换取故障恢复时更短的重算时间（收益）。这个权衡是否合算，取决于故障概率、重算代价、存储代价三者的比较。在云存储（S3/OSS）成本极低的今天，这个权衡越来越偏向于"多做 Checkpoint"——存储成本可以忽略，而减少故障恢复时间的价值远高于存储开销。

---

## 第 7 章 实战：诊断何时需要 Checkpoint

### 7.1 通过 Lineage 深度判断是否需要 Checkpoint

使用 `rdd.toDebugString` 查看 Lineage 深度（缩进层数），超过 20-30 层时应考虑在中间节点设置 Checkpoint：

```scala
println(rdd.toDebugString)
// 输出的最大缩进层数 ≈ Lineage 深度
```

### 7.2 通过 Stage 重算成本判断是否需要 Checkpoint

在 Spark UI 的 **Stages 页面**，查看各 Stage 的 `Duration`（运行时长）。如果某个 Stage 的运行时间超过 10 分钟，且它后面还有多个下游 Stage，应在这个 Stage 的输出 RDD 上设置 Checkpoint：

- 下游 Stage 失败概率 × 该 Stage 及其祖先的重算时间 > 该 Stage 的 Checkpoint 写入时间
- 则 Checkpoint 是合算的

### 7.3 监控 Checkpoint 写入情况

在 Spark UI 的 **Storage 页面**，可以看到被 Checkpoint 的 RDD 的信息（标记为 `CheckpointRDD`）。如果 Checkpoint 写入失败（HDFS 权限问题、磁盘空间不足等），Spark 会在日志中打印警告：

```
WARN ReliableCheckpointRDD: Error checkpointing RDD(id=42) to path hdfs://...
```

此时 Lineage 截断不会发生，RDD 仍保留完整 Lineage——这是安全的降级行为，但如果 Checkpoint 失败反复出现，说明 HDFS 配置有问题，需要修复。

---

## 小结

RDD Checkpoint 是 Lineage 容错机制的必要补充：

- **设计动机**：Lineage 容错在深链（迭代算法）和高代价 Shuffle 前的场景下，重算代价无法接受，需要在 HDFS 上物化中间结果来截断 Lineage
- **工作原理**：`rdd.checkpoint()` 标记 → Action 触发计算 → CheckpointRDD Stage 写 HDFS → 截断 Lineage（原父 RDD 依赖被替换为 `CheckpointRDD`）
- **三类持久化对比**：`persist` 不截断 Lineage（纯性能优化）；`localCheckpoint` 截断但不可靠（降低 Driver 内存）；可靠 `checkpoint` 截断且可靠（真正的容错）
- **最重要的实践**：**先 `persist`，再 `checkpoint`**——避免 RDD 被计算两次；Checkpoint 完成后 `unpersist` 释放缓存
- **频率权衡**：迭代算法每 10-20 次迭代 Checkpoint 一次是合理的默认策略；代价高 Stage 的输出应在其后的第一个 Action 前 Checkpoint
- **清理责任**：批处理作业需要手动清理 Checkpoint 文件，建议在作业完成后自动清理

至此，批处理容错体系（Lineage + 多级重试 + Checkpoint）已经完整介绍。第 04 篇将进入流处理领域，讲解 Structured Streaming 的容错模型——如何通过 Offset 持久化和 Checkpoint 目录结构，在 Driver 崩溃重启后无缝恢复流处理状态，以及端到端精确一次语义（Exactly-once）的实现前提。

---

## 参考资料

- [Spark Checkpoint 详解（博客园）](https://www.cnblogs.com/cenglinjinran/p/9542589.html)
- [Spark 中 checkpoint 的正确使用方式（CSDN）](https://blog.csdn.net/u010003835/article/details/106744095)
- [persist、checkpoint、localCheckpoint 区别（知乎）](https://www.zhihu.com/question/458648696)
- Apache Spark 源码：`org.apache.spark.rdd.RDD#checkpoint`
- Apache Spark 源码：`org.apache.spark.rdd.ReliableCheckpointRDD`
- Apache Spark 源码：`org.apache.spark.rdd.LocalCheckpointRDD`
- Matei Zaharia 等：Resilient Distributed Datasets（NSDI 2012）
