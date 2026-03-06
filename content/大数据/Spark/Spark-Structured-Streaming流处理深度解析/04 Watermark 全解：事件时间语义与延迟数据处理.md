---
title: "Watermark 全解：事件时间语义与延迟数据处理"
date: 2026-02-28
tags: [Spark, Structured Streaming, Watermark, 事件时间, 乱序数据, 延迟数据, 水位线, 窗口, State清理]
aliases: []
---

# 04 Watermark 全解：事件时间语义与延迟数据处理

## 摘要

Watermark（水位线）是 Structured Streaming 处理乱序、延迟数据的核心机制，也是让聚合查询支持 Append 输出模式、让 State Store 能够安全清理过期状态的关键前提。其本质是一个**系统对"事件时间进度"的单调递增估计**：当 Watermark 推进到时间 `W` 时，Spark 宣告"事件时间 `<= W` 的数据不再到来"——这个声明允许 Spark 安全关闭该时间之前的窗口、输出已确定的结果、并清理不再需要的状态。本文深度讲解 Watermark 的推进算法（从 maxEventTime 减去延迟阈值）、多 Source 场景下的 Watermark 对齐策略（Global Watermark = min of all sources）、Watermark 与 State 清理的精确时序（窗口何时关闭、State 何时被删除）、Watermark 停滞的根因与诊断（数据倾斜、Source 空分区、时间戳精度问题），以及如何在 Spark UI 中实时监控 Watermark 的推进状态。

---

## 第 1 章 为什么需要 Watermark：乱序数据的根本挑战

### 1.1 处理时间 vs 事件时间

在流处理中，每个事件都有两个相关的时间概念：

**处理时间（Processing Time）**：Spark Task 处理这条记录的时刻（系统时钟，`System.currentTimeMillis()`）。处理时间是确定的、单调递增的，不存在乱序问题——越晚处理的记录，处理时间越大。

**事件时间（Event Time）**：事件实际发生的时刻（嵌入在数据字段中，如 `event_timestamp` 列）。事件时间反映了真实世界的业务语义——统计"每分钟的下单量"，用的是订单发生时刻（事件时间），而不是 Spark 处理订单的时刻（处理时间）。

**乱序数据（Out-of-order Data）**的产生**原因**：

- **网络延迟**：不同来源的数据经过不同的网络路径，到达 Kafka 的时间有先后
- **客户端重试**：移动端应用在网络断开时缓存事件，恢复连接后批量上报——这些事件的时间戳是几分钟甚至几小时前的
- **时区错误**：客户端时钟偏差（服务器 NTP 未同步）
- **多级管道**：数据经过多个 ETL 节点，各节点的处理延迟不同

**乱序数据的后果**（如果不处理）：

假设每 5 分钟做一次窗口聚合（统计 10:00-10:05 的事件数）：

```
Spark 的处理时间到了 10:06，批次触发
读取到的事件：
  10:00:01 的事件（即时到达）
  10:00:03 的事件（即时到达）
  10:04:58 的事件（即时到达）

还有 3 个事件：
  10:00:45 的事件（网络延迟 2 分钟，10:02:45 才进入 Kafka，本批次未读到）
  10:03:20 的事件（客户端重试，10:08 才到 Kafka，未来批次才能读到）
  10:02:11 的事件（网络问题，10:07 才到）

→ 如果 10:06 的批次就关闭窗口并输出结果，这 3 个"迟到"事件被丢弃
→ 统计结果偏少，数据质量差
```

如果等所有迟到数据都到了再关闭窗口，需要等多久？理论上可以等到无穷——总可能有更晚的数据到来。Watermark 解决了这个"等多久"的问题：给定一个合理的延迟阈值，超过阈值的迟到数据被认为"不会再来了"，窗口安全关闭。

### 1.2 Watermark 的直觉定义

**Watermark 是系统对"当前事件时间进度"的保守估计**。

更精确地说：当 Watermark = `W` 时，Spark 承诺"事件时间 `<= W` 的数据不再到来"。

这是一个保守承诺（可能有极少数更晚的数据确实到来了，但它们会被丢弃）。`W` 的大小取决于用户配置的**延迟容忍阈值（Late Data Threshold）**：延迟阈值越大，能容忍的迟到数据越多，状态保留时间越长，输出延迟越高；延迟阈值越小，迟到数据被丢弃越多，状态清理越积极，输出延迟越低。

---

## 第 2 章 Watermark 的推进算法

### 2.1 单 Source 的 Watermark 计算

**定义 Watermark**：

