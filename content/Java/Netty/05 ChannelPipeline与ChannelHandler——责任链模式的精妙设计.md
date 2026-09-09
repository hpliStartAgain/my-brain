---
title: "ChannelPipeline与ChannelHandler——责任链模式的精妙设计"
date: 2026-09-07
tags: [ChannelHandler, ChannelHandlerContext, ChannelPipeline, InboundHandler, Java, Netty, OutboundHandler, Sharable, 责任链模式]
aliases: [ChannelPipeline, ChannelHandler, Netty责任链, Pipeline设计]
---

# ChannelPipeline与ChannelHandler——责任链模式的精妙设计

**摘要：**

`ChannelPipeline` 是 Netty 中数据处理逻辑的"主干道"——每一个到达的字节流、每一条发出的消息，都必须经过 `ChannelPipeline` 中的 Handler 链路处理。它是责任链（Chain of Responsibility）设计模式在网络编程中的极致应用：将解码、业务逻辑、编码、日志、限流等关注点分解为独立的 `ChannelHandler`，通过 Pipeline 将它们串联为一条有序的处理流水线，每个 Handler 只专注于自己的职责，对上下游透明。本文从责任链模式的理论基础出发，深入剖析 `DefaultChannelPipeline` 的双向链表结构与 `ChannelHandlerContext` 的角色、入站和出站事件的传播方向与截断机制、`executionMask` 位掩码对传播路径的优化、`@Sharable` 注解的线程安全含义、异常在 Pipeline 中的传播规则，以及动态修改 Pipeline 支持协议切换的设计。最后讨论 `ctx.write()` 与 `channel.write()` 的根本差异——这个看似细微的区别是 Netty 开发中最容易引发 Bug 的知识点。

---

## 第 1 章 责任链模式：Pipeline 的设计基础

### 1.1 为什么网络编程需要责任链

在 Netty 之前，很多框架（包括早期的 Apache Mina）的网络处理逻辑是"大杂烩"式的：一个巨大的 Handler 方法里既做协议解析，又做业务逻辑，还做序列化输出。这种设计的问题显而易见：协议升级、日志逻辑变更、限流策略调整都需要修改同一个文件，牵一发动全身；HTTP 解码器、TLS 处理器、心跳检测器等通用逻辑无法独立抽取，每个项目都要重复实现；混合了多种关注点的代码单元测试极其困难。

责任链模式（Chain of Responsibility Pattern）是解决这个问题的经典方案。GoF 在 1994 年的《Design Patterns》中正式定义了这个模式：将请求的处理分解为多个独立的 Handler，每个 Handler 只处理自己关注的部分，处理完后决定是否将请求传递给下一个 Handler。这个模式的精髓在于"解耦"——请求的发送者不需要知道哪个 Handler 会处理请求，请求会沿链路自动传播直到被处理。

Netty 的 `ChannelPipeline` 将这个模式发挥到了极致。每个 `ChannelHandler` 只做一件事（解码、鉴权、日志、业务逻辑），Handler 的插入顺序决定处理顺序且随时可以动态增删，`HttpServerCodec`、`SslHandler`、`IdleStateHandler` 等都是独立可插拔的组件，入站数据（网络到业务）和出站数据（业务到网络）在同一个 Pipeline 中流动，方向相反，互不干扰。

### 1.2 经典责任链与 Netty Pipeline 的区别

经典责任链模式中，每个 Handler 可以选择处理并终止（消费请求）或处理并传递（调用下一个 Handler）。Netty Pipeline 在此基础上做了一个关键扩展：**双向流动**。入站数据沿一个方向流动（head 到 tail），出站数据沿相反方向流动（tail 到 head）。这意味着同一条 Pipeline 既承载了"接收处理链"，又承载了"发送处理链"，两条链共享同一个数据结构（双向链表），但流动方向相反。

这个设计的优雅之处在于：解码器（入站）和编码器（出站）可以配对放置在 Pipeline 中，形成完整的"协议层"。Netty 提供的 `ByteToMessageCodec`（同时处理入站解码和出站编码）就是这种思路的体现。在 HTTP 协议处理中，`HttpServerCodec` 内部同时包含 `HttpRequestDecoder`（入站）和 `HttpResponseEncoder`（出站），作为一个整体添加到 Pipeline 中，自动处理 HTTP 协议的编解码——程序员不需要分别添加解码器和编码器，也不需要关心它们在 Pipeline 中的相对位置。

### 1.3 责任链模式的局限性

责任链模式虽然优雅，但也有局限性。第一是"调试困难"——请求在链路中传播时，如果你不知道每个 Handler 的实现，很难追踪请求最终被哪个 Handler 处理。在调试 Netty 应用时，经常需要通过日志或断点逐个 Handler 跟踪，才能定位问题。第二是"性能开销"——即使某个 Handler 不处理特定事件，事件仍需要经过它（虽然 `executionMask` 优化了这一点），在 Handler 数量很多时，传播路径的长度会影响性能。第三是"顺序敏感"——Handler 的添加顺序决定了处理顺序，错误的顺序会导致逻辑错误（譬如把业务 Handler 放在解码器之前，业务 Handler 收到的是原始字节流而非解码后的对象）。

这些局限性是责任链模式的固有代价，Netty 通过 `executionMask` 优化、`@Sharable` 共享、动态 Pipeline 等机制来缓解，但无法完全消除。理解这些局限性，才能在设计中扬长避短——譬如不要在 Pipeline 中放太多 Handler（通常 5-10 个为宜），不要把无关的逻辑混在同一个 Handler 中（保持单一职责），不要依赖 Handler 的隐式顺序（在文档中明确说明 Handler 的添加顺序要求）。

### 1.4 责任链模式的历史脉络

责任链模式的历史可以追溯到 1980 年代。GoF 在 1994 年的《Design Patterns》中将其归类为行为型模式，但它的思想更早出现在 Smalltalk 的 MVC 框架中——事件沿视图层级向上传播直到被处理。Java Servlet 的 Filter Chain 是责任链模式在 Web 领域的典型应用：每个 Filter 检查请求并决定是否传递给下一个 Filter 或直接响应。Spring Interceptor、Apache Commons Chain 也采用了类似的设计。

Netty 的 `ChannelPipeline` 在这些前辈的基础上做了两个关键创新。第一是"双向链"——传统的责任链是单向的（请求从一端进，沿链路传播），Pipeline 是双向的（入站和出站方向相反），这更贴合网络编程中"接收-处理-发送"的对称结构。第二是"类型安全的事件"——传统责任链的 `handle(Request)` 方法接受通用请求类型，Pipeline 的 `channelRead`、`channelActive` 等方法是类型明确的事件，编译期就能检查 Handler 是否处理了正确的事件类型。这两个创新使得 Pipeline 在保持责任链模式解耦优势的同时，更贴合网络编程的实际需求。

