---
title: "09 本地化调度（Locality-Aware Scheduling）：移动计算而非移动数据的实现细节"
date: 2026-02-27
tags: [Spark, 本地化调度, 数据本地性, TaskScheduler, 性能优化]
aliases: [Locality-Aware Scheduling]
---

# 09 本地化调度（Locality-Aware Scheduling）：移动计算而非移动数据的实现细节

> [!abstract] 摘要
> 分布式计算有一条朴素的性能原理：**计算应该在数据所在的地方发生，而不是把数据拖到计算发生的地方**。这条原理听起来简单，但在一个有数百个节点、数千个并发 Task、数据分布动态变化的集群中，真正实现"移动计算而非移动数据"需要一套精密的机制。这就是 Spark 的**本地化调度（Locality-Aware Scheduling）**。本文将从第一性原理推导：数据移动的成本为什么是分布式计算的主要瓶颈 → Spark 定义了哪五个本地化级别，每个级别的物理含义是什么 → `TaskSetManager` 如何维护本地性偏好信息 → Locality Wait 机制如何在"等待最优"与"接受次优"之间动态权衡 → 以及在 HDFS、Cache、S3 等不同数据源下本地化调度的实际效果差异。

---

## 第 1 章 为什么数据移动是分布式计算的主要瓶颈

### 1.1 存储层级与访问延迟的数量级差异

理解本地化调度的价值，需要先建立对不同存储访问延迟的直觉。以下是一个现代数据中心中典型的延迟数量级（近似值）：

| 存储层级 | 访问延迟 | 典型带宽 |
| :--- | :--- | :--- |
| L1 Cache（CPU 缓存） | ~1 ns | - |
| L2/L3 Cache | 4-50 ns | - |
| JVM 堆内存（访问 Java 对象） | ~100 ns | - |
| **本地磁盘（SSD）顺序读** | **~100 μs** | **500 MB/s** |
| **本地磁盘（HDD）顺序读** | **~2 ms** | **100-200 MB/s** |
| **同机架万兆网络传输** | **~1 ms RTT** | **1 GB/s** |
| **跨机架千兆网络传输** | **~5-10 ms RTT** | **100 MB/s** |
| **跨数据中心广域网** | **~50-100 ms RTT** | **10-100 MB/s** |

**关键结论**：通过网络传输 1GB 数据，在万兆网络下需要约 1 秒；而直接从本地内存读取，只需要约 10ms。数据本地性的差异，意味着 Task 执行效率可以相差 10-100 倍。

### 1.2 Spark 的典型数据读取场景

在 Spark 的实际运行中，数据读取的延迟来源主要有以下几种：

**场景一：从 HDFS 读取原始数据（第一个 Stage）**

HDFS 的每个文件块（Block，默认 128MB）通常有 3 个副本，分布在不同节点上。如果 Spark 能将处理该 Block 的 Task 调度到存有该 Block 副本的节点上，就可以直接读取本地磁盘，避免网络传输。

**场景二：读取已缓存的 RDD 分区（迭代计算）**

当 RDD 被 `cache()` 后，分区数据存储在某个 Executor 的 JVM 内存中。如果后续 Job 的 Task 能调度到同一个 Executor 上，就可以直接从进程内存读取，延迟极低（PROCESS_LOCAL 级别）。

**场景三：Shuffle Read（下游 Stage 读取上游写出的 Shuffle 数据）**

Shuffle 数据分散在所有 Map Task 所在 Executor 的本地磁盘上。Reduce Task 无论调度到哪里，都必须通过网络从多个 Executor 拉取数据——本地化调度在 Shuffle Read 阶段意义有限，因为数据本就需要跨节点传输。

**场景四：从 S3/OSS 等对象存储读取数据**

对象存储天然不提供"数据本地性"的概念——所有节点访问 S3 的延迟基本相同（取决于 S3 服务的距离和网络带宽）。在这种场景下，本地化调度无意义，所有 Task 都是 NO_PREF 级别。

---

## 第 2 章 五个本地化级别：从最优到最差的物理含义

### 2.1 TaskLocality 枚举的完整定义

