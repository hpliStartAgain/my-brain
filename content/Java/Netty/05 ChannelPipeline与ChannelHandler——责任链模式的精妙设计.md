---
title: "ChannelPipeline与ChannelHandler——责任链模式的精妙设计"
date: 2026-03-04
tags: [Java, Netty, ChannelPipeline, ChannelHandler, ChannelHandlerContext, 责任链模式, InboundHandler, OutboundHandler, 异常处理, Sharable]
aliases: []
---

# ChannelPipeline与ChannelHandler——责任链模式的精妙设计

## 摘要

`ChannelPipeline` 是 Netty 中数据处理逻辑的"主干道"——每一个到达的字节流、每一条发出的消息，都必须经过 `ChannelPipeline` 中的 Handler 链路处理。它是责任链（Chain of Responsibility）设计模式在网络编程中的极致应用：将解码、业务逻辑、编码、日志、限流等关注点分解为独立的 `ChannelHandler`，通过 Pipeline 将它们串联为一条有序的处理流水线，每个 Handler 只专注于自己的职责，对上下游透明。本文深入剖析 `DefaultChannelPipeline` 的双向链表结构与 `ChannelHandlerContext` 的角色、入站/出站事件的传播方向与截断机制、`@Sharable` 注解的线程安全含义、异常在 Pipeline 中的传播规则，以及几个设计精妙但极易踩坑的细节——包括出站操作从 tail 还是从 ctx 触发的根本差异。

---

## 第 1 章 责任链模式：Pipeline 的设计基础

### 1.1 为什么网络编程需要责任链

在 Netty 之前，很多框架（包括早期的 Mina）的网络处理逻辑是"大杂烩"式的：一个巨大的 Handler 方法里既做协议解析，又做业务逻辑，还做序列化输出。这种设计的问题显而易见：

- **耦合严重**：协议升级、日志逻辑变更、限流策略调整，都需要修改同一个文件，牵一发动全身；
- **不可复用**：HTTP 解码器、TLS 处理器、心跳检测器等通用逻辑无法独立抽取，每个项目都要重复实现；
- **难以测试**：混合了多种关注点的代码单元测试极其困难。

责任链模式（Chain of Responsibility Pattern）是解决这个问题的经典方案：将请求的处理分解为多个独立的 Handler，每个 Handler 只处理自己关注的部分，处理完后决定是否将请求传递给下一个 Handler。

Netty 的 `ChannelPipeline` 将这个模式发挥到了极致：

- **关注点分离**：每个 `ChannelHandler` 只做一件事（解码、鉴权、日志、业务逻辑……）；
- **顺序可配置**：`ChannelHandler` 的插入顺序决定处理顺序，随时可以动态增删；
- **组件可复用**：`HttpServerCodec`、`SslHandler`、`IdleStateHandler` 等都是独立可插拔的组件；
- **双向处理**：入站数据（网络→业务）和出站数据（业务→网络）在同一个 Pipeline 中流动，方向相反，互不干扰。

### 1.2 经典责任链与 Netty Pipeline 的区别

经典责任链模式中，每个 Handler 可以选择：处理并终止（消费请求）、或处理并传递（调用下一个 Handler）。

Netty Pipeline 在此基础上做了一个关键扩展：**双向流动**。入站数据沿一个方向流动（head → tail），出站数据沿相反方向流动（tail → head）。这意味着同一条 Pipeline 既承载了"接收处理链"，又承载了"发送处理链"，两条链共享同一个数据结构（双向链表），但流动方向相反。

这个设计的优雅之处在于：解码器（入站）和编码器（出站）可以配对放置在 Pipeline 中，形成完整的"协议层"。Netty 提供的 `ByteToMessageCodec`（同时处理入站解码和出站编码）就是这种思路的体现。

---

## 第 2 章 DefaultChannelPipeline 的数据结构

### 2.1 双向链表 + ChannelHandlerContext

`DefaultChannelPipeline` 内部是一个双向链表，链表节点是 `ChannelHandlerContext`（简称 ctx），每个 ctx 包装了一个 `ChannelHandler`：

```java
public class DefaultChannelPipeline implements ChannelPipeline {
    // 链表头节点（不是用户添加的，是 Netty 内置的 HeadContext）
    final AbstractChannelHandlerContext head;
    // 链表尾节点（不是用户添加的，是 Netty 内置的 TailContext）
    final AbstractChannelHandlerContext tail;
    
    // 关联的 Channel
    private final Channel channel;
    
    // Handler 名称 → Context 的映射（用于按名称查找）
    private Map<String, AbstractChannelHandlerContext> name2ctx;
    
    DefaultChannelPipeline(Channel channel) {
        this.channel = channel;
        tail = new TailContext(this);
        head = new HeadContext(this);
        head.next = tail;
        tail.prev = head;
    }
}
```

