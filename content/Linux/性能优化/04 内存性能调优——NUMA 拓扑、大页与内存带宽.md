---
title: "内存性能调优——NUMA 拓扑、大页与内存带宽"
date: 2026-03-02
tags: [HugePage, Linux, NUMA, numactl, numastat, THP, 内存带宽, 内存调优, 大页, 性能优化, 性能调优, stream, lstopo, AutoNUMA, TLB, DDR4, DDR5]
aliases: ["NUMA调优", "HugePage配置", "透明大页THP", "内存带宽优化", "numactl使用", "numastat诊断", "TLB Miss", "内存交错"]
---

# 04 内存性能调优——NUMA 拓扑、大页与内存带宽

**摘要：**
内存性能不只是"容量够不够"的问题。在现代多路服务器（2 路/4 路 NUMA）和大内存（TB 级）场景下，**内存访问的延迟和带宽差异**比容量更重要：跨 NUMA 节点的内存访问比本地访问慢 2 倍（延迟：~40ns → ~120ns），1TB 内存中分散的工作集会产生大量 TLB Miss（每次 miss 需要 4 次页表遍历 ≈ 200-400 cycles），而内存带宽饱和（所有内存通道满负荷）会让增加 CPU 核也毫无帮助。本文深入三个维度：**NUMA 拓扑感知**——如何用 `numastat` 和 `numactl` 诊断和修复 NUMA 不均衡；**大页（HugePage）**——为什么 2MB 大页能将 TLB Miss 减少 512 倍，透明大页（THP）的自动化优势与碎片化陷阱；**内存带宽**——如何用 `perf` 和 `stream` 工具量化内存带宽饱和，以及内存通道绑定（Memory Interleaving）对带宽的影响。每个维度都给出从诊断到调优的完整路径。

---

## 第 1 章 从 UMA 到 NUMA——多路服务器的内存拓扑演进

### 1.1 共享总线时代的终结

理解 NUMA 之前，先回顾多处理器服务器的内存架构演化史。1990 年代的多处理器服务器采用 **UMA（Uniform Memory Access，统一内存访问）** 架构——所有 CPU 通过共享总线（FSB，Front Side Bus）访问同一块内存，访问延迟对所有 CPU 相同。这种架构简单优雅，但有一个致命问题——共享总线是瓶颈。当 CPU 核数增加时，所有核都要通过同一根总线访问内存，总线竞争导致每个核的有效带宽下降。4 核时还能勉强工作，8 核时总线饱和，16 核时性能不升反降——"加核不加速"的怪圈。

2000 年代，AMD 在 Opteron 处理器上引入了 **NUMA（Non-Uniform Memory Access，非统一内存访问）** 架构——每个 CPU 插槽有自己的"本地内存"，CPU 优先访问本地内存（低延迟），也可以通过 HyperTransport（AMD）/ QPI（Intel）/ UPI（Intel 新一代）互联总线访问远端 NUMA 节点的内存（高延迟）。NUMA 打破了共享总线的瓶颈——每个 CPU 有自己的内存通道，带宽随 CPU 数量线性扩展。但代价是"内存有远近之分"——远端访问比本地访问慢 2-3 倍。**NUMA 是"用延迟不均匀换带宽可扩展"的架构选择**——它让多路服务器的内存带宽能随 CPU 数量扩展，但要求软件感知拓扑以避免远端访问。

NUMA 架构的演化没有止步于"每插槽一个 NUMA 节点"。随着 CPU 核数进一步增加（单插槽 64 核、128 核），单插槽内的内存控制器也分化为多个——譬如 AMD EPYC 的 NUMA 架构（NPS，Nodes Per Socket），单插槽可以配置为 NPS1（单节点）、NPS2（两节点）、NPS4（四节点）。这意味着一个 2 路 EPYC 服务器在 NPS4 模式下有 8 个 NUMA 节点——NUMA 距离矩阵从 2×2 变成 8×8，拓扑复杂度急剧上升。软件需要更精细的 NUMA 感知才能避免远端访问——"绑定到 Socket 0"不够，要"绑定到 Socket 0 的 NUMA 节点 0"。**NUMA 拓扑随 CPU 核数增长而复杂化**——从 2 节点到 8 节点，调优粒度从"插槽级"细化到"芯片内节点级"。

NUMA 拓扑的复杂化还有一个与"操作系统视角"相关的简化——Linux 内核把所有 NUMA 节点统一编号（0, 1, 2, ...），无论物理上是插槽级还是芯片内级。`numactl --hardware` 显示的节点数就是内核看到的 NUMA 节点数。这意味着软件不需要关心"物理拓扑是 NPS1 还是 NPS4"——只需要按内核的节点编号做绑定。但理解物理拓扑有助于调优决策——譬如 NPS4 模式下，同一插槽内的两个 NUMA 节点距离是 20（近），跨插槽的距离是 40（远），优化时要优先"同插槽同节点"，其次"同插槽跨节点"，最后"跨插槽"。**内核统一编号 NUMA 节点，但物理拓扑决定距离矩阵**——这是 NUMA 调优的"逻辑统一、物理差异"特点。

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph TD
    subgraph "NUMA Node 0"
        CPU0["CPU 0-15<br/>Socket 0"]
        MEM0["Memory 0<br/>0-127 GB"]
    end
    subgraph "NUMA Node 1"
        CPU1["CPU 16-31<br/>Socket 1"]
        MEM1["Memory 1<br/>128-255 GB"]
    end
    CPU0 -.->|"本地访问 ~40ns"| MEM0
    CPU1 -.->|"本地访问 ~40ns"| MEM1
    CPU0 ==>"|远端访问 ~120ns<br/>via QPI/UPI|" MEM1
    CPU1 ==>"|远端访问 ~120ns<br/>via QPI/UPI|" MEM0

    classDef local fill:#282a36,stroke:#50fa7b,color:#f8f8f2
    classDef remote fill:#44475a,stroke:#ff5555,color:#f8f8f2
    class MEM0,MEM1 local
