---
title: "Go 内存分配器——mcache、mcentral 与 mheap"
date: 2026-03-04
tags: [Golang, mcache, mcentral, mheap, size class, Span, TCMalloc, 内存分配器, 堆分配, 栈分配, 逃逸分析]
aliases: []
---

# Go 内存分配器——mcache、mcentral 与 mheap

## 摘要

Go 的内存分配器是整个运行时性能的基础，它脱胎于 Google 的 TCMalloc（Thread-Caching Malloc），采用三层缓存架构（`mcache` → `mcentral` → `mheap`）和按大小分类（size class）的设计，在减少锁竞争的同时实现了高效的内存分配与回收。理解这套机制，能解释很多 Go 性能特性：为什么小对象分配极快（无锁的 `mcache` 路径）？为什么 Go 程序内存占用有时比预期高（内存不立即归还 OS）？为什么逃逸分析如此重要（栈分配比堆分配快一个数量级）？本文从内存管理的基本问题出发，逐层剖析 `mspan`（内存块）的设计、67 个 size class 的分类逻辑、三层缓存的分配路径、大对象（>32KB）的特殊处理，以及内存归还给操作系统的时机与机制（`scavenger`）。

---

## 第 1 章 内存管理的基本问题：为什么不直接用 malloc

### 1.1 系统调用的代价

操作系统通过 `mmap`/`brk` 等系统调用向进程分配内存，但每次系统调用都有显著的开销：需要从用户态切换到内核态（约 100-1000ns），内核需要更新页表、执行内存保护检查等。对于一个高并发的 Go 服务，每秒可能有数百万次小对象分配，如果每次都调用 `mmap`，性能将完全不可接受。

因此，Go 运行时采用**内存池**策略：从 OS 预先申请大块内存（通过 `mmap`），然后在用户态自行管理这块内存的分配与回收，只在内存池不足时才再次向 OS 申请。

### 1.2 通用 malloc 的局限性

即使是优化过的通用 malloc（如 glibc 的 ptmalloc），在高并发场景下仍有两个问题：

**问题一：全局锁竞争**。传统 malloc 维护一个全局的空闲链表（free list），每次分配/释放都需要加锁。在多核 CPU 上，这个全局锁会成为严重的竞争热点——内核数越多，锁竞争越激烈，性能越差（接近线性退化）。

**问题二：内存碎片**。通用 malloc 分配任意大小的内存块，随着时间推移，堆上会出现大量大小不一的空洞（内存碎片）——这些空洞的总大小可能足够分配新对象，但单个空洞太小无法使用，导致实际可用内存减少。

**Go 的解法来自 TCMalloc**：Thread-Caching Malloc 是 Google 在 2001 年为 C++ 设计的高性能内存分配器，其核心思想是：
1. **按大小分类（Size Class）**：将所有对象按大小分成若干类别，每个类别维护独立的空闲链表，消灭碎片（相同大小的对象可以完美复用空闲 slot）；
2. **线程本地缓存（Thread-Local Cache）**：每个线程维护一个私有的小对象缓存，分配时无需任何锁，只有缓存耗尽时才需要与共享层交互。

Go 的内存分配器在 TCMalloc 的基础上做了若干调整以适配 Goroutine 模型（用 P 的缓存替代线程缓存等），并与 GC 深度集成。

---

## 第 2 章 基础单元：mspan

### 2.1 mspan 是什么

`mspan` 是 Go 内存分配器的基本管理单元。一个 `mspan` 代表**一段连续的内存页**（page，Go 中每页 8KB），专门用于分配某一个 size class 的对象：

```go
// runtime/mheap.go（简化）
type mspan struct {
    next     *mspan     // 链表：下一个 mspan
    prev     *mspan     // 链表：上一个 mspan
    startAddr uintptr   // 这段连续内存的起始地址
    npages   uintptr    // 这段内存包含的页数（每页 8KB）
    
    manualFreeList gclinkptr  // 手动管理的空闲对象链表
    freeindex uintptr         // 快速分配的游标位置（指向下一个空闲 slot）
    nelems   uintptr          // 该 span 总共能容纳多少个对象
    allocBits  *gcBits        // 位图：哪些 slot 已被分配
    gcmarkBits *gcBits        // 位图：GC 标记（哪些对象可达）
    
    spanclass spanClass       // size class 编号（0-67）
    // ...
}
```

