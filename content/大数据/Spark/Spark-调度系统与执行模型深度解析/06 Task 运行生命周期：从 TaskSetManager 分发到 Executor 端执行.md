---
title: "06 Task 运行生命周期：从 TaskSetManager 分发到 Executor 端执行"
date: 2026-02-27
tags: [Executor, Spark, Task, TaskRunner, TaskSetManager, 调度系统]
aliases: [Task Lifecycle]
---

# 06 Task 运行生命周期：从 TaskSetManager 分发到 Executor 端执行

> [!abstract] 摘要
> 前几篇文章从宏观视角解析了 Spark 调度系统的架构：DAGScheduler 划分 Stage、TaskScheduler 分配资源、SchedulerBackend 对接集群。本文将视角聚焦到最微观的单元——**单个 Task 的完整生命周期**。一个 Task 从逻辑上被 `TaskSetManager` 选中，到物理上在 Executor 的 CPU 线程中运行，中间经历了哪些关键步骤？序列化时闭包的"陷阱"在哪里？`TaskContext` 扮演什么角色？`TaskRunner` 的执行链路是什么？ShuffleMapTask 和 ResultTask 在执行路径上有何本质差异？Task 失败后 attempt 机制如何保证前向推进？这些是真正理解 Spark 执行模型、定位生产问题的基础。

---

## 第 1 章 Task 是什么：分布式计算的原子单元

### 1.1 Task 的精确定义

Task 是 Spark 执行模型中**最小的、不可再分的工作单元**。它的三个组成要素：

1. **目标分区（Partition）**：Task 负责处理 Stage 中某一个特定的数据分区（通过分区 ID 标识）
2. **执行闭包（Closure）**：RDD 的 `compute` 函数 + Stage 内所有算子的函数组合
3. **执行上下文（Context）**：广播变量、累加器引用、数据本地性偏好、Task Metrics 等

一个 Stage 有多少个分区，就有多少个 Task（`numTasks = rdd.partitions.length`）。所有这些 Task 在逻辑上执行完全相同的计算逻辑，只是作用于不同的数据分区——这正是 Spark 并行计算的本质。

### 1.2 Task 的两种形态

Spark 的 Task 有两种具体实现，对应 Stage 的两种类型：

**ShuffleMapTask**（对应 ShuffleMapStage）：
- 执行 RDD 的 `compute` 方法，将分区数据按照 Partitioner 写入本地磁盘的 Shuffle 文件
- 完成后向 Driver 汇报 `MapStatus`（每个输出分区的数据量和位置）
- 不直接返回数据给 Driver，只生产 Shuffle 中间数据

**ResultTask**（对应 ResultStage）：
- 执行 RDD 的 `compute` 方法，将结果通过 Action 函数处理
- 将结果（或结果的序列化字节）直接返回给 Driver（如 `collect`）或写入外部存储（如 `saveAsTextFile`）
- 完成后通知 `JobWaiter` 该分区已完成

### 1.3 Task 的状态机

```
PENDING（等待分配）
    ↓ 被 TaskScheduler 选中，LaunchTask 发往 Executor
RUNNING（Executor 端执行中）
    ├── 成功完成 → FINISHED（StatusUpdate: FINISHED）
    ├── 用户代码异常 → FAILED（StatusUpdate: FAILED，可重试）
    ├── OOM / 进程崩溃 → LOST（心跳超时，可重试）
    └── 被 kill → KILLED（推测执行取消，不计入失败次数）
```

每个**逻辑 Task**（一个分区的计算）可以有多个 **Attempt**（尝试），对应同一个分区的不同执行实例。Spark UI 中看到的 `task 23.1` 表示分区 23 的第 2 次尝试（attempt=1）。

---

## 第 2 章 Driver 侧：Task 的选中、封装与发送

### 2.1 Task 如何被选中：dequeueTask 的完整决策

当 `TaskSchedulerImpl.resourceOffers` 收到 Resource Offer 后，它调用 `TaskSetManager.resourceOffer`，后者调用 `dequeueTask` 从等待队列中选出一个 Task。

