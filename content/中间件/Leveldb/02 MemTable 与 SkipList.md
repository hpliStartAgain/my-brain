---
title: "MemTable 与 SkipList"
date: 2026-03-05
tags: [Arena, InternalKey, LevelDB, MemTable, MVCC, SkipList, 中间件, 存储引擎]
aliases: []
---

# MemTable 与 SkipList

## 摘要

MemTable 是 LevelDB 写入路径的核心内存数据结构，承接所有写入操作并维护键值对的有序性。其底层实现是 **SkipList（跳跃表）**——一种通过随机化多层索引实现 O(log N) 期望时间复杂度的有序数据结构，兼具 B+ 树的查找效率和链表的插入便利性。本文深度解析 SkipList 的结构原理与 LevelDB 中的工程实现，解析 **Arena 内存分配器**如何通过大块预分配消除 `malloc` 的碎片化代价，并分析 **InternalKey** 编码（UserKey + SequenceNumber + ValueType）如何支撑 MVCC 多版本控制。理解 MemTable 的实现细节，是掌握 LevelDB 写入性能来源的关键。

---

## 第 1 章 MemTable 的定位与职责

### 1.1 MemTable 在写入路径中的位置

在 [[01 LevelDB 全局架构——LSM-Tree 的写优化设计]] 中，我们了解到 LevelDB 的写入路径分为两个阶段：先写内存（MemTable），再批量刷盘（SSTable）。MemTable 正是这个两阶段模型中的内存缓冲层。

从职责角度看，MemTable 需要同时满足以下几个看似矛盾的需求：

1. **写入高效**：每秒需要承接数十万次 Put/Delete 操作，插入操作的延迟必须控制在微秒级
2. **有序存储**：键值对必须按 key 的字节序有序存储，以便刷盘时能顺序写出有序的 SSTable
3. **支持并发读**：Get 请求需要同时在 MemTable 中查找，要求读写并发不互相阻塞（至少不频繁阻塞）
4. **内存受控**：MemTable 的内存占用必须可预测、有上限，超过阈值时能快速切换为 Immutable MemTable

哈希表能满足 1 和 3，但无法满足 2（无序）。B+ 树能满足 2，但实现复杂，且平衡调整操作需要持有锁，并发性差。**SkipList** 以其简洁的结构和优异的并发特性，成为 LevelDB MemTable 的最佳选择。

### 1.2 MemTable 的内部结构

LevelDB 的 MemTable 由两个核心部件组成：

- **SkipList**：有序索引结构，存储所有 InternalKey → Value 的映射，支持有序迭代
- **Arena**：专用内存分配器，为 SkipList 的节点分配内存，避免频繁调用 `malloc`/`free`

MemTable 还维护一个 `refs_` 引用计数，当 MemTable 被多个组件引用时（如同时有读请求在访问，以及后台 Compaction 线程在刷盘），通过引用计数控制其生命周期，避免提前析构。

---

## 第 2 章 SkipList——优雅的有序并发数据结构

### 2.1 从链表说起——SkipList 的设计动机

要理解 SkipList，先从最简单的有序链表开始思考。

假设维护一个有序的单链表，插入和查找的时间复杂度均为 O(N)——因为链表只能从头部开始顺序遍历，无法像数组那样随机访问。对于 N=100 万的情况，平均每次操作需要遍历 50 万个节点，这对于高频写入场景显然不可接受。

**如何加速链表的查找？** 一个直觉的想法是：在原始链表之上再建一层"快速通道"——每隔 K 个节点，提取一个节点放到上层链表。查找时先在上层快速通道中定位范围，再到下层原始链表中精确查找。这就是 SkipList 的核心思想。

William Pugh 在 1990 年的论文《Skip Lists: A Probabilistic Alternative to Balanced Trees》中将这个思想推向极致：不是固定间隔地提取节点，而是用**随机化方法**决定每个节点是否出现在上层索引中——每个节点以概率 p 被提升到上一层（LevelDB 中 p = 1/4），理论上可以建立 O(log N) 层索引，实现 O(log N) 期望时间复杂度的查找和插入。

SkipList 相比平衡二叉树（AVL、红黑树）的关键优势在于：**插入和删除不需要复杂的平衡旋转操作**，逻辑更简单，且天然支持无锁并发读（详见 2.4 节）。

### 2.2 SkipList 的结构详解

一个典型的 SkipList 结构如下：

