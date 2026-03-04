---
title: "生产者——分区策略、acks 与幂等性"
date: 2026-03-04
tags: [中间件, Kafka, Producer, 分区策略, acks, 幂等性, 事务消息, 精确一次]
aliases: []
---

# 生产者——分区策略、acks 与幂等性

## 摘要

Kafka Producer 是连接应用代码与 Kafka 集群的桥梁，其设计远比"发消息"三个字复杂：分区策略决定了负载均衡和顺序性的取舍；`acks` 参数是可靠性与吞吐量的关键旋钮；幂等生产者（Idempotent Producer）通过 PID + Sequence Number 机制彻底解决了网络重试导致的消息重复问题；事务 API 则在幂等基础上提供跨多 Partition 的原子写入能力，是 Exactly-Once 语义的Producer 端保障。本文从 Producer 的完整发送流水线出发，深入剖析每一层抽象的设计动机与实现原理。

---

## 第 1 章 Producer 发送流水线

### 1.1 从 send() 到网络发送的完整链路

调用 `producer.send(record)` 之后，消息并不会立刻被发送到 Kafka，而是经历一条精心设计的流水线：

```
应用线程调用 send()
        ↓
  [1] 序列化器 (Serializer)
        ↓
  [2] 分区器 (Partitioner)
        ↓
  [3] RecordAccumulator（消息累积器）
        │
        ├── Partition 0 的 Deque<RecordBatch>
        ├── Partition 1 的 Deque<RecordBatch>
        └── Partition N 的 RecordBatch（当前正在写入）
        
Sender 线程（后台）
        ↓
  [4] 从 Accumulator 拉取就绪的 Batch
        ↓
  [5] 创建 ProduceRequest（按 Broker 聚合）
        ↓
  [6] 通过 NetworkClient 发送（Kafka 自实现的 NIO 客户端）
        ↓
  [7] 接收 Broker 响应，触发 Callback
```

这条流水线的关键设计是**应用线程与 IO 线程的分离**：应用线程（调用 `send()` 的线程）只负责序列化和将消息放入 Accumulator，不做任何网络 IO；专门的 **Sender 线程**（后台单线程）负责从 Accumulator 批量拉取消息并发送。这种设计让 `send()` 的调用几乎不阻塞（只是内存操作），应用线程不会因网络延迟而挂起。

### 1.2 RecordAccumulator：批量化的核心

**RecordAccumulator** 是 Producer 的内存缓冲区，其核心数据结构是：

```java
// 简化的内部结构（概念性表示）
Map<TopicPartition, Deque<RecordBatch>> batches;
```

每个 TopicPartition（Topic + Partition 的组合）对应一个双端队列，队列末尾是当前正在写入的 RecordBatch。`send()` 的消息被追加到对应 Partition 的最后一个 RecordBatch 中。

RecordBatch 被发送的触发条件：
- **大小达到 `batch.size`**（默认 16384 字节，即 16KB）：Batch 满了，Sender 线程拉走发送；
- **等待超过 `linger.ms`**（默认 0ms）：Batch 未满但等待时间到，也发送。

`linger.ms=0` 意味着消息进来就立即发送（Batch 几乎永远是空的），延迟最低但批量效果最差；`linger.ms=5` 意味着最多等待 5ms 攒一批再发，吞吐量显著提升，延迟略微增加（5ms 对大多数异步场景完全可接受）。**生产环境通常将 `linger.ms` 设为 5-20ms 以换取更好的吞吐量**。

Accumulator 的总内存大小受 `buffer.memory` 控制（默认 32MB）。当消息产生速度超过 Sender 发送速度时，Accumulator 会被填满，此时 `send()` 调用会阻塞，最长阻塞 `max.block.ms`（默认 60 秒）。如果超时仍未有空间，抛出 `TimeoutException`。

---

## 第 2 章 分区策略：负载均衡与顺序性的取舍

### 2.1 三种内置分区策略的设计原理

**策略一：RoundRobinPartitioner**（轮询，Key 为 null 时的早期默认策略）

消息依次分配到 Partition 0、1、2、0、1、2...，保证均匀分布。但问题在于：每条消息可能落到不同 Partition，导致每个 RecordBatch 中只有少量消息，批量效果差，网络请求次数多。

**策略二：StickyPartitioner**（粘性分区，Kafka 2.4+ 的新默认策略）

粘性分区器的核心思想：**在一个 Batch 写满或超时之前，将消息"粘性地"发送到同一个 Partition，满足条件后再随机换一个 Partition**。

