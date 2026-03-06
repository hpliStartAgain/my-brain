---
title: "Actuator——健康检查、指标暴露与自定义端点"
date: 2026-03-04
tags: [Java, SpringBoot, Actuator, HealthIndicator, Micrometer, 监控, 可观测性, Endpoint]
aliases: []
---

# Actuator——健康检查、指标暴露与自定义端点

## 摘要

Spring Boot Actuator 是应用"可观测性"的基础设施。在微服务架构下，应用不仅要能"跑起来"，还必须能够被监控系统实时感知其状态——Kubernetes 的 liveness/readiness 探针依赖 `/actuator/health`，Prometheus 从 `/actuator/prometheus` 拉取指标，开发者通过 `/actuator/env` 排查配置问题，通过 `/actuator/threaddump` 分析线程阻塞……这些能力都由 Actuator 提供。本文深入剖析 Actuator 的架构设计：端点（`Endpoint`）的注册与暴露机制、`HealthIndicator` 的聚合算法与组管理、Micrometer 指标体系的核心抽象（`Meter`、`MeterRegistry`、`MeterFilter`），以及如何从零开发一个生产级别的自定义端点。

---

## 第 1 章 可观测性：Actuator 存在的理由

### 1.1 单体时代的运维与微服务时代的挑战

在单体应用时代，运维工程师通常通过以下方式感知应用状态：
- 登录服务器查看日志文件；
- 通过 `top`、`jstat`、`jstack` 等命令查看 JVM 状态；
- 配置 Nagios/Zabbix 等监控工具定时发送 HTTP 探测请求。

这些方式在 5-10 个服务器节点的规模下勉强可行。但当架构演进到数十个微服务、每个服务运行在 Kubernetes 集群的多个 Pod 中时，这种手工运维模式彻底失效：
- Pod 随时可能被调度、重启、扩缩容，IP 地址动态变化；
- 数百个服务实例，不可能逐一 SSH 登录查看日志；
- Kubernetes 需要通过 HTTP 端点实时判断 Pod 是否健康、是否就绪接收流量。

这就是"可观测性"（Observability）概念兴起的背景。可观测性的三大支柱：
- **Logs（日志）**：结构化日志 + 日志聚合（ELK、Loki）；
- **Metrics（指标）**：时序数据 + 指标展示（Prometheus + Grafana）；
- **Traces（链路追踪）**：分布式请求链路（Jaeger、Zipkin）。

Spring Boot Actuator 主要解决 **Metrics** 和**应用状态探测**两个问题，是可观测性基础设施的应用侧组件。

### 1.2 引入 Actuator

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

引入后，Spring Boot 会自动注册一批 HTTP 端点（默认挂载在 `/actuator` 路径下）：

```bash
# 查看所有已暴露的端点
curl http://localhost:8080/actuator
```

默认只暴露 `health` 和 `info` 两个端点（出于安全考虑）。其他端点需要显式开启：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: "*"   # 暴露所有端点（开发环境）
        # include: health,info,metrics,prometheus  # 生产环境按需暴露
  endpoint:
    health:
      show-details: always  # 显示所有 HealthIndicator 的详细信息
```

---

## 第 2 章 Actuator 的架构：端点的注册与暴露

### 2.1 Endpoint：端点的核心抽象

Actuator 的每个功能点都是一个 `Endpoint`。`@Endpoint` 是定义端点的核心注解：

```java
// Actuator 端点的定义方式
@Endpoint(id = "health")         // 通用端点（支持 HTTP + JMX）
@WebEndpoint(id = "health")      // 仅支持 HTTP 的端点
@JmxEndpoint(id = "health")      // 仅支持 JMX 的端点
@ServletEndpoint(id = "upload")  // 基于 Servlet 的端点（处理文件上传等复杂场景）
```

端点内的方法通过操作注解标识其 HTTP 语义：

```java
@Endpoint(id = "myservice")
public class MyServiceEndpoint {
    
    // 对应 HTTP GET（只读查询）
    @ReadOperation
    public Map<String, Object> status() {
        return Map.of("status", "running", "version", "1.0.0");
    }
    
