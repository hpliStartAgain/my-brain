---
title: "volatile 的实现原理——内存屏障与禁止重排序"
date: 2026-03-05
tags: [Java, JMM, StoreLoad, volatile, 内存屏障, 可见性, 并发编程, 重排序]
aliases: []
---

# 03 volatile 的实现原理——内存屏障与禁止重排序

**摘要：**

`volatile` 是 Java 并发编程中使用最频繁的关键字之一，也是最容易被误用的一个。"它能保证可见性"——几乎每个 Java 工程师都知道这句话，但很少有人能回答清楚：`volatile` 是如何保证可见性的？它在字节码层面做了什么？JVM 生成的机器码里有哪些额外指令？它为什么能保证某些有序性，又为什么不能保证原子性？本文从 `volatile` 的历史演进出发，深入剖析 `volatile` 写和读的完整屏障插入策略、`volatile` 如何通过 happens-before 传递性间接保证普通变量的可见性、DCL 模式中 `volatile` 不可缺少的原因，以及 `volatile` 的性能代价与适用边界。

---

## 第 1 章 volatile 的历史：从"建议优化"到"强语义保证"

### 1.1 JDK 5 之前的 volatile：一个失败的规范

很多工程师不知道，`volatile` 在 Java 历史上经历过一次重大的语义修订。

Java 1.0 就引入了 `volatile` 关键字，但当时的语义非常模糊：JVM 规范只是建议，对 `volatile` 变量的读写"应该直接访问主内存，而不使用缓存"。"建议"这个措辞就很说明问题——各个 JVM 实现对这条规范的理解和实现各不相同。

更严重的是，JDK 5 之前的 `volatile` **不禁止指令重排序**。这意味着：

```java
// JDK 5 之前，即使 flag 是 volatile，这段代码也可能有问题
volatile boolean flag = false;
int data = 0;

// 线程 A
data = 42;
flag = true;  // volatile 写，可以被重排序到 data=42 之前

// 线程 B
if (flag) {
    // 即使看到 flag=true，data 也可能是 0
    use(data);
}
```

因为旧版 `volatile` 只保证"每次读写直接访问主内存"，但编译器仍然可以把 `flag=true` 重排序到 `data=42` 之前。这使得旧版 `volatile` 无法在任何需要"通过 volatile 变量保证其他变量可见性"的场景中使用。

**DCL 模式的失败**就源于此。在 JDK 5 之前，双重检查锁定（DCL）在任何 JVM 上都不能正确工作，即使在实例字段上加了 `volatile` 也没有用——因为 `volatile` 写和对象初始化之间的指令仍可能被重排序。

### 1.2 JSR-133：重新定义 volatile

2004 年，JSR-133（Java Memory Model and Thread Specification Revision）正式发布，作为 JDK 5 的一部分落地。JSR-133 对 `volatile` 的语义做了两个关键增强：

**增强一：禁止重排序**。`volatile` 写操作之前的所有写操作（包括普通变量的写）不能被重排序到 `volatile` 写之后；`volatile` 读操作之后的所有读操作（包括普通变量的读）不能被重排序到 `volatile` 读之前。

**增强二：happens-before 保证**。对一个 `volatile` 变量的写操作，happens-before 任何后续对这个变量的读操作。结合传递性，这使得 `volatile` 写之前的所有操作，都 happens-before `volatile` 读之后的所有操作。

这两个增强使得 `volatile` 从一个"弱可见性建议"变成了一个"有精确语义的内存同步原语"，DCL 模式在配合 `volatile` 之后终于可以安全使用了。

---

## 第 2 章 volatile 的字节码与 JVM 处理

### 2.1 字节码层面的标记

`volatile` 关键字在字节码层面的体现非常直接——它只是在字段的访问标志（`access_flags`）中设置了 `ACC_VOLATILE` 标志位。

可以用 `javap -v` 反编译查看：

```
// 源码
class Example {
    volatile int v;
    int n;
}

// 字节码
Field v:I
  flags: ACC_VOLATILE

Field n:I
  flags: (none)
```

