---
title: "LSM-Tree 存储引擎——为什么用 LSM 而非 CoW 文件覆盖"
date: 2026-03-02
tags: [Paimon, LSM-Tree, MemTable, SST, Compaction, 存储引擎, RocksDB, 写放大, 读放大]
aliases: ["Paimon LSM-Tree", "LSM-Tree存储引擎", "MemTable", "SST文件", "Paimon Compaction"]
---

**摘要：**

[[Apache Paimon]] 的存储引擎核心是 **[[LSM-Tree]]（Log-Structured Merge-Tree）**。这个数据结构在数据库领域已有 40 年历史，是 [[LevelDB]]、[[RocksDB]]、[[Apache HBase]]、[[Apache Cassandra]] 共同的存储基础。然而，Paimon 是第一个将 LSM-Tree 系统性地应用于数据湖（对象存储 + 大规模分析查询）场景的开源项目。本文深入剖析 Paimon 的 LSM-Tree 实现：MemTable 如何在内存中积累高频写入、SST 文件如何在 S3/HDFS 上分层组织、Compaction 的 Full Compaction 与 Universal Compaction 两种策略如何在写放大与读放大之间取舍，以及这套机制相较于 Hudi CoW/MoR 和 Iceberg 的文件模型在高频流式写入场景下的根本优势。

---

## 第 1 章 传统数据湖"不可变文件"模型的本质限制

### 1.1 不可变文件（Immutable File）模型

[[Apache Hudi]] 和 [[Apache Iceberg]] 都建立在"不可变文件"模型之上——一个 Parquet 文件一旦写出，其内容永远不变。对该文件中记录的更新或删除，有两种方式处理：

**方式一：Copy-on-Write（写时复制）**

读取整个旧文件，将更新合并进去，写出一个全新的文件版本，旧文件在新 Snapshot 中被"替换"（标记为 Removed）。

```
CoW 更新代价示例：
  一个 128MB 的 Parquet 文件，包含 100 万条记录
  更新其中 1000 条记录（0.1%）

  → 读取 128MB
  → 处理 100 万条记录，找出并替换其中 1000 条
  → 写出 128MB 的新文件
  → 总 IO：256MB（读 128MB + 写 128MB）
  → 写放大系数：128x（写了 128MB，实际只有 100KB 的数据发生变化）
```

**方式二：Merge-on-Read（读时合并）**

Hudi MoR：不覆盖旧文件，而是追加一个日志文件（.log），记录本次更新的增量。读取时，将旧文件与日志文件合并，得到最新数据。

```
MoR 更新代价：
  写入：追加一个日志文件（只含 1000 条更新记录，约 100KB）← 写入极快
  读取：读旧 Parquet 文件（128MB）+ 读日志文件（100KB）+ 内存合并
  → 写代价低，读代价高
```

无论 CoW 还是 MoR，都有一个共同特点：**每次"发布"（Commit）都需要在文件系统上创建/替换文件**，这个操作与 Checkpoint 周期绑定，决定了数据可见性的频率上限。

### 1.2 LSM-Tree 的核心洞察：分离写入路径与可见性路径

LSM-Tree 的根本创新是：**将"数据写入"与"数据发布（可见性提交）"解耦**。

```
传统不可变文件模型的绑定：
  每次写入一批数据 → 生成 Parquet 文件 → Commit（发布）
  三步必须同步完成，Commit 后数据才可见

LSM-Tree 的解耦：
  Step 1（高频）：写入 MemTable（内存，微秒级）
  Step 2（中频）：MemTable 满 → 刷写到 Level 0 SST（顺序写，秒级）
  Step 3（低频）：发布快照 Snapshot（JSON 元数据，毫秒级）← 独立于 Step 1/2
  Step 4（后台）：Compaction（合并多层 SST，与读写异步进行）

数据何时可见：Step 3 之后（快照发布）
数据何时到达磁盘：Step 2 之后（SST 刷写）
数据何时持久化：Flink Checkpoint 时（Step 1 中 MemTable 的 State 持久化）
```

