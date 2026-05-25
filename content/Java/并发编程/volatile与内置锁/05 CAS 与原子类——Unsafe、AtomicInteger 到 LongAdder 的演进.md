---
title: "CAS 与原子类——Unsafe、AtomicInteger 到 LongAdder 的演进"
date: 2026-03-05
tags: [ABA问题, AtomicInteger, AtomicLong, CAS, Contended, Java, LongAdder, Unsafe, 伪共享, 并发编程]
aliases: []
---

# 05 CAS 与原子类——Unsafe、AtomicInteger 到 LongAdder 的演进

**摘要：**

锁是并发控制的悲观策略——假设冲突一定会发生，先加锁再操作。**CAS（Compare-And-Swap，比较并交换）** 是乐观策略——假设冲突是少数，先操作再验证，失败了就重试。CAS 是现代并发体系的基石：`synchronized` 的轻量级锁、AQS 的状态更新、`ConcurrentHashMap` 的桶级别操作，都依赖 CAS。本文从 CPU 指令层面剖析 CAS 的工作原理，深入分析 JDK 的 `Unsafe` 类如何将硬件 CAS 暴露给 Java，揭示 **ABA 问题**的根源与解决方案，再追踪 JDK 原子类从 `AtomicInteger` 到 `LongAdder` 的演进历程——这一演进揭示了一个深刻的工程哲学：**当"所有线程共享一个变量"变成性能瓶颈时，"让每个线程拥有自己的计数器"往往是突破口**。

---

## 第 1 章 CAS 的硬件基础

### 1.1 为什么需要 CAS

在 [[volatile与内置锁/03 volatile 的实现原理——内存屏障与禁止重排序]] 中我们看到，`volatile` 保证了单次读写的可见性，但不保证"读-改-写"的原子性。对于 `i++` 这类需要原子性的复合操作，我们需要额外的机制。

悲观的方案是 `synchronized`：加锁 → 读 → 改 → 写 → 解锁，任何时刻只有一个线程能操作。代价是：其他线程必须阻塞等待，涉及操作系统调度，代价高昂。

乐观的方案是 CAS：先读旧值 → 计算新值 → 用 CAS 原子地检查"内存中的值是否仍然等于旧值，如果是则更新为新值"。如果检查失败（说明有其他线程在我读旧值之后修改了它），就重新读取并重试。

CAS 的核心语义可以用伪代码表达：

```
function CAS(memory_address, expected_value, new_value):
    // 以下是原子操作，不可被打断
    current = *memory_address
    if current == expected_value:
        *memory_address = new_value
        return true   // 成功
    else:
        return false  // 失败，内存值已被其他线程修改
```

"原子地"完成"比较+交换"是 CAS 的关键——这需要硬件支持。

### 1.2 x86 上的 CMPXCHG 指令

在 x86 架构上，CAS 对应 **`CMPXCHG`** 指令（Compare and Exchange）。

```asm
; 语义：如果 [dst] == EAX，则 [dst] = src，并设置 ZF=1；否则 EAX = [dst]，ZF=0
CMPXCHG [dst], src
```

在多核环境下，`CMPXCHG` 本身不是原子的——总线上可能有其他核心同时读写同一内存地址。为了保证原子性，需要加上 **`LOCK` 前缀**：

```asm
; LOCK 前缀使 CMPXCHG 成为一个原子操作
LOCK CMPXCHG [dst], src
```

`LOCK` 前缀的语义是：在执行该指令期间，锁定内存总线（或使用缓存锁定，Cache Lock，在现代 CPU 上更常见——只锁定包含目标地址的缓存行，不锁整条总线），保证整个"比较+交换"序列不会被其他 CPU 的内存操作打断。

`LOCK CMPXCHG` 的代价：在无竞争情况下，约 5-20 个 CPU 周期；在有竞争时，可能更高（需要等待缓存行的独占权）。这比操作系统互斥锁的代价（数千个周期）低得多。

### 1.3 ARM 上的 LDREX/STREX

ARM 架构采用了不同的实现方式——**Load-Linked / Store-Conditional（LL/SC）** 机制：

