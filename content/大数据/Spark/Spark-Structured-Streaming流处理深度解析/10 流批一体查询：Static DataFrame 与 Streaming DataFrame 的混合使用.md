---
title: "流批一体查询：Static DataFrame 与 Streaming DataFrame 的混合使用"
date: 2026-02-28
tags: [Spark, Static DataFrame, Streaming DataFrame, Structured Streaming, 广播Join, 流批Join, 流批一体, 维表关联]
aliases: []
---

# 10 流批一体查询：Static DataFrame 与 Streaming DataFrame 的混合使用

## 摘要

Structured Streaming 最具工程价值的设计之一，是允许流 DataFrame（Streaming DataFrame）与静态 DataFrame（Static DataFrame，普通批处理读取的表）在同一个查询中混合使用——流数据与维度表关联（Lookup Join）是最典型的场景：用户行为流 × 用户维表（用户基本信息）、交易事件流 × 商品维表（商品详情）、日志流 × 机器维表（主机配置）。这种"流-批 Join"（Stream-Static Join）在语义上比流-流 Join 简单得多：静态表不随时间变化（在每个批次内是固定的），不需要维护双侧 State Buffer，也不需要 Watermark 控制清理——每个批次只是将流的新数据与静态表做一次普通的批处理 Join。本文深度讲解流-批 Join 的执行机制（每批次重新读取 vs 广播缓存）、静态表更新时如何刷新（Session 级别刷新与 DataFrame 重建）、流-批 Join 的语义限制（不支持 Full Outer Join、Right Outer Join），以及维表数量很多时的内存压力控制策略。

---

## 第 1 章 流-批 Join 的动机与执行模型

### 1.1 为什么不用流-流 Join 替代

当一个"维表"（如用户信息表、商品信息表）存储在 Hive 或数据库中，而不是实时 Kafka 流时，有两种选择：

**方案一（错误方向）**：将维表也封装成一个 Kafka Topic，作为流来处理，用流-流 Join。  
**代价**：需要维护双侧 State Buffer，State 无限增长（维表数据永不过期），内存压力极大；维表的完整历史数据都需要进入 Kafka，工程复杂度高。

**方案二（正确方向）**：维表继续存在 Hive/数据库，作为静态 DataFrame 读取，与流 DataFrame 做流-批 Join。  
**优势**：不需要 State Buffer，不需要 Watermark，每批次直接做批处理 Join，内存可控，逻辑简单。

### 1.2 流-批 Join 的执行机制

```python
# 静态维表（每次读取时固定）
user_dim = spark.table("dim_users")  # Hive 表

# 流 DataFrame
event_stream = spark.readStream \
    .format("kafka") \
    .option("subscribe", "user-events") \
    .load()

# 流-批 Join（与普通 DataFrame Join 语法相同）
enriched = event_stream.join(user_dim, "userId", "left_outer")

query = enriched.writeStream \
    .outputMode("append") \
    .format("delta") \
    .start()
```

**每个 MicroBatch 的执行过程**：

```
batchId=5：
  流数据：从 Kafka 读取 [startOffset, endOffset] 内的 1000 条事件（Streaming DataFrame）
  维表数据：执行 spark.table("dim_users")，读取当前 Hive 表的完整数据（Static DataFrame）
  执行 Join：普通批处理 Join（1000条 × dim_users），输出 Join 结果
  
batchId=6：
  流数据：读取 Kafka 的下一批 1200 条事件
  维表数据：再次执行 spark.table("dim_users")（重新读取！）
  执行 Join：1200条 × dim_users
```

**关键点：Static DataFrame 在每个批次中重新读取**。如果 dim_users 在 batchId=5 和 batchId=6 之间有更新（如有新用户注册），batchId=6 会读到最新的维表数据，自动感知维表变化。这与流-流 Join 完全不同——不需要任何额外机制来"刷新"维表。

> [!info] 核心概念
> 这里"重新读取"是对 `spark.table("dim_users")` 而言的逻辑读取。实际上如果维表被 [[Spark Cache|Spark 缓存]]（`.cache()` 或 `.persist()`），重新读取会命中缓存，不走真实 I/O。但缓存的数据是静态的，不会感知维表更新——需要手动 `unpersist()` 再重新读取才能刷新。

---

## 第 2 章 维表缓存策略：每批次读 vs 广播缓存

### 2.1 每批次重新读取的代价

如果维表（`dim_users`）有 1000 万行，每个 MicroBatch 都从 Hive 读取 1000 万行，即使批次间隔只有 10 秒：

```
每秒数据吞吐 = 维表大小 / 批次间隔
= 1000万行 × 每行100字节 / 10秒
= 100MB/s（持续的 Hive 读取 I/O）
```

对于高频批次（秒级），这是不可接受的 I/O 开销。

