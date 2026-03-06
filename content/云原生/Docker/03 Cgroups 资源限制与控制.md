---
title: "03 Cgroups 资源限制与控制"
date: 2026-03-04
tags: [云原生, Docker, 容器, Linux, Cgroups, CPU, Memory, OOM Killer, Kubernetes]
aliases: []
---

# 03 Cgroups 资源限制与控制

**摘要：**

[[02 Linux Namespace 深度解析]] 解决了"容器看到什么"的问题——通过 Namespace 让容器进程看到独立的 PID 空间、网络栈和文件系统。但仅有视图隔离是远远不够的：一个容器进程虽然"看不到"其他容器的进程，但它仍然可以消耗宿主机上所有的 CPU 和内存——直到把整台机器拖垮。**Cgroups（Control Groups）** 解决的正是"容器能用多少资源"的问题。它是 Linux 内核提供的资源限制、优先级控制和监控机制，通过将进程组织成层级结构并为每一级设置资源上限，确保一个容器不会"饿死"其他容器或宿主机本身。本文从 Cgroups 的设计思想出发，深入分析 v1 和 v2 的架构差异，逐一剖析 CPU、Memory、I/O 三大核心控制器的工作机制，重点解读 OOM Killer 的触发逻辑和 CPU 限流（Throttling）的原理，最后阐明 Cgroups 参数在容器运行时和 [[Kubernetes]] 中的具体映射关系。

---

## 第 1 章 为什么需要资源限制

### 1.1 没有资源限制的后果

考虑一台 16 核 64GB 内存的服务器上运行着 20 个容器。如果没有任何资源限制：

**场景一：内存泄漏**。容器 A 中的 Java 应用存在内存泄漏，堆内存持续增长。由于没有内存限制，它会消耗越来越多的物理内存，直到宿主机的可用内存耗尽。此时 Linux 内核的 OOM Killer 会被触发——但它可能杀死的不是容器 A 的进程，而是其他"无辜"的容器 B 或 C 的进程（OOM Killer 选择杀死哪个进程有自己的评分算法，不一定选择消耗最多内存的那个）。一个容器的内存泄漏导致了其他容器的不可用——这是生产事故。

**场景二：CPU 饥饿**。容器 A 启动了一个计算密集型任务（如 AI 模型训练），将所有 16 核 CPU 跑满 100%。其他 19 个容器几乎分不到 CPU 时间，HTTP 请求超时，健康检查失败，服务不可用。

**场景三：磁盘 I/O 打满**。容器 A 大量写日志，占满了磁盘 I/O 带宽。其他容器的数据库查询因为磁盘 I/O 延迟急剧增加而超时。

这三个场景说明了一个核心问题：**Namespace 只解决了"看得见"的隔离，没有解决"用得到"的隔离。** 容器之间的资源争抢需要 Cgroups 来治理。

### 1.2 Cgroups 的定义与设计目标

**Cgroups（Control Groups）** 是 Linux 内核提供的一种机制，用于**将进程组织成层级结构，并对每个组设置资源使用的限制、优先级和监控**。

Cgroups 有四个核心功能：

| 功能 | 说明 | 对容器的意义 |
| :--- | :--- | :--- |
| **限制（Limiting）** | 为进程组设置资源使用上限 | 容器最多用 4GB 内存、2 核 CPU |
| **优先级（Prioritization）** | 控制进程组之间的资源分配权重 | 高优容器优先获得 CPU 时间 |
| **记账（Accounting）** | 统计进程组的资源使用量 | 监控容器的实际 CPU/内存使用 |
| **控制（Control）** | 冻结/恢复/终止进程组 | 暂停一个容器的所有进程 |

Cgroups 由 Google 的工程师 Paul Menage 和 Rohit Seth 在 2006 年开发（最初叫 "Process Containers"），2007 年合入 Linux 2.6.24 主线内核。Google 开发 Cgroups 的动机是管理其大规模数据中心中的进程资源——这个需求后来直接催生了 Borg（Google 内部的集群管理系统），而 Borg 又是 [[Kubernetes]] 的前身。

---

## 第 2 章 Cgroups v1 vs v2

### 2.1 Cgroups v1 的架构

