---
title: "JIT 编译与逃逸分析——从解释执行到本地代码"
date: 2026-03-05
tags: [Java, JVM, JIT, C1, C2, 分层编译, 逃逸分析, 内联, 锁消除, 栈上分配, 标量替换, 热点代码, Profiling]
aliases: []
---

# 12 JIT 编译与逃逸分析——从解释执行到本地代码

**摘要：**

Java 程序的高性能，在很大程度上依赖于 JIT（Just-In-Time）编译器——它在运行时将热点字节码编译为本地机器码，使 Java 程序的性能逐渐逼近甚至在某些场景超越 C++。理解 JIT 编译是理解 Java 性能的关键。本文深入剖析 HotSpot 的**分层编译（Tiered Compilation）** 架构（解释器 → C1 客户端编译器 → C2 服务端编译器，各层的触发条件和优化深度）、JIT 最重要的优化手段**方法内联（Method Inlining）**（为什么说"内联是一切优化的基础"）、以及 C2 最精彩的优化之一——**逃逸分析（Escape Analysis）** 及其三种应用（**栈上分配、标量替换、锁消除**）。最后讨论代码缓存（Code Cache）的管理、JIT 的去优化（Deoptimization）机制，以及 JDK 17 引入的实验性 **AOT（Ahead-Of-Time）** 编译和 GraalVM Native Image 的权衡。

---

## 第 1 章 解释执行的天花板与 JIT 的必然性

### 1.1 解释执行为什么慢

[[执行引擎/11 字节码指令集与执行引擎]] 介绍了 HotSpot 的模板解释器——每条字节码指令由一段预先生成的本地代码模板执行。即使是模板解释器，与直接编译为机器码相比，仍然有本质的性能差距：

**字节码与机器码的语义粒度不匹配**：一条 Java 字节码（如 `iadd`）对应若干条本地指令（至少需要从内存/栈加载操作数、执行运算、写回结果），模板解释器为每条字节码的执行增加了框架开销（维护操作数栈、更新程序计数器等）。

**无法跨指令优化**：解释器逐条执行字节码，看不到整个方法的全局视图，无法进行跨指令的优化（如常量折叠、死代码消除、循环展开）。

**无法利用 CPU 高级特性**：现代 CPU 有 SIMD（向量化指令）、乱序执行、分支预测优化等能力。解释器生成的代码序列较为保守，无法充分利用这些特性。JIT 编译器（尤其是 C2）有专门的优化 pass 来针对特定 CPU 生成最优机器码。

### 1.2 JIT 的基本思想——热点代码才值得编译

JIT 编译（Just-In-Time Compilation）的核心思想：**不是所有代码都值得编译**。

Pareto 原则在代码执行中同样适用：通常 20% 的代码消耗了 80% 的 CPU 时间（热点代码）。JIT 的策略是：
1. 程序启动时，所有方法从解释执行开始（启动快，无需等待编译）
2. JVM 收集每个方法的**执行次数和 Profile 数据**（调用次数、分支走向、类型分布等）
3. 当某个方法的执行次数达到阈值（热点），JIT 将其编译为机器码，后续调用直接执行机器码

这个模型的优势：解释执行期间收集的 Profile 数据（"这个接口调用实际上 99.9% 的情况是调用 X 的实现"）为 JIT 提供了宝贵的运行时信息，使 JIT 可以做出比 AOT 编译器（只能基于静态分析）更激进的优化假设，反而在某些场景获得更高性能。

---

## 第 2 章 分层编译——从冷启动到巅峰性能

### 2.1 JDK 8 之前：C1 和 C2 的二选一

HotSpot 有两个内置 JIT 编译器：

**C1 编译器（客户端编译器）**：编译速度快，优化程度浅（主要做方法内联、少量局部优化），适合桌面应用（追求快速启动，用户不想等"预热"）。对应 `-client` JVM 参数。

