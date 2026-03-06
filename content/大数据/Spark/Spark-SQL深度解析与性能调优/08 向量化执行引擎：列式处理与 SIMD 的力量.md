---
title: "向量化执行引擎：列式处理与 SIMD 的力量"
date: 2026-02-28
tags: [Spark, SparkSQL, 向量化执行, Vectorized Execution, ColumnarBatch, Arrow, SIMD, Parquet向量化读取, 列式存储]
aliases: []
---

# 08 向量化执行引擎：列式处理与 SIMD 的力量

## 摘要

Whole-Stage CodeGen 消灭了 Volcano 模型的虚方法调用开销，但本质上仍然是**逐行处理**——每次循环迭代处理一行数据，CPU 在每次迭代之间都要维护状态、判断分支。向量化执行（Vectorized Execution）将处理单元从"单行"提升为"一批列数据"（通常 1024 或 4096 行），一次操作作用于整列数据。这一转变带来了两个质变：第一，列式内存布局（同一列的数据连续存储）与 CPU 缓存行（Cache Line）天然匹配，prefetch 机制充分发挥；第二，同类型的列数据可以利用 CPU 的 **SIMD（Single Instruction Multiple Data）** 指令，一条指令同时对 8/16/32 个数据元素做运算，硬件级并行度大幅提升。Spark SQL 的向量化执行体现在两个维度：**向量化文件读取**（Parquet/ORC Vectorized Reader，以 `ColumnarBatch` 而非逐行返回数据）和**向量化算子执行**（DataFusion 风格的列式算子，以及 Apache Arrow 提供的跨语言列式内存标准）。本文深度拆解向量化执行的物理原理（CPU 缓存、SIMD 指令集、列式内存布局）、Spark 的 Parquet 向量化读取实现、`ColumnarBatch` 的内存模型、向量化算子的设计与局限，以及如何通过配置发挥向量化读取的最大效益。

---

## 第 1 章 从逐行到逐列：处理粒度的跃升

### 1.1 逐行处理的 CPU 效率瓶颈

第 07 篇讲到，Whole-Stage CodeGen 将多算子逻辑融合为单循环，消灭了虚方法调用。融合后的代码形如：

```java
for (int rowIdx = 0; rowIdx < numRows; rowIdx++) {
    double amount = amountCol.getDouble(rowIdx);   // 读第 rowIdx 行的 amount
    if (amount <= 100.0) continue;
    UTF8String userId = userIdCol.getUTF8String(rowIdx);
    // ... 聚合逻辑 ...
}
```

这段代码已经非常高效，但仍然有一个隐藏的 CPU 效率问题：**逐行处理不利于 SIMD 向量化指令**。

现代 CPU 的 SIMD 指令集（Intel 的 AVX2、AVX-512，ARM 的 NEON/SVE）提供了对多个数据元素同时操作的指令：
- `_mm256_add_pd`（AVX2）：一条指令同时对 4 个 `double` 做加法
- `_mm512_cmpgt_epi64`（AVX-512）：一条指令同时比较 8 个 `long` 与阈值

但要使用 SIMD，数据必须满足：**同类型数据连续排列在内存中**，能被 SIMD 指令一次性加载到向量寄存器（如 256bit 的 YMM 寄存器恰好容纳 4 个 `double`）。

**逐行布局（行式存储）**：

```
内存中的数据：
[row0: userId=A, amount=100.5, ts=...][row1: userId=B, amount=200.3, ts=...][row2: ...]
```

`amount` 字段分散在各行之间，相邻 `amount` 值之间有其他字段隔开。SIMD 指令无法一次性加载连续的 4 个 `amount` 值（因为它们在内存中不连续），必须逐个加载，无法利用向量化指令。

**列式布局（列式存储）**：

```
内存中的数据（同一列连续存储）：
amount 列: [100.5, 200.3, 350.0, 89.1, 432.5, 77.2, ...]
userId 列: [A, B, C, D, E, F, ...]
```

