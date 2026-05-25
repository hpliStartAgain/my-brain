---
title: "EventLoop与线程模型——Reactor模式的落地实现"
date: 2026-03-04
tags: [ChannelFuture, EventLoop, Java, Netty, NioEventLoop, Promise, Reactor, 任务队列, 无锁化, 线程模型]
aliases: []
---

# EventLoop与线程模型——Reactor模式的落地实现

## 摘要

`EventLoop` 是 Netty 线程模型的核心，也是其高性能的根本来源。Netty 做出了一个大胆的设计决定：**一个 Channel 的整个生命周期，所有 I/O 操作和事件处理，都绑定在同一个 `EventLoop` 线程中执行，不切换线程**。这个"单线程化"的设计彻底消除了 Channel 操作的锁竞争——不需要 `synchronized`，不需要 `ConcurrentHashMap`，数据天然线程安全。本文深入剖析这个设计的完整实现：`EventLoop` 如何判断当前是否在正确的线程中执行、外部线程如何向 `EventLoop` 提交任务而不破坏线程安全、任务队列的提交与执行机制、`ChannelFuture` 与 `Promise` 如何实现异步操作的结果通知，以及 `EventLoop` 线程模型在实际开发中最容易踩的坑——在 Handler 中执行阻塞操作。

---

## 第 1 章 为什么 Netty 选择单线程化 Channel 操作

### 1.1 多线程并发访问 Channel 的代价

假设不采用单线程化设计，允许多个线程并发操作同一个 Channel。那么会发生什么？

考虑一个简单的场景：连接建立后，定时任务线程要发送心跳包，同时业务线程也在发送响应数据：

```java
// 不安全的并发写（假设 Netty 不是单线程模型）
// 定时器线程
channel.writeAndFlush(heartbeatMsg);

// 业务线程
channel.writeAndFlush(responseMsg);
```

在 NIO 的 `SocketChannel` 层面，写操作涉及：
1. 将数据放入发送缓冲区；
2. 注册/更新 `OP_WRITE` 事件到 Selector；
3. `Selector.select()` 检测发送缓冲区可写时，将数据写入内核 TCP 发送缓冲区；
4. 调用 `flush()`，触发 `channel.unsafe.flush0()`。

如果两个线程并发操作，步骤 1、2 需要加锁保护，步骤 3、4 涉及 Selector 的并发修改（`register`/`interestOps` 方法本身是线程安全的，但效率低）。更糟糕的是，`ChannelPipeline` 中的 Handler 通常假设自己在单线程环境下运行（没有同步），并发访问会导致数据竞争。

这种设计需要大量 `synchronized` 块和 `ConcurrentXxx` 数据结构，极大增加代码复杂度，且频繁加锁/解锁会导致显著的性能下降（上下文切换、缓存失效）。

### 1.2 Netty 的解法：Thread Confinement（线程封闭）

Netty 采用了并发编程中"线程封闭"的经典技术：**将对象的所有访问限制在单一线程中，从而天然保证线程安全**。

核心规则：
> **Channel 注册到哪个 `EventLoop`，这个 Channel 的所有操作（包括 I/O 事件处理、用户 Handler 调用、Channel 写操作）都在那个 `EventLoop` 的线程中执行。**

当外部线程（如定时器线程、业务线程池）想要操作某个 Channel 时，不是直接操作，而是将操作封装成 `Runnable` 任务提交到该 Channel 所属的 `EventLoop` 的任务队列，由 `EventLoop` 线程串行执行。

这个设计的精妙之处在于：
- Channel 相关的所有操作都是串行的（因为都在同一线程执行），天然无并发问题；
- 任务队列本身用 `MPSC`（多生产者单消费者）无锁队列实现，多个外部线程提交任务是高效的；
- 用户 Handler 代码无需加锁，大幅简化了业务开发。

### 1.3 线程模型的判断逻辑

Netty 实现"线程封闭"的关键是 `inEventLoop()` 方法——每次在 `EventLoop` 中执行操作之前，Netty 都会检查当前线程是否就是该 `EventLoop` 的线程：

```java
// AbstractChannel 中的 write 操作（简化）
public ChannelFuture write(Object msg) {
    return pipeline.write(msg);
}

// DefaultChannelPipeline → HeadContext → AbstractChannel.AbstractUnsafe.write()
public final void write(Object msg, ChannelPromise promise) {
    // 关键判断：当前线程是否是 EventLoop 线程？
    if (eventLoop.inEventLoop()) {
        // 是 EventLoop 线程：直接执行
        outboundBuffer.addMessage(msg, size, promise);
    } else {
        // 不是 EventLoop 线程（如业务线程池）：封装成任务提交
        final AbstractWriteTask task = WriteTask.newInstance(this, msg, size, promise);
        if (!safeExecute(task)) {
            // 提交失败（如 EventLoop 已关闭）：立即失败
            task.cancel();
            promise.setFailure(ex);
        }
    }
}
```

