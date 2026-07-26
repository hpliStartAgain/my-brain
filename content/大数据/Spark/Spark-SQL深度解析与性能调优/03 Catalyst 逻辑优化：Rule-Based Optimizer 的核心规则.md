---
title: "Catalyst 逻辑优化：Rule-Based Optimizer 的核心规则"
date: 2026-02-28
tags: [Catalyst, LogicalPlan, Optimizer, RBO, Spark, SparkSQL, 列裁剪, 子查询优化, 常量折叠, 谓词下推]
aliases: []
---

# 03 Catalyst 逻辑优化：Rule-Based Optimizer 的核心规则

## 摘要

Analyzed LogicalPlan 描述了"用户想要什么"，但它是按照用户写代码的顺序直接翻译的，并不一定是最高效的执行路径。逻辑优化阶段（Logical Optimization）的任务是：在**保持结果等价**的前提下，将计划变换为更高效的形式。这一阶段由 **Optimizer** 完成，核心是 **Rule-Based Optimizer（RBO，基于规则的优化器）**——一套由数十条等价变换规则组成的规则集，每条规则识别特定的计划模式并替换为等价但更优的形式。本文深度拆解 RBO 最重要的五类规则：**谓词下推（Predicate Pushdown）**、**列裁剪（Column Pruning）**、**常量折叠（Constant Folding）**、**子查询优化（Subquery Optimization）**、**Join 重排序（Join Reordering，属于 CBO 范畴但与 RBO 协作）**，通过大量 BEFORE / AFTER 对比示例，直观展示每条规则对执行计划的改变，以及规则失效的边界与反例。

---

## 第 1 章 RBO 的设计哲学与工作方式

### 1.1 等价变换：唯一的硬约束

逻辑优化的核心约束只有一条：**变换前后的查询结果必须完全等价**。无论做什么优化，用户看到的数据必须相同（相同的行、相同的列、相同的值）。

这个约束比听起来严苛得多。以"谓词下推"为例——将 `Filter` 节点从 `Join` 之后移到 `Join` 之前——虽然直觉上总是对的，但实际上有例外：对于 `LEFT OUTER JOIN`，右表的 Filter 不能下推到 Join 之前（下推会改变外连接的语义，漏掉右表不满足条件的行应该产生的 NULL 输出）。因此每条规则都必须精确描述自己的适用条件。

### 1.2 RBO 与 CBO 的分工

**RBO（Rule-Based Optimizer）**：基于规则的优化，规则是静态的等价变换，不依赖数据的统计信息。RBO 的优化结果是确定性的——相同的查询结构永远产生相同的优化结果，无论数据量大小。

**CBO（Cost-Based Optimizer）**：基于代价的优化，需要收集表的统计信息（行数、列 NDV、直方图），根据预估代价选择最优计划。CBO 的结果依赖统计信息的准确性，第 04 篇专门讲解。

在 Spark 的 `Optimizer` 中，RBO 规则和 CBO 规则共存：RBO 规则形成多个批次，CBO 规则单独形成 `CostBasedJoinReorder` 批次。两者在同一个 `Optimizer` 框架中顺序执行。

### 1.3 规则的执行次序与批次化

Spark 的 `Optimizer` 将规则组织为**批次（Batch）**，同一批次内的规则按顺序应用，批次之间也有先后顺序。

**为什么要分批次？**

因为某些规则有前提依赖。例如，`InferFiltersFromConstraints`（从约束推导过滤条件）必须在 `PushPredicateThroughJoin`（谓词下推过 Join）之后执行——只有先把谓词推下去，才能基于推下去的谓词推导出新的约束。

Spark 3.x 的 Optimizer 主要批次（简化）：

