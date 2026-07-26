---
title: "插件机制——Interceptor的责任链模式与分页插件原理"
date: 2026-03-04
tags: [Interceptor, InterceptorChain, Java, Mybatis, PageHelper, 分页, 动态代理, 四大核心对象, 插件, 责任链模式]
aliases: []
---

# 插件机制——Interceptor的责任链模式与分页插件原理

## 摘要

Mybatis 的插件（Plugin）机制是其扩展性最强的设计之一，允许开发者在不修改框架源码的前提下，对 SQL 执行链路的关键节点进行拦截和增强。其底层实现基于 JDK 动态代理，通过对 `Executor`、`StatementHandler`、`ParameterHandler`、`ResultSetHandler` 四大核心对象进行包装，形成一条层层嵌套的责任链。本文从插件的注解定义、注册机制、代理链的构建过程讲起，深入剖析 `Plugin.wrap()` 的动态代理实现，并以 PageHelper 分页插件为例，完整还原"查询前拦截 → SQL 改写 → count 查询 → 分页 SQL 执行"的全链路原理，让你彻底理解"分页插件是怎么知道要对哪条 SQL 加 LIMIT 的"这个经典问题。

---

## 第 1 章 插件机制的设计动机

### 1.1 框架扩展的两种范式

任何成熟框架都需要考虑如何在不修改核心代码的前提下支持扩展。常见的两种范式：

**范式一：回调/钩子（Callback/Hook）**

在框架执行流程的关键节点预留"钩子"，允许外部代码注入回调逻辑。Spring 的 `BeanPostProcessor`、`BeanFactoryPostProcessor` 就是典型代表——框架在 Bean 创建的特定阶段调用这些接口的实现。

这种方式的优点是显式、类型安全；缺点是只能在预定义的钩子点扩展，灵活性有限。

**范式二：拦截器（Interceptor）+ 动态代理**

将核心对象整体替换为代理对象，代理对象可以拦截任意方法调用，在调用前后插入任意逻辑。AOP 就是这种范式的极致表达。

Mybatis 选择了第二种范式，针对其核心执行链路中的四大对象，提供了一套基于动态代理的拦截器机制。相比于 Spring AOP 的通用性，Mybatis 插件机制更加聚焦——**只能拦截指定的四个类的指定方法**，这既是约束，也是简洁性的来源。

### 1.2 四大可拦截对象

Mybatis 插件能够拦截的四个核心接口及其典型方法：

| 接口 | 可拦截方法 | 典型应用场景 |
| --- | --- | --- |
| `Executor` | `query`、`update`、`commit`、`rollback`、`close` | 分页（改写 SQL）、读写分离路由、SQL 审计日志、慢 SQL 监控 |
| `StatementHandler` | `prepare`、`parameterize`、`query`、`update`、`batch` | SQL 改写（加表前缀/租户隔离）、打印完整 SQL（含参数值）|
| `ParameterHandler` | `setParameters` | 参数加密/解密，自动注入公共参数（如 tenant_id）|
| `ResultSetHandler` | `handleResultSets` | 结果集字段脱敏（手机号、身份证号），自动解密 |

选择在哪个层面拦截，需要根据业务需求权衡：
- 需要改写最终 SQL？拦截 `StatementHandler.prepare()`（此时 SQL 已确定，还未发送给 JDBC）；
- 需要分页（改写 SQL + 额外 count 查询）？拦截 `Executor.query()`（此时可以拿到完整上下文，便于执行额外查询）；
- 需要参数级加解密？拦截 `ParameterHandler.setParameters()`；
- 需要结果集级处理？拦截 `ResultSetHandler.handleResultSets()`。

---

## 第 2 章 插件的定义与注册

### 2.1 @Intercepts 与 @Signature：声明拦截目标

每个 Mybatis 插件必须实现 `Interceptor` 接口，并通过 `@Intercepts` 注解声明要拦截的具体方法：

