---
title: "08 推测执行（Speculative Execution）：分布式环境下长尾任务的自动修复机制"
date: 2026-02-27
tags: [Spark, 推测执行, 长尾任务, TaskSetManager, 调度系统]
aliases: [Speculative Execution]
---

# 08 推测执行（Speculative Execution）：分布式环境下长尾任务的自动修复机制

> [!abstract] 摘要
> 在分布式计算中，"长尾任务"（Straggler Task）是影响作业整体完成时间的隐形杀手。一个 Stage 的完成时间由**最慢的那个 Task** 决定，而在 1000 个 Task 中，哪怕只有 1 个 Task 因节点抖动、数据倾斜或资源争用而慢了 10 倍，整个 Stage 就要等它。**推测执行（Speculative Execution）**是 Spark 应对这个问题的核心机制：当系统检测到某个 Task 异常缓慢时，在另一个 Executor 上启动同一分区的"副本 Task"，谁先完成谁的结果被采用，另一个被 Kill。本文将系统推导：长尾任务的产生根因 → 推测执行检测算法的数学逻辑 → `TaskSetManager` 中推测执行的完整实现 → 推测执行与幂等性的关键约束 → 以及不适合开启推测执行的场景。

---

## 第 1 章 长尾任务：分布式计算的阿喀琉斯之踵

### 1.1 木桶效应在分布式计算中的体现

设一个 Stage 有 1000 个 Task，每个 Task 理论上需要 60 秒。在理想情况下，这个 Stage 应该在 60 秒后完成（假设资源充足，所有 Task 并发执行）。

但实际情况是：即使 999 个 Task 在 60 秒内完成，只要有 1 个 Task 因某种原因需要 600 秒，整个 Stage 就需要等待 600 秒——比理论时间**慢了 10 倍**。

这就是"长尾任务"问题，或称为**"木桶效应"**在分布式计算中的表现。

### 1.2 长尾任务的五大成因

**成因一：节点硬件抖动（最常见）**
- 磁盘 I/O 抖动：节点磁盘出现坏扇区或高延迟，Shuffle Read/Write 速度骤降
- 内存不足：节点因其他进程占用内存，触发 Swap 或 OOM，导致 Task 执行极慢
- CPU 争用：同一节点上有其他高负载进程（如 HDFS DataNode 的 Compaction）

**成因二：数据倾斜（Data Skew）**
- 某些分区的数据量远超平均值（如 `groupByKey` 后某个 Key 的数据占总量的 30%）
- 该分区对应的 Task 需要处理的数据量是其他 Task 的数倍乃至数十倍
- 推测执行**无法解决**数据倾斜导致的长尾（在另一个 Executor 上运行同样慢）

**成因三：JVM GC 停顿（STW）**
- Executor JVM 触发 Full GC，Stop-The-World 停顿期间所有 Task 暂停
- 通常持续数秒到数十秒

**成因四：网络带宽争用**
- Shuffle Read 阶段，多个 Task 同时从同一 Executor 拉取数据，争用网络带宽
- 处于网络热点 Executor 上的 Reduce Task 速度显著下降

**成因五：资源碎片化（Resource Fragmentation）**
- 集群资源不均匀，某些 Executor 被分配了过多 Task，CPU 时间片不足
- 最后剩余的几个 Task（Tail Task）在资源不足的 Executor 上运行

### 1.3 推测执行能解决的问题范围

推测执行有效的场景：**同等数据量下，某个 Task 因运行环境问题（节点抖动、资源争用）而异常缓慢**。

推测执行无效的场景：**数据倾斜导致的长尾**——如果一个分区有 1 亿条记录，在任何 Executor 上执行都需要很长时间，在另一个 Executor 上启动副本解决不了数据量问题。

---

## 第 2 章 推测执行的检测算法

### 2.1 检测的核心问题：什么样的 Task 算"慢"？

推测执行检测需要回答：**当前仍在运行的 Task 中，哪些已经"显著慢于"正常水平？**

朴素的方案"超时时间"（如运行超过 60 秒就认为慢）存在明显问题：对于一个正常就需要 300 秒的 Stage，60 秒的阈值会误判大量正常 Task；对于一个正常 10 秒的 Stage，60 秒又太迟钝。

Spark 采用的是**相对于同 Stage 中位数运行时间的百分比阈值**：

> 一个 Task 被认为是"推测执行候选"，当且仅当：
> 1. 该 Task 的已运行时间 > 同 Stage 中所有已完成 Task 运行时间的**中位数 × 推测执行倍数因子**
> 2. 该 Task 的已运行时间 > 推测执行的最小绝对时间阈值（默认 100ms，防止在极短 Stage 中无意义触发）
> 3. 同 Stage 至少有 `spark.speculation.minTaskRuntime` 个 Task 已完成（确保中位数有统计意义）

