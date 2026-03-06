---
title: "Shenandoah——与 ZGC 殊途同归的并发压缩"
date: 2026-03-05
tags: [Java, JVM, GC, Shenandoah, Brooks Pointer, 并发疏散, 读屏障, 写屏障, 低延迟, RedHat, JDK12]
aliases: []
---

# 09 Shenandoah——与 ZGC 殊途同归的并发压缩

**摘要：**

Shenandoah 是由 Red Hat 开发、JDK 12 引入的低延迟垃圾回收器，与 ZGC 有着高度相似的设计目标：**让 GC 停顿时间与堆大小无关，控制在亚毫秒到几毫秒级别**。然而，Shenandoah 和 ZGC 在实现并发对象转移这一核心问题上，选择了截然不同的技术路线：ZGC 利用 64 位地址高位的**着色指针**和**读屏障**，Shenandoah 则在每个对象前放置一个额外的**转发指针（Brooks Pointer）**，并同时使用**读屏障和写屏障**。两条路线各有优劣，在不同场景下表现出不同的特征。本文深入剖析 Shenandoah 的 Brooks Pointer 设计、并发疏散（Concurrent Evacuation）机制、GC 阶段划分、与 ZGC 的技术路线对比，以及 Shenandoah 2.0（JDK 17+ 引入的新一代架构）的改进方向。理解 Shenandoah，不仅是学习一个具体的 GC，更是理解"并发转移"这一关键技术的另一种解法——两种解法的对比，深刻揭示了工程中"没有最好的设计，只有最合适的权衡"。

---

## 第 1 章 Shenandoah 的诞生背景

### 1.1 Red Hat 的动机

ZGC 由 Oracle 开发，Shenandoah 由 Red Hat 独立开发，两者在 JDK 12 和 JDK 11 相继发布，方向几乎一致——这并非巧合，而是 Java 生态在那个时期对"停顿时间可预测的低延迟 GC"的共同需求驱动的。

Red Hat 在企业软件领域有大量的客户运行着对延迟极为敏感的 Java 应用（金融中间件、电信系统、实时数据处理）。这些应用运行在 Red Hat Enterprise Linux 上，服务于大量用户，G1 的几百毫秒停顿在峰值时段会直接造成用户可感知的卡顿。Red Hat 希望有一个不依赖 Oracle 技术路线、由自己掌控的低延迟 GC 实现。

### 1.2 核心设计问题

Shenandoah 和 ZGC 面对的核心工程问题是相同的：**如何在用户线程正在使用对象的同时，安全地将对象从旧地址移动到新地址（并发疏散/并发转移）？**

这个问题的难点在于：移动对象的过程中，旧地址仍然有效（用户线程持有旧指针），新地址刚刚分配（对象正在复制中），如何保证用户线程读取到的是一致、正确的对象状态？

ZGC 的答案是：**把元数据编码进指针（着色指针），在读取时检查并修正（读屏障）**。

Shenandoah 的答案是：**在对象本身里放一个额外的间接层（Brooks Pointer），让所有对对象的访问都经过这个间接层**。

---

## 第 2 章 Brooks Pointer——Shenandoah 的核心数据结构

### 2.1 什么是 Brooks Pointer

**Brooks Pointer**（得名于 Rodney A. Brooks，其在 1984 年的论文中提出了这种转发指针技术）是 Shenandoah 在**每个 Java 对象头之前**额外插入的一个机器字（word，8 字节），它始终指向该对象的"当前有效地址"：

```
普通对象的内存布局（HotSpot，无 Shenandoah）：
┌─────────────────────────────┐
│  Mark Word（8 字节）         │
├─────────────────────────────┤
│  Klass Pointer（4/8 字节）  │
├─────────────────────────────┤
│  实例数据...                │
└─────────────────────────────┘

Shenandoah 下对象的内存布局：
┌─────────────────────────────┐  ← 对象的真实起始地址（对外暴露的是这里 - 8 字节）
│  Brooks Pointer（8 字节）   │  ← 指向当前有效地址（正常情况下指向自身）
├─────────────────────────────┤  ← 传统意义上对象头的起始（Mark Word 在这里）
│  Mark Word（8 字节）         │
├─────────────────────────────┤
│  Klass Pointer（4/8 字节）  │
├─────────────────────────────┤
│  实例数据...                │
└─────────────────────────────┘
```