从更宏观的视角看，`ChannelPipeline` 是"控制反转"（Inversion of Control）思想在网络编程中的体现。传统模型中，应用程序主动调用"读取-处理-发送"的流程，控制权在应用程序手中。Pipeline 模型中，应用程序只需编写"事件来了做什么"的 Handler，事件的分发、传播、线程管理都由框架处理——控制权从应用程序转移到了框架。这种控制反转让应用程序只需关注业务逻辑，而不需要关心"如何等待事件""如何分发事件""如何保证线程安全"等基础设施问题。Spring 的 IoC 容器在依赖注入领域做了类似的事，Netty 的 Pipeline 在网络编程领域做了类似的事——它们都是"框架接管复杂性，应用程序聚焦业务"的设计哲学的体现。

---

## 第 2 章 DefaultChannelPipeline 的数据结构

### 2.1 双向链表与 ChannelHandlerContext

`DefaultChannelPipeline` 内部是一个双向链表，链表节点是 `ChannelHandlerContext`（简称 ctx），每个 ctx 包装了一个 `ChannelHandler`。Pipeline 在创建时自动插入两个特殊节点——`HeadContext`（链表头）和 `TailContext`（链表尾），用户添加的 Handler 位于两者之间。

```java
public class DefaultChannelPipeline implements ChannelPipeline {
    // 链表头节点（Netty 内置的 HeadContext）
    final AbstractChannelHandlerContext head;
    // 链表尾节点（Netty 内置的 TailContext）
    final AbstractChannelHandlerContext tail;

    private final Channel channel;
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

每个 `ChannelHandlerContext` 节点持有前驱节点 `prev` 和后继节点 `next`（双向链表指针）、关联的 `ChannelHandler`（实际的业务逻辑）、关联的 `ChannelPipeline` 和 `Channel`、执行 Handler 回调的 `EventExecutor`（默认是 Channel 所属的 `EventLoop`，也可以是独立线程池）、`executionMask`（标记这个 Handler 实现了哪些方法，用于跳过未实现方法的 Handler）。

### 2.2 HeadContext 与 TailContext

`HeadContext` 是链表头，最接近网络层，同时实现 `ChannelOutboundHandler` 和 `ChannelInboundHandler` 接口。作为 OutboundHandler，它执行最终的底层 I/O 操作——`write()` 调用 `unsafe.write()` 将数据写入发送缓冲区，`flush()` 调用 `unsafe.flush()` 将发送缓冲区数据写入网卡。作为 InboundHandler，它把网络层读到的数据传入 Pipeline——`channelRead()` 调用 `ctx.fireChannelRead(msg)` 向后传播入站数据。

```java
final class HeadContext extends AbstractChannelHandlerContext
        implements ChannelOutboundHandler, ChannelInboundHandler {

    private final Unsafe unsafe;

    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) {
        unsafe.write(msg, promise);  // 真正将数据写入发送缓冲区
    }

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        ctx.fireChannelRead(msg);  // 向后传播入站数据
    }
}
```

`HeadContext` 是整条责任链的"入口兼出口"：入站方向它是第一个节点，把网络数据"喂给"后续的 Handler；出站方向它是最后一个节点，负责最终的 I/O 操作。这个双重角色是 Pipeline 双向设计的集中体现——同一个节点既处理入站又处理出站，但两个方向的职责完全不同。

`TailContext` 是链表尾，最接近业务层，只实现 `ChannelInboundHandler` 接口。它的核心职责是作为入站数据的"安全网"——如果某条消息经过所有 Handler 后没有被任何业务 Handler 消费，`TailContext` 会打印警告日志并释放 `ByteBuf`，防止内存泄漏和无声的消息丢失。

```java
final class TailContext extends AbstractChannelHandlerContext
        implements ChannelInboundHandler {

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        onUnhandledInboundMessage(ctx, msg);  // 消息到达 tail 仍未被处理
    }

    private void onUnhandledInboundMessage(ChannelHandlerContext ctx, Object msg) {
        try {
            logger.warn("Discarded inbound message {} that reached at the tail of the pipeline.", msg);
        } finally {
            ReferenceCountUtil.release(msg);  // 自动释放未被消费的 ByteBuf
        }
    }
}
```

`TailContext` 的自动释放机制是 `ByteBuf` 内存管理的最后一道防线。如果你在 Pipeline 配置中遗漏了业务 Handler，或者业务 Handler 忘记调用 `fireChannelRead` 导致消息"断流"，`TailContext` 会确保 `ByteBuf` 被释放而非泄漏。但这条防线不应该被依赖——它打印的警告日志意味着你的 Pipeline 配置有问题，应该修复而非忽视。

### 2.3 Pipeline 的内存模型

`DefaultChannelPipeline` 的双向链表节点（`ChannelHandlerContext`）是在堆上分配的 Java 对象，每个节点持有前驱和后继指针、Handler 引用、EventExecutor 引用等。在一个有 10 个 Handler 的 Pipeline 中，节点对象本身占用的内存约为 10 * 100 字节 = 1KB，相对于 Channel 的网络缓冲区可以忽略。但在连接数极多的服务器上（如十万连接），Pipeline 节点的总内存为 100KB * 10 = 1MB，仍然不是大开销。

真正需要关注的是 Handler 持有的状态内存。解码器（如 `ByteToMessageDecoder`）的累积缓冲区会随数据量增长，如果连接空闲但缓冲区未清理，会浪费内存。`IdleStateHandler` 在连接空闲时会触发事件，但不会自动清理缓冲区——你需要在自己的 Handler 中响应空闲事件并释放资源。理解 Pipeline 的内存模型，有助于在连接数极多的场景下优化内存使用——譬如为低频连接配置更小的初始缓冲区，或在空闲时清理 Handler 状态。

---

## 第 3 章 入站事件的传播机制

### 3.1 入站事件的流向

入站事件（`ChannelInboundHandler` 的方法）从 `HeadContext` 开始，沿 `next` 方向依次向后传播，直到 `TailContext` 或被某个 Handler 截断。以 `channelRead` 为例，完整的传播路径是：网络层读到数据 → `NioEventLoop.processSelectedKey()` → `AbstractChannel.Unsafe.read()` → `DefaultChannelPipeline.fireChannelRead(byteBuf)` → `HeadContext.channelRead()` → 用户 Handler 链 → `TailContext`（如果未被截断）。

```java
// DefaultChannelPipeline.fireChannelRead() 的实现
@Override
public final ChannelPipeline fireChannelRead(Object msg) {
    AbstractChannelHandlerContext.invokeChannelRead(head, msg);  // 从 head 开始传播
    return this;
}

