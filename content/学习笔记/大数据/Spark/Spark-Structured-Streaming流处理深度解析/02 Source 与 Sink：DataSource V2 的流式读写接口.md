---
title: "Source 与 Sink：DataSource V2 的流式读写接口"
date: 2026-02-28
tags: [Spark, Structured Streaming, Source, Sink, Kafka, DataSource V2, Exactly-once, Offset管理]
aliases: []
---

# 02 Source 与 Sink：DataSource V2 的流式读写接口

## 摘要

Structured Streaming 的数据入口（Source）和出口（Sink）决定了流查询能处理哪些数据、能写往哪里，以及能否实现端到端的 Exactly-once 语义。Spark 先后提供了两代接口：**DataSource V1**（Spark 2.x，基于 `Source`/`Sink` 接口）和 **DataSource V2**（Spark 3.0+ 完善，基于 `SparkDataStream`/`StreamingWrite` 接口），两者在 Offset 管理、分区感知、批流统一等设计上有本质差异。本文重点讲解生产中最重要的 Kafka Source 的 Offset 管理机制（如何保证不丢不重）、Rate Source 与 Socket Source 的调试用途、File Source 的原子性语义；以及 Sink 侧的三个等级——`ForeachSink`（灵活但需手动保证幂等）、`FileSink`（天然幂等）、`KafkaSink`（At-least-once）——各自的 Exactly-once 保证能力与实现原理。

---

## 第 1 章 Source 的职责与接口设计

### 1.1 Source 需要解决什么问题

流处理的 Source 与批处理的数据读取有一个根本差异：**流 Source 必须支持可重放（Replayable）**。

当一个 MicroBatch 失败并重试时，Spark 需要重新读取这个批次涉及的数据。这要求 Source 能够根据一个"位置标记"（Offset）重新返回特定范围的数据。不是所有数据源天然支持这一点：

- **Kafka**：天然可重放——Kafka 消息有持久化的 Offset，可以精确回放任意 Offset 范围的消息
- **Socket**：不可重放——TCP Socket 流是一次性的，读过的数据无法回放（因此只用于测试）
- **HDFS/S3 文件**：可重放——文件一旦写入就不变，可以多次读取
- **数据库 CDC 流**（如 Debezium）：可重放——通常有 binlog 位置或 LSN 记录

**DataSource V1 的 Source 接口**：

```scala
trait Source {
  def schema: StructType                           // Source 的 Schema
  def getOffset: Option[Offset]                    // 获取当前最新 Offset
  def getBatch(start: Option[Offset], end: Offset): DataFrame  // 返回 [start, end] 的批次数据
  def stop(): Unit                                 // 停止 Source
}
```

**DataSource V2 的 SparkDataStream 接口**（更通用，批流统一）：

```scala
trait SparkDataStream {
  def initialOffset(): Offset                      // 首次启动时的默认起始 Offset
  def deserializeOffset(json: String): Offset      // 从 Checkpoint JSON 反序列化 Offset
  def commit(end: Offset): Unit                    // 通知 Source 已提交到此 Offset（可用于 Offset 提交）
  def stop(): Unit
}

trait MicroBatchStream extends SparkDataStream {
  def latestOffset(): Offset                       // 获取当前最新可用 Offset
  def planInputPartitions(start: Offset, end: Offset): Array[InputPartition]  // 分区规划
  def createReaderFactory(): PartitionReaderFactory  // 创建分区读取器
}
```

V2 接口的关键改进：`planInputPartitions` 允许 Source 将数据分区信息暴露给 Spark，Spark 可以据此做分区并行读取，而不是所有数据都通过 Driver 中转。

---

## 第 2 章 Kafka Source：生产级 Source 的深度解析

Kafka Source 是 Structured Streaming 生产中使用最广泛的 Source，其 Offset 管理设计直接决定了流查询的正确性。

### 2.1 Kafka Offset 的管理逻辑

Kafka 消息以 `(topic, partition, offset)` 三元组精确定位。Structured Streaming 的 Kafka Source 将每个 `(topic, partition)` 的消费位置记录为一个 JSON 映射：

