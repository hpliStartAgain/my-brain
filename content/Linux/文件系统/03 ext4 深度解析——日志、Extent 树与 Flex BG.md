---
title: "ext4 深度解析——日志、Extent 树与 Flex BG"
date: 2026-03-02
tags: [Linux, 文件系统, ext4, Extent树, 日志, journal, Flex BG, 块组, 崩溃一致性, JBD2]
aliases: ["ext4文件系统原理", "ext4 Extent树", "ext4日志机制", "JBD2内核", "ext4块组布局"]
---

**摘要：**

ext4 是当前 Linux 发行版使用最广泛的文件系统——Ubuntu、Debian、CentOS 7 及更早版本默认使用 ext4，绝大多数云主机的系统盘也是 ext4。它的前身 ext2/ext3 已经服役了 20 多年，而 ext4 在此基础上引入了三个革命性改进：**Extent 树**（彻底解决了大文件的块指针碎片化问题）、**弹性块组（Flex BG）**（大幅提升大文件顺序读写性能）和**日志改进（JBD2）**（checksumming 和更快的 fsck）。本文从 ext4 的磁盘物理布局出发，逐层解析块组（Block Group）的结构、inode 表的组织方式、Extent 树如何用 B 树结构描述文件数据块的分布，然后深入 JBD2 日志子系统——日志为什么能保证崩溃一致性、日志的三种模式（writeback/ordered/journal）有何本质区别、为什么 ordered 模式是大多数场景的最佳选择，最后分析 Flex BG 对连续大文件 IO 性能的提升原理，以及 ext4 在生产中最常见的调优手段。

---

## 第 1 章 从 ext2 到 ext4：三代演进的问题与解法

### 1.1 ext2 的奠基：块组布局

ext2（1993 年，Rémy Card 实现）建立了 Linux 文件系统的基本磁盘布局范式，这个布局被 ext3、ext4 完全继承：

**磁盘被分为等大小的块组（Block Group）**，每个块组包含一套完整的管理结构——超级块（可选备份）、块组描述符（GDT）、数据块位图、inode 位图、inode 表、数据块。

为什么要分组？核心原因是**局部性（Locality）**：如果一个文件的 inode 和其数据块都在同一个块组里，访问这个文件的 IO 操作都在磁盘的同一区域——对 HDD 而言，这意味着更少的磁头寻道，更快的访问速度。

**ext2 的致命缺陷：三级间接块指针**

ext2 用一个固定大小的数组（inode 内嵌的 `i_block[15]`）来描述文件数据块的位置：
- `i_block[0..11]`：直接指针（12 个块，4KB 块 = 48KB）
- `i_block[12]`：一级间接块（指向一个块，该块存 1024 个块指针 = 4MB）
- `i_block[13]`：二级间接块（= 4GB）
- `i_block[14]`：三级间接块（= 4TB）

这个设计对于大文件极为低效——一个 1GB 的文件，其块指针会分散在数百个间接块中，顺序读取需要大量额外的磁盘寻道（读间接块）。而且 fsck（文件系统检查修复）需要遍历这些间接块，扫描 1TB 磁盘可能需要数小时。

### 1.2 ext3 的补丁：日志

ext3（2001 年）在 ext2 基础上添加了日志（Journal）子系统（JBD，Journal Block Device），解决了 ext2 最大的痛点——**崩溃后需要漫长的 fsck**。

ext2 时代，系统断电后重启，必须用 `fsck` 扫描整个磁盘，检查并修复文件系统不一致（可能需要数十分钟）。日志的引入使得崩溃恢复从"扫描整个磁盘"变为"重放日志"——通常只需几秒。

但 ext3 完全继承了 ext2 的三级间接块指针，大文件性能问题依然存在。

### 1.3 ext4 的根本性改进

ext4（2008 年，Linux 2.6.28）的核心改进：

1. **Extent 树（取代三级间接块指针）**：用 B 树描述文件的连续块区间，大幅减少元数据 IO
2. **弹性块组 Flex BG**：将多个块组的 inode 表合并到第一个块组，使数据区域连续
3. **延迟分配（Delayed Allocation）**：写数据时不立即分配磁盘块，积累一批后再分配，提升块分配质量
4. **多块分配（Multi-block Allocation）**：一次 IO 分配多个连续块，减少碎片
5. **更快的 fsck**：未使用的 inode 在 inode 表中标记，fsck 可跳过它们
6. **JBD2（Journal Block Device 2）**：日志 checksum，支持更大的日志

