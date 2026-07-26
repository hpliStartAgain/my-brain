---
title: "IO 调度器——CFQ、Deadline 与 mq-deadline 的演进"
date: 2026-03-02
tags: [BFQ, CFQ, Deadline, HDD, IO优先级, IO调度器, Linux, mq-deadline, none, noop, NVMe, SSD, 饥饿]
aliases: ["Linux IO调度器原理", "CFQ调度器", "mq-deadline", "BFQ调度器", "IO调度器选型"]
---

**摘要：**

IO 调度器（I/O Scheduler）解决的问题是：当多个进程同时发出 IO 请求时，以什么顺序将这些请求提交给硬件？这个问题看似简单，实则涉及吞吐量、延迟、公平性三者之间的复杂权衡——为了提升 HDD 吞吐量，需要将请求排序为磁头单向扫描（减少寻道）；为了保证延迟，需要给每个请求设置超时上限；为了公平，需要防止某个进程的大量 IO 请求"饿死"其他进程。Linux 历经四代调度器演进：朴素的 NOOP（无调度，直接提交）→ 追求 HDD 公平的 CFQ（完全公平队列）→ 追求延迟确定性的 Deadline → 适配 blk-mq 的 mq-deadline 和 BFQ。本文从"HDD 为什么需要 IO 调度"这一根本问题出发，深入剖析每代调度器的设计思路、核心算法与适用边界，重点解析 mq-deadline 如何在多队列架构下保证请求的时间界限，以及 BFQ 如何为桌面交互场景提供极低的 IO 延迟感知。

---

## 第 1 章 为什么需要 IO 调度器：从 HDD 的物理特性谈起

### 1.1 HDD 的寻道代价

现代 NVMe SSD 不存在机械部件，任何位置的访问延迟都在 ~100µs，随机 IO 和顺序 IO 的性能差距不超过 2-3 倍。但 HDD（机械硬盘）的情况截然不同：

**HDD 的 IO 延迟由三部分组成**：

1. **寻道时间（Seek Time）**：磁头从当前磁道移动到目标磁道——取决于磁道间的物理距离，平均 ~5-10ms
2. **旋转等待（Rotational Latency）**：等待目标扇区转到磁头下方——7200 RPM HDD 平均 ~4ms
3. **数据传输（Transfer Time）**：实际读写数据——通常 < 1ms（顺序读约 150MB/s）

对于 7200 RPM HDD，一次随机 IO 的平均延迟 ≈ 5ms（寻道）+ 4ms（旋转）+ 0.1ms（传输）= **~9ms**，即 ~110 IOPS。

**顺序 IO vs 随机 IO 的本质差距**：

- 顺序读（磁头不移动，连续读相邻扇区）：150 MB/s
- 随机读（每次 IO 都要寻道）：110 IOPS × 4KB = **~440 KB/s**

差距 **340 倍**！这就是 IO 调度器存在的根本理由——通过对 IO 请求进行重新排序，将随机 IO 尽量转化为类顺序 IO，大幅提升 HDD 吞吐量。

### 1.2 电梯算法（Elevator Algorithm）：最朴素的优化

最早的磁盘调度算法叫**电梯算法（Elevator/LOOK）**——类比电梯的运行方式：磁头沿一个方向（从外道到内道）移动，依次处理路过的所有请求；到达最内道后，反向扫描回最外道。

**优势**：极大减少磁头的总移动距离，提升顺序吞吐量
**劣势**：请求的等待时间不确定——最坏情况（刚好在磁头"刚离开"的位置），需要等一整个来回才能被服务，延迟可能高达几十毫秒

这个问题被称为**IO 饥饿（Starvation）**——某些位置的 IO 请求可能被一直"跳过"（因为有更多其他位置的请求持续到来），得不到服务。

### 1.3 SSD 与 NVMe：IO 调度器的价值衰减

SSD（包括 SATA SSD 和 NVMe）没有机械部件，不存在寻道时间：
- 任意位置的读延迟 ≈ 100µs（几乎固定）
- 顺序 IO 和随机 IO 的吞吐差距 < 3 倍（vs HDD 的 340 倍）

因此，**针对 HDD 设计的 IO 排序优化在 SSD 上价值大幅降低**——重新排序 IO 请求带来的性能提升，可能还不如排序本身消耗的 CPU 时间。