`TaskSetManager` 内部维护了多个按本地化级别分类的 pending Task 队列：

```scala
// TaskSetManager 内部的本地化队列
private val pendingTasksForExecutor = new HashMap[String, ArrayBuffer[Int]]
// Key: executorId, Value: 该 Executor 上有数据的 Task 分区 ID 列表
// 对应 PROCESS_LOCAL（Task 的数据在该 Executor 的内存中，如 cached RDD）

private val pendingTasksForHost = new HashMap[String, ArrayBuffer[Int]]
// Key: host, Value: 该 Host 上有数据的 Task 分区 ID 列表
// 对应 NODE_LOCAL（数据在同一节点的磁盘上，如 HDFS 本地副本）

private val pendingTasksForRack = new HashMap[String, ArrayBuffer[Int]]
// Key: rack, Value: 同机架上有数据的 Task 分区 ID 列表
// 对应 RACK_LOCAL

private val pendingTasksWithNoPrefs = new ArrayBuffer[Int]
// 没有数据本地性偏好的 Task（如从 S3/OSS 读取，无本地性概念）
// 对应 NO_PREF

private val allPendingTasks = new ArrayBuffer[Int]
// 所有等待执行的 Task（ANY 级别的兜底队列）
```

**这些队列是如何初始化的？**

在 `TaskSetManager` 创建时，它调用 `addPendingTask` 为每个 Task 计算其本地性偏好，并加入对应队列：

```scala
private def addPendingTask(index: Int, resolveRacks: Boolean = true): Unit = {
  // 从 Task 的 preferredLocations 获取偏好位置
  for (loc <- tasks(index).preferredLocations) {
    loc match {
      case e: ExecutorCacheTaskLocation =>
        // 数据在某个 Executor 的内存中（cached RDD）→ PROCESS_LOCAL
        pendingTasksForExecutor.getOrElseUpdate(e.executorId, ArrayBuffer()) += index
        
      case e: HDFSCacheTaskLocation =>
        // HDFS 本地缓存 → 类似 NODE_LOCAL
        val exe = sched.getExecutorsAliveOnHost(e.host)
        exe.foreach { execId =>
          pendingTasksForExecutor.getOrElseUpdate(execId, ArrayBuffer()) += index
        }
        
      case _ =>
        // 普通 HOST 位置偏好 → NODE_LOCAL
        val hostList = pendingTasksForHost.getOrElseUpdate(loc.host, ArrayBuffer())
        hostList += index
    }
  }
  
  if (tasks(index).preferredLocations.isEmpty) {
    pendingTasksWithNoPrefs += index  // 无偏好
  }
  
  allPendingTasks += index  // 无论如何都加入 ANY 队列
}
```

### 2.2 TaskDescription：Task 的"邮包"

被选中的 Task 被封装为 `TaskDescription`，这是 Task 在网络上传输的完整载体：

```scala
private[spark] class TaskDescription(
    val taskId: Long,             // 全局唯一 Task ID（jobId + stageId + partitionId + attemptId 组合）
    val attemptNumber: Int,        // attempt 编号（0=首次，1=第一次重试，...）
    val executorId: String,        // 目标 Executor ID
    val name: String,              // 可读名称（用于 UI 显示）
    val index: Int,                // 在 TaskSet 中的索引
    val partitionId: Int,          // 对应的分区 ID
    val addedFiles: Map[String, Long],    // 需要下载的文件（用户通过 sc.addFile 添加的）
    val addedJars: Map[String, Long],     // 需要下载的 JAR（用户通过 sc.addJar 添加的）
    val addedArchives: Map[String, Long], // 需要下载的归档文件
    val properties: Properties,   // 调度属性（Pool 名称等）
    val cpus: Int,                 // Task 需要的 CPU 核数
    val resources: Map[String, ResourceInformation],  // GPU 等自定义资源需求
    val serializedTask: ByteBuffer // 序列化的 Task 对象（闭包 + 分区元数据）
)
```