**mspan 的工作原理**：一个 size class 为 `k` 的 `mspan`，其内存区域被等分成若干固定大小的 slot，每个 slot 存放一个对象。`allocBits` 位图记录哪些 slot 已分配，`freeindex` 是快速路径分配游标——依次扫描找到下一个空闲 slot，避免遍历整个位图。

```
一个 size class=8 (32 字节/对象) 的 mspan（1 页 = 8KB）：

+------+------+------+------+ ... +------+
|  s0  |  s1  |  s2  |  s3  |     | s255 |   256 个 32 字节的 slot
+------+------+------+------+ ... +------+
  ↑
freeindex（游标，指向下一个空闲 slot）

allocBits：0b11001010...（1=已分配，0=空闲）
```

### 2.2 size class：67 个大小分类

Go 将对象大小分为 67 个 size class（从 size class 1 到 67，size class 0 表示"大对象"），每个 size class 对应一个固定的对象大小和该 size class 的 `mspan` 所需页数：

| size class | 对象大小 | mspan 页数 | 每个 mspan 中的对象数 | 内存利用率 |
| --- | --- | --- | --- | --- |
| 1 | 8 bytes | 1 page (8KB) | 1024 | 100% |
| 2 | 16 bytes | 1 page | 512 | 100% |
| 3 | 24 bytes | 1 page | 341 | ~99.6% |
| 4 | 32 bytes | 1 page | 256 | 100% |
| 5 | 48 bytes | 1 page | 170 | ~99.6% |
| ... | ... | ... | ... | ... |
| 13 | 96 bytes | 1 page | 85 | ~99.1% |
| ... | ... | ... | ... | ... |
| 67 | 32768 bytes (32KB) | 4 pages | 1 | 100% |

**为什么要分类**？设想如果所有 4 字节的对象和所有 32 字节的对象都混在一个连续的堆区域中，当一个 4 字节的对象被释放后，这个 4 字节的空洞只能被另一个 4 字节或更小的对象复用。但如果有人请求 8 字节的对象，这个空洞就无法使用——碎片产生。而如果将"4 字节对象专用 span"和"8 字节对象专用 span"分开，每个 span 内的所有 slot 大小相同，释放的 slot 可以完美地被同 size class 的下一个对象复用——**零碎片**。

**size class 的设计原则**：相邻两个 size class 的大小比值约在 1.1-1.5 倍之间，使内存浪费（一个对象分配到比它大的 size class）不超过约 12.5%。例如，一个 33 字节的对象会分配到 48 字节的 size class，浪费 `(48-33)/48 ≈ 31%`……这看起来比较浪费，但平均浪费率通过精心设计保持在可接受范围内。

---

## 第 3 章 三层缓存架构：分配路径全解析

### 3.1 架构总览

Go 的内存分配器采用三层缓存，从快到慢：

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#44475a', 'lineColor': '#bd93f9', 'secondaryColor': '#44475a', 'background': '#282a36'}}}%%
graph TD
    classDef fast fill:#50fa7b,stroke:#282a36,color:#282a36
    classDef mid fill:#ffb86c,stroke:#282a36,color:#282a36
    classDef slow fill:#ff5555,stroke:#282a36,color:#f8f8f2
    classDef os fill:#6272a4,stroke:#282a36,color:#f8f8f2

    A["分配请求 (size ≤ 32KB)"]
    B["mcache</br>P 本地缓存（无锁）"]:::fast
    C["mcentral</br>全局每 size class 一把锁"]:::mid
    D["mheap</br>全局堆（一把大锁）"]:::slow
    E["操作系统</br>mmap 申请新内存"]:::os
    F["大对象 (>32KB)</br>直接从 mheap 分配"]:::slow

    A --> B
    B -->|"mcache 无空闲 span"| C
    C -->|"mcentral 无空闲 span"| D
    D -->|"mheap 内存不足"| E
    A -->|"size > 32KB"| F
    F --> D
