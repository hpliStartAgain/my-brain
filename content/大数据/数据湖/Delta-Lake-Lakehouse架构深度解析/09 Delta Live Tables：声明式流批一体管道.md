---
title: "Delta Live Tables：声明式流批一体管道"
date: 2026-02-28
tags: [Delta Lake, Delta Live Tables, DLT, 声明式管道, Expectations, 数据质量, 物化视图, 流式表, 数据血缘]
aliases: []
---

# 09 Delta Live Tables：声明式流批一体管道

## 摘要

传统的 Spark ETL 管道是命令式的：工程师需要显式地编写每一步的 Spark 代码（读哪张表、做什么变换、写到哪里），并手动管理依赖关系（作业 A 完成后才能触发作业 B）、资源调度（什么时候运行哪个作业）、错误处理（失败后如何重试）。这种方式在管道规模增大后，运维复杂度急剧上升——一个包含 50 张表、100 个依赖关系的数据管道，仅靠人工维护其 DAG 和调度逻辑就足以让团队疲于奔命。**Delta Live Tables（DLT）** 是 Databricks 在 2021 年推出的声明式流批一体管道框架：工程师只需要声明"这张表是用什么 SQL/Python 逻辑定义的"，DLT 框架自动推断依赖关系、自动调度执行、自动处理增量更新、自动管理数据质量约束（Expectations）。本文从 DLT 的核心设计思想出发，深入讲解三个核心概念：**物化视图（Materialized View）**（自动增量计算的批处理结果）、**流式表（Streaming Table）**（Append-only 的实时数据摄取）、**Expectations（期望/数据质量约束）**（声明式数据质量规则，违规时可丢弃、警告或阻断管道），以及 DLT 管道的增量执行引擎如何利用 Delta Lake 的 Change Data Feed 实现高效的增量更新。

---

## 第 1 章 DLT 的设计哲学：从命令式到声明式

### 1.1 命令式 ETL 管道的痛点

一个典型的命令式 Spark ETL 管道：

```python
# 传统命令式 ETL：工程师手动管理所有细节
# 作业 1：清洗原始数据
raw_df = spark.read.format("delta").table("raw_orders")
cleaned_df = raw_df.filter("amount > 0").dropDuplicates(["order_id"])
cleaned_df.write.format("delta").mode("overwrite").saveAsTable("cleaned_orders")

# 作业 2：聚合（必须在作业 1 完成后才能运行）
cleaned = spark.read.format("delta").table("cleaned_orders")
agg_df = cleaned.groupBy("date", "category").agg(F.sum("amount").alias("total"))
agg_df.write.format("delta").mode("overwrite").saveAsTable("daily_sales")

# 作业 3：进一步聚合（依赖作业 2）
...

# 还需要：
# 1. 调度系统（Airflow/Argo Workflow）管理这 3 个作业的依赖和触发
# 2. 失败重试逻辑（某个作业失败后如何重跑）
# 3. 增量更新逻辑（只处理新数据，不全量重算）← 工程师自己实现
# 4. 数据质量检查（手动添加 assert 或过滤逻辑）
# 5. 数据血缘记录（手动维护文档）
```

随着管道变复杂（50+ 张中间表、多级依赖），上述的手动管理成本呈指数级增长，且极易出错（忘记更新某个依赖、数据质量检查遗漏某列）。

### 1.2 DLT 的声明式思想

DLT 的核心思想是：**用"这张表是什么（What）"来替代"如何计算这张表（How）"**。

```python
# DLT 声明式写法
import dlt
from pyspark.sql.functions import col, sum as spark_sum

# 声明"cleaned_orders"是从"raw_orders"清洗而来的
@dlt.table(comment="清洗后的订单表，过滤无效金额和重复记录")
@dlt.expect_or_drop("valid_amount", "amount > 0")  # 数据质量约束
def cleaned_orders():
    return (
        dlt.read("raw_orders")
           .dropDuplicates(["order_id"])
    )

# 声明"daily_sales"是从"cleaned_orders"聚合而来的
@dlt.table(comment="每日各品类销售汇总")
def daily_sales():
    return (
        dlt.read("cleaned_orders")
           .groupBy("date", "category")
           .agg(spark_sum("amount").alias("total"))
    )
```

