---
title: "ReentrantLock 深度剖析——公平锁、非公平锁与可中断"
date: 2026-03-05
tags: [Java, 并发编程, ReentrantLock, 公平锁, 非公平锁, 可中断, tryLock, AQS, synchronized对比]
aliases: []
---

# 07 ReentrantLock 深度剖析——公平锁、非公平锁与可中断

**摘要：**

`ReentrantLock` 是 JUC 并发包中使用最广泛的显式锁实现。它与 `synchronized` 在语义上等价——都提供可重入的互斥锁——但 `ReentrantLock` 提供了 `synchronized` 所没有的能力：**可中断的等待**（`lockInterruptibly`）、**有超时的尝试**（`tryLock`）、**公平性选择**（`FairSync` vs `NonfairSync`）以及**多个等待条件**（`newCondition()`）。本文在 [[JUC工具/06 AQS 框架——AbstractQueuedSynchronizer 的设计与实现]] 的基础上，深入剖析 `ReentrantLock` 的四种获取锁方式的实现差异、公平锁的 `hasQueuedPredecessors` 检查如何防止插队、非公平锁的插队策略为什么能提升吞吐量、以及 `tryLock(timeout)` 如何在 AQS 中实现超时等待。文章最后给出 `ReentrantLock` 与 `synchronized` 选型的工程决策树。

---

## 第 1 章 ReentrantLock 的诞生背景

### 1.1 synchronized 的局限性

`synchronized` 是 Java 最基础的同步原语，但它的语义非常受限：

**锁定粒度固定**：`synchronized` 只能锁定整个方法或代码块，无法在代码块中途"先锁 A，再锁 B，然后释放 A"这样的灵活操作。

**无法中断等待**：一个线程在等待 `synchronized` 锁时，如果另一个线程调用了 `interrupt()`，线程不会被唤醒，必须等到真正获取锁之后才能响应中断。对于需要响应"取消"信号的场景（如任务超时取消），`synchronized` 无能为力。

**无法尝试非阻塞获取**：`synchronized` 只能阻塞等待，没有"尝试获取，获取不到就算了"的 `tryLock()` 语义。这使得死锁避免算法（如"按序获取锁失败就全部释放重试"）难以实现。

**只有一个等待队列**：`synchronized` 的 `Object.wait()`/`notify()` 系统对所有等待线程共用一个 WaitSet，无法区分"等待某个条件 A"和"等待某个条件 B"的线程，`notifyAll()` 会唤醒所有等待线程（通常是不必要的）。

**无法选择公平性**：`synchronized` 的锁获取是非公平的，但没有提供公平模式选项。

`ReentrantLock` 正是为了解决这些局限性而设计的，作为 `java.util.concurrent.locks.Lock` 接口的实现，提供了更灵活、更丰富的锁操作语义。

### 1.2 Lock 接口的设计

```java
public interface Lock {
    void lock();                    // 阻塞获取锁，不响应中断
    void lockInterruptibly()        // 阻塞获取锁，响应中断
        throws InterruptedException;
    boolean tryLock();              // 立即尝试获取，成功返回 true，失败返回 false（非阻塞）
    boolean tryLock(long time,      // 带超时的尝试获取
        TimeUnit unit)
        throws InterruptedException;
    void unlock();                  // 释放锁
    Condition newCondition();       // 创建一个绑定到此锁的 Condition 对象
}
```

`Lock` 接口的四种获取方式覆盖了几乎所有实际场景：
- `lock()`：最常用，与 `synchronized` 等价
- `lockInterruptibly()`：可取消的等待，用于实现超时取消
- `tryLock()`：非阻塞尝试，用于死锁避免或"宁可放弃也不阻塞"的场景
- `tryLock(timeout)`：有超时的等待，介于阻塞等待和立即放弃之间

---

## 第 2 章 ReentrantLock 的内部结构

### 2.1 层次结构

```
ReentrantLock
    └── Sync extends AbstractQueuedSynchronizer
            ├── NonfairSync extends Sync  （非公平锁，默认）
            └── FairSync extends Sync     （公平锁）
```

`ReentrantLock` 本身只是一个外壳，所有锁操作都委托给内部的 `Sync` 对象。`ReentrantLock(boolean fair)` 构造器决定使用 `FairSync` 还是 `NonfairSync`：