**`serializedTask` 的内容**：这是整个 Task 的"灵魂"，包含了序列化后的 Task 对象（`ShuffleMapTask` 或 `ResultTask`），其中又包含了：
- `taskBinary`：Stage 内所有 RDD 的依赖链（序列化的 RDD 对象） + 用户函数闭包
- `partition`：目标分区的 `Partition` 对象
- `locs`：偏好执行位置

**闭包序列化的"陷阱"**：

当用户编写 `rdd.map(record => record.value + helper.compute())` 时，`helper` 对象如果不是 `Serializable`，就会导致 `Task not serializable` 异常。更危险的是，如果 `helper` 持有了对 `SparkContext` 的隐式引用（如在闭包中使用了外部类的方法），序列化时会尝试序列化整个 `SparkContext`，导致 JVM OOM 或超长序列化时间：

```scala
// 危险写法：闭包捕获了 this（外部类实例）
class MyJob(sc: SparkContext) {
  val rdd = sc.textFile("data.txt")

  def run(): Unit = {
    // 这个闭包捕获了 this（MyJob 实例），而 MyJob 持有 SparkContext
    // 序列化闭包时会尝试序列化整个 MyJob + SparkContext → OOM 或 Task not serializable
    rdd.map(line => this.processLine(line)).count()
  }

  def processLine(line: String): String = line.toUpperCase
}

// 安全写法：在本地提取需要的函数引用
class MyJob(sc: SparkContext) {
  def run(): Unit = {
    val rdd = sc.textFile("data.txt")
    val processFn = processLine _  // 提取方法引用，不捕获 this
    rdd.map(processFn).count()
  }
  def processLine(line: String): String = line.toUpperCase
}
```

---

## 第 3 章 网络传输：Task 从 Driver 到 Executor

### 3.1 LaunchTask 消息的传递路径

```
Driver 端：
TaskSchedulerImpl.resourceOffers → TaskDescription 生成
                    ↓
CoarseGrainedSchedulerBackend.launchTasks
                    ↓
executor.executorEndpoint.send(LaunchTask(serializedTaskDescription))
  [通过 Netty RPC 框架发送到目标 Executor]
                    ↓（网络传输）
Executor 端：
CoarseGrainedExecutorBackend.receive
  case LaunchTask(data) =>
    executor.launchTask(context, data.deserialize())
```

### 3.2 Executor 接收 Task 后的处理

`CoarseGrainedExecutorBackend.receive` 处理 `LaunchTask` 消息：

```scala
// CoarseGrainedExecutorBackend.scala
override def receive: PartialFunction[Any, Unit] = {
  case LaunchTask(data) =>
    if (executor == null) {
      exitExecutor(1, "Received LaunchTask command but executor was null")
    } else {
      val taskDesc = TaskDescription.decode(data.value)
      logInfo("Got assigned task " + taskDesc.taskId)
      taskResources(taskDesc.taskId) = taskDesc.resources
      executor.launchTask(this, taskDesc)
    }
}
```

`Executor.launchTask` 创建 `TaskRunner` 并提交到线程池：

```scala
// Executor.scala
def launchTask(context: ExecutorBackend, taskDescription: TaskDescription): Unit = {
  val tr = new TaskRunner(context, taskDescription, plugins)
  runningTasks.put(taskDescription.taskId, tr)
  threadPool.execute(tr)  // 提交到 Executor 内部线程池，异步执行
}
```

---

## 第 4 章 Executor 侧：TaskRunner 的完整执行链路

### 4.1 TaskRunner 是什么

`TaskRunner` 是一个 `Runnable`，代表一次 Task 执行尝试。每个 `TaskRunner` 实例对应一个 Task Attempt，在 Executor 内部的线程池中运行。

`TaskRunner.run()` 是整个 Task 执行的"总控"：

