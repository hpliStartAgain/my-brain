---
title: "CPU 调度延迟——实时性、亲和性与 cgroup CPU"
date: 2026-03-02
tags: [CFS, cgroups, CPU亲和性, Linux, numactl, SCHED_FIFO, taskset, 实时调度, 延迟抖动, 性能优化, 调度延迟]
aliases: ["CPU调度延迟优化", "调度延迟分析", "CPU亲和性设置", "cgroup CPU调优", "实时进程调度"]
---

**摘要：**

P99 延迟毛刺是低延迟服务最难排查的问题之一，因为它往往不是代码慢，而是进程在等待 CPU 调度——即进程已经"就绪"（有数据可处理），但 CPU 被别的任务占用，等待了数毫秒才被调度到 CPU 上执行。这类问题在 `perf` 的 on-CPU 火焰图中几乎看不到（因为进程处于 off-CPU 状态，没有被采样到）。本文从 Linux CFS 调度器的延迟来源出发，深入分析三类调度延迟问题：**调度器固有延迟**（唤醒延迟、调度周期、抢占延迟）、**CPU 资源竞争**（多进程竞争同一 CPU 核）、**cgroup CPU Bandwidth Throttling**（容器 CPU 限制的毫秒级周期性节流）。每类问题给出诊断工具（`schedstat`、`perf sched`、bpftrace 调度追踪）和具体的优化手段（CPU 亲和性绑定、`taskset`/`cpuset`、实时调度策略、cgroup CPU 隔离）。

---

## 第 1 章 调度延迟的来源：为什么就绪的进程要等待

### 1.1 CFS 调度的工作方式复习

[[进程管理/08 CFS 完全公平调度器——从 O(1) 到红黑树的演进]] 中已经深入解析了 CFS 的核心机制。这里从性能优化角度提炼关键点：

CFS 的"公平性"建立在**时间片轮转**基础上：每个可运行的进程都有机会占用 CPU，但每次占用时间有限（`sched_latency_ns / 进程数`，默认最大 24ms）。当进程用完时间片后，被抢占、加入就绪队列尾部，等待下一轮调度。

**这里隐藏了第一类调度延迟**：假设系统有 N 个可运行进程，调度延迟（一个进程从"就绪"到"真正被调度"的最大等待时间）约为：

```
调度延迟 ≈ sched_latency_ns = max(N × sched_min_granularity_ns, 6ms)

在 8 个可运行进程时：
  调度延迟 ≈ 8 × 0.75ms = 6ms  ← 最坏情况：一个进程必须等 6ms 才能获得 CPU！
```

对于 P99 要求 < 1ms 的服务，6ms 的调度延迟意味着毛刺几乎无法避免——只要 CPU 上有多个进程竞争。

### 1.2 三类调度延迟

```
调度延迟的完整构成：

┌─────────────────────────────────────────────────────────┐
│  事件发生（网络包到达）                                    │
│  ↓ 中断处理 + NAPI 软中断（2-50µs）                       │
│  ↓ 唤醒目标进程（加入就绪队列）                            │
│  ↓ 等待被调度到 CPU（0 ~ 调度周期 = 6ms）← 最大来源        │
│  ↓ 进程真正在 CPU 上开始执行                               │
│  总延迟 = 硬中断响应 + 唤醒延迟 + 调度等待延迟              │
└─────────────────────────────────────────────────────────┘
```

**类型 1：唤醒延迟（Wakeup Latency）**

进程被唤醒（从睡眠转为就绪）后，到真正执行的时间。在单核场景，这几乎是零（立即抢占当前进程）；在多核场景，唤醒的进程可能被调度到不同 CPU，需要跨 CPU 迁移，增加了 100µs-1ms 的延迟。

**类型 2：调度周期延迟（Scheduling Period Delay）**

当多个进程竞争同一 CPU 时，每个进程必须等待其他进程用完时间片。这是导致 P99 毛刺的最常见原因。

**类型 3：cgroup CPU Throttling**

Kubernetes 等容器平台为 Pod 设置了 CPU limit。cgroup v1 的 CPU Bandwidth Controller 以 100ms 为周期分配 CPU 配额（`cpu.cfs_quota_us`）。当 Pod 用完本周期配额时，被**强制暂停**，直到下一个 100ms 周期开始——这会导致固定周期的调度延迟，是容器化服务 P99 抖动的主要来源之一。