```json
{
  "topic-events": {
    "0": 1500,   // partition 0 消费到 offset 1500
    "1": 2300,   // partition 1 消费到 offset 2300
    "2": 1800    // partition 2 消费到 offset 1800
  }
}
```

这个 JSON 被存储在 Checkpoint 的 `offsets/` 目录中，作为每个 MicroBatch 的 WAL 记录。

**一个完整批次的 Kafka Offset 流转**：

```
batchId=5 开始：
  startOffset = offsets/4 的 endOffset = {partition-0: 1500, partition-1: 2300}
  
调用 KafkaSource.latestOffset()：
  返回 Kafka 当前各分区的最新 Offset = {partition-0: 1650, partition-1: 2480}
  
写 offsets/5：
  {startOffset: {p0:1500, p1:2300}, endOffset: {p0:1650, p1:2480}}
  
执行 Spark Job：
  每个 Kafka 分区对应一个 InputPartition
  InputPartition(partition=0, startOffset=1500, endOffset=1650)  → Task 0
  InputPartition(partition=1, startOffset=2300, endOffset=2480)  → Task 1
  Task 读取对应范围的 Kafka 消息，处理后写出

写 commits/5：标记 batchId=5 完成
```

**关键设计**：Spark 的 Kafka Source **不直接向 Kafka 提交 Consumer Group Offset**（不使用 `__consumer_offsets` topic）。Offset 完全由 Spark Checkpoint 管理，与 Kafka 的 Consumer Group 机制解耦。这意味着：
- Kafka UI 上看到的 Consumer Group Lag 可能不反映实际的 Spark 消费进度
- 更换 Checkpoint 目录或修改 `startingOffsets` 配置会改变消费起点
- 多个 Spark 流查询可以使用相同的 Consumer Group 名称（但不建议，容易混淆）

### 2.2 Kafka Source 的关键配置

```python
df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker1:9092,broker2:9092") \
    .option("subscribe", "events")           # 订阅单个 topic
    # .option("subscribePattern", "events-.*") # 正则订阅多个 topic
    # .option("assign", '{"events":[0,1,2]}')  # 指定特定分区
    \
    # Offset 起始位置（首次启动时生效，有 Checkpoint 则忽略）
    .option("startingOffsets", "earliest")   # 从头消费（适合回放）
    # .option("startingOffsets", "latest")   # 只消费新数据（适合实时）
    # .option("startingOffsets", '{"events":{"0":1000,"1":2000}}')  # 指定具体 Offset
    \
    # 背压控制（每个分区每批次最多读取的消息数）
    .option("maxOffsetsPerTrigger", 100000)  # 全局限制（所有分区合计）
    # .option("maxOffsetsPerPartition", 10000)  # 每分区限制
    \
    # Kafka 消费者配置
    .option("kafka.group.id", "spark-streaming-app")  # Consumer Group 名称
    .option("kafka.session.timeout.ms", "60000")
    \
    # 故障容错
    .option("failOnDataLoss", "false")       # 数据丢失（Kafka 消息过期）时是否报错
    .load()
```

**`maxOffsetsPerTrigger` 的背压作用**：

如果不设置 `maxOffsetsPerTrigger`，Kafka Source 每次批次会尝试读取从 startOffset 到 latestOffset 的**所有**数据。当存在大量积压时（如应用停机后 Kafka 积累了数亿条消息），第一个批次会尝试处理所有积压，导致单批次数据量极大、内存溢出。

`maxOffsetsPerTrigger=100000` 使每批次最多处理 10 万条消息，将积压处理变为可控的多批次渐进消费。

### 2.3 Kafka Source 的分区感知

Kafka Source 实现了 DataSource V2 的 `planInputPartitions`，将每个 Kafka 分区映射为一个 Spark InputPartition。这意味着：

- Kafka 有 N 个分区 → Spark 每个批次有 N 个 Task 并行读取
- Spark Task 数 = Kafka 分区数（不受 `shuffle.partitions` 影响）
- 当 Kafka 分区数过少时（如只有 2 个分区），Spark 并行度也被限制为 2，无法充分利用集群资源