    // 对应 HTTP POST（写操作，修改状态）
    @WriteOperation
    public void reload(@Selector String component) {
        // 重新加载指定组件的配置
    }
    
    // 对应 HTTP DELETE（删除操作）
    @DeleteOperation
    public void clear(@Selector String cacheRegion) {
        // 清除指定缓存区域
    }
}
```

`@Selector` 注解标注的参数映射到 URL 路径段：`GET /actuator/myservice/component-name` → `@Selector String component = "component-name"`。

### 2.2 端点的暴露控制：三个层次

Actuator 对端点的控制有三个层次，从内到外：

**层次一：是否启用（enabled）**
```yaml
management:
  endpoint:
    shutdown:
      enabled: true  # 默认 false，关机端点需要显式启用
    health:
      enabled: true  # 默认 true
```

**层次二：是否暴露（exposed）**
```yaml
management:
  endpoints:
    web:
      exposure:
        include: "health,info,metrics"  # 只暴露这三个
        exclude: "env,beans"            # 排除这两个（优先于 include）
    jmx:
      exposure:
        include: "*"  # JMX 默认暴露所有
```

**层次三：安全访问控制（Spring Security）**
```java
@Configuration
public class ActuatorSecurityConfig {
    
    @Bean
    public SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
        return http
            .requestMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeRequests(auth -> auth
                // health 和 info 允许匿名访问
                .requestMatchers(EndpointRequest.to("health", "info")).permitAll()
                // 其他端点需要 ACTUATOR_ADMIN 角色
                .anyRequest().hasRole("ACTUATOR_ADMIN")
            )
            .httpBasic(Customizer.withDefaults())
            .build();
    }
}
```

> [!warning] 生产环境的端点安全
> 暴露 `/actuator/env` 会泄露所有配置属性（包括数据库密码，虽然敏感值被遮蔽，但键名本身也是信息）；暴露 `/actuator/shutdown` 允许远程关闭应用；暴露 `/actuator/heapdump` 允许下载堆转储文件（可能包含内存中的敏感数据）。生产环境必须通过 Spring Security 或网络层防火墙严格控制 Actuator 端点的访问。

### 2.3 独立端口：将 Actuator 隔离到管理端口

最佳实践是将 Actuator 运行在与业务 API 不同的端口上，通过网络策略确保只有内部监控系统可以访问 Actuator 端口：

```yaml
management:
  server:
    port: 8090          # Actuator 专用端口
    address: 127.0.0.1  # 只监听 localhost（更安全）
  endpoints:
    web:
      base-path: /      # 可选：去掉 /actuator 前缀，直接 /health
```

Kubernetes 配置：

```yaml
# 业务流量走 8080
# 监控探针走 8090（只在集群内部可访问）
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8090
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8090
```

---

## 第 3 章 HealthIndicator：健康检查的核心机制

### 3.1 Health 的数据结构

`Health` 对象是健康检查结果的载体：

```java
// Health 的状态枚举
// 有序：DOWN > OUT_OF_SERVICE > UNKNOWN > UP
// 聚合时取最严重的状态
Status.DOWN          // 服务不健康（返回 503）
Status.OUT_OF_SERVICE // 服务暂时下线（返回 503）
Status.UNKNOWN       // 状态未知（返回 200，但表示无法判断）
Status.UP            // 服务健康（返回 200）

// 构建 Health 对象
Health health = Health.up()
    .withDetail("database", "MySQL 8.0.33")
    .withDetail("connections", "8/20")
    .withDetail("responseTime", "2ms")
    .build();

Health degraded = Health.status("DEGRADED")  // 自定义状态
    .withDetail("message", "部分功能不可用")
    .build();
