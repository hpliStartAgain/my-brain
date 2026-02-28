---
title: "触发器 Trigger：ProcessingTime、Once、AvailableNow 与 Continuous"
date: 2026-02-28
tags: [Spark, Structured Streaming, Trigger, ProcessingTime, AvailableNow, Once, Continuous, 微批, 延迟]
aliases: []
---

# 05 触发器 Trigger：ProcessingTime、Once、AvailableNow 与 Continuous

## 摘要

Trigger（触发器）决定了 Structured Streaming 查询**何时启动下一个 MicroBatch**——是按固定时间间隔、还是数据就绪时立即触发、还是只运行一次后退出。四种 Trigger 类型覆盖了从实时流处理（秒级批次）到离线增量处理（一次性消费积压）的全部场景。本文深度讲解每种 Trigger 的触发逻辑、与 MicroBatch 执行模型的交互、延迟与吞吐量的权衡，以及 Spark 3.3 新增的 `AvailableNow` 如何解决 `Once` 触发器的根本缺陷（单批次内存压力）、成为定时增量 ETL 场景的最佳选择。

---

## 第 1 章 Trigger 的本质：控制批次启动节奏

### 1.1 Trigger 在 MicroBatch 循环中的位置

第 01 篇讲到，MicroBatch 执行模型是一个无限循环：等待 Trigger → 读取 Offset → 执行 Job → 提交 Commit → 再等待 Trigger。Trigger 控制的是"等待"这一步的行为：

```
┌──────────────────────────────────────────────────────┐
│               MicroBatch 触发循环                      │
│                                                      │
│  [等待 Trigger 条件] ←──────────────────────┐         │
│         │                                  │         │
│         ↓                                  │         │
│  [获取 Source Offset]                       │         │
│         │                                  │         │
│         ↓                                  │         │
│  [执行 Spark Job]                           │         │
│         │                                  │         │
│         ↓                                  │         │
│  [写 Commit 文件] ──────────────────────────┘         │
└──────────────────────────────────────────────────────┘
```

不同 Trigger 对"等待 Trigger 条件"步骤的实现：

- **`ProcessingTime`**：计时器，等满指定间隔后触发
- **`Once`**：不等待，立即触发一次，完成后退出整个循环
- **`AvailableNow`**：不等待，立即触发，但可以触发**多次**直到处理完所有积压数据后退出
- **`Continuous`**：不使用 MicroBatch 循环，走完全不同的 Continuous Processing 路径

---

## 第 2 章 ProcessingTime：生产实时流的默认选择

### 2.1 ProcessingTime 的触发逻辑

```python
# 每 10 秒触发一次
query = df.writeStream \
    .trigger(processingTime="10 seconds") \
    .format("kafka") \
    .start()

# 等价写法
from pyspark.sql.streaming import Trigger
query = df.writeStream \
    .trigger(Trigger.ProcessingTime("10 seconds")) \
    .start()

# 特殊值：processingTime="0 seconds"（尽可能快地触发，上一批次完成立即开始下一批次）
query = df.writeStream \
    .trigger(processingTime="0 seconds") \
    .start()
```

**计时逻辑**：计时从**上一批次完成时**开始（不是从上一批次开始时）。如果批次执行时间 > 触发间隔（如批次执行需要 15 秒，但间隔只有 10 秒），Spark 不会启动重叠的批次——而是在上一批次完成后**立即**启动下一批次（不再等待剩余的间隔时间）。

```
场景：processingTime="10 seconds"，批次执行时间 15 秒

T=0:   批次 0 开始
T=15:  批次 0 完成（超过了 10 秒间隔）
T=15:  批次 1 立即开始（不再等 10 秒，因为已经"欠"了 5 秒）
T=30:  批次 1 完成
T=40:  批次 2 开始（等满了 10 秒）
...
```

### 2.2 批次间隔的选择原则

选择合适的批次间隔是吞吐量与延迟的核心权衡：

