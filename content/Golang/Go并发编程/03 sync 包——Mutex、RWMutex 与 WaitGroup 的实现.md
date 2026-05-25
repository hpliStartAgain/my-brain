---
title: "sync 包——Mutex、RWMutex 与 WaitGroup 的实现"
date: 2026-03-04
tags: [Golang, Mutex, RWMutex, sync, WaitGroup, 互斥锁, 信号量, 自旋, 读写锁, 饥饿模式]
aliases: []
---

# sync 包——Mutex、RWMutex 与 WaitGroup 的实现

## 摘要

`sync` 包是 Go 并发编程的底层工具箱，提供了互斥锁（`Mutex`）、读写锁（`RWMutex`）、等待组（`WaitGroup`）、条件变量（`Cond`）等原语。这些原语看似简单，但底层实现极为精妙——`Mutex` 不是简单的一把锁，它在 Go 1.9 引入了**正常模式**与**饥饿模式**的双模态设计，在高竞争场景下防止 Goroutine 无限等待；`RWMutex` 通过精心设计的计数器避免写者饥饿；`WaitGroup` 用一个 64 位原子变量同时存储等待计数和信号量。理解这些实现，不仅能让你写出更正确的并发代码，更能在出现死锁或性能问题时快速定位根因。

---

## 第 1 章 互斥锁的基本问题：为什么自旋不够用

### 1.1 自旋锁：简单但有缺陷

最简单的互斥锁实现是**自旋锁（Spinlock）**：未获取到锁时，不断地用 CAS（Compare-And-Swap）操作循环检查锁是否可用：

```go
// 概念性的自旋锁实现
type SpinLock struct {
    locked uint32
}

func (s *SpinLock) Lock() {
    for !atomic.CompareAndSwapUint32(&s.locked, 0, 1) {
        // 忙等待：不断重试
        runtime.Gosched()  // 让出 CPU（防止完全占满）
    }
}

func (s *SpinLock) Unlock() {
    atomic.StoreUint32(&s.locked, 0)
}
```

自旋锁在**锁持有时间极短**（纳秒级）且**竞争不激烈**的场景下效率极高——因为没有 Goroutine 的上下文切换开销。但在以下场景下代价极大：

- **锁持有时间较长**：等待者在 CPU 上空转，浪费大量 CPU 周期（不做任何有意义的计算，只是在检查锁）；
- **高竞争**：多个 Goroutine 同时自旋，CPU 缓存一致性流量激增（每次 CAS 需要独占 cache line）；
- **单 CPU 核心**：持锁的 Goroutine 可能已被调度走，等待者自旋没有任何意义（持锁者不在运行，永远无法释放）。

**理想的锁应该结合两种策略**：先短暂自旋（期望锁很快释放），如果自旋超时仍未获取到锁，则**让 Goroutine 睡眠**（进入等待队列，不占用 CPU），等锁释放时再唤醒。这正是 Go `Mutex` 的核心设计思路。

### 1.2 操作系统信号量：睡眠/唤醒的基础

Go 的 `Mutex` 底层基于**信号量（Semaphore）**实现睡眠/唤醒。信号量是一个非负整数，关联操作：

- `sema_acquire(s)`：如果 `s > 0`，将 `s--` 返回；否则将当前 Goroutine 加入等待队列，让其睡眠；
- `sema_release(s)`：将 `s++`；如果有 Goroutine 在等待，唤醒一个。

Go 运行时提供了 `runtime_SemacquireMutex` 和 `runtime_Semrelease` 两个内部函数，`sync` 包所有的睡眠/唤醒操作都通过它们完成。

---

## 第 2 章 Mutex：正常模式与饥饿模式

### 2.1 Mutex 的内存结构

```go
// sync/mutex.go
type Mutex struct {
    state int32   // 状态位图（包含多个标志位和等待者计数）
    sema  uint32  // 信号量（用于睡眠/唤醒）
}

// state 字段的位布局（32 位）：
// bit 0: mutexLocked    — 是否已被锁定（1=已锁定）
// bit 1: mutexWoken     — 是否有等待者被唤醒（1=已唤醒，防止重复唤醒）
// bit 2: mutexStarving  — 是否处于饥饿模式（1=饥饿模式）
// bit 3-31: mutexWaiterShift — 等待者数量（用 >>3 取出）

const (
    mutexLocked          = 1 << iota  // 1
    mutexWoken                         // 2
    mutexStarving                      // 4
    mutexWaiterShift = iota            // 3（等待者计数从 bit 3 开始）
)
```

