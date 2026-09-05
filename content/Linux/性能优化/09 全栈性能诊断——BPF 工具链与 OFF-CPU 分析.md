---
title: "全栈性能诊断——BPF 工具链与 OFF-CPU 分析"
date: 2026-03-02
tags: [BCC, BPF, bpftrace, eBPF, Linux, OFF-CPU分析, offcputime, wakeuptime, 性能优化, 性能诊断, 性能调优, 锁竞争, biolatency, biosnoop, CO-RE, BTF]
aliases: ["BPF性能诊断", "OFF-CPU分析", "eBPF工具链", "bpftrace性能排查", "锁竞争分析", "全栈时间分析"]
---

# 09 全栈性能诊断——BPF 工具链与 OFF-CPU 分析

**摘要：**
前几篇文章覆盖的性能工具（perf、火焰图、blktrace、iostat、ss）都有一个共同局限：它们主要告诉你进程**在 CPU 上做了什么**（on-CPU 时间）。但现实中，最难排查的 P99 延迟问题往往来自进程**不在 CPU 上的时间**（off-CPU 时间）——进程在等待什么？等锁？等 IO？等调度？等网络？在 on-CPU 火焰图上，这些等待时间是隐形的，火焰图显示进程很"健康"（没有明显热点），但 P99 延迟却居高不下。**OFF-CPU 分析**是 Brendan Gregg 提出的分析方法，通过追踪进程从"运行态"切换到"睡眠态"的时刻（`sched_switch` 事件），记录睡眠的持续时间和触发睡眠的调用栈，生成 **OFF-CPU 火焰图**——让隐藏的等待时间可见化。本文以 BPF/bpftrace 为核心工具，系统介绍 OFF-CPU 分析的原理与实践，并扩展到锁竞争分析（`mutexlock`/`rwlock` 等待时间）、IO 等待分析（`bio_latency`）、以及如何构建完整的"ON-CPU + OFF-CPU"全貌时间分析。

---

## 第 1 章 ON-CPU vs OFF-CPU：时间到哪里去了

### 1.1 进程的时间构成

一个进程从收到请求到返回响应，其时间由两部分构成——这两部分构成了"全栈时间"的完整图景，缺一不可：

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

进程时间的二分法有一个与"性能诊断盲区"相关的核心洞察——传统的 on-CPU 工具（perf、火焰图）只能看到"ON-CPU 时间"，看不到"OFF-CPU 时间"。如果一个进程的 P99 延迟主要来自 OFF-CPU（等锁、等 IO），on-CPU 火焰图完全看不到问题——火焰图显示"没有热点"，但 P99 却高。这是"on-CPU 工具的盲区"——它假设"CPU 时间 = 总时间"，但 OFF-CPU 时间被忽略了。**ON-CPU 工具的盲区是"看不到 OFF-CPU 时间"**——这是 OFF-CPU 分析存在的根本理由，填补 on-CPU 工具的盲区。

进程时间的二分法还有一个与"P99 延迟"相关的实战意义——P99 延迟问题（99 分位的慢请求）往往来自 OFF-CPU 而非 ON-CPU。为什么？因为 ON-CPU 时间相对稳定（CPU 算得快慢差异小），OFF-CPU 时间波动大（等锁、等 IO 的等待时间受系统负载影响）。所以"慢请求"（P99）通常是"等得久"的请求——某个请求恰好遇到锁争用或 IO 拥堵，等待时间飙升。所以 P99 问题要查 OFF-CPU——on-CPU 火焰图看不到 P99 的根因。**P99 延迟问题往往来自 OFF-CPU**——这是 OFF-CPU 分析的"P99 诊断价值"，P99 的根因在等待时间波动。

进程时间的二分法还有一个与"平均 vs 分位"相关的统计视角——平均延迟可能正常（大部分请求快），但 P99 延迟高（少数请求慢）。这是因为 OFF-CPU 时间有"长尾"——大部分请求等得短（无争用），少数请求等得长（遇到争用）。平均掩盖长尾，P99 暴露长尾。所以性能诊断要看"P99 而非平均"——平均正常不代表 P99 正常。**P99 暴露 OFF-CPU 长尾**——这是延迟分析的"分位视角"，平均掩盖长尾，P99 暴露长尾。

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

on-CPU 火焰图的"采样盲区"有一个与"perf 采样机制"相关的本质——perf 用定时中断采样"当前在 CPU 上运行的进程"。进程等锁时让出 CPU（不运行），定时中断采不到它——等锁时间在火焰图上是"空白"。这不是 perf 的 bug，而是"采样机制的固有盲区"——采样只能看到"运行态"，看不到"睡眠态"。**perf 采样的固有盲区是"看不到睡眠态"**——这是 on-CPU 火焰图的"机制局限"，不是工具 bug。

on-CPU 火焰图的采样盲区还有一个与"perf 采样频率"相关的细节——perf 的采样频率（默认 99Hz，每秒 99 次）决定了"能看到多短的 CPU 时间"。如果进程在 CPU 上跑了不到 10ms（1/99 秒），可能采不到——采样盲区。但 OFF-CPU 分析用事件驱动，不依赖采样频率——即使睡眠 1µs 也能记录。所以 OFF-CPU 分析对"短等待"也敏感——而 perf 对"短 CPU 时间"可能漏采。**OFF-CPU 分析对"短等待"也敏感**——这是 OFF-CPU 分析的"短时敏感"，事件驱动不漏短事件。

on-CPU 火焰图的采样盲区还有一个与"wall clock 采样"相关的替代方案——perf 也支持"wall clock 采样"（`perf record -e sched:sched_switch` 或 `perf record --call-graph=dwarf -e cpu-clock`），能采到"睡眠态"进程。但 perf 的 wall clock 采样不如 BPF 的 OFF-CPU 分析精确——perf 是"采样"，BPF 是"事件驱动"。所以 wall clock 采样是"perf 的 OFF-CPU 近似"，不如 BPF 精确，但比纯 on-CPU 采样好。**perf wall clock 采样是"OFF-CPU 近似"**——这是 perf 的"OFF-CPU 替代"，不如 BPF 精确但比 on-CPU 好。

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

