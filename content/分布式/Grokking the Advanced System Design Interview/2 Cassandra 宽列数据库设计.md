# 2 Cassandra：如何设计宽列 NoSQL 数据库

## Cassandra 简介

### 目标

设计一个分布式、可扩展的系统，能够存储海量结构化数据，通过行键索引，每行可拥有无限数量的列。

### 背景

[[Cassandra]] 是 Apache 开源项目，最初由 Facebook 于 2007 年为其收件箱搜索功能开发。Cassandra 架构旨在提供可扩展性、可用性和可靠性以存储大量数据。Cassandra 结合了 Amazon [[Dynamo]] 的分布式特性和 Google [[BigTable]] 的列式数据模型。凭借去中心化架构，集群中不存在单点故障，性能随节点增加线性扩展。

![Cassandra 架构来源](images/chapter-002/page053.png)

### 什么是 Cassandra？

Cassandra 是分布式、去中心化、可扩展且高可用的 NoSQL 数据库。用 [[CAP 定理]] 术语表述，Cassandra 通常归类为 AP 系统（可用性和分区容忍性）。Cassandra 可通过复制因子和一致性级别进行调整以满足强一致性需求，但会带来性能代价。

Cassandra 使用对等架构，每个节点连接到所有其他节点。每个 Cassandra 节点执行所有数据库操作，无需领导者节点即可服务客户端请求。

![Cassandra 对等架构](images/chapter-002/page055.png)

![Cassandra 数据模型](images/chapter-002/page057.png)

### Cassandra 的用例

- **高可用键值存储**：Reddit 和 Digg 使用 Cassandra 作为持久化存储
- **时序数据模型**：Cassandra 的列由应用决定而非预定义模式，每行可包含不同数量的列
- **写入密集型应用**：时序流服务、传感器日志、物联网应用

![Cassandra 数据模型与 RDBMS 对比](images/chapter-002/page056.png)

---

## 高层架构

### 基本术语

- **列（Column）**：键值对，是数据结构的最基本单元
- **行（Row）**：通过主键引用的列容器。Cassandra 不存储值为 null 的列，节省大量空间
- **表（Table）**：行的容器
- **键空间（Keyspace）**：表的容器，可跨越一个或多个节点
- **集群（Cluster）**：键空间的容器
- **节点（Node）**：运行 Cassandra 实例的计算机系统

![Consistency Hash Ring](images/chapter-002/page058.png)

![Partition Key and Clustering Key](images/chapter-002/page059.png)

### 数据分区

Cassandra 使用[[一致性哈希]]进行数据分区。默认使用 **Murmur3** 哈希函数，对给定分区键始终产生相同的哈希值。

![Data partitioning ring](images/chapter-002/page060.png)
![Coordinator Node](images/chapter-002/page061.png)

### Cassandra 的键

主键唯一标识表中的每一行，分为两部分：

```
主键 = 分区键 + 聚簇键
```

- **分区键**：决定数据分布在哪个节点
- **聚簇键**：决定数据在节点内如何存储

例如 `PRIMARY KEY (city_id, employee_id)`，其中 `city_id` 是分区键，所有具有相同 `city_id` 的行位于同一节点；`employee_id` 是聚簇键，数据在节点内按该列排序。

![Replication Strategy](images/chapter-002/page063.png)

![Multi-DC Replication](images/chapter-002/page064.png)

### 分区器

分区器负责确定数据如何在一致性哈希环上分布。写入数据时，分区器对分区键应用哈希算法，输出决定数据落在哪个范围以及存储在哪个节点。

### 协调节点

客户端可连接到集群中的任意节点发起读写查询，该节点称为**协调节点**。协调节点识别负责该数据的节点并将查询转发给它们。

![Consistency Levels](images/chapter-002/page067.png)

![Hinted Handoff](images/chapter-002/page068.png)

---

## 复制

### 复制因子

复制因子是接收相同数据副本的节点数量。复制因子为 3 意味着每行存储在三个不同节点上。每个键空间可有不同的复制因子。