```

### 3.2 内置 HealthIndicator

Spring Boot 自动配置了一批常用组件的 `HealthIndicator`：

| HealthIndicator | 检查内容 | 激活条件 |
| --- | --- | --- |
| `DataSourceHealthIndicator` | 执行验证 SQL（如 `SELECT 1`） | 类路径有 JDBC DataSource |
| `RedisHealthIndicator` | `PING` 命令 | 类路径有 spring-data-redis |
| `MongoHealthIndicator` | `isMaster` 命令 | 类路径有 spring-data-mongodb |
| `RabbitHealthIndicator` | AMQP 连接检查 | 类路径有 spring-amqp |
| `KafkaHealthIndicator` | 描述集群元数据 | 类路径有 spring-kafka |
| `DiskSpaceHealthIndicator` | 检查磁盘空间是否低于阈值 | 始终激活 |
| `LivenessStateHealthIndicator` | 应用 Liveness 状态 | Spring Boot 的 LivenessState |
| `ReadinessStateHealthIndicator` | 应用 Readiness 状态 | Spring Boot 的 ReadinessState |

### 3.3 聚合算法：CompositeHealthContributor

当存在多个 `HealthIndicator` 时，`HealthEndpoint` 如何把所有结果聚合成一个最终状态？

聚合逻辑由 `StatusAggregator` 控制：

```java
// 默认聚合顺序（从最严重到最轻微）：DOWN > OUT_OF_SERVICE > UNKNOWN > UP
// 只要有任一组件 DOWN，最终状态就是 DOWN
// 配置自定义顺序：
management:
  health:
    status:
      order: DOWN, OUT_OF_SERVICE, UNKNOWN, UP
      # 配置 HTTP 响应码映射
      http-mapping:
        DOWN: 503
        OUT_OF_SERVICE: 503
        UNKNOWN: 200
        UP: 200
```

`CompositeHealthContributor` 允许将多个 `HealthIndicator` 组合为一个组，以树形结构展示：

```java
@Component("externalServices")
public class ExternalServicesHealthIndicator 
        implements CompositeHealthContributor {
    
    private final Map<String, HealthContributor> indicators;
    
    public ExternalServicesHealthIndicator(
            PaymentServiceClient paymentClient,
            NotificationServiceClient notificationClient) {
        
        this.indicators = new LinkedHashMap<>();
        this.indicators.put("payment", 
            (HealthIndicator) () -> checkService(paymentClient));
        this.indicators.put("notification", 
            (HealthIndicator) () -> checkService(notificationClient));
    }
    
    private Health checkService(ServiceClient client) {
        try {
            long start = System.currentTimeMillis();
            client.ping();
            long elapsed = System.currentTimeMillis() - start;
            return Health.up()
                .withDetail("responseTime", elapsed + "ms")
                .build();
        } catch (Exception e) {
            return Health.down(e)
                .withDetail("error", e.getMessage())
                .build();
        }
    }
    
    @Override
    public HealthContributor getContributor(String name) {
        return indicators.get(name);
    }
    
    @Override
    public Iterator<NamedContributor<HealthContributor>> iterator() {
        return indicators.entrySet().stream()
            .map(e -> NamedContributor.of(e.getKey(), e.getValue()))
            .iterator();
    }
}
```

访问 `/actuator/health` 时会看到嵌套结构：

```json
{
  "status": "UP",
  "components": {
    "db": { "status": "UP", "details": { "database": "MySQL" } },
    "externalServices": {
      "status": "UP",
      "components": {
        "payment": { "status": "UP", "details": { "responseTime": "12ms" } },
        "notification": { "status": "UP", "details": { "responseTime": "8ms" } }
      }
    },
    "diskSpace": { "status": "UP", "details": { "free": "42.3GB", "threshold": "10MB" } }
  }
}
```

### 3.4 Liveness 与 Readiness：Kubernetes 探针的最佳配置

Spring Boot 2.3+ 将 Health 分为两个独立的组：`liveness`（存活探针）和 `readiness`（就绪探针），语义不同：

- **Liveness**（`/actuator/health/liveness`）：应用是否"活着"。如果 Liveness 检查失败，Kubernetes 会**重启** Pod。因此这个检查应该保守——只有当应用进入完全无法恢复的状态（如死锁、内存耗尽）时才返回 `DOWN`。绝对不要把外部依赖（数据库、Redis）的健康状态加入 Liveness 检查，否则 Redis 抖动会导致所有 Pod 被重启。

- **Readiness**（`/actuator/health/readiness`）：应用是否"准备好接收流量"。如果 Readiness 检查失败，Kubernetes 会将 Pod 从 Service 的 Endpoints 中**摘除**（停止路由流量），但不重启。这里适合检查外部依赖——数据库连接池耗尽时，停止接收新请求比继续接收然后报错更合理。

```yaml
management:
  health:
    livenessstate:
      enabled: true   # 启用 LivenessStateHealthIndicator
    readinessstate:
      enabled: true   # 启用 ReadinessStateHealthIndicator
  endpoint:
    health:
      group:
        liveness:
          include: livenessState   # Liveness 只检查应用内部状态
        readiness:
          include: readinessState,db,redis  # Readiness 还检查外部依赖
          show-details: always
