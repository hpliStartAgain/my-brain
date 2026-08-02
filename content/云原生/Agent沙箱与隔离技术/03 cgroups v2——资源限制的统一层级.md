---
title: "cgroups v2——资源限制的统一层级"
date: 2026-08-01
tags: [Agent Sandbox, cgroup v2, cgroups, Container, Kubernetes, Linux, PSI, Pressure Stall Information, 资源限制, 统一层级]
aliases: [cgroups v2, cgroup v2, 资源限制统一层级, PSI, Pressure Stall Information]
---

# 03 cgroups v2——资源限制的统一层级

> [!abstract] 摘要
> [[02 Linux namespaces——资源隔离的基石|上一篇]]深入了 namespace——容器隔离的"视图隔离"层，并指出"namespace 不限制资源使用量"。本文深入容器隔离的第二层——cgroups。cgroups 解决"进程能用多少资源"的问题——CPU 时间、内存容量、I/O 带宽、设备访问。文章从 cgroups v1 的三大设计缺陷出发（多层级导致的复杂性、控制器行为不一致、嵌套困难），系统剖析 cgroups v2 的根本性改进——单一统一层级结构、控制器按需启用、层级化资源分配；深入 cgroups v2 的核心概念（cgroup2 文件系统、cgroup.controllers/cgroup.subtree_control 控制器启用机制、内部进程禁用规则）；然后拆解 PSI（Pressure Stall Information）——cgroups v2 原生支持的资源压力监控机制，它如何通过"some"和"full"两个维度量化 CPU/内存/I/O 压力，以及 systemd 和 Kubernetes 如何利用 PSI 做主动资源管理；最后讨论 cgroups v1→v2 的迁移现状——systemd v258 完全移除 v1 支持、Kubernetes 1.35 是最后支持 v1 的版本、内核 7.17 计划完全移除 v1 代码——以及这对 Agent 沙箱的影响。核心认知：cgroups v2 的统一层级不只是"简化了 API"——它让资源限制从"每个控制器各自为政"变成"统一的资源分配树"，这是 Kubernetes 和 Agent 沙箱做精细资源管理的基础。

---

## 第 1 章 cgroups v1 的三大设计缺陷

### 1.1 cgroups 的起源

cgroups（control groups）最初由 Google 工程师 Paul Menage 在 2006 年开发，2007 年合入 Linux 2.6.24（2008 年发布）。它的设计目标极其明确——**限制和隔离进程组的资源使用**。如果说 namespace 解决"进程能看到什么"，cgroups 解决"进程能用多少"。

### 1.2 v1 的核心设计：多独立层级

cgroups v1 的核心设计是**多个独立的层级（hierarchy）**——每种资源控制器（CPU、memory、I/O 等）可以挂载为独立的 cgroup 文件系统，有自己独立的 cgroup 树。

```
/sys/fs/cgroup/cpu/          ← CPU 控制器的层级
├── container_a/             ← 容器A的CPU限制
└── container_b/             ← 容器B的CPU限制

/sys/fs/cgroup/memory/       ← 内存控制器的层级（完全独立于CPU层级）
├── container_a/             ← 容器A的内存限制
└── container_b/             ← 容器B的内存限制

/sys/fs/cgroup/blkio/        ← I/O控制器的层级（又一个独立树）
├── container_a/
└── container_b/
```

这意味着**一个进程可以同时在不同的 cgroup 中**——在 CPU 层级中属于 `container_a`，在 memory 层级中属于 `container_b`。这种"灵活性"在实践中几乎没人用到，但它的复杂性却由所有人承担。

### 1.3 缺陷一：配置复杂

多层级意味着多挂载点、多配置文件、多种出错方式。如果你尝试在 v1 系统上调试 cgroup 问题，你需要追踪"这个进程在 CPU 层级中属于哪个 cgroup？在 memory 层级中又属于哪个？"——两个答案可能完全不同。这种"进程的 cgroup 归属因控制器而异"的设计让调试和审计极其困难。

### 1.4 缺陷二：控制器行为不一致

不同控制器独立演进，导致接口和行为不一致——CPU 控制器的工作方式与 memory 控制器不同，memory 控制器又与 I/O 控制器不同。开发者需要学习每种控制器的独特接口，增加了学习成本和出错概率。

### 1.5 缺陷三：嵌套困难

v1 的多层级设计让"嵌套 cgroup"（如容器内再运行容器）极其困难——因为每一层需要自己的层级，但 v1 的层级是全局的，不是按 cgroup 分的。Docker-in-Docker 在 cgroups v1 上需要特殊的"特权"配置才能工作——因为内层容器需要创建自己的 cgroup，但外层容器的 cgroup 限制可能阻止它这样做。

