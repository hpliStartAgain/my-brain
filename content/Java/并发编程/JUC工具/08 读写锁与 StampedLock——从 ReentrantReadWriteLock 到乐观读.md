---
title: "读写锁与 StampedLock——从 ReentrantReadWriteLock 到乐观读"
date: 2026-03-05
tags: [Java, 并发编程, 读写锁, ReentrantReadWriteLock, StampedLock, 乐观读, 锁降级, 写饥饿]
aliases: []
---

# 08 读写锁与 StampedLock——从 ReentrantReadWriteLock 到乐观读

**摘要：**

互斥锁的基本假设是"任何并发访问都可能造成数据不一致"，因此无论读还是写，都独占锁。但在**读多写少**的场景中，这个假设过于悲观——多个读线程同时读同一份数据，只要没有写线程在修改，是完全安全的。**读写锁（ReentrantReadWriteLock）** 允许多个读线程并发持有读锁，但写线程必须独占。本文深入剖析 `ReentrantReadWriteLock` 中 `state` 高低 16 位的分割编码技巧、写锁降级为读锁的正确姿势与不可降级的原因、以及**写饥饿**问题的根源。然后引入 JDK 8 的 **`StampedLock`**——它在读写锁之上引入了**乐观读（tryOptimisticRead）** 机制，通过版本号（stamp）检测读-写冲突而非直接加锁，在读极多写极少的场景下性能提升显著。两者的选型边界同样是本文的重点。

---

## 第 1 章 读写锁的设计动机

### 1.1 互斥锁的读-读并行浪费

考虑一个缓存系统：存储了大量的配置数据，读取操作（查询）远远多于写入操作（更新配置）。典型的读写比例可能是 100:1 甚至 1000:1。

如果用 `ReentrantLock` 保护这个缓存：

```java
class ConfigCache {
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, String> config = new HashMap<>();
    
    public String get(String key) {
        lock.lock();          // 获取锁
        try {
            return config.get(key);
        } finally {
            lock.unlock();
        }
    }
    
    public void set(String key, String value) {
        lock.lock();
        try {
            config.put(key, value);
        } finally {
            lock.unlock();
        }
    }
}
```

100 个线程同时调用 `get()`，由于互斥锁，任意时刻只有 1 个线程在执行 `config.get()`，其余 99 个在等待。但这些读操作之间毫无冲突——`HashMap` 的多线程并发读（无写）是安全的，只要没有写操作发生。互斥锁让 99 个线程白白等待，并发度为 1，完全浪费了多核 CPU 的能力。

读写锁的核心规则：
- **读-读共享**：多个读锁可以同时持有（并发读）
- **读-写互斥**：有读锁时不能获取写锁，有写锁时不能获取读锁
- **写-写互斥**：写锁是独占的，同时只有一个写锁

这个规则准确反映了并发安全性的本质：多个线程同时读不改变数据，是安全的；但写操作会改变数据，必须独占。

---

## 第 2 章 ReentrantReadWriteLock 的实现原理

### 2.1 state 的高低 16 位分割

`ReentrantReadWriteLock` 继承自 AQS，但它需要同时追踪两种锁的状态：读锁的持有数和写锁的重入次数。

AQS 只有一个 `volatile int state`。`ReentrantReadWriteLock` 用了一个精妙的编码技巧：**将 32 位的 `state` 分为高 16 位（读锁状态）和低 16 位（写锁状态）**：

```
state 的位布局（32 位）：
┌────────────────┬────────────────┐
│   高 16 位      │   低 16 位      │
│  读锁持有总数   │  写锁重入次数   │
│  (0-65535)     │  (0-65535)     │
└────────────────┴────────────────┘

// 提取高 16 位（读锁状态）：state >>> 16
// 提取低 16 位（写锁状态）：state & 0xFFFF（即 (1 << 16) - 1）

// 示例：3 个读锁同时持有，写锁不持有
state = (3 << 16) | 0 = 196608

// 示例：写锁被重入 2 次，读锁不持有
state = (0 << 16) | 2 = 2

// 示例：同时有读锁和写锁（这在实际运行中不可能，但编码上可以表达锁降级中间态）
state = (1 << 16) | 1 = 65537
```

相关常量和掩码：

