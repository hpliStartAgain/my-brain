---
title: "Changelog Producer——CDC 语义的流式生产与消费"
date: 2026-03-02
tags: [Paimon, Changelog, CDC, Full Compaction, Lookup Changelog, 流式消费, 变更日志, 流批一体]
aliases: ["Paimon Changelog", "CDC语义", "Changelog Producer", "Full Compaction Producer", "Lookup Changelog"]
---

**摘要：**

[[Apache Paimon]] 最核心的流处理能力之一，是让数据湖的存储层直接充当**可靠的 Changelog 来源**——下游 [[Apache Flink]] 任务可以像消费 [[Apache Kafka]] 一样消费 Paimon 表的变更事件（`+I`、`-U`、`+U`、`-D`），而不是像传统方案那样只能做全量快照查询。这个能力被称为 **Changelog Producer**。本文深入剖析 Changelog Producer 的两种核心实现模式：**Full Compaction Producer**（通过全量合并产生精确的 before/after 变更对）和 **Lookup Changelog Producer**（通过查找旧值产生实时 Changelog），解析两者在延迟、准确性、资源消耗和适用场景上的根本差异，以及 Paimon Changelog 如何与 Flink 的流式执行模型无缝结合，构建真正的流批一体实时数仓链路。

---

## 第 1 章 为什么数据湖需要 Changelog 能力

### 1.1 传统数据湖的"只读快照"困境

在 Paimon 出现之前，基于 [[Apache Hudi]] 或 [[Apache Iceberg]] 构建的数据湖，其下游消费模式通常是：

```
消费模式 1：全量快照读取（Snapshot Query）
  每隔一段时间（如每小时），读取整张表的最新快照
  → 数据量 = 全量（即使只有 0.1% 的数据发生了变化）
  → 计算成本高，延迟高

消费模式 2：增量文件读取（Hudi Incremental Query / Iceberg Incremental Read）
  读取"上次处理以来新增/修改的文件"
  → 数据量 = 变更文件（比全量小很多）
  → 但仍然是文件粒度，无法知道"每条记录的变化方向（增/改/删）"
```

这两种模式都缺少一个关键信息：**记录的变化方向（Change Type）**。

具体问题是：Hudi 增量查询返回的是"在时间范围内被最后修改的记录的当前状态"，但它不告诉你：这条记录是新增的？是从什么值更新到什么值？还是已经被删除了？

对于下游的 Flink 流计算任务，如果你需要基于"订单状态从 CREATED 变为 PAID"这个事件触发业务逻辑，增量快照文件是无法直接使用的——你还需要自己维护旧状态，与新文件做 JOIN 才能推断出变化方向。这显著增加了下游的开发复杂度和计算成本。

### 1.2 Kafka 的 CDC 流与数据湖的矛盾

另一种常见方案是：让 [[Apache Kafka]] 充当 Changelog 来源，Paimon/Hudi/Iceberg 只做"最终状态存储"：

```
架构：
  MySQL → Flink CDC → Kafka（Changelog 消息）→ 下游多路流消费
                                              ↓（同时写入）
                                    Paimon 数据湖（最终状态存储）

下游消费者：
  下游 A：从 Kafka 实时消费 Changelog，做实时指标计算
  下游 B：从 Paimon 读取最新状态，做批量报表
  下游 C：从 Kafka 消费 Changelog，更新另一张 Paimon 聚合表
```

这个架构的问题是：

```
问题 1：Kafka 的保留时间限制
  Kafka 默认保留 7 天的消息。超过 7 天的历史 Changelog 无法回溯。
  如果下游任务需要重跑历史数据（如修复 Bug），Kafka 的历史数据已经过期。
  而 Paimon 的历史 Snapshot 可以保留很久（只受存储成本限制）。

问题 2：Kafka 与数据湖的一致性
  写入 Kafka 和写入 Paimon 是两个独立操作。
  如果 Flink Job 在写 Paimon 成功、写 Kafka 失败时崩溃（或反之），
  会出现 Kafka 与 Paimon 数据不一致的问题。

问题 3：维护双写的复杂性
  需要同时维护 Kafka Topic 和 Paimon 表，数据双份存储，成本高。
```

