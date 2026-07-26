---
title: "全栈性能诊断——BPF 工具链与 OFF-CPU 分析"
date: 2026-03-02
tags: [BCC, BPF, bpftrace, eBPF, Linux, OFF-CPU分析, offcputime, wakeuptime, 性能优化, 性能诊断, 锁竞争]
aliases: ["BPF性能诊断", "OFF-CPU分析", "eBPF工具链", "bpftrace性能排查", "锁竞争分析"]
---

**摘要：**

前几篇文章覆盖的性能工具（perf、火焰图、blktrace、iostat、ss）都有一个共同局限：它们主要告诉你进程**在 CPU 上做了什么**（on-CPU 时间）。但现实中，最难排查的 P99 延迟问题往往来自进程**不在 CPU 上的时间**（off-CPU 时间）——进程在等待什么？等锁？等 IO？等调度？等网络？在 on-CPU 火焰图上，这些等待时间是隐形的，火焰图显示进程很"健康"（没有明显热点），但 P99 延迟却居高不下。**OFF-CPU 分析**是 Brendan Gregg 提出的分析方法，通过追踪进程从"运行态"切换到"睡眠态"的时刻（`sched_switch` 事件），记录睡眠的持续时间和触发睡眠的调用栈，生成 **OFF-CPU 火焰图**——让隐藏的等待时间可见化。本文以 BPF/bpftrace 为核心工具，系统介绍 OFF-CPU 分析的原理与实践，并扩展到锁竞争分析（`mutexlock`/`rwlock` 等待时间）、IO 等待分析（`bio_latency`）、以及如何构建完整的"ON-CPU + OFF-CPU"全貌时间分析。

---

## 第 1 章 ON-CPU vs OFF-CPU：时间到哪里去了

### 1.1 进程的时间构成

一个进程从收到请求到返回响应，其时间由两部分构成：

```
总响应时间 = ON-CPU 时间 + OFF-CPU 时间

ON-CPU 时间（进程在 CPU 上执行）：
  - CPU 密集型计算
  - 系统调用处理（在内核态执行，但仍算 CPU 时间）
  - 内存访问（Cache Miss 等待，虽然慢，但 CPU 仍在跑）

OFF-CPU 时间（进程被调度出 CPU，处于睡眠/等待态）：
  - 等待互斥锁（mutex lock，锁被其他线程持有）
  - 等待磁盘 IO（发起 read/write 后等待完成）
  - 等待网络 IO（socket recv，等待数据到达）
  - 等待调度（CPU 资源被其他进程占用）
  - 等待条件变量 / 信号量
  - sleep() / nanosleep()
  - 等待 epoll_wait 超时
```

**为什么 ON-CPU 火焰图无法发现 OFF-CPU 问题**：

`perf record` 的采样机制基于**定时中断**（或性能计数器溢出）——每隔固定时间（如 1ms）采样一次当前正在运行的进程的调用栈。当进程在 `pthread_mutex_lock()` 中等待时，它已经主动调用 `futex()` 系统调用让出 CPU，**不在任何 CPU 上运行**，定时采样完全采不到它——进程"消失"了。

```
时间轴：
线程 A：[======运行======][等锁 20ms][===运行===][等IO 50ms][====运行====]
                          ↑ perf 看不到这段   ↑ 也看不到

perf 火焰图的视角：
线程 A：[======运行======]              [===运行===]            [====运行====]
# 火焰图看起来进程运行正常，没有明显热点
# 但实际上 70ms 的时间是空白的（等待）！
```

### 1.2 OFF-CPU 分析的核心思路

**OFF-CPU 分析**通过在 `sched_switch`（进程切换）tracepoint 上挂载 BPF 程序，记录每次进程被切换出去的时刻和原因，等到进程重新被调度回来时，计算这段时间间隔，并记录当时的调用栈：

