---
title: "Go 错误处理哲学——从 error 到 errors.Is 与 errors.As"
date: 2026-03-04
tags: [error, errors, errors.As, errors.Is, fmt.Errorf, Golang, panic, recover, 工程实践, 错误包装, 错误处理]
aliases: []
---

# Go 错误处理哲学——从 error 到 errors.Is 与 errors.As

**摘要：**

Go 的错误处理是语言中争议最多、也最能体现其设计哲学的部分。与 Java 的受检异常（checked exception）、Python 的 try/except 不同，Go 将错误作为**普通的返回值**——`func Read() (int, error)` 中的 `error` 与 `int` 平等，没有特殊的语言机制，不能被忽略（不赋值给 `_` 就是编译警告）。这种设计让错误处理变得显式、可见，代价是大量重复的 `if err != nil` 样板代码。Go 1.13（2019年）引入了**错误包装（Error Wrapping）**，`fmt.Errorf("%w", err)` 和 `errors.Is`、`errors.As` 函数彻底改变了 Go 错误处理的最佳实践：调用链上每一层都可以包装错误（添加上下文信息），最上层可以精确地检查错误链中是否包含特定的错误类型或值。本文从 `error` 接口的本质出发，剖析错误包装的实现机制，梳理哨兵错误、自定义错误类型、`fmt.Errorf %w` 三种错误定义范式，以及 `panic/recover` 的合理使用边界。文章最后回到一个设计认知：Go 错误处理的哲学是"显式优于隐式"——错误是普通返回值，不是异常；错误处理在每个调用点显式决策，不是隐藏在 catch 块；错误链通过 Unwrap 显式传递，不是隐式抛出。这个"显式优于隐式"让 Go 的错误处理可见、可控、可审计，是 Go 工程哲学的核心体现。

---

## 第 1 章 error 接口：Go 错误处理的基石

### 1.1 error 是什么

`error` 在 Go 中只是一个内置接口：

```go
// builtin/builtin.go
type error interface {
    Error() string
}
```

任何实现了 `Error() string` 方法的类型都满足 `error` 接口。这与 Go 的整体设计一致：通过接口而非继承来表达多态。`error` 的零值是 `nil`，表示"没有错误"——这是 Go 中最广泛使用的 `nil` 语义。

`errors.New` 是创建最简单错误值的标准函数：

```go
// errors/errors.go
func New(text string) error {
    return &errorString{text}
}

type errorString struct {
    s string
}

func (e *errorString) Error() string {
    return e.s
}
```

注意 `New` 返回的是 `*errorString`（指针），而不是 `errorString`（值）。这是刻意设计——每次 `errors.New("same text")` 都返回一个新的指针，两个不同调用返回的错误指针不相等，即使文本相同。这使得错误比较可以精确到"是否是同一个错误实例"，而不是"是否有相同的错误消息"。

这个"指针保证唯一性"是 Go 错误比较的基础——哨兵错误（如 `io.EOF`）是全局唯一的指针，比较 `err == io.EOF` 实际上是比较指针。如果 `errors.New` 返回值类型，两个 `errors.New("EOF")` 会相等（值相等），导致错误的"误匹配"。指针让每个错误实例唯一，比较精确。

### 1.2 显式错误处理的设计哲学

Go 选择显式错误返回而非异常（exception）的核心理由：

**理由一：错误是预期内的正常分支，不是异常**。在网络编程中，连接超时是完全正常的情况，不是"异常"；在文件操作中，文件不存在是完全正常的情况。Java 的异常机制让这些"正常的错误"看起来像"程序崩溃"，强迫开发者用 try/catch 包裹，且 unchecked exception 可以在任何地方抛出，调用者无法从函数签名知道可能有哪些错误。

**理由二：强迫开发者在每个错误发生的地方做决策**。`if err != nil` 是一个强制检查点——你必须在这里决定：是直接返回？是包装上下文再返回？还是处理掉（如有默认值可用）？这让错误处理策略在代码中显式可见，而不是隐藏在 catch 块里（可能在几百行之外）。

**理由三：错误与控制流清晰分离**。Go 的函数签名 `func (T, error)` 清楚地表达了"这个函数可能失败，失败时返回 error"，不需要查阅文档或运行时才知道。

**代价**：大量重复的 `if err != nil { return nil, err }` 样板代码。Go 社区多次讨论过语法糖来减少这种重复（如提案中的 `?` 操作符），但 Go 团队的立场是：显式优于隐式，代价可以接受。

这个"显式优于隐式"是 Go 错误处理的根本哲学——Go 宁可让代码冗长，也要让错误处理可见。这个"冗长但可见"与 Java 的"简洁但隐藏"形成对比——Java 的 try/catch 让错误处理看起来简洁，但错误可能被忽略（空 catch 块），错误传播路径不清晰（unchecked exception 可以跨层抛出）。Go 的 `if err != nil` 虽然冗长，但每个错误处理点都显式可见，错误传播路径清晰。

---

## 第 2 章 错误包装：Go 1.13 的重大改进

### 2.1 包装前的痛点：错误信息 vs 错误类型检查

Go 1.13 之前，向错误中添加上下文信息的常见方式是用 `fmt.Errorf` 格式化：

```go
// Go 1.12 及之前：添加上下文
func readConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("readConfig: %v", err)  // %v 直接格式化错误消息
    }
    // ...
}
```

这种方式的问题：原始错误被"埋葬"在字符串中了。假设调用链是：

```
main() → loadService() → readConfig() → os.ReadFile() → 底层文件 IO 错误
```

经过每一层的 `fmt.Errorf("%v", err)` 包装后，最终错误消息可能是：

```
loadService: readConfig: readConfig: open /etc/config.yaml: no such file or directory
```

调用者能读懂错误消息，但无法通过代码**检查原始错误类型**：

```go
// 错误：无法正确检查被包装的错误
err := loadService()
if err == os.ErrNotExist {  // 永远是 false！错误已被包装成 string
    // 提供更友好的提示
}
```

这迫使开发者要么不添加上下文（错误消息无用），要么放弃精确的错误类型检查（只能字符串匹配，脆弱）。这个"信息 vs 类型检查"的二选一是 Go 1.13 之前错误处理的核心痛点——你要么有好的错误消息（但无法程序化检查），要么有程序化检查能力（但错误消息缺乏上下文）。

### 2.2 fmt.Errorf %w：错误包装的标准方式

Go 1.13 给 `fmt.Errorf` 添加了 `%w` 动词：

```go
// Go 1.13+：用 %w 包装错误（保留原始错误的引用）
func readConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("readConfig %s: %w", path, err)  // %w 包装
    }
    // ...
}
```

`%w` 与 `%v` 的区别：
- `%v`：将 `err.Error()` 的字符串值嵌入新的错误消息，原始错误与新错误没有结构关系；
- `%w`：创建一个新的错误，它的 `Error()` 方法返回格式化后的字符串，同时通过 `Unwrap()` 方法保存原始错误的引用。