> [!warning] 生产避坑：cgroups v1 的迁移倒计时
> cgroups v1 正在被系统性移除——以下是关键时间节点：systemd v256（2024-06）默认禁用 cgroup v1；systemd v258（2025-09）完全移除 cgroup v1 支持；Kubernetes 1.31 将 cgroup v1 支持移入维护模式；Kubernetes 1.35 是最后支持 v1 的版本；所有主流云 K8s 服务（GKE/EKS/AKS）在新节点镜像上默认使用 cgroup v2；内核 7.17（计划 2029 年初）完全移除 cgroup v1 代码。如果你还在运行 cgroup v1 的系统，现在是规划迁移的最后窗口期。对于 Agent 沙箱——新建设的沙箱基础设施应该直接使用 cgroup v2，不要在 v1 上投入新的工程努力。

---

## 第 2 章 cgroups v2 的根本性改进

### 2.1 单一统一层级

cgroups v2 的核心改进是**只有一个层级**——所有控制器挂载在同一棵 cgroup 树上。进程在树中的位置唯一确定它受哪些控制器约束——不再有"在 CPU 层级属于 A、在 memory 层级属于 B"的混乱。

```
/sys/fs/cgroup/              ← 唯一的 cgroup2 文件系统
├── cgroup.controllers       ← 可用的控制器列表
├── cgroup.subtree_control   ← 启用的子树控制器
├── container_a/
│   ├── cpu.max              ← CPU 限制
│   ├── memory.max           ← 内存限制
│   ├── io.max               ← I/O 限制
│   └── cgroup.subtree_control  ← 子cgroup启用的控制器
└── container_b/
    ├── cpu.max
    ├── memory.max
    └── io.max
```

**为什么这是根本性改进**：
- 进程的 cgroup 归属唯一确定——不再"因控制器而异"
- 所有控制器的接口统一在同一个目录下——`cpu.max`、`memory.max`、`io.max` 都在同一个 cgroup 目录中
- 嵌套自然支持——子 cgroup 继承父 cgroup 的限制，且可以进一步收紧

### 2.2 控制器按需启用

cgroups v2 不像 v1 那样让所有控制器始终活跃——它采用**按需启用**机制：

- `cgroup.controllers`（只读）：列出当前 cgroup 可用的控制器
- `cgroup.subtree_control`（读写）：启用/禁用子 cgroup 的控制器

```bash
# 查看根 cgroup 可用的控制器
cat /sys/fs/cgroup/cgroup.controllers
# 输出: cpu io memory pids ...

# 在根 cgroup 启用 cpu 和 memory 控制器（对子cgroup生效）
echo "+cpu +memory" > /sys/fs/cgroup/cgroup.subtree_control

# 创建子 cgroup
mkdir /sys/fs/cgroup/agent_sandbox

# 在子 cgroup 中，cpu 和 memory 控制器已启用
# 设置 CPU 限制（2 个 CPU 核）
echo "200000 100000" > /sys/fs/cgroup/agent_sandbox/cpu.max
# 设置内存限制（512MB）
echo "536870912" > /sys/fs/cgroup/agent_sandbox/memory.max
```

这种"按需启用"机制让 cgroup 树的每一层可以精确控制"子树启用哪些控制器"——根 cgroup 可以启用所有控制器，但某个子 cgroup 可以只为它的子树启用 cpu 和 memory（不启用 io），实现精细化的资源管理。

### 2.3 层级化资源分配

cgroups v2 的所有控制器行为都是**层级化的**——如果一个控制器在某个 cgroup 上启用，它影响该 cgroup 的整个子树（包括所有后代 cgroup）。子 cgroup 的限制是父 cgroup 限制的**进一步收紧**，不能超越父 cgroup 的限制。

```
/sys/fs/cgroup/
├── cpu.max = "max"          ← 根：不限制
├── agent_pool/
│   ├── cpu.max = "400000 100000"  ← 限制为 4 核
│   ├── agent_1/
│   │   └── cpu.max = "200000 100000"  ← 限制为 2 核（不能超过父级的 4 核）
│   └── agent_2/
│       └── cpu.max = "200000 100000"  ← 限制为 2 核
```

这种层级化设计天然支持"资源池"模式——父 cgroup 分配一个总资源池（如 4 核 CPU），子 cgroup 在池内分配（如 agent_1 和 agent_2 各 2 核）。如果 agent_1 和 agent_2 各自的限制之和超过父级（如各 3 核，和为 6 核，超过父级的 4 核），它们会竞争父级分配的资源——不会被硬性拒绝，但实际可用资源受父级限制约束。

