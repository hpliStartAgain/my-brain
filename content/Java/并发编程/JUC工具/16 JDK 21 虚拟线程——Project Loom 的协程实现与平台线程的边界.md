---
title: "JDK 21 虚拟线程——Project Loom 的协程实现与平台线程的边界"
date: 2026-03-05
tags: [Java, 并发编程, 虚拟线程, VirtualThread, ProjectLoom, Continuation, CarrierThread, 协程, JDK21, 结构化并发]
aliases: []
---

# 16 JDK 21 虚拟线程——Project Loom 的协程实现与平台线程的边界

**摘要：**

Java 并发编程经历了从 OS 线程到线程池再到异步回调的演进，每一步都是对"IO 等待浪费线程"问题的妥协。**JDK 21 正式引入的虚拟线程（Virtual Threads）** 是 Project Loom 项目的核心交付，它从根本上改变了 Java 的并发模型：虚拟线程极其轻量（创建代价约 1 微秒，内存约 1KB），可以创建数百万个；当虚拟线程阻塞在 IO 上时，底层的**平台线程（Carrier Thread）** 不阻塞，而是挂起虚拟线程的 **Continuation（续体）** 并切换去处理其他虚拟线程——实现了 Go goroutine 式的"同步代码风格，异步执行效率"。本文深入剖析虚拟线程的 Continuation 实现机制、调度器（ForkJoinPool）与平台线程的关系、Pinning（固定）现象的根因与规避、以及虚拟线程对现有代码（`synchronized`、`ThreadLocal`、线程池）的兼容性与边界。

---

## 第 1 章 Java 并发模型的历史困境

### 1.1 线程即资源：OS 线程的代价

Java 的传统线程（`java.lang.Thread`）是对操作系统线程的 1:1 映射。每个 `new Thread()` 背后都是一个 OS 线程：
- 创建代价：约 1-10ms（涉及内核调用、栈内存分配）
- 内存占用：默认栈大小 512KB~1MB（可通过 `-Xss` 调整）
- 系统上限：通常几千到几万（受 `/proc/sys/kernel/threads-max` 和 `ulimit -u` 限制）

对于 CPU 密集型任务，线程数等于 CPU 核心数是最优解，OS 线程是完美的抽象。但对于 IO 密集型任务（如 Web 服务，大多数时间在等待数据库、网络），OS 线程是巨大的浪费：线程大部分时间在阻塞等待，但仍然占用内存和 OS 资源。

### 1.2 解决"IO 等待"的两条路

**路线 1：异步/响应式编程**（Reactive Programming）

Netty、Vert.x、Spring WebFlux 采用少量 IO 线程 + 回调/Future/响应式流的方式，彻底消灭阻塞。IO 线程不阻塞，当数据就绪时通过回调通知。

代价是：编程模型倒置（回调、`CompletableFuture` 链、`Mono`/`Flux`），代码可读性差，调试困难，栈跟踪不完整，无法直接使用 `try-catch`，与现有同步 API（如 JDBC）不兼容，学习曲线极高。

**路线 2：虚拟线程/协程**（Coroutine）

Go 的 goroutine、Kotlin 的 coroutine、Python 的 asyncio 都采用这条路——**用户态的轻量级线程**，由运行时（而不是 OS）调度。当协程阻塞时，运行时自动挂起它并切换到其他协程，不阻塞 OS 线程。

代价几乎没有：**代码仍然用同步风格编写**，不需要回调或链式操作，与现有同步 API 完全兼容。

JDK 21 的虚拟线程，正是 Java 走上了路线 2。

---

## 第 2 章 虚拟线程的基本使用

### 2.1 创建虚拟线程

