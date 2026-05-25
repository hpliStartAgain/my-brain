---
title: "AQS 框架——AbstractQueuedSynchronizer 的设计与实现"
date: 2026-03-05
tags: [AbstractQueuedSynchronizer, AQS, CLH队列, CountDownLatch, Java, ReentrantLock, Semaphore, 并发编程, 模板方法]
aliases: []
---

# 06 AQS 框架——AbstractQueuedSynchronizer 的设计与实现

**摘要：**

如果说 CAS 是 JUC 并发包的"砖"，那么 **AQS（AbstractQueuedSynchronizer，抽象队列同步器）** 就是用这些砖建造出来的"地基"。`ReentrantLock`、`Semaphore`、`CountDownLatch`、`CyclicBarrier`、`ReentrantReadWriteLock` 全部构建在 AQS 之上。理解 AQS，就等于理解了半个 JUC 并发包的工作原理。AQS 的设计精髓在于：用**一个 `volatile int state` 变量**表达所有同步语义，用**一个 CLH 变体等待队列**管理所有阻塞线程，通过**模板方法模式**将"如何阻塞/唤醒"与"何时允许通过"分离——具体语义由子类实现，AQS 负责管理等待队列和线程调度。本文从 CLH 队列的数据结构出发，深入剖析独占模式（`acquire`/`release`）和共享模式（`acquireShared`/`releaseShared`）的完整实现，以及 `ConditionObject` 的等待-通知机制。

---

## 第 1 章 AQS 的设计哲学

### 1.1 同步器的本质问题

任何同步原语，无论是互斥锁、信号量、倒计时门闩还是读写锁，本质上都要解决同一个问题：**在某些条件不满足时，让线程等待；当条件满足时，唤醒等待的线程**。

不同同步原语的区别只是"什么条件"不同：
- **互斥锁**：条件是"没有其他线程持有锁"
- **信号量**：条件是"当前许可数 > 0"
- **倒计时门闩**：条件是"计数器已归零"
- **读写锁（读锁）**：条件是"没有写线程持有锁"
- **读写锁（写锁）**：条件是"没有任何线程持有锁（读或写）"

如果每种同步原语都从零开始实现"线程等待与唤醒"的机制，会产生大量重复代码，而且很难保证每个实现都是正确的（并发 Bug 非常难调试）。

Doug Lea 在设计 JUC 时，识别出了这个共同骨架，将其提炼为 **AQS**：把所有同步原语共用的"等待队列管理"和"线程 park/unpark"逻辑统一封装在 AQS 中，只把"是否允许通过"的判断逻辑留给子类实现。这是**模板方法模式**（Template Method Pattern）在并发编程中的绝佳应用。

### 1.2 AQS 的核心抽象

AQS 只有两个核心的状态变量：

```java
// 同步状态：所有语义都编码在这一个 int 中
private volatile int state;

// 等待队列的头节点（哑节点）
private transient volatile Node head;

// 等待队列的尾节点
private transient volatile Node tail;
```

这三个字段撑起了整个 AQS 的运作机制。`state` 的具体语义由子类定义：
- `ReentrantLock` 中：`state = 0` 表示锁未被持有；`state > 0` 表示锁被持有，值为重入次数
- `Semaphore` 中：`state` 表示剩余的许可数量
- `CountDownLatch` 中：`state` 表示剩余的计数值（归零时门闩打开）
- `ReentrantReadWriteLock` 中：`state` 的高 16 位表示读锁持有数，低 16 位表示写锁重入数

---

## 第 2 章 CLH 队列变体——等待节点的数据结构

### 2.1 为什么选择 CLH 队列

在多个线程竞争锁失败需要等待时，JVM 需要一种数据结构来管理这些等待线程。最简单的想法是一个链表，但对链表的插入/删除必须是线程安全的，这本身又需要锁——循环依赖。

