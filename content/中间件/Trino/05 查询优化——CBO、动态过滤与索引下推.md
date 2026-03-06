---
title: "查询优化——CBO、动态过滤与索引下推"
date: 2026-03-05
tags: [中间件, Trino, CBO, 查询优化, 动态过滤, 谓词下推, Join重排序, 执行计划]
aliases: []
---

# 查询优化——CBO、动态过滤与索引下推

## 摘要

查询优化器是 Trino 将 SQL 语义转换为高效执行计划的核心模块。Trino 拥有两个层次的优化器：**基于规则的优化器（RBO）** 和 **基于代价的优化器（CBO）**。RBO 应用确定性的代数变换规则（谓词下推、列裁剪、常量折叠、子查询消除等），不依赖统计信息；CBO 依赖表和列的统计信息（行数、NDV、最小/最大值等）来估算每种执行计划的代价，选择代价最低的方案——尤其是在多表 JOIN 场景下，JOIN 顺序和 JOIN 类型（Broadcast JOIN vs Repartition JOIN）的选择对性能影响可达数量级。本文深度解析 Trino 优化器的工作机制，重点讲解 CBO 的统计信息来源与代价模型、**动态过滤（Dynamic Filtering）** 如何在运行时将小表的过滤条件下推到大表扫描，以及谓词/聚合/JOIN 下推到 Connector 的机制与边界。

---

## 第 1 章 优化器的整体架构

### 1.1 从 SQL 到执行计划的完整路径

一条 SQL 在进入执行引擎之前，需要经过优化器的完整处理流程。Trino 的优化器采用 Volcano/Cascades 优化框架的变体：先用 RBO 阶段做确定性变换，再用 CBO 阶段做代价驱动的决策。

**为什么需要两层优化器（RBO + CBO）？**

纯 RBO 的优化结果确定、不依赖统计信息，但无法处理依赖数据规模的决策（如 JOIN 顺序应该大表在左还是小表在左？）。纯 CBO 能做出更精确的选择，但依赖准确的统计信息，且搜索空间随 JOIN 数量指数级增长（N 个表有 N! 种 JOIN 顺序）。两层结合：先用 RBO 做确定性变换减少计划规模，再用 CBO 对剩余的关键决策（主要是 JOIN 顺序）做代价估算，是工程上的最优折中。

### 1.2 RBO 的核心规则

Trino 的 RBO 包含数十条规则，最重要的几类：

**谓词下推（Predicate Pushdown）**：将 WHERE/HAVING 中的过滤条件尽量推到执行计划树的叶子节点（数据源），减少中间节点需要处理的数据量。

```sql
-- 原始：先 JOIN 再过滤
Filter(dt='2024-01-15')
  Join(a.user_id = b.user_id)

-- 下推后：先过滤再 JOIN（过滤后数据量更小）
Join(a.user_id = b.user_id)
  Filter(dt='2024-01-15')  -- 下推到左侧
    TableScan(behavior_log, partition=dt='2024-01-15')  -- 进一步下推到 Connector
  TableScan(user_profile)
```

**列裁剪（Column Pruning）**：去掉查询中不被使用的列，减少从存储读取的数据量。对于 ORC/Parquet 列存格式，只读取需要的列是极大的 IO 优化。

**子查询展开（Subquery Unnesting）**：将相关子查询转换为 JOIN，避免逐行执行子查询。这在处理 `WHERE col IN (SELECT ...)` 或 `WHERE EXISTS (SELECT ...)` 时尤为重要。

**常量折叠（Constant Folding）**：在优化阶段计算常量表达式（如 `1+1`、`DATE '2024-01-15'`），避免运行时重复计算。

**Limit 提前（Limit Pushdown）**：对于 `SELECT ... LIMIT N` 的查询，优化器尽量将 LIMIT 推到靠近数据源的位置，让每个 Stage 尽早停止产出数据。

---

## 第 2 章 CBO——基于代价的优化

### 2.1 统计信息：CBO 的工作前提

CBO 的核心是**代价估算（Cost Estimation）**——计算每种执行计划方案的预期资源消耗，选择代价最低的方案。代价估算依赖**表和列的统计信息**：

