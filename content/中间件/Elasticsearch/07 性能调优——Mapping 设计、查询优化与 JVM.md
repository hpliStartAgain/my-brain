---
title: "07 性能调优——Mapping 设计、查询优化与 JVM"
date: 2026-03-04
tags: [Elasticsearch, 性能调优, Mapping, JVM, 查询优化, Doc Values, Filter Cache, ILM]
aliases: []
---

# 07 性能调优——Mapping 设计、查询优化与 JVM

## 摘要

ES 的性能问题大多数不是在运行时暴露的，而是在设计阶段埋下的：错误的 Mapping 类型、过度的字段数量、不当的分片数量配置，都会在数据量增长后爆发。本文以"设计即调优"为核心思想，从 Mapping 设计原则出发，深入分析字段类型选择的工程权衡，再到查询层面的 Filter Cache 利用、Routing 精确定位，最后落到 JVM Heap 与 Off-Heap 的内存模型、GC 参数调优。所有优化手段均给出可量化的预期收益与适用边界。

---

## 第 1 章 Mapping 设计：性能的第一道关卡

### 1.1 Dynamic Mapping 的双刃剑

ES 默认开启 **Dynamic Mapping**——当你索引一条文档时，如果包含 Mapping 中尚未定义的字段，ES 会自动推断字段类型并添加到 Mapping 中。这极大地降低了上手门槛，但在生产环境中却是性能陷阱的高发区。

**问题一：字段数量爆炸（Mapping Explosion）**

日志场景中，如果每条日志的 JSON 结构不固定（如 Kubernetes 的 labels、应用自定义的 extra 字段），Dynamic Mapping 会为每个出现过的字段名创建 Mapping 条目。当集群积累了数月日志后，某些索引的字段数量可能达到数万个。

字段数量过多的代价：
- Cluster State 中的 Mapping 部分急剧膨胀（数万字段的 Mapping JSON 可达数 MB），频繁广播导致 Master 和所有节点持续处理大量序列化/反序列化；
- 每个 Segment 为每个字段维护 Doc Values（即使大多数文档没有该字段），磁盘空间浪费；
- 查询时即使只涉及少数字段，ES 内部仍需初始化全部字段的元信息，增加 overhead。

**解决方案：**

关闭 Dynamic Mapping，显式定义所有字段：
```json
PUT /my-index
{
  "mappings": {
    "dynamic": "strict"
  }
}
```

`strict` 模式下，索引包含未知字段的文档会直接报错。这迫使写入方在设计阶段就规范字段结构。

对于确实需要存储不确定结构的字段，使用 `flattened` 类型：
```json
"labels": {
  "type": "flattened"
}
```

`flattened` 类型将整个对象存储为单个 Lucene 字段，无论对象内部有多少 key，都只产生一个 Mapping 条目。代价是：只能做 `term` 精确查询，无法做 `range`、`text` 全文检索。

**问题二：自动推断类型不符合预期**

Dynamic Mapping 的类型推断规则：
- 数字字符串（`"123"`）→ 推断为 `long`，而不是 `text`；
- 日期格式字符串（`"2026-03-04"`）→ 推断为 `date`，如果某天日志中出现一条格式不同的日期，整个批次写入失败；
- 布尔字符串（`"true"`）→ 推断为 `boolean`。

一旦某个字段被写入了第一条文档，其类型就被锁定——后续写入该字段不同类型的值时，会触发类型冲突错误，导致批量写入失败。

### 1.2 字段类型的精确选择

**keyword vs text**

这是 ES Mapping 设计中最常见的决策点：

| 场景 | 推荐类型 | 原因 |
|:---|:---|:---|
| 精确匹配（枚举值、标签、状态码） | `keyword` | 不分词，直接索引原始字符串；支持排序、聚合 |
| 全文搜索（文章标题、正文内容） | `text` | 经分析器分词后建倒排索引；不支持排序、聚合 |
| 既需要全文搜索，又需要精确聚合 | `text` + `fields.keyword` | 双字段存储，各自服务不同查询 |
| IP 地址 | `ip` | 支持 CIDR 范围查询，比 `keyword` 更高效 |
| 版本号（如 `1.2.3`） | `keyword` | 不需要分词，精确匹配即可 |

**`enabled: false`：完全禁用索引**

对于某些字段，你只需要在 `_source` 中存储（供 Fetch Phase 返回），完全不需要查询或聚合，可以设置 `enabled: false`：