```scala
// Executor.TaskRunner.run()（核心流程，简化）
override def run(): Unit = {
  threadId = Thread.currentThread.getId
  Thread.currentThread.setName(threadName)
  
  // 步骤一：更新任务度量（Metrics）基准线
  val threadMXBean = ManagementFactory.getThreadMXBean
  val taskMemoryManager = new TaskMemoryManager(env.memoryManager, taskId)
  val deserializeStartTimeNs = System.nanoTime()
  
  // 步骤二：反序列化 Task（还原 RDD 血缘链和用户闭包）
  Thread.currentThread.setContextClassLoader(replClassLoader)
  val ser = env.closureSerializer.newInstance()
  logInfo(s"Running $taskName (TID $taskId)")
  
  // 向 Driver 报告 Task 开始运行
  execBackend.statusUpdate(taskId, TaskState.RUNNING, EMPTY_BYTE_BUFFER)
  
  var taskStartTimeNs: Long = 0
  var taskStartCpu: Long = 0
  startGCTime = computeTotalGcTime()
  
  try {
    // 核心反序列化：还原 Task 对象（含 RDD 依赖链 + 用户函数）
    val (taskFiles, taskJars, taskProps, taskDescription) = Task.deserializeWithDependencies(
      serializedTask)
    
    updateDependencies(taskFiles, taskJars)  // 下载依赖文件/JAR
    
    task = ser.deserialize[Task[Any]](
      taskDescription, Thread.currentThread.getContextClassLoader)
    task.localProperties = taskProps
    task.setTaskMemoryManager(taskMemoryManager)
    
    // 步骤三：创建 TaskContext（Task 的执行上下文）
    val taskContext = new TaskContextImpl(
      stageId = task.stageId,
      stageAttemptNumber = task.stageAttemptId,
      partitionId = task.partitionId,
      taskAttemptId = taskId,
      attemptNumber = attemptNumber,
      taskMemoryManager = taskMemoryManager,
      localProperties = localProperties,
      metricsSystem = env.metricsSystem,
      taskMetrics = taskMetrics,
      cpus = cpus,
      resources = resources)
    TaskContext.setTaskContext(taskContext)
    
    // 步骤四：执行 Task（ShuffleMapTask 或 ResultTask）
    taskStartTimeNs = System.nanoTime()
    taskStartCpu = if (threadMXBean.isCurrentThreadCpuTimeSupported) {
      threadMXBean.getCurrentThreadCpuTime
    } else 0L
    
    val value = Utils.tryWithSafeFinally {
      val res = task.run(
        taskAttemptId = taskId,
        attemptNumber = attemptNumber,
        metricsSystem = env.metricsSystem,
        cpus = cpus,
        resources = resources,
        plugins = plugins)
      threwException = false
      res
    } {
      // finally：清理 TaskContext，释放内存
      val releasedLocks = env.blockManager.releaseAllLocksForTask(taskId)
      val freedMemory = taskMemoryManager.cleanUpAllAllocatedMemory()
      ...
    }
    
    // 步骤五：收集结果，汇报给 Driver
    val resultSer = env.serializer.newInstance()
    val beforeSerialization = System.nanoTime()
    val valueBytes = resultSer.serialize(value)
    
    if (valueBytes.limit() > TaskResultBlockId.MAX_DIRECT_SIZE) {
      // 结果太大，先存入 BlockManager，Driver 来拉取
      val blockId = TaskResultBlockId(taskId)
      env.blockManager.putBytes(blockId, valueBytes, StorageLevel.MEMORY_AND_DISK_SER)
      execBackend.statusUpdate(taskId, TaskState.FINISHED,
        ser.serialize(IndirectTaskResult[Any](blockId, ...)))
    } else {
      // 结果直接通过 RPC 返回
      execBackend.statusUpdate(taskId, TaskState.FINISHED,
        ser.serialize(DirectTaskResult[Any](valueBytes, accumUpdates, ...)))
    }
    
  } catch {
    case ffe: FetchFailedException =>
      // Shuffle 读取失败，上报 FAILED 状态（触发 Stage 重算）
      execBackend.statusUpdate(taskId, TaskState.FAILED, ser.serialize(ffe.toTaskFailedReason))
      
    case _: TaskKilledException =>
      // Task 被 kill（推测执行取消），上报 KILLED 状态（不计入失败次数）
      execBackend.statusUpdate(taskId, TaskState.KILLED, ...)
      
    case t: Throwable =>
      // 其他异常，上报 FAILED 状态
      execBackend.statusUpdate(taskId, TaskState.FAILED, ...)
  }
}
```