**C2 编译器（服务端编译器）**：编译速度慢，优化程度极深（全局值编号、循环变换、逃逸分析、向量化等），生成的机器码质量极高，适合服务端长时间运行的应用（追求峰值吞吐量，可以接受更长的预热时间）。对应 `-server` JVM 参数。

JDK 8 之前，用户必须选择 `-client` 或 `-server` 模式，鱼和熊掌不可兼得：C1 启动快但峰值性能低，C2 峰值性能高但启动慢（预热时间长）。

### 2.2 JDK 7+ 分层编译（Tiered Compilation）

**分层编译（`-XX:+TieredCompilation`，JDK 8 开始默认开启）** 将执行过程分为五个层次（Level 0~4），结合了 C1 的快速编译和 C2 的深度优化：

| 层次 | 执行方式 | Profile 收集 | 说明 |
| :--- | :--- | :--- | :--- |
| **Level 0** | 解释执行 | 是（方法调用次数、循环回边次数）| 冷代码，刚启动时所有代码在此 |
| **Level 1** | C1 编译，无 Profile | 否 | 简单方法的快速编译，不再收集 Profile |
| **Level 2** | C1 编译，有限 Profile | 部分 | 方法调用计数 + 回边计数 |
| **Level 3** | C1 编译，完整 Profile | 是（完整类型分布、分支统计）| 最常用的 C1 层，为 C2 提供最完整的 Profile |
| **Level 4** | C2 编译，深度优化 | 否（利用 Level 3 收集的 Profile）| 最高优化层，极少数热点方法最终在此执行 |

**典型的编译路径**：

```
冷方法：Level 0（解释）→ Level 3（C1 + 完整 Profile）→ Level 4（C2 深度优化）

简单方法（如 getter/setter）：
Level 0 → Level 1（C1 快速编译，不再收集 Profile，直接优化）

C2 编译器繁忙时的退路：
Level 0 → Level 2（C1 有限 Profile，临时编译等待 C2）→ Level 4
```

分层编译的效果：启动速度接近 C1（方法很快被 Level 3 编译），峰值性能接近纯 C2（热点最终被 Level 4 深度优化）。

### 2.3 热点阈值——什么时候触发编译

JVM 通过两个计数器决定是否触发 JIT 编译：

**方法调用计数器（Invocation Counter）**：记录方法被调用的次数。默认 Level 3 → Level 4 的阈值（`-XX:Tier4InvocationThreshold`）约为 15000 次。

**回边计数器（Back Edge Counter）**：记录方法内**循环回跳**的次数（每次循环体结束跳回循环头时 +1）。这是为了处理**单次调用但内含超长循环**的方法——如果只看调用次数，这类方法永远达不到阈值，但循环体实际上是热点。

**OSR（On-Stack Replacement，栈上替换）**：当一个方法的回边计数器达到阈值，JVM 不等方法返回后再用编译版本，而是**直接在方法执行期间（循环运行到一半时）替换为编译版本继续执行**。这称为"栈上替换"——字面意思是在运行时替换当前栈帧中的解释执行代码为编译执行代码。

---

## 第 3 章 方法内联——一切优化的基础

### 3.1 什么是方法内联

**方法内联（Method Inlining）** 是将被调用方法的函数体直接嵌入到调用处，消除方法调用的开销（保存/恢复寄存器、参数传递、栈帧创建/销毁、返回值传递）。

```java
// 内联前：
int result = add(a, b);

// 内联后（编译器将 add 方法体直接替换到调用处）：
int result = a + b;  // add 方法体被直接嵌入，方法调用消失了
```

内联消除了方法调用本身的开销，但**更重要的是**：内联之后，调用者和被调用者的代码合并为一个更大的代码块，JIT 编译器可以对这个更大的代码块进行**跨方法边界的全局优化**——常量传播、死代码消除、循环提升等优化的效果因此得以跨越方法边界。这是"内联是一切优化的基础"的真正含义。

### 3.2 内联的条件与限制

