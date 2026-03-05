---
title: "03 数据写入与 Part 合并"
date: 2026-03-05
tags: [ClickHouse, MergeTree, Part, Merge, Mutation, TTL, 写入流程, 后台合并]
aliases: []
---

# 03 数据写入与 Part 合并

## 摘要

ClickHouse 的写入模型是"每次 INSERT 生成一个新 Part，后台异步合并小 Part 为大 Part"。这个看似简单的设计背后，隐藏着精巧的合并调度策略、Mutation 的异步重写机制、以及 TTL 数据过期的自动清理。本文深入剖析从一次 INSERT 到数据可查询的完整链路，重点讲解 Part 的生命周期、Merge 的触发逻辑与代价分析，以及生产中最常见的"too many parts"问题的根因和解决方案。

---

## 第 1 章 一次 INSERT 发生了什么

### 1.1 写入流程概览

ClickHouse 的写入流程与传统数据库截然不同——没有 WAL（预写日志）的概念（分布式 Replicated 表有 ZooKeeper Log，但本地 MergeTree 不依赖 WAL），数据直接写入磁盘上的 Part 目录。

```
INSERT INTO events VALUES (...), (...), ...
         ↓
1. 解析 SQL，验证数据类型和约束
         ↓
2. 在内存中按 ORDER BY 键排序这批数据
         ↓
3. 构建列式数据块（每列独立）
         ↓
4. 按 PARTITION BY 键拆分为多个分区组
         ↓
5. 为每个分区组创建一个新 Part 目录（临时目录 tmp_xxx）
6. 将每列数据压缩后写入 *.bin 文件
7. 构建稀疏索引，写入 primary.idx
8. 构建 Mark 文件，写入 *.mrk3
9. 写入 checksums.txt 和 columns.txt
         ↓
10. 原子性地将 tmp_xxx 重命名为正式 Part 目录（rename 是原子的）
         ↓
11. 写入完成，数据立即可查询（Part 可见）
```

整个流程的关键点：

**第 2 步：内存排序**。这批数据在写入磁盘前，在内存中按主键排序。这是 MergeTree 保证每个 Part 内部有序的方式。如果这批数据量太大（超过 `max_insert_block_size`，默认 1048576 行），会被拆分成多个内存块分别处理，每个块生成一个 Part。

**第 10 步：原子 rename**。通过操作系统的 `rename` 系统调用（POSIX 保证在同一文件系统内 rename 是原子的），将临时 Part 目录重命名为正式名称。这保证了写入的原子性——要么整个 Part 对外可见，要么完全不可见。如果写入过程中宕机，临时目录会被丢弃，不会有部分写入的脏数据。

### 1.2 Part 的命名规则

Part 目录名格式：`{partition}_{min_block}_{max_block}_{level}`

- `partition`：分区值（如 `202401` 表示 2024 年 1 月的数据）
- `min_block`、`max_block`：这个 Part 的 block 编号范围（全局递增的计数器，每次写入分配新的 block 号）
- `level`：合并层级，新写入的 Part 为 level=0，每次被合并后 level 加 1

示例：`202401_1_1_0` 表示分区 202401、block 范围 [1,1]、level 0（刚写入的原始 Part）。  
合并后：`202401_1_50_1` 表示 block 范围 [1,50] 内的 50 个 Part 被合并成一个，level=1。

通过目录名可以直观判断一个表的数据整理状况：如果有大量 level=0 的 Part，说明 Merge 跟不上写入速度。

---

## 第 2 章 后台 Merge——ClickHouse 的"清洁工"

### 2.1 为什么需要后台 Merge

每次 INSERT 生成一个新 Part，如果写入频繁，磁盘上会积累大量小 Part。大量小 Part 带来两个问题：

**查询性能下降**：查询时 ClickHouse 需要扫描所有 Part，Part 越多，需要打开的文件越多，索引查找的轮次越多，查询延迟越高。理论上，同样的数据合并成 1 个大 Part 的查询性能远好于分散在 1000 个小 Part 中。

**文件描述符消耗**：每个 Part 包含多个文件（每列一个 `.bin` + 一个 `.mrk3`），1000 个 Part × 100 列 = 数十万个文件描述符。操作系统对单个进程的文件描述符数量有限制，超限会导致写入失败。

