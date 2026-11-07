---
title: "Linux 隔离原语——namespace、cgroups、seccomp 与 capabilities 的安全地基"
date: 2026-08-15
tags: [Agent Sandbox, Linux, cgroups, io_uring]
keywords: [CLONE_NEW, Container, Landlock, PSI, capabilities, namespaces, rootless, seccomp, user namespace]
aliases: [Linux隔离原语, namespace详解, cgroups详解, seccomp详解, 隔离三件套]
---

# 02 Linux 隔离原语——namespace、cgroups、seccomp 与 capabilities 的安全地基

**摘要：**

[[01 Agent 沙箱全景——威胁模型、六层技术栈与逻辑演进]] 建立了威胁模型与六层技术栈，指出"隔离运行时"是沙箱的第四层、也是爆炸半径控制的关键。本文深入这一层的地基：Linux 内核从 2002 年到 2020 年逐步引入的四类隔离原语——**namespaces**（视图隔离）、**cgroups**（资源限制）、**seccomp**（系统调用过滤）、**capabilities**（权限分权）。文章逐一拆解 8 种 namespace 的隔离资源与反例场景，剖析 clone/unshare/setns 的正交设计与 nsproxy 共享语义，深入 user namespace"无特权创建"的安全争议（CVE-2024-1086、Ubuntu 24.04 的三次绕过与 2025 年 11 月 runc 三连逃逸的官方立场）。随后补上原语层的另外三块拼图：cgroup v2 的统一层级、委托（delegation）与 PSI 压力信号，seccomp-BPF 过滤器的执行路径与 seccomp-user-notification 用户态通知，capabilities 的位集语义与"容器内 root 不等于全能力"的分权逻辑；并做 2025-2026 的时效更新——cgroup v1 的系统性退役、io_uring 与 seccomp 的结构性盲区（Linux 7.0 收口）、Landlock 的 ABI 演进与 systemd 集成。最后打通"原语到运行时"的完整 CRI 链路（RuntimeClass→kubelet→CRI→containerd→shim→agent 七跳），论证为什么这四类原语叠加仍不足以构成对抗性沙箱——共享内核是它们共同的天花板。核心认知：**隔离原语解决"视图、账本、入口、权限"四个维度，但都不解决"内核攻击面"——这正是 gVisor/Kata/Firecracker 存在的理由，也是[[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]]的起点**。

---

## 第 1 章 namespace 的本质——"视图隔离"

2002 年，当内核开发者决定把挂载点视图从全局列表里"抽出来"、让每个进程各看各的树时，恐怕没有人预料到，这个不起眼的机制会在二十多年后成为 AI Agent 隔离的地基。今天一个模型生成的代码沙箱，它的安全边界几乎全部由 Linux 内核这些年零散累积的隔离机制拼成，而其中最底层的一块就是 namespace。要理解这些机制为什么长成今天这个样子，得先回答一个朴素的问题：为什么一个进程需要"以为"自己独占了一份资源？

### 1.1 什么是 namespace

Linux namespace 的核心思想极其简洁：**把一个全局内核资源包装起来，让一个进程以为它拥有自己私有的副本**。

考虑一个最简单的例子——PID namespace。在没有 PID namespace 的系统中，所有进程共享同一个 PID 空间，进程的 PID 全局唯一。但当把一个进程放入新的 PID namespace 时，这个进程看到的 PID 空间是全新的：它自己是 PID 1，它的子进程是 PID 2、3、4……它看不到外部世界的进程（PID 100、200、300 对它不可见）。

这不是"隐藏"——从内核视角看，外部进程仍然存在，仍然在同一个内核上运行。但从**这个进程的视角**看，它"以为"整个系统只有它和它的子进程。这就是"视图隔离"——改变进程对资源的视图，而非改变资源本身。

> [!info] 核心概念：namespace 只是 inode 数字
> 在内核实现层面，namespace 极其朴素——它只是一个 inode 数字。每个进程在 `/proc/[pid]/ns/` 目录下有一组符号链接，每条链接指向一个 namespace 对象，链接名后面的方括号中是 inode 数字。两个进程的 `/proc/[pid]/ns/net` 如果指向相同的 inode，它们就共享同一个网络 namespace；如果 inode 不同，它们就在不同的网络 namespace 中。内核通过比较 inode 数字来判断"这两个进程是否在同一个 namespace 中"——没有更复杂的机制，就是数字比较。
>
> 这种极简实现是 namespace 轻量的根本原因——创建一个新 namespace 几乎没有内存开销（只是分配一个新的 inode），这也是容器启动速度达到毫秒级的基础。对比 VM：创建一个 VM 需要加载完整的内核镜像、初始化设备模型、启动用户态系统，开销在数百 MB 内存和秒级启动时间；创建一个 namespace 只需要一个 inode。这个数量级的差异，是"容器化隔离"与"虚拟化隔离"在 Agent 沙箱场景中性能分化的根源。

**实操证据**：在任意 Linux 机器上运行下面的命令，可以看到当前进程所属的全部 namespace：

```bash
# 查看当前 shell 进程的 namespace 身份
ls -l /proc/self/ns/

# 输出示例（inode 数字即 namespace 身份）
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 cgroup -> 'cgroup:[4026531835]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 ipc -> 'ipc:[4026531839]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 mnt -> 'mnt:[4026531841]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 net -> 'net:[4026531993]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 pid -> 'pid:[4026531836]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 user -> 'user:[4026531837]'
# lrwxrwxrwx 1 root root 0 Aug 15 10:00 uts -> 'uts:[4026531838]'
```

再运行 `unshare --pid --fork --mount-proc bash` 进入一个新的 PID namespace，`ls -l /proc/self/ns/pid` 会看到不同的 inode 数字——这就是"进入新 namespace"的可见证据。在 agent-sandbox 的 PoC 验证中，笔者正是用这类命令在 OpenSandbox 创建的沙箱内采集隔离证据链（guest 内核版本、PID 1 身份、namespace inode 差异），证明沙箱确实运行在独立 namespace 中。

值得补充的细节是 `/proc/[pid]/ns/` 里其实不止八条链接——PID 与 Time 各有两条，多出来的 `pid_for_children` 与 `time_for_children` 指向"该进程创建子进程时将进入的 namespace"，而 `pid` 与 `time` 指向进程当前所在的那个。这暴露了一个微妙的事实：**一个进程自身的 PID namespace 归属终身不可变**——内核没有"移动已存在进程"的接口，只能经 setns 改变其后代的归属。

再往深一层看，这些链接同时是内核 namespace 对象的句柄：**只要有一个文件描述符或绑定挂载还持有它，namespace 就不会销毁**——`ip netns` 把网络 namespace 的链接 bind mount 到 `/run/netns/` 下正是利用这一点：即使创建进程早已退出，网络栈依然存活，供后续进程 setns 加入。

### 1.2 三个系统调用：clone / unshare / setns

namespace 的操纵通过三个系统调用完成，它们覆盖了 namespace 操纵的全部三个维度：

**clone(flags)**：创建新进程，同时可选地创建新 namespace。`flags` 参数中可以指定 `CLONE_NEW*` 标志来创建对应类型的新 namespace。这是 Docker `run` 底层使用的——Docker 调用 `clone()` 并传入 `CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWNS | ...` 一次性创建所有需要的 namespace。

**unshare(flags)**：不创建新进程，但把**当前进程**移入新的 namespace。这在"已有进程想进入隔离环境"的场景中使用——如 `unshare --net /bin/bash` 让当前 shell 进入新的网络 namespace。

**setns(fd, nstype)**：把当前进程加入一个**已存在的** namespace。`fd` 是指向目标 namespace 的文件描述符（通过打开 `/proc/[pid]/ns/xxx` 获得）。这是 Docker `exec` 底层使用的——Docker 调用 `setns()` 让新进程加入容器的已有 namespace。

```c
// 三个系统调用的关系
clone(CLONE_NEWNET | CLONE_NEWPID, ...)  // 创建新进程 + 新网络namespace + 新PID namespace
unshare(CLONE_NEWNET)                    // 当前进程进入新网络namespace（不创建新进程）
setns(fd_net, CLONE_NEWNET)              // 当前进程加入fd指向的网络namespace
```

> [!note] 设计哲学：clone/unshare/setns 的"正交设计"
> 三个系统调用覆盖了 namespace 操纵的三个维度：clone 是"创建新进程 + 新空间"，unshare 是"已有进程 + 新空间"，setns 是"已有进程 + 已有空间"。这种正交设计让 namespace 可以灵活组合——你可以创建新进程进新空间（容器启动）、让已有进程进新空间（运行时隔离）、或让已有进程加入已有空间（docker exec 进入运行中的容器）。这种灵活性是容器运行时能够实现"启动→执行→进入"完整工作流的基础。
>
> 对 Agent 沙箱而言，这个设计还有一个更深的意义：**沙箱内的"注入"机制依赖 setns**。OpenSandbox 的 execd 要进入沙箱进程的 namespace 执行命令、查看文件，本质上就是打开目标进程的 `/proc/[pid]/ns/*` fd 再 setns——理解这三个调用，才能理解 [[08 OpenSandbox 数据面——execd 与 egress 的盒内世界]] 的实现原理。

### 1.3 创建 namespace 需要什么权限

大多数 namespace 的创建需要 `CAP_SYS_ADMIN` 能力——因为在新 namespace 中，创建者将拥有改变全局资源的权力（挂载文件系统、配置网络栈、管理进程），这些改变可能影响后续加入该 namespace 的进程。

**例外：user namespace**。自 Linux 3.8（2013 年）起，创建 user namespace **不需要任何特权**——无特权用户也可以创建。这个"无特权创建"特性是 rootless 容器（无根容器）的基础，但也引发了持续至今的安全争议（第 4 章深入讨论）。

权限要求差异造成了一个有趣的现状：**普通用户能做的"沙箱"，与管理员能做的"沙箱"，在 namespace 维度上能力不同**——这也是为什么大多数 Agent 沙箱平台（包括 OpenSandbox）以 rootless 或半特权模式运行沙箱进程，却在宿主侧保留完整的管理能力。

### 1.4 nsproxy 与 namespace 的共享、继承

在内核实现里，每个进程的 task_struct 中有一个指向 `struct nsproxy` 的指针，这个结构体统一持有该进程当前所在的所有 namespace 的引用——clone 时若指定了某个 `CLONE_NEW*` 标志，内核就分配一个新的 nsproxy、让新进程指向它；若一个标志都没指定，父子进程共享同一个 nsproxy，即共享全部 namespace。线程（CLONE_THREAD）必然共享 nsproxy，同一进程的各线程必然身处同一组 namespace。

