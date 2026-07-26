---
title: "05 SkyWalking Java Agent 字节码增强原理"
date: 2026-03-03
tags: [Byte Buddy, Instrumentation API, Java Agent, SkyWalking, 可观测性, 字节码增强]
aliases: []
---

# 05 SkyWalking Java Agent 字节码增强原理

**摘要：**

SkyWalking 之所以能实现"应用代码零修改"的无侵入埋点，核心技术是 **Java Agent 字节码增强**——在 JVM 类加载时，拦截目标类的字节码，动态注入追踪逻辑。这不是 SkyWalking 独创的技术，而是 JVM 平台的一项底层能力。本文从 JVM 的 **Java Instrumentation API** 出发，解释 Agent 如何获得修改字节码的权限；然后深入 [[Byte Buddy]]——SkyWalking 底层使用的字节码操作框架——的工作原理；最后剖析 SkyWalking Agent 的插件体系如何将"拦截哪个类的哪个方法"和"注入什么追踪逻辑"解耦为可扩展的插件机制，使得社区能够不断增加对新框架的追踪支持。

---

## 第 1 章 Java Instrumentation API：Agent 的入场券

### 1.1 什么是 Java Agent

在讨论 SkyWalking 之前，需要先理解 JVM 层面的 **Java Agent** 机制——它是所有 Java 字节码增强技术的基础设施。

**Java Agent** 是一个特殊的 JAR 包，通过 JVM 启动参数 `-javaagent:path/to/agent.jar` 加载。JVM 在启动时，会在应用的 `main()` 方法执行之前，先调用 Agent JAR 中指定的 `premain()` 方法。在 `premain()` 中，Agent 可以注册一个 **ClassFileTransformer**，这个 Transformer 会在每个类被 ClassLoader 加载时被回调，获得**修改该类字节码的机会**。

这个机制由 `java.lang.instrument` 包提供，核心接口是 `Instrumentation`：

```java
// Agent 的入口方法：JVM 在 main() 之前调用
public static void premain(String agentArgs, Instrumentation inst) {
    // 注册一个 ClassFileTransformer
    // 之后每个类加载时，transform() 方法都会被调用
    inst.addTransformer(new MyClassFileTransformer(), true);
}

public class MyClassFileTransformer implements ClassFileTransformer {
    @Override
    public byte[] transform(
        ClassLoader loader,          // 加载该类的 ClassLoader
        String className,            // 类名（如 "javax/servlet/http/HttpServlet"）
        Class<?> classBeingRedefined, // 如果是 retransform，这是原始 Class 对象
        ProtectionDomain domain,
        byte[] classfileBuffer       // 原始字节码
    ) {
        // 检查是否需要增强这个类
        if (shouldEnhance(className)) {
            // 修改字节码并返回
            return enhanceBytecode(classfileBuffer);
        }
        // 返回 null 表示不修改
        return null;
    }
}
```

### 1.2 premain vs agentmain

Java Agent 有两种加载方式：

| 方式 | 入口方法 | 加载时机 | 使用场景 |
| :--- | :--- | :--- | :--- |
| **静态加载** | `premain()` | JVM 启动时，`main()` 之前 | SkyWalking Agent 的标准使用方式 |
| **动态加载** | `agentmain()` | JVM 运行中，通过 Attach API 注入 | 热部署、在线诊断（如 [[Arthas]]）|

SkyWalking Agent 使用 `premain()` 静态加载，因为：
- **premain 能拦截所有类的首次加载**：在 `main()` 之前注册 Transformer，确保应用中所有类的加载都能被拦截
- **agentmain 需要 retransform 已加载的类**：如果类已经被加载（如 JDK 核心类），需要调用 `inst.retransformClasses()` 重新触发 transform，这个操作有诸多限制（不能添加/删除字段和方法，只能修改方法体）且性能开销较大

### 1.3 ClassLoader 隔离

