---
title: "类型系统——值类型、引用类型与 struct 组合"
date: 2026-03-04
tags: [Golang, 类型系统, 值类型, 引用类型, struct, 内存布局, 方法集, 指针接收者, 嵌入, Embedding]
aliases: []
---

# 类型系统——值类型、引用类型与 struct 组合

## 摘要

Go 的类型系统是理解整个语言行为的基础，但它与 Java 或 C++ 的类型系统有本质差异，容易让来自其他语言的开发者踩坑。本文深入剖析 Go 类型系统的三个核心维度：**值类型与引用类型的内存语义**——Go 是按值传递（pass by value）的语言，理解不同类型在赋值和函数传参时的行为差异（复制 vs 复制指针），是写出高效正确代码的前提；**struct 的内存布局与对齐**——struct 字段的声明顺序直接影响内存占用大小，内存对齐的规则隐藏着出乎意料的"空洞"；**struct 嵌入与方法集**——嵌入是 Go 代码复用的核心机制，方法集（Method Set）的规则决定了"哪些类型满足哪些接口"，这是一个让很多开发者困惑的领域，本文通过第一性原理逐步推导其规则和背后的设计原因。

---

## 第 1 章 Go 的内存模型基础：一切皆值

### 1.1 Go 是严格按值传递的语言

在深入各类类型之前，必须建立一个核心认知：**Go 是严格按值传递（pass by value）的语言**，没有例外。

每一次赋值（`a = b`）、每一次函数调用时的参数传递，都是**复制**操作——将右侧的值完整地复制一份给左侧。这个规则适用于所有类型，没有任何特殊情况。

这句话听起来简单，但它会引发一个让很多 Go 新手困惑的问题：**如果 map 和 slice 是按值传递的，为什么在函数内修改它们，函数外也能看到变化？**

要回答这个问题，需要理解 Go 类型分类背后的内存语义。

### 1.2 Go 的类型分类：按内部结构而非"引用/值"来划分

Java 有一个简单的划分：基本类型（int、long、double……）是值类型，对象（Object 及其子类）是引用类型。Go 没有这么简单的二分法，它的类型按照**内部是否包含指针**来决定"传递行为"：

**类别一：纯值类型（不含指针，直接存储数据）**

```go
// 这些类型的变量直接存储数据值本身
var i int         = 42
var f float64     = 3.14
var b bool        = true
var r rune        = 'A'      // int32 的别名
var a [3]int      = [3]int{1, 2, 3}  // 数组：固定大小，值传递

// struct 中若所有字段都是纯值类型，整个 struct 也是纯值类型
type Point struct {
    X float64  // 纯值
    Y float64  // 纯值
}
```

这类类型在赋值和传参时，**数据本身**被完整复制。

**类别二：含有指针的类型（表面看是"值"，但内部包含指向数据的指针）**

```go
// slice header：内部包含一个指向底层数组的指针
// 赋值时复制的是 header（3 个字段），不是底层数组
type slice struct {
    array unsafe.Pointer  // 指向底层数组的指针 ← 这是关键
    len   int
    cap   int
}

// map：本质上是一个指向 hmap 结构体的指针
// map 变量本身就是一个指针，赋值时复制的是指针值
type hmap struct { ... }  // map 的真实数据
// var m map[string]int  ← m 变量存储的是 *hmap

// channel：本质上是一个指向 hchan 结构体的指针
type hchan struct { ... }

// 函数值：本质上是一个指向函数代码和闭包变量的指针
// 指针：指针值本身就是一个地址值
```

这类类型在赋值和传参时，**header 或指针值**被复制——但由于 header 内部有指向底层数据的指针，两个 header 副本仍然共享同一份底层数据。这就是为什么修改会"穿透"函数边界。

### 1.3 用具体例子厘清"按值传递"的含义

