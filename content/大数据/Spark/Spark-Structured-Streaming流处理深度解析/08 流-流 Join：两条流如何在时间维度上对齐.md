---
title: "流-流 Join：两条流如何在时间维度上对齐"
date: 2026-02-28
tags: [Join Buffer, Spark, State Store, Stream-Stream Join, Structured Streaming, Watermark, 时间对齐, 流-流Join]
aliases: []
---

# 08 流-流 Join：两条流如何在时间维度上对齐

## 摘要

流-批 Join（流与静态 DataFrame Join）在语义上是直观的：静态表的数据不变，流的每批数据与静态表做 Lookup。但**流-流 Join**（两条均在持续更新的流的 Join）在语义上有根本性挑战：两条流的数据可能乱序、延迟到达，如何确保两侧匹配的行能够"相遇"？Structured Streaming 通过维护**双侧 Join Buffer（两个 State Store）**解决这一问题：Stream A 的每条记录缓存到 State Store A，等待 Stream B 的匹配行；Stream B 同理。Watermark 负责控制 Buffer 的清理时机——当系统确认某个时间之前的数据不再到来时，Buffer 中该时间范围内未被匹配的行才能安全丢弃（Inner Join 直接丢弃，Left/Right Outer Join 输出 NULL 行）。本文深度解析流-流 Join 的 State Buffer 机制、与 Watermark 的精确交互、支持的 Join 类型及限制、以及高并发场景下 Join Buffer 膨胀的控制策略。

---

## 第 1 章 流-流 Join 的核心挑战

### 1.1 批处理 Join 为什么不能直接用于流处理

批处理 Join 的前提：**Join 时两张表的数据都已完整可用**。

```sql
-- 批处理 Join：两张表全量数据都在，可以直接做 HashJoin 或 SortMergeJoin
SELECT a.*, b.*
FROM orders a JOIN shipments b ON a.orderId = b.orderId
```

流-流 Join 的现实：

```
时刻 T=0:
  orders 流：{orderId=001, userId=A, amount=100}
  shipments 流：{orderId=002, trackingNo=TRK002}（orderId=001 的shipment还没来）

→ orderId=001 的 order 和 shipment 还不能 Join（shipment 未到达）
→ 必须先把 orderId=001 的 order 存起来，等待其对应的 shipment

时刻 T=5分钟:
  shipments 流：{orderId=001, trackingNo=TRK001}（终于来了）

→ 现在可以 Join：order(001) × shipment(001) → 输出结果
```

**核心问题**：等待 Join 的对方数据到来，需要把已到的数据**缓存**起来，但缓存多久？永久缓存内存撑不住，但缓存太短会导致数据丢失（对方的数据还没来就被清了）。**Watermark 提供了答案**：缓存到 Watermark 确认对方数据不再来为止。

---

## 第 2 章 流-流 Join 的 State Buffer 机制

### 2.1 双侧 State Buffer

Structured Streaming 为流-流 Join 维护**两个 State Store**（每侧一个），分别缓存两条流中尚未被 Join 匹配的数据：

```
Stream A (orders)       Stream B (shipments)
    │                        │
    ▼                        ▼
┌─────────────┐         ┌─────────────┐
│ State Store │         │ State Store │
│    A_buf    │         │    B_buf    │
│ (未匹配的   │         │ (未匹配的   │
│  orders 行) │         │ shipments行)│
└──────┬──────┘         └──────┬──────┘
       │                        │
       └──────── JOIN ──────────┘
                  │
              输出匹配结果
```

**数据到来时的处理流程**：

当 Stream A（orders）的一条新记录到来时：
1. 在 B_buf（shipments 的 State Store）中查找匹配的行（按 Join Key 查找）
2. 如果找到匹配：输出 Join 结果
3. 将该 orders 记录存入 A_buf（等待可能的延迟 shipments 数据）

当 Stream B（shipments）的一条新记录到来时：
1. 在 A_buf（orders 的 State Store）中查找匹配的行
2. 如果找到匹配：输出 Join 结果
3. 将该 shipments 记录存入 B_buf

**关键点**：即使找到了匹配，原记录**仍然保留在 State Store 中**（因为可能还有另一侧的延迟数据来匹配）。只有 Watermark 推进时，才会清理确定"不会再有匹配"的记录。

### 2.2 Watermark 控制 Buffer 清理

要清理 A_buf 中的一条 orders 记录（`orderId=001, event_time=10:00`），需要确认：
- Stream B 中所有可能匹配 `orderId=001` 的 shipments 记录都已经到达了