`amount` 的所有值连续排列，SIMD 指令可以一次加载 4 个（AVX2）或 8 个（AVX-512）`double` 到向量寄存器，一条比较指令完成 4/8 行的过滤判断。

### 1.2 CPU 缓存行与列式存储的天然契合

CPU 缓存（L1/L2/L3）以 **Cache Line**（通常 64 字节）为单位从内存加载数据。每次访问内存时，即使只读一个字节，CPU 也会将包含该字节的整个 64 字节 Cache Line 都加载到缓存中。

**行式存储的缓存效率问题**：

处理查询 `SELECT sum(amount) FROM orders`（只需要 `amount` 列），在行式存储中：
- 每行包含 `userId(16B) + orderId(16B) + amount(8B) + ts(8B) + status(4B)` = 52 字节
- 读取 `amount` 时，整个 52 字节的行都被加载到 Cache Line
- 但我们只需要 8 字节的 `amount`，剩余 44 字节是**无效缓存占用**
- Cache 利用率：8/52 ≈ **15%**

**列式存储的缓存效率**：

在列式存储中，`amount` 列的数据连续排列（8 字节 × N 行）：
- 读取 `amount` 时，Cache Line（64 字节）加载 8 个连续的 `amount` 值
- 这 8 个值全部是我们需要的
- Cache 利用率：**100%**

列式存储使 Cache 预取（CPU 的 Hardware Prefetch 机制会自动探测到顺序访问模式，提前将下一个 Cache Line 加载到缓存）和 SIMD 向量化都能充分发挥作用。这是向量化执行比逐行处理快的物理原因。

---

## 第 2 章 Spark 的 ColumnarBatch：列式内存模型

### 2.1 ColumnarBatch 是什么

`ColumnarBatch` 是 Spark SQL 中列式内存数据的核心抽象，代表一批数据行（通常 1024 行）的列式表示：

```scala
class ColumnarBatch(private val columns: Array[ColumnVector]) {
  private var numRows: Int = 0
  
  // 获取第 i 列的 ColumnVector
  def column(i: Int): ColumnVector = columns(i)
  
  // 该 Batch 包含的行数
  def numRows(): Int = numRows
  
  // 按行迭代（转换为 InternalRow，用于不支持列式的算子）
  def rowIterator(): Iterator[InternalRow] = ...
}
```

**`ColumnVector`**（列向量）代表一列数据的连续内存块：

```scala
abstract class ColumnVector(val dataType: DataType) {
  def isNullAt(rowId: Int): Boolean
  def getBoolean(rowId: Int): Boolean
  def getByte(rowId: Int): Byte
  def getShort(rowId: Int): Short
  def getInt(rowId: Int): Int
  def getLong(rowId: Int): Long
  def getFloat(rowId: Int): Float
  def getDouble(rowId: Int): Double
  def getUTF8String(rowId: Int): UTF8String
  def getArray(rowId: Int): ColumnarArray
  // ...
}
```

**两种 ColumnVector 实现**：
- **`OnHeapColumnVector`**：数据存储在 JVM 堆上（`int[]`、`long[]`、`double[]` 等 Java 原始类型数组）
- **`OffHeapColumnVector`**：数据存储在堆外内存（`sun.misc.Unsafe` 分配的本地内存），通过内存地址直接访问

堆外内存的 `OffHeapColumnVector` 避免了 JVM GC 的影响，且 SIMD 指令可以更直接地操作（Java 数组有对象头，不完全适合原始 SIMD 地址对齐）。

### 2.2 Batch Size 的设计权衡

每个 `ColumnarBatch` 包含多少行（Batch Size）是一个工程权衡：

**Batch Size 太小**（如 16 行）：
- 每次循环处理的数据量少，循环控制开销占比大
- SIMD 利用率低（AVX-512 一次处理 8 个 double，Batch 只有 16 行，仅 2 次 SIMD 操作就处理完）

**Batch Size 太大**（如 65536 行）：
- 整个 Batch 的数据可能无法放入 L1/L2 Cache（L1 通常 32KB，L2 通常 256KB）
- Cache Miss 率升高，反而降低效率

