---
title: "06 RDD 迭代器模型：流水线计算（Pipeline）与内存迭代器的实现深度分析"
date: 2026-02-27
tags: [Spark, RDD, 迭代器, 流水线计算, JVM GC]
aliases: [RDD Iterator and Pipelining]
---

# 06 RDD 迭代器模型：流水线计算（Pipeline）与内存迭代器的实现深度分析

> [!abstract] 摘要
> 前几篇我们在宏观层面讨论了 DAG 构建、Stage 划分、依赖分类和血缘容错。本文回到微观层面，深入 Task 内部：**一条数据记录在单个 Task 中是如何被处理的？** 核心答案是"拉取式迭代器链（Pull-based Iterator Chain）"——这是 Spark 能在有限内存中处理无限规模数据的物理基础。本文将系统分析：Iterator 模型与物化模型的本质差异 → Spark 如何将多个算子的 compute 调用组合成一条 Iterator 链 → 这个链条如何在 JVM 内存模型中工作 → mapPartitions 与 map 在 Iterator 视角下的行为差异 → 以及这套模型对 JVM GC 行为的深远影响。

---

## 第 1 章 物化 vs 流水线：两种数据处理范式的对决

### 1.1 物化（Materialization）模型的运作方式

"物化"的含义是：将一个算子的全部输出结果在内存（或磁盘）中形成一个完整的数据集合，然后下一个算子再从这个集合中读取数据。

这是最直观的处理方式，也是大多数非流式框架的默认行为。Python 的列表推导式就是物化的：`result = [f(x) for x in data]`——它会把 `data` 中每个元素经过 `f` 的变换结果全部存入 `result` 列表，然后后续操作才对 `result` 进行处理。

**物化模型的代价**：

设数据集总大小为 $D$，经过 $n$ 个算子链处理，每个算子的选择率（输出量 / 输入量）分别为 $r_1, r_2, ..., r_n$：

- 物化模型的峰值内存占用 = $D + D \cdot r_1 + D \cdot r_1 \cdot r_2 + ... \approx O(D)$（当前步骤的输入 + 上一步的输出同时存在内存中）
- 每个算子之间产生一次完整的内存分配（`new Array[T]`）和遍历

在数据量 $D$ 远大于可用内存时，物化模型会触发大量 Spill（内存不足时写磁盘），进而触发频繁的磁盘 I/O 和 JVM Full GC，性能急剧下降。

### 1.2 流水线（Pipelining）模型的运作方式

流水线模型的核心思想是：**不等前一个算子处理完所有数据，而是每处理完一条（或一批）数据就立即交给下一个算子处理**。

类比工厂流水线：汽车组装不是等所有底盘都装好轮子，再把所有底盘移到下一个工位装车门。而是底盘一离开"装轮子"工位，就立刻进入"装车门"工位，两个工位同时工作。

**流水线模型的内存特性**：

- 峰值内存占用 ≈ 当前正在处理的一条（或一小批）记录的大小，与数据集总大小 $D$ 无关
- 不产生任何中间数据集合对象
- 数据在算子间以 JVM 函数调用的形式传递（栈帧上的对象引用），而非堆内存中的集合

**这就是 Spark 处理 PB 级数据却不需要 PB 级内存的物理原因。**

---

## 第 2 章 Iterator 模型的 Java/Scala 基础

### 2.1 Iterator 接口的语义

Java/Scala 的 `Iterator[T]` 接口只有两个核心方法：

```scala
trait Iterator[+A] {
  def hasNext: Boolean  // 是否还有下一个元素
  def next(): A         // 取出下一个元素（同时移动内部指针）
}
```

**关键语义**：`Iterator` 不持有任何数据集合，它只是一个"取数据的接口"。数据从哪里来、如何产生，完全由实现类决定。

最简单的 `Iterator` 实现可以是这样的：

```scala
// 一个每次调用 next() 都从文件读取一行的 Iterator
class FileLineIterator(file: File) extends Iterator[String] {
  private val reader = new BufferedReader(new FileReader(file))
  private var nextLine: String = reader.readLine()  // 预读一行

  def hasNext: Boolean = nextLine != null
  def next(): String = {
    val line = nextLine
    nextLine = reader.readLine()  // 读取下一行，为下次调用准备
    line
  }
}
```

注意：这个 Iterator 创建时并不读取整个文件，只预读一行。整个文件的数据在 `next()` 被反复调用时才逐步"流出"。

