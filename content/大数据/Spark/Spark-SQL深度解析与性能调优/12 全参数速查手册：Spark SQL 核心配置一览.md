---
title: "全参数速查手册：Spark SQL 核心配置一览"
date: 2026-02-28
tags: [AQE, CBO, IO, Join, Shuffle, Spark, SparkSQL, 内存, 调优参数, 速查手册, 配置参数]
aliases: []
---

# 12 全参数速查手册：Spark SQL 核心配置一览

## 摘要

本篇是本专栏的参考手册，汇总 Spark SQL 中最重要的配置参数。每个参数给出：默认值、作用、调优建议与典型值域，以及对应的专栏章节引用，方便在实际工作中快速查阅定位。参数按功能域分类：**查询优化（CBO/RBO）**、**自适应查询执行（AQE）**、**Join 策略**、**Shuffle**、**内存管理**、**I/O 与数据源**、**CodeGen 与执行引擎**、**资源配置**。所有参数均基于 Spark 3.2+ 版本，部分参数在早期版本默认值不同，使用时请注意版本差异。

---

## 第 1 章 查询优化器参数

### 1.1 CBO（代价优化器）

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.cbo.enabled` | `false` | 开启 CBO（基于代价的优化器）。开启后 Catalyst 在逻辑优化阶段使用统计信息估算代价，指导 Join 策略和 Join 顺序选择 | **生产建议开启**（`true`），前提是已为关键表收集统计信息（`ANALYZE TABLE`）。无统计信息时 CBO 回退到默认估算，无副作用 |
| `spark.sql.cbo.joinReorder.enabled` | `false` | 开启多表 Join 的动态规划重排序。需要 CBO 开启（`cbo.enabled=true`）。对三张表以上的 Join 效果显著 | 有三张及以上表 Join 且均有统计信息时**强烈建议开启** |
| `spark.sql.cbo.joinReorder.dp.threshold` | `12` | Join Reordering 动态规划的最大参与表数。超过此数量的表回退到贪心顺序 | 默认 12 张表已覆盖绝大多数场景，无需修改。超大星型模型（20+ 维表）可适当调大，但代价是 Driver 端规划时间增加 |
| `spark.sql.statistics.histogram.enabled` | `false` | 为列统计信息收集等高直方图。直方图使基数估算对倾斜数据更精确 | 对有已知倾斜列（如 `status`、`category`）的表，建议开启后重新 `ANALYZE TABLE` |
| `spark.sql.statistics.histogram.numBins` | `254` | 等高直方图的桶数 | 默认值适合大多数场景，数据分布极不均匀时可调大到 512 |

**快速使用**：
```sql
-- 收集统计后开启 CBO
ANALYZE TABLE orders COMPUTE STATISTICS FOR COLUMNS userId, amount, category;
SET spark.sql.cbo.enabled=true;
SET spark.sql.cbo.joinReorder.enabled=true;
```

### 1.2 RBO 关键规则开关

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `spark.sql.optimizer.excludedRules` | `""` | 逗号分隔的规则类名，指定的规则从 Catalyst 优化器中排除。**调试专用**，生产中不应排除任何规则 |
| `spark.sql.optimizer.maxIterations` | `100` | Catalyst 规则批次的最大迭代轮数。极个别情况下规则未收敛会达到此上限并报 Warning |
| `spark.sql.subexpressionElimination.enabled` | `true` | 公共子表达式消除（CSE）。相同的表达式在同一 Task 内只计算一次 |
| `spark.sql.optimizer.nestedSchemaPruning.enabled` | `true` | 嵌套 Schema 裁剪（Struct 类型只读取实际需要的字段）。对宽嵌套表效果显著 |

---

## 第 2 章 自适应查询执行（AQE）

### 2.1 AQE 核心开关

| 参数 | 默认值（Spark 3.2+） | 说明 | 调优建议 |
|------|---------|------|---------|
| `spark.sql.adaptive.enabled` | `true` | 开启 AQE。Spark 3.2 起默认开启 | **保持默认开启**。极短微批次查询（< 10s）可考虑关闭以避免 Stage 间等待开销 |
| `spark.sql.adaptive.forceApply` | `false` | 强制所有查询使用 AQE（包括不含 Exchange 或 Subquery 的查询）。默认只有含 Shuffle/Broadcast 的查询才包装为 AQE | 通常不需要修改 |

### 2.2 动态分区合并

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.adaptive.coalescePartitions.enabled` | `true` | 开启动态分区合并 | 保持开启 |
| `spark.sql.adaptive.coalescePartitions.minPartitionNum` | `1` | 合并后的最小分区数（防止过度合并导致并行度为 1） | 对于大集群，可设为 `spark.default.parallelism / 2`，确保保留足够并行度 |
| `spark.sql.adaptive.coalescePartitions.initialPartitionNum` | 等于 `shuffle.partitions` | AQE 合并的初始分区数上限（AQE 从此数向下合并，不会向上拆分）| 配合 `shuffle.partitions` 设大（如 1000）使用 |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | `64MB` | 合并的目标分区大小。AQE 尝试将相邻小分区合并到接近此大小 | 网络 I/O 快的集群可设 128MB；存储是 S3 等高延迟对象存储时可设 256MB |

