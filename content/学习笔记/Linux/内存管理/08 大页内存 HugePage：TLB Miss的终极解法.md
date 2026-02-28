---
title: "大页内存 HugePage：TLB Miss的终极解法"
date: 2026-02-28
tags: [Linux, 内存管理, HugePage, TLB, THP, 透明大页, 性能优化]
aliases: [大页内存, HugePage, THP, 透明大页]
---

# 大页内存 HugePage：TLB Miss的终极解法

**摘要：**

[[虚拟内存：为什么每个进程都以为自己独占内存|第01篇]]介绍 TLB 时提到，TLB Miss 会触发页表遍历，代价是几十到几百个 CPU 周期。对于内存访问密集型应用（数据库、大数据计算、JVM），TLB Miss 可以占到程序总运行时间的 10%~30%。**大页内存（HugePage）**通过增大单个页帧的大小（从 4KB 到 2MB 或 1GB），让同等内存容量只需要更少的 TLB 条目来覆盖，从根本上降低 TLB Miss 率。本文深入剖析 HugePage 的工作原理：为什么 4KB 的默认页大小在大内存时代已成瓶颈、HugePage 的两种实现方式（显式大页与透明大页 THP）各自的适用场景与局限、THP 的 khugepaged 后台合并机制与延迟抖动问题、以及在 MySQL/Redis/Java/Hadoop 等不同技术栈中的最佳配置实践。

---

## 第 1 章 TLB 容量的瓶颈

### 1.1 TLB 容量与大内存时代的矛盾

TLB 是 MMU 内部的硬件缓存，存储最近使用的虚拟→物理地址映射，命中时直接输出物理地址，不需要访问内存中的页表。但 TLB 容量极为有限：

| TLB 类型 | 典型容量（条目数）| 覆盖内存（4KB 页） |
|---------|--------------|-----------------|
| L1 dTLB | 64 条目 | 256KB |
| L1 iTLB | 128 条目 | 512KB |
| L2 TLB | 1024~4096 条目 | 4MB~16MB |
| L3 TLB（部分 CPU）| 8192 条目 | 32MB |

即便是最大的 L3 TLB（8192 条目），在 4KB 页的情况下只能覆盖 **32MB** 的内存。而现代服务器应用动辄需要几十 GB 的工作内存集：MySQL InnoDB Buffer Pool 通常 32GB~256GB，Redis 单实例 8GB~64GB，JVM 堆 4GB~16GB。

当工作集远超 TLB 覆盖范围时，每次内存访问几乎都会 TLB Miss，触发页表遍历——x86-64 四级页表需要 4 次内存访问（PGD→PUD→PMD→PTE），代价约 150~300 个 CPU 周期。TLB Miss 率在大堆 JVM 上实测可达 10%~30% 的 CPU 周期浪费。

### 1.2 大页的核心思路：用更大的粒度减少 TLB 条目需求

**大页（HugePage）**的解决思路直接而有效：**把单个页帧的大小从 4KB 增加到 2MB（甚至 1GB），同样 4096 个 TLB 条目就能覆盖 4096 × 2MB = 8GB 的内存范围**，是 4KB 页时的 512 倍。

| 页大小 | L2 TLB（4096条目）覆盖内存 | 覆盖 256GB 工作集所需条目 |
|--------|--------------------------|--------------------------|
| 4KB | 16MB | 67,108,864 条目（远超硬件）|
| 2MB | 8GB | 131,072 条目 |
| 1GB | 4TB | 256 条目（完全能容纳）|

1GB 大页时，L2 TLB 可覆盖整个 256GB 工作集，TLB Miss 率接近零。

大页还同时减少了页表遍历层数：
- 4KB 页：4 级页表（4 次内存访问）
- 2MB 页：PMD 层直接映射，3 次内存访问
- 1GB 页：PUD 层直接映射，2 次内存访问

---

## 第 2 章 显式大页（Static HugePage）

### 2.1 工作方式与配置

显式大页需要管理员提前预留，应用通过 `MAP_HUGETLB` 显式使用：

```bash
# 预留 2048 个 2MB 大页 = 4GB
echo 2048 > /proc/sys/vm/nr_hugepages

# 查看大页状态
cat /proc/meminfo | grep -i huge
# HugePages_Total: 2048  HugePages_Free: 512  Hugepagesize: 2048 kB
```

应用程序使用大页：

```c
void *addr = mmap(NULL, 4UL << 30,    /* 4GB */
                  PROT_READ | PROT_WRITE,
                  MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                  -1, 0);
```

Oracle Database 使用 `SHM_HUGETLB` 分配 SGA；MySQL InnoDB 通过 `innodb_huge_pages=ON` 使用大页。

### 2.2 1GB 超大页

需要 CPU 支持 `pdpe1gb`，且只能在内核启动参数中配置（不能运行时修改）：

```bash
# /etc/default/grub 中 GRUB_CMDLINE_LINUX 添加：
# hugepagesz=1G hugepages=128  （预留 128 个 1GB 大页 = 128GB）
```