### 2.2 Iterator 的函数式组合

Scala 的 `Iterator` 提供了 `map`、`filter`、`flatMap` 等高阶方法，这些方法返回的是新的 `Iterator`（包装了原始 Iterator），而非实体集合：

```scala
val fileIter: Iterator[String] = new FileLineIterator(file)

// filter 返回的是一个新 Iterator，不触发任何实际计算
val errorIter: Iterator[String] = fileIter.filter(_.contains("ERROR"))

// map 也返回新 Iterator
val parsedIter: Iterator[LogEntry] = errorIter.map(parseLogLine)

// 到这里仍然没有读取任何文件数据！
// 只有当调用 next() 时，数据才会真正从文件流出
val firstEntry: LogEntry = parsedIter.next()
// next() 的调用链：
//   parsedIter.next()
//     → errorIter.next()（内部循环直到找到含 ERROR 的行）
//       → fileIter.next()（从文件读取一行）
```

**这就是 Spark 流水线计算的 Scala 语言基础**：多个 Iterator 的嵌套组合形成一条"懒惰的数据管道"，只有最外层的消费者调用 `next()` 时，数据才从最底层的数据源"流出"。

---

## 第 3 章 Spark 中的 Iterator 链：compute 方法的嵌套调用

### 3.1 从 RDD 链到 Iterator 链的映射

在 Spark 中，每个 RDD 的 `compute` 方法负责为该 RDD 的一个分区返回一个 `Iterator[T]`。当多个 RDD 构成一条窄依赖链时，`compute` 方法的递归调用天然构成了一条嵌套的 Iterator 链。

以 `HadoopRDD → FilteredRDD → MappedRDD` 为例：

```scala
// HadoopRDD.compute：返回一个从 HDFS Block 读取数据的 Iterator
override def compute(split: Partition, ctx: TaskContext): Iterator[(K, V)] = {
  val partition = split.asInstanceOf[HadoopPartition]
  val reader = partition.inputSplit.value.createRecordReader(...)
  // 返回一个包装了 RecordReader 的 Iterator（按需从磁盘读取）
  new RecordReaderIterator(reader, ...)
}

// FilteredRDD（对应 rdd.filter(f)，在 Spark 中实现为 MapPartitionsRDD）
// compute 实现：将父 Iterator 包装一层 filter
override def compute(split: Partition, ctx: TaskContext): Iterator[T] = {
  firstParent[T].iterator(split, ctx).filter(f)
  // firstParent[T].iterator 会触发 HadoopRDD.compute 的调用
  // 返回的是一个 FilterIterator（包装了 HadoopRDD 的 RecordReaderIterator）
}

// MappedRDD（对应 rdd.map(g)）
// compute 实现：将父 Iterator 包装一层 map
override def compute(split: Partition, ctx: TaskContext): Iterator[U] = {
  firstParent[T].iterator(split, ctx).map(g)
  // 返回的是一个 MapIterator（包装了 FilterIterator）
}
```

**Task 执行时的调用流程**：

Executor 在执行 Task 时，调用末端 RDD（`MappedRDD`）的 `iterator(split, ctx)`，这触发了整个链条的初始化：

```
MappedRDD.iterator(split, ctx)
  → MappedRDD.compute(split, ctx)
    → FilteredRDD.iterator(split, ctx)  [firstParent.iterator]
      → FilteredRDD.compute(split, ctx)
        → HadoopRDD.iterator(split, ctx)  [firstParent.iterator]
          → HadoopRDD.compute(split, ctx)
            → new RecordReaderIterator(...)  [指向 HDFS Block]
          → return RecordReaderIterator
        → return FilterIterator(RecordReaderIterator, f)
      → return FilterIterator
    → return MapIterator(FilterIterator, g)
  → return MapIterator
```

**注意**：这个初始化过程非常快，只是在 JVM 堆上创建了几个 Iterator 对象，没有读取任何数据。

### 3.2 数据流动的驱动力：Task 的消费循环

Task 最终的执行是一个消费循环，不断从末端 Iterator 拉取数据：

```scala
// Task 执行的核心逻辑（简化）
val iter: Iterator[T] = rdd.iterator(split, context)

// 不同 Action 对应不同的消费方式：
// count() 对应：
var count = 0L
while (iter.hasNext) { iter.next(); count += 1 }
return count

// collect() 对应：
val buffer = new ArrayBuffer[T]
while (iter.hasNext) { buffer += iter.next() }
return buffer.toArray

// foreach(f) 对应：
while (iter.hasNext) { f(iter.next()) }
```