### 4.2 ShuffleMapTask.run()：生产 Shuffle 数据

```scala
// ShuffleMapTask.runTask()（简化）
override def runTask(context: TaskContext): MapStatus = {
  // 反序列化 RDD 和依赖链
  val ser = SparkEnv.get.closureSerializer.newInstance()
  val (rdd, dep) = ser.deserialize[(RDD[_], ShuffleDependency[_, _, _])](
    ByteBuffer.wrap(taskBinary.value), Thread.currentThread.getContextClassLoader)
  
  // 计算当前分区数据（沿 RDD 血缘链拉取数据并计算）
  val data: Iterator[Product2[Any, Any]] = rdd.iterator(partition, context)
  
  // 将计算结果写入 Shuffle 文件
  dep.shuffleWriterProcessor.write(rdd, dep, partition.index, context, partition)
  // 内部调用 ShuffleWriter（如 SortShuffleWriter）将数据排序后写入磁盘
  
  // 向 MapOutputTracker 汇报输出位置
  return MapStatus(SparkEnv.get.blockManager.shuffleServerId, ...)
}
```

**关键链路**：`rdd.iterator(partition, context)` 触发了整个 RDD 血缘链的懒计算，数据从最底层（如 HadoopRDD 读取 HDFS 文件）流向顶层，通过 Iterator 链路的 `next()` 调用逐条处理（这正是第 06 篇 RDD Iterator 模型的工程体现）。

### 4.3 ResultTask.run()：生产最终结果

```scala
// ResultTask.runTask()（简化）
override def runTask(context: TaskContext): U = {
  val ser = SparkEnv.get.closureSerializer.newInstance()
  val (rdd, func) = ser.deserialize[(RDD[T], (TaskContext, Iterator[T]) => U)](
    ByteBuffer.wrap(taskBinary.value), Thread.currentThread.getContextClassLoader)
  
  // 触发 RDD 血缘链计算，将结果传给 func（用户的 Action 函数）
  func(context, rdd.iterator(partition, context))
}
```

例如 `collect()` 对应的 func 是 `(context, iter) => iter.toArray`，直接将整个分区的数据收集为数组。

---

## 第 5 章 TaskContext：Task 内部的"共享黑板"

### 5.1 TaskContext 的作用

`TaskContext` 是 Task 执行期间的"上下文对象"，通过 ThreadLocal 绑定到当前 Task 的执行线程，在整个执行过程中可以被用户代码和框架代码访问：

```scala
// TaskContext 提供的核心能力
abstract class TaskContext extends Serializable {
  def isCompleted(): Boolean     // Task 是否已完成
  def isInterrupted(): Boolean   // Task 是否被 kill
  def taskAttemptId(): Long      // 当前 attempt 的 Task ID
  def stageId(): Int             // Stage ID
  def partitionId(): Int         // 分区 ID
  def attemptNumber(): Int       // attempt 编号

  // 注册 Task 完成时的回调（用于资源清理）
  def addTaskCompletionListener[U](f: TaskContext => U): TaskContext

  // 注册 Task 失败时的回调
  def addTaskFailureListener(f: (TaskContext, Throwable) => Unit): TaskContext

  // 获取 Task 运行指标（输入/输出字节数、记录数、Shuffle 读写等）
  def taskMetrics(): TaskMetrics
  
  // 获取累加器（Accumulator）
  def getLocalProperty(key: String): String
}
```

**典型用法**：在 `mapPartitions` 中使用 `TaskContext` 进行资源管理：

```scala
rdd.mapPartitions { iter =>
  val context = TaskContext.get()  // 获取当前 Task 的 TaskContext
  
  // 创建需要清理的资源（如数据库连接）
  val conn = createDatabaseConnection()
  
  // 注册 Task 完成时的清理回调
  context.addTaskCompletionListener[Unit] { _ =>
    conn.close()  // Task 完成时（无论成功还是失败）自动关闭连接
  }
  
  iter.map { record =>
    conn.lookup(record.key)  // 使用连接处理数据
  }
}
```

