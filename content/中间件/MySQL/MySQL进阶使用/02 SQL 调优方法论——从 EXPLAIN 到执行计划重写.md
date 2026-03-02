---
title: "SQL 调优方法论——从 EXPLAIN 到执行计划重写"
date: 2026-03-02
tags: [MySQL, SQL调优, EXPLAIN, 执行计划, 性能优化]
aliases: [MySQL SQL调优, EXPLAIN详解]
---

# 02 SQL 调优方法论——从 EXPLAIN 到执行计划重写

**摘要：** 慢查询是线上系统性能问题的头号嫌疑人。但"这条 SQL 很慢"只是症状，根因可能是索引缺失、执行计划偏差、数据分布倾斜、或者 SQL 写法本身有问题。本文建立一套系统化的 SQL 调优方法论：先用 `EXPLAIN` 读懂执行计划（每一列在说什么、如何判断执行计划好不好），再掌握最常见的慢查询模式（深分页、隐式转换、子查询陷阱），最后通过 SQL 改写技巧将"烂 SQL"变成"好 SQL"。调优不是碰运气加索引，而是**诊断 → 定位 → 改写 → 验证**的工程化流程。

---

## 第 1 章 调优的正确姿势：不是"加索引"而是"读执行计划"

### 1.1 为什么大多数人的调优方式是错的

面对一条慢查询，很多开发者的第一反应是"加个索引试试"。运气好的话，加对了索引确实能解决问题；运气不好的话，加了一堆无效索引，查询依然很慢，写入性能反而下降了。

这种"试错法"的根本问题在于：**你不知道 MySQL 到底在做什么**。你不知道它选了哪个索引、是全表扫描还是索引扫描、有没有做排序、有没有用临时表、预估扫描了多少行。没有这些信息，"加索引"就是盲人摸象。

正确的调优流程是：

1. **定位慢查询**：通过慢查询日志或监控系统找到需要优化的 SQL
2. **EXPLAIN 诊断**：读懂执行计划，理解 MySQL 的执行策略
3. **分析根因**：是索引缺失？索引选错？SQL 写法有问题？数据量太大？
4. **针对性改写**：根据根因选择加索引、改 SQL、拆查询等手段
5. **验证效果**：再次 EXPLAIN + 实际执行时间对比，确认优化有效

这个流程的核心是第 2 步——`EXPLAIN` 是 MySQL 调优的"X 光机"，不会读 EXPLAIN 就无法做有效的调优。

### 1.2 EXPLAIN 的基本用法

在任何 SELECT 语句前加上 `EXPLAIN` 关键字，MySQL 就会返回这条查询的执行计划，而不是实际执行查询：

```sql
EXPLAIN SELECT name, email FROM users WHERE age > 25 ORDER BY created_at;
```

MySQL 8.0 还支持几种增强格式：

```sql
-- JSON 格式，包含更详细的代价信息
EXPLAIN FORMAT=JSON SELECT ...;

-- TREE 格式（8.0.16+），以树状结构展示执行计划
EXPLAIN FORMAT=TREE SELECT ...;

-- ANALYZE（8.0.18+），实际执行查询并展示真实的行数和时间
EXPLAIN ANALYZE SELECT ...;
```

> [!warning] 生产避坑
> `EXPLAIN ANALYZE` 会**真正执行查询**，对于耗时很长的慢查询，它本身的执行时间也会很长。在生产环境诊断时，优先使用普通 `EXPLAIN`（不实际执行），只在开发/测试环境使用 `EXPLAIN ANALYZE` 获取精确数据。

---

## 第 2 章 EXPLAIN 输出逐列深度解读

### 2.1 输出列全景

`EXPLAIN` 的标准输出包含以下列：

| 列名 | 含义 | 重要程度 |
|------|------|----------|
| `id` | 查询的序号标识 | ★★☆ |
| `select_type` | 查询类型（简单查询/子查询/UNION等） | ★★☆ |
| `table` | 访问的表名 | ★★★ |
| `partitions` | 匹配的分区 | ★☆☆ |
| `type` | **访问类型（最核心的性能指标）** | ★★★ |
| `possible_keys` | 可能使用的索引 | ★★☆ |
| `key` | 实际使用的索引 | ★★★ |
| `key_len` | 使用的索引长度 | ★★★ |
| `ref` | 与索引比较的列或常量 | ★★☆ |
| `rows` | 预估扫描行数 | ★★★ |
| `filtered` | 经过条件过滤后的行百分比 | ★★☆ |
| `Extra` | **额外信息（第二重要的列）** | ★★★ |