**CLH 锁**（Craig, Landin, Hagersten 锁）是一种基于单向链表的公平自旋锁：每个线程在前驱节点的 `locked` 字段上自旋，锁释放时只有直接后继被唤醒，无需广播。CLH 锁的关键优势是：每个线程在自己的"本地"变量（前驱的字段）上自旋，而不是在同一个全局变量上自旋，减少了缓存争用。

AQS 使用的是 CLH 队列的**变体**，将自旋改为阻塞（`LockSupport.park`），并改为双向链表（以便取消节点时能快速找到前驱）：

```java
static final class Node {
    // 节点等待状态
    static final int CANCELLED =  1;  // 线程因超时或中断而取消等待
    static final int SIGNAL    = -1;  // 后继节点需要被唤醒（当前节点释放时需要 unpark 后继）
    static final int CONDITION = -2;  // 节点在 Condition 等待队列中
    static final int PROPAGATE = -3;  // 共享模式：唤醒需要向后传播

    volatile int waitStatus;      // 节点状态（CANCELLED/SIGNAL/CONDITION/PROPAGATE/0）
    volatile Node prev;           // 前驱节点（双向链表）
    volatile Node next;           // 后继节点
    volatile Thread thread;       // 等待的线程
    Node nextWaiter;              // Condition 队列中的下一个节点（或共享模式标记）
}
```

**`waitStatus` 字段的语义**是理解 AQS 的关键。每个节点的 `waitStatus` 描述的不是当前节点自身的状态，而是"**当前节点能对其后继做什么**"：

- **`SIGNAL(-1)`**：表示"当前节点的后继节点正在等待被唤醒"。当当前节点释放锁或放弃等待时，必须 `unpark` 后继节点。这是最常见的状态。
- **`CANCELLED(1)`**：表示"当前节点已经因超时或中断而取消"。取消的节点最终会从队列中移除，永远不会被唤醒。
- **`CONDITION(-2)`**：表示"当前节点在 Condition 的等待队列（`WaitSet`）中，而不是同步队列中"。
- **`PROPAGATE(-3)`**：仅用于共享模式头节点，表示"唤醒需要向后续节点无条件传播"。
- **`0`**：初始状态，新节点入队时为 0。

### 2.2 等待队列的整体结构

AQS 的等待队列是一个 FIFO 双向链表，头节点是一个**哑节点**（dummy head，不对应任何线程），其后的节点依次是按加锁时间排列的等待线程：

```
         head（哑节点）       节点1             节点2          tail
        ┌──────────┐      ┌──────────┐      ┌──────────┐
 null ←─│  prev    │←─────│  prev    │←─────│  prev    │
        │  next   ─┼─────→│  next   ─┼─────→│  next    │─→ null
        │waitStatus│      │waitStatus│      │waitStatus│
        │  thread  │      │ Thread A │      │ Thread B │
        └──────────┘      └──────────┘      └──────────┘
```

哑头节点的存在简化了队列操作：入队只需操作 `tail`，出队（获取锁成功）只需将自己变成新的哑头节点，无需处理空队列的特殊情况。

---

## 第 3 章 独占模式：acquire 与 release

### 3.1 acquire 的完整流程

独占模式的获取锁（`acquire`）是 AQS 最核心的方法，代码非常简洁但逻辑精妙：

```java
// AQS 的 acquire 方法（模板，子类不覆盖此方法）
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&              // 1. 子类实现：尝试获取（不阻塞）
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))  // 2. 失败则入队等待
        selfInterrupt();  // 3. 如果在等待期间被中断，在此重新中断
}
```

**步骤 1：`tryAcquire(arg)`**

这是子类实现的方法——子类在这里检查 `state` 是否满足条件，如果满足就用 CAS 更新 `state` 并返回 `true`，否则返回 `false`。例如 `ReentrantLock` 的非公平锁实现：