```json
"raw_payload": {
  "type": "object",
  "enabled": false
}
```

该字段的数据仍然存储在 `_source` 中（`.fdt` 文件），但不建立任何倒排索引、Doc Values，大幅节省索引空间和写入时间。

**`index: false`：存储但不索引**

比 `enabled: false` 更细粒度：字段存储在 `_source`，建立 Doc Values（可用于排序/聚合），但不建立倒排索引（不可用于全文检索和 `term` 过滤）：

```json
"response_body": {
  "type": "text",
  "index": false
}
```

适合大型文本字段（如 API 响应体），只需要展示不需要搜索的场景。

**`doc_values: false`：不建列存**

```json
"session_token": {
  "type": "keyword",
  "doc_values": false
}
```

该字段仍然可以 `term` 过滤查询，但不能排序、聚合、用于 Script。适合高基数的 ID 类字段（每个文档的值都唯一，聚合无意义），关闭 Doc Values 节省约 30%~50% 的磁盘空间。

**`store: false`（默认）：字段不单独存储**

ES 默认不单独存储每个字段（`store: false`），字段数据通过 `_source` 返回（从 `.fdt` 文件读取整个 `_source` JSON，再解析出目标字段）。

只有在 `_source` 被禁用，但仍需要返回特定字段时，才需要 `store: true`。在大多数场景下，`store: true` 只会增加存储冗余，不建议使用。

### 1.3 _source 的取舍

`_source` 存储了文档的原始 JSON，是 Fetch Phase 返回字段数据的来源。禁用 `_source` 可以节省大量磁盘空间（通常 `_source` 占总存储的 40%~60%），但代价是：

- 无法使用 `_update` 和 `_reindex`（这两个操作需要读取 `_source`）；
- 无法返回字段值（除非字段开启了 `store: true`）；
- 无法使用 `highlight`（高亮需要读取原始文本）；
- 数据迁移困难（无法从 ES 直接导出完整文档重建索引）。

**折中方案：`_source includes/excludes`**

只存储部分字段到 `_source`，减少存储空间：

```json
PUT /my-index
{
  "mappings": {
    "_source": {
      "excludes": ["raw_log", "full_stack_trace"]
    }
  }
}
```

被排除的字段仍然参与索引（如果 Mapping 中定义了相应字段），只是不存储在 `_source` 中。适合将原始大字段（如完整日志行、堆栈信息）排除，只保留结构化字段用于查询。

### 1.4 Shard 数量的预先规划

**Shard 数量一旦确定，不能在线修改**（只能通过 `_shrink`/`_split` 非在线操作调整）。因此，索引创建时合理规划 Shard 数量至关重要。

**过多 Shard 的代价：**
- 每个 Shard 是一个独立的 Lucene 索引，有固定的内存 overhead（默认约 500KB~1MB Heap per Shard）；
- 查询在所有 Shard 上并行执行，Shard 越多，协调开销越大（网络往返、结果合并）；
- Master 需要维护更大的 Routing Table。

**Shard 大小的黄金区间：**

ES 官方建议单个 Shard 大小在 **10GB~50GB** 之间。太小（< 1GB）说明分片过多、overhead 占比高；太大（> 50GB）会导致故障恢复时间长（单 Shard 恢复需要重建所有数据，越大越慢）。

**分片数计算公式：**
```
预期索引大小(GB) / 目标单片大小(GB) = Primary Shard 数量

例：
预期每天日志量 500GB，保留 7 天，总量 3500GB
目标单片 30GB → Primary Shard = 3500 / 30 ≈ 117

考虑未来 2 倍增长 → 取整为 150 个 Primary Shard
分布到 10 个数据节点 → 每节点 15 个 Primary Shard（合理）
```

对于时序类索引（每天/每小时一个索引），结合 ILM 滚动策略，每个时间段的索引大小可控，更容易规划。

---

## 第 2 章 查询优化：让每一次搜索物尽其用

### 2.1 Filter 优先于 Query

这是 ES 查询优化中最高回报的单项措施，在第 4 篇文章中已有提及，这里结合实际案例深化。

**原则：所有不需要相关性评分的查询条件，放入 `filter` 子句。**

```json
// 错误写法：status 条件在 must 中，参与 BM25 评分，且无法缓存
{
  "query": {
    "bool": {
      "must": [
        { "term": { "status": "published" } },
        { "match": { "title": "Elasticsearch" } }
      ]
    }
  }
}

// 正确写法：status 在 filter 中，不计分，可被 Filter Cache 缓存
{
  "query": {
    "bool": {
      "must": [
        { "match": { "title": "Elasticsearch" } }
      ],
      "filter": [
        { "term": { "status": "published" } }
      ]
    }
  }
}
```