Cgroups v1 使用**文件系统接口**来管理——每种资源控制器（CPU、内存、I/O 等）被挂载为一个独立的虚拟文件系统层级。通过读写这些文件来配置资源限制。

```bash
# v1 的文件系统布局
/sys/fs/cgroup/
├── cpu/                    # CPU 控制器
│   ├── docker/
│   │   ├── <container-id>/
│   │   │   ├── cpu.cfs_quota_us    # CPU 时间配额
│   │   │   ├── cpu.cfs_period_us   # CPU 时间周期
│   │   │   ├── cpu.shares          # CPU 权重
│   │   │   └── tasks               # 属于此 cgroup 的进程 PID 列表
├── memory/                 # 内存控制器
│   ├── docker/
│   │   ├── <container-id>/
│   │   │   ├── memory.limit_in_bytes     # 内存上限
│   │   │   ├── memory.usage_in_bytes     # 当前内存使用量
│   │   │   └── memory.oom_control        # OOM 控制
├── blkio/                  # 块 I/O 控制器
├── cpuset/                 # CPU 绑定
├── pids/                   # 进程数限制
└── ...
```

**v1 的核心设计：每种控制器一个独立的层级树**。CPU 控制器有自己的树结构，内存控制器有自己的树结构，彼此独立。一个进程可以在 CPU 控制器的 A 组中，同时在内存控制器的 B 组中——这种灵活性在实践中带来了巨大的复杂性。

#### v1 的问题

**问题一：多层级导致管理混乱**。每种控制器的层级结构独立维护，一个进程可能属于不同控制器的不同层级位置，难以统一管理。

**问题二：控制器间缺乏协调**。CPU 控制器和内存控制器各自为政——无法实现"只有当 CPU 和内存都有余量时才允许调度"这样的联合策略。

**问题三：委托困难**。将 Cgroup 的管理权委托给非 root 用户（如容器中的进程）在 v1 中充满陷阱——不同控制器的权限模型不一致。

### 2.2 Cgroups v2 的架构

Cgroups v2（Linux 4.5 引入，5.x 开始成熟）的核心改进是**统一层级（Unified Hierarchy）**——所有控制器共享一棵层级树。

```bash
# v2 的文件系统布局
/sys/fs/cgroup/                    # 统一的根
├── cgroup.controllers             # 可用的控制器列表
├── cgroup.subtree_control         # 启用的控制器
├── system.slice/                  # 系统服务
├── user.slice/                    # 用户会话
└── docker-<container-id>.scope/   # 容器
    ├── cgroup.controllers
    ├── cpu.max                    # CPU 限制（替代 cfs_quota/cfs_period）
    ├── cpu.weight                 # CPU 权重（替代 cpu.shares）
    ├── memory.max                 # 内存上限（替代 memory.limit_in_bytes）
    ├── memory.current             # 当前内存使用
    ├── io.max                     # I/O 限制
    └── pids.max                   # 进程数限制
```

**v2 的关键改进**：

| 维度 | v1 | v2 |
| :--- | :--- | :--- |
| **层级结构** | 每个控制器一棵独立的树 | 所有控制器共享一棵统一的树 |
| **进程归属** | 一个进程可在不同控制器树的不同位置 | 一个进程在统一树中只有一个位置 |
| **线程粒度** | 不支持线程级控制 | 支持线程粒度的 CPU 控制 |
| **PSI 支持** | 不支持 | 支持 PSI（Pressure Stall Information）资源压力监控 |
| **内存控制** | 需要手动配置 `memory.memsw` | 统一的内存 + swap 控制 |
| **接口风格** | 参数名不统一，各控制器命名风格不同 | 统一的命名规范（如 `cpu.max`、`memory.max`）|

> [!info] 当前的生态状态
> 截至 2024 年，主流 Linux 发行版（Ubuntu 22.04+、Fedora 31+、RHEL 9+）默认使用 Cgroups v2。[[Kubernetes]] 1.25+ 对 Cgroups v2 提供了稳定支持。Docker 和 containerd 也已完全支持 v2。新部署的生产环境应优先使用 v2。

---

## 第 3 章 CPU 控制器

### 3.1 CPU 资源的两种控制维度