---

## 第 2 章 ext4 磁盘布局：从分区到数据块

### 2.1 整体布局

一个 ext4 格式化的分区（如 `/dev/sda1`）的磁盘布局：

```
分区起始
  ├─ Boot Block（前 1024 字节）      ← 引导扇区（传统保留，ext4 不使用）
  │
  ├─ Block Group 0（块组 0）         ← 首个块组，包含主超级块
  │    ├─ Superblock（1 个块）       ← 文件系统全局配置
  │    ├─ Group Descriptor Table    ← 所有块组的描述符数组（每个块组一个 32/64 字节条目）
  │    ├─ Reserved GDT blocks       ← 为将来 resize 预留的 GDT 空间
  │    ├─ Data Block Bitmap（1 块）  ← 位图：该块组中哪些数据块已被使用
  │    ├─ Inode Bitmap（1 块）       ← 位图：该块组中哪些 inode 已被使用
  │    ├─ Inode Table（N 块）        ← inode 数组（每个 inode 256 字节，4KB/256=16 个/块）
  │    └─ Data Blocks（剩余空间）    ← 文件数据存储区
  │
  ├─ Block Group 1                  ← 可能包含超级块备份（sparse_super2 特性）
  │    ├─ Data Block Bitmap
  │    ├─ Inode Bitmap
  │    ├─ Inode Table
  │    └─ Data Blocks
  │
  ├─ Block Group 2
  │    └─ ...（无超级块备份）
  │
  └─ Block Group N（最后一个块组）
       └─ ...
```

**块组的大小**：默认情况下，每个块组包含 `8 * 块大小（字节）` 个块——4KB 块大小的文件系统，每个块组有 `8 * 4096 = 32768` 个块，即 128MB。这个数字来自：一个块的位图（Block Bitmap）最多能表示的块数 = 4096 字节 × 8 位 = 32768 个块。

```bash
# 查看 ext4 的块组布局
dumpe2fs -h /dev/sda1 | head -50
# Block count:              10485760     ← 总块数
# Block size:               4096         ← 块大小
# Blocks per group:         32768        ← 每组块数
# Inodes per group:         8192         ← 每组 inode 数
# Group count:              320          ← 块组总数（10485760 / 32768）

# 查看单个块组的详细信息
dumpe2fs /dev/sda1 | grep "Group 0:" -A 8
# Group 0: (Blocks 0-32767) csum 0x1234
#   Primary superblock at 0, Group descriptors at 1-5
#   Reserved GDT blocks at 6-261
#   Block bitmap at 262 (+262), csum 0xabcd
#   Inode bitmap at 278 (+278), csum 0xef01
#   Inode table at 294-549 (+294)
#   23420 free blocks, 8181 free inodes, 2 directories
```

### 2.2 超级块（Superblock）

超级块存储文件系统的全局配置，是 ext4 最关键的元数据之一：

```c
/* ext4 磁盘超级块（ext4_super_block，在磁盘上的格式）关键字段 */
struct ext4_super_block {
    __le32  s_inodes_count;         /* 总 inode 数 */
    __le32  s_blocks_count_lo;      /* 总块数（低 32 位）*/
    __le32  s_r_blocks_count_lo;    /* 保留块数（为 root 保留，防止普通用户填满文件系统）*/
    __le32  s_free_blocks_count_lo; /* 空闲块数 */
    __le32  s_free_inodes_count;    /* 空闲 inode 数 */
    __le32  s_first_data_block;     /* 第一个数据块号（4KB 块 = 0，1KB 块 = 1）*/
    __le32  s_log_block_size;       /* 块大小 = 1024 << s_log_block_size（0=1KB, 2=4KB）*/
    __le32  s_blocks_per_group;     /* 每组块数（通常 32768）*/
    __le32  s_inodes_per_group;     /* 每组 inode 数 */
    __le32  s_mtime;                /* 上次挂载时间 */
    __le32  s_wtime;                /* 上次写入时间 */
    __le16  s_magic;                /* 魔数（0xEF53 = ext2/3/4）*/
    __le16  s_state;                /* 文件系统状态（1=clean, 0=errors, 2=orphans）*/
    __le16  s_rev_level;            /* 版本（0=ext2, 1=ext3/ext4）*/
    __le32  s_feature_compat;       /* 兼容特性标志 */
    __le32  s_feature_incompat;     /* 不兼容特性标志（包含是否使用 Extents）*/
    __le32  s_feature_ro_compat;    /* 只读兼容特性标志 */
    __u8    s_uuid[16];             /* 文件系统 UUID */
    char    s_volume_name[16];      /* 卷标（mkfs.ext4 -L 设置的名字）*/
    /* ... 其他字段 ... */
};
```