**每次 `iter.next()` 的调用链**（以 `HadoopRDD → FilteredRDD → MappedRDD` 为例）：

```
Task.while: iter.next() [MapIterator.next()]
  → FilterIterator.next() [内部循环直到找到满足条件的记录]
    → RecordReaderIterator.next() [从 HDFS 读取一行]
    → f(line) 为 false → 继续循环
    → RecordReaderIterator.next() [从 HDFS 再读一行]
    → f(line) 为 true → 返回这行
  → g(filteredLine) [执行 map 变换]
  → 返回变换后的结果给 Task 消费循环
```

整个过程：一次 I/O（从 HDFS 读取一行）→ 一次 filter 判断 → 一次 map 变换 → 产生一个结果对象，交给 Task。JVM 中同时存在的对象只有：当前读取的一行原始数据、filter 后的中间对象、map 变换后的结果对象——全部都是极短生命周期的小对象。

---

## 第 4 章 mapPartitions vs map：Iterator 视角下的行为差异

### 4.1 map 算子的 Iterator 实现

`rdd.map(f)` 对应的 `MapPartitionsRDD` 的 `compute` 实现：

```scala
// map 的 compute：对 Iterator 的每个元素应用 f
override def compute(split: Partition, ctx: TaskContext): Iterator[B] = {
  firstParent[A].iterator(split, ctx).map(f)
  // Scala Iterator.map 返回一个懒惰的 MapIterator
  // 每次调用 next() 时，才对一个元素执行 f
}
```

`map` 的特点：
- 函数 `f` 针对**每条记录**单独调用一次
- 函数 `f` 是无状态的（不能在调用之间共享状态）
- 函数 `f` 在流水线中被"内联"调用，无额外开销

### 4.2 mapPartitions 算子的 Iterator 实现

`rdd.mapPartitions(f)` 的 `compute` 实现：

```scala
// mapPartitions 的 compute：将整个分区 Iterator 传给 f
override def compute(split: Partition, ctx: TaskContext): Iterator[B] = {
  f(firstParent[A].iterator(split, ctx))
  // f 接收整个分区的 Iterator，返回一个新 Iterator
  // f 内部可以维护分区级别的状态
}
```

**`mapPartitions` 与 `map` 的本质差异**：

| 特性 | `map(f)` | `mapPartitions(f)` |
| :--- | :--- | :--- |
| 函数签名 | `f: T => U` | `f: Iterator[T] => Iterator[U]` |
| 调用次数 | 每条记录调用一次 | 每个分区调用一次 |
| 状态维护 | 无法在记录间共享状态 | 可在分区内维护状态 |
| 资源生命周期 | 每条记录独立获取/释放资源 | 分区开始时初始化，分区结束时释放 |
| 内存使用 | 固定（一条记录） | 可自行控制（可缓存整个分区） |

**`mapPartitions` 的典型应用场景**：

```scala
// 场景1：数据库批量写入（每分区只建一次连接）
rdd.mapPartitions { iter =>
  val conn = createDBConnection()
  val result = iter.flatMap { record =>
    Try(conn.insert(record)).toOption
  }
  // 注意：conn.close() 在这里有问题！
  // 因为 result 是懒惰 Iterator，conn.close() 会在 Iterator 被消费前就执行
  result
  // 正确做法是使用 context.addTaskCompletionListener 注册清理回调
}

// 场景2：ML 模型推理（每分区加载一次模型）
rdd.mapPartitions { iter =>
  val model = loadMLModel("hdfs://model.pkl")  // 加载一次，分区内所有记录共用
  iter.map(record => model.predict(record))
}
```

### 4.3 mapPartitions 的资源清理问题：TaskContext 的正确用法

在 `mapPartitions` 中，资源的释放时机是一个常见的陷阱。由于 `f` 返回的是一个 Iterator（懒惰求值），在函数体内直接关闭资源会导致资源在数据被消费前就释放：

```scala
// 错误写法：conn 在返回 Iterator 之前就被关闭了
rdd.mapPartitions { iter =>
  val conn = createConnection()
  val result = iter.map(x => conn.query(x))
  conn.close()  // 错误！此时 result Iterator 还没有被消费，conn 已关闭
  result        // 后续调用 result.next() 时，conn 已经关闭，抛出异常
}

// 正确写法：使用 TaskContext 注册完成回调
rdd.mapPartitions { iter =>
  val ctx = TaskContext.get()
  val conn = createConnection()
  ctx.addTaskCompletionListener[Unit] { _ =>
    conn.close()  // Task 完成时（Iterator 被全部消费后）才关闭
  }
  iter.map(x => conn.query(x))
}
```

