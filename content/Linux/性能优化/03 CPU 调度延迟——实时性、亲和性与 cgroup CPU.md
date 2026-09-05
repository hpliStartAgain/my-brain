---
title: "CPU 调度延迟——实时性、亲和性与 cgroup CPU"
date: 2026-03-02
tags: [CFS, cgroups, CPU亲和性, Linux, numactl, SCHED_FIFO, SCHED_DEADLINE, taskset, 实时调度, 延迟抖动, 性能优化, 性能调优, 调度延迟, isolcpus, cpuset, EEVDF]
aliases: ["CPU调度延迟优化", "调度延迟分析", "CPU亲和性设置", "cgroup CPU调优", "实时进程调度", "CPU throttling", "cgroup v2", "SCHED_RR"]
---

# 03 CPU 调度延迟——实时性、亲和性与 cgroup CPU

**摘要：**
P99 延迟毛刺是低延迟服务最难排查的问题之一，因为它往往不是代码慢，而是进程在等待 CPU 调度——即进程已经"就绪"（有数据可处理），但 CPU 被别的任务占用，等待了数毫秒才被调度到 CPU 上执行。这类问题在 `perf` 的 on-CPU 火焰图中几乎看不到（因为进程处于 off-CPU 状态，没有被采样到）。本文从 Linux CFS 调度器的延迟来源出发，深入分析三类调度延迟问题：调度器固有延迟（唤醒延迟、调度周期、抢占延迟）、CPU 资源竞争（多进程竞争同一 CPU 核）、cgroup CPU Bandwidth Throttling（容器 CPU 限制的毫秒级周期性节流）。每类问题给出诊断工具（`schedstat`、`perf sched`、bpftrace 调度追踪）和具体的优化手段（CPU 亲和性绑定、`taskset`/`cpuset`、实时调度策略、cgroup CPU 隔离）。

---

## 第 1 章 从 O(1) 到 CFS 再到 EEVDF——Linux 调度器的演进

### 1.1 调度器演化的三条路线

理解调度延迟之前，先回顾 Linux 调度器的演化史。Linux 2.4 时代的调度器是 O(n) 算法——每次调度都要遍历所有可运行进程，进程数多了性能急剧下降。Linux 2.6（2003 年）引入了 Ingo Molnar 的 O(1) 调度器——用优先级数组 + 位图查找，调度复杂度降到 O(1)，不再随进程数增长。但 O(1) 调度器有一个问题——它基于固定时间片 + 启发式的优先级调整，对交互式进程的"公平性"靠经验规则判断，在极端负载下表现不稳定，某些进程可能长时间得不到 CPU。

2007 年，Ingo Molnar 重写了调度器，推出了 **CFS（Completely Fair Scheduler，完全公平调度器）**——基于红黑树 + 虚拟运行时间（vruntime）的算法，目标是"完全公平"——每个进程按权重比例获得 CPU 时间，无需启发式调整。CFS 的核心思想是追踪每个进程的"虚拟运行时间"（vruntime），vruntime 最小的进程下一个被调度——这保证了"运行最少的进程优先调度"，实现了真正的公平。CFS 从 2.6.23 合入主线，统治了 Linux 普通进程调度十多年。

2023 年，Linux 6.6 合入了 **EEVDF（Earliest Eligible Virtual Deadline First）** 调度器，由 Peter Zijlstra 开发，替代 CFS。EEVDF 解决了 CFS 的几个长期问题——延迟敏感进程的优先级提升、精确的延迟保证、更好的权重公平性。EEVDF 引入了"资格"（eligibility）和"截止时间"（deadline）概念，让调度器能更精确地控制"谁先跑"和"跑多久"。但 EEVDF 的核心机制（vruntime + 红黑树）与 CFS 一脉相承，本文以 CFS/EEVDF 的共同机制为基础讨论调度延迟——两者的延迟来源和优化手段基本相同。

EEVDF 相比 CFS 的改进值得多说几句。CFS 的一个长期问题是"延迟敏感进程的优先级提升不够灵活"——CFS 用 nice 值调整权重，但 nice 值只影响"时间片长短"，不直接影响"调度延迟"。一个 nice -20 的进程时间片更长，但在就绪队列里仍要等 vruntime 最小才能跑——如果队列里有多个 nice 0 的进程，nice -20 的进程仍可能等一个调度周期。EEVDF 引入了"延迟优先级"（latency nice）——直接控制进程的"最大调度延迟"，延迟敏感进程可以设低延迟优先级，调度器保证它在更短时间内被调度。这是 CFS 做不到的——CFS 只能通过"权重"间接影响延迟，EEVDF 能直接控制延迟。**EEVDF 的"延迟优先级"是 CFS 缺失的能力**——它让延迟敏感进程有了"插队"的合法途径，而非只能靠实时调度（SCHED_FIFO）这种"极端手段"。

### 1.2 CFS/EEVDF 的"公平"与延迟的矛盾

[[进程管理/08 CFS 完全公平调度器——从 O(1) 到红黑树的演进]] 中已经深入解析了 CFS 的核心机制。这里从性能优化角度提炼关键点：

CFS 的"公平性"建立在**时间片轮转**基础上：每个可运行的进程都有机会占用 CPU，但每次占用时间有限（`sched_latency_ns / 进程数`，默认最大 24ms）。当进程用完时间片后，被抢占、加入就绪队列尾部，等待下一轮调度。

**这里隐藏了第一类调度延迟**：假设系统有 N 个可运行进程，调度延迟（一个进程从"就绪"到"真正被调度"的最大等待时间）约为：

