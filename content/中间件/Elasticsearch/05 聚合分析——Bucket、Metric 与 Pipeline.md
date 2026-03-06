---
title: "05 聚合分析——Bucket、Metric 与 Pipeline"
date: 2026-03-04
tags: [Elasticsearch, 聚合, Bucket, Metric, Pipeline, Terms, HyperLogLog, Cardinality, Doc Values]
aliases: []
---

# 05 聚合分析——Bucket、Metric 与 Pipeline

## 摘要

ES 的聚合（Aggregation）能力让它从一个搜索引擎进化为兼具实时分析功能的数据平台。一个 `terms` 聚合看起来像 SQL 的 `GROUP BY`，但其内部机制与关系型数据库截然不同；`cardinality` 聚合能在毫秒级估算数百万条数据中的唯一值数量，背后是 HyperLogLog++ 概率数据结构；而 `terms` 聚合的 `doc_count` 在分布式环境下为什么会有误差，怎么理解 `doc_count_error_upper_bound` 字段？

本文以 Doc Values 的列式存储为基础，系统梳理 ES 聚合的三大家族（Bucket / Metric / Pipeline），深入剖析分布式聚合的误差来源与解决方案，以及聚合的内存模型与熔断机制。

---

## 第 1 章 聚合的基础：Doc Values

### 1.1 为什么聚合不走倒排索引

ES 的全文检索基于倒排索引——给定一个词，快速找到包含它的文档列表。但聚合要做的事情完全不同：给定所有文档，统计某个字段的分布（有多少文档 status="published"？平均价格是多少？）。

倒排索引对聚合几乎无用：要统计 `status` 字段的分布，倒排索引只能告诉你"status=published 的文档有哪些"，但你需要先知道 status 的所有可能取值，然后逐一统计——对于高基数字段（cardinality 高），这种方式效率极低。

聚合需要的是**正排数据结构**——给定一个文档 ID，快速获取它的字段值。更进一步，聚合通常是批量处理所有文档的某个字段，因此**列式存储**（Column-Oriented Storage）是最优选择。

### 1.2 Doc Values：预先构建的列式存储

**Doc Values** 是 Lucene 在写入阶段**预先构建**的正排列式存储。对于每个开启了 Doc Values 的字段，Lucene 会在 Segment 文件中维护一个专属的列存文件（`.dvd` 和 `.dvm`），其存储格式类似于 [[Parquet]] 的列存——所有文档的同一字段值连续存储，按 DocID 排列。

**数据类型与 Doc Values 的编码：**

| 字段类型 | Doc Values 编码方式 | 说明 |
|:---|:---|:---|
| `keyword` | 字典编码（Dict Encoding） | 所有唯一值建词典，文档存词典 index |
| `long`/`integer` | DELTA 编码或直接存储 | 按排序后差值压缩，节省空间 |
| `double`/`float` | 直接存储或压缩 | 浮点数精度保留 |
| `date` | DELTA 编码（毫秒时间戳） | 时间戳差值极小，压缩效率高 |
| `text` | **默认不开启** | 分词后的全文字段，Doc Values 无意义 |

当一个聚合操作到来时，ES 不需要解析任何文档的 JSON `_source`，直接读取 Doc Values 列存文件，批量获取所有文档的字段值，然后做统计计算。由于是顺序 IO，且列存格式的数据紧密排列，[[Page Cache]] 的利用率极高。

> [!warning] 生产避坑
> **Doc Values 默认对大多数字段开启，但 `text` 类型除外**。如果你在 `text` 字段上做聚合而没有设置 `keyword` 子字段，ES 会抛出错误："Fielddata is disabled on [field]..."。正确做法是在 Mapping 中为需要聚合的文本字段添加 `keyword` 子字段：
> ```json
> "title": {
>   "type": "text",
>   "fields": {
>     "keyword": { "type": "keyword", "ignore_above": 256 }
>   }
> }
> ```
> 之后聚合时使用 `title.keyword` 字段，享受 Doc Values 的高效列存。

### 1.3 禁用 Doc Values 的场景

Doc Values 需要额外的磁盘空间（通常是原始字段大小的 1~3 倍）和写入时的计算开销。对于**确定不需要聚合、排序的字段**，可以在 Mapping 中关闭：

```json
"internal_id": {
  "type": "long",
  "doc_values": false
}
```

关闭后，该字段仍可用于过滤（Filter），但无法用于排序、聚合和 Script 计算。大规模日志索引中，大量字段只用于过滤而非聚合，关闭 Doc Values 可以节省 20%~40% 的磁盘空间，并提升写入速度。

