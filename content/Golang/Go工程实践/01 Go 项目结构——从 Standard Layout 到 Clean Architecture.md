---
title: "Go 项目结构——从 Standard Layout 到 Clean Architecture"
date: 2026-03-04
tags: [Clean Architecture, Golang, Standard Layout, 依赖倒置, 包设计, 单体, 工程实践, 微服务, 项目结构]
aliases: []
---

# Go 项目结构——从 Standard Layout 到 Clean Architecture

**摘要：**

Go 语言没有强制规定项目目录结构，这既是自由，也是陷阱——同一个团队里五个人可能写出五种不同风格的项目布局，让接手者无从下手。本文从"为什么需要项目结构约定"出发，梳理 Go 社区最广泛认可的 **Standard Layout**（`/cmd`、`/internal`、`/pkg` 等目录惯例），深入剖析每个目录的设计意图与边界，再介绍如何在 Standard Layout 之上引入 **Clean Architecture**（整洁架构）思想来组织业务逻辑——将 domain、usecase、repository、handler 分层，保持核心业务逻辑与框架、数据库等基础设施的解耦。最后给出从命令行工具、HTTP 微服务到 mono-repo 三种典型场景的具体目录模板和包设计决策框架。文章最后回到一个设计认知：项目结构的本质是"用物理目录表达逻辑边界"——目录名传达意图，依赖方向体现架构，包划分承载职责。好的项目结构让代码"自文档化"——开发者看目录就能理解项目的架构和职责划分，不需要读代码。

---

## 第 1 章 为什么项目结构如此重要

### 1.1 结构即沟通

代码是写给人读的，项目结构是代码的第一印象。当一个新工程师打开 `ls -la` 看到项目根目录时，他应该能在 30 秒内回答以下问题：
- 这个项目有哪些可执行程序？
- 对外暴露的库代码在哪里？
- 数据库访问层、HTTP 路由、业务逻辑分别在哪里？
- 配置和部署文件在哪里？

如果一个项目的根目录是这样的：

```
myproject/
├── api.go
├── auth.go
├── config.go
├── database.go
├── handler.go
├── main.go
├── models.go
├── utils.go
└── ...（30 个 .go 文件全平铺）
```

那么即便每个文件的代码质量都很高，这个项目仍然是难以维护的——因为它没有表达任何关于"哪些东西属于一类"的信息。文件名是所有结构信息的唯一载体，当项目增长到 100 个文件时，这种平铺结构会完全失控。

这个"平铺失控"是项目结构缺失的根本危害——文件名只能表达"这个文件是什么"，不能表达"这个文件与哪些文件相关"。目录结构提供了"分组"能力——把相关的文件放在同一目录，让"哪些文件属于一类"一目了然。这个"分组"是项目结构的核心价值——它让代码的组织方式传达架构意图。

好的项目结构应该做到：
- **自文档化（Self-documenting）**：目录名本身传达意图；
- **边界清晰**：哪些代码是公开 API，哪些是内部实现，一目了然；
- **依赖方向可见**：高层模块不依赖低层模块，依赖方向通过目录结构体现；
- **可扩展**：增加新功能不需要重构整个目录树。

### 1.2 Go 的包设计哲学

在深入目录结构之前，有必要理解 Go 的**包（package）设计哲学**，因为目录结构本质上是包的物理组织方式：

**包是封装的单元**：Go 的 `package` 是比类更粗粒度的封装单元。一个包应该围绕一个**单一的职责**设计——所有暴露在包外的类型、函数、变量共同构成这个包的 API，它们应该相互关联，共同表达一个内聚的概念。这个"单一职责"是包设计的核心原则——一个包应该只做一件事，且把这件事做好。

**包名即文档**：`package http` 里的 `Client` 不需要命名为 `HTTPClient`，因为使用方会写 `http.Client`，包名已经提供了上下文。好的包名应该简洁（单个英文词，不用下划线或驼峰），且能准确描述包的内容。这个"包名即上下文"让 Go 的 API 简洁——不需要冗余的前缀，包名本身就是命名空间。

**避免循环依赖**：Go 编译器严格禁止包之间的循环依赖。这不是限制，而是强迫开发者理清依赖关系——如果 A 包和 B 包互相依赖，说明要么它们应该合并为一个包，要么需要提取公共接口打破循环。这个"禁止循环依赖"是 Go 包设计的硬约束——它迫使开发者思考依赖方向，避免"大泥球"式的包依赖。

