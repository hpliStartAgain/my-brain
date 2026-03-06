---
title: "Spark SQL 调优实战：从慢查询到根因的诊断方法论"
date: 2026-02-28
tags: [Spark, SparkSQL, 调优, 性能诊断, 慢查询, SparkUI, EXPLAIN, Join调优, OOM, 调优方法论]
aliases: []
---

# 11 Spark SQL 调优实战：从慢查询到根因的诊断方法论

## 摘要

前 10 篇系统讲解了 Spark SQL 从 SQL 解析到执行、从静态优化到运行时自适应、从 CPU 效率到 I/O 效率的完整技术链条。本篇是方法论的综合应用篇：一条 Spark SQL 作业跑得慢，正确的调优姿势不是凭经验"猜"——是内存不够？是 Shuffle 太多？是倾斜？——而是建立在**系统性诊断**的基础上，通过 Spark UI、执行计划分析、运行时指标，**精确定位瓶颈所在**，然后针对性地施加正确的优化手段。本文给出一套可落地的慢查询诊断框架：**五步诊断法**（确定瓶颈阶段 → 定位慢 Stage → 分析 Task 指标 → 解读执行计划 → 验证优化效果），并针对生产中最高频的六类慢查询场景（Shuffle 过重、Join 策略误选、数据倾斜、I/O 效率低、内存不足/OOM、Stage 并行度不合理）给出完整的根因分析与调优方案。文末提供一份"调优前的必看 Checklist"，覆盖从集群配置到 SQL 写法的全面核查项。

---

## 第 1 章 调优的第一性原理：先诊断，后治疗

### 1.1 调优的三个境界

**第一境界：经验调参**——凭直觉调整配置。"跑得慢？调大内存。OOM？加 executor。倾斜？加盐。"这种方式偶尔有效，但无法系统解决问题，浪费大量时间试错。

**第二境界：指标驱动**——通过 Spark UI 和执行计划定位瓶颈，针对性调优。这是工程师应该达到的标准水平。

**第三境界：架构感知**——在设计阶段就考虑数据组织（分区、分桶、文件格式）、查询模式（星型模型、宽表、聚合链），从根源避免性能问题出现。

本篇主要帮助读者从第一境界进阶到第二境界，并在关键决策点植入第三境界的思维。

### 1.2 调优的根本原则

Spark SQL 作业的时间由以下几部分构成：

```
总时间 = I/O 时间（读写磁盘/网络）
       + Shuffle 时间（序列化 + 磁盘写 + 网络传输 + 反序列化）
       + 计算时间（CPU 处理数据）
       + 调度开销（Task 创建/提交/汇报）
       + 等待时间（倾斜导致的长尾等待）
```

有效的调优必须针对当前瓶颈，而不是优化非瓶颈：
- 如果 Shuffle 时间占 80%，优化 CPU 效率（CodeGen）收益接近零
- 如果 I/O 时间占 70%，优化 Join 策略收益有限
- 如果是倾斜导致长尾（1 个 Task 慢，其他 Task 早完成），优化任何其他维度都无助于整体时间

**调优前必须量化各部分时间占比**，这是 Spark UI 的用武之地。

---

## 第 2 章 五步诊断法

### 2.1 第一步：确定整体瓶颈阶段

**入口**：Spark UI → Jobs 标签页

查看 Job 时间线，找到耗时最长的 Job（通常一个 SQL 对应一个或多个 Job）。如果有多个 Job，分别观察各 Job 的 Stages，确认哪个 Job 是主要瓶颈。

**关键信息**：
- **Duration**：各 Job 的总耗时
- **Stages**：各 Stage 的数量和完成状态
- **Skipped Stages**（绿色）：被 Stage 复用机制跳过的 Stage（通常是缓存命中或 Exchange 复用），越多越好

如果多数时间在等待（Job 进度条长时间不动），检查：
- Driver 端是否在做大量计算（如 `df.collect()` 拉回大量数据）
- 是否有 Stage 的 Task 数为 1 但数据量极大（串行瓶颈）

### 2.2 第二步：定位慢 Stage

**入口**：Spark UI → Stages 标签页

重点关注：
- **Stage 时间比例**：Shuffle Write/Read 时间 vs. 计算时间
- **Shuffle Read/Write Size**：Shuffle 数据量异常大说明可能有冗余 Join、不必要的宽依赖
- **Failed Task 数量**：有 Task 失败重试说明有内存或磁盘问题