```

可以通过编程方式控制 Liveness/Readiness 状态：

```java
@Component
public class ApplicationStateManager {
    
    @Autowired
    private ApplicationContext applicationContext;
    
    // 手动将应用标记为"不就绪"（如正在执行数据迁移，暂停接收流量）
    public void setNotReady(String reason) {
        AvailabilityChangeEvent.publish(
            applicationContext,
            ReadinessState.REFUSING_TRAFFIC  // 拒绝流量
        );
    }
    
    // 恢复就绪状态
    public void setReady() {
        AvailabilityChangeEvent.publish(
            applicationContext,
            ReadinessState.ACCEPTING_TRAFFIC  // 接受流量
        );
    }
}
```

---

## 第 4 章 Micrometer：指标体系的核心抽象

### 4.1 Micrometer 是什么，为什么需要它

在 Spring Boot 2.x 之前，Java 生态的指标库是一片混乱：Spring Framework 自带 `CounterService`/`GaugeService`（已废弃）；Dropwizard Metrics 是事实标准但与 Spring 集成需要适配层；Prometheus 的 Java 客户端又是另一套 API……每次切换监控后端（比如从 Dropwizard 切换到 Prometheus），都需要修改大量业务代码。

[[Micrometer]] 的定位是"指标领域的 SLF4J"——它提供了一套**与监控后端无关**的指标 API，通过 `MeterRegistry` 实现对接不同后端：

```
应用代码  → Micrometer API（Counter, Timer, Gauge...）
              ↓
         MeterRegistry（抽象层）
              ↓
    ┌────────┬────────┬────────────┐
    ↓        ↓        ↓            ↓
Prometheus  Datadog  CloudWatch  InfluxDB
```

这意味着：编写一次指标代码，通过切换依赖（`micrometer-registry-prometheus` vs `micrometer-registry-datadog`）即可将指标上报到不同的监控系统，业务代码零修改。

### 4.2 Meter：指标的基本类型

Micrometer 定义了以下核心指标类型：

**Counter（计数器）**：单调递增的计数，适合统计"发生了多少次"：
```java
Counter orderCreated = Counter.builder("orders.created")
    .tag("region", "cn-north")
    .description("成功创建的订单数")
    .register(meterRegistry);

// 使用
orderCreated.increment();       // +1
orderCreated.increment(5);      // +5
orderCreated.count();           // 获取当前计数
```

**Timer（计时器）**：统计操作的执行时间分布（包含 count、totalTime、max），适合统计"调用耗时"：
```java
Timer dbQueryTimer = Timer.builder("db.query.duration")
    .tag("table", "orders")
    .description("数据库查询耗时")
    .publishPercentiles(0.5, 0.95, 0.99)  // 发布百分位数
    .publishPercentileHistogram()           // 发布直方图（Prometheus histogram）
    .register(meterRegistry);

// 使用方式一：手动记录
long start = System.nanoTime();
// ... 执行操作 ...
dbQueryTimer.record(System.nanoTime() - start, TimeUnit.NANOSECONDS);

// 使用方式二：包装调用
Order result = dbQueryTimer.record(() -> orderRepository.findById(orderId));