---

## 第 2 章 调度延迟的诊断工具

### 2.1 /proc/schedstat：内核调度统计

Linux 内核在 `/proc/schedstat` 中暴露了每个 CPU 的调度器运行统计，包含进程在就绪队列中等待的累积时间：

```bash
# 查看每个 CPU 的调度统计
cat /proc/schedstat
# cpu0 0 0 0 0 0 0 12345678 23456789 45678
#              ↑           ↑         ↑
#              总运行时间   总等待时间  调度次数（纳秒）

# 更直观的方式：查看每个进程的调度延迟
cat /proc/<pid>/schedstat
# 运行时间(ns)  等待时间(ns)  上下文切换次数
# 12345678901  234567890  1234

# 通过 /proc/<pid>/sched 获得更详细信息
cat /proc/<pid>/sched
# nginx (1234, #threads: 4)
# ...
# wait_sum                         :        345678901.123456  ← 累积等待时间（纳秒）
# nr_voluntary_switches            :               1234567   ← 主动上下文切换次数
# nr_involuntary_switches          :                  1234   ← 被抢占次数（高=CPU竞争激烈）
# ...
```

**`nr_involuntary_switches` 是关键指标**——被动上下文切换说明进程用完了时间片或被更高优先级进程抢占，计数持续增长说明 CPU 竞争激烈。

### 2.2 perf sched：调度事件的完整追踪

`perf sched` 是分析调度延迟最强大的工具，它记录了所有进程的调度事件序列（wake、switch、migrate），可以精确计算每个进程的等待时间：

```bash
# 采集 5 秒的调度事件
perf sched record -g -- sleep 5
# 生成 perf.data，包含所有 sched_switch、sched_wakeup 事件

# 分析等待延迟统计
perf sched latency | head -30
# ---------------------------------------------------------------------------------------------------------------
# Task                  |   Runtime ms  | Switches | Average delay ms | Maximum delay ms | Maximum delay at      |
# ---------------------------------------------------------------------------------------------------------------
# nginx:1234            |    1234.567ms |   123456 |       0.012ms    |       12.345ms   | avg=0.012 max=12.345  |
# java:5678             |    5678.901ms |    45678 |       0.089ms    |       45.678ms   ← ！！最大延迟 45ms
# redis-server:9012     |     901.234ms |    12345 |       0.003ms    |        3.456ms   |
#
# 解读：
# Average delay = 平均等待时间（进程从就绪到执行的平均等待时间）
# Maximum delay = 最大等待时间（对应 P99/P100 延迟）
# java:5678 的最大调度延迟 45ms 是 P99 毛刺的根因！

# 回放调度事件，看特定时间窗口的调度序列
perf sched script | head -100
# nginx  1234 [000] 12345.678901: sched:sched_switch: prev_comm=nginx -> next_comm=java
# java   5678 [000] 12345.679012: sched:sched_switch: prev_comm=java -> next_comm=nginx
# ...

# 统计某个进程的调度延迟分布
perf sched latency | grep java
```

### 2.3 bpftrace 实时追踪调度延迟

`perf sched` 需要事后分析，**bpftrace 可以实时输出调度延迟**，并精确到单次调度事件：

```bash
# 追踪所有进程的唤醒→执行延迟（超过 1ms 的都打印）
bpftrace -e '
tracepoint:sched:sched_wakeup,
tracepoint:sched:sched_wakeup_new {
    @wakeup_ts[args->pid] = nsecs;
}

tracepoint:sched:sched_switch {
    $pid = args->next_pid;
    if (@wakeup_ts[$pid]) {
        $lat_us = (nsecs - @wakeup_ts[$pid]) / 1000;
        if ($lat_us > 1000) {  /* 超过 1ms 才打印 */
            printf("HIGH SCHED LATENCY: pid=%d comm=%s lat=%dµs\n",
                   $pid, args->next_comm, $lat_us);
        }
        delete(@wakeup_ts[$pid]);
    }
}'

# 输出示例：
# HIGH SCHED LATENCY: pid=5678 comm=java lat=12456µs
# HIGH SCHED LATENCY: pid=5678 comm=java lat=45678µs  ← 这就是 P99 毛刺的来源！

# 以直方图展示调度延迟分布（每 10 秒汇总一次）
bpftrace -e '
tracepoint:sched:sched_wakeup { @ts[args->pid] = nsecs; }
tracepoint:sched:sched_switch {
    $pid = args->next_pid;
    if (@ts[$pid]) {
        @lat_us = hist((nsecs - @ts[$pid]) / 1000);
        delete(@ts[$pid]);
    }
}
interval:s:10 { print(@lat_us); clear(@lat_us); }'
```

