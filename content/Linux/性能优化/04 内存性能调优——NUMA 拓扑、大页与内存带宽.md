---
title: "内存性能调优——NUMA 拓扑、大页与内存带宽"
date: 2026-03-02
tags: [HugePage, Linux, NUMA, numactl, numastat, THP, 内存带宽, 内存调优, 大页, 性能优化]
aliases: ["NUMA调优", "HugePage配置", "透明大页THP", "内存带宽优化", "numactl使用"]
---

**摘要：**

内存性能不只是"容量够不够"的问题。在现代多路服务器（2 路/4 路 NUMA）和大内存（TB 级）场景下，**内存访问的延迟和带宽差异**比容量更重要：跨 NUMA 节点的内存访问比本地访问慢 2 倍（延迟：~40ns → ~120ns），1TB 内存中分散的工作集会产生大量 TLB Miss（每次 miss 需要 4 次页表遍历 ≈ 200-400 cycles），而内存带宽饱和（所有内存通道满负荷）会让增加 CPU 核也毫无帮助。本文深入三个维度：**NUMA 拓扑感知**——如何用 `numastat` 和 `numactl` 诊断和修复 NUMA 不均衡；**大页（HugePage）**——为什么 2MB 大页能将 TLB Miss 减少 512 倍，透明大页（THP）的自动化优势与碎片化陷阱；**内存带宽**——如何用 `perf` 和 `stream` 工具量化内存带宽饱和，以及内存通道绑定（Memory Interleaving）对带宽的影响。每个维度都给出从诊断到调优的完整路径。

---

## 第 1 章 NUMA 架构：为什么内存有"远近"之分

### 1.1 NUMA 的出现背景

早期的多处理器服务器采用 **UMA（Uniform Memory Access，统一内存访问）** 架构——所有 CPU 通过共享总线访问同一块内存，访问延迟对所有 CPU 相同。但随着 CPU 核数增加，共享总线成为严重瓶颈——16 核 CPU 同时访问内存时，总线竞争导致每个核的有效带宽大幅下降。

**NUMA（Non-Uniform Memory Access，非统一内存访问）** 将内存划分为多个"本地"区域，每个区域（NUMA 节点）直接连接到对应的 CPU 插槽。CPU 优先访问本地内存（低延迟），也可以通过 QPI/UPI 互联总线访问远端 NUMA 节点的内存（高延迟）：

```
双路 NUMA 服务器的物理拓扑：

┌─────────────────────────────────────────────────────┐
│  NUMA Node 0                NUMA Node 1             │
│  ┌──────────────┐          ┌──────────────┐         │
│  │ CPU Socket 0 │◄────────►│ CPU Socket 1 │         │
│  │ CPU 0-15     │  QPI/UPI │ CPU 16-31    │         │
│  └──────┬───────┘          └──────┬───────┘         │
│         │ 本地总线                 │ 本地总线         │
│  ┌──────┴───────┐          ┌──────┴───────┐         │
│  │ Memory 0     │          │ Memory 1     │         │
│  │ 0 - 127 GB   │          │ 128 - 255 GB │         │
│  └──────────────┘          └──────────────┘         │
└─────────────────────────────────────────────────────┘

CPU 0 访问 Memory 0（本地）：~40 ns  ← 快
CPU 0 访问 Memory 1（远端）：~120 ns ← 慢（通过 QPI/UPI 跨节点）
```

**NUMA 比率（NUMA Ratio）**：远端延迟/本地延迟，通常为 2-3 倍。在内存密集型应用中，如果大量数据分配在远端 NUMA 节点，实际吞吐量可能损失 30-50%。

### 1.2 查看服务器的 NUMA 拓扑

