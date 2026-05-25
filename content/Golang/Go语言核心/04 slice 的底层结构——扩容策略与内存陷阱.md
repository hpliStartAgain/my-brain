---
title: "slice 的底层结构——扩容策略与内存陷阱"
date: 2026-03-04
tags: [Append, copy, Golang, slice, 共享底层数组, 内存, 切片, 底层结构, 扩容, 陷阱]
aliases: []
---

# slice 的底层结构——扩容策略与内存陷阱

## 摘要

slice（切片）是 Go 中使用频率最高的数据结构，几乎替代了数组的所有使用场景。但 slice 简洁的外表下隐藏着若干容易踩坑的内存语义：截取操作（`s[low:high]`）产生的子切片与原切片**共享底层数组**，在其中一个上 append 或修改元素，可能悄然影响另一个；`append` 在容量不足时会触发扩容，分配全新的底层数组，此后两个切片各自独立——"是否共享"随操作动态变化。本文从 slice header 的三元组内存结构出发，精确推导 `append` 的扩容策略（Go 1.18 前后的变化）、截取的内存语义、`copy` 的行为，再到常见的内存陷阱（大切片截取导致的内存泄漏、并发访问共享底层数组的竞态条件），帮助读者建立对 slice 完整而精确的认知模型。

---

## 第 1 章 从数组说起：slice 是如何演进出来的

### 1.1 C 语言数组的痛点

在理解 slice 之前，先理解它要解决的问题。C 语言的数组有两个著名的缺陷：

**缺陷一：数组传递会退化为指针，丢失长度信息**。C 语言中把数组传给函数时，数组退化（decay）为指向第一个元素的指针，函数只拿到地址，不知道数组有多长。这是 C 语言缓冲区溢出漏洞的最大根源——函数不知道边界在哪里，就可能越界访问。解决方法是额外传一个 `size_t len` 参数，但这是"约定"，不是"强制"，容易出错。

**缺陷二：数组大小是编译期常量，无法动态增长**。C 数组的大小必须在声明时确定（或用 `malloc` 手动管理），没有自动扩容的能力。需要"可变长数组"时，开发者必须手动 `malloc` + 拷贝 + `free`，容易出现内存泄漏。

Go 的数组（`[N]T`）解决了第一个问题——数组类型包含大小信息（`[3]int` 和 `[4]int` 是不同的类型），传递数组时会完整复制（包括大小信息）。但 Go 数组同样是固定大小的，无法动态增长。

### 1.2 Go 数组的局限与 slice 的出现

Go 数组的按值复制语义，在处理大数组时效率低下：

```go
var a [1000000]int  // 1 百万个 int，占 8MB
b := a              // 完整复制 8MB 数据——这个代价通常不可接受
```

更重要的是，不同大小的数组是不同类型，这让编写"处理任意长度数组"的通用函数几乎不可能：

```go
// 无法编写一个同时接受 [3]int 和 [5]int 的函数
// func sum(a [3]int) int { ... }  // 只能处理长度为 3 的数组
```

**slice 是对这些问题的完整解法**：它是一个描述底层数组某段连续区间的"视图"——既保留了数组的直接内存访问效率，又提供了动态增长能力，还允许以统一的 `[]T` 类型处理任意长度的序列。

---

## 第 2 章 slice header：三元组内存结构

### 2.1 slice 在内存中是什么

slice 变量本身只有 24 字节（64 位系统），包含三个字段：

```go
// Go 运行时对 slice 的内部表示（runtime/slice.go）
type slice struct {
    array unsafe.Pointer  // 8 字节：指向底层数组第一个元素的指针
    len   int             // 8 字节：当前包含的元素个数
    cap   int             // 8 字节：从 array 开始到底层数组末尾的元素个数
}
```

这个三元组就是所谓的 **slice header**。理解这三个字段的含义，是理解所有 slice 行为的基础：

- `array`：底层数组的起始位置指针——决定了数据从哪里开始；
- `len`：当前可见的元素数量——决定了可以访问 `s[0]` 到 `s[len-1]`，越界则 panic；
- `cap`：从 `array` 开始到底层数组末尾的元素总数——决定了在不重新分配内存的前提下，最多能存放多少元素（`append` 时只要 `len < cap`，就不需要扩容）。