```
OFF-CPU 时间追踪（bpftrace 伪代码）：

tracepoint:sched:sched_switch {
    /* 进程被切换出去 */
    if (被切换走的进程是我们关注的) {
        @sleep_start[pid] = 当前时间戳;
        @sleep_stack[pid] = 当前调用栈;  /* 记录"是谁让我睡觉的" */
    }
}

tracepoint:sched:sched_switch {
    /* 进程被切换回来 */
    if (被切换进来的进程是我们关注的) {
        off_cpu_ns = 当前时间戳 - @sleep_start[pid];
        输出(@sleep_stack[pid], off_cpu_ns);
    }
}
```

将所有 `(调用栈, off_cpu_时间)` 对汇聚，用 FlameGraph 工具生成 **OFF-CPU 火焰图**——宽度代表睡眠时间长度，而不是 CPU 时间，让隐藏的等待变为可视化。

---

## 第 2 章 BPF 工具链全景

### 2.1 BCC vs bpftrace：工具选择

| 工具 | 定位 | 优势 | 适用场景 |
|-----|-----|-----|---------|
| **BCC** | Python/C 库，预编译 BPF 工具集 | 功能强大，有丰富的现成工具（`offcputime`、`biolatency`、`tcptop` 等）| 日常诊断，直接运行现成工具 |
| **bpftrace** | 高级脚本语言，类 awk 语法 | 语法简洁，适合临时探索和自定义追踪 | 自定义追踪、一次性分析 |
| **perf BPF** | perf 子命令 | 与 perf 工作流集成 | 已熟悉 perf 的用户 |

**BCC 核心工具速览**：

```bash
# 安装 BCC
apt-get install bpfcc-tools python3-bpfcc  # Ubuntu
# 工具在 /usr/share/bcc/tools/ 下

# 常用工具列表
execsnoop        # 追踪新进程启动（发现短命进程导致的 CPU 异常）
opensnoop        # 追踪文件打开操作
filetop          # 文件 IO top（哪个进程读写了哪些文件）
biolatency       # 块设备 IO 延迟直方图
biosnoop         # 逐个追踪块设备 IO（含延迟）
tcptop           # TCP 吞吐量 top（哪个连接流量最大）
tcpretrans       # TCP 重传追踪（发现丢包）
tcpconnect       # 新 TCP 连接追踪
sockstat         # Socket 统计
offcputime       # OFF-CPU 时间分析（核心工具！）
wakeuptime       # 进程唤醒路径分析（谁唤醒了你）
profile          # on-CPU 性能分析（火焰图原料）
funclatency      # 函数调用延迟直方图
funccount        # 函数调用次数统计
stackcount       # 特定事件的调用栈统计
```

### 2.2 bpftrace 语法速查

```bash
# bpftrace 的基本结构：
# probe { action }
#
# probe 类型：
#   kprobe:函数名          内核函数入口
#   kretprobe:函数名       内核函数返回
#   uprobe:路径:函数名     用户态函数入口
#   tracepoint:类:事件     内核 tracepoint（稳定接口，推荐）
#   usdt:路径:探针名       用户态静态探针
#   profile:频率           定时采样
#   interval:间隔          定期触发
#   BEGIN / END            程序启动/结束

# 内置变量：
# pid     进程 ID
# tid     线程 ID
# comm    进程名
# nsecs   当前时间（纳秒）
# cpu     当前 CPU 编号
# ustack  用户态调用栈
# kstack  内核态调用栈
# args    tracepoint 的参数（通过 args->字段名 访问）

# 内置函数：
# printf(fmt, ...)    打印
# hist(val)           幂次直方图
# lhist(val, min, max, step)  线性直方图
# count()             计数
# sum(val)            求和
# min(val) / max(val)
# delete(@map[key])   删除 map 条目
# clear(@map)         清空 map

# 示例：追踪某进程的所有系统调用及其延迟
bpftrace -e '
tracepoint:raw_syscalls:sys_enter /pid == 1234/ {
    @start[tid] = nsecs;
    @name[tid] = args->id;
}
tracepoint:raw_syscalls:sys_exit /pid == 1234 && @start[tid]/ {
    $lat = nsecs - @start[tid];
    @syscall_lat[ksym(@name[tid])] = hist($lat);
    delete(@start[tid]);
    delete(@name[tid]);
}'
```