后台 Merge 持续地将小 Part 合并成大 Part，减少 Part 数量，优化查询性能。

### 2.2 Merge 的触发策略

ClickHouse 的 Merge 调度器运行在后台，持续选择合适的 Part 组合进行合并。选择的基本原则：

**同分区内合并**：不同分区的 Part 永远不会合并（因为它们的数据按分区键有序，合并会破坏分区边界）。

**按大小选择**：默认使用 `Simple` 合并策略——优先合并大小相近的 Part。防止一个巨大的 Part 被反复合并（代价太高），而小 Part 无法被合并（因为大 Part 太重导致队列一直被占用）。

**合并限制**：
- 单次合并的 Part 总大小上限：`max_bytes_to_merge_at_max_space_in_pool`（默认 150GB）
- 同时进行的 Merge 任务数：`background_pool_size`（默认 16，即最多 16 个并发合并任务）

### 2.3 Merge 的代价

Merge 操作的本质是：读取多个小 Part 的列数据，排序合并（归并排序），写入一个大 Part，然后删除旧的小 Part。

**IO 代价**：读 + 写 = 2 × 被合并 Part 的总大小。对于 150GB 的合并，需要读写 300GB 数据，在 500MB/s 的磁盘吞吐下需要约 10 分钟。

**合并对查询的影响**：Merge 是磁盘 IO 密集型操作，会与正常查询竞争磁盘带宽。ClickHouse 通过后台 IO 限速（`background_merges_mutations_disk_read_write_max_bytes`）避免 Merge 完全饿死查询 IO。

> [!warning] 生产避坑：too many parts 问题
> ClickHouse 对每个分区内的 Part 数量有保护上限（默认 300 个），当 Part 数量超过这个阈值时，新的 INSERT 会报错：`Too many parts (xxx). Merges are processing significantly slower than inserts.`
>
> 根因：写入速度（生成 Part 的速度）超过了 Merge 速度（合并 Part 的速度）。
>
> **解决方案**：
> 1. 短期：增加 `parts_to_delay_insert` 阈值（推迟而不是报错），或临时暂停写入
> 2. 长期：降低写入频率（增大批次大小），或增加 `background_pool_size` 提升 Merge 并发
> 3. 根本：每次 INSERT 的批次大小应 ≥ 10 万行，避免每秒多次小批写入
>
> 最佳实践：通过 Kafka + ClickHouse Kafka Engine 或批量导入工具，保证每次写入至少 10 万行。

---

## 第 3 章 Mutation——ClickHouse 的"重写式更新"

### 3.1 为什么更新/删除在 ClickHouse 中代价高

传统行存数据库的 UPDATE/DELETE 代价低：找到对应行，修改该行数据或标记删除，只需要修改少量数据页（B+Tree 的特点）。

ClickHouse 的 Part 是**不可变的**（immutable）——一旦写入，列数据文件不能被修改（因为压缩格式不支持随机修改）。因此，更新/删除必须通过**重写整个 Part**来实现——读出 Part 的所有数据，修改目标行，压缩后写入新 Part，删除旧 Part。

这个操作称为 **Mutation**，是异步执行的：

```sql
-- 删除某个用户的所有数据
ALTER TABLE events DELETE WHERE user_id = 12345;

-- 更新某些行的 amount 列
ALTER TABLE events UPDATE amount = amount * 1.1 WHERE date = '2024-01-01';

-- 查看 Mutation 状态
SELECT * FROM system.mutations WHERE table = 'events';
-- is_done = 1 表示完成，否则还在后台执行
```

### 3.2 Mutation 的执行流程

1. Mutation 命令写入 `system.mutations` 表，生成一个 Mutation 记录
2. 后台 Mutation 线程读取待处理的 Mutation 列表
3. 对每个 Part，读取所有列数据，应用 Mutation 条件（过滤 DELETE，或计算新值 UPDATE）
4. 将处理后的数据写入新 Part，名称中包含 Mutation ID 标记（如 `_0_100_0_mut_123`）
5. 所有 Part 处理完毕后，Mutation 标记为完成
6. 旧 Part 在后续的定期清理中被删除

**Mutation 的代价**：每次 Mutation 需要重写整个表（所有分区的所有 Part），即使只修改了一行。对于 TB 级别的大表，一次 `ALTER TABLE DELETE WHERE user_id = 12345` 可能需要数小时。