```java
@Intercepts({
    @Signature(
        type = Executor.class,       // 要拦截的接口类型
        method = "query",            // 要拦截的方法名
        args = {                     // 方法的参数类型列表（用于区分方法重载）
            MappedStatement.class,
            Object.class,
            RowBounds.class,
            ResultHandler.class
        }
    )
})
public class MyQueryInterceptor implements Interceptor {
    
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        // invocation.getTarget()：被代理的原始对象（Executor 实例）
        // invocation.getMethod()：被拦截的方法（Executor.query）
        // invocation.getArgs()：方法的参数数组
        
        // 在 SQL 执行前的逻辑（前置处理）
        long startTime = System.currentTimeMillis();
        
        // 调用被拦截方法（如果不调用，则完全替代原方法）
        Object result = invocation.proceed();
        
        // 在 SQL 执行后的逻辑（后置处理）
        long elapsed = System.currentTimeMillis() - startTime;
        if (elapsed > 1000) {
            // 慢 SQL 告警
            MappedStatement ms = (MappedStatement) invocation.getArgs()[0];
            System.out.println("慢 SQL: " + ms.getId() + " 耗时 " + elapsed + "ms");
        }
        
        return result;
    }
    
    @Override
    public Object plugin(Object target) {
        // 默认实现：用 Plugin.wrap() 对目标对象进行代理
        // 内部会检查 target 是否是 @Intercepts 声明的拦截目标，是则包装，否则直接返回
        return Plugin.wrap(target, this);
    }
    
    @Override
    public void setProperties(Properties properties) {
        // 从 mybatis-config.xml 中的 <plugin> 标签读取配置属性
        // <plugin interceptor="...">
        //     <property name="threshold" value="1000"/>
        // </plugin>
        String threshold = properties.getProperty("threshold", "1000");
    }
}
```

### 2.2 多方法拦截

`@Intercepts` 可以包含多个 `@Signature`，同时拦截多个方法：

```java
@Intercepts({
    @Signature(
        type = Executor.class,
        method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}
    ),
    @Signature(
        type = Executor.class,
        method = "query",
        // 拦截另一个重载：带 CacheKey 和 BoundSql 参数的 query 方法
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class, CacheKey.class, BoundSql.class}
    ),
    @Signature(
        type = Executor.class,
        method = "update",
        args = {MappedStatement.class, Object.class}
    )
})
public class AuditInterceptor implements Interceptor {
    // 同时拦截 query 和 update，记录所有 SQL 执行情况
}
```

### 2.3 插件注册

在 `mybatis-config.xml` 中注册插件：

```xml
<plugins>
    <!-- 按声明顺序注册，后声明的插件包装在外层（最先执行） -->
    <plugin interceptor="com.example.plugin.AuditInterceptor">
        <property name="logLevel" value="INFO"/>
    </plugin>
    <plugin interceptor="com.github.pagehelper.PageInterceptor">
        <property name="helperDialect" value="mysql"/>
        <property name="reasonable" value="true"/>
    </plugin>
</plugins>
```

在 Spring Boot + Mybatis-Spring-Boot-Starter 中，只需将 `Interceptor` 的实现类注册为 Spring Bean，即可自动被扫描注册：

```java
@Bean
public PageInterceptor pageInterceptor() {
    PageInterceptor interceptor = new PageInterceptor();
    Properties props = new Properties();
    props.setProperty("helperDialect", "mysql");
    interceptor.setProperties(props);
    return interceptor;
}
```

---

## 第 3 章 InterceptorChain：责任链的构建与执行

### 3.1 InterceptorChain 的结构

`InterceptorChain` 是插件链的管理器，它持有所有注册的 `Interceptor`，并在 Mybatis 初始化时完成插件链的构建：

```java
public class InterceptorChain {
    // 按注册顺序存储所有 Interceptor
    private final List<Interceptor> interceptors = new ArrayList<>();
    
    // 注册一个 Interceptor
    public void addInterceptor(Interceptor interceptor) {
        interceptors.add(interceptor);
    }
    
    // 对目标对象应用所有插件（构建代理链）
    // target：要包装的原始对象（Executor/StatementHandler/ParameterHandler/ResultSetHandler 实例）
    public Object pluginAll(Object target) {
        for (Interceptor interceptor : interceptors) {
            // 每个 Interceptor 的 plugin() 方法可能返回原对象（不匹配时）
            // 或返回一个代理对象（匹配时）
            target = interceptor.plugin(target);
        }
        return target;
    }
    
    public List<Interceptor> getInterceptors() {
        return Collections.unmodifiableList(interceptors);
    }
}
```

`pluginAll()` 在 `Configuration.newExecutor()` 等方法中被调用：