对于有时间边界的 Join（如"Join 条件包含时间范围"），这个确认可以通过 Watermark 实现：

```python
# 带时间约束的流-流 Join
orders.withWatermark("order_time", "20 minutes") \
    .join(
        shipments.withWatermark("ship_time", "20 minutes"),
        expr("""
            orders.orderId = shipments.orderId AND
            shipments.ship_time >= orders.order_time AND
            shipments.ship_time <= orders.order_time + INTERVAL 5 DAYS
        """)
    )
```

**时间约束的作用**：`ship_time >= order_time AND ship_time <= order_time + 5 days` 限定了 shipment 的到达时间必须在 order 之后 5 天内。这给 Buffer 清理提供了确定性依据：

```
A_buf 清理条件（orders 记录可以被清理）：
  对于 orders 记录 order_time=T：
  所有可能匹配的 shipments 的 ship_time 范围是 [T, T+5天]
  当 Stream B 的 Watermark(B) > T + 5天 时：
    → 所有 ship_time <= T+5天 的 shipments 都已到达（或被判定为迟到丢弃）
    → orders 记录可以安全清理

B_buf 清理条件（shipments 记录可以被清理）：
  对于 shipments 记录 ship_time=S：
  可以匹配的 orders 的 order_time 范围是 [S-5天, S]
  当 Stream A 的 Watermark(A) > S 时：
    → 所有 order_time <= S 的 orders 都已到达
    → shipments 记录可以安全清理
```

**全局清理时机**：取两个 Source 的 Watermark 的最小值作为全局 Watermark（第 04 篇详述），确保两侧都确认了数据到齐后才清理。

---

## 第 3 章 支持的 Join 类型

### 3.1 Inner Join（需要 Watermark）

```python
# Inner Join：两侧都有匹配才输出
joined = orders \
    .withWatermark("order_time", "20 minutes") \
    .join(
        shipments.withWatermark("ship_time", "20 minutes"),
        expr("""
            orderId = shipmentOrderId AND
            ship_time >= order_time - INTERVAL 1 HOUR AND
            ship_time <= order_time + INTERVAL 5 DAYS
        """)
    )
query = joined.writeStream.outputMode("append").start()
```

**Inner Join 的语义**：只有当两侧都有匹配的行时才输出。Buffer 中的记录如果在 Watermark 推进后仍未被匹配，则**直接丢弃**（不产生输出）。

**Inner Join 必须有时间约束**：没有时间约束（只有 `orderId = shipmentOrderId`）的 Inner Join 理论上永远不能清理 Buffer（任何时候都可能来一条匹配的记录），State 无限增长。Spark 会要求用户添加时间约束条件。

### 3.2 Left Outer / Right Outer Join（必须有 Watermark）

```python
# Left Outer Join：orders 侧全部输出，shipments 侧没有匹配则填 NULL
joined = orders \
    .withWatermark("order_time", "20 minutes") \
    .join(
        shipments.withWatermark("ship_time", "20 minutes"),
        expr("orderId = shipmentOrderId AND ship_time BETWEEN order_time AND order_time + INTERVAL 5 DAYS"),
        how="left_outer"
    )
query = joined.writeStream.outputMode("append").start()
```

**Left Outer Join 的 Buffer 清理语义**：

当一条 orders 记录（order_time=T）在 Buffer 中等待，且 Watermark 推进到确认"不再有能匹配它的 shipments"时：
- 如果已经找到了匹配的 shipment：已在匹配时输出
- 如果没有找到匹配：输出 `(order_row, NULL, NULL, ...)`（NULL 填充 shipments 侧）

这就是 Left Outer Join 的"延迟输出"：一条 orders 记录的输出时机不是数据到来时，而是确认"等待超时（Watermark 超过预期的最晚 shipment 时间）"后。

**输出延迟**：Left/Right Outer Join 的输出延迟 = Watermark 延迟阈值（需要等待 Watermark 推进到超过时间约束的上界才能确认"未匹配"）。

### 3.3 不支持的 Join 类型

| Join 类型 | 支持情况 |
|---------|---------|
| Inner Join（有时间约束） | ✅ 支持 |
| Left Outer Join（有 Watermark） | ✅ 支持 |
| Right Outer Join（有 Watermark） | ✅ 支持 |
| Full Outer Join | ❌ 不支持 |
| Cross Join（笛卡尔积） | ❌ 不支持（无 Join Key，无法分组） |
| Inner Join（无时间约束） | ❌ Buffer 无法清理，不允许 |
| Left Semi / Anti Join | ❌ 不支持 |

