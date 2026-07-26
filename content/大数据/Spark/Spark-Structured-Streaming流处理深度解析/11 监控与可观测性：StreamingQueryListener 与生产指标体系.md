---
title: "监控与可观测性：StreamingQueryListener 与生产指标体系"
date: 2026-02-28
tags: [Metrics, Prometheus, Spark, Spark UI, StreamingQueryListener, Structured Streaming, Watermark, 可观测性, 告警, 监控]
aliases: []
---

# 11 监控与可观测性：StreamingQueryListener 与生产指标体系

## 摘要

一个没有监控的流处理作业，就像在没有仪表盘的情况下驾驶汽车——你不知道它跑得多快、是否在正常消费、State Store 是否正在悄悄膨胀。Structured Streaming 提供了多层可观测性机制：**Spark UI 的 Streaming 标签页**（可视化的实时仪表盘）、**`StreamingQueryListener` 接口**（程序化获取每批次指标，对接外部监控系统）、**Spark Metrics System**（基于 Dropwizard Metrics 的底层指标，可以 Prometheus Exporter 暴露）。这三层配合构成完整的流查询可观测性体系。本文系统讲解每层的核心指标含义（输入速率、处理速率、批次持续时间、Watermark 延迟、State 大小、Shuffle 读写量）、关键告警规则的设计逻辑（当 `processedRowsPerSecond < inputRowsPerSecond` 时意味着积压正在增长）、`StreamingQueryProgress` 对象的完整结构与实用解析技巧，以及将流查询指标接入 Prometheus/Grafana 的完整实现方案。

---

## 第 1 章 Spark UI 的 Streaming 标签页

### 1.1 Streaming 标签页的结构

在 Spark UI（默认 `http://driver-host:4040`）的 **Structured Streaming** 标签页，可以看到：

**查询总览表格**：
- **Query Name**：流查询的名称（`.queryName("my-stream")` 设置）
- **Status**：`ACTIVE`（正常运行）/ `TERMINATED`（已停止）/ `INITIALIZING`（初始化中）
- **ID**：查询的唯一 UUID（与 Checkpoint 目录中的 `metadata` 文件匹配）
- **Start Time**：查询启动时间
- **Duration**：已运行时长
- **Average Input Rate**：平均输入速率（行/秒）
- **Average Process Rate**：平均处理速率（行/秒）

**批次时间线图**（点击查询名称进入详情）：
- 横轴：批次触发时间
- 纵轴（左）：输入行数（每批次读取的新行数）
- 纵轴（右）：批次处理时间（从触发到完成的毫秒数）

**关键观察点**：

```
正常状态：处理速率 ≥ 输入速率，批次时间趋于稳定
积压增长：处理速率 < 输入速率，批次时间越来越长（数据越积越多）
Watermark 停滞：eventTime.watermark 长时间不变，State 大小持续增长
```

### 1.2 关键指标的含义

| 指标 | 含义 | 告警阈值建议 |
|-----|------|-----------|
| `inputRowsPerSecond` | Source 侧的数据生产速率（Kafka 写入速率）| 基线监控 |
| `processedRowsPerSecond` | Spark 处理速率 | < `inputRowsPerSecond` 持续 5 分钟 → 积压告警 |
| `batchDuration` | 批次总耗时（毫秒）| > 批次间隔的 80% → 警告；> 批次间隔 → 严重 |
| `durationMs.triggerExecution` | 触发器执行时间（不含等待时间）| 同上 |
| `durationMs.getBatch` | 从 Source 获取数据的时间 | > 5 秒 → Source 连接问题 |
| `durationMs.addBatch` | 执行 Spark Job 的时间（主要耗时）| 占 `batchDuration` 的主要部分 |
| `durationMs.commitOffsets` | 写 Commit 文件时间 | > 2 秒 → Checkpoint HDFS/S3 I/O 慢 |
| `eventTime.watermark` | 当前全局 Watermark | 与 `eventTime.max` 的差值 > 延迟阈值×2 → Watermark 停滞 |
| `stateOperators.numRowsTotal` | State Store 中的总行数 | 持续单调增长（无下降趋势）→ 状态泄漏 |
| `stateOperators.memoryUsedBytes` | State Store 内存占用 | 超过 Executor 内存的 50% → 风险 |

---

## 第 2 章 StreamingQueryListener：程序化监控接口

### 2.1 为什么需要 StreamingQueryListener

