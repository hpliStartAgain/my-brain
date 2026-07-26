---
title: "MySQL 查询优化器——从代价模型到执行计划的决策过程"
date: 2026-03-02
tags: [MySQL, Optimizer, 代价模型, 执行计划, 查询优化器, 统计信息]
aliases: [查询优化器, 代价模型, 执行计划]
---

# 09 MySQL 查询优化器——从代价模型到执行计划的决策过程

**摘要：** 为什么同一条 SQL 在数据量小时走索引，数据量大了之后反而走全表扫描？为什么有时候你明明建了索引，MySQL 却不用？为什么 `FORCE INDEX` 能提升性能，有时候又会让性能更差？这些问题的答案都藏在 MySQL 查询优化器的决策逻辑里。本文深入 [[MySQL]] 优化器的核心架构：统计信息（Statistics）如何描述数据分布，代价模型（Cost Model）如何量化不同执行方案的"代价"，优化器如何在候选方案中选出"最优"方案。理解了这套决策机制，执行计划就不再神秘——你可以预测优化器会做什么选择，并知道如何提供正确的"引导"让优化器做出更好的决策。

---

## 第 1 章 优化器的位置与职责

### 1.1 SQL 的生命周期回顾

在 MySQL 全局架构（第 01 篇）中，一条 SQL 的执行路径是：

```
SQL → 解析器（Parser）→ 优化器（Optimizer）→ 执行器（Executor）→ 存储引擎
```

**解析器** 负责语法检查和语义分析，将 SQL 字符串解析成内部的抽象语法树（AST），并验证表名、列名是否存在，用户是否有权限等。

**优化器** 接收 AST，负责决定"如何执行这条 SQL"——选择什么索引、以什么顺序连接多张表、是否使用临时表或文件排序等。优化器的输出是一个**执行计划（Execution Plan）**。

**执行器** 按照执行计划，调用存储引擎的 API 来实际获取数据，最终将结果集返回给客户端。

优化器是整个查询处理链中最复杂的组件。它面对的核心问题是一个 **NP-Hard 问题**：对于一个 n 张表的 JOIN，可能的连接顺序有 n! 种，每种顺序又有多种索引选择方式，候选方案数量可能是天文数字。优化器必须在合理的时间内找到一个"足够好"（不一定最优）的方案。

### 1.2 基于规则的优化（RBO）与基于代价的优化（CBO）

优化器的决策方法历史上有两种流派：

**RBO（Rule-Based Optimizer，基于规则的优化器）**：维护一套固定的规则，如"有索引就用索引"、"索引比全表扫描好"等。不考虑数据的实际分布情况，完全依赖规则。Oracle 早期版本使用 RBO。

**CBO（Cost-Based Optimizer，基于代价的优化器）**：收集数据的统计信息（行数、值的分布、索引的选择性等），为每种候选执行方案计算一个"代价值"，选择代价最低的方案。MySQL 从 5.x 开始逐步向 CBO 演进，MySQL 8.0 的优化器已经是较为完整的 CBO 实现。

CBO 的优势是能够根据实际数据分布做出更合理的决策——比如，一个选择性很低的索引（如 `gender` 列，只有两种值），即使存在，使用索引扫描 + 大量回表的代价也可能高于全表扫描，CBO 会选择全表扫描。这是 RBO 无法做到的。

---

## 第 2 章 统计信息：优化器的"数据画像"

### 2.1 什么是统计信息

统计信息是优化器用于估算执行代价的数学摘要，包括：
- 表的总行数（`n_rows`）
- 表的数据页数量（`data_pages`）
- 索引的选择性（Selectivity）：不同值的数量 / 总行数
- 索引列的值分布直方图（Histogram）

MySQL 将统计信息存储在 `mysql.innodb_table_stats` 和 `mysql.innodb_index_stats` 系统表中：

```sql
-- 查看表级统计信息
SELECT * FROM mysql.innodb_table_stats WHERE table_name='orders';

-- 查看索引级统计信息  
SELECT * FROM mysql.innodb_index_stats WHERE table_name='orders';
```