| 统计信息类型 | 含义 | 用途 |
|------------|------|------|
| **Row Count** | 表的总行数 | 估算 TableScan 的输出大小 |
| **NDV（Number of Distinct Values）** | 某列的唯一值数量 | 估算 GROUP BY 后的输出行数 |
| **列的最小/最大值** | 数值型列的值域范围 | 估算范围过滤后的选择率 |
| **NULL 比例** | 某列 NULL 值的比例 | 精确估算过滤后行数 |
| **直方图（Histogram）** | 值分布的近似统计 | 更精确的选择率估算（等频直方图） |

**统计信息的来源**：
1. **Hive 表**：通过 `ANALYZE TABLE` 更新，存储在 Hive Metastore。默认不自动更新。
2. **Iceberg 表**：写入时自动收集（每列的最小/最大值在 Manifest File 中），Trino 在规划时直接读取，无需手动 ANALYZE。
3. **默认估算**：若统计信息缺失，Trino 使用默认假设（如"过滤后保留 10% 的行"），可能导致次优计划。

> [!warning] 生产避坑
> Hive 表的统计信息默认不自动更新。即使表数据发生大幅变化（如某分区新增 10 亿行），Metastore 中的统计信息仍是旧的。CBO 基于过时统计信息做出错误的 JOIN 顺序选择，可能导致查询慢几十倍。建议在大规模 ETL 写入后执行 `ANALYZE TABLE` 更新统计信息；或在关键查询上使用 Hints 显式指定 JOIN 策略，绕过 CBO 的自动决策。

### 2.2 JOIN 重排序——CBO 的核心场景

CBO 最重要的优化场景是 **JOIN 重排序（Join Reordering）**。给定 N 个表的 JOIN，理论上有 N! 种 JOIN 顺序，不同顺序的性能可以相差数量级。

**为什么 JOIN 顺序重要？**

假设有三个表：`behavior_log`（10 亿行）、`user_profile`（100 万行）、`vip_users`（1 万行）。

**错误顺序**：先 JOIN 大表和中表：
- `behavior_log (10亿) JOIN user_profile (100万)` 的中间结果约 10 亿行
- 需要在内存保持 10 亿行的 Hash Table，必然 OOM 或极慢

**正确顺序**：小表先 JOIN，大表在 Probe 侧：
- `user_profile (100万) JOIN vip_users (1万)` 的中间结果约 1 万行（仅 VIP 用户）
- Hash Table 只有 1 万行，再用 behavior_log 做 Probe（顺序扫描），内存友好

CBO 通过估算每个 JOIN 后的中间结果行数（基于行数 × 选择率），选择中间结果最小的 JOIN 顺序。

**Trino 的 JOIN 重排序算法**：Trino 使用**动态规划（Dynamic Programming）** 搜索最优 JOIN 顺序（对于 ≤ 8 个表）或**贪心算法**（更多表）。

```properties
# 开启 CBO 的 JOIN 重排序
optimizer.join-reordering-strategy=AUTOMATIC    # 自动选择（推荐）
# NONE：禁用；ELIMINATE_CROSS_JOINS：只消除笛卡尔积；AUTOMATIC：完整 CBO

# 动态规划的最大 JOIN 表数（超过后改用贪心）
optimizer.max-reordered-joins=9
```

### 2.3 JOIN 类型选择——Broadcast vs Repartition

除了 JOIN 顺序，CBO 还决定每个 JOIN 使用哪种分布式执行策略：

**Broadcast JOIN（广播 JOIN）**：
- 将 Build 侧的**小表**广播到所有 Worker（每个 Worker 有完整副本）
- Probe 侧的大表在各自 Worker 上本地处理，不需要 Shuffle
- 适用条件：Build 侧数据量 < `join.broadcast-max-build-table-bytes`（默认 100MB）
- 优势：大表无 Shuffle，节省大量网络传输
- 劣势：Build 侧广播到所有 Worker，若数据量稍大，广播开销高

**Repartition JOIN（Hash 分区 JOIN）**：
- 将 JOIN 两侧数据按 JOIN Key 的 Hash 重新分区（Shuffle），相同 key 的数据到同一 Worker
- 适用条件：Build 侧数据量较大，无法广播
- 优势：可以处理任意大小的两侧数据
- 劣势：两侧数据都需要 Shuffle，网络传输量约为两侧数据之和