DLT 框架从这些声明中**自动推断**：
- `daily_sales` 依赖 `cleaned_orders`（因为 `dlt.read("cleaned_orders")`）
- `cleaned_orders` 依赖 `raw_orders`（因为 `dlt.read("raw_orders")`）
- 执行顺序：raw_orders → cleaned_orders → daily_sales

工程师不再需要编写调度代码、依赖管理代码、增量更新代码——这些都由 DLT 框架自动处理。

> [!note] 设计哲学
> DLT 的声明式设计与 SQL 视图的声明式设计一脉相承：SQL 的 `CREATE VIEW v AS SELECT ...` 声明了"视图是什么"，而不是"如何执行"，优化器负责推导执行计划。DLT 将这种思维扩展到了流批一体的数据管道层面。

---

## 第 2 章 DLT 的三种核心对象

### 2.1 物化视图（Materialized View）

**物化视图（Materialized View，MV）** 是 DLT 中表示"批处理聚合结果"的对象类型。它的语义与数据库的物化视图相同：预先计算并存储查询结果（与普通 SQL VIEW 每次查询时动态计算不同），当上游数据变化时，MV 被自动刷新。

```python
@dlt.table                          # 默认就是 Materialized View
def monthly_revenue():
    return (
        dlt.read("cleaned_orders")
           .groupBy("year", "month", "category")
           .agg(spark_sum("amount").alias("revenue"))
    )
```

**DLT 如何实现 MV 的增量刷新**：

DLT 利用 [[Change Data Feed]] 来实现高效的增量刷新：
1. `cleaned_orders` 的 CDF 提供了自上次刷新以来的行级别变更（insert/update/delete）
2. DLT 对增量变更重新执行聚合逻辑（增量聚合，而不是全量重算）
3. 将增量聚合结果 MERGE 到 `monthly_revenue` 中

对于**不支持增量计算的聚合**（如 `COUNT DISTINCT`、某些窗口函数），DLT 会自动退回全量重算模式，并在日志中记录原因。

**MV 的适用场景**：
- 聚合查询（SUM、COUNT、AVG）
- JOIN 的预计算结果
- 复杂的多步转换管道

### 2.2 流式表（Streaming Table）

**流式表（Streaming Table）** 是 DLT 中表示"Append-only 实时摄取"的对象类型。数据只追加到流式表，不更新、不删除。

```python
@dlt.table(comment="从 Kafka 实时摄取的原始订单事件")
def raw_orders():
    return (
        spark.readStream
             .format("kafka")
             .option("kafka.bootstrap.servers", "kafka:9092")
             .option("subscribe", "orders")
             .load()
             .select(
                 from_json(col("value").cast("string"), order_schema).alias("data")
             )
             .select("data.*")
    )
```

**流式表 vs 物化视图的本质区别**：

| 维度 | 流式表 | 物化视图 |
|-----|-------|---------|
| **数据语义** | Append-only（只追加）| 完整的当前状态（支持 UPDATE/DELETE）|
| **数据来源** | 流式 Source（Kafka/Kinesis/Delta Source）| 任何 DLT 表（批或流）|
| **刷新方式** | 持续摄取（流式处理）| 增量刷新（检测到上游变化时触发）|
| **历史数据** | 保留完整历史（Time Travel 有效）| 只保留当前状态（MV 刷新时可能覆盖）|
| **适用场景** | 原始事件摄取、日志收集 | 聚合、JOIN、复杂转换结果 |

### 2.3 SQL 声明方式

DLT 同时支持 Python API 和 SQL 声明方式：

```sql
-- SQL 声明流式表
CREATE OR REFRESH STREAMING TABLE raw_orders
COMMENT "从 Kafka 实时摄取的原始订单"
AS SELECT
  order_id,
  amount,
  order_date,
  customer_id
FROM STREAM(kafka.orders);   -- STREAM() 函数表示流式读取

-- SQL 声明物化视图
CREATE OR REFRESH MATERIALIZED VIEW monthly_revenue
COMMENT "每月各品类销售汇总"
AS SELECT
  year(order_date) AS year,
  month(order_date) AS month,
  category,
  SUM(amount) AS revenue
FROM cleaned_orders
GROUP BY 1, 2, 3;
```