```
底层数组（由 Go 运行时管理）：
+---+---+---+---+---+---+---+---+
| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
+---+---+---+---+---+---+---+---+
      ^               ^           ^
      |               |           |
   array            len         cap
   （起点）        （array+3）  （array+6）

对应的 slice header：
array = &底层数组[1]
len   = 3   // 可见 [1, 2, 3]
cap   = 6   // 从 [1] 到 [6]，共 6 个位置可用
```

### 2.2 make 与字面量的创建方式

```go
// 方式一：字面量初始化（同时确定 len 和内容）
s1 := []int{10, 20, 30}
// array 指向新分配的 [3]int{10, 20, 30}
// len = 3, cap = 3

// 方式二：make（指定 len 和可选的 cap）
s2 := make([]int, 3)       // len=3, cap=3，所有元素初始化为零值 0
s3 := make([]int, 3, 10)   // len=3, cap=10，预留容量（避免频繁扩容）

// 方式三：nil slice（零值状态）
var s4 []int
// array = nil, len = 0, cap = 0
// nil slice 是合法的，可以 append、len/cap 操作，但不能访问元素

// 方式四：从数组截取
arr := [5]int{1, 2, 3, 4, 5}
s5 := arr[1:4]  // array = &arr[1], len = 3, cap = 4（从 arr[1] 到 arr 末尾）
```

**nil slice vs 空 slice**：

```go
var nilSlice []int        // nil slice：array = nil, len = 0, cap = 0
emptySlice := []int{}     // 空 slice：array 指向某个非 nil 地址（但内容为空），len = 0, cap = 0

fmt.Println(nilSlice == nil)    // true
fmt.Println(emptySlice == nil)  // false（注意！）

// 两者的 len 和 cap 都是 0，都可以 append
// 但在 JSON 序列化时行为不同：
// json.Marshal(nilSlice)    → "null"
// json.Marshal(emptySlice)  → "[]"
```

> [!warning] 生产避坑：JSON 序列化中的 nil slice
> 如果 API 返回列表字段，当列表为空时应返回 `[]`（空数组）而非 `null`，因为前端往往不能优雅处理 `null`。正确做法：将 slice 字段初始化为空 slice（`[]T{}`）或使用 `make([]T, 0)`，而非声明为零值（`var s []T`）。

---

## 第 3 章 截取操作：共享底层数组的双刃剑

### 3.1 截取语法与内存语义

截取（slicing）操作 `s[low:high]` 返回一个新的 slice header，但不复制数据：

```go
original := []int{0, 1, 2, 3, 4, 5, 6, 7}
// original: array=&[0], len=8, cap=8

sub := original[2:5]
// sub: array=&original[2], len=3, cap=6
// sub 的 array 指针指向 original 底层数组的第 3 个元素（索引 2）
// sub 的 cap = 原 cap - low = 8 - 2 = 6
```

```
底层数组：[0][1][2][3][4][5][6][7]
              ^        ^           ^
original.array         .          .
          sub.array    |           |
                     sub 的 len 范围  sub 的 cap 范围
```

**关键认知**：`sub` 和 `original` 共享同一块底层数组内存。修改 `sub` 的元素会影响 `original`，反之亦然：

```go
sub[0] = 99  // 修改 sub[0]，实际修改的是底层数组的 [2] 位置
fmt.Println(original[2])  // 99！sub 的修改穿透到了 original
```

### 3.2 三索引截取：精确控制 cap

Go 1.2 引入了三索引截取 `s[low:high:max]`，允许显式指定子切片的 `cap`：

```go
original := []int{0, 1, 2, 3, 4, 5, 6, 7}
sub := original[2:5:6]
// sub: array=&original[2], len=3, cap=4 (= 6 - 2)
// 注意：cap 受到 max 参数限制，而不是到底层数组末尾

// 为什么需要三索引截取？
// 场景：向 sub 中 append 时，不希望覆盖 original[5] 及之后的元素
// 如果 sub 的 cap 被限制为 4，append 时一旦超出 cap 就会触发扩容（新分配数组）
// 而不是覆盖 original 的后续元素
```