| 批次名 | 策略 | 典型规则 |
|--------|------|---------|
| `Eliminate Distinct` | Once | `EliminateDistinct` |
| `Finish Analysis` | Once | `EliminateSubqueryAliases`、`EliminateView` |
| `Union` | Once | `CombineUnions` |
| `Pullup Correlated Expressions` | Once | 相关子查询提取 |
| `Subquery` | Once | 子查询转化 |
| `Replace Operators` | FixedPoint | `ReplaceIntersectWithSemiJoin`、`ReplaceExceptWithAntiJoin` |
| `Aggregate` | FixedPoint | `RemoveLiteralFromGroupExpressions`、`RemoveRepetitionFromGroupExpressions` |
| `Operator Optimization before Inferring Filters` | FixedPoint | `PushPredicateThroughJoin`、`ColumnPruning`、`ConstantFolding` 等 |
| `Infer Filters` | Once | `InferFiltersFromConstraints` |
| `Operator Optimization after Inferring Filters` | FixedPoint | 与上一批次相同的规则（再次应用新推导出的过滤条件） |
| `Join Reorder` | Once | `CostBasedJoinReorder`（CBO） |
| `Eliminate Sorts` | Once | 消除不必要的排序 |
| `Decimal Optimizations` | FixedPoint | 精度优化 |

---

## 第 2 章 谓词下推（Predicate Pushdown）

### 2.1 是什么，为什么出现

**谓词（Predicate）** 在 SQL 中指 WHERE / ON / HAVING 子句中的过滤条件（即返回布尔值的表达式）。**谓词下推** 是将 Filter 节点从计划树的高处（靠近根节点）移动到尽量低的位置（靠近数据源叶节点）。

**为什么谓词越靠下越好？**

因为数据量在计划树中自底向上流动：叶节点（数据扫描）产生最多数据，根节点输出最少数据（最终结果）。过滤条件越靠近叶节点，数据被过滤得越早，后续的算子（Join、Aggregation、Sort）处理的数据量就越少。

**不做谓词下推会怎样？**

考虑一个典型场景：`large_table`（10 亿行）与 `small_table`（100 万行）做 Join，然后过滤 `large_table.ts > '2024-01-01'`（只保留最近 30 天，约 8000 万行）：

```sql
SELECT a.id, b.name
FROM large_table a
JOIN small_table b ON a.fk = b.id
WHERE a.ts > '2024-01-01'
```

**不做谓词下推**：先 Join 10 亿 × 100 万（代价极高），再过滤，最终只保留 8000 万行 Join 结果。

**做谓词下推**：先过滤 `large_table` 到 8000 万行，再 Join 8000 万 × 100 万（代价降低 91%）。

两者的计算代价差距可能是数十倍。

### 2.2 谓词下推的四个场景

**场景一：Filter 下推过 Project（列投影）**

规则：`PushPredicateThroughProject`

```
优化前：
Filter(amount > 100, Project([userId, amount], Scan(orders)))

优化后：
Project([userId, amount], Filter(amount > 100, Scan(orders)))
```

Filter 通过 Project 下推到 Scan 之前（前提：Filter 中引用的列在 Project 之前已存在）。这减少了 Project 处理的行数。

**场景二：Filter 下推过 Inner Join**

规则：`PushPredicateThroughJoin`

```sql
SELECT a.id, b.name
FROM large_table a, small_table b
WHERE a.fk = b.id
  AND a.ts > '2024-01-01'
  AND b.status = 'active'
```

优化前的计划（Filter 在 Join 之上）：
```
Filter(a.ts > '2024-01-01' AND b.status = 'active')
└── Join(a.fk = b.id)
    ├── Scan(large_table)
    └── Scan(small_table)
```

优化后（谓词下推到各自的数据源）：
```
Join(a.fk = b.id)
├── Filter(a.ts > '2024-01-01')
│   └── Scan(large_table)
└── Filter(b.status = 'active')
    └── Scan(small_table)
```

**关键判断逻辑**：将 Filter 条件中每个谓词分析其引用的列：
- 只引用左表列的谓词 → 下推到左子树
- 只引用右表列的谓词 → 下推到右子树
- 同时引用两表列的谓词（Join 条件本身）→ 保留在 Join 的连接条件中

**场景三：Filter 下推过 Union**

规则：`PushPredicateThroughSetOperator`

