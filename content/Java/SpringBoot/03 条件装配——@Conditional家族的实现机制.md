---
title: "条件装配——@Conditional家族的实现机制"
date: 2026-03-04
tags: [Java, SpringBoot, Conditional, ConditionalOnClass, ConditionalOnBean, ConditionalOnProperty, 条件装配]
aliases: []
---

# 条件装配——@Conditional家族的实现机制

## 摘要

`@Conditional` 是 Spring Boot 自动装配的精确制导武器。有了它，框架才能做到"引入 Redis 依赖就自动配置 `RedisTemplate`，不引入就什么都不做"——这种"智能感知环境后按需装配"的能力，是 Spring Boot "开箱即用"体验的技术根基。本文从 `@Conditional` 的底层接口 `Condition` 出发，深入分析 Spring Boot 提供的 20+ 个内置条件注解的实现原理，重点剖析 `@ConditionalOnClass`（类路径条件）、`@ConditionalOnBean`/`@ConditionalOnMissingBean`（Bean 存在性条件）、`@ConditionalOnProperty`（配置属性条件）这三大核心条件注解的实现细节与使用陷阱，并系统梳理条件注解的评估时机、优先级规则与多条件组合语义。

---

## 第 1 章 @Conditional 的底层设计

### 1.1 Condition 接口：条件的最小原语

Spring Framework 4.0 引入了 `@Conditional` 注解和 `Condition` 接口，这是整个条件装配体系的基础：

```java
// @Conditional 注解：标注在 @Configuration 类或 @Bean 方法上
@Target({ElementType.TYPE, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface Conditional {
    // 指定一个或多个 Condition 实现类
    // 多个 Condition 之间是 AND 关系：全部满足才装配
    Class<? extends Condition>[] value();
}

// Condition 接口：条件的判断逻辑
@FunctionalInterface
public interface Condition {
    /**
     * 判断条件是否满足
     * @param context  条件评估上下文（可获取 BeanFactory、Environment、ClassLoader 等）
     * @param metadata 被注解元素的元数据（注解属性、类信息等）
     * @return true 表示条件满足，false 表示不满足
     */
    boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata);
}
```

`ConditionContext` 提供了丰富的环境信息：

```java
public interface ConditionContext {
    BeanDefinitionRegistry getRegistry();           // 访问 BeanDefinition 注册表
    @Nullable ConfigurableListableBeanFactory getBeanFactory(); // 访问 BeanFactory
    Environment getEnvironment();                   // 访问配置属性和 Profile
    ResourceLoader getResourceLoader();             // 加载类路径资源
    @Nullable ClassLoader getClassLoader();         // 检查类是否存在
}
```

一个最简单的自定义 `Condition` 实现——判断操作系统是否为 Linux：

```java
public class LinuxCondition implements Condition {
    
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        Environment env = context.getEnvironment();
        String osName = env.getProperty("os.name", "").toLowerCase();
        return osName.contains("linux");
    }
}

// 使用自定义条件
@Bean
@Conditional(LinuxCondition.class)
public FileSystemWatcher linuxFileWatcher() {
    return new InotifyFileWatcher(); // Linux 特有的 inotify 机制
}
```

### 1.2 条件评估的时机

条件评估不是在 Bean 实例化时进行的，而是在 **`ConfigurationClassPostProcessor` 处理 `@Configuration` 类时**（`refresh()` 步骤 6）：

- 对于类级别的 `@Conditional`：在 `ConfigurationClassParser` 决定是否解析该 `@Configuration` 类时评估；
- 对于方法级别的 `@Conditional`：在处理 `@Bean` 方法、决定是否将其注册为 `BeanDefinition` 时评估。

一旦条件评估结果为 `false`，对应的类/方法就不会产生任何 `BeanDefinition`——从容器角度看，这个 Bean 就从未存在过。

### 1.3 ConfigurationCondition：区分两个处理阶段

Spring 提供了 `ConfigurationCondition`，允许条件实现类指定自己在哪个阶段生效：

```java
public interface ConfigurationCondition extends Condition {
    
    // 指定条件在哪个阶段生效
    ConfigurationPhase getConfigurationPhase();
    
    enum ConfigurationPhase {
        // 在解析 @Configuration 类时评估（类级别条件）
        // 适合：@ConditionalOnClass（类路径条件，不依赖 BeanDefinition）
        PARSE_CONFIGURATION,
        
        // 在注册 BeanDefinition 时评估（方法级别条件）
        // 适合：@ConditionalOnBean（需要 BeanDefinition 已存在）
        REGISTER_BEAN
    }
}
```

