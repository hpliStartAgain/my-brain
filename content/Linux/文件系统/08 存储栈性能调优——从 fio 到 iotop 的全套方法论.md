---
title: "存储栈性能调优——从 fio 到 iotop 的全套方法论"
date: 2026-03-02
tags: [blktrace, fio, iostat, iotop, IO调优, Linux, 存储性能, 延迟分析, 性能基准, 读写放大]
aliases: ["Linux存储性能调优", "fio基准测试", "iostat分析", "blktrace使用", "IO性能诊断"]
---

**摘要：**

存储性能调优是 Linux 系统工程中最需要方法论的领域之一——"我的应用 IO 慢"这类模糊问题，必须被分解为一系列可测量的指标（IOPS、吞吐量、延迟、队列深度），才能找到真正的瓶颈。盲目调参（改块大小、换调度器、加队列深度）而不先做系统性测量，往往是在黑暗中射击。本文建立一套完整的存储性能诊断与调优方法论：首先用 `fio` 建立存储性能的精确基线（区分顺序/随机、读/写、不同 block size、不同 iodepth 下的真实能力），然后用 `iostat`/`iotop`/`blktrace` 在生产负载下精确定位瓶颈层次（是 Page Cache 不够？IO 调度器积压？磁盘本身饱和？），接着解析读写放大（Write Amplification / Read Amplification）的根源与消除手段，最后给出数据库、日志系统、HDFS 数据节点三类典型场景的专项调优方案。

---

## 第 1 章 存储性能的四个核心指标

### 1.1 IOPS、吞吐量、延迟、队列深度的关系

存储性能的四个核心指标并不独立——它们通过**利特尔法则（Little's Law）** 联系在一起：

```
利特尔法则（Little's Law）：
  L = λ × W
  
  L = 系统中的平均请求数（队列深度，Queue Depth）
  λ = 请求到达率（IOPS）
  W = 每个请求的平均等待时间（延迟，Latency）

变形：IOPS = Queue Depth / Latency
```

**这个公式揭示了一个重要的性质**：在延迟固定的情况下，提高 IOPS 的唯一方法是提高队列深度。NVMe SSD 之所以能达到百万 IOPS，不是因为单次 IO 比 HDD 快 10000 倍，而是因为它支持极深的队列（queue depth=32+），允许同时并发处理成百上千个 IO 请求。

| 存储类型 | 单次随机读延迟 | 典型队列深度 | 理论最大随机 IOPS |
|---------|-------------|-----------|----------------|
| HDD 7200rpm | ~8ms | 1-2（机械限制）| ~250 IOPS |
| SATA SSD | ~100µs | 32（NCQ 限制）| ~320K IOPS |
| NVMe Gen3 | ~70µs | 1024+（多队列）| ~800K IOPS |
| NVMe Gen4 | ~20µs | 1024+（多队列）| ~1.5M IOPS |
| Optane 3D XPoint | ~10µs | 极深 | ~2M IOPS |

### 1.2 顺序 IO vs 随机 IO

**顺序 IO**：IO 请求的物理地址连续（LBA 连续），磁盘控制器可以通过预读（readahead）优化，HDD 磁头不需要寻道。代表场景：视频流、日志追加写、数据库全表扫描。

**随机 IO**：IO 请求的物理地址散布在磁盘各处。HDD 每次都需要寻道，性能极差。代表场景：数据库 OLTP（按主键随机读写）、邮件服务器（大量小文件随机访问）。

**为什么区分顺序/随机如此重要**：

同一块 SATA SSD：
- 顺序读：550 MB/s（100%）
- 4KB 随机读（queue depth=1）：~20 MB/s（3.6%）
- 4KB 随机读（queue depth=32）：~400 MB/s（73%）

看出来了吗？提高队列深度让随机 IO 性能大幅接近顺序 IO——这正是数据库使用异步 IO + 深队列的根本原因。

---

## 第 2 章 fio：精确测量存储性能的基准工具

### 2.1 为什么 fio 而不是 dd/cp

`dd` 和 `cp` 是简单的文件复制工具，不适合作为存储基准测试：
- **无法控制队列深度**：dd 是同步顺序 IO，queue depth=1
- **无法测试随机 IO**：dd 是纯顺序读写
- **受文件系统和 Page Cache 干扰**：dd 读写文件时受 Page Cache 影响，不能测量真实磁盘性能
- **延迟统计不完整**：dd 只报告总时间，不报告 p99、p999 延迟