典型输出：
```
table_name: orders
n_rows: 500000000        -- 预估行数（约 5 亿行）
clustered_index_size: 50000  -- 聚簇索引的页数
sum_of_other_index_sizes: 12000  -- 所有二级索引的总页数

index_name: idx_shop_status_time
stat_name: n_diff_pfx01    -- shop_id 列的不同值数量
stat_value: 10000

stat_name: n_diff_pfx02    -- (shop_id, status) 组合的不同值数量
stat_value: 30000
```

### 2.2 统计信息的采集方式

InnoDB 有两种统计信息采集方式：

**持久化统计（Persistent Statistics）**（默认）：统计信息持久存储在 `mysql.innodb_table_stats` 和 `mysql.innodb_index_stats` 中，MySQL 重启后仍然有效。由参数 `innodb_stats_persistent = ON`（默认）控制。

统计信息的自动更新触发条件：
- 表中有超过 10% 的数据发生变化时（`innodb_stats_auto_recalc = ON`，默认）
- 手动执行 `ANALYZE TABLE`

**非持久化统计（Transient Statistics）**：每次 MySQL 重启后重新采样计算，不持久存储。

### 2.3 统计信息不准确的问题

InnoDB 的统计信息是基于**随机采样**的——不是全量扫描，而是从 [[B+Tree]] 中随机选取若干个叶子页，统计这些页上的数据分布，然后推算全表的统计数据。

采样的页数由 `innodb_stats_persistent_sample_pages`（默认 20）控制。20 个页的采样对于均匀分布的数据通常足够准确，但对于数据分布极不均匀的情况（如某个 shop_id 有 80% 的数据），20 个页可能采样到的样本过少，导致统计信息偏差较大。

**统计信息不准确的后果**：优化器基于错误的行数估算，做出错误的执行计划选择，例如：
- 认为索引能过滤掉大量数据，实际上选择性很低，导致大量回表，性能更差
- 认为全表扫描行数很少，实际上表非常大，导致慢查询

**手动更新统计信息**：

```sql
-- 重新计算并持久化统计信息
ANALYZE TABLE orders;

-- 增大采样页数（临时），提高统计信息精度
SET GLOBAL innodb_stats_persistent_sample_pages = 200;
ANALYZE TABLE orders;
```

> [!warning] 生产避坑
> 在数据量发生大幅变化后（如大批量导入、删除），优化器可能因为统计信息过时而做出错误的执行计划。如果发现某个原本快的 SQL 突然变慢，第一步应该检查统计信息是否需要更新，执行 `ANALYZE TABLE` 是最低成本的修复手段。

### 2.4 直方图（Histogram）：MySQL 8.0 的精度提升

MySQL 8.0 引入了**直方图（Histogram）** 统计，可以更精确地描述列的值分布：

```sql
-- 为 status 列创建直方图（采样 100 个 bucket）
ANALYZE TABLE orders UPDATE HISTOGRAM ON status WITH 100 BUCKETS;

-- 查看直方图信息
SELECT 
    column_name,
    JSON_PRETTY(histogram) 
FROM information_schema.COLUMN_STATISTICS 
WHERE table_name='orders';
```

直方图将列的值范围划分为若干个"桶（Bucket）"，记录每个桶内值的分布比例。这使得优化器能够精确估计 `WHERE status=2 AND shop_id=100` 这样的复合条件下的行数，而不是简单地用 `1/不同值数量` 来估算。

---

## 第 3 章 代价模型：执行方案的量化评估

### 3.1 代价的组成

MySQL 的代价模型将执行一个方案的总代价分为两部分：

**I/O 代价（Disk Cost）**：从磁盘（或 [[Buffer Pool]]）读取数据页的代价。读取一个数据页的代价固定为 `1.0`（单位），这是代价模型的基本单位。

**CPU 代价（CPU Cost）**：处理数据的代价，包括扫描记录、比较大小、计算函数等。处理一行记录的代价为 `0.2`（比 I/O 便宜约 5 倍，反映了 CPU 操作比 I/O 操作快得多）。