`filter` 子句的结果会被 **Filter Cache**（Node-level Query Cache）缓存，基于 LRU 策略，大小由 `indices.queries.cache.size`（默认 10% Heap）控制。下次遇到相同 `filter` 条件时直接命中缓存，完全绕过 Lucene 的倒排索引查询。

**Filter Cache 的生效条件：**
- 查询条件必须是确定性的（不能包含动态参数如 `now`，或使用了 `now/m` 时间取整后可缓存）；
- 同一 Shard 上同一查询条件才能命中缓存（不同 Shard 各自维护独立的 Cache）；
- Segment 发生 Merge 后，对应的 Cache 失效（新 Segment 结构变化，缓存不再适用）。

### 2.2 Routing：精确定位目标 Shard

默认情况下，ES 按 `_id` 的哈希值路由文档到 Shard：

```
shard_num = hash(_id) % number_of_primary_shards
```

查询时，如果不指定 Routing，ES 需要在**所有** Primary Shard 上执行查询，再合并结果。对于有明确数据分区特征的场景（如按用户 ID 分区的多租户系统），可以指定 Routing，让相同 Routing key 的文档都写入同一 Shard，查询时只需访问对应的 Shard：

**写入时指定 Routing：**
```http
POST /user-logs/_doc?routing=user_123
{
  "user_id": "user_123",
  "action": "login",
  "timestamp": "2026-03-04T10:00:00"
}
```

**查询时指定同样的 Routing：**
```http
GET /user-logs/_search?routing=user_123
{
  "query": {
    "term": { "user_id": "user_123" }
  }
}
```

效果：只访问存储 `user_123` 数据的 1 个 Shard，而非全部 N 个 Shard。对于 10 个 Shard 的索引，查询代价降低 10 倍（网络往返减少 90%，合并结果的 overhead 消除）。

> [!warning] 生产避坑
> Routing 的代价是**数据倾斜**。如果某个 Routing key 的文档数量远超其他 key（如超级活跃用户），对应 Shard 会成为热点，其磁盘空间、查询负载远高于其他 Shard。应确保 Routing key 的分布相对均匀，或对超大 key 做特殊处理（如为 VIP 用户单独分配 Shard）。

### 2.3 Source Filtering：减少 Fetch Phase 的数据量

当查询只需要部分字段时，通过 `_source` includes 只返回需要的字段，减少 Fetch Phase 的网络传输和 JSON 解析开销：

```json
{
  "query": { "match": { "title": "Elasticsearch" } },
  "_source": ["title", "author", "publish_date"],
  "size": 10
}
```

对于 `_source` 很大（如包含完整文章正文）但只需要展示摘要的场景，Source Filtering 可以将网络传输量降低数十倍。

更彻底的方案是完全禁用 `_source` 返回，通过 `fields` 参数从 Doc Values 中读取字段值（只适用于 `keyword`、`numeric`、`date` 等有 Doc Values 的字段类型）：

```json
{
  "query": { "match": { "title": "Elasticsearch" } },
  "_source": false,
  "fields": ["title.keyword", "author.keyword", "publish_date"]
}
```

从 Doc Values 读取比从 `_source` 解析 JSON 更快，且可以避免读取整个 `_source` JSON 带来的 IO 放大。

### 2.4 Search After 替代深分页

深分页问题（`from + size` 过大）在第 4 篇已经介绍。这里给出 `search_after` 的完整使用示例：

**第一页：**
```json
{
  "query": { "match_all": {} },
  "sort": [
    { "publish_date": "desc" },
    { "_id": "desc" }
  ],
  "size": 10
}
```

**后续页（使用上一页最后一条文档的排序值作为 cursor）：**
```json
{
  "query": { "match_all": {} },
  "sort": [
    { "publish_date": "desc" },
    { "_id": "desc" }
  ],
  "search_after": ["2026-03-04T09:00:00", "doc-id-xyz"],
  "size": 10
}
```

`search_after` 的核心优势是：无论翻到第几页，每次查询的代价都是固定的（只需在每个 Shard 上找排序值小于 cursor 的前 `size` 条文档），不随页码增大而增加。

注意：`search_after` 要求排序字段是唯一的（或最后一个排序字段加入 `_id` 确保唯一），否则游标位置不确定，可能跳过或重复文档。

