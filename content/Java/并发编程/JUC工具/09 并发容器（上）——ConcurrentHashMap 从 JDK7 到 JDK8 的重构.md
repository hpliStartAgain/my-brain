---
title: "并发容器（上）——ConcurrentHashMap 从 JDK7 到 JDK8 的重构"
date: 2026-03-05
tags: [Java, 并发编程, ConcurrentHashMap, Segment, 分段锁, CAS, 红黑树, 扩容, CounterCell, 并发容器]
aliases: []
---

# 09 并发容器（上）——ConcurrentHashMap 从 JDK7 到 JDK8 的重构

**摘要：**

`ConcurrentHashMap` 是 Java 并发编程中使用最高频的并发数据结构，也是并发设计技巧的集大成者。从 JDK 7 的**分段锁（Segment）** 到 JDK 8 的 **CAS + synchronized**，这不仅是一次性能优化，更是一次设计哲学的转变——从"粗粒度锁一组桶"到"精确锁单个桶"。本文深入剖析两个版本的内部数据结构与并发控制策略：JDK 7 的 Segment 如何继承 `ReentrantLock` 实现 16 个分区的独立加锁；JDK 8 的 `Node` 数组如何在不加锁的情况下完成初始化和空桶插入，以及如何只用 `synchronized` 锁住单个桶头节点实现高并发写；扩容时的"迁移协助（transfer）"如何让多个线程分工合作；以及 `size()` 操作的 `CounterCell` 实现——这些细节共同构成了 `ConcurrentHashMap` 精妙的并发设计。最后分析 `computeIfAbsent` 的死锁陷阱与正确使用边界。

---

## 第 1 章 为什么 HashMap 不是线程安全的

### 1.1 HashMap 的并发危险

`HashMap` 在多线程环境下使用是危险的，不只是"可能读到旧值"那么简单，而是会引发严重的结构性破坏：

**JDK 7 的 resize 死锁**：JDK 7 中，`HashMap` 扩容时使用头插法迁移链表节点。多线程并发扩容时，可能形成环形链表——当一个线程调用 `get()` 时，在遍历链表的过程中陷入死循环，CPU 占用率飙升到 100%。这是一个非常经典的生产事故。

**JDK 8 的数据丢失**：JDK 8 改用尾插法，解决了链表成环的问题，但仍然存在多线程同时插入同一桶（put 时 CAS 竞争）导致数据丢失的问题。

**size 不准确**：并发 `put` 时对 `size` 字段的更新不是原子的，读到的 `size` 可能远小于实际大小。

这些问题决定了：在多线程环境下，必须使用线程安全的并发 Map，而不是在 `HashMap` 外面套一层 `Collections.synchronizedMap()`（它虽然线程安全，但用一把锁保护所有操作，并发度极低）。

### 1.2 设计目标

一个高性能的并发 HashMap 需要在以下目标间取得平衡：

**高并发读**：读操作（`get`）不应该需要加锁。大多数并发 Map 的访问模式是读多写少，如果每次读都加锁，并发度就退化到了 `Hashtable` 的水平。

**细粒度写并发**：写操作（`put`、`remove`）应该只锁住目标桶，不影响其他桶。理想情况下，如果两次写操作访问不同的桶，它们应该能完全并发执行。

**正确的内存可见性**：写操作对其他线程必须可见，这需要适当的 `volatile` 和内存屏障。

**高效的扩容**：扩容（resize）是 HashMap 最耗时的操作，应该支持多线程协助完成，而不是阻塞所有操作等待单线程扩容完成。

---

## 第 2 章 JDK 7 的 ConcurrentHashMap——Segment 分段锁

### 2.1 Segment 的数据结构

JDK 7 的 `ConcurrentHashMap` 采用**分段锁**设计：整个 HashMap 被分成若干个 **Segment**，每个 Segment 是一个独立的小 HashMap，有自己的 `ReentrantLock`。写操作只需锁住目标 Segment，其他 Segment 上的写操作可以并发执行。