```python
events_with_watermark = events \
    .withWatermark("event_time", "10 minutes")
    # 参数一：事件时间列名（TIMESTAMP 类型）
    # 参数二：延迟容忍阈值（晚于当前 Watermark 多少的数据可以被接受）
```

**Watermark 的推进公式**：

```
新 Watermark = MAX(当前批次所有事件的 event_time) - 延迟阈值
```

但 Watermark 是**单调递增**的——新计算的值只有大于当前 Watermark 时才更新：

```
Watermark = MAX(当前 Watermark, 当前批次 maxEventTime - 延迟阈值)
```

**具体例子**（延迟阈值 = 10 分钟）：

```
batchId=0：
  事件时间：10:00:01, 10:02:30, 10:04:15
  maxEventTime = 10:04:15
  新 Watermark = 10:04:15 - 10min = 09:54:15
  当前 Watermark = MAX(初始值-∞, 09:54:15) = 09:54:15

batchId=1：
  事件时间：10:05:00, 10:08:30, 10:00:45（延迟 8 分钟的迟到数据）
  maxEventTime = 10:08:30
  新 Watermark = 10:08:30 - 10min = 09:58:30
  当前 Watermark = MAX(09:54:15, 09:58:30) = 09:58:30
  → 10:00:45 的事件：10:00:45 > 09:58:30（Watermark），接受！

batchId=2：
  事件时间：10:15:00, 10:16:20
  maxEventTime = 10:16:20
  新 Watermark = 10:16:20 - 10min = 10:06:20
  当前 Watermark = MAX(09:58:30, 10:06:20) = 10:06:20
  → 此时，结束时间 <= 10:06:20 的窗口可以关闭并输出结果
```

### 2.2 迟到数据的处理决策

每条新到达的事件数据，Spark 根据其事件时间与当前 Watermark 的比较，决定接受还是丢弃：

```
事件的事件时间 > 当前 Watermark → 接受（正常数据或允许延迟范围内的迟到数据）
事件的事件时间 <= 当前 Watermark → 丢弃（认为此数据已"过期"，对应窗口已关闭）
```

**关键点**：Watermark 本身是根据"迄今为止看到的最大事件时间"计算的。一条极晚的事件（如带未来时间戳的异常数据）会把 Watermark 瞬间推进很远，导致很多正常数据被丢弃！

> [!warning] 生产避坑
> **时间戳异常值（Future Timestamps）是 Watermark 的最大杀手**。客户端时钟错误、数据格式解析 Bug 等可能导致某条事件的时间戳是"2099-01-01"——这会把 Watermark 瞬间推进到 73 年后，所有正常数据的事件时间都 <= 这个极大 Watermark，全部被丢弃！
>
> **预防措施**：在 `withWatermark` 之前，对事件时间列做合法性过滤：
> ```python
> events.filter(
>     (col("event_time") >= "2020-01-01") &
>     (col("event_time") <= current_timestamp() + expr("INTERVAL 1 HOUR"))  # 不允许超过当前时间 1 小时的未来时间戳
> ).withWatermark("event_time", "10 minutes")
> ```

### 2.3 Watermark 推进时机：批次结束时更新

Watermark 不是实时更新的，而是在**每个 MicroBatch 结束时**基于该批次的所有事件计算一次。这意味着：

1. 在 batchId=N 的处理过程中，Watermark 值是 batchId=N-1 结束时计算的值（上一批次的 Watermark）
2. batchId=N 的数据处理（窗口归属、迟到判断）使用的是 batchId=N-1 的 Watermark
3. batchId=N 处理完成后，根据 batchId=N 的 maxEventTime 更新 Watermark，供 batchId=N+1 使用

这个"滞后一批次"的特性有时会引发迷惑：明明某批次有很晚的事件时间，为什么窗口没有关闭？因为窗口关闭发生在**下一批次**，当新 Watermark 生效时。

---

## 第 3 章 多 Source 场景的 Watermark 对齐

### 3.1 全局 Watermark = 所有 Source Watermark 的最小值

当流查询涉及多个 Source（如流-流 Join、UNION 多个 Kafka Topic）时，每个 Source 有自己独立的 Watermark，而全局 Watermark（用于窗口关闭决策）取所有 Source Watermark 的**最小值（min）**：

```
Source A（高速流）：Watermark = 10:20:00
Source B（低速流）：Watermark = 10:05:00

全局 Watermark = min(10:20:00, 10:05:00) = 10:05:00
→ 只有结束时间 <= 10:05:00 的窗口才会关闭
→ 即使 Source A 的数据已经到了 10:30，窗口 10:00-10:05 也不会关闭，
   因为 Source B 只确认到 10:05 之前的数据到齐了
```