每个 `ChannelHandlerContext` 节点持有：
- 前驱节点 `prev` 和后继节点 `next`（双向链表指针）；
- 关联的 `ChannelHandler`（实际的业务逻辑）；
- 关联的 `ChannelPipeline` 和 `Channel`；
- 执行 Handler 回调的 `EventExecutor`（默认是 Channel 所属的 `EventLoop`，也可以是独立线程池）；
- `executionMask`：标记这个 Handler 实现了哪些方法（用于跳过未实现方法的 Handler，优化传播性能）。

### 2.2 HeadContext 与 TailContext

Netty 在 Pipeline 的两端自动插入了两个特殊节点，理解它们的职责对掌握数据流向至关重要：

**HeadContext**（链表头，最接近网络层）：

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {
    
    private final Unsafe unsafe;
    
    // 作为 OutboundHandler：执行最终的底层 I/O 操作
    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) {
        unsafe.write(msg, promise);  // 真正将数据写入发送缓冲区
    }
    
    @Override
    public void flush(ChannelHandlerContext ctx) {
        unsafe.flush();  // 真正将发送缓冲区数据写入网卡
    }
    
    @Override
    public void bind(ChannelHandlerContext ctx, SocketAddress addr, ChannelPromise promise) {
        unsafe.bind(addr, promise);  // 真正绑定端口
    }
    
    // 作为 InboundHandler：将底层读到的数据传入 Pipeline
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        ctx.fireChannelRead(msg);  // 向后传播入站数据
    }
}
```

`HeadContext` 是整条责任链的"入口兼出口"：
- 入站方向：它是第一个节点，把网络数据"喂给"后续的 Handler；
- 出站方向：它是最后一个节点，负责最终的 I/O 操作（`write()`/`flush()`）。

**TailContext**（链表尾，最接近业务层）：

```java
final class TailContext extends AbstractChannelHandlerContext
        implements ChannelInboundHandler {
    
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        // 消息到达 tail 仍未被处理，打印警告并释放资源
        onUnhandledInboundMessage(ctx, msg);
    }
    
    private void onUnhandledInboundMessage(ChannelHandlerContext ctx, Object msg) {
        try {
            logger.warn(
                "Discarded inbound message {} that reached at the tail of the pipeline. " +
                "Please check your pipeline configuration.", msg);
        } finally {
            ReferenceCountUtil.release(msg);  // 自动释放未被消费的 ByteBuf，防止泄漏
        }
    }
    
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        onUnhandledInboundException(cause);  // 未被处理的异常，打印警告
    }
}
```

`TailContext` 是入站数据的"安全网"：如果某条消息经过所有 Handler 后没有被任何业务 Handler "消费"，`TailContext` 会打印警告并释放 `ByteBuf`，防止内存泄漏和无声的消息丢失。

---

## 第 3 章 入站事件的传播机制

### 3.1 入站事件的流向：从 head 到 tail

入站事件（`ChannelInboundHandler` 的方法）从 `HeadContext` 开始，沿 `next` 方向依次向后传播，直到 `TailContext` 或被某个 Handler 截断。

以 `channelRead` 为例，完整的传播路径：

```
网络层读到数据
    ↓
NioEventLoop.processSelectedKey()
    ↓
AbstractChannel.Unsafe.read()
    ↓
DefaultChannelPipeline.fireChannelRead(byteBuf)  ← 入站事件在此进入 Pipeline
    ↓
HeadContext.channelRead()
    ↓ ctx.fireChannelRead(msg)  ← HeadContext 向后传播
InboundHandler #1.channelRead()  ← 用户 Handler（如解码器）
    ↓ ctx.fireChannelRead(decodedMsg)  ← 如果解码完成，向后传播
InboundHandler #2.channelRead()  ← 用户 Handler（如业务逻辑）
    ↓ 消费消息，不再调用 ctx.fireChannelRead()  ← 截断传播
