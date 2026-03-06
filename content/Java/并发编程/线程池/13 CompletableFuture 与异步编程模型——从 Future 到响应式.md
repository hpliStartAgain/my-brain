---
title: "CompletableFuture 与异步编程模型——从 Future 到响应式"
date: 2026-03-05
tags: [Java, 并发编程, CompletableFuture, Future, 异步编程, 回调地狱, thenApply, thenCompose, allOf, anyOf, 异常处理, 响应式]
aliases: []
---

# 13 CompletableFuture 与异步编程模型——从 Future 到响应式

**摘要：**

`Future<V>` 是 JDK 5 引入的异步计算抽象，但它有一个致命缺陷：`get()` 会阻塞调用线程，无法真正实现"提交后不管，结果就绪时通知我"的非阻塞语义。JDK 8 的 **`CompletableFuture`** 彻底改变了这一局面：它实现了 `CompletionStage` 接口，提供了超过 50 个方法用于链式组合异步操作，支持非阻塞回调（`thenApply`、`thenAccept`、`thenRun`）、异步流水线（`thenCompose`）、多任务聚合（`allOf`、`anyOf`）和异常处理（`exceptionally`、`handle`）。本文从 `Future` 的局限出发，深入剖析 `CompletableFuture` 的内部状态机（`result` 字段的多态编码）、任务链的回调传递机制（`Completion` 链表）、线程调度策略（`thenApply` vs `thenApplyAsync` 的执行线程差异），以及生产中最容易犯的陷阱——在异步链中错误地共享 `ThreadLocal` 和混用阻塞操作。

---

## 第 1 章 Future 的局限性

### 1.1 Future 接口的基本使用

JDK 5 引入的 `Future<V>` 代表一个异步计算的结果：

```java
ExecutorService executor = Executors.newFixedThreadPool(4);

// 提交异步任务，立即返回 Future
Future<String> future = executor.submit(() -> {
    Thread.sleep(1000);  // 模拟耗时操作
    return "result";
});

// 做一些其他事情...
doOtherWork();

// 获取结果（阻塞直到结果就绪）
String result = future.get();  // 阻塞！
```

`Future` 的接口非常简单：

```java
public interface Future<V> {
    boolean cancel(boolean mayInterruptIfRunning);
    boolean isCancelled();
    boolean isDone();
    V get() throws InterruptedException, ExecutionException;
    V get(long timeout, TimeUnit unit) throws ...;
}
```

### 1.2 Future 的三大痛点

**痛点 1：`get()` 阻塞，无法真正异步**

`Future.get()` 会阻塞当前线程直到结果就绪。这意味着：如果有 100 个并发请求，每个请求都需要等待一个异步结果，就需要 100 个线程同时阻塞——这与同步代码没有本质区别，完全浪费了异步的价值。

真正的异步应该是："提交任务，注册一个回调，当任务完成时自动调用回调"——调用线程不阻塞，可以继续处理其他事情。

**痛点 2：无法链式组合多个异步操作**

现实中的业务逻辑通常是多个异步操作的串联：

```
查询用户 → 根据用户ID查询订单 → 根据订单查询商品详情 → 组装响应
```

用 `Future` 实现这个流程，代码会变成：

```java
Future<User> userFuture = executor.submit(() -> getUser(userId));
User user = userFuture.get();  // 阻塞

Future<Order> orderFuture = executor.submit(() -> getOrder(user.getId()));
Order order = orderFuture.get();  // 再次阻塞

Future<Product> productFuture = executor.submit(() -> getProduct(order.getProductId()));
Product product = productFuture.get();  // 三次阻塞
```

每一步都阻塞，整个流程退化为串行执行，完全没有异步的意义。

**痛点 3：没有统一的异常处理机制**

`Future.get()` 将任务内部抛出的异常包装成 `ExecutionException`，调用方需要解包处理。在多个 Future 串联的场景中，异常处理代码散落各处，极难维护。

---

## 第 2 章 CompletableFuture 的设计理念

### 2.1 CompletionStage：流水线的每一个阶段

`CompletableFuture<T>` 实现了两个接口：
- `Future<T>`：兼容旧有的 Future 使用方式
- `CompletionStage<T>`：声明了链式异步编程的完整 API

`CompletionStage` 的设计理念来自**数据流（Dataflow）编程**：每个异步操作是流水线上的一个阶段（Stage），一个阶段完成后，它的结果自动触发下一个阶段的执行，不需要调用方轮询或阻塞等待。

