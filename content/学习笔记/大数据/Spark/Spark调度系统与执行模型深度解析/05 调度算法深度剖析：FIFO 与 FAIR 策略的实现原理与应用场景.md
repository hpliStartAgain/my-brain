---
title: "05 调度算法深度剖析：FIFO 与 FAIR 策略的实现原理与应用场景"
date: 2026-02-27
tags: [Spark, 调度算法, FIFO, FAIR, 源码分析]
aliases: [Spark Scheduling Algorithms]
---

# 05 调度算法深度剖析：FIFO 与 FAIR 策略的实现原理与应用场景

> [!abstract] 摘要
> 当多个 Job、多个用户、多个业务线同时向同一个 Spark 集群提交作业时，集群内部的资源竞争就变得不可回避。**调度算法**决定了在同一个 Spark Application 内部，有限的 Executor 资源该如何在并发的 Job 之间分配。这看似是一个"排队"问题，实则是一个需要在**吞吐量、延迟、公平性和优先级**之间精细权衡的工程命题。本文将系统推导：为什么 FIFO 在多租户场景下会失效 → `Schedulable`/`Pool` 层级结构的设计意图 → FIFO 排序算法的完整逻辑 → FAIR 调度的双重排序数学模型 → `minShare` 与 `weight` 的生产配置策略 → 以及如何通过多级资源池设计实现精细的业务优先级控制。

---

## 第 1 章 问题起点：单 Application 内的资源竞争

### 1.1 什么是应用内调度？

Spark 的资源调度发生在两个层面：

**应用间调度（Inter-Application Scheduling）**：由 YARN/K8s/Standalone 负责，决定每个 Spark Application 获得多少 Container/Pod。这不在 Spark 的控制范围内，本文不讨论。

**应用内调度（Intra-Application Scheduling）**：在单个 Spark Application 的生命周期内，该应用申请到的 Executor 资源（CPU 核、内存）在其多个并发 Job 之间如何分配。**这是 `TaskScheduler` 中调度算法的职责范围，也是本文的核心主题。**

### 1.2 什么时候会产生应用内的并发 Job？

在以下场景中，一个 Spark Application 可能同时有多个 Job 在运行：

**场景一：多线程触发多个 Action**
```scala
// 主线程触发 Job 1
val f1 = Future { rdd1.count() }  // Job 1（异步，在另一个线程运行）

// 主线程继续触发 Job 2
val f2 = Future { rdd2.count() }  // Job 2（同时在运行）

// 等待两个 Future 完成
Await.result(f1, Duration.Inf)
Await.result(f2, Duration.Inf)
```

**场景二：Spark SQL 的 Subquery 优化**
Catalyst 优化器可能将一个 SQL 查询分解为多个并发执行的子查询，这些子查询可能对应多个 Job。

**场景三：Streaming 批次处理**
Spark Structured Streaming 中，每个 batch 的处理可能包含多个并发 Job（如主数据流 + watermark 维护 + State Store 操作）。

### 1.3 FIFO 的默认行为与其局限性

**FIFO（First In First Out）**是 Spark 的默认调度模式。其行为极其简单：**先提交的 Job 优先获得所有可用资源，后提交的 Job 必须等待。**

这在以下场景会产生严重问题：

```
时间线：
t=0: Job A 提交（超大 ETL 作业，预计运行 2 小时，需要 200 个 Executor）
t=5min: Job B 提交（交互式查询，只需要 10 秒，只需要 5 个 Executor）

FIFO 的结果：
  Job A 占用全部 200 Executor 运行 2 小时
  Job B 在等待队列中阻塞 2 小时后才开始执行

FAIR 的结果（理想）：
  Job A 和 Job B 同时运行
  Job B 在 ~10 秒内完成（使用分配到的 5 个 Executor）
  Job A 继续使用剩余资源，稍微慢一点（约 2 小时 5 分钟）
```

FAIR 以少量的 Job A 性能损失（5 分钟），换取了 Job B 延迟从 2 小时降到 10 秒——这在多租户共享集群中是极高价值的权衡。

---

## 第 2 章 核心数据结构：Schedulable 与 Pool 的层级树

### 2.1 Schedulable：一切可被调度对象的抽象

任何可以被 `TaskScheduler` 调度的对象都实现了 `Schedulable` 接口：