**典型问题信号**：

| 指标异常 | 可能根因 |
|---------|---------|
| Shuffle Read Size 是 Shuffle Write Size 的 10 倍以上 | Join 产生了大量新数据（笛卡尔积？） |
| 单个 Stage 耗时 >> 其他所有 Stage 之和 | 该 Stage 是核心瓶颈，重点分析 |
| GC Time 占 Duration 的 30%+ | 内存不足，数据对象创建太多，考虑调大堆内存或使用堆外内存 |
| Spill (Memory) + Spill (Disk) 很大 | 内存不足导致数据 Spill 到磁盘，性能急剧下降 |

### 2.3 第三步：分析 Task 指标

**入口**：点击进入慢 Stage 的详情页，查看 Task 指标分布

**关键指标**：

```
Task 时间分布（理想情况）：大部分 Task 时间接近，无明显长尾
Task 时间分布（倾斜情况）：大部分 Task 2秒完成，1-2个 Task 30分钟

Shuffle Read Size 分布：
  - 均匀分布 = 无倾斜
  - 极少数 Task 读取远大于中位数 = 倾斜
  
Executor Summary（底部）：
  - 各 Executor 的总 Task 数、失败次数、Duration
  - 某个 Executor 失败率高 = 该 Executor 节点可能有资源问题
```

**Summary Metrics 中的百分位数**：

Spark UI 会展示 Task 指标的 25th、50th（中位数）、75th、Max 百分位数。判断倾斜的关键：

```
若 Max >> 75th percentile（如 Max=30min，75th=3s）→ 严重倾斜（少数 Task 极慢）
若 Max ≈ 75th percentile（如 Max=35s，75th=30s）→ 均匀分布，无倾斜
```

### 2.4 第四步：解读执行计划

**入口**：Spark UI → SQL 标签页（详情页有可视化执行计划）或命令行 `EXPLAIN`

**执行计划的阅读重点**：

```sql
-- 获取执行计划（三种详细级别）
EXPLAIN sql_query;                -- 简要物理计划
EXPLAIN EXTENDED sql_query;       -- 逻辑+物理计划
EXPLAIN FORMATTED sql_query;      -- 格式化物理计划（含统计信息）
EXPLAIN COST sql_query;           -- 含代价估算的逻辑计划
```

**阅读物理计划的关键节点**：

```
*(2) HashAggregate [userId] sum(amount)   ← *(N) 表示在 Whole-Stage CodeGen 区域
+- Exchange hashpartitioning(userId, 200) ← Shuffle（关注分区数和数据量）
   +- *(1) HashAggregate [userId] partial_sum
      +- *(1) Filter (amount > 100)       ← Filter 在 Scan 之上（谓词下推成功）
         +- *(1) FileScan parquet [...]
            PushedFilters: [GreaterThan(amount,100.0)]  ← 谓词已推送到 Parquet 读取
            PartitionFilters: [isnotnull(dt), (dt = 2024-01-15)]  ← 分区裁剪生效
```

**执行计划中的危险信号**：

| 执行计划中出现 | 含义 | 应对 |
|-------------|------|------|
| `CartesianProduct` | 笛卡尔积（通常是 SQL 写错） | 检查 JOIN 条件是否缺失 |
| `BroadcastNestedLoopJoin` | 非等值 Join，可能极慢 | 尝试改写为等值 Join |
| `SortMergeJoin` 但一侧很小 | CBO 没有选 Broadcast，加 Hint | 加 `BROADCAST` Hint 或调大阈值 |
| `Exchange` 节点分区数很大（如 2000）| Shuffle 并行度过高，有大量空 Task | 开启 AQE 或手动调低 shuffle.partitions |
| 没有 `*` 前缀 | CodeGen 不生效 | 检查是否有阻断 CodeGen 的算子（Python UDF？） |
| `PushedFilters: []` | 谓词未下推到文件读取 | 检查 Filter 条件是否是函数表达式 |
| `PartitionFilters: []` | 分区裁剪未生效 | 检查查询条件是否覆盖分区键 |

### 2.5 第五步：验证优化效果