**间隔过小的代价**：
- 每个批次读取的数据量少，批次启动/结束的固定开销（Task 调度、Checkpoint 写入）占比上升
- 批次间隔 < 批次执行时间时，系统陷入"追赶模式"，Kafka Lag 持续增长
- 频繁的 State Store checkpoint 操作（每批次都触发 State 写入）IO 压力大

**间隔过大的代价**：
- 端到端延迟增大（事件需要等待更长时间才被处理）
- 单批次数据量大，内存压力高，可能 Spill

**经验法则**：

| 场景 | 推荐批次间隔 |
|-----|-----------|
| 实时告警、监控仪表盘 | 1-5 秒 |
| 实时数仓（准实时） | 30 秒 - 5 分钟 |
| 近实时 ETL | 5-15 分钟 |
| 高吞吐 ETL（延迟不敏感） | 15-60 分钟 |

---

## 第 3 章 Once：单次执行的历史包袱

### 3.1 Once 的用途与行为

```python
# 只执行一次 MicroBatch，然后退出
query = df.writeStream \
    .trigger(once=True) \
    .format("parquet") \
    .option("checkpointLocation", "/ckpt/") \
    .start()
query.awaitTermination()  # 等待这一次执行完成
```

`Once` 触发器的行为：启动后立即触发一个批次，从 Checkpoint 记录的上次 Offset 到**当前 Kafka 最新 Offset** 的所有数据，一次性处理完后退出。下次调用时，从上次的 endOffset 继续。

**设计初衷**：用于**定时批量处理**场景——不想维持一个长期运行的流查询，而是通过定时调度（如 cron job 或 Airflow）周期性地启动 Spark 作业，每次消费上次到现在的增量数据。

### 3.2 Once 的根本缺陷

`Once` 触发器的致命问题：**将从上次 Offset 到当前 Kafka 最新 Offset 的所有积压数据放入单个 MicroBatch**。

如果上次运行是昨天，今天触发时 Kafka 中积累了数亿条消息，`Once` 会尝试在一个批次内处理所有数亿条消息——这往往导致：

1. **OOM（内存溢出）**：单批次数据量超过 Executor 内存
2. **State Store 压力**：有状态查询在单批次内需要处理海量状态更新
3. **运行时间极长**：本应分散到多批次的处理集中到一个批次

这就是 `AvailableNow` 被引入的原因。

---

## 第 4 章 AvailableNow：定时增量 ETL 的最佳选择

### 4.1 AvailableNow 是什么，为什么出现

**`AvailableNow`**（Spark 3.3 引入）解决了 `Once` 的单批次大数据量问题：它也会在处理完所有当前可用数据后退出，但**分多个批次逐步处理**，而不是一个巨型批次：

```python
# Spark 3.3+
query = df.writeStream \
    .trigger(availableNow=True) \
    .option("maxOffsetsPerTrigger", 1000000) \  # 每批最多 100 万条
    .format("parquet") \
    .option("checkpointLocation", "/ckpt/") \
    .start()
query.awaitTermination()
```

**行为**：
1. 查询启动时，记录当前各 Source 的最新 Offset（称为 "termination offset"）
2. 开始执行 MicroBatch，每批次按 `maxOffsetsPerTrigger` 的限制处理一部分数据
3. 当所有 Source 都处理到 termination offset 时，查询自动停止

```
Kafka 中积压了 1000 万条消息，maxOffsetsPerTrigger=100 万

AvailableNow 执行过程：
  批次 0：处理 Offset [0, 100万)
  批次 1：处理 Offset [100万, 200万)
  ...
  批次 9：处理 Offset [900万, 1000万)
  → 处理完成，自动退出

Once 执行过程：
  批次 0：处理所有 Offset [0, 1000万)  ← 单批次 1000 万条，可能 OOM
  → 处理完成，退出
```

### 4.2 AvailableNow 与 Once 的对比