// AbstractChannelHandlerContext.invokeChannelRead()
static void invokeChannelRead(final AbstractChannelHandlerContext next, Object msg) {
    EventExecutor executor = next.executor();
    if (executor.inEventLoop()) {
        next.invokeChannelRead(m);  // 在 EventLoop 线程：直接调用
    } else {
        executor.execute(() -> next.invokeChannelRead(m));  // 不在 EventLoop：提交任务
    }
}
```

`invokeChannelRead` 的实现有一个重要的细节：它检查了当前线程是否在 `EventLoop` 中。如果在，直接调用 Handler 方法；如果不在（譬如 Handler 配置了独立的 `EventExecutorGroup`），把调用包装成任务提交到 `EventExecutor` 的任务队列。这个检查确保了 Handler 回调始终在正确的线程中执行，即使 Handler 被配置了独立线程池。

### 3.2 事件截断与消息消费

入站事件传播的核心特征是"可截断"——每个 Handler 可以选择消费消息（不调用 `ctx.fireChannelRead()`，事件不再向后传播）或转发消息（调用 `ctx.fireChannelRead(msg)`，事件继续向后传播）。这个选择是 Pipeline 设计的精髓——它让每个 Handler 可以根据自己的逻辑决定是否让消息继续流动。

最常见的截断场景是解码器：`ByteToMessageDecoder` 在 `channelRead` 中累积字节，尝试解码。如果解码成功，调用 `fireChannelRead` 把解码后的对象传给下游；如果解码未完成（数据不够），不调用 `fireChannelRead`，等待更多数据到达。这个"不够就不传"的逻辑正是处理 TCP 粘包拆包的核心——解码器把"字节流"转换为"消息流"，下游 Handler 看到的是完整的消息而非半成品字节。

另一个截断场景是业务 Handler：`SimpleChannelInboundHandler` 在 `channelRead0` 中处理完业务逻辑后，默认不调用 `fireChannelRead`（消息被消费）。如果你需要把消息传给下游（譬如多个 Handler 都需要看到同一条消息），需要手动调用 `ctx.fireChannelRead(msg)` 并 `retain` 消息（因为 `SimpleChannelInboundHandler` 会自动 `release`）。

### 3.4 入站事件的种类与触发时机

`ChannelInboundHandler` 定义了十多个回调方法，每个对应一种 Channel 生命周期事件或 I/O 事件。`channelRegistered` 在 Channel 注册到 EventLoop 时触发，`channelUnregistered` 在注销时触发。`channelActive` 在 TCP 连接建立（三次握手完成）时触发，`channelInactive` 在连接断开时触发。`channelRead` 在读到数据时触发，`channelReadComplete` 在本次读取周期结束时触发（不代表数据读完，只代表本次 `Selector` 就绪事件的读取完成）。`userEventTriggered` 在用户自定义事件触发时调用（如 `IdleStateHandler` 的空闲事件）。`channelWritabilityChanged` 在 Channel 的可写状态变化时触发（如发送缓冲区高水位线被触及）。

理解每个事件的触发时机对正确编写 Handler 至关重要。一个常见的错误是在 `channelActive` 中发送数据但忘记 `flush`——`channelActive` 只表示连接建立，不涉及数据发送，`write` 后必须 `flush` 才能真正发出。另一个常见错误是在 `channelReadComplete` 中假设数据已经读完——`channelReadComplete` 只表示本次 `Selector` 就绪的读取完成，TCP 流可能还有更多数据在下次 `Selector` 就绪时读取。如果你需要知道"客户端发完了所有数据"，需要在应用层协议中定义结束标记（如 HTTP 的 Content-Length 或 Transfer-Encoding: chunked），而非依赖 `channelReadComplete`。

`userEventTriggered` 是一个特殊的事件——它不是 I/O 事件，而是用户自定义事件。Netty 内置了一些用户事件（如 `IdleStateEvent` 表示连接空闲），你也可以通过 `ctx.pipeline().fireUserEventTriggered(event)` 触发自定义事件。用户事件沿 Pipeline 向 tail 传播，与入站事件的方向相同，但它不是 I/O 事件，不涉及数据读取。用户事件的典型用途是"通知 Handler 某个状态变化"——如空闲检测、握手完成、配置变更。`IdleStateHandler` 就是利用用户事件机制通知下游"连接已空闲"的典型例子。

### 3.3 executionMask：跳过未实现方法的优化

`ChannelHandlerContext` 的 `executionMask` 字段是 Netty 的一个精妙性能优化。考虑一个场景：Pipeline 中有 10 个 Handler，但只有第 1 个和第 10 个实现了 `channelActive()` 方法（其余都是默认实现，直接转发）。如果每次 `channelActive` 事件都要逐个遍历 10 个节点，效率很低。

Netty 通过 `executionMask` 解决这个问题：在 Handler 添加到 Pipeline 时，Netty 通过反射检查该 Handler 类是否重写了各个方法，生成一个位掩码（每种事件对应一个 bit）。传播事件时，跳过 `executionMask` 中对应 bit 为 0（即使用默认实现）的 Handler：

```java
// AbstractChannelHandlerContext.findContextInbound() — 查找下一个实现了特定方法的 InboundHandler
private AbstractChannelHandlerContext findContextInbound(int mask) {
    AbstractChannelHandlerContext ctx = this;
    do {
        ctx = ctx.next;  // 向后找
    } while (skipContext(ctx, mask));  // 如果 executionMask 中对应 bit 为 0，跳过
    return ctx;
}
```

这个优化使得事件传播的实际复杂度是 O(k)，其中 k 是实际处理该事件的 Handler 数量（通常远小于 Pipeline 中 Handler 的总数），而非 O(n)。在 Pipeline 有 20 个 Handler 但只有 3 个实现了 `channelActive` 的场景下，`executionMask` 把传播路径从 20 步缩短为 3 步，性能提升显著。

`executionMask` 的生成通过反射在 Handler 添加时完成，只执行一次，后续传播时直接用位运算判断。这个设计体现了 Netty 对性能的极致追求——即使是一个"遍历链表"的操作，也要通过位掩码优化到最优。在 Netty 4.1 之前，这个优化不存在，事件传播需要遍历所有节点检查是否实现了特定方法，性能开销更大。4.1 引入 `executionMask` 后，事件传播的性能提升了约 30%。

### 3.5 事件传播的线程安全

事件传播的线程安全由 `EventLoop` 的线程封闭模型保证。当 `invokeChannelRead` 检查 `executor.inEventLoop()` 时，如果当前线程是 `EventLoop` 线程，直接调用 Handler 方法；如果不是（Handler 配置了独立的 `EventExecutorGroup`），把调用包装成任务提交到 `EventExecutor` 的任务队列。这个机制确保了 Handler 回调始终在正确的线程中执行，即使 Handler 被配置了独立线程池。

当 Handler 配置了独立的 `EventExecutorGroup` 时，事件传播会涉及线程切换——从 `EventLoop` 线程切换到 `EventExecutor` 线程，处理完后再切换回来。这个切换通过任务队列实现，有上下文切换的开销。但它的好处是 Handler 中的阻塞操作不会影响 `EventLoop` 线程——`EventLoop` 线程把事件"扔"给 `EventExecutor` 后立即返回，继续处理其他 Channel 的 I/O 事件。这是 Netty 处理"业务逻辑耗时"的标准方案：解码在 `EventLoop` 线程（快速），业务逻辑在 `EventExecutor` 线程池（允许阻塞），编码写回 `EventLoop` 线程（快速）。

---

## 第 4 章 出站事件的传播机制

### 4.1 出站事件的流向

出站操作（`write()`、`flush()`、`connect()`、`close()` 等）的传播方向与入站相反：从 tail 方向向 head 方向传播，最终由 `HeadContext` 执行实际的底层 I/O。以 `writeAndFlush` 为例，传播路径是：业务代码调用 `channel.writeAndFlush(response)` → `DefaultChannelPipeline.writeAndFlush()` 从 tail 开始 → `TailContext.write()` 转发 → 用户 OutboundHandler 链（编码器等）→ `HeadContext.write()` 执行底层写 → `AbstractChannel.Unsafe.write()` 写入发送缓冲区。

出站和入站的方向差异源于它们的语义不同。入站是"数据从网络进来，需要被业务处理"，方向是 head（网络层）到 tail（业务层）；出站是"数据从业务出去，需要被编码后发到网络"，方向是 tail（业务层）到 head（网络层）。编码器（OutboundHandler）把业务对象编码为字节流，解码器（InboundHandler）把字节流解码为业务对象——两者在 Pipeline 中的位置通常是对称的，编码器在解码器附近，但处理方向相反。

### 4.2 ctx.write() 与 channel.write() 的根本区别

这是 Netty 开发中最容易混淆、也最容易引发 Bug 的知识点。`channel.write(msg)` 或 `ctx.pipeline().write(msg)` 从 Pipeline 的 tail 开始向 head 方向传播，消息会经过所有 `OutboundHandler`。`ctx.write(msg)` 从当前 Handler 的位置向 head 方向传播，只经过当前 Handler 之前（更靠近 head 的）的 `OutboundHandler`，跳过当前 Handler 之后（更靠近 tail 的）的 Handler。

用一个具体场景说明其差异。假设 Pipeline 结构是 `Head → SslHandler → HttpEncoder → TrafficMonitorHandler → MyBusinessHandler → Tail`，`MyBusinessHandler` 要发送 `HttpResponse`：

```java
// 方式一：ctx.writeAndFlush(response)
// 路径：MyBusinessHandler → HttpEncoder → SslHandler → Head → 网络
// 经过 HttpEncoder（编码）、SslHandler（加密），不经过 TrafficMonitorHandler