这个解耦使得快照发布（Step 3）可以以极低代价高频触发（每 10 秒一次），而不需要等待每次 Checkpoint（5-10 分钟一次）。

---

## 第 2 章 Paimon 的 LSM-Tree 实现详解

### 2.1 MemTable：写入的第一站

**MemTable（内存表）** 是 Paimon 写入路径中的第一个组件，接受所有传入的写入请求并在内存中维护一个有序的键值映射。

**MemTable 的数据结构**：

Paimon 的 MemTable 使用 **SortBuffer**（外部排序缓冲区）实现，因为 Flink 环境中内存是严格管理的（[[Flink MemoryManager]]），Paimon 不能无限使用 JVM 堆：

```java
// Paimon MemTable 的核心逻辑（简化）
// 实际实现在 org.apache.paimon.memory.MemoryPoolFactory

class SortBufferMemTable {
    private final SortBuffer sortBuffer;    // 外部排序缓冲区（支持溢写到磁盘）
    private final Comparator<InternalRow> keyComparator;  // 按主键排序
    private final MergeFunction mergeFunction;  // 相同主键的合并策略

    // 写入一条记录
    public boolean put(InternalRow row) {
        if (sortBuffer.isFull()) {
            return false;   // MemTable 满了，触发刷写
        }
        sortBuffer.write(row);  // 写入排序缓冲区
        return true;
    }

    // 刷写：将 MemTable 排序并生成 SST 文件
    public DataFileMeta flush(FileWriter writer) {
        // 按主键排序
        sortBuffer.sort();
        // 迭代有序记录，应用 MergeFunction（去重、聚合等）
        MergeIterator mergeIterator = new MergeIterator(sortBuffer.iterator(), mergeFunction);
        // 写出 ORC/Parquet 文件（Level 0 SST）
        return writer.write(mergeIterator);
    }
}
```

**MemTable 刷写触发条件**：

```
触发刷写（MemTable → Level 0 SST）的条件：
  1. MemTable 容量满（配置项 write-buffer-size，默认 256MB）
  2. Flink Checkpoint 触发（强制刷写，保证一致性）
  3. 手动触发（如关闭写入 Job 时）

每次刷写生成一个 Level 0 SST 文件：
  文件大小 ≈ MemTable 大小（256MB 压缩后通常 30-80MB）
  文件内数据按主键有序
  文件名包含层级信息：data-{uuid}-level-0.orc
```

### 2.2 SST 文件的分层结构

**SST（Sorted String Table）文件** 是 LSM-Tree 的磁盘存储单元。每个 SST 文件内部按主键有序，是一个不可变的文件（写出后不再修改）。

Paimon 将 SST 文件组织成多个层级（Level），层级越高，文件越大、越稳定、越有序：

```
Level 0（新鲜层）：
  来源：MemTable 直接刷写，每次刷写产生一个 L0 文件
  特性：文件内有序，但 L0 各文件之间可能有 key 范围重叠
         （不同 L0 文件可能包含同一主键的不同版本）
  典型大小：30-80MB
  典型文件数：0-10 个（积累到一定数量触发 Compaction）

Level 1（合并层）：
  来源：L0 文件经 Compaction 合并后的结果
  特性：文件之间无 key 范围重叠（同一 key 只在一个 L1 文件中）
  典型大小：128MB-256MB
  典型文件数：10-100 个

Level 2（稳定层）：
  来源：L1 文件经 Compaction 合并后的结果
  特性：同 L1，进一步去除旧版本，文件更大更稳定
  典型大小：256MB-1GB
  典型文件数：10-100 个

Level N（历史层，仅部分 Compaction 策略使用）：
  来源：逐层合并
  特性：越高层数据越"冷"，文件越大，Compaction 频率越低
```

**文件布局示例**（某个分区的 bucket-0 目录）：

