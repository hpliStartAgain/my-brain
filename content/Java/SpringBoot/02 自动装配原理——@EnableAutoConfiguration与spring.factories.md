---
title: "自动装配原理——@EnableAutoConfiguration与spring.factories"
date: 2026-03-04
tags: [Java, SpringBoot, 自动装配, AutoConfiguration, EnableAutoConfiguration, spring.factories, SpringFactoriesLoader]
aliases: []
---

# 自动装配原理——@EnableAutoConfiguration与spring.factories

## 摘要

Spring Boot 最具革命性的特性是"约定优于配置"的自动装配机制——引入 `spring-boot-starter-data-redis` 依赖后，`RedisTemplate` 就自动可用了；引入 `spring-boot-starter-web` 后，`DispatcherServlet`、`Jackson`、内嵌 Tomcat 就自动配置好了。这一切的背后，是 `@EnableAutoConfiguration` + `spring.factories`（Spring Boot 2.x）/ `AutoConfiguration.imports`（Spring Boot 3.x）+ `@Conditional` 条件注解共同构成的自动装配体系。本文深入剖析自动装配的完整链路：从 `@EnableAutoConfiguration` 到 `AutoConfigurationImportSelector`，再到 `spring.factories` 的加载与过滤，重点分析自动配置类的排序机制（`@AutoConfigureOrder`/`@AutoConfigureBefore`/`@AutoConfigureAfter`）以及 Spring Boot 3.x 带来的重大架构调整。

---

## 第 1 章 自动装配解决的核心问题

### 1.1 Spring Framework 的"配置地狱"

在 Spring Boot 出现之前，一个典型的 Spring Web 应用需要大量的 XML 或 Java Config 配置。以集成 Redis 为例：

```java
// Spring Framework 时代：需要手动配置每一个组件
@Configuration
public class RedisConfig {
    
    @Bean
    public RedisConnectionFactory redisConnectionFactory() {
        LettuceConnectionFactory factory = new LettuceConnectionFactory();
        factory.setHostName("localhost");
        factory.setPort(6379);
        factory.afterPropertiesSet();
        return factory;
    }
    
    @Bean
    public RedisTemplate<String, Object> redisTemplate(
            RedisConnectionFactory connectionFactory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.afterPropertiesSet();
        return template;
    }
    
    @Bean
    public StringRedisTemplate stringRedisTemplate(
            RedisConnectionFactory connectionFactory) {
        return new StringRedisTemplate(connectionFactory);
    }
}
```

这段配置有几个明显的问题：
1. **每个项目都需要重复编写**：没有复用机制，每个使用 Redis 的 Spring 应用都需要类似的配置；
2. **配置项硬编码**：`localhost:6379` 写死在代码中，不易维护；
3. **知识负担重**：开发者需要了解 `LettuceConnectionFactory`、序列化器的选择等细节；
4. **版本兼容复杂**：不同版本的 `spring-data-redis` 依赖的 Lettuce/Jedis 版本不同，手动管理版本冲突耗时费力。

### 1.2 自动装配的设计目标

Spring Boot 的自动装配机制要解决三个层次的问题：

**第一层（依赖管理）**：Spring Boot Starter 通过 Maven/Gradle 的 BOM（Bill of Materials）和 Starter 依赖，统一管理版本，消除版本冲突。引入 `spring-boot-starter-data-redis`，Lettuce、`spring-data-redis` 的版本都由 Spring Boot 自动管理。

**第二层（配置提供）**：`RedisAutoConfiguration` 为用户提供了合理的默认配置。只要类路径上有 Redis 的相关类且没有用户自定义配置，`RedisTemplate` 就会被自动注册。

**第三层（条件装配）**：自动配置不是无条件的——`@ConditionalOnClass`（类路径上有特定类才装配）、`@ConditionalOnMissingBean`（容器中没有用户自定义的同类 Bean 才装配）等条件注解，确保自动配置不会覆盖用户的自定义配置，也不会在不需要的时候引入不必要的 Bean。

---

## 第 2 章 @EnableAutoConfiguration 的工作原理

### 2.1 @EnableAutoConfiguration 是什么