其中 `type` 和 `Extra` 是诊断慢查询时最需要关注的两列，下面逐一深入解读。

### 2.2 type 列：访问类型的性能阶梯

`type` 列描述了 MySQL 如何查找表中的数据行，是判断查询性能好坏的**第一指标**。从最优到最差的排列如下：

#### 2.2.1 system 与 const：常量级查找

**`system`**：表中只有一行数据（系统表），这是 `const` 的特殊情况，实际业务中极少出现。

**`const`**：通过**主键或唯一索引**的**等值查询**，最多只返回一行结果。MySQL 在优化阶段就能确定结果，将其视为常量。

```sql
-- const 类型：主键等值查询
EXPLAIN SELECT * FROM users WHERE id = 42;
-- type: const, rows: 1
```

为什么叫"常量"？因为 MySQL 在优化阶段就知道 `id = 42` 最多匹配一行（主键是唯一的），所以它可以提前读取这一行，在后续的优化过程中将其当作常量值来处理。如果这条查询是一个更大查询的子部分（比如子查询或 JOIN 的驱动表），这种"常量化"能极大简化优化器的决策。

#### 2.2.2 eq_ref：主键/唯一索引的 JOIN 查找

当 JOIN 的关联条件使用的是**被驱动表的主键或唯一索引**时，每次关联最多找到一行匹配记录，`type` 为 `eq_ref`。

```sql
-- eq_ref 类型：JOIN 时被驱动表通过主键匹配
EXPLAIN SELECT * FROM orders o JOIN users u ON o.user_id = u.id;
-- users 表的 type: eq_ref（因为 u.id 是主键，每次关联最多一行）
```

`eq_ref` 是多表 JOIN 中**最理想的访问类型**。它意味着每次从驱动表拿到一个关联值，在被驱动表中只需要精确定位一行——没有多余的扫描，没有浪费。

#### 2.2.3 ref：非唯一索引的等值查找

当 WHERE 条件使用的是**非唯一索引**的等值查询，或 JOIN 条件对应的是非唯一索引时，`type` 为 `ref`。与 `const` / `eq_ref` 的区别在于：匹配的结果可能不止一行。

```sql
-- ref 类型：非唯一索引等值查询
EXPLAIN SELECT * FROM users WHERE name = '张三';
-- type: ref（name 上有普通索引，但不是唯一索引，可能匹配多行）
```

`ref` 的性能通常很好，尤其是当索引选择性高（匹配行数少）时。但如果索引选择性差（比如 `status = 1` 匹配了 80% 的数据），即使 `type` 显示为 `ref`，实际性能也不理想——因为回表次数太多。

#### 2.2.4 range：索引范围扫描

当 WHERE 条件对索引列使用了范围操作符（`>`, `<`, `>=`, `<=`, `BETWEEN`, `IN`）时，`type` 为 `range`。

```sql
-- range 类型
EXPLAIN SELECT * FROM users WHERE age BETWEEN 20 AND 30;
EXPLAIN SELECT * FROM orders WHERE status IN (1, 2, 3);
```

`range` 表示 MySQL 能够利用索引定位到一个范围的起始位置，然后沿着索引顺序扫描这个范围内的记录，而不是扫描全表。`IN` 在 MySQL 内部也被当作多个等值范围的组合来处理。

`range` 的性能好坏取决于范围的大小。如果范围很窄（比如 `age BETWEEN 25 AND 26`），扫描的行数很少；如果范围很宽（比如 `age > 0`），几乎退化为全索引扫描。

#### 2.2.5 index：全索引扫描

**`index`** 表示 MySQL 扫描了**整棵索引树**（遍历所有叶子节点），但没有回表。这通常发生在覆盖索引场景下，但查询条件无法利用索引的有序性来缩小范围。

```sql
-- index 类型：覆盖索引但无法利用索引过滤
EXPLAIN SELECT name FROM users;
-- 假设 name 上有索引，查询只需要 name 列
-- MySQL 选择扫描 idx_name 索引（比扫描整张表小），但要遍历所有叶子节点
```

