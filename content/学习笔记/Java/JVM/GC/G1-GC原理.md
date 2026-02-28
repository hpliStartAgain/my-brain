## 一、G1 垃圾回收器概述

### 1.1 设计目标

G1（Garbage First）是 JDK 7 引入、JDK 9 成为默认的垃圾回收器，其设计目标包括：

- **可预测的暂停时间**：通过 `-XX:MaxGCPauseMillis` 设置目标暂停时间
- **高吞吐量**：在保证暂停时间的前提下最大化吞吐量
- **支持大堆内存**：设计目标是支持数十GB到数百GB的堆
- **避免 Full GC**：通过增量式回收尽量避免全堆扫描

### 1.2 基本架构

G1 将堆内存划分为多个大小相等的 **Region**（区域），每个 Region 的大小在 1MB 到 32MB 之间，由 JVM 根据堆大小自动确定，也可通过 `-XX:G1HeapRegionSize` 手动指定。

```
┌───────────────────────────────────────────────────────────────┐
│                         G1 堆内存布局                           │
├───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┬───┤
│ E │ E │ S │ O │ O │ O │ H │ H │ E │ O │ O │ S │ E │ O │ F │ F │
├───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┴───┤
│ E = Eden   S = Survivor   O = Old   H = Humongous  F = Free   │
└───────────────────────────────────────────────────────────────┘
```

**对于本案例**：

- 堆大小：200GB
- Region 大小：32MB（通过日志确认）
- Region 总数：200GB / 32MB = **6400 个 Region**

---

## 二、G1 的 GC 类型

### 2.1 Young GC（年轻代垃圾回收）

**触发条件**：Eden 区域被填满时触发

**回收范围**：所有 Eden 和 Survivor Region

**过程**：

1. **STW（Stop The World）**：暂停所有应用线程
2. **根扫描（Root Scanning）**：扫描 GC Roots
3. **更新 RSet（Update RS）**：处理 Dirty Card Queue，更新 RSet
4. **扫描 RSet（Scan RS）**：扫描 RSet 找出老年代到年轻代的引用
5. **对象复制（Object Copy）**：将存活对象复制到 Survivor 或 Old 区域
6. **清理（Cleanup）**：回收空的 Region

**正常耗时**：几十毫秒到几百毫秒

### 2.2 Mixed GC（混合垃圾回收）

**触发条件**：并发标记周期完成后，G1 选择一些老年代 Region 与年轻代一起回收

**回收范围**：所有 Eden、Survivor Region + 部分 Old Region

**过程**：与 Young GC 类似，但额外回收部分老年代 Region

**关键参数**：

- `-XX:G1MixedGCCountTarget=8`：一次并发周期后 Mixed GC 的目标次数
- `-XX:G1HeapWastePercent=5`：允许的堆内存浪费百分比
- `-XX:G1MixedGCLiveThresholdPercent=85`：Region 中存活对象超过此比例则不回收

### 2.3 并发标记周期（Concurrent Marking Cycle）

**触发条件**：堆使用率达到 IHOP（Initiating Heap Occupancy Percent，默认 45%）

**阶段**：

|   |   |   |
|---|---|---|
|**阶段**|**STW**|**说明**|
|Initial Mark|是|标记 GC Roots 直接可达的对象，借用 Young GC 的 STW|
|Root Region Scan|否|扫描 Survivor 区域对 Old 区域的引用|
|Concurrent Mark|否|并发遍历整个堆，标记存活对象|
|Remark|是|处理 SATB（Snapshot-At-The-Beginning）队列中的引用变更|
|Cleanup|是/否|统计存活对象，识别可回收 Region，准备 Mixed GC|

---

## 三、Remembered Set（RSet）机制详解

### 3.1 为什么需要 RSet？

在分代垃圾回收中，回收年轻代时需要知道哪些老年代对象引用了年轻代对象。传统方法是扫描整个老年代，但这对于大堆来说开销巨大。

**RSet 的作用**：记录"谁引用了我"，使得 GC 时只需扫描 RSet 而非整个老年代。