**内联的条件**（HotSpot C2 的策略）：
- **方法足够小**：默认 bytecode 不超过 35 字节（`-XX:MaxInlineSize=35`）的方法，如果热度足够，直接内联
- **调用足够热**：被调用超过 `-XX:MinInliningThreshold`（默认 250）次的方法会更积极地被考虑内联
- **调用层级不超过限制**：默认最多内联 9 层（`-XX:MaxInlineLevel=9`），防止递归方法引起内联爆炸

**不能内联的情况**：
- **虚方法调用存在多态**：如果一个接口方法有 3 个以上不同的实现类（"超多态"，Megamorphic），JIT 无法确定要内联哪一个，放弃内联，转为虚方法调用
- **方法体过大**：超过 `-XX:MaxFreqInlineSize`（默认 325 字节）的方法不参与热点内联
- **native 方法**：本地方法无法内联（除非有专门的 Intrinsic 实现，见下文）

### 3.3 内联缓存与类型特化（Speculative Optimization）

对于虚方法调用（`invokevirtual`、`invokeinterface`），JIT 在解释执行期间收集了**调用点的类型分布（Call Site Type Profile）**：

- **单态调用（Monomorphic）**：99% 的调用都是某一具体类型（如 `ArrayList`）。C2 对此做**投机内联（Speculative Inlining）**——假设调用目标永远是这个类型，直接内联它的方法体，同时插入一个**类型保护（Type Guard）**：

```
// C2 生成的伪机器码：
if (receiver.class == ArrayList) {
    // 直接执行内联的 ArrayList.get() 代码（快速路径）
    ... inlined code ...
} else {
    // 假设失败（fallback），走正常虚方法分派（慢速路径）
    call virtual get();
}
```

- **双态调用（Bimorphic）**：两种类型，JIT 生成两个 if-else 分支，各内联一次。
- **超多态调用（Megamorphic，3 种以上）**：放弃内联，使用虚方法表直接调用。

这种"投机优化 + 保护检查"的模式，使 Java 的多态调用在实际中通常只有一两种类型时，性能接近 C++ 的直接函数调用。

---

## 第 4 章 逃逸分析——最精彩的运行时优化

### 4.1 什么是逃逸分析

**逃逸分析（Escape Analysis）** 分析一个对象的**作用域是否"逃逸"出了它被创建的方法或线程**。如果一个对象：
- 没有被方法返回（不从方法逃逸）
- 没有被赋值给全局变量、实例字段（不在方法外部被引用）
- 没有被传递给不可分析的方法（如 native 方法）
- 没有被不同线程共享

…那么这个对象就**没有逃逸**，JIT 编译器可以对它进行三种激进优化。

### 4.2 优化一：栈上分配（Stack Allocation）

正常情况下，`new` 出来的对象都在**堆**上分配，需要 GC 管理。如果逃逸分析确定对象不会逃逸，可以直接在**当前线程的栈上分配**：

```java
void processRequest() {
    // Point 对象仅在 processRequest() 内使用，不逃逸
    Point p = new Point(3, 4);
    double dist = Math.sqrt(p.x * p.x + p.y * p.y);
    // p 仅在此方法内使用，不被返回，不被赋给字段
    // JIT 可以将 p 分配在栈上
}
// processRequest() 返回时，栈帧销毁，p 随之消亡，无需 GC 参与！
```

**栈上分配的收益**：
- 方法返回时对象**自动消失**（随栈帧销毁），完全不需要 GC 介入
- 栈内存分配极快（指针碰撞，几乎零开销）
- 对象访问可能因为与其他局部变量在同一 CPU 缓存行而获得更好的缓存命中率

**HotSpot 的现实**：严格意义上的"栈上分配"在 HotSpot 中通过**标量替换**实现（见下节），而不是真的在栈上放一整个对象，但效果相同。

### 4.3 优化二：标量替换（Scalar Replacement）

**标量（Scalar）** 是无法再分解的基本数据类型（`int`、`long`、`boolean` 等）。**标量替换** 是逃逸分析最常见的应用：当一个对象不会逃逸时，将该对象**拆解为若干局部变量**（标量），不再创建对象实例：