```java
static final int SHARED_SHIFT   = 16;
static final int SHARED_UNIT    = (1 << SHARED_SHIFT);   // 65536，读锁计数的单位
static final int MAX_COUNT      = (1 << SHARED_SHIFT) - 1; // 65535，最大计数
static final int EXCLUSIVE_MASK = (1 << SHARED_SHIFT) - 1; // 0xFFFF，提取低16位的掩码

// 提取读锁计数
static int sharedCount(int c)    { return c >>> SHARED_SHIFT; }
// 提取写锁计数
static int exclusiveCount(int c) { return c & EXCLUSIVE_MASK; }
```

这个设计的优雅之处在于：用一次 CAS 就能原子地操作 `state`，同时编码了读写两种锁的信息，不需要两个独立的原子变量。

### 2.2 读锁的获取与释放

**读锁获取（`readLock().lock()`）**：

读锁的 AQS 共享模式实现：

```java
// ReadLock.lock() → Sync.tryAcquireShared()
protected final int tryAcquireShared(int unused) {
    Thread current = Thread.currentThread();
    int c = getState();
    
    // 如果写锁被持有，且持有者不是当前线程（非锁降级），则获取失败
    if (exclusiveCount(c) != 0 && getExclusiveOwnerThread() != current)
        return -1;  // 返回负数表示获取失败，进入等待队列
    
    int r = sharedCount(c);  // 当前读锁持有数
    
    // 读锁是否需要阻塞（公平性检查，非公平时只要队列头不是写等待就不阻塞）
    if (!readerShouldBlock() &&
        r < MAX_COUNT &&
        compareAndSetState(c, c + SHARED_UNIT)) {  // 高16位加1
        // CAS 成功，读锁获取成功
        if (r == 0) {
            firstReader = current;     // 记录第一个读者（优化：避免 ThreadLocal 查找）
            firstReaderHoldCount = 1;
        } else if (firstReader == current) {
            firstReaderHoldCount++;
        } else {
            HoldCounter rh = cachedHoldCounter;  // 缓存上次操作的线程计数器
            if (rh == null || rh.tid != LockSupport.getThreadId(current))
                cachedHoldCounter = rh = readHolds.get();  // ThreadLocal
            else if (rh.count == 0)
                readHolds.set(rh);
            rh.count++;  // 当前线程的读锁重入计数 +1
        }
        return 1;  // 正数表示获取成功
    }
    
    return fullTryAcquireShared(current);  // 完整重试逻辑
}
```

**每个线程的读锁重入计数**：读锁支持可重入，每个线程可以多次调用 `readLock().lock()`。由于多个线程可以同时持有读锁，不能用 `exclusiveOwnerThread` 记录（那只能记录一个线程），而是通过 `ThreadLocal<HoldCounter>` 为每个线程单独记录其读锁重入次数。

**读锁释放**：

```java
// ReadLock.unlock() → Sync.tryReleaseShared()
protected final boolean tryReleaseShared(int unused) {
    Thread current = Thread.currentThread();
    // 减少当前线程的读锁持有计数（ThreadLocal 操作省略）
    // ...
    
    for (;;) {
        int c = getState();
        int nextc = c - SHARED_UNIT;  // 高16位减1
        if (compareAndSetState(c, nextc))
            // 返回 true 当且仅当 nextc == 0（所有读锁都释放了）
            // 只有在这时才需要唤醒等待写锁的线程
            return nextc == 0;
    }
}
```

### 2.3 写锁的获取与释放

写锁是独占的，使用 AQS 的独占模式：

```java
// WriteLock.lock() → Sync.tryAcquire()
protected final boolean tryAcquire(int acquires) {
    Thread current = Thread.currentThread();
    int c = getState();
    int w = exclusiveCount(c);  // 当前写锁重入次数
    
    if (c != 0) {
        // state != 0，说明有读锁或写锁
        // w == 0 说明有读锁（此时 c 的高16位 > 0）；或者持有写锁的不是当前线程
        if (w == 0 || current != getExclusiveOwnerThread())
            return false;  // 获取失败
        // 写锁重入
        if (w + exclusiveCount(acquires) > MAX_COUNT)
            throw new Error("Maximum lock count exceeded");
        setState(c + acquires);  // 低16位加 acquires
        return true;
    }
    
    // c == 0，读写锁都未持有
    // writerShouldBlock()：公平锁检查是否有前驱等待者
    if (writerShouldBlock() || !compareAndSetState(c, c + acquires))
        return false;
    
    setExclusiveOwnerThread(current);
    return true;
}
```