这个策略解决了 RoundRobin 的批量问题：同一时间段内的消息被集中到一个 Partition 的 RecordBatch，Batch 更容易写满，单次网络请求携带更多消息，吞吐量显著提升。同时，长期来看消息仍然均匀分布在各 Partition（因为每次换 Partition 是随机的）。

**策略三：HashPartitioner**（Key 哈希，Key 不为 null 时使用）

对消息的 Key 计算 `murmur2` 哈希值，然后对 Partition 数量取模。相同的 Key 总是路由到同一个 Partition——这是保证**同一 Key 的消息有序**的唯一方式。

> [!warning] 生产避坑：哈希分区的数据倾斜问题
> 如果 Key 的分布不均匀（如某个用户的行为远多于其他用户），大量消息会集中在某一个 Partition，导致**数据倾斜**——该 Partition 的 Leader Broker 成为热点，消费该 Partition 的 Consumer 压力远大于其他 Consumer。解决方案：在 Key 中引入随机前缀（如 `userId + random(0,10)`），在牺牲局部顺序性的前提下缓解倾斜，或者使用自定义 Partitioner 实现更均匀的分配策略。

### 2.2 自定义 Partitioner

```java
// 自定义分区器：VIP 用户的消息优先进入 Partition 0
public class VipFirstPartitioner implements Partitioner {
    
    @Override
    public int partition(String topic, Object key, byte[] keyBytes,
                         Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();
        
        // VIP 用户标识（key 以 "VIP:" 开头）
        if (key != null && keyBytes != null && 
            new String(keyBytes).startsWith("VIP:")) {
            return 0;  // VIP 消息总是进 Partition 0
        }
        
        // 普通用户使用 murmur2 哈希
        if (keyBytes == null) {
            // 无 key 时随机选择（简化版）
            return ThreadLocalRandom.current().nextInt(1, numPartitions);
        }
        return (Utils.murmur2(keyBytes) & Integer.MAX_VALUE) % (numPartitions - 1) + 1;
    }
    
    @Override
    public void close() {}
    
    @Override  
    public void configure(Map<String, ?> configs) {}
}
```

---

## 第 3 章 acks 与可靠性保证

### 3.1 acks 参数的三个级别

`acks`（acknowledgments）参数控制 Broker 在什么条件下向 Producer 返回成功响应，直接决定了消息的**持久性保证级别**：

**`acks=0`：火力全开，可能丢消息**

Producer 发送完消息立即认为成功，不等待任何 Broker 响应。Broker 甚至不需要收到消息就可以"成功"（如果网络中断，消息根本没到 Broker）。

适用场景：日志采集（如收集 Web 服务器的访问日志），偶尔丢失几条可以接受，追求极致吞吐量。

**`acks=1`：Leader 确认，存在丢消息风险**

等待 Leader 将消息写入本地日志（不一定刷盘）后返回成功。但在 Follower 还没来得及同步这条消息之前，如果 Leader 宕机，这条消息就丢失了（新 Leader 没有这条消息，且 Producer 以为已经成功）。

这是 Kafka 的**默认配置**——在大多数场景下，`acks=1` 已经足够可靠，且性能比 `acks=all` 更好。

**`acks=all`（或 `acks=-1`）：所有 ISR 确认，最强保证**

等待所有 **In-Sync Replicas（ISR，同步副本集合）** 写入成功后才返回。即使 Leader 在返回响应后立即宕机，也不会丢消息——因为至少有一个 Follower 已经同步了这条消息，它会被选为新 Leader。

但 `acks=all` 有一个隐患：如果 ISR 中只剩 Leader 自己（所有 Follower 都落后太多被踢出 ISR），`acks=all` 退化为 `acks=1`，失去保护意义。

**最强可靠性配置组合**：

```properties
acks=all
min.insync.replicas=2   # 至少 2 个 ISR 副本确认才算写入成功
replication.factor=3    # 总副本数 3，允许最多 1 个宕机
```

在这个配置下，即使 1 个 Broker 宕机，仍有 2 个 ISR 副本，消息不丢。如果 2 个 Broker 同时宕机，ISR 只剩 1 个，低于 `min.insync.replicas=2`，Producer 写入会收到 `NotEnoughReplicasException`，但这比静默丢数据要好得多——应用可以感知到问题。

### 3.2 `retries` 与幂等性的必要性

