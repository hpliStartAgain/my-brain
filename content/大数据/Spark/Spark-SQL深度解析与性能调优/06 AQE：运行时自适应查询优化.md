---
title: "AQE：运行时自适应查询优化"
date: 2026-02-28
tags: [Spark, SparkSQL, AQE, AdaptiveQueryExecution, 动态分区合并, Skew Join, 动态Join策略, QueryStage, Spark3.0]
aliases: []
---

# 06 AQE：运行时自适应查询优化

## 摘要

静态查询优化（CBO + RBO）的根本局限是：所有决策必须在执行开始前做出，依赖对数据规模的**估算**，而不是**真实测量**。统计信息可能过时，基数估算可能有数量级的误差，数据倾斜在执行前根本无从感知。Spark 3.0 引入的 **Adaptive Query Execution（AQE，自适应查询执行）** 彻底改变了这一范式：它在查询执行过程中，以 **Shuffle Exchange** 为边界将执行划分为多个 **QueryStage**，每个 Stage 完成后收集真实的运行时统计（实际行数、分区大小分布），并据此**动态重新规划**后续 Stage 的执行计划。三大核心优化能力——**动态分区合并（Coalesce Shuffle Partitions）**、**动态 Join 策略切换（Dynamic Join Switch）**、**Skew Join 自动优化（Automatic Skew Join Handling）**——覆盖了生产中最高频的三类性能问题，且完全透明（无需修改用户代码）。本文深度拆解 AQE 的运行时框架：QueryStage 的划分与物化机制、三大优化的触发条件与实现原理、AQE 的代价与局限，以及如何通过 AQE 的执行计划可视化来诊断性能问题。

---

## 第 1 章 静态优化的根本局限

### 1.1 "估算"永远不如"测量"

前几篇讲的 RBO 和 CBO，本质上都是在执行前对执行计划做静态决策。这种范式有一个不可回避的根本性问题：**所有决策依赖的是对数据的估算，而不是真实的执行时数据**。

估算必然存在误差，有时是小误差，有时是灾难性的误差。几个典型场景：

**场景一：Shuffle 分区数估算失败**

`spark.sql.shuffle.partitions=200`（默认值）是一个全局静态配置。对于一个简单的小查询（10MB 数据量），200 个分区意味着每个分区只有 50KB——产生 200 个极小的 Task，调度开销远大于实际计算开销。对于一个大查询（10TB 数据量），200 个分区意味着每个分区有 50GB——单个 Task 内存不足，触发大量 Spill，性能急剧下降。同一个数字无法同时满足大查询和小查询的需求。

**场景二：数据倾斜在执行前不可见**

`WHERE userId IN ('hot_user_1', 'hot_user_2')` 过滤后，`hot_user_1` 的数据量是其他分区的 1000 倍，但 CBO 无法在执行前感知到这种不均匀分布（直方图也只是近似）。SortMergeJoin 的某个分区会处理 1000 倍的数据量，整个 Stage 的完成时间取决于这一个慢 Task，造成长尾效应。

**场景三：过滤效果超出预期**

```sql
SELECT * FROM large_table a
JOIN small_table b ON a.id = b.id
WHERE a.category = 'rare_type'
```

CBO 估算 `rare_type` 过滤后有 100 万行，决定用 SortMergeJoin。但实际上 `rare_type` 在数据中极为稀少，真实过滤后只有 1000 行——此时 `small_table`（50MB）应该 Broadcast，用 BroadcastHashJoin 比 SortMergeJoin 快 100 倍。

这三类问题是生产中 Spark SQL 性能不稳定的最常见根源，它们有一个共同特点：**在运行时才能观察到真实情况，在执行前无从得知**。AQE 就是为此而生的。

### 1.2 AQE 的核心思路：以 Shuffle 为边界，分阶段动态决策

AQE 的设计思路极其优雅：**Shuffle 是天然的物化点**。