CPU 资源控制有两个正交的维度：

**维度一：权重（Weight/Shares）**——当 CPU 资源有竞争时，不同容器按权重比例分配 CPU 时间。如果容器 A 的权重是 1024，容器 B 的权重是 512，那么在 CPU 满载时，A 获得 2/3 的 CPU 时间，B 获得 1/3。但如果只有 A 在运行，A 可以使用全部 CPU——权重不设上限，只控制竞争时的分配比例。

**维度二：配额（Quota）**——硬性限制容器在每个时间周期内最多使用多少 CPU 时间。即使 CPU 空闲，容器也不能超过配额。

| 维度 | v1 参数 | v2 参数 | 行为 |
| :--- | :--- | :--- | :--- |
| 权重 | `cpu.shares` (默认 1024) | `cpu.weight` (默认 100) | CPU 竞争时按比例分配，空闲时不限制 |
| 配额 | `cpu.cfs_quota_us` + `cpu.cfs_period_us` | `cpu.max` | 硬性限制 CPU 时间上限 |

### 3.2 CFS 带宽控制（CPU Quota）的原理

Linux 的默认 CPU 调度器是 **CFS（Completely Fair Scheduler）**。CFS 的带宽控制功能通过两个参数实现 CPU 配额：

- **period**（周期）：一个时间窗口的长度，默认 100ms（100000 微秒）
- **quota**（配额）：在每个 period 内，进程组最多使用的 CPU 时间

**核心公式**：`可用 CPU 核数 = quota / period`

```
# 限制容器使用 1.5 核 CPU
# period = 100ms, quota = 150ms
# 含义：每 100ms 的时间窗口内，容器最多使用 150ms 的 CPU 时间
#        在多核系统上，150ms CPU 时间可以分布在多个核上

# Cgroups v1
echo 100000 > /sys/fs/cgroup/cpu/docker/<id>/cpu.cfs_period_us
echo 150000 > /sys/fs/cgroup/cpu/docker/<id>/cpu.cfs_quota_us

# Cgroups v2
echo "150000 100000" > /sys/fs/cgroup/docker-<id>.scope/cpu.max
```

**CPU Throttling（限流）** 是 CFS 带宽控制的执行机制。当容器在当前 period 内用完了 quota，CFS 会将容器的所有线程标记为"被限流"（throttled）——这些线程在当前 period 的剩余时间内不会被调度到任何 CPU 上执行。直到下一个 period 开始，配额被重置，线程才恢复运行。

#### CPU Throttling 的陷阱

CPU Throttling 是容器化环境中**最常见的性能问题之一**。一个典型的案例：

一个 Java Web 应用配置了 `--cpus=2`（即 quota=200000, period=100000），在正常负载下 CPU 使用率只有 30%，看起来很轻松。但在某些请求中，应用会触发一次 Full GC（垃圾回收），[[JVM GC]] 的 STW（Stop The World）阶段需要在极短的时间内消耗大量 CPU（GC 线程并行工作）。如果 GC 发生在一个 period 的末尾，容器可能已经消耗了 180ms 的配额，只剩 20ms 给 GC——GC 被限流了，本来 50ms 就能完成的 GC 被拉长到 200ms+（等待下一个 period 的配额），导致 P99 延迟出现剧烈尖峰。

**从指标上看**：CPU 使用率只有 30%（平均），但 `cpu.stat` 中的 `nr_throttled`（被限流次数）和 `throttled_time`（被限流总时间）很高。**CPU 使用率低 + Throttling 高 = CPU 配额设置不合理。**

```bash
# 查看容器的 CPU 限流统计
cat /sys/fs/cgroup/cpu/docker/<id>/cpu.stat
# nr_periods 12345          # 经过的 period 总数
# nr_throttled 892          # 被限流的 period 数
# throttled_time 456789000  # 被限流的总时间（纳秒）
```

> [!warning] 生产避坑
> 在 [[Kubernetes]] 中，`resources.limits.cpu` 映射为 CFS quota，`resources.requests.cpu` 映射为 CFS shares（权重）。很多团队只设置了 limits 而没有注意到 Throttling 的存在。**建议监控容器的 `container_cpu_cfs_throttled_periods_total` 指标**（[[Prometheus]] 的 cAdvisor 暴露），如果 Throttling 比例超过 5%，需要考虑增大 CPU limits 或优化应用的 CPU 使用模式（如减少 GC 线程数、避免 CPU burst）。

