---
title: "03 PromQL 深度解析"
date: 2026-03-03
tags: [可观测性, 指标, Prometheus, PromQL, rate, histogram_quantile, 聚合]
aliases: []
---

# 03 PromQL 深度解析

**摘要：**

[[PromQL]]（Prometheus Query Language）是 Prometheus 的灵魂——没有 PromQL，Prometheus 存储的时间序列数据只是一堆数字；有了 PromQL，这些数字才能转化为"每秒请求数"、"P99 延迟"、"错误率"这些对工程师有意义的信息。PromQL 的设计深受函数式编程影响：它没有赋值语句，没有循环，所有操作都是对时间序列集合的变换——选择、过滤、聚合、运算。本文从 PromQL 的两种核心数据类型（即时向量与范围向量）出发，逐一剖析 `rate`/`irate`/`increase` 的区别与适用场景、聚合操作的语义、`histogram_quantile` 的计算原理，以及生产环境中最常用的查询模式。

---

## 第 1 章 PromQL 的数据类型

### 1.1 四种数据类型

PromQL 表达式的计算结果是以下四种类型之一：

**即时向量（Instant Vector）**：同一时间点上的一组时间序列，每条时间序列只有一个数据点。这是最常用的类型——Grafana 面板中显示的每条曲线背后就是一个即时向量。

```
# 即时向量：每条时间序列在"当前时刻"的值
http_requests_total{service="order", method="POST"}
→ {service="order", method="POST", status="200"} 1523
  {service="order", method="POST", status="500"} 42
```

**范围向量（Range Vector）**：同一时间范围内的一组时间序列，每条时间序列包含该范围内的所有数据点。范围向量不能直接展示——它是 `rate()`、`increase()` 等函数的输入。

```
# 范围向量：每条时间序列在"过去 5 分钟"的所有数据点
http_requests_total{service="order", method="POST"}[5m]
→ {service="order", method="POST", status="200"}
    @ 14:00:00  1500
    @ 14:00:15  1505
    @ 14:00:30  1510
    @ 14:00:45  1515
    @ 14:01:00  1523
    ...（更多数据点）
```

**标量（Scalar）**：一个单纯的浮点数，没有标签。

```
# 标量
42
3.14
```

**字符串（String）**：目前在 PromQL 中几乎不使用。

### 1.2 即时向量与范围向量的关系

理解即时向量和范围向量的关系是掌握 PromQL 的关键。

即时向量可以看作"范围向量在某个时间点的截面"——`http_requests_total` 返回每条时间序列在当前时刻的最新值。

范围向量是"即时向量沿时间轴的展开"——`http_requests_total[5m]` 返回每条时间序列在过去 5 分钟内的所有采样点。

**为什么需要范围向量？**

因为很多有用的计算需要知道"一段时间内的变化"，而不仅仅是"当前时刻的值"：

- `rate()` 需要知道 Counter 在一段时间内的起始值和结束值，才能计算速率
- `avg_over_time()` 需要知道一段时间内的所有值，才能计算平均值
- `predict_linear()` 需要一段时间内的数据点来做线性回归

范围向量是这些函数的"原料"，函数的输出是即时向量。

```
范围向量                    函数                   即时向量
http_requests_total[5m] → rate() → 每秒请求数（单个数值/时间序列）
memory_used_bytes[1h]   → deriv() → 内存增长速率（单个数值/时间序列）
```

---

## 第 2 章 选择器与匹配器

### 2.1 标签匹配器

PromQL 支持四种标签匹配器：

| 匹配器 | 语法 | 含义 |
| :--- | :--- | :--- |
| **等于** | `label="value"` | 精确匹配 |
| **不等于** | `label!="value"` | 排除特定值 |
| **正则匹配** | `label=~"regex"` | 正则表达式匹配 |
| **正则不匹配** | `label!~"regex"` | 排除正则匹配的值 |