这就是为什么 NVMe SSD 的推荐调度器是 `none`（不做任何排序，直接提交），而 HDD 仍然推荐 `mq-deadline` 或 `bfq`。

---

## 第 2 章 NOOP/None：最简单的调度器

### 2.1 NOOP 的设计

`noop`（Linux 2.x ~ 5.x）和 `none`（blk-mq 时代的等价物）是最简单的 IO 调度器：**不做任何排序，只做简单的 FIFO 合并**。

```
NOOP/None 的逻辑：

新请求到来：
  1. 尝试与已有请求合并（前向合并或后向合并：扇区地址相邻的 bio 合并为一个大 request）
  2. 若无法合并，加入 FIFO 队列末尾
  3. 按 FIFO 顺序分发给设备

没有排序，没有优先级，没有延迟保证
```

**为什么 NVMe SSD 适合 none**：

1. SSD 不需要磁头排队，请求顺序对延迟影响很小
2. `none` 的 CPU 开销最低——没有排序算法的计算开销
3. NVMe 自身有硬件队列，可以并发处理多个请求，不需要软件排序来"优化"

```bash
# 查看当前调度器
cat /sys/block/nvme0n1/queue/scheduler
# [none] mq-deadline kyber bfq   ← 方括号内是当前使用的调度器

cat /sys/block/sda/queue/scheduler
# mq-deadline kyber [bfq]        ← 当前 bfq，可选 mq-deadline 或 kyber

# 切换调度器
echo none > /sys/block/nvme0n1/queue/scheduler
echo mq-deadline > /sys/block/sda/queue/scheduler
```

---

## 第 3 章 CFQ：完全公平队列（已退役）

### 3.1 CFQ 的设计目标

**CFQ（Completely Fair Queuing，完全公平队列）** 是 Linux 2.6.18~5.0 时代的默认 IO 调度器，设计目标与 CPU 调度器的 [[CFS 完全公平调度器]] 类似：**保证每个进程获得公平的磁盘 IO 带宽**。

CFQ 的核心思想：

1. **为每个进程维护独立的 IO 队列**：每个进程的 IO 请求进入自己专属的队列
2. **时间片轮转服务**：每个进程的队列获得固定时间片（默认 8 个 IO 请求或 100ms），轮流服务
3. **时间片用完后切换到下一个进程的队列**

这与 CPU 调度的 RR（Round Robin）非常类似——但 IO 调度面临额外复杂性：一个进程做了一次 IO 后可能需要等待读写结果（睡眠），这时应该把时间片给其他进程，还是等待这个进程继续发出更多 IO？

**Anticipatory IO（预期 IO）**：CFQ 有时会在进程队列服务完当前 IO 后，短暂等待（**idling，空转等待**）该进程发出更多 IO——这是为了防止切换到另一个进程的 IO 而打断当前进程的 IO 顺序性（对 HDD 非常有价值）。

### 3.2 CFQ 的问题：idling 对 SSD 的伤害

CFQ 的 idling 机制在 HDD 上很有价值，但在 SSD 上是**严重的性能杀手**：

- HDD：进程 A 读完一个 4KB 块后，可能立即读相邻块。CFQ 等待 10ms（idling time），然后服务 A 的下一个请求（磁头不需要寻道）→ 性能好
- SSD：进程 A 读完后，CFQ 等待 10ms。但 SSD 处理一个 IO 只需要 100µs——在 CFQ 空转等待的这 10ms 里，SSD 本可以处理 100 个 IO！

更严重的是：CFQ 的每进程队列设计意味着**吞吐量受限于单个进程的 IO 深度**。而 NVMe SSD 靠深队列（queue depth=32+）才能发挥全部性能——CFQ 强制轮转服务各进程队列，人为限制了队列深度。

### 3.3 CFQ 的退役

Linux 5.0（2019 年）正式移除了 CFQ——主要原因：
1. CFQ 专为 HDD 的单队列架构设计，无法在 blk-mq 多队列架构上工作
2. CFQ 的复杂度极高（代码约 4000 行），维护成本大
3. 其替代品 BFQ 在 HDD 上的公平性和性能均优于 CFQ

---

## 第 4 章 Deadline：截止期调度器

### 4.1 Deadline 的设计动机：防饥饿

Deadline 调度器（Linux 2.6.17 引入）解决的是 IO 饥饿（Starvation）问题：