**Spark 的默认选择**：

```properties
# Parquet 向量化读取的 Batch 大小（行数），默认 4096
spark.sql.parquet.columnarReaderBatchSize=4096

# Arrow Batch 大小
spark.sql.execution.arrow.maxRecordsPerBatch=10000
```

4096 行 × 8 字节（double）= 32KB，恰好接近 L1 Cache 大小，是兼顾 SIMD 利用率和缓存效率的经验值。

---

## 第 3 章 Parquet 向量化读取

### 3.1 非向量化读取的代价

在没有向量化读取之前，Spark 读取 Parquet 文件的方式：

1. 从 Parquet 文件读取一个 Row Group（通常 128MB）
2. 反序列化每一列的编码数据（Dictionary Encoding、Delta Encoding 等）
3. 将每行的各列数据组装为一个 `UnsafeRow`（行式内存布局）
4. 将 `UnsafeRow` 传给上层算子逐行处理

这个过程的问题：步骤 3 的"列转行"是纯开销——我们从列式存储（Parquet）读取，然后立即把数据从列式重组为行式，失去了列式存储的所有优势。

### 3.2 向量化 Parquet Reader 的实现

当 `spark.sql.parquet.enableVectorizedReader=true`（默认 true），Spark 使用 **`VectorizedParquetRecordReader`**，直接将 Parquet 的列式数据填充到 `ColumnarBatch`，完全跳过行组装步骤：

```
Parquet 文件（列式存储）
    ↓
VectorizedParquetRecordReader
    ↓  直接填充（无列转行）
ColumnarBatch（列式内存）
    ↓
列式算子（直接访问 ColumnVector）
```

**向量化 Reader 的核心优化**：

**优化一：批量解码（Batch Decoding）**

Parquet 的列数据是经过编码压缩的（RLE、Dictionary Encoding 等）。非向量化读取每行解码一个值；向量化读取一次解码整个 Page（通常 64KB~1MB）或整个 Batch（4096 行）的数据，批量写入 `ColumnVector` 的底层数组，减少解码函数调用次数。

**优化二：Dictionary 编码直传（Dictionary Passthrough）**

Parquet 的 Dictionary Encoding 将高基数列（如用户 ID 字符串）压缩为整数代码（类似 ID → index 的映射）。向量化 Reader 可以直接以整数形式传递 Dictionary 编码列，延迟到真正需要字符串时才解码，减少不必要的字符串对象创建。

**优化三：列裁剪在 I/O 层生效**

Parquet 是按列存储的，不同列在文件中物理分离。向量化 Reader 结合 `SparkPlan` 的列裁剪信息，只读取查询中实际需要的列，跳过其他列的磁盘 I/O——这一点在行式存储中无法实现（行式存储必须读完整行再丢弃不需要的列）。

**优化四：谓词下推到行级过滤（Row-Level Filtering）**

向量化 Reader 支持在读取时应用 Filter（行级谓词），对每个 Batch 先执行过滤，丢弃不满足条件的行，避免将无效数据传递给上层算子：

```java
// VectorizedParquetRecordReader 的行级过滤
for (int rowId = 0; rowId < batch.numRows(); rowId++) {
    if (!filterEval.eval(batch, rowId)) {
        batch.markFiltered(rowId);  // 标记为过滤掉
    }
}
```

### 3.3 向量化读取的限制

不是所有数据类型都支持向量化读取：

| 数据类型 | 向量化读取支持 | 备注 |
|---------|-------------|------|
| `INT32`、`INT64` | 完全支持 | 映射到 `int[]`、`long[]` |
| `FLOAT`、`DOUBLE` | 完全支持 | 映射到 `float[]`、`double[]` |
| `BYTE_ARRAY`（字符串）| 支持 | 略慢（变长数据需特殊处理） |
| `FIXED_LEN_BYTE_ARRAY`（Decimal 大值）| 支持（有限）| |
| 嵌套类型（`MAP`、`LIST`） | **不支持** | 需回退到非向量化读取 |
| `INT96` 时间戳（老格式）| 部分支持 | 建议迁移到 `TIMESTAMP_MILLIS` |