```java
// Configuration.java 中的核心创建方法
public Executor newExecutor(Transaction transaction, ExecutorType executorType) {
    // 1. 创建基础 Executor
    Executor executor = new SimpleExecutor(this, transaction);
    if (cacheEnabled) {
        executor = new CachingExecutor(executor);
    }
    // 2. 对 Executor 应用所有插件（构建代理链）
    executor = (Executor) interceptorChain.pluginAll(executor);
    return executor;
}

public StatementHandler newStatementHandler(...) {
    StatementHandler statementHandler = new RoutingStatementHandler(executor, ms, ...);
    // 对 StatementHandler 应用所有插件
    statementHandler = (StatementHandler) interceptorChain.pluginAll(statementHandler);
    return statementHandler;
}

// ParameterHandler 和 ResultSetHandler 同理
```

### 3.2 Plugin.wrap()：JDK 动态代理的封装

`Plugin` 类是 Mybatis 对 JDK 动态代理的封装，实现了 `InvocationHandler`：

```java
public class Plugin implements InvocationHandler {
    private final Object target;           // 被代理的原始对象
    private final Interceptor interceptor; // 对应的拦截器
    // 解析 @Intercepts 注解，构建"类型 → 方法集合"的映射
    private final Map<Class<?>, Set<Method>> signatureMap;
    
    private Plugin(Object target, Interceptor interceptor, 
                   Map<Class<?>, Set<Method>> signatureMap) {
        this.target = target;
        this.interceptor = interceptor;
        this.signatureMap = signatureMap;
    }
    
    // 核心静态方法：对 target 进行代理包装
    public static Object wrap(Object target, Interceptor interceptor) {
        // 1. 解析 @Intercepts 注解，得到"类型 → 方法集合"映射
        Map<Class<?>, Set<Method>> signatureMap = getSignatureMap(interceptor);
        
        // 2. 获取 target 的实际类型及其实现的所有接口
        Class<?> type = target.getClass();
        Class<?>[] interfaces = getAllInterfaces(type, signatureMap);
        
        // 3. 如果 target 实现了 signatureMap 中的某些接口，才需要代理
        if (interfaces.length > 0) {
            // 创建 JDK 动态代理对象
            // 代理对象实现 interfaces 中的所有接口
            return Proxy.newProxyInstance(
                type.getClassLoader(),
                interfaces,
                new Plugin(target, interceptor, signatureMap));
        }
        
        // target 不是拦截目标：直接返回原对象，不包装
        return target;
    }
    
    // 代理对象的方法调用都会路由到这里
    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        try {
            // 检查被调用的方法是否在 signatureMap 中（即是否是拦截目标方法）
            Set<Method> methods = signatureMap.get(method.getDeclaringClass());
            if (methods != null && methods.contains(method)) {
                // 是拦截目标：调用拦截器的 intercept() 方法
                return interceptor.intercept(new Invocation(target, method, args));
            }
            // 不是拦截目标：直接调用原始方法
            return method.invoke(target, args);
        } catch (Exception e) {
            throw ExceptionUtil.unwrapThrowable(e);
        }
    }
    
    // 解析 @Intercepts 注解
    private static Map<Class<?>, Set<Method>> getSignatureMap(Interceptor interceptor) {
        Intercepts interceptsAnnotation = interceptor.getClass().getAnnotation(Intercepts.class);
        if (interceptsAnnotation == null) {
            throw new PluginException("No @Intercepts annotation was found in interceptor "
                + interceptor.getClass().getName());
        }
        Signature[] sigs = interceptsAnnotation.value();
        Map<Class<?>, Set<Method>> signatureMap = new HashMap<>();
        for (Signature sig : sigs) {
            // 从 sig.type() 接口中查找 sig.method() 指定的方法
            Set<Method> methods = MapUtil.computeIfAbsent(signatureMap, sig.type(), k -> new HashSet<>());
            try {
                Method method = sig.type().getMethod(sig.method(), sig.args());
                methods.add(method);
            } catch (NoSuchMethodException e) {
                throw new PluginException("Could not find method on " + sig.type() + " named " + sig.method() + "...", e);
            }
        }
        return signatureMap;
    }
}
```

### 3.3 代理链的结构与执行顺序

假设注册了 3 个插件（A、B、C，按此顺序注册），对 `Executor` 的包装过程：

```
初始对象：SimpleExecutor（被 CachingExecutor 装饰）

pluginAll() 执行顺序（按注册顺序）：
1. A.plugin(executor) → Proxy_A（包装 executor）
2. B.plugin(Proxy_A)  → Proxy_B（包装 Proxy_A）
3. C.plugin(Proxy_B)  → Proxy_C（包装 Proxy_B）

最终暴露给 SqlSession 的是 Proxy_C
```

