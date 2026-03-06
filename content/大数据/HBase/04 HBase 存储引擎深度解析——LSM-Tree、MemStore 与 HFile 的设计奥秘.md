---
title: "HBase 存储引擎深度解析——LSM-Tree、MemStore 与 HFile 的设计奥秘"
date: 2026-02-27
tags: [HBase, LSM-Tree, MemStore, HFile, 存储引擎, 跳表, BloomFilter, 写放大, 读放大]
aliases: [HBase存储引擎, LSM-Tree原理, HFile格式]
---

# HBase 存储引擎深度解析——LSM-Tree、MemStore 与 HFile 的设计奥秘

**摘要：**

HBase 的高吞吐写入能力，根源在于它选择了 [[LSM-Tree]]（Log-Structured Merge Tree）作为存储引擎，而不是关系型数据库普遍采用的 [[B+Tree]]。本文从磁盘 I/O 的物理本质出发，逐步推导出为什么"顺序写优于随机写"，以及 LSM-Tree 如何将所有写操作转化为顺序写从而获得极致的写入吞吐量——同时也揭示了这种选择所必须承担的代价：读放大（Read Amplification）、写放大（Write Amplification）和空间放大（Space Amplification）。在此基础上，深入拆解 HBase 中 LSM-Tree 的两个核心落地组件：**MemStore**（内存层，以 `ConcurrentSkipListMap` 实现的有序写缓冲）和 **HFile**（磁盘层，多级块索引 + BloomFilter 的有序不可变文件），帮助读者建立从理论到实现的完整认知链路。

---

## 第 1 章 磁盘 I/O 的物理本质：所有存储引擎设计的出发点

### 1.1 为什么存储引擎的设计要从磁盘 I/O 说起

软件工程中有一条不成文的规律：**系统的性能瓶颈决定了系统的设计方向**。对于一个数据存储系统，最核心的性能瓶颈从来不是 CPU、不是内存带宽，而是**磁盘 I/O**。

这是因为 CPU 的指令执行时间在纳秒（ns）量级，内存访问在 100 纳秒量级，而磁盘访问在毫秒（ms）量级。这意味着：一次磁盘 I/O 的时间，足够 CPU 执行数百万条指令。在以磁盘为持久化介质的存储系统中，I/O 次数是决定性能的第一因素，算法复杂度反而退居其次。

**机械硬盘（HDD）的 I/O 特性**

机械硬盘的工作原理是：磁头在旋转的磁盘盘片上寻找特定位置（磁道），然后读取数据。每次 I/O 由三部分延迟构成：
- **寻道时间（Seek Time）**：磁头移动到目标磁道，约 3~12ms
- **旋转延迟（Rotational Latency）**：等待盘片旋转到目标扇区，约 2~6ms（转速 7200RPM）
- **传输时间（Transfer Time）**：实际数据传输，对少量数据可忽略不计

一次随机 I/O 的总延迟约 **5~20ms**。如果每秒发起 1000 次随机 I/O，总延迟就是 5~20 秒——机器完全被 I/O 阻塞。

但如果是**顺序 I/O**（连续读写相邻的磁盘块），磁头无需频繁寻道，数据以盘片的旋转速度源源不断地传输，吞吐量可以达到 100~200 MB/s。

**量化对比**：
- 机械硬盘随机 I/O：约 100~200 次/秒（IOPS）
- 机械硬盘顺序 I/O：约 100~200 MB/s（即约 10 万~20 万次 4KB 块的顺序读写/秒）

顺序 I/O 的吞吐量是随机 I/O 的**1000 倍量级**。这个差距是所有存储引擎设计的核心矛盾所在。

**SSD 改变了什么，没有改变什么**

固态硬盘（SSD）消除了机械寻道时间，随机 I/O 性能大幅提升（可达数万 IOPS），但顺序 I/O 仍然远快于随机 I/O（通常快 10 倍以上）。更重要的是，SSD 有**写放大（Write Amplification）**问题：SSD 的最小擦除单位（Block，通常 512KB）远大于最小写入单位（Page，通常 4KB），随机写会触发"读-擦除-写"操作，显著降低写入性能和 SSD 寿命。

因此，即使在 SSD 时代，"尽量将随机写转化为顺序写"仍然是存储引擎设计的重要原则。

### 1.2 两种存储引擎的核心哲学对比

正是基于对磁盘 I/O 物理特性的深刻理解，历史上形成了两种截然不同的存储引擎设计哲学：

**B+Tree：读优化，随机写接受**

B+Tree 是传统关系型数据库（[[MySQL]] InnoDB、[[PostgreSQL]]）的存储引擎核心，也是绝大多数单机文件系统索引的基础数据结构。

B+Tree 的核心思想是：将数据组织成一棵高度为 3~4 层的平衡多叉树，每个节点对应磁盘上的一个 Page（通常 4KB 或 16KB）。查询时从根节点开始，每次 I/O 读取一个 Page，经过 3~4 次 I/O 就能定位到目标记录——这是 O(log N) 的查询复杂度，查询性能极优。

