## 一、Linux 内存管理基础

### 1.1 虚拟内存与物理内存

Linux 使用**虚拟内存**机制，每个进程拥有独立的虚拟地址空间：

```
进程视角（虚拟地址空间）          物理内存 + Swap
┌─────────────────────┐         ┌─────────────────┐
│   栈 (Stack)        │         │  物理内存 (RAM)   │
├─────────────────────┤   ┌────>│  Page Frame 0   │
│       ↓             │   │     │  Page Frame 1   │
│                     │   │     │  Page Frame 2   │
│       ↑             │   │     │      ...        │
├─────────────────────┤   │     │  Page Frame N   │
│   堆 (Heap)         │───┘     └─────────────────┘
│   (JVM 堆在这里)     │               ↕
├─────────────────────┤         ┌─────────────────┐
│   数据段             │         │   Swap 分区      │
├─────────────────────┤   ┌────>│  (磁盘)          │
│   代码段             │───┘     └─────────────────┘
└─────────────────────┘
         │
         ▼
    页表 (Page Table) 负责虚拟地址到物理地址的映射
```

### 1.2 页（Page）与页帧（Page Frame）

- **页（Page）**：虚拟内存的基本单位，通常为 4KB
- **页帧（Page Frame）**：物理内存的基本单位，与页大小相同
- **页表（Page Table）**：记录虚拟页到物理页帧的映射关系

### 1.3 内存页的类型

Linux 内核将内存页分为两大类：

|   |   |   |   |
|---|---|---|---|
|**类型**|**说明**|**示例**|**回收方式**|
|**File-backed Pages**|有文件作为后备存储|程序代码、共享库、mmap 文件|直接丢弃（干净页）或写回文件（脏页）|
|**Anonymous Pages**|无文件后备，只存在于内存|malloc 分配、栈、堆|**只能通过 Swap 回收**|

**关键点**：JVM 堆属于 **Anonymous Pages**，只能通过 Swap 才能被换出。

---

## 二、Swap 机制详解

### 2.1 Swap 的本质

Swap 是 Linux 为 Anonymous Pages 提供的**后备存储**：

```
内存回收的两种路径：

File-backed Page:
  内存页 → 检查是否为脏页 → 是：写回文件 → 释放物理内存
                         → 否：直接释放

Anonymous Page:
  内存页 → 写入 Swap 分区 → 释放物理内存
              ↓
         磁盘 I/O（慢！）
```

### 2.2 Swap 的作用

**常见误解**：Swap 是"紧急内存"，内存不够时才用。

**正确理解**：Swap 是实现**回收平等性（Equality of Reclamation）**的机制：

1. **回收冷页面**：将长期未使用的 Anonymous Pages 换出，腾出内存给更活跃的数据
2. **提高内存效率**：让 Page Cache 有更多空间缓存磁盘数据
3. **处理内存压力**：在内存紧张时提供额外的缓冲

### 2.3 什么情况下会发生 Swap？

内核决定 Swap 的主要因素：

```
┌─────────────────────────────────────────────────────────────────┐
│                    内核页面回收决策流程                            │
├─────────────────────────────────────────────────────────────────┤
│  1. 内存压力触发                                                  │
│     - 分配请求无法满足                                            │
│     - 可用内存低于阈值                                            │
│     - kswapd 后台扫描                                            │
│                    ↓                                            │
│  2. 扫描 LRU 列表                                                │
│     - Active/Inactive 列表                                      │
│     - File 列表 vs Anonymous 列表                                │
│                    ↓                                            │
│  3. 根据 swappiness 决定回收比例                                  │
│     - swappiness 越高，越倾向于回收 Anonymous Pages               │
│     - swappiness = 0 时，尽量避免 Swap（但不完全禁止）              │
│                    ↓                                           │
│  4. 选择"最冷"的页面                                             │
│     - 基于 LRU（Least Recently Used）算法                        │
│     - 最久未访问的页面优先被回收                                   │
└────────────────────────────────────────────────────────────────┘
```

---

## 三、LRU（Least Recently Used）算法

### 3.1 双 LRU 列表

Linux 使用**两个维度**的 LRU 列表：

```
                    ┌────────────────────────────────────┐
                    │         LRU 列表结构                │
                    └────────────────────────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            │                                               │
    ┌───────▼───────┐                               ┌───────▼───────┐
    │  File LRU     │                               │ Anonymous LRU │
    └───────────────┘                               └───────────────┘
            │                                               │
    ┌───────┴───────┐                               ┌───────┴───────┐
    │               │                               │               │
┌───▼───┐       ┌───▼───-┐                       ┌───▼───┐       ┌───▼──-─┐
│Active │       │Inactive│                      │Active │       │Inactive│
│ File  │       │ File   │                      │ Anon  │       │ Anon   │
└───────┘       └────────┘                      └───────┘       └────────┘
    ↑               ↑                               ↑               ↑
  热页面          冷页面                           热页面          冷页面
                    │                                               │
                    ▼                                               ▼
               直接回收或                                      写入 Swap
               写回文件                                        然后回收
```

