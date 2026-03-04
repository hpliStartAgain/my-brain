---
title: "Netty在开源项目中的应用——Dubbo、RocketMQ、Elasticsearch"
date: 2026-03-04
tags: [Java, Netty, Dubbo, RocketMQ, Elasticsearch, 开源项目, 网络层, 实战分析]
aliases: []
---

# Netty在开源项目中的应用——Dubbo、RocketMQ、Elasticsearch

## 摘要

学习一个框架的最终目的，是在真实系统中运用它。本文选取三个在生产中被广泛使用的顶级开源项目——Apache Dubbo（微服务 RPC 框架）、Apache RocketMQ（分布式消息队列）、Elasticsearch（分布式搜索引擎）——从源码视角剖析它们如何将 Netty 作为网络通信的基础设施。这三个项目代表了三种典型的使用模式：Dubbo 展示了如何在 Netty 之上构建完整的 RPC 协议栈，包括 SPI 扩展的 Handler 体系和多协议支持；RocketMQ 展示了消息队列场景下的高并发消息投递、批量拉取与心跳管理；Elasticsearch 展示了如何在 Netty 的基础上构建节点间的内部通信（Transport 层），包括请求/响应的异步路由和跨版本协议兼容。通过分析这些项目的真实代码，将本专栏前九篇的知识点串联起来，完成从"理解原理"到"看懂源码"的跨越。

---

## 第 1 章 为什么选这三个项目

### 1.1 代表性与覆盖面

选择 Dubbo、RocketMQ、Elasticsearch 的理由：

**覆盖了 Netty 最典型的三种使用场景**：

- **Dubbo**：经典的 RPC/微服务通信，同步请求-响应模型，代表了大多数企业内部服务调用的场景；
- **RocketMQ**：消息队列场景，Producer 高频推送、Consumer 批量拉取、Broker 高并发接收，对吞吐量要求极高；
- **Elasticsearch**：集群节点间通信（Transport 层），需要处理复杂的异步请求路由、版本兼容、节点健康感知。

**都是在阿里巴巴等大厂生产环境中长期运行、久经考验的系统**，代码质量和工程实践都处于行业领先水平。

**代码开放、可查**：三个项目均开源于 Apache/GitHub，可以直接阅读源码验证本文的分析。

### 1.2 阅读开源项目网络层的方法论

阅读大型项目的网络层代码，推荐以下路径：

1. **找启动入口**：搜索 `ServerBootstrap` 或 `Bootstrap` 的初始化代码，找到服务端/客户端的启动位置；
2. **看 ChannelInitializer**：`initChannel()` 方法是 Pipeline 的完整定义，从中可以了解整个协议栈的 Handler 组成；
3. **找核心 Handler**：通常最靠近业务的 Handler（Pipeline 末端的 InboundHandler）是入口，从这里开始读；
4. **追踪消息流**：从 `channelRead()` 开始，追踪消息如何被解码、路由、处理、编码、写回。

---

## 第 2 章 Dubbo 的 Netty 网络层

### 2.1 Dubbo 的网络层架构

Dubbo 的网络通信层（`dubbo-remoting` 模块）设计了一套高度抽象的 SPI 扩展接口，使得网络传输实现（Netty、Mina 等）可以自由替换。Netty 4 实现位于 `dubbo-remoting-netty4` 模块。

Dubbo 的网络层核心接口：

```
Transporter（传输层 SPI 接口）
├── NettyTransporter（Netty 4 实现）
│   ├── NettyServer（服务端）
│   │   └── 内部创建 NettyServerHandler → 注册到 Pipeline
│   └── NettyClient（客户端）
│       └── 内部创建 NettyClientHandler → 注册到 Pipeline

Channel（连接抽象）
└── NettyChannel（对 Netty io.netty.channel.Channel 的包装）

ChannelHandler（Dubbo 自己的 Handler 接口，不是 Netty 的）
└── 多层装饰器：
    HeartbeatHandler（心跳处理）
    → MultiMessageHandler（多消息处理）
    → AllChannelHandler（分发到业务线程池）
    → DecodeHandler（解码）
    → HeaderExchangeHandler（Exchange 层处理）
    → DubboProtocol.requestHandler（业务处理）
```

注意：Dubbo 有自己的 `ChannelHandler` 接口（`org.apache.dubbo.remoting.ChannelHandler`），与 Netty 的 `ChannelHandler` 是两套不同的接口体系。Dubbo 在 Netty Pipeline 中只放了一个 `NettyServerHandler`（Netty Handler），它在内部再调用 Dubbo 自己的 Handler 链。