```java
// 方式 1：Thread.ofVirtual()（JDK 21）
Thread vt = Thread.ofVirtual()
    .name("vt-1")
    .start(() -> {
        System.out.println("虚拟线程运行中: " + Thread.currentThread().isVirtual());
    });

// 方式 2：Thread.startVirtualThread()（最简洁）
Thread vt = Thread.startVirtualThread(() -> doWork());

// 方式 3：通过 ExecutorService（推荐用于管理大量虚拟线程）
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    // 每提交一个任务，创建一个新的虚拟线程（不是线程池！不复用！）
    for (int i = 0; i < 100_000; i++) {
        executor.submit(() -> handleRequest());
    }
}  // try-with-resources 自动调用 shutdown() 并等待所有任务完成
```

**`Executors.newVirtualThreadPerTaskExecutor()`** 是虚拟线程最常用的使用方式：每个任务创建一个新的虚拟线程，任务完成后虚拟线程销毁。由于虚拟线程极其轻量（创建代价微秒级，内存 KB 级），这种"不复用"的策略完全可行，也更简单。

### 2.2 虚拟线程的规模对比

```java
// 用平台线程处理 100,000 个并发请求（会 OOM 或创建失败）
ExecutorService platform = Executors.newFixedThreadPool(100_000);
// 线程数 100,000 × 512KB 栈 ≈ 50GB 内存！完全不可行

// 用虚拟线程处理 100,000 个并发请求（轻松）
ExecutorService virtual = Executors.newVirtualThreadPerTaskExecutor();
// 虚拟线程初始栈极小（按需增长），100,000 个约占用几百 MB，完全正常
```

实际测试中，单 JVM 可以轻松创建并发运行 **100 万个**虚拟线程，每个都在执行独立的 IO 操作（如数据库查询）。这在平台线程时代是不可想象的。

---

## 第 3 章 虚拟线程的底层机制：Continuation

### 3.1 什么是 Continuation

`Continuation`（续体）是虚拟线程实现的核心概念。它代表一个**可以在任意点暂停（yield）并在稍后恢复（resume）的计算过程**。

从程序执行的视角看，当虚拟线程调用一个阻塞操作（如 `socket.read()`）时：
1. JVM 检测到这是一个阻塞调用
2. **保存当前虚拟线程的完整执行状态**（调用栈、局部变量、程序计数器）到 Continuation 对象（存储在堆上！）
3. 释放底层的平台线程（Carrier Thread），让它去执行其他虚拟线程
4. 当 IO 完成、数据就绪时，将 Continuation 重新调度到某个（可能不同的）平台线程上
5. 平台线程**恢复** Continuation，虚拟线程从阻塞点之后继续执行

对于虚拟线程内的代码来说，这一切完全透明——它就像在正常地阻塞等待，从未感知到自己被挂起和迁移过。

### 3.2 Continuation 的堆栈存储

传统 OS 线程的调用栈是预分配在内存特定区域的连续内存块（大小固定，由 `-Xss` 控制）。虚拟线程的 Continuation 将调用栈存储在 **Java 堆**中，按需增长和收缩：

```
OS 线程（平台线程）：
  内核栈（固定大小，一般 4KB）
  用户栈（固定大小，一般 512KB）
  
虚拟线程：
  Continuation 对象（存储在 Java 堆）：
    ┌─────────────────────┐
    │  栈帧 1（方法 A）    │  ← 当前执行位置
    │  栈帧 2（方法 B）    │
    │  栈帧 3（方法 C）    │
    │  局部变量...         │
    └─────────────────────┘
    初始约 300-400 字节（按需增长到 MB 级，但通常远小于 OS 线程栈）
```

这是虚拟线程内存效率远高于 OS 线程的根本原因：Continuation 的栈空间按实际使用动态分配，而 OS 线程的栈空间是预分配的固定大小。

### 3.3 调度器：ForkJoinPool 的角色

虚拟线程由 JVM 内置的调度器管理，底层使用的正是 [[线程池/12 线程池（下）——ForkJoinPool 与工作窃取算法]] 中介绍的 `ForkJoinPool`：

