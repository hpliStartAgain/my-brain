---
title: "并发工具类——CountDownLatch、CyclicBarrier、Semaphore 与 Exchanger"
date: 2026-03-05
tags: [AQS, CountDownLatch, CyclicBarrier, Exchanger, Java, Semaphore, 倒计时门闩, 并发协调, 并发编程, 循环屏障]
aliases: []
---

# 14 并发工具类——CountDownLatch、CyclicBarrier、Semaphore 与 Exchanger

**摘要：**

JUC 包中除了锁和线程池，还提供了四个专用的**并发协调工具**：`CountDownLatch`（一次性倒计时门闩）、`CyclicBarrier`（可复用的循环屏障）、`Semaphore`（信号量，控制并发资源访问数量）和 `Exchanger`（双方数据交换）。这四个工具覆盖了并发编程中最常见的四种协调模式：等待多个事件全部完成（门闩）、让多个线程在某个时间点同步汇合（屏障）、限制同时进入某段代码的线程数（信号量）、两个线程互换数据（交换器）。本文在 [[JUC工具/06 AQS 框架——AbstractQueuedSynchronizer 的设计与实现]] 的基础上，深入剖析这四个工具的内部 AQS 实现，重点分析 `CountDownLatch` 与 `CyclicBarrier` 的本质差异（一次性 vs 可复用，等待者角色不同），`Semaphore` 公平/非公平模式的性能权衡，以及 `CyclicBarrier` 的 barrierAction 在哪个线程执行的陷阱。

---

## 第 1 章 并发协调的四种模式

在多线程编程中，线程之间的协调需求可以归纳为以下四种核心模式：

**模式 1：一个线程等待多个事件完成（门闩）**

场景：主线程需要等待 N 个子任务全部完成后才能汇总结果，或者应用启动时需要等待所有服务组件初始化完毕才能开始处理请求。这就是 `CountDownLatch` 的使用场景——门闩从 N 开始倒数，每个事件完成时 `countDown()` 减 1，倒计时归零时等待者通过。

**模式 2：N 个线程相互等待，同时出发（屏障）**

场景：并行压测中，希望 N 个测试线程在同一时刻开始压测，避免"先来的线程已经压了一段时间，后来的线程才开始"的问题。或者分布式计算中，多个 Worker 完成一轮计算后，汇总中间结果，然后同步开始下一轮。这是 `CyclicBarrier` 的场景——所有线程到达屏障后同时通过，且可以重复使用。

**模式 3：限制同时访问某资源的线程数（信号量）**

场景：数据库连接池最多允许 20 个并发连接；限流器每秒最多处理 100 个请求；并发 HTTP 请求数不超过 50。这是 `Semaphore` 的场景——通过 `acquire()` 获取许可，`release()` 归还许可，控制并发量。

**模式 4：两个线程互换数据（交换器）**

场景：生产者-消费者模型的变体——生产者积累了一批数据，消费者手里有一个空容器，双方"交换"，生产者拿到空容器继续生产，消费者拿到满数据继续处理。这是 `Exchanger` 的场景。

理解这四种模式，是选择正确工具的前提。

---

## 第 2 章 CountDownLatch——一次性倒计时门闩

### 2.1 设计动机与核心语义

`CountDownLatch` 的名字已经完整表达了它的语义：Count（计数）Down（倒数）Latch（门闩）。初始化时设定一个计数 N，调用 `countDown()` 使计数减 1，调用 `await()` 的线程会阻塞直到计数归零。

**一次性**是 `CountDownLatch` 的关键约束：计数归零后不能重置，门闩永久打开，所有后续的 `await()` 调用都立即返回。如果需要可复用的版本，应该使用 `CyclicBarrier`。

典型使用场景：