```sql
SELECT * FROM (
  SELECT id, amount FROM table_a
  UNION ALL
  SELECT id, amount FROM table_b
) WHERE amount > 100
```

优化后：
```sql
SELECT id, amount FROM table_a WHERE amount > 100
UNION ALL
SELECT id, amount FROM table_b WHERE amount > 100
```

Filter 被复制到 UNION 的每个分支，两个分支各自独立过滤，减少 UNION 需要合并的数据量。

**场景四：Filter 下推到数据源（Parquet/ORC 层面）**

规则：`PushDownPredicates`（物理规划层）

这是谓词下推的最终形态——将 Filter 条件不仅在逻辑计划中下推，还推入数据源本身（Parquet Row Group 过滤、ORC Bloom Filter、分区裁剪）。第 09 篇详解数据源层面的谓词下推。

### 2.3 谓词下推的边界：哪些情况不能下推

**边界一：LEFT OUTER JOIN 的右表谓词不能下推**

```sql
-- 外连接语义：左表所有行都保留，右表不匹配的行补 NULL
SELECT a.id, b.status
FROM a LEFT JOIN b ON a.id = b.aid
WHERE b.status = 'active'
```

**错误的下推**：把 `b.status = 'active'` 下推到 `b` 的扫描前 → 实际上把 LEFT JOIN 变成了 INNER JOIN（那些 b 表没有 `active` 记录的 a 行也被过滤掉了）

**正确行为**：这个条件不能下推，保留在 Join 之上。（注意：如果用 `INNER JOIN` 则可以下推；LEFT JOIN 的**右表**谓词在 WHERE 中相当于将外连接转为内连接，这是一个常见的语义陷阱）

**边界二：含非确定性函数的谓词不能下推**

`rand() > 0.5`、`uuid()` 等非确定性函数，每次调用结果不同。如果下推到 Scan 前执行，与在 Scan 后执行的语义可能不同（采样比例会变化）。

**边界三：含聚合结果的谓词（HAVING 子句）不能下推过 Aggregate**

`HAVING count(*) > 10` 中的 `count(*)` 是聚合结果，必须在 Aggregate 执行后才能计算，不能下推到 Aggregate 之前。

---

## 第 3 章 列裁剪（Column Pruning）

### 3.1 是什么，为什么出现

**列裁剪** 是从数据扫描阶段开始，只读取查询中实际用到的列，丢弃所有未使用的列。

**为什么列裁剪如此重要？**

现代大数据存储普遍使用**列式格式**（Parquet、ORC）。列式格式的数据按列存储——所有行的 `userId` 存在一起，所有行的 `amount` 存在一起。读取数据时，可以只读取需要的列，完全跳过其他列的 I/O。

如果一张表有 100 列，但查询只用到 3 列，列裁剪可以将 I/O 减少 97%，这是最直接的性能提升。

**不做列裁剪会怎样？**

读取全部 100 列 → 传输到 Executor → 在内存中持有 100 列的数据 → 后续算子处理 100 列 → 最终只用 3 列。97% 的 I/O、网络传输、内存占用全部浪费。

### 3.2 列裁剪的传播规则

规则：`ColumnPruning`

列裁剪的核心是：**每个算子只需要输出其父节点（以及更上层节点）实际引用的列**。优化器从根节点向叶节点传播"需要哪些列"的信息：

```sql
SELECT userId, SUM(amount) as total
FROM orders
WHERE ts > '2024-01-01'
GROUP BY userId
```

这张表有 `(userId, amount, ts, category, source, ip, ua, ...)` 共 20 列。

**列裁剪传播过程**：

1. **根节点 `Project([userId, total])`**：只需要 `userId`、`SUM(amount)`
2. **`Aggregate([userId], [SUM(amount)])`**：需要 `userId`（GROUP BY）、`amount`（SUM 参数）
3. **`Filter(ts > '2024-01-01')`**：需要 `ts`（Filter 条件），以及向上传递的 `userId`、`amount`
4. **`Scan(orders)`**：只需要 `[userId, amount, ts]` 三列，其余 17 列不读取