```
JDK 7 ConcurrentHashMap 结构：

Segment[0]（ReentrantLock）    Segment[1]（ReentrantLock）    ...    Segment[15]（ReentrantLock）
    ↓                               ↓                                       ↓
HashEntry[] table               HashEntry[] table                      HashEntry[] table
[0] → e1 → e2 → null           [0] → null                            [0] → e5 → null
[1] → null                      [1] → e3 → null                       [1] → null
...                              ...                                    ...
```

默认配置：16 个 Segment，每个 Segment 内有一个初始容量为 2 的 `HashEntry[]`（总初始容量 32）。Segment 数量一旦确定就不再改变，只有 Segment 内部的 `HashEntry[]` 会随着 put 增多而扩容。

```java
// JDK 7 Segment（简化）
static final class Segment<K,V> extends ReentrantLock implements Serializable {
    transient volatile HashEntry<K,V>[] table;  // 桶数组，volatile 保证可见性
    transient int count;        // 当前 Segment 中的 Entry 数量
    transient int modCount;     // 结构修改次数（用于快速失败迭代）
    transient int threshold;    // 扩容阈值（= table.length * loadFactor）
    final float loadFactor;
    
    // put 操作加锁
    final V put(K key, int hash, V value, boolean onlyIfAbsent) {
        HashEntry<K,V> node = tryLock() ? null :
            scanAndLockForPut(key, hash, value);  // 尝试获取锁，失败则自旋等待
        // ... 在 table 中找到对应桶，插入或更新 ...
        unlock();
    }
}
```

### 2.2 读操作的无锁设计

JDK 7 `ConcurrentHashMap` 的 `get()` 操作**不加锁**，依赖 `volatile` 保证可见性：

```java
// JDK 7 get()（简化）
public V get(Object key) {
    Segment<K,V> s;
    HashEntry<K,V>[] tab;
    int h = hash(key);
    long u = (((h >>> segmentShift) & segmentMask) << SSHIFT) + SBASE;
    
    // UNSAFE.getObjectVolatile 读取 Segment（volatile 读，保证看到最新 Segment 引用）
    if ((s = (Segment<K,V>)UNSAFE.getObjectVolatile(segments, u)) != null &&
        (tab = s.table) != null) {
        
        // 遍历桶中的链表，查找 key
        for (HashEntry<K,V> e = (HashEntry<K,V>)UNSAFE.getObjectVolatile(
                tab, ((long)(((tab.length-1) & h)) << TSHIFT) + TBASE);
             e != null; e = e.next) {
            K k;
            if ((k = e.key) == key || (e.hash == h && key.equals(k)))
                return e.value;  // e.value 是 volatile，保证读到最新值
        }
    }
    return null;
}
```

`HashEntry` 的 `value` 字段是 `volatile` 的，`next` 也是 `volatile` 的——这保证了：即使读操作不加锁，读到的 `value` 也是最新写入的值（其他线程的 put 操作对 `value` 和 `next` 的写，通过 `volatile` 的 happens-before 保证对读线程可见）。

### 2.3 JDK 7 的 size() 实现

`size()` 需要统计所有 Segment 的 `count` 之和。如果每次都加锁遍历，代价太高。JDK 7 采用了一个聪明的策略：

1. **先尝试无锁统计**：连续两次遍历所有 Segment 的 `count` 求和，同时统计每次遍历时的 `modCount`（结构修改次数）总和。如果两次遍历的 `modCount` 相同，说明统计期间没有发生结构修改，结果可信，直接返回。
2. **超出重试次数则加全局锁**：如果连续 `RETRIES_BEFORE_LOCK`（默认 2）次无锁统计都检测到修改，则锁定所有 Segment，再次统计，保证一致性。

这个"乐观读+版本验证"的思路与 `StampedLock` 的乐观读如出一辙，只不过是手工实现的。