三索引截取是实现"安全子切片"的关键工具，在将子切片传给外部函数时尤为重要。

### 3.3 共享底层数组的典型陷阱

**陷阱一：通过子切片意外修改原切片**

```go
func process(data []int) []int {
    // 对前三个元素做处理，返回处理结果
    result := data[:3]   // result 和 data 共享底层数组！
    result[0] *= 2       // 修改了 data[0]
    return result
}

original := []int{1, 2, 3, 4, 5}
processed := process(original)
fmt.Println(original)   // [2 2 3 4 5]  ← original[0] 被意外修改了！
fmt.Println(processed)  // [2 2 3]
```

解决方法：如果不想共享，使用 `copy` 创建独立副本：

```go
func processSafe(data []int) []int {
    result := make([]int, 3)
    copy(result, data[:3])  // 复制到新的底层数组
    result[0] *= 2
    return result
}
```

**陷阱二：append 到子切片覆盖原切片的数据**

```go
original := []int{1, 2, 3, 4, 5}
sub := original[:3]  // sub.len=3, sub.cap=5（与 original 共享底层数组）

// sub 的 cap(5) > len(3)，append 不会扩容，直接在底层数组写入
sub = append(sub, 99)  // 写入底层数组的位置 [3]，覆盖了 original[3]

fmt.Println(original)  // [1 2 3 99 5]  ← original[3] 被覆盖了！
fmt.Println(sub)       // [1 2 3 99]
```

这个陷阱特别危险，因为 `append` 的调用方不知道 `sub` 是否与别的 slice 共享底层数组。

---

## 第 4 章 append 与扩容策略

### 4.1 append 的基本行为

`append` 是 Go 的内置函数，向 slice 追加元素，返回（可能是新的）slice：

```go
// append 的两种典型用法
s := []int{1, 2, 3}

// 追加单个元素
s = append(s, 4)       // [1, 2, 3, 4]

// 追加多个元素
s = append(s, 5, 6, 7) // [1, 2, 3, 4, 5, 6, 7]

// 追加另一个 slice（用 ... 展开）
other := []int{8, 9}
s = append(s, other...)  // [1, 2, 3, 4, 5, 6, 7, 8, 9]
```

**为什么 `append` 必须返回新的 slice 并赋值给原变量？**

```go
// 错误用法：不接收 append 的返回值
func wrongAppend(s []int) {
    append(s, 42)  // 这行代码什么也没做（编译器会报错：append result not used）
}

// 原因：append 可能需要分配新的底层数组
// 如果旧 cap 不够，新的 array 指针和 cap 只存在于 append 的返回值中
// 不赋值给变量，新的信息就丢失了
```

### 4.2 append 的工作流程

`append` 内部的逻辑可以概念性地描述为：

```go
// append(s, elems...) 的伪实现
func append(s []T, elems ...T) []T {
    newLen := s.len + len(elems)
    
    if newLen <= s.cap {
        // 容量足够：直接在原底层数组后面写入，不分配新内存
        // 只更新 len，array 和 cap 不变
        result := slice{array: s.array, len: newLen, cap: s.cap}
        copy(result[s.len:], elems)
        return result
    }
    
    // 容量不足：需要扩容
    newCap := growSlice(len(elems), s)  // 计算新容量（见下节）
    newArray := mallocgc(newCap * sizeof(T), ...)  // 分配新内存
    
    // 将旧数据和新元素都复制到新内存
    copy(newArray, s[:s.len])
    copy(newArray[s.len:], elems)
    
    return slice{array: newArray, len: newLen, cap: newCap}
}
```

**扩容后，新旧 slice 不再共享底层数组**——这是 `append` 行为中最需要警惕的时间点。

### 4.3 扩容策略：Go 1.18 前后的变化

扩容策略决定了"容量不足时，新容量是多少"。这个策略直接影响 `append` 的性能（扩容次数 vs 内存浪费）。