> [!info] 核心概念：统一层级是"资源分配树"而非"控制器列表"
> cgroups v2 的统一层级把资源管理从"每个控制器各自为政"变成了"一棵统一的资源分配树"。这棵树的每个节点可以分配 CPU、内存、I/O 等多种资源——资源限制在树上层层传递，父节点约束子节点。这种设计让复杂的资源分配场景（如"给 Agent 池分配 16 核 64GB，池内的 8 个 Agent 各分 2 核 8GB"）可以用一棵树自然表达——不需要在多个独立的控制器层级中分别配置。这是 Kubernetes 做精细资源管理（如 Guaranteed/Burstable/BestEffort QoS 类）的基础——K8s 的 QoS 机制在 cgroup v2 上比 v1 上更简洁、更可靠。

### 2.4 内部进程禁用规则

cgroups v2 有一个 v1 没有的重要规则——**除根 cgroup 外，进程只能驻留在叶子 cgroup（不包含子 cgroup 的 cgroup）中**。这意味着一个 cgroup 要么包含进程，要么包含子 cgroup，不能两者都有。

这个规则的设计目的是避免歧义——在 v1 中，一个 cgroup 可以既包含进程又包含子 cgroup，导致"父 cgroup 的资源限制是只约束直接子进程，还是也约束子 cgroup 中的进程？"的歧义。v2 通过"进程只在叶子"消除了这种歧义——中间 cgroup 只做资源分配（约束子树），不做进程驻留。

---

## 第 3 章 cgroups v2 的核心控制器

### 3.1 CPU 控制器

**`cpu.max`**：设置 CPU 时间限制。格式为"$MAX $PERIOD"——在每 $PERIOD 微秒内，最多使用 $MAX 微秒 CPU 时间。如 `200000 100000` 表示每 100ms 内最多用 200ms CPU 时间——等价于 2 个完整 CPU 核。

**`cpu.weight`**：设置 CPU 权重（1-10000），用于在兄弟 cgroup 间按权重分配空闲 CPU 时间。如 agent_1 权重 100、agent_2 权重 200——空闲 CPU 时间按 1:2 分配。

**`cpu.pressure`**：CPU 压力信息（PSI）——第 4 节详述。

### 3.2 Memory 控制器

cgroups v2 的 memory 控制器相比 v1 有一个重要改进——**统一内存统计**。v1 中，网络内存、内核内存、用户内存分别统计，配置复杂。v2 把所有类型的内存统一为一个 `memory.current` 和一个 `memory.max`。

**`memory.max`**：硬限制——超过触发 OOM（Out of Memory）kill。

**`memory.high`**：软限制——超过触发内存回收和节流（backpressure），但不立即 OOM。这是 cgroups v2 独有的——它让"接近内存限制"时系统通过回收内存来减压，而非直接杀死进程。

**`memory.current`**：当前内存使用量。

**`memory.events`**：内存事件计数器——包括 `low`（低于 memory.low）、`high`（超过 memory.high）、`max`（超过 memory.max）、`oom`（OOM kill 发生）等。

> [!warning] 生产避坑：memory.high 的"静默节流"陷阱
> cgroups v2 的 `memory.high` 会在超过时触发内存回收和节流——但这个过程是"静默"的，进程不会收到任何错误信号，只是变慢。这可能导致难以诊断的延迟问题——应用的 p99 延迟突然升高，但 CPU 使用率正常、内存没有 OOM、日志没有错误——实际上是 `memory.high` 在节流。诊断方法：检查 `memory.events` 中的 `high` 计数器是否在增长——如果增长，说明在触发 `memory.high` 节流。对于 Agent 沙箱，这意味着如果 Agent 的代码分配了大量内存，它可能被静默节流而非被 OOM kill——Agent 可能表现为"变慢了"而非"崩溃了"。

### 3.3 I/O 控制器

**`io.max`**：设置 I/O 速率限制。格式为"$MAJOR:$MINOR rbps=$RATE wbps=$RATE riops=$IOPS wiops=$IOPS"——按设备限制读写带宽和 IOPS。

**`io.weight`**：设置 I/O 权重——在兄弟 cgroup 间按权重分配 I/O 带宽。

**`io.pressure`**：I/O 压力信息（PSI）。

### 3.4 PIDs 控制器