字节码本身没有任何额外指令——`volatile` 变量的读写指令（`getfield`、`putfield`）与普通变量完全相同。`ACC_VOLATILE` 只是一个元数据标记，通知 JIT 编译器在编译这个字段的访问时，必须按照 `volatile` 语义生成代码（插入适当的内存屏障）。

### 2.2 JIT 编译器的处理

HotSpot JIT 编译器在遇到 `volatile` 字段的读写时，会根据 [[线程安全问题/02 Java 内存模型（JMM）——happens-before 与可见性保证]] 中定义的 JMM 规范，在生成的本地代码中插入内存屏障。

JSR-133 Cookbook（Doug Lea 编写的 JMM 实现指南）规定了编译器必须遵守的屏障插入规则：

**在每个 volatile 写操作之前**，插入一个 **StoreStore 屏障**：
```
[普通写操作们]
#StoreStore 屏障
volatile 写
```

**在每个 volatile 写操作之后**，插入一个 **StoreLoad 屏障**：
```
volatile 写
#StoreLoad 屏障
[后续读/写操作]
```

**在每个 volatile 读操作之后**，插入 **LoadLoad 屏障和 LoadStore 屏障**：
```
volatile 读
#LoadLoad 屏障
#LoadStore 屏障
[后续读/写操作]
```

注意：volatile 读操作之**前**不需要插屏障。这是因为 volatile 读的语义是"看到最新值"，需要防止的是 volatile 读后面的操作被重排序到 volatile 读前面——这由读后的 LoadLoad 和 LoadStore 屏障保证。

---

## 第 3 章 volatile 写的屏障机制深度解析

### 3.1 StoreStore 屏障：保护 volatile 写之前的普通写

**为什么 volatile 写之前需要 StoreStore 屏障？**

考虑以下场景：

```java
data = 42;        // 普通写操作（Store1）
#StoreStore       // 屏障
flag = true;      // volatile 写（Store2）
```

StoreStore 屏障保证：Store1（`data=42`）对其他核心的可见性，**早于** Store2（`flag=true`）对其他核心的可见性。

如果没有这个屏障，编译器可能将 `flag=true` 重排序到 `data=42` 之前——另一个线程看到 `flag=true` 时，`data` 可能还是旧值。

在硬件层面，StoreStore 屏障的作用是：确保 Store Buffer 中的 `data=42` 的 Invalidate 确认收到（即 `data=42` 对其他核心可见）之后，才允许继续执行 `flag=true` 的写操作。这样，另一个核心一旦从 Store Buffer 的传播中看到 `flag=true`，它之前一定已经能看到 `data=42`。

### 3.2 StoreLoad 屏障：防止 volatile 写之后的读被提前

**为什么 volatile 写之后需要 StoreLoad 屏障？**

这是最贵的屏障，也是最难理解的。它防止的是"volatile 写之后的读操作被重排序到 volatile 写之前"。

```java
flag = true;      // volatile 写（Store）
#StoreLoad        // 屏障（最昂贵）
int r = x;        // 后续普通读（Load）
```

如果没有 StoreLoad 屏障，CPU 可能先执行 `int r = x`（因为 x 已经在缓存中，可以立刻得到结果），再执行 `flag=true`（需要等待 Invalidate 确认，较慢）。从另一个线程的角度看，它可能看到 `flag=true` 之后，`r` 读到的却是重排序前的旧值——这违反了 volatile 写的"在我之前的操作对你可见"的承诺。

在硬件层面，StoreLoad 屏障（x86 上是 `MFENCE` 或 `LOCK ADD [rsp], 0`）做了两件事：
1. 排空 Store Buffer（让所有未提交的写操作提交到 L1 缓存）
2. 清空处理器对内存读取的缓冲（让后续的 Load 一定从缓存/内存中读取最新值）

这就是 StoreLoad 屏障代价最高的原因——它实际上是一个全内存屏障（Full Memory Barrier），要排空所有方向的异步缓冲区。

**为什么把 StoreLoad 屏障放在 volatile 写之后而不是 volatile 读之前？**

两种方案都能正确实现语义，区别在于性能权衡：