```scala
// org.apache.spark.scheduler.TaskLocality.scala
object TaskLocality extends Enumeration {
  // 从最优到最差排序
  val PROCESS_LOCAL, NODE_LOCAL, NO_PREF, RACK_LOCAL, ANY = Value
  type TaskLocality = Value

  def isAllowed(constraint: TaskLocality, condition: TaskLocality): Boolean = {
    // 检查 condition 级别是否在 constraint 允许的范围内
    // 例如：constraint = NODE_LOCAL，则 PROCESS_LOCAL 和 NODE_LOCAL 都被允许
    condition <= constraint
  }
}
```

### 2.2 五个级别的详细解析

**PROCESS_LOCAL（进程本地）**：Task 所需数据在目标 Executor 的 JVM 进程内存中。数据访问不经过网络，也不经过磁盘，直接在 JVM 堆内存中读取。

**触发条件**：
- RDD 分区已被 `cache()` 并且恰好缓存在该 Executor 上
- 广播变量已在该 Executor 上有副本（通常广播到所有 Executor，所以所有 Executor 都是 PROCESS_LOCAL）

**性能特征**：最快，无 I/O 开销，纯 CPU 计算。

---

**NODE_LOCAL（节点本地）**：Task 所需数据在目标节点的本地磁盘上，但不在目标 Executor 的进程内存中。

**触发条件**：
- HDFS Block 的副本在目标节点上（DataNode 与 Executor 同节点）
- RDD 分区缓存在同一节点上的另一个 Executor（不同 JVM 进程）
- 数据存储在目标节点的本地磁盘（如已 Spill 到磁盘的缓存块）

**性能特征**：需要磁盘 I/O，但无网络传输。对于 SSD，读取速度 500MB/s；对于 HDD，约 100-200MB/s。

---

**NO_PREF（无偏好）**：Task 对执行节点没有本地性偏好，所有节点的访问延迟相同。

**触发条件**：
- 数据存储在 S3、OSS、HDFS over HTTP 等对象存储或远程服务
- Task 本身不涉及数据读取（纯计算 Task）

**性能特征**：调度器可以将其分配到任意节点，不需要等待最优本地性。在资源有限时，NO_PREF 的 Task 往往能比 NODE_LOCAL 更快被调度（因为不需要等待特定节点空闲）。

---

**RACK_LOCAL（机架本地）**：Task 所需数据在同一机架的其他节点上。

**触发条件**：
- HDFS Block 的所有副本都在同机架的其他节点（目标节点没有副本）
- 需要先通过机架内交换机传输数据，但不需要跨核心交换机

**性能特征**：机架内带宽（通常 10Gbps）远高于跨机架带宽（通常 1Gbps 共享）。RACK_LOCAL 比 ANY 快，但比 NODE_LOCAL 慢。

---

**ANY（任意）**：Task 可以在集群中任意节点执行，数据需要跨机架网络传输。

**触发条件**：没有更好的本地性选项，或者 Locality Wait 超时后降级。

**性能特征**：最差，需要跨机架网络传输，延迟高，带宽受限。

---

### 2.3 本地化级别的优先级矩阵

```mermaid
graph LR
    A["PROCESS_LOCAL</br>进程内存</br>最优"] --> B["NODE_LOCAL</br>本地磁盘"]
    B --> C["NO_PREF</br>无偏好</br>(对象存储等)"]
    C --> D["RACK_LOCAL</br>同机架网络"]
    D --> E["ANY</br>跨机架网络</br>最差"]

    classDef best fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px;
    classDef good fill:#e3f2fd,stroke:#1565c0,stroke-width:2px;
    classDef neutral fill:#fff9c4,stroke:#f57f17,stroke-width:2px;
    classDef bad fill:#ffccbc,stroke:#bf360c,stroke-width:2px;
    classDef worst fill:#f8bbd0,stroke:#880e4f,stroke-width:2px;
    class A best;
    class B good;
    class C neutral;
    class D bad;
    class E worst;
```

**注意**：`NO_PREF` 的位置稍微特殊——它在代码中排在 `NODE_LOCAL` 和 `RACK_LOCAL` 之间，但语义上它表示"没有偏好，任意节点都可以"。当一个 Task 是 NO_PREF 时，它可以立即被分配到任何节点，不需要等待 Locality Wait。

---

## 第 3 章 TaskSetManager 如何获得本地性偏好信息