### 2.2 Dubbo 的 Pipeline 组成

Dubbo 服务端的 Netty Pipeline（从 Netty 层面看）：

```java
// NettyServer.initChannel()（简化）
protected void initChannel(Channel ch) throws Exception {
    final NettyServerHandler nettyServerHandler = new NettyServerHandler(getUrl(), this);
    channels.put(NetUtils.toAddressString((InetSocketAddress) ch.remoteAddress()), 
                 nettyServerHandler.getChannel());
    
    ch.pipeline()
        .addLast("decoder", adapter.getDecoder())    // Dubbo 协议解码器
        .addLast("encoder", adapter.getEncoder())    // Dubbo 协议编码器
        .addLast("server-idle-handler",              // 连接空闲检测（心跳）
                 new IdleStateHandler(0, 0, heartbeat, MILLISECONDS))
        .addLast("handler", nettyServerHandler);     // 核心处理器
}
```

### 2.3 Dubbo 协议的报文格式

Dubbo 默认协议（`dubbo://`）的报文格式是 16 字节固定头部 + 可变长消息体：

```
┌──────────────────────────────────────────────────────────────────────┐
│  2字节magic  │  1字节flag  │  1字节status  │  8字节requestId  │  4字节bodyLen  │
├──────────────────────────────────────────────────────────────────────┤
│                           body（变长）                               │
└──────────────────────────────────────────────────────────────────────┘
```

- `magic`：固定值 `0xdabb`（Dubbo 的特征值，d=0xda，b=0xbb）；
- `flag`：位标志，最高位=1 表示请求，最低位=1 表示 event（如心跳），bit 3-5 表示序列化方式；
- `status`：响应状态码（仅响应消息有效）；
- `requestId`：8 字节请求 ID（Dubbo 用 long 类型）；
- `bodyLen`：消息体字节数。

Dubbo 的解码器基于 `LengthFieldBasedFrameDecoder`（或等效的自定义实现），先做帧切割，再解析头部字段。

### 2.4 Dubbo 的多线程模型：AllChannelHandler

Dubbo 的一个重要设计是将消息分发到不同的线程池处理。`AllChannelHandler`（也称 `all` 分发策略）将所有消息（请求/响应/连接/断开/心跳）都派发到业务线程池：

```java
// AllChannelHandler：将所有事件分发到业务线程池
public class AllChannelHandler extends WrappedChannelHandler {
    
    @Override
    public void received(Channel channel, Object message) throws RemotingException {
        ExecutorService executor = getPreferredExecutorService(message);
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, 
                ChannelState.RECEIVED, message));
        } catch (Throwable t) {
            // 线程池满时的处理：拒绝请求，记录警告
            if (message instanceof Request && t instanceof RejectedExecutionException) {
                sendFeedback(channel, (Request) message, t);
                return;
            }
            throw new ExecutionException("...", t);
        }
    }
}
```

这样做的好处是：Netty 的 `EventLoop` 线程（I/O 线程）只做协议解析，业务逻辑（实际的 RPC 调用）在独立的业务线程池中执行，I/O 线程不会被业务逻辑阻塞。这正是第三篇讲到的"在 Handler 中执行阻塞操作"问题的标准解法。

Dubbo 提供了多种分发策略（通过 URL 参数 `dispatcher` 配置）：
- `all`（默认）：所有消息派发到业务线程池；
- `direct`：不派发，直接在 I/O 线程执行（适合业务逻辑极快的场景）；
- `message`：只有请求和响应消息派发，连接/断开等事件在 I/O 线程处理；
- `execution`：只有请求消息派发，响应在 I/O 线程处理。

### 2.5 Dubbo 3.x 的 Triple 协议

Dubbo 3.x 引入了 Triple 协议（基于 HTTP/2 + Protobuf），兼容 gRPC，支持跨语言调用。Triple 协议的 Netty 实现基于 Netty 的 HTTP/2 编解码器（`Http2FrameCodec` + `Http2MultiplexHandler`），展示了 Netty 对复杂二进制协议的支持能力。

---

## 第 3 章 RocketMQ 的 Netty 网络层

### 3.1 RocketMQ 的 Remoting 模块

RocketMQ 的网络通信封装在 `rocketmq-remoting` 模块中，提供了 `RemotingServer` 和 `RemotingClient` 两个接口，底层实现分别是 `NettyRemotingServer` 和 `NettyRemotingClient`。