每次做一个调优变更，然后重新运行查询，对比关键指标（总时间、最慢 Task 时间、Shuffle 数据量）。只做单一变量修改，否则无法判断是哪个优化起了作用。

---

## 第 3 章 六类典型慢查询场景与调优方案

### 3.1 场景一：Shuffle 数据量过大

**症状**：
- Spark UI 中 Shuffle Write + Read 数据量合计达到 TB 级
- 整体时间大部分花在 Exchange 阶段
- 磁盘 I/O 监控显示 Shuffle 期间磁盘写入量极大

**根因分析**：

**根因一：Join 产生了笛卡尔积或 Key 数量爆炸**

```sql
-- 问题 SQL：没有 Join 条件（笛卡尔积）
SELECT a.*, b.*
FROM table_a a, table_b b;  -- 忘写 WHERE/JOIN ON 条件！

-- 修复：补充正确的 Join 条件
SELECT a.*, b.*
FROM table_a a
JOIN table_b b ON a.id = b.id;
```

**根因二：中间结果没有及时过滤，大数据经过多轮 Shuffle**

```sql
-- 低效写法：先 JOIN 所有数据，最后才 FILTER
SELECT *
FROM (
    SELECT a.*, b.name
    FROM large_table a  -- 10 亿行
    JOIN medium_table b ON a.id = b.id  -- 1000 万行
    -- Shuffle 了 10 亿行！
) t
WHERE t.category = 'food';  -- 过滤在 Join 之后

-- 高效写法：先下推过滤，减少 Join 数据量
SELECT a.*, b.name
FROM (SELECT * FROM large_table WHERE category = 'food') a  -- 过滤后可能只剩 1000 万行
JOIN medium_table b ON a.id = b.id;
-- 只 Shuffle 1000 万行！
```

RBO 的谓词下推应该自动完成这个优化，但对于复杂子查询或某些视图，谓词下推可能失效。检查执行计划中 `Filter` 是否在 `Join` 之上（生效）还是之下（未生效）。

**根因三：Shuffle 分区数过多，大量小 Shuffle 文件**

```
spark.sql.shuffle.partitions=2000（过大），数据只有 100MB
→ 2000 个分区，每个 50KB
→ Map 端每个 Task 产生 2000 个小文件（Map × partitions 个文件总数极大）
→ HDFS 元数据压力 + 小文件合并开销
```

**解决**：开启 AQE 动态合并（`spark.sql.adaptive.coalescePartitions.enabled=true`），或手动设置合理的 `shuffle.partitions`。

### 3.2 场景二：Join 策略误选

**症状**：
- 执行计划显示 `SortMergeJoin`，但直觉上一侧应该可以 Broadcast
- 或执行计划显示 `BroadcastHashJoin`，但内存报 OOM（表被错误地当作小表 Broadcast）

**诊断**：

```sql
-- 查看当前 Broadcast 阈值
SET spark.sql.autoBroadcastJoinThreshold;

-- 查看两侧的统计估算
EXPLAIN COST
SELECT * FROM a JOIN b ON a.id = b.id;
-- 在输出中找 Statistics(sizeInBytes=...)
-- 如果 sizeInBytes 是 "Unknown" 或异常大/小，说明统计信息不准
```

**案例一：应该 Broadcast 但没有 Broadcast**

```
原因：CBO 统计信息过时，b 表实际 5MB 但 Catalog 记录为 500MB
解决：
  1. 更新统计信息：ANALYZE TABLE b COMPUTE STATISTICS;
  2. 或加 Hint：SELECT /*+ BROADCAST(b) */ * FROM a JOIN b ON a.id = b.id;
  3. 或临时调大阈值：SET spark.sql.autoBroadcastJoinThreshold=100MB;
```

**案例二：不应该 Broadcast 但被 Broadcast（OOM）**

```
原因：统计信息显示 b 很小，但实际很大（数据增长了 100 倍）
症状：Driver OOM（收集大表到 Driver）或 Executor OOM（内存不足存 HashMap）
解决：
  1. 更新统计信息
  2. 加 NO_BROADCAST Hint：SELECT /*+ NO_BROADCAST_HASH(b) */ ...
  3. 降低 autoBroadcastJoinThreshold（如降到 10MB）防止误 Broadcast
```

### 3.3 场景三：数据倾斜（长尾 Task）