```asm
retry:
    LDREX R0, [addr]    ; 加载 addr 的值到 R0，并在该地址上设置"独占监视器"
    CMP   R0, expected  ; 比较当前值与期望值
    BNE   fail          ; 不相等则失败
    STREX R1, new, [addr] ; 条件存储：如果"独占监视器"仍然有效，写入新值并清除监视器
    CMP   R1, #0        ; 检查存储是否成功
    BNE   retry         ; 失败则重试
    ; 成功
fail:
    ; 失败处理
```

`LDREX`（Load Exclusive）在读取时设置一个"独占监视器"，`STREX`（Store Exclusive）只有在独占监视器未被清除的情况下才成功写入。如果在 `LDREX` 和 `STREX` 之间有其他核心访问了同一内存地址（触发缓存一致性协议），独占监视器会被清除，`STREX` 失败，需要重试。

LL/SC 相比 `LOCK CMPXCHG` 有一个优势：它天然解决了 ABA 问题（后文详述）——如果在 LL 和 SC 之间内存地址的值被改过然后改回来，独占监视器仍然会被清除，SC 会失败。

---

## 第 2 章 Java 中的 CAS：Unsafe 类

### 2.1 Unsafe 类的定位

`sun.misc.Unsafe`（JDK 9+ 迁移至 `jdk.internal.misc.Unsafe`）是 JDK 中最危险也最强大的类。它提供了 Java 层面的直接内存访问、对象字段偏移量操作，以及**原子 CAS 操作**。

它叫 "Unsafe" 的原因是：它绕过了 Java 的安全检查，错误使用可能导致 JVM 崩溃、内存破坏等严重后果。因此 `Unsafe` 不是公开 API，只允许 JDK 内部类（BootClassLoader 加载的类）使用，普通代码只能通过反射获取它的实例。

```java
// 获取 Unsafe 实例（JDK 内部类的方式）
private static final Unsafe U = Unsafe.getUnsafe();

// 普通代码通过反射获取（不推荐在生产代码中使用）
Field f = Unsafe.class.getDeclaredField("theUnsafe");
f.setAccessible(true);
Unsafe unsafe = (Unsafe) f.get(null);
```

### 2.2 Unsafe 的核心 CAS 方法

`Unsafe` 提供了三个基本的 CAS 方法：

```java
// 对象字段的 CAS（o: 目标对象, offset: 字段偏移量, expected: 期望值, x: 新值）
public native boolean compareAndSetInt(Object o, long offset, int expected, int x);
public native boolean compareAndSetLong(Object o, long offset, long expected, long x);
public native boolean compareAndSetReference(Object o, long offset, Object expected, Object x);
```

这些方法最终调用到 JVM 的 C++ 代码，在 x86 上生成 `LOCK CMPXCHG` 指令，在 ARM 上生成 `LDREX/STREX` 序列。

**字段偏移量（offset）** 是什么？每个对象的字段在内存中的位置是相对于对象起始地址的偏移。`Unsafe.objectFieldOffset(Field f)` 可以获取一个字段的偏移量。有了对象引用和字段偏移量，就能直接计算出字段在内存中的绝对地址，从而实现 CAS。

```java
// AtomicInteger 内部的静态字段偏移量初始化
private static final long VALUE_OFFSET;
static {
    try {
        VALUE_OFFSET = U.objectFieldOffset(AtomicInteger.class.getDeclaredField("value"));
    } catch (Exception e) {
        throw new Error(e);
    }
}
```

---

## 第 3 章 AtomicInteger——基于 CAS 的整数原子类

### 3.1 AtomicInteger 的内部结构

`AtomicInteger` 是 JDK 中最基础的原子类。它的实现非常简洁，核心就是一个 `volatile int value` 字段和对 `Unsafe.compareAndSetInt` 的封装：