**正常状态（未转移）**：Brooks Pointer 指向对象**自身**（`brooksPt → this`）。这时 Brooks Pointer 像一个"冗余"的自引用，没有实际作用。

**转移进行中**：当 GC 线程将对象从旧地址复制到新地址时，将**旧对象的 Brooks Pointer 更新为指向新地址**（`oldBrooksPt → newObj`）。此后：
- 用户线程若通过旧指针访问对象，先读 Brooks Pointer，发现它指向新地址，自动转向新地址
- 用户线程若通过新指针（已被 GC 直接更新）访问对象，Brooks Pointer 指向自身，直接访问

```
转移过程示意：

转移前：
引用 ref → [旧对象地址]
           ┌─────────────────────┐
           │ Brooks Ptr: 自身     │ ← 指向自己
           │ Mark Word           │
           │ 实例数据: value=42  │
           └─────────────────────┘

GC 复制到新地址后，更新旧对象的 Brooks Ptr：
引用 ref → [旧对象地址]
           ┌─────────────────────┐
           │ Brooks Ptr: 新地址  │ ← 现在指向新对象
           │ Mark Word           │  （旧对象数据仍存在，但通过 Brooks Ptr 透明转发）
           │ 实例数据: value=42  │
           └─────────────────────┘
                    ↓
           [新对象地址]
           ┌─────────────────────┐
           │ Brooks Ptr: 自身     │ ← 新对象的 Brooks Ptr 指向自身
           │ Mark Word           │
           │ 实例数据: value=42  │  （复制的完整数据）
           └─────────────────────┘
```

### 2.2 Brooks Pointer 的读/写屏障

为了让所有对象访问都经过 Brooks Pointer 的间接层，Shenandoah 需要在所有对象访问处插入屏障：

**读屏障（Read/Load Barrier）**：每次读取一个对象引用后，如果该引用指向一个处于转移集合中的对象，读屏障通过 Brooks Pointer 找到新地址并返回。

**写屏障（Write Barrier / Store Barrier）**：每次向对象引用字段写入时，同样需要检查目标对象是否需要通过 Brooks Pointer 转发，确保写入的是新对象而非旧对象的副本。

**对比 ZGC**：ZGC 只有读屏障（Load Barrier），没有写屏障。Shenandoah 同时有读屏障和写屏障，屏障覆盖范围更广，理论上开销更大。但 Shenandoah 的屏障逻辑相对简单（只是追随 Brooks Pointer），而 ZGC 的读屏障逻辑更复杂（颜色检查、慢速路径重映射）。两者的实际开销因应用特征而异，很难一概而论地说哪个更重。

### 2.3 Brooks Pointer 的内存开销

每个对象额外增加 8 字节（一个机器字）的 Brooks Pointer 开销。这是 Shenandoah 与 ZGC 相比一个明显的劣势——ZGC 的着色指针利用了指针中现有的未用高位，**没有任何额外内存开销**；Shenandoah 的 Brooks Pointer 是额外增加到每个对象头中的，使堆内存中每个对象都增大了 8 字节。

对于对象数量极多（数以亿计的小对象）的应用，这额外的 8 字节 × N 个对象可能是几 GB 的额外内存消耗。这也是 Shenandoah 2.0（分代 Shenandoah）着力优化的方向之一。

---

## 第 3 章 Shenandoah 的 GC 阶段

### 3.1 完整 GC 周期概览