`fio`（Flexible IO Tester）是专业的 IO 基准测试工具，支持：
- 任意读写比例（100% 读、70% 读 30% 写混合等）
- 任意 block size（4KB ~ 4MB）
- 任意队列深度（1 ~ 1024）
- 同步/异步 IO 引擎（sync、libaio、io_uring 等）
- 绕过 Page Cache（direct IO）
- 延迟百分位数统计（p50、p95、p99、p999）
- 多个 job 并发

### 2.2 fio 核心参数详解

```bash
# fio 最重要的参数（每个都有其含义）

fio \
  --name=randread-4k-qd32 \       # 测试名称（随机读，4KB，队列深度32）
  --ioengine=libaio \             # IO 引擎：libaio（Linux 异步 IO），也可用 io_uring
  --direct=1 \                    # O_DIRECT：绕过 Page Cache，测量真实磁盘性能
  --rw=randread \                 # 读写模式：randread/randwrite/read/write/randrw
  --bs=4k \                       # Block size：每次 IO 的大小（4KB = 常见 OLTP 场景）
  --iodepth=32 \                  # 队列深度：同时提交到设备的未完成 IO 数量
  --size=10G \                    # 测试数据集大小（必须远大于物理内存，防止全部命中 Page Cache）
  --filename=/dev/nvme0n1 \       # 测试目标：直接测块设备（最准确），或文件（含文件系统开销）
  --runtime=60 \                  # 运行时间（秒）
  --time_based \                  # 基于时间运行（而不是写完 size 就停止）
  --numjobs=4 \                   # 并发 job 数（模拟多线程）
  --group_reporting \             # 汇总所有 job 的报告
  --lat_percentiles=1 \           # 输出延迟百分位数
  --output-format=json            # 输出 JSON（便于自动化分析）
```

### 2.3 标准基准测试套件

下面是一套评估存储全面性能的测试矩阵，建议在购买新存储设备或配置新服务器时运行：

```bash
#!/bin/bash
# storage_benchmark.sh：全面存储基准测试脚本
# 注意：直接测块设备会破坏数据，确保 TARGET 是空闲设备或文件
TARGET=/dev/nvme0n1    # 或使用文件路径 /data/testfile

# ==================== 测试 1：顺序写（模拟日志追加、视频写入）====================
echo "=== Test 1: Sequential Write (128K block, QD=8) ==="
fio --name=seqwrite \
    --ioengine=libaio --direct=1 \
    --rw=write --bs=128k --iodepth=8 \
    --size=10G --filename=$TARGET \
    --runtime=30 --time_based \
    --output-format=terse | grep -E "WRITE|bw|iops"

# ==================== 测试 2：顺序读（模拟全表扫描、冷数据读取）====================
echo "=== Test 2: Sequential Read (128K block, QD=8) ==="
fio --name=seqread \
    --ioengine=libaio --direct=1 \
    --rw=read --bs=128k --iodepth=8 \
    --size=10G --filename=$TARGET \
    --runtime=30 --time_based

# ==================== 测试 3：4KB 随机读（模拟 OLTP 数据库读）====================
echo "=== Test 3: Random Read 4K (OLTP, QD=1/8/32/64) ==="
for QD in 1 8 32 64; do
    echo "--- Queue Depth=$QD ---"
    fio --name=randread-qd${QD} \
        --ioengine=libaio --direct=1 \
        --rw=randread --bs=4k --iodepth=$QD \
        --size=50G --filename=$TARGET \
        --runtime=30 --time_based \
        --lat_percentiles=1 \
        --output-format=terse | awk -F';' '{print "IOPS="$49" BW="$48" lat_avg="$40" p99="$60}'
done

# ==================== 测试 4：4KB 随机写（模拟数据库写入）====================
echo "=== Test 4: Random Write 4K (QD=32) ==="
fio --name=randwrite \
    --ioengine=libaio --direct=1 \
    --rw=randwrite --bs=4k --iodepth=32 \
    --size=50G --filename=$TARGET \
    --runtime=30 --time_based \
    --lat_percentiles=1

# ==================== 测试 5：混合读写（70/30，模拟 OLTP 混合负载）====================
echo "=== Test 5: Mixed Read/Write 70/30 (4K, QD=32) ==="
fio --name=mixed7030 \
    --ioengine=libaio --direct=1 \
    --rw=randrw --rwmixread=70 --bs=4k --iodepth=32 \
    --size=50G --filename=$TARGET \
    --runtime=60 --time_based \
    --lat_percentiles=1
```

