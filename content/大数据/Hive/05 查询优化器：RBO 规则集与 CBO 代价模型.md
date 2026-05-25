---
title: "查询优化器：RBO 规则集与 CBO 代价模型"
date: 2026-02-28
tags: [ANALYZE, Calcite, CBO, Hive, Join策略, RBO, 代价模型, 查询优化器, 统计信息, 谓词下推]
aliases: []
---

# 05 查询优化器：RBO 规则集与 CBO 代价模型

## 摘要

查询优化器是 SQL 引擎的核心竞争力。同一条 SQL，经过优化器的不同决策，执行时间可能相差 10 倍乃至 100 倍。Hive 的优化器体系分为两层：**RBO（基于规则的优化，Rule-Based Optimization）** 是默认基础层，通过一组预定义的代数等价变换规则改写 Operator Tree；**CBO（基于代价的优化，Cost-Based Optimization）** 是高级层，通过统计信息估算每种执行方案的代价，选择代价最低的方案。理解 RBO 和 CBO 的工作机制，能帮助工程师：一、知道哪类 SQL 写法会绕过优化器（让优化器无法发挥作用）；二、知道为什么 `ANALYZE TABLE` 对某些查询的提速是数量级的；三、在 `EXPLAIN` 输出中看懂优化器的决策并评估是否合理。本文系统梳理 Hive RBO 的核心规则集、CBO 的代价计算模型，以及 Join 策略（Map Join / Common Join / SMB Join）的选择条件。

---

## 第 1 章 为什么需要查询优化器

### 1.1 SQL 的声明性与执行的多样性

SQL 是一种**声明式语言**（Declarative Language）：你描述"要什么结果"，而不是"怎么获得结果"。`SELECT a.name, COUNT(b.id) FROM customers a JOIN orders b ON a.id = b.cust_id WHERE a.region = 'US' GROUP BY a.name` 这条 SQL 说的是"我要美国客户的订单数量"，没有说"先扫哪张表"、"用哪种 Join 算法"、"按哪个顺序过滤"。

正是这种声明性，给了查询优化器发挥的空间——**同一个逻辑结果，可以用无数种物理执行计划来获取**，优化器的使命是找到其中代价最小的一种。

以上面的 SQL 为例，执行计划的维度就包括：
- 先扫 `customers` 还是先扫 `orders`？
- `WHERE a.region = 'US'` 在 JOIN 之前过滤还是之后过滤？
- 用 Common Join（Shuffle）、Map Join（广播小表）还是 SMB Join（有序文件合并）？
- GROUP BY 在 Reduce 端单次完成还是 Map+Reduce 两阶段完成？

这些维度的组合是指数级的，人工枚举是不现实的，这正是优化器存在的价值。

### 1.2 RBO 与 CBO 的分工

**RBO（Rule-Based Optimization）**：基于"代数等价变换"——将 Operator Tree 中的某个模式替换为等价但通常更高效的模式，不依赖数据统计。规则是固定的，无需 `ANALYZE TABLE`，即开即用。

RBO 的局限：规则是全局适用的，不感知数据分布。例如，"总是将过滤条件下推到数据源"这个规则在绝大多数情况下是有益的，但对于某些极端案例（过滤条件选择性很低，不能减少多少数据量），这个规则的收益可能不如期望的大。规则本身没有错，但"最优"需要数据做支撑。

**CBO（Cost-Based Optimization）**：基于统计信息估算每种执行计划的代价（CPU 时间 + I/O + 内存），选择总代价最小的计划。CBO 能做 RBO 无法做的决策：选择 Join 算法、优化多表 Join 顺序、决定聚合的并行度。代价是必须有统计信息（`ANALYZE TABLE` 收集），且统计信息必须是准确的（过期的统计信息可能导致更差的计划）。

---

## 第 2 章 RBO：核心规则集详解

### 2.1 Hive RBO 框架

