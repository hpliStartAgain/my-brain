---
title: "sync.Map、sync.Pool 与原子操作"
date: 2026-03-04
tags: [Golang, sync.Map, sync.Pool, atomic, 原子操作, 无锁, 并发安全, read-copy-update, 对象池, GC]
aliases: []
---

# sync.Map、sync.Pool 与原子操作

## 摘要

`sync` 包除了提供互斥锁和读写锁，还提供了两个针对高频并发场景深度优化的工具：`sync.Map`（并发安全的 map，专为读多写少或键稳定场景优化）和 `sync.Pool`（对象复用池，减少频繁分配导致的 GC 压力）。与此同时，`sync/atomic` 包提供了底层的原子操作原语，是所有无锁数据结构的基础。这三者在实现上都贯穿着同一个核心思想：**用无锁或细粒度锁的设计，在特定场景下替代重量级 Mutex**。本文深入 `sync.Map` 的双 map（read/dirty）设计和提升机制、`sync.Pool` 与 GC 的交互方式及 per-P 缓存池设计、以及 CAS/Load/Store 原子操作的内存序语义与实践边界。

---

## 第 1 章 sync.Map：为什么不直接用 map + RWMutex

### 1.1 map + RWMutex 的瓶颈

对于并发访问的 map，最直接的方案是 `map[K]V` + `sync.RWMutex`：读操作持有读锁（允许并发），写操作持有写锁（独占）。这个方案在轻度竞争场景下完全够用，但在以下高频场景会成为性能瓶颈：

**场景一：读多写极少（如配置缓存、路由表）**。每次读都要 `RLock` + `RUnlock`，虽然读锁允许并发，但锁操作本身仍有约 10-30ns 的开销。对于每秒数百万次读取的场景，这个开销累积起来不可忽视。

**场景二：每个 Goroutine 访问不同的 key（如 per-goroutine 计数器、连接池）**。在这种场景中，Goroutine 之间几乎没有真正的 key 竞争，却因为共享同一把锁而产生不必要的竞争。

`sync.Map` 针对这两个场景做了深度优化，其代价是：对于**写多读少**或**key 不稳定**的场景，性能可能不如简单的 `map + RWMutex`——选择时需要了解其适用条件。

### 1.2 sync.Map 的设计思想：Read-Copy-Update

`sync.Map` 的核心思想借鉴自 Linux 内核的 **RCU（Read-Copy-Update）** 机制：

- **读操作**：通过原子加载一个只读的 map 副本（`read`），完全无锁——读取 `read` map 中的条目不需要任何锁；
- **写操作**：修改一个带锁的 `dirty` map（需要加锁，但只有写操作时才需要），同时通过特殊标记处理 `read` 和 `dirty` 之间的一致性；
- **提升（Promotion）**：当 `dirty` map 中的访问次数（miss 次数）积累到一定程度，将 `dirty` 原子地提升为新的 `read` map。

---

## 第 2 章 sync.Map 的内存结构与操作原理

### 2.1 内存结构

```go
// sync/map.go（简化，加中文注释）
type Map struct {
    mu     Mutex              // 保护 dirty 字段的互斥锁
    read   atomic.Pointer[readOnly]  // 只读 map（原子加载，无锁读）
    dirty  map[any]*entry     // 可写 map（需要 mu 保护）
    misses int                // 读 read 未命中的次数（触发 dirty 提升的计数器）
}

// readOnly 是 read 字段指向的只读快照
type readOnly struct {
    m       map[any]*entry  // 实际存储的 map
    amended bool            // dirty 中是否有 read 没有的 key（true 表示 dirty 有新 key）
}

// entry 是每个 key 对应的值的包装
type entry struct {
    p atomic.Pointer[any]  // 实际存储的值
    // p 有三种状态：
    // 1. 指向真实值（正常状态）
    // 2. nil（已被 Delete，但 key 还在 dirty 中）
    // 3. expunged（已被标记为永久删除，key 不在 dirty 中）
}
```