**电梯算法的饥饿场景**：

假设磁头正在处理 LBA 1000-2000 范围的请求，此时不断有新的 LBA 1500 附近的请求到来。电梯算法会一直处理这些新请求（它们在磁头"当前位置附近"），而 LBA 5000 的一个老请求可能等待很长时间得不到服务。

**Deadline 的解法**：为每个请求设置一个**绝对截止时间**：

- 读请求：最多等待 **500ms**（`read_expire`）
- 写请求：最多等待 **5000ms**（`write_expire`）

读请求的超时更短，因为应用程序的 `read()` 通常在同步等待（进程阻塞），而 `write()` 通常是异步写缓冲（进程不等待）。

### 4.2 Deadline 的双队列结构

Deadline 维护两个队列：

**排序队列（Sorted Queue）**：按 LBA（扇区地址）排序，用于从空间上找到"磁头方向上的下一个请求"——优先服务这些请求，减少磁头移动（类似电梯算法）。

**截止期队列（Deadline Queue）**：按到期时间排序，用于找到"即将超时的请求"——防止饥饿。

```c
/* Deadline 的 dispatch 逻辑（简化）*/
struct request *deadline_dispatch_request(struct deadline_data *dd) {
    /* 先检查是否有即将超时的请求 */
    struct request *rq = NULL;

    /* 读请求超时检查（读优先级高于写）*/
    if (!list_empty(&dd->fifo_list[READ])) {
        struct request *oldest_read = list_first_entry(&dd->fifo_list[READ], ...);
        if (time_after_eq(jiffies, oldest_read->fifo_time)) {
            /* 读请求即将超时：立即分发它（打断当前的扫描顺序）*/
            return oldest_read;
        }
    }

    /* 写请求超时检查 */
    if (!list_empty(&dd->fifo_list[WRITE])) {
        struct request *oldest_write = list_first_entry(&dd->fifo_list[WRITE], ...);
        if (time_after_eq(jiffies, oldest_write->fifo_time)) {
            return oldest_write;
        }
    }

    /* 无超时请求：从排序队列中按 LBA 顺序选择下一个（电梯式扫描）*/
    rq = dd->next_rq[READ] ?: dd->next_rq[WRITE];
    return rq;
}
```

### 4.3 Deadline 的参数调优

```bash
# Deadline 调度器的可调参数（单队列时代，位于 /sys/block/<dev>/queue/iosched/）
ls /sys/block/sda/queue/iosched/   # 仅当使用 deadline 时有此目录

# mq-deadline（多队列版本）的参数
cat /sys/block/sda/queue/iosched/read_expire
# 500   ← 读请求最大等待时间（毫秒）

cat /sys/block/sda/queue/iosched/write_expire
# 5000  ← 写请求最大等待时间（毫秒）

cat /sys/block/sda/queue/iosched/writes_starved
# 2     ← 每服务 1 个写请求前，允许服务最多 2 个读请求（防止写请求饥饿）

cat /sys/block/sda/queue/iosched/fifo_batch
# 16    ← 从 FIFO 队列一次性分发的最大请求数（避免频繁切换排序/FIFO 队列）

# 数据库服务器优化（降低读请求延迟，允许写积累更长）
echo 200 > /sys/block/sda/queue/iosched/read_expire   # 读超时 200ms
echo 10000 > /sys/block/sda/queue/iosched/write_expire # 写超时 10s（积累后批量写）
```

---

## 第 5 章 mq-deadline：多队列时代的 Deadline

### 5.1 从单队列 Deadline 到 mq-deadline

Linux 5.0 引入 blk-mq 后，`deadline` 被改写为支持多队列的 `mq-deadline`，主要变化：

1. **per-CPU 合并**：IO 请求的合并在各 CPU 的软件队列中独立进行，不需要全局锁
2. **多硬件队列感知**：请求分发时考虑多个硬件队列，将请求均匀分配到各队列
3. **保留了核心的截止期保证**：读 500ms / 写 5000ms 的超时机制完整保留

### 5.2 mq-deadline 的内核实现关键点