这个区分非常重要：
- `@ConditionalOnClass` 只需要检查类路径，不依赖任何 Bean 的存在，在 `PARSE_CONFIGURATION` 阶段评估更高效；
- `@ConditionalOnBean` 需要检查 BeanFactory 中是否有某个 Bean，只有等 BeanDefinition 注册完毕后才能准确判断，必须在 `REGISTER_BEAN` 阶段评估。

---

## 第 2 章 @ConditionalOnClass / @ConditionalOnMissingClass

### 2.1 工作原理

`@ConditionalOnClass` 是自动配置中最常用的条件注解——类路径上有指定类才装配：

```java
@Target({ ElementType.TYPE, ElementType.METHOD })
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Conditional(OnClassCondition.class)  // 底层委托给 OnClassCondition
public @interface ConditionalOnClass {
    Class<?>[] value() default {};   // 通过 Class 引用指定（编译期检查）
    String[] name() default {};      // 通过类名字符串指定（运行时检查，类不在类路径上也不会编译失败）
}
```

`OnClassCondition` 的核心逻辑：

```java
// OnClassCondition 的实现（简化）
class OnClassCondition extends FilteringSpringBootCondition {
    
    @Override
    public ConditionOutcome getMatchOutcome(ConditionContext context, 
            AnnotatedTypeMetadata metadata) {
        
        ClassLoader classLoader = context.getClassLoader();
        ConditionMessage matchMessage = ConditionMessage.empty();
        
        // 获取 @ConditionalOnClass 的 name 属性（类名列表）
        List<String> onClasses = getCandidates(metadata, ConditionalOnClass.class);
        if (onClasses != null) {
            // 检查哪些类不在类路径上
            List<String> missing = filter(onClasses, ClassNameFilter.MISSING, classLoader);
            if (!missing.isEmpty()) {
                // 有类找不到，条件不满足
                return ConditionOutcome.noMatch(
                    ConditionMessage.forCondition(ConditionalOnClass.class)
                        .didNotFind("required class", "required classes")
                        .items(Style.QUOTE, missing));
            }
            matchMessage = matchMessage.andCondition(ConditionalOnClass.class)
                .found("required class", "required classes").items(Style.QUOTE, onClasses);
        }
        
        // @ConditionalOnMissingClass 的检查（类存在则不装配）
        List<String> onMissingClasses = getCandidates(metadata, ConditionalOnMissingClass.class);
        if (onMissingClasses != null) {
            List<String> present = filter(onMissingClasses, ClassNameFilter.PRESENT, classLoader);
            if (!present.isEmpty()) {
                return ConditionOutcome.noMatch(
                    ConditionMessage.forCondition(ConditionalOnMissingClass.class)
                        .found("unwanted class", "unwanted classes")
                        .items(Style.QUOTE, present));
            }
        }
        
        return ConditionOutcome.match(matchMessage);
    }
}
```

类路径检查通过 `classLoader.loadClass(className)` 实现——能加载则说明类存在，抛出 `ClassNotFoundException` 则说明不存在。

### 2.2 value 属性 vs name 属性的使用选择

```java
// ❌ 问题写法：使用 value（Class 引用）指定一个当前类路径上可能不存在的类
@ConditionalOnClass(RedisTemplate.class)  // 如果 spring-data-redis 不在类路径上，这行代码无法编译！
public class MyRedisConfig { ... }

// ✅ 正确写法：使用 name（类名字符串）
@ConditionalOnClass(name = "org.springframework.data.redis.core.RedisTemplate")
public class MyRedisConfig { ... }
```

这是编写自动配置类时最常见的陷阱之一。`@ConditionalOnClass` 的 `value` 属性用于引用**当前模块自己提供的类**（编译期确定存在）；`name` 属性用于引用**可能不在类路径上的外部类**（运行时检查）。

Spring Boot 的内置自动配置类大量使用 `name` 属性正是出于这个原因：

```java
// spring-boot-autoconfigure 模块中不依赖 spring-data-redis
// 但需要检测类路径上是否有 spring-data-redis
@AutoConfiguration
@ConditionalOnClass(name = "org.springframework.data.redis.core.RedisOperations")
public class RedisAutoConfiguration { ... }
```

---

## 第 3 章 @ConditionalOnBean / @ConditionalOnMissingBean

### 3.1 核心语义

`@ConditionalOnBean`：容器中已有指定 Bean 才装配（"我依赖某个 Bean 存在"）；
`@ConditionalOnMissingBean`：容器中没有指定 Bean 才装配（"用户没有自定义，我提供默认实现"）。

这两个注解是实现"用户配置优先"的核心机制：