这种模式是 Spark 中管理外部资源的标准姿势——**不要在 mapPartitions 的闭包外部管理资源，而是通过 `addTaskCompletionListener` 确保资源在任何情况下都被正确清理**。

---

## 第 6 章 Task 失败与 Attempt 机制

### 6.1 失败的分类与处理

`TaskSetManager` 收到 Task 失败通知后，根据失败类型决定如何处理：

```scala
// TaskSetManager.handleFailedTask（简化）
def handleFailedTask(tid: Long, state: TaskState, reason: TaskFailedReason): Unit = {
  val info = taskInfos(tid)
  val index = info.index
  
  reason match {
    case FetchFailed(bmAddress, shuffleId, mapId, reduceId, failureMessage) =>
      // Shuffle 读取失败：这是 Stage 级别的错误，通知 DAGScheduler
      // TaskSetManager 本身不做 Task 级别的重试
      sched.dagScheduler.taskEnded(tasks(index), reason, null, ...)
      
    case ExceptionFailure(className, description, stackTrace, ...) =>
      // 用户代码异常：可以重试
      if (numFailures(index) >= maxTaskFailures) {
        // 超过最大重试次数，终止整个 TaskSet
        abort(s"Task ${info.id} in stage ${taskSet.id} failed $maxTaskFailures times...")
      } else {
        // 重新加入等待队列（下次 resourceOffer 时重新分配）
        addPendingTask(index)
      }
      
    case TaskKilled(reason) =>
      // Task 被 kill（如推测执行）：不计入失败次数
      // 只是将 Task 重新加入等待队列（如果还需要）
      
    case ExecutorLostFailure(execId, exitCausedByApp, reason) =>
      // Executor 丢失：Task 重新入队
      // 若 exitCausedByApp=false（集群故障，不是应用代码导致），不计入应用失败次数
      if (!exitCausedByApp) {
        numFailures(index) -= 1  // 不算这次失败
      }
      addPendingTask(index)
  }
}
```

### 6.2 最大失败次数与 Stage 终止

```scala
// 配置
spark.task.maxFailures = 4  // 同一个 Task 最多允许 4 次失败（默认值）

// 当某个 Task 的 numFailures(index) >= maxTaskFailures 时：
// TaskSetManager.abort() 被调用
// → DAGScheduler.taskSetFailed() 被调用
// → Job 被标记为失败
// → jobWaiter.jobFailed(exception) 被调用
// → runJob 的阻塞 await 返回异常
// → 用户代码收到 SparkException
```

### 6.3 Attempt 机制的容错语义

同一个分区的 Task 可以有多个 Attempt 并发运行（在推测执行场景下）。Spark 通过 Attempt ID 区分同一分区的不同执行实例，并**只采用第一个完成的 Attempt 的结果**：

```scala
// TaskSetManager.handleSuccessfulTask
def handleSuccessfulTask(tid: Long, result: DirectTaskResult[_]): Unit = {
  val info = taskInfos(tid)
  val index = info.index
  
  // 如果这个分区已经有另一个 Attempt 成功了，忽略当前结果
  if (successful(index) && killedByOtherAttempt.contains(tid)) {
    // 这个 Task 已经是"失效"的推测执行副本，结果不采用
    logInfo(s"Task ${info.id} on ${info.host} ignored: ...")
    return
  }
  
  // Kill 同一分区的所有其他运行中 Attempt（推测执行场景）
  for (attemptInfo <- taskAttempts(index) if attemptInfo.running) {
    if (attemptInfo.taskId != tid) {
      sched.backend.killTask(attemptInfo.taskId, attemptInfo.executorId, ...)
    }
  }
  
  successful(index) = true
  tasksSuccessful += 1
  ...
}
```

---

## 第 7 章 Task 结果的处理路径

### 7.1 小结果直接返回，大结果走 BlockManager

Task 完成后，结果的传输有两种路径，根据结果大小动态选择：