```
虚拟线程调度架构：

┌──────────────────────────────────────────────────────────┐
│                     JVM 调度器                            │
│           (ForkJoinPool，默认并行度 = CPU 核心数)          │
│                                                          │
│   平台线程 T1   平台线程 T2   平台线程 T3   平台线程 T4     │
│   (Carrier)    (Carrier)    (Carrier)    (Carrier)       │
│      ↕               ↕             ↕            ↕        │
│   VT-A 运行    VT-B 运行    VT-C 运行    VT-D 运行        │
│      ↓               ↓             ↓            ↓        │
│   VT-A IO阻塞  → yield → Continuation 存堆                │
│   T1 空闲 → 从调度队列取 VT-E 继续运行                     │
└──────────────────────────────────────────────────────────┘

VT = 虚拟线程，T = 平台线程（Carrier Thread）
调度队列中有数百万个 Continuation 等待被调度
```

每个平台线程（Carrier Thread）是一个 `ForkJoinPool` 的工作线程，它不断从调度队列中取出"就绪的 Continuation"并执行。当虚拟线程阻塞时（yield），平台线程将 Continuation 交还给调度器，然后取下一个就绪的 Continuation。

**平台线程数固定**：虚拟线程的 Carrier Thread 数量等于 `Runtime.getRuntime().availableProcessors()`（即 CPU 核心数），不需要也不应该增加。虚拟线程的调度完全在用户态 JVM 中完成，不需要 OS 参与线程切换，成本极低。

---

## 第 4 章 Pinning——虚拟线程的阻塞陷阱

### 4.1 什么是 Pinning

**Pinning（固定）** 是指虚拟线程无法从 Carrier Thread 上"卸载"（unmount）的状态。当虚拟线程被 pinned 时，它阻塞在 IO 上会**同时阻塞底层的平台线程**，虚拟线程的优势完全消失。

发生 Pinning 的两种情况：

**情况 1：虚拟线程在 `synchronized` 块内阻塞**

```java
// 会导致 Pinning 的代码
synchronized (lock) {
    Thread.sleep(1000);  // 或者任何 IO 操作
    // 在 synchronized 块内阻塞，Carrier Thread 被 pin 住，无法服务其他虚拟线程
}
```

为什么 `synchronized` 会导致 Pinning？

`synchronized` 的底层是 [[volatile与内置锁/04 synchronized 的锁升级——偏向锁、轻量级锁与重量级锁]] 中介绍的 JVM 内置 Monitor。Monitor 的等待集（WaitSet）直接关联到 OS 线程（通过 `pthread_mutex_t`）。当虚拟线程在 `synchronized` 内阻塞时，JVM 无法将这个虚拟线程从其 Carrier Thread 上"卸下"，因为 OS 的 mutex 等待是与 OS 线程绑定的，迁移到另一个平台线程后无法继续持有 mutex。

**情况 2：调用了本地方法（JNI）内的阻塞操作**

JNI 代码在 C/C++ 栈上运行，JVM 无法保存和恢复其栈状态，因此在 JNI 执行期间虚拟线程也会被 pinned。

### 4.2 检测和量化 Pinning

JDK 21 提供了检测 Pinning 的诊断机制：

```bash
# 方式 1：系统属性，当发生 Pinning 时打印线程 dump
-Djdk.tracePinnedThreads=full     # 打印完整栈跟踪
-Djdk.tracePinnedThreads=short    # 只打印简要信息

# 方式 2：JFR 事件
jcmd <pid> JFR.start name=pinning settings=profile duration=60s filename=pinning.jfr
# 分析 jdk.VirtualThreadPinned 事件
```

### 4.3 解决 Pinning 的策略

**策略 1：将 `synchronized` 替换为 `ReentrantLock`**

```java
// 问题代码（会 Pinning）
synchronized (this) {
    result = database.query(sql);  // IO 阻塞在 synchronized 内
}

// 修复（使用 ReentrantLock，虚拟线程可以正常 yield）
private final ReentrantLock lock = new ReentrantLock();

lock.lock();
try {
    result = database.query(sql);  // 阻塞时虚拟线程 yield，Carrier Thread 释放
} finally {
    lock.unlock();
}
```