```go
// fmt.Errorf %w 生成的错误的等效实现：
type wrappedError struct {
    msg string
    err error  // 原始错误的引用
}

func (e *wrappedError) Error() string { return e.msg }
func (e *wrappedError) Unwrap() error { return e.err }  // 关键：暴露原始错误
```

`Unwrap()` 接口（`interface{ Unwrap() error }`）是 Go 1.13 引入的非官方接口——任何实现了 `Unwrap() error` 方法的错误类型，都可以被 `errors.Is` 和 `errors.As` 沿链解包。这个"Unwrap 链"是 Go 1.13 错误包装的核心机制——错误通过 Unwrap 链形成"错误链"，`errors.Is` 和 `errors.As` 沿链查找，让"添加上下文"与"精确错误检查"不再互斥。

### 2.3 errors.Is：在错误链中查找特定值

`errors.Is(err, target)` 检查 `err` 或其 Unwrap 链中是否存在与 `target` 相等的错误：

```go
// 用法示例
data, err := os.ReadFile("/etc/config.yaml")
if errors.Is(err, os.ErrNotExist) {
    // 文件不存在，使用默认配置
    return defaultConfig(), nil
}
if errors.Is(err, os.ErrPermission) {
    // 权限不足，返回明确的错误
    return nil, fmt.Errorf("no permission to read config: %w", err)
}
if err != nil {
    return nil, fmt.Errorf("read config: %w", err)
}
```

**`errors.Is` 的比较逻辑**：

```go
// errors/wrap.go（简化）
func Is(err, target error) bool {
    if target == nil {
        return err == target
    }
    isComparable := reflectlite.TypeOf(target).Comparable()
    for {
        if isComparable && err == target {
            return true  // 直接相等
        }
        // 检查 err 是否实现了自定义 Is 方法（允许自定义比较逻辑）
        if x, ok := err.(interface{ Is(error) bool }); ok && x.Is(target) {
            return true
        }
        // Unwrap 继续向下查找
        switch x := err.(type) {
        case interface{ Unwrap() error }:
            err = x.Unwrap()
        case interface{ Unwrap() []error }:
            // 多重包装（Go 1.20，见下文）
            for _, e := range x.Unwrap() {
                if Is(e, target) {
                    return true
                }
            }
            return false
        default:
            return false
        }
    }
}
```

**`errors.Is` vs `==` 直接比较**：对于哨兵错误（全局变量），直接 `err == io.EOF` 可以工作，但如果 `err` 是被 `%w` 包装过的，`==` 就失败了。`errors.Is` 会沿链解包，即使错误被多层包装，也能找到原始的哨兵错误。**应始终用 `errors.Is` 替代 `==` 来比较错误**。

这个"始终用 errors.Is 替代 =="是 Go 1.13 后的错误处理最佳实践——`errors.Is` 能处理包装链，`==` 不能。即使当前错误没有被包装，用 `errors.Is` 也是更安全的选择——未来如果有人加了包装层，`==` 会悄悄失败，`errors.Is` 仍然工作。

### 2.4 errors.As：在错误链中提取特定类型

`errors.As(err, &target)` 在错误链中查找第一个可以赋值给 `target` 类型的错误：

```go
// 自定义错误类型
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation error on field %s: %s", e.Field, e.Message)
}

// 使用 errors.As 提取自定义错误
func handleRequest(req *Request) error {
    if err := validate(req); err != nil {
        var ve *ValidationError
        if errors.As(err, &ve) {
            // ve 现在是 *ValidationError 类型，可以访问 Field 和 Message
            return fmt.Errorf("bad request: field %q %s", ve.Field, ve.Message)
        }
        return fmt.Errorf("validation failed: %w", err)
    }
    return nil
}
```

**`errors.As` vs 类型断言**：直接类型断言 `err.(*ValidationError)` 在错误被包装后会失败；`errors.As` 会沿错误链查找，即使 `ValidationError` 被多层 `fmt.Errorf("%w")` 包装，也能找到并提取。

这个"errors.As 沿链查找类型"是 Go 1.13 错误包装的另一半能力——`errors.Is` 查找值（哨兵错误），`errors.As` 查找类型（自定义错误类型）。两者配合，让错误链中的任何错误都能被精确识别和提取，无论被包装了多少层。

---

## 第 3 章 三种错误定义范式

### 3.1 哨兵错误（Sentinel Error）

**哨兵错误（Sentinel Error）** 是包级别的全局 `error` 变量，用于表示特定的已知错误条件：

```go
// 标准库中的哨兵错误示例
var (
    io.EOF              = errors.New("EOF")
    os.ErrNotExist     = errors.New("file does not exist")
    os.ErrPermission   = errors.New("permission denied")
    sql.ErrNoRows      = errors.New("sql: no rows in result set")
    context.Canceled   = errors.New("context canceled")
    context.DeadlineExceeded = deadlineExceededError{}
)
```

哨兵错误的使用场景：表示一个**预期内的、明确的终止条件**，调用者需要检查并作出不同的决策。

```go
// 哨兵错误的正确使用
for {
    n, err := r.Read(buf)
    if errors.Is(err, io.EOF) {
        break  // 正常结束，不是真正的错误
    }
    if err != nil {
        return fmt.Errorf("read: %w", err)
    }
    process(buf[:n])
}
```

**哨兵错误的命名约定**：标准库中以 `Err` 开头（`io.EOF` 是历史遗留的例外），如 `os.ErrNotExist`、`sql.ErrNoRows`。自定义包中应遵循同样约定：

```go
// 业务代码中的哨兵错误
var (
    ErrUserNotFound    = errors.New("user not found")
    ErrEmailDuplicate  = errors.New("email already exists")
    ErrInsufficientBalance = errors.New("insufficient balance")
)
```

**哨兵错误的局限**：无法携带额外的上下文信息（如"哪个用户不存在"）。如果需要上下文，使用自定义错误类型。这个"哨兵错误无上下文"是它的根本局限——哨兵错误是全局唯一的值，所有"用户不存在"的情况都返回同一个 `ErrUserNotFound`，无法区分"是哪个用户不存在"。需要上下文时，必须用自定义错误类型。

### 3.2 自定义错误类型

当错误需要携带额外的结构化信息时，定义自定义 struct 类型：

```go
// 带结构化信息的自定义错误
type NotFoundError struct {
    Resource string  // 资源类型
    ID       string  // 资源 ID
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s with id %q not found", e.Resource, e.ID)
}

// 使用时
func (r *UserRepository) FindByID(ctx context.Context, id string) (*User, error) {
    user, ok := r.store[id]
    if !ok {
        return nil, &NotFoundError{Resource: "user", ID: id}
    }
    return user, nil
}

// 调用方
user, err := repo.FindByID(ctx, "user-123")
if err != nil {
    var nfe *NotFoundError
    if errors.As(err, &nfe) {
        // 可以访问结构化信息
        log.Printf("resource %s (id=%s) not found", nfe.Resource, nfe.ID)
        return http.StatusNotFound, "resource not found"
    }
    return http.StatusInternalServerError, "internal error"
}
```