### 2.4 JDK 7 分段锁的局限性

JDK 7 的分段锁是当时的最优解，但有几个固有缺陷：

**Segment 数量固定**：初始化时确定的 Segment 数（默认 16）不能动态调整。在高并发场景下，16 个 Segment 可能仍然不够（最多 16 个写线程能真正并行）。

**Segment 数量不是越大越好**：更多的 Segment 意味着更多的 `ReentrantLock` 对象，内存开销增加。每个 Segment 还有一个独立的 `HashEntry[]` 数组，可能造成内存的不均匀分配（某些 Segment 满而其他 Segment 几乎空）。

**put 操作涉及两次哈希**：先定位 Segment，再在 Segment 内定位桶，两次哈希操作。

**不支持复合操作原子性**：`computeIfAbsent`、`merge` 等复合操作跨越了 Segment 内多个步骤，需要额外的 Segment 级锁定。

---

## 第 3 章 JDK 8 的 ConcurrentHashMap——CAS + synchronized 重构

### 3.1 JDK 8 的数据结构

JDK 8 彻底抛弃了 Segment，回归到类似 JDK 8 `HashMap` 的结构：**一个 `Node[]` 数组**（桶数组），每个桶是一个链表（< 8 个节点时）或红黑树（>= 8 个节点时）。

```
JDK 8 ConcurrentHashMap 结构：

Node[] table（volatile）
[0] → Node(k1,v1) → Node(k2,v2) → null    // 链表
[1] → TreeBin(root) → ...                  // 红黑树（通过 TreeBin 包装）
[2] → ForwardingNode(nextTable)            // 扩容中的转发节点
[3] → null
...
```

核心节点类型：

```java
// 普通链表节点
static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;         // 哈希值（final，不可变）
    final K key;            // 键（final）
    volatile V val;         // 值（volatile，保证读可见性）
    volatile Node<K,V> next; // 下一个节点（volatile）
}

// 扩容中的转发节点（hash = MOVED = -1）
static final class ForwardingNode<K,V> extends Node<K,V> {
    final Node<K,V>[] nextTable;  // 指向新的桶数组
}

// 红黑树根节点的包装（hash = TREEBIN = -2）
static final class TreeBin<K,V> extends Node<K,V> {
    TreeNode<K,V> root;           // 红黑树根节点
    volatile TreeNode<K,V> first; // 链表顺序的第一个节点
    volatile Thread waiter;       // 等待写锁的线程
    volatile int lockState;       // 锁状态（读写锁）
}
```

### 3.2 table 的延迟初始化

`table` 数组不在构造器中创建，而是在第一次 `put` 时**延迟初始化**。原因是：如果在构造器中创建，`new ConcurrentHashMap()` 会立即分配 16 * 指针大小 = 128 字节的数组，对于永远不被使用的实例是浪费；更重要的是，延迟初始化允许通过 `CAS` 实现无锁的并发初始化。

初始化的并发控制用了一个简单的状态字段 `sizeCtl`：

```java
private transient volatile int sizeCtl;
// sizeCtl 的语义：
// -1：table 正在初始化（有线程持有初始化权）
// -N：有 N-1 个线程正在协助扩容（N 编码了扩容戳）
// 0：table 尚未初始化（首次 put 会触发初始化）
// 正数：下次扩容的阈值（= table.length * 0.75）
```

初始化逻辑：

