---
title: "XFS 文件系统深度解析——B+ 树与日志架构"
date: 2026-03-02
tags: [Linux, 文件系统, XFS, 分配组, AG, B+树, 日志, 延迟分配, Speculative Preallocation, RHEL, CentOS]
aliases: ["XFS文件系统原理", "XFS AG分配组", "XFS B+树", "XFS日志", "XFS延迟分配"]
---

**摘要：**

XFS 是 RHEL 7+、CentOS 7+、Rocky Linux、AlmaLinux 的默认文件系统，也是众多 Hadoop 数据节点、高性能计算集群、视频存储服务器的首选。它由 SGI 于 1993 年为 IRIX 操作系统设计，2001 年移植到 Linux，历经 30 年演进，在以下场景表现出超过 ext4 的明显优势：大文件（TB 级）、高并发写、超大目录（百万文件级）、在线扩容。XFS 的核心设计哲学与 ext4 的"块组"方案截然不同——它用**分配组（AG，Allocation Group）** 实现并发，每个 AG 是一个独立的文件系统子单元，有自己的空闲空间 B+ 树和 inode B+ 树，多个 CPU 可以并行在不同 AG 中分配块和 inode，彻底消除了全局锁争用。本文从 XFS 的 AG 分组架构出发，深入解析 XFS B+ 树家族（空闲块树、inode 树、目录树、Extent 树）的结构与查询逻辑，XFS 日志（XLOG）相对于 ext4 JBD2 的设计差异，以及**延迟分配（Delayed Allocation）+ 投机预分配（Speculative Preallocation）** 如何从根本上减少文件碎片，最后梳理 XFS 在生产中最重要的调优参数和常见故障排查手段。

---

## 第 1 章 XFS 的设计背景：为什么需要不同于 ext4 的方案

### 1.1 ext4 的并发瓶颈

[[03 ext4 深度解析——日志、Extent 树与 Flex BG]] 中提到，ext4 的块组（Block Group）布局中，**块组描述符表（GDT）** 是全局的——分配一个新块或 inode 时，需要扫描 GDT 找到有空闲空间的块组，然后操作那个块组的位图。当多个进程同时创建文件或写入数据时，这个全局 GDT 成为锁竞争的热点。

ext4 的 Flex BG 和延迟分配虽然缓解了部分问题，但本质上 ext4 的分配仍然存在全局协调的开销，在以下场景表现不佳：

- **高并发创建小文件**（如 Nginx 日志轮转、Java 应用临时文件）：频繁的 inode 分配
- **并行写入大文件**（如 HDFS 多数据块并行写）：频繁的数据块分配
- **超大目录**（如单目录 100 万文件）：ext4 的 htree 在极大目录下查找性能下降

XFS 的 AG 分组架构从设计伊始就以并发为首要目标。

### 1.2 XFS 的核心设计哲学

XFS 的设计哲学可以用三个词概括：**并发、B+ 树、日志**。

- **并发**：通过 AG 分组，将文件系统分割为多个独立的子单元，多 CPU 并行操作不同 AG，无全局锁
- **B+ 树**：不论是空闲空间管理、inode 追踪、目录项索引、还是文件 Extent 描述，XFS 一律用 B+ 树（而 ext4 对这些用位图、链表、htree 等各种不同数据结构），保证所有操作的 O(log n) 性能
- **日志（XLOG）**：写操作先写日志，日志提交后才写实际位置，与 ext4 的 JBD2 类似但实现更彻底——XFS 日志覆盖的范围更广，包括目录操作和 Extent 分配

### 1.3 XFS vs ext4：各自的优势领域