> [!info] 核心概念
> 代价模型中的 I/O 代价 `1.0` 和 CPU 代价 `0.2` 并不是真实的物理时间，而是相对量化的权重。重要的不是绝对值，而是**不同方案之间的相对代价**。这些权重存储在 `mysql.server_cost` 和 `mysql.engine_cost` 表中，MySQL 8.0 支持用户修改这些权重以适应不同的硬件环境（如纯 SSD 系统，I/O 代价与 CPU 代价的比值应该更小）。

### 3.2 全表扫描的代价估算

```sql
SELECT * FROM orders WHERE shop_id = 100;
```

如果没有索引，需要全表扫描：

```
全表扫描代价 = I/O 代价 + CPU 代价
             = 数据页数 × 1.0 + 总行数 × 0.2
             = clustered_index_size × 1.0 + n_rows × 0.2
             ≈ 50000 × 1.0 + 500000000 × 0.2
             ≈ 150,050,000
```

这个代价数字很大，意味着全表扫描非常昂贵。

### 3.3 索引扫描的代价估算

如果有索引 `idx_shop_id (shop_id)`，查询 `shop_id=100` 的代价是：

```
索引扫描代价 = 索引 I/O 代价 + 回表 I/O 代价 + CPU 代价

1. 估算满足条件的行数（通过统计信息）：
   n_diff_shop_id = 10000（shop_id 有 10000 个不同值）
   estimated_rows = n_rows / n_diff_shop_id = 500000000 / 10000 = 50000

2. 索引 I/O 代价（扫描索引叶子节点）：
   index_page_count = estimated_rows / rows_per_index_page
   ≈ 50000 / 200 = 250 页
   索引 I/O 代价 = 250 × 1.0 = 250

3. 回表 I/O 代价（每行可能需要一次回表 I/O）：
   回表代价 = estimated_rows × 1.0 = 50000
   （最坏情况下每行对应一个随机的聚簇索引页）

4. CPU 代价：
   estimated_rows × 0.2 = 50000 × 0.2 = 10000

总代价 ≈ 250 + 50000 + 10000 ≈ 60250
```

**对比**：索引扫描代价（约 60250）远小于全表扫描（约 1.5 亿），优化器选择走索引。

### 3.4 索引失效的本质原因

现在考虑一个极端情况：`shop_id=1` 这个店铺有 4 亿行数据（占总数据量的 80%）。

```
estimated_rows ≈ 400000000（80% 的行满足条件）

索引扫描代价 ≈ 400000000 / 200 × 1.0 + 400000000 × 1.0 + 400000000 × 0.2
           ≈ 480,000,000

全表扫描代价 ≈ 50000 × 1.0 + 500000000 × 0.2 = 150,050,000
```

此时全表扫描的代价（1.5 亿）**小于**索引扫描代价（4.8 亿）！优化器会选择全表扫描——这是完全正确的决策，因为通过索引找到 80% 的行后还需要大量回表，代价远高于直接顺序扫描整张表。

**这就是"明明有索引，优化器却不用"的根本原因**：当索引的选择性很低（满足条件的行占比很高），使用索引 + 回表的代价反而高于全表扫描。

---

## 第 4 章 多表 JOIN 的连接顺序优化

### 4.1 连接顺序对性能的影响

对于多表 JOIN，连接的顺序至关重要。以三张表 A、B、C 的 JOIN 为例：

- **顺序 A → B → C**：先连接 A 和 B，中间结果集大小取决于 A、B 的行数和连接条件；然后用中间结果连接 C
- **顺序 B → A → C**：先连接 B 和 A...

不同的连接顺序产生不同大小的中间结果集，最终的总 I/O 和 CPU 代价可能相差数十倍。

MySQL 使用**左深树（Left-Deep Tree）** 结构来枚举连接顺序：每次将一张新表添加到当前连接树的右侧，形成 A → (A JOIN B) → (A JOIN B JOIN C) 的结构。

对于 n 张表的 JOIN，可能的连接顺序有 n! 种。当 n ≤ `optimizer_search_depth`（默认 62，但实际会根据情况动态调整）时，优化器会枚举所有顺序；当 n 更大时，优化器会使用贪心算法（greedy search）来减少搜索空间。