超级块在块组 0 的第一个块（对于 4KB 块大小）或第二个块（1KB 块大小，需要跳过引导扇区）中存储。为了安全，超级块在多个块组中有备份副本（传统上在块组 1、3、5、7……的幂次组中，`sparse_super` 特性启用后）。

---

## 第 3 章 Extent 树：大文件存储的根本改进

### 3.1 为什么 Extent 树比间接块指针好

**核心问题**：文件的数据块通常不是随机分散的，而是连续的大块（因为文件系统的块分配器会尽量分配连续块）。用单个块指针（指向一个 4KB 块）来描述一个连续的 1GB 文件，需要 `1GB/4KB = 262144` 个块指针，这些指针分散在数十个间接块中，访问文件末尾需要额外的 3 次磁盘 IO（读 3 级间接块）。

**Extent 的思想**：与其记录每一个块的指针，不如记录"从物理块 X 开始，有 Y 个连续块"。一个 Extent 用 12 字节描述一段连续块区间：

```c
struct ext4_extent {
    __le32  ee_block;     /* 这段连续块在文件中的起始逻辑块号（Logical Block Number）*/
    __le16  ee_len;       /* 连续块的数量（最大 32768，即 128MB 一个 Extent）*/
    __le16  ee_start_hi;  /* 物理块号的高 16 位 */
    __le32  ee_start_lo;  /* 物理块号的低 32 位（合计 48 位物理块号，支持 1EB 磁盘）*/
};
```

一个 128MB 的连续文件段，用一个 Extent 就能描述（vs ext2 需要 32768 个块指针）。

**实际效果**：对于顺序写入的大文件，ext4 通常只需要少量 Extent（1-10 个）就能描述整个文件的布局，元数据 IO 开销从 ext2 的 O(文件大小/块大小) 降低到 O(碎片数)。

### 3.2 Extent 树的结构

Extent 树是一个 B 树，存储在 inode 的 `i_data` 字段（60 字节内联存储）：

```c
/* Extent 树的内部节点（索引节点）*/
struct ext4_extent_idx {
    __le32  ei_block;   /* 该索引覆盖的文件逻辑块范围的起始块号 */
    __le32  ei_leaf_lo; /* 子节点（叶子页或内部节点页）的物理块号（低 32 位）*/
    __le16  ei_leaf_hi; /* 子节点物理块号（高 16 位）*/
    __u16   ei_unused;
};

/* Extent 树节点的头部（叶子节点和内部节点通用）*/
struct ext4_extent_header {
    __le16  eh_magic;   /* 魔数（0xF30A）*/
    __le16  eh_entries; /* 当前节点中有效条目数 */
    __le16  eh_max;     /* 当前节点最大条目数（inode 内联 = 4，磁盘块 = (4096-12)/12=340）*/
    __le16  eh_depth;   /* 树的深度（0 = 叶子节点，即 Extent 直接存在这里）*/
    __le32  eh_generation; /* 树的版本（用于检测并发修改）*/
};
```

**树的布局**（以 inode 内联为例）：

```
inode.i_data（60 字节 = 1 个 header + 4 个 extent/index）：

深度为 0（叶子节点，文件小，4 个 Extent 足够）：
  [header: magic=0xF30A, entries=2, max=4, depth=0]
  [extent: block=0,    len=128, start=12345]   ← 文件第 0-127 块 → 物理块 12345-12472
  [extent: block=128,  len=64,  start=67890]   ← 文件第 128-191 块 → 物理块 67890-67953
  [空]
  [空]

深度为 1（需要更多 Extent，叶子页在磁盘上）：
  [header: magic=0xF30A, entries=1, max=4, depth=1]
  [index: block=0, leaf=99999]   ← 指向物理块 99999（该块包含最多 340 个 Extent）
  [空] [空] [空]

    → 物理块 99999 的内容（叶子节点页）：
       [header: entries=340, max=340, depth=0]
       [extent: block=0,    len=32768, start=...] ← 128MB 的连续数据
       [extent: block=32768, len=...] ...
       [... 共 340 个 Extent ...]
```