**直接返回（Direct Result）**：结果序列化后小于 `spark.driver.maxResultSize`（默认 1GB）且小于 `spark.rpc.message.maxSize`（默认 128MB）时，直接通过 StatusUpdate RPC 消息携带返回给 Driver：

```
Executor → StatusUpdate(taskId, FINISHED, DirectTaskResult(valueBytes)) → Driver
```

**间接返回（Indirect Result）**：结果较大时，先存入 Executor 的 BlockManager，Driver 收到通知后主动拉取：

```
Executor → 存入 BlockManager → StatusUpdate(taskId, FINISHED, IndirectTaskResult(blockId))
Driver → 收到 blockId → 通过 BlockTransferService 从 Executor 拉取数据
```

### 7.2 ResultHandler 的回调

Driver 端的 `TaskResultGetter` 处理 Task 完成消息，解析结果后调用 `JobWaiter.taskSucceeded`：

```scala
// TaskResultGetter.enqueueSuccessfulTask（简化）
def enqueueSuccessfulTask(
    taskSetManager: TaskSetManager, tid: Long, serializedData: ByteBuffer): Unit = {
  
  resultHandlerCaller.execute(() => {
    val result = serializer.get().deserialize[TaskResult[_]](serializedData)
    result match {
      case directResult: DirectTaskResult[_] =>
        // 直接使用结果
        taskSetManager.handleSuccessfulTask(tid, directResult)
        
      case IndirectTaskResult(blockId, size) =>
        // 从 BlockManager 拉取结果
        val serializedTaskResult = sparkEnv.blockManager.getRemoteBytes(blockId)
        val deserializedResult = serializer.get().deserialize[DirectTaskResult[_]](
          serializedTaskResult.get.toByteBuffer)
        taskSetManager.handleSuccessfulTask(tid, deserializedResult)
        sparkEnv.blockManager.master.removeBlock(blockId)  // 清理
    }
  })
}
```

---

## 第 8 章 总结

Task 生命周期是理解 Spark 执行模型的"最后一公里"：

- **选中**：`dequeueTask` 按本地化级别从 pending 队列中选出 Task
- **封装**：序列化为 `TaskDescription`（含 RDD 依赖链 + 用户闭包 + 分区信息）
- **传输**：通过 Netty RPC `LaunchTask` 消息发送到目标 Executor
- **执行**：`TaskRunner.run()` 反序列化 → 创建 `TaskContext` → `task.run()` 触发 RDD 血缘计算
- **汇报**：结果通过 `StatusUpdate` 返回（小结果直接携带，大结果存 BlockManager 后通知 Driver 拉取）
- **容错**：失败通过 Attempt 机制重试，达到 `maxFailures` 后终止 Stage

在 **[[07 执行器（Executor）底层机制：任务运行环境、线程池管理与资源隔离|下一篇文章]]** 中，我们将"走进" Executor JVM 进程内部，理解线程池、内存管理和 BlockManager 如何协作支撑 Task 的运行。

---

> [!note] 思考题
> 1. `TaskRunner.run()` 中，Task 执行完毕后会调用 `TaskContext.addTaskCompletionListener` 注册的所有回调。如果某个回调抛出异常，会影响 Task 状态吗（Task 会被标记为 FAILED 吗）？这对用户编写 `addTaskCompletionListener` 有什么启示？
> 2. `Task.deserializeWithDependencies` 在反序列化 Task 时会调用 `updateDependencies(taskFiles, taskJars)`，下载 Driver 端通过 `sc.addJar()` 添加的用户 JAR。这个 JAR 下载操作是每次 Task 都执行，还是 Executor 级别缓存后复用？如果 JAR 更新了（版本变化），如何确保 Executor 用的是最新版本？
> 3. 推测执行（Speculative Execution）同时启动了同一分区的两个 Attempt（A 和 B）。如果 A 先完成，B 会被 kill。但如果 B 已经完成了 Shuffle Write（`ShuffleMapTask` 已写出数据），而 A 完成的数据被采用，B 写出的 Shuffle 数据会被清理吗？下游 Stage 读取 Shuffle 时会读到 B 的数据吗？