**`internal` 包的访问控制**：Go 1.4 引入了 `internal` 目录——`internal` 下的包只能被其父目录下的代码引用，外部无法 import。这是 Go 唯一的包级访问控制机制（比 Java 的 `protected` 和 `package-private` 更简单粗暴，但足够用）。这个"internal 访问控制"让 Go 项目可以明确区分"公开 API"和"内部实现"——`internal/` 下的代码可以自由重构，不用担心破坏外部用户。

---

## 第 2 章 Standard Layout：Go 社区的目录惯例

### 2.1 Standard Layout 的由来

[golang-standards/project-layout](https://github.com/golang-standards/project-layout) 是 GitHub 上 star 最多的 Go 项目结构参考，归纳了 Go 大型项目（Kubernetes、etcd、Prometheus 等）的共同目录约定。它不是官方标准，但已成为事实上的社区共识。

完整的 Standard Layout 如下：

```
myproject/
├── cmd/                    # 主程序入口（每个子目录对应一个可执行文件）
│   ├── server/
│   │   └── main.go
│   └── worker/
│       └── main.go
├── internal/               # 项目内部代码（外部不可 import）
│   ├── app/               # 应用初始化和组装
│   ├── config/            # 配置解析
│   ├── handler/           # HTTP/gRPC handler
│   ├── service/           # 业务逻辑
│   └── repository/        # 数据访问层
├── pkg/                    # 可被外部项目 import 的公共库
│   ├── logger/
│   └── middleware/
├── api/                    # API 定义（OpenAPI spec、proto 文件）
│   ├── openapi/
│   └── proto/
├── web/                    # Web 静态资源（HTML、CSS、JS）
├── configs/                # 配置文件模板
├── scripts/                # 构建、安装、分析脚本
├── build/                  # 打包和 CI/CD 配置
│   ├── ci/
│   └── docker/
├── deployments/            # 部署配置（Kubernetes YAML、Helm charts）
├── test/                   # 集成测试、端到端测试数据
├── docs/                   # 设计文档
├── tools/                  # 项目依赖的工具（通过 tools.go 管理）
├── vendor/                 # 依赖包（可选，通常用 go.sum 替代）
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

### 2.2 核心目录详解

#### `/cmd`：可执行程序的入口

`/cmd` 下每个子目录对应一个可执行程序，子目录名即是程序名（`go build ./cmd/server` 生成 `server` 二进制）。

**关键原则：`main.go` 只做装配，不写业务逻辑**。`main.go` 应该只做：解析配置、初始化依赖（DB 连接、Logger 等）、组装应用、启动 HTTP/gRPC server、处理优雅退出信号。业务逻辑全部在 `internal/` 中。

```go
// cmd/server/main.go — 典型的装配代码
func main() {
    cfg, err := config.Load()  // 读取配置
    if err != nil {
        log.Fatal(err)
    }
    
    db, err := postgres.Connect(cfg.DatabaseURL)
    if err != nil {
        log.Fatal(err)
    }
    
    // 组装依赖（依赖注入，手动或通过 wire）
    userRepo := repository.NewUserRepository(db)
    userService := service.NewUserService(userRepo)
    userHandler := handler.NewUserHandler(userService)
    
    // 启动 HTTP 服务
    srv := server.New(cfg.Port, userHandler)
    
    // 优雅退出
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()
    
    if err := srv.Start(ctx); err != nil {
        log.Fatal(err)
    }
}
```

为什么不把 `main.go` 写得很厚？因为 `main` 包不可被测试（其他包不能 import `main`），业务逻辑放在 `main.go` 里等于无法测试。这个"main 只做装配"的原则是 Go 项目结构的第一条铁律——它让业务逻辑可测试，让装配代码与业务代码分离。装配代码（main.go）负责"把各组件连起来"，业务代码（internal/）负责"具体做什么"，两者职责清晰。

#### `/internal`：项目私有代码

`/internal` 是 Go 项目中最重要的目录。其下的所有包只能被本项目代码引用——这个限制由 Go 编译器强制，防止外部项目意外依赖内部实现细节，给重构带来障碍。

`/internal` 内部的子目录划分对应业务层次，详见第 3 章的 Clean Architecture 讨论。这个"internal 私有性"是 Go 项目结构的核心保护——它让内部实现可以自由重构，不用担心破坏外部用户。Kubernetes、etcd 等大型项目都大量使用 `/internal` 来保护实现细节。

#### `/pkg`：公共可复用库

`/pkg` 下的代码可以被外部项目 import。放入 `/pkg` 的代码应该：
- 与业务无关（通用工具、中间件、日志库等）；
- API 稳定，轻易不会破坏性修改；
- 有完善的测试和文档。

**一个常见的误区**：将所有代码都放在 `/pkg` 中，以为"万一以后别人要用"。这种过度设计会导致外部实现细节被迫稳定，增加维护成本。正确做法是：**除非已经有外部用户，否则放在 `/internal`**；确实需要对外暴露时，再移到 `/pkg`（或独立为一个新模块）。

这个"默认 internal，确有外部用户才 pkg"是 Go 项目结构的第二条铁律——它避免了"过早公开 API"的陷阱。一旦代码在 `/pkg` 中，它就成了公开 API，任何修改都可能破坏外部用户，维护成本激增。默认放 `/internal` 让代码保持"可自由重构"的状态，直到真正需要公开时才公开。

#### `/api`：接口定义

存放 API 合约文件：OpenAPI/Swagger YAML、Protocol Buffer `.proto` 文件、JSON Schema 等。这些是服务与外界沟通的契约，独立存放便于：
- 前端/客户端团队直接查阅；
- 代码生成工具（`protoc`、`oapi-codegen`）找到输入文件；
- API 变更通过 diff 一目了然。

这个"API 定义独立目录"让 API 契约与实现分离——API 契约是跨团队的协议，应该独立于实现代码。这个分离让 API 变更更透明——PR 中 `/api/` 的变更就是 API 变更，review 时可以重点关注。

---

## 第 3 章 Clean Architecture：内部分层的设计哲学

### 3.1 为什么需要分层

Standard Layout 解决了"文件放在哪个目录"的问题，但没有解决 `internal/` 内部如何组织代码——如果把所有业务代码都平铺在 `internal/` 下，同样会陷入混乱。

**Clean Architecture**（Robert C. Martin 提出，也称六边形架构、洋葱架构的变体）的核心思想是：

> **依赖方向只能从外层指向内层，内层不知道外层的存在。**

```
           ┌─────────────────────────────────┐
           │         Frameworks & Drivers     │  ← 最外层：HTTP框架、数据库驱动、消息队列
           │  ┌───────────────────────────┐   │
           │  │    Interface Adapters      │   │  ← 适配层：Handler、Repository实现、Presenter
           │  │  ┌─────────────────────┐  │   │
           │  │  │    Use Cases         │  │   │  ← 业务规则：应用服务、用例
           │  │  │  ┌───────────────┐  │  │   │
           │  │  │  │   Entities    │  │  │   │  ← 最内层：领域模型、核心业务规则
           │  │  │  └───────────────┘  │  │   │
           │  │  └─────────────────────┘  │   │
           │  └───────────────────────────┘   │
           └─────────────────────────────────┘
```

**最内层（Entities / Domain）**：纯 Go struct 和接口，代表业务的核心概念（User、Order、Product 等）及其不变的业务规则。这层代码不依赖任何第三方库，不依赖数据库、HTTP、框架——它是整个应用中最稳定、最易测试的部分。

**第二层（Use Cases / Application Service）**：编排业务流程。例如"用户注册"用例：验证邮箱格式 → 检查是否已注册 → 创建用户 → 发送欢迎邮件。这层代码通过**接口**（而非具体实现）与外部交互——它知道"需要一个 UserRepository 来存储用户"，但不知道具体是 PostgreSQL 还是 MySQL。

**第三层（Interface Adapters）**：将外层的数据格式转换为内层能理解的格式，或将内层的数据转换为外层需要的格式。HTTP Handler 把 HTTP 请求转换为用例的输入；Repository 的 PostgreSQL 实现把数据库行转换为领域对象。

**最外层（Frameworks & Drivers）**：框架、数据库驱动、第三方客户端。这层变化最频繁（换数据库、换HTTP框架），但因为它在最外层，对内层没有影响。

这个"依赖方向从外到内"是 Clean Architecture 的核心约束——它让内层（业务逻辑）不依赖外层（框架、数据库），从而让业务逻辑可以独立测试、独立演进。这个"依赖方向"是 Clean Architecture 与"传统分层架构"（Controller → Service → DAO，依赖方向从上到下）的关键区别——Clean Architecture 通过依赖倒置让依赖方向"反转"（外层依赖内层，而非内层依赖外层）。

### 3.2 在 Go 项目中落地 Clean Architecture

将上述思想映射到具体目录：

```
internal/
├── domain/                 # 最内层：领域模型（Entities）
│   ├── user.go            # User struct，业务规则方法
│   ├── order.go
│   └── errors.go          # 领域错误定义
│
├── port/                   # 接口定义（连接各层的"插座"）
│   ├── repository.go      # UserRepository 接口
│   └── service.go         # EmailService 接口（外部依赖的接口）
│
├── usecase/                # 第二层：应用业务规则（Use Cases）
│   ├── user_register.go
│   ├── user_login.go
│   └── order_create.go
│
├── adapter/                # 第三层：适配器
│   ├── handler/           # HTTP Handler（gin/echo/chi）
│   │   ├── user_handler.go
│   │   └── middleware.go
│   ├── repository/        # Repository 实现（PostgreSQL、Redis）
│   │   ├── postgres/
│   │   │   └── user_repo.go
│   │   └── redis/
│   │       └── cache_repo.go
│   └── grpc/              # gRPC 适配器
│
├── infrastructure/         # 最外层：框架和驱动
│   ├── database/          # 数据库连接池初始化
│   ├── cache/             # Redis 客户端
│   └── messaging/         # Kafka/RabbitMQ 客户端
│
└── app/                    # 应用组装（依赖注入）
    └── app.go             # 将所有层组装在一起
```

### 3.3 依赖倒置：接口是关键

Clean Architecture 在 Go 中落地的关键是**依赖倒置原则（DIP）**——高层模块（Use Case）不依赖低层模块（Repository 实现），两者都依赖抽象（接口）：

```go
// domain/user.go — 领域对象（无任何外部依赖）
type User struct {
    ID        int64
    Email     string
    Name      string
    CreatedAt time.Time
}

// 领域级别的业务规则
func (u *User) IsActive() bool {
    return u.CreatedAt.After(time.Now().Add(-365 * 24 * time.Hour))
}
```

```go
// port/repository.go — 接口定义（Use Case 所依赖的抽象）
// 注意：接口定义在"消费者"侧（use case 包），而非"实现者"侧（repository 包）
// 这是 Go 接口的惯用法：接口应该由使用者定义，实现者只需满足接口即可
type UserRepository interface {
    FindByID(ctx context.Context, id int64) (*domain.User, error)
    FindByEmail(ctx context.Context, email string) (*domain.User, error)
    Save(ctx context.Context, user *domain.User) error
}
```

```go
// usecase/user_register.go — 业务逻辑（只依赖接口）
type UserRegisterUseCase struct {
    userRepo    port.UserRepository  // 接口，不是具体实现
    emailSender port.EmailSender     // 接口
}

func (uc *UserRegisterUseCase) Execute(ctx context.Context, req RegisterRequest) (*domain.User, error) {
    // 检查邮箱是否已注册
    existing, err := uc.userRepo.FindByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, domain.ErrNotFound) {
        return nil, fmt.Errorf("check email: %w", err)
    }
    if existing != nil {
        return nil, domain.ErrEmailAlreadyExists
    }
    
    // 创建用户
    user := &domain.User{
        Email: req.Email,
        Name:  req.Name,
    }
    
    if err := uc.userRepo.Save(ctx, user); err != nil {
        return nil, fmt.Errorf("save user: %w", err)
    }
    
    // 发送欢迎邮件（接口调用，不关心具体实现是 SendGrid 还是 SMTP）
    uc.emailSender.SendWelcome(ctx, user.Email, user.Name)
    
    return user, nil
}
```

```go
// adapter/repository/postgres/user_repo.go — 具体实现（依赖数据库）
type PostgresUserRepository struct {
    db *sql.DB
}