**`pids.max`**：限制 cgroup 内的最大进程数。这对 Agent 沙箱极其重要——防止 Agent 执行的代码通过 fork bomb（`while(true) fork()`）耗尽系统的 PID 空间。

---

## 第 4 章 PSI——Pressure Stall Information

### 4.1 PSI 解决什么问题

在 PSI 出现之前，Linux 缺乏一种"量化资源压力"的标准方法。你可以看到 CPU 使用率是 90%、内存使用率是 80%——但这些数字不告诉你"进程因为资源不足而等待了多久"。CPU 90% 可能是"正在高效计算"（无压力），也可能是"在等待 I/O 时被调度器频繁切换"（有压力）。

PSI（Pressure Stall Information，Linux 4.20+，cgroup v2 原生支持）解决了这个问题——它**量化和报告进程因资源争用而停滞的时间**。

### 4.2 两种压力维度

PSI 对每种资源（CPU/memory/I/O）提供两种压力度量：

**"some"（部分停滞）**：至少一个任务在等待资源。这种状态下，部分任务在等待，但其他任务可能仍在做有用的工作——系统有压力但仍在进步。

**"full"（完全停滞）**：所有非空闲任务都在等待资源——没有任何任务在做有用的工作。这是最严重的压力状态——CPU 周期在浪费，系统在"抖动"（thrashing）。

```
# /proc/pressure/cpu 示例
some avg10=2.04 avg60=0.75 avg300=0.40 total=157656722

# /proc/pressure/memory 示例
some avg10=70.24 avg60=68.52 avg300=69.91 total=3559632828
full avg10=57.59 avg60=58.06 avg300=60.38 total=3300487258
```

**`avg10/avg60/avg300`**：10 秒/60 秒/300 秒移动平均的停滞时间占比（百分比）。

**`total`**：累计停滞时间（微秒）——用于检测"太短而不足以影响平均值"的延迟尖峰。

### 4.3 PSI 在 cgroup v2 中

在 cgroup v2 中，每个 cgroup 有自己的 PSI 文件——`cpu.pressure`、`memory.pressure`、`io.pressure`。这些文件报告**该 cgroup 内**的压力，而非系统全局的。

这让 Agent 沙箱可以监控"自己的资源压力"——如果 Agent 的 `memory.pressure` 的 `full` 值持续高，说明 Agent 在"抖动"——可能需要增加内存限制或优化代码。

### 4.4 PSI 的三种资源详解

**CPU 压力（cpu.pressure）**：当任务在运行队列中等待 CPU 时间时产生压力。`some` 表示"至少一个任务在等 CPU"——这通常意味着 CPU 被超分配，但系统仍在做有用的工作（其他任务在运行）。CPU 压力没有 `full` 维度——因为如果所有任务都在等 CPU，那 CPU 就是空闲的（矛盾）。

**内存压力（memory.pressure）**：当任务因内存不足而等待时产生压力。等待来源包括：swap-in（从交换分区读回数据）、page cache refault（之前被回收的页面需要重新读入）、direct reclaim（内核直接回收内存而非等待后台回收）。`some` 表示"至少一个任务在等内存"——通常可以恢复；`full` 表示"所有任务都在等内存"——系统在严重抖动，可能即将 OOM。

**I/O 压力（io.pressure）**：当任务等待 I/O 操作完成时产生压力。`some` 表示"部分任务在等 I/O"——这在正常 I/O 操作中也会短暂出现；`full` 表示"所有任务都在等 I/O"——I/O 子系统严重饱和，系统在做无用的等待。

### 4.5 PSI 触发器——主动资源管理

PSI 不只是被动监控——它支持**注册触发器**，在压力超过阈值时唤醒用户空间进程：

```c
// 注册内存压力触发器：当 1 秒窗口内 "some" 停滞超过 150ms 时触发
int fd = open("/proc/pressure/memory", O_RDWR);
write(fd, "some 150000 1000000", ...);
// 然后用 poll()/select()/epoll 等待触发
poll(...);
```

**systemd 的 PSI 集成**：systemd 利用 PSI 触发器做主动资源管理——当检测到内存压力时，systemd 可以主动要求服务释放内存缓存；当检测到 CPU 压力时，可以降低服务的并行度。systemd 提供了 `MemoryPressureWatch=`、`CPUPressureWatch=`、`IOPressureWatch=` 配置项，以及 `sd_event_add_memory_pressure()` 等 API。