在 Spark 的执行模型中，Shuffle 将查询切分为若干 Stage——Map Stage 将数据写入 Shuffle 文件，Reduce Stage 读取 Shuffle 文件继续处理。Shuffle 文件是一个完整的中间结果快照：它精确记录了每个 Reduce 分区的数据量（字节数和行数）。

AQE 利用这一点：**当一个 Shuffle Stage（MapStage）完成后，Shuffle 文件中已经包含了下一个 Stage 的输入精确统计——每个分区有多少字节，分布是否均匀**。在下一个 Stage 开始执行之前，AQE 读取这些统计数据，动态调整后续计划。

---

## 第 2 章 QueryStage：AQE 的运行时框架

### 2.1 QueryStage 是什么

**QueryStage（查询阶段）** 是 AQE 的核心抽象，代表一个可以独立物化的执行单元。QueryStage 以 `ShuffleExchangeExec` 或 `BroadcastExchangeExec` 为边界：

- 每个 `ShuffleExchangeExec` 节点对应一个 **ShuffleQueryStage**
- 每个 `BroadcastExchangeExec` 节点对应一个 **BroadcastQueryStage**
- 整个查询的最终输出对应一个 **ResultQueryStage**

QueryStage 与 DAGScheduler 中 Stage 的概念高度相关，但不完全相同：QueryStage 是 AQE 层面的逻辑抽象，一个 QueryStage 可能对应多个 Spark Stages（如一个 ShuffleQueryStage 包含其上游的所有计算，可能跨越多个没有 Shuffle 的 Task 执行链）。

### 2.2 QueryStage 的执行流程

```mermaid
%%{init: {"theme": "dracula", "themeVariables": {"primaryColor": "#6272a4", "primaryTextColor": "#f8f8f2", "primaryBorderColor": "#bd93f9", "lineColor": "#ff79c6", "secondaryColor": "#44475a", "tertiaryColor": "#282a36"}}}%%
sequenceDiagram
    participant AQE as "AdaptiveSparkPlan</br>(AQE 调度器)"
    participant QS as "QueryStage</br>(单个 Stage)"
    participant EXEC as "Spark 执行引擎</br>(DAGScheduler)"
    participant OPT as "运行时优化器</br>(Re-optimize)"

    AQE ->> QS: "提交 QueryStage 执行"
    QS ->> EXEC: "提交 MapStage Task 集合"
    EXEC ->> EXEC: "执行 Map Tasks</br>写 Shuffle 文件"
    EXEC ->> QS: "Stage 完成，统计信息就绪"
    QS ->> AQE: "MapOutputStatistics</br>{partitionSizes, rowCounts}"

    AQE ->> OPT: "传入真实统计</br>触发重新优化"
    OPT ->> OPT: "动态分区合并？</br>切换 Join 策略？</br>Skew 分拆？"
    OPT ->> AQE: "返回优化后的后续计划"
    AQE ->> QS: "按新计划提交下一个 QueryStage"
```

**关键时间点**：当一个 ShuffleQueryStage 的所有 Map Task 完成后，Spark 在提交下一个 ReduceStage 的 Task 之前，触发 AQE 的重新优化逻辑。这个"插入优化"的时机正是 AQE 能够使用真实统计的原因——Map 已经完成，Shuffle 文件已经写好，分区大小精确可知。

### 2.3 AdaptiveSparkPlan：AQE 的执行入口

当 `spark.sql.adaptive.enabled=true`（Spark 3.2+ 默认开启），整棵物理计划树被包裹在一个 `AdaptiveSparkPlan` 节点中：

```scala
class AdaptiveSparkPlan(initialPlan: SparkPlan) extends LeafExecNode {
  // 当前正在执行的"活跃计划"（可能已被 AQE 动态替换）
  @volatile private var currentPhysicalPlan: SparkPlan = initialPlan
  
  // 执行逻辑：递归提交 QueryStage，在 Stage 边界插入优化
  override def executeCollect(): Array[InternalRow] = {
    val (plan, adaptedPlan) = executeAndAdapt()
    currentPhysicalPlan = adaptedPlan  // 更新为 AQE 优化后的最终计划
    plan.executeCollect()
  }
}
```