```
调度延迟 ≈ sched_latency_ns = max(N × sched_min_granularity_ns, 6ms)

在 8 个可运行进程时：
  调度延迟 ≈ 8 × 0.75ms = 6ms  ← 最坏情况：一个进程必须等 6ms 才能获得 CPU！
```

对于 P99 要求 < 1ms 的服务，6ms 的调度延迟意味着毛刺几乎无法避免——只要 CPU 上有多个进程竞争。这就是 CFS "公平性"与"低延迟"的根本矛盾——公平意味着所有进程平等排队，低延迟意味着某些进程要"插队"。CFS 默认的"公平优先"策略对普通服务够用，但对延迟敏感的服务（交易、实时流处理）不够——后者需要"延迟优先"的调度策略，这就是后续要讲的实时调度（SCHED_FIFO/RR/DEADLINE）和 CPU 隔离（isolcpus）的动机。

CFS 的"公平"还有一个与"权重"相关的细节——CFS 不是绝对公平，而是"按权重公平"。每个进程有一个 nice 值（-20 到 +19），nice 值映射到权重（1024 到 110712），权重决定了进程获得的 CPU 时间比例。nice 值每差 1，权重差约 25%——nice -20 的进程比 nice 0 的进程多约 10 倍 CPU 时间。但"多 10 倍 CPU 时间"不等于"10 倍快"——如果 CPU 有空闲，所有进程都能跑满；只有 CPU 竞争时，权重才决定比例。**nice 值是"竞争时的相对优先级"，不是"绝对速度"**——这是 CFS 公平性的精确含义。

### 1.3 三类调度延迟

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

进程被唤醒（从睡眠转为就绪）后，到真正执行的时间。在单核场景，这几乎是零（立即抢占当前进程）；在多核场景，唤醒的进程可能被调度到不同 CPU，需要跨 CPU 迁移，增加了 100µs-1ms 的延迟。唤醒延迟的优化手段是"唤醒抢占"（wake_preempt）——唤醒一个进程时，如果它的 vruntime 小于当前运行进程，立即触发抢占，不等当前进程的时间片用完。CFS 默认开启唤醒抢占，但抢占粒度由 `sched_wakeup_granularity_ns` 控制——粒度太小会频繁抢占（上下文切换开销大），粒度太大会延迟抢占（唤醒进程等更久）。

唤醒延迟还有一个与"唤醒亲和性"（wake affinity）相关的优化——内核唤醒进程时，会优先选择它上次运行的 CPU（因为那个 CPU 的缓存里可能有它的数据）。但如果那个 CPU 很忙，内核会考虑迁移到空闲 CPU——这要在"缓存亲和性"和"负载均衡"之间权衡。`sched_wake_idle_near_cpu` sysctl 控制这个策略——如果开启，唤醒时优先选择空闲 CPU（即使不是上次运行的 CPU），减少等待时间；如果关闭，优先选择上次运行的 CPU（即使要排队），保持缓存亲和性。**唤醒亲和性是"缓存 vs 延迟"的权衡**——缓存亲和性好的场景（大工作集）优先选上次 CPU，延迟敏感的场景（小工作集）优先选空闲 CPU。

**类型 2：调度周期延迟（Scheduling Period Delay）**

当多个进程竞争同一 CPU 时，每个进程必须等待其他进程用完时间片。这是导致 P99 毛刺的最常见原因。调度周期延迟的优化手段是"减少竞争者"——用 CPU 亲和性绑定把进程限制到专用 CPU 核，让该核上只有这一个进程，调度周期延迟降到接近零。

调度周期延迟还有一个与"负载均衡"相关的加重因素——CFS 的负载均衡器会定期在 CPU 核间迁移进程以保持负载均衡，但迁移本身会引入延迟（进程被迁移后要重新排队）。如果负载均衡器频繁迁移一个进程（譬如每 10ms 迁移一次），该进程的调度延迟会显著增加——它在每个核上都待不久就被迁走，然后在新核上重新排队。`isolcpus` 能消除这种迁移——隔离的核不参与负载均衡，进程放上去就不再迁移。**负载均衡是"整体公平"与"个体延迟"的矛盾**——负载均衡让所有核的负载均匀（整体公平），但迁移会让被迁移的进程延迟增加（个体延迟）。

**类型 3：cgroup CPU Throttling**

Kubernetes 等容器平台为 Pod 设置了 CPU limit。cgroup v1 的 CPU Bandwidth Controller 以 100ms 为周期分配 CPU 配额（`cpu.cfs_quota_us`）。当 Pod 用完本周期配额时，被**强制暂停**，直到下一个 100ms 周期开始——这会导致固定周期的调度延迟，是容器化服务 P99 抖动的主要来源之一。cgroup throttling 的优化手段是"提高 limit 或移除 limit"，或用 cgroup v2 的 burst 特性缓解。

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph TD
    PKT["网络包到达"] --> IRQ["硬中断处理<br/>2-10µs"]
    IRQ --> NAPI["NAPI 软中断<br/>10-50µs"]
    NAPI -> WAKE["唤醒目标进程<br/>加入就绪队列"]
    WAKE -> WAIT["等待被调度<br/>0 ~ 6ms（最大来源）"]
    WAIT -> RUN["进程在 CPU 上执行"]
    WAKE -.->|跨核迁移| MIG["100µs-1ms 额外延迟"]
    WAIT -.->|cgroup throttle| THROTTLE["被暂停到下个周期<br/>最多 100ms"]

    classDef event fill:#44475a,stroke:#ff79c6,color:#f8f8f2
    classDef fast fill:#282a36,stroke:#50fa7b,color:#f8f8f2
    classDef slow fill:#44475a,stroke:#ff5555,color:#f8f8f2
    classDef optional fill:#282a36,stroke:#ffb86c,color:#f8f8f2
    class PKT event
    class IRQ,NAPI,WAKE fast
    class WAIT slow
    class RUN fast
    class MIG,THROTTLE optional