这就是为什么 ClickHouse 不适合高频更新的场景——每次更新都是"重写整张表"。

> [!info] 核心概念：Mutation 的轻量化改进
> ClickHouse 在较新版本（22.x+）引入了对 Mutation 的优化：如果 WHERE 条件覆盖整个分区（如按分区键过滤），可以通过 DROP PARTITION + INSERT 来替代 Mutation，性能好得多。
> 另一个优化是 `lightweight delete`（轻量级删除）：使用一个隐藏的删除标记列而不是立即重写 Part，类似 [[Doris]] 的 Delete Bitmap 机制，减少 Mutation 的即时开销。

---

## 第 4 章 TTL——数据自动过期与清理

### 4.1 行级 TTL

ClickHouse 的 TTL（Time to Live）功能支持自动过期删除数据，无需手动 DROP PARTITION 或执行 DELETE。

```sql
-- 创建表时定义 TTL（数据保留 30 天）
CREATE TABLE events (
    date     DateTime,
    user_id  UInt64,
    amount   Float64
) ENGINE = MergeTree()
ORDER BY (date, user_id)
TTL date + INTERVAL 30 DAY;  -- 数据在 date 的值 + 30 天后过期

-- 也可以对单独的列设置 TTL（过期后清零）
CREATE TABLE user_events (
    date      DateTime,
    user_id   UInt64,
    pii_email String TTL date + INTERVAL 90 DAY  -- 90 天后 email 自动清空
) ENGINE = MergeTree() ORDER BY (date, user_id);
```

TTL 的执行也是在后台 Merge 时完成的——当一个 Part 被合并时，ClickHouse 检查每行的 TTL 值，过期的行不会被写入新 Part（相当于在合并时自动过滤）。

### 4.2 列级 TTL 与数据分层（Storage Policy）

ClickHouse 支持将过期数据移动到"冷存储"而不是直接删除，实现**热冷数据分层**：

```sql
-- 定义存储策略（热存储 NVMe SSD，冷存储 HDD）
<storage_configuration>
    <disks>
        <hot>
            <path>/data/nvme/</path>
        </hot>
        <cold>
            <path>/data/hdd/</path>
        </cold>
    </disks>
    <policies>
        <hot_cold>
            <volumes>
                <hot_volume>
                    <disk>hot</disk>
                    <max_data_part_size_bytes>10737418240</max_data_part_size_bytes>  <!-- 10GB 内的 Part 留在热存储 -->
                </hot_volume>
                <cold_volume>
                    <disk>cold</disk>
                </cold_volume>
            </volumes>
            <move_factor>0.2</move_factor>  <!-- 热存储使用率超过 80% 时，将最旧的 Part 移到冷存储 -->
        </hot_cold>
    </policies>
</storage_configuration>

-- 建表时指定存储策略 + 数据移动 TTL
CREATE TABLE events (
    date DateTime,
    amount Float64
) ENGINE = MergeTree()
ORDER BY date
SETTINGS storage_policy = 'hot_cold'
TTL date + INTERVAL 7 DAY TO VOLUME 'cold_volume';  -- 7 天后移动到冷存储
```

这种"热 NVMe + 冷 HDD"的分层存储策略，可以在控制成本的同时保持近期数据的查询性能。

---

## 第 5 章 小结

ClickHouse 的写入和合并机制体现了"写入简单、合并优化"的设计哲学：

- **写入**：直接创建有序 Part，无 WAL 开销，写入延迟极低
- **合并**：后台持续合并小 Part，优化查询性能，用 IO 换查询速度
- **Mutation**：通过重写 Part 实现更新/删除，代价高但功能可用
- **TTL**：在合并时自动清理过期数据或迁移到冷存储，无需业务层管理

理解这套机制，能帮助工程师做出正确的使用决策：**每次 INSERT 要有足够的批次大小**（避免 too many parts）、**避免高频小批量更新**（Mutation 代价高）、**用 TTL + Storage Policy 管理数据生命周期**（替代手动 DROP PARTITION）。

---

**延伸阅读**：
- [[02 MergeTree 引擎家族——主键索引与数据排序]]
- [[06 ClickHouse 性能调优——表设计、查询优化与资源管理]]