---

## 第 3 章 动态分区合并（Coalesce Shuffle Partitions）

### 3.1 问题：静态分区数的"一刀切"困境

`spark.sql.shuffle.partitions=200` 是使用频率最高的 Spark SQL 参数，也是最常被错误配置的参数。问题的根源在于：**这个参数对整个应用中所有 Shuffle 操作生效**，而一个应用中不同 Shuffle 阶段的数据量差异可能是数千倍。

```sql
-- Stage 1 Shuffle：10TB 数据，需要 2000 个分区（每分区 5GB）
SELECT category, COUNT(*) FROM events GROUP BY category

-- Stage 2 Shuffle：Stage 1 的输出只有 100 类别，100 行数据
-- 还是 200 个分区？每个分区平均 0.5 行！
SELECT category, count FROM stage1 WHERE count > 1000 ORDER BY count DESC
```

200 个分区对 Stage 1 可能还合理，对 Stage 2 则产生 199 个空分区和 1 个有数据的分区。200 个 Task 被调度，199 个几乎立即完成（空分区），只有 1 个在真正做事——调度开销完全浪费。

### 3.2 AQE 的动态合并机制

当 `spark.sql.adaptive.coalescePartitions.enabled=true`（默认 true），AQE 在 ShuffleQueryStage 完成后，读取每个分区的字节数，用贪心算法将相邻的小分区合并：

**合并算法**（贪心）：
```
目标分区大小 = spark.sql.adaptive.advisoryPartitionSizeInBytes（默认 64MB）
最大合并比例 = spark.sql.adaptive.coalescePartitions.minPartitionNum（保证最小分区数）

从左到右扫描所有分区：
  累积当前分区组的总字节数
  如果累积大小 < 目标大小：将当前分区加入组
  如果累积大小 >= 目标大小：输出当前组（一个合并分区），开始新组
```

**效果示例**：

原始 200 个分区（Stage 2 完成后）：
```
分区 0: 512KB    分区 1: 0B(空)  分区 2: 48KB  ... 分区 199: 1KB
总计 ~1MB，目标分区大小 64MB
```

合并后：AQE 将所有非空分区合并为 1 个分区（因为总共只有 ~1MB < 64MB），199 个空分区直接丢弃。

下一个 Stage（ReduceStage）只需要启动 **1 个 Task**，而不是 200 个。调度开销从 200 个 Task 降到 1 个 Task。

### 3.3 合并的参数调优

```properties
# 开启动态合并（默认 true）
spark.sql.adaptive.coalescePartitions.enabled=true

# 目标分区大小（合并后每个分区尽量达到此大小）
spark.sql.adaptive.advisoryPartitionSizeInBytes=64MB

# 合并后的最小分区数（防止过度合并导致并行度太低）
spark.sql.adaptive.coalescePartitions.minPartitionNum=1

# 初始 Shuffle 分区数（AQE 会从这个数开始合并，而不是 shuffle.partitions）
spark.sql.adaptive.coalescePartitions.initialPartitionNum=200
```

> [!note] 设计哲学
> 开启 AQE 后，`spark.sql.shuffle.partitions` 的角色发生了变化：它不再是"最终分区数"，而是"初始分区数上限"。AQE 会将实际分区数从这个初始值向下动态合并到合理范围。因此，开启 AQE 后建议将 `spark.sql.shuffle.partitions` 调大（如 2000），让 AQE 的合并有更大的下调空间，从而在不同数据量的 Stage 之间都能找到合理的并行度。

---

## 第 4 章 动态 Join 策略切换

### 4.1 问题：静态规划时的"错误预判"