### 2.4 解读 fio 输出

```bash
# fio 输出示例（NVMe Gen3 SSD，4K 随机读，QD=32）
fio --name=test --ioengine=libaio --direct=1 --rw=randread --bs=4k \
    --iodepth=32 --size=50G --filename=/dev/nvme0n1 --runtime=30 --time_based

# 典型输出：
# test: (g=0): rw=randread, bs=(R) 4096B-4096B, (W) 4096B-4096B, (T) 4096B-4096B, ioengine=libaio, iodepth=32
# ...
# read: IOPS=287k, BW=1122MiB/s (1177MB/s)(32.9GiB/30001msec)
#   slat (nsec): min=1378, max=155067, avg=2234.07, stdev=1847.55
#   clat (usec): min=55, max=3440, avg=109.47, stdev=41.46
#    lat (usec): min=57, max=3443, avg=111.70, stdev=41.82
#   clat percentiles (usec):
#    |  1.00th=[   67],  5.00th=[   79], 10.00th=[   83], 20.00th=[   89],
#    | 50.00th=[  100], 75.00th=[  116], 90.00th=[  153], 95.00th=[  180],
#    | 99.00th=[  237], 99.50th=[  265], 99.90th=[  334], 99.95th=[  367],
#    | 99.99th=[  676]

# 关键指标解读：
# IOPS=287k       ← 每秒 28.7 万次 4KB 随机读
# BW=1122 MiB/s   ← 带宽 1.12 GB/s（= IOPS × 4KB）
# slat：提交延迟（从 submit_bio 到 IO 引擎接受的时间）
# clat：完成延迟（从 IO 引擎提交到 DMA 完成的时间）
# lat：总延迟（= slat + clat）
# p50=100µs       ← 50% 的 IO 在 100µs 内完成（中位数）
# p99=237µs       ← 99% 的 IO 在 237µs 内完成（P99 尾延迟）
# p99.99=676µs    ← 万分之一的 IO 需要 676µs（极端尾延迟）
```

> [!info] 尾延迟（Tail Latency）的重要性
> 对于微服务架构，p99 甚至 p999 延迟比平均延迟更重要。一个请求可能需要访问 10 个微服务，每个服务的 IO p99 = 1ms，但整个请求的延迟是这 10 个独立随机事件中最慢的一个——概率论告诉我们，10 个 p99 事件中至少有一个超时的概率 ≈ 1 - (0.99)^10 ≈ 9.6%。这就是为什么 Google、Amazon 等公司把 p99.9 甚至 p99.99 作为 SLA 目标。

---

## 第 3 章 生产环境 IO 诊断工具链

### 3.1 iostat：块设备级别的 IO 统计

`iostat` 是最常用的存储性能监控工具，提供块设备的 IOPS、吞吐量、利用率和队列深度统计：

```bash
# 基本用法（每 1 秒刷新，显示扩展统计）
iostat -x 1

# 输出解读：
# Device  r/s    w/s   rkB/s   wkB/s  r_await w_await aqu-sz %util
# sda    0.00  120.00    0.00  1920.0    0.00    5.23    0.63  70.2
# nvme0  1250   2500  5000.0 10000.0    0.08    0.07    0.28  99.8

# 关键列说明：
# r/s, w/s      ：每秒读/写 IO 请求数（IOPS）
# rkB/s, wkB/s  ：每秒读/写字节数（吞吐量）
# r_await       ：读 IO 的平均等待时间（ms）= 队列等待 + 设备服务时间
# w_await       ：写 IO 的平均等待时间（ms）
# aqu-sz        ：平均 IO 队列深度（越高说明 IO 积压越严重）
# %util         ：设备利用率（接近 100% 说明设备已饱和）
```

**诊断场景**：