```go
// 例子一：数组是纯值传递，函数内修改不影响函数外
func modifyArray(a [3]int) {
    a[0] = 100  // 修改的是副本
}

arr := [3]int{1, 2, 3}
modifyArray(arr)
fmt.Println(arr[0])  // 输出 1，不受影响

// 例子二：slice 传参时复制 header，但 header 内的 array 指针指向同一底层数组
func modifySlice(s []int) {
    s[0] = 100   // 通过指针修改底层数组 ← 函数外可见
    s = append(s, 4)  // append 可能创建新底层数组，仅影响 s 这个副本 ← 函数外不可见
}

sl := []int{1, 2, 3}
modifySlice(sl)
fmt.Println(sl[0])  // 100 ← s[0] = 100 可见
fmt.Println(sl)     // [100 2 3]，没有第 4 个元素 ← append 不可见

// 例子三：map 传参时复制指针，两个"指针"指向同一个 hmap
func modifyMap(m map[string]int) {
    m["key"] = 42  // 通过指针修改 hmap 内的数据 ← 函数外可见
}

mp := map[string]int{"key": 0}
modifyMap(mp)
fmt.Println(mp["key"])  // 42 ← 可见

// 例子四：struct 赋值是完整复制
type User struct { Name string; Age int }
u1 := User{Name: "Alice", Age: 30}
u2 := u1  // 完整复制
u2.Name = "Bob"
fmt.Println(u1.Name)  // "Alice"，不受影响
```

理解了"什么被复制"，就能预测每种操作的行为，不再依赖记忆"哪些类型是引用类型"这种模糊的规则。

---

## 第 2 章 struct 的内存布局与对齐

### 2.1 为什么 CPU 对内存对齐有要求

struct 是 Go 中构建复杂数据结构的核心工具。理解 struct 的内存布局，不只是为了优化内存占用，更是为了理解 Go 的类型系统和 unsafe 操作的底层行为。

首先需要理解**为什么要内存对齐**。现代 CPU 在访问内存时，不是按字节随机访问，而是按"字长"（Word Size）对齐的块来读取。在 64 位系统上，CPU 一次能高效读取 8 字节对齐的数据。如果一个 8 字节的数据（如 `int64`）存储在奇数地址（如地址 1）上，CPU 需要两次内存读取才能得到完整数据——第一次读 [0, 7]，第二次读 [8, 15]，然后拼接。某些 CPU 架构（如 ARM）甚至会直接报错（bus error）。

为了避免这种效率损失（或错误），编译器在分配 struct 字段时会自动插入**填充字节（padding）**，使每个字段的起始地址符合其自身大小的对齐要求。

**对齐规则简述**：
- `bool`、`int8`、`uint8`：1 字节对齐，可以放在任意地址；
- `int16`、`uint16`：2 字节对齐，地址必须是 2 的倍数；
- `int32`、`uint32`、`float32`：4 字节对齐；
- `int64`、`uint64`、`float64`、指针（64 位系统）：8 字节对齐；
- struct 的对齐要求 = 其所有字段中对齐要求最大的那个字段。

### 2.2 字段顺序影响 struct 大小：一个出乎意料的例子

```go
// 反例：字段顺序不优化，内存浪费严重
type Bad struct {
    Flag  bool    // 1 字节，放在偏移 0
    // 编译器插入 7 字节 padding（使 ID 对齐到 8 字节边界）
    ID    int64   // 8 字节，偏移 8
    // 编译器插入 3 字节 padding（使 Code 对齐到 4 字节边界）
    Code  int32   // 4 字节，偏移 16? 不对，让我们仔细算...
}

// 实际内存布局（64 位系统）：
// [0]:   Flag (1 byte)
// [1-7]: padding (7 bytes) ← 为了让 ID 从 8 字节对齐的地址开始
// [8-15]: ID (8 bytes)
// [16-19]: Code (4 bytes)
// [20-23]: padding (4 bytes) ← struct 整体大小必须是最大对齐要求(8)的倍数
// 总大小：24 字节

// 验证
bad := Bad{}
fmt.Println(unsafe.Sizeof(bad))  // 输出 24

// 优化：将大字段排在前面，小字段排在后面
type Good struct {
    ID    int64   // 8 字节，偏移 0
    Code  int32   // 4 字节，偏移 8
    Flag  bool    // 1 字节，偏移 12
    // 3 字节 padding（保证 struct 整体 8 字节对齐）
}
// [0-7]:   ID (8 bytes)
// [8-11]:  Code (4 bytes)
// [12]:    Flag (1 byte)
// [13-15]: padding (3 bytes)
// 总大小：16 字节

good := Good{}
fmt.Println(unsafe.Sizeof(good))  // 输出 16
```