// 实现 port.UserRepository 接口（Go 的隐式接口，无需显式声明 implements）
func (r *PostgresUserRepository) FindByEmail(ctx context.Context, email string) (*domain.User, error) {
    row := r.db.QueryRowContext(ctx, "SELECT id, email, name, created_at FROM users WHERE email = $1", email)
    
    var u domain.User
    if err := row.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, domain.ErrNotFound
        }
        return nil, err
    }
    return &u, nil
}
```

这种设计的好处：
- **Use Case 完全可测试**：测试时只需 mock `UserRepository` 接口，不需要真实数据库；
- **实现可替换**：将来把 PostgreSQL 换成 MySQL，只需要换 `adapter/repository/mysql/` 的实现，`usecase/` 代码不需要改动；
- **框架无关**：将来把 Gin 换成 Echo，只需要换 `adapter/handler/` 的代码，业务逻辑不受影响。

这个"接口由消费者定义"是 Go Clean Architecture 的核心技巧——Use Case 定义它需要的 Repository 接口，PostgreSQL 实现满足这个接口即可。这个"消费者定义接口"让 Use Case 不依赖具体实现，只依赖它自己定义的抽象——这是依赖倒置的 Go 实现方式。

---

## 第 4 章 三种典型场景的项目结构

### 4.1 命令行工具（CLI Tool）

对于简单的命令行工具，不需要完整的 Clean Architecture，Standard Layout 的简化版即可：

```
mycli/
├── cmd/
│   └── mycli/
│       └── main.go         # cobra/urfave-cli 根命令
├── internal/
│   ├── command/            # 每个子命令的实现
│   │   ├── build.go
│   │   └── deploy.go
│   └── config/             # 配置加载
├── pkg/                    # 可复用的工具库
│   └── template/
├── go.mod
├── go.sum
└── Makefile
```

CLI 工具通常不需要 domain/usecase/adapter 分层——它的"业务逻辑"就是命令处理，直接在 `internal/command/` 中实现即可。这个"按场景简化"是项目结构选择的实用主义——不是所有项目都需要完整 Clean Architecture，简单工具用简化版 Standard Layout 就够。

### 4.2 HTTP 微服务

```
user-service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── domain/             # User, Address 等领域对象
│   ├── port/               # Repository/Service 接口
│   ├── usecase/            # 注册、登录、查询等用例
│   ├── adapter/
│   │   ├── http/           # gin/echo handler + router 注册
│   │   ├── grpc/           # gRPC server 实现
│   │   └── repo/           # postgres/redis 实现
│   ├── infrastructure/     # DB/cache/messaging 初始化
│   └── app/                # 依赖注入组装
├── api/
│   ├── openapi/
│   │   └── user.yaml       # OpenAPI 3.0 spec
│   └── proto/
│       └── user.proto
├── configs/
│   ├── config.yaml
│   └── config.local.yaml
├── deployments/
│   └── k8s/
│       ├── deployment.yaml
│       └── service.yaml
├── go.mod
└── Makefile
```

HTTP 微服务是 Clean Architecture 的典型应用场景——业务逻辑复杂 enough 值得分层，且需要可测试性（mock 数据库）。这个"微服务用完整 Clean Architecture"是中型项目的推荐结构——既保持了清晰的分层，又不会过度设计。

### 4.3 Mono-repo（多服务单仓库）

大型团队常采用 mono-repo 将多个服务放在同一个 Git 仓库中管理，便于跨服务代码复用和原子性提交：

```
company-backend/
├── services/               # 各微服务
│   ├── user-service/
│   │   ├── cmd/
│   │   ├── internal/
│   │   └── go.mod          # 每个服务有独立的 go.mod
│   ├── order-service/
│   │   ├── cmd/
│   │   ├── internal/
│   │   └── go.mod
│   └── payment-service/
│
├── shared/                 # 跨服务共享代码（独立 Go module）
│   ├── pkg/
│   │   ├── logger/
│   │   ├── tracing/
│   │   └── middleware/
│   └── go.mod
│
├── proto/                  # 全局 proto 定义
│   ├── user/
│   └── order/
│
├── scripts/                # 全局构建脚本
│   ├── build-all.sh
│   └── test-all.sh
│
└── Makefile                # 统一入口
```

Mono-repo 的关键决策：**每个服务是独立的 Go module（独立的 `go.mod`）还是共享同一个 `go.mod`**？

- **独立 `go.mod`**：服务间依赖通过版本号管理（`replace` 指令指向本地路径），构建隔离性好，但跨服务修改需要同步升级版本号；
- **共享 `go.mod`**：最简单，但所有服务必须使用相同版本的依赖，大型项目中灵活性差。

这个"独立 vs 共享 go.mod"是 mono-repo 的核心决策——独立 go.mod 让服务间解耦（各自管理依赖），但跨服务修改需要同步版本；共享 go.mod 让跨服务修改简单（一次修改所有服务生效），但所有服务绑定相同依赖版本。选择取决于团队规模和跨服务修改频率——大团队 + 频繁跨服务修改用独立 go.mod，小团队 + 少量跨服务修改用共享 go.mod。

---

## 第 5 章 包设计的实践决策

### 5.1 包的大小：多大合适

Go 没有规定包的大小，但有两个反面教材：

**过大的包（Fat Package）**：一个包承担太多职责，内部耦合高，外部 API 臃肿。典型症状：包名是宽泛的词（`util`、`common`、`helper`、`misc`）——这类包名无法精确描述包的内容，往往是各种不相关代码的垃圾桶。

**过小的包（Nano Package）**：每个文件都是一个包，包间跳转频繁，循环依赖风险高。Go 的包比 Java 的类粒度更粗，一个包完全可以有十几个源文件。

**合适的包大小判断标准**：能用一句话描述包的职责，且这句话不需要"和（and）"这个词。`package http` 负责 HTTP 客户端和服务端（这里的"和"是合理的，因为两者天然属于一个 RFC 标准）；`package userutil` 负责"用户相关的工具函数"——这个包名本身就是警告信号。

这个"一句话描述且不需要'和'"是包大小的实用判断标准——如果描述包职责需要"和"，说明包承担了多个职责，应该拆分。这个标准比"文件数量"或"代码行数"更本质——它直接检查"职责单一性"。

### 5.2 循环依赖的解决方案

Go 禁止循环依赖，但写代码时很容易无意识地引入。常见解法：

**方案一：提取公共接口**。如果 A 包依赖 B 包，同时 B 包依赖 A 包的某个类型，将该类型提取到一个新包 C，让 A 和 B 都依赖 C。

**方案二：合并包**。如果两个包彼此高度耦合（几乎每个函数都用到对方的类型），说明它们本来就应该是一个包。

**方案三：依赖反转**。A 包定义一个接口，B 包实现这个接口，A 只依赖接口不依赖 B 的具体类型。

这三个方案的选择原则是"看耦合度"——高耦合（几乎每个函数都用到对方）用合并包，低耦合（只有一两个类型相关）用提取公共包，中等耦合（一方需要另一方的某个能力）用依赖反转。这个"按耦合度选择"是循环依赖解决的实用主义——不是机械套用某个方案，而是根据实际情况选择。

### 5.3 避免 God Package（上帝包）

```go
// 反面教材：package main 里写了所有业务逻辑
// 或者 package api 里既有路由、又有业务逻辑、又有数据库访问

