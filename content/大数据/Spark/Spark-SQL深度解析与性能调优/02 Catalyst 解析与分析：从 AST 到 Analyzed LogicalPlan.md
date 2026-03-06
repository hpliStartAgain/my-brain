---
title: "Catalyst 解析与分析：从 AST 到 Analyzed LogicalPlan"
date: 2026-02-28
tags: [Spark, SparkSQL, Catalyst, Parser, Analyzer, AST, LogicalPlan, Catalog, Antlr4, Resolution]
aliases: []
---

# 02 Catalyst 解析与分析：从 AST 到 Analyzed LogicalPlan

## 摘要

一条 SQL 字符串进入 Spark SQL 引擎，第一关是"把文字变成树"，第二关是"把树中的哑引用变成有意义的属性"。这两关分别由 **Parser（解析器）** 和 **Analyzer（分析器）** 完成，对应执行管道的前两个阶段。Parser 基于 Antlr4 构建语法解析器，将 SQL 文本转化为 **Unresolved LogicalPlan**——一棵节点全是"未解析引用"的 AST 树。Analyzer 对接 **Catalog**（元数据中心），通过一批**规则（Rule）**将未解析的列名、表名、函数名逐一"解析"为有类型、有来源的 `Attribute`，产出 **Analyzed LogicalPlan**。本文深度拆解这两个阶段的内部工作原理：Antlr4 语法文件如何定义 SQL 方言、解析过程中的 Visitor 模式、`Unresolved` 系列节点的语义、Analyzer 的批次化规则引擎、Catalog 的架构与 Hive Metastore 集成，以及分析阶段最容易遇到的错误类型与诊断方法。

---

## 第 1 章 为什么需要两个独立阶段

### 1.1 解析与分析的本质区别

在编译器理论中，将"语法分析"与"语义分析"分为两个阶段是经典的设计：

**解析（Parse）是纯语法层面的工作**：判断一段文本是否符合语言的语法规则，将其转化为结构化的树型表示。这个过程不需要知道"这张表有没有 `amount` 列"，只需要知道 "`SELECT a FROM t WHERE b > 1`" 在语法上是一个合法的查询结构。

**分析（Analyze）是语义层面的工作**：在语法正确的基础上，进一步确认语义的合法性——这张表存在吗？`amount` 列在哪个表里？它是 `DoubleType` 还是 `StringType`？`SUM` 函数能接受 `StringType` 吗？

**为什么要分离？**

如果把解析和分析合并为一步，就必须在解析 SQL 文本的同时访问 Catalog（元数据），这带来两个问题：

1. **性能问题**：Catalog 访问通常涉及网络 I/O（查询 Hive Metastore），如果在解析阶段就触发 Catalog 查询，会在文本解析这个轻量操作中引入网络延迟
2. **缓存失效**：相同的 SQL 文本可以缓存解析结果（AST），但分析结果不能缓存（表 Schema 可能变化）。两阶段分离后，AST 缓存可以独立管理

更深层的设计原因：**Parser 是上下文无关（Context-Free）的，Analyzer 是上下文敏感（Context-Sensitive）的**。上下文无关的解析器可以用形式化语法完整描述，工具生成（Antlr4）；上下文敏感的语义分析必须依赖运行时状态（Catalog），无法用形式化方法完整描述。两种方法论完全不同，自然应该分阶段处理。

---

## 第 2 章 解析阶段：Antlr4 与 SQL 方言

### 2.1 Antlr4 是什么

**[[Antlr4]]（Another Tool for Language Recognition，v4）** 是业界广泛使用的解析器生成工具。开发者编写**语法文件**（`.g4` 格式），描述语言的词法规则（Token）和语法规则（Grammar），Antlr4 自动生成对应的 Lexer（词法分析器）和 Parser（语法分析器）代码。

Spark SQL 的语法文件位于：
`sql/catalyst/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBase.g4`

这个文件定义了 Spark SQL 支持的全部 SQL 方言（包括 ANSI SQL 标准语法 + Spark 扩展语法，如 `LATERAL VIEW`、`DISTRIBUTE BY`、`SORT BY`、`TRANSFORM`、`PIVOT` 等）。

### 2.2 词法分析：从字符流到 Token 流

解析的第一步是**词法分析**（Lexing）：将 SQL 字符串拆分为有意义的最小单元（Token）。