**写入**时，B+Tree 需要找到目标 Page（随机 I/O），在 Page 内部修改数据（可能触发 Page 分裂），再将脏 Page 写回磁盘（随机 I/O）。**B+Tree 的写操作本质上是随机 I/O**——因为更新的 Page 可能分布在磁盘的任意位置。

**LSM-Tree：写优化，读代价接受**

LSM-Tree 的核心思想是：**放弃原地修改（In-Place Update），将所有写操作转化为追加写（Append-Only Sequential Write）**。

它的基本模型是：
1. 新写入的数据首先进入内存中的有序数据结构（称为 MemTable 或 MemStore）
2. 内存结构达到阈值后，整体 **Flush 到磁盘，生成一个新的有序不可变文件**（称为 SSTable 或 HFile）
3. 磁盘上积累了若干文件后，后台线程定期将多个小文件**合并（Merge/Compaction）**成更大的文件，同时清除过期版本和墓碑标记

所有写操作（包括更新和删除）都是追加写，没有任何随机写——这是 LSM-Tree 写入吞吐量的根本来源。

但代价是：同一条数据可能存在于多个文件（新版本在小文件里，旧版本在大文件里），读取时需要合并多个文件的结果——这是**读放大**。

> [!note] 设计哲学
> B+Tree 和 LSM-Tree 代表了两种截然不同的工程取舍观：
> - **B+Tree**：为读优化，接受随机写的代价。适合读多写少、需要低读延迟的 OLTP 场景。
> - **LSM-Tree**：为写优化，接受读放大的代价。适合写多读少、对写入吞吐量要求极高的场景（日志、时序数据、行为追踪）。
> HBase 选择 LSM-Tree，是因为其核心场景（数亿条用户行为写入、海量日志存档）是典型的写密集型负载。

---

## 第 2 章 LSM-Tree 的完整理论模型

### 2.1 Patrick O'Neil 的原始论文：从理论到工程

LSM-Tree 由 Patrick O'Neil 等人在 1996 年的论文《The Log-Structured Merge-Tree (LSM-Tree)》中提出。论文的核心贡献是提出了一个精确的数学模型，证明在高写入负载场景下，LSM-Tree 能够显著降低磁盘 I/O 成本。

论文中，LSM-Tree 被定义为一个**多级结构（Multi-level Structure）**：

- **C0 层（内存层）**：最小的一层，存储在内存中，以某种有序数据结构（如跳表或红黑树）组织，支持高效插入和有序遍历
- **C1 层（磁盘一级层）**：比 C0 大得多，存储在磁盘上，以 B-Tree 或排序文件组织
- **C2、C3...层（更深的磁盘层）**：每层比上层大一个固定倍数（通常 10 倍）

数据的流动方向是单向的：从 C0 层 Flush 到 C1 层，再通过 Compaction 从 C1 层合并到 C2 层，以此类推。每次 Flush 和 Compaction 都是**顺序写**操作——这是 LSM-Tree 写入性能的保证。

### 2.2 三种放大问题：LSM-Tree 的工程代价

LSM-Tree 并非没有代价，任何存储引擎都需要在三种"放大"之间做权衡：

**写放大（Write Amplification）**

定义：用户写入 1 字节，实际写入磁盘的字节数之比。

LSM-Tree 的写放大来源于 **Compaction**：数据从 C0 层 Flush 到 C1 层，再从 C1 层 Compaction 到 C2 层……同一份数据在其生命周期内会被多次读取、重写。在极端情况下，一条数据可能被写入磁盘 10 次以上。

相比之下，B+Tree 的写放大主要来自 Page 的写时复制（Write-On-Copy）和日志（WAL），通常在 2~5 倍之间，远低于 LSM-Tree。

**读放大（Read Amplification）**

定义：查询 1 条记录，实际读取的磁盘数据量之比。

LSM-Tree 的读放大来源于**多层文件的合并读取**：同一条记录的不同版本可能分布在 MemStore、多个 L0 层文件、L1 层文件中，读取时需要检索所有可能包含目标记录的文件，然后合并。在极端情况下，一次读取可能需要访问数十个 HFile。

Bloom Filter（布隆过滤器）是缓解读放大的关键技术——它能以极低的内存代价（每个 key 约 10 位），以 99% 的概率确定某个 key 是否存在于某个 HFile 中，从而跳过不可能包含目标数据的文件。

**空间放大（Space Amplification）**

定义：存储 1 字节的用户数据，实际占用的磁盘空间之比。

LSM-Tree 的空间放大来源于**多版本共存和墓碑标记**：旧版本数据在 Compaction 清理之前始终占用磁盘空间。"删除"操作写入墓碑标记，原数据依然存在于旧的 HFile 中。在 Major Compaction 执行之前，删除的数据实际上并没有被物理删除。

三种放大的关系是此消彼长的：降低读放大（增加 Compaction 频率，减少文件层数）会增加写放大；降低写放大（减少 Compaction）会增加读放大；降低空间放大（频繁 Compaction）会增加写放大。LSM-Tree 的调优本质上是在三者之间寻找适合当前业务场景的平衡点。