### 3.1 preferredLocations 的来源

每个 Task 的本地性偏好来自其对应 RDD 分区的 `preferredLocations`。不同类型的 RDD 有不同的实现：

**HadoopRDD（HDFS 数据源）**：
```scala
// HadoopRDD.getPreferredLocations
override def getPreferredLocations(split: Partition): Seq[String] = {
  val hsplit = split.asInstanceOf[HadoopPartition].inputSplit.value
  val locs = hsplit match {
    case lsplit: FileSplit =>
      lsplit.getLocations.filter(_ != "localhost")  // HDFS Block 的副本所在节点
    case _ => Array.empty[String]
  }
  locs
}
```
HDFS 通过 `InputSplit.getLocations()` 返回该 Block 所有副本的节点名称，TaskSetManager 把这些位置加入 `pendingTasksForHost` 队列，对应 NODE_LOCAL。

**CachedRDD（已缓存的分区）**：
```scala
// RDD.getPreferredLocations（当分区已缓存时）
private def getPreferredLocsInternal(
    rdd: RDD[_], partition: Int): Seq[TaskLocation] = {
  
  // 查询 BlockManagerMaster：该分区的 Block 在哪些 Executor 上有缓存？
  val cached = getCacheLocs(rdd)(partition)
  if (cached.nonEmpty) {
    return cached  // 返回缓存所在的 Executor 位置（PROCESS_LOCAL）
  }
  ...
}
```
如果分区已被缓存，`getCacheLocs` 从 `BlockManagerMaster` 查询该 Block 的位置，返回 `ExecutorCacheTaskLocation`，TaskSetManager 把这些位置加入 `pendingTasksForExecutor` 队列，对应 PROCESS_LOCAL。

**ShuffledRDD（Shuffle 输出）**：ShuffledRDD 本身没有 `preferredLocations`（返回空），因为 Shuffle Read 天然需要从多个远程节点拉取数据，无法做到本地性。

**ParallelCollectionRDD（`sc.parallelize`）**：没有 `preferredLocations`，属于 NO_PREF。

### 3.2 TaskSetManager 中的本地性队列初始化

```scala
// TaskSetManager 初始化时，为所有 Task 计算本地性偏好
private def addPendingTask(index: Int, resolveRacks: Boolean = true): Unit = {
  for (loc <- tasks(index).preferredLocations) {
    loc match {
      case e: ExecutorCacheTaskLocation =>
        // 数据在指定 Executor 的内存中 → PROCESS_LOCAL
        pendingTasksForExecutor.getOrElseUpdate(e.executorId, ArrayBuffer()) += index

      case e: HDFSCacheTaskLocation =>
        // HDFS 本地缓存 → 类似 PROCESS_LOCAL
        val execs = sched.getExecutorsAliveOnHost(e.host)
        execs.foreach { execId =>
          pendingTasksForExecutor.getOrElseUpdate(execId, ArrayBuffer()) += index
        }

      case _ =>
        // 普通 Host 偏好 → NODE_LOCAL
        pendingTasksForHost.getOrElseUpdate(loc.host, ArrayBuffer()) += index
        // 如果需要，也计算机架信息 → RACK_LOCAL
        if (resolveRacks) {
          sched.getRackForHost(loc.host).foreach { rack =>
            pendingTasksForRack.getOrElseUpdate(rack, ArrayBuffer()) += index
          }
        }
    }
  }

  if (tasks(index).preferredLocations.isEmpty) {
    pendingTasksWithNoPrefs += index  // NO_PREF
  }
  allPendingTasks += index  // ANY 级别的兜底
}
```

---

## 第 4 章 Locality Wait 机制：在理想与现实之间的动态权衡

### 4.1 Locality Wait 要解决的核心矛盾

假设 Task T 的数据在节点 A 上（NODE_LOCAL），但节点 A 的所有 CPU 都被其他 Task 占满。此时节点 B 有空闲 CPU，但 Task T 的数据不在节点 B 上（ANY 级别）。

**朴素策略一：永远等待最优本地性**
- 问题：节点 A 可能需要等待很长时间才有空闲 CPU，节点 B 的空闲资源被白白浪费
- 适用场景：数据量极大、网络传输代价远高于等待代价