Hive 的 RBO 基于一个简单的 **图模式匹配 + 规则应用** 框架（`Optimizer` 类，在 Hive 3.x 中，`CalcitePlanner` 也包含 Calcite 规则集）。框架遍历 Operator Tree，对每个子树尝试应用已注册的规则集（`Rule`），如果某个规则的模式（Pattern）匹配当前子树，就将该子树替换为规则指定的变换后版本。

这个过程是多轮迭代的——一轮规则应用可能使 Operator Tree 满足另一个规则的匹配条件，因此规则引擎会持续应用规则直到没有新的变换可以发生（达到不动点）。

### 2.2 谓词下推（PredicatePushDown，PPD）

**规则描述**：将 FilterOperator 下推到尽量靠近数据源的位置（TableScanOperator 或 Partition 层）。

**数学本质**：在关系代数中，σ（过滤）具有交换律——`σ(condition)(Join(A, B)) = Join(σ(condition_A)(A), σ(condition_B)(B))`，即针对单表的过滤条件可以先对各表单独过滤，再做 JOIN，结果等价。

**在 Hive 中的效果链**：

第一层，谓词下推到 FilterOperator 层（早于 JOIN 执行）：
```
优化前：Join → Filter(a.region='US') → FileSink
优化后：Join(Filter(a.region='US')(TS_customers), TS_orders) → FileSink
```

第二层，**分区裁剪（Partition Pruning）**——谓词下推的极致形式：如果 `region` 是分区列，过滤条件可以在 SQL **编译阶段**就传递给 `TableScanOperator`，Hive 在规划时确定只扫描匹配分区的 HDFS 文件，**完全不读取不匹配分区的文件**。

```xml
<!-- 相关配置 -->
<property>
  <name>hive.optimize.ppd</name>
  <value>true</value>  <!-- 启用谓词下推，默认 true -->
</property>
<property>
  <name>hive.optimize.ppd.storage</name>
  <value>true</value>  <!-- 将谓词下推到 ORC/Parquet 的 Row Group 过滤，默认 true -->
</property>
```

**谓词下推的边界**：并非所有谓词都能下推。以下情况无法下推：
- 涉及 `OR`：`a.region = 'US' OR b.status = 'active'`——这个条件跨越两张表，无法拆分下推
- 非确定性函数：`WHERE rand() < 0.1`——`rand()` 每行结果不同，下推后语义会改变
- 外连接的外侧谓词：LEFT JOIN 中右表的过滤条件不能下推（会改变外连接的空值填充语义）

> [!note] 设计哲学
> 谓词下推和分区裁剪的协同，是 Hive 性能调优中效益最高的优化手段。一张按 `dt` 分区的 1000 分区大表，如果查询只需要最近 7 天的数据（7 个分区），分区裁剪将 I/O 从 100% 降到 0.7%——这比任何内存优化或并行度调整都更直接有效。这也是为什么"合理的分区设计"是 Hive 表设计的最高优先级原则。

### 2.3 列裁剪（ColumnPruning）

**规则描述**：分析整棵 Operator Tree，确定每个 Operator 实际需要的列集合，删除不需要的列的读取和传递。

**在 ORC/Parquet 下的效果**：列式存储格式按列存储，读取不需要的列完全不产生 I/O。如果一张表有 50 列，但查询只用了 5 列，列裁剪使实际 I/O 减少 90%。

**列裁剪的实现思路**（简化版）：

```
从 FileSinkOperator 开始，反向遍历 Operator Tree：
  1. FileSink 需要哪些列？→ SELECT 子句中的列
  2. GroupByOperator 需要哪些列？→ 聚合列 + GROUP BY 列
  3. FilterOperator 需要哪些列？→ 上游需要的列 + WHERE 条件涉及的列
  4. JoinOperator 需要哪些列？→ 上游需要的列 + JOIN Key 列
  5. TableScanOperator 只读取最终确定的列集合
```

**`SELECT *` 的代价**：`SELECT *` 通知 Hive 所有列都需要，列裁剪无法生效，ORC/Parquet 的列式存储优势完全损失。这是生产中禁止 `SELECT *` 的核心技术原因（而不仅仅是"代码规范"）。

### 2.4 常量折叠（Constant Folding）

