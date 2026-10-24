---
title: "KVM 与硬件虚拟化——MicroVM 隔离的硬件基石"
date: 2026-08-15
tags: [Agent Sandbox, APICv, EPT, KVM, MicroVM, SEV-SNP, TDX, VMX, 嵌套虚拟化, 机密计算, 硬件虚拟化, 虚拟化]
aliases: [KVM基础, 硬件虚拟化原理, 嵌套虚拟化, EPT内存隔离]
---

# 04 KVM 与硬件虚拟化——MicroVM 隔离的硬件基石

**摘要：**

[[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 把硬件虚拟化列为隔离光谱的最高档，并给出了 Kata/Firecracker 的宏观对比。本文回答更深一层的问题：**"硬件级隔离"到底强在哪里、由什么机制强制实施？** 答案藏在 CPU 与内存虚拟化的硬件机制中：CPU 虚拟化由处理器内置的 VMX（Intel VT-x）状态机强制执行，不可信负载的任何越权动作都会触发 VM Exit 交由 hypervisor 裁决；内存虚拟化由 EPT（Extended Page Tables）的两级地址转换强制执行，Guest 无法构造指向宿主机内存的映射。文章深入 VMCS 结构与 VM Entry/Exit 细节、EPT 缺页路径与 KVM 的 TDP MMU、APICv 与 posted interrupt 的中断投递机制、三级 fd 架构与 vCPU 线程化，剖析嵌套虚拟化（L0/L1/L2）的退出分类机制与四道生产门禁，并完整记录素材中 CVM 嵌套虚拟化的真实验证过程与"能加载不等于可用"的工程教训。收束部分以 2025-2026 年的硬件虚拟化进展更新时效：TDX/SEV-SNP 机密计算进入生产、KVM 在 Linux 6.16-6.18 的内核侧演进、Firecracker 版本迭代与 AWS Lambda MicroVMs 发布，讨论这些进展对 Agent 沙箱选型的影响。核心认知：**MicroVM 的隔离强度不来自"软件写得好"，而来自"CPU 硬件状态机 + EPT 页表"的结构性强制——这正是它区别于 gVisor（用户态软件）与 runc（原语组合）的本质**。

---

## 第 1 章 为什么硬件虚拟化是"硬件级"隔离

### 1.1 软件隔离的天花板

上一篇文章把隔离边界画成一条从共享内核到 MicroVM 的四档光谱，并给出了完整的选型框架；但那条光谱回答的是"边界画在哪"，本文要回答的是更底层的问题——**当边界画到硬件上时，它凭什么立得住、而不是像前两档那样只是"软件写得好不好"的问题**。

回顾前两篇的结论：runc 的隔离依赖内核原语（namespace/cgroups/seccomp/capabilities），gVisor 的隔离依赖用户态软件（Sentry 拦截 syscall）。这两者的共同特征是——**隔离的"裁决者"与"被隔离者"在同一层软件生态中**：

- runc 场景：被隔离的代码与隔离机制（内核）共享同一内核，攻击目标是内核漏洞；
- gVisor 场景：被隔离的代码与隔离机制（Sentry）通过 syscall 接口交互，攻击目标是 Sentry 的逻辑漏洞。

这两档的天花板是同一种东西：**裁决者本身是软件，软件就有 bug、就有攻击面**。这就好比把安全交给一位尽职尽责的门卫——门卫再认真，终究是人，可以被骗过、被收买、被打晕；而硬件虚拟化的思路是完全换一种方式，不请门卫，而是把门换成金库的机械转盘锁，开锁的物理规则由金属本身的构造决定，与看门人的素质无关。

硬件虚拟化把裁决者换成了**处理器本身**：CPU 提供了一套虚拟机执行模式（VMX root / VMX non-root），不可信负载运行在 non-root 模式中，**任何试图执行特权操作、访问 hypervisor 内存、篡改中断的行为，都会被 CPU 硬件捕获（VM Exit）并交给 hypervisor 处理**。攻击者要逃逸，必须先找到"硬件虚拟化层"的漏洞——这个攻击面比任何用户态程序都小、比任何内核模块都难利用。

> [!info] 核心概念：信任边界的三次外移
> 隔离信任边界的三次外移，对应三种不同的"裁决者"：runc 的裁决者是**内核代码**（漏洞多、攻击面大）；gVisor 的裁决者是**用户态软件 Sentry**（Go 内存安全缩小了攻击面，但仍是软件）；KVM/MicroVM 的裁决者是**CPU 硬件状态机**（固化的电路逻辑，没有"内存安全 bug"这个概念）。理解这个递进关系，就理解了为什么"硬件级隔离"是隔离光谱的最高档——**它把隔离从"代码问题"变成了"硬件问题"**。

### 1.2 虚拟化的历史背景：为什么需要硬件支持

要理解 VMX 的存在，得先回到一个更早的理论问题：什么样的 CPU 架构可以被虚拟化？1974 年，Gerald Popek 与 Robert Goldberg 在论文《Formal Requirements for Virtualizable Third Generation Architectures》中给出了经典判据——一个架构若满足三个条件，就可以用"陷入并模拟"（Trap-and-Emulate）的方式被经典虚拟化：**等价性**（Equivalence，虚拟机中运行的程序，其行为与在裸机上的语义一致）、**资源控制**（Resource Control，虚拟机不能访问未分配的资源，资源由 VMM 独占裁决）、**效率**（Efficiency，绝大多数指令直接由硬件执行，不需要 VMM 逐条解释）。这三条判据后来被称为 Popek-Goldberg 定理（Popek-Goldberg Theorem），它把"能不能虚拟化"从一个工程问题变成了一个架构判据问题。

麻烦在于，x86 恰好不满足这三条判据。经典虚拟化的前提是"敏感指令必须都是特权指令"——敏感操作一旦执行就陷入 VMM，VMM 裁决后再恢复执行；但 x86 里有不少**既敏感又不特权**的指令，譬如 `SGDT`/`SIDT`（读取全局/中断描述符表寄存器）在用户态就可以执行，`POPF`（弹出标志寄存器）在低特权级会静默忽略中断标志位的修改。这些指令在虚拟机里会泄露真实硬件状态、或产生与预期不符的行为，而它们又不触发陷入——用 Popek-Goldberg 的语言说，x86 不是"可经典虚拟化"的架构。

于是在 Intel VT-x（2005）与 AMD-V（2006）出现之前，x86 虚拟化依赖"二进制翻译"（Binary Translation）——VMM（如 VMware Workstation 的早期版本）在软件层面扫描并改写 Guest 的特权指令，把敏感指令替换为对 VMM 的调用序列，让它们"看起来"在虚拟环境下安全执行。这条路有两个致命问题：

**问题一：性能损耗**。每条特权指令都要经过翻译/模拟路径，性能开销动辄 20-30%，且无法对性能做预测——翻译缓存的命中率随工作负载波动，同一个程序在不同时刻的执行路径开销可能完全不同。

**问题二：完整性风险**。翻译器必须穷举所有特权指令模式——任何漏网的特权指令都可能让 Guest 直接操作硬件，虚拟化边界形同虚设。换句话说，二进制翻译的隔离强度取决于"翻译器有没有枚举完"，这是典型的软件正确性问题，与 1.1 节的门卫困境是同构的。

硬件虚拟化扩展的引入把这两个问题一起解决：CPU 增加"VMX non-root 模式"——Guest 的特权指令在 non-root 模式下执行**不直接操作硬件**，而是触发 VM Exit 交给 hypervisor 裁决。**硬件不再区分"哪条指令是特权的"，而是强制"non-root 模式下所有特权操作都先经过 hypervisor"**——这是结构性的强制，不依赖软件枚举的完备性。注意这个思路的微妙之处：它绕开了"哪些指令敏感"的枚举问题，用一条更粗的规则覆盖一切——在 non-root 模式下，任何被 VMCS 执行控制位点名的事件都先退出，剩下的全部由硬件直接执行。

### 1.3 一个直觉模型：虚拟机是"被硬件看管的进程"

理解 KVM 最直觉的模型是：**虚拟机（VM）在宿主机上只是一个普通进程，但 CPU 硬件给了这个进程一个特殊的"身份标记"（VMCS，Virtual Machine Control Structure）**。普通进程执行特权指令时，内核会检查权限并代为执行；VM 进程（在 non-root 模式）执行特权指令时，CPU 不检查权限，而是直接暂停该进程（VM Exit），唤醒 hypervisor 来处理——**hypervisor 拥有绝对的裁决权，且这个权力由 CPU 电路保证，不依赖任何软件约定**。

```
普通进程：  特权指令 → 内核（检查权限 → 执行/拒绝）
VM 进程：   特权指令 → CPU 硬件 → VM Exit → hypervisor（裁决 → 恢复 VM）
                                     ↑
                          这个跳转由 CPU 电路强制执行，
                          Guest 无法跳过、无法伪造、无法篡改
```

这个模型解释了硬件虚拟化与软件隔离的本质差异：**软件隔离的强度取决于"代码写得有多好"，硬件虚拟化的强度取决于"CPU 设计得有多对"**——后者经过数十年安全审计，攻击面是数量级意义上的小。但读者不妨立刻追问一句：硬件电路也有勘误（erratum）和微码 bug，凭什么说它"没有内存安全 bug"？笔者的回答是：隔离强度的对比从来不是"绝对无漏洞"，而是"漏洞的形态与可利用性"——硬件缺陷以勘误表、微码更新（microcode patch）的形式由厂商统一修复，攻击者既没有源码也没有调试接口去挖掘，这和"数百万行 C 代码里找内存破坏"是完全不同量级的难度。

### 1.4 硬件虚拟化的四个支柱

完整的硬件虚拟化不是"CPU 一个点"，而是四个硬件支柱的协同。理解全部四根支柱，才能评估"MicroVM 到底隔离了什么"：

| 支柱 | 硬件机制 | 隔离的内容 |
| :--- | :--- | :--- |
| **CPU 虚拟化** | VMX/AMD-V（VM Entry/Exit 状态机） | 特权指令、模式切换、指令执行 |
| **内存虚拟化** | EPT/NPT（两级页表） | 地址空间、内存访问、DMA 目标 |
| **中断虚拟化** | APICv/vAPIC、posted interrupts | 中断注入、设备中断路由 |
| **I/O 虚拟化** | IOMMU（VT-d/AMD-Vi）、virtio | 设备直通、DMA 隔离 |

四个支柱中，**IOMMU 是常被忽略却极其关键的一根**：没有 IOMMU，直通设备（GPU/网卡）的 DMA 可以直接读写宿主机物理内存——设备级绕过 EPT 的路径存在。MicroVM 方案默认不使用设备直通（极简设备模型），也就天然规避了大部分 IOMMU 需求；但 Kata 的 GPU 直通场景（QEMU hypervisor）必须同时启用 IOMMU 才能保证 DMA 隔离。**评估一个虚拟化方案的隔离强度时，四根支柱要逐一过问**——只问"有没有 VMX"是远远不够的。

后文将沿这四根支柱展开，但顺序上有轻重：第 2、3 章分别深入 CPU 与内存这两根最核心的支柱，中断虚拟化并入第 3 章（它本质上是内存与中断控制器的协同），I/O 虚拟化留给 [[05 VMM 解剖——Firecracker、Cloud Hypervisor 与 Kata 的虚拟机监视器家族]] 从设备模型角度展开。

---

## 第 2 章 CPU 虚拟化：VMX 状态机与 VM Exit

### 2.1 VMX root 与 non-root：两个世界

Intel VMX（Virtual Machine Extensions）定义了两种操作模式：

| 模式 | 运行者 | 权限 | 触发条件 |
| :--- | :--- | :--- | :--- |
| **VMX root 模式** | hypervisor（KVM/QEMU/VMM） | 完全特权 | 正常的内核/用户态切换 |
| **VMX non-root 模式** | Guest（虚拟机内的内核+用户态） | 受限 | 由 VM Entry 进入 |

**关键点：non-root 模式下的"特权"是假象**。Guest 内核以为自己在 ring 0 执行特权指令（它看到的 CR3、IDTR 等都是虚拟的），但实际上任何特权操作（写 CR3、开中断、执行特权指令）都会触发 VM Exit——**Guest 永远无法直接操作真实硬件**。两个模式共享同一套特权级（ring 0-3）语义，差别在于 non-root 模式下"特权指令的结果由 hypervisor 代为裁决"，root 模式下则由处理器真实执行——这是"假特权"与"真特权"的分界。

### 2.2 VMCS：虚拟机的"身份证"

每个 vCPU 关联一个 VMCS（Virtual Machine Control Structure）——一个由 hypervisor 维护的数据结构，记录：

- **Guest 状态**：Guest 的寄存器、CR3、IDTR、LDTR 等（VM Entry 时恢复）；
- **Host 状态**：hypervisor 的寄存器上下文（VM Exit 时恢复）；
- **VM 执行控制**：哪些指令/事件触发 VM Exit（如"EPT 违规"、"CPUID 指令"）；
- **VM Exit 原因**：本次退出是为什么（如"访问了未映射的 Guest 物理地址"）。

VMCS 的操作指令（VMPTRLD/VMCLEAR/VMREAD/VMWRITE）本身也是特权指令——**只有 hypervisor 能读写 VMCS**。Guest 无法修改自己的"身份证"，也就无法篡改"哪些操作会触发 VM Exit"的规则。

但"只能由 hypervisor 读写"只是 VMCS 安全性的第一层，其结构本身还有不少值得展开的细节。VMCS 的字段按用途分成若干组：Guest-state area 与 Host-state area 分别保存两个世界的上下文；VM-execution control fields 决定哪些指令与事件触发退出；VM-exit control fields 与 VM-entry control fields 控制进出时的处理器行为；此外还有专门记录"最近一次退出原因与信息"的 VM-exit information fields。处理器并不把 VMCS 当普通内存直接读——它通过一个 VMCS 指针寄存器（VMCS pointer）引用当前 VMCS，`VMPTRLD` 指令把某块内存载为当前 VMCS，`VMCLEAR` 则把处理器内部缓存的 VMCS 数据写回内存并把该 VMCS 置为 "clear" 状态；处于 clear 状态的 VMCS 才能被 `VMLAUNCH`（首次进入）使用，已经 launch 过的 VMCS 走 `VMRESUME`（再次进入）——首次进入与后续进入分成两条指令，是硬件层面对"初始化路径"与"热路径"的显式区分。硬件还会对 VMCS 区域做完整性校验，防止软件把字段改写成有害值。这意味着，Guest 既没有读写 VMCS 的指令，也没有绕过校验的机会——身份证不但锁在保险柜里，连伪造证件本身都不存在可操作的路径。

行文至此，读者可能会问：VMCS 里到底存了多少 Guest 状态？答案是"够用的子集"——通用寄存器（GPR）并不全在 VMCS 里，而是由 hypervisor 的软件在退出路径上自行保存。这引出一个有趣的引申：当 ISA 扩展把架构寄存器变多时，VM Exit/Entry 路径的保存恢复负担就会变大。2024-2025 年 Intel 推出的 APX（Advanced Performance Extensions）把通用寄存器从 16 个翻倍到 32 个（GCC 15 于 2025 年 6 月全量实现，并确认随 Diamond Rapids 与 Nova Lake 落地）——对虚拟化而言，每一次这样的 ISA 扩展都意味着 vCPU 状态集扩大、hypervisor 需要在退出路径上保存恢复更多寄存器、并正确向 Guest 暴露对应的 CPUID 特性位，这类适配通常由 KVM 在数个内核大版本内逐步完成。

### 2.3 VM Exit 的完整流程

当 Guest 触发退出条件时，CPU 硬件执行以下序列（无需软件参与）：

1. 保存 Guest 状态到 VMCS；
2. 从 VMCS 恢复 Host 状态；
3. 切换到 root 模式；
4. 跳转到 hypervisor 注册的 VM Exit 处理入口；
5. hypervisor 解析 VM Exit 原因（`VM_EXIT_REASON` 字段），决定如何处理（模拟指令、转发给用户态 QEMU、或直接恢复执行）。

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    A["Guest 执行特权指令<br/>（VMX non-root 模式）"] -->|"CPU 硬件捕获"| B["VM Exit<br/>保存 Guest 状态到 VMCS"]
    B --> C["切换到 root 模式<br/>恢复 Hypervisor 状态"]
    C --> D["解析 VM_EXIT_REASON"]
    D --> E["可安全模拟？"]
    E -->|"是"| F["hypervisor 模拟指令<br/>（如 CPUID、I/O 端口）"]
    E -->|"否"| G["转发给用户态 VMM<br/>（QEMU/rust-vmm 等）"]
    F --> H["VM Entry<br/>恢复 Guest 继续执行"]
    G --> H

    classDef hw fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef sw fill:#44475a,stroke:#6272a4,color:#f8f8f2
    class A,B,C,D,H hw
    class E,F,G sw
```

**"模拟"与"转发"的分工**：KVM 内核模块处理高频、简单的退出（如 CPUID、CR 访问、EPT 违规），用户态 VMM（QEMU/Firecracker 等）处理低频、复杂的设备模拟（如 virtio 设备 I/O）。这个分工是性能的关键——**高频路径留在内核，低频路径才出内核**。

VM-exit reason 本身是一个字段系统：硬件在退出时把"主要原因"写入 VMCS 的 exit reason 字段，常见值譬如 `EXIT_REASON_EPT_VIOLATION`（EPT 违规）、`EXIT_REASON_CPUID`、`EXIT_REASON_IO_INSTRUCTION`（I/O 指令）——每一种 reason 对应 KVM 里一段独立的处理逻辑。KVM 拿到退出原因后，在 `vmx_handle_exit()` 之类的入口做一次分派：能在内核里模拟的立即模拟，不能的（设备 I/O）则通过 KVM 的用户态接口（`KVM_EXIT_IO` 等退出原因）把控制权交还 VMM 进程。整条路径从硬件到内核再到用户态，每一级都只处理"自己这一层必须处理的事"。

### 2.4 为什么 VM Exit 是安全的（而非缓慢的）

一个常见疑问："VM Exit 让每条特权指令都退出一次，性能怎么受得了？"答案在于**执行控制位的精细粒度**：VMCS 的"VM-execution controls"允许 hypervisor 声明"哪些事件不触发退出"——譬如：

- **不退出**：普通算术指令、内存访问（除非 EPT 违规）、无特权指令——这些在 non-root 模式直接执行，零开销；
- **退出**：特权指令（CR3 写入等）、敏感指令（INVEPT 等）、中断/异常（按配置）、EPT 违规。

因此 VM Exit 只发生在"真正需要 hypervisor 介入"的时刻——Guest 的绝大多数指令（包括用户态代码）在 non-root 模式以原生速度执行。**这正是"硬件虚拟化接近原生性能"的结构性原因**：不是虚拟化没有开销，而是开销被硬件精确地限制在"必须介入"的路径上。

不过，"原生速度"只是理想态，硬件的补齐经历了一个过程。早期（2006-2008 年前后）的硬件虚拟化还不完善：VM Exit/Entry 会无条件冲刷 TLB，频繁进出意味着频繁的地址转换缓存失效；Guest 运行在实模式等非分页模式时还需要 hypervisor 逐条模拟。硬件随后补齐了两件关键事：其一是 **VPID（Virtual Processor ID，虚拟处理器标识）**，它给 TLB 条目打上 vCPU 的标签，VM Exit/Entry 时只刷新被切换 vCPU 的条目、不必全量冲刷，配合 EPT 的地址空间标签实现"切换虚拟机不清 TLB"；其二是 **Unrestricted Guest（无限制客户机）** 控制位，在启用 EPT 的前提下允许 Guest 直接以实模式/未分页模式运行，免去了早期对"模式切换"的软件模拟。这两项加上 EPT，才凑齐了"接近原生"的拼图——理解 KVM 的性能史，其实就是理解"硬件逐步补齐虚拟化原语"的历史。

---

## 第 3 章 内存虚拟化：EPT 的两级地址转换

### 3.1 影子页表的时代：软件维护的脆弱

在 EPT（Extended Page Tables，Intel 2008 引入）之前，内存虚拟化依赖"影子页表"（Shadow Page Table）：hypervisor 为 Guest 的每个页表维护一份"影子"，把 Guest 虚拟地址直接映射到宿主机物理地址（跳过 Guest 物理地址这一层）。问题：

**性能**：Guest 每次修改页表（mmap/munmap 频繁发生），hypervisor 都要同步重建影子页表——TLB 刷新频繁，性能损耗显著。更具体地说，Guest 写页表项（PTE）的指令会被拦截，hypervisor 要先停下 Guest、解析这次写入、重建对应的影子项、再让 Guest 继续——一次普通的内存映射操作被拆成了"陷入-解析-重建-恢复"的往返。

**安全**：影子页表由 hypervisor 软件维护——如果同步逻辑有漏洞，Guest 可能获得"直通"映射（Guest 虚拟地址直接映射到宿主机物理地址），**绕过隔离**。影子页表时代的内存隔离强度取决于"hypervisor 软件的正确性"——这是软件隔离，不是硬件隔离。

影子页表还有一个不易察觉的工程负担：hypervisor 必须为"谁的页表该影子化、影子到哪一层"维护一套复杂的反向映射（rmap）结构，当宿主侧回收或迁移内存页时，要顺着反向映射找到所有受影响的影子项并逐一修正——这套逻辑在 EPT 出现后并没有立刻消失，而是演化为第 3.5 节要讲的 TDP MMU 的前身。

### 3.2 EPT：第二级页表，硬件强制执行

EPT 的思路极其优雅：**不替换 Guest 的页表，而是在旁边增加"第二级"地址转换**。

```
Guest 虚拟地址 → (Guest 页表, 由 Guest 自己管理) → Guest 物理地址
                                                 ↓
                    (EPT, 由 hypervisor 独占管理) → 宿主机物理地址
```

关键特性：

| 特性 | 含义 |
| :--- | :--- |
| **两级转换** | Guest 虚拟地址先经 Guest 页表转成 Guest 物理地址（GPA），再经 EPT 转成宿主机物理地址（HPA） |
| **独占管理** | EPT 页表只由 hypervisor 维护——Guest 没有写 EPT 的指令路径 |
| **硬件执行** | 地址转换由 CPU 内存管理单元（MMU）硬件完成——Guest 无法跳过 |
| **权限控制** | EPT 条目带读写执行权限位——hypervisor 可以把 Guest 内存设为只读/不可执行 |

**安全意义**：Guest 物理地址空间是"虚拟的"——Guest 以为自己在访问 0x1000，实际映射到宿主机的哪块物理内存完全由 EPT 决定。**Guest 没有任何机制构造"指向宿主机内核内存"的映射，因为地址转换的最后一跳（GPA→HPA）在硬件层面由 hypervisor 独占控制**。这就是"内存级隔离"的完整含义。

把 EPT 拆开看，它本身是一张与 x86 常规页表同构的层级结构：PML4/PDPT/PD/PT 四级，由 EPTP（Extended Page Table Pointer，扩展页表指针）寄存器指根；条目里除了 R/W/X 权限位，还携带内存类型（EPT Memory Type）与"是否大页"的编码——2MiB 与 1GiB 的大页在 EPT 里同样支持。这里可以借一个比喻来理解两级转换的边界：Guest 页表是房客手里的户型图，想怎么画都行；EPT 是房东重新铺过的地板，房客每走一步，脚下踩的地板都是房东装的，走向哪里由地板决定，不由图纸决定——图纸只决定"房客以为自己要去哪"，地板决定"他实际到得了哪"。

### 3.3 EPT 违规与缺页处理

Guest 访问未映射的 Guest 物理地址时，CPU 产生 **EPT Violation**（VM Exit 原因之一），hypervisor 检查后决定：

- Guest 页表尚未建立映射 → 返回缺页错误给 Guest（Guest 自行处理，与正常缺页无异）；
- Guest 访问了"存在但被 EPT 标为不可访问"的内存 → hypervisor 可以记录/审计/拒绝——**这是沙箱实现"内存访问控制"的硬件钩子**。

值得区分两个容易混淆的概念：**EPT Violation（EPT 违规）** 与 **EPT Misconfiguration（EPT 配置错误）**。前者是"访问了未映射或权限不符的地址"，属于 Guest 的正常行为被拦截，hypervisor 可以妥善处理；后者是"EPT 条目本身的编码无效"（譬如设置了保留位、组合了非法的权限位），这意味着 EPT 页表自身被写坏了——正常运行时只有 hypervisor 自己的 bug 才会触发它。这个区分透露了 EPT 的信任模型：Guest 的越权行为落在"可处理的违规"范畴，而"配置错误"被单列为另一类事件，因为它动的是隔离机制本身。

对 Agent 沙箱的实际意义：CubeSandbox/Firecracker 类平台可以在 EPT 层实现"Guest 只能访问自己被分配的内存范围"的硬保证——即使沙箱内代码完全失控（被注入、被攻破），也无法读取相邻沙箱或宿主机内存。**这是 MicroVM 多租户安全的物理基础**。

缺页路径还有一个性能维度值得展开：KVM 处理 EPT 违规时，要为"缺的那一页"建立 EPT 映射，映射粒度越大、缺页次数越少。MicroVM 的 Guest 内存通常是启动时一次性注册的一大块连续区域，KVM 会尽量以 2MiB 甚至 1GiB 的大页粒度建立 EPT 映射——这也是 Firecracker 的 `huge_pages` 配置（把 Guest 内存挂到大页上）的底层原因：宿主侧内存大页化之后，EPT 的页表层级更浅、TLB 覆盖范围更大、缺页路径更短。对"每沙箱一个 VM"的高密度场景，这条路径的每一微秒都会乘以沙箱数量。

### 3.4 性能特征：为什么 EPT 比影子页表快

| 维度 | 影子页表 | EPT |
| :--- | :--- | :--- |
| 地址转换 | 单级（Guest VA→HPA），软件维护 | 两级（Guest VA→GPA→HPA），硬件维护 |
| Guest 页表修改 | 触发 hypervisor 同步（软件开销） | 无需同步（硬件自动走两级转换） |
| TLB 行为 | 共享 TLB，频繁失效 | 专用 TLB（EPTP 切换），命中率高 |
| 内存开销 | 每个 Guest 进程一份影子页表 | 每个 VM 一份 EPT（可按需分配） |

代价：两级转换让"每次地址翻译"多一次内存查找——但 CPU 用 EPT 专用缓存（EPT TLB）与页表遍历缓存（PML4/PDP 缓存）消化了大部分开销。**实测中 EPT 的内存密集负载比影子页表快 10-40%**（SPEC 类基准），这是 MicroVM 能承担"每沙箱一个 VM"的硬件前提。

### 3.5 KVM 的 TDP MMU：把 EPT 的维护本身做对

讲完 EPT 的硬件机制，还有一个"维护者"的坑必须补上：EPT 页表由谁、以什么方式写？答案是 hypervisor 的软件——但"谁来写 EPT"这件事的质量，同样决定了性能上限。早期 KVM 在 EPT 模式下仍然沿用为影子页表设计的 legacy MMU：围绕反向映射与 vCPU 锁串行化，多 vCPU 并发触发缺页时会互相阻塞，页表根的切换（CR3 变更、SMM 切换）还会引发整棵 EPT 重建。KVM 在 2021 年（Linux 5.14）把专为 EPT 优化的 **TDP MMU（Two-Dimensional Paging MMU）** 设为 64 位平台的默认实现：它直接维护 EPT 页表、支持无锁的并发页表遍历与快速页错误（fast page fault）处理，不再依赖 legacy MMU 的全局锁与反向映射结构。

TDP MMU 对 MicroVM 场景的意义是直接的：单机同时运行上百个单 vCPU MicroVM 时，每个 VM 都有一份 EPT，叠加的页错误风暴是宿主侧的常态负载——TDP MMU 把"维护 EPT"从串行瓶颈变成可并发的常规路径，这正是"每沙箱一个 VM"在密度上能够成立的软件前提之一。顺着这条线索看，硬件（EPT）负责隔离的强制性，软件（TDP MMU）负责隔离的可持续性，两者缺一不可。

### 3.6 中断虚拟化：设备中断的隔离路径

中断是虚拟化中"看不见但离不开"的支柱——Guest 的设备（virtio-net 等）产生中断时，中断不能直接打到 Guest 的 IDT（中断描述符表），否则 Guest 可以伪造中断向量。现代中断虚拟化（APICv / posted interrupts）的路径：

```
物理设备中断 → IOMMU/中断控制器 → hypervisor 检查（目标 vCPU 是否合法）
             → posted interrupt（直接把中断"投递"到目标 vCPU 的虚拟 APIC）
             → VM Entry 时 Guest 看到中断
```

**安全要点**：中断注入的目标 vCPU、向量号、优先级都由 hypervisor 控制——Guest 无法伪造"来自设备"的中断（伪造的写操作会触发 VM Exit）。**posted interrupts 的优化意义**：合法的设备中断不需要先 VM Exit 再注入，而是在下次 VM Entry 时自动呈现——减少了中断路径的退出次数。对沙箱性能的意义：网络密集负载（virtio-net 中断频繁）在这条路径上获得接近原生的中断延迟。

机制上，APICv（Advanced Programmable Interrupt Controller virtualization）把 APIC 的虚拟化也交给了硬件：每个 vCPU 关联一个 virtual APIC page 与 APIC-access page，Guest 对 APIC 寄存器的读写由硬件直接处理，不再逐次退出；posted interrupt 则更进一步——hypervisor 把待投递的中断写入目标 vCPU 的 **posted-interrupt descriptor（PID，投递式中断描述符）**，若该 vCPU 正在 non-root 模式下运行，硬件在适当时机直接把中断呈现给 Guest，整条路径不产生 VM Exit；若 vCPU 不在运行，则通过 notification vector 触发一条 IPI，由宿主侧把 vCPU 唤醒后再投递。配合 IOMMU 的中断重映射（Interrupt Remapping），直通设备的中断可以按重映射表直接路由到目标 vCPU。把这套机制与第 4 章的 vCPU 线程模型对照看，就能理解"中断延迟接近原生"对沙箱的意义：沙箱内跑网络密集型 Agent 任务（调用外部 API、拉取模型文件）时，频繁的设备中断不成为宿主 CPU 的负担，VM 的隔离成本才真正落在"值得付"的地方。

---

## 第 4 章 KVM 架构：三级 fd 与 ioctl 生命周期

### 4.1 /dev/kvm 与三级 fd

KVM（Kernel-based Virtual Machine）是 Linux 内核的虚拟化模块——它把 CPU/内存虚拟化能力封装为字符设备接口，用户态 VMM 通过 ioctl 系统调用使用。KVM 的 API 设计是三级 fd 体系：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    DEV["/dev/kvm<br/>全局设备（打开一次）"] -->|"KVM_CREATE_VM"| VM["vm_fd<br/>一个虚拟机"]
    VM -->|"KVM_CREATE_VCPU"| VCPU["vcpu_fd<br/>一个虚拟 CPU"]
    VM -->|"KVM_SET_USER_MEMORY_REGION"| MEM["Guest 内存注册<br/>（HVA→GPA 映射）"]
    VCPU -->|"KVM_RUN<br/>（阻塞，直到 VM Exit）"| RUN["运行循环"]

    classDef dev fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef fd fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    class DEV dev
    class VM,VCPU,MEM,RUN fd
```

| fd | 创建方式 | 职责 | 关键 ioctl |
| :--- | :--- | :--- | :--- |
| **kvm_fd** | `open("/dev/kvm")` | 全局能力查询与 VM 创建 | `KVM_GET_API_VERSION`、`KVM_CREATE_VM` |
| **vm_fd** | `KVM_CREATE_VM` | 虚拟机资源（内存/设备/中断） | `KVM_SET_USER_MEMORY_REGION`、`KVM_CREATE_VCPU` |
| **vcpu_fd** | `KVM_CREATE_VCPU` | 单个 vCPU 的执行 | `KVM_SET_REGS`、`KVM_SET_SREGS`、`KVM_RUN` |

**KVM_RUN 是核心**：VMM 对每个 vCPU 调用 `KVM_RUN` 后，该 ioctl **阻塞直到下一次 VM Exit**——返回时 `run` 结构体中携带退出原因（`kvm_run.exit_reason`）。VMM 处理退出后再次调用 `KVM_RUN`。整个虚拟机的"运行"就是 VMM 围绕 `KVM_RUN` 的循环。用进大厦的比喻来记这套体系：三级 fd 好比三道门禁——前台（`/dev/kvm`）确认你有资格进入大厦，楼层闸机（vm_fd）给你划拨一间房间，最后房间的门禁卡（vcpu_fd）管着你在这间房里的一举一动；房东（hypervisor）把门禁规则写死在硬件里，房客（Guest）手里的卡永远打不开别人的门。

有两个 API 层面的细节值得点出。其一是 **kvm_run 共享内存**：`KVM_RUN` 并不是把 vCPU 状态通过 ioctl 参数反复拷贝——VMM 在第一次调用前把一段内存 `mmap` 到内核侧，Guest 的寄存器快照、退出原因、I/O 请求都在这块共享内存里直接读写，省掉了每次退出的数据搬运；对热路径（每秒成千上万次退出）来说，这块共享内存是"退出处理延迟"的隐性组成部分。其二是 **事件机制**：除了阻塞式 `KVM_RUN`，KVM 还提供 `KVM_IRQFD`/`KVM_IOEVENTFD`，让设备模拟线程可以通过 eventfd 向指定 vCPU 注入中断或转发 I/O——vCPU 线程与设备线程因此可以解耦，这是多线程 VMM（QEMU 的主循环与 iothread 分离、Firecracker 的事件循环）得以成立的基础。

### 4.2 一个 VM 的完整生命周期

以 Firecracker 类 MicroVM 为例，从创建到运行的内核路径：

```c
// 伪代码：MicroVM 创建的最小骨架
int kvm_fd = open("/dev/kvm", O_RDWR);              // 1. 打开 KVM 设备
int vm_fd  = ioctl(kvm_fd, KVM_CREATE_VM, 0);        // 2. 创建 VM
ioctl(vm_fd, KVM_SET_USER_MEMORY_REGION, &region);   // 3. 注册 Guest 内存（HVA↔GPA）
int vcpu_fd = ioctl(vm_fd, KVM_CREATE_VCPU, 0);      // 4. 创建 vCPU
ioctl(vcpu_fd, KVM_SET_SREGS, &sregs);               // 5. 设置 Guest 初始状态（入口 RIP 等）
while (true) {
    ioctl(vcpu_fd, KVM_RUN, 0);                      // 6. 运行 vCPU（阻塞到 VM Exit）
    handle_exit(&run);                               // 7. 处理退出（设备模拟/转发）
}
```

**注意第 3 步**：`KVM_SET_USER_MEMORY_REGION` 是内存隔离的契约点——VMM 声明"哪些宿主机用户态内存区间映射为 Guest 的哪些物理地址"。**未经注册的内存区间，Guest 无论如何都无法访问**——这是 EPT 隔离的 API 侧表达。

第 3 步值得再展开一句：注册的载体是"宿主机用户态内存区间"（HVA，Host Virtual Address），KVM 在内部维护 HVA→HPA 的反向映射，EPT 条目最终指向物理页。这个"用户态内存注册"的设计意味着 VMM 进程的堆内存就是 Guest 的物理内存——MicroVM 的内存开销（Guest 内核镜像、页表、运行时堆）全部落在 VMM 进程的地址空间里，这也是为什么 `PSS`（按共享比例分摊后的驻留内存）能作为 MicroVM 内存开销的度量口径：它度量的是这个"VM 进程"真实占用的宿主内存。

### 4.3 vCPU 与线程：KVM 的线程模型

一个细节容易让人困惑：**vCPU 不是内核线程，也不是特殊实体——每个 vcpu_fd 的 `KVM_RUN` 调用由一个普通的用户态线程执行**。这意味着：

- vCPU 的调度（哪个物理核跑哪个 vCPU）由宿主机 CFS 调度器决定——VMM 可以通过 CPU affinity 固定 vCPU 到物理核（MicroVM 平台常用）；
- `KVM_RUN` 阻塞期间，该线程不占 CPU——等待 VM Exit 时 vCPU 是"空闲"的；
- **多 vCPU 的 VM 对应多个用户态线程**——VMM 的线程数 = vCPU 数 + 辅助线程（I/O 事件循环等）。

对 MicroVM 场景的含义：单 vCPU 的 MicroVM（Agent 沙箱常见配置）在宿主机上就是一个线程——**资源模型的粒度与容器几乎一致**（一个沙箱 ≈ 一个进程 + 若干辅助进程），这解释了为什么 MicroVM 方案可以做到"每沙箱一个 VM"的密度：VM 的宿主侧成本主要是内存（Guest 内核 + 页表），而非 CPU 线程开销。

"vCPU 是线程"这个事实还派生出一组排障语义：vCPU 的调度延迟由宿主 CFS 的负载决定，沙箱内的 CPU 等待时间可以被半虚拟化时钟（kvm_steal_time）统计为 steal time 暴露给 Guest——当沙箱内观察到 CPU 时间"凭空消失"时，问题往往不在沙箱而在宿主侧的调度竞争。这套"vCPU 作为线程被调度"的机制与宿主侧的绑核、超分、Steal Time 排障，在 [[Linux/KVM虚拟化与性能工程/02 vCPU 调度与超分——运行队列、Steal Time、绑核和资源竞争]] 里有系统展开，本文只点出它与"每沙箱一个 VM"密度模型的关联。

### 4.4 KVM 与 QEMU/Firecracker 的分工

KVM 是内核模块（负责 CPU/内存虚拟化），QEMU/Firecracker 是用户态 VMM（负责设备模拟与固件加载）。分工边界：

| 层 | 组件 | 职责 |
| :--- | :--- | :--- |
| **内核** | KVM 模块 | VMX 管理、EPT 维护、VM Exit 处理、中断注入 |
| **用户态** | QEMU / Firecracker / Cloud Hypervisor | 固件/引导加载、virtio 设备模拟、I/O 转发、速率限制 |

对 MicroVM 场景，用户态 VMM 越薄越好——Firecracker 只保留 6 个设备，就是要把"用户态攻击面"压缩到最小（[[05 VMM 解剖——Firecracker、Cloud Hypervisor 与 Kata 的虚拟机监视器家族]] 详述）。

> [!note] 设计哲学：内核做"最小可信计算基"
> KVM 的设计哲学是"内核只做不可不做的事"：CPU 虚拟化（VMCS 管理）与内存虚拟化（EPT）必须在内核（硬件接口最近处），设备模拟全部推到用户态。这样设计的结果是：**内核侧的可信计算基（TCB）极小**（KVM 模块数万行），用户态 VMM 即使被攻破（如 QEMU 的 virtio 漏洞），攻击者得到的也只是"用户态进程权限"而非内核权限。MicroVM 方案把这条哲学推到极致——用户态 VMM 也被 jailer 沙箱化。

---

## 第 5 章 嵌套虚拟化：L0/L1/L2 与生产门禁

### 5.1 什么是嵌套虚拟化

嵌套虚拟化（Nested Virtualization）指**在虚拟机里再跑虚拟机**：宿主机（L0）上运行 Worker VM（L1），L1 内部再创建 MicroVM（L2）——Agent 沙箱的 Kata/Firecracker 场景正是这个结构：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    L0["L0：物理宿主机<br/>KVM 直接使用 VT-x"]
    L1["L1：Worker VM（CVM）<br/>需要 VT-x 透传 + nested=1"]
    L2["L2：MicroVM（Kata/Firecracker）<br/>Agent 沙箱本体"]

    L0 -->|"创建"| L1
    L1 -->|"嵌套 KVM"| L2

    classDef l0 fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef l1 fill:#ffb86c,stroke:#ffb86c,color:#282a36
    classDef l2 fill:#50fa7b,stroke:#50fa7b,color:#282a36
    class L0 l0
    class L1 l1
    class L2 l2
```

**关键事实：多出来的 L1 才是门禁**。裸金属（物理机）上跑 Kata 不需要嵌套（L0 直接提供 VT-x）；但在云 VM（CVM）上跑 Kata，L1 必须把 VT-x 透传给 L2 使用——**L1 的虚拟化能力（是否透传 VT-x、是否开启 nested、性能损耗多少）决定了整个方案是否可行**。理解嵌套，用"套娃"这个比喻就够了：L0 是最外层的大娃娃，L1 是中间娃娃，L2 是最内层娃娃；大娃娃的壳能不能被中间娃娃"借用"、借用的代价多大，决定了整套嵌套结构的可行性——套娃的每一层壳都在变厚，只是厚度是否可接受的问题。

### 5.2 嵌套虚拟化的退出分类：L1 不拦截的由 L0 直处理

嵌套虚拟化的核心机制是**退出分类**：L2 的 VM Exit 首先由谁处理？现代实现（Intel VMCS shadowing / AMD nested page tables）的策略是：

- **L1 配置了拦截的事件**：L2 的 VM Exit 由 L1 处理（L1 是 L2 的"直接 hypervisor"）；
- **L1 未配置拦截的事件**：L2 的 VM Exit 直接由 L0 处理——**L0 是最终的硬件裁决者**。

素材调研（Phase1-04）明确记录了这个机制："嵌套虚拟化按退出类型分化——L1 不拦截的退出由 L0 直处理"。这个分化的安全含义：**即使 L1（Worker VM）被攻破，L2 的硬件隔离仍由 L0 兜底**——嵌套不是"隔离的稀释"，而是"隔离的叠加"，只是多了一层性能损耗。

这个"分类"在硬件层面是怎么实现的？值得补一笔机制细节。Intel 侧是 **VMCS shadowing（VMCS 影子化）** 加 **virtual VMCS**：L0 把 L1 的 VMCS 页面标记为"影子"状态，L1 对 VMCS 的 `VMREAD`/`VMWRITE` 就不再触发退出，而是直接读写影子页；L1 为其客户机（L2）准备的 VMCS，则由 L0 在后台以 virtual VMCS（习惯叫 VMCS12）的形式维护——L2 的退出信息被 L0 写进对应的 VMCS12，L1 读起来就像自己处理过一样。AMD 侧的对应物是 VMCB shadowing 与嵌套 NPT（Nested Page Tables，L0 为 L2 构造两级页表）。这套机制的实际效果是：**"谁拦截、谁处理"在硬件与软件之间有了清晰的层次**——L1 明确声明的拦截由 L1 处理，L1 没声明的一律落到 L0。生产上的直接推论是：L1 的 KVM 配置（拦截哪些事件、开哪些控制位）直接决定 L2 的性能特征，这也解释了 6.3 节里"配置验证无法替代负载验证"的结论。

### 5.3 嵌套虚拟化的性能代价

嵌套的性能损耗来自两个层面：

**VM Exit 的串联处理**：L2 的退出可能需要 L1 与 L0 两级处理（取决于拦截配置）——路径变长，延迟叠加。

**EPT 的两级嵌套**：L0 维护 L1 的 EPT，L1 维护 L2 的 EPT——L2 的地址转换变成三级（L2 GPA→L1 GPA→L0 HPA），TLB 命中率下降，缺页路径更长。

**实测量级**：素材 PoC 中，Kata 在裸金属的启动 p50 为 4.0s；嵌套场景（CVM）的真实性能尚未过门禁（Phase5-03 明确"嵌套 Kata 未过门禁前只做灰度"）——**嵌套的损耗数字必须在同型节点上实测，不能从裸金属数据外推**。这是素材反复强调的方法论：**性能数据必须绑定测量场景**（[[12 沙箱性能工程——Runtime 基准与 WarmPool 容量管理]]）。嵌套场景下"损耗与负载强相关、且与 L1 的拦截配置耦合"这两点，与 [[Linux/KVM虚拟化与性能工程/07 Kata、嵌套虚拟化与迁移能力约束]] 的结论相互印证：嵌套不是"能不能开"的问题，而是"在什么负载、什么拦截配置下可接受"的问题。

### 5.4 嵌套虚拟化的生产门禁：素材中的四道关卡

素材 Phase5-03 把"Kata 上 CVM 嵌套"的生产放行条件定义为四道关卡，这是全文最值得抄录的清单之一：

| 门禁 | 内容 | 为什么需要 |
| :--- | :--- | :--- |
| **厂商书面确认** | 云厂商书面确认该机型支持 VT-x 透传与嵌套虚拟化 | 云平台的虚拟化策略可能随时变化（超卖、热迁移、新机型缺透传）——口头承诺不构成运维依据 |
| **性能对照** | 嵌套 vs 裸金属的同型节点性能对照数据 | 嵌套损耗不能外推——必须"同型节点"实测 |
| **运维事件** | 该机型在目标时间段内的虚拟化相关运维事件记录 | 透传/Nested 参数在平台维护中可能被重置 |
| **24-72 小时稳定性** | 连续 24-72 小时的高负载稳定性观察 | 暴露间歇性问题（如特定负载下的 EPT 异常） |

**门禁背后的工程逻辑**：嵌套虚拟化不是一个"配置开关"，而是"云平台底层虚拟化策略的暴露面"——**L1 的虚拟化能力由云平台控制，不在你手里**。素材作者给出的兜底方案也值得注意："未过门禁前只做灰度，兜底是 RHEL 9 裸金属 Worker"——**生产路径永远有一条不依赖云平台虚拟化策略的退路**。

### 5.5 嵌套过不了门禁怎么办：三条退路

嵌套门禁不通过（或云平台明确不支持嵌套）时，Kata/MicroVM 仍有三条退路，素材作者按优先级排列：

**退路一：裸金属 Worker 节点**。在物理机上直接跑 Kata——不经过 L1，VT-x 由 L0 直接提供，无嵌套损耗。这是素材作者明确的首选兜底（"兜底是 RHEL 9 裸金属 Worker"）。代价：需要采购/调配物理机，失去云 VM 的弹性。

**退路二：gVisor 替代**。威胁等级允许时，用 gVisor（第三档）替代 Kata（第四档）——不需要任何虚拟化硬件，CVM 里直接用 systrap platform（[[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 的门禁二）。代价：隔离强度降一档。

**退路三：混合拓扑**。控制面/普通负载在云 VM，高安全负载调度到专门的裸金属池——通过节点标签与 RuntimeClass 调度分离（素材生产方案的"Worker 节点物理故障域分布"正是这个思路）。代价：运维复杂度上升。

**选择逻辑**：先确认"高安全负载的规模与频次"——规模小选退路一（最省心），规模大且威胁等级中选退路二（最省钱），两者都需要时选退路三。**不要让"云平台不支持嵌套"成为整个沙箱项目的阻塞点**——换一条路即可。

---

## 第 6 章 实测验证：CVM 嵌套虚拟化的真实记录

### 6.1 素材中的验证过程

素材 Phase1-04 记录了作者在公司 CVM（云虚拟机）上验证嵌套虚拟化能力的完整过程。验证目标是回答三个问题：CVM 是否透传了 VT-x？KVM 模块能否加载？嵌套虚拟化是否开启？

**第一步：检查 CPU 虚拟化标志**。在 CVM 内执行 `grep -E "vmx|svm" /proc/cpuinfo`，确认 CPU 暴露了 VMX 标志——**这证明宿主平台透传了 VT-x**（若未透传，Guest 内看不到 vmx 标志）。作者在 ht100040.venus 上验证通过。

**第二步：加载 KVM 模块**。`modprobe kvm_intel`（Intel 平台）——模块加载成功说明内核认可 CPU 的虚拟化能力。作者验证通过。

**第三步：检查嵌套开关**。读取 `/sys/module/kvm_intel/parameters/nested`，确认值为 `1`（开启嵌套）或 `Y`。作者验证通过，nested=1。

**验证结论**：CVM 的嵌套虚拟化配置闸门通过——"真实 MicroVM 生命周期和性能仍需 PoC 实测"（素材原话）。**注意这个结论的克制**：配置闸门通过 ≠ 生产可用——后面还有性能对照、稳定性观察等四道关卡（5.4）。

### 6.2 验证清单：任何嵌套场景的可复制步骤

把素材的验证过程整理为可复制清单：

```bash
# 1. 确认 CPU 虚拟化标志（vt-x 透传）
grep -E "vmx|svm" /proc/cpuinfo | head -1

# 2. 确认内核虚拟化支持
ls /dev/kvm

# 3. 加载 KVM 模块并确认 nested 参数
modprobe kvm_intel
cat /sys/module/kvm_intel/parameters/nested   # 期望 1 或 Y

# 4. 创建测试 VM 并确认 VMX 在 Guest 内可见
# （在测试 VM 内重复第 1 步）

# 5. 最小化 Kata/MicroVM 冒烟：创建、启动、执行、销毁
```

### 6.3 "能加载 kvm_intel"不等于"嵌套可用"

素材记录中有一个重要的工程教训：**`modprobe kvm_intel` 成功只证明"当前节点"具备虚拟化能力，不证明"嵌套可用"**。原因：

- 云平台的嵌套支持可能随宿主机的超卖状态、CPU 型号、内核版本变化——**今天可用不代表明天可用**（这正是"厂商书面确认"门禁存在的理由）；
- 某些云平台"透传了 vmx 标志但关闭了 VMCS shadowing"——Guest 能看到 VT-x、KVM 能加载，但嵌套虚拟化的性能或正确性不达标；
- 嵌套的性能损耗与负载类型强相关（I/O 密集 vs CPU 密集差异显著）——**配置验证无法替代负载验证**。

**工程含义**：嵌套虚拟化的验收必须是"配置验证 + 性能对照 + 稳定性观察"的组合，任何单一检查都不能作为放行依据。配置验证与生产放行的关系，好比体检报告的"血常规正常"与"能跑完马拉松"的关系——前者证明没有基础疾病，后者才证明扛得住真实负荷；性能对照与 24-72 小时稳定性观察，就是嵌套虚拟化这台"负荷试验机"。

### 6.4 配置验证之后的真实战场：MicroVM 生命周期 PoC

素材作者在配置闸门通过后，明确把下一步定义为"真实 MicroVM 生命周期和性能仍需 PoC 实测"——这句话背后是一份完整的 PoC 清单，可以视为嵌套验证的"第二阶段"：

| 验证项 | 内容 | 对应风险 |
| :--- | :--- | :--- |
| **创建生命周期** | MicroVM 创建→运行→销毁全流程（含失败路径） | 嵌套下 VM 创建可能间歇性失败 |
| **性能对照** | 同负载下裸金属 vs 嵌套的启动/内存/负载数据 | 嵌套损耗的量化 |
| **并发密度** | 单节点可同时运行的 MicroVM 数量 | 嵌套下 EPT 内存开销放大 |
| **稳定性** | 24-72 小时高负载观察 | 间歇性故障（嵌套特有） |
| **故障恢复** | 节点重启/宿主机维护后的 MicroVM 恢复 | 平台维护对嵌套配置的影响 |

**为什么这份清单重要**：配置验证回答"能不能用"，PoC 回答"好不好用、稳不稳"——素材的生产化路线（[[15 生产化深水区——十个盲区与行业共识]] 的 T0-T7 与 P0-P6）把这份清单嵌入了灰度门禁，任何一项不过都阻止 Kata Profile 的流量切换。

---

## 第 7 章 KVM 与 MicroVM 家族：谁在用、怎么用

### 7.1 三个典型用户对 KVM 的不同使用方式

| 方案 | KVM 使用方式 | 用户态 VMM | 特点 |
| :--- | :--- | :--- | :--- |
| **Firecracker** | 直接 KVM API | 自研极简 VMM（Rust） | 最小设备模型，每秒 150 VM |
| **Kata Containers（QEMU 路线）** | KVM API | QEMU | 全功能设备模型，支持 GPU/TDX |
| **CubeSandbox** | KVM API | CubeHypervisor（自研） | 与 containerd-shim 同进程（Dragonball 路线） |

三者共享同一个硬件底座（KVM + EPT），差异全在用户态 VMM 的设备模型与产品形态——**这印证了第 4 章的设计哲学：内核侧的可信计算基极小且统一，竞争发生在用户态**。这个观察也解释了为什么 MicroVM 生态能同时容下这么多参与者：KVM 修好了所有 VMM 都要走的高速公路，各家的用户态 VMM 是不同品牌的车——车怎么造可以各显神通，但路基是公用的，也因此谁都不用再发明一次"轮子"。KVM 把"最难的部分"（CPU/内存虚拟化）变成了内核的公共能力，用户态只需要解决设备模拟与生命周期管理，VMM 的门槛因此从"懂虚拟化"降为"懂 Linux 进程与 ioctl"。

### 7.2 为什么 MicroVM 方案都选 KVM 而非其他

一个自然的问题：为什么 MicroVM 全部建立在 KVM 上，而不是用户态虚拟化（如 QEMU 的 TCG 模式）或 VMware/KVM 之外的 hypervisor？答案：

1. **KVM 是 Linux 内核的一部分**——与容器生态（Kubernetes/containerd）同栈，部署无需额外 hypervisor 层；
2. **性能接近原生**——EPT + VMX 的硬件路径让"每沙箱一个 VM"在成本上可接受；
3. **API 稳定且简单**——三级 fd 的设计让自研 VMM（Firecracker/CubeHypervisor）的门槛降到"一个 Rust/C 项目"的量级；
4. **硬件加速统一**——Intel/AMD/ARM 都通过 KVM 抽象暴露，VMM 无需为每个平台写单独驱动。

**反例**：需要嵌套虚拟化的云 VM 场景、无 VT-x 的旧硬件——这些场景 KVM 不可用，只能退回 gVisor（用户态）或 runc（原语组合），这正是 [[03 隔离边界的光谱——从共享内核到 MicroVM 的四档技术路线]] 光谱的现实意义：**不是所有环境都能上第四档，选型必须先验证环境能力**。

### 7.3 KVM 与容器生态的共存：同节点双栈

一个常见的部署问题是："Kata 节点和普通容器节点能混用吗？"答案是可以，且素材的测试集群正是这么规划的——同一个 Kubernetes 节点上同时存在默认 runc 运行时与 Kata 运行时：

```yaml
# containerd config.toml 中的运行时注册（同一节点双栈）
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata]
  runtime_type = "io.containerd.kata.v2"
  privileged_without_host_devices = true
```

**双栈的前提**：节点必须同时具备 KVM 能力（/dev/kvm 存在）与容器运行条件——这正是"KVM 模块在容器节点上常见"的原因。**双栈的调度保障**：通过 RuntimeClass 的 `scheduling.nodeSelector` 把 Kata Pod 与 runc Pod 分离到不同节点池（如果担心混合负载的相互影响），或允许同节点混跑（如果资源充足）——素材生产方案选择"三 Profile 独立节点池"的保守路线，测试集群则同节点混跑以节约资源。

**双栈的运维注意**：`/dev/kvm` 的设备权限（容器运行时需要把 KVM 设备注入 Kata Pod 的 VM 进程）、节点内核版本（KVM 模块与内核绑定）、cgroup 层级（Kata VM 进程的 cgroup 归属）——每一项都是混跑时的排障入口。

### 7.4 KVM 排障速查

KVM 相关故障是 MicroVM 沙箱平台最常见的"环境类"问题，按症状给出排查路径：

| 症状 | 可能原因 | 排查命令 |
| :--- | :--- | :--- |
| `/dev/kvm` 不存在 | 内核未加载 kvm 模块 / CPU 无 VT-x / 云平台未透传 | `modprobe kvm_intel`、`grep vmx /proc/cpuinfo` |
| `KVM_CREATE_VM` 失败（EINVAL） | CPU 不支持 VMX 或 BIOS 未开启虚拟化 | `dmesg \| grep -i kvm`、检查 BIOS 设置 |
| Kata Pod 一直 Pending | RuntimeClass 调度器未匹配节点（无节点标签） | `kubectl describe pod` 查调度失败原因 |
| VM 创建慢/超时 | 嵌套虚拟化损耗 / 镜像拉取慢 / 节点过载 | 对比裸金属性能、查镜像大小 |
| Guest 内性能异常 | 嵌套场景用了错误 platform | 确认 `nested=1`、检查 hypervisor 类型 |
| 节点重启后 Kata 不可用 | kvm 模块未随开机加载 / 云平台重置透传 | `systemctl status kvm`、重新验证嵌套配置 |

**排障纪律**（素材经验）：**任何"昨天还能用、今天不能用"的 KVM 故障，先怀疑环境变更（云平台维护、内核升级、模块未加载），再怀疑配置**——嵌套虚拟化尤其如此，因为 L1 的虚拟化能力不在你手里。

---

## 第 8 章 2025-2026：硬件虚拟化的新进展与 Agent 沙箱的下一拐点

第 1-7 章讲的都是"已经稳定运行多年的机制"。但硬件虚拟化这片地基并没有停止生长：2025-2026 年，机密计算进入生产主流、KVM 内核侧完成多轮大版本演进、MicroVM 生态出现重量级采用者。本章把这几条线核实到具体日期与版本，供读者在选型时作为"当前坐标"。以下事实均来自可查证的一手来源（见文末参考文献），笔者不作任何超出来源的推断。

### 8.1 机密计算：TDX 与 SEV-SNP 进入生产

先交代一个概念边界：前七章讲的硬件虚拟化，信任边界画在"hypervisor 与 Guest 之间"——hypervisor 是可信的，它用 VMX/EPT 隔离 Guest。**机密计算（Confidential Computing）** 把边界再推一层：连 hypervisor、乃至整个云平台基础设施都不再可信，Guest 的内存由 CPU 密码学保护，宿主即使拥有全部特权也读不到 Guest 的明文。传统硬件虚拟化是"把房间隔成单间，房东保留钥匙"，机密计算则是"给每个房间发独立保险箱，房东连保险箱密码都没有"。

两条主流路线在 2025-2026 年相继进入生产：

**Intel TDX（Trust Domain Extensions）**。TDX 用硬件建立一个**信任域（Trust Domain, TD）**：TD 的内存由 CPU 加密，宿主 hypervisor 只能看到密文；TD 内部的页表由 TDX module 以安全 EPT（Secure EPT, S-EPT）的形式管理，宿主对 S-EPT 只有只读权限；TD 启动时通过硬件生成度量值，供**远程证明（Remote Attestation）** 验证环境的真实性。生产侧的关键节点：Google Cloud 于 2025 年 8 月把 TDX 机密 VM 扩展到 10 个区域、21 个可用区（C3 系列），并推出 Confidential GKE Nodes；Azure 于 2026 年 2 月宣布基于第五代至强（Xeon）的 Intel TDX 机密 VM 全面可用（general availability，DCesv6/ECesv6 系列）。

**AMD SEV-SNP（Secure Encrypted Virtualization with Secure Nested Paging）**。SEV 家族的演进脉络是：SEV 加密 Guest 内存，SEV-ES 进一步加密寄存器状态，**SEV-SNP** 再加一层"安全嵌套分页"——CPU 侧维护一张**反向映射表（Reverse Map Table, RMP）** 记录每个物理页的归属（宿主、某 Guest、还是共享），防止任何一方篡改页的归属关系，并提供完整性保护与远程证明。生产侧的关键节点：Google 的 SEV-SNP 机密 VM 早在 2024 年 6 月即 GA（N2D 系列）；Azure 于 2025 年 9 月把基于第四代 EPYC 的 DCasv6/ECasv6（SEV-SNP）扩展到更多区域；VMware Cloud Foundation 9.0（2025 年 8 月）同时支持 SEV-SNP 与 TDX；Red Hat OpenShift 4.19 的机密集群（confidential clusters）在 GCP 上同时支持两种技术。

把两条路线放到本专栏的坐标系里看：机密计算并没有取代第 1-7 章的机制，而是在其上叠加——TDX/SEV-SNP 的 Guest 仍然是 VM，仍然走 KVM，仍然有 EPT；区别是内存多了一层密码学保护、宿主多了一个"不可信"的前提。这也解释了素材里"Kata 的 GPU、TDX、SEV-SNP 高级特性目前仅 QEMU hypervisor 支持"的调研结论为什么重要：想给沙箱叠机密计算，选型范围会被收窄到 QEMU 路线。

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph LR
    A["1974<br/>Popek-Goldberg<br/>可虚拟化判据"] --> B["2005-06<br/>Intel VT-x / AMD-V"]
    B --> C["2007-08<br/>EPT / NPT<br/>硬件二级地址转换"]
    C --> D["2013 / 2018<br/>APICv 与 posted interrupt<br/>Firecracker 开源"]
    D --> E["2021-23<br/>SEV-SNP（EPYC Milan）<br/>TDX（Xeon Sapphire Rapids）"]
    E --> F["2025-26<br/>KVM 6.16 TDX host、SEV-SNP 云侧 GA<br/>Lambda MicroVMs、Azure TDX GA"]

    classDef hist fill:#44475a,stroke:#6272a4,color:#f8f8f2
    classDef now fill:#ffb86c,stroke:#ffb86c,color:#282a36
    class A,B,C,D hist
    class E,F now
```

这条时间线想传达的演进逻辑是：硬件虚拟化的每一步，都是在把"需要软件保证的东西"变成"由硬件强制的东西"——2005-2006 解决特权指令，2007-08 解决地址转换，2013 前后解决中断，2021-2026 解决"宿主本身不可信"。每一层硬件的出现，都让隔离更少地依赖软件正确性。

### 8.2 KVM 内核侧的演进：TDX host、CET 虚拟化与 guest_memfd

KVM 本身在 2025-2026 年经历了几轮对虚拟化格局有意义的大版本演进：

**Linux 6.16（2025 年 7 月）：x86 KVM 合入 TDX host 支持**。这是"数年之功"的落地——约 6000 行、100+ 个补丁，从此 Intel 平台可以用 KVM 直接承载 TD 类型的机密 Guest。同一版本里，arm64 KVM 的嵌套虚拟化（nested virtualization）正式启用（默认关闭），受保护 KVM（pKVM）获得透明大页支持，RISC-V 的 KVM 也不再标记为实验性。嵌套虚拟化在 ARM 上的"默认关闭"，与第 5 章"嵌套是云平台策略暴露面"的判断是同一件事的两面：硬件支持与生产放行之间，永远隔着一道门禁。

**Linux 6.18（2025 年 12 月）**：x86 KVM 支持 SEV-SNP 的**密文隐藏（CipherText Hiding）**——防止未授权的 CPU 访问读取 SNP Guest 私有内存的密文；同时支持虚拟化 **CET（Control-flow Enforcement Technology，控制流强制技术）**，即 Intel 的影子栈（Shadow Stack）与间接分支跟踪（IBT）、AMD 的影子栈——这是对"Guest 内防御 ROP 类攻击"的硬件能力虚拟化。此外 6.18 为 guest_memfd 增加了宿主用户态映射支持，为"把 Guest 内存移出内核直接映射（direct map）"铺路；Firecracker 社区也有一条试验分支在探索用 guest_memfd 做"秘密隐藏"。

**Linux 6.19 / 6.20（2025 年底-2026 年初）**：TDX 相关的锁竞争重构（避免 KVM 在代表用户态动作时触发 TDX Module 内部的锁竞争）、guest_memfd 的 vCPU 侧映射与 GUP 源页处理、PMU 与 APIC 相关的补丁陆续合入。把 6.16-6.20 连起来看，KVM 的定位正在从"通用 hypervisor"扩展为"机密计算的宿主侧平台"。

对沙箱平台而言，这些内核侧变化的工程含义是双面的：好消息是机密计算的能力栈在变厚（TDX/SEV-SNP 的 Guest 现在有原生内核支持）；需要警惕的是，**TDX host 支持本身就是一大块新增的内核代码，KVM 的 TCB 在变大**——第 4 章"内核侧可信计算基极小"的哲学仍然成立，但"极小"的边界随着新特性的加入在不断重画，升级内核与审计攻击面因此成为机密计算路线的隐性运维成本。

### 8.3 MicroVM 生态：Firecracker 版本迭代与 Lambda MicroVMs

Firecracker 在 2025-2026 年保持了约每季度一个大版本的节奏：v1.13（2025 年 8 月）带来 ARM 上的 steal time（PVTime）支持、自定义 CPU template 可直接写入配置文件、以及基于 `mincore` 的差分快照（在脏页追踪关闭时仍可近似计算脏页集）；v1.16（2026 年 6 月）加入 PCI virtio 设备热插拔/热拔（开发者预览）、快照恢复时 vsock 的 Unix 域套接字路径覆盖、virtio-net 的 MTU 通告、以及 Linux 6.18 host 内核支持——v1.16.1 于 2026 年 7 月发布。

更值得注意的采用信号出现在 2026 年 6 月：AWS 发布 **Lambda MicroVMs**——一个面向"执行用户生成或 AI 生成代码"的服务器无状态计算原语，其底座正是 Firecracker。按 AWS 官方的口径，Firecracker 已承载"每月超过 15 万亿次 Lambda 函数调用"；Lambda MicroVMs 采取"镜像然后启动"（image-then-launch）模型：用户提交 Dockerfile 与代码，AWS 运行构建、初始化应用、对运行环境的内存与磁盘状态打一份 Firecracker 快照，之后每个 MicroVM 都从这份快照恢复而不是冷启动，从而做到"接近瞬时启动 + 有状态执行（最长 8 小时）+ 自动挂起与按需恢复"。

把这条新闻与本专栏对照：Lambda MicroVMs 本质上是把第 03 篇讨论的"E2B 式 Firecracker 沙箱"做成了云厂商的原生产品形态——VM 级隔离、快照恢复、有状态会话，正是 Agent 代码执行的三个核心诉求。它验证了本系列的一条主线判断：**MicroVM 正在成为 AI 代码执行类负载的事实底座**，而"快照恢复"（Lambda 的 image-then-launch 与 OpenSandbox 的 WarmPool/快照是同一思路）是让 MicroVM 越过冷启动劣势的关键杠杆。

### 8.4 对 Agent 沙箱选型的含义

把 8.1-8.3 的进展汇总，对 Agent 沙箱选型有三条可操作的结论：

其一，**威胁模型决定了要不要叠机密计算**。第 03 篇的"威胁等级→档位"框架假设宿主（云平台）可信；机密计算解决的是"宿主不可信"（云运维越权、平台侧漏洞、合规审计要求）的场景。如果 Agent 沙箱处理的只是普通业务代码，叠 TDX/SEV-SNP 属于不必要的性能税与运维复杂度；如果涉及高价值模型权重、受监管数据、或多方协作场景，机密计算才值得进入候选。**"最强隔离"在第 03 篇不是正确答案，在这里同样不是**。

其二，**嵌套虚拟化与机密计算在 CVM 场景是叠加关系**。在云 VM 里跑 Kata 已经需要第 5 章的四道门禁；若再叠机密计算（CVM 本身是 TDX/SEV-SNP 机密 VM），嵌套层数不变、但每一层的验证成本都在上升。素材"未过门禁前只做灰度"的纪律，在机密计算时代只会更重要，不会更不重要。

其三，**MicroVM 生态的成熟降低了自建门槛**。Firecracker 的版本迭代（热插拔、快照、CPU template）与 AWS 的原生化采用，意味着"每沙箱一个 VM"的工程范式已经度过验证期——平台团队可以放心地把 MicroVM 当作成熟底座来规划，把精力留给上层协议（第 06-09 篇的 OpenSandbox 架构）与容量工程（第 12 篇）。至于机密计算与 MicroVM 在 Agent 场景的最终融合形态，目前仍然言之尚早——但方向已经清晰：隔离边界每向外推一层，Agent 沙箱能承接的信任等级就高一级，代价则是更重的性能与运维账。

---

## 第 9 章 总结与下一篇导读

### 9.1 本文核心要点

1. **硬件虚拟化把隔离从"代码问题"变成"硬件问题"**：VMX 状态机与 EPT 页表由 CPU 电路强制执行，攻击面远小于任何软件隔离
2. **VM Exit 是安全与性能的统一**：只有需要 hypervisor 介入的事件才退出，普通指令在 non-root 模式原生速度执行；VPID 与 Unrestricted Guest 补上了"接近原生"的最后拼图
3. **EPT 是内存隔离的硬件保证**：Guest 物理地址→宿主机物理地址的最后一跳由 hypervisor 独占，Guest 无法构造指向宿主内存的映射；KVM 的 TDP MMU 把 EPT 的维护变成可并发的常规路径
4. **中断虚拟化把"注入"也硬件化**：APICv 与 posted interrupt 让合法中断不经 VM Exit 直达 vCPU，网络密集负载获得接近原生的中断延迟
5. **KVM 三级 fd 是 MicroVM 的 API 底座**：kvm_fd→vm_fd→vcpu_fd，`KVM_RUN` 阻塞循环是虚拟机的运行本质；vCPU 是一个普通用户态线程，这是"每沙箱一个 VM"密度的来源
6. **嵌套虚拟化的退出分类**：L1 不拦截的退出由 L0 直处理——嵌套是隔离的叠加，不是稀释，但性能损耗必须实测
7. **嵌套生产门禁四道关卡**：厂商书面确认、性能对照、运维事件、24-72 小时稳定性——"配置通过"不等于"生产可用"
8. **CVM 验证的教训**：`modprobe kvm_intel` 成功只证明当前节点可用，不证明嵌套可用——验收必须是组合验证
9. **2025-2026 的进展把边界再推一层**：TDX/SEV-SNP 机密计算让"宿主不可信"成为可选项（Azure TDX GA 2026-02、Google TDX 扩展 2025-08、Azure SEV-SNP GA 2025-09）；KVM 6.16 合入 TDX host、6.18 加入密文隐藏与 CET 虚拟化；Firecracker 迭代到 v1.16，AWS Lambda MicroVMs（2026-06）把 MicroVM 做成云原生原语

### 9.2 术语速查

| 术语 | 口径 |
| :--- | :--- |
| **VMX root / non-root** | Intel VT-x 的两种操作模式：hypervisor 在 root，Guest 在 non-root |
| **VM Exit / VM Entry** | Guest 触发硬件捕获离开（/重新进入）non-root 模式的事件 |
| **VMCS** | 每个 vCPU 的虚拟化控制结构，记录 Guest/Host 状态与退出规则 |
| **VMLAUNCH / VMRESUME** | 首次进入 / 再次进入 non-root 模式的指令（clear 状态 vs launched 状态） |
| **VPID** | 虚拟处理器标识，TLB 条目按 vCPU 打标，减少切换时刷新 |
| **Unrestricted Guest** | 允许 Guest 在实模式/未分页模式直接运行的控制位，免除软件模拟 |
| **EPT** | 扩展页表，Guest 物理地址→宿主机物理地址的第二级转换（hypervisor 独占） |
| **GPA / HPA** | Guest 物理地址 / 宿主机物理地址 |
| **EPT Violation / Misconfiguration** | Guest 越权访问被拦截 / EPT 条目自身编码无效（hypervisor 配置错误） |
| **TDP MMU** | KVM 维护 EPT 的无锁 MMU 实现，Linux 5.14 起为 64 位平台默认 |
| **APICv / posted interrupt** | APIC 虚拟化的硬件支持 / 把中断写入 PID 描述符、不经 VM Exit 投递 |
| **KVM_RUN** | 阻塞式 ioctl：运行 vCPU 直到下一次 VM Exit |
| **L0 / L1 / L2** | 物理宿主机 / Worker VM / MicroVM（嵌套层级） |
| **VMCS shadowing / VMCS12** | Intel 嵌套虚拟化：L1 的 VMCS 影子化、L2 的 VMCS 由 L0 后台维护 |
| **嵌套虚拟化** | 在 VM 内再运行虚拟化（L1 内创建 L2），依赖 VT-x 透传与 nested 开关 |
| **机密计算（Confidential Computing）** | 宿主（含 hypervisor/云平台）也不可信的隔离范式，内存由 CPU 密码学保护 |
| **TDX / TD / S-EPT** | Intel 信任域扩展 / 信任域 / 安全 EPT（宿主只读） |
| **SEV-SNP / RMP** | AMD 安全嵌套分页 / 反向映射表（页归属强制） |
| **CET / Shadow Stack** | 控制流强制技术 / 影子栈（KVM 6.18 起可虚拟化） |
| **guest_memfd** | 机密 Guest 私有内存的内核机制（6.18 起支持宿主映射） |

### 9.3 思考题

1. **信任边界递进**：runc→gVisor→KVM→机密计算，信任边界逐层外移。每一层外移分别付出了什么代价？如果把第 03 篇的"威胁等级→档位"框架扩一档"L4：宿主也不可信"，哪些场景需要这一档？

2. **VMCS 的完整性**：VMCS 由硬件做完整性校验、Guest 无法读写。但如果 hypervisor 自身被攻破（VMM 漏洞），VMCS 保护还成立吗？这提示"VMCS 保护"与"VMM 进程沙箱化（jailer）"各自防的是什么？

3. **EPT 的边界**：EPT 保证 Guest 无法构造指向宿主内存的映射，但设备直通（GPU/网卡 DMA）可以绕过 EPT——这就是 IOMMU 存在的理由。请评估一个"MicroVM + 设备直通"的沙箱方案需要哪几层防护叠加。

4. **posted interrupt 的适用性**：posted interrupt 把中断投递做到不经 VM Exit。什么类型的负载最受益、什么类型几乎无感？由此推断"中断虚拟化"对沙箱选型（网络密集 vs CPU 密集）的影响权重。

5. **嵌套的"叠加"语义**：文中说嵌套是"隔离的叠加"不是"稀释"——依据是 L1 不拦截的退出由 L0 直处理。请用这个机制推导：如果 L1 被攻破，L2 还能得到哪些保护、失去哪些保护？

6. **门禁的不可替代性**：为什么"厂商书面确认"是四道关卡之一，而 `grep vmx /proc/cpuinfo` 只是第一步？如果云平台半年后悄悄关闭某机型的嵌套透传，你的监控怎么发现？

7. **机密计算的取舍**：TDX/SEV-SNP 让宿主不可信成为可选项，但带来性能税、运维复杂度与更小的生态（如仅 QEMU hypervisor 支持）。对照你的威胁模型，什么业务值得付这笔税？

8. **MicroVM 的下一拐点**：AWS Lambda MicroVMs 的"镜像→快照→恢复"模型与 OpenSandbox 的 WarmPool/快照是同一思路。这种"快照优先"范式对沙箱平台的内存容量规划（第 12 篇）意味着什么变化？

### 9.4 下一篇导读

本文讲透了 KVM 硬件底座，但"VMM"这个用户态角色还没有展开：**Firecracker 为什么只做 6 个设备？Kata 为什么支持 5 种 hypervisor？rust-vmm 与 CubeHypervisor 是什么关系？** 下一篇 [[05 VMM 解剖——Firecracker、Cloud Hypervisor 与 Kata 的虚拟机监视器家族]] 将沿着"极简↔全功能"的光谱拆解 VMM 家族，回答"虚拟机监视器本身如何设计才安全"。

> [!info] 专栏导航
> 本文是 [[00 专栏导览]] 的第 04 篇。前 3 篇建立了威胁模型（01）、隔离原语（02）与四档光谱（03）；本文深入第四档的硬件机制；下一篇完成 VMM 家族解剖后，隔离技术主线（01-05）收官，第 06 篇起进入平台层。

---

## 参考文献

1. Intel. "Intel 64 and IA-32 Architectures Software Developer's Manual, Vol. 3C: System Programming Guide (VMX)."
2. KVM 官方文档. https://www.kernel.org/doc/html/latest/virt/kvm/api.html
3. Agache et al. "Firecracker: Lightweight Virtualization for Serverless Applications." NSDI 2020.
4. Popek, Goldberg. "Formal Requirements for Virtualizable Third Generation Architectures." CACM 1974.
5. LWN. "The second half of the 6.16 merge window." 2025-06-09. https://lwn.net/Articles/1023075/
6. LWN. "The end of the 6.18 merge window." 2025-10-14. https://lwn.net/Articles/1041004/
7. Microsoft. "Announcing general availability of Azure Intel TDX confidential VMs." 2026-02-26. https://techcommunity.microsoft.com/blog/azureconfidentialcomputingblog/announcing-general-availability-of-azure-intel%C2%AE-tdx-confidential-vms/4495693
8. Google Cloud. "Confidential Computing expands with Intel TDX." 2025-08-29. https://cloud.google.com/blog/products/identity-security/from-clicks-to-clusters-confidential-computing-expands-with-intel-tdx/
9. Microsoft Azure. "GA: DCasv6 and ECasv6 confidential VMs based on 4th Generation AMD EPYC processors." 2025-09-17.
10. AWS News Blog. "Run isolated sandboxes with full lifecycle control: AWS Lambda introduces MicroVMs." 2026-06-22. https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/
11. Firecracker. "Release v1.13.0." 2025-08-28; "Release v1.16.0." 2026-06-04. https://github.com/firecracker-microvm/firecracker/releases
12. Intel. "Bringing the Next Generation of Intel CPU Performance Optimizations to GCC 15 (APX/AVX10.2)." 2025-06-15.
13. Paolo Bonzini. "[PATCH] KVM: x86: enable TDP MMU by default." Linux 5.14, 2021-07-26.
14. 素材调研. Phase1-04 KVM 与硬件虚拟化基础、Phase5-03 Kata 与嵌套虚拟化、Phase5-10 从测试集群到生产
15. 素材验证记录. CVM ht100040.venus 嵌套虚拟化配置闸门验证