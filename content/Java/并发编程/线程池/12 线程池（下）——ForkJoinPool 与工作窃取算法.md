---
title: "线程池（下）——ForkJoinPool 与工作窃取算法"
date: 2026-03-05
tags: [Java, 并发编程, ForkJoinPool, 工作窃取, Work-Stealing, RecursiveTask, RecursiveAction, ForkJoinTask, 分治, parallelStream, CompletableFuture]
aliases: []
---

# 12 线程池（下）——ForkJoinPool 与工作窃取算法

**摘要：**

`ThreadPoolExecutor` 适合处理独立的、同质化的任务（如 HTTP 请求处理、数据库查询），但面对**分治（Divide and Conquer）** 类问题时——任务本身可以递归分解成子任务，子任务之间存在依赖和聚合——`ThreadPoolExecutor` 力不从心：工作线程在等待子任务完成时会阻塞，造成线程饥饿死锁。**`ForkJoinPool`** 是为分治问题专门设计的线程池，其核心是**工作窃取（Work-Stealing）算法**：每个工作线程维护自己的**双端队列（Deque）**，任务分解产生的子任务推入自己的队列底部，自己从底部取；当空闲时，从其他线程队列的顶部窃取任务——这个设计极大减少了队列竞争，同时天然支持递归任务的并行化。本文深入剖析 `ForkJoinPool` 的工作窃取机制、`ForkJoinTask` 的 `fork()`/`join()` 语义、`work queue` 的双端设计以及其作为 `parallelStream` 和 `CompletableFuture` 默认线程池的角色，最后给出 `ThreadPoolExecutor` 与 `ForkJoinPool` 的选型边界。

---

## 第 1 章 ThreadPoolExecutor 的分治困境

### 1.1 分治问题的特点

分治算法的基本结构是：将一个大问题分解为若干个同类型的子问题，递归解决子问题，然后合并子问题的结果。典型的分治例子包括归并排序、快速排序、大数组求和/最大值、MapReduce 等。

在 Java 中，用 `ThreadPoolExecutor` 实现并行分治会遇到一个根本性的问题：

```java
// 用 ThreadPoolExecutor 并行归并排序（反面教材）
class MergeSortTask implements Callable<int[]> {
    private final int[] array;
    
    public int[] call() throws Exception {
        if (array.length <= THRESHOLD) {
            Arrays.sort(array);  // 足够小，直接排序
            return array;
        }
        
        int mid = array.length / 2;
        // 将左半部分提交到线程池
        Future<int[]> leftFuture = executor.submit(
            new MergeSortTask(Arrays.copyOfRange(array, 0, mid)));
        // 将右半部分提交到线程池
        Future<int[]> rightFuture = executor.submit(
            new MergeSortTask(Arrays.copyOfRange(array, mid, array.length)));
        
        // 等待左右两部分完成（阻塞！）
        int[] left = leftFuture.get();   // 当前线程在这里阻塞
        int[] right = rightFuture.get(); // ...继续阻塞
        return merge(left, right);
    }
}
```

**问题根源：线程饥饿死锁（Thread Starvation Deadlock）**

假设线程池有 4 个线程，递归分解到第 3 层时，已经有 4 个任务在"等待子任务完成"的状态中阻塞。此时线程池满负荷，没有空闲线程可以执行子任务——所有线程都在 `future.get()` 上阻塞等待，子任务永远无法被执行。死锁！

即使通过增大线程池大小来"绕过"死锁（让线程数超过递归层数），也会因为大量线程阻塞而浪费资源，且线程创建代价很高。

### 1.2 解决思路：任务不能"阻塞等待子任务"

解决方案的核心思路是：**当一个任务在等待子任务时，它不应该阻塞线程，而应该让当前线程去执行其他任务（包括子任务）**。

这正是 `ForkJoinPool` 的设计哲学：当线程调用 `task.join()` 等待子任务时，如果子任务还没有完成，线程不会阻塞，而是从自己的工作队列中取出其他任务来执行，直到被 join 的子任务完成。

---

## 第 2 章 工作窃取算法——ForkJoinPool 的核心

### 2.1 每个线程一个双端队列

`ThreadPoolExecutor` 的所有工作线程共享一个 `BlockingQueue`，任何线程的 `put` 和 `take` 都在这一个共享队列上操作，这是高竞争的根源。