```

### 3.2 第一层：mcache（P 本地缓存，无锁）

`mcache` 是与每个 **P**（Processor，Go 调度器中的逻辑处理器，详见[[01 Goroutine 与 GMP 调度器]]）绑定的本地缓存。由于每个 Goroutine 在任何时刻只运行在一个 P 上，`mcache` 是无锁访问的——分配时根本不需要任何同步操作。

```go
// runtime/mcache.go（简化）
type mcache struct {
    // alloc 数组：67 个 size class × 2（noscan/scan）= 134 个 mspan 指针
    // 每个 size class 有两个版本：
    //   noscan：对象中不包含指针（GC 不需要扫描）
    //   scan：对象中包含指针（GC 需要扫描追踪引用）
    alloc [numSpanClasses]*mspan
    
    // 小对象（< 16 bytes，且不含指针）的微分配器
    tiny       uintptr  // 当前微分配块的起始地址
    tinyoffset uintptr  // 当前微分配块内的分配游标
    tinyAllocs uintptr  // 微分配计数
}
```

**分配小对象的快速路径**（无锁，约 1-3ns）：

```
1. 确定对象的 size class（查表，O(1)）
2. 从 mcache.alloc[sizeclass] 取出当前 mspan
3. 检查 mspan.freeindex：是否有空闲 slot
4. 有：直接返回 slot 地址，freeindex 前进——完成！
5. 无（当前 mspan 已满）：去 mcentral 获取新的 mspan（需要锁）
```

**微分配器（Tiny Allocator）**：对于极小的无指针对象（`< 16 bytes`，如 `int8`、`bool`、小 struct），Go 还有一个更激进的优化——将多个微小对象打包到同一个 16 字节的内存块中：

```go
// 假设连续分配 3 个 int8（1 字节）：
// 普通路径：每个分配到 size class=1（8 字节），浪费 7 字节/对象
// 微分配路径：3 个 int8 共享一个 16 字节块，偏移 0/1/2，利用率大幅提升

// runtime/malloc.go 中的微分配逻辑
if size < maxTinySize {  // maxTinySize = 16
    // 检查当前 tiny 块能否容纳
    off := c.tinyoffset
    if off+size <= maxTinySize && c.tiny != 0 {
        // 直接在当前 tiny 块内分配，更新偏移
        x = unsafe.Pointer(c.tiny + off)
        c.tinyoffset = off + size
        return x
    }
    // tiny 块满了，申请新的 tiny 块（从 size class 2 = 16 字节的 mspan 中）
}
```

微分配器能将极小对象的分配效率提升约 5-10 倍，这对于大量分配小 struct 和基本类型的程序（如 JSON 解析、AST 构建）有显著性能收益。

### 3.3 第二层：mcentral（每个 size class 一把锁）

当 `mcache` 中某个 size class 的 `mspan` 耗尽时，需要从 `mcentral` 获取新的 `mspan`。`mcentral` 是全局的，每个 size class 对应一个 `mcentral` 实例，有独立的锁——这意味着不同 size class 的分配不会相互竞争。

```go
// runtime/mcentral.go（简化）
type mcentral struct {
    spanclass spanClass  // 这个 mcentral 管理的 size class
    
    // partial：包含空闲 slot 的 mspan 列表
    partial [2]spanSet   // partial[0]=已清扫，partial[1]=未清扫（GC 相关）
    
    // full：已全满的 mspan 列表（无空闲 slot）
    full    [2]spanSet
}
```

`mcentral` 的分配路径（有锁，约 30-100ns）：
1. 加锁；
2. 从 `partial` 列表取出一个有空闲 slot 的 `mspan`，返回给 `mcache`；
3. 如果 `partial` 为空，去 `mheap` 申请新的 `mspan`；
4. 解锁。

返回 `mcache` 后，原来的空 `mspan`（已经没有空闲 slot 了）被移入 `full` 列表保存，等待 GC 扫描后回收空间。

### 3.4 第三层：mheap（全局堆，页级别管理）

`mheap` 是 Go 内存分配器的最底层，管理所有从操作系统申请的内存。它以**页**（8KB）为单位管理内存，为 `mcentral` 提供新的 `mspan`，也直接处理大对象（> 32KB）的分配。

```go
// runtime/mheap.go（简化）
type mheap struct {
    lock      mutex     // 全局锁（分配时需要持有）
    
    // 空闲页管理：基数树（radix tree）
    // 记录哪些连续页范围是空闲的
    pages     pageAlloc
    
    // 所有 mcentral 实例（67 size classes × 2）
    central [numSpanClasses]struct {
        mcentral mcentral
        pad      [cpu.CacheLinePadSize - unsafe.Sizeof(mcentral{})%cpu.CacheLinePadSize]byte
        // pad 是缓存行填充，防止不同 mcentral 的数据在同一 cache line 上（False Sharing）
    }
    
    // Arena：Go 向 OS 申请的大块内存区域
    arenas [1 << arenaL1Bits]*[1 << arenaL2Bits]*heapArena
    // ...
}
```

**Arena 的设计**：Go 运行时使用**Arena**机制从 OS 预先申请大块连续内存（64 位系统上每次申请 64MB），然后在这块大内存上做细粒度管理。Arena 之间通过二级页表（`arenas` 数组）组织，支持稀疏内存（进程的虚拟地址空间不需要完全连续）。

**大对象（> 32KB）的分配**：直接从 `mheap` 分配，绕过 `mcache` 和 `mcentral`，分配整数个连续页（向上取整到 8KB 的倍数）：

```go
// 分配一个 40KB 的对象：
// 需要 ceil(40KB / 8KB) = 5 个连续页
// 直接调用 mheap.alloc(5 pages)
// 创建一个 span 类型为 class 0（大对象专用）的 mspan
```

---

## 第 4 章 逃逸分析：决定分配位置的关键

### 4.1 栈分配 vs 堆分配

理解 Go 内存分配器，必须理解**逃逸分析**（Escape Analysis）的作用——它是编译器决定"这个变量应该分配在栈上还是堆上"的机制。

**栈分配**（约 1ns）：在函数的栈帧上分配，只需移动栈指针，函数返回时自动回收，完全不涉及 GC。

**堆分配**（约 10-30ns）：通过 Go 的内存分配器在堆上分配，需要 GC 追踪和回收，是栈分配的 10-30 倍慢。

**逃逸分析的规则**：编译器会分析变量的生命周期，如果变量可能在创建它的函数返回后仍被访问，则必须分配到堆上（"逃逸"）；否则可以在栈上分配。

```go
// 场景一：变量不逃逸，栈分配
func stackAlloc() int {
    x := 42       // x 不逃逸：只在本函数内使用
    return x      // 返回值（整数），复制给调用方
}

