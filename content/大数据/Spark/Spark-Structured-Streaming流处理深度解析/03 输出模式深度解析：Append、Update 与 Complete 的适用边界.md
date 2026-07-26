---
title: "输出模式深度解析：Append、Update 与 Complete 的适用边界"
date: 2026-02-28
tags: [Append, Complete, Spark, Structured Streaming, UPDATE, Watermark, 聚合, 输出模式]
aliases: []
---

# 03 输出模式深度解析：Append、Update 与 Complete 的适用边界

## 摘要

Structured Streaming 的三种输出模式（Output Mode）——**Append**、**Update**、**Complete**——决定了每个 MicroBatch 向 Sink 写出哪些行。这不仅是"写哪些数据"的问题，更深层地关联着**查询语义的可正确性**：不是每种查询都与每种输出模式兼容，错误地选择输出模式会导致 Spark 直接报错（如对聚合查询使用 Append 模式）或静默产生语义错误的结果。三种模式的设计背后是对"哪些行的结果是确定的（不再改变）"这一问题的不同回答：Append 模式要求结果行**确定后才输出**（一旦输出不再修改）；Update 模式每批次输出**本批发生变化的行**（结果可以被后续批次覆盖）；Complete 模式每批次输出**全量当前结果**（完整重写）。本文深度讲解三种模式的内在语义、与不同查询类型（无状态/有状态/窗口聚合）的兼容性矩阵、以及 Watermark 如何使聚合查询支持 Append 模式（让"已确定"的窗口结果可以安全输出）。

---

## 第 1 章 为什么输出模式如此重要

### 1.1 "增量输出"的语义挑战

在批处理中，查询结果只有一份：`SELECT category, SUM(amount) FROM orders GROUP BY category` 的结果是确定的，一次性输出。

在流处理中，同一个聚合查询的结果会**随着新数据不断更新**：
- t=0：`food → 100`
- t=1：又来了一批 food 数据 → `food → 350`
- t=2：又来了更多 food 数据 → `food → 800`

每个 MicroBatch 结束时，`food` 的聚合值都可能发生变化。现在问题来了：每次批次结束后，应该向 Sink 写什么？

- 只写变化的行（`food → 350`，表示更新）？
- 写全部当前结果（所有 category 的最新值）？
- 还是等 food 的值"确定不再变化"后才写？

三种不同的答案，对应三种输出模式。

### 1.2 输出模式与 Sink 的关系

不同的输出模式对 Sink 的语义要求不同：

- **Append 模式**：Sink 只需要支持追加写入（append），写出的每行数据不会被后续批次修改，适合所有 Sink（Kafka、File、JDBC）
- **Update 模式**：Sink 需要支持行级更新（upsert），后续批次可能写出相同 key 的更新行，适合支持 UPSERT 的 Sink（Kafka、MySQL、HBase）；不适合只追加写入的 FileSink（会产生重复行）
- **Complete 模式**：每批次覆盖全量结果，Sink 需要支持全量覆盖（overwrite），或本身是可以被全量替换的内存结构（如内存表）；FileSink 可以用 `overwrite` 模式支持 Complete

---

## 第 2 章 Append 模式：只输出"确定"的行

### 2.1 Append 模式的语义定义

**Append 模式**：每个 MicroBatch 只向 Sink 输出**新增的行**，且这些行保证**不会被后续批次修改**。

"不会被后续批次修改"这个保证是 Append 模式能够与 FileSink、KafkaSink 安全结合的前提——这些 Sink 通常只支持追加写入，无法修改已写出的数据。如果 Spark 在后续批次需要修改之前写出的行，但 Sink 不支持修改，就会产生错误结果。

**适用查询类型**：

**完全适用：无状态查询（filter、map、select、join with static）**

无状态查询（不包含聚合/窗口/有状态 join）的每一行输出只依赖当前批次的输入行，不存在"修改历史输出"的需求。每个批次的新输入行产生新输出行，完全符合 Append 语义。

```python
# 适合 Append 模式的查询（无状态）
result = events \
    .filter(col("amount") > 100) \
    .select("userId", "amount", "ts")

query = result.writeStream \
    .outputMode("append") \
    .format("parquet") \
    .option("checkpointLocation", "/ckpt/") \
    .start()
```

**有条件适用：带 Watermark 的聚合/窗口查询**

对于聚合查询，默认 Append 模式**不可用**。但当查询同时定义了 Watermark 时，Spark 能够判断哪些窗口/聚合组的结果已经"最终确定"（不会再有新数据影响），并只在结果确定后才将其输出——这使 Append 模式对带 Watermark 的聚合查询可用。

```python
# 带 Watermark 的窗口聚合 + Append 模式
result = events \
    .withWatermark("event_time", "10 minutes") \   # 定义 Watermark
    .groupBy(window("event_time", "5 minutes"), "category") \
    .agg(sum("amount").alias("total"))

query = result.writeStream \
    .outputMode("append") \   # Watermark 保证窗口关闭后才输出
    .format("parquet") \
    .start()
```