RocketMQ 的网络层相比 Dubbo 更简洁，没有多层抽象，直接暴露了 Netty 的使用细节：

```java
// NettyRemotingServer.start()（简化，展示关键配置）
public void start() {
    this.defaultEventExecutorGroup = new DefaultEventExecutorGroup(
        nettyServerConfig.getServerWorkerThreads(),  // 业务处理线程数（默认 8）
        new ThreadFactory() { ... }
    );
    
    ServerBootstrap childHandler = this.serverBootstrap
        .group(this.eventLoopGroupBoss, this.eventLoopGroupSelector)
        .channel(NioServerSocketChannel.class)  // 或 EpollServerSocketChannel（Linux 优化）
        .option(ChannelOption.SO_BACKLOG, 1024)
        .option(ChannelOption.SO_REUSEADDR, true)
        .childOption(ChannelOption.SO_KEEPALIVE, false)
        .childOption(ChannelOption.TCP_NODELAY, true)  // 禁用 Nagle，降低延迟
        .childOption(ChannelOption.SO_SNDBUF, nettyServerConfig.getServerSocketSndBufSize())
        .childOption(ChannelOption.SO_RCVBUF, nettyServerConfig.getServerSocketRcvBufSize())
        .localAddress(new InetSocketAddress(this.nettyServerConfig.getListenPort()))
        .childHandler(new ChannelInitializer<SocketChannel>() {
            @Override
            public void initChannel(SocketChannel ch) throws Exception {
                ch.pipeline()
                    .addLast(defaultEventExecutorGroup, 
                             HANDSHAKE_HANDLER_NAME, handshakeHandler)  // TLS 握手
                    .addLast(defaultEventExecutorGroup,
                             new NettyEncoder(),                    // RocketMQ 协议编码
                             new NettyDecoder(),                    // RocketMQ 协议解码
                             new IdleStateHandler(0, 0,            // 空闲检测（心跳）
                                 nettyServerConfig.getServerChannelMaxIdleTimeSeconds()),
                             new NettyConnectManageHandler(),       // 连接事件管理
                             new NettyServerHandler());             // 核心业务处理
            }
        });
}
```

注意 RocketMQ 将大部分 Handler 都放到了 `defaultEventExecutorGroup`（业务线程池）中执行——包括编解码器！这与 Netty 的最佳实践稍有不同（通常编解码器放在 I/O 线程执行更高效），但 RocketMQ 这样做是为了将所有处理都从 I/O 线程卸载，防止任何编解码异常影响 I/O 线程。

### 3.2 RocketMQ 的 RemotingCommand 协议

RocketMQ 自定义了 `RemotingCommand` 作为统一的消息格式，所有通信（Producer 发消息、Consumer 拉消息、Broker 心跳、NameServer 注册等）都使用同一套报文格式：

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 4字节帧总长 │ 4字节头部长 │  头部（JSON 或二进制）  │  消息体（Bytes）              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

头部包含：请求类型（code，如 10=SendMessage，11=PullMessage）、语言标识、版本号、请求 ID（opaque）、扩展字段（`Map<String, String>`）等。

这个设计的特点是：**头部和消息体分离**，头部统一处理，消息体按业务类型解析。这使得 RocketMQ 的协议扩展性很强——增加新的请求类型只需要新增 `code` 值和对应的处理器，不需要修改编解码逻辑。

### 3.3 RocketMQ 的异步请求匹配：ResponseFuture

RocketMQ 的 `ResponseFuture` 机制与第九篇设计的 `PendingRequestMap` 高度相似：

```java
// NettyRemotingAbstract 中的核心数据结构
// Key：requestId（RemotingCommand 的 opaque 字段）
// Value：等待响应的 ResponseFuture
protected final ConcurrentMap<Integer, ResponseFuture> responseTable 
    = new ConcurrentHashMap<>(256);

// 发送异步请求
public void invokeAsyncImpl(final Channel channel, final RemotingCommand request,
                             final long timeoutMillis, final InvokeCallback invokeCallback) {
    final int opaque = request.getOpaque();
    final ResponseFuture responseFuture = new ResponseFuture(
        channel, opaque, timeoutMillis, invokeCallback, once);
    this.responseTable.put(opaque, responseFuture);
    
    channel.writeAndFlush(request).addListener(f -> {
        if (f.isSuccess()) {
            responseFuture.setSendRequestOK(true);
            return;
        }
        // 发送失败：立即清理并触发回调
        requestFail(opaque);
    });
}

// 响应到达时
public void processResponseCommand(ChannelHandlerContext ctx, RemotingCommand cmd) {
    final int opaque = cmd.getOpaque();
    final ResponseFuture pair = responseTable.get(opaque);
    if (pair != null) {
        pair.setResponseCommand(cmd);
        responseTable.remove(opaque);
        
        if (pair.getInvokeCallback() != null) {
            // 异步回调：在回调线程池中执行
            executeInvokeCallback(pair);
        } else {
            // 同步等待：唤醒 countDownLatch
            pair.putResponse(cmd);
        }
    }
}
```

