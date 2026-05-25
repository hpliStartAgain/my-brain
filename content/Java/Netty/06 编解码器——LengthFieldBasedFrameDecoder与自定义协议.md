---
title: "编解码器——LengthFieldBasedFrameDecoder与自定义协议"
date: 2026-03-04
tags: [ByteToMessageDecoder, Java, LengthFieldBasedFrameDecoder, MessageToByteEncoder, Netty, TCP流协议, 粘包拆包, 编解码器, 自定义协议]
aliases: []
---

# 编解码器——LengthFieldBasedFrameDecoder与自定义协议

## 摘要

TCP 是流协议，不是消息协议——它只保证字节的顺序到达，不保证"一次 send 对应一次 recv"。这个特性在应用层引发了**粘包**（多条消息粘合在一次读取中）和**拆包**（一条消息被分割到多次读取中）问题，是所有网络编程框架必须解决的基础难题。Netty 通过 `ByteToMessageDecoder` 体系提供了标准化的解决方案，并内置了 4 种常用的帧解码器覆盖主流协议格式。本文从 TCP 粘包/拆包的根本原因出发，深入剖析 `ByteToMessageDecoder` 的累积缓冲区机制与 `callDecode()` 循环驱动逻辑，重点讲解 `LengthFieldBasedFrameDecoder` 的 6 个参数含义（这是生产中最常用也最容易配错的），并以一个完整的自定义 RPC 协议为例展示如何设计和实现私有二进制协议的编解码器。

---

## 第 1 章 TCP 粘包与拆包：网络编程的基础难题

### 1.1 什么是粘包与拆包

要理解粘包和拆包，必须先理解 TCP 的本质。

TCP（Transmission Control Protocol）是一个**面向连接的字节流协议**。"字节流"这三个字是关键：TCP 不知道也不关心你的应用层消息的边界在哪里，它的工作就是把字节从发送端按顺序、可靠地传输到接收端。

想象一条水管：你往管子一端倒入的水（字节），会从另一端流出来，但你无法控制"每次流出多少"——可能你倒了一大桶（一条完整消息），对方只接到了半桶（拆包）；可能你倒了两小杯（两条消息），对方一次接到了两杯混在一起的水（粘包）。

**粘包**的典型场景：

客户端连续发送了两条消息"Hello"（5字节）和"World"（5字节），服务端在一次 `read()` 调用中读到了"HelloWorld"（10字节）。从字节层面看完全正确，但应用层不知道这是一条消息还是两条消息。

**拆包**的典型场景：

客户端发送了一条完整消息"Hello World"（11字节），由于网络分片或发送缓冲区满，服务端第一次 `read()` 只读到"Hello"（5字节），第二次 `read()` 读到" World"（6字节）。应用层收到了两个不完整的片段。

实际生产中，粘包和拆包往往同时出现：一次 `read()` 可能读到"一条半消息"——第一条完整，第二条只有一半。

### 1.2 粘包拆包的根本原因

粘包拆包现象的产生，源自 TCP 协议设计中的三个机制共同作用：

**原因一：Nagle 算法**

前文已提及，Nagle 算法会将多个小数据包合并发送。发送方先后调用了两次 `write()`，但如果第二次调用时第一次的 ACK 还没回来，Nagle 算法会将两次数据合并到一个 TCP 段中发送——这在接收端表现为"粘包"。禁用 `TCP_NODELAY` 可以解决这个问题，但代价是网络上小包增多。

**原因二：TCP 缓冲区与 MSS**

TCP 的发送缓冲区（`SO_SNDBUF`，默认约 4KB～128KB）和最大报文段大小（MSS，Maximum Segment Size，约 1460 字节）共同决定了每次实际发送的字节数。如果应用层一次 `write()` 的数据超过 MSS，TCP 会将其分割为多个报文段发送——这在接收端表现为"拆包"。

**原因三：接收缓冲区的读取时机**

应用层 `read()` 的调用时机和每次读取的字节数与发送方完全解耦。即使发送方每次精确地发送一条完整消息，接收方的 `read()` 调用可能只读到其中一半（内核接收缓冲区还未收到完整消息），也可能读到多条消息（多个报文段已经积累在缓冲区中）。

### 1.3 应用层如何界定消息边界

解决粘包/拆包的核心是在应用层定义消息边界，主流方案有四种：