`index` 和 `ALL` 的区别在于：`index` 只扫描索引文件（通常比数据文件小很多），`ALL` 扫描整个数据文件。但两者的时间复杂度都是 O(n)，对于大表来说都很慢。

#### 2.2.6 ALL：全表扫描

**`ALL`** 是性能最差的访问类型，意味着 MySQL 要扫描整张表的所有行。当你在 `EXPLAIN` 中看到 `type: ALL` 且 `rows` 值很大时，通常意味着有严重的性能问题。

```sql
-- ALL 类型：全表扫描
EXPLAIN SELECT * FROM orders WHERE YEAR(created_at) = 2026;
-- 对索引列使用了函数，索引失效，退化为全表扫描
```

> [!info] 核心概念
> **type 列的性能排序**（从最好到最差）：
> `system` > `const` > `eq_ref` > `ref` > `range` > `index` > `ALL`
> 
> 作为一条经验法则：**生产环境中的查询，`type` 至少应该达到 `range` 级别**。如果出现 `index` 或 `ALL`，且 `rows` 超过几千行，就应该考虑优化。

### 2.3 key_len 列：判断联合索引用了几列

`key_len` 的值是**实际使用的索引部分的字节长度**，这个信息在联合索引场景下极其有用——它能告诉你联合索引的前几个列被真正利用了。

计算规则（参考上一篇文章的详细表格）：
- `INT NOT NULL` → 4 字节
- `BIGINT NOT NULL` → 8 字节
- `VARCHAR(n) NOT NULL`（utf8mb4）→ n × 4 + 2 字节
- 允许 NULL 的列额外 +1 字节

**实战示例**：

```sql
-- 联合索引 idx_uid_status_time (user_id BIGINT, status INT, created_at DATETIME)
-- 所有列 NOT NULL

-- 场景 1：只用到 user_id
EXPLAIN SELECT * FROM orders WHERE user_id = 10086;
-- key_len = 8（BIGINT = 8 字节）

-- 场景 2：用到 user_id + status
EXPLAIN SELECT * FROM orders WHERE user_id = 10086 AND status = 1;
-- key_len = 12（8 + 4 = 12 字节）

-- 场景 3：用到全部三列
EXPLAIN SELECT * FROM orders WHERE user_id = 10086 AND status = 1 AND created_at > '2026-01-01';
-- key_len = 17（8 + 4 + 5 = 17 字节，DATETIME = 5 字节）
```

通过 `key_len` 的值，你可以精确判断联合索引是在第几列被"截断"了。如果 `key_len` 比预期的小，说明后面的列没有被利用——可能是因为查询条件的写法不对，也可能是因为范围条件截断了后续列。

### 2.4 rows 列与 filtered 列：预估的扫描量

**`rows`** 是优化器**预估**需要扫描的行数。注意两个关键词：

1. **"预估"**：这个值基于统计信息计算得出，不是精确值。统计信息可能过时或不准确。
2. **"扫描"**：不是"返回"的行数。MySQL 可能扫描了 10000 行，但只返回 100 行。