对于 `SELECT userId, SUM(amount) FROM orders WHERE amount > 100`：

| Token 类型 | Token 值 |
|-----------|---------|
| `KW_SELECT` | `SELECT` |
| `IDENTIFIER` | `userId` |
| `COMMA` | `,` |
| `IDENTIFIER` | `SUM` |
| `LEFT_PAREN` | `(` |
| `IDENTIFIER` | `amount` |
| `RIGHT_PAREN` | `)` |
| `KW_FROM` | `FROM` |
| `IDENTIFIER` | `orders` |
| `KW_WHERE` | `WHERE` |
| `IDENTIFIER` | `amount` |
| `GREATER_THAN` | `>` |
| `INTEGER_VALUE` | `100` |

Antlr4 生成的 `SqlBaseLexer` 按照 `SqlBase.g4` 中定义的词法规则（正则表达式匹配），将字符流转为 Token 流，传递给语法分析器。

### 2.3 语法分析：从 Token 流到语法树（CST）

**语法分析**（Parsing）将 Token 流按照语法规则组合为**具体语法树（Concrete Syntax Tree，CST）**。Antlr4 生成的 `SqlBaseParser` 执行这个过程。

CST 紧密对应语法规则，每个语法规则对应一类节点。例如 `SqlBase.g4` 中的一个片段（简化）：

```antlr
// 查询语句的语法规则
query
    : ctes? queryTerm queryOrganization     # 带 CTE 的查询
    ;

queryTerm
    : queryPrimary                           # 简单查询
    | queryTerm UNION (ALL|DISTINCT)? queryTerm  # UNION 查询
    ;

queryPrimary
    : selectClause fromClause whereClause? groupByClause? havingClause?
    ;

selectClause
    : SELECT namedExpression (',' namedExpression)*
    ;
```

语法树中每个节点都是 Antlr4 自动生成的类（如 `QueryContext`、`SelectClauseContext`），包含其子节点和匹配的 Token。

### 2.4 Visitor 模式：从 CST 到 Unresolved LogicalPlan

Antlr4 支持两种遍历 CST 的方式：**Listener 模式**（回调通知）和 **Visitor 模式**（主动访问，有返回值）。Spark 使用 **Visitor 模式**，因为需要从子节点的结果构建父节点（自底向上构建逻辑计划树）。

Spark 的 `AstBuilder` 类继承 Antlr4 生成的 `SqlBaseBaseVisitor`，重写每个语法规则对应的 `visit*` 方法，将 CST 节点转化为 Catalyst 的 LogicalPlan 节点：

```scala
// AstBuilder 中的部分方法（简化示意）

// 处理 SELECT 子句
override def visitSelectClause(ctx: SelectClauseContext): Seq[NamedExpression] = {
  ctx.namedExpression().map(visitNamedExpression)
}

// 处理 WHERE 子句 → 生成 Filter 节点
override def visitWhereClause(ctx: WhereClauseContext): Expression = {
  expression(ctx.booleanExpression())
}

// 处理完整查询 → 组装 Project/Filter/Aggregate 等节点
override def visitQuerySpecification(ctx: QuerySpecificationContext): LogicalPlan = {
  val from: LogicalPlan = visitFromClause(ctx.fromClause())
  val where: Option[Expression] = ctx.whereClause().map(visitWhereClause)
  val withFilter = where.map(Filter(_, from)).getOrElse(from)
  // 后续处理 GROUP BY、HAVING、SELECT ...
}
```

这个 Visitor 的输出就是 **Unresolved LogicalPlan**：一棵包含 `UnresolvedRelation`、`UnresolvedAttribute`、`UnresolvedFunction` 等未解析节点的树。

### 2.5 Unresolved 系列节点的语义

"Unresolved"意味着节点携带的只是字符串标识符，尚未对应到具体的元数据：

| 节点类型 | 含义 | 携带信息 | 解析后变为 |
|---------|------|---------|----------|
| `UnresolvedRelation` | 一张表或视图 | 表名（字符串） | `HiveTableRelation` 或 `LogicalRelation` |
| `UnresolvedAttribute` | 一列 | 列名（字符串，可能含前缀如 `a.id`） | `AttributeReference`（含 `exprId`、类型） |
| `UnresolvedFunction` | 一个函数调用 | 函数名、参数列表 | `AggregateExpression`、`ScalarSubquery` 等 |
| `UnresolvedStar` | `SELECT *` | 可选的表前缀 | 展开为所有列的 `AttributeReference` 列表 |
| `UnresolvedAlias` | 一个别名 | 表达式 + 可选别名字符串 | `Alias`（含确定的输出列名） |