```
Stage 1          Stage 2          Stage 3          Stage 4
getUser()  →  getOrder(user)  →  getProduct()  →  buildResponse()
[异步执行]     [user就绪后触发]  [order就绪后触发]  [product就绪后触发]

主线程提交 Stage 1 后直接返回，每个 Stage 的回调在对应 Stage 的执行线程上触发
```

### 2.2 创建 CompletableFuture 的几种方式

```java
// 方式 1：手动创建，手动完成（最灵活）
CompletableFuture<String> cf = new CompletableFuture<>();
// 在某个地方调用 cf.complete("result") 或 cf.completeExceptionally(ex)

// 方式 2：supplyAsync——有返回值的异步任务
CompletableFuture<String> cf = CompletableFuture.supplyAsync(
    () -> fetchData(),   // 任务
    executor             // 指定线程池（不指定则用 commonPool）
);

// 方式 3：runAsync——无返回值的异步任务
CompletableFuture<Void> cf = CompletableFuture.runAsync(
    () -> sendNotification(),
    executor
);

// 方式 4：completedFuture——已完成的 CompletableFuture（测试/短路常用）
CompletableFuture<String> cf = CompletableFuture.completedFuture("immediate value");
```

---

## 第 3 章 内部实现：result 字段的多态编码

### 3.1 CompletableFuture 的核心状态

`CompletableFuture` 的内部状态只用两个字段表达：

```java
public class CompletableFuture<T> implements Future<T>, CompletionStage<T> {
    
    volatile Object result;       // 结果（null = 未完成，非null = 已完成）
    volatile Completion stack;    // 等待此 CF 完成的回调链表（头节点）
}
```

**`result` 的多态编码**：

```java
// result 的可能值：
// null              → CompletableFuture 还未完成
// new AltResult(null) → 完成，结果是 null（包装以区分"未完成"）
// AltResult(ex)      → 异常完成，ex 是原因
// T value            → 正常完成，值为 value（非 null 的 T）
```

`AltResult` 是一个包装类：

```java
static final class AltResult {
    final Throwable ex;  // null 表示正常完成但结果是 null；非 null 表示异常完成
    AltResult(Throwable x) { this.ex = x; }
}
```

这个编码的精妙之处：一个 `volatile Object result` 字段通过 CAS（`compareAndSet(null, value)`）完成状态转换，无需额外的状态标志位，也不需要锁。

### 3.2 Completion 链表——回调的存储与触发

每个 `CompletableFuture` 维护一个 `Completion` 链表（`stack` 字段），存储所有等待此 CF 完成后要触发的回调：

```java
abstract static class Completion extends ForkJoinTask<Void>
    implements Runnable, AsynchronousCompletionTask {
    volatile Completion next;  // 链表的下一个节点
    
    // 核心方法：尝试触发（返回依赖此 Completion 的下一个 CompletableFuture）
    abstract CompletableFuture<?> tryFire(int mode);
    
    // 当前是否可以被触发（所有前置依赖都满足）
    abstract boolean isLive();
}
```

不同类型的组合操作对应不同的 `Completion` 子类：
- `UniApply`：对应 `thenApply`（一元变换）
- `UniCompose`：对应 `thenCompose`（一元异步链接）
- `BiApply`：对应 `thenCombine`（二元合并）
- `OrApply`：对应 `applyToEither`（二选一）
- `UniAccept`：对应 `thenAccept`（消费，无返回值）
- `UniRun`：对应 `thenRun`（纯副作用，无输入无返回值）

**complete() 的触发流程**：

```java
// 当外部调用 cf.complete(value) 或 supplyAsync 的任务完成时
boolean completeValue(T t) {
    // 1. CAS 将 result 从 null 改为 value（或 NIL）
    return RESULT.compareAndSet(this, null, (t == null) ? NIL : t);
}

final void postComplete() {
    // 2. 遍历 stack 链表，依次触发所有注册的回调
    CompletableFuture<?> f = this;
    Completion h;
    while ((h = f.stack) != null || (f != this && (h = (f = this).stack) != null)) {
        CompletableFuture<?> d;
        Completion t;
        if (STACK.compareAndSet(f, h, t = h.next)) {
            if (t != null) {
                if (f != this) {
                    // 将剩余的回调转移到当前 CF（减少 this 的栈遍历）
                    pushStack(h);
                    continue;
                }
                h.next = null;
            }
            // 3. 触发单个回调（tryFire 返回下一个需要传播的 CF）
            f = (d = h.tryFire(NESTED)) == null ? this : d;
        }
    }
}
```