### 2.3 动态 Join 策略切换

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.adaptive.localShuffleReader.enabled` | `true` | 当 Shuffle 数据与 Executor 在同一节点时，使用本地读取（避免网络传输）。AQE 结合 BroadcastHashJoin 切换时自动利用此功能 | 保持开启 |
| `spark.sql.autoBroadcastJoinThreshold` | `10MB` | 自动 Broadcast Join 的阈值。物理规划阶段和 AQE 动态切换都使用此值 | **生产建议 10-50MB**。不要设超过 `executor.memory * 0.2` 的值，防止 OOM |

### 2.4 Skew Join

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.adaptive.skewJoin.enabled` | `true` | 开启 AQE Skew Join 自动处理 | 保持开启 |
| `spark.sql.adaptive.skewJoin.skewedPartitionFactor` | `5` | 倾斜判定因子：分区大小 > 中位数 × 此因子，才认定为倾斜 | 数据整体均匀但偶发倾斜时，可降低到 3；频繁误判时，可调高到 10 |
| `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` | `256MB` | 倾斜分区的绝对大小阈值。必须同时满足因子和绝对大小两个条件才认定倾斜 | 数据量普遍较小的场景可降到 64MB；大规模集群（TB 级 Stage）可调高到 512MB |

---

## 第 3 章 Join 策略参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.autoBroadcastJoinThreshold` | `10MB`（10485760）| 小于此阈值的表自动 Broadcast。设为 `-1` 禁用自动 Broadcast | 见上文，建议 10-50MB |
| `spark.sql.join.preferSortMergeJoin` | `true` | 当两侧都满足 SortMergeJoin 和 ShuffledHashJoin 时，优先选 SortMergeJoin（更省内存，可 Spill）。设为 `false` 时优先 ShuffledHashJoin（更快，但内存要求高）| 内存充足的集群可设 `false` 以获得更快的 Join |
| `spark.sql.broadcastTimeout` | `300`（秒） | Broadcast 等待超时时间（秒）。Broadcast 数据需先在 Driver 端收集，超时后 Task 报错 | 如果 Broadcast 的表很大（50-100MB）且网络慢，可适当调大到 600 秒 |
| `spark.sql.shuffle.partitions` | `200` | Shuffle 分区数。对所有包含 Shuffle 的操作全局生效（除非 AQE 动态合并） | 开启 AQE 后建议设 **500-2000**（大值，让 AQE 往下合并）。未开启 AQE 时，根据数据量设置：每个分区约 128-256MB 数据为宜 |

### 3.1 Bucket Join 相关

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `spark.sql.sources.bucketing.enabled` | `true` | 启用分桶表的 Bucket Join 优化 |
| `spark.sql.sources.bucketing.maxBuckets` | `100000` | 创建分桶表时允许的最大桶数 |
| `spark.sql.bucketing.coalesceBucketsInJoin.enabled` | `false` | 当两张分桶表桶数不同时（如 256 vs 128），对桶数多的表做局部 Shuffle 以匹配少的那张，实现部分 Bucket Join | 两表桶数有整数倍关系时建议开启 |