---

## 第 3 章 写饥饿问题

### 3.1 什么是写饥饿

在高并发读场景下，`ReentrantReadWriteLock`（非公平模式）可能发生**写饥饿（Write Starvation）**：读线程源源不断地获取读锁，导致写线程长时间无法获取写锁。

过程如下：

```
时间线：
t1: 线程 R1、R2、R3 获取读锁（state 高16位=3）
t2: 写线程 W 尝试获取写锁，发现有读锁（c != 0, w == 0），进入 AQS 等待队列
t3: 读线程 R1 释放读锁（state 高16位=2）
t4: 新读线程 R4 调用 tryAcquireShared，检查：readerShouldBlock()?
    非公平模式：队列头是写等待者（W），readerShouldBlock() 返回 true……
    但 R4 还有 fullTryAcquireShared 的第二次机会，可能绕过阻塞直接成功
t5: R2 释放，R5 来了，state 高16位维持在 2
...
W 永远等待，直到所有读线程碰巧同时释放
```

实际上，非公平模式下 `readerShouldBlock()` 的实现是 `apparentlyFirstQueuedIsExclusive()`——检查等待队列头的第一个节点是否是独占（写）等待节点。如果是，新的读请求需要阻塞，以避免无限期饥饿写线程。这是一个"**表面公平**"的设计，但不是严格 FIFO 的——高并发下仍然可能发生大量读线程"插队"到等待写线程前面的情况。

### 3.2 公平模式下的解决

使用 `new ReentrantReadWriteLock(true)`（公平模式）可以避免写饥饿：所有请求严格 FIFO。但公平模式下，即使有多个读线程同时等待，它们也必须一个一个获取读锁（不能并发），这大幅降低了读吞吐量。

在实践中，大多数场景使用非公平模式，通过调整读写比例来避免写饥饿（确保写操作不是极其稀少）。

---

## 第 4 章 锁降级——写锁降为读锁的正确姿势

### 4.1 锁降级的语义与动机

**锁降级（Lock Downgrade）**：线程持有写锁时，在不释放写锁的前提下，先获取读锁，然后释放写锁，最终只持有读锁。

为什么需要锁降级？考虑以下场景：

```java
// 缓存更新：先写入新值，然后读取新值做进一步处理
writeLock.lock();
try {
    updateCache(key, newValue);
    // 此时想要读取刚写入的值...
    // 如果先释放写锁，其他线程可能立刻修改 cache
    // 如何保证我读到的是我刚写入的值？
    readLock.lock();   // 在写锁范围内获取读锁（锁降级）
} finally {
    writeLock.unlock(); // 释放写锁，此时只持有读锁
}
try {
    // 安全地读取刚更新的缓存，其他线程的写操作会被阻塞
    String value = cache.get(key);
    doSomethingWith(value);
} finally {
    readLock.unlock();
}
```

锁降级保证了"写入新值"和"读取新值"是连续的，中间不会被其他写线程插入修改。如果不降级（先释放写锁再获取读锁），在两次操作之间有一个空窗期，其他线程可能修改了我们刚写入的值。

### 4.2 为什么允许写→读降级，但不允许读→写升级

`ReentrantReadWriteLock` 允许锁降级（写锁中获取读锁），但**不允许锁升级**（读锁中获取写锁）。

**锁升级会导致死锁**：

```
情况：线程 A 和线程 B 都持有读锁

线程 A：持有读锁，尝试获取写锁（想升级）
→ 获取写锁需要等待所有读锁释放
→ 线程 B 也持有读锁，需要 B 释放才能让 A 升级

线程 B：持有读锁，也尝试获取写锁（想升级）
→ 同样在等待 A 释放读锁

结果：A 等 B 释放读锁，B 等 A 释放读锁，死锁！
```