```

### 1.2 NUMA 距离与 NUMA 比率

**NUMA 距离（NUMA Distance）** 是内核用来量化"远近"的指标——本地访问距离为 10（基准），远端访问距离通常为 20-40（取决于互联拓扑）。2 路服务器的 NUMA 距离矩阵很简单——Node 0 到 Node 0 是 10，Node 0 到 Node 1 是 21（Intel 典型值）。4 路及以上的服务器更复杂——可能有多级互联（远端节点的远端节点），距离可达 40-80。

**NUMA 比率（NUMA Ratio）**：远端延迟/本地延迟，通常为 2-3 倍。在内存密集型应用中，如果大量数据分配在远端 NUMA 节点，实际吞吐量可能损失 30-50%。NUMA 比率不是固定的——它取决于互联总线带宽、内存通道数、缓存命中率。同代 CPU 的 NUMA 比率相对稳定，但跨代可能变化——譬如 Intel 从 QPI 升级到 UPI 时，NUMA 比率有所下降（UPI 带宽更高）。

### 1.3 查看服务器的 NUMA 拓扑

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

`numastat` 的输出有几个关键指标——`numa_hit`（本地分配成功）、`numa_miss`（本地分配失败，溢出到远端）、`numa_foreign`（别的节点溢出到本节点）。`numa_miss` 高说明"本节点内存不够，被迫分配到远端"——这是 NUMA 不均衡的信号。但 `numa_miss` 是累积值，要看"增长率"而非绝对值——用 `watch -n 5 numastat` 看 5 秒内的变化，如果 `numa_miss` 增长很快，说明当前有活跃的远端分配；如果几乎不增长，说明历史上有过远端分配但当前没有。**`numa_miss` 的增长率比绝对值更重要**——这是 NUMA 诊断的动态视角。

`numastat` 还有一个与"NUMA hit rate"相关的综合指标——`numa_hit / (numa_hit + numa_miss)` 是本地分配命中率。健康的服务器 hit rate 应该 > 95%——说明绝大多数分配在本地节点。如果 hit rate < 80%，说明 NUMA 不均衡严重，需要调优。但 hit rate 要结合"内存使用量"看——如果节点内存使用率低（譬如 Node 0 用了 50%，Node 1 用了 10%），即使 hit rate 高，也可能有"Node 1 内存闲置"的浪费——这时要考虑"把更多进程放到 Node 1"以均衡负载。**"hit rate"看分配健康度，"节点使用率"看负载均衡度**——两者结合才是完整的 NUMA 健康评估。

### 1.4 numastat -p：定位哪个进程有 NUMA 问题

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

`numastat -p` 是"进程级 NUMA 诊断"的核心工具——它显示进程的内存在各 NUMA 节点的分布。理想状态是"进程的内存全在与 CPU 同节点"——譬如进程跑在 Node 0 的 CPU 上，内存也全在 Node 0。如果内存分散在多个节点，说明有远端访问——这是 NUMA 调优的目标。**`numastat -p` 定位"哪个进程有 NUMA 问题"，`numastat` 定位"系统级 NUMA 健康度"**——前者是进程级诊断，后者是系统级监控，两者配合使用。

NUMA 诊断有一个与"多线程"相关的复杂性——多线程进程的线程可能分布在多个 NUMA 节点上（譬如 16 线程的 Java 服务，8 线程在 Node 0，8 线程在 Node 1）。这种情况下，"进程的内存应该在哪"没有简单答案——Node 0 的线程希望内存在 Node 0，Node 1 的线程希望内存在 Node 1，但内存只能在一个地方（除非 interleave）。解法是"线程级 NUMA 绑定"——用 `pthread_setaffinity_np` 把线程绑定到特定 NUMA 节点的 CPU，再用 `mbind` 把线程的内存绑定到同节点。这要求应用感知 NUMA（譬如 JVM 的 `-XX:+UseNUMA` 让 G1GC 的 Region 按 NUMA 节点分配）。**多线程进程的 NUMA 优化要"线程级绑定 + 内存级绑定"配合**——这是比单线程进程更复杂的调优维度。

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

`numactl` 的三种策略——`--membind`（严格绑定，不足报错）、`--preferred`（优先绑定，不足溢出）、`--interleave`（交错分配）——对应三种场景。`--membind` 适合"内存够用"的场景（譬如 8GB 进程在 128GB 节点上），严格绑定避免任何远端访问。`--preferred` 适合"内存可能不够"的场景（譬如 100GB 进程在 128GB 节点上，紧张时溢出），比 `--membind` 安全。`--interleave` 适合"大内存 + 带宽优先"的场景（譬如 Spark 的 200GB 内存），用延迟换带宽。**`--membind` 求确定性，`--preferred` 求安全，`--interleave` 求带宽**——三种策略各有适用场景，不能混用。

`numactl` 还有一个与"网卡"相关的实践——网卡的硬件中断由特定 NUMA 节点的 CPU 处理，网络数据包的内存也分配在该节点。如果应用跑在另一个 NUMA 节点，从网卡到应用的路径要跨节点——网络包先到 Node 0（网卡所在），再通过 QPI 传到 Node 1（应用所在），增加延迟。所以网络密集型应用要"与网卡同 NUMA 节点"——用 `numactl --cpunodebind=<网卡所在节点>` 绑定。查看网卡所在 NUMA 节点用 `cat /sys/class/net/eth0/device/numa_node`。**网络应用的 NUMA 绑定要考虑网卡位置**——这是 NUMA 优化与网络优化的交叉点。

网卡与 NUMA 的关系还有一个与"多网卡"相关的复杂性——多网卡服务器可能网卡分布在不同 NUMA 节点（譬如 eth0 在 Node 0，eth1 在 Node 1）。如果应用用 eth0 收包、用 eth1 发包，数据包要跨节点——收包在 Node 0，发包在 Node 1，数据要从 Node 0 传到 Node 1。解法是"网卡绑定与应用绑定一致"——用 eth0 的应用绑到 Node 0，用 eth1 的应用绑到 Node 1。对于双网卡bonding（譬如 LACP），bonding 驱动会轮流用两个网卡，数据包可能从任一网卡收发——这种情况下 NUMA 亲和性难以保证，建议用 `numactl --interleave=all` 让应用内存跨节点，避免"收包节点与应用节点不匹配"的延迟。**多网卡场景的 NUMA 优化要"网卡 + 应用 + 内存"三者一致**——这是网络密集型应用的 NUMA 调优难点。

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

AutoNUMA 的设计初衷是"让不感知 NUMA 的应用也能获得 NUMA 优化"——内核自动迁移内存，应用无需修改。但它的代价是"page fault + 迁移抖动"——标记页面为 PROT_NONE 后，进程首次访问触发 page fault，这个 fault 有微秒级开销；迁移页面时 TLB shootdown 让所有 CPU 刷新 TLB，有毫秒级开销。对延迟不敏感的批处理任务，这些开销可接受；对 P99 < 1ms 的延迟敏感服务，这些开销是抖动来源。**AutoNUMA 适合"不感知 NUMA 的普通应用"，不适合"延迟敏感 + 已手动绑定"的应用**——这是 AutoNUMA 的边界。

AutoNUMA 还有一个与"迁移准确性"相关的局限——它基于"页面访问频率"决定迁移，但"访问频率高"不等于"应该迁移到该 CPU"。譬如一个页面被 Node 0 和 Node 1 的线程交替访问（各 50%），AutoNUMA 可能根据微小的频率差异决定迁移到 Node 0，但 Node 1 的线程仍要远端访问——迁移没有解决问题，反而增加了迁移开销。这种"交替访问"模式是 AutoNUMA 的盲区——它适合"明显偏向某一节点"的访问模式，不适合"均匀分布"的模式。**AutoNUMA 对"偏斜访问"有效，对"均匀访问"无效甚至有害**——这是 AutoNUMA 的适用边界。

AutoNUMA 的替代方案是 `numad` 守护进程——一个用户态的 NUMA 优化服务，它比内核的 AutoNUMA 更智能——`numad` 不仅看页面访问频率，还看进程的 CPU 亲和性和内存分布，综合决定迁移策略。`numad` 适合虚拟化环境（KVM）——它能把 VM 的 vCPU 和内存绑定到同一 NUMA 节点，减少 VM 内部的 NUMA 远端访问。但 `numad` 已经较少维护，现代实践更推荐"手动绑定 + 关闭 AutoNUMA"——对于已知访问模式的应用（数据库、缓存），手动绑定比自动迁移更可靠。**`numad` 是"智能 AutoNUMA"，但现代实践倾向"手动绑定"**——这是 NUMA 优化的工具演化。

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

NUMA 问题的量化有一个与"延迟 vs 带宽"相关的分维度——远端访问的延迟是本地的 2-3 倍（延迟维度），但远端访问的带宽可能不降反升（如果用 interleave 让两个节点的内存通道并行）。所以 NUMA 优化的目标要分清——如果瓶颈是延迟（譬如 Redis 的单次访问），要"本地绑定"（消除远端访问）；如果瓶颈是带宽（譬如 Spark 的批量扫描），要"交错分配"（利用多节点带宽）。**NUMA 优化"延迟看本地绑定，带宽看交错分配"**——两个目标对应两种策略，不能混用。

NUMA 优化还有一个与"内存分配时机"相关的细节——`numactl --membind` 只影响"启动后的新分配"，不影响"已分配的内存"。如果一个进程已经运行了一段时间，内存分散在多个节点，再用 `numactl --membind` 绑定不会让已有内存迁移——只有新分配的内存才遵守绑定策略。所以 NUMA 绑定要在"进程启动时"做，而非"运行中"做。如果必须对运行中的进程做 NUMA 迁移，要用 `migrate_pages` 系统调用或 `numad` 守护进程——但这有 TLB shootdown 开销。**NUMA 绑定"启动时做"最优，"运行中做"有开销**——这是 NUMA 优化的时序原则。

NUMA 绑定还有一个与"容器"相关的特殊场景——容器（Docker/Kubernetes）内的进程默认看不到宿主机的 NUMA 拓扑，`numactl` 在容器内可能无效或报错。Kubernetes 的 `numaPolicy`（Resource Manager 的一部分）能让 Pod 感知 NUMA——`numaPolicy: single-numa-node` 让 Pod 的 CPU 和内存绑定到同一 NUMA 节点。但这需要 Kubernetes 1.22+ 且启用 CPU Manager 的 static 策略。在容器化环境中，NUMA 优化是"平台能力"而非"应用能力"——业务方要 NUMA 绑定，需要平台方配置。**容器中的 NUMA 优化依赖平台支持**——这与第 03 篇的"容器中的调度优化依赖平台"是同一模式。

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

TLB Miss 的影响有一个与"工作集大小"相关的非线性特征——当工作集小于 TLB 覆盖范围时，TLB Miss 率接近 0（所有页都在 TLB 中）；当工作集略大于 TLB 覆盖范围时，TLB Miss 率急剧上升（频繁淘汰和重载）；当工作集远大于 TLB 覆盖范围时，TLB Miss 率趋于稳定（每次访问几乎都 miss）。这个"阈值效应"意味着——4KB 页面下，6MB 是 TLB 性能的"悬崖"；2MB 大页下，3GB 是新的"悬崖"。**大页把 TLB 的"性能悬崖"从 6MB 推到 3GB**——让大多数应用的工作集落在悬崖之内，TLB Miss 从"常态"变成"罕见"。

大页的收益有一个与"工作集大小"相关的阈值——只有当工作集大于 4KB 页面的 TLB 覆盖范围（6MB）时，大页才有显著收益。如果工作集只有 1MB（譬如一个小型 API 服务），4KB 页面的 TLB 就能覆盖，大页无收益（甚至有副作用——大页的内存浪费）。所以大页优化要"先测工作集大小"——用 `perf stat -e dTLB-load-misses` 看 TLB Miss 率，如果 Miss 率 < 1%，大页收益有限；如果 Miss 率 > 5%，大页收益显著。**大页优化的前提是"TLB Miss 率高"**——没有 TLB Miss 问题的应用不需要大页。

大页收益的评估还有一个与"perf"相关的精确测量方法——`perf stat -e dTLB-loads,dTLB-load-misses,iTLB-loads,iTLB-load-misses` 分别测量数据和指令的 TLB 访问与 Miss。`dTLB-load-misses / dTLB-loads` 是数据 TLB Miss 率，`iTLB-load-misses / iTLB-loads` 是指令 TLB Miss 率。数据 TLB Miss 率高（> 3%）说明工作集大，要用大页；指令 TLB Miss 率高说明代码量大（譬如大型 JVM 应用），也要用大页。两者都高时，大页收益最大。**`perf stat` 的 TLB 计数器是"大页收益评估"的精确工具**——比"凭感觉判断工作集大小"更可靠。

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

静态大页的预分配有一个与"内存碎片"相关的时序问题——大页需要连续的 2MB 物理内存，系统运行时间长后内存碎片化，连续 2MB 块减少，`vm.nr_hugepages` 可能分配失败。所以大页预分配要在"系统启动早期"做——此时内存还没碎片化，连续 2MB 块充足。内核启动参数 `hugepages=4096` 是最可靠的方式——在内核启动早期分配，保证成功。`sysctl` 方式在系统运行后设置，可能因碎片化失败。**大页预分配"越早越好"——启动参数 > sysctl > 运行时分配**——这是大页配置的时序原则。

大页预分配还有一个与"内存浪费"相关的权衡——预分配的大页是"独占"的，即使应用不用，其他应用也不能用这部分内存。譬如预分配 8GB 大页，但应用只用了 4GB，剩余 4GB 大页闲置，普通应用无法使用。所以大页预分配要"按需"——根据应用实际需求设置 `vm.nr_hugepages`，不要过度预分配。一个实践是"先测应用的大页使用量，再设预分配"——用 `perf stat` 测 TLB Miss 率确认需要大页，再根据应用的 Heap 大小计算大页数量。**大页预分配"按需设置"，过度预分配浪费内存**——这是大页配置的容量原则。

大页配置还有一个与"NUMA"相关的分配策略——`/sys/devices/system/node/nodeN/hugepages/hugepages-2048kB/nr_hugepages` 可以按 NUMA 节点分配大页。譬如 Node 0 分 2048 个 2MB 大页（4GB），Node 1 分 2048 个（4GB），共 8GB。这样每个节点都有本地大页，绑到该节点的应用能用本地大页，避免"大页跨节点访问"的尴尬（大页省了 TLB Miss，但 NUMA 远端访问又加回延迟）。**NUMA 感知的大页分配让"大页 + NUMA"双重优化**——这是大页配置的进阶实践。

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

大页的使用方式有一个与"应用感知"相关的分层——`MAP_HUGETLB` 是"应用显式使用"（修改代码），`LD_PRELOAD` 是"透明替换"（不改代码但改环境），JVM 的 `-XX:+UseLargePages` 是"运行时配置"（不改代码改启动参数），THP 是"内核自动"（什么都不改）。从"显式"到"自动"，控制力递减但易用性递增。**显式方式控制力强但侵入性高，自动方式易用但可能有副作用**——这是大页使用的权衡，要根据应用场景选择。

大页的使用还有一个与"1GB 大页"相关的极端场景——1GB 大页需要 BIOS 支持（或内核启动参数 `hugepagesz=1G`），且要求连续的 1GB 物理内存。1GB 大页的 TLB 覆盖范围极大（1536 × 1GB = 1.5TB），适合 TB 级工作集的应用（譬如大型内存数据库 SAP HANA）。但 1GB 大页的分配极难——系统运行后几乎不可能找到连续 1GB 物理内存，必须在启动时预分配。且 1GB 大页的内存浪费严重——分配一个 1GB 大页就占用 1GB，即使应用只用 1MB。**1GB 大页是"极端场景的极端方案"**——只适合 TB 级工作集 + 启动时预分配的场景，普通应用用 2MB 大页够。

2MB 大页与 1GB 大页的选择有一个与"TLB 条目数"相关的细节——CPU 的 L2 TLB 通常区分 4KB 页条目和 2MB 页条目（譬如 Intel 的 L2 TLB 有 1536 个 4KB 条目 + 16 个 2MB 条目）。这意味着 2MB 大页的 TLB 条目数有限（16 个，覆盖 32MB）——如果工作集超过 32MB，2MB 大页也会 TLB Miss。但 2MB 大页的 TLB Miss 代价比 4KB 低——每次 Miss 只遍历 3 级页表（而非 4 级），且一个 2MB 大页 Miss 后，后续 2MB 内的访问都命中。**2MB 大页的 TLB 条目数有限，但 Miss 代价低**——这是 2MB 大页的"有限但够用"特点，也是为什么 1GB 大页在 TB 级场景有不可替代的价值。

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

THP 的 `madvise` 模式是"两全其美"的折中——应用可以通过 `madvise(MADV_HUGEPAGE)` 显式请求大页（譬如 JVM 的 `UseTransparentHugePages`），内核只为这些请求的内存分配大页，不自动扫描其他内存。这样既享受了大页的 TLB 优化，又避免了 `khugepaged` 对其他内存的扫描抖动。**`madvise` 是"应用控制 + 内核执行"的协作模式**——比 `always`（内核全自动）安全，比 `never`（完全禁用）灵活，是生产环境的推荐配置。

THP 的 `defer+madvise` defrag 模式还有一个与"内存碎片整理"相关的细节——当大页分配失败时，内核可以触发"内存碎片整理"（compaction）来腾出连续 2MB 块，但整理过程会持有锁、移动页面，有毫秒级抖动。`defer` 前缀让碎片整理"延迟"到内存压力低时做，避免在分配时同步整理。`defer+madvise` 是"只对 madvise 标记的内存做延迟碎片整理"——既支持应用请求的大页，又避免碎片整理的同步抖动。**`defer+madvise` 是 THP defrag 的生产推荐配置**——比 `always`（同步整理，抖动大）安全，比 `never`（不整理，大页分配失败率高）有效。

THP 还有一个与"内存碎片化监控"相关的指标——`/proc/vmstat` 的 `compact_stall` 计数器记录"内存碎片整理的直接回收"次数。`compact_stall` 高说明系统在频繁做碎片整理（因为大页分配失败触发整理），这是内存碎片化的信号。解法是"减少碎片"——重启系统（最彻底）、用 `compaction` 主动整理（`echo 1 > /proc/sys/vm/compact_memory`）、或减少大页使用（用静态大页替代 THP）。**`compact_stall` 是内存碎片化的早期信号**——比"大页分配失败率"更早发现碎片化问题。

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

内存带宽饱和有一个与"加核"相关的反直觉现象——当带宽饱和时，加核不仅无益，可能有害。原因是加核后更多线程同时访问内存，带宽竞争更激烈，每个线程的有效带宽反而下降。这就像一条高速公路已经堵车，再加入口让更多车进来，只会让所有人更慢。**带宽饱和时"加核无效甚至有害"**——这是与"CPU 瓶颈加核有效"相反的优化方向，要先诊断瓶颈类型再决定加核还是优化带宽。

内存带宽饱和还有一个与"DDR5"相关的硬件升级路径——DDR5 相比 DDR4 有两个改进：频率更高（DDR5-4800 vs DDR4-3200，带宽提升 50%）和通道数翻倍（DDR5 每通道 2 个子通道，有效并发翻倍）。一个 8 通道 DDR5-4800 服务器的理论带宽是 8 × 4800 × 8 = 307 GB/s，比 DDR4-3200 的 204 GB/s 高 50%。但 DDR5 的延迟没有显著改善（甚至略高）——DDR5 是"带宽优先于延迟"的演进。所以 DDR5 升级对带宽饱和的应用有效，对延迟敏感的应用收益有限。**DDR5 是"带宽升级"，不是"延迟升级"**——这是内存硬件演进的取向，也是选型时要考虑的。

内存硬件的演进还有一个与"持久内存（PMEM）"相关的分支——Intel 的 Optane PMEM 是一种"介于 DRAM 和 SSD 之间"的存储介质，延迟比 DRAM 高（~300ns vs ~100ns），但容量大（128GB/条 vs 32GB/条）且持久（断电不丢）。PMEM 可以作为"大容量 NUMA 节点"——用 `ipmctl` 把 PMEM 配置为 Memory Mode（对应用透明，内核当作慢速 DRAM）或 App Direct Mode（应用显式用 `mmap` 访问）。PMEM 适合"大工作集 + 延迟不敏感"的场景（譬如大型内存数据库的冷数据）。但 Intel 已于 2022 年停产 Optane PMEM，PMEM 的未来不确定——后续可能由 CXL 内存（CXL 3.0 支持内存扩展）替代。**PMEM 是"大容量慢速内存"的尝试，CXL 是其继任者**——这是内存硬件的演进方向。

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

STREAM 的四种操作——Copy（拷贝）、Scale（缩放）、Add（加法）、Triad（三元运算）——代表不同的内存访问模式。Copy 是最简单的（读一个、写一个），Triad 最复杂（读两个、写一个、还有运算）。Triad 通常带宽最低，因为它对内存控制器的压力最大——同时有多个读和写请求。**STREAM 的 Triad 是"最接近真实负载"的带宽指标**——它模拟了"读数据 + 计算 + 写结果"的典型模式，比单纯的 Copy 更能反映实际应用的带宽需求。

STREAM 的结果解读有一个与"数组大小"相关的注意点——`STREAM_ARRAY_SIZE` 要足够大（通常 > LLC 大小），否则数据在 L3 缓存中命中，测的是缓存带宽而非内存带宽。一个典型错误是"数组设太小，测出 500GB/s"——这远超 DRAM 带宽上限，说明数据在缓存中。正确的设置是数组大小 > LLC 容量的 4 倍（譬如 LLC 32MB，数组要 > 128MB），确保每次访问都穿透到 DRAM。**STREAM 测的是"DRAM 带宽"，数组大小要超过 LLC**——这是 STREAM 测试的方法论要点。

STREAM 的结果还有一个与"线程数"相关的配置——`OMP_NUM_THREADS` 控制并行线程数。线程数太少（譬如 4 线程在 32 核机器上）无法打满内存带宽；线程数太多（譬如 64 线程在 32 核机器上）线程切换开销增加。最佳线程数通常是"物理核数"或"物理核数 - 1"（留一个核给系统）。但要注意"NUMA 线程分布"——如果所有线程都在 Node 0，只测了 Node 0 的带宽；要测整机带宽，用 `numactl --interleave=all` 让内存跨节点，线程分布在所有节点。**STREAM 的线程数和 NUMA 策略影响测试结果**——要明确"测什么带宽"再配置。

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

内存带宽的诊断有一个与"LLC Miss"相关的间接判断法——如果 `LLC-load-misses` 极高（L3 缓存命中率低），说明大量请求穿透到 DRAM，内存带宽压力大。但 LLC Miss 高不一定是带宽饱和——也可能是延迟敏感（每次 Miss 要等 100ns，但总带宽没饱和）。区分方法是看"带宽利用率"和"延迟"——如果带宽利用率 > 80% 且延迟升高，是带宽饱和；如果带宽利用率低但延迟高，是延迟问题（譬如 TLB Miss 或 NUMA 远端访问）。**"LLC Miss 高"指向内存压力，"带宽利用率"区分饱和与延迟**——两者配合才能精确诊断。

内存带宽的诊断还有一个与"多核竞争"相关的现象——当多个核同时访问内存时，有效带宽会下降（内存控制器要仲裁多个请求）。譬如单核 STREAM 测出 150GB/s，但 32 核同时跑 STREAM 可能只测出 180GB/s（而非 32 × 150 = 4800GB/s）——内存总线是共享资源，多核竞争让每核有效带宽下降。这种"多核带宽稀释"是带宽饱和的早期信号——即使总带宽没到上限，单核带宽已经开始下降。**"多核带宽稀释"是带宽饱和的早期信号**——比"总带宽到上限"更早出现，是预防性诊断的指标。

多核带宽稀释还有一个与"NUMA 交错"相关的缓解手段——当多核竞争同一节点的内存总线时，把内存 interleave 到多节点能让多核分散到不同内存控制器，减少竞争。譬如 32 核全在 Node 0 跑 STREAM，Node 0 的内存总线饱和（100GB/s）；如果内存 interleave 到 Node 0 和 Node 1，32 核的访问分散到两个内存控制器，有效带宽翻倍（200GB/s）。**interleave 缓解"多核带宽稀释"**——这是 interleave 在"带宽饱和前"的预防性价值，不只是"带宽饱和后"的补救。

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

内存带宽优化有一个与"数据局部性"相关的核心原则——"减少从 DRAM 读取的次数"比"提高 DRAM 带宽利用率"更重要。原因是 DRAM 带宽是有限的（200GB/s 上限），而缓存复用可以把"从 DRAM 读取"降到接近 0。一个优化良好的算法，即使工作集远超 LLC，也能通过分块让每个块在 LLC 中复用多次，DRAM 带宽需求降到很低。**"缓存复用"是带宽优化的第一原则，"交错分配"是第二原则，"数据压缩"是第三原则**——按优先级排序，先复用再扩带宽再减数据量。

内存带宽优化还有一个与"数据结构"相关的底层手段——SoA（Structure of Arrays）比 AoS（Array of Structures）对带宽更友好。譬如一个粒子系统有 100 万个粒子，每个粒子有 x/y/z/vx/vy/vz 六个属性。AoS 布局是 `struct{float x,y,z,vx,vy,vz} particles[1000000]`——访问 x 时会把 y/z/vx/vy/vz 也加载到缓存行（因为它们相邻）。SoA 布局是 `struct{float x[1000000],y[1000000],...} particles`——访问 x 时只加载 x 数组，不加载无关属性。SoA 让内存访问更"纯"（只加载需要的数据），有效带宽利用率更高。这在 [[02 CPU 微架构优化]] 中已详细讲过，这里从带宽角度再强调——**SoA 减少"无效加载"，提高有效带宽利用率**——这是数据结构对带宽的影响。

数据结构对带宽的影响还有一个与"列式存储"相关的数据库实践——列式数据库（ClickHouse、Apache Arrow）把同一列的数据连续存储，扫描一列时是顺序访问（带宽利用率高）；行式数据库（MySQL InnoDB）把一行的多列连续存储，扫描某一列时要跳过其他列（带宽利用率低）。这就是为什么分析型查询（聚合、过滤）在列式数据库中快——不仅减少了 IO（只读需要的列），还提高了内存带宽利用率（顺序访问）。**列式存储是"为带宽优化"的数据布局**——这是数据库架构与内存带宽的深层关系。

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

Redis 的内存调优清单有一个与"单线程"相关的特殊性——Redis 是单线程的（核心逻辑），所以 NUMA 绑定到单节点最优（不需要 interleave，因为单线程无法利用多节点带宽）。而多线程应用（譬如 MySQL 的多线程 buffer pool）可能需要 interleave 来让所有线程都能利用多节点带宽。**单线程应用"本地绑定"，多线程应用"按需 interleave"**——这是 NUMA 策略与线程模型的关系。

Redis 的调优清单还有一个与"持久化"相关的特殊点——Redis 的 `BGSAVE` 用 `fork()` 创建子进程，子进程写 RDB 文件。`fork()` 后父子进程共享内存页（CoW），如果 THP 开启，任何一次写都会触发整个 2MB 大页的 CoW 复制——内存膨胀严重。所以 Redis 要"禁用 THP"——这是 Redis 特有的调优点（其他不用 `fork()` 的应用没这个问题）。如果 Redis 用 AOF 而非 RDB，`fork()` 频率低（只在 rewrite 时），THP 的影响小一些，但仍建议禁用以避免 rewrite 时的内存膨胀。**Redis 禁用 THP 是"fork + CoW"的特殊要求**——这是 Redis 内存调优的独特之处。

Redis 的内存调优还有一个与"内存碎片"相关的指标——`INFO memory` 的 `mem_fragmentation_ratio` 是 `used_memory_rss / used_memory`，反映内存碎片程度。比率 > 1.5 说明碎片严重（RSS 比实际用得多）——可能是 `jemalloc` 的 arena 碎片或 THP 的 2MB 对齐浪费。解法是重启 Redis（释放碎片）或用 `MEMORY PURGE` 命令（ jemalloc 主动归还内存）。**`mem_fragmentation_ratio` 是 Redis 内存健康的"温度计"**——定期监控，> 1.5 时要处理。

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

JVM 的内存调优有一个与"GC + NUMA"相关的特殊点——JVM 的 GC 要扫描整个 Heap，如果 Heap 跨多个 NUMA 节点，GC 扫描时会触发大量跨节点内存访问，GC 停顿时间延长。G1GC 的 Region 化设计能缓解这个问题——Region 按 NUMA 节点分配，GC 优先扫描本节点的 Region，减少跨节点访问。ZGC 更进一步——它的着色指针和读屏障让 GC 与应用并发，不需要 STW 扫描整个 Heap。**JVM 的 GC 选型要考虑 NUMA 影响**——G1GC 的 Region 化适合 NUMA，ZGC 的并发适合大 Heap，CMS（已废弃）的 STW 扫描不适合大 Heap + NUMA。

JVM 的内存调优还有一个与"对象分配"相关的细节——JVM 的对象分配在 TLAB（Thread Local Allocation Buffer）中，每个线程有自己的 TLAB，分配无锁。TLAB 的大小影响内存碎片和 NUMA 亲和性——TLAB 太小（默认几 KB）会导致频繁申请新 TLAB，可能从其他 NUMA 节点分配；TLAB 太大（几 MB）会浪费内存。JVM 的 `-XX:+UseNUMA` 让 TLAB 按 NUMA 节点分配——每个线程的 TLAB 在线程所在 NUMA 节点，保证对象分配的 NUMA 亲和性。**JVM 的 TLAB + UseNUMA 是"对象级 NUMA 优化"**——比 Heap 级的 interleave 更精细，让每个对象都在正确的 NUMA 节点。

JVM 的内存调优还有一个与"堆外内存"相关的盲区——JVM 的 DirectByteBuffer（Netty 常用）和 MappedByteBuffer（文件 mmap）是堆外内存，不受 JVM 的 NUMA 策略控制。它们的 NUMA 分配取决于操作系统的默认策略——通常是"第一个 touch 的 CPU 所在节点"。如果 Netty 的 IO 线程在 Node 0，DirectByteBuffer 分配在 Node 0；但如果 IO 线程迁移到 Node 1，后续访问就是远端。解法是"IO 线程绑定 + DirectByteBuffer 分配在同节点"——用 `numactl --cpunodebind` 绑定整个 JVM，或用 Netty 的 `EventExecutorGroup` 绑定线程到特定 CPU。**JVM 堆外内存的 NUMA 优化要"IO 线程 + 缓冲区"同节点**——这是 JVM + Netty 的 NUMA 调优细节。

---

## 第 6 章 内存调优的边界与盲区

### 6.1 NUMA 优化无法解决缓存命中率低

NUMA 优化能减少"跨节点访问的延迟"，但不能减少"缓存 Miss 的次数"。如果一个应用的缓存命中率低（譬如随机访问大数组），即使所有数据都在本地 NUMA 节点，每次访问仍要穿透到 DRAM（100ns 延迟）。NUMA 优化把"远端 DRAM 访问（120ns）"变成"本地 DRAM 访问（40ns）"，但仍然是 DRAM 访问——比缓存命中（10ns）慢得多。**NUMA 优化是"DRAM 内的优化"，缓存优化是"避免 DRAM 访问"**——后者收益更大，要先做缓存优化（数据结构、访问模式、分块），再做 NUMA 优化。

NUMA 优化的优先级有一个经验排序——先缓存优化（命中率从 50% 到 90%，收益 5 倍），再大页优化（TLB Miss 从 10% 到 1%，收益 1.5 倍），再 NUMA 优化（远端访问从 50% 到 10%，收益 1.3 倍）。缓存优化收益最大，因为它避免了 DRAM 访问；大页次之，它减少了地址翻译开销；NUMA 最小，它只是把"远端 DRAM"变成"本地 DRAM"。**内存优化的优先级是"缓存 > 大页 > NUMA"**——按收益排序，先做收益大的，避免在低收益优化上浪费时间。

### 6.2 大页无法解决缓存 Miss

大页优化 TLB Miss，但不优化 Cache Miss——大页减少的是"地址翻译"的开销，不是"数据加载"的开销。如果一个应用的 Cache Miss 率高（譬如随机访问大数组），大页能让"每次 Miss 后的地址翻译更快"，但 Miss 本身仍要等 DRAM 延迟。**大页优化"翻译"，缓存优化"加载"**——两者独立，大页不能替代缓存优化。一个常见的误区是"用了大页就不用管缓存了"——大页只省了 TLB Miss，Cache Miss 仍要靠数据结构优化和分块。

大页与缓存的关系还有一个微妙的交互——大页可能"降低"缓存命中率。原因是 2MB 大页在 TLB 中只占一个条目，但它的数据在 L1/L2 缓存中仍占多个缓存行（2MB / 64B = 32768 个缓存行）。如果应用只访问大页中的少量数据（譬如一个 2MB 数组只访问前 1KB），大页会让整个 2MB 都在 TLB 中，但 L1/L2 缓存只缓存访问的部分——这没问题。但如果应用随机访问大页中的多个位置，2MB 的数据可能把 L1/L2 缓存填满（L1 通常 32-48KB，一个 2MB 大页就超了），导致缓存抖动。**大页对"顺序访问"友好，对"随机访问少量数据"可能不友好**——这是大页与缓存交互的微妙之处。

### 6.3 内存带宽优化无法解决延迟问题

带宽和延迟是内存性能的两个独立维度——带宽是"单位时间能传多少数据"，延迟是"一次访问要等多久"。带宽优化（interleave、压缩）能提高"吞吐量"，但不降低"单次访问延迟"——interleave 让一半访问是远端（延迟更高），压缩增加解压延迟。所以延迟敏感的应用（Redis）要"本地绑定 + 小工作集"（低延迟），带宽敏感的应用（Spark）要"interleave + 大工作集"（高带宽）。**"延迟优化"和"带宽优化"方向相反**——前者集中（本地、小集），后者分散（interleave、大集），不能同时优化。

延迟与带宽的矛盾还有一个与"应用类型"相关的判断——延迟敏感型应用（Redis、交易系统）的瓶颈通常是"单次访问延迟"，要"本地绑定 + 小工作集 + 大页"（减少每次访问的延迟）；带宽敏感型应用（Spark、ML 推理）的瓶颈是"总数据吞吐量"，要"interleave + 大工作集 + 顺序访问"（提高总带宽）。判断应用类型的方法是看"访问模式"——随机访问 + 低 QPS 是延迟敏感，顺序扫描 + 高吞吐是带宽敏感。**延迟敏感和带宽敏感是"两种应用、两个方向"**——先判断应用类型，再选优化方向，不能盲目套用。

---

## 第 7 章 小结

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

内存性能调优的核心认知是"内存不是统一的"——同一个物理内存，访问延迟因 NUMA 节点而异（40ns vs 120ns），因页大小而异（TLB Miss 多 200 cycles），因访问模式而异（顺序带宽高、随机延迟高）。**"内存性能"不是一个数字，而是"拓扑 + 页大小 + 访问模式"的复合函数**——理解这个复合函数，才能针对性优化。下一篇进入存储层，磁盘 IO 的性能调优有类似的"拓扑 + 模式"复杂性。

内存性能调优的认知框架可以总结为一个核心命题——**"内存访问不是免费的"**。每次内存访问都有代价——延迟（40ns 本地、120ns 远端）、带宽（共享总线竞争）、翻译（TLB Miss 200 cycles）。优化的本质是"减少代价"——NUMA 优化减少延迟代价，大页减少翻译代价，带宽优化减少总线竞争代价。但所有优化都有边界——NUMA 优化不能减少 Cache Miss，大页不能减少 Cache Miss，带宽优化不能减少延迟。**内存优化是"减少某一类代价"，不是"消除所有代价"**——这是内存调优的认知边界，也是为什么优化要"先诊断瓶颈类型，再选优化手段"。

下一篇 [[05 磁盘 IO 性能调优——fio 方法论、调度器与 IO 模式]] 将把调优视角移向存储层：`fio` 作为磁盘性能基准测试的标准工具，如何设计测试场景（iodepth/bs/numjobs 三参数的配合）来准确衡量存储设备性能；`blktrace` 如何追踪一个 IO 请求在内核块设备层的完整路径；以及 NVMe SSD 的最佳 IO 模式（`io_uring` vs `libaio` vs 同步 IO）如何选择。

---

## 参考资料

1. John L. Hennessy, David A. Patterson, "Computer Architecture: A Quantitative Approach", 6th edition, 2017.（NUMA 架构与内存层次）
2. Linux kernel documentation, "NUMA Memory Policy". https://www.kernel.org/doc/html/latest/admin-guide/mm/numa_memory_policy.html
3. Linux kernel documentation, "Transparent Hugepage Support". https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html
4. John D. McCalpin, "STREAM: Sustainable Memory Bandwidth in High Performance Computers". https://www.cs.virginia.edu/stream/
5. Intel, "Intel Xeon Scalable Processors Technical Overview"（内存通道与带宽规格）.
6. Brendan Gregg, "Linux Memory Analysis"（perf 与内存性能分析）.
7. Redis 官方文档, "Redis Administration Guide: Transparent Huge Pages (THP)".
8. Oracle, "MySQL InnoDB Buffer Pool Optimization"（buffer pool 与 NUMA）.

---

> [!note] 思考题
> 1. NUMA 架构中 `numactl --interleave=all` 将内存均匀分布在所有节点。在数据库共享缓冲池场景中这是合理的（因为所有 CPU 都访问缓冲池）。但对于单线程应用，interleave 反而增加了一半的远端访问。你如何根据应用的线程模型选择 NUMA 策略？
> 2. 内存带宽是向量化查询引擎和 ML 推理的常见瓶颈。DDR4 双通道约 50GB/s。`perf stat` 的 `LLC-load-misses` 表示 L3 Miss（需要访问主存）——如果这个值很高，说明应用受内存带宽限制。除了升级内存（DDR5）和增加通道数，应用层有什么优化手段？
> 3. 在 KVM 虚拟化中，虚拟机的 vCPU 可能被调度到不同 NUMA 节点的物理核上，导致内存访问延迟不可预测。`virsh numatune` 和 `vcpupin` 如何解决？在 OpenStack/K8s 环境中，如何在调度层面保证 VM/Pod 的 NUMA 亲和性？