`@EnableAutoConfiguration` 是一个 `@Import` 注解的变体：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@AutoConfigurationPackage    // ① 注册 @SpringBootApplication 所在包为"自动配置基础包"
@Import(AutoConfigurationImportSelector.class)  // ② 引入核心选择器
public @interface EnableAutoConfiguration {
    
    // 排除特定的自动配置类（按类型）
    Class<?>[] exclude() default {};
    
    // 排除特定的自动配置类（按类名，用于未在类路径上的类）
    String[] excludeName() default {};
}
```

`@AutoConfigurationPackage` 通过 `@Import(AutoConfigurationPackages.Registrar.class)` 将 `@SpringBootApplication` 所在包路径注册到容器中。这个信息被 Spring Data JPA 等框架用于扫描实体类——JPA 需要知道从哪个包开始扫描 `@Entity` 类，而不需要开发者显式指定。

### 2.2 AutoConfigurationImportSelector：自动配置的核心选择器

`AutoConfigurationImportSelector` 实现了 `DeferredImportSelector`（`ImportSelector` 的延迟版本），在 `ConfigurationClassPostProcessor` 处理 `@Import` 时被调用：

```java
public class AutoConfigurationImportSelector 
        implements DeferredImportSelector, BeanClassLoaderAware, 
                   ResourceLoaderAware, BeanFactoryAware, EnvironmentAware, Ordered {
    
    @Override
    public String[] selectImports(AnnotationMetadata annotationMetadata) {
        if (!isEnabled(annotationMetadata)) {
            return NO_IMPORTS;
        }
        // 调用核心方法获取所有应该自动配置的类名列表
        AutoConfigurationEntry autoConfigurationEntry = 
            getAutoConfigurationEntry(annotationMetadata);
        return StringUtils.toStringArray(autoConfigurationEntry.getConfigurations());
    }
    
    protected AutoConfigurationEntry getAutoConfigurationEntry(
            AnnotationMetadata annotationMetadata) {
        
        if (!isEnabled(annotationMetadata)) {
            return EMPTY_ENTRY;
        }
        
        // 获取 @EnableAutoConfiguration 的属性（exclude、excludeName）
        AnnotationAttributes attributes = getAttributes(annotationMetadata);
        
        // ① 加载所有候选的自动配置类名
        List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);
        
        // ② 去重（同一个类可能来自多个 spring.factories 文件）
        configurations = removeDuplicates(configurations);
        
        // ③ 处理 @EnableAutoConfiguration 的 exclude/excludeName 排除列表
        Set<String> exclusions = getExclusions(annotationMetadata, attributes);
        checkExcludedClasses(configurations, exclusions);
        configurations.removeAll(exclusions);
        
        // ④ 过滤：使用 AutoConfigurationImportFilter 进行条件过滤
        // （性能优化：在这里提前过滤掉不满足 @ConditionalOnClass 等条件的配置类）
        configurations = getConfigurationClassFilter().filter(configurations);
        
        // ⑤ 触发 AutoConfigurationImportEvent（供 devtools 等使用）
        fireAutoConfigurationImportEvents(configurations, exclusions);
        
        return new AutoConfigurationEntry(configurations, exclusions);
    }
}
```

**为什么使用 `DeferredImportSelector` 而非普通 `ImportSelector`？**

`ImportSelector` 在 `ConfigurationClassPostProcessor` 处理 `@Import` 时立即执行，此时可能还有其他 `@Configuration` 类尚未解析。`DeferredImportSelector` 的 `selectImports()` 被延迟到**所有普通 `@Configuration` 类处理完毕之后**才执行。

这个延迟的意义在于：自动配置类需要感知用户是否已经定义了某些 Bean（`@ConditionalOnMissingBean`），而用户的 Bean 定义（来自 `@ComponentScan` 的组件）应该先于自动配置类处理。延迟确保了"用户配置优先于自动配置"的语义。

---

## 第 3 章 spring.factories 的加载机制

### 3.1 getCandidateConfigurations()：加载候选配置类

```java
protected List<String> getCandidateConfigurations(AnnotationMetadata metadata, 
        AnnotationAttributes attributes) {
    
    // Spring Boot 2.7+ 同时支持两种方式：
    
    // 方式一：从 META-INF/spring.factories 加载（旧方式，向后兼容）
    List<String> configurations = new ArrayList<>(
        SpringFactoriesLoader.loadFactoryNames(
            getSpringFactoriesLoaderFactoryClass(),  // EnableAutoConfiguration.class
            getBeanClassLoader()));
    
    // 方式二：从 META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
    // 加载（Spring Boot 2.7+ 新方式，Spring Boot 3.x 中成为主要方式）
    ImportCandidates.load(AutoConfiguration.class, getBeanClassLoader())
        .forEach(configurations::add);
    
    return configurations;
}
```

### 3.2 SpringFactoriesLoader：服务发现的基础设施

`SpringFactoriesLoader` 是 Spring Boot 服务发现机制的底层实现，类似 Java 的 `ServiceLoader`，但更灵活：

```java
public final class SpringFactoriesLoader {
    