```java
// 场景 1：主线程等待 N 个子任务完成
int N = 5;
CountDownLatch latch = new CountDownLatch(N);

for (int i = 0; i < N; i++) {
    final int taskId = i;
    executor.submit(() -> {
        try {
            processTask(taskId);
        } finally {
            latch.countDown();  // 任务完成，计数 -1（finally 保证一定执行）
        }
    });
}

latch.await();  // 主线程等待所有任务完成
System.out.println("所有任务已完成，开始汇总结果");

// 场景 2：多个线程等待同一起跑信号（发令枪）
CountDownLatch startSignal = new CountDownLatch(1);  // 起跑信号，初始值 1

for (int i = 0; i < 10; i++) {
    executor.submit(() -> {
        startSignal.await();     // 所有线程在这里等待
        doRace();
    });
}

Thread.sleep(1000);  // 准备就绪
startSignal.countDown();  // 发令！所有等待线程同时出发
```

### 2.2 AQS 实现：共享模式的 state 倒数

`CountDownLatch` 使用 AQS 的共享模式实现：

```java
private static final class Sync extends AbstractQueuedSynchronizer {
    Sync(int count) {
        setState(count);  // state = 初始计数值 N
    }

    int getCount() { return getState(); }

    // tryAcquireShared：只有 state == 0 时才允许通过
    // 返回 1（成功）或 -1（失败，进入等待队列）
    protected int tryAcquireShared(int acquires) {
        return (getState() == 0) ? 1 : -1;
    }

    // tryReleaseShared：state - 1，当 state 恰好从 1 变为 0 时返回 true
    // 返回 true 会触发 AQS 的"唤醒传播"，将所有等待线程依次唤醒
    protected boolean tryReleaseShared(int releases) {
        for (;;) {
            int c = getState();
            if (c == 0) return false;  // 已经是 0，不需要再操作
            int nextc = c - 1;
            if (compareAndSetState(c, nextc))
                return nextc == 0;  // 刚好归零时返回 true
        }
    }
}
```

`await()` 调用 `sync.acquireSharedInterruptibly(1)`：如果 `state != 0`，进入 AQS 等待队列（共享模式节点）。

`countDown()` 调用 `sync.releaseShared(1)`：CAS 将 `state` 减 1，当 `state` 变为 0 时，`tryReleaseShared` 返回 `true`，触发 AQS 的**唤醒传播（propagation）**——第一个等待的共享节点被唤醒，它唤醒下一个共享节点，形成级联唤醒，所有 `await()` 的线程几乎同时被唤醒。

这个级联唤醒正是 `CountDownLatch` "门闩打开后所有等待者同时通过"语义的底层实现。

### 2.3 await() 的超时版本

```java
// 带超时的等待：最多等待 timeout 时间，超时返回 false（不是抛异常）
boolean allDone = latch.await(5, TimeUnit.SECONDS);
if (!allDone) {
    log.warn("等待超时，部分任务未完成");
}
```

超时版本在某些场景下很重要：如果某个 `countDown()` 因为异常没有执行（`finally` 块中的 `countDown()` 是防御，但不能保证），主线程可以通过超时机制避免永久阻塞。

---

## 第 3 章 CyclicBarrier——可复用的循环屏障

### 3.1 CyclicBarrier vs CountDownLatch 的本质差异

这是最容易混淆的对比，先从使用角色区分：

| 维度 | `CountDownLatch` | `CyclicBarrier` |
| :--- | :--- | :--- |
| **等待者角色** | 等待者（`await`）和通知者（`countDown`）是不同的线程 | 所有线程既是等待者也是通知者，互相等待 |
| **复用性** | 一次性，归零后不可重置 | 可循环复用（`reset()` 或自动重置） |
| **归零语义** | 计数归零 = 所有外部事件完成 | 所有参与线程都到达屏障 |
| **barrierAction** | ❌ 不支持 | ✅ 所有线程到达后执行一次 |
| **实现基础** | AQS 共享模式（`tryReleaseShared`） | `ReentrantLock` + `Condition` |
| **异常处理** | 不传播（一个任务异常不影响等待者）| 若屏障损坏（`BrokenBarrierException`），所有等待者都被通知 |