| 方案 | 原理 | 优点 | 缺点 | 典型应用 |
| --- | --- | --- | --- | --- |
| **固定长度** | 每条消息固定 N 字节 | 实现最简单 | 消息长度变化时浪费空间或截断 | 简单心跳包 |
| **分隔符** | 用特殊字节序列标记消息结束（如 `\r\n`、`\0`）| 消息长度可变，实现简单 | 消息内容中不能包含分隔符（需转义）| HTTP 头、Telnet、Redis 协议 |
| **长度前缀** | 消息头部固定字节数表示消息长度，后跟消息体 | 高效、通用、支持二进制 | 需要先读长度再读体，实现稍复杂 | **大多数 RPC 框架**（Dubbo、gRPC）|
| **消息边界** | 利用协议本身的结构边界（如 HTTP 的 `Content-Length`、WebSocket 的帧格式）| 与协议语义结合 | 与具体协议绑定 | HTTP/1.1、WebSocket |

Netty 针对这四种方案都提供了内置解码器：
- 固定长度：`FixedLengthFrameDecoder`
- 分隔符：`DelimiterBasedFrameDecoder`、`LineBasedFrameDecoder`
- 长度前缀：`LengthFieldBasedFrameDecoder`（功能最强大）

---

## 第 2 章 ByteToMessageDecoder：累积缓冲区的设计

### 2.1 解码器的核心挑战

编写一个解码器的核心挑战是：**每次 `channelRead()` 读到的数据不一定是完整的消息**。解码器必须能够：
1. 将当前读到的字节追加到累积缓冲区；
2. 尝试从累积缓冲区解析完整消息；
3. 如果数据不足，等待下次 `channelRead()` 继续积累；
4. 解析出完整消息后，将其传递给下一个 Handler，并继续尝试解析剩余字节（处理粘包）。

`ByteToMessageDecoder` 提供了这个通用框架，子类只需实现 `decode()` 方法（"从累积缓冲区中尝试提取一条完整消息"的逻辑）。

### 2.2 cumulation：累积缓冲区

`ByteToMessageDecoder` 维护一个 `cumulation`（累积缓冲区），负责跨多次 `channelRead()` 的字节积累：

```java
public abstract class ByteToMessageDecoder extends ChannelInboundHandlerAdapter {
    
    // 累积缓冲区：跨多次 channelRead() 积累未解析完的字节
    ByteBuf cumulation;
    
    // 积累策略（默认 MERGE_CUMULATOR：将新数据合并到已有缓冲区）
    private Cumulator cumulator = MERGE_CUMULATOR;
    
    // 是否只解码单条消息（用于 HttpObjectDecoder 等特殊场景）
    private boolean singleDecode;
    
    @Override
    public void channelRead(ChannelHandlerContext ctx, Object msg) throws Exception {
        if (msg instanceof ByteBuf) {
            // 创建输出列表，用于收集本次解析出的消息
            CodecOutputList out = CodecOutputList.newInstance();
            try {
                ByteBuf data = (ByteBuf) msg;
                first = cumulation == null;
                if (first) {
                    // 第一次读取（累积缓冲区为空）：直接使用读到的数据
                    cumulation = data;
                } else {
                    // 已有累积数据：将新数据追加到累积缓冲区
                    cumulation = cumulator.cumulate(ctx.alloc(), cumulation, data);
                }
                // 核心：尝试从累积缓冲区解析消息
                callDecode(ctx, cumulation, out);
            } catch (DecoderException e) {
                throw e;
            } catch (Exception e) {
                throw new DecoderException(e);
            } finally {
                // 清理已读数据，释放引用
                if (cumulation != null && !cumulation.isReadable()) {
                    numReads = 0;
                    cumulation.release();
                    cumulation = null;
                } else if (++numReads >= discardAfterReads) {
                    // 多次读取后，丢弃已读数据（节省内存）
                    numReads = 0;
                    discardSomeReadBytes();
                }
                // 将解析出的消息传递给下一个 Handler
                int size = out.size();
                firedChannelRead |= out.insertSinceRecycled();
                fireChannelRead(ctx, out, size);
                out.recycle();
            }
        } else {
            // 非 ByteBuf 消息：直接往下传，不处理
            ctx.fireChannelRead(msg);
        }
    }
    
    // 核心解析循环
    protected void callDecode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
        try {
            while (in.isReadable()) {
                int outSize = out.size();
                
                if (outSize > 0) {
                    // 已经解析出消息：先触发 channelRead 传给下游，清空 out
                    fireChannelRead(ctx, out, outSize);
                    out.clear();
                    outSize = 0;
                }
                
                int oldInputLength = in.readableBytes();
                // 调用子类实现的 decode 方法
                decodeRemovalReentryProtection(ctx, in, out);
                
                if (out.size() == outSize) {
                    // decode() 没有解析出新消息
                    if (oldInputLength == in.readableBytes()) {
                        // 而且也没有消耗任何字节：说明数据不足，等待更多数据
                        break;
                    }
                    // 消耗了部分字节但没解析出消息：继续循环（可能需要更多字节）
                } else {
                    // 解析出了消息：继续循环（处理粘包，尝试解析更多消息）
                    if (oldInputLength == in.readableBytes()) {
                        // 解析出了消息但没消耗字节：这是 bug，抛出异常
                        throw new DecoderException("...");
                    }
                }
            }
        } catch (DecoderException e) {
            throw e;
        } catch (Exception cause) {
            throw new DecoderException(cause);
        }
    }
}
```