`inEventLoop()` 的实现极其简单：

```java
// SingleThreadEventExecutor.inEventLoop()
@Override
public boolean inEventLoop(Thread thread) {
    return thread == this.thread;  // 比较线程引用，O(1) 操作
}
```

这个判断遍布 Netty 的代码库——任何对 Channel 的操作，在执行前都会做这个检查，确保操作始终在正确的线程中执行。

---

## 第 2 章 EventLoop 的任务队列机制

### 2.1 三种类型的任务

`EventLoop` 需要处理三类任务，它们有不同的优先级和存储位置：

**类型一：I/O 事件任务（最高优先级）**

由 `Selector.select()` 返回的就绪事件触发，如 `OP_READ`、`OP_WRITE`、`OP_ACCEPT`、`OP_CONNECT`。这些任务通过 `processSelectedKeys()` 处理，优先于任务队列中的其他任务。

**类型二：普通任务（taskQueue）**

外部线程（或 `EventLoop` 自己）提交的一次性任务，存放在 `taskQueue` 中（`LinkedBlockingQueue` 或 Netty 自定义的 `MpscQueue`，MPSC = Multi-Producer Single-Consumer）。

```java
// 外部线程向某个 Channel 的 EventLoop 提交任务
channel.eventLoop().execute(() -> {
    // 这段代码会在 EventLoop 线程中执行
    channel.writeAndFlush(someMessage);
});
```

**类型三：定时任务（scheduledTaskQueue）**

通过 `schedule()`/`scheduleAtFixedRate()` 提交的延迟或周期性任务，存放在按执行时间排序的优先队列（`PriorityQueue`）中。

```java
// 30 秒后执行心跳检测
channel.eventLoop().schedule(() -> {
    if (channel.isActive()) {
        channel.writeAndFlush(HEARTBEAT_PING);
    }
}, 30, TimeUnit.SECONDS);
```

### 2.2 任务的执行顺序

`NioEventLoop` 的核心循环中，三类任务的执行顺序是固定的：

```
每次 Event Loop 迭代：
1. select()：等待 I/O 事件（阻塞，直到有事件就绪或超时）
2. processSelectedKeys()：处理所有就绪的 I/O 事件
3. runAllTasks(timeoutNanos)：处理任务队列中的任务（含定时任务）
   - 先将到期的定时任务从 scheduledTaskQueue 移入 taskQueue
   - 然后按 FIFO 顺序执行 taskQueue 中的任务
   - 当执行时间超过 timeoutNanos 时停止（保证不无限占用时间）
```

这个顺序意味着：**I/O 事件的处理优先于任务队列中的任务**。如果 I/O 事件很多，任务队列中的任务可能被延迟执行。`ioRatio` 参数就是通过限制 I/O 处理时间来保证任务队列得到及时处理的机制。

### 2.3 MPSC 队列：高效的多生产者单消费者队列

Netty 对任务队列的性能非常敏感——多个外部线程可能同时向同一个 `EventLoop` 提交任务，但只有 `EventLoop` 这一个线程消费任务。这是典型的 MPSC（Multi-Producer Single-Consumer）场景。

Netty 使用 JCTools 库提供的 `MpscArrayQueue`（或 `MpscLinkedQueue`），其特点是：
- **多生产者无锁写入**：通过 CAS（Compare-And-Swap）原语实现多线程并发写入，无 `synchronized`；
- **单消费者无锁读取**：消费者（`EventLoop` 线程）可以无锁地读取任务；
- **高吞吐量**：相比 `LinkedBlockingQueue`（使用 ReentrantLock），性能提升显著（减少了锁竞争和上下文切换）。

这是 Netty 性能优化的一个典型细节：在业务代码中不显眼，但在高并发场景下影响显著。

---

## 第 3 章 EventLoop 的启动过程

### 3.1 懒启动设计

`NioEventLoop` 并不在 `NioEventLoopGroup` 创建时立即启动线程，而是采用懒启动（Lazy Initialization）策略：**当第一个任务被提交到 `EventLoop` 时，才真正创建并启动底层线程**。