这个"共享/新建"的二元选择，加上 1.2 节三个系统调用的正交组合，构成了 namespace 操纵的完整语法：clone 决定新进程的 nsproxy 是复制还是新建，unshare 把当前进程从共享中"拆出去"，setns 则让进程加入别人已经建好的 nsproxy。可以把这个结构想成一把钥匙串——**nsproxy 就是挂满各房间钥匙的钥匙环**：clone 决定新进程是"拿到复制的钥匙环"还是"共用同一串"，unshare 是"把其中一把钥匙换成新配的"，setns 则是"借用别人的钥匙串进门"。

---

## 第 2 章 8 种 namespace 逐一拆解

### 2.1 Mount Namespace（CLONE_NEWNS，Linux 2.4.19，2002）

**隔离资源**：挂载点视图——每个 mount namespace 有自己的挂载表。进程在一个 mount namespace 中 mount/umount 文件系统，不影响其他 mount namespace 中的进程看到的挂载视图。

**引入背景**：Mount namespace 是 Linux 的**第一个** namespace——2002 年在 Linux 2.4.19 中引入。它是最自然的隔离维度——"让进程看到不同的文件系统视图"。有趣的是它的 flag 名字 `CLONE_NEWNS`（New Namespace 的缩写）——因为引入时开发者没预料到后面还会有一系列 namespace，所以第一个 namespace 的 flag 命名留了个"历史包袱"。

**容器中的角色**：Docker 用 mount namespace 让容器看到自己的文件系统层次——容器的根文件系统（image layer 通过 OverlayFS 合并）只对容器内的进程可见，宿主机上其他进程看不到这个挂载视图。

**不这样会怎样**：如果没有 mount namespace，所有进程共享同一个挂载表——你给容器 mount 一个 overlay 文件系统，宿主机上所有进程都能看到这个挂载。这意味着容器的文件系统隔离完全不存在——任何进程都能访问容器的文件。

> [!warning] 生产避坑：mount namespace 的"传播性"陷阱
> mount namespace 有一个容易踩的坑——挂载传播性（mount propagation）。默认情况下，一个 mount namespace 中的挂载**可能**传播到其他 namespace（取决于挂载点的传播类型：MS_PRIVATE / MS_SHARED / MS_SLAVE / MS_UNBINDABLE）。如果容器的根挂载点没有正确设置为 MS_PRIVATE，容器内的 mount 操作可能"泄漏"到宿主机的挂载表中。Docker/Podman 在创建容器时会显式设置传播类型为 MS_PRIVATE 来防止这种泄漏，但如果你自己用 unshare/clone 做 namespace 隔离，必须手动设置传播类型——否则可能出现"容器 mount 了东西，宿主机也看到了"的诡异现象。
>
> 对 Agent 沙箱来说，这个陷阱还有一个放大效应：Agent 可能被诱导执行 `mount` 类命令（如果沙箱给了 CAP_SYS_ADMIN 且未限制 mount syscall），挂载传播配置错误时，沙箱内的挂载操作会直接污染宿主机文件系统视图——这是攻击链第 2 步（提权/逃逸）的一条现实路径。

### 2.2 UTS Namespace（CLONE_NEWUTS，Linux 2.6.19，2006）

**隔离资源**：主机名（hostname）和 NIS 域名——两个 `uname` 系统调用返回的字符串。

**名字来源**：UTS = UNIX Timesharing System，来自 `struct utsname`——这是一个历史悠久的 Unix 数据结构，存储系统标识信息。

**容器中的角色**：让每个容器有自己的 hostname——如 `hostname` 命令在容器中返回容器名而非宿主机名。这对需要 hostname 做服务发现的应用很重要。

**不这样会怎样**：如果没有 UTS namespace，所有进程共享同一个 hostname——容器中的 `hostname` 命令返回宿主机的 hostname。这可能导致依赖 hostname 的应用行为异常（如某些中间件用 hostname 做节点标识）。

**为什么是最简单的 namespace**：UTS namespace 只隔离两个字符串——hostname 和 domainname。没有复杂的数据结构，没有资源管理，只是"让进程看到不同的系统名"。它是理解 namespace 概念的最好起点——如果 UTS namespace 的概念理解了（"让进程看到不同的 hostname"），其他 namespace 只是"让进程看到不同的 X"的变体。

**Agent 沙箱视角**：多个 Agent 沙箱运行在同一节点时，每个沙箱内的 hostname 必须独立——否则 Agent 在沙箱内启动的服务（如 OpenCode 的 4096 端口服务、Hermes 的 9119 Dashboard）无法用 hostname 区分，服务发现会错乱。

### 2.3 IPC Namespace（CLONE_NEWIPC，Linux 2.6.19，2006）

**隔离资源**：System V IPC 和 POSIX 消息队列——包括共享内存段（`shmget`）、信号量集（`semget`）、消息队列（`msgget`）。

**容器中的角色**：让容器有自己的 IPC 资源空间——容器 A 创建的共享内存段不会被容器 B 看到。

**不这样会怎样**：如果没有 IPC namespace，所有进程共享同一个 IPC 资源空间——容器 A 和容器 B 可能因为使用了相同的 IPC key 而产生冲突（一个容器创建的共享内存段被另一个容器意外访问）。

**实际影响较小**：在现代应用中，System V IPC 的使用频率远低于 POSIX IPC 和其他消息传递机制（如 Redis、RabbitMQ）。很多容器化应用甚至不使用 System V IPC，因此 IPC namespace 的实际影响较小——但它仍然是容器隔离的一个维度。IPC namespace 与 [[04 KVM 与硬件虚拟化——MicroVM 隔离的硬件基石]] 的对比最能说明"视图隔离 vs 真实隔离"的差异：VM 之间连 CPU 寄存器都不共享，IPC namespace 只是让共享内存段"看起来"是私有的。

### 2.4 PID Namespace（CLONE_NEWPID，Linux 2.6.24，2008）

**隔离资源**：进程 ID 空间——每个 PID namespace 有自己的 PID 编号空间。在新 PID namespace 中创建的第一个进程是 PID 1。

**容器中的角色**：让容器中的进程看到自己的 PID 树——容器的入口进程是 PID 1，其子进程是 PID 2、3、4……容器内进程看不到宿主机上的其他进程。

**PID 1 的特殊职责**：在 PID namespace 中，PID 1 有特殊职责——它是"init 进程"，负责回收孤儿进程（reaping zombies）和处理信号。如果 PID 1 退出，该 namespace 中的所有进程都会被 SIGKILL。这就是为什么 Docker 容器需要"init 进程"（如 `tini`）——如果你的应用不是为做 PID 1 设计的（不回收僵尸进程），可能导致进程泄漏。

**Agent 沙箱视角——PID 1 与 execd 的进程拓扑**：在 OpenSandbox 的沙箱中，进程拓扑是"bootstrap 启动 execd + 用户 entrypoint"——bootstrap 成为 PID 1，execd 与用户进程是它的子进程（[[08 OpenSandbox 数据面——execd 与 egress 的盒内世界]] 详细展开）。这个设计不是随意的：**bootstrap 做 PID 1 保证了沙箱退出时所有进程（包括 execd 和 Agent 进程）能被完整回收**，避免了"沙箱已删、进程残留"的僵尸问题——这正是素材中 PoC 验收"残留 0"的底层机制。

**不这样会怎样**：如果没有 PID namespace，容器中的进程可以看到宿主机上的所有进程——`ps aux` 在容器中会列出宿主机的所有进程。这不仅泄露了宿主机的进程信息（安全风险），还可能导致依赖 PID 的应用行为异常。

> [!warning] 生产避坑：PID namespace 的 `/proc` 陷阱
> PID namespace 有一个容易踩的坑——创建了新的 PID namespace 后，`ps` 命令仍然可能显示宿主机的进程，原因是 `ps` 从 `/proc` 文件系统读取进程信息，而 `/proc` 是 mount namespace 管辖的。如果你只创建了 PID namespace 但没有同时创建 mount namespace 并重新挂载 `/proc`，`ps` 读取的仍然是宿主机的 `/proc`——显示的是宿主机的进程列表。Docker 在创建容器时同时创建 PID namespace 和 mount namespace，并在新 mount namespace 中重新挂载 `/proc`——这样 `ps` 才能正确显示容器内的进程。这个"陷阱"说明 namespace 之间需要组合使用——单一 namespace 往往不够。

PID namespace 的 setns 有一个容易忽略的语义：**通过 setns 加入 PID namespace 只能影响"将来创建的子进程"，当前进程自身的 PID 归属不会改变**——所以"docker exec 进入容器"里 exec 出来的进程，与容器原进程共享的其实是"后代视角"。

### 2.5 Network Namespace（CLONE_NEWNET，Linux 2.6.24，2008）

**隔离资源**：网络栈——包括网络设备（网卡）、IP 地址、路由表、端口号、防火墙规则、`/proc/net`、`/sys/class/net`。

**容器中的角色**：让容器有独立的网络栈——容器可以有自己 IP 地址、自己的端口绑定（两个容器都可以绑定 80 端口而不冲突）、自己的路由表。

**不这样会怎样**：如果没有 network namespace，所有进程共享同一个网络栈——两个容器不能同时绑定 80 端口；容器可以看到宿主机的路由表和防火墙规则；容器的网络流量直接走宿主机的网络设备。

**网络 namespace 的连接**：独立的 network namespace 是隔离的——默认无法与外部通信。容器网络（如 Docker bridge、Kubernetes CNI）通过虚拟以太网对（veth pair）连接不同的 network namespace——一端在容器 namespace 中，另一端在宿主机 namespace 中，数据在两端之间传递。可以把这个结构想成"每家一台独立路由器"：网卡、IP、路由表、防火墙都是自家的，veth pair 则是两根把两家路由器连起来的网线——物理链路共享，路由决策彼此隔离。

**对 Agent 沙箱的特殊意义——Egress 控制的前提**：Network namespace 是 Agent 沙箱 Egress 过滤的基础——通过把 Agent 放入独立的 network namespace，可以对其网络流量做独立控制（iptables/eBPF 规则只作用于该 namespace）。如果 Agent 与宿主机共享网络栈，任何出站过滤都无法"只针对这个沙箱"生效。OpenSandbox 的 egress sidecar 正是利用 network namespace 边界，在沙箱网络命名空间内注入策略（[[08 OpenSandbox 数据面——execd 与 egress 的盒内世界]]）。**这是"为什么沙箱必须有独立网络 namespace"的硬性理由：不是可选的隔离增强，而是数据外泄控制（攻击链第 4 步）的结构性前提**。

### 2.6 User Namespace（CLONE_NEWUSER，Linux 3.8，2013）

**隔离资源**：用户 ID 和组 ID——在 user namespace 内，uid/gid 可以与外部不同。一个在宿主机上是 uid 1000 的用户，在某个 user namespace 内可以是 uid 0（root）。