---

## 第 4 章 Shuffle 参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.shuffle.partitions` | `200` | 见上文 Join 章节 | |
| `spark.shuffle.compress` | `true` | 压缩 Shuffle 数据（Map 输出文件）。减少磁盘写入量和网络传输量 | 保持默认。计算密集型作业（Shuffle 数据量小）可关闭以节省压缩 CPU 开销 |
| `spark.shuffle.spill.compress` | `true` | 压缩 Shuffle Spill 数据 | 保持默认 |
| `spark.reducer.maxSizeInFlight` | `48MB` | 每个 Reduce Task 同时拉取的最大 Shuffle 数据量。控制网络并发 | 网络带宽充足时可调大（96MB、192MB），加速 Shuffle 读取 |
| `spark.shuffle.file.buffer` | `32KB` | Shuffle Map 输出的文件缓冲区大小 | 对磁盘 I/O 密集型 Shuffle，可调大到 64KB-256KB |
| `spark.shuffle.sort.bypassMergeThreshold` | `200` | 当 Reduce 分区数 <= 此值且无需聚合时，使用 bypass merge sort 模式（不排序，直接按分区写文件），速度更快 | 小 Shuffle 分区数场景下提速明显，可适当调大 |

---

## 第 5 章 内存管理参数

### 5.1 Executor 内存配置

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.executor.memory` | `1g` | Executor JVM 堆内存 | 生产建议 **4g-16g**，根据数据量和 Shuffle 大小调整 |
| `spark.executor.memoryOverhead` | `executorMemory * 0.1`，最小 384MB | Executor 堆外内存（用于 JVM Native、Shuffle Buffer、NIO Direct Buffer 等）。YARN Container = `executor.memory + memoryOverhead` | 使用堆外 ColumnVector 或 Arrow 时建议设为 `executor.memory * 0.2`，至少 1g |
| `spark.executor.pyspark.memory` | 不限 | PySpark 进程（Python Worker）的最大内存。在 YARN 模式下，Python 进程内存也计入 Container 总内存 | 使用 Pandas UDF 时建议显式设置，防止 Python 进程内存超出 Container 限制 |

### 5.2 Spark 内存分区

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.memory.fraction` | `0.6` | JVM 堆内存中用于 Spark 托管内存（Execution + Storage）的比例。剩余 40% 是用户代码和 Spark 内部结构的保留空间 | 纯计算作业（少量 UDF 对象）可调高到 0.7；大量自定义数据结构时保持 0.6 |
| `spark.memory.storageFraction` | `0.5` | Spark 托管内存中用于 Storage（缓存）的比例。另 50% 用于 Execution（Sort/Hash/Shuffle） | 缓存大量数据时可调高 Storage 比例（0.6）；减少缓存增加计算空间时调低（0.3） |
| `spark.memory.offHeap.enabled` | `false` | 开启堆外内存用于 Spark 托管操作（如 Tungsten 堆外分配）。需要同时设置 `offHeap.size` | 大内存压力 + 频繁 GC 时开启。`offHeap.size` 设为 `executor.memory * 0.5` 左右 |
| `spark.memory.offHeap.size` | `0` | 每个 Executor 的堆外内存大小（字节）。开启 `offHeap.enabled` 时生效 | |

### 5.3 广播变量内存

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `spark.broadcast.blockSize` | `4MB` | 广播变量分块传输的块大小。影响 TorrentBroadcast 的传输效率 |
| `spark.broadcast.compress` | `true` | 压缩广播变量。建议保持开启（减少序列化大小和网络传输） |

---

## 第 6 章 I/O 与数据源参数