```c
/* mq-deadline 的核心数据结构 */
struct deadline_data {
    /* 红黑树：按扇区地址排序的请求（用于电梯式顺序扫描）*/
    struct rb_root_cached sort_list[DD_DIR_COUNT];

    /* FIFO 链表：按到期时间排序的请求（用于防饥饿检查）*/
    struct list_head fifo_list[DD_DIR_COUNT];

    /* 最近一次分发的请求（磁头当前位置）*/
    struct request *next_rq[DD_DIR_COUNT];

    /* 统计与控制 */
    unsigned int batching;    /* 当前连续服务的请求计数（超过 fifo_batch 则强制检查超时）*/
    unsigned int starved;     /* 写请求连续被跳过的计数 */
    int fifo_expire[DD_DIR_COUNT]; /* 超时时间：[0]=read=500ms, [1]=write=5000ms */
    int fifo_batch;           /* 每批处理的请求数（默认 16）*/
    int writes_starved;       /* 写请求饥饿阈值（默认 2：服务 2 个读才服务 1 个写）*/
};
```

**mq-deadline 的 dispatch 策略**：

```
每次 dispatch（为硬件队列选择下一个请求）：

1. 优先检查读 FIFO 队列头部：是否有超时（time > read_expire）？
   → 是：立即分发（截止期保证）
   → 否：继续

2. 检查写 FIFO 队列头部：是否有超时（time > write_expire）？
   → 是：立即分发
   → 否：继续

3. 从排序队列（红黑树）按电梯顺序选择（下一个 LBA 更大的请求）
   → 连续服务同方向的请求（HDD 磁头不回头）
   → 超过 fifo_batch（16 个）：强制回到步骤 1 检查超时

4. 读写切换逻辑：
   → 读优先（writes_starved=2）：每服务 writes_starved 个读，才服务 1 个写
   → 写请求被跳过次数超过 writes_starved：强制切换到写
```

### 5.3 mq-deadline 的适用场景

**推荐使用 mq-deadline 的场景**：
- **HDD（机械硬盘）**：最主要的使用场景，减少磁头寻道 + 防止 IO 饥饿
- **SATA SSD（混合负载）**：既有交互型（需要低延迟），又有批量型（需要高吞吐）
- **数据库服务器（HDD 或 SATA SSD）**：保证读请求不被大量写操作"淹没"

**不适合使用 mq-deadline 的场景**：
- **NVMe SSD（高并发纯 IOPS 场景）**：`none` 更优，调度开销大于收益
- **交互式桌面（需要极低感知延迟）**：BFQ 更优（能感知进程的 IO "重要性"）

---

## 第 6 章 BFQ：面向带宽公平与低延迟的调度器

### 6.1 BFQ 的诞生背景

**BFQ（Budget Fair Queuing）** 由 Paolo Valente 实现，Linux 4.12 合入主线。它解决的是一个比 mq-deadline 更复杂的问题：

**如何在多进程共用磁盘 IO 时，同时保证**：
1. **延迟敏感型进程**（如音频解码器、交互型应用）的低延迟
2. **批量型进程**（如 rsync、备份）不会"饥饿"
3. **吞吐量不过度损失**

CFQ 虽然也追求公平，但它用"时间片"来量化公平——时间片用完就切换，不管进程发出了多少 IO。BFQ 改用**IO 预算（Budget）**来量化：每个进程分配一定量的"磁盘带宽预算"，预算用完后切换，而不是按固定时间切换。

### 6.2 BFQ 的核心机制

**预算（Budget）**：

BFQ 为每个进程的 IO 队列分配预算（以扇区为单位）。进程每发一个 IO 请求，消耗相应扇区数的预算。预算耗尽后，BFQ 切换到下一个队列。

**预算的自适应调整**：

BFQ 观察每个进程的 IO 模式，动态调整其预算：
- 进程在预算内发出了大量连续 IO → 增大其预算（顺序写文件的进程倾向于连续使用大量 IO）
- 进程在预算内发出了少量零散 IO → 减小其预算（交互型进程的 IO 通常短而零散）

**低延迟模式（Low Latency Mode）**：

BFQ 有一个独特的**低延迟模式**——能自动识别"交互型进程"（如 shell 命令、文本编辑器的文件保存），并给予这些进程极高的 IO 优先级，使其响应时间控制在 2ms 以内，即使系统同时有大量后台 IO。