一个 `Mutex` 只有 8 字节（`int32` + `uint32`），但通过位操作在这 8 字节中编码了丰富的状态信息——这是 Go 运行时代码中"极致节省内存"风格的典型体现。

### 2.2 Lock：自旋 + 睡眠的双阶段策略

```go
// sync/mutex.go Lock() 的简化流程
func (m *Mutex) Lock() {
    // 快速路径：直接 CAS 将 state 从 0 改为 mutexLocked
    if atomic.CompareAndSwapInt32(&m.state, 0, mutexLocked) {
        return  // 无竞争，直接获取锁，约 5-10ns
    }
    // 慢路径：有竞争，进入复杂的自旋/睡眠逻辑
    m.lockSlow()
}
```

`lockSlow` 的核心逻辑：

```go
func (m *Mutex) lockSlow() {
    var waitStartTime int64
    starving := false    // 当前 goroutine 是否处于饥饿状态
    awoke := false       // 是否从睡眠中被唤醒
    iter := 0           // 自旋次数
    old := m.state
    
    for {
        // 判断是否可以继续自旋：
        // 条件：锁被持有（non-starving）+ 自旋次数未超限 + 多核 CPU
        if old&(mutexLocked|mutexStarving) == mutexLocked && runtime_canSpin(iter) {
            // 标记 mutexWoken，告诉 Unlock 不必唤醒其他等待者
            // （因为当前 goroutine 正在自旋，马上就会拿到锁）
            if !awoke && old&mutexWoken == 0 && old>>mutexWaiterShift != 0 &&
                atomic.CompareAndSwapInt32(&m.state, old, old|mutexWoken) {
                awoke = true
            }
            runtime_doSpin()  // 执行 30 次 PAUSE 指令（降低 CPU 功耗，让超线程友好）
            iter++
            old = m.state
            continue
        }
        
        new := old
        // 非饥饿模式下：尝试加锁
        if old&mutexStarving == 0 {
            new |= mutexLocked
        }
        // 增加等待者计数
        if old&(mutexLocked|mutexStarving) != 0 {
            new += 1 << mutexWaiterShift
        }
        // 如果当前 goroutine 已等待超过 1ms，进入饥饿模式
        if starving && old&mutexLocked != 0 {
            new |= mutexStarving
        }
        
        if atomic.CompareAndSwapInt32(&m.state, old, new) {
            // 如果原来没有锁且不在饥饿模式，成功获取锁
            if old&(mutexLocked|mutexStarving) == 0 {
                break
            }
            // 否则进入睡眠（排队等待），queueLifo 控制队列位置
            queueLifo := waitStartTime != 0
            if waitStartTime == 0 {
                waitStartTime = runtime_nanotime()
            }
            // 睡眠等待信号量（queueLifo=true 时插入队列头部，即饥饿模式下优先唤醒）
            runtime_SemacquireMutex(&m.sema, queueLifo, 1)
            
            // 被唤醒后检查是否进入饥饿状态
            starving = starving || runtime_nanotime()-waitStartTime > starvationThresholdNs
            old = m.state
            
            if old&mutexStarving != 0 {
                // 饥饿模式：直接获取锁（锁已被 Unlock 直接转移给我）
                delta := int32(mutexLocked - 1<<mutexWaiterShift)
                if !starving || old>>mutexWaiterShift == 1 {
                    delta -= mutexStarving  // 最后一个等待者，退出饥饿模式
                }
                atomic.AddInt32(&m.state, delta)
                break
            }
            awoke = true
            iter = 0
        } else {
            old = m.state
        }
    }
}
```

### 2.3 正常模式 vs 饥饿模式：解决 Goroutine 饥饿

这是 Go 1.9 对 `Mutex` 的重大改进，理解它需要先理解**饥饿问题的根源**。

**饥饿问题的产生**（Go 1.8 及之前）：

设想以下场景：
1. Goroutine A 持有锁，正在执行；
2. Goroutine B 在等待队列中睡眠；
3. A 释放锁，`Unlock` 唤醒 B（B 从睡眠中醒来，但不一定立即在 CPU 上运行）；
4. 就在 B 还没有被调度执行时，Goroutine C（新来的，正在 CPU 上运行）发现锁已释放，立即 CAS 抢到了锁；
5. B 被唤醒后发现锁又被占了，只能重新排队睡眠。