```java
public ReentrantLock() {
    sync = new NonfairSync();  // 默认非公平
}

public ReentrantLock(boolean fair) {
    sync = fair ? new FairSync() : new NonfairSync();
}
```

### 2.2 state 的语义

在 `ReentrantLock` 中，AQS 的 `state` 字段语义如下：
- `state == 0`：锁未被持有，任何线程可以获取
- `state > 0`：锁被某线程持有，值为重入次数（同一线程每次 `lock()` 加 1，每次 `unlock()` 减 1，归零时完全释放）

`Sync` 还持有 `exclusiveOwnerThread`（继承自 `AbstractOwnableSynchronizer`），记录当前持有锁的线程，用于判断可重入和 `isHeldByCurrentThread()` 检查。

---

## 第 3 章 四种获取锁方式的深度剖析

### 3.1 lock()——最基础的阻塞获取

`ReentrantLock.lock()` 对应 `NonfairSync.lock()` 或 `FairSync.lock()`，不响应中断。

**非公平锁的 `lock()`**：

```java
// NonfairSync.lock()（JDK 17 精简版）
final void lock() {
    // 关键：直接 CAS 尝试将 state 从 0 改为 1
    // 如果成功，设置持有线程为当前线程，直接返回（"插队"成功）
    if (!initialTryLock())
        acquire(1);  // 失败则走 AQS 标准流程（入队等待）
}

// NonfairSync.initialTryLock()
final boolean initialTryLock() {
    Thread current = Thread.currentThread();
    if (compareAndSetState(0, 1)) {  // 第一次直接 CAS，不检查队列
        setExclusiveOwnerThread(current);
        return true;
    } else if (getExclusiveOwnerThread() == current) {  // 可重入
        int c = getState() + 1;
        if (c < 0) throw new Error("Maximum lock count exceeded");
        setState(c);
        return true;
    } else {
        return false;  // 失败，进入 AQS acquire 流程
    }
}
```

非公平锁在 `lock()` 时直接 CAS 抢锁，完全不检查等待队列中是否有其他线程。这个"直接 CAS"是非公平的核心——当锁刚好被释放的瞬间，如果有一个新来的线程调用 `lock()`，它可以比等待队列中已经 `unpark()` 但还没开始运行的线程更快获得锁。

**为什么非公平锁性能更好？**

想象这样的场景：锁被线程 A 持有，线程 B、C 在等待队列中。线程 A 释放锁，唤醒线程 B（`unpark(B)`）。但 `unpark` 到线程 B 真正被 CPU 调度起来执行，需要几微秒到几十微秒。在这个空档里，如果线程 D 调用 `lock()`：

- **公平锁**：D 检查到队列中有 B 在等待，乖乖进入队列排在 B 之后
- **非公平锁**：D 直接 CAS，发现 `state == 0`（B 还没抢到），成功获取锁，立即执行，执行完释放锁，再唤醒 B

非公平锁让 D 在 B 的"调度等待期"内完成了一次锁的获取和释放，提升了 CPU 的利用率和整体吞吐量。代价是 B 的等待时间变长了，但整体处理的任务数更多。

**公平锁的 `lock()`**：

```java
// FairSync.initialTryLock()
final boolean initialTryLock() {
    Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        // 公平锁的核心：先检查队列中是否有其他等待线程
        if (!hasQueuedThreads() && compareAndSetState(0, 1)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (getExclusiveOwnerThread() == current) {
        // 可重入
        if (++c < 0) throw new Error("Maximum lock count exceeded");
        setState(c);
        return true;
    }
    return false;
}
```

公平锁在 `lock()` 时先调用 `hasQueuedThreads()`，如果队列中有等待线程，即使 `state == 0`（锁空闲），也不会直接 CAS 抢锁，而是乖乖入队排在后面。

**`hasQueuedPredecessors()` 与 `hasQueuedThreads()` 的区别**：

`tryAcquire` 中使用 `hasQueuedPredecessors()`——"是否有线程在我之前等待"（即队列中是否有节点且我不是头节点的直接后继）。`initialTryLock` 中使用 `hasQueuedThreads()`——"队列中是否有任何线程在等待"（更严格）。

### 3.2 lockInterruptibly()——可中断的阻塞获取