`TaskContext.addTaskCompletionListener` 注册的回调会在 Task 完成（无论成功还是失败）时执行，这是在 `mapPartitions` 中管理有状态资源的标准模式。

---

## 第 5 章 Iterator 模型对 JVM GC 的影响

### 5.1 JVM 内存分代模型简述

JVM 将堆内存分为两代（简化模型）：
- **Young Generation（新生代）**：新创建的小对象在此分配，空间较小，GC 频率高但速度快（Minor GC，通常 < 1ms）
- **Old Generation（老年代）**：生命周期长的大对象晋升到此，空间较大，GC 触发条件苛刻但代价极高（Full GC，通常数秒到数十秒，会 Stop-The-World）

### 5.2 流水线模型对对象生命周期的影响

在 Spark 的流水线计算中，中间记录对象的生命周期极短：

```
Task 消费循环的一次迭代：
1. HadoopRDD 读取一行原始数据 → 创建 String 对象 (A)
2. FilteredRDD 应用 filter 函数 → A 存活，决定是否放行
3. MappedRDD 应用 map 函数 → 从 A 创建新对象 B，A 不再被引用
4. B 被 Task 消费逻辑使用（如写入 output buffer）→ 完成后 B 不再被引用

下一次迭代：A 和 B 都已经不可达，在 Young GC 中被回收
```

关键观察：**在任意时刻，JVM 堆上的"活跃"中间对象数量是有界的**（仅限于当前正在处理的那条记录的各个中间形态）。这些对象通常很小（单条记录），且生命周期极短（一次 `next()` 调用完成后即不可达）。

JVM 的 GC 优化策略（如 G1GC、ZGC）都对"大量短生命周期的小对象"场景有专门优化——这些对象往往在 Young Gen 就被回收，不会晋升到 Old Gen，不会触发昂贵的 Full GC。

### 5.3 物化模型的 GC 噩梦

对比物化模型：

```
算子 A 执行完成后，将结果存入 Array[T](100_000_000 条记录)
这个 Array 对象大小约 1GB，直接进入 Old Gen（JVM 大对象直接晋升策略）
算子 B 开始执行，同时有：
  - 算子 A 的 Array（1GB，在 Old Gen）
  - 算子 B 正在构建的新 Array（同样约 1GB，同样进入 Old Gen）
Old Gen 压力达到阈值 → 触发 Full GC → Stop-The-World → 整个 Executor 暂停几秒到几十秒
```

在大规模 Spark 作业中，**JVM GC 停顿导致的 Stage 延迟是实际生产中最常见的性能问题之一**。流水线的 Iterator 模型通过消除大对象创建，从根本上降低了 GC 压力。

### 5.4 什么情况下流水线的 GC 优势会减弱？

以下情况会让流水线的 GC 优势减弱甚至消失：

**情况一：算子函数内部创建大量对象**

```scala
// 问题：每条记录都创建一个新 HashMap 对象
rdd.map { line =>
  val map = new HashMap[String, Int]()  // 每条记录 new 一次
  parseFields(line).foreach { (k, v) => map.put(k, v) }
  map
}
// 优化：使用可变对象并重用
```

**情况二：`groupByKey` 等物化算子**

`groupByKey` 需要将相同 Key 的所有 Value 收集到一个 `Iterable`（通常是 `CompactBuffer`）中。对于 Key 对应大量 Value 的情况，这个 `CompactBuffer` 可能占用大量内存，且生命周期较长（在 Reduce Task 执行期间持续存在）。

**情况三：`collect()` 等将全量数据拉到 Driver 的操作**

`collect()` 会把所有分区的数据汇聚到 Driver 端的一个 `Array` 中。对于大数据集，这个 Array 会直接导致 Driver OOM。

---

## 第 6 章 流水线的边界：为什么 Shuffle 必须物化？

本文多次强调了流水线的优越性，但 Shuffle 操作必须打破流水线，进行数据物化（写磁盘）。这背后的原因值得深入分析。

### 6.1 直接网络流转（不落盘）为什么不可行？

假设取消 Shuffle 的磁盘写入步骤，改为 Map Task 直接通过网络将数据"推"给 Reduce Task：