`ReentrantLock` 基于 AQS，等待时调用 `LockSupport.park()`，JVM 对 `park` 有专门处理——当虚拟线程调用 `park` 时，可以正常 yield（卸载），Carrier Thread 不阻塞。

**策略 2：缩小 `synchronized` 的 IO 代码范围**

```java
// 如果 synchronized 不可替换，把 IO 移到 synchronized 块外面
String data = fetchFromRemote();  // IO 在 synchronized 外面
synchronized (this) {
    cache.put(key, data);  // synchronized 内只做内存操作，不会阻塞
}
```

**策略 3：JDK 版本升级**

JDK 24 计划解决 `synchronized` 导致的 Pinning 问题（JEP 491）——将 `synchronized` 的实现从 OS mutex 迁移到基于 JVM 的轻量级锁，使其支持虚拟线程的 yield。在此之前，需要手动评估和规避。

> [!info] JDK 的进展
> JEP 491（Synchronize Virtual Threads without Pinning）已经在 JDK 24 中实现并集成。升级到 JDK 24+ 后，`synchronized` 块内的 IO 阻塞不再导致 Pinning，虚拟线程与平台线程的兼容性大幅改善。

---

## 第 5 章 虚拟线程与现有代码的兼容性

### 5.1 ThreadLocal 在虚拟线程中的变化

由于虚拟线程极其轻量，可能同时存在数百万个，如果每个虚拟线程都使用大量 `ThreadLocal` 变量，内存占用可能超出预期：

```
100 万虚拟线程 × 每个 ThreadLocal 存储 10KB 数据 = 10GB！
```

JDK 21 引入了 **`ScopedValue`**（作用域值，JEP 446，孵化阶段；JDK 23+ 预览）作为 `ThreadLocal` 的替代品，专为虚拟线程设计：

```java
// ScopedValue：不可变、有作用域边界，比 ThreadLocal 更适合虚拟线程
final static ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

// 绑定值：只在 Runnable 执行期间有效
ScopedValue.where(CURRENT_USER, currentUser)
    .run(() -> {
        processRequest();  // 在此范围内可以访问 CURRENT_USER.get()
    });
// run 返回后，ScopedValue 自动失效，无需 remove()
```

`ScopedValue` 与 `ThreadLocal` 的关键差异：
- **不可变**：绑定后不能修改，天然线程安全，适合"传递只读上下文"
- **有作用域边界**：随 `ScopedValue.where(...).run(...)` 的作用域自动生效和失效，不需要手动 `remove()`
- **内存友好**：不存储在线程的 `ThreadLocalMap` 中，不会随虚拟线程数量线性增长

但 `ScopedValue` 目前仍处于预览阶段，对于生产代码，使用现有 `ThreadLocal` 配合 `remove()` 仍然是推荐方案。

### 5.2 线程池的使用策略变化

**虚拟线程时代，用于 IO 密集型任务的线程池应该被替换为 `newVirtualThreadPerTaskExecutor()`**：

```java
// 旧代码：IO 密集型服务用大线程池
ExecutorService executor = new ThreadPoolExecutor(
    200, 500, 60L, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(1000)
);

// 新代码（JDK 21+）：用虚拟线程，不需要限制数量
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
// 不需要担心创建过多线程——每个虚拟线程约 1KB，100 万个才 1GB
```

**CPU 密集型任务仍应使用平台线程池**：

虚拟线程只是让 IO 等待"不阻塞平台线程"，对于 CPU 密集型计算（不涉及 IO），虚拟线程不能提供额外的并行度——并行度仍然受 Carrier Thread 数量（= CPU 核心数）限制。CPU 密集型任务用 `ForkJoinPool` 或 `ThreadPoolExecutor(coreSize = CPU核心数)` 更合适。

### 5.3 现有框架的适配

**Tomcat / Jetty / Undertow**：JDK 21 发布后，Tomcat 10.1.x+、Jetty 12+、Undertow 2.x+ 都添加了对虚拟线程的支持，配置后可以用虚拟线程处理每个 HTTP 请求：