**朴素策略二：不等待，立即接受任意节点**
- 问题：每次数据都需要跨节点传输，Shuffle Read 前的网络传输代价叠加，整体吞吐量下降
- 适用场景：集群节点很少、网络带宽充足、数据量小

Spark 的 **Locality Wait** 是这两种极端之间的动态平衡：**等待一段时间，如果最优级别的节点仍未就绪，则降级到次优级别，再等待一段时间，以此类推。**

### 4.2 Locality Wait 的配置参数体系

```properties
# 基础等待时间（未被更细化参数覆盖时的默认值）
spark.locality.wait = 3s

# 各级别独立配置（可以细粒度控制每个级别的等待时间）
spark.locality.wait.process = 3s  # 等待 PROCESS_LOCAL 的时间
spark.locality.wait.node    = 3s  # 等待 NODE_LOCAL 的时间
spark.locality.wait.rack    = 3s  # 等待 RACK_LOCAL 的时间
# 注意：NO_PREF 和 ANY 没有等待时间（会立即接受）
```

**等待时间的含义**：`spark.locality.wait.node = 3s` 意味着：如果一个 Task 在 `NODE_LOCAL` 级别等待了 3 秒仍未被分配（因为目标节点没有空闲 CPU），则降级到 `RACK_LOCAL` 尝试。

### 4.3 Locality Wait 的实现机制：getAllowedLocalityLevel

`TaskSetManager` 中的 `getAllowedLocalityLevel` 方法根据等待时间动态计算当前允许的最低本地化级别：

```scala
// TaskSetManager.getAllowedLocalityLevel（简化）
private def getAllowedLocalityLevel(curTime: Long): TaskLocality.TaskLocality = {
  // 尝试从最优到最差，找到当前可以接受的级别
  while (currentLocalityIndex < myLocalityLevels.length - 1) {
    val moreTasks = myLocalityLevels(currentLocalityIndex) match {
      case TaskLocality.PROCESS_LOCAL =>
        moreTasksToRunIn(pendingTasksForExecutor)
      case TaskLocality.NODE_LOCAL =>
        moreTasksToRunIn(pendingTasksForHost)
      case TaskLocality.NO_PREF =>
        pendingTasksWithNoPrefs.nonEmpty
      case TaskLocality.RACK_LOCAL =>
        moreTasksToRunIn(pendingTasksForRack)
      case _ => false
    }

    if (!moreTasks) {
      // 当前级别已无 Task 等待，跳过直接降级
      currentLocalityIndex += 1
    } else if (curTime - lastLocalityWaitResetTime >= localityWaits(currentLocalityIndex)) {
      // 当前级别的等待时间已到，降级
      currentLocalityIndex += 1
      lastLocalityWaitResetTime += localityWaits(currentLocalityIndex - 1)
    } else {
      // 仍在等待窗口内，返回当前级别
      return myLocalityLevels(currentLocalityIndex)
    }
  }
  myLocalityLevels(currentLocalityIndex)
}
```

### 4.4 一个完整的本地化调度时序示例

```
初始状态：Task T 的数据在 NodeA（NODE_LOCAL），当前 NodeA 满载，NodeB 空闲

t=0:   ResourceOffer 到达
       getAllowedLocalityLevel → NODE_LOCAL（刚开始，还在等待窗口内）
       NodeA 满载，无法提供 NodeA 上的 Offer → Task T 未被分配

t=1s:  新一轮 ResourceOffer
       已等待 1s，spark.locality.wait.node=3s，仍在等待
       → Task T 继续等待 NODE_LOCAL

t=3s:  getAllowedLocalityLevel → 等待 3s 超时，降级到 RACK_LOCAL
       NodeB 在同机架 → RACK_LOCAL Offer 可用
       Task T 被分配到 NodeB 执行（RACK_LOCAL 级别）

如果 spark.locality.wait.rack 也超时（再等 3s）：
t=6s:  降级到 ANY → 任意节点都可接受
```

---

## 第 5 章 本地化调度在不同数据源下的实际效果

### 5.1 HDFS 数据源：本地化调度的最佳场景