**规则描述**：将表达式树中可以在编译期计算的子表达式替换为其值。

**典型场景**：

```sql
-- 时间计算常量折叠
SELECT * FROM t WHERE dt = date_sub(current_date(), 7);
-- current_date() 在编译时确定，date_sub 结果也可以预计算
-- 优化后：WHERE dt = '2026-02-21'  （假设当前日期是 2026-02-28）
-- 这使得 dt 可以参与分区裁剪

-- 算术常量折叠
SELECT * FROM t WHERE amount > 100 * 1000;
-- 优化后：WHERE amount > 100000

-- 布尔简化
SELECT * FROM t WHERE 1 = 1 AND status = 'active';
-- 优化后：WHERE status = 'active'
```

常量折叠与谓词下推、分区裁剪形成协同链：只有当谓词表达式被常量折叠为"分区列 = 常量"的形式，分区裁剪才能生效。

### 2.5 相关子查询消除（Subquery Elimination）

Hive 对子查询的支持有限（历史上相关子查询支持很弱），但现代 Hive（3.x）支持将部分子查询转换为等价的 JOIN 形式：

```sql
-- 原始 SQL（IN 子查询）
SELECT * FROM orders
WHERE cust_id IN (SELECT id FROM customers WHERE region = 'US');

-- 优化后等价写法（SEMI JOIN）
SELECT orders.*
FROM orders LEFT SEMI JOIN customers
  ON (orders.cust_id = customers.id AND customers.region = 'US');
```

LEFT SEMI JOIN 在 Hive 中有专门的优化路径（不需要 Reduce 端的全量匹配，一旦找到匹配即停止），比 IN + 子查询的非优化执行效率更高。

---

## 第 3 章 CBO：基于代价的优化

### 3.1 Hive CBO 的技术基础：Apache Calcite

Hive 的 CBO 基于 **Apache Calcite**——一个开源的 SQL 优化框架（最初由 Julian Hyde 开发，现为 Apache 顶级项目，被 Flink、Drill、Phoenix 等众多系统采用）。

Calcite 提供了：
- **关系代数层**：将 Hive 的 Operator Tree 转换为 Calcite 的 Relational Algebra（RelNode）树，包括 `LogicalTableScan`、`LogicalFilter`、`LogicalJoin`、`LogicalAggregate` 等节点
- **代价模型框架**：定义 `Cost` 接口（包含 rowCount、cpu、io 三个维度），允许注册自定义代价计算函数
- **规划器（Planner）**：基于 Volcano/Cascades 优化框架，通过搜索等价变换空间找到代价最低的计划

**开启 CBO 的配置**：

```xml
<property>
  <name>hive.cbo.enable</name>
  <value>true</value>  <!-- 开启 CBO，Hive 2.0+ 默认 true -->
</property>
<property>
  <name>hive.stats.fetch.column.stats</name>
  <value>true</value>  <!-- CBO 决策时从 HMS 获取列统计信息 -->
</property>
<property>
  <name>hive.stats.fetch.partition.stats</name>
  <value>true</value>  <!-- CBO 决策时从 HMS 获取分区统计信息 -->
</property>
```

### 3.2 统计信息：CBO 的决策基础

CBO 的有效性完全依赖于统计信息的准确性。Hive 的统计信息分为两个层次：

**表级统计**（`numRows`、`rawDataSize`）：整张表（或每个分区）的总行数和总数据量，存储在 HMS 的 `TABLE_PARAMS`（表参数）或 `PARTITION_PARAMS` 中。

```sql
-- 收集表级统计（快速，只扫描文件大小，不扫描数据内容）
ANALYZE TABLE customers COMPUTE STATISTICS;

-- 收集分区表的特定分区统计
ANALYZE TABLE orders PARTITION(dt='2026-01-15') COMPUTE STATISTICS;

-- 收集所有分区（慎用，分区多时代价高）
ANALYZE TABLE orders PARTITION(dt) COMPUTE STATISTICS;
```