`callDecode()` 的循环驱动逻辑是 `ByteToMessageDecoder` 的精髓：
- 只要累积缓冲区有数据，就不断调用 `decode()`；
- `decode()` 成功解析出消息（`out` 中增加了元素）：继续循环，处理剩余字节（可能还有更多完整消息——粘包场景）；
- `decode()` 没有解析出消息且没有消耗字节：数据不足，退出循环，等待下次 `channelRead()`；
- `decode()` 没有解析出消息但消耗了部分字节：正在处理中间状态，继续循环。

### 2.3 MERGE_CUMULATOR vs COMPOSITE_CUMULATOR

`ByteToMessageDecoder` 提供两种数据积累策略：

**`MERGE_CUMULATOR`（默认）**：

将新数据合并（拷贝）到现有累积缓冲区。优点：数据连续，访问高效；缺点：合并时有一次数据拷贝。

```java
public static final Cumulator MERGE_CUMULATOR = (alloc, cumulation, in) -> {
    if (!cumulation.isReadable() && in.isContiguous()) {
        cumulation.release();
        return in;
    }
    try {
        int required = in.readableBytes();
        if (required > cumulation.maxWritableBytes() ||
            (required > CONSOLIDATE_WHEN_MERGE_AVOIDS_COMPACTION && ...) ) {
            return expandCumulation(alloc, cumulation, in);
        }
        cumulation.writeBytes(in, in.readerIndex(), required);  // 拷贝新数据到已有缓冲区
        in.readerIndex(in.writerIndex());
        return cumulation;
    } finally {
        in.release();
    }
};
```

**`COMPOSITE_CUMULATOR`**：

用 `CompositeByteBuf` 聚合，不拷贝数据。优点：零拷贝积累；缺点：随机访问性能稍差（需要跨组件计算偏移）。

适用于大消息体（如文件上传）场景，避免大量数据的内存拷贝。对于小消息（如 RPC 请求帧，通常 < 4KB），默认的 `MERGE_CUMULATOR` 已经足够高效。

---

## 第 3 章 内置帧解码器详解

### 3.1 FixedLengthFrameDecoder

最简单的解码器，每条消息固定 N 字节：

```java
// 每条消息恰好 100 字节
pipeline.addLast(new FixedLengthFrameDecoder(100));
```

实现极其简单：`decode()` 检查累积缓冲区是否有 ≥ 100 字节，有则读取 100 字节作为一帧，否则等待。

适用场景极为有限：传感器数据、监控指标等消息长度完全固定的场景。

### 3.2 DelimiterBasedFrameDecoder

以特殊字节序列作为消息分隔符：

```java
// 以 "\r\n" 或 "\n" 作为分隔符，最大帧长 1024 字节
pipeline.addLast(new DelimiterBasedFrameDecoder(1024,
    Delimiters.lineDelimiter()));

// 以自定义分隔符作为终止
ByteBuf delimiter = Unpooled.wrappedBuffer(new byte[]{0x00});
pipeline.addLast(new DelimiterBasedFrameDecoder(4096, delimiter));
```

`DelimiterBasedFrameDecoder` 会在累积缓冲区中搜索分隔符，找到则将分隔符之前的字节作为一帧（不含分隔符）。