### 3.3 Extent 树的操作：写入时的块分配

当进程向文件追加数据时，ext4 需要：

1. **查找（Find）**：在 Extent 树中查找文件末尾对应的位置（`ext4_find_extent`）
2. **扩展或插入**：如果末尾的 Extent 可以扩展（新分配的物理块紧接着上一个 Extent）→ 扩展 `ee_len`；否则插入一个新 Extent
3. **块分配**：调用块分配器（`ext4_mb_new_blocks`）分配新的物理块——多块分配器尽量分配连续的块，减少碎片

**延迟分配（Delayed Allocation）** 是 ext4 提升 Extent 质量的关键技术：

传统文件系统在 `write()` 写入数据时立即分配磁盘块，但此时只是小批量数据（用户可能还会继续写），分配的块可能零散。延迟分配将块分配推迟到脏页真正要写回磁盘时（`writepage`）——此时内核知道这次写 IO 的完整大小，可以一次性分配更多连续块，生成更大的 Extent，减少碎片。

```bash
# 验证延迟分配特性（ext4 默认启用）
tune2fs -l /dev/sda1 | grep "Filesystem features"
# Filesystem features: ext_attr resize_inode dir_index filetype extent ...
# "extent" 特性 = 启用了 Extent 树
# "delalloc" 挂载选项（默认开启）= 启用延迟分配

# 查看挂载选项
cat /proc/mounts | grep "sda1"
# /dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0
# 注意：delalloc 是默认选项，即使不显示也是启用的

# 禁用延迟分配（某些特殊场景需要，如实时数据分析工具）
mount -o remount,nodelalloc /dev/sda1 /
```

---

## 第 4 章 日志（JBD2）：崩溃一致性的保证

### 4.1 为什么需要日志：更新磁盘的原子性问题

向 ext4 写入一个新文件，需要更新多个磁盘数据结构：

1. 在 inode 位图中标记一个 inode 为已使用
2. 初始化 inode（写入权限、大小、时间戳、Extent 树根）
3. 在数据块位图中标记分配的数据块为已使用
4. 将实际数据写入数据块
5. 在父目录的数据中添加新的目录项（文件名 → inode 号）
6. 更新父目录的 inode（修改时间、大小）
7. 更新超级块中的空闲块数和空闲 inode 数

这 7 个步骤必须**原子完成**——任何中途断电都不能留下半完成的状态。但磁盘 IO 本质上是非原子的：每次只能写一个块，中途断电无法保证所有块都写完。

**没有日志时的问题**：

假设在步骤 3 完成（数据块已标记为"使用中"）、步骤 4 未完成时断电——重启后，数据块被标记为使用，但 inode 中没有对应的 Extent 指针。这个块就成了**孤立块（lost block）**：既不属于任何文件，又被标记为"已分配"。积累多了会导致磁盘空间泄漏，必须用 fsck 检查修复——而 fsck 需要扫描整个磁盘，对于大磁盘需要数小时。

### 4.2 日志的基本工作原理

**Write-Ahead Logging（WAL，预写日志）** 是关系数据库和文件系统共用的核心技术：

**在将任何元数据（或数据）写入其最终位置之前，先将变更记录到专门的日志区域**。日志写入成功（被磁盘持久化）后，才将变更写入实际位置。

崩溃恢复时：
- 如果日志**未提交**（日志记录不完整）：忽略这条日志，文件系统处于旧的一致状态
- 如果日志**已提交**（有完整的提交记录）：重放这条日志，将变更写入实际位置

```
日志区域的结构（循环日志，类似环形缓冲区）：

  ┌────────────────────────────────────────────────────┐
  │  [Transaction 1: COMMIT]                           │
  │    Descriptor Block → Data Block → Commit Block   │  ← 已提交，可以重放
  │  [Transaction 2: COMMIT]                           │
  │    Descriptor Block → Data Block → Commit Block   │  ← 已提交
  │  [Transaction 3: 未提交]                           │
  │    Descriptor Block → Data Block → ...（断电）     │  ← 忽略（未完整）
  │  [空闲空间...]                                     │
  └────────────────────────────────────────────────────┘
                           ↑                ↑
                     tail（最老）        head（最新写入位置）
```