**列级统计**（`numDistincts`、`numNulls`、`min`、`max`、`avgColLen`）：每列的基数、空值数、值域范围等，存储在 HMS 的 `TAB_COL_STATS` / `PART_COL_STATS` 中。

```sql
-- 收集列级统计（需要扫描数据，代价较高）
ANALYZE TABLE customers COMPUTE STATISTICS FOR COLUMNS id, region, name;

-- 收集所有列的统计（高代价，建议只收集 JOIN Key 和 WHERE 过滤列）
ANALYZE TABLE customers COMPUTE STATISTICS FOR COLUMNS;
```

**统计信息的有效期问题**：统计信息是在 `ANALYZE TABLE` 时刻的数据快照，不会随着数据增量自动更新。如果一张表每天新增 100 万行，一个月后统计信息严重失效（行数估算偏差 3000 万行），CBO 基于错误的行数可能做出比 RBO 更差的决策（如误把一张大表识别为小表，选择了 Map Join，导致 Executor OOM）。

> [!warning] 生产避坑
> **失效的统计信息比没有统计信息更危险**。没有统计信息时，CBO 使用保守的默认估算值（通常偏向安全的 Common Join），执行计划可能次优但不会出错。而失效的统计信息（如 `numRows=1000` 但实际有 1 亿行）会让 CBO 错误地选择 Map Join，导致 Executor 因广播数据超过内存上限而 OOM。生产中建议：对于每日更新的分区表，在数据写入后对新分区执行 `ANALYZE TABLE ... PARTITION(...) COMPUTE STATISTICS FOR COLUMNS`，而不是对全表执行。

### 3.3 CBO 的代价模型

Calcite 的代价模型从三个维度估算执行代价：

- **`rowCount`（行数）**：某个 RelNode 输出的估计行数。是代价计算的核心基础——后续操作的 CPU 和 I/O 代价都基于行数估算
- **`cpu`（CPU 代价）**：处理一行数据的 CPU 代价（相对单位）
- **`io`（I/O 代价）**：读写一行数据的 I/O 代价（相对单位）

**`rowCount` 的估算逻辑（简化）**：

对于 `LogicalFilter(condition=c > 1000)`：
```
filterRowCount = sourceRowCount × selectivity(c > 1000)

selectivity 计算：
  如果有列统计（min=0, max=10000, numDistincts=5000）：
    selectivity = (max - 1000) / (max - min) = (10000 - 1000) / (10000 - 0) = 0.9
    filterRowCount = sourceRowCount × 0.9

  如果没有列统计：
    默认 selectivity = 1/3（经验值）
    filterRowCount = sourceRowCount × 0.33
```

对于 `LogicalJoin(condition=a.id=b.cust_id)`：
```
joinRowCount = leftRowCount × rightRowCount / max(leftNDV(id), rightNDV(cust_id))

其中 NDV = Number of Distinct Values（基数，来自 numDistincts 列统计）
```

这些估算公式在理想情况下（数据均匀分布）是准确的，但面对数据倾斜时可能严重失准。

### 3.4 CBO 的 Join 顺序优化

**多表 Join 的顺序空间**：对于 N 张表的 Join，Join 顺序有 `(2(N-1))! / (N-1)!` 种（Catalan 数），N=5 时已经有 1680 种，N=10 时超过 1700 亿种。穷举搜索是不可行的，Hive CBO 使用**动态规划**（DP）搜索最优 Join 顺序。

**DP 搜索的核心思路**：

```
自底向上构建最优计划：
  对每对表的 Join，计算代价，选择代价最小的算法（Map Join vs Common Join）
  对每三表组合，考虑所有二进制树形结构，选择代价最小的 Join 顺序
  ...以此类推直到所有 N 张表都被 Join

代价估算关键：
  小表 + 大表 → 优先考虑 Map Join（小表广播到每个 Map Task）
  两张大表 → Common Join（Shuffle，Reducer 端 Join）
  有序且分桶对齐的两张表 → SMB Join（Sort Merge Bucket Join，无 Shuffle）
```