```java
// ReentrantLock.NonfairSync.tryAcquire
protected final boolean tryAcquire(int acquires) {
    return nonfairTryAcquire(acquires);
}

final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        // 锁未被持有，直接 CAS 抢锁（不检查队列中是否有等待线程——这就是"非公平"）
        if (compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {
        // 可重入：同一线程再次获取，state 直接加 acquires
        int nextc = c + acquires;
        if (nextc < 0) throw new Error("Maximum lock count exceeded");
        setState(nextc);
        return true;
    }
    return false;
}
```

**步骤 2：`addWaiter(Node.EXCLUSIVE)`**

`tryAcquire` 失败后，将当前线程包装成 Node 加入等待队列尾部：

```java
private Node addWaiter(Node mode) {
    Node node = new Node(mode);  // 创建新节点，mode = EXCLUSIVE 或 SHARED
    for (;;) {
        Node oldTail = tail;
        if (oldTail != null) {
            // 队列已初始化，CAS 将新节点设为 tail
            node.setPrevRelaxed(oldTail);
            if (compareAndSetTail(oldTail, node)) {
                oldTail.next = node;  // 注意：先 CAS tail，再设置 prev.next
                return node;
            }
            // CAS 失败（有竞争），重试
        } else {
            // 队列未初始化，创建哑头节点
            initializeSyncQueue();
        }
    }
}
```

这里有一个**重要细节**：`node.prev = oldTail`（通过 `setPrevRelaxed`）在 CAS 成功**之前**就已经设置，而 `oldTail.next = node` 在 CAS 成功**之后**才设置。这意味着从后向前遍历（通过 `prev`）总是安全的，但从前向后遍历（通过 `next`）在短暂窗口内可能看不到刚入队的节点。AQS 的取消节点逻辑正是利用了这个特性，总是通过 `prev` 遍历。

**步骤 3：`acquireQueued(node, arg)`**

节点入队后，在队列中等待获取锁：

```java
final boolean acquireQueued(final Node node, int arg) {
    boolean interrupted = false;
    try {
        for (;;) {
            final Node p = node.predecessor();  // 获取前驱节点
            
            // 关键：只有当自己是头节点的直接后继（即"队列第一个等待者"）时，才尝试获取锁
            if (p == head && tryAcquire(arg)) {
                // 获取成功：将自己设为新的哑头节点
                setHead(node);     // head = node; node.thread = null; node.prev = null
                p.next = null;     // 帮助 GC：断开旧头节点的 next 引用
                return interrupted;
            }
            
            // 检查是否应该 park（通过检查前驱的 waitStatus）
            if (shouldParkAfterFailedAcquire(p, node))
                interrupted |= parkAndCheckInterrupt();  // park 当前线程
        }
    } catch (Throwable t) {
        cancelAcquire(node);  // 异常时取消节点
        if (interrupted) selfInterrupt();
        throw t;
    }
}
```

**`shouldParkAfterFailedAcquire` 的逻辑**：

```java
private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;
    if (ws == Node.SIGNAL)
        return true;  // 前驱已设置 SIGNAL，安全 park
    if (ws > 0) {
        // 前驱已取消（CANCELLED），跳过所有取消的前驱，直到找到未取消的
        do {
            node.prev = pred = pred.prev;
        } while (pred.waitStatus > 0);
        pred.next = node;
    } else {
        // 将前驱的 waitStatus 设为 SIGNAL（表示"我需要被唤醒"）
        pred.compareAndSetWaitStatus(ws, Node.SIGNAL);
    }
    return false;  // 第一次设置 SIGNAL 后返回 false，让循环再次尝试 tryAcquire
}
```

这里有一个精妙的设计：`shouldParkAfterFailedAcquire` 在第一次调用时通常不直接 park，而是先把前驱的 `waitStatus` 设为 `SIGNAL`，然后返回 `false`，让外层循环再试一次 `tryAcquire`。这给了一次"临门一脚"的机会，避免了不必要的 park/unpark（park 代价虽然比 OS mutex 低，但仍然可观）。

### 3.2 release 的完整流程