步骤 4 中 C 的行为叫**"插队"（barging）**——正在 CPU 上运行的 Goroutine 总是比刚被唤醒的 Goroutine 更有优势，因为被唤醒的 Goroutine 需要等待调度器给它分配 CPU 时间。在高竞争场景下，等待队列中的 Goroutine 可能被反复"插队"，等待时间无上限——这就是饥饿（Starvation）。

**Go 1.9 的解决方案：饥饿模式**

```
正常模式（Normal Mode）：
- 新来的 Goroutine 可以"插队"（尝试自旋抢锁）
- 优先让 CPU 上运行的 Goroutine 获取锁（吞吐量高）
- 但等待队列中的 Goroutine 可能等待较久

触发饥饿模式的条件：
- 某个 Goroutine 在等待队列中等待时间 > 1ms（starvationThresholdNs）

饥饿模式（Starvation Mode）：
- 锁的所有权从 Unlock 的 Goroutine 直接转移给等待队列头部的 Goroutine
- 新来的 Goroutine 不允许自旋，直接加入等待队列尾部
- 保证等待队列中的 Goroutine 按 FIFO 顺序获取锁

退出饥饿模式的条件（满足任一）：
- 当前 Goroutine 的等待时间 < 1ms（说明延迟可接受，恢复高吞吐模式）
- 等待队列已空（没有其他等待者了）
```

这个双模态设计巧妙地平衡了**吞吐量**（正常模式）和**公平性**（饥饿模式）：平时追求高吞吐，只有真的有 Goroutine 等待超过 1ms 时才切换到公平模式，一旦队列清空或等待者都得到了及时响应，再切回高吞吐模式。

### 2.4 Unlock：释放锁与唤醒

```go
func (m *Mutex) Unlock() {
    // 快速路径：清除 mutexLocked 标志
    new := atomic.AddInt32(&m.state, -mutexLocked)
    if new != 0 {
        // 有等待者，进入慢路径
        m.unlockSlow(new)
    }
}

func (m *Mutex) unlockSlow(new int32) {
    if new&mutexStarving == 0 {
        // 正常模式：唤醒一个等待者（如果有）
        // 但如果有自旋的 Goroutine（mutexWoken 标志），不必唤醒
        old := new
        for {
            if old>>mutexWaiterShift == 0 || old&(mutexLocked|mutexWoken|mutexStarving) != 0 {
                return
            }
            new = (old - 1<<mutexWaiterShift) | mutexWoken
            if atomic.CompareAndSwapInt32(&m.state, old, new) {
                runtime_Semrelease(&m.sema, false, 1)
                return
            }
            old = m.state
        }
    } else {
        // 饥饿模式：直接将锁转移给等待队列头部的 Goroutine
        // handoff=true 表示直接传递，不允许其他 Goroutine 插队
        runtime_Semrelease(&m.sema, true, 1)
    }
}
```

> [!warning] 生产避坑：Mutex 的使用禁忌
> - **不能复制已使用的 Mutex**：`Mutex` 内部包含状态，复制后两个锁的状态独立，原锁的等待者永远无法被新锁唤醒。应始终通过指针传递 `Mutex`，或将其嵌入 struct 时不允许该 struct 被复制；
> - **不能递归加锁**：Go 的 `Mutex` 不是可重入锁（同一个 Goroutine 再次 `Lock` 会死锁），这是刻意设计——可重入锁会掩盖设计缺陷；
> - **用 `defer` 确保解锁**：如果函数有多个返回路径，始终用 `defer mu.Unlock()` 紧跟在 `mu.Lock()` 之后，防止遗漏解锁。

---

## 第 3 章 RWMutex：读写锁的实现与写者饥饿问题

### 3.1 读写锁的语义

`Mutex` 对读和写操作同等对待——同一时刻只有一个 Goroutine 能持有锁（无论是读还是写）。但在**读多写少**的场景（如缓存、配置读取），读操作之间并不互斥——允许多个读者并发读取，而写者需要独占访问。

`RWMutex` 实现了以下语义：
- **并发读**：多个 Goroutine 可以同时持有读锁（`RLock`）；
- **写者独占**：写锁（`Lock`）获取后，所有后续的读锁请求和写锁请求都会阻塞；
- **写者优先**：当有写者等待时，新来的读者会阻塞（防止写者饥饿）。

### 3.2 RWMutex 的内存结构