Paimon 的 Changelog Producer 解决了这个矛盾：**让 Paimon 本身成为 Changelog 的来源，消除对独立 Kafka CDC 流的依赖**。

### 1.3 Changelog 的四种变化类型

Paimon 遵循 Flink 的 Changelog 语义，使用四种 RowKind 表示记录的变化：

```
+I（INSERT）：记录新增
  → {+I, order_id=1, status='CREATED', amount=99}
  → 表示 order_id=1 这条记录首次出现

-D（DELETE）：记录删除
  → {-D, order_id=1, status='CREATED', amount=99}
  → 表示 order_id=1 这条记录被删除（含删除前的值）

-U（UPDATE BEFORE）：更新前镜像
  → {-U, order_id=1, status='CREATED', amount=99}
  → 表示 order_id=1 的旧值（更新前）

+U（UPDATE AFTER）：更新后镜像
  → {+U, order_id=1, status='PAID', amount=99}
  → 表示 order_id=1 的新值（更新后）
  → -U 和 +U 必须成对出现（先 -U 后 +U）
```

当 Flink 的下游算子（如 `GROUP BY`、`JOIN`）消费这四种消息时，它们可以正确地维护聚合状态：

```
下游：统计各 status 的订单数量
  收到 {+I, status='CREATED'} → count['CREATED'] += 1
  收到 {-U, status='CREATED'} → count['CREATED'] -= 1  ← 撤回旧值
  收到 {+U, status='PAID'}    → count['PAID'] += 1      ← 加入新值
  → 最终：count['PAID']=1, count['CREATED']=0（正确！）

如果只有快照（没有 -U/+U 的撤回/更新）：
  看到一条 {status='CREATED'} 记录被修改为 {status='PAID'}
  但不知道应该撤回哪个旧聚合值
  → 下游算子无法正确维护状态
```

---

## 第 2 章 Full Compaction Changelog Producer

### 2.1 设计思路：用合并过程产生 Changelog

**Full Compaction Producer** 的核心思想是：LSM-Tree 在做 Full Compaction 时，必然会遍历同一主键的所有历史版本（读取多层 SST 文件）——这个遍历过程包含了每条记录"旧值 → 新值"的完整信息，可以在 Compaction 过程中顺便输出 Changelog。

```
Full Compaction 过程中的 Changelog 生成：

待合并的 SST 文件中，key=order_1 有以下版本（按时间排序）：
  Level 2（旧）：{order_id=1, status='CREATED', amount=99}     ← 旧版本
  Level 0（新）：{order_id=1, status='PAID',    amount=99}     ← 新版本（来自近期写入）

Full Compaction 合并时：
  读取旧版本：{order_id=1, status='CREATED', amount=99}
  读取新版本：{order_id=1, status='PAID',    amount=99}
  输出 Changelog：
    {-U, order_id=1, status='CREATED', amount=99}  ← UPDATE BEFORE
    {+U, order_id=1, status='PAID',    amount=99}  ← UPDATE AFTER
  最终 SST 只写入最新版本：{order_id=1, status='PAID', amount=99}
```

这些 Changelog 消息被写入专门的 **Changelog 文件**（存储在表目录下），下游 Flink 流任务可以读取这些文件消费变更事件。

### 2.2 Full Compaction Producer 的配置