```java
// SingleThreadEventExecutor.execute() — 任务提交入口
@Override
public void execute(Runnable task) {
    ObjectUtil.checkNotNull(task, "task");
    execute(task, !(task instanceof LazyRunnable) && wakesUpForTask(task));
}

private void execute(Runnable task, boolean immediate) {
    boolean inEventLoop = inEventLoop();
    addTask(task);  // 将任务加入队列
    
    if (!inEventLoop) {
        // 外部线程提交任务时：尝试启动 EventLoop 线程
        startThread();  // 内部检查：如果线程尚未启动，则启动
        if (isShutdown()) {
            // EventLoop 已关闭，移除任务并拒绝
            boolean reject = false;
            try {
                if (removeTask(task)) {
                    reject = true;
                }
            } catch (UnsupportedOperationException e) {
                // 不支持 removeTask 的队列实现
            }
            if (reject) {
                reject();
            }
        }
    }
    
    if (!addTaskWakesUp && immediate) {
        // 唤醒可能正在 select() 阻塞的 EventLoop 线程
        wakeup(inEventLoop);
    }
}

private void startThread() {
    if (state == ST_NOT_STARTED) {
        // CAS 确保只启动一次
        if (STATE_UPDATER.compareAndSet(this, ST_NOT_STARTED, ST_STARTED)) {
            boolean success = false;
            try {
                doStartThread();  // 真正创建并启动线程
                success = true;
            } finally {
                if (!success) {
                    STATE_UPDATER.compareAndSet(this, ST_STARTED, ST_NOT_STARTED);
                }
            }
        }
    }
}
```

懒启动的好处：如果某个 `EventLoop` 从未被分配任何 Channel（比如 `WorkerGroup` 有 16 个线程，但服务器连接数很少，只用了 4 个），未使用的 `EventLoop` 线程不会被创建，节省资源。

### 3.2 线程的唤醒机制

当 `EventLoop` 线程阻塞在 `Selector.select()` 时，如果有新任务被提交到任务队列，需要唤醒它，让它及时处理新任务（而不是继续等待 I/O 事件）：

```java
// NioEventLoop.wakeup()
@Override
protected void wakeup(boolean inEventLoop) {
    if (!inEventLoop && nextWakeupNanos.getAndSet(AWAKE) != AWAKE) {
        // selector.wakeup() 让 select() 立即返回
        // 注意：wakeup() 是跨线程的，可以从任意线程调用
        selector.wakeup();
    }
}
```

`Selector.wakeup()` 是 Java NIO 提供的线程安全方法，它向 Selector 注入一个"唤醒信号"，使正在阻塞的 `select()` 调用立即返回（返回 0）。这样 `EventLoop` 线程就能立即进入任务处理阶段。

---

## 第 4 章 ChannelFuture 与 Promise：异步操作的结果通知

### 4.1 为什么需要 Future/Promise

Netty 的所有 I/O 操作都是异步的——`channel.write(msg)` 调用之后，数据并不一定已经写入 TCP 发送缓冲区，可能还在 `EventLoop` 的任务队列中等待执行。那么，调用者如何知道操作是否成功完成？

Java 标准库的 `Future<V>` 接口是一种方案，但它只支持阻塞等待（`future.get()` 会阻塞当前线程直到操作完成），这在 `EventLoop` 线程中是致命的——**在 `EventLoop` 线程中调用 `future.get()` 会造成死锁**（`EventLoop` 线程等待操作完成，而操作本身需要 `EventLoop` 线程来执行）。

Netty 引入了自己的 `Future`/`Promise` 体系，核心是**非阻塞的监听器（Listener）回调机制**：

```java
// Netty 异步操作的标准模式
ChannelFuture future = channel.writeAndFlush(message);

// 注册回调监听器（不阻塞）
future.addListener(f -> {
    if (f.isSuccess()) {
        // 写操作成功完成
        System.out.println("Message sent successfully");
    } else {
        // 写操作失败
        Throwable cause = f.cause();
        System.err.println("Failed to send: " + cause.getMessage());
        // 通常需要关闭连接
        channel.close();
    }
});
```

### 4.2 Future 与 Promise 的关系

在 Netty 中，`Future` 和 `Promise` 分别代表异步操作结果的两种视角：

- **`Future`（消费者视角）**：表示一个异步操作的"只读"结果。你可以读取操作状态（成功/失败/未完成）、注册监听器，但不能设置结果；
- **`Promise`（生产者视角）**：`Future` 的子接口，表示一个可写的"结果占位符"。执行操作的代码可以通过 `promise.setSuccess()` 或 `promise.setFailure()` 填写结果，这会触发所有注册在 `Future` 上的监听器。