```java
public class AtomicInteger extends Number implements java.io.Serializable {
    private static final Unsafe U = Unsafe.getUnsafe();
    // 获取 value 字段相对于 AtomicInteger 对象起始地址的偏移量
    private static final long VALUE_OFFSET =
        U.objectFieldOffset(AtomicInteger.class, "value");

    // 实际存储值，必须是 volatile（保证每次 CAS 读到最新值）
    private volatile int value;

    public final int incrementAndGet() {
        return U.getAndAddInt(this, VALUE_OFFSET, 1) + 1;
    }
}
```

`Unsafe.getAndAddInt` 的实现（Java 层面的参考实现，实际可能由 JIT 内联为单条指令）：

```java
// Unsafe.getAndAddInt 的参考实现
public final int getAndAddInt(Object o, long offset, int delta) {
    int v;
    do {
        v = getIntVolatile(o, offset);   // volatile 读，获取当前值
    } while (!compareAndSetInt(o, offset, v, v + delta));  // CAS 尝试更新
    return v;  // 返回旧值
}
```

这个 CAS 重试循环（**CAS + 自旋**）是乐观锁的标准模式：

1. 读取当前值 `v`
2. 计算期望的新值 `v + delta`
3. 用 CAS 尝试将内存中的值从 `v` 更新为 `v + delta`
4. 如果 CAS 失败（有其他线程抢先更新了值），重新读取当前值，重试

在无竞争或低竞争场景下，CAS 通常一次成功，总代价只有一次 `LOCK CMPXCHG`，比 `synchronized` 低得多。

### 3.2 value 必须是 volatile 的原因

`AtomicInteger.value` 必须是 `volatile` 的，原因是：CAS 操作本身（`LOCK CMPXCHG`）只保证了"原子地比较并更新"，但不保证读取到的旧值是最新值（在 Store Buffer 还未提交时，可能读到缓存中的旧值）。

`volatile` 的读语义（读后的 LoadLoad 屏障）确保了每次读取 `value` 时，都能看到其他线程最新写入的值，避免了"读到旧值 → CAS 误成功"的问题。

### 3.3 AtomicInteger 的高竞争困境

在低竞争场景下，`AtomicInteger` 性能优秀。但在高并发下（如 32 个线程同时对同一个 `AtomicInteger` 做 `incrementAndGet()`），会发生：

1. 所有线程读到相同的旧值 `v`
2. 同时尝试 CAS
3. 只有一个线程 CAS 成功
4. 其他 31 个线程 CAS 失败，需要重新读取并重试

这种情况下，大量线程在循环重试，产生大量的 `LOCK CMPXCHG` 指令和缓存行争用——因为所有线程都在争用同一个缓存行（包含 `value` 字段的那个），MESI 协议会产生大量的失效流量。

竞争越激烈，CAS 失败率越高，重试次数越多，性能越差——这是 `AtomicInteger` 在极高并发下的根本限制。

---

## 第 4 章 ABA 问题——CAS 的隐患

### 4.1 ABA 问题的描述

CAS 的检查条件是"内存中的值是否等于期望值"。但"值相等"不等于"值没有被修改过"——如果另一个线程将值从 A 改为 B，再改回 A，CAS 会认为值没有被修改，但实际上中间发生了两次变化。这就是 **ABA 问题**。

一个经典的 ABA 场景（用无锁栈举例）：

```
初始状态：栈顶 → A → B → C

线程 1（慢）：
  1. 读取栈顶 = A，期望将栈顶从 A 改为 A.next（即 B）
  2. 线程 1 被挂起

线程 2（快）：
  3. 弹出 A（栈变为：B → C）
  4. 弹出 B（栈变为：C）
  5. 压入 A（栈变为：A → C，但 A.next 现在指向 C，不是 B！）

线程 1 恢复：
  6. 执行 CAS：内存中的栈顶仍然是 A，与期望值 A 相等，CAS 成功
  7. 将栈顶改为 A.next（即 B，但 B 可能已经被释放！）
  8. 栈被破坏，B 已经是游离节点，可能造成内存问题
```

线程 1 的 CAS 成功了，但此时的 A 已经不是原来的 A——它的后继节点已经变了。这种"值相同但状态已变"的场景就是 ABA 问题。

### 4.2 ABA 问题在 Java 中的影响

不是所有 CAS 场景都会受到 ABA 问题影响：