### 6.1 Parquet

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.parquet.enableVectorizedReader` | `true` | 开启 Parquet 向量化读取（返回 `ColumnarBatch` 而非逐行 `InternalRow`）| 保持开启。仅当有不支持的嵌套类型时 Spark 自动回退 |
| `spark.sql.parquet.columnarReaderBatchSize` | `4096` | 向量化读取的 Batch 大小（行数）| 内存充裕时可调大到 8192；内存紧张时调小到 2048 |
| `spark.sql.parquet.filterPushdown` | `true` | 开启谓词下推到 Parquet Row Group 级别（利用 MIN/MAX 统计跳过 Row Group）| 保持开启 |
| `spark.sql.parquet.recordLevelFilter.enabled` | `false` | 在 Parquet 读取时启用行级过滤（在 Page 内逐行应用过滤条件）。比 Row Group Skip 更细粒度 | 高选择率过滤（过滤掉 90%+ 的行）时建议开启 |
| `spark.sql.parquet.compression.codec` | `snappy` | 写入 Parquet 时的压缩算法。可选：`none`、`snappy`、`gzip`、`lzo`、`zstd`、`brotli` | 生产推荐 `zstd`（压缩率优于 snappy，解压速度接近），或保持 `snappy`（最广泛兼容） |
| `spark.sql.files.maxPartitionBytes` | `128MB` | 读取文件时单个分区（Task）最大处理的字节数。控制 Scan 的并行度 | 文件过大时调小（64MB）增加并行度；小文件合并读取时调大（256MB）减少 Task 数 |
| `spark.sql.files.openCostInBytes` | `4MB` | 估算打开一个文件的代价（字节等效）。用于合并小文件到同一 Split：如果一个文件 < `openCostInBytes`，倾向于将其与相邻文件合并为一个 Task | 小文件场景下调大此值（16MB），促进小文件合并，减少 Task 数 |

### 6.2 ORC

| 参数 | 默认值 | 说明 |
|------|-------|------|
| `spark.sql.orc.enableVectorizedReader` | `true` | 开启 ORC 向量化读取 |
| `spark.sql.orc.filterPushdown` | `true` | 谓词下推到 ORC Row Group |
| `spark.sql.orc.columnarReaderBatchSize` | `4096` | ORC 向量化读取的 Batch 大小 |

### 6.3 分区发现与元数据

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.hive.metastorePartitionPruning` | `true` | 将分区过滤条件下推到 Hive Metastore 查询（只列举满足条件的分区，而非获取全部分区再过滤）| 保持开启。分区数量多（> 1 万）时，对 Driver 端的元数据获取速度影响显著 |
| `spark.sql.sources.partitionOverwriteMode` | `static` | 分区表覆盖写入模式。`static`：覆盖全表；`dynamic`：只覆盖写入的分区（保留未涉及的分区）| 增量写入分区表时，**强烈建议设为 `dynamic`**，防止覆盖未涉及的历史分区 |
| `spark.sql.optimizer.dynamicPartitionPruning.enabled` | `true` | 开启动态分区裁剪（DPP）。星型模型查询的关键优化，根据维表 Join 结果动态过滤事实表分区 | 保持开启 |
| `spark.sql.optimizer.dynamicPartitionPruning.useStats` | `true` | DPP 决策时使用表统计信息（若维表过滤后数据量 > 某阈值则不做 DPP）| 保持默认 |

---