```java
// Promise 的使用模式（框架内部）
DefaultChannelPromise promise = new DefaultChannelPromise(channel, eventLoop);

// 执行异步操作...
eventLoop.execute(() -> {
    try {
        // 真正的写操作
        doWrite(msg);
        // 成功：通知所有 Listener
        promise.setSuccess();
    } catch (Exception e) {
        // 失败：通知所有 Listener
        promise.setFailure(e);
    }
});

// 调用方收到 promise（作为 ChannelFuture）
ChannelFuture future = promise;
future.addListener(f -> {
    // 在 EventLoop 线程中被调用（异步回调）
    if (f.isSuccess()) { ... }
});
```

### 4.3 监听器的执行线程

这是一个容易踩坑的细节：`ChannelFuture` 的监听器在哪个线程中被调用？

**结论**：监听器在 `Promise.setSuccess()` / `setFailure()` 被调用的那个线程中执行。而 Netty 内部的 I/O 操作通常在 `EventLoop` 线程中完成，因此监听器默认在 `EventLoop` 线程中被调用。

```java
future.addListener(f -> {
    // 这段代码在 EventLoop 线程中执行！
    // 不要在这里做耗时操作（如数据库查询、HTTP 请求）
    // 否则会阻塞 EventLoop，影响所有连接的 I/O 处理
    
    // 正确做法：耗时操作提交给业务线程池
    businessThreadPool.execute(() -> {
        handleResult(f);
    });
});
```

Netty 也提供了 `GenericFutureListener` 的带 executor 版本，允许指定监听器在哪个线程池中执行，但这需要额外封装。

### 4.4 sync() 与 await() 的使用边界

Netty 的 `ChannelFuture` 提供了 `sync()` 和 `await()` 方法，允许阻塞等待操作完成，但两者有重要区别：

```java
// sync()：等待操作完成，如果失败则抛出异常
ChannelFuture f = b.bind(8080).sync();  // 等待端口绑定成功，失败抛异常

// await()：等待操作完成，但不抛异常（需要手动检查 isSuccess()）
ChannelFuture f = channel.writeAndFlush(msg);
f.await();
if (!f.isSuccess()) {
    Throwable cause = f.cause();
    // 处理错误
}
```

> [!warning] 禁止在 EventLoop 线程中调用 sync()/await()
> `sync()` 和 `await()` 都会阻塞当前线程直到操作完成。如果在 `EventLoop` 线程中调用，会造成**死锁**：
> - `EventLoop` 线程等待 `ChannelFuture` 完成；
> - 而 `ChannelFuture` 的完成需要 `EventLoop` 线程来执行操作；
> - 两者互相等待，永远无法完成。
>
> Netty 在 `DefaultPromise.await()` 中做了检测：如果发现当前线程是 `EventLoop` 线程，会直接抛出 `BlockingOperationException`，提醒开发者这是危险操作。
>
> **`sync()`/`await()` 只应该在 EventLoop 外部的线程中调用**（如启动线程、业务线程等）。

---

## 第 5 章 EventLoop 线程模型的最大陷阱

### 5.1 在 Handler 中执行阻塞操作

这是 Netty 开发中最常见也最致命的错误。看这段代码：

```java
// 危险的 Handler 写法（正是生产事故高发区）
public class UserHandler extends SimpleChannelInboundHandler<Request> {
    @Override
    protected void messageReceived(ChannelHandlerContext ctx, Request request) {
        // 错误！直接在 EventLoop 线程中查询数据库
        User user = userRepository.findById(request.getUserId());  // 数据库查询，可能耗时 10ms～500ms
        Response response = buildResponse(user);
        ctx.writeAndFlush(response);
    }
}
```

这段代码的问题：

`messageReceived()` 在 `EventLoop` 线程中执行。`userRepository.findById()` 是一个数据库 I/O 操作，即使最快也需要几毫秒，极端情况下可能需要几秒（数据库高负载、网络延迟）。

在这段时间内，`EventLoop` 线程被完全占用，无法处理其他 Channel 的 I/O 事件。如果这个 `EventLoop` 管理了 1000 个连接，这 1000 个连接的所有事件都被阻塞。

**正确做法：将阻塞操作卸载到业务线程池**：

