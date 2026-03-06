---
title: "Whole-Stage CodeGen：JVM 字节码级别的性能飞跃"
date: 2026-02-28
tags: [Spark, SparkSQL, CodeGen, Whole-Stage CodeGen, Volcano模型, JVM, 字节码, Tungsten, 性能优化]
aliases: []
---

# 07 Whole-Stage CodeGen：JVM 字节码级别的性能飞跃

## 摘要

Spark SQL 执行引擎的早期实现沿用关系型数据库的经典模型——**Volcano 迭代器模型**：每个物理算子实现 `next()` 方法，上层算子不断调用下层算子的 `next()` 拉取数据，一行一行地处理。处理 10 亿行数据时，`next()` 被调用 10 亿次——每次都是 JVM 虚方法调用，有类型检查、多态分发、栈帧创建的开销，JIT 无法做函数内联，数据以通用 `InternalRow` 对象传递，造成大量无谓开销。**Whole-Stage CodeGen（全阶段代码生成）** 是 Spark 2.0 引入的革命性优化：将一组连续的物理算子融合为一段动态生成的 Java 代码，消灭算子间的虚方法调用，让 JIT 能够内联所有计算逻辑，数据以局部变量传递而非序列化行对象，实现接近手写 `for` 循环的执行效率。本文深度拆解 Whole-Stage CodeGen 的工作原理：Volcano 模型的具体开销来源、CodeGen 的 produce/consume 融合模型、生成代码的实际示例、`CollapseCodegenStages` 的融合边界、以及 CodeGen 的禁用场景与调试方法。

---

## 第 1 章 Volcano 迭代器模型：优雅但有代价

### 1.1 Volcano 模型的工作方式

**Volcano 模型**（Goetz Graefe，1994）是关系型数据库查询执行的经典架构，被 PostgreSQL、MySQL、早期 Spark SQL 广泛采用。

核心思想：每个物理算子是一个**迭代器**，实现统一的 `open()/next()/close()` 接口。父算子调用子算子的 `next()` 拉取下一行数据，数据从叶节点（Scan）一行一行地"流向"根节点（输出）。

```scala
// Filter 算子的 Volcano 实现
class FilterOperator(child: Operator, predicate: Row => Boolean) extends Operator {
  def next(): Row = {
    var row = child.next()
    while (row != null && !predicate(row)) row = child.next()
    row
  }
}
```

**Volcano 被采用的原因**：模块化强（每个算子独立实现）、内存友好（一次只处理一行）、支持流水线（数据逐行流动）。

### 1.2 Volcano 模型的性能代价

对于 `Scan → Filter → Project → Aggregate` 处理 1 亿行数据：
- 各算子的 `next()` 调用总次数：约 **3 亿次**（每算子约 1 亿次）

每次 `next()` 调用的代价：
1. **JVM 虚方法调用**（`invokevirtual`）：通过 vtable 做多态分发，无法静态分发，约 1-3ns / 次。3 亿次 = 0.3~1 秒的纯开销
2. **JIT 内联失败**：虚方法调用目标在运行时才确定，JIT 无法将 `predicate.eval(row)` 内联到 `next()` 中，保留了函数调用指令
3. **`InternalRow` 对象开销**：列值通过 `row.getInt(0)`、`row.getString(1)` 等方法访问，每次需要运行时类型检查和偏移量计算，而不是直接访问 JVM 局部变量
4. **CPU 流水线停顿**：虚方法调用和间接跳转导致 CPU 分支预测失败，流水线频繁 flush

> [!info] 核心概念
> Volcano 模型的根本问题是：它是为"通用性"而设计的（任何算子组合都能工作），但"通用性"的代价是大量运行时开销。当我们的查询结构在执行前就已经确定（物理计划是静态的），就没有必要保持这种通用性——我们可以针对这个具体的计划生成专用的高效代码。这正是 CodeGen 的出发点。

---

## 第 2 章 Whole-Stage CodeGen 的核心思路

### 2.1 "手写循环"的效率

如果手写等价于 `Scan → Filter → Project → Aggregate` 的 Java 代码：

```java
// 手写的等价代码——无任何虚方法调用
HashMap<UTF8String, long[]> aggMap = new HashMap<>();
for (InternalRow row : scanIterator) {
    double amount = row.getDouble(1);
    if (amount <= 100.0) continue;           // Filter（内联）
    UTF8String userId = row.getUTF8String(0); // Project（内联）
    // Aggregate（内联）
    long[] buf = aggMap.computeIfAbsent(userId, k -> new long[]{0L, 0L});
    buf[0] += (long) amount;  // sum
    buf[1]++;                 // count
}
```