Agent 的字节码运行在应用进程中，但 Agent 的类和应用的类需要**隔离**——Agent 依赖的 Byte Buddy、gRPC Client 等库不应该与应用依赖的同名库冲突。

SkyWalking Agent 通过**自定义 ClassLoader**（`AgentClassLoader`）实现隔离：

```
JVM ClassLoader 层级：

Bootstrap ClassLoader（加载 rt.jar 等 JDK 核心类）
    ↓
AgentClassLoader（加载 SkyWalking Agent 的类和插件）
    ↓（不是父子关系，而是平行）
Application ClassLoader（加载应用的类）
```

Agent 的核心类（如 `ContextManager`、`AbstractSpan`）由 `AgentClassLoader` 加载，与 Application ClassLoader 隔离。但有一个例外：**增强后的方法体中需要调用 Agent 的 API**（如创建 Span），而增强后的方法体运行在 Application ClassLoader 的上下文中。SkyWalking 通过将关键桥接类加载到 **Bootstrap ClassLoader**（所有 ClassLoader 的祖先）中来解决这个问题——Bootstrap ClassLoader 中的类对所有 ClassLoader 可见。

---

## 第 2 章 Byte Buddy：字节码操作的瑞士军刀

### 2.1 为什么选择 Byte Buddy

直接操作 JVM 字节码（`byte[]` 数组）是一项极其繁琐且容易出错的工作。Java 生态中有多个字节码操作框架：

| 框架 | 抽象层级 | 复杂度 | 性能 | SkyWalking 使用 |
| :--- | :--- | :--- | :--- | :--- |
| **ASM** | 最低（字节码指令级）| 极高 | 最优 | 否（太底层）|
| **Javassist** | 中等（源码级修改）| 中等 | 良好 | 早期版本使用 |
| **Byte Buddy** | 最高（Java API 级）| 低 | 优秀 | 当前使用 |
| **CGLIB** | 高（代理级）| 低 | 良好 | 否（功能不够）|

[[Byte Buddy]] 由 Rafael Winterhalter 开发，它的核心优势是：**用纯 Java API 描述字节码修改，不需要了解任何 JVM 字节码指令**。开发者只需要定义"拦截哪个方法"和"在方法前后执行什么逻辑"，Byte Buddy 自动生成正确的字节码。

SkyWalking 早期使用 Javassist，后来切换到 Byte Buddy，原因有二：
1. **性能更优**：Byte Buddy 生成的字节码质量高（接近手写字节码），运行时开销更小
2. **API 更安全**：Byte Buddy 的 API 设计具有强类型安全性，编译期就能发现很多错误；Javassist 需要以字符串形式编写 Java 代码片段，错误只在运行时才暴露

### 2.2 Byte Buddy 的核心 API

Byte Buddy 的使用范式是**声明式**的——描述"做什么"而不是"怎么做"：

```java
// 示例：使用 Byte Buddy 增强 HttpServlet.service() 方法
new AgentBuilder.Default()
    // 1. 匹配条件：拦截哪些类
    .type(named("javax.servlet.http.HttpServlet"))
    // 2. 增强逻辑：对匹配的类做什么修改
    .transform((builder, typeDescription, classLoader, module, domain) -> 
        builder.method(
            // 匹配 service(HttpServletRequest, HttpServletResponse) 方法
            named("service")
                .and(takesArguments(2))
                .and(takesArgument(0, named("javax.servlet.http.HttpServletRequest")))
        )
        // 3. 委托给拦截器：在方法前后执行自定义逻辑
        .intercept(MethodDelegation.to(HttpServletInterceptor.class))
    )
    // 4. 注册到 Instrumentation
    .installOn(instrumentation);
```

**拦截器（Interceptor）** 是一个普通的 Java 类，使用 Byte Buddy 的注解标记方法参数：