OFF-CPU 分析的核心思路有一个与"事件驱动"相关的机制——OFF-CPU 分析不是"采样"（像 perf 那样定时采样），而是"事件驱动"——每次 `sched_switch`（进程切换）都触发 BPF 程序记录。事件驱动比采样精确——不漏掉任何一次切换，精确测量每次睡眠的持续时间。所以 OFF-CPU 分析的精度比 on-CPU 火焰图高——on-CPU 是"采样估计"，OFF-CPU 是"事件精确"。**OFF-CPU 分析是"事件驱动"，比 on-CPU 采样精确**——这是 OFF-CPU 分析的"精度优势"，不漏掉任何等待事件。

OFF-CPU 分析的核心思路还有一个与"调用栈记录"相关的细节——OFF-CPU 分析记录的是"进程被切换出去时的调用栈"，即"是谁让我睡觉的"。这个调用栈显示了"导致睡眠的代码路径"——譬如 `pthread_mutex_lock → futex_wait` 说明"在等锁"，`read → io_schedule` 说明"在等 IO"。所以 OFF-CPU 火焰图的调用栈是"睡眠原因的代码路径"——直接指向"哪段代码在等待"。**OFF-CPU 调用栈是"睡眠原因的代码路径"**——这是 OFF-CPU 分析的"代码定位"，调用栈直接指向等待的代码。

OFF-CPU 分析的核心思路还有一个与"状态过滤"相关的精度——并非所有 `sched_switch` 都是"问题等待"——譬如进程主动 `sleep`（定时等待）是正常的，不算问题。OFF-CPU 分析可以"过滤状态"——只记录"非自愿切换"（被调度出去，而非主动 sleep）的等待。这区分"主动等待"（正常）和"被动等待"（可能问题）。所以 OFF-CPU 分析要"过滤主动 sleep"——聚焦"被动等待"（锁、IO、调度）。**OFF-CPU 分析要"过滤主动 sleep"**——这是 OFF-CPU 分析的"状态过滤"，聚焦被动等待。

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

BCC vs bpftrace 的选择有一个与"现成 vs 自定义"相关的决策——BCC 提供"现成工具"（`offcputime`、`biolatency` 等），开箱即用，适合"常见问题"；bpftrace 提供"脚本语言"，灵活自定义，适合"特殊问题"。日常诊断用 BCC（快速），深度排查用 bpftrace（灵活）。两者不冲突——先用 BCC 现成工具快速定位，再用 bpftrace 自定义脚本精确分析。**BCC "现成快速"，bpftrace "自定义灵活"**——这是 BPF 工具选择的"两步法"，先 BCC 后 bpftrace。

BCC vs bpftrace 的选择还有一个与"开发效率 vs 运行效率"相关的权衡——bpftrace 脚本"开发快"（几行代码）但"运行稍慢"（运行时编译 BPF）；BCC 工具"开发慢"（Python/C 几十行）但"运行快"（预编译 BPF）。所以"临时分析"用 bpftrace（开发快），"常用工具"用 BCC（运行快）。这是"开发效率 vs 运行效率"的权衡——根据使用频率选择。**bpftrace "开发快"，BCC "运行快"**——这是 BPF 工具的"效率权衡"，临时用 bpftrace，常用用 BCC。

BCC vs bpftrace 的选择还有一个与"工具生态"相关的趋势——bpftrace 的生态在快速成长（更多示例、更多文档、更多社区支持），逐渐成为"BPF 追踪的主流"。BCC 仍保留"现成工具"优势，但"自定义追踪"的生态向 bpftrace 集中。所以新学 BPF 推荐"先学 bpftrace"——生态更活跃，未来更主流。**bpftrace 生态"快速成长"，推荐先学**——这是 BPF 工具的"生态趋势"，bpftrace 成为主流。

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

bpftrace 的语法有一个与"类 awk"相关的简洁性——bpftrace 的语法类似 awk：`pattern { action }`。pattern 是探针（`kprobe:函数名`），action 是处理逻辑（`@map[key] = value`）。这种"模式 + 动作"的语法简洁且表达力强——几行代码就能写一个自定义追踪。相比 BCC 的 Python/C 编写 BPF 程序（几十行），bpftrace 几行搞定——开发效率高。**bpftrace "类 awk"语法简洁高效**——这是 bpftrace 的"语法优势"，几行代码自定义追踪。

bpftrace 的语法还有一个与"map 聚合"相关的核心特性——bpftrace 的 `@map[key] = value` 是"聚合 map"——自动按 key 聚合 value。譬如 `@syscall_lat[name] = hist($lat)` 自动按系统调用名聚合延迟直方图。这让"统计聚合"变得简单——几行代码就能"按维度聚合统计"。相比 BCC 要手写 map 操作，bpftrace 的聚合 map 大幅简化统计代码。**bpftrace "聚合 map"简化统计**——这是 bpftrace 的"聚合优势"，自动按 key 聚合 value。

bpftrace 的语法还有一个与"hist 直方图"相关的可视化——bpftrace 的 `hist(val)` 函数自动生成"幂次直方图"（log2 分桶），`lhist(val, min, max, step)` 生成"线性直方图"。直方图比"平均值"更能反映"分布形态"——譬如 `hist($lat)` 显示延迟分布，一眼看出"长尾"。所以 bpftrace 的 hist 是"延迟分析"的利器——自动生成分桶直方图，无需手动统计。**bpftrace `hist` 自动生成直方图**——这是 bpftrace 的"可视化优势"，延迟分析利器。

bpftrace 的探针类型还有一个与"稳定 vs 不稳定"相关的选择——`tracepoint` 是"稳定接口"（内核保证 ABI 稳定，字段不变），`kprobe` 是"不稳定接口"（内核函数可能改名或消失）。所以生产环境优先用 `tracepoint`——跨内核版本兼容；`kprobe` 只用于"tracepoint 没覆盖"的场景，且要"绑定内核版本"。**`tracepoint` 稳定，`kprobe` 不稳定**——这是 bpftrace 探针选择的"稳定性原则"，生产优先 tracepoint。

bpftrace 的探针类型还有一个与"uprobe"相关的用户态追踪——`uprobe` 是"用户态函数探针"——可以追踪用户态程序的函数（譬如 `pthread_mutex_lock`、`malloc`）。这让 bpftrace 不只看内核，还能看用户态函数——譬如追踪 `pthread_mutex_lock` 的等待时间。所以 bpftrace 能"跨用户态/内核态追踪"——uprobe 看用户态，kprobe/tracepoint 看内核态。**`uprobe` 让 bpftrace 能追踪用户态函数**——这是 bpftrace 的"跨态追踪"，uprobe 看用户态，kprobe 看内核态。