```
┌─────────────────────────────────────────────────────────────────┐
│                     跨 Region 引用示例                            │
│                                                                 │
│   Region A (Old)              Region B (Young)                  │
│  ┌─────────────────┐        ┌─────────────────┐                 │
│  │                 │        │                 │                 │
│  │  ┌───────┐      │        │  ┌───────┐      │                 │
│  │  │ obj1  │──────┼────────┼─>│ obj2  │      │                 │
│  │  └───────┘      │        │  └───────┘      │                 │
│  │                 │        │                 │                 │
│  └─────────────────┘        └─────────────────┘                 │
│                                    │                            │
│                                    ▼                            │
│                             RSet of Region B:                   │
│                             { Region A: [card containing obj1] }│
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 RSet 的数据结构

RSet 是一个**多级数据结构**，采用"Points-Into"模式：

```
RSet 结构层次：
┌─────────────────────────────────────────────────────────────────┐
│  Level 1: Sparse PRT (Sparse Per-Region Table)                  │
│  - 使用 hash table 存储少量条目                                    │
│  - 每个条目是一个 card 地址                                        │
│  - 适用于引用较少的情况                                            │
├─────────────────────────────────────────────────────────────────┤
│  Level 2: Fine-Grained PRT                                      │
│  - 使用位图（bitmap）记录引用                                      │
│  - 每个 Region 对应一个位图                                       │
│  - 适用于中等数量的引用                                            │
├─────────────────────────────────────────────────────────────────┤
│  Level 3: Coarse-Grained Bitmap                                 │
│  - 一个全局位图，每个 bit 代表一个 Region                           │
│  - 表示"该 Region 中存在对本 Region 的引用"                         │
│  - 扫描时需要扫描整个源 Region                                     │
│  - 适用于引用非常多的情况（但扫描代价高）                             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Card Table（卡表）

Card Table 是 RSet 的基础设施：

- 将堆内存划分为 512 字节的 **Card**
- 每个 Card 用 1 字节表示其状态（clean/dirty）
- 当发生跨 Region 引用时，对应的 Card 被标记为 dirty

```
堆内存与 Card Table 的对应关系：

堆内存：
┌───────────────────────────────────────────────────────┐
│ 512B │ 512B │ 512B │ 512B │ 512B │ 512B │ 512B │ 512B │
│Card 0│Card 1│Card 2│Card 3│Card 4│Card 5│Card 6│Card 7│
└───────────────────────────────────────────────────────┘
         ↓       ↓                   ↓
Card Table：
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ 0  │ 1  │ 1  │ 0  │ 0  │ 1  │ 0  │ 0  │  (0=clean, 1=dirty)
└────┴────┴────┴────┴────┴────┴────┴────┘
```

### 3.4 写屏障（Write Barrier）与 Dirty Card Queue

当应用程序执行引用赋值操作时，G1 的**写屏障（Write Barrier）**会：

1. 检查是否是跨 Region 引用
2. 如果是，将对应的 Card 标记为 dirty
3. 将 dirty card 放入线程本地的 **Dirty Card Queue**
4. 当本地队列满时，转移到全局 **Dirty Card Queue**

**Refinement 线程**：后台线程持续从全局队列取出 dirty card，更新对应 Region 的 RSet

```
写屏障处理流程：

应用线程执行: objA.field = objB
                    │
                    ▼
            ┌───────────────┐
            │  写屏障触发     │
            └───────┬───────┘
                    │
        ┌───────────┴───────────┐
        │ 是否跨 Region 引用？    │
        └───────────┬───────────┘
                    │ 是
                    ▼
            ┌───────────────┐
            │ 标记 Card 为   │
            │ dirty         │
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────┐
            │ 放入本地 Dirty │
            │ Card Queue    │
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────┐
            │ Refinement    │
            │ 线程异步处理    │
            │ 更新 RSet      │
            └───────────────┘
```

### 3.5 Scan RS（RSet 扫描）过程