HDFS 的 3 副本策略天然支持数据本地性：每个 Block 在 3 个不同节点上各有一份。如果 Spark Executor 与 HDFS DataNode 部署在同一批节点上（Hadoop 的典型部署方式），理论上每个 Task 都能找到 NODE_LOCAL 级别的执行位置。

**实际效果影响因素**：
- **Executor 数量 < DataNode 数量**：部分节点没有 Executor，无法利用本地副本
- **数据偏斜**：某些节点上的 HDFS Block 数量不均匀，导致部分 Task 无法找到 NODE_LOCAL
- **节点故障**：DataNode 挂掉后，HDFS 开始副本迁移，此时副本位置与 Spark 的缓存不一致

**最佳实践**：在 YARN 模式下，将 `spark.executor.instances` 设置为与 DataNode 数量相同，并通过 `spark.executor.cores` 合理配置并发数，确保每个节点都有 Executor 运行，最大化 NODE_LOCAL 机会。

### 5.2 Cache 场景：PROCESS_LOCAL 的巨大收益

在迭代型机器学习计算（如 Spark MLlib 的 K-Means、ALS 算法）中，训练数据被 `cache()` 后存储在 Executor 内存中。每轮迭代的 Task 都以 PROCESS_LOCAL 级别访问数据，不经过任何 I/O。

**数据：PROCESS_LOCAL vs NODE_LOCAL vs ANY 的延迟对比（64MB 数据块）**：
- PROCESS_LOCAL（内存）：~50ms（纯 CPU 处理，无 I/O）
- NODE_LOCAL（SSD）：~150ms（内存处理 + SSD 读取）
- ANY（万兆网络）：~600ms（内存处理 + 网络传输）

10 轮迭代 × 100 个 Task：
- PROCESS_LOCAL：5000ms
- ANY：60000ms（慢 12 倍）

这正是 MLlib 官方推荐在训练前 `cache()` 数据的核心原因——不仅避免重算，更将 I/O 升级为纯内存访问。

### 5.3 S3/OSS 场景：本地化调度无意义

云端对象存储（S3、阿里云 OSS、GCS 等）不提供数据本地性的概念——从任何 Executor 访问 S3 的延迟基本一致（受网络带宽限制，而非数据位置）。

在这种场景下，所有 Task 都是 NO_PREF，调度器可以立即将 Task 分配到任何有空闲 CPU 的 Executor，完全不需要等待 Locality Wait。

**配置建议**：如果你的集群主要使用 S3/OSS 作为数据源，可以将 Locality Wait 设为 0：

```properties
spark.locality.wait = 0s  # 不等待，直接接受任意节点
```

这可以避免 Locality Wait 带来的无谓延迟（在无本地性的场景下等待 3 秒毫无意义）。

### 5.4 Shuffle Read 场景：本地性失效的必然

Shuffle Read 阶段，Reduce Task 需要从**所有** Map Task 所在 Executor 拉取对应分区的数据。这是一个多对多的网络传输，天然无法实现数据本地性。

**为什么 Shuffle 之后的 Stage 的 Task 都是 ANY 级别？**

ShuffledRDD（Shuffle 输出的 RDD）的 `getPreferredLocations` 返回空列表——它的数据分散在所有 Map Executor 上，没有"偏好位置"的概念。因此所有 Reduce Task 都是 NO_PREF/ANY 级别，调度器直接按资源可用性分配，不等待 Locality Wait。

---

## 第 6 章 本地性感知与动态分配的交互

### 6.1 动态分配对本地性的影响

开启动态资源分配（`spark.dynamicAllocation.enabled=true`）后，Executor 会在 Task 完成后被释放（达到一定空闲时间阈值）。这导致已缓存的 RDD 数据可能随 Executor 释放而丢失，使后续 Task 的 PROCESS_LOCAL 机会减少。

**HDFS 场景下的影响相对较小**：因为 HDFS 副本不随 Executor 消亡而消失，NODE_LOCAL 机会仍然存在。

**Cache 场景下的影响较大**：Executor 释放后内存中的 Cache Block 消失，后续 Task 只能重算（或从磁盘读取，如果 StorageLevel 包含 DISK）。

**生产建议**：在迭代型计算（需要多次访问同一 Cache RDD）中，使用 `spark.dynamicAllocation.cachedExecutorIdleTimeout`（默认 `infinity`）确保缓存了重要数据的 Executor 不被释放：