```bash
# 查看 NUMA 节点和 CPU 分布
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
# node 0 size: 128675 MB
# node 0 free: 64321 MB
# node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
# node 1 size: 131072 MB
# node 1 free: 98765 MB
# node distances:         ← NUMA 距离矩阵
#         node 0  node 1
# node 0:   10    21    ← Node 0 访问 Node 0 = 10（本地基准），访问 Node 1 = 21
# node 1:   21    10    ← 对称矩阵

# 查看更详细的 NUMA 拓扑（包含 NUMA 节点的硬件缓存关系）
lstopo --no-io       # 图形化拓扑（需要安装 hwloc）
lstopo > topo.svg    # 导出 SVG

# 查看每个 NUMA 节点的内存使用（最关键的诊断命令）
numastat
# Per-node numastat
#                    node0           node1
# numa_hit       12345678901     23456789012  ← 成功的本地内存分配
# numa_miss            12345            678  ← ！！远端内存分配次数（目标节点内存不足，溢出到远端）
# numa_foreign          678           12345  ← 别的节点溢出到本节点的分配
# interleave_hit        123             456
# local_node      12345678000     23456789000
# other_node           12901            12  ← 非本地 CPU 访问本节点内存的次数

# numa_miss 高 → 内存分配发生了跨 NUMA 节点溢出 → 需要调优
```

### 1.3 numastat -p：定位哪个进程有 NUMA 问题

```bash
# 查看特定进程的 NUMA 内存分布
numastat -p <pid>
# Per-node process memory usage (in MBs) for PID 1234 (java)
#                  Node 0          Node 1           Total
# Huge                0.00            0.00            0.00
# Heap             3456.78          567.89         4024.67  ← Heap 内存分布在两个节点！
# Stack               1.23            0.00            1.23
# Private          1234.56            0.00         1234.56
# -------          -------         -------         -------
# Total            4692.57          567.89         5260.46

# 解读：该 Java 进程的 Heap 分布在 Node 0（3456MB）和 Node 1（568MB）
# 运行在 Node 0 CPU 的线程访问 Node 1 的 568MB 时，延迟翻倍
# 优化目标：让进程的内存全部在 Node 0（与线程运行的 CPU 同节点）
```

---

## 第 2 章 NUMA 调优：让计算与内存在同一节点

### 2.1 numactl：启动时绑定 NUMA 策略

`numactl` 是最直接的 NUMA 调优工具，在进程启动时指定 CPU 和内存的 NUMA 策略：

```bash
# 将进程绑定到 NUMA Node 0 的 CPU 和内存
numactl --cpunodebind=0 --membind=0 ./my_service
# --cpunodebind=0：只使用 Node 0 的 CPU（等同于 taskset -c 0-15）
# --membind=0：所有内存分配优先从 Node 0 分配，不足时报错（不溢出到 Node 1）

# 更宽松的策略：优先本地，不足时溢出
numactl --cpunodebind=0 --preferred=0 ./my_service
# --preferred=0：优先 Node 0，不足时可以溢出到其他节点（比 --membind 更安全）

# 对于需要充分利用所有内存的大数据进程：跨节点交错分配
numactl --interleave=all ./my_large_memory_service
# --interleave=all：内存以页为单位交替分配到所有 NUMA 节点
# 好处：内存带宽翻倍（两个节点的内存通道同时工作）
# 代价：约一半访问是远端（延迟增加），但避免了单节点内存耗尽
# 适合：大规模 in-memory 数据处理（Spark、ClickHouse）

# 实际生产案例：Nginx + Redis 的 NUMA 配置
# Nginx（网络密集）：绑定到与网卡同 NUMA 节点的 CPU 和内存
numactl --cpunodebind=0 --membind=0 nginx  # 假设网卡在 Node 0

# Redis（内存密集，单线程）：绑定到单个 NUMA 节点
numactl --cpunodebind=1 --membind=1 redis-server  # 独占 Node 1
```

### 2.2 内核 NUMA 自动均衡（AutoNUMA）的利与弊

Linux 内核从 3.8 开始支持 **AutoNUMA**（`kernel.numa_balancing=1`，默认开启）——内核自动检测进程的内存访问模式，将频繁被某个 CPU 访问的内存页迁移到该 CPU 所在的 NUMA 节点。