在 GC 的 STW 阶段，**Scan RS** 需要：

1. 遍历 Collection Set 中每个 Region 的 RSet
2. 对于每个 RSet 条目，找到引用源的 Card
3. 扫描该 Card 中的对象，找出指向 Collection Set 的引用
4. 将这些引用作为 GC Roots 的一部分

**关键问题**：如果 RSet 非常大，或者大量 Card 需要扫描，Scan RS 时间会急剧增加。

---

## 四、为什么 Scan RS 时间会爆炸？

### 4.1 RSet 膨胀的原因

|   |   |
|---|---|
|**因素**|**影响**|
|**堆越大**|Region 越多，跨 Region 引用越多|
|**对象图越复杂**|对象之间引用关系越多，RSet 越大|
|**长期存活对象多**|老年代对象多，跨代引用多|
|**大量小对象**|对象密度高，一个 Card 内可能有多个引用|

### 4.2 NameNode 的特殊性

NameNode 在内存中维护整个 HDFS 的命名空间：

```
NameNode 内存中的主要对象：
┌─────────────────────────────────────────────────────────────────┐
│  INode 对象（文件/目录元数据）                                      │
│  - 数量：数千万到数亿                                              │
│  - 每个 INode 包含多个引用（父目录、子节点、Block 信息等）             │
├─────────────────────────────────────────────────────────────────┤
│  Block 对象                                                      │
│  - 数量：数千万到数亿                                              │
│  - 每个 Block 包含副本位置引用                                     │
├─────────────────────────────────────────────────────────────────┤
│  DataNode 信息                                                   │
│  - 每个 DataNode 的 Block 列表                                    │
├─────────────────────────────────────────────────────────────────┤
│  复杂的引用关系                                                   │
│  - 目录树结构                                                    │
│  - Block 到 DataNode 的映射                                      │
│  - 租约信息                                                      │
└─────────────────────────────────────────────────────────────────┘
```

**结果**：

- 大量长期存活的对象 → 巨大的老年代
- 复杂的对象引用图 → 大量跨 Region 引用
- RSet 规模巨大 → Scan RS 时间长

### 4.3 JDK 8 G1 的已知问题

JDK 8 中 G1 的 RSet 处理存在性能问题：

1. **Refinement 线程效率问题**：在高负载下可能跟不上 dirty card 生成速度
2. **RSet 扫描是线性的**：扫描时间与 RSet 大小成正比
3. **粗粒度位图退化**：当跨 Region 引用过多时，RSet 退化为 Coarse-Grained，扫描开销剧增

**JDK 11+ 的改进**：

- 并行 RSet 扫描
- 更高效的 RSet 数据结构
- 更好的 Refinement 线程调度

---

## 五、与 SWAP 交互的致命影响

### 5.1 问题场景

当 RSet 或相关的老年代对象被 Linux 内核换出到 SWAP：

```
正常情况：
  Scan RS → 访问 RSet 数据结构 → 内存访问 → 纳秒级延迟

SWAP 介入：
  Scan RS → 访问 RSet 数据结构 → Page Fault → 磁盘 I/O → 毫秒级延迟
                                     ↑
                                 延迟放大 100万倍
```

### 5.2 为什么老年代对象会被换出？

1. **没有使用** `**-XX:+AlwaysPreTouch**`

- JVM 启动时只保留虚拟地址空间，不实际分配物理内存
- 物理页在首次访问时才分配
- 长期不访问的页会被内核视为"冷页"

3. **老年代对象的访问模式**

- NameNode 的某些元数据可能很少被访问
- Linux 内核的 LRU 算法会将这些"冷页"换出

5. **G1 的内存布局**

- RSet 等数据结构也是 Native Memory 或堆内存
- 如果 RSet 所在的页被换出，扫描时会触发大量 Page Fault

### 5.3 本案例的证据

从 GC 日志可以看到：

```
正常 Young GC:
  Scan RS = 4.4ms ~ 6.0ms

问题 Mixed GC:
  Scan RS = 13,343ms → 21,190ms → 24,041ms → 32,012ms → 41,111ms
```