// 场景二：变量逃逸，堆分配
func heapAlloc() *int {
    x := 42       // x 逃逸到堆：函数返回后调用方仍持有指向 x 的指针
    return &x
}

// 场景三：赋给接口导致逃逸
func interfaceEscape() interface{} {
    x := 42       // x 逃逸：被装入 interface{}，接口可能超出本函数生命周期
    return x
}

// 场景四：大对象通常逃逸
func largeEscape() {
    // 超过栈大小阈值（通常 > 64KB）的对象会逃逸到堆
    var buf [65536]byte
    use(buf[:])
}
```

**查看逃逸分析结果**：

```bash
go build -gcflags="-m -m" main.go 2>&1 | grep escape
# 输出示例：
# ./main.go:8:2: x escapes to heap
# ./main.go:14:2: x does not escape
```

### 4.2 常见的逃逸场景

理解哪些操作会触发逃逸，有助于写出更高效的代码：

| 触发场景 | 说明 |
| --- | --- |
| 返回局部变量的指针 | 生命周期超出函数，必须堆分配 |
| 将变量赋给接口 | 接口内的值不可寻址，存储时需要堆分配 |
| 闭包捕获外部变量 | 闭包生命周期可能超出外层函数 |
| 切片容量增长（append 扩容）| 新底层数组在堆上分配 |
| 发送到 Channel | 发送的值可能被另一个 Goroutine 使用 |
| 在 `go` 语句中使用 | Goroutine 的参数需要在堆上 |
| 大对象 | 超过栈帧大小阈值 |
| 编译器无法确定大小的对象 | 如 `make([]int, n)`，n 是变量 |

**减少不必要逃逸的技巧**：

```go
// 技巧一：避免将小对象装入 interface{}（如果只是临时使用）
// 低效：装箱导致逃逸
func printValue(v interface{}) { fmt.Println(v) }
printValue(42)  // 42 逃逸到堆

// 更好：使用具体类型（如果调用方知道类型）
func printInt(v int) { fmt.Println(v) }
printInt(42)  // 42 不逃逸

// 技巧二：预分配 slice，避免 append 扩容时的重新分配
result := make([]int, 0, expectedLen)

