---
title: "并发陷阱与调试——Goroutine 泄漏、死锁与 Race Detector"
date: 2026-03-04
tags: [Golang, 并发陷阱, Goroutine泄漏, 死锁, Race Detector, pprof, 数据竞争, 调试, 生产问题]
aliases: []
---

# 并发陷阱与调试——Goroutine 泄漏、死锁与 Race Detector

## 摘要

Go 的并发模型让编写高并发程序变得相对简单，但也带来了一类独特的、在串行程序中不存在的 Bug：Goroutine 泄漏、死锁、数据竞争。这三类 Bug 有一个共同特点——**它们在代码 review 和普通测试中极难发现**，却在生产环境中往往造成严重后果（内存持续增长、服务卡死、数据损坏）。本文系统梳理这三类问题的产生根源、识别方式与修复策略，重点介绍 Go 工具链提供的三大诊断武器：`go tool pprof`（通过 goroutine profile 定位泄漏）、`runtime` 死锁检测器（内置，panic 告警）以及 `-race` 竞争检测器（编译期插桩，运行时检测）。掌握这些工具和防御性编程模式，是 Go 并发程序从"能跑"到"可信赖"的关键跨越。

---

## 第 1 章 Goroutine 泄漏：最常见也最隐蔽的并发 Bug

### 1.1 什么是 Goroutine 泄漏

**Goroutine 泄漏（Goroutine Leak）** 是指一个 Goroutine 启动后，由于某种原因永远无法退出——它既不执行任何有用的工作，也无法被 GC 回收（GC 不会回收存活的 Goroutine），导致 Goroutine 数量随着程序运行时间持续增长，占用的内存（至少每个 Goroutine 的栈，约 2KB 起步）也持续增长。

在生产环境中，Goroutine 泄漏往往表现为：
- 服务的内存使用量随运行时间缓慢但持续增长（即使流量平稳）；
- `runtime.NumGoroutine()` 返回的数字持续增大；
- 通过 `pprof` 的 goroutine profile 发现大量 Goroutine 阻塞在同一个位置。

**Goroutine 泄漏不会立刻崩溃服务**——这正是它危险的地方。它通常是一个长期慢性问题，直到内存耗尽才暴露，而此时排查现场已经很困难了。

### 1.2 泄漏原因一：channel 操作永久阻塞

最常见的泄漏原因是 Goroutine 阻塞在一个永远不会被操作的 channel 上：

**场景一：发送方泄漏（没有接收者）**

```go
// 错误示例：启动 goroutine 发送，但接收者提前退出
func processRequest(ctx context.Context) *Result {
    resultCh := make(chan *Result)  // 无缓冲 channel
    
    go func() {
        result := doExpensiveWork()
        resultCh <- result  // 如果接收者已经退出，这里永久阻塞
    }()
    
    select {
    case result := <-resultCh:
        return result
    case <-ctx.Done():
        return nil  // ctx 超时，函数返回了，但 goroutine 仍然阻塞在 resultCh <- result
    }
}
```

函数因为 `ctx.Done()` 返回后，`resultCh` 这个 channel 没有任何接收者了，但那个 goroutine 还阻塞在 `resultCh <- result` 这行——它永远无法退出，发生泄漏。

**修复方案：使用有缓冲 channel，或通过 ctx 通知 goroutine 退出**

```go
// 方案一：使用有缓冲 channel（容量 >= 可能的发送次数）
func processRequest(ctx context.Context) *Result {
    resultCh := make(chan *Result, 1)  // 有缓冲，goroutine 可以发送后退出
    
    go func() {
        result := doExpensiveWork()
        select {
        case resultCh <- result:
        default:  // 如果没人接收（接收者已超时退出），直接丢弃，goroutine 正常退出
        }
    }()
    
    select {
    case result := <-resultCh:
        return result
    case <-ctx.Done():
        return nil
    }
}

// 方案二：goroutine 内部监听 ctx，允许提前退出
func processRequest(ctx context.Context) *Result {
    resultCh := make(chan *Result, 1)
    
    go func() {
        result := doExpensiveWork()  // 假设这个函数不支持 ctx，只能等它完成
        select {
        case resultCh <- result:
        case <-ctx.Done():  // ctx 已取消，放弃发送，退出
        }
    }()
    
    select {
    case result := <-resultCh:
        return result
    case <-ctx.Done():
        return nil
    }
}
```

**场景二：接收方泄漏（没有发送者，channel 永远不关闭）**