| 特性 | XFS | ext4 |
|-----|-----|------|
| 默认文件系统 | RHEL 7+，CentOS 7+，SUSE | Ubuntu 16.04+，Debian |
| 大文件性能 | 优秀（AG 并行 + Speculative Prealloc）| 良好（Flex BG + 延迟分配）|
| 小文件性能 | 稍弱（B+ 树开销略高于位图）| 良好（位图分配快）|
| 高并发写 | 优秀（多 AG 并行）| 良好（单 AG 内并发有限）|
| 超大目录 | 优秀（B+ 树目录索引）| 良好（htree）|
| 在线扩容 | 支持（`xfs_growfs`）| 支持（`resize2fs`）|
| 在线缩容 | **不支持**（设计限制）| 支持（`resize2fs` 缩小）|
| fsck 速度 | 快（`xfs_repair`，并行）| 中（`fsck.ext4`）|
| 最大文件系统 | 8 EiB（64 位），实测 16 TiB+| 1 EiB |
| 崩溃恢复 | 秒级（日志重放）| 秒级（日志重放）|

> [!note] 设计哲学：XFS 不可缩容
> XFS 从设计上就不支持在线或离线缩小文件系统大小。原因在于：XFS 在整个磁盘分区的末尾分配 AG，并在 AG 中任意位置存储数据。如果要缩小文件系统，必须将末尾 AG 的所有数据移走，但 XFS 没有实现这个"数据迁移"操作——这是 XFS 为追求最大并发性能而做出的设计取舍。这也是选择文件系统时需要权衡的：如果你的场景需要灵活调整分区大小，ext4 更合适；如果需要最大性能且分区大小固定，XFS 更优。

---

## 第 2 章 AG（分配组）：XFS 并发的基石

### 2.1 AG 是什么

**AG（Allocation Group，分配组）** 是 XFS 将磁盘分区划分成的等大小子区域。每个 AG 是一个**完全自包含的文件系统子单元**，拥有：

- 自己的超级块（AG 超级块，记录本 AG 的配置）
- 自己的空闲块 B+ 树（两棵：一棵按块号排序，一棵按块大小排序）
- 自己的 inode B+ 树（记录本 AG 中已分配的 inode）
- 自己的 unlinked inode 链表（记录已删除但仍被进程打开的文件）

操作一个 AG 内的元数据（分配块、分配 inode、更新目录项），只需要锁住那个 AG——**不同 AG 的操作完全并行，无需协调**。

```bash
# 查看 XFS 的 AG 信息
xfs_info /dev/sda1
# meta-data=/dev/sda1          isize=512    agcount=4, agsize=65536000 blks
#                              sectsz=512   attr=2, projid32bit=1
#                              crc=1        finobt=1, sparse=1, rmapbt=0
#          =                   reflink=1
# data     =                   bsize=4096   blocks=262144000, imaxpct=25
# ...
# 解读：
# agcount=4    ← 4 个 AG
# agsize=65536000 blks  ← 每个 AG 约 65M 个块（256 GB）

# 使用 xfs_db 查看 AG 0 的超级块
xfs_db -r /dev/sda1 -c "sb 0" -c "print"
# uuid = xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# magicnum = 0x58465342  ← XFS 魔数
# blocksize = 4096       ← 块大小
# dblocks = 65536000     ← AG 的总数据块数
# agblocks = 65536000    ← AG 的块数（同上）
# agcount = 4            ← 全局 AG 数量
```

### 2.2 AG 的大小选择

AG 大小在 `mkfs.xfs` 时确定，默认值由内核根据磁盘总大小自动计算：

| 磁盘大小 | 典型 AG 数量 | AG 大小 |
|---------|------------|--------|
| < 1 TB | 4 | ~250 GB |
| 1-10 TB | 8 | ~1.25 GB |
| > 10 TB | 16+ | ~4 GB |

**AG 大小的权衡**：
- **AG 太小**：AG 数量多，锁竞争减少，但每个 AG 内可用空间小，大文件无法在单 AG 内连续分配，产生碎片
- **AG 太大**：AG 数量少，多 CPU 并发时可能多个 CPU 争用同一 AG 的锁

对于现代多核服务器（16-64 核），推荐 AG 数量 ≥ CPU 核数，以充分发挥并行分配的优势：

```bash
# 格式化时手动指定 AG 大小（单位：块数）
mkfs.xfs -d agsize=1g /dev/sdb1    # 每个 AG 1 GB（适合多核高并发）
mkfs.xfs -d agcount=16 /dev/sdb1   # 指定 16 个 AG
```