**调用顺序**：当 SQL 执行时，调用链从外到内：

```
Proxy_C.invoke() → C.intercept()
    Proxy_B.invoke() → B.intercept()
        Proxy_A.invoke() → A.intercept()
            CachingExecutor.query()（真正执行）
        ← A 的后置逻辑
    ← B 的后置逻辑
← C 的后置逻辑
```

**结论**：后注册的插件包装在外层，先执行前置逻辑，后执行后置逻辑。这与 Spring AOP 的切面执行顺序类似（外层 `@Around` 先于内层执行）。

> [!info] 插件顺序的重要性
> 插件的注册顺序对行为有直接影响。以分页插件（PageHelper）和 SQL 审计插件为例：
> - 如果分页插件在外层（后注册）：审计插件记录的是原始 SQL（不含 LIMIT），分页插件改写 SQL 后再执行；
> - 如果审计插件在外层（后注册）：审计插件记录的是已被 PageHelper 改写后的分页 SQL（含 LIMIT）。
>
> 通常希望审计记录的是最终执行的 SQL，所以应该让审计插件在最外层——即**最后注册**。

---

## 第 4 章 Invocation：拦截器的执行上下文

`Invocation` 封装了被拦截方法的完整上下文：

```java
public class Invocation {
    private final Object target;    // 被代理的原始对象
    private final Method method;    // 被拦截的方法
    private final Object[] args;    // 方法参数
    
    // 继续执行被拦截的方法（可能调用更内层的拦截器，或最终调用原始方法）
    public Object proceed() throws InvocationTargetException, IllegalAccessException {
        return method.invoke(target, args);
    }
}
```

在插件的 `intercept()` 方法中，可以通过 `Invocation` 做到：

1. **在方法执行前修改参数**：`invocation.getArgs()[0]` 获取参数，修改后再 `proceed()`；
2. **在方法执行后修改返回值**：`Object result = invocation.proceed()`，修改 `result` 后返回；
3. **完全替代原方法**：不调用 `invocation.proceed()`，直接返回自定义结果；
4. **执行额外的数据库操作**：在 `proceed()` 前后，用 `target`（Executor 实例）执行额外的 SQL。

---

## 第 5 章 PageHelper 分页插件：完整实现剖析

### 5.1 分页的本质难题

在数据库层面，分页查询需要修改 SQL 语句：
- MySQL：`SELECT * FROM users LIMIT offset, pageSize`；
- Oracle：`SELECT * FROM (SELECT t.*, ROWNUM rn FROM (...) t WHERE ROWNUM <= endRow) WHERE rn > startRow`；
- PostgreSQL：`SELECT * FROM users LIMIT pageSize OFFSET offset`；
- SQL Server：`SELECT * FROM users ORDER BY id OFFSET offset ROWS FETCH NEXT pageSize ROWS ONLY`。

不同数据库的分页语法差异巨大。如果让业务代码直接写分页 SQL，一旦切换数据库就要全部修改，耦合度极高。

同时，分页查询通常还需要一个 `COUNT(*)` 查询来获取总记录数，用于计算总页数。两个 SQL 的业务逻辑完全一样，只是一个查数据，一个查总数——如果都要手写，代码冗余。

PageHelper 的目标：**通过拦截器在框架层自动完成 SQL 改写和 count 查询，业务代码只需关心业务逻辑**。

### 5.2 PageHelper 的使用方式

```java
// 业务代码（极其简洁）
@Service
public class UserService {
    @Autowired
    private UserMapper userMapper;
    
    public PageInfo<User> getUsers(int pageNum, int pageSize) {
        // 在查询前调用 PageHelper.startPage()，设置分页参数
        // 这一行会将分页信息存入 ThreadLocal
        PageHelper.startPage(pageNum, pageSize);
        
        // 紧随其后的第一条查询，会被 PageHelper 自动拦截并加上分页
        List<User> users = userMapper.selectAll();
        // 注意：此时 users 实际上是 Page<User> 类型（Page 继承 ArrayList）
        
        // PageInfo 包含数据列表、总记录数、总页数、当前页等所有分页信息
        return new PageInfo<>(users);
    }
}
```