---

## 第 3 章 OFF-CPU 分析实战

### 3.1 offcputime：BCC 的核心工具

```bash
# offcputime：追踪所有进程的 off-CPU 时间（5 秒）
/usr/share/bcc/tools/offcputime -df 5 > offcpu.txt

# 参数说明：
# -d：同时采集用户态和内核态调用栈（most useful）
# -f：输出 folded 格式（FlameGraph 的输入格式）
# 5：采集持续时间（秒）

# 只追踪特定进程
/usr/share/bcc/tools/offcputime -p 1234 -df 5 > offcpu.txt

# 只追踪特定进程名
/usr/share/bcc/tools/offcputime -c java -df 5 > offcpu.txt

# 生成 OFF-CPU 火焰图
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph
./flamegraph.pl --color=io --title="Off-CPU Time" --countname=us < /tmp/offcpu.txt > offcpu.svg
# 用浏览器打开 offcpu.svg
```

**解读 OFF-CPU 火焰图**：

```
OFF-CPU 火焰图 vs ON-CPU 火焰图的关键区别：

ON-CPU 火焰图：
  - 宽度 = CPU 时间
  - 热点 = 宽的函数框（CPU 密集型）
  - "好"的进程在火焰图上占比小

OFF-CPU 火焰图：
  - 宽度 = 睡眠时间（等待的总时间）
  - 热点 = 宽的函数框（在这里等待最久）
  - 调用栈 = 导致进程进入睡眠的代码路径

典型 OFF-CPU 火焰图的热点模式：

[宽框] futex_wait → __pthread_mutex_lock → 业务代码A
  ↑ 含义：业务代码A 调用了 mutex_lock，等锁等了很长时间
  ↑ 诊断：锁竞争问题，多个线程争同一把锁

[宽框] schedule → io_schedule → submit_bio → ext4_writepages → 业务代码B
  ↑ 含义：业务代码B 触发了磁盘写，等待完成
  ↑ 诊断：同步写 IO，如果宽度很大说明磁盘是瓶颈

[宽框] schedule → do_wait → sys_waitpid → 业务代码C
  ↑ 含义：等待子进程结束
  ↑ 诊断：子进程处理慢
```

### 3.2 bpftrace 自定义 OFF-CPU 追踪

BCC 的 `offcputime` 是针对所有进程的通用工具，`bpftrace` 允许更有针对性的追踪：

```bash
# 只追踪特定进程名（java），输出超过 1ms 的 off-CPU 事件及调用栈
bpftrace -e '
tracepoint:sched:sched_switch
/args->prev_comm == "java"/ {
    @ts[args->prev_pid] = nsecs;
    @stack[args->prev_pid] = ustack();
}

tracepoint:sched:sched_switch
/args->next_comm == "java" && @ts[args->next_pid]/ {
    $dur_us = (nsecs - @ts[args->next_pid]) / 1000;
    if ($dur_us > 1000) {  /* 只打印超过 1ms 的等待 */
        printf("pid=%d dur=%dµs\n", args->next_pid, $dur_us);
        print(@stack[args->next_pid]);
        printf("\n");
    }
    delete(@ts[args->next_pid]);
    delete(@stack[args->next_pid]);
}'

# 输出示例：
# pid=5678 dur=15234µs
# java_pid5678
#     java.lang.Object.wait(Object.java)
#     java.util.concurrent.locks.LockSupport.park(LockSupport.java:175)
#     org.apache.kafka.clients.consumer.internals.ConsumerCoordinator.poll
#     ...
# 含义：Kafka Consumer 在 poll() 中等了 15ms，是在等待 Coordinator 响应
```

### 3.3 wakeuptime：谁唤醒了你