**症状**：
- 某个 Stage 的 Max Task Time >> 75th percentile Task Time
- 少数 Task 的 Shuffle Read Size 是其他 Task 的几百倍
- Stage 进度条长时间停在 99%（99 个 Task 完成，1 个在跑）

**诊断与调优**（完整策略见第 10 篇）：

```sql
-- 第一步：确认倾斜 Key
SELECT join_key, COUNT(*) cnt
FROM skewed_table
GROUP BY join_key
ORDER BY cnt DESC LIMIT 20;

-- 第二步：检查 AQE Skew Join 是否生效
-- UI 中 Final Plan 是否出现 Skew Join 的分拆结构

-- 第三步：如果 AQE 未处理，根据倾斜类型选择方案：
-- 维表可 Broadcast → 加 BROADCAST Hint
-- 已知热点 Key → 局部 Salting
-- NULL 集中 → 过滤或打散 NULL
-- GROUP BY 倾斜 → 两阶段聚合
```

### 3.4 场景四：I/O 效率低

**症状**：
- 作业读取的数据量远大于查询实际需要的数据
- `FileScan` 节点的 `Rows Output` 远小于 `Rows Read`（大量数据被读出后过滤掉）
- 没有分区裁剪（`PartitionFilters` 为空）

**诊断**：

```sql
-- 查看执行计划中的分区裁剪情况
EXPLAIN FORMATTED
SELECT * FROM events WHERE dt = '2024-01-15' AND region = 'CN';

-- 期望看到：
-- PartitionFilters: [isnotnull(dt#1), (dt#1 = 2024-01-15), (region#2 = CN)]
-- 如果 PartitionFilters 为空，说明分区裁剪没有生效
```

**分区裁剪不生效的常见原因**：

**原因一：分区列上有函数调用**

```sql
-- 分区列是 dt（DATE 类型），查询时用了函数
WHERE YEAR(dt) = 2024 AND MONTH(dt) = 1
-- RBO 的谓词下推无法将 YEAR(dt) = 2024 转化为分区范围，裁剪失效

-- 修复：直接用范围条件
WHERE dt BETWEEN '2024-01-01' AND '2024-01-31'
```

**原因二：分区列类型不匹配**

```sql
-- 分区列是 STRING 类型，查询时用了 INT
WHERE dt = 20240115  -- 数字，而分区键是字符串 '2024-01-15'
-- 类型不匹配导致无法匹配分区

-- 修复：确保类型一致
WHERE dt = '2024-01-15'
```

**原因三：查询走了视图，视图内部阻断了谓词传递**

```sql
-- 视图定义
CREATE VIEW events_view AS SELECT *, 'processed' AS status FROM events;

-- 查询视图（dt 是 events 的分区键）
SELECT * FROM events_view WHERE dt = '2024-01-15';
-- 分区裁剪可能生效（取决于 Spark 版本，多数情况下视图谓词可以透传）

-- 但如果视图内有 UNION ALL、子查询等，谓词透传可能失败
```

### 3.5 场景五：OOM（内存不足）

**症状**：
- Executor 心跳超时（GC overhead 或内存耗尽）
- 错误日志：`java.lang.OutOfMemoryError: GC overhead limit exceeded` 或 `Container killed by YARN for exceeding memory limits`
- Spark UI 中有大量 Failed Task（失败后重试）

**OOM 的来源分层**：

**Driver OOM**：
- `df.collect()` / `df.toPandas()` 拉取大量数据到 Driver
- Broadcast 大表（Driver 先全量收集）
- 过多的 Accumulator 或 Broadcast 变量

**Executor OOM（堆内）**：
- 数据倾斜导致单分区数据量超过 Executor 内存
- 过多的缓存（`cache()` 了太多数据）
- 聚合/排序的中间状态无限增长（如 `collect_list` 累积大量元素）

**Executor OOM（堆外）**：
- 堆外内存配置不足（Shuffle 使用堆外 Buffer、ColumnVector 使用堆外）
- 第三方 JNI 库内存泄漏

**调优方向**：