```bash
# 查看 BFQ 的当前配置
ls /sys/block/sda/queue/iosched/   # 仅当使用 bfq 时
# low_latency           ← 低延迟模式（0=关闭, 1=开启，默认开启）
# slice_idle            ← 空转等待时间（毫秒，类 CFQ 的 idling，默认 8ms）
# back_seek_max         ← 最大后向寻道距离（MB）
# back_seek_penalty     ← 后向寻道的惩罚系数（相比前向寻道的代价倍数）

cat /sys/block/sda/queue/iosched/low_latency
# 1   ← 低延迟模式开启

# 对于纯吞吐量场景（如备份服务器），关闭低延迟模式
echo 0 > /sys/block/sda/queue/iosched/low_latency

# BFQ 的 ionice 支持（通过进程 IO 优先级影响 BFQ 预算分配）
ionice -c 1 -n 0 -p <pid>   # 实时 IO 类（BFQ 给予最高优先级）
ionice -c 2 -n 0 -p <pid>   # Best-effort IO，最高子优先级
ionice -c 3 -p <pid>         # Idle IO（只在磁盘空闲时运行）
```

### 6.3 BFQ 的适用场景

**推荐使用 BFQ 的场景**：
- **桌面 Linux**（GNOME、KDE 等）：低延迟模式使文件操作响应极快
- **多租户服务器**（多个不同优先级的应用共用一块 HDD）：BFQ 的公平调度防止低优先级任务影响高优先级任务
- **实时音视频处理**：音频进程的 IO 能得到极低延迟保证

**不适合使用 BFQ 的场景**：
- **NVMe SSD 高并发纯写**：BFQ 的 idling 机制在 SSD 上有负面影响（空等进程发 IO，而 SSD 可以服务其他 IO）
- **高并发数据库 IOPS 场景**：BFQ 的公平调度逻辑开销 > 收益，`none` 或 `mq-deadline` 更优

---

## 第 7 章 Kyber：面向延迟目标的调度器

### 7.1 Kyber 的设计哲学

**Kyber**（Linux 4.12 引入）是为 NVMe SSD 和高速存储设计的轻量级调度器，它的设计哲学完全不同于前三代：

**不排序，只限流（Token Bucket）**：

Kyber 不对 IO 请求做任何排序，而是用**令牌桶（Token Bucket）**来控制各类型 IO（读/写/同步/异步）的发送速率，以达到用户设置的延迟目标：

```
Kyber 的令牌桶机制：

目标：读 IO 延迟 ≤ 2ms（kyber_read_lat_nsec = 2000000）
     写 IO 延迟 ≤ 10ms（kyber_write_lat_nsec = 10000000）

实际运行中：
  测量当前读 IO 的平均延迟
  如果延迟 > 2ms（超过目标）：减少读 IO 的令牌（降低读并发度，减轻磁盘压力）
  如果延迟 < 2ms（低于目标）：增加读 IO 令牌（提高并发度，榨取更多 IOPS）

效果：系统自动在最大 IOPS 和延迟目标之间找到平衡点
```

### 7.2 Kyber 的适用场景

Kyber 非常轻量（代码 ~600 行，vs BFQ 的 ~3000 行），CPU 开销极小，适合：
- **高端 NVMe SSD**（PCIe Gen4/Gen5）：SSD 性能足够高，调度器只需做最简单的流量控制
- **延迟敏感的云服务**：能精确控制读/写 IO 的延迟上限

---

## 第 8 章 调度器选型：生产环境决策树

### 8.1 各调度器特性对比

| 调度器 | 适用存储 | 核心策略 | CPU 开销 | 延迟保证 | 公平性 |
|-------|---------|---------|---------|---------|-------|
| `none` | NVMe SSD | FIFO+合并，无排序 | 极低 | 无 | 无 |
| `mq-deadline` | HDD/SATA SSD | 电梯+截止期 | 低 | 硬限时 | 读优先 |
| `bfq` | HDD/低速 SSD | 预算公平+低延迟 | 中高 | 软限时 | 进程公平 |
| `kyber` | 高速 SSD/NVMe | 令牌桶限流 | 极低 | 目标延迟 | 无 |

### 8.2 生产环境选型建议