第 04 篇讲到，CBO 统计信息过时或不准确时，Physical Planner 可能做出错误的 Join 策略选择：
- 一张实际只有 1MB 的表，被 CBO 估算为 200MB，导致没有 Broadcast，用了 SortMergeJoin
- 一张经过高选择率过滤后实际只有几千行的数据，被估算为百万行，导致没有切换到 ShuffledHashJoin

### 4.2 AQE 的动态切换机制

当一个 ShuffleQueryStage（构建 Join 输入）完成后，AQE 读取该 Stage 真实的输出大小，判断是否触发 Join 策略切换：

**条件一：切换为 BroadcastHashJoin**

```
如果 ShuffleQueryStage 的实际输出 ≤ autoBroadcastJoinThreshold（默认 10MB）：
  将后续的 SortMergeJoin 改为 BroadcastHashJoin
  改变执行计划：取消对应侧的 ShuffleExchange，改为 BroadcastExchange
```

这是 AQE 最常见的动态优化之一。典型场景：

```sql
SELECT a.*, b.name
FROM fact_table a
JOIN dim_table b ON a.category = b.id
WHERE a.date = '2024-01-15' AND a.region = 'CN-WEST'
```

- **静态规划时**：`dim_table` 是 50MB，低于 Broadcast 阈值，会被 Broadcast
- **但如果**：`fact_table` 经过 `date + region` 双重过滤后只有 5MB，此时 `dim_table` 的 50MB 比 `fact_table` 的 5MB 还大，但 `fact_table` 这一侧才更适合 Broadcast

AQE 在 `fact_table` 这一侧的 ShuffleStage 完成后，发现实际只有 5MB，立即将其改为 BroadcastHashJoin（Broadcast fact_table 这侧），完全跳过了 SortMergeJoin 的 Shuffle 开销。

**条件二：切换为 ShuffledHashJoin**

```
如果 ShuffleQueryStage 的一侧实际输出 ≤ 能放入内存的阈值（基于分区内存估算）：
  且 spark.sql.adaptive.preferSortMergeJoin=false：
  将 SortMergeJoin 改为 ShuffledHashJoin（省去排序开销）
```

### 4.3 在 Spark UI 中观察 Join 策略切换

开启 AQE 后，Spark UI 的 SQL 标签页会展示 AQE 修改前后的两个执行计划：
- **Initial Plan**：静态规划时的原始计划（基于估算）
- **Final Plan**：AQE 动态修改后的最终计划（基于真实统计）

当 AQE 触发了 Join 策略切换，Final Plan 中会出现 `BroadcastHashJoinExec`，而 Initial Plan 中是 `SortMergeJoinExec`。在各 QueryStage 节点旁边还会标注真实的输出行数和字节数，方便确认 AQE 决策的依据。

---

## 第 5 章 Skew Join 自动优化（最重要的能力）

### 5.1 数据倾斜：分布式计算的头号性能杀手

**数据倾斜（Data Skew）** 是指：在 Shuffle 完成后，某些分区的数据量远大于其他分区的平均水平。在 Join 或 Aggregation 中，这直接导致处理倾斜分区的 Task 成为整个 Stage 的瓶颈（长尾 Task）——其他 Task 早已完成，整个 Stage 在等这一个（或几个）慢 Task。

**倾斜的来源**：
- **Key 本身分布不均**：某些业务 key（如超级用户 id、热门商品 id、"unknown" 兜底值）在数据中出现频率远高于其他 key
- **Join 的一侧包含 NULL**：NULL 被 Hash 到同一个分区，导致该分区异常大
- **数据生成逻辑不均**：如日志数据按时间分区，某些时间段的事件数量是其他时间段的 10 倍

### 5.2 AQE Skew Join 的工作原理

当 `spark.sql.adaptive.skewJoin.enabled=true`（默认 true），AQE 在 Shuffle Stage 完成后，检测每个分区的大小，识别倾斜分区：

**倾斜判定条件**（同时满足）：
```
分区大小 > spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes（默认 256MB）
AND
分区大小 > median(所有分区大小) × spark.sql.adaptive.skewJoin.skewedPartitionFactor（默认 5）
```