// 方式二：ctx.channel().writeAndFlush(response)
// 路径：Tail → TrafficMonitorHandler → HttpEncoder → SslHandler → Head → 网络
// 经过 TrafficMonitorHandler（流量统计）、HttpEncoder（编码）、SslHandler（加密）
```

方式一跳过了 `TrafficMonitorHandler`（因为它在 `MyBusinessHandler` 之后，更靠近 tail），方式二经过了所有出站 Handler。如果你的 `TrafficMonitorHandler` 负责统计出站流量，方式一会导致流量统计不准确——响应数据没有被统计。

> [!warning] 出站操作起点的选择规则
> - **在业务 Handler 内发送响应**：用 `ctx.writeAndFlush()`（从当前位置向前传播，经过编码器、SSL 等）；
> - **在 Pipeline 外部（如定时任务）发送消息**：用 `channel.writeAndFlush()`（从 tail 开始，经过所有出站 Handler）；
> - **在某个 Handler 中需要绕过部分 Handler 直接发送**：用 `ctx.pipeline().context(HandlerClass.class).writeAndFlush()`（指定起始位置）。

### 4.3 为什么默认推荐 ctx.write()

在 Handler 内部发送响应时，默认推荐 `ctx.write()` 而非 `channel.write()`，原因有两点。第一是效率——`ctx.write()` 跳过了 tail 到当前位置之间的出站 Handler，减少了传播路径。如果当前位置在 Pipeline 中间，跳过的 Handler 可能有好几个，省掉的传播开销可观。第二是避免意外——`channel.write()` 会经过所有出站 Handler，包括那些可能不应该处理当前响应的 Handler（譬如流量统计器可能被计数两次，如果业务 Handler 之前已经用 `ctx.write()` 发过一次）。

但 `ctx.write()` 也有一个陷阱：如果你的编码器在当前 Handler 之后（更靠近 tail），`ctx.write()` 不会经过编码器，响应数据不会被编码就直接发到网络——这通常不是你想要的。因此，在配置 Pipeline 时，编码器应该放在业务 Handler 之前（更靠近 head），确保 `ctx.write()` 能经过编码器。这是 Pipeline 配置的一个常见约定：解码器和编码器在前，业务 Handler 在后。

### 4.4 出站操作的批量优化

Netty 的出站操作支持批量优化——`write()` 只是把数据放入 Channel 的出站缓冲区（`ChannelOutboundBuffer`），不立即发送；`flush()` 才真正触发发送。这个设计允许你多次 `write` 后一次 `flush`，减少系统调用次数。在 HTTP 响应场景中，Header 和 Body 可以分别 `write` 然后一次 `flush`，而非每次 `write` 都触发发送。

`ChannelOutboundBuffer` 有一个高水位线（`ChannelOption.WRITE_BUFFER_HIGH_WATER_MARK`，默认 64KB）和低水位线（`WRITE_BUFFER_LOW_WATER_MARK`，默认 32KB）。当缓冲区中的数据量超过高水位线时，Channel 变为"不可写"（`isWritable()` 返回 false），触发 `channelWritabilityChanged` 事件。这个机制用于"背压"（Backpressure）——当发送速度跟不上写入速度时，通知上游减速。如果你的 Handler 忽略可写状态持续 `write`，缓冲区会无限增长最终 OOM。正确的做法是在 `channelWritabilityChanged` 中暂停和恢复写入：

```java
@Override
public void channelWritabilityChanged(ChannelHandlerContext ctx) {
    if (ctx.channel().isWritable()) {
        // 缓冲区低于低水位线，恢复读取
        ctx.channel().config().setAutoRead(true);
    } else {
        // 缓冲区高于高水位线，暂停读取
        ctx.channel().config().setAutoRead(false);
    }
}
```

这个背压机制在流式传输场景中尤为重要——如文件下载、视频流推送，发送方不能比接收方快太多，否则缓冲区会溢出。Netty 的背压通过 `autoRead` 和水位线联动实现：`autoRead=false` 时 Netty 不从网络读取数据，相当于"暂停"了接收端，让发送方减速。

### 4.5 ChannelOutboundBuffer 的内部结构

`ChannelOutboundBuffer` 是 Netty 出站操作的内部缓冲区，它用单向链表管理待发送的消息。每个 `write()` 调用把消息（加 `ChannelPromise`）包装成一个 `Entry` 节点追加到链表尾部，`flush()` 把链表中所有未发送的 `Entry` 标记为"可发送"，`HeadContext` 的 `unsafe.flush()` 通过 JDK 的 `Channel.write()` 把数据写入内核发送缓冲区。

`ChannelOutboundBuffer` 的设计有一个细节值得注意：它用 `Entry` 对象池（`Recycler`）复用 `Entry` 对象，避免每次 `write` 都创建新对象。在每秒数万次 `write` 的场景下，对象池复用节省了大量的对象创建和 GC 开销。这是 Netty 高性能的又一个微观优化——在"看得见"的 API 之下，有大量"看不见"的优化在起作用。

当 `ChannelOutboundBuffer` 中的数据量超过高水位线时，`Channel.isWritable()` 返回 false。这个状态通过 `channelWritabilityChanged` 事件通知 Pipeline 中的 Handler。如果你在 Handler 中持续 `write` 而不检查 `isWritable()`，缓冲区会持续增长——每个 `Entry` 持有消息对象和 `ChannelPromise`，消息对象可能是 `ByteBuf`（持有堆外内存），最终会导致堆外内存 OOM。因此，在高吞吐场景中，必须实现背压逻辑，不能盲目 `write`。

---

## 第 5 章 ChannelHandler 的生命周期

### 5.1 Handler 的添加与移除事件

`ChannelHandler` 被添加到 Pipeline 或从 Pipeline 中移除时，会触发特定的回调方法。`handlerAdded()` 在 Handler 被添加到 Pipeline 时调用，常用于初始化 Handler 状态（如分配资源、打开文件句柄）。`handlerRemoved()` 在 Handler 从 Pipeline 中移除时调用，用于清理资源。`exceptionCaught()` 在 Handler 或其上游抛出异常时调用（已废弃，建议在 `ChannelInboundHandlerAdapter` 中覆盖）。

`handlerAdded()` 的执行时机值得注意：如果 Handler 在 Channel 注册到 `EventLoop` 之前被添加（譬如在 `ChannelInitializer` 的 `initChannel` 中），`handlerAdded()` 会延迟到 Channel 注册完成后执行。这个延迟确保了 `handlerAdded()` 在 `EventLoop` 线程中执行，避免了并发问题。如果 Handler 在 Channel 已注册后被添加，`handlerAdded()` 会立即在 `EventLoop` 线程中执行（或提交到 `EventLoop` 异步执行，取决于调用方线程）。

### 5.2 @Sharable：Handler 的线程安全声明

Netty 的 `ChannelHandler` 默认不是共享的：同一个 Handler 实例只能绑定到一个 Channel 的 Pipeline 上。如果将同一个 Handler 实例添加到多个 Pipeline，Netty 会抛出 `ChannelPipelineException`。这个限制是为了防止有状态的 Handler 被多个连接共享导致数据竞争——大多数 Handler 持有与某个连接相关的状态（如协议解析的中间状态、连接级别的计数器），如果多个连接共享同一个 Handler 实例，这些状态会被不同连接的数据混淆。

如果 `ChannelHandler` 是无状态的（不持有任何连接级别的实例变量），可以用 `@Sharable` 注解声明它是线程安全的，允许被多个 Channel 的 Pipeline 共享：

```java
@ChannelHandler.Sharable  // 声明：这个 Handler 是线程安全的
public class StatelessLoggingHandler extends ChannelInboundHandlerAdapter {
    private static final Logger logger = LoggerFactory.getLogger(StatelessLoggingHandler.class);

    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) {
        logger.info("Received: {}", msg);  // 只使用传入的参数，不访问实例变量
        ctx.fireChannelRead(msg);
    }
}