`lockInterruptibly()` 与 `lock()` 的唯一区别是：在等待过程中，如果线程被 `interrupt()`，会立即抛出 `InterruptedException`，而不是等到获取锁后才处理中断。

AQS 为此提供了 `acquireInterruptibly(int arg)`：

```java
public final void acquireInterruptibly(int arg) throws InterruptedException {
    if (Thread.interrupted())
        throw new InterruptedException();  // 先检查是否已被中断
    if (!tryAcquire(arg))
        doAcquireInterruptibly(arg);       // 进入可中断的等待流程
}

private void doAcquireInterruptibly(int arg) throws InterruptedException {
    final Node node = addWaiter(Node.EXCLUSIVE);
    try {
        for (;;) {
            final Node p = node.predecessor();
            if (p == head && tryAcquire(arg)) {
                setHead(node);
                p.next = null;
                return;
            }
            if (shouldParkAfterFailedAcquire(p, node) &&
                parkAndCheckInterrupt())
                throw new InterruptedException();  // 被中断时直接抛异常！
                // 注意：普通的 acquireQueued 只是记录中断标志，不抛异常
        }
    } catch (Throwable t) {
        cancelAcquire(node);
        throw t;
    }
}
```

对比普通 `acquireQueued`（不可中断版）：

```java
// 不可中断版：被中断只是记录标志，不抛异常
if (shouldParkAfterFailedAcquire(p, node) && parkAndCheckInterrupt())
    interrupted = true;  // 只记录，继续等待
```

```java
// 可中断版：被中断直接取消等待并抛异常
if (shouldParkAfterFailedAcquire(p, node) && parkAndCheckInterrupt())
    throw new InterruptedException();  // 立即中止等待
```

这一行之差，决定了线程在被中断时是"继续等"还是"立即放弃"。

**典型使用场景**：

```java
public void doTask() throws InterruptedException {
    lock.lockInterruptibly();  // 可以被 cancel() 操作中断
    try {
        performWork();
    } finally {
        lock.unlock();
    }
}

// 在另一个线程中取消任务
public void cancel(Thread t) {
    t.interrupt();  // 唤醒 lockInterruptibly() 中的等待，让它抛 InterruptedException
}
```

### 3.3 tryLock()——立即尝试，不等待

`tryLock()` 是非阻塞的：尝试获取锁，成功返回 `true`，失败立即返回 `false`，不进入等待队列。

```java
// ReentrantLock.tryLock()
public boolean tryLock() {
    return sync.nonfairTryAcquire(1);  // 注意：永远是非公平的！
}
```

> [!warning] 生产避坑
> `tryLock()` 永远是非公平的，即使创建的是公平锁（`new ReentrantLock(true)`）。这是因为 `tryLock()` 的语义是"立即尝试"，如果此时锁空闲就应该直接获取，没有理由拒绝。JDK 文档明确指出了这一点：即使是公平锁，`tryLock()` 也会直接尝试获取而不检查队列。如果你需要公平的 `tryLock()`，必须使用 `tryLock(0, TimeUnit.NANOSECONDS)` 替代。

**死锁避免的经典模式**：

```java
// 转账场景：需要同时持有两个账户的锁
public boolean transfer(Account from, Account to, int amount) {
    while (true) {
        if (from.lock.tryLock()) {             // 尝试获取 from 锁
            try {
                if (to.lock.tryLock()) {       // 尝试获取 to 锁
                    try {
                        // 两个锁都获取成功，执行转账
                        from.balance -= amount;
                        to.balance += amount;
                        return true;
                    } finally {
                        to.lock.unlock();
                    }
                }
                // to 锁获取失败，释放 from 锁，随机等待后重试（指数退避）
            } finally {
                from.lock.unlock();
            }
        }
        // 随机等待，避免活锁（两个线程同时重试）
        Thread.sleep(ThreadLocalRandom.current().nextInt(10));
    }
}
```

这种"尝试-失败-释放所有-重试"的模式用 `synchronized` 是无法实现的。

### 3.4 tryLock(timeout)——有超时的阻塞等待

`tryLock(long timeout, TimeUnit unit)` 在 AQS 中通过 `doAcquireNanos` 实现，它结合了可中断等待和超时机制：