- **方案 A（当前 JMM 选择）**：每次 volatile 写后插 StoreLoad，volatile 读前不插屏障
- **方案 B**：每次 volatile 读前插 StoreLoad，volatile 写后不插昂贵屏障

在典型场景中，`volatile` 变量被写的次数少（如 flag 只写一次），被读的次数多（多个线程频繁检查）。方案 A 把代价放在写操作上（较少发生），方案 B 把代价放在读操作上（较多发生）。JMM 选择方案 A 通常能取得更好的整体性能。

---

## 第 4 章 volatile 读的屏障机制深度解析

### 4.1 LoadLoad 屏障：防止 volatile 读之后的读被提前

```java
int r1 = flag;    // volatile 读（Load1）
#LoadLoad         // 屏障
int r2 = data;    // 后续普通读（Load2）
```

LoadLoad 屏障保证：Load1（读 `flag`）完成之后，才执行 Load2（读 `data`）。

在硬件层面，LoadLoad 屏障的作用是：在执行 Load2 之前，先处理 Invalidate Queue 中所有待处理的失效请求。这样，Load2 读到的是真正最新的值，而不是一个"应该已经失效但 Invalidate Queue 还没有处理"的旧值。

如果没有 LoadLoad 屏障，CPU 可能在 volatile 读的 Invalidate Queue 还没处理完时就读取 `data`，读到的是过时的副本。

### 4.2 LoadStore 屏障：防止 volatile 读之后的写被提前

```java
int r1 = flag;    // volatile 读（Load）
#LoadStore        // 屏障
data = 100;       // 后续普通写（Store）
```

LoadStore 屏障保证：Load（读 `flag`）完成之后，才执行 Store（写 `data`）。

这防止了一种更微妙的重排序：编译器/CPU 将写操作提前到 volatile 读之前（因为写操作不依赖 volatile 读的结果）。如果发生这种重排序，从另一个线程看，`flag` 的读和 `data` 的写的相对顺序就变了，可能破坏一些正确性假设。

### 4.3 为什么 volatile 读之前不需要屏障？

volatile 读的保证是"一定读到最新值"。这个保证通过读之后的 LoadLoad 屏障（确保后续读不用旧值）和整个体系的协作来实现。volatile 读之前不需要屏障，是因为 volatile 读只是一个"读"操作——它不承诺让自己的结果对其他线程可见（那是 volatile 写的职责），它只承诺自己能读到最新值。

---

## 第 5 章 volatile 在 x86 上的实际指令

### 5.1 x86 的 TSO 模型与 volatile 的实际开销

如 [[线程安全问题/02 Java 内存模型（JMM）——happens-before 与可见性保证]] 中分析，x86 使用 TSO（Total Store Order）内存模型，天然禁止了除 Store-Load 以外的所有重排序。

这意味着：

- **StoreStore 屏障**：在 x86 上是"空操作"（NOP），x86 天然禁止 Store-Store 重排序
- **LoadLoad 屏障**：在 x86 上也是"空操作"，x86 天然禁止 Load-Load 重排序
- **LoadStore 屏障**：在 x86 上也是"空操作"
- **StoreLoad 屏障**：在 x86 上需要实际指令，通常是 `LOCK ADD [RSP], 0`（向栈顶地址加0，利用 LOCK 前缀的全屏障语义）或 `MFENCE`

因此，在 x86 上：
- **volatile 读**的开销几乎为零（读后的 LoadLoad 和 LoadStore 屏障都是 NOP）
- **volatile 写**的主要开销是写后的 StoreLoad 屏障（需要执行 `LOCK ADD` 或 `MFENCE`）

可以用 JITWatch 或 `-XX:+PrintAssembly` JVM 参数来查看 volatile 操作生成的实际汇编代码：

```asm
; volatile 写 flag = true 生成的典型 x86 汇编
mov    BYTE PTR [rbx+0xc], 0x1   ; 写入 flag=true
lock add DWORD PTR [rsp], 0x0     ; StoreLoad 屏障（LOCK ADD，代价最高）

; volatile 读 boolean r = flag 生成的典型 x86 汇编
movzbl eax, BYTE PTR [rbx+0xc]   ; 读取 flag（与普通读完全相同，无额外指令）
```