**特点**：没有虚方法调用、JIT 可以内联所有逻辑、数据以局部变量传递、CPU 可以做预取优化。执行效率比 Volcano 模型快 **2-10 倍**。

**Whole-Stage CodeGen 的目标**：让 Spark 自动生成类似这样的"手写代码"，针对每个具体的物理计划生成专用的 Java 代码，而不是用通用的 Volcano 迭代器执行。

### 2.2 produce() / consume() 模型（Push Model）

Whole-Stage CodeGen 用 **Push Model**（推送模型）替代 Volcano 的 Pull Model（拉取模型）：

- **`produce()`**：算子生成"生产数据"的代码，向父算子推送数据
- **`consume()`**：算子生成"消费数据"的代码，处理来自子算子的数据

```scala
trait CodegenSupport extends SparkPlan {
  // 生成"生产数据"的代码骨架（通常包含循环）
  def doProduce(ctx: CodegenContext): String
  
  // 生成"消费来自子算子一行数据"的处理代码
  def doConsume(ctx: CodegenContext, input: Seq[ExprCode], row: ExprCode): String
}
```

**关键差异**：在 Volcano 中，控制流从父到子（父调用 `child.next()`）；在 CodeGen 中，**代码生成的方向从子到父**——叶节点（Scan）的 `produce()` 代码包含 `for` 循环，循环体内嵌入了父节点的 `consume()` 代码，父节点的 `consume()` 又嵌入了祖父节点的 `consume()`……最终生成一个大的单层循环，所有算子的逻辑都内联在其中。

---

## 第 3 章 代码融合的实际过程

### 3.1 单阶段融合示例

以 `FileScan → Filter(amount > 100) → HashAggregate(sum(amount) by userId)` 为例：

**Scan 的 `produce()` 生成的代码骨架**（包含外层循环）：
```java
for (int batchIdx = 0; batchIdx < numBatches; batchIdx++) {
    ColumnarBatch batch = ...; 
    int numRows = batch.numRows();
    for (int rowIdx = 0; rowIdx < numRows; rowIdx++) {
        double amount_value = amountCol.getDouble(rowIdx);
        boolean amount_isNull = amountCol.isNullAt(rowIdx);
        UTF8String userId_value = userIdCol.getUTF8String(rowIdx);
        /* FILTER_CONSUME */   // ← 此处由 Filter.consume() 代码替换
    }
}
```

**Filter 的 `consume()` 代码替换 `/* FILTER_CONSUME */`**：
```java
if (amount_isNull || !(amount_value > 100.0)) continue;
/* AGG_CONSUME */   // ← 此处由 HashAggregate.consume() 代码替换
```

**HashAggregate 的 `consume()` 代码替换 `/* AGG_CONSUME */`**：
```java
int hashCode = userId_value.hashCode();
int idx = findOrInsert(hashCode, userId_value);  // HashMap 探测
aggBuffer_sum[idx] += amount_value;
aggBuffer_count[idx]++;
```

**最终融合生成的代码**（单段，无任何跨算子调用）：
```java
for (int batchIdx = 0; batchIdx < numBatches; batchIdx++) {
    ColumnarBatch batch = batches[batchIdx];
    int numRows = batch.numRows();
    for (int rowIdx = 0; rowIdx < numRows; rowIdx++) {
        // Scan
        double amount_value = amountCol.getDouble(rowIdx);
        boolean amount_isNull = amountCol.isNullAt(rowIdx);
        // Filter（内联）
        if (amount_isNull || !(amount_value > 100.0)) continue;
        // Project（内联，直接用已有变量）
        UTF8String userId_value = userIdCol.getUTF8String(rowIdx);
        // HashAggregate（内联）
        int hashCode = userId_value.hashCode();
        int idx = findOrInsert(hashCode, userId_value);
        aggBuffer_sum[idx] += amount_value;
        aggBuffer_count[idx]++;
    }
}
```

这段代码由 Spark 在运行时通过 **Janino（轻量级 Java 编译器）** 动态编译为 JVM 字节码，然后被 JIT 进一步优化为机器码。

---

## 第 4 章 CollapseCodegenStages：融合的边界判断

### 4.1 不是所有算子都支持 CodeGen

并非所有物理算子都实现了 `CodegenSupport` 接口。以下算子**不支持** Whole-Stage CodeGen：