```java
private final Node<K,V>[] initTable() {
    Node<K,V>[] tab; int sc;
    while ((tab = table) == null || tab.length == 0) {
        if ((sc = sizeCtl) < 0)
            Thread.yield();  // 其他线程正在初始化，让出 CPU 等待
        else if (U.compareAndSetInt(this, SIZECTL, sc, -1)) {
            // CAS 将 sizeCtl 设为 -1，抢到了初始化权
            try {
                if ((tab = table) == null || tab.length == 0) {
                    int n = (sc > 0) ? sc : DEFAULT_CAPACITY;
                    Node<K,V>[] nt = (Node<K,V>[]) new Node<?,?>[n];
                    table = tab = nt;
                    sc = n - (n >>> 2);  // 0.75 * n（下次扩容阈值）
                }
            } finally {
                sizeCtl = sc;  // 恢复 sizeCtl 为正数（扩容阈值）
            }
            break;
        }
    }
    return tab;
}
```

### 3.3 put 操作的完整流程

JDK 8 的 `put` 是整个 `ConcurrentHashMap` 设计的精华所在：

```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    if (key == null || value == null) throw new NullPointerException();
    int hash = spread(key.hashCode());  // 二次哈希：(h ^ (h >>> 16)) & HASH_BITS
    int binCount = 0;
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh; K fk; V fv;
        
        // 情况 1：table 未初始化
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();
        
        // 情况 2：目标桶为空（CAS 无锁插入）
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            // CAS 尝试将新节点放入空桶
            if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value)))
                break;  // CAS 成功，无需锁
            // CAS 失败（其他线程同时插入），重试外层 for 循环
        }
        
        // 情况 3：桶头是 ForwardingNode（正在扩容）
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);  // 协助扩容，然后重试
        
        // 情况 4：优化快速路径（仅在 onlyIfAbsent=true 时）
        else if (onlyIfAbsent && fh == hash &&
                 ((fk = f.key) == key || fk != null && key.equals(fk)) &&
                 (fv = f.val) != null)
            return fv;  // key 已存在，不需要加锁直接返回
        
        // 情况 5：普通插入（加锁）
        else {
            V oldVal = null;
            synchronized (f) {  // 只锁住桶的头节点！
                if (tabAt(tab, i) == f) {  // double-check：头节点没变
                    if (fh >= 0) {  // 链表节点（fh >= 0 是链表节点的 hash）
                        binCount = 1;
                        for (Node<K,V> e = f;; ++binCount) {
                            K ek;
                            if (e.hash == hash && ((ek = e.key) == key ||
                                    (ek != null && key.equals(ek)))) {
                                oldVal = e.val;
                                if (!onlyIfAbsent)
                                    e.val = value;  // 更新已有 key 的值
                                break;
                            }
                            Node<K,V> pred = e;
                            if ((e = e.next) == null) {
                                pred.next = new Node<K,V>(hash, key, value);  // 尾插
                                break;
                            }
                        }
                    } else if (f instanceof TreeBin) {  // 红黑树
                        Node<K,V> p;
                        binCount = 2;
                        if ((p = ((TreeBin<K,V>)f).putTreeVal(hash, key, value)) != null) {
                            oldVal = p.val;
                            if (!onlyIfAbsent) p.val = value;
                        }
                    }
                    // else: ReservationNode（computeIfAbsent 占位），不处理
                }
            }
            // synchronized 块结束，检查是否需要树化
            if (binCount != 0) {
                if (binCount >= TREEIFY_THRESHOLD)  // TREEIFY_THRESHOLD = 8
                    treeifyBin(tab, i);  // 链表转红黑树
                if (oldVal != null)
                    return oldVal;
                break;
            }
        }
    }
    addCount(1L, binCount);  // 更新 size 计数
    return null;
}
```

**put 的四种情况总结**：

| 情况 | 条件 | 处理方式 | 是否加锁 |
| :--- | :--- | :--- | :--- |
| table 未初始化 | `tab == null` | `initTable()`（CAS 抢初始化权） | 无锁 |
| 目标桶为空 | `tabAt(...) == null` | CAS 插入新节点 | 无锁 |
| 正在扩容 | 头节点 `hash == MOVED` | 协助扩容（`helpTransfer`） | 无锁（内部有协调） |
| 桶有数据 | 头节点存在且 `hash >= 0` 或是 TreeBin | `synchronized(头节点)` 操作链表/红黑树 | **只锁头节点** |