优化后的计划中，Scan 节点的 `requiredSchema` 只包含 3 列，Parquet 读取时只读这 3 列的数据。

### 3.3 Project 的合并与消除

列裁剪过程中，有时会引入额外的 `Project` 节点（在算子之间插入 Project 以限制列集）。Optimizer 随后通过 `CollapseProject` 规则合并相邻的 Project 节点，消除冗余投影：

```
优化前（多层 Project 嵌套）：
Project([a, b])
└── Project([a, b, c])
    └── Scan(table)

CollapseProject 优化后：
Project([a, b])
└── Scan(table)

再次列裁剪后：
Scan(table, requiredColumns=[a, b])
```

---

## 第 4 章 常量折叠（Constant Folding）与表达式简化

### 4.1 常量折叠

**常量折叠** 是在编译（优化）阶段计算所有可以提前确定结果的表达式，避免在运行时对每一行重复计算。

规则：`ConstantFolding`

```scala
// 优化前
Filter(year(current_date()) == 2024 AND amount > 100 + 50, Scan(orders))

// 优化后（常量计算在优化阶段完成）
Filter(true AND amount > 150, Scan(orders))
// → 进一步简化：
Filter(amount > 150, Scan(orders))
```

`year(current_date())` 在优化时确定为 `2024`（`IntegerLiteral(2024)`）；`100 + 50` 折叠为 `150`。这两个计算原本会对每一行重复执行（比如 10 亿行就重复 10 亿次），折叠后只计算一次。

**哪些表达式可以折叠**：
- 纯数值运算：`1 + 2`、`3 * 4`
- 常量时间函数：`current_date()`、`now()`（每次查询执行时固定）
- 字符串常量操作：`upper('hello')` → `'HELLO'`
- 逻辑运算：`true AND x` → `x`；`false OR x` → `x`

**哪些不能折叠**：
- 非确定性函数：`rand()`、`uuid()`（每行结果不同）
- 依赖输入数据的表达式：`upper(name)`（`name` 是每行不同的）

### 4.2 Boolean 表达式简化

规则：`BooleanSimplification`

```scala
// true AND x → x
Filter(Literal(true) && amount > 100, Scan)
→ Filter(amount > 100, Scan)

// false AND x → false（整个 Filter 为假，等价于返回空集）
Filter(Literal(false) && amount > 100, Scan)
→ Filter(Literal(false), Scan)
→ LocalRelation(emptyOutput)  // 直接返回空结果，不做任何扫描

// x OR true → true（整个 Filter 为真，等价于不过滤）
Filter(amount > 100 || Literal(true), Scan)
→ Scan  // 直接去掉 Filter 节点
```

`Filter(Literal(false), Scan)` 被进一步优化为 `LocalRelation`（空结果）——Spark 不会执行任何真实的数据扫描，直接返回空。这在处理动态分区裁剪（Dynamic Partition Pruning）失败的场景中很常见。

### 4.3 空值传播（Null Propagation）

规则：`NullPropagation`

SQL 的三值逻辑（TRUE / FALSE / NULL）使得 `NULL` 在运算中有特殊行为：大多数算术和比较运算遇到 `NULL` 返回 `NULL`。Optimizer 利用这一点做静态优化：

```scala
// NULL + x → NULL（不需要运行时计算）
Add(Literal(null, IntegerType), column) → Literal(null, IntegerType)

// NULL > 100 → NULL → 在 Filter 中等价于 false（NULL 不通过 Filter）
Filter(null_column > 100, Scan) → Filter(false, Scan) → LocalRelation
```

---

## 第 5 章 子查询优化

### 5.1 子查询的分类

SQL 中的子查询按位置和相关性分类：

**按位置**：
- **标量子查询（Scalar Subquery）**：在 SELECT 列表中，返回单个值
- **谓词子查询**：在 WHERE/HAVING 中，用于 `IN`、`EXISTS`、比较运算