```properties
# 增大 Executor 内存（最直接）
spark.executor.memory=8g

# 增大 Executor 堆外内存（针对堆外 OOM）
spark.executor.memoryOverhead=2g  # YARN Container = executor.memory + memoryOverhead

# 调整 Spark 内存分区比例
spark.memory.fraction=0.6       # Execution + Storage 共用堆内存的 60%
spark.memory.storageFraction=0.5  # 其中 50% 用于 Storage（缓存），另 50% 用于 Execution

# 减少单 Task 数据量（增大 Shuffle 分区数）
spark.sql.shuffle.partitions=500  # 让每个分区更小

# 对于聚合 OOM：开启外部排序聚合（Spill 到磁盘）
spark.sql.execution.sortBasedAggregationThreshold=128MB
```

### 3.6 场景六：Stage 并行度不合理

**症状 A：并行度过低（大分区，少 Task）**

- 执行计划中 Exchange 分区数很小（如 10），但数据量很大（TB 级）
- 少数 Task 每个处理几十 GB 数据，内存压力大，执行极慢

```properties
# 调大 shuffle.partitions（或依赖 AQE 动态调整）
spark.sql.shuffle.partitions=1000

# AQE 开启后也可以设置大值，让 AQE 动态合并到合适大小
spark.sql.shuffle.partitions=2000
spark.sql.adaptive.coalescePartitions.enabled=true
spark.sql.adaptive.advisoryPartitionSizeInBytes=128MB
```

**症状 B：并行度过高（小分区，大量 Task）**

- 文件 Scan 产生了 10 万个 Task（10 万个小文件）
- Task 调度时间（Driver 端 DAGScheduler + Heartbeat）比实际计算时间还长
- 整体呈现"快速提交，慢速完成"（调度瓶颈）

```python
# 解决方案一：合并小文件后再读（根本解决）
spark.conf.set("spark.sql.files.maxPartitionBytes", "256MB")  # 限制单分区最大字节

# 解决方案二：读取后 coalesce 减少分区
df = spark.read.parquet(path).coalesce(200)

# 解决方案三：开启文件合并读取
# （Spark 会将多个小文件合并为一个 Split，减少 Task 数）
spark.conf.set("spark.sql.files.openCostInBytes", str(4 * 1024 * 1024))  # 4MB 合并代价
```

---

## 第 4 章 调优前的必看 Checklist

### 4.1 数据层面

- [ ] **文件格式**：内部存储是否使用 Parquet 或 ORC？（CSV/JSON 用于生产场景是严重性能问题）
- [ ] **分区设计**：是否按最常用的过滤列（日期、区域）分区？分区目录数是否合理（< 10 万）？
- [ ] **文件大小**：单个文件是否接近 128-512MB？是否有大量小文件（< 1MB）？
- [ ] **统计信息**：是否为常用的 Join 表和过滤列收集了统计信息（`ANALYZE TABLE`）？是否及时更新？
- [ ] **数据质量**：是否有大量 NULL 值在 Join Key 列？是否有已知的热点 Key？

### 4.2 配置层面

- [ ] **AQE**：`spark.sql.adaptive.enabled=true`（Spark 3.2+ 默认开启，务必确认）
- [ ] **CBO**：`spark.sql.cbo.enabled=true`，`spark.sql.cbo.joinReorder.enabled=true`
- [ ] **Broadcast 阈值**：`autoBroadcastJoinThreshold` 是否合理（建议 10-50MB，不要过大）
- [ ] **Shuffle 分区数**：开启 AQE 后建议设为 500-2000，让 AQE 动态合并
- [ ] **Executor 内存**：`executor.memory` + `executor.memoryOverhead` 是否足够？
- [ ] **向量化读取**：`parquet.enableVectorizedReader=true`，`orc.enableVectorizedReader=true`

### 4.3 SQL 写法层面

- [ ] **是否有不必要的 `SELECT *`**：宽表的 `SELECT *` 读取所有列，应明确指定需要的列
- [ ] **子查询优化**：嵌套子查询是否可以改写为 JOIN 或 CTE（`WITH` 子句）？
- [ ] **过滤条件的位置**：过滤条件是否尽量靠近数据源（在子查询/CTE 内部过滤）？
- [ ] **JOIN 顺序**：开启 CBO 后，检查 Join Reordering 是否生效（三张以上表的 Join）
- [ ] **COUNT DISTINCT**：是否可以改为 `approx_count_distinct`（允许约 5% 误差）？
- [ ] **窗口函数**：窗口函数是否有合适的 `PARTITION BY`？无 `PARTITION BY` 的窗口函数强制将所有数据汇集到一个分区（相当于 `coalesce(1)`）
- [ ] **DISTINCT 的位置**：`SELECT DISTINCT` 是否可以推到子查询中尽早去重（减少后续处理数据量）？