    // 扫描的文件路径（固定）
    public static final String FACTORIES_RESOURCE_LOCATION = "META-INF/spring.factories";
    
    public static List<String> loadFactoryNames(Class<?> factoryType, 
            @Nullable ClassLoader classLoader) {
        ClassLoader classLoaderToUse = classLoader != null ? classLoader 
            : SpringFactoriesLoader.class.getClassLoader();
        
        String factoryTypeName = factoryType.getName();
        return loadSpringFactories(classLoaderToUse).getOrDefault(factoryTypeName, 
            Collections.emptyList());
    }
    
    private static Map<String, List<String>> loadSpringFactories(ClassLoader classLoader) {
        // 有缓存则直接返回（每个 ClassLoader 只加载一次）
        Map<String, List<String>> result = cache.get(classLoader);
        if (result != null) {
            return result;
        }
        
        result = new HashMap<>();
        try {
            // 扫描类路径上所有 jar 中的 META-INF/spring.factories
            Enumeration<URL> urls = classLoader.getResources(FACTORIES_RESOURCE_LOCATION);
            while (urls.hasMoreElements()) {
                URL url = urls.nextElement();
                UrlResource resource = new UrlResource(url);
                Properties properties = PropertiesLoaderUtils.loadProperties(resource);
                
                // 将每个 key（接口全类名）对应的 value（实现类全类名列表）合并
                for (Map.Entry<?, ?> entry : properties.entrySet()) {
                    String factoryTypeName = ((String) entry.getKey()).trim();
                    String[] factoryImplementationNames = 
                        StringUtils.commaDelimitedListToStringArray((String) entry.getValue());
                    for (String factoryImplementationName : factoryImplementationNames) {
                        result.computeIfAbsent(factoryTypeName, key -> new ArrayList<>())
                            .add(factoryImplementationName.trim());
                    }
                }
            }
        } catch (IOException ex) {
            throw new IllegalArgumentException("...", ex);
        }
        
        // 放入缓存
        result.replaceAll((factoryType, implementations) -> 
            implementations.stream().distinct().collect(Collectors.toList()));
        cache.put(classLoader, result);
        return result;
    }
}
```

一个典型的 `META-INF/spring.factories` 文件（来自 `spring-boot-autoconfigure`）：

```properties
# Auto Configure
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
org.springframework.boot.autoconfigure.admin.SpringApplicationAdminJmxAutoConfiguration,\
org.springframework.boot.autoconfigure.aop.AopAutoConfiguration,\
org.springframework.boot.autoconfigure.amqp.RabbitAutoConfiguration,\
org.springframework.boot.autoconfigure.batch.BatchAutoConfiguration,\
org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration,\
org.springframework.boot.autoconfigure.cassandra.CassandraAutoConfiguration,\
org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration,\
org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration,\
org.springframework.boot.autoconfigure.data.redis.RedisReactiveAutoConfiguration,\
org.springframework.boot.autoconfigure.data.redis.RedisRepositoriesAutoConfiguration,\
...（共 144 个自动配置类）
```

Spring Boot 2.x 的 `spring-boot-autoconfigure` 包含约 **144 个**自动配置类，覆盖了从数据库到消息队列、从缓存到安全的几乎所有主流技术栈。

### 3.3 Spring Boot 3.x 的架构调整：AutoConfiguration.imports

Spring Boot 3.x（以及 2.7 的过渡版本）将自动配置类的注册从 `spring.factories` 分离到专属文件：

```
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

文件内容格式更简洁（每行一个类名，不需要 key-value 格式）：