RocketMQ 专门有一个 `scanResponseTable()` 定时任务（每秒执行一次），扫描 `responseTable` 中超时的请求，触发超时回调并清理。这与 Netty 的 `HashedWheelTimer` 方案相比，是一种更简单但精度较低（1 秒粒度）的超时处理方式。

### 3.4 RocketMQ 的 Epoll 优化

RocketMQ 在 Linux 环境下会自动切换到 Epoll 模式（使用 Netty 的 `EpollEventLoopGroup` 和 `EpollServerSocketChannel`），相比 NIO 的 Java 层 `Selector`，Epoll 可以直接操作 Linux 内核的 epoll 接口，减少一次用户态/内核态切换，在超高并发（数万连接）时性能更好：

```java
// RocketMQ 的 Epoll/NIO 自动切换
if (useEpoll()) {
    this.eventLoopGroupBoss = new EpollEventLoopGroup(1, threadFactory);
    this.eventLoopGroupSelector = new EpollEventLoopGroup(
        nettyServerConfig.getServerSelectorThreads(), threadFactory);
} else {
    this.eventLoopGroupBoss = new NioEventLoopGroup(1, threadFactory);
    this.eventLoopGroupSelector = new NioEventLoopGroup(
        nettyServerConfig.getServerSelectorThreads(), threadFactory);
}

private boolean useEpoll() {
    return RemotingUtil.isLinuxPlatform()    // 必须是 Linux
        && nettyServerConfig.isUseEpollNativeSelector()  // 配置开关
        && Epoll.isAvailable();              // Netty Epoll 依赖可用
}
```

---

## 第 4 章 Elasticsearch 的 Transport 层

### 4.1 Transport 层的职责

Elasticsearch 是一个分布式搜索引擎，集群中的多个节点需要频繁通信：数据分片的复制（Primary → Replica）、查询的扇出（Coordinator → Data Node）与汇聚（Data Node → Coordinator）、集群状态同步（Master → All Nodes）等。

这些节点间的通信通过 **Transport 层**实现，在 Elasticsearch 7.x 之前由 `NettyTransport` 承担，7.x 之后迁移到基于 Netty 的 NIO `TransportService`。Transport 层的 Netty 实现位于 `transport-netty4` 模块。

### 4.2 Elasticsearch 的 TcpTransport 与 Netty 集成

Elasticsearch 的网络层设计比 Dubbo 和 RocketMQ 更复杂，因为它需要处理节点版本兼容（不同版本 ES 节点之间的通信）和复杂的请求路由（请求可能被转发到多个节点，并聚合结果）。

```java
// Elasticsearch Netty4Transport 的 Pipeline 配置（简化）
protected void initChannel(Channel ch) {
    Netty4TcpChannel nettyTcpChannel = new Netty4TcpChannel(ch, ...);
    
    ch.pipeline()
        .addLast("size", new Netty4SizeHeaderFrameDecoder())  // 帧解码（4字节长度 + body）
        .addLast("dispatcher", new Netty4MessageChannelHandler(
            pageCacheRecycler, transport));  // 消息分发器
}
```

Elasticsearch 的帧格式非常简单：4 字节消息长度 + 消息体（`TcpHeader` + 消息内容）。消息头部包含 `requestId`（请求/响应匹配）、`status`（标识是请求还是响应、是否压缩）、`version`（协议版本，用于跨版本兼容）。

### 4.3 异步请求路由：TransportService 的 pendingHandlers

Elasticsearch 的 `TransportService` 维护了两个 Map：

```java
// 等待响应的请求（等同于 RocketMQ 的 responseTable）
final Map<Long, RequestHolder<?>> pendingHandlers = new ConcurrentHashMap<>();

// 注册的请求处理器（按请求 action 分类）
private final Map<String, RequestHandlerRegistry<? extends TransportRequest>> requestHandlers;
```