### 2.3 HBase 中 LSM-Tree 的简化实现

HBase 的 LSM-Tree 实现相比原始论文有所简化，主要体现在层级结构上：

```
原始 LSM-Tree：C0(内存) → C1(磁盘L1) → C2(磁盘L2) → ...

HBase 的实现：
  MemStore（内存，对应C0）
    ↓ Flush
  L0 HFiles（若干个小文件，对应C0→C1的过渡层）
    ↓ Minor Compaction
  合并后的 HFiles（对应C1层，文件数量减少、单文件更大）
    ↓ Major Compaction（定期）
  单个大 HFile（包含该 Store 所有数据的最终合并结果）
```

HBase 没有严格的"层级"概念（不像 LevelDB/RocksDB 的 Leveled Compaction 有严格的 L0/L1/L2），而是通过 **Minor Compaction**（合并少数几个小文件）和 **Major Compaction**（合并一个 Store 内所有文件）来控制文件数量。这套机制在第 07 篇文章中详细讨论。

---

## 第 3 章 MemStore：内存中的有序写缓冲

### 3.1 MemStore 是什么，它在哪里

[[MemStore]] 是 LSM-Tree C0 层在 HBase 中的具体实现，是内存中的写缓冲区。

**定位精确**：每个列族（Column Family）对应一个 Store 对象，每个 Store 中有**且仅有一个** MemStore。这意味着：

- 一张有 3 个列族的表 × 100 个 Region × 每个 Store 一个 MemStore = 300 个 MemStore 对象
- 每个 MemStore 默认大小阈值为 128MB（由 `hbase.hregion.memstore.flush.size` 控制）
- 300 个 MemStore × 128MB = 38.4GB 的 MemStore 内存上限（这是列族不能太多的根本原因）

MemStore 的核心职责：
1. **接收写入请求**：所有写入该列族的 KeyValue 首先进入 MemStore
2. **维护有序性**：MemStore 中的数据按（RowKey, CF, CQ, Timestamp 倒序）排列，方便后续 Flush 生成有序的 HFile
3. **支持读取**：读取请求需要合并 MemStore 中的最新版本与 HFile 中的历史版本
4. **触发 Flush**：当 MemStore 大小超过阈值时，触发将内存数据写入 HFile

### 3.2 ConcurrentSkipListMap：为什么选跳表而不是红黑树

MemStore 的核心数据结构是 Java 标准库中的 `ConcurrentSkipListMap`。选择这个数据结构而非红黑树（`TreeMap`）或 B+Tree，是一个经过深思熟虑的工程决策。

**什么是跳表（Skip List）**

跳表是一种基于链表的有序数据结构，由 William Pugh 于 1990 年提出。它在普通有序链表的基础上，增加了多层"快速通道"（索引层），使得查找操作从 O(N) 降低到期望 O(log N)。

```
示意：一个跳表的结构

Level 3:  1 --------------------------------> 9
Level 2:  1 ------------> 4 -------------> 9
Level 1:  1 ------> 3 -> 4 ------> 7 ----> 9
Level 0:  1 -> 2 -> 3 -> 4 -> 5 -> 7 -> 8 -> 9

查找 7：从 Level3 开始，1→9（太大）→降到Level2，1→4→9（太大）→降到Level1，
       4→7（找到！）共经历 4 次比较，而普通链表需要 7 次。
```

跳表的期望时间复杂度：
- 查找：O(log N)
- 插入：O(log N)
- 删除：O(log N)
- 范围扫描：O(log N + K)，K 为结果数量

**为什么不用红黑树（TreeMap）**

红黑树是 Java `TreeMap` 的底层实现，同样能提供 O(log N) 的查找、插入、删除。但在 HBase 的并发写入场景下，红黑树有一个致命弱点：**旋转操作的并发控制极其复杂**。

红黑树在插入或删除后，为了维持平衡，需要执行"旋转（Rotation）"操作。旋转操作修改了树中多个节点的指针，必须在锁保护下进行。在高并发写入场景下，粗粒度的锁会成为严重的性能瓶颈。

要为红黑树实现无锁并发（Lock-Free）几乎不可能，即使是细粒度锁（Fine-Grained Lock）的实现也极为复杂，容易引入 Bug。

**跳表的并发友好性：ConcurrentSkipListMap 的优势**

跳表的节点插入可以被分解为多个**局部操作**：
1. 找到目标插入位置（只读遍历）
2. 修改底层链表的 next 指针（CAS 操作）
3. 概率性地提升索引层（独立的局部操作）

这些操作之间的依赖关系是局部的，不像红黑树旋转那样需要修改大范围节点。`ConcurrentSkipListMap` 利用 CAS（Compare-And-Swap）原子操作实现了真正的无锁并发——多个线程可以同时对跳表进行读写，而不需要全局锁。

**实测性能对比**（在高并发写入场景下）：
- `ConcurrentSkipListMap`：多线程并发写入，线性扩展
- `Collections.synchronizedSortedMap(new TreeMap<>())`：全局锁，并发写入时严重阻塞
- `ConcurrentSkipListMap` 的吞吐量在 8 线程下约是同步 TreeMap 的 **5~10 倍**