### 2.4 诊断 cgroup CPU Throttling

cgroup CPU throttling 在 `/sys/fs/cgroup/cpu/` 下有专门的统计文件：

```bash
# 查看 cgroup 的 CPU throttle 统计
# Kubernetes 中，Pod 对应的 cgroup 路径为：
CGROUP_PATH=/sys/fs/cgroup/cpu/kubepods/pod<pod-uid>/<container-id>

cat $CGROUP_PATH/cpu.stat
# nr_periods       1234567    ← 总周期数（每 100ms 一个周期）
# nr_throttled     123456     ← 被 throttle 的周期数
# throttled_time   12345678901234  ← 被暂停的总时间（纳秒）

# 计算 throttle 比例
python3 -c "print(123456 / 1234567 * 100, '% throttled')"
# 10.0% throttled  ← 10% 的周期里 Pod 被暂停！这直接导致 P99 毛刺

# 实时监控（每秒一次）
watch -n 1 "cat $CGROUP_PATH/cpu.stat"
```

> [!warning] 生产避坑：Kubernetes CPU Throttling 是隐藏杀手
> 一个 CPU request=1，limit=2 的 Pod，在 100ms 的 CFS 周期里最多使用 200ms 的 CPU 时间（2 个核×100ms）。但如果在某个 100ms 窗口的前 20ms 内，Pod 爆发性地使用了 200ms 的 CPU（突发），后续 80ms 就会被完全暂停——即使此时整个节点的 CPU 还有大量空闲！这是 cgroup v1 CPU bandwidth controller 的设计局限性，对突发性负载极不友好。

---

## 第 3 章 CPU 亲和性：消除跨核调度开销

### 3.1 为什么需要 CPU 亲和性

Linux 调度器默认会在多个 CPU 核间迁移进程，以实现负载均衡。但频繁的跨核迁移有两类代价：

**代价 1：缓存失效**。进程从 CPU 0 迁移到 CPU 3 后，CPU 0 L1/L2 缓存中属于该进程的数据（工作集）在 CPU 3 上不存在，需要重新从 L3 或 DRAM 加载——对于有大量工作集的服务（如大缓冲区的数据库），这会导致迁移后几毫秒内的性能下降。

**代价 2：NUMA 跨节点访问**。在多路 NUMA 服务器上，进程从 NUMA 0 的 CPU 迁移到 NUMA 1 的 CPU，而其内存分配在 NUMA 0——此后所有内存访问都是远端访问（延迟 2 倍），可能导致 10-30% 的性能下降。

**CPU 亲和性（CPU Affinity）** 通过限制进程只能在指定 CPU 核上运行，彻底消除跨核迁移：

### 3.2 taskset：进程级 CPU 亲和性绑定

```bash
# 将进程绑定到 CPU 0（bitmask = 0x1 = 1）
taskset -p 0x1 <pid>
# Process 1234's current affinity mask: ff （原来可以跑在所有 8 个核上）
# Process 1234's new affinity mask: 1   （现在只能跑在 CPU 0 上）

# 将进程绑定到 CPU 0-3（bitmask = 0xf = 1111b）
taskset -p 0xf <pid>

# 以指定 CPU 亲和性启动新进程（不需要知道 PID）
taskset -c 0 ./my_server        # 只用 CPU 0
taskset -c 0,1,2,3 ./my_server  # 用 CPU 0-3
taskset -c 0-3,8-11 ./my_server # CPU 0-3 和 8-11（例如两个 NUMA 节点的前 4 个核）

# 验证亲和性设置
taskset -p <pid>
# Process 1234's current affinity mask: f  ← CPU 0-3

# 查看当前进程的 CPU 亲和性
cat /proc/<pid>/status | grep Cpus_allowed
# Cpus_allowed:    f     ← 16 进制 bitmask，f = CPU 0-3
```

### 3.3 cpuset cgroup：容器级 CPU 核隔离