当收到一条入站消息时，`TransportService` 根据 `status` 字段判断是请求还是响应：

- **如果是响应**：在 `pendingHandlers` 中查找对应的 `requestId`，调用注册的响应处理器；
- **如果是请求**：根据消息头中的 `action`（请求类型，如 `indices:data/read/search`）在 `requestHandlers` 中找到对应的处理器，提交到适当的线程池执行。

这种按 `action` 注册处理器的模式，使得不同类型的请求（搜索、索引、集群管理）可以分配到不同的线程池，保证高优先级操作（如集群管理）不被低优先级操作（如大型搜索）阻塞。

### 4.4 Elasticsearch 的 Page Cache 回收

Elasticsearch 处理大量搜索响应时，需要高效管理读取到的字节缓冲区。它没有直接使用 Netty 的 `PooledByteBufAllocator`，而是实现了自己的 `PageCacheRecycler`（基于线程本地缓存的页面回收器），与 Netty 的 `ByteBuf` 解耦，可以独立优化内存管理策略。

这体现了 Elasticsearch 工程师对底层的深度定制能力——使用 Netty 作为 I/O 层，但在其之上构建了更适合搜索引擎特征（大量大块数据、分块流式处理）的内存管理机制。

---

## 第 5 章 三个项目的 Netty 使用模式对比

### 5.1 核心差异总结

| 维度 | Dubbo | RocketMQ | Elasticsearch |
| --- | --- | --- | --- |
| **协议格式** | 16字节固定头 + body | 帧长(4) + 头长(4) + 头 + body | 4字节帧长 + body（含自定义头）|
| **序列化** | Hessian2（默认，可扩展）| JSON 头 + 二进制 body | 自定义二进制格式 |
| **线程模型** | I/O 线程 + Dubbo 业务线程池（AllChannelHandler）| I/O 线程 + 业务 EventExecutorGroup | I/O 线程 + 多个按优先级分级的线程池 |
| **心跳机制** | IdleStateHandler + 定时心跳 | IdleStateHandler + 专用心跳报文 | 节点间 Ping 机制（Transport 层上）|
| **请求匹配** | long 型 requestId + ConcurrentHashMap | int 型 opaque + ConcurrentHashMap + 定时扫描超时 | long 型 requestId + pendingHandlers |
| **Epoll 支持** | 通过参数配置 | 自动检测 Linux + 配置开关 | 通过参数配置 |
| **内存管理** | 依赖 Netty PooledByteBufAllocator | 依赖 Netty PooledByteBufAllocator | 自定义 PageCacheRecycler |

### 5.2 共同的设计模式

尽管三个项目在细节上差异显著，但在 Netty 使用层面都遵循了相同的核心模式：

**模式一：I/O 线程只做编解码，业务逻辑在独立线程池**

三个项目无一例外都将耗时的业务逻辑（实际的 RPC 调用、消息存储、搜索执行）从 `EventLoop` 线程卸载到独立的业务线程池，严格遵守"不在 EventLoop 中做阻塞操作"的铁律。

**模式二：自定义二进制协议 + LengthFieldBasedFrameDecoder 变种**

三个项目都设计了自己的二进制协议，都有固定头部（含长度字段）+ 可变消息体的结构。帧切割要么直接使用 `LengthFieldBasedFrameDecoder`，要么实现等效的自定义解码器。

**模式三：requestId + ConcurrentHashMap 实现异步请求-响应匹配**

所有项目都用相同的模式解决异步响应匹配问题：发送前注册 `<requestId, Future/Callback>`，响应到达时查找并完成。差别只在于 requestId 的类型（int/long/String）和超时处理方式（HashedWheelTimer/定时扫描）。

**模式四：应用层心跳保持连接活性**

`IdleStateHandler` + 自定义心跳报文是三个项目共同的选择。心跳间隔从 15 秒（Dubbo）到 30 秒（RocketMQ）不等，取决于中间网络设备的 TCP 空闲超时配置。

---

## 第 6 章 从开源项目中提炼的工程实践

### 6.1 连接数与线程数的合理配置

**`BossGroup` 线程数**：始终配置为 1（除非每秒新建连接数超过数万，如超大流量 API 网关）。Dubbo、RocketMQ、Elasticsearch 均如此。