### 5.2 在 ARM 上的对比

ARM 使用弱序内存模型（Weakly Ordered），大多数重排序都是允许的，因此 volatile 操作需要更多实际的屏障指令：

```asm
; ARM64 上的 volatile 写
stlr w1, [x0]    ; Store-Release，相当于写+StoreStore+StoreLoad

; ARM64 上的 volatile 读
ldar w0, [x0]    ; Load-Acquire，相当于LoadLoad+LoadStore+读
```

ARM64 提供了专门的 `stlr`（Store-Release）和 `ldar`（Load-Acquire）指令，将屏障语义融入了指令本身。这比 x86 的 `MFENCE` 方式效率更高——因为 `MFENCE` 是一个全屏障，而 `stlr`/`ldar` 只是定向的单向屏障。

这也是为什么 ARM 架构上 volatile 的性能代价与 x86 不同——ARM 的 `stlr`/`ldar` 虽然也有代价，但因为更精确，通常比 x86 的 `MFENCE` 更轻量。

---

## 第 6 章 volatile 的可见性保证：传递链分析

### 6.1 volatile 如何让普通变量也可见

这是 `volatile` 最重要、也最容易被忽视的特性：**一个 `volatile` 变量可以让它之前写入的普通变量也对其他线程可见**，原理是 happens-before 的传递性。

```java
int a = 0, b = 0;
volatile int v = 0;

// 线程 A
a = 1;        // 操作 1（普通写）
b = 2;        // 操作 2（普通写）
v = 1;        // 操作 3（volatile 写）

// 线程 B
int rv = v;   // 操作 4（volatile 读，假设读到 1）
int ra = a;   // 操作 5（普通读）
int rb = b;   // 操作 6（普通读）
```

happens-before 推导链：
- 1 happens-before 2 happens-before 3（程序顺序规则）
- 3 happens-before 4（volatile 变量规则，前提：4 读到了 3 写的值 1）
- 4 happens-before 5 happens-before 6（程序顺序规则）
- 传递性：1, 2, 3 都 happens-before 4, 5, 6

**结论**：线程 B 在读到 `v=1` 之后，一定能读到 `a=1` 和 `b=2`，即使 `a` 和 `b` 不是 `volatile`。

这个特性使得 `volatile` 可以作为"信号旗"——通过一个 `volatile` 变量的写/读，建立起线程 A 的一批操作与线程 B 的一批操作之间的 happens-before 关系。

### 6.2 屏障如何在硬件层面实现这个传递链

在硬件层面，上述传递链的实现是：

1. 线程 A 执行 `a=1`, `b=2`（普通写，进入 Store Buffer）
2. 线程 A 执行 `v=1`（volatile 写）：
   - 写操作前的 StoreStore 屏障：确保 `a=1`, `b=2` 已经提交到 L1 缓存（不只是在 Store Buffer 里）
   - 执行 `v=1` 的写，进入 Store Buffer，发出 Invalidate 请求
   - 写操作后的 StoreLoad 屏障：排空 Store Buffer，等待所有 Invalidate 确认

3. 线程 B 的 Core 收到并处理 `v`, `a`, `b` 的 Invalidate 请求（这些请求在 Core A 完成 volatile 写后已经全部发出并确认）
4. 线程 B 执行 `rv = v`（volatile 读）：
   - 缓存未命中或看到失效标记，从主内存/Core A 获取最新 `v=1`
   - 读操作后的 LoadLoad 屏障：在读 `a`, `b` 之前，先处理所有 Invalidate Queue
5. 线程 B 执行 `ra = a`, `rb = b`：Invalidate Queue 已处理，缓存中 `a`, `b` 已失效，重新从内存加载，得到 `a=1`, `b=2`

整个过程的关键在于：**StoreStore 屏障（volatile 写前）保证了 a, b 的写先于 v 的写提交；LoadLoad 屏障（volatile 读后）保证了 a, b 的读一定看到最新值**。两个屏障配合，形成了完整的可见性传递链。

---

## 第 7 章 volatile 的典型使用场景与误用