**Go 1.17 及之前的策略**：

- 若所需容量 > 当前容量的 2 倍，则新容量 = 所需容量（刚好够用）；
- 否则：
  - 当前容量 < 1024：新容量 = 当前容量 × 2；
  - 当前容量 ≥ 1024：每次增加当前容量的 25%，直到够用。

```
旧策略示意（初始 cap=4，每次 append 1 个元素）：
cap 4 → 8 → 16 → 32 → ...  // cap < 1024：每次翻倍
cap 1024 → 1280 → 1600 → ...  // cap ≥ 1024：每次 +25%
```

**Go 1.18 及之后的新策略**：将 1024 这个固定阈值替换为平滑的曲线，避免在阈值处出现扩容比例的突变：

```go
// runtime/slice.go（Go 1.18+，已简化）
func growslice(oldCap, newLen int) int {
    newcap := oldCap
    doublecap := newcap + newcap
    
    if newLen > doublecap {
        // 所需容量超过翻倍：直接用所需容量
        newcap = newLen
    } else {
        const threshold = 256  // 新阈值从 1024 降低到 256
        if oldCap < threshold {
            newcap = doublecap  // 小切片：翻倍
        } else {
            // 平滑增长：从 2x 逐渐过渡到 1.25x
            for newcap < newLen {
                // 公式：newcap += (newcap + 3*threshold) / 4
                // 当 newcap = threshold(256) 时，增量约为 256
                // 随着 newcap 增大，增量占比逐渐减小到约 1.25x
                newcap += (newcap + 3*threshold) >> 2
            }
        }
    }
    return newcap
}
```

新策略的改进之处：在旧策略中，一个 cap=1023 的 slice 扩容时翻倍到 2046，而 cap=1024 时只增加 25% 到 1280——在阈值附近存在明显的跳跃。新策略通过 `(newcap + 3*threshold) / 4` 公式实现平滑过渡。

**注意**：以上是元素个数层面的计算，实际新容量还要经过内存对齐（根据元素大小向上取整到内存分配器的 size class 边界），所以真实的 cap 增长可能与纯数学计算有少许出入：

```go
s := make([]int, 0, 3)
for i := 0; i < 20; i++ {
    s = append(s, i)
    fmt.Printf("len=%d, cap=%d\n", len(s), cap(s))
}
// 输出（64 位系统）：
// len=1, cap=3
// len=2, cap=3
// len=3, cap=3
// len=4, cap=6   ← 扩容（3→6，内存对齐后）
// len=5, cap=6
// len=6, cap=6
// len=7, cap=12  ← 扩容（6→12）
// ...
```

### 4.4 预分配容量：避免频繁扩容

当预先知道 slice 最终大小时，应使用 `make([]T, 0, expectedLen)` 预分配容量，避免 `append` 触发多次扩容（每次扩容都有分配内存 + 复制数据的开销）：

```go
// 反例：不预分配，最终可能触发 log2(n) 次扩容
func collectBad(n int) []int {
    result := []int{}
    for i := 0; i < n; i++ {
        result = append(result, i)
    }
    return result
}

// 正例：预分配，0 次扩容
func collectGood(n int) []int {
    result := make([]int, 0, n)  // 预分配 n 个元素的容量
    for i := 0; i < n; i++ {
        result = append(result, i)
    }
    return result
}
```

对 n=1000000 的场景，基准测试显示预分配版本比不预分配版本快约 3-5 倍，且 GC 压力更低（不预分配版本产生大量短命的中间数组）。

---

## 第 5 章 copy：安全的深度复制

### 5.1 copy 的语义

`copy(dst, src)` 将 `src` 的元素复制到 `dst`，实际复制的元素数为 `min(len(dst), len(src))`，返回复制的元素数：

```go
src := []int{1, 2, 3, 4, 5}
dst := make([]int, 3)

n := copy(dst, src)      // 复制 min(3, 5) = 3 个元素
fmt.Println(n)           // 3
fmt.Println(dst)         // [1, 2, 3]（不含 4, 5）

// dst 和 src 现在是独立的——修改 dst 不影响 src
dst[0] = 99
fmt.Println(src[0])      // 1，不受影响
```