```java
// 优化前（有 new，有堆分配）：
Point p = new Point(3, 4);
double dist = Math.sqrt(p.x * p.x + p.y * p.y);

// 标量替换后（JIT 的视角，对用户透明）：
int p_x = 3;   // Point.x 被替换为局部变量 p_x
int p_y = 4;   // Point.y 被替换为局部变量 p_y
double dist = Math.sqrt(p_x * p_x + p_y * p_y);
// Point 对象完全消失！不再有 new，不再有堆分配
```

标量替换后，原本需要堆分配的对象变成了几个普通的局部变量（可以放寄存器或栈上），**完全消除了对象的创建和 GC 开销**。

这就是为什么在 JVM 中，**大量创建短命的小对象（如 `Point`、`StringBuilder`、临时包装类）不一定会带来显著的 GC 压力**——如果这些对象不逃逸，JIT 的标量替换会让它们根本不进入堆。

> [!warning] 生产避坑：标量替换的限制
> 标量替换依赖逃逸分析，而逃逸分析是过程间分析（Interprocedural Analysis）——需要内联支持。如果方法因为太大或多态而无法被内联，其中创建的对象的逃逸状态无法被分析，标量替换就不会发生。因此，将短命对象的创建方法保持小巧、并尽量避免多态（单态调用）是让标量替换充分发挥的关键。

### 4.4 优化三：锁消除（Lock Elision）

逃逸分析的第三个应用：如果一个被 `synchronized` 保护的对象**只有一个线程能访问**（对象不逃逸，其他线程无法持有引用），那么对这个对象的锁操作**完全不需要**——加锁是为了防止多线程竞争，但如果根本不存在竞争，锁的开销就是纯粹的浪费。

```java
// 看起来有 synchronized，实际上锁会被消除：
public String concatenate(String s1, String s2) {
    StringBuffer sb = new StringBuffer();  // sb 不逃逸（局部变量，未被返回/传递）
    sb.append(s1);  // StringBuffer 的方法是 synchronized 的
    sb.append(s2);  // 这里的锁，逃逸分析后会被消除！
    return sb.toString();
}
// JIT 分析发现：sb 只在本方法内使用，没有其他线程能持有 sb 的引用
// 因此 sb.append() 的 synchronized 块对应的 monitorenter/monitorexit 指令被删除
```

锁消除的实际意义：很多 Java 历史 API（`StringBuffer`、`Vector`、`Hashtable`）有不必要的同步，现代代码理论上应该改用 `StringBuilder`、`ArrayList`、`HashMap`，但遗留代码中大量使用同步容器——锁消除让这些遗留代码在单线程上下文中的性能几乎不受影响。

---

## 第 5 章 代码缓存（Code Cache）

### 5.1 代码缓存是什么

JIT 编译后的机器码存储在**代码缓存（Code Cache）** 中——一块专门的堆外内存区域，由 JVM 自己管理（不在 GC 的管辖范围内）。

JDK 8 引入了**分段代码缓存（Segmented Code Cache）**，将代码缓存分为三段：
- **Non-method Code**：JVM 内部代码（解释器、桩代码等），永久存在
- **Profiled Code**：Level 1~3 的 C1 编译代码（带 Profile 信息，会被 C2 替换或丢弃）
- **Non-profiled Code**：Level 4 的 C2 编译代码（长期存在的最优代码）

### 5.2 代码缓存满了会怎样

代码缓存的默认大小：JDK 8，240MB（64 位服务端 JVM）。

当代码缓存被填满时，JVM 会打印警告：
```
CodeCache is full. Compiler has been disabled.
```

**JIT 编译器被禁用**——新的热点代码无法被编译，只能继续解释执行，性能退化。已编译的方法仍然继续执行编译版本，但新的热点无法得到编译优化。

通过 `-XX:ReservedCodeCacheSize=512m` 增大代码缓存可以缓解此问题。通过 `-XX:+PrintCodeCache` 或 JConsole/VisualVM 可以监控代码缓存使用情况。