**`filtered`** 是经过 WHERE 条件过滤后，预估会保留的行的百分比。`rows × filtered / 100` 就是预估的最终结果行数。

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 10086 AND status = 1;
-- rows: 500, filtered: 20.00
-- 含义：预估扫描 500 行（通过 user_id 索引定位），其中 20% 满足 status = 1 条件
-- 最终预估返回 500 × 20% = 100 行
```

在多表 JOIN 中，`rows × filtered / 100` 的乘积直接决定了整个查询的总工作量。如果驱动表预估返回 1000 行，被驱动表每次关联扫描 500 行，总扫描量就是 1000 × 500 = 50 万行。所以**驱动表的结果集越小越好**——这也是优化器选择 JOIN 顺序的核心考量。

### 2.5 Extra 列：隐藏的性能情报

`Extra` 列包含了执行计划的补充信息，很多关键的性能问题只有在这一列才能看到。以下是最重要的几种：

#### 2.5.1 Using index（覆盖索引）

```
Extra: Using index
```

表示查询所需的所有列都在索引中，**不需要回表**到聚簇索引。这是最理想的状态——查询完全在索引树上完成。参考上一篇文章中关于[[覆盖索引]]的详细讲解。

#### 2.5.2 Using index condition（索引下推）

```
Extra: Using index condition
```

表示 [[InnoDB]] 启用了**索引下推（ICP）**优化：在存储引擎层利用索引中的列提前过滤，减少回表次数。这通常出现在联合索引的"截断"场景中——前面的列用于索引定位，后面的列虽然无法用于索引的有序性查找，但可以在存储引擎层做过滤。

#### 2.5.3 Using where

```
Extra: Using where
```

表示 Server 层在存储引擎返回数据后，还需要进一步做 WHERE 条件过滤。**这本身不一定是问题**——很多查询都会有这个标记。但如果同时 `type` 是 `ALL` 且 `rows` 很大，那就说明大量数据被存储引擎读出来后又被 Server 层丢弃了，这是需要优化的信号。

#### 2.5.4 Using filesort（额外排序）

```
Extra: Using filesort
```

表示 MySQL 无法利用索引的有序性完成 `ORDER BY` 操作，需要进行**额外的排序**。注意"filesort"这个名字有误导性——它**不一定涉及磁盘文件**。如果数据量小于 `sort_buffer_size`（默认 256KB），排序在内存中完成；如果超出缓冲区大小，才会使用临时磁盘文件做归并排序。

`Using filesort` 什么时候是问题？当排序的数据量很大时。对几十行数据做 filesort 几乎不影响性能，但对几十万行数据做 filesort 就很昂贵了。解决方案通常是设计能同时满足过滤和排序的索引（参考上一篇文章中"利用索引排序避免 filesort"的内容）。

#### 2.5.5 Using temporary（使用临时表）

```
Extra: Using temporary
```

表示 MySQL 需要创建临时表来处理查询，通常出现在 `GROUP BY`、`DISTINCT`、`UNION` 等需要去重或分组的操作中，且无法利用索引完成。

临时表优先在内存中创建（使用 [[Memory]] 引擎或 [[TempTable]] 引擎），但当数据量超过 `tmp_table_size` 或 `max_heap_table_size` 的较小值时，会转为磁盘临时表（使用 InnoDB 引擎），性能骤降。

**`Using temporary` 通常是比 `Using filesort` 更严重的性能信号**，因为临时表的创建和销毁本身就有开销，加上转磁盘的风险。

#### 2.5.6 Using join buffer（Block Nested Loop / Hash Join）

```
Extra: Using join buffer (hash join)
```

表示 JOIN 操作的被驱动表没有可用的索引，MySQL 使用了 **Join Buffer** 来加速。MySQL 8.0.18+ 在等值 JOIN 场景下默认使用 **Hash Join** 替代了早期的 Block Nested Loop（BNL）算法。

Hash Join 的工作方式：将较小表的关联列数据加载到内存中构建哈希表，然后扫描较大表的每一行，通过哈希查找匹配的关联行。虽然比没有任何优化的 Nested Loop 好很多，但**对被驱动表建立合适的索引仍然是首选方案**。

> [!note] 设计哲学
> `Extra` 列中出现多个标记的组合需要综合判断。例如 `Using where; Using filesort; Using temporary` 的组合意味着：数据先被过滤，再被写入临时表，最后在临时表上排序——这几乎总是需要优化的信号。而单独的 `Using where` 或单独的 `Using index` 通常不是问题。

---

## 第 3 章 高频慢查询模式与改写技巧

### 3.1 深分页问题：LIMIT 100000, 10 的性能灾难

这是线上系统中最常见的慢查询模式之一。前端的分页列表在翻到很后面的页码时，查询性能急剧下降。

```sql
-- 查询第 10001 页，每页 10 条
SELECT * FROM orders WHERE status = 1 ORDER BY created_at DESC LIMIT 100000, 10;
```

**为什么慢？** `LIMIT 100000, 10` 的语义是：先按 `ORDER BY` 排好序，跳过前 100000 行，然后取 10 行。MySQL 的执行方式是**先扫描并排序 100010 行，然后丢弃前 100000 行，只返回最后 10 行**。也就是说，100000 行的扫描和排序是完全浪费的。

即使有索引 `(status, created_at)`，MySQL 也需要沿着索引顺序扫描 100010 个索引记录，然后逐个回表——100010 次回表的随机 I/O 代价是巨大的。

#### 3.1.1 解法一：延迟关联（Deferred Join）

核心思想：先通过子查询只在索引上扫描，得到目标行的主键，再用主键回表取完整数据。这样子查询阶段是覆盖索引扫描（不回表），只有最终的 10 行才需要回表。

```sql
-- 延迟关联写法
SELECT o.* 
FROM orders o
INNER JOIN (
    SELECT id FROM orders WHERE status = 1 ORDER BY created_at DESC LIMIT 100000, 10
) AS t ON o.id = t.id;
```

子查询 `SELECT id FROM orders WHERE status = 1 ORDER BY created_at DESC LIMIT 100000, 10` 只需要扫描索引 `(status, created_at)` 的叶子节点（叶子节点中包含主键 `id`），这是一次纯索引扫描，不涉及回表。然后用得到的 10 个 `id` 去聚簇索引中精确查找——只回表 10 次。

在实测中，这种改写对于大偏移量的分页查询，**性能提升通常在 10 倍到 100 倍之间**。

#### 3.1.2 解法二：游标分页（Cursor-based Pagination）

从根本上避免 `LIMIT offset` 的问题：**不用偏移量，而是用上一页最后一条记录的值作为下一页的起始条件**。

```sql
-- 第一页
SELECT * FROM orders WHERE status = 1 ORDER BY created_at DESC LIMIT 10;
-- 假设最后一条记录的 created_at = '2026-02-28 10:30:00', id = 50000