这里有一个关键的设计：`read` 和 `dirty` 中的 `*entry` **是共享的**——两个 map 中同一个 key 对应的是**同一个 `entry` 指针**（不是值的拷贝）。这意味着更新一个已存在 key 的值，只需原子地修改 `entry.p`，不需要任何锁——`read` map 和 `dirty` map 中的 `entry` 会同时看到更新。

### 2.2 Load（读取）操作

```go
func (m *Map) Load(key any) (value any, ok bool) {
    // 快速路径：从 read map 原子加载，无锁
    read := m.read.Load()
    e, ok := read.m[key]
    
    // 如果 read 中没有，且 dirty 中可能有（amended=true）
    if !ok && read.amended {
        m.mu.Lock()
        // 双重检查（加锁后 read 可能已被提升）
        read = m.read.Load()
        e, ok = read.m[key]
        if !ok && read.amended {
            e, ok = m.dirty[key]
            // 记录一次 miss，累积 misses 触发 dirty 提升
            m.missLocked()
        }
        m.mu.Unlock()
    }
    
    if !ok {
        return nil, false
    }
    return e.load()  // 原子加载 entry 中的值
}

func (m *Map) missLocked() {
    m.misses++
    if m.misses < len(m.dirty) {
        return
    }
    // misses 达到 dirty 的长度：将 dirty 提升为 read
    m.read.Store(&readOnly{m: m.dirty})
    m.dirty = nil
    m.misses = 0
}
```

**快速路径（read 命中）**：一次原子 load + map 查找，完全无锁，约 10-20ns。

**慢速路径（read 未命中）**：需要加锁查询 dirty，并记录 miss。当 miss 次数达到 `len(dirty)` 时，dirty 被提升为 read——之后相同的查询就走快速路径了。

### 2.3 Store（写入）操作

```go
func (m *Map) Store(key, value any) {
    // 如果 key 已在 read 中且未被删除，原子更新 entry（无需锁）
    read := m.read.Load()
    if e, ok := read.m[key]; ok && e.tryStore(&value) {
        return  // 快速路径：更新已存在 key 的值，无锁！
    }
    
    // 慢速路径：key 不在 read 中，或 entry 被标记为 expunged
    m.mu.Lock()
    read = m.read.Load()
    if e, ok := read.m[key]; ok {
        // key 在 read 中但是 expunged 状态：恢复它，并加入 dirty
        if e.unexpungeLocked() {
            m.dirty[key] = e
        }
        e.storeLocked(&value)
    } else if e, ok := m.dirty[key]; ok {
        // key 在 dirty 中：直接更新
        e.storeLocked(&value)
    } else {
        // 全新的 key：加入 dirty
        if !read.amended {
            // dirty 是 nil 或尚未与 read 分歧：初始化 dirty
            m.dirtyLocked()
            m.read.Store(&readOnly{m: read.m, amended: true})
        }
        m.dirty[key] = newEntry(value)
    }
    m.mu.Unlock()
}
```

**快速路径（更新已存在 key）**：原子 CAS 更新 `entry.p`，完全无锁——这是 sync.Map 适合"读多写少，且写操作主要是更新已有 key"场景的原因。

**慢速路径（插入新 key）**：需要加锁，将新 key 写入 dirty map，并设置 `amended=true`。

### 2.4 dirty 提升：一次提升之后

当 dirty 被提升为 read 后，dirty 变为 nil。下次有新的 key 需要写入 dirty 时，`dirtyLocked()` 会将 read 中**所有未被删除的 entry** 复制到新的 dirty map 中——这确保 dirty 是 read 的超集（dirty 包含所有 key，read 只是一个快照）。

```go
func (m *Map) dirtyLocked() {
    if m.dirty != nil {
        return
    }
    read := m.read.Load()
    m.dirty = make(map[any]*entry, len(read.m))
    for k, e := range read.m {
        // 将 read 中未被 expunged 的 entry 复制到 dirty
        // expunged 的 entry（已被彻底删除的）不复制
        if !e.tryExpungeLocked() {
            m.dirty[k] = e  // 注意：共享 entry 指针，不是复制值
        }
    }
}
```