`taskset` 只是建议性的——如果 CPU 0 上还有很多其他进程竞争，绑定到 CPU 0 也无法避免调度延迟。真正的隔离需要**独占 CPU 核**——用 cpuset cgroup 将某些 CPU 核保留给特定进程组，完全排除其他进程：

```bash
# 将 CPU 核 4-7 独占给高优先级服务（需要 root）

# 1. 创建专用 cpuset
mkdir /sys/fs/cgroup/cpuset/realtime

# 2. 分配 CPU 核
echo 4-7 > /sys/fs/cgroup/cpuset/realtime/cpuset.cpus
echo 0   > /sys/fs/cgroup/cpuset/realtime/cpuset.mems   # NUMA 节点 0 的内存

# 3. 将进程加入此 cpuset
echo <pid> > /sys/fs/cgroup/cpuset/realtime/tasks

# 4. 从默认 cpuset 中排除这些核（可选，但推荐）
# 修改根 cpuset 只使用 CPU 0-3（让普通任务只跑在 CPU 0-3）
echo 0-3 > /sys/fs/cgroup/cpuset/cpuset.cpus

# 结果：
# CPU 0-3：运行所有普通进程
# CPU 4-7：只运行高优先级实时服务，完全没有其他进程竞争
```

**Linux kernel 的 `isolcpus` 启动参数**：比 cpuset 更彻底的隔离，将 CPU 核从内核调度器的负载均衡域中完全移除，需要在内核启动参数中设置：

```bash
# 在 /etc/default/grub 中添加
GRUB_CMDLINE_LINUX="isolcpus=4,5,6,7 nohz_full=4,5,6,7 rcu_nocbs=4,5,6,7"
# isolcpus=4-7：不向 CPU 4-7 进行负载均衡迁移
# nohz_full=4-7：在隔离 CPU 上禁用时钟中断（tick-less）
# rcu_nocbs=4-7：RCU 回调不在隔离 CPU 上执行

update-grub
reboot

# 重启后，用 taskset 将进程放到隔离的 CPU 上
taskset -c 4 ./ultra_low_latency_server
# CPU 4 现在只有这一个进程，调度延迟降到 ~10µs 量级
```

---

## 第 4 章 实时调度策略：突破 CFS 的延迟边界

### 4.1 为什么 CFS 无法满足硬实时需求

CFS 的设计目标是"公平性"——所有进程平等地分享 CPU 时间。这对大多数应用合适，但对于需要**确定性低延迟**（如音视频处理、工业控制、高频交易）的场景，"公平"意味着你的实时任务可能被优先级相同的批处理任务延迟数毫秒。

Linux 为此提供了**实时调度策略**，实时进程的优先级高于所有 CFS 进程，保证在就绪时立即抢占 CPU：

### 4.2 实时调度策略：SCHED_FIFO 与 SCHED_RR

```
Linux 调度策略优先级（由高到低）：

SCHED_DEADLINE   优先级 -1（EDF，Earliest Deadline First）
SCHED_FIFO       优先级 1-99（数字越大越高）  ← 实时调度
SCHED_RR         优先级 1-99（数字越大越高）  ← 实时调度
SCHED_OTHER/CFS  优先级 0（普通进程）
SCHED_BATCH      优先级 0（批处理）
SCHED_IDLE       最低优先级（后台任务）
```

**SCHED_FIFO**：实时进程优先占用 CPU，一旦运行不主动让出则不被抢占（除非被更高优先级的实时进程抢占）。适合运行时间有界、需要确定性延迟的任务。

**SCHED_RR**：在 SCHED_FIFO 基础上增加时间片轮转，同优先级的 RR 进程平分 CPU 时间。

```bash
# 将进程设置为 SCHED_FIFO 实时调度（优先级 50）
chrt -f -p 50 <pid>

# 查看进程的调度策略
chrt -p <pid>
# pid 1234's current scheduling policy: SCHED_OTHER
# pid 1234's current scheduling priority: 0

chrt -f -p 50 <pid>
chrt -p <pid>
# pid 1234's current scheduling policy: SCHED_FIFO
# pid 1234's current scheduling priority: 50

# 以实时优先级启动新进程
chrt -f 50 ./my_realtime_server

# 结合 taskset 和 cpuset：
taskset -c 4 chrt -f 80 ./ultra_low_latency_server
# CPU 4 隔离 + SCHED_FIFO 优先级 80 → 确定性调度延迟 < 50µs
```