**CBO Join 顺序优化的收益场景**：当 SQL 包含星型 Schema 查询（一张大事实表 JOIN 多张维表）时，CBO 能正确识别维表（小表），优先将维表广播，避免大表参与 Shuffle。这种场景下 CBO 的效果最显著。

---

## 第 4 章 Join 策略深度解析

### 4.1 Hive 的五种 Join 策略

| Join 类型 | 适用条件 | 执行机制 | 优势 | 局限 |
|---------|---------|---------|-----|-----|
| **Common Join** | 通用，无特殊要求 | Shuffle（ReduceSinkOperator）+ Reduce 端 Join | 通用，支持任意大小 | Shuffle 代价高 |
| **Map Join** | 小表可放入内存 | 小表广播到所有 Map Task，Map 端完成 Join | 无 Shuffle，速度快 | 小表内存限制 |
| **Bucket Map Join** | 两表分桶键相同，分桶数倍数关系 | 只广播对应桶的数据，减少广播量 | 比普通 Map Join 广播数据少 | 需要两表分桶对齐 |
| **SMB Join** | 两表分桶键相同、桶内有序 | 无广播，逐桶 Merge Join，O(n+m) | 无 Shuffle，无广播，最高效 | 强前提条件（分桶+排序）|
| **Skew Join** | 数据严重倾斜 | 对倾斜键单独处理（发到特殊 Reducer）| 避免单 Reducer 处理所有倾斜数据 | 需要先探测倾斜键 |

### 4.2 Map Join：小表广播的实现细节

Map Join 是生产中最常用的 Join 优化手段。当 Join 的一方是小表（能放入 Executor 内存）时，Map Join 将小表数据广播到所有处理大表的 Map Task，每个 Map Task 在内存中构建小表的 Hash Table，处理大表时直接 Probe（探测）Hash Table，避免了 Shuffle。

**Map Join 的执行流程**：

```
编译期：
  Hive 判断小表大小（来自统计信息或 SELECT 结果）
  如果小表大小 < hive.mapjoin.smalltable.filesize（默认 25MB）：
    将 Join 计划改写为 Map Join

运行期：
  阶段 1（LocalTask）：
    在 HS2 本地执行（不提交 MR/Tez 任务），读取小表所有数据
    序列化为 HashTable 文件，上传到 HDFS 的分布式缓存（DistributedCache）

  阶段 2（MapTask）：
    每个 Map Task 启动时，从 DistributedCache 下载 HashTable 文件
    反序列化为内存中的 HashMap
    处理大表的一行时，用 Join Key 在 HashMap 中查找匹配行（O(1)）
    输出 Join 结果行，直接写入最终文件（不需要 Shuffle）
```

**Map Join 的关键配置**：

```xml
<!-- 启用自动 Map Join -->
<property>
  <name>hive.auto.convert.join</name>
  <value>true</value>  <!-- 自动将小表 Join 转换为 Map Join -->
</property>
<!-- 小表大小阈值（超过此值的表不做广播）-->
<property>
  <name>hive.mapjoin.smalltable.filesize</name>
  <value>26214400</value>  <!-- 25MB，根据集群内存酌情调大，如 128MB -->
</property>
<!-- Map Join 使用的内存（相对于 Task 总内存的比例）-->
<property>
  <name>hive.mapjoin.followby.gby.localtask.max.memory.usage</name>
  <value>0.55</value>
</property>
```

> [!warning] 生产避坑
> **Map Join 的 "小表" 是文件大小，不是内存中的 HashMap 大小**。一张 25MB 的 ORC 文件，解压后内存中的 Java HashMap 对象可能占用 250MB（ORC 压缩比约 10:1，Java 对象开销约 2-3 倍）。如果 Map Task 的内存配置是 2GB，单个 Map Join 的 HashMap 占用 250MB 是可接受的；但如果 SQL 包含 3 个 Map Join（3 张小表），3 个 HashMap 共占用 750MB，加上大表扫描和其他内存，可能导致 OOM。生产中推荐将 `hive.mapjoin.smalltable.filesize` 设置为 Task 内存的 **10-15%**，留足余量。