**生产建议**：根据预期的 Spark 并行度合理设置 Kafka 分区数。通常每个 Core 对应 1-2 个 Kafka 分区是较好的起点。如果需要更高的 Spark 并行度，可以在 Kafka Source 后接一个 `repartition(N)` 操作（会引入一次 Shuffle）。

---

## 第 3 章 其他内置 Source

### 3.1 File Source：基于文件系统的流式读取

File Source 将一个目录（HDFS/S3）视为数据源，持续监视新写入的文件，每个批次读取新到达的文件：

```python
df = spark.readStream \
    .format("parquet")          # 也支持 csv/json/orc
    .schema(schema)             # 必须显式指定 Schema（流式读取不做自动 Schema 推断）
    .option("path", "s3://bucket/landing-zone/") \
    .option("maxFilesPerTrigger", 100)   # 每批次最多处理多少个新文件
    .option("latestFirst", "false")      # 是否优先处理最新文件
    .load()
```

**File Source 的原子性语义**：File Source 只处理**完整写入的文件**——它通过文件的最终化状态（文件已存在于目录中且不再被写入）来判断文件是否可以读取。对于使用临时文件 + Rename 原子写入的场景（如 HDFS 的 `_temporary` → final 路径），这天然保证了只读取完整文件。

**File Source 的 Offset**：File Source 的 Offset 是**已处理文件的列表**（存储在 `offsets/` 目录中）。故障恢复时，Spark 从 Checkpoint 读取已处理文件列表，跳过这些文件，只处理新文件。

> [!warning] 生产避坑
> File Source 需要文件写入者（上游）保证**写入的原子性**——不能在文件写到一半时就出现在监视目录中（否则 Spark 会读到不完整的文件）。推荐的模式是：写到临时目录，写完后 `mv` 到监视目录（HDFS 的 rename 是原子操作）。直接向监视目录流式写入（如 `append` 写入同一文件）是不安全的。

### 3.2 Rate Source 和 Rate Per Micro-Batch Source（测试专用）

```python
# Rate Source：按固定速率生成测试数据
df = spark.readStream \
    .format("rate") \
    .option("rowsPerSecond", 1000)     # 每秒生成 1000 行
    .option("numPartitions", 4)         # 生成数据的并行度
    .load()
# 输出 Schema：timestamp TIMESTAMP, value LONG

# Rate Per Micro-Batch Source（Spark 3.3+）：每批次生成固定行数
df = spark.readStream \
    .format("rate-micro-batch") \
    .option("rowsPerBatch", 5000)       # 每批次生成 5000 行（与批次间隔无关）
    .load()
```

Rate Source 用于性能测试（测试 Sink 的写入速度、状态算子的吞吐量）和功能验证（不依赖外部 Kafka/文件系统的单元测试）。不用于生产。

---

## 第 4 章 Sink：数据写出的 Exactly-once 保证等级

Sink 的 Exactly-once 保证能力是流查询端到端语义的决定性因素。不同 Sink 的保证等级不同，根本原因在于各 Sink 是否支持**幂等写出**或**事务性写出**。

### 4.1 Exactly-once 的两个条件

端到端 Exactly-once 需要同时满足：
1. **Source 可重放**（At-least-once 处理）：任何失败都可以从 Checkpoint 的 Offset 重新读取数据
2. **Sink 幂等或事务**：重放相同数据时，输出结果与只处理一次相同

条件 1 由 Checkpoint 机制保证（所有可重放的 Source 都满足）。条件 2 取决于具体的 Sink 实现。

### 4.2 FileSink：天然的 Exactly-once

```python
query = df.writeStream \
    .format("parquet") \
    .option("path", "s3://bucket/output/") \
    .option("checkpointLocation", "s3://bucket/checkpoint/") \
    .partitionBy("dt", "region")          # 可选：分区写出
    .start()
```

**FileSink 的 Exactly-once 机制**：

FileSink（`FileStreamSink`）使用**两阶段提交**实现 Exactly-once：

1. **写入阶段**：每个 Task 将数据写入临时路径（`$outputPath/_spark_metadata/` 下的临时文件）
2. **提交阶段**：当 batchId 的所有 Task 完成后，Driver 将这些临时文件的路径原子写入 `$outputPath/_spark_metadata/` 下的 compact 文件，然后将文件 rename 到最终路径