bpftrace 的探针类型还有一个与"USDT"相关的高级特性——USDT（User Statically Defined Tracing）是"用户态静态探针"——应用开发者预先在代码中埋点（譬如 `DTRACE_PROBE` 宏），bpftrace 通过 `usdt:路径:探针名` 追踪。USDT 比 uprobe 稳定（探针位置固定，不随版本变）且有语义（探针名有业务含义）。譬如 MySQL、PostgreSQL 有 USDT 探针——`usdt:/usr/sbin/mysqld:query__start` 追踪查询开始。所以 USDT 是"应用级追踪"的最佳实践——应用埋点，bpftrace 追踪。**USDT 是"应用级追踪"的最佳实践**——这是 bpftrace 的"静态探针"，应用埋点稳定有语义。

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

OFF-CPU 火焰图的解读有一个与"宽度含义"相关的关键——OFF-CPU 火焰图的"宽度"是"睡眠时间"而非"CPU 时间"。宽框代表"在这里等了很久"，不是"在这里算了很久"。所以解读 OFF-CPU 火焰图要找"最宽的框"——那是"等待最久"的代码路径。这与 on-CPU 火焰图"找最宽的框（CPU 热点）"同理，但含义不同——on-CPU 宽 = 算得久，off-CPU 宽 = 等得久。**OFF-CPU 火焰图"宽 = 等得久"**——这是 OFF-CPU 火焰图的"解读关键"，宽度是等待时间。

OFF-CPU 火焰图的解读还有一个与"颜色"相关的区分——FlameGraph 工具生成 OFF-CPU 火焰图时，用 `--color=io` 参数指定"IO 色系"（蓝绿色），区别于 on-CPU 火焰图的"CPU 色系"（红黄色）。这让"看图"时一眼区分"这是 OFF-CPU 还是 on-CPU"——颜色不同。所以 OFF-CPU 火焰图用 `--color=io`，on-CPU 用 `--color=hot`——颜色区分图类型。**OFF-CPU 火焰图用 `--color=io` 区分 on-CPU**——这是 OFF-CPU 火焰图的"颜色区分"，蓝绿色 vs 红黄色。

OFF-CPU 火焰图的解读还有一个与"调用栈深度"相关的细节——OFF-CPU 火焰图的调用栈可能很深（从业务代码到内核 `schedule`），但"热点"通常在"栈底"（内核等待函数）和"栈顶"（业务代码）。栈底（`futex_wait`、`io_schedule`）告诉你"等什么"，栈顶（业务函数）告诉你"谁在等"。所以解读 OFF-CPU 火焰图要"看栈底 + 栈顶"——栈底看等待类型，栈顶看业务代码。**OFF-CPU 火焰图"栈底看类型，栈顶看代码"**——这是 OFF-CPU 火焰图的"解读技巧"，两端结合定位。

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

bpftrace 自定义追踪有一个与"过滤条件"相关的优化——bpftrace 脚本可以加"过滤条件"（`/pid == 1234/`、`/args->prev_comm == "java"/`），只追踪关注的进程。这比 offcputime 的"全进程追踪"更精准——减少无关进程的噪声，聚焦目标进程。且过滤在"BPF 程序内"做（内核态过滤），比"用户态过滤"开销小——不相关的数据不传到用户态。**bpftrace "内核态过滤"比"用户态过滤"开销小**——这是 bpftrace 的"过滤优势"，内核态过滤减少用户态噪声。

bpftrace 自定义追踪还有一个与"阈值过滤"相关的实用技巧——bpftrace 脚本可以加"阈值过滤"（譬如 `if ($dur_us > 1000)`），只输出"超过 1ms 的等待"。这避免"短等待"淹没"长等待"——只看"有问题的长等待"。譬如每秒几十万次 `sched_switch`，大部分是"微秒级短等待"（正常），只有少数是"毫秒级长等待"（问题）。阈值过滤只输出长等待——聚焦问题。**bpftrace "阈值过滤"聚焦长等待**——这是 bpftrace 的"阈值技巧"，只看有问题的长等待。

bpftrace 自定义追踪还有一个与"用户态栈 + 内核态栈"相关的双栈——bpftrace 的 `ustack` 是用户态栈，`kstack` 是内核态栈。OFF-CPU 分析通常要"双栈"——`ustack` 看业务代码，`kstack` 看内核等待函数。譬如 `ustack` 显示 `process_request`，`kstack` 显示 `futex_wait`——结合知道"process_request 在等锁"。所以 OFF-CPU 分析要记录"双栈"——用户态 + 内核态，两者结合定位。**OFF-CPU 分析要"双栈"（用户态 + 内核态）**——这是 OFF-CPU 分析的"双栈原则"，ustack 看代码，kstack 看等待。

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

wakeuptime 有一个与"反向追踪"相关的独特价值——offcputime 看"进程在哪里睡"（正向），wakeuptime 看"谁唤醒了进程"（反向）。有时候"反向"比"正向"更有用——譬如进程在 `epoll_wait` 睡（正向看不出问题），但 wakeuptime 显示"TCP 数据到达唤醒"（反向）——说明进程在等网络响应，瓶颈在下游服务。所以 offcputime + wakeuptime 是"正反双向"分析——两者结合才能完整定位等待来源。**offcputime + wakeuptime 是"正反双向"分析**——这是 OFF-CPU 分析的"双向定位"，正向看睡点，反向看唤醒源。

offcputime + wakeuptime 的双向分析还有一个与"下游服务"相关的典型场景——譬如微服务 A 调用微服务 B，A 的 P99 高。offcputime 显示 A 在 `epoll_wait` 睡（等 B 响应），但看不出"等 B 多久"。wakeuptime 显示 A 被 `tcp_data_ready` 唤醒（B 的响应到了）——确认 A 在等 B。结合 offcputime 的等待时间，算出"等 B 响应花了多久"——定位瓶颈在 B。所以 offcputime + wakeuptime 能"定位下游服务延迟"——这是微服务诊断的典型用法。**offcputime + wakeuptime 能"定位下游服务延迟"**——这是双向分析的"微服务诊断"价值。

offcputime + wakeuptime 的双向分析还有一个与"唤醒源类型"相关的分类——wakeuptime 显示的"唤醒源"能分类等待类型：`tcp_data_ready` 唤醒 → 等网络响应（下游服务），`io_completion` 唤醒 → 等 IO 完成，`futex_wake` 唤醒 → 等锁释放。所以 wakeuptime 的"唤醒源函数"直接分类等待类型——比 offcputime 的"睡眠点"更精确（睡眠点可能多个，唤醒源通常一个）。**wakeuptime "唤醒源函数"分类等待类型**——这是 wakeuptime 的"分类价值"，唤醒源比睡眠点更精确。