**按相关性**：
- **非相关子查询（Non-correlated）**：子查询不引用外层查询的列，可以独立执行
- **相关子查询（Correlated）**：子查询引用外层查询的列，对外层的每一行都要执行一次

相关子查询是性能杀手——如果外层有 1000 万行，相关子查询就要执行 1000 万次。Optimizer 的目标是将其转化为 Join（只需执行一次）。

### 5.2 IN 子查询 → Semi Join

规则：`RewritePredicateSubquery`

```sql
-- IN 子查询（常见写法）
SELECT * FROM orders
WHERE userId IN (SELECT userId FROM vip_users)
```

**Optimizer 将其转化为 LEFT SEMI JOIN**：
```sql
-- 等价变换
SELECT orders.* FROM orders
LEFT SEMI JOIN vip_users ON orders.userId = vip_users.userId
```

**为什么要转为 Join？**

- `IN` 子查询原本的语义是：对 `orders` 中的每一行，检查其 `userId` 是否在 `vip_users` 的结果集中。如果 `vip_users` 有 100 万行，最坏情况下需要 100 万次查找。
- LEFT SEMI JOIN 将 `vip_users` 构建一次 Hash Table，然后用 `orders` 的每一行去 probe，总体只需 O(1) 的 Hash 查找（假设 Hash Join），比嵌套循环快数个量级。

**LEFT SEMI JOIN 的语义**：对于左表（`orders`）的每一行，如果右表（`vip_users`）中存在满足连接条件的行，则输出该左表行，且只输出一次（不重复）。这与 `IN` 的语义完全等价。

### 5.3 NOT IN 子查询 → Anti Join

```sql
-- NOT IN 子查询
SELECT * FROM orders
WHERE userId NOT IN (SELECT userId FROM blocked_users)
```

**Optimizer 转化为 LEFT ANTI JOIN**：
```sql
SELECT orders.* FROM orders
LEFT ANTI JOIN blocked_users ON orders.userId = blocked_users.userId
```

**LEFT ANTI JOIN**：对于左表的每一行，如果右表中**不存在**满足连接条件的行，则输出该行。等价于 `NOT IN` 或 `NOT EXISTS`。

> [!warning] 生产避坑
> `NOT IN` 在右表有 NULL 值时有特殊语义陷阱：如果 `blocked_users.userId` 包含 NULL，`orders.userId NOT IN (NULL, ...)` 会对所有行返回 `NULL`（而非 TRUE），导致整个 NOT IN 过滤不返回任何行！这是 SQL 三值逻辑的陷阱，生产中应优先使用 `NOT EXISTS` 或 `LEFT ANTI JOIN`（它们在 NULL 处理上更安全）。Catalyst 在生成 Anti Join 时会考虑 NULL 语义，但用户需要理解这个陷阱。

### 5.4 EXISTS / NOT EXISTS 子查询 → Semi / Anti Join

```sql
-- EXISTS（转为 SEMI JOIN，与 IN 子查询优化结果相同）
SELECT * FROM orders o
WHERE EXISTS (SELECT 1 FROM vip_users v WHERE v.userId = o.userId)

-- NOT EXISTS（转为 ANTI JOIN）
SELECT * FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM blocked_users b WHERE b.userId = o.userId)
```

`EXISTS` 和 `IN` 的转化路径相同，最终都产生 `SemiJoin`（物理层再根据大小选 BroadcastHash 或 SortMerge）。

### 5.5 标量子查询优化

标量子查询出现在 SELECT 列表中：

```sql
SELECT 
  userId,
  amount,
  (SELECT AVG(amount) FROM orders) AS avg_amount  -- 标量子查询
FROM orders
```

如果子查询是**非相关**的（不引用外层列），Optimizer 将其提取为独立执行，缓存结果，避免对每一行重复计算：

```
Project([userId, amount, avg_amount#scalar_subquery])
└── Scan(orders)

Scalar Subquery: SELECT AVG(amount) FROM orders → 单独执行一次，结果作为常量注入
```