// 在 ChannelInitializer 中安全地共享
private static final StatelessLoggingHandler LOGGING_HANDLER = new StatelessLoggingHandler();
ch.pipeline().addLast(LOGGING_HANDLER);  // 所有连接共享同一个实例
```

> [!info] @Sharable 的正确使用条件
> 标注 `@Sharable` 意味着你向 Netty 承诺这个 Handler 是线程安全的。满足以下条件才可以标注：Handler 没有任何实例变量（纯无状态）；或者所有实例变量都是线程安全的（如 `AtomicLong`、`ConcurrentHashMap`）；或者实例变量是不可变对象（`final` 且不可修改）。如果 Handler 有连接级别的状态（如协议解析缓冲区、登录状态标记），绝对不能标注 `@Sharable`，必须为每个连接创建独立的 Handler 实例。

`@Sharable` 的设计体现了 Netty 对"默认安全"的追求——默认情况下 Handler 不可共享（防止有状态 Handler 被误共享导致数据错乱），只有显式标注 `@Sharable` 才能共享（程序员必须意识到并承担线程安全的责任）。这种"默认严格、显式放宽"的设计哲学，比"默认宽松、需要手动加锁"的设计更不容易出错——人在匆忙中容易忘记加锁，但不容易忘记标注注解。

### 5.3 Handler 的状态管理

Handler 的状态管理是 Pipeline 编程的核心难点。有状态 Handler（如解码器、会话管理器）的实例变量只在单个连接的 `EventLoop` 线程中访问，不需要同步——这是 `EventLoop` 线程封闭的红利。但如果你把有状态 Handler 标注为 `@Sharable` 并共享给多个连接，它的实例变量会被多个 `EventLoop` 线程并发访问，数据竞争就发生了。

区分 Handler 是否有状态的简单方法是看它是否有实例变量。如果 Handler 只有方法参数和局部变量，它是无状态的；如果 Handler 有实例变量（如 `ByteBuf cumulation`、`int state`、`UserSession session`），它是有状态的。无状态 Handler 可以安全共享，有状态 Handler 必须每个连接一个实例。`ChannelInitializer` 是无状态 Handler 的典型——它的 `initChannel` 方法只使用参数 `ch`，没有实例变量，因此可以被多个 Channel 共享（你通常用一个 `ChannelInitializer` 实例配置所有新连接的 Pipeline）。

### 5.4 Handler 的热替换

动态 Pipeline 的一个高级用法是"Handler 热替换"——在不中断连接的前提下，用新 Handler 替换旧 Handler。这在"配置热更新"场景中很有用：譬如限流规则变更后，用新的限流 Handler 替换旧的，无需重启服务或断开连接。`pipeline.replace(oldHandler, "newHandler", newHandler)` 实现了这个功能——它先添加新 Handler，调用新 Handler 的 `handlerAdded`，然后移除旧 Handler，调用旧 Handler 的 `handlerRemoved`。

热替换的陷阱在于状态迁移——如果旧 Handler 持有状态（如计数器、缓冲区），新 Handler 需要继承这些状态，否则状态丢失。在限流 Handler 的热替换中，新 Handler 应该继承旧 Handler 的当前计数器值，否则限流统计会重置。状态迁移通常通过在 `handlerRemoved` 中把状态保存到 `Channel.attr()`，在 `handlerAdded` 中从 `Channel.attr()` 读取来实现。这个模式虽然可行，但增加了代码复杂度，需要谨慎使用。

---

## 第 6 章 异常的传播机制

### 6.1 入站异常的传播

当 `ChannelHandler` 在处理入站事件时抛出异常，Netty 会捕获它并将异常作为 `exceptionCaught` 事件向后传播（向 tail 方向）。异常传播的路径与入站事件相同——从抛出异常的 Handler 位置开始，沿 `next` 方向依次调用后续 Handler 的 `exceptionCaught()` 方法，直到某个 Handler 处理了异常（不再调用 `ctx.fireExceptionCaught()`）或到达 `TailContext`。

```java
// 异常传播的入口
private void invokeChannelRead(Object msg) {
    try {
        ((ChannelInboundHandler) handler()).channelRead(this, msg);
    } catch (Throwable t) {
        invokeExceptionCaught(t);  // 将异常转变为 exceptionCaught 事件向后传播
    }
}
```

**最佳实践**是在 Pipeline 的最后（靠近 tail 的位置）添加一个统一的异常处理 Handler，捕获并处理所有未被上游处理的异常：

```java
// 统一异常处理器（放在 Pipeline 末尾）
public class GlobalExceptionHandler extends ChannelInboundHandlerAdapter {
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        if (cause instanceof IOException) {
            // TCP 连接异常（如客户端强制断开），正常关闭
            logger.warn("Connection reset: {}", ctx.channel().remoteAddress());
        } else {
            // 业务异常，打印完整堆栈
            logger.error("Unexpected exception from channel: {}", ctx.channel(), cause);
            ctx.writeAndFlush(buildErrorResponse(cause))
               .addListener(ChannelFutureListener.CLOSE);
        }
    }
}