```
# 精确匹配：order-service 的指标
http_requests_total{service="order-service"}

# 正则匹配：所有以 order 开头的服务
http_requests_total{service=~"order.*"}

# 排除：非 2xx 状态码
http_requests_total{status!~"2.."}

# 组合匹配：production 环境中非 GET 请求的 5xx 错误
http_requests_total{env="production", method!="GET", status=~"5.."}
```

### 2.2 __name__ 匹配器

指标名称本身可以用正则匹配——这在查找"所有以 http_ 开头的指标"时非常有用：

```
# 所有以 http_ 开头的指标
{__name__=~"http_.*"}

# 所有 Counter 类型的请求总数指标
{__name__=~".*_requests_total"}
```

### 2.3 时间范围选择

范围向量的时间范围使用方括号指定，支持以下时间单位：

| 单位 | 含义 |
| :--- | :--- |
| `s` | 秒 |
| `m` | 分钟 |
| `h` | 小时 |
| `d` | 天 |
| `w` | 周 |
| `y` | 年 |

```
http_requests_total[5m]    # 过去 5 分钟
http_requests_total[1h]    # 过去 1 小时
http_requests_total[7d]    # 过去 7 天
```

**offset 修饰符**：将查询时间窗口向过去偏移。

```
# 当前的 QPS
rate(http_requests_total[5m])

# 1 小时前的 QPS
rate(http_requests_total[5m] offset 1h)

# 昨天同一时刻的 QPS
rate(http_requests_total[5m] offset 1d)

# 对比：当前 QPS 与昨天的差异
rate(http_requests_total[5m]) - rate(http_requests_total[5m] offset 1d)
```

---

## 第 3 章 rate、irate 与 increase

这三个函数是 PromQL 中使用频率最高的函数，它们都用于处理 Counter 类型的指标。理解它们的区别是正确使用 PromQL 的关键。

### 3.1 rate()：平均变化率

`rate(counter[duration])` 计算 Counter 在 `duration` 时间范围内的**平均每秒增长率**。

```
rate(http_requests_total[5m])
= (最后一个采样点的值 - 第一个采样点的值) / 时间跨度（秒）
```

**rate 的内部机制**：

假设 `http_requests_total` 在过去 5 分钟有以下采样点：

```
14:00:00  1000
14:00:15  1010
14:00:30  1025
14:00:45  1030
14:01:00  1050
...
14:05:00  1300
```

`rate(http_requests_total[5m])` 计算过程：
1. 取第一个点（14:00:00, 1000）和最后一个点（14:05:00, 1300）
2. 值的差：1300 - 1000 = 300
3. 时间差：300 秒
4. 速率：300 / 300 = 1 请求/秒

**rate 自动处理 Counter 重置**：如果 Counter 因为进程重启而归零（如从 1200 跳到 0），rate 会检测到值的下降，将其视为重置，并在计算中自动补偿。

### 3.2 irate()：瞬时变化率

`irate(counter[duration])` 只使用 `duration` 时间范围内**最后两个采样点**计算变化率。

```
irate(http_requests_total[5m])
= (倒数第一个点的值 - 倒数第二个点的值) / 两点之间的时间差
```

假设最后两个采样点是 `(14:04:45, 1280)` 和 `(14:05:00, 1300)`：

```
irate = (1300 - 1280) / 15秒 = 1.33 请求/秒
```

### 3.3 rate vs irate：何时用哪个

| 维度 | rate | irate |
| :--- | :--- | :--- |
| **计算方式** | 整个范围的平均速率 | 最后两个点的瞬时速率 |
| **平滑度** | 平滑（抹平短期波动）| 尖锐（捕捉瞬时变化）|
| **适合告警** | ✅ 是（避免误报）| ❌ 否（波动大导致频繁触发）|
| **适合仪表盘** | ✅ 趋势分析 | ✅ 实时监控 |
| **对 scrape 间隔的敏感度** | 低 | 高（只用最后两个点）|