### 4.3 SMB Join：终极 Join 优化

**Sort Merge Bucket Join（SMB Join）** 是 Hive 中执行代价最低的 Join 类型——既不需要 Shuffle，也不需要广播，两张大表都可以参与。代价是苛刻的前提条件。

**SMB Join 的前提**：
1. 两张表都按 Join 键**分桶（BUCKETED BY join_key）**
2. 两张表的分桶数**相同**（或为整数倍关系）
3. 桶内的数据按 Join 键**排序（SORTED BY join_key）**

满足上述条件后，JOIN 可以逐桶进行，每个桶内的数据来自两张表且已排序——只需一次 **Merge（归并）**操作（O(n+m)，n 和 m 是两个桶的行数）即可完成 JOIN，不需要 Hash Table（节省内存），不需要 Shuffle（节省网络 I/O）。

```sql
-- 建表时声明分桶和排序（确保后续可以使用 SMB Join）
CREATE TABLE orders_bucketed (
    cust_id BIGINT,
    order_id BIGINT,
    amount DECIMAL(10,2)
)
CLUSTERED BY (cust_id) SORTED BY (cust_id) INTO 256 BUCKETS
STORED AS ORC;

CREATE TABLE customers_bucketed (
    id BIGINT,
    name STRING,
    region STRING
)
CLUSTERED BY (id) SORTED BY (id) INTO 256 BUCKETS
STORED AS ORC;

-- 启用 SMB Join（需要所有参与 Join 的表都是有序分桶表）
SET hive.auto.convert.sortmerge.join=true;
SET hive.optimize.bucketmapjoin=true;
SET hive.optimize.bucketmapjoin.sortedmerge=true;

-- 查询（Hive 自动选择 SMB Join）
SELECT c.name, SUM(o.amount)
FROM customers_bucketed c JOIN orders_bucketed o ON c.id = o.cust_id
GROUP BY c.name;
```

SMB Join 在数仓事实表与维表的大规模 Join 场景下，性能提升可达 5-10 倍（相比 Common Join）。代价是建表时必须提前规划分桶策略，且数据写入时必须保证有序（通过 `INSERT INTO ... SELECT ... ORDER BY join_key` 或 Bucketing Sort 写入）。

---

## 第 5 章 统计信息维护的生产实践

### 5.1 统计信息的自动收集

手动 `ANALYZE TABLE` 代价高且容易遗忘，Hive 支持**自动统计信息收集**——在数据写入（INSERT）时自动更新统计信息：

```xml
<!-- 开启自动统计信息收集 -->
<property>
  <name>hive.stats.autogather</name>
  <value>true</value>  <!-- INSERT INTO/OVERWRITE 后自动更新行数和数据量 -->
</property>
<!-- 自动收集列统计（代价较高，按需开启）-->
<property>
  <name>hive.stats.column.autogather</name>
  <value>false</value>  <!-- 默认 false，对高频写入表不建议开启 -->
</property>
```

`hive.stats.autogather=true` 时，每次 `INSERT` 完成后，Hive 自动更新 HMS 中的 `numRows` 和 `rawDataSize`（表级统计），但**不更新列统计**。列统计的准确性对 CBO 的 Join 决策影响最大，建议通过定期调度（如每天凌晨对关键表执行 `ANALYZE TABLE ... COMPUTE STATISTICS FOR COLUMNS`）来保持列统计的新鲜度。

### 5.2 查看当前统计信息

```sql
-- 查看表级统计
DESCRIBE EXTENDED orders;
-- 在输出的 Table Parameters 中找：numRows, rawDataSize, totalSize

-- 查看列级统计
DESCRIBE FORMATTED orders;

-- 通过 HMS 直接查询（高级用法）
-- 使用 MetaStore API：msck check table ...
```

### 5.3 CBO 是否生效的诊断