```java
public final boolean release(int arg) {
    if (tryRelease(arg)) {          // 子类实现：释放（更新 state）
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);     // 唤醒头节点的第一个有效后继
        return true;
    }
    return false;
}

private void unparkSuccessor(Node node) {
    int ws = node.waitStatus;
    if (ws < 0)
        node.compareAndSetWaitStatus(ws, 0);  // 清除头节点的 SIGNAL 状态
    
    Node s = node.next;
    // 如果直接后继为 null 或已取消，从 tail 向前找第一个有效节点
    if (s == null || s.waitStatus > 0) {
        s = null;
        for (Node p = tail; p != node && p != null; p = p.prev)
            if (p.waitStatus <= 0)
                s = p;
    }
    if (s != null)
        LockSupport.unpark(s.thread);  // 唤醒找到的节点
}
```

为什么从 `tail` 向前遍历而不是从 `head.next` 向前？因为如上文分析，节点入队时先设 `prev`，后设 `next`——在短暂窗口内，`head.next` 可能看不到刚入队的节点，但 `tail.prev` 总是完整的。从 `tail` 向前是更安全的方式。

---

## 第 4 章 共享模式：acquireShared 与 releaseShared

### 4.1 共享模式的语义

独占模式：一次只有一个线程能持有（互斥锁）。共享模式：多个线程可以同时持有（信号量、读锁、倒计时门闩）。

AQS 用 `nextWaiter == Node.SHARED`（一个特殊的哨兵节点引用）来标记一个节点是共享模式。

### 4.2 acquireShared 的传播机制

共享模式的核心特性是**唤醒传播（Propagation）**：当一个等待的线程获取到共享锁后，如果还有"剩余资源"（例如信号量还有多个许可），它应该继续唤醒后面的等待线程，而不是只唤醒一个。

```java
public final void acquireShared(int arg) {
    if (tryAcquireShared(arg) < 0)     // 子类实现：返回值 < 0 表示获取失败
        doAcquireShared(arg);
}

private void doAcquireShared(int arg) {
    final Node node = addWaiter(Node.SHARED);  // 入队，标记为共享模式
    // ... park 等待，与独占模式类似 ...
    // 获取成功后：
    // setHeadAndPropagate(node, r);  // 设置新头节点，并向后传播唤醒
}

private void setHeadAndPropagate(Node node, int propagate) {
    Node h = head;
    setHead(node);  // 当前节点成为新头节点
    
    // 如果还有剩余资源（propagate > 0）或者头节点是 PROPAGATE 状态，继续唤醒后继
    if (propagate > 0 || h == null || h.waitStatus < 0 ||
        (h = head) == null || h.waitStatus < 0) {
        Node s = node.next;
        if (s == null || s.isShared())
            doReleaseShared();  // 唤醒下一个共享节点
    }
}
```

这个传播机制是 `CountDownLatch` 等"一次性开闸"类型同步器的基础——当计数归零时，所有等待线程被依次唤醒，每个被唤醒的线程再唤醒它的后继，形成级联唤醒。

---

## 第 5 章 ConditionObject——等待/通知机制

### 5.1 Condition 的设计

`Object.wait()`/`notify()` 是与 `synchronized` 绑定的等待通知机制。`java.util.concurrent.locks.Condition` 是一个更强大的替代品：

- 一个 `Lock` 可以创建**多个** `Condition`（`synchronized` 只有一个隐式的 WaitSet）
- `Condition` 支持**有时限的等待**（`awaitNanos`、`awaitUntil`）和**不响应中断的等待**（`awaitUninterruptibly`）
- `Condition.signal()` 只唤醒特定 Condition 上等待的线程，而不是该 lock 上的任意等待线程

`AQS.ConditionObject` 是 `Condition` 接口的内部实现类，每个 `ConditionObject` 维护一个**独立的等待队列**（不是 AQS 的同步队列，是一个单向链表）。

### 5.2 await() 的流程