```xml
<!-- Tomcat 虚拟线程配置 -->
<Connector port="8080" protocol="HTTP/1.1"
           executor="virtualThreadExecutor"/>
<Executor name="virtualThreadExecutor" className="...VirtualThreadExecutor"/>
```

**Spring Boot 3.2+**：只需一行配置，Spring MVC 和 Spring WebFlux 都支持虚拟线程：

```properties
# application.properties（Spring Boot 3.2+）
spring.threads.virtual.enabled=true
```

启用后，每个 HTTP 请求在独立的虚拟线程上处理，同步的 JDBC 调用、`RestTemplate` 调用等不再阻塞平台线程。

**JDBC 驱动**：虚拟线程完全兼容现有 JDBC 驱动（MySQL Connector/J、PostgreSQL JDBC 等），无需修改。原来用于应对数据库等待的大型线程池可以简化为虚拟线程。

---

## 第 6 章 结构化并发——虚拟线程的高级应用

### 6.1 结构化并发的问题背景

`CompletableFuture` 和传统线程池的一个共同问题是：**并发任务的生命周期边界不清晰**——你提交了一个任务，但任务的生命周期与提交者的生命周期是解耦的，任务可能在提交者"逻辑完成"后还在执行，或者提交者已经超时取消但任务还在消耗资源。

**结构化并发（Structured Concurrency）** 的核心思想是：**并发任务的生命周期必须嵌套在其创建者的生命周期内**，就像结构化编程中 `if`/`for`/`try` 代码块嵌套一样。

### 6.2 StructuredTaskScope（JDK 21 预览）

```java
// 结构化并发 API（JEP 453，JDK 21 预览，JDK 23+ 第二次预览）
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    // 在 scope 内并发提交多个子任务（每个在独立虚拟线程上执行）
    StructuredTaskScope.Subtask<User> userTask = 
        scope.fork(() -> userService.findById(userId));
    StructuredTaskScope.Subtask<Order> orderTask = 
        scope.fork(() -> orderService.findByUser(userId));
    
    scope.join();           // 等待所有子任务完成（或其中一个失败）
    scope.throwIfFailed();  // 若有任务失败，抛出异常（同时取消所有其他任务）
    
    // 到达这里，所有任务成功完成
    User user = userTask.get();
    Order order = orderTask.get();
    return buildResponse(user, order);
}
// scope 关闭时（try-with-resources），自动等待所有未完成的子任务，确保无"泄漏"
```

**`ShutdownOnFailure`**：任意子任务失败时，自动取消其他所有子任务——"要么全部成功，要么全部放弃"。

**`ShutdownOnSuccess`**：任意子任务成功时，取消其他子任务并返回第一个成功结果——适合"赛马"模式（多个备选服务，用第一个返回的结果）。

---

## 第 7 章 虚拟线程的性能特性与边界

### 7.1 虚拟线程适合的场景

**IO 密集型服务**（最佳场景）：Web 服务、微服务 API、数据库访问、消息队列消费等。线程大部分时间在等待 IO，虚拟线程允许用极少的 Carrier Thread 承载大量并发请求。

基准数据（参考，具体结果因硬件/JDK版本而异）：
- 传统线程池（200 线程）：最大并发约 200，超出后排队
- 虚拟线程：最大并发轻松超过 10 万，受 IO 资源（如 DB 连接数）限制而非线程数限制

**高并发短任务**：每个请求处理时间短（几毫秒到几百毫秒），需要处理大量并发连接。

### 7.2 虚拟线程不适合的场景

**纯 CPU 密集型计算**：虚拟线程无法提供超过 CPU 核心数的实际并行度。如果任务纯 CPU 密集，用平台线程池（大小 = CPU 核心数）更直接。

**持有 `synchronized` 的长时间 IO 操作**：Pinning 问题尚未完全解决（JDK 21/22/23），需要将 `synchronized` 改为 `ReentrantLock`。JDK 24+ 改善了这一点。