当查询涉及嵌套类型列时，Spark 自动回退到非向量化读取。如果表中有嵌套列但查询不涉及它（列裁剪会跳过），不影响其他列的向量化读取。

---

## 第 4 章 列式执行算子

### 4.1 从 ColumnarBatch 到向量化计算

向量化读取给出了 `ColumnarBatch`，但如果上层算子仍然逐行处理（调用 `batch.rowIterator()` 拆成 `InternalRow` 再处理），列式存储的好处在算子层就消失了。

真正的向量化执行需要算子层也支持 `ColumnarBatch` 输入/输出，对整批数据做列式操作：

```scala
// 伪代码：向量化 Filter 算子
class VectorizedFilterExec(condition: Expression) {
  def processColumnarBatch(batch: ColumnarBatch): ColumnarBatch = {
    val selected = new BitSet(batch.numRows())
    val amountCol = batch.column(amountIdx).asInstanceOf[DoubleColumnVector]
    
    // 批量比较（可利用 SIMD）
    for (i <- 0 until batch.numRows()) {
      if (!amountCol.isNullAt(i) && amountCol.getDouble(i) > 100.0) {
        selected.set(i)
      }
    }
    // 返回只包含 selected 行的新 Batch（通过 Selection Vector，不拷贝数据）
    batch.filter(selected)
  }
}
```

### 4.2 Spark 原生向量化算子的现状

Spark 开源版的算子层**大部分仍是逐行处理**，向量化主要体现在 I/O 层（Parquet/ORC 向量化读取）。算子层的向量化是社区持续建设的方向（如 SPARK-27396 系列），但截至 Spark 3.x，原生向量化算子覆盖有限：

- **向量化 HashAggregate**（`spark.sql.execution.enableHashAggregation`）：对简单聚合函数（`SUM`、`COUNT`、`AVG`）做批量处理
- **向量化 Sort**（Tungsten Sort）：使用 UnsafeExternalSorter，数据以二进制格式存储，排序操作直接比较二进制 key，无需反序列化

**商业版（Databricks Photon、Intel Gluten + Velox）**扩展了向量化执行的深度，实现了更多算子的向量化，但这超出了开源 Spark 的范畴。

### 4.3 Apache Arrow 与跨语言列式数据交换

**[[Apache Arrow]]** 是 Apache 基金会提供的跨语言列式内存格式标准，定义了一种与语言无关的、SIMD 友好的列式内存布局。

Spark SQL 在以下场景使用 Arrow：

**场景一：Pandas UDF（Vectorized Python UDF）**

传统 Python UDF 逐行序列化（pickle）数据，跨 JVM/Python 进程传输代价极高。`@pandas_udf` 装饰器的 Pandas UDF 通过 Arrow 格式批量传输数据：

```python
from pyspark.sql.functions import pandas_udf
import pandas as pd

@pandas_udf("double")
def multiply_by_tax(amount: pd.Series) -> pd.Series:
    return amount * 1.1  # 整列操作，向量化
```

数据流：JVM 的 `ColumnarBatch` → Arrow IPC 格式 → Python 进程（Pandas DataFrame） → Arrow IPC → JVM。批量传输代替逐行 pickle，Shuffle 开销降低约 10-100 倍。

**场景二：toPandas() 的优化**

```python
# 不使用 Arrow（默认）：逐行收集，性能差
df.toPandas()

# 使用 Arrow 加速（推荐）
spark.conf.set("spark.sql.execution.arrow.pyspark.enabled", "true")
df.toPandas()  # 通过 Arrow 批量传输，快约 10-30 倍
```

**Arrow 的内存布局**（以 `INT32` 列为例）：

```
validity bitmap（空值位图）:  [1, 1, 0, 1, 1, ...]  // 1=非空, 0=NULL
value buffer（值缓冲）:       [100, 200, 0, 400, 500, ...]  // NULL 位置的值无意义
```