即：分区大小既要超过绝对阈值（256MB），又要超过中位数的 5 倍，才被认定为倾斜分区。

**处理方式：分拆倾斜分区**

对于被识别为倾斜的分区（假设是分区 `P`）：

1. 将倾斜分区 `P` 的数据**拆分**为 `N` 个子分区（`P_0`, `P_1`, ..., `P_{N-1}`），每个子分区读取原始文件的一段范围（Spark 通过 `PartialMapOutputStatistics` 实现文件范围读取）
2. 对另一侧（非倾斜侧），将分区 `P` **复制** `N` 份（`P_copy_0`, `P_copy_1`, ..., `P_copy_{N-1}`）——因为另一侧的 `P` 需要与倾斜侧的所有 `N` 个子分区分别 Join
3. 将 `N` 对 `(P_i, P_copy_i)` 并行执行 Join，结果合并

```
倾斜前（Join 分区 P）：
  左侧分区 P：10GB（倾斜！）
  右侧分区 P：500MB
  → 单个 Task 处理 10.5GB，耗时 30 分钟

AQE Skew Join 处理后（N=4，拆分为 4 个子分区）：
  左侧 P_0: 2.5GB  ← 右侧 P_copy_0: 500MB
  左侧 P_1: 2.5GB  ← 右侧 P_copy_1: 500MB（右侧复制了 4 份）
  左侧 P_2: 2.5GB  ← 右侧 P_copy_2: 500MB
  左侧 P_3: 2.5GB  ← 右侧 P_copy_3: 500MB
  → 4 个 Task 并行处理，每个 3GB，耗时约 8 分钟（理想情况）
```

**右侧复制的代价**：右侧分区 `P` 的 500MB 数据被读取了 4 次，有额外的 I/O 和 CPU 开销。但这个代价远小于等待一个 30 分钟的倾斜 Task——以 2GB 额外读取换取 22 分钟的等待，是合算的。

### 5.3 Skew Join 的参数调优

```properties
# 开启 Skew Join（默认 true）
spark.sql.adaptive.skewJoin.enabled=true

# 倾斜分区大小绝对阈值（超过此值才考虑是倾斜）
spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes=256MB

# 倾斜因子（分区大小超过中位数的倍数）
spark.sql.adaptive.skewJoin.skewedPartitionFactor=5

# 目标分拆后每个子分区的大小（影响拆分成几个子分区）
spark.sql.adaptive.advisoryPartitionSizeInBytes=64MB
# 拆分数 N ≈ ceil(倾斜分区大小 / advisoryPartitionSizeInBytes)
# 如：10GB / 64MB ≈ 160 个子分区
```

### 5.4 Skew Join 的边界与局限

**边界一：只适用于 SortMergeJoin**

AQE Skew Join 只能优化 SortMergeJoin（因为 SortMergeJoin 按分区处理，可以对分区做分拆）。BroadcastHashJoin 由于不做 Shuffle，没有"分区"的概念，无法被 Skew Join 优化。

如果倾斜发生在 BroadcastHashJoin 的 Probe 端，需要手动 Salting 或其他方式处理（第 10 篇详解）。

**边界二：Skew 在 Join 之后的 Aggregation 阶段**

如果倾斜发生在 JOIN 之后的 GROUP BY 阶段，AQE Skew Join 无法处理——它只检测 Join 输入侧的 Shuffle 分区倾斜。

**边界三：极端倾斜（某一个 key 占据绝大多数数据）**

如果倾斜是单一 key 导致的（如 `userId = 'robot_001'` 有 50 亿行），分拆后的子分区大小仍然 >> 目标分区大小（50 亿行 / 160 子分区 = 3 千万行 / 子分区，仍然是其他正常分区的 100 倍）。AQE Skew Join 在极端单一 key 倾斜场景下效果有限，必须配合数据清洗或 Salting。

---

## 第 6 章 AQE 的整体配置与生产建议