Spark UI 是人工查看的可视化工具，不适合自动化告警和指标存储。`StreamingQueryListener` 是 Structured Streaming 提供的**程序化回调接口**：每当流查询发生特定事件（启动、每批次进度更新、终止）时，Spark 调用用户实现的回调函数，传入详细的进度数据。

用户可以在回调函数中：
- 将指标发送到 Prometheus/Grafana
- 写入 InfluxDB 或 Elasticsearch
- 触发钉钉/PagerDuty 告警
- 记录到本地日志文件

### 2.2 StreamingQueryListener 接口

```python
from pyspark.sql.streaming import StreamingQueryListener
import json
import time

class ProductionStreamingMonitor(StreamingQueryListener):
    """生产级流查询监控 Listener"""
    
    def __init__(self, alert_webhook_url=None, metrics_pusher=None):
        self.alert_webhook_url = alert_webhook_url
        self.metrics_pusher = metrics_pusher
        self._query_start_times = {}  # queryId → 启动时间
    
    def onQueryStarted(self, event):
        """流查询启动时触发"""
        query_id = event.id
        query_name = event.name or "unnamed"
        self._query_start_times[query_id] = time.time()
        print(f"[STREAM START] Query '{query_name}' (id={query_id}) started at {time.strftime('%Y-%m-%d %H:%M:%S')}")
    
    def onQueryProgress(self, event):
        """每个 MicroBatch 完成后触发（最重要的回调）"""
        progress = event.progress
        self._analyze_progress(progress)
    
    def onQueryTerminated(self, event):
        """流查询终止时触发（正常停止或异常崩溃）"""
        query_id = event.id
        if event.exception:
            # 异常终止：发送高优先级告警
            self._send_alert(
                level="CRITICAL",
                message=f"Stream query {query_id} CRASHED: {event.exception}"
            )
        else:
            print(f"[STREAM STOP] Query {query_id} stopped normally")
    
    def _analyze_progress(self, progress):
        """分析每批次进度数据，提取关键指标并检查告警条件"""
        
        query_name = progress.name or progress.id
        batch_id = progress.batchId
        
        # === 速率指标 ===
        input_rate = progress.inputRowsPerSecond    # 输入速率（行/秒）
        process_rate = progress.processedRowsPerSecond  # 处理速率（行/秒）
        num_input_rows = progress.numInputRows       # 本批次输入行数
        
        # === 时间指标（毫秒）===
        batch_duration = progress.batchDuration     # 批次总耗时
        duration_ms = progress.durationMs            # 各阶段耗时（字典）
        trigger_exec = duration_ms.get("triggerExecution", 0)
        get_batch = duration_ms.get("getBatch", 0)
        add_batch = duration_ms.get("addBatch", 0)
        commit_offsets = duration_ms.get("commitOffsets", 0)
        
        # === 事件时间指标 ===
        event_time = progress.eventTime              # 字典
        watermark_str = event_time.get("watermark", "") if event_time else ""
        max_et_str = event_time.get("max", "") if event_time else ""
        
        # === State Store 指标 ===
        state_operators = progress.stateOperators    # 列表（每个有状态算子一个）
        total_state_rows = sum(op.numRowsTotal for op in state_operators) if state_operators else 0
        total_state_memory = sum(op.memoryUsedBytes for op in state_operators) if state_operators else 0
        
        # === Source 偏移指标 ===
        sources = progress.sources
        for source in sources:
            source_desc = source.description
            start_offset = source.startOffset
            end_offset = source.endOffset
            # 可以从 Kafka 偏移量计算消费延迟
        
        # === 打印关键指标 ===
        print(f"[BATCH {batch_id}] {query_name}: "
              f"rows={num_input_rows}, "
              f"input_rate={input_rate:.1f}r/s, "
              f"process_rate={process_rate:.1f}r/s, "
              f"batch_ms={batch_duration}, "
              f"state_rows={total_state_rows}, "
              f"state_mb={total_state_memory//1024//1024}")
        
        # === 告警检查 ===
        self._check_alerts(
            query_name, batch_id, input_rate, process_rate,
            batch_duration, total_state_rows, total_state_memory
        )
        
        # === 推送指标到 Prometheus/InfluxDB ===
        if self.metrics_pusher:
            self.metrics_pusher.push({
                "query": query_name,
                "batch_id": batch_id,
                "input_rate": input_rate,
                "process_rate": process_rate,
                "batch_duration_ms": batch_duration,
                "state_rows": total_state_rows,
                "state_memory_bytes": total_state_memory,
            })
    
    def _check_alerts(self, query_name, batch_id, input_rate,
                      process_rate, batch_duration_ms, state_rows, state_memory_bytes):
        """检查告警条件"""
        
        # 告警 1：处理速率低于输入速率（积压正在增长）
        if input_rate > 0 and process_rate < input_rate * 0.8:
            self._send_alert(
                level="WARNING",
                message=f"[{query_name}] Processing lag growing: "
                        f"input={input_rate:.1f}r/s, process={process_rate:.1f}r/s"
            )
        
        # 告警 2：批次时间过长（超过 5 分钟）
        if batch_duration_ms > 5 * 60 * 1000:
            self._send_alert(
                level="WARNING",
                message=f"[{query_name}] Slow batch #{batch_id}: {batch_duration_ms/1000:.1f}s"
            )
        
        # 告警 3：State 内存超过 10GB（可能泄漏）
        if state_memory_bytes > 10 * 1024 * 1024 * 1024:
            self._send_alert(
                level="CRITICAL",
                message=f"[{query_name}] State memory exploding: "
                        f"{state_memory_bytes//1024//1024//1024}GB"
            )
    
    def _send_alert(self, level, message):
        """发送告警（可对接钉钉、PagerDuty、Slack 等）"""
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
        print(f"[ALERT][{level}] {timestamp}: {message}")
        # 实际生产中：调用 webhook API 发送告警

# 注册 Listener
monitor = ProductionStreamingMonitor()
spark.streams.addListener(monitor)
```