**UID/GID 映射**：user namespace 通过 `/proc/[pid]/uid_map` 和 `/proc/[pid]/gid_map` 文件定义映射关系。如 `0 1000 65536` 表示"namespace 内的 uid 0-65535 映射到宿主机的 uid 1000-65535"。

**无特权创建**：user namespace 是唯一一个不需要 `CAP_SYS_ADMIN` 就能创建的 namespace。这意味着非 root 用户可以创建 user namespace，在其中"成为 root"——但这个"root"只在 namespace 内有效，映射到宿主机上是一个非特权用户。

**rootless 容器的基础**：Podman 和 Docker 的 rootless 模式依赖 user namespace——不需要宿主机 root 权限就能运行容器。容器内的 root（uid 0）在宿主机上映射为一个非特权用户——即使容器内的进程"逃逸"到宿主机，它也只有非特权用户的权限。

**对 Agent 沙箱的决定性意义**：Agent 沙箱运行的代码是模型生成的、不可信的。如果沙箱容器内的 root 就是宿主机的 root，那么"代码在容器内提权到 root"几乎等于"获得宿主机 root"——逃逸半径无限大。user namespace 把容器内的 root 映射为宿主机非特权用户后，**即使沙箱内代码提权成功，逃逸后也只是普通用户权限**——这是 Agent 沙箱中"权限降级"的核心机制，也是 OpenSandbox 的 egress/execd 设计能成立的前提之一。

**安全争议**：user namespace 的"无特权创建"特性是一把双刃剑——它让 rootless 容器成为可能，但也让无特权用户可以进入"有 CAP_SYS_ADMIN 的环境"，从而触及内核中需要 CAP_SYS_ADMIN 的代码路径——这些路径中可能存在未被充分审计的漏洞。CVE-2024-1086（nf_tables use-after-free）就是典型案例——无特权用户通过 user namespace 获得了访问 `nf_tables` 子系统的能力，进而利用漏洞获得 root 权限（第 4 章详细讨论）。

### 2.7 Cgroup Namespace（CLONE_NEWCGROUP，Linux 4.6，2016）

**隔离资源**：cgroup 根目录视图——在 cgroup namespace 内，进程看到的 cgroup 层次结构以它所在的 cgroup 为根，而非宿主机的完整 cgroup 层次。

**容器中的角色**：让容器内的进程看到"自己的 cgroup 是根"——而非看到宿主机的完整 cgroup 层次。这防止容器内的进程通过读取 `/proc/self/cgroup` 获知宿主机的 cgroup 结构信息。

**不这样会怎样**：如果没有 cgroup namespace，容器内的进程可以通过 `/proc/self/cgroup` 看到它在宿主机 cgroup 层次中的完整路径——如 `/docker/<container_id>`——这泄露了宿主机的 cgroup 组织信息。

**Agent 沙箱视角**：cgroup namespace 泄露的信息看似无害（只是一条路径），但在多租户沙箱平台上，路径中可能包含其他租户的资源池信息，为横向探测提供线索。隔离的哲学是"信息面越小越好"——cgroup namespace 是这条哲学的一个小注脚。

### 2.8 Time Namespace（CLONE_NEWTIME，Linux 5.6，2020）

**隔离资源**：单调时钟（monotonic clock）和启动时间（boot time）——在 time namespace 内，可以偏移单调时钟的起点和启动时间。

**容器中的角色**：让容器可以有自己的"时间起点"——如一个容器 checkpoint/restore 后，它的单调时钟可以从 checkpoint 时刻继续，而非从宿主机启动时刻开始。

**不这样会怎样**：如果没有 time namespace，所有进程共享同一个时钟——容器 checkpoint/restore 后，单调时钟会跳跃（从 checkpoint 时的值跳到 restore 时的值），可能导致依赖时间间隔的应用行为异常。

**Agent 沙箱的价值**：对于需要 checkpoint/restore 的 Agent 沙箱（如 GKE Agent Sandbox 的 Pod Snapshots、OpenSandbox 的 pause/resume），time namespace 让恢复后的 Agent 看到连续的时间流逝而非时间跳跃——这对测量执行时间、设置超时等场景很重要。不过截至 2026 年，主流 Agent 沙箱的 pause/resume 都以"容器 rootfs 保存/恢复"为主（[[09 OpenSandbox 编排面——BatchSandbox、WarmPool 与快照]]），time namespace 主要服务于 CRIU 类内存级 checkpoint 方案。

### 2.9 8 种 namespace 全景表

| Namespace | Flag | 内核版本 | 隔离资源 | 创建需特权 | Agent 沙箱价值 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Mount** | CLONE_NEWNS | 2.4.19 (2002) | 挂载点视图 | CAP_SYS_ADMIN | 文件系统隔离 |
| **UTS** | CLONE_NEWUTS | 2.6.19 (2006) | 主机名/域名 | CAP_SYS_ADMIN | 标识隔离 |
| **IPC** | CLONE_NEWIPC | 2.6.19 (2006) | System V IPC | CAP_SYS_ADMIN | IPC 资源隔离 |
| **PID** | CLONE_NEWPID | 2.6.24 (2008) | 进程 ID | CAP_SYS_ADMIN | 进程视图隔离 + 完整回收 |
| **Network** | CLONE_NEWNET | 2.6.24 (2008) | 网络栈 | CAP_SYS_ADMIN | **网络隔离 + Egress 控制前提** |
| **User** | CLONE_NEWUSER | 3.8 (2013) | 用户/组 ID | **不需要** | **rootless + 权限降级** |
| **Cgroup** | CLONE_NEWCGROUP | 4.6 (2016) | cgroup 视图 | CAP_SYS_ADMIN | cgroup 信息隐藏 |
| **Time** | CLONE_NEWTIME | 5.6 (2020) | 单调时钟 | CAP_SYS_ADMIN | checkpoint/restore 时间连续性 |

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    subgraph "Linux Namespace 演进时间线"
        T1["Mount (2002)<br/>Linux 2.4.19"]
        T2["UTS + IPC (2006)<br/>Linux 2.6.19"]
        T3["PID + Network (2008)<br/>Linux 2.6.24"]
        T4["User (2013)<br/>Linux 3.8"]
        T5["Cgroup (2016)<br/>Linux 4.6"]
        T6["Time (2020)<br/>Linux 5.6"]
        T1 --> T2 --> T3 --> T4 --> T5 --> T6
    end

    subgraph "Agent 沙箱必需组合"
        M["Mount<br/>文件系统隔离"]
        P["PID<br/>进程视图 + 回收"]
        N["Network<br/>Egress 控制前提"]
        U["User<br/>权限降级"]
        C["Cgroup<br/>资源信息隐藏"]
    end

    classDef early fill:#44475a,stroke:#6272a4,color:#f8f8f2
    classDef mid fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef late fill:#50fa7b,stroke:#50fa7b,color:#282a36
    classDef essential fill:#ff79c6,stroke:#ff79c6,color:#282a36

    class T1,T2 early
    class T3,T4 mid
    class T5,T6 late
    class M,P,N,U,C essential