背后的黑魔法：`PageHelper.startPage()` 将分页参数存入 `ThreadLocal`，PageHelper 的拦截器在 `query()` 调用时检查 `ThreadLocal`，发现有分页参数就自动改写 SQL。

### 5.3 PageInterceptor 的完整实现逻辑

PageHelper 的核心是 `PageInterceptor`，拦截 `Executor.query()` 方法：

```java
@Intercepts({
    @Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}),
    @Signature(type = Executor.class, method = "query",
        args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class,
                CacheKey.class, BoundSql.class})
})
public class PageInterceptor implements Interceptor {
    
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        try {
            // 提取被拦截方法的参数
            Object[] args = invocation.getArgs();
            MappedStatement ms = (MappedStatement) args[0];
            Object parameter = args[1];
            RowBounds rowBounds = (RowBounds) args[2];
            ResultHandler resultHandler = (ResultHandler) args[3];
            
            // 获取当前 Executor（代理链的下一层）
            Executor executor = (Executor) invocation.getTarget();
            
            BoundSql boundSql;
            CacheKey cacheKey;
            if (args.length == 4) {
                // 4 参数版本的 query
                boundSql = ms.getBoundSql(parameter);
                cacheKey = executor.createCacheKey(ms, parameter, rowBounds, boundSql);
            } else {
                // 6 参数版本的 query
                cacheKey = (CacheKey) args[4];
                boundSql = (BoundSql) args[5];
            }
            
            // 关键：检查 ThreadLocal 中是否有分页参数
            // PageHelper.startPage() 将分页信息存在 ThreadLocal<Page> 中
            if (!dialect.skip(ms, parameter, rowBounds)) {
                // 有分页参数，进入分页处理流程
                
                // 步骤一：执行 COUNT 查询（获取总记录数）
                Long count = null;
                if (dialect.beforeCount(ms, parameter, rowBounds)) {
                    // 基于原始 SQL 构建 count SQL：
                    // SELECT COUNT(*) FROM (原始 SELECT) tmp_count
                    // 或者更智能地去除 ORDER BY、SELECT 列改写等
                    count = executeAutoCount(executor, ms, parameter, boundSql, rowBounds, resultHandler);
                    // 将总记录数设置到 Page 对象（ThreadLocal 中）
                    dialect.afterCount(count, parameter, rowBounds);
                    
                    // 如果 count == 0，不需要执行数据查询
                    if (!dialect.afterCount(count, parameter, rowBounds)) {
                        return dialect.afterPage(new ArrayList(), parameter, rowBounds);
                    }
                }
                
                // 步骤二：改写分页 SQL
                // 根据数据库方言，在原始 SQL 外层包装分页逻辑
                // MySQL: "原始SQL LIMIT #{offset}, #{pageSize}"
                // Oracle: "SELECT * FROM (原始SQL) t WHERE ROWNUM <= endRow) WHERE rn > startRow"
                BoundSql pageBoundSql = dialect.getPageBoundSql(ms, boundSql, parameter, rowBounds);
                
                // 步骤三：用改写后的 BoundSql 执行实际的分页查询
                // 构建新的 MappedStatement（包含改写后的 SqlSource）
                MappedStatement pageMappedStatement = buildMappedStatement(ms, new BoundSqlSqlSource(pageBoundSql));
                
                // 替换 args 中的 MappedStatement 和 BoundSql
                args[0] = pageMappedStatement;
                if (args.length == 6) {
                    args[5] = pageBoundSql;
                    // 重新生成 cacheKey（因为 SQL 改变了）
                    args[4] = executor.createCacheKey(pageMappedStatement, parameter, 
                                                       rowBounds, pageBoundSql);
                }
                
                // 执行分页查询
                List resultList = (List) invocation.proceed();
                
                // 步骤四：将查询结果和分页信息合并，返回 Page 对象
                return dialect.afterPage(resultList, parameter, rowBounds);
            }
            
            // 没有分页参数：直接执行原始查询
            return invocation.proceed();
        } finally {
            // 清理 ThreadLocal（防止内存泄漏和错误复用）
            dialect.afterAll();
        }
    }
}
```

### 5.4 ThreadLocal 的使用与风险

PageHelper 使用 `ThreadLocal<Page>` 在 `startPage()` 和拦截器之间传递分页参数：