**本质差异**：`CountDownLatch` 是"1 个（或少数）线程等待 N 个事件"，通知者和等待者是分离的；`CyclicBarrier` 是"N 个线程互相等待，凑齐了一起走"，所有线程角色对等。

### 3.2 基本使用

```java
int parties = 4;  // 需要 4 个线程同时到达才能通过

// barrierAction：所有线程到达后，在最后一个到达的线程上执行一次
CyclicBarrier barrier = new CyclicBarrier(parties, () -> {
    System.out.println("所有线程已就绪，执行屏障动作，线程: " + Thread.currentThread().getName());
});

// 4 个工作线程
for (int i = 0; i < parties; i++) {
    final int id = i;
    executor.submit(() -> {
        System.out.println("线程 " + id + " 准备好了");
        barrier.await();  // 等待其他线程
        System.out.println("线程 " + id + " 通过屏障，开始下一阶段");
        
        doNextPhase();
        
        barrier.await();  // 第二轮屏障（CyclicBarrier 可复用！）
        System.out.println("线程 " + id + " 第二阶段完成");
    });
}
```

### 3.3 barrierAction 在哪个线程执行

这是一个常见的陷阱：**barrierAction 在最后一个调用 `await()` 的线程上执行**，而不是在专用的线程或主线程上。

为什么这样设计？因为 `CyclicBarrier` 的实现基于 `ReentrantLock` 而非 AQS，最后到达的线程持有锁，直接在持锁的情况下执行 barrierAction，然后 `signalAll()` 唤醒所有等待者。这样避免了额外的线程切换。

但这带来了一个重要含义：**barrierAction 的执行时间会延迟最后到达的线程的进展**。如果 barrierAction 很耗时，最后到达的线程（通常是最慢的那个）会更慢，影响整体性能。barrierAction 应该尽量轻量（如统计数据、切换阶段标志），耗时操作应该异步化。

### 3.4 CyclicBarrier 的内部实现

`CyclicBarrier` **不使用 AQS**，而是直接用 `ReentrantLock` + `Condition` 实现：

```java
public class CyclicBarrier {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition trip = lock.newCondition();
    
    private final int parties;         // 参与者总数
    private final Runnable barrierCommand;  // 屏障动作
    
    private Generation generation = new Generation();  // 当前代（用于区分不同轮次）
    private int count;                 // 当前轮次还未到达的线程数（初始 = parties）
    
    private static class Generation {
        Generation() {}
        boolean broken;  // 当前屏障是否已损坏
    }
}
```

`await()` 的核心逻辑：

```java
private int dowait(boolean timed, long nanos) throws ... {
    final ReentrantLock lock = this.lock;
    lock.lock();
    try {
        final Generation g = generation;
        if (g.broken) throw new BrokenBarrierException();
        
        // 响应中断
        if (Thread.interrupted()) {
            breakBarrier();  // 中断一个线程，损坏屏障，其他线程抛 BrokenBarrierException
            throw new InterruptedException();
        }
        
        int index = --count;  // 本线程到达，count 减 1
        
        if (index == 0) {
            // 最后一个到达的线程：执行 barrierCommand，然后唤醒所有人
            boolean ranAction = false;
            try {
                final Runnable command = barrierCommand;
                if (command != null) command.run();  // 在当前线程上执行 barrierAction
                ranAction = true;
                nextGeneration();  // 唤醒所有等待者，重置 count，切换到新 Generation
                return 0;
            } finally {
                if (!ranAction) breakBarrier();  // barrierAction 抛异常时损坏屏障
            }
        }
        
        // 非最后到达的线程：等待
        for (;;) {
            try {
                if (!timed)
                    trip.await();          // 无限等待
                else if (nanos > 0L)
                    nanos = trip.awaitNanos(nanos);  // 有超时等待
            } catch (InterruptedException ie) {
                // 处理中断...
            }
            
            if (g.broken) throw new BrokenBarrierException();
            if (g != generation) return index;  // Generation 已切换，说明屏障已通过
            if (timed && nanos <= 0L) {
                breakBarrier();
                throw new TimeoutException();
            }
        }
    } finally {
        lock.unlock();
    }
}

private void nextGeneration() {
    trip.signalAll();   // 唤醒所有在 trip 上等待的线程
    count = parties;    // 重置计数（可复用的关键！）
    generation = new Generation();  // 新一代
}
```