```java
@AutoConfiguration
@ConditionalOnClass(ObjectMapper.class)
public class JacksonAutoConfiguration {
    
    @Bean
    @Primary
    @ConditionalOnMissingBean  // ← 如果用户已经定义了 ObjectMapper Bean，就不创建
    @ConditionalOnSingleCandidate(ObjectMapper.class)
    ObjectMapper jacksonObjectMapper(Jackson2ObjectMapperBuilder builder) {
        return builder.createXmlMapper(false).build();
    }
    
    @Bean
    @ConditionalOnMissingBean  // ← 如果用户定义了自己的 Builder，就不创建
    Jackson2ObjectMapperBuilder jacksonObjectMapperBuilder(
            JacksonProperties jacksonProperties,
            List<Jackson2ObjectMapperBuilderCustomizer> customizers) {
        // 使用 jacksonProperties 配置 Builder
        Jackson2ObjectMapperBuilder builder = new Jackson2ObjectMapperBuilder();
        ...
        return builder;
    }
}
```

### 3.2 @ConditionalOnMissingBean 的搜索范围

`@ConditionalOnMissingBean` 默认检查当前 Bean 的**类型**是否已在容器中存在：

```java
// 默认：检查是否存在 ObjectMapper 类型的 Bean
@ConditionalOnMissingBean  
// 等价于：
@ConditionalOnMissingBean(ObjectMapper.class)

// 指定检查特定类型
@ConditionalOnMissingBean(type = "com.fasterxml.jackson.databind.ObjectMapper")

// 指定检查特定名称
@ConditionalOnMissingBean(name = "objectMapper")

// 排除某些类型（这些类型的 Bean 存在时也认为"缺失"）
@ConditionalOnMissingBean(ignored = JacksonAutoConfiguration.class)

// 指定注解：检查是否有带特定注解的 Bean
@ConditionalOnMissingBean(annotation = Primary.class)
```

### 3.3 @ConditionalOnBean 的评估陷阱：顺序依赖

`@ConditionalOnBean` 是所有条件注解中**最容易踩坑**的一个，因为它的结果依赖于 BeanDefinition 的注册顺序。

**陷阱场景**：

```java
// 自动配置类 A：依赖 DataSource 存在才装配
@AutoConfiguration
@ConditionalOnBean(DataSource.class)  // ← 问题在这里
public class MetricsAutoConfiguration {
    
    @Bean
    public DatabaseMetricsCollector dbMetrics(DataSource dataSource) {
        return new DatabaseMetricsCollector(dataSource);
    }
}

// 用户配置类 B：定义 DataSource
@Configuration
public class DataSourceConfig {
    
    @Bean
    public DataSource dataSource() {
        return new HikariDataSource(...);
    }
}
```

如果 `MetricsAutoConfiguration` 在 `DataSourceConfig` 之前被处理（BeanDefinition 注册顺序更早），那么在评估 `@ConditionalOnBean(DataSource.class)` 时，`DataSource` 的 BeanDefinition 还未注册，条件判断为 `false`，`MetricsAutoConfiguration` 被跳过！

**根本原因**：`@ConditionalOnBean` 检查的是**当前时刻已注册的 BeanDefinition**，而非容器最终就绪后的所有 Bean。

**正确解法**：

```java
// 方案1：使用 @AutoConfigureAfter 确保在 DataSource 相关配置之后处理
@AutoConfiguration(after = DataSourceAutoConfiguration.class)
@ConditionalOnBean(DataSource.class)
public class MetricsAutoConfiguration { ... }

// 方案2：对于自动配置类，Spring Boot 通过 DeferredImportSelector 保证
// 自动配置类在用户配置类（@ComponentScan 扫描的类）之后处理
// 因此 @ConditionalOnMissingBean 通常比 @ConditionalOnBean 更安全

// 方案3：改用 @ConditionalOnClass（类路径条件），不依赖注册顺序
@AutoConfiguration
@ConditionalOnClass(DataSource.class)  // 只要类路径上有，就装配
public class MetricsAutoConfiguration { ... }
```

> [!warning] @ConditionalOnBean 的可靠使用场景
> `@ConditionalOnBean` 在以下场景相对安全：
> 1. 标注在自动配置类的 `@Bean` **方法**上（而非类上），此时 BeanDefinition 注册时机更晚；
> 2. 配合 `@AutoConfigureAfter` 明确指定顺序；
> 3. 检查的是 Spring Boot 自身的自动配置类注册的 Bean（顺序由 `@AutoConfigureAfter` 保证）。
> 
> 在自动配置类的**类级别**（而非方法级别）使用 `@ConditionalOnBean` 检查用户定义的 Bean，是不稳定的——结果依赖于类路径扫描和加载顺序，可能因 classpath 顺序不同而行为不一致。

---

## 第 4 章 @ConditionalOnProperty