（TailContext 收不到这条消息，不打印警告）
```

`DefaultChannelPipeline.fireChannelRead(msg)` 的实现：

```java
@Override
public final ChannelPipeline fireChannelRead(Object msg) {
    // 从 head 节点开始传播入站事件
    AbstractChannelHandlerContext.invokeChannelRead(head, msg);
    return this;
}
```

`AbstractChannelHandlerContext.invokeChannelRead()` 负责找到下一个 `InboundHandler` 并调用它的 `channelRead()`：

```java
static void invokeChannelRead(final AbstractChannelHandlerContext next, Object msg) {
    final Object m = next.pipeline.touch(msg, next);
    EventExecutor executor = next.executor();
    
    if (executor.inEventLoop()) {
        // 在 EventLoop 线程：直接调用
        next.invokeChannelRead(m);
    } else {
        // 不在 EventLoop 线程（Handler 被配置了独立线程池）：提交任务
        executor.execute(() -> next.invokeChannelRead(m));
    }
}

private void invokeChannelRead(Object msg) {
    if (invokeHandler()) {
        try {
            // 调用用户 Handler 的 channelRead()
            ((ChannelInboundHandler) handler()).channelRead(this, msg);
        } catch (Throwable t) {
            invokeExceptionCaught(t);
        }
    } else {
        fireChannelRead(msg);  // Handler 未初始化，跳过
    }
}
```

### 3.2 executionMask：跳过未实现方法的优化

前面提到 `ChannelHandlerContext` 有一个 `executionMask` 字段，这是 Netty 的一个精妙性能优化。

考虑一个场景：Pipeline 中有 10 个 Handler，但只有第 1 个和第 10 个实现了 `channelActive()` 方法（其余都是默认实现，直接转发）。如果每次 `channelActive` 事件都要逐个遍历 10 个节点，效率很低。

Netty 通过 `executionMask` 解决这个问题：在 Handler 添加到 Pipeline 时，Netty 通过反射检查该 Handler 类是否重写了各个方法，生成一个位掩码（每种事件对应一个 bit）。传播事件时，跳过 `executionMask` 中对应 bit 为 0（即使用默认实现）的 Handler：

```java
// AbstractChannelHandlerContext.findContextInbound() — 查找下一个实现了特定方法的 InboundHandler
private AbstractChannelHandlerContext findContextInbound(int mask) {
    AbstractChannelHandlerContext ctx = this;
    EventExecutor currentExecutor = executor();
    do {
        ctx = ctx.next;  // 向后找
    } while (skipContext(ctx, currentExecutor, mask, MASK_ONLY_INBOUND));
    // 如果 ctx 的 executionMask 中，mask 对应的 bit 为 0（没实现），跳过继续找
    return ctx;
}
```

这个优化使得事件传播的实际复杂度是 O(k)，其中 k 是实际处理该事件的 Handler 数量（通常远小于 Pipeline 中 Handler 的总数），而非 O(n)。

---

## 第 4 章 出站事件的传播机制

### 4.1 出站事件的流向：从 tail（或 ctx）到 head

出站操作（`write()`、`flush()`、`connect()`、`close()` 等）的传播方向与入站相反：从 tail 方向向 head 方向传播，最终由 `HeadContext` 执行实际的底层 I/O。

```
业务代码：ctx.channel().writeAndFlush(response)
    ↓
DefaultChannelPipeline.writeAndFlush(response)  ← 从 tail 开始
    ↓
TailContext.write()（直接转发）
    ↓ ctx.write(msg, promise)
OutboundHandler #1.write()  ← 如 HttpResponseEncoder（编码器）
    ↓ ctx.write(encodedByteBuf, promise)  ← 将 HttpResponse 编码为 ByteBuf 后继续传播
HeadContext.write()  ← 最终执行底层写
    ↓
AbstractChannel.Unsafe.write(encodedByteBuf, promise)  ← 写入发送缓冲区
```

### 4.2 ctx.write() 与 channel.write() 的根本区别

这是 Netty 开发中最容易混淆、也最容易引发 Bug 的知识点，必须深刻理解：

**`channel.write(msg)` / `ctx.pipeline().write(msg)`**：

从 Pipeline 的 **tail** 开始向 head 方向传播。消息会经过所有 `OutboundHandler`。

**`ctx.write(msg)`**：

从**当前 Handler 的位置**向 head 方向传播，只经过当前 Handler **之前**（更靠近 head 的）的 `OutboundHandler`，**跳过**当前 Handler 之后（更靠近 tail 的）的 Handler。

一个具体场景说明其差异：

```
Pipeline 结构（从 head 到 tail）：
Head → SslHandler → HttpEncoder → TrafficMonitorHandler → MyBusinessHandler → Tail

