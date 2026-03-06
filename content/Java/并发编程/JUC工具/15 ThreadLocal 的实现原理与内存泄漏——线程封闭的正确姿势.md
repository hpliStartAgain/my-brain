---
title: "ThreadLocal 的实现原理与内存泄漏——线程封闭的正确姿势"
date: 2026-03-05
tags: [Java, 并发编程, ThreadLocal, ThreadLocalMap, 内存泄漏, 弱引用, 线程封闭, InheritableThreadLocal, TransmittableThreadLocal]
aliases: []
---

# 15 ThreadLocal 的实现原理与内存泄漏——线程封闭的正确姿势

**摘要：**

`ThreadLocal` 是 Java 实现**线程封闭（Thread Confinement）** 的核心工具——它让每个线程拥有变量的独立副本，彻底消除了共享状态，从根本上规避了并发冲突。但 `ThreadLocal` 并不像表面上看起来那么简单：它的数据存储在 `Thread` 对象的 `threadLocals` 字段（一个自定义的 `ThreadLocalMap`），`Entry` 的 **key 是对 `ThreadLocal` 对象的弱引用（WeakReference）**——这个设计原本是为了防止内存泄漏，却在线程池环境下引入了更隐蔽的内存泄漏和数据污染问题。本文深入剖析 `ThreadLocalMap` 的开放地址法散列实现、弱引用 key 的 GC 与 `stale entry` 清理机制、线程池中 `ThreadLocal` 数据不清理导致的泄漏原理，以及 `InheritableThreadLocal`（父子线程继承）和阿里巴巴开源的 `TransmittableThreadLocal`（跨线程池传递上下文）的设计思路与边界。

---

## 第 1 章 线程封闭——最强的并发安全保证

### 1.1 三种并发安全策略

解决并发安全问题有三种根本策略，从强到弱排列：

**策略 1：线程封闭（Thread Confinement）**——数据只归一个线程拥有，其他线程根本访问不到，不需要任何同步。这是并发安全的最高境界，消灭了并发问题的根源（共享可变状态）。

**策略 2：不可变性（Immutability）**——数据共享但不可变，多线程只读无竞争。`String`、`Integer`、`BigDecimal` 等不可变类天然线程安全。

**策略 3：同步（Synchronization）**——数据共享且可变，用锁/CAS/volatile 等机制保证正确性。这是前两种策略都无法使用时的最后手段，也是复杂度最高的方案。

`ThreadLocal` 实现的就是策略 1——每个线程持有自己独立的变量副本，线程间完全隔离。

### 1.2 ThreadLocal 的典型使用场景

**场景 1：维护线程独享的对象（如 `SimpleDateFormat`）**

`SimpleDateFormat` 不是线程安全的（其内部有可变的日期解析状态），如果多线程共享同一个实例会出现格式化错误。一种方案是每次调用都 `new SimpleDateFormat()`（对象创建代价高），另一种是用 `ThreadLocal` 每个线程一个实例：

```java
// 每个线程持有自己的 SimpleDateFormat 实例
private static final ThreadLocal<SimpleDateFormat> dateFormat =
    ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd HH:mm:ss"));

public static String format(Date date) {
    return dateFormat.get().format(date);  // 每个线程用自己的 SDF，无竞争
}
```

**场景 2：传递请求上下文（避免方法间参数传递）**

在 Web 应用中，一个 HTTP 请求从 Controller → Service → Repository 的调用链中，需要传递请求 ID、用户 ID、权限信息等上下文。如果每个方法都加参数，代码非常臃肿。`ThreadLocal` 可以在请求入口处设置，在调用链任意深度读取：

```java
// 请求上下文
public class RequestContext {
    private static final ThreadLocal<RequestContext> CURRENT = new ThreadLocal<>();
    
    private String requestId;
    private Long userId;
    
    public static void set(RequestContext ctx) { CURRENT.set(ctx); }
    public static RequestContext get() { return CURRENT.get(); }
    public static void clear() { CURRENT.remove(); }  // 关键！
}

// 在 Filter/Interceptor 中设置和清理
public class RequestContextFilter implements Filter {
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        RequestContext ctx = buildContext(req);
        RequestContext.set(ctx);
        try {
            chain.doFilter(req, res);  // 整个请求处理链都能通过 RequestContext.get() 获取
        } finally {
            RequestContext.clear();    // 关键：请求结束后必须清理！
        }
    }
}
```