---

## 第 3 章 分析阶段：Analyzer 的规则引擎

### 3.1 Analyzer 的整体结构

`Analyzer` 是 Spark SQL 分析阶段的核心，继承自 `RuleExecutor[LogicalPlan]`。`RuleExecutor` 是 Catalyst 规则引擎的基类，提供批次化的规则执行机制：

```scala
abstract class RuleExecutor[TreeType <: TreeNode[_]] {
  // 规则批次的定义（子类重写）
  protected def batches: Seq[Batch]

  // 对计划执行所有规则批次
  def execute(plan: TreeType): TreeType = {
    var curPlan = plan
    batches.foreach { batch =>
      val batchStartPlan = curPlan
      var iteration = 1
      var lastPlan = curPlan
      var continue = true

      while (continue) {
        curPlan = batch.rules.foldLeft(curPlan) { case (plan, rule) =>
          rule(plan)  // 对整棵树应用规则
        }
        iteration += 1
        // 如果计划不再变化（固定点），或达到最大迭代次数，退出
        continue = !(curPlan fastEquals lastPlan) && iteration <= batch.strategy.maxIterations
        lastPlan = curPlan
      }
    }
    curPlan
  }
}
```

**批次（Batch）**：多条规则的有序集合，每个批次有一个执行策略（`Once` 或 `FixedPoint`）：
- `Once`：批次内规则只执行一遍
- `FixedPoint`：批次内规则反复执行，直到计划不再变化（达到固定点），保证所有可以应用的规则都被应用

### 3.2 Analyzer 的核心规则批次

Spark 3.x 的 `Analyzer` 中定义了约 10 个批次，每个批次负责一类分析工作：

**Batch 1：Substitution（替换）**
- `CTESubstitution`：将 CTE（WITH 子句）定义内联展开
- `WindowsSubstitution`：处理窗口函数的 WINDOW 子句引用

**Batch 2：Resolution（核心解析，FixedPoint）**
这是最重要的批次，包含大量规则，反复执行直到所有引用都被解析：

- `ResolveRelations`：将 `UnresolvedRelation` 解析为具体的 `LogicalRelation`（查 Catalog）
- `ResolveReferences`：将 `UnresolvedAttribute` 解析为 `AttributeReference`（匹配列到来源表）
- `ResolveFunctions`：将 `UnresolvedFunction` 解析为具体的函数实现（查函数注册表）
- `ResolveAliases`：处理 SELECT 列表中的别名
- `ResolveSubquery`：解析子查询（包括相关子查询的外部引用）
- `ResolveGroupingAnalytics`：解析 `GROUPING SETS`、`ROLLUP`、`CUBE`
- `ImplicitTypeCasts`：对函数参数做隐式类型转换（如将 `IntegerType` 转为 `LongType`）

**Batch 3：Post-Hoc Resolution**
- `ResolveNaturalAndUsingJoin`：解析 `NATURAL JOIN` 和 `USING` 连接条件
- `ResolveOutputRelation`：解析 INSERT INTO 的目标表 Schema

**Batch 4：Nondeterministic**
- 将非确定性表达式（如 `rand()`）提取出来，避免重复求值

**Batch 5：UDF（用户自定义函数）**

**Batch 6：Cleanup（清理）**
- `CleanupAliases`：删除不必要的别名节点

### 3.3 Resolution 规则的工作细节

以最核心的 `ResolveReferences` 规则为例，详细讲解属性解析的过程：

**场景**：`orders` 表有 `(userId: StringType, amount: DoubleType, ts: TimestampType)` 三列。

**输入**（Unresolved LogicalPlan 片段）：
```
Filter(UnresolvedAttribute("amount") > Literal(100), UnresolvedRelation("orders"))
```