```go
// sync/rwmutex.go（简化）
type RWMutex struct {
    w           Mutex    // 写锁（互斥写）
    writerSem   uint32   // 写者等待的信号量
    readerSem   uint32   // 读者等待的信号量
    readerCount atomic.Int32  // 当前活跃读者数量
                             // 负数时表示有写者持有锁或正在等待
    readerWait  atomic.Int32  // 当写者等待时，还有多少读者未完成
}

const rwmutexMaxReaders = 1 << 30  // 最大并发读者数
```

### 3.3 RLock/RUnlock：读者的快速路径

```go
func (rw *RWMutex) RLock() {
    // 原子地将 readerCount 加 1
    // 如果结果 < 0，说明有写者持有锁或等待，需要阻塞
    if rw.readerCount.Add(1) < 0 {
        // 有写者，睡眠等待
        runtime_SemacquireMutex(&rw.readerSem, false, 0)
    }
}

func (rw *RWMutex) RUnlock() {
    // 原子地将 readerCount 减 1
    if r := rw.readerCount.Add(-1); r < 0 {
        // r < 0 说明有写者在等待（readerCount 被写者减去了 rwmutexMaxReaders）
        rw.rUnlockSlow(r)
    }
}

func (rw *RWMutex) rUnlockSlow(r int32) {
    // 将 readerWait 减 1；如果减到 0，唤醒等待的写者
    if rw.readerWait.Add(-1) == 0 {
        runtime_Semrelease(&rw.writerSem, false, 1)
    }
}
```

### 3.4 Lock/Unlock：写者的独占逻辑与防饥饿

```go
func (rw *RWMutex) Lock() {
    // 1. 先获取内部 Mutex（排队等待其他写者）
    rw.w.Lock()
    
    // 2. 通知读者有写者在等待：将 readerCount 减去 rwmutexMaxReaders（使其变为负数）
    // 之后新来的读者看到 readerCount < 0，会进入睡眠
    r := rw.readerCount.Add(-rwmutexMaxReaders) + rwmutexMaxReaders
    
    // 3. 等待已有的活跃读者完成
    if r != 0 && rw.readerWait.Add(r) != 0 {
        // r 是当前活跃读者数，将其记录到 readerWait
        // 每个读者 RUnlock 时会将 readerWait 减 1
        // 等到 readerWait 变为 0，所有活跃读者都完成了
        runtime_SemacquireMutex(&rw.writerSem, false, 0)
    }
}

func (rw *RWMutex) Unlock() {
    // 1. 恢复 readerCount（加回 rwmutexMaxReaders）
    // 同时允许新的读者进来
    r := rw.readerCount.Add(rwmutexMaxReaders)
    
    // 2. 唤醒所有等待的读者
    for i := 0; i < int(r); i++ {
        runtime_Semrelease(&rw.readerSem, false, 0)
    }
    
    // 3. 释放内部 Mutex，允许其他写者竞争
    rw.w.Unlock()
}
```

**写者防饥饿的关键设计**：当写者调用 `Lock` 后，通过将 `readerCount` 减去 `rwmutexMaxReaders`（使其变为负数），新来的读者看到 `readerCount < 0` 后会立刻阻塞——不再有新读者能绕过等待的写者。写者只需等待**已有的活跃读者**（`readerWait` 减到 0），而不是等待无穷无尽的新读者。

**`readerCount` 的聪明编码**：
- 正常状态（没有写者等待）：`readerCount` = 活跃读者数（0 到 rwmutexMaxReaders）；
- 有写者等待时：`readerCount` = 活跃读者数 - rwmutexMaxReaders（负数）；
- 写者持锁时：`readerCount` = -rwmutexMaxReaders + 活跃读者数（仍为负数，新读者会阻塞）。

用一个字段同时编码两种信息（计数 + 状态），避免了额外的字段和原子操作，是 Go 并发原语代码中高度精炼的设计风格。

---

## 第 4 章 WaitGroup：等待一组 Goroutine 完成

### 4.1 WaitGroup 的使用场景

`WaitGroup` 解决的问题：等待一组并发任务全部完成后再继续。

```go
var wg sync.WaitGroup

for i := 0; i < 10; i++ {
    wg.Add(1)  // 在启动 Goroutine 之前 Add（不能在 goroutine 内部 Add）
    go func(id int) {
        defer wg.Done()  // 任务完成，计数减 1
        processTask(id)
    }(i)
}

wg.Wait()  // 阻塞，直到计数减到 0
fmt.Println("all tasks done")
```

### 4.2 WaitGroup 的内存结构