```

---

## 第 3 章 namespace 的组合使用

### 3.1 单一 namespace 不够

从第 2 章的逐个分析中可以清楚看到——单一 namespace 几乎都不足以构成有意义的隔离：

- 只有 mount namespace？进程还能看到外部进程（PID 共享）、使用宿主机网络（网络共享）
- 只有 PID namespace？`ps` 还是显示宿主机进程（因为 `/proc` 还是宿主机的）
- 只有 network namespace？文件系统、进程、用户都还共享

有意义的隔离需要**组合使用多种 namespace**——这正是容器运行时（Docker/runc）做的事。可以把 namespace 组合理解为"给进程套上多层滤镜"：每层滤镜遮蔽一个维度的视图，全部套上之后，进程眼中的世界才是一个"独立系统"。

这里还有一个容易忽略的顺序问题：无特权用户单独创建 user namespace 之外的任何 namespace 都是做不到的，但在一个新建的 user namespace 内部，进程会获得该 namespace 中的全部能力（包括 CAP_SYS_ADMIN）——于是**"先建 user namespace、再在里面创建其余 namespace"成为无特权沙箱的标准配方**：bubblewrap、Flatpak 与 runc 的 rootless 模式走的都是这条路。这也意味着，若 user namespace 的创建被系统策略卡住（第 4 章的 Ubuntu 限制即属此类），整个无特权沙箱栈都会跟着失效。

### 3.2 容器的标准 namespace 组合

Docker 创建一个容器时，默认创建以下 namespace 组合：

| Namespace | 为什么需要 |
| :--- | :--- |
| **Mount** | 隔离文件系统视图——容器看到自己的 overlayfs 根 |
| **PID** | 隔离进程视图——容器只看到自己的进程 |
| **Network** | 隔离网络栈——容器有自己的 IP 和端口 |
| **IPC** | 隔离 IPC 资源——容器的共享内存不被其他容器看到 |
| **UTS** | 隔离 hostname——容器有自己的主机名 |
| **Cgroup** | 隔离 cgroup 视图——容器不知道宿主机的 cgroup 结构 |

**User namespace 默认不启用**——传统 Docker 容器内的 root 就是宿主机的 root（这是容器逃逸风险高的核心原因）。rootless 模式（Podman / Docker rootless）才启用 user namespace，把容器内的 root 映射为宿主机的非特权用户。

**Time namespace 默认不启用**——只在 checkpoint/restore 场景（如 CRIU）中使用。

### 3.3 Agent 沙箱的 namespace 需求

Agent 沙箱对 namespace 的需求与容器类似，但有两个额外强调：

**Network namespace 是必须的**——Agent 沙箱必须做 Egress 网络过滤（防止数据外泄，攻击链第 4 步），而 Egress 过滤的前提是 Agent 在独立的 network namespace 中——这样才能对该 namespace 的网络流量做独立控制。**没有独立网络 namespace 的"沙箱"，在网络维度上不构成沙箱**。

**User namespace 强烈推荐**——Agent 代码是不可信的，如果它在容器内获得了 root 权限并通过内核漏洞逃逸到宿主机，后果严重。User namespace 把容器内的 root 映射为宿主机的非特权用户——即使逃逸，也只有非特权权限。**user namespace 是"把逃逸的爆炸半径从 root 降为普通用户"的关键机制**。

> [!info] 核心概念：runc 官方推荐 user namespace 作为容器逃逸防御
> 2025 年 11 月的 runc CVE 披露中，官方明确推荐："Use containers with user namespaces (with the host root user not mapped into the container's user namespace). This will block most of the most serious aspects of these attacks."——使用 user namespace（且不把宿主机 root 映射进容器的 user namespace），可以阻止这些攻击中最严重的部分。原因是这些攻击利用的 `/proc` 文件受 Unix DAC 权限保护——user namespace 内的用户没有权限访问相关文件。这说明 user namespace 不只是"让 rootless 容器成为可能"的便利特性，而是"对抗容器逃逸"的关键防御层。
>
> 对 Agent 沙箱平台的工程含义：**在镜像构建与运行时配置中显式声明 user namespace 策略**（如 OpenSandbox 部署时要求沙箱 Pod 以非 root 或 user namespace 映射运行），是安全基线的一部分，而不是可选项。

---

## 第 4 章 User Namespace 的安全争议

### 4.1 矛盾的核心

User namespace 的核心矛盾：

**正面**：让非特权用户可以创建隔离环境——rootless 容器、沙箱、应用沙箱化（如 Chrome 的渲染进程用 user namespace 隔离）。这降低了容器使用的门槛，也让更多应用可以用 namespace 做隔离。

**负面**：让非特权用户可以进入"有 CAP_SYS_ADMIN/CAP_NET_ADMIN 等特权的环境"——虽然这些特权只在 namespace 内有效，但它们让进程可以触及内核中需要这些特权的代码路径。这些代码路径中可能存在未被充分审计的漏洞——因为历史上只有 root 才能到达这些路径，审计强度不如"任何人都能到达"的路径。

可以用一个比喻来概括：**user namespace 就像给每个公民发了一张"临时市长证"——在本市范围内可以指挥一切，出了市界证件立刻失效**。便利性无可置疑，但"人人都能当市长"也意味着人人都能走进只有市长才进得去的市政大楼——而那里的某些房间未必经得起这么多人参观。

### 4.2 CVE-2024-1086——user namespace 成为漏洞的"门"

CVE-2024-1086 是 netfilter `nf_tables` 子系统的一个 use-after-free 漏洞（CVSS 7.8）。正常情况下，配置防火墙（`nf_tables`）需要 root 权限——无特权用户无法触及这个代码路径。但通过 user namespace，无特权用户可以创建一个自己在其中是 root 的 namespace，获得 `CAP_NET_ADMIN`，从而可以配置 `nf_tables`——把漏洞的代码路径置于无特权用户的触达范围内。

研究者 Notselwyn 在 2024 年 3 月发布了高度可靠的漏洞利用代码，覆盖内核 5.14 到 6.6——一个"可靠的无特权本地提权漏洞"是极其危险的武器。

**争论**：这个漏洞应该归咎于 `nf_tables` 子系统（代码有 bug）还是 user namespace（让无特权用户能到达有 bug 的代码）？两种观点都有支持者——内核开发者倾向于"nf_tables 应该更安全"，安全研究者倾向于"user namespace 不应该让无特权用户到达这里"。

**Agent 沙箱的启示**：CVE-2024-1086 展示了"隔离机制本身成为攻击面"的悖论。对 Agent 沙箱平台，这意味着：**安全基线不能只依赖"我们用了 user namespace"，还要持续跟踪内核安全公告、规划内核升级节奏**——素材中生产化调研把"内核版本门禁"列为 gVisor/Kata 等强隔离运行时的前置条件，正是这个逻辑。

### 4.3 Ubuntu 24.04 的限制与三次绕过

Ubuntu 23.10 首次引入了对无特权 user namespace 的限制（opt-in），24.04 则默认开启 `kernel.apparmor_restrict_unprivileged_userns`——策略是"允许创建但拒绝在 namespace 内获得额外能力"：让 rootless 容器仍能工作（只需要基本隔离），但阻止利用 user namespace 触达特权代码路径。内核侧"LSM 仲裁 userns 创建"的能力 6.1 合入上游、AppArmor 的 userns 规则 6.7 落地，但"unconfined 一律拒绝 + sysctl 开关"仍是 Ubuntu 特有的补丁式方案。

但 Qualys 发现了三种绕过方式：
1. **aa-exec 绕过**：使用 `aa-exec` 切换到预配置的允许完整 user namespace 的 AppArmor profile（如 Chrome、Flatpak 的 profile）
2. **busybox 绕过**：通过 busybox shell 绕过限制
3. **第三种绕过**：详见 Qualys 报告

这证明"在操作系统层面限制 user namespace 的能力"在实践中很难做到无缝——系统中总有预配置的 profile 留有"合法使用 user namespace"的通道，攻击者可以利用这些通道。

> [!note] 设计哲学：user namespace 的"民主化隔离"悖论
> User namespace 的设计初衷是"民主化隔离"——让非特权用户也能创建隔离环境，不依赖 root。这个初衷是好的——它让 rootless 容器、应用沙箱化成为可能。但"民主化"也意味着"更多人能触达更多内核代码路径"——包括那些有漏洞的路径。这是一个经典的"安全民主化悖论"——降低使用门槛让更多人受益于安全特性，但同时也扩大了攻击面。Ubuntu 的限制尝试和三次绕过证明，这个悖论没有简单的解决方案——你很难在"让合法用户用"和"阻止攻击者用"之间做出完美区分。

### 4.4 2025-2026：限制的扩散与 runc 的官方立场

到 2025 到 2026 年，这个争议出现了两个值得注意的新动向。

其一，Ubuntu 之外的发行版大多没有跟进"默认限制"——因为 rootless 容器、Chrome 渲染进程、Flatpak 都依赖无特权 user namespace，一刀切关闭的兼容性代价远超安全收益。Ubuntu 自己的方案也不是没有成本：**限制一旦生效，所有依赖 userns 的沙箱栈（包括 rootless runc、bubblewrap）都会在无 AppArmor profile 时静默失效**——故障表现为"莫名权限不足"，比漏洞本身更难排查。

其二，runc 在 2025 年 11 月 5 日一次性披露了三个高危容器逃逸：CVE-2025-31133（maskedPath 滥用导致任意 bind mount）、CVE-2025-52565 与 CVE-2025-52881（任意写 gadget 与 procfs 写重定向，含 `/dev/console` 挂载竞态），修复版本为 1.2.8 / 1.3.3 / 1.4.0-rc.3。官方缓解建议的第一条始终是同一句话——**"用 user namespace，且不要把宿主 root 映射进容器"**。于是出现了一个耐人寻味的图景：2024 年的 CVE-2024-1086 让 user namespace 被质疑为"攻击面放大器"，2025 年的 runc 三连又把它确认为"最有效的逃逸缓解"——同一机制在相邻两年里同时扮演问题与答案，安全领域向来如此：**机制的取舍取决于威胁模型，而不是机制本身的名声**。可操作的含义是：user namespace 照用，同时把"内核版本 ≥ 修复线 + 跟进上游公告"当作配套约束。

---

## 第 5 章 cgroups——资源限制的"账本"

### 5.1 账本视角：namespace 管视图，cgroups 管用量

第 1 章说过，namespace 改变的只是视图，资源本身仍是全局共享的——一个被困在独立 namespace 里的进程，照样可以把宿主机的 CPU 烧满、把内存耗到全局 OOM、把磁盘 I/O 打到邻居的"不可用"。**cgroups（control groups，控制组）补的正是这一环：为每个进程组记账并设限**。

引入背景要追溯到 2006 年：Google 的工程师（Paul Menage 与 Rohit Seth）讨论"如何把一组进程的资源用量管起来"时，提出了 container groups 的雏形——后来因为 "container" 一词歧义太重（与容器概念撞车），才改名 cgroups。2008 年（Linux 2.6.24）合入内核，与 PID namespace、network namespace 同一年落地。有意思的是它的原始动机并非容器安全，而是数据中心的资源计量与公平调度；容器把它捡起来当隔离工具，属于典型的"机制先行、用途后置"。

可以把这个机制想成"小区物业的账本"：**namespace 决定每户看见什么样的户型图，账本记录每户的水电用量并规定"这户一个月最多用多少度电"**。没有账本，任何一户都能拉掉整栋楼的电闸；只有账本而没有户型图，住户虽然知道自己被限了额度，却不知道自己隔壁还住着谁。

### 5.2 从 v1 到 v2：一次迟到的架构修正

cgroup v1 的设计是"每个控制器一棵树"：cpu、memory、blkio、pids 等每个控制器各挂一棵独立的层级树，一个进程可以同时挂在多棵树上。这带来两个后果——其一，想把一个进程"完整地"限制住，必须同时操作多棵树上的多个节点，配置分散且无法原子地一起改；其二，"这个进程到底属于哪个组"在不同控制器语境下答案不同，语义混乱。

v2（Linux 4.5，2016）把全部控制器统一到一棵树上，一次迟到的架构修正：`cgroup.controllers` 列出该节点可用的控制器，`cgroup.subtree_control` 声明把哪些控制器下发给子树——父组没有下发的，子组想用也用不了，控制权限沿树逐级委托。v2 还引入两个关键语义：其一是"内部进程约束"（no internal processes），**一个组要在它下面再建子组，它自己就不能再容纳进程**——"进程到底属于哪个叶子组"永远清晰；其二是 threaded 模式，让需要"部分进程单独设限、其余共享父级限制"的场景把自己的线程标为 threaded 子树的一部分。这让"把某棵子树的控制权完整交给另一个用户"（delegation）第一次可操作——这是 5.5 节的前提。

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    ROOT["/（根 cgroup）<br/>cgroup.controllers: cpu memory io pids"] --> SYS["system.slice"]
    ROOT --> USER["user.slice"]
    SYS --> CT["容器 cgroup<br/>subtree_control: cpu memory"]
    CT --> PROC["容器内进程组"]
    USER --> A["user@1000.service"]
    A --> D["delegated cgroup<br/>（rootless 容器账本）"]

    classDef root fill:#bd93f9,stroke:#bd93f9,color:#282a36
    classDef slice fill:#44475a,stroke:#6272a4,color:#f8f8f2
    classDef ctr fill:#ff79c6,stroke:#ff79c6,color:#282a36
    classDef dlg fill:#50fa7b,stroke:#50fa7b,color:#282a36
    class ROOT root
    class SYS,USER slice
    class CT,PROC ctr
    class A,D dlg
```

上图是 v2 层级的一个简化示例：系统服务与用户服务分属不同 slice，容器挂在自己那一支下，rootless 容器则落在被委托给用户的子树上。

### 5.3 沙箱常用的四个控制器

v2 的控制器有十余种，Agent 沙箱最常用的是下面四个：

| 控制器 | v2 关键文件 | 语义 | 沙箱场景 |
| :--- | :--- | :--- | :--- |
| **cpu** | `cpu.max`（quota/period）、`cpu.weight` | 绝对配额 / 相对权重 | 防死循环烧满宿主机 |
| **memory** | `memory.max`、`memory.high` | 硬上限（触顶 OOM）/ 软上限（触顶节流） | 防无限分配拖垮节点 |
| **pids** | `pids.max` | 进程数上限 | 防 fork 炸弹 |
| **io** | `io.max` | 磁盘带宽/IOPS 上限 | 防 I/O 抢占邻居 |