`ForkJoinPool` 的设计完全不同：**每个工作线程都有自己的双端队列（WorkQueue / Deque）**，不共享队列。

```
ForkJoinPool 内部结构（4 个工作线程）：

工作线程 T0          工作线程 T1          工作线程 T2          工作线程 T3
  WorkQueue            WorkQueue            WorkQueue            WorkQueue
  ┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ [底部]   │←push    │ [底部]   │←push    │ [底部]   │←push    │ [底部]   │
  │  task5   │         │  task8   │         │  (空)    │         │  task12  │
  │  task4   │         │  task7   │         │          │         │  task11  │
  │  task3   │  steal→ │  task6   │         │          │  steal→ │  task10  │
  │ [顶部]   │         │ [顶部]   │         │          │         │ [顶部]   │
  └──────────┘         └──────────┘         └──────────┘         └──────────┘
    自己取↑(底部)       自己取↑(底部)                               自己取↑(底部)
    被窃取↑(顶部)       被窃取↑(顶部)                               被窃取↑(顶部)
```

**操作规则**：
- 工作线程向自己队列的**底部（bottom）** push 新产生的子任务
- 工作线程从自己队列的**底部（bottom）** pop 下一个要执行的任务（LIFO）
- 空闲线程从**其他**线程队列的**顶部（top）** steal 任务（FIFO）

### 2.2 为什么是双端队列，为什么区分底部和顶部

**工作线程自己从底部取（LIFO）的原因**：

子任务是由父任务 `fork()` 产生的，父任务 fork 后立即 `join()` 等待子任务。子任务被 push 到队列底部，然后立即从底部 pop 出来执行——相当于直接执行子任务，避免了放入队列再取出的往返，内存局部性最好（最近 fork 的子任务数据最热）。

在分治问题的递归场景中，LIFO 顺序意味着深度优先处理——先把一个分支递归到底，解决它，然后处理其他分支。深度优先在内存使用上更经济（不需要同时保存所有层次的中间数据）。

**其他线程从顶部窃取（FIFO）的原因**：

从顶部窃取，拿到的是最老的任务（最先 push 的）。这些任务是问题树中较高层次的大任务，本身可以进一步分解，窃取后能产生更多子任务，让窃取线程有更多工作可做。

**竞争分析**：

工作线程自己操作底部，其他线程操作顶部——两者在不同端，绝大多数情况下没有竞争。只有当队列只剩一个任务时，自己的 pop 和他人的 steal 才会竞争（用 CAS 解决）。这使得 `ForkJoinPool` 的队列操作几乎无锁，吞吐量远高于共享的 `BlockingQueue`。

---

## 第 3 章 ForkJoinTask：fork() 与 join() 的语义

### 3.1 ForkJoinTask 的基本类型

`ForkJoinTask` 是 `ForkJoinPool` 中任务的基类，JDK 提供了两个常用子类：

```java
// 有返回值的分治任务（类比 Callable）
abstract class RecursiveTask<V> extends ForkJoinTask<V> {
    protected abstract V compute();  // 子类实现分治逻辑
}

// 无返回值的分治任务（类比 Runnable）
abstract class RecursiveAction extends ForkJoinTask<Void> {
    protected abstract void compute();
}
```

**一个正确的并行求和示例**：

```java
class SumTask extends RecursiveTask<Long> {
    private static final int THRESHOLD = 1000;  // 阈值：低于此直接计算
    private final long[] array;
    private final int from, to;
    
    SumTask(long[] array, int from, int to) {
        this.array = array;
        this.from = from;
        this.to = to;
    }
    
    @Override
    protected Long compute() {
        if (to - from <= THRESHOLD) {
            // 基本情况：直接求和
            long sum = 0;
            for (int i = from; i < to; i++) sum += array[i];
            return sum;
        }
        
        int mid = (from + to) / 2;
        SumTask left = new SumTask(array, from, mid);
        SumTask right = new SumTask(array, mid, to);
        
        // 关键：fork() 异步提交右子任务，compute() 直接执行左子任务
        right.fork();              // 将 right 推入当前线程的工作队列底部
        long leftResult = left.compute();   // 当前线程直接执行（不 fork）
        long rightResult = right.join();    // 等待 right 完成
        
        return leftResult + rightResult;
    }
}

// 使用
ForkJoinPool pool = new ForkJoinPool();
long[] array = new long[1_000_000];
// ... 初始化 array ...
Long result = pool.invoke(new SumTask(array, 0, array.length));
```