```

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

`nr_involuntary_switches` 和 `nr_voluntary_switches` 的区分对诊断很有价值。主动切换（voluntary）是进程主动调用 `sched_yield()`、`sleep()`、`wait()` 等让出 CPU——这是正常的，说明进程在等 IO 或锁。被动切换（involuntary）是进程被强制抢占——时间片用完了，或更高优先级进程来了。被动切换多说明"CPU 不够用，进程被迫轮流跑"——这是调度延迟的根因。**主动切换多看 IO/锁，被动切换多看 CPU 竞争**——两类切换指向不同的优化方向。

`/proc/<pid>/sched` 还有一个与"调度延迟"直接相关的字段——`wait_sum`（累积等待时间）和 `wait_avg`（平均等待时间）。`wait_sum` 是进程从启动以来在就绪队列里等待的总时间，`wait_avg` 是平均每次调度的等待时间。如果 `wait_avg` 是 100µs，说明进程每次被唤醒后平均等 100µs 才上 CPU——这是健康的；如果 `wait_avg` 是 5ms，说明进程每次要等 5ms——这是调度延迟问题的信号。`wait_sum` 除以进程的运行时间，得到"等待时间占比"——如果占比 > 50%，说明进程大部分时间在等 CPU 而非跑 CPU，CPU 资源严重不足。**`wait_avg` 看单次延迟，`wait_sum` 占比看整体资源充足度**——两者结合能快速判断"调度延迟是偶发还是系统性"。

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

`perf sched` 的输出有三个关键列——`Average delay`（平均调度延迟）、`Maximum delay`（最大调度延迟）、`Switches`（上下文切换次数）。`Maximum delay` 对应 P100 延迟（最坏情况），是排查毛刺的首要指标——如果最大延迟 45ms，说明有一次调度进程等了 45ms，这就是毛刺的来源。`Average delay` 对应平均延迟，反映整体调度健康度——平均延迟高说明调度延迟是系统性问题，平均延迟低但最大延迟高说明是偶发毛刺。**Average 看趋势，Maximum 找毛刺**——两者结合才能完整评估调度性能。

`perf sched` 还有一个与"时间线回放"相关的高级用法——`perf sched script` 能回放完整的调度事件序列，看"某一时刻谁在跑谁在等"。这对"毛刺时刻的归因"很有价值——譬如 P99 毛刺发生在 10:05:32，用 `perf sched script` 回放这个时间点的调度序列，能看到"10:05:32.001 进程 A 被唤醒，10:05:32.005 进程 B 还在跑，10:05:32.006 进程 A 才被调度"——这就定位到了"进程 B 占用 CPU 导致进程 A 等了 5ms"。**`perf sched script` 是"调度事件的慢动作回放"**——能精确还原毛刺时刻的调度序列，是毛刺归因的终极工具。

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

bpftrace 相比 perf sched 的优势是"实时 + 精确"——perf sched 要先采集再分析，bpftrace 能在采集的同时实时输出超阈值的事件。这对生产环境的"在线诊断"很有价值——譬如线上服务出现毛刺，bpftrace 能立即抓到"哪次调度延迟了多久"，而不需要先采集 5 秒再分析。bpftrace 的直方图模式还能展示调度延迟的分布——大部分调度延迟在 10-100µs，但尾部有 1-10ms 的长尾，直方图让长尾一目了然。**perf sched 适合事后分析，bpftrace 适合实时诊断**——两者互补，根据场景选择。

bpftrace 还有一个与"调度延迟归因"相关的高级用法——追踪"进程被唤醒后，是哪个进程在占用 CPU"。当调度延迟高时，知道"谁在占用 CPU 导致我的进程等"很有价值——bpftrace 能在 `sched_switch` 事件里同时拿到"被唤醒的进程"和"当前在跑的进程"，直接定位"是谁阻塞了我的进程"。这种"归因到具体进程"的能力是 perf sched 没有的——perf sched 只能看到"调度延迟 5ms"，但不知道"这 5ms 里是谁在跑"。**bpftrace 能做到"延迟归因到进程"，perf sched 只能"延迟归因到统计"**——这是 bpftrace 在调度诊断上的独特优势。

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

cgroup throttling 的诊断有一个"隐蔽性"问题——它不出现在 `perf sched` 的调度延迟里。`perf sched` 追踪的是 `sched_switch` 事件（进程切换），而 throttling 是"进程被禁止运行"——进程不在就绪队列里，也不在 CPU 上，处于一种"被 cgroup 冻结"的状态。`perf sched` 看不到这种状态，只有 cgroup 的 `cpu.stat` 能看到。**throttling 是"第三种 off-CPU 状态"**——除了等锁、等 IO、等调度，还有"被 cgroup 暂停"——这是容器化环境特有的 off-CPU 来源，传统调度分析工具容易漏掉。

throttling 的诊断还有一个与"周期性"相关的识别特征——throttling 导致的延迟有固定周期（100ms 或 1ms，取决于 cgroup period）。如果一个服务的 P99 延迟毛刺以固定间隔出现（譬如每 100ms 一次），很可能是 cgroup throttling——这种"周期性毛刺"是 throttling 的指纹。而 CPU 竞争导致的调度延迟是随机分布的（没有固定周期），锁竞争导致的延迟与请求模式相关（跟随负载波动）。**"周期性毛刺"指向 throttling，"随机毛刺"指向 CPU 竞争，"负载相关毛刺"指向锁/IO**——毛刺的时间分布是归因的第一线索。

毛刺归因还有一个与"时间精度"相关的实践——要精确归因，需要毫秒级甚至微秒级的时间戳。`perf sched` 的时间戳精度是微秒级，bpftrace 也是——它们能精确还原"某一毫秒内发生了什么"。但如果用应用层日志（譬如 Nginx 的 request_time），精度通常只有毫秒级，且只记录"请求开始和结束"，不记录"中间等了多久"。所以毛刺归因通常要结合"应用层日志"（定位毛刺时刻）和"系统层工具"（定位毛刺原因）——应用日志告诉你"10:05:32 有个请求花了 50ms"，perf sched 告诉你"10:05:32 进程等了 45ms CPU"。**应用日志定位时刻，系统工具定位原因**——两层结合才能完整归因。

---

## 第 3 章 CPU 亲和性：消除跨核调度开销

### 3.1 为什么需要 CPU 亲和性

Linux 调度器默认会在多个 CPU 核间迁移进程，以实现负载均衡。但频繁的跨核迁移有两类代价：

**代价 1：缓存失效**。进程从 CPU 0 迁移到 CPU 3 后，CPU 0 L1/L2 缓存中属于该进程的数据（工作集）在 CPU 3 上不存在，需要重新从 L3 或 DRAM 加载——对于有大量工作集的服务（如大缓冲区的数据库），这会导致迁移后几毫秒内的性能下降。这就像一个工人从一张工作台换到另一张——新工作台上没有他熟悉的工具，要重新找一遍。

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

`taskset` 的绑定是"软绑定"——进程只能在指定 CPU 上跑，但指定 CPU 上还可以跑其他进程。这意味着绑定后仍有调度竞争——如果 CPU 0 上还有其他进程，你的进程仍要排队。要彻底消除竞争，需要"硬隔离"——把 CPU 核从调度器的负载均衡域中移除，让该核只跑你的进程，这就是后续要讲的 `isolcpus` 和 `cpuset cgroup`。**`taskset` 是"限制范围"，`isolcpus` 是"独占核心"**——前者减少跨核迁移，后者消除竞争，两者经常配合使用。

`taskset` 的使用有一个与"多线程"相关的注意点——`taskset -p` 只绑定进程的主线程，不自动绑定进程的所有线程。一个多线程进程（譬如 8 线程的 Java 服务）用 `taskset -p 0xf <pid>` 绑定后，只有主线程被绑定，其他 7 个线程仍可在所有 CPU 上跑。要绑定所有线程，需要用 `taskset -p` 对每个线程 ID（TID）单独设置，或用 cpuset cgroup（cgroup 里的所有进程自动继承绑定）。**多线程进程的绑定要用 cpuset cgroup，而非 `taskset`**——这是多线程服务 CPU 亲和性配置的常见坑。

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

cpuset cgroup 的隔离粒度比 `taskset` 更强——`taskset` 只限制"进程能跑在哪些核"，cpuset cgroup 能限制"哪些核只跑哪些进程"。配合第 4 步（从默认 cpuset 排除这些核），能实现真正的"核独占"——CPU 4-7 上只有 realtime cgroup 里的进程，普通进程无法进入。这种隔离对延迟敏感服务至关重要——独占的核上没有竞争者，调度延迟降到接近零。

cpuset cgroup 还有一个与"NUMA"相关的配置——`cpuset.mems` 指定 cgroup 使用的 NUMA 节点。配合 `cpuset.cpus`，能实现"CPU + 内存"的双重 NUMA 绑定——进程只在 NUMA 0 的 CPU 上跑，只分配 NUMA 0 的内存，所有访问都是本地访问，消除跨节点延迟。这是 NUMA 优化的标准做法，第 04 篇会详细讲。**cpuset cgroup 是"CPU 隔离 + NUMA 绑定"的一体化方案**——一个配置同时解决两个问题。

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

`isolcpus` 的隔离比 cpuset 更彻底——它从内核调度器层面把 CPU 核"踢出"负载均衡域，普通进程根本不会被调度到这些核上。配合 `nohz_full`（禁用时钟中断）和 `rcu_nocbs`（RCU 回调迁移到其他核），隔离的 CPU 上几乎没有内核活动——只有你放上去的那个进程在跑。这种"极致隔离"能把调度延迟从毫秒级降到微秒级，是高频交易、实时控制等场景的标准配置。但代价是"核浪费"——隔离的核不参与普通负载均衡，整机 CPU 利用率上限降低。**`isolcpus` 是"用资源换确定性"的极致**——延迟敏感场景值得，吞吐优先场景不值得。

`isolcpus` 还有一个与"中断"相关的配合优化——即使 CPU 核被隔离，如果网卡中断仍然路由到这个核，中断处理会打断你的进程。所以隔离时要同时把中断绑定到非隔离核——`echo <non-isolated-cpu-mask> > /proc/irq/<irq>/smp_affinity`。这个步骤容易被忽略——很多人设了 `isolcpus` 但没绑中断，结果隔离核上仍有网卡中断打扰，调度延迟没降到预期。**`isolcpus` + 中断绑定 + `nohz_full` + `rcu_nocbs` 是"四位一体"的隔离方案**——任何一个漏了，隔离就不彻底。

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

**SCHED_FIFO**：实时进程优先占用 CPU，一旦运行不主动让出则不被抢占（除非被更高优先级的实时进程抢占）。适合运行时间有界、需要确定性延迟的任务。FIFO 的语义是"先到先得，不让就一直跑"——同优先级的 FIFO 进程按就绪顺序排队，先就绪的先跑，跑到主动让出为止。

**SCHED_RR**：在 SCHED_FIFO 基础上增加时间片轮转，同优先级的 RR 进程平分 CPU 时间。RR 的语义是"轮流跑"——同优先级的 RR 进程各跑一个时间片后轮换，避免某个 FIFO 进程不让出导致其他同优先级进程饿死。

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

SCHED_FIFO 的死锁风险是实时调度的"双刃剑"——它保证了实时进程的确定性延迟，但也意味着实时进程的 bug（死循环、长时间不让出）会卡死整个系统。`sched_rt_runtime_us` 是内核的"安全网"——限制实时进程最多用 95% 的 CPU，留 5% 给普通进程和系统维护。但这个安全网也有代价——如果你的实时进程确实需要 100% CPU（譬如高频交易的持续计算），95% 的限制会让它在最后 5% 时间被强制让出，引入延迟抖动。**`sched_rt_runtime_us` 是"安全 vs 确定性"的权衡**——默认 95% 安全，需要 100% 确定性的场景要调到 100%（但要确保实时进程不会死循环）。

SCHED_FIFO 的优先级设置有一个经验法则——不要用 99（最高优先级），留几级给系统进程。如果两个服务都设 99，它们之间无法区分优先级；如果系统有内核线程需要实时调度（譬如高精度定时器 hrtimer），你的 99 进程会和它竞争。推荐的范围是 50-80——足够高于普通进程，又留了余地给系统实时线程。**SCHED_FIFO 优先级"留余地"比"用最高"更稳妥**——这是生产环境的实践智慧。

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

SCHED_DEADLINE 相比 SCHED_FIFO/RR 的优势是"确定性保证"——FIFO/RR 只保证优先级高，但不保证"什么时候完成"；DEADLINE 通过 EDF 算法 + 准入控制，数学上保证"只要总需求不超过 100%，每个任务都在截止时间前完成"。这种保证对硬实时系统（工业控制、航空航天）至关重要——它们需要的是"可证明的确定性"，而非"通常很快"。SCHED_DEADLINE 的代价是"配置复杂"——要精确知道每个任务的 runtime/deadline/period，且总利用率不能超 100%。**SCHED_DEADLINE 是"用配置复杂度换数学保证"的实时策略**——硬实时场景值得，软实时场景用 FIFO/RR 够了。

SCHED_DEADLINE 还有一个与"多核"相关的限制——它的 CPU 带宽计算是 per-core 的，但 DEADLINE 任务可以在核间迁移（除非用 affinity 绑定）。迁移会带来 cache miss，可能让任务的执行时间超过 `runtime`，导致 deadline miss。所以 SCHED_DEADLINE 通常配合 CPU affinity 使用——把任务绑到固定核，消除迁移开销，让 `runtime` 的估计更准确。**SCHED_DEADLINE + CPU affinity 是硬实时的标准组合**——前者保证截止时间，后者消除迁移抖动。

SCHED_DEADLINE 的使用还有一个与"准入控制"相关的实践——添加新 DEADLINE 任务前，要计算现有 DEADLINE 任务的总利用率 + 新任务的利用率是否超过 100%。譬如现有任务用了 60% CPU，新任务需要 50%，总和 110% 超过 100%，`sched_setattr` 会返回 EBUSY。这意味着 DEADLINE 任务的"添加"要谨慎——不能无脑加，要算总账。对动态创建任务的场景（譬如每次请求创建一个 DEADLINE 线程），这种"准入控制"很麻烦——要预先规划好总利用率分配。**SCHED_DEADLINE 适合"固定任务集"的场景，不适合"动态任务"的场景**——这是它不如 SCHED_FIFO 灵活的地方。

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

Shares 和 Bandwidth 的区别是"软限制 vs 硬限制"——Shares 是"竞争时的比例"，Bandwidth 是"任何时候的上限"。一个常见的混淆是"设了 Shares 为什么还 throttle"——因为 Shares 不限制上限，Bandwidth 才限制。Kubernetes 的 `requests.cpu` 对应 Shares（调度位置），`limits.cpu` 对应 Bandwidth（执行上限）。**`requests` 决定"放哪"，`limits` 决定"跑多快"**——两者独立，不要混淆。

Shares 和 Bandwidth 的配合有一个"最佳实践"——对延迟敏感服务设高 shares（竞争时优先），不设 limits（避免 throttling）；对批处理服务设低 shares（竞争时让步），设 limits（限制最大 CPU）。这样延迟敏感服务在 CPU 紧张时优先获得 CPU，在 CPU 空闲时能无限制使用；批处理服务在 CPU 紧张时让步，在 CPU 空闲时用剩余资源，但不抢占延迟敏感服务。**"延迟敏感高 shares 无 limits，批处理低 shares 有 limits"是 Kubernetes CPU 配置的黄金模式**——既保证延迟敏感服务的优先级，又限制批处理服务的资源占用。

这个黄金模式还有一个与"request 值"相关的细节——request 决定 Pod 被调度到哪个节点（节点要有足够 CPU 余量），也决定 cgroup 的 cpu.shares（shares = request × 1024）。所以 request 要"真实反映服务的常态 CPU 需求"——设低了 Pod 可能被调度到 CPU 紧张的节点（request 是调度依据），设高了浪费集群资源（节点为 Pod 预留了用不完的 CPU）。一个常见错误是"request 设很低，limit 设很高"——以为这样能"省资源又能突发"，但 request 低意味着 shares 低，CPU 紧张时优先级低，突发时反而抢不到 CPU。**request 要反映常态需求，不能为了省资源而设低**——这是 Kubernetes CPU 配置的另一个常见坑。

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

cgroup v2 的 burst 特性是"用历史储蓄缓解突发"——如果前几个周期没用满配额，剩余的配额"储蓄"起来，下一个周期突发时可以借用储蓄的配额，不被 throttle。这比 cgroup v1 的"用完即停"更友好——突发性负载不再被硬性截断。但 burst 也有上限——储蓄不能无限累积（默认上限是一个周期的配额），且借用后后续周期的可用配额会减少（要"还"储蓄）。**burst 是"用弹性换平滑"的 throttling 缓解**——比 v1 的硬性截断好，但不如"移除 limit"彻底。

移除 CPU limit 有一个与"资源隔离"相关的风险——如果集群 CPU 不余量，移除 limit 的服务可能抢占其他服务的 CPU，导致其他服务延迟升高。所以"移除 limit"的前提是"集群 CPU 有余量"或"服务之间有信任关系"（譬如同一个团队的服务，互相不抢资源）。在多租户集群中，移除 limit 是危险的——租户的服务可能互相抢占。**"移除 limit"适合单租户或信任环境，多租户环境要用 burst 或合理设置 limit**——这是 Kubernetes CPU 管理的安全考量。

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

throttling 的监控有一个与"延迟归因"相关的实践——当服务 P99 延迟升高时，要同时看 throttling 指标和调度延迟指标。如果 throttling 比例高，根因是 cgroup 限制；如果调度延迟高但 throttling 低，根因是 CPU 竞争；如果两者都不高但延迟仍高，根因在应用层（锁、IO、GC）。**throttling + 调度延迟 + 应用层，三者构成延迟归因的完整诊断链**——逐项排查，才能定位真正的根因。

throttling 的监控还有一个与"GC 交互"的特殊场景——JVM 的 GC 是 CPU 密集型操作（并行 GC 需要多核并发），如果容器 CPU limit 低于 GC 所需的核数，GC 会被 throttle，导致 GC 停顿时间翻倍。这种"GC throttle"在 Java 服务的 Kubernetes 部署中很常见——CPU limit 设了 2 核，但 Parallel GC 想用 4 核，被 throttle 后 GC 时间从 50ms 变成 200ms。诊断方法是看 GC 日志的停顿时间与 cgroup throttle 时间的对应关系——如果 GC 停顿时间长的时段恰好是 throttle 高的时段，根因就是 GC 被 throttle。解法是调大 CPU limit 或换用对 CPU 更友好的 GC（譬如 ZGC，单核也能高效工作）。**Java 服务的 CPU limit 要考虑 GC 的并发需求**——这是 JVM + Kubernetes 的特殊调优点。

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

这个调优清单的顺序有讲究——从"硬件/内核级"到"进程级"逐层深入。`isolcpus` 是内核启动参数（最底层），`numa_balancing` 是 sysctl（内核配置），`taskset` 是进程绑定（进程级），`chrt` 是调度策略（进程级），`sched_min_granularity` 是调度器调优（内核配置），中断绑定是硬件级。**从底到顶调优**——先隔离 CPU 核（消除竞争），再绑定进程（消除迁移），再调调度参数（优化抢占），最后绑中断（消除干扰）。顺序反了效果打折——譬如不隔离 CPU 核就调 `sched_min_granularity`，竞争者多时调参收益有限。

这个调优清单还有一个与"验证"相关的步骤——调优后要重新 profile 确认效果。用 `bpftrace` 重新测调度延迟，对比调优前后的 P99 调度延迟——如果从 5ms 降到 100µs，调优有效；如果没降，说明根因不在调度（可能在锁或 IO），要换方向。**"调优前测、调优后测、对比"是调度优化的闭环**——没有验证的调优是"盲调"，可能改了一堆参数但没效果。

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

延迟与吞吐的矛盾本质上是"公平 vs 优先"的矛盾——CFS 的"公平"最大化吞吐（所有进程都有机会跑，CPU 利用率高），但牺牲了延迟（实时进程要排队）；实时调度的"优先"最小化延迟（实时进程立即跑），但牺牲了吞吐（其他进程被饿死，CPU 利用率可能降低）。**延迟敏感服务选"优先"，吞吐优先服务选"公平"**——没有两全其美，只有场景匹配。

延迟与吞吐的权衡还有一个与"成本"相关的维度——延迟优化通常需要"冗余资源"（隔离的核、多余的 CPU limit），这增加了硬件成本。一个 P99 < 1ms 的服务可能需要 8 核中的 4 核隔离，CPU 利用率上限只有 50%——这意味着同样的吞吐需要 2 倍的硬件。而 P99 < 100ms 的服务可以用满所有核，硬件成本减半。**延迟要求越严，硬件成本越高**——这是延迟优化的经济账，业务方要在"延迟指标"和"硬件成本"之间权衡。

延迟与成本的关系还有一个与"长尾"相关的非线性特征——从 P50 100ms 优化到 P50 50ms 可能只需要"加 20% CPU"，但从 P99 100ms 优化到 P99 50ms 可能需要"加 100% CPU"。原因是 P99 是长尾，长尾由"极端竞争"或"极端事件"导致，消除长尾要"冗余资源"应对极端情况——大部分时间冗余资源闲置，但极端时刻能顶住。**P99 优化的成本比 P50 优化高一个数量级**——这是为什么很多服务只优化到 P99 < 100ms 而非 P99 < 1ms，后者成本太高。业务方要明确"延迟指标的目标分位"——P50、P95、P99、P99.9 的成本差异巨大，选错分位会浪费资源。

---

## 第 7 章 调度延迟的边界与盲区

### 7.1 调度优化无法解决应用层延迟

调度延迟优化能减少"进程等 CPU"的时间，但不能减少"进程在 CPU 上做事"的时间。如果服务的 P99 延迟高是因为某个请求处理逻辑慢（譬如复杂的数据库查询、大 JSON 解析），调度优化无效——进程已经拿到 CPU 了，是它自己做得慢。**调度优化只解决"等 CPU"，不解决"用 CPU"**——后者要靠 perf 火焰图（第 01 篇）和微架构优化（第 02 篇）。一个常见的误区是"延迟高就调调度参数"——如果瓶颈在应用层，调 `isolcpus`、`SCHED_FIFO` 都没用，要先 profile 确认瓶颈在哪一层。

判断"瓶颈在哪一层"的方法是看"等待时间"和"运行时间"的比例。`/proc/<pid>/schedstat` 给出三个数——运行时间、等待时间、上下文切换次数。如果等待时间占比高（> 50%），瓶颈在 off-CPU（调度、锁、IO）；如果运行时间占比高但延迟仍高，瓶颈在 on-CPU（代码慢）。等待时间高时，再细分——用 bpftrace 看调度延迟（等 CPU 的时间），用 off-CPU profiling 看锁/IO 等待时间。**"运行 vs 等待"的比例是分层诊断的第一步**——它决定了后续用 on-CPU 工具还是 off-CPU 工具。

### 7.2 实时调度的"确定性"是相对的

SCHED_FIFO 和 `isolcpus` 能大幅降低调度延迟，但不能做到"零延迟"——硬件中断、缓存 miss、TLB miss 仍然会引入微秒级的抖动。对大多数延迟敏感服务（P99 < 1ms），微秒级抖动可接受；对极端硬实时（譬如要求 < 10µs 的确定性），Linux 本身可能不够——需要专门的实时操作系统（RTOS）如 VxWorks、QNX，或 Linux 的 PREEMPT_RT 补丁（把内核变成完全可抢占）。**PREEMPT_RT 是 Linux 实时化的终极方案**——它把内核的临界区、中断处理都变成可抢占，让 Linux 达到接近 RTOS 的实时性，但代价是吞吐下降（抢占开销增加）。PREEMPT_RT 在 2024 年合入主线内核（Linux 6.12），从此 Linux 不需要打补丁就能做硬实时——但默认不开启，需要内核配置 `CONFIG_PREEMPT_RT`。

PREEMPT_RT 的合入主线是 Linux 实时化的里程碑——在此之前，要做硬实时 Linux 需要打 PREEMPT_RT 补丁，维护成本高（每次内核升级要重新打补丁），且补丁滞后主线几个版本。合入主线后，任何 Linux 发行版都能启用 PREEMPT_RT（只要内核配置开启），实时 Linux 的门槛大幅降低。但 PREEMPT_RT 的"实时"是有代价的——内核可抢占性增加意味着更多的抢占点、更多的上下文切换，吞吐通常下降 5-15%。所以 PREEMPT_RT 适合"延迟优先"的场景（工业控制、机器人、音频），不适合"吞吐优先"的场景（数据库、大数据）。**PREEMPT_RT 是"用吞吐换确定性"的内核级权衡**——和 `isolcpus`、`SCHED_FIFO` 是同一思路的不同层次实现。

### 7.3 容器环境的调度限制

容器环境（Kubernetes/Docker）中，调度优化手段受限——容器内通常没有 root 权限，无法 `chrt` 设置实时调度，无法 `taskset` 绑定 CPU（需要 `CAP_SYS_NICE` 和 `CAP_SYS_ADMIN`）。Kubernetes 提供了一些替代方案——`cpuManager: static` 能把 CPU 核独占分配给容器（类似 cpuset），`runtimeClass: nvidia.com/rt` 能启用 SCHED_FIFO。但这些都需要集群管理员配置，普通业务方无法自行启用。**容器中的调度优化是"平台能力"而非"应用能力"**——业务方要调调度参数，需要平台方支持。

容器环境的调度限制还有一个与"多租户"相关的矛盾——多租户集群要求"公平共享"（每个租户的 Pod 平等竞争 CPU），但延迟敏感服务要求"优先调度"（自己的 Pod 优先获得 CPU）。这两个目标冲突——公平意味着不优先，优先意味着不公平。Kubernetes 的解法是"优先级类"（PriorityClass）+ "服务质量"（QoS）——高优先级 Pod 在调度和抢占时优先，Guaranteed QoS 的 Pod 有稳定的资源保证。但这仍是"相对优先"，不是"绝对独占"——要绝对独占，需要 cpuManager 的 static 策略（独占 CPU 核）或 device plugin（专用硬件）。**多租户环境下的延迟优化是"在公平框架内争取优先"**——不能破坏公平性，但能用优先级和 QoS 获得相对优势。

容器环境的调度优化还有一个与"节点超卖"相关的实践——Kubernetes 集群通常允许"超卖"（sum of requests < node capacity），以提高资源利用率。但超卖意味着 CPU 竞争更激烈——多个 Pod 的 request 之和超过节点 CPU，紧张时有人要等。延迟敏感服务在超卖节点上表现差——即使设了高 shares，竞争者太多时仍要排队。解法是"节点独占"——用 nodeSelector 或 taint 把延迟敏感服务调度到不超卖的专用节点，或用 Guaranteed QoS（request = limit）确保资源独占。**延迟敏感服务要避开超卖节点**——超卖是"吞吐优先"的策略，与"延迟优先"矛盾。

---

## 第 8 章 小结

CPU 调度延迟是低延迟服务 P99 毛刺最常见的隐藏原因之一，因为它不会出现在 on-CPU 火焰图中（进程处于等待状态，没有消耗 CPU）：

**诊断工具优先级**：
1. `bpftrace` 实时唤醒延迟追踪（最直接，超过 1ms 的调度延迟立即可见）
2. `perf sched latency`（事后分析，给出每个进程的平均/最大调度延迟统计）
3. cgroup `cpu.stat` 的 `nr_throttled` 计数（快速判断是否有 CPU throttling）

**三类根因对应的解决方案**：
- **多进程 CPU 竞争** → CPU 亲和性绑定（`taskset`）+ `isolcpus` 核心隔离
- **实时性需求** → `SCHED_FIFO`/`SCHED_RR` 实时调度 + `chrt` 设置优先级
- **cgroup CPU throttling** → 提高 CPU limit / 移除 limit / 使用 cgroup v2 burst

调度延迟优化的本质是"让进程从就绪到执行的等待时间最小化"——要么减少竞争者（CPU 隔离），要么提高优先级（实时调度），要么消除限制（移除 cgroup limit）。三种手段对应三类根因，诊断清楚根因才能选对手段。**调度延迟优化是"用资源或权限换确定性"的权衡**——隔离的核不能跑别的任务，实时调度需要权限且可能饿死其他进程，移除 limit 失去资源隔离——每种优化都有代价，没有免费午餐。

调度延迟优化的认知框架可以总结为一个核心命题——**"CPU 利用率高"不等于"CPU 资源充足"**。一个进程可能 CPU 利用率只有 30%，但 P99 延迟高——因为它在等 CPU 调度（off-CPU 时间长），而非在 CPU 上跑得慢。传统的"看 CPU 利用率判断瓶颈"的方法对延迟问题失效——CPU 利用率是"在 CPU 上的时间比例"，不反映"等 CPU 的时间长短"。**延迟问题要看"等待时间"，而非"利用率"**——这是调度延迟诊断的认知转变，也是为什么 `perf sched` 和 bpftrace（追踪等待时间）比 `top`（看利用率）更适合延迟诊断。

这个认知转变还有一个推论——"加 CPU 核"不一定能降延迟。如果延迟高是因为调度竞争（进程多核少），加核能缓解；但如果延迟高是因为锁竞争（所有线程在等同一把锁），加核无效——锁等待时间不随核数减少。甚至可能反向——核多了线程也多了，锁竞争更激烈，延迟反而升高。**"加核降延迟"要分清瓶颈类型**——CPU 竞争型加核有效，锁竞争型加核可能反向，IO 等待型加核无效（瓶颈在 IO 不在 CPU）。这也是为什么延迟优化要先诊断根因，而非盲目加资源。

这个"先诊断后加资源"的原则是性能工程的黄金法则——任何资源添加（CPU、内存、IO）都要建立在"确认瓶颈在该资源"的基础上。盲目加资源不仅浪费钱，可能还让问题更复杂（譬如加核后线程数翻倍，锁竞争加剧，调试更难）。**"诊断先行，资源后加"是性能优化的方法论**——这也是本专栏从诊断工具（perf、bpftrace）开始讲，而非从"加资源"开始讲的原因。调度延迟的诊断工具和优化手段已经讲透，下一篇进入内存性能的硬件维度——NUMA、大页、内存带宽，这些硬件层面的内存性能问题与调度延迟一样隐蔽，但影响同样深远，且更难排查，因为它们涉及 CPU 与内存之间的物理拓扑，需要理解硬件才能诊断，行文至此，调度延迟的原理、工具、手段、边界已讲透。

下一篇 [[04 内存性能调优——NUMA 拓扑、大页与内存带宽]] 将深入内存性能的硬件维度：NUMA 不均衡（跨节点内存访问慢 2 倍）、HugePage 减少 TLB Miss（工作集大的数据库/缓存服务的必选项）、以及内存带宽饱和（当内存总线成为瓶颈时，加更多 CPU 核也无法提升性能）的诊断与优化。

---

## 参考资料

1. Linux kernel documentation, "CFS Scheduler". https://www.kernel.org/doc/html/latest/scheduler/sched-CFS.html
2. Ingo Molnar, "CFS: Completely Fair Scheduler", Linux kernel mailing list, 2007.
3. Daniel Bristot de Oliveira, "Deconstructing the Linux (EEVDF) Scheduler", LWN.net, 2023.
4. Brendan Gregg, "Linux Load Averages: Solving the Mystery". https://www.brendangregg.com/blog/2017-08-08/linux-load-averages.html
5. Linux kernel documentation, "SCHED_DEADLINE". https://www.kernel.org/doc/html/latest/scheduler/sched-deadline.html
6. Kubernetes CPU Manager documentation. https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/
7. cgroup v2 CPU controller documentation. https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#cpu
8. Brendan Gregg, "bpftrace Examples: Scheduling". https://www.brendangregg.com/ebpf.html

---

> [!note] 思考题
> 1. CFS 的调度延迟取决于可运行进程数。Kubernetes 节点上 50+ Pod 竞争 CPU 时，CFS 的调度延迟如何影响延迟敏感应用？`sched_min_granularity_ns`（最小时间片）设置过小会增加上下文切换开销，过大会增加调度延迟——如何找到平衡？
> 2. 在 NUMA 架构中，CPU 亲和性（`taskset`）可以避免跨节点内存访问（~70ns vs ~120ns）。但绑定可能导致负载不均。在一个 2-Socket 64 核的 NUMA 机器上运行数据库，你会选择将数据库绑定到一个 Socket 还是让 CFS 自由调度？`numactl --interleave=all` 在这里有什么作用？
> 3. CGroups v2 的 `cpu.max` 限制 CPU 带宽。被限流时 `cpu.stat` 的 `nr_throttled` 持续增加。如果一个容器的 CPU limit 设为 2 核，但它的代码在 GC 时需要 4 核并发——GC 会被限流导致停顿时间翻倍。你如何判断 CPU 限流是否影响了 GC 性能？是调大 limit 还是优化 GC？