`copy` 可以处理重叠的 slice（如在同一个底层数组内移动元素），Go 运行时会正确处理方向：

```go
s := []int{1, 2, 3, 4, 5}

// 向右移动：将 s[0:3] 复制到 s[1:4]
copy(s[1:], s[:4])  // 等价于 memmove，处理重叠
fmt.Println(s)      // [1, 1, 2, 3, 4]
```

### 5.2 copy vs append 的选择

| 场景 | 推荐方式 |
| --- | --- |
| 追加元素 | `append` |
| 复制整个切片（不想共享）| `copy` 到新 slice |
| 合并两个 slice | `append(s1, s2...)` |
| 截取并独立（不想与原 slice 共享）| `copy` 到子 slice |
| 删除中间元素 | `append(s[:i], s[i+1:]...)` |

---

## 第 6 章 内存陷阱：大切片截取导致的内存泄漏

### 6.1 大切片截取的内存问题

这是 Go 实践中一个较为隐蔽的内存泄漏模式：

```go
// 读取一个大文件（假设文件内容被读入一个大 slice）
bigData := readBigFile()  // bigData: len=1000000, cap=1000000

// 只需要前 10 个元素
result := bigData[:10]
// result: array=&bigData[0], len=10, cap=1000000
// result 的 cap 是 1000000！它持有对整个底层数组的引用！

bigData = nil  // 试图释放 bigData... 但无效！
// 因为 result 仍然通过 array 指针引用着底层数组
// GC 不会回收这块内存，直到 result 也不再被引用

// 最终效果：本来只需要 10 个元素（80 字节），
// 却让 8MB 的内存无法被回收——内存泄漏！
```

### 6.2 解决方案：截取后用 copy 创建独立副本

```go
bigData := readBigFile()

// 正确做法：用 copy 将所需数据复制到独立的小 slice
result := make([]int, 10)
copy(result, bigData[:10])
// result: array 指向新分配的 [10]int，len=10, cap=10
// 与 bigData 的底层数组完全独立

bigData = nil  // bigData 的底层数组现在真的可以被 GC 回收了
```

或者使用 `append` 的零容量技巧（`append` 到一个空 slice，触发扩容，新 slice 与原 slice 无关）：

```go
result := append([]int(nil), bigData[:10]...)  // 复制前 10 个元素到新 slice
```

### 6.3 并发访问共享底层数组的竞态条件

当多个 Goroutine 操作共享底层数组的不同 slice 时，可能产生数据竞争：

```go
// 危险：两个 goroutine 写入共享底层数组的不同位置
original := make([]int, 100)
s1 := original[:50]   // 前 50 个
s2 := original[50:]   // 后 50 个

// 看起来两个 goroutine 操作的是"不同的 slice"
// 但它们共享同一底层数组！
go func() { s1[0] = 1 }()  // 写 original[0]
go func() { s2[0] = 2 }()  // 写 original[50]

// 在 x86 架构上，由于不同位置的写入实际上是独立的内存地址，
// 这段代码大多数情况下"恰好不会崩溃"
// 但对于更小粒度的操作（如两个 slice 元素映射到同一个 cache line），
// 会产生"伪共享"（False Sharing）问题，影响性能
// 更糟糕：如果涉及 slice header 的读写，则有明确的竞态条件
```

> [!warning] 生产避坑：slice 并发安全
> slice 本身不是并发安全的。并发写入 slice（即使写入不同元素）在 Go 的内存模型下是未定义行为，必须通过 `sync.Mutex` 保护或使用 `sync/atomic` 包。`Race Detector`（`go test -race`）可以检测这类问题。

---

## 第 7 章 常见操作的惯用写法

### 7.1 删除元素

```go
s := []int{1, 2, 3, 4, 5}

// 删除索引 i 处的元素（顺序保持不变）
i := 2  // 删除 s[2] = 3
s = append(s[:i], s[i+1:]...)
fmt.Println(s)  // [1, 2, 4, 5]

// 删除索引 i 处的元素（不保持顺序，但更高效）
// 将最后一个元素移到 i 处，然后截短 slice
s[i] = s[len(s)-1]
s = s[:len(s)-1]
```