// 一个包同时做了三件事（违反单一职责）：
package user

func CreateUser(db *sql.DB, w http.ResponseWriter, r *http.Request) {
    // 解析 HTTP 请求
    var req CreateUserRequest
    json.NewDecoder(r.Body).Decode(&req)
    
    // 业务逻辑
    if req.Email == "" {
        http.Error(w, "email required", 400)
        return
    }
    
    // 数据库操作
    result, err := db.ExecContext(r.Context(), "INSERT INTO users ...", req.Email)
    
    // 返回 HTTP 响应
    json.NewEncoder(w).Encode(result)
}
```

这个函数把 HTTP 处理、业务验证、数据库操作混在一起——任何一层的变化都需要修改这个函数，且无法单独测试任何一层的逻辑。这是"God Function"的典型——一个函数承担了多层职责，违反单一职责原则。Clean Architecture 的分层就是避免 God Function 的方法——每层只做自己的事，通过接口协作。

---

## 第 6 章 项目结构的设计认知

### 6.1 物理目录表达逻辑边界

项目结构的本质是"用物理目录表达逻辑边界"——目录名传达意图，依赖方向体现架构，包划分承载职责。好的项目结构让代码"自文档化"——开发者看目录就能理解项目的架构和职责划分，不需要读代码。这个"物理目录表达逻辑边界"是项目结构的核心价值——它让架构可见，让职责清晰，让依赖方向明确。

### 6.2 约定优于配置

Standard Layout 是"约定优于配置"的体现——社区约定 `/cmd` 放入口、`/internal` 放私有代码、`/pkg` 放公共库，开发者遵循约定即可，不需要每次项目都重新设计目录结构。这个"约定优于配置"让 Go 项目的结构一致性高——不同项目的目录结构相似，开发者切换项目时不需要重新学习"这个项目的目录是什么意思"。

### 6.3 分层的代价与收益

Clean Architecture 的分层有代价——多层目录增加文件跳转，接口引入额外抽象，依赖注入增加装配代码。但收益更大——业务逻辑可测试、框架可替换、职责清晰。这个"分层代价 vs 收益"的权衡是项目结构选择的实用主义——简单项目用简化版 Standard Layout（低代价），复杂项目用完整 Clean Architecture（高收益）。不是所有项目都需要完整分层，按项目复杂度选择合适的结构。

---

## 总结

本篇从包设计哲学出发，梳理了 Go 项目结构的两个层次：

**Standard Layout（物理目录约定）**：`/cmd` 存放各可执行程序入口（main 只做装配）；`/internal` 存放项目私有代码（编译器强制访问控制）；`/pkg` 存放可复用公共库（非必要不对外）；`/api` 存放接口定义文件。根据项目规模选择完整版或简化版。这个"物理目录约定"让项目结构自文档化，开发者看目录就能理解项目架构。

**Clean Architecture（逻辑分层约定）**：在 `internal/` 内部按照 `domain → port（接口）→ usecase → adapter → infrastructure` 的洋葱结构分层，**依赖方向只能从外到内**。核心工具是 Go 的隐式接口：Use Case 定义它所需要的 Repository 接口（消费者定义接口），具体的 PostgreSQL 实现只需满足这个接口——解耦框架与业务逻辑，让 Use Case 层完全可测试。这个"依赖倒置 + 消费者定义接口"是 Go Clean Architecture 的核心技巧。

**三个关键原则**：
- `main.go` 只做装配，不写业务（让业务可测试）；
- 除非有外部消费者，代码默认放 `internal/`（保持可重构）；
- 接口由消费者（Use Case）定义，而非生产者（Repository 实现）（依赖倒置）。

项目结构的本质是"用物理目录表达逻辑边界"——目录名传达意图，依赖方向体现架构，包划分承载职责。好的项目结构让代码"自文档化"——开发者看目录就能理解项目的架构和职责划分，不需要读代码。

下一篇介绍 Go 模块系统与依赖管理的完整机制：[[02 Go Module 与依赖管理]]。

---

## 参考资料

1. golang-standards/project-layout: https://github.com/golang-standards/project-layout——Go 社区项目结构参考。
2. Robert C. Martin,《Clean Architecture》, Pearson 2017——Clean Architecture 的原始著作。
3. Go Blog,《Organizing a Go module》: https://go.dev/doc/modules/layout——Go 官方对模块组织的建议。
4. Dave Cheney,《Practical Go: Real world advice for writing maintainable Go programs》——Go 包设计的实践建议。
5. Russell Cox,《Go & Versioning》——Go 模块系统设计的历史与原理。

---

> [!note] 思考题
> 1. 在一个包含 gRPC 服务、HTTP 网关和定时任务三种入口的 Go 项目中，`cmd/` 下有三个 `main.go`，它们共享 `internal/service` 层的业务逻辑。如果某天需要将 gRPC 服务和 HTTP 网关合并为同一个进程（减少部署复杂度），Standard Layout 的哪些目录约定会成为阻碍？你会如何调整项目结构？
> 2. `internal/` 目录利用 Go 编译器的访问限制实现了包级别的封装。但如果你的项目是一个开源框架（如 Gin），核心逻辑放在 `internal/` 下会导致外部用户无法扩展。Go 生态中的知名开源项目（如 Kubernetes、Prometheus）是如何处理"既要封装内部实现，又要暴露扩展点"这个矛盾的？
> 3. Clean Architecture 强调依赖方向从外层指向内层（Handler → UseCase → Repository）。在 Go 中用 interface 实现依赖反转时，interface 应该定义在调用方（UseCase 层）还是实现方（Repository 层）？Go 社区的惯例与 Java 社区有什么本质区别？为什么？
> 4. Standard Layout 是"约定优于配置"的体现，但 Go 官方并未强制这个结构。如果团队中有人不遵循约定（如把业务逻辑放在 `main.go` 里，或把内部代码放在 `/pkg` 中），你会如何处理？是强制约定（如 lint 规则），还是允许灵活？这个"约定 vs 灵活"的权衡在工程管理中如何决策？