> [!warning] 生产避坑
> 显式大页预留后**永久占用物理内存**，不参与 LRU 回收，空闲大页也不能被 Page Cache 使用。预留过多导致的内存浪费可能比 TLB Miss 更影响整体性能。务必根据应用实际需求精确配置。

---

## 第 3 章 透明大页（THP）

### 3.1 THP 解决的核心问题

显式大页对应用有侵入性、需要手动规划、内存碎片化后预留可能失败。**透明大页（Transparent HugePage，THP，Linux 2.6.38 引入）**在不修改应用程序的前提下，让内核自动将普通 4KB 页聚合为 2MB 大页，对应用完全透明。

THP 只支持 **2MB 大页**，只作用于**匿名内存**（堆、栈、匿名 mmap），不作用于文件页。

### 3.2 THP 配置

```bash
# 查看和配置工作模式
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never

# always：对所有匿名内存自动尝试 THP（默认）
# madvise：只在应用通过 madvise(MADV_HUGEPAGE) 标记的区域使用
# never：完全禁用 THP

echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
```

### 3.3 khugepaged：后台合并线程

**khugepaged** 负责在后台异步将 4KB 小页合并成 2MB 大页。

合并过程：
1. 从伙伴系统申请连续 2MB 物理内存（order=9 的大块）
2. `memcpy` 将 512 个 4KB 页内容拷贝到新的 2MB 页帧
3. 原子更新 PMD 条目为大页映射，刷新 TLB
4. 释放原来 512 个 4KB 页帧

```bash
# 调整 khugepaged 扫描频率
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed
# 累计合并的大页数
```

---

## 第 4 章 THP 的暗面：延迟抖动

### 4.1 THP 引入延迟的两个根因

**根因一：合并时的停顿**。合并 512 个 4KB 页为 2MB 大页时：
- 需要找到连续 2MB 物理内存（可能触发内存紧缩，耗时 1~100ms）
- 2MB 内存拷贝（约 50~200μs）
- 短暂持有 `mmap_sem` 写锁

**根因二：Fork + COW 内存放大**。`fork()` 后父子进程共享大页，当父进程修改数据时触发 COW，**每次修改哪怕只有几字节，也要复制整个 2MB 大页**，而非只复制被修改的 4KB 小页。COW 代价放大 512 倍。

### 4.2 Redis 为何强烈要求禁用 THP

Redis 官方文档明确要求禁用 THP：

```
WARNING you have Transparent Huge Pages (THP) support enabled in your kernel.
This will create latency and memory usage issues with Redis.
```

Redis 持久化（RDB/AOF rewrite）通过 `fork()` 子进程做快照，持续时间可能达数十秒。在此期间：
- **使用 4KB 页**：父进程每次写操作 COW 拷贝 4KB，代价小
- **使用 THP**：父进程每次写操作 COW 拷贝 2MB，代价大 512 倍

实测数据：一台 64GB Redis 实例，开启 THP 时 fork 期间内存使用量可以增加 5~10GB（大量 COW 副本），CPU 使用率飙升，写操作延迟从正常的亚毫秒飙升到几十毫秒。

> [!warning] 生产避坑
> **Redis、Memcached 等内存数据库必须禁用 THP**：
> ```bash
> echo never > /sys/kernel/mm/transparent_hugepage/enabled
> echo never > /sys/kernel/mm/transparent_hugepage/defrag
> # 写入 /etc/rc.local 永久生效
> ```

### 4.3 THP 的 defrag 选项

内存碎片化时找不到连续 2MB 的行为控制：

```bash
cat /sys/kernel/mm/transparent_hugepage/defrag
# [always] defer defer+madvise madvise never
```

- **always**：同步等待内存紧缩（最激进，可能导致分配延迟，生产不推荐）
- **defer**：异步触发紧缩，不阻塞当前分配（推荐）
- **never**：不触发紧缩，退回 4KB 页

---

## 第 5 章 各技术栈的 HugePage 最佳实践

### 5.1 MySQL InnoDB

InnoDB Buffer Pool 是 TLB Miss 的主要来源，大页收益明显：

```bash
# my.cnf 配置
[mysqld]
innodb_huge_pages = ON     # 使用显式大页
large_pages = ON

# 同时配置显式大页（Buffer Pool 大小 + 20% 余量）
echo 20480 > /proc/sys/vm/nr_hugepages  # 40GB Buffer Pool 需要约 20000 个 2MB 大页
```

### 5.2 Java（JVM）

JVM 堆是典型的大内存匿名分配，THP 对 JVM 通常是正收益（JVM 不像 Redis 那样频繁 fork）：