### 3.3 CPU 权重（Shares/Weight）

CPU 权重控制的是**竞争时的 CPU 分配比例**，而不是绝对上限。

```bash
# Cgroups v1：cpu.shares，默认 1024
# 容器 A: shares=2048，容器 B: shares=1024
# 当两者都在争抢 CPU 时，A 获得 2/3，B 获得 1/3
# 当只有 A 在运行时，A 可以使用 100% CPU

# Cgroups v2：cpu.weight，范围 1-10000，默认 100
echo 200 > /sys/fs/cgroup/docker-<id>.scope/cpu.weight
```

在 [[Kubernetes]] 中，`resources.requests.cpu: "500m"` 表示 0.5 核 CPU 的请求量——它被转换为 `cpu.shares = 512`（v1）或 `cpu.weight` 的对应值（v2）。Kubernetes 调度器使用 requests 来决定 Pod 调度到哪个节点（节点的可分配 CPU 必须大于所有 Pod requests 之和），而 limits 用来设置 CFS quota 硬限制。

### 3.4 cpuset：CPU 绑定

`cpuset` 控制器允许将进程组绑定到特定的 CPU 核心上运行。这在对延迟敏感的场景中非常有用——避免 CPU 缓存失效（cache miss）和跨 NUMA 节点的内存访问开销。

```bash
# 将容器绑定到 CPU 0 和 CPU 1
echo "0-1" > /sys/fs/cgroup/cpuset/docker/<id>/cpuset.cpus
```

在 [[Kubernetes]] 中，通过 **CPU Manager** 的 `static` 策略可以为 Guaranteed QoS 类别的 Pod 分配独占的 CPU 核心。

---

## 第 4 章 Memory 控制器

### 4.1 内存限制的工作机制

内存控制器限制进程组可以使用的物理内存（RSS + Page Cache）总量。

```bash
# Cgroups v1
echo 4294967296 > /sys/fs/cgroup/memory/docker/<id>/memory.limit_in_bytes  # 4GB

# Cgroups v2
echo 4294967296 > /sys/fs/cgroup/docker-<id>.scope/memory.max  # 4GB
```

当容器的内存使用量接近限制时，内核会尝试以下操作（按顺序）：

1. **回收 Page Cache**：将 Cgroup 内的文件缓存页面释放。Page Cache 是内核用于缓存磁盘文件内容的内存，可以安全释放（数据已经在磁盘上）
2. **Swap Out**：如果启用了 swap，将不常用的匿名页面（堆、栈等）换出到 swap 空间
3. **触发 OOM Killer**：如果回收 Page Cache 和 Swap Out 仍无法满足内存需求，内核在该 Cgroup 范围内选择一个进程杀死

### 4.2 OOM Killer 深度解析

**OOM Killer（Out Of Memory Killer）** 是 Linux 内核在内存耗尽时的最后手段——选择一个进程杀死以释放内存。在容器场景中，Cgroups 的内存限制触发的是**Cgroup 范围内的 OOM Killer**——只会杀死该 Cgroup 内的进程，不会影响其他 Cgroup 或宿主机进程。

#### OOM Killer 的评分机制

OOM Killer 通过 **oom_score** 来决定杀死哪个进程。每个进程的 oom_score 基于以下因素计算：

- **内存使用量**：使用内存越多，得分越高（越容易被杀）
- **进程树**：杀死一个进程如果能释放大量内存（包括其子进程），得分更高
- **oom_score_adj**：管理员可以手动调整的偏移量（-1000 到 1000）。-1000 表示永不被 OOM 杀死，1000 表示优先被杀

```bash
# 查看进程的 OOM 得分
cat /proc/<PID>/oom_score       # 当前得分
cat /proc/<PID>/oom_score_adj   # 管理员设置的偏移量
```

在 [[Kubernetes]] 中，kubelet 根据 Pod 的 QoS 等级设置 `oom_score_adj`：