> [!info] 核心概念：跳表的有序性是 Flush 的前提
> MemStore 维护有序性的目的，不仅仅是为了支持范围扫描，更重要的是：**当 MemStore Flush 到 HFile 时，有序的 KeyValue 序列可以直接顺序写入 HFile，无需额外排序**。这是 Flush 操作能够作为纯顺序写完成的基础。

### 3.3 MemStore 的双缓冲设计：Snapshot 机制

HBase 的 MemStore 实现了一个精巧的**双缓冲（Double Buffer）**机制，确保 Flush 操作不会阻塞正在进行的写入请求。

**为什么需要双缓冲？**

如果 MemStore 只有一个数据结构，那么在 Flush 期间（将数据写入 HFile），必须锁定整个 MemStore 以防止新写入破坏 Flush 中的数据集合。这会导致 Flush 期间所有写入被阻塞，直接影响写入延迟。

**双缓冲的实现：Active + Snapshot**

HBase 的 MemStore 内部维护两个数据结构：

```java
// HBase MemStore 的核心数据结构（简化版）
class MemStore {
    // 活跃写入区：接收所有新的写入请求
    volatile CellSet active;   
    
    // 快照区：Flush 期间的只读副本
    volatile CellSet snapshot; 
}
```

Flush 触发时的流程：

```
步骤1：加锁，将 active 重命名为 snapshot，创建新的空 active
       （这个操作极快，只是指针交换，锁持有时间 < 1ms）

步骤2：释放锁，新的写入继续写入新的 active（不阻塞！）

步骤3：后台线程将 snapshot 中的数据顺序写入 HFile（耗时，但不阻塞写入）

步骤4：HFile 写入完成，清空 snapshot，更新相关元数据
```

这种设计的精妙之处在于：**步骤 1 的锁持有时间极短（指针交换），步骤 3 的耗时操作在不持有锁的情况下执行**。写入请求在 Flush 期间几乎感知不到延迟。

### 3.4 MemStore 的 Flush 触发机制

MemStore Flush 是 LSM-Tree 从内存层（C0）到磁盘层（C1）的关键操作，触发条件有多层：

**触发条件一：单个 MemStore 超过阈值（ memstore.flush.size）**

默认 128MB。当某个列族的 MemStore 超过这个值时，触发**该 Region 的所有列族** Flush（注意是整个 Region 的所有 Store 都 Flush，不是只 Flush 超阈值的那个）。

这里有一个微妙的设计：为什么要 Flush 整个 Region 而不是只 Flush 超阈值的 Store？

原因是 WAL（Write-Ahead Log）的连续性。WAL 是整个 RegionServer 共享的，记录了所有 Region 的写入操作。如果只 Flush 了部分 Store，WAL 中对应该 Region 的条目就无法被标记为"已持久化"（因为另一个 Store 还有未 Flush 的数据可能需要该 WAL 条目进行故障恢复）。Flush 整个 Region 能确保该 Region 对应的 WAL 段可以被清理，避免 WAL 无限增长。

**触发条件二：RegionServer 全局 MemStore 超过上限**

`hbase.regionserver.global.memstore.size`（默认 40% 的 JVM 堆内存）。当所有 MemStore 的总内存占用超过这个值时，触发紧急 Flush：选择 MemStore 最大的 Region 优先 Flush，直到总内存降到 `global.memstore.size.lower.limit`（默认全局上限的 95%）以下。

此时如果 Flush 速度赶不上写入速度，会触发**写入阻塞**（Block）：拒绝新的写入请求，等待 Flush 完成腾出内存。这是 HBase 写入延迟突然暴增的常见根因之一。

**触发条件三：WAL 文件达到上限**

`hbase.regionserver.max.logs`（默认 32 个 WAL 文件）。WAL 是按文件滚动的，旧的 WAL 文件只有在其包含的所有 Region 数据都已 Flush 到 HFile 后才能删除。如果某些 Region 长时间没有写入（因此 MemStore 很小，不触发 Flush），但 WAL 文件已积累到上限，HBase 会强制 Flush 这些 Region 的 MemStore，以便释放旧的 WAL 文件。

**触发条件四：手动触发**

管理员可以通过 HBase Shell 命令 `flush 'tablename'` 手动触发特定表的 Flush，或者 `flush 'regionserver_hostname,port'` 触发特定 RegionServer 的 Flush。

---

## 第 4 章 HFile：磁盘上的有序不可变文件

### 4.1 HFile 的设计目标

[[HFile]] 是 HBase 在 HDFS 上存储数据的文件格式，对应 BigTable 论文中的 SSTable（Sorted String Table）。它的设计目标直接由 HBase 的使用场景决定：

- **支持随机点查**：给定一个 RowKey，能够在不扫描整个文件的情况下快速定位到目标数据
- **支持范围扫描**：给定起止 RowKey，能够顺序读取区间内的所有数据
- **高压缩率**：相同 RowKey 下的多列数据具有前缀重复性，适合压缩
- **写入一次，读取多次**：HFile 写入后不再修改（Immutable），可以针对读取优化内部结构
- **支持 Bloom Filter**：在不读取数据块的情况下，快速判断某个 RowKey 是否存在于文件中