```java
// PageHelper.startPage() 的简化实现
public static <E> Page<E> startPage(int pageNum, int pageSize) {
    Page<E> page = new Page<>(pageNum, pageSize);
    // 将分页参数存入当前线程的 ThreadLocal
    PageMethod.setLocalPage(page);
    return page;
}

// 拦截器中读取
protected static ThreadLocal<Page> LOCAL_PAGE = new ThreadLocal<>();

public static <T> Page<T> getLocalPage() {
    return LOCAL_PAGE.get();
}

public static void clearPage() {
    LOCAL_PAGE.remove();
}
```

> [!warning] PageHelper 的两大经典陷阱
>
> **陷阱一：startPage 与查询不紧邻**
>
> `PageHelper.startPage()` 和紧随其后的 **第一条** 查询语句会被分页，第二条及之后的查询不受影响。如果在 `startPage()` 和目标查询之间有其他查询语句，分页会错误地应用到那条中间查询上：
>
> ```java
> PageHelper.startPage(1, 10);
> // ❌ 错误：这里有一条额外查询，分页会应用到这里！
> int count = userMapper.countActiveUsers();
> // 原本想分页的查询反而没有分页
> List<User> users = userMapper.selectAll();
> ```
>
> **正确写法**：`startPage()` 必须紧接目标查询：
> ```java
> PageHelper.startPage(1, 10);
> List<User> users = userMapper.selectAll();  // 紧随其后，这条 SQL 被分页
> ```
>
> **陷阱二：ThreadLocal 未清理导致内存泄漏**
>
> 如果查询过程中抛出异常，`finally` 块中的 `afterAll()`（调用 `clearPage()`）可能不会执行，导致 `ThreadLocal` 中的 `Page` 对象残留。在线程池复用线程的场景下（如 Web 应用的请求处理线程），下一个请求可能意外地被上一个请求的分页参数影响。
>
> PageHelper 的 `intercept()` 用 `try-finally` 包裹了 `afterAll()`，通常能正确清理。但如果在拦截器执行路径之外调用了 `startPage()`（如异步线程、非 Mybatis 查询），就需要手动 `PageHelper.clearPage()`。

### 5.5 COUNT 查询的 SQL 生成策略

PageHelper 的 count SQL 生成有两种策略：

**策略一：简单包装（默认）**

```sql
-- 原始 SQL
SELECT u.id, u.name, u.email, o.amount
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.status = 'ACTIVE'
ORDER BY u.created_at DESC

-- 生成的 count SQL（简单包装，大多数情况有效）
SELECT COUNT(0) FROM (
    SELECT u.id, u.name, u.email, o.amount
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE u.status = 'ACTIVE'
    ORDER BY u.created_at DESC
) tmp_count
```

**策略二：智能化处理（BoundSqlSqlSource 改写）**

PageHelper 的智能 count 会尝试：
1. 去除 `ORDER BY` 子句（count 不需要排序，去除后性能更好）；
2. 简化 `SELECT` 列表为 `COUNT(*)`（如果没有 DISTINCT 或 GROUP BY）；
3. 对于有 `GROUP BY` 的查询，保留内层 SQL 的结构。

```sql
-- 改写后的 count SQL（智能版本）
SELECT COUNT(0) FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.status = 'ACTIVE'
-- ORDER BY 被去除
```

---

## 第 6 章 自定义插件实战：租户隔离

### 6.1 多租户隔离的核心挑战

在 SaaS 系统中，多个租户共用同一套数据库和代码，需要确保每个租户只能查询/修改自己的数据。最简单的做法是每张表加 `tenant_id` 列，并在每条 SQL 的 WHERE 子句中加上 `AND tenant_id = ?`。

但手动在每个 Mapper 方法的 SQL 中加 `tenant_id` 条件有两个问题：一是工作量巨大（每条 SQL 都要改），二是遗漏风险高（新人加的 SQL 可能忘了加）。

Mybatis 插件可以在 `StatementHandler.prepare()` 阶段自动改写 SQL，注入 `tenant_id` 条件：