```java
private boolean doAcquireNanos(int arg, long nanosTimeout) throws InterruptedException {
    if (nanosTimeout <= 0L) return false;
    
    final long deadline = System.nanoTime() + nanosTimeout;  // 计算截止时间
    final Node node = addWaiter(Node.EXCLUSIVE);
    
    try {
        for (;;) {
            final Node p = node.predecessor();
            if (p == head && tryAcquire(arg)) {
                setHead(node);
                p.next = null;
                return true;  // 成功获取
            }
            
            // 计算剩余等待时间
            nanosTimeout = deadline - System.nanoTime();
            if (nanosTimeout <= 0L) {
                cancelAcquire(node);
                return false;  // 超时！返回 false
            }
            
            if (shouldParkAfterFailedAcquire(p, node) &&
                nanosTimeout > SPIN_FOR_TIMEOUT_THRESHOLD)  // 剩余时间 > 1000ns 才 park
                LockSupport.parkNanos(this, nanosTimeout);  // 带超时的 park
            
            if (Thread.interrupted())
                throw new InterruptedException();  // 可中断
        }
    } catch (Throwable t) {
        cancelAcquire(node);
        throw t;
    }
}
```

**`SPIN_FOR_TIMEOUT_THRESHOLD = 1000L`（1 微秒）** 这个细节很重要：当剩余超时时间小于 1 微秒时，不再 `parkNanos`（因为 `parkNanos` 本身的调度精度就在微秒级，无意义），而是直接自旋。这避免了在极短超时时间下的线程上下文切换代价。

---

## 第 4 章 可重入性的实现

### 4.1 什么是可重入性

**可重入性（Reentrancy）** 是指同一个线程可以多次获取同一把锁，而不会死锁。这是 `synchronized` 和 `ReentrantLock` 共同具备的特性。

没有可重入性会发生什么？

```java
public synchronized void outer() {
    inner();  // inner 也是 synchronized，如果锁不可重入，这里会死锁
}

public synchronized void inner() {
    // ...
}
```

如果锁不可重入，`outer()` 持有锁后调用 `inner()`，`inner()` 尝试再次获取同一个锁，但锁已经被当前线程持有，会阻塞等待——而持有锁的就是当前线程，形成死锁。

### 4.2 ReentrantLock 的重入实现

`ReentrantLock` 的重入通过 `state` 计数和 `exclusiveOwnerThread` 记录实现：

```java
// tryAcquire 中的可重入检查
} else if (current == getExclusiveOwnerThread()) {
    // 同一线程再次获取：state 加 1
    int nextc = c + acquires;
    if (nextc < 0) throw new Error("Maximum lock count exceeded");
    setState(nextc);
    return true;
}
```

```java
// tryRelease 中的重入释放
protected final boolean tryRelease(int releases) {
    int c = getState() - releases;  // state 减 1
    if (Thread.currentThread() != getExclusiveOwnerThread())
        throw new IllegalMonitorStateException();
    boolean free = (c == 0);        // 只有 state 归零时才真正释放锁
    if (free)
        setExclusiveOwnerThread(null);
    setState(c);
    return free;  // 只有完全释放时才返回 true，触发后继唤醒
}
```

**重入深度限制**：`state` 是一个 `int`，理论上最大重入深度是 `Integer.MAX_VALUE`（约 21 亿次）。实际上不可能达到这个限制，但代码里有防御性检查 `if (nextc < 0) throw new Error(...)`——因为重入次数过多可能是 Bug（如递归死循环中加锁），抛出 `Error` 比静默地让 `int` 溢出更合理。

---

## 第 5 章 Condition 的使用与实现

### 5.1 多 Condition 的优势

一个 `ReentrantLock` 可以创建多个 `Condition`，这使得精细化的等待-通知成为可能：

```java
// 有界阻塞队列的典型实现
class BoundedBlockingQueue<E> {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull  = lock.newCondition();  // 等待"队列未满"
    private final Condition notEmpty = lock.newCondition();  // 等待"队列非空"
    private final Object[] items;
    private int putIndex, takeIndex, count;

    public void put(E e) throws InterruptedException {
        lock.lock();
        try {
            while (count == items.length)
                notFull.await();    // 队列满了，等待"未满"信号
            items[putIndex] = e;
            if (++putIndex == items.length) putIndex = 0;
            count++;
            notEmpty.signal();      // 通知等待"非空"的消费者
        } finally {
            lock.unlock();
        }
    }

    public E take() throws InterruptedException {
        lock.lock();
        try {
            while (count == 0)
                notEmpty.await();   // 队列空了，等待"非空"信号
            E e = (E) items[takeIndex];
            if (++takeIndex == items.length) takeIndex = 0;
            count--;
            notFull.signal();       // 通知等待"未满"的生产者
            return e;
        } finally {
            lock.unlock();
        }
    }
}
```