---

## 第 2 章 Bucket 聚合：分组的艺术

### 2.1 Bucket 聚合的本质

**Bucket 聚合**类似于 SQL 的 `GROUP BY`——将文档按某种条件分组，每组是一个"桶"（Bucket），然后对每个桶做进一步的统计。

核心区别在于：SQL 的 GROUP BY 需要读取所有数据，ES 的 Bucket 聚合直接基于 Doc Values 的列式数据迭代，并借助 [[Page Cache]] 实现高效的批量读取。

### 2.2 Terms 聚合：分布式环境下的精度陷阱

`terms` 聚合是最常用的 Bucket 聚合类型，统计某字段的值分布，等价于 `SELECT status, COUNT(*) FROM docs GROUP BY status`。

**单机场景下**，Terms 聚合很直观：遍历所有文档的 `status` 字段（从 Doc Values 读取），用一个 HashMap 累计每个值的文档数，最后按 doc_count 排序取 Top-N。

**分布式场景下**，问题来了。假设索引有 5 个 Shard，你请求 Top-3 的 status 值。每个 Shard 都只返回它自己的 Top-3，Coordinating Node 汇总 15 条记录，合并后得到全局 Top-3。

这里有一个**微妙但重要的精度问题**：

```
Shard 1:  published=1000, draft=800, archived=200
Shard 2:  published=900,  archived=600, draft=100
Shard 3:  draft=1500,     published=50, deleted=300
```

每个 Shard 独立返回 Top-3：
- Shard 1: [published=1000, draft=800, archived=200]
- Shard 2: [published=900, archived=600, draft=100]
- Shard 3: [draft=1500, published=50, deleted=300]

Coordinating Node 汇总：
- published = 1000+900+50 = **1950**
- draft = 800+100+1500 = **2400**
- archived = 200+600 = **800** (Shard 3 没有返回 archived，因为它的 Top-3 里没有 archived！)
- deleted = 300（Shard 1、2 也没有返回 deleted）

**问题**：Shard 3 实际上有多少 archived？我们不知道——因为它没有被返回。如果 Shard 3 有 700 个 archived，那么全局 archived 应该是 200+600+700=1500，排名第二！但我们算出来只有 800。

这就是 Terms 聚合在分布式环境下的**固有误差**。

### 2.3 理解 doc_count_error_upper_bound 与 sum_other_doc_count

ES 在 Terms 聚合结果中提供了两个元数据字段来帮助你评估误差：

**`doc_count_error_upper_bound`**：每个桶的 doc_count 可能的最大误差上界。ES 的计算方式是：将每个 Shard 中未返回（排在 Top-N 之外）的最大可能 doc_count 加总。如果这个值为 0，说明聚合结果是精确的（通常是当索引只有一个 Shard，或所有 Shard 的数据分布极度均匀时）。

**`sum_other_doc_count`**：所有未进入 Top-N 的桶的文档总数之和。这是一个精确值，反映了"还有多少数据被忽略了"。

```json
"aggregations": {
  "status_count": {
    "doc_count_error_upper_bound": 320,
    "sum_other_doc_count": 1450,
    "buckets": [
      { "key": "published", "doc_count": 1950 },
      { "key": "draft",     "doc_count": 2400 },
      { "key": "archived",  "doc_count": 800  }
    ]
  }
}
```

`doc_count_error_upper_bound=320` 意味着每个桶的真实值可能比展示值高至多 320。如果 `archived` 的 320 误差被计入，它可能达到 1120，依然不改变排名；但如果误差是上限，archived 的真实值可能高达 1120，而某个未展示桶的真实值可能更高。

### 2.4 提升 Terms 聚合精度的方法

**方法一：增大 `size` 参数**

每个 Shard 返回的 Top-N 越多，Coordinating Node 能看到的数据越完整，误差越小。将 `size` 从 10 调整为 100，意味着每个 Shard 返回 Top-100，误差大幅降低——但内存和网络传输开销线性增加。

```json
{
  "aggs": {
    "status_count": {
      "terms": {
        "field": "status.keyword",
        "size": 100
      }
    }
  }
}
```

**方法二：设置 `shard_size`**

`shard_size` 参数控制每个 Shard 返回的候选数量（默认为 `size × 1.5 + 10`）。增大 `shard_size` 而不增大 `size`，可以在保持最终返回桶数不变的情况下提升精度：