---

## 第 4 章 链式操作的执行线程模型

### 4.1 thenApply vs thenApplyAsync：关键区别

`CompletableFuture` 中的每个操作都有三个变体：

```java
// 变体 1：同步执行（在"触发"此回调的线程上执行）
CompletableFuture<U> thenApply(Function<? super T, ? extends U> fn)

// 变体 2：异步执行，使用 commonPool（ForkJoinPool）
CompletableFuture<U> thenApplyAsync(Function<? super T, ? extends U> fn)

// 变体 3：异步执行，使用指定 Executor
CompletableFuture<U> thenApplyAsync(Function<? super T, ? extends U> fn, Executor executor)
```

**`thenApply`（无 Async 后缀）的执行线程**：

这是最容易被误解的地方。`thenApply` 的回调在**触发前置 CF 完成的那个线程**上执行。具体来说：
- 如果前置 CF 在线程 A 上完成（`cf.complete(value)`），`thenApply` 的回调在线程 A 上执行
- 如果注册 `thenApply` 时前置 CF 已经完成，回调在**注册线程**（调用 `thenApply` 的线程）上立即执行

```java
// 示例：理解 thenApply 的执行线程
CompletableFuture<String> cf = CompletableFuture.supplyAsync(
    () -> {
        System.out.println("supplyAsync: " + Thread.currentThread().getName());
        return "hello";
    },
    executor
);

cf.thenApply(s -> {
    // 如果 cf 还没完成，这个回调在 executor 的线程上执行（与 supplyAsync 同一线程）
    // 如果 cf 已经完成，这个回调在调用 thenApply 的线程上执行
    System.out.println("thenApply: " + Thread.currentThread().getName());
    return s.toUpperCase();
});
```

这个行为的含义：**`thenApply` 不保证在哪个线程上执行**。在高并发下，这可能导致微妙的 Bug，尤其是当回调中使用了 `ThreadLocal`（`ThreadLocal` 值依赖于执行线程）。

**`thenApplyAsync` 的执行线程**：

`thenApplyAsync` 的回调总是被提交到指定的 `Executor`（或 commonPool），在独立的线程上执行，执行线程是确定的（由 `Executor` 管理）。对于生产代码，`thenApplyAsync` 通常是更安全的选择，尤其是当回调中有任何与线程相关的操作时。

> [!warning] 生产避坑
> 在 `CompletableFuture` 的回调链中使用 `ThreadLocal` 是非常危险的。`thenApply` 的执行线程不确定，线程池中的线程可能携带上一个任务遗留的 `ThreadLocal` 值。在异步链中传递上下文（如链路追踪 ID、用户信息），应该通过方法参数显式传递，或使用专为异步场景设计的上下文传播框架（如 Alibaba 的 `TransmittableThreadLocal`）。

---

## 第 5 章 核心操作详解

### 5.1 变换类：thenApply / thenApplyAsync

```java
// thenApply：当前 CF 完成后，用函数变换其结果，返回新 CF
CompletableFuture<Integer> cf = CompletableFuture.supplyAsync(() -> "hello")
    .thenApply(String::length);   // "hello" → 5
    
// 链式：多个 thenApply 串联
CompletableFuture<String> pipeline = CompletableFuture.supplyAsync(() -> userId)
    .thenApplyAsync(id -> userService.findById(id), dbPool)  // 查用户
    .thenApplyAsync(user -> orderService.findByUser(user), dbPool)  // 查订单
    .thenApply(orders -> ResponseBuilder.build(orders));  // 组装响应（CPU操作，不需要异步）
```

### 5.2 异步流水线：thenCompose

`thenApply` 用于将同步函数应用于结果，`thenCompose` 用于将**返回 `CompletableFuture`** 的函数应用于结果（类似 `flatMap`）。这是避免 `CompletableFuture<CompletableFuture<T>>` 嵌套的关键：

```java
// 错误：thenApply 一个返回 CF 的函数，结果是嵌套的 CF
CompletableFuture<CompletableFuture<Order>> wrongResult = 
    getUserAsync(userId)
    .thenApply(user -> getOrderAsync(user.getId()));  // 嵌套！

// 正确：用 thenCompose 展平嵌套
CompletableFuture<Order> correctResult = 
    getUserAsync(userId)
    .thenCompose(user -> getOrderAsync(user.getId()));  // 展平为单层 CF
```