```
层级 4：  head ──────────────────────────────────────── [key:50] ── tail
              
层级 3：  head ──────────── [key:15] ──────────────── [key:50] ── tail

层级 2：  head ─── [key:7] ─── [key:15] ─── [key:30] ─ [key:50] ── tail

层级 1：  head ─ [key:3] ─ [key:7] ─ [key:15] ─ [key:22] ─ [key:30] ─ [key:40] ─ [key:50] ─ tail
（原始有序链表）
```

每个节点包含：
- **key**：InternalKey（在 LevelDB 中是 UserKey + SequenceNumber + ValueType 的编码）
- **value**：键值对的实际 Value（在 MemTable 的 SkipList 中，value 与 key 一起编码存储）
- **`next_[maxHeight]`**：多层 forward 指针数组，`next_[i]` 指向同层的下一个节点

**查找过程（以查找 key=22 为例）**：
1. 从最高层（层级 4）开始，从 head 出发
2. 层级 4：head → 50（22 < 50，不前进，下降到层级 3）
3. 层级 3：head → 15（22 > 15，前进）→ 50（22 < 50，下降到层级 2）
4. 层级 2：15 → 30（22 < 30，下降到层级 1）
5. 层级 1：15 → 22（找到！）

整个查找只遍历了 5 个节点，而链表需要遍历 6 个节点。层数越多、数据量越大，效果越明显。

**插入过程**：插入需要先执行查找，记录每一层的"前驱节点"（即每层中最后一个 key 小于待插入 key 的节点），然后随机决定新节点的高度，最后更新前驱节点的 forward 指针。

```cpp
// LevelDB SkipList 节点定义（简化版）
template<typename Key, class Comparator>
struct SkipList<Key, Comparator>::Node {
  explicit Node(const Key& k) : key(k) {}
  Key const key;

  // 获取/设置第 n 层的 forward 指针
  // 使用 std::atomic 保证无锁并发读的内存序
  Node* Next(int n) {
    assert(n >= 0);
    return next_[n].load(std::memory_order_acquire);
  }
  void SetNext(int n, Node* x) {
    assert(n >= 0);
    next_[n].store(x, std::memory_order_release);
  }

 private:
  // forward 指针数组，大小在构造时确定（等于节点高度）
  std::atomic<Node*> next_[1];  // 变长数组，实际大小由 Arena 分配时确定
};
```

### 2.3 随机高度——概率平衡的本质

SkipList 最巧妙之处在于**用随机化代替严格平衡**。每次插入新节点时，通过抛硬币决定节点高度：

```cpp
// LevelDB 中节点高度的随机决定（简化）
int SkipList::RandomHeight() {
  static const unsigned int kBranching = 4;  // p = 1/4
  int height = 1;
  while (height < kMaxHeight && ((rnd_.Next() % kBranching) == 0)) {
    height++;
  }
  assert(height > 0);
  assert(height <= kMaxHeight);
  return height;
}
```

以 p=1/4、kMaxHeight=12 的参数分析：
- 节点高度为 1 的概率：`1 - 1/4 = 3/4 ≈ 75%`
- 节点高度为 2 的概率：`1/4 × (1 - 1/4) ≈ 18.75%`
- 节点高度为 3 的概率：`(1/4)² × (1 - 1/4) ≈ 4.7%`
- 节点高度为 h 的概率：`(1/4)^(h-1) × (3/4)`

这种概率分布保证了高层索引的节点数量大约是下层的 1/4，构成一个近似于"每隔 4 个节点提取一个"的多层索引结构。**期望查找复杂度为 O(log₄ N)**，对于 100 万节点，期望比较次数约为 `log₄(10⁶) ≈ 10` 次。

> [!note] 设计哲学
> 为什么选择随机化而非严格平衡？严格平衡树（如 AVL 树、红黑树）的插入/删除需要执行旋转操作来维护平衡不变式，这些操作不仅逻辑复杂，还需要持有写锁，多线程并发时锁竞争严重。随机化 SkipList 的插入只需修改 forward 指针，不需要全局重平衡，因此可以通过精心设计内存序（Memory Order）实现无锁并发读（只需写操作加锁）。

### 2.4 无锁并发读的实现

LevelDB 的 SkipList 针对多读者单写者（MRSW）场景进行了专门优化：**写操作持有 MemTable 的写锁，读操作完全无锁**。

这通过 C++ 的 `std::atomic` 和精确的内存序控制实现：

- **写入新节点**：先分配节点内存、填充 key/value，然后按从**低层到高层**的顺序设置 forward 指针，每次设置使用 `memory_order_release`（确保节点内容在指针可见之前已完全写入）
  