四个控制器各自堵住一种"模型生成代码的典型恶行"：死循环烧 CPU、无限递归与无界分配吃内存、fork 风暴在 pids 控制器面前几秒内就会触顶、疯狂读写磁盘抢占 io。值得强调的是 memory 的两级设计：`memory.high` 是"软上限"，触顶后内核对该组进程节流并回收页面，进程还能运行；`memory.max` 是"硬上限"，触顶即在该组内执行 OOM 判定并杀进程。**"先 high 后 max"的分级就像两道闸门**——先让 Agent 变慢，再在它确实失控时干净利落地杀掉。

### 5.4 PSI：比使用率更早的压力信号

PSI（Pressure Stall Information，压力停滞信息）是 Linux 4.20（2018）引入的指标，经 `/proc/pressure/{cpu,memory,io}` 与每个 cgroup 内的 `cpu.pressure` 等文件暴露。它统计的不是"资源用了多少"，而是"任务因等资源停滞了多久"——`some` 表示"部分任务在等"，`full` 表示"所有非空闲任务都在等"。

为什么沙箱调度需要 PSI？因为"使用率"是个滞后指标：内存使用率 90% 时危机已经发生，而 memory.pressure 会在回收风暴出现之前就持续报高——**PSI 是"气压计"，使用率只是"事后温度计"**。Kubernetes 的节点级驱逐、负载感知调度都在往 PSI 演进；对 Agent 沙箱而言，可落地的用法是把沙箱组的 `memory.pressure` 当作"邻居在抢内存"的早期信号：`full` 抬升时先收缩配额或降级低优先级沙箱，而不是等 OOM 后再善后。

### 5.5 委托与 rootless 沙箱

cgroup v2 的 delegation（委托）机制，即把某个子树目录的写权限与 `subtree_control` 的下发权交给非特权用户——被委托的用户可以在自己名下建组、设限，但碰不到树的其他部分。rootless 容器正是靠它拿到"自己的资源账本"：Podman/rootless runc 在用户会话的 cgroup 子树下为每个容器建组，限额由普通用户自己管理，影响不到宿主上其他用户的组。cgroup namespace（2.7 节）的作用是让容器内看到"自己的组就是根"——一个管权限边界、一个管视图。

### 5.6 边界与反例

cgroups 并非万能的资源闸门，有几条边界值得写下来。其一，**cgroups 管不到的资源比想象中多**——文件锁、inotify 实例、信号量等对象并不归任何控制器管，且"内存使用量"不等于 RSS（还要计入 page cache、socket 缓冲、tmpfs/共享内存），只看 RSS 做配额会严重低估。其二，**cgroups 依赖进程"自觉待在组里"**：拥有 CAP_SYS_ADMIN 的进程可以把自己的子进程移进或移出 cgroup、甚至新建组绕开限制——所以 cgroup 必须与 capabilities、seccomp 配合，否则"限了白限"。其三，v2 的"内部进程约束"对容器是隐性陷阱：容器内直接运行 systemd 这类"既要管子单元又要自己容纳进程"的软件会撞上限制，需要 threaded 模式或调整结构。

最后是时效更新：**cgroup v1 正在系统性退役**。systemd 256（2024）默认拒绝在 v1 层级上启动，systemd 258（2025 年 9 月）彻底移除了 v1 支持；RHEL 9.4 宣布弃用 cgroups v1，RHEL 10 只支持 v2；Kubernetes 从 v1.31 起把 cgroup v1 置于维护模式，KEP-5573 计划最终移除其代码。对 2026 年新建的沙箱平台，这意味着可以直接按 v2 设计资源模型，不必为 v1 兼容留退路。

---

## 第 6 章 seccomp——系统调用过滤器

### 6.1 起源：从"四调用的监狱"到 BPF 过滤器

seccomp（Secure Computing，安全计算模式）的历史比多数人以为的更长。2005 年，Andrea Arcangeli 为了在网格计算场景中"安全运行他人代码"（他当时甚至设想过买卖闲置 CPU 周期的市场），提交了最初的实现并于 Linux 2.6.12 合入：进程一旦写 `1` 到 `/proc/PID/seccomp`，就只能执行 read、write、exit、sigreturn 四个系统调用，其余任何调用直接 SIGKILL。这个 SECCOMP_MODE_STRICT 模式本质是"只有四个洞的监狱"，用途极窄。2007 年（2.6.23）接口改为 prctl(PR_SET_SECCOMP)，2014 年（3.17）seccomp(2) 成为正式系统调用。

真正的转折在 2012 年：Google 的 Will Drewry 为 Chromium/ChromeOS 设计了 seccomp-bpf（SECCOMP_MODE_FILTER，Linux 3.5），用 BPF（Berkeley Packet Filter）语言——tcpdump 的老朋友——编写过滤器，可以按系统调用号和参数做精细判断。Chrome 23 起渲染进程的下一代沙箱就建立在这套机制上，OpenSSH、vsftpd 等对攻击面敏感的程序也相继跟进。seccomp 由此完成了从"监狱"到"过滤器"的转变：**它不再把进程锁死，而是给每个系统调用设一道安检门**。可以把它想成大厦门口的访客系统——进门前先刷证件（系统调用号）再报目的楼层（参数），符合白名单才放行，可疑的直接拒之门外。

### 6.2 过滤器的执行路径与动作裁决

一个线程安装了过滤器之后，内核会在它的线程标志里置上 TIF_SECCOMP。此后每次系统调用进入内核，都会先走一遍过滤器逻辑：输入是一个 `seccomp_data` 结构（包含系统调用号 nr、架构号 arch、指令指针与最多 6 个参数），BPF 程序据此裁决。BPF 程序不允许解引用指针、不允许循环，执行时间被指令数严格约束——这带来一个对安全至关重要的性质：**seccomp 天然免疫 TOCTOU（time-of-check-to-time-of-use）竞争**。对比 ptrace 类拦截器（如 gVisor 早期 platform）需要先"看"参数再决定、参数可能在两次检查之间被改掉，seccomp 的裁决与执行发生在内核同一条路径上，不存在这个窗口。

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph LR
    A["用户态进程<br/>调用 syscall"] --> B["进入内核<br/>syscall 入口"]
    B --> C{"TIF_SECCOMP 置位？"}
    C -->|否| F["按 syscall 表正常分发"]
    C -->|是| D["执行 BPF 过滤器<br/>输入: seccomp_data<br/>nr / arch / ip / args[0..5]"]
    D --> E{"动作裁决"}
    E -->|ALLOW| F
    E -->|ERRNO| G["返回 EPERM / ENOSYS"]
    E -->|KILL_PROCESS| H["杀死整个进程"]
    E -->|USER_NOTIF| I["挂起 syscall<br/>通知用户态监听者"]
    I --> J["监听者模拟执行后<br/>CONTINUE 或注入结果"]

    classDef user fill:#44475a,stroke:#6272a4,color:#f8f8f2
    classDef kernel fill:#bd93f9,stroke:#bd93f9,color:#282a36
    classDef decision fill:#ff79c6,stroke:#ff79c6,color:#282a36
    class A user
    class B,D,F kernel
    class C,E,I decision
    class G,H,J kernel
