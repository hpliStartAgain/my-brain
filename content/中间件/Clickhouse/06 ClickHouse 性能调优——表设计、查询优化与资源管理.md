---
title: "06 ClickHouse 性能调优——表设计、查询优化与资源管理"
date: 2026-03-05
tags: [ClickHouse, 主键设计, 性能调优, 查询优化, 物化视图, 资源管理, 跳数索引, LowCardinality, Workload Groups, 压缩编码]
aliases: [ClickHouse 性能调优, ClickHouse 表设计, ClickHouse 查询优化, ClickHouse 资源管理, ClickHouse 物化视图, ClickHouse 跳数索引, ClickHouse LowCardinality, ClickHouse Workload Groups]
---

# 06 ClickHouse 性能调优——表设计、查询优化与资源管理

**摘要：**
ClickHouse 的性能调优分为三个层次——**表设计**（主键选择、分区策略、跳数索引、压缩编码、LowCardinality）、**查询优化**（避免全表扫描、物化视图预聚合、Prewhere、SQL 写法、字典 JOIN）和**资源管理**（Settings Profile、Quota、Workload Groups、内存溢写、并发控制）。本文系统梳理这三个层次的调优方法，重点阐明每个优化手段的原理和边界——不是"这样做更快"的操作手册，而是"为什么这样做更快"的深度分析。理解了前 5 篇的存储与执行原理，本文的调优手法才能"知其然且知其所以然"——而不是机械地抄配置。

---

## 第 1 章 表设计调优——性能的源头

### 1.1 主键与排序键的设计原则

ClickHouse 的主键（`PRIMARY KEY` / `ORDER BY`）是最重要的性能决策，直接决定了查询的索引剪枝效果——第 02 篇讲过，稀疏索引按主键排序，查询时按主键前缀做范围剪枝。主键设计错了，后面所有优化都补不回来。

**原则一：高频过滤列放在主键最左侧**

稀疏索引支持**最左前缀匹配**——查询条件必须匹配排序键的最左列，才能有效利用索引剪枝。

```sql
-- 表设计：ORDER BY (date, region, user_id)
-- 查询 1：WHERE date = '2024-01-01' → ✅ 有效剪枝（date 是第一列）
-- 查询 2：WHERE date = '2024-01-01' AND region = 'BJ' → ✅ 有效剪枝（前两列）
-- 查询 3：WHERE region = 'BJ' → ❌ 无法剪枝（region 不是第一列，date 条件缺失）
-- 查询 4：WHERE user_id = 12345 → ❌ 无法剪枝
```

如果业务上 `region` 维度的查询比 `date` 更频繁，应将 `region` 放在第一位。但对于时序数据，`date` 通常作为第一列——时间范围是最常见的过滤条件，且连续时间数据的物理存储局部性好（时间连续的 Granule 可能在磁盘上相邻，IO 更友好）。

**主键列顺序的决策可以用一个简单规则概括——"查询频率从高到低排，基数从低到高排"**。`date` 查询频率最高且基数低（几千个日期），放第一；`region` 查询频率次高且基数低（几十个地区），放第二；`user_id` 查询频率低且基数高（百万用户），放第三。这个"频率 + 基数"的双重排序是主键设计的经验法则。

这个法则有一个例外值得注意——**"等值查询"与"范围查询"的差异**。稀疏索引对"等值查询"和"范围查询"的剪枝效果不同——等值查询（`WHERE date = '2024-01-01'`）能精确定位到包含该值的 Granule；范围查询（`WHERE date BETWEEN '2024-01-01' AND '2024-01-31'`）定位到范围内的所有 Granule。如果某列的查询都是"等值查询"（譬如 `WHERE status = 'active'`），它放主键任何位置都行；如果是"范围查询"（譬如 `WHERE date BETWEEN ...`），它放主键第一列最有价值（范围剪枝的效果最大）。**"范围查询列优先放主键左侧"是"频率 + 基数"法则的补充**——范围查询从主键最左列开始才能做范围剪枝。

主键设计还有一个与"ORDER BY 和 PRIMARY KEY 的区别"相关的进阶用法——**PRIMARY KEY 可以是 ORDER BY 的前缀**。第 02 篇讲过，`ORDER BY` 决定数据排序，`PRIMARY KEY` 决定稀疏索引。如果 `ORDER BY (date, user_id, event_type)` 但 `PRIMARY KEY (date, user_id)`，数据按三列排序，但稀疏索引只记前两列——索引更小（不记 `event_type`），但 `event_type` 无法用稀疏索引剪枝。**"ORDER BY 比 PRIMARY KEY 多几列"是"排序精度"与"索引大小"的权衡**——多排几列让数据更聚簇（`event_type` 在 `(date, user_id)` 内有序），但索引不记这几列，剪枝精度不提升。这种设计适合"按前两列查询为主，偶尔按第三列查询"的场景——前两列剪枝准，第三列用跳数索引补充。

**原则二：主键列基数不宜太高**

主键列基数（不同值的数量）不宜过高。高基数列作为主键意味着相邻的 Granule 之间主键值差异很大，稀疏索引的剪枝精度下降。

- `date`（低基数，几千个不同日期值）：非常适合作为主键第一列，每个 `date` 值对应的数据在连续的 Granule 中，剪枝极准
- `user_id`（高基数，数亿个不同用户）：适合放在主键后几位，作为在日期范围内进一步过滤的依据
- `session_id`（极高基数，全局唯一）：不适合作为主键，无法有效剪枝；如果需要按 session_id 查询，应使用跳数索引

高基数列放主键为什么剪枝精度差？因为稀疏索引是"每 8192 行记一个主键值"——如果主键是 `session_id`（每行都不同），8192 行的主键值范围是 `[session_1, session_8192]`，这个范围几乎覆盖所有可能的 `session_id`——查询 `WHERE session_id = 'xxx'` 时，几乎所有 Granule 的主键范围都包含 `xxx`，无法跳过任何 Granule。**稀疏索引的剪枝效果取决于"主键值的聚簇程度"——同一主键值的数据越聚簇，剪枝越准**。高基数列让数据无法聚簇（每个值只有几行），剪枝失效。

这个"聚簇程度"的概念可以用一个具体例子来感受。假设主键是 `(date, user_id)`，10 亿行数据：
- `date` 有 1000 个值（3 年的日数据），每个 `date` 值约 100 万行——数据按 `date` 高度聚簇，查询 `WHERE date = '2024-01-01'` 能精确定位到约 100 万行（1000 个 Granule 中的 122 个）。
- `user_id` 有 100 万个值，每个 `user_id` 值约 1000 行——数据按 `user_id` 分散，查询 `WHERE user_id = 12345` 在 `date` 范围内仍要扫该 `date` 的所有 100 万行（因为 `user_id` 在 `date` 内部是排序的，但每个 `user_id` 只有 1000 行，跨多个 Granule）。

如果把主键改成 `(user_id, date)`——`user_id` 放第一列：
- 查询 `WHERE user_id = 12345` 能精确定位到该 `user_id` 的约 1000 行——剪枝极准。
- 查询 `WHERE date = '2024-01-01'` 无法剪枝——`date` 不是第一列，且 `user_id` 范围覆盖所有值，稀疏索引无法跳过任何 Granule。

**主键顺序的选择本质上是"哪个查询的剪枝更重要"的权衡**——把 `date` 放第一，时间范围查询剪枝准但 `user_id` 查询全扫；把 `user_id` 放第一，`user_id` 查询剪枝准但时间范围查询全扫。生产中通常把 `date` 放第一——因为"时间范围查询"比"单用户查询"更常见（报表、看板都是时间范围），且时间范围查询的数据量大（扫一个月几亿行），剪枝收益更大。

**原则三：主键越短越好**

主键越短，稀疏索引的内存占用越小，更容易完整缓存在 OS Page Cache 中，查询时的内存 IO 更少。譬如主键 `(date, user_id)`——`date` 是 2 字节，`user_id` 是 8 字节，每个主键条目 10 字节；如果再加 `session_id`（String，平均 36 字节），每个条目 46 字节——索引内存占用翻 4 倍。**主键列数通常不超过 4 个**——超过后索引膨胀，缓存命中率下降。