```go
// sync/waitgroup.go（简化）
type WaitGroup struct {
    noCopy noCopy         // 防止复制（vet 工具可以检测）
    state  atomic.Uint64  // 高 32 位：计数器（Add/Done 操作）
                          // 低 32 位：等待者数量（Wait 的 goroutine 数）
    sema   uint32         // 信号量（用于唤醒 Wait 的 goroutine）
}
```

**用一个 64 位原子变量同时存储两个 32 位计数器**：这样对计数器和等待者数量的变更可以用单个原子操作完成，避免了锁的开销：

```
state 的高 32 位（counter）：Add 时加，Done 时减（Done = Add(-1)）
state 的低 32 位（waiters）：Wait 时加，计数器归零时减
```

### 4.3 Add、Done、Wait 的实现

```go
func (wg *WaitGroup) Add(delta int) {
    state := wg.state.Add(uint64(delta) << 32)  // 修改高 32 位
    v := int32(state >> 32)  // 当前计数器值
    w := uint32(state)       // 当前等待者数量
    
    if v < 0 {
        panic("sync: negative WaitGroup counter")
    }
    if v > 0 || w == 0 {
        return  // 计数器未到 0，或没有等待者，直接返回
    }
    
    // 计数器降到 0，且有等待者：唤醒所有等待者
    wg.state.Store(0)  // 重置 state
    for ; w != 0; w-- {
        runtime_Semrelease(&wg.sema, false, 0)
    }
}

func (wg *WaitGroup) Done() { wg.Add(-1) }

func (wg *WaitGroup) Wait() {
    for {
        state := wg.state.Load()
        v := int32(state >> 32)
        if v == 0 {
            return  // 计数器已为 0，无需等待
        }
        // 将等待者数量加 1（低 32 位 +1），并睡眠
        if wg.state.CompareAndSwap(state, state+1) {
            runtime_SemacquireMutex(&wg.sema, false, 0)
            // 被唤醒后，state 已被 Add 重置为 0
            return
        }
    }
}
```

> [!warning] 生产避坑：WaitGroup 的使用规范
> - **`Add` 必须在 `go` 语句之前调用**：如果在 Goroutine 内部调用 `Add`，可能在 `Wait` 已经执行完（计数器为 0）后才调用 `Add`，导致 `Wait` 提前返回；
> - **不能复制 WaitGroup**：同 Mutex，内含状态，复制会导致信号量状态不一致；
> - **Add 和 Wait 并发使用的竞争窗口**：在循环中对 slice 做 Add 时，`Add` 和 `Wait` 不能并发（否则 Add 和 Wait 的竞争会导致计数器短暂为 0，Wait 提前返回）。正确做法：所有 `Add` 在第一个 `go` 之前完成，或者 `Add(totalCount)` 一次性加完。

---

## 第 5 章 sync.Once 与 sync.Cond

### 5.1 sync.Once：保证只执行一次

`sync.Once` 保证某个函数只被执行一次，典型用于懒初始化（Lazy Initialization）：

```go
var (
    instance *Config
    once     sync.Once
)

func GetConfig() *Config {
    once.Do(func() {
        instance = loadConfig()  // 只会被执行一次，即使并发调用
    })
    return instance
}
```

**实现原理**：

```go
type Once struct {
    done atomic.Uint32  // 是否已执行（0=未执行，1=已执行）
    m    Mutex          // 保护第一次执行的互斥锁
}

func (o *Once) Do(f func()) {
    // 快速路径：已执行过，直接返回
    if o.done.Load() == 1 {
        return
    }
    o.doSlow(f)
}

func (o *Once) doSlow(f func()) {
    o.m.Lock()
    defer o.m.Unlock()
    // 双重检查：防止多个 Goroutine 同时通过快速路径失败后重复执行
    if o.done.Load() == 0 {
        defer o.done.Store(1)  // 先 defer，确保 f panic 时也标记为已执行
        f()
    }
}
```

**关键细节**：`defer o.done.Store(1)` 在 `f()` 之前注册，即使 `f()` panic，`done` 也会被设为 1——后续调用 `Do` 不会重试（防止 panic 的初始化被反复重试）。这是一个经过深思熟虑的设计选择：如果初始化 panic，说明初始化逻辑有 bug，重试通常也会再次 panic，不如快速失败。

### 5.2 sync.Cond：条件变量

`Cond` 是条件变量，用于"等待某个条件成立"的场景，配合 `Mutex` 使用：