**设计原因**：流-流 Join 需要等待两条流的数据都到齐才能关闭窗口。如果用两个 Source 中较大的 Watermark，可能导致 Source B 还有 10:10 的延迟数据未到，但窗口已经被 Source A 的高 Watermark 关闭，丢失了 Source B 的迟到数据。取 min 是最保守的正确策略。

### 3.2 低速 Source 导致全局 Watermark 停滞

`min of all sources` 策略带来一个严重的生产问题：**一个低速或停滞的 Source 会拖慢整个查询的 Watermark 推进**，进而导致：

1. 窗口永远无法关闭，State Store 无限增长
2. Append 模式下没有数据输出（因为没有窗口确定关闭）
3. State 内存不断膨胀，最终 OOM

**典型场景**：流-流 Join 中，一个高吞吐的事件流（Source A，每秒 10 万条）与一个低吞吐的维度更新流（Source B，每小时只有几条更新）。Source B 的 Watermark 长时间停在很早的时间点，拖累全局 Watermark。

**解决方案一**：为低速 Source 单独设置更小的 Watermark 延迟阈值

```python
# 高速流：允许 10 分钟延迟
high_stream = events.withWatermark("event_time", "10 minutes")

# 低速流：只允许 1 分钟延迟（减少 Watermark 停滞）
low_stream = updates.withWatermark("update_time", "1 minute")

# Join
joined = high_stream.join(low_stream, ...)
```

**解决方案二**：将低速 Source 改为批处理读取（流-批 Join）

如果维度更新流可以接受"非实时更新"，将其改为定期刷新的静态 DataFrame，避免引入第二个 Source 的 Watermark 约束：

```python
# 每小时重新读取维度表（批处理，不是流）
dim_df = spark.read.table("dim_updates")  # 静态 DataFrame

# 流-批 Join 不受低速 Source Watermark 限制
result = high_stream.join(dim_df, "userId")
```

---

## 第 4 章 Watermark 与 State 清理的精确时序

### 4.1 窗口关闭的条件

以 5 分钟滚动窗口为例，窗口 `[10:00, 10:05)` 的关闭条件：

```
窗口结束时间 10:05 < 当前全局 Watermark W

即：W > 10:05 时，窗口 [10:00, 10:05) 关闭
```

具体流程：

1. **batchId=N**：全局 Watermark 推进到 `W = 10:06:20`（因为某批次出现了 10:16 的事件）
2. **batchId=N 的状态更新**：本批次中时间戳在 `[10:00, 10:05)` 的所有事件，更新窗口 `[10:00, 10:05)` 的聚合状态
3. **batchId=N 的窗口关闭判断**：`W = 10:06:20 > 10:05`，窗口 `[10:00, 10:05)` 关闭
4. **输出**（Append 模式）：将窗口 `[10:00, 10:05)` 的最终聚合结果写出到 Sink
5. **State 清理**：从 State Store 中删除窗口 `[10:00, 10:05)` 的所有状态

**注意**：步骤 2 和步骤 3 在同一个批次发生——本批次的新数据先更新状态，然后判断是否关闭窗口。这意味着：即使本批次有属于 `[10:00, 10:05)` 的迟到数据（但其事件时间 > 当前 Watermark，即未被判断为过期），也会被计入该窗口的最终结果。

### 4.2 迟到数据被丢弃的条件

一条迟到数据被**丢弃**的精确条件：

```
数据的事件时间 <= 当前批次开始时的 Watermark
（即：数据的窗口在当前批次之前已经关闭）
```

```
当前 Watermark = 10:06:20
一条迟到数据：事件时间 = 10:04:30（属于窗口 [10:00, 10:05)）
判断：10:04:30 <= 10:06:20（窗口 [10:00, 10:05) 结束时间 10:05 < W = 10:06:20）
→ 该数据被丢弃，不计入任何窗口
```

### 4.3 非窗口聚合（GROUP BY key）的 State 清理

对于非窗口的 GROUP BY 聚合（如 `GROUP BY userId`），State 清理的逻辑与窗口聚合不同：

```python
# 非窗口聚合：统计每个用户的总消费
result = events \
    .withWatermark("event_time", "1 hour") \
    .groupBy("userId") \
    .agg(sum("amount"))
```

此时没有窗口边界，Spark 如何清理 `userId` 的状态？

**规则**：当某个 `userId` 最后一次出现的事件时间 + 延迟阈值 < 当前 Watermark 时，该 userId 的状态被清理。