主键长度还有一个与"Merge 性能"相关的影响——Merge 时要按主键排序合并多个 Part，主键越长，排序比较的代价越高。譬如主键 `(date, user_id)` 的排序比较是"先比 date（2 字节），再比 user_id（8 字节）"；主键 `(date, user_id, session_id, request_id)` 的排序比较要比 4 列，每列都可能触发字符串比较。**主键越长，Merge 的 CPU 开销越大**——这也是"主键越短越好"的一个原因。

### 1.2 分区策略的选择

分区是粗粒度剪枝，通常按时间维度分区：

```sql
-- 日志类数据（高写入频率，每天新增数亿行）
PARTITION BY toDate(timestamp)  -- 按天分区

-- 业务数据（适中写入量，历史数据需要长期保留）
PARTITION BY toYYYYMM(date)     -- 按月分区

-- 不需要分区（小表，几百万行以内）
-- 不设置 PARTITION BY，或 PARTITION BY tuple()
```

分区设计有三个关键原则：

**分区的数据量不能太小**——每个分区至少应包含几十万行数据，否则每个分区只有少数几个 Part，Merge 效果差（Part 太少合并不起来），查询时 Part 文件 open/close 开销占比高。譬如按天分区但每天只有几千行——每个分区一个几百 KB 的 Part，查询扫 365 个分区要 open 365 个文件，开销远大于数据本身。

**分区的数据量不能太大**——单个分区不宜超过几亿行或几十 GB。分区太大时，DROP PARTITION（删一个分区）的代价高（删几十 GB 要几秒到几十秒），且单个分区的 Merge 任务重（合并几十 GB 的 Part 要几分钟）。**"分区的数据量不能太大**——单个分区不宜超过几亿行或几十 GB。分区太大时，DROP PARTITION（删一个分区）的代价高（删几十 GB 要几秒到几十秒），且单个分区的 Merge 任务重（合并几十 GB 的 Part 要几分钟）。**"按天分区"对日志类数据是较好的平衡——每天几千万到几亿行，分区大小在 GB 级**。

分区大小的"上下限"可以用一个经验区间来概括——**单分区数据量在 1GB 到 10GB 之间是较优的**。小于 1GB，分区太碎，Part 管理开销大；大于 10GB，分区太重，DROP 和 Merge 代价高。按这个区间反推分区粒度——如果每天数据 5GB，按天分区（每分区 5GB）合适；如果每天数据 100GB，按天分区（每分区 100GB）太重，应该按小时分区（每分区约 4GB）；如果每天数据 100MB，按天分区（每分区 100MB）太碎，应该按月分区（每分区约 3GB）。**"分区大小 1-10GB"是分区粒度选择的锚点**——根据日均数据量反推合适的分区键。

分区键的选择还有一个与"分区裁剪"配合的细节——**分区键和主键的第一列通常相同**。譬如 `PARTITION BY toYYYYMM(date)` 且 `ORDER BY (date, user_id)`——分区键是 `toYYYYMM(date)`，主键第一列是 `date`。查询 `WHERE date >= '2024-01-01' AND date < '2024-02-01'` 时，分区裁剪到 202401 分区，主键剪枝到该分区内 `date` 范围内的 Granule——两层剪枝叠加，效果最大。如果分区键和主键第一列不同（譬如 `PARTITION BY toYYYYMM(date)` 但 `ORDER BY (user_id, date)`），分区裁剪到 202401 分区后，主键第一列是 `user_id`，`date` 范围无法用主键剪枝——只能扫整个分区的所有 Granule。**"分区键和主键第一列对齐"是两层剪枝协同的前提**——这是表设计的一个常见疏漏点。

这个疏漏的典型表现是——建表时把分区键设成 `toYYYYMM(timestamp)`，但主键设成 `(user_id, timestamp)`（因为按 `user_id` 查询更多）。结果是——按时间范围查询时，分区裁剪到月，但月内按 `user_id` 排序，`timestamp` 范围无法用主键剪枝，扫整个月。解法是——**主键第一列改成 `timestamp`**，让分区键和主键第一列对齐；`user_id` 放第二列，在 `timestamp` 范围内做二级剪枝。虽然 `user_id` 查询的剪枝效果下降（从第一列变第二列），但时间范围查询的剪枝效果大幅提升——通常是更优的权衡。

这个权衡的判断标准是——**"时间范围查询的频率和扫表代价" vs "单用户查询的频率和扫表代价"**。时间范围查询通常扫大量数据（一个月几亿行），剪枝收益大；单用户查询通常扫少量数据（一个用户几千行），即使全分区扫也快。所以"主键第一列对齐分区键"通常更优——让代价大的查询拿到剪枝收益。

**分区键要支持查询的过滤模式**——如果业务常按"月"查询（`WHERE date BETWEEN '2024-01-01' AND '2024-01-31'`），按月分区让分区裁剪直接跳到目标月；如果按天分区，同一个月的查询要扫 30 个分区，虽然每个分区都小，但 open 的文件多。**分区粒度应该匹配"典型查询的时间范围"**——按天查按天分区，按月查按月分区。

分区策略还有一个与"分区裁剪"相关的细节——**分区键的函数选择影响裁剪精度**。`PARTITION BY toYYYYMM(date)` 按月分区，查询 `WHERE date >= '2024-01-15' AND date < '2024-02-15'` 会裁剪到 202401 和 202402 两个分区——但实际需要的数据是 1 月 15 到 2 月 15，1 月 1-14 和 2 月 16-29 的数据被"多扫"了（分区粒度粗于查询粒度）。`PARTITION BY toDate(date)` 按天分区，同样的查询裁剪到 1 月 15 到 2 月 14 的 31 个分区——精确匹配，不多扫。**"裁剪精度"与"Part 数量"的权衡。

这个权衡可以用一个具体例子来量化——假设 3 年的日数据（1000 天），每天 1 亿行：
- 按月分区：12 × 3 = 36 个分区，每分区约 30 亿行。查询"某一天"要扫该天所在月的整个分区（30 亿行），多扫 29 天的数据。
- 按天分区：1000 个分区，每分区 1 亿行。查询"某一天"只扫该天分区（1 亿行），精确匹配。

按天分区的查询 IO 是按月分区的 1/30——但分区数是 30 倍。如果 Merge 能跟上（1000 个分区的 Part 管理可控），按天分区更优；如果 Merge 压力大，按月分区更稳。**"按天分区"适合"查询粒度细 + Merge 能力强"的集群，"按月分区"适合"查询粒度粗 + Merge 压力大"的集群**——没有绝对优劣，取决于集群能力和查询模式。

### 1.3 跳数索引——主键之外的二级过滤

当查询条件不能利用主键进行剪枝时，**跳数索引（Skip Index）** 可以在 Granule 级别提供额外过滤。

跳数索引不是传统的 B+Tree 索引，而是**对每个 Granule 存储简化的统计信息**，查询时根据统计信息决定是否可以跳过该 Granule。它与稀疏索引的区别在于——稀疏索引是"主键的范围边界"，跳数索引是"非主键列的统计摘要"。稀疏索引自动建（主键自带），跳数索引手动建（`INDEX` 子句）。

**MinMax 索引**（适合低基数数值列或有序列）：

```sql
CREATE TABLE events (
    date    Date,
    user_id UInt64,
    region  String,
    amount  Float64,
    INDEX idx_region region TYPE minmax GRANULARITY 4
    -- 每 4 个 Granule 存储 region 列的最小最大值
) ENGINE = MergeTree() ORDER BY (date, user_id);
```

查询 `WHERE region = 'Beijing'` 时，如果某个 Granule 组的 minmax 统计显示 `region` 的值范围不包含 `Beijing`，这些 Granule 被跳过，不读取数据。MinMax 索引的代价低（只存两个值），但对高基数列（譬如 `user_id`）几乎无效——`user_id` 的 minmax 范围几乎覆盖所有值，无法跳过任何 Granule。