```java
public class HttpServletInterceptor {
    
    @RuntimeType  // 表示返回值类型在运行时确定
    public static Object intercept(
        @This Object servlet,           // 被拦截的对象实例
        @AllArguments Object[] args,     // 方法的所有参数
        @Origin Method method,           // 被拦截的原始方法
        @SuperCall Callable<?> callable  // 调用原始方法的 Callable
    ) throws Exception {
        // ===== 方法执行前：创建 Span =====
        HttpServletRequest request = (HttpServletRequest) args[0];
        Span span = ContextManager.createEntrySpan(request.getRequestURI());
        span.setComponent("Tomcat");
        span.setTag("http.method", request.getMethod());
        
        try {
            // ===== 调用原始方法 =====
            Object result = callable.call();
            
            // ===== 方法执行后：记录结果 =====
            HttpServletResponse response = (HttpServletResponse) args[1];
            span.setTag("http.status_code", String.valueOf(response.getStatus()));
            if (response.getStatus() >= 400) {
                span.errorOccurred();
            }
            return result;
        } catch (Exception e) {
            // ===== 异常处理：记录错误 =====
            span.errorOccurred();
            span.log(e);
            throw e;
        } finally {
            // ===== 清理：结束 Span =====
            ContextManager.stopSpan();
        }
    }
}
```

Byte Buddy 在类加载时将上述拦截逻辑编译为字节码，注入到 `HttpServlet.service()` 方法中。运行时，当 Tomcat 调用 `HttpServlet.service()` 时，实际执行的是增强后的版本——先创建 Span，再执行原始逻辑，最后结束 Span。

### 2.3 字节码增强的时机与性能影响

字节码增强发生在**类加载时**（Class Loading Time），不是在每次方法调用时。这意味着：

- **增强只发生一次**：每个类只在第一次被 ClassLoader 加载时经过 Transformer，之后 JVM 使用增强后的字节码，不再有 Transformer 的开销
- **运行时开销 ≈ 拦截器逻辑本身的开销**：增强后的方法体中增加了拦截器的调用（创建 Span、设置属性、结束 Span），这个开销通常在**微秒级**
- **JIT 优化友好**：增强后的字节码对 [[JVM]] 的 JIT 编译器是透明的——JIT 会将增强后的方法体与原始逻辑一起优化（内联、逃逸分析等）

**启动时间影响**：Agent 在 JVM 启动时需要遍历所有加载的类，检查是否需要增强。这个过程会增加应用的启动时间，通常在**数百毫秒到几秒**（取决于应用的类数量和启用的插件数量）。对于长期运行的服务来说，这个一次性开销完全可以接受；但对于 Serverless 函数（冷启动敏感），可能需要考虑优化。

---

## 第 3 章 SkyWalking 的插件体系

### 3.1 插件的本质：将"增强什么"与"如何增强"解耦

SkyWalking Agent 需要支持数十种框架（Tomcat、Spring MVC、Dubbo、gRPC、MySQL JDBC、Redis Jedis、Kafka 等），每种框架需要拦截不同的类和方法，注入不同的追踪逻辑。如果将所有增强逻辑硬编码在 Agent 核心中，代码会极其臃肿且难以维护。

SkyWalking 的解决方案是**插件体系**——每个框架的追踪支持被封装为一个独立的**插件（Plugin）**，插件定义了三个关键信息：

1. **增强目标**：拦截哪个类的哪个方法（ClassMatch + MethodMatch）
2. **拦截器**：在方法前后执行什么逻辑（Interceptor）
3. **Span 语义**：创建什么类型的 Span（Entry/Exit/Local）、设置什么 Component 名称和 Tags

### 3.2 插件的接口定义

每个 SkyWalking 插件需要实现 `AbstractClassEnhancePluginDefine` 抽象类（或其子类），定义以下关键方法：

```java
// 伪代码：SkyWalking 插件接口
public abstract class AbstractClassEnhancePluginDefine {
    
    // 1. 定义要增强的类
    protected abstract ClassMatch enhanceClass();
    
    // 2. 定义要增强的实例方法及其拦截器
    protected abstract InstanceMethodsInterceptPoint[] getInstanceMethodsInterceptPoints();
    
    // 3. 定义要增强的构造方法及其拦截器
    protected abstract ConstructorInterceptPoint[] getConstructorInterceptPoints();
    
    // 4. 定义要增强的静态方法及其拦截器（可选）
    protected abstract StaticMethodsInterceptPoint[] getStaticMethodsInterceptPoints();
}
```