**Generation 的作用**：每轮屏障对应一个 `Generation` 对象，等待中的线程通过检查 `g != generation` 来判断屏障是否已经被新一轮重置，避免误判。

### 3.5 BrokenBarrierException——屏障损坏

如果等待中的某个线程被中断，或者 barrierAction 抛异常，`CyclicBarrier` 会调用 `breakBarrier()`，将 `generation.broken` 设为 `true`，并唤醒所有等待线程。这些线程会抛出 `BrokenBarrierException`，而不是正常通过屏障。

这个"失败即全部失败"的语义很重要：当参与者中有一个出现问题时，继续让其他参与者"等待"是没有意义的，屏障损坏通知所有参与者放弃这一轮。

---

## 第 4 章 Semaphore——并发资源访问控制

### 4.1 信号量的经典语义

`Semaphore` 来自操作系统中 Dijkstra 提出的经典同步原语。它维护一个**许可（permit）计数器**：
- `acquire()`：获取一个许可，如果没有可用许可则阻塞等待
- `release()`：归还一个许可，可能唤醒等待的线程

互斥锁可以看作 `Semaphore(1)` 的特例——只有 1 个许可，同时只允许 1 个线程持有。但 `Semaphore` 更通用：允许 N 个线程同时进入临界区。

### 4.2 典型使用场景

**限制并发资源访问数量（数据库连接池模拟）**：

```java
class BoundedConnectionPool {
    private final Semaphore available;
    private final Connection[] connections;
    private final boolean[] used;
    
    BoundedConnectionPool(int maxConnections) {
        available = new Semaphore(maxConnections);  // 最多 maxConnections 个并发
        connections = buildConnections(maxConnections);
        used = new boolean[maxConnections];
    }
    
    public Connection acquire() throws InterruptedException {
        available.acquire();  // 等待许可（阻塞直到有空闲连接）
        return getNextAvailableConnection();
    }
    
    public void release(Connection conn) {
        returnConnectionToPool(conn);
        available.release();  // 归还许可，唤醒等待者
    }
}
```

**限流器（限制并发操作数）**：

```java
// 最多 10 个并发 HTTP 请求
Semaphore httpLimiter = new Semaphore(10);

public String fetchUrl(String url) throws Exception {
    httpLimiter.acquire();  // 等待许可（可能阻塞）
    try {
        return httpClient.get(url);
    } finally {
        httpLimiter.release();  // 确保释放
    }
}
```

### 4.3 AQS 实现：共享模式的 state 递减

`Semaphore` 使用 AQS 共享模式，`state` 表示可用的许可数：

```java
abstract static class Sync extends AbstractQueuedSynchronizer {
    Sync(int permits) {
        setState(permits);  // state = 初始许可数
    }

    // 非公平：直接 CAS 减少许可数
    final int nonfairTryAcquireShared(int acquires) {
        for (;;) {
            int available = getState();
            int remaining = available - acquires;
            // remaining < 0 表示许可不足，返回负数（进入等待队列）
            // remaining >= 0 表示成功，CAS 更新 state 后返回剩余数
            if (remaining < 0 || compareAndSetState(available, remaining))
                return remaining;
        }
    }

    // 释放：state 增加
    protected final boolean tryReleaseShared(int releases) {
        for (;;) {
            int current = getState();
            int next = current + releases;
            if (next < current) throw new Error("Maximum permit count exceeded");
            if (compareAndSetState(current, next))
                return true;  // 返回 true，触发 AQS 唤醒等待线程
        }
    }
}
```