---

## 第 6 章 去优化（Deoptimization）——投机优化的代价

### 6.1 什么是去优化

JIT 的投机优化（如单态内联）建立在一些**可能被推翻的假设**上。当这些假设在运行时被违反时，JVM 必须**撤销之前的优化，回退到解释执行**——这就是**去优化（Deoptimization）**。

**常见触发去优化的场景**：

**类型分布变化**：JIT 假设某接口调用总是 `ArrayList` 的实现并做了内联，此后代码中加载了一个新类实现了同一接口并成为调用目标——投机假设失败，需要去优化。

**类加载**：JIT 优化了某个 `final` 类（假设它不会有子类），但运行时加载了一个突破封装的子类（使用字节码工具生成的）——需要去优化。

**代码变化（热部署）**：Arthas、Java Instrumentation API 替换了某个类的字节码，已编译的机器码失效，需要回退到解释执行，然后重新 Profile 和编译。

### 6.2 去优化的代价

去优化本身会导致：
- **当前帧的执行从机器码切换为解释器**，有一次"栈帧转换"开销
- **该方法需要重新被 Profile，重新被 JIT 编译**，有一段时间的性能退化
- **频繁去优化**（如接口实现类不断增加）会导致 JIT 反复编译，CPU 资源浪费

去优化信息可以通过 `-XX:+PrintCompilation` 日志中的 `made not entrant` / `made zombie` 标记识别：
- `made not entrant`：该方法的编译版本不再接受新的调用（回退到解释），但已在执行中的调用继续完成
- `made zombie`：该方法的编译版本没有任何活跃调用，代码缓存空间可以被回收

---

## 第 7 章 AOT 编译与 GraalVM Native Image

### 7.1 JIT 的启动代价

JIT 的模型对长期运行的服务端应用效果极好，但对于**短生命周期的场景**（CLI 工具、FaaS/Serverless 函数、微服务快速启动）有明显缺陷：

- **启动慢**：JVM 初始化 + 类加载 + JIT 预热，启动时间通常数百毫秒到数秒
- **内存占用大**：JVM 本身的元数据、JIT 编译器、代码缓存，有几十到几百 MB 的固定开销

在 Serverless 场景中，函数可能每隔几秒就冷启动一次，JVM 的启动开销会直接影响延迟和成本。

### 7.2 GraalVM Native Image——极致的 AOT 编译

**GraalVM Native Image** 将整个 Java 应用（含 JVM 核心库）在**构建时**静态编译为单一的本地可执行文件：

```bash
# 将 HelloWorld.jar 编译为本地可执行文件
native-image -jar hello-world.jar hello-world-native

# 生成的 hello-world-native 是一个本地二进制，不需要 JVM
./hello-world-native  # 启动时间：几毫秒！内存：几 MB！
```

**Native Image 的极致性能**：
- **启动时间**：毫秒级（相比 JVM 应用的数秒）
- **内存占用**：比 JVM 应用低 5~10 倍
- **镜像大小**：单一自包含的二进制文件

**Native Image 的代价与限制**：
- **不能使用 JIT**（已经是 AOT 编译，没有 JVM 参与）：没有运行时的 Profile 数据，无法做投机优化，峰值吞吐量**通常低于 JIT 的 JVM**
- **反射限制**：AOT 编译时需要知道所有被反射访问的类（通过配置文件声明），大量依赖运行时反射的框架（如 Spring）需要显式配置
- **无动态类加载**：不能在运行时加载新类，OSGi、热部署、动态代理（未提前配置的）不支持
- **构建时间长**：Native Image 构建通常需要几分钟

**适用场景**：Quarkus、Micronaut 等云原生框架，CLI 工具，Serverless 函数——这些场景启动速度比峰值吞吐量更重要。

### 7.3 JDK 21 引入的 Project Leyden——缓存 JIT 结果

Oracle 的 **Project Leyden** 探索一个介于 JIT 和 AOT 之间的中间路线：**缓存 JIT 编译的结果**（编译后的机器码）到磁盘，下次启动时直接加载，跳过 JIT 预热阶段。