**`ResolveRelations` 执行后**（`UnresolvedRelation` 被解析）：
```
Filter(
  UnresolvedAttribute("amount") > Literal(100),
  LogicalRelation(
    HiveTableRelation("orders"),
    output = [userId#1: StringType, amount#2: DoubleType, ts#3: TimestampType]
  )
)
```

注意：每个 `AttributeReference` 都被分配了一个唯一的 `exprId`（如 `#1`、`#2`、`#3`），在整个查询中唯一标识这个属性，避免同名列的混淆。

**`ResolveReferences` 执行后**（`UnresolvedAttribute` 被解析）：
```
Filter(
  amount#2 > Literal(100),  // amount → amount#2: DoubleType
  LogicalRelation(...)
)
```

`ResolveReferences` 的匹配逻辑：
1. 遍历当前节点的 child 节点的输出属性列表（`child.output`）
2. 找到名字匹配的 `AttributeReference`
3. 将 `UnresolvedAttribute` 替换为找到的 `AttributeReference`

如果 `UnresolvedAttribute` 是带限定符的（如 `orders.amount`），则同时匹配表名和列名。

### 3.4 固定点迭代的必要性

`Resolution` 批次使用 `FixedPoint` 的原因：**多个规则之间有依赖关系，需要反复执行才能完全解析**。

典型场景：子查询中的相关引用。

```sql
SELECT userId, 
       (SELECT SUM(o2.amount) FROM orders o2 WHERE o2.userId = o1.userId) AS total
FROM orders o1
```

**迭代 1**：`ResolveRelations` 解析 `orders o1` → `LogicalRelation(output=[userId#1, ...])`，但内层子查询中的 `o1.userId` 仍未解析（内层查询独立解析时看不到外层的 `o1`）

**迭代 2**：`ResolveSubquery` 将外层属性传入内层，内层 `o1.userId` 被解析为 `userId#1`（外部引用）

**迭代 3**：验证整棵树所有引用都已解析，不再变化，退出循环

如果使用 `Once` 策略，第一次迭代后子查询中的外部引用还未解析，分析结果不完整。

---

## 第 4 章 Catalog：元数据的基础设施

### 4.1 Catalog 的职责

**Catalog** 是 Spark SQL 的元数据中心，负责管理：
- 数据库（Database）列表
- 表（Table）和视图（View）的定义（Schema、存储格式、分区、位置）
- 列统计信息（用于 CBO）
- 函数（内置函数 + UDF/UDAF/UDTF）注册表
- 临时表（Temporary View）和全局临时表（Global Temporary View）

Spark 的 Catalog 架构是**分层的**：

```
ExternalCatalog（接口）
    ├── HiveExternalCatalog（对接 Hive Metastore）← 生产最常用
    ├── InMemoryCatalog（纯内存，用于测试）
    └── 第三方实现（AWS Glue Catalog、Unity Catalog 等）

SessionCatalog（会话级封装）
    ├── 管理临时表（会话级，不持久化）
    ├── 管理全局临时表（跨 Session，存在 global_temp 数据库下）
    └── 代理 ExternalCatalog 的持久化表操作
```

### 4.2 Hive Metastore 集成

在生产环境中，几乎所有 Spark SQL 应用都对接 **[[Hive Metastore]]** 作为持久化 Catalog。Hive Metastore 是一个独立的服务（通常基于 MySQL 或 PostgreSQL），存储所有表的元数据。

**Spark 读取 Hive 表的流程**：

1. Analyzer 执行 `ResolveRelations`，遇到 `UnresolvedRelation("orders")`
2. 调用 `SessionCatalog.lookupRelation("orders")`
3. `SessionCatalog` 先查本地临时表（没有），再调用 `HiveExternalCatalog.getTable("default", "orders")`
4. `HiveExternalCatalog` 通过 Hive Metastore Client 向 Hive Metastore 服务发送 Thrift RPC
5. Hive Metastore 返回表的 `CatalogTable`（包含 Schema、SerDe、存储位置、分区信息等）
6. Spark 将 `CatalogTable` 转化为 `HiveTableRelation`（逻辑计划节点）

**Hive Metastore 访问的性能影响**：

在分析阶段，如果查询涉及多张表，每张表都需要一次 Hive Metastore 的 RPC。对于复杂查询（20+ 张表的 Join），分析阶段可能花费数秒在 Metastore 访问上。这是 Spark SQL 的一个常被忽视的开销来源。