Shenandoah 的 GC 周期同样分为三大阶段，每个阶段各有 STW 和并发部分：

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}}%%
graph LR
    subgraph "标记阶段"
        A["初始标记\nSTW 极短"]
        B["并发标记\n与用户线程并发"]
        C["最终标记\nSTW 极短"]
        A --> B --> C
    end

    subgraph "疏散阶段"
        D["并发清理\n回收全空 Region"]
        E["初始疏散\nSTW 极短"]
        F["并发疏散\n与用户线程并发"]
        D --> E --> F
    end

    subgraph "更新引用阶段"
        G["初始更新引用\nSTW 极短"]
        H["并发更新引用\n与用户线程并发"]
        I["最终更新引用\nSTW 极短"]
        G --> H --> I
    end

    C --> D
    F --> G

    classDef stw fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef concurrent fill:#50fa7b,stroke:#50fa7b,color:#282a36
    class A,C,E,G,I stw
    class B,D,F,H concurrent
```

**阶段一：标记（Marking）**

- **初始标记（Initial Mark）—— STW，极短**：STW 扫描所有 GC Roots，标记其直接可达对象，将这些对象加入标记工作队列。
- **并发标记（Concurrent Mark）—— 并发**：从工作队列出发，并发遍历整个对象图，通过三色标记标记所有可达对象。Shenandoah 使用 SATB（原始快照）处理并发期间的引用变化，与 G1 相同。
- **最终标记（Final Mark）—— STW，极短**：处理 SATB 队列中的剩余对象，完成最终标记，同时确定"疏散集合"（Evacuation Set）——垃圾最多的那些 Region。

**阶段二：疏散（Evacuation）**

- **并发清理（Concurrent Cleanup）—— 并发**：回收标记阶段结束后存活率为 0%（全部是垃圾）的 Region，这些 Region 直接变为 Free，无需复制任何对象。
- **初始疏散（Initial Evacuation）—— STW，极短**：疏散 GC Roots 直接引用的、位于疏散集合中的对象，确保 GC Roots 指向的对象有确定的新地址。
- **并发疏散（Concurrent Evacuation）—— 并发**：将疏散集合中所有 Region 的存活对象**并发地**复制到新 Region，同时更新旧对象的 Brooks Pointer 指向新地址，用户线程通过 Brooks Pointer 透明地访问已移动的对象。

**阶段三：更新引用（Update References）**

Shenandoah 在疏散阶段结束后，堆中仍然存在大量指向旧地址的引用字段（只有 Brooks Pointer 保持了透明转发，但旧指针仍然存在）。更新引用阶段负责将所有这些旧指针统一更新为新地址：

- **初始更新引用（Initial Update References）—— STW，极短**：仅更新 GC Roots 中的引用，工作量极小。
- **并发更新引用（Concurrent Update References）—— 并发**：遍历整个堆，将所有指向已移动对象的引用字段更新为新地址（通过 Brooks Pointer 查找）。完成后，Brooks Pointer 的转发使命结束，所有指针直接指向新地址，旧 Region 可以安全释放。
- **最终更新引用（Final Update References）—— STW，极短**：更新最后剩余的 GC Roots 引用（并发阶段可能遗漏的），完成清理。

### 3.2 与 ZGC GC 流程的对比

| 阶段 | ZGC | Shenandoah |
| :--- | :--- | :--- |
| **标记** | 初始标记（STW）+ 并发标记 + 最终标记（STW）| 相同 |
| **对象转移** | 并发转移（无单独"更新引用"阶段，重映射与下次标记合并）| 并发疏散（有单独的"更新引用"阶段）|
| **引用修正** | 通过读屏障懒式修正（访问时按需更新）| 独立的"并发更新引用"阶段主动修正所有引用 |
| **STW 次数** | 3 次（初始标记、最终标记、初始转移）| 5 次（初始标记、最终标记、初始疏散、初始更新引用、最终更新引用）|
| **每次 STW 时间** | < 1ms | < 1ms（但次数更多）|

Shenandoah 有 5 次 STW 停顿，ZGC 只有 3 次。虽然每次都很短，但频繁的 STW 在某些对停顿次数敏感的场景（如实时系统）仍然是劣势。

---

## 第 4 章 Brooks Pointer vs 着色指针——两种技术路线的本质对比

### 4.1 核心思想的差异

**ZGC（着色指针）**：元数据在**指针**上。GC 状态信息编码在指针的高位比特中，每次通过指针访问对象时，读屏障检查颜色，按需修正。"对象本身不变，指针携带状态"。

**Shenandoah（Brooks Pointer）**：元数据在**对象**上。每个对象前额外存储一个转发指针，所有对对象的访问都经过这个间接层。"指针不变，对象本身提供转发"。

### 4.2 并发疏散时的行为差异

**ZGC**：GC 移动对象后，通过**转发表**记录旧→新地址映射。用户线程持有旧指针，下次读取时读屏障发现颜色不对，查转发表，更新指针，返回新地址。

**Shenandoah**：GC 移动对象后，更新**旧对象的 Brooks Pointer**指向新地址。用户线程持有旧指针，读取对象时通过 Brooks Pointer 透明跳转到新地址（就算没有意识到对象已移动，也能访问到最新数据）。

**一个关键竞争条件**：并发疏散时，GC 线程和用户线程可能同时尝试向被转移的对象写数据——GC 线程在将旧对象复制到新地址（正在写新对象），用户线程也在更新旧对象的字段（写旧对象）。如果没有同步，写操作可能丢失。

**Shenandoah 的解决方案**：GC 线程在更新旧对象 Brooks Pointer 时使用 **CAS（Compare-And-Swap）** 原子操作。同时，写屏障确保用户线程对位于疏散集合中的对象的写操作，能够被"转发"到新对象。

### 4.3 平台兼容性

**ZGC 的着色指针依赖 64 位地址空间的高位比特**，要求：
- 64 位操作系统
- 不能开启 CompressedOops（压缩指针会占用着色指针所需的地址位）
- 需要操作系统支持多重虚拟地址映射（Linux/macOS 支持，某些较旧的 Windows 版本有限制）

**Shenandoah 的 Brooks Pointer 是通用方案**：
- 兼容 32 位系统（虽然实际中 32 位系统已经很少）
- 不依赖特殊的地址空间布局
- 更容易移植到不同的 JVM 实现和平台

这是 Shenandoah 相比 ZGC 在可移植性上的优势——它可以更容易地被移植到 OpenJDK 的各种发行版中，而不受平台的限制。

---

## 第 5 章 Shenandoah 2.0——新一代架构

### 5.1 Shenandoah 1.0 的短板

原始的 Shenandoah（以下称 Shenandoah 1.0）与早期 ZGC 一样，是**非分代的**——每次 GC 都扫描和处理整个堆。与非分代 ZGC 一样，Shenandoah 1.0 违背了分代假说，对短命对象和长命对象使用相同的处理策略，吞吐量因此受到影响。

此外，Brooks Pointer 每个对象增加 8 字节，在对象数量极多的应用中内存开销不可忽视。

### 5.2 分代 Shenandoah 的探索

Red Hat 的工程师在社区积极推进**分代 Shenandoah** 的开发，目标与 JDK 21 分代 ZGC 相似：引入新生代/老年代的区分，让短命对象更快被回收，减少每次 GC 需要处理的数据量，提升吞吐量。

分代 Shenandoah 的实现比分代 ZGC 更复杂（因为 Brooks Pointer 在每个对象前，分代 GC 需要处理更多的跨代引用场景），但技术路线已经明确，相关 JEP 正在推进中。

### 5.3 与 ZGC 的竞争格局

目前在 OpenJDK 生态中，ZGC 和 Shenandoah 是两个并行存在的低延迟 GC 选项：

- **ZGC**：由 Oracle 维护，更激进（纯读屏障，无写屏障，无额外内存开销），分代版本（JDK 21）已正式发布，是 Oracle JDK 的主推方向
- **Shenandoah**：由 Red Hat 维护，更保守（Brooks Pointer 简单直接，兼容性更广），是 Red Hat 系发行版（如 OpenJDK Fedora/RHEL 版本）的内置选项

---

## 第 6 章 Shenandoah、ZGC 与 G1 的全面对比

| 维度 | G1 | ZGC（分代，JDK 21）| Shenandoah |
| :--- | :--- | :--- | :--- |
| **STW 停顿目标** | 几十~几百 ms | < 1ms | < 1ms（但停顿次数多）|
| **STW 次数/GC 周期** | 2（初始标记+重新标记）| 3 | 5 |
| **停顿与堆大小的关系** | 正相关 | 无关（常数）| 无关（常数）|
| **对象转移方式** | STW 期间复制 | 并发转移（着色指针+读屏障）| 并发疏散（Brooks Pointer+读写屏障）|
| **内存开销** | RSet（5%~20%）| 极低（着色指针无额外内存）| Brooks Pointer（每对象+8字节）|
| **吞吐量** | 最高 | 分代版本接近 G1 | 略低于 G1（Brooks Pointer + 双屏障）|
| **平台兼容性** | 全平台 | 64位，需多重内存映射支持 | 全平台（兼容性最好）|
| **适用堆大小** | 4GB~数十 GB | 几百 MB ~ 16TB | 几百 MB ~ 数百 GB |
| **JDK 默认版本** | JDK 9~（服务端默认）| 非默认（需显式启用）| 非默认（需显式启用）|
| **分代支持** | 完整分代 | JDK 21 分代 ZGC | 开发中 |
| **维护方** | Oracle | Oracle | Red Hat |

---

## 第 7 章 Shenandoah 的适用场景与配置

### 7.1 最适合 Shenandoah 的场景

**对停顿时间极度敏感但对吞吐量要求不是最苛刻的应用**：Shenandoah 在停顿时间上与 ZGC 相当（都是亚毫秒级），但吞吐量通常略低于 ZGC 分代版本，适合那些停顿敏感但吞吐量允许有一定余量的场景。

**使用 Red Hat OpenJDK 发行版的环境**：Shenandoah 在 Red Hat 发行的 OpenJDK 版本中有深度优化和长期支持，如果基础设施是 RHEL/Fedora，Shenandoah 是更受支持的选择。

**需要跨平台兼容的低延迟 GC**：在某些不完全支持 ZGC 着色指针技术（如特殊的操作系统或硬件）的环境中，Shenandoah 的 Brooks Pointer 方案兼容性更好。

### 7.2 Shenandoah 关键参数

| 参数 | 含义 | 建议 |
| :--- | :--- | :--- |
| `-XX:+UseShenandoahGC` | 启用 Shenandoah | JDK 12+ |
| `-XX:ShenandoahGCMode` | GC 模式（`normal`/`iu`/`passive`）| 默认 `normal`，`iu` 是 Incremental Update 实验性模式 |
| `-XX:ShenandoahGCHeuristics` | 启发式策略（`adaptive`/`static`/`compact`）| 默认 `adaptive`（自适应），生产推荐 |
| `-XX:ShenandoahAllocationThreshold` | 触发 GC 的分配速率阈值 | 默认 10%，分配慢可调高 |
| `-XX:ShenandoahInitFreeThreshold` | 初始空闲堆比例触发并发 GC | 默认 70% |
| `-XX:ShenandoahMinFreeThreshold` | 最低空闲比例触发紧急 GC | 默认 10% |

> [!warning] 生产避坑
> Shenandoah 的 `compact` 启发式模式会尽可能积极地压缩堆（回收后尽量缩小堆大小），适合内存受限的环境，但会增加 GC 频率。不要在高吞吐量场景中使用 `compact` 模式，否则 GC 过于频繁会反而影响性能。生产环境推荐使用默认的 `adaptive` 模式，配合 `-Xms=-Xmx` 固定堆大小。

---

## 第 8 章 总结——两条路通向同一目标

Shenandoah 和 ZGC 代表了解决"并发对象转移"这一核心问题的两种工程路线，它们共同揭示了一个重要的工程智慧：

**当一个技术问题没有明显最优解时，不同团队会基于各自的约束和偏好，走出不同但各自合理的路**。

**ZGC 路线**（着色指针 + 读屏障）：将 GC 状态信息编码进指针本身，利用 64 位地址空间的富余位数，零额外内存开销，只需读屏障。代价：依赖 64 位平台特性，技术实现复杂（多重虚拟地址映射）。

**Shenandoah 路线**（Brooks Pointer + 读写屏障）：在对象前增加一个转发指针，提供简单透明的间接访问层，平台兼容性好。代价：每个对象增加 8 字节内存开销，同时需要读屏障和写屏障，屏障覆盖面更广。

两条路最终都实现了亚毫秒级停顿。ZGC 在内存开销和平台现代化方面更优，Shenandoah 在兼容性和实现直觉上更简单。Oracle 主推 ZGC，Red Hat 主推 Shenandoah，Java 生态由此拥有了两个高质量的低延迟 GC 选项。

**GC 演进总结**：

```
Serial（单线程，STW）
  → Parallel（多线程并行，STW 时间缩短，但与堆大小正相关）
    → CMS（并发标记，老年代停顿降至 100ms 级别，但碎片化）
      → G1（Region 化，可预测停顿，解决碎片，停顿 10ms~200ms）
        → ZGC/Shenandoah（并发转移，亚毫秒停顿，与堆大小解耦）
            → 分代 ZGC/分代 Shenandoah（兼顾亚毫秒停顿 + 高吞吐量）
