---
title: "CPU 性能分析——perf、火焰图与热点定位"
date: 2026-03-02
tags: [Linux, 性能优化, perf, 火焰图, CPU分析, 热点定位, profiling, on-CPU, 调用栈]
aliases: ["perf使用指南", "火焰图原理", "CPU热点定位", "Linux性能分析perf"]
---

**摘要：**

CPU 利用率高是最常见的性能问题症状，但"CPU 高"只是结论，不是根因。真正有价值的问题是：**CPU 时间花在哪里？是用户代码、库函数、系统调用，还是内核路径？是某个热点函数、锁争用、还是频繁的上下文切换？** `perf` 是 Linux 内核原生的性能分析工具，它通过**硬件性能计数器（PMU）** 和**采样机制**，能以极低的开销（通常 < 1% CPU 额外消耗）回答这个问题。但 `perf report` 的树状输出对于复杂调用栈难以阅读——**火焰图（Flame Graph）** 将调用栈可视化为宽度与 CPU 时间成正比的矩形堆叠，让热点函数一眼可见。本文从 `perf` 的采样原理出发，深入理解为什么基于中断的采样能代表 CPU 时间分布，然后系统讲解 on-CPU profiling 的完整工作流（`perf record` → `perf script` → 火焰图），以及如何针对不同场景（用户态热点、内核态热点、混合场景、多线程竞争）选择正确的 `perf` 参数组合。

---

## 第 1 章 perf 的工作原理：为什么采样能代表 CPU 时间

### 1.1 硬件性能计数器（PMU）是什么

现代 CPU 内部有一组专用寄存器，叫做**硬件性能计数器（PMU，Performance Monitoring Unit）**，可以对特定的 CPU 微架构事件进行计数：

- 已执行的指令数（instructions retired）
- CPU 时钟周期数（CPU cycles）
- 缓存缺失次数（LLC-load-misses、L1-dcache-misses）
- 分支预测失误次数（branch-misses）
- TLB 未命中次数（iTLB-load-misses、dTLB-load-misses）
- 内存总线访问次数（mem-loads、mem-stores）

PMU 的特点是**硬件直接计数，开销几乎为零**——CPU 在执行每条指令的同时，自动累加这些计数器，不需要软件干预。

**`perf stat` 直接读取 PMU 计数器**，给出程序执行期间的硬件事件统计摘要：

```bash
perf stat -e cycles,instructions,cache-misses,branch-misses \
    -p 1234 sleep 10

# Performance counter stats for process '1234':
#
#  12,345,678,901  cycles             #   3.21 GHz
#   9,876,543,210  instructions       #   0.80  insn per cycle  ← IPC < 1 说明 CPU 有等待
#      45,678,901  cache-misses       #   3.2% of all cache refs
#       1,234,567  branch-misses      #   0.8% of all branches
#
#      10.001234543 seconds time elapsed

# IPC（Instructions Per Cycle）= 0.80 < 1.0：
# 表明每个时钟周期 CPU 平均只执行 0.8 条指令
# 理想值接近 2-4（多发射 CPU）
# IPC 低说明 CPU pipeline 经常空转（等待内存数据、分支预测失误等）
```

### 1.2 采样机制：从计数到调用栈

`perf stat` 只给出总体统计，无法告诉你"哪段代码导致了 12 亿次 cache-misses"。这需要**采样（Sampling）**——`perf record` 的核心机制。

**采样原理**：

1. 设置 PMU 计数器，在计数溢出时（默认每隔 N 个周期）触发一个 **PMI（Performance Monitoring Interrupt，性能监控中断）**
2. PMI 中断处理程序捕获此刻的 **CPU 寄存器状态**（特别是 `RIP`——当前指令指针，以及 `RSP`——栈指针）
3. 通过栈指针**展开调用栈**（stack unwinding），记录从当前函数到 `main()` 的完整调用链
4. 将 `(调用栈, 时间戳)` 对写入 perf ring buffer

**为什么采样能代表 CPU 时间分布**：

这是一个统计学的基本原理——如果以固定频率（如 999 Hz）对 CPU 当前执行位置进行采样，每个采样点出现在某个函数的概率，**正比于该函数占用 CPU 时间的比例**。采样 3 万次后，如果函数 A 被采样到 6000 次，函数 B 被采样到 300 次，我们可以合理推断函数 A 占用了约 20% 的 CPU 时间，函数 B 约占 1%——这就是 profiling 的统计基础。