**Kubernetes 的 PSI 集成**：Kubernetes v1.36 起，`KubeletPSI` feature gate 锁定为 true（不可禁用）——kubelet 自动收集节点/Pod/容器级别的 PSI 指标，通过 Summary API 和 `/metrics/cadvisor` 端点暴露。这让 K8s 集群管理员可以看到每个 Pod 的资源压力——本专栏第 9 篇讨论的 GKE Agent Sandbox 可以利用这些指标做沙箱扩缩容决策。

> [!info] 核心概念：PSI 是"资源压力的可观测性"基础
> PSI 的核心价值不是"限制资源"（那是 cgroup 控制器的工作），而是"让资源压力可观测"——让你知道"进程在等什么、等了多久"。这对 Agent 沙箱的运维至关重要：当 Agent 响应变慢时，你需要知道是 CPU 压力、内存压力还是 I/O 压力导致的——PSI 给出了精确的答案。没有 PSI，你只能看到"CPU 使用率"和"内存使用量"，但无法区分"高使用率是高效计算还是资源争用"。PSI 把"资源压力"从"不可观测"变成了"可量化、可告警、可触发自动响应"。

---

## 第 5 章 cgroups v1→v2 迁移现状

### 5.1 迁移时间线

cgroups v2 的迁移正在系统性推进，以下是关键时间节点：

| 时间 | 事件 |
| :--- | :--- |
| 2016 | Linux 4.5 正式发布 cgroups v2 |
| 2024.06 | systemd v256 默认禁用 cgroup v1 |
| 2024 | Kubernetes 1.31 cgroup v1 支持移入维护模式 |
| 2025.09 | systemd v258 完全移除 cgroup v1 支持 |
| 2025 | 所有主流云 K8s（GKE/EKS/AKS）新节点默认 cgroup v2 |
| 2026 | Kubernetes 1.35 最后支持 cgroup v1 的版本 |
| 2026 | 内核 7.4 打印 cgroup v1 弃用警告 |
| 2027 | 内核 7.10 cgroup v1 默认不编译（需手动启用） |
| 2029 | 内核 7.17 完全移除 cgroup v1 代码 |

### 5.2 对 Agent 沙箱的影响

**新建设的 Agent 沙箱基础设施应该直接使用 cgroup v2**——不要在 v1 上投入新的工程努力。原因：

1. **v1 正在被移除**——2029 年内核将完全移除 v1 代码，在 v1 上构建的系统届时需要迁移
2. **v2 功能更全**——PSI、memory.high 软限制、统一内存统计等 v2 独有功能对 Agent 沙箱有实际价值
3. **生态已迁移**——所有主流容器运行时（runc/containerd/Docker）、K8s、云平台都已默认 v2

**需要检查的兼容性问题**：
- 如果 Agent 沙箱的容器镜像中有应用直接读取 cgroup 文件系统（如某些 JVM、监控 agent），需要确保它们支持 cgroup v2 的文件格式
- OpenJDK 需要 jdk8u372+ 或 11.0.16+ 才完全支持 cgroup v2——旧版 JDK 可能误读内存限制
- cAdvisor 需要 v0.43.0+ 才支持 cgroup v2

> [!warning] 生产避坑：JVM 在 cgroup v2 上的兼容性
> [[Java/JVM/02 运行时数据区——堆、栈、方法区的内存布局|JVM 内存管理]]依赖 cgroup 信息来确定堆内存上限（`-XX:MaxRAMPercentage` 基于 cgroup 的 memory.limit_in_bytes）。在 cgroup v1 上，JVM 读取 `/sys/fs/cgroup/memory/memory.limit_in_bytes`；在 cgroup v2 上，文件路径和格式变了（`/sys/fs/cgroup/memory.max`）。旧版 JDK（如 jdk8u371 及更早）可能无法正确读取 v2 的 cgroup 信息，导致 JVM 误认为可用内存远大于实际限制——进而触发 OOM 而非优雅降级。如果你的 Agent 沙箱运行 Java 应用，确保 JDK 版本支持 cgroup v2。

---

## 第 6 章 Agent 沙箱的 cgroups 实践

### 6.1 典型 Agent 沙箱的 cgroup 配置

一个典型的 Agent 沙箱需要设置以下 cgroup 限制：

```bash
# 创建 Agent 沙箱的 cgroup
mkdir /sys/fs/cgroup/agent_sandbox

# CPU 限制：1 核（在 100ms 周期内最多 100ms CPU 时间）
echo "100000 100000" > /sys/fs/cgroup/agent_sandbox/cpu.max

# 内存硬限制：512MB
echo "536870912" > /sys/fs/cgroup/agent_sandbox/memory.max

# 内存软限制：400MB（超过后开始节流回收，不立即 OOM）
echo "419430400" > /sys/fs/cgroup/agent_sandbox/memory.high

# PID 限制：最多 100 个进程（防止 fork bomb）
echo "100" > /sys/fs/cgroup/agent_sandbox/pids.max

# I/O 限制：读写各 50MB/s
echo "8:0 rbps=52428800 wbps=52428800" > /sys/fs/cgroup/agent_sandbox/io.max
```