```
org.springframework.boot.autoconfigure.aop.AopAutoConfiguration
org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration
org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration
...
```

**为什么要做这个调整？**

`spring.factories` 本来是一个通用的服务发现文件，存储了监听器、初始化器、自动配置类等多种类型的注册信息。随着自动配置类数量的膨胀（144+），`spring.factories` 文件变得臃肿，且无法区分"自动配置类"和"其他类型注册信息"的语义。

专属的 `AutoConfiguration.imports` 文件有几个优势：
1. **语义更清晰**：文件名本身就说明了它只包含自动配置类；
2. **更好的 AOT 支持**：Spring Boot 3.x 的 AOT 处理器可以精确定位自动配置类并进行编译期优化；
3. **更快的加载**：格式更简单，解析开销更低；
4. **GraalVM Native Image 友好**：更易于在编译时静态分析和处理。

---

## 第 4 章 自动配置类的解剖：以 RedisAutoConfiguration 为例

### 4.1 RedisAutoConfiguration 的完整结构

```java
// ① @AutoConfiguration 是 @Configuration + @AutoConfigureBefore/@AutoConfigureAfter 的组合
@AutoConfiguration
// ② 类路径上必须有 RedisOperations 类才装配（否则无 spring-data-redis，无需配置）
@ConditionalOnClass(RedisOperations.class)
// ③ 导入连接工厂的配置（LettuceConnectionConfiguration 或 JedisConnectionConfiguration）
@Import({ LettuceConnectionConfiguration.class, JedisConnectionConfiguration.class })
// ④ 启用 RedisProperties 配置绑定（spring.data.redis.* 属性）
@EnableConfigurationProperties(RedisProperties.class)
public class RedisAutoConfiguration {
    
    // ⑤ 只有容器中没有用户自定义 RedisTemplate 时才注册
    @Bean
    @ConditionalOnMissingBean(name = "redisTemplate")
    @ConditionalOnSingleCandidate(RedisConnectionFactory.class)
    public RedisTemplate<Object, Object> redisTemplate(
            RedisConnectionFactory redisConnectionFactory) {
        RedisTemplate<Object, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(redisConnectionFactory);
        return template;
    }
    
    // ⑥ 只有容器中没有用户自定义 StringRedisTemplate 时才注册
    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnSingleCandidate(RedisConnectionFactory.class)
    public StringRedisTemplate stringRedisTemplate(
            RedisConnectionFactory redisConnectionFactory) {
        return new StringRedisTemplate(redisConnectionFactory);
    }
}
```

解读这个结构的关键点：

1. **`@ConditionalOnClass(RedisOperations.class)`**：整个类级别的条件。如果类路径上没有 `spring-data-redis`（`RedisOperations` 不存在），整个 `RedisAutoConfiguration` 类不会被处理，不浪费任何资源；

2. **`@Import` 导入连接工厂配置**：`LettuceConnectionConfiguration` 负责 Lettuce 客户端（默认），`JedisConnectionConfiguration` 负责 Jedis 客户端，两者都有 `@ConditionalOnClass` 保护——只有对应客户端的类在类路径上时才生效。这种设计允许用户通过替换依赖来切换 Redis 客户端，无需修改任何配置；

3. **`@ConditionalOnMissingBean`**：自动配置类"礼让"用户配置的核心机制。如果用户在自己的 `@Configuration` 类中定义了 `RedisTemplate` Bean，这个条件为 false，自动配置的 `RedisTemplate` 不会注册，避免 Bean 冲突；

4. **`@EnableConfigurationProperties(RedisProperties.class)`**：将 `spring.data.redis.*` 属性绑定到 `RedisProperties` POJO，实现配置驱动。用户只需在 `application.yml` 中写 `spring.data.redis.host=redis-server`，无需写任何 Java 配置代码。

### 4.2 连接工厂的自动选择

`LettuceConnectionConfiguration` 的实现展示了 Spring Boot 条件装配的精妙：