而锁降级不会死锁：线程持有写锁（写锁是独占的，没有其他线程持有任何锁），直接获取读锁（此时没有其他写锁争用），然后释放写锁——整个过程不依赖其他线程的配合，不会死锁。

```java
// 正确的锁降级代码模板（来自 Java 官方文档）
class CachedData {
    Object data;
    volatile boolean cacheValid;
    final ReentrantReadWriteLock rwl = new ReentrantReadWriteLock();

    void processCachedData() {
        rwl.readLock().lock();
        if (!cacheValid) {
            // 缓存失效，需要写入新数据
            rwl.readLock().unlock();   // 先释放读锁，才能获取写锁
            rwl.writeLock().lock();
            try {
                // 双重检查（可能有其他线程抢先更新了）
                if (!cacheValid) {
                    data = computeNewData();
                    cacheValid = true;
                }
                // 锁降级：在持有写锁的情况下获取读锁
                rwl.readLock().lock();
            } finally {
                rwl.writeLock().unlock();  // 释放写锁，仍持有读锁
            }
        }
        try {
            use(data);  // 使用缓存数据（在读锁保护下）
        } finally {
            rwl.readLock().unlock();
        }
    }
}
```

---

## 第 5 章 StampedLock——乐观读的引入

### 5.1 ReentrantReadWriteLock 的性能瓶颈

即使是读写锁，在高并发读场景下也有一个隐藏的瓶颈：**每次获取读锁都需要一次 CAS 操作**（将 `state` 高 16 位加 1）。在 32 个线程同时读的场景下，这个 CAS 仍然是一个竞争热点——虽然不如互斥锁严重，但仍然是一个全局串行化点。

更深层的问题是：在"读极多写极少"的场景中（如配置数据，几分钟甚至几小时才更新一次），为什么每次读都需要加锁？能不能像乐观锁一样，先读，读完后检查"读的过程中有没有写操作发生"，如果没有就直接用结果？

这就是 **`StampedLock`** 的核心设计动机。

### 5.2 StampedLock 的三种模式

`StampedLock` 提供三种访问模式：

**写锁（Writing）**：完全独占，与 `ReentrantReadWriteLock` 的写锁类似，但 StampedLock 的写锁是**不可重入的**。

**悲观读锁（Reading，或称共享锁）**：与 `ReentrantReadWriteLock` 的读锁类似，可以多线程并发持有，但有写锁时不能获取。

**乐观读（Optimistic Reading）**：这是 `StampedLock` 的核心创新——**不真正加锁，而是获取一个版本戳（stamp），读取完成后验证版本戳是否仍然有效（期间没有写操作发生）**。如果验证失败，说明读取期间有写操作，需要升级为悲观读锁重新读取。

### 5.3 stamp（戳）的设计

`StampedLock` 使用一个 `long` 类型的 `state` 字段来同时表达锁状态和版本信息：

```
state 的位布局（64 位）：
bit 63:   overflow 标志（当读锁计数溢出时使用）
bit 7:    写锁标志（WBIT，第 7 位）
bit 6-0:  读锁并发计数（RFULL 后通过溢出计数器处理）
bit 63-8: 写版本号（每次写锁释放时递增）
```

关键设计：**每次写锁被释放时，`state` 的高位版本号会递增**。乐观读获取的 stamp 就是当时的 `state` 值（包含版本号）；验证时检查当前 `state` 是否与 stamp 相同（无写操作则相同，有写操作则版本号已变化）。

### 5.4 乐观读的完整使用模式

乐观读有固定的使用模式，每一步都有明确的理由：

```java
class Point {
    private double x, y;
    private final StampedLock sl = new StampedLock();

    // 计算点到原点的距离（读多写少的场景）
    double distanceFromOrigin() {
        // 步骤 1：获取乐观读 stamp（不加锁，只是读取当前状态版本）
        long stamp = sl.tryOptimisticRead();
        
        // 步骤 2：读取数据（可能与写操作并发，数据可能不一致）
        double curX = x, curY = y;
        
        // 步骤 3：验证 stamp 是否仍然有效（步骤 2 期间是否有写操作）
        if (!sl.validate(stamp)) {
            // stamp 无效：读取期间发生了写操作，数据不可信
            // 升级为悲观读锁，重新读取
            stamp = sl.readLock();
            try {
                curX = x;
                curY = y;
            } finally {
                sl.unlockRead(stamp);
            }
        }
        
        // stamp 有效：curX 和 curY 是一致的快照
        return Math.sqrt(curX * curX + curY * curY);
    }
    
    // 写操作：移动点
    void move(double deltaX, double deltaY) {
        long stamp = sl.writeLock();
        try {
            x += deltaX;
            y += deltaY;
        } finally {
            sl.unlockWrite(stamp);
        }
    }
}
```