### 4.2 HFile 的版本演进

HFile 从 HBase 诞生至今经历了三个主要版本：

| 版本 | 引入版本 | 核心改进 |
|------|---------|---------|
| **HFile V1** | HBase 0.20 | 初始实现，仅有 Data Block 和简单索引 |
| **HFile V2** | HBase 0.92 | 多级索引（Root + Intermediate + Leaf），Inline Bloom Filter |
| **HFile V3** | HBase 0.98 | 支持 Cell Tag（用于可见性标签、ACL），Tag 压缩改进 |

当前生产环境主流使用 V2/V3。

### 4.3 HFile V2 的内部结构详解

HFile V2 的文件结构如下图所示：

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}}%%
graph TD
    subgraph HFile["HFile V2 文件结构（从上到下）"]
        DB1["Data Block 1</br>(Key-Value 序列，已压缩)"]
        DB2["Data Block 2</br>(Key-Value 序列，已压缩)"]
        DB3["Data Block N</br>(Key-Value 序列，已压缩)"]
        BF1["Bloom Block 1</br>(位数组，用于行级布隆过滤)"]
        BF2["Bloom Block 2"]
        LIB["Leaf Index Block</br>(Data Block 级别的索引)"]
        IIB["Intermediate Index Block</br>(Leaf Index 的索引，可选)"]
        RIB["Root Index Block</br>(文件级别的顶层索引)"]
        BFM["Bloom Filter Meta Block</br>(布隆参数：哈希函数数量、位数组大小)"]
        FI["File Info Block</br>(文件级元数据：最大/最小Key、创建时间等)"]
        TLR["Fixed File Trailer</br>(定长，指向所有其他块的偏移量)"]
    end

    DB1 --> DB2 --> DB3
    DB3 --> BF1
    BF1 --> BF2
    BF2 --> LIB
    LIB --> IIB
    IIB --> RIB
    RIB --> BFM
    BFM --> FI
    FI --> TLR

    classDef data fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef bloom fill:#50fa7b,stroke:#50fa7b,color:#282a36
    classDef index fill:#ff79c6,stroke:#ff79c6,color:#282a36
    classDef meta fill:#f1fa8c,stroke:#f1fa8c,color:#282a36
    classDef trailer fill:#bd93f9,stroke:#bd93f9,color:#282a36

    class DB1,DB2,DB3 data
    class BF1,BF2,BFM bloom
    class LIB,IIB,RIB index
    class FI meta
    class TLR trailer
```

**各部分的详细说明：**

**Data Block（数据块）**

Data Block 是 HFile 中存储实际 KeyValue 数据的基本单元，默认大小为 **64KB**（由 `hbase.mapreduce.hfileoutputformat.blocksize` 和 `ColumnFamilyDescriptor.setBlocksize()` 控制）。

每个 Data Block 的内部结构：
```
+------------------+-----------------------------------+
| Block Header (33B)|  Compressed KeyValue Data         |
+------------------+-----------------------------------+

Block Header 包含：
  - Magic Number（8B）：Block 类型标识
  - Compressed Size（4B）：压缩后大小
  - Uncompressed Size（4B）：未压缩大小
  - Previous Block Offset（8B）：上一个 Block 的文件偏移量
  - Checksum（9B）：数据校验值