**与依赖 `ThreadLocal` 状态的框架集成**：某些框架依赖 `ThreadLocal` 传递状态（如老版本 Spring Security、某些 ORM 框架），在大量虚拟线程场景下可能有内存压力，需要评估。

### 7.3 虚拟线程对调试和可观测性的影响

**线程 dump 变化**：`jstack` 或 `jcmd Thread.print` 在大量虚拟线程时会输出百万行，工具需要支持虚拟线程过滤。JDK 提供了 `--virtual-threads` 选项来过滤。

**栈跟踪完整性**：虚拟线程在 yield 和 resume 时，栈跟踪是完整的——这是相对于异步回调（栈跟踪断裂，只有当前帧）的显著优势，大大降低了调试难度。

---

## 第 8 章 总结

虚拟线程是 Java 并发史上最重要的变革之一，它让 Java 开发者终于可以用**同步的代码风格，获得接近异步框架的吞吐量**：

**核心机制**：Continuation（续体）将执行状态存储在 Java 堆上，JVM 调度器（基于 ForkJoinPool）在 IO 阻塞时 yield 虚拟线程、释放 Carrier Thread，IO 就绪时 resume——整个过程对应用代码透明。

**Pinning 陷阱**：`synchronized` 块内 IO 阻塞会 pin 住 Carrier Thread（JDK 21-23），解决方案是改用 `ReentrantLock`，或升级到 JDK 24+。

**使用策略**：IO 密集型服务用 `Executors.newVirtualThreadPerTaskExecutor()` 替代大型线程池；CPU 密集型计算仍用平台线程池；`synchronized` 密集的遗留代码需要评估 Pinning 风险。

**生态适配**：Spring Boot 3.2+、Tomcat 10.1+、Quarkus、Micronaut 都已支持虚拟线程。数据库驱动、HTTP 客户端等 IO 组件无需修改，与虚拟线程天然兼容。

下一篇 [[JUC工具/17 实战——高并发场景下的锁优化与无锁编程]] 将把本专栏学到的所有并发知识融合为实战技巧，通过真实的性能问题案例，展示如何系统地分析并发瓶颈、选择正确的优化手段。

---

## 参考文献

1. JEP 444: Virtual Threads (JDK 21, GA), openjdk.org
2. JEP 491: Synchronize Virtual Threads without Pinning (JDK 24), openjdk.org
3. JEP 453: Structured Concurrency (JDK 21 Preview), openjdk.org
4. Ron Pressler, "Loom: Fibers and Continuations for the Java Virtual Machine", blogs.oracle.com
5. Heinz Kabutz, "Virtual Threads in Java 21", javaspecialists.eu
6. Spring Blog, "Spring Boot 3.2 + Virtual Threads", spring.io

---

> [!note] 思考题
> 1. 虚拟线程（Virtual Thread）由 JVM 调度而非操作系统调度——一个平台线程（carrier thread）可以承载成千上万个虚拟线程。当虚拟线程执行阻塞操作（如 `Socket.read()`）时，JVM 会将其从 carrier thread 上'卸载'（unmount），让 carrier thread 执行其他虚拟线程。但 `synchronized` 块中的阻塞操作会'钉住'（pin）carrier thread——为什么？
> 2. 虚拟线程适合 IO 密集型任务——百万级虚拟线程可以同时等待网络响应。但对于 CPU 密集型任务，虚拟线程没有优势——因为 carrier thread 的数量仍然受限于 CPU 核数。在一个混合了 IO 等待和 CPU 计算的应用中，你如何判断虚拟线程是否能带来性能提升？
> 3. 虚拟线程使得'每个请求一个线程'（Thread-per-Request）模式在高并发下可行。这是否意味着 Reactive 编程模型（如 WebFlux、RxJava）不再需要了？虚拟线程的同步编程模型相比 Reactive 的异步链式编程，在可读性和调试性方面有什么优势？在什么场景下 Reactive 仍然优于虚拟线程？