```bash
# 场景 1：%util 接近 100%，r_await/w_await 高
# 结论：磁盘已成为瓶颈（饱和），需要：
#   - 更换更快设备（HDD → SSD → NVMe）
#   - 减少 IO 并发（优化应用）
#   - 使用 RAID 或分布式存储扩展 IO 能力

# 场景 2：%util 低，但 r_await 高
# 结论：设备利用率不高但延迟大，可能是：
#   - 大量随机 IO（HDD 每次都寻道）
#   - IO 调度器积压（aqu-sz 高而 %util 低）
#   - 远程存储（NFS、云磁盘）网络延迟

# 场景 3：aqu-sz 持续高（> 设备支持的 queue depth）
# 结论：IO 请求积压在调度器队列中，设备来不及处理
#   - 查看调度器队列：cat /sys/block/sda/queue/nr_requests
#   - 检查是否是写密集型（写操作通常会被 IO 调度器延迟更多）

# 按进程分组查看 IO（需要 sysstat 工具）
iostat -x 1 | awk 'NR>3{print}'

# 更细粒度的统计（包含 await 的百分位数，需要 Linux 5.x+）
cat /proc/diskstats
```

### 3.2 iotop：进程级别的 IO 实时监控

`iostat` 只能看设备级别的聚合统计。`iotop` 可以按进程实时显示 IO 使用情况：

```bash
# 安装
apt install iotop   # Ubuntu/Debian
yum install iotop   # RHEL/CentOS

# 基本用法
iotop -ao           # -a: 累计统计（而不是实时速率），-o: 只显示有 IO 的进程

# 输出示例：
# Total DISK READ: 125.4 MB/s | Total DISK WRITE: 45.2 MB/s
#   TID  PRIO  USER     DISK READ  DISK WRITE  SWAPIN     IO>    COMMAND
# 12345  be/4  mysql       85.0 M/s     0.0 B/s  0.0 %  95.3 % mysqld [InnoDB]
#  6789  be/4  hdfs        40.0 M/s     0.0 B/s  0.0 %  48.1 % java [DataNode]
#  2468  be/7  backup       0.0 B/s    45.2 M/s  0.0 %  12.0 % rsync

# 关键列说明：
# PRIO：IO 优先级（be/4 = best-effort class, 优先级 4）
# DISK READ/WRITE：当前进程的 IO 速率
# IO>：该进程 IO 等待占 CPU 时间的比例（高说明进程严重等 IO）

# 查找 IO 占用最高的进程（非交互模式，适合脚本）
iotop -b -n 5 -o | head -30
```

### 3.3 blktrace + blkparse：IO 请求的全链路追踪

当 `iostat` 和 `iotop` 不足以定位问题时，`blktrace` 提供内核级的 IO 请求追踪——每个 IO 请求从进入块设备层到 DMA 完成的每一步都被记录：

```bash
# 安装
apt install blktrace   # Ubuntu/Debian

# 采集 30 秒的 IO 事件（-d 指定块设备）
blktrace -d /dev/sda -w 30 -o trace

# 解析为可读格式
blkparse -i trace -o trace.txt

# 输出示例（精简）：
# 8,0  0  1  0.000000000  12345  Q   R 1000+8 [mysqld]   ← Queue（IO进入队列）
# 8,0  0  2  0.000001000  12345  G   R 1000+8 [mysqld]   ← Get request（分配 request 结构）
# 8,0  0  3  0.000002000  12345  P   N                   ← Plug（进入 plug 列表）
# 8,0  0  4  0.000003000  12345  I   R 1000+8 [mysqld]   ← Insert（插入调度器队列）
# 8,0  0  5  0.000100000  12345  D   R 1000+8 [mysqld]   ← Dispatch（分发给驱动）
# 8,0  0  6  0.001500000     0   C   R 1000+8 0          ← Complete（IO 完成）

# 关键事件类型：
# Q → I 时间差：在调度器队列中等待的时间（IO 调度延迟）
# D → C 时间差：设备服务时间（真实磁盘 IO 时间）
# Q → C 总时间：完整 IO 延迟

# 统计分析（btt 工具：blktrace analysis）
btt -i trace.blktrace.0 -o analysis
# 输出包含：
# Q2I: Queue to Insert（调度器接受请求的延迟）
# I2D: Insert to Dispatch（请求在调度器队列中等待的时间）
# D2C: Dispatch to Complete（设备服务时间）
# Q2C: Queue to Complete（总延迟）

# 可视化（生成延迟直方图）
btt -i trace.blktrace.0 -l | gnuplot -p -e "
    set terminal png size 800,400;
    set output 'io_latency.png';
    set xlabel 'Time (s)';
    set ylabel 'Latency (ms)';
    plot 'Q2C.dat' using 1:2 title 'Total Latency' with linespoints"
```