// 技巧三：对于频繁分配/释放的对象，使用 sync.Pool 复用
var pool = &sync.Pool{
    New: func() interface{} { return &MyObject{} },
}
obj := pool.Get().(*MyObject)
// ... 使用 obj ...
pool.Put(obj)  // 放回池中，下次复用
```

---

## 第 5 章 内存归还：scavenger 与 MADV_FREE

### 5.1 Go 内存归还 OS 的机制

Go 的内存分配器并不立即将空闲内存归还给操作系统——从 OS 获取内存是通过 `mmap`，而归还需要调用 `munmap`（或 `MADV_FREE`/`MADV_DONTNEED`），这些操作有系统调用开销，频繁调用得不偿失。

Go 运行时的策略：
- **GC 之后**：标记清扫完成后，将大量空闲的内存页标记为可归还（通过 `MADV_FREE` 通知 OS 这些页可以在内存压力时回收，但物理页暂时保留）；
- **定期归还（Scavenger）**：Go 运行时有一个后台 Goroutine（`bgscavenge`），周期性地将长期空闲（超过 5 分钟，Go 1.12 之后是基于目标内存量）的内存物理归还给 OS（通过 `MADV_DONTNEED`）。

### 5.2 MADV_FREE vs MADV_DONTNEED

这两个 `madvise` 系统调用有不同的语义，影响 Go 进程的内存占用数字如何呈现：

**`MADV_DONTNEED`**（Linux 默认，Go 1.11 之前和 1.16 之后在某些情况下使用）：立即将物理内存归还给 OS，页表项仍在但物理页被回收。下次访问这些地址会触发缺页异常（page fault），重新分配物理内存。RSS（Resident Set Size，实际物理内存占用）立即减小。

**`MADV_FREE`**（Linux 4.5+，Go 1.12-1.15 默认）：物理页可以被 OS 在内存压力时回收，但如果内存充裕，这些页会保留（下次访问无需 page fault）。RSS 不立即减小（OS 可能保留这些页），只有在 OS 内存紧张时才真正回收。

Go 1.16 引入环境变量 `GODEBUG=madvdontneed=1` 允许用户选择行为；Go 1.12 曾切换到 `MADV_FREE`，但因为很多监控系统（如 Kubernetes 的内存 limit）基于 RSS 判断内存占用，`MADV_FREE` 导致 RSS 数字虚高，引发误报 OOM 问题，Go 1.16 回退到优先使用 `MADV_DONTNEED`。

> [!warning] 生产避坑：Go 程序的内存指标解读
> `top` 或 `ps` 看到的 RSS 不等于 Go 程序"真正使用"的内存。Go 的内存分配器会保留一定的空闲内存在池中（待复用），这部分内存反映在 RSS 中。更准确的指标是 Go pprof 中的 `HeapInuse`（当前 heap 中活跃对象占用的内存）和 `HeapSys`（从 OS 申请的总内存，含空闲池）。RSS ≈ HeapSys + 栈 + 其他。

### 5.3 GOGC：控制 GC 触发频率与内存占用的旋钮

`GOGC` 环境变量（或 `runtime/debug.SetGCPercent`）控制 GC 的触发阈值：

```
触发 GC 的条件：
当前堆大小 >= 上次 GC 后堆大小 × (1 + GOGC/100)

GOGC=100（默认）：堆大小翻倍时触发 GC
GOGC=50：堆大小增长 50% 时触发 GC（GC 更频繁，内存占用更低，CPU 开销更高）
GOGC=200：堆大小增长 200% 时触发 GC（GC 更稀少，内存占用更高，CPU 开销更低）
GOGC=off：禁用 GC（仅用于调试）
```

**如何选择 GOGC**：
- 内存敏感型服务（如嵌入式、微服务在内存 limit 较小的容器中）：降低 GOGC（如 50），减少内存占用，但增加 CPU；
- CPU 敏感型、高吞吐服务：提高 GOGC（如 200-400），减少 GC 频率，但增加内存占用；
- 默认 GOGC=100 对大多数场景是合理的起点。

Go 1.19 引入了 `GOMEMLIMIT`，允许设置进程的软内存上限，当接近上限时自动加速 GC——这比单纯调整 GOGC 更直观、更安全。

---

## 第 6 章 内存分配器的调试与诊断

### 6.1 使用 runtime.MemStats 查看分配统计

```go
import "runtime"

var stats runtime.MemStats
runtime.ReadMemStats(&stats)

fmt.Printf("HeapAlloc:   %d bytes\n", stats.HeapAlloc)   // 当前活跃对象占用
fmt.Printf("HeapSys:     %d bytes\n", stats.HeapSys)     // 从 OS 申请的总量
fmt.Printf("HeapIdle:    %d bytes\n", stats.HeapIdle)    // 空闲（可归还 OS）的量
fmt.Printf("HeapInuse:   %d bytes\n", stats.HeapInuse)   // Span 中有对象使用的量
fmt.Printf("NumGC:       %d\n", stats.NumGC)             // GC 执行次数
fmt.Printf("TotalAlloc:  %d bytes\n", stats.TotalAlloc)  // 历史总分配量（含已释放）
fmt.Printf("Mallocs:     %d\n", stats.Mallocs)           // 历史总分配对象数
fmt.Printf("Frees:       %d\n", stats.Frees)             // 历史总释放对象数
fmt.Printf("StackSys:    %d bytes\n", stats.StackSys)    // Goroutine 栈使用的总内存
```

### 6.2 使用 pprof 定位内存热点

```bash
# 开启 pprof HTTP 端点（在 main.go 中 import _ "net/http/pprof"）
go tool pprof http://localhost:6060/debug/pprof/heap