```

下一篇 [[类加载器/10 类加载机制——双亲委派模型与打破它的场景]] 将离开 GC 的领域，转向另一个核心子系统——类加载器，深入剖析 JVM 如何将 `.class` 字节码转化为可运行的类型表示，以及双亲委派模型为何被设计出来、在哪些场景下又不得不被打破。

---

## 参考文献

1. Aleksey Shipilev, "Shenandoah: The Garbage Collector That Could", 2015 Red Hat Summit
2. Erin Schnabel & Christine Flood, "Shenandoah GC in OpenJDK", FOSDEM 2018
3. Roman Kennke, "Shenandoah Status Update 2020", OpenJDK Blog
4. Rodney A. Brooks, "Trading data space for reduced time and code space in real-time garbage collection on stock hardware", ACM LFP 1984（Brooks Pointer 原始论文）
5. 周志明, 《深入理解 Java 虚拟机（第三版）》, 第 3.8 章：低延迟垃圾收集器
6. JEP 189: Shenandoah: A Low-Pause-Time Garbage Collector (JDK 12)
7. OpenJDK Wiki, "Shenandoah GC", wiki.openjdk.org/display/shenandoah

---

> [!note] 思考题
> 1. Shenandoah 使用'Brooks Pointer'（间接指针/转发指针）实现并发压缩——每个对象多一个指针字段指向自身，GC 移动对象后更新转发指针。与 ZGC 的着色指针方案相比，Brooks Pointer 的内存开销和运行时开销各有什么不同？在什么工作负载下 Shenandoah 会优于 ZGC？
> 2. Shenandoah 和 ZGC 都声称实现了亚毫秒级 STW 停顿。但 Shenandoah 的并发阶段使用'写屏障'（类似 G1），而 ZGC 使用'读屏障'。两种屏障对应用吞吐量的影响模式有什么差异？在'读远多于写'的缓存服务场景中，哪种 GC 的吞吐量损失更小？
> 3. Shenandoah 由 Red Hat 主导开发，但 Oracle 的 JDK 发行版不包含 Shenandoah（只有 OpenJDK 包含）。在生产环境选型时，如果你的公司使用 Oracle JDK，低延迟 GC 的唯一选择是 ZGC。你如何评估从 Oracle JDK 迁移到 OpenJDK 的风险和成本？
