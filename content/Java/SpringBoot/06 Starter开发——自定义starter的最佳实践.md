---
title: "Starter开发——自定义starter的最佳实践"
date: 2026-03-04
tags: [AutoConfiguration, Java, SPI, SpringBoot, Starter, 组件封装, 自定义Starter]
aliases: []
---

# Starter开发——自定义starter的最佳实践

## 摘要

Spring Boot Starter 是"约定优于配置"理念的最高体现——开发者只需在 `pom.xml` 中声明一行依赖，就能自动获得完整的功能组件，无需任何手动配置。`spring-boot-starter-web` 引入后 Web 框架就绪，`spring-boot-starter-data-redis` 引入后 Redis 客户端就绪……这种"开箱即用"的体验背后，是 Starter 的标准化封装模式。本文从零构建一个生产可用的自定义 Starter（以限流 SDK 为例），深入讲解 Starter 的两模块结构（`autoconfigure` + `starter`）、自动配置类的编写规范、`@ConfigurationProperties` 的元数据生成、Spring Boot 2.x/3.x 的注册方式差异（`spring.factories` vs `AutoConfiguration.imports`），以及 Starter 的测试策略和常见陷阱。

---

## 第 1 章 Starter 是什么，解决了什么问题

### 1.1 没有 Starter 的世界是什么样的

设想一个团队内部有一个通用的限流 SDK（基于 Redis 实现的令牌桶算法），需要在 5 个微服务中集成。在没有 Starter 的情况下，每个微服务都需要：

1. 在 `pom.xml` 中引入 SDK 的 `core` 包和 `spring-data-redis` 依赖；
2. 编写 `RateLimiterConfig.java`，读取配置、创建 `RateLimiter` Bean；
3. 编写 `application.yml` 中的 `rate-limiter.*` 配置项；
4. 如果忘记某个步骤，应用启动时报错，需要查文档排查。

这 5 个微服务中有大量**重复的样板代码**，每次 SDK 升级（比如新增一个配置项）都需要同步修改所有使用方。这就是 Starter 要解决的问题。

### 1.2 Starter 的核心职责

一个标准的 Spring Boot Starter 承担三个职责：

1. **依赖聚合**：将所有必要的依赖（SDK 核心包、第三方库）聚合到一个 `starter` 依赖中，使用方只需引入这一个依赖；
2. **自动配置**：通过 `@AutoConfiguration` 类，在满足特定条件时自动创建所需 Bean，无需使用方手动编写配置类；
3. **配置文档化**：通过 `@ConfigurationProperties` + 元数据处理器，为 IDE 提供配置属性的自动补全和文档提示。

---

## 第 2 章 Starter 的标准目录结构

### 2.1 两模块结构：autoconfigure + starter

官方推荐将一个 Starter 拆分为两个独立的 Maven 模块：

```
rate-limiter-spring-boot/
├── rate-limiter-spring-boot-autoconfigure/    ← 自动配置模块（核心）
│   ├── src/main/java/
│   │   └── com/example/ratelimiter/
│   │       ├── autoconfigure/
│   │       │   ├── RateLimiterAutoConfiguration.java
│   │       │   └── RateLimiterProperties.java
│   │       └── core/
│   │           ├── RateLimiter.java           ← SDK 核心接口
│   │           └── RedisRateLimiter.java      ← 默认实现
│   ├── src/main/resources/
│   │   └── META-INF/
│   │       ├── spring/
│   │       │   └── org.springframework.boot.autoconfigure.AutoConfiguration.imports
│   │       └── spring-configuration-metadata.json  ← 由 annotation processor 生成
│   └── pom.xml
│
└── rate-limiter-spring-boot-starter/          ← 启动器模块（纯 pom，无代码）
    └── pom.xml
```

**为什么要拆两个模块？**

核心原因在于**可选性**。`autoconfigure` 模块包含实际的自动配置逻辑，它依赖 Spring Boot、Spring Data Redis 等框架。但有些情况下，用户可能想使用 SDK 的核心功能（`RateLimiter` 接口），但希望自己管理 Bean 的创建，不需要自动配置介入——这时用户可以只引入 `autoconfigure` 模块，而跳过 `starter`。