```java
public final void await() throws InterruptedException {
    if (Thread.interrupted()) throw new InterruptedException();
    
    // 1. 将当前线程加入 Condition 等待队列（单向链表，节点 waitStatus = CONDITION）
    Node node = addConditionWaiter();
    
    // 2. 完全释放锁（即使是可重入的，也完全释放，state 变为 0）
    int savedState = fullyRelease(node);
    
    int interruptMode = 0;
    
    // 3. 等待：当节点从 Condition 队列转移到 AQS 同步队列后，才继续
    while (!isOnSyncQueue(node)) {
        LockSupport.park(this);  // 释放锁后 park，等待 signal
        if ((interruptMode = checkInterruptWhileWaiting(node)) != 0)
            break;
    }
    
    // 4. 重新竞争锁（节点已在 AQS 同步队列中，走正常的 acquireQueued 流程）
    if (acquireQueued(node, savedState) && interruptMode != THROW_IE)
        interruptMode = REINTERRUPT;
    
    // 5. 清理 Condition 队列中已取消的节点
    if (node.nextWaiter != null)
        unlinkCancelledWaiters();
    
    // 6. 处理中断
    if (interruptMode != 0)
        reportInterruptAfterWait(interruptMode);
}
```

关键点：`await()` 在 park 之前**完全释放锁**（包括所有重入层次），这样其他线程才能获取锁。等到被 `signal()` 唤醒后，需要重新竞争锁（`acquireQueued`），只有竞争成功才能继续执行。

### 5.3 signal() 的流程

```java
public final void signal() {
    // 调用 signal() 的线程必须是持有锁的线程
    if (!isHeldExclusively()) throw new IllegalMonitorStateException();
    
    Node first = firstWaiter;  // Condition 队列的第一个节点
    if (first != null)
        doSignal(first);
}

private void doSignal(Node first) {
    do {
        if ((firstWaiter = first.nextWaiter) == null)
            lastWaiter = null;
        first.nextWaiter = null;  // 从 Condition 队列中断开
    } while (!transferForSignal(first) && (first = firstWaiter) != null);
}

// 将节点从 Condition 队列转移到 AQS 同步队列
final boolean transferForSignal(Node node) {
    // 将节点 waitStatus 从 CONDITION 改为 0
    if (!node.compareAndSetWaitStatus(Node.CONDITION, 0))
        return false;  // 节点已取消，转移失败
    
    // 将节点加入 AQS 同步队列尾部（此时 await() 的 while 循环会退出）
    Node p = enq(node);
    int ws = p.waitStatus;
    // 将前驱节点设为 SIGNAL，确保 await() 线程能被正确唤醒
    if (ws > 0 || !p.compareAndSetWaitStatus(ws, Node.SIGNAL))
        LockSupport.unpark(node.thread);  // 前驱已取消，立即唤醒（让它自己重试）
    return true;
}
```

`signal()` 的核心是 **"将节点从 Condition 队列转移到 AQS 同步队列"**。转移后，`await()` 的 `isOnSyncQueue(node)` 检查返回 `true`，退出 while 循环，然后通过 `acquireQueued` 重新竞争锁。

---

## 第 6 章 AQS 的子类实现：模板方法

### 6.1 需要覆盖的方法

AQS 定义了 5 个需要子类实现的方法（如果不覆盖，默认抛出 `UnsupportedOperationException`）：

| 方法 | 模式 | 语义 |
| :--- | :--- | :--- |
| `tryAcquire(int arg)` | 独占 | 尝试获取，成功返回 true |
| `tryRelease(int arg)` | 独占 | 尝试释放，完全释放返回 true |
| `tryAcquireShared(int arg)` | 共享 | 尝试获取，≥0 表示成功（值表示剩余资源数）|
| `tryReleaseShared(int arg)` | 共享 | 尝试释放，true 表示释放后可能有等待线程需要唤醒 |
| `isHeldExclusively()` | 独占 | 当前线程是否独占持有 |

### 6.2 ReentrantLock 的实现示例