**AutoNUMA 的工作原理**：
1. 内核定期扫描进程的页表，将部分页面标记为"不可访问"（PROT_NONE）
2. 当进程访问这些页面时触发 page fault
3. 内核记录访问该页面的 CPU 所在的 NUMA 节点
4. 如果页面和访问它的 CPU 不在同一节点，触发页面迁移（migrate）

**AutoNUMA 的代价**：
- 定期扫描和标记页面有 CPU 开销（约 1-3%）
- 页面迁移（`migrate_pages`）会引发短暂的 TLB shootdown（所有 CPU 需要刷新 TLB）
- 对于访问模式不固定的应用（多线程随机访问），迁移后可能很快又被"错误"CPU 访问

**生产建议**：

```bash
# 查看 AutoNUMA 状态
sysctl kernel.numa_balancing
# 1  ← 默认开启

# 在以下场景建议关闭 AutoNUMA（用手动 numactl 替代）：
# 1. 延迟敏感服务（AutoNUMA 的 page fault + 迁移引起抖动）
# 2. 已经手动绑定了 NUMA 策略（AutoNUMA 和手动绑定冲突）
sysctl -w kernel.numa_balancing=0

# 在以下场景保持 AutoNUMA 开启：
# 1. 服务访问模式难以预测
# 2. 没有时间手动调优 NUMA 策略
```

### 2.3 量化 NUMA 问题的实际影响

```bash
# 方法 1：perf stat 中的 node-load-misses（跨 NUMA 内存访问计数器）
perf stat -e node-load-misses,node-prefetch-misses -p <pid> sleep 10
# node-load-misses：需要访问远端 NUMA 节点才能满足的 load 次数

# 方法 2：用 numastat 监控 NUMA miss 变化率（每 5 秒刷新一次）
watch -n 5 numastat

# 方法 3：stream 工具测量 NUMA 配置对内存带宽的影响
# 对比 numactl --membind=0 vs --interleave=all 的内存带宽差异
numactl --membind=0 ./stream
# Triad: 45678.9 MB/s（单节点，只使用 Node 0 的内存通道）

numactl --interleave=all ./stream
# Triad: 89012.3 MB/s（两个节点内存通道同时工作，带宽翻倍！）
```

---

## 第 3 章 HugePage：从根本上解决 TLB Miss

### 3.1 TLB Miss 问题的量级

在 [[02 CPU 微架构优化——Cache Miss、分支预测与 SIMD]] 中提到，TLB Miss 需要 4 次内存访问（200-400 cycles）来完成地址翻译。关键问题是：**4KB 页面的 TLB 覆盖范围太有限**。

以 Intel CPU 为例，L2 TLB 有 1536 个条目（data + instruction 混合）。使用 4KB 页面：
```
TLB 覆盖范围 = 1536 条目 × 4 KB/条目 = 6 MB
```

任何工作集超过 6MB 的应用（Redis 有几十 GB、MySQL buffer pool 几十 GB、JVM Heap 几十 GB），每次访问非缓存区域都必然触发 TLB Miss。

使用 2MB 大页：
```
TLB 覆盖范围 = 1536 条目 × 2 MB/条目 = 3 GB
```

覆盖范围从 6MB 扩大到 3GB，**提升 512 倍**——对于 Redis（数 GB 的数据集）或 MySQL（几 GB 的 buffer pool），工作集完全可以覆盖在 TLB 中，TLB Miss 率从 5-20% 降到接近 0。

### 3.2 标准大页（Huge Pages）的配置

Linux 提供两种大页：**2MB 大页**（x86 默认）和 **1GB 大页**（需要 BIOS 支持，用于极大内存场景）。