**Set 索引**（适合低基数列的精确匹配）：

```sql
INDEX idx_status status TYPE set(100)  -- 每个 Granule 存储最多 100 个不同的 status 值
GRANULARITY 1
```

Set 索引存储每个 Granule 的"不同值集合"（最多 N 个），查询 `WHERE status = 'active'` 时检查 `active` 是否在集合里——不在就跳过 Granule。Set 索引适合"基数低于 N"的列——如果列的基数超过 N，Set 索引只存前 N 个值，可能漏掉实际存在的值，导致误跳（跳过了本该读的 Granule）。

**Bloom Filter 索引**（适合高基数列的等值过滤）：

```sql
INDEX idx_request_id request_id TYPE bloom_filter(0.01)  -- 1% 误判率
GRANULARITY 1
```

对于查询 `WHERE request_id = 'abc-123'`，Bloom Filter 能以 99% 的概率正确判断某个 Granule 中不存在这个值，从而跳过该 Granule。Bloom Filter 适合高基数列（譬如 `request_id`、`trace_id`）——这些列无法用 MinMax（范围太大）或 Set（基数太高），但 Bloom Filter 的概率过滤仍然能跳过大部分 Granule。

> [!warning] 生产避坑：跳数索引的代价
> 跳数索引在写入时增加额外的计算和存储开销（每次 Part 写入/Merge 都需要更新索引）。不要为所有列都创建跳数索引——只为确实有高频点查需求且主键无法覆盖的列创建。
> 可以用 `EXPLAIN INDEXES` 验证查询是否实际利用了跳数索引。

跳数索引的 `GRANULARITY` 参数有一个值得理解的细节——它控制"每几个 Granule 建一个索引条目"。`GRANULARITY 1` 表示每个 Granule 一个条目（最细），`GRANULARITY 4` 表示每 4 个 Granule 一个条目（较粗）。`GRANULARITY` 大，索引小（条目少），但跳过精度低（要跳就跳 4 个 Granule）；`GRANULARITY` 小，索引大（条目多），但跳过精度高（可以单 Granule 跳）。**`GRANULARITY` 是"索引大小"与"跳过精度"的权衡**——通常 `GRANULARITY 1` 用于 Bloom Filter（精确跳过），`GRANULARITY 4` 用于 MinMax（范围统计，粗一点够用）。

### 1.4 压缩编码——IO 的隐形优化

第 01 篇讲过 ClickHouse 的列式压缩——每列独立压缩，IO 量减少。压缩编码的选择是表设计的一个隐形优化点——选对了，IO 降一半；选错了，CPU 浪费。

ClickHouse 支持多种压缩编码，常用的有：

**LZ4（默认）**——通用压缩，速度快（压缩/解压都快），压缩比中等（2-5x）。适合"对压缩比要求不高、对速度敏感"的列。**LZ4 是默认选择，大多数列用 LZ4 即可**。

**ZSTD**——高压缩比，速度较慢（压缩慢，解压尚可），压缩比高（5-10x）。适合"对压缩比要求高、查询频率低"的列——譬如历史数据列、冷数据列。**ZSTD 用 CPU 换 IO——对 IO 瓶颈的集群有效，对 CPU 瓶颈的集群可能适得其反**。

**Delta**——对"相邻值差异小"的列有效，存储"当前值与前值的差"而非原始值。适合时序数据的时间戳列、自增 ID 列。Delta 编码通常配合 LZ4 或 ZSTD 使用——先 Delta 再 LZ4，压缩比比纯 LZ4 高。

**DoubleDelta**——Delta 的变体，存储"差值的差"，对"变化率稳定"的列更有效。适合监控指标列（譬如温度、CPU 利用率，变化平稳）。

**Gorilla**——对 Float 列的专用编码，来自 Facebook 的 Gorilla 论文，用 XOR 差异编码浮点数。适合监控指标列（Float 类型）。

```sql
CREATE TABLE metrics (
    timestamp DateTime CODEC(Delta, ZSTD),
    cpu_usage Float64 CODEC(Gorilla, ZSTD),
    memory_usage Float64 CODEC(Gorilla, ZSTD),
    log_message String CODEC(ZSTD(3))  -- ZSTD 压缩级别 3
) ENGINE = MergeTree() ORDER BY (timestamp);
```

压缩编码的选择原则是——**"看列的数据特征选编码"**。时间戳用 Delta（相邻值差异小），Float 指标用 Gorilla（浮点专用），String 用 LZ4 或 ZSTD（通用）。**不要对所有列用同一种编码**——那是浪费了 ClickHouse 的多编码支持。

压缩编码的选择还有一个与"查询模式"相关的考量——**频繁查询的列用低压缩比（LZ4），冷数据列用高压缩比（ZSTD）**。LZ4 解压快，查询时 CPU 开销低；ZSTD 解压慢，查询时 CPU 开销高。如果某列频繁被查询（譬如 `amount` 列在所有聚合查询里都用），用 LZ4 让查询快；如果某列很少被查询（譬如 `raw_log` 列只偶尔查），用 ZSTD 让存储省。**"热列用 LZ4，冷列用 ZSTD"是压缩编码的分层策略**——与第 03 篇讲的"热数据在 NVMe，冷数据在 HDD"的存储分层思路一致。

压缩编码的选择对"查询性能"的影响可以用一个数字来感受——假设一列 100GB 原始数据，LZ4 压缩到 25GB（4x），ZSTD 压缩到 12GB（8x）。查询这列时，LZ4 要读 25GB 磁盘 + 解压，ZSTD 要读 12GB 磁盘 + 解压。如果磁盘吞吐 500MB/s，LZ4 的 IO 时间 50 秒，ZSTD 的 IO 时间 24 秒——ZSTD 的 IO 少一半。但 ZSTD 的解压 CPU 开销比 LZ4 高 3-5 倍——如果 CPU 是瓶颈，ZSTD 可能反而慢。**"IO 瓶颈用 ZSTD，CPU 瓶颈用 LZ4"是压缩编码的选择策略**——看你的查询是"等磁盘"还是"等 CPU"。

怎么判断查询是"IO 瓶颈"还是"CPU 瓶颈"？看 `system.query_log` 的 `read_bytes`（读取字节数）和 `query_duration_ms`（查询时长）。如果 `read_bytes / query_duration_ms` 接近磁盘吞吐（譬如 500MB/s），说明查询在等磁盘——IO 瓶颈，换 ZSTD 减少读取量。如果 `read_bytes / query_duration_ms` 远低于磁盘吞吐（譬如 100MB/s），但 CPU 使用率高，说明查询在等 CPU 计算（解压、聚合）——CPU 瓶颈，换 LZ4 减少解压开销。**`system.query_log` 是判断"IO 瓶颈还是 CPU 瓶颈"的数据来源**——不要靠猜，用数据说话。

ClickHouse 还支持"按分区切换编码"——`CODEC(ZSTD, toYYYYMM(date) < 202301 ? LZ4 : ZSTD)`，让 2023 年前的冷数据用 ZSTD，2023 年后的热数据用 LZ4。这种"按分区动态选编码"让压缩策略与数据生命周期匹配——近期数据查询频繁用快编码，历史数据查询少用高压缩比编码。

压缩编码的变更有一个工程限制——**编码是建表时定的，改编码要重建表**。如果建表时用了 LZ4，后来想换 ZSTD，不能直接 `ALTER TABLE ... MODIFY COLUMN ... CODEC(ZSTD)`——虽然语法上支持，但已写入的 Part 仍然是 LZ4 编码，只有新写入的 Part 用 ZSTD。要让所有数据都换成 ZSTD，需要触发全表 Mutation（重写所有 Part）——代价高。**压缩编码的选择应该在建表时慎重决定**——不要指望"先 LZ4 后换 ZSTD"，换编码的代价是全表重写。

### 1.5 LowCardinality——低基数列的字典编码

`LowCardinality` 数据类型对低基数列（如 country、status、event_type）使用字典编码——用整数索引替代重复字符串。这可以将存储大小减少 10 倍以上，同时加速过滤和 GROUP BY。