---

## 第 4 章 锁竞争分析

### 4.1 锁竞争是 OFF-CPU 的主要来源之一

互斥锁竞争是多线程服务中最常见的 OFF-CPU 原因。当线程 A 持有锁时，线程 B 尝试加锁会进入 `futex_wait`（内核等待），被调度出 CPU，直到线程 A 释放锁并唤醒线程 B。

**锁竞争的症状**：
- CPU 使用率不高，但吞吐量达不到预期
- 增加线程数，性能不再提升（甚至下降）
- `perf stat` 显示大量 `context-switches`（上下文切换）
- `/proc/<pid>/sched` 中 `nr_involuntary_switches` 增长

锁竞争的症状有一个与"CPU 不高但吞吐低"相关的特征——锁竞争的典型症状是"CPU 使用率不高，但吞吐量达不到预期"。这是因为线程大部分时间在"等锁"（OFF-CPU），不在 CPU 上跑——CPU 看起来闲，但吞吐量上不去（线程被锁阻塞）。这与"CPU 密集型"相反——CPU 密集型是"CPU 高 + 吞吐高"，锁竞争是"CPU 低 + 吞吐低"。所以"CPU 低 + 吞吐低"是锁竞争的信号——要怀疑锁瓶颈。**"CPU 低 + 吞吐低"是锁竞争的信号**——这是锁竞争的"症状特征"，与 CPU 密集型相反。

锁竞争的症状还有一个与"线程数增加无益"相关的特征——锁竞争时"增加线程数，性能不再提升（甚至下降）"。为什么？因为线程越多，争同一把锁的线程越多——等锁时间更长，吞吐反而下降。这与"CPU 密集型"相反——CPU 密集型增加线程数能利用多核，吞吐提升。所以"增加线程数无益甚至有害"是锁竞争的信号——说明瓶颈在锁而非 CPU。**"增加线程数无益"是锁竞争的信号**——这是锁竞争的"线程数特征"，与 CPU 密集型相反。

锁竞争的症状还有一个与"context-switches 高"相关的指标——`perf stat` 显示"高 context-switches"是锁竞争的信号。为什么？因为等锁的线程被调度出去（切换），锁释放后被唤醒（切换）——每次锁争用产生 2 次上下文切换。所以锁竞争 → 高 context-switches。`perf stat` 看 context-switches 计数——如果异常高，怀疑锁竞争。**"高 context-switches"是锁竞争的信号**——这是锁竞争的"切换指标"，等锁产生上下文切换。

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

bpftrace 追踪 mutex 有一个与"锁地址"相关的定位——bpftrace 用"锁地址"（`arg0` 是 `pthread_mutex_lock` 的第一个参数，即锁的地址）作为 key 统计等待时间。不同锁的地址不同——通过地址区分"哪把锁"等待久。找到热点锁地址后，再结合代码（"哪个锁的地址是 0x7f1234567890"）定位具体锁。**bpftrace 用"锁地址"区分热点锁**——这是 mutex 分析的"地址定位"，通过地址映射到代码中的具体锁。

bpftrace 追踪 mutex 还有一个与"uprobe vs futex"相关的层次——追踪 mutex 有两个层次：`uprobe:pthread_mutex_lock`（用户态锁函数）和 `tracepoint:syscalls:sys_enter_futex`（内核锁系统调用）。前者看到"所有 mutex 调用"（含无争用快速路径），后者只看到"有争用进内核的 futex"（慢速路径）。所以"统计所有 mutex 调用"用 uprobe，"统计有争用的 mutex"用 futex tracepoint——两者层次不同。**uprobe 看"所有 mutex"，futex 看"有争用 mutex"**——这是 mutex 追踪的"层次选择"，uprobe 全量，futex 慢速路径。

bpftrace 追踪 mutex 还有一个与"读写锁"相关的扩展——除了 mutex（互斥锁），还有 rwlock（读写锁）。rwlock 的读锁（共享）和写锁（排他）行为不同——读锁能并发，写锁排他。bpftrace 可以分别追踪 `pthread_rwlock_rdlock` 和 `pthread_rwlock_wrlock` 的等待时间——看是"读锁争用"还是"写锁争用"。所以锁分析要"区分锁类型"——mutex、rwlock、spinlock 各有不同追踪方式。**锁分析要"区分锁类型"（mutex/rwlock/spinlock）**——这是锁分析的"类型区分"，不同锁不同追踪。

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

定位持锁线程有一个与"等待 vs 持有"相关的双面分析——锁竞争问题要分析两面："等待时间"（谁等得久）和"持有时间"（谁持得久）。等待时间长说明"锁争用激烈"，持有时间长说明"临界区太大"。两者要结合——如果等待长但持有短，说明"并发度太高"（多个线程争同一锁）；如果等待长且持有长，说明"临界区太大"（持锁线程在临界区做了太多事）。**锁竞争要分析"等待 + 持有"双面**——这是锁分析的"双面法"，等待看争用，持有看临界区。

定位持锁线程还有一个与"临界区优化"相关的方向——找到"持锁久"的线程后，优化方向是"缩小临界区"——只在必要时持锁，不在临界区做耗时操作（譬如 IO、复杂计算）。譬如持锁 2ms 是因为临界区有 `read`（IO）——把 `read` 移出临界区（先读再锁），持锁时间降到几十微秒。所以"缩小临界区"是锁优化的核心——减少持锁时间，减少等待时间。**"缩小临界区"是锁优化的核心**——这是锁优化的"方向"，减少持锁时间。

定位持锁线程还有一个与"读写锁替代"相关的优化——如果临界区是"读多写少"（譬如配置读取，读多写少），用"读写锁"替代"互斥锁"——读锁能并发，不互斥。这把"串行读"变"并行读"——读吞吐提升。所以"读多写少"场景用读写锁——这是锁优化的"锁类型选择"。**"读多写少"用读写锁替代互斥锁**——这是锁优化的"类型选择"，读锁并发提升吞吐。

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