```java
@Configuration(proxyBeanMethods = false)
@ConditionalOnClass(RedisClient.class)   // Lettuce 的核心类
@ConditionalOnProperty(name = "spring.data.redis.client-type", 
    havingValue = "lettuce", matchIfMissing = true) // 默认使用 Lettuce
class LettuceConnectionConfiguration extends RedisConnectionConfiguration {
    
    @Bean
    @ConditionalOnMissingBean(RedisConnectionFactory.class)
    LettuceConnectionFactory redisConnectionFactory(
            ObjectProvider<LettuceClientConfigurationBuilderCustomizer> 
                builderCustomizers,
            ClientResources clientResources) throws UnknownHostException {
        
        // 从 RedisProperties 读取 host、port、password 等配置
        LettuceClientConfiguration clientConfig = getLettuceClientConfiguration(
            builderCustomizers, clientResources, 
            getProperties().getLettuce().getPool());
        
        return createLettuceConnectionFactory(clientConfig);
    }
}
```

如果用户想切换到 Jedis，只需：
1. 在 `pom.xml` 中排除 `lettuce-core`，添加 `jedis`；
2. 在 `application.yml` 中添加 `spring.data.redis.client-type: jedis`（可选）。

Spring Boot 的条件装配机制会自动使 `LettuceConnectionConfiguration` 失效，`JedisConnectionConfiguration` 生效。这就是"约定优于配置"的精髓——用户只需要表达意图（我想用 Jedis），框架负责推断如何实现。

---

## 第 5 章 自动配置类的排序机制

### 5.1 为什么需要排序

自动配置类之间可能存在依赖关系。例如：
- `SecurityAutoConfiguration` 需要在 `WebMvcAutoConfiguration` 之前应用，才能在 Web MVC 配置中集成安全过滤器；
- `DataSourceAutoConfiguration`（配置数据源）需要先于 `JpaAutoConfiguration`（配置 JPA）执行，因为 JPA 依赖数据源；
- `JacksonAutoConfiguration` 需要先于 `WebMvcAutoConfiguration` 执行，因为 Web MVC 需要 Jackson 的消息转换器。

### 5.2 @AutoConfigureBefore / @AutoConfigureAfter

这两个注解直接声明自动配置类之间的相对顺序：

```java
// JacksonAutoConfiguration 没有特殊排序声明
@AutoConfiguration
@ConditionalOnClass(ObjectMapper.class)
public class JacksonAutoConfiguration { ... }

// WebMvcAutoConfiguration 明确声明自己应在 JacksonAutoConfiguration 之后
@AutoConfiguration(after = {
    DispatcherServletAutoConfiguration.class,
    TaskExecutionAutoConfiguration.class,
    ValidationAutoConfiguration.class
})
@ConditionalOnWebApplication(type = Type.SERVLET)
@ConditionalOnClass({ Servlet.class, DispatcherServlet.class, WebMvcConfigurer.class })
@ConditionalOnMissingBean(WebMvcConfigurationSupport.class)
public class WebMvcAutoConfiguration { ... }
```

Spring Boot 3.x 将 `@AutoConfigureBefore`/`@AutoConfigureAfter` 合并到了 `@AutoConfiguration` 注解的 `before`/`after` 属性中，更简洁。

### 5.3 @AutoConfigureOrder：全局顺序

`@AutoConfigureOrder` 提供全局的整数排序（类比 `@Order`），数值越小越先加载：

```java
@AutoConfiguration
@AutoConfigureOrder(Ordered.HIGHEST_PRECEDENCE + 5)  // 非常高的优先级
@ConditionalOnClass(DispatcherServlet.class)
public class DispatcherServletAutoConfiguration { ... }
```

**排序的完整优先级（由高到低）**：
1. `@AutoConfigureOrder` 的数值（数值小优先）；
2. `@AutoConfigureBefore`/`@AutoConfigureAfter` 的依赖关系约束（拓扑排序）；
3. 在相同优先级和无依赖关系时，按类名字典序（保证确定性）。

### 5.4 排序陷阱：@AutoConfigureBefore/@After 与实际加载顺序

一个常见的误解：`@AutoConfigureBefore(B.class)` 并不意味着"A 一定在 B 之前完成所有 Bean 的注册"——它只是说明在 `ConfigurationClassPostProcessor` 解析这些配置类时，A 的 `BeanDefinition` 会先于 B 注册。但由于 `@Conditional` 的存在，B 可能在条件评估时就被完全跳过，顺序无关紧要。