### 2.2 关键配置参数

```properties
spark.speculation = true           # 开启推测执行（默认 false）
spark.speculation.interval = 100ms # 检测周期（每 100ms 扫描一次 Stage 的 Task 状态）
spark.speculation.multiplier = 1.5 # 推测执行倍数因子（运行时间 > 中位数 × 1.5 则触发）
spark.speculation.quantile = 0.75  # 需要至少 75% 的 Task 完成后，才开始检测长尾
spark.speculation.minTaskRuntime = 100ms  # Task 最少运行多少毫秒才有资格被推测执行
```

**`spark.speculation.quantile` 的设计意图**：当同 Stage 只有 10% 的 Task 完成时，中位数的统计意义不足——可能某些 Task 本身就快，而另一些 Task 数据量大本来就慢，此时不应该触发推测执行。等到 75% 的 Task 完成后，中位数才有足够的代表性。

### 2.3 检测算法的数学推导

以一个具体例子理解检测逻辑：

```
Stage 共 100 个 Task，spark.speculation.quantile = 0.75，spark.speculation.multiplier = 1.5

当前状态（75 个 Task 已完成，25 个仍在运行）：
  已完成 Task 的运行时间（排序后）：[10s, 12s, 15s, 20s, 22s, ... , 45s]
  中位数（第 37.5 个值）= 22s

推测执行阈值 = 22s × 1.5 = 33s

对所有仍在运行的 25 个 Task 检查：
  - Task 87：已运行 40s > 33s → 触发推测执行
  - Task 92：已运行 28s < 33s → 不触发
  - Task 99：已运行 50s > 33s → 触发推测执行
```

---

## 第 3 章 TaskSetManager 中推测执行的实现

### 3.1 推测执行检测的触发入口

`TaskSchedulerImpl` 有一个定时器，每 `spark.speculation.interval`（默认 100ms）调用一次 `checkSpeculatableTasks`：

```scala
// TaskSchedulerImpl.start()
private val speculationScheduler =
  ThreadUtils.newDaemonSingleThreadScheduledExecutor("task-scheduler-speculation")

override def start(): Unit = {
  backend.start()
  
  if (!isLocal && conf.get(SPECULATION_ENABLED)) {
    logInfo("Starting speculative execution thread")
    speculationScheduler.scheduleWithFixedDelay(
      () => Utils.tryOrStopSparkContext(sc) {
        checkSpeculatableTasks()
      },
      SPECULATION_INTERVAL_MS, SPECULATION_INTERVAL_MS, TimeUnit.MILLISECONDS)
  }
}

private def checkSpeculatableTasks(): Unit = {
  var shouldRevive = false
  synchronized {
    shouldRevive = rootPool.checkSpeculatableTasks(MIN_TIME_TO_SPECULATION)
  }
  if (shouldRevive) {
    backend.reviveOffers()  // 有新的推测执行候选，触发资源要约
  }
}
```

### 3.2 TaskSetManager.checkSpeculatableTasks：核心检测逻辑

```scala
// TaskSetManager.checkSpeculatableTasks（简化）
override def checkSpeculatableTasks(minTimeToSpeculation: Long): Boolean = {
  // 需要至少 quantile 比例的 Task 完成
  if (tasksSuccessful < (conf.get(SPECULATION_QUANTILE) * numTasks)) {
    return false
  }
  
  var foundTasks = false
  val medianDuration = successfulTaskDurations.median  // 已完成 Task 运行时间的中位数
  val threshold = max(
    SPECULATION_MULTIPLIER * medianDuration,    // 中位数 × 倍率
    minTimeToSpeculation                        // 绝对时间下限
  )
  
  val now = clock.getTimeMillis()
  
  for (tid <- runningTasksSet) {
    val info = taskInfos(tid)
    val index = info.index
    
    // 检查 Task 是否符合推测执行条件
    if (!successful(index) && copiesRunning(index) == 1 &&
        info.timeRunning(now) > threshold &&
        !speculatableTasks.contains(index)) {
      
      logInfo(s"Marking task $index in stage ${taskSet.id} as speculative " +
        s"due to being more than $SPECULATION_MULTIPLIER times as slow as the median " +
        s"(${info.timeRunning(now)} vs $medianDuration)")
      
      speculatableTasks += index  // 标记为推测执行候选
      foundTasks = true
    }
  }
  foundTasks
}
```