- **计数器**（`AtomicInteger.incrementAndGet()`）：不受 ABA 影响。即使值从 5 变成 6 再变回 5，"将 5 加 1 变成 6"这个操作本身是正确的——我们只关心"每次正确加 1"，不关心值的历史。
- **引用操作**（`AtomicReference`）：可能受 ABA 影响。如果一个对象引用从 A 变成 B 再变回 A，但 A 内部状态已经不同了（如 A 是一个被重用的节点），CAS 误判为"没有变化"可能造成数据结构破坏。

### 4.3 AtomicStampedReference——版本号解决 ABA

JDK 提供了 **`AtomicStampedReference`** 来解决 ABA 问题，原理是在值之外附加一个**版本号（Stamp）**：CAS 时同时检查值和版本号，每次修改版本号递增，即使值回到 A，版本号也已经不同，CAS 会失败。

```java
// 初始值 A，初始版本号 0
AtomicStampedReference<String> ref = new AtomicStampedReference<>("A", 0);

// 线程 1
int[] stampHolder = new int[1];
String val = ref.get(stampHolder);   // val = "A", stampHolder[0] = 0
// 线程 1 被挂起...

// 线程 2：A → B → A，版本号从 0 → 1 → 2
ref.compareAndSet("A", "B", 0, 1);
ref.compareAndSet("B", "A", 1, 2);

// 线程 1 恢复：用版本号 0 去做 CAS，失败（当前版本号是 2）
boolean success = ref.compareAndSet("A", "B", stampHolder[0], stampHolder[0] + 1);
// success = false！ABA 问题被检测到
```

`AtomicStampedReference` 的代价是：每次 CAS 需要同时更新引用和版本号，这无法用单条 `CMPXCHG` 指令完成（64 位 JVM 上引用 8 字节，版本号 4 字节，合计 12 字节，超过单条 CAS 的操作宽度）。HotSpot 的实现是将引用和版本号打包成一个内部的 `Pair` 对象，对 `Pair` 对象的引用做 CAS——但这引入了额外的对象分配开销。

另外，`AtomicMarkableReference` 只附加一个布尔标记（而不是整数版本号），适用于只需要"标记已删除"而不需要完整版本追踪的场景。

---

## 第 5 章 LongAdder——分段思想的胜利

### 5.1 为什么 AtomicLong 不够用

对于高并发计数场景（如统计 QPS、记录访问次数），`AtomicLong` 在低竞争下已经足够好，但在高并发下（数十个线程同时 `incrementAndGet()`），CAS 失败重试率高，性能急剧下降。

根本原因是：所有线程都在争用**同一个** `long` 变量，这个变量所在的缓存行成为全局热点——每次成功的 CAS 都会使其他所有核心的副本失效（MESI 失效），这些核心再次 CAS 时必须重新加载，又引发新一轮失效……

这是一个**竞争-失效-重试**的恶性循环，竞争程度越高，恶性程度越深。

### 5.2 LongAdder 的核心思想：化整为零

**`LongAdder`** 于 JDK 8 引入，由 Doug Lea 设计。它的核心思想极为简洁：**不让所有线程争用同一个值，而是给每个线程分配自己的计数器（Cell），最终求和时再合并**。

```
单变量模式（AtomicLong）：
  Thread 1 ──┐
  Thread 2 ──┤──→ [Long value: 0] ← 所有线程争用同一个缓存行
  Thread 3 ──┤
  Thread 4 ──┘

分段模式（LongAdder）：
  Thread 1 ──→ [Cell 0: 3]
  Thread 2 ──→ [Cell 1: 5]  ← 不同线程操作不同缓存行，无竞争
  Thread 3 ──→ [Cell 2: 7]
  Thread 4 ──→ [Cell 3: 2]
  
  sum() = base + Cell 0 + Cell 1 + Cell 2 + Cell 3 = 17 + 0 = 17
```

每个线程优先操作自己对应的 `Cell`，不同 `Cell` 位于不同缓存行，互不干扰；只有在获取最终值（调用 `sum()`）时，才将 `base` 和所有 `Cell` 的值累加。