### 3.2 页面老化过程

```
页面生命周期：

新分配 → Active List (热) → 长时间未访问 → Inactive List (冷) → 回收
           ↑                                    │
           └────────────再次访问─────────────────┘
```

### 3.3 为什么 JVM 堆内存会被换出？

**场景分析**：

1. **JVM 堆中存在"冷对象"**

- NameNode 的某些元数据很少被访问
- 这些对象所在的内存页长期处于 Inactive Anonymous List

3. **内核后台扫描**

- kswapd 定期扫描 LRU 列表
- 发现长期未访问的 Anonymous Pages
- 将其换出到 Swap（即使物理内存并不紧张）

5. **没有使用** `**-XX:+AlwaysPreTouch**`

- JVM 启动时只申请虚拟地址空间
- 物理页在首次写入时才分配
- 某些页可能在分配后很少被访问，被内核视为"冷"

---

## 四、vm.swappiness 参数

### 4.1 参数含义

`vm.swappiness` 控制内核在回收内存时对 Anonymous Pages vs File Pages 的偏好：

|   |   |
|---|---|
|**值**|**行为**|
|0|尽量避免 Swap Anonymous Pages，除非绝对必要|
|1-59|倾向于回收 File Pages|
|60（默认）|平衡回收 File 和 Anonymous Pages|
|61-99|倾向于回收 Anonymous Pages|
|100|同等对待 File 和 Anonymous Pages|

### 4.2 swappiness = 0 的真正含义

**重要澄清**：`swappiness = 0` **不等于禁用 Swap**！

```
swappiness = 0 的行为：
┌─────────────────────────────────────────────────────────────────┐
│  1. 正常情况：尽量只回收 File Pages                                │
│  2. 但如果：                                                     │
│     - File Pages 已经很少                                        │
│     - 或者内存压力很大                                             │
│     → 仍然会 Swap Anonymous Pages                                │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 推荐设置

对于运行 JVM 的服务器：

```
# 方法 1：最小化 swappiness（仍可能 Swap）
sysctl vm.swappiness=0
echo "vm.swappiness=0" >> /etc/sysctl.conf

# 方法 2：完全禁用 Swap（激进但有效）
swapoff -a
# 并注释 /etc/fstab 中的 swap 条目
```

---

## 五、Page Fault（缺页中断）

### 5.1 缺页中断类型

|   |   |   |   |
|---|---|---|---|
|**类型**|**英文**|**触发条件**|**处理时间**|
|**Minor Page Fault**|软缺页|页已在内存，只需更新页表|微秒级|
|**Major Page Fault**|硬缺页|页不在内存，需从磁盘读取|**毫秒级**|

### 5.2 Major Page Fault 的代价

```
Major Page Fault 处理流程：

CPU 访问虚拟地址
       │
       ▼
┌─────────────────┐
│ 查询页表         │
│ 发现页不在内存    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 触发缺页中断      │
│ 陷入内核态        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 确定页在 Swap     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 发起磁盘 I/O     │←─── 耗时最长的部分！
│ 从 Swap 读取页   │     HDD: 5-10ms
└────────┬────────┘     SSD: 0.1-0.5ms
         │
         ▼
┌─────────────────┐
│ 分配物理页帧      │
│ 复制数据到内存    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 更新页表         │
│ 返回用户态        │
└────────┬────────┘
         │
         ▼
    继续执行

总耗时：毫秒级（vs 内存访问的纳秒级）
放大倍数：约 100,000 ~ 1,000,000 倍
```

### 5.3 监控 Page Fault

```
# 查看系统级 Page Fault
sar -B 1

# 输出字段：
# pgpgin/s   - 每秒从磁盘读入的 KB 数
# pgpgout/s  - 每秒写出到磁盘的 KB 数
# fault/s    - 每秒缺页中断总数
# majflt/s   - 每秒 Major Page Fault 数

# 查看进程级 Page Fault
ps -o min_flt,maj_flt -p <pid>