CBO 根据 Build 侧的估算行数自动选择，也可以通过 Hint 强制指定：

```sql
-- 强制使用 Broadcast JOIN（当 CBO 错误地选择了 Repartition）
SELECT /*+ USE_BROADCAST_JOIN(small_table) */ *
FROM large_table
JOIN small_table ON large_table.id = small_table.id;
```

### 2.4 聚合策略——Local Aggregation 与 Global Aggregation

对于 `GROUP BY` 查询，Trino 优化器决定是否使用**两阶段聚合（Two-Phase Aggregation）**：

**两阶段聚合（推荐，CBO 默认选择）**：
- **Stage 1（Partial Aggregation，Local）**：每个 Worker 对本地 Split 先做部分聚合，减少 Shuffle 的数据量
- **Shuffle**：按 GROUP BY key 重新分区
- **Stage 2（Final Aggregation，Global）**：每个 Worker 对收到的数据做最终聚合

两阶段聚合的关键优势：若 GROUP BY 的 key 有高度重复（如按 `country` 分组，只有 200 个国家），Partial Aggregation 能将数据量压缩到 200 行，后续 Shuffle 的数据量从 GB 级降到 KB 级。

**单阶段聚合（Partial Aggregation 被优化器跳过）**：若 GROUP BY key 基数很高（如按 `user_id` 分组，用户数亿级），Partial Aggregation 几乎没有压缩效果（每个 Split 的 key 都不重复），反而引入额外的聚合开销。CBO 在估算 Partial Aggregation 的压缩率较低时，会跳过这一阶段。

---

## 第 3 章 动态过滤——运行时的谓词下推

### 3.1 静态谓词下推的局限

第 1 章介绍的谓词下推是**静态**的——在查询计划生成时（运行前），将 WHERE 子句中的已知条件下推到 TableScan。但有一类条件是**运行时才能确定**的：JOIN 条件中的小表过滤。

考虑以下查询：

```sql
SELECT b.user_id, b.event_type, b.event_time
FROM behavior_log b
JOIN vip_users v ON b.user_id = v.user_id
WHERE v.vip_level >= 3;
```

- `vip_users` 表中满足 `vip_level >= 3` 的 user_id 集合，在查询执行前是未知的（需要扫描 vip_users 才能知道）
- `behavior_log` 是个大表（10 亿行），若不做过滤，需要全量扫描
- 若能在运行时知道满足条件的 user_id 集合（如 `{1001, 1002, 5008, ...}` 共 5000 个），将其作为过滤条件下推到 `behavior_log` 的扫描，就只需要扫描 5000 个 user_id 对应的文件，IO 减少 99%+

**动态过滤（Dynamic Filtering）** 正是解决这个问题的机制。

### 3.2 动态过滤的工作原理

动态过滤的工作流程分为两个并发阶段：

```
Stage 0（并发执行）：
  Worker A：扫描 vip_users，过滤 vip_level >= 3
  Worker B：同上

  ↓ 各 Worker 收集满足条件的 user_id
  ↓ 通过 Coordinator 汇总 → 合并为全局 user_id 集合（BloomFilter）
  ↓ 广播到所有正在扫描 behavior_log 的 Worker

Stage 1（behavior_log 扫描，受动态过滤影响）：
  Worker 的 TableScanOperator 接收到 user_id BloomFilter
  → 在读取 HDFS/S3 文件时，对每个 ORC Row Group 判断：
    该 Row Group 的 user_id 范围是否与 BloomFilter 有交集？
    无交集 → 跳过整个 Row Group（IO 节省）
  → 对读取到内存的行，再次用 BloomFilter 精确过滤
```

**BloomFilter 的使用**：若满足条件的 user_id 集合较大（如 10 万个），存储精确集合需要大量内存且广播代价高。动态过滤使用 **BloomFilter**（一种概率数据结构）——允许少量假阳性（认为某行满足条件，但实际不满足），但保证无假阴性（满足条件的行不会被漏掉）。BloomFilter 的大小远小于精确集合（1MB 的 BloomFilter 可以存储约 1000 万个 hash 值，假阳性率约 1%）。

### 3.3 动态过滤的触发条件

动态过滤在满足以下条件时自动启用：