**经验法则**：
- **告警规则**：始终使用 `rate()`，时间范围至少 5 分钟（`rate(xxx[5m])`）。irate 的瞬时波动会导致告警频繁触发和恢复（抖动）。
- **实时仪表盘**：如果需要看到秒级的流量变化（如排查正在进行的故障），使用 `irate()`。
- **趋势分析**：使用 `rate()` 配合较大的时间范围（`rate(xxx[15m])` 或 `rate(xxx[1h])`）。

### 3.4 increase()：总增长量

`increase(counter[duration])` 计算 Counter 在 `duration` 时间范围内的**总增长量**。

```
increase(http_requests_total[1h])
= rate(http_requests_total[1h]) × 3600
= 过去 1 小时的总请求数
```

`increase()` 本质上就是 `rate() × 时间范围（秒）`。它的优势是语义更直观——"过去 1 小时处理了多少请求"比"过去 1 小时平均每秒处理多少请求"更容易理解。

> [!warning] increase 的精度陷阱
> `increase()` 的结果可能不是整数——即使 Counter 每次只增加 1。这是因为 rate/increase 在计算时会做**线性外推（extrapolation）**：如果范围内的第一个点不在范围的起始时间，rate 会将速率线性外推到范围起始。这导致 increase 的结果可能是 `99.8` 而非 `100`。在仪表盘中使用 `round()` 函数取整即可。

---

## 第 4 章 聚合操作

### 4.1 聚合操作符

PromQL 提供了丰富的聚合操作符，用于将多条时间序列合并为一条或几条：

| 操作符 | 含义 |
| :--- | :--- |
| `sum` | 求和 |
| `avg` | 平均值 |
| `min` | 最小值 |
| `max` | 最大值 |
| `count` | 计数（时间序列的数量）|
| `stddev` | 标准差 |
| `stdvar` | 方差 |
| `topk` | 取最大的 K 条 |
| `bottomk` | 取最小的 K 条 |
| `quantile` | 分位数（注意：这是对即时向量值的分位数，不是 Histogram 分位数）|
| `count_values` | 按值分组计数 |
| `group` | 只返回标签组合，值全为 1 |

### 4.2 by 与 without：分组聚合

`by` 指定**保留**哪些标签作为分组维度（其余标签被丢弃）。`without` 指定**排除**哪些标签（其余标签保留）。

```
# 原始数据（4 条时间序列）：
http_requests_total{service="order", method="POST", status="200"} = 1000
http_requests_total{service="order", method="POST", status="500"} = 50
http_requests_total{service="order", method="GET",  status="200"} = 2000
http_requests_total{service="payment", method="POST", status="200"} = 800

# 按 service 聚合（合并 method 和 status 维度）：
sum(http_requests_total) by (service)
→ {service="order"}   = 3050    # 1000 + 50 + 2000
  {service="payment"} = 800

# 排除 status 维度（保留 service 和 method）：
sum(http_requests_total) without (status)
→ {service="order", method="POST"} = 1050   # 1000 + 50
  {service="order", method="GET"}  = 2000
  {service="payment", method="POST"} = 800
```

### 4.3 topk 与 bottomk

`topk(k, vector)` 返回值最大的 K 条时间序列。常用于"找出错误最多的 Top 5 服务"：

```
# 错误率最高的 5 个服务
topk(5,
  sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
  / sum(rate(http_requests_total[5m])) by (service)
)
```

> [!info] topk 在 Grafana 中的行为
> 在 Grafana 面板中使用 topk 时，每个时间点的 Top K 可能不同——导致图表中的曲线频繁出现和消失。如果希望在整个时间范围内显示固定的 Top K 服务，需要先用 Recording Rule 预计算出每个服务的聚合值，再在 Grafana 中排序。

---

## 第 5 章 二元运算与向量匹配

### 5.1 算术运算

PromQL 支持标准的算术运算：`+`、`-`、`*`、`/`、`%`（取模）、`^`（幂）。