```go
type Cond struct {
    L Locker  // 关联的锁（通常是 *Mutex 或 *RWMutex）
    // ...
}

// 典型用法：生产者/消费者
var (
    mu      sync.Mutex
    cond    = sync.NewCond(&mu)
    queue   []int
)

// 消费者
func consumer() {
    mu.Lock()
    for len(queue) == 0 {
        cond.Wait()  // 原子地释放锁 + 睡眠；被唤醒时重新获取锁
    }
    item := queue[0]
    queue = queue[1:]
    mu.Unlock()
    process(item)
}

// 生产者
func producer(item int) {
    mu.Lock()
    queue = append(queue, item)
    cond.Signal()  // 唤醒一个等待者；或用 Broadcast() 唤醒所有
    mu.Unlock()
}
```

**`Wait` 必须在循环中调用**：`Wait` 被唤醒时不能保证条件一定成立（可能是虚假唤醒，或者其他 Goroutine 已经消费了数据），必须重新检查条件。`for len(queue) == 0 { cond.Wait() }` 是标准用法，不能写成 `if len(queue) == 0 { cond.Wait() }`。

> [!note] 设计哲学：sync.Cond 在 Go 中的地位
> 在 Go 中，`sync.Cond` 相对不常用——大多数"等待条件"的场景可以用 Channel 优雅地表达（Channel 本身就是带条件的同步原语）。但在以下场景 `Cond` 比 Channel 更自然：需要广播唤醒所有等待者（Channel close 只能用一次）；需要与已有的 `Mutex` 保护的状态配合（`Wait` 原子地释放锁并睡眠，避免竞争窗口）。

---

## 总结

本篇深入 `sync` 包三个最重要的原语的实现机制：

**Mutex 的双模态设计**：正常模式下允许新 Goroutine 自旋插队（高吞吐），当某个 Goroutine 等待超过 1ms 时切换到饥饿模式（公平 FIFO，防止长期等待）。`state` 字段通过位操作同时编码锁状态、唤醒标志、饥饿标志和等待者计数。

**RWMutex 的计数器设计**：`readerCount` 在正常时是活跃读者数，写者等待时减去 `rwmutexMaxReaders` 使其变为负数，新读者看到负数后阻塞——写者无需等待无限的新读者，只需等待已有的活跃读者（`readerWait`）完成。

**WaitGroup 的高位/低位编码**：`state` 的高 32 位是任务计数器，低 32 位是等待者数量，单个 64 位原子操作同时更新两个计数，避免了额外的锁开销。`Add` 必须在 `go` 之前调用，且不能并发地同时有 `Add` 和 `Wait` 在执行。

**两个要点需要铭记**：Mutex 不可重入（同 Goroutine 再次 Lock 死锁）；任何包含这些原语的 struct 都不应被复制（`go vet` 的 `copylocks` 检查器可以帮助检测）。

下一篇深入 `sync.Map`、`sync.Pool` 与原子操作的实现：[[04 sync.Map、sync.Pool 与原子操作]]。

---

> [!note] 参考资料
> - Go 源码：`sync/mutex.go`、`sync/rwmutex.go`、`sync/waitgroup.go`
> - Dmitry Vyukov,《Scalable Go Scheduler》
> - Go Blog,《Introducing the Go Race Detector》: https://go.dev/blog/race-detector
> - Russ Cox,《sync.Mutex, sync.RWMutex 设计演进》

---

> [!note] 思考题
> 1. `sync.Mutex` 在 Go 中经历了从'简单自旋'到'饥饿模式'的演进。当一个 goroutine 等待锁超过 1ms 时，Mutex 会切换到饥饿模式——新到达的 goroutine 不再尝试获取锁，而是直接排队。这种设计解决了什么问题？如果所有锁请求的持有时间都很短（< 100μs），饥饿模式会被触发吗？
> 2. `sync.RWMutex` 允许多个读者并发，但写者独占。当一个写者在等待锁时，后到的读者是否会被阻塞（即写者优先），还是读者可以'插队'？Go 的 RWMutex 实现中，这个设计选择的原因是什么？与 Java 的 `ReentrantReadWriteLock` 的公平策略有什么区别？
> 3. `sync.WaitGroup` 的 `Add()` 和 `Done()` 内部使用原子操作维护计数器。如果在启动 goroutine 之前忘记调用 `Add()`，而是在 goroutine 内部第一行调用 `Add(1)`，可能发生什么竞态问题？`WaitGroup` 可以被复用（Wait 返回后再次 Add）吗？