**一个具体的插件示例：Tomcat 插件**

```java
public class TomcatInstrumentation extends ClassInstanceMethodsEnhancePluginDefine {

    @Override
    protected ClassMatch enhanceClass() {
        // 增强 Tomcat 的 StandardHostValve 类
        // 这个类是 Tomcat 请求处理管道中的关键环节
        return byName("org.apache.catalina.core.StandardHostValve");
    }

    @Override
    public ConstructorInterceptPoint[] getConstructorInterceptPoints() {
        return null;  // 不增强构造方法
    }

    @Override
    public InstanceMethodsInterceptPoint[] getInstanceMethodsInterceptPoints() {
        return new InstanceMethodsInterceptPoint[] {
            new InstanceMethodsInterceptPoint() {
                @Override
                public ElementMatcher<MethodDescription> getMethodsMatcher() {
                    // 拦截 invoke(Request, Response) 方法
                    return named("invoke");
                }

                @Override
                public String getMethodsInterceptor() {
                    // 指定拦截器类名
                    return "org.apache.skywalking.apm.plugin.tomcat.TomcatInvokeInterceptor";
                }

                @Override
                public boolean isOverrideArgs() {
                    return false;  // 不修改方法参数
                }
            }
        };
    }
}
```

### 3.3 插件的发现与加载

SkyWalking Agent 使用 **SPI（Service Provider Interface）** 机制发现和加载插件：

```
skywalking-agent/
├── skywalking-agent.jar          ← Agent 核心
├── config/
│   └── agent.config              ← 配置文件
├── plugins/                      ← 插件目录（自动加载）
│   ├── apm-tomcat-plugin.jar
│   ├── apm-spring-mvc-plugin.jar
│   ├── apm-dubbo-plugin.jar
│   ├── apm-mysql-plugin.jar
│   ├── apm-redis-jedis-plugin.jar
│   └── ...
├── optional-plugins/             ← 可选插件（手动移入 plugins/ 启用）
│   ├── apm-trace-ignore-plugin.jar
│   ├── apm-spring-cloud-gateway-plugin.jar
│   └── ...
└── optional-reporter-plugins/    ← 可选上报插件
    ├── kafka-reporter-plugin.jar
    └── ...
```

Agent 启动时：
1. 扫描 `plugins/` 目录下的所有 JAR 文件
2. 通过 SPI 加载每个 JAR 中的 `AbstractClassEnhancePluginDefine` 实现
3. 收集所有插件的 `enhanceClass()` 返回的类匹配规则
4. 将所有匹配规则注册到 Byte Buddy 的 AgentBuilder 中
5. AgentBuilder 安装到 Instrumentation 上，开始拦截类加载

**按需启用/禁用插件**：不需要某个框架的追踪支持时，直接从 `plugins/` 目录移除对应的 JAR 文件即可。需要可选功能时，从 `optional-plugins/` 移入 `plugins/`。这种基于文件系统的插件管理方式非常直观。

### 3.4 插件开发的三种拦截模式

SkyWalking 根据 Span 类型，定义了三种拦截器基类：

**EntrySpan 拦截器**：用于服务入口（如 HTTP 请求接收、消息消费）

拦截器需要：
- 从传入的请求中提取 SpanContext（如从 HTTP Header 中提取 `sw8`）
- 创建 EntrySpan，将提取的 SpanContext 作为父 Context
- 设置操作名（如 `GET /api/orders`）和组件名（如 `Tomcat`）

**ExitSpan 拦截器**：用于服务出口（如 HTTP 请求发送、数据库查询）