```bash
# 查看大页支持状态
cat /proc/meminfo | grep -i huge
# AnonHugePages:   1234567 kB  ← THP（透明大页）已分配的匿名大页
# ShmemHugePages:        0 kB
# HugePages_Total:    1024     ← 预分配的静态 2MB 大页总数
# HugePages_Free:      512     ← 空闲的静态大页
# HugePages_Rsvd:       64     ← 已保留（分配但未使用）
# HugePages_Surp:        0     ← 超出 vm.nr_hugepages 的动态分配
# Hugepagesize:       2048 kB  ← 大页大小 2MB
# Hugetlb:         2097152 kB  ← 总 HugeTLB 内存

# 配置预分配的 2MB 大页数量
# 在系统启动时配置（推荐，避免内存碎片化）
sysctl -w vm.nr_hugepages=4096   # 预分配 4096 × 2MB = 8GB 大页

# 永久配置（写入 /etc/sysctl.conf）
echo "vm.nr_hugepages = 4096" >> /etc/sysctl.conf

# 或在内核启动参数中配置（最可靠，防止内存碎片导致分配失败）
# GRUB_CMDLINE_LINUX="hugepages=4096 default_hugepagesz=2M"

# 挂载 hugetlbfs（程序通过 mmap 使用大页）
mkdir /mnt/hugepages
mount -t hugetlbfs hugetlbfs /mnt/hugepages

# NUMA 感知的大页分配（分别在两个 NUMA 节点上分配大页）
echo 2048 > /sys/devices/system/node/node0/hugepages/hugepages-2048kB/nr_hugepages
echo 2048 > /sys/devices/system/node/node1/hugepages/hugepages-2048kB/nr_hugepages
```

### 3.3 应用程序如何使用大页

**方式 1：通过 `mmap` 的 `MAP_HUGETLB` 标志**

```c
#include <sys/mman.h>

/* 直接分配 2MB 大页内存 */
void *buf = mmap(NULL, 2 * 1024 * 1024,  /* 2MB */
                 PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                 -1, 0);
if (buf == MAP_FAILED) {
    perror("mmap hugetlb failed");  /* 大页不够时失败 */
}
/* 使用完毕 */
munmap(buf, 2 * 1024 * 1024);
```

**方式 2：通过 `LD_PRELOAD` 替换 `malloc`（对应用透明）**

```bash
# libhugetlbfs 库自动将 malloc 大分配替换为大页分配
apt-get install libhugetlbfs-bin
export HUGETLB_MORECORE=yes
LD_PRELOAD=/usr/lib/libhugetlbfs.so.0 ./my_application
```

**方式 3：JVM 大页配置（Java 应用最常用）**

```bash
# JVM 启用大页（需要系统已配置足够的 HugePages）
java -XX:+UseLargePages \
     -XX:+UseHugeTLBFS \        # 明确使用 HugeTLB FS
     -Xms8g -Xmx8g \            # Heap 完全分配在大页上
     -jar myapp.jar

# 验证 JVM 是否成功使用大页
java -XX:+UseLargePages -verbose:gc -Xms1g -Xmx1g -version 2>&1 | grep -i huge
```

**方式 4：Redis 大页配置**

```
# redis.conf
hugepages yes  # Redis 6.0+ 支持

# 或通过环境变量
MALLOC_ARENA_MAX=1 numactl --membind=0 redis-server
```

### 3.4 透明大页（THP）：自动化的代价

**THP（Transparent Huge Pages，透明大页）** 是 Linux 内核的自动化大页机制——内核自动将连续的 4KB 匿名页合并为 2MB 大页，对应用程序完全透明，无需修改代码。

**THP 的工作原理**：

当进程分配内存时（如 `malloc`），内核优先分配 2MB 大页（如果有连续的可用内存）。对于已有的 4KB 页，内核的 `khugepaged` 守护进程定期扫描，将符合条件的连续 4KB 页合并为 2MB 大页。

**THP 的问题**：

```bash
# 查看 THP 当前配置
cat /sys/kernel/mm/transparent_hugepage/enabled
# [always] madvise never
# always：所有内存自动尝试使用大页（默认，可能导致问题）
# madvise：只对显式调用 madvise(MADV_HUGEPAGE) 的内存使用大页（推荐）
# never：完全禁用 THP

# 查看 THP 的统计
cat /proc/vmstat | grep thp
# thp_fault_alloc 1234567         ← 分配大页的次数
# thp_fault_fallback 12345        ← 大页分配失败，退回 4KB 页
# thp_collapse_alloc 234567       ← khugepaged 合并的次数
# thp_split_page 3456             ← 大页被分裂回 4KB 页的次数（高 = 内存碎片）
# thp_deferred_split_page 23456   ← 延迟分裂
```