```
partition=2024-01-01/bucket-0/
  data-abc-0001_level-0.orc   ← L0，刚从 MemTable 刷写，含最新数据
  data-abc-0002_level-0.orc   ← L0，与上一个有 key 重叠
  data-def-0003_level-1.orc   ← L1，无重叠，稳定
  data-def-0004_level-1.orc   ← L1，无重叠
  data-ghi-0005_level-2.orc   ← L2，大文件，最稳定
```

### 2.3 读取时的多层合并

当查询需要读取某条记录时，Paimon 需要对多个层级的 SST 文件进行**归并读取**：

```
查询：SELECT * FROM events WHERE primary_key = 'key-12345'

归并读取步骤：
  1. 在 Level 0 的所有文件中，查找 key-12345（L0 文件间可能有重叠）
     → 可能在 L0 文件 1 和 L0 文件 2 中都有该 key 的版本
     → 取 sequence_number 更大的那个（更新的版本）

  2. 在 Level 1 中，二分查找包含 key-12345 的文件
     → L1 各文件 key 范围无重叠，最多在一个文件中

  3. 在 Level 2 中，同样二分查找

  4. 归并所有找到的版本，按 sequence_number 排序，取最新版本
     （或应用 MergeFunction，如部分更新 Partial Update）
```

这就是 LSM-Tree 的"读放大"——读一条记录可能需要访问多个文件。后台 Compaction 通过合并层级来降低读放大（高层文件中一个 key 只有一个版本）。

---

## 第 3 章 Compaction 策略

### 3.1 为什么 Compaction 是关键

Compaction 是 LSM-Tree 中最复杂、最关键的后台任务，它负责：

1. **合并 L0 小文件**：消除 L0 文件间的 key 重叠，提升读性能
2. **去除旧版本**：同一主键有多个版本时，保留最新版本，释放存储空间
3. **层级提升**：将文件从低层移到高层，长期维持 LSM 树的层级结构均衡

如果 Compaction 速度跟不上写入速度，L0 文件会不断积累，导致读取时需要扫描大量 L0 文件（读放大严重）——这是 LSM-Tree 系统在高写入压力下的典型退化问题。

### 3.2 Full Compaction（全量合并）

**Full Compaction** 是 Paimon 的第一种 Compaction 策略，也是适合批处理场景的标准策略：

```
Full Compaction 触发条件：
  所有 Level 0 文件数量超过阈值（num-levels=5，默认最多 5 层）
  或手动触发（批处理作业完成后）

Full Compaction 执行过程：
  1. 将所有层的所有 SST 文件读取并合并（大型归并排序）
  2. 对相同主键的多个版本，应用 MergeFunction 保留最终结果
  3. 写出一组新的高层 SST 文件（如直接写到 Level 2 或 Level N）
  4. 旧文件标记为废弃（在下一个 Snapshot 后可删除）

Full Compaction 的特点：
  ✅ 读放大降至最低（合并后每个 key 只有一个版本）
  ✅ Changelog 生成能力最完整（可以输出 before → after 的变更日志）
  ❌ Compaction 代价最高（读写所有数据，类似全表重写）
  ❌ 不适合高频触发（会长期占用大量 IO）

适合场景：
  批处理 ETL 作业结束后的一次性合并
  需要生成完整 Changelog 的 CDC 场景
```

### 3.3 Universal Compaction（通用合并）

**Universal Compaction** 是 Paimon 借鉴自 [[RocksDB]] 的 Universal Compaction 策略，适合流式写入场景：