1. **JOIN 类型为 Inner JOIN 或 Right JOIN**（Left JOIN 不能用，因为左表可能需要保留所有行）
2. **Build 侧（小表）的数据量不超过阈值**：`dynamic-filtering.large-broadcast.max-size-per-driver`（默认 100MB），超过则不生成动态过滤（避免广播代价超过收益）
3. **Probe 侧（大表）来自支持动态过滤的 Connector**：目前 Hive、Iceberg、Delta Lake Connector 均支持

```properties
# 动态过滤配置
enable-dynamic-filtering=true
dynamic-filtering.small-broadcast.max-size-per-driver=1MB    # 小型 BloomFilter 直接广播
dynamic-filtering.large-broadcast.max-size-per-driver=100MB  # 大型动态过滤的上限
dynamic-filtering.small-broadcast.rows-limit=100000          # 精确 Set（非 BloomFilter）的行数上限
```

### 3.4 动态过滤的实际收益

动态过滤是 Trino 在 JOIN 查询上最重要的性能优化之一，典型场景的收益：

| 查询模式 | 大表规模 | 小表过滤率 | 扫描数据减少 | 查询提速 |
|---------|---------|-----------|------------|---------|
| 大表 JOIN 小表（高选择性） | 1TB | 99%（只有1%满足条件） | ~99% | 10~100x |
| 大表 JOIN 小表（低选择性） | 1TB | 10%（90%满足条件） | ~10% | 1.1~1.5x |
| 星型模型多维过滤 | 100GB 事实表 | 各维度过滤叠加 95% | ~95% | 5~20x |

实际效果取决于大表的分区/文件组织——若 user_id 的分布在文件中高度相关（如数据按 user_id 排序存储），BloomFilter 能跳过大量整个文件；若 user_id 完全随机分布，BloomFilter 对文件级别的跳过效果有限，但对行组级别的过滤仍有效。

---

## 第 4 章 Connector 级别的下推优化

### 4.1 聚合下推（Aggregation Pushdown）

对于 JDBC 类 Connector（MySQL、PostgreSQL、SQL Server 等），Trino 支持将简单的聚合操作下推到数据库层面执行：

```sql
-- Trino SQL
SELECT country, count(*) FROM mysql_prod.users.user_profile GROUP BY country;

-- 未启用聚合下推：Trino 读取所有行，在 Worker 内存中做聚合（可能读取亿行）
-- 启用聚合下推：Trino 向 MySQL 发送：
--   SELECT country, count(*) FROM user_profile GROUP BY country
-- MySQL 自己完成聚合，只返回 200 行（按国家数量），Trino 网络传输极小
```

聚合下推的启用配置：

```properties
# MySQL Connector 配置
connector.name=mysql
aggregation-pushdown.enabled=true
```

**聚合下推的局限**：只对简单聚合（`COUNT`, `SUM`, `MIN`, `MAX`, `AVG`）有效，复杂聚合（`ARRAY_AGG`, `PERCENTILE` 等）无法下推。且数据库的聚合性能不一定比 Trino 的 MPP 聚合快——对于行数较少（< 百万）的表，下推聚合效果显著；对于大表，数据库的单机聚合可能反而成为瓶颈。

### 4.2 JOIN 下推（Join Pushdown）

对于 JDBC Connector，Trino 支持将 JOIN 操作下推到同一个数据源的两个表之间：

```sql
-- 两张都在 MySQL 的表的 JOIN
SELECT o.order_id, u.user_name
FROM mysql_prod.orders.order_items o
JOIN mysql_prod.users.user_profile u ON o.user_id = u.user_id
WHERE o.order_date = '2024-01-15';

-- 若 JOIN 下推启用：Trino 向 MySQL 发送完整的 JOIN SQL：
-- SELECT o.order_id, u.user_name
-- FROM orders.order_items o JOIN users.user_profile u ON o.user_id = u.user_id
-- WHERE o.order_date = '2024-01-15'
-- MySQL 利用索引完成 JOIN，只返回匹配的行

-- 若未下推：Trino 分别读取两张表，在内存中做 Hash JOIN（全表读取）
```

JOIN 下推的适用场景：**两张表在同一个 JDBC 数据源，且数据量不太大**。对于大表 JOIN，MySQL 的单机 JOIN 性能不如 Trino 的 MPP，此时应避免下推。