```scala
// org.apache.spark.scheduler.Schedulable.scala
private[spark] trait Schedulable {
  var parent: Pool  // 父节点（构成树形结构）

  // 调度属性
  def schedulingMode: SchedulingMode  // 本节点内部的调度模式（FIFO 或 FAIR）
  def weight: Int                     // 权重（FAIR 模式下的资源分配比例）
  def minShare: Int                   // 最小资源保障（至少保证运行这么多 Task）
  def runningTasks: Int               // 当前正在运行的 Task 数量
  def priority: Int                   // 优先级（FIFO 模式下使用，值越小越优先）
  def stageId: Int                    // Stage ID（同 Job 内按 Stage 排序）

  // 核心方法
  def getSortedTaskSetQueue: ArrayBuffer[TaskSetManager]
  // 按当前调度算法排序，返回所有叶节点 TaskSetManager 的有序列表

  def addSchedulable(schedulable: Schedulable): Unit
  def removeSchedulable(schedulable: Schedulable): Unit
  def getSchedulableByName(name: String): Schedulable
}
```

`Schedulable` 有两个实现类：
- **`Pool`**：中间节点，可以包含子 `Pool` 或 `TaskSetManager`（叶节点）
- **`TaskSetManager`**：叶节点，代表一个 Stage 的 Task 集合

### 2.2 Pool：调度树的骨架

`Pool` 是 Spark 调度算法的核心容器，它维护了一个子节点（子 Pool 或 TaskSetManager）的集合，并按自身的 `schedulingMode` 对子节点进行排序：

```scala
private[spark] class Pool(
    val poolName: String,
    val schedulingMode: SchedulingMode,  // 本 Pool 内部使用 FIFO 还是 FAIR
    initMinShare: Int,
    initWeight: Int
) extends Schedulable {

  val schedulableQueue = new ConcurrentLinkedQueue[Schedulable]()
  val schedulableNameToSchedulable = new ConcurrentHashMap[String, Schedulable]()
  
  var weight = initWeight    // 在父 Pool 的 FAIR 调度中，本 Pool 的权重
  var minShare = initMinShare  // 在父 Pool 的 FAIR 调度中，本 Pool 的保底资源

  override def getSortedTaskSetQueue: ArrayBuffer[TaskSetManager] = {
    // 对子节点按 schedulingMode 排序
    val sortedSchedulables = schedulableQueue.toList.sortWith(taskSetSchedulingAlgorithm.comparator)
    val sortedTaskSetQueue = new ArrayBuffer[TaskSetManager]
    for (schedulable <- sortedSchedulables) {
      // 递归收集所有叶节点
      sortedTaskSetQueue ++= schedulable.getSortedTaskSetQueue
    }
    sortedTaskSetQueue
  }
}
```

### 2.3 调度树的形态

**FIFO 模式**的调度树极简：
```
rootPool（FIFO）
  ├── TaskSetManager（Stage 0 of Job 0）
  ├── TaskSetManager（Stage 1 of Job 0）
  └── TaskSetManager（Stage 0 of Job 1）
```
所有 TaskSetManager 直接挂在 rootPool 下，按 jobId + stageId 排序。

**FAIR 模式**的调度树支持多级结构：
```
rootPool（FAIR）
  ├── Pool "production"（FIFO, weight=10, minShare=50）
  │    ├── TaskSetManager（high-priority ETL）
  │    └── TaskSetManager（reporting job）
  └── Pool "test"（FAIR, weight=1, minShare=0）
       ├── TaskSetManager（developer test job 1）
       └── TaskSetManager（developer test job 2）
```
rootPool 用 FAIR 算法在 production 和 test 两个池之间分配资源，production 池内部用 FIFO，test 池内部用 FAIR。

---

## 第 3 章 FIFO 调度算法：极简主义的先来后到

### 3.1 FIFOSchedulingAlgorithm 源码

```scala
// org.apache.spark.scheduler.FIFOSchedulingAlgorithm.scala
private[spark] class FIFOSchedulingAlgorithm extends SchedulingAlgorithm {

  override def comparator(s1: Schedulable, s2: Schedulable): Boolean = {
    // 第一排序键：priority（对应 Job ID，越小越先提交）
    val priority1 = s1.priority
    val priority2 = s2.priority
    var res = math.signum(priority1 - priority2)
    
    if (res == 0) {
      // 第二排序键：stageId（同一 Job 内，Stage ID 越小越先执行）
      val stageId1 = s1.stageId
      val stageId2 = s2.stageId
      res = math.signum(stageId1 - stageId2)
    }
    
    // 返回 true 表示 s1 优先于 s2
    res < 0
  }
}
```