### 4.2 驱动表的选择原则

在 MySQL 的 Nested Loop Join 中，**驱动表（Outer Table）** 的每一行都会触发一次对**被驱动表（Inner Table）** 的查找。

核心原则：**优先选择行数少（经过 WHERE 过滤后）的表作为驱动表，并确保被驱动表的连接列上有索引**。

```sql
SELECT o.order_no, u.name 
FROM orders o 
JOIN users u ON o.user_id = u.id
WHERE o.shop_id = 888 AND o.status = 1;
```

如果 `orders` 表 `shop_id=888 AND status=1` 过滤后有 1000 行，`users` 表有 1000 万行但 `id` 上有主键索引：

- 以 `orders` 为驱动表：扫描 1000 行，每行用 `user_id` 在 `users` 的主键索引上查找一次 → 1000 次索引查找，代价低
- 以 `users` 为驱动表：扫描 1000 万行，每行用 `id` 在 `orders` 的索引上查找 → 1000 万次查找，代价极高

优化器应该选择 `orders` 作为驱动表。

### 4.3 Block Nested Loop Join（BNL）

当被驱动表的连接列没有索引时，MySQL 5.x 使用 **Block Nested Loop Join（BNL）** 算法：

1. 将驱动表的数据批量装入 **Join Buffer**（`join_buffer_size` 控制大小，默认 256KB）
2. 扫描被驱动表的全部数据，与 Join Buffer 中的每一行进行比较

这比朴素的 Nested Loop 好——将 `驱动行数 × 被驱动全表扫描` 优化为 `⌈驱动行数 / join_buffer_size中能装的行数⌉ × 被驱动全表扫描`，减少了被驱动表的全表扫描次数。

MySQL 8.0.18+ 引入了 **Hash Join** 算法，替代了 BNL：将较小表的连接列哈希到 Join Buffer，扫描较大表时用哈希匹配。Hash Join 在等值连接且无索引的场景下比 BNL 快得多，时间复杂度从 O(n×m) 降低到 O(n+m)。

---

## 第 5 章 优化器的局限性与 Hint 的使用

### 5.1 优化器做出错误决策的场景

优化器基于统计信息做决策，当统计信息不准确时，决策可能出错：

1. **统计信息过时**：大批量数据变更后，统计信息未更新，行数估算错误
2. **数据分布极不均匀**：部分值的行数远高于平均值，采样统计无法反映真实分布
3. **复杂函数或表达式**：`WHERE YEAR(created_at) = 2024` 这类表达式，优化器无法利用 `created_at` 的统计信息（函数导致索引失效，且无法估算选择性）
4. **多列相关性**：优化器假设多个 WHERE 条件的列是独立的，估算 `WHERE shop_id=1 AND status=2` 的行数时，用 `P(shop_id=1) × P(status=2)` 来估算，但如果 `shop_id` 和 `status` 高度相关（如某个 shop 只有 status=2 的订单），这个估算会严重偏低

### 5.2 常用 Optimizer Hints

当优化器做出错误决策时，可以用 **Optimizer Hints** 强制指导：

```sql
-- 强制使用特定索引
SELECT * FROM orders FORCE INDEX (idx_shop_status) 
WHERE shop_id = 100 AND status = 1;

-- 强制忽略某个索引（如果优化器错误地选了它）
SELECT * FROM orders IGNORE INDEX (idx_created_at)
WHERE shop_id = 100;

-- 指定连接顺序（orders 作为驱动表）
SELECT /*+ JOIN_ORDER(o, u) */ o.order_no, u.name
FROM orders o JOIN users u ON o.user_id = u.id
WHERE o.shop_id = 100;

-- 强制使用 Hash Join
SELECT /*+ HASH_JOIN(o, u) */ o.order_no, u.name
FROM orders o JOIN users u ON o.user_id = u.id;

-- 设置 Join Buffer 大小
SELECT /*+ BNL(o, u) SET_VAR(join_buffer_size=16777216) */ ...
```