`offcputime` 告诉你"进程在哪里睡"，`wakeuptime` 告诉你"谁把进程唤醒"——有时候知道唤醒路径比睡眠路径更有用（比如诊断为什么某个请求在等待另一个服务的回调）：

```bash
# wakeuptime：显示唤醒进程的调用栈（谁 wake_up 了目标进程）
/usr/share/bcc/tools/wakeuptime -p 1234 5 | head -50

# 输出示例：
# ffffffffc0a12345 try_to_wake_up
# ffffffffc0a23456 wake_up_process
# ffffffffc0b34567 tcp_data_ready
# ffffffffc0c45678 tcp_rcv_established
# ffffffffc0d56789 tcp_v4_do_rcv
# ...（内核网络栈路径）
# -                java（PID 1234）
# 5,234,567 µs     ← 这条唤醒路径总共花了 5.2 秒
#
# 含义：java 进程的大量 off-CPU 时间是由 TCP 数据到达唤醒的（等待网络响应）
# 这意味着瓶颈在网络侧（下游服务慢），而不是本进程的逻辑问题
```

---

## 第 4 章 锁竞争分析

### 4.1 锁竞争是 OFF-CPU 的主要来源之一

互斥锁竞争是多线程服务中最常见的 OFF-CPU 原因。当线程 A 持有锁时，线程 B 尝试加锁会进入 `futex_wait`（内核等待），被调度出 CPU，直到线程 A 释放锁并唤醒线程 B。

**锁竞争的症状**：
- CPU 使用率不高，但吞吐量达不到预期
- 增加线程数，性能不再提升（甚至下降）
- `perf stat` 显示大量 `context-switches`（上下文切换）
- `/proc/<pid>/sched` 中 `nr_involuntary_switches` 增长

### 4.2 bpftrace 追踪 pthread mutex 等待时间

```bash
# 追踪 libpthread 中 mutex lock 的等待时间（用户态 POSIX 互斥锁）
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock {
    @lock_start[tid] = nsecs;
    @lock_addr[tid] = arg0;  /* 锁的地址 */
}

uretprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock {
    if (@lock_start[tid]) {
        $wait_us = (nsecs - @lock_start[tid]) / 1000;
        if ($wait_us > 100) {  /* 等锁超过 100µs 才记录 */
            @lock_wait_us[@lock_addr[tid]] = hist($wait_us);
        }
        delete(@lock_start[tid]);
        delete(@lock_addr[tid]);
    }
}

interval:s:10 {
    print("=== Mutex Lock Wait Time Distribution ===");
    print(@lock_wait_us);
    clear(@lock_wait_us);
}'

# 输出示例：
# === Mutex Lock Wait Time Distribution ===
# @lock_wait_us[0x7f1234567890]:  ← 锁地址 0x7f1234567890
# [64, 128)          3 |@                                      |
# [128, 256)        12 |@@@@                                   |
# [256, 512)        45 |@@@@@@@@@@@@@@@                        |
# [512, 1K)        123 |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|  ← 热点！
# [1K, 2K)          67 |@@@@@@@@@@@@@@@@@@@@@@@                |
# [2K, 4K)          12 |@@@@                                   |
# [4K, 8K)           3 |@                                      |
#
# 含义：这个地址的锁有大量 500µs-2ms 的等待，说明持有锁的时间太长或并发度太高
```

### 4.3 定位持有锁的线程（谁持有时间最长）