```go
// 错误示例：goroutine 等待一个永远不会关闭的 channel
func startMonitor() {
    events := getEventChannel()  // 假设 events 从某个外部来源获取
    
    go func() {
        for event := range events {  // 如果 events 永远不关闭，这个 goroutine 永远不退出
            processEvent(event)
        }
    }()
    // 这里没有办法停止这个 goroutine
}
```

**修复：始终提供退出机制**

```go
func startMonitor(ctx context.Context) {
    events := getEventChannel()
    
    go func() {
        for {
            select {
            case event, ok := <-events:
                if !ok {
                    return  // channel 关闭，正常退出
                }
                processEvent(event)
            case <-ctx.Done():
                return  // ctx 取消，退出
            }
        }
    }()
}
```

### 1.3 泄漏原因二：sync.WaitGroup 或 sync.Mutex 永久阻塞

```go
// 错误：wg.Done() 没有被调用（panic 路径遗漏）
func process(wg *sync.WaitGroup, data []byte) {
    defer wg.Done()
    if len(data) == 0 {
        return  // 早返回，wg.Done() 通过 defer 正确调用
    }
    result := parse(data)
    if result == nil {
        panic("unexpected nil result")  // panic 时 defer 会执行，wg.Done() 会被调用
        // 但如果是 return 而没有 defer：
    }
}

// 更危险的错误：条件分支中忘记调用 Done
func processWrong(wg *sync.WaitGroup, data []byte) {
    wg.Add(1)
    go func() {
        if len(data) == 0 {
            return  // 忘记调用 wg.Done()！wg.Wait() 会永远阻塞
        }
        defer wg.Done()
        parse(data)
    }()
}
```

**黄金规则**：`wg.Add(1)` 之后，`wg.Done()` 必须通过 `defer` 调用，确保所有代码路径（包括 panic 恢复）都能执行到。

### 1.4 泄漏原因三：HTTP Server 请求处理 Goroutine 泄漏

```go
// 危险模式：在 HTTP handler 中启动 goroutine，但没有等待或取消机制
func handler(w http.ResponseWriter, r *http.Request) {
    go func() {
        // 这个 goroutine 与 request 的生命周期解绑了
        // 即使客户端断开连接，这个 goroutine 仍然运行
        result := callDownstream()
        log.Println(result)
    }()
    w.WriteHeader(http.StatusAccepted)
}

// 正确：将 r.Context() 传递给 goroutine，客户端断开时 goroutine 自动退出
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    go func() {
        result, err := callDownstreamWithCtx(ctx)
        if err != nil {
            if ctx.Err() != nil {
                return  // 客户端已断开，正常退出
            }
            log.Printf("downstream error: %v", err)
        }
        log.Println(result)
    }()
    w.WriteHeader(http.StatusAccepted)
}
```

### 1.5 如何检测 Goroutine 泄漏

**方法一：pprof goroutine profile**

```go
import _ "net/http/pprof"

func main() {
    go http.ListenAndServe(":6060", nil)  // 开启 pprof 端点
    // ...
}
```

访问 `http://localhost:6060/debug/pprof/goroutine?debug=2` 可以看到所有 Goroutine 的调用栈。泄漏的 Goroutine 通常会有大量重复的相同调用栈，且阻塞在同一个位置。

```bash
# 命令行查看 goroutine 数量和调用栈
go tool pprof http://localhost:6060/debug/pprof/goroutine

# 在 pprof 交互界面中：
(pprof) top       # 按 goroutine 数量排序，找出最多的阻塞点
(pprof) traces    # 查看所有 goroutine 调用栈
(pprof) list main.handler  # 查看具体函数的 goroutine 情况
```

**方法二：测试中使用 goleak 库**