---

## 第 3 章 XFS 的 B+ 树家族

### 3.1 为什么 XFS 用 B+ 树而不是位图

ext4 用位图（Bitmap）管理空闲块和 inode——位图简单、查找 O(n)（最坏情况扫描整个位图），但在块组较大时（128MB），最坏情况下需要扫描 `128MB/4KB/8=4096` 字节（1 个块）。

XFS 对所有元数据一律使用 **B+ 树**，原因：

1. **更快的任意查询**：B+ 树支持按任意条件（"找大小 ≥ N 的空闲块"、"找 LBA X 后的第一个空闲块"）的 O(log n) 查询，而位图只能顺序扫描
2. **更好的大空间处理**：当 AG 很大（数 GB）时，位图本身就需要几百 KB，而 B+ 树的大小与已分配项数成比例（空 AG 几乎不占空间）
3. **天然支持并发**：B+ 树的节点级锁使得多个操作可以并发修改树的不同部分，而位图需要字节级甚至位级的锁

### 3.2 空闲块 B+ 树（Free Space B+ Trees）

每个 AG 有**两棵空闲块 B+ 树**，共同描述该 AG 内所有未分配的磁盘块区间：

**树 1（bno tree）**：以空闲块区间的**起始块号（Block Number）** 为键，按物理位置排序。用于查找"从某个块号开始的第一个空闲区间"（用于顺序分配，减少碎片）。

**树 2（cnt tree）**：以空闲块区间的**长度（Count）** 为键，按大小排序。用于查找"大小 ≥ N 的空闲区间"（用于分配指定大小的连续区间）。

```
AG 0 的空闲块状态（假设）：
  已分配：块 0-999（超级块、AG 头部元数据）
  空闲：  块 1000-5000（4001 个块连续空闲）
  已分配：块 5001-6000（某文件的数据）
  空闲：  块 6001-7000（1000 个块）
  ...

bno tree（按起始块号排序）：
  [1000, len=4001]
  [6001, len=1000]
  [8001, len=3000]
  ...

cnt tree（按大小排序）：
  [len=1000, start=6001]
  [len=3000, start=8001]
  [len=4001, start=1000]
  ...

分配 2000 个连续块：
  查 cnt tree：找到 len >= 2000 的最小区间 → [len=3000, start=8001]
  从 8001 开始分配 2000 个块：8001-10000
  更新两棵树：将 [8001, 3000] 改为 [10001, 1000]
```

### 3.3 inode B+ 树（Inode B+ Trees）

ext4 将 inode 存储在固定大小的 inode 表（inode table）中，每个块组的 inode 数量在 `mkfs` 时固定。XFS 用 B+ 树动态管理 inode：

**inobt（inode B+ tree）**：记录 AG 内所有已分配的 inode 块区间（以 inode 号为键），用于快速查找"分配第一个空闲 inode"和"释放一个 inode"。

**finobt（free inode B+ tree）**，Linux 3.16 引入：只记录有空闲 inode 的块区间（整块 inode 全部用完的不在此树中）。这使得分配新 inode 只需查询 finobt（通常只有少量节点），而不需要遍历整个 inobt。

```bash
# 查看 inode B+ 树信息
xfs_db -r /dev/sda1 -c "agi 0" -c "print"
# count = 12288          ← AG 0 中已分配的 inode 数
# freecount = 1234       ← AG 0 中空闲的 inode 数
# root = 3               ← inobt 的根节点块号
# fino_root = 5          ← finobt 的根节点块号
```

**XFS inode 的动态分配**：

与 ext4 不同，XFS 的 inode 不预先分配固定数量——当 inode 不足时，XFS 从空闲块中动态分配新的 inode 块（每个 inode 块包含 64 个 inode，inode 大小默认 512 字节）。这意味着 XFS **不会出现 ext4 那种"磁盘空间还有但 inode 耗尽"的问题**——只要磁盘有空间，就能分配新 inode。