```sql
CREATE TABLE events (
    date       Date,
    user_id    UInt64,
    region     LowCardinality(String),    -- 地区，几十个值
    event_type LowCardinality(String),    -- 事件类型，几百个值
    status     LowCardinality(String)     -- 状态，几个值
) ENGINE = MergeTree() ORDER BY (date, user_id);
```

`LowCardinality` 的工作原理是——列值存在一个字典里（譬如 `['Beijing', 'Shanghai', 'Guangzhou', ...]`），列数据存的是字典索引（`UInt8` 或 `UInt16`，1-2 字节）而非原始字符串（几十字节）。查询时按索引过滤或聚合，比按字符串快得多——比较 `UInt8` 比比较 String 快，HashTable 的 Key 是 `UInt8` 比 String 省内存。

**LowCardinality 的适用边界是"列的基数 < 10000"**——字典大小不超过 10000 个条目时，字典缓存在内存里，查询快。超过 10000 后，字典可能溢出缓存，查询时要回字典查找，性能下降。对高基数列（如 UUID、user_id）使用 `LowCardinality` 反而增加开销——字典大小超过内存缓存时性能退化。

> [!info] LowCardinality 的经验阈值
> - 基数 < 1000：强烈建议用 LowCardinality（字典极小，收益巨大）
> - 基数 1000-10000：建议用 LowCardinality（字典中等，收益明显）
> - 基数 10000-100000：谨慎使用（字典较大，收益递减）
> - 基数 > 100000：不要用 LowCardinality（字典太大，性能反而下降）

LowCardinality 的字典粒度是一个值得了解的细节——**字典是"Part 级"的，每个 Part 有自己的字典**。这意味着同一个列在不同 Part 里可能有不同的字典（譬如 Part 1 的 `region` 字典是 `['Beijing', 'Shanghai']`，Part 2 的字典是 `['Guangzhou', 'Shenzhen']`）。查询跨多个 Part 时，ClickHouse 要合并多个字典——这带来一点开销，但通常可忽略（字典很小）。**Part 级字典的好处是"写入时不需要全局协调"**——每个 Part 独立建字典，写入并行度高；坏处是"跨 Part 查询要合并字典"——但合并代价低。

LowCardinality 还有一个与"GROUP BY"的协同效应——**GROUP BY LowCardinality 列比 GROUP BY String 快得多**。因为 GROUP BY 的 HashTable Key 是字典索引（UInt8/UInt16，1-2 字节）而非字符串（几十字节），HashTable 的内存占用小、哈希计算快。对"按低基数列聚合"的查询（譬如 `GROUP BY region`），LowCardinality 让聚合性能提升几倍。**"LowCardinality 是"低基数列"的全能优化——存储省、查询快、聚合快**，应该作为低基数列的默认选择。

LowCardinality 的使用有一个与"字符串 vs 枚举"的对比值得了解——传统数据库对低基数列用"枚举类型"（ENUM），ClickHouse 用 LowCardinality。两者的区别是——ENUM 是"建表时固定值列表"（新增值要 ALTER TABLE），LowCardinality 是"运行时动态字典"（新增值自动加到字典）。**LowCardinality 比 ENUM 更灵活**——不需要预定义值列表，新增值自动处理。代价是"字典有一点点运行时开销"（查字典比直接比较 ENUM 稍慢），但通常可忽略。生产中对低基数列，**优先用 LowCardinality 而非 String**——这是 ClickHouse 特有的优化，MySQL/PostgreSQL 用户迁移时容易忽略。

---

## 第 2 章 查询优化——SQL 写法与物化视图

### 2.1 避免全表扫描的三个手段

**手段一：确保 WHERE 条件匹配主键前缀**

见 1.1 节，主键最左前缀匹配是最根本的查询优化。如果 WHERE 条件不匹配主键前缀，稀疏索引无法剪枝，查询退化为全表扫——这是 ClickHouse 查询性能最常见的问题根源。

**手段二：分区裁剪**

对于分区表，WHERE 条件应包含分区列：

```sql
-- ✅ 分区裁剪有效（只扫描 2024-01 和 2024-02 两个分区）
SELECT * FROM events WHERE date BETWEEN '2024-01-01' AND '2024-02-28';

-- ❌ 分区裁剪无效（函数包裹分区列，ClickHouse 无法识别范围）
SELECT * FROM events WHERE toYYYYMM(date) = 202401;

-- ✅ 改写为（使用 date 列直接过滤，ClickHouse 自动推导分区范围）
SELECT * FROM events WHERE date >= '2024-01-01' AND date < '2024-02-01';
```

**分区裁剪失效的最常见原因是"函数包裹分区列"**——`toYYYYMM(date) = 202401` 让 ClickHouse 无法从 `toYYYYMM(date) = 202401` 反推出 `date` 的范围（虽然人能推出来，但优化器不一定能）。解法是改写为"对分区列的直接比较"——`date >= '2024-01-01' AND date < '2024-02-01'`，ClickHouse 能直接识别 `date` 的范围并裁剪分区。**"不要在 WHERE 条件里对分区列用函数"是 ClickHouse SQL 写法的一条铁律**。

这条铁律的常见违反场景包括——`toYYYYMM(date) = 202401`（函数包裹分区列）、`toDate(timestamp) = '2024-01-01'`（如果分区键是 `toYYYYMM(timestamp)`，`toDate` 不匹配分区键函数）、`date + INTERVAL 1 DAY > '2024-01-01'`（算术运算包裹分区列）。这些写法都让 ClickHouse 无法识别分区范围，退化为全分区扫。**改写原则是"把分区列单独放在比较操作的一侧，另一侧是常量或简单表达式"**——`date >= '2024-01-01' AND date < '2024-02-01'` 让 `date` 直接参与比较，ClickHouse 能识别范围。

**手段三：避免 SELECT \***

`SELECT *` 会读取所有列，即使查询只需要 2-3 列。列存储的列剪枝必须在 SQL 层显式指定需要的列才能生效：

```sql
-- ❌ 读取所有列（100 列全部解压）
SELECT * FROM events WHERE user_id = 12345;

-- ✅ 只读取需要的列
SELECT date, amount, event_type FROM events WHERE user_id = 12345;
```

`SELECT *` 的危害在宽表上尤其严重——100 列的宽表，`SELECT *` 读 100 列的 `.bin` 文件，IO 量是"只读 3 列"的 33 倍。**`SELECT *` 是列存储最大的敌人**——第 04 篇讲查询反模式时已经强调过，这里从表设计角度再次提醒。

`SELECT *` 还有一个隐含的代价——**网络传输量**。ClickHouse 查询结果要通过网络传给客户端，`SELECT *` 传所有列的数据，网络带宽占用大。譬如 100 列的宽表，`SELECT *` 传 100 列的数据，网络传输量是"只传 3 列"的 33 倍。对"查询结果大 + 网络带宽紧"的场景（譬如跨机房查询），`SELECT *` 可能让网络成为瓶颈。**"只 SELECT 需要的列"不仅省 IO 和 CPU，还省网络**——这是列存储在"查询结果传输"上的额外优势。

### 2.2 物化视图预聚合——以空间换时间

对于高频执行的聚合查询，可以用物化视图（Materialized View）将聚合结果预计算并持续更新：

```sql
-- 实时事件表（原始数据）
CREATE TABLE events (
    timestamp DateTime,
    date      Date ALIAS toDate(timestamp),
    region    String,
    event_type String,
    amount    Float64
) ENGINE = MergeTree() ORDER BY (timestamp, region);

-- 物化视图：实时维护按 (date, region) 的聚合统计
CREATE MATERIALIZED VIEW events_daily_mv
ENGINE = AggregatingMergeTree()
ORDER BY (date, region)
AS SELECT
    toDate(timestamp) AS date,
    region,
    sumState(amount)       AS total_amount,
    countState()           AS event_count,
    uniqState(user_id)     AS unique_users
FROM events
GROUP BY date, region;

-- 查询聚合结果（毫秒级响应，不需要扫描原始数据）
SELECT
    date,
    region,
    sumMerge(total_amount)  AS total_amount,
    countMerge(event_count) AS event_count,
    uniqMerge(unique_users) AS unique_users
FROM events_daily_mv
GROUP BY date, region;
```