```properties
spark.dynamicAllocation.cachedExecutorIdleTimeout = infinity
# 有 Cache Block 的 Executor 永不被动态释放
```

---

## 第 7 章 生产调优：Locality Wait 的调整策略

### 7.1 Locality Wait 的调整原则

**场景一：数据量大、网络带宽不充裕**

数据传输成本高，值得等待更优本地性：
```properties
spark.locality.wait = 5s       # 延长等待时间
spark.locality.wait.node = 10s  # 节点本地性尤为重要，多等一会
```

**场景二：Stage Task 数量远大于集群节点数（如 10000 Task，200 节点）**

此时每个节点会处理约 50 个 Task，负载均衡问题比本地性更重要：
```properties
spark.locality.wait = 1s  # 缩短等待，防止某些节点任务积压
```

**场景三：对象存储（S3/OSS）为主要数据源**

```properties
spark.locality.wait = 0s  # 无本地性概念，不需要等待
```

**场景四：缓存密集型迭代计算（MLlib 训练）**

```properties
spark.locality.wait.process = 10s  # 重要：等待 PROCESS_LOCAL，避免缓存失效
spark.locality.wait.node = 3s
```

### 7.2 通过 Spark UI 诊断本地化调度质量

在 Spark UI 的 **Stage Details** 页面，每个 Task 都显示其 Locality Level。通过统计各级别 Task 的数量分布，可以判断本地化调度效果：

```
理想情况（HDFS 数据源）：
  PROCESS_LOCAL: 0%（第一次读取，无缓存）
  NODE_LOCAL: 90%
  RACK_LOCAL: 8%
  ANY: 2%

缓存命中良好（第二次迭代）：
  PROCESS_LOCAL: 95%
  NODE_LOCAL: 5%

需要关注的情况：
  NODE_LOCAL: 20%
  ANY: 80%    ← 大量 ANY 说明 Executor 分布与数据分布不匹配
```

---

## 第 8 章 总结

本地化调度是 Spark 将"移动计算而非移动数据"理念落地的核心机制：

- **五个级别**：PROCESS_LOCAL（进程内存）→ NODE_LOCAL（本地磁盘）→ NO_PREF（无偏好）→ RACK_LOCAL（同机架）→ ANY（任意），从最优到最差
- **本地性信息来源**：由 RDD 的 `getPreferredLocations` 提供，HDFS Block 副本位置 → NODE_LOCAL，Cache Block 位置 → PROCESS_LOCAL，S3 对象 → NO_PREF
- **Locality Wait 机制**：在固定时间窗口内等待更优本地性，超时后降级，实现等待代价与传输代价的动态平衡
- **不同场景的差异化效果**：HDFS 和 Cache 场景本地性收益显著；S3 场景应关闭 Locality Wait；Shuffle Read 阶段无本地性可言

在 **[[10 动态资源申请（Dynamic Resource Allocation）：弹性计算的资源调度逻辑|下一篇文章]]** 中，我们将解析 Spark 如何根据作业实时负载弹性伸缩 Executor 数量，在资源利用率与作业响应时间之间找到最优平衡。

---

> [!note] 思考题
> 1. 一个 Stage 有 500 个 Task，数据在 HDFS 上，集群有 50 个节点各有一个 Executor（4 核）。理论上 Task 应该 100% NODE_LOCAL。但实际运行时，最后几个 Task 往往是 RACK_LOCAL 或 ANY。请解释为什么——是"最后几个 Task"的数据不在任何 Executor 节点上吗？还是有其他原因？
> 2. PROCESS_LOCAL 的触发条件是数据在 Executor 的 JVM 内存中。如果一个 RDD 分区被 `persist(StorageLevel.DISK_ONLY)` 写到磁盘，此时 BlockManager 中有该 Block 的记录，但内存中没有数据。这个分区的 Task 是 PROCESS_LOCAL、NODE_LOCAL 还是 ANY？
> 3. Spark 的机架感知（Rack Awareness）是如何工作的？`sched.getRackForHost(host)` 如何知道某个节点属于哪个机架？如果集群没有配置机架信息（默认情况下），RACK_LOCAL 级别会有什么效果？