- **读取时遍历**：使用 `memory_order_acquire` 加载 forward 指针，保证看到的节点内容是完整的（不会看到半初始化的节点）

这种设计的关键洞察：**读操作永远不需要等待，因为 SkipList 只追加新节点，不修改已有节点**（MemTable 中的"修改"是通过写入更高 SequenceNumber 的新条目实现的，原条目保持不变）。这与 LSM-Tree 的整体 Append-Only 设计哲学完全一致。

> [!warning] 生产避坑
> LevelDB 的无锁读依赖于两个前提：①写操作只追加，不修改已有节点；②`std::atomic` 的 acquire/release 语义保证内存可见性。如果在 LevelDB 之上构建类似结构，切勿在不理解内存模型的前提下随意修改并发逻辑，错误的内存序可能导致极难复现的并发 Bug。

---

## 第 3 章 InternalKey——MVCC 的编码基础

### 3.1 为什么需要 InternalKey

在 MemTable（和 SSTable）中，键不是直接使用用户提供的原始 key（UserKey），而是编码为 **InternalKey**。这个额外的编码层有两个核心目的：

1. **支持 MVCC 多版本**：同一个 UserKey 可能被多次写入（包括删除后重新写入），InternalKey 通过携带 SequenceNumber 区分同一 key 的不同版本

2. **支持软删除（Tombstone）**：`Delete(key)` 不是真正从数据结构中移除数据，而是写入一条特殊的 InternalKey（ValueType = kTypeDeletion），标记该 key 已被删除

### 3.2 InternalKey 的编码格式

```
InternalKey 格式：
┌──────────────────────────────┬──────────────────────────┬─────────────┐
│  UserKey（变长，用户原始 key）  │  SequenceNumber（7字节）  │ Type（1字节）│
└──────────────────────────────┴──────────────────────────┴─────────────┘
                                ← ─ ─ 这两个字段打包成一个 uint64_t ─ ─ →
```

**SequenceNumber（序列号）**：7 字节，最大值约为 `2^56 ≈ 7200 万亿`，全局单调递增。每次 WriteBatch 提交时，消耗若干个 SequenceNumber（一个 WriteBatch 中有多少条写入，就消耗多少个）。

**ValueType（值类型）**：1 字节，当前只有两个有效值：
- `kTypeValue = 1`：正常写入
- `kTypeDeletion = 0`：删除标记（Tombstone）

在实际存储中，SequenceNumber（7字节）和 ValueType（1字节）被合并成一个 `uint64_t`，计算方式为：
```
packed_tag = (SequenceNumber << 8) | ValueType
```

**InternalKey 的比较规则**是 LevelDB 正确性的关键：
1. 首先按 UserKey 升序排列
2. 若 UserKey 相同，则按 SequenceNumber **降序**排列（SequenceNumber 大的在前，即更新的版本排在前面）
3. 若 SequenceNumber 也相同，则按 ValueType 降序排列（`kTypeValue=1` 排在 `kTypeDeletion=0` 之前）

这个比较规则保证：对于同一个 UserKey，**最新版本总是排在最前面**。MemTable 或 SSTable 中查找一个 key 时，第一个匹配到的条目就是最新版本，读取效率最高。

### 3.3 LookupKey——查找时的辅助结构

读取路径中，为了在 MemTable 和 SSTable 中查找某个 UserKey 在特定 SequenceNumber 快照下的值，LevelDB 构造了一个 **LookupKey**：

```
LookupKey 格式：
┌──────────┬──────────────────────────────────────────────────────────┐
│ 总长度    │  UserKey + (snapshot_seq << 8 | kValueTypeForSeek)       │
└──────────┘──────────────────────────────────────────────────────────┘
```

其中 `kValueTypeForSeek = kTypeValue = 1`，之所以选 1 而非 0（kTypeDeletion），是因为 InternalKey 的比较中 ValueType 越大排越前，这样构造的 LookupKey 在有序结构中能找到"SequenceNumber ≤ snapshot_seq 的最大版本"，即在该快照下可见的最新版本。

这个设计的精妙之处：**同一套 SkipList 的 Seek 操作，通过不同的 LookupKey 参数，就能实现不同 SequenceNumber 快照下的读取，无需为每个快照维护独立的数据结构**。