所有同类型值连续存储，满足 SIMD 对齐要求（通常要求 16/32/64 字节对齐）。

---

## 第 5 章 向量化执行的性能收益与配置

### 5.1 性能收益的量化

向量化 Parquet 读取对扫描密集型查询的加速效果最为显著：

| 查询类型 | 无向量化 | 向量化读取 | 向量化算子 | 加速比 |
|---------|---------|---------|---------|------|
| 全表扫描 + 简单过滤 | 基准 | 2-4x | 3-8x | 3-8x |
| 聚合（sum/count） | 基准 | 1.5-3x | 2-5x | 2-5x |
| Join（Broadcast） | 基准 | 1.3-2x | 1.5-3x | 1.5-3x |
| 复杂 UDF | 基准 | 无改善 | 无改善 | 1x |

**收益最大的场景**：
- 宽表（列多，列裁剪效果显著）
- 数据类型以数值型为主（Double、Long、Int）
- 高选择率过滤（过滤掉大量行，避免传递无效数据给上层算子）

### 5.2 关键配置与调优

```properties
# 开启 Parquet 向量化读取（默认 true）
spark.sql.parquet.enableVectorizedReader=true

# 开启 ORC 向量化读取（默认 true）
spark.sql.orc.enableVectorizedReader=true

# 向量化 Batch 大小（行数），影响 Cache 利用率
spark.sql.parquet.columnarReaderBatchSize=4096

# 开启 Arrow 优化 Pandas UDF 与 toPandas()
spark.sql.execution.arrow.pyspark.enabled=true

# Arrow 每批最大行数
spark.sql.execution.arrow.maxRecordsPerBatch=10000

# 使用堆外内存存储 ColumnVector（SIMD 友好，减少 GC）
spark.sql.columnVector.offheap.enabled=true
```

### 5.3 向量化执行的禁用场景

以下场景 Spark 会自动回退到非向量化模式：

1. **嵌套类型列被查询**：`MAP`、`ARRAY`、`STRUCT` 类型列不支持向量化读取
2. **不支持的 Parquet 特性**：某些加密的 Parquet 文件（列级加密），或使用不支持的压缩算法
3. **外部数据源不支持**：非 Parquet/ORC 格式（CSV、JSON、Avro）没有向量化读取实现
4. **Legacy Decimal 类型**：`FIXED_LEN_BYTE_ARRAY` 编码的大精度 Decimal（`scale > 18`）

> [!warning] 生产避坑
> 如果表 Schema 中包含 `MAP` 或 `ARRAY` 类型列，即使查询不涉及这些列，某些 Spark 版本也会对整张表回退为非向量化读取。解决方法：将包含复杂类型的列单独存入另一张子表，主表保持简单类型列，以确保向量化读取正常工作。Spark 3.3+ 改善了这一问题，支持"列级回退"（复杂类型列非向量化，其他列仍向量化）。

---

## 第 6 章 Tungsten：向量化的内存基础

### 6.1 Tungsten 项目的背景

**[[Tungsten]]** 是 Spark 1.4 引入的内存管理与 CPU 效率优化项目，是 Whole-Stage CodeGen 和向量化执行的底层支撑：

1. **堆外内存管理**：通过 `MemoryManager` 和 `TaskMemoryManager` 管理堆外内存，直接操作内存地址，避免 JVM GC 对大内存操作的影响
2. **二进制行格式（UnsafeRow）**：设计了一种紧凑的行式二进制格式，列值以紧密排列的方式存储（固定长度类型直接存值，变长类型存偏移量），支持在不反序列化的情况下直接比较和 Hash
3. **Cache-Aware 算法**：如 `SortMergeJoin` 的外部排序（`UnsafeExternalSorter`）使用了 Cache-Aware 的归并策略，减少排序过程中的 Cache Miss

### 6.2 UnsafeRow：二进制行格式