// 使用方式三：try-with-resources
try (Timer.Sample sample = Timer.start(meterRegistry)) {
    // ... 执行操作 ...
    sample.stop(dbQueryTimer);
}
```

**Gauge（仪表盘）**：反映当前时刻的瞬时值，适合统计"当前有多少"：
```java
// 监控线程池大小
Gauge.builder("threadpool.size", executor, ThreadPoolExecutor::getPoolSize)
    .tag("pool", "order-processor")
    .register(meterRegistry);

// 监控缓存命中率（每次采集时计算）
Gauge.builder("cache.hit.ratio", cache, c -> (double) c.hitCount() / c.requestCount())
    .register(meterRegistry);
```

**DistributionSummary（分布摘要）**：记录数值的分布，适合统计"请求体大小"、"队列长度"等：
```java
DistributionSummary requestBodySize = DistributionSummary.builder("http.request.body.size")
    .baseUnit("bytes")
    .publishPercentiles(0.5, 0.95)
    .register(meterRegistry);

requestBodySize.record(request.getContentLengthLong());
```

### 4.3 Tags（标签）：指标的多维度切片

标签（Tags）是 Micrometer 指标体系的灵魂。一个指标 + 一组标签构成唯一的时序序列，通过标签可以实现指标的多维度聚合：

```java
// 以 HTTP 状态码和方法为维度统计请求数
Counter.builder("http.requests")
    .tag("method", "POST")
    .tag("uri", "/orders")
    .tag("status", "200")
    .register(meterRegistry)
    .increment();

// 在 Prometheus 中查询：
// http_requests_total{method="POST", uri="/orders", status="200"}  ← 具体查询
// sum(http_requests_total{uri="/orders"})                          ← 按路径汇总
// sum(rate(http_requests_total[5m])) by (status)                  ← 按状态码分析 QPS 趋势
```

> [!warning] 标签值的基数爆炸
> 标签的每一个唯一值组合都会创建一个独立的时序序列。如果将用户 ID 作为标签值，100 万用户会产生 100 万条时序序列，直接击垮 Prometheus。标签应当选择**低基数**的维度：HTTP 方法（GET/POST/PUT/DELETE）、状态码（200/404/500）、服务名、环境（prod/staging）等。绝对不要将用户 ID、订单 ID、请求 ID 等高基数值作为标签。

### 4.4 MeterFilter：全局指标过滤与转换

`MeterFilter` 允许在 Meter 注册时对其进行全局拦截，实现：
- 为所有指标添加公共标签（如应用名、环境、版本）；
- 过滤掉不需要收集的指标；
- 重命名指标；
- 禁用百分位数计算（降低 CPU 开销）。

```java
@Configuration
public class MetricsConfig {
    
    @Bean
    public MeterRegistryCustomizer<MeterRegistry> commonTags(
            @Value("${spring.application.name}") String appName) {
        // 为所有指标添加应用名和环境标签
        return registry -> registry.config()
            .commonTags("application", appName)
            .commonTags("env", System.getenv().getOrDefault("ENV", "unknown"));
    }
    
    @Bean
    public MeterFilter denyInternalMetrics() {
        // 过滤掉 JVM 内部的 classloader 相关指标（减少指标噪音）
        return MeterFilter.denyNameStartsWith("jvm.classes");
    }
    