**不可用：不带 Watermark 的聚合查询**

没有 Watermark 时，Spark 无法知道某个 Key 的聚合结果何时"最终确定"（理论上任何时候都可能有该 Key 的新数据到来），因此无法用 Append 模式输出聚合结果——会抛出 `AnalysisException`。

### 2.2 为什么无 Watermark 的聚合不能用 Append

以 `SELECT category, SUM(amount) FROM events GROUP BY category` 为例：

```
batchId=0：events={food:100, drink:50}
  → 结果：food=100, drink=50
  → 能输出吗？food=100 是最终结果吗？不能确定——下一批可能还有 food 数据
  → Append 模式无法输出，因为不确定

batchId=1：events={food:200, sport:30}
  → 结果：food=300, drink=50, sport=30
  → food 从 100 变成了 300——如果 batchId=0 已经向 Sink 写出了 food=100，
     Sink 中就有错误的历史数据
  → 矛盾！Append 模式假设写出的行不再修改，但聚合结果必须修改
```

---

## 第 3 章 Complete 模式：每批次全量输出

### 3.1 Complete 模式的语义

**Complete 模式**：每个 MicroBatch 向 Sink 输出**当前查询的完整结果**（所有行），覆盖之前的输出。

对于聚合查询，Complete 模式每次写出所有已知 Key 的最新聚合值：

```
batchId=0：events={food:100, drink:50}
  → 写出：food=100, drink=50（全量 2 行）

batchId=1：events={food:200, sport:30}
  → 写出：food=300, drink=50, sport=30（全量 3 行，覆盖之前的 2 行）
```

**适用查询类型**：仅适用于**聚合查询**（GROUP BY），或其他需要汇总全量状态的查询。

```python
# Complete 模式：实时维护所有 category 的累计销售额
result = events \
    .groupBy("category") \
    .agg(sum("amount").alias("total_amount"), count("*").alias("cnt"))

query = result.writeStream \
    .outputMode("complete") \
    .format("memory") \         # 内存表（调试用）
    .queryName("category_stats") \
    .start()

# 查询内存表（每次查到的是最新的完整结果）
spark.sql("SELECT * FROM category_stats ORDER BY total_amount DESC").show()
```

### 3.2 Complete 模式的生产风险

**风险一：State Store 无限增长**

Complete 模式下，State Store 必须**永久保留所有历史 Key 的聚合状态**——因为任何一个历史 Key 在未来都可能出现新数据，State Store 无法丢弃任何已有的 Key。

随着时间推移，State Store 中的 Key 数量单调递增，可能导致：
- RocksDB State Store 文件不断膨胀，磁盘空间耗尽
- State Store 读写 latency 持续升高
- Checkpoint 文件越来越大，Checkpoint 耗时越来越长

**风险二：每批次全量写出的 I/O 代价**

Complete 模式每批次写出全量结果。如果结果集有 100 万行，每批次都写 100 万行，这是巨大的 I/O 开销——即使本批次只有 1000 行新数据，也要重写所有 100 万行。

**生产建议**：Complete 模式适合**低基数聚合**（Key 的种类有限且不增长，如 `GROUP BY region`，只有几十个国家/地区），不适合高基数聚合（如 `GROUP BY userId`，数亿用户，State 无限增长）。

> [!warning] 生产避坑
> Complete 模式不能与 Watermark 一起使用。因为 Watermark 的设计目的是清理过期状态（允许 Spark 丢弃"已过期的窗口/Key 的状态"），而 Complete 模式要求永久保留所有状态——两者语义冲突。如果同时定义 Watermark 和使用 Complete 模式，Spark 会报 `AnalysisException`。

---

## 第 4 章 Update 模式：只输出变化的行

### 4.1 Update 模式的语义

**Update 模式**：每个 MicroBatch 只向 Sink 输出**本批次发生变化的行**（新增或更新的行，不包含未变化的行）。

对于无状态查询，Update 模式与 Append 模式等价（每行只生成一次，没有更新）。对于聚合查询，Update 模式只输出本批次聚合值发生变化的 Key：

```
batchId=0：events={food:100, drink:50}
  → 变化的 Key：food（新增，100），drink（新增，50）
  → 写出：food=100, drink=50（2 行）

batchId=1：events={food:200, sport:30}
  → 变化的 Key：food（更新，100→300），sport（新增，30）
  → 写出：food=300, sport=30（2 行，drink 未变化不输出）
```

### 4.2 Update 模式与 Append 模式的核心区别

| 维度 | Append 模式 | Update 模式 |
|-----|-----------|-----------|
| **输出内容** | 只输出"最终确定"的新行 | 输出"本批次发生变化"的行（含修改后的旧 Key） |
| **历史行修改** | 写出后**不会修改** | 写出的行**可以在后续批次被再次写出（更新值）** |
| **Sink 要求** | 只需追加写入 | 需要支持 UPSERT 语义（后来的同 key 行会覆盖）|
| **聚合（无 Watermark）** | **不支持** | **支持** |
| **聚合（有 Watermark）** | 支持（等窗口关闭再输出） | 支持（每次窗口更新立即输出） |
| **State 清理** | 与 Watermark 配合自动清理 | 可以配合 Watermark 清理，但聚合结果中间状态一直更新 |