```bash
# 追踪从加锁到解锁的持有时间（找到哪个线程持有锁时间最长）
bpftrace -e '
uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_lock {
    @hold_start[arg0] = nsecs;  /* 以锁地址为 key，记录加锁时间 */
    @hold_tid[arg0] = tid;
}

uprobe:/lib/x86_64-linux-gnu/libpthread.so.0:pthread_mutex_unlock {
    if (@hold_start[arg0]) {
        $hold_us = (nsecs - @hold_start[arg0]) / 1000;
        if ($hold_us > 500) {  /* 持锁超过 500µs */
            printf("LONG LOCK HOLD: lock=0x%lx tid=%d hold=%dµs\n",
                   arg0, @hold_tid[arg0], $hold_us);
            /* 打印当前线程的调用栈（持锁时在做什么）*/
            print(ustack());
        }
        delete(@hold_start[arg0]);
        delete(@hold_tid[arg0]);
    }
}'

# 输出示例：
# LONG LOCK HOLD: lock=0x7f1234567890 tid=5679 hold=2345µs
#     acquire_lock+0x15
#     process_request+0x234      ← process_request 持有锁 2ms！
#     handle_connection+0x89
#     ...
# 含义：tid=5679 在 process_request 中持有锁 2ms，这期间其他线程都在等
# 优化方向：缩小临界区（只在必要时持锁），或使用读写锁（允许并发读）
```

### 4.4 Java 应用的锁竞争分析

Java 的 `synchronized` 和 `java.util.concurrent.locks.Lock` 最终都通过 JVM 的 monitorenter/monitorexit 指令实现，可以通过 JVM 的内置工具和 AsyncProfiler 分析：

```bash
# 方法 1：AsyncProfiler（支持 Java 的 OFF-CPU 分析）
java -agentpath:/path/to/async-profiler/libasyncProfiler.so=start,\
event=wall,interval=1ms,file=/tmp/wall.html \
     -jar myapp.jar
# event=wall：挂钟时间（= ON-CPU + OFF-CPU），而不是 CPU 时间
# 这样等待的时间也能被采样到

# 方法 2：jstack 周期性采样（简单但粗糙）
for i in $(seq 1 10); do
    jstack <pid> >> /tmp/thread_dump.txt
    sleep 1
done
# 分析 thread_dump.txt 中频繁出现 "waiting to lock" 的栈

# 方法 3：JFR（Java Flight Recorder）
# 开启 JFR 记录锁竞争
java -XX:+FlightRecorder \
     -XX:StartFlightRecording=duration=60s,filename=/tmp/record.jfr,\
settings=profile \
     -jar myapp.jar

# 用 JMC（Java Mission Control）分析 record.jfr
# Lock Instances 标签页显示每个锁的竞争统计
```

---

## 第 5 章 IO 等待分析

### 5.1 biolatency：块设备 IO 延迟分布

当 OFF-CPU 分析发现大量时间花在 IO 等待上时，`biolatency` 给出 IO 延迟的统计分布：

```bash
# 追踪所有块设备 IO 的延迟分布（10 秒）
/usr/share/bcc/tools/biolatency 10 1
# Tracing block device I/O... Hit Ctrl-C to end.
#
# usecs               : count     distribution
# 0 -> 1             : 0        |                                       |
# 2 -> 3             : 0        |                                       |
# 4 -> 7             : 234      |@@@@@@@@                               |
# 8 -> 15            : 1567     |@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@|
# 16 -> 31           : 890      |@@@@@@@@@@@@@@@@@@@@@@@@@              |
# 32 -> 63           : 234      |@@@@@@@                                |
# 64 -> 127          : 89       |@@                                     |
# 128 -> 255         : 23       |                                       |
# 256 -> 511         : 12       |                                       |
# 512 -> 1023        : 5        |                                       |
# 1024 -> 2047       : 45       |@                                      | ← P99 尾部！
# 2048 -> 4095       : 12       |                                       |
#
# 含义：大部分 IO 集中在 8-63µs（NVMe 正常），但有少量 1-4ms 的长尾
# 长尾的 IO 可能是由于 IO 调度器重排序、磁盘内部 GC 等原因

# 按设备分别统计
/usr/share/bcc/tools/biolatency -D 10 1  # -D：按设备分类

# 按进程分别统计
/usr/share/bcc/tools/biolatency -P 10 1  # -P：按进程分类
```

### 5.2 biosnoop：逐个 IO 事件追踪