### 4.3 JBD2 的三种日志模式

ext4 的日志子系统 JBD2（Journal Block Device 2）支持三种日志模式，在性能和安全性之间取得不同的权衡：

**模式一：data=journal（全数据日志）**

文件的元数据和数据都写入日志，然后再写入实际位置。

- **优点**：最强的一致性保证——即使在数据写入过程中断电，可以从日志完整恢复
- **缺点**：性能最差——每次写操作产生两倍磁盘 IO（先写日志，再写实际位置）
- **适用场景**：极端安全要求（如金融系统），几乎不在现代系统中使用

**模式二：data=ordered（有序日志，默认模式）**

只有元数据写入日志，**但保证数据块在元数据提交之前写入磁盘**。具体顺序：
1. 将数据块写入磁盘（文件数据的最终位置）
2. 数据写完后，将元数据变更记录到日志
3. 日志提交（Commit Block 写入日志）
4. 后台将元数据从日志写入实际位置（Checkpoint）

- **优点**：性能较好（数据只写一次，元数据写两次），同时保证了一致性：崩溃时，日志元数据要么未提交（忽略，文件系统处于旧状态），要么已提交（数据已在磁盘，重放元数据即可）
- **缺点**：相比 writeback 有额外的数据写顺序限制
- **适用场景**：绝大多数生产系统的最佳选择

**模式三：data=writeback（回写日志）**

只有元数据写入日志，数据块和元数据的写入顺序**不保证**。

- **优点**：性能最好——数据和元数据可以并行写，不互相等待
- **缺点**：崩溃后可能出现数据"空洞"——新文件的元数据（inode、目录项）已写入，但数据块可能还在旧内容（因为块刚从其他文件回收，新数据还未写入）。这不是文件系统不一致（fsck 不会报错），但文件内容可能损坏
- **适用场景**：数据库服务器（数据库自己通过 WAL 保证一致性，不需要文件系统的 ordered 语义）

```bash
# 查看当前的日志模式
mount | grep "ext4"
# /dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)
# 未显示 data= 选项时，默认是 data=ordered

# 更改日志模式（需要重新挂载）
mount -o remount,data=writeback /dev/sda1
# 或在 /etc/fstab 中配置：
# /dev/sda1  /  ext4  defaults,data=writeback  0  1
```

### 4.4 JBD2 的事务合并与提交时机

JBD2 不是每次文件操作都立即提交一个日志事务——它将多个文件操作合并到同一个**复合事务（Compound Transaction）**中，批量提交：

```
时间轴：
  t=0ms   进程 A：write() → 加入当前事务（running transaction）
  t=2ms   进程 B：mkdir() → 加入同一事务
  t=4ms   进程 C：write() → 加入同一事务
  t=5ms   提交超时（commit_interval=5s，但磁盘 IO 积累触发提前提交）
  t=5ms   事务关闭（Closing），新操作进入下一个事务
  t=6ms   JBD2 kthread 将事务写入日志（Descriptor Block + 元数据块）
  t=7ms   写入 Commit Block（带 checksum）→ 事务完成（Committed）
  t=...   后台 Checkpoint：将日志中的元数据写入实际位置
```

```bash
# JBD2 日志统计（/proc/fs/jbd2/<device>/info）
cat /proc/fs/jbd2/sda1-8/info
# 252 transaction, max 4098 blocks, logged 72564, max committing 40
# commit 252 times, 3002 ms total waited, 12 ms max wait
# 1 handles made dirty, 3 written out, 0 waiting for commit

# 关键字段解读：
# transaction：已完成的事务总数
# max wait：单次事务等待时间的最大值（毫秒）
# logged：写入日志的总块数
```

---

## 第 5 章 Flex BG：连续 IO 的性能保障

### 5.1 传统块组布局的 IO 问题

在传统的 ext2/ext3 布局中，每个块组都有自己的 inode 表，分散在磁盘各处。当顺序写入大文件时：

1. 写入文件数据（块组 0 的数据区）
2. 更新 inode（块组 0 的 inode 表，需要寻道）
3. 写入更多数据（下一个块组的数据区，需要寻道）
4. 更新下一个块组的 inode 表（需要寻道）

数据写入和 inode 更新交替进行，导致 HDD 磁头频繁在数据区和 inode 区之间来回寻道，严重影响顺序写性能。