-- 第二页（基于上一页的末尾值）
SELECT * FROM orders 
WHERE status = 1 
  AND (created_at < '2026-02-28 10:30:00' OR (created_at = '2026-02-28 10:30:00' AND id < 50000))
ORDER BY created_at DESC 
LIMIT 10;
```

这种方式每次查询都是从索引的某个精确位置开始扫描 10 行，**无论翻到多少页，性能都是恒定的**。

缺点是：无法直接跳到任意页码（"跳到第 500 页"这种操作无法实现）。但对于现代 App 的"无限滚动"加载模式，游标分页是最优方案。

### 3.2 子查询 vs JOIN：优化器的行为差异

MySQL 对子查询的优化经历了多个版本的改进，但在某些场景下，子查询的性能仍然远不如等价的 JOIN 写法。

#### 3.2.1 相关子查询的陷阱

```sql
-- 相关子查询：查找每个部门薪资最高的员工
SELECT * FROM employees e1
WHERE salary = (
    SELECT MAX(salary) FROM employees e2 WHERE e2.dept_id = e1.dept_id
);
```

**相关子查询**（Correlated Subquery）的特征是：子查询引用了外层查询的列（`e1.dept_id`）。这意味着子查询**不能独立执行**，必须对外层查询的每一行都执行一次子查询。如果外层 `employees` 表有 10 万行，子查询就要执行 10 万次——即使有索引，10 万次独立查询的开销也很可观。

改写为 JOIN：

```sql
-- 改写为 JOIN + 聚合
SELECT e.* FROM employees e
INNER JOIN (
    SELECT dept_id, MAX(salary) AS max_salary FROM employees GROUP BY dept_id
) AS t ON e.dept_id = t.dept_id AND e.salary = t.max_salary;
```

JOIN 写法中，子查询 `SELECT dept_id, MAX(salary)...` 只执行一次，生成一个临时结果集，然后与 `employees` 表做一次 JOIN。相比相关子查询的 10 万次执行，差距显而易见。

> [!warning] 生产避坑
> MySQL 8.0 的优化器已经能将某些相关子查询自动转换为 semi-join 或 materialization。但这种自动优化并不是在所有场景都会触发——特别是当子查询中包含 `GROUP BY`、`HAVING`、聚合函数等复杂结构时，优化器可能无法转换。**在性能敏感的查询中，手动改写为 JOIN 是更稳妥的选择。**

#### 3.2.2 IN 子查询的物化优化

```sql
-- IN 子查询
SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE age > 25);
```

在 MySQL 5.5 及更早版本中，这个 `IN` 子查询会被当作相关子查询来处理——对 `orders` 表的每一行，都执行一次子查询判断 `user_id` 是否在结果集中。MySQL 5.6+ 引入了**子查询物化（Materialization）**优化：先将子查询的结果集物化为一个临时表（带去重和索引），然后将 `IN` 操作转化为对这个临时表的 JOIN 查找。

但即使有物化优化，如果子查询的结果集很大，临时表的构建和 JOIN 查找的代价也不小。在明确知道需要优化的场景下，直接改写为 JOIN 更清晰：

```sql
-- 改写为 JOIN
SELECT o.* FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE u.age > 25;
```

### 3.3 COUNT 的性能陷阱

#### 3.3.1 COUNT(*) vs COUNT(1) vs COUNT(column)

这是一个广泛流传的"性能神话"：很多人认为 `COUNT(1)` 比 `COUNT(*)` 快。实际上，**MySQL 优化器对 `COUNT(*)` 和 `COUNT(1)` 的处理是完全相同的**——它们都是统计总行数，不存在性能差异。

但 `COUNT(column)` 的语义不同：它统计的是 `column` 列中**非 NULL 值的行数**。如果 `column` 允许 NULL，MySQL 需要逐行检查该列是否为 NULL，不能使用某些优化路径。

```sql
-- 这三个在语义上不同
SELECT COUNT(*)    FROM users;  -- 总行数
SELECT COUNT(1)    FROM users;  -- 总行数（与 COUNT(*) 等价）
SELECT COUNT(name) FROM users;  -- name 非 NULL 的行数
```

#### 3.3.2 大表 COUNT(*) 为什么慢

在 [[InnoDB]] 中，`COUNT(*)` 没有现成的行数缓存——不像 [[MyISAM]] 在表头维护了精确的行数。InnoDB 之所以不缓存行数，是因为 [[MVCC]] 机制下，不同事务在同一时刻看到的行数可能不同（有些行对当前事务不可见）。

InnoDB 在执行 `COUNT(*)` 时，会选择**最小的可用索引**来遍历（不一定是聚簇索引——二级索引的叶子节点更小，扫描更快），但仍然需要遍历所有叶子节点来计数。对于千万级的大表，这可能需要数秒甚至十几秒。

解决方案：

1. **缓存计数**：使用 [[Redis]] 维护一个近似的行数计数器，写入时同步增减
2. **专用计数表**：维护一张独立的计数表，在业务事务中同步更新
3. **`information_schema.TABLES` 的近似值**：`SELECT TABLE_ROWS FROM information_schema.TABLES WHERE ...` 返回的是 InnoDB 的统计估算值，不精确但速度极快，适合不需要精确值的场景

### 3.4 ORDER BY 优化

#### 3.4.1 双路排序 vs 单路排序

当 MySQL 无法利用索引完成排序时（`Using filesort`），它在内部有两种排序策略：

**双路排序（Two-Pass Sort）**：第一次扫描只读取排序键和行指针（RowID），在排序缓冲区中排好序，然后第二次扫描根据行指针回表取完整的行数据。这种方式排序缓冲区中每条记录很小，能排更多的行，但需要两次 I/O。

**单路排序（Single-Pass Sort）**：一次性读取查询所需的所有列数据到排序缓冲区中排序，排完直接返回。只需要一次 I/O，但排序缓冲区中每条记录很大，能排的行数更少。

MySQL 通过 `max_length_for_sort_data`（默认 4096 字节）来决定使用哪种策略：如果排序涉及的列总长度小于这个值，使用单路排序；否则使用双路排序。

> [!info] 核心概念
> 这两种排序策略的权衡本质是：**内存使用量 vs I/O 次数**。单路排序用更多内存换更少的 I/O，双路排序省内存但多一次 I/O。对于 SSD 环境，I/O 代价下降了，但内存竞争加剧了——所以现代实践中，适当增大 `sort_buffer_size` 并保持单路排序通常是更优选择。

#### 3.4.2 利用索引避免排序的条件

如果 `ORDER BY` 的列**与索引的列顺序完全一致**，且排序方向也一致（或在 MySQL 8.0+ 使用了降序索引），MySQL 可以直接沿着索引顺序读取数据，完全避免 filesort：

```sql
-- 索引 (status, created_at)