## 第 7 章 CodeGen 与执行引擎参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.codegen.wholeStage` | `true` | 开启 Whole-Stage CodeGen | 保持开启。调试时可临时关闭以观察纯解释执行的性能基线 |
| `spark.sql.codegen.maxFields` | `100` | 单个 Whole-Stage CodeGen 代码块中允许的最大字段数。超过此数量的 Stage 不做 CodeGen（防止生成的 Java 方法过大超过 JVM 64KB 限制）| 宽表（100+ 列）的查询可能触发此限制，可适当调大（200），但需关注 64KB 方法限制 |
| `spark.sql.codegen.hugeMethodLimit` | `65536` | 单个生成方法允许的最大字节码大小（字节）。超过时回退到解释执行 | 极少需要修改 |
| `spark.sql.codegen.fallback` | `true` | CodeGen 失败时是否回退到解释执行（而不是报错）| 保持默认（允许回退）。生产中应确保 CodeGen 正常工作，不依赖 fallback |
| `spark.sql.codegen.aggregate.fastHashMap.enabled` | `true` | 为 HashAggregate 开启快速 HashMap（使用专用的紧凑 HashMap，比 Java HashMap 内存效率高）| 保持开启 |
| `spark.sql.execution.arrow.pyspark.enabled` | `false` | 开启 Arrow 优化 `toPandas()`/`createDataFrame()` 操作 | **使用 PySpark + Pandas 的场景必须开启**，性能提升 10-100 倍 |
| `spark.sql.execution.arrow.maxRecordsPerBatch` | `10000` | Arrow 批处理的最大行数 | 内存充足时可调大（50000）；`toPandas()` 返回大表时适当调大以减少批次数 |
| `spark.sql.columnVector.offheap.enabled` | `false` | 使用堆外内存存储 ColumnVector（向量化读取的列数据）| 大规模向量化读取 + 频繁 GC 时开启。需要配合 `memoryOverhead` 设置足够堆外空间 |

---

## 第 8 章 资源与并行度参数

### 8.1 Executor 资源

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.executor.cores` | `1`（local）/ YARN 默认 | 每个 Executor 的 CPU 核数 | 建议 **3-5 核**。过多核会增加单 Executor 内存压力（多 Task 共享堆）；过少则 Executor 创建开销高 |
| `spark.executor.instances` | 无默认（YARN 动态分配） | 静态 Executor 数量 | 与动态分配二选一。静态分配适合资源独占场景 |
| `spark.dynamicAllocation.enabled` | `false` | 开启动态 Executor 分配（根据 Task 队列自动增减 Executor）| 共享集群强烈建议开启 |
| `spark.dynamicAllocation.minExecutors` | `0` | 动态分配的最小 Executor 数 | 设为 1-5，避免完全释放 Executor 后重新申请的延迟 |
| `spark.dynamicAllocation.maxExecutors` | `∞` | 动态分配的最大 Executor 数 | 根据集群规模和业务优先级设上限，避免单个作业占用所有资源 |
| `spark.dynamicAllocation.executorIdleTimeout` | `60s` | Executor 空闲超过此时间后被释放 | 调度密集型作业可调大（300s），避免频繁释放和申请 |

### 8.2 任务并行度

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.default.parallelism` | 对 YARN 等是 `max(totalCores, 2)` | RDD 操作（非 SQL）的默认分区数 | Spark SQL 优先使用 `shuffle.partitions`，此参数主要影响 RDD API |
| `spark.task.cpus` | `1` | 每个 Task 占用的 CPU 核数 | 通常为 1。对于需要多线程的 Task（如使用 BLAS 的 ML 算子），可设为 2-4 |
| `spark.task.maxFailures` | `4` | Task 失败重试最大次数（超过后 Job 失败） | 网络不稳定的集群可调大到 8；对数据准确性要求极高时降到 1-2 |
| `spark.speculation` | `false` | 开启推测执行（慢 Task 被推测性地在其他 Executor 上重新启动，取先完成的结果）| **数据倾斜场景不建议开启**（慢 Task 是因为数据多，不是节点问题，推测执行会浪费资源）。节点硬件不均衡时可考虑开启 |

---

## 第 9 章 SQL 行为参数