如果子查询是**相关**的（引用外层列），就无法独立提取，但 Optimizer 仍会尝试通过装饰关联（`RewriteCorrelatedScalarSubquery`）将其转化为 Join + 聚合，避免逐行执行：

```sql
-- 相关标量子查询（对每个 userId 计算该用户的平均金额）
SELECT userId, amount,
  (SELECT AVG(o2.amount) FROM orders o2 WHERE o2.userId = o1.userId) AS user_avg
FROM orders o1
```

转化为：
```sql
SELECT o1.userId, o1.amount, agg.user_avg
FROM orders o1
LEFT JOIN (
  SELECT userId, AVG(amount) AS user_avg
  FROM orders
  GROUP BY userId
) agg ON o1.userId = agg.userId
```

这样聚合只执行一次（扫描一次 orders 表），而不是对 o1 的每一行执行一次。

---

## 第 6 章 其他重要优化规则

### 6.1 消除冗余算子

**EliminateDistinct**：在 `DISTINCT` 与 `GROUP BY` 同时存在且 GROUP BY key 包含所有 SELECT 列时，消除 DISTINCT（GROUP BY 已经保证唯一性）：

```sql
-- 冗余的 DISTINCT
SELECT DISTINCT userId, MIN(amount)
FROM orders
GROUP BY userId
-- 等价于（去掉 DISTINCT，GROUP BY 已保证 userId 唯一）
SELECT userId, MIN(amount) FROM orders GROUP BY userId
```

**EliminateSorts**：消除不必要的排序：
- `SORT BY` 后接 `LIMIT 0` → 消除排序（结果为空集）
- 输出不保证顺序的算子后的 `ORDER BY`，如果后续有 Hash Aggregation → 消除 ORDER BY（聚合不关心输入顺序）

**RemoveRedundantAliases**：消除不改变列名的别名：`SELECT a AS a FROM t` → `SELECT a FROM t`

### 6.2 合并 Union 操作

规则：`CombineUnions`

```sql
-- 多层嵌套 Union
(SELECT * FROM a) UNION ALL (SELECT * FROM b) UNION ALL (SELECT * FROM c)
```

**优化前**：两层嵌套 Union 节点（先合并 a 和 b，再与 c 合并）

**优化后**：单层 Union 节点（三个子节点并列），可以并行读取三个数据源

### 6.3 分区裁剪（Partition Pruning）

规则：`PruneFileSourcePartitions`

对于分区表（如按 `dt`、`country` 分区的 Hive 表），当 Filter 条件包含分区列时，可以直接跳过不相关的分区目录，避免读取：

```sql
SELECT * FROM events WHERE dt = '2024-01-15' AND country = 'CN'
-- 只读取 dt=2024-01-15/country=CN/ 下的数据文件
-- 跳过所有其他分区目录（可能节省 99% 的 I/O）
```

分区裁剪在逻辑优化阶段确定裁剪范围，在物理扫描阶段执行实际过滤。

---

## 第 7 章 自定义优化规则

### 7.1 为什么需要自定义规则

内置的 Optimizer 规则覆盖了通用 SQL 优化场景，但业务系统有时需要针对特定业务场景的优化：

- **数据脱敏规则**：自动检测查询中对敏感列（如手机号、身份证号）的访问，自动插入脱敏函数
- **缓存注入规则**：检测到某张"维度表"被频繁读取，自动将其替换为内存缓存版本
- **分片路由规则**：将特定查询重定向到不同的数据源分片

### 7.2 实现自定义 Rule

