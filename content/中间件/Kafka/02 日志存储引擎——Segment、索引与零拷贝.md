---
title: "日志存储引擎——Segment、索引与零拷贝"
date: 2026-03-04
tags: [Kafka, Page Cache, Segment, sendfile, 中间件, 日志存储, 稀疏索引, 零拷贝, 顺序写]
aliases: []
---

# 日志存储引擎——Segment、索引与零拷贝

## 摘要

Kafka 能够在普通机械硬盘上实现百万级消息每秒的吞吐量，背后有三个相互配合的核心技术：**追加顺序写**（避免随机 IO）、**[[Page Cache]] 充分利用**（读写热数据走内存而非磁盘）、以及 **`sendfile` 零拷贝**（Consumer Fetch 时绕过用户态，直接从内核传输到网络）。这三项技术叠加的前提，是 Kafka 精心设计的日志文件格式——每个 Partition 对应一组 Segment 文件，每个 Segment 包含 `.log`（消息数据）、`.index`（偏移量稀疏索引）、`.timeindex`（时间戳稀疏索引）三种文件，通过二分查找实现 O(log N) 级别的消息定位。本文深入剖析这套存储引擎的设计逻辑。

---

## 第 1 章 从磁盘性能说起：为什么 Kafka 不慢

### 1.1 磁盘的真正性能曲线

在很多工程师的直觉中，"写磁盘"等于"慢"——这个直觉来自于数据库场景中大量的**随机写**（B+ 树更新需要在任意位置修改页）。但这个直觉在 Kafka 的场景中是错误的。