**采样频率与开销的权衡**：

```bash
# 默认采样频率：4000 Hz（Linux 内核限制最大约 100000 Hz）
perf record -F 4000 -p 1234 -- sleep 30

# 高精度模式：999 Hz（Brendan Gregg 推荐的"安全高频率"）
# 为什么用 999 而不是 1000？避免与系统时钟（1000 Hz）产生谐振
perf record -F 999 -a -g -- sleep 30

# 低频率（用于生产环境，减少干扰）：99 Hz
perf record -F 99 -a -g -- sleep 30
```

每次 PMI 中断约消耗 2-5µs 的 CPU 时间。在 999 Hz 频率下，每秒 999 次中断，每核消耗约 0.2-0.5% CPU——这是可接受的生产环境开销（但要在低峰期使用）。

### 1.3 调用栈展开：frame pointer vs DWARF vs LBR

`perf` 支持三种调用栈展开方式，选择错误会导致火焰图中出现大量"broken stacks"（断裂的调用链）：

**方式 1：Frame Pointer（帧指针）**

传统的调用栈展开方式——通过 `RBP` 寄存器（帧指针）链式追踪调用链。前提是程序编译时**保留了帧指针**（`-fno-omit-frame-pointer`）。GCC 默认的优化级别（`-O2`）会省略帧指针，导致 perf 无法展开调用栈：

```bash
# 检查二进制是否保留帧指针
objdump -d /usr/bin/nginx | head -50
# 若 push %rbp / mov %rsp,%rbp 出现在每个函数开头 → 保留了帧指针

# 重新编译时保留帧指针
g++ -O2 -fno-omit-frame-pointer my_program.cpp -o my_program

# JVM 需要特殊处理：-XX:+PreserveFramePointer（Java 8u60+）
java -XX:+PreserveFramePointer -jar app.jar
```

**方式 2：DWARF 调试信息**

读取 ELF 二进制中的 `.debug_frame` 或 `.eh_frame` 段来展开调用栈，不需要帧指针，但**开销更大**（每次展开需要解析 DWARF 信息），且需要 dwarf 展开支持：

```bash
# 使用 DWARF 展开调用栈（需要 --call-graph dwarf）
perf record -F 999 --call-graph dwarf -p 1234 -- sleep 30
```

**方式 3：LBR（Last Branch Record）**

Intel CPU 专有功能，硬件直接记录最近 16/32 次函数调用（不需要软件展开），开销极低，但调用栈深度有限（只能看到最近 16 层）：

```bash
# LBR 模式（Intel CPU only，深度约 16 层）
perf record -F 999 --call-graph lbr -p 1234 -- sleep 30
```

**生产推荐**：对大多数服务（Java/Go/Rust），用 `--call-graph dwarf`；对 C/C++ 服务（重新编译时加 `-fno-omit-frame-pointer`），用默认帧指针模式；对延迟极敏感的场景，用 LBR。

---

## 第 2 章 perf record 的核心参数

### 2.1 采集目标的四种模式

```bash
# 模式 1：针对特定进程（最常用）
perf record -F 999 -g -p <PID> -- sleep 30
#                  ↑ -g 表示记录调用栈（call graph）

# 模式 2：针对整个系统（-a，需要 root）
perf record -F 999 -ag -- sleep 30
# 捕获所有 CPU 上的所有进程，适合定位"CPU 忙在哪里"的全局问题

# 模式 3：针对特定命令（直接启动并 profile）
perf record -F 999 -g -- ./my_program arg1 arg2
# 从程序启动开始 profile，直到程序结束

# 模式 4：针对特定 CPU 核（-C）
perf record -F 999 -g -C 0,1,2,3 -- sleep 30
# 只采集 CPU 0-3 上的活动，用于多核分析
```

### 2.2 事件类型的选择

`perf record` 默认采集 CPU 时钟（`cycles`）事件——即"CPU 在哪里花时间"。但也可以针对特定硬件事件采集，以找到特定类型的瓶颈：

```bash
# 默认：CPU cycles（找 CPU 时间热点）
perf record -F 999 -g -p 1234 -- sleep 30

# L3 Cache Miss 采样（找内存访问热点）
perf record -e LLC-load-misses -g -p 1234 -- sleep 30
# 每次 LLC miss 记录一次调用栈 → 告诉你"哪段代码导致了 LLC miss"

# 分支预测失误采样（找分支密集的热点）
perf record -e branch-misses -g -p 1234 -- sleep 30

# 页错误采样（找内存分配热点）
perf record -e page-faults -g -p 1234 -- sleep 30

# 系统调用采样（找系统调用密集的热点）
perf record -e 'syscalls:sys_enter_*' -g -p 1234 -- sleep 30

# 软件事件：上下文切换（找调度频繁的代码路径）
perf record -e context-switches -g -p 1234 -- sleep 30
```