```
Universal Compaction 核心逻辑：
  将所有文件按写入时间排序，视为一个有序序列
  当最老的几个文件的总大小超过最新文件大小的 ratio 倍时，触发合并

  具体触发条件（默认参数）：
    max-size-amplification-percent = 200
    → 当所有文件总大小超过最新文件大小的 200% 时触发全量合并
    size-ratio = 1
    → 文件大小比例超过 1:1 时触发相邻文件合并

  合并策略：
    总是合并文件序列的一个前缀段（最老的 N 个文件）
    而不是全部文件（不像 Full Compaction）
    → 增量合并，代价比 Full Compaction 低

Universal Compaction 的特点：
  ✅ 合并代价均摊，不会出现长时间的大型 Compaction 阻塞
  ✅ 适合持续流式写入（合并与写入并行进行）
  ✅ 空间放大系数可控（通过 max-size-amplification-percent 配置）
  ❌ 读放大比 Full Compaction 略高（多层文件可能并存）
  ❌ Changelog 生成能力有限（不能保证输出完整的 before/after）

适合场景：
  高频流式 Upsert（Flink 实时写入）
  不需要完整 Changelog 的聚合 / 去重场景
```

### 3.4 Compaction 的配置实践

```sql
-- 创建 Paimon 主键表，配置 Compaction 策略（Flink SQL）
CREATE TABLE analytics.events (
    event_id  STRING,
    user_id   BIGINT,
    event_ts  TIMESTAMP(3),
    region    STRING,
    status    STRING,
    PRIMARY KEY (event_id) NOT ENFORCED   -- 主键（决定 Upsert 合并的 key）
) PARTITIONED BY (DATE_FORMAT(event_ts, 'yyyy-MM-dd'))
WITH (
    'bucket'                   = '16',          -- 每个分区分 16 个 bucket（并行度）
    'write-buffer-size'        = '256 mb',      -- MemTable 大小
    'num-levels'               = '5',           -- LSM-Tree 最大层数
    'compaction.max-size-amplification-percent' = '200',  -- Universal Compaction 触发比
    'file.format'              = 'orc',         -- 数据文件格式
    'target-file-size'         = '128 mb',      -- 目标 SST 文件大小
    'changelog-producer'       = 'full-compaction',  -- Changelog 生成策略（见下篇）
    'snapshot.num-retained.max' = '100'         -- 保留最近 100 个 Snapshot
);
```

---

## 第 4 章 对象存储上的 LSM-Tree 挑战与解法

### 4.1 S3 不支持随机写的问题

[[LSM-Tree]] 在传统数据库（[[RocksDB]]、[[LevelDB]]）中运行在本地磁盘上，支持随机读写（即使顺序写为主，也有 seek 操作）。但 Paimon 运行在 S3/OSS 等对象存储上，这些系统有根本性的限制：

```
对象存储的约束：
  ✅ 支持顺序写（PUT 一个完整对象）
  ✅ 支持顺序读（GET 一个对象）
  ✅ 支持随机读（Range GET，即读对象的一部分）
  ❌ 不支持随机写（不能修改已有对象的一部分）
  ❌ 不支持原子 rename（S3 的 rename 实际是 copy + delete，非原子）

这对 LSM-Tree 的影响：
  MemTable 刷写 → 生成新的 SST 文件 → OK（新对象 PUT）
  Compaction 合并 → 生成新的 SST 文件 → OK（新对象 PUT）
  删除旧 SST 文件 → OK（DELETE 请求）
  原子替换（rename）→ 不支持！需要通过 Snapshot 元数据间接实现
```

**Paimon 的解法**：完全不依赖文件系统的 rename 原子性。所有的"原子提交"通过写一个 **Snapshot 元数据文件**（JSON）来实现——新 Snapshot 文件包含新的文件列表，旧文件在下一次 GC 时删除。这与 Iceberg 的 Snapshot 机制思想相同。

### 4.2 S3 小文件的 GET 延迟问题

S3 上每次 GET 请求有约 10-50ms 的延迟开销（TCP 连接 + TLS 握手 + S3 内部路由）。LSM-Tree 的 Level 0 存在大量小文件（每次 MemTable 刷写约产生 30-80MB 的文件），如果查询时需要扫描多个 L0 文件，每个文件一次 GET 请求，延迟叠加会很显著。

**Paimon 的缓解措施**：