### 4.4 公平 vs 非公平 Semaphore

与 `ReentrantLock` 类似，`Semaphore` 也支持公平/非公平两种模式：

```java
Semaphore fairSemaphore = new Semaphore(10, true);    // 公平
Semaphore unfairSemaphore = new Semaphore(10, false); // 非公平（默认）
```

**非公平 Semaphore**：调用 `acquire()` 时直接尝试 CAS 减少 `state`，不检查等待队列。如果此时有许可可用，直接获取（可能"插队"到已经在等待队列中的线程前面）。吞吐量高，但可能导致等待时间长的线程饥饿。

**公平 Semaphore**：通过 `hasQueuedPredecessors()` 检查队列，若有等待线程则排队，严格 FIFO。公平但吞吐量略低。

### 4.5 tryAcquire 的非阻塞用法

```java
// tryAcquire()：立即尝试，获取不到返回 false（不阻塞）
if (semaphore.tryAcquire()) {
    try {
        doWork();
    } finally {
        semaphore.release();
    }
} else {
    // 没有可用许可，执行降级逻辑
    returnCachedResult();
}

// tryAcquire(timeout)：带超时的尝试
if (semaphore.tryAcquire(100, TimeUnit.MILLISECONDS)) {
    // ...
}
```

> [!warning] 生产避坑
> `Semaphore.release()` 不检查调用线程是否持有许可——任何线程都可以调用 `release()` 来增加许可数，甚至可以增加到超过初始值。这与 `ReentrantLock.unlock()` 必须由持有者调用不同。如果程序逻辑有 Bug（如 `release()` 被多次调用），许可数会异常增大，失去流量控制的效果。务必用 `try-finally` 保证 `acquire` 和 `release` 的配对。

---

## 第 5 章 Exchanger——双线程数据交换

### 5.1 设计动机

`Exchanger` 是一个非常特殊的同步工具：它让**两个线程**在一个"交换点"互相交换数据。每个线程提供数据，调用 `exchange(V x)` 阻塞等待，直到另一个线程也调用 `exchange()`，两者交换数据后各自继续。

这个模式的典型场景是**流水线处理**：

```
生产者线程                          消费者线程
  ┌─────────────────────┐            ┌─────────────────────┐
  │ 用空 buffer 填充数据  │            │ 处理 buffer 中的数据  │
  │ buffer = fillBuffer()│            │ process(buffer)      │
  │ exchange(buffer)  ──┼────────────┼── exchange(emptyBuf)  │
  │ buffer = emptyBuf   │  ←拿到空buf│ buffer = filledBuf    │
  └─────────────────────┘            └─────────────────────┘
         ↓                                    ↓
  继续填充下一批数据                    继续处理这批数据
```

生产者和消费者通过 `Exchanger` 交换 buffer，生产者拿到空 buffer 继续填充，消费者拿到满 buffer 继续处理，两者可以并行工作，通过 buffer 交换来协调进度。

### 5.2 基本使用

```java
Exchanger<List<String>> exchanger = new Exchanger<>();

// 生产者线程
Thread producer = new Thread(() -> {
    List<String> buffer = new ArrayList<>();
    while (true) {
        // 填充 buffer
        for (int i = 0; i < 100; i++) {
            buffer.add(produceItem());
        }
        // 与消费者交换：提交满 buffer，获取空 buffer
        try {
            buffer = exchanger.exchange(buffer);  // 阻塞直到消费者也 exchange
            buffer.clear();  // 拿到的是消费者归还的空 buffer，清空可以复用
        } catch (InterruptedException e) {
            break;
        }
    }
});

// 消费者线程
Thread consumer = new Thread(() -> {
    List<String> buffer = new ArrayList<>();  // 初始空 buffer
    while (true) {
        // 与生产者交换：提交空 buffer，获取满 buffer
        try {
            buffer = exchanger.exchange(buffer);  // 拿到生产者填充的满 buffer
        } catch (InterruptedException e) {
            break;
        }
        // 消费 buffer 中的数据
        buffer.forEach(item -> consume(item));
        buffer.clear();
    }
});
```