`maxFrameLength` 参数是安全保护：如果在 `maxFrameLength` 字节内没有找到分隔符，抛出 `TooLongFrameException`，防止恶意客户端发送超长无分隔符数据导致内存溢出。

适用场景：HTTP 协议头（以 `\r\n` 分隔）、Redis 协议（RESP 格式以 `\r\n` 结尾）、Telnet。

### 3.3 LineBasedFrameDecoder

`DelimiterBasedFrameDecoder` 针对换行符的专用优化版本，支持 `\n` 和 `\r\n` 两种换行符：

```java
pipeline.addLast(new LineBasedFrameDecoder(2048));
```

### 3.4 LengthFieldBasedFrameDecoder：最通用的帧解码器

`LengthFieldBasedFrameDecoder` 是 Netty 内置解码器中最复杂、也最常用的。几乎所有基于 Netty 构建的 RPC 框架（Dubbo、gRPC 的 HTTP/2 帧、自定义协议）都依赖于它或其变种。

---

## 第 4 章 LengthFieldBasedFrameDecoder 六参数详解

### 4.1 协议帧的通用结构

大多数二进制协议都遵循类似的帧格式：

```
┌─────────────────────────────────────────────────────────────────┐
│  header fields...  │  Length Field  │  header fields...  │ Body │
└─────────────────────────────────────────────────────────────────┘
```

`LengthFieldBasedFrameDecoder` 的六个参数精确描述了长度字段在协议帧中的位置和含义：

```java
LengthFieldBasedFrameDecoder(
    int maxFrameLength,       // 最大帧长度（安全保护，超过则抛异常）
    int lengthFieldOffset,    // 长度字段的起始偏移量（距帧首的字节数）
    int lengthFieldLength,    // 长度字段占几个字节（1/2/3/4/8）
    int lengthAdjustment,     // 长度字段值的修正量（正负均可）
    int initialBytesToStrip   // 解码后需要跳过的字节数（去掉不需要的头部）
)
```

参数含义用公式表达：

```
实际消息体起始位置 = lengthFieldOffset + lengthFieldLength
消息体字节数      = 长度字段的值 + lengthAdjustment
完整帧的字节数    = lengthFieldOffset + lengthFieldLength + 消息体字节数
```

解码后的 `ByteBuf` 内容 = 跳过开头 `initialBytesToStrip` 字节后的剩余内容。

### 4.2 六种典型配置场景

用六个具体例子演示参数的含义：

**场景一：长度字段只表示消息体长度（最常见）**

```
协议格式：[ 4字节长度 | 消息体 ]
长度字段值 = 消息体字节数

参数：maxFrameLength=65535, lengthFieldOffset=0, lengthFieldLength=4,
     lengthAdjustment=0, initialBytesToStrip=0

解码前：┌─────────────────────────────────────┐
        │ 0x00 0x00 0x00 0x0C │ "Hello World" │
        └─────────────────────────────────────┘
         ←  长度字段(12)  →    ← 12字节体  →

解码后：┌─────────────────────────────────────┐
        │ 0x00 0x00 0x00 0x0C │ "Hello World" │
        └─────────────────────────────────────┘
        （包含长度字段，initialBytesToStrip=0 不跳过）
```

如果想在解码后去掉长度字段（只保留消息体）：

```
参数：initialBytesToStrip=4

解码后：┌─────────────────┐
        │  "Hello World"  │
        └─────────────────┘
```

**场景二：长度字段表示整帧长度（含长度字段本身）**

```
协议格式：[ 4字节长度 | 消息体 ]
长度字段值 = 4 + 消息体字节数（含长度字段自身）

参数：lengthFieldOffset=0, lengthFieldLength=4,
     lengthAdjustment=-4,  ← 修正：实际消息体 = 长度值 - 4
     initialBytesToStrip=4 ← 跳过长度字段
```

`lengthAdjustment=-4` 的含义：长度字段的值是 16（表示整帧长度），减去长度字段自身 4 字节，实际消息体是 12 字节。

**场景三：消息体之前有 2 字节 magic（魔数）**

```
协议格式：[ 2字节magic | 4字节长度 | 消息体 ]

参数：lengthFieldOffset=2,  ← 长度字段在 magic 之后，偏移 2 字节
     lengthFieldLength=4,
     lengthAdjustment=0,
     initialBytesToStrip=0  ← 保留完整帧（包含 magic 和长度字段）
```