真正关键的是：**当多个自动配置类都注册了某种类型的 Bean 时，排序决定了哪个 Bean 先被注册，从而影响 `@Primary` 和 `@ConditionalOnMissingBean` 的判断结果**。

---

## 第 6 章 自动配置的过滤优化

### 6.1 AutoConfigurationImportFilter：提前过滤

在 `getAutoConfigurationEntry()` 中，有一步 `getConfigurationClassFilter().filter(configurations)` 的操作。这是 Spring Boot 的一个重要性能优化：**在真正实例化这些配置类之前，通过 `AutoConfigurationImportFilter` 提前过滤掉明显不满足条件的配置类**。

默认注册了三个过滤器（也通过 `spring.factories` 注册）：

```properties
# META-INF/spring.factories
org.springframework.boot.autoconfigure.AutoConfigurationImportFilter=\
org.springframework.boot.autoconfigure.condition.OnBeanCondition,\
org.springframework.boot.autoconfigure.condition.OnClassCondition,\
org.springframework.boot.autoconfigure.condition.OnWebApplicationCondition
```

`OnClassCondition` 检查配置类上的 `@ConditionalOnClass` 注解——如果某个类不在类路径上，对应的自动配置类在这个过滤阶段就直接排除，不会进入后续的 `ConfigurationClassPostProcessor` 处理流程。

这个优化很关键：Spring Boot 有 100+ 个自动配置类，但一个典型的 Web 应用可能只真正用到其中 20-30 个。通过提前过滤，避免了对大量无用配置类的解析和 `@Conditional` 评估，显著减少了启动时间。

**提前过滤 vs 正式 @Conditional 评估的区别**：

| 阶段 | 时机 | 实现方式 | 目的 |
| --- | --- | --- | --- |
| 提前过滤 | `selectImports()` 期间（BeanDefinition 注册之前） | `AutoConfigurationImportFilter` | 性能优化，快速排除整个配置类 |
| 正式条件评估 | `ConfigurationClassPostProcessor` 处理期间 | `@Conditional`（每个 `@Bean` 方法） | 精确的 Bean 级别条件判断 |

### 6.2 spring.autoconfigure.exclude：排除自动配置

除了 `@EnableAutoConfiguration(exclude = ...)` 的注解方式，Spring Boot 还支持通过配置文件排除：

```yaml
spring:
  autoconfigure:
    exclude:
      - org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration
      - org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

这在以下场景很有用：
- 测试时排除某些自动配置（更常见的做法是使用 `@SpringBootTest(excludeAutoConfiguration = ...)`）；
- 应用需要自己控制某个组件的配置，完全禁用自动配置；
- 调试自动配置冲突问题时，临时排除某些配置类。

---

## 第 7 章 如何调试自动装配

### 7.1 --debug 标志：自动配置报告

启动 Spring Boot 应用时加上 `--debug` 参数（或设置 `debug=true` 属性），会打印详细的自动配置报告（`ConditionEvaluationReport`）：

```
============================
CONDITIONS EVALUATION REPORT
============================

Positive matches:        ← 已装配的自动配置类
-----------------
   AopAutoConfiguration matched:
      - @ConditionalOnProperty (spring.aop.auto=true) matched (OnPropertyCondition)

   DataSourceAutoConfiguration matched:
      - @ConditionalOnClass found required classes 'javax.sql.DataSource',
        'org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType' 
        (OnClassCondition)

Negative matches:        ← 未装配的自动配置类及原因
-----------------
   ActiveMQAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class 
           'jakarta.jms.ConnectionFactory' (OnClassCondition)

   BatchAutoConfiguration:
      Did not match:
         - @ConditionalOnClass did not find required class 
           'org.springframework.batch.core.launch.JobLauncher' (OnClassCondition)

Exclusions:              ← 被显式排除的自动配置类
----------
   None

Unconditional classes:  ← 无条件装配的类
---------------------
   org.springframework.boot.autoconfigure.context.ConfigurationPropertiesAutoConfiguration
```

这个报告是排查自动装配问题的最直接工具。当遇到"为什么 Redis 没有自动装配"或"为什么出现了两个 DataSource"时，首先看这个报告。

### 7.2 @SpringBootTest 中的自动配置控制

测试场景下，可以精确控制哪些自动配置参与：

```java
// 完整的 Spring Boot 测试（所有自动配置都生效）
@SpringBootTest
class FullIntegrationTest { ... }