### 3.4 perf + BPF：现代化 IO 追踪

```bash
# 使用 BCC 工具集（基于 eBPF）追踪 IO 延迟
# 安装：apt install bpfcc-tools

# biolatency：IO 延迟直方图（块设备级别）
biolatency -D 10    # 追踪 10 秒，按延迟区间分组
# 输出（延迟直方图）：
#       usecs               : count     distribution
#         2 -> 3            : 0        |                                        |
#         4 -> 7            : 12       |                                        |
#         8 -> 15           : 145      |*                                       |
#        16 -> 31           : 890      |*******                                 |
#        32 -> 63           : 4532     |*************************************** |
#        64 -> 127          : 5123     |***************************************|
#       128 -> 255          : 1234     |**********                              |
#       256 -> 511          : 234      |*                                       |
#       512 -> 1023         : 23       |                                        |
#      1024 -> 2047         : 2        |                                        |

# biosnoop：实时显示每个 IO 请求（类似 strace 对 IO 的追踪）
biosnoop 10     # 追踪 10 秒
# PID    COMM         D MAJ MIN  DISK       I/O     LAT(ms)
# 12345  mysqld       R   8   0  sda       4096      0.234
# 12345  mysqld       W   8   0  sda       4096      0.156
# 67890  java         R   8  16  sdb      65536      1.234

# fileslower：追踪慢文件 IO（超过阈值的 IO）
fileslower 10   # 追踪延迟超过 10ms 的文件 IO
# PID    COMM         TYPE PATH                         LAT(ms)
# 12345  mysqld       R   /var/lib/mysql/ibdata1         25.3
# 67890  nginx        R   /var/log/nginx/access.log       11.2
```

---

## 第 4 章 读写放大：性能损耗的隐形杀手

### 4.1 什么是写放大（Write Amplification）

**写放大（Write Amplification, WA）** 是指实际写入存储介质的数据量，远超应用程序原本想写入的数据量。

**写放大的来源**：

**来源 1：文件系统元数据写入**

应用写 1 字节，文件系统需要同时更新：inode（mtime、大小）+ Extent 树（新块位置）+ 日志（JBD2/XLOG）+ 超级块（空闲块数）。元数据的写放大通常是 2-5 倍。

**来源 2：SSD/Flash 的内部写放大**

NAND Flash 的物理特性：只能按"页"写（4KB-16KB），但必须按"块"（256KB-4MB）擦除。如果要更新一个 4KB 的页，需要：
1. 读取整个 Flash 块（4MB）到缓存
2. 修改其中的 4KB 页
3. 擦除整个 Flash 块（4MB 清零）
4. 将修改后的 4MB 写回

结果：写 4KB → 实际写 4MB，写放大倍数 = **1000x**。SSD 控制器通过 FTL（Flash Translation Layer）和垃圾回收（GC）机制将写放大控制在 2-10 倍之间，但这在随机小 IO 场景下仍然显著。

**来源 3：日志文件系统的写放大**

ext4 的 `data=ordered` 模式：
- 数据写 1 次（数据块写到实际位置）
- 元数据写 2 次（先写日志，再写实际位置）

对于元数据密集型操作（频繁 create/delete 小文件），写放大非常显著。

### 4.2 减少写放大的方法

**方法 1：增大写 IO 的块大小（减少随机小写）**

小 IO（4KB）的写放大最严重。通过以下方法增大写 IO 的粒度：
- 数据库：增大 WAL 日志的刷新间隔（`innodb_flush_log_at_trx_commit=2`）
- 日志系统：增大日志缓冲区，批量写入
- 文件系统：启用延迟分配（默认开启）

**方法 2：降低 fsync 频率**

每次 `fsync` 都会触发 SSD 的 FTL GC（因为小量更新后立即持久化，导致大量碎片化写）。数据库可以通过 group commit 将多个事务的 fsync 合并为一次：

```sql
-- MySQL InnoDB 配置（减少 fsync 频率）
innodb_flush_log_at_trx_commit = 2   -- 每秒 fsync 一次（而不是每事务）
innodb_io_capacity = 2000            -- InnoDB IO 容量（IOPS 估值，驱动写回）
innodb_io_capacity_max = 4000        -- 最大 IO 容量（SSD 场景可以设更高）
```