**THP 的已知问题**：

**问题 1：延迟抖动**。`khugepaged` 在合并页面时会持有各种内核锁，可能阻塞应用程序几毫秒。对于延迟敏感的服务（Redis、交易系统），这是不可接受的。**Redis 官方文档明确要求禁用 THP**：

```bash
# Redis 推荐：禁用 THP（或设为 madvise）
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
# 永久配置（/etc/rc.local 或 systemd service）
```

**问题 2：内存碎片化**。THP 需要连续的 2MB 内存块。系统运行时间长后，内存碎片化严重，THP 分配失败率（`thp_fault_fallback`）增加，退回 4KB 页，TLB miss 率重新上升。

**问题 3：内存膨胀**。Copy-on-Write（写时复制）基于页面粒度。使用 2MB 大页时，`fork()` 后子进程对大页内任何一个字节的写入，会触发整个 2MB 大页的 CoW 复制（而不是 4KB）——这在使用 `fork()` 的进程中（如 Redis 的 `BGSAVE`）会造成显著的内存膨胀（"THP + fork 内存膨胀"问题）。

**生产建议**：

| 场景 | THP 配置 |
|-----|---------|
| Redis | `never` 或 `madvise`（官方强烈建议禁用）|
| MySQL / PostgreSQL | `madvise`（数据库自己管理大页）|
| JVM 应用 | `always` 可接受，但建议 `madvise` + 显式 `UseLargePages`|
| Kafka Broker | `madvise`（减少 khugepaged 抖动）|
| 批处理/分析任务 | `always`（延迟不敏感，内存带宽重要）|

---

## 第 4 章 内存带宽：当内存总线成为瓶颈

### 4.1 内存带宽的硬件上限

现代服务器 CPU 支持多通道内存（DDR4/DDR5），以 Intel Ice Lake-SP 为例：
- 支持 8 通道 DDR4-3200
- 每通道带宽：3200 MHz × 8 bytes = 25.6 GB/s
- 总带宽上限：8 × 25.6 = **204.8 GB/s**

当应用程序的内存访问速率接近或达到这个上限时，就发生了**内存带宽饱和**——增加 CPU 核心数不再有帮助（CPU 在等待内存数据），甚至因为更多 CPU 竞争同一内存总线而性能下降。

**内存带宽饱和的典型场景**：
- 大规模向量运算（ML 推理、科学计算）
- 内存密集型数据库查询（列式扫描）
- 大数据量的排序和 Hash Join

### 4.2 STREAM：内存带宽基准测试

**STREAM** 是内存带宽测试的行业标准工具，测量四种内存密集型操作的带宽：

```bash
# 安装和编译 STREAM（需要 OpenMP）
wget https://www.cs.virginia.edu/stream/FTP/Code/stream.c
gcc -O3 -march=native -fopenmp -DSTREAM_ARRAY_SIZE=100000000 \
    stream.c -o stream
# STREAM_ARRAY_SIZE=1亿：数组大小超过 LLC，强迫从 DRAM 读取

# 运行测试
./stream
# Function    Best Rate MB/s  Avg time     Min time     Max time
# Copy:           145678.9     0.010958     0.010953     0.010973
# Scale:          134567.8     0.011890     0.011885     0.011895
# Add:            156789.0     0.015367     0.015363     0.015376
# Triad:          158901.2     0.015163     0.015158     0.015173

# 解读 Triad 速率（通常最接近峰值带宽）：
# 理论峰值：204.8 GB/s
# 实测：158.9 GB/s → 利用率 77%（正常，受 DRAM 刷新等开销影响）

# NUMA 感知的带宽测试
numactl --interleave=all ./stream   # 双通道满速
numactl --membind=0 ./stream        # 单节点带宽
```