---

## 第 2 章 ThreadLocal 的内部数据结构

### 2.1 数据存储在 Thread 中，而不是 ThreadLocal 中

很多人以为 `ThreadLocal` 内部有一个 `Map<Thread, T>`，用线程作为 key 存储各线程的值。这个直觉是错误的。

实际设计恰恰相反：**数据存储在 `Thread` 对象本身**，而不是 `ThreadLocal` 对象中：

```java
// java.lang.Thread 中的字段
class Thread {
    // ...
    ThreadLocal.ThreadLocalMap threadLocals = null;  // 当前线程的 ThreadLocal 数据
    ThreadLocal.ThreadLocalMap inheritableThreadLocals = null;  // 可继承的
}
```

每个 `Thread` 对象持有一个 `ThreadLocalMap`，这个 Map 的 key 是 `ThreadLocal` 对象（弱引用），value 是该线程对应的值：

```
Thread T1 的 threadLocals（ThreadLocalMap）：
  Entry[hash(dateFormat)] = (WeakRef(dateFormat) → T1的SDF实例)
  Entry[hash(requestCtx)] = (WeakRef(requestCtx) → T1的RequestContext)

Thread T2 的 threadLocals（ThreadLocalMap）：
  Entry[hash(dateFormat)] = (WeakRef(dateFormat) → T2的SDF实例)
  Entry[hash(requestCtx)] = (WeakRef(requestCtx) → T2的RequestContext)
```

**为什么这样设计，而不是用 `ThreadLocal` 持有 `Map<Thread, T>`？**

如果 `ThreadLocal` 持有 `Map<Thread, T>`，那么所有线程对同一个 `ThreadLocal` 的访问都需要操作这个共享 Map——锁竞争或 CAS 热点。

而将数据存储在 `Thread` 对象中，每个线程的 `ThreadLocalMap` 只被自己的线程访问，**完全无竞争**，也不需要任何同步。这正是"线程封闭"的极致体现——连 Map 本身都是线程私有的。

### 2.2 ThreadLocalMap：开放地址法的自定义哈希表

`ThreadLocalMap` 是 `ThreadLocal` 的内部类，它是一个**用开放地址法（线性探测法）实现的哈希表**，而不是像 `HashMap` 那样用拉链法。

```java
static class ThreadLocalMap {
    // Entry：键值对节点，key 是 ThreadLocal 的弱引用
    static class Entry extends WeakReference<ThreadLocal<?>> {
        Object value;  // 线程本地值（强引用！）
        
        Entry(ThreadLocal<?> k, Object v) {
            super(k);   // ThreadLocal 是弱引用（WeakReference）
            value = v;  // value 是强引用
        }
    }
    
    private static final int INITIAL_CAPACITY = 16;
    private Entry[] table;    // Entry 数组，大小始终是 2 的幂
    private int size;         // 当前 Entry 数量
    private int threshold;    // 扩容阈值（= table.length * 2/3）
}
```

**开放地址法的工作原理**：

当两个 `ThreadLocal` 的哈希值冲突时，不像 `HashMap` 那样在同一桶中建立链表，而是向后探测（线性探测），找到下一个空位存放：

```java
// ThreadLocal 的 hashCode 生成：每个 ThreadLocal 实例都有一个唯一的 threadLocalHashCode
private final int threadLocalHashCode = nextHashCode();
private static AtomicInteger nextHashCode = new AtomicInteger();
// 黄金分割数：0x61c88647，使哈希值均匀分布在 2 的幂次大小的数组中
private static final int HASH_INCREMENT = 0x61c88647;

private static int nextHashCode() {
    return nextHashCode.getAndAdd(HASH_INCREMENT);
}
```

`0x61c88647` 是一个与斐波那契数列相关的黄金比例数，它能让连续递增的整数均匀地散列到 2 的幂次长度的数组中，减少冲突。

`set(ThreadLocal<?> key, Object value)` 的逻辑：