```sql
CREATE TABLE dwd_orders (
    order_id   BIGINT,
    status     STRING,
    amount     DECIMAL(10,2),
    updated_at TIMESTAMP(3),
    PRIMARY KEY (order_id) NOT ENFORCED
) PARTITIONED BY (DATE_FORMAT(updated_at, 'yyyy-MM-dd'))
WITH (
    'bucket'              = '16',
    'changelog-producer'  = 'full-compaction',   -- 开启 Full Compaction Changelog
    'full-compaction.delta-commits' = '1',        -- 每隔多少次 Commit 触发一次 Full Compaction
    'changelog-producer.compaction-interval' = '2 min'  -- 最大等待 2 分钟触发 Compaction
);
```

### 2.3 Full Compaction Producer 的延迟分析

Full Compaction Producer 的**数据延迟 = 最近一次 Full Compaction 完成时间**，而不是写入时间。

```
时间线分析：
  t=0:   写入 {order_id=1, status='PAID'}（Flink 消费 Kafka）
  t=10s: MemTable Flush → Level 0 SST 生成，Snapshot 发布（数据可见，但 Changelog 未生成）
  t=2min: Full Compaction 触发（合并 L0 + L1 + L2 文件）
          → 遍历 order_id=1 的新旧版本
          → 生成 Changelog 文件
          → 发布新 Snapshot（含 Changelog 文件引用）
  t=2min: 下游 Flink 任务读取 Changelog：
          {-U, order_id=1, status='CREATED', ...}
          {+U, order_id=1, status='PAID', ...}

Changelog 延迟：约 2 分钟（Full Compaction 间隔）
```

这是 Full Compaction Producer 的主要缺点：Changelog 延迟与 Compaction 间隔绑定，通常在 1-5 分钟。

**然而**，Full Compaction Producer 有一个不可替代的优点：**精确性**。因为 Changelog 是在合并所有版本后生成的，即使同一条记录在短时间内被更新了 10 次，最终 Changelog 只输出 1 组 `(-U, +U)`（从第一个版本到最后一个版本），而不是 10 组中间状态的变更——这对下游聚合算子更友好（避免不必要的撤回重算）。

> [!info] Full Compaction 与数据可见延迟的区别
> 注意区分两种"延迟"的概念：
> - **数据可见延迟**：从写入到可被 Snapshot Query 查询的延迟 ≈ MemTable Flush 时间 ≈ 秒级
> - **Changelog 延迟**：从写入到 Changelog 事件被下游消费的延迟 ≈ Full Compaction 间隔 ≈ 分钟级
> Full Compaction Producer 的 Changelog 延迟高，但 Snapshot 查询延迟仍然是秒级。如果下游只需要读最新状态（Lookup Join），Snapshot 延迟才是关键。

---

## 第 3 章 Lookup Changelog Producer

### 3.1 设计思路：写入时查找旧值

**Lookup Changelog Producer** 采用完全不同的策略——在**写入时**（而不是 Compaction 时）立刻查找该 key 的旧值，并立刻生成 Changelog：

```
Lookup Changelog 的写入流程：
  收到新记录：{order_id=1, status='PAID', amount=99}

  Step 1：在 MemTable 中查找 order_id=1 的旧值
    → 如果 MemTable 中有旧值：{order_id=1, status='CREATED', amount=99}
      立即生成：
        {-U, order_id=1, status='CREATED', amount=99}
        {+U, order_id=1, status='PAID', amount=99}

  Step 2：如果 MemTable 中没有旧值，查找 SST 文件（Level 0, 1, 2...）
    → 找到旧值
      生成：{-U, 旧值} + {+U, 新值}
    → 未找到（新记录）
      生成：{+I, 新值}

  Step 3：将新值写入 MemTable（覆盖旧值）
```

**Lookup Changelog 的延迟**：

```
延迟分析：
  t=0:   写入 {order_id=1, status='PAID'}
  t=0:   Lookup 旧值（MemTable 命中或 SST 文件读取，约 1-10ms）
  t=0:   生成 Changelog，随 MemTable 数据一起缓冲
  t=10s: MemTable Flush，Changelog 文件写出
  t=10s: Snapshot 发布，下游可消费

Changelog 延迟：约 10-30 秒（与数据可见延迟相同）
```