---

## 第 3 章 Expectations：声明式数据质量约束

### 3.1 为什么需要 Expectations

数据质量问题是数据管道中最难处理的问题之一。传统方法是在 ETL 代码中手动添加数据质量检查：

```python
# 传统手动数据质量检查（命令式）
df = spark.read.table("raw_orders")

# 检查 amount > 0
bad_records = df.filter("amount <= 0")
if bad_records.count() > 0:
    if bad_records.count() / df.count() > 0.01:  # 超过 1% 的数据质量问题
        raise ValueError("数据质量告警：amount <= 0 的记录超过 1%")
    else:
        df = df.filter("amount > 0")  # 过滤掉坏数据继续

# 检查 order_id 不为 NULL
null_orders = df.filter("order_id IS NULL")
...
```

这种方式有两个问题：
1. **代码与业务逻辑耦合**：数据质量检查散落在 ETL 代码各处，难以统一管理和审计
2. **缺乏可见性**：数据质量问题不会自动暴露到监控系统，需要人工检查日志

**DLT Expectations** 将数据质量约束提升为一等公民：独立声明、自动执行、结果自动记录到 DLT 的事件日志，可以在 UI 上直观看到每次管道运行的数据质量报告。

### 3.2 三种违规处理模式

**模式一：`@dlt.expect`（警告，继续处理）**

```python
@dlt.table
@dlt.expect("valid_amount", "amount > 0")  # 违反时记录警告，但数据照样写入
def cleaned_orders():
    return dlt.read("raw_orders")
```

使用场景：数据质量问题是已知的、可容忍的，需要记录但不阻断管道。例如，上游系统偶尔产生 amount=0 的记录（测试订单），这些记录不应该阻断整个管道，但需要被监控。

**模式二：`@dlt.expect_or_drop`（丢弃违规行）**

```python
@dlt.table
@dlt.expect_or_drop("valid_amount", "amount > 0")  # 违反时丢弃该行
@dlt.expect_or_drop("valid_order_id", "order_id IS NOT NULL")
def cleaned_orders():
    return dlt.read("raw_orders")
```

使用场景：坏数据应该被过滤掉，不写入目标表，但管道整体可以继续运行。DLT 会在事件日志中记录丢弃了多少行（违反了哪个约束）。

**模式三：`@dlt.expect_or_fail`（失败并停止管道）**

```python
@dlt.table
@dlt.expect_or_fail("no_duplicate_orders", 
                    "COUNT(*) OVER (PARTITION BY order_id) = 1")  # 出现重复则失败
def critical_orders():
    return dlt.read("raw_orders")
```

使用场景：数据质量问题严重到无法接受，需要立即停止管道并触发告警，让工程师人工介入。例如，主键重复是严重的上游数据错误，继续处理会导致下游数据污染。

### 3.3 聚合级别的 Expectations

DLT 2.0 支持表级别的聚合约束（不只是行级别）：

```python
@dlt.table
@dlt.expect("daily_completeness",
            "COUNT(CASE WHEN amount IS NULL THEN 1 END) / COUNT(*) < 0.05")
# 表级别约束：NULL amount 比例不超过 5%
def orders_daily():
    return dlt.read("raw_orders").filter("date = current_date()")
```

### 3.4 Expectations 的事件日志

DLT 将每次管道运行的 Expectations 执行结果记录在 `event_log` 中：

```python
# 查询 DLT 事件日志（分析数据质量历史）
event_log = spark.read.format("delta") \
    .load("s3://bucket/dlt/pipeline_id/system/events")

# 查看数据质量问题摘要
event_log \
    .filter("event_type = 'flow_progress'") \
    .select("timestamp", "details") \
    .show()

# 典型输出：
# {
#   "flow_name": "cleaned_orders",
#   "metrics": {
#     "num_output_rows": 99850,
#     "expectations": {
#       "valid_amount": {"passed_records": 99850, "failed_records": 150}
#     }
#   }
# }
```