`thenCompose` 等价于函数式编程中的 `flatMap`——对于 `CompletableFuture` 这个"容器"，`thenApply` 是 `map`，`thenCompose` 是 `flatMap`。

```java
// 完整的异步业务流程示例
public CompletableFuture<Response> processOrder(long userId, long productId) {
    return getUserAsync(userId)                          // CF<User>
        .thenComposeAsync(user ->                        // User → CF<Order>
            createOrderAsync(user, productId), orderPool)
        .thenComposeAsync(order ->                       // Order → CF<PayResult>
            payAsync(order), payPool)
        .thenApply(payResult ->                          // PayResult → Response
            Response.success(payResult));
}
```

### 5.3 消费类：thenAccept / thenRun

```java
// thenAccept：消费结果，无返回值（回调是 Consumer）
CompletableFuture<Void> logCf = cf.thenAccept(result -> 
    log.info("任务完成，结果: {}", result));

// thenRun：不关心结果，纯副作用（回调是 Runnable）
CompletableFuture<Void> notifyCf = cf.thenRun(() -> 
    notificationService.sendCompletion());
```

### 5.4 多任务聚合：allOf 和 anyOf

```java
// allOf：等待所有 CF 完成（返回 CF<Void>，不携带结果）
CompletableFuture<User> userCF = getUserAsync(userId);
CompletableFuture<Order> orderCF = getOrderAsync(orderId);
CompletableFuture<Product> productCF = getProductAsync(productId);

CompletableFuture.allOf(userCF, orderCF, productCF)
    .thenApply(v -> {
        // 所有 CF 完成后，通过 join() 获取结果（此时已完成，join() 不会阻塞）
        User user = userCF.join();
        Order order = orderCF.join();
        Product product = productCF.join();
        return buildResponse(user, order, product);
    });

// anyOf：等待任意一个 CF 完成（返回第一个完成的结果，类型是 Object）
CompletableFuture<Object> firstResult = CompletableFuture.anyOf(cf1, cf2, cf3);
```

**allOf 的实现机制**：

`allOf` 内部创建一个 `BiCompletion`（二元完成）的树状结构，每个节点等待其两个子 CF 完成后才完成。对于 N 个 CF，构建一棵高度约 log(N) 的二叉树，避免了 N 个 CF 都依赖同一个计数器的竞争。

**allOf 的陷阱——不传播异常**：

```java
// 陷阱：allOf 本身不会把子 CF 的异常传播出来
CompletableFuture<Void> all = CompletableFuture.allOf(
    CompletableFuture.failedFuture(new RuntimeException("oops")),
    CompletableFuture.completedFuture("ok")
);
all.join();  // 会抛出异常——好，这是预期行为

// 但如果需要获取所有成功结果并处理失败，需要手动处理：
List<CompletableFuture<String>> futures = /* ... */;
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
    .whenComplete((v, ex) -> {
        if (ex != null) {
            // 找出哪些失败了
            futures.stream()
                .filter(CompletableFuture::isCompletedExceptionally)
                .forEach(f -> f.exceptionally(e -> { log.error("失败", e); return null; }));
        } else {
            // 所有成功
            List<String> results = futures.stream()
                .map(CompletableFuture::join)
                .collect(Collectors.toList());
        }
    });
```

---

## 第 6 章 异常处理

### 6.1 异常处理的三种方式

`CompletableFuture` 提供了三种异常处理方法，语义各不相同：

**`exceptionally(fn)`**：仅在异常时触发，提供默认值（类比 try-catch）：

```java
CompletableFuture<String> cf = fetchDataAsync()
    .exceptionally(ex -> {
        log.error("获取数据失败", ex);
        return "default_value";  // 提供默认值，后续链路继续正常执行
    });
```

**`handle(fn)`**：无论成功还是失败都触发，可以同时处理正常结果和异常（类比 try-catch-finally）：

```java
CompletableFuture<Response> cf = fetchDataAsync()
    .handle((result, ex) -> {
        if (ex != null) {
            return Response.error(ex.getMessage());
        }
        return Response.success(result);
    });
```

**`whenComplete(action)`**：无论成功还是失败都触发，不改变结果（纯副作用，类比 finally）：

```java
CompletableFuture<String> cf = fetchDataAsync()
    .whenComplete((result, ex) -> {
        // 记录日志，不改变 cf 的结果
        log.info("完成，结果: {}, 异常: {}", result, ex);
    });
// cf 的类型仍是 CF<String>，结果不变
```

### 6.2 异常在链路中的传播