### 3.2 fork() 的实现

```java
// ForkJoinTask.fork()
public final ForkJoinTask<V> fork() {
    Thread t;
    if ((t = Thread.currentThread()) instanceof ForkJoinWorkerThread)
        ((ForkJoinWorkerThread)t).workQueue.push(this);  // 推入当前线程的工作队列
    else
        ForkJoinPool.common.externalPush(this);  // 从外部线程提交到公共池
    return this;
}
```

`fork()` 只是将任务推入当前线程的工作队列——不创建新线程，不等待，立即返回。任务会被当前线程后续取出执行（LIFO），或被其他空闲线程窃取执行（FIFO）。

### 3.3 join() 的实现——不是简单的阻塞

`join()` 是理解 `ForkJoinPool` 的关键，它**不是简单地让当前线程阻塞**：

```java
// ForkJoinTask.join()（简化）
public final V join() {
    int s;
    if (((s = doJoin()) & DONE_MASK) != NORMAL)
        reportException(s);
    return getRawResult();
}

// doJoin() 的核心逻辑：
private int doJoin() {
    int s;
    Thread t;
    ForkJoinWorkerThread wt;
    ForkJoinPool.WorkQueue w;
    
    return (s = status) < 0 ? s :  // 已完成，直接返回
        ((t = Thread.currentThread()) instanceof ForkJoinWorkerThread) ?
        (w = (wt = (ForkJoinWorkerThread)t).workQueue).
            // 尝试从队列中直接取出并执行这个任务（如果它还在底部）
            tryUnpush(this) && (s = doExec()) < 0 ? s :
            // 否则：进入"补偿等待"——帮助执行其他任务，直到此任务完成
            wt.pool.awaitJoin(w, this, 0L) :
        externalAwaitDone();  // 非 ForkJoinWorkerThread 调用：阻塞等待
}
```

当 `ForkJoinWorkerThread` 调用 `join()` 时的行为：
1. 如果目标任务还在自己的队列底部（刚刚 fork 的），直接取出执行（最优路径）
2. 如果任务已被窃取或在队列其他位置，调用 `pool.awaitJoin()`——此方法会让当前线程帮助执行其他任务，直到被 join 的任务完成

**补偿机制（awaitJoin）**：

`awaitJoin` 内部实现了一个"帮助执行"的循环：当前线程不阻塞，而是从自己的工作队列取任务执行，或者尝试帮助执行被 join 任务的子任务，直到 join 的目标完成。如果实在无事可做（等待的任务不在任何可达的队列中），则通过"补偿线程"机制：临时增加一个工作线程，保证并行度不降低，然后当前线程阻塞等待。

---

## 第 4 章 ForkJoinPool 的内部结构

### 4.1 WorkQueue 数组

`ForkJoinPool` 内部维护一个 `WorkQueue[]` 数组：

```java
// WorkQueue 数组，奇数下标是工作线程的队列，偶数下标是外部提交的队列
volatile WorkQueue[] workQueues;
```

偶数下标的 `WorkQueue` 没有绑定工作线程，用于接收外部线程（非 `ForkJoinWorkerThread`）提交的任务。多个外部提交者通过哈希分散到不同的偶数下标队列，减少竞争。

奇数下标的 `WorkQueue` 每个绑定一个工作线程，工作线程自己 push/pop，其他线程来 steal。

### 4.2 工作线程的 scan（窃取）逻辑

空闲的工作线程不会立即退出，而是执行 scan：随机选择一个其他工作线程的队列，尝试从顶部窃取任务。如果窃取失败（队列为空），换一个队列再试；连续多次失败后，进入短暂的等待（`Thread.sleep` 或 `LockSupport.park`），避免空转浪费 CPU。

```java
// ForkJoinPool.scan()（简化示意）
private ForkJoinTask<?> scan(WorkQueue w, int r) {
    WorkQueue[] ws;
    int n;
    if ((ws = workQueues) != null && (n = ws.length) > 1 && w != null) {
        // 随机选起始队列（r 是随机种子，通过 XOR shift 更新）
        for (int m = n - 1, j = r & m;;) {
            WorkQueue q;
            if ((q = ws[j]) != null && q.top != q.base) {
                // 尝试从队列顶部窃取
                ForkJoinTask<?> t = q.poll();  // poll from top
                if (t != null) {
                    w.source = j;  // 记录窃取源，用于计算帮助执行的提示
                    return t;
                }
            }
            if ((j = (j + 1) & m) == (r & m))
                break;  // 扫描一圈没找到
        }
    }
    return null;
}
```