### 5.2 Flex BG 的解法：元数据集中化

**Flex BG（Flexible Block Group，弹性块组）** 将多个传统块组合并为一个"超级块组"：超级块组中所有块组的**inode 表、块位图、inode 位图**集中存储在第一个块组，**其余块组完全用于数据**。

```
Flex BG（flex_bg_size = 16，将 16 个传统块组合并）：

传统布局（每个块组独立）：        Flex BG 布局：
  BG0: [管理结构][数据...]           BG0: [超级块][GDT][全部 inode 表][全部位图]
  BG1: [管理结构][数据...]           BG1: [数据块，全部！...............]
  BG2: [管理结构][数据...]           BG2: [数据块，全部！...............]
  BG3: [管理结构][数据...]           ...
  ...                                BG15:[数据块，全部！...............]
  BG15:[管理结构][数据...]
```

**Flex BG 对 IO 的影响**：

写入大文件时，数据块的写 IO 完全集中在 BG1-BG15（纯数据区），inode 更新集中在 BG0（元数据区）。在 BG0 完成元数据更新后，磁头不需要在元数据和数据之间频繁跳动，数据块的顺序写 IO 效率大幅提升。

```bash
# 查看 Flex BG 大小
tune2fs -l /dev/sda1 | grep "Flex block group"
# Flex block group size: 16   ← 16 个块组合并为一个 Flex BG

# mkfs 时设置 Flex BG 大小
mkfs.ext4 -G 32 /dev/sdb1   # 32 个块组组成一个 Flex BG（更大的连续数据区域）
```

---

## 第 6 章 ext4 目录的实现：htree（哈希树）

### 6.1 目录是特殊的文件

目录在 ext4 中是一种特殊的文件，其"数据"不是普通字节流，而是**目录项（Directory Entry）**的列表——每个目录项记录一个文件名及其对应的 inode 号：

```c
struct ext4_dir_entry_2 {
    __le32  inode;          /* 文件名对应的 inode 号 */
    __le16  rec_len;        /* 该条目的长度（包含对齐填充，用于跳到下一条目）*/
    __u8    name_len;       /* 文件名长度 */
    __u8    file_type;      /* 文件类型（1=普通文件, 2=目录, 7=符号链接...）*/
    char    name[];         /* 文件名（可变长度，最长 255 字节）*/
};
```

### 6.2 htree：大目录的高效查找

当目录文件只有几个条目时，线性扫描（遍历所有目录项）足够快。但当目录包含数万个文件（如 `/usr/lib`）时，线性查找效率低下（O(n)）。

ext4 的 `dir_index` 特性（默认启用）为大目录启用 **htree（哈希树，Hash Tree）**——一个两级哈希表，以文件名的哈希值为键，直接定位到对应的目录块：

```
htree 结构：
  目录文件第一个块 = 根节点（包含哈希区间 → 块号 的映射）
  其余块 = 叶子节点（存储实际目录项）

查找 "libc.so.6"：
  1. 计算 "libc.so.6" 的哈希值 = 0x12345678
  2. 在根节点中二分查找：hash 0x12345678 → 第 37 块
  3. 读取第 37 块（叶子节点），线性扫描找到 "libc.so.6"

时间复杂度：O(1) 块 IO（1-2 次磁盘读取），vs 线性扫描的 O(n) 块 IO
```

```bash
# 验证目录是否使用了 htree
debugfs -R "stat /usr/lib" /dev/sda1
# Inode: 12345  Type: directory  Flags: 0x81000  (INDEX = htree 启用)
```

---

## 第 7 章 ext4 生产调优

### 7.1 挂载选项调优

```bash
# /etc/fstab 中的 ext4 挂载选项优化示例

# 通用服务器：默认选项 + noatime
/dev/sda1  /  ext4  defaults,noatime  0  1
# noatime：关闭访问时间更新（每次 read 不需要更新 inode 的 atime）
# 提升：减少大量随机 IO（在 inode 上），对读多写少的场景显著有效

# 数据库服务器（如 MySQL）：
/dev/sdb1  /data  ext4  defaults,noatime,data=writeback,barrier=0  0  2
# data=writeback：不保证数据/元数据写入顺序（数据库自己保证一致性）
# barrier=0：关闭写屏障（write barrier），牺牲安全性换性能
#            注意：UPS 保护 + 有电池备份的 RAID 卡才能安全关闭 barrier

# 高并发写（如日志服务器）：
/dev/sdc1  /logs  ext4  defaults,noatime,commit=60  0  2
# commit=60：日志提交间隔 60 秒（默认 5 秒）
# 提升：减少日志提交频率，批量更大的事务，减少元数据 IO
# 代价：断电可能丢失最多 60 秒的数据
```