同样的三个字段，仅仅调换了声明顺序，内存占用从 24 字节降低到 16 字节，节省了 33%。当这个 struct 在内存中有数百万个实例（如缓存中的条目、大型切片的元素），这个差异会带来显著的内存节省。

> [!warning] 生产避坑
> struct 字段顺序是影响内存占用的隐形因素。在定义频繁使用的数据结构时，建议将大字段（`int64`、指针、`string`、`slice`）放在前面，小字段（`bool`、`int8`、`int16`）放在后面。可以用 `unsafe.Sizeof()` 验证，或使用 `go vet` 的 `fieldalignment` 检查器（需要 `golang.org/x/tools/go/analysis/passes/fieldalignment`）自动检测和修复字段顺序。

### 2.3 空 struct 的特殊性：零大小类型

Go 中一个特殊的类型是**空 struct**（`struct{}`），它的大小为 0 字节：

```go
empty := struct{}{}
fmt.Println(unsafe.Sizeof(empty))  // 0
```

零大小意味着：无论分配多少个 `struct{}` 实例，都不消耗堆内存。这在某些场景下非常有用：

**用途一：Channel 的信号传递**

```go
// 只需要发送信号（"操作完成"），不需要携带数据
done := make(chan struct{})
go func() {
    doWork()
    close(done)  // 或 done <- struct{}{}
}()
<-done  // 等待信号

// 对比：make(chan bool) 虽然也能做到，但 bool 占 1 字节，
// struct{} 占 0 字节，语义更清晰（我们只关心信号，不关心值）
```

**用途二：用 map 模拟 Set**

```go
// Go 没有内置 Set 类型，用 map[T]struct{} 模拟
type StringSet map[string]struct{}

func (s StringSet) Add(item string) {
    s[item] = struct{}{}
}

func (s StringSet) Contains(item string) bool {
    _, ok := s[item]
    return ok
}

set := make(StringSet)
set.Add("golang")
set.Add("python")
fmt.Println(set.Contains("golang"))  // true

// 对比：map[string]bool 也能模拟 Set，但 bool 值的存储有额外开销（虽然很小），
// 而且 map[string]struct{} 的语义更明确——我们只关心 key 是否存在
```

---

## 第 3 章 指针：地址、解引用与 nil

### 3.1 Go 的指针与 C/C++ 的区别

Go 有指针，但比 C/C++ 的指针要"安全"得多：

- **没有指针算术**：不能做 `ptr + 1` 这样的操作（除非通过 `unsafe.Pointer`）；
- **自动垃圾回收**：不需要 `free` 或 `delete`，GC 负责回收不再使用的内存；
- **垃圾回收安全**：GC 知道哪些内存被指针引用，不会回收有指针指向的内存；
- **nil 检查**：对 nil 指针解引用会 panic（而非未定义行为）。

```go
// 基本指针操作
x := 42
p := &x       // p 是 *int，存储 x 的地址
fmt.Println(*p)   // 解引用：输出 42
*p = 100          // 通过指针修改 x 的值
fmt.Println(x)    // 100

// new() 分配零值并返回指针
p2 := new(int)  // *int，指向一个初始值为 0 的 int
*p2 = 50

// nil 指针解引用会 panic
var p3 *int  // p3 的零值是 nil
// *p3 = 1  // 运行时 panic: nil pointer dereference
```