网络是不可靠的。即使 Broker 成功写入消息并返回了 ACK，ACK 也可能在传输途中丢失——Producer 没有收到 ACK，认为发送失败，触发重试。这次重试会导致消息**重复写入**。

在 Kafka 0.11 之前，这个问题没有内置解决方案——开发者要么接受 at-least-once（至少一次）语义（允许重复），要么在业务层实现幂等（如数据库 unique key）。

---

## 第 4 章 幂等生产者：精确一次的 Producer 端保障

### 4.1 幂等性的问题定义

Producer 重试会导致消息重复，核心问题在于 **Broker 无法区分"这是第一次发送"还是"这是重试发送"**——两次请求携带的内容完全相同，Broker 无从判断。

解决幂等性问题需要给每次发送请求一个**唯一标识（去重键）**，Broker 记录已处理的标识，重试请求携带相同标识时，Broker 识别为重复并返回成功但不再重复写入。

### 4.2 PID + Sequence Number 机制

Kafka 0.11 引入**幂等生产者**（通过 `enable.idempotence=true` 启用），核心机制是两个标识符：

**PID（Producer ID）**：每个 Producer 实例在启动时向 Broker 申请一个唯一的 64 位整数 ID。PID 在 Producer 生命周期内保持不变，但 **Producer 重启后 PID 会改变**（申请新 PID）——这意味着幂等性保证仅限于单次 Producer 会话内，不能跨重启。

**Sequence Number（序列号）**：Producer 为每个 TopicPartition 维护一个单调递增的序列号（从 0 开始，每次发送 Batch 后 +1）。每个 ProduceRequest 携带 `(PID, Partition, SequenceNumber)`。

Broker 端为每个 `(PID, Partition)` 维护一个最近接收的 Sequence Number。当收到 ProduceRequest 时：

```
if (requestSeqNum == expectedSeqNum):
    接受写入，expectedSeqNum += 1
elif (requestSeqNum < expectedSeqNum):
    这是重复请求（已处理过），返回成功但不写入
elif (requestSeqNum > expectedSeqNum + 1):
    序列号乱序（可能有消息丢失），返回 OutOfOrderSequenceException
```

这个机制保证了：
- **去重**：重试请求携带相同 Sequence Number，Broker 识别为重复并忽略；
- **有序**：Sequence Number 单调递增，Broker 检测乱序并报错（防止 Batch 乱序到达的情况）。

> [!info] 核心概念：启用幂等性的自动配置变化
> `enable.idempotence=true` 会自动将 `acks` 强制设置为 `all`，`retries` 设置为 `Integer.MAX_VALUE`，`max.in.flight.requests.per.connection` 设置为 ≤5——这三个配置是幂等性语义的前提。Kafka 会在启动时验证这些配置的一致性，不满足时抛出 `ConfigException`。

### 4.3 幂等性的局限：单 Producer 会话，单 Partition

幂等生产者的保证范围是**单个 Producer 实例的单个 Partition**：

- **不跨 Producer 重启**：PID 在重启后改变，新 PID 对 Broker 来说是全新的 Producer，无法识别重启前的重复。
- **不跨 Partition**：幂等性保证每个 TopicPartition 独立，无法保证跨多个 Partition 的原子性。

要跨越这些限制（跨 Partition 原子写入、跨重启的幂等），需要使用**事务 API**。

---

## 第 5 章 事务 API：跨 Partition 的原子写入

### 5.1 事务的使用场景

Kafka 事务主要用于**流处理中的 Exactly-Once**：从 Topic A 消费消息，处理后写入 Topic B，同时提交 Consumer Offset——这三个操作（写 Topic B + 提交 Offset）必须原子完成，要么全部成功，要么全部失败，否则会出现处理了消息但没提交 Offset（重复处理）或提交了 Offset 但没写出结果（数据丢失）的情况。

```java
// Kafka 事务 API 使用示例
Properties props = new Properties();
props.put("transactional.id", "order-processor-1");  // 全局唯一的事务 ID
props.put("enable.idempotence", "true");

KafkaProducer<String, String> producer = new KafkaProducer<>(props);
producer.initTransactions();  // 向 Transaction Coordinator 注册

try {
    producer.beginTransaction();
    
    // 写入多个 Partition（原子）
    producer.send(new ProducerRecord<>("output-topic", key, processedValue));
    producer.send(new ProducerRecord<>("audit-topic", key, auditRecord));
    
    // 提交 Consumer Offset（原子，消费偏移量也在事务范围内）
    producer.sendOffsetsToTransaction(
        Collections.singletonMap(new TopicPartition("input-topic", 0),
                                 new OffsetAndMetadata(offset + 1)),
        consumerGroup
    );
    
    producer.commitTransaction();  // 原子提交
} catch (ProducerFencedException e) {
    // 同一 transactional.id 的其他 Producer 实例已接管，当前实例被"隔离"
    producer.close();
} catch (KafkaException e) {
    producer.abortTransaction();  // 回滚，消费者看不到这些消息
}
```