Lookup Changelog Producer 的 Changelog 延迟与数据可见延迟几乎相同——几乎是实时的。

### 3.2 Lookup Changelog 的性能代价

Lookup Changelog 需要在**每次写入时**查找旧值，这个查找操作的代价是：

```
内存命中（MemTable 中有旧值）：
  → 哈希查找，O(1)，微秒级，代价极低

SST 文件查找（MemTable 中没有旧值）：
  → 需要读取 SST 文件（Bloom Filter 过滤 + 二分查找）
  → 对于冷数据（旧记录在 Level 2 大文件中）：
     一次 S3 GET 请求，约 10-50ms

写入吞吐量影响：
  如果大多数写入是对已有记录的更新（高更新率）：
    → MemTable 命中率高 → 代价低
  如果大多数写入是新记录（高插入率）：
    → 每条记录都需要 SST 查找（确认是否是新记录）→ 代价较高
    → 对于插入率 > 90% 的场景，Lookup 开销显著

对比 Full Compaction：
  Full Compaction 的查找发生在 Compaction 时（后台，不阻塞写入）
  Lookup 的查找发生在写入时（阻塞写入路径）
  → Lookup 对写入延迟有直接影响，Full Compaction 对写入延迟无影响
```

### 3.3 Lookup Changelog 的配置

```sql
CREATE TABLE dwd_orders (
    order_id   BIGINT,
    status     STRING,
    amount     DECIMAL(10,2),
    PRIMARY KEY (order_id) NOT ENFORCED
) WITH (
    'bucket'             = '16',
    'changelog-producer' = 'lookup',          -- 开启 Lookup Changelog
    'lookup.cache-rows'  = '100000',          -- 缓存最近 10 万条记录（减少 SST 查找）
    'lookup.cache-file-retention' = '1 h'    -- 缓存保留时间
);
```

**Lookup Cache** 是 Lookup Changelog Producer 的关键优化——将最近被查找过的旧值缓存在内存中，避免重复的 SST 文件读取：

```
Lookup Cache 的工作原理：
  首次查找 order_id=1 的旧值：
    → 读取 SST 文件（10ms）
    → 将结果存入 Cache：{order_id=1, status='CREATED', ...}

  1 秒后，order_id=1 的再次更新（如 status='SHIPPED'）：
    → Cache 命中：直接返回 {status='PAID', ...}（上次写入的新值）
    → 不需要读取 SST 文件
    → 代价：微秒级

Cache 大小（lookup.cache-rows = 100000）：
  缓存最近被更新的 10 万条记录
  适合：更新模式有局部性（热点记录频繁更新，冷数据很少更新）
  对于完全随机的更新模式（所有记录均匀更新），Cache 效果有限
```

---

## 第 4 章 下游 Flink 消费 Paimon Changelog

### 4.1 Flink 流读取 Paimon Changelog

开启 Changelog Producer 后，下游 Flink 任务可以通过 `scan-mode = latest-full` 或 `scan-mode = from-snapshot` 流式消费变更事件：

```sql
-- 下游 Flink SQL：实时消费 dwd_orders 的 Changelog 计算各状态订单数

-- Source：流式读取 Paimon dwd_orders（消费 Changelog）
CREATE TABLE orders_changelog_source (
    order_id   BIGINT,
    status     STRING,
    amount     DECIMAL(10,2)
) WITH (
    'connector'    = 'paimon',
    'path'         = 'hdfs:///data/dwd_orders',
    'scan.mode'    = 'latest-full',   -- 先读一次全量快照，再持续消费增量 Changelog
    'scan.snapshot-id' = '1'         -- 可指定起始 Snapshot（实现精确的一次语义）
);

-- Sink：目标聚合统计表
CREATE TABLE dws_order_status_count (
    status     STRING,
    order_count BIGINT,
    PRIMARY KEY (status) NOT ENFORCED
) WITH (
    'connector'          = 'paimon',
    'path'               = 'hdfs:///data/dws_order_status_count',
    'merge-engine'       = 'aggregation',
    'fields.order_count.aggregate-function' = 'sum'  -- Paimon AggregateMerge
);

-- 流式 SQL 逻辑：统计各状态订单数
INSERT INTO dws_order_status_count
SELECT status, COUNT(*) AS order_count
FROM orders_changelog_source
GROUP BY status;
-- GROUP BY 在 Flink 中是有状态的流式聚合，消费 Changelog 事件正确维护状态
```