### 3.2 什么时候该用指针

Go 中"用指针还是用值"是一个经常需要决策的问题，规则比 C++ 简单，但仍需要理解背后的权衡：

**规则一：修改调用方的变量，必须用指针**

```go
// 值接收者：修改的是副本，调用方看不到变化
func incrementByValue(n int) {
    n++
}

// 指针接收者：修改的是原始变量
func incrementByPointer(n *int) {
    *n++
}

x := 10
incrementByValue(x)
fmt.Println(x)  // 10，没变

incrementByPointer(&x)
fmt.Println(x)  // 11，改变了
```

**规则二：大型 struct 传参，用指针避免复制开销**

```go
// 如果 LargeConfig 有几百个字段，每次函数调用都完整复制代价昂贵
type LargeConfig struct {
    // ... 很多字段
}

// 低效：每次调用复制整个 struct
func processConfig(cfg LargeConfig) { ... }

// 高效：传递指针，只复制 8 字节（指针大小）
func processConfig(cfg *LargeConfig) { ... }
```

**规则三：需要表示"可选/不存在"的语义，用指针（或 Go 1.18+ 用泛型的 Optional）**

```go
// *string 可以表示"有值的字符串"和"无值（nil）"两种状态
// 而 string 的零值 "" 无法区分"空字符串"和"未设置"
type UserProfile struct {
    Name        string
    Nickname    *string  // nil 表示"未设置昵称"，"" 表示"设置了空昵称"
    PhoneNumber *string
}
```

**规则四：实现接口时，大多数情况应用指针接收者**（详见下节）

---

## 第 4 章 struct 的方法与方法集

### 4.1 值接收者 vs 指针接收者

Go 的方法（Method）是绑定了接收者的函数。接收者有两种形式：值接收者（Value Receiver）和指针接收者（Pointer Receiver）：

```go
type Counter struct {
    count int
}

// 值接收者：接收 Counter 的副本
func (c Counter) Value() int {
    return c.count
}

// 指针接收者：接收 *Counter（指向原 Counter 的指针）
func (c *Counter) Increment() {
    c.count++  // 修改原始 Counter
}

// 使用
counter := Counter{count: 0}

counter.Increment()          // Go 自动取地址：等价于 (&counter).Increment()
counter.Increment()
fmt.Println(counter.Value()) // 2

// 用指针调用值接收者方法也合法
p := &counter
fmt.Println(p.Value())       // Go 自动解引用：等价于 (*p).Value()
```

Go 编译器会自动在值和指针接收者之间做转换（当且仅当变量是可寻址的，即变量在内存中有地址，而非临时值）：

```go
// 自动取地址：从值调用指针接收者方法（变量必须可寻址）
counter.Increment()  // 合法：counter 是可寻址的变量

// 不能自动取地址：临时值（不可寻址）调用指针接收者方法
Counter{}.Increment()  // 编译错误：cannot take the address of Counter{}
```

### 4.2 方法集（Method Set）：决定接口满足关系的规则

**方法集**是 Go 类型系统中最容易让人困惑的概念之一，但它是理解"为什么某个类型满足某个接口，而另一个不满足"的关键。

**方法集的定义**：一个类型的方法集是它能调用的所有方法的集合。规则如下：

| 类型 | 方法集包含 |
| --- | --- |
| `T`（值类型）| 只包含值接收者方法（`func (t T) method()`）|
| `*T`（指针类型）| 包含值接收者方法 + 指针接收者方法 |

等等——为什么 `T` 不能调用指针接收者方法？不是说 Go 编译器会"自动取地址"吗？

**自动取地址的前提是"变量可寻址"**。接口值内部存储的是**值的副本**，这个副本不一定可寻址（Go 规范明确规定接口存储的值不可取地址）。因此，接口的方法集不能包含指针接收者方法——否则编译器无法保证能安全地对接口内存储的值取地址。

这个规则导致了一个常见的编译错误：