[`go.uber.org/goleak`](https://github.com/uber-go/goleak) 是 Uber 开源的 Goroutine 泄漏检测库，可以在单元测试中使用：

```go
import "go.uber.org/goleak"

func TestNoGoroutineLeak(t *testing.T) {
    defer goleak.VerifyNone(t)  // 测试结束时检查是否有新增的泄漏 goroutine
    
    // 执行可能泄漏的代码
    processRequest(context.Background())
}
```

**方法三：runtime.NumGoroutine() 监控**

```go
// 简单的 goroutine 数量监控
func monitorGoroutines() {
    for {
        time.Sleep(10 * time.Second)
        n := runtime.NumGoroutine()
        log.Printf("goroutine count: %d", n)
        if n > 10000 {
            log.Printf("WARNING: possible goroutine leak!")
        }
    }
}
```

---

## 第 2 章 死锁：程序完全卡死的并发 Bug

### 2.1 什么是死锁，以及 Go 的内置检测

**死锁（Deadlock）** 是指两个或多个 Goroutine 相互等待对方释放资源，导致所有这些 Goroutine 都永远无法继续执行：

```
Goroutine A 持有 Lock1，等待 Lock2
Goroutine B 持有 Lock2，等待 Lock1
→ A 和 B 互相等待，永远无法继续
```

**Go 运行时内置死锁检测器**：当**所有** Goroutine 都处于阻塞状态时（没有任何 Goroutine 在运行），Go 运行时会检测到这种情况并 panic：

```
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan receive]:
main.main()
    /tmp/sandbox/main.go:10 +0x40

goroutine 2 [chan send]:
main.producer()
    /tmp/sandbox/main.go:20 +0x60
```

**注意限制**：Go 的死锁检测只能检测"全局死锁"（所有 Goroutine 都阻塞）。如果只有部分 Goroutine 死锁，但还有其他 Goroutine 在正常运行（如 HTTP server 的主 Goroutine），运行时不会检测到，服务会继续运行但某些请求永久卡住——这更像是一种**局部死锁（Partial Deadlock）**，需要通过 pprof 发现。

### 2.2 死锁原因一：Mutex 加锁顺序不一致

```go
var (
    mu1 sync.Mutex
    mu2 sync.Mutex
)

// Goroutine A：先锁 mu1，再锁 mu2
func funcA() {
    mu1.Lock()
    defer mu1.Unlock()
    time.Sleep(1 * time.Millisecond)  // 模拟处理时间
    mu2.Lock()
    defer mu2.Unlock()
    // ...
}

// Goroutine B：先锁 mu2，再锁 mu1（顺序与 A 相反！）
func funcB() {
    mu2.Lock()
    defer mu2.Unlock()
    time.Sleep(1 * time.Millisecond)
    mu1.Lock()
    defer mu1.Unlock()
    // ...
}

// 当 A 和 B 并发执行时：
// A 拿到 mu1，B 拿到 mu2
// A 等待 mu2（被 B 持有），B 等待 mu1（被 A 持有）
// → 死锁
```

**修复：全局统一加锁顺序**。对于需要同时持有多把锁的操作，在整个代码库中规定一个固定的加锁顺序（如按锁的地址、名字或枚举值排序），所有代码都遵循这个顺序。

### 2.3 死锁原因二：Mutex 不可重入

```go
type Cache struct {
    mu    sync.Mutex
    items map[string]string
}

func (c *Cache) Get(key string) string {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.items[key]
}

func (c *Cache) GetOrSet(key, defaultVal string) string {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    val := c.Get(key)  // 错误！Get 内部也会 c.mu.Lock()，但 mu 已被持有
    // → 死锁：同一个 Goroutine 再次尝试获取已持有的 Mutex
    
    if val == "" {
        c.items[key] = defaultVal
        return defaultVal
    }
    return val
}
```

Go 的 `Mutex` 是**不可重入（Non-reentrant）**的——同一个 Goroutine 再次对已持有的 `Mutex` 调用 `Lock()` 会永久阻塞（不像 Java 的 `synchronized` 会重入）。这是刻意的设计：不可重入锁迫使开发者明确区分"需要锁保护的公共方法"和"不需要锁的内部方法"。

**修复：拆分内部实现**

```go
// 内部方法（加了 Locked 后缀，调用方必须已持有锁）
func (c *Cache) getLocked(key string) string {
    return c.items[key]
}

func (c *Cache) Get(key string) string {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.getLocked(key)
}

func (c *Cache) GetOrSet(key, defaultVal string) string {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    val := c.getLocked(key)  // 调用内部方法，不再加锁
    if val == "" {
        c.items[key] = defaultVal
        return defaultVal
    }
    return val
}
```

### 2.4 死锁原因三：channel 操作死锁

```go
// 错误一：向无缓冲 channel 发送，但没有 goroutine 在接收
func deadlock1() {
    ch := make(chan int)
    ch <- 1  // 阻塞：没有接收者
    <-ch
}

// 错误二：所有 goroutine 都在等待彼此
func deadlock2() {
    ch1 := make(chan int)
    ch2 := make(chan int)
    
    go func() {
        <-ch1   // 等待 ch1 有数据
        ch2 <- 1
    }()
    
    go func() {
        <-ch2   // 等待 ch2 有数据
        ch1 <- 1
    }()
    
    // 两个 goroutine 互相等待，主 goroutine 也没有做任何事
    // 如果主 goroutine 最终 Wait，会触发全局死锁检测
}
```

### 2.5 局部死锁的 pprof 诊断

```bash
# 当某些请求卡住，但服务未崩溃时：
# 1. 查看阻塞 profile
go tool pprof http://localhost:6060/debug/pprof/block

# 2. 查看 mutex profile（需要先开启）
# 代码中：runtime.SetMutexProfileFraction(1)
go tool pprof http://localhost:6060/debug/pprof/mutex

# 3. 直接查看所有 goroutine 调用栈，找出阻塞在 Lock/chan 的 goroutine
curl http://localhost:6060/debug/pprof/goroutine?debug=2 | grep -A 5 "sync.Mutex"
```

---

## 第 3 章 数据竞争：最难发现的并发 Bug

### 3.1 什么是数据竞争，为什么如此危险

**数据竞争（Data Race）** 是指两个或多个 Goroutine 在没有同步的情况下并发访问同一块内存，且至少有一个访问是写操作。

数据竞争的危险性在于其行为是**完全不可预期的（Undefined Behavior）**：
- 有时表现正常（恰好没有并发冲突）；
- 有时产生错误的计算结果（写丢失）；
- 有时导致 panic（访问了被并发修改为非法状态的数据结构）；
- 有时在特定硬件或操作系统上才触发。

这使得数据竞争的 Bug 极难复现和调试——测试环境完全正常，生产环境偶发崩溃，而两者代码完全相同。

**典型场景**：

```go
// 场景一：共享计数器（最简单的数据竞争）
var counter int

func increment() {
    counter++  // 不是原子操作！load + add + store 三步，可能被其他 goroutine 打断
}

// 场景二：map 并发读写（会 panic！）
var m = map[string]int{}

go func() { m["a"] = 1 }()
go func() { fmt.Println(m["a"]) }()
// Go 1.6+ 的 map 对并发读写有检测，会触发 panic: concurrent map read and write

// 场景三：slice 并发 append（最隐蔽）
var results []int

for i := 0; i < 10; i++ {
    go func(n int) {
        results = append(results, n)  // append 可能修改底层数组指针，并发写 slice header
    }(i)
}
```

### 3.2 Race Detector：Go 的编译期插桩检测器

Go 工具链内置了 **Race Detector**（竞争检测器），只需在编译或测试时加 `-race` 标志：

```bash
# 运行测试时开启 race 检测（推荐 CI 中始终开启）
go test -race ./...

# 运行程序时开启 race 检测
go run -race main.go

# 构建时开启（生产不推荐，有性能开销）
go build -race -o myapp .
```

**Race Detector 的工作原理**：编译时在每个内存访问（读和写）前后插入**影子内存（Shadow Memory）**更新指令，记录"哪个 Goroutine 在何时访问了这个内存地址"。运行时，当检测到两个访问之间没有同步关系（happens-before 关系）且至少有一个是写，就报告竞争：

```
==================
WARNING: DATA RACE
Write at 0x00c000126010 by goroutine 7:
  main.increment()
      /tmp/race.go:10 +0x3e

Previous write at 0x00c000126010 by goroutine 6:
  main.increment()
      /tmp/race.go:10 +0x3e

Goroutine 7 (running) created at:
  main.main()
      /tmp/race.go:20 +0xa0

Goroutine 6 (running) created at:
  main.main()
      /tmp/race.go:20 +0xa0
==================
```

Race Detector 的输出非常精确：告诉你哪两个 Goroutine、在哪一行代码上发生了冲突，定位 Bug 的效率极高。

**Race Detector 的性能开销**：约 5-10 倍的 CPU 开销，2-3 倍内存开销——因此不适合在生产环境中长期开启，但：
- **所有 CI 测试都应该开启 `-race`**；
- **代码 review 阶段**，可以在本地对可疑代码用 `-race` 验证；
- **性能测试**不应开启（会影响 benchmark 结果）。

### 3.3 常见数据竞争的修复方法

**修复方案一：使用原子操作（适合简单计数器）**

```go
// 竞争的计数器
var counter int64

// 修复：使用原子操作
var counter atomic.Int64

func increment() {
    counter.Add(1)
}
```

**修复方案二：使用 Mutex 保护**

```go
var (
    mu      sync.Mutex
    results []int
)

for i := 0; i < 10; i++ {
    go func(n int) {
        mu.Lock()
        results = append(results, n)
        mu.Unlock()
    }(i)
}
```

**修复方案三：通过 channel 传递所有权（CSP 模式）**

```go
// 不共享状态，通过 channel 传递数据
resultCh := make(chan int, 10)

for i := 0; i < 10; i++ {
    go func(n int) {
        resultCh <- n  // 发送后，n 的所有权转移给接收者
    }(i)
}

var results []int
for i := 0; i < 10; i++ {
    results = append(results, <-resultCh)
}
```

**修复方案四：局部变量避免共享**

```go
// 最好的情况：根本不共享状态
func processItems(items []Item) []Result {
    results := make([]Result, len(items))
    var wg sync.WaitGroup
    
    for i, item := range items {
        wg.Add(1)
        go func(idx int, it Item) {
            defer wg.Done()
            results[idx] = process(it)  // 每个 goroutine 写不同的 results[idx]，不竞争
        }(i, item)
    }
    
    wg.Wait()
    return results
}
```

---

## 第 4 章 其他常见并发陷阱

### 4.1 陷阱：循环变量捕获

Go 1.22 之前，`for range` 循环中启动的 Goroutine 会共享循环变量（`i` 和 `v` 在循环结束时指向最后一个值）：

```go
// Go 1.21 及之前的经典陷阱
for i, v := range items {
    go func() {
        // i 和 v 是对循环变量的引用，所有 goroutine 共享同一个 i 和 v
        // 循环结束时，所有 goroutine 看到的 i 都是 len(items)-1
        fmt.Println(i, v)  // 打印的几乎都是最后一个值
    }()
}

// 修复方案（Go 1.21 及之前）：通过参数传递，创建新的局部变量
for i, v := range items {
    i, v := i, v  // 创建新的局部变量
    go func() {
        fmt.Println(i, v)  // 每个 goroutine 有自己的 i 和 v
    }()
}

// 或者
for i, v := range items {
    go func(idx int, val Item) {
        fmt.Println(idx, val)
    }(i, v)  // 通过参数传值
}
```

**Go 1.22 的修复**：从 Go 1.22 起，`for range` 循环的每次迭代都会创建新的循环变量（行为与直觉一致），这个陷阱不再存在——但读老代码时仍需注意。

### 4.2 陷阱：time.After 的 Goroutine 泄漏

```go
// 危险：在循环中使用 time.After，每次调用都创建一个 timer，直到超时才 GC
func processWithTimeout(ch <-chan int) {
    for {
        select {
        case v := <-ch:
            process(v)
        case <-time.After(5 * time.Second):  // 每次循环都创建一个新 timer！
            // 如果 ch 一直有数据，之前的 timer 在 5s 内不会被 GC
            // 每次循环都积累一个 timer，高频调用时大量 timer 堆积
            return
        }
    }
}

// 正确：在循环外创建 timer，或使用 time.NewTimer + Reset
func processWithTimeout(ch <-chan int) {
    timer := time.NewTimer(5 * time.Second)
    defer timer.Stop()
    
    for {
        select {
        case v := <-ch:
            timer.Reset(5 * time.Second)  // 重置而非重新创建
            process(v)
        case <-timer.C:
            return
        }
    }
}
```

### 4.3 陷阱：select 在 nil channel 上的行为

```go
// nil channel 上的 send/recv 永远阻塞
// 在 select 中，对 nil channel 的 case 永远不会被选中——可以利用这个特性

func merge(a, b <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for a != nil || b != nil {
            select {
            case v, ok := <-a:
                if !ok {
                    a = nil  // a 已关闭，将 a 设为 nil，select 不再监听 a
                    continue
                }
                out <- v
            case v, ok := <-b:
                if !ok {
                    b = nil  // b 已关闭
                    continue
                }
                out <- v
            }
        }
    }()
    return out
}
```

将已关闭的 channel 设为 `nil` 后，`select` 的对应 case 永远不会触发（nil channel 永远阻塞）——这是一个优雅的技巧，避免了 close 后的 channel 被反复读取到零值。

---

## 第 5 章 并发调试工具总览

### 5.1 工具选择矩阵

| 问题类型 | 检测工具 | 使用时机 |
| --- | --- | --- |
| Goroutine 泄漏 | `pprof /goroutine` | 线上问题排查、压测后检查 |
| Goroutine 泄漏（测试） | `goleak` 库 | 单元/集成测试 |
| 全局死锁 | Go 运行时内置（自动 panic）| 开发调试 |
| 局部死锁/卡死 | `pprof /block`、`/mutex` | 线上问题排查 |
| 数据竞争 | `go test -race` / `go run -race` | CI 阶段、开发阶段 |
| 竞争条件（逻辑 bug）| 代码审查 + 单元测试 | 开发阶段 |
| 性能瓶颈（锁争用）| `pprof /mutex` | 性能优化阶段 |

### 5.2 开启 block profile 和 mutex profile

```go
import "runtime"

func init() {
    // 开启阻塞 profile（记录 goroutine 阻塞在 channel 和 select 的情况）
    runtime.SetBlockProfileRate(1)  // 1 = 每次阻塞都记录；大值 = 采样
    
    // 开启 mutex 争用 profile（记录 mutex 锁争用情况）
    runtime.SetMutexProfileFraction(1)  // 1 = 每次都记录；大值 = 采样
}
```

**pprof 的使用流程**：

```bash
# 步骤一：采集 goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine

# 步骤二：在 pprof 交互界面分析
(pprof) top10           # 显示占用最多的 10 个调用栈
(pprof) web             # 在浏览器中查看调用图（需要 graphviz）
(pprof) list funcName   # 显示特定函数的源码级别分析

# 步骤三：对比两个时间点的 profile（用于确认 goroutine 泄漏）
curl -o before.pb.gz http://localhost:6060/debug/pprof/goroutine
# 等待一段时间...
curl -o after.pb.gz http://localhost:6060/debug/pprof/goroutine
go tool pprof -diff_base=before.pb.gz after.pb.gz
```

---

## 总结

本篇系统梳理了 Go 并发程序中三类最危险的 Bug 及其诊断工具：

**Goroutine 泄漏**：本质是 Goroutine 永久阻塞（channel 无人接收/发送、Mutex/WaitGroup 未释放）。预防靠**始终为 Goroutine 提供退出路径**（ctx 取消 + 有缓冲 channel），检测靠 `pprof goroutine profile` 或 `goleak` 测试库。

**死锁**：全局死锁由 Go 运行时自动检测并 panic；局部死锁（部分 Goroutine 卡死）需要 `pprof block/mutex profile` 定位。预防靠**全局统一加锁顺序**（防止 lock ordering 死锁）和**避免 Mutex 重入**（拆分 locked/public 方法）。

**数据竞争**：最隐蔽，行为不可预期。`go test -race` 通过影子内存插桩，能精确报告竞争发生的位置和 Goroutine。**CI 中始终开启 `-race`** 是工程上防止数据竞争进入生产的最有效手段。修复手段：原子操作（简单计数器）、Mutex（复杂状态）、channel 所有权转移（CSP 风格）。

下一篇深入 Go 网络编程的底层：[[08 Go 网络编程——netpoller 与 Goroutine-per-Connection]]。

---

> [!note] 参考资料
> - Go Blog,《Introducing the Go Race Detector》: https://go.dev/blog/race-detector
> - Go 文档,《Data Race Detector》: https://go.dev/doc/articles/race_detector
> - uber-go/goleak: https://github.com/uber-go/goleak
> - Go pprof 文档: https://pkg.go.dev/net/http/pprof

---

> [!note] 思考题
> 1. 一个 goroutine 向一个无缓冲 channel 发送数据，但没有接收方——这个 goroutine 会永远阻塞（goroutine 泄漏）。Go 运行时能检测到这种泄漏吗？`runtime.NumGoroutine()` 可以用来监控泄漏，但它无法定位是哪个 goroutine 泄漏了。在生产环境中，你有哪些工具和方法来定位 goroutine 泄漏的具体代码位置？
> 2. Go 的 Race Detector 使用 happens-before 关系来判断是否存在数据竞争。两个 goroutine 分别读写同一个 `map` 而没有加锁——即使在测试中没有观察到错误结果，Race Detector 也会报告竞争。这是否意味着'没有可观察到的错误不等于没有数据竞争'？Go 的 map 在并发读写时可能导致什么运行时后果（不仅仅是数据错误）？
> 3. 死锁检测是 Go 运行时的内置能力——当所有 goroutine 都阻塞时，运行时会 panic 并报告 `fatal error: all goroutines are asleep - deadlock!`。但如果只有部分 goroutine 死锁（其他 goroutine 仍在运行，比如 HTTP server），运行时还能检测到吗？在微服务场景中，如何检测这种'部分死锁'？