`UnsafeRow` 是 Spark 内部最常用的行格式，其内存布局设计使得多行数据在内存中紧密排列：

```
UnsafeRow 内存布局（3 列：INT, LONG, STRING）：
┌─────────────────────────────────────────────────────────────┐
│  Null Bitmap (8 bytes)  │  col0: INT (4 bytes) │ col1: LONG │
│  (每列一个 bit 标记是否 NULL) │  (8B aligned)  │  (8 bytes) │
│  col2: offset+length(8B)│  col2 data: string bytes...      │
└─────────────────────────────────────────────────────────────┘
```

对于排序操作，可以直接比较 `UnsafeRow` 的二进制数据而不反序列化——比较两个 `long` 型的 `UnsafeRow` 就是比较两个 64 位整数，速度与比较原始 `long` 相同。

---

## 小结

向量化执行从物理硬件层面提升了 Spark SQL 的执行效率：

- **物理基础**：列式存储与 CPU Cache Line（64 字节）天然匹配，同类型连续数据可利用 SIMD 指令一次操作多个元素；逐行处理则两者都无法充分利用
- **ColumnarBatch**：Spark 的列式内存模型，通常 4096 行为一批，`ColumnVector` 以 `int[]`/`long[]` 等原始数组存储同列数据
- **Parquet 向量化读取**：直接将 Parquet 列数据填充到 `ColumnarBatch`（跳过列转行），支持批量解码、Dictionary 直传、列裁剪 I/O 优化；嵌套类型不支持，自动回退
- **算子层向量化**：Spark 开源版主要在 I/O 层，算子层有限；Pandas UDF 通过 Arrow 实现批量跨进程传输（替代逐行 pickle）
- **Tungsten**：堆外内存管理 + `UnsafeRow` 二进制格式，是向量化执行的内存基础

第 09 篇将转向数据源与 I/O 优化：向量化读取是数据进入执行引擎的最后一段路，而更早的优化发生在文件格式选择、分区裁剪、谓词下推到存储层——这些才是大规模数据处理中 I/O 性能的决定性因素。

---

> [!note] 思考题
> 1. Spark 的向量化执行引擎（`ColumnarBatch`）与 Whole-Stage CodeGen 是两条不同的优化路径，在很多情况下不能同时发挥最大效果。为什么向量化执行和 CodeGen 存在设计上的张力？Databricks 的 Photon 引擎是如何解决这个矛盾的？
> 2. `ColumnarBatch` 的 Batch Size 默认是 4096 行。这个值并非越大越好——增大 Batch Size 会导致 CPU L1/L2 缓存溢出，反而降低 SIMD 效率。在列数很多（比如宽表 200 列）的场景下，你会如何调整 Batch Size？有没有办法动态适配？
> 3. Parquet 向量化读取绕过了 Java 对象的创建，直接将 Parquet 编码数据（如 Dictionary Encoding、RLE）解码到堆外 `WritableColumnVector` 中。但对于用户自定义的复杂类型（如嵌套 STRUCT、MAP），向量化读取会退化为逐行读取。这个退化的根本原因是什么？

## 参考资料

- [Vectorized Query Execution in Apache Spark（Databricks Blog）](https://www.databricks.com/blog/2017/05/23/apache-spark-native-execution.html)
- Apache Arrow 官方文档：Memory Layout
- Apache Spark 源码：`org.apache.spark.sql.vectorized.ColumnarBatch`
- Apache Spark 源码：`org.apache.spark.sql.execution.datasources.parquet.VectorizedParquetRecordReader`
- Apache Spark 源码：`org.apache.spark.sql.catalyst.expressions.codegen.UnsafeRowWriter`
- Willhalm T 等：SIMD-Scan: Ultra Fast in-Memory Table Scan using on-Chip Vector Processing Units（VLDB 2009）
- [Project Tungsten: Bringing Apache Spark Closer to Bare Metal（Databricks Blog）](https://www.databricks.com/blog/2015/04/28/project-tungsten-bringing-spark-closer-to-bare-metal.html)