-- 可以利用索引排序 ✅
SELECT * FROM orders WHERE status = 1 ORDER BY created_at;

-- 无法利用索引排序 ❌（ORDER BY 的列不在索引中）
SELECT * FROM orders WHERE status = 1 ORDER BY amount;

-- 无法利用索引排序 ❌（WHERE 用了范围条件，created_at 在索引中的有序性被破坏）
SELECT * FROM orders WHERE status > 0 ORDER BY created_at;
```

### 3.5 JOIN 优化

#### 3.5.1 小表驱动大表原则

MySQL 的 Nested Loop JOIN 算法是：**从驱动表中取一行数据，到被驱动表中查找匹配的行**。循环的总次数 = 驱动表行数 × 被驱动表每次查找的代价。

因此，**让结果集更小的表作为驱动表**可以减少循环次数。当使用 `INNER JOIN` 时，优化器会自动选择较小的表作为驱动表。但使用 `LEFT JOIN` 时，左表强制作为驱动表——如果左表是大表，性能会很差。

```sql
-- 差的写法：大表 orders 作为驱动表
SELECT * FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE u.age > 25;
-- 注意：WHERE u.age > 25 实际上隐式将 LEFT JOIN 转换为 INNER JOIN

-- 好的写法：如果语义允许 INNER JOIN，让优化器自动选择驱动表
SELECT * FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE u.age > 25;
```

#### 3.5.2 被驱动表必须有索引

这是 JOIN 性能的**绝对底线**。如果被驱动表的关联列上没有索引，每次关联都要全表扫描被驱动表——10 行驱动表 × 100 万行全表扫描 = 1000 万次行比较。

```sql
-- 确保 orders.user_id 有索引！
EXPLAIN SELECT * FROM users u JOIN orders o ON o.user_id = u.id;
-- orders 表的 type 应该是 ref 或 eq_ref，而不是 ALL
```

---

## 第 4 章 调优实战：一个完整的优化案例

### 4.1 场景描述

电商系统的订单列表页，DBA 反馈有一条慢查询平均耗时 4.5 秒：

```sql
SELECT o.order_no, o.amount, o.status, o.created_at, u.name AS user_name
FROM orders o
LEFT JOIN users u ON o.user_id = u.id
WHERE o.shop_id = 8888
  AND o.status IN (1, 2)
  AND o.created_at >= '2026-01-01'