### 2.3 StreamingQueryProgress 的完整结构

`StreamingQueryProgress`（Python 中为 `StreamingQueryProgress` 对象，Scala/Java 中有更丰富的字段）的关键字段：

```python
# 获取当前运行中的流查询进度（最近一次批次）
for query in spark.streams.active:
    progress = query.lastProgress
    if progress:
        # 将进度序列化为 JSON 查看完整结构
        print(json.dumps(json.loads(progress.prettyJson), indent=2, ensure_ascii=False))
```

完整 JSON 结构示例：

```json
{
  "id": "d4c2a3b1-...",
  "runId": "e5d3b4c2-...",
  "name": "payment-stream",
  "timestamp": "2026-02-28T10:30:00.000Z",
  "batchId": 42,
  "batchDuration": 3250,
  "numInputRows": 85000,
  "inputRowsPerSecond": 2833.3,
  "processedRowsPerSecond": 26153.8,
  "durationMs": {
    "latestOffset": 45,
    "getBatch": 120,
    "queryPlanning": 35,
    "addBatch": 2890,
    "triggerExecution": 3100,
    "commitOffsets": 85,
    "walCommit": 75
  },
  "eventTime": {
    "avg": "2026-02-28T10:25:30.000Z",
    "max": "2026-02-28T10:29:55.000Z",
    "min": "2026-02-28T10:22:10.000Z",
    "watermark": "2026-02-28T10:19:55.000Z"
  },
  "stateOperators": [
    {
      "operatorName": "deduplicate",
      "numRowsTotal": 250000,
      "numRowsUpdated": 85000,
      "allUpdatesTimeMs": 820,
      "numRowsRemoved": 42000,
      "allRemovalsTimeMs": 210,
      "commitTimeMs": 145,
      "memoryUsedBytes": 52428800,
      "numRowsDroppedByWatermark": 1200,
      "customMetrics": {}
    }
  ],
  "sources": [
    {
      "description": "KafkaV2[Subscribe[payment-events]]",
      "startOffset": {"payment-events": {"0": 10000, "1": 9800}},
      "endOffset": {"payment-events": {"0": 10850, "1": 10200}},
      "latestOffset": {"payment-events": {"0": 10850, "1": 10200}},
      "numInputRows": 85000,
      "inputRowsPerSecond": 2833.3,
      "processedRowsPerSecond": 26153.8
    }
  ],
  "sink": {
    "description": "FileSink[s3://bucket/output/]",
    "numOutputRows": 83800
  }
}
```

---

## 第 3 章 关键告警规则的设计逻辑

### 3.1 积压增长告警：最重要的告警

**判断依据**：`processedRowsPerSecond < inputRowsPerSecond`（持续多批次）

**含义**：Spark 处理数据的速度低于数据产生的速度，Kafka 中的 Lag（积压）正在增长。如果不干预，积压会持续增大，最终导致：
- 端到端延迟无限增大（数据积压越来越久才被处理）
- Checkpoint 目录中的 `offsets/` 文件越来越多
- 极端情况下 Kafka 消息过期（`retention.ms` 到期），数据永久丢失