```go
type Writer interface {
    Write(data []byte) error
}

type FileWriter struct {
    path string
}

// 指针接收者方法
func (fw *FileWriter) Write(data []byte) error {
    // ... 写文件
    return nil
}

// 问题：FileWriter（值类型）的方法集不包含指针接收者方法 Write
// 所以 FileWriter 不满足 Writer 接口，但 *FileWriter 满足

var w Writer = FileWriter{path: "/tmp/out.txt"}  // 编译错误！
// 错误信息：FileWriter does not implement Writer
//           (Write method has pointer receiver)

var w Writer = &FileWriter{path: "/tmp/out.txt"}  // 正确：*FileWriter 满足 Writer
```

**为什么这样设计？** 设想如果 `T` 的方法集也包含指针接收者方法：

```go
var w Writer = FileWriter{...}  // 如果这行合法
w.Write(data)  // 编译器会怎么做？
// 需要对接口内存储的 FileWriter 副本取地址
// 但这个副本是接口内部的，外部代码无法访问这个地址
// 如果 Write 通过指针修改了 FileWriter 的状态，这个修改发生在副本上
// 对原始变量不可见——这会导致极其难以调试的 bug
```

这个规则虽然让某些情况下需要多写一个 `&`，但它确保了接口方法的行为是一致且可预测的——通过接口调用指针接收者方法，一定是在原始对象上操作，而不是某个看不见的副本上。

> [!info] 核心概念：方法集的记忆口诀
> - 值类型 `T`：只有值接收者方法才属于 `T` 的方法集；
> - 指针类型 `*T`：值接收者方法和指针接收者方法都属于 `*T` 的方法集；
> - **结论：如果一个方法需要修改接收者状态，用指针接收者；实现接口时，通常用指针类型（`*T`）来满足接口，以确保方法集完整。**

---

## 第 5 章 struct 嵌入（Embedding）的深层机制

### 5.1 嵌入的本质：字段提升（Field Promotion）

在[[01 Go 语言设计哲学——简单背后的取舍]]中，我们从哲学角度介绍了嵌入作为继承替代品的设计动机。本节深入嵌入的底层机制。

struct 嵌入在语法上是声明一个**匿名字段**（Anonymous Field）——只有类型名，没有字段名：

```go
type Base struct {
    ID   int
    Name string
}

func (b Base) Describe() string {
    return fmt.Sprintf("ID=%d, Name=%s", b.ID, b.Name)
}

func (b *Base) SetName(name string) {
    b.Name = name
}

type Derived struct {
    Base         // 嵌入：匿名字段，类型名 Base 同时充当字段名
    ExtraField string
}
```

嵌入触发**字段提升**和**方法提升**：`Derived` 的实例可以直接访问 `Base` 的字段和方法，就好像这些字段和方法是 `Derived` 自己的一样：

```go
d := Derived{
    Base:       Base{ID: 1, Name: "test"},
    ExtraField: "extra",
}

// 字段提升：直接访问 Base 的字段
fmt.Println(d.ID)           // 1（提升访问）
fmt.Println(d.Base.ID)      // 1（显式访问，等价）

// 方法提升：直接调用 Base 的方法
fmt.Println(d.Describe())   // "ID=1, Name=test"（值接收者方法提升）
d.SetName("updated")        // 指针接收者方法也提升
fmt.Println(d.Name)         // "updated"
```

**关键认知**：提升仅仅是语法糖。`d.Describe()` 在底层等价于 `d.Base.Describe()`。Go 没有为提升创建任何特殊的运行时机制——它只是编译器自动将 `d.MethodName()` 重写为 `d.EmbeddedField.MethodName()`。

### 5.2 嵌入与接口满足

嵌入最重要的应用之一是**通过嵌入"继承"接口满足**：如果被嵌入的类型满足某接口，且嵌入该类型的 struct 没有覆写该接口的方法，那么该 struct 也自动满足该接口：