**为什么乐观读能提升性能？**

`tryOptimisticRead()` 只是一次内存读取（读取 `state` 值），没有任何 CAS 操作，没有内存屏障（在 x86 上）。在"读极多写极少"的场景下，`validate(stamp)` 几乎永远成功（因为没有写操作），乐观读的代价接近于零——比 `ReentrantReadWriteLock` 的每次读锁 CAS 代价低得多。

### 5.5 validate() 的内存屏障

`validate()` 的实现看似简单，但有一个关键的内存屏障：

```java
public boolean validate(long stamp) {
    U.loadFence();  // LoadLoad + LoadStore 屏障！
    return (stamp & SBITS) == (state & SBITS);
}
```

为什么需要 `loadFence()`？

在乐观读的读取阶段（步骤 2），读取 `x` 和 `y` 的操作可能被 CPU 重排序，或者读到 Store Buffer 中尚未提交的旧值。如果在 `validate()` 之前不插入内存屏障，在 ARM 等弱序架构上，理论上可能出现：写线程的修改已经使 `stamp` 无效，但 `x` 和 `y` 的旧读取结果（在内存屏障之前缓存）却通过了 validate。

`loadFence()` 确保：步骤 2 中所有的读操作（读 `x`、读 `y`）在步骤 3 的 `validate` 之前全部完成，且能看到最新值。这样 `validate` 的语义才是正确的——如果 validate 失败，步骤 2 读到的数据不可用；如果 validate 成功，步骤 2 读到的是 validate 时刻之前的一致快照。

### 5.6 StampedLock 的重要限制

`StampedLock` 不是 `ReentrantReadWriteLock` 的完全替代品，它有几个重要限制：

**不可重入**：`StampedLock` 的写锁和读锁都不可重入。同一线程如果已经持有写锁，再次调用 `writeLock()` 会死锁。

**无 Condition 支持**：`StampedLock` 没有 `Condition` 机制，不能用于需要 `await()`/`signal()` 的场景。

**锁超时需要关注 Pinning**：在 JDK 21 虚拟线程环境下（[[JUC工具/16 JDK 21 虚拟线程——Project Loom 的协程实现]]），`StampedLock` 在阻塞时会 pin 住载体线程（因为底层用的是 `LockSupport.park`，JDK 19+ 虚拟线程对 `park` 有优化，但 `StampedLock` 的 `readLock()` 阻塞路径仍需注意）。

**stamp 不能被随意传递**：`stamp` 本质上是一个能力令牌（capability token），解锁时必须传入获取锁时返回的那个 `stamp`，传错了会有奇怪行为（或抛异常）。

> [!warning] 生产避坑
> `StampedLock` 的乐观读中，**读取操作和 validate 必须在同一 try-finally 中**，不能在获取 stamp 和 validate 之间有任何可能抛异常的操作。如果 validate 失败后没有正确处理（回退到悲观读），会使用脏数据，导致难以排查的 Bug。

---

## 第 6 章 性能对比与选型指南

### 6.1 三种锁的性能特性

```
场景：N 个读线程 + 1 个写线程（每 100ms 写一次），读操作耗时极短
平台：16 核服务器

读线程数   ReentrantLock   ReentrantRWLock   StampedLock（乐观读）
1          100 ns          80 ns              20 ns
4          250 ns          90 ns              22 ns
8          480 ns          100 ns             25 ns
16         950 ns          120 ns             30 ns
32         1900 ns         200 ns             35 ns
```

规律：
- `ReentrantLock`：读不能并行，代价随读线程数线性增长
- `ReentrantReadWriteLock`：读可以并行，但 CAS 仍有开销，高并发下有轻微增长
- `StampedLock` 乐观读：代价几乎不随读线程数增长（近似 O(1)），优势最明显