### 4.3 Update 模式的适用场景

**场景一：实时仪表盘（Dashboard）**

仪表盘通常显示"最新的聚合值"，需要的是 UPSERT 语义——新的计算结果替换旧值。Update 模式天然匹配：

```python
# 实时更新各区域的当前在线用户数
result = sessions \
    .groupBy("region") \
    .agg(count("*").alias("active_sessions"))

# 写到 Redis（支持 UPSERT）
def write_to_redis(df, batch_id):
    import redis
    r = redis.Redis(host="redis-host")
    for row in df.collect():
        r.set(f"active_sessions:{row.region}", row.active_sessions)

query = result.writeStream \
    .outputMode("update") \
    .foreachBatch(write_to_redis) \
    .start()
```

**场景二：实时告警（只关心最新状态）**

对于告警系统，只需要知道"当前某个指标是否超阈值"，不需要历史记录。Update 模式每次只输出状态变化的 Key，避免了 Complete 模式的全量写出开销。

---

## 第 5 章 Watermark 如何使聚合查询支持 Append 模式

### 5.1 Watermark 与"确定性"的关系

Append 模式要求写出的行"不再修改"。对于窗口聚合，一个窗口关闭后（不再有新数据落入该窗口），窗口的聚合结果就"确定了"。**Watermark 就是告诉 Spark"什么时间点之前的数据不再到来"的机制**。

当 Watermark 推进到 `W` 时：
- 所有结束时间 `<= W` 的窗口，结果已确定（不会再有新数据落入）
- 这些窗口的聚合结果可以安全地以 Append 模式写出，且写出后 State Store 可以清理这些窗口的状态

### 5.2 三种模式与 Watermark 的完整兼容矩阵

| 查询类型 | Append | Update | Complete |
|---------|-------|--------|---------|
| 无状态查询（filter/map） | ✅ | ✅ | ❌ |
| 无 Watermark 的聚合 | ❌ | ✅ | ✅ |
| 有 Watermark 的窗口聚合 | ✅（窗口关闭后） | ✅（每批更新） | ❌（与 Watermark 冲突） |
| 有 Watermark 的非窗口聚合 | ✅（Key 过期后） | ✅ | ❌ |
| 流-流 Join（带 Watermark） | ✅ | ❌ | ❌ |
| 流-批 Join | ✅ | ✅ | ❌ |
| `dropDuplicates` | ✅（带 Watermark） | ❌ | ❌ |

---

## 小结

三种输出模式的本质差异在于对"哪些行已确定"的不同处理策略：

- **Append**：只输出"已确定不再修改"的行。无状态查询天然满足；聚合查询需要 Watermark 确定窗口关闭时机；Sink 只需支持追加，最安全
- **Update**：输出"本批次发生变化"的行，可以是更新后的聚合值。不需要 Watermark 也能工作；Sink 需要支持 UPSERT 语义；State 永不清理（除非配合 Watermark）
- **Complete**：每批次输出全量结果。只用于聚合；State 无限增长；每批次全量 I/O；生产中慎用（仅限低基数聚合）

第 04 篇将深入 Watermark 的全貌：推进逻辑（如何从事件时间计算 Watermark）、多 Source 场景下的 Watermark 对齐、Watermark 停滞的诊断与处理，以及 Watermark 与 State 清理的精确关系。

---

> [!note] 思考题
> 1. Append 模式要求只输出"最终确定不会再改变"的行。对于有聚合操作的查询，这意味着必须配合 Watermark 使用——只有窗口关闭后，窗口内的聚合结果才是确定的。但 Watermark 是基于"事件时间延迟"估算的，不是精确的。如果实际延迟比 Watermark 设定的上界更大，会发生什么？迟到数据如何影响 Append 模式输出的"正确性"？
> 2. Complete 模式在每个批次输出全量聚合结果。对于高基数的聚合 Key（比如用户 ID 有 1 亿个），Complete 模式每批次都要向 Sink 写出 1 亿行数据，这显然不现实。Complete 模式的实际适用场景边界在哪里？有没有办法在 Sink 端只接收"变更了的聚合结果"而不是全量？
> 3. Update 模式只输出本批次中发生了变化的行，适合更新型 Sink（如 Redis、Cassandra）。但不同 Sink 的"幂等写入"能力差异很大——有的 Sink 支持 UPSERT，有的只支持 INSERT。当 Spark 重试一个批次（因为 Task 失败）时，Update 模式下的写出是幂等的吗？如何保证端到端精确一次？

## 参考资料

- Apache Spark 官方文档：Structured Streaming Output Modes
- Apache Spark 源码：`org.apache.spark.sql.streaming.OutputMode`
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.IncrementalExecution`
- Armbrust M 等：Structured Streaming（SIGMOD 2018）