```go
type Stringer interface {
    String() string
}

type Animal struct {
    Name string
}

// Animal 满足 Stringer
func (a Animal) String() string {
    return "Animal: " + a.Name
}

type Pet struct {
    Animal        // 嵌入 Animal
    Owner string
}

// Pet 没有定义自己的 String() 方法
// 但因为嵌入了满足 Stringer 的 Animal，Pet 也满足 Stringer

var s Stringer = Pet{Animal: Animal{Name: "Buddy"}, Owner: "Alice"}
fmt.Println(s.String())  // "Animal: Buddy"
```

如果 `Pet` 定义了自己的 `String()` 方法，则覆写嵌入的方法：

```go
// 覆写：Pet 自己的 String() 优先级高于 Animal 的 String()
func (p Pet) String() string {
    return fmt.Sprintf("Pet{%s, owner: %s}", p.Name, p.Owner)
}

fmt.Println(s.String())  // "Pet{Buddy, owner: Alice}"
```

这就是 Go 的"覆写"机制——不是通过 `override` 关键字声明，而是通过"在外层类型定义同签名方法"来实现。

### 5.3 嵌入多个类型：名称冲突的解决规则

一个 struct 可以嵌入多个类型，但如果多个被嵌入类型有同名的字段或方法，会发生冲突：

```go
type A struct { Name string }
type B struct { Name string }

type C struct {
    A
    B
}

c := C{A: A{Name: "from A"}, B: B{Name: "from B"}}

// c.Name  // 编译错误！ambiguous selector c.Name
// 解决：显式指定来自哪个嵌入类型
fmt.Println(c.A.Name)  // "from A"
fmt.Println(c.B.Name)  // "from B"
```

Go 的冲突解决规则：
1. **外层优先**：如果 `C` 自己定义了 `Name` 字段，优先级最高，不冲突；
2. **深度相同时报错**：如果两个嵌入类型在同一层级都有 `Name`，编译报错（需要显式指定）；
3. **浅层优先**：如果一个嵌入类型直接有 `Name`，另一个的嵌入类型的嵌入类型才有 `Name`，则浅层的优先（不报错）。

### 5.4 嵌入接口：扩展接口与组合接口

嵌入不仅能用在 struct 中，也能用在接口中，实现接口的组合：

```go
// 接口嵌入：组合多个接口为一个更大的接口
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

// ReadWriter 组合了 Reader 和 Writer 的所有方法
type ReadWriter interface {
    Reader  // 嵌入 Reader 接口
    Writer  // 嵌入 Writer 接口
}
// 等价于：
// type ReadWriter interface {
//     Read(p []byte) (n int, err error)
//     Write(p []byte) (n int, err error)
// }
```

`io.ReadWriter`、`io.ReadWriteCloser`、`io.ReadWriteSeeker` 都是 Go 标准库中通过接口嵌入组合的典型例子。这种方式让接口可以"按需组合"，调用方可以接受最小必要接口——这是 [[ISP（接口隔离原则）]] 在 Go 中最自然的体现。

---

## 第 6 章 类型别名 vs 类型定义：两种创建新类型的方式

### 6.1 类型定义：创建全新类型

`type NewType OldType` 创建的是一个**全新的类型**——即使底层类型相同，它们也不兼容：

```go
type Celsius    float64  // 摄氏度：基于 float64 的新类型
type Fahrenheit float64  // 华氏度：基于 float64 的另一个新类型

c := Celsius(100.0)
f := Fahrenheit(212.0)

// 不能直接赋值或比较（即使底层都是 float64）
// c = f  // 编译错误：cannot use f (type Fahrenheit) as type Celsius

// 需要显式类型转换
c2 := Celsius(f)  // 合法，但语义不正确（只是类型强转，不是温度换算）
```

类型定义还可以给新类型添加方法：

```go
func (c Celsius) ToFahrenheit() Fahrenheit {
    return Fahrenheit(c*9/5 + 32)
}

fmt.Println(c.ToFahrenheit())  // 212
```