**这个设计的代价**：`sum()` 不是原子的——在调用 `sum()` 的过程中，其他线程可能正在修改某些 `Cell`，因此 `LongAdder.sum()` 只提供**最终一致性**（eventual consistency），不是精确的原子快照。对于只需要大致准确的统计场景（如 QPS 监控、访问量统计），这个权衡完全可以接受。

### 5.3 LongAdder 的内部结构

`LongAdder` 继承自 `Striped64`（分段累加器的抽象基类）：

```java
// Striped64 的核心字段（简化）
abstract class Striped64 extends Number {
    // 基础值：无竞争时直接更新 base；有竞争时 Cell 数组分摊
    transient volatile long base;
    
    // 分段 Cell 数组：大小是 2 的幂次方，最大为 CPU 核心数的两倍
    transient volatile Cell[] cells;
    
    // 创建/扩容 cells 数组时的锁（仅用于 cells 数组结构的修改）
    transient volatile int cellsBusy;
}
```

**`Cell` 类**（`@Contended` 注解防止伪共享）：

```java
@sun.misc.Contended  // 让每个 Cell 独占一个缓存行（前后各填充 128 字节）
static final class Cell {
    volatile long value;    // 该 Cell 的计数值
    
    // CAS 更新 Cell 的值
    final boolean cas(long cmp, long val) {
        return VALUE.compareAndSet(this, cmp, val);
    }
    
    private static final VarHandle VALUE;
    static {
        VALUE = MethodHandles.lookup().findVarHandle(Cell.class, "value", long.class);
    }
}
```

`@Contended` 注解是防止伪共享的关键——没有这个注解，多个 `Cell` 可能位于同一个缓存行，Core 0 更新 `Cell[0]` 会导致 Core 1 的 `Cell[1]` 也被失效，相邻 `Cell` 之间仍然存在伪共享问题，LongAdder 的性能优势大打折扣。

### 5.4 LongAdder 的 add() 流程

```java
// LongAdder.add() 的简化逻辑
public void add(long x) {
    Cell[] cs; long b, v; int m; Cell c;
    
    // 快速路径：cells 数组为空时，直接 CAS 更新 base
    if ((cs = cells) == null && casBase(b = base, b + x))
        return;  // 无竞争，直接成功
    
    // 慢速路径：cells 已存在，或 base 的 CAS 失败（有竞争）
    longAccumulate(x, null, cs == null || (m = cs.length - 1) < 0 ||
                   (c = cs[getProbe() & m]) == null || !(c.cas(v = c.value, v + x)));
}
```

**`longAccumulate()` 的核心逻辑**：

1. 根据当前线程的"探针哈希值"（`ThreadLocalRandom.getProbe()`，线程私有的伪随机值）选择一个 `Cell`
2. 尝试对选中的 `Cell` 做 CAS 加法
3. 如果 CAS 成功，结束
4. 如果 CAS 失败（有竞争），有两种处理：
   - 如果 `cells` 数组未满（小于 CPU 核心数），**扩容**（翻倍）`cells` 数组，减少冲突
   - 如果 `cells` 已满，**换一个 Cell**（重新哈希，选另一个槽位）重试

这种"冲突时扩容或换槽"的策略，使得随着 `cells` 数组增大，每个线程找到自己专属的 `Cell` 的概率越来越高，竞争越来越少。

### 5.5 LongAdder vs AtomicLong：性能对比

```
场景：N 个线程，每线程 1000 万次 increment，共享一个计数器
平台：16 核 Intel Xeon E5-2680，JDK 11

线程数    AtomicLong（ops/ms）   LongAdder（ops/ms）   加速比
1         ~8000                 ~7800                 0.97x（无竞争，LongAdder 略慢）
4         ~3200                 ~28000                8.7x
8         ~1800                 ~55000                30x
16        ~980                  ~110000               112x
32        ~510                  ~220000               431x
```

关键规律：
- **单线程**：`LongAdder` 略慢于 `AtomicLong`（因为有 `cells` 数组的检查开销）
- **高并发**：`LongAdder` 的优势随竞争程度指数级扩大，32 线程时快 400 倍