### 4.2 流批一体的 Changelog 消费场景

Paimon 的 Changelog 使得"流批一体"从理论变为实际：

```
场景：构建实时数仓的 DWD → DWS 链路

Step 1：MySQL CDC → Flink CDC → Paimon DWD 层（主键表，Full Compaction Changelog）
  写入：Flink CDC 消费 MySQL Binlog，Upsert 写入 Paimon 主键表
  输出：每 1 分钟（Full Compaction 间隔）生成一批 Changelog 文件

Step 2：下游 Flink Job 流读 Paimon DWD 层的 Changelog → 写入 DWS 聚合层
  读取：Flink 流式消费 DWD 的 Changelog（-U/+U 事件）
  计算：GROUP BY 维度（如按 status、按 region）聚合
  写入：Upsert 到 Paimon DWS 主键表（AggregateMerge）

整体延迟：
  MySQL 变更 → DWS 查询可见 ≈ Full Compaction 间隔 ≈ 1-2 分钟
  （DWD 层数据写入 + DWD Changelog 生成 + DWS 消费和写入）
```

这个链路中，Paimon 完全替代了 Kafka 在变更事件传递上的角色——Paimon 既是存储（持久化、可查询），也是流（可订阅的 Changelog 来源）。

### 4.3 两种 Producer 的选型建议

| 维度 | Full Compaction Producer | Lookup Changelog Producer |
|-----|------------------------|--------------------------|
| **Changelog 延迟** | 分钟级（Compaction 间隔）| 秒级（几乎实时）|
| **Changelog 精确性** | 高（只输出最终变化，跳过中间状态）| 中（每次写入都产生 Changelog，含中间状态）|
| **写入吞吐影响** | 无（Changelog 在后台 Compaction 生成）| 有（每次写入需要 Lookup 旧值）|
| **适用写入模式** | 任意（特别适合批量写入）| 高更新率（热点记录频繁更新，Cache 命中率高）|
| **资源消耗** | Compaction 时 CPU/IO 高峰 | 写入时分散的 IO（Lookup 开销）|
| **适合场景** | CDC Upsert + 下游不需要每次中间变更 | 实时维表、需要低延迟 Changelog 的流水线 |

---

## 小结

Paimon 的 Changelog Producer 是它在流批一体架构中的核心差异化能力：

- **Full Compaction Producer**：以分钟级延迟换取 Changelog 精确性和写入零额外开销，适合对延迟不那么敏感但需要准确变更语义的 CDC 链路
- **Lookup Changelog Producer**：以写入时的 Lookup 开销换取秒级 Changelog 延迟，适合实时性要求高的场景，搭配 Lookup Cache 可以大幅降低 SST 读取频率

两者都让 Paimon 成为一个"既能存储、又能流式消费"的数据湖存储——这是 [[Apache Hudi]] 的 Incremental Query 和 [[Apache Iceberg]] 的 Incremental Read 都无法完全覆盖的能力。

下一篇 [[05 Lookup Join 与维表——Paimon 在流计算中的实时维表查询]] 将聚焦 Paimon 作为 Flink Lookup Join 的维表来源，解析 Paimon 如何通过 LSM-Tree 的局部查找能力和 Lookup Cache 机制，实现比 HBase/Redis 更低运维复杂度的实时维表查询。