物化视图的工作原理——每次向 `events` 表写入数据时，ClickHouse 自动触发物化视图的更新查询，将新数据的聚合结果写入 `events_daily_mv`（使用 AggregatingMergeTree 合并聚合状态）。查询时直接读预聚合结果，数据量极小——10 亿行原始数据按 `(date, region)` 聚合后可能只有几千行，查询从"扫 10 亿行"变成"扫几千行"，性能提升几个数量级。

**物化视图的核心是"聚合状态"而非"聚合值"**——`sumState(amount)` 存的是 `sum` 的可合并状态（而非最终的 `sum` 值），`sumMerge` 把多个状态合并成最终值。这让物化视图能"增量更新"——新写入的数据生成新的聚合状态，与已有状态合并，不需要重新扫全表。第 02 篇讲 AggregatingMergeTree 时已经展开过这个机制，这里看到它在物化视图中的实际应用。

**物化视图的适用场景**：
- 高频聚合查询（每分钟执行数百次的 Grafana Dashboard 查询）
- 聚合维度固定（`GROUP BY date, region` 这样的固定分组）
- 原始数据量大但聚合后数据量小（百亿行聚合后只有几千行）

**物化视图的局限**：
- 存储开销（额外存储聚合结果，通常远小于原始数据）
- 维度固定（物化视图只预计算了特定的 GROUP BY 组合，其他维度的聚合仍需查原始数据）
- 延迟（物化视图的更新是同步的，可能略微增加写入延迟）

物化视图的"维度固定"局限有一个缓解方案——**多物化视图**。如果业务有多个常用聚合维度（譬如按 `(date, region)` 和按 `(date, event_type)`），为每个维度建一个物化视图。譬如 `events_daily_region_mv` 和 `events_daily_type_mv`——查询按 region 聚合走前者，按 event_type 走后者。**多物化视图是"用存储换查询灵活性"**——每个物化视图存一份聚合结果，存储成本上升，但多种聚合查询都能命中预聚合。

物化视图的"存储成本"值得量化一下——譬如原始数据 1TB，按 `(date, region)` 聚合后的物化视图可能只有 10MB（几千行），按 `(date, event_type)` 聚合后也只有 20MB。**物化视图的存储成本通常远小于原始数据**——因为聚合把"亿行"压缩到"几千行"。建 10 个物化视图的存储成本可能只有原始数据的 0.1%——几乎可以忽略。**多物化视图的"存储换查询"是高性价比的**——存储成本微乎其微，查询性能提升几个数量级。

物化视图的写入开销也值得了解——**物化视图的更新是"增量"的，不是"全量重算"**。每次 INSERT 触发物化视图时，只对新写入的数据做聚合，把聚合状态合并到物化视图的已有状态里——不需要扫原始表。譬如 INSERT 100 万行，物化视图触发时只对这 100 万行做 GROUP BY，结果合并到 `events_daily_mv`——开销与"100 万行的聚合"相当，远小于"全表聚合"。**"物化视图的写入开销与"INSERT 批次大小"成正比，与"原始表大小"无关**——这让物化视图即使在大表上也能持续维护，不会越来越慢。

物化视图的写入开销有一个与"多物化视图"相关的累加效应——**每个物化视图都独立触发，N 个物化视图的写入开销是 N 倍**。譬如 1 个物化视图，INSERT 100 万行触发 1 次聚合（开销 X）；10 个物化视图，INSERT 100 万行触发 10 次聚合（总开销 10X）。如果物化视图太多，写入延迟可能显著上升。**"物化视图数量"与"写入延迟"是线性关系**——生产中通常控制在 5-10 个物化视图以内，超过后写入延迟可能不可接受。

物化视图还有一个进阶用法——**级联物化视图**。譬如先建一个按 `(date, region, event_type)` 的细粒度物化视图，再在它上面建一个按 `(date, region)` 的粗粒度物化视图。查询按 `(date, region)` 聚合时走粗粒度视图（更快），查询按 `(date, region, event_type)` 聚合时走细粒度视图。**级联物化视图让"不同粒度的聚合"都能命中预聚合**——从细到粗，层层预计算。

### 2.3 Prewhere 的手动调优

第 04 篇详细讲了 Prewhere 的原理——"先读过滤列生成位图，再按位图读其他列"。这里从调优角度补充——**什么时候需要手动指定 PREWHERE**。

自动 Prewhere 在大多数情况下工作良好，但有几个场景需要手动：

**优化器选错 Prewhere 列**——`WHERE user_id = 12345 AND date >= '2024-01-01'`，优化器可能选 `date` 做 Prewhere（因为 `date` 是小类型），但 `user_id` 的选择性更高（1% vs 10%）。手动 `PREWHERE user_id = 12345 WHERE date >= '2024-01-01'` 强制 `user_id` 做 Prewhere，解压量减少更多。

**多列 Prewhere**——`WHERE user_id = 12345 AND status = 'active'`，两个条件都高选择性。手动 `PREWHERE user_id = 12345 AND status = 'active'` 让两个条件一起生成位图，联合选择性更高（譬如 0.1%），比自动选一个条件做 Prewhere 更优。

**Prewhere 列的压缩影响**——如果 Prewhere 列用了高压缩比编码（譬如 Delta + ZSTD），解压代价高，Prewhere 的"先解压过滤列"这一步本身就消耗 CPU。此时可能需要关闭 Prewhere（`SET optimize_move_to_prewhere = 0`）或换一个低压缩比的 Prewhere 列。

### 2.4 合理使用子查询与 IN

ClickHouse 对 `IN` 子查询的优化不如 Trino 完善，大集合的 `IN` 查询可能导致性能问题：

```sql
-- ❌ 大集合 IN（可能导致内存溢出或慢查询）
SELECT * FROM events WHERE user_id IN (SELECT user_id FROM users WHERE segment = 'VIP');
-- 如果 VIP 用户有数百万，这个 IN 集合会很大

-- ✅ 改为 JOIN（更可控，可以利用索引）
SELECT e.*
FROM events e
JOIN (SELECT user_id FROM users WHERE segment = 'VIP') vip
ON e.user_id = vip.user_id;

-- ✅ 或使用 GLOBAL IN（分布式场景）
SELECT * FROM events WHERE user_id GLOBAL IN (SELECT user_id FROM users WHERE segment = 'VIP');
```

`IN` 子查询的执行方式是——把子查询结果物化到内存 Set，主查询每行检查是否在 Set 里。如果子查询结果集大（百万级），Set 的内存占用大，且检查成本高。改用 JOIN 后，ClickHouse 可以用 HashTable 做 JOIN（效率与 Set 类似但内存控制更好），或用索引剪枝（如果 JOIN Key 是主键前缀）。**"大集合用 JOIN，小集合用 IN"是 ClickHouse SQL 的经验法则**——几千行的子查询用 IN 没问题，百万行的子查询改 JOIN。

`IN` 子查询还有一个与"分布式"相关的坑——**普通 `IN` 在分布式表上可能结果错误**。如果 `events` 是 Distributed 表，`WHERE user_id IN (SELECT user_id FROM users)` 会在每个 Shard 的本地表上执行 `IN`——但 `users` 子查询只在 Initiator 执行，结果没有广播到各 Shard。各 Shard 的本地表看不到完整的 `users` 子查询结果，`IN` 判断不完整——可能漏掉应该匹配的行。**分布式表要用 `GLOBAL IN`**——Initiator 把子查询结果广播到所有 Shard，各 Shard 用完整的子查询结果做 `IN` 判断。这与第 05 篇讲的 `GLOBAL JOIN` 是同一个思路——"分布式场景下，子查询结果要广播"。

### 2.5 字典 JOIN 替代维表 JOIN