| 算子 | 不支持原因 |
|------|----------|
| `SortMergeJoinExec`（两侧归并） | 归并逻辑需要同时持有两个迭代器，难以融合为单循环 |
| `BroadcastNestedLoopJoinExec` | 嵌套循环需要外层+内层迭代器 |
| `WindowExec` | 窗口函数需要缓冲完整的 Frame |
| `ExpandExec`（GROUPING SETS 展开） | 每行产生多行输出，不适合 consume() 模型 |
| Python UDF / Pandas UDF 相关算子 | 需要跨进程调用 Python |

当遇到不支持 CodeGen 的算子时，Whole-Stage CodeGen 的融合链被截断——该算子作为边界，其上下游各自形成独立的 CodeGen 区域。

### 4.2 `CollapseCodegenStages` 规则

`CollapseCodegenStages` 是在 `QueryExecution.preparations` 中应用的一个规则，遍历整棵物理计划树，将连续的 `CodegenSupport` 节点合并为一个 `WholeStageCodegenExec` 节点：

```
优化前（物理计划树）：
HashAggregateExec
└── FilterExec
    └── ProjectExec
        └── FileScanExec

CollapseCodegenStages 应用后：
WholeStageCodegenExec
└── HashAggregateExec
    └── FilterExec
        └── ProjectExec
            └── FileScanExec
```

如果中间有不支持 CodeGen 的算子（如 `SortMergeJoinExec`），则形成两个独立的 `WholeStageCodegenExec`：

```
WholeStageCodegenExec  ← 上半段（Join 之后）
└── HashAggregateExec
    └── SortMergeJoinExec  ← 阻断点（不支持 CodeGen）
        ├── WholeStageCodegenExec  ← 下半段左侧
        │   └── FilterExec
        │       └── FileScanExec
        └── WholeStageCodegenExec  ← 下半段右侧
            └── FileScanExec
```

### 4.3 在执行计划中识别 CodeGen 区域

执行计划（`EXPLAIN FORMATTED`）中，被 `WholeStageCodegenExec` 包裹的算子会在名称前加 `*`（星号）：

```
== Physical Plan ==
*(2) HashAggregate(keys=[userId#1], functions=[sum(amount#2)])
+- Exchange hashpartitioning(userId#1, 200)
   +- *(1) HashAggregate(keys=[userId#1], functions=[partial_sum(amount#2)])
      +- *(1) Filter (amount#2 > 100.0)
         +- *(1) FileScan parquet orders[userId#1,amount#2]
```

`*(1)` 表示第一个 Whole-Stage CodeGen 区域，`*(2)` 表示第二个区域。`Exchange`（Shuffle）没有 `*`，是 CodeGen 链的天然边界。

---

## 第 5 章 CodeGen 的性能收益量化

### 5.1 基准测试数据

Databricks 的 TPC-DS 基准测试显示，开启 Whole-Stage CodeGen 后：
- 简单扫描 + 过滤查询：**3-5 倍**加速
- 聚合查询：**2-4 倍**加速
- Join 密集型查询：**1.5-3 倍**加速（Join 本身不总在 CodeGen 区域内）

**主要收益来源**：
1. **消灭虚方法调用**：减少约 50-80% 的 CPU 指令数
2. **JIT 内联优化**：整段循环被 JIT 视为一个单元，可以做寄存器分配优化、循环展开、消除公共子表达式
3. **减少 `InternalRow` 对象创建**：数据以局部变量传递，减少 GC 压力

### 5.2 什么时候 CodeGen 没有效果

**场景一：大量 Python UDF**

Python UDF 阻断 CodeGen 链（每个 Python UDF 产生一个 CodeGen 边界），且 Python UDF 本身有序列化 + 进程间通信开销。应将 Python UDF 改写为 Pandas UDF（批量处理，减少边界）或改用内置 Spark SQL 函数（完全在 CodeGen 内）。

**场景二：复杂窗口函数**

`WindowExec` 不支持 CodeGen，窗口函数密集的查询无法从 CodeGen 获益。

**场景三：IO 瓶颈**

如果查询时间主要花在磁盘 IO 或网络 Shuffle 上（而不是 CPU 计算），CodeGen 对 CPU 效率的提升不会反映在整体执行时间上。CodeGen 主要解决 CPU 效率问题，对 IO 密集型查询帮助有限。

---

## 第 6 章 调试与观察 CodeGen

### 6.1 查看生成的 Java 代码

```scala
// 方法一：通过 explain("codegen") 查看
df.explain("codegen")

// 方法二：通过 QueryExecution
println(df.queryExecution.executedPlan)

// 方法三：提取生成代码（用于调试）
val plan = df.queryExecution.executedPlan
plan.foreach {
  case wsc: WholeStageCodegenExec =>
    val (_, code) = wsc.doCodeGen()
    println(code.body)  // 打印生成的 Java 代码
  case _ =>
}
```