> [!warning] 生产避坑：SCHED_FIFO 的死锁风险
> SCHED_FIFO 进程一旦进入死循环，将永久占用 CPU，导致整个系统卡死（普通进程无法运行，甚至无法 SSH 登录）。**必须设置 RT 进程的 CPU 时间上限**：
> ```bash
> # 限制实时进程最多使用 95% 的 CPU（留 5% 给系统）
> sysctl -w kernel.sched_rt_runtime_us=950000  # 每 sched_rt_period_us(=1秒)内最多 950ms
> sysctl -w kernel.sched_rt_period_us=1000000
> ```
> 或者在代码中设置看门狗定时器，确保实时进程有明确的退出条件。

### 4.3 SCHED_DEADLINE：基于截止时间的精确实时调度

**SCHED_DEADLINE**（Linux 3.14）是最精确的实时调度策略，允许为每个任务声明：
- `runtime`：每个周期内该任务需要多少 CPU 时间
- `deadline`：截止时间（相对于任务激活时间）
- `period`：任务的激活周期

内核用 **EDF（Earliest Deadline First）** 算法保证：只要总 CPU 需求不超过 100%，每个任务都能在截止时间前完成：

```c
#include <sched.h>
#include <linux/sched.h>

struct sched_attr attr = {
    .size = sizeof(attr),
    .sched_policy = SCHED_DEADLINE,
    .sched_runtime  = 10 * 1000000,   /* 10ms：每个周期需要 10ms CPU */
    .sched_deadline = 20 * 1000000,   /* 20ms：必须在 20ms 内完成 */
    .sched_period   = 100 * 1000000,  /* 100ms：每 100ms 激活一次 */
};

/* 将当前线程设为 DEADLINE 调度 */
if (syscall(__NR_sched_setattr, 0, &attr, 0) < 0) {
    perror("sched_setattr");
}
/* 现在这个线程保证：每 100ms 内，有 10ms 的 CPU 时间，且必须在 20ms 内执行完 */
```

**SCHED_DEADLINE 的准入控制**：内核会拒绝导致总 CPU 利用率超过 100% 的 DEADLINE 任务（`sched_setattr` 返回 EBUSY）。这是系统安全的保障。

---

## 第 5 章 cgroup CPU 资源管理

### 5.1 cgroup v1 CPU 的两个维度

cgroup CPU 子系统提供两个独立的资源控制维度，经常被混淆：

**维度 1：CPU Shares（相对权重，`cpu.shares`）**

CPU Shares 控制当 **CPU 资源有竞争时** 各 cgroup 获得的比例：

```bash
# 查看当前 cgroup 的 cpu.shares
cat /sys/fs/cgroup/cpu/kubepods/burstable/pod<id>/cpu.shares
# 1024  ← 默认值，权重 1

# 设置高优先级服务的权重（10 倍于默认值）
echo 10240 > /sys/fs/cgroup/cpu/my_service/cpu.shares

# 效果：
# my_service（10240 shares）vs 其他（1024 shares × 9个 = 9216 shares）
# 竞争时 my_service 获得约 52% 的 CPU，其他各获得约 5.3%
# 但 CPU 空闲时，任何 cgroup 都可以使用 100% 的 CPU（不限制上限）
```

**重要**：CPU Shares 只在 **CPU 满负载竞争时** 生效。当 CPU 有空闲时，低 shares 的 cgroup 也可以使用全部 CPU——这是一种"弹性"保障，不是硬性限制。

**维度 2：CPU Bandwidth（绝对上限，`cpu.cfs_quota_us` + `cpu.cfs_period_us`）**

CPU Bandwidth 是**绝对 CPU 上限**，无论 CPU 是否空闲都严格执行：

```bash
# 查看 cgroup 的 CPU 配额设置
cat /sys/fs/cgroup/cpu/my_container/cpu.cfs_period_us  # 100000（100ms）
cat /sys/fs/cgroup/cpu/my_container/cpu.cfs_quota_us   # 200000（200ms）
# 含义：每 100ms 周期内，该 cgroup 最多使用 200ms CPU（= 2 个核）

# 在 Kubernetes 中对应 resources.limits.cpu = "2"
# 设置 limits.cpu = "0.5" 等于：
echo 50000 > /sys/fs/cgroup/cpu/my_container/cpu.cfs_quota_us
# 每 100ms 最多用 50ms CPU（= 0.5 核）
```