---

## 第 5 章 ForkJoinPool.commonPool()——隐形的全局池

### 5.1 Common Pool 的来历

JDK 8 引入了一个静态方法 `ForkJoinPool.commonPool()`，返回一个**全局共享的 `ForkJoinPool` 实例**（common pool）。它的并行度（工作线程数）默认为 `Runtime.getRuntime().availableProcessors() - 1`。

这个 common pool 是以下 JDK 特性的默认线程池：

**`parallelStream()`**：

```java
// parallelStream 使用 common pool
List<Integer> list = IntStream.range(0, 1_000_000)
    .boxed().collect(Collectors.toList());
int sum = list.parallelStream()
    .mapToInt(Integer::intValue)
    .sum();  // 底层自动使用 ForkJoinPool.commonPool()
```

**`CompletableFuture` 的默认异步执行**：

```java
// 不指定 Executor 时，使用 common pool
CompletableFuture.supplyAsync(() -> computeExpensiveResult());  // common pool
CompletableFuture.supplyAsync(() -> ioOperation(), customPool);  // 指定线程池
```

### 5.2 Common Pool 的陷阱

Common Pool 是全局共享的，这意味着不同的代码路径可能在同一个池中竞争线程资源。这在某些场景下会造成严重问题：

**IO 操作不应使用 common pool**：

common pool 的线程数等于 CPU 核心数减 1，设计目标是 CPU 密集型计算。如果将 IO 操作（数据库查询、HTTP 请求等）放入 common pool，IO 等待会占用工作线程，其他的计算任务被饿死。

```java
// 错误：IO 操作放入 common pool
CompletableFuture.supplyAsync(() -> dbQuery("SELECT ..."));  // 阻塞 common pool！

// 正确：IO 操作使用单独的线程池
ExecutorService ioPool = Executors.newFixedThreadPool(20);  // 或自定义有界线程池
CompletableFuture.supplyAsync(() -> dbQuery("SELECT ..."), ioPool);
```

**阻塞调用会导致 common pool 线程数降为 0**：

common pool 默认并行度为 `availableProcessors - 1`。如果所有工作线程都因 IO 阻塞而不可用，且没有触发补偿线程机制（只有 `ForkJoinTask.join()` 触发），那么 `parallelStream` 和不带 Executor 的 `CompletableFuture` 实际上退化为单线程执行。

**自定义 common pool 大小**：

```java
// 通过系统属性设置 common pool 并行度
System.setProperty("java.util.concurrent.ForkJoinPool.common.parallelism", "16");

// 或者：对于 parallelStream，可以临时在自定义池中执行
ForkJoinPool customPool = new ForkJoinPool(4);
customPool.submit(() -> list.parallelStream().forEach(item -> process(item))).get();
```

---

## 第 6 章 分治算法的最佳实践

### 6.1 阈值的选择

分治算法中最重要的调优参数是**阈值（Threshold）**——当问题规模小于阈值时，停止递归分解，直接计算。

阈值太小：任务太多，fork/join 的开销（任务创建、队列操作）超过并行收益。

阈值太大：并行度不够，多核 CPU 无法充分利用。

**实践原则**：阈值应该使每个叶子任务的执行时间在**100 微秒到 10 毫秒**之间。太短的任务（< 100μs）fork/join 开销占比过高；太长的任务（> 10ms）可能导致负载不均衡。

可以通过实验确定：从 `array.length / (parallelism * 4)` 开始（将任务分成并行度 4 倍的数量），然后通过基准测试调整。

### 6.2 fork()/join() 的正确姿势

```java
@Override
protected Long compute() {
    if (size <= THRESHOLD) {
        return directCompute();
    }
    
    // 正确姿势 1：fork 右边，直接 compute 左边
    RightTask right = new RightTask(/* ... */);
    right.fork();                    // 异步提交右任务
    Long leftResult = new LeftTask(/* ... */).compute();  // 当前线程直接执行
    Long rightResult = right.join(); // 等待右任务
    return combine(leftResult, rightResult);
    
    // 错误姿势：两个都 fork，当前线程什么都不做
    // LeftTask left = new LeftTask(); left.fork();
    // RightTask right = new RightTask(); right.fork();
    // return combine(left.join(), right.join());  // 当前线程阻塞等待，浪费！
    
    // 也可以用 invokeAll（自动处理 fork/join 的正确顺序）
    // invokeAll(left, right);  // 等价于：left.fork(); right.compute(); left.join();
}
```