```java
// ReentrantLock.Sync（AQS 子类，简化版）
abstract static class Sync extends AbstractQueuedSynchronizer {

    // 释放：state 减少，归零时完全释放
    @ReservedStackAccess
    protected final boolean tryRelease(int releases) {
        int c = getState() - releases;
        if (Thread.currentThread() != getExclusiveOwnerThread())
            throw new IllegalMonitorStateException();
        boolean free = (c == 0);
        if (free)
            setExclusiveOwnerThread(null);  // 清除持有线程
        setState(c);
        return free;  // 只有完全释放（state = 0）才返回 true，触发后继唤醒
    }

    protected final boolean isHeldExclusively() {
        return getExclusiveOwnerThread() == Thread.currentThread();
    }
}

// 非公平锁：tryAcquire 不检查队列
static final class NonfairSync extends Sync {
    protected final boolean tryAcquire(int acquires) {
        return nonfairTryAcquire(acquires);  // 直接 CAS 抢，不管队列
    }
}

// 公平锁：tryAcquire 先检查队列是否有等待线程
static final class FairSync extends Sync {
    protected final boolean tryAcquire(int acquires) {
        final Thread current = Thread.currentThread();
        int c = getState();
        if (c == 0) {
            // hasQueuedPredecessors：队列中是否有其他线程在我之前等待
            if (!hasQueuedPredecessors() && compareAndSetState(0, acquires)) {
                setExclusiveOwnerThread(current);
                return true;
            }
        } else if (current == getExclusiveOwnerThread()) {
            int nextc = c + acquires;
            if (nextc < 0) throw new Error("Maximum lock count exceeded");
            setState(nextc);
            return true;
        }
        return false;
    }
}
```

### 6.3 Semaphore 的实现示例

```java
// Semaphore.Sync（共享模式）
abstract static class Sync extends AbstractQueuedSynchronizer {
    Sync(int permits) {
        setState(permits);  // state = 许可数
    }

    // 尝试获取 acquires 个许可
    final int nonfairTryAcquireShared(int acquires) {
        for (;;) {
            int available = getState();
            int remaining = available - acquires;
            if (remaining < 0 ||     // 不够了，返回负数（表示失败，进入等待队列）
                compareAndSetState(available, remaining))
                return remaining;    // 返回剩余许可数（>=0 表示成功）
        }
    }

    // 释放 releases 个许可
    protected final boolean tryReleaseShared(int releases) {
        for (;;) {
            int current = getState();
            int next = current + releases;
            if (next < current) throw new Error("Maximum permit count exceeded");
            if (compareAndSetState(current, next))
                return true;  // 释放后 state 增加，可能有等待线程需要唤醒
        }
    }
}
```

### 6.4 CountDownLatch 的实现示例

```java
// CountDownLatch.Sync（共享模式，特殊：只能从 N 倒数到 0，不能再增加）
private static final class Sync extends AbstractQueuedSynchronizer {
    Sync(int count) {
        setState(count);
    }

    // 获取：只有 state == 0 时才允许通过（倒计时归零后，所有等待线程都通过）
    protected int tryAcquireShared(int acquires) {
        return (getState() == 0) ? 1 : -1;
    }

    // 倒计时：state - 1，归零时返回 true（触发唤醒传播，所有等待线程被唤醒）
    protected boolean tryReleaseShared(int releases) {
        for (;;) {
            int c = getState();
            if (c == 0) return false;  // 已经归零，不需要再操作
            int nextc = c - 1;
            if (compareAndSetState(c, nextc))
                return nextc == 0;    // 刚好归零时返回 true，触发唤醒所有等待线程
        }
    }
}
```

---

## 第 7 章 AQS 的公平性保证

### 7.1 公平锁 vs 非公平锁的本质区别

AQS 的公平锁和非公平锁的区别只有一行代码：`hasQueuedPredecessors()`。

**非公平锁**：调用 `lock()` 时，直接 CAS 尝试抢锁，不管等待队列中是否有其他线程。如果 CAS 成功，"插队"到所有等待线程之前。