// 仅测试 Web 层（只加载 Web 相关的自动配置）
@WebMvcTest(OrderController.class)
class OrderControllerTest { ... }

// 仅测试 JPA 层（只加载 JPA 和数据库相关的自动配置）
@DataJpaTest
class OrderRepositoryTest { ... }

// 精确指定使用哪些自动配置类
@SpringBootTest
@ImportAutoConfiguration(classes = {
    RedisAutoConfiguration.class,
    JacksonAutoConfiguration.class
})
class RedisAndJsonTest { ... }
```

---

## 第 8 章 自定义自动配置类的最佳实践

### 8.1 编写一个自动配置类的完整流程

以一个自定义限流组件 `RateLimiter` 的自动配置为例：

```java
// 1. 创建 Properties 类（配置绑定）
@ConfigurationProperties(prefix = "app.rate-limiter")
public class RateLimiterProperties {
    private boolean enabled = true;
    private int qps = 1000;       // 每秒请求上限
    private int burstCapacity = 2000; // 突发容量
    // getters, setters...
}

// 2. 创建自动配置类
@AutoConfiguration
@ConditionalOnClass(RateLimiter.class)   // 类路径上必须有 RateLimiter
@ConditionalOnProperty(
    prefix = "app.rate-limiter",
    name = "enabled",
    havingValue = "true",
    matchIfMissing = true  // 属性不存在时默认装配
)
@EnableConfigurationProperties(RateLimiterProperties.class)
public class RateLimiterAutoConfiguration {
    
    @Bean
    @ConditionalOnMissingBean  // 用户自定义的 RateLimiter 优先
    public RateLimiter rateLimiter(RateLimiterProperties properties) {
        return RateLimiter.create(properties.getQps());
    }
    
    @Bean
    @ConditionalOnMissingBean
    @ConditionalOnBean(RateLimiter.class)
    public RateLimiterInterceptor rateLimiterInterceptor(RateLimiter rateLimiter) {
        return new RateLimiterInterceptor(rateLimiter);
    }
}
```

```java
// 3. 注册自动配置类（Spring Boot 3.x 方式）
// 文件路径：src/main/resources/META-INF/spring/
//          org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.ratelimiter.autoconfigure.RateLimiterAutoConfiguration
```

### 8.2 @AutoConfiguration vs @Configuration 的区别

在 Spring Boot 2.7+ 和 3.x 中，自动配置类应使用 `@AutoConfiguration` 而非普通 `@Configuration`：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Configuration(proxyBeanMethods = false)  // 注意：默认 proxyBeanMethods = false
@AutoConfigureBefore({})
@AutoConfigureAfter({})
public @interface AutoConfiguration {
    // ...
}
```

关键区别：`@AutoConfiguration` 默认 `proxyBeanMethods = false`（轻量配置模式），而普通 `@Configuration` 默认 `proxyBeanMethods = true`（CGLIB 代理，确保 `@Bean` 方法的调用返回单例）。

自动配置类使用 `proxyBeanMethods = false` 的原因：
- 自动配置类中的 `@Bean` 方法之间通常不直接相互调用（依赖通过方法参数注入，而非直接调用）；
- 避免 CGLIB 代理的开销（每个 `@Configuration` 类都需要 CGLIB 增强）；
- 对于有 100+ 自动配置类的 Spring Boot 应用，这个优化有可观的效果。

---

## 第 9 章 spring.factories 的其他用途

`spring.factories` 不只用于自动配置类，还是 Spring Boot 其他 SPI 机制的注册入口：