异常在 `CompletableFuture` 链中会自动向下传播，跳过中间的 `thenApply`/`thenCompose` 节点（它们不处理异常），直到遇到 `exceptionally` 或 `handle`：

```java
CompletableFuture<String> result = CompletableFuture.supplyAsync(() -> {
        throw new RuntimeException("step1 failed");
    })
    .thenApply(s -> s + " step2")     // 被跳过（上游异常）
    .thenApply(s -> s + " step3")     // 被跳过（上游异常）
    .exceptionally(ex -> "recovered") // 捕获异常，返回默认值
    .thenApply(s -> s + " step4");    // 正常执行：recovered step4

result.join();  // "recovered step4"
```

这与 Java 的 `Optional` 链、响应式编程中的 `onError` 机制高度相似——错误在流水线中被"携带"，直到有处理者接收。

---

## 第 7 章 生产中的常见陷阱

### 7.1 在回调中调用阻塞操作

```java
// 错误：在 common pool 的线程上执行阻塞的 IO
CompletableFuture.supplyAsync(() -> userId)
    .thenApply(id -> jdbcTemplate.queryForObject(  // 阻塞 IO！
        "SELECT * FROM users WHERE id = ?", id));   // 这会阻塞 common pool 的线程

// 正确：用 thenApplyAsync + 专用 IO 线程池
CompletableFuture.supplyAsync(() -> userId)
    .thenApplyAsync(id -> jdbcTemplate.queryForObject(
        "SELECT * FROM users WHERE id = ?", id), dbPool);  // 在 dbPool 中执行阻塞操作
```

**原则**：CPU 密集型操作可以用 `thenApply`（在完成线程上执行）或 commonPool；**IO 密集型（数据库、网络）必须用 `thenApplyAsync` + 专用 IO 线程池**。

### 7.2 忘记处理异常导致静默失败

```java
// 危险：没有异常处理，异常被静默吞掉
CompletableFuture.runAsync(() -> {
    if (someCondition) throw new RuntimeException("oops");
    doWork();
});
// 如果 doWork() 抛异常，整个 CF 处于 exceptionally 完成状态，但没有任何告警

// 正确：至少在顶层处理异常
CompletableFuture.runAsync(() -> doWork())
    .exceptionally(ex -> {
        log.error("异步任务失败", ex);
        return null;
    });
```

### 7.3 join() 代替 get() 并不能避免阻塞

`join()` 是 `CompletableFuture` 提供的非受检异常版 `get()`，底层仍然是阻塞的。在需要真正非阻塞的场景（如 Netty 的 I/O 线程、响应式框架的事件循环线程），调用 `join()` 或 `get()` 一样危险——会阻塞事件循环，导致其他连接无法处理。

```java
// 在响应式框架中（如 Spring WebFlux / Reactor）
// 不要这样做：
Mono<Response> result = Mono.fromCallable(() -> {
    String data = myCompletableFuture.join();  // 阻塞！
    return buildResponse(data);
});

// 应该这样：
Mono<Response> result = Mono.fromFuture(myCompletableFuture)
    .map(data -> buildResponse(data));
```

### 7.4 超时控制

JDK 9 新增了 `orTimeout` 和 `completeOnTimeout`：

```java
// orTimeout：超时后以 TimeoutException 异常完成
CompletableFuture<String> cf = fetchDataAsync()
    .orTimeout(500, TimeUnit.MILLISECONDS);

// completeOnTimeout：超时后以默认值正常完成
CompletableFuture<String> cf = fetchDataAsync()
    .completeOnTimeout("default", 500, TimeUnit.MILLISECONDS);
```

JDK 8 中需要手动实现超时：

```java
// JDK 8 超时实现
ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1);

public static <T> CompletableFuture<T> withTimeout(
        CompletableFuture<T> cf, long timeout, TimeUnit unit) {
    CompletableFuture<T> result = new CompletableFuture<>();
    cf.whenComplete((v, ex) -> {
        if (ex != null) result.completeExceptionally(ex);
        else result.complete(v);
    });
    scheduler.schedule(
        () -> result.completeExceptionally(new TimeoutException()),
        timeout, unit
    );
    return result;
}
```

---

## 第 8 章 CompletableFuture 与响应式编程的关系

### 8.1 从 CompletableFuture 到 Reactor/RxJava

`CompletableFuture` 本质上是一个"单值"的异步容器（`Future<T>` = 0或1个值）。响应式编程框架（Reactor 的 `Mono<T>`/`Flux<T>`，RxJava 的 `Single<T>`/`Observable<T>`）扩展了这个概念到"0~N 个值的异步流"。