### 6.1 开启 AQE 的完整配置

```properties
# 开启 AQE（Spark 3.2+ 默认 true）
spark.sql.adaptive.enabled=true

# 动态分区合并
spark.sql.adaptive.coalescePartitions.enabled=true
spark.sql.adaptive.advisoryPartitionSizeInBytes=64MB
spark.sql.adaptive.coalescePartitions.minPartitionNum=1

# 动态 Join 策略（依赖 autoBroadcastJoinThreshold）
spark.sql.autoBroadcastJoinThreshold=10MB

# Skew Join
spark.sql.adaptive.skewJoin.enabled=true
spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes=256MB
spark.sql.adaptive.skewJoin.skewedPartitionFactor=5

# 初始 Shuffle 分区数（建议设大，由 AQE 动态合并）
spark.sql.shuffle.partitions=500
```

### 6.2 AQE 引入的额外开销

AQE 不是"免费的午餐"，它有以下额外开销：

**开销一：Stage 间的等待延迟**

AQE 必须等待一个 ShuffleQueryStage **完全完成**后，才能做重新优化并提交下一个 Stage。这意味着 Stage 间的流水线被打断——在没有 AQE 的情况下，Reduce Stage 的 Task 可以在 Map Task 陆续完成时就开始（流水线式），但 AQE 必须等全部 Map Task 完成后才开始 Reduce Stage。

**影响**：对于 Map Stage 的末尾几个慢 Task（长尾），Reduce Stage 必须等待它们。对于没有数据倾斜的快速查询，AQE 的等待开销可能反而让作业略慢（几秒到几十秒）。

**开销二：QueryStage 物化的元数据处理**

每个 ShuffleQueryStage 完成后，AQE 需要读取所有分区的统计信息（`MapOutputStatistics`），做合并/倾斜分析，生成新的执行计划。对于分区数极多的场景（如 5000 个分区），这个处理过程在 Driver 端有一定 CPU 开销。

**是否应该开启 AQE**：对于绝大多数生产查询（Spark 3.2+），**应该默认开启 AQE**。AQE 的收益（消除分区数不匹配、动态切换 Join 策略、Skew Join 自动处理）在多数情况下远大于额外开销。只有在以下情形考虑关闭：
- 极短的微批次查询（处理时间 < 10 秒），AQE 等待开销占比过大
- 大量 Stage 的复杂查询，AQE 的 Driver 端计划重新生成开销明显

### 6.3 AQE 与 CBO 的互补关系

AQE 并不替代 CBO，两者解决不同层面的问题：

| 维度 | CBO | AQE |
|------|-----|-----|
| **决策时机** | 执行前（静态） | 执行中（运行时） |
| **信息来源** | 统计信息（可能过时） | Shuffle 文件真实统计（精确） |
| **优化范围** | Join 顺序、策略选择 | 分区数、Join 策略修正、Skew 处理 |
| **适用场景** | 统计信息准确时非常有效 | 统计信息不准确或数据倾斜时互补 |

最佳实践是**同时开启 CBO 和 AQE**：CBO 在静态阶段做尽量好的决策，AQE 在运行时对 CBO 的错误决策进行修正。

---

## 第 7 章 通过 AQE 可视化诊断性能问题

### 7.1 Spark UI 中的 AQE 信息

开启 AQE 后，Spark UI → SQL 标签页的执行计划可视化增加了以下 AQE 特有信息：

- **AQE Stage 边界**：执行计划图中，每个 QueryStage 用不同颜色标注，清晰显示 AQE 的分阶段边界
- **真实统计**：每个已完成的 QueryStage 节点旁显示真实的输出行数（rows）和字节数（bytes）
- **Initial Plan vs Final Plan**：两个按钮切换展示原始静态计划和 AQE 优化后的最终计划，可以直接看到 AQE 做了哪些修改

### 7.2 识别 AQE 触发了哪类优化