拦截器需要：
- 创建 ExitSpan，记录被调用方的地址（peer）
- 将当前 SpanContext 序列化并注入到传输载体中（如 HTTP Header）
- 设置操作名（如 `MySQL/JDBC/PreparedStatement/execute`）和组件名（如 `MySQL`）

**LocalSpan 拦截器**：用于进程内部操作（如本地缓存查询、业务逻辑处理）

拦截器只需要：
- 创建 LocalSpan，记录操作名和组件名
- 不涉及跨进程的 Context 传播

---

## 第 4 章 Context 管理的内部实现

### 4.1 ContextManager：线程级的 Trace 状态机

`ContextManager` 是 SkyWalking Agent 中管理 Trace 上下文的核心类。它通过 [[ThreadLocal]] 维护每个线程的 Trace 状态：

```java
// 简化的 ContextManager 实现逻辑
public class ContextManager {
    // 每个线程持有一个 AbstractTracerContext
    private static ThreadLocal<AbstractTracerContext> CONTEXT = new ThreadLocal<>();
    
    // 创建入口 Span（服务接收请求时调用）
    public static AbstractSpan createEntrySpan(String operationName, ContextCarrier carrier) {
        AbstractTracerContext context = getOrCreate();
        return context.createEntrySpan(operationName);
    }
    
    // 创建出口 Span（调用下游服务时调用）
    public static AbstractSpan createExitSpan(String operationName, ContextCarrier carrier, String peer) {
        AbstractTracerContext context = getOrCreate();
        return context.createExitSpan(operationName, peer);
    }
    
    // 创建本地 Span
    public static AbstractSpan createLocalSpan(String operationName) {
        AbstractTracerContext context = getOrCreate();
        return context.createLocalSpan(operationName);
    }
    
    // 结束当前 Span
    public static void stopSpan() {
        AbstractTracerContext context = CONTEXT.get();
        if (context.stopSpan(context.activeSpan())) {
            // 所有 Span 都已结束，Segment 完成
            // 将 Segment 放入上报缓冲区
            TracingContext.ListenerManager.notifyFinish(context.capture());
            CONTEXT.remove();  // 清理 ThreadLocal，防止内存泄漏
        }
    }
    
    private static AbstractTracerContext getOrCreate() {
        AbstractTracerContext context = CONTEXT.get();
        if (context == null) {
            // 检查采样策略：是否需要记录这个 Trace
            if (SamplingService.trySampling()) {
                context = new TracingContext();  // 真实的追踪上下文
            } else {
                context = new IgnoredTracerContext();  // 忽略上下文（不记录任何数据）
            }
            CONTEXT.set(context);
        }
        return context;
    }
}
```

注意 `IgnoredTracerContext` 的设计：当采样策略决定不记录当前 Trace 时，ContextManager 创建一个"空"上下文，所有 Span 创建和结束操作都是 No-op，几乎零开销。这比"创建真实 Span 然后在上报时丢弃"更高效。

### 4.2 Span 的栈式管理

一个线程中可能嵌套多个 Span（如 EntrySpan → LocalSpan → ExitSpan），SkyWalking 使用**栈（Stack）**来管理 Span 的嵌套关系：

```
线程执行顺序：
  1. HTTP 请求到达 → createEntrySpan("GET /api/orders")    栈：[Entry]
  2. 进入业务逻辑 → createLocalSpan("OrderService.create")  栈：[Entry, Local]
  3. 调用数据库 → createExitSpan("MySQL/SELECT", "mysql:3306") 栈：[Entry, Local, Exit]
  4. 数据库返回 → stopSpan()                                 栈：[Entry, Local]
  5. 调用支付服务 → createExitSpan("POST /pay", "pay:8080")  栈：[Entry, Local, Exit]
  6. 支付返回 → stopSpan()                                   栈：[Entry, Local]
  7. 业务完成 → stopSpan()                                   栈：[Entry]
  8. HTTP 响应 → stopSpan()                                  栈：[]  → Segment 完成
```