# 在 pprof 交互界面：
(pprof) top10          # 查看内存分配 top 10 函数
(pprof) list funcName  # 查看某函数的逐行内存分配
(pprof) web            # 生成调用图（需要 graphviz）
```

**heap profile 的四种视图**：
- `inuse_space`（默认）：当前活跃对象占用的内存（已分配未释放）；
- `inuse_objects`：当前活跃对象的数量；
- `alloc_space`：历史总分配内存量（包含已被 GC 回收的）；
- `alloc_objects`：历史总分配对象数量。

`alloc_space` 和 `alloc_objects` 对于找"分配最频繁的地方"（可能导致 GC 压力）更有用；`inuse_space` 用于找"内存占用最多的地方"（可能导致内存泄漏）。

---

## 总结

本篇从内存管理的基本问题出发，系统梳理了 Go 内存分配器的三层架构：

**mspan 与 size class**：`mspan` 是内存管理的基本单元，每个 span 专属于一个 size class，其中的 slot 大小相同——这消灭了内存碎片。67 个 size class 覆盖 8 字节到 32KB 的对象，相邻 size class 比值约 1.1-1.5，最大浪费率控制在合理范围内。

**三层缓存的分配路径**：`mcache`（P 本地，无锁，约 1-3ns）→ `mcentral`（每 size class 一把锁，约 30-100ns）→ `mheap`（全局堆，页级管理）→ OS（`mmap`）。大对象（> 32KB）直接走 `mheap` 路径，跳过前两层。微分配器（Tiny Allocator）将 < 16 字节的无指针小对象打包到 16 字节块中，进一步提升小对象分配效率。

**逃逸分析决定分配位置**：栈分配（约 1ns）比堆分配（约 10-30ns）快一个数量级，且无 GC 追踪开销。编译器的逃逸分析决定变量是在栈还是堆上——返回局部变量指针、装入接口、闭包捕获等场景会触发逃逸。`go build -gcflags="-m"` 可以查看逃逸决策，指导性能优化。

**内存归还与 GOGC**：Go 不立即将空闲内存归还 OS，而是通过 `scavenger` 后台协程定期归还。`MADV_DONTNEED` vs `MADV_FREE` 影响 RSS 的呈现方式。`GOGC` 控制 GC 触发阈值，Go 1.19 引入的 `GOMEMLIMIT` 提供了更直观的内存上限控制。

下一篇深入 Go GC 的三色标记算法与混合写屏障：[[09 垃圾回收——三色标记与混合写屏障]]。

---

> [!note] 参考资料
> - Go 运行时源码：`runtime/malloc.go`、`runtime/mheap.go`、`runtime/mcache.go`、`runtime/mcentral.go`
> - Austin Clements,《Go 1.5 concurrent garbage collector pacing》
> - TCMalloc 设计文档：https://google.github.io/tcmalloc/design.html
> - Go Blog,《Getting to Go: The Journey of Go's Garbage Collector》

---

> [!note] 思考题
> 1. Go 的内存分配器将对象分为三类：tiny（< 16B）、small（16B-32KB）、large（> 32KB）。tiny 对象的分配使用 mcache 中的 tiny allocator，将多个 tiny 对象合并到同一个 16B 的内存块中。这个优化对什么类型的程序效果最显著？如果一个 tiny 对象包含指针，还能使用 tiny allocator 吗？为什么？
> 2. 每个 P 有自己的 mcache，mcache 中缓存了各个 size class 的空闲对象。当 mcache 用尽时，从 mcentral 获取新的 span。这种'P 本地缓存'的设计与 TCMalloc 的 thread cache 有什么异同？在 GOMAXPROCS=64 的高并发场景下，mcache 的总内存占用是多少？这是否会成为内存压力？
> 3. Go 内存分配器的 size class 将 0-32KB 的对象映射到 67 个离散的大小等级。例如 33 字节的对象会被分配到 48 字节的 size class 中，浪费 15 字节。这种'内部碎片'的理论最大值是多少？与 C 的 `malloc`（glibc ptmalloc）相比，Go 的分配器在碎片率方面有优势还是劣势？