```properties
# ApplicationContextInitializer：在 ApplicationContext 刷新前执行
org.springframework.context.ApplicationContextInitializer=\
org.springframework.boot.context.ConfigurationWarningsApplicationContextInitializer,\
org.springframework.boot.context.ContextIdApplicationContextInitializer

# ApplicationListener：Spring 应用事件监听器
org.springframework.context.ApplicationListener=\
org.springframework.boot.ClearCachesApplicationListener,\
org.springframework.boot.builder.ParentContextCloserApplicationListener

# SpringApplicationRunListener：SpringApplication.run() 生命周期监听
org.springframework.boot.SpringApplicationRunListener=\
org.springframework.boot.context.event.EventPublishingRunListener

# EnvironmentPostProcessor：在 Environment 准备好后修改它
org.springframework.boot.env.EnvironmentPostProcessor=\
org.springframework.boot.cloud.CloudFoundryVcapEnvironmentPostProcessor,\
org.springframework.boot.env.SpringApplicationJsonEnvironmentPostProcessor,\
org.springframework.boot.env.SystemEnvironmentPropertySourceEnvironmentPostProcessor

# AutoConfigurationImportFilter：自动配置类的提前过滤
org.springframework.boot.autoconfigure.AutoConfigurationImportFilter=\
org.springframework.boot.autoconfigure.condition.OnBeanCondition,\
org.springframework.boot.autoconfigure.condition.OnClassCondition,\
org.springframework.boot.autoconfigure.condition.OnWebApplicationCondition
```

这些注册类型共同构成了 Spring Boot 的"开放-封闭"扩展体系——用户无需修改 Spring Boot 源码，只需在自己的 jar 包中添加 `META-INF/spring.factories` 文件，就能注入自定义的初始化器、监听器、自动配置类等。这也是 Spring Cloud、各种第三方 Starter 能与 Spring Boot 无缝集成的技术基础。

---

## 总结

本文完整剖析了 Spring Boot 自动装配机制的设计思想与实现细节：

- **核心链路**：`@EnableAutoConfiguration` → `AutoConfigurationImportSelector`（`DeferredImportSelector`）→ `getCandidateConfigurations()` → `SpringFactoriesLoader`（扫描 `META-INF/spring.factories`）→ 过滤 → 注册 `BeanDefinition`；
- **DeferredImportSelector 的语义**：延迟到所有用户配置类处理完毕后再执行，确保"用户配置优先于自动配置"；
- **自动配置类的结构**：`@ConditionalOnClass`（类路径条件）+ `@ConditionalOnMissingBean`（用户覆盖机制）+ `@EnableConfigurationProperties`（配置绑定）是标准三件套；
- **排序机制**：`@AutoConfigureOrder`（全局顺序）+ `@AutoConfigureBefore/After`（相对顺序）确保配置类按正确顺序处理；
- **Spring Boot 3.x 变化**：自动配置类迁移到 `AutoConfiguration.imports`，`@AutoConfiguration` 注解合并了排序属性，默认 `proxyBeanMethods = false`；
- **调试手段**：`--debug` 参数打印 `ConditionEvaluationReport`，快速定位装配问题。

下一篇，我们将深入条件注解体系，系统梳理 `@Conditional` 家族的所有成员及其实现机制：[[03 条件装配——@Conditional家族的实现机制]]。

---

> [!note] 参考资料
> - `org.springframework.boot.autoconfigure.AutoConfigurationImportSelector` 源码
> - `org.springframework.core.io.support.SpringFactoriesLoader` 源码
> - `org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration` 源码
> - [Spring Boot 官方文档 - Auto-configuration](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.developing-auto-configuration)

---

> [!note] 思考题
> 1. `SpringApplication.run()` 的启动流程包括：创建 ApplicationContext、加载 BeanDefinition、刷新容器（`refresh()`）、调用 Runner。在 `refresh()` 阶段，如果某个 Bean 的初始化失败（抛出异常），Spring Boot 会尝试优雅关闭已创建的资源吗？还是直接崩溃退出？
> 2. Spring Boot 的 `ApplicationRunner` 和 `CommandLineRunner` 在容器就绪后执行。如果你需要在所有 Bean 初始化完成后、但在接收 HTTP 请求前执行一些初始化逻辑（如缓存预热），应该使用哪种机制？`@PostConstruct`、`InitializingBean`、`ApplicationRunner` 和 `SmartLifecycle` 的执行时机有什么区别？
> 3. Spring Boot 的'优雅停机'（Graceful Shutdown）在收到 SIGTERM 后等待正在处理的请求完成再关闭。`server.shutdown=graceful` 配置了优雅停机，`spring.lifecycle.timeout-per-shutdown-phase` 设置了超时时间。如果某个请求一直不结束（如长轮询），超时后会强制中断该请求吗？线程中断是否能可靠地终止正在执行的数据库事务？