**自定义错误类型的命名约定**：以 `Error` 结尾（`*ValidationError`、`*NotFoundError`、`*TimeoutError`）。

**指针接收者 vs 值接收者**：`Error()` 方法通常使用指针接收者（`*MyError`），这样 `errors.As(err, &target)` 中 `target` 是 `*MyError` 类型，对应于实际存储的 `*MyError` 指针——类型断言可以成功。如果用值接收者 (`MyError`)，则 `errors.As` 的 target 类型需要是 `*MyError` 指向的接口，略复杂。生产代码中**始终用指针接收者**定义错误类型是更安全的选择。

### 3.3 fmt.Errorf %w：轻量级上下文包装

对于不需要结构化字段、只需要添加文字上下文的场景，`fmt.Errorf("%w", err)` 是最简洁的方式：

```go
func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        // 添加 service 层的上下文，同时保留原始错误（*NotFoundError 或其他）
        return nil, fmt.Errorf("UserService.GetUser id=%s: %w", id, err)
    }
    return user, nil
}
```

包装后的错误消息清晰展示了调用链：

```
UserService.GetUser id=user-123: user with id "user-123" not found
```

同时调用方仍然可以通过 `errors.As(err, &nfe)` 提取原始的 `*NotFoundError`——两全其美。

**三种范式的选择矩阵**：

| 场景 | 推荐方式 |
| --- | --- |
| 表示已知的终止条件（如 EOF）| 哨兵错误（`var ErrXxx = errors.New(...)`）|
| 错误需要携带结构化字段 | 自定义错误类型（`type XxxError struct{}`）|
| 只需添加文字上下文 | `fmt.Errorf("context: %w", err)` |
| 同时需要结构化字段和上下文链 | 自定义类型 + 实现 `Unwrap() error` |

这个"三种范式按场景选择"是 Go 错误定义的实用框架——简单终止条件用哨兵错误，需要结构化信息用自定义类型，只需文字上下文用 `fmt.Errorf %w`。不是所有错误都需要自定义类型，按需选择最合适的方式。

---

## 第 4 章 错误处理的工程实践

### 4.1 错误包装的层次：每层只加一次上下文

一个常见的反模式是每层都重复添加相同的上下文：

```go
// 反模式：重复堆叠上下文
func (r *Repo) FindUser(id string) (*User, error) {
    u, err := r.db.Query(...)
    if err != nil {
        return nil, fmt.Errorf("FindUser: %w", err)  // 加了 FindUser
    }
    return u, nil
}

func (s *Service) GetUser(id string) (*User, error) {
    u, err := s.repo.FindUser(id)
    if err != nil {
        return nil, fmt.Errorf("GetUser: FindUser: %w", err)  // 又加了 GetUser: FindUser
    }
    return u, nil
}

func (h *Handler) UserDetail(w http.ResponseWriter, r *http.Request) {
    u, err := h.svc.GetUser(id)
    if err != nil {
        log.Printf("UserDetail: GetUser: FindUser: db error: %v", err)  // 错误消息已经很长了
    }
}
```

最终错误消息变成了：`UserDetail: GetUser: FindUser: query: ...`——调用链都展示在错误消息里，信息是有的，但太冗余。

**正确做法：每层只加一次有意义的上下文（输入参数、操作名），不要重复调用链的层次**：

```go
func (r *Repo) FindUser(id string) (*User, error) {
    u, err := r.db.QueryRowContext(ctx, "SELECT ...", id)
    if err != nil {
        return nil, fmt.Errorf("query user id=%s: %w", id, err)  // 加入关键参数
    }
    return u, nil
}

func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    u, err := s.repo.FindUser(id)
    if err != nil {
        // 不需要再加 "GetUser"，直接透传（repo 层已经有足够的上下文）
        return nil, err
        // 或者只加 service 特有的上下文：
        return nil, fmt.Errorf("get user for request %s: %w", requestID, err)
    }
    return u, nil
}
```

这个"每层只加一次有意义上下文"是错误包装的核心原则——上下文应该是"这个层特有的信息"（如输入参数、操作名），而不是"调用链的层次名"（如"GetUser"、"FindUser"）。调用链信息已经在错误链的 Unwrap 结构中，不需要在消息中重复。

### 4.2 错误日志：只在最顶层记录一次

**原则：错误只在能做出最终决策的那一层记录日志，中间层只包装后向上透传。**

```go
// 错误模式：每层都记录日志
func (r *Repo) FindUser(id string) (*User, error) {
    u, err := db.Query(...)
    if err != nil {
        log.Printf("ERROR repo.FindUser: %v", err)  // 日志 1
        return nil, fmt.Errorf("find user: %w", err)
    }
    return u, nil
}

func (s *Service) GetUser(id string) (*User, error) {
    u, err := s.repo.FindUser(id)
    if err != nil {
        log.Printf("ERROR service.GetUser: %v", err)  // 日志 2（重复！）
        return nil, fmt.Errorf("get user: %w", err)
    }
    return u, nil
}

// 结果：同一个错误被记录了 2-3 次，日志里出现大量重复
```

```go
// 正确模式：中间层透传，顶层记录
func (r *Repo) FindUser(id string) (*User, error) {
    u, err := db.Query(...)
    if err != nil {
        return nil, fmt.Errorf("find user id=%s: %w", id, err)  // 只包装，不记录
    }
    return u, nil
}

func (s *Service) GetUser(id string) (*User, error) {
    u, err := s.repo.FindUser(id)
    if err != nil {
        return nil, err  // 直接透传（或加 service 特有上下文）
    }
    return u, nil
}

func (h *Handler) UserDetail(w http.ResponseWriter, r *http.Request) {
    u, err := h.svc.GetUser(id)
    if err != nil {
        // 顶层：记录完整的错误（包含整个调用链的上下文）
        log.Printf("ERROR UserDetail: %v", err)
        
        // 根据错误类型决定 HTTP 响应
        var nfe *NotFoundError
        if errors.As(err, &nfe) {
            http.Error(w, "not found", 404)
            return
        }
        http.Error(w, "internal error", 500)
    }
}
```

这个"错误日志只在最顶层记录一次"是错误日志的核心原则——中间层只包装透传，顶层统一记录。这个"顶层记录"让日志不重复，且包含完整的错误链上下文（通过 `%v` 打印整个错误链的消息）。如果每层都记录，同一个错误会在日志中出现多次，造成日志噪声和排查困难。

### 4.3 Go 1.20 的多重错误包装

Go 1.20 引入了 `errors.Join` 和 `fmt.Errorf` 对 `%w` 多次使用的支持，允许一个错误同时包装多个原始错误：

```go
// errors.Join：将多个错误合并为一个（如批量操作的错误收集）
errs := []error{}
for _, item := range items {
    if err := process(item); err != nil {
        errs = append(errs, fmt.Errorf("process item %d: %w", item.ID, err))
    }
}
if len(errs) > 0 {
    return errors.Join(errs...)  // 合并所有错误
}

// fmt.Errorf 多个 %w（Go 1.20+）
err := fmt.Errorf("operation failed: %w and %w", err1, err2)
// errors.Is(err, err1) → true
// errors.Is(err, err2) → true
```