`starter` 模块只是一个聚合 pom，没有任何 Java 代码，唯一的作用是声明依赖：

```xml
<!-- rate-limiter-spring-boot-starter/pom.xml -->
<dependencies>
    <!-- 引入 autoconfigure 模块 -->
    <dependency>
        <groupId>com.example</groupId>
        <artifactId>rate-limiter-spring-boot-autoconfigure</artifactId>
    </dependency>
    
    <!-- 引入 Spring Boot starter 基础（包含 spring-boot, spring-context 等） -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter</artifactId>
    </dependency>
    
    <!-- 引入 Spring Data Redis（这是 starter 的价值：用户无需知道需要哪些依赖） -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-redis</artifactId>
    </dependency>
</dependencies>
```

使用方只需声明一个依赖：

```xml
<!-- 使用方的 pom.xml -->
<dependency>
    <groupId>com.example</groupId>
    <artifactId>rate-limiter-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

### 2.2 命名规范

Spring Boot 官方的命名规范是：

- **官方 Starter**：`spring-boot-starter-{name}`（如 `spring-boot-starter-web`）；
- **第三方 Starter**：`{name}-spring-boot-starter`（如 `mybatis-spring-boot-starter`）；
- **autoconfigure 模块**：`{name}-spring-boot-autoconfigure`。

这个命名规范的意义在于避免与官方 Starter 命名冲突，也让用户一眼识别出这是第三方 Starter。

> [!warning] 不要用 spring-boot 开头命名自定义 Starter
> Spring Boot 官方文档明确要求：第三方 Starter 不能以 `spring-boot` 开头命名，这是保留给 Spring 官方使用的命名空间。违反这个约定不会报错，但会给使用者造成困惑，不符合社区规范。

---

## 第 3 章 编写 @ConfigurationProperties

### 3.1 定义配置属性 POJO

`@ConfigurationProperties` 是 Starter 配置绑定的标准方式。每个配置属性都需要有合理的默认值，让"零配置"情况下 Starter 依然能正常工作：

```java
/**
 * 限流 Starter 的配置属性
 * 所有属性以 rate-limiter 为前缀
 */
@ConfigurationProperties(prefix = "rate-limiter")
public class RateLimiterProperties {
    
    /**
     * 是否启用限流功能。默认启用。
     * 通过 rate-limiter.enabled=false 可完全关闭限流。
     */
    private boolean enabled = true;
    
    /**
     * 默认 QPS（每秒请求数）限制。
     * 具体接口可通过注解覆盖此默认值。
     */
    private int defaultQps = 1000;
    
    /**
     * 限流键的 Redis Key 前缀，用于多应用共用同一 Redis 时的隔离。
     */
    private String keyPrefix = "rate-limit";
    
    /**
     * 令牌桶的滑动窗口大小，决定限流的粒度。
     */
    @DurationUnit(ChronoUnit.SECONDS)
    private Duration windowSize = Duration.ofSeconds(1);
    
    /**
     * 限流被触发时的行为：REJECT（直接拒绝）或 WAIT（等待令牌可用）。
     */
    private LimitStrategy strategy = LimitStrategy.REJECT;
    
    /**
     * 当 strategy=WAIT 时，最长等待时间。
     */
    @DurationUnit(ChronoUnit.MILLISECONDS)
    private Duration maxWaitTime = Duration.ofMillis(500);
    
    public enum LimitStrategy {
        REJECT,  // 超出限制直接返回 429
        WAIT     // 超出限制等待令牌桶有空余
    }
    
    // getters and setters...
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    
    public int getDefaultQps() { return defaultQps; }
    public void setDefaultQps(int defaultQps) { this.defaultQps = defaultQps; }
    
    public String getKeyPrefix() { return keyPrefix; }
    public void setKeyPrefix(String keyPrefix) { this.keyPrefix = keyPrefix; }
    
    public Duration getWindowSize() { return windowSize; }
    public void setWindowSize(Duration windowSize) { this.windowSize = windowSize; }
    
    public LimitStrategy getStrategy() { return strategy; }
    public void setStrategy(LimitStrategy strategy) { this.strategy = strategy; }
    