| QoS 等级 | oom_score_adj | 含义 |
| :--- | :--- | :--- |
| **Guaranteed** | -997 | 请求 = 限制，最不容易被杀 |
| **Burstable** | 2~999（根据内存使用比例） | 弹性使用，中等优先级 |
| **BestEffort** | 1000 | 未设置请求和限制，最容易被杀 |

这意味着当节点内存不足时，Kubernetes 会优先杀死 BestEffort Pod，然后是 Burstable Pod，最后才是 Guaranteed Pod——这就是 Kubernetes QoS 模型的底层实现机制。

#### OOM 事件的排查

容器被 OOM Kill 后，可以通过以下方式确认：

```bash
# 查看容器的退出码——137 表示被 SIGKILL 杀死（通常是 OOM）
docker inspect <container> --format='{{.State.ExitCode}}'
# 137

# 查看内核日志
dmesg | grep -i "killed process"
# [12345.678] Memory cgroup out of memory: Killed process 9876 (java)
# total-vm:8388608kB, anon-rss:4194304kB, file-rss:0kB

# Cgroups v2 查看 OOM 事件计数
cat /sys/fs/cgroup/docker-<id>.scope/memory.events
# oom 3          # 发生了 3 次 OOM
# oom_kill 3     # 杀死了 3 次进程
```

### 4.3 内存的组成部分

容器的"内存使用量"并不只是堆内存。Cgroups 统计的内存包括：

| 内存类型 | 说明 | 是否计入 Cgroup 限制 |
| :--- | :--- | :--- |
| **RSS（Resident Set Size）** | 进程实际驻留在物理内存中的匿名页（堆、栈、mmap 匿名映射）| ✅ |
| **Page Cache** | 内核为文件 I/O 缓存的页面（读写文件时自动分配）| ✅ |
| **Kernel Memory** | 内核为进程分配的内核数据结构（如 socket buffer、dentry cache）| ✅（v2 默认计入）|
| **Swap** | 被换出到 swap 空间的页面 | 可配置 |
| **Shared Memory** | tmpfs / shmem 共享内存 | ✅ |

Page Cache 被计入 Cgroup 限制这一点经常让人困惑。假设容器的内存限制是 4GB，应用的堆内存占了 2GB，但容器频繁地读写文件，内核为文件 I/O 分配了 2GB 的 Page Cache——此时容器的内存使用量已经达到 4GB 限制。虽然 Page Cache 可以被回收（不会直接触发 OOM），但频繁的 Page Cache 回收和重新分配会导致磁盘 I/O 增加、性能下降。

> [!warning] Java 容器的内存陷阱
> Java 应用在容器中的内存使用量 = JVM 堆内存（`-Xmx`）+ 非堆内存（Metaspace、线程栈、Direct Buffer、JIT 代码缓存）+ 原生内存（JNI 分配）+ Page Cache。很多团队只关注 `-Xmx` 设置，忽略了非堆内存和 Page Cache 的开销。经验法则：**容器的内存限制应该至少是 JVM 堆内存的 1.5~2 倍**。

### 4.4 memory.low 与 memory.high（v2）

Cgroups v2 引入了两个额外的内存控制参数，提供了比 v1 更精细的内存管理：

- **memory.low**：软保证。当 Cgroup 的内存使用低于此值时，内核会尽量避免回收该 Cgroup 的内存（除非系统全局内存紧张到不得不回收）。这类似于"最低保障"。
- **memory.high**：软限制。当 Cgroup 的内存使用超过此值时，内核会开始积极回收该 Cgroup 的内存（主要是 Page Cache），并对内存分配进行限流（throttle），但**不会触发 OOM Kill**。
- **memory.max**：硬限制。超过此值将触发 OOM Kill。

```
memory.low  ≤  memory.high  ≤  memory.max

                                    ← OOM Kill
                      ← 积极回收 + 限流
        ← 受保护，尽量不回收
```

---

## 第 5 章 I/O 控制器

### 5.1 块 I/O 限制

I/O 控制器（v1 中叫 `blkio`，v2 中叫 `io`）限制进程组对块设备（磁盘）的 I/O 速率。