假设 MyBusinessHandler 要发送 HttpResponse：
```

```java
// 方式一：ctx.writeAndFlush(response)
// 路径：MyBusinessHandler → HttpEncoder → SslHandler → Head → 网络
// 经过：HttpEncoder（编码）、SslHandler（加密）✓ 正确

// 方式二：ctx.channel().writeAndFlush(response)
// 路径：Tail → TrafficMonitorHandler → HttpEncoder → SslHandler → Head → 网络
// 经过：TrafficMonitorHandler（流量统计）、HttpEncoder（编码）、SslHandler（加密）
// 如果 TrafficMonitorHandler 是 OutboundHandler，方式二会额外经过它
```

**结论：大多数情况下，在 Handler 内部应使用 `ctx.writeAndFlush()`，而非 `ctx.channel().writeAndFlush()`**，因为：
1. `ctx.write()` 效率更高（跳过了 tail 到当前位置之间的出站 Handler，减少传播路径）；
2. 避免意外地重复经过某些出站 Handler（如流量统计器可能被计数两次）。

> [!warning] 出站操作起点的选择规则
> - **在业务 Handler 内发送响应**：用 `ctx.writeAndFlush()`（从当前位置向前传播，经过编码器、SSL 等）；
> - **在 Pipeline 外部（如定时任务）发送消息**：用 `channel.writeAndFlush()`（从 tail 开始，经过所有出站 Handler）；
> - **在某个 Handler 中需要绕过部分 Handler 直接发送**：用 `ctx.pipeline().context(HandlerClass.class).writeAndFlush()`（指定起始位置）。

---

## 第 5 章 ChannelHandler 的生命周期

### 5.1 Handler 的添加与移除事件

`ChannelHandler` 被添加到 Pipeline 或从 Pipeline 中移除时，会触发特定的回调方法：

```java
public interface ChannelHandler {
    // Handler 被添加到 Pipeline 时调用
    void handlerAdded(ChannelHandlerContext ctx) throws Exception;
    
    // Handler 从 Pipeline 中移除时调用
    void handlerRemoved(ChannelHandlerContext ctx) throws Exception;
    
    // （已废弃）发生异常时调用
    @Deprecated
    void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) throws Exception;
}
```

`handlerAdded()` 常用于初始化 Handler 状态（如分配资源），`handlerRemoved()` 用于清理资源（如关闭文件句柄）。

### 5.2 @Sharable：Handler 的线程安全声明

Netty 的 `ChannelHandler` 默认**不是共享的**：同一个 Handler 实例只能绑定到一个 Channel 的 Pipeline 上。如果将同一个 Handler 实例添加到多个 Pipeline（如 `ChannelInitializer` 里不慎使用了单例 Handler），Netty 会抛出 `ChannelPipelineException`：

```java
// 错误：Handler 不是 @Sharable 但被重用
public class BadPractice {
    private final MyBusinessHandler handler = new MyBusinessHandler();  // 单例
    
    public void initChannel(SocketChannel ch) {
        ch.pipeline().addLast(handler);  // 第二次 addLast 同一个实例会报错！
        // ChannelPipelineException: MyBusinessHandler is not a @Sharable handler
    }
}
```

**为什么默认不允许共享？**

因为 `ChannelHandler` 通常持有与某个连接相关的状态（如协议解析的中间状态、连接级别的计数器），如果多个连接共享同一个 Handler 实例，这些状态会被不同连接的数据混淆，引发数据竞争。

如果 `ChannelHandler` 是**无状态的**（不持有任何连接级别的实例变量），可以用 `@Sharable` 注解声明它是线程安全的，允许被多个 Channel 的 Pipeline 共享：

```java
// 正确：无状态的 Handler，可以安全共享
@ChannelHandler.Sharable  // 声明：这个 Handler 是线程安全的，可以被多个 Pipeline 共用
public class StatelessLoggingHandler extends ChannelInboundHandlerAdapter {
    private static final Logger logger = LoggerFactory.getLogger(StatelessLoggingHandler.class);
    
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        // 只使用传入的参数，不访问实例变量
        logger.info("Received: {}", msg);
        ctx.fireChannelRead(msg);  // 往下传
    }
}

// 在 ChannelInitializer 中安全地共享：
private static final StatelessLoggingHandler LOGGING_HANDLER = new StatelessLoggingHandler();