### 5.2 CPU Throttling 的根本原因与解决方案

**为什么 CPU limit 会造成比预期严重得多的延迟**：

Kubernetes 的 CPU limit 按照 100ms 的周期分配配额，但实际负载往往是**突发性的**——在 100ms 周期的前 10ms 内，服务可能爆发性地处理了大量请求，快速消耗了全部配额（50ms），然后在剩余 90ms 内被强制暂停。即使后续 90ms 内 CPU 完全空闲，服务也无法运行：

```
时间轴（Kubernetes Pod，CPU limit=0.5，period=100ms，quota=50ms）：

0ms ─── 10ms：处理请求爆发，消耗 50ms CPU（quota 用尽）
10ms ─── 100ms：被 THROTTLE 强制停止（90ms 暂停！！）
100ms：新周期开始，quota 恢复
100ms ─── 110ms：继续处理，又消耗 50ms quota
...
```

**解决方案一：提高 CPU limit**（最直接）

```yaml
# Kubernetes Pod 配置
resources:
  requests:
    cpu: "0.5"
  limits:
    cpu: "2"    # 允许突发使用更多 CPU
```

**解决方案二：移除 CPU limit（对非资源敏感的服务）**

在 Kubernetes 中，CPU request 决定调度位置（保证至少有这么多 CPU），CPU limit 决定 throttling。如果集群 CPU 有余量，**可以只设置 request，不设置 limit**——这样服务可以无限制地使用空闲 CPU，完全消除 throttling：

```yaml
resources:
  requests:
    cpu: "0.5"
  # limits: 不设置！
```

**解决方案三：使用 cgroup v2 + burst 特性**

cgroup v2 引入了 `cpu.max.burst`，允许 cgroup 在低负载时"储蓄"未使用的 CPU 配额，在突发时使用，缓解周期性 throttling 的影响（Linux 5.14+）：

```bash
# cgroup v2 设置（Kubernetes 1.25+ 使用 cgroup v2）
echo "50000 100000" > /sys/fs/cgroup/my_pod/cpu.max
# 格式：quota period（单位：µs）
# 50ms/100ms = 0.5 核

echo "30000" > /sys/fs/cgroup/my_pod/cpu.max.burst
# 允许突发借用最多 30ms 的额外配额（来自历史储蓄）
```

### 5.3 实时监控 CPU Throttling

```bash
# 方法 1：直接读取 cgroup 统计
watch -n 1 "cat /sys/fs/cgroup/cpu/my_container/cpu.stat"

# 方法 2：Prometheus + cAdvisor（Kubernetes 标准方案）
# container_cpu_throttled_seconds_total
# container_cpu_cfs_throttled_periods_total
# container_cpu_cfs_periods_total

# 告警规则（throttle 比率超过 25% 时告警）
# sum(rate(container_cpu_cfs_throttled_periods_total[5m])) by (pod, container)
# /
# sum(rate(container_cpu_cfs_periods_total[5m])) by (pod, container)
# > 0.25

# 方法 3：bpftrace 实时追踪 throttle 事件
bpftrace -e '
tracepoint:cgroup:cgroup_throttle_count {
    printf("THROTTLE: cgroup=%s count=%d\n",
           args->path, args->count);
}'
```

---

## 第 6 章 综合调优策略

### 6.1 低延迟服务的调度调优清单

针对 P99 延迟 < 1ms 的延迟敏感型服务：

```bash
# 1. 隔离 CPU 核（BIOS + 内核启动参数）
# GRUB_CMDLINE_LINUX="isolcpus=4-7 nohz_full=4-7 rcu_nocbs=4-7"

# 2. 关闭 NUMA 均衡（避免内存自动迁移引起 TLB flush）
sysctl -w kernel.numa_balancing=0

# 3. 设置进程 CPU 亲和性
taskset -c 4-7 ./my_service  # 或配合 cpuset cgroup

# 4. 可选：提升调度优先级（需权限）
chrt -f 50 ./my_service  # SCHED_FIFO 50

# 5. 减少调度周期（更激进的抢占）
sysctl -w kernel.sched_min_granularity_ns=500000    # 最小时间片 0.5ms（默认 0.75ms）
sysctl -w kernel.sched_wakeup_granularity_ns=500000  # 唤醒粒度 0.5ms

# 6. 禁用不必要的中断（减少 CPU 被中断打扰）
# 将网卡中断绑定到非服务 CPU
for irq in $(cat /proc/interrupts | grep eth0 | awk -F: '{print $1}'); do
    echo 0xf > /proc/irq/$irq/smp_affinity  # CPU 0-3 处理网卡中断
done
# 服务 CPU（4-7）不处理中断，专心计算
```