```json
{
  "aggs": {
    "status_count": {
      "terms": {
        "field": "status.keyword",
        "size": 10,
        "shard_size": 1000
      }
    }
  }
}
```

**方法三：单 Shard 聚合（最精确，但牺牲可用性）**

将索引设置为单个 Primary Shard，聚合在单个 Shard 上完成，结果 100% 精确。但单 Shard 限制了并行度，不适合大规模场景。

> [!note] 设计哲学
> ES 在这里做了一个工程上的妥协：牺牲精确性换取分布式可扩展性。这与 Presto/[[Trino]] 的 `APPROX_DISTINCT()` 函数、[[Kafka]] Streams 的窗口聚合中的近似统计是同一种设计哲学——在大数据量、分布式系统中，精确的 `GROUP BY` 代价极高，近似结果往往足够用。ES 的智慧在于将误差量化（`doc_count_error_upper_bound`），让使用者可以基于业务容忍度做决策。

### 2.5 Range 聚合与 Date Histogram 聚合

**Range 聚合**：手动定义区间，将文档按数值区间分桶，常用于价格区间、年龄段分析：

```json
{
  "aggs": {
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "to": 100 },
          { "from": 100, "to": 500 },
          { "from": 500 }
        ]
      }
    }
  }
}
```

Range 聚合的结果是精确的（不存在 Terms 聚合的分布式误差），因为区间划分是确定性的，每个文档只属于一个区间，各 Shard 的计数可以直接相加。

**Date Histogram 聚合**：按时间粒度（分钟/小时/天/月）分桶，是日志分析场景最常用的聚合类型之一：

```json
{
  "aggs": {
    "logs_per_hour": {
      "date_histogram": {
        "field": "@timestamp",
        "calendar_interval": "1h",
        "time_zone": "Asia/Shanghai"
      }
    }
  }
}
```

Date Histogram 同样是精确的——时间桶是确定性划分，各 Shard 同一时间桶的计数直接相加即可。

---

## 第 3 章 Metric 聚合：统计计算

### 3.1 基础 Metric 聚合

**Metric 聚合**对一组文档计算数值统计量，等价于 SQL 中的聚合函数（COUNT、SUM、AVG、MIN、MAX）：

```json
{
  "aggs": {
    "avg_price": { "avg": { "field": "price" } },
    "max_price": { "max": { "field": "price" } },
    "price_stats": { "stats": { "field": "price" } }
  }
}
```

`stats` 聚合一次性返回 min/max/avg/sum/count 五个统计量，比分别执行五个聚合高效得多（只遍历一次 Doc Values）。

**Metric 聚合通常与 Bucket 聚合嵌套使用**：

```json
{
  "aggs": {
    "by_category": {
      "terms": { "field": "category.keyword" },
      "aggs": {
        "avg_price": { "avg": { "field": "price" } },
        "total_sales": { "sum": { "field": "sales_count" } }
      }
    }
  }
}
```

这等价于：`SELECT category, AVG(price), SUM(sales_count) FROM products GROUP BY category`。

### 3.2 Percentiles 聚合：分位数的内存权衡

`percentiles` 聚合返回指定分位数（如 P50、P95、P99）的值，是 SRE 监控场景中最常用的聚合之一（接口延迟的 P99 是多少？）。

精确计算分位数需要将所有值排序后取对应位置，内存复杂度 O(N)——对于亿级文档，这需要几 GB 内存，不可接受。

ES 使用 **TDigest** 算法来近似计算分位数。TDigest 的核心思想是：维护一个"质心"（Centroid）集合，每个质心记录一个代表值和其覆盖的数据点数量。质心之间按值排序，分位数估算通过质心插值计算。TDigest 的关键性质：**对极端分位数（P1、P99）精度更高，对中间分位数（P50）精度略低**——而实际监控场景恰好最关心极端分位数，这与其精度分布完美契合。

内存占用：TDigest 的内存与质心数量（`compression` 参数控制，默认 100）成线性关系，与数据量 N 无关。不管有 1 万还是 1 亿条数据，内存占用都在 KB 量级。

```json
{
  "aggs": {
    "latency_percentiles": {
      "percentiles": {
        "field": "response_time_ms",
        "percents": [50, 90, 95, 99, 99.9],
        "tdigest": {
          "compression": 200
        }
      }
    }
  }
}
```

`compression` 越大，质心越多，精度越高，内存越大。对于精度要求高的场景（如计费系统的 P99.9），可以适当提高 compression。

### 3.3 Cardinality 聚合：HyperLogLog++ 的工程奇迹