### 4.1 语义与用法

`@ConditionalOnProperty` 基于配置属性的值决定是否装配，是实现"功能开关"的标准方式：

```java
@Target({ ElementType.TYPE, ElementType.METHOD })
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Conditional(OnPropertyCondition.class)
public @interface ConditionalOnProperty {
    
    String[] value() default {};     // 属性名（prefix + value = 完整属性键）
    String prefix() default "";      // 属性键前缀
    String[] name() default {};      // 属性名（与 value 等价）
    String havingValue() default ""; // 期望的属性值（空字符串表示属性存在且不为 false）
    boolean matchIfMissing() default false; // 属性不存在时是否视为匹配
}
```

常见用法：

```java
// 属性存在且值不为 "false" 时装配（最常见的"开关"用法）
@ConditionalOnProperty("app.feature.enabled")

// 属性值必须等于 "true"（更明确）
@ConditionalOnProperty(name = "app.feature.enabled", havingValue = "true")

// 属性不存在时也装配（默认开启，显式设置为 false 才关闭）
@ConditionalOnProperty(name = "app.feature.enabled", havingValue = "true", matchIfMissing = true)

// 带前缀
@ConditionalOnProperty(prefix = "spring.datasource", name = "url")

// 多个属性（AND 关系，全部满足才装配）
@ConditionalOnProperty(name = {"app.cache.enabled", "app.redis.enabled"})
```

### 4.2 OnPropertyCondition 的实现细节

`OnPropertyCondition` 通过 `Environment.getProperty()` 获取配置值：

```java
// OnPropertyCondition#getMatchOutcome()（简化）
@Override
public ConditionOutcome getMatchOutcome(ConditionContext context, 
        AnnotatedTypeMetadata metadata) {
    
    List<AnnotationAttributes> allConditionAttributes = annotationAttributesFromMultiValueMap(
        metadata.getAllAnnotationAttributes(ConditionalOnProperty.class.getName()));
    
    List<ConditionMessage> noMatch = new ArrayList<>();
    List<ConditionMessage> match = new ArrayList<>();
    
    for (AnnotationAttributes conditionAttributes : allConditionAttributes) {
        ConditionOutcome outcome = determineOutcome(conditionAttributes, 
            context.getEnvironment());
        (outcome.isMatch() ? match : noMatch).add(outcome.getConditionMessage());
    }
    
    if (!noMatch.isEmpty()) {
        return ConditionOutcome.noMatch(ConditionMessage.of(noMatch));
    }
    return ConditionOutcome.match(ConditionMessage.of(match));
}

private ConditionOutcome determineOutcome(AnnotationAttributes conditionAttributes, 
        PropertyResolver resolver) {
    
    String prefix = conditionAttributes.getString("prefix").trim();
    String[] names = getNames(conditionAttributes);
    String havingValue = conditionAttributes.getString("havingValue");
    boolean matchIfMissing = conditionAttributes.getBoolean("matchIfMissing");
    
    for (String name : names) {
        String key = prefix.isEmpty() ? name : (prefix + "." + name);
        String value = resolver.getProperty(key);
        
        if (value == null) {
            // 属性不存在：根据 matchIfMissing 决定
            if (!matchIfMissing) {
                return ConditionOutcome.noMatch(
                    ConditionMessage.forCondition(ConditionalOnProperty.class, conditionAttributes)
                        .didNotFind("property").items(Style.QUOTE, key));
            }
        } else {
            // 属性存在：检查值
            if (!isMatch(value, havingValue)) {
                return ConditionOutcome.noMatch(
                    ConditionMessage.forCondition(ConditionalOnProperty.class, conditionAttributes)
                        .found("different value in property").items(Style.QUOTE, key));
            }
        }
    }
    return ConditionOutcome.match(...);
}

private boolean isMatch(String value, String requiredValue) {
    if (StringUtils.hasLength(requiredValue)) {
        // 有期望值：精确匹配（忽略大小写）
        return requiredValue.equalsIgnoreCase(value);
    }
    // 无期望值：属性值不为 "false" 即视为匹配
    return !"false".equalsIgnoreCase(value);
}
```

### 4.3 Relaxed Binding 与属性名匹配

`@ConditionalOnProperty` 使用的是 `Environment.getProperty()`，而 `Environment` 底层走的是 `PropertySourcesPropertyResolver`，它支持精确匹配但不支持 Relaxed Binding（宽松绑定）。

```yaml
# application.yml 中的配置
app:
  my-feature:
    enabled: true
```