```java
@Intercepts({
    @Signature(type = StatementHandler.class, method = "prepare",
               args = {Connection.class, Integer.class})
})
public class TenantInterceptor implements Interceptor {
    
    // 不需要过滤的表（系统级别的表，所有租户共享）
    private static final Set<String> EXCLUDED_TABLES = Set.of("sys_config", "sys_dict");
    
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        StatementHandler statementHandler = (StatementHandler) invocation.getTarget();
        
        // 使用 MetaObject 访问 StatementHandler 内部字段
        // StatementHandler 是代理对象，需要用 SystemMetaObject.forObject() 穿透代理
        MetaObject metaObject = SystemMetaObject.forObject(statementHandler);
        
        // 获取当前执行的 MappedStatement（判断是否是 SELECT/INSERT/UPDATE/DELETE）
        MappedStatement mappedStatement = (MappedStatement) metaObject.getValue("delegate.mappedStatement");
        
        // 只处理 SELECT 语句（INSERT/UPDATE/DELETE 通常由业务代码负责加 tenant_id）
        if (mappedStatement.getSqlCommandType() != SqlCommandType.SELECT) {
            return invocation.proceed();
        }
        
        // 获取当前要执行的 BoundSql（含有最终 SQL 字符串）
        BoundSql boundSql = (BoundSql) metaObject.getValue("delegate.boundSql");
        String originalSql = boundSql.getSql();
        
        // 解析 SQL，判断涉及的表是否需要租户隔离
        // 这里用简化逻辑，实际生产需要 SQL 解析器（如 JSqlParser）
        if (requiresTenantFilter(originalSql)) {
            // 获取当前租户 ID（从 ThreadLocal 或 SecurityContext 中获取）
            Long tenantId = TenantContext.getCurrentTenantId();
            if (tenantId != null) {
                // 改写 SQL：在 WHERE 子句后追加 tenant_id 条件
                String newSql = appendTenantCondition(originalSql, tenantId);
                // 将改写后的 SQL 写回 BoundSql
                metaObject.setValue("delegate.boundSql.sql", newSql);
            }
        }
        
        return invocation.proceed();
    }
    
    private boolean requiresTenantFilter(String sql) {
        // 检查 SQL 中是否包含需要隔离的表
        // 生产中建议用 JSqlParser 解析 SQL AST，而非简单字符串匹配
        String upperSql = sql.toUpperCase();
        for (String excludedTable : EXCLUDED_TABLES) {
            if (!upperSql.contains(excludedTable.toUpperCase())) {
                return true;
            }
        }
        return false;
    }
    
    private String appendTenantCondition(String sql, Long tenantId) {
        // 简化示例：在 WHERE 后追加条件
        // 生产中需要用 JSqlParser 正确处理各种 SQL 结构
        if (sql.toUpperCase().contains("WHERE")) {
            return sql + " AND tenant_id = " + tenantId;
        } else {
            return sql + " WHERE tenant_id = " + tenantId;
        }
    }
    
    @Override
    public Object plugin(Object target) {
        return Plugin.wrap(target, this);
    }
}
```

> [!warning] 直接字符串拼接 SQL 的危险
> 上述 `appendTenantCondition()` 的简单字符串拼接方案在 SQL 结构复杂时会失效（如 UNION、子查询、CTE 等）。生产级方案应使用 **JSqlParser** 等 SQL 解析库，将 SQL 解析为 AST（抽象语法树），在正确的位置注入条件，然后再生成 SQL 字符串。
>
> ```xml
> <dependency>
>     <groupId>com.github.jsqlparser</groupId>
>     <artifactId>jsqlparser</artifactId>
>     <version>4.7</version>
> </dependency>
> ```

---

## 第 7 章 插件开发的注意事项与性能影响

### 7.1 谨慎使用 MetaObject 穿透代理

由于 `StatementHandler` 等对象可能已经被多个插件代理，直接 `(StatementHandler) invocation.getTarget()` 得到的是代理对象，无法直接访问其内部字段。需要用 `SystemMetaObject.forObject()` 穿透所有代理层：

```java
// 穿透代理，获取最终的原始 StatementHandler
StatementHandler statementHandler = (StatementHandler) invocation.getTarget();
MetaObject metaObject = SystemMetaObject.forObject(statementHandler);

// 对于 RoutingStatementHandler（Mybatis 内部使用），需要先获取 delegate
// 方式一：通过 MetaObject 路径访问
MappedStatement ms = (MappedStatement) metaObject.getValue("delegate.mappedStatement");
BoundSql boundSql = (BoundSql) metaObject.getValue("delegate.boundSql");

// 方式二：直接解包（如果明确知道层次结构）
while (metaObject.hasGetter("h")) {
    // JDK 代理：通过 h 字段获取 InvocationHandler（即 Plugin）
    Object object = metaObject.getValue("h");
    metaObject = SystemMetaObject.forObject(object);
}
while (metaObject.hasGetter("target")) {
    // Plugin 有 target 字段指向被包装对象
    Object object = metaObject.getValue("target");
    metaObject = SystemMetaObject.forObject(object);
}
```

