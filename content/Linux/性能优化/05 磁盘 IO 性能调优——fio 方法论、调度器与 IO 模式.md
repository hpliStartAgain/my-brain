---
title: "磁盘 IO 性能调优——fio 方法论、调度器与 IO 模式"
date: 2026-03-02
tags: [blktrace, fio, iodepth, iostat, IO性能测试, IO调度器, Linux, NVMe, SSD, 性能优化, 性能调优, 磁盘IO, blk-mq, mq-deadline, bfq, kyber, iotop, Little's Law, libaio]
aliases: ["fio使用指南", "磁盘IO调优", "IO调度器选择", "blktrace分析", "NVMe性能调优", "iostat诊断", "blk-mq", "IO队列深度"]
---

# 05 磁盘 IO 性能调优——fio 方法论、调度器与 IO 模式

**摘要：**
存储性能问题的诊断常常陷入两个极端：要么直接 `dd if=/dev/sda of=/dev/null`（过于简单，不能反映真实负载）；要么直接在生产上观察应用表现（太晚，无法做事前评估）。`fio`（Flexible IO Tester）是磁盘性能测试的行业标准工具，它的价值不在于能测多快，而在于能**精确模拟目标场景的 IO 模式**——随机还是顺序、读还是写、同步还是异步、队列深度是多少——并以此评估存储设备在真实负载下的性能边界。本文的核心目标是建立 `fio` 的方法论：三个关键参数（`iodepth`/`bs`/`numjobs`）如何联合决定测试结果，如何对应真实应用场景（OLTP 随机读写 vs 日志顺序写 vs 分析型大块扫描）。同时深入 `blktrace` 追踪 IO 请求的内核路径，理解 IO 调度器的选择对延迟和吞吐量的影响，以及如何针对 NVMe SSD 做最优化配置。

---

## 第 1 章 从 HDD 到 NVMe——存储设备的性能跃迁

### 1.1 存储设备的三个时代

理解磁盘 IO 性能调优之前，先回顾存储设备的演化史。1956 年 IBM 推出第一块硬盘（RAMAC 305），5MB 容量，重达 1 吨——这是 **HDD（Hard Disk Drive，机械硬盘）** 时代的起点。HDD 的核心是"旋转的磁盘片 + 移动的磁头"——数据存储在旋转的盘片上，磁头移动到指定位置读写。这种机械结构决定了 HDD 的两个性能特征——随机访问慢（磁头寻道 5-15ms）、顺序访问快（磁头不动，盘片转一圈读完）。HDD 的 IOPS 通常只有 100-200，但顺序吞吐能到 100-200MB/s——"顺序快、随机慢"是 HDD 的本质。

2000 年代，**SSD（Solid State Drive，固态硬盘）** 开始商用——用闪存芯片替代机械结构，没有磁头和盘片，随机访问和顺序访问的延迟几乎相同（都是 100-500µs）。SSD 让 IOPS 从 HDD 的 100 跃升到 10 万（SATA SSD）——三个数量级的提升。但 SSD 仍受限于 SATA 接口（6Gbps 带宽上限 ~550MB/s）和 AHCI 协议（单队列，深度最多 32）。

2010 年代，**NVMe（Non-Volatile Memory Express）** 协议出现——专为闪存设计的 PCIe 接口协议。NVMe 有两个关键改进——多队列（最多 64K 个队列，每队列深度最多 64K）和 PCIe 带宽（PCIe 4.0 x4 = 8GB/s）。NVMe SSD 的 IOPS 达到 50-100 万，吞吐量 3-7GB/s，延迟 20-100µs——又比 SATA SSD 提升了一个数量级。**HDD → SATA SSD → NVMe SSD 是存储性能的三级跳**——每一级都改变了 IO 性能的特征，也改变了 IO 调优的方法论。

这三代存储设备的性能差异不仅是"快慢"之分，更是"性能特征"的根本变化。HDD 的性能特征是"顺序快、随机慢"——寻道时间主导，IO 调度器要"排序请求减少寻道"。SATA SSD 的性能特征是"随机=顺序"——无机械结构，但受限于 SATA 接口和 AHCI 协议的单队列。NVMe SSD 的性能特征是"多队列并行"——PCIe 带宽 + 多队列，IO 调度器要"最少干预"。**每一代存储设备要求不同的调优策略**——HDD 要"排序"，SATA SSD 要"队列管理"，NVMe SSD 要"放手不管"——这是存储演进对调优方法论的重塑。

存储设备的演进还有一个与"接口协议"相关的维度——HDD 用 SATA/SAS 接口 + SCSI/ATA 协议，SATA SSD 也用 SATA 接口 + AHCI 协议，NVMe SSD 用 PCIe 接口 + NVMe 协议。接口协议决定了"带宽上限"和"队列能力"——SATA 6Gbps（~550MB/s）+ AHCI 单队列（深度 32），PCIe 4.0 x4（~8GB/s）+ NVMe 多队列（64K 队列 × 64K 深度）。所以即使闪存芯片速度相同，SATA SSD 和 NVMe SSD 的性能也差 10 倍——瓶颈在接口协议，不在闪存。**接口协议是存储性能的"天花板"**——闪存再快，接口限制了也发挥不出来，这是 NVMe 相比 SATA SSD 的根本优势。

存储设备的演进还有一个与"持久性"相关的维度——HDD 是磁性存储（断电不丢，持久性高），SSD 是闪存存储（断电不丢，但有写寿命），而新兴的"持久内存"（PMEM）和"存储级内存"（SCM）是"DRAM 速度 + 闪存持久性"的混合。这些新介质模糊了"内存"和"存储"的边界——PMEM 既能当内存用（mmap 后直接访问），又能当存储用（文件系统挂载）。未来的存储层级可能是"DRAM → PMEM → NVMe SSD → HDD"四级——每级延迟差 10 倍，容量差 10 倍。**存储介质的多元化让 IO 调优更复杂**——不同介质要用不同的 IO 接口和调度策略，"一刀切"的配置不再适用。

存储介质的演进趋势还有一个与"软件定义"相关的方向——"软件定义存储"（SDS）把存储功能（分层、缓存、复制、压缩）从硬件移到软件层。SDS 让"存储性能"不再只取决于硬件——软件的缓存策略、分层策略、压缩策略都能影响性能。譬如 Ceph 的"热数据自动分层"（热数据放 SSD，冷数据放 HDD）让"同一份数据"的性能随访问模式变化——热数据快，冷数据慢。**SDS 让存储性能"动态化"**——性能不再固定，随软件策略变化，调优要从"硬件调优"扩展到"软件策略调优"。

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph LR
    HDD["HDD<br/>IOPS ~150<br/>延迟 5-15ms<br/>顺序快随机慢"]
    SSD["SATA SSD<br/>IOPS ~10万<br/>延迟 100-500µs<br/>随机=顺序"]
    NVMe["NVMe SSD<br/>IOPS ~50-100万<br/>延迟 20-100µs<br/>多队列并行"]

    HDD ==>"|SATA 接口<br/>AHCI 协议|" SSD
    SSD ==>"|PCIe 接口<br/>NVMe 协议|" NVMe

    classDef slow fill:#44475a,stroke:#ff5555,color:#f8f8f2
    classDef mid fill:#282a36,stroke:#ffb86c,color:#f8f8f2
    classDef fast fill:#282a36,stroke:#50fa7b,color:#f8f8f2
    class HDD slow
    class SSD mid
    class NVMe fast
```

### 1.2 存储设备的性能不是一个数字

"这块 SSD 能跑多少 IOPS？"——这个问题的答案取决于：
- **IO 大小（Block Size）**：4KB 随机读 vs 128KB 顺序读，IOPS 差异可以是 10 倍
- **队列深度（Queue Depth / iodepth）**：NVMe SSD 在队列深度 1（同步 IO）时可能只有 5 万 IOPS，队列深度 32 时达到 50 万 IOPS
- **读写比例**：纯读 vs 70/30 读写混合，写操作的 Erase-Program 周期使 SSD 写性能远低于读性能
- **访问模式**：顺序访问（HDD 速度提升 100 倍，SSD 提升 2-5 倍）vs 随机访问
- **IO 引擎**：同步（`sync`）、异步（`libaio`）、`io_uring` 对性能有显著影响

这就是为什么 `dd` 测出来的数字（通常是大块顺序写）对大多数应用场景没有参考价值——OLTP 数据库主要是小块随机 IO，完全不同的性能特征。

### 1.3 存储性能的三个核心指标

```
IOPS（Input/Output Operations Per Second）
  = 每秒完成的 IO 操作数
  适合衡量：小块随机 IO（4KB、8KB）场景
  典型值：HDD ~ 150 IOPS，SATA SSD ~ 10 万 IOPS，NVMe SSD ~ 50-100 万 IOPS

吞吐量（Throughput / Bandwidth）
  = 每秒传输的数据量（MB/s 或 GB/s）
  适合衡量：大块顺序 IO（128KB、512KB、1MB）场景
  典型值：HDD ~ 100-200 MB/s，SATA SSD ~ 500-550 MB/s，NVMe SSD ~ 3-7 GB/s

延迟（Latency）
  = 单次 IO 操作的响应时间（µs 或 ms）
  适合衡量：低延迟敏感场景（交易系统、Redis 持久化）
  典型值：HDD ~ 5-10 ms，SATA SSD ~ 100-500 µs，NVMe SSD ~ 20-100 µs（P99）
```

三个指标之间有内在联系：

```
吞吐量 = IOPS × 块大小
IOPS = 队列深度 / 平均延迟（Little's Law）
```

当队列深度增加时，存储设备内部可以并行处理更多请求（NVMe 的多队列架构），**吞吐量提升，但单次 IO 的延迟也随之增加**（队列中等待的时间更长）——这是延迟和吞吐量之间永恒的权衡。

三个指标的优先级取决于应用场景——OLTP 数据库看 IOPS（小块随机 IO 多）和延迟（P99 敏感），大数据分析看吞吐量（大块顺序扫描），消息队列看延迟和吞吐量的平衡（顺序写 + 低延迟）。**"测什么指标"取决于"应用关心什么"**——盲目追求 IOPS 而忽略延迟，或追求吞吐量而忽略 P99，都是指标错配。

三个指标之间的关系还有一个与"Little's Law"相关的数学约束——IOPS = 队列深度 / 延迟。这个公式意味着，要提高 IOPS，要么"增加队列深度"（让设备并行处理更多请求），要么"降低延迟"（让每个请求更快完成）。增加队列深度是"用延迟换吞吐"——队列深了，每个请求等更久，但总 IOPS 更高。降低延迟是"用硬件换性能"——换更快的 SSD，每个请求更快完成，IOPS 自然更高。**"加队列"是软件手段，"降延迟"是硬件手段**——前者有上限（延迟不能太高），后者有成本（更快的 SSD 更贵），两者结合才能达到目标 IOPS。

Little's Law 还有一个与"拐点"相关的实践——当队列深度增加时，IOPS 先线性增长（设备未饱和），然后增长放缓（设备接近饱和），最后不再增长（设备完全饱和）。这个"拐点"是设备的"饱和队列深度"——超过这个深度，IOPS 不再增加，但延迟继续线性增长。拐点通常在设备 IOPS 的 70-80% 处——譬如 NVMe 50 万 IOPS，拐点在 35-40 万 IOPS 对应的队列深度。**"拐点"是"延迟可接受的最大 IOPS"的参考**——超过拐点，加队列只增延迟不增 IOPS，是"亏本买卖"。

Little's Law 的拐点还有一个与"应用选型"相关的实践意义——不同应用对"延迟 vs IOPS"的敏感度不同。延迟敏感应用（MySQL OLTP）要"在拐点以下运行"——宁可 IOPS 低一点，也要延迟低。吞吐优先应用（Spark 批处理）可以"在拐点以上运行"——延迟高一点没关系，IOPS 越高越好。所以同一个 NVMe SSD，MySQL 配 `iodepth=32`（拐点附近），Spark 配 `iodepth=128`（拐点以上）——两者用不同的队列深度策略。**"拐点"是"延迟敏感 vs 吞吐优先"的分界线**——应用选型决定 iodepth 策略。

iodepth 策略还有一个与"IO 引擎"相关的约束——`sync` 引擎不支持 `iodepth > 1`（同步 IO 一次一个请求），`libaio` 支持 `iodepth` 但要求 `O_DIRECT`（buffered IO 的 `libaio` 会退化为同步），`io_uring` 支持 `iodepth` 且对 buffered/direct 都可用。所以"iodepth 策略"要配合"IO 引擎"——想用深队列必须用 `libaio`（+ direct）或 `io_uring`。**"iodepth > 1 要求异步 IO 引擎"**——这是 iodepth 与 IO 引擎的依赖关系，第 06 篇会详细讲 IO 引擎选型。

---

## 第 2 章 fio：磁盘性能基准测试的正确姿势

### 2.1 fio 的核心参数体系

```bash
# 安装 fio
apt-get install fio  # Ubuntu/Debian
yum install fio      # CentOS/RHEL

# fio 的基本运行方式
fio --name=test --filename=/tmp/testfile --size=10g \
    --rw=randread --bs=4k --iodepth=32 --numjobs=4 \
    --ioengine=libaio --direct=1 --runtime=60 --time_based \
    --output-format=json > result.json
```

**三个最关键的参数**：

**参数 1：`bs`（Block Size，IO 大小）**

```bash
bs=4k    # 4KB：模拟 OLTP 数据库的随机小块 IO（MySQL InnoDB page = 16KB）
bs=16k   # 16KB：MySQL InnoDB 默认 page 大小
bs=128k  # 128KB：Kafka 日志段的典型写入大小
bs=1m    # 1MB：大文件顺序传输（备份、数据迁移）
```

**参数 2：`iodepth`（IO 队列深度）**

```bash
iodepth=1   # 同步 IO：一次只发起一个请求，等待完成后再发起下一个
            # 代表场景：传统同步数据库 write，Redis AOF fsync
iodepth=32  # 浅队列异步：数据库后台刷新
            # NVMe SSD 在此通常达到 70-80% 峰值 IOPS
iodepth=128 # 深队列：充分压榨 NVMe SSD 内部并行性
            # 代表场景：分析型批量扫描，io_uring 批量提交
```

> [!info] 理解 iodepth 与 Little's Law
> Little's Law（排队论）：队列长度 = 到达率 × 平均响应时间
> 换算：**IOPS = iodepth / latency**
>
> 例如：NVMe SSD 单队列延迟 100µs（0.1ms），队列深度 1：IOPS = 1/0.0001 = 10,000
> 同一块 NVMe，队列深度 32：IOPS = 32/0.0001 ≈ 320,000（假设延迟不变）
>
> 实际上延迟会随队列深度上升而增加，但存储设备的内部并行性使 IOPS 仍然大幅提升。

**参数 3：`numjobs`（并发 IO 线程数）**

```bash
numjobs=1   # 单线程（串行测试，反映单流延迟）
numjobs=4   # 4 线程（模拟 4 核应用并发）
numjobs=16  # 16 线程（高并发数据库连接）
```

`iodepth` 是**每个线程的队列深度**，总 IO 并发度 = `iodepth × numjobs`。

三个参数的配合有一个与"压测目标"相关的原则——`bs` 决定"测什么类型的 IO"（小块随机 vs 大块顺序），`iodepth` 决定"测多深的队列"（同步 vs 异步），`numjobs` 决定"测多并发"（单线程 vs 多线程）。三个参数组合起来才能精确模拟目标场景——譬如 MySQL OLTP 是"16KB + iodepth 64 + numjobs 8"，Kafka 是"128KB + iodepth 16 + numjobs 4"。**`bs` + `iodepth` + `numjobs` 是"IO 模式 + 队列深度 + 并发度"的三维定义**——缺一不可，只设一两个会偏离真实场景。

三个参数的配合还有一个与"总并发度"相关的计算——总 IO 并发度 = `iodepth × numjobs`。譬如 `iodepth=32, numjobs=4`，总并发度 128——同时有 128 个 IO 请求在途。这个总并发度要与 NVMe SSD 的硬件队列深度匹配——NVMe 通常支持 1024+ 的队列深度，128 并发度能充分利用。但如果总并发度太低（譬如 `iodepth=1, numjobs=1`，并发度 1），NVMe 的多队列能力浪费——只有一个请求在途，64 个硬件队列只有 1 个在用。**总并发度要与设备能力匹配**——太低浪费设备并行性，太高增加延迟，要找到"设备利用率高 + 延迟可接受"的平衡点。

`numjobs` 的设置还有一个与"CPU 核数"相关的约束——`numjobs` 个线程要消耗 CPU 核，如果 `numjobs` 超过 CPU 核数，线程会相互抢占 CPU，反而降低 IO 提交效率。譬如 8 核机器设 `numjobs=32`，32 个线程争 8 个核，线程切换开销大，IO 提交反而慢。推荐 `numjobs` 不超过 CPU 核数——8 核机器用 `numjobs=8`，每核一个线程，无切换开销。**`numjobs` 受 CPU 核数约束**——这是 fio 参数的硬件限制，不是越大越好。

`numjobs` 的设置还有一个与"线程绑定"相关的进阶实践——`numjobs` 个线程默认由操作系统调度，可能分散在不同 NUMA 节点，导致 IO 提交的 NUMA 远端访问。用 `numactl --cpunodebind=0 fio ...` 把 fio 进程绑到特定 NUMA 节点，能让 IO 提交线程和 NVMe 设备在同节点（如果 NVMe 在 Node 0），减少跨节点开销。对于高 IOPS 测试（譬如 100 万 IOPS），NUMA 绑定能让性能提升 10-15%——这是 fio 测试的"NUMA 优化"。**fio 高 IOPS 测试要"NUMA 绑定 + numjobs 不超核数"**——这是 fio 参数的硬件协同。

### 2.2 模拟真实场景的 fio 配置

**场景 1：OLTP 数据库（MySQL InnoDB）**

```bash
# MySQL InnoDB 主要是 16KB 随机读（buffer pool miss）+ 顺序 redo log 写
fio --name=mysql-like \
    --filename=/data/testfile --size=20g \
    --rw=randrw --rwmixread=70 \   # 70% 读 30% 写（典型 OLTP 比例）
    --bs=16k \                      # InnoDB page size
    --iodepth=64 \                  # MySQL 默认 innodb_io_capacity 相关
    --numjobs=8 \                   # 模拟 8 个并发连接
    --ioengine=libaio \
    --direct=1 \                    # 绕过 Page Cache（innodb 使用 direct io）
    --runtime=120 --time_based \
    --lat_percentiles=1 \           # 输出延迟百分位
    --output-format=json
```

**场景 2：Kafka/日志顺序写**

```bash
# Kafka 是顺序追加写，通常 128KB-1MB 的大块写
fio --name=kafka-like \
    --filename=/data/kafka-test --size=20g \
    --rw=write \                    # 纯顺序写
    --bs=128k \                     # Kafka 默认批量大小
    --iodepth=16 \
    --numjobs=4 \                   # 模拟 4 个 partition
    --ioengine=libaio \
    --direct=0 \                    # Kafka 使用 Page Cache（buffered IO）
    --fsync=0 \                     # Kafka 依赖 OS flush，不每次 fsync
    --runtime=120 --time_based
```

**场景 3：分析型查询（ClickHouse/列式扫描）**

```bash
# ClickHouse 是大块顺序读，充分压榨 NVMe 顺序读带宽
fio --name=clickhouse-like \
    --filename=/data/test --size=100g \
    --rw=read \                     # 顺序读（列式扫描）
    --bs=1m \                       # 大块顺序 IO
    --iodepth=32 \
    --numjobs=8 \                   # 8 个并发扫描线程
    --ioengine=io_uring \           # 最新高性能 IO 引擎
    --direct=1 \
    --runtime=60 --time_based
```

**场景 4：Redis RDB 持久化（大块随机写）**

```bash
# Redis BGSAVE：fork 子进程将全量数据写入 RDB 文件
fio --name=redis-rdb \
    --filename=/data/redis-test --size=8g \
    --rw=write \                    # 顺序写（RDB 是全量写入）
    --bs=4m \                       # 大块写
    --iodepth=4 \
    --numjobs=1 \                   # 单线程（BGSAVE 是单个子进程）
    --ioengine=sync \               # 同步写（BGSAVE 是 write() 系统调用）
    --runtime=60 --time_based
```

这四个场景的 fio 配置展示了"IO 模式决定参数"的实践——MySQL 是"小块随机 + 深队列 + direct IO"（数据库要绕过 Page Cache 自己管理缓存），Kafka 是"大块顺序 + 浅队列 + buffered IO"（Kafka 依赖 Page Cache 做缓冲），ClickHouse 是"大块顺序 + 深队列 + io_uring"（分析型要压榨带宽），Redis RDB 是"大块顺序 + 单线程 + sync"（BGSAVE 是简单的顺序写）。**fio 配置是"应用 IO 模式的镜像"**——理解应用的 IO 模式，才能写出正确的 fio 配置。

fio 配置的"镜像"原则有一个与"验证"相关的实践——写好 fio 配置后，要用 `iostat` 对比 fio 测试时的 IO 模式和生产环境的 IO 模式。如果 fio 测试时 `iostat` 显示 `r_await=0.1ms, aqu-sz=32`，而生产环境 `iostat` 显示 `r_await=45ms, aqu-sz=87`，说明 fio 配置偏离了生产——要么 `iodepth` 设低了（生产 87 vs fio 32），要么 `bs` 设错了。**"fio 配置对不对，用 iostat 对比验证"**——这是 fio 方法论的闭环，避免"测了半天测的不是真实场景"。

fio 配置的验证还有一个与"延迟分布"相关的维度——不仅要对比"平均延迟"，还要对比"P99 延迟"。如果 fio 测出 P99=500µs，但生产环境 P99=45ms，说明生产环境有 fio 没模拟到的"毛刺源"——可能是 GC、fsync、或调度器延迟。fio 的"稳定负载"无法模拟生产的"突发毛刺"，所以 fio 的 P99 通常比生产低——这是 fio 测试的固有局限。**fio 测"稳定态性能"，生产有"突发态毛刺"**——fio 的 P99 是"最好情况"，生产的 P99 是"真实情况"。

fio 与生产的差距还有一个与"混合负载"相关的维度——fio 通常测"纯读"或"纯写"或"固定比例混合"，但生产的读写比例是动态变化的。譬如数据库白天读多（查询），晚上写多（批处理），读写比例从 90:10 变到 30:70。fio 的固定比例无法模拟这种动态——所以 fio 结果只能作为"某一种负载下的性能参考"，不能代表"所有负载下的性能"。要全面评估，要跑多个 fio 测试（不同读写比例），看"性能随负载变化的曲线"。**"fio 测单点，生产是曲线"**——这是 fio 测试的"单点 vs 曲线"局限。

fio 的局限还有一个与"并发模型"相关的维度——fio 的 `numjobs` 个线程是"纯 IO 线程"，它们只发 IO 不做别的；但生产应用的线程是"业务 + IO"混合——线程在做业务计算时不发 IO，IO 队列可能空。所以即使 `numjobs` 和 `iodepth` 设得和生产一致，fio 的"有效并发度"也比生产高——因为 fio 线程不做业务，IO 队列始终满。这意味着 fio 测出的 IOPS 是"理想并发"的上限，生产应用因业务计算"稀释"了并发度，实际 IOPS 更低。**"fio 是纯 IO，生产是 IO + 业务"**——这是 fio 与生产的"并发模型差距"。

### 2.3 解读 fio 输出

```bash
fio --name=test --rw=randread --bs=4k --iodepth=32 \
    --numjobs=4 --ioengine=libaio --direct=1 \
    --filename=/dev/nvme0n1 --size=10g --runtime=60 --time_based

# 输出解读：
# test: (g=0): rw=randread, bs=(R) 4096B, iodepth=32, file=/dev/nvme0n1
# Starting 4 processes
# Jobs: 4 (f=4): [r(4)][100.0%][r=1825MiB/s][r=467k IOPS][eta 00m:00s]
#
# test: (groupid=0, jobs=4):
#   read: IOPS=465k, BW=1816MiB/s (1904MB/s)(106GiB/60001msec)
#                ↑ 总 IOPS   ↑ 总带宽
#
#     clat (usec): min=15, max=2456, avg=274.19, stdev=89.23
#     ↑ 完成延迟（Completion Latency）
#
#      lat (usec) : 10=0.01%, 20=0.13%, 50=2.12%, 100=12.34%,
#                   250=45.67%, 500=38.45%, 750=1.23%, 1000=0.04%,
#                   2000=0.01%
#
#     clat percentiles (usec):
#      |  1.00th=[  143],  5.00th=[  167], 10.00th=[  182]
#      | 20.00th=[  204], 50.00th=[  262], 75.00th=[  318]
#      | 90.00th=[  379], 95.00th=[  420], 99.00th=[  537]  ← P99 延迟 537µs
#      | 99.50th=[  594], 99.90th=[  734], 99.95th=[  814]
#      | 99.99th=[ 1221]                                     ← P9999 延迟 1.2ms
#
#   cpu: usr=2.12%, sys=7.34%, ctx=1234567, majf=0, minf=123
#                        ↑ 系统调用 CPU 开销（libaio 相对较低）
#
#   IO depths    : 1=0.1%, 2=0.1%, 4=0.1%, 8=0.2%, 16=6.2%, 32=93.3%
#                                               ↑ 队列实际深度分布（接近 32 说明设备跟得上）

# 关键指标解读：
# P99 延迟（clat 99th）= 537µs → 这是真实 P99 读延迟的参考值
# 系统调用开销（sys=7.34%）→ 异步 IO 系统调用仍有开销，io_uring 可以降低
# ctx=1234567 → 上下文切换次数（异步 IO 应尽量少）
```

fio 输出的解读有一个与"延迟分位"相关的关键——`clat percentiles` 是完成延迟的百分位分布，P99（99th）是"99% 的 IO 延迟低于这个值"，P9999（99.99th）是"99.99% 的 IO 延迟低于这个值"。P99 反映"大多数请求的延迟上限"，P9999 反映"极端毛刺的延迟"。对延迟敏感的应用（交易系统），P99 比"平均延迟"更有参考价值——平均延迟 100µs 但 P99 537µs，说明有 1% 的请求等了 5 倍于平均的时间。**"平均延迟"看整体健康度，"P99/P9999"看毛刺**——两者结合才能完整评估存储延迟性能。

fio 输出的解读还有一个与"IO depths 分布"相关的诊断价值——`IO depths` 显示实际队列深度的分布。如果 `iodepth=32` 但 `IO depths` 显示 `32=93.3%`，说明 93% 的时间队列深度确实接近 32——设备跟得上，请求能及时提交。如果 `IO depths` 显示 `4=80%, 8=15%, 32=5%`，说明大部分时间队列深度只有 4-8——设备处理太快，请求来不及填满队列。这种情况下，增加 `iodepth` 不会有帮助（队列本来就填不满），要增加 `numjobs`（更多线程产生更多请求）。**`IO depths` 分布反映"队列是否被填满"**——这是判断"iodepth 设高了还是低了"的依据。

fio 输出还有一个与"CPU 开销"相关的指标——`cpu: usr=2.12%, sys=7.34%`。`sys` 是"内核态 CPU 占比"，反映 IO 系统调用的开销。`libaio` 的 `sys` 通常 5-10%，`io_uring` 的 `sys` 通常 2-5%（更少的系统调用），`sync` 的 `sys` 可能 20%+（每次 IO 一次系统调用）。如果 `sys` 占比高，说明 IO 引擎的 CPU 开销大——换 `io_uring` 能降低 CPU 开销，让更多 CPU 给应用。**`sys` 占比反映"IO 引擎的 CPU 效率"**——这是 IO 引擎选型的参考指标。

fio 输出还有一个与"上下文切换"相关的指标——`ctx=1234567` 是"上下文切换次数"。异步 IO（libaio、io_uring）的 ctx 应该少（线程不阻塞，不需要切换），同步 IO（sync）的 ctx 多（每次 IO 都阻塞+唤醒，两次切换）。如果异步 IO 的 ctx 异常高，说明"异步退化成了同步"——可能是 `iodepth` 没生效（譬如 `ioengine=sync` 配了 `iodepth=32`，但 sync 引擎不支持异步，实际 iodepth=1）。**ctx 异常高说明"异步退化"**——这是 fio 配置错误的诊断信号。

### 2.4 fio 的常见误区

**误区 1：测试文件太小，全部在 Page Cache 中**

```bash
# 错误：文件大小 < 内存 → 实际测的是内存速度，不是磁盘速度
fio --filename=/tmp/test --size=100m ...  # 内存 128GB，100MB 全在 Page Cache

# 正确：文件大小 > 可用内存，或使用 --direct=1 绕过 Page Cache
fio --filename=/data/test --size=200g ...  # 远超内存大小
# 或
fio --filename=/data/test --size=10g --direct=1 ...  # 直接 IO，绕过 Page Cache
```

**误区 2：没有预热（warm-up）就测延迟**

```bash
# SSD 在冷启动时延迟较低（内部缓存为空），预热后延迟增加
# 正确做法：先运行 30-60 秒预热，再开始计时
fio --name=warmup --filename=/dev/nvme0n1 --size=100% \
    --rw=randwrite --bs=4k --iodepth=32 --numjobs=4 \
    --ioengine=libaio --direct=1 --runtime=60 --time_based
# 预热完成后再运行实际测试
```

**误区 3：测试设备而不是文件系统**

```bash
# 直接测块设备（/dev/nvme0n1）：测设备原始性能，排除文件系统开销
fio --filename=/dev/nvme0n1 ...

# 通过文件系统测：包含文件系统开销（metadata 操作、journal 写入）
fio --filename=/mnt/nvme/testfile ...

# 实际生产中，应该测文件系统层（因为应用使用文件系统，不是裸块设备）
# 但对比两者可以量化文件系统的开销
```

fio 的误区还有一个与"预热"相关的 SSD 特性——SSD 有"SLC Cache"（用 SLC 闪存做写入缓存），写入先到 SLC Cache（快），Cache 满后写入 TLC/QLC（慢）。如果测试文件小于 SLC Cache（譬如 10GB < 50GB Cache），测的是 SLC Cache 的速度（虚高）；测试文件大于 Cache 后，才测到 TLC/QLC 的真实写入速度。所以 SSD 写入测试要"文件大于 SLC Cache"——通常用 100GB 以上的文件，确保穿透 Cache。**SSD 的 SLC Cache 让"小文件写入测试"虚高**——这是 SSD 时代的 fio 新误区，HDD 时代没有这个问题。

SSD 的写入性能还有一个与"Trim"相关的特性——SSD 删除数据后要"Trim"（通知 SSD 这些块可以擦除），否则 SSD 不知道哪些块空闲，写入时要先擦除（慢）。Trim 后的 SSD 写入性能比未 Trim 的高——因为 SSD 有空闲块可用，不需要"先擦后写"。fio 测试前要确认 SSD 是否 Trim 过——`fstrim /mnt/nvme` 能 Trim 整个文件系统。如果 SSD 未 Trim，写入性能会逐渐下降（空闲块耗尽），测试结果偏低且不稳定。**"fio 写入测试前先 Trim"是 SSD 测试的准备工作**——这是 SSD 时代的新步骤。

SSD 的测试还有一个与"稳态"相关的概念——SSD 在"新鲜"状态（刚 Trim）和"稳态"状态（写过一段时间）的性能不同。新鲜状态有大量空闲块，写入快；稳态状态空闲块少，要 GC，写入慢。fio 测试要测"稳态性能"——先写入足够长时间（让 SSD 进入稳态），再开始计量。通常用"先写满 SSD 容量 2 倍"来进入稳态——这叫"SSD 稳态预处理"。**"稳态性能"是 SSD 的真实性能，"新鲜性能"是虚高**——这是 SSD 测试的"稳态原则"。

SSD 的稳态测试还有一个与"测试时长"相关的实践——SNIA（存储工业协会）的 SSD 性能测试规范要求"至少写满 SSD 容量 4 倍"才进入稳态。对于 1TB SSD，要写 4TB 才稳态——按 1GB/s 写入速度，要 4000 秒（约 1 小时）。所以 SSD 写入测试不能"跑 60 秒看结果"——60 秒还在 SLC Cache 内，测的是虚高速度。要"跑 1 小时以上"或"用 fio 的 `--time_based` + `--runtime=3600`"确保进入稳态。**SSD 写入测试"时长要够"**——这是 SSD 测试的时间要求，HDD 时代不需要。

SSD 的稳态测试还有一个与"测试模式"相关的细节——SNIA 规范定义了四种稳态测试模式：WS（Write Steady，纯写稳态）、RS（Read Steady，纯读稳态）、RWS（Read-Write Steady，混合稳态）、TP（Throughput Put，吞吐稳态）。不同模式对应不同应用场景——WS 测"写入耐力"（能持续写多久），RS 测"读取稳定性"（读性能是否随时间变化），RWS 测"混合负载稳态"。对于数据库（读写混合），用 RWS 模式最接近真实。**SNIA 的四种稳态模式对应不同应用场景**——选对模式才能测出有参考价值的数据。

---

## 第 3 章 blktrace：追踪 IO 请求的内核路径

### 3.1 blktrace 的工作原理

`blktrace` 是内核块设备层的 IO 追踪工具，通过在内核 blk 层的 tracepoints 上挂载，记录每个 IO 请求的完整生命周期事件：

```
一个 IO 请求的内核路径（blktrace 追踪的事件序列）：

应用程序 → Q（Queued）
        → G（Get request）   ← 从 request pool 分配
        → I（Inserted）      ← 插入 IO 调度器队列
        → S（Sleep/Merge）   ← 等待合并（相邻请求合并为一个）
        → M（Merge）         ← 与相邻请求合并
        → D（Dispatched）    ← 发送到设备驱动
        → C（Complete）      ← 设备完成，中断通知

延迟分解：
  I2D 延迟（Inserted → Dispatched）= IO 调度器的排队时间
  D2C 延迟（Dispatched → Complete）= 设备驱动到硬件完成的时间
  Q2C 延迟（Queued → Complete）= 端到端 IO 延迟
```

### 3.2 blktrace 使用示例

```bash
# 追踪 /dev/nvme0n1 上的 IO（后台运行 10 秒）
blktrace -d /dev/nvme0n1 -w 10 -o /tmp/trace

# blktrace 生成多个 CPU 核的追踪文件：trace.blktrace.0, trace.blktrace.1, ...

# 使用 blkparse 解析和汇总
blkparse -i /tmp/trace -o /tmp/parsed.txt

# 查看 IO 延迟统计（Q2C 时间分布）
btt -i /tmp/trace | head -50
# ==================== All Devices ====================
# IO Operations:
#   Reads Queued:          123456
#   Writes Queued:          12345
#
# Throughput (R,W):  1823 MiB/s, 45 MiB/s
# Events (r,w):      123456, 12345
# Merged (r,w):       12345, 1234
#
# I/O Wait Q2Q (time in seconds)
#   Total: 0.000023456
#   Avg:   0.000000190  ← 平均 190ns（Q2Q，本次 IO 开始到下次 IO 开始的间隔）
#
# I/O Wait (D2C)
#   Min: 0.000023456
#   Avg: 0.000089012  ← D2C 平均 89µs（设备处理时间）
#   Max: 0.002345678
#
# I/O Wait (Q2C)
#   Min: 0.000034567
#   Avg: 0.000112345  ← Q2C 平均 112µs（含调度器延迟）
#   Max: 0.003456789

# 发现问题：I2D（调度器延迟）= Q2C - D2C = 112 - 89 = 23µs → 调度器有额外延迟
# 对于 NVMe SSD，I2D 应该接近 0（NVMe 应该使用 none/mq-deadline 调度器）
```

blktrace 的延迟分解有一个与"瓶颈定位"相关的诊断价值——Q2C（端到端延迟）= I2D（调度器延迟）+ D2C（设备延迟）。如果 I2D 占比高（譬如 Q2C 112µs 中 I2D 23µs，占 20%），说明调度器是瓶颈——换调度器（none）能减少 23µs。如果 D2C 占比高（譬如 Q2C 112µs 中 D2C 89µs，占 80%），说明设备本身是瓶颈——调度器无能为力，要换更快的设备或减少 IO 量。**I2D 定位"调度器瓶颈"，D2C 定位"设备瓶颈"**——blktrace 的延迟分解是 IO 瓶颈定位的"手术刀"。

blktrace 还有一个与"合并分析"相关的诊断维度——`blkparse` 的输出包含 `M`（Merge）事件，反映 IO 请求的合并情况。合并率高（譬如 50% 的请求被合并）说明 IO 模式是顺序的（相邻请求能合并），调度器的合并逻辑有效。合并率低（譬如 < 5%）说明 IO 模式是随机的（请求不相邻，无法合并），调度器的合并逻辑无效——这时用 `none` 调度器（不合并）反而更好。**合并率反映"IO 是否可合并"，指导调度器选择**——这是 blktrace 对调度器选型的指导价值。

blktrace 还有一个与"热力图"相关的高级分析——`btt` 能生成"I/O 延迟的时间分布"，看"延迟是否随时间变化"。如果延迟在某个时间段突然升高，对应那个时间段的系统事件（譬如 GC、fsync、或备份任务），能定位"延迟毛刺的时间根因"。这种"时间维度的延迟分析"对"间歇性 IO 慢"的问题很有价值——平均延迟正常但偶发毛刺，只有时间维度的分析才能定位。**blktrace 的时间维度分析定位"间歇性毛刺"**——这是 `iostat`（只给平均值）做不到的。

blktrace 还有一个与"开销"相关的使用注意——blktrace 在内核 tracepoint 上挂载，有 1-3% 的 CPU 开销和磁盘空间开销（trace 文件可能很大）。生产环境长时间开 blktrace 不合适——要做"短时采样"（10-30 秒），抓到问题就停。对于"偶发毛刺"，可以用 `perf record -e block:block_rq_complete` 替代——perf 的开销更小，且能采样而非全量记录。**blktrace 是"短时全量"，perf 是"长时采样"**——两者各有适用场景，长时间监控用 perf，精确分析用 blktrace。

blktrace 的替代工具还有一个与"biolatency"相关的 bpftrace 脚本——`biolatency` 直接统计 IO 延迟分布（直方图），比 `blktrace + btt` 的分析流程更简洁。`biolatency` 的输出是"延迟直方图"——横轴是延迟（µs/ms），纵轴是 IO 数量。直方图能直观看到"延迟分布"——是否有双峰（正常延迟 + 毛刺延迟）、是否有长尾（P99/P9999 远高于 P50）。**`biolatency` 是"延迟分布的快照"**——比 `blktrace` 的"事件流"更易读，适合快速诊断。

---

## 第 4 章 IO 调度器：针对不同存储设备的选择

### 4.1 IO 调度器存在的意义

Linux 内核的 IO 调度器（IO Scheduler）位于通用块层（Generic Block Layer）和设备驱动之间。其核心目标是：**将来自多个进程的大量随机 IO 请求，重新排序和合并，以提高磁盘的整体吞吐量**。

对于 **HDD**，这非常有价值——磁头寻道时间（5-15ms）远大于旋转等待时间（0-4ms），将随机 IO 排序为"磁头扫描方向上的顺序 IO"（电梯算法），可以将 IOPS 从 100 提升到 150+。

对于 **SSD/NVMe**，随机 IO 的延迟已经和顺序 IO 几乎相同（都是 10-100µs），**IO 调度器的排序几乎没有收益**，反而引入调度器本身的延迟（5-50µs）。因此 NVMe SSD 通常应该使用最简单的调度器。

### 4.2 现代 Linux 的调度器（blk-mq 时代）

Linux 4.x 引入了 **blk-mq（Multi-Queue Block IO Queueing Mechanism）** 后，传统的单队列调度器（CFQ、Deadline、NOOP）被 blk-mq 架构下的新调度器替代：

| 调度器 | 适用场景 | 核心特点 |
|-------|---------|---------|
| **none** | NVMe SSD（高端）| 不做任何排序，直接提交到设备，延迟最低 |
| **mq-deadline** | SATA SSD / 混合场景 | 带截止时间的简单调度，防止请求饥饿 |
| **kyber** | NVMe SSD（中端）| 基于延迟目标的调度，平衡读写优先级 |
| **bfq** | 桌面 / 共享 HDD | 完全公平 IO 调度，保证每个进程的 IO 配额 |

```bash
# 查看当前块设备的 IO 调度器
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq
# 方括号中的是当前生效的调度器

# 切换调度器（临时）
echo none > /sys/block/nvme0n1/queue/scheduler
echo mq-deadline > /sys/block/sda/queue/scheduler

# 永久配置（通过 udev 规则）
cat > /etc/udev/rules.d/60-ioschedulers.rules << 'EOF'
# NVMe SSD：使用 none 调度器
ACTION=="add|change", KERNEL=="nvme*", ATTR{queue/scheduler}="none"
# SATA SSD：使用 mq-deadline
ACTION=="add|change", KERNEL=="sd*", ATTRS{queue/rotational}=="0", ATTR{queue/scheduler}="mq-deadline"
# HDD：使用 mq-deadline（或 bfq）
ACTION=="add|change", KERNEL=="sd*", ATTRS{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
EOF
udevadm control --reload-rules
```

blk-mq 的引入有一个与"多队列"相关的架构演进——传统单队列调度器（CFQ、Deadline）只有一个全局 IO 队列，所有 CPU 的 IO 请求都进同一队列，队列锁竞争严重（多核时锁争用成为瓶颈）。blk-mq 引入了"多队列"——每个 CPU 有自己的软件队列，每个硬件队列（NVMe 有多个）对应一组软件队列，队列锁争用大幅减少。blk-mq 让 NVMe SSD 的多队列能力充分发挥——64 个硬件队列 × 64K 队列深度 = 400 万并发请求，远超单队列的 32。**blk-mq 是"为 NVMe 多队列设计"的块层架构**——它让 Linux 块层不再成为 NVMe 性能的瓶颈。

blk-mq 的多队列架构还有一个与"CPU 亲和性"相关的优化——每个 CPU 核有自己的软件队列，IO 请求从提交到设备不需要跨 CPU 锁。这减少了多核 IO 的锁争用——传统单队列在 32 核时锁争用严重，blk-mq 的多队列让每个核独立提交 IO，无锁争用。但 blk-mq 也要求"IO 提交线程和完成线程在同一 CPU"——如果提交在 CPU 0，完成中断在 CPU 1，跨 CPU 通知有开销。NVMe 驱动默认把完成中断路由到提交 CPU（`irqaffinity`），保持亲和性。**blk-mq 的多队列 + CPU 亲和性是"无锁 IO 路径"的基础**——这是 NVMe 高 IOPS 的软件保障。

blk-mq 的多队列还有一个与"调度器适配"的细节——传统调度器（CFQ、Deadline）是为单队列设计的，blk-mq 引入后这些调度器不兼容，要重写为 blk-mq 版本（mq-deadline、bfq）。所以 blk-mq 时代的调度器名字都带"mq"前缀（mq-deadline）或重新设计（kyber、bfq）。`none` 是 blk-mq 的"无调度器"模式——直接把请求从软件队列提交到硬件队列，不做任何排序。**blk-mq 时代的调度器都是"mq 化"的**——这是调度器与块层架构的适配关系。

blk-mq 的调度器还有一个与"运行时切换"相关的特性——Linux 4.x 支持运行时切换调度器（`echo none > /sys/block/nvme0n1/queue/scheduler`），无需重启。这让"不同负载用不同调度器"成为可能——白天用 `none`（延迟敏感），晚上批处理用 `mq-deadline`（防饥饿）。但切换调度器会"排空当前队列"——切换瞬间 IO 暂停，有短暂延迟。所以切换要在"低峰期"做，避免影响生产。**调度器可运行时切换，但要避开高峰**——这是调度器管理的实践细节。

### 4.3 NVMe SSD 的关键 IO 队列参数

```bash
# 查看 NVMe 设备的队列深度（硬件支持的最大并发请求数）
cat /sys/block/nvme0n1/queue/nr_requests
# 1023  ← 内核 IO 队列深度上限（默认 128-1023）

# 查看 NVMe 硬件队列数（对应 CPU 核数）
ls /sys/block/nvme0n1/mq/
# 0  1  2  3  4  5  6  7  ← 8 个硬件队列，每个对应一个 CPU

# 调整队列深度（部分设备允许）
echo 512 > /sys/block/nvme0n1/queue/nr_requests

# 关闭合并（NVMe SSD 不需要合并，合并反而引入延迟）
echo 0 > /sys/block/nvme0n1/queue/nomerges
# 0 = 允许合并（默认），1 = 只合并可以快速判断的，2 = 完全禁止合并
echo 2 > /sys/block/nvme0n1/queue/nomerges  # NVMe 建议禁止合并
```

### 4.4 IO 调度器对延迟的实际影响

以 Samsung 970 Pro NVMe SSD 为例，实测不同调度器对 4KB 随机读 P99 延迟的影响：

| 调度器 | 平均延迟 | P99 延迟 | IOPS |
|-------|---------|---------|------|
| none | 89 µs | 156 µs | **450,000** |
| kyber | 92 µs | 168 µs | 435,000 |
| mq-deadline | 101 µs | 245 µs | 395,000 |
| bfq | 134 µs | 456 µs | 298,000 |

**结论**：对于 NVMe SSD，`none` 调度器在延迟和 IOPS 方面均最优，P99 延迟比 `bfq` 低 3 倍。

调度器的选择有一个与"公平性 vs 延迟"的权衡——`none` 延迟最低但不保证公平（某进程可能"饿死"），`bfq` 保证公平但延迟高。单应用独占 NVMe 时用 `none`（不需要公平），多应用共享 NVMe 时用 `mq-deadline`（防饥饿）。**`none` 求延迟，`mq-deadline` 求公平，`bfq` 求精确公平**——调度器选择是"延迟 vs 公平"的权衡，取决于共享程度。

调度器的选择还有一个与"混合负载"相关的复杂性——当一个节点上既有延迟敏感服务（MySQL）又有吞吐优先服务（备份），调度器要同时满足两种需求。`none` 对延迟敏感服务好（低延迟），但对吞吐优先服务可能不友好（无排序，顺序写效率低）。`mq-deadline` 是折中——有基本的排序（防饥饿）但不过度排序（延迟可控）。混合负载场景推荐 `mq-deadline`——它不会像 `none` 那样让吞吐服务"裸奔"，也不会像 `bfq` 那样让延迟服务"排队"。**混合负载用 `mq-deadline`，单负载用 `none`**——这是调度器选择的实践指南。

调度器选择还有一个与"容器"相关的特殊性——容器内的进程共享宿主机的块设备和调度器，容器无法单独设置调度器。如果宿主机用 `none`（为延迟敏感服务优化），容器内的批处理任务可能"饿死"（无公平调度）。解法是"blk-cgroup 的 IO 权重"——`io.weight` 控制各 cgroup 的 IO 配额，即使 `none` 调度器也能通过 blk-cgroup 保证公平。但 blk-cgroup 的权重控制粒度粗（只控制"IO 时间片比例"），不如 `bfq` 的精确公平。**容器环境的 IO 公平靠 blk-cgroup，不是调度器**——这是容器化对 IO 调度的影响。

容器环境的 IO 调优还有一个与"IO 限速"相关的实践——`io.max`（cgroup v2）能限制容器的 IOPS 和带宽。譬如 `io.max rbps=100M wbps=50M riops=10000 wiops=5000` 限制容器的读带宽 100MB/s、写带宽 50MB/s、读 IOPS 10000、写 IOPS 5000。这比 `io.weight`（相对权重）更直接——`io.max` 是"硬限制"，`io.weight` 是"软优先级"。对于"要严格控制容器 IO 影响"的场景（譬如多租户云），用 `io.max`；对于"只要相对公平"的场景，用 `io.weight`。**`io.max` 是硬限制，`io.weight` 是软优先级**——两者适用不同的隔离强度。

---

## 第 5 章 iostat 与 iotop：实时 IO 监控

### 5.1 iostat：设备级 IO 统计

```bash
# 每秒刷新一次，显示所有块设备的 IO 统计
iostat -x 1
# Device   r/s   w/s   rkB/s   wkB/s  rrqm/s  wrqm/s  %rrqm  %wrqm  r_await  w_await  aqu-sz  rareq-sz  wareq-sz  svctm  %util
# nvme0n1  45678  1234  178012   4893    0.00    1.23    0.00   0.10     0.09     0.23    4.12    3.90     3.97     0.02   98.72
#
# 关键字段解读：
# r/s, w/s：每秒读/写请求数（IOPS）
# rkB/s, wkB/s：每秒读/写数据量（KB/s）
# rrqm/s, wrqm/s：每秒合并的读/写请求数（高 = 顺序访问，合并有效）
# r_await, w_await：读/写请求平均等待时间（ms）← 最重要的延迟指标
# aqu-sz：平均 IO 队列深度（= 平均在途请求数）
# %util：设备利用率（接近 100% = 磁盘可能成为瓶颈）

# 注意：%util 对 NVMe SSD 有误导性！
# NVMe 是多队列并行设备，即使 %util = 100%，也可能还有更多并发处理能力
# 真正的饱和指标是 r_await 或 w_await 持续上升（排队延迟增加）

# 只看特定设备
iostat -x nvme0n1 1

# 诊断磁盘是否成为瓶颈
iostat -x 1 | awk 'NR>3 && $NF > 90 {print "HIGH UTIL:", $0}'
# 当 %util > 90% 时打印告警
```

`iostat` 的 `%util` 有一个与"多队列设备"相关的误导——`%util` 是"设备有至少一个在途请求的时间比例"，对单队列设备（HDD、SATA SSD）准确反映饱和度。但对多队列设备（NVMe），即使所有队列都在忙，`%util` 也只是 100%——它不区分"1 个队列忙"和"64 个队列都忙"。所以 NVMe 的 `%util = 100%` 可能只是"1 个队列饱和"，其他 63 个队列还有余量。**NVMe 的饱和度要看 `aqu-sz`（队列深度）和 `await`（延迟）**——`aqu-sz` 持续增长 + `await` 持续上升才是真饱和。

`iostat` 还有一个与"rrqm/wrqm"相关的诊断维度——合并请求率。`rrqm/s` 是"每秒合并的读请求数"，`%rrqm` 是"合并请求占总请求的比例"。合并率高说明 IO 模式是顺序的（相邻请求被合并），合并率低说明 IO 模式是随机的（请求不相邻，无法合并）。这个指标对"IO 模式判断"很有价值——如果生产环境的 `%rrqm` 从 50% 降到 5%，说明 IO 模式从顺序变成了随机——可能是索引失效导致全表扫描变成了随机 IO。**`%rrqm` 是"IO 模式变化的温度计"**——监控它的变化能发现 IO 模式的转变。

`iostat` 还有一个与"svctm"相关的历史字段——`svctm` 是"平均服务时间"（设备处理 IO 的时间，不含排队）。但 `svctm` 在现代内核已废弃（不准确），`r_await`/`w_await` 是"总等待时间"（排队 + 服务），更可靠。区分"排队时间"和"服务时间"要用 `aqu-sz`（队列深度）和 `await`（总延迟）——`aqu-sz` 高 + `await` 高说明排队时间长（设备饱和），`aqu-sz` 低 + `await` 高说明服务时间长（设备慢）。**`svctm` 已废弃，用 `aqu-sz` + `await` 区分排队和服务**——这是 iostat 字段的现代化。

### 5.2 iotop：进程级 IO 使用

```bash
# 实时显示哪个进程在做最多 IO（类似 top，但按 IO 排序）
iotop -o  # -o：只显示有 IO 活动的进程

# Total DISK READ: 1.23 G/s | Total DISK WRITE: 45.67 M/s
# Actual DISK READ: 1.23 G/s | Actual DISK WRITE: 45.67 M/s
# TID    PRIO  USER     DISK READ  DISK WRITE  SWAPIN     IO>    COMMAND
# 1234   be/4  mysql    800.00 M/s  0.00 B/s    0.00 %  85.23 %  mysqld
# 5678   be/4  kafka    423.00 M/s  45.67 M/s   0.00 %  12.34 %  java -jar kafka

# 找到高 IO 进程后，结合 lsof 定位具体文件
lsof -p 1234 | grep -E "REG|DIR"
# mysql  1234 root  REG   8,1  10737418240  /var/lib/mysql/ibdata1
#                   ↑ 这个文件正在被大量读取

# 进一步分析：该进程的 IO 类型（随机还是顺序？）
bpftrace -e '
tracepoint:block:block_rq_insert {
    if (args->dev == ... && @prev_sector) {
        $delta = (int64)(args->sector - @prev_sector);
        if ($delta < 0) $delta = -$delta;
        if ($delta > 128) @random++;  /* 跨度 > 128 扇区 = 随机访问 */
        else @sequential++;
    }
    @prev_sector = args->sector;
}
interval:s:5 { print(@random); print(@sequential); clear(@random); clear(@sequential); }'
```

`iotop` 的进程级 IO 诊断有一个与"IO 归因"相关的实践——当 `iostat` 显示磁盘饱和时，要知道"是谁在用 IO"。`iotop` 按 IO 量排序进程，能快速定位"IO 大户"。但 `iotop` 只显示"进程的 IO 总量"，不显示"IO 类型"（随机还是顺序、读还是写）——后者要用 `bpftrace` 追踪 `block_rq_insert` 事件，看扇区跨度判断随机/顺序。**`iotop` 定位"谁在用 IO"，`bpftrace` 定位"用什么类型的 IO"**——两者配合才能完整归因 IO 瓶颈。

IO 归因还有一个与"文件级"相关的更细粒度——`iotop` 只到进程级，要知道"进程在读写哪个文件"要用 `lsof` 或 `bpftrace`。`bpftrace` 能追踪 `block_rq_insert` 事件并打印文件名（通过 `args->rwbs` 和扇区反查），直接定位"哪个文件的 IO 多"。这种"文件级 IO 归因"对数据库调优很有价值——譬如 MySQL 有多个表文件，知道"哪个表的 IO 多"能定位"哪个表是热点"。**"进程级"用 iotop，"文件级"用 bpftrace**——IO 归因的粒度从粗到细，逐层深入。

IO 归因还有一个与"延迟归因"相关的进阶——知道"谁在用 IO"后，还要知道"谁的 IO 慢"。`biolatency` bpftrace 脚本能按进程统计 IO 延迟分布——哪个进程的 IO 延迟高，哪个进程的 IO 延迟低。这比 `iotop`（只看 IO 量）更深入——IO 量大的进程不一定慢（可能是顺序 IO），IO 量小的进程可能很慢（可能是随机 IO + 排队）。**`biolatency` 按"延迟"归因，`iotop` 按"量"归因**——两者维度不同，要结合使用。

IO 归因还有一个与"历史回溯"相关的实践——`iostat` 和 `iotop` 是"实时监控"，如果问题已经过去，看不到历史。`sar -d`（sysstat 包）能记录历史 IO 统计——`sar -d 1 60` 每秒记录一次磁盘统计，存到文件，事后用 `sar -f /var/log/sa/saXX` 回放。这对于"夜间发生的 IO 问题"很有价值——早上发现问题时，用 `sar` 回看夜间的 IO 变化，定位问题时段。**`sar` 是"IO 监控的行车记录仪"**——补足了 `iostat`/`iotop` 的"实时性"局限。

---

## 第 6 章 综合调优案例

### 6.1 案例：MySQL 慢查询定位 IO 瓶颈

**症状**：MySQL P99 查询延迟 500ms，但 CPU 利用率只有 20%。

```bash
# 步骤 1：iostat 确认磁盘是瓶颈
iostat -x 1 nvme0n1
# r_await = 45ms  ← ！！远超 NVMe 正常值（< 1ms）
# %util = 98%     ← 磁盘高度饱和
# aqu-sz = 87     ← 队列深度 87，大量请求在排队

# 步骤 2：blktrace 分析 I2D 延迟（调度器引入的延迟）
blktrace -d /dev/nvme0n1 -w 10 -o /tmp/trace
btt -i /tmp/trace
# I2D avg = 35ms  ← 调度器延迟就占了 35ms！

# 原因：MySQL 服务器使用了 bfq 调度器（不适合 NVMe）
cat /sys/block/nvme0n1/queue/scheduler
# none mq-deadline kyber [bfq]  ← bfq 是当前调度器！

# 步骤 3：切换调度器
echo none > /sys/block/nvme0n1/queue/scheduler

# 步骤 4：验证效果
iostat -x 1 nvme0n1
# r_await = 0.89ms  ← 恢复正常
# aqu-sz = 42       ← 队列深度仍高（说明 IO 量大，但延迟已恢复）

# MySQL P99 查询延迟从 500ms 降到 45ms
```

这个案例展示了一个常见的 IO 调优误区——"NVMe SSD 很快，调度器无所谓"。实际上，错误的调度器（bfq）能让 NVMe 的延迟从 100µs 飙到 45ms——500 倍的退化。原因是 bfq 的"公平调度"逻辑在 NVMe 上完全多余（NVMe 随机访问已经很快，不需要排序），但 bfq 仍要执行排序和公平计算，引入 35ms 的调度延迟。**"NVMe SSD 要配 none 调度器"是 IO 调优的基本功**——但很多运维不知道，默认配置可能用了 bfq（某些发行版的桌面优化默认）。

这个案例还有一个与"诊断顺序"相关的方法论——先 `iostat` 确认"磁盘是瓶颈"（r_await 45ms 远超正常），再 `blktrace` 定位"瓶颈在哪一层"（I2D 35ms 说明调度器是瓶颈），最后"换调度器并验证"。这个"从宏观到微观"的诊断顺序是 IO 调优的标准流程——跳过 `iostat` 直接 `blktrace` 会浪费时间（可能瓶颈不在磁盘），跳过 `blktrace` 直接换调度器会盲目（不知道瓶颈是否在调度器）。**"iostat 确认 → blktrace 定位 → 调整 → 验证"是 IO 调优的四步法**——每一步都有明确目标，不跳步。

这个案例还有一个与"根因 vs 症状"相关的教训——MySQL P99 500ms 是"症状"，bfq 调度器是"根因"。如果只看症状，可能误判为"MySQL 查询慢"或"NVMe SSD 性差"，去优化 SQL 或换 SSD——都解决不了问题。`blktrace` 的 I2D 分析直接定位"调度器层延迟"，才找到真根因。**"症状在应用，根因可能在内核"**——IO 调优要穿透应用层看到内核层，不能只在应用层打转。

这个案例还有一个与"验证"相关的闭环——切换调度器后，要用 `iostat` 确认 `r_await` 下降（从 45ms 到 0.89ms），再用 MySQL 的 P99 确认应用层改善（从 500ms 到 45ms）。两层验证——内核层（iostat）+ 应用层（MySQL P99）——才能确认"调优真的有效"。如果只看内核层（iostat 好了）不看应用层（MySQL P99 没改善），可能"内核好了但应用没改善"——说明瓶颈不在调度器，在别的地方。**"内核层 + 应用层"双重验证才是完整闭环**——这是 IO 调优的验证原则。

---

## 第 7 章 磁盘 IO 调优的边界与盲区

### 7.1 IO 调优无法解决应用层 IO 低效

IO 调优能减少"IO 在内核和设备层的延迟"，但不能减少"应用发起的 IO 次数"。如果一个应用因为算法低效（譬如 N+1 查询）发了 10 倍的 IO，再快的 NVMe 也救不了——10 倍 IO 量让设备饱和，延迟上升。**IO 调优优化"每次 IO 的延迟"，应用优化减少"IO 的次数"**——后者收益更大，要先做应用层 IO 优化（索引、缓存、批量），再做内核层 IO 调优。

应用层 IO 优化的典型手段包括——数据库加索引（把全表扫描的随机 IO 变成索引查找的少量 IO）、应用层缓存（把磁盘 IO 变成内存访问）、批量写入（把多次小 IO 合并为一次大 IO）。这些优化的收益通常是 10-100 倍——远超内核调优的 1.5-3 倍。所以 IO 性能问题的排查要"先看应用，再看内核"——如果应用的 IO 量本身不合理（譬如 N+1 查询），内核调优是"治标不治本"。**"应用 IO 优化 > 内核 IO 调优"是 IO 性能优化的优先级原则**——这是与"CPU 优化先 profile 后调参"类似的思路。

应用层 IO 优化与内核层 IO 调优的优先级还有一个与"投入产出比"相关的考量——应用层优化（加索引、加缓存）通常需要开发投入（改代码），但收益大（10-100 倍）；内核层调优（换调度器、调队列）只需运维投入（改配置），但收益小（1.5-3 倍）。所以"投入产出比"上，应用层优化更划算——但前提是"应用层有优化空间"。如果应用已经优化到极限（索引齐全、缓存充分），再优化只能靠内核层。**"应用层优化到极限后，内核层调优才有意义"**——这是两层优化的时序关系。

应用层与内核层的协同还有一个与"反馈循环"相关的实践——应用层优化（譬如加索引）会改变 IO 模式（从随机全表扫描变成随机索引查找），IO 模式变化后内核层调优的"最优配置"也变化（譬如 iodepth 要调低）。所以 IO 调优不是"一次性"的——应用层优化后要重新评估内核层配置，形成"应用优化 → IO 模式变化 → 内核重调优 → 再优化应用"的反馈循环。**IO 调优是"应用与内核的协同迭代"**——不是"先应用后内核"的单次流程，而是循环优化，直到性能达标。

### 7.2 fio 测试无法完全模拟生产负载

fio 能模拟"IO 模式"（大小、队列深度、读写比例），但不能模拟"应用语义"（事务、锁、一致性）。譬如 fio 测出 NVMe 4KB 随机写 50 万 IOPS，但 MySQL 在同一块 NVMe 上可能只跑 5 万 IOPS——因为 MySQL 的每次写要经过"redo log + binlog + buffer pool flush"多个 IO 步骤，且要保证事务 ACID。**fio 测的是"设备上限"，应用跑的是"语义受限的实际性能"**——两者差距可能很大，fio 结果不能直接等同于应用性能。

fio 与应用性能的差距有一个与"一致性语义"相关的解释——数据库的每次写要保证 ACID（原子性、一致性、隔离性、持久性），这意味着每次写要"写 redo log + 写 binlog + 更新 buffer pool + fsync"——4 个步骤，且 fsync 要等磁盘确认。fio 的写没有这些语义——直接写就完事，不等 ACID 保证。所以数据库的 IOPS 通常是 fio 测出的 1/5 到 1/10——这是"一致性开销"。**"一致性语义"是应用 IO 与 fio IO 的本质差距**——不能用 fio 结果直接预估数据库性能，要乘以"一致性系数"。

fio 与应用性能的差距还有一个与"并发模型"相关的维度——fio 的 `numjobs` 个线程是"纯 IO 线程"，只做 IO 不做计算；但应用的线程是"IO + 计算"混合——IO 完成后要做业务逻辑（解析、聚合、序列化），这期间不发起新 IO，IO 队列可能空。所以应用的"有效 IO 并发度"通常低于 fio——即使配了 `iodepth=32`，实际可能只有 10-15（因为线程在做计算时 IO 队列空）。**"应用 IO 并发度 < fio IO 并发度"**——这是"IO + 计算混合"导致的，fio 测的是"纯 IO 上限"，应用达不到。

### 7.3 NVMe SSD 的写寿命限制

NVMe SSD 的闪存有"写寿命"——TLC 闪存约 3000 次 P/E（Program/Erase），QLC 约 1000 次。持续高写入量会消耗 SSD 寿命，最终导致 SSD 变只读或坏块增多。`smartctl -a /dev/nvme0n1` 的 `Percentage Used` 或 `Media Wearout Indicator` 反映剩余寿命。IO 调优要考虑"写寿命"——不能为了性能无限制地写（譬如日志级别开太低、缓存策略太激进）。**IO 性能调优要平衡"性能"和"寿命"**——这是 SSD 时代的新约束，HDD 时代没有写寿命问题。

SSD 写寿命还有一个与"写放大"相关的恶化因素——SSD 的"垃圾回收"（GC）要移动数据，产生额外写入——实际写入量可能是应用写入量的 2-10 倍（写放大系数 WAF）。WAF 高意味着 SSD 寿命消耗更快——应用写 1TB，WAF=3 意味着 SSD 实际写 3TB，寿命消耗 3 倍。降低 WAF 的手段是"顺序写"（GC 友好）和"Trim"（让 SSD 知道空闲块）。**"写放大"让 SSD 寿命消耗快于应用写入量**——IO 调优要考虑 WAF，不能只看应用的写入量。

SSD 寿命管理还有一个与"监控"相关的实践——`smartctl -a /dev/nvme0n1` 的 `Percentage Used` 是"已用寿命百分比"，从 0% 增长到 100% 是 SSD 的设计寿命。但"设计寿命"是保守估计——实际寿命通常比设计寿命长 20-50%。监控 `Percentage Used` 的"月增长率"能预估"剩余寿命"——如果每月增长 2%，剩余 50% 寿命还能用 25 个月。当 `Percentage Used > 80%` 时要考虑更换 SSD——避免"寿终"导致的数据丢失。**`Percentage Used` 是 SSD 寿命的"油表"**——定期监控，提前规划更换。

---

## 第 8 章 小结

fio + blktrace + iostat 构成了磁盘 IO 性能调优的完整工具链：

**fio 的正确使用原则**：
- `bs` 对应目标应用的 IO 大小（OLTP = 16KB，日志 = 128KB，分析 = 1MB）
- `iodepth` 模拟应用的 IO 并发度（同步应用 = 1-4，异步应用 = 32-128）
- 必须使用 `--direct=1` 或足够大的测试文件，确保测的是真实磁盘性能
- 关注 P99 延迟（`clat percentiles`），而不只是平均 IOPS

**IO 调度器选择原则**：
- NVMe SSD → `none`（最低延迟，最高 IOPS）
- SATA SSD / 企业 SAS → `mq-deadline`
- HDD → `mq-deadline` 或 `bfq`（根据工作负载特征）

**诊断顺序**：`iostat -x`（是否饱和）→ `blktrace + btt`（I2D 调度器延迟）→ `iotop`（哪个进程）→ `fio`（设备真实能力与实际负载对比）

磁盘 IO 性能调优的核心认知是"存储设备不是统一的"——同一块 SSD，不同 IO 模式（随机 vs 顺序、小块 vs 大块、浅队列 vs 深队列）的性能差异可达 10-100 倍。**"存储性能"不是一个数字，而是"IO 模式 + 队列深度 + 调度器"的复合函数**——理解这个复合函数，才能用 fio 精确模拟目标场景，用 blktrace 定位瓶颈层，用正确的调度器消除不必要的延迟。下一篇进入应用层 IO 接口选型——同一块 NVMe，不同的 IO 接口（buffered/direct/mmap/io_uring）性能截然不同。

磁盘 IO 调优的认知框架可以总结为一个核心命题——**"IO 性能是多层复合的"**。一次 IO 要经过"应用 → 系统调用 → VFS → 文件系统 → Page Cache → 块层 → IO 调度器 → 设备驱动 → 硬件"——9 层。每层都有延迟和开销，调优要"定位瓶颈层，针对性优化"。`blktrace` 的 I2D/D2C 分解就是"分层定位"的工具——I2D 定位调度器层，D2C 定位设备层。**"分层定位瓶颈"是 IO 调优的方法论**——不盲目调参，先定位"哪一层慢"，再针对性优化那一层。

磁盘 IO 调优的认知框架还有一个与"工具链配合"相关的实践——`fio` 测"设备能力上限"，`iostat` 看"生产实时状态"，`blktrace` 定位"瓶颈层"，`iotop` 归因"哪个进程"。四个工具各有职责，组成完整的诊断链路。诊断 IO 问题时，按"iostat → blktrace → iotop → fio"的顺序用——先看是否饱和（iostat），再定位瓶颈层（blktrace），再归因进程（iotop），最后测设备上限做对比（fio）。**"iostat → blktrace → iotop → fio"是 IO 诊断的标准链路**——每一步解决一个问题，不跳步。

下一篇 [[06 应用级 IO 优化——Direct IO、mmap 与 io_uring 选型]] 将视角提升到应用层：同一块 NVMe SSD，不同的 IO 接口（`buffered`/`direct`/`mmap`/`io_uring`）有截然不同的性能特征和适用场景——这是架构选型层面的决策，而不是调参。

---

## 参考资料

1. Jens Axboe, "fio: Flexible IO Tester" documentation. https://fio.readthedocs.io/
2. Linux kernel documentation, "Block IO Layer (blk-mq)". https://www.kernel.org/doc/html/latest/block/
3. Jens Axboe, "Linux Block IO: Present & Future"（blk-mq 设计与演进）.
4. NVMe Specification, NVM Express Inc. https://nvmexpress.org/specifications/
5. Brendan Gregg, "Linux Storage Performance Analysis"（iostat、blktrace 使用指南）.
6. Linux kernel documentation, "IO Schedulers". https://www.kernel.org/doc/html/latest/block/
7. Samsung, "970 PRO NVMe SSD White Paper"（NVMe SSD 性能特征与测试方法）.
8. Paolo Valente, "BFQ: Budget Fair Queueing"（BFQ 调度器设计论文）.

---

> [!note] 思考题
> 1. `fio` 测试中 `iodepth=32` 表示同时提交 32 个 IO 请求。增加 iodepth 可提高 IOPS——因为 SSD 内部有多个闪存芯片可并行处理。但 iodepth 过大会增加延迟。在 NVMe SSD 上，iodepth 从 1 增加到 128 时，IOPS 和平均延迟分别如何变化？存在一个'拐点'吗？
> 2. NVMe SSD 通常使用 `none` IO 调度器。但多应用共享一块 NVMe 时，无调度可能导致某应用'饿死'。`mq-deadline` 的 FIFO 过期机制如何保证公平性？在容器环境中，blk-cgroup 的 IO 权重（`io.weight`）与调度器如何配合？
> 3. 数据库 WAL 通常使用 Direct IO + `O_DSYNC`。Buffered IO + `fsync` 在吞吐量上可能更高（因为内核可以合并写入），但延迟更不可控。在一个需要保证写入持久化但也需要高吞吐的场景中（如 Kafka Broker），你会选择哪种模式？`O_DSYNC` 和 `fsync` 的语义有什么细微差别？