Java 锁分析有一个与"wall clock 采样"相关的特殊方法——Java 的 AsyncProfiler 支持 `event=wall`（挂钟时间采样），而非 `event=cpu`（CPU 时间采样）。wall 采样能采到"等待中的线程"（等锁、等 IO），而 cpu 采样采不到。所以 Java 的 OFF-CPU 分析用 `event=wall`——这是 Java 特有的 OFF-CPU 方法，相当于"采样版的 offcputime"。**Java AsyncProfiler `event=wall` 是"采样版 OFF-CPU"**——这是 Java 锁分析的特殊方法，wall 采样覆盖等待时间。

Java 锁分析还有一个与"synchronized vs ReentrantLock"相关的区分——Java 有两种主要锁：`synchronized`（JVM 内置锁，monitorenter/monitorexit）和 `ReentrantLock`（JUC 锁，基于 AQS）。两者最终都可能进 `futex_wait`（内核等待），但 JVM 内部逻辑不同——`synchronized` 有"锁膨胀"（偏向锁→轻量锁→重量锁），`ReentrantLock` 直接用 AQS。所以 bpftrace 看到 `futex_wait` 不能直接区分是 `synchronized` 还是 `ReentrantLock`——要看 JVM 内部状态（JFR 能区分）。**`synchronized` 和 `ReentrantLock` 都可能进 `futex_wait`**——这是 Java 锁分析的"区分难点"，bpftrace 看不出锁类型，要 JFR。

Java 锁分析还有一个与"锁膨胀"相关的 JVM 机制——`synchronized` 锁有"锁膨胀"过程：偏向锁（无争用，最快）→ 軽量锁（CAS 自旋，少量争用）→ 重量锁（futex 内核等待，高争用）。只有"重量锁"才进 `futex_wait`——前两个不进内核。所以 bpftrace 看到 `futex_wait` 说明锁已膨胀到"重量锁"——争用严重。JFR 能看"锁膨胀事件"——提前发现"锁从轻量变重量"。**`futex_wait` 说明 synchronized 已膨胀到"重量锁"**——这是 Java 锁分析的"膨胀判断"，futex 说明争用严重。

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

biolatency 有一个与"延迟分布"相关的诊断价值——biolatency 显示 IO 延迟的"直方图分布"，不只"平均延迟"。平均延迟可能掩盖"长尾"——譬如平均 50µs 但 P99 2ms（有长尾）。直方图能看出"长尾"——譬如 1024-2047µs 有 45 个（长尾）。所以 biolatency 的直方图比"平均延迟"诊断价值高——能看到分布形态，发现长尾。**biolatency 直方图比"平均延迟"诊断价值高**——这是 IO 延迟分析的"分布视角"，平均掩盖长尾，直方图暴露长尾。

biolatency 还有一个与"长尾根因"相关的诊断方向——biolatency 显示"长尾"（1-4ms 的 IO）后，要找"长尾根因"。常见根因：磁盘内部 GC（SSD 的垃圾回收，偶发延迟）、IO 调度器重排序（IO 合并导致某些 IO 等久）、文件系统 journal（ext4 的 journal 提交阻塞 IO）。所以长尾 IO 要"分层排查"——磁盘层（biosnoop 看个别 IO）、调度器层（`/sys/block/sdX/queue/scheduler` 看调度器）、文件系统层（ext4slower 看 journal）。**长尾 IO 要"分层排查"根因**——这是 IO 长尾的"分层诊断"，磁盘/调度器/文件系统逐层排查。

biolatency 还有一个与"按进程/设备分类"相关的细化——biolatency 的 `-P`（按进程）和 `-D`（按设备）参数能"分类统计"——看是"哪个进程的 IO 慢"或"哪个设备的 IO 慢"。譬如 `-P` 显示 mysql 进程的 IO 长尾多——定位到 mysql；`-D` 显示 nvme0 的 IO 长尾多——定位到 nvme0。所以 biolatency 的分类参数能"细化定位"——从"整体长尾"到"进程/设备长尾"。**biolatency `-P`/`-D` 分类定位长尾来源**——这是 biolatency 的"分类细化"，按进程/设备定位。

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

biosnoop 有一个与"逐个事件"相关的精度——biolatency 是"统计分布"（聚合），biosnoop 是"逐个事件"（明细）。biosnoop 打印每个 IO 的"时间、进程、磁盘、扇区、大小、延迟"——能看到"哪个进程的哪个 IO 慢"。譬如 java 进程的某次 64KB 读取 1.23ms——精确定位"哪个进程的哪个 IO 异常"。所以 biolatency 看"整体分布"，biosnoop 看"个别异常"——两者互补。**biolatency 看"整体分布"，biosnoop 看"个别异常"**——这是 IO 分析的"统计 + 明细"双视角。

biosnoop 还有一个与"延迟关联进程"相关的定位——biosnoop 打印每个 IO 的"进程名 + PID + 延迟"——能看到"哪个进程的哪个 IO 慢"。譬如 java 进程的某次 64KB 读取 1.23ms——精确定位"java 进程的某个 IO 异常"。这比 biolatency 的"整体分布"更 actionable——直接知道"哪个进程要查"。所以 biosnoop 适合"定位慢 IO 的进程"——而 biolatency 适合"看整体延迟形态"。**biosnoop "延迟关联进程"定位慢 IO 来源**——这是 biosnoop 的"进程定位"价值，直接知道哪个进程慢。

biosnoop 还有一个与"时间戳关联"相关的时序分析——biosnoop 打印每个 IO 的"时间戳"——能看到"IO 的时间分布"。譬如某段时间 IO 延迟集中飙升——结合时间戳找到"那段时刻发生了什么"（譬如 GC、日志刷盘）。所以 biosnoop 的"时间戳"能做"时序关联"——IO 延迟与系统事件的时间关联。**biosnoop "时间戳"做时序关联**——这是 biosnoop 的"时序分析"，IO 延迟与系统事件关联。

### 5.3 ext4slower：文件系统层慢操作

```bash
# ext4slower：追踪 ext4 文件系统中超过阈值的慢操作（默认 10ms）
/usr/share/bcc/tools/ext4slower 10
# Tracing ext4 operations slower than 10 ms... Hit Ctrl-C to end.
# TIME     COMM         PID    T BYTES   OFF_KB   LAT(ms) FILENAME
# 12:34:56 mysqld       1234   R 16384   1024       15.23  /var/lib/mysql/users.ibd
# 12:34:57 java         5678   W 4096    2048       23.45  /var/log/app/server.log
#
# 含义：mysqld 读取 users.ibd 花了 15ms（超过 10ms 阈值），是慢操作
# 可能原因：文件碎片、磁盘 GC、IO 调度器排队

# 类似工具：
# xfs slower    # XFS 文件系统慢操作
# zfs slower    # ZFS 文件系统慢操作
# nfs slower    # NFS 慢操作
```