这使得数据质量的历史趋势可以被量化和可视化——每天有多少记录违反了约束？违规率是在上升还是下降？

---

## 第 4 章 DLT 管道的增量执行引擎

### 4.1 DLT 如何决定哪些表需要刷新

DLT 管道的每次更新（Update）执行时，框架会分析整个 DAG（有向无环图）中哪些节点需要刷新：

```
DAG 结构：
  raw_orders（Streaming Table）← Kafka
    ↓
  cleaned_orders（Materialized View）
    ↓
  daily_sales（Materialized View）
    ↓
  monthly_revenue（Materialized View）

每次 DLT 更新时：
  1. raw_orders：检查 Kafka 是否有新消息 → 有：摄取新消息（流式）
  2. cleaned_orders：检查 raw_orders 是否有新数据（CDF）→ 有：增量刷新
  3. daily_sales：检查 cleaned_orders 是否有新数据（CDF）→ 有：增量刷新
  4. monthly_revenue：检查 daily_sales 是否有新数据（CDF）→ 有：增量刷新
```

**关键设计**：DLT 不依赖外部调度器来决定哪些表需要刷新，而是通过检查每张表的上游是否有变化来自动决定。这等效于"数据驱动的调度"——有新数据才计算，没有新数据就跳过。

### 4.2 全量刷新 vs 增量刷新

DLT 管道有两种运行模式：

**`FULL REFRESH`（全量刷新）**：清空所有表，从数据源头全量重算所有中间表。适合：
- 业务逻辑发生变化（如 `cleaned_orders` 的过滤条件修改了）
- 上游历史数据被回填（需要重算历史聚合结果）
- 修复之前管道运行的错误

**`UPDATE`（增量更新，默认）**：只处理自上次成功运行以来的新增/变更数据。适合：
- 正常的周期性运行（日常 ETL）

```python
# 通过 Databricks API 触发管道运行
import requests

# 增量更新
requests.post(f"/api/2.0/pipelines/{pipeline_id}/updates",
              json={"full_refresh": False})

# 全量刷新
requests.post(f"/api/2.0/pipelines/{pipeline_id}/updates",
              json={"full_refresh": True})
```

### 4.3 DLT 管道的数据血缘（Lineage）

DLT 框架在执行过程中自动记录每张表的数据血缘——哪张表是从哪些上游表计算得来的。这些血缘信息可以通过 Unity Catalog（Databricks 的统一数据目录）查询：

```sql
-- 查询 monthly_revenue 的上游血缘
SELECT * 
FROM system.information_schema.column_lineage
WHERE target_table = 'monthly_revenue';

-- 结果：
-- monthly_revenue ← daily_sales ← cleaned_orders ← raw_orders ← kafka.orders
```

**数据血缘的工程价值**：
- **影响分析**：当 `raw_orders` Schema 发生变化，可以快速找出所有受影响的下游表
- **合规审计**：证明某个报表数据的来源（对 GDPR、SOX 合规的支持）
- **故障根因分析**：当 `monthly_revenue` 出现数据异常，通过血缘链路快速定位问题源头

---

## 第 5 章 DLT 的运维与监控

### 5.1 管道状态监控

DLT 在 Databricks UI 中提供了直观的管道 DAG 可视化——每个节点（表）的颜色表示其当前状态（绿色：运行中/成功，红色：失败，灰色：未运行），节点上显示行数和数据质量指标。

通过 API 或 SQL 获取管道状态：

```python
# 获取管道最新的运行状态
pipeline_events = spark.read.format("delta") \
    .load(f"s3://bucket/dlt/{pipeline_id}/system/events") \
    .filter("event_type IN ('pipeline_state', 'flow_progress', 'create_dataset')") \
    .orderBy("timestamp", ascending=False) \
    .limit(100)

pipeline_events.select("timestamp", "event_type", "details").show(truncate=False)
```

### 5.2 生产部署建议