```

Data Block 内部的 KeyValue 按键的顺序排列（RowKey 字节序 → CF → CQ → Timestamp 倒序），是**完全排序**的。这保证了块内的顺序读取效率。

Data Block 默认使用 **NONE**（不压缩），但可以配置 SNAPPY、LZ4、ZSTD 等压缩算法。对于文本类数据，SNAPPY 通常能达到 2~3 倍压缩比，ZSTD 能达到 3~5 倍但 CPU 消耗更高。

**Root / Intermediate / Leaf Index Block（多级索引）**

HFile V2 的最重要改进是引入了**多级块索引**，类似于 B+Tree 的结构，解决了 V1 版本在超大 HFile 时索引加载耗内存的问题。

- **Leaf Index Block（叶子索引）**：每个叶子索引条目记录一个 Data Block 的起始 RowKey 和文件偏移量
- **Intermediate Index Block（中间索引）**：每个中间索引条目指向一个 Leaf Index Block
- **Root Index Block（根索引）**：整个索引树的根，固定大小，**在 HFile 打开时完全加载到内存**

查找一个 RowKey 的过程：
1. 读 Root Index Block（已在内存）→ 定位目标 Leaf Index Block 的偏移量
2. 一次磁盘 I/O 读取 Leaf Index Block → 定位目标 Data Block 的偏移量
3. 一次磁盘 I/O 读取 Data Block（64KB）→ 在 Block 内部二分查找目标 KeyValue

**最多 3 次磁盘 I/O（实际上通常 1~2 次，因为 BlockCache 缓存了热点索引和数据块）即可完成随机点查**，这是 HFile 多级索引设计的工程价值。

**Fixed File Trailer（定长文件尾）**

HFile 的最后 4KB（固定大小）是 Trailer，包含：
- 各个段（Data Block 区域、Index 区域、Bloom Filter 区域）的起始文件偏移量
- HFile 版本号
- 压缩算法类型
- 总 Block 数量
- 数据的最小/最大 RowKey

**当 RegionServer 打开一个 HFile 时，首先读取 Trailer**（一次 I/O），然后根据 Trailer 中的偏移量加载 Root Index Block（通常也是一次 I/O）。这两步完成后，HFile 就可以服务随机查询了。

### 4.4 Bloom Filter：用"可能"换取"一定不"

[[Bloom Filter]]（布隆过滤器）是 HBase 读性能优化中最重要的技术之一，它直接影响随机点查（Get）在有大量 HFile 时的性能。

**布隆过滤器的本质问题：如何以极小的空间代价判断元素是否存在于集合中**

考虑一个场景：一个 Region 有 20 个 HFile（因为 Compaction 不够积极），现在需要查询某个 RowKey 是否存在。如果没有布隆过滤器，需要检查所有 20 个 HFile——每个 HFile 需要 2~3 次 I/O 定位是否包含该 RowKey，总共约 40~60 次 I/O。

布隆过滤器能够以**每个 key 约 10 位（bit）的内存代价**，提供这样的判断能力：
- 如果过滤器说"该 key **一定不在**这个文件中"→ 跳过，0 次 I/O
- 如果过滤器说"该 key **可能在**这个文件中"→ 实际读取文件验证

这被称为"**无假阴性（No False Negative）**"：真正存在的 key，过滤器一定会报告"可能存在"；但可能存在假阳性（False Positive）：某个不存在的 key，过滤器可能误报"可能存在"（概率约 1%）。

**布隆过滤器的工作原理**

布隆过滤器使用一个长度为 m 的位数组和 k 个独立的哈希函数：

**写入阶段**（构建布隆过滤器）：
```
对每个 RowKey，用 k 个哈希函数分别计算 k 个哈希值（对应位数组中的 k 个位置），
将这 k 个位置都设置为 1。

例如，k=3，RowKey="user_001"：
  hash1("user_001") = 17 → bit[17] = 1
  hash2("user_001") = 42 → bit[42] = 1
  hash3("user_001") = 103 → bit[103] = 1
```

**查询阶段**（判断是否存在）：
```
对查询的 RowKey，用同样的 k 个哈希函数计算 k 个位置，
检查这 k 个位置是否全为 1：
  全为 1 → 该 key 可能存在（存在误判概率）
  有任意一位为 0 → 该 key 一定不存在
```

**HBase 中 Bloom Filter 的粒度**

HBase 支持两种 Bloom Filter 粒度，通过列族的 `BLOOMFILTER` 属性配置：

| 类型 | 配置值 | 过滤粒度 | 适用场景 |
|------|--------|---------|---------|
| 行级 | `ROW`（默认）| 对 RowKey 建立过滤器 | 按 RowKey 的 Get 操作 |
| 行+列级 | `ROWCOL` | 对 RowKey+Qualifier 建立过滤器 | 按特定列的 Get，稀疏列场景 |
| 关闭 | `NONE` | 不使用 | 场景是全表扫描，Get 很少 |

行级 Bloom Filter 对随机点查（`Get`）有显著的加速效果；`ROWCOL` 在稀疏列场景下进一步减少无效 I/O，但内存占用更大（因为需要为每个（RowKey, Qualifier）组合建立过滤器条目）。

> [!info] 布隆过滤器的内存位置
> 每个 HFile 的 Bloom Filter 数据存储在 HFile 中的 Bloom Block 中（磁盘），但在 HFile 打开时，Bloom Filter 的位数组会被部分或全部**加载到 BlockCache 中**（如果 BlockCache 容量充足）。一旦 Bloom Filter 在内存中，每次过滤操作的代价仅是几次哈希计算，代价极低。

---

## 第 5 章 写放大与读放大的量化分析

### 5.1 HBase 的写放大路径

一条数据在 HBase 的生命周期中，会被写入磁盘多少次？

**写入路径分析：**

```
1. WAL 写入：数据写入 WAL（顺序写，1次）
2. MemStore Flush：MemStore 数据写入 L0 HFile（顺序写，1次）
3. Minor Compaction：若干 L0 HFile 合并成更大的文件（顺序读+顺序写，写 1次）
4. Major Compaction：所有文件合并成一个（顺序读+顺序写，写 1次）

总计：1（WAL）+ 1（Flush）+ N（Compaction 次数）次磁盘写入
```

在 HBase 的典型配置下，一条数据从写入到经过 1 次 Minor Compaction 和 1 次 Major Compaction，会被写入磁盘约 4~6 次。对于 SSD 来说，这个写放大会显著影响 SSD 的使用寿命。

### 5.2 HBase 的读放大路径

不经过 BlockCache 的随机点查，最坏情况需要多少次 I/O？

**最坏情况分析（BlockCache 完全未命中）：**

```
假设一个 Store 有 M 个 HFile：