### 7.2 mkfs 时的格式化优化

```bash
# SSD 优化格式化（4KB 对齐 + 禁用不必要特性）
mkfs.ext4 \
    -E stride=8,stripe-width=8 \  # 对齐到 SSD 的内部块大小
    -b 4096 \                     # 4KB 块大小（SSD 页大小对齐）
    -i 65536 \                    # 每 64KB 分配一个 inode（对于大文件多的场景增大此值）
    -O ^has_journal \             # 禁用日志（仅限 tmpfs 或不需要一致性的场景）
    /dev/nvme0n1p1

# 大文件场景（如 Hadoop 数据节点，文件平均 128MB+）
mkfs.ext4 \
    -T largefile4 \  # 预设：每个 inode 代表 4MB，减少 inode 表大小，增大数据区
    -G 32 \          # 更大的 Flex BG
    /dev/sdb1

# 查看 mkfs 的 bigalloc 特性（大块分配，减少元数据）
mkfs.ext4 -O bigalloc -C 65536 /dev/sdc1
# bigalloc：以 16 个块（64KB）为最小分配单元，减少碎片和位图 IO
# 缺点：小文件浪费磁盘空间（一个 1 字节文件占用 64KB）
```

### 7.3 ext4 常见问题排查

```bash
# 文件系统只读（errors=remount-ro 触发）
# 查看内核日志
dmesg | grep "ext4\|EXT4"
# 常见原因：磁盘坏道、元数据损坏、日志提交失败

# 检查文件系统健康状态（offline，需要卸载或 live-CD）
fsck.ext4 -n /dev/sda1   # -n：只检查，不修复
# 如有问题：
fsck.ext4 -y /dev/sda1   # -y：自动回答 yes，自动修复

# inode 耗尽（"No space left on device" 但 df -h 显示磁盘有空间）
df -ih /
# Filesystem     Inodes IUsed IFree IUse% Mounted on
# /dev/sda1       1.2M  1.2M    0   100% /    ← inode 全部耗尽！

# 解决方案（无法在线扩展 inode 数量）：
# 1. 清理大量小文件（如 /tmp 下的临时文件）
# 2. 重新格式化，指定更大的 inode 数（-N 参数）

# 查找 inode 占用最多的目录
find / -xdev -type d | sort -t= -k2 -n | while read dir; do
    count=$(find "$dir" -maxdepth 1 | wc -l)
    echo "$count $dir"
done | sort -rn | head -20

# ext4 碎片化检查
e2fsck -f -n /dev/sda1 2>&1 | grep "fragmented"
# 或用 e4defrag（在线碎片整理）
e4defrag /data/bigfile.dat  # 整理单个文件的碎片
e4defrag /data/             # 整理整个目录
```

---

## 小结

ext4 的三大核心改进构成了其相对于前辈的核心竞争力：

**Extent 树**（取代三级间接块指针）：
- 用 `(logical_start, physical_start, length)` 三元组描述连续块区间
- 大文件只需少量 Extent，元数据 IO 从 O(文件大小) 降到 O(碎片数)
- inode 内联 4 个 Extent（深度=0），无需额外磁盘 IO；碎片多时退化为 B 树

**JBD2 日志**（崩溃一致性保证）：
- `data=ordered`（默认）：元数据记日志，数据先于元数据落盘，安全与性能的最佳平衡
- 事务合并提交（默认 5 秒间隔），批量 IO 效率高
- 崩溃恢复只需重放日志（秒级），告别漫长的 fsck

**Flex BG**（大文件 IO 性能）：
- 16 个块组合并，inode 表集中到第一个块组
- 数据区域连续，顺序写不受 inode 更新打断

下一篇 [[04 Page Cache 与脏页回写——Linux IO 的秘密缓冲层]] 将深入 Linux IO 性能的最核心机制：Page Cache 如何让几乎全部可用内存成为磁盘缓冲区，脏页的生命周期管理，以及 direct IO（`O_DIRECT`）如何绕过 Page Cache，及其适用场景。