```
userId='user_001' 最后一次出现：事件时间 09:50:00
延迟阈值：1 小时
当前 Watermark：11:00:00

判断：09:50:00 + 1 小时 = 10:50:00 < 11:00:00（当前 Watermark）
→ user_001 的状态可以清理
```

对于非窗口聚合，State 清理需要 Spark 跟踪每个 Key 的"最后事件时间"，这本身也需要存储在 State Store 中，有额外开销。

---

## 第 5 章 Watermark 停滞的诊断与处理

### 5.1 Watermark 停滞的症状

**Watermark 停滞**是生产中最常见的 Structured Streaming 问题之一：Watermark 长时间不推进，导致 State Store 无限增长，最终 OOM 或 Checkpoint 超时。

**症状**：
- Spark UI → Streaming 标签页：Global Watermark 值长时间不变
- State Store 大小（`stateRows`、`stateMemory`）持续增长，不见下降
- Append 模式查询没有任何数据输出

### 5.2 Watermark 停滞的根因

**根因一：某个 Source 分区没有数据**

Kafka Source 的 Watermark 基于该批次读取到的所有事件的 maxEventTime。如果某个 Kafka 分区长时间没有数据（该分区的生产者停止写入），该批次读到的事件全部来自其他分区，maxEventTime 可能正常推进。

但如果 Kafka Source 有 `startingOffsets=latest` 的配置，且某个分区完全没有新消息，该分区的 Offset 不推进——这通常不影响单 Source 的 Watermark（Watermark 只看事件时间，不看 Offset）。

**真正影响 Watermark 的情况**：有 Source 持续没有任何数据（比如 Kafka 连接断开）。此时该批次没有任何事件，maxEventTime 无法更新，Watermark 不推进。

```python
# 诊断：在 foreachBatch 中打印 Watermark
def diagnose(df, batch_id):
    from pyspark.sql.functions import max as spark_max
    if df.count() == 0:
        print(f"Batch {batch_id}: EMPTY BATCH - Watermark may stall")
    else:
        max_ts = df.agg(spark_max("event_time")).collect()[0][0]
        print(f"Batch {batch_id}: maxEventTime={max_ts}")
```

**根因二：事件时间列有大量 NULL**

如果大量记录的 `event_time` 列为 NULL，这些记录不参与 maxEventTime 的计算。如果非 NULL 记录很少，Watermark 推进缓慢。

**诊断**：
```python
# 检查事件时间 NULL 比例
df.agg(
    count("*").alias("total"),
    count("event_time").alias("non_null_ts"),
    (count("event_time") / count("*")).alias("non_null_ratio")
).show()
```

**根因三：多 Source Join，低速 Source 拖累**

见第 3 章 3.2 节，解决方案是分离低速 Source 为批处理。

**根因四：Watermark 延迟阈值设置过大**

延迟阈值 = 2 小时，意味着 Watermark 始终比当前 maxEventTime 落后 2 小时。如果数据产生的事件时间是"现在"，Watermark 会实时推进；但如果在消费历史积压数据时，积压中的事件时间跨度 < 2 小时，Watermark 会推进但窗口不关闭（需要等数据的事件时间跨度超过 2 小时才能关闭早期窗口）。

### 5.3 通过 Spark UI 监控 Watermark

Spark UI → Streaming 标签页提供了流查询的实时指标，Watermark 相关的关键指标：

- **eventTime.watermark**：当前全局 Watermark 值（epoch 毫秒数，需要转换为可读时间）
- **eventTime.max**：当前批次的最大事件时间
- **eventTime.avg**：当前批次的平均事件时间

通过 StreamingQueryListener 也可以获取这些指标：

```python
from pyspark.sql.streaming import StreamingQueryListener

class WatermarkMonitor(StreamingQueryListener):
    def onQueryProgress(self, event):
        progress = event.progress
        # 获取 Watermark 信息
        for source_info in progress.sources:
            print(f"Source: {source_info.description}")
        
        # 全局事件时间统计
        et_stats = progress.eventTime
        if et_stats:
            watermark = et_stats.get("watermark", "N/A")
            max_et = et_stats.get("max", "N/A")
            print(f"Watermark: {watermark}, MaxEventTime: {max_et}")
            
            # 计算 Watermark 滞后（maxEventTime - watermark）
            # 正常应等于延迟阈值，如果远大于阈值则有问题

spark.streams.addListener(WatermarkMonitor())
```

---

## 第 6 章 Watermark 的边界与反例

### 6.1 Watermark 不能保证零数据丢失