ext4slower 有一个与"分层定位"相关的价值——ext4slower 在"文件系统层"追踪慢操作，biosnoop 在"块设备层"追踪。如果 ext4slower 显示慢但 biosnoop 正常，说明"瓶颈在文件系统层"（譬如文件系统锁、journal 等待）；如果两者都慢，说明"瓶颈在块设备层"（磁盘慢）。所以 ext4slower + biosnoop 是"分层定位"——文件系统层 + 块设备层，定位瓶颈在哪层。**ext4slower + biosnoop 是"分层定位"**——这是 IO 分析的"分层视角"，文件系统层 vs 块设备层。

ext4slower 还有一个与"文件名关联"相关的定位——ext4slower 打印"文件名 + 延迟"——能看到"哪个文件的 IO 慢"。譬如 `/var/lib/mysql/users.ibd` 读取 15ms——精确定位"哪个文件慢"。这比 biosnoop 的"扇区号"更直观——文件名比扇区号易理解。所以 ext4slower 适合"定位慢文件"——而 biosnoop 适合"定位慢扇区"。**ext4slower "文件名关联"定位慢文件**——这是 ext4slower 的"文件定位"价值，文件名比扇区号直观。

ext4slower 还有一个与"阈值调整"相关的实践——ext4slower 的"慢操作阈值"可调（默认 10ms）。对于"NVMe"（正常 IO 几十微秒），阈值可以调低到 1ms——更敏感地发现慢 IO；对于"HDD"（正常 IO 几毫秒），阈值调高到 50ms——避免正常 IO 被报为慢。所以阈值要"按设备类型调整"——NVMe 低阈值，HDD 高阈值。**ext4slower 阈值要"按设备类型调整"**——这是 ext4slower 的"阈值实践"，NVMe 低 HDD 高。

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

完整的请求时间分解有一个与"全栈视角"相关的目标——性能诊断的终极目标是"理解一个请求的时间花在哪"。ON-CPU 分析看"算的时间"，OFF-CPU 分析看"等的时间"，两者拼起来才是"完整时间"。所以全栈时间分析 = ON-CPU + OFF-CPU——这是性能诊断的"完整图景"，缺一不可。**全栈时间 = ON-CPU + OFF-CPU**——这是性能诊断的"完整图景"，两者拼起来才完整。

完整的请求时间分解还有一个与"请求边界"相关的挑战——要分解请求时间，要先确定"请求开始和结束"的边界。HTTP 请求的边界是"accept（开始）→ write（结束）"，但 RPC 请求的边界可能是"recv（开始）→ send（结束）"。所以 bpftrace 脚本要根据"协议的请求边界"定制——没有通用脚本。这是"请求时间分解"的难点——要懂应用的协议边界。**请求时间分解要"按协议边界定制"**——这是全栈时间分析的"定制难点"，要懂应用协议。

完整的请求时间分解还有一个与"直方图输出"相关的统计——bpftrace 脚本用 `hist($total_us)` 输出"请求延迟直方图"——能看到"P50/P99/P999"的分布。这比"平均延迟"更有诊断价值——能看到"长尾请求"的延迟。所以请求时间分解要"输出直方图"——不只看平均，看分布。**请求时间分解要"输出直方图"**——这是全栈时间分析的"统计输出"，直方图看分布。

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

综合诊断工作流有一个与"决策树"相关的系统性——工作流是"决策树"：先量化问题（步骤 1），再分类问题（步骤 2：CPU 高 vs 低），再深入分析（步骤 3：OFF-CPU 热点类型），最后量化效果（步骤 4）。这种"决策树"工作流避免"盲目试工具"——按逻辑顺序逐步缩小范围。**综合诊断是"决策树"工作流**——这是全栈诊断的"系统性"，避免盲目试工具，按逻辑缩小范围。

综合诊断工作流还有一个与"先量化后分析"相关的顺序——工作流的第一步是"量化问题"（iperf3、iostat、top），而不是"直接上 BPF"。为什么？因为 BPF 是"深度分析工具"，开销大，不适合"初步排查"。先用"低开销工具"（top、iostat）量化问题（CPU 高？IO 高？网络高？），再决定"是否需要 BPF 深度分析"。所以 BPF 是"第二步"——先量化，再深度分析。**BPF 是"第二步"，先量化后分析**——这是工作流的"顺序原则"，先用低开销工具量化。

综合诊断工作流还有一个与"CPU 高 vs 低"相关的分类——工作流的核心分类是"CPU 使用率高低"：CPU 高 → on-CPU 分析（perf 火焰图），CPU 低 → OFF-CPU 分析（offcputime）。这是"二分法"——CPU 高低决定分析方向。为什么这样分？因为 CPU 高说明"算得久"（on-CPU 问题），CPU 低说明"等得久"（OFF-CPU 问题）。所以"CPU 高低"是诊断的"第一分类"——决定走 on-CPU 还是 OFF-CPU 路径。**"CPU 高低"是诊断的"第一分类"**——这是工作流的"二分法"，CPU 高走 on-CPU，CPU 低走 OFF-CPU。

综合诊断工作流还有一个与"热点类型映射"相关的优化方向——OFF-CPU 火焰图的热点函数直接映射到优化方向：`futex_wait` → 锁优化，`io_schedule` → IO 优化，`epoll_wait` → 网络优化。这是"热点函数 → 优化方向"的映射表——看到热点函数就知道优化方向。所以 OFF-CPU 火焰图不只"发现问题"，还"指引优化"——热点函数类型决定优化手段。**OFF-CPU 热点函数 → 优化方向有映射**——这是 OFF-CPU 分析的"指引价值"，热点类型决定优化手段。

综合诊断工作流还有一个与"量化效果"相关的闭环——工作流的最后一步是"量化优化效果"（对比调优前后的 offcputime 和 P99）。这一步常被忽略——优化后不验证效果，不知道"优化是否有效"。所以"量化效果"是工作流的闭环——优化前测基线，优化后再测，对比确认效果。没有这一步，优化是"盲优化"——不知道是否有效。**"量化效果"是工作流的闭环**——这是工作流的"验证原则"，优化前后对比确认效果。

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