```

过滤器最终产出一个动作（action），动作之间有严格优先级：KILL_PROCESS > KILL_THREAD > TRAP > ERRNO > USER_NOTIF > TRACE > LOG > ALLOW。多个过滤器叠加时取"最严格"的那个结果，而非"先到先得"。Docker 的默认 seccomp profile 就是"白名单 + ERRNO"的标准形态：`defaultAction` 为 `SCMP_ACT_ERRNO`（默认拒绝、报 Permission Denied），再放行约 260 个常用调用，屏蔽 300 多个中的约 44 个。值得注意一个细节：过滤器**按线程**生效，新线程经 clone 继承，但多线程程序里若存在"过滤器安装前就存在的线程"，需要 SECCOMP_FILTER_FLAG_TSYNC 同步一次——这是沙箱跑多线程负载时容易踩的坑。

### 6.3 seccomp-user-notification：把裁决交给用户态

seccomp 过滤器是静态的——同一个调用，要么放行要么拒绝，无法"看了具体内容再决定"。Linux 4.14（2017）加入的 SECCOMP_RET_USER_NOTIF 打破了这一点：过滤器可以返回 USER_NOTIF，内核随即挂起该系统调用，向监听者（经 SECCOMP_FILTER_FLAG_NEW_LISTENER 创建的通知 fd）发送消息；用户态的守护进程通过 ioctl(NOTIF_RECV / NOTIF_SEND) 读取调用参数、在用户态模拟执行后返回结果，甚至可以用 NOTIF_ADDFD 往被挂起进程的文件描述符表里"塞"进一个 fd，或用 SECCOMP_USER_NOTIF_FLAG_CONTINUE 放行原调用。

seccomp-user-notification 的应用在 2025-2026 年变多了。容器运行时 LXC 用它做系统调用"虚拟化"——譬如容器内进程执行 mknod 时，由宿主侧监听者代为完成需要真实特权（CAP_MKNOD）的操作；Anbox（Android in a Box）靠它模拟安卓期望的行为；2025 年开源的 SocksTrace 把代理泄漏检测从 ptrace 迁到 notify——ptrace 每步都要停下整个进程，notify 只拦关心的调用；Rust 生态的 Syd 则把 seccomp-notify 做成"应用级内核"，在用户态模拟整套系统调用语义。

但 notify 有它的结构性局限：**一个进程树上只能存在一个带 listener 的过滤器**，第二个会直接返回 EBUSY。容器运行时（LXC）已经占用了 listener 时，容器内的应用（或嵌套的容器运行时）就再也挂不上自己的监听器——LPC2025 专门讨论了"嵌套容器里的 seccomp listener"这一开放问题。对 Agent 沙箱的启示是：notify 是"中间层沙箱"的抓手——不像 ptrace 那样慢，又不像纯 BPF 那样只能静态判断，适合"模拟少量特定调用、其余按白名单放行"的场景；但正因 listener 的排他性，引入前必须想清楚这条进程树上还有没有别人要用。

### 6.4 边界：seccomp 看不到的东西

seccomp 有三个天然盲区，都是沙箱设计者必须知道的。

第一个盲区是**它只看调用号与参数，不看对象身份**。同一个 `open()`，对 `/etc/shadow` 与对 `/tmp/foo` 的裁决无法区分——路径级语义需要交给 LSM 层的 Landlock/AppArmor 来补。seccomp 解决"能不能发这个请求"，LSM 解决"这个请求指向谁"。

第二个盲区是 **io_uring**。io_uring 是内核提供的异步 I/O 框架，本质上是一套"独立于经典系统调用的并行 API"：应用把要做的操作（open、read、connect……）打包成 SQE（submission queue entry）提交进环形队列，内核批量执行。seccomp 只能过滤 `io_uring_setup`、`io_uring_enter` 这些入口调用，对 SQE 里封装的"虚拟系统调用"完全没有可见性——LWN 的原话是："在 seccomp 下允许 io_uring，几乎肯定等于给了程序一条彻底绕过沙箱的通道。"应对措施 2023 年已经落地：Docker 与 containerd 的默认 seccomp profile 直接屏蔽 `io_uring_*` 三个调用（moby#46762、containerd#9320）——安全社区普遍认为 io_uring 不安全，Google 的 ChromeOS、Android 与生产服务器都禁用了它。而 2026 年 4 月发布的 Linux 7.0 终于合入了 Jens Axboe 的补丁：**io_uring 自带的 cBPF 过滤器（按 opcode 精细过滤）与 per-task 继承式限制**——"seccomp 管不到 io_uring"这个结构性缺口第一次有了内建方案。对 Agent 沙箱的当前建议依然是：默认屏蔽 io_uring 相关调用。

第三个盲区是**它不提供对象级与命名空间级的语义**——这恰恰是 Landlock 补位的地方。Landlock LSM 自 5.13（2021）首版以来已演进到 6.15 的 ABI 7（审计日志），是无特权、纯用户态可用的路径级沙箱；2025 年 9 月起维护者 Mickaël Salaün 在推进把 Landlock 配置集成进 systemd（PR #39174），pacman、snapd、Suricata 等已陆续接入。它的定位正是 [[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 中"第二档：系统调用过滤的极致"的代表——细节留给 03 篇，这里只需记住：**seccomp 收窄的是"入口"，Landlock 收窄的是"路径"**。

### 6.5 默认配置现状与 Agent 沙箱建议

Kubernetes 侧，`securityContext.seccompProfile.type: RuntimeDefault` 自 v1.27 起成为 stable 特性，kubelet 加 `--seccomp-default` 后可以为所有未显式声明的工作负载兜底套上运行时默认 profile；而 `privileged: true` 的容器永远是 Unconfined——这是 K8s 官方文档明写的例外，也是"特权容器不可与 seccomp 并存"的铁律。对 Agent 沙箱的落地建议可以收敛成三条：**RuntimeDefault 起步**，让 containerd 的内置白名单先挡住明显有害的调用（`unshare(CLONE_NEWUSER)`、`ptrace`、`mount`、`reboot`、`io_uring_*` 都在屏蔽之列）；**显式禁止 privileged**，宁可另起一个带自定义 profile 的沙箱规格，也不要靠特权容器妥协；**按 Agent 工作负载定制白名单**——RuntimeDefault 是为通用容器设计的，代码解释型 Agent（Python/Node 等运行时）往往还需要追加或移除若干调用，需要在测试集群里逐项验证。

---

## 第 7 章 capabilities——root 的分权

### 7.1 起源：把"万能钥匙"熔成一套"单间钥匙"

传统 Unix 权限模型只有两档：root 与非 root。root 拥有一切，非 root 什么特权都没有——想为某个单一操作授权（譬如只允许调整系统时间），只能给整个 root。capabilities（能力）机制把 root 拆成几十个独立的开关：Linux 2.2（1999）率先实现，其概念源自 1997 年撤回的 POSIX 1003.1e 草案；2.6.24（2008）补上 file capabilities（把能力直接附加到可执行文件上，程序被 exec 时自动获得），2.6.25 起 bounding set 变为 per-thread。

此后的演进几乎是一部"从 CAP_SYS_ADMIN 里往外拆能力"的历史：Linux 5.8 拆出 CAP_BPF 与 CAP_PERFMON，5.9 拆出 CAP_CHECKPOINT_RESTORE，5.12 起向新 user namespace 映射 uid 0 还需要 CAP_SETFCAP——每一次拆分都是内核在承认"这个能力太万能，必须允许单独授予、单独收走"。**capabilities 像是把 root 这把万能钥匙熔成一套每间房单独配的钥匙**：每把钥匙只能开一类门，丢了其中一把，损失范围可控。

### 7.2 位集语义：五个集合与 exec 时的传递

Linux 目前有 41 个能力位（编号 0 到 40）。每个进程维护五张"能力位图"（capability set），其语义是安全建模的核心：

| 集合 | 英文 | 语义 |
| :--- | :--- | :--- |
| **Effective（E）** | CapEff | 内核真正检查的集合——"现在就能用的能力" |
| **Permitted（P）** | CapPrm | 可提升为 E 的上限——"最多能用到的能力" |
| **Inheritable（I）** | CapInh | 跨 exec 传递给子程序的能力 |
| **Bounding（B）** | CapBnd | 进程及其后代永远碰不到的能力边界 |
| **Ambient（A）** | CapAmb | 4.3 加入，非特权进程跨 exec 保住能力的手段 |

exec 执行新程序时，能力集合按固定转换规则重算：新的 Permitted =（Bounding 与文件能力的交集）∪（Inheritable 与文件 Inheritable 的交集）∪ Ambient；新的 Effective 在"文件带能力"时等于 Permitted，否则等于 Ambient。由此可推得几个工程结论：为何"先 drop bounding set 再 exec"才是彻底的降权（Bounding 是硬边界，exec 后无法恢复）；为何 rootless 容器里非特权进程要保住能力必须走 Ambient（Inheritable 在 setuid 面前形同虚设）；以及为何 `PR_SET_NO_NEW_PRIVS`（no_new_privs）如此重要——它保证"exec 一个带文件能力或 setuid 位的程序也不会获得新特权"，seccomp 与 rootless 沙箱都以它为前提。

### 7.3 容器默认能力与三个危险位

Docker 默认给容器保留 14 项能力：CHOWN、DAC_OVERRIDE、FSETID、FOWNER、MKNOD、NET_RAW、SETGID、SETUID、SETFCAP、SETPCAP、NET_BIND_SERVICE、SYS_CHROOT、KILL、AUDIT_WRITE——比宿主 root 的 41 项少了一大截。但必须立刻补充一个限定：**没有 user namespace 时，容器内 root 就是宿主机 root，capabilities 只是"能力集合"层面的收窄，UID 0 的身份并未改变**。这意味着"容器内 root 不等于宿主机 root"这句话，只有叠加了 user namespace（第 4 章）才严格成立；只有 capabilities 时，它顶多算"能力打了折的 root"。

在剩余的默认能力里，有三个位值得沙箱设计者重点警惕。**CAP_SYS_ADMIN** 是公认最危险的位——它覆盖了挂载、命名空间操作、设备管理等一大片子系统，安全社区近乎一致地把"给容器 CAP_SYS_ADMIN"视为"几乎等于给 root"；Docker 默认 profile 的屏蔽列表里，mount 等一票高危调用被 seccomp 挡掉，正是因为就算有 CAP_SYS_ADMIN，也该在调用入口收掉。**CAP_DAC_OVERRIDE** 允许绕过文件的读/写/执行权限检查（DAC 是 discretionary access control，自主访问控制）——配合 bind mount 宿主机目录时，容器 root 凭借它可以直接读宿主上本不该让它读的文件（譬如容器里挂进来的宿主机敏感文件）。**CAP_NET_RAW** 允许构造原始网络报文——这是扫描、伪造流量的入口。Kubernetes 的默认策略比 Docker 更严：非特权容器直接 drop 全部能力（一个都不给），需要时在 securityContext 里按需追加——**"默认全无、按需补充"是比"默认 14 项、按需删除"更安全的心智模型**，Agent 沙箱平台应该照抄后者、而不是沿用 Docker 的默认。

### 7.4 capabilities 与 user namespace 的叠加

capabilities 还有一个常被忽略的性质：**能力是"相对于某个 user namespace"的**。一个进程在它的 user namespace 里可能拥有全部能力，但这些能力只对"该 namespace 内、以及它作为所有者创建并映射了 uid 的对象"有效——对宿主机上 root 拥有的文件与资源，这些能力形同虚设。第 4.4 节 runc 缓解建议的底层原理即在于此：把宿主 root 排除在容器 uid_map 之外，容器内进程即使拿到全部能力，也够不着宿主的敏感对象。

三个原语叠加起来，才构成完整的"降权链条"：**user namespace 降身份（uid 0 映射成普通用户），capabilities 降能力（41 位收窄到个位数），seccomp 降入口（高危调用直接拒之门外）**——少了任何一环，链条就断，这也是 2026 年的 Agent 沙箱平台把它们当作不可拆分的"安全三件套"一起配置的原因。

### 7.5 边界与反例

capabilities 的两个经典反例值得写进沙箱清单。其一是 **file capabilities 提权链**：非特权用户可以给自己拥有的可写文件设置文件能力（cap_setfcap），而"设置文件能力"恰恰是 CAP_SETFCAP 允许的——于是"给 ping 一个 CAP_NET_RAW"这类做法成立的前提是"你能写那个文件"。镜像层里若藏着带文件能力的可执行程序（譬如打包时误加 `setcap` 的二进制），它在沙箱内被 exec 时会自动获得对应能力——这是镜像供应链审计的一个具体检查点。其二是 **bounding set 的时序**：drop 只能发生在 exec 之前，运行中再 drop 对已获得的 Permitted/Effective 没有追溯力；Ambient 集合也会在 setuid/setgid 转换时被无条件清空。验证手段上，`capsh --print` 与 `getpcaps` 是标准工具，可以直接读出"容器内 root 到底有多大权力"。

---

## 第 8 章 从隔离原语到运行时：CRI 链路的七跳

### 8.1 原语在沙箱平台中的"最后一公里"

前面几章讨论的四类原语都是"内核机制"，但在一个 Kubernetes 化的 Agent 沙箱平台（如 OpenSandbox）中，它们的创建与配置不是由平台直接调用 `clone()` 或 `prctl()` 完成的，而是通过一条完整的 CRI（Container Runtime Interface）链路间接完成的。理解这条链路，才能回答"沙箱里的 namespace、cgroup、seccomp 过滤器在哪个环节创建"。OCI runtime-spec 的 `linux.namespaces`、`linux.resources`、`linux.seccomp`、`linux.capabilities` 四个字段，正是从这条链路落到内核里的。

素材调研（Phase1-03）给出了这条链路的完整形态——**七跳**：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph LR
    A["Sandbox CR<br/>runtimeClassName"] --> B["RuntimeClass<br/>handler"]
    B --> C["kubelet<br/>选择运行时"]
    C --> D["CRI 接口<br/>runtimeHandler"]
    D --> E["containerd<br/>插件注册"]
    E --> F["shim 进程<br/>runc/runsc/kata"]
    F --> G["agent 进程<br/>创建容器+namespace"]

    classDef hop fill:#44475a,stroke:#6272a4,color:#f8f8f2
    class A,B,C,D,E,F,G hop
    class A fill:#bd93f9,stroke:#bd93f9,color:#282a36
    class G fill:#50fa7b,stroke:#50fa7b,color:#282a36
```