### 2.5 避免使用 wildcard 和 leading wildcard

`wildcard` 查询（`*`、`?`）和 `regexp` 查询会扫描词典中的所有词条，时间复杂度接近 O(词典大小)。**leading wildcard**（如 `*foo`）尤为危险——ES 无法利用 FST 词典的前缀压缩进行快速定位，必须线性扫描所有词条。

对于频繁的前缀查询（如自动补全），使用 `prefix` 查询（可以利用 FST 加速）或专门的 `completion` 类型；对于子串匹配，提前用 n-gram 分析器分词（将词分解为所有子串的 n-gram），转化为精确 `term` 查询。

```json
// 慢：leading wildcard，线性扫描词典
{ "wildcard": { "title": "*cloud" } }

// 快：使用 n-gram 分析器（需要提前在 Mapping 中配置）
{ "term": { "title.ngram": "cloud" } }
```

---

## 第 3 章 JVM 调优：Heap 与 Off-Heap 的平衡艺术

### 3.1 ES 的内存架构

ES 进程的内存分为两大部分：

```
┌─────────────────────────────────────┐
│           JVM Heap                  │
│  ┌──────────────┬──────────────┐    │
│  │  Young Gen   │   Old Gen    │    │
│  │  (Eden+S0+S1)│              │    │
│  └──────────────┴──────────────┘    │
│  用途：对象分配、聚合计算、            │
│       Cluster State、Field Data 缓存 │
└─────────────────────────────────────┘
┌─────────────────────────────────────┐
│           Off-Heap (Native Memory)  │
│  ┌─────────────────────────────┐    │
│  │  OS Page Cache              │    │
│  │  (Lucene Segment 文件缓存)  │    │
│  └─────────────────────────────┘    │
│  用途：Lucene 索引文件缓存            │
│       (倒排索引、Doc Values 等)       │
└─────────────────────────────────────┘
```

**Heap 负责 ES 应用逻辑的对象分配；Off-Heap（通过 OS Page Cache）负责 Lucene 文件的缓存。**

这两部分共享同一台机器的物理内存。Heap 越大，留给 Page Cache 的空间越小；Page Cache 越小，Lucene 文件的缓存命中率越低，磁盘 IO 越多。因此，ES 的内存调优不是"Heap 越大越好"，而是在 Heap 和 Page Cache 之间找到最优分配点。

### 3.2 Heap 大小的黄金法则

**法则一：Heap 不超过物理内存的 50%**

剩余的 50% 留给 OS Page Cache。这是 ES 性能调优中最重要的单条建议。对于一台 64GB 内存的节点，Heap 设置为 32GB，剩余 32GB 作为 Page Cache，可以缓存约 32GB 的 Lucene 文件（倒排索引 + Doc Values），这对查询性能至关重要。

**法则二：Heap 不超过 32GB（JVM 指针压缩阈值）**

这是 JVM 的一个关键阈值。当 Heap < 32GB 时，JVM 使用 **Compressed OOPs**（压缩对象指针），每个对象引用占 4 字节而非 8 字节。超过 32GB 后，指针变为 8 字节，对象内存占用增大约 30%~50%，实际可用的对象空间反而减少（超出 32GB 的收益被指针膨胀抵消）。

**实际意义：**
- 64GB 内存节点：Heap = 31GB（在 32GB 阈值以下），Page Cache = 33GB；
- 128GB 内存节点：建议拆成两个 ES 实例，每个 Heap = 31GB，而不是单个实例 Heap = 64GB；
- 或者：Heap = 31GB，剩余 97GB 全部给 Page Cache（搜索密集型场景，大量 Segment 需要缓存）。

```yaml
# jvm.options
-Xms31g
-Xmx31g
```

`-Xms` 和 `-Xmx` 设置为相同值，防止 JVM 在运行时动态扩缩 Heap（每次扩展都可能触发 Full GC）。

### 3.3 GC 算法选择

**ES 7.x 及以下：推荐 CMS 或 G1GC**

ES 7.x 默认推荐 **G1GC**：
```
# jvm.options
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=4m
```

G1GC 的优势：通过 Region 化的内存布局，尽量将 GC STW 暂停时间控制在目标范围内（`MaxGCPauseMillis`），避免大 Heap 下 CMS 常见的长暂停问题。

**ES 8.x：推荐 ZGC 或 G1GC**