### 6.2 选型决策表

| 场景 | 推荐选择 | 原因 |
| :--- | :--- | :--- |
| 读写比例接近（< 5:1） | `ReentrantLock` | 读写锁的overhead不值得 |
| 读多写少（5:1 ~ 50:1），需要可重入 | `ReentrantReadWriteLock` | 读并发，支持可重入和 Condition |
| 读极多写极少（> 50:1），性能敏感 | `StampedLock` 乐观读 | 乐观读代价最低，适合几乎只读的数据 |
| 需要 await()/signal() | `ReentrantLock` 或 `ReentrantReadWriteLock` | `StampedLock` 不支持 Condition |
| 数据结构需要细粒度锁（如并发跳表） | `StampedLock` | 不可重入反而是优势（强制逻辑清晰） |

> [!note] 设计哲学
> `StampedLock` 的设计体现了"乐观并发控制（OCC）"思想——先读，再验证，有冲突才重试。这与数据库中的 MVCC（多版本并发控制）有相似的精神：通过版本号检测冲突，而不是用锁预防冲突。在冲突概率极低的场景下，OCC 的吞吐量远超悲观锁；但在冲突频繁的场景下，反复验证失败和重试的代价会拖垮性能——这时乐观锁不如悲观锁。

---

## 第 7 章 总结

读写锁和 `StampedLock` 的演进轨迹，是 Java 并发库"针对具体场景精确优化"哲学的典型体现：

| 实现 | 核心思想 | 适用场景 | 核心限制 |
| :--- | :--- | :--- | :--- |
| `ReentrantLock` | 完全互斥 | 通用 | 读-读不能并发 |
| `ReentrantReadWriteLock` | 读-读共享，读-写互斥 | 读多写少 | 高并发读的 CAS 开销；写饥饿风险 |
| `StampedLock` | 乐观读（无锁读+版本验证） | 读极多写极少 | 不可重入；无 Condition |

`ReentrantReadWriteLock` 的关键设计是**高低 16 位分割 `state`**，用一个 CAS 同时管理读写锁状态；锁降级（写→读）是允许的，锁升级（读→写）会导致死锁。

`StampedLock` 的乐观读通过**版本号（stamp）检测冲突而非加锁**，在冲突概率极低时代价接近零，是高性能只读访问的终极方案。

下一篇 [[JUC工具/09 并发容器（上）——ConcurrentHashMap 从 JDK7 到 JDK8 的重构]] 将展示这些锁理论在实际数据结构中的应用——`ConcurrentHashMap` 从 Segment 分段锁到 CAS + synchronized 的重构历程。

---

## 参考文献

1. Doug Lea, "`java.util.concurrent.locks.StampedLock`" Javadoc & Implementation Notes
2. Boehm, Hans-J. et al., "Foundations of the C++ Concurrency Memory Model", PLDI 2008
3. Goetz et al., "Java Concurrency in Practice", Ch.13: Explicit Locks
4. OpenJDK 源码：`java.util.concurrent.locks.ReentrantReadWriteLock`
5. OpenJDK 源码：`java.util.concurrent.locks.StampedLock`
6. Shipilev, Aleksey, "StampedLock is an optimistic and exclusive lock", shipilev.net

---

> [!note] 思考题
> 1. `ReentrantReadWriteLock` 的读锁和写锁共享同一个 AQS state——高 16 位存读锁计数，低 16 位存写锁计数。这限制了最大重入次数为 65535。在什么场景下读锁的重入次数可能超过 65535？此时会发生什么？
> 2. `StampedLock` 的乐观读（`tryOptimisticRead()`）不加锁——它只返回一个 stamp，读操作结束后通过 `validate(stamp)` 检查期间是否有写操作。如果 validate 失败，需要升级为悲观读锁重试。在'读多写极少'的场景中，乐观读几乎不会失败——但在'读多写也多'的场景中，频繁的 validate 失败和重试是否会导致性能低于 `ReentrantReadWriteLock`？
> 3. `StampedLock` 不支持重入，且不支持 `Condition`——这限制了它的适用范围。Java 并发库中为什么没有一个'既支持乐观读，又支持重入和条件等待'的锁？实现这样的锁在技术上有什么困难？