# 使用 perf 追踪
perf stat -e page-faults,major-faults -p <pid>
```

---

## 六、JVM 与 Swap 的致命交互

### 6.1 问题场景

```
┌─────────────────────────────────────────────────────────────────┐
│                    JVM + Swap 致命交互                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. JVM 启动，分配 200GB 堆（虚拟内存）                             │
│     └─→ 没有使用 AlwaysPreTouch，物理页按需分配                     │
│                                                                 │
│  2. 应用运行，堆中产生大量对象                                      │
│     └─→ 部分对象晋升到老年代后很少被访问                             │
│                                                                │
│  3. Linux 内核后台扫描 LRU                                       │
│     └─→ 发现这些"冷"的 Anonymous Pages                           │
│     └─→ 将其换出到 Swap                                          │
│                                                                │
│  4. G1 GC 触发（Mixed GC）                                      │
│     └─→ 需要扫描 RSet，遍历老年代对象                              │
│     └─→ 访问到被换出的内存页                                      │
│     └─→ 触发大量 Major Page Fault                               │
│                                                                │
│  5. GC 暂停时间爆炸                                              │
│     └─→ 原本毫秒级的 Scan RS 变成秒级甚至分钟级                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 为什么 GC 对 Swap 特别敏感？

1. **STW 期间无法并发**

- GC 的某些阶段是 Stop-The-World
- 所有应用线程都在等待
- 任何延迟都会直接体现在暂停时间上

3. **访问模式随机**

- GC 需要遍历大量对象
- 访问模式接近随机
- 无法利用磁盘的顺序读取优化

5. **多线程放大问题**

- G1 使用多个 GC 线程（本例 30 个）
- 多个线程同时触发 Page Fault
- 磁盘 I/O 成为瓶颈

### 6.3 本案例的证据

**SAR 数据**：

```
时间段          pswpin/s   pswpout/s   磁盘读取 KB/s
01:10-01:20     0.02       2.60        0.12         ← 正常
01:20-01:30     1.71       0.21        7.19         ← 正常
01:30-01:40   292.58       0.00     1170.94         ← Swap In 激增！
01:40-01:50    24.93     262.90      123.43         ← Swap Out 激增！
```

**解读**：

- **01:30-01:40**：大量 Swap In（292.58 pages/s），说明 GC 正在读回被换出的页
- **01:40-01:50**：Swap Out 增加，可能是内存释放后内核重新平衡

---

## 七、防止 JVM 内存被 Swap 的方法

### 7.1 方法对比

|   |   |   |   |
|---|---|---|---|
|**方法**|**实现**|**优点**|**缺点**|
|**设置 swappiness=0**|`sysctl vm.swappiness=0`|简单，减少 Swap|不能完全防止|
|**禁用 Swap**|`swapoff -a`|彻底解决|内存不足时 OOM|
|**AlwaysPreTouch**|JVM 参数|启动时预热内存|启动时间变长|
|**mlock/mlockall**|系统调用|锁定内存不被换出|需要特权，复杂|
|**cgroup memory**|memory.swappiness=0|容器级别控制|需要 cgroup 支持|
|**大页内存**|Huge Pages|不会被 Swap|配置复杂|

### 7.2 推荐组合方案

```
# 1. 系统级设置
sysctl vm.swappiness=0
echo "vm.swappiness=0" >> /etc/sysctl.conf

# 2. JVM 参数
-XX:+AlwaysPreTouch     # 启动时预热所有堆内存

# 3. 可选：使用大页内存（Huge Pages）
# 配置系统大页
echo 102400 > /proc/sys/vm/nr_hugepages  # 200GB / 2MB = 102400 个大页

# JVM 使用大页
-XX:+UseLargePages
-XX:LargePageSizeInBytes=2m

# 4. 可选：完全禁用 Swap（谨慎使用）
swapoff -a
```

### 7.3 AlwaysPreTouch 的作用

```
不使用 AlwaysPreTouch：
┌─────────────────────────────────────────────────────────────────┐
│  JVM 启动                                                       │
│  └─→ 申请 200GB 虚拟地址空间                                      │
│  └─→ 物理内存：0GB（按需分配）                                     │
│                                                                │
│  运行过程中                                                      │
│  └─→ 首次访问某页时触发 Minor Page Fault                          │
│  └─→ 内核分配物理页                                              │
│  └─→ 长时间未访问的页可能被换出                                    │
└────────────────────────────────────────────────────────────────┘

使用 AlwaysPreTouch：
┌─────────────────────────────────────────────────────────────────┐
│  JVM 启动                                                        │
│  └─→ 申请 200GB 虚拟地址空间                                       │
│  └─→ 逐页触摸（写入）所有页                                         │
│  └─→ 物理内存：200GB（全部分配）                                    │
│  └─→ 所有页都在 Active 列表                                       │
│                                                                 │
│  启动后                                                          │
│  └─→ 所有页已"热"，不太容易被立即换出                                │
│  └─→ 后续 GC 不会触发 Page Fault（页已在内存）                       │
└─────────────────────────────────────────────────────────────────┘
```

**注意**：AlwaysPreTouch 会显著增加 JVM 启动时间（200GB 可能需要几分钟）。

---

## 八、监控与诊断

### 8.1 关键监控指标