**Cardinality 聚合**统计某字段的唯一值数量（基数），等价于 SQL 的 `COUNT(DISTINCT field)`。

精确计算基数需要一个 HashSet 存储所有已见过的值，内存复杂度 O(唯一值数量)。对于用户 ID、设备 ID 等高基数字段（数亿唯一值），精确基数计算可能需要 GB 级内存。

ES 使用 **HyperLogLog++**（HLL++）算法近似计算基数。这是一个极度精妙的概率数据结构：

**HyperLogLog 的基本原理（简化版）：**

对每个值计算哈希值，观察哈希值二进制表示中前导零的最大数量。直觉上，如果在 N 个随机哈希值中，最大前导零数量是 k，那么 N ≈ 2^k。

实际的 HLL 使用多个独立的哈希函数和桶（Register）来降低估算误差，HLL++ 进一步引入了偏差校正和稀疏表示（基数小时使用精确表示，节省内存）。

**HLL++ 的精度与内存：**

| 精度参数（precision_threshold） | 内存占用 | 相对误差 |
|:---:|:---:|:---:|
| 100（默认） | ~1KB | ~6.5% |
| 1000 | ~40KB | ~1.5% |
| 40000 | ~1.5MB | ~0.15% |

默认的 1KB 内存，换来 6.5% 的误差——对于"大概有多少唯一用户"这类业务问题，6.5% 的误差完全可以接受。

```json
{
  "aggs": {
    "unique_users": {
      "cardinality": {
        "field": "user_id.keyword",
        "precision_threshold": 1000
      }
    }
  }
}
```

> [!note] 设计哲学：概率数据结构的价值
> HyperLogLog 是一类"概率数据结构"（Probabilistic Data Structure）的典型代表——牺牲精确性，换取极致的内存效率。类似的设计还有布隆过滤器（Bloom Filter，用于快速判断元素是否存在）、Count-Min Sketch（用于频率统计）。在大数据场景中，当精确计算的代价（内存、时间）无法承受时，概率近似往往是唯一可行的工程方案。关键在于：你需要量化误差范围，让业务方基于已知误差做决策，而不是对"近似"二字视而不见。

---

## 第 4 章 Pipeline 聚合：对聚合结果的二次计算

### 4.1 Pipeline 聚合的定位

前两类聚合（Bucket 和 Metric）直接作用于文档数据。**Pipeline 聚合**的输入不是原始文档，而是**其他聚合的输出**——它是对聚合结果的二次计算，类似于 SQL 中的 `WITH` 子句（CTE，Common Table Expression）或窗口函数。

### 4.2 常用 Pipeline 聚合

**`derivative`（导数）聚合**：计算相邻桶之间的差值，常用于时序数据的趋势分析（每小时新增了多少事件？）：

```json
{
  "aggs": {
    "sales_per_hour": {
      "date_histogram": {
        "field": "order_time",
        "calendar_interval": "1h"
      },
      "aggs": {
        "total_sales": { "sum": { "field": "amount" } },
        "sales_delta": {
          "derivative": {
            "buckets_path": "total_sales"
          }
        }
      }
    }
  }
}
```

`buckets_path` 指定上游 Metric 聚合的路径（可以跨层级，用 `>` 分隔）。`sales_delta` 返回每小时销售额相对于上一小时的变化量。

**`moving_avg`（移动平均）聚合**：计算滑动窗口内的平均值，用于平滑时序曲线（去除噪声）：

```json
{
  "aggs": {
    "smoothed_qps": {
      "moving_avg": {
        "buckets_path": "requests_per_minute",
        "window": 5,
        "model": "ewma",
        "settings": { "alpha": 0.3 }
      }
    }
  }
}
```

`ewma`（指数加权移动平均）比简单平均更能响应近期变化——`alpha` 越大，近期数据权重越高，对最新趋势越敏感（但噪声也更大）。

**`bucket_sort`（桶排序）聚合**：对 Bucket 聚合的结果进行排序，并支持分页（取 top-N 桶后再做 Pipeline 计算时很有用）：

```json
{
  "aggs": {
    "by_category": {
      "terms": { "field": "category.keyword", "size": 100 },
      "aggs": {
        "total_sales": { "sum": { "field": "sales_count" } },
        "sort_by_sales": {
          "bucket_sort": {
            "sort": [{ "total_sales": { "order": "desc" } }],
            "size": 10
          }
        }
      }
    }
  }
}
```

**`cumulative_sum`（累计求和）聚合**：计算历史累计值，适合展示"累计增长曲线"：