    public Duration getMaxWaitTime() { return maxWaitTime; }
    public void setMaxWaitTime(Duration maxWaitTime) { this.maxWaitTime = maxWaitTime; }
}
```

### 3.2 配置属性验证

通过 `@Validated` 注解和 JSR-303 约束，在应用启动时验证配置合法性，将配置错误提前暴露：

```java
@ConfigurationProperties(prefix = "rate-limiter")
@Validated
public class RateLimiterProperties {
    
    private boolean enabled = true;
    
    @Positive(message = "defaultQps 必须是正整数")
    private int defaultQps = 1000;
    
    @NotBlank(message = "keyPrefix 不能为空")
    @Pattern(regexp = "[a-z][a-z0-9-]*", message = "keyPrefix 只能包含小写字母、数字和连字符")
    private String keyPrefix = "rate-limit";
    
    @NotNull
    @DurationMin(nanos = 100_000_000, message = "windowSize 不能小于 100ms")
    private Duration windowSize = Duration.ofSeconds(1);
    
    // ...
}
```

如果 `rate-limiter.default-qps=-1`，应用会在启动阶段抛出 `BindValidationException`，并给出清晰的错误信息：

```
***************************
APPLICATION FAILED TO START
***************************

Binding to target RateLimiterProperties failed:

    Property: rate-limiter.default-qps
    Value: -1
    Reason: defaultQps 必须是正整数
```

这比在运行时因非法配置导致的 NPE 或业务异常要友好得多。

---

## 第 4 章 编写自动配置类

### 4.1 @AutoConfiguration 类的标准模式

```java
/**
 * 限流功能的自动配置类。
 *
 * 装配条件：
 * 1. 类路径上存在 RedisOperations（spring-data-redis 已引入）
 * 2. rate-limiter.enabled=true（默认为 true）
 * 3. 用户未自定义 RateLimiter Bean
 *
 * 执行时机：在 RedisAutoConfiguration 之后（确保 RedisTemplate 已就绪）
 */