```
# 错误率 = 错误请求数 / 总请求数
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
/ sum(rate(http_requests_total[5m])) by (service)

# 内存使用率 = 已用 / 总量
node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes
/ node_memory_MemTotal_bytes * 100

# 磁盘使用率
(node_filesystem_size_bytes - node_filesystem_avail_bytes)
/ node_filesystem_size_bytes * 100
```

### 5.2 向量匹配：一对一与一对多

当两个即时向量做二元运算时，PromQL 需要确定左侧的每条时间序列与右侧的哪条时间序列配对——这就是**向量匹配（Vector Matching）**。

**一对一匹配（默认）**：左右两侧的时间序列通过**相同的标签集**配对。

```
# 左侧：{service="order", method="POST"} = 50（错误数）
# 右侧：{service="order", method="POST"} = 1000（总数）
# 匹配：标签完全相同 → 50 / 1000 = 0.05

rate(http_requests_total{status="500"}[5m])
/ rate(http_requests_total[5m])
```

但如果左右两侧的标签不完全一致，就需要 `on` 或 `ignoring` 来指定匹配规则：

```
# 左侧有 status="500" 标签，右侧没有（已被 sum by 聚合掉）
# 需要 ignoring(status) 来忽略 status 标签的差异
sum(rate(http_requests_total{status="500"}[5m])) by (service, method)
/ ignoring(status) sum(rate(http_requests_total[5m])) by (service, method)
```

**一对多匹配**：当一侧的一条时间序列需要与另一侧的多条时间序列配对时，使用 `group_left` 或 `group_right`。

```
# 场景：计算每个状态码占总请求的比例
# 左侧（多）：每个 status 的请求数
# 右侧（一）：总请求数（没有 status 标签）

sum(rate(http_requests_total[5m])) by (service, status)
/ on(service) group_left
sum(rate(http_requests_total[5m])) by (service)
```

`group_left` 表示"左侧是多的一方"——左侧的多条时间序列（不同 status）与右侧的一条时间序列（总数）配对。

---

## 第 6 章 histogram_quantile：分位数计算

### 6.1 计算原理

`histogram_quantile(φ, bucket_vector)` 从 Histogram 的累积桶数据中估算第 φ 分位数。

**算法步骤**：

假设要计算 P99（φ = 0.99），Histogram 桶数据如下：

```
bucket{le="0.01"}  = 100
bucket{le="0.05"}  = 400
bucket{le="0.1"}   = 700
bucket{le="0.5"}   = 950
bucket{le="1.0"}   = 990
bucket{le="+Inf"}  = 1000
```

1. 计算目标排名：0.99 × 1000 = 990（第 990 个请求）
2. 找到目标排名所在的桶：`le="1.0"` 桶有 990 个，刚好等于目标排名
3. 但实际的分位数在 `le="0.5"`（950 个）和 `le="1.0"`（990 个）之间
4. 做线性插值：
   - 前一个桶的上界 = 0.5，累计数 = 950
   - 当前桶的上界 = 1.0，累计数 = 990
   - 目标排名 990 在这两个桶之间的位置：(990 - 950) / (990 - 950) = 1.0
   - P99 ≈ 0.5 + (1.0 - 0.5) × 1.0 = **1.0 秒**

### 6.2 常见查询模式

```
# 单个服务的 P99 延迟
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket{service="order"}[5m])
)

# 所有服务的 P99 延迟（按 service 分组）
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
)

# P50、P90、P99 同时展示（Grafana 中配置三条查询）
# Query A: histogram_quantile(0.50, sum(rate(xxx_bucket[5m])) by (le))
# Query B: histogram_quantile(0.90, sum(rate(xxx_bucket[5m])) by (le))
# Query C: histogram_quantile(0.99, sum(rate(xxx_bucket[5m])) by (le))
```