    @Bean
    public MeterFilter renameMetrics() {
        // 将旧的指标名映射到新的指标名（保持向后兼容）
        return MeterFilter.renameTag(
            "http.server.requests",   // 指标名
            "outcome",                // 旧标签名
            "result"                  // 新标签名
        );
    }
}
```

### 4.5 自动采集的指标

引入 `spring-boot-starter-actuator` 后，以下指标会被自动采集（无需任何代码）：

| 指标前缀 | 内容 | 来源 |
| --- | --- | --- |
| `jvm.memory.*` | JVM 堆/非堆内存使用、已提交、最大 | JVM MXBean |
| `jvm.gc.*` | GC 次数、GC 耗时（按 GC 类型分） | GarbageCollectorMXBean |
| `jvm.threads.*` | 线程数（总计、守护、峰值、死锁） | ThreadMXBean |
| `jvm.classes.*` | 已加载/已卸载类数量 | ClassLoadingMXBean |
| `process.cpu.usage` | JVM 进程 CPU 使用率 | OperatingSystemMXBean |
| `process.uptime` | JVM 启动时间 | RuntimeMXBean |
| `http.server.requests` | HTTP 请求数、耗时（按 URI、方法、状态码分） | Spring MVC Interceptor |
| `hikaricp.*` | HikariCP 连接池状态（活跃连接、等待、超时等） | HikariCP MetricsTrackerFactory |
| `spring.data.repository.*` | Spring Data Repository 方法调用耗时 | AOP 切面 |
| `executor.*` | 线程池队列大小、活跃线程数等 | ThreadPoolExecutor |

---

## 第 5 章 Prometheus 集成与 Grafana 展示

### 5.1 暴露 Prometheus 格式的指标

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: prometheus,health,info
  metrics:
    export:
      prometheus:
        enabled: true
```

访问 `/actuator/prometheus` 即可获取 Prometheus 文本格式的指标：

```
# HELP http_server_requests_seconds Duration of HTTP server request handling
# TYPE http_server_requests_seconds summary
http_server_requests_seconds{application="order-service",env="prod",exception="None",method="GET",outcome="SUCCESS",status="200",uri="/orders/{orderId}",quantile="0.5",} 0.008912896
http_server_requests_seconds{application="order-service",env="prod",exception="None",method="GET",outcome="SUCCESS",status="200",uri="/orders/{orderId}",quantile="0.95",} 0.023068672
http_server_requests_seconds_count{application="order-service",env="prod",...} 15432
http_server_requests_seconds_sum{application="order-service",env="prod",...} 187.234
```

### 5.2 Kubernetes 中的 Prometheus 自动发现

通过在 Pod 上添加注解，Prometheus Operator 或 Prometheus 的 Kubernetes SD 可以自动发现并抓取指标：

```yaml
# Kubernetes Deployment 配置
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"         # 允许 Prometheus 抓取
        prometheus.io/path: "/actuator/prometheus"  # 指标路径
        prometheus.io/port: "8090"           # Actuator 专用端口
```

---

## 第 6 章 自定义端点开发实战

### 6.1 业务场景：缓存管理端点

假设需要一个端点，允许运维人员查看当前缓存状态、清除特定缓存，而不需要重启服务：

```java
/**
 * 缓存管理 Actuator 端点。
 * 访问路径：GET  /actuator/cache          ← 查看所有缓存统计
 *          GET  /actuator/cache/{name}   ← 查看指定缓存统计
 *          DELETE /actuator/cache/{name} ← 清除指定缓存
 */
@Component
@Endpoint(id = "cache")
public class CacheManagementEndpoint {
    
    private final CacheManager cacheManager;
    private final MeterRegistry meterRegistry;
    
    public CacheManagementEndpoint(CacheManager cacheManager, 
                                    MeterRegistry meterRegistry) {
        this.cacheManager = cacheManager;
        this.meterRegistry = meterRegistry;
    }
    
    @ReadOperation
    public Map<String, Object> cacheStats() {
        Map<String, Object> result = new LinkedHashMap<>();
        
        for (String cacheName : cacheManager.getCacheNames()) {
            Cache cache = cacheManager.getCache(cacheName);
            result.put(cacheName, getCacheStats(cacheName, cache));
        }
        
        return result;
    }
    
    @ReadOperation
    public Map<String, Object> cacheStatsByName(@Selector String cacheName) {
        Cache cache = cacheManager.getCache(cacheName);
        if (cache == null) {
            throw new IllegalArgumentException("Cache not found: " + cacheName);
        }
        return getCacheStats(cacheName, cache);
    }
    
    @DeleteOperation
    public Map<String, String> clearCache(@Selector String cacheName) {
        Cache cache = cacheManager.getCache(cacheName);
        if (cache == null) {
            return Map.of("status", "NOT_FOUND", "cache", cacheName);
        }
        cache.clear();
        return Map.of("status", "CLEARED", "cache", cacheName, 
                      "timestamp", Instant.now().toString());
    }
    
    private Map<String, Object> getCacheStats(String name, Cache cache) {
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("name", name);
        stats.put("type", cache.getClass().getSimpleName());
        
        // 从 Micrometer 获取命中率统计
        try {
            double hitCount = meterRegistry.get("cache.gets")
                .tag("name", name).tag("result", "hit").counter().count();
            double missCount = meterRegistry.get("cache.gets")
                .tag("name", name).tag("result", "miss").counter().count();
            double total = hitCount + missCount;
            
            stats.put("hitCount", (long) hitCount);
            stats.put("missCount", (long) missCount);
            stats.put("hitRate", total > 0 ? String.format("%.2f%%", hitCount / total * 100) : "N/A");
        } catch (MeterNotFoundException e) {
            stats.put("hitRate", "metrics not available");
        }
        
        return stats;
    }
}
```