```
# 1. Swap 使用情况
free -h
cat /proc/meminfo | grep -i swap

# 2. Swap I/O 活动
sar -W 1          # pswpin/s, pswpout/s
vmstat 1          # si, so 列

# 3. 进程级内存信息
cat /proc/<pid>/status | grep -E "VmSwap|VmRSS|VmSize"
# VmSwap: 被换出的内存量

# 4. Page Fault 统计
sar -B 1          # majflt/s
ps -o min_flt,maj_flt -p <pid>

# 5. 磁盘 I/O（识别 Swap 分区）
iostat -xz 1
# 注意 Swap 分区的 r/s, w/s, await
```

### 8.2 诊断 Swap 是否影响 GC

```
# 1. 检查 GC 前后的 Swap 活动
# 在 GC 发生前后采集 sar 数据

# 2. 分析 GC 日志中的 real vs user 时间
# 正常情况：real ≈ user / ParallelGCThreads
# Swap 影响：real >> user / ParallelGCThreads（等待 I/O）

# 3. 使用 perf 追踪 Page Fault
perf record -e major-faults -p <pid> -g
perf report

# 4. 使用 strace 追踪系统调用
strace -f -e trace=memory -p <pid>
```

---

## 九、本案例的 SAR 数据分析

### 9.1 原始数据

```
sar -W 结果：
时间          pswpin/s  pswpout/s
01:10-01:20     0.31      0.00    ← 正常
01:20-01:30     0.02      2.60    ← 正常，少量换出
01:30-01:40   292.58      0.00    ← Swap In 激增！
01:40-01:50    24.93    262.90    ← 恢复，Swap Out 增加
```

### 9.2 与 GC 事件的关联

```
时间线对照：
┌─────────────────────────────────────────────────────────────────┐
│ 01:30-01:40                                                     │
│   GC 事件：01:36:30 触发 Concurrent Mark                         │
│   Swap：pswpin = 292.58/s                                       │
│   解释：Concurrent Mark 需要遍历整个堆，访问被换出的页                │
├─────────────────────────────────────────────────────────────────┤
│ 01:38:54 - 01:54:17                                             │
│   GC 事件：5 次 Mixed GC，Scan RS 时间爆炸                         │
│   磁盘读：1170 KB/s                                              │
│   解释：扫描 RSet 时持续触发 Page Fault                            │
├─────────────────────────────────────────────────────────────────┤
│ 01:40-01:50                                                     │
│   Swap：pswpout = 262.90/s                                      │
│   解释：GC 完成后，内存释放，内核将部分页换出以平衡                     │
└─────────────────────────────────────────────────────────────────┘
```

### 9.3 内存使用分析

```
sar -r 结果：
时间          kbmemfree   %memused   kbcached
01:10-01:20   3129336      98.81     96012560
01:20-01:30   2771496      98.95     96370872
01:30-01:40   2595796      99.01     96526332
01:40-01:50   1907836      99.28     96498156  ← 可用内存最低
01:50-02:00   3298188      98.75     95296540
```

**观察**：

- 系统内存使用率始终在 99% 左右
- 可用内存很少（约 2-3GB）
- 这意味着内核有动力将部分 Anonymous Pages 换出

---

## 十、总结

### 10.1 核心要点

1. **Swap 不是紧急内存，而是内存管理的一部分**

- 内核会主动将"冷"的 Anonymous Pages 换出
- 即使物理内存充足也可能发生

3. **JVM 堆属于 Anonymous Pages**

- 只能通过 Swap 回收
- GC 时需要访问整个堆，可能触发大量 Page Fault

5. **Page Fault 的代价是灾难性的**

- 延迟放大 100 万倍
- GC 暂停时间从毫秒变成秒/分钟

7. **LRU 算法对 GC 不友好**

- 老年代的"冷"对象容易被换出
- 但 GC 时必须访问它们

### 10.2 最佳实践

1. **系统级**：

- `vm.swappiness=0`
- 考虑禁用 Swap（需评估风险）
- 确保物理内存充足

3. **JVM 级**：

- **必须**使用 `-XX:+AlwaysPreTouch`
- 考虑使用大页内存（Huge Pages）

5. **监控**：

- 持续监控 `pswpin/pswpout`
- 监控 `majflt/s`
- 关联 GC 日志分析

---

## 参考资料

- [In Defence of Swap](https://chrisdown.name/2018/01/02/in-defence-of-swap.html)
- [Linux Swappiness](https://eklitzke.org/swappiness)
- [GridGain Memory Tuning](https://www.gridgain.com/docs/latest/perf-troubleshooting-guide/memory-tuning)
- [Elasticsearch Disable Swapping](https://www.elastic.co/guide/en/elasticsearch/reference/current/setup-configuration-memory.html)
- [Linux Kernel: Memory Management](https://www.kernel.org/doc/html/latest/admin-guide/mm/index.html)