### 2.3 perf record 的输出文件

`perf record` 默认将采样数据写入 `perf.data` 文件（当前目录）：

```bash
# 自定义输出文件
perf record -F 999 -g -p 1234 -o /tmp/my_profile.data -- sleep 30

# 查看文件大小（高频采样 + 深调用栈会快速增大）
ls -lh perf.data
# -rw------- 1 root root 245M perf.data

# 采样时设置 ring buffer 大小（防止内存占用过大）
perf record -F 999 -g -m 512 -p 1234 -- sleep 30
#                          ↑ 512 页（2MB）的 ring buffer
```

---

## 第 3 章 perf report：理解树状输出

### 3.1 perf report 的基本用法

```bash
# 交互式查看（最常用）
perf report

# 非交互式（适合脚本/CI）
perf report --stdio | head -50

# 按函数符号排序（默认）：找 CPU 时间最多的函数
perf report --sort=sym

# 按调用者排序（找谁调用了热点函数）
perf report --sort=caller

# 只看用户态代码（过滤内核函数）
perf report --kallsyms=/dev/null
```

### 3.2 理解 perf report 的输出格式

```
# perf report --stdio 输出示例：

# Overhead  Command  Shared Object      Symbol
# --------  -------  -----------------  -----------------------
#   23.45%  java     [JIT] tid 1234     L io.netty.channel.AbstractChannel::flush
#   15.32%  java     libc-2.31.so       [.] malloc
#   12.18%  java     [kernel.kallsyms]  [k] tcp_sendmsg
#    8.91%  java     [JIT] tid 1234     L java.util.HashMap::get
#    6.45%  nginx    nginx              [.] ngx_http_process_request
#    5.23%  nginx    [kernel.kallsyms]  [k] __memcpy
#
# Overhead：该函数及其被调用的函数占用的 CPU 时间百分比
# Command：进程名
# Shared Object：函数所在的库/模块
#   [JIT]：JIT 编译的代码（Java/JS）
#   [kernel.kallsyms]：内核函数
#   libXXX.so：动态库函数
#   程序名：程序自身的函数
# Symbol 中的标记：
#   [k]：内核态函数
#   [.]：用户态函数
#   [j]：JIT 编译函数
```

**问题**：`perf report` 的调用树在函数调用链复杂时难以阅读——需要展开每个节点才能看到调用关系，而一个真实的 Java 应用可能有数百个函数各占 1-5%，无法快速找到"哪条调用链导致了大部分的 CPU 消耗"。这就是火焰图的价值所在。

---

## 第 4 章 火焰图：让热点一眼可见

### 4.1 火焰图的原理

**火焰图（Flame Graph）** 由 Brendan Gregg 于 2011 年发明，核心思想是：

> 将所有采样的调用栈堆叠显示，每个函数以矩形表示，**矩形的宽度正比于该函数（包括其子调用）出现在调用栈中的次数**（即 CPU 时间比例）。

```
火焰图阅读规则：

 ┌──────────────────────────────────────────────────────┐
 │  最宽的矩形 = CPU 时间最多的调用链顶端（关注这里！）   │
 │                                                       │
 │    ┌──────┐     ┌──┐  ┌─────────────────────────┐    │
 │    │func_C│     │  │  │      func_G             │ ←热│
 │    ├──────┤     │E │  ├─────────────────────────┤    │
 │    │func_B│     │  │  │         func_F           │    │
 │    ├──────────────────┴─────────────────────────┤    │
 │    │               func_A                        │    │
 │    ├─────────────────────────────────────────────┤    │
 │    │                  main                       │    │
 └────┴─────────────────────────────────────────────┴───┘
                      CPU 时间 →

 func_G 是最宽的"高原"顶部 → 是真正的 CPU 热点
 func_A 宽但有子调用 → 本身不是热点，是热点的路径
 "平顶"（plateau）= 没有更高的调用 = CPU 直接执行此函数 = 真正的热点
```