**`WorkerGroup` 线程数**：经验值是 CPU 核数 × 2。但需要根据 I/O 与 CPU 的比例调整：
- 纯 I/O 密集（编解码快，转发型服务）：CPU 核数 × 2 甚至更少；
- 有一定 CPU 计算（复杂解析、压缩/解压）：可以适当增加。

**业务线程池大小**：最难配置，建议通过压测确定。起点参考：
- 对于 I/O 密集型业务（多数 RPC 服务）：CPU 核数 × 4 ～ CPU 核数 × 8；
- 对于 CPU 密集型业务（搜索、计算）：CPU 核数 × 1 ～ CPU 核数 × 2。

### 6.2 生产环境的常见坑

**坑一：未设置 SO_BACKLOG，高并发时连接建立失败**

`SO_BACKLOG` 控制 TCP 全连接队列（accept queue）大小，默认 128。在高并发下（服务重启后大量客户端同时重连），128 远不够用，连接会被 kernel 丢弃（SYN 包被 RST）。建议设置为 1024 或更大。

```java
serverBootstrap.option(ChannelOption.SO_BACKLOG, 1024);
```

**坑二：未处理 write() 返回的 ChannelFuture，忽略写失败**

```java
// 危险：忽略写失败
channel.writeAndFlush(response);

// 正确：监听写结果
channel.writeAndFlush(response).addListener(f -> {
    if (!f.isSuccess()) {
        log.error("Write failed: {}", f.cause().getMessage());
        channel.close();
    }
});
```

**坑三：直接内存泄漏，未关注 ResourceLeakDetector 日志**

生产环境建议在预发布时开启 `SIMPLE` 检测级别（默认），确认没有内存泄漏警告后再上线：

```
-Dio.netty.leakDetectionLevel=SIMPLE
```

**坑四：误用 channel.write() 替代 ctx.write()，绕过了出站 Handler**

在自定义 Handler 中发送响应时，应使用 `ctx.writeAndFlush(response)` 而非 `channel.writeAndFlush(response)`（尤其是在有多个出站 Handler 如编码器的 Pipeline 中）。这一点在第五篇已深入讨论。

**坑五：在 ChannelFuture 的 Listener 中执行阻塞操作**

`Listener` 在 `EventLoop` 线程中被调用，不能有任何阻塞：

```java
// 危险：Listener 中执行阻塞操作
future.addListener(f -> {
    if (f.isSuccess()) {
        String result = database.query("...");  // 阻塞！会卡住 EventLoop
    }
});

// 正确：提交到业务线程池
future.addListener(f -> {
    if (f.isSuccess()) {
        businessPool.execute(() -> {
            String result = database.query("...");
        });
    }
});
```

---

## 总结

本篇以 Dubbo、RocketMQ、Elasticsearch 三个顶级开源项目为案例，验证了前九篇所讲原理在真实工程中的落地方式：

- **Dubbo** 展示了如何通过 SPI 机制让 Netty 作为可替换的传输层，Dubbo 协议的 16 字节固定头设计，以及 `AllChannelHandler` 将业务逻辑卸载到独立线程池的标准模式；

- **RocketMQ** 展示了消息队列场景下对 Netty 的直接使用——更扁平的 Handler 结构、`RemotingCommand` 统一协议格式、`ResponseFuture` + `ConcurrentHashMap` 的异步匹配机制、Linux Epoll 的自动切换；

- **Elasticsearch** 展示了分布式搜索引擎对 Netty 的深度定制——按 action 分类的请求路由、多级优先级线程池、以及在 Netty 之上构建自定义 `PageCacheRecycler` 的例子；

- **三个项目共同验证**的核心模式：I/O 线程只做编解码、业务逻辑卸载到独立线程池、自定义二进制协议 + 帧解码器、requestId + ConcurrentHashMap 异步匹配、IdleStateHandler + 心跳报文。

至此，Netty 专栏全部 10 篇完成。从 Java NIO 的基础原理（01）、Netty 全局架构（02）、EventLoop 线程模型（03）、ByteBuf 内存管理（04）、ChannelPipeline 责任链（05）、编解码器（06）、jemalloc 内存池（07）、高性能工具类（08）、RPC 框架设计（09），到本篇的开源项目实战（10），形成了一条完整的学习路径，从原理到实践，从设计到落地。

---

> [!note] 参考资料
> - Apache Dubbo 源码：`dubbo-remoting-netty4` 模块
> - Apache RocketMQ 源码：`rocketmq-remoting` 模块
> - Elasticsearch 源码：`transport-netty4` 插件模块
> - 各项目官方文档与架构设计文档