### 7.2 不要在插件中做阻塞操作

插件拦截器运行在执行 SQL 的线程中，如果在插件中做耗时操作（如调用远程服务、写文件），会直接增加每次 SQL 执行的响应时间。对于审计日志等非核心操作，应该**异步处理**：

```java
// 异步 SQL 审计插件
@Override
public Object intercept(Invocation invocation) throws Throwable {
    Object result = invocation.proceed();
    
    // 异步记录审计日志，不阻塞当前线程
    final String sqlId = ((MappedStatement) invocation.getArgs()[0]).getId();
    auditExecutor.submit(() -> {
        auditLogService.log(sqlId, ...);
    });
    
    return result;
}
```

### 7.3 插件的性能开销

JDK 动态代理的方法调用有微小的额外开销（通过反射调用，比直接调用慢约 2-5 倍）。对于每秒执行几万次 SQL 的高并发系统，每个插件增加的延迟约为 1-2 微秒（μs），通常可以忽略。但如果插件本身的逻辑较重（如复杂 SQL 解析、锁等待），则需要仔细评估。

---

## 总结

Mybatis 插件机制是一个精心设计的扩展框架：

- **设计思路**：对四大核心对象（`Executor`/`StatementHandler`/`ParameterHandler`/`ResultSetHandler`）进行 JDK 动态代理包装，形成责任链；每个插件的 `intercept()` 可以在方法执行前后插入逻辑，也可以修改参数和返回值；
- **核心组件**：`@Intercepts`/`@Signature` 注解声明拦截目标；`InterceptorChain.pluginAll()` 在对象创建时构建代理链；`Plugin.wrap()` 执行 JDK 动态代理；`Plugin.invoke()` 分发方法调用（是拦截目标 → 调用 `intercept()`，否则 → 调用原始方法）；
- **注册顺序决定执行顺序**：后注册的插件包装在外层，其前置逻辑最先执行，后置逻辑最后执行；
- **PageHelper 原理**：拦截 `Executor.query()`，通过 `ThreadLocal<Page>` 传递分页参数，自动执行 count SQL 和改写分页 SQL，最终返回含分页信息的 `Page` 对象；核心陷阱是 `startPage()` 与目标查询之间不能插入其他查询；
- **实战建议**：生产 SQL 改写推荐使用 JSqlParser 解析 AST；插件中避免阻塞操作；注意 `MetaObject` 穿透代理的写法；异步处理审计等非核心逻辑。

下一篇，深入 Mapper 接口的代理实现机制——`MapperProxy` 如何拦截接口方法调用，`MapperMethod` 如何分析方法签名并映射到 SqlSession 操作：[[08 Mapper接口的代理实现——MapperProxy与MapperMethod]]。

---

> [!note] 参考资料
> - `org.apache.ibatis.plugin.Plugin` 源码
> - `org.apache.ibatis.plugin.InterceptorChain` 源码
> - [PageHelper GitHub](https://github.com/pagehelper/Mybatis-PageHelper)
> - [Mybatis 官方文档 - Plugins](https://mybatis.org/mybatis-3/configuration.html#plugins)

---

> [!note] 思考题
> 1. MyBatis 的插件机制允许拦截 Executor、StatementHandler、ParameterHandler 和 ResultSetHandler 四大接口的方法调用。底层通过 JDK 动态代理实现。如果多个插件拦截同一个方法，它们的执行顺序由什么决定？内层代理先执行还是外层代理先执行？
> 2. 分页插件（如 PageHelper）的核心原理是拦截 Executor 的 query 方法，修改 SQL 为 `SELECT ... LIMIT offset, size`，并额外执行一条 `SELECT COUNT(*) ...` 获取总数。在深分页场景（offset=1000000）中，LIMIT 的性能会急剧下降。分页插件有能力自动优化为'游标分页'（基于上一页最后一条的 ID）吗？还是必须由用户手动改写查询？
> 3. MyBatis 插件可以修改 SQL 文本、替换参数、甚至修改返回结果。在一个多租户系统中，插件自动为所有 SQL 追加 `AND tenant_id = #{tenantId}` 条件。这种'透明租户隔离'的方案在什么场景下会失败（如子查询、UNION、EXISTS 等复杂 SQL）？