### 6.2 敏感端点的安全保护

对自定义端点添加细粒度的安全控制：

```java
// 方式一：通过 EndpointRequest 配置 Spring Security
@Bean
public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth
            // cache 端点的 DELETE 操作需要 CACHE_ADMIN 角色
            .requestMatchers(HttpMethod.DELETE, "/actuator/cache/**")
                .hasRole("CACHE_ADMIN")
            // cache 端点的 GET 操作允许所有认证用户访问
            .requestMatchers(HttpMethod.GET, "/actuator/cache/**")
                .authenticated()
        )
        .build();
}

// 方式二：端点内部检查（更简单，但不推荐用于生产）
@DeleteOperation
public Map<String, String> clearCache(@Selector String cacheName, 
                                       Principal principal) {
    if (principal == null) {
        throw new SecurityException("Authentication required");
    }
    // ...
}
```

### 6.3 @WebEndpoint：仅 HTTP 的端点（支持复杂请求/响应）

当端点需要处理文件下载、自定义 HTTP 头等 HTTP 专有特性时，使用 `@WebEndpoint` 和 `WebEndpointResponse`：

```java
@Component
@WebEndpoint(id = "export")
public class DataExportEndpoint {
    
    private final OrderRepository orderRepository;
    
    @ReadOperation
    @Produces(MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public WebEndpointResponse<Resource> exportOrders(
            @Selector String format,   // CSV 或 JSON
            @Nullable String from,     // 开始日期（可选）
            @Nullable String to) {     // 结束日期（可选）
        
        byte[] data = generateExport(format, from, to);
        String filename = "orders-" + LocalDate.now() + "." + format;
        
        return new WebEndpointResponse<>(
            new ByteArrayResource(data),
            200,
            Map.of(
                "Content-Disposition", "attachment; filename=" + filename,
                "Content-Type", "text/" + format
            )
        );
    }
    
    private byte[] generateExport(String format, String from, String to) {
        // 生成导出数据...
        return new byte[0];
    }
}
```

---

## 第 7 章 常用 Actuator 端点实战指南

### 7.1 /actuator/info：应用元数据

```yaml
management:
  info:
    env:
      enabled: true   # 暴露 info.* 配置属性
    git:
      enabled: true   # 暴露 Git 提交信息（需要 git-commit-id-plugin）
    build:
      enabled: true   # 暴露构建信息（需要 spring-boot-maven-plugin 生成）
    java:
      enabled: true   # JDK 版本信息

info:
  app:
    name: Order Service
    version: "@project.version@"  # 从 Maven POM 读取
    description: "订单服务"
  contact:
    team: backend-team
    slack: "#order-service"
```

### 7.2 /actuator/loggers：动态修改日志级别

```bash
# 查看所有 Logger 的级别
curl http://localhost:8090/actuator/loggers

# 查看特定 Logger
curl http://localhost:8090/actuator/loggers/com.example.order

# 动态修改日志级别（不需要重启！）
curl -X POST http://localhost:8090/actuator/loggers/com.example.order \
  -H "Content-Type: application/json" \
  -d '{"configuredLevel": "DEBUG"}'

# 恢复默认级别
curl -X POST http://localhost:8090/actuator/loggers/com.example.order \
  -H "Content-Type: application/json" \
  -d '{"configuredLevel": null}'
```