优化措施：
- 配置 `spark.sql.hive.metastore.version` 和连接池（减少 RPC 建立开销）
- 使用 `spark.sql.hive.caseSensitiveInferenceMode=INFER_AND_SAVE`（缓存列大小写推断结果）
- 对高频查询的表，预先在 Spark 端做 Catalog 缓存

### 4.3 临时视图与全局临时视图

**临时视图（Temporary View）**：只在当前 `SparkSession` 中可见，不持久化到 Hive Metastore：

```scala
df.createOrReplaceTempView("my_temp_view")
// 可以在 SQL 中直接引用
spark.sql("SELECT * FROM my_temp_view WHERE ...")
```

**全局临时视图（Global Temporary View）**：在同一个 `SparkContext` 的所有 `SparkSession` 中可见，存在 `global_temp` 数据库下：

```scala
df.createOrReplaceGlobalTempView("my_global_view")
// 必须用 global_temp 前缀引用
spark.sql("SELECT * FROM global_temp.my_global_view WHERE ...")
```

**区分两者的场景**：
- 临时视图：单个查询会话内的中间结果，如 ETL 管道中的临时中间表
- 全局临时视图：多个 SparkSession（如不同用户会话或不同线程）共享的公共数据集

---

## 第 5 章 分析错误的类型与诊断

### 5.1 常见分析错误类型

Analyzer 分析失败时，通常抛出 `AnalysisException`，错误信息指向具体的失败原因：

**错误一：表不存在**
```
AnalysisException: Table or view not found: orders
```
根因：`ResolveRelations` 在 Catalog 中找不到 `orders` 表。
诊断：检查表名拼写、数据库名、是否已执行 `USE database_name`。

**错误二：列不存在**
```
AnalysisException: Resolved attribute(s) missing from child: amount
```
或：
```
AnalysisException: Column 'amount' does not exist. Did you mean one of the following? [amt, total_amount]
```
根因：`ResolveReferences` 在当前作用域的输出属性中找不到 `amount`。
诊断：检查列名拼写、是否在正确的表上引用。Spark 3.x 会给出"你是否想要..."的提示。

**错误三：类型不匹配**
```
AnalysisException: cannot resolve '(amount + user_name)' due to data type mismatch:
  argument 1 requires (double or decimal) type, however, 'user_name' is of string type.
```
根因：`ImplicitTypeCasts` 规则无法自动做类型转换，触发类型检查失败。
诊断：显式添加 `CAST` 进行类型转换。

**错误四：聚合函数使用错误（混合聚合与非聚合）**
```
AnalysisException: Resolved attribute(s) missing from child: userId
  userId#1 not found in aggregate: [SUM(amount#2)]
```
或更常见的：
```
AnalysisException: grouping expressions sequence is empty, and 'orders.userId' is not an aggregate function.
```
根因：SELECT 列表中包含非聚合列，但没有将其加入 GROUP BY。
诊断：将 SELECT 中的所有非聚合列加入 GROUP BY。

**错误五：子查询返回多列（期望单列）**
```
AnalysisException: Scalar subquery must return only one column, but found: 2
```

### 5.2 通过 Spark UI 观察分析结果

在 Spark UI → SQL 标签页，可以看到每个 SQL 查询的执行计划。点击具体查询，可以看到包含分析后逻辑计划的详情。

也可以在代码中直接打印分析结果：

```scala
val df = spark.sql("SELECT userId, SUM(amount) FROM orders GROUP BY userId")

// 打印 Analyzed LogicalPlan
println(df.queryExecution.analyzed)

// 输出类似：
// Aggregate [userId#1], [userId#1, sum(amount#2) AS sum(amount)#5]
// +- Filter (amount#2 > 100)
//    +- HiveTableRelation `default`.`orders`, 
//       org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe,
//       [userId#1, amount#2, ts#3]
```

---

## 第 6 章 自定义 SQL 解析器扩展

### 6.1 为什么需要扩展 Parser

默认的 SQL 解析器覆盖了标准 SQL 语法和 Spark 的扩展语法。但某些场景需要自定义语法，例如：

- **数据库迁移**：将特定数据库（如 Teradata、Netezza）的方言语法转换为 Spark SQL
- **特定语法糖**：为业务场景添加快捷语法（如 `ANALYZE TABLE ... QUICK` 自定义命令）
- **多引擎兼容**：支持 Presto / Trino 方言的某些特定语法