```java
// ✅ 匹配（kebab-case，与 YAML 一致）
@ConditionalOnProperty(prefix = "app.my-feature", name = "enabled")

// ❌ 不匹配（camelCase 在 @ConditionalOnProperty 中不会自动转换）
@ConditionalOnProperty(prefix = "app.myFeature", name = "enabled")
```

> [!warning] @ConditionalOnProperty 不支持 Relaxed Binding
> `@ConfigurationProperties` 支持 Relaxed Binding，但 `@ConditionalOnProperty` 不支持——它使用的 `Environment.getProperty()` 是精确匹配。因此，`@ConditionalOnProperty` 中的属性名必须与实际配置文件中的键名完全一致（推荐 kebab-case）。这是一个非常容易踩的坑，尤其是在从 `@ConfigurationProperties` 复制属性名时。

---

## 第 5 章 其他重要条件注解

### 5.1 @ConditionalOnWebApplication / @ConditionalOnNotWebApplication

```java
// 只在 Web 应用中装配
@ConditionalOnWebApplication
// 等价于：
@ConditionalOnWebApplication(type = Type.ANY)  // SERVLET 或 REACTIVE 都算

// 只在 Servlet Web 应用中装配（MVC，非 WebFlux）
@ConditionalOnWebApplication(type = Type.SERVLET)

// 只在 Reactive Web 应用中装配（WebFlux）
@ConditionalOnWebApplication(type = Type.REACTIVE)

// 非 Web 应用才装配（如定时任务、批处理应用）
@ConditionalOnNotWebApplication
```

`OnWebApplicationCondition` 通过检查 `ApplicationContext` 是否是 `WebApplicationContext` 的子类来判断：

```java
private ConditionOutcome isWebApplication(ConditionContext context, 
        AnnotatedTypeMetadata metadata, boolean required) {
    
    switch (deduceType(metadata)) {
        case SERVLET:
            return isServletWebApplication(context);
        case REACTIVE:
            return isReactiveWebApplication(context);
        default:
            return isAnyWebApplication(context, required);
    }
}

private ConditionOutcome isServletWebApplication(ConditionContext context) {
    ConditionMessage.Builder message = ConditionMessage.forCondition("");
    // 检查类路径上是否有 DispatcherServlet
    if (!ClassNameFilter.isPresent(SERVLET_WEB_APPLICATION_CLASS, context.getClassLoader())) {
        return ConditionOutcome.noMatch(message.didNotFind("servlet web application classes").atAll());
    }
    // 检查 ApplicationContext 是否是 WebApplicationContext
    if (context.getBeanFactory() != null) {
        String[] scopes = context.getBeanFactory().getRegisteredScopeNames();
        if (ObjectUtils.containsElement(scopes, "session")) {
            return ConditionOutcome.match(message.foundExactly("servlet web application 'session' scope"));
        }
    }
    ...
}
```

### 5.2 @ConditionalOnExpression

基于 SpEL 表达式的条件，提供最灵活的条件判断能力：

```java
// 基于 SpEL 表达式
@ConditionalOnExpression("${feature.enabled:true} && ${another.flag:false}")

// 调用 Bean 方法
@ConditionalOnExpression("@environment.getProperty('os.name').contains('Mac')")

// 复杂逻辑
@ConditionalOnExpression(
    "#{T(java.lang.Runtime).getRuntime().availableProcessors() > 4}"
)
```

`@ConditionalOnExpression` 的底层使用 `SpelExpressionParser` 解析并求值。由于每次评估都需要 SpEL 解析，性能比其他条件注解稍差，不建议在高频创建 Bean 的场景使用。

### 5.3 @ConditionalOnSingleCandidate

当指定类型的 Bean 在容器中只有一个（或有多个但其中一个标注了 `@Primary`）时才装配：

```java
// 只有容器中有且只有一个 DataSource Bean 时才装配（或有 @Primary DataSource）
@ConditionalOnSingleCandidate(DataSource.class)
public JdbcTemplate jdbcTemplate(DataSource dataSource) {
    return new JdbcTemplate(dataSource);
}
```

这个注解在多数据源场景中很有价值——如果用户配置了多个 `DataSource` 且没有指定 `@Primary`，`JdbcTemplate` 的自动配置就不会生效，避免因"不知道用哪个数据源"而导致的歧义。

### 5.4 @ConditionalOnJava

基于 JDK 版本的条件：

```java
// 只在 Java 11 及以上版本才装配
@ConditionalOnJava(JavaVersion.ELEVEN)
// 等价于：
@ConditionalOnJava(value = JavaVersion.ELEVEN, range = Range.EQUAL_OR_NEWER)

// 只在 Java 11 以下才装配（用旧 API 的向下兼容实现）
@ConditionalOnJava(value = JavaVersion.ELEVEN, range = Range.OLDER_THAN)
```