BPF 的生产安全性有一个与"验证器"相关的保障——BPF 验证器在"加载时"检查 BPF 程序的安全性：不允许无限循环（防止卡死 CPU）、不允许越界访问（防止破坏内核）、不允许未初始化读取（防止泄漏内核数据）。验证器保证 BPF 程序"不会破坏内核"——这是 BPF 可以在生产使用的安全基础。没有验证器，BPF 程序可能"卡死 CPU"或"破坏内核"——那就不能在生产用。**BPF 验证器是"生产安全"的保障**——这是 BPF 可以在生产使用的安全基础，加载时验证防止破坏内核。

BPF 的生产安全性还有一个与"只读追踪"相关的限制——追踪类型的 BPF 程序是"只读"的——只能读内核数据，不能修改。这保证了 BPF 程序"不会破坏内核状态"——即使 BPF 程序有 bug，也不会改坏内核。所以 BPF 追踪是"安全只读"——可以放心在生产用，不怕"改坏内核"。**BPF 追踪是"只读安全"**——这是 BPF 追踪的"安全限制"，只读不修改，放心生产用。

BPF 的性能开销还有一个与"高频事件"相关的风险——BPF 程序每次触发有 50-200ns 开销。低频事件（系统调用、IO）开销可忽略，高频事件（`sched_switch` 每秒几十万次）开销累积——50ns × 30 万 = 15ms/s（1.5% CPU）。所以高频事件的 BPF 要"短时间采集"（10-60 秒），不能"长期运行"——否则开销累积。**高频事件 BPF 要"短时间采集"**——这是 BPF 生产使用的"时长原则"，避免开销累积。

BPF 的性能开销还有一个与"percpu map"相关的优化——BPF 的 map 是"全局共享"的，多 CPU 同时访问会争用（锁开销）。`percpu map` 是"每 CPU 一个 map"——无锁并行访问，最后汇总。对于高频事件（`sched_switch`），用 percpu map 减少 map 争用——开销降低。所以高频 BPF 程序要用 percpu map——这是 BPF 性能优化的"map 技巧"。**percpu map 减少 BPF map 争用**——这是 BPF 的"map 优化"，高频场景用 percpu map。

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

BPF 的内核版本要求有一个与"功能演进"相关的版本差异——BPF 功能随内核版本演进：4.x 支持 BCC 基础工具，5.x 支持 bpftrace 高级特性（BTF、CO-RE），5.8+ 支持非 root BPF（CAP_BPF）。所以 BPF 工具的使用要"看内核版本"——某些工具在旧内核不可用。生产环境推荐 5.x 内核——BPF 功能最完整。**BPF 功能"随内核版本演进"**——这是 BPF 的"版本依赖"，推荐 5.x 内核。

BPF 的内核版本要求还有一个与"非 root 权限"相关的演进——Linux 5.8+ 支持"非 root BPF"（CAP_BPF + CAP_PERFMON）。之前只有 root 能用 BPF，5.8+ 后普通用户（有 CAP_BPF）也能用。这让 BPF 在容器场景更友好——容器内非 root 用户也能用 BPF 诊断。但生产环境要谨慎——CAP_BPF 是"高权限"，要限制授予。**Linux 5.8+ 支持"非 root BPF"**——这是 BPF 的"权限演进"，容器场景更友好但要谨慎授权。

### 7.3 BPF CO-RE：跨内核版本兼容

BPF CO-RE（Compile Once, Run Everywhere）是 BPF 的"跨内核兼容"技术——通过 BTF（BPF Type Format）让 BPF 程序"一次编译，到处运行"。没有 CO-RE，BPF 程序要"针对每个内核版本重新编译"（因为内核结构体字段偏移可能变化）；有 CO-RE，BPF 程序"编译一次"就能在不同内核版本运行（BTF 提供结构体信息，运行时调整偏移）。

```bash
# 检查 BTF 支持（CO-RE 的前提）
ls /sys/kernel/btf/vmlinux
# 存在即支持 BTF，CO-RE 可用

# libbpf 是 CO-RE 的核心库
# bpftrace 0.9+ 默认支持 CO-RE
# BCC 0.25+ 支持 CO-RE（libbpf-based BCC）
```

BPF CO-RE 有一个与"跨内核兼容"相关的价值——没有 CO-RE，BPF 程序绑定特定内核版本（结构体偏移硬编码），内核升级后 BPF 程序可能失效（偏移变了）。有 CO-RE，BPF 程序通过 BTF 动态适应偏移——内核升级后 BPF 程序仍能运行。所以 CO-RE 解决了"BPF 程序的跨内核兼容"——这是 BPF 在"多内核环境"（譬如多台不同版本内核的服务器）的关键。**CO-RE 解决"BPF 跨内核兼容"**——这是 BPF 的"可移植性"，通过 BTF 动态适应偏移。

BPF CO-RE 还有一个与"libbpf vs BCC"相关的实现差异——libbpf 是"CO-RE 原生"（从设计就支持 CO-RE），BCC 是"CO-RE 后加"（0.25+ 才支持）。所以新项目推荐 libbpf（CO-RE 原生），旧 BCC 工具逐步迁移到 libbpf。bpftrace 0.9+ 默认用 libbpf 后端——CO-RE 原生支持。**libbpf "CO-RE 原生"，BCC "CO-RE 后加"**——这是 CO-RE 的"实现差异"，新项目推荐 libbpf。

---

## 第 8 章 BPF 工具链的边界与盲区

### 8.1 BPF 不是万能的

BPF 虽然强大，但不能"看到一切"——BPF 主要看"内核态"事件（系统调用、调度、IO），对"用户态纯计算"（譬如 Java JIT 编译的代码）看不到内部。譬如 Java 的 `synchronized` 锁，BPF 能看到 `futex` 系统调用（内核态），但看不到 JVM 内部的锁膨胀逻辑（用户态）。所以 BPF 要与"语言特定工具"（Java 的 JFR、AsyncProfiler）配合——BPF 看内核，语言工具看用户态内部。**BPF 看"内核态"，语言工具看"用户态内部"**——这是 BPF 的"视角边界"，要与语言工具配合。

BPF 的边界还有一个与"JIT 代码"相关的盲区——BPF 的 uprobe 能追踪用户态函数，但对"JIT 编译的代码"（譬如 Java JVM JIT、V8 JavaScript JIT）看不到——JIT 代码的函数地址是运行时生成的，uprobe 无法预先挂载。所以 Java 的 JIT 编译方法，BPF 看不到——要用 Java 特定工具（AsyncProfiler、JFR）。这是 BPF 的"JIT 盲区"——动态生成的代码追踪不了。**BPF 有"JIT 代码盲区"**——这是 BPF 的"动态代码局限"，JIT 代码要用语言工具。