### 6.2 调度延迟与吞吐量的权衡

调度延迟优化和吞吐量优化往往是矛盾的：

| 调优方向 | 对延迟的影响 | 对吞吐量的影响 |
|---------|------------|--------------|
| CPU 亲和性绑定 | ✅ 降低跨核迁移延迟 | ❌ 减少负载均衡灵活性，可能降低整体利用率 |
| `isolcpus` 核心隔离 | ✅ 消除调度竞争 | ❌ 隔离的核不参与整体负载均衡 |
| SCHED_FIFO 实时 | ✅ 立即抢占，最低调度延迟 | ❌ 可能饿死其他进程 |
| 减少 sched_latency_ns | ✅ 缩短最大等待时间 | ❌ 增加上下文切换频率，降低缓存效率 |
| 移除 cgroup CPU limit | ✅ 消除 throttling | ❌ 失去资源保证，可能影响同节点服务 |

**黄金法则**：只有当你**用 `perf sched` 或 `bpftrace` 确认调度延迟是 P99 毛刺的真实根因**后，才应该调整调度参数。盲目调整调度策略可能适得其反（过度使用 SCHED_FIFO 会导致系统稳定性问题）。

---

## 小结

CPU 调度延迟是低延迟服务 P99 毛刺最常见的隐藏原因之一，因为它不会出现在 on-CPU 火焰图中（进程处于等待状态，没有消耗 CPU）：

**诊断工具优先级**：
1. `bpftrace` 实时唤醒延迟追踪（最直接，超过 1ms 的调度延迟立即可见）
2. `perf sched latency`（事后分析，给出每个进程的平均/最大调度延迟统计）
3. cgroup `cpu.stat` 的 `nr_throttled` 计数（快速判断是否有 CPU throttling）

**三类根因对应的解决方案**：
- **多进程 CPU 竞争** → CPU 亲和性绑定（`taskset`）+ `isolcpus` 核心隔离
- **实时性需求** → `SCHED_FIFO`/`SCHED_RR` 实时调度 + `chrt` 设置优先级
- **cgroup CPU throttling** → 提高 CPU limit / 移除 limit / 使用 cgroup v2 burst

下一篇 [[04 内存性能调优——NUMA 拓扑、大页与内存带宽]] 将深入内存性能的硬件维度：NUMA 不均衡（跨节点内存访问慢 2 倍）、HugePage 减少 TLB Miss（工作集大的数据库/缓存服务的必选项）、以及内存带宽饱和（当内存总线成为瓶颈时，加更多 CPU 核也无法提升性能）的诊断与优化。

---

> [!note] 思考题
> 1. CFS 的调度延迟取决于可运行进程数。Kubernetes 节点上 50+ Pod 竞争 CPU 时，CFS 的调度延迟如何影响延迟敏感应用？`sched_min_granularity_ns`（最小时间片）设置过小会增加上下文切换开销，过大会增加调度延迟——如何找到平衡？
> 2. 在 NUMA 架构中，CPU 亲和性（`taskset`）可以避免跨节点内存访问（~70ns vs ~120ns）。但绑定可能导致负载不均。在一个 2-Socket 64 核的 NUMA 机器上运行数据库，你会选择将数据库绑定到一个 Socket 还是让 CFS 自由调度？`numactl --interleave=all` 在这里有什么作用？
> 3. CGroups v2 的 `cpu.max` 限制 CPU 带宽。被限流时 `cpu.stat` 的 `nr_throttled` 持续增加。如果一个容器的 CPU limit 设为 2 核，但它的代码在 GC 时需要 4 核并发——GC 会被限流导致停顿时间翻倍。你如何判断 CPU 限流是否影响了 GC 性能？是调大 limit 还是优化 GC？