```java
private void set(ThreadLocal<?> key, Object value) {
    Entry[] tab = table;
    int len = tab.length;
    int i = key.threadLocalHashCode & (len - 1);  // 初始槽位

    for (Entry e = tab[i]; e != null; e = tab[i = nextIndex(i, len)]) {
        // 获取弱引用指向的 ThreadLocal
        ThreadLocal<?> k = e.get();
        
        if (k == key) {
            e.value = value;  // key 命中，更新 value
            return;
        }
        
        if (k == null) {
            // k == null 说明这个 Entry 的 ThreadLocal 已被 GC 回收（stale entry）
            // 替换这个 stale entry（顺便清理其他 stale entries）
            replaceStaleEntry(key, value, i);
            return;
        }
    }
    
    // 找到了空槽（e == null），在此放置新 Entry
    tab[i] = new Entry(key, value);
    int sz = ++size;
    if (!cleanSomeSlots(i, sz) && sz >= threshold)
        rehash();  // 扩容
}
```

---

## 第 3 章 弱引用 key 的设计意图与泄漏根源

### 3.1 为什么 Entry 的 key 是弱引用

如果 `Entry` 的 key 是对 `ThreadLocal` 对象的**强引用**，会发生什么？

```
场景：代码中创建了一个局部 ThreadLocal，使用后局部变量离开作用域

ThreadLocal<byte[]> tl = new ThreadLocal<>();  // 方法内部局部变量
tl.set(new byte[1024 * 1024]);  // 在当前线程设置 1MB 数据
// tl 局部变量离开作用域...

// 此时：
// - 局部变量 tl（对 ThreadLocal 对象的引用）消失
// - 但线程的 threadLocals Map 中仍有 Entry(key → ThreadLocal对象, value → 1MB数据)
// - 如果 key 是强引用，ThreadLocal 对象永远无法被 GC 回收
// - 由于 Entry.key → ThreadLocal 的强引用，1MB 的 value 也无法被回收
// - 只要线程还活着（线程池中的线程可能永久存活），这 1MB 就永远泄漏
```

为了避免这种泄漏，JDK 设计者让 `Entry.key` 持有对 `ThreadLocal` 对象的**弱引用**：

```
ThreadLocal 对象的引用链：
  外部强引用：
    static ThreadLocal<...> = tl;  ← 强引用（只要这个 static 字段存在，ThreadLocal 不会被 GC）
    局部变量 tl = ...;              ← 强引用（方法内部局部）
    
  内部弱引用：
    Thread.threadLocals[i].key = WeakRef(ThreadLocal对象)  ← 弱引用
```

当所有对 `ThreadLocal` 对象的**强引用**都消失后（如 `static` 字段被置为 null，或方法返回局部变量消失），`ThreadLocal` 对象会在下次 GC 时被回收，`Entry.key`（弱引用）变为 null，这个 `Entry` 成为 **stale entry（过期条目）**。

### 3.2 弱引用 key 解决了一部分问题，但引入了新问题

弱引用 key 让 `ThreadLocal` 对象本身能被 GC 回收，但 `Entry.value`（强引用）还在！

```
GC 后的状态：
  Thread.threadLocals[i]:
    key → null（弱引用，ThreadLocal 对象已被 GC）
    value → 某个对象（强引用，GC 无法回收！）
```

只要 `Thread` 对象还活着（线程池中的核心线程永久存活），这些 stale entry 中的 value 就无法被 GC，形成内存泄漏。

JDK 的应对策略是：在 `get()`、`set()`、`remove()` 等方法中，**顺便清理 stale entry**：

```java
// get() 时发现 stale entry 会触发清理
private Entry getEntryAfterMiss(ThreadLocal<?> key, int i, Entry e) {
    Entry[] tab = table;
    int len = tab.length;
    while (e != null) {
        ThreadLocal<?> k = e.get();
        if (k == key) return e;
        if (k == null)
            expungeStaleEntry(i);  // 清理 stale entry
        else
            i = nextIndex(i, len);
        e = tab[i];
    }
    return null;
}

// expungeStaleEntry：清理单个 stale entry，并重新散列其后的连续 entry
private int expungeStaleEntry(int staleSlot) {
    Entry[] tab = table;
    int len = tab.length;
    
    // 清理 staleSlot 处的 entry
    tab[staleSlot].value = null;  // 断开 value 的强引用，允许 GC
    tab[staleSlot] = null;
    size--;
    
    // 重新散列 staleSlot 之后的所有 entry（直到碰到空槽）
    // 因为开放地址法中，后续 entry 可能因为之前的冲突而"位移"，
    // 清理 staleSlot 后这些 entry 需要归位
    Entry e;
    int i;
    for (i = nextIndex(staleSlot, len); (e = tab[i]) != null; i = nextIndex(i, len)) {
        ThreadLocal<?> k = e.get();
        if (k == null) {
            e.value = null;  // 顺手清理其他 stale entry
            tab[i] = null;
            size--;
        } else {
            // 归位：将 entry 移到其应该在的槽位
            int h = k.threadLocalHashCode & (len - 1);
            if (h != i) {
                tab[i] = null;
                while (tab[h] != null)
                    h = nextIndex(h, len);
                tab[h] = e;
            }
        }
    }
    return i;
}
```