1. 对每个 HFile 检查 Bloom Filter：
   - Bloom Filter 在内存：0次I/O；
   - Bloom Filter 未加载：1次I/O（读取 Bloom Block）
   
2. 对未被 Bloom Filter 过滤的 HFile（设有 K 个）：
   - 读 Root Index（已在内存）：0次I/O
   - 读 Leaf Index Block：1次I/O
   - 读 Data Block：1次I/O
   共 2次I/O × K个文件

3. 合并 K 个文件的结果：内存操作

总计：约 2K 次 I/O（K = 未被Bloom Filter过滤的文件数）
```

在没有 Bloom Filter、没有 BlockCache 的极端情况下，20 个 HFile 可能需要约 40 次 I/O。这正是 Compaction 存在的意义：通过控制 HFile 数量（理想情况下一个 Store 只有少数几个文件），将最坏情况下的读放大控制在可接受范围内。

### 5.3 BlockCache：缓解读放大的第一道防线

[[BlockCache]] 是 RegionServer 级别的读缓存，缓存最近从 HFile 读取的 Block（Data Block、Index Block、Bloom Block）。它是缓解读放大的最重要机制。

BlockCache 的存储量（默认 JVM 堆内存的 40%）与 MemStore 形成竞争：两者的总内存不能超过可用堆内存（通常约 80%，留 20% 给其他用途）。

BlockCache 的两种实现：
- **LRUBlockCache**（默认）：纯 JVM 堆内存，简单高效，但受 JVM GC 影响
- **BucketCache**（生产推荐）：堆外内存（Off-Heap）或本地 SSD，不受 GC 影响，但配置更复杂

BlockCache 的工作细节在第 06 篇（读链路）中详细展开。

---

## 第 6 章 从理论到实践：HFile 读写的工程细节

### 6.1 HFile 的写入过程：Flush 的工程步骤

MemStore Flush 到 HFile 的过程，是 LSM-Tree C0 → C1 层迁移的核心操作：

**步骤一：创建 HFile Writer**
RegionServer 在 HDFS 上创建一个新的 HFile 文件，初始化 HFile Writer。Writer 内部维护一个 Block Buffer，累积 KeyValue 直到达到 Block 大小阈值（64KB）。

**步骤二：顺序写入 KeyValue**
从 MemStore 的 Snapshot（快照）中按顺序读取 KeyValue（已经是有序的），逐条写入 Block Buffer。每当 Buffer 达到阈值，压缩整个 Block，追加到 HFile（顺序写）。同时更新 Bloom Filter 的位数组（在内存中）和 Block 索引（在内存中）。

**步骤三：写入 Bloom Block 和索引**
所有 Data Block 写完后，将内存中的 Bloom Filter 位数组序列化，追加写入 Bloom Block。然后将索引（Root + Intermediate + Leaf）序列化并写入对应的 Index Block。

**步骤四：写入 Trailer**
将文件尾（Trailer）写入——包含各个段的偏移量，完成文件。

**步骤五：HDFS 文件原子提交**
HFile 的最终写入依赖 HDFS 的原子提交语义：文件在 `close()` 前对其他读者不可见；`close()` 后整个文件原子性地出现在目录中。这保证了读取者要么看到完整的 HFile，要么看不到（不会看到中间状态）。

### 6.2 HFile 的打开过程：RegionServer 的启动代价

当 RegionServer 接管一个 Region 时，需要打开该 Region 的所有 HFile。打开 HFile 的代价包括：

1. **读取 Trailer**（1次 I/O）：获取各个段的偏移量
2. **读取 Root Index Block**（1次 I/O）：加载到内存，用于后续快速定位 Leaf Index
3. **可选：预加载 Bloom Filter**：如果配置了 Bloom Filter 预加载，将 Bloom Block 读取到 BlockCache

这意味着：一个有 200 个 HFile 的 Region，打开时需要约 400~600 次 HDFS 随机读取（Trailer + Root Index），这是 RegionServer 冷启动慢的直接原因。通过合理的 Compaction 策略控制 HFile 数量（每个 Store 理想情况下 1~5 个 HFile），可以显著加快启动速度。

---

## 第 7 章 LSM-Tree 在 HBase 场景下的校准与优化

### 7.1 HBase 与 LevelDB/RocksDB 的 LSM 实现对比

LevelDB 和 RocksDB 是同样基于 LSM-Tree 的 KV 存储引擎，它们采用了更严格的分层策略（Leveled Compaction），HBase 与之相比有重要差异：

| 维度 | HBase | LevelDB/RocksDB |
|------|-------|-----------------|
| **分层模式** | 简单分层（L0 + 大文件） | 严格 Leveled（L0/L1/L2/L3...） |
| **Compaction 触发** | 文件数量超阈值 | 每层大小超阈值 |
| **读放大控制** | 依赖 Bloom Filter + BlockCache | 通过严格分层限制文件数量 |
| **写放大** | 相对较低（合并次数少） | 相对较高（严格分层导致更多合并） |
| **HDFS 依赖** | 依赖 HDFS 管理文件 | 管理本地文件系统 |
| **多 CF 支持** | 每个 CF 独立的 MemStore+HFile | 通常只有一个 CF |

HBase 选择更宽松的 Compaction 策略，是因为它部署在 HDFS 上，网络 I/O（HDFS 读写需要通过网络到 DataNode）的代价远高于本地磁盘 I/O，过于激进的 Compaction 会导致大量网络流量和性能抖动。

### 7.2 调优方向：根据业务负载调整放大权衡

理解了 LSM-Tree 的三种放大问题，就能理解 HBase 调优的根本逻辑：

**写密集型场景**（每秒百万级写入，读少）：
- 增大 MemStore 大小（减少 Flush 频率，降低写放大）
- 减小 BlockCache 比例（写为主，读缓存价值低）
- 使用 `BulkLoad`（HBase MapReduce 批量写入，完全跳过 MemStore 和 WAL）

**读写均衡场景**（既有高频写入，又有大量随机读）：
- 平衡 MemStore 和 BlockCache 比例
- 开启 `ROWCOL` 级别 Bloom Filter（降低读放大）
- 适当积极的 Minor Compaction（控制 HFile 数量）

**读密集型场景**（历史数据查询，写入量小）：
- 增大 BlockCache（提高热数据命中率）
- 执行 Major Compaction（合并所有文件为一个，消除读放大）
- 压缩 HFile（用更高压缩比如 ZSTD，节省磁盘和网络 I/O）

---

## 第 8 章 总结：存储引擎的选择决定了一切

LSM-Tree 作为 HBase 的存储引擎，是所有后续章节讨论的技术基础：

- **写入链路**（第 05 篇）：WAL + MemStore + Flush 的完整过程，本质上是 LSM-Tree C0 层的写入和到 C1 层的迁移
- **读取链路**（第 06 篇）：MemStore + BlockCache + 多层 HFile 的合并读，是 LSM-Tree 读放大问题的具体体现
- **Compaction 机制**（第 07 篇）：LSM-Tree 控制文件数量、清理旧版本的核心后台操作，是写放大和读放大的权衡点

HBase 选择 LSM-Tree 而非 B+Tree 的工程决策，换来了极高的写入吞吐量（顺序写代替随机写），代价是更复杂的读取路径（多层文件合并）和后台的持续 Compaction 压力。

理解了这个基本的取舍逻辑，就能在实际工程中对 HBase 的调优方向作出正确的判断：**当写入延迟高时，看 MemStore 是否频繁 Flush；当读取延迟高时，看 BlockCache 命中率和 HFile 数量；当磁盘空间异常增长时，看 Major Compaction 是否正常执行**。这条诊断思路将在第 10 篇（生产调优实战）中得到充分展开。

---

> [!note] 思考题
> 1. LSM-Tree 通过将随机写转化为顺序写来获得高写入吞吐，但这以读放大为代价——读取一个 Key 可能需要检查 MemStore、BlockCache 以及多个 HFile。HBase 通过 BloomFilter 来减少不必要的 HFile 扫描。BloomFilter 是有假阳性率的——它可能误判"该 Key 在此 HFile 中存在"。这个假阳性会导致什么额外代价？如何根据数据规模选择合适的 BloomFilter 大小？
> 2. HFile 是 HBase 的持久化存储格式，基于 SSTable 结构，内部数据按 RowKey 有序排列。当执行 Scan 操作时，需要同时扫描 MemStore 和多个 HFile，然后按时间戳合并结果。如果一张表有 100 个 HFile（Compaction 长期未执行），一次全表 Scan 的 I/O 放大系数是多少？Minor Compaction 和 Major Compaction 在改善 Scan 性能方面各有什么贡献？
> 3. MemStore 使用 `ConcurrentSkipListMap` 作为内存数据结构，支持并发读写和有序遍历。当 MemStore 达到 `hbase.hregion.memstore.flush.size`（默认 128MB）时触发 Flush。在高并发写入场景下，如果多个 Region 的 MemStore 同时达到 Flush 阈值，会引发大量并发的 HDFS 写操作，导致 RegionServer 的磁盘和网络 I/O 峰值。HBase 的 `hbase.regionserver.global.memstore.size` 全局阈值是如何协调这个问题的？

## 参考资料

- [1] O'Neil, P., et al. "The Log-Structured Merge-Tree (LSM-Tree)." Acta Informatica, 1996.
- [2] Apache HBase Reference Guide — StoreFile (HFile): https://hbase.apache.org/book.html#hfile
- [3] 从 B+树到 LSM 树，及 LSM 树在 HBase 中的应用: https://cloud.tencent.com/developer/article/1662272
- [4] HBase 存储文件 HFile 结构解析: http://hbasefly.com/2016/03/25/hbase-hfile/
- [5] Bloom Filters by Example: https://llimllib.github.io/bloomfilter-tutorial/
- [6] HBase MemStore 内存管理机制: https://www.jianshu.com/p/85567b4308f8
- [7] RocksDB Wiki — Leveled Compaction: https://github.com/facebook/rocksdb/wiki/Leveled-Compaction