### 4.3 LIMIT 下推（TopN Pushdown）

对于 JDBC Connector 和 Hive Connector，Trino 支持将 `ORDER BY ... LIMIT N` 下推：

```sql
-- 下推前：Trino 读取所有数据，全量排序后取前 10 行
-- 下推后（MySQL）：
-- SELECT * FROM orders ORDER BY order_date DESC LIMIT 10
-- MySQL 利用索引快速返回前 10 行，无需全表扫描

SELECT * FROM mysql_prod.orders.orders
ORDER BY order_date DESC LIMIT 10;
```

---

## 第 5 章 EXPLAIN——理解执行计划

### 5.1 EXPLAIN 的使用

Trino 的 `EXPLAIN` 命令是调优查询的最重要工具。通过分析执行计划，可以发现 JOIN 顺序不合理、谓词未正确下推、某个 Stage 数据量异常大等问题。

```sql
-- 查看逻辑执行计划（优化后，未分 Stage）
EXPLAIN SELECT b.user_id, count(*) FROM behavior_log b
JOIN vip_users v ON b.user_id = v.user_id
GROUP BY b.user_id;

-- 查看分布式执行计划（含 Stage 划分）
EXPLAIN (TYPE DISTRIBUTED) SELECT ...;

-- 查看更详细的 I/O 统计信息（含分区裁剪信息）
EXPLAIN (TYPE IO) SELECT ...;

-- 实际执行并返回执行计划（含运行时统计，最详细）
EXPLAIN ANALYZE SELECT ...;
```

### 5.2 识别执行计划中的性能问题

**问题一：ScanFilter 行数远超预期（分区裁剪未生效）**

```
- ScanFilter[behavior_log]
    Estimates: {rows: 1000000000, cpu: 1000000000, memory: 0, network: 0}
    dt = '2024-01-15'
```

若 `Estimates` 显示行数是整张表的行数（而非某个分区的行数），说明分区裁剪未生效——可能是 `dt` 列的统计信息缺失，或者过滤条件的格式与分区格式不匹配（如日期格式不一致）。

**问题二：CrossJoin（笛卡尔积）**

```
- CrossJoin
    Left: TableScan[table_a] Estimates: {rows: 1000000}
    Right: TableScan[table_b] Estimates: {rows: 1000000}
```

若执行计划中出现 `CrossJoin`，说明两个表之间没有有效的 JOIN 条件（可能是 WHERE 子句中的 JOIN 条件写错了），需要立即检查 SQL。

**问题三：Remote Exchange 传输量过大**

```
- RemoteExchange[REPARTITION] Estimates: {rows: 1000000000, ...}
```

若 `RemoteExchange` 的行数估算很大，说明 Shuffle 阶段需要传输大量数据。检查是否可以通过谓词下推减少 Shuffle 前的数据量，或者改用 Broadcast JOIN（若 Build 侧确实较小）。

**问题四：Aggregation 的 Partial 阶段没有显著压缩**

```
- AggregationNode[PARTIAL] Estimates: {rows: 999000000 → 998000000}
```

若 Partial Aggregation 几乎没有压缩（行数从 10 亿变为 9.98 亿），说明 GROUP BY key 基数很高，Partial Aggregation 无效，应考虑在 SESSION 级别禁用它：

```sql
SET SESSION enable_intermediate_aggregations = false;
```

---

## 第 6 章 执行计划调优实战

### 6.1 通过 Join Hints 干预 JOIN 策略

当 CBO 因统计信息不准确做出错误的 JOIN 决策时，可以通过 Hints 覆盖：

```sql
-- 强制 Broadcast JOIN（当 CBO 错误选择了 Repartition）
SELECT /*+ USE_BROADCAST_JOIN(small_table) */ *
FROM large_table l
JOIN small_table s ON l.id = s.id;

-- 强制 Repartition JOIN（防止小表实际很大时广播 OOM）
SELECT /*+ NO_BROADCAST_JOIN(supposedly_small) */ *
FROM large_table l
JOIN supposedly_small s ON l.id = s.id;
```

### 6.2 通过 Session Properties 调整优化器行为