第 05 篇讲过字典 JOIN 的原理——维表加载到每个节点的内存字典，查询时 `dictGet` 本地查字典，无网络开销。这里从调优角度补充——**什么时候用字典 JOIN 而非 GLOBAL JOIN**。

| 维度 | GLOBAL JOIN | 字典 JOIN |
| :--- | :--- | :--- |
| **网络开销** | 小表广播到所有 Shard | 无（字典在各节点本地） |
| **内存开销** | Shard 数 × 小表 | 每节点一份字典 |
| **数据新鲜度** | 每次查询读最新小表 | 定时刷新（有延迟） |
| **适用场景** | 小表更新频繁 | 维表更新不频繁 |
| **大小限制** | 小表 < 几百 MB | 字典总内存 < 节点内存 20% |

这张表的洞察是——**"维表更新不频繁"用字典 JOIN，"维表更新频繁"用 GLOBAL JOIN**。譬如 `users` 维表每天更新一次，用字典 JOIN（每天刷新一次字典）；实时活动表每分钟更新，用 GLOBAL JOIN（每次查询读最新）。**字典 JOIN 是 ClickHouse 处理"大表 JOIN 小维表"的最佳方案**——比 GLOBAL JOIN 更快（无网络），比预分片更灵活（维表不分片）。

字典 JOIN 的使用有一个工程细节——**字典的预热**。字典在第一次查询时才加载到内存（懒加载），第一次查询会慢（等字典加载）。生产中通常在部署后手动触发字典预热——`SELECT dictGet('users', 'user_name', 1)` 触发加载，或用 `SYSTEM RELOAD DICTIONARY` 预加载。**"字典预热是"消除冷启动延迟"的实践**——让第一次查询不因为字典加载而慢。

字典还有一个与"写入"相关的细节——**字典的源表写入延迟会传递到字典**。如果字典源表（譬如 `users` 维表）的写入有延迟（譬如 Kafka 消费延迟），字典的刷新也会延迟——字典里的数据落后于源表。对"维表实时性要求高"的场景，要么缩短字典刷新间隔（`LIFETIME(MIN 60 MAX 60)`，每分钟刷新），要么不用字典改用 GLOBAL JOIN（每次查询读最新维表）。**字典的"定时刷新"是"用实时性换性能"的取舍**——刷新间隔越短，实时性越好但刷新开销越大；间隔越长，性能越好但实时性越差。

### 第 3 章 资源管理——多用户并发的隔离

### 3.1 Settings Profile 与 Quota

ClickHouse 通过 **Settings Profile** 和 **Quota** 实现多用户的资源隔离：

```sql
-- 创建 Settings Profile（SQL 方式，ClickHouse 22.x+）
CREATE SETTINGS PROFILE analytics_profile SETTINGS
    max_threads = 8,                    -- 查询最多使用 8 个线程
    max_memory_usage = 10737418240,     -- 最多使用 10GB 内存
    max_execution_time = 60,            -- 查询超时 60 秒
    max_result_rows = 1000000,          -- 结果行数限制
    max_rows_to_read = 10000000000;     -- 最多读取 100 亿行（防止笛卡尔积等误操作）

-- 创建 Quota（限制时间窗口内的累计资源消耗）
CREATE QUOTA analytics_quota
    FOR INTERVAL 1 HOUR MAX queries = 100, read_rows = 100000000000
    TO analytics_role;

-- 为用户分配 Profile
ALTER USER analyst SETTINGS PROFILE 'analytics_profile';
```

**Settings Profile 限制"单个查询"的资源**——`max_threads` 限制单查询的线程数，`max_memory_usage` 限制单查询的内存。**Quota 限制"时间窗口内的累计"资源**——每小时最多 100 个查询、读 1000 亿行。两者配合使用——Profile 防"单查询失控"，Quota 防"用户刷量"。

Profile 和 Quota 的配合可以用一个场景来理解——分析师 A 写了一个低效的笛卡尔积 JOIN，单查询要跑 100GB 内存——Profile 的 `max_memory_usage = 10GB` 让这个查询在 10GB 时被 kill，保护集群不 OOM。分析师 B 每分钟发 1000 个小查询（脚本刷量）——Quota 的 `MAX queries = 100 per hour` 让 B 在 100 个查询后被限流，保护集群不被刷爆。**"Profile 是"单点保护"，Quota 是"总量保护"**——两者覆盖不同的风险场景。

Quota 的配置有一个与"公平性"相关的考量——**Quota 按"用户"还是按"角色"限制**。按用户限制（`TO user1`）精确但管理成本高（每个用户一个 Quota）；按角色限制（`TO analytics_role`）粗放但管理简单（同角色的用户共享 Quota）。生产中通常按角色限制——把"分析师"都归到 `analytics_role`，共享一个 Quota（每小时 100 查询）。如果某个分析师刷量，整个角色的 Quota 袗尽——其他分析师也受影响。这促使同角色用户"互相监督"，而非"各自为政"。**按角色限制 Quota 是"用群体压力防刷量"的管理策略**——比按用户限制更省管理成本，且有"群体自律"效应。

Quota 还有一个与"超额行为"相关的设计——**超额后的处理方式**。默认是"拒绝"（超额后查询报错），也可以设为"延迟"（超额后查询排队等待，不报错）。`FOR INTERVAL 1 HOUR MAX queries = 100, queries = 100 OVER LIMIT = DELAY` 表示"100 查询内正常，超过后延迟"。**"拒绝"适合"硬限制"场景（防止刷量），"延迟"适合"软限制"场景（允许突发但削峰）**——与第 03 篇讲的 `parts_to_delay_insert` / `parts_to_throw_insert` 的"软保护/硬保护"思路一致。

### 3.2 Workload Groups——更精细的资源隔离

Settings Profile 是"软隔离"——它限制单查询的资源上限，但不保证"每个 Profile 的总资源份额"。如果 10 个 `analytics` 查询同时跑，每个 8 线程，总共 80 线程——仍然过载。**Workload Groups**（ClickHouse 23.x+ 引入）提供"硬隔离"——每个 Workload Group 有独立的资源池（CPU、内存配额），查询在组内竞争资源，不跨组抢占。

```sql
-- 创建 Workload Group
CREATE WORKLOAD GROUP analytics_wg
    SETTINGS max_concurrent_queries = 4,  -- 最多 4 个并发查询
             max_threads = 32,            -- 组内最多 32 线程
             max_memory_usage = 32212254720;  -- 组内最多 32GB 内存

-- 创建 Workload Classifier（按用户/角色路由到 Workload Group）
CREATE WORKLOAD CLASSIFIER analytics_classifier
    TO analytics_wg
    FOR user1, user2;
```

Workload Groups 的设计逻辑是——**"按业务类型分组，每组有独立资源池"**。譬如 `analytics_wg`（分析师，4 并发 32 线程）、`reports_wg`（报表，8 并发 16 线程）、`dashboard_wg`（看板，16 并发 8 线程）。分析师的大查询不会挤占看板的小查询资源——它们在不同的资源池里。**Workload Groups 是"多租户 ClickHouse"的关键能力**——让一个集群同时服务多个业务，互不干扰。

Workload Groups 与 Settings Profile 的区别值得再强调——Profile 限制"单查询"的资源，Workload Groups 限制"一组查询"的总资源。Profile 是"每个查询最多 8 线程"，Workload Groups 是"这组查询总共最多 32 线程"。前者防"单查询失控"，后者防"组内查询累积过载"。**生产中两者配合使用——Profile 设单查询上限，Workload Groups 设组内总上限**。譬如 `analytics_wg` 组内最多 32 线程，组内每个查询最多 8 线程——最多 4 个查询并发（32 / 8 = 4），第 5 个查询排队。

### 3.3 内存溢出（OOM）的防范

ClickHouse 的聚合操作（GROUP BY、DISTINCT）在内存中构建 HashTable，当 GROUP BY 的基数极高时，HashTable 可能耗尽内存，导致进程被 OOM Killer 终止。

**两阶段磁盘溢写（Spilling to Disk）**：