| 参数 | 默认值 | 说明 | 调优建议 |
|------|-------|------|---------|
| `spark.sql.ansi.enabled` | `false` | 开启 ANSI SQL 合规模式。开启后整数溢出、除以零等会抛出异常（而不是返回 NULL）| 数据质量要求严格的场景建议开启 |
| `spark.sql.legacy.timeParserPolicy` | `EXCEPTION` | 时间解析策略（`EXCEPTION`/`LEGACY`/`CORRECTED`）。影响 `to_timestamp`、`to_date` 等函数的行为 | 从 Spark 2.x 迁移时可设为 `LEGACY` 保持兼容性 |
| `spark.sql.storeAssignmentPolicy` | `ANSI` | 向表写入数据时的类型转换策略（`ANSI`/`LEGACY`/`STRICT`） | 迁移旧 Hive ETL 时可设为 `LEGACY` |
| `spark.sql.mapKeyDedupPolicy` | `LAST_WIN` | Map 类型中重复 Key 的处理策略（`LAST_WIN`/`EXCEPTION`） | 数据质量敏感的场景设为 `EXCEPTION` 提前发现问题 |
| `spark.sql.sources.default` | `parquet` | `spark.read.load(path)` 不指定格式时的默认数据源 | 保持默认（parquet） |
| `spark.sql.legacy.createHiveTableByDefault` | `false` | `CREATE TABLE` 时是否默认创建 Hive 表（Spark 3.0 后默认创建 Datasource 表）| 使用 Hive Metastore 的场景可设为 `true` 保持与 Hive 的兼容性 |

---

## 第 10 章 参数速查索引

按问题场景快速定位参数：

**查询太慢，不知道从哪里优化**
→ 先看 Spark UI，再对照第 11 篇五步诊断法；开启 `spark.sql.adaptive.enabled=true`（AQE）和 `spark.sql.cbo.enabled=true`（CBO）

**Shuffle 太慢或数据量太大**
→ `spark.sql.shuffle.partitions`（分区数）+ AQE 动态合并 + 检查 Join 是否可以改为 Broadcast

**Join 选了错误策略**
→ `spark.sql.autoBroadcastJoinThreshold`（调整 Broadcast 阈值）+ `BROADCAST` Hint + `ANALYZE TABLE` 更新统计

**数据倾斜**
→ `spark.sql.adaptive.skewJoin.enabled=true`（AQE Skew Join）+ 手动 Salting（第 10 篇）

**OOM**
→ `spark.executor.memory` + `spark.executor.memoryOverhead` + `spark.sql.shuffle.partitions`（增大分区数减小单分区数据量）

**I/O 太慢（读数据慢）**
→ `spark.sql.parquet.enableVectorizedReader=true`（向量化读取）+ 分区裁剪（检查 WHERE 条件）+ DPP（`dynamicPartitionPruning.enabled=true`）

**PySpark Pandas 交互慢**
→ `spark.sql.execution.arrow.pyspark.enabled=true`

**小文件太多，Task 调度慢**
→ `spark.sql.files.maxPartitionBytes`（合并小文件读取）+ 定期 Compaction 合并写入

**多表 Join 顺序不合理**
→ `spark.sql.cbo.joinReorder.enabled=true` + `ANALYZE TABLE` 收集统计信息

**分区覆盖写入误删历史数据**
→ `spark.sql.sources.partitionOverwriteMode=dynamic`

---

## 附录：生产集群推荐基础配置

以下是一套适合中大规模（100-1000 台节点）生产 Spark SQL 集群的基础配置，可根据实际情况调整：

```properties
# ===== 核心优化器 =====
spark.sql.adaptive.enabled=true
spark.sql.adaptive.coalescePartitions.enabled=true
spark.sql.adaptive.advisoryPartitionSizeInBytes=128MB
spark.sql.adaptive.skewJoin.enabled=true
spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes=256MB
spark.sql.cbo.enabled=true
spark.sql.cbo.joinReorder.enabled=true

# ===== Shuffle =====
spark.sql.shuffle.partitions=1000
spark.sql.autoBroadcastJoinThreshold=50MB
spark.reducer.maxSizeInFlight=96MB

# ===== 内存 =====
spark.executor.memory=8g
spark.executor.memoryOverhead=2g
spark.memory.fraction=0.6
spark.memory.storageFraction=0.4

# ===== I/O =====
spark.sql.parquet.enableVectorizedReader=true
spark.sql.parquet.columnarReaderBatchSize=4096
spark.sql.orc.enableVectorizedReader=true
spark.sql.files.maxPartitionBytes=256MB
spark.sql.files.openCostInBytes=16MB
spark.sql.sources.partitionOverwriteMode=dynamic
spark.sql.optimizer.dynamicPartitionPruning.enabled=true

# ===== 资源 =====
spark.dynamicAllocation.enabled=true
spark.dynamicAllocation.minExecutors=2
spark.dynamicAllocation.maxExecutors=500
spark.executor.cores=4

# ===== PySpark（如使用 Python）=====
spark.sql.execution.arrow.pyspark.enabled=true
spark.sql.execution.arrow.maxRecordsPerBatch=20000
```