Watermark 是一个**概率性机制**，不是零损失的精确保证：

- **保证**：事件时间 > 当前 Watermark 的数据会被处理
- **无法保证**：事件时间 <= 当前 Watermark 的迟到数据不会被丢弃（这些数据被 Spark 丢弃）

延迟阈值设置得多大，才能"不丢失数据"？在数据质量良好的场景（客户端时钟准确、网络延迟在秒级），5-10 分钟的延迟阈值通常能覆盖 99.9% 的迟到数据。但总会有极少数超过阈值的迟到数据被丢弃。

**如果业务要求零丢失**：不要用 Watermark 的 Append 模式。改为：
1. 用 Update 模式，接受结果被不断更新
2. 或用 Lambda 架构（实时层 + 批处理层修正）：流处理提供近似实时结果，每天用批处理跑完整数据修正

### 6.2 处理时间 Watermark vs 事件时间 Watermark

Structured Streaming 的 `withWatermark` 只支持**事件时间 Watermark**（基于数据中的时间字段）。

如果需要基于处理时间做窗口（如"每 5 分钟统计一次，不管数据的实际时间"），直接用 `processingTime` 触发器 + `window()` 函数，不需要 Watermark：

```python
# 处理时间窗口（不用 Watermark）
result = events \
    .groupBy(window(current_timestamp(), "5 minutes")) \  # 用处理时间
    .agg(count("*"))

query = result.writeStream \
    .outputMode("update") \  # 处理时间窗口通常用 Update 模式
    .start()
```

但这样的统计结果会把不同实际发生时间的事件混合在同一个"处理窗口"内，通常不符合业务语义。事件时间窗口才是正确的选择。

---

## 小结

Watermark 是 Structured Streaming 处理乱序数据、控制状态大小的核心机制：

- **推进算法**：`Watermark = max(当前 Watermark, 批次 maxEventTime - 延迟阈值)`，单调递增，每批次结束时更新
- **迟到数据判断**：事件时间 <= 当前 Watermark → 丢弃；事件时间 > Watermark → 接受
- **多 Source 对齐**：全局 Watermark = min(所有 Source 的 Watermark)，低速 Source 会导致全局 Watermark 停滞
- **State 清理时机**：窗口结束时间 < Watermark → 窗口关闭，状态删除（Append 模式输出结果）
- **时间戳异常值**：未来时间戳会把 Watermark 推进到极远，导致大量正常数据被丢弃，生产中必须过滤
- **停滞诊断**：通过 Spark UI 或 StreamingQueryListener 监控 eventTime.watermark 和 eventTime.max 的差值

第 05 篇将深入四种 Trigger 的语义与适用场景：`ProcessingTime` 的批次间隔控制、`Once` 的单次执行语义、Spark 3.3 新增的 `AvailableNow`（批量处理积压数据的利器）、以及 `Continuous` 的特殊模式。

---

> [!note] 思考题
> 1. Watermark 的推进算法基于"所有 Source 分区中最大事件时间的最小值减去延迟阈值"。在多分区 Kafka Source 场景下，如果某个分区长时间没有新数据（比如该分区的生产者宕机），这个分区的最大事件时间会停滞，导致整个 Watermark 停滞不前，进而阻止窗口关闭和状态清理。Spark 如何处理这种"僵死分区"问题？
> 2. Watermark 是事件时间延迟容忍度的上界，超过这个上界的迟到数据默认被丢弃。但"丢弃"是唯一的处理策略吗？在某些业务场景（如金融对账）中，即使数据很晚到达，也必须被处理。有哪些工程手段可以在 Structured Streaming 框架内处理"超 Watermark 迟到数据"，而不是简单丢弃？
> 3. Watermark 更新发生在批次结束时，而不是实时更新。这意味着在一个批次处理期间，Watermark 是固定的。如果一个批次内既包含大量历史数据（时间戳很老）又包含实时数据（时间戳很新），这个批次结束后 Watermark 会跳跃式前进很大一段距离，导致大量窗口同时关闭。这种"Watermark 跳跃"会引发什么性能问题？

## 参考资料

- Apache Spark 官方文档：Structured Streaming - Handling Late Data and Watermarking
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.EventTimeWatermarkExec`
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.WatermarkTracker`
- [The world beyond batch: Streaming 101（O'Reilly, Tyler Akidau 2015）](https://www.oreilly.com/ideas/the-world-beyond-batch-streaming-101)
- [The world beyond batch: Streaming 102（O'Reilly, Tyler Akidau 2016）](https://www.oreilly.com/ideas/the-world-beyond-batch-streaming-102)