```sql
-- 启用内存不足时溢写到磁盘（牺牲性能，防止 OOM）
SET max_bytes_before_external_group_by = 3221225472;  -- 超过 3GB 时溢写
SET max_bytes_before_external_sort = 3221225472;      -- 排序超过 3GB 时溢写
```

启用溢写后，当 HashTable 大小超过阈值，ClickHouse 将中间数据写入临时文件，通过多次 Merge 完成聚合，类似 MapReduce 的 Shuffle 机制。性能下降显著（可能慢 5-10 倍），但不会 OOM。

**溢写是"兜底机制"——正常不触发，触发就意味着查询已经慢了**。生产中应该通过"预聚合"或"限制 GROUP BY 基数"来避免溢写，而不是依赖溢写兜底。如果溢写频繁触发，说明查询设计有问题——应该用物化视图预聚合降低基数，或用 `uniqHLL12` 等近似函数替代精确 `uniq`。

### 3.4 CPU 资源管理

```sql
-- 全局限制同时执行的查询数（防止高并发时 CPU 过载）
max_concurrent_queries = 100  -- config.xml 中配置

-- 每个查询的线程数上限（用户级别控制）
SET max_threads = 4;

-- 查询优先级（数值越小优先级越高，0 = 最高优先级）
SET priority = 1;  -- 低优先级查询（Grafana Dashboard 等低重要度查询）
```

`max_threads` 的设置有一个与"查询延迟"和"集群吞吐"的权衡——单查询 `max_threads` 大，查询延迟低（多线程并行），但并发查询少（线程被一个查询占满）；`max_threads` 小，并发查询多，但单查询延迟高。**"大查询用大 max_threads，小查询用小 max_threads"是 Settings Profile 分组的核心逻辑**——第 04 篇讲过这个思路，这里看到它在资源管理层的落地。

`max_threads` 的设置还有一个与"内存"的关联——**GROUP BY 的内存占用与 `max_threads` 正相关**。每个线程维护独立的局部 HashTable，总内存 = `max_threads` × 单线程 HashTable 大小。譬如 `max_threads = 32`，单线程 HashTable 1GB，总内存 32GB——可能 OOM。调小 `max_threads` 到 8，总内存降到 8GB——安全但查询慢。**"大 GROUP BY 用小 max_threads，小 GROUP BY 用大 max_threads"是内存安全的调优策略**——GROUP BY 基数高时减线程省内存，GROUP BY 基数低时加线程加速。

这个策略的极致情况是——**`max_threads = 1` 的单线程聚合**。当 GROUP BY 基数极高（譬如 `GROUP BY user_id`，亿级用户），即使 `max_threads = 8` 也可能 OOM（8 × 1GB HashTable = 8GB）。此时设 `max_threads = 1`，HashTable 只有一份（1GB），内存安全。代价是查询慢（单线程），但至少不 OOM。**"宁可慢也不 OOM"是高基数 GROUP BY 的兜底策略**——用 `max_threads = 1` + 溢写保证查询能完成，虽然慢。

除了 `max_threads` 和溢写，高基数 GROUP BY 还有一个缓解方案——**近似聚合函数**。`uniqHLL12(user_id)` 用 HyperLogLog 估算去重数，内存占用固定（12KB），与 `user_id` 的基数无关；`uniqExact(user_id)` 精确去重，内存占用与基数成正比。对"只要近似值"的场景（譬如 DAU 统计，误差 1% 可接受），用 `uniqHLL12` 替代 `uniqExact`——内存从 GB 级降到 KB 级，查询从"可能 OOM"变成"永远安全"。**"近似聚合是"用精度换内存"的策略**——对"精确度要求不高"的分析场景（大多数统计场景），近似聚合是高基数聚合的最佳方案。

ClickHouse 提供多种近似聚合函数，各有适用场景：

| 函数 | 用途 | 误差 | 内存 |
| :--- | :--- | :--- | :--- |
| `uniqHLL12` | 近似去重（HLL 12 位） | ~0.5-1% | 固定 12KB |
| `uniqHLL10` | 近似去重（HLL 10 位，更省内存） | ~1-2% | 固定 8KB |
| `uniqExact` | 精确去重 | 0 | 与基数成正比 |
| `quantileTDigest` | 近似分位数 | ~0.5% | 固定 ~100KB |
| `quantileExact` | 精确分位数 | 0 | 与数据量成正比 |
| `sum` | 精确求和 | 0 | 固定（与数据量无关） |

这张表的洞察是——**"去重"和"分位数"有近似版本（HLL、TDigest），"求和"没有近似版本**（求和本身内存固定，不需要近似）。对"DAU 统计"（去重 user_id）和"P99 延迟统计"（分位数），用近似版本能让内存从 GB 级降到 KB 级。**"精确还是近似"是 ClickHouse 聚合调优的一个选择点**——大多数分析场景接受 1% 误差，近似聚合是高基数聚合的首选。

近似聚合的"1% 误差"在业务上的可接受性值得多说一句——**大多数分析场景的"决策阈值"远大于 1%**。譬如"DAU 是 100 万还是 99 万"——两个数字对业务决策（譬如评估活动效果）没有本质区别。但"订单金额总和是 100 万还是 99 万"——对财务报表有区别（要对账）。**"统计场景用近似，财务场景用精确"是业务层的判断**——不是技术上"能不能用近似"，而是业务上"允不允许误差"。ClickHouse 的定位是"分析"而非"交易"——大多数场景接受近似，这也是它提供丰富近似函数的原因。

### 3.5 磁盘 IO 资源管理

除了 CPU 和内存，磁盘 IO 也是 ClickHouse 的关键资源——第 03 篇讲过 Merge 和查询竞争磁盘带宽。ClickHouse 提供几个 IO 限制参数：

**`background_merges_mutations_disk_read_write_max_bytes`**——后台 Merge/Mutation 的 IO 限速。默认 0（不限速），生产中建议设为磁盘吞吐的 30-50%——譬如 SSD 500MB/s，设为 200MB/s，留 300MB/s 给查询。**这个限速是"Merge 不饿死查询"的保障**——不限速时 Merge 可能占满磁盘带宽，查询 IO 排队。

**`max_download_replicas`**——副本同步的下载限速。副本同步要从源 Replica 下载 Part，占网络和磁盘带宽。限速让同步不挤占查询和 Merge。

**`min_bytes_to_use_direct_io`**——直接 IO 阈值。读取大于这个阈值的数据时用直接 IO（绕过 OS Page Cache），避免大查询把 Page Cache 冲掉。默认 0（不用直接 IO），生产中可以设为 1GB——大于 1GB 的读取走直接 IO，不污染 Page Cache。**直接 IO 是"大查询不冲刷缓存"的保护**——让小查询的缓存命中率不受大查询影响。

这些 IO 参数的调优逻辑是——**"ClickHouse 的 IO 资源要分给三类消费者：查询、Merge、副本同步"**。三者竞争磁盘带宽，需要通过限速让它们"和平共处"——查询优先（不限速），Merge 次之（限速 30-50%），副本同步最后（限速更低）。

这个优先级排序的逻辑是——**查询是"用户感知"的操作，慢了用户会投诉**；Merge 是"后台"操作，慢了只是 Part 堆积（用户不直接感知）；副本同步也是"后台"操作，慢了只是副本落后（用户不直接感知）。**"用户感知的优先，后台的让步"是 IO 资源分配的原则**——让用户感知的操作拿到更多 IO，后台操作用剩余 IO 慢慢做。这个原则与第 03 篇讲的"Merge 不饿死查询"一脉相承——都是"查询优先"的资源分配哲学。

---

## 第 4 章 诊断工具速查

### 4.1 常用诊断查询