> [!info] 核心概念
> **快照读（Snapshot Read）**：LevelDB 允许客户端获取一个 `Snapshot` 对象（本质上是当前 SequenceNumber 的副本），后续使用该 Snapshot 进行读取时，只能看到 Snapshot 创建时刻之前已提交的数据，不受后续写入的影响。这是 LevelDB 的 MVCC 实现——不同时刻的读者看到的是不同的"历史版本"，彼此不干扰。

---

## 第 4 章 Arena——专用内存分配器

### 4.1 为什么不直接用 malloc

SkipList 的节点大小是可变的（高度不同，`next_` 数组大小不同），且插入频率极高（每秒可能有数十万次插入）。如果每次插入都调用 `malloc` 分配节点内存，会面临以下问题：

1. **系统调用开销**：`malloc` 在频繁小对象分配时会触发较多的系统调用（`brk`/`mmap`），有明显的 CPU 开销
2. **内存碎片**：大量小对象的 `malloc`/`free` 会产生严重的内存碎片，导致实际内存占用远超理论值，且 `free` 归还给操作系统的时机不可控
3. **无法整体释放**：MemTable 生命周期结束时（刷盘完成后），需要释放所有节点的内存。如果每个节点都独立 `malloc`，就需要遍历 SkipList 逐个 `free`，代价高且容易出错

**Arena 的解决思路**：预先分配一大块内存（Block），然后从中线性分配（Bump Pointer Allocation）。所有分配请求都是从当前 Block 的末尾"切割"一小块，指针向前移动，速度接近于数组索引操作。当 Block 用完时，申请下一个 Block。**释放时，直接释放所有 Block，无需逐个 free 节点。**

### 4.2 Arena 的实现细节

```cpp
// LevelDB Arena 的核心数据结构（简化）
class Arena {
 public:
  Arena();
  ~Arena();

  // 分配 bytes 字节的内存，返回指针
  char* Allocate(size_t bytes);
  
  // 按对齐要求分配内存（用于需要特定对齐的场景，如 atomic 变量）
  char* AllocateAligned(size_t bytes);

  // 返回 Arena 已分配的总内存量（用于监控 MemTable 大小）
  size_t MemoryUsage() const {
    return memory_usage_.load(std::memory_order_relaxed);
  }

 private:
  char* AllocateFallback(size_t bytes);
  char* AllocateNewBlock(size_t block_bytes);

  char* alloc_ptr_;        // 当前 Block 中下一次分配的起始指针
  size_t alloc_bytes_remaining_;  // 当前 Block 剩余可用字节数
  std::vector<char*> blocks_;     // 已分配的所有 Block 的指针列表
  std::atomic<size_t> memory_usage_;  // 已使用总内存（用于判断是否超阈值）
};
```

**Allocate 的快速路径**：
```cpp
inline char* Arena::Allocate(size_t bytes) {
  assert(bytes > 0);
  if (bytes <= alloc_bytes_remaining_) {
    // 快速路径：当前 Block 剩余空间足够，直接 Bump Pointer
    char* result = alloc_ptr_;
    alloc_ptr_ += bytes;
    alloc_bytes_remaining_ -= bytes;
    return result;
  }
  // 慢速路径：当前 Block 不够，申请新 Block
  return AllocateFallback(bytes);
}
```

快速路径只有三条指令（一次比较 + 两次指针运算），比 `malloc` 快 10~100 倍。

**Block 大小策略**：
- 标准 Block 大小为 4096 字节（与内存页大小对齐）
- 若请求的内存 > Block 大小的 1/4（即 >1024 字节），则为该请求单独申请一个精确大小的 Block，避免大对象占满整个标准 Block 导致后续小对象浪费空间
- 否则，申请一个新的标准 4096 字节 Block，从中分配请求的内存

### 4.3 Arena 与 MemTable 大小控制

MemTable 通过 `Arena::MemoryUsage()` 来判断是否超过了大小阈值（默认 4MB），从而决定是否需要切换为 Immutable MemTable。

```
MemTable 大小检查（每次写入后）：
if (mem_->ApproximateMemoryUsage() > options_.write_buffer_size) {
    // 将当前 MemTable 冻结为 Immutable MemTable
    // 创建新的 MemTable
    // 触发后台 Compaction 线程
}
```

`ApproximateMemoryUsage()` 返回的是 Arena 已分配的总内存（包括所有 Block 的大小总和），而非实际使用的字节数。由于 Arena 的 Bump Pointer 分配策略，已分配内存和实际使用内存之间的差异通常不超过一个 Block 的大小（4096 字节），误差极小。