**栈顶的 Span 就是当前的 Active Span**——新创建的 Span 自动以栈顶 Span 为父。

### 4.3 跨线程的 Context 传递

当业务代码使用异步编程（如将任务提交到线程池）时，新线程的 ThreadLocal 中没有 Trace Context，链路会"断裂"。

SkyWalking 提供了两种机制解决这个问题：

**机制一：ContextSnapshot 手动传递**

```java
// 主线程：捕获当前 Context 的快照
ContextSnapshot snapshot = ContextManager.capture();

// 提交到线程池
executor.submit(() -> {
    // 子线程：恢复 Context
    ContextManager.continued(snapshot);
    try {
        // 在子线程中创建的 Span 会自动关联到原始 Trace
        AbstractSpan span = ContextManager.createLocalSpan("async-task");
        // ... 业务逻辑
        ContextManager.stopSpan();
    } finally {
        ContextManager.cleanAfterAsync();
    }
});
```

**机制二：@TraceCrossThread 注解 + Agent 自动增强**

SkyWalking 提供了 `@TraceCrossThread` 注解和对应的 Agent 插件，可以自动增强 `Runnable`、`Callable`、`Supplier` 等异步入口：

```java
@TraceCrossThread
public class MyTask implements Runnable {
    @Override
    public void run() {
        // Agent 自动在 run() 入口恢复 Context
        // 不需要手动调用 capture() 和 continued()
    }
}

// 使用方式与普通 Runnable 完全一样
executor.submit(new MyTask());
```

Agent 的 `@TraceCrossThread` 插件在类加载时，自动将 `ContextSnapshot` 的捕获和恢复逻辑注入到被注解类的构造方法和 `run()`/`call()` 方法中。

---

## 第 5 章 常见插件的增强策略

### 5.1 JDBC 插件：数据库调用追踪

JDBC 插件拦截 `java.sql.PreparedStatement` 的 `execute()`、`executeQuery()`、`executeUpdate()` 方法，创建 ExitSpan：

```
增强目标：java.sql.PreparedStatement.execute*()
Span 类型：ExitSpan
Component：MySQL / PostgreSQL / Oracle（根据 JDBC URL 自动识别）
Peer：从 Connection 的 URL 中提取（如 "mysql:3306"）
Tags：
  - db.type: mysql
  - db.instance: order_db
  - db.statement: SELECT * FROM orders WHERE id = ?（参数化 SQL，不含实际值）
```

> [!warning] SQL 记录的安全考量
> SkyWalking 默认记录**参数化 SQL**（`SELECT * FROM orders WHERE id = ?`），不记录实际的参数值——这是为了防止敏感数据（如用户密码、身份证号）泄露到追踪系统中。如果需要记录完整 SQL（含参数），需要额外启用 `trace_sql_parameters` 配置，并自行承担安全风险。

### 5.2 Spring MVC 插件：HTTP 入口追踪

Spring MVC 插件拦截 `@RequestMapping` 标注的 Controller 方法，创建 EntrySpan：

```
增强目标：带有 @RequestMapping 注解的方法
Span 类型：EntrySpan
Component：SpringMVC
Tags：
  - http.method: GET / POST / PUT / DELETE
  - url: /api/orders/{id}
  - http.status_code: 200
```

一个微妙的设计点：Spring MVC 插件的增强目标不是 `DispatcherServlet`（那是 Servlet 容器层面的入口），而是具体的 Controller 方法。这样做的好处是 Span 的操作名可以精确到 Controller 方法级别（如 `OrderController.getOrder`），而不是泛泛的 `DispatcherServlet.service()`。

### 5.3 HTTP Client 插件：出口调用追踪

以 OkHttp 插件为例，拦截 `okhttp3.RealCall.execute()` 和 `enqueue()` 方法，创建 ExitSpan 并注入 sw8 Header：