**场景四：magic + 长度字段 + 额外头部 + 消息体**

```
协议格式：[ 2字节magic | 3字节长度 | 1字节类型 | 消息体 ]
长度字段值 = 消息体字节数（不含 1 字节类型）

参数：lengthFieldOffset=2,   ← 长度字段在 2 字节 magic 后
     lengthFieldLength=3,   ← 长度字段 3 字节
     lengthAdjustment=1,    ← 长度字段后还有 1 字节类型需要包含
     initialBytesToStrip=5  ← 解码后跳过 magic(2) + 长度(3)，只保留类型+消息体
```

**场景五：长度字段在中间（头部分两段）**

```
协议格式：[ 1字节version | 1字节type | 2字节length | 消息体 ]
长度字段值 = 消息体字节数

参数：lengthFieldOffset=2,   ← 长度字段在第 2 字节后
     lengthFieldLength=2,
     lengthAdjustment=0,
     initialBytesToStrip=4  ← 跳过整个固定头部（version + type + length），只保留消息体
```

**场景六：长度字段值包含了整个帧（含所有头部）**

```
协议格式：[ 4字节length | 1字节type | 消息体 ]
长度字段值 = 4 + 1 + 消息体字节数

参数：lengthFieldOffset=0,
     lengthFieldLength=4,
     lengthAdjustment=-5,   ← 修正：实际消息体字节数 = 长度值 - 5
     initialBytesToStrip=5  ← 跳过 length(4) + type(1)，只保留消息体
```

> [!info] 记忆 lengthAdjustment 的方法
> `lengthAdjustment` 的直觉是：**它弥补了"长度字段的值"与"实际消息体字节数"之间的差距**。
>
> - 如果长度字段的值 = 消息体字节数（最常见）：`lengthAdjustment = 0`；
> - 如果长度字段的值包含了长度字段本身（如 4 字节长度 + 消息体，长度值 = 4 + 消息体）：`lengthAdjustment = -4`（减去多算的 4 字节）；
> - 如果长度字段的值是消息体字节数，但消息体前面还有未被长度字段计入的固定字段（如 1 字节 type）：`lengthAdjustment = 1`（告诉解码器还需额外读取 1 字节）。

---

## 第 5 章 自定义 RPC 协议的完整实现

### 5.1 协议设计

以一个简化的 RPC 协议为例，演示完整的编解码器实现。协议帧格式：

```
┌──────────────────────────────────────────────────────────────────┐
│  2字节  │  1字节  │  1字节  │  4字节    │  4字节    │  N字节    │
│  magic  │ version │  type   │ requestId │  length   │  payload  │
└──────────────────────────────────────────────────────────────────┘
```

字段说明：
- `magic`（2字节）：协议魔数，固定值 `0xCAFE`，用于识别协议；
- `version`（1字节）：协议版本号，便于协议升级；
- `type`（1字节）：消息类型（0=请求, 1=响应, 2=心跳ping, 3=心跳pong）；
- `requestId`（4字节）：请求 ID，用于异步场景匹配请求与响应；
- `length`（4字节）：payload 的字节数；
- `payload`（N字节）：序列化后的消息体（如 JSON、Protobuf）。

固定头部总长度：2 + 1 + 1 + 4 + 4 = 12 字节。

### 5.2 消息对象定义

```java
@Data
@Builder
public class RpcMessage {
    public static final short MAGIC = (short) 0xCAFE;
    public static final byte VERSION = 1;
    
    // 消息类型常量
    public static final byte TYPE_REQUEST  = 0;
    public static final byte TYPE_RESPONSE = 1;
    public static final byte TYPE_HEARTBEAT_PING = 2;
    public static final byte TYPE_HEARTBEAT_PONG = 3;
    
    // 头部字段
    private byte version;    // 协议版本
    private byte type;       // 消息类型
    private int requestId;   // 请求 ID
    
    // 消息体（已反序列化的对象）
    private Object payload;  // 业务请求或响应对象
}
```

### 5.3 解码器实现：RpcMessageDecoder