```json
{
  "aggs": {
    "daily_new_users": {
      "date_histogram": { "field": "register_time", "calendar_interval": "1d" },
      "aggs": {
        "new_count": { "value_count": { "field": "user_id" } },
        "total_users": {
          "cumulative_sum": { "buckets_path": "new_count" }
        }
      }
    }
  }
}
```

### 4.3 嵌套聚合的树形结构

ES 的聚合支持任意深度的嵌套——Bucket 聚合可以嵌套 Metric 聚合，Metric 聚合的结果可以被 Pipeline 聚合引用。这构成了一棵聚合树：

```
aggs (root)
├── by_category (Terms Bucket)
│   ├── avg_price (Avg Metric)
│   ├── total_sales (Sum Metric)
│   └── price_percentiles (Percentiles Metric)
└── overall_avg_price (Avg Metric)
```

嵌套聚合在执行时是**深度优先**遍历的：对每个 Terms Bucket 中的文档集合，依次计算 `avg_price`、`total_sales`、`price_percentiles`。这意味着内存消耗是多个 Metric 聚合的叠加，不是并行独立的。

---

## 第 5 章 聚合的内存模型与熔断机制

### 5.1 聚合消耗的内存在哪里

ES 的聚合计算主要在 JVM Heap 中进行：

1. **Bucket 聚合的 HashMap**：Terms 聚合对每个唯一值维护一个 Bucket（计数器 + 嵌套聚合的状态），内存消耗与唯一值数量（基数）成正比；
2. **Metric 聚合的统计结构**：TDigest（Percentiles）、HLL++(Cardinality) 等都有各自的内存占用；
3. **Doc Values 的解压缓冲区**：从磁盘读取 Doc Values 列存数据时，需要在 Heap 中维护解压后的临时缓冲区。

高基数 Terms 聚合是内存消耗最大的场景。对一个有 1000 万唯一用户 ID 的字段做 `terms` 聚合（不限 size），ES 需要在 Heap 中维护一个有 1000 万个条目的 HashMap，内存消耗轻松达到 GB 级，极易导致 OOM。

### 5.2 Circuit Breaker：内存熔断机制

ES 提供了**内存熔断器（Circuit Breaker）** 机制来防止聚合操作耗尽 JVM Heap、触发 OOM 导致节点崩溃。

ES 的熔断器分为多个层级：

| 熔断器名称 | 保护目标 | 默认限制 |
|:---|:---|:---|
| `indices.breaker.total.limit` | 全部内存使用上限 | JVM Heap 的 95% |
| `indices.breaker.fielddata.limit` | Field Data 缓存（text 字段聚合） | Heap 的 40% |
| `indices.breaker.request.limit` | 单个请求的内存使用 | Heap 的 60% |
| `network.breaker.inflight_requests.limit` | 正在传输的请求内存 | Heap 的 100% |

当聚合操作预计使用的内存超过熔断器限制时，ES **不会 OOM**，而是提前拒绝请求，返回 `CircuitBreakingException`：
```
{
  "error": {
    "type": "circuit_breaking_exception",
    "reason": "[request] Data too large, data for [<reused_arrays>] would be [1.5gb/1.4gb], which is larger than the limit of [1.2gb/1.1gb]"
  }
}
```

> [!warning] 生产避坑
> 如果频繁遇到熔断异常，不要简单地提高熔断阈值——那只是推迟了 OOM 的时间。应当从根本上解决问题：
> 1. **限制 Terms 聚合的 size**，避免无上限的高基数聚合；
> 2. 对真正需要高基数聚合的场景，使用 **Cardinality 近似替代精确 Count Distinct**；
> 3. 在写入时做**预聚合**（使用 ES 的 Rollup 功能或在 Ingest Pipeline 中预计算），避免在查询时实时聚合大量数据；
> 4. 增加数据节点，通过水平扩展降低每个节点的聚合压力。

### 5.3 聚合与搜索同时执行的资源竞争

ES 支持在同一个请求中同时执行查询和聚合：

```json
{
  "query": { "match": { "title": "Elasticsearch" } },
  "aggs": {
    "by_author": { "terms": { "field": "author.keyword" } }
  }
}
```

在这种情况下：
- **查询（Query Phase）** 利用倒排索引定位匹配文档，主要消耗 CPU 和 Page Cache；
- **聚合** 在查询结果集上执行，遍历命中文档的 Doc Values，主要消耗 JVM Heap。

