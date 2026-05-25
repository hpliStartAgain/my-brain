---
title: "Go 错误处理哲学——从 error 到 errors.Is 与 errors.As"
date: 2026-03-04
tags: [error, errors, errors.As, errors.Is, fmt.Errorf, Golang, panic, recover, 工程实践, 错误包装, 错误处理]
aliases: []
---

# Go 错误处理哲学——从 error 到 errors.Is 与 errors.As

## 摘要

Go 的错误处理是语言中争议最多、也最能体现其设计哲学的部分。与 Java 的受检异常（checked exception）、Python 的 try/except 不同，Go 将错误作为**普通的返回值**——`func Read() (int, error)` 中的 `error` 与 `int` 平等，没有特殊的语言机制，不能被忽略（不赋值给 `_` 就是编译警告）。这种设计让错误处理变得显式、可见，代价是大量重复的 `if err != nil` 样板代码。Go 1.13（2019年）引入了**错误包装（Error Wrapping）**，`fmt.Errorf("%w", err)` 和 `errors.Is`、`errors.As` 函数彻底改变了 Go 错误处理的最佳实践：调用链上每一层都可以包装错误（添加上下文信息），最上层可以精确地检查错误链中是否包含特定的错误类型或值。本文从 `error` 接口的本质出发，剖析错误包装的实现机制，梳理哨兵错误、自定义错误类型、`fmt.Errorf %w` 三种错误定义范式，以及 `panic/recover` 的合理使用边界。

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

### 1.2 显式错误处理的设计哲学

Go 选择显式错误返回而非异常（exception）的核心理由：

**理由一：错误是预期内的正常分支，不是异常**。在网络编程中，连接超时是完全正常的情况，不是"异常"；在文件操作中，文件不存在是完全正常的情况。Java 的异常机制让这些"正常的错误"看起来像"程序崩溃"，强迫开发者用 try/catch 包裹，且 unchecked exception 可以在任何地方抛出，调用者无法从函数签名知道可能有哪些错误。

**理由二：强迫开发者在每个错误发生的地方做决策**。`if err != nil` 是一个强制检查点——你必须在这里决定：是直接返回？是包装上下文再返回？还是处理掉（如有默认值可用）？这让错误处理策略在代码中显式可见，而不是隐藏在 catch 块里（可能在几百行之外）。

**理由三：错误与控制流清晰分离**。Go 的函数签名 `func (T, error)` 清楚地表达了"这个函数可能失败，失败时返回 error"，不需要查阅文档或运行时才知道。

**代价**：大量重复的 `if err != nil { return nil, err }` 样板代码。Go 社区多次讨论过语法糖来减少这种重复（如提案中的 `?` 操作符），但 Go 团队的立场是：显式优于隐式，代价可以接受。

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

这迫使开发者要么不添加上下文（错误消息无用），要么放弃精确的错误类型检查（只能字符串匹配，脆弱）。

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

`Unwrap()` 接口（`interface{ Unwrap() error }`）是 Go 1.13 引入的非官方接口——任何实现了 `Unwrap() error` 方法的错误类型，都可以被 `errors.Is` 和 `errors.As` 沿链解包。

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

**哨兵错误的局限**：无法携带额外的上下文信息（如"哪个用户不存在"）。如果需要上下文，使用自定义错误类型。

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

`errors.Join` 返回的错误实现了 `Unwrap() []error`（返回 slice 而非单个 error），`errors.Is` 和 `errors.As` 都能正确处理这种多重包装。

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

---

## 总结

本篇深入剖析了 Go 错误处理的设计哲学与工程实践：

**`error` 接口的本质**：`Error() string` 是 Go 中最简单的接口，错误是普通返回值，显式处理保证可见性。`errors.New` 返回指针保证每次创建的错误唯一可比较。

**Go 1.13 错误包装**：`fmt.Errorf("%w", err)` 保留原始错误的链式引用（通过 `Unwrap() error`）；`errors.Is` 沿链查找特定错误值；`errors.As` 沿链提取特定错误类型。三者配合，让"添加上下文"与"精确错误检查"不再互斥。

**三种错误范式**：哨兵错误（表示已知终止条件）、自定义错误类型（携带结构化信息）、`fmt.Errorf %w`（轻量级上下文添加）——根据场景选择合适的方式。

**两个关键工程原则**：每层只添加有意义的上下文（不重复堆叠调用链名称）；错误日志只在最顶层记录一次（中间层只包装透传）。

**panic/recover 的边界**：panic 用于"永远不应该发生"的不变量违反；recover 只在服务边界（HTTP 中间件、Goroutine 入口）拦截，且必须记录完整 stack trace。

下一篇介绍 Go 完整的测试体系：[[04 Go 测试体系——单元测试、表驱动测试与 Mock]]。

---

> [!note] 参考资料
> - Go Blog,《Error handling and Go》: https://go.dev/blog/error-handling-and-go
> - Go Blog,《Working with Errors in Go 1.13》: https://go.dev/blog/go1.13-errors
> - Dave Cheney,《Don't just check errors, handle them gracefully》: https://dave.cheney.net/2016/04/27
> - Go 源码：`errors/errors.go`、`errors/wrap.go`、`fmt/errors.go`

---

> [!note] 思考题
> 1. 在一个多层调用链（Handler → Service → Repository → DB Driver）中，Repository 层捕获到 `sql.ErrNoRows`。如果直接 `return fmt.Errorf("user not found: %w", err)` 向上传播，Service 层可以用 `errors.Is(err, sql.ErrNoRows)` 匹配。但这意味着 Service 层需要知道底层使用了 SQL 数据库——这违反了依赖反转原则。你会如何设计错误类型来解决这个矛盾？
> 2. Go 1.13 引入了 `errors.Is` 和 `errors.As`，但社区中仍有大量代码使用 `if err.Error() == "some string"` 的方式判断错误。`errors.Is` 的链式匹配（遍历 Unwrap 链）在性能上有什么开销？在高频调用路径（如每秒百万次的中间件错误判断）中，这个开销是否值得关注？
> 3. `panic` + `recover` 在 Go 中被视为'核武器'，但标准库中 `encoding/json` 的内部实现大量使用 `panic` 来中断深层递归。在什么场景下用 `panic` 替代 `error` 返回值是合理的？如果一个 goroutine 内的 `panic` 没有被 `recover`，它会影响同进程内的其他 goroutine 吗？