```java
// 正确的写法：使用独立的业务线程池处理阻塞操作
public class UserHandler extends SimpleChannelInboundHandler<Request> {
    private final ExecutorService businessPool = Executors.newFixedThreadPool(
        Runtime.getRuntime().availableProcessors() * 4);
    
    @Override
    protected void messageReceived(ChannelHandlerContext ctx, Request request) {
        // 将数据库查询提交到业务线程池（立即返回，不阻塞 EventLoop）
        businessPool.submit(() -> {
            try {
                User user = userRepository.findById(request.getUserId());
                Response response = buildResponse(user);
                
                // 将写操作提交回 Channel 所属的 EventLoop 线程执行
                // ctx.writeAndFlush() 内部会检查是否在 EventLoop 线程，
                // 如果不是则自动包装成任务提交
                ctx.writeAndFlush(response);
            } catch (Exception e) {
                ctx.fireExceptionCaught(e);
            }
        });
    }
}
```

Netty 也为这种模式提供了内置支持——在 `ChannelPipeline.addLast()` 时可以指定一个 `EventExecutorGroup`，让该 Handler 的所有回调在这个线程组中执行，而非 `EventLoop` 线程：

```java
// 为特定 Handler 指定独立的业务线程池
EventExecutorGroup businessPool = new DefaultEventExecutorGroup(16);

pipeline.addLast(new HttpServerCodec());           // 在 EventLoop 线程执行（快速）
pipeline.addLast(businessPool, new UserHandler()); // 在 businessPool 线程执行（可以阻塞）
```

这是 Netty 提供的最优雅的解决方案：解码在 `EventLoop` 线程（快速），业务逻辑在独立线程池（允许阻塞），编码写出回到 `EventLoop` 线程（快速）。

### 5.2 识别 EventLoop 线程的工具方法

在实际开发中，有时需要明确判断当前代码运行在哪个线程：

```java
// 判断当前是否在某个 Channel 的 EventLoop 线程中
boolean inEventLoop = channel.eventLoop().inEventLoop();

// 在 Handler 中，通过 ctx 获取
boolean inEventLoop = ctx.channel().eventLoop().inEventLoop();

// 安全地在 EventLoop 中执行任务（无论当前在哪个线程）
channel.eventLoop().execute(() -> {
    // 这段代码一定在 EventLoop 线程执行
});
```

---

## 第 6 章 EventLoop 的优雅关闭

### 6.1 关闭流程

`EventLoopGroup` 的关闭通过 `shutdownGracefully()` 完成，支持指定"静默期"和"最长等待时间"：

```java
// 标准的关闭写法（在 finally 块中）
bossGroup.shutdownGracefully(
    2, TimeUnit.SECONDS,    // quietPeriod：静默期。关闭命令发出后，至少等待 2 秒没有新任务才关闭
    15, TimeUnit.SECONDS    // timeout：最长等待 15 秒，超时强制关闭
);
workerGroup.shutdownGracefully(2, TimeUnit.SECONDS, 15, TimeUnit.SECONDS);
```

关闭流程：
1. 接收到 `shutdownGracefully()` 调用后，`EventLoop` 进入"关闭过渡期"；
2. 拒绝接受新任务（`execute()` 会抛出 `RejectedExecutionException`）；
3. 继续处理任务队列中已积累的任务；
4. 静默期内无新任务提交：关闭 `Selector`，线程退出；
5. 超过最长等待时间：强制关闭（可能有任务被丢弃）。

> [!info] 为什么需要静默期
> 静默期（quietPeriod）是为了防止"关闭竞态"：系统刚发出关闭命令，一些异步操作（如发送最后一条消息、记录关闭日志）还在提交任务。静默期确保这些"收尾任务"有机会完成，而不是被粗暴拒绝。

---

## 第 7 章 EventLoop 线程模型的设计权衡

### 7.1 单线程模型的固有限制

Netty `EventLoop` 单线程模型在带来简洁性和性能的同时，也有固有的限制：

**限制一：单个 EventLoop 的处理能力上限是有限的**

如果一台服务器有 10 万个连接，均匀分配到 16 个 `EventLoop`，每个 `EventLoop` 管理约 6250 个连接。如果某个 `EventLoop` 管理的连接都非常活跃（如 WebSocket 推送），单个线程的 CPU 可能成为瓶颈。

解决方案：适当增加 `WorkerGroup` 的线程数（超过 CPU 核数 × 2），或将计算密集型工作卸载到业务线程池。

**限制二：Channel 一旦绑定 EventLoop，不会迁移**