### 4.3 perf 诊断内存带宽饱和

```bash
# 方法 1：Intel Memory Controller 计数器（最直接）
perf stat -e uncore_imc/data_reads/,uncore_imc/data_writes/ \
    -p <pid> sleep 10
# uncore_imc = Integrated Memory Controller（内存控制器）
# data_reads：内存读取字节数
# data_writes：内存写入字节数

# 方法 2：通过内存带宽占比间接判断
perf stat -e cycles,instructions,LLC-load-misses -p <pid> sleep 10
# 若 LLC-load-misses 极高（每秒 > 1 亿次），且 IPC 极低（< 0.3）
# → 高度怀疑内存带宽饱和

# 方法 3：/proc/meminfo 的 dirty/writeback 监控
watch -n 1 "grep -E 'MemFree|Dirty|Writeback|Cached|Buffers' /proc/meminfo"

# 方法 4：Intel VTune（最强大的内存带宽分析工具）
vtune -collect memory-access ./my_program
# 输出：内存带宽利用率百分比、热点内存访问函数
```

### 4.4 内存带宽优化策略

**策略 1：提高数据复用率（减少从 DRAM 读取的次数）**

这是最根本的优化——如果数据能在 LLC 中复用，就不需要从 DRAM 读取。核心手段是**缓存分块（Cache Blocking/Tiling）**，在 [[02 CPU 微架构优化]] 中已有详细介绍。

**策略 2：NUMA 交错（Interleaving）提升有效带宽**

当单节点内存带宽不够时，将内存分配到多个 NUMA 节点，让多个内存控制器并行工作：

```bash
# 单节点：只使用 Node 0 的内存控制器（最多 ~100 GB/s）
numactl --membind=0 ./my_program

# 交错分配：使用所有节点的内存控制器（最多 ~200 GB/s）
numactl --interleave=all ./my_program
# 代价：约一半访问是远端内存（延迟高），但带宽翻倍
# 适合：大规模顺序扫描（带宽比延迟更重要的场景）
```

**策略 3：数据压缩（减少内存数据量）**

```bash
# 对于内存带宽成为瓶颈的 ClickHouse 查询，开启列压缩
# 数据在内存中保持压缩状态，减少内存带宽消耗
# LZ4 解压速度 > 5 GB/s（远高于 DRAM 带宽），因此内存压缩是净收益

# 数据库层面：确保 buffer pool 足够大（避免频繁从磁盘 reload）
# MySQL
innodb_buffer_pool_size = 120G  # 典型设置：物理内存的 70-80%

# PostgreSQL
shared_buffers = 32G            # 典型设置：物理内存的 25%
effective_cache_size = 96G      # 告知查询优化器有多少缓存可用
```

**策略 4：写合并（Write Combining）优化写带宽**

顺序写比随机写更节省带宽（硬件写合并缓冲区可以将多个小写合并为一个 Cache Line 写）。对于写密集型应用，确保写操作是顺序的：

```c
/* 随机写（内存带宽效率低）*/
for (int i = 0; i < N; i++)
    output[random_idx[i]] = compute(input[i]);

/* 顺序写（内存带宽效率高，Write Combining 充分利用）*/
/* 如果算法允许，先计算所有结果，再顺序写入 */
for (int i = 0; i < N; i++)
    output[i] = compute(input[sorted_idx[i]]);  /* 写是顺序的 */
```

---

## 第 5 章 内存调优综合案例

### 5.1 案例：Redis 内存性能调优清单