**关键检查条件**：
- `!successful(index)`：分区尚未成功完成
- `copiesRunning(index) == 1`：当前只有 1 个副本在运行（避免重复触发）
- `info.timeRunning(now) > threshold`：已运行时间超过阈值
- `!speculatableTasks.contains(index)`：尚未被标记为推测执行候选

### 3.3 推测执行 Task 的分配：dequeueSpeculativeTask

当 `speculatableTasks` 非空且有空闲资源时，`dequeueTask` 会调用 `dequeueSpeculativeTask` 为推测执行候选分配新的执行位置：

```scala
private def dequeueSpeculativeTask(
    execId: String,
    host: String,
    locality: TaskLocality.Value
): Option[(Int, TaskLocality.Value, Boolean)] = {
  
  speculatableTasks.retain { index =>
    // 过滤掉已经成功完成的分区（副本抢先完成了）
    !successful(index)
  }
  
  // 尝试找一个推测执行候选，且其原始 Task 不在当前 Executor 上运行
  def canRunOnHost(index: Int): Boolean = {
    !hasAttemptOnHost(index, host)  // 避免在已有副本的同一主机上再启动
  }
  
  if (!speculatableTasks.isEmpty) {
    // 按本地化级别匹配推测执行 Task
    for (index <- speculatableTasks if canRunOnHost(index)) {
      val allowedLocality = getAllowedLocalityLevel(execId, host)
      if (allowedLocality <= locality) {
        speculatableTasks -= index
        return Some((index, allowedLocality, true))  // 第三个参数 true = 是推测执行
      }
    }
  }
  
  None
}
```

**关键设计**：`!hasAttemptOnHost(index, host)` 避免在已有原始 Task 运行的同一主机上启动推测副本——因为如果问题是节点故障，在同一节点启动副本同样会很慢，甚至更快失败。

---

## 第 4 章 推测执行的结果采用与副本 Kill

### 4.1 谁先完成谁的结果被采用

当某个分区的一个 Attempt（无论是原始 Task 还是推测副本）成功完成时，`handleSuccessfulTask` 处理如下：

```scala
def handleSuccessfulTask(tid: Long, result: DirectTaskResult[_]): Unit = {
  val info = taskInfos(tid)
  val index = info.index
  
  if (successful(index)) {
    // 这个分区已经被另一个 Attempt 完成了（推测副本先完成，或原始先完成）
    // 当前这个 Task 是"多余的"，忽略其结果
    logInfo(s"Task ${info.id} on ${info.host} ignored: " +
      "duplicate task completing for partition " + index)
    sched.handleSuccessfulTask(this, tid, result)
    // 仍然需要通知 Backend 释放该 Task 占用的资源
  } else {
    // 这是该分区的第一个成功 Attempt
    successful(index) = true
    tasksSuccessful += 1
    
    // Kill 同一分区的其他所有正在运行的 Attempt（包括原始 Task 或其他推测副本）
    for (attemptInfo <- taskAttempts(index) if attemptInfo.running) {
      if (attemptInfo.taskId != tid) {
        sched.backend.killTask(
          attemptInfo.taskId,
          attemptInfo.executorId,
          interruptThread = true,
          reason = "another attempt succeeded"
        )
      }
    }
    
    // 通知 DAGScheduler 该分区已完成
    sched.dagScheduler.taskEnded(tasks(index), Success, result.value(), ...)
  }
}
```

### 4.2 被 Kill 的 Task 的状态处理

被推测执行 Kill 的 Task 会收到 `TaskKilledException`，其状态被标记为 `KILLED`（而非 `FAILED`）：
- **不计入 `numFailures(index)`**：不会触发 Stage 终止
- **不触发 FetchFailedException**：不会引发上游 Stage 重算
- 该 Task 占用的 Executor 资源会被释放，可以接受新的 Task

---

## 第 5 章 幂等性：推测执行的前提条件

### 5.1 为什么推测执行要求 Task 幂等？

推测执行可能导致同一分区的数据被计算两次、写入两次（在两个不同的 Executor 上同时运行）。如果 Task 有**副作用**（Side Effect），如写入外部数据库或追加写文件，两次执行会导致数据重复。

### 5.2 各类 Task 的幂等性分析

| Task 类型 | 幂等性 | 原因 | 推测执行是否安全 |
| :--- | :--- | :--- | :--- |
| **ShuffleMapTask** | 是 | Shuffle 文件以 mapId 命名，重复写入同名文件 | 安全（后写覆盖前写） |
| **ResultTask（读操作）** | 是 | `count()`、`collect()` 等纯计算，无副作用 | 安全 |
| **ResultTask（写 HDFS）** | 是（通常）| Hadoop OutputCommitter 的 commitTask 用原子性 rename 避免重复 | 安全（有 OutputCommitter 保护） |
| **ResultTask（写数据库）** | 否 | 数据库 INSERT 没有天然的幂等性 | 危险（会导致重复写入） |
| **ResultTask（发消息）** | 否 | 向 Kafka/RabbitMQ 发送消息 | 危险（会发送重复消息） |