> [!warning] 生产避坑
> Optimizer Hints 是最后的手段，不是第一选择。过度使用 Hints 会导致 SQL 与特定的数据分布和索引结构强绑定，当数据量变化、索引调整后，原本正确的 Hint 可能变成性能杀手。**优先的解决路径是**：更新统计信息（`ANALYZE TABLE`）→ 检查并优化索引 → 改写 SQL → 使用 Hints（最后手段）。

---

## 第 6 章 EXPLAIN 与优化器追踪

### 6.1 EXPLAIN 的局限性

`EXPLAIN` 显示的是优化器**选择的执行计划**，但不显示优化器是如何做出这个选择的（即为什么不选其他方案）。这对于诊断"优化器做了错误选择"的情况有局限。

### 6.2 Optimizer Trace：追踪优化器的决策过程

MySQL 提供了 **Optimizer Trace** 功能，可以记录优化器评估每个方案的代价：

```sql
-- 开启 Optimizer Trace
SET optimizer_trace="enabled=on";
SET optimizer_trace_max_mem_size=1000000;

-- 执行目标 SQL
SELECT * FROM orders WHERE shop_id = 100 AND status = 1 
ORDER BY created_at DESC LIMIT 20;

-- 查看优化器的决策过程
SELECT trace FROM information_schema.OPTIMIZER_TRACE\G
```

输出的 JSON 格式追踪信息会显示：
- 各个候选方案（全表扫描、不同索引）的代价估算值
- 最终选择的方案及其代价
- 各步骤的行数估算

通过 Optimizer Trace，可以精确看到"优化器为什么选了全表扫描而不是索引"——是因为行数估算不准确（统计信息问题），还是因为确实全表扫描代价更低（需要优化索引或查询）。

---

## 第 7 章 小结

本文构建的优化器知识体系：

1. **优化器是 CBO**：基于统计信息和代价模型做决策，不是固定规则。相同 SQL 在不同数据量下可能得到不同的执行计划
2. **统计信息是决策基础**：行数估算、索引选择性、直方图共同描述数据画像。统计信息过时 → 行数估算错误 → 错误执行计划；`ANALYZE TABLE` 是低成本的修复手段
3. **代价模型量化执行代价**：I/O 代价（读取数据页）+ CPU 代价（处理行数据）。全表扫描 vs 索引扫描的选择，本质是两种方案代价数值的比较
4. **索引失效的本质**：当满足条件的行占比很高（选择性低）时，索引扫描 + 大量回表的代价高于全表顺序扫描，优化器正确选择全表扫描
5. **JOIN 连接顺序优化**：优先选行数少的表为驱动表，被驱动表的连接列必须有索引；8.0.18+ Hash Join 在无索引等值 JOIN 场景大幅优于 BNL
6. **Optimizer Hints 是最后手段**：应先更新统计信息、优化索引、改写 SQL，再考虑 Hints
7. **Optimizer Trace 揭示决策过程**：当执行计划不符合预期时，用 Trace 查看代价估算，找到优化器做出错误选择的真正原因

---

> [!note] 思考题
> 1. 分库分表将数据按分片键分散到多个数据库实例。水平分片（按行拆分）和垂直分片（按列拆分）各适合什么场景？在一个按 `user_id` 分片的订单表中，如果查询 `SELECT * FROM orders WHERE merchant_id = 123`（非分片键），需要查询所有分片——性能很差。如何在分片键之外的查询上保持性能？异构索引表和 Elasticsearch 辅助查询各有什么优劣？
> 2. ShardingSphere-JDBC 以 JDBC Driver 的形式嵌入应用——拦截 SQL 并路由到正确的分片。ShardingSphere-Proxy 作为独立的数据库代理——对应用透明。两种方式在性能开销、运维复杂度和适用场景方面有什么区别？在 Kubernetes 环境中哪种更合适？
> 3. 分库分表后的数据迁移（如从 8 个分片扩展到 16 个分片）需要重新分配数据。在线迁移（不停机）的挑战是什么——如何保证迁移期间数据的一致性？'双写'方案和'增量同步'方案各有什么优劣？