### 7.2 去重

```go
// 对已排序的 slice 去重
func dedup(sorted []int) []int {
    if len(sorted) == 0 {
        return sorted
    }
    result := sorted[:1]  // 保留第一个元素
    for _, v := range sorted[1:] {
        if v != result[len(result)-1] {
            result = append(result, v)
        }
    }
    return result
}
```

### 7.3 过滤（Filter）

```go
// 原地过滤（复用底层数组）
func filter(s []int, keep func(int) bool) []int {
    result := s[:0]  // 复用底层数组，len=0，cap=len(s)
    for _, v := range s {
        if keep(v) {
            result = append(result, v)
        }
    }
    return result
}

s := []int{1, 2, 3, 4, 5, 6}
even := filter(s, func(n int) bool { return n%2 == 0 })
fmt.Println(even)  // [2, 4, 6]
```

注意：原地过滤会修改原 slice 的底层数组（在过滤的同时覆写），如果原 slice 还会被访问，应先 `copy` 再过滤。

### 7.4 反转

```go
func reverse(s []int) {
    for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
        s[i], s[j] = s[j], s[i]
    }
}
```

---

## 总结

本篇从 slice header 的三元组结构出发，完整梳理了 slice 的核心机制与易错点：

**三元组（array, len, cap）是理解一切的基础**。`len` 决定可访问范围，`cap` 决定 `append` 时是否需要扩容，`array` 指向底层数组——截取操作只创建新 header，不复制数据，两个 header 可以指向同一底层数组的不同段。

**扩容是 slice 行为最大的"变数"**。`append` 在 `len < cap` 时直接写入（共享底层数组），在 `len == cap` 时分配新数组（彻底独立）。Go 1.18 将固定阈值 1024 替换为平滑曲线，避免扩容比例的突变。预知最终大小时用 `make([]T, 0, n)` 预分配，可消除所有扩容开销。

**共享底层数组是最大的陷阱来源**。截取子切片、向子切片 append（cap 充足时）、通过子切片修改元素——都会穿透到原切片。大切片截取后不解除引用会造成内存泄漏，规避方式是 `copy` 到独立的小切片。

**nil slice 和空 slice 的语义差异**在 JSON 序列化等场景下会显现，需要根据具体需求选择合适的初始化方式。

下一篇深入 Go map 的哈希表设计与渐进式扩容：[[05 map 的实现原理——哈希表与渐进式扩容]]。

---

> [!note] 参考资料
> - Go 运行时源码：`runtime/slice.go`
> - Go 语言规范：Slice expressions 章节
> - Go Blog,《Go Slices: usage and internals》: https://go.dev/blog/slices-intro
> - Dave Cheney,《Slices from the ground up》

---

> [!note] 思考题
> 1. `s := make([]int, 0, 1024)` 创建了一个 len=0、cap=1024 的 slice。向其 append 1024 个元素不会触发扩容。但如果执行 `s2 := s[:512]` 再向 s2 append，s2 和 s 是否共享底层数组？什么时候 s2 的修改会影响 s 的数据？这种'共享底层数组'是 slice 最常见的 bug 来源——你有哪些编码习惯来规避？
> 2. Go 1.18 之前，slice 的扩容策略是：cap < 1024 时翻倍，cap >= 1024 时增长 25%。Go 1.18 改用了更平滑的增长曲线。新策略解决了旧策略的什么问题？在一个需要精确控制内存使用量的场景（如嵌入式设备或内存受限容器），你应该使用 `append` 还是预分配 `make([]T, n)`？
> 3. 从一个大 slice 中取一个小子切片 `small := big[0:10]`，如果 `big` 的底层数组很大（比如 100MB），`small` 会阻止 GC 回收整个 100MB。这就是'slice 内存泄漏'。`copy` 和 `append([]T(nil), small...)` 都能解决这个问题。它们在性能和语义上有什么区别？Go 编译器未来有可能自动优化这种场景吗？