ES 8.x 开始支持 **ZGC**（Z Garbage Collector），特别适合大 Heap（> 16GB）场景：
```
# jvm.options (ES 8.x)
-XX:+UseZGC
```

ZGC 的 STW 暂停时间通常在 1ms 以内（与 Heap 大小基本无关），极大地降低了大 Heap 下的 GC 抖动，对 P99 延迟有显著改善。

> [!warning] 生产避坑
> **观察 GC 日志是 ES 调优的第一步**。ES 默认将 GC 日志输出到 `logs/gc.log`。关注以下指标：
> - Young GC 频率：正常情况下每几十秒一次，每次暂停 < 100ms；
> - Old Gen GC（Full GC / Major GC）：频率应极低（每天几次或更少），每次暂停应 < 1s；
> - 如果出现频繁的 Full GC，往往是 Heap 不足（数据量增长超出 Heap 容量）或内存泄漏（Field Data 缓存未限制）。

### 3.4 Heap 的主要消耗者

了解 Heap 的主要消耗者，才能有针对性地优化：

**Cluster State**：Master 节点维护整个集群的元数据，大型集群（数千索引、数十万 Shard）的 Cluster State 可达数百 MB，完全在 Heap 中序列化/反序列化。

**In-flight 查询请求**：每个正在执行的查询，其中间结果（Priority Queue、聚合 HashMap）都在 Heap 中。并发查询越多，Heap 消耗越大。

**聚合计算**：Terms 聚合的 HashMap、TDigest 质心列表、HLL++ 寄存器等，全在 Heap 中。高基数聚合是 Heap 消耗最大的单一操作。

**Translog 缓冲**：未 Flush 到磁盘的 Translog 数据在内存中缓冲（少量，通常可忽略）。

**Field Data Cache**（`text` 字段聚合）：如果不幸开启了 Field Data，这是最危险的 Heap 消耗者。应通过 `indices.fielddata.cache.size`（如 `20%` Heap）限制其大小，避免 OOM。

### 3.5 swap 必须关闭

**ES 对 swap 极度不友好**。JVM 的 GC 需要对整个 Heap 进行扫描，如果 Heap 的部分内容被 swap 到磁盘，GC 的 STW 暂停时间会从几百毫秒暴增到数十秒甚至数分钟。

生产环境必须确保 ES 进程不会使用 swap：

```bash
# 方法一：关闭系统 swap（所有进程均不使用 swap）
swapoff -a
# 持久化（编辑 /etc/fstab，注释掉 swap 行）

# 方法二：仅锁定 ES 进程的内存（推荐，不影响其他进程）
# elasticsearch.yml
bootstrap.mlockall: true
```

`mlockall: true` 要求操作系统将 ES 进程的所有内存页锁定在物理内存中，不允许 swap。需要系统级权限支持（`ulimit -l unlimited`）。

---

## 第 4 章 磁盘 IO 优化

### 4.1 文件系统的选择

ES 对磁盘的访问模式以顺序 IO 为主（Segment 文件的顺序读、Translog 的顺序追加写），间以随机 IO（Fetch Phase 的 `.fdt` 文件随机读）。

**推荐文件系统：ext4 或 xfs**

- `xfs` 在高并发写入场景下（多 Shard 同时写）表现优于 `ext4`，因为 xfs 的目录索引结构更适合大量小文件；
- `ext4` 更成熟稳定，调优相对简单。

**挂载参数建议：**
```
# /etc/fstab
/dev/sdb1 /data xfs defaults,noatime 0 0
```

`noatime`：禁用文件访问时间（atime）更新。每次读取文件时，Linux 默认会更新文件的访问时间，产生一次元数据写入。对于 Lucene 文件（高频读取），这会产生大量无意义的写 IO。`noatime` 可以消除这部分开销，提升读 IO 性能约 5%~15%。

### 4.2 使用 SSD 的注意事项

SSD 对 ES 性能的提升是全方位的：随机 IO 延迟从机械盘的毫秒级降到微秒级，对 Merge 和 Fetch Phase 尤为明显。但 SSD 也有特殊的注意事项：

**写放大问题**：SSD 的底层 Flash 只能以块（Block，通常 256KB~4MB）为单位擦除，小块写入会触发 SSD 内部的"读-修改-写"操作（Write Amplification Factor，WAF）。ES 的 Translog 是 append-only（对 SSD 友好），但 Merge 操作的大块重写会产生显著的 SSD 写放大。选择企业级 SSD（有 DRAM 缓存和高耐久度的 TLC/MLC NAND）而非消费级 SSD。