```bash
# Cgroups v2：限制容器对设备 8:0（sda）的 I/O
# 读速率上限 100MB/s，写速率上限 50MB/s
echo "8:0 rbps=104857600 wbps=52428800" > /sys/fs/cgroup/docker-<id>.scope/io.max
```

I/O 限制的粒度是**块设备级别**的——你可以限制容器对 `/dev/sda` 的 I/O 速率，但无法限制对特定文件或目录的 I/O 速率。

### 5.2 I/O 权重

类似于 CPU 权重，I/O 权重控制在 I/O 资源竞争时的分配比例：

```bash
# Cgroups v2：设置 I/O 权重（范围 1-10000，默认 100）
echo "default 200" > /sys/fs/cgroup/docker-<id>.scope/io.weight
```

### 5.3 I/O 控制的局限

Cgroups 的 I/O 控制有一个重要的局限：**它只对直接 I/O（Direct I/O）和同步写入有效**。对于通过 Page Cache 的缓冲 I/O（这是绝大多数应用的默认行为），I/O 控制的效果有限——因为应用的写操作先写入 Page Cache（内存操作，非常快），然后由内核的回写线程（writeback）异步地将数据刷到磁盘。回写线程的 I/O 限制在 v1 中基本不生效，v2 中有所改善但仍不完美。

---

## 第 6 章 pids 控制器

`pids` 控制器限制进程组可以创建的进程（和线程）数量。这是一个简单但重要的保护机制——防止 **fork bomb**（恶意或 bug 导致的进程无限创建）拖垮整个系统。

```bash
# 限制容器最多创建 1024 个进程
echo 1024 > /sys/fs/cgroup/pids/docker/<id>/pids.max  # v1
echo 1024 > /sys/fs/cgroup/docker-<id>.scope/pids.max  # v2
```

在 [[Kubernetes]] 中，kubelet 的 `--pod-max-pids` 参数可以设置每个 Pod 的进程数上限。

---

## 第 7 章 Cgroups 在容器运行时中的应用

### 7.1 Docker 的参数映射

| Docker 参数 | Cgroups v1 文件 | Cgroups v2 文件 |
| :--- | :--- | :--- |
| `--memory=4g` | `memory.limit_in_bytes` | `memory.max` |
| `--memory-reservation=2g` | `memory.soft_limit_in_bytes` | `memory.low` |
| `--cpus=1.5` | `cpu.cfs_quota_us=150000` | `cpu.max "150000 100000"` |
| `--cpu-shares=512` | `cpu.shares` | `cpu.weight` |
| `--cpuset-cpus=0,1` | `cpuset.cpus` | `cpuset.cpus` |
| `--pids-limit=1024` | `pids.max` | `pids.max` |

### 7.2 Kubernetes 的参数映射

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: app
      resources:
        requests:       # 调度依据 + CPU 权重
          memory: "2Gi"
          cpu: "500m"
        limits:         # 硬性上限
          memory: "4Gi"
          cpu: "2"
```

| K8s 字段 | 映射到的 Cgroups 参数 | 说明 |
| :--- | :--- | :--- |
| `requests.cpu: 500m` | `cpu.shares=512` (v1) / `cpu.weight` (v2) | 0.5 核 CPU 权重 |
| `limits.cpu: 2` | `cpu.cfs_quota_us=200000` (v1) / `cpu.max` (v2) | 最多 2 核 CPU |
| `requests.memory: 2Gi` | 不直接映射 Cgroups，用于调度决策和 QoS 分类 | 调度器保证节点有 2Gi 可用 |
| `limits.memory: 4Gi` | `memory.limit_in_bytes` (v1) / `memory.max` (v2) | 超过 4Gi 触发 OOM Kill |

> [!info] requests vs limits 的设计哲学
> **requests** 是"保障"——Kubernetes 调度器确保节点有足够的资源满足所有 Pod 的 requests 之和。requests 通过 CPU shares 实现——当 CPU 有竞争时，按 requests 的比例分配。
>
> **limits** 是"上限"——即使节点有空闲资源，容器也不能超过 limits。limits 通过 CFS quota 和 memory limit 实现。
>
> 设置 requests < limits 允许容器"突发"使用超出 requests 的资源（当节点有空闲时），这被称为 **Overcommit（超售）**。超售可以提高资源利用率，但也增加了资源争抢的风险。

### 7.3 PSI（Pressure Stall Information）

Cgroups v2 引入了 **PSI（Pressure Stall Information）** 机制——一种量化资源压力的指标。PSI 告诉你"进程组中有多大比例的时间因为缺乏某种资源而被阻塞"。

```bash
cat /sys/fs/cgroup/docker-<id>.scope/cpu.pressure
# some avg10=2.50 avg60=1.30 avg300=0.80 total=12345678
# full avg10=0.50 avg60=0.20 avg300=0.10 total=2345678