> [!warning] histogram_quantile 的常见错误
> **错误一**：忘记 `by (le)`。`histogram_quantile` 需要 `le` 标签来识别桶边界。如果 `sum()` 时没有保留 `le`，桶信息会丢失，计算结果无意义。
> ```
> # ❌ 错误：le 被聚合掉了
> histogram_quantile(0.99, sum(rate(xxx_bucket[5m])) by (service))
> 
> # ✅ 正确：保留 le
> histogram_quantile(0.99, sum(rate(xxx_bucket[5m])) by (service, le))
> ```
> 
> **错误二**：对 `rate()` 的结果而非 `bucket` 使用 `histogram_quantile`。
> ```
> # ❌ 错误：rate 应该在 bucket 上，不是在 _count 上
> histogram_quantile(0.99, rate(xxx_count[5m]))
> 
> # ✅ 正确：rate 作用于 _bucket
> histogram_quantile(0.99, rate(xxx_bucket[5m]))
> ```

### 6.3 桶边界对精度的影响

histogram_quantile 的精度完全取决于桶边界的设置。桶边界越密，线性插值越精确；桶边界越疏，估算误差越大。

```
# 稀疏的桶：精度差
buckets(0.1, 1.0, 10.0)
→ 如果实际 P99 = 2.5 秒，但只有 1.0 和 10.0 两个桶
→ 线性插值的结果可能偏差很大

# 密集的桶：精度好，但时间序列数量多
buckets(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)
→ 11 个桶 = 11 条时间序列 / 标签组合
```

**桶边界设计的建议**：在 SLO 阈值附近设置更密的桶。例如，如果 SLO 要求 P99 < 500ms，则在 100ms ~ 1000ms 区间设置更多桶（如 0.1, 0.2, 0.3, 0.5, 0.8, 1.0），在其他区间可以稀疏一些。

---

## 第 7 章 生产环境常用查询模式

### 7.1 RED 指标查询

```
# Rate：每秒请求数（按服务）
sum(rate(http_requests_total[5m])) by (service)

# Errors：错误率（按服务）
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
/ sum(rate(http_requests_total[5m])) by (service)

# Duration：P99 延迟（按服务）
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
)
```

### 7.2 USE 指标查询

```
# CPU 利用率（按实例）
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# 内存使用率
(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)
/ node_memory_MemTotal_bytes * 100

# 磁盘使用率
(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"})
/ node_filesystem_size_bytes{mountpoint="/"} * 100

# 磁盘 I/O 饱和度（队列深度）
rate(node_disk_io_time_weighted_seconds_total[5m])
```

### 7.3 告警规则常用模式

```
# 错误率告警：错误率 > 1% 持续 5 分钟
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
/ sum(rate(http_requests_total[5m])) by (service) > 0.01

# 延迟告警：P99 > 2 秒持续 5 分钟
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
) > 2

# 磁盘预测告警：按当前速率，4 小时内磁盘会满
predict_linear(node_filesystem_avail_bytes[6h], 4 * 3600) < 0

# 服务宕机告警
up{job="order-service"} == 0

# Kafka 消费积压告警
kafka_consumergroup_lag_sum > 10000
```

### 7.4 同比环比查询

```
# 与 1 小时前对比：QPS 变化百分比
(
  sum(rate(http_requests_total[5m])) by (service)
  - sum(rate(http_requests_total[5m] offset 1h)) by (service)
)
/ sum(rate(http_requests_total[5m] offset 1h)) by (service) * 100

# 与昨天同一时刻对比
sum(rate(http_requests_total[5m])) by (service)
/ sum(rate(http_requests_total[5m] offset 1d)) by (service)
```

### 7.5 Apdex 分数计算

Apdex（Application Performance Index）是一种将延迟分布转化为 0~1 分数的方法。假设满意阈值 T = 500ms：

- 满意（Satisfied）：延迟 ≤ T（≤ 500ms）
- 容忍（Tolerating）：T < 延迟 ≤ 4T（500ms ~ 2s）
- 失望（Frustrated）：延迟 > 4T（> 2s）