`errors.Join` 返回的错误实现了 `Unwrap() []error`（返回 slice 而非单个 error），`errors.Is` 和 `errors.As` 都能正确处理这种多重包装。这个"多重错误包装"让批量操作的错误收集更优雅——不需要单独处理每个错误，`errors.Join` 一次性合并，调用方可以统一检查。

---

## 第 5 章 panic 与 recover：异常机制的合理使用

### 5.1 panic 的语义：真正的异常，而非错误

`panic` 在 Go 中的语义是：**程序遇到了不可恢复的错误，继续运行会产生不可预期的结果**。典型场景：

- 数组越界（runtime 自动触发）；
- nil 指针解引用（runtime 自动触发）；
- 类型断言失败（`v := x.(T)` 没有用 `,ok` 形式）；
- 不变量被违反（如"这个函数的调用者保证参数不能为 nil，但传了 nil"）。

**原则：不要用 panic 代替 error 返回值**。panic 应该是"永远不应该发生"的情况，而不是"可能发生的错误条件"。函数签名中，可能出错的情况应该通过 `error` 返回值表达。

```go
// 错误使用：用 panic 代替 error
func ParseConfig(data []byte) *Config {
    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        panic(err)  // 不应该这样！解析失败是正常的错误情况
    }
    return &cfg
}

// 正确使用：通过 error 返回值
func ParseConfig(data []byte) (*Config, error) {
    var cfg Config
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("parse config: %w", err)
    }
    return &cfg, nil
}

// panic 的合理使用：不变量检查（只在"绝对不可能发生"的情况下）
func MustParseUUID(s string) uuid.UUID {
    id, err := uuid.Parse(s)
    if err != nil {
        panic(fmt.Sprintf("MustParseUUID: invalid UUID literal %q: %v", s, err))
        // Must 前缀的函数约定：输入必须合法，否则 panic
    }
    return id
}
```

**`Must` 前缀约定**：标准库中有 `template.Must`、`regexp.MustCompile` 等，都是"输入保证合法，不合法则 panic"的 helper——用于全局变量初始化（在 `init()` 或全局变量声明中，不方便处理 error）。

这个"panic 用于不变量违反，error 用于预期错误"是 Go 错误处理的核心区分——panic 是"程序内部状态错误"（如不变量被违反），error 是"外部输入或环境问题"（如文件不存在）。混淆两者会导致代码难以维护——用 panic 处理预期错误会让调用者必须 recover，增加复杂度；用 error 处理不变量违反会让错误传播路径不清晰（不变量违反应该立即崩溃，而不是向上传播）。

### 5.2 recover：在边界处拦截 panic

`recover` 只能在 `defer` 函数中有效，用于拦截当前 goroutine 的 panic 并恢复正常执行：