### 6.2 资源限制的设计考量

**CPU 限制**：Agent 的代码执行通常不是 CPU 密集型——大部分时间在等 I/O（网络请求、文件读写）。1 核 CPU 通常够用。但如果 Agent 执行计算密集型代码（如 ML 推理），需要提高限制。

**内存限制**：Agent 沙箱的内存限制需要平衡"足够工作"和"防止耗尽宿主机"。512MB-2GB 是常见范围。设置 `memory.high` 为 `memory.max` 的 80%——让接近限制时有节流警告而非直接 OOM。

**PID 限制**：极其重要——fork bomb 是最简单的 DoS 攻击。100-500 个 PID 限制通常足够正常的 Agent 工作，但能防止 fork bomb。

**I/O 限制**：防止 Agent 的代码通过大量 I/O 影响宿主机性能。根据宿主机磁盘性能设置合理限制。

### 6.3 PSI 监控集成

Agent 沙箱应该监控 PSI 指标，在资源压力过高时采取行动：

- **memory.pressure "full" 持续高** → 可能需要增加内存限制或终止 Agent
- **cpu.pressure "some" 持续高** → Agent 在等 CPU，可能需要增加 CPU 限制
- **io.pressure "full" 持续高** → I/O 瓶颈，可能需要优化 I/O 模式或增加 I/O 限制

GKE Agent Sandbox 等生产级平台已经集成了 PSI 监控——通过 Kubernetes 的 PSI 指标暴露机制，集群管理员可以设置基于 PSI 的自动扩缩容和告警策略。

### 4.7 Agent 沙箱的 PSI 监控实践

对于自建的 Agent 沙箱平台，建议实施以下 PSI 监控策略：

**基线建立**：在正常负载下运行 Agent 沙箱一段时间，记录 `cpu.pressure`、`memory.pressure`、`io.pressure` 的 `some` 和 `full` 的 avg10/avg60/avg300 基线值。这些基线定义了"正常状态"——后续偏离基线的异常值是问题的信号。

**告警阈值**：基于基线设置告警——如 `memory.pressure` 的 `full` avg10 > 10% 持续 60 秒 → 内存压力告警。`cpu.pressure` 的 `some` avg60 > 50% 持续 5 分钟 → CPU 不足告警。

**自动响应**：通过 PSI 触发器实现自动响应——内存压力超过阈值时自动终止最不重要的 Agent 沙箱（释放内存）；CPU 压力超过阈值时自动降低低优先级沙箱的 CPU 限制（`cpu.idle=1`）。

**与 OOM 的区别**：PSI 在"接近资源限制但还没 OOM"时就能发出信号——比 OOM kill 更早。一个理想的 Agent 沙箱运维系统应该"在 OOM 之前就通过 PSI 检测到压力并采取行动"，而非"等 OOM 发生了才处理"。

---

## 第 7 章 cgroup v2 高级特性与生产案例

### 7.1 memory.oom.group——原子 OOM 杀组

cgroups v2 的 `memory.oom.group` 文件（设为 1 时）启用"组级 OOM"语义——当该 cgroup 中任何进程触发 OOM 时，cgroup 中的**所有进程**都会被杀死，而非只杀死触发 OOM 的单个进程。

**为什么需要**：在传统 OOM 行为中，内核只杀死"触发 OOM 的那个进程"。但在很多场景下，一个 cgroup 中的多个进程是协作关系——如一个 Agent 沙箱中的主进程和几个辅助进程。如果只杀死触发 OOM 的进程，辅助进程可能变成"孤儿"继续运行但无法正常工作——消耗资源却不做有用的事。

**Agent 沙箱的应用**：在 Agent 沙箱中启用 `memory.oom.group`，可以确保 OOM 时整个沙箱被干净地终止——所有进程一起退出，不会留下"半死不活"的孤儿进程。这与 Kubernetes 的 Pod 概念一致——Pod 中的容器应该一起生、一起死。

### 7.2 memory.swap.max——Swap 限制

cgroups v2 允许独立限制 swap 使用量——`memory.swap.max` 设置 cgroup 最多能使用多少 swap 空间。