### 5.2 Transaction Coordinator 与两阶段提交

Kafka 事务基于**两阶段提交（2PC）**实现，由 **Transaction Coordinator**（每个 Broker 可以担任部分 Producer 的 Transaction Coordinator）协调：

**阶段一：Prepare（准备）**

Producer 调用 `commitTransaction()` 时，发送 `EndTransaction` 请求给 Transaction Coordinator。Coordinator 将事务状态记录到内部 Topic `__transaction_state`（`PREPARE_COMMIT`）。这是持久化的，Coordinator 宕机重启后可以继续推进事务。

**阶段二：Commit（提交）**

Coordinator 向所有参与该事务的 Partition 的 Leader Broker 发送 `WriteTxnMarkers` 请求，写入一个特殊的**事务控制消息（Transaction Marker）**：COMMIT 标记。Consumer 只有看到 COMMIT 标记后，才认为事务内的消息可以消费（通过 `isolation.level=read_committed` 配置）。

```
事务写入过程（消费者视角）：

Partition 日志：
  Offset 100: msg1 (事务内, PID=42, SeqNum=0)
  Offset 101: msg2 (事务内, PID=42, SeqNum=1)
  Offset 102: msg3 (非事务消息)
  Offset 103: [COMMIT MARKER for PID=42]  ← Coordinator 写入

read_committed 消费者：看到 COMMIT MARKER 后，msg1 和 msg2 才变为可见
read_uncommitted 消费者：msg1、msg2 立即可见（不管事务是否提交）
```

### 5.3 transactional.id 与 Zombie Fencing

**`transactional.id`** 是事务 Producer 的全局唯一标识符（与 PID 不同：PID 每次启动都变，transactional.id 是固定配置的字符串）。它的核心作用是**跨重启的事务 Producer 唯一标识**和 **Zombie Fencing（僵尸隔离）**。

Zombie Fencing 解决的问题：假设 Producer 在事务中途宕机并重启，旧的 Producer 进程（"僵尸"）可能仍然存活（网络分区隔离），试图继续提交旧事务。新启动的 Producer 通过同一 `transactional.id` 向 Transaction Coordinator 注册时，Coordinator 会递增一个 **Producer Epoch**。当旧 Producer 再次发出请求时，Coordinator 发现其 Epoch 低于当前 Epoch，返回 `ProducerFencedException`——旧 Producer 被"隔离"，无法继续操作，防止两个 Producer 同时推进同一事务。

---

## 总结

本篇系统剖析了 Kafka Producer 的三个核心维度：

**发送流水线**：应用线程只做序列化 + 分区 + 放入 Accumulator，Sender 线程异步批量发送。`batch.size` 控制 Batch 大小，`linger.ms` 控制等待时间——两个参数共同决定了吞吐量与延迟的平衡点。

**分区策略**：无 Key 时 StickyPartitioner 攒批发送（吞吐优先）；有 Key 时 HashPartitioner 保证同 Key 有序（但注意数据倾斜风险）；自定义 Partitioner 满足特殊路由需求。

**可靠性层次**：`acks=0` 牺牲可靠性换吞吐 → `acks=1` 默认平衡 → `acks=all` + `min.insync.replicas=2` 最强保证。幂等生产者（PID + Sequence Number）解决单 Partition 的重复写问题；事务 API 通过 2PC 和 Zombie Fencing 提供跨 Partition 的原子写入，是 Exactly-Once 流处理的基础。

下一篇深入消费者组的 Rebalance 机制：[[04 消费者与消费者组——Rebalance 机制深度剖析]]。

---

> [!note] 参考资料
> - Apache Kafka 文档,《Producer Configs》
> - Confluent Blog,《Exactly-Once Semantics Are Possible: Here's How Kafka Does It》
> - KIP-98: Exactly Once Delivery and Transactional Messaging
> - KIP-480: Sticky Partitioner