```go
// HTTP server 中间件：防止单个请求的 panic 导致整个服务崩溃
func RecoveryMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rv := recover(); rv != nil {
                // 记录 panic 的调用栈
                buf := make([]byte, 1024*64)
                n := runtime.Stack(buf, false)
                log.Printf("PANIC recovered: %v\n%s", rv, buf[:n])
                
                // 返回 500 响应
                http.Error(w, "internal server error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

**recover 的使用原则**：
- **只在边界处使用**（HTTP handler、Goroutine 入口点、插件系统的调用边界）；
- recover 后必须记录完整的调用栈（`runtime.Stack`），否则 panic 的原因会被吞掉，永远找不到 Bug；
- recover 后通常将 panic 转换为 error 返回（或返回 500 响应），而不是假装什么都没发生；
- **不要用 recover 来处理预期内的错误**——那是 `error` 的职责。

这个"recover 只在边界处使用"是 recover 的核心原则——边界是"panic 不应该跨过的线"（如 HTTP 请求边界、Goroutine 边界），在边界处 recover 防止单个请求/Goroutine 的 panic 影响整个服务。中间层不应该 recover——让 panic 向上传播到边界，由边界统一处理。这个"边界 recover"让 panic 既能被拦截（不影响服务），又能被记录（保留调用栈用于调试）。

---

## 第 6 章 Go 错误处理的设计认知

### 6.1 显式优于隐式

Go 错误处理的哲学是"显式优于隐式"——错误是普通返回值，不是异常；错误处理在每个调用点显式决策，不是隐藏在 catch 块；错误链通过 Unwrap 显式传递，不是隐式抛出。这个"显式优于隐式"让 Go 的错误处理可见、可控、可审计。这个"显式"是 Go 与 Java 异常机制的根本区别——Java 的异常可以隐式跨层抛出（unchecked exception），调用者不知道可能有哪些异常；Go 的错误必须显式返回和检查，每个错误处理点都可见。

### 6.2 错误是值，不是控制流

Go 把错误当作"普通的值"——`error` 是一个接口，错误值可以被存储、传递、包装、检查。这个"错误是值"让错误处理具有"值操作"的所有灵活性——你可以把错误放进 channel、存入 struct、用函数处理。这个"错误是值"与"错误是控制流"（如 Java 的异常会改变控制流）形成对比——Go 的错误处理不改变控制流，错误就是返回值，处理错误就是处理返回值。

### 6.3 渐进式改进

Go 错误处理的演进是"渐进式"的——Go 1.0 只有 `error` 接口和 `errors.New`，Go 1.13 引入错误包装（`%w`、`errors.Is`、`errors.As`），Go 1.20 引入多重包装（`errors.Join`）。这个"渐进式演进"让社区有时间适应，避免了"一刀切"的破坏性变更。这个"渐进式"也反映了 Go 团队对错误处理的谨慎态度——不急于引入复杂机制（如 `?` 操作符），而是在现有框架内逐步增强。

---

## 第 7 章 错误的分类与边界

### 7.1 领域错误与基础设施错误

错误处理的第一道分界线是"这条错误意味着什么"。**领域错误**（业务规则不允许：余额不足、状态非法、参数越界）本质上是**正常的控制流**——它是"这次请求被合理地拒绝了"，调用方应当据此给用户一个明确的提示，而不是触发告警或重试。**基础设施错误**（数据库连不上、下游超时、磁盘满）则是**技术故障**——它意味着"这次尝试没有真正完成"，通常可以重试，并且需要被监控到。

把这两类混淆会同时产生两种危害：把领域错误当故障上报，会让告警里充满"用户输入错误"这类噪音，真正的故障被淹没；把基础设施错误当业务拒绝返回，会让用户看到"参数错误"，而实际上系统正在故障，问题被掩盖。因此一个成熟的错误体系首先要能回答：**这条错误，调用方应当"告诉用户"还是"重试/告警"？**

### 7.2 分类的粒度由调用方决定

分类的依据应当是"**调用方需要对它做什么**"，而不是"它来自哪个包"。同一种底层错误在不同语境下可能是不同类别：`sql.ErrNoRows` 在"查询详情"场景里是正常的"不存在"（领域语义），在"必须存在的记录缺失"场景里则是**数据不一致的故障**。因此分类不该在产生错误的地方一刀切，而应当在**消费错误的那一层**按语境决定——这也解释了为什么 Go 把错误当作值层层传递，而不是在产生处就定死它的性质。

### 7.3 错误到协议的映射

对外服务必须把内部错误映射成稳定的协议错误。映射的原则有三条：**其一，不泄漏内部细节**（不要把 SQL 语句、堆栈、内部主机名返回给外部用户，那既无用也是安全隐患）；**其二，分类要稳定**（"参数错误"永远映射到同一个状态码，不要因为重构而改变）；**其三，保留可追踪的标识**（返回一个请求 ID，让用户报错时你能定位到具体日志）。以 gRPC 为例，错误分类大致映射到 `InvalidArgument`（参数问题）、`NotFound`（不存在）、`PermissionDenied`（权限）、`ResourceExhausted`（限流）、`Unavailable`（下游不可用）、`Internal`（未知内部错误）等状态码——**映射表本身不重要，重要的是这张表在团队里是统一的、被文档化的**。

### 7.4 错误契约

"错误契约"指的是**对外承诺的错误集合**。它应当满足两点：**可枚举**（调用方能知道可能收到哪些错误，而不是"任何错误都可能"）、**可文档化**（每个错误对应什么处理建议写清楚）。契约一旦确立，就应当稳定——内部重构可以自由改实现，但对外暴露的错误码与语义不应随意变动。这一点在 SDK 与公开 API 上尤其重要，因为调用方的处理逻辑（`if errors.Is(err, ErrNotFound)`）会直接依赖它。

## 第 8 章 错误的可观测性

### 8.1 只在边界记录一次

错误日志最常见的反模式是"层层都打一遍"——每一层都 `log.Error(err)` 再往上返回，结果是同一个错误在同一请求里被打印了五次，日志量翻倍、噪音严重，还掩盖了真正的边界。正确的纪律是：**在错误第一次被"处理"（翻译成对外响应、决定重试、触发告警）的边界处记录一次**，中间层只做包装与传递，不打日志。所谓边界，通常是"请求处理的最外层"或"后台任务的最外层"——那里才是唯一有完整上下文、也唯一有决策权的地方。

### 8.2 结构化错误日志

记录错误时应当打成**结构化**的（key-value 字段），而不是拼进一行字符串。至少包含几个字段：**错误链**（从里到外的完整信息）、**错误分类**（是领域错误还是故障）、**请求标识**（用于关联同一请求的其他日志与追踪）、**关键上下文**（涉及哪个用户、哪条记录、哪个下游）。结构化日志的价值在"可检索、可聚合"——当你想统计"最近一小时数据库超时出现了多少次、集中在哪个下游"时，结构化的错误日志能直接回答，而纯文本日志只能靠正则硬凑。

### 8.3 错误指标与错误预算

除了日志，还应当有**错误指标**：按分类计数（领域错误 vs 故障）、按来源计数（自己产生 vs 下游传来）、按接口计数。指标与日志的分工是"指标发现异常、日志定位原因"。在此基础上，"错误预算"（把"允许出现多少故障"量化成一个额度）让"错误率"从"越低越好"的模糊目标，变成"是否耗尽了预算"的可判定状态——额度还在，就继续迭代；额度耗尽，就停下来先修稳定性。

### 8.4 错误与追踪

最后是把错误挂到追踪上。每次发生错误时，把它作为属性记到当前的 Span 上，于是"这次请求为什么失败"在追踪系统里就能一眼看到——错误发生在哪一跳、传递路径是怎样的、哪一层把它翻译成了对外错误。这一点在分布式系统里尤其有价值：一个错误跨了五个服务，纯日志要靠请求 ID 逐个服务去捞，而追踪直接给出了全貌。

> [!info] 一个实用的分工
> 日志回答"**发生了什么**"（带上下文的一次具体事件），指标回答"**有多少**"（趋势与阈值），追踪回答"**在哪一跳**"（调用链上的位置）。三者缺一，故障排查就会卡在某一环。

## 第 9 章 实现细节：自定义错误与包装合约

### 9.1 自定义错误类型的设计

定义一个错误类型时，要回答四个问题：**它要携带什么字段**（通常是机器可读的标识，如资源 ID、重试等待时长）、**它要不要实现 `Is`/`As`**（让调用方能用自己熟悉的方式判断）、**它要不要导出**（导出的类型成为公开契约）、**它的 `Error()` 返回什么**（给人和给机器的信息要在这一层分开）。一个常见的坏习惯是把所有信息拼进 `Error()` 字符串、然后靠字符串判断——那等于放弃了类型系统提供的全部能力。正确的做法是：**结构化字段给机器，`Error()` 给人**。

### 9.2 Unwrap 的合约

`errors.Is` 与 `errors.As` 能在错误链上工作，靠的是 `Unwrap() error` 这个可选接口。围绕它有几条契约需要记住：**单链用 `Unwrap() error`，多链用 `Unwrap() []error`**（后者是 Go 1.20 为 `errors.Join` 引入的）；`Is`/`As` 会同时沿两种链遍历，因此实现正确就能自动被"链式查找"支持；若某个错误类型需要特殊的相等语义（比如"任何 `*PathError` 都算匹配"），可以实现自定义的 `Is(target error) bool` 来接管判断。最后一条容易被忽略但很好用——**自定义 `Is` 让"错误的分类判定"不再依赖字符串，也不再依赖具体的类型包装层级**。

### 9.3 errors.Join 与多重错误

Go 1.20 引入的 `errors.Join` 解决了一个长期痛点：**一次操作中产生了多个错误，怎么把它们一起返回**。典型场景是"批量校验"——十个字段里有三个不合法，你希望一次把三个都说出来，而不是让用户改一个再报一个。`errors.Join` 把多个错误合成一个，`errors.Is`/`As` 会在其中任一匹配合适时返回 true。使用它的边界也很清晰：**它适合"这些错误是可以同时呈现的"，不适合"后续错误依赖于前面是否成功"**——后者只应当返回第一个阻断性错误。

### 9.4 哨兵错误的边界

哨兵错误（如 `sql.ErrNoRows`）适合表达"**一个稳定的、调用方需要识别其含义的状态**"，但它不适合被滥用。两个常见的越界是：**其一，导出一大堆哨兵**——每个内部错误都导出一个，结果是包之间靠哨兵互相耦合，重构时寸步难行；**其二，哨兵的语义漂移**——同一个哨兵在不同场景下含义不同，调用方无从判断。判断该不该用哨兵，只需问一句：**调用方是否需要用 `errors.Is` 特别处理它？** 若是，用哨兵或错误类型；若否，用 `fmt.Errorf` 包装即可。

### 9.5 一张包装与传播图

把前面的机制画成一张图，可以看清错误在层与层之间是如何被"包装—传播—判定"的：

```mermaid
%%{init: {'theme': 'dracula'}}%%
flowchart TB
    A["底层：sql.ErrNoRows<br/>（哨兵）"] --> B["仓储层：fmt.Errorf(\"查询用户: %w\", err)<br/>保留链"]
    B --> C["用例层：包装为领域错误 ErrUserNotFound<br/>（自定义 Is）"]
    C --> D["传输层：映射为 NotFound<br/>并记录一次结构化日志"]
    D --> E["调用方：errors.Is(err, ErrUserNotFound) 判断"]