```bash
# 1. 禁用 THP（防止 khugepaged 延迟和 fork 内存膨胀）
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 2. 绑定 NUMA 节点（Redis 单线程，绑定单节点最优）
numactl --cpunodebind=0 --membind=0 redis-server /etc/redis/redis.conf

# 3. 禁用 NUMA 自动均衡（Redis 已手动绑定，避免冲突）
sysctl -w kernel.numa_balancing=0

# 4. 关闭内存 overcommit（Redis 需要确定性内存分配）
sysctl -w vm.overcommit_memory=1

# 5. 预配置静态大页（Redis 不使用，但防止系统内存碎片化影响大页可用性）
sysctl -w vm.nr_hugepages=0  # Redis 不使用静态大页

# 6. 调整 swappiness（尽量不 swap）
sysctl -w vm.swappiness=1
```

### 5.2 案例：Java（JVM）内存性能调优清单

```bash
# 1. 使用大页（JVM Heap 通常 > 8GB，受益显著）
java -XX:+UseLargePages \
     -XX:+UseTransparentHugePages \  # 或 -XX:+UseHugeTLBFS（需要系统预配置大页）
     ...

# 2. NUMA 感知的 JVM 配置
java -XX:+UseNUMA \      # 启用 NUMA 感知分配器（G1GC/ZGC 支持）
     -XX:+UseG1GC \      # G1GC 天然支持 NUMA
     ...
numactl --interleave=all java ...  # 或交错分配（Heap > 单节点内存时）

# 3. 减少 GC 产生的内存带宽压力
java -XX:+UseZGC \       # ZGC：低延迟 GC，减少 STW 期间的内存扫描带宽
     -XX:SoftMaxHeapSize=28g \  # 控制 Heap 实际使用上限（减少带宽）
     -Xmx32g \
     ...
```

---

## 小结

内存性能调优的三个维度彼此独立，针对不同根因：

**NUMA 不均衡**（跨节点访问慢 2 倍）：
- 诊断：`numastat` 看 `numa_miss` 计数，`numastat -p <pid>` 看进程内存分布
- 修复：`numactl --cpunodebind=N --membind=N` 绑定 NUMA，或 `--interleave=all` 提升带宽

**TLB Miss 频繁**（工作集大于 TLB 覆盖范围）：
- 诊断：`perf stat -e dTLB-load-misses`，miss 率 > 3% 需要优化
- 修复：静态 HugePage（`vm.nr_hugepages`）+ 应用层配置（`-XX:+UseLargePages`），或 THP `madvise` 模式

**内存带宽饱和**（内存总线成为瓶颈）：
- 诊断：STREAM 基准测试测量实际带宽，`perf stat -e LLC-load-misses` 间接判断
- 修复：缓存分块提高数据复用率，`numactl --interleave=all` 利用多节点带宽

下一篇 [[05 磁盘 IO 性能调优——fio 方法论、调度器与 IO 模式]] 将把调优视角移向存储层：`fio` 作为磁盘性能基准测试的标准工具，如何设计测试场景（iodepth/bs/numjobs 三参数的配合）来准确衡量存储设备性能；`blktrace` 如何追踪一个 IO 请求在内核块设备层的完整路径；以及 NVMe SSD 的最佳 IO 模式（`io_uring` vs `libaio` vs 同步 IO）如何选择。

---

> [!note] 思考题
> 1. NUMA 架构中 `numactl --interleave=all` 将内存均匀分布在所有节点。在数据库共享缓冲池场景中这是合理的（因为所有 CPU 都访问缓冲池）。但对于单线程应用，interleave 反而增加了一半的远端访问。你如何根据应用的线程模型选择 NUMA 策略？
> 2. 内存带宽是向量化查询引擎和 ML 推理的常见瓶颈。DDR4 双通道约 50GB/s。`perf stat` 的 `LLC-load-misses` 表示 L3 Miss（需要访问主存）——如果这个值很高，说明应用受内存带宽限制。除了升级内存（DDR5）和增加通道数，应用层有什么优化手段？
> 3. 在 KVM 虚拟化中，虚拟机的 vCPU 可能被调度到不同 NUMA 节点的物理核上，导致内存访问延迟不可预测。`virsh numatune` 和 `vcpupin` 如何解决？在 OpenStack/K8s 环境中，如何在调度层面保证 VM/Pod 的 NUMA 亲和性？