如果 Task 失败重试，重试的 Task 写入新的临时文件（不会与失败 Task 的临时文件冲突）；Driver 只提交成功 Task 的文件。如果 Driver 在提交阶段崩溃，重启后重新执行该批次（At-least-once 的文件写入，但 rename 是幂等的——同名文件 rename 到目标路径不会产生重复），最终结果唯一。

**生产注意**：FileSink 的输出目录中会有 `_spark_metadata/` 元数据目录，读取时应使用 Structured Streaming 的 FileSink 专用读取方式（`spark.read.format("parquet").load(outputPath)` 会自动识别此元数据）。

### 4.3 KafkaSink：At-least-once（非 Exactly-once）

```python
query = df.selectExpr("CAST(key AS STRING)", "CAST(value AS STRING)") \
    .writeStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("topic", "output-events") \
    .option("checkpointLocation", "/checkpoint/") \
    .start()
```

**KafkaSink 只提供 At-least-once**，原因：

Kafka 的生产者（Producer）写入是异步的，且 Kafka 本身不支持跨批次的两阶段提交协议（Kafka 的事务 API 支持单次事务内的 Exactly-once，但跨批次的协调需要额外实现）。当一个 MicroBatch 部分 Task 失败重试时，成功的 Task 已经向 Kafka 写出了数据，重试的 Task 会再次写出相同数据——产生重复消息。

**如何实现 Kafka Sink 的 Exactly-once**：

- **方案一：业务层去重**——在 Kafka 消费端根据消息中的唯一 ID（eventId）做去重
- **方案二：Kafka 幂等 Producer + 事务**

```python
query = df.writeStream \
    .format("kafka") \
    .option("kafka.enable.idempotence", "true")  # 开启幂等 Producer
    .option("kafka.transactional.id", "spark-app-unique-id")  # 事务 ID（Exactly-once 写入）
    .option("checkpointLocation", "/checkpoint/") \
    .start()
```

开启 Kafka 事务性写入后，KafkaSink 使用 Kafka 的事务 API：每个批次作为一个 Kafka 事务提交，事务 abort 时消费者看不到任何部分写入的消息。这实现了对 Kafka 的 Exactly-once 写入。

> [!warning] 生产避坑
> Kafka 事务性写入有性能开销（约 10-20% 的吞吐量降低），且需要 Kafka Broker 版本 >= 0.11。生产中是否需要 Kafka Sink 的 Exactly-once，取决于下游消费者是否能容忍重复消息。大多数场景中，业务层去重（通过 eventId）是更轻量的方案。

### 4.4 ForeachBatchSink：最灵活但需手动保证幂等

`foreachBatch` 是最灵活的 Sink，允许用户为每个 MicroBatch 执行任意的批处理逻辑：

```python
def write_to_mysql(df, batch_id):
    """
    df: 当前批次的 DataFrame（普通批处理 DataFrame，不是流 DataFrame）
    batch_id: 当前批次的 ID（可用于幂等写入的版本控制）
    """
    # 示例：幂等写入 MySQL（使用 batch_id 作为版本号）
    df.write \
        .format("jdbc") \
        .option("url", "jdbc:mysql://host:3306/db") \
        .option("dbtable", "results") \
        .mode("append") \
        .save()

query = df.writeStream \
    .foreachBatch(write_to_mysql) \
    .option("checkpointLocation", "/checkpoint/") \
    .start()
```

**ForeachBatch 的 Exactly-once 保证完全依赖用户实现**：

Spark 保证 `write_to_mysql` 函数的调用语义是 At-least-once（批次可能重试，函数被多次调用）。用户需要在函数内部实现幂等性：

**幂等写入示例（UPSERT 语义）**：

```python
def write_upsert(df, batch_id):
    # 使用 batch_id 作为版本号，幂等 UPSERT
    df.write \
        .format("jdbc") \
        .option("dbtable", "results") \
        .mode("overwrite")  # 如果支持 overwrite（覆盖）就是幂等的
        # 或使用 MERGE INTO SQL（MySQL INSERT ... ON DUPLICATE KEY UPDATE）
        .save()
```

**避免重复处理的标准模式**：