两者共享同一个节点的资源，在高负载时会产生竞争。对于实时搜索场景（低延迟优先）和离线分析场景（高吞吐优先），建议通过不同的查询路由分隔到不同的数据节点组——ES 的 **Allocation Awareness** 和 **Search Preference** 机制支持这种路由策略。

---

## 第 6 章 聚合性能调优实践

### 6.1 关键原则：减少遍历的文档数量

聚合的时间复杂度与候选文档数成正比。最有效的优化是**用 Filter 提前缩小聚合范围**：

```json
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "region": "cn-shanghai" } },
        { "range": { "timestamp": { "gte": "now-1h" } } }
      ]
    }
  },
  "aggs": {
    "error_by_service": {
      "terms": { "field": "service_name.keyword" }
    }
  }
}
```

Filter 在 Query Phase 执行，利用 Filter Cache，极大地减少了聚合阶段需要遍历的文档数。

### 6.2 避免嵌套层级过深

ES 聚合的内存消耗随嵌套深度指数级增长：

```
3 层嵌套: Terms(100桶) × Terms(50桶) × Terms(20桶) = 100,000 个叶子桶
```

每个叶子桶维护一组 Metric 聚合的状态，100,000 个叶子桶意味着大量 Heap 消耗和大量返回数据。实践中，超过 3 层嵌套的聚合通常需要重新审视数据模型——是否可以通过预聚合（Rollup）或更宽的 Mapping（把多层嵌套的 key 拼成单个字段）来简化查询？

### 6.3 利用 Sampling 聚合近似加速

对于不需要 100% 精确的探索性分析，ES 提供了 `sampler` 和 `diversified_sampler` 聚合，先对文档做采样（只取评分最高的前 N 条），再在样本上做聚合：

```json
{
  "aggs": {
    "sample": {
      "sampler": {
        "shard_size": 1000
      },
      "aggs": {
        "top_keywords": {
          "significant_terms": { "field": "content" }
        }
      }
    }
  }
}
```

每个 Shard 只取 1000 条文档做聚合，大幅降低内存和 CPU 消耗，换取可接受的精度损失。对于日志分析中的"最近出现最多的错误关键词"这类探索性问题，采样聚合往往已经足够准确。

---

## 小结

本文从 Doc Values 的列式存储出发，梳理了 ES 聚合的三大家族：

- **Bucket 聚合**（Terms、Range、Date Histogram）将文档分组，Terms 聚合在分布式环境下存在固有精度误差，通过 `shard_size` 参数可以权衡精度与开销；
- **Metric 聚合**（Avg/Max/Stats、Percentiles、Cardinality）做数值统计，Percentiles 用 TDigest 近似、Cardinality 用 HyperLogLog++ 近似——两者都以极小内存换取可量化的精度损失；
- **Pipeline 聚合**（derivative、moving_avg、cumulative_sum）对聚合结果做二次计算，实现时序分析、趋势检测等复杂分析需求。

聚合的核心资源是 JVM Heap，Circuit Breaker 机制提供了最后一道防线。生产中最重要的聚合优化原则：**用 Filter 缩小候选集、控制 Terms size、避免过深嵌套、必要时采用预聚合**。

下一篇文章将深入 ES 的集群管理机制——选主（Master Election）、分片分配策略与脑裂防护。

---

> [!note] 思考题
> 1. ES 的分片分配策略（Shard Allocation）决定了 Shard 如何分布在各 Data 节点上。默认策略尽量均匀分配 Shard 数量。但 Shard 大小可能不均匀——有些 Shard 100GB，有些只有 1GB。基于 Shard 数量的均衡不等于基于磁盘使用量的均衡。`cluster.routing.allocation.disk.watermark.low/high` 如何在磁盘使用率层面控制分配？
> 2. ES 集群的容量规划需要考虑：数据量（原始数据 × 1.1 膨胀 + 副本）、查询 QPS 和延迟要求、写入吞吐量。在日志场景中，每天写入 500GB 原始日志，1 副本，保留 30 天——需要多少磁盘空间？如果需要支持 100 QPS 的聚合查询，需要多少 Data 节点（假设每个节点可以处理 20 QPS）？
> 3. Hot-Warm-Cold 架构将数据按时间分层存储——最新数据在 Hot 节点（NVMe SSD，高性能），较旧数据迁移到 Warm 节点（SATA SSD），最老数据到 Cold 节点（HDD）。ILM（Index Lifecycle Management）自动管理数据迁移。在什么时间点应该将 Index 从 Hot 迁移到 Warm？迁移过程中查询性能是否受影响？