与 `Object.wait()/notifyAll()` 相比，多 `Condition` 的精确 `signal()` 避免了 `notifyAll()` 唤醒所有等待线程（包括那些条件根本不满足的线程）的低效行为。`ArrayBlockingQueue` 的内部实现正是这种 `notFull`/`notEmpty` 双 Condition 模式（JDK 7 之前），JDK 8+ 改为两把锁，但原理类似。

### 5.2 await() 的正确使用模式

```java
// 正确：在循环中检查条件
while (!conditionMet()) {
    condition.await();
}
doWorkWhenConditionMet();

// 错误：只检查一次
if (!conditionMet()) {
    condition.await();
}
doWorkWhenConditionMet();  // 可能在条件不满足时执行！
```

必须用 `while` 而不是 `if`，原因是**虚假唤醒（Spurious Wakeup）**：`await()` 可能在没有 `signal()` 的情况下自动返回（这是操作系统层面的特性，POSIX 标准明确允许 `pthread_cond_wait` 有虚假唤醒）。即使不考虑虚假唤醒，`notifyAll()` 唤醒多个线程后，也只有一个线程能真正满足条件执行，其他线程必须重新检查条件再决定是否继续等待。

---

## 第 6 章 ReentrantLock vs synchronized：工程选型

### 6.1 功能对比

| 特性 | `synchronized` | `ReentrantLock` |
| :--- | :--- | :--- |
| **可重入性** | ✅ | ✅ |
| **公平性选择** | ❌ 只有非公平 | ✅ 支持公平/非公平 |
| **可中断等待** | ❌ | ✅ `lockInterruptibly()` |
| **超时等待** | ❌ | ✅ `tryLock(timeout)` |
| **非阻塞尝试** | ❌ | ✅ `tryLock()` |
| **多等待条件** | ❌ 只有一个 WaitSet | ✅ 多个 `Condition` |
| **锁状态查询** | ❌ | ✅ `isLocked()`、`getQueueLength()` 等 |
| **实现层次** | JVM 内置（字节码 monitorenter/exit）| Java 代码（基于 AQS） |
| **忘记释放锁** | 不可能（编译器保证） | **⚠️ 可能**（必须在 finally 中释放）|

### 6.2 性能对比（JDK 6+）

JDK 6 引入了 `synchronized` 的锁升级机制后，两者在典型场景下的性能差异已经非常小。粗略规律：

| 竞争程度 | `synchronized` | `ReentrantLock`（非公平） |
| :--- | :--- | :--- |
| 无竞争（单线程） | 偏向锁/轻量级锁，极快 | 略快（无偏向锁撤销代价）|
| 低竞争（< 4 线程） | 轻量级锁 CAS，快 | 相当 |
| 中等竞争 | 重量级锁，慢 | 自适应自旋后入队，相当 |
| 高竞争（> 16 线程） | 重量级锁 + OS 调度 | 相当（都走 OS 阻塞） |

结论：**在 JDK 6+ 中，性能不应该是选择 `ReentrantLock` 的理由**，功能需求才是。

### 6.3 工程决策树

```
你需要的锁操作是否超出了 synchronized 的能力？
     │
     ├─ 需要可中断等待？        → ReentrantLock.lockInterruptibly()
     ├─ 需要超时等待？           → ReentrantLock.tryLock(timeout)
     ├─ 需要非阻塞尝试？         → ReentrantLock.tryLock()
     ├─ 需要多个等待条件？       → ReentrantLock + 多个 Condition
     ├─ 需要公平调度？           → ReentrantLock(true)
     ├─ 需要锁状态监控/调试？    → ReentrantLock（有丰富的监控 API）
     │
     └─ 以上都不需要？           → 优先使用 synchronized
                                   原因：代码更简洁，编译器保证 unlock，
                                   JIT 有更多优化机会（锁消除、锁粗化）
```