> [!info] 核心概念：sync.Map 的适用场景
> `sync.Map` 针对两种场景深度优化：（1）**读多写少**：大量读操作走无锁的 read map 快速路径，锁只在写时才需要；（2）**各 Goroutine 写不同的 key**（如 per-goroutine 状态存储）：一旦 key 被写入并提升到 read，后续对该 key 的更新走无锁路径。对于**写密集**或**key 频繁变动**的场景，`map + RWMutex` 反而更优——因为 sync.Map 的 dirty 提升开销（复制 read 到 dirty）在这类场景下会频繁触发。

---

## 第 3 章 sync.Pool：对象复用池

### 3.1 对象池解决的问题

在高并发服务中，某些对象会被频繁地分配和释放——例如 HTTP 请求处理中的 `[]byte` buffer、JSON 编解码中的临时对象、日志格式化中的 `strings.Builder` 等。每次分配都需要走内存分配器（[[08 Go 内存分配器——mcache、mcentral 与 mheap]]），每次释放都增加 GC 的工作量。

`sync.Pool` 的解法：将用完的对象放回池中，下次需要时从池中取，避免重新分配：

```go
var bufPool = &sync.Pool{
    New: func() any {
        return make([]byte, 0, 4096)  // 初始 4KB buffer
    },
}

func processRequest(data []byte) {
    buf := bufPool.Get().([]byte)  // 从池中取（或 New 创建）
    buf = buf[:0]                  // 重置 length，保留底层数组
    
    buf = append(buf, data...)
    // ... 使用 buf 处理请求 ...
    
    bufPool.Put(buf)  // 放回池中，下次复用
}
```

### 3.2 sync.Pool 的内存结构：per-P 本地池

`sync.Pool` 的高性能来自于**与 GMP 调度器深度结合**的设计——每个 P（逻辑处理器）都有自己的本地池，访问本地池不需要任何锁：

```go
// sync/pool.go（简化）
type Pool struct {
    noCopy noCopy
    local     unsafe.Pointer  // 指向 [P]poolLocal 数组的指针（每个 P 一个 poolLocal）
    localSize uintptr         // 数组长度（等于当前 GOMAXPROCS）
    victim     unsafe.Pointer // GC 前的 local（保留一个 GC 周期）
    victimSize uintptr
    New func() any            // 池为空时调用，创建新对象
}

// poolLocal 是每个 P 的本地池
type poolLocal struct {
    poolLocalInternal
    pad [128 - unsafe.Sizeof(poolLocalInternal{})%128]byte  // 缓存行对齐，防止 False Sharing
}

type poolLocalInternal struct {
    private any          // 只有当前 P 能访问的"私有槽"（最快，无需任何同步）
    shared  poolChain    // 双端队列：本 P 从头部 push/pop，其他 P 从尾部 steal
}
```

### 3.3 Get 的查找顺序

```go
func (p *Pool) Get() any {
    // 1. 绑定到当前 P，禁止抢占（防止 Get 过程中被调度到另一个 P）
    l, pid := p.pin()
    
    // 2. 从本地 P 的 private 槽取（最快，无需任何同步）
    x := l.private
    l.private = nil
    
    if x == nil {
        // 3. 从本地 P 的 shared 队列头部取（需要轻量锁）
        x, _ = l.shared.popHead()
        
        if x == nil {
            // 4. 从其他 P 的 shared 队列尾部偷取（工作窃取）
            x = p.getSlow(pid)
        }
    }
    
    runtime_procUnpin()  // 解除 P 绑定
    
    if x == nil && p.New != nil {
        // 5. 池为空，调用 New 创建新对象
        x = p.New()
    }
    return x
}

func (p *Pool) getSlow(pid int) any {
    // 先尝试从其他 P 的 shared 队列尾部偷
    for i := 0; i < size; i++ {
        l := indexLocal(locals, (pid+i+1)%size)
        if x, _ := l.shared.popTail(); x != nil {
            return x
        }
    }
    // 再尝试从 victim（上次 GC 保留的旧池）中取
    // ...
    return nil
}
```