```sql
-- 1. 查看当前正在运行的查询
SELECT query_id, user, elapsed, read_rows, memory_usage, query
FROM system.processes ORDER BY elapsed DESC;

-- 终止某个慢查询
KILL QUERY WHERE query_id = 'xxx-yyy-zzz';

-- 2. 查看 Part 状态（too many parts 排查）
SELECT table, partition, count() AS parts_count, sum(rows) AS total_rows
FROM system.parts WHERE active = 1
GROUP BY table, partition ORDER BY parts_count DESC LIMIT 20;

-- 3. 查看后台 Merge 进度
SELECT table, elapsed, progress, num_parts, result_part_name
FROM system.merges ORDER BY elapsed DESC;

-- 4. 查看 Mutation 进度
SELECT table, mutation_id, command, is_done, parts_to_do
FROM system.mutations WHERE is_done = 0;

-- 5. 分析查询日志中的慢查询
SELECT query, query_duration_ms, read_rows, read_bytes
FROM system.query_log
WHERE type = 'QueryFinish' AND query_duration_ms > 5000
ORDER BY query_duration_ms DESC LIMIT 20
SETTINGS log_queries = 1;
```

这五个查询覆盖了 ClickHouse 运维的五大场景——当前慢查询、Part 堆积、Merge 进度、Mutation 进度、历史慢查询。**它们应该集成到 ClickHouse 的运维看板**（Grafana + Prometheus 采集 `system.*` 表），让运维工程师能一眼看到集群健康状况。

除了这五个常用查询，还有几个诊断查询值得了解：

**查看磁盘使用**——`SELECT name, free_space, total_space FROM system.disks`——监控磁盘使用率，超过 70% 时 Merge 可能因空间不足失败（第 03 篇讲过）。

**查看副本同步状态**——`SELECT database, table, replica_name, replication_lag FROM system.replicas WHERE replication_lag > 0`——监控副本落后，落后的 Replica 要从负载均衡摘除（第 05 篇讲过）。

**查看分布式表的健康**——`SELECT database, table, is_leader, is_readonly, is_session_expired FROM system.replicas`——`is_readonly = 1` 的 Replica 不能写入（通常是 ZooKeeper 连接断了），需要排查 Keeper 健康。

这些查询共同构成了 ClickHouse 的"运维仪表盘"——Part、Merge、Mutation、磁盘、副本、分布式表，每个维度都有对应的 `system.*` 表查询。**成熟的 ClickHouse 运维团队会把这些查询固化成 Grafana 看板**，配合告警规则，让集群问题在"用户感知之前"被发现。

### 4.2 EXPLAIN 三件套

第 04 篇详细讲了 `EXPLAIN`、`EXPLAIN PIPELINE`、`EXPLAIN ESTIMATE` 的用途——这里从调优角度总结使用流程：

**第一步：`EXPLAIN ESTIMATE`**——看预计读取的 `rows`/`marks`/`bytes`。如果接近全表，说明索引剪枝没生效，回到第 1 步检查主键和 WHERE 条件。

**第二步：`EXPLAIN`**——看逻辑执行计划，确认 Prewhere 是否触发、谓词是否下推、JOIN 顺序是否合理。

**第三步：`EXPLAIN PIPELINE`**——看物理 Pipeline，确认并行度是否充分（`MergeTreeReader` 的实例数是否匹配 `max_threads`）。

**三步按"从粗到细"的顺序**——ESTIMATE 看数据量（最粗），EXPLAIN 看算子树（中等），PIPELINE 看 Processor（最细）。大多数调优在第一步就能定位问题（索引没剪枝），后两步用于深度调优（Prewhere、并行度）。

EXPLAIN 三件套的使用有一个经验法则——**"先 ESTIMATE，再决定要不要 EXPLAIN"**。如果 ESTIMATE 显示 `marks` 接近全表，说明索引没剪枝——此时不需要 EXPLAIN，直接回去检查主键和 WHERE 条件。如果 ESTIMATE 显示 `marks` 已经很小（剪枝生效）但查询仍然慢，才需要 EXPLAIN 看是不是 Prewhere 没触发或 JOIN 顺序不对。**ESTIMATE 是"快速判断"工具，EXPLAIN 是"深度诊断"工具**——先用 ESTIMATE 判断"问题在哪一层"，再决定是否需要 EXPLAIN 深入。

---

## 第 5 章 小结与下一篇导读

### 5.1 调优的优先级

ClickHouse 的性能调优是一个系统工程，按"收益从大到小"排序：

1. **表设计先行**——主键选择决定了 80% 的查询性能上限，主键设计错误无法通过后期优化弥补
2. **物化视图是高频查询的最佳武器**——用写入时的增量计算换取查询时的极低延迟
3. **跳数索引补充主键的盲区**——针对高频的非主键列点查创建 Bloom Filter 索引
4. **压缩编码与 LowCardinality**——IO 和内存的隐形优化，对宽表和高基数场景收益明显
5. **资源隔离防止鲸鱼查询**——通过 Settings Profile / Workload Groups 限制单查询和单用户的资源

**调优时从第 1 步开始，前一步解决了再考虑后一步**——不要一上来就调资源参数，那通常是收益最小的优化点。主键设计错了，调多少 `max_threads` 都补不回来。

这个"主键设计决定 80% 性能"的说法有一个工程上的含义——**主键设计是"建表时的一次性决策"，影响后续所有查询**。如果主键设计错了（譬如把高基数列放第一），所有按时间范围查询都全表扫——后期用 Prewhere、跳数索引、物化视图都只能部分缓解，无法根治。**主键设计是 ClickHouse 表设计的"地基"——地基打错了，上面的优化都是"修补"而非"根治"**。这也是为什么第 02 篇和本文都反复强调主键设计——它是 ClickHouse 性能的"第一性原理"。

### 5.2 下一篇导读

下一篇 [[07 ClickHouse 运维——集群部署、监控与版本升级]] 将从"调优"转向"运维"——集群的部署模式（单机、集群、多机房）、监控体系的搭建（`system.*` 表 + Prometheus + Grafana）、备份与恢复（`FREEZE PARTITION` + `clickhouse-backup`）、版本升级的滚动策略与兼容性检查。理解了运维，才能保证 ClickHouse 集群在生产中"部署得了、监控得到、备份得了、升级得了"——这是 ClickHouse 从"能用"到"好用"的最后一公里。

---

## 参考资料

1. ClickHouse 表设计最佳实践. https://clickhouse.com/docs/best-practices
2. ClickHouse 跳数索引文档. https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#table_engine-mergetree-data_skipping-indexes
3. ClickHouse 压缩编码文档. https://clickhouse.com/docs/sql-reference/statements/create/table#column-compression-codecs
4. ClickHouse LowCardinality 文档. https://clickhouse.com/docs/sql-reference/data-types/lowcardinality
5. ClickHouse 物化视图文档. https://clickhouse.com/docs/sql-reference/statements/create/view
6. ClickHouse Workload Groups 文档. https://clickhouse.com/docs/operations/workload-scheduling

---

> [!note] 思考题
> 1. 主键设计是 ClickHouse 表设计最重要的决策。如果一张事件表有 `date`、`user_id`、`event_type`、`region` 四个常用过滤列，你会怎么设计主键顺序？考虑查询模式——"按时间范围 + 用户"、"按时间范围 + 地区"、"按事件类型 + 时间范围"三种查询都很常见。如果三种查询都很频繁，一个主键能同时优化三种吗？如果不能，有什么替代方案（提示：多物化视图、跳数索引）？
> 2. 物化视图用"写入时增量计算"换"查询时极低延迟"——但物化视图的维度是固定的。如果业务的聚合维度经常变化（譬如今天按 region 聚合，明天按 event_type 聚合），物化视图帮不上忙。这种场景下，你会怎么优化？用预聚合的宽表（所有维度都预聚合）？用 OLAP Cube（譬如 Apache Kylin）？还是接受原始数据查询的延迟？
> 3. LowCardinality 对低基数列（如 country、status）用字典编码——存储减少 10 倍，查询加速。但 LowCardinality 的字典是"全局"的（整个 Part 共享一个字典）还是"Granule 级"的？如果字典是全局的，写入新值时字典如何更新？如果字典是 Granule 级的，每个 Granule 都存一个字典，存储开销是否上升？查阅 ClickHouse 文档，搞清楚 LowCardinality 的字典粒度。