```python
def write_idempotent(df, batch_id):
    # 方法：在写出前检查 batch_id 是否已处理（通过专用的 batch 状态表）
    import pymysql
    conn = pymysql.connect(host="db-host", ...)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM batch_status WHERE batch_id = %s", (batch_id,))
    if cursor.fetchone()[0] > 0:
        print(f"Batch {batch_id} already processed, skipping")
        return
    
    # 写入数据
    df.write.format("jdbc")...save()
    
    # 标记 batch 已完成
    cursor.execute("INSERT INTO batch_status VALUES (%s, NOW())", (batch_id,))
    conn.commit()
```

---

## 第 5 章 DataSource V2 的流式接口设计哲学

### 5.1 V1 到 V2 的演进动机

DataSource V1 的问题：
- **Driver 中心化**：V1 的 Source 接口（`getBatch()`）返回一个 DataFrame，所有数据都通过 Driver 端的逻辑生成，Spark 无法感知 Source 的分区信息
- **批流分离**：读批处理文件和读流 Source 是完全独立的代码路径，无法复用
- **扩展性差**：无法表达聚合下推、分区下推等高级优化

DataSource V2 的改进：
- **分区感知**：`planInputPartitions()` 让 Source 暴露分区信息，Spark 直接从各分区并行读取
- **批流统一**：`Table` 接口统一描述数据源，`MicroBatchStream` 和 `ContinuousStream` 是对同一 Table 的不同读取策略
- **Filter/Aggregate 下推**：V2 提供 `SupportsPushDownFilters`、`SupportsPushDownAggregates` 等接口，Source 可以声明自己能在数据源层执行这些操作

### 5.2 Kafka Source 在 V2 下的分区并行读取

在 DataSource V2 下，Kafka Source 的 `planInputPartitions()` 将每个 Kafka Partition 的 `[startOffset, endOffset]` 范围映射为一个 `KafkaInputPartition`：

```
Kafka 有 4 个分区，本批次 Offset 范围：
  partition-0: [1500, 1650]
  partition-1: [2300, 2480]
  partition-2: [900, 1020]
  partition-3: [3100, 3200]

planInputPartitions() 返回 4 个 KafkaInputPartition：
  KafkaInputPartition(partition=0, start=1500, end=1650)
  KafkaInputPartition(partition=1, start=2300, end=2480)
  KafkaInputPartition(partition=2, start=900,  end=1020)
  KafkaInputPartition(partition=3, start=3100, end=3200)

Spark 为每个 InputPartition 启动一个 Task，4 个 Task 并行读取 4 个 Kafka 分区
→ 无 Driver 中心化瓶颈，完全并行
```

---

## 小结

- **Source 的核心要求**：可重放（Replayable），支持按 Offset 范围精确返回数据；不可重放的 Source（Socket）只用于测试
- **Kafka Source**：Offset 完全由 Spark Checkpoint 管理，不依赖 Kafka Consumer Group；`maxOffsetsPerTrigger` 控制背压；每 Kafka 分区对应一个 Spark Task
- **File Source**：监视目录新文件；Offset 是已处理文件列表；要求文件原子写入（临时路径+rename）
- **Sink 的 Exactly-once 等级**：FileSink（两阶段提交，天然 Exactly-once）> KafkaSink+事务（Exactly-once）> KafkaSink（At-least-once）> ForeachBatch（用户负责幂等）
- **DataSource V2**：批流统一的数据源接口，分区感知消除 Driver 中心化瓶颈，Filter/Aggregate 下推让存储层感知查询谓词

第 03 篇将深入三种输出模式的语义差异：为什么有聚合的查询不能用 Append 模式？Complete 模式为什么在生产中谨慎使用？Update 模式的增量输出逻辑是怎样的？

---

## 参考资料

- Apache Spark 官方文档：Structured Streaming Programming Guide - Sinks
- Apache Spark 源码：`org.apache.spark.sql.kafka010.KafkaSourceProvider`
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.FileStreamSink`
- Apache Spark 源码：`org.apache.spark.sql.connector.read.streaming.MicroBatchStream`
- [Exactly-Once Semantics Are Possible: Here's How Kafka Does It（Confluent Blog）](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