```
# Apdex = (Satisfied + Tolerating/2) / Total
(
  sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) by (service)
  + sum(rate(http_request_duration_seconds_bucket{le="2.0"}[5m])) by (service)
  - sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) by (service)
) / 2
/ sum(rate(http_request_duration_seconds_count[5m])) by (service)
```

简化后：

```
(
  sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) by (service)
  + sum(rate(http_request_duration_seconds_bucket{le="2.0"}[5m])) by (service)
)
/ 2
/ sum(rate(http_request_duration_seconds_count[5m])) by (service)
```

---

## 第 8 章 PromQL 性能优化

### 8.1 查询性能的关键因素

PromQL 查询的执行时间取决于两个因素：

**因素一：需要加载的时间序列数量**。查询涉及的时间序列越多，TSDB 需要从磁盘读取的数据越多。高基数标签会导致时间序列爆炸。

**因素二：时间范围**。范围越大，每条时间序列需要加载的数据点越多。`rate(xxx[1h])` 比 `rate(xxx[5m])` 需要加载 12 倍的数据点。

### 8.2 优化技巧

**技巧一：使用 Recording Rules 预计算**

将高频使用的复杂查询预计算为 Recording Rule（参见 [[02 Prometheus 数据模型与采集原理]] 第 6.2 节），在查询时直接读取预计算结果。

**技巧二：尽早过滤**

```
# ❌ 低效：先聚合所有时间序列，再过滤
sum(rate(http_requests_total[5m])) by (service)  # 加载所有标签组合
  # 然后在 Grafana 中过滤 service="order"

# ✅ 高效：先过滤，再聚合
sum(rate(http_requests_total{service="order"}[5m]))  # 只加载 order 的时间序列
```

**技巧三：避免使用 `{__name__=~".*"}` 这样的宽泛匹配**

这会加载 Prometheus 中的**所有**时间序列，在大规模集群中可能导致 OOM。

**技巧四：合理设置 rate 的时间范围**

`rate()` 的时间范围至少应该是 scrape_interval 的 4 倍。如果 scrape_interval = 15s，`rate(xxx[1m])` 只有 4 个数据点，统计意义不大。推荐使用 `rate(xxx[5m])` 作为最小范围。

---

## 参考资料

1. Prometheus Documentation - Querying：https://prometheus.io/docs/prometheus/latest/querying/basics/
2. Prometheus Documentation - Functions：https://prometheus.io/docs/prometheus/latest/querying/functions/
3. Prometheus Documentation - Operators：https://prometheus.io/docs/prometheus/latest/querying/operators/
4. Julius Volz (2020). *PromQL for Humans*. PromCon Online.
5. Brian Brazil (2018). *Prometheus: Up & Running*, Chapter 14: PromQL. O'Reilly Media.
6. Robust Perception Blog - rate vs irate：https://www.robustperception.io/irate-graphs-are-better-graphs

---

> [!note] 思考题
> 1. 告警规则定义在 Prometheus 中（`alert: HighCPU expr: cpu_usage > 0.8 for: 5m`），触发后发送到 Alertmanager。Alertmanager 负责去重、分组和路由。`group_by: [alertname, cluster]` 将相同 alertname 和 cluster 的告警分为一组——一次通知包含组内所有告警。在什么场景下你需要调整 `group_by` 以减少通知数量？
> 2. 告警的'for'持续时间——`for: 5m` 要求条件持续 5 分钟才触发告警。这避免了瞬时波动导致的误告警。但 5 分钟意味着故障发生后至少 5 分钟才收到告警。在不同的告警级别（Critical vs Warning）中，`for` 应该设为多长？
> 3. Alertmanager 的 Inhibition 规则——当'父告警'已触发时抑制'子告警'。如 `inhibit_rules: source_match: {severity: critical}, target_match: {severity: warning}, equal: [instance]`——同一实例的 critical 告警会抑制 warning 告警。这如何减少告警噪音？你需要多少层次的 inhibition 规则？