### 2.2 广播缓存：一次读取，多批次复用

```python
from pyspark.sql.functions import broadcast

# 方案一：广播 Join（Spark 自动广播小维表）
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "100MB")
enriched = event_stream.join(user_dim, "userId")  # 小维表自动广播

# 方案二：显式广播 + 缓存（中等大小维表，如 500MB）
user_dim_cached = user_dim.cache()  # 第一个批次读取后缓存在 Executor 内存
enriched = event_stream.join(broadcast(user_dim_cached), "userId")
```

**广播 Join 的执行流程**：

1. 第一个批次触发时，`user_dim` 被 Driver 端收集（或通过 TorrentBroadcast 分发）到所有 Executor
2. 每个 Executor 在本地内存中维护 `user_dim` 的哈希表（广播变量）
3. 后续批次中，流数据的每条记录直接在本地广播哈希表中查找，无需 Shuffle
4. 维表数据驻留在 Executor 内存，不重复读取 Hive

**广播缓存的大小限制**：`spark.sql.autoBroadcastJoinThreshold`（默认 10MB）。超过此大小的维表不自动广播。对于几百 MB 的维表，可以适当调高阈值（建议不超过 Executor 内存的 10-20%，防止 OOM）。

### 2.3 维表更新时的刷新机制

**广播缓存的失效问题**：一旦 `user_dim` 被广播并缓存，后续批次直接复用缓存数据，不会感知 Hive 维表的更新。如果有新用户注册（维表新增行），缓存的广播变量中不包含这些新用户，`enriched` 的 Join 结果中这些新用户的事件将被 Left Outer Join 填充 NULL。

**刷新策略一：定时重建 DataFrame（推荐）**

在 `foreachBatch` 中定时重建 Static DataFrame：

```python
import time

last_refresh_time = [0]  # 使用列表以支持闭包修改
REFRESH_INTERVAL_SEC = 300  # 每 5 分钟刷新一次维表

def process_with_refresh(batch_df, batch_id):
    global last_refresh_time
    
    current_time = time.time()
    if current_time - last_refresh_time[0] > REFRESH_INTERVAL_SEC:
        # 重新读取维表（会触发新的 Spark 查询读取最新 Hive 数据）
        # 注意：这里需要使用 spark.read 而不是 spark.table（避免缓存）
        fresh_dim = spark.read.table("dim_users")
        # 广播最新维表
        enriched_batch = batch_df.join(broadcast(fresh_dim), "userId", "left_outer")
        last_refresh_time[0] = current_time
    else:
        enriched_batch = batch_df.join(broadcast(cached_dim), "userId", "left_outer")
    
    enriched_batch.write.format("delta").mode("append").save("/output/")

query = event_stream.writeStream \
    .foreachBatch(process_with_refresh) \
    .start()
```

**刷新策略二：接受维表延迟（最简单）**

对于维表更新不频繁（如每天更新一次）的场景，每批次重新读取（不缓存）是最简单的选择：

```python
# 不缓存维表，每批次读取最新数据（适合维表更新频率低、维表不太大的场景）
def process_batch(batch_df, batch_id):
    dim = spark.read.table("dim_users")  # 每次读最新
    result = batch_df.join(dim, "userId", "left_outer")
    result.write.format("delta").mode("append").save("/output/")

query = event_stream.writeStream.foreachBatch(process_batch).start()
```

---

## 第 3 章 流-批 Join 的语义限制

### 3.1 支持的 Join 类型

| Join 类型 | 流在左侧 | 流在右侧 |
|---------|---------|---------|
| Inner Join | ✅ | ✅ |
| Left Outer Join | ✅（流左，静态右） | ❌ |
| Right Outer Join | ❌ | ✅（流右，静态左） |
| Full Outer Join | ❌ | ❌ |
| Left Semi Join | ✅ | ❌ |
| Left Anti Join | ✅ | ❌ |

**为什么 Full Outer Join 不支持**：Full Outer Join 要求输出两侧未匹配的行（静态表中没有对应流数据的行也要输出）。但在流处理中，"静态表中没有匹配的流数据"需要等到"所有流数据都处理完"后才能确定——而流是无界的，永远无法确定"所有数据都处理完了"。因此语义上不可实现。

**为什么 Left Outer Join（流左静态右）支持，但反过来不支持**：流-批 Left Outer Join 语义是"流的每条记录都输出，静态表没有匹配则填 NULL"——流的每条记录立即可以判断是否匹配（用静态表做 Lookup），结果确定。而 Right Outer Join（静态左流右）要求静态表的每行都输出，没有匹配的流数据填 NULL——这同样需要等待所有流数据处理完才能确定，不可实现。

### 3.2 流-批 Join 不需要 Watermark