ch.pipeline().addLast(LOGGING_HANDLER);  // 所有连接共享同一个实例，节省对象创建开销
```

> [!info] @Sharable 的正确使用条件
> 标注 `@Sharable` 意味着你向 Netty 承诺这个 Handler 是线程安全的。满足以下条件才可以标注：
> 1. Handler 没有任何实例变量（纯无状态）；
> 2. 或者所有实例变量都是线程安全的（如 `AtomicLong`、`ConcurrentHashMap`）；
> 3. 或者实例变量是不可变对象（`final` 且不可修改）。
>
> 如果 Handler 有连接级别的状态（如协议解析缓冲区、登录状态标记），绝对不能标注 `@Sharable`，必须为每个连接创建独立的 Handler 实例。

---

## 第 6 章 异常的传播机制

### 6.1 入站异常的传播

当 `ChannelHandler` 在处理入站事件时抛出异常，`invokeChannelRead()` 会捕获它并调用 `invokeExceptionCaught()`，将异常作为入站事件向后传播：

```java
// 异常传播的入口
private void invokeChannelRead(Object msg) {
    try {
        ((ChannelInboundHandler) handler()).channelRead(this, msg);
    } catch (Throwable t) {
        // 将异常转变为 exceptionCaught 事件向后传播
        invokeExceptionCaught(t);
    }
}
```

**异常向后传播**（从抛出异常的 Handler 位置向 tail 方向）：

```
InboundHandler #1.channelRead() 抛出异常
    ↓ invokeExceptionCaught()
InboundHandler #2.exceptionCaught()  ← 如果实现了此方法，在这里处理
    ↓ 如果没处理（或调用 ctx.fireExceptionCaught()），继续往后
InboundHandler #3.exceptionCaught()
    ↓
TailContext.exceptionCaught()  ← 未处理的异常到达这里，打印警告
```

**最佳实践**：在 Pipeline 的最后（靠近 tail 的位置）添加一个统一的异常处理 Handler，捕获并处理所有未被上游处理的异常：

```java
// 统一异常处理器（放在 Pipeline 末尾）
public class GlobalExceptionHandler extends ChannelInboundHandlerAdapter {
    private static final Logger logger = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        if (cause instanceof IOException) {
            // TCP 连接异常（如客户端强制断开），正常关闭，不打印堆栈
            logger.warn("Connection reset: {}", ctx.channel().remoteAddress());
        } else {
            // 业务异常，打印完整堆栈
            logger.error("Unexpected exception from channel: {}", ctx.channel(), cause);
            // 发送错误响应
            ctx.writeAndFlush(buildErrorResponse(cause))
               .addListener(ChannelFutureListener.CLOSE);  // 发送完后关闭连接
        }
    }
}