```sql
-- 用 EXPLAIN 查看 CBO 决策
SET hive.explain.user=false;  -- 显示详细的内部计划
EXPLAIN SELECT c.name, COUNT(o.id) FROM customers c JOIN orders o ON c.id = o.cust_id GROUP BY c.name;

-- 关注输出中的以下信息：
-- "Map Join Operator" → CBO/RBO 选择了 Map Join（小表广播）
-- "Reduce Output Operator" → 有 Shuffle，表示 Common Join
-- Statistics: Num rows: ... Data size: ... → CBO 的行数估算值（与实际行数对比判断准确性）
```

---

## 小结

Hive 的查询优化器体系由 RBO 和 CBO 两层构成，两者协同工作：

- **RBO（规则驱动）**：谓词下推（减少 Shuffle 数据量）、列裁剪（减少 I/O）、常量折叠（配合分区裁剪）构成基础优化层，无需统计信息，即开即用；边界是无法感知数据分布，无法做数据感知的 Join 策略选择
- **CBO（代价驱动）**：基于 Apache Calcite，通过统计信息（行数、基数、数据大小）估算各种执行方案的 CPU + I/O 代价，选择总代价最低方案；最重要的 CBO 决策是 **Join 策略**（Map Join vs Common Join vs SMB Join）和 **Join 顺序**
- **统计信息管理**：`ANALYZE TABLE ... COMPUTE STATISTICS FOR COLUMNS` 是 CBO 有效工作的前提；失效的统计信息比没有统计信息更危险；建议对关键表按周期自动化执行 ANALYZE
- **Join 策略**：Map Join（小表广播，25MB 以下）、SMB Join（分桶+有序，无 Shuffle 最高效）、Common Join（通用回退）；根据表的大小和物理布局选择合适的 Join 类型是 Hive 调优的核心手段

第 06 篇深入 Join 实现机制：Common Join 的 Shuffle 原理（Map 端标记 → Shuffle 分发 → Reduce 端合并），Map Join 的 HashTable 构建过程，Bucket Map Join 的分桶对齐优化，SMB Join 的归并实现，以及 Skew Join 自动处理数据倾斜的机制。

---

> [!note] 思考题
> 1. Hive 的 CBO（基于代价的优化器）依赖表和列的统计信息（行数、NDV、Min/Max）来估算每个操作的代价，从而选择最优的 JOIN 顺序和 JOIN 算法。如果统计信息过时（上次 `ANALYZE TABLE` 之后数据发生了大量变更），CBO 的估算可能严重偏差，选择出比 RBO 更差的执行计划。如何在生产环境中建立统计信息的自动更新机制，确保 CBO 始终基于准确的统计数据做决策？
> 2. Join Order Optimization（JOO）是 CBO 最重要的应用——在多表 JOIN 时，不同的 JOIN 顺序会产生不同大小的中间结果，进而影响性能。Hive 的 JOO 使用动态规划（DP）来枚举所有可能的 JOIN 顺序，选择代价最小的方案。对于 N 张表的 JOIN，枚举的空间是 O(N!)。当 N 很大（如 10 张以上）时，完全枚举的计算量会非常大。Hive 如何通过剪枝或启发式方法控制 JOO 的计算复杂度？
> 3. Predicate Pushdown（谓词下推）是 RBO 中最重要的优化之一——将 WHERE 条件尽早下推到数据扫描层（如 ORC 的列统计过滤），减少后续处理的数据量。但并非所有谓词都可以下推——包含不确定性函数（如 `RAND()`、`CURRENT_TIMESTAMP`）或需要先执行聚合再过滤（如 `HAVING` 子句）的谓词不能下推。在实际编写 Hive SQL 时，有哪些常见的"写法导致谓词无法下推"的陷阱，以及如何改写 SQL 来启用下推？

## 参考资料

- [Hive CBO 设计文档](https://cwiki.apache.org/confluence/display/Hive/Cost-based+optimizations+in+Hive)
- [Apache Calcite 文档](https://calcite.apache.org/docs/algebra.html)
- [Hive Join 优化文档](https://cwiki.apache.org/confluence/display/Hive/LanguageManual+JoinOptimization)
- [Hive Statistics 文档](https://cwiki.apache.org/confluence/display/Hive/StatsDev)