**问题一：背压（Back Pressure）**

如果 Map Task 产生数据的速度远快于 Reduce Task 消费的速度，Map Task 无法等待（Task 有超时机制），数据会堆积在网络缓冲区或内存中，最终导致 OOM 或丢失。

**问题二：同步屏障无法实现**

Shuffle 的语义要求"所有 Map Task 的相同分区数据都到达 Reduce Task 后，Reduce 才能开始聚合"。若直接网络流转，如何确保所有 Map Task 的数据都已发送？若某个 Map Task 发送到一半时 Executor 崩溃，数据已经发出的部分无法回滚。

**问题三：容错代价极高**

若 Reduce Task 在接收数据中途失败，已经通过网络发送的数据丢失，所有 Map Task 需要重新发送。而磁盘文件在 Shuffle 完成前始终保留，Reduce Task 失败后可以重新从磁盘拉取，不需要 Map Task 重跑。

> [!note] Spark 的 Shuffle 设计演进
> Spark 的 Shuffle 实现经历了多次演进：
> - **Hash-based Shuffle**（早期）：每个 Map Task 为每个 Reduce Task 创建一个文件，N×M 个文件导致大量小文件问题
> - **Sort-based Shuffle**（Spark 1.1+）：每个 Map Task 只创建一个数据文件 + 一个索引文件，文件数降至 2N
> - **Tungsten Sort Shuffle**（Spark 1.5+）：利用堆外内存和 Unsafe API，减少 GC 压力
>
> 现代 Spark 默认使用 Sort-based Shuffle，在 Sort Shuffle 中，Map Task 会在内存中排序后写入一个有序文件，Reduce Task 根据索引文件定位到对应的数据区间，通过 `FileSegmentManagedBuffer` 的零拷贝技术发送给 Reduce Task（使用 `FileChannel.transferTo`，数据不经过 JVM 堆）。

---

## 第 7 章 总结

RDD 的 Iterator 模型是 Spark 性能卓越的物理根基：

- **不持有数据，只持有"取数据的能力"**：Iterator 接口的语义定义了"按需拉取"的基础
- **嵌套组合构成流水线**：多个 RDD 的 `compute` 方法通过 Iterator 包装形成调用链，数据以记录为粒度流过整个链条
- **内存占用与数据集大小解耦**：任意时刻内存中只有当前处理的极少数记录，峰值内存由分区内数据的"宽度"（单条记录大小）决定，而非分区的"长度"（记录数量）
- **短生命周期对象与 JVM GC 友好**：中间对象在 Young Gen 快速被回收，不触发昂贵的 Full GC
- **Shuffle 是流水线的唯一强制中断点**：跨节点的数据重分布必须通过磁盘中转实现同步屏障和容错保障

理解了这个模型，你就能解释生产中遇到的很多现象：为什么 `map + filter` 的链路可以处理几十 TB 数据而 Executor 内存占用极低？为什么 `groupByKey` 比 `reduceByKey` 更容易 OOM？为什么 `mapPartitions` 可以显著提升数据库写入的性能？

在 **[[07 分区器（Partitioner）：分布式数据布局的数学逻辑与数据倾斜攻坚|下一篇文章]]** 中，我们将进入 Shuffle 的"前半段"——分区器（Partitioner）的工作机制：它如何决定每条记录的"去向"，以及 Key 分布不均时如何引发数据倾斜，又如何通过分区器设计来消解。

---

> [!note] 思考题
> 1. 在 `rdd.map(f1).filter(f2).map(f3)` 链路中，当 `f2` 的选择率为 1%（即 99% 的记录被过滤掉）时，`f3` 的调用次数是 `f1` 的 1%。但如果将顺序改为 `rdd.filter(f2).map(f1).map(f3)`，`f1` 的调用次数也会减少到 1%。在 Iterator 模型下，这两种写法的内存使用有差异吗？性能差异主要体现在哪里？
> 2. `mapPartitions` 中如果 `f` 函数消费了传入 Iterator 的一半元素后抛出异常，Task 会失败并重试。重试时，`f` 会接收一个全新的 Iterator 还是接着上次的位置继续？为什么？
> 3. 假设 `map` 算子中的函数 `f` 会产生一个 10MB 的 `HashMap` 对象（用于 lookup）。这个对象在流水线的每次 `next()` 调用中都会创建一次新实例吗？如何用 `mapPartitions` 优化这个问题？