这是 Go 中"新类型添加语义约束"的标准做法——通过定义新类型，编译器防止了不同语义的数据被混用（如摄氏度和华氏度），提供了编译期的类型安全检查。

### 6.2 类型别名：完全透明的别名

`type Alias = ExistingType` 创建的是**类型别名**——`Alias` 和 `ExistingType` 完全等价，可以相互赋值：

```go
type MyString = string  // 别名，不是新类型

var s MyString = "hello"
var t string = s  // 合法，不需要转换
```

类型别名主要用于以下场景：

- **大型重构时的渐进迁移**：将 `package a` 中的 `Type` 移动到 `package b`，在 `package a` 中保留 `type Type = b.Type` 作为别名，避免大量调用方需要立即修改；
- **跨包的类型暴露**：在公共 API 包中用别名暴露内部包的类型；
- **`rune` 和 `byte`** 本质上就是类型别名：`type byte = uint8` 和 `type rune = int32`。

---

## 总结

本篇从内存语义出发，系统梳理了 Go 类型系统的三个核心层面：

**值传递与指针传递的本质**：Go 是严格按值传递的语言，"引用类型"的神奇之处在于其内部包含指向底层数据的指针，传递时复制的是指针（或含有指针的 header），而非数据本身。理解"什么被复制"，就能准确预测赋值和函数调用的行为。

**struct 的内存布局**：字段的声明顺序直接影响 struct 的内存大小——编译器会插入 padding 字节以满足对齐要求。将大字段排前、小字段排后可以显著减少内存浪费。空 struct `struct{}` 是零大小类型，是信号 Channel 和 Set 实现的惯用选择。

**方法集与接口满足的规则**：值类型 `T` 的方法集只含值接收者方法；指针类型 `*T` 的方法集含值接收者和指针接收者方法。这条规则决定了"哪种类型满足哪个接口"，背后的设计原因是防止通过接口调用指针接收者方法时修改的是看不见的副本。实践中，大多数场景应该用 `*T` 来实现接口。struct 嵌入是 Go 代码复用的核心机制，通过字段/方法提升实现，本质是编译期语法糖，不涉及运行时的特殊机制。

下一篇深入 Go 接口的底层实现——为什么接口赋值需要关注 nil 接口和 nil 指针的区别，`iface` 和 `eface` 的内存结构是什么，类型断言在底层是如何实现的：[[03 接口的实现原理——iface、eface 与鸭子类型]]。

---

> [!note] 参考资料
> - Go 语言规范：https://go.dev/ref/spec（类型系统章节）
> - Go 内存模型：https://go.dev/ref/mem
> - Dave Cheney,《High Performance Go Workshop》（内存对齐与 struct 优化）
> - Russ Cox,《Go Data Structures》（slice/map 内部结构）

---

> [!note] 思考题
> 1. Go 中 slice、map、channel 被称为'引用类型'，但严格来说它们是包含指针的值类型（slice header 是 {pointer, len, cap}，map 是指向 hmap 的指针）。将一个 slice 作为函数参数传递时，函数内部 `append` 导致扩容后，调用方看到的 slice 会改变吗？为什么？这个行为与 Java 传递 ArrayList 引用有什么本质区别？
> 2. struct embedding 在 Go 中实现了方法的'提升'（promotion）——外层 struct 可以直接调用被嵌入 struct 的方法。但如果外层 struct 和被嵌入 struct 有同名方法，会发生什么？如果同时嵌入两个 struct 且都有同名方法呢？Go 编译器如何解决这种歧义？
> 3. Go 的 struct 内存布局遵循字段对齐规则（alignment）。一个包含 `bool`(1B)、`int64`(8B)、`bool`(1B) 三个字段的 struct 实际占用多少字节？如果调整字段顺序为 `bool`、`bool`、`int64`，占用又是多少？`unsafe.Sizeof` 和 `unsafe.Alignof` 的结果能帮你优化 struct 布局吗？