### 3.4 sync.Pool 与 GC 的交互

**关键特性**：`sync.Pool` 中的对象在 **GC 时会被清空**。这是有意为之的设计——Pool 只是一个**临时缓存**，而不是永久存储。GC 会定期清空 Pool，防止池中的对象长期占用内存（如果某段时间流量低，池中大量对象会浪费内存）。

**两代 Pool 的设计（Go 1.13 引入）**：直接清空会导致 GC 后每次 Get 都走 New 路径（因为池空了），造成 GC 后短暂的性能抖动（"GC pause 之后的分配风暴"）。Go 1.13 引入了 victim cache：

```
GC 前：local pool（活跃） + victim pool（上一轮 GC 保留的对象）

GC 时：
1. 将 victim pool 中的对象真正释放（GC 回收它们）
2. 将 local pool 降级为新的 victim pool
3. local pool 变为空

GC 后：
- Get 先查 local pool（空），再查 victim pool（有对象可用）
- victim pool 中的对象可以被 Get 取出继续使用（延缓分配风暴）
- 只有两个 GC 周期内都没有被 Get 到的对象才真正被回收
```

这个两代设计让 GC 后的性能更平滑——至少有一个 GC 周期的缓冲时间。

> [!warning] 生产避坑：sync.Pool 的使用规范
> - **不能在 Pool 中存放带状态的对象而不重置**：从 Pool 取出的对象可能是之前使用过的，其字段可能有残留值。**必须在 Put 之前清空对象**（或在 Get 之后初始化），避免数据泄漏（如 buffer 中残留上次请求的数据）；
> - **Pool 不是对象缓存（Cache）**：GC 会清空 Pool，不能依赖 Pool 做持久化存储；
> - **不适合存放需要 Finalizer 的对象**：Pool 中的对象生命周期不确定，Finalizer 可能不能及时触发；
> - **Put 前重置大对象**：如果对象包含大型 slice（如 4MB 的 buffer），Put 时考虑截短（`buf = buf[:cap]` 或重新创建一个小 buffer），防止 Pool 中积累大量大对象占用内存。

---

## 第 4 章 sync/atomic：无锁编程的基础

### 4.1 原子操作是什么，为什么需要它

**原子操作（Atomic Operation）** 是在硬件层面保证不可分割性的操作——在多核 CPU 上，一个原子操作执行过程中，不会被其他 CPU 核的操作中断，其结果对所有核都是立即可见的。

最简单的案例：`counter++` 在 Go 中编译成三条指令（load → add → store），多个 Goroutine 并发执行时会产生数据竞争（写丢失）。而 `atomic.AddInt64(&counter, 1)` 是一条原子指令（x86 的 `LOCK XADD`），保证并发安全且无需锁：

```go
// 数据竞争（错误）
var counter int64
go func() { counter++ }()  // load + add + store，不是原子的
go func() { counter++ }()

// 原子操作（正确）
var counter int64
go func() { atomic.AddInt64(&counter, 1) }()
go func() { atomic.AddInt64(&counter, 1) }()
```

原子操作的代价约 5-10ns，比 Mutex（10-30ns）快约 2-5 倍，是最轻量的并发安全手段。

### 4.2 sync/atomic 提供的操作

Go 1.4 起，`sync/atomic` 提供了以下原子操作（以 `int64` 为例，其他整数类型类似）：

```go
import "sync/atomic"

var v int64

// Load：原子读取
x := atomic.LoadInt64(&v)

// Store：原子写入
atomic.StoreInt64(&v, 42)

// Add：原子加法，返回新值
newVal := atomic.AddInt64(&v, 1)   // +1
atomic.AddInt64(&v, -1)            // -1（减法）

// Swap：原子交换，返回旧值
old := atomic.SwapInt64(&v, 100)

// CompareAndSwap（CAS）：比较后条件交换
// 如果 v == old，则将 v 设为 new，返回 true；否则不修改，返回 false
swapped := atomic.CompareAndSwapInt64(&v, old, new)
```