### 3.4 get 操作的无锁读

```java
public V get(Object key) {
    Node<K,V>[] tab; Node<K,V> e, p; int n, eh; K ek;
    int h = spread(key.hashCode());
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (e = tabAt(tab, (n - 1) & h)) != null) {  // tabAt 是 volatile 读
        // 头节点就是目标（最快路径）
        if ((eh = e.hash) == h) {
            if ((ek = e.key) == key || (ek != null && key.equals(ek)))
                return e.val;
        }
        // hash < 0：特殊节点（ForwardingNode 或 TreeBin）
        else if (eh < 0)
            return (p = e.find(h, key)) != null ? p.val : null;
        // 遍历链表
        while ((e = e.next) != null) {
            if (e.hash == h && ((ek = e.key) == key || (ek != null && key.equals(ek))))
                return e.val;
        }
    }
    return null;
}
```

`get` 完全无锁：`tabAt` 使用 `Unsafe.getReferenceAcquire`（在 JDK 9+ 中，对应一个 LoadAcquire 语义的读操作），配合 `Node.val` 和 `Node.next` 的 `volatile` 属性，保证读到的是最新值。

---

## 第 4 章 扩容：多线程协助迁移

### 4.1 扩容触发条件

`ConcurrentHashMap` 在以下情况触发扩容：
- 键值对数量超过 `sizeCtl`（默认 0.75 × table.length）
- 链表转红黑树时，如果 `table.length < MIN_TREEIFY_CAPACITY`（默认 64），优先扩容而不是树化

### 4.2 transfer 的分段迁移

JDK 8 的扩容通过 `transfer` 方法实现，支持**多线程协助**：多个线程各自认领一段桶区间，并发地将旧数组中的节点迁移到新数组。

核心机制是 `ForwardingNode`：当一个线程完成某个桶的迁移后，在旧数组的该桶位置放置一个 `ForwardingNode`（hash = MOVED = -1），指向新数组。其他线程在 `put` 或 `get` 时遇到 `ForwardingNode`，知道这个桶已经迁移，要去新数组查找；`get` 直接跟随到新数组，`put` 则先调用 `helpTransfer` 协助扩容。

```java
// 扩容时线程认领任务的逻辑（简化）
private final void transfer(Node<K,V>[] tab, Node<K,V>[] nextTab) {
    int n = tab.length, stride;
    // 计算每个线程负责迁移的桶数（最少 MIN_TRANSFER_STRIDE = 16 个）
    if ((stride = (NCPU > 1) ? (n >>> 3) / NCPU : n) < MIN_TRANSFER_STRIDE)
        stride = MIN_TRANSFER_STRIDE;
    
    // ... 初始化 nextTable ...
    
    int nextn = nextTab.length;
    ForwardingNode<K,V> fwd = new ForwardingNode<K,V>(nextTab);
    boolean advance = true;  // 是否还需要向前推进
    
    for (int i = 0, bound = 0;;) {
        Node<K,V> f; int fh;
        
        // 通过 CAS 认领一段桶区间 [bound, i]
        while (advance) {
            int nextIndex, nextBound;
            if (--i >= bound || finishing)
                advance = false;
            else if ((nextIndex = transferIndex) <= 0) {
                i = -1;
                advance = false;
            } else if (U.compareAndSetInt(this, TRANSFERINDEX, nextIndex,
                nextBound = (nextIndex > stride ? nextIndex - stride : 0))) {
                bound = nextBound;
                i = nextIndex - 1;
                advance = false;
            }
        }
        
        // 处理当前桶 i
        if (i < 0 || i >= n || i + n >= nextn) {
            // ... 检查是否所有线程都完成，设置 sizeCtl ...
        } else if ((f = tabAt(tab, i)) == null) {
            // 空桶：直接放 ForwardingNode
            advance = casTabAt(tab, i, null, fwd);
        } else if ((fh = f.hash) == MOVED) {
            advance = true;  // 已经是 ForwardingNode，跳过
        } else {
            synchronized (f) {  // 锁住桶头节点
                // 将链表/红黑树分成高低位两组，分别放到新数组的对应位置
                // ... 迁移逻辑 ...
                setTabAt(tab, i, fwd);  // 放置 ForwardingNode
            }
            advance = true;
        }
    }
}
```