```
增强目标：okhttp3.RealCall.execute() / enqueue()
Span 类型：ExitSpan
Component：OKHttp
Peer：从 Request.url() 中提取主机和端口
Context Propagation：
  1. 在发送请求前，将当前 SpanContext 序列化为 sw8 格式
  2. 添加到 HTTP Request 的 Header 中
  3. 被调用方的 Agent（如 Tomcat 插件）从 Header 中提取 sw8
  4. 还原为 SpanContext，作为新 Segment 的父 Context
```

---

## 第 6 章 sw8 协议：SkyWalking 的上下文传播格式

### 6.1 sw8 Header 的结构

SkyWalking 使用自定义的 `sw8` HTTP Header 传播 Trace Context。sw8 的格式是用 `-` 分隔的多个字段，每个字段用 Base64 编码：

```
sw8: 1-TRACE_ID-SEGMENT_ID-SPAN_ID-SERVICE-INSTANCE-ENDPOINT-PEER_HOST

各字段含义：
  1              → 采样标志（1=采样，0=不采样）
  TRACE_ID       → Trace ID（Base64 编码）
  SEGMENT_ID     → 父 Segment ID（Base64 编码）
  SPAN_ID        → 父 Span ID（数字）
  SERVICE        → 父服务名（Base64 编码）
  INSTANCE       → 父实例名（Base64 编码）
  ENDPOINT       → 父端点名（Base64 编码）
  PEER_HOST      → 目标地址（Base64 编码）
```

**为什么不直接使用 W3C Trace Context？**

SkyWalking 的 sw8 携带了比 W3C `traceparent` 更多的信息——特别是**父服务名、父实例名、父端点名**。这些信息让下游服务在接收请求时，不需要查询任何外部系统，就能知道"谁调用了我"——OAP 利用这个信息直接构建服务拓扑图。

W3C `traceparent` 只携带 Trace ID + Parent Span ID + Flags，OAP 需要在收到双方的 Segment 后，通过 Span 的 `peer` 信息和反向查找来建立调用关系——这比 sw8 的方式更间接。

SkyWalking 从 8.x 版本开始同时支持 sw8 和 W3C Trace Context，通过配置选择使用哪种传播格式。

---

## 参考资料

1. Java Instrumentation API Specification：https://docs.oracle.com/javase/8/docs/api/java/lang/instrument/package-summary.html
2. Byte Buddy 官方文档：https://bytebuddy.net/
3. Rafael Winterhalter (2015). *Byte Buddy: Runtime Code Generation for the Java Virtual Machine*. PhD Thesis.
4. Apache SkyWalking Java Agent 源码：https://github.com/apache/skywalking-java
5. SkyWalking Agent Plugin Development Guide：https://skywalking.apache.org/docs/skywalking-java/latest/en/setup/service-agent/java-agent/java-plugin-development-guide/
6. SkyWalking Cross Process Propagation Headers Protocol：https://skywalking.apache.org/docs/main/latest/en/api/x-process-propagation-headers-v3/

---

> [!note] 思考题
> 1. OTel Metrics SDK 支持导出为 Prometheus 格式（Pull 模式，暴露 `/metrics` 端点）和 OTLP 格式（Push 模式，推送到 Collector）。在已有 Prometheus 基础设施的环境中，你会选择哪种导出方式？两种方式在时间序列的命名和标签格式上有什么差异？
> 2. OTel 的 Metric 类型：Counter（单调递增，如请求总数）、Gauge（可增可减，如当前连接数）、Histogram（分布统计，如延迟分布）。OTel 的 Histogram 使用 Explicit Bucket Histogram（预定义桶边界）或 Exponential Histogram（自适应桶）。Exponential Histogram 在未知数据分布时更灵活——但 Prometheus 的 Histogram 使用固定桶。两者如何转换？
> 3. Metrics 的高基数（High Cardinality）问题——如果标签值有百万级（如 `user_id`），时间序列数量爆炸导致存储和查询性能崩溃。OTel SDK 层面如何控制高基数（如在 SDK 中丢弃高基数标签）？Collector 的 `filter` Processor 是否能帮助？