**Agent 沙箱的意义**：对于 Agent 沙箱，通常应该**禁用 swap**（`echo 0 > memory.swap.max`）。原因有二：1）Swap 会让 Agent 的代码执行变得不可预测——当内存超限时，系统不是 OOM kill 而是开始用 swap，导致极慢的"抖动"状态；2）Swap 可能导致安全风险——Agent 的内存内容（可能包含敏感数据）被写入磁盘的 swap 分区，即使 Agent 终止后也可能被恢复。

### 7.3 cpu.idle——低优先级调度

cgroups v2 的 `cpu.idle` 文件（设为 1 时）将该 cgroup 标记为"低优先级"——调度器只在所有非 idle cgroup 都无任务可运行时，才调度 idle cgroup 的任务。

**Agent 沙箱的应用**：对于"非实时"的 Agent 任务（如批量代码分析、离线测试），可以设为低优先级——让它们"趁宿主机空闲时运行"，不影响其他高优先级工作负载。GKE Agent Sandbox 的"冷池"概念——suspended sandboxes 在宿主机空闲时恢复——与 `cpu.idle` 的设计哲学一致。

### 7.4 生产案例：GKE Agent Sandbox 的 cgroup 策略

GKE Agent Sandbox 在生产中使用了以下 cgroup v2 策略组合：

**分层资源分配**：
```
/sys/fs/cgroup/
├── agent-sandbox-pool/           ← 沙箱池（总资源限制）
│   ├── cpu.max = "host_cpus * 0.8"  ← 池最多用 80% CPU
│   ├── memory.max = "host_mem * 0.7" ← 池最多用 70% 内存
│   ├── sandbox-1/                ← 单个沙箱
│   │   ├── cpu.max = "1 core"
│   │   ├── memory.max = "512MB"
│   │   ├── memory.high = "400MB"
│   │   ├── pids.max = 100
│   │   └── memory.oom.group = 1
│   ├── sandbox-2/
│   └── ...
```

**PSI 驱动的自动扩缩容**：当沙箱池的 `memory.pressure` 的 `full` 值持续超过阈值时，自动扩容（增加节点或提高池的内存限制）；当 `cpu.pressure` 的 `some` 值持续低时，自动缩容（减少节点）。

**memory.high + Pod Snapshots 组合**：在创建 Pod Snapshot 前，检查 `memory.high` 是否在节流——如果在节流，等待节流解除后再做 snapshot（避免 snapshot 一个正在抖动的状态）。

### 7.5 生产案例：Agent 沙箱的 fork bomb 防御

一个真实的生产场景：Agent 被诱导执行了 fork bomb 代码 `while(true) fork()`——这是最简单的 DoS 攻击之一，任何能执行 shell 命令的 Agent 都可能被 Prompt Injection 诱导执行。

**没有 pids.max 的后果**：fork bomb 在几秒内创建数千进程，耗尽宿主机的 PID 空间（默认 32768 个 PID）——导致宿主机上无法创建新进程，包括无法 SSH 登录、无法运行修复命令——宿主机"活锁"。恢复这种状态通常需要硬重启——影响所有运行在该宿主机上的工作负载。在共享宿主机上（如 Kubernetes 节点），一个 Agent 的 fork bomb 可以让整个节点瘫痪。

**有 pids.max 的防御**：
```bash
# Agent 沙箱设置 pids.max = 100
echo 100 > /sys/fs/cgroup/agent_sandbox/pids.max
```
fork bomb 在创建 100 个进程后，第 101 次 `fork()` 返回 EAGAIN（资源暂时不可用）——fork bomb 无法继续。宿主机的 PID 空间不受影响，其他进程正常运行。

这个案例说明了 cgroup 资源限制的一个核心价值——**不仅是"限制正常使用的资源"，更是"防御异常使用的资源"**。Agent 执行的代码可能是 buggy 的、甚至是恶意的——cgroup 限制确保即使代码行为异常，影响也被限制在沙箱的 cgroup 范围内，不会扩散到宿主机。

---

## 第 8 章 总结与下一篇导读

### 7.1 本文核心要点