**方法 3：使用写入友好的文件系统选项**

```bash
# ext4：data=writeback 减少元数据写放大（数据库服务器）
mount -o data=writeback /dev/sda1 /var/lib/mysql

# XFS：nobarrier 减少 fsync 强制刷盘次数（需要有断电保护）
mount -o nobarrier /dev/sda1 /var/lib/mysql

# 关闭 atime 更新（每次读文件不再写 inode）
mount -o noatime /dev/sda1 /
# 或更精细地用 relatime（只在 mtime 比 atime 新时才更新 atime）
mount -o relatime /dev/sda1 /
```

### 4.3 读放大（Read Amplification）

**读放大** 是指读取用户数据时，实际从磁盘读取的数据量超过用户请求的数据量。

**来源**：

**来源 1：文件系统元数据读取**

读一个文件前，需要先读 inode（1 次 IO）→ 读 Extent 树节点（0-3 次 IO）→ 读数据块（n 次 IO）。对于小文件（inode 内联 Extent），只需 1 次 IO；对于大碎片文件，可能需要额外的多次元数据 IO。

**来源 2：Page Cache 预读引入的无效读取**

内核预读会把用户请求的后续页也读入 Page Cache。对于随机 IO 场景，预读的这些页永远不会被访问，浪费了带宽。

```bash
# 针对随机 IO 场景，关闭预读
echo 0 > /sys/block/nvme0n1/queue/read_ahead_kb
# 或通过 posix_fadvise 对特定文件关闭预读
# posix_fadvise(fd, 0, 0, POSIX_FADV_RANDOM);
```

**来源 3：压缩文件系统的读放大**

btrfs/ZFS 支持透明压缩——读取压缩文件时，实际磁盘读取量 < 用户看到的文件大小（是"负"读放大），但 CPU 解压缩有额外开销。

---

## 第 5 章 典型场景的存储调优方案

### 5.1 MySQL InnoDB 数据库调优

MySQL InnoDB 是对存储 IO 质量要求最高的典型场景，有以下特征：
- 随机小 IO（4KB-16KB），读写混合
- 对 `fsync` 延迟极度敏感（事务提交延迟 = fsync 延迟）
- Buffer Pool 作为自管理缓冲，希望绕过 OS Page Cache

```bash
# 1. 文件系统选择
# 推荐 XFS（更好的并发写性能）或 ext4（data=writeback）

# XFS 格式化（InnoDB 数据目录）
mkfs.xfs -d agcount=16 -l size=256m /dev/sdb1
mount -o noatime,nobarrier /dev/sdb1 /var/lib/mysql

# 2. IO 调度器
# SATA SSD：mq-deadline（保证 fsync 延迟可预测）
echo mq-deadline > /sys/block/sda/queue/scheduler
echo 200 > /sys/block/sda/queue/iosched/read_expire

# NVMe：none
echo none > /sys/block/nvme0n1/queue/scheduler

# 3. 队列深度（大于默认值，充分利用 SSD 并发）
echo 256 > /sys/block/nvme0n1/queue/nr_requests

# 4. MySQL 配置
cat >> /etc/mysql/mysql.conf.d/mysqld.cnf << 'EOF'
# InnoDB IO 优化
innodb_flush_method = O_DIRECT         # 绕过 OS Page Cache（避免双重缓存）
innodb_io_capacity = 2000              # 匹配 SSD 实际 IOPS 能力的 70%
innodb_io_capacity_max = 4000
innodb_read_io_threads = 8             # 读线程数（NVMe 可以设更高）
innodb_write_io_threads = 8
innodb_flush_log_at_trx_commit = 1     # 完整 ACID：每事务 fsync
# 或：= 2 每秒 fsync（允许最多丢失 1 秒数据）

# InnoDB Buffer Pool（设为物理内存的 60-80%）
innodb_buffer_pool_size = 12G          # 16GB 内存设 12GB
innodb_buffer_pool_instances = 8       # 减少 Buffer Pool 锁竞争
EOF
```

### 5.2 日志系统调优（Kafka、Nginx 日志）

日志系统的特征：
- 顺序追加写（append-only），写多读少
- 对 `fsync` 不敏感（日志允许丢失少量数据）
- 文件大，数量相对少