生产环境中，当线上出现问题需要临时开启 DEBUG 日志时，这个功能极其有用——无需重新打包部署，立即生效。

### 7.3 /actuator/threaddump 与 /actuator/heapdump

```bash
# 获取线程栈转储（诊断线程阻塞、死锁）
curl http://localhost:8090/actuator/threaddump > thread-dump.txt
# 或获取 JSON 格式（便于程序分析）
curl -H "Accept: application/json" http://localhost:8090/actuator/threaddump | jq .

# 获取堆转储（MAT、JProfiler 分析内存泄漏）
curl http://localhost:8090/actuator/heapdump > heap.hprof
# 使用 Eclipse MAT 打开 heap.hprof 分析
```

---

## 总结

Spring Boot Actuator 是构建生产级应用"可观测性"的基础设施：

- **端点体系**：`@Endpoint`/`@ReadOperation`/`@WriteOperation`/`@DeleteOperation` 构成端点开发的标准模式；三层访问控制（enabled → exposed → security）保证灵活性与安全性；独立端口（`management.server.port`）是生产环境隔离的最佳实践；
- **健康检查**：`HealthIndicator` + `CompositeHealthContributor` 实现细粒度健康检查；`StatusAggregator` 按严重性聚合状态；Liveness（只检查应用内部状态，失败触发重启）与 Readiness（检查外部依赖，失败摘除流量）是 Kubernetes 环境的标准配置；
- **Micrometer 指标**：`Counter`/`Timer`/`Gauge`/`DistributionSummary` 四种基本类型；Tags 实现多维度分析（注意标签基数爆炸）；`MeterFilter` 做全局标签注入和指标过滤；`MeterRegistryCustomizer` 添加公共标签；
- **Prometheus 集成**：引入 `micrometer-registry-prometheus`，通过 `/actuator/prometheus` 暴露指标；Pod 注解实现自动发现；
- **运维实战**：`/actuator/loggers` 动态修改日志级别（无需重启）；`/actuator/threaddump` 诊断线程阻塞；`/actuator/heapdump` 分析内存泄漏。

下一篇，我们深入 Spring Boot 的日志体系，从 SLF4J 的门面设计到 Logback 的源码配置，再到多框架日志桥接的实现原理：[[08 日志体系——SLF4J、Logback与日志桥接]]。

---

> [!note] 参考资料
> - `org.springframework.boot.actuate.health.HealthEndpoint` 源码
> - `org.springframework.boot.actuate.endpoint.annotation.Endpoint` 源码
> - [Micrometer 官方文档](https://micrometer.io/docs)
> - [Spring Boot 官方文档 - Actuator](https://docs.spring.io/spring-boot/docs/current/reference/html/actuator.html)

---

> [!note] 思考题
> 1. Actuator 的 `/health` 端点聚合了多个 `HealthIndicator`（如 DataSource、Redis、Elasticsearch）的状态。如果 Redis 健康检查失败但数据库正常，`/health` 返回 DOWN（聚合策略是'最差的一个决定整体'）。在 Kubernetes 中将 `/health` 用作 liveness probe——Redis 宕机会导致应用被 K8s 重启，即使应用本身是正常的。你如何避免这种'级联重启'？
> 2. Actuator 通过 Micrometer 暴露 JVM 指标（如堆内存、GC 次数、线程数）和自定义业务指标。Micrometer 支持多种监控系统（Prometheus、InfluxDB、Datadog）。在一个 Spring Boot 应用中，你如何定义一个 Counter 指标来记录'每种订单类型的创建数量'？使用 Tag（`orderType=physical`）和使用独立的 Counter（`order.create.physical`）各有什么优劣？
> 3. Actuator 的 `/threaddump` 端点可以获取线程快照，但默认情况下这些端点暴露在与业务端口相同的端口上。在生产环境中，你如何配置 Actuator 使用独立端口（`management.server.port`）并限制访问（仅内网可达）？如果 Actuator 端点被意外暴露到公网，可能造成什么安全风险？