```java
/**
 * RPC 协议解码器
 * 基于 LengthFieldBasedFrameDecoder：先做帧切割，再解析帧内容
 */
public class RpcMessageDecoder extends LengthFieldBasedFrameDecoder {
    
    // 固定头部长度：magic(2) + version(1) + type(1) + requestId(4) = 8 字节
    // length 字段在偏移量 8 处，占 4 字节
    // payload 在 length 字段之后
    private static final int HEADER_LENGTH = 12;  // 不含 payload 的完整头部
    private static final int LENGTH_FIELD_OFFSET = 8;   // length 字段偏移
    private static final int LENGTH_FIELD_LENGTH = 4;   // length 字段占 4 字节
    
    public RpcMessageDecoder() {
        super(
            65535,             // maxFrameLength：最大帧 64KB
            LENGTH_FIELD_OFFSET,  // lengthFieldOffset = 8
            LENGTH_FIELD_LENGTH,  // lengthFieldLength = 4
            0,                 // lengthAdjustment = 0（length 字段值 = payload 字节数）
            0                  // initialBytesToStrip = 0（保留完整帧，自己解析头部）
        );
    }
    
    @Override
    protected Object decode(ChannelHandlerContext ctx, ByteBuf in) throws Exception {
        // 调用父类：负责帧切割（等待完整帧到达）
        Object decoded = super.decode(ctx, in);
        if (decoded instanceof ByteBuf) {
            ByteBuf frame = (ByteBuf) decoded;
            try {
                return decodeFrame(frame);
            } finally {
                frame.release();  // 解析完释放帧缓冲区
            }
        }
        return decoded;
    }
    
    private RpcMessage decodeFrame(ByteBuf frame) {
        // 验证魔数
        short magic = frame.readShort();
        if (magic != RpcMessage.MAGIC) {
            throw new IllegalStateException("Invalid magic: " + magic);
        }
        
        // 读取头部字段
        byte version = frame.readByte();
        byte type = frame.readByte();
        int requestId = frame.readInt();
        int length = frame.readInt();
        
        if (length <= 0) {
            // 无 payload（如心跳消息）
            return RpcMessage.builder()
                .version(version)
                .type(type)
                .requestId(requestId)
                .build();
        }
        
        // 读取 payload 并反序列化
        byte[] payloadBytes = new byte[length];
        frame.readBytes(payloadBytes);
        
        // 根据消息类型决定反序列化目标类型
        Object payload = deserialize(type, payloadBytes);
        
        return RpcMessage.builder()
            .version(version)
            .type(type)
            .requestId(requestId)
            .payload(payload)
            .build();
    }
    
    private Object deserialize(byte type, byte[] bytes) {
        // 实际实现中根据消息类型选择合适的反序列化策略
        // 这里简化为 JSON 反序列化
        if (type == RpcMessage.TYPE_REQUEST) {
            return JSON.parseObject(bytes, RpcRequest.class);
        } else if (type == RpcMessage.TYPE_RESPONSE) {
            return JSON.parseObject(bytes, RpcResponse.class);
        }
        return bytes;  // 心跳等无 payload 类型
    }
}
```

### 5.4 编码器实现：RpcMessageEncoder

```java
/**
 * RPC 协议编码器
 * 继承 MessageToByteEncoder，将 RpcMessage 对象序列化为字节流
 */
@ChannelHandler.Sharable  // 无状态，可以共享
public class RpcMessageEncoder extends MessageToByteEncoder<RpcMessage> {
    
    @Override
    protected void encode(ChannelHandlerContext ctx, RpcMessage msg, ByteBuf out) throws Exception {
        // 写入魔数
        out.writeShort(RpcMessage.MAGIC);
        
        // 写入头部字段
        out.writeByte(msg.getVersion());
        out.writeByte(msg.getType());
        out.writeInt(msg.getRequestId());
        
        // 序列化 payload
        byte[] payloadBytes = msg.getPayload() != null 
            ? JSON.toJSONBytes(msg.getPayload()) 
            : new byte[0];
        
        // 写入 length 字段
        out.writeInt(payloadBytes.length);
        
        // 写入 payload
        if (payloadBytes.length > 0) {
            out.writeBytes(payloadBytes);
        }
    }
}
```

### 5.5 MessageToByteEncoder 的工作原理

`MessageToByteEncoder<I>` 是所有编码器的基类，其工作原理是：