### 复制策略

分区键哈希落入的范围的拥有节点是第一个副本，后续副本放置在顺时针方向的下一个节点。

![Read Repair](images/chapter-002/page069.png)

![Snitch](images/chapter-002/page070.png)

**简单复制策略**：仅用于单数据中心集群。第一个副本由分区器确定，后续副本顺时针放置。

**网络拓扑策略**：用于多数据中心。可为不同数据中心指定不同的复制因子。

![Multi-DC replication](images/chapter-002/page065.png)

---

## Cassandra 一致性级别

一致性级别定义为读或写操作成功前必须响应的最小节点数。Cassandra 允许为读写操作指定不同的一致性级别。

### 写入一致性级别

- **ONE / TWO / THREE**：数据必须写入至少指定数量的副本节点
- **QUORUM**：数据必须写入至少仲裁（多数）节点。仲裁定义为 `floor(RF/2 + 1)`
- **ALL**：数据必须写入所有副本节点。提供最高一致性但可用性最低
- **LOCAL_QUORUM**：数据必须写入协调节点所在数据中心的仲裁节点
- **EACH_QUORUM**：数据必须写入每个数据中心的仲裁节点
- **ANY**：数据必须写入至少一个节点。当所有副本节点宕机时，写入仍可通过提示移交成功。提供最低延迟和最高可用性，但一致性最低

![Consistency level comparison](images/chapter-002/page066.png)

### 提示移交

Cassandra 在节点宕机时，由协调节点将提示（hint）写入本地磁盘文件，包含数据本身及数据所属节点的信息。当协调节点发现目标节点恢复时，转发写入请求。Cassandra 默认将提示存储三小时，超时后删除旧提示。

![Hinted handoff flow](images/chapter-002/page071.png)

### 读取一致性级别

Cassandra 提供与写入相同的一致性级别（EACH_QUORUM 除外，因其成本过高）。

**实现强一致性的条件**：R + W > RF，其中 R 为读取副本数，W 为写入副本数，RF 为复制因子。

### 读取修复

读取操作用于修复副本间不一致的数据。当一致性级别小于 ALL 时，Cassandra 使用概率性读取修复机制，默认 10% 的请求触发读取修复。

![Read repair mechanism](images/chapter-002/page073.png)

### Snitch

Snitch 是跟踪网络拓扑的组件，决定环内节点的接近度并识别最快的节点。主要功能：

1. 确定节点接近度，监控读取延迟以避免读取减速节点
2. 复制策略使用 Snitch 提供的信息智能分布副本

![Snitch topology](images/chapter-002/page075.png)

---

## Gossiper

Cassandra 使用 [[Gossip 协议]] 让每个节点跟踪集群中其他节点的状态信息。每个节点每秒与 1-3 个随机节点交换状态信息。

**世代号**：每个节点存储一个世代号，每次重启时递增。世代号包含在 Gossip 消息中，用于区分重启前后的状态。

**种子节点**：Cassandra 指定种子节点列表，用于新节点首次启动时引导 Gossip 过程。种子节点不是单点故障，也没有其他特殊用途。

![Gossip protocol](images/chapter-002/page077.png)

### 节点故障检测

Cassandra 使用 **Phi Accrual 故障检测器**。这种自适应算法利用历史心跳信息使阈值自适应。与传统心跳输出布尔值（存活/死亡）不同，Accrual 故障检测器输出**怀疑级别**——怀疑级别越高，服务器宕机的可能性越大。这使分布式系统在声明系统完全宕机之前，能考虑网络环境的波动和间歇性服务器问题。

![Phi Accrual failure detection](images/chapter-002/page078.png)

---

## 写入操作剖析

Cassandra 同时使用内存和磁盘存储数据，以提供高性能和持久性。

写入路径总结：

1. 每次写入追加到**提交日志**（Commit Log），存储在磁盘
2. 然后写入内存中的 **MemTable**
3. 定期将 MemTable 刷新为磁盘上的 **SSTable**
4. 定期执行压缩以合并 SSTable