### 6.2 两种扩展方式

**方式一：实现 `ParserInterface` 包装器（推荐）**

```scala
class MyCustomParser(delegate: ParserInterface) extends ParserInterface {
  override def parsePlan(sqlText: String): LogicalPlan = {
    // 先尝试自定义解析
    if (isCustomSyntax(sqlText)) {
      parseCustomSyntax(sqlText)
    } else {
      // 回退到默认 Parser
      delegate.parsePlan(sqlText)
    }
  }
  // ... 其他方法委托给 delegate
}

// 通过 SparkSessionExtensions 注册
val spark = SparkSession.builder()
  .withExtensions(_.injectParser((session, parser) => new MyCustomParser(parser)))
  .getOrCreate()
```

**方式二：修改 `SqlBase.g4`（不推荐生产使用）**

直接修改语法文件并重新生成解析器，代码维护成本高，每次 Spark 升级都需要重新合并。

---

## 小结

解析与分析两阶段是 Spark SQL 执行管道的"入口关"：

- **Parser（解析）**：Antlr4 将 SQL 文本转为 CST，`AstBuilder` 通过 Visitor 模式将 CST 转为 `Unresolved LogicalPlan`。三种节点：`UnresolvedRelation`（表名）、`UnresolvedAttribute`（列名）、`UnresolvedFunction`（函数名）
- **Analyzer（分析）**：继承 `RuleExecutor`，通过批次化规则将所有 Unresolved 节点替换为有类型、有来源的节点。核心批次是 `Resolution`（FixedPoint），核心规则是 `ResolveRelations`、`ResolveReferences`、`ResolveFunctions`
- **Catalog**：分析阶段的元数据依赖，分 `ExternalCatalog`（持久化）和 `SessionCatalog`（会话级）两层。生产中通常对接 Hive Metastore（Thrift RPC），有一定访问延迟
- **固定点迭代**：Resolution 批次反复执行，直到计划不再变化，确保所有引用都被完全解析（处理子查询外部引用等复杂场景）
- **分析错误**：全部以 `AnalysisException` 抛出，分为"表不存在"、"列不存在"、"类型不匹配"、"聚合错误"四大类，诊断方式是检查表名、列名、类型、GROUP BY 是否完整

下一篇（第 03 篇）将深入 Optimizer，拆解 Rule-Based Optimizer 的核心规则体系：谓词下推、列裁剪、常量折叠、子查询优化，以及如何通过 `EXPLAIN` 观察每条优化规则带来的计划变化。

---

> [!note] 思考题
> 1. Analyzer 使用"固定点迭代"来确保所有 Resolution 规则收敛。如果用户写了一个无法收敛的自定义 Resolution 规则，Spark 会怎么处理？Spark 是如何防止无限循环的？
> 2. `Unresolved` 系列节点（UnresolvedRelation、UnresolvedAttribute）在解析阶段大量存在。这种"延迟绑定"设计有什么好处？在什么场景下会导致运行时才暴露的错误，而不是编译期错误？
> 3. Analyzer 依赖 Catalog 来解析表名和列名。在多租户场景下，如果两个 SparkSession 同时修改同一张表的 Schema，Analyzer 拿到的 Catalog 快照可能不一致——Spark 是如何处理这种并发元数据访问的？

## 参考资料

- [Deep Dive into Spark SQL's Catalyst Optimizer（Databricks Blog）](https://www.databricks.com/blog/2015/04/13/deep-dive-into-spark-sqls-catalyst-optimizer.html)
- [Catalyst Optimizer in Spark SQL（waitingforcode.com）](https://www.waitingforcode.com/apache-spark-sql/catalyst-optimizer-in-spark-sql/read)
- Michael Armbrust 等：Spark SQL: Relational Data Processing in Spark（SIGMOD 2015）
- Apache Spark 源码：`org.apache.spark.sql.catalyst.parser.AstBuilder`
- Apache Spark 源码：`org.apache.spark.sql.catalyst.analysis.Analyzer`
- Apache Spark 源码：`org.apache.spark.sql.catalyst.catalog.SessionCatalog`
- Antlr4 官方文档：The Definitive ANTLR 4 Reference（Terence Parr）