机械磁盘（HDD）的寻道时间约 5-10ms，但**顺序读写速度**可以达到 100-200 MB/s（SSD 更快）。[ACM Queue 的一项研究](https://queue.acm.org/detail.cfm?id=1563874) 表明，顺序磁盘 IO 甚至可以比随机内存访问（如跳表遍历、哈希表碰撞）更快——这乍听违反直觉，但原因在于：操作系统会进行磁盘预读（Read-ahead），顺序访问时预读命中率极高，使得磁盘读取延迟被 Page Cache 完全吸收。

Kafka 的日志写入是**追加写**——新消息永远追加到当前 Segment 的末尾，不修改已有数据，这是天然的顺序写。

### 1.2 Page Cache 的战略意义

**[[Page Cache]]** 是 Linux 内核中的磁盘文件缓存。当应用程序写文件时，数据首先写入内核的 Page Cache（内存），内核异步地将 Page Cache 中的"脏页"刷写到磁盘（pdflush/bdflush 线程）。当应用程序读文件时，如果对应数据已在 Page Cache 中，直接返回内存数据，不触发磁盘 IO。

Kafka 大量利用 Page Cache 的方式：

**写入路径**：Producer 消息 → Broker 追加到 `.log` 文件 → 实际写入 OS Page Cache（用户态通过 `write()` 系统调用）→ OS 后台异步刷盘。对于 Producer 来说，写入延迟是内存级别的，不是磁盘级别的。

**消费路径（热数据）**：Consumer Fetch 刚写入的消息 → 数据在 Page Cache 中 → 内核直接从 Page Cache 发送到网络（零拷贝），不触发磁盘 IO。在实时消费的场景中（Consumer 消费进度接近 Producer 的生产进度），消息几乎完全通过 Page Cache 传递，磁盘只是持久化备份。

**消费路径（冷数据）**：Consumer Fetch 历史消息 → 数据不在 Page Cache → 触发磁盘 IO 读取 → 读取结果写入 Page Cache → 发送到网络。

这解释了 Kafka 为何**不建议为 Kafka 进程分配大 JVM Heap**——Heap 越大，操作系统能用于 Page Cache 的物理内存就越少，冷数据读取性能就越差。通常建议 Kafka 的 JVM Heap 不超过 6GB，剩余内存留给 Page Cache。

> [!warning] 生产避坑：与 Kafka Broker 共部署其他内存密集型应用
> Kafka 的性能高度依赖 Page Cache。如果在同一台机器上与 Flink TaskManager 或 Spark Worker 共部署，这些 JVM 进程的大内存会挤占 Page Cache，导致 Kafka 的冷数据读取性能大幅下降。生产环境应为 Kafka Broker 提供专用机器，或至少确保有足够物理内存（建议 Page Cache 至少能容纳最近 24 小时的活跃数据量）。

---

## 第 2 章 Partition 的物理存储结构

### 2.1 Segment：日志文件的分片单位

每个 Partition 在磁盘上对应一个目录（如 `orders-0/` 代表 Topic `orders` 的第 0 个 Partition）。目录内有一组 **Segment 文件**，每个 Segment 由三个文件组成：

```
orders-0/
├── 00000000000000000000.log        # 消息数据文件
├── 00000000000000000000.index      # 偏移量稀疏索引
├── 00000000000000000000.timeindex  # 时间戳稀疏索引
├── 00000000000000012345.log        # 新 Segment（当前活跃写入的 Segment）
├── 00000000000000012345.index
├── 00000000000000012345.timeindex
└── leader-epoch-checkpoint         # Leader Epoch 检查点
```

**文件名即起始 Offset**：Segment 文件名是该 Segment 中第一条消息的 Offset，补零到 20 位。`00000000000000000000.log` 从 Offset=0 开始，`00000000000000012345.log` 从 Offset=12345 开始。这个命名规则让 Kafka 可以通过**二分查找**快速定位某个 Offset 属于哪个 Segment：将所有 Segment 的起始 Offset 排序，二分找到最大的不超过目标 Offset 的 Segment 即可。

**Segment 的滚动（Rolling）**：当前活跃的 Segment 满足以下任一条件时，会 "滚动"（创建新 Segment）：
- 大小超过 `log.segment.bytes`（默认 1GB）；
- 时间超过 `log.roll.hours`（默认 168 小时）；
- 索引文件大小超过 `log.index.size.max.bytes`（默认 10MB）；
- 消息时间戳差值超过 `log.roll.ms`。

滚动后，旧 Segment 变为**不可变的只读文件**，新 Segment 继续接收写入。只读 Segment 正是零拷贝的理想场景——内容不变，OS 可以安全地缓存和传输。

### 2.2 .log 文件：消息的物理存储格式

`.log` 文件是实际存储消息的文件，采用**二进制格式**，消息以 **RecordBatch** 为单位追加（一次 Producer 发送的批量消息组成一个 RecordBatch）。

RecordBatch 的结构（Kafka 2.0+ 的 Magic v2 格式）：

```
RecordBatch:
  base_offset          (int64)   : 批次中第一条消息的 Offset
  batch_length         (int32)   : 批次总长度（字节）
  partition_leader_epoch (int32) : Leader Epoch（用于防止数据截断）
  magic                (int8)    : 格式版本号（当前为 2）
  attributes           (int16)   : 压缩类型、时间戳类型等标志位
  last_offset_delta    (int32)   : 批次内最后一条消息的相对 Offset
  base_timestamp       (int64)   : 批次内第一条消息的时间戳
  max_timestamp        (int64)   : 批次内最大时间戳
  producer_id          (int64)   : 幂等 Producer 的 ID（-1 表示非幂等）
  producer_epoch       (int16)   : 事务 Producer 的 Epoch
  base_sequence        (int32)   : 幂等 Producer 的序列号起始值
  records_count        (int32)   : 批次内消息数量
  records              (Record[]):每条消息
```

每条 Record 的相对偏移（`offset_delta`）、时间戳增量（`timestamp_delta`）、Key、Value 以 Varint 编码存储，进一步压缩存储空间。批次级别的压缩（Snappy/LZ4/Zstd）也在 RecordBatch 层面进行——对整个批次的 records 部分压缩，压缩率比逐条压缩高得多（相似内容的批量消息有更多可压缩的重复模式）。

### 2.3 .index 文件：偏移量稀疏索引

如果每条消息都在 `.index` 中建立索引，索引文件会和数据文件一样大，白白消耗存储和内存。Kafka 采用**稀疏索引（Sparse Index）**策略——不是每条消息建立索引，而是每隔约 `log.index.interval.bytes`（默认 4096 字节，即 4KB）的数据量建立一个索引条目。

每个索引条目是一个 **8 字节的定长记录**：
```
index entry:
  relative_offset (int32)  : 相对于 Segment 起始 Offset 的偏移量（差值）
  physical_position (int32): 对应消息在 .log 文件中的字节偏移量（文件位置）
```

使用相对偏移（而非绝对 Offset）节省了存储空间，因为 Offset 值可能很大（64位整数），但相对偏移在一个 Segment 内是 0 到约数万的小整数（4 字节足够）。

**通过 .index 定位消息的过程**：

```
目标：找到 Offset = 12350 的消息

第一步：确定目标 Segment
    所有 Segment 起始 Offset 排序：[0, 12345, 20000, ...]
    12350 最接近且不超过 12345，目标 Segment 是 00000000000000012345.log

第二步：在 .index 中二分查找
    加载 00000000000000012345.index（文件小，可全部 mmap 到内存）
    索引条目按 relative_offset 有序，二分查找最大的 relative_offset ≤ (12350-12345) = 5
    假设找到条目：(relative_offset=4, physical_position=8192)

第三步：从 .log 文件顺序扫描
    从 .log 文件的字节位置 8192 开始，顺序读取 RecordBatch
    逐条比对 Offset，直到找到 Offset = 12350
```

稀疏索引的设计权衡：
- 索引条目少 → 索引文件小 → 可以全部 `mmap` 映射到内存，二分查找极快；
- 但找到索引条目后还需要顺序扫描 `.log` 文件中最多 4KB 的数据才能精确定位目标消息。这 4KB 的顺序扫描代价在实际场景中可以忽略不计（4KB 是一个内存页的大小，几乎总是已在 Page Cache 中）。

### 2.4 .timeindex 文件：时间戳稀疏索引

`.timeindex` 文件用于**基于时间戳查找消息**（`offsetsForTimes()` API），结构类似 `.index`，但存储的是 `(timestamp, relative_offset)` 对而非 `(relative_offset, physical_position)` 对。

典型使用场景：Consumer 想从"2小时前"的消息开始消费，可以先用 `offsetsForTimes()` 将时间戳转换为 Offset，再从该 Offset 开始消费。

---

## 第 3 章 零拷贝：sendfile 的工程实现

### 3.1 传统文件传输的四次拷贝问题

在介绍 Kafka 的零拷贝之前，先理解传统方式（如 Web 服务器发送静态文件）的数据路径：

```
传统方式：read() + write() 的四次拷贝

磁盘 → DMA → 内核 Page Cache       (第1次拷贝：DMA)
内核 Page Cache → 用户空间缓冲区    (第2次拷贝：CPU)
用户空间缓冲区 → 内核 Socket Buffer (第3次拷贝：CPU)
内核 Socket Buffer → 网卡 DMA       (第4次拷贝：DMA)
```

4 次数据拷贝，其中 2 次是 CPU 参与的（内核↔用户空间的拷贝），且需要 4 次用户态/内核态的上下文切换（2 次 read，2 次 write）。在 Kafka 的 Consumer Fetch 场景中，数据从磁盘文件传输到网络，走传统路径性能损耗巨大。

### 3.2 sendfile 零拷贝：2 次拷贝，0 次 CPU 拷贝

Linux 2.1 引入了 `sendfile()` 系统调用，允许操作系统直接将文件描述符的数据发送到 Socket，不经过用户空间：

```
sendfile() 零拷贝路径：

磁盘 → DMA → 内核 Page Cache          (第1次拷贝：DMA)
内核 Page Cache → 内核 Socket Buffer   (第2次拷贝：CPU，但 Linux 2.4+ 可进一步优化)
内核 Socket Buffer → 网卡 DMA          (第3次拷贝：DMA)

Linux 2.4+ Scatter-Gather DMA 进一步优化：
磁盘 → DMA → 内核 Page Cache
内核 Page Cache 的地址/长度信息 → Socket Buffer（仅复制描述符，无数据拷贝）
内核 Page Cache → 网卡 DMA             (实际只有 2 次 DMA 拷贝，0 次 CPU 数据拷贝)
```

Kafka 在 Java 层面通过 `FileChannel.transferTo()` 调用底层的 `sendfile()`。这使得 Consumer Fetch 时，`.log` 文件的数据**直接从 Page Cache（或磁盘）传输到网络 Socket**，全程不经过 Kafka 的 JVM 用户空间——Kafka 代码中看不到"读取消息数据"的 Java 代码，因为数据根本没有进入 JVM 堆内存。

**零拷贝的前提条件**：数据在传输过程中不需要修改（不能压缩、不能加密、不能修改内容）。Kafka 在 Broker 端不对消息数据进行任何修改，消息从 Producer 压缩后发到 Broker，Broker 原样存储，Consumer 拉取时原样发出——这个"原样传输"的设计是零拷贝的前提，也是 Kafka 架构中一个重要的约束。

> [!info] 核心概念：为什么不在 Broker 端解压后重压
> 有些场景需要 Broker 端解压消息（如 Offset 赋值），但 Kafka 的设计尽量避免这种操作。如果 Producer 用 LZ4 压缩发送，Broker 验证 CRC 后原样存储 LZ4 压缩数据，Consumer 拉取后在客户端解压——Broker 全程不接触消息内容。这是"传输型 Broker"而非"处理型 Broker"的设计哲学。

---

## 第 4 章 日志清理：保留策略与 Compaction

### 4.1 基于时间和大小的日志删除

Kafka 默认的日志保留策略是**基于时间删除**：超过 `log.retention.hours`（默认 168 小时，7天）的 Segment 会被删除。

删除的粒度是整个 Segment，而不是单条消息。一个 Segment 只有在其**最新消息的时间戳**超过保留时间后，整个文件才会被删除。这意味着：如果一个 Segment 有 100 万条消息，其中最老的消息已经超过 7 天，但最新的消息只有 6 天，这个 Segment 仍然不会被删除（要等到整个 Segment 的消息都过期）。这在 Segment 很大（1GB）时可能导致轻微的"超时保留"，但工程上完全可以接受。

也可以配置基于大小的保留：`log.retention.bytes` 控制 Partition 的最大总大小，超过后删除最老的 Segment。

### 4.2 Log Compaction：为键值语义设计的压实策略

除了删除外，Kafka 还支持 **Log Compaction（日志压实）**，这是一种不同于删除的保留策略。

**适用场景**：当 Kafka 被用作键值存储的变更日志（如 Change Data Capture、数据库的状态快照）时，对于同一个 Key，只需保留**最新的**那条消息（代表当前状态），历史状态记录可以清理。

**工作原理**：后台的 Log Cleaner 线程定期扫描 Partition 的日志，对每个 Key 保留最新的一条消息，删除相同 Key 的历史旧消息。

```
压实前：
Offset: 0  Key:user1 Value:age=18
Offset: 1  Key:user2 Value:age=25
Offset: 2  Key:user1 Value:age=19  ← user1 的更新
Offset: 3  Key:user1 Value:age=20  ← user1 的再次更新

压实后：
Offset: 1  Key:user2 Value:age=25
Offset: 3  Key:user1 Value:age=20  ← 只保留最新值
```

压实策略让 Kafka 能存储任意长时间的**最终状态**（而不只是最近 7 天的历史），这是 Kafka Streams 中 KTable（状态流）的存储基础。

---

## 总结

本篇深入剖析了 Kafka 日志存储引擎的三层机制：

**文件格式**：Partition 目录 → Segment 三件套（.log + .index + .timeindex）。Segment 的分段设计让老数据清理变为文件删除操作，名字即起始 Offset 让 Segment 定位可以二分查找。

**稀疏索引**：每 4KB 数据一个索引条目，索引文件足够小可以全量 mmap；Offset 查找 = Segment 二分 + 索引二分 + 顺序扫描 ≤ 4KB，整体 O(log N) 复杂度。

**性能三件套**：顺序追加写避免随机 IO → Page Cache 吸收读写延迟 → `sendfile` 零拷贝将 Consumer Fetch 的 CPU 拷贝次数降为 0，三者合力支撑百万级 TPS。

下一篇深入生产者的分区策略、幂等性与事务：[[03 生产者——分区策略、acks 与幂等性]]。

---

> [!note] 参考资料
> - Apache Kafka 文档,《Log Compaction》
> - 《Kafka: The Definitive Guide》, Chapter 5: Kafka Internals
> - Linux `sendfile()` man page
> - Brendan Gregg,《Systems Performance》, Chapter on File Systems

---

> [!note] 思考题
> 1. Producer 的分区策略决定消息发往哪个 Partition。默认的 Sticky Partitioner 在同一 batch 内将消息发往同一 Partition（提升 batch 效率）。如果消息有 Key，按 Key 的 hash 值分区——保证相同 Key 的消息有序。在订单消息场景中（按 order_id 分区），如果某些 order_id 的消息量远大于其他（如热门商品），会导致 Partition 间数据倾斜——你如何缓解？
> 2. Kafka 的幂等生产者（`enable.idempotence=true`）通过 Producer ID + Sequence Number 在 Broker 端去重——保证单 Partition 内不丢不重。但幂等只保证单会话（单 Producer 实例）内的去重。如果 Producer 重启（新的 Producer ID），之前的 Sequence 记录丢失——是否可能产生重复消息？事务（`transactional.id`）如何解决跨会话的 exactly-once？
> 3. `acks` 参数控制写入确认级别：`acks=0`（不等确认）、`acks=1`（Leader 确认）、`acks=all`（所有 ISR 确认）。`acks=all` + `min.insync.replicas=2` 保证至少 2 个副本写入成功。在一个 3 副本的 Partition 中，如果 ISR 缩减到只有 Leader 一个节点，`acks=all` + `min.insync.replicas=2` 会导致什么？消息会被拒绝还是降级为 `acks=1`？