### 5.5 @ConditionalOnResource

类路径上存在指定资源文件才装配：

```java
// 类路径上有 log4j.properties 才装配
@ConditionalOnResource(resources = "classpath:log4j.properties")

// 文件系统上的路径
@ConditionalOnResource(resources = "file:/etc/app/config.json")
```

### 5.6 条件注解汇总

| 注解 | 触发条件 | 典型使用场景 |
| --- | --- | --- |
| `@ConditionalOnClass` | 类路径上有指定类 | 检测 SDK 依赖是否存在 |
| `@ConditionalOnMissingClass` | 类路径上没有指定类 | 没有高版本 SDK 时用旧版实现 |
| `@ConditionalOnBean` | 容器中已有指定 Bean | 依赖某 Bean 存在才扩展 |
| `@ConditionalOnMissingBean` | 容器中没有指定 Bean | 用户未自定义时提供默认实现 |
| `@ConditionalOnSingleCandidate` | 容器中只有一个同类型 Bean | 避免多数据源歧义 |
| `@ConditionalOnProperty` | 配置属性满足条件 | 功能开关、环境检测 |
| `@ConditionalOnExpression` | SpEL 表达式为 true | 复杂组合条件 |
| `@ConditionalOnWebApplication` | 是 Web 应用 | Web 专属功能 |
| `@ConditionalOnNotWebApplication` | 不是 Web 应用 | 批处理/守护进程专属功能 |
| `@ConditionalOnJava` | JDK 版本满足条件 | 新版 JDK 特性的按需启用 |
| `@ConditionalOnResource` | 资源文件存在 | 配置文件驱动的功能启用 |
| `@ConditionalOnCloudPlatform` | 在指定云平台上运行 | 云原生适配（Kubernetes、Cloud Foundry 等） |
| `@Profile` | 指定 Profile 激活 | 环境差异化配置（dev/test/prod） |

---

## 第 6 章 条件注解的组合与优先级

### 6.1 同类型条件的 AND 语义

当多个 `@Conditional` 注解标注在同一元素上时，默认是 AND 关系——所有条件都满足才装配：

```java
@Bean
@ConditionalOnClass(RedisTemplate.class)   // 条件1：类路径上有 RedisTemplate
@ConditionalOnProperty("app.cache.redis") // 条件2：配置了 redis 缓存开关
@ConditionalOnMissingBean(CacheManager.class) // 条件3：没有自定义 CacheManager
public RedisCacheManager redisCacheManager(RedisTemplate<?, ?> template) {
    return new RedisCacheManager(template);
}
```

三个条件必须**全部**满足，`redisCacheManager` Bean 才会被注册。

### 6.2 @Profile：特殊的条件注解

`@Profile` 是 Spring Framework 内置的条件注解（不是 Spring Boot 的），底层也是通过 `@Conditional(ProfileCondition.class)` 实现的：

```java
// 只在 dev 或 test 环境才注册的 Bean
@Bean
@Profile({"dev", "test"})
public DataSource embeddedDataSource() {
    return new EmbeddedDatabaseBuilder()
        .setType(EmbeddedDatabaseType.H2)
        .build();
}

// 只在非 production 环境才注册
@Bean
@Profile("!production")
public MockEmailService mockEmailService() {
    return new MockEmailService();
}
```

`@Profile` 的表达式语法：
- `"dev"`：激活了 dev Profile；
- `"!production"`：没有激活 production Profile；
- `"dev | test"`：激活了 dev 或 test 之一；
- `"dev & cloud"`：同时激活了 dev 和 cloud；
- `"(dev | test) & !legacy"`：复杂组合（Spring 5.1+ 支持括号分组）。

### 6.3 自定义组合条件注解

通过 `@Conditional` 的元注解特性，可以创建语义更清晰的组合条件注解：

```java
// 创建一个"开发环境且没有自定义配置时装配"的组合注解
@Target({ ElementType.TYPE, ElementType.METHOD })
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Profile("dev")
@ConditionalOnMissingBean
public @interface ConditionalOnDevDefault {
    // 组合 @Profile("dev") 和 @ConditionalOnMissingBean
    // 只有在 dev Profile 下且用户未自定义时才装配
}

// 使用
@Bean
@ConditionalOnDevDefault
public MockPaymentService mockPaymentService() {
    return new MockPaymentService();
}
```

---

## 第 7 章 自定义 Condition 的进阶模式

### 7.1 SpringBootCondition：更丰富的诊断输出

Spring Boot 提供了 `SpringBootCondition` 基类，它在 `Condition` 的基础上增加了更丰富的日志支持，使 `--debug` 报告中能显示详细的条件评估原因：