**高低位分流**：扩容时新数组大小是旧数组的 2 倍。对于旧数组桶 `i` 中的每个节点，新数组中的位置要么是 `i`（低位），要么是 `i + n`（高位），取决于节点的哈希值在第 `n` 位（旧数组长度的最高位）是 0 还是 1。这个性质与 JDK 8 `HashMap` 的扩容策略相同，避免了重新计算所有节点的哈希值。

---

## 第 5 章 size() 的 CounterCell 实现

### 5.1 为什么 size() 不能用单个 volatile 字段

简单地用一个 `volatile long size` 字段来记录元素数量，在高并发写的场景下会产生严重的性能问题：所有 `put`/`remove` 操作都要 CAS 更新这个字段，造成全局 CAS 热点（与 `AtomicLong` 在高竞争下的问题完全相同，参见 [[volatile与内置锁/05 CAS 与原子类——Unsafe、AtomicInteger 到 LongAdder 的演进]]）。

### 5.2 baseCount + CounterCell 的分段设计

JDK 8 `ConcurrentHashMap` 的 `size()` 实现与 `LongAdder` 完全相同的思路：

```java
private transient volatile long baseCount;         // 基础计数
private transient volatile CounterCell[] counterCells; // 分段计数器

// CounterCell 也用了 @Contended 防伪共享
@jdk.internal.vm.annotation.Contended
static final class CounterCell {
    volatile long value;
}
```

`addCount(long x, int check)` 的逻辑：
1. 先尝试 CAS 更新 `baseCount`
2. 如果 CAS 失败（有竞争），找到当前线程对应的 `CounterCell`，CAS 更新其 `value`
3. 如果对应的 `CounterCell` 不存在，创建它；如果 `counterCells` 数组不够大，扩容

`size()` 的计算：

```java
public int size() {
    long n = sumCount();
    return ((n < 0L) ? 0 :
            (n > (long)Integer.MAX_VALUE) ? Integer.MAX_VALUE :
            (int)n);
}

final long sumCount() {
    CounterCell[] cs = counterCells;
    long sum = baseCount;
    if (cs != null) {
        for (CounterCell c : cs)
            if (c != null)
                sum += c.value;
    }
    return sum;
}
```

`size()` 不是精确原子的——在 `sumCount()` 执行期间，其他线程可能正在进行 `put`/`remove`。但对于大多数使用场景（如监控、估算容量），这个近似值已经足够。

---

## 第 6 章 computeIfAbsent 的死锁陷阱

### 6.1 问题描述

JDK 8 的 `ConcurrentHashMap` 中，`computeIfAbsent` 在特定情况下会死锁：

```java
// 死锁场景：在 computeIfAbsent 的 mapping 函数中再次 computeIfAbsent 同一个 key
ConcurrentHashMap<Integer, Integer> map = new ConcurrentHashMap<>();
map.computeIfAbsent(0, k -> map.computeIfAbsent(0, k2 -> 42));
// 上面这行会死锁！
```

**原因分析**：

`computeIfAbsent` 的实现（JDK 8）：
1. 计算 key 的哈希值，找到目标桶 `i`
2. 如果桶为空，放置一个 **`ReservationNode`**（hash = RESERVED = -3）占位，防止其他线程同时操作
3. **在 `synchronized(ReservationNode)` 锁内**调用 mapping 函数
4. 如果 mapping 函数返回非 null，用结果替换 `ReservationNode`；否则移除占位