**Scan RS 时间增长了 10000 倍！**

同时 SAR 数据显示：

```
01:30-01:40: pswpin = 292.58 pages/s, 磁盘读 = 1170 KB/s
```

这证实了：**GC 扫描触发了大量的 SWAP 读取（Page Fault）**。

---

## 六、关键 JVM 参数解读

### 6.1 本案例使用的参数

```
-XX:+UseG1GC                    # 使用 G1 GC
-Xms204800m -Xmx204800m         # 堆大小 200GB
-XX:MaxGCPauseMillis=500        # 目标暂停时间 500ms
-XX:+ParallelRefProcEnabled     # 并行处理引用
-XX:-ResizePLAB                 # 禁用 PLAB 自动调整（不推荐）
-XX:ParallelGCThreads=30        # GC 并行线程数
-XX:NewSize=20480m              # 固定年轻代大小 20GB（不推荐）
-XX:MaxNewSize=20480m
```

### 6.2 问题参数分析

|   |   |
|---|---|
|**参数**|**问题**|
|无 `-XX:+AlwaysPreTouch`|内存未预热，可能被 SWAP|
|`-XX:NewSize/-XX:MaxNewSize`|固定年轻代大小，G1 无法自适应调整|
|`-XX:-ResizePLAB`|可能导致内存分配效率问题|

### 6.3 推荐参数

```
# 基础参数
-XX:+UseG1GC
-Xms204800m -Xmx204800m
-XX:MaxGCPauseMillis=500
-XX:ParallelGCThreads=30

# 关键新增参数
-XX:+AlwaysPreTouch              # 启动时预热所有堆内存
-XX:InitiatingHeapOccupancyPercent=35  # 更早开始并发标记
-XX:G1HeapRegionSize=32m         # 明确指定 Region 大小
-XX:G1MixedGCCountTarget=16      # 分散 Mixed GC，每次处理更少 Region
-XX:G1HeapWastePercent=10        # 允许更多堆浪费，减少激进回收
-XX:G1ReservePercent=15          # 增加预留空间
-XX:ConcGCThreads=8              # 并发 GC 线程数

# 诊断参数
-XX:+PrintGCApplicationStoppedTime
-XX:+PrintAdaptiveSizePolicy
-XX:+G1SummarizeRSetStats
-XX:G1SummarizeRSetStatsPeriod=1
```

---

## 七、总结

### 7.1 G1 GC 在大堆场景的挑战

1. **RSet 规模与堆大小成正比**：200GB 堆 = 6400 个 Region = 潜在海量 RSet
2. **对象图复杂度影响巨大**：NameNode 的复杂引用关系加剧 RSet 膨胀
3. **JDK 8 的 G1 实现存在性能瓶颈**：RSet 处理效率不够高

### 7.2 SWAP 是致命的放大器

- G1 的 Scan RS 阶段需要访问大量内存
- 如果这些内存被换出到 SWAP，每次访问都会触发 Page Fault
- Page Fault 的延迟是内存访问的 **100 万倍**
- 这会将毫秒级的 GC 变成秒级甚至分钟级

### 7.3 最佳实践

1. **禁用或限制 SWAP**：`vm.swappiness=0` 或 `swapoff -a`
2. **使用** `**-XX:+AlwaysPreTouch**`：启动时预热内存
3. **升级到 JDK 11+**：G1 有重大性能改进
4. **考虑 ZGC/Shenandoah**：JDK 17+ 的低延迟 GC

---

## 参考资料

- [Oracle G1 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)
- [Getting Started with G1 GC](https://www.oracle.com/technical-resources/articles/java/g1gc.html)
- [Cloudera: GC Pauses in NameNode](https://community.cloudera.com/t5/Community-Articles/Garbage-Collection-Pauses-in-Namenode-and-Datanode/ta-p/376030)
- [JVM Anatomy Quark: GC Design and Pauses](https://shipilev.net/jvm/anatomy-quarks/3-gc-design-and-pauses/)