### 6.3 ForkJoinPool 不适合的场景

- **IO 密集型任务**：工作线程数基于 CPU 核心数，大量线程等待 IO 会降低有效并行度
- **任务耗时差异悬殊**：工作窃取能在一定程度上平衡负载，但如果某个任务极慢，仍会成为瓶颈
- **需要精确控制任务顺序**：工作窃取的随机性使得任务执行顺序不可预测

---

## 第 7 章 ThreadPoolExecutor vs ForkJoinPool 选型

| 维度 | `ThreadPoolExecutor` | `ForkJoinPool` |
| :--- | :--- | :--- |
| **适用任务类型** | 独立同质任务（HTTP 处理、DB 查询） | 可递归分解的分治任务 |
| **任务依赖** | 不处理任务间依赖（任务独立） | 原生支持 fork/join（父子依赖） |
| **队列结构** | 所有线程共享一个队列 | 每线程独立双端队列 + 工作窃取 |
| **阻塞行为** | 等待时线程阻塞（线程饥饿风险） | 等待时帮助执行其他任务 |
| **IO 友好性** | 好（可设置大量线程来覆盖 IO 等待） | 差（线程数受限于 CPU 核心数） |
| **并行流支持** | ❌ | ✅ `parallelStream()` 底层 |
| **CompletableFuture 默认** | ❌ | ✅ `commonPool()` |
| **线程数配置** | 精确配置（core/max） | 基于并行度（= CPU 核心数 - 1） |
| **参数调优难度** | 需要调 7 个参数 | 只需调并行度和阈值 |

**决策准则**：

```
你的任务是否可以分解为同类型的子任务，且子任务结果需要合并？
    ├─ YES → 考虑 ForkJoinPool（分治、递归、并行流）
    │         进一步：任务是 CPU 密集型还是 IO 密集型？
    │         ├─ CPU 密集 → ForkJoinPool（common pool 或自定义）
    │         └─ IO 密集  → 不要用 ForkJoinPool，用 ThreadPoolExecutor
    └─ NO → 用 ThreadPoolExecutor
            进一步：无界任务流 or 需要背压？
            ├─ 需要背压 → 有界队列 + CallerRunsPolicy
            └─ 允许积压 → 有界队列 + AbortPolicy + 监控告警
```

---

## 第 8 章 总结

`ForkJoinPool` 是 Java 并发包中最精妙的设计之一。它的核心创新点：

**工作窃取算法**：每线程独立双端队列，自己从底部取（LIFO，内存局部性好），空闲时从他人顶部窃取（FIFO，取大任务）。绝大多数操作在本地队列上完成，几乎无竞争。

**join() 不阻塞**：等待子任务时，线程帮助执行其他任务（或子任务的子任务），直到 join 目标完成，或通过补偿线程机制避免并行度降低。这从根本上避免了 `ThreadPoolExecutor` 在分治场景中的线程饥饿死锁。

**Common Pool 的角色**：JDK 8+ 中，`parallelStream()` 和无 Executor 的 `CompletableFuture` 默认使用 common pool，这是 JDK 标准库中被动使用最广泛的线程池。理解 common pool 的大小和限制，是避免生产性能问题的关键。

下一篇 [[线程池/13 CompletableFuture 与异步编程模型——从 Future 到响应式]] 将在 `ForkJoinPool` 的基础上，深入剖析 `CompletableFuture` 的链式异步编程模型：如何将多个异步操作用 `thenApply`、`thenCompose`、`allOf`、`anyOf` 串联和组合，以及它与响应式编程的关系。

---

## 参考文献

1. Doug Lea, "A Java Fork/Join Framework", ACM 2000
2. Herlihy & Shavit, "The Art of Multiprocessor Programming", Ch.16: Futures, Scheduling, and Work Distribution
3. OpenJDK 源码：`java.util.concurrent.ForkJoinPool`, `java.util.concurrent.ForkJoinTask`
4. Goetz et al., "Java Concurrency in Practice", Ch.8: Applying Thread Pools
5. JEP 266: More Concurrency Updates (common pool configuration)