> [!info] 核心概念
> **`write_buffer_size` 参数**（默认 4MB）是 LevelDB 最重要的调优参数之一。增大它可以减少 Compaction 频率（更少的 L0 文件）和写放大（每个 SSTable 文件更大，Compaction 合并效率更高），但代价是：①内存占用增加（同时可能有 2 个 MemTable：一个活跃 + 一个 Immutable）；②崩溃恢复时需要重放更大的 WAL，恢复时间更长。

---

## 第 5 章 MemTable 的完整写入与读取流程

### 5.1 一次 Put 在 MemTable 中的完整路径

以 `db->Put(WriteOptions(), "user:alice", "30")` 为例，追踪数据在 MemTable 中的处理流程：

**步骤 1：构造 WriteBatch**
```
WriteBatch 内容：
  sequence_number = 1001
  count = 1
  record[0]: type=kTypeValue, key="user:alice", value="30"
```

**步骤 2：WAL 追加写**（见[[01 LevelDB 全局架构——LSM-Tree 的写优化设计]]的第 4 章）

**步骤 3：MemTable 插入**
- 将 `("user:alice", 1001, kTypeValue)` 编码为 InternalKey
- InternalKey 的二进制表示：`user:alice` 的字节 + `(1001 << 8 | 1)` 的小端 uint64_t
- 通过 Arena 分配 SkipList 节点内存（节点大小 = InternalKey 长度 + value 长度 + 节点头部）
- 在 SkipList 中执行有序插入（随机决定节点高度，更新相关层的 forward 指针）

**步骤 4：MemTable 大小检查**
- 读取 `arena_.MemoryUsage()`，若超过 `write_buffer_size`，触发 Minor Compaction 流程

### 5.2 一次 Get 在 MemTable 中的完整路径

以 `db->Get(ReadOptions(), "user:alice", &value)` 为例：

**步骤 1：构造 LookupKey**
- 若 `ReadOptions.snapshot == nullptr`，使用当前最新的 SequenceNumber（`last_sequence`）
- 构造 `LookupKey = "user:alice" + (last_sequence << 8 | kValueTypeForSeek)`

**步骤 2：MemTable 的 SkipList Seek**
- 在 SkipList 中执行 `iter.Seek(lookup_key)`
- Seek 找到第一个 InternalKey ≥ LookupKey 的节点
- 由于 InternalKey 的比较规则（相同 UserKey 下 SequenceNumber 降序），找到的节点就是满足 `UserKey == "user:alice"` 且 `SequenceNumber ≤ last_sequence` 的最新版本

**步骤 3：结果判断**
- 若找到节点，检查其 ValueType：
  - `kTypeValue`：返回对应的 value，查找成功
  - `kTypeDeletion`：该 key 已被删除，返回 NotFound
- 若未找到（或找到的节点 UserKey 不匹配），转向 Immutable MemTable 继续查找

### 5.3 Delete 操作的实现

`db->Delete(WriteOptions(), "user:alice")` 不会真正从 SkipList 中删除节点，而是插入一条新的记录：

```
InternalKey: "user:alice" + (1002 << 8 | kTypeDeletion)
Value: ""  (空值，Tombstone 的 value 不存储实际数据)
```

这条 Tombstone 记录的 SequenceNumber（1002）大于之前 Put 操作的 SequenceNumber（1001），因此在有序 SkipList 中排在之前版本之前。后续 Get 时，Seek 找到的第一个匹配节点就是这个 Tombstone，直接返回 NotFound，无需再看旧版本。

**延迟删除的代价与收益**：
- **代价**：磁盘上会临时存在旧数据和 Tombstone，直到 Compaction 才真正清理
- **收益**：Delete 操作本身的延迟与 Put 完全相同（都只是内存插入 + WAL 追加），不会因为需要查找和删除旧数据而产生额外的磁盘 IO

---

## 第 6 章 性能特征与调优

### 6.1 MemTable 写入性能分析

MemTable 写入路径的性能构成：

| 操作 | 耗时量级 | 说明 |
|------|----------|------|
| WriteBatch 序列化 | ~10ns | 内存拷贝，极快 |
| WAL 追加写 | ~50~200μs | 主要瓶颈，受磁盘性能影响 |
| Arena 分配内存 | ~5ns | Bump Pointer，比 malloc 快 100x |
| SkipList 插入 | ~100ns~1μs | O(log N)，N=MemTable 中的条目数 |
| MemTable 大小检查 | ~5ns | atomic load，接近零开销 |