ORDER BY o.created_at DESC
LIMIT 20;
```

表信息：`orders` 表 800 万行，`users` 表 50 万行。

### 4.2 第一步：EXPLAIN 诊断

```
+----+-------------+-------+------+---------------+------+---------+------+---------+----------------------------------------------------+
| id | select_type | table | type | possible_keys | key  | key_len | ref  | rows    | Extra                                              |
+----+-------------+-------+------+---------------+------+---------+------+---------+----------------------------------------------------+
|  1 | SIMPLE      | o     | ALL  | NULL          | NULL | NULL    | NULL | 8000000 | Using where; Using temporary; Using filesort       |
|  1 | SIMPLE      | u     | eq_ref| PRIMARY      | PRIMARY| 8    | o.user_id| 1  | NULL                                               |
+----+-------------+-------+------+---------------+------+---------+------+---------+----------------------------------------------------+
```

**诊断结果**：
- `orders` 表 `type: ALL`，`rows: 8000000` → **全表扫描 800 万行**
- `Extra: Using where; Using temporary; Using filesort` → 过滤 + 临时表 + 排序，三重灾难
- `users` 表 `type: eq_ref` → 通过主键关联，这部分没问题

### 4.3 第二步：分析根因

`orders` 表上没有能满足 `shop_id + status + created_at` 组合查询的索引。MySQL 只能全表扫描后在 Server 层过滤、排序。

### 4.4 第三步：设计索引

分析查询条件：
- `shop_id = 8888`：等值条件，高选择性
- `status IN (1, 2)`：等值条件（IN），低选择性
- `created_at >= '2026-01-01'`：范围条件
- `ORDER BY created_at DESC`：排序

按照"等值列在前、范围列在后"的原则：

```sql
ALTER TABLE orders ADD INDEX idx_shop_status_time (shop_id, status, created_at);
```

### 4.5 第四步：验证效果

```
+----+-------------+-------+-------+----------------------+----------------------+---------+-----------+------+---------------------+
| id | select_type | table | type  | possible_keys        | key                  | key_len | ref       | rows | Extra               |
+----+-------------+-------+-------+----------------------+----------------------+---------+-----------+------+---------------------+
|  1 | SIMPLE      | o     | range | idx_shop_status_time | idx_shop_status_time | 17      | NULL      | 350  | Using index condition|
|  1 | SIMPLE      | u     | eq_ref| PRIMARY              | PRIMARY              | 8       | o.user_id | 1    | NULL                |
+----+-------------+-------+-------+----------------------+----------------------+---------+-----------+------+---------------------+
```

优化后：
- `type: range`（从 ALL 到 range）
- `rows: 350`（从 800 万到 350）
- `Extra: Using index condition`（ICP 生效）
- 执行时间：从 4.5 秒降至 **8 毫秒**

但注意这里有一个细节：`status IN (1, 2)` 相当于两个等值范围，MySQL 会对每个 status 值分别在索引上做范围扫描。由于 `created_at` 在 `status` 之后，每个 `status` 值内部 `created_at` 是有序的——所以 MySQL 可以利用索引的顺序来满足 `ORDER BY created_at DESC`，避免了 filesort。`Extra` 中没有 `Using filesort` 就是证据。

### 4.6 可以更进一步吗？

如果要消除回表，可以创建覆盖索引：

```sql
ALTER TABLE orders ADD INDEX idx_shop_status_time_cover 
    (shop_id, status, created_at, order_no, amount, user_id);