---

## 第 4 章 Join Buffer 膨胀的控制

### 4.1 Buffer 大小的决定因素

```
A_buf 大小 ≈ 时间窗口内 Stream A 的记录数
           = (时间约束上界 - 时间约束下界 + Watermark延迟阈值) × 数据速率

例：时间约束 [order_time, order_time+5days]，Watermark=20分钟，Stream A 速率=1万条/分钟
  A_buf ≈ (5天 + 20分钟) × 1万 = 5×24×60×1万 ≈ 7200万条
```

7200 万条记录的 Buffer 对内存是极大的压力。控制 Buffer 的核心杠杆：**缩小时间约束范围**。

### 4.2 控制 Buffer 膨胀的策略

**策略一：缩短时间约束范围**

```python
# 时间约束从 5 天缩短到 1 小时（业务允许的话）
expr("ship_time BETWEEN order_time AND order_time + INTERVAL 1 HOUR")
# Buffer 大小从 7200 万 → 60万（缩小 120 倍）
```

**策略二：使用 RocksDB State Store**

大型 Join Buffer 超出内存时，RocksDB State Store 可以将冷数据溢出到 SSD，避免 OOM。

**策略三：减小 Watermark 延迟阈值**

Watermark 延迟阈值越小，Buffer 清理越及时。但这会增加迟到数据的丢失率（见第 04 篇权衡）。

> [!warning] 生产避坑
> 流-流 Join 的 Buffer 是最容易被忽视的内存消耗点。上线前必须估算 Buffer 大小（= 时间窗口 × 每秒数据量 × 单行大小），并确保 State Store 的存储容量（内存或 RocksDB SSD）足够。建议在压测时监控 `stateMemory` 和 `stateRows` 指标，确认 Buffer 在 Watermark 推进后正常缩减。

---

## 小结

流-流 Join 通过双侧 State Buffer 解决时间对齐问题：

- **双侧 State Buffer**：两条流各维护一个 State Store，缓存等待匹配的记录；新数据到来时先查对侧 Buffer，再存入本侧 Buffer
- **时间约束**：必须定义 Join 条件的时间范围（如 `ship_time BETWEEN order_time AND order_time + 5 DAYS`），否则 Buffer 无法清理
- **Watermark 控制清理**：全局 Watermark 推进时，超出时间约束范围的 Buffer 记录被清理；Left Outer Join 的未匹配行输出 NULL
- **Buffer 膨胀风险**：时间窗口越大，Buffer 越大；RocksDB State Store + 合理的时间约束是控制内存的关键手段
- **支持范围**：Inner/Left Outer/Right Outer Join（均需时间约束）；Full Outer/Cross Join 不支持

第 09 篇讲解 `dropDuplicates`：如何在流处理中实现精确去重、与 Watermark 结合实现有界去重（防止 State 无限增长）、以及 Exactly-once 语义在应用层的保障。

---

> [!note] 思考题
> 1. 流-流 Join 通过双侧 State Buffer 来缓存未匹配的事件，等待另一侧的匹配事件到来。如果两侧流的事件时间偏差很大（比如左流平均延迟 1 分钟，右流平均延迟 10 分钟），State Buffer 的大小会受到什么影响？Watermark 应该如何设置才能在及时清理 Buffer 与保留足够匹配窗口之间取得平衡？
> 2. 流-流 Inner Join 要求两侧都必须有 Watermark，否则 State Buffer 永不清理。但 Left Outer Join 在语义上允许右侧没有匹配行时输出 NULL。Spark 如何确定"右侧确实没有匹配行"而不是"右侧数据还没到达"？这个判断逻辑依赖 Watermark 的哪个特性？
> 3. 流-流 Join 的 State Buffer 分布在各个 Executor 的 State Store 中。当 Executor 发生故障时，对应的 State Buffer 会丢失。Spark 是通过 Checkpoint 来恢复这些状态的，但 Checkpoint 是在批次结束时写入的。如果 Executor 在批次处理中途失败，这个批次的 State 更新是否会丢失？Spark 如何保证流-流 Join 的端到端一致性？

## 参考资料

- Apache Spark 官方文档：Structured Streaming Join Operations
- Apache Spark 源码：`org.apache.spark.sql.execution.streaming.StreamingSymmetricHashJoinExec`
- [Stream-Stream Joins in Apache Spark 2.3（Databricks Blog）](https://www.databricks.com/blog/2018/03/13/introducing-stream-stream-joins-in-apache-spark-2-3.html)