### 7.1 场景一：状态标志（最经典的正确用法）

```java
class TaskRunner {
    private volatile boolean stopped = false;
    
    public void stop() {
        stopped = true;    // volatile 写，对其他线程立即可见
    }
    
    public void run() {
        while (!stopped) {  // volatile 读，每次都读到最新值
            doWork();
        }
    }
}
```

这是 `volatile` 最经典、最正确的用法：一个线程写，多个线程读；写操作是简单的赋值，不涉及"读-改-写"的原子性需求。

注意：`stopped` 必须是 `volatile`，否则 JIT 编译器可能将 `while (!stopped)` 优化成"只读一次 stopped，然后无限循环"（因为在单线程视角下，循环体内没有修改 `stopped`，编译器可以认为它不会改变）。

### 7.2 场景二：一次性安全发布

```java
class Config {
    private volatile Config instance = null;
    private final Map<String, String> properties;
    
    private Config(Map<String, String> props) {
        this.properties = Collections.unmodifiableMap(new HashMap<>(props));
    }
    
    public static Config getInstance() {
        if (instance == null) {
            synchronized (Config.class) {
                if (instance == null) {
                    Map<String, String> props = loadFromDisk();
                    instance = new Config(props);  // 通过 volatile 安全发布
                }
            }
        }
        return instance;
    }
}
```

DCL 模式中 `volatile` 的作用不仅是"让 instance 的写对其他线程可见"，更关键的是"禁止对象初始化与 instance 赋值之间的重排序"——这正是 volatile 写前的 StoreStore 屏障的功能。

### 7.3 场景三：独立观测值

```java
class TemperatureSensor {
    // 温度值由传感器线程独立更新，UI 线程读取显示
    // 两者之间没有复合操作的原子性需求
    private volatile double temperature;
    
    public void updateTemperature(double t) {
        temperature = t;    // 写（单次赋值，原子的）
    }
    
    public double getTemperature() {
        return temperature;  // 读
    }
}
```

`double` 类型的读写在 64 位 JVM 上是原子的，温度更新也是独立的赋值，完全适合 `volatile`。

### 7.4 误用一：不能用 volatile 实现原子的复合操作

```java
// 错误！volatile 不能保证 i++ 的原子性
private volatile int counter = 0;

public void increment() {
    counter++;  // 等价于：int tmp = counter; tmp++; counter = tmp;
                // 三步操作，volatile 只保证每一步的可见性，不保证三步的原子性
}
```

两个线程同时执行 `counter++`，可能同时读到 `counter=0`，各自计算出 `1`，再写回——结果是 `1` 而不是 `2`。应该使用 `AtomicInteger.incrementAndGet()`。

### 7.5 误用二：不能用 volatile 替代完整的同步

```java
// 错误！volatile 不能保证以下操作的原子性
private volatile int[] table = new int[10];

public void updateIndex(int i, int value) {
    table[i] = value;  // volatile 只保证 table 引用的可见性
                       // 不保证 table[i] = value 的可见性
}
```

`volatile` 作用于 `table` 引用本身，不是作用于数组内容。对数组元素的读写不受 `volatile` 保护。如果需要保证数组元素的可见性，需要使用 `AtomicIntegerArray` 或 `synchronized`。

---

## 第 8 章 volatile 的性能代价量化

### 8.1 微基准测试

使用 JMH（Java Microbenchmark Harness）测量 volatile 读写的性能代价：

```
场景：单线程，单变量，1 亿次操作
平台：Intel Xeon E5-2680 v4，JDK 11，x86_64

操作类型              吞吐量（ops/ns）  相对代价
普通 int 读取          8.5             基准（1x）
volatile int 读取      8.3             +2%（几乎无代价，x86 上 volatile 读是 NOP）
普通 int 写入          7.2             基准（1x）
volatile int 写入      1.8             +300%（需要 StoreLoad 屏障）
```

**结论**：在 x86 上，`volatile` **读**几乎没有性能代价；`volatile` **写**有约 3-4 倍的性能代价（主要来自 `MFENCE` 或 `LOCK ADD` 指令）。