### 5.3 Exchanger 的内部实现

`Exchanger` 的实现不依赖 AQS，而是使用了一种基于 CAS 的无锁算法：

```java
public class Exchanger<V> {
    // 槽位：存储等待交换的数据
    private volatile Node[] arena;   // 多槽（高并发时防止竞争）
    private volatile Node slot;      // 单槽（低并发时使用）
    
    static final class Node {
        int index;           // 当前使用的竞技场槽位索引
        int bound;           // 上次记录的竞技场边界
        int collides;        // 在当前 bound 下的 CAS 失败次数
        int hash;            // 伪随机数，用于选择槽位
        Object item;         // 本线程要交换的数据
        volatile Object match;  // 交换到的对方数据（null 表示尚未交换）
        volatile Thread parked; // 等待的线程（需要 unpark 时使用）
    }
}
```

单槽模式（低并发）下的核心逻辑：

1. 线程 A 调用 `exchange(dataA)`：将 `dataA` 放入 `slot.item`，然后等待（park）
2. 线程 B 调用 `exchange(dataB)`：发现 `slot` 已有数据，取出 `slot.item`（= `dataA`），将 `dataB` 写入 `slot.match`，唤醒线程 A
3. 线程 A 被唤醒，读取 `slot.match`（= `dataB`），交换完成

高并发时，多个"交换对"可能同时到来，单槽会产生竞争，此时 `Exchanger` 动态扩展为多槽竞技场（`arena`），将不同的线程对散列到不同的槽位，减少竞争。

---

## 第 6 章 四种工具的选型对比

| 工具 | 核心语义 | 是否可复用 | 参与者关系 | 实现基础 |
| :--- | :--- | :--- | :--- | :--- |
| `CountDownLatch` | 1（或少数）等待 N 个事件完成 | ❌ 一次性 | 等待者与通知者分离 | AQS 共享模式 |
| `CyclicBarrier` | N 个线程互相等待，凑齐同行 | ✅ 可循环复用 | 所有线程角色对等 | `ReentrantLock` + `Condition` |
| `Semaphore` | 限制同时访问资源的线程数 | ✅ 持续有效 | 申请者与许可计数器 | AQS 共享模式 |
| `Exchanger` | 两个线程互换数据 | ✅ 可重复交换 | 只支持两个线程 | 无锁 CAS + 竞技场 |

**选型决策**：

```
多个线程需要协调，核心诉求是什么？
    │
    ├─ 等待 N 个任务/事件完成？
    │   ├─ 只需要等一次 → CountDownLatch
    │   └─ 需要多次重复 → 用 CompletableFuture.allOf 或循环创建新 CountDownLatch
    │
    ├─ N 个线程需要在某个时间点同步后继续？
    │   ├─ 只需要一次同步 → CountDownLatch（更简单）
    │   └─ 需要多次同步（如多轮迭代计算） → CyclicBarrier
    │
    ├─ 需要限制并发访问某资源的线程数？
    │   └─ Semaphore（指定许可数即为并发度上限）
    │
    └─ 两个线程需要互换数据？
        └─ Exchanger
```

---

## 第 7 章 生产中的注意事项

### 7.1 CountDownLatch 的 countDown 必须在 finally 中

```java
// 正确：finally 保证 countDown 一定执行，防止 latch.await() 永久阻塞
executor.submit(() -> {
    try {
        doWork();
    } finally {
        latch.countDown();  // 即使 doWork() 抛异常也必须 countDown
    }
});

// 错误：doWork 抛异常时，countDown 不执行，主线程永久阻塞
executor.submit(() -> {
    doWork();
    latch.countDown();  // 可能不会执行！
});
```