```bash
# 方案一：让 THP 自动处理（always 模式下 JVM 自动受益）
# 不需要额外配置

# 方案二：JVM 参数显式使用大页（配合显式大页）
java -XX:+UseLargePages -XX:LargePageSizeInBytes=2m -jar app.jar

# 方案三：AlwaysPreTouch + THP 结合（稳定延迟）
java -XX:+UseLargePages -XX:+AlwaysPreTouch -jar app.jar
# AlwaysPreTouch：启动时触发所有堆页的 Page Fault，让 khugepaged 提前合并
```

> [!info] 核心概念：JVM 与 THP 的友好关系
> JVM 的 GC 工作模式是：分配内存（大量按顺序分配，THP 友好）、全量扫描存活对象（顺序遍历，TLB 效率高）。与 Redis 的随机写不同，JVM 分配的匿名内存通常是连续的大块，khugepaged 合并成功率高，且 JVM 不频繁 fork，COW 放大问题基本不存在。开启 THP 对 JVM 应用通常有 3%~15% 的性能提升。

### 5.3 Hadoop/Spark

计算框架的 executor 内存同样是大块匿名内存，适合 THP：

```bash
# 保持 THP=always，让内核自动处理
# 对于大内存 shuffle（数百 GB），可以考虑显式大页
# yarn.nodemanager.resource.memory-mb 对应的物理内存可配置大页
```

### 5.4 数据库类（PostgreSQL/Oracle）

PostgreSQL 支持通过 `huge_pages = on` 配置（需要配置 `shmget` 的大页权限）：

```bash
# postgresql.conf
huge_pages = on
# 同时在内核层面预留足够的大页
echo 16384 > /proc/sys/vm/nr_hugepages  # 32GB shared_buffers 需要 ~16000 个 2MB 大页
```

---

## 第 6 章 HugePage 的监控与诊断

### 6.1 确认大页使用情况

```bash
# 查看 THP 使用量
grep AnonHugePages /proc/meminfo
# AnonHugePages: 8388608 kB  = 4096 个 2MB THP 正在使用

# 查看某个进程的 THP 使用
grep AnonHugePages /proc/$(pgrep java)/smaps | awk '{sum+=$2} END{print sum/1024 " MB"}'

# 查看 THP 合并统计
grep thp /proc/vmstat
# thp_fault_alloc：直接分配成功的 THP 次数
# thp_collapse_alloc：khugepaged 合并成功次数
# thp_split_page：大页被拆分的次数（越少越好）
# thp_fault_fallback：想分配 THP 但退回 4KB 的次数（多说明内存碎片化）
```

### 6.2 用 perf 量化 TLB Miss 收益

```bash
# 测量开启 THP 前后的 TLB Miss 率
$ perf stat -e dTLB-load-misses,dTLB-loads,iTLB-load-misses,iTLB-loads \
    -p $(pgrep java) -- sleep 10

# 典型输出（开启 THP 前）：
# dTLB-load-misses:  1,234,567  （12.3% miss rate）
# dTLB-loads:       10,000,000

# 典型输出（开启 THP 后）：
# dTLB-load-misses:    123,456  （1.2% miss rate）↓ 10倍改善
# dTLB-loads:       10,000,000
```

---

## 第 7 章 总结

HugePage 是解决大内存时代 TLB Miss 问题的系统级方案，本文核心认知：

**1. TLB 容量有限是根本矛盾**：L2 TLB 仅 4096 条目，用 4KB 页只能覆盖 16MB。大页通过扩大页粒度，使同样 TLB 容量覆盖更多内存。

**2. 显式大页 vs THP**：显式大页性能最好但有侵入性；THP 对应用透明但有延迟抖动风险。两者不互斥，可以同时存在（THP 只影响匿名页，显式大页通过 `MAP_HUGETLB` 独立使用）。

**3. Redis/Memcached 必须禁用 THP**：Fork + COW + 大页 = 持久化期间 COW 代价放大 512 倍，导致内存暴涨和延迟抖动。

**4. JVM/数据库 Buffer Pool 是 HugePage 收益最大的场景**：大块连续内存分配，TLB Miss 率高，使用大页后 TLB Miss 可减少 10 倍以上，整体性能提升 3%~15%。

**5. defrag=defer 是 THP 的推荐配置**：避免 `always` 模式下同步内存紧缩引入的分配延迟。

理解了大页内存后，下一篇[[CGroups 内存子系统：容器内存隔离的底层实现]]将从 cgroup 视角看内存管理——容器如何通过 cgroup 实现内存隔离，以及 limit 背后的内核机制。

---

## 参考资料

- Linux Kernel Documentation: [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)
- Linux Kernel Documentation: [Hugetlbfs](https://www.kernel.org/doc/Documentation/vm/hugetlbpage.txt)
- Brendan Gregg, *Systems Performance, 2nd Ed.*, Chapter 7: Memory（HugePage section）
- Redis Documentation: [Latency - Transparent huge pages](https://redis.io/docs/management/optimization/latency/)
- [Transparent Hugepages: measuring the performance impact](https://alexandrnikitin.github.io/blog/transparent-hugepages-measuring-the-performance-impact/)