**火焰图的阅读技巧**：
- **关注"平顶"宽矩形**——顶部没有子调用的宽矩形，是真正消耗 CPU 时间的代码
- **从底部追溯根源**——找到热点函数后，向下追溯调用链，找到应用代码在哪里触发了这条路径
- **忽略窄矩形**——宽度 < 1% 的矩形通常不是优化目标
- **注意颜色**（标准 flamegraph.pl 配色）：红/橙色 = 用户态代码，蓝色 = 内核态代码，绿色 = JIT 代码

### 4.2 生成火焰图的完整工作流

```bash
# 步骤 1：采集数据（-g 必须，-F 999 足够精确，-a 全系统）
perf record -F 999 -ag -- sleep 30
# → 生成 perf.data

# 步骤 2：导出为文本格式
perf script > out.perf
# out.perf 包含每个采样点的调用栈（纯文本）

# 步骤 3：下载 FlameGraph 工具集（Brendan Gregg GitHub）
git clone https://github.com/brendangregg/FlameGraph
cd FlameGraph

# 步骤 4：折叠调用栈（将相同路径的采样计数聚合）
./stackcollapse-perf.pl ../out.perf > out.folded

# 步骤 5：生成 SVG 火焰图
./flamegraph.pl out.folded > flame.svg

# 步骤 6：用浏览器打开（支持交互：点击放大、搜索、鼠标悬停显示百分比）
open flame.svg  # macOS
# 或传到本地：scp user@server:/path/flame.svg .
```

**一行命令版本**：

```bash
perf record -F 999 -ag -- sleep 30 && \
perf script | /path/to/FlameGraph/stackcollapse-perf.pl | \
/path/to/FlameGraph/flamegraph.pl > flame.svg
```

### 4.3 针对不同语言的火焰图生成

**Java 应用的挑战**：JVM 的 JIT 编译器默认不保留帧指针，且 JIT 编译的符号不出现在标准 perf 符号表中，导致火焰图中大量显示 `[unknown]`。

```bash
# Java 火焰图正确姿势（async-profiler 是最佳选择）
# async-profiler 不依赖 perf，直接用 JVM 内部 API 采样
wget https://github.com/async-profiler/async-profiler/releases/download/v3.0/async-profiler-3.0-linux-x64.tar.gz
tar -xzf async-profiler*.tar.gz

# CPU 采样 30 秒，生成 HTML 火焰图
./asprof -d 30 -f /tmp/flame.html <java_pid>
# → 生成交互式 HTML 火焰图（Flamegraph.js，比 SVG 更好）

# 如果坚持用 perf（需要以下 JVM 参数）：
java -XX:+PreserveFramePointer \
     -XX:+UnlockDiagnosticVMOptions \
     -XX:+DebugNonSafepoints \
     -jar app.jar
# 同时在 JVM 启动后创建符号映射文件
perf-map-agent/bin/create-java-perf-map.sh <pid>
# → 生成 /tmp/perf-<pid>.map，perf 用它解析 JIT 符号
```

**Go 应用**：

```bash
# Go 原生支持 pprof，最方便
import _ "net/http/pprof"
go func() { http.ListenAndServe(":6060", nil) }()

# 远程采集 30 秒 CPU 样本
curl -o cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30

# 生成火焰图
go tool pprof -http :8080 cpu.prof
# → 在浏览器中打开 http://localhost:8080/ui/flamegraph

# 或用 pprof + FlameGraph
go tool pprof -raw -output cpu.txt cpu.prof
# 转换为 FlameGraph 格式...（需要额外脚本）
```

**Rust/C++ 应用**：

```bash
# 标准 perf 工作流即可，但编译时需保留帧指针
cargo build --release  # 默认省略帧指针！
# 在 Cargo.toml 中设置：
# [profile.release]
# debug = true           # 保留调试符号（函数名）
# [profile.release.build-override]
# opt-level = 3
# 或通过环境变量：
RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release
```

---

## 第 5 章 典型场景的 perf 使用策略

### 5.1 场景 1：定位用户态 CPU 热点（纯应用性能）

**症状**：服务 CPU 利用率 80%+，但系统调用比例低，主要是用户态计算。

```bash
# 1. 采集目标进程的 CPU 样本（只看用户态）
perf record -F 999 -g --user-regs=all -p <pid> -- sleep 60

# 2. 生成火焰图，重点看用户态函数
perf script | FlameGraph/stackcollapse-perf.pl | \
    grep -v "kernel\." | \
    FlameGraph/flamegraph.pl --title "User CPU Profile" > user_flame.svg

# 3. 确认用户态 vs 内核态的 CPU 时间比例
perf report --stdio | grep -E "^\s+[0-9]+\.[0-9]+%.*\[k\]" | head -10
# 若内核态函数（[k]）占比 < 5%，说明瓶颈主要在应用代码
```