**为什么 priority = Job ID？**

在 `DAGScheduler.submitJob` 中，每个 Job 的 `jobId = nextJobId.getAndIncrement()`，是一个递增的计数器。先提交的 Job 有更小的 ID，因此有更高的优先级（更小的 `priority` 值在 FIFO 中优先）。

**为什么第二排序键是 stageId？**

在同一个 Job 内，可能有多个 Stage 同时处于"可运行"状态（如 Stage 0 和 Stage 1 都没有依赖）。Stage ID 更小的通常是更早被创建的，按 Stage ID 排序保证同一 Job 内 Stage 的执行顺序是确定的。

### 3.2 FIFO 的性能特点

| 指标 | FIFO 表现 | 说明 |
| :--- | :--- | :--- |
| **单作业吞吐量** | 最佳 | 一个 Job 独占所有资源，无资源切换开销 |
| **短作业延迟** | 差（被长作业阻塞） | 长作业运行期间，短作业完全得不到资源 |
| **实现复杂度** | 极低 | 一个简单的两键排序 |
| **调度开销** | 极低 | 无需维护额外状态 |
| **适用场景** | 独占集群的批处理 | 不存在并发 Job 竞争资源时最优 |

---

## 第 4 章 FAIR 调度算法：数学上的公平性保证

### 4.1 FAIR 的核心目标

FAIR 调度算法的目标是：在多个并发 Job 之间，**按权重比例分配资源，同时保证每个 Job 的最低资源需求（minShare）得到满足**。

这个目标来自操作系统的公平调度思想（Linux CFS - Completely Fair Scheduler），Spark 的 FAIR 算法是其简化版。

### 4.2 FairSchedulingAlgorithm 完整源码解析

```scala
// org.apache.spark.scheduler.FairSchedulingAlgorithm.scala
private[spark] class FairSchedulingAlgorithm extends SchedulingAlgorithm {

  override def comparator(s1: Schedulable, s2: Schedulable): Boolean = {
    val minShare1 = s1.minShare
    val minShare2 = s2.minShare
    val runningTasks1 = s1.runningTasks
    val runningTasks2 = s2.runningTasks
    val s1Needy = runningTasks1 < minShare1  // s1 是否"饥饿"（运行中 Task 少于保底）
    val s2Needy = runningTasks2 < minShare2  // s2 是否"饥饿"

    // 第一排序键：minShare 满足度（饥饿的优先）
    val compare = if (s1Needy && !s2Needy) {
      true   // s1 饥饿而 s2 不饥饿：s1 优先
    } else if (!s1Needy && s2Needy) {
      false  // s1 不饥饿而 s2 饥饿：s2 优先
    } else {
      // 两者都饥饿，或两者都不饥饿：进入第二排序键
      
      // 第二排序键：资源饱和度（runningTasks / weight）
      // 含义：按权重归一化后的"已获得资源量"
      // 值越小表示获得的资源越少（相对于权重），应该优先获得资源
      val minShareRatio1 = runningTasks1.toDouble / math.max(minShare1, 1.0)
      val minShareRatio2 = runningTasks2.toDouble / math.max(minShare2, 1.0)
      
      val taskToWeightRatio1 = runningTasks1.toDouble / s1.weight.toDouble
      val taskToWeightRatio2 = runningTasks2.toDouble / s2.weight.toDouble
      
      var res: Boolean = false
      if (s1Needy && s2Needy) {
        // 两者都饥饿：看 minShare 完成度（谁更需要资源）
        res = minShareRatio1 < minShareRatio2
      } else {
        // 两者都不饥饿：看 weight 归一化后的资源占用（谁的资源相对权重最少）
        res = taskToWeightRatio1 < taskToWeightRatio2
      }
      
      // 第三排序键（平局处理）：回退到名称字符串比较，保证排序的确定性
      if (res == (minShareRatio1 == minShareRatio2) || 
          res == (taskToWeightRatio1 == taskToWeightRatio2)) {
        res = s1.name < s2.name
      }
      res
    }
    
    compare
  }
}
```

### 4.3 FAIR 算法的直觉理解

用一个具体例子解释：

**配置**：
- Pool A：weight=4，minShare=10
- Pool B：weight=1，minShare=2
- 集群总 CPU 核：100