但这种"懒清理"有一个前提：**需要有后续的 `get()`/`set()`/`remove()` 调用来触发清理**。如果线程池中的线程在完成一个任务后，再也不调用那个 `ThreadLocal` 的 `get()`/`set()`，stale entry 就永远不会被清理。

---

## 第 4 章 线程池中的内存泄漏与数据污染

### 4.1 线程池的核心问题：线程复用

`ThreadLocal` 的清理机制在普通线程（用完即销毁）中工作良好：线程结束时，`Thread` 对象被 GC，`threadLocals` 中的所有数据随之消失。

但在**线程池**中，核心线程（如果不设置 `allowCoreThreadTimeOut`）永远不会被销毁，一直复用。这意味着：

- 任务 A 在线程 T1 上执行，通过 `ThreadLocal` 设置了用户 ID = 100
- 任务 A 执行完毕，**忘记调用 `ThreadLocal.remove()`**
- 线程 T1 空闲，被线程池回收，等待下一个任务
- 任务 B 被分配到线程 T1 执行
- 任务 B 调用 `ThreadLocal.get()`，读到了**任务 A 遗留的用户 ID = 100**！

这就是**数据污染（Data Contamination）**——线程 B 错误地读取了线程 A 的数据，可能导致权限绕过、数据混乱等严重 Bug。在 Web 应用中，如果每个请求的用户 ID 通过 `ThreadLocal` 传递，忘记 `remove()` 会导致一个用户的请求"看到"另一个用户的数据——这是严重的安全漏洞。

### 4.2 内存泄漏场景

```java
// 反面教材：线程池中使用 ThreadLocal 而不清理
ThreadLocal<LargeObject> tl = new ThreadLocal<>();

executor.submit(() -> {
    tl.set(new LargeObject(/* 1MB 数据 */));
    doWork();
    // 忘记 tl.remove()！
});

// 此时：
// 1. 线程池的线程存活，Thread.threadLocals 中有 Entry(key→tl, value→1MB数据)
// 2. 如果 tl 是局部变量，ThreadLocal 对象的强引用消失，但 Thread 还持有
//    Entry(key→WeakRef(tl), value→1MB)
// 3. GC 后 key 变为 null，但 value（1MB）的强引用仍在 threadLocals 中
// 4. 线程池线程不退出，这 1MB 永远不会被 GC → 内存泄漏！
```

### 4.3 正确的使用模式：必须调用 remove()

**线程池中使用 `ThreadLocal` 的正确模式**：

```java
// 正确：必须在任务结束时 remove()
executor.submit(() -> {
    tl.set(computeValue());
    try {
        doWork();
    } finally {
        tl.remove();  // 关键！必须在 finally 中，确保即使 doWork 抛异常也会清理
    }
});

// 在 Web 框架中：在 Filter/Interceptor 中清理
public class ContextFilter implements Filter {
    public void doFilter(request, response, chain) {
        threadLocal.set(buildContext(request));
        try {
            chain.doFilter(request, response);
        } finally {
            threadLocal.remove();  // 请求结束清理
        }
    }
}
```

> [!warning] 生产避坑
> 线程池中使用 `ThreadLocal` **必须在 `finally` 中调用 `remove()`**。这不是建议，是强制要求。没有 `remove()` 的 `ThreadLocal` 在线程池环境下一定会导致内存泄漏和数据污染。阿里巴巴 Java 开发手册将此列为强制规则：必须回收自定义的 `ThreadLocal` 变量。

---

## 第 5 章 InheritableThreadLocal——父子线程的值继承

### 5.1 子线程无法继承父线程的 ThreadLocal

`ThreadLocal` 是线程级私有的，子线程不会自动继承父线程的值：

```java
ThreadLocal<String> tl = new ThreadLocal<>();
tl.set("父线程的值");

new Thread(() -> {
    System.out.println(tl.get());  // null！子线程无法读到父线程的值
}).start();
```