```bash
# ext4 中查看 inode 使用情况
df -i /
# Filesystem     Inodes IUsed IFree IUse% Mounted on
# /dev/sda1       2621440  1234560  1386880  47%  /
# 如果 IUse% = 100%，即使磁盘有空间也无法创建文件！

# XFS 不会有这个问题——inode 按需分配
# 但可以通过 imaxpct 参数限制 inode 最大占用磁盘的比例
xfs_info /dev/sda1 | grep imaxpct
# imaxpct=25  ← inode 最多占用磁盘总空间的 25%
```

### 3.4 Extent 列表与 B+ 树：文件数据块的映射

XFS 描述文件数据块位置的方式与 ext4 的 Extent 树类似，但细节不同：

**小文件（Extents 较少）**：Extent 列表直接内联在 XFS inode 的数据区（inode data fork）中，无需额外磁盘 IO。每个 XFS Extent 用 128 位（16 字节）描述：

```c
/* XFS Extent 的 128 位编码（xfs_bmbt_rec）*/
/* 高 64 位：*/
/*   bit 63: flag（0=normal, 1=unwritten/预分配但未初始化）*/
/*   bit 54-62: 文件逻辑块号的高 9 位 */
/*   bit 21-53: 物理块号（AG 编号 + AG 内偏移）*/
/*   bit 0-20:  长度（连续块数，最大 2^21=2MB 个块 = 8GB 连续区间）*/
```

**大文件（Extents 超过 inode 内联容量）**：Extent 列表升级为 B+ 树（bmbt，Block Map B+ Tree），以文件逻辑块号为键，存储在独立的磁盘块中。

```bash
# 查看文件的 Extent 信息
xfs_bmap -v /data/bigfile
# /data/bigfile:
# EXT: FILE-OFFSET      BLOCK-RANGE      AG AG-OFFSET        TOTAL FLAGS
#   0: [0..262143]      1048576..1310719  0  (1048576..1310719)  262144 000000
#   1: [262144..524287] 2097152..2359295  1  (1..262143)         262144 000000
# 两个 Extent，分别在 AG 0 和 AG 1（并行分配到不同 AG！）

# Extent 数量（碎片化程度）
xfs_db -r /dev/sda1 -c "inode 128" -c "print core.nextents"
# core.nextents = 3   ← 该文件有 3 个 Extent
```

---

## 第 4 章 延迟分配与投机预分配：碎片优化的双剑合璧

### 4.1 延迟分配（Delayed Allocation）

XFS 的延迟分配（Delayed Allocation，delalloc）与 ext4 的同名特性思路相同：**`write()` 写入 [[Page Cache]] 时不立即分配磁盘块，等到脏页真正要写回磁盘时才分配**。

```
传统分配（无延迟）：
  write(buf, 1MB) → 立即分配 1MB 的磁盘块 → 更新 Extent 树 → 数据写入 Page Cache
  ↓ 结果：磁盘块立即分配，但可能分配在碎片化的位置

延迟分配：
  write(buf, 1MB) → 数据写入 Page Cache
                  → Extent 树中记录"保留 1MB"（speculative reservation，非实际分配）
  ... 进程继续写 ...
  write(buf, 1MB) → 数据继续写入 Page Cache
                  → "保留 2MB"（累计）
  ...（等到脏页回写时）...
  writeback → 一次性分配 8MB 连续磁盘块（内核看到累计 8MB 的写入）
             → 分配质量远好于每次写 1MB 时分配一次
```

延迟分配的好处：内核等待更多数据积累后再分配，更容易找到连续的大块空闲空间，减少碎片。

### 4.2 投机预分配（Speculative Preallocation）

XFS 在延迟分配的基础上更进一步——**主动预分配比当前写入量更多的磁盘空间**，为未来的追加写留出余地：

**工作原理**：当 XFS 检测到一个文件正在增长（有持续的追加写操作），它会在分配 Extent 时多分配一些额外空间（**Speculative Extent**），这部分空间被标记为"预分配但未初始化（Unwritten Extent）"。