**初始状态**（两个池都空闲）：
- A.runningTasks=0（< minShare=10，饥饿）
- B.runningTasks=0（< minShare=2，饥饿）
- 两者都饥饿，按 minShare 完成度排序：0/10=0 vs 0/2=0 → 相等，按名称排序

**当 Pool A 获得 5 个 Task 后**：
- A.runningTasks=5（< minShare=10，仍然饥饿）
- B.runningTasks=0（< minShare=2，饥饿）
- minShareRatio: A=5/10=0.5, B=0/2=0 → B 的完成度更低，B 优先

**当 A 获得 10、B 获得 2 个 Task 后**（都满足 minShare）：
- A.runningTasks=10（≥ minShare=10，不饥饿）
- B.runningTasks=2（≥ minShare=2，不饥饿）
- 两者都不饥饿，按 weight 归一化比较：A=10/4=2.5, B=2/1=2 → B 的比值更小，B 优先

**稳定状态**（FAIR 算法期望的分布）：
- 资源按权重比例分配：A 获得 80 个 Task（80/4=20），B 获得 20 个 Task（20/1=20）
- 在稳定状态下，`runningTasks/weight` 两者相等，即真正的"按比例公平"

> [!info] 为什么叫"饥饿优先"？
> `minShare` 是"最低资源保障线"。当一个 Pool 的运行 Task 数低于 minShare 时，说明它连最低保障都没达到，处于"资源饥饿"状态。FAIR 算法优先解除饥饿状态，确保每个 Pool 的基本权益。只有在所有 Pool 的 minShare 都满足后，才按 weight 比例分配剩余资源。

---

## 第 5 章 多级资源池的生产配置：fairscheduler.xml 深度解析

### 5.1 配置文件结构

```xml
<?xml version="1.0"?>
<allocations>
  <!-- 生产业务线：高权重，有最低保障 -->
  <pool name="production">
    <schedulingMode>FIFO</schedulingMode>  <!-- 生产内部按 FIFO：先提交先运行 -->
    <weight>10</weight>                    <!-- 相对权重：是 test 池的 10 倍资源 -->
    <minShare>20</minShare>                <!-- 最少保证 20 个并发 Task -->
  </pool>

  <!-- 实时查询：低延迟要求，给予一定保障 -->
  <pool name="realtime">
    <schedulingMode>FAIR</schedulingMode>  <!-- 内部公平竞争 -->
    <weight>5</weight>
    <minShare>10</minShare>
  </pool>

  <!-- 开发测试：最低优先级，无保障 -->
  <pool name="dev">
    <schedulingMode>FAIR</schedulingMode>
    <weight>1</weight>
    <minShare>0</minShare>
  </pool>
</allocations>
```

**配置解读**：
- 在三个池都有 Task 运行时，FAIR 算法会在它们之间按 10:5:1 的比例分配资源
- `production` 的 minShare=20 确保生产 Job 在任何情况下至少有 20 个 Task 在运行
- `dev` 的 minShare=0 意味着当 production 和 realtime 池的 minShare 未满足时，dev 池的 Task 可能完全无法运行（资源被完全让出）

### 5.2 代码中绑定 Pool

```scala
// 方式一：为当前线程的所有 Job 设置调度池
sc.setLocalProperty("spark.scheduler.pool", "production")
rdd.count()  // 这个 Job 会被提交到 production 池

// 方式二：在 SparkSession 中设置（Spark SQL）
spark.sparkContext.setLocalProperty("spark.scheduler.pool", "realtime")
spark.sql("SELECT count(*) FROM orders").show()

// 方式三：重置为默认池
sc.setLocalProperty("spark.scheduler.pool", null)
```

`LocalProperty` 是线程局部变量（Thread Local），只影响当前线程触发的 Job，不影响其他线程。

### 5.3 生产配置的常见误区

**误区一：minShare 设置过大**
```xml
<!-- 危险配置 -->
<pool name="p1"><minShare>80</minShare></pool>
<pool name="p2"><minShare>80</minShare></pool>
<!-- 总 minShare = 160 > 集群总核数 100
     导致两个池都永远处于"饥饿"状态，FAIR 退化为 minShare 完成度比较的无限循环 -->
```
**经验法则**：所有池的 minShare 之和不超过集群总核数的 80%。

**误区二：weight 设为 0**
```xml
<pool name="dev"><weight>0</weight></pool>
<!-- weight=0 会导致除以零的问题（taskToWeightRatio = runningTasks / 0）
     Spark 实现中用 math.max(weight, 1) 保护，实际效果等同于 weight=1 -->
```