// 初始化 Pipeline 时加在最后
pipeline.addLast(new HttpServerCodec());
pipeline.addLast(new HttpObjectAggregator(65536));
pipeline.addLast(new MyBusinessHandler());
pipeline.addLast(new GlobalExceptionHandler());  // 最后一个，兜底处理所有异常
```

### 6.2 出站异常的处理

出站操作（`write()`、`connect()` 等）的异常通过 `ChannelPromise` 通知调用者，而非通过 `exceptionCaught()` 传播：

```java
ChannelFuture future = ctx.writeAndFlush(response);
future.addListener(f -> {
    if (!f.isSuccess()) {
        // 写操作失败（如连接断开）
        Throwable cause = f.cause();
        logger.error("Write failed: {}", cause.getMessage());
        ctx.close();
    }
});
```

如果出站 Handler 的 `write()` 方法中抛出未捕获的异常，Netty 会通过 `ChannelPromise.setFailure(cause)` 通知调用者，调用者通过 `ChannelFuture.addListener()` 处理。

---

## 第 7 章 动态修改 Pipeline

### 7.1 运行时增删 Handler

`ChannelPipeline` 支持在运行时动态添加、移除、替换 Handler，这个能力在某些场景下非常强大：

**场景一：HTTP 升级 WebSocket**

WebSocket 握手是通过一个特殊的 HTTP 请求（Upgrade 请求）完成的。在握手成功之前，Pipeline 需要包含 HTTP 编解码器；握手成功之后，Pipeline 需要切换为 WebSocket 编解码器：

```java
// WebSocket 握手成功后，动态替换 Pipeline
public class WebSocketUpgradeHandler extends SimpleChannelInboundHandler<FullHttpRequest> {
    private final WebSocketServerHandshakerFactory wsFactory;
    
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (WebSocketServerHandshakerFactory.isUpgradeRequest(request)) {
            WebSocketServerHandshaker handshaker = wsFactory.newHandshaker(request);
            handshaker.handshake(ctx.channel(), request).addListener(f -> {
                if (f.isSuccess()) {
                    // 握手成功：重构 Pipeline
                    ChannelPipeline pipeline = ctx.pipeline();
                    // 移除 HTTP 相关 Handler
                    pipeline.remove(HttpObjectAggregator.class);
                    pipeline.remove(HttpServerCodec.class);
                    pipeline.remove(this);  // 移除自己（升级 Handler 完成使命）
                    // 添加 WebSocket 处理 Handler
                    pipeline.addLast(new WebSocketFrameHandler());
                }
            });
        } else {
            // 不是 WebSocket 请求，转发给后续 HTTP Handler
            ctx.fireChannelRead(request.retain());
        }
    }
}
```

**场景二：SSL/TLS 握手完成后的 Pipeline 重配置**

`SslHandler` 在 TLS 握手完成后会触发 `SslHandshakeCompletionEvent`，可以在这个事件中检查客户端证书，决定是否允许连接：

```java
// 监听 SSL 握手完成事件
@Override
public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
    if (evt instanceof SslHandshakeCompletionEvent) {
        SslHandshakeCompletionEvent event = (SslHandshakeCompletionEvent) evt;
        if (event.isSuccess()) {
            // TLS 握手成功：添加应用层协议处理器
            ctx.pipeline().addLast(new HttpServerCodec());
            ctx.pipeline().addLast(new MyBusinessHandler());
            ctx.pipeline().remove(this);  // 移除自己
        } else {
            // TLS 握手失败：关闭连接
            ctx.close();
        }
    } else {
        ctx.fireUserEventTriggered(evt);
    }
}
```

### 7.2 Pipeline 修改的线程安全性

`ChannelPipeline` 的 `addLast()`、`remove()`、`replace()` 等修改操作是线程安全的（Netty 内部保证了并发修改的安全性）。但修改操作必须注意执行顺序：如果在 `EventLoop` 线程之外修改 Pipeline，Netty 会将修改操作封装为任务提交到 `EventLoop` 异步执行，这意味着修改可能不是立即生效的。

在 `EventLoop` 线程内（如在 Handler 回调中）修改 Pipeline 是同步的，立即生效。

---

## 总结

`ChannelPipeline` 是 Netty 责任链模式的精妙实现，核心设计点总结如下：

- **双向链表结构**：`HeadContext` → 用户 Handler 链 → `TailContext`，入站数据从 head 流向 tail，出站数据从 tail 流向 head；

- **`HeadContext` 是 I/O 的执行者**：出站操作的最终执行者（`unsafe.write()`/`unsafe.flush()`），同时也是入站数据的起点；**`TailContext` 是入站的安全网**：释放未消费的 `ByteBuf`，打印未处理消息的警告；

- **`executionMask` 优化传播路径**：通过位掩码跳过未实现特定方法的 Handler，将事件传播的复杂度从 O(n) 降为 O(k)（k 为实际处理该事件的 Handler 数量）；

- **`ctx.write()` vs `channel.write()` 的本质区别**：`ctx.write()` 从当前位置向 head 传播（跳过当前位置 tail 侧的 Handler），`channel.write()` 从 tail 开始传播（经过所有出站 Handler）；**在 Handler 内部发送数据，应优先使用 `ctx.writeAndFlush()`**；

- **`@Sharable` 是线程安全承诺**：无状态 Handler 可以标注，节省对象创建开销；有连接级别状态的 Handler 必须为每个 Channel 创建独立实例；

- **异常统一处理**：在 Pipeline 末尾添加 `ChannelInboundHandlerAdapter.exceptionCaught()` 实现，作为所有入站异常的兜底处理；出站异常通过 `ChannelFuture.addListener()` 处理，不走 `exceptionCaught()` 路径；

- **动态 Pipeline 支持运行时协议切换**：如 HTTP → WebSocket 升级、TLS 握手后重配置，是构建多协议服务器的关键能力。

下一篇深入 Netty 的编解码器体系——TCP 粘包/拆包是网络编程的根本难题，`ByteToMessageDecoder`、`LengthFieldBasedFrameDecoder` 如何彻底解决它：[[06 编解码器——LengthFieldBasedFrameDecoder与自定义协议]]。

---

> [!note] 参考资料
> - `io.netty.channel.DefaultChannelPipeline` 源码
> - `io.netty.channel.AbstractChannelHandlerContext` 源码
> - `io.netty.channel.ChannelHandlerContext` 接口源码
> - Norman Maurer,《Netty in Action》第 6 章 ChannelHandler 与 ChannelPipeline