### 4.4 执行计划核查

- [ ] **Join 策略**：是否有不期望的 `SortMergeJoin`（应该 Broadcast 的表没有 Broadcast）？是否有 `CartesianProduct`（几乎总是错误）？
- [ ] **分区裁剪**：每个 FileScan 的 `PartitionFilters` 是否包含了期望的分区条件？
- [ ] **谓词下推**：FileScan 的 `PushedFilters` 是否包含了 WHERE 子句中的条件？
- [ ] **CodeGen**：扫描-过滤-聚合链是否在同一个 `*(N)` 区域内（连续的 CodeGen 执行）？
- [ ] **Exchange 数量**：是否有超出预期的 Shuffle Exchange 节点（可能有多余的重分区操作）？

---

## 第 5 章 一个完整的调优案例演示

### 5.1 问题描述

业务查询：计算过去 30 天内，每个区域的活跃用户数和总消费金额，按区域 + 用户级别分组。

```sql
SELECT
    u.region,
    u.level,
    COUNT(DISTINCT o.userId) AS active_users,
    SUM(o.amount) AS total_amount
FROM orders o
JOIN users u ON o.userId = u.id
WHERE o.dt BETWEEN '2024-01-01' AND '2024-01-30'
GROUP BY u.region, u.level;
```

数据规模：
- `orders`：30 天数据约 50 亿行，按 `dt` 分区
- `users`：1000 万行（未分区），全量用户信息

**现象**：查询耗时 45 分钟，Stage 2（聚合 Stage）有严重长尾（1 个 Task 跑了 40 分钟）。

### 5.2 诊断过程

**Step 1：查看执行计划**

```
*(4) HashAggregate [region, level] count(distinct userId) sum(amount)
+- Exchange hashpartitioning(region#1, level#2, 200)
   +- *(3) HashAggregate [region, level, userId] count(userId) sum(amount)
      +- *(3) SortMergeJoin [userId#3], [id#4], Inner   ← 未 Broadcast！
         :- *(3) Sort [userId#3 ASC]
         :  +- Exchange hashpartitioning(userId#3, 200)
         :     +- *(2) FileScan parquet orders[userId,amount,dt]
         :        PartitionFilters: [dt BETWEEN 2024-01-01 AND 2024-01-30]  ← 分区裁剪生效
         +- *(1) Sort [id#4 ASC]
            +- Exchange hashpartitioning(id#4, 200)
               +- *(1) FileScan parquet users[id,region,level]  ← 全量扫描 1000 万行
```

**发现问题一**：`users` 表（1000 万行，约 500MB）未被 Broadcast，使用了 SortMergeJoin。检查 `EXPLAIN COST`，发现 users 的 `sizeInBytes` 显示为 `Unknown`（没有统计信息）。

**发现问题二**：Stage 2 长尾，查看 Task 指标，`level='VIP'` 的分区有 3 亿行（占总数据量 60%），倾斜严重。

### 5.3 调优方案

**修复一：为 users 表收集统计信息 + 强制 Broadcast**

```sql
-- 收集统计信息
ANALYZE TABLE users COMPUTE STATISTICS FOR COLUMNS id, region, level;

-- 或直接加 Hint（统计信息更新需要时间，Hint 立即生效）
SELECT /*+ BROADCAST(u) */
    u.region,
    u.level,
    ...
```

Broadcast 使 `users` 不再触发 Shuffle（消除一轮 200 分区的 Shuffle），且 Join 后每个 Executor 在本地完成，Join 时间从 20 分钟降到 2 分钟。

**修复二：处理 level='VIP' 的倾斜**

分析：`level='VIP'` 用户消费金额是普通用户的 100 倍，聚合时该分区异常大。

解决方案：两阶段聚合（先加盐局部聚合，再去盐全局合并）：