**告警设计**：

```python
# 判断积压是否在持续增长（滑动窗口检查，避免单批次抖动误报）
class LagGrowthDetector:
    def __init__(self, window_size=5):
        self.window = []
        self.window_size = window_size
    
    def check(self, input_rate, process_rate):
        ratio = process_rate / input_rate if input_rate > 0 else 1.0
        self.window.append(ratio)
        if len(self.window) > self.window_size:
            self.window.pop(0)
        
        # 连续 5 批次处理速率 < 输入速率的 90%，才告警
        if len(self.window) == self.window_size:
            avg_ratio = sum(self.window) / self.window_size
            return avg_ratio < 0.9
        return False
```

### 3.2 Watermark 停滞告警

**判断依据**：`eventTime.max - eventTime.watermark` 的差值远大于设定的延迟阈值，且连续多批次不变化

```python
from datetime import datetime, timedelta

class WatermarkStallDetector:
    def __init__(self, expected_lag_seconds, stall_threshold_batches=10):
        self.expected_lag = expected_lag_seconds
        self.threshold = stall_threshold_batches
        self.watermark_history = []
    
    def check(self, event_time_dict):
        if not event_time_dict:
            return False
        
        watermark_str = event_time_dict.get("watermark", "")
        if not watermark_str:
            return False
        
        self.watermark_history.append(watermark_str)
        if len(self.watermark_history) > self.threshold:
            self.watermark_history.pop(0)
        
        # Watermark 连续 10 批次不变化
        if len(self.watermark_history) == self.threshold:
            return len(set(self.watermark_history)) == 1  # 所有批次的 Watermark 相同
        return False
```

### 3.3 State 异常增长告警

**判断依据**：`stateOperators.numRowsTotal` 连续多批次单调递增，没有任何下降

```python
class StateLeakDetector:
    def __init__(self, growth_window=20, growth_threshold=1.5):
        self.history = []
        self.window = growth_window
        self.threshold = growth_threshold  # 20批次内增长超过50%
    
    def check(self, state_rows):
        self.history.append(state_rows)
        if len(self.history) > self.window:
            self.history.pop(0)
        
        if len(self.history) == self.window:
            oldest = self.history[0]
            newest = self.history[-1]
            if oldest > 0 and newest / oldest > self.threshold:
                # 20批次内 State 增长超过 50%，且无下降
                if min(self.history[10:]) > max(self.history[:10]):  # 后半段全高于前半段
                    return True
        return False
```

---

## 第 4 章 接入 Prometheus + Grafana

### 4.1 通过 Spark Metrics System 暴露指标

Spark 内置了基于 [[Dropwizard Metrics]] 的指标框架，通过配置可以将流查询指标以 Prometheus 格式暴露：

```properties
# spark-defaults.conf 或启动参数
spark.metrics.conf.*.sink.prometheusServlet.class=org.apache.spark.metrics.sink.PrometheusServlet
spark.metrics.conf.*.sink.prometheusServlet.path=/metrics/prometheus
spark.ui.prometheus.enabled=true
```

开启后，访问 `http://driver:4040/metrics/prometheus` 获取所有指标的 Prometheus 格式数据。

**关键的流查询指标（Prometheus 格式）**：

```
# 流查询输入行数（累计）
metrics_streaming_<queryId>_inputRows_total

# 批次处理时间
metrics_streaming_<queryId>_batchDuration

# State Store 行数
metrics_streaming_<queryId>_stateOperator_<opId>_numRowsTotal
```

### 4.2 通过 StreamingQueryListener 自定义推送

对于需要更精细控制的场景，直接在 Listener 中推送到 Prometheus Pushgateway：