```

但这个索引包含了 6 个列，体积较大，写入维护成本也高。对于 LIMIT 20 的场景，回表 20 次的代价极低，**覆盖索引在这里的收益不大，反而增加了写入负担**——这就是工程权衡。

---

## 第 5 章 EXPLAIN FORMAT=TREE 与 EXPLAIN ANALYZE

### 5.1 TREE 格式：更直观的执行计划

MySQL 8.0.16+ 支持 `EXPLAIN FORMAT=TREE`，以缩进的树状结构展示执行计划：

```sql
EXPLAIN FORMAT=TREE
SELECT o.order_no, u.name
FROM orders o JOIN users u ON o.user_id = u.id
WHERE o.shop_id = 8888 AND o.status = 1
ORDER BY o.created_at DESC
LIMIT 10;
```

输出类似于：

```
-> Limit: 10 row(s)
    -> Nested loop inner join
        -> Index lookup on o using idx_shop_status_time (shop_id=8888, status=1) (reverse)
        -> Single-row index lookup on u using PRIMARY (id=o.user_id)
```

这种格式更容易看出执行计划的层级关系——最内层的操作先执行，结果向上流动。

### 5.2 EXPLAIN ANALYZE：真实执行数据

`EXPLAIN ANALYZE` 不仅显示执行计划，还会**实际执行查询**并记录每个操作的真实行数和耗时：

```
-> Limit: 10 row(s) (actual time=0.5..0.8 rows=10 loops=1)
    -> Nested loop inner join (actual time=0.5..0.78 rows=10 loops=1)
        -> Index lookup on o using idx_shop_status_time (actual time=0.3..0.5 rows=10 loops=1)
        -> Single-row index lookup on u using PRIMARY (actual time=0.02..0.02 rows=1 loops=10)
```

`actual time=0.3..0.5` 的两个数字分别是**获取第一行的时间**和**获取所有行的时间**（毫秒）。`rows=10` 是实际处理的行数，`loops=1` 是该操作被执行的次数。

对比 `rows`（预估）和 `actual rows`（实际），可以判断优化器的统计信息是否准确。如果差异巨大，应该执行 `ANALYZE TABLE` 更新统计信息。

---

## 第 6 章 小结

本文建立的 SQL 调优方法论可以总结为：

1. **EXPLAIN 是起点，不是终点**：读懂执行计划只是诊断的第一步，真正的优化在于根据诊断结果做出正确的改写或索引调整
2. **`type` 列是性能的第一道防线**：确保生产查询至少达到 `range` 级别
3. **`Extra` 列暗藏关键信号**：`Using filesort` + `Using temporary` 的组合通常意味着严重问题
4. **`key_len` 是联合索引的"温度计"**：通过字节数判断索引利用了几列
5. **深分页用延迟关联或游标分页**：永远不要依赖大偏移量的 `LIMIT offset`
6. **手动改写子查询为 JOIN**：在优化器不够智能时，人工保底
7. **小表驱动大表 + 被驱动表必须有索引**：这是 JOIN 性能的两条铁律

调优的本质不是"加索引"，而是**理解 MySQL 在做什么、为什么这样做、如何引导它做得更好**。`EXPLAIN` 是你与 MySQL 优化器之间的对话工具——学会读懂它的"话"，慢查询问题自然迎刃而解。