```sql
-- 两阶段聚合改写
WITH phase1 AS (
    SELECT
        u.region,
        u.level,
        CONCAT(u.region, '_', u.level, '_',
               CAST(FLOOR(RAND() * 20) AS STRING)) AS group_salted,
        o.userId,
        o.amount
    FROM orders o
    JOIN /*+ BROADCAST(u) */ users u ON o.userId = u.id
    WHERE o.dt BETWEEN '2024-01-01' AND '2024-01-30'
),
phase1_agg AS (
    -- 带盐的局部聚合（去重 userId 在同盐内先去重）
    SELECT group_salted,
           region, level,
           COUNT(DISTINCT userId) AS partial_distinct,  -- 注意：这里仍需全局去重，只能简化为 COUNT(userId)
           SUM(amount) AS partial_sum
    FROM phase1
    GROUP BY group_salted, region, level
)
-- 全局合并
SELECT region, level,
       SUM(partial_sum) AS total_amount
       -- COUNT DISTINCT 需特殊处理（见下方说明）
FROM phase1_agg
GROUP BY region, level;
```

> [!warning] 生产避坑
> `COUNT(DISTINCT userId)` 的两阶段聚合比 `SUM` 复杂：局部去重后的 `COUNT(DISTINCT)` 在全局合并时无法简单求和（不同盐内可能有相同 userId）。解决方案有两种：(1) 改用 `approx_count_distinct`（有约 5% 误差，但快速且无倾斜）；(2) 在 Phase 1 先 `SELECT DISTINCT group_salted, region, level, userId`，Phase 2 对 `(region, level)` 做 `COUNT(userId)`（精确但需额外一轮 Shuffle）。

**修复后效果**：
- Broadcast 消除 Join Shuffle：Join 时间 20min → 2min
- 两阶段聚合消除 VIP 倾斜：聚合长尾 Task 40min → 5min
- 总查询时间：45min → **8min**（5.6x 加速）

---

## 小结

本篇提供了 Spark SQL 调优的完整实战框架：

- **调优原则**：先诊断（量化各部分时间）再治疗，避免经验主义盲目调参
- **五步诊断法**：确定阶段 → 定位慢 Stage → 分析 Task 指标 → 解读执行计划 → 验证效果
- **六类常见场景**：Shuffle 过重（减少中间结果 + 调整分区数）、Join 误选（统计信息 + Hint）、数据倾斜（AQE + Salting + 隔离）、I/O 低效（分区裁剪 + 谓词下推）、OOM（内存配置 + Spill）、并行度不合理（AQE + 分区设置）
- **调优 Checklist**：涵盖数据层、配置层、SQL 写法层、执行计划核查四个维度

第 12 篇将作为本专栏的参考手册：汇总所有关键配置参数的含义、默认值、调优建议，方便在实际工作中快速查阅。

---

> [!note] 思考题
> 1. 五步诊断法的第一步是"确定整体瓶颈阶段"，需要区分是 CPU 密集、I/O 密集还是 Shuffle 密集。但在实际 Spark UI 中，一个 Stage 的 Task 时间往往是多种因素叠加的。如何判断一个 Stage 是受 GC 压力拖慢的，而不是因为数据量本身大？GC 时间的阈值应该怎么设定？
> 2. `EXPLAIN` 命令输出的执行计划是"编译期"计划，而 AQE 会在运行时修改它。当你在 Spark UI 的 SQL Tab 看到实际执行计划与 `EXPLAIN` 输出不一致时，如何判断哪个是真正被执行的计划？有没有办法在不实际运行 SQL 的情况下预测 AQE 会做什么优化？
> 3. 生产调优中常见一类"治好了又复发"的问题：添加了分桶表或调大了广播阈值后性能明显提升，但几天后慢查询再次出现。通常是什么根因导致了这种"调优效果衰减"？如何设计一套持续有效的性能基线监控，让调优效果能够被量化追踪？

## 参考资料

- Spark 官方文档：Performance Tuning（spark.apache.org）
- [Top Performance Tuning Tips for Spark SQL（Databricks Tech Blog）](https://www.databricks.com/blog/2015/05/28/tuning-java-garbage-collection-for-spark-applications.html)
- 《High Performance Spark》（Holden Karau, Rachel Warren，O'Reilly 2017）
- [Spark Summit: Tuning Apache Spark for Large Scale Workloads（YouTube）](https://www.youtube.com/watch?v=RmqOHsaFYdw)
- Apache Spark 源码：`org.apache.spark.sql.execution.ui.SparkPlanGraphWrapper`