### 7.2 CyclicBarrier 的异常处理

```java
// CyclicBarrier 需要处理 BrokenBarrierException
for (int i = 0; i < parties; i++) {
    executor.submit(() -> {
        try {
            doPhaseWork();
            barrier.await();  // 可能抛 BrokenBarrierException 或 InterruptedException
            doContinuation();
        } catch (BrokenBarrierException e) {
            // 某个线程中断/超时导致屏障损坏，当前线程应该放弃这一轮
            log.warn("屏障已损坏，放弃本轮计算");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    });
}
```

### 7.3 Semaphore 的 release 必须与 acquire 配对

```java
// Semaphore 的经典用法模板
semaphore.acquire();
try {
    doWork();
} finally {
    semaphore.release();  // 无论如何都释放
}

// 不要这样写（忘了 finally）：
semaphore.acquire();
doWork();          // 如果抛异常，semaphore 泄漏
semaphore.release();
```

---

## 第 8 章 总结

这四个并发工具类是 JUC 并发协调层次的高级抽象，它们各自针对特定场景提供了简洁的 API，底层都依赖前文学过的同步原语（AQS、`ReentrantLock`）：

**`CountDownLatch`**：一次性倒计时门闩，基于 AQS 共享模式，`state` 从 N 倒数到 0，触发所有等待者的级联唤醒。适合"主线程等 N 个子任务完成"或"多线程等同一起跑信号"。

**`CyclicBarrier`**：可复用的循环屏障，基于 `ReentrantLock` + `Condition`，支持 barrierAction，`BrokenBarrierException` 保证屏障损坏时所有参与者立即感知。适合多轮迭代计算中的阶段同步。

**`Semaphore`**：信号量，基于 AQS 共享模式，`state` 表示可用许可数，是互斥锁的广义化。适合限制并发资源访问数量，是连接池、限流器的基础构建块。

**`Exchanger`**：双线程数据交换，基于无锁 CAS 竞技场。适合流水线模式中生产者与消费者的 buffer 交换。

下一篇 [[JUC工具/15 ThreadLocal 的实现原理与内存泄漏——线程封闭的正确姿势]] 将剖析 `ThreadLocal` 的数据结构（`Thread.threadLocals` 字段的 `ThreadLocalMap`）以及 `Entry` 的弱引用设计为什么仍然会导致内存泄漏。

---

## 参考文献

1. Doug Lea, "`java.util.concurrent`" 包 Javadoc
2. Goetz et al., "Java Concurrency in Practice", Ch.5: Building Blocks
3. OpenJDK 源码：`CountDownLatch`、`CyclicBarrier`、`Semaphore`、`Exchanger`
4. Herlihy & Shavit, "The Art of Multiprocessor Programming", Ch.17: Barriers
5. Dijkstra, E.W., "Cooperating Sequential Processes", 1965

---

> [!note] 思考题
> 1. CountDownLatch 是一次性的（计数减到零后无法重置），CyclicBarrier 可以重复使用（所有线程到达后自动重置）。在一个'主线程等待 N 个子任务完成'的场景中，两者都能实现。但如果某个子任务失败了需要重试，CountDownLatch 的一次性特性会导致什么问题？CyclicBarrier 的 `BrokenBarrierException` 机制如何处理线程故障？
> 2. Semaphore 的 `acquire()` 和 `release()` 不要求由同一个线程调用——这意味着线程 A 可以 `acquire()`，线程 B 可以 `release()`。这与 Lock 的'谁加锁谁解锁'语义不同。在什么场景下你需要'跨线程释放许可'的能力？这种灵活性是否也带来了滥用的风险？
> 3. Semaphore 可以用于实现限流——控制同时访问某资源的线程数。但 Semaphore 的许可是'公平'或'不公平'的——不公平模式下新请求可能插队。在 API 限流场景中，公平 Semaphore 和不公平 Semaphore 对用户体验有什么不同影响？生产环境中你更倾向于哪种？