Netty 不支持将 Channel 从一个 `EventLoop` 迁移到另一个。这意味着负载均衡只能在连接建立时（分配阶段）进行，一旦建立就不能重新平衡。如果某些 Channel 比其他 Channel 活跃得多，可能导致 `EventLoop` 间负载不均。

**限制三：对 GC 的敏感性**

Stop-The-World GC 暂停会同时影响所有 `EventLoop` 线程，导致所有连接在 GC 期间无响应。对延迟敏感的应用需要使用 G1/ZGC/Shenandoah 等低停顿 GC，并合理调整堆大小。

### 7.2 与传统线程池模型的对比

| 对比维度 | Netty EventLoop 模型 | 传统线程池模型（BIO/线程池） |
| --- | --- | --- |
| 线程数量 | 少（CPU 核数 × 2） | 多（连接数或请求数相关）|
| 线程切换 | 极少（Channel 绑定单线程）| 频繁（每次请求可能切换线程）|
| 同步需求 | 极少（单线程内无竞争）| 大量（共享状态需同步）|
| 内存占用 | 低（线程栈总量小）| 高（大量线程栈）|
| 编程复杂度 | 中（需理解 EventLoop 模型）| 低（直观的阻塞式编程）|
| 适用场景 | 高并发、I/O 密集 | 低并发、CPU 密集或阻塞操作多 |

---

## 总结

`EventLoop` 是 Netty 高性能的根本来源，其设计核心是**线程封闭（Thread Confinement）**：

- **一个 Channel 绑定一个 `EventLoop`**，Channel 的所有操作都在这个线程中串行执行，天然无竞争、无锁；

- **`inEventLoop()` 是线程安全的守卫**：任何对 Channel 的操作（写数据、改变状态）都先检查是否在正确的线程，不在则提交到任务队列；

- **三类任务按优先级处理**：I/O 事件（`processSelectedKeys()`）> 普通任务（`taskQueue`）> 定时任务（`scheduledTaskQueue`），`ioRatio` 控制 I/O 与任务的时间分配；

- **`ChannelFuture`/`Promise`** 实现异步操作的非阻塞结果通知，监听器在 `EventLoop` 线程中回调，避免了阻塞等待；禁止在 `EventLoop` 线程中调用 `sync()`/`await()`，否则死锁；

- **Handler 中禁止阻塞操作**是最重要的实践原则：数据库查询、HTTP 调用等阻塞 I/O 必须提交到独立的业务线程池（通过 `pipeline.addLast(executor, handler)` 或手动提交）；

- **MPSC 无锁队列、懒启动线程、`Selector.wakeup()` 唤醒机制**是支撑 `EventLoop` 高效运转的底层细节。

下一篇深入 Netty 的内存管理核心——`ByteBuf`：为什么它比 JDK `ByteBuffer` 更好用、引用计数如何防止内存泄漏、池化内存的 jemalloc 算法：[[04 ByteBuf——引用计数、池化与零拷贝]]。

---

> [!note] 参考资料
> - `io.netty.channel.nio.NioEventLoop` 源码
> - `io.netty.util.concurrent.SingleThreadEventExecutor` 源码
> - `io.netty.util.concurrent.DefaultPromise` 源码
> - JCTools 库 `MpscArrayQueue` 源码
> - Norman Maurer,《Netty in Action》第 7 章 EventLoop 与线程模型

---

> [!note] 思考题
> 1. Netty 的 `CompositeByteBuf` 允许将多个 `ByteBuf` 组合为一个逻辑视图，避免了内存拷贝。在 HTTP 响应中，Header 和 Body 通常是两个独立的 ByteBuf——使用 `CompositeByteBuf` 可以零拷贝地将它们合并为一个完整的响应。但 `CompositeByteBuf` 在什么场景下反而比直接拷贝更慢？
> 2. Netty 的 `ByteBuf` 使用引用计数（Reference Counting）管理生命周期。`retain()` 增加计数，`release()` 减少计数，计数归零时回收内存。如果一个 ChannelHandler 从 `channelRead` 收到 ByteBuf 后既不处理也不传递给下一个 Handler，这个 ByteBuf 的引用计数会怎样？这是 Netty 内存泄漏最常见的原因吗？
> 3. Netty 的池化内存分配器（PooledByteBufAllocator）参考了 jemalloc 的设计——使用 Arena、Chunk、Page 三级结构管理内存。池化分配器在高并发场景下避免了频繁的 `malloc/free` 系统调用。但池化也意味着内存不会立即归还给操作系统——在什么场景下你应该关闭池化（使用 `UnpooledByteBufAllocator`）？