**动态分区合并触发**：Final Plan 中某个 ShuffleExchange 的分区数 < Initial Plan 中的分区数（如从 200 降到 3），说明 AQE 做了合并。

**动态 Join 切换触发**：Initial Plan 中是 `SortMergeJoin`，Final Plan 中是 `BroadcastHashJoin`，说明 AQE 在运行时发现一侧数据量小，切换了策略。

**Skew Join 触发**：Final Plan 中某个 Join 的 Stage 被拆分为多个子 Stage（执行计划图中出现类似"分叉"结构），说明 AQE 检测到倾斜并做了分拆处理。

**日志确认**：
```
INFO AdaptiveSparkPlan: Final plan changed.
INFO AdaptiveSparkPlan: Coalesced X shuffle partitions to Y
INFO AdaptiveSparkPlan: Changed Sort Merge Join to Broadcast Hash Join
WARN AdaptiveSparkPlan: Detected skew partition: partition X of size Y bytes, median Z bytes.
```

---

## 小结

AQE 是 Spark 3.0 最重要的性能特性，彻底改变了静态优化的范式：

- **核心机制**：以 Shuffle Exchange 为边界划分 QueryStage，每个 Stage 完成后读取真实统计，在下一个 Stage 启动前动态重新规划
- **动态分区合并**：消除静态分区数"一刀切"问题，自动将小分区合并到目标大小（默认 64MB），减少空 Task 调度开销
- **动态 Join 切换**：基于真实 Stage 输出大小，将 SortMergeJoin 动态降级为 BroadcastHashJoin（当一侧实际很小），弥补 CBO 统计信息不准确的问题
- **Skew Join 自动优化**：检测并分拆倾斜分区（>256MB 且>中位数 5 倍），将倾斜的单个巨型 Task 并行化处理，消除长尾效应
- **代价**：Stage 间等待延迟增加（需等 MapStage 全部完成），Driver 端有额外的计划重生成开销

第 07 篇将深入 Spark SQL 的执行引擎底层：**Whole-Stage CodeGen** 如何通过动态生成 JVM 字节码，将多个算子融合为一段紧密执行的代码，消灭 Volcano 迭代器模型中每行数据的虚方法调用开销，实现接近手写循环的执行效率。

---

> [!note] 思考题
> 1. AQE 以 Shuffle 边界为 QueryStage 的分割点，每个 Stage 完成后才能做动态决策。这意味着 AQE 对没有 Shuffle 的 Pipeline（如全部是窄依赖的计算）完全无法介入。在什么类型的 SQL 查询中，AQE 几乎没有优化空间？
> 2. AQE 的 Skew Join 优化通过将倾斜分区切分成多个小分区来并行处理。但切分后，非倾斜侧的对应分区必须被"复制"到多个 Task 中。如果倾斜侧有 5 个分区都是热点，而每个热点被切成 10 份，非倾斜侧的数据会被读取多少次？这对 I/O 意味着什么？
> 3. AQE 在每个 QueryStage 完成后会重新优化后续计划，这引入了额外的规划开销。在生产中，有没有场景会因为 AQE 的动态重优化而导致总体执行时间反而比关闭 AQE 更长？

## 参考资料

- [Spark 3.0 - AQE 浅析（Adaptive Query Execution）（CSDN）](https://blog.csdn.net/zyzzxycj/article/details/106469572)
- [Apache Spark 自适应查询优化深度实践及改进（nowjava.com）](https://nowjava.com/article/44188)
- [Spark_调优_Spark3.0之SparkSQL AQE（CSDN）](https://blog.csdn.net/u010003835/article/details/111407775)
- Spark 官方文档：Adaptive Query Execution（spark.apache.org）
- Apache Spark 源码：`org.apache.spark.sql.execution.adaptive.AdaptiveSparkPlanExec`
- Apache Spark 源码：`org.apache.spark.sql.execution.adaptive.CoalesceShufflePartitions`
- Apache Spark 源码：`org.apache.spark.sql.execution.adaptive.OptimizeSkewedJoin`