```python
# DLT 管道配置（通过 Databricks Job/Pipeline 配置）
pipeline_config = {
    "name": "orders_lakehouse_pipeline",
    "edition": "ADVANCED",      # CORE / PRO / ADVANCED（功能不同）
    "continuous": False,        # True=持续运行（低延迟）, False=按触发运行（低成本）
    "development": False,       # 生产环境
    "libraries": [{"notebook": {"path": "/pipelines/orders_etl"}}],
    "clusters": [
        {
            "label": "default",
            "spark_conf": {
                "spark.databricks.delta.optimizeWrite.enabled": "true",
                "spark.databricks.delta.autoCompact.enabled": "true"
            },
            "autoscale": {
                "min_workers": 2,
                "max_workers": 20,
                "mode": "ENHANCED"   # 增强型自动扩缩容，根据 Stage 负载动态调整
            }
        }
    ],
    "target": "orders_lakehouse",  # 所有 DLT 表注册到这个 schema
    "configuration": {
        "pipelines.tableManagedByUs.enabled": "true",
        "spark.sql.shuffle.partitions": "auto"
    }
}
```

> [!info] 核心概念
> DLT 目前（2025 年）是 Databricks 平台的特有功能，不在开源 Delta Lake 中提供。开源替代方案：
> - **[[Apache Airflow]]** + 手动编写增量逻辑（最常见）
> - **[[dbt]]（Data Build Tool）**：专注于 SQL 转换的声明式框架，与 Delta Lake 集成
> - **Spark Structured Streaming** + **Delta CDF**：流批一体的开源实现（本专栏第 08 篇）
> 
> 本文介绍 DLT 的目的是理解声明式管道的设计思想，其核心概念（物化视图、Expectations、增量刷新）对于使用开源工具实现类似架构有重要的参考价值。

---

## 小结

Delta Live Tables 代表了数据管道工程的一个重要方向——从命令式（How）到声明式（What）的演进：

- **物化视图（Materialized View）**：声明"这张表是什么"，DLT 自动利用 CDF 实现增量刷新；不支持增量计算的聚合自动退回全量模式
- **流式表（Streaming Table）**：Append-only 实时摄取；与 Kafka、Kinesis、Delta Source 集成；持续运行或按触发运行
- **Expectations（数据质量约束）**：三种违规处理模式（warn/drop/fail）；行级别和表级别约束；自动记录到事件日志，支持数据质量趋势分析
- **增量执行引擎**：基于 CDF 检测上游变化，数据驱动调度（有变化才计算）；支持全量刷新（逻辑变更时）和增量更新（日常运行）
- **数据血缘**：DLT 自动记录表级别血缘，与 Unity Catalog 集成，支持影响分析和合规审计

第 10 篇讲解性能调优：小文件合并的触发时机与合理的目标文件大小、AUTO OPTIMIZE 的两种模式（Optimize Write + Auto Compaction）、Delta Cache（与 Spark Cache 的区别）、统计信息维护（`ANALYZE TABLE` 对 CBO 的作用）。

---

> [!note] 思考题
> 1. DLT 的声明式 API 降低了使用门槛，但也降低了控制粒度——用户无法直接控制每个表的刷新时机和资源分配。在需要精细控制的场景下（如某些表必须在特定时间点刷新），DLT 的声明式模型是否会成为约束？
> 2. DLT 的数据质量约束提供三种处理策略：警告、失败、丢弃。如果"丢弃"策略被频繁触发（大量记录因质量问题被丢弃），如何监控和告警这种情况，防止静默的数据丢失？
> 3. DLT 目前是 Databricks 托管服务，不能在开源 Spark 上直接运行，存在平台锁定风险。在评估 DLT 与自建 Spark + Delta 管道的选型时，平台锁定风险应该如何量化？

## 参考资料

- [Delta Live Tables 官方文档](https://docs.databricks.com/en/delta-live-tables/index.html)
- [DLT Expectations 文档](https://docs.databricks.com/en/delta-live-tables/expectations.html)
- [DLT Event Log Schema](https://docs.databricks.com/en/delta-live-tables/observability.html)