> [!warning] 生产避坑：写外部存储时谨慎开启推测执行
> 如果你的 Spark 作业最终将数据写入 MySQL、HBase、Elasticsearch 等外部存储，且没有实现基于主键的 UPSERT（Insert Or Update）语义，**不应该开启推测执行**，否则会导致数据重复。
>
> 正确的做法：要么实现幂等写入（如 INSERT INTO ... ON DUPLICATE KEY UPDATE），要么关闭推测执行（`spark.speculation = false`）。

---

## 第 6 章 推测执行的生产实践

### 6.1 开启与配置

```properties
# 开启推测执行
spark.speculation = true

# 调整检测灵敏度（根据实际 Stage 的任务时间分布调整）
spark.speculation.multiplier = 3     # 对于时间方差大的 Stage，适当放宽
spark.speculation.quantile = 0.9     # 等 90% Task 完成后再检测，减少误判
spark.speculation.interval = 1000ms  # 适当增大检测周期，减少调度开销

# 针对 Task 运行时间较长的作业
spark.speculation.minTaskRuntime = 60000ms  # 至少运行 60 秒的 Task 才被推测执行
```

### 6.2 什么时候关闭推测执行？

| 场景 | 建议 | 原因 |
| :--- | :--- | :--- |
| 数据倾斜严重的 Stage | 关闭 | 推测执行不能解决数据量问题，只会浪费资源 |
| Task 有非幂等副作用 | 关闭 | 防止数据重复写入 |
| 集群资源紧张 | 关闭 | 推测执行额外消耗 10-30% 的资源 |
| Shuffle 密集型 Stage | 谨慎 | 推测执行会造成同一 Map 端 Block 被多次 Fetch，增加网络压力 |

### 6.3 如何区分"推测执行解决"vs"数据倾斜解决"？

**诊断方法**：在 Spark UI 的 Stage 详情页，查看 Task 的运行时间分布：
- 如果大多数 Task 快速完成，少数 Task（1-5个）异常慢 → 可能是节点抖动，推测执行有效
- 如果慢 Task 的"Input Size"（输入数据量）也显著大于平均值 → 数据倾斜，需要专项处理（如加盐、Broadcast Join），推测执行无效

---

## 第 7 章 总结

推测执行是分布式计算中"以资源换时间"的典型设计：

- **检测机制**：基于相对中位数的百分比阈值，自适应于不同 Stage 的 Task 运行时间分布
- **启动条件**：满足 quantile 比例完成 + 运行时间 > 中位数 × multiplier + 最小绝对时间
- **副本分配**：优先分配到与原始 Task 不同的主机，避免在同一故障节点上重试
- **结果采用**：先完成的 Attempt 的结果被采用，其他 Attempt 被 Kill（KILLED 不计失败次数）
- **幂等性前提**：推测执行的安全性依赖 Task 的幂等性，非幂等写入场景必须关闭

在 **[[09 本地化调度（Locality-Aware Scheduling）：移动计算而非移动数据的实现细节|下一篇文章]]** 中，我们将深入数据本地性调度的完整机制，理解 Spark 如何实现"移动计算，而非移动数据"的核心理念。

---

> [!note] 思考题
> 1. `spark.speculation.quantile = 0.75` 意味着至少 75% 的 Task 完成后才开始检测。如果一个 Stage 有 1000 个 Task，但由于数据倾斜，有 200 个 Task 永远不会完成（持续 OOM），推测执行会触发吗？在这种情况下，等待 75% 完成会陷入死锁吗？
> 2. ShuffleMapTask 的推测执行副本在另一个 Executor 上完成后，原始 Task 被 Kill。此时 `MapOutputTracker` 中记录的该 Map 分区的输出位置是什么（原始 Task 的位置还是副本的位置）？如果下游 Reduce Task 已经开始从原始 Task 的输出位置拉取数据，Kill 原始 Task 会导致什么？
> 3. 推测执行检测基于"已完成 Task 运行时间的中位数"。如果一个 Stage 的前 75% Task 都很快（5 秒），中位数 = 5 秒，推测阈值 = 7.5 秒。而后 25% Task（数据量较大）正常也需要 20 秒。这 25% Task 会被误判为长尾而触发推测执行吗？如何缓解这个问题？