**典型热点及优化方向**：

| 热点函数 | 可能原因 | 优化方向 |
|---------|---------|---------|
| `malloc`/`free` | 频繁小对象分配/释放 | 对象池、内存池、`jemalloc`/`tcmalloc` |
| `memcpy`/`memset` | 大量数据复制 | 零拷贝、减少不必要的数据复制 |
| `std::map::find` | 红黑树查找（O(log n)）| 改用 `unordered_map`（O(1)）|
| `pthread_mutex_lock` | 锁竞争 | 减少临界区、无锁数据结构、分片锁 |
| JSON 解析函数 | 高频 JSON 序列化/反序列化 | 换更快的 JSON 库（simdjson、rapidjson）|

### 5.2 场景 2：定位内核态 CPU 热点

**症状**：`top` 中 `%sy`（系统态）占比高（> 20%），说明 CPU 大量时间花在内核代码。

```bash
# 全系统采集（包含内核符号）
perf record -F 999 -ag -- sleep 30

# 只看内核函数
perf report --stdio | grep "\[k\]" | head -20
#   12.3%  nginx  [kernel.kallsyms]  [k] nf_hook_slow     ← iptables 规则遍历
#    8.5%  nginx  [kernel.kallsyms]  [k] tcp_sendmsg
#    6.2%  java   [kernel.kallsyms]  [k] sys_futex         ← 锁系统调用
#    5.8%  nginx  [kernel.kallsyms]  [k] __copy_to_user

# 分析 nf_hook_slow 热点（iptables 遍历）
perf report --stdio --symbol-filter=nf_hook_slow
```

**常见内核热点及含义**：

| 内核函数 | 含义 | 解决方向 |
|---------|------|---------|
| `nf_hook_slow` | Netfilter 钩子（iptables 规则遍历）| 减少规则、迁移 Cilium/eBPF |
| `__copy_to_user`/`__copy_from_user` | 内核-用户数据拷贝 | 零拷贝技术（sendfile/mmap）|
| `tcp_sendmsg`/`tcp_rcv_established` | TCP 收发处理 | 网络调优、批量发送 |
| `ksoftirqd` | 软中断处理（NAPI）| 增大 netdev_budget，多队列网卡 |
| `sys_futex` | 用户态锁的内核路径 | 减少锁竞争，改用无锁算法 |
| `page_fault` | 页错误（内存分配）| 预分配、HugePage |
| `schedule` | 上下文切换 | 减少系统调用，减少锁争用 |

### 5.3 场景 3：多线程锁竞争分析

**症状**：程序有多个线程，CPU 利用率低于核心数量（例如 8 核但只用了 200%），怀疑锁竞争。

```bash
# 1. 先看 mutex/futex 的 perf 计数
perf stat -e 'syscalls:sys_enter_futex' -p <pid> sleep 10
# 若每秒 futex 调用 > 1 万次，可能有激烈的锁竞争

# 2. 采集上下文切换事件（锁竞争会导致频繁上下文切换）
perf record -e context-switches -ag -- sleep 10
perf report | head -20
# 频繁切换的线程 → 可能在等锁

# 3. 用 bpftrace 直接追踪锁等待时间（更精确）
bpftrace -e '
tracepoint:syscalls:sys_enter_futex / args->op == 128 / {
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_futex
/@start[tid]/ {
    $lat = nsecs - @start[tid];
    if ($lat > 1000000) {  /* > 1ms */
        printf("LOCK WAIT %dms: pid=%d tid=%d\n",
               $lat/1000000, pid, tid);
    }
    delete(@start[tid]);
}'
```

### 5.4 场景 4：短命进程的性能分析

**症状**：批处理任务（如 `grep`、`sort`、编译任务）每次运行时间只有几秒甚至几百毫秒，常规 `perf record` 采样时间不够。