问题在第 3 步：在 `synchronized(ReservationNode)` 锁内，如果 mapping 函数再次调用 `computeIfAbsent(0, ...)`，内层调用会找到同一个桶，发现已经有一个节点（`ReservationNode`），会尝试 `synchronized(ReservationNode)`——但这个锁已经被外层持有了，死锁！

**JDK 9 修复**：JDK 9 对此做了修复，内层 `computeIfAbsent` 遇到 `ReservationNode` 时会抛出 `IllegalStateException`（"Recursive update"）而不是死锁。但如果你使用的是 JDK 8，这个问题依然存在。

> [!warning] 生产避坑
> 不要在 `ConcurrentHashMap.computeIfAbsent` 的 mapping 函数中对**同一个** `ConcurrentHashMap` 实例进行任何写操作（`put`、`computeIfAbsent` 等）。这会在 JDK 8 导致死锁，在 JDK 9+ 导致 `IllegalStateException`。如果确实需要递归计算，应该先计算出结果，再调用 `computeIfAbsent`。

### 6.2 另一个陷阱：mapping 函数被调用多次

`computeIfAbsent` 不保证 mapping 函数只被调用一次。在多线程竞争同一个 key 时，多个线程可能同时调用 mapping 函数，只有一个线程的结果最终被放入 Map。

如果 mapping 函数有副作用（如创建数据库连接、发送网络请求），这可能造成意外的多次执行。在这类场景中，应该使用更显式的锁控制，或者将 mapping 函数设计为无副作用的。

---

## 第 7 章 JDK 7 vs JDK 8 对比总结

| 维度 | JDK 7 | JDK 8 |
| :--- | :--- | :--- |
| **锁粒度** | Segment（一组桶） | 单个桶头节点 |
| **锁类型** | `ReentrantLock`（Segment 继承） | `synchronized`（直接锁 Node） |
| **最大并发写数** | 16（默认 Segment 数） | table.length（等于桶数，默认 16，可扩容到更大） |
| **链表长度限制** | 无，一直是链表 | > 8 时转红黑树，O(n) → O(log n) |
| **扩容** | 单线程扩容（Segment 内） | 多线程协助迁移（ForwardingNode + transferIndex） |
| **size 实现** | 多次无锁重试 + 全局锁 | baseCount + CounterCell（类 LongAdder） |
| **null 值** | 不允许 null key/value | 不允许 null key/value |
| **get 锁** | 无锁（volatile 读） | 无锁（volatile 读） |
| **内存占用** | 较高（Segment + 内部 table 双层结构） | 较低（单层 Node[] 数组） |

JDK 8 的重构本质是：用**更细粒度**（单桶）替代**中等粒度**（Segment），并将锁从 `ReentrantLock`（相对重）换成 `synchronized`（JDK 6+ 经过锁升级优化后，在低竞争场景下极轻量）。同时，将链表改为红黑树解决了哈希冲突严重时的性能退化问题（JDK 7 的链表在最坏情况下查找是 O(n)）。

下一篇 [[JUC工具/10 并发容器（下）——CopyOnWriteArrayList、BlockingQueue 家族]] 将讨论另一类并发容器——`CopyOnWriteArrayList` 的写时复制语义，以及 `BlockingQueue` 家族的各种实现与适用场景。

---

## 参考文献

1. Doug Lea, "`java.util.concurrent.ConcurrentHashMap`" 源码注释
2. JDK 8 `ConcurrentHashMap` 源码：OpenJDK `java.base/java/util/concurrent/ConcurrentHashMap.java`
3. Goetz et al., "Java Concurrency in Practice", Ch.5: Building Blocks
4. 美团技术博客, "Java 8 ConcurrentHashMap 源码分析", 2018
5. JDK Bug JDK-8062841: "ConcurrentHashMap.computeIfAbsent can hang", bugs.openjdk.java.net
