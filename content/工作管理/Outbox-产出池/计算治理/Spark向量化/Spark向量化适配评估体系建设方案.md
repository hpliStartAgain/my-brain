# Spark 向量化适配评估体系建设方案

> **版本**: v1.0
> **日期**: 2026-03-20
> **负责人**: 李浩鹏
> **依赖 Spark 版本**: 3.2.3

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状与痛点](#2-现状与痛点)
3. [方案总览](#3-方案总览)
4. [GSS 评分体系设计](#4-gss-评分体系设计)
5. [技术实现架构](#5-技术实现架构)
6. [数据模型与输出表](#6-数据模型与输出表)
7. [分阶段实施计划](#7-分阶段实施计划)
8. [验收标准](#8-验收标准)
9. [风险与规避](#9-风险与规避)

---

## 1. 背景与目标

### 1.1 背景

Gluten + Velox 是 Intel/Meta 联合开源的 Spark 原生向量化加速方案，通过将 Spark SQL 物理算子卸载到 Velox（基于 SIMD 指令集的 C++ 执行引擎），可显著提升 CPU 密集型 SQL 作业的执行性能（典型场景加速比 2x~5x）。

集群当前运行大量 Spark 作业（bdwh、msns 等业务用户），整体 YARN vCore 利用率较高。对部分作业开启 Gluten 向量化，是降低计算资源消耗、提升吞吐的有效手段。

### 1.2 问题

**不是所有作业都适合开启向量化**：

- 纯 RDD 作业、Python 作业、Streaming 作业不经过 Catalyst，Gluten 无法介入
- 含 Hive UDF / Pandas UDF 的作业在向量化引擎中会 fallback 到 JVM，引入额外转换开销
- 频繁的行列格式切换（ColumnarToRow ↔ RowToColumnar）会导致性能负收益
- 盲目开启可能引发 OOM（Velox Off-Heap 内存使用方式与 JVM 不同）

**当前缺乏评估手段**：人工分析作业计划耗时且无法规模化，缺少系统性的适配性评估工具。

### 1.3 目标

建立一套**自动化、离线、无侵入的 Spark 向量化适配评估体系**：

| 目标 | 说明 |
|------|------|
| 自动评估 | 从 EventLog 中自动提取特征，无需修改用户代码 |
| 规模化覆盖 | 批量分析集群全量 Spark 作业 |
| 量化决策 | 输出 0-100 分的 GSS（Gluten Suitability Score），支持按分段决策 |
| 收益预估 | 结合 YARN 资源用量，预估向量化后的 CPU/内存节省量 |

---

## 2. 现状与痛点

### 2.1 作业现状

| 用户 | 典型场景 | 日均作业数 |
|------|---------|-----------|
| bdwh | Hive on Spark ETL、OLAP 查询 | 数百 |
| msns | 数据加工、用户行为分析 | 数十 |
| 其他业务用户 | 自定义 Spark 作业 | 若干 |

### 2.2 已知问题

- **无评估工具**：只能人工查看 EXPLAIN 计划，逐作业判断，无法批量
- **Hive UDF 风险**：自定义 UDF 在向量化引擎中强制 fallback，若大量使用反而增加开销
- **GC 压力**：向量化 Off-Heap 内存需要额外配置，参数配置错误会引发 Container OOM

---

## 3. 方案总览

```
HDFS EventLog（全量 Spark 作业）
        │ 每小时扫描最近1小时修改的文件
        ▼
PantherSparkEventGSSJob（Spark 离线分析作业）
  ├── 事件解析（7类 SparkListener 事件）
  ├── 14个向量化特征检测 UDF
  ├── SQL级 GSS 评分（基于物理执行计划）
  └── Job级 GSS 评分（基于作业类型+指标）
        │
        ▼ 写出 Parquet 分区表
  ┌─────────────────────────────────┐
  │  dwd_panther_spark_stage        │  Stage 性能指标
  │  dwd_panther_spark_job          │  Job 画像 + GSS 评分
  │  dwd_panther_spark_sql_plan     │  SQL 执行计划 + 特征
  └─────────────────────────────────┘
        │
        ▼ 搬运至 Doris
  ads_panther_spark_*_gss（数据服务层）
        │
        ▼
  Panther 大盘 / 向量化白名单遴选工具
```

**核心特点**：
- **零侵入**：仅读取 HDFS 上已有的 EventLog，不修改任何用户作业配置
- **全量分析**：覆盖所有开启了 `spark.eventLog.enabled=true` 的作业
- **按小时滚动**：`dt/hr` 分区，每小时增量更新

---

## 4. GSS 评分体系设计

GSS（Gluten Suitability Score）分两个层次，分别从 SQL 执行计划维度和作业整体维度评估。

### 4.1 SQL 级 GSS（基于物理执行计划）

适用范围：有 SQL 执行计划的作业（SQL CLI、Dataset API）

**基础分 50 分，加减分规则如下**：

| 维度 | 分值 | 说明 |
|------|------|------|
| 列式存储（Parquet/ORC） | +20 | 向量化引擎读取列式格式效率最高 |
| 混合列式格式 | +15 | 同时包含 Parquet + ORC |
| 原生向量化已启用（Batched:true） | +15 | 已开启 Spark 原生向量化，兼容性更佳 |
| 存在 Aggregate 算子 | +10 | HashAgg/SortAgg 是 SIMD 加速收益最大的算子 |
| 纯行式格式（CSV/Text） | -20 | 行格式需逐行解析，向量化无法加速 |
| JSON 半结构化格式 | -10 | 反序列化开销大，向量化加速有限 |
| 行列格式混合 | -15 | 存在行列混用，需额外转换 |
| 行列转换夹层（每次） | -15（上限-60） | ColumnarToRow+RowToColumnar 往返代价高 |
| 包含 Hive UDF | -30 | Hive UDF 强制 fallback 到 JVM |
| 包含 Pandas UDF | -20 | Python UDF 无法向量化 |
| Window 函数 | -15 | 部分 Window 算子向量化支持有限 |
| Shuffle 节点（每个） | -5（上限-10） | Shuffle 是 IO 瓶颈，向量化收益有限 |
| Join 节点 > 5 个 | -10 | 复杂多路 Join 易引发行列转换 |
| 复杂嵌套类型（Map/Array） | -15 | 向量化引擎对复杂类型支持不完整 |

**分数分段与决策建议**：

| 分数段 | 建议 | 说明 |
|--------|------|------|
| ≥ 70 | ✅ 建议开启 | 特征良好，预期有明确收益 |
| 40 ~ 69 | ⚠️ 谨慎评估 | 建议灰度测试，对比开关前后资源用量 |
| < 40 | ❌ 不建议开启 | 特征不匹配，可能负收益 |

### 4.2 Job 级 GSS（基于作业整体特征）

适用范围：所有作业类型（包括 SQL、RDD、Streaming、Python）

**基础分 50 分，加减分规则如下**：

| 维度 | 分值 | 说明 |
|------|------|------|
| SQL CLI / Kyuubi 提交 | +15 | 经过 Catalyst 优化，向量化介入空间最大 |
| Dataset API | +10 | 有部分 SQL 执行计划 |
| CPU 密集度 > 0.5 | +15 | SIMD 加速在 CPU 密集型场景收益最显著 |
| CPU 密集度 0.3~0.5 | +5 | 中等 CPU 密集，有一定收益 |
| 存在 SQL 执行计划 | +10 | Catalyst 生成计划，Gluten 可介入 |
| ANSI 模式未开启 | +5 | 默认模式兼容性更好 |
| Streaming 作业 | -40 | micro-batch 启动开销抵消向量化收益 |
| 纯 RDD 作业 | -50 | 不经过 Catalyst，Gluten 完全无法介入 |
| Python 作业 | -25 | Python UDF 无法向量化，主要逻辑在 Python 侧 |
| CPU 密集度 < 0.1 | -10 | IO 密集型，向量化无法提升 IO 吞吐 |

### 4.3 向量化特征检测 UDF 列表

系统实现了 14 个 Spark UDF，通过正则/字符串匹配对物理执行计划文本进行特征提取：

| UDF | 功能 |
|-----|------|
| `extractInputFormat` | 识别输入数据格式（Parquet/ORC/CSV/Text/JSON） |
| `detectSandwichPattern` | 检测行列转换夹层（ColumnarToRow ↔ RowToColumnar） |
| `detectHiveUDF` | 检测 HiveSimpleUDF / HiveGenericUDF |
| `detectPandasUDF` | 检测 ArrowEvalPython / BatchEvalPython |
| `detectWindowFunction` | 检测 WindowExec 算子 |
| `detectComplexTypes` | 检测 `map<` / `array<` 嵌套类型 |
| `isNativeVectorized` | 检测是否已开启 Spark 原生向量化（Batched: true） |
| `countShuffleNodes` | 统计 Exchange 节点数量 |
| `countJoinNodes` | 统计 5 种 Join 类型节点数量 |
| `countAggregateNodes` | 统计 HashAggregate / SortAggregate 节点数量 |
| `countFileScanNodes` | 统计数据源扫描节点数量 |
| `countColumnarToRow` | 统计行列转换次数 |
| `countRowToColumnar` | 统计列行转换次数 |
| `calculateGSSBaseScore` | SQL 级 GSS 评分（加权求和，0-100） |

> **兼容性说明**：Spark 3.2+ 物理计划中文件扫描节点命名由 `FileScan parquet` 变为 `(N) Scan parquet`，UDF 统一使用 `"scan parquet"` 子串匹配，兼容新旧两种格式。

---

## 5. 技术实现架构

### 5.1 事件处理流程

```
HDFS EventLog（JSON Lines 格式）
        │
        ├── 文件过滤：最近1小时修改 + 排除 .inprogress
        │
        ▼
EventLog JSON 解析（7类事件）
  ├─ SparkListenerApplicationStart     → 提交用户
  ├─ SparkListenerEnvironmentUpdate    → Spark 配置参数
  ├─ SparkListenerJobStart             → 作业类型识别
  ├─ SparkListenerStageCompleted       → Stage 性能指标（30+）
  ├─ SparkListenerSQLExecutionStart    → 物理执行计划（核心）
  ├─ SparkListenerSQLExecutionEnd      → SQL 执行时长
  └─ GlutenPlanFallbackEvent           → Gluten fallback 原因
        │
        ▼
注册 14 个特征检测 UDF
        │
  ┌─────┴────────────────────────────────────┐
  │                                          │
  ▼                                          ▼
Stage 指标表                         SQL 执行计划分析表
dwd_panther_spark_stage              dwd_panther_spark_sql_plan
（30+ 性能指标）                      （14 项特征 + SQL级GSS）
  │                                          │
  └───────────────────┬──────────────────────┘
                      ▼
              Job 画像表
         dwd_panther_spark_job
         （作业类型 + 配置 + Job级GSS + CPU密集度）
```

### 5.2 关键配置

| 参数 | 值 | 说明 |
|------|-----|------|
| 物理计划截取长度 | 50,000 字节 | 超长计划截断，用 `is_plan_truncated` 标记 |
| EventLog 时间窗口 | 最近 1 小时 | 按文件修改时间过滤 |
| 调度周期 | 每小时 | 与 EventLog 采集频率对齐 |
| 输出分区 | dt(yyyyMMdd) + hr(HH) | 支持按天/小时回溯 |

### 5.3 部署参数

```bash
spark-submit \
  --class com.sohu.datacenter.tornado.jobmanage.PantherSparkEventGSSJob \
  --master yarn --deploy-mode cluster \
  --conf spark.sql.parquet.writeLegacyFormat=true \
  tornato_h3_spark-<version>.jar \
  "2026032010" \          # dthr: yyyyMMddHH
  "/user/bdwh/panther/dwd"  # 输出根路径
```

---

## 6. 数据模型与输出表

### 6.1 dwd_panther_spark_sql_plan（全新表）

SQL 执行计划维度分析，每条 SQL 执行一行记录。

**分区路径**：`/user/bdwh/panther/dwd/dwd_panther_spark_sql_plan/dt={yyyyMMdd}/hr={HH}`

| 字段分组 | 关键字段 |
|---------|---------|
| 基础标识 | app_id, execution_id, event_time, username |
| 执行计划 | sql_description, physical_plan（前50KB） |
| 格式特征 | input_format, has_sandwich_pattern, has_complex_types |
| UDF 特征 | has_hive_udf, has_pandas_udf, has_window_function |
| 算子统计 | file_scan_count, shuffle_count, join_count, aggregate_count |
| 转换统计 | columnar_to_row_count, row_to_columnar_count |
| GSS 评分 | gss_base_score(0-100), is_plan_truncated |
| 内存配置 | executor_memory, offheap_enabled, offheap_size |
| Gluten 状态 | is_gluten_enabled, gluten_fallback_info |
| 性能指标 | cpu_intensity(0.0-1.0) |

### 6.2 dwd_panther_spark_job（新增 15 个字段）

在原有 Job 画像表基础上扩展向量化相关字段：

| 新增字段组 | 字段 |
|-----------|------|
| 向量化配置 | spark_plugins, spark_memory_offheap_enabled, spark_memory_offheap_size, spark_executor_memoryoverhead, spark_shuffle_manager, is_gluten_enabled |
| 兼容性标记 | ansi_mode_compatible, not_python_job |
| GSS 评分 | job_cpu_intensity, sql_plan_count, job_gss_score(0-100), job_gss_label |

`job_gss_label` 取值：`RECOMMENDED` / `CAUTIOUS` / `NOT_RECOMMENDED`

---

## 7. 分阶段实施计划

### 阶段一：作业画像上线（当前）

- [x] PantherSparkEventGSSJob 代码开发完成（1225 行）
- [x] 14 个向量化特征检测 UDF 实现完成
- [x] SQL 级 + Job 级双层 GSS 评分算法完成
- [ ] 测试环境验证，输出至 `*_gss_test` 临时目录
- [ ] 切换至生产输出路径，接入 Panther 大盘

### 阶段二：白名单遴选（bdwh 用户优先）

- [ ] 基于 GSS ≥ 70 的作业，生成向量化候选白名单
- [ ] 结合 YARN vCore 使用量（memorySeconds / vcoreSeconds），预估收益
- [ ] 人工复核高分作业的执行计划，排查误判

**收益预估公式**（参考）：
```
预估节省 vCore·s = vcoreSeconds × (1 - 1/预期加速比)
预估节省 Memory·s = memorySeconds × (1 - 1/预期加速比)
```

### 阶段三：灰度验证与上线

- [ ] 对白名单中 TOP20 作业逐个开启 Gluten
- [ ] 对比开关前后的实际 vcoreSeconds / 执行时长（通过 YARN History 对比）
- [ ] 验证无 OOM、无数据正确性问题后批量推广

---

## 8. 验收标准

- [ ] dwd_panther_spark_sql_plan 表按小时正常产出，无异常分区缺失
- [ ] dwd_panther_spark_job 新增 15 个字段正常填充，job_gss_score 全量有值
- [ ] GSS 评分分布合理：预期 RECOMMENDED ≈ 20-30%，NOT_RECOMMENDED ≈ 40-50%
- [ ] Parquet/ORC 列式作业 GSS 基础分 ≥ 70（无 UDF、无复杂类型场景下）
- [ ] 纯 RDD 作业 job_gss_score < 40，job_gss_label = NOT_RECOMMENDED
- [ ] is_plan_truncated = 1 的记录占比 < 5%（物理计划过大需调大截取阈值）
- [ ] 搬运至 Doris 的数据可在 Panther 大盘正常查询

---

## 9. 风险与规避

| 风险 | 影响 | 规避措施 |
|------|------|---------|
| 物理计划截断导致 Scan 节点丢失 | input_format 误判为 unknown，GSS 偏低 | 监控 is_plan_truncated 比例，超过 5% 时调大 maxPhysicalPlanLength |
| Spark 版本升级导致计划格式变更 | UDF 正则匹配失效，特征全部为 false | 升级 Spark 版本时需回归测试 14 个 UDF 的提取结果 |
| EventLog 文件过大导致作业 OOM | 分析作业本身崩溃 | 设置 executor 内存 ≥ 8G，配置 maxPhysicalPlanLength 控制单条记录大小 |
| GC 日志路径年份前缀跨年失效 | 新年后 GC 指标采集中断 | 在年度运维计划中设置提醒，每年 1 月更新配置 |
| 向量化误判导致业务作业 OOM | 业务数据产出中断 | 白名单遴选阶段必须人工复核，灰度开启，首批控制在 5 个作业以内 |
| Gluten fallback 率过高 | 实际加速比远低于预期 | 上线前通过 GlutenPlanFallbackEvent 确认 fallback 算子占比 |