```bash
# 方法 1：直接 perf record 跟随进程
perf record -F 9999 -g -- /path/to/short_process arg1 arg2
# -F 9999：更高采样频率，在短时间内获得更多样本

# 方法 2：用 perf stat 获取硬件计数器总量（比采样更精确）
perf stat -e cycles,instructions,cache-misses,branch-misses \
    -- /path/to/short_process arg1 arg2
# 即使只运行 100ms，perf stat 也能给出精确的硬件事件总量

# 方法 3：循环执行多次，合并数据
for i in {1..10}; do
    perf record -F 999 -g -o /tmp/perf_$i.data -- ./short_process
done
# 合并所有采集数据
perf script -i /tmp/perf_1.data > combined.perf
for i in {2..10}; do
    perf script -i /tmp/perf_$i.data >> combined.perf
done
# 生成合并后的火焰图
cat combined.perf | FlameGraph/stackcollapse-perf.pl | \
    FlameGraph/flamegraph.pl > merged_flame.svg
```

---

## 第 6 章 差分火焰图：量化优化效果

### 6.1 差分火焰图的价值

单张火焰图只能告诉你"现在哪里慢"，无法回答"优化之后变快了多少"。**差分火焰图（Differential Flame Graph）** 比较两次 profiling 结果，用**颜色深浅**表示变化幅度：

- **红色越深**：该函数/路径在优化后 CPU 时间增加（变慢了）
- **蓝色越深**：该函数/路径在优化后 CPU 时间减少（变快了）
- **白色**：无变化

```bash
# 采集优化前的样本
perf record -F 999 -ag -o before.data -- sleep 30
perf script -i before.data | FlameGraph/stackcollapse-perf.pl > before.folded

# 做优化（修改代码/配置/参数）

# 采集优化后的样本
perf record -F 999 -ag -o after.data -- sleep 30
perf script -i after.data | FlameGraph/stackcollapse-perf.pl > after.folded

# 生成差分火焰图
FlameGraph/difffolded.pl before.folded after.folded | \
    FlameGraph/flamegraph.pl --negate > diff_flame.svg
# --negate：用蓝色标记减少（更直观：蓝=变好，红=变坏）
```

---

## 小结

perf 的核心价值是以**极低的运行时开销（< 1% CPU）将 CPU 时间与具体函数调用栈精确关联**——这在过去只能通过侵入式的代码插桩（instrument）实现，而 perf 通过 PMU 硬件采样完全做到了无侵入。

**工作流总结**：
1. `perf stat`：快速获取 CPU 级别的硬件计数器总量（IPC、cache miss 率）——30 秒定性判断
2. `perf record -F 999 -ag`：采集全系统调用栈样本——30-60 秒的数据足够定位大部分热点
3. `perf script | stackcollapse | flamegraph.pl`：生成火焰图——找"平顶宽矩形"
4. 差分火焰图：量化优化效果，验证改动的影响范围

**火焰图中"平顶宽矩形"就是真正的 CPU 热点**——没有子调用的宽函数，说明 CPU 在此直接执行，是优化的首要目标。调用链上的宽函数（有子调用的）只是路径，需要继续向上追踪到真正的执行叶节点。

下一篇 [[02 CPU 微架构优化——Cache Miss、分支预测与 SIMD]] 将深入到比函数调用更底层的层次：即使你的函数代码正确，CPU 仍然可能因为 cache line 对齐、分支预测失效、NUMA 远端内存访问等微架构问题而大幅低于理论性能——这些问题在 perf 的函数级火焰图中通常显示为"某函数 IPC 很低，但找不到原因"，需要硬件计数器层面的分析。

---

> [!note] 思考题
> 1. `perf record -g` 默认使用 Frame Pointer 回溯调用栈，但 GCC 的 `-fomit-frame-pointer` 会破坏调用链导致 `[unknown]`。DWARF 和 LBR 两种替代方案的性能开销和准确度有什么差异？在 Java 应用中，`-XX:+PreserveFramePointer` 会带来多大的运行时开销？
> 2. 火焰图中函数占 30% 宽度，但可能是 on-CPU 时间或 off-CPU 时间。标准 CPU 火焰图只显示 on-CPU。如果看到 `read()` 系统调用占大比例，真正瓶颈是 IO 而非 CPU。你需要 off-CPU 火焰图来定位——`bcc` 的 `offcputime` 和 `perf` 的 `sched:sched_switch` 跟踪点各有什么优势？
> 3. 在生产环境中 `perf record` 的采样开销通常在 1%-3%。高采样频率（999Hz）会增加开销但提高精度。在什么场景下需要高采样频率？能否用 `perf record -p <pid>` 只采样特定进程来降低全局开销？`-F 99` vs `-F 999` 在短期采样（10秒）中的数据量差异有多大？