**WAL 是写入延迟的主要来源**。LevelDB 的 `WriteOptions.sync` 参数控制 WAL 的同步方式：
- `sync=false`（默认）：WAL 只写入内核 Page Cache，由 OS 异步刷盘。写入延迟约 50~200μs，但崩溃可能丢失最近数秒内的写入
- `sync=true`：WAL 每次写入后调用 `fsync()`，强制刷盘。写入延迟增至 1~10ms，但保证每次写入都持久化

### 6.2 MemTable 读取性能分析

MemTable 的 Get 操作完全是内存操作，典型延迟约 100ns~1μs（取决于 SkipList 的大小和缓存命中率）。MemTable 中的读取比 SSTable 快约 100~1000 倍（SSTable 需要磁盘 IO）。

**热点数据加速效应**：最近写入的数据总是先在 MemTable 中，若应用的读写呈现时间局部性（最近写入的数据最可能被读取），则大量读取会直接命中 MemTable，避免磁盘 IO。这是 LevelDB 在高频读写混合场景下实际性能远好于理论分析的原因之一。

### 6.3 关键参数调优建议

| 参数 | 默认值 | 调优建议 |
|------|--------|----------|
| `write_buffer_size` | 4MB | 内存充裕时可调至 64MB~256MB，减少 Compaction 频率，降低写放大 |
| `max_write_buffer_number` | 2（LevelDB 固定） | LevelDB 只有 1 活跃 + 1 Immutable，RocksDB 此参数可调 |
| `WriteOptions.sync` | false | 对数据安全要求高的场景设为 true，代价是 10x 写入延迟 |
| Bloom Filter bits | 10 bits/key | 增大可降低假阳性率，减少读 IO，代价是更多内存 |

> [!warning] 生产避坑
> 若业务的写入速度持续超过 Minor Compaction（Immutable MemTable 刷盘）的速度，会导致 Immutable MemTable 无法及时清空，进而阻塞新的写入（LevelDB 写入限速机制）。监控 `leveldb.num-immutable-mem-table` 指标，若该值持续 > 0，需要检查磁盘 IO 是否成为瓶颈，或考虑增大 `write_buffer_size` 以减少 Minor Compaction 频率。

---

## 第 7 章 小结

### 7.1 核心设计决策回顾

MemTable 的设计体现了三个核心决策的精妙组合：

- **SkipList vs 平衡树**：选择 SkipList 是因为其简洁的无锁并发读实现（Append-Only + atomic 内存序），以及避免平衡旋转带来的锁竞争
- **InternalKey 编码**：将 UserKey + SequenceNumber + ValueType 合并为一个统一的比较键，用单一的有序数据结构同时支持多版本（MVCC）、软删除（Tombstone）和快照读（Snapshot）
- **Arena 分配器**：通过 Bump Pointer 分配将小对象分配成本降至接近零，并支持 MemTable 生命周期结束时的整体释放

这三个决策相互配合，共同使 MemTable 成为 LevelDB 写入路径的高效缓冲层。

### 7.2 后续章节导引

- **[[03 SSTable 的文件格式与 Block 结构]]**：深入 MemTable 刷盘后生成的 SSTable 文件格式，理解 Data Block、Index Block、Bloom Filter 的布局与读取优化
- **[[04 Compaction——分层合并与版本管理]]**：理解多个 SSTable 如何通过 Compaction 合并，以及 Version/VersionEdit/VersionSet 如何管理文件集合的 MVCC

---

> [!note] 思考题
> 1. 写入路径：先写 WAL（Write-Ahead Log，顺序追加）再写 MemTable（内存跳表）。WAL 保证了崩溃恢复——重启时重放 WAL 恢复 MemTable 内容。如果 WAL 写入成功但 MemTable 写入失败（如内存不足），数据是否安全？WAL 的 fsync 策略（每次写入 fsync vs 批量 fsync）如何影响持久性和性能？
> 2. 读取路径：先查 MemTable → Immutable MemTable → Level 0 SSTable → Level 1 SSTable → ...。在最坏情况下（Key 在最底层），需要查找所有层级的 SSTable。LevelDB 通过'表缓存'（Table Cache）缓存打开的 SSTable 文件描述符和索引块。在什么场景下 Table Cache 的大小成为性能关键因素？
> 3. MemTable 使用跳表（Skip List）实现——O(log n) 的插入和查找。为什么选择跳表而非红黑树或 B+ 树？跳表的实现更简单且对并发读友好（无需复杂的旋转操作）。RocksDB 后来引入了 HashSkipList 和 HashLinkList——它们在什么场景下优于普通 SkipList？