这在某些场景下是期望行为（完全隔离），但在另一些场景下是问题——如链路追踪 ID、用户上下文需要从父线程传递给子线程。

### 5.2 InheritableThreadLocal

JDK 提供了 `InheritableThreadLocal` 来解决这个问题：

```java
InheritableThreadLocal<String> itl = new InheritableThreadLocal<>();
itl.set("父线程的值");

new Thread(() -> {
    System.out.println(itl.get());  // "父线程的值" ✓
}).start();
```

实现机制：`Thread` 有两个 Map 字段——`threadLocals`（普通）和 `inheritableThreadLocals`（可继承）。创建子线程时，在 `Thread.init()` 中：

```java
// Thread.init() 的关键部分（简化）
private void init(/* ... */) {
    Thread parent = currentThread();
    if (parent.inheritableThreadLocals != null)
        // 复制父线程的 inheritableThreadLocals 到子线程
        this.inheritableThreadLocals = ThreadLocal.createInheritedMap(parent.inheritableThreadLocals);
}
```

**`InheritableThreadLocal` 的局限性**：

继承发生在线程**创建时**（一次性复制），不是实时同步的。如果父线程在子线程创建后修改了值，子线程看不到新值。更重要的是：**线程池中的线程不是在任务提交时创建的，而是提前创建好的**——任务提交时，复用的是已创建的线程，不会触发 `init()`，所以 `InheritableThreadLocal` 在线程池中**不能正确传递上下文**。

---

## 第 6 章 TransmittableThreadLocal——跨线程池的上下文传递

### 6.1 问题场景

```java
InheritableThreadLocal<String> itl = new InheritableThreadLocal<>();
itl.set("requestId-123");

// 使用线程池提交任务
executor.submit(() -> {
    System.out.println(itl.get());  // 可能是 null，或者是上一个任务遗留的旧值！
});
```

线程池的线程在池创建时就已经建好，之后复用，`InheritableThreadLocal` 的继承机制无法在任务提交时触发。

### 6.2 TransmittableThreadLocal 的解决思路

阿里巴巴开源的 `TransmittableThreadLocal`（TTL）通过**包装 `Runnable`/`Callable`** 在任务**提交时**捕获当前线程的上下文，在任务**执行前**恢复到执行线程，执行后清理：

```java
// TTL 的核心机制（概念性描述）
class TtlRunnable implements Runnable {
    private final Runnable runnable;
    // 在任务"提交时"（捕获点）保存当前线程的 TTL 值
    private final Map<TransmittableThreadLocal<?>, Object> capturedSnapshot;
    
    TtlRunnable(Runnable r) {
        this.runnable = r;
        this.capturedSnapshot = TransmittableThreadLocal.Transmitter.capture();
    }
    
    @Override
    public void run() {
        // 执行任务前：将捕获的上下文恢复到当前执行线程
        Map<?, ?> backup = TransmittableThreadLocal.Transmitter.replay(capturedSnapshot);
        try {
            runnable.run();
        } finally {
            // 执行任务后：清理，恢复执行线程的原始上下文（避免污染）
            TransmittableThreadLocal.Transmitter.restore(backup);
        }
    }
}
```

TTL 的使用：

```java
// 方式 1：手动包装
executor.submit(TtlRunnable.get(() -> {
    System.out.println(ttl.get());  // 正确读到提交时的值
}));

// 方式 2：包装 ExecutorService（推荐，透明化）
ExecutorService ttlExecutor = TtlExecutors.getTtlExecutorService(executor);
ttlExecutor.submit(() -> {
    System.out.println(ttl.get());  // 自动传递，无需手动包装
});

// 方式 3：Java Agent（完全无侵入，推荐生产使用）
// 启动时添加 -javaagent:transmittable-thread-local-x.x.x.jar
// 所有线程池操作自动传递 TTL
```

`TransmittableThreadLocal` 是分布式链路追踪（Zipkin、SkyWalking）、多租户隔离、权限上下文传递等场景的标准解决方案，在国内大厂应用非常广泛。

---

## 第 7 章 ThreadLocalMap 的 rehash 与 expunge 全流程

### 7.1 扩容策略

`ThreadLocalMap` 的负载因子是 2/3（比 `HashMap` 的 0.75 更保守），扩容时大小翻倍：