```bash
# 自动检测并设置最优调度器（推荐放入 /etc/udev/rules.d/）

# 方法一：udev 规则（按设备类型自动配置）
cat > /etc/udev/rules.d/60-ioscheduler.rules << 'EOF'
# 旋转磁盘（HDD）：使用 mq-deadline
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="1", \
    ATTR{queue/scheduler}="mq-deadline"

# 非旋转（SSD/NVMe）：使用 none
ACTION=="add|change", KERNEL=="sd[a-z]*", ATTR{queue/rotational}=="0", \
    ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="nvme[0-9]*", \
    ATTR{queue/scheduler}="none"
EOF

# 方法二：手动确认并设置
# 查看设备是否为旋转磁盘
cat /sys/block/sda/queue/rotational
# 1 = HDD，0 = SSD

# HDD 服务器（数据库，混合读写）
echo mq-deadline > /sys/block/sda/queue/scheduler
echo 200 > /sys/block/sda/queue/iosched/read_expire    # 读 200ms 超时
echo 5000 > /sys/block/sda/queue/iosched/write_expire  # 写 5s 超时

# NVMe 高 IOPS 场景
echo none > /sys/block/nvme0n1/queue/scheduler

# 桌面 Linux / 多应用服务器（HDD）
echo bfq > /sys/block/sda/queue/scheduler
echo 1 > /sys/block/sda/queue/iosched/low_latency
```

### 8.3 IO 调度器的性能验证

```bash
# 用 fio 验证调度器切换的效果（随机读，8 个并发，HDD）
fio --name=random-read \
    --ioengine=libaio \
    --iodepth=8 \
    --rw=randread \
    --bs=4k \
    --size=1G \
    --filename=/dev/sdb \
    --runtime=30 \
    --output-format=json

# 对比不同调度器：
# mq-deadline：IOPS 约 400，p99 延迟约 18ms（防止极端延迟）
# none：IOPS 约 350，p99 延迟约 45ms（无排序，偶尔极差延迟）
# bfq：IOPS 约 380，p99 延迟约 12ms（BFQ 低延迟模式效果明显）

# 监控调度器队列深度
iostat -x 1 sda
# avgqu-sz：平均队列深度（越大说明 IO 积压越严重）
```

---

## 小结

IO 调度器的演进历程折射出存储技术的代际变迁：

**HDD 时代的核心矛盾**：磁头寻道是主要瓶颈，需要通过排序减少寻道，同时防止 IO 饥饿。CFQ（公平性优先）和 Deadline（延迟界限优先）是这一时代的主流答案。

**SSD 时代的范式转变**：无机械部件使排序优化价值下降，高并发成为 IOPS 的关键。单队列架构的全局锁成为瓶颈，blk-mq 多队列 + `none` 成为 NVMe 的最优解。

**调度器选型原则**：
- **NVMe SSD，高并发 IOPS 场景** → `none`（零开销）
- **HDD 或 SATA SSD，混合负载** → `mq-deadline`（延迟可预测）
- **桌面 Linux 或多应用服务器（需要进程公平）** → `bfq`（低延迟感知）
- **高速 SSD，有明确延迟目标** → `kyber`（轻量限流）

下一篇 [[07 XFS 文件系统深度解析——B+ 树与日志架构]] 将深入 Linux 服务器上最主流的高性能文件系统：XFS 的 AG（分配组）并发设计为什么对大文件和高并发写有天然优势？B+ 树如何在 XFS 中被广泛用于 inode 管理、空闲空间管理和目录索引？延迟分配与 Speculative Preallocation 如何减少文件碎片？

---

> [!note] 思考题
> 1. XFS 使用 B+ 树管理 inode 和 Extent。在数十亿文件场景中，XFS 的目录查找是否优于 ext4？ext4 的 htree（hash tree）目录索引与 XFS 的 B+ 树在什么规模的目录中出现性能分化？`ls -l` 在百万级文件目录中的性能差异有多大？
> 2. XFS 的延迟分配在 write() 时不分配磁盘块，回写时一次性分配连续 Extent。这对顺序写非常有利。但掉电时未回写的数据可能丢失（即使 write() 已返回成功）。XFS 的日志如何保证元数据一致性？数据丢失的范围是最近一次 fsync 之后的所有写入吗？
> 3. Btrfs 和 ZFS 提供数据校验和（Checksum），读取时验证完整性。ext4/XFS 只有元数据校验。在非 ECC 内存或廉价 SSD 环境中数据校验很重要。数据校验的性能开销（CPU 计算 CRC/xxhash）通常是多少？在 NVMe SSD 上这个开销相对于 IO 延迟是否可以忽略？