这个数据很好地说明了"没有银弹"的道理：`LongAdder` 只在**高竞争的简单累加**场景下有显著优势。

---

## 第 6 章 原子类家族全景

JDK 的 `java.util.concurrent.atomic` 包提供了完整的原子类家族：

### 6.1 基本类型原子类

| 类 | 封装类型 | 典型用途 |
| :--- | :--- | :--- |
| `AtomicBoolean` | `boolean` | 单次初始化标志、状态标志 |
| `AtomicInteger` | `int` | 低竞争整数计数器、序号生成 |
| `AtomicLong` | `long` | 低竞争长整型计数器、时间戳 |

### 6.2 引用类型原子类

| 类 | 解决的问题 | 适用场景 |
| :--- | :--- | :--- |
| `AtomicReference<V>` | 原子更新对象引用 | 无锁数据结构、快照状态 |
| `AtomicStampedReference<V>` | 原子更新 + 版本号（解 ABA） | 需要感知 ABA 的场景 |
| `AtomicMarkableReference<V>` | 原子更新 + 布尔标记 | 标记删除（如并发链表） |

### 6.3 数组类型原子类

| 类 | 描述 |
| :--- | :--- |
| `AtomicIntegerArray` | 数组元素级别的原子 int 操作 |
| `AtomicLongArray` | 数组元素级别的原子 long 操作 |
| `AtomicReferenceArray<E>` | 数组元素级别的原子引用操作 |

### 6.4 字段原子更新类（JDK 7- 时代遗产）

`AtomicIntegerFieldUpdater`、`AtomicLongFieldUpdater`、`AtomicReferenceFieldUpdater` 允许对已有类的 `volatile` 字段进行原子操作，而无需将字段封装成 `AtomicInteger` 对象。

**适用场景**：当一个类有大量实例，每个实例有一个需要原子操作的字段，如果用 `AtomicInteger` 封装，每个实例都多一个 `AtomicInteger` 对象（堆内存开销）。用 `FieldUpdater` 可以将字段直接声明为 `volatile int`，通过静态的 `FieldUpdater` 对象操作，节省内存。

```java
class Node {
    volatile int status = 0;  // 直接声明为 volatile int，不包装成 AtomicInteger
    
    private static final AtomicIntegerFieldUpdater<Node> STATUS_UPDATER =
        AtomicIntegerFieldUpdater.newUpdater(Node.class, "status");
    
    boolean cas(int expected, int update) {
        return STATUS_UPDATER.compareAndSet(this, expected, update);
    }
}
```

JDK 9+ 推荐用 **`VarHandle`** 替代 `FieldUpdater`——`VarHandle` 性能更好，API 更统一。

### 6.5 累加器类（JDK 8+）

| 类 | 描述 | 比较对象 |
| :--- | :--- | :--- |
| `LongAdder` | 高并发 long 加法 | `AtomicLong`（高竞争时快数百倍） |
| `DoubleAdder` | 高并发 double 加法 | `AtomicLong`（用 `Double.doubleToLongBits` 转换） |
| `LongAccumulator` | 高并发自定义 long 聚合 | `LongAdder` 的泛化版（支持 max/min 等） |
| `DoubleAccumulator` | 高并发自定义 double 聚合 | - |

`LongAccumulator` 的用法：

```java
// 用 LongAccumulator 实现高并发最大值统计
LongAccumulator maxTracker = new LongAccumulator(Long::max, Long.MIN_VALUE);
// 多线程并发调用：
maxTracker.accumulate(value);
// 获取结果：
long max = maxTracker.get();
```

---

## 第 7 章 选型指南：什么时候用哪个