**I/O Scheduler**：Linux 的 I/O 调度器对 SSD 应设置为 `mq-deadline` 或 `none`（直接下发，不做排序优化，因为 SSD 的随机 IO 开销已经很低，不需要 elevator 算法合并请求）：
```bash
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
```

---

## 第 5 章 Index Lifecycle Management：自动化运维

### 5.1 ILM 的四个阶段

**Index Lifecycle Management（ILM）** 是 ES 官方的索引生命周期自动化管理框架，将索引按年龄/大小划分为四个阶段，自动执行对应的操作：

| 阶段 | 时机 | 典型操作 |
|:---|:---|:---|
| **Hot** | 数据新鲜，频繁写入和查询 | Rollover（滚动新建索引）、Force Merge |
| **Warm** | 数据变老，仍有查询需求但不再写入 | 迁移到温节点（`shrink` 减少 Shard 数）、Force Merge 到 1 个 Segment |
| **Cold** | 数据更老，查询很少 | 迁移到冷节点、Freeze（只读，减少内存占用） |
| **Delete** | 数据超过保留期 | 删除索引 |

**典型日志索引的 ILM 策略：**
```json
PUT /_ilm/policy/logs-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_size": "50GB",
            "max_age": "1d"
          },
          "set_priority": { "priority": 100 }
        }
      },
      "warm": {
        "min_age": "3d",
        "actions": {
          "shrink": { "number_of_shards": 1 },
          "forcemerge": { "max_num_segments": 1 },
          "allocate": { "require": { "box_type": "warm" } },
          "set_priority": { "priority": 50 }
        }
      },
      "cold": {
        "min_age": "30d",
        "actions": {
          "allocate": { "require": { "box_type": "cold" } },
          "set_priority": { "priority": 0 }
        }
      },
      "delete": {
        "min_age": "90d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

ILM 将原本需要 SRE 手动执行的"数据老化迁移 + 定期 Force Merge + 过期删除"等运维操作，变成了自动化的声明式配置，大幅降低运维负担。

---

## 第 6 章 综合调优 Checklist

经过前面的分析，以下是一份可在生产环境直接使用的调优 Checklist：

**Mapping 层面：**
- [ ] 关闭 Dynamic Mapping（`dynamic: strict`），显式定义所有字段；
- [ ] 不需要聚合/排序的高基数 ID 字段，关闭 `doc_values`；
- [ ] 不需要搜索的大型文本字段，设置 `index: false` 或 `enabled: false`；
- [ ] 文本字段根据需求选择 `text`（全文搜索）或 `keyword`（精确匹配）；
- [ ] 合理规划 Shard 数量（单 Shard 目标大小 10~50GB）。

**查询层面：**
- [ ] 所有过滤条件放入 `filter` 子句（利用 Filter Cache）；
- [ ] 对有数据分区特征的场景使用 Routing；
- [ ] 深分页用 `search_after` 替代 `from + size`；
- [ ] 只返回需要的字段（`_source includes` 或 `fields`）；
- [ ] 避免 `wildcard` 和 `leading wildcard` 查询。

**JVM 层面：**
- [ ] Heap 设置为物理内存的 50%，且不超过 31GB；
- [ ] `-Xms` 和 `-Xmx` 设为相同值；
- [ ] 开启 `bootstrap.mlockall: true`，关闭 swap；
- [ ] 使用 G1GC（7.x）或 ZGC（8.x）。

**运维层面：**
- [ ] 配置 Allocation Awareness（按可用区分散副本）；
- [ ] 配置热温冷分层存储；
- [ ] 为时序索引配置 ILM 策略（自动 Rollover + Force Merge + 迁移 + 删除）；
- [ ] Master 节点专用化，避免 GC 导致的选举震荡。

---

## 小结

本文从"设计即调优"的视角，系统梳理了 ES 性能优化的三个层次：

- **Mapping 设计**是性能的第一道关卡：合理选择字段类型、控制字段数量、预规划 Shard 数量，能从根本上避免大多数性能问题；
- **查询优化**的核心是减少不必要的计算：Filter 优先利用缓存、Routing 减少涉及 Shard 数、Search After 解决深分页；
- **JVM 调优**的关键是 Heap 与 Page Cache 的平衡：不超过 31GB 的 Heap 限制、禁止 swap、选择适合 Heap 大小的 GC 算法。

下一篇文章将转向 ES 的生产运维实践——关键监控指标体系、容量规划方法论与版本升级策略。