cat /sys/fs/cgroup/docker-<id>.scope/memory.pressure
# some avg10=5.00 avg60=3.20 avg300=1.50 total=23456789
# full avg10=1.00 avg60=0.50 avg300=0.20 total=3456789
```

- **some**：至少有一个任务因为缺乏资源而被阻塞的时间百分比
- **full**：所有任务都因为缺乏资源而被阻塞的时间百分比

PSI 是比传统的 CPU 使用率更准确的"资源是否充足"的信号——CPU 使用率 90% 不一定意味着 CPU 不够用（可能只是一个大任务在跑），但 CPU PSI some=50% 意味着有一半的时间至少有一个任务在等待 CPU。

---

## 第 8 章 总结

本文系统梳理了 Cgroups 的完整技术体系：

- **Cgroups v1 vs v2**：v2 的统一层级设计解决了 v1 多层级的管理混乱
- **CPU 控制器**：权重（shares/weight）控制竞争时的分配比例，配额（quota）设置硬性上限；CPU Throttling 是容器性能问题的常见根因
- **Memory 控制器**：硬限制触发 OOM Kill，内存使用量包含 RSS + Page Cache；Kubernetes 的 QoS 等级通过 oom_score_adj 实现差异化的 OOM 优先级
- **I/O 控制器**：限制块设备的 I/O 速率，但对缓冲 I/O 的控制有限
- **Kubernetes 映射**：requests → CPU 权重 + 调度依据，limits → CFS quota + 内存硬限制

下一篇 [[04 UnionFS 与容器镜像原理]] 将深入容器的第三大支柱——联合文件系统与镜像的分层存储机制。

---

## 参考资料

1. Linux Kernel Documentation - Cgroups v2：https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
2. Linux man pages: `cgroups(7)`
3. Kubernetes Documentation - Resource Management：https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
4. Kubernetes Documentation - Pod QoS：https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
5. Facebook Engineering (2018). *PSI - Pressure Stall Information*：https://facebookmicrosites.github.io/psi/
6. Brendan Gregg (2020). *BPF Performance Tools*. Addison-Wesley, Chapter 6: CPUs.
7. Tim Hockin (2019). *Kubernetes CPU Limits and Throttling*. Google Engineering Blog.

---

> [!note] 思考题
> 1. Docker 的 Bridge 网络为每个容器创建 veth pair——一端在容器的 Network Namespace 内，另一端连接到宿主机的 docker0 网桥。容器间通过网桥通信，访问外部网络通过 NAT（iptables MASQUERADE）。NAT 对性能有什么影响？Host 网络模式（容器直接使用宿主机网络栈）在什么场景下性能优势明显？
> 2. Overlay 网络（如 Docker Swarm 的 ingress、Kubernetes 的 Flannel VXLAN）通过隧道封装实现跨主机容器通信。VXLAN 在 UDP 包中封装原始以太网帧——增加了约 50 字节的头部开销和封装/解封装的 CPU 开销。在需要高网络性能的场景中（如 10Gbps+），Overlay 网络的开销是否可接受？Calico 的 BGP 路由模式如何避免封装开销？
> 3. 容器的 DNS 解析默认使用 Docker 内置的 DNS 服务器（127.0.0.11）。在 Kubernetes 中，CoreDNS 处理 Service 名称解析。DNS 查询延迟在高 QPS 场景中可能成为瓶颈——`ndots:5`（默认）导致短域名被追加多个搜索域后缀尝试解析。你如何通过调优 `ndots` 和使用 NodeLocal DNSCache 来降低 DNS 延迟？