```sql
-- 禁用 CBO 的 JOIN 重排序（当 CBO 选错顺序时）
SET SESSION join_reordering_strategy = 'NONE';

-- 强制指定 JOIN 分布类型
SET SESSION join_distribution_type = 'BROADCAST';  -- 或 'REPARTITIONED'

-- 调整 Broadcast JOIN 的大小阈值（默认 100MB）
SET SESSION broadcast_join_max_table_bytes = '500MB';

-- 启用/禁用动态过滤
SET SESSION enable_dynamic_filtering = true;

-- 控制是否使用 CBO 统计信息做代价估算
SET SESSION use_cost_based_optimizer = false;  -- 退回纯 RBO
```

### 6.3 常见查询优化模式

**模式一：星型模型优化（Star Schema）**

数仓中最常见的查询模式是大事实表 JOIN 多个小维度表。动态过滤 + Broadcast JOIN 的组合：

```sql
-- 典型的星型查询
SELECT d_date.quarter, p_product.category, sum(f_sales.amount)
FROM fact_sales f
JOIN dim_date d ON f.date_id = d.date_id
JOIN dim_product p ON f.product_id = p.product_id
JOIN dim_region r ON f.region_id = r.region_id
WHERE d.year = 2024 AND r.country = 'CN'
GROUP BY d_date.quarter, p_product.category;
```

优化器应该选择：
1. 先从 `dim_date` 和 `dim_region` 中获取满足条件的 ID 集合（动态过滤）
2. 用这些 ID 集合过滤 `fact_sales` 的扫描（减少 IO）
3. 对所有维度表使用 Broadcast JOIN（维度表通常较小）

**模式二：窗口函数的优化**

```sql
-- 低效写法（两次全表扫描）
SELECT user_id, event_time,
       rank() OVER (PARTITION BY user_id ORDER BY event_time) AS rnk
FROM behavior_log
WHERE dt = '2024-01-15';

-- 若只需要最近 N 条，用子查询 + LIMIT 避免排序全量数据
SELECT user_id, event_time FROM (
    SELECT user_id, event_time,
           row_number() OVER (PARTITION BY user_id ORDER BY event_time DESC) AS rn
    FROM behavior_log WHERE dt = '2024-01-15'
) WHERE rn <= 3;
```

---

## 第 7 章 小结

### 7.1 查询优化的层次与优先级

Trino 的查询优化分为五个层次，从高到低优先级依次为：

1. **分区裁剪（Connector 级别）**：效果最大，单次查询可减少 90%+ 的 IO，应首先确保 WHERE 条件能正确下推到分区列
2. **动态过滤（运行时下推）**：对星型模型等高选择性 JOIN 查询，减少大表扫描量 90%+
3. **JOIN 顺序与类型（CBO）**：确保统计信息准确，让 CBO 做出正确的 JOIN 决策；或通过 Hints 干预
4. **文件/行组级别过滤（ORC/Parquet 统计）**：由 Connector 自动利用，确保使用列存格式
5. **Operator 级别优化（Partial Aggregation、列裁剪）**：由优化器自动处理，通常无需手动干预

### 7.2 后续章节导引

- **[[06 Trino 运维——集群部署、慢查询分析与调优]]**：从运维角度讲解如何部署 Trino 集群、通过 Trino UI 和监控指标定位慢查询、以及生产环境中的常见调优场景

---

> [!note] 思考题
> 1. Trino 的权限模型支持 Catalog → Schema → Table → Column 级别的访问控制。在一个数据湖场景中（多个团队共享同一个 Trino 集群），你如何设计权限策略——按团队划分 Catalog 还是按数据域划分 Schema？OPA（Open Policy Agent）集成如何实现更灵活的权限策略？
> 2. 数据脱敏（Data Masking）在查询时动态替换敏感数据（如将手机号显示为 `138****1234`）。Trino 的 Column Masking 功能可以为不同用户组配置不同的脱敏规则。与在数据源层做脱敏相比，在查询引擎层做脱敏有什么优势（如不需要复制数据、规则统一管理）？
> 3. Trino 支持 Kerberos、OAuth2 和证书认证。在 Kubernetes 环境中，你倾向于使用哪种认证方式？OAuth2 + OIDC（如 Keycloak）与 Kerberos 在运维复杂度和用户体验方面有什么差异？