```java
public abstract class SpringBootCondition implements Condition {
    
    @Override
    public final boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        // 获取条件附加信息（注解标注的类名或方法名）
        String classOrMethodName = getClassOrMethodName(metadata);
        try {
            // 委托给子类的具体判断逻辑
            ConditionOutcome outcome = getMatchOutcome(context, metadata);
            
            // 记录日志（会出现在 --debug 的条件评估报告中）
            logOutcome(classOrMethodName, outcome);
            recordEvaluation(context, classOrMethodName, outcome);
            
            return outcome.isMatch();
        } catch (NoClassDefFoundError ex) {
            throw new IllegalStateException("...", ex);
        }
    }
    
    // 子类实现具体的条件判断，返回 ConditionOutcome（包含结果 + 原因描述）
    public abstract ConditionOutcome getMatchOutcome(ConditionContext context, 
            AnnotatedTypeMetadata metadata);
}
```

实现自定义条件时，继承 `SpringBootCondition` 而非直接实现 `Condition` 接口：

```java
// 自定义条件：检查系统是否有足够内存（> 2GB）
public class SufficientMemoryCondition extends SpringBootCondition {
    
    private static final long MIN_MEMORY_BYTES = 2L * 1024 * 1024 * 1024; // 2GB
    
    @Override
    public ConditionOutcome getMatchOutcome(ConditionContext context, 
            AnnotatedTypeMetadata metadata) {
        
        long maxMemory = Runtime.getRuntime().maxMemory();
        
        if (maxMemory >= MIN_MEMORY_BYTES) {
            return ConditionOutcome.match(
                ConditionMessage.forCondition("SufficientMemory")
                    .found("sufficient JVM heap")
                    .items(Style.QUOTE, formatBytes(maxMemory)));
        }
        
        return ConditionOutcome.noMatch(
            ConditionMessage.forCondition("SufficientMemory")
                .found("insufficient JVM heap")
                .items(Style.QUOTE, 
                    formatBytes(maxMemory) + " < required " + formatBytes(MIN_MEMORY_BYTES)));
    }
    
    private String formatBytes(long bytes) {
        return String.format("%.1fGB", bytes / (1024.0 * 1024 * 1024));
    }
}

// 创建注解
@Target({ ElementType.TYPE, ElementType.METHOD })
@Retention(RetentionPolicy.RUNTIME)
@Conditional(SufficientMemoryCondition.class)
public @interface ConditionalOnSufficientMemory {}

// 使用
@Bean
@ConditionalOnSufficientMemory
public LargeInMemoryCache bigCache() {
    return new LargeInMemoryCache(512 * 1024 * 1024); // 512MB 缓存
}
```

### 7.2 条件注解与 AOT 的兼容性

Spring Boot 3.x 的 AOT（Ahead-of-Time）处理在编译时对条件注解进行静态分析。部分条件注解天然支持 AOT（如 `@ConditionalOnClass`——类路径在编译时已知），而另一些条件在运行时才能评估（如 `@ConditionalOnBean`——Bean 的存在取决于运行时配置）。

对于**自定义 Condition**，如果需要兼容 AOT 和 Native Image，需要实现 `RuntimeHintsRegistrar` 来告知 AOT 处理器该 Condition 在运行时需要哪些反射权限：

```java
// 告知 GraalVM 编译器：SufficientMemoryCondition 需要在运行时保留
@ImportRuntimeHints(SufficientMemoryCondition.Hints.class)
public class SufficientMemoryCondition extends SpringBootCondition {
    
    static class Hints implements RuntimeHintsRegistrar {
        @Override
        public void registerHints(RuntimeHints hints, ClassLoader classLoader) {
            // 注册需要保留的类、方法、资源
            hints.reflection().registerType(SufficientMemoryCondition.class,
                MemberCategory.INVOKE_DECLARED_CONSTRUCTORS);
        }
    }
}
```

---

## 第 8 章 条件装配的调试与诊断

### 8.1 ConditionEvaluationReport

`ConditionEvaluationReport` 记录了容器启动过程中所有条件注解的评估结果，是排查自动装配问题的核心工具。

获取并分析 `ConditionEvaluationReport`：

```java
// 编程方式获取条件评估报告
@Autowired
private ApplicationContext applicationContext;

public void printConditionReport() {
    ConditionEvaluationReport report = ConditionEvaluationReport
        .get(applicationContext.getBeanFactory());
    
    // 打印所有不满足条件的自动配置类及原因
    report.getConditionAndOutcomesBySource().forEach((source, outcomes) -> {
        boolean anyNoMatch = outcomes.stream().anyMatch(co -> !co.getOutcome().isMatch());
        if (anyNoMatch) {
            System.out.println("NOT MATCHED: " + source);
            outcomes.forEach(co -> {
                if (!co.getOutcome().isMatch()) {
                    System.out.println("  - " + co.getOutcome().getMessage());
                }
            });
        }
    });
}
```