1. **cgroups v1 三大缺陷**：多独立层级导致配置复杂、控制器行为不一致、嵌套困难——这些问题在 v2 中被根本性解决
2. **v2 的核心改进是统一层级**：单一 cgroup2 文件系统，所有控制器挂载在同一棵树上，进程的 cgroup 归属唯一确定——把资源管理从"控制器各自为政"变成"统一的资源分配树"
3. **控制器按需启用**：`cgroup.subtree_control` 让 cgroup 树的每一层精确控制子树启用哪些控制器——精细化的资源管理
4. **层级化资源分配**：子 cgroup 的限制是父 cgroup 的进一步收紧，不能超越——天然支持"资源池"模式
5. **memory.high 软限制**：v2 独有——超过时不 OOM 而是节流回收——但可能导致"静默变慢"的诊断困难
6. **PSI 是资源压力的可观测性基础**：量化"进程因资源不足而等了多久"——区分"高效使用"和"资源争用"——systemd 和 K8s 都已集成
7. **v1 正在被系统性移除**：systemd v258 已移除 v1、K8s 1.35 是最后支持 v1 的版本、内核 7.17 计划完全移除 v1 代码——新 Agent 沙箱基础设施应直接用 v2

### 7.2 下一篇导读

本文深入了 cgroups——容器隔离的"资源限制"层。下一篇 [[04 seccomp 与 capabilities——系统调用过滤与权限分权]] 将深入容器隔离的第三层——seccomp（系统调用过滤）和 capabilities（权限分权）。seccomp-bpf 如何通过 BPF 程序过滤系统调用？seccomp notifier 如何让用户空间参与系统调用决策？Linux capabilities 的五种能力集合（Permitted/Effective/Inheritable/Ambient/Bounding）如何工作？为什么 CAP_SYS_ADMIN 仍被称为"新 root"？

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Agent 沙箱与隔离技术专栏]] 的第 3 篇。前 3 篇完成了 namespace（视图隔离）+ cgroups（资源限制）的讨论；接下来第 4 篇将完成 seccomp + capabilities（系统调用过滤+权限分权），构成"传统容器三重隔离"的完整图景。

---

## 参考文献

1. Linux Kernel. "Control Group v2." https://docs.kernel.org/admin-guide/cgroup-v2.html
2. Linux man pages. "cgroups(7)." https://man7.org/linux/man-pages/man7/cgroups.7.html
3. Kubernetes. "About cgroup v2." https://kubernetes.io/docs/concepts/architecture/cgroups/
4. Kubernetes. "Understand Pressure Stall Information (PSI) Metrics." https://kubernetes.io/docs/reference/instrumentation/understand-psi-metrics/
5. Linux Kernel. "PSI - Pressure Stall Information." https://docs.kernel.org/accounting/psi.html
6. LWN. "psi: pressure stall information for CPU, memory, and IO v2." https://lwn.net/Articles/759658/
7. systemd. "Resource Pressure Handling." https://systemd.io/PRESSURE/
8. "Cgroup v1: timeline and path to removal." https://www.spinics.net/lists/cgroups/msg53739.html
9. "Understanding cgroups: From v1 to v2 and Why It Matters for Kubernetes." https://diveinto.com/blog/cgroups-v1-to-v2
10. "Kubernetes p99 Spikes Without OOM: Diagnosing cgroup v2 memory.high with PSI." https://www.michal-drozd.com/en/blog/cgroup-v2-memory-high-psi-kubernetes/

---

## 思考题

1. **cgroups v2 的"内部进程禁用"规则要求进程只能驻留在叶子 cgroup 中。但 Docker 容器的入口进程（PID 1）需要在一个 cgroup 中运行——如果这个 cgroup 又有子 cgroup（如容器内用 cgroup 做进一步资源分配），就违反了规则。Docker/runc 如何解决这个矛盾？** 提示：考虑"中间 cgroup"——Docker 可以为容器创建一个"包装 cgroup"（不包含进程），在其下创建"进程 cgroup"（包含 PID 1）和"子资源 cgroup"——进程 cgroup 是叶子，子资源 cgroup 也是叶子。

2. **PSI 的 "some" 和 "full" 两个维度——什么场景下 "some" 很高但 "full" 很低？什么场景下两者都很高？** 提示：考虑"部分任务在等"vs"所有任务在等"——"some 高 full 低"意味着部分任务在等资源但其他任务仍在工作（如多线程程序中部分线程在等 I/O）；"some 和 full 都高"意味着所有任务都在等（如内存耗尽导致全局回收）。

3. **cgroups v2 的 memory.high 软限制会在超过时"静默节流"而非 OOM kill。对于 Agent 沙箱，这是好事还是坏事？** 提示：考虑两种视角——从"可用性"角度，节流比 OOM 更好（Agent 变慢但仍在运行）；从"可诊断性"角度，OOM 比节流更好（Agent 崩溃并产生明确的错误日志，开发者知道需要增加内存；节流则可能导致"Agent 变慢了但不知道为什么"）。Agent 沙箱应该如何选择 memory.high 和 memory.max 的关系？
