---
title: "磁盘 IO 性能调优——fio 方法论、调度器与 IO 模式"
date: 2026-03-02
tags: [blktrace, fio, iodepth, iostat, IO性能测试, IO调度器, Linux, NVMe, SSD, 性能优化, 磁盘IO]
aliases: ["fio使用指南", "磁盘IO调优", "IO调度器选择", "blktrace分析", "NVMe性能调优"]
---

**摘要：**

存储性能问题的诊断常常陷入两个极端：要么直接 `dd if=/dev/sda of=/dev/null`（过于简单，不能反映真实负载）；要么直接在生产上观察应用表现（太晚，无法做事前评估）。`fio`（Flexible IO Tester）是磁盘性能测试的行业标准工具，它的价值不在于能测多快，而在于能**精确模拟目标场景的 IO 模式**——随机还是顺序、读还是写、同步还是异步、队列深度是多少——并以此评估存储设备在真实负载下的性能边界。本文的核心目标是建立 `fio` 的方法论：三个关键参数（`iodepth`/`bs`/`numjobs`）如何联合决定测试结果，如何对应真实应用场景（OLTP 随机读写 vs 日志顺序写 vs 分析型大块扫描）。同时深入 `blktrace` 追踪 IO 请求的内核路径，理解 IO 调度器的选择对延迟和吞吐量的影响，以及如何针对 NVMe SSD 做最优化配置。

---

## 第 1 章 为什么磁盘 IO 性能测试如此复杂

### 1.1 存储设备的性能不是一个数字

"这块 SSD 能跑多少 IOPS？"——这个问题的答案取决于：
- **IO 大小（Block Size）**：4KB 随机读 vs 128KB 顺序读，IOPS 差异可以是 10 倍
- **队列深度（Queue Depth / iodepth）**：NVMe SSD 在队列深度 1（同步 IO）时可能只有 5 万 IOPS，队列深度 32 时达到 50 万 IOPS
- **读写比例**：纯读 vs 70/30 读写混合，写操作的 Erase-Program 周期使 SSD 写性能远低于读性能
- **访问模式**：顺序访问（HDD 速度提升 100 倍，SSD 提升 2-5 倍）vs 随机访问
- **IO 引擎**：同步（`sync`）、异步（`libaio`）、`io_uring` 对性能有显著影响

这就是为什么 `dd` 测出来的数字（通常是大块顺序写）对大多数应用场景没有参考价值——OLTP 数据库主要是小块随机 IO，完全不同的性能特征。

### 1.2 存储性能的三个核心指标

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

---

## 小结

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

下一篇 [[06 应用级 IO 优化——Direct IO、mmap 与 io_uring 选型]] 将视角提升到应用层：同一块 NVMe SSD，不同的 IO 接口（`buffered`/`direct`/`mmap`/`io_uring`）有截然不同的性能特征和适用场景——这是架构选型层面的决策，而不是调参。

---

> [!note] 思考题
> 1. `fio` 测试中 `iodepth=32` 表示同时提交 32 个 IO 请求。增加 iodepth 可提高 IOPS——因为 SSD 内部有多个闪存芯片可并行处理。但 iodepth 过大会增加延迟。在 NVMe SSD 上，iodepth 从 1 增加到 128 时，IOPS 和平均延迟分别如何变化？存在一个'拐点'吗？
> 2. NVMe SSD 通常使用 `none` IO 调度器。但多应用共享一块 NVMe 时，无调度可能导致某应用'饿死'。`mq-deadline` 的 FIFO 过期机制如何保证公平性？在容器环境中，blk-cgroup 的 IO 权重（`io.weight`）与调度器如何配合？
> 3. 数据库 WAL 通常使用 Direct IO + `O_DSYNC`。Buffered IO + `fsync` 在吞吐量上可能更高（因为内核可以合并写入），但延迟更不可控。在一个需要保证写入持久化但也需要高吞吐的场景中（如 Kafka Broker），你会选择哪种模式？`O_DSYNC` 和 `fsync` 的语义有什么细微差别？