@AutoConfiguration(after = RedisAutoConfiguration.class)
@ConditionalOnClass(RedisOperations.class)
@ConditionalOnProperty(prefix = "rate-limiter", name = "enabled", 
    havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(RateLimiterProperties.class)
public class RateLimiterAutoConfiguration {
    
    /**
     * 注册 RateLimiter Bean。
     * @ConditionalOnMissingBean 保证用户自定义的 RateLimiter 优先。
     */
    @Bean
    @ConditionalOnMissingBean
    public RateLimiter rateLimiter(StringRedisTemplate redisTemplate,
                                   RateLimiterProperties properties) {
        return new RedisRateLimiter(redisTemplate, properties);
    }
    
    /**
     * 注册限流 AOP 切面（仅在类路径上有 AspectJ 时才注册）。
     */
    @Bean
    @ConditionalOnClass(name = "org.aspectj.lang.annotation.Aspect")
    @ConditionalOnMissingBean(RateLimiterAspect.class)
    public RateLimiterAspect rateLimiterAspect(RateLimiter rateLimiter,
                                                RateLimiterProperties properties) {
        return new RateLimiterAspect(rateLimiter, properties);
    }
    
    /**
     * 注册 Spring MVC 拦截器（仅在 Servlet Web 应用中注册）。
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    static class RateLimiterWebConfiguration implements WebMvcConfigurer {
        
        private final RateLimiter rateLimiter;
        private final RateLimiterProperties properties;
        
        RateLimiterWebConfiguration(RateLimiter rateLimiter, 
                                     RateLimiterProperties properties) {
            this.rateLimiter = rateLimiter;
            this.properties = properties;
        }
        
        @Override
        public void addInterceptors(InterceptorRegistry registry) {
            registry.addInterceptor(new RateLimiterInterceptor(rateLimiter, properties))
                    .addPathPatterns("/**")
                    .order(Ordered.HIGHEST_PRECEDENCE + 10);
        }
    }
}
```

### 4.2 自动配置类的设计要点

**要点一：`@ConditionalOnMissingBean` 是"用户优先"的保证**

自动配置类提供的每个 Bean，都应该标注 `@ConditionalOnMissingBean`。这意味着：
- 如果用户在自己的 `@Configuration` 类中定义了同类型或同名的 Bean，自动配置的 Bean 就不会创建；
- 用户永远可以通过自定义 Bean 来"覆盖"自动配置的默认实现，无需修改 Starter 代码。

这是 Spring Boot Starter 最重要的设计契约，也是"开放封闭原则"在配置层的体现。

**要点二：优先使用 `proxyBeanMethods = false`**

对于 `@Configuration` 类（特别是嵌套的 static `@Configuration` 类），推荐使用 `@Configuration(proxyBeanMethods = false)`：

```java
// ✅ 推荐：lite 模式，不通过 CGLIB 代理 @Bean 方法
@Configuration(proxyBeanMethods = false)
public class RateLimiterAutoConfiguration { ... }

// ❌ 避免：full 模式，需要 CGLIB 代理，启动略慢
@Configuration  // 默认 proxyBeanMethods = true
public class RateLimiterAutoConfiguration { ... }
```

`proxyBeanMethods = false`（lite 模式）下，`@Bean` 方法之间的调用不会走 CGLIB 代理，无法保证 Bean 的单例性；但这对自动配置类通常不是问题，因为 Bean 之间的依赖通过参数注入，而非方法调用。lite 模式的好处是启动速度更快（少了 CGLIB 子类生成的开销）。

**要点三：`@AutoConfiguration` vs `@Configuration`**

Spring Boot 3.x 引入了 `@AutoConfiguration` 注解（实际上是 `@Configuration(proxyBeanMethods = false)` + `@AutoConfigureBefore`/`@AutoConfigureAfter` 的组合语法糖）。自动配置类应当使用 `@AutoConfiguration`，用户的配置类使用 `@Configuration`——这让框架能够区分"自动配置"和"用户配置"，用于正确的处理顺序。

**要点四：通过 `after`/`before` 声明依赖顺序**

```java
// 在 RedisAutoConfiguration 之后处理（确保 StringRedisTemplate 已注册）
@AutoConfiguration(after = RedisAutoConfiguration.class)

// 在多个配置之后处理
@AutoConfiguration(after = { RedisAutoConfiguration.class, CacheAutoConfiguration.class })

// 在某个配置之前处理
@AutoConfiguration(before = SecurityAutoConfiguration.class)
```

这比 `@DependsOn`（Bean 级别的依赖）更合适，因为自动配置的顺序控制应该在配置类层面声明，而不是 Bean 层面。

---

## 第 5 章 注册自动配置类

### 5.1 Spring Boot 3.x：AutoConfiguration.imports（推荐）

在 `src/main/resources/META-INF/spring/` 目录下创建文件：

```
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.ratelimiter.autoconfigure.RateLimiterAutoConfiguration
```

文件名固定为 `org.springframework.boot.autoconfigure.AutoConfiguration.imports`，每行一个自动配置类的全限定名。Spring Boot 3.x 通过 `ImportCandidates` 加载这个文件，替代了旧的 `spring.factories` 方式。

### 5.2 Spring Boot 2.x：spring.factories（兼容方式）

在 `src/main/resources/META-INF/` 目录下创建或追加到 `spring.factories` 文件：

```properties
# META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
  com.example.ratelimiter.autoconfigure.RateLimiterAutoConfiguration
```

如果 Starter 需要同时支持 Spring Boot 2.x 和 3.x，需要同时提供两个文件——Spring Boot 3.x 会优先使用 `AutoConfiguration.imports`，如果不存在则回退到 `spring.factories`。

### 5.3 Spring Boot 3.x 为什么废弃 spring.factories

`spring.factories` 是一个通用的 SPI 文件，承载了多种 Spring Boot 内部接口的注册（`ApplicationListener`、`EnvironmentPostProcessor`、`AutoConfiguration` 等）。Spring Boot 3.x 将自动配置的注册从这个通用文件中分离出来，原因有三：

1. **AOT 友好性**：`AutoConfiguration.imports` 格式简单（纯类名列表），AOT 处理器（Native Image 编译时）可以高效解析；`spring.factories` 的键值对格式和 `\\` 续行语法增加了解析复杂度；
2. **语义清晰**：分离后，`spring.factories` 只承载非自动配置的 SPI（如 `ApplicationContextInitializer`、`SpringApplicationRunListener`），语义更明确；
3. **性能优化**：Spring Boot 3.x 可以在编译时预处理 `AutoConfiguration.imports` 并生成索引，加速运行时加载。

---

## 第 6 章 实现 SDK 核心功能

### 6.1 RateLimiter 接口设计

```java
/**
 * 限流器接口。
 * 设计为接口而非直接实现，允许用户替换底层实现（如从 Redis 切换到本地内存计数器）。
 */
public interface RateLimiter {
    
    /**
     * 尝试获取令牌（同步，不等待）。
     * @param key   限流键（通常是接口路径 + 用户标识）
     * @param limit 限制值（每 windowSize 内最多允许的请求数）
     * @return true 表示获取成功，可以继续处理；false 表示限流触发
     */
    boolean tryAcquire(String key, int limit);
    
    /**
     * 获取令牌（根据配置决定是直接拒绝还是等待）。
     * @throws RateLimitExceededException 当超过限制且 strategy=REJECT 时抛出
     */
    void acquire(String key, int limit) throws RateLimitExceededException;
    
    /**
     * 查询当前剩余令牌数。
     */
    long getRemainingTokens(String key);
    
    /**
     * 重置指定键的限流状态（用于测试或管理端点）。
     */
    void reset(String key);
}
```

### 6.2 RedisRateLimiter：基于 Redis Lua 脚本的实现

使用 Redis + Lua 脚本实现原子性的令牌桶算法，是生产环境的标准方案：

```java
public class RedisRateLimiter implements RateLimiter {
    
    private static final String RATE_LIMIT_SCRIPT = """
        -- Lua 脚本：原子性令牌桶检查与扣减
        -- KEYS[1]: 限流键
        -- ARGV[1]: 限流阈值（窗口内最大请求数）
        -- ARGV[2]: 窗口大小（秒）
        
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        
        -- 获取当前计数
        local current = redis.call('INCR', key)
        
        if current == 1 then
            -- 第一次设置过期时间
            redis.call('EXPIRE', key, window)
        end
        
        if current <= limit then
            return 1  -- 允许
        else
            return 0  -- 拒绝
        end
        """;
    
    private final StringRedisTemplate redisTemplate;
    private final RateLimiterProperties properties;
    private final RedisScript<Long> script;
    
    public RedisRateLimiter(StringRedisTemplate redisTemplate,
                             RateLimiterProperties properties) {
        this.redisTemplate = redisTemplate;
        this.properties = properties;
        this.script = RedisScript.of(RATE_LIMIT_SCRIPT, Long.class);
    }
    
    @Override
    public boolean tryAcquire(String key, int limit) {
        String fullKey = properties.getKeyPrefix() + ":" + key;
        long windowSeconds = properties.getWindowSize().toSeconds();
        
        Long result = redisTemplate.execute(
            script,
            Collections.singletonList(fullKey),
            String.valueOf(limit),
            String.valueOf(windowSeconds)
        );
        
        return Long.valueOf(1L).equals(result);
    }
    
    @Override
    public void acquire(String key, int limit) throws RateLimitExceededException {
        if (properties.getStrategy() == RateLimiterProperties.LimitStrategy.REJECT) {
            if (!tryAcquire(key, limit)) {
                throw new RateLimitExceededException(
                    "Rate limit exceeded for key: " + key + ", limit: " + limit);
            }
        } else {
            // WAIT 策略：轮询等待
            long deadline = System.currentTimeMillis() + 
                properties.getMaxWaitTime().toMillis();
            while (!tryAcquire(key, limit)) {
                if (System.currentTimeMillis() > deadline) {
                    throw new RateLimitExceededException(
                        "Rate limit wait timeout for key: " + key);
                }
                try {
                    Thread.sleep(10); // 10ms 轮询间隔
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RateLimitExceededException("Interrupted while waiting for token");
                }
            }
        }
    }
    
    @Override
    public long getRemainingTokens(String key) {
        String fullKey = properties.getKeyPrefix() + ":" + key;
        String current = redisTemplate.opsForValue().get(fullKey);
        // 这里需要知道总限制，简化处理：返回-1表示未跟踪
        return current != null ? -Long.parseLong(current) : 0;
    }
    
    @Override
    public void reset(String key) {
        String fullKey = properties.getKeyPrefix() + ":" + key;
        redisTemplate.delete(fullKey);
    }
}
```

### 6.3 @RateLimit 注解：AOP 切面集成

提供注解式限流，让使用方无需直接调用 `RateLimiter` API：

```java
// 限流注解定义
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface RateLimit {
    
    // 限流键（支持 SpEL 表达式）
    String key() default "";
    
    // 每窗口最大请求数（-1 表示使用全局默认值）
    int limit() default -1;
    
    // 限流键的生成策略（当 key 为空时使用）
    KeyStrategy keyStrategy() default KeyStrategy.METHOD;
    
    enum KeyStrategy {
        METHOD,    // 以方法签名作为限流键（全局限流）
        IP,        // 以客户端 IP 作为限流键（按 IP 限流）
        USER,      // 以当前用户 ID 作为限流键（按用户限流）
        CUSTOM     // 通过 SpEL 表达式自定义（最灵活）
    }
}

// 使用示例
@RestController
public class OrderController {
    
    // 全局限流：所有请求共享一个计数器，整体不超过 100 QPS
    @RateLimit(limit = 100, keyStrategy = RateLimit.KeyStrategy.METHOD)
    @PostMapping("/orders")
    public Order createOrder(@RequestBody OrderRequest request) { ... }
    
    // 按用户限流：每个用户每秒最多 5 次查询
    @RateLimit(limit = 5, keyStrategy = RateLimit.KeyStrategy.USER)
    @GetMapping("/orders/{orderId}")
    public Order getOrder(@PathVariable Long orderId) { ... }
    
    // SpEL 自定义键：按订单类型限流
    @RateLimit(key = "#request.orderType", limit = 200)
    @PostMapping("/orders/batch")
    public List<Order> batchCreate(@RequestBody BatchOrderRequest request) { ... }
}
```

---

## 第 7 章 生成配置元数据

### 7.1 annotation processor 自动生成

在 `autoconfigure` 模块的 `pom.xml` 中添加：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>  <!-- optional=true：不传递到使用方 -->
</dependency>
```

编译时（`mvn compile`），annotation processor 会扫描所有 `@ConfigurationProperties` 类，生成 `META-INF/spring-configuration-metadata.json`：

```json
{
  "groups": [{
    "name": "rate-limiter",
    "type": "com.example.ratelimiter.autoconfigure.RateLimiterProperties",
    "sourceType": "com.example.ratelimiter.autoconfigure.RateLimiterProperties"
  }],
  "properties": [
    {
      "name": "rate-limiter.enabled",
      "type": "java.lang.Boolean",
      "description": "是否启用限流功能。默认启用。",
      "sourceType": "com.example.ratelimiter.autoconfigure.RateLimiterProperties",
      "defaultValue": true
    },
    {
      "name": "rate-limiter.default-qps",
      "type": "java.lang.Integer",
      "description": "默认 QPS（每秒请求数）限制。",
      "sourceType": "com.example.ratelimiter.autoconfigure.RateLimiterProperties",
      "defaultValue": 1000
    },
    {
      "name": "rate-limiter.strategy",
      "type": "com.example.ratelimiter.autoconfigure.RateLimiterProperties$LimitStrategy",
      "description": "限流被触发时的行为：REJECT（直接拒绝）或 WAIT（等待令牌可用）。",
      "sourceType": "com.example.ratelimiter.autoconfigure.RateLimiterProperties",
      "defaultValue": "reject"
    }
  ],
  "hints": [
    {
      "name": "rate-limiter.strategy",
      "values": [
        { "value": "reject", "description": "超出限制直接返回 429" },
        { "value": "wait", "description": "超出限制等待令牌桶有空余" }
      ]
    }
  ]
}
```

### 7.2 手动补充 additional-spring-configuration-metadata.json

annotation processor 能自动生成大多数元数据，但对于动态或复杂的属性（如第三方框架的配置类），可能无法自动生成。此时可以手动创建 `additional-spring-configuration-metadata.json`，annotation processor 会在生成时将其合并进最终的 `spring-configuration-metadata.json`：

```json
// src/main/resources/META-INF/additional-spring-configuration-metadata.json
{
  "hints": [
    {
      "name": "rate-limiter.key-prefix",
      "values": [
        { "value": "rate-limit", "description": "默认前缀" },
        { "value": "${spring.application.name}", "description": "使用应用名称作为前缀（推荐多应用隔离时使用）" }
      ]
    }
  ]
}
```

---

## 第 8 章 测试 Starter

### 8.1 使用 ApplicationContextRunner 测试自动配置

```java
@ExtendWith(MockitoExtension.class)
class RateLimiterAutoConfigurationTest {
    
    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(RateLimiterAutoConfiguration.class));
    
    @Test
    void shouldAutoConfigureWhenRedisPresent() {
        contextRunner
            .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class))
            .run(context -> {
                // 类路径上有 RedisOperations，且 enabled 默认为 true
                assertThat(context).hasSingleBean(RateLimiter.class);
                assertThat(context).hasSingleBean(RateLimiterProperties.class);
            });
    }
    
    @Test
    void shouldNotAutoConfigureWhenDisabled() {
        contextRunner
            .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class))
            .withPropertyValues("rate-limiter.enabled=false")
            .run(context -> {
                assertThat(context).doesNotHaveBean(RateLimiter.class);
            });
    }
    
    @Test
    void shouldRespectUserDefinedBean() {
        RateLimiter customRateLimiter = mock(RateLimiter.class);
        
        contextRunner
            .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class))
            .withBean(RateLimiter.class, () -> customRateLimiter)  // 用户自定义 Bean
            .run(context -> {
                // 应该使用用户定义的 Bean，而非自动配置的
                assertThat(context).hasSingleBean(RateLimiter.class);
                assertThat(context.getBean(RateLimiter.class)).isSameAs(customRateLimiter);
            });
    }
    
    @Test
    void shouldBindPropertiesCorrectly() {
        contextRunner
            .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class))
            .withPropertyValues(
                "rate-limiter.default-qps=500",
                "rate-limiter.key-prefix=my-app",
                "rate-limiter.strategy=wait",
                "rate-limiter.max-wait-time=200ms"
            )
            .run(context -> {
                RateLimiterProperties props = context.getBean(RateLimiterProperties.class);
                assertThat(props.getDefaultQps()).isEqualTo(500);
                assertThat(props.getKeyPrefix()).isEqualTo("my-app");
                assertThat(props.getStrategy()).isEqualTo(RateLimiterProperties.LimitStrategy.WAIT);
                assertThat(props.getMaxWaitTime()).isEqualTo(Duration.ofMillis(200));
            });
    }
    
    @Test
    void shouldFailOnInvalidProperties() {
        assertThatThrownBy(() ->
            contextRunner
                .withBean(StringRedisTemplate.class, () -> mock(StringRedisTemplate.class))
                .withPropertyValues("rate-limiter.default-qps=-1")
                .run(context -> context.getBean(RateLimiterProperties.class))
        ).hasCauseInstanceOf(BindValidationException.class);
    }
}
```

### 8.2 集成测试：嵌入式 Redis

对于需要验证 Redis 交互的集成测试，使用 `Embedded Redis` 或 `Testcontainers`：

```java
@SpringBootTest
@Testcontainers
class RedisRateLimiterIntegrationTest {
    
    @Container
    static final RedisContainer redis = new RedisContainer(DockerImageName.parse("redis:7"))
        .withExposedPorts(6379);
    
    @DynamicPropertySource
    static void configureRedis(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", redis::getFirstMappedPort);
    }
    
    @Autowired
    private RateLimiter rateLimiter;
    
    @Test
    void shouldAllowRequestsWithinLimit() {
        // 限制 5 QPS
        for (int i = 0; i < 5; i++) {
            assertThat(rateLimiter.tryAcquire("test-key", 5)).isTrue();
        }
        // 第 6 次应该被拒绝
        assertThat(rateLimiter.tryAcquire("test-key", 5)).isFalse();
    }
    
    @BeforeEach
    void resetState() {
        rateLimiter.reset("test-key");
    }
}
```

---

## 第 9 章 Starter 发布与版本管理

### 9.1 Spring Boot 版本兼容性声明

在 `pom.xml` 中通过 `<parent>` 或 `<dependencyManagement>` 声明兼容的 Spring Boot 版本，避免因 Spring Boot 版本升级导致的 API 不兼容：

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
</parent>

<!-- autoconfigure 中的核心依赖使用 optional=true，不传递给使用方 -->
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-autoconfigure</artifactId>
        <optional>true</optional>
    </dependency>
    <dependency>
        <groupId>org.springframework.data</groupId>
        <artifactId>spring-data-redis</artifactId>
        <optional>true</optional>  <!-- 使用方不必引入，可以换其他 Redis 客户端 -->
    </dependency>
</dependencies>
```

### 9.2 `@AutoConfigurationPackage` 与组件扫描边界

Starter 提供的组件不在使用方的 `@SpringBootApplication` 扫描包范围内，但由于是通过 `@AutoConfiguration` 类中的 `@Bean` 方法注册的，不需要 `@ComponentScan`。这是 Starter 的设计优势：**不污染使用方的包扫描路径**，避免包名冲突。

### 9.3 常见错误：避免将 @SpringBootApplication 放进 autoconfigure 模块

这是初学者最常见的错误：在 `autoconfigure` 模块的根包上添加了 `@SpringBootApplication` 或 `@ComponentScan`，导致 Starter 内部的测试启动类扫描了整个模块并注册了不应该自动注册的 Bean。

正确做法：`autoconfigure` 模块没有 `main` 方法，测试用的 Spring Boot 应用配置类应该只用于测试，且明确限制扫描范围。

---

## 总结

本文完整演示了一个生产级别自定义 Starter 的构建过程：

- **两模块结构**：`autoconfigure`（核心逻辑）+ `starter`（依赖聚合）分离，允许使用方按需引入；
- **命名规范**：第三方 Starter 用 `{name}-spring-boot-starter` 命名，不以 `spring-boot` 开头；
- **自动配置类设计**：`@AutoConfiguration` + `@ConditionalOnClass` + `@ConditionalOnMissingBean` + `@EnableConfigurationProperties` 的标准四件套；`proxyBeanMethods = false` 提升启动性能；通过 `after`/`before` 显式控制配置顺序；
- **配置属性**：`@ConfigurationProperties` + `@Validated` 提供类型安全和启动期验证；annotation processor 自动生成元数据支持 IDE 自动补全；
- **注册方式**：Spring Boot 3.x 用 `AutoConfiguration.imports`；Spring Boot 2.x 用 `spring.factories`；需要两者兼容时同时提供；
- **测试策略**：`ApplicationContextRunner` 做单元测试（验证条件、属性绑定、用户 Bean 优先）；`Testcontainers` 做集成测试（验证真实 Redis 交互）。

下一篇，我们探讨 Spring Boot Actuator 的设计原理，包括健康检查、指标暴露与自定义端点的实现机制：[[07 Actuator——健康检查、指标暴露与自定义端点]]。

---

> [!note] 参考资料
> - [Spring Boot 官方文档 - Creating Your Own Starter](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration)
> - `org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration` 源码（参考实现）
> - `org.springframework.boot.context.properties.ConfigurationPropertiesBindingPostProcessor` 源码

---

> [!note] 思考题
> 1. Spring Boot 2.x 默认使用 HikariCP 连接池。Hikari 的 `maximumPoolSize` 默认为 10。如果你的应用有 200 个并发请求都需要数据库查询，超出的 190 个请求会等待连接——如果等待超过 `connectionTimeout`（默认 30 秒），抛出异常。在这种场景下，是应该增大连接池还是优化查询速度？连接池过大会导致什么问题？
> 2. Spring 的 `@Transactional` 声明式事务底层通过 AOP 代理实现。默认情况下，只有 `RuntimeException` 和 `Error` 会触发回滚，`checked Exception` 不会。在一个调用链中，Service A 调用 Service B（`REQUIRES_NEW`），B 的事务提交后 A 抛出异常——B 的事务会回滚吗？为什么？
> 3. `@Transactional(readOnly=true)` 标记只读事务。在 MySQL + InnoDB 中，只读事务是否真的不获取锁？只读事务对 MySQL 的查询性能有什么优化（提示：不写 undo log、不需要 binlog）？在什么场景下忘记标记 `readOnly=true` 会导致性能差异？