```
1. File Index（文件级索引）：
   Paimon 在每个 SST 文件中嵌入 Bloom Filter，
   用于快速判断某个 key 是否在该文件中，
   避免打开不包含目标 key 的文件

2. Bucket 分区（Bucket Partitioning）：
   每个 Partition 下细分为若干 Bucket（按主键哈希路由）
   同一 Bucket 内的 SST 文件 key 范围聚合，
   查询某个 key 时只需访问对应 Bucket 的文件，
   大幅减少需要打开的文件数

3. 积极的 Compaction 策略：
   在写入低峰期加速 Compaction，减少 L0 文件积累
   配合 sort-spill-threshold 控制内存溢写频率
```

---

## 第 5 章 与 Hudi MoR 的深度对比

Hudi MoR 和 Paimon LSM-Tree 都是"写入快，读取合并"的思路，但实现层面有根本差异：

### 5.1 日志文件 vs SST 文件

```
Hudi MoR 的增量日志（.log 文件）：
  格式：Avro（无结构约束，存原始增量事件）
  内容：以 Block 形式存储的增量记录（无主键排序）
  读取：顺序扫描 .log 文件，内存中合并（哈希 Merge）
  特点：写入极快（顺序追加），读取开销与日志量成正比

Paimon LSM-Tree 的 SST 文件：
  格式：ORC/Parquet（列式存储）
  内容：按主键有序排列的记录（每个 SST 内部有序）
  读取：多路归并排序（利用有序性，避免全量哈希）
  特点：读取效率优于日志文件（有序 + 二分查找），但写入需要排序
```

### 5.2 Compaction 策略的差异

```
Hudi MoR Compaction：
  触发条件：日志文件数量超过阈值（delta.commits.max = 5）
  执行方式：读取基础 Parquet + 所有日志文件 → 合并 → 写出新 Parquet
  结果：一个 FileGroup 内的多个版本合并为一个新 Parquet
  耗时：高（需要重写整个 FileGroup 的数据，通常 128MB 级别）

Paimon Universal Compaction：
  触发条件：文件大小比例（动态触发，不依赖 commit 次数）
  执行方式：合并相邻 Level 的部分文件（增量合并，非全量）
  结果：多个小 SST 合并为一个大 SST，层级提升
  耗时：低（只合并被选中的 SST，不需要全量重写）
```

| 对比项 | Hudi MoR | Paimon LSM-Tree |
|-------|---------|----------------|
| **写入数据结构** | 无结构日志（Avro Block）| 有序 SST 文件（ORC/Parquet）|
| **写入内存开销** | 低（直接追加）| 中（MemTable 排序）|
| **读取合并方式** | 哈希合并（日志 Scan）| 归并排序（有序 SST）|
| **Compaction 代价** | 高（全量 FileGroup 重写）| 中（增量 SST 合并）|
| **数据新鲜度** | 分钟级（Checkpoint 约束）| 秒级（Snapshot 独立发布）|
| **读放大上限** | 低（Compaction 后一个文件）| 中（多层 SST 合并）|
| **Changelog 支持** | 有限（需要 Input Format 层解析）| 原生支持（Full Compaction 模式）|

---

## 小结

Paimon 的 LSM-Tree 存储引擎不是简单地把 RocksDB 搬到数据湖上，而是针对对象存储（S3/HDFS）的特点和 Flink 流计算的需求做了专门的适配：

- **MemTable** 使用 Flink 管理的外部排序缓冲，安全地在有限内存下运行
- **SST 文件** 以 ORC/Parquet 列式格式存储，兼顾压缩效率和 OLAP 查询性能
- **Compaction** 提供 Full Compaction（高质量，低频）和 Universal Compaction（低代价，高频）两种策略
- **Snapshot 元数据**代替 rename 原子性，在对象存储上实现 ACID 提交

下一篇 [[03 主键表与追加表——两种写入模型的设计逻辑]] 将聚焦 Paimon 的两种核心表类型：Primary Key Table（主键表，基于 LSM-Tree 的 Upsert）和 Append-Only Table（追加表，适合日志/事件流场景），深入分析两者的写入路径差异和适用场景。