```bash
# 1. 文件系统选择
# ext4（data=writeback + noatime）或 XFS

# ext4（日志服务器）
mkfs.ext4 -T largefile /dev/sdb1    # largefile 预设：每 1MB 一个 inode
mount -o noatime,data=writeback,commit=60 /dev/sdb1 /data/kafka
# commit=60：日志提交间隔 60 秒，大批量写入更高效
# data=writeback：元数据不等待数据落盘，顺序写性能最佳

# 2. 增大 Page Cache 脏页比例（允许更多数据在内存中缓冲，批量写入）
sysctl vm.dirty_ratio=40               # 允许 40% 内存作为脏页（默认 20%）
sysctl vm.dirty_background_ratio=20    # 后台写回阈值 20%（默认 10%）
sysctl vm.dirty_writeback_centisecs=3000  # 写回间隔 30 秒（积累更多后批量写）

# 3. Kafka 特定优化
# Kafka 使用 mmap 和 sendfile（零拷贝），不需要 O_DIRECT
# 关键是文件系统顺序写性能和预读性能

# Kafka broker 配置
cat >> /etc/kafka/server.properties << 'EOF'
log.flush.interval.messages=10000     # 每 1 万条消息 flush 一次
log.flush.interval.ms=1000            # 或每 1 秒 flush 一次
log.retention.bytes=107374182400      # 日志保留大小 100GB
num.io.threads=16                     # IO 线程数（CPU 核数 × 1.5）
EOF
```

### 5.3 HDFS 数据节点调优

Hadoop HDFS DataNode 的特征：
- 大文件顺序写（默认 128MB 数据块）
- 多副本并发写（3 副本 × 并发 pipeline）
- 读多写少（热数据被频繁顺序读取）

```bash
# 1. 文件系统（强烈推荐 XFS）
# 每块数据盘单独格式化为 XFS
for disk in /dev/sd{b,c,d,e,f,g,h}; do
    mkfs.xfs -d agcount=16 -l size=256m $disk
done

# 挂载（关键：allocsize=256m 匹配 HDFS 2 个数据块的预分配）
# /etc/fstab：
# /dev/sdb  /data/1  xfs  defaults,noatime,allocsize=256m  0 0
# /dev/sdc  /data/2  xfs  defaults,noatime,allocsize=256m  0 0
# ...

# 2. IO 调度器
# HDD 数据节点：
for disk in sdb sdc sdd sde; do
    echo mq-deadline > /sys/block/$disk/queue/scheduler
    echo 32 > /sys/block/$disk/queue/nr_requests
done

# 3. 增大预读（顺序读大文件，预读越大越好）
for disk in sdb sdc sdd sde; do
    echo 2048 > /sys/block/$disk/queue/read_ahead_kb  # 预读 2MB
done

# 4. HDFS DataNode 配置
cat >> $HADOOP_HOME/etc/hadoop/hdfs-site.xml << 'EOF'
<!-- 每个数据目录独立磁盘 -->
<property>
  <name>dfs.datanode.data.dir</name>
  <value>/data/1,/data/2,/data/3,/data/4</value>
</property>
<!-- 增大线程数（充分利用多盘并发）-->
<property>
  <name>dfs.datanode.handler.count</name>
  <value>128</value>
</property>
<!-- 数据块传输线程池 -->
<property>
  <name>dfs.datanode.max.transfer.threads</name>
  <value>8192</value>
</property>
EOF
```

---

## 第 6 章 系统级调优参数汇总

### 6.1 内核参数（/etc/sysctl.conf）

```bash
# 存储性能相关的内核参数最佳实践（高性能服务器）

# ─── Page Cache / 脏页管理 ───────────────────────────────────
vm.dirty_ratio = 30                   # 脏页上限（30% 内存 = 约 10GB 脏页在 32GB 系统）
vm.dirty_background_ratio = 15        # 后台写回触发阈值
vm.dirty_expire_centisecs = 6000      # 脏页最长存活 60 秒
vm.dirty_writeback_centisecs = 1000   # 写回线程每 10 秒扫描一次

# ─── 文件系统缓存 ─────────────────────────────────────────────
vm.vfs_cache_pressure = 50            # 降低 dcache/inode 回收积极性（保留更多路径缓存）
# 默认 100；对于小文件密集型（如 Nginx、邮件服务器）降到 50-75 可提升性能

# ─── 内存分配 ─────────────────────────────────────────────────
vm.swappiness = 10                    # 优先用 Page Cache 换出，而不是 swap
vm.overcommit_memory = 1              # 允许内存超额申请（适合大 JVM 应用）

# ─── 网络（影响 NFS/iSCSI/NVMe-oF 等网络存储）───────────────
net.core.rmem_max = 134217728         # 接收缓冲区最大 128MB
net.core.wmem_max = 134217728         # 发送缓冲区最大 128MB
```