pipeline.addLast(new HttpServerCodec());
pipeline.addLast(new MyBusinessHandler());
pipeline.addLast(new GlobalExceptionHandler());  // 最后一个，兜底处理所有异常
```

### 6.2 出站异常的处理

出站操作（`write()`、`connect()` 等）的异常通过 `ChannelPromise` 通知调用者，而非通过 `exceptionCaught()` 传播。这是入站和出站异常处理的关键区别——入站异常走 Pipeline 传播，出站异常走 `ChannelFuture` 回调。

```java
ChannelFuture future = ctx.writeAndFlush(response);
future.addListener(f -> {
    if (!f.isSuccess()) {
        Throwable cause = f.cause();
        logger.error("Write failed: {}", cause.getMessage());
        ctx.close();
    }
});
```

如果出站 Handler 的 `write()` 方法中抛出未捕获的异常，Netty 会通过 `ChannelPromise.setFailure(cause)` 通知调用者，调用者通过 `ChannelFuture.addListener()` 处理。这个设计确保了出站异常能被精确地关联到具体的写操作——每个 `write()` 返回一个独立的 `ChannelFuture`，异常通过这个 `Future` 通知，不会与其他写操作的异常混淆。

### 6.3 异常处理的常见错误

入站异常处理中最常见的错误是"吞掉异常"——在 Handler 的 `exceptionCaught` 中既不处理也不调用 `ctx.fireExceptionCaught()`，异常被静默忽略。这会导致连接可能已经处于不一致状态但没有任何日志记录，排查时无从下手。正确的做法是：要么处理异常（记录日志、关闭连接、发送错误响应），要么传递给下游（调用 `ctx.fireExceptionCaught(cause)`）。

另一个常见错误是"在异常处理后继续使用 Channel"——发生异常后，Channel 可能已经处于不一致状态（如解码器缓冲区损坏、SSL 状态错误），继续使用可能导致更多问题。最佳实践是：发生严重异常后关闭连接，让客户端重新建立连接，而非尝试在错误状态下继续服务。只有轻微异常（如某个请求的处理失败但连接本身正常）才适合在不关闭连接的情况下处理。

### 6.4 异常处理的分层策略

在生产级 Netty 应用中，异常处理通常采用分层策略。第一层是 Handler 内部 try-catch：如果某个操作可能抛出预期异常（如解析失败、鉴权失败），在 Handler 内部捕获并处理，不传播到 Pipeline。第二层是业务 Handler 的 `exceptionCaught`：如果业务逻辑抛出未预期异常，在业务 Handler 的 `exceptionCaught` 中处理（如记录日志、发送错误响应）。第三层是 Pipeline 末尾的 `GlobalExceptionHandler`：兜底处理所有未被前两层捕获的异常。

这种分层策略的好处是"按职责处理"——预期异常在产生处处理（最了解上下文），业务异常在业务层处理（可以发送业务错误码），未知异常在全局兜底处理（记录完整堆栈并关闭连接）。不分层的异常处理（所有异常都到一个全局 Handler 处理）会导致全局 Handler 逻辑臃肿，且无法针对不同类型的异常做差异化处理。

### 6.5 异常与连接关闭的决策

异常处理中一个需要决策的点是"是否关闭连接"。并非所有异常都需要关闭连接——轻微的、可恢复的异常（如单个请求的解析失败、业务校验失败）可以只发送错误响应而不关闭连接，让客户端继续发送后续请求。严重的、不可恢复的异常（如 SSL 状态错误、协议严重错乱、`OutOfMemoryError`）应该立即关闭连接，防止错误扩散。

判断标准是"连接是否还能正常服务"。如果异常只影响当前请求但连接本身正常（如 HTTP 400 Bad Request），不关闭连接。如果异常导致连接状态不一致（如解码器缓冲区损坏、SSL 握手失败），关闭连接。对于不确定的异常，保守做法是关闭连接——让客户端重新连接比在错误状态下继续服务更安全。这个决策没有通用规则，需要根据协议和业务特征判断，但"宁可关闭也不在错误状态下继续"是一个安全的默认策略。

---

## 第 7 章 动态修改 Pipeline

### 7.1 运行时增删 Handler

`ChannelPipeline` 支持在运行时动态添加、移除、替换 Handler，这个能力在某些场景下非常强大。

**场景一：HTTP 升级 WebSocket。** WebSocket 握手是通过一个特殊的 HTTP 请求（Upgrade 请求）完成的。在握手成功之前，Pipeline 需要包含 HTTP 编解码器；握手成功之后，Pipeline 需要切换为 WebSocket 编解码器：

```java
public class WebSocketUpgradeHandler extends SimpleChannelInboundHandler<FullHttpRequest> {
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, FullHttpRequest request) {
        if (WebSocketServerHandshakerFactory.isUpgradeRequest(request)) {
            handshaker.handshake(ctx.channel(), request).addListener(f -> {
                if (f.isSuccess()) {
                    ChannelPipeline pipeline = ctx.pipeline();
                    pipeline.remove(HttpObjectAggregator.class);
                    pipeline.remove(HttpServerCodec.class);
                    pipeline.remove(this);  // 移除自己（升级 Handler 完成使命）
                    pipeline.addLast(new WebSocketFrameHandler());
                }
            });
        } else {
            ctx.fireChannelRead(request.retain());  // 不是 WebSocket 请求，转发
        }
    }
}
```

**场景二：SSL/TLS 握手完成后的 Pipeline 重配置。** `SslHandler` 在 TLS 握手完成后会触发 `SslHandshakeCompletionEvent`，可以在这个事件中检查客户端证书，决定是否允许连接并添加应用层协议处理器。

动态 Pipeline 的价值在于"按需配置"——不同阶段需要不同的 Handler，握手阶段需要握手 Handler，数据传输阶段需要业务 Handler。如果 Pipeline 是静态的，所有 Handler 都要预先添加，握手 Handler 在数据传输阶段会成为多余的跳转节点。动态 Pipeline 让 Handler 的存在与连接的状态匹配，既节省了传播开销，又保持了逻辑的清晰。

### 7.4 动态 Pipeline 在 Dubbo 中的应用

Dubbo 的协议处理是动态 Pipeline 的典型应用。Dubbo 支持在同一个端口上处理多种协议（Dubbo 协议、Triple 协议、REST 协议），通过"协议探测"机制决定使用哪种协议的解码器。在连接建立时，Pipeline 中只放一个"协议探测 Handler"，它读取前几个字节判断协议类型，然后动态添加对应协议的解码器和业务 Handler，移除自己。这种设计让 Dubbo 可以在单一端口上支持多协议，而无需为每种协议开独立端口。

Dubbo 还利用动态 Pipeline 实现了"按需压缩"——如果客户端请求头中包含 `Accept-Encoding: gzip`，Provider 端动态添加 `CompressionEncoder`，对响应数据进行 gzip 压缩。如果客户端不支持压缩，不添加压缩 Handler，避免不必要的 CPU 开销。这种"按需添加"的设计比"始终添加但内部判断"更高效——没有压缩需求时，Pipeline 中没有压缩 Handler，传播路径更短。

### 7.5 动态 Pipeline 的性能影响

动态 Pipeline 的性能影响需要辩证看待。一方面，动态移除不需要的 Handler 缩短了传播路径，提升了性能——譬如握手完成后移除握手 Handler，后续请求少经过一个节点。另一方面，动态添加和移除 Handler 本身有开销——`addLast` 涉及链表节点创建和插入，`remove` 涉及链表节点摘除和 `handlerRemoved` 回调，这些操作在频繁执行时有 CPU 开销。

因此，动态 Pipeline 适合"低频次、高收益"的场景——譬如连接建立时的协议探测（一次性的）、配置变更时的 Handler 热替换（偶发的）。不适合"高频次"的场景——譬如每个请求都动态增删 Handler，这种用法会让 Pipeline 修改的开销超过它带来的传播路径缩短收益。在大多数场景下，静态 Pipeline（启动时配置好，运行时不变）是更简单且性能更稳定的选择，动态 Pipeline 是特殊场景的"高级武器"，不是常规手段。

### 7.2 Pipeline 修改的线程安全性

`ChannelPipeline` 的 `addLast()`、`remove()`、`replace()` 等修改操作是线程安全的。但修改操作必须注意执行上下文：如果在 `EventLoop` 线程之外修改 Pipeline，Netty 会将修改操作封装为任务提交到 `EventLoop` 异步执行，这意味着修改可能不是立即生效的。在 `EventLoop` 线程内（如在 Handler 回调中）修改 Pipeline 是同步的，立即生效。

这个"线程内同步、线程外异步"的设计与 `EventLoop` 的线程封闭模型一致——Pipeline 的修改必须在 `EventLoop` 线程中执行，才能保证与事件传播的互斥。如果在其他线程中修改 Pipeline，修改操作被排队，`EventLoop` 在处理完当前事件后会执行修改任务——但在这之前，可能有新的事件已经按旧的 Pipeline 配置传播了。因此，如果你需要确保修改立即生效，应该在 `EventLoop` 线程中修改（譬如在 Handler 回调中调用 `pipeline.remove()`），而非从外部线程修改。

### 7.3 动态 Pipeline 的陷阱

动态 Pipeline 虽然强大，但也有陷阱。第一是"修改时机的竞争"——如果在修改 Pipeline 的同时有事件正在传播，可能出现"事件传播到一半 Handler 被移除"的情况。Netty 通过在 `EventLoop` 线程中串行执行修改和事件传播来避免这个问题，但如果你从外部线程修改 Pipeline，修改的生效时机是不确定的。第二是"Handler 状态丢失"——被移除的 Handler 如果持有状态（如解码器的累积缓冲区），移除时这些状态会丢失。如果在移除时缓冲区中还有未处理的数据，这些数据会被丢弃。第三是"移除自身的时序"——Handler 在自己的回调中移除自身时，当前回调的剩余部分仍会执行，但下一次事件不会再经过这个 Handler。这个时序通常没问题，但在某些精细的场景下需要注意。

---

## 第 8 章 ChannelHandlerContext 的设计

### 8.1 ctx 的角色

`ChannelHandlerContext`（ctx）是 Handler 与 Pipeline 交互的"桥梁"——Handler 通过 ctx 获取 Channel、Pipeline、EventExecutor 等组件，通过 ctx 的 `fireXxx()` 方法向后传播事件，通过 ctx 的 `write()` 方法向前传播出站操作。ctx 把 Handler 从 Pipeline 的链表结构中解耦——Handler 不需要知道自己在链表中的位置，也不需要知道前驱和后继是谁，所有"找下一个 Handler"的逻辑都由 ctx 封装。

### 8.2 ctx 的方法分类

ctx 的方法可以分为三类。第一类是事件传播方法：`fireChannelActive()`、`fireChannelInactive()`、`fireChannelRead()`、`fireExceptionCaught()` 等，用于向后传播入站事件。第二类是出站操作方法：`write()`、`flush()`、`bind()`、`connect()`、`close()` 等，用于向前传播出站操作。第三类是状态查询方法：`channel()`、`pipeline()`、`executor()`、`name()`、`handler()` 等，用于获取关联组件的信息。

理解这三类方法的区别对正确使用 ctx 至关重要。事件传播方法是"通知下游有事件发生"，不涉及具体的 I/O 操作；出站操作方法是"请求执行 I/O 操作"，最终由 `HeadContext` 执行底层 I/O；状态查询方法是"获取上下文信息"，不触发任何传播或操作。初学者常犯的错误是把 `fireChannelRead` 和 `write` 混淆——前者是向后传给下一个 InboundHandler，后者是向前传给前一个 OutboundHandler，方向完全相反。

### 8.3 ctx 与 Channel 的关系

`ctx.channel()` 返回当前 Channel，`ctx.pipeline()` 返回当前 Pipeline，`ctx.executor()` 返回执行当前 Handler 的 `EventExecutor`。这些方法让 Handler 可以在不持有 Channel/Pipeline/EventExecutor 引用的前提下访问它们——Handler 的代码不需要管理这些依赖，Netty 通过 ctx 自动注入。这个设计让 Handler 可以独立于具体 Channel 编写，同一个 Handler 类可以被用于不同的 Channel 和 Pipeline。

`ctx.alloc()` 返回当前 Channel 配置的 `ByteBufAllocator`，这是在 Handler 中创建 `ByteBuf` 的推荐方式。`ctx.alloc()` 返回的分配器与 Channel 绑定，确保分配的 `ByteBuf` 在同一 `EventLoop` 线程中被创建和释放——这对于池化分配器的性能至关重要，因为 `PooledByteBufAllocator` 内部为每个 `EventLoop` 维护了线程本地缓存，同线程的分配和释放可以走快速路径。

### 8.4 ctx 的生命周期

`ChannelHandlerContext` 的生命周期与 Handler 在 Pipeline 中的存在绑定——Handler 添加时创建 ctx，Handler 移除时销毁 ctx。ctx 本身是一个轻量级对象，持有 Handler 引用和链表指针，不持有网络资源。ctx 的创建和销毁在 `EventLoop` 线程中完成，线程安全。

ctx 不能跨 Channel 使用——每个 Channel 有自己的 Pipeline，每个 Pipeline 中的 ctx 是独立的。如果你在 Handler 中保存了 ctx 引用并在其他 Channel 的回调中使用，会导致操作错误的 Channel。正确的做法是通过 ctx 获取 Channel 引用（`ctx.channel()`），在需要操作 Channel 时使用 Channel 引用而非 ctx 引用。ctx 是"当前 Handler 在当前 Pipeline 中的位置"的抽象，离开这个上下文它就失去了意义。

---

## 总结

`ChannelPipeline` 是 Netty 责任链模式的精妙实现。双向链表结构中，`HeadContext` 是 I/O 的执行者和入站数据的起点，`TailContext` 是入站的安全网，释放未消费的 `ByteBuf` 并打印警告。`executionMask` 优化传播路径，通过位掩码跳过未实现特定方法的 Handler，将事件传播的复杂度从 O(n) 降为 O(k)。`ctx.write()` 与 `channel.write()` 的本质区别在于传播起点——前者从当前位置向 head 传播，后者从 tail 开始经过所有出站 Handler；在 Handler 内部发送数据应优先使用 `ctx.writeAndFlush()`。`@Sharable` 是线程安全承诺，无状态 Handler 可以标注以共享实例，有状态的 Handler 必须为每个 Channel 创建独立实例。异常统一处理通过在 Pipeline 末尾添加 `exceptionCaught` 实现兜底，出站异常通过 `ChannelFuture.addListener()` 处理。动态 Pipeline 支持运行时协议切换（HTTP 到 WebSocket、TLS 握手后重配置），是构建多协议服务器的关键能力。

Pipeline 的设计体现了几个工程哲学。第一是"关注点分离"——每个 Handler 只做一件事，通过链式组合完成复杂逻辑，这比"一个大 Handler 做所有事"的设计更易维护和复用。第二是"双向流动"——入站和出站共享同一条链路但方向相反，让编解码器可以对称放置，简化了协议层的配置。第三是"默认安全"——Handler 默认不可共享、`TailContext` 自动释放未消费消息、异常自动向后传播，这些"默认安全"的设计减少了人为错误。第四是"性能与优雅的平衡"——`executionMask` 优化了传播路径，动态 Pipeline 支持了协议切换，这些设计在保持 API 优雅的同时兼顾了性能。

理解 Pipeline 的设计，是从"使用 Netty"到"理解 Netty"的关键一步。Pipeline 不仅是 Handler 的容器，更是 Netty 整个架构的"骨架"——`EventLoop` 驱动 Pipeline 传播事件，`ByteBuf` 在 Pipeline 中流转，`ChannelFuture` 在 Pipeline 的出站操作中返回。把这些组件的关系在 Pipeline 的上下文中理解，才能看到 Netty 架构的全貌。

Pipeline 的设计也反映了 Netty 对"可组合性"的追求。每个 Handler 是一个独立的、可复用的组件，通过 Pipeline 的链式组合形成完整的处理逻辑。这种"组合优于继承"的设计哲学让 Netty 的功能扩展非常灵活——你需要 HTTP 支持？加 `HttpServerCodec`。你需要 SSL？加 `SslHandler`。你需要空闲检测？加 `IdleStateHandler`。每个功能都是一个可插拔的 Handler，无需修改框架核心代码。这种可组合性是 Netty 生态繁荣的基础——社区贡献了大量的 Handler 实现，从协议编解码到监控埋点，从流量整形到访问控制，几乎覆盖了网络编程的所有常见需求。

但可组合性也有代价——Handler 之间的隐式依赖（顺序、类型、状态）增加了配置的复杂度。一个错误的 Pipeline 配置可能导致消息类型不匹配（解码器输出的类型不是业务 Handler 期望的）、顺序错误（编码器在业务 Handler 之后导致 `ctx.write()` 不经过编码器）、状态丢失（动态移除 Handler 时缓冲区被丢弃）。这些代价是可组合性的固有挑战，Netty 通过 `ChannelInitializer` 的集中配置、文档约定、`@Sharable` 的显式声明等机制来缓解，但最终仍需要程序员对 Pipeline 的行为有清晰的理解。架构即权衡，可组合性换来了灵活性，也带来了配置复杂度——这是责任链模式在网络编程中落地的必然代价。理解这些代价，才能在实践中扬长避短，既享受 Pipeline 的灵活组合能力，又通过清晰的配置约定和文档降低隐式依赖带来的风险。没有银弹，只有因地制宜——Pipeline 的可组合性在简单场景下是优势，在复杂场景下需要额外的约定和文档来驾驭。这正是架构权衡的本质：每一个设计决策都是利弊并存，关键在于根据实际场景选择合适的方案，而非盲目追求某种"最佳实践"。Netty 的 Pipeline 设计为我们提供了一个优秀的范本——它不是完美的，但它在灵活性和可控性之间找到了一个适合大多数网络编程场景的平衡点，这正是优秀架构设计的标志。

下一篇深入 Netty 的编解码器体系——TCP 粘包/拆包是网络编程的根本难题，`ByteToMessageDecoder`、`LengthFieldBasedFrameDecoder` 如何彻底解决它：[[06 编解码器——LengthFieldBasedFrameDecoder与自定义协议]]。

---

## 参考资料

1. Erich Gamma, Richard Helm, Ralph Johnson, John Vlissides. *Design Patterns: Elements of Reusable Object-Oriented Software*. Addison-Wesley, 1994
2. Norman Maurer, Marvin Allen Wolfthal. *Netty in Action*, Chapter 6: ChannelHandler and ChannelPipeline. Manning, 2016
3. `io.netty.channel.DefaultChannelPipeline` 源码
4. `io.netty.channel.AbstractChannelHandlerContext` 源码
5. `io.netty.channel.ChannelHandlerContext` 接口源码
6. `io.netty.channel.ChannelHandler.Sharable` 注解源码

---

> [!note] 思考题
> 1. `ChannelPipeline` 中的 InboundHandler 从 Head 到 Tail 正序执行，OutboundHandler 从 Tail 到 Head 逆序执行。如果在 Pipeline 中先添加 InboundHandler A，再添加 InboundHandler B，入站数据的处理顺序是 A 到 B。但如果 A 中调用了 `ctx.fireChannelRead(msg)` 和 `ctx.channel().writeAndFlush(resp)`，后者会从 Tail 开始还是从 A 的位置开始执行出站 Handler？这两种调用方式的差异在什么场景下会导致 Bug？
> 2. `@Sharable` 注解标记的 Handler 可以被多个 Channel 的 Pipeline 共享。如果你标注了一个有状态的 Handler 为 `@Sharable`（譬如它有一个实例变量 `ByteBuffer cumulation` 用于累积解码数据），多个连接同时使用这个 Handler 时会发生什么？Netty 会在运行时检测到这种错误吗，还是只能等到数据错乱时才发现？
> 3. Netty 允许在运行时动态添加和移除 ChannelHandler（如 SSL HandshakeHandler 在握手完成后移除自己）。如果在 Pipeline 修改期间有数据正在流经 Pipeline，是否存在并发安全问题？Netty 是如何保证 Pipeline 修改的线程安全性的？如果你从外部线程（非 EventLoop 线程）调用 `pipeline.remove(handler)`，修改何时生效？