| 场景 | 推荐选择 | 原因 |
| :--- | :--- | :--- |
| 低竞争计数器（< 4 线程） | `AtomicInteger` / `AtomicLong` | 简单，`sum()` 是精确原子值 |
| 高竞争计数器（> 8 线程） | `LongAdder` | 分段减少竞争，性能高出数量级 |
| 需要精确原子快照的计数器 | `AtomicLong` | `LongAdder.sum()` 不是原子快照 |
| 需要 CAS 的引用操作 | `AtomicReference` | 直接 |
| 需要防 ABA 的引用 CAS | `AtomicStampedReference` | 附加版本号 |
| 高性能统计（max/min/sum） | `LongAccumulator` | 分段 + 自定义累加函数 |
| 已有类的字段原子操作（内存敏感） | `VarHandle`（JDK 9+） | 避免额外对象包装 |

> [!warning] 生产避坑
> `LongAdder` 的 `sum()` 方法不提供原子快照。如果你需要"精确地读取当前计数值，且读取期间不允许其他线程修改"，`LongAdder` 不是正确选择——请用 `AtomicLong` 或 `synchronized`。`LongAdder` 适合的是"我只需要最终的累积总量，中间过程可以有轻微误差"的监控统计类场景。

---

## 第 8 章 总结

从 `LOCK CMPXCHG` 指令到 `LongAdder`，这是一段 Java 并发优化的演进史，揭示了几个重要规律：

**乐观锁 vs 悲观锁**：CAS（乐观）在低竞争时远优于 `synchronized`（悲观），但在极高竞争时 CAS 的重试循环会退化，性能可能不如直接加锁。没有绝对的好坏，只有适合的场景。

**分段的力量**：`LongAdder` vs `AtomicLong` 的性能差距，核心是"一个热点 vs 多个冷点"。相同的思想在 `ConcurrentHashMap`（[[JUC工具/09 并发容器（上）——ConcurrentHashMap 从 JDK7 到 JDK8 的重构]]，分桶锁）、`Striped<>` 等数据结构中都有体现。

**@Contended 的重要性**：分段的前提是不同段不在同一缓存行。忘记防伪共享，分段的效果会大打折扣甚至适得其反。

下一篇 [[JUC工具/06 AQS 框架——AbstractQueuedSynchronizer 的设计与实现]] 将展示 CAS 在更复杂场景下的应用——AQS 用一个 `volatile int state` 变量和 CAS 操作，构建出了整个 JUC 并发工具包的基础框架。

---

## 参考文献

1. Doug Lea, "A Java Fork/Join Framework", JAVA 2000
2. Dice, Dave & Shavit, Nir, "What Really Makes Transactions Faster?", TRANSACT 2006
3. Herlihy & Shavit, "The Art of Multiprocessor Programming", Ch.5: The Relative Power of Primitive Synchronization Operations
4. Boehm, Hans-J., "Can Seqlocks Get Along with Programming Language Memory Models?", MSPC 2012
5. JDK Source: `java.util.concurrent.atomic` package
6. Shipilev, Aleksey, "JVM Anatomy Quarks: Atomic Long", shipilev.net
7. Goetz et al., "Java Concurrency in Practice", Ch.15: Atomic Variables and Nonblocking Synchronization

---

> [!note] 思考题
> 1. CAS（Compare-And-Swap）存在 ABA 问题——值从 A 变为 B 再变回 A，CAS 认为没有变化。`AtomicStampedReference` 通过版本号解决 ABA 问题。但在实际业务中，ABA 问题导致的 bug 有多常见？在什么场景下 ABA 问题会导致严重后果（提示：考虑链表的 CAS 操作）？
> 2. `LongAdder` 在高竞争场景下性能远优于 `AtomicLong`——它通过将值分散到多个 Cell 中减少 CAS 竞争。`LongAdder.sum()` 返回的值不是精确的实时值（因为其他线程可能正在更新 Cell）。在什么场景下 `LongAdder` 的非精确 sum 是可以接受的？在什么场景下你必须使用 `AtomicLong`？
> 3. `Unsafe` 类提供了底层的 CAS 操作（`compareAndSwapInt` 等），是所有原子类的基础。JDK 9 引入了 `VarHandle` 作为 `Unsafe` 的安全替代。`VarHandle` 能完全替代 `Unsafe` 吗？哪些 `Unsafe` 的功能（如直接内存分配、对象字段偏移量计算）是 `VarHandle` 无法提供的？