| 维度 | `Once` | `AvailableNow` |
|-----|-------|---------------|
| **引入版本** | Spark 2.0 | Spark 3.3 |
| **批次数量** | 1 个批次（所有积压） | 多个批次（受 maxOffsets 控制） |
| **内存压力** | 高（积压越多越危险） | 可控（每批次固定大小） |
| **State 更新** | 单批次海量更新 | 分批次渐进更新 |
| **失败恢复** | 失败需从头重跑（整批次） | 失败从最近完成的批次续跑 |
| **适用场景** | 积压量小且可控的场景 | **所有定时增量 ETL 场景** |

> [!note] 设计哲学
> `AvailableNow` 本质上把"定时流处理"的两个需求解耦：**执行有界**（处理完当前积压就退出，不持续监听）和**批次有界**（每个 MicroBatch 数据量可控）。这使它成为在 Airflow/DolphinScheduler 中调度 Spark 流处理作业的首选模式——定时触发、自动退出、不会因积压而 OOM。

### 4.3 生产中的 AvailableNow 最佳实践

```python
# 完整的 AvailableNow 生产模式
spark = SparkSession.builder \
    .config("spark.sql.shuffle.partitions", "200") \
    .getOrCreate()

# 读取 Kafka
df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .option("startingOffsets", "earliest") \
    .option("maxOffsetsPerTrigger", 2000000) \  # 每批最多 200 万条
    .load()

# 业务逻辑
result = df.selectExpr("CAST(value AS STRING)") \
    .filter(...) \
    .groupBy(...) \
    .agg(...)

# AvailableNow 触发器
query = result.writeStream \
    .trigger(availableNow=True) \
    .outputMode("append") \
    .format("delta") \
    .option("checkpointLocation", "s3://bucket/checkpoint/events-etl/") \
    .option("path", "s3://bucket/output/events/") \
    .start()

# 等待执行完成后退出（Airflow 任务结束）
query.awaitTermination()
```

---

## 第 5 章 默认触发器（无 Trigger 配置）

当不调用 `.trigger()` 方法时，Structured Streaming 使用**默认触发器**，等价于 `processingTime="0 seconds"`——上一批次完成后**尽可能快地**启动下一批次（不等待任何间隔）。

```python
# 等价写法
query = df.writeStream.format("console").start()
# 等价于：
query = df.writeStream.trigger(processingTime="0 seconds").format("console").start()
```

这种模式在数据持续涌入的场景下，每批次处理尽量多的数据，吞吐量最高，但 CPU 和 I/O 负载也最高（持续高强度运行）。适合吞吐量优先、延迟不是首要约束的场景。

---

## 小结

四种 Trigger 各有其精确适用场景：

- **`ProcessingTime`**：生产实时流处理的默认选择，通过批次间隔平衡延迟与吞吐量；间隔选择依据是"批次执行时间的 2-3 倍"作为上限
- **`Once`**：历史遗留，定时增量 ETL 场景；积压量不可控时有 OOM 风险，**新项目优先用 `AvailableNow`**
- **`AvailableNow`**（Spark 3.3+）：定时增量 ETL 的最佳实践；多批次消费积压、内存可控、失败可续跑；配合 Airflow 是理想的"流批一体"调度模式
- **`Continuous`**：毫秒级延迟的实验性模式，不支持聚合/状态，生产中慎用
- **默认（无 Trigger）**：等价于 `processingTime="0 seconds"`，最高吞吐，持续全力运行

第 06 篇深入三种窗口的实现机制：滚动窗口（Tumbling Window）、滑动窗口（Sliding Window）与会话窗口（Session Window）在 State Store 中的存储结构，以及窗口状态的清理时机。

---

## 参考资料

- Apache Spark 官方文档：Structured Streaming Triggers
- Apache Spark 源码：`org.apache.spark.sql.streaming.Trigger`
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.MicroBatchExecution`
- [SPARK-36533: Add AvailableNow trigger for Structured Streaming](https://issues.apache.org/jira/browse/SPARK-36533)