1. `write()` 操作触发时，检查消息类型是否匹配泛型参数 `I`；
2. 如果匹配，分配一个 `ByteBuf`（通过 `allocateBuffer()`），调用 `encode()` 方法将消息写入；
3. 如果不匹配，直接往前传递（让其他出站 Handler 处理）。

```java
public abstract class MessageToByteEncoder<I> extends ChannelOutboundHandlerAdapter {
    
    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
        ByteBuf buf = null;
        try {
            if (acceptOutboundMessage(msg)) {
                // 消息类型匹配：分配缓冲区并编码
                I cast = (I) msg;
                buf = allocateBuffer(ctx, cast, preferDirect);
                try {
                    encode(ctx, cast, buf);  // 子类实现
                } finally {
                    ReferenceCountUtil.release(cast);  // 自动释放原始消息对象
                }
                if (buf.isReadable()) {
                    ctx.write(buf, promise);  // 将编码后的 ByteBuf 传出
                    buf = null;
                } else {
                    // 编码后没有数据（编码器选择不发送）
                    buf.release();
                    ctx.write(Unpooled.EMPTY_BUFFER, promise);
                }
            } else {
                // 类型不匹配：直接往前传
                ctx.write(msg, promise);
            }
        } catch (EncoderException e) {
            throw e;
        } catch (Throwable e) {
            throw new EncoderException(e);
        } finally {
            if (buf != null) {
                buf.release();
            }
        }
    }
}
```

注意 `MessageToByteEncoder` 会自动释放原始消息对象（调用 `ReferenceCountUtil.release(cast)`），因此如果 `payload` 是 `ByteBuf` 类型，编码完成后 Netty 会自动释放它，不需要手动 `release()`。

### 5.6 组装 Pipeline

将编解码器组装到 Pipeline，构成完整的 RPC 协议栈：

```java
@Override
protected void initChannel(SocketChannel ch) {
    ChannelPipeline pipeline = ch.pipeline();
    
    // 入站：解码（字节 → RpcMessage）
    pipeline.addLast(new RpcMessageDecoder());
    
    // 出站：编码（RpcMessage → 字节）
    pipeline.addLast(new RpcMessageEncoder());
    
    // 空闲检测（心跳）
    pipeline.addLast(new IdleStateHandler(60, 0, 0, TimeUnit.SECONDS));
    
    // 业务处理
    pipeline.addLast(new RpcServerHandler());
}
```

入站顺序（从 head 到 tail）：`RpcMessageDecoder` 在前，`RpcServerHandler` 在后——字节先被解码为 `RpcMessage`，再传给业务 Handler 处理。

出站顺序（从 tail 到 head）：业务 Handler 写出 `RpcMessage`，先经过 `RpcMessageEncoder` 编码为 `ByteBuf`，再写入网络。这里出站经过 `RpcMessageEncoder` 是因为 `RpcServerHandler` 调用 `ctx.writeAndFlush(rpcMessage)` 从当前位置向前传播，方向是：`RpcServerHandler` → `RpcMessageEncoder` → head → 网络。

---

## 第 6 章 ReplayingDecoder：更简洁的解码器写法

### 6.1 传统 decode() 的繁琐之处

用 `ByteToMessageDecoder` 实现解码器时，每次读取前都要手动检查可读字节数是否足够，否则需要保存中间状态并等待更多数据：

```java
// 繁琐的手动检查
@Override
protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
    // 检查是否有足够的字节读取头部
    if (in.readableBytes() < 4) return;  // 不够，等待
    
    // 标记 readerIndex，以便不够时回退
    in.markReaderIndex();
    int length = in.readInt();
    
    if (in.readableBytes() < length) {
        in.resetReaderIndex();  // 回退，等待完整 payload
        return;
    }
    
    // 读取 payload
    byte[] payload = new byte[length];
    in.readBytes(payload);
    out.add(new MyMessage(length, payload));
}
```

### 6.2 ReplayingDecoder：伪阻塞式写法

`ReplayingDecoder` 通过一个特殊的 `ReplayingDecoderByteBuf` 包装原始缓冲区——当读取操作发现数据不足时，自动抛出 `Signal.REPLAY`（一种特殊异常），`ReplayingDecoder` 捕获后回退 `readerIndex` 并退出，等待更多数据：