**误区三：混用 FIFO 和 FAIR 时的优先级错误**

Pool 内部的 schedulingMode 只影响该 Pool 内部子节点的排序，不影响该 Pool 在父 Pool 中的优先级。

---

## 第 6 章 调度算法在生产环境中的实战策略

### 6.1 典型的多租户 Spark 集群配置

```
集群总资源：500 Executor，每个 4 核 = 2000 核

业务池配置：
┌──────────────────┬────────┬──────────┬─────────────────────────────┐
│ Pool名称          │ weight │ minShare │ 适用场景                     │
├──────────────────┼────────┼──────────┼─────────────────────────────┤
│ critical         │   50   │   200    │ 关键 SLA 作业（不能延迟）      │
│ production       │   20   │   100    │ 日常生产 ETL                 │
│ realtime         │   10   │    50    │ 实时报表查询                  │
│ adhoc            │    5   │     0    │ 即席查询（可以等）             │
│ dev              │    1   │     0    │ 开发测试                     │
└──────────────────┴────────┴──────────┴─────────────────────────────┘

注：critical + production + realtime 的 minShare 合计 350 < 2000，安全
```

### 6.2 动态调整优先级的方法

FAIR 调度算法是静态配置（基于 `fairscheduler.xml`），但可以通过以下方式实现动态优先级：

**动态切换 Pool**：
```scala
// 运行时根据 SLA 要求动态分配到不同 Pool
def submitWithSLA(slaLevel: String)(action: => Unit): Unit = {
  val pool = slaLevel match {
    case "critical" => "critical"
    case "normal" => "production"
    case _ => "dev"
  }
  sc.setLocalProperty("spark.scheduler.pool", pool)
  action
  sc.setLocalProperty("spark.scheduler.pool", null)
}
```

**临时调整 weight**（运行时，不需要重启集群）：
```scala
// 通过 SparkContext 的调度接口临时修改权重（实验性 API）
sc.getPoolForName("adhoc").foreach(_.weight = 10)
```

---

## 第 7 章 总结

FIFO 和 FAIR 两种调度模式代表了两种截然不同的资源分配哲学：

- **FIFO**：简单、高效、吞吐量最大，但严重牺牲了并发性和公平性。适合独占集群的批处理场景。
- **FAIR**：通过 minShare + weight 的双重保障机制，在多租户场景下提供可预期的资源分配保证，以少量吞吐量损失换取显著的公平性和响应性提升。

核心调优原则：
1. **minShare 是底线，不要设太高**：确保所有关键 Pool 的 minShare 总和不超过集群总核数的 80%
2. **weight 是比例，看相对值而非绝对值**：weight=10 和 weight=1 的效果等同于 weight=100 和 weight=10
3. **Pool 内部调度模式的选择**：生产批处理 Pool 内部用 FIFO（稳定、可预期），多用户共享 Pool 内部用 FAIR（资源均衡）

在 **[[06 Task 运行生命周期：从 TaskSetManager 分发到 Executor 端执行|下一篇文章]]** 中，我们将从"调度"进入"执行"，追踪单个 Task 从 Driver 侧被选出、序列化、通过网络发送，到 Executor 侧被反序列化、执行、结果返回的完整生命周期。

---

> [!note] 思考题
> 1. 假设集群有 100 个 CPU 核，Pool A（weight=3，minShare=0）正在运行 90 个 Task，Pool B（weight=1，minShare=0）正在运行 10 个 Task。此时 FAIR 算法会认为 A 和 B 谁更应该获得下一个空闲资源？计算 `taskToWeightRatio`：A=90/3=30，B=10/1=10。B 的比值更小，B 优先。这符合"按 3:1 比例公平分配"的目标吗？
> 2. 如果将 Pool A 的 minShare 设为 60，Pool B 的 minShare 设为 40，集群总核为 100。此时 A 运行 50 个 Task（饥饿），B 运行 30 个 Task（饥饿）。FAIR 算法选择哪个 Pool 优先？为什么？在 minShare 总和等于集群总核的情况下，FAIR 算法的稳定状态是什么样的？
> 3. 在同一个 Pool 内部使用 FAIR 调度的场景下，两个 Stage（不同 Job）同时运行时，FAIR 算法是在 TaskSetManager 级别（单个 Stage）还是 Pool 级别进行资源分配？如果是在 TaskSetManager 级别，各 TaskSetManager 的 weight 是什么？