```
文件追加写场景：

第一次写：write 4MB 数据
  XFS 实际分配：8MB（4MB 实际 + 4MB 投机预分配）
  Extent 树：[logical 0..1023, physical 5000..6023, flags=UNWRITTEN 1024..2047]
                                                   ↑ 后 4MB 标记为 unwritten（未初始化）

继续写：write 3MB 数据（紧接着上次写的位置）
  发现已预分配的 unwritten 空间足够 → 直接使用，无需额外分配！
  将 unwritten 区间标记为普通 Extent

结果：文件的前 7MB 完全连续，零碎片
```

**投机预分配量的动态调整**：

XFS 根据文件当前大小动态计算预分配量：
- 文件 < 1GB：预分配量 = 当前已写大小（翻倍策略）
- 文件 1-8GB：预分配 = 512MB
- 文件 > 8GB：预分配 = 1GB

```bash
# 查看 XFS 的投机预分配配置
xfs_info /dev/sda1 | grep allocsize
# （默认不显示，allocsize 是挂载选项）

# 设置固定的投机预分配大小（挂载选项）
mount -o allocsize=256m /dev/sda1 /data
# 对于 Hadoop 数据块（默认 128MB），推荐 allocsize=256m

# 查看已分配但未初始化的预分配空间
xfs_bmap -vp /data/growing_file
# FLAGS 列中的 'u' 表示 unwritten（预分配但未初始化）
```

> [!warning] 生产避坑：投机预分配导致"磁盘空间虚高"
> XFS 的投机预分配会为正在写入的文件预留额外磁盘空间——这部分空间在文件系统中显示为"已使用"，但实际上文件内容还没有写满这些块。如果多个进程同时写大文件，磁盘使用量会突然飙高（超过实际数据量），可能触发磁盘告警。解决方法：在磁盘告警时检查是否有大量写操作正在进行；写完后预分配空间会被自动回收（`xfs_fsr` 整理或文件关闭时自动收缩）。

---

## 第 5 章 XFS 日志（XLOG）：与 JBD2 的异同

### 5.1 XLOG 的基本设计

XFS 的日志子系统称为 **XLOG**，基本思想与 ext4 的 JBD2 相同——写前日志（WAL），先写日志再写实际位置。但 XLOG 有一些重要的设计差异：

**差异 1：日志覆盖范围更广**

JBD2 默认只记录元数据（`data=ordered` 模式）。XLOG 记录所有文件系统元数据操作，包括：
- inode 更新
- 目录操作（创建、删除、重命名）
- Extent 分配和释放
- AG 空闲块 B+ 树更新

**差异 2：内部日志 vs 外部日志**

XFS 支持将日志存储在独立的设备上（**外部日志**），与数据分离：

```bash
# 创建使用外部日志的 XFS 文件系统
# /dev/sdb = 数据设备，/dev/sdc = 日志设备（高速 SSD 或 NVMe）
mkfs.xfs -l logdev=/dev/sdc,size=1g /dev/sdb
mount -o logdev=/dev/sdc /dev/sdb /data
```

**为什么要分离日志？**

日志写入是**顺序写、高频率、小 IO**——将日志放在 NVMe 上，数据放在大容量 HDD 上，可以用 NVMe 的低延迟加速日志提交，同时用 HDD 的大容量存储数据，兼顾性能和容量。

**差异 3：日志大小**

XFS 的日志大小范围：512 KB ~ 2 GB（大容量磁盘推荐大日志）。日志太小的问题：如果单个事务（如重命名操作）的元数据变更量超过日志大小，XFS 会 panic——这是 XFS 生产中最常见的故障之一。

```bash
# 检查日志大小
xfs_info /dev/sda1 | grep "log ="
# log     =internal          bsize=4096   blocks=5120, version=2
#          =                 sectsz=512   sunit=0 blks, lazy-count=1
# blocks=5120 = 5120 * 4096 = 20 MB 的日志

# 建议日志大小（经验值）
# 小磁盘（< 100GB）：默认即可（约 10-30 MB）
# 中等磁盘（100GB - 1TB）：128 MB
# 大磁盘（> 1TB）：256 MB - 1 GB

# 如果遇到 "XFS: log size 10240 blocks too small" 错误，需要重新格式化并增大日志
mkfs.xfs -l size=256m /dev/sdb1
```