```java
// 简洁的 ReplayingDecoder 写法
public class MyDecoder extends ReplayingDecoder<Void> {
    @Override
    protected void decode(ChannelHandlerContext ctx, ByteBuf in, List<Object> out) {
        // 不需要手动检查 readableBytes！数据不够时会自动重试
        int length = in.readInt();      // 如果不够 4 字节，自动触发等待
        byte[] payload = new byte[length];
        in.readBytes(payload);          // 如果不够 length 字节，自动触发等待
        out.add(new MyMessage(length, payload));
    }
}
```

`ReplayingDecoder` 的优点是代码更简洁（无需 `markReaderIndex()`/`resetReaderIndex()`）；缺点是每次数据不足都需要重新执行整个 `decode()` 方法（从头重读已读过的字段），有一定的重复计算。对于复杂协议，可以配合 `ReplayingDecoder<State>` 的泛型参数维护解析状态（状态机），避免重复读取。

---

## 总结

TCP 粘包/拆包是网络编程无法回避的基础问题，Netty 通过标准化的编解码器体系彻底解决了它：

- **`ByteToMessageDecoder` 提供累积缓冲区框架**：`cumulation` 字段跨多次 `channelRead()` 积累不完整数据，`callDecode()` 循环驱动解析，自动处理粘包（多条消息一次解析）和拆包（等待数据完整）；

- **四种内置帧解码器覆盖主流场景**：`FixedLengthFrameDecoder`（固定长度）、`DelimiterBasedFrameDecoder`（分隔符）、`LineBasedFrameDecoder`（换行符）、`LengthFieldBasedFrameDecoder`（长度前缀，最通用）；

- **`LengthFieldBasedFrameDecoder` 的六参数**是核心：`maxFrameLength`（安全上限）、`lengthFieldOffset`（长度字段位置）、`lengthFieldLength`（长度字段字节数）、`lengthAdjustment`（长度值修正量）、`initialBytesToStrip`（解码后跳过字节数）；掌握 `lengthAdjustment` 的本质——补偿长度字段值与实际消息体字节数的差距；

- **自定义协议 = 解码器（帧切割 + 字段解析）+ 编码器（字段序列化 + ByteBuf 写出）**：`LengthFieldBasedFrameDecoder` 负责帧切割，子类 `decode()` 负责字段解析；`MessageToByteEncoder` 提供 `ByteBuf` 分配和消息类型检查，子类 `encode()` 负责写入字段；

- **`ReplayingDecoder` 提供伪阻塞式解码写法**，消除手动的 `readableBytes` 检查，适合协议结构清晰的简单场景。

下一篇深入 Netty 内存管理的底层实现——`PooledByteBufAllocator` 如何借鉴 jemalloc 的 Chunk/Page/SubPage 三级分配体系管理堆外内存：[[07 Netty内存管理——jemalloc算法在Java中的实现]]。

---

> [!note] 参考资料
> - `io.netty.handler.codec.ByteToMessageDecoder` 源码
> - `io.netty.handler.codec.LengthFieldBasedFrameDecoder` 源码（含详细注释和 Javadoc 示例）
> - `io.netty.handler.codec.MessageToByteEncoder` 源码
> - Norman Maurer,《Netty in Action》第 10 章 编解码框架

---

> [!note] 思考题
> 1. Netty 的 HTTP 编解码器将 HTTP 请求解析为 `HttpRequest`（Headers）和 `HttpContent`（Body）两个独立的消息。如果 Body 很大（如文件上传），`HttpObjectAggregator` 会将所有 `HttpContent` 聚合为 `FullHttpRequest`。在处理大文件上传时，`HttpObjectAggregator` 会导致什么问题？Netty 提供了什么替代方案（如 `HttpChunkedInput`）？
> 2. WebSocket 连接是从 HTTP Upgrade 握手开始的。Netty 的 `WebSocketServerProtocolHandler` 自动处理握手过程。握手完成后，Pipeline 中的 HTTP 编解码器会被自动移除并替换为 WebSocket 帧编解码器。如果你需要在同一个端口上同时支持 HTTP 和 WebSocket（如 REST API + 实时推送），Pipeline 应该如何设计？
> 3. WebSocket 的 `CloseFrame` 要求双方都发送关闭帧才能完成优雅关闭。如果客户端直接断开 TCP 连接（不发送 CloseFrame），服务端如何检测？Netty 的 `IdleStateHandler` 在 WebSocket 场景中扮演什么角色？心跳间隔设置过短或过长分别有什么风险？