```

这张图里有两条值得注意的规则：**中间层只包装、不判定、不记录**；**判定与记录都发生在边界**（传输层）。守住这两条，"同一错误被判断多次、记录多次"的混乱就不会发生。

## 第 10 章 十二个反例

**其一，忽略错误。** `_ = f()` 或"只 `log` 不 `return`"是错误处理里最常见的漏洞——前者让失败悄无声息，后者让流程在失败后继续走下去。后者的危害更大，因为它把"局部失败"扩散成了"状态不一致"。

**其二，重复记录。** 每一层都打一次日志（见 8.1），结果是噪音与成本双双上升。

**其三，用字符串比较错误。** `if err.Error() == "not found"` 把错误处理绑到了人类可读的文案上——文案一改，逻辑就断，而且无法处理包装后的链。

**其四，把 panic 当错误用。** `panic` 的定位是"**不可恢复的程序错误**"（数组越界、空指针），用它表达"业务上不允许"会让正常路径带上栈展开的代价，也让调用方失去了编译期的可见性。

**其五，用 recover 吞掉 panic。** 恢复之后既不记录也不重抛，问题就被埋了（详见第 11 篇对"错误修复"的讨论）。

**其六，丢失原始错误。** 用 `errors.New("查询失败")` 覆盖掉原始错误，链就断了——应改为 `fmt.Errorf("查询失败: %w", err)`。

**其七，在循环里层层包装。** 循环内每轮都包装一次，会得到一条极长的错误链（十几层 `%w`），既浪费内存，也让日志难以阅读。循环里的包装应只加一次上下文（如循环索引）。

**其八，用 `%v` 而非 `%w`。** 格式动词只差一个字母，语义差了整个错误链——`%v` 会把错误转成字符串，链就此断开。

**其九，导出一堆哨兵。** 见 9.4——包与包之间通过哨兵耦合，重构成本骤增。

**其十，在 `defer` 里丢失错误。** `defer file.Close()` 忽略了关闭错误，而写入场景下关闭错误可能意味着"数据没落盘"，静默忽略是危险的。正确做法是在具名返回值上用 `defer func() { err = errors.Join(err, f.Close()) }()` 把关闭错误并入返回。

**其十一，把错误当控制流。** 用"返回错误"来表达"存在与否"这类正常查询（如 `ErrNoRows` 判存在），会让正常路径背上错误处理的负担——更合适的是返回 `(value, bool)` 或 `(*T, error)` 中明确区分"不存在"与"出错"。

**其十二，错误信息含敏感数据。** 把密码、token、身份证号拼进错误消息，会随日志与对外响应泄漏出去。错误消息里应只放"标识"（用户 ID、记录 ID），不放"内容"。

## 第 11 章 与其他语言对照与团队规约

### 11.1 与 Java、Python、Rust 的对照

四门语言对"错误"的建模差异极大，对照着看很能说明取舍。**Java** 区分受检异常（checked，必须在签名里声明）与非受检异常——受检异常强制了处理，但催生了大量 `catch (Exception e) {}` 的空处理，空处理比不处理更危险。**Python** 全用异常，简洁但"哪些异常可能抛"在签名上不可见，调用方只能靠文档与通读源码。**Rust** 用 `Result<T, E>` 把错误编进了类型系统，编译器强制处理，代价是到处 `?`、`map_err` 的仪式感，以及错误类型组合的复杂度。**Go** 选择的是"错误是值 + 显式返回 + 不强制处理"——不强制带来了"可能忘记处理"的风险（靠 linter 与评审弥补），但换来了调用链上错误的去向一目了然。

### 11.2 Go 为什么不引入异常

Go 明确拒绝异常机制，理由可以归结为三条。**其一，异常让控制流隐式**——读一段代码时，你无法从字面判断"哪一行可能突然跳到别处"，而显式的 `if err != nil` 让每一次可能的中断都在字面上可见。**其二，异常容易跨越边界**——异常可以穿过若干层栈帧，直到某处才被捕获，这让"错误在哪里被处理"变得难以追踪；Go 的显式返回逼着每一层做决定：往上抛还是就地处理。**其三，panic 保留给"真正异常"的情形**（程序 bug、不可恢复状态），于是它的出现本身就带有强烈的信号意义。这三条合起来，是"显式优于隐式"这条设计信条在错误处理上的最完整表达。

### 11.3 团队错误处理规约

把全篇压成一份可执行的规约：

| 规则 | 做法 | 违反后果 |
| :--- | :--- | :--- |
| 错误必处理 | 不出现 `_ = err`（除非有明确理由并注释） | 失败被静默 |
| 只记录一次 | 中间层不 `log`，只在边界记录 | 日志噪音、成本上升 |
| 包装加上下文 | 用 `%w` 并附上"在哪一步失败" | 定位困难 |
| 判定用 `Is`/`As` | 不用字符串比较 | 重构即断 |
| 分类在边界 | 领域错误与故障在边界区分 | 告警噪音或故障掩盖 |
| 不外泄内部信息 | 对外错误只给分类与请求 ID | 安全风险 |

这份规约的特点是每一条都对应一类具体故障，而不是抽象的"要写好错误处理"——**规约要能被执行，就必须写成"做什么/不做什么"的形式**。

### 11.4 收束

回到全篇的起点——"错误是值"。这一句话支撑起了整篇的所有实践：因为是值，所以可以携带结构化的信息、可以被包装成链、可以用 `Is`/`As` 判定、可以被收集与比较；也因为是值，所以它不会自己"跳走"，必须由每一层显式地决定它的去向。**这个设计把"错误处理"从一件语言帮你兜底的事，变成了一件你必须显式交代的事**——它更啰嗦，但也更可控，而后者在需要长期维护的系统里，价值远高于前者。

## 第 12 章 十个进阶议题

**议题一：错误链有没有长度上限？** 没有硬上限，但链越长，`errors.Is`/`As` 的比对次数越多，日志越长。工程上的建议是"每一层最多包一次"，一个正常请求的错误链通常不超过五六层；若发现链有十几层，通常是循环里重复包装或装饰器层层叠加所致。

**议题二：`errors.Is`/`As` 的性能如何？** 它们是沿链的线性遍历，单次开销很小（通常亚微秒级），远不值得为它做优化。真正需要注意的是"在热路径上反复构造错误"的场景——判定的开销可以忽略，**构造**（尤其是带格式化与堆栈的构造）才是成本所在。

**议题三：什么时候用错误类型，什么时候用哨兵？** 需要携带**数据**时用类型（如"重试等待 2 秒"），只需要表达**状态**时用哨兵（如"资源不存在"）。判据是"调用方除了知道它是什么，还需不需要知道更多"。若两者都要，可以让哨兵类型的 `Is` 方法接管判定，兼顾"稳定标识"与"可携带数据"。

**议题四：错误消息要不要做国际化？** 通常不要。错误消息是给**开发者与运维**看的，应当保持英文、稳定、可检索；面向最终用户的提示应当由边界层根据错误分类单独生成（而不是直接回显错误消息）。把 i18n 做进错误消息，会让日志变成多语言的、难以聚合——这是"给机器的信息"与"给人的信息"必须分开的又一例证。

**议题五：怎么测试错误路径？** 三条做法：对"返回错误"的函数，用可控的依赖注入制造失败（mock 的仓储返回错误）；用 `errors.Is` 断言分类而非消息文本；对"不该发生却被处理了"的情况（如 `recover`），专门写一个触发 panic 的用例验证其被正确转换。**错误路径的测试覆盖率往往被高估**——很多人测了"成功路径"，却没测"失败时是否泄漏资源、是否状态一致"。

**议题六：错误与重试是什么关系？** 只有"**暂时性**"的错误才值得重试——网络抖动、下游限流、连接被重置是暂时的；而参数错误、权限不足、资源不存在是**确定性**的，重试一万次也是同样的结果。因此一个成熟的错误体系会给错误打上"是否可重试"的标记（这就是"分类"的又一处用途），让重试逻辑不必靠猜。

**议题七：错误与幂等有什么关系？** 对写操作重试的前提是幂等——若不能保证幂等，重试可能造成重复提交。错误处理与幂等设计的交汇点在于：**对"结果未知"的错误**（超时、连接中断）必须按幂等处理，因为操作可能已经成功了；对"明确失败"的错误才可以安全重试。

**议题八：标准库的错误设计有什么可借鉴的？** 三点：`os.PathError` 这种"**包装类型携带操作与路径**"的模式，示范了"把机器可读的上下文结构化"；`net.OpError` 示范了"错误的分类字段"（Op、Net、Addr）；`errors.Is` 的链式匹配示范了"让判定逻辑与包装层数解耦"。它们的共同点是——**错误的类型设计围绕"调用方如何使用它"，而不是围绕"错误是怎么产生的"**。

**议题九：API 演进时错误集合怎么保持兼容？** 两个原则：**只增不改**（新增错误码可以，改变已有错误码的语义不行）；**让调用方能安全地"未知错误"兜底**（调用方应当有一个默认分支处理"没见过的错误"，而不是穷举所有可能——否则服务端每加一类错误，客户端都要跟着改）。

**议题十：错误处理的最终衡量标准是什么？** 一个实用的标准是：**线上出现一个陌生错误时，你能多快定位到它**。若"看到一个错误消息 → 找到它的产生处 → 知道它为什么发生"能在几分钟内完成，说明这套错误处理是有效的；若需要反复猜、反复加日志才能定位，那再优雅的 `%w` 也还没落地。**错误处理的产出不是代码，是"可定位性"。**

## 第 13 章 一次线上错误的完整推演

把前面的机制串成一次排查，能看清"好的错误处理"到底省下了什么。假设线上出现用户投诉："偶尔保存失败"。

**第一步，看对外响应**。用户看到的是"保存失败，请重试"加一个请求 ID——这是错误契约正确落地的表现：既没泄漏内部细节，又给了可追踪的线索。若此时返回的是"`sql: no rows in result set`"，那问题就已经从"排查"变成了"先修泄漏"。

**第二步，用请求 ID 捞日志**。边界处记录的那一条结构化日志里，应当有：错误分类（是故障而非参数问题）、错误链（`更新订单: 获取当前状态: 连接超时`）、关键上下文（订单 ID、下游地址）。仅凭这一条日志，"是下游超时"这个结论就已经出来了——**这正是"只在边界记录一次，且记录完整上下文"的价值**。

**第三步，看指标与追踪**。错误指标显示该错误在最近一小时上升、且集中在一个下游——这不是个例，而是下游质量问题。追踪给出了具体的慢调用分布，确认了是那个下游的偶发超时。

**第四步，决定动作**。因为错误分类里已标注"是可重试的暂时性故障"，且保存操作被设计成幂等（用订单 ID 去重），因此可以直接给这个下游调用加重试（带退避与抖动）。若分类缺失、幂等没做，此时的正确动作只能是"先告警、人工介入"，排查到修复的周期会被拉长很多。

这段推演说明的是同一个道理：**错误处理的质量，最终体现在"从现象到根因"这条路径有多短**。分类让第一步就能分流，结构化上下文让第二步就能定位，指标与追踪让第三步就能判断范围，幂等与可重试标记让第四步可以自动化。四步各自对应了本篇的一个机制——它们不是孤立的"好习惯"，而是一条完整链路上的必需环节。

## 第 14 章 落地路径

把错误体系从零建立起来，不必一步到位，可以分四个阶段推进。

**第一阶段，先"不丢"。** 最小的目标是：所有错误都被处理（不 `_ =`），所有包装都用 `%w` 保留链。这一阶段靠 linter 与评审即可达成，投入极小，收益是把"错误被静默"这类最危险的情况先消灭掉。

**第二阶段，再加"分类"。** 引入错误类型与哨兵，把"领域错误"与"基础设施错误"在边界处分开，并据此决定"是否重试、是否告警、返回什么状态码"。这一阶段的价值在于**让错误从"日志里的文本"变成"可判定的信号"**，自动化才成为可能。

**第三阶段，然后"可观测"。** 统一结构化日志的字段、引入错误指标、把错误挂到追踪上。这一阶段把"能定位"从依赖个人经验，变成依赖系统能力。

**第四阶段，最后"契约化"。** 把对外错误码固定下来、写进文档，让调用方能依赖它，也让客户端有一个稳定的处理接口。这一步通常只在对外提供 API/SDK 时才有必要，但对这类系统是必须的。

四个阶段的顺序不是随意的——**先消灭最危险的（静默失败），再建立可判定的（分类），再补齐可观测的，最后固定对外的**。若跳过第一阶段直接做契约，很可能建立在一个"错误还在被随手丢掉"的地基上。

## 第 15 章 四种场景的错误处理范式

错误处理的形状随"调用方是谁"而变。四种常见场景各有其范式，放在一起对照能看清"同一套原则在不同边界上的落地方式"。

### 15.1 HTTP handler

handler 是典型的"错误边界"——它要把内部错误翻译成对外响应，并决定记录与否。范式是：**调用的下层只用 `%w` 包装、不记录、不判定；handler 处做分类判定、映射状态码、记录一次结构化日志、返回带请求 ID 的响应**。有一处细节常被忽略：**要区分"客户端错误"与"服务端错误"**——前者（参数、鉴权）不该打错误级日志（否则日志里全是 4xx 噪音），后者才需要。日志级别本身就是分类的一种表达。

### 15.2 后台任务与消费者

后台任务（定时任务、消息消费）没有"HTTP 状态码"这层出口，它的边界是"任务的入口"。范式是：**每个任务实例承担完整的错误处理——分类决定"是否重试"、重试策略决定"退避与上限"、最终失败则记录并（可选）投递到死信**。这里的重点是**不能让一个任务失败拖垮整个消费循环**：`for` 循环里的单条失败应当被就地处理（重试或抛弃），而不是让错误冒泡到循环外终止整个过程。这也是"panic 隔离"在此场景等价于"错误隔离"的地方。

### 15.3 CLI 工具

CLI 的错误处理出口是"进程退出码 + stderr"。范式是：**错误只在 `main` 记录一次、打印简洁的人类可读信息、并以非零退出码结束**；内部各层仍按"包装不记录"的规则办。有一处特有的考虑是**区分退出码**——"用法错误"（用户输入不对）与"运行失败"（环境问题）应当有不同的码，这样脚本与 CI 才能据此分流。同时要注意：**面向用户的报错要给"可执行的下一步"**（"配置文件 X 不存在，请先执行 Y"），而不是把内部错误原样抛给用户。

### 15.4 库（SDK）

库是最需要克制的一类——它的"边界"在调用方手里，因此**库不应记录日志**（日志策略是应用的事），也**不应把错误映射成特定的响应格式**。库的职责只有三条：**返回带上下文的错误**（`fmt.Errorf("解析配置: %w", err)`）、**导出稳定的错误标识**（哨兵或类型，供调用方 `Is`/`As`）、**不隐藏可判定信息**（不要用 `errors.New("failed")` 覆盖掉能让调用方分类的信息）。一句话：**库提供"可判定的错误"，由应用决定"如何处理"**。

四类场景的差别，其实只在于"边界在哪里、边界处要不要面向用户"。原则始终是同一条：**中间层包装、边界层判定与记录**——变的只是边界的形态。

把这四类范式摆在一起，还能看出一条更普遍的规律：**错误处理的复杂度，与"边界的数量"成正比**。一个服务同时是 HTTP 服务端、消息消费者、CLI 工具与库时，它的错误处理需要为四类边界各设计一套出口——这也是为什么把"边界"这个概念先在代码里明确下来，比直接写 `if err != nil` 更重要。

写代码时不妨问一句：这条错误，如果三周后在凌晨三点出现，我能多快定位？这个问题比"错误处理写得好不好看"更能指导实践。

还有一处容易被忽略的收益：**好的错误处理让代码的"失败语义"变得可读**。读到 `if errors.Is(err, ErrInsufficientBalance)` 时，你立刻知道这是一个"合理的拒绝"；读到 `fmt.Errorf("调用下游 %s: %w", addr, err)` 时，你立刻知道失败发生在哪一跳。这种可读性不体现在注释里，而体现在代码本身——**它是错误处理最被低估的一项回报。**

换句话说，错误处理的功夫不花在"写多少 `if err != nil`"，而花在"让每一条错误都带着足够的信息、走到它该去的地方"——**这既是 Go 的显式哲学，也是它的实践门槛**。

## 总结

本篇深入剖析了 Go 错误处理的设计哲学与工程实践：

**`error` 接口的本质**：`Error() string` 是 Go 中最简单的接口，错误是普通返回值，显式处理保证可见性。`errors.New` 返回指针保证每次创建的错误唯一可比较。这个"错误是普通返回值"是 Go 错误处理的基石。

**Go 1.13 错误包装**：`fmt.Errorf("%w", err)` 保留原始错误的链式引用（通过 `Unwrap() error`）；`errors.Is` 沿链查找特定错误值；`errors.As` 沿链提取特定错误类型。三者配合，让"添加上下文"与"精确错误检查"不再互斥。这个"错误链"机制是 Go 1.13 错误处理的核心创新。

**三种错误范式**：哨兵错误（表示已知终止条件）、自定义错误类型（携带结构化信息）、`fmt.Errorf %w`（轻量级上下文添加）——根据场景选择合适的方式。这个"按场景选择"是错误定义的实用框架。

**两个关键工程原则**：每层只添加有意义的上下文（不重复堆叠调用链名称）；错误日志只在最顶层记录一次（中间层只包装透传）。这两个原则让错误消息清晰、日志不冗余。

**panic/recover 的边界**：panic 用于"永远不应该发生"的不变量违反；recover 只在服务边界（HTTP 中间件、Goroutine 入口）拦截，且必须记录完整 stack trace。这个"panic 用于不变量，error 用于预期错误"的区分是 Go 错误处理的核心约定。

Go 错误处理的哲学是"显式优于隐式"——错误是普通返回值，不是异常；错误处理在每个调用点显式决策，不是隐藏在 catch 块；错误链通过 Unwrap 显式传递，不是隐式抛出。这个"显式优于隐式"让 Go 的错误处理可见、可控、可审计，是 Go 工程哲学的核心体现。

下一篇介绍 Go 完整的测试体系：[[04 Go 测试体系——单元测试、表驱动测试与 Mock]]。

---

## 参考资料

1. Go Blog,《Error handling and Go》: https://go.dev/blog/error-handling-and-go——Go 错误处理的官方介绍。
2. Go Blog,《Working with Errors in Go 1.13》: https://go.dev/blog/go1.13-errors——Go 1.13 错误包装的官方说明。
3. Dave Cheney,《Don't just check errors, handle them gracefully》: https://dave.cheney.net/2016/04/27——Go 错误处理的最佳实践。
4. Go 源码：`errors/errors.go`、`errors/wrap.go`、`fmt/errors.go`——错误处理的实现细节。
5. Russ Cox,《Error Handling》——Go 错误处理设计的历史与原理。

---

> [!note] 思考题
> 1. 在一个多层调用链（Handler → Service → Repository → DB Driver）中，Repository 层捕获到 `sql.ErrNoRows`。如果直接 `return fmt.Errorf("user not found: %w", err)` 向上传播，Service 层可以用 `errors.Is(err, sql.ErrNoRows)` 匹配。但这意味着 Service 层需要知道底层使用了 SQL 数据库——这违反了依赖反转原则。你会如何设计错误类型来解决这个矛盾？
> 2. Go 1.13 引入了 `errors.Is` 和 `errors.As`，但社区中仍有大量代码使用 `if err.Error() == "some string"` 的方式判断错误。`errors.Is` 的链式匹配（遍历 Unwrap 链）在性能上有什么开销？在高频调用路径（如每秒百万次的中间件错误判断）中，这个开销是否值得关注？
> 3. `panic` + `recover` 在 Go 中被视为"核武器"，但标准库中 `encoding/json` 的内部实现大量使用 `panic` 来中断深层递归。在什么场景下用 `panic` 替代 `error` 返回值是合理的？如果一个 goroutine 内的 `panic` 没有被 `recover`，它会影响同进程内的其他 goroutine 吗？
> 4. Go 错误处理的哲学是"显式优于隐式"，但大量 `if err != nil` 样板代码是 Go 社区的长期争议点。Go 团队多次拒绝引入 `?` 操作符（类似 Rust 的错误传播语法糖）。你认为 Go 应该引入 `?` 操作符吗？引入它会带来哪些好处和风险？从"显式优于隐式"的角度分析。