JDK 21 引入了 **CDS（Class Data Sharing）的增强版 AppCDS + JEP 483（Ahead-of-Time Class Loading & Linking，JDK 23 preview）**，部分实现了这个思路——缩短启动时间，同时保留运行时 JIT 优化能力。

这是介于 JVM 灵活性和 Native Image 启动速度之间的折中方案，代表了 Java 平台的重要演进方向。

---

## 第 8 章 总结

JIT 编译是 Java 性能的最大秘密，也是 JVM 与其他语言运行时最大的技术差异点：

**分层编译**：解释器（Level 0）→ C1 带 Profile（Level 3）→ C2 深度优化（Level 4），兼顾快速启动和峰值性能。

**方法内联**：消除方法调用开销，更重要的是为跨方法边界的全局优化（常量传播、死代码消除等）创造条件，是"一切优化的基础"。

**逃逸分析三剑客**：
- **栈上分配/标量替换**：不逃逸的对象无需堆分配，GC 压力大幅降低
- **锁消除**：不存在竞争的 synchronized 锁被完全删除

**去优化**：投机优化的必要代价。假设失败时回退到解释执行，重新编译，是 JVM 正确性的最后保障。

**代码缓存**：JIT 编译结果的存储空间，耗尽会导致 JIT 被禁用，需要监控。

**AOT（GraalVM Native Image）**：牺牲峰值吞吐量换取极致的启动速度和低内存，适合 Serverless 和 CLI 场景，代价是失去 JIT 的运行时优化能力和反射/动态加载限制。

下一篇 [[JVM实战/13 JVM 内存问题实战——OOM、内存泄漏与堆外内存]] 将进入实战领域，系统讲解如何诊断和解决 JVM 内存问题——从各类 OOM 错误的根因，到堆外内存泄漏，到使用 MAT、jmap、jstack 等工具的实际操作流程。

---

## 参考文献

1. 周志明, 《深入理解 Java 虚拟机（第三版）》, 第 11 章：晚期（运行期）优化
2. Cliff Click & Michael Paleczny, "A Simple Graph-Based Intermediate Representation", ACM IR 1995（C2 编译器的核心数据结构）
3. Aleksandr Patschke, "JIT Compilation, Tiered Compilation, and Escape Analysis", Oracle Technology Network
4. Aleksey Shipilev, "JVM Anatomy Quarks: Inlining", shipilev.net
5. Aleksey Shipilev, "JVM Anatomy Quarks: Escaping Differences", shipilev.net
6. Thomas Wuerthinger et al., "GraalVM: One VM to Rule Them All", Onward! 2013
7. JEP 295: Ahead-of-Time Compilation (JDK 9, experimental)
8. GraalVM Native Image Documentation, graalvm.org

---

> [!note] 思考题
> 1. HotSpot 的 JIT 编译器有两个：C1（Client Compiler，优化快但程度浅）和 C2（Server Compiler，优化慢但程度深）。分层编译（Tiered Compilation）让代码先由 C1 编译，热度足够高后再由 C2 重新编译。如果一个方法被 C2 编译后，其调用的另一个方法发生了去优化（Deoptimization），C2 编译的代码是否需要全部废弃？
> 2. 逃逸分析判断对象是否'逃逸'出方法或线程。如果对象未逃逸，JIT 可以进行标量替换（将对象拆解为基本类型变量）和锁消除。但逃逸分析本身有计算成本——对于只执行一两次的方法，花费时间做逃逸分析是否值得？JIT 是如何决定一个方法'值得'做逃逸分析的？
> 3. JIT 编译后的机器码存储在 CodeCache 中。如果 CodeCache 满了（默认 240MB），JIT 编译器会停止工作，所有方法回退到解释执行——性能会断崖式下降。你如何监控 CodeCache 的使用量？在什么类型的应用中 CodeCache 最容易被耗尽（提示：考虑动态生成类的场景）？