```bash
# 实时打印每个块设备 IO 事件（含延迟和进程信息）
/usr/share/bcc/tools/biosnoop | head -30
# TIME(s)     COMM         PID    DISK    T SECTOR     BYTES  LAT(ms)
# 0.000001    mysqld       1234   nvme0n1 R 12345678   16384   0.12
# 0.000234    mysqld       1234   nvme0n1 W 23456789    4096   0.09
# 0.001234    java         5678   nvme0n1 R 34567890   65536   1.23  ← 1ms 延迟！
# 0.002345    mysqld       1234   nvme0n1 R 45678901    4096   0.11
#
# T 列：R=读，W=写，D=丢弃
# 可以发现：java 进程的某次 64KB 读取花了 1.23ms（其他 IO 都 < 0.2ms），是异常的

# 过滤只看高延迟 IO（> 1ms）
/usr/share/bcc/tools/biosnoop | awk '$NF > 1.0'
```

---

## 第 6 章 全栈时间分析：把 ON-CPU 和 OFF-CPU 拼在一起

### 6.1 完整的请求时间分解

真正全面的性能诊断需要将一个请求的**完整时间**（从到达到返回）分解为各个组成部分：

```bash
# 使用 bpftrace 追踪完整的 HTTP 请求时间（以 Nginx 为例）
bpftrace -e '
/* 请求开始：accept 或 epoll_wait 返回 */
tracepoint:syscalls:sys_exit_accept4 /pid == target_pid && args->ret >= 0/ {
    @req_start[args->ret] = nsecs;  /* fd 为 key */
}

/* 请求结束：write 或 sendto 发送响应 */
tracepoint:syscalls:sys_enter_write /pid == target_pid && @req_start[args->fd]/ {
    $total_us = (nsecs - @req_start[args->fd]) / 1000;
    @latency_us = hist($total_us);
    delete(@req_start[args->fd]);
}

interval:s:10 {
    print(@latency_us);
    clear(@latency_us);
}'
```

### 6.2 综合诊断工作流

```
全栈性能诊断的决策树：

步骤 1：量化问题
  → iperf3/netperf 确认网络是否正常
  → iostat 确认磁盘是否饱和
  → top/vmstat 看 CPU 使用率和等待时间

步骤 2：分类问题
  → CPU 使用率 > 80%？
    是 → ON-CPU 分析（perf + 火焰图）找热点函数
    否 → OFF-CPU 分析

步骤 3（OFF-CPU 分析）：
  → offcputime -p <pid> -df 5 → 生成 OFF-CPU 火焰图
  → 找到最宽的睡眠热点：

  热点在 futex_wait / pthread_mutex_lock？
    → 锁竞争：bpftrace mutex 持有时间分析
    → 优化：减小临界区 / 使用读写锁 / 无锁数据结构

  热点在 io_schedule / submit_bio？
    → IO 等待：biolatency 分析 IO 延迟分布
    → 优化：异步 IO / io_uring / 调整 IO 调度器

  热点在 schedule / do_nanosleep / epoll_wait？
    → 调度等待 / 网络等待：perf sched latency / tcptop
    → 优化：CPU 亲和性 / BBR 拥塞控制

  热点在 try_to_wake_up（wakeuptime）？
    → 被动等待下游响应：追踪下游服务延迟
    → 优化：下游服务调优 / 连接池 / 请求批量合并

步骤 4：量化优化效果
  → 对比调优前后的 offcputime 输出
  → P99/P999 延迟变化
```

---

## 第 7 章 BPF 工具的生产使用注意事项

### 7.1 运行时安全性