### 8.2 BPF 的开销不能忽略

BPF 虽然验证器保证安全，但"安全 ≠ 零开销"——每次 BPF 程序触发有 50-200ns 开销。在高频事件（`sched_switch`、网络包）上，开销累积——可能占几个百分点 CPU。所以 BPF 不能"长期开着"——它是"诊断工具"，不是"监控工具"。长期监控用"低开销工具"（譬如 Prometheus 的 node_exporter，定期采样），BPF 用于"临时诊断"（10-60 秒采集）。**BPF 是"诊断工具"非"监控工具"**——这是 BPF 的"使用定位"，短时诊断而非长期监控。

BPF 的开销还有一个与"过滤减少开销"相关的优化——BPF 程序加"过滤条件"（`/pid == 1234/`）能减少"不相关事件的 BPF 执行"——只对目标进程执行 BPF 逻辑，其他进程直接跳过。这降低 BPF 的"平均开销"——不相关事件不触发 BPF 逻辑。所以 BPF 脚本一定要加过滤——这是 BPF 开销优化的"过滤原则"。**BPF "加过滤减少开销"**——这是 BPF 的"过滤优化"，只对目标进程执行 BPF 逻辑。

### 8.3 BPF 的学习曲线

BPF 的学习曲线有一个与"多语言"相关的陡峭——BPF 涉及"内核知识 + BPF 字节码 + bpftrace 语法 + BCC Python"多个领域。写一个自定义 bpftrace 脚本要懂"内核 tracepoint、探针类型、map 操作"——不是"开箱即用"的工具。所以 BPF 的"入门门槛高"——需要学习内核和 BPF 语法。但 BCC 的现成工具降低了门槛——日常诊断用 BCC 现成工具（无需写代码），深度排查才用 bpftrace 自定义。**BPF "入门门槛高"，BCC 现成工具降低门槛**——这是 BPF 的"学习曲线"，先用 BCC 现成工具，再学 bpftrace。

BPF 的学习曲线还有一个与"社区资源"相关的辅助——BPF 有丰富的社区资源：Brendan Gregg 的"BPF Performance Tools"书、bpftrace 的官方文档、BCC 的工具示例。这些资源降低了学习门槛——照着示例改就能写 bpftrace 脚本。所以学 BPF 要"从示例开始"——找类似场景的 bpftrace 脚本，改改就能用，不用从零写。**学 BPF "从示例开始"降低门槛**——这是 BPF 学习的"示例法"，照着社区示例改。

---

## 第 9 章 小结

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

OFF-CPU 分析的核心认知是"时间不只 CPU 时间"——一个请求的时间 = ON-CPU + OFF-CPU，传统工具只看 ON-CPU，OFF-CPU 是盲区。OFF-CPU 分析填补盲区，让"等待时间"可见化——等锁、等 IO、等网络、等调度，都能在 OFF-CPU 火焰图上看到。**"时间 = ON-CPU + OFF-CPU，OFF-CPU 是传统工具的盲区"**——这是 OFF-CPU 分析的核心认知，填补 on-CPU 工具的盲区。

OFF-CPU 分析的核心认知还有一个与"工具组合"相关的实践——OFF-CPU 分析不是"单独用"，而是"与 on-CPU 分析组合"。完整诊断 = on-CPU 火焰图（看 CPU 热点）+ OFF-CPU 火焰图（看等待热点）+ wakeuptime（看唤醒源）+ biolatency（看 IO 延迟）。多工具组合才能"全栈诊断"——单一工具看不全。**OFF-CPU 分析要"与 on-CPU 组合"**——这是 OFF-CPU 分析的"组合实践"，多工具组合全栈诊断。

下一篇 [[10 性能调优实战案例——从症状到根因的完整诊断链路]] 是本专栏的收官篇，将三个真实的生产案例（Java 服务 P99 毛刺、数据库慢查询、高并发 API 网关吞吐量低）走完从"收到告警"到"找到根因并修复"的完整诊断链路，综合运用本专栏所有工具，展示真实场景中的多工具协作方式。

---

## 参考资料

1. Brendan Gregg, "Off-CPU Analysis"（OFF-CPU 分析方法的提出者）. https://www.brendangregg.com/offcpuanalysis.html
2. Brendan Gregg, "BPF Performance Tools"（BPF 性能工具圣经）. Addison-Wesley, 2019.
3. Linux kernel documentation, "BPF Documentation"（BPF 文档）. https://www.kernel.org/doc/html/latest/bpf/
4. bpftrace documentation, "bpftrace Reference Guide"（bpftrace 语法参考）. https://github.com/iovisor/bpftrace
5. BCC documentation, "BPF Compiler Collection"（BCC 工具集文档）. https://github.com/iovisor/bcc
6. Linux kernel documentation, "BTF (BPF Type Format)"（BPF 类型格式）. https://www.kernel.org/doc/html/latest/bpf/btf.html
7. libbpf documentation, "BPF CO-RE"（Compile Once, Run Everywhere）. https://github.com/libbpf/libbpf
8. AsyncProfiler documentation, "Java Off-CPU Profiling"（Java OFF-CPU 分析）. https://github.com/jvm-profiling-tools/async-profiler

---

> [!note] 思考题
> 1. 在'偶发 IO 延迟毛刺'场景中，如何用 bpftrace 定位毛刺发生时内核在做什么？`biolatency`（块设备层延迟分布）和 `ext4slower`（文件系统层慢操作）分别适用于什么层级？如果 `biolatency` 显示正常但 `ext4slower` 显示慢操作，说明瓶颈在哪一层？
> 2. OFF-CPU 火焰图中 `futex_wait` 占大比例意味着线程在等待锁。如何进一步定位是哪个用户态锁——可以用 `bpftrace` 追踪 `pthread_mutex_lock` 的调用栈吗？在 Java 应用中，`futex_wait` 对应的可能是 `synchronized` 还是 `ReentrantLock`？
> 3. eBPF 验证器限制了循环和指针访问。BPF CO-RE（Compile Once, Run Everywhere）通过 BTF（BPF Type Format）实现跨内核版本兼容。在什么场景下没有 CO-RE 会导致 eBPF 程序无法运行（如内核升级后结构体字段偏移变化）？libbpf 和 BCC 在 CO-RE 支持方面有什么差异？