| 概念 | `CompletableFuture` | Reactor（Project Reactor） |
| :--- | :--- | :--- |
| 单值异步 | `CompletableFuture<T>` | `Mono<T>` |
| 多值异步流 | ❌ 不支持 | `Flux<T>` |
| 变换 | `thenApply` | `map` |
| 异步链接 | `thenCompose` | `flatMap` |
| 聚合 | `allOf` | `Mono.zip` |
| 异常处理 | `exceptionally` | `onErrorReturn`/`onErrorResume` |
| 背压 | ❌ 不支持 | ✅ 原生支持（Publisher-Subscriber 协议）|
| 调度 | `thenApplyAsync(executor)` | `publishOn(scheduler)` |

`CompletableFuture` 是掌握 `Mono`/`Flux` 等响应式类型的必要基础——两者的设计哲学相同（链式、非阻塞、声明式），响应式框架只是在此基础上增加了流（多值）和背压的支持。

### 8.2 与 Spring WebFlux 的集成

Spring WebFlux 可以直接消费 `CompletableFuture`：

```java
@GetMapping("/user/{id}")
public Mono<User> getUser(@PathVariable Long id) {
    // CompletableFuture 转 Mono
    return Mono.fromFuture(userService.findByIdAsync(id));
}
```

反之，在响应式代码中也可以触发 `CompletableFuture`：

```java
public Mono<String> fetchWithCF() {
    return Mono.fromCompletionStage(
        CompletableFuture.supplyAsync(() -> expensiveCompute())
    );
}
```

---

## 第 9 章 总结

`CompletableFuture` 是 Java 异步编程从"阻塞-等待"模式向"回调-流水线"模式转变的关键里程碑：

**核心机制**：`result` 字段的 CAS 状态转换 + `stack` 上的 `Completion` 链表回调传播——无锁地实现了"完成时触发所有回调"的语义。

**执行线程**：`thenApply`（在前置完成线程上）vs `thenApplyAsync`（在指定 Executor 上）——生产代码中应优先使用 `thenApplyAsync` + 明确指定 Executor，避免执行线程不确定导致的 Bug。

**异常处理**：异常在链路中自动传播，`exceptionally` 捕获恢复，`handle` 统一处理成功和失败，`whenComplete` 纯副作用。

**组合能力**：`thenCompose`（flatMap 避免嵌套）、`allOf`（等所有完成）、`anyOf`（等任意完成）覆盖了绝大多数异步编排场景。

下一篇 [[JUC工具/14 并发工具类——CountDownLatch、CyclicBarrier、Semaphore 与 Exchanger]] 将回到 AQS 的具体应用，深入剖析 JUC 的四大并发协调工具，理解它们的使用场景差异与内部实现。

---

## 参考文献

1. JDK 8 `CompletableFuture` 源码：`java.util.concurrent.CompletableFuture`
2. Goetz et al., "Java Concurrency in Practice", Appendix: Annotation Types
3. Lea, Doug, "Scalable IO in Java", 2002
4. Project Reactor 文档, "Which operator do I need?", projectreactor.io
5. JEP 266: More Concurrency Updates — `orTimeout`, `completeOnTimeout`

---

> [!note] 思考题
> 1. `CompletableFuture.thenApply()` 在哪个线程上执行？如果上一步的 Future 已经完成，`thenApply` 可能在调用线程上同步执行；如果未完成，在完成 Future 的线程上执行。`thenApplyAsync()` 保证在线程池中执行。在什么场景下不使用 `Async` 版本会导致性能问题（提示：如果回调函数执行很慢且在 Netty 的 EventLoop 线程上执行）？
> 2. `CompletableFuture.allOf(cf1, cf2, cf3)` 等待所有 Future 完成。但 `allOf` 的返回类型是 `CompletableFuture<Void>`——你无法直接获取各个 Future 的结果。你如何优雅地获取所有 Future 的结果并组合？`allOf` 后再逐个 `cf.join()` 是否是最佳实践？
> 3. `CompletableFuture` 的异常处理链：`exceptionally()` 处理异常并返回默认值，`handle()` 同时处理正常结果和异常。如果链路中有多个 `thenApply`，中间某一步抛出异常——后续的 `thenApply` 会被跳过直到遇到 `exceptionally` 或 `handle`。这种行为与 try-catch 的异常传播有什么异同？在异常链路上 `thenCompose` 和 `thenApply` 的行为有区别吗？