```scala
import org.apache.spark.sql.catalyst.plans.logical.LogicalPlan
import org.apache.spark.sql.catalyst.rules.Rule
import org.apache.spark.sql.catalyst.expressions._
import org.apache.spark.sql.catalyst.plans.logical._

// 自动将敏感列的访问替换为脱敏版本
object MaskSensitiveColumns extends Rule[LogicalPlan] {
  
  val sensitiveColumns = Set("phone", "id_card", "email")
  
  override def apply(plan: LogicalPlan): LogicalPlan = plan.transformAllExpressionsUp {
    case attr: AttributeReference if sensitiveColumns.contains(attr.name.toLowerCase) =>
      // 将敏感列的引用替换为 mask(column) 函数调用
      Alias(
        ScalaUDF(maskFunction _, StringType, Seq(attr), ...),
        attr.name
      )(exprId = attr.exprId)
  }
}

// 注册自定义规则
val spark = SparkSession.builder()
  .withExtensions { extensions =>
    extensions.injectOptimizerRule(_ => MaskSensitiveColumns)
  }
  .getOrCreate()
```

**注意事项**：
- 自定义规则在内置规则之后执行（追加到最后一个批次）
- 规则必须是**等价变换**（改变了脱敏场景的输出，这本来就是业务需求，不是真正意义上的等价）
- 规则的 `apply` 方法可能被多次调用（FixedPoint 迭代），需要保证幂等性

---

## 小结

Catalyst 的 Rule-Based Optimizer 通过数十条精心设计的等价变换规则，系统性地将用户的"原始查询意图"转化为更高效的执行计划：

- **谓词下推（Predicate Pushdown）**：Filter 越靠近数据源越好，最大化早期过滤的效果；边界是 OUTER JOIN 语义、非确定性函数、含聚合结果的谓词
- **列裁剪（Column Pruning）**：只读取查询实际需要的列，在列式存储格式（Parquet/ORC）上带来数倍 I/O 节省；由根节点向叶节点传播"需要哪些列"的信息
- **常量折叠（Constant Folding）**：编译时计算常量表达式，消除运行时的重复计算；`false AND x` 可使整个 Filter 消失，避免扫描
- **子查询优化**：`IN` → Semi Join，`NOT IN` → Anti Join，`EXISTS` → Semi Join，相关标量子查询 → Left Join + 聚合，将嵌套执行变为并行执行
- **分区裁剪**：分区列谓词直接过滤文件系统目录，跳过无关分区的全部 I/O

第 04 篇将进入 CBO（代价模型）的世界：当 RBO 无法确定哪种执行顺序更优时（如多表 Join 的连接顺序），如何通过收集统计信息、建立代价模型，让优化器自动选出最优方案。

---

> [!note] 思考题
> 1. 谓词下推（Predicate Pushdown）在遇到 `LEFT OUTER JOIN` 右表的过滤条件时，无法下推到 Join 之前。这是为什么？如果强行下推会导致什么语义错误？
> 2. Catalyst 的 RBO 规则是无状态的等价变换，不依赖数据统计信息。那么"列裁剪"规则是否也属于纯等价变换？在涉及 `SELECT *` 加上 UDF 的场景下，列裁剪是否可能裁掉"看起来不需要"但实际有副作用的列？
> 3. 子查询优化将 `IN` 子查询转化为 Semi Join。但对于 `NOT IN` 含 NULL 值的情况，SQL 标准规定的三值逻辑（TRUE/FALSE/UNKNOWN）与 Anti Join 的处理方式存在细微差异。Spark 是如何正确处理这个语义陷阱的？

## 参考资料

- [Catalyst Optimizer in Spark SQL（waitingforcode.com）](https://www.waitingforcode.com/apache-spark-sql/catalyst-optimizer-in-spark-sql/read)
- [Spark SQL Optimization – Understanding the Catalyst Optimizer（data-flair.training）](https://data-flair.training/blogs/spark-sql-optimization/)
- Michael Armbrust 等：Spark SQL: Relational Data Processing in Spark（SIGMOD 2015）
- Apache Spark 源码：`org.apache.spark.sql.catalyst.optimizer.Optimizer`
- Apache Spark 源码：`org.apache.spark.sql.catalyst.optimizer.expressions.scala`（常量折叠、空值传播等规则）
- Apache Spark 源码：`org.apache.spark.sql.catalyst.optimizer.subquery.scala`（子查询优化规则）
- Apache Spark 源码：`org.apache.spark.sql.catalyst.optimizer.joins.scala`（Join 相关规则）