流-批 Join 不涉及 State Buffer，无需 Watermark：
- 每个 MicroBatch 的流数据与静态表的 Join 是普通的批处理操作
- 没有"等待对方数据"的问题（静态表永远存在）
- 没有状态需要清理

这与流-流 Join 形成鲜明对比（流-流 Join 需要 Watermark 控制 Buffer 清理）。

---

## 第 4 章 多维表 Join 与内存压力控制

### 4.1 多维表 Join 的常见模式

实际生产中，流数据往往需要同时关联多张维表：

```python
# 典型的多维表 Join
user_dim = spark.table("dim_users")         # 1000万用户，每行200字节 ≈ 2GB
product_dim = spark.table("dim_products")   # 500万商品，每行100字节 ≈ 500MB
region_dim = spark.table("dim_regions")     # 10万地区，每行50字节 ≈ 5MB

# 批处理（全部广播）
order_stream \
    .join(broadcast(user_dim), "userId") \
    .join(broadcast(product_dim), "productId") \
    .join(broadcast(region_dim), "regionCode")
```

**问题**：多张维表同时广播 → Executor 内存 = 2GB + 500MB + 5MB = 2.5GB 的广播数据，加上流数据本身的内存，容易 OOM。

### 4.2 分级策略：大维表用 SortMergeJoin

对于超过广播阈值的大维表，不强制广播，让 Spark 选择 SortMergeJoin（两侧 Shuffle）：

```python
# 小维表：广播（无 Shuffle）
order_stream \
    .join(broadcast(region_dim), "regionCode")  # 5MB，广播无压力
    \
    # 大维表：SortMergeJoin（有 Shuffle，但不用驻留内存）
    .join(user_dim, "userId")       # 2GB，Shuffle 处理
    .join(product_dim, "productId") # 500MB，Shuffle 处理
```

**权衡**：SortMergeJoin 需要 Shuffle（增加批次处理时间），但不占用 Executor 持久内存。对于延迟不敏感的场景是合理的选择。

> [!note] 设计哲学
> 流-批 Join 是 Structured Streaming "流批一体"设计哲学的最直接体现：批处理的逻辑（维表 Lookup）与流处理的逻辑（持续事件处理）用统一的 DataFrame API 描述，执行引擎在底层自动处理两者的差异（广播 vs Shuffle，缓存策略，刷新机制）。用户无需在两套不同的 API 间切换，大幅降低了实时数仓建设的工程复杂度。

---

## 小结

流-批 Join 是 Structured Streaming 实际工程中最高频的模式之一：

- **执行机制**：每个批次将流数据与静态 DataFrame 做普通批处理 Join；静态 DataFrame 默认每批次重新读取（感知维表更新）
- **广播缓存**：小维表（< 100MB）自动广播到 Executor 内存，避免重复读取；大维表用 SortMergeJoin
- **维表刷新**：缓存的广播变量不感知维表更新；需要刷新时，在 `foreachBatch` 中定期重建 Static DataFrame
- **支持的 Join 类型**：Inner、Left Outer（流左）、Left Semi/Anti；不支持 Full Outer、Right Outer（流左）
- **无需 Watermark**：流-批 Join 无 State Buffer，不需要 Watermark

第 11 篇深入监控与可观测性：StreamingQueryListener 的完整接口、Spark UI 中流查询指标的解读、关键告警指标（Watermark 停滞、处理速率 < 输入速率、State 持续增长）的设置方法。

---

> [!note] 思考题
> 1. 流-批 Join 中，维表（Static DataFrame）在每个 MicroBatch 开始时被重新广播给所有 Executor。如果维表数据量很大（比如 1GB），频繁广播会给 Driver 和网络带来巨大压力。广播缓存（一次广播多批次复用）是优化手段，但如果维表在流作业运行期间更新了，缓存的广播变量如何刷新？有没有办法做到"感知维表变更后自动刷新"？
> 2. Structured Streaming 的流-批 Join 要求维表在每个批次执行时是"静态快照"——即使底层数据源（如 Hive 表）在批次执行期间发生了写入，本批次读到的维表数据也是固定的。但如果维表是一个 Delta Lake 表并启用了 Time Travel，是否可以实现"每个批次读取与批次事件时间对齐的维表版本"？这种时间旅行 Join 在工程上如何实现？
> 3. 在流批一体架构中，实时流处理和离线批处理共享同一套业务逻辑代码。但两者在 State 管理、输出模式、窗口语义上有很多差异。在设计流批一体 Pipeline 时，有哪些 Structured Streaming 的算子或特性在批处理模式下行为不同，需要特别注意？

## 参考资料

- Apache Spark 官方文档：Structured Streaming Join Operations
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.StreamingJoinStrategy`
- [Stream-Static Joins in Apache Spark Structured Streaming（Databricks Blog）](https://www.databricks.com/blog/2018/03/13/introducing-stream-stream-joins-in-apache-spark-2-3.html)