### 5.2 XLOG 的检查点（Checkpoint）机制

XFS 日志是一个循环的环形缓冲区，已提交的日志需要定期清除（**Checkpoint**），才能为新日志腾出空间：

```
XFS 日志循环示意（日志大小 = 10 个 block）：

  ┌─────────────────────────────────────────────────────┐
  │ T1[C] │ T2[C] │ T3[C] │ T4[C] │ T5   │ ←head     │
  │  ↑    |                                             │
  │ tail（等待 Checkpoint）                              │
  └─────────────────────────────────────────────────────┘

  T1-T4：已提交（[C] = Committed）
  T5：正在写入的事务

  Checkpoint 过程：
    T1 中的元数据已被写入实际位置（Checkpoint 完成）
    → tail 移动到 T2 的位置，T1 的日志空间被释放

  如果日志写满但 Checkpoint 太慢（元数据写回慢），
  XFS 会强制阻塞（停止接受新写操作），等待 Checkpoint
  → 这是 XFS 在 HDD 上写性能可能突然下降的原因
```

---

## 第 6 章 XFS 的目录实现

### 6.1 XFS 目录的四种格式

XFS 根据目录包含的文件数动态选择目录格式，从简单格式升级到复杂格式：

**格式一：Shortform（短格式）**，文件 ≤ 约 10 个：
所有目录项直接内联在 inode 的数据区中，不需要任何数据块。单次 IO 就能读取整个目录。

**格式二：Block（块格式）**，文件 10-几百个：
目录内容存储在一个 4KB 的数据块中，包含：目录项数组 + 哈希表（用于按文件名快速查找）。

**格式三：Leaf（叶子格式）**，文件几百到数万个：
目录内容分散到多个数据块，并有一个独立的"叶子块"存储哈希索引（按名字哈希 → 数据块号的映射）。

**格式四：Node（节点格式）**，文件数万到百万+：
升级为完整的 B+ 树索引，支持 O(log n) 查找。XFS 在这个格式上的表现远超 ext4 的 htree（ext4 htree 是两级哈希，XFS Node 是完整 B+ 树）。

```bash
# 验证超大目录性能（在 XFS 上创建 100 万文件的目录）
mkdir /data/million_files
time for i in $(seq 1 1000000); do touch /data/million_files/file_$i; done
# XFS：约 120 秒（B+ 树插入 O(log n)）
# ext4：约 180 秒（htree 在极大目录下性能下降）

# 单次 ls 查找特定文件
time ls /data/million_files/file_999999
# XFS：< 1ms（B+ 树查找）
# ext4：< 1ms（htree 查找，但内存压力大时慢）
```

---

## 第 7 章 XFS 生产运维

### 7.1 常用监控命令

```bash
# 查看 XFS 文件系统状态（运行统计）
xfs_info /data          # 查看挂载点的文件系统配置
xfs_db -r /dev/sda1 -c "statfs" -c "print"  # 详细统计

# 实时 IO 统计（xfs_io 工具）
xfs_io -c "statfs" /data
# 查看文件的 Extent 碎片情况
xfs_bmap -v /data/bigfile

# 整体文件系统碎片报告
xfs_db -r /dev/sda1 -c "freesp" -c "print"
# 输出空闲块的大小分布，碎片化严重时会有很多小区间

# 查看磁盘空间使用（按目录树统计）
xfs_quota -x -c "df -h" /data
xfs_quota -x -c "report" /data   # quota 报告（如启用了 quota）
```

### 7.2 XFS 碎片整理

与 ext4 类似，XFS 也支持在线碎片整理（`xfs_fsr`，File System Reorganizer）：

```bash
# 整理单个文件的碎片（在线，不需要卸载）
xfs_fsr /data/fragmented_file

# 整理整个文件系统（按碎片化程度排序，先整理最碎的文件）
xfs_fsr /data

# 查看整理效果（整理前后的 Extent 数量）
xfs_bmap -v /data/bigfile  # 整理前
xfs_fsr /data/bigfile
xfs_bmap -v /data/bigfile  # 整理后
```