![Write path](images/chapter-002/page079.png)

### 提交日志

写入请求到达节点时，数据立即写入提交日志。提交日志是[[预写日志]]（WAL），存储在磁盘上，作为崩溃恢复机制。写入在写入提交日志之前不被视为成功。

### MemTable

写入提交日志后，数据写入内存中的 MemTable 数据结构。每个节点为每个 Cassandra 表维护一个 MemTable。提交日志按顺序存储所有写入，而 MemTable 按分区键和聚簇列的排序顺序存储数据。

### SSTable

当 MemTable 中的对象数达到阈值时，MemTable 的内容被刷新到磁盘上的 SSTable 文件。此时创建新的 MemTable。SSTable 是不可变的——写入后不再更改。

![MemTable flush to SSTable](images/chapter-002/page080.png)

---

## 读取操作剖析

读取路径总结：

1. 检查 MemTable 中的数据
2. 如果未命中，按时间倒序检查 SSTable 缓存（行缓存）
3. 如果仍未命中，检查 Bloom 过滤器
4. 如果 Bloom 过滤器指示数据存在，检查分区键缓存、分区索引、压缩偏移映射
5. 从 SSTable 中获取数据

![Read path](images/chapter-002/page081.png)

Cassandra 使用[[布隆过滤器]]（Bloom Filter）快速判断 SSTable 是否包含所请求的分区数据。布隆过滤器是一种概率性数据结构，可以精确回答"不存在"，但不能精确回答"存在"。

---

## 压缩

Cassandra 定期执行压缩以合并 SSTable。压缩合并多个 SSTable 并写入新 SSTable，然后丢弃旧的 SSTable。压缩期间，被覆盖或删除的数据被移除，减少磁盘占用。

![Compaction](images/chapter-002/page083.png)

---

## 墓碑

Cassandra 的删除操作不会立即移除数据。相反，Cassandra 为已删除数据写入一个称为**墓碑**（Tombstone）的标记。墓碑最终会在压缩时被清除。墓碑给 Cassandra 的处理带来了复杂性——如果存在大量墓碑，读取操作的延迟会显著增加。

![Tombstone lifecycle](images/chapter-002/page084.png)

---

## 总结

| Dynamo 技术 | Cassandra 采纳情况 |
|------------|-----------------|
| 一致性哈希 + 虚拟节点 | 支持 |
| 提示移交 | 支持 |
| Merkle 树反熵 | 支持 |
| 向量时钟 | LWW（最后写入者获胜） |
| Gossip 协议 | 支持 |

Cassandra 综合了 Dynamo 的分布式架构和 BigTable 的数据模型，是一个高性能、高可用的宽列 NoSQL 数据库，特别适合写入密集型应用、时序数据和大数据分析场景。它采用对等架构消除单点故障，使用一致性哈希分布数据，通过可调一致性级别让应用在可用性和一致性之间灵活权衡。

![Architecture summary](images/chapter-002/page082.png)

---

## 选择题

1. Cassandra 的数据模型结合了哪两个系统的设计？
   a. MySQL 和 Redis
   b. Dynamo 和 BigTable
   c. MongoDB 和 HDFS
   d. Kafka 和 ZooKeeper

2. Cassandra 中使用什么哈希函数作为默认分区器？
   a. MD5
   b. SHA-1
   c. Murmur3
   d. SHA-256

3. 以下哪个一致性级别在 Cassandra 写入中提供最高可用性但最低一致性？
   a. ALL
   b. QUORUM
   c. ONE
   d. ANY

4. 什么是 Cassandra 中的"墓碑"（Tombstone）？
   a. 存储已删除数据的标记
   b. 备份数据的快照
   c. 压缩后的索引文件
   d. 日志文件的归档格式

5. Cassandra 使用什么机制进行故障检测？
   a. 固定超时心跳
   b. Phi Accrual 故障检测器
   c. 轮询
   d. 主节点监控

**答案**
1. b
2. c
3. d
4. a
5. b