```bash
# BPF 程序的安全保障（为什么 BPF 可以在生产环境使用）：
# 1. BPF 验证器（Verifier）：每个 BPF 程序在加载时经过内核严格验证
#    - 不允许无限循环
#    - 不允许越界内存访问
#    - 不允许未初始化的变量读取
# 2. BPF 程序只读（对于追踪类型），不能修改内核数据结构
# 3. BPF 程序有执行时间限制（防止长时间占用 CPU）

# 性能开销评估：
# kprobe/tracepoint：每次触发约 50-200ns 额外开销
# 在 100 万次/秒的系统调用场景下：
#   50ns × 100万 = 50ms/s CPU 时间 ← 约 5% 额外开销
# 高频事件（如 sched_switch，每秒可能几十万次）要谨慎

# 生产使用原则：
# 1. 优先使用 tracepoint（稳定接口）而非 kprobe（内核版本可能变化）
# 2. 在 BPF 程序中加过滤条件（pid、comm 过滤），减少不必要的处理
# 3. 短时间采集（10-60 秒），不要长期运行高频 BPF 程序
# 4. 对于高频事件（sched_switch），使用 percpu map 减少 map 竞争
```

### 7.2 内核版本要求

```bash
# 检查内核 BPF 支持
uname -r
# 5.15.0-91-generic  ← 推荐 5.x，BPF 功能最完整

# 检查 BPF 类型格式（BTF）是否开启（bpftrace 推荐需要）
ls /sys/kernel/btf/vmlinux
# /sys/kernel/btf/vmlinux  ← 存在即表示 BTF 支持开启

# 检查是否有足够权限（通常需要 root 或 CAP_BPF）
id
# uid=0(root)  ← root 用户

# 非 root 用户的 BPF 权限（Linux 5.8+）
# 需要 CAP_BPF + CAP_PERFMON（对于追踪类型 BPF）
# 可以通过 Kubernetes securityContext 配置
```

---

## 小结

OFF-CPU 分析是性能诊断工具箱中最强大但最鲜被使用的工具——它填补了 on-CPU 火焰图的盲区，让等待时间可见化：

**核心工具三件套**：
- `offcputime -p <pid> -df 5`：生成 OFF-CPU 火焰图原料，找到最大的睡眠热点
- `wakeuptime -p <pid> 5`：找到谁在唤醒目标进程（反向追踪等待来源）
- `bpftrace` 自定义脚本：针对具体问题（mutex 持有时间、特定函数延迟）精确追踪

**诊断决策原则**：
- ON-CPU 火焰图宽 → 代码热点，优化算法和数据结构
- OFF-CPU 火焰图宽（futex）→ 锁竞争，减小临界区
- OFF-CPU 火焰图宽（io_schedule）→ IO 等待，异步化或优化存储
- ON-CPU + OFF-CPU 都不大，但延迟高 → 调度等待，CPU 亲和性或 cgroup 调优

下一篇 [[10 性能调优实战案例——从症状到根因的完整诊断链路]] 是本专栏的收官篇，将三个真实的生产案例（Java 服务 P99 毛刺、数据库慢查询、高并发 API 网关吞吐量低）走完从"收到告警"到"找到根因并修复"的完整诊断链路，综合运用本专栏所有工具，展示真实场景中的多工具协作方式。

---

> [!note] 思考题
> 1. 在'偶发 IO 延迟毛刺'场景中，如何用 bpftrace 定位毛刺发生时内核在做什么？`biolatency`（块设备层延迟分布）和 `ext4slower`（文件系统层慢操作）分别适用于什么层级？如果 `biolatency` 显示正常但 `ext4slower` 显示慢操作，说明瓶颈在哪一层？
> 2. OFF-CPU 火焰图中 `futex_wait` 占大比例意味着线程在等待锁。如何进一步定位是哪个用户态锁——可以用 `bpftrace` 追踪 `pthread_mutex_lock` 的调用栈吗？在 Java 应用中，`futex_wait` 对应的可能是 `synchronized` 还是 `ReentrantLock`？
> 3. eBPF 验证器限制了循环和指针访问。BPF CO-RE（Compile Once, Run Everywhere）通过 BTF（BPF Type Format）实现跨内核版本兼容。在什么场景下没有 CO-RE 会导致 eBPF 程序无法运行（如内核升级后结构体字段偏移变化）？libbpf 和 BCC 在 CO-RE 支持方面有什么差异？