这条链路把"隔离"这件产品的生产拆成一条流水线——**声明、解析、路由、执行各司其职**：任何一环的图纸错了，成品都不是你要的那件。**第 1 跳：Sandbox CR 声明**。用户在 BatchSandbox/Sandbox CR 的 podTemplate 中声明 `runtimeClassName`——例如 `gvisor` 或 `kata-qemu-runtime-rs`。这只是一个字符串声明，没有任何执行语义。

**第 2 跳：RuntimeClass 解析**。kubelet 读取 RuntimeClass 对象，取出其中的 `handler` 字段（如 `runsc`、`kata-qemu-runtime-rs`）。RuntimeClass 还携带 `overhead`（Pod 额外开销）与 `scheduling`（节点选择器）字段——后者决定这类运行时 Pod 只能调度到特定节点。

**第 3 跳：kubelet 决策**。kubelet 是 K8s 侧唯一真正"看见"运行时差异的组件——它根据 handler 决定把容器创建请求发给哪个运行时插件。

**第 4 跳：CRI 接口**。kubelet 通过 CRI（gRPC 协议）调用 containerd 的 `runtimeHandler` 参数——一个字符串，用于选择 containerd 内注册的运行时插件。

**第 5 跳：containerd 插件注册**。containerd 的配置文件（`/etc/containerd/config.toml`）中注册了多个运行时插件：默认的 `runc`，以及可选的 `runsc`（gVisor）、`kata-qemu-runtime-rs`（Kata）。每个插件对应一个 handler 名。**如果 containerd 里没有注册对应插件，前面所有声明都会在运行时失败**——这是"四层必须一致"的第一个断裂点。

**第 6 跳：shim 进程**。containerd 为每个容器拉起一个 shim 进程（containerd-shim-runc-v2 / containerd-shim-runsc-v1 / containerd-shim-kata-v2），shim 是容器进程的"直接父进程"，负责 stdin/stdout 转发、信号传递、退出状态上报。

**第 7 跳：运行时 agent**。shim 调用运行时组件（runc 直接操作 OCI bundle；runsc 创建用户态内核沙箱；kata-runtime 启动 QEMU/Cloud Hypervisor VM）——**namespace 的 `clone()` 调用、cgroup 的创建与限额写入、seccomp 过滤器的装载、capabilities 的裁剪都发生在这里**，依据的就是 OCI bundle 里那份 config.json。

### 8.2 四层必须一致：一个断裂点的教训

素材调研（Phase5-02）把这条链路总结为"四层必须一致"：

| 层 | 配置位置 | 断裂表现 |
| :--- | :--- | :--- |
| Server 配置 | OpenSandbox server 的 `secure_runtime` 配置 | 平台以为在用强隔离，实际 Sandbox 没带 runtimeClassName |
| CR/Pod 声明 | BatchSandbox podTemplate 的 `runtimeClassName` | 请求没指定 handler，走到默认 runc |
| RuntimeClass 定义 | 集群中的 RuntimeClass 对象 | handler 与 containerd 插件名不一致 |
| containerd 注册 | `/etc/containerd/config.toml` | 插件未安装/未注册，容器创建失败 |

这四层任何一层不一致，都会产生"**你以为在隔离，实际没有**"的静默失效——比"创建失败"更危险，因为创建失败会立即暴露，而静默降级不会。PoC 中笔者就遇到了"通过 Helm 修改 secure_runtime 配置后，必须手动 rollout restart server 才生效"的坑（Issue-021）——配置声明与实际运行时之间的传播不是即时的。

### 8.3 隔离证据链：如何验证"沙箱真的隔离了"

七跳链路带来一个工程问题：**配置声明与运行事实可能脱节，如何证明沙箱确实运行在预期的隔离级别？** 素材中 Kata 运行时全流程手册给出了一套"隔离证据链"方法论——不依赖平台自报，而是从多个独立层面交叉取证：

| 证据层 | 验证命令/手段 | 证明什么 |
| :--- | :--- | :--- |
| **guest 内核** | 沙箱内执行 `uname -r` | 与宿主机内核版本不同 → 运行在独立内核（Kata/gVisor） |
| **QEMU/VM 进程** | 宿主机 `ps aux \| grep qemu` | 存在 VM 进程 → 硬件虚拟化生效 |
| **namespace inode** | 对比沙箱内与宿主机 `/proc/self/ns/*` inode | inode 不同 → namespace 隔离生效 |
| **RuntimeClass 注入** | `kubectl get pod -o yaml` 查 runtimeClassName | 声明与事实一致 |
| **CRI 层** | `crictl info` / containerd 日志 | 确认实际使用的 runtime handler |

笔者在 PoC 中的实操流程是：创建沙箱 → 手敲 CLI 采集上述五层证据 → 形成一份"隔离证据链"记录。这套方法论的价值在于：**任何一层证据缺失，都意味着"你以为的隔离"与"实际的隔离"出现了偏差**——例如 runtimeClassName 声明了 Kata 但 Pod 实际跑在 runc 上（四层不一致的典型场景），只有通过证据链交叉验证才能发现。在此基础上，第 7.5 节的"CapEff 位图"、`/proc/self/status` 的 `Seccomp` 字段、cgroup 归属路径，都可以作为第六、第七层证据——**隔离的每一层都应该有独立于平台自报的可观测读数**。

### 8.4 RuntimeClass 与 Pod Overhead：调度器的盲区