> [!note] 设计哲学
> 没有"万能的最优配置"。上述配置是经验值的起点，不是终点。每个生产集群的数据特征（规模、Schema、分区方式）、查询模式（OLAP 探索、ETL 批处理、实时分析）和硬件环境（CPU 型号、内存大小、SSD/HDD、网络带宽）都不同。真正的调优，是理解每个参数的底层原理（本专栏的核心目标），然后根据对自己业务和系统的深刻理解，做出正确的权衡决策。

---

## 小结

本篇汇总了 Spark SQL 全链路的核心配置参数，覆盖：

- **查询优化器**：CBO（`cbo.enabled`、`joinReorder.enabled`）、统计直方图、RBO 规则控制
- **AQE**：总开关、动态分区合并（`coalescePartitions`、`advisoryPartitionSizeInBytes`）、Skew Join（`skewedPartitionFactor`、`skewedPartitionThresholdInBytes`）
- **Join**：Broadcast 阈值、SortMerge vs ShuffledHash 偏好、Bucket Join、分区数
- **Shuffle**：分区数、压缩、Buffer 大小
- **内存**：Executor 堆内/堆外、Spark 内存分区比例、Broadcast 内存
- **I/O**：向量化读取、谓词下推、分区发现、DPP、文件合并读取
- **CodeGen**：Whole-Stage CodeGen、Arrow
- **资源**：动态分配、并发度、Task 重试

至此，「Spark SQL 深度解析与性能调优」专栏全部 12 篇完成。从 SQL 文本到 RDD 执行的完整旅程（第 01 篇），经过解析与分析（02）、逻辑优化（03）、代价模型（04）、物理规划（05）、运行时自适应（06）、CodeGen（07）、向量化（08）、I/O 优化（09）、倾斜解决（10）、调优实战（11），最终以本篇参数手册（12）收尾——每一层都讲清楚了"是什么→为什么→不这样会怎样→在 Spark 中如何落地→边界与反例"，构建了一套完整的 Spark SQL 性能优化知识体系。

---

> [!note] 思考题
> 1. `spark.sql.shuffle.partitions` 默认值为 200，这个值来自 Hadoop MapReduce 时代的经验数字，并不适用于所有场景。开启 AQE 后这个参数的角色发生了变化——它从"最终分区数"变成了"初始上限"。在 AQE 环境下，这个参数设置过小（比如 10）会引发什么问题？设置过大（比如 10000）又会带来哪些额外开销？
> 2. CBO 相关参数（如 `spark.sql.cbo.enabled`、`spark.sql.cbo.joinReorder.enabled`）默认是关闭的。Spark 为什么不默认开启 CBO？在哪些典型场景下，开启 CBO 反而会导致查询变慢，产生比 RBO 更差的执行计划？
> 3. `spark.sql.autoBroadcastJoinThreshold` 控制广播阈值，但 Spark 估算表大小的方式依赖统计信息——如果统计信息缺失，Spark 会依赖文件大小估算，而文件大小与内存中的数据大小可能相差数倍（Parquet 压缩比、解压后膨胀）。在什么情况下这种估算误差会导致超出 Driver/Executor 内存的广播操作？如何设置安全上限？

## 参考资料

- Apache Spark 官方文档：Configuration（spark.apache.org/docs/latest/configuration.html）
- Apache Spark 官方文档：SQL Configuration（spark.apache.org/docs/latest/sql-performance-tuning.html）
- Databricks 官方文档：Performance Tuning and Best Practices
- 《High Performance Spark》（Holden Karau, Rachel Warren，O'Reilly 2017）
- Spark 源码：`org.apache.spark.sql.internal.SQLConf`（所有 SQL 相关配置的权威定义）