**Go 1.19 引入的泛型原子类型**（推荐使用）：

```go
// atomic.Value：存储任意类型（但每次 Store 的类型必须一致）
var av atomic.Value
av.Store(map[string]int{"a": 1})
m := av.Load().(map[string]int)

// 泛型版本（Go 1.19+）
var ai atomic.Int64
ai.Store(42)
ai.Add(1)
ai.CompareAndSwap(43, 100)
n := ai.Load()

var ab atomic.Bool
ab.Store(true)
if ab.Load() { ... }

var ap atomic.Pointer[MyStruct]
ap.Store(&MyStruct{})
s := ap.Load()
```

### 4.3 CAS 的使用模式：无锁数据结构的基础

**CAS（Compare-And-Swap）** 是实现无锁算法的核心操作。其典型使用模式是**乐观并发控制（Optimistic Concurrency Control）**：

```go
// 无锁地将一个 int64 更新为 f(oldVal) 的结果
func updateAtomic(v *int64, f func(int64) int64) {
    for {
        old := atomic.LoadInt64(v)
        new := f(old)
        if atomic.CompareAndSwapInt64(v, old, new) {
            return  // 成功：v 在我们读取和写入之间没有被修改
        }
        // 失败：v 已被其他 Goroutine 修改，重试
    }
}

// 使用示例：无锁地实现最大值更新
func updateMax(v *int64, x int64) {
    for {
        old := atomic.LoadInt64(v)
        if x <= old {
            return  // 已经是更大值，无需更新
        }
        if atomic.CompareAndSwapInt64(v, old, x) {
            return
        }
    }
}
```

**CAS 的 ABA 问题**：CAS 检查"值是否与预期相同"，但无法区分"值没变过"和"值变了又变回来了（A→B→A）"。在 Go 中，对于 `int64`、`uint64` 等整数类型，ABA 通常不是问题（因为我们关心的就是当前值）。但对于指针类型，ABA 可能导致错误——例如：指针 p 指向 A，被替换为指向 B，然后又替换回指向 A（但这个新 A 可能已经被回收重用了）。解决方案是在指针旁边附加一个单调递增的版本号（tagged pointer）。

### 4.4 内存序：原子操作的可见性保证

原子操作不只是保证操作本身的原子性，还涉及**内存序（Memory Ordering）**——保证其他内存访问的可见性顺序。

Go 的原子操作遵循**顺序一致性（Sequential Consistency）**：
- 对同一变量的原子操作在所有 Goroutine 看来都是全局有序的；
- 一个原子 Store 操作在另一个 Goroutine 的原子 Load 之前执行，则 Load 能看到 Store 的值。

这比 C++ 的原子操作（可以指定宽松的内存序，如 `relaxed`）更简单但开销更高。Go 的设计选择是：不暴露内存序的复杂性给用户（正确性优先），接受轻微的性能代价。

```go
// Go 的 happens-before 保证：
var x int64
var ready atomic.Bool

// Goroutine 1
x = 42           // 普通写
ready.Store(true) // 原子写：happens before Goroutine 2 的 Load 观测到 true

// Goroutine 2
if ready.Load() {  // 原子读
    fmt.Println(x) // 一定能看到 x=42（由于 happens-before 关系）
}
```

**atomic.Value 的使用场景**：存储和原子替换一个完整的不可变数据结构（如配置对象、路由表快照）：

```go
type Config struct {
    Host    string
    Timeout time.Duration
}

var currentConfig atomic.Value

// 初始化
currentConfig.Store(&Config{Host: "localhost", Timeout: 5 * time.Second})

// 并发读取（无锁）
cfg := currentConfig.Load().(*Config)
fmt.Println(cfg.Host)

// 更新（原子替换整个结构体指针）
newCfg := &Config{Host: "newhost", Timeout: 10 * time.Second}
currentConfig.Store(newCfg)
```