```java
private void rehash() {
    expungeStaleEntries();  // 先全量清理所有 stale entry
    // 清理后如果大小仍然超过阈值的 3/4，才真正扩容
    if (size >= threshold - threshold / 4)
        resize();
}

private void resize() {
    Entry[] oldTab = table;
    int oldLen = oldTab.length;
    int newLen = oldLen * 2;  // 翻倍
    Entry[] newTab = new Entry[newLen];
    int count = 0;
    
    for (Entry e : oldTab) {
        if (e != null) {
            ThreadLocal<?> k = e.get();
            if (k == null) {
                e.value = null;  // 丢弃 stale entry
            } else {
                // 重新散列到新数组
                int h = k.threadLocalHashCode & (newLen - 1);
                while (newTab[h] != null)
                    h = nextIndex(h, newLen);
                newTab[h] = e;
                count++;
            }
        }
    }
    
    setThreshold(newLen);
    size = count;
    table = newTab;
}
```

---

## 第 8 章 总结

`ThreadLocal` 是一把双刃剑：用对了是消灭共享状态、实现线程封闭的利器；用错了在线程池环境下是内存泄漏和数据污染的来源。

**核心设计**：数据存在 `Thread.threadLocals`（`ThreadLocalMap`），而非 `ThreadLocal` 对象中——完全无竞争，每个线程只访问自己的 Map。

**弱引用 key**：`Entry.key` 是弱引用，允许 `ThreadLocal` 对象被 GC 回收，但 `Entry.value` 是强引用，stale entry 的 value 需要通过 `get()`/`set()`/`remove()` 触发懒清理，或主动调用 `remove()`。

**线程池陷阱**：线程池的线程不销毁，`ThreadLocal` 数据会在任务间"渗透"。**在线程池中使用 `ThreadLocal` 必须在 `finally` 中调用 `remove()`**，这是强制要求。

**跨线程池传递**：`InheritableThreadLocal` 只在线程创建时继承一次，不适用线程池场景；`TransmittableThreadLocal`（TTL）通过在任务提交时捕获、执行前恢复的方式解决了这个问题，是工程实践中的标准方案。

下一篇 [[JUC工具/16 JDK 21 虚拟线程——Project Loom 的协程实现与平台线程的边界]] 将进入 Java 并发编程的最新前沿——JDK 21 正式发布的虚拟线程（Virtual Threads），解析它如何通过 Continuation 和 Carrier Thread 实现轻量级协程，以及它对现有并发代码的影响。

---

## 参考文献

1. JDK 源码：`java.lang.ThreadLocal`、`java.lang.Thread`
2. 阿里巴巴 Java 开发手册，"并发处理"章节
3. 阿里巴巴 TransmittableThreadLocal 开源项目，github.com/alibaba/transmittable-thread-local
4. Goetz et al., "Java Concurrency in Practice", Ch.3: Sharing Objects, Sec.3.3 Thread Confinement
5. OpenJDK 源码：`java.lang.ThreadLocal.ThreadLocalMap`

---

> [!note] 思考题
> 1. ThreadLocal 的 ThreadLocalMap 使用弱引用（WeakReference）指向 ThreadLocal key。当 ThreadLocal 变量没有外部强引用时，key 会被 GC 回收，但 value 不会——因为 value 被 Entry 强引用。这就是 ThreadLocal 内存泄漏的根本原因。但 ThreadLocalMap 在 `get/set/remove` 时会清理 key 为 null 的 Entry——那泄漏是在什么条件下发生的？
> 2. 在线程池场景中，ThreadLocal 的危害被放大——线程被复用意味着 ThreadLocal 中的数据不会被自动清理。如果线程 A 处理请求 1 时设置了 `userContext.set(user1)`，线程 A 处理请求 2 时如果没有清除 ThreadLocal，会读到 user1 的数据——这是一个严重的安全漏洞。除了在 `finally` 中调用 `remove()`，你有什么机制来保证 ThreadLocal 一定被清理？
> 3. Java 21 的虚拟线程（Virtual Thread）与 ThreadLocal 存在兼容性问题——虚拟线程的数量可能达到百万级，每个虚拟线程都有自己的 ThreadLocalMap，内存开销巨大。JDK 21 引入了 `ScopedValue` 作为 ThreadLocal 的替代。`ScopedValue` 与 ThreadLocal 的核心区别是什么？在什么场景下 `ScopedValue` 无法替代 ThreadLocal？