### 8.2 自动化条件测试

使用 `ApplicationContextRunner` 对自定义条件和自动配置进行单元测试：

```java
class RateLimiterAutoConfigurationTest {
    
    // ApplicationContextRunner：轻量级的 Spring Boot 应用上下文测试工具
    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(RateLimiterAutoConfiguration.class));
    
    @Test
    void autoConfiguresWhenEnabled() {
        contextRunner
            .withPropertyValues("app.rate-limiter.enabled=true")
            .run(context -> {
                // 断言 RateLimiter Bean 已被创建
                assertThat(context).hasSingleBean(RateLimiter.class);
                // 断言 QPS 配置正确
                RateLimiterProperties props = context.getBean(RateLimiterProperties.class);
                assertThat(props.getQps()).isEqualTo(1000);
            });
    }
    
    @Test
    void doesNotAutoConfigureWhenDisabled() {
        contextRunner
            .withPropertyValues("app.rate-limiter.enabled=false")
            .run(context -> {
                // 属性为 false，不应该装配
                assertThat(context).doesNotHaveBean(RateLimiter.class);
            });
    }
    
    @Test
    void backOffWhenUserDefinesCustomRateLimiter() {
        contextRunner
            .withPropertyValues("app.rate-limiter.enabled=true")
            .withUserConfiguration(CustomRateLimiterConfig.class) // 用户自定义配置
            .run(context -> {
                // 用户自定义了 RateLimiter，自动配置应退让
                assertThat(context).hasSingleBean(RateLimiter.class);
                // 确认是用户的自定义实现，而非自动配置的默认实现
                assertThat(context.getBean(RateLimiter.class))
                    .isInstanceOf(CustomRateLimiter.class);
            });
    }
    
    @Configuration
    static class CustomRateLimiterConfig {
        @Bean
        RateLimiter customRateLimiter() {
            return new CustomRateLimiter(5000); // 自定义 QPS
        }
    }
}
```

`ApplicationContextRunner` 是测试 Spring Boot 自动配置的标准工具，它的优点：
- 不启动完整的 Spring Boot 应用，启动速度极快；
- 支持精确控制加载哪些自动配置类；
- 提供流畅的 AssertJ 风格断言（`assertThat(context).hasSingleBean(...)`）；
- 每个测试方法都是独立的 `ApplicationContext`，测试互不干扰。

---

## 总结

本文系统梳理了 Spring Boot 条件装配的完整体系：

- **底层基础**：`Condition` 接口 + `@Conditional` 注解构成条件装配的最小原语；`ConditionContext` 提供 BeanFactory、Environment、ClassLoader 等评估上下文；`ConfigurationCondition` 区分 `PARSE_CONFIGURATION`（类解析阶段）和 `REGISTER_BEAN`（BeanDefinition 注册阶段）两个评估时机；
- **核心三件套**：`@ConditionalOnClass`（类路径条件，最安全，性能最好）+ `@ConditionalOnMissingBean`（用户优先机制）+ `@ConditionalOnProperty`（功能开关），是自动配置类的标准模式；
- **使用陷阱**：`@ConditionalOnBean` 的顺序依赖问题（在类级别使用时需配合 `@AutoConfigureAfter`）；`@ConditionalOnProperty` 不支持 Relaxed Binding（需与配置文件键名完全一致）；`@ConditionalOnClass` 的 `value` vs `name` 选择（外部类用 `name`）；
- **调试工具**：`--debug` 参数打印 `ConditionEvaluationReport`；`ApplicationContextRunner` 做自动配置的单元测试；
- **组合条件**：多条件 AND 语义；`@Profile` 也是条件注解；可通过元注解创建语义化组合条件注解。

下一篇，我们深入 Spring Boot 的嵌入式 Web 容器，探讨 Tomcat、Jetty、Undertow 如何被集成进 Spring Boot，以及它们的启动、配置与切换机制：[[04 嵌入式Web容器——Tomcat、Jetty、Undertow的启动与配置]]。

---

> [!note] 参考资料
> - `org.springframework.boot.autoconfigure.condition.OnClassCondition` 源码
> - `org.springframework.boot.autoconfigure.condition.OnBeanCondition` 源码
> - `org.springframework.boot.autoconfigure.condition.OnPropertyCondition` 源码
> - `org.springframework.boot.test.context.runner.ApplicationContextRunner` 源码
> - [Spring Boot 官方文档 - Condition Annotations](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration.condition-annotations)