七跳链路之外还有一个被素材标记为 GAP-011 的调度问题：**RuntimeClass 的 `overhead` 字段没有被 OpenSandbox 的调度正确使用**。gVisor 空闲时 PSS 约 127.2MiB，Kata 约 392.7MiB（[[12 沙箱性能工程——Runtime 基准与 WarmPool 容量管理]] 的实测数据），但调度器按普通容器（几十 MiB）计算节点容量——强隔离运行时的真实内存开销被"漏记"了。结果：节点上调度了大量 Kata 沙箱后，实际内存占用远超调度器的账本，OOM 风险被系统性低估。这是"隔离运行时引入 K8s"时特有的记账问题，也是 [[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 与生产化章节反复强调"overhead 必须按镜像族×运行时×节点机型实测"的原因。

---

## 第 9 章 为什么隔离原语单独不足以构成沙箱

### 9.1 三个根本不足

第 5 到第 7 章拆解了 cgroups、seccomp、capabilities 的机制，但即便四类原语全部叠满，也仍不足以构成对抗性沙箱。

**不足一：共享宿主内核**

这是最致命的不足。无论 namespace 组合多全面、能力裁剪多严格，容器进程的系统调用仍然由**宿主机内核**处理。namespace 改变的是进程对资源的"视图"，而非资源本身的"处理者"；capabilities 裁剪的是进程在宿主内核面前的"权限面"，而非内核本身的代码。

```
容器进程 → syscall → 宿主机内核（同一个内核）→ 处理 → 返回
```

一个内核漏洞（如 Dirty Pipe CVE-2022-0847）可以让容器进程绕过所有 namespace 隔离——因为漏洞在内核层面，namespace 也在内核层面，绕过 namespace 的内核漏洞直接访问真实资源。

这就是为什么 [[01 Agent 沙箱全景——威胁模型、六层技术栈与逻辑演进]] 讨论的 gVisor 和 Kata/Firecracker 要把信任边界从"共享内核"移开——它们不依赖 namespace 的视图隔离，而是用用户空间内核或硬件虚拟化提供真正的"独立内核"。隔离原语是沙箱的"第一层"，但不是"唯一层"。

**不足二：缺少资源限制**

Namespace 不限制进程能使用多少资源——一个进程在新 namespace 中仍然可以耗尽宿主机的 CPU、内存、磁盘 I/O。资源限制是 cgroups（第 5 章）的职责——namespace 管"能看到什么"，cgroups 管"能用多少"。

一个 Agent 沙箱必须同时做视图隔离（namespace）和资源限制（cgroups）——只做 namespace 不做 cgroups，Agent 执行的代码可能通过 `while(true){}` 循环耗尽宿主机 CPU，或通过 `malloc` 无限分配耗尽宿主机内存。**对 Agent 场景尤其重要：模型生成的代码不受"常识"约束，一个死循环或无限递归是常态而非意外**。

**不足三：缺少系统调用过滤**

Namespace 不限制进程能调用哪些系统调用——一个进程在新 namespace 中仍然可以调用所有系统调用（如 `ptrace`、`mount`、`reboot`）。系统调用过滤是 seccomp（第 6 章）的职责。

一个 Agent 沙箱应该用 seccomp 限制容器进程能调用的系统调用——如禁止 `ptrace`（防止调试其他进程）、禁止 `mount`（防止修改挂载表）、禁止 `reboot`（防止重启系统）。同时 capabilities（第 7 章）把 root 的超级权限拆分：容器默认 drop 大部分，只保留基础项——**"容器内是 root"不等于"容器内有 root 的全部能力"**。

### 9.2 namespace + cgroups + seccomp + capabilities 的四重组合

真正的容器隔离是四种机制的叠加：

| 机制 | 解决什么 | 维度 |
| :--- | :--- | :--- |
| **namespaces** | 视图隔离——进程能看到什么 | 空间 |
| **cgroups** | 资源限制——进程能用多少 | 资源 |
| **seccomp** | 系统调用过滤——进程能做什么 | 行为 |
| **capabilities** | 权限分权——进程的 root 有多大 | 权限 |

四者的关系是"叠加防御"——namespace 是第一层（视图隔离），cgroups 是第二层（资源限制），seccomp 是第三层（系统调用过滤），capabilities 是第四层（权限削减）。任何一层被突破，其他层仍然提供保护。但如果四层都被突破（如一个内核漏洞同时绕过 namespace 和 seccomp），进程就逃逸了——这就是为什么对"不可信代码"还需要 gVisor/Kata/Firecracker 的更强隔离。

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    subgraph "传统容器四重隔离"
        NS["Namespace<br/>视图隔离"] --> CG["Cgroups<br/>资源限制"]
        CG --> SC["Seccomp<br/>系统调用过滤"]
        SC --> CAP["Capabilities<br/>权限分权"]
    end

    subgraph "宿主机内核（共享）"
        KERNEL["Linux Kernel<br/>数百万行 C 代码<br/>最大攻击面"]
    end

    NS -->|"系统调用仍到达"| KERNEL
    CG -->|"不限制系统调用"| KERNEL
    SC -->|"过滤后仍到达"| KERNEL
    CAP -->|"权限削减后仍共享"| KERNEL

    subgraph "更强隔离"
        GV["gVisor<br/>用户空间内核"]
        KATA["Kata/Firecracker<br/>硬件虚拟化"]
    end

    KERNEL -->|"共享内核不安全"| GV
    KERNEL -->|"共享内核不安全"| KATA

    classDef layer fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef kernel fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef strong fill:#50fa7b,stroke:#50fa7b,color:#282a36

    class NS,CG,SC,CAP layer
    class KERNEL kernel
    class GV,KATA strong
```

可以用一句话概括这四层的关系：**它们像四道不同的锁，但都装在同一扇门（宿主机内核）上**——每把锁都增加了撬门的时间成本，可一旦有人拿到门本身的钥匙（一个能绕过所有层的内核漏洞），四把锁同时作废。

> [!info] 核心概念：隔离原语是"必要但不充分"的隔离
> 隔离原语是容器隔离的"必要"组件——没有 namespace，容器进程和宿主机进程共享所有资源视图，谈不上隔离；没有 cgroups，一个沙箱就能耗尽宿主机；没有 seccomp/capabilities，容器内 root 几乎等于宿主机 root。但四重组合仍然不是"充分"的——因为它们都共享宿主内核，一个内核漏洞就能突破所有层。对于运行可信代码的传统容器，四重组合通常够用；但对于运行 AI 生成的不可信代码的 Agent 沙箱，还需要把信任边界进一步移开——到用户空间内核（gVisor）或硬件虚拟化（Kata/Firecracker）。

### 9.3 Agent 沙箱的隔离档位选择

把 9.2 的结论落到 Agent 沙箱选型上，形成"按威胁等级选档位"的决策框架：

| 档位 | 技术组合 | 适合场景 | 代价 |
| :--- | :--- | :--- | :--- |
| **基础档** | 四重隔离原语（runc） | 低风险、内部可信代码、高密度 | 内核共享，逃逸半径大 |
| **中档** | 四重原语 + gVisor | 中风险（代码解释器）、需要容器速度 | syscall 兼容性子集、性能损耗 |
| **高档** | 四重原语 + Kata/Firecracker | 高风险（多租户不可信代码） | 启动慢、内存开销大 |

注意三个档位都"包含"四重隔离原语——**档位差异在于信任边界是否移出宿主内核**，而不是要不要 namespace。这个框架正是 [[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 的完整展开。

---

## 第 10 章 总结与下一篇导读

### 10.1 本文核心要点

1. **namespace 的本质是"视图隔离"**：让进程"以为"自己有独占的资源副本，但不改变资源本身——进程的系统调用仍然到达共享的宿主内核
2. **8 种 namespace 逐步引入**：Mount(2002) → UTS+IPC(2006) → PID+Network(2008) → User(2013) → Cgroup(2016) → Time(2020)，每种隔离一个维度
3. **三个系统调用操纵 namespace**：clone（创建新进程+新空间）、unshare（已有进程+新空间）、setns（已有进程+已有空间）——正交设计覆盖所有操纵维度，nsproxy 是那把钥匙串
4. **namespace 是 inode 数字**：内核通过比较 `/proc/[pid]/ns/` 下的 inode 数字判断进程是否在同一 namespace——极简实现，几乎零内存开销
5. **单一 namespace 不足**：PID namespace 需要 mount namespace 配合才能让 `ps` 正确工作——namespace 之间需要组合，无特权场景则要"先建 user namespace、再建其余"
6. **user namespace 的双刃剑**：无特权创建让 rootless 容器成为可能，但也让无特权用户能触达特权代码路径——CVE-2024-1086 与 Ubuntu 三次绕过证明了危险，2025 年 runc 三连逃逸又把它确认为最有效的缓解
7. **cgroups 是资源账本**：v2 统一层级（4.5）解决 v1 多树混乱，PSI（4.20）提供更早的压力信号；cgroup v1 自 2025 年起系统性退役（systemd 256/258、RHEL 与 K8s）
8. **seccomp 是系统调用安检门**：seccomp-bpf（3.5）起从"监狱"变"过滤器"，动作有严格优先级、天然免疫 TOCTOU；seccomp-user-notification（4.14）把裁决交给用户态；io_uring 曾是结构性盲区，Linux 7.0（2026）内建过滤方案
9. **capabilities 是 root 的分权**：41 个能力位、五个集合、exec 转换规则共同定义"容器内 root 有多大权力"；与 user namespace 叠加，"容器内 root ≠ 宿主机 root"才严格成立
10. **namespace 到运行时是七跳链路**：CR 声明→RuntimeClass→kubelet→CRI→containerd→shim→agent，四层配置必须一致，否则"你以为在隔离，实际没有"
11. **四重隔离原语仍不构成对抗性沙箱**：共享宿主内核是共同天花板——需要 gVisor/Kata/Firecracker 把信任边界移出内核

### 10.2 下一篇导读

本文深入了隔离原语——容器隔离的"地基"层。下一篇 [[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 将回答一个关键问题：**当四重隔离原语不够时，信任边界应该画在哪里？** 系统调用过滤（seccomp 的极致化）？用户态内核（gVisor 的 Sentry 拦截）？还是硬件虚拟化（Kata/Firecracker 的完整 VM）？三档方案在启动时间、内存开销、兼容性上的实测数据对比，以及"按威胁等级选档位"的决策框架，将在下一篇展开。

> [!info] 专栏导航
> 本文是 [[00 专栏导览]] 的第 02 篇。上一篇 [[01 Agent 沙箱全景——威胁模型、六层技术栈与逻辑演进]] 建立了威胁模型与六层技术栈；本文深入了隔离原语层；接下来第 03-05 篇将完成隔离边界光谱、KVM 硬件虚拟化与 VMM 家族的讨论，构成"隔离运行时"层的完整图景。

### 10.3 思考题

1. **nsproxy 与进程树**：为什么一个进程的 PID namespace 归属终身不可变，而 mount/user/network namespace 却可以中途切换？

2. **无特权创建的顺序依赖**："先建 user namespace、再建其余"是无特权沙箱的标准配方。若发行版默认禁止无特权 userns（如 Ubuntu 24.04），这套配方会以什么形式失效？

3. **cgroup v2 的 no internal processes**：要在容器内运行 systemd 的镜像，为什么可能撞上"内部进程约束"？threaded 模式是唯一解吗？

4. **memory.high 与 memory.max**：为什么 Agent 沙箱应该"先 high 后 max"？只设 max 会怎样？

5. **seccomp 的 io_uring 盲区**：假设沙箱负载确实需要 io_uring，在 Linux 7.0 之前和之后，你的安全设计分别能做什么？

6. **notify 的排他性**：seccomp-user-notification 只能存在一个 listener。execd 想用 notify 做命令级审计、容器内又有一层嵌套运行时，冲突怎么解决？

7. **capabilities 与 userns 的叠加**：为什么"容器内 root + 全部能力"在 user namespace 内不等于"宿主机 root"？

8. **证据链的第六层**：第 8.3 节给出五层隔离证据链。如果要加"能力位图"与"Seccomp 模式"两层，验证命令分别是什么？

---

## 参考文献

1. Linux man pages. "namespaces(7)." https://www.man7.org/linux/man-pages/man7/namespaces.7.html
2. Linux man pages. "clone(2)." https://man7.org/linux/man-pages/man2/clone.2.html
3. Linux man pages. "setns(2)." https://man7.org/linux/man-pages/man2/setns.2.html
4. "Linux Namespaces Explained: All 7 Types with /proc Evidence." https://rootcause.hashnode.dev/what-is-a-linux-namespace-really-all-7-explained
5. "Linux Namespaces and Cgroups — The Foundation of Containerization." https://systeminternals.dev/linux/namespaces/
6. Qualys. "Three bypasses of Ubuntu's unprivileged user namespace restrictions." 2025. https://www.qualys.com/2025/three-bypasses-of-Ubuntu-unprivileged-user-namespace-restrictions.txt
7. "The Linux firewall bug your users can reach because you gave them a private root." https://patchdayalert.com/blog/linux-cve-2024-1086-nf-tables-user-namespaces/
8. opencontainers/runc. "runc container escape via masked path abuse due to mount race conditions"（CVE-2025-31133，与 CVE-2025-52565/CVE-2025-52881 同批披露，2025-11-05）. https://github.com/advisories/GHSA-9493-h29p-rfm2 ；同批公告 GHSA-qw9x-cqr3-wc7r、GHSA-cgrx-mc8f-2prm
9. Kubernetes 文档. "RuntimeClass." https://kubernetes.io/zh-cn/docs/concepts/containers/runtime-class/
10. agent-sandbox 调研素材. Phase1-03 隔离边界对比、Phase5-02 RuntimeClass 与 Pod Overhead
11. Linux man pages. "capabilities(7)." https://man7.org/linux/man-pages/man7/capabilities.7.html
12. Linux man pages. "seccomp(2)." https://man7.org/linux/man-pages/man2/seccomp.2.html ；内核文档 "seccomp_filter." https://docs.kernel.org/userspace-api/seccomp_filter.html
13. Michael Kerrisk. "A seccomp overview." LWN.net, 2015. https://lwn.net/Articles/656307/
14. cr0 blog. "Introducing Chrome's next-generation Linux sandbox." 2012-09. https://blog.cr0.org/2012/09/introducing-chromes-next-generation.html
15. LWN.net. "Task-level io_uring restrictions." 2026. https://lwn.net/Articles/1054225/
16. moby/moby PR #46762. "seccomp: block io_uring_* syscalls in default profile." 2023-11.
17. containerd PR #9320. "Update RuntimeDefault seccomp profile to disallow io_uring related syscalls." 2023-11.
18. systemd v258 Release Notes. "Support for cgroup v1 removed." 2025-09. https://github.com/systemd/systemd/releases/tag/v258
19. Kubernetes KEP-5573. "Remove cgroup v1 support." https://www.kubernetes.dev/resources/keps/5573/
20. Landlock 官方新闻 #5. "Restricting signals and abstract UNIX sockets / audit logging." 2025-05. https://landlock.io/news/5/
21. systemd PR #39174. "Landlock Config." 2025-09. https://github.com/systemd/systemd/pull/39174
22. KernelNewbies. "Linux 7.0." 2026-04. https://kernelnewbies.org/Linux_7.0
23. LPC 2025. "Seccomp listeners for nested containers." https://lpc.events/event/19/contributions/2241/
24. Ubuntu 官方博客. "Restricted unprivileged user namespaces are coming to Ubuntu 23.10." https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces