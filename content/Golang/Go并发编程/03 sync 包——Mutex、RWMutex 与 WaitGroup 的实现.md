---
title: "sync 包——Mutex、RWMutex 与 WaitGroup 的实现"
date: 2026-03-04
tags: [Golang, Mutex, RWMutex, sync, WaitGroup, 互斥锁, 信号量, 自旋, 读写锁, 饥饿模式]
aliases: []
---

# sync 包——Mutex、RWMutex 与 WaitGroup 的实现

**摘要：**

`sync` 包是 Go 并发编程的底层工具箱，提供了互斥锁（`Mutex`）、读写锁（`RWMutex`）、等待组（`WaitGroup`）、条件变量（`Cond`）等原语。这些原语看似简单，但底层实现极为精妙——`Mutex` 不是简单的一把锁，它在 Go 1.9 引入了**正常模式**与**饥饿模式**的双模态设计，在高竞争场景下防止 Goroutine 无限等待；`RWMutex` 通过精心设计的计数器避免写者饥饿；`WaitGroup` 用一个 64 位原子变量同时存储等待计数和信号量。理解这些实现，不仅能让你写出更正确的并发代码，更能在出现死锁或性能问题时快速定位根因。文章最后回到一个设计认知：Go 的 sync 原语体现了"用复杂性换公平性"的工程哲学——简单的自旋锁够用但可能饥饿，Go 选择用双模态、计数器编码等复杂性换取"高吞吐 + 防饥饿"的双重保证，这是生产级并发原语的典型设计。

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

自旋锁的根本问题是"用 CPU 换等待"——如果锁很快释放，自旋比睡眠高效（省了上下文切换）；如果锁很久不释放，自旋就是纯浪费（占着 CPU 不做事）。因此自旋锁只适合"锁持有时间确定且极短"的场景，如内核内部的短临界区。应用层的锁持有时间通常不确定，纯自旋锁不合适。

**理想的锁应该结合两种策略**：先短暂自旋（期望锁很快释放），如果自旋超时仍未获取到锁，则**让 Goroutine 睡眠**（进入等待队列，不占用 CPU），等锁释放时再唤醒。这正是 Go `Mutex` 的核心设计思路——"先自旋后睡眠"的双阶段策略，兼顾了"短锁的高效"和"长锁的不浪费 CPU"。

### 1.2 操作系统信号量：睡眠/唤醒的基础

Go 的 `Mutex` 底层基于**信号量（Semaphore）**实现睡眠/唤醒。信号量是一个非负整数，关联操作：

- `sema_acquire(s)`：如果 `s > 0`，将 `s--` 返回；否则将当前 Goroutine 加入等待队列，让其睡眠；
- `sema_release(s)`：将 `s++`；如果有 Goroutine 在等待，唤醒一个。

Go 运行时提供了 `runtime_SemacquireMutex` 和 `runtime_Semrelease` 两个内部函数，`sync` 包所有的睡眠/唤醒操作都通过它们完成。信号量是操作系统提供的同步原语（Linux 上基于 futex 实现），它让"睡眠等待"不需要忙轮询——Goroutine 睡眠后不占 CPU，被唤醒时再继续执行。这个"睡眠/唤醒"机制是 Mutex 比 Spinlock 复杂但更通用的基础。

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

一个 `Mutex` 只有 8 字节（`int32` + `uint32`），但通过位操作在这 8 字节中编码了丰富的状态信息——这是 Go 运行时代码中"极致节省内存"风格的典型体现。`state` 的 32 位被分为四个字段：锁定标志（1 位）、唤醒标志（1 位）、饥饿标志（1 位）、等待者计数（29 位）。这个"位图编码"让一次原子操作就能同时更新多个字段，避免了多字段更新的锁开销。

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

这个 `lockSlow` 的逻辑相当复杂，但核心是"自旋 + 睡眠"的双阶段策略：
1. **自旋阶段**：如果锁被持有但不在饥饿模式，且自旋次数未超限，执行 `runtime_doSpin()`（PAUSE 指令）短暂自旋——期望锁很快释放；
2. **睡眠阶段**：自旋超时后，将等待者计数加 1，调用 `runtime_SemacquireMutex` 睡眠等待；
3. **唤醒后**：检查等待时间是否超过 1ms，如果是则进入饥饿模式。

`runtime_doSpin()` 执行的是 CPU 的 PAUSE 指令——它不停止 CPU，但告诉 CPU"我在等锁，可以降低流水线优先级"，让超线程（Hyper-Threading）的另一个逻辑核获得更多执行资源。这个"PAUSE 而非纯忙等"的优化让自旋对超线程友好。

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

这个"插队"行为在低竞争场景下是好事——它让 CPU 上运行的 Goroutine 立即获取锁，避免了唤醒等待者的上下文切换开销，提升了吞吐量。但在高竞争场景下，它让等待队列中的 Goroutine 永远抢不到锁，导致饥饿。这是"吞吐量 vs 公平性"的经典矛盾。

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

这个双模态设计巧妙地平衡了**吞吐量**（正常模式）和**公平性**（饥饿模式）：平时追求高吞吐，只有真的有 Goroutine 等待超过 1ms 时才切换到公平模式，一旦队列清空或等待者都得到了及时响应，再切回高吞吐模式。1ms 的阈值是经验值——足够长以避免误判（正常锁等待通常 < 1ms），又足够短以防止严重饥饿。

饥饿模式的"锁所有权直接转移"是关键——Unlock 时不让新来的 Goroutine 抢锁，而是直接通过信号量将锁交给等待队列头部的 Goroutine。这个"handoff"机制保证了 FIFO 公平性，但代价是"新来的 Goroutine 必须睡眠排队"，吞吐量降低。这是"公平性换吞吐量"的取舍——在饥饿场景下，公平性比吞吐量更重要。

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

正常模式下 Unlock 的"如果有自旋的 Goroutine 就不唤醒"是一个优化——如果有 Goroutine 正在自旋（`mutexWoken` 标志），它马上就会拿到锁，不需要再唤醒一个睡眠的等待者（省了一次唤醒开销）。这个"自旋者优先"的优化让"短锁 + 有自旋者"的场景避免了不必要的唤醒。

> [!warning] 生产避坑：Mutex 的使用禁忌
> - **不能复制已使用的 Mutex**：`Mutex` 内部包含状态，复制后两个锁的状态独立，原锁的等待者永远无法被新锁唤醒。应始终通过指针传递 `Mutex`，或将其嵌入 struct 时不允许该 struct 被复制；
> - **不能递归加锁**：Go 的 `Mutex` 不是可重入锁（同一个 Goroutine 再次 `Lock` 会死锁），这是刻意设计——可重入锁会掩盖设计缺陷；
> - **用 `defer` 确保解锁**：如果函数有多个返回路径，始终用 `defer mu.Unlock()` 紧跟在 `mu.Lock()` 之后，防止遗漏解锁。

"Mutex 不可重入"是 Go 的刻意设计——可重入锁（如 Java 的 ReentrantLock）允许同一线程多次获取锁，但会掩盖"同一个 Goroutine 在不同代码路径重复加锁"的设计缺陷。Go 选择"不可重入 + 重复加锁即死锁"，让设计缺陷立即暴露而非被掩盖。这反映了 Go"让错误早暴露"的哲学。

---

## 第 3 章 RWMutex：读写锁的实现与写者饥饿问题

### 3.1 读写锁的语义

`Mutex` 对读和写操作同等对待——同一时刻只有一个 Goroutine 能持有锁（无论是读还是写）。但在**读多写少**的场景（如缓存、配置读取），读操作之间并不互斥——允许多个读者并发读取，而写者需要独占访问。

`RWMutex` 实现了以下语义：
- **并发读**：多个 Goroutine 可以同时持有读锁（`RLock`）；
- **写者独占**：写锁（`Lock`）获取后，所有后续的读锁请求和写锁请求都会阻塞；
- **写者优先**：当有写者等待时，新来的读者会阻塞（防止写者饥饿）。

读写锁的核心价值是"读并发"——在读多写少的场景下，多个读者可以并发读取，大幅提升吞吐量。但读写锁的实现比 Mutex 复杂——需要区分"读者计数"和"写者状态"，还要防止"写者饥饿"（如果读者源源不断，写者永远等不到锁）。

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

RWMutex 用四个字段实现读写锁——`w` 是写者之间的互斥锁，`writerSem`/`readerSem` 是写者/读者的睡眠信号量，`readerCount`/`readerWait` 是读者计数。这个设计比 Mutex 复杂，因为需要同时管理"读者并发"和"写者独占"两种模式。

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

读者的快速路径很简单——`readerCount` 加 1，如果结果为正（没有写者），直接返回（并发读）。只有当 `readerCount` 为负（有写者等待）时才睡眠。这个"原子加 + 条件睡眠"的设计让无写者场景下的读锁开销极低（一次原子操作）。

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

这个"减去 rwmutexMaxReaders 使 readerCount 变负"的技巧是 RWMutex 防写者饥饿的核心——它让"有写者等待"这个状态用一个原子操作就传播给所有新读者，新读者看到负数立即阻塞，不会继续增加读者数量。如果没有这个设计，源源不断的新读者会让写者永远等不到锁（写者饥饿）。

**`readerCount` 的聪明编码**：
- 正常状态（没有写者等待）：`readerCount` = 活跃读者数（0 到 rwmutexMaxReaders）；
- 有写者等待时：`readerCount` = 活跃读者数 - rwmutexMaxReaders（负数）；
- 写者持锁时：`readerCount` = -rwmutexMaxReaders + 活跃读者数（仍为负数，新读者会阻塞）。

用一个字段同时编码两种信息（计数 + 状态），避免了额外的字段和原子操作，是 Go 并发原语代码中高度精炼的设计风格。这个"一字段双用途"的技巧在 Mutex 的 `state` 字段中也出现过——Go 运行时倾向于用位操作把多个状态压缩到一个字段，减少原子操作次数。

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

WaitGroup 是 Go 中"等待一组 Goroutine 完成"的标准工具——它比"用 Channel 计数"更简洁，比"用 Mutex + 计数器 + Cond"更高效。WaitGroup 的典型场景是"fan-out"——启动多个 Goroutine 并行处理，主 Goroutine 等待所有 Goroutine 完成后汇总结果。

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

这个"高 32 位计数 + 低 32 位等待者"的编码让 Add 和 Wait 的并发安全检查可以用一次原子操作完成——如果计数器归零且有等待者，Add 可以在一个原子操作中同时"重置 state"和"准备唤醒"。如果用两个独立的 32 位变量，需要两次原子操作，中间可能有其他操作插入，导致竞态。

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

Wait 的"CAS + 睡眠"循环是为了处理"Add 和 Wait 并发"的竞态——如果 Wait 检查到计数器 > 0，准备睡眠时，Add 恰好把计数器减到 0，Wait 就会错过唤醒。CAS 保证了"检查计数器 + 增加等待者"是原子的，要么在 Add 减到 0 之前成功增加等待者（之后会被唤醒），要么在 Add 减到 0 之后看到计数器为 0（直接返回）。

> [!warning] 生产避坑：WaitGroup 的使用规范
> - **`Add` 必须在 `go` 语句之前调用**：如果在 Goroutine 内部调用 `Add`，可能在 `Wait` 已经执行完（计数器为 0）后才调用 `Add`，导致 `Wait` 提前返回；
> - **不能复制 WaitGroup**：同 Mutex，内含状态，复制会导致信号量状态不一致；
> - **Add 和 Wait 并发使用的竞争窗口**：在循环中对 slice 做 Add 时，`Add` 和 `Wait` 不能并发（否则 Add 和 Wait 的竞争会导致计数器短暂为 0，Wait 提前返回）。正确做法：所有 `Add` 在第一个 `go` 之前完成，或者 `Add(totalCount)` 一次性加完。

"Add 必须在 go 之前"是 WaitGroup 最常见的误用——如果 `Add` 在 Goroutine 内部，主 Goroutine 的 `Wait` 可能在任何 Goroutine 的 `Add` 执行之前就检查到计数器为 0 并返回。这个误用导致的 bug 很隐蔽——在低并发时可能正常（Goroutine 启动快），高并发时才暴露。

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

`sync.Once` 的"双重检查 + 原子标志"是懒初始化的经典模式——快速路径用原子读（无锁），慢速路径用互斥锁保证只执行一次。这个模式在 Java 的双重检查锁（Double-Checked Locking）中也出现，但 Go 的实现更简洁——`atomic.Uint32` 的 `Load` 是无锁的，`Mutex` 只在第一次执行时加锁。

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

"虚假唤醒"（Spurious Wakeup）是条件变量的已知行为——`Wait` 可能在没有 `Signal`/`Broadcast` 的情况下返回。这不是 bug，而是操作系统信号量的实现细节（某些架构上信号量唤醒可能不精确）。用 `for` 循环检查条件可以正确处理虚假唤醒——即使被虚假唤醒，条件不成立时会再次 `Wait`。

> [!note] 设计哲学：sync.Cond 在 Go 中的地位
> 在 Go 中，`sync.Cond` 相对不常用——大多数"等待条件"的场景可以用 Channel 优雅地表达（Channel 本身就是带条件的同步原语）。但在以下场景 `Cond` 比 Channel 更自然：需要广播唤醒所有等待者（Channel close 只能用一次）；需要与已有的 `Mutex` 保护的状态配合（`Wait` 原子地释放锁并睡眠，避免竞争窗口）。

---

## 第 6 章 sync 原语的设计认知

### 6.1 用复杂性换公平性

Go 的 sync 原语体现了"用复杂性换公平性"的工程哲学——简单的自旋锁够用但可能饥饿，Go 选择用双模态（Mutex）、计数器编码（RWMutex）、高位低位合并（WaitGroup）等复杂性换取"高吞吐 + 防饥饿"的双重保证。这个"用复杂性换公平性"是生产级并发原语的典型设计——学术级的简单原语（如纯自旋锁）在生产环境中不够用，需要额外的机制保证公平性和防饥饿。

### 6.2 位操作压缩状态

Go 的 sync 原语大量使用"位操作压缩状态"——Mutex 的 `state` 用 32 位编码四个字段，RWMutex 的 `readerCount` 用正负编码两种状态，WaitGroup 的 `state` 用高 32 位/低 32 位编码两个计数。这个"位压缩"让多个状态字段可以用一次原子操作更新，避免了多字段更新的锁开销。这是 Go 运行时"极致节省内存 + 减少原子操作"风格的体现。

### 6.3 快速路径 + 慢速路径

所有 Go sync 原语都采用"快速路径 + 慢速路径"的设计——快速路径用原子操作处理无竞争场景（极快），慢速路径用锁/信号量处理有竞争场景（正确但慢）。这个设计让无竞争场景下的开销极低（一次原子操作），只有有竞争时才付出更复杂的逻辑代价。这是高并发原语的通用优化模式——大多数情况下无竞争，快速路径让常见情况极快。

### 6.4 与其他语言同步原语的对比

Go 的 sync 原语与其他语言的同步原语有显著差异，理解这些差异有助于理解 Go sync 的设计取向：

| 语言 | 互斥锁 | 读写锁 | 等待机制 | 可重入 |
| --- | --- | --- | --- | --- |
| Go | sync.Mutex（双模态） | sync.RWMutex（写者优先） | sync.WaitGroup | 不可重入 |
| Java | ReentrantLock（公平/非公平） | ReentrantReadWriteLock | CountDownLatch/CyclicBarrier | 可重入 |
| C++ | std::mutex | std::shared_mutex | std::latch/std::barrier | 不可重入 |
| Rust | std::sync::Mutex | std::sync::RwLock | std::sync::Barrier | 不可重入 |
| Python | threading.Lock | 无内置 | threading.Barrier | 不可重入 |

**与 Java ReentrantLock 的对比**：Java 的 ReentrantLock 支持公平/非公平两种模式，且可重入（同一线程可多次 lock，需对应次数 unlock）。Go 的 Mutex 不可重入（同 Goroutine 再次 Lock 死锁），且只有一种模式（双模态自动切换）。这个差异反映了两种语言的设计哲学——Java 提供灵活的配置选项，Go 选择"一种合理默认"简化使用。

**与 C++ std::mutex 的对比**：C++ 的 std::mutex 不可重入，与 Go Mutex 类似。但 C++ 的 std::mutex 没有饥饿模式（纯 FIFO 或无序竞争，取决于实现），而 Go Mutex 有双模态切换。这个差异让 Go Mutex 在"高吞吐"和"防饥饿"之间自适应平衡，而 C++ std::mutex 需要开发者自行选择策略。

**与 Rust std::sync::Mutex 的对比**：Rust 的 Mutex 不可重入，且通过所有权系统保证"lock 不会忘记 unlock"（RAII 模式，lock 返回的 guard 在 drop 时自动 unlock）。Go 的 Mutex 需要开发者手动 defer Unlock，容易遗漏。这个差异反映了两种语言的安全策略——Rust 用类型系统防错，Go 用惯例和 defer。

这个"与其他语言对比"展示了 Go sync 原语的定位——比 Java 简单（一种默认），比 C++ 智能（双模态自适应），比 Rust 灵活但安全性稍低（无所有权保护）。Go sync 原语在"性能 + 公平性 + 简洁性"三个维度取得了良好平衡，这是 Go 并发编程受欢迎的原因。理解这个对比有助于在技术选型时选择合适的同步原语。

### 6.5 高频面试题

**Q1：Mutex 的饥饿模式何时触发？触发后有什么变化？**

饥饿模式在某个 Goroutine 等待锁超过 1ms 时触发。触发后：新到达的 Goroutine 不再尝试自旋插队，而是直接排到队列尾部；锁的移交改为 FIFO 顺序（先到先得）；等待 Goroutine 获得锁后直接退出饥饿模式（如果队列中还有等待者则保持饥饿模式）。这个设计解决了"长等待 Goroutine 被不断插队导致饥饿"的问题。如果所有锁请求的持有时间都很短（< 100μs），等待者很难超过 1ms 阈值，饥饿模式基本不会触发——正常模式的高吞吐优势得以保持。

**Q2：为什么 Go Mutex 不可重入？同 Goroutine 再次 Lock 会怎样？**

同 Goroutine 再次 Lock 会死锁——第二次 Lock 会阻塞等待第一次 Lock 释放，但第一次 Lock 的释放需要该 Goroutine 继续执行，而该 Goroutine 已经阻塞在第二次 Lock 上，形成循环等待。Go 选择不可重入的原因：可重入锁需要记录"锁的持有者"（通常是 Goroutine ID），但 Go 没有 Goroutine ID 的公开 API（goid 是内部字段）；可重入锁容易掩盖设计问题（"为什么同 Goroutine 需要两次锁"通常是代码结构问题）；可重入锁的实现复杂度更高。Go 的建议是"重构代码避免重入"——将需要重入的逻辑拆分到不同的函数，或用更细粒度的锁。

**Q3：RWMutex 的"写者优先"如何实现？新读者为什么会阻塞？**

写者等待时，`readerCount` 减去 `rwmutexMaxReaders`（1<<30）使其变为负数。新读者调用 RLock 时，`atomic.AddInt32(&rw.readerCount, 1)` 后检查 `readerCount < 0`，如果是负数则调用 `runtime_Semacquire` 阻塞自己。这个"减大数使计数变负"的技巧让新读者无需额外标志位就能感知"有写者在等待"。写者获得锁后，`readerCount` 加回 `rwmutexMaxReaders` 恢复为正数，被阻塞的读者在写者 Unlock 后被唤醒。这个设计防止了"无限新读者让写者饥饿"的问题。

**Q4：WaitGroup 的 Add/Done/Wait 有什么使用陷阱？**

陷阱一：Add 必须在 go 之前调用。如果在 goroutine 内部第一行调用 `Add(1)`，可能 Wait 已经返回（因为 Add 还没执行，计数器为 0）。正确做法是 `wg.Add(1); go func() { defer wg.Done(); ... }()`。陷阱二：Add 的参数不能为负数导致计数器小于 0，否则 panic。陷阱三：Wait 返回后可以再次 Add（复用 WaitGroup），但不能并发地同时有 Add 和 Wait 在执行——会导致竞态。陷阱四：Done 是 Add(-1) 的简写，必须与 Add 的正数对应，否则计数器失衡。

**Q5：sync.Once 的实现原理是什么？为什么需要双重检查？**

sync.Once 用一个 Mutex 和一个 done 标志实现。Do 函数先原子检查 done 是否为 1（快速路径，无锁），如果是则直接返回；如果不是则加锁，再次检查 done（慢速路径，防止多个 Goroutine 同时通过第一次检查），如果仍为 0 则执行 f 并设置 done 为 1。这个"双重检查"避免了"多个 Goroutine 同时通过第一次检查后都执行 f"的问题。done 用 atomic.Load/Store 而非普通读写，保证可见性。Mutex 只在第一次执行时加锁，后续调用走无锁快速路径，性能开销极低。

**Q6：sync.Cond 的使用场景是什么？为什么不用 Channel？**

sync.Cond 适合"多个 Goroutine 等待某个条件成立"的场景——如生产者-消费者模型中，多个消费者等待队列非空。Cond 的 Wait 会释放锁并阻塞，被 Signal/Broadcast 唤醒后重新获取锁。相比 Channel，Cond 的优势：可以检查复杂条件（Channel 只能检查"有数据"）；Broadcast 可以唤醒所有等待者（Channel 的 close 也能广播，但只能一次性）；Cond 与 Mutex 配合更自然（Channel 自带同步语义）。劣势：Cond 的接口更底层，容易误用（如忘记在循环中检查条件）；Channel 的语义更清晰，Go 社区更推荐 Channel。

**Q7：copylocks 检查器检测什么？为什么 sync 原语不能被复制？**

copylocks 检测"包含 sync 原语的 struct 被复制"的情况——如 `func f(m Mutex) {}`（Mutex 作为值参数）、`s := *m`（解引用复制）、`m2 := m`（赋值复制）。sync 原语不能被复制因为：复制会复制锁的状态（如 state 字段），导致原锁和副本的状态不一致；复制后两个锁是独立的，无法互斥；WaitGroup 复制后计数器分裂，Add/Done/Wait 在不同副本上失效。正确做法是用指针 `*Mutex` 或将 struct 放在指针后面。

**Q8：Mutex vs RWMutex 如何选择？RWMutex 一定比 Mutex 快吗？**

选择依据：写多读少用 Mutex（RWMutex 的读写锁管理开销大于 Mutex）；读多写少且临界区较长用 RWMutex（并发读提升吞吐量）；读多写少但临界区很短用 Mutex（RWMutex 的原子操作开销可能超过并发读的收益）。RWMutex 不一定比 Mutex 快——RWMutex 的 RLock 需要 atomic.Add 和条件检查，开销约 20-50ns，而 Mutex 的 Lock 在无竞争时约 20ns。如果临界区只有几纳秒，RWMutex 的锁管理开销可能超过并发读的收益。实测建议：用 benchmark 在实际场景下比较两者。

**Q9：锁竞争严重时如何优化？**

优化策略：减少临界区（只保护真正需要互斥的代码）；读写分离（用 RWMutex 替代 Mutex）；分片锁（将一个锁拆成多个，如 sync.Map 的分段锁）；无锁数据结构（用 atomic 操作替代锁）；Channel 替代锁（用 CSP 模型避免共享状态）；sync.Pool 减少分配（减少 GC 压力间接减少锁竞争）。诊断工具：`go tool pprof -contention` 分析锁竞争热点；`go tool trace` 查看阻塞时间线；`runtime.NumGoroutine` 监控 Goroutine 数量。

**Q10：如何排查死锁？**

排查方法：`go test -race` 检测竞态（部分死锁能被发现）；`pprof goroutine` 查看所有 Goroutine 的栈（死锁的 Goroutine 会显示在 chan receive/mutex 等状态）；`runtime.Stack` 打印所有 Goroutine 栈；`kill -SIGQUIT` 触发 Go 运行时自动打印所有 Goroutine 栈（调试死锁的终极手段）。常见死锁模式：锁顺序不一致（A 锁 B，B 锁 A）；Mutex 不可重入导致的自死锁；Channel 收发不匹配导致的阻塞死锁；WaitGroup 的 Add/Done 不平衡导致的永久等待。

**Q11：Mutex 的 state 字段如何用 32 位编码四个信息？**

state 是 int32，按位编码：最低 1 位是 locked（锁是否被持有）；第 2 位是 woken（是否有 Goroutine 被唤醒准备抢锁）；第 3 位是 starving（是否处于饥饿模式）；高 29 位是 waiter count（等待者数量）。这种"位编码"让一次 CAS 原子操作就能同时更新多个字段，避免了多字段更新的锁开销。例如 Lock 时用 `atomic.CompareAndSwapInt32(&m.state, 0, mutexLocked)` 一次操作就设置了 locked 位；Unlock 时用 `atomic.AddInt32(&m.state, -mutexLocked)` 清除 locked 位并检查 waiter count 决定是否唤醒等待者。

**Q12：Mutex 的自旋条件是什么？为什么不是所有情况都自旋？**

自旋条件：GOMAXPROCS > 1（多核机器，自旋才有意义）；当前 P 上没有其他 G 可运行（自旋不浪费 CPU）；机器类型为 CPU 密集型（`proc.go` 中的 `canSpin` 函数判断）。不所有情况自旋的原因：单核机器自旋会浪费 CPU（自旋的 Goroutine 占用唯一的 CPU，被等待的 Goroutine 永远没机会释放锁）；有其他 G 可运行时自旋会延迟其他 G 的调度；I/O 密集型场景自旋收益低（锁持有者可能在等 I/O，自旋期间不会释放锁）。自旋次数上限约 4 次，超过后转为阻塞。

**Q13：sync.Once 的 done 为什么用 atomic 而非 Mutex 保护？**

done 用 atomic.LoadInt32 读取，避免每次 Do 调用都加锁。如果用 Mutex 保护 done，每次 Do 都要 Lock/Unlock，即使 f 已经执行过——这会让 Once 的"快速路径"变成"慢速路径"。用 atomic 后，已执行的 Do 只需一次原子读（约 1ns），未执行的 Do 才加锁执行 f。这个"atomic 快速路径 + Mutex 慢速路径"的设计让 Once 在"初始化已完成"的常见场景下几乎零开销。这也是 Go sync 原语"快速路径 + 慢速路径"设计模式的典型应用。

**Q14：WaitGroup 的 state 高 32 位和低 32 位分别是什么？为什么用一次原子操作更新？**

state 是 uint64，高 32 位是 counter（任务计数器，Add 改变），低 32 位是 waiter count（等待者数量，Wait 改变）。用一次 64 位原子操作更新两个字段，保证"counter 和 waiter 的变更"是原子的——避免"Add 增加 counter 时，Wait 正在检查 counter==0"的竞态。如果用两个独立的 32 位原子操作，两次操作之间可能被其他 Goroutine 插入，导致状态不一致。这个"64 位编码两个字段"是 Go sync 原语"位操作压缩状态"的典型设计。

**Q15：Mutex 的 Unlock 能否被不同 Goroutine 调用？**

可以——Go 的 Mutex 不记录"锁的持有者"，任何 Goroutine 都可以 Unlock。但这不是推荐用法——Lock 和 Unlock 应该在同一个 Goroutine 的代码块内配对（通常用 `defer m.Unlock()`），否则容易导致"锁的归属不清"和"忘记 Unlock"。如果确实需要"一个 Goroutine Lock，另一个 Goroutine Unlock"（如异步任务移交），应该用 Channel 或其他机制明确传递"锁的归属"，而非依赖 Mutex 的灵活性。

**Q16：RWMutex 的 RLock 可以嵌套调用吗？**

不可以——Go 的 RWMutex 不记录"读者的重入次数"，同 Goroutine 再次 RLock 会死锁（第二次 RLock 阻塞等待第一次 RUnlock，但第一次 RUnlock 需要该 Goroutine 继续执行，而该 Goroutine 已阻塞在第二次 RLock）。Java 的 ReentrantReadWriteLock 支持重入（记录重入次数），但 Go 选择不支持——重入会增加实现复杂度，且容易掩盖设计问题。如果需要"嵌套读"，应该重构代码避免重入，或用其他机制（如将数据拷贝出来后释放锁，再操作拷贝）。

**Q17：sync.Cond 的 Wait 为什么必须在循环中调用？**

Cond.Wait 的正确用法是 `for !condition { cond.Wait() }` 而非 `if !condition { cond.Wait() }`。原因：Wait 被唤醒后，条件可能已经被其他 Goroutine 改变（如多个消费者竞争同一个条件，一个消费者处理了数据，其他消费者醒来时数据已被消费）——这就是"虚假唤醒"（spurious wakeup）。用 for 循环可以在唤醒后重新检查条件，避免在条件不满足时继续执行。用 if 则会在唤醒后直接执行，可能在不满足条件时操作导致错误。这是 Cond 的经典陷阱，Go 文档明确要求"在循环中调用 Wait"。

**Q18：Mutex 的 Lock 和 Unlock 之间能否有 defer？**

可以且推荐——`m.Lock(); defer m.Unlock()` 是标准用法。defer 保证 Unlock 在函数返回时执行（即使 panic），避免忘记 Unlock 导致死锁。但要注意：defer 的开销约 50-100ns（比直接调用慢），在极高频锁场景可能影响性能——可以用 `m.Lock(); ...; m.Unlock()` 直接调用优化。另外，defer 的作用域是整个函数，如果临界区只占函数一小部分，defer 会让锁持有时间变长——可以用匿名函数缩小作用域：`func() { m.Lock(); defer m.Unlock(); ... }()`。

**Q19：sync.Once 的 Do 函数如果 panic 会怎样？**

如果 Do 的 f 函数 panic，Do 不会将 done 设为 1——后续调用 Do 会再次执行 f。这意味着 Once 不保证"恰好执行一次"，而是保证"成功执行一次"或"直到成功为止"。如果 f 可能 panic 且不希望重试，需要在 f 内部 recover 并处理错误。这个设计的原因：如果 panic 后标记 done，后续调用会认为"已初始化"但实际未成功，导致使用未初始化的状态。Go 选择"panic 后不标记 done"让 Once 更安全——失败后可以重试。

**Q20：Mutex 的饥饿模式下，自旋还会发生吗？**

不会——饥饿模式下，新到达的 Goroutine 不尝试自旋，直接排入等待队列。原因：饥饿模式表示"有 Goroutine 等待超过 1ms"，自旋会让新 Goroutine 抢锁，进一步延长等待者的等待时间。饥饿模式的目标是"让等待者尽快获得锁"，自旋与这个目标冲突。正常模式下自旋是为了"高吞吐"（新 Goroutine 快速获得锁），饥饿模式下放弃自旋是为了"公平性"（等待者优先）。这个"自旋 vs 排队"的切换是 Mutex 双模态设计的核心。

**Q21：RWMutex 的写者如何等待已有读者完成？**

写者调用 Lock 时，将 `readerCount` 减去 `rwmutexMaxReaders`（1<<30）使其变为负数，新读者看到负数后阻塞。但此时已有活跃读者仍在读，写者需要等待它们完成。写者将"剩余活跃读者数"存入 `readerWait`（`readerCount + rwmutexMaxReaders`，即减去大数后的正值部分）。每个读者 RUnlock 时检查 `readerWait`，如果大于 0 则原子减 1，减到 0 时唤醒写者。这个"写者等待已有读者完成"的机制是 RWMutex 的核心——写者不阻塞新读者（新读者看到负数自己阻塞），只等待已有读者（通过 readerWait 倒计时）。

**Q22：WaitGroup 的 Wait 如何知道所有任务完成？**

Wait 的实现：原子读取 state，如果 counter（高 32 位）大于 0，则将 waiter count（低 32 位）加 1（用 CAS 循环保证原子性），然后调用 `runtime_Semacquire` 阻塞自己。Add(-1)（即 Done）使 counter 减 1，当 counter 减到 0 时，检查 waiter count 是否大于 0，如果是则调用 `runtime_Semrelease` 唤醒所有等待者。Wait 被唤醒后重新检查 counter（防止虚假唤醒），如果仍为 0 则返回。这个"counter==0 时唤醒所有 waiter"的机制是 WaitGroup 的核心——Add/Done 改变 counter，Wait 等待 counter 变 0。

**Q23：Mutex 的正常模式和饥饿模式如何切换？**

正常模式转饥饿模式：Unlock 时检查当前 Goroutine 的等待时间是否超过 1ms（starving 标志），如果是则将 state 的 starving 位置 1，进入饥饿模式。饥饿模式转正常模式：等待者获得锁时，如果等待时间小于 1ms 或队列中只剩一个等待者，则清除 starving 位，退出饥饿模式。这个"1ms 阈值"是经验值——太短会导致频繁切换（模式切换有开销），太长会导致饥饿期间吞吐量下降。1ms 在"避免长期饥饿"和"减少模式切换开销"之间取得平衡。

**Q24：sync.Cond 的 Signal 和 Broadcast 有什么区别？**

Signal 唤醒一个等待者（FIFO 顺序，先等待的先唤醒），Broadcast 唤醒所有等待者。选择依据：如果条件是"共享资源"（如"队列非空"，一个消费者处理一个元素），用 Signal（唤醒一个足够，避免多个消费者竞争）；如果条件是"状态变更"（如"配置已更新"，所有等待者都需要感知），用 Broadcast（唤醒所有）。Signal 的开销更小（只唤醒一个 Goroutine），Broadcast 的开销更大（唤醒所有，但只有部分可能条件满足）。误用 Signal 替代 Broadcast 会导致"部分等待者永远不被唤醒"的饥饿问题。

**Q25：Mutex 的 Lock 是可重入的吗？为什么 Go 不支持可重入锁？**

Go 的 Mutex 不可重入——同 Goroutine 再次 Lock 会死锁。Go 不支持可重入的原因：可重入锁需要记录"锁的持有者"（通常是 Goroutine ID），但 Go 没有 Goroutine ID 的公开 API（goid 是内部字段，获取 goid 需要 unsafe 操作）；可重入锁容易掩盖设计问题（"为什么同 Goroutine 需要两次锁"通常是代码结构问题，如函数 A 调用函数 B，两者都 Lock 同一把锁——应该重构让 B 不加锁，由 A 统一加锁）；可重入锁的实现复杂度更高（需要维护重入计数）。Go 的建议是"重构代码避免重入"——将需要重入的逻辑拆分，或用更细粒度的锁。

**Q26：Mutex 的 woken 位有什么作用？**

woken 位表示"有 Goroutine 被唤醒准备抢锁"。作用：避免不必要的唤醒。场景：Unlock 时如果有等待者，会唤醒一个；但如果被唤醒的 Goroutine 还没获得锁，又有新 Goroutine 来抢锁，新 Goroutine 可能抢到锁，被唤醒的 Goroutine 又阻塞——这就是"无效唤醒"。woken 位让新 Goroutine 知道"已有 Goroutine 被唤醒准备抢锁"，新 Goroutine 可以不尝试抢锁直接排队，减少竞争。被唤醒的 Goroutine 获得锁后清除 woken 位。这个"woken 位避免无效唤醒"是 Mutex 的优化细节。

**Q27：RWMutex 的 RUnlock 如果调用次数多于 RLock 会怎样？**

会 panic（"rUnlock of unlocked RWMutex"）。RWMutex 内部用 `readerCount` 记录活跃读者数，RUnlock 使 readerCount 减 1。如果 RUnlock 多于 RLock，readerCount 会变成负数（正常情况下 readerCount >= 0），运行时检测到这个异常会 panic。这个"运行时检查"防止了"忘记 RLock 就 RUnlock"的错误。类似地，Mutex 的 Unlock 如果没有对应的 Lock 也会 panic（"unlock of unlocked mutex"）。这些运行时检查是 Go sync 原语的"安全网"——编译期无法检测的误用，运行时 panic 暴露问题。

**Q28：WaitGroup 复用时有什么注意事项？**

WaitGroup 可以复用——Wait 返回后可以再次 Add 启动新一轮。注意事项：Wait 返回后才能再次 Add，不能在 Wait 返回前 Add（会导致 panic "sync: WaitGroup is reused before previous Wait has returned"）。复用的典型场景是"批量处理"——每批用同一个 WaitGroup，Wait 等待本批完成，然后 Add 启动下一批。复用减少了对象分配（无需每次 new WaitGroup），但要注意"Wait 返回和下一轮 Add 之间的间隙"不能有其他 Goroutine 操作 WaitGroup。如果复用逻辑复杂，建议用新的 WaitGroup 避免竞态。

**Q29：sync.Mutex 和 sync.RWMutex 的内存布局是什么？为什么不能复制？**

Mutex 的内存布局是 `state int32`（编码 locked/woken/starving/waiter count）+ `sema uint32`（信号量），共 8 字节。RWMutex 的内存布局是 `w Mutex`（写锁）+ `writerSem/readerSem uint32`（写者/读者信号量）+ `readerCount/readerWait int32`（读者计数/写者等待读者数），共 24 字节。不能复制的原因：复制会复制 state 和 sema，导致原锁和副本的状态独立——原锁的 Lock 不会阻塞副本的 Lock，互斥失效；sema 的复制会导致唤醒逻辑混乱（唤醒原锁的等待者不影响副本）。`go vet` 的 copylocks 检查器会检测这种复制并报警。

**Q30：Mutex 的 sema 字段是什么？为什么需要信号量？**

sema 是 uint32 的信号量，用于管理阻塞/唤醒。Lock 时如果抢锁失败，调用 `runtime_SemacquireMutex(&m.sema, ...)` 将当前 Goroutine 挂入 sema 等待队列并阻塞；Unlock 时如果有等待者，调用 `runtime_Semrelease(&m.sema, ...)` 唤醒一个等待者。信号量比直接操作 Goroutine 队列更高效——运行时维护一个高效的信号量实现（基于 futex/semaphore 系统调用），支持快速唤醒和公平排队。state 的 waiter count 记录等待者数量，sema 是实际的等待队列句柄，两者配合完成阻塞唤醒。

**Q31：sync 原语的性能开销大约是多少？**

无竞争场景：Mutex 的 Lock/Unlock 约 20-30ns（快速路径，一次 CAS）；RWMutex 的 RLock/RUnlock 约 20-50ns（一次原子加）；atomic 操作约 5-10ns。有竞争场景：Mutex 的 Lock/Unlock 约 1-5μs（慢速路径，gopark/goready）；Channel 操作约 50-100ns（快速路径）到 1-5μs（慢速路径）。这些数值是近似值，实际取决于 CPU 架构、Go 版本、负载特征。性能敏感场景应该用 benchmark 实测，而非依赖经验值。

---

## 总结

本篇深入 `sync` 包三个最重要的原语的实现机制：

**Mutex 的双模态设计**：正常模式下允许新 Goroutine 自旋插队（高吞吐），当某个 Goroutine 等待超过 1ms 时切换到饥饿模式（公平 FIFO，防止长期等待）。`state` 字段通过位操作同时编码锁状态、唤醒标志、饥饿标志和等待者计数。这个"正常 + 饥饿"的双模态设计平衡了吞吐量和公平性——平时高吞吐，饥饿时切公平。

**RWMutex 的计数器设计**：`readerCount` 在正常时是活跃读者数，写者等待时减去 `rwmutexMaxReaders` 使其变为负数，新读者看到负数后阻塞——写者无需等待无限的新读者，只需等待已有的活跃读者（`readerWait`）完成。这个"减大数使计数变负"的技巧是防写者饥饿的核心。

**WaitGroup 的高位/低位编码**：`state` 的高 32 位是任务计数器，低 32 位是等待者数量，单个 64 位原子操作同时更新两个计数，避免了额外的锁开销。`Add` 必须在 `go` 之前调用，且不能并发地同时有 `Add` 和 `Wait` 在执行。

**两个要点需要铭记**：Mutex 不可重入（同 Goroutine 再次 Lock 死锁）；任何包含这些原语的 struct 都不应被复制（`go vet` 的 `copylocks` 检查器可以帮助检测）。

Go 的 sync 原语体现了"用复杂性换公平性"的工程哲学——简单的自旋锁够用但可能饥饿，Go 选择用双模态、计数器编码等复杂性换取"高吞吐 + 防饥饿"的双重保证。这个"用复杂性换公平性"是生产级并发原语的典型设计。

sync 原语的三个设计认知值得铭记：**Mutex 的双模态切换**让高吞吐和防饥饿自适应平衡，是"用复杂性换公平性"的典范；**RWMutex 的写者优先**通过"减大数使计数变负"防止写者饥饿，是"防饥饿设计"的典范；**WaitGroup 的高位低位编码**用一次原子操作更新两个计数，是"位操作压缩状态"的典范。这三个认知共同构成了 Go sync 原语的设计哲学——用双模态（自适应平衡）、写者优先（防饥饿）、位压缩（原子性更新）三个维度，实现高效、公平、简洁的同步原语。

理解 sync 原语的底层机制，不仅能帮助开发者写出正确的并发代码（避免不可重入陷阱、避免复制陷阱、正确使用 WaitGroup 的 Add/Done/Wait），还能帮助开发者在"Mutex vs RWMutex"之间做出正确选择（写多用 Mutex，读多用 RWMutex），以及在性能敏感场景评估锁开销（快速路径约 20-50ns，慢速路径约 1-5μs）。sync 原语是 Go 并发编程的基础工具，也是区分"会用 Go"和"精通 Go"的分水岭——前者只知道"Mutex 加锁解锁"，后者理解双模态切换、写者优先、位压缩编码的底层机制。

sync 原语的设计还体现了 Go"快速路径 + 慢速路径"的工程哲学——无竞争时走快速路径（一次原子操作，极快），有竞争时走慢速路径（锁/信号量，正确但慢）。这个设计让无竞争场景下的开销极低，只有有竞争时才付出复杂逻辑的代价。这是高并发原语的通用优化模式——大多数情况下无竞争，快速路径让常见情况极快。理解这个设计有助于在性能优化时关注"减少锁竞争"而非"优化锁实现"——锁本身的实现已经足够快，瓶颈在于竞争。

同时，sync 原语的"简单接口 + 精巧底层"设计让开发者可以按需深入——日常使用只需 Lock/Unlock、Add/Done/Wait 的基本语法，性能优化时再深入双模态切换、写者优先、位压缩编码。这种"按需深入"的分层设计，让并发编程既适合初学者快速上手（sync 原语接口简洁），也适合资深开发者深度优化（理解底层机制才能写出高并发、低延迟的代码）。理解 sync 原语的底层机制，是从"会用 Go"走向"精通 Go"的必经之路，也是写出正确、高效、可维护并发 Go 代码的基础。

最后，sync 原语的设计还体现了 Go"持续演进"的工程态度——从 Go 1.0 的简单自旋锁，到 Go 1.1 的饥饿模式，到 Go 1.15 的 RWMutex 优化。Go 团队持续在"不破坏兼容性"的前提下优化 sync 原语，让 sync 原语在不同场景（高并发、低延迟、防饥饿）都能良好工作。这种"持续演进"让 sync 原语在不同版本上性能持续提升，开发者无需修改代码就能享受优化收益。理解 sync 原语的版本演进，有助于开发者在升级 Go 版本时评估锁性能收益，以及在新版本上利用最新的优化特性。

下一篇深入 `sync.Map`、`sync.Pool` 与原子操作的实现：[[04 sync.Map、sync.Pool 与原子操作]]。

---

## 参考资料

1. Go 源码：`sync/mutex.go`、`sync/rwmutex.go`、`sync/waitgroup.go`——三个原语的完整实现。
2. Dmitry Vyukov,《Scalable Go Scheduler》——Go 调度器与同步原语的设计文档。
3. Go Blog,《Introducing the Go Race Detector》: https://go.dev/blog/race-detector——竞态检测器的官方介绍。
4. Russ Cox,《sync.Mutex, sync.RWMutex 设计演进》——Go sync 原语演进的历史。
5. Linux `futex(2)` man page——Go 信号量底层基于 futex 实现。
6. `sync/mutex.go` 源码——Mutex 完整实现，展示双模态切换与位编码。
7. `sync/rwmutex.go` 源码——RWMutex 完整实现，展示写者优先与计数器编码。
8. `sync/waitgroup.go` 源码——WaitGroup 完整实现，展示高位低位编码。
9. `sync/once.go` 源码——Once 实现，展示双重检查与原子操作。
10. `sync/cond.go` 源码——Cond 实现，展示条件变量的等待与通知。
11. `sync/semaphore.go` 源码——信号量实现，展示 sync 原语的底层。
12. `runtime/sema.go` 源码——运行时信号量，展示底层 futex 交互。
13. `runtime/lock_futex.go` 源码——futex 锁，展示运行时锁的实现。
14. `go vet -copylocks` 文档——复制锁检查，展示 sync 原语的复制陷阱检测。
15. `go test -race` 文档——竞态检测，展示 sync 原语误用的检测。
16. `runtime/pprof` 包文档——锁竞争剖析，展示 sync 原语性能分析。
17. `runtime/trace` 包文档——执行追踪，展示 sync 原语阻塞唤醒的时间线。
18. `sync` 包文档——sync 包官方文档，展示所有 sync 原语的接口。
19. `atomic` 包文档——原子操作，展示 sync 原语的底层原子操作。
20. `runtime/debug.SetMaxThreads` 包文档——线程数限制，展示锁竞争与线程数的关系。
---

> [!note] 思考题
> 1. `sync.Mutex` 在 Go 中经历了从"简单自旋"到"饥饿模式"的演进。当一个 goroutine 等待锁超过 1ms 时，Mutex 会切换到饥饿模式——新到达的 goroutine 不再尝试获取锁，而是直接排队。这种设计解决了什么问题？如果所有锁请求的持有时间都很短（< 100μs），饥饿模式会被触发吗？
> 2. `sync.RWMutex` 允许多个读者并发，但写者独占。当一个写者在等待锁时，后到的读者是否会被阻塞（即写者优先），还是读者可以"插队"？Go 的 RWMutex 实现中，这个设计选择的原因是什么？与 Java 的 `ReentrantReadWriteLock` 的公平策略有什么区别？
> 3. `sync.WaitGroup` 的 `Add()` 和 `Done()` 内部使用原子操作维护计数器。如果在启动 goroutine 之前忘记调用 `Add()`，而是在 goroutine 内部第一行调用 `Add(1)`，可能发生什么竞态问题？`WaitGroup` 可以被复用（Wait 返回后再次 Add）吗？
> 4. Go 的 sync 原语大量使用"位操作压缩状态"——Mutex 的 state 用 32 位编码四个字段，WaitGroup 用 64 位编码两个计数。这个"位压缩"让一次原子操作能更新多个字段，但也让代码可读性降低。你认为这种"用可读性换性能"的取舍值得吗？如果用多个独立字段（每个字段一次原子操作），会带来什么问题？请从"原子性"和"性能"两个角度分析。
> 5. Go 的 sync.Mutex 不可重入——同 Goroutine 再次 Lock 会死锁。而 Java 的 ReentrantLock 可重入（同线程可多次 lock，需对应次数 unlock）。请分析：为什么 Go 选择不可重入？这个选择如何影响 Go 的并发编程实践？如果 Go Mutex 改为可重入，会带来哪些问题？
> 6. Go 的 sync.RWMutex 实现了"写者优先"——当写者在等待时，新读者会被阻塞。这个设计防止了写者饥饿，但也可能降低读吞吐量。请分析：在什么场景下"写者优先"比"读者优先"更合适？在什么场景下"读者优先"更好？Go 的选择是否总是最优？