### 6.2 通过日志观察 CodeGen 编译

开启 DEBUG 日志后，CodeGen 会输出编译信息：
```
DEBUG WholeStageCodegenExec: Generated code for stage 1:
/* 001 */ public Object generate(Object[] references) {
/* 002 */   return new GeneratedIteratorForCodegenStage1(references);
/* 003 */ }
/* 004 */ 
/* 005 */ class GeneratedIteratorForCodegenStage1 extends ...
...
```

### 6.3 禁用 CodeGen（调试用途）

```properties
# 禁用 Whole-Stage CodeGen（调试时对比性能）
spark.sql.codegen.wholeStage=false

# 禁用表达式级 CodeGen
spark.sql.codegen.factoryMode=NO_CODEGEN
```

> [!warning] 生产避坑
> 生产中不要禁用 CodeGen（除非有充分的调试理由）。CodeGen 是 Spark SQL 性能的重要基础，禁用后性能通常下降 2-5 倍。如果遇到 "Generated code exceeds 64KB limit" 错误（Janino 对单方法字节码大小有 64KB 限制），说明 CodeGen 融合的算子数过多，可以通过增加 Exchange 节点（如手动添加 `repartition()`）来打断过长的 CodeGen 链。

---

## 小结

Whole-Stage CodeGen 是 Spark SQL 在 CPU 效率层面的核心优化：

- **问题根源**：Volcano 迭代器模型对 10 亿行数据产生 10 亿次 `next()` 虚方法调用，JIT 无法内联，`InternalRow` 传递有额外开销
- **解决思路**：针对具体物理计划动态生成专用 Java 代码，将多算子逻辑融合为单个紧密循环，消灭虚方法调用开销
- **实现机制**：`produce()/consume()` Push 模型；每个支持 CodeGen 的算子实现 `doGenCode()`；`CollapseCodegenStages` 将连续 CodeGen 算子包裹为 `WholeStageCodegenExec`；Janino 动态编译为字节码
- **融合边界**：`ShuffleExchange`（天然边界）、不支持 CodeGen 的算子（SortMergeJoin、WindowExec 等）会截断 CodeGen 链
- **性能收益**：简单查询 3-5x，聚合 2-4x；IO 瓶颈场景收益有限
- **调试工具**：`explain("codegen")` 查看生成代码；`*` 前缀标识 CodeGen 区域

第 08 篇将进入向量化执行引擎的世界：CodeGen 在"消灭虚调用"上做到了极致，但仍然是逐行处理（每行一次循环迭代）。向量化执行将处理单元从"一行"提升到"一批列数据"，配合 CPU 的 SIMD 指令，实现真正的并行数据处理。

---

> [!note] 思考题
> 1. Whole-Stage CodeGen 将多个算子融合成一个紧凑的 `next()` 循环，消除了 Volcano 模型的虚函数调用开销。但 JVM 的 JIT 编译器本身也会对虚函数调用进行内联优化（Inline Cache）。在什么情况下，不使用 CodeGen 的 Volcano 模型经过 JIT 充分预热后，性能反而可以接近 CodeGen？
> 2. CodeGen 生成的 Java 代码在运行时通过 `Janino` 编译器动态编译。如果一个复杂 SQL 生成的代码超过 JVM 方法大小限制（64KB 字节码），会发生什么？Spark 是如何处理这个边界的？
> 3. CodeGen 的 `produce()/consume()` 模型是一种 Push 驱动的数据流模型，与 Volcano 的 Pull 模型相反。在包含 `Sort` 或 `HashAggregate` 这类需要"积累所有数据才能输出"的算子时，Push 模型会如何处理？这是否意味着这些算子天然成为 CodeGen 的边界点？

## 参考资料

- Neumann T: Efficiently Compiling Efficient Query Plans for Modern Hardware（VLDB 2011）——produce/consume 模型的原始论文
- Graefe G: Volcano—An Extensible and Parallel Query Evaluation System（IEEE TKDE 1994）——Volcano 模型原始论文
- [Deep Dive into Spark SQL's Catalyst Optimizer（Databricks Blog）](https://www.databricks.com/blog/2015/04/13/deep-dive-into-spark-sqls-catalyst-optimizer.html)
- Apache Spark 源码：`org.apache.spark.sql.execution.WholeStageCodegenExec`
- Apache Spark 源码：`org.apache.spark.sql.execution.CodegenSupport`
- Apache Spark 源码：`org.apache.spark.sql.catalyst.expressions.codegen.CodegenContext`