**公平锁**：调用 `lock()` 时，先检查等待队列是否有其他线程（`hasQueuedPredecessors()`），如果有，乖乖进入队列排队。只有等待队列为空（或自己就是队列头部的线程），才尝试 CAS 获取锁。

为什么非公平锁是默认选项且通常性能更好？

因为线程唤醒（`unpark`）到线程真正开始运行，中间有一段调度延迟（通常数微秒到数十微秒）。在这段时间里，如果有一个刚刚调用 `lock()` 的线程（不在等待队列里）直接 CAS 成功，就节省了"唤醒等待线程"和"等待线程真正运行"之间的空档期，提升了吞吐量。

代价是：等待队列中的线程可能被"插队"而延迟获取锁，在极端情况下可能造成**饥饿**（某个线程等了很久仍然没有获取到锁）。对于对延迟不敏感但对吞吐量要求高的场景，非公平锁更合适；对于需要严格公平的场景（如任务调度），公平锁更合适。

---

## 第 8 章 总结

AQS 是 JDK 并发包的核心基础设施，它的设计展示了"抽象的力量"：

**核心数据结构**：一个 `volatile int state` + 一个 CLH 变体双向链表（等待队列）。

**两种模式**：独占模式（`ReentrantLock`、写锁）和共享模式（`Semaphore`、`CountDownLatch`、读锁），通过重写 `try*` 方法实现不同语义。

**模板方法模式**：AQS 封装了所有线程 park/unpark、队列管理的复杂逻辑；子类只需实现"是否允许通过"的判断——这个分离让复杂的并发正确性只需在 AQS 中证明一次，所有子类都能复用。

**两个等待队列**：AQS 同步队列（竞争锁失败的线程）和 Condition 等待队列（调用了 `await()` 的线程）。`signal()` 将节点从后者转移到前者，`await()` 在前者竞争锁成功后才真正返回。

接下来的 [[JUC工具/07 ReentrantLock 深度剖析——公平锁、非公平锁与可中断]] 将基于本文的 AQS 知识，具体分析 `ReentrantLock` 的所有功能，以及它与 `synchronized` 的对比选型。

---

## 参考文献

1. Doug Lea, "The java.util.concurrent Synchronizer Framework", JACM 2004
2. AQS 源码：`java.util.concurrent.locks.AbstractQueuedSynchronizer`（OpenJDK）
3. Craig, Landin, Hagersten, "Building FIFO and Priority-Queuing Spin Locks from Atomic Swap", Technical Report, 1993
4. Goetz et al., "Java Concurrency in Practice", Appendix: Annotation Types
5. Shipilev, Aleksey, "JVM Anatomy Quarks: LockSupport", shipilev.net

---

> [!note] 思考题
> 1. AQS 使用一个 `volatile int state` 变量和一个 CLH 队列（双向链表）实现同步。`ReentrantLock` 用 state 表示重入次数，`Semaphore` 用 state 表示许可数，`CountDownLatch` 用 state 表示计数。如果你需要实现一个'同时最多允许 3 个线程进入，且支持重入'的自定义同步器，state 应该如何设计？
> 2. AQS 的 CLH 队列中，等待线程被 `LockSupport.park()` 阻塞。当释放锁时，AQS 唤醒队列中的下一个节点。但 `park/unpark` 有一个特性：如果 `unpark` 在 `park` 之前调用，后续的 `park` 会立即返回（许可制）。这个特性对 AQS 的实现有什么帮助？如果没有这个特性，AQS 需要做什么额外的同步？
> 3. AQS 的 `tryAcquire` 方法由子类实现（模板方法模式）。公平锁的 `tryAcquire` 会检查等待队列——如果有等待线程则不尝试 CAS。非公平锁直接 CAS 竞争。在高竞争场景下，非公平锁可能导致某些线程'饥饿'（长时间得不到锁）。但 Java 的非公平锁在实际中很少出现饥饿——为什么？