### 6.2 块设备参数（按设备类型）

```bash
# HDD 优化脚本
optimize_hdd() {
    DEV=$1
    echo mq-deadline > /sys/block/$DEV/queue/scheduler
    echo 256 > /sys/block/$DEV/queue/read_ahead_kb    # 256KB 预读（顺序 IO 多时增大）
    echo 128 > /sys/block/$DEV/queue/nr_requests       # 队列深度 128
    echo 2 > /sys/block/$DEV/queue/rq_affinity         # 软中断亲和性（NUMA 系统）
}

# SATA SSD 优化
optimize_sata_ssd() {
    DEV=$1
    echo mq-deadline > /sys/block/$DEV/queue/scheduler
    echo 128 > /sys/block/$DEV/queue/read_ahead_kb
    echo 256 > /sys/block/$DEV/queue/nr_requests       # 深队列
    echo 0 > /sys/block/$DEV/queue/add_random          # 关闭随机熵贡献（减少 CPU 开销）
}

# NVMe SSD 优化
optimize_nvme() {
    DEV=$1
    echo none > /sys/block/$DEV/queue/scheduler        # 无调度
    echo 32 > /sys/block/$DEV/queue/read_ahead_kb      # 小预读（随机 IO 为主）
    echo 1023 > /sys/block/$DEV/queue/nr_requests      # 最大队列深度
    echo 0 > /sys/block/$DEV/queue/add_random
    echo 2 > /sys/block/$DEV/queue/rq_affinity
}
```

---

## 小结

存储性能调优的本质是**精确测量 → 定位瓶颈 → 有针对性地调整**，而不是盲目调参：

**方法论三步走**：
1. **建立基线**（`fio`）：在无负载情况下测量存储设备的真实能力（IOPS、吞吐、延迟分布），区分顺序/随机、读/写、不同队列深度
2. **定位瓶颈**（`iostat` → `iotop` → `blktrace` → BPF 工具）：从粗到细，先确定是磁盘饱和还是应用 IO 模式问题，再追踪到具体进程和 IO 路径
3. **针对性调优**：根据应用类型（数据库/日志/大数据）和存储类型（HDD/SSD/NVMe）选择合适的文件系统参数、调度器、内核参数

**读写放大是性能损耗的核心**：通过批量写入（减少小 IO）、关闭不必要的同步（`noatime`、`data=writeback`）、使用正确的 fsync 策略（`fdatasync` 而非 `fsync`），可以将写放大降低 2-5 倍。

下一篇 [[09 文件系统的安全边界——权限、ACL 与 Capabilities]] 将从另一个维度解析文件系统：访问控制。Linux 的 DAC 权限模型（rwx 位）是如何工作的？为什么 POSIX ACL 是对 rwx 的必要补充？`setuid`/`setgid` 位的安全风险，以及 Capabilities 如何替代 `sudo` 提供更细粒度的权限授予。

---

> [!note] 思考题
> 1. BFQ 在高 IOPS 场景（NVMe，100K+ IOPS）中调度开销是否成为瓶颈？BFQ 的调度算法复杂度是 O(log n)——在每秒处理 50 万个 IO 请求时，调度本身消耗的 CPU 时间占比是多少？内核社区是否有 BFQ 在 NVMe 上的基准测试数据？
> 2. 混合读写负载中，`mq-deadline` 优先调度读请求（`read_expire=500ms`）。但写操作被延迟可能导致脏页积压——当脏页达到 `dirty_ratio` 时反过来阻塞所有写操作，间接影响读性能。这种'写饥饿导致读阻塞'的连锁反应在什么负载模式下最容易触发？
> 3. CFQ 在 Linux 5.0 被移除。CFQ 的'完全公平'理念在 HDD 上通过合并相邻请求和排序磁头位置来提升效率。SSD 不需要这些优化——随机 IO 性能与顺序 IO 接近。BFQ 继承了 CFQ 的公平性理念但适应了 SSD——具体做了哪些改变？