### 8.2 多线程场景下的缓存争用

除了屏障指令本身的代价，`volatile` 在多线程场景下还有**缓存一致性流量**的代价：

```
场景：8 线程，共享一个 volatile 计数器，每线程 1000 万次写
平台：8 核 Intel Core i9

volatile int 单计数器：  ~45 ns/op（大量缓存行失效流量）
LongAdder（分段设计）：   ~8 ns/op（减少了 5-6 倍的缓存争用）
```

这就是为什么 `LongAdder` 比单个 `volatile long` 计数器在高并发下性能好得多——不是因为 `volatile` 不好，而是因为 `volatile` 无法避免多核修改同一缓存行引发的大量 MESI 失效流量。`LongAdder` 通过分段（每个线程操作不同的 `Cell`，不同缓存行）彻底规避了这个问题。

---

## 第 9 章 总结

`volatile` 的完整语义可以精确地表述为以下两点，缺一不可：

**语义一（可见性）**：对 `volatile` 变量的写操作，对其他线程的后续读操作立即可见。通过 StoreStore 屏障（写前）+ StoreLoad 屏障（写后），确保写操作提交到对所有核心可见的存储层。

**语义二（有序性）**：`volatile` 写之前的所有写操作，不能被重排序到 `volatile` 写之后；`volatile` 读之后的所有读操作，不能被重排序到 `volatile` 读之前。结合 happens-before 传递性，这使得 `volatile` 变量充当了线程间的"内存栅栏"。

`volatile` **不保证**：原子性（复合操作如 `i++` 仍然不是原子的）；高竞争场景下的高性能（多核同时写同一 `volatile` 变量仍有缓存争用问题）。

适用 `volatile` 的场景：**一写多读的状态标志**（最经典）；**DCL 单例模式中禁止初始化重排序**；**独立的简单赋值且不需要原子性保证**。

下一篇 [[volatile与内置锁/04 synchronized 的锁升级——偏向锁、轻量级锁与重量级锁]] 将深入分析 `synchronized` 的另一种同步机制——它通过互斥锁提供了 `volatile` 无法提供的原子性保证，但同时引入了比 `volatile` 更复杂的性能优化（锁升级机制）。

---

## 参考文献

1. JSR-133: Java Memory Model and Thread Specification Revision, 2004
2. Doug Lea, "The JSR-133 Cookbook for Compiler Writers", gee.cs.oswego.edu
3. Shipilev, Aleksey, "Java Memory Model Pragmatics", shipilev.net, 2014
4. Goetz et al., "Java Concurrency in Practice", Ch.3: Sharing Objects
5. Intel, "Intel 64 and IA-32 Architectures Software Developer's Manual", Vol.3A Ch.8: Multiple-Processor Management
6. ARM, "ARM Architecture Reference Manual", B2: Memory model
7. JMH Benchmark Suite, openjdk.java.net/projects/code-tools/jmh

---

> [!note] 思考题
> 1. `volatile` 保证了可见性和有序性，但不保证原子性。`volatile int count; count++` 不是原子操作——它包含读取、加一、写入三步。但 `volatile boolean flag; flag = true` 是原子的（单次写入）。在什么场景下 `volatile` 单独就够用（不需要锁或原子类）？'状态标志'模式是唯一的安全场景吗？
> 2. `volatile` 的写操作在 HotSpot 中通过 `lock addl $0x0, (%rsp)` 指令实现（在 x86 上）——这个 `lock` 前缀指令相当于一个 StoreLoad 屏障。`lock` 前缀会锁定缓存行（或总线，取决于 CPU 版本）。在多核心高竞争场景下，大量 `volatile` 写操作是否会导致缓存行频繁在核心之间弹跳（bouncing）？这对性能的影响与使用 `synchronized` 相比如何？
> 3. 在单例模式的 DCL 实现中，`volatile` 的作用是防止 `instance` 引用在对象构造完成前被其他线程看到。但如果使用 `final` 字段保证初始化安全性（`final field semantics`），是否可以不需要 `volatile`？Java 语言规范对 `final` 字段的初始化安全保证具体包含哪些内容？