### 7.3 XFS 修复与故障排查

```bash
# XFS 崩溃恢复（系统重启后自动执行）
# XFS 会在挂载时自动重放日志，通常几秒内完成

# 如果挂载失败（"Structure needs cleaning" 错误）
# 需要离线修复：
umount /dev/sda1          # 先卸载
xfs_repair /dev/sda1      # 修复（比 ext4 的 fsck 快得多）
mount /dev/sda1 /data

# xfs_repair 的常见选项
xfs_repair -n /dev/sda1   # -n：只检查，不修复（dry run）
xfs_repair -L /dev/sda1   # -L：强制清零日志（当日志本身损坏时的最后手段，可能丢失少量数据）

# 常见错误：XFS log recovery failed
# 原因 1：日志太小（元数据操作频繁，日志溢出）
# 原因 2：磁盘坏道（日志区块损坏）
# 原因 3：突然断电时日志写到一半

# 查看 XFS 内核错误日志
dmesg | grep -i "xfs"
# XFS (sda1): log mount/recovery failed: error -5
# → -5 = EIO（磁盘 IO 错误），检查磁盘健康状况
# → smartctl -a /dev/sda

# 在线扩容（XFS 支持在线扩容，不需要卸载）
# 先扩容底层块设备（LVM 或分区），再扩容 XFS
lvextend -L +100G /dev/mapper/data-vg
xfs_growfs /data   # 在线扩容（自动使用新增空间）
```

### 7.4 XFS 格式化最佳实践

```bash
# 通用服务器（大文件，高吞吐）
mkfs.xfs \
    -d agcount=16 \              # 16 个 AG，适合 16 核服务器
    -l size=256m \               # 256 MB 日志
    -f \                         # 强制格式化
    /dev/sdb1

# Hadoop 数据节点（大文件，128MB 数据块）
mkfs.xfs \
    -d agcount=16,allocsize=256m \  # 投机预分配 256MB（2 个数据块）
    -l size=512m \
    /dev/sdb1
mount -o noatime,allocsize=256m /dev/sdb1 /data

# NVMe SSD（高 IOPS，小文件混合）
mkfs.xfs \
    -d agcount=8,sunit=1,swidth=1 \  # sunit/swidth=1：禁用 RAID 对齐优化
    -l size=128m \
    /dev/nvme0n1p1
mount -o noatime,nobarrier /dev/nvme0n1p1 /data
# nobarrier：NVMe 有持久写缓存，可以关闭 write barrier
# 注意：只在 NVMe 有断电保护（UPS 或电池备份）时才关 barrier
```

---

## 小结

XFS 与 ext4 的核心设计差异归结为一点：**XFS 以并发为第一优先级，ext4 以兼容性为第一优先级**。

**XFS 的三大支柱**：

1. **AG 分组**：磁盘被分割为多个独立的 AG，多 CPU 并行操作不同 AG，消除全局锁竞争。代价：AG 大小固定，文件系统不可缩容。

2. **B+ 树统一数据结构**：空闲块、inode、目录项、文件 Extent 全部用 B+ 树管理。O(log n) 性能在所有规模下可预测，尤其对大目录、海量 inode 场景优势明显。

3. **延迟分配 + 投机预分配**：写操作积累后批量分配磁盘块，并主动预留连续空间，使大文件几乎无碎片。代价：磁盘剩余空间显示可能偏小（预分配占用）。

**选型建议**：
- **高性能服务器（RHEL/CentOS 生态）** → XFS（默认，生态完善）
- **需要灵活扩缩容的云主机** → ext4（支持缩容）
- **超大文件（TB 级）、高并发写** → XFS 明显优于 ext4

下一篇 [[08 存储栈性能调优——从 fio 到 iotop 的全套方法论]] 将综合运用前七篇的知识，从实战角度讲解如何系统性地诊断和优化 Linux 存储性能：`fio` 基准测试参数详解、`iostat`/`iotop`/`blktrace` 的使用与分析、读写放大的根源与消除，以及数据库、日志、HDFS 等不同场景的专项调优方案。