```python
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

class PrometheusStreamingMonitor(StreamingQueryListener):
    
    def __init__(self, pushgateway_url, job_name):
        self.pushgateway_url = pushgateway_url
        self.job_name = job_name
        self.registry = CollectorRegistry()
        
        # 定义 Gauge 指标
        self.input_rate_gauge = Gauge(
            'spark_streaming_input_rate', 'Input rows per second',
            ['query_name'], registry=self.registry
        )
        self.process_rate_gauge = Gauge(
            'spark_streaming_process_rate', 'Processed rows per second',
            ['query_name'], registry=self.registry
        )
        self.batch_duration_gauge = Gauge(
            'spark_streaming_batch_duration_ms', 'Batch duration in milliseconds',
            ['query_name'], registry=self.registry
        )
        self.state_rows_gauge = Gauge(
            'spark_streaming_state_rows_total', 'Total rows in state store',
            ['query_name'], registry=self.registry
        )
    
    def onQueryProgress(self, event):
        p = event.progress
        name = p.name or str(p.id)[:8]
        
        self.input_rate_gauge.labels(query_name=name).set(p.inputRowsPerSecond)
        self.process_rate_gauge.labels(query_name=name).set(p.processedRowsPerSecond)
        self.batch_duration_gauge.labels(query_name=name).set(p.batchDuration)
        
        if p.stateOperators:
            total_rows = sum(op.numRowsTotal for op in p.stateOperators)
            self.state_rows_gauge.labels(query_name=name).set(total_rows)
        
        # 推送到 Prometheus Pushgateway
        push_to_gateway(
            self.pushgateway_url,
            job=self.job_name,
            registry=self.registry
        )

# 使用
monitor = PrometheusStreamingMonitor("http://pushgateway:9091", "spark-streaming")
spark.streams.addListener(monitor)
```

### 4.3 Grafana Dashboard 关键面板

生产 Grafana Dashboard 建议包含以下面板：

| 面板名称 | 指标 | 图表类型 |
|--------|------|---------|
| 输入速率 vs 处理速率 | `input_rate` + `process_rate` | 折线图（两线对比） |
| Kafka 消费 Lag（行数） | `input_rate - process_rate` 积分 | 面积图 |
| 批次处理时间 | `batch_duration_ms` | 折线图（配阈值参考线） |
| State Store 行数趋势 | `state_rows_total` | 折线图（健康时有上下波动） |
| Watermark 延迟 | `max_event_time - watermark` | 折线图（应约等于延迟阈值） |
| 各阶段耗时分解 | `addBatch`, `getBatch`, `commitOffsets` | 堆叠柱状图 |

---

## 小结

完整的流查询可观测性体系包含三层：

- **Spark UI**（人工查看）：Streaming 标签页实时展示输入速率、处理速率、批次时间、State 大小；快速判断查询健康状态
- **StreamingQueryListener**（程序化监控）：`onQueryStarted`/`onQueryProgress`/`onQueryTerminated` 三个回调；`StreamingQueryProgress` 包含全量指标；推荐接入 Prometheus/Grafana 构建持久化监控
- **关键告警规则**：积压增长（processRate < inputRate）、Watermark 停滞（watermark 不推进）、State 泄漏（State 持续增长无下降）；建议用滑动窗口检测避免单批次抖动误报

第 12 篇（本专栏最后一篇）将汇总生产调优全攻略：吞吐量调优、延迟调优、State Store 调优、背压控制，以及常见故障的快速诊断清单。

---

> [!note] 思考题
> 1. `StreamingQueryProgress` 中的 `inputRowsPerSecond` 和 `processedRowsPerSecond` 是两个关键指标。当 `inputRowsPerSecond` 持续大于 `processedRowsPerSecond` 时，意味着消费速度跟不上生产速度，积压在增长。但 `processedRowsPerSecond` 只反映批次处理速率，并不直接告诉你瓶颈在哪里（CPU、I/O 还是 Shuffle）。如何通过哪些额外的指标组合来精确定位处理速率低的根因？
> 2. `StreamingQueryListener` 的回调函数（`onQueryProgress`、`onQueryTerminated`）在 Driver 端的事件线程中执行。如果用户在回调函数中执行了耗时操作（比如向外部监控系统发送 HTTP 请求），会影响流作业的批次调度吗？正确的实践是什么？
> 3. 在生产中，一个 Spark 应用可能同时运行多个 `StreamingQuery`（多路并行处理）。每个 Query 都有独立的 Checkpoint 和 State，但它们共享同一个 `SparkContext` 的资源。如果某个 Query 的批次处理时间突然变长（比如因为数据倾斜），会对其他 Query 的调度产生影响吗？如何在多 Query 场景下实现资源隔离？

## 参考资料

- Apache Spark 官方文档：Structured Streaming Monitoring
- Apache Spark 源码：`org.apache.spark.sql.streaming.StreamingQueryListener`
- Apache Spark 源码：`org.apache.spark.sql.streaming.StreamingQueryProgress`
- [Monitoring Structured Streaming Applications（Databricks Blog）](https://www.databricks.com/blog/2017/05/22/running-streaming-jobs-day-10x-cost-savings.html)
- Prometheus 官方文档：Pushgateway