这个模式（copy-on-write + atomic pointer swap）是高并发只读配置访问的标准惯用法——读者不需要任何锁，更新者只需要构造新配置对象并原子替换指针。

---

## 第 5 章 三者的选型决策

### 5.1 并发数据访问的工具选择矩阵

| 场景 | 推荐工具 | 原因 |
| --- | --- | --- |
| 单个数值计数器（read/write）| `atomic.Int64`/`atomic.Uint64` | 最轻量，约 5-10ns |
| 保护复杂共享状态（多字段）| `sync.Mutex` | 正确性高于性能 |
| 读多写少的共享状态 | `sync.RWMutex` | 允许并发读 |
| 读多写极少的 map（key 稳定）| `sync.Map` | 读无锁 |
| 写密集 map | `map + RWMutex` | sync.Map 写性能不如此方案 |
| 频繁 alloc/free 的同类对象 | `sync.Pool` | 减少 GC 压力 |
| 不可变配置的原子替换 | `atomic.Value` / `atomic.Pointer[T]` | 无锁读，写时替换整个对象 |
| 通过通信传递数据所有权 | `channel` | CSP 模型，天然同步 |

### 5.2 sync.Map 与 map+RWMutex 的 benchmark 对比

在实际 benchmark 中（仅供参考，具体数字因环境而异）：

```
场景：8 核 CPU，100% 读操作（无写）
map + RWMutex: ~30ns/op
sync.Map:       ~15ns/op（快约 2 倍，读完全无锁）

场景：8 核 CPU，50% 读 + 50% 写（写多）
map + RWMutex: ~60ns/op
sync.Map:       ~120ns/op（慢约 2 倍，写开销更大）

场景：8 核 CPU，95% 读 + 5% 写（读多写少）
map + RWMutex: ~35ns/op
sync.Map:       ~20ns/op（快约 1.7 倍）
```

结论：写操作比例超过 20-30% 时，`map + RWMutex` 更优；读操作比例超过 80% 或 key 不怎么变动时，`sync.Map` 更优。

---

## 总结

本篇聚焦 `sync` 包中三个高频并发工具的底层机制：

**`sync.Map` 的双 map 设计**：`read` 是原子加载的只读快照（无锁读），`dirty` 是带锁的可写 map。两个 map 共享 `*entry` 指针，更新已存在 key 的值只需原子 CAS `entry.p`，无需任何锁。`misses` 达到 `len(dirty)` 时，`dirty` 被提升为新的 `read`——这使得"频繁读取某些 key"后，这些 key 的读取走无锁快速路径。适合读多写少或 key 稳定的并发 map 场景。

**`sync.Pool` 的 per-P 设计**：每个 P 有独立的 `poolLocal`（private 槽 + shared 双端队列），本地访问完全无锁。Get 按 private → local shared → steal from others → victim → New 的顺序查找。GC 时 pool 被清空但保留 victim 缓存（一代缓冲），平滑 GC 后的分配压力。

**`sync/atomic` 的基础操作**：Load/Store/Add/Swap/CAS 五类原子操作，约 5-10ns，是无锁算法的基石。CAS 的乐观并发控制模式（读-改-CAS 循环）是实现无锁更新的标准范式。`atomic.Value` 和泛型版 `atomic.Pointer[T]` 用于不可变对象的原子替换，是并发只读配置访问的标准方案。

下一篇深入 `context` 包的设计与取消传播机制：[[05 Context 的设计与取消传播机制]]。

---

> [!note] 参考资料
> - Go 源码：`sync/map.go`、`sync/pool.go`、`sync/atomic`
> - Dmitry Vyukov,《sync.Map design document》
> - Go Blog,《Concurrency is not Parallelism》
> - Go 1.13 Release Notes: sync.Pool victim cache