> [!note] 设计哲学
> `synchronized` 是"声明式"的——你声明一个临界区，JVM 保证互斥性；`ReentrantLock` 是"命令式"的——你显式获取和释放锁，享有更多控制权，但也承担更多责任（必须在 `finally` 中释放）。**能用声明式解决的问题，不要用命令式**——这是工程上的 KISS 原则。

### 6.4 ReentrantLock 的必须注意事项

**unlock 必须在 finally 块中**：

```java
// 正确姿势：unlock 必须在 finally 中
lock.lock();
try {
    // ... 临界区代码
} finally {
    lock.unlock();  // 无论是否有异常，都必须释放
}

// 错误姿势：如果临界区抛异常，lock 永远不会被释放
lock.lock();
doWork();    // 如果这里抛异常
lock.unlock(); // 这行不会执行！
```

**不要在 lock() 和 try 之间有其他代码**：

```java
// 潜在问题
lock.lock();
doSomethingBeforeTry();  // 如果这里抛异常，进了 try 吗？没有，unlock 不会执行
try {
    doWork();
} finally {
    lock.unlock();
}

// 正确：lock() 和 try 之间不要有任何代码
lock.lock();
try {
    doWork();
} finally {
    lock.unlock();
}
```

---

## 第 7 章 总结

`ReentrantLock` 是 `synchronized` 的显式锁替代品，在功能层面全面覆盖并超越了 `synchronized`：

**四种获取方式**：`lock()`（阻塞不响应中断）、`lockInterruptibly()`（阻塞响应中断）、`tryLock()`（非阻塞立即返回）、`tryLock(timeout)`（带超时的阻塞）——覆盖了所有实际场景的需求。

**公平锁 vs 非公平锁**：非公平锁（默认）在"锁刚释放"的瞬间允许新来的线程插队，提升吞吐量但可能导致饥饿；公平锁严格 FIFO，延迟可预测但吞吐量略低。绝大多数场景使用默认的非公平锁。

**多 Condition**：相比 `synchronized` 的单一 WaitSet，`Condition` 可以为不同的等待条件创建独立的等待队列，`signal()` 精确唤醒，比 `notifyAll()` 效率更高。

**使用原则**：优先 `synchronized`，需要更强功能时选 `ReentrantLock`，且 `unlock()` 必须在 `finally` 中。

下一篇 [[JUC工具/08 读写锁与 StampedLock——从 ReentrantReadWriteLock 到乐观读]] 将展示 `ReentrantLock` 的进阶形态：当临界区的读操作远多于写操作时，如何通过读写锁进一步提升并发度。

---

## 参考文献

1. Doug Lea, "java.util.concurrent.locks.ReentrantLock" Javadoc & Design Notes
2. AQS 论文：Doug Lea, "The java.util.concurrent Synchronizer Framework", JACM 2004
3. Goetz et al., "Java Concurrency in Practice", Ch.13: Explicit Locks
4. JEP 374: Disable and Deprecate Biased Locking — 影响 synchronized vs ReentrantLock 的性能对比
5. OpenJDK 源码：`java.util.concurrent.locks.ReentrantLock`

---

> [!note] 思考题
> 1. `ReentrantLock` 相比 `synchronized` 提供了可中断、可超时、可条件等待（`Condition`）和公平性选择等额外能力。在 JDK 6 之后，`synchronized` 经过偏向锁/轻量级锁等优化后性能已经与 `ReentrantLock` 接近。在什么场景下你仍然必须选择 `ReentrantLock` 而非 `synchronized`？
> 2. `Condition.await()` 可以被 `signal()` 或 `signalAll()` 唤醒。`signalAll()` 唤醒所有等待线程，它们竞争重新获取锁——但只有一个能获取到。这种'惊群效应'（thundering herd）在等待线程非常多时是否会导致性能问题？`signal()` 只唤醒一个线程但可能唤醒'不需要被唤醒的'线程——你如何在精确唤醒和避免死锁之间权衡？
> 3. `ReentrantLock.lockInterruptibly()` 允许等待锁的线程被中断。但如果线程已经持有锁并在执行业务逻辑，此时调用 `thread.interrupt()` 不会导致线程释放锁——中断只在 `await/sleep/park` 等阻塞操作中生效。在一个需要'强制终止持锁线程'的场景中（如请求超时），你如何安全地实现？直接 `Thread.stop()` 有什么风险？
