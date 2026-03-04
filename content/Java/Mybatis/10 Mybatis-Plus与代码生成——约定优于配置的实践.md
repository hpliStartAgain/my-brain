---
title: "Mybatis-Plus与代码生成——约定优于配置的实践"
date: 2026-03-04
tags: [Java, Mybatis, MybatisPlus, BaseMapper, IService, LambdaQueryWrapper, 代码生成, AutoFill, 逻辑删除, 乐观锁]
aliases: []
---

# Mybatis-Plus与代码生成——约定优于配置的实践

## 摘要

Mybatis-Plus（简称 MP）是 Mybatis 的增强工具，在不修改 Mybatis 源码的前提下，通过扩展 `BaseMapper` 接口和注入通用 CRUD 方法，实现了"零 XML、零注解写 70% 的 CRUD 操作"的目标。本文系统讲解 Mybatis-Plus 的核心设计哲学（约定优于配置、增强不替代）、`BaseMapper` 内置方法的实现原理（`ISqlInjector` 如何动态注入 SQL）、`LambdaQueryWrapper` 的链式条件构建机制、以及自动填充（`MetaObjectHandler`）、逻辑删除、乐观锁等常用特性的底层实现。最后，我们还将介绍 MP 代码生成器（AutoGenerator）如何根据数据库表结构自动生成 Entity/Mapper/Service/Controller 层代码，并讨论代码生成在工程实践中的合理边界。

---

## 第 1 章 Mybatis-Plus 的设计哲学

### 1.1 约定优于配置（Convention over Configuration）

"约定优于配置"是 Rails 框架推广的一种软件设计范式：当系统能够根据约定自动推断出行为时，就不需要开发者显式配置。Mybatis-Plus 对这一理念的贯彻体现在以下几个核心约定：

**约定一：表名与类名对应**

`UserInfo` 类默认对应 `user_info` 表（驼峰转下划线），无需 `@Table` 注解显式声明（除非需要覆盖）。

**约定二：字段名与属性名对应**

`userName` 属性默认对应 `user_name` 列（驼峰转下划线），无需 `@Column` 注解。

**约定三：主键字段名**

属性名为 `id` 的字段默认被识别为主键，对应的 JDBC 操作自动使用 `WHERE id = ?` 语法。

**约定四：标准 CRUD 操作**

所有实体类的 Mapper 默认继承 `BaseMapper<T>`，自动获得 `selectById`、`insert`、`updateById`、`deleteById` 等 20+ 个通用方法，无需编写一行 XML 或注解 SQL。

这些约定让 Mybatis-Plus 在 80% 的典型 CRUD 场景下实现"零配置"，开发者只需专注于有业务差异的复杂查询。

### 1.2 增强不替代

Mybatis-Plus 的口号是"增强 Mybatis，不替代 Mybatis"——它完全兼容原生 Mybatis，MP 增加的功能是叠加在 Mybatis 之上的，不影响任何原有的 Mapper XML 和注解的使用。

这意味着：
- 原来写好的 XML SQL 不需要改动；
- `BaseMapper` 提供不了的复杂查询，照样用 XML 扩展；
- MP 的增强功能（自动填充、逻辑删除、乐观锁）可以逐步引入，不是全有全无。

---

## 第 2 章 BaseMapper 内置方法的实现原理

### 2.1 ISqlInjector：动态 SQL 注入机制

Mybatis-Plus 的通用 CRUD 方法不是用 XML 写死的，而是在 Mybatis 初始化阶段通过 `ISqlInjector` 动态注入的。

`ISqlInjector` 的接口：

```java
public interface ISqlInjector {
    // 在 Configuration 初始化时被调用，向 Configuration 注入通用 SQL 的 MappedStatement
    void inspectInject(MapperBuilderAssistant builderAssistant, Class<?> mapperClass);
}
```

`DefaultSqlInjector` 是默认实现，它内置了所有通用方法对应的 `AbstractMethod` 实现类：

```java
public class DefaultSqlInjector extends AbstractSqlInjector {
    @Override
    public List<AbstractMethod> getMethodList(Class<?> mapperClass, TableInfo tableInfo) {
        // 返回所有内置通用方法的列表
        return Stream.of(
            new Insert(),             // insert
            new Delete(),             // delete (by wrapper)
            new DeleteById(),         // deleteById
            new DeleteBatchByIds(),   // deleteBatchIds
            new Update(),             // update (by wrapper)
            new UpdateById(),         // updateById
            new SelectById(),         // selectById
            new SelectBatchByIds(),   // selectBatchIds
            new SelectCount(),        // selectCount
            new SelectList(),         // selectList (by wrapper)
            new SelectMaps(),         // selectMaps
            new SelectOne(),          // selectOne
            new SelectPage(),         // selectPage (分页)
            new SelectMapsPage()      // selectMapsPage
            // ... 等共 17 个方法
        ).collect(Collectors.toList());
    }
}
```

每个 `AbstractMethod` 子类负责生成一个通用方法对应的 SQL `MappedStatement`。以 `SelectById` 为例：

```java
public class SelectById extends AbstractMethod {
    @Override
    public MappedStatement injectMappedStatement(Class<?> mapperClass, Class<?> modelClass,
                                                   TableInfo tableInfo) {
        // 生成 SQL 模板：根据 TableInfo（表信息）动态构建
        // tableInfo 包含：表名、主键列名、所有字段的映射信息
        String sql = String.format(sqlMethod.getSql(),
            tableInfo.getSelectScript(),   // SELECT id, name, email, ...
            tableInfo.getTableName(),      // users
            tableInfo.getKeyColumn(),      // id
            tableInfo.getKeyProperty(),    // id
            WRAPPER_FILTER);              // 额外过滤条件（逻辑删除时自动加 AND deleted=0）
        
        // 构建 SqlSource（注意：这里使用的是 Mybatis 的 SqlSource 体系）
        SqlSource sqlSource = languageDriver.createSqlSource(configuration, sql, modelClass);
        
        // 注入 MappedStatement 到 Configuration
        return this.addSelectMappedStatementForTable(mapperClass, getMethod(sqlMethod),
            sqlSource, tableInfo);
    }
}
```

注入时机：`MybatisPlusAutoConfiguration` 在 Spring Boot 启动时，将 `ISqlInjector` 集成到 `SqlSessionFactory` 的构建过程中，确保在 Mybatis 初始化阶段完成所有通用方法的 `MappedStatement` 注册。

### 2.2 TableInfo：实体类的元数据

`TableInfo` 是 MP 解析实体类的产物，包含了表名、主键、字段列表等所有元数据，是 SQL 动态生成的基础：

```java
public class TableInfo implements Constants {
    private String tableName;              // 表名（user_info）
    private String keyColumn;             // 主键列名（id）
    private String keyProperty;           // 主键属性名（id）
    private KeyGenerator keyGenerator;   // 主键生成策略
    private boolean logicDelete;          // 是否开启逻辑删除
    private String logicDeleteFieldInfo;  // 逻辑删除字段信息
    private TableFieldInfo versionFieldInfo; // 版本字段（乐观锁）
    private List<TableFieldInfo> fieldList;  // 所有普通字段的列表
    // ...
    
    // 生成 SELECT 的列列表（如 "id, user_name, email, created_at"）
    public String getAllSqlSelect() {
        // 过滤掉 select=false 的字段（如密码字段可以标记不查询）
        return fieldList.stream()
            .filter(f -> !f.isWithoutSelect())
            .map(TableFieldInfo::getColumn)
            .collect(joining(",", keyColumn + ",", ""));
    }
}
```

`TableInfoHelper` 在类路径扫描时解析每个实体类，识别 `@TableName`、`@TableId`、`@TableField`、`@TableLogic`、`@Version` 等注解，构建 `TableInfo` 对象并缓存。

---

## 第 3 章 条件构造器：LambdaQueryWrapper

### 3.1 QueryWrapper 与 LambdaQueryWrapper

Mybatis-Plus 提供了两种条件构造器：

**`QueryWrapper`（字符串方式）**：

```java
QueryWrapper<User> wrapper = new QueryWrapper<>();
wrapper.eq("status", "ACTIVE")       // WHERE status = 'ACTIVE'
       .like("name", "张")            // AND name LIKE '%张%'
       .between("age", 18, 60)        // AND age BETWEEN 18 AND 60
       .orderByDesc("created_at")     // ORDER BY created_at DESC
       .last("LIMIT 10");             // 手动拼接尾部 SQL
```

问题：列名是字符串，有拼写错误编译不报错，重构时也无法自动更新。

**`LambdaQueryWrapper`（方法引用方式，推荐）**：

```java
LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
wrapper.eq(User::getStatus, "ACTIVE")       // 通过方法引用引用列
       .like(User::getName, "张")
       .between(User::getAge, 18, 60)
       .orderByDesc(User::getCreatedAt);
```

`User::getStatus` 是 Java 的方法引用，可以在 IDE 中安全重构——重命名 `status` 属性时，引用会自动更新，不会出现字符串不同步的问题。

### 3.2 LambdaQueryWrapper 的实现原理

`User::getStatus` 本质上是一个 `java.util.function.Function<User, Object>` 类型的 lambda 对象（或更准确地说，是 `SFunction<T, R>` 接口的实现）。

MP 如何从 `User::getStatus` 这个方法引用反推出对应的列名 `status`（或 `user_status`）？

关键在于 `LambdaUtils.extract()`——它通过序列化 lambda 对象，从序列化数据中提取方法引用所指向的方法名：

```java
// SFunction 继承 Serializable，这是关键
@FunctionalInterface
public interface SFunction<T, R> extends Function<T, R>, Serializable { }

// 从 SFunction 中提取方法名
public static <T> String extractFieldName(SFunction<T, ?> func) {
    // 将 lambda 序列化为 SerializedLambda（Java 为可序列化 lambda 提供的特殊对象）
    SerializedLambda serializedLambda = getSerializedLambda(func);
    // 从 implMethodName 字段获取方法名（如 "getStatus"）
    String methodName = serializedLambda.getImplMethodName();
    // 去掉 "get"/"is" 前缀，得到属性名 "status"
    return PropertyNamer.methodToProperty(methodName);
}
```

得到属性名后，再通过 `TableInfo` 查找对应的 `TableFieldInfo`，从中获取数据库列名（如 `user_status`）。整个过程对使用者完全透明。

### 3.3 链式调用与条件拼装

`QueryWrapper` 支持多种条件方法，其内部维护一个 `MergeSegments`（SQL 片段列表），链式调用时不断追加条件片段，最终由 `SqlSegmentUtils` 拼装为完整的 WHERE 子句：

```java
// 常用条件方法
wrapper
    .eq(column, val)           // = val
    .ne(column, val)           // != val
    .gt(column, val)           // > val
    .ge(column, val)           // >= val
    .lt(column, val)           // < val
    .le(column, val)           // <= val
    .between(column, v1, v2)   // BETWEEN v1 AND v2
    .notBetween(column, v1, v2)
    .like(column, val)         // LIKE '%val%'
    .likeLeft(column, val)     // LIKE '%val'
    .likeRight(column, val)    // LIKE 'val%'
    .isNull(column)            // IS NULL
    .isNotNull(column)         // IS NOT NULL
    .in(column, list)          // IN (v1, v2, ...)
    .notIn(column, list)
    .inSql(column, sql)        // IN (SELECT ...)（子查询）
    .exists(sql)               // EXISTS (SELECT ...)
    .and(nested -> nested.eq(...).or().eq(...))  // AND (条件1 OR 条件2)
    .or()                      // OR
    .orderByAsc(column)        // ORDER BY column ASC
    .orderByDesc(column)       // ORDER BY column DESC
    .groupBy(column)           // GROUP BY
    .having("count(*) > {0}", 5) // HAVING
    .select(column1, column2)  // 只查询指定列（SELECT 投影）
    .last("LIMIT 10");         // 直接拼接到 SQL 末尾（有注入风险，谨慎使用）
```

**条件方法的 condition 参数**（重要特性）：

所有条件方法都有带 `boolean condition` 的重载版本，当 `condition=false` 时该条件被忽略：

```java
// 传统写法（冗余的 if 判断）
if (StringUtils.isNotBlank(name)) {
    wrapper.like("name", name);
}
if (status != null) {
    wrapper.eq("status", status);
}

// MP 写法（condition 参数，更简洁）
wrapper.like(StringUtils.isNotBlank(name), User::getName, name)
       .eq(status != null, User::getStatus, status);
```

---

## 第 4 章 IService：Service 层的通用封装

### 4.1 IService 与 ServiceImpl

`IService<T>` 是 MP 对 Service 层的抽象，`ServiceImpl<M extends BaseMapper<T>, T>` 是其默认实现：

```java
// IService 接口（部分方法）
public interface IService<T> {
    boolean save(T entity);                      // 插入
    boolean saveBatch(Collection<T> entityList); // 批量插入
    boolean saveOrUpdate(T entity);              // 存在则更新，否则插入
    boolean removeById(Serializable id);         // 按 ID 删除
    boolean remove(Wrapper<T> queryWrapper);     // 按条件删除
    boolean updateById(T entity);                // 按 ID 更新（null 字段不更新）
    boolean update(T entity, Wrapper<T> wrapper); // 按条件更新
    T getById(Serializable id);                  // 按 ID 查询
    T getOne(Wrapper<T> queryWrapper);           // 查单条（多条时抛异常）
    List<T> list(Wrapper<T> queryWrapper);       // 按条件查列表
    IPage<T> page(IPage<T> page, Wrapper<T> queryWrapper); // 分页查询
    long count(Wrapper<T> queryWrapper);         // 统计数量
    // ...
}

// 使用方式：继承 ServiceImpl
@Service
public class UserServiceImpl extends ServiceImpl<UserMapper, User> implements UserService {
    // 直接继承所有通用方法，只需在这里添加业务特定方法
    
    public List<User> findActiveUsers() {
        return lambdaQuery()
            .eq(User::getStatus, "ACTIVE")
            .orderByDesc(User::getCreatedAt)
            .list();
    }
}
```

`ServiceImpl` 内部的 `saveBatch()` 是对 MP 批量插入的封装，底层使用 Mybatis 的 `BatchExecutor`，每批（默认 1000 条）刷新一次：

```java
// ServiceImpl 中的 saveBatch 实现
@Transactional(rollbackFor = Exception.class)
public boolean saveBatch(Collection<T> entityList, int batchSize) {
    String sqlStatement = getSqlStatement(SqlMethod.INSERT_ONE);
    return executeBatch(entityList, batchSize, (sqlSession, entity) -> {
        sqlSession.insert(sqlStatement, entity);
    });
}

protected boolean executeBatch(Collection<T> list, int batchSize,
                                 BiConsumer<SqlSession, T> consumer) {
    // 获取 SqlSessionFactory，手动创建 BatchExecutor 模式的 SqlSession
    SqlSessionFactory sqlSessionFactory = SpringUtils.getBean(SqlSessionFactory.class);
    try (SqlSession batchSqlSession = sqlSessionFactory.openSession(ExecutorType.BATCH)) {
        int i = 0;
        for (T anObj : list) {
            consumer.accept(batchSqlSession, anObj);
            if (i >= 1 && i % batchSize == 0) {
                batchSqlSession.flushStatements();  // 批量提交
            }
            i++;
        }
        batchSqlSession.flushStatements();
        return true;
    }
}
```

---

## 第 5 章 核心特性：自动填充、逻辑删除与乐观锁

### 5.1 自动填充（MetaObjectHandler）

自动填充解决了一个常见需求：在 `insert` 时自动设置 `created_at` 和 `created_by`，在 `update` 时自动设置 `updated_at` 和 `updated_by`，而不需要在每个 Service 方法中手动赋值。

**第一步：在实体类字段上标注 `@TableField(fill = ...)`**：

```java
@Data
@TableName("users")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;
    
    private String name;
    
    @TableField(fill = FieldFill.INSERT)  // 只在 INSERT 时填充
    private LocalDateTime createdAt;
    
    @TableField(fill = FieldFill.INSERT)
    private Long createdBy;
    
    @TableField(fill = FieldFill.INSERT_UPDATE)  // INSERT 和 UPDATE 时均填充
    private LocalDateTime updatedAt;
    
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private Long updatedBy;
}
```

**第二步：实现 `MetaObjectHandler`，定义填充逻辑**：

```java
@Component
public class AuditMetaObjectHandler implements MetaObjectHandler {
    
    @Override
    public void insertFill(MetaObject metaObject) {
        // INSERT 时的填充逻辑
        this.strictInsertFill(metaObject, "createdAt", LocalDateTime.class, LocalDateTime.now());
        this.strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
        
        // 从 Spring Security 上下文获取当前用户 ID
        Long currentUserId = SecurityUtils.getCurrentUserId();
        this.strictInsertFill(metaObject, "createdBy", Long.class, currentUserId);
        this.strictInsertFill(metaObject, "updatedBy", Long.class, currentUserId);
    }
    
    @Override
    public void updateFill(MetaObject metaObject) {
        // UPDATE 时的填充逻辑（只更新 updatedAt 和 updatedBy）
        this.strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
        Long currentUserId = SecurityUtils.getCurrentUserId();
        this.strictUpdateFill(metaObject, "updatedBy", Long.class, currentUserId);
    }
}
```

**填充触发时机**：MP 在 `BaseMapper.insert()` 和 `BaseMapper.update()` 的执行路径中，通过 `DefaultSqlInjector` 注入的 SQL 模板会触发 `MetaObjectHandler` 的调用。具体来说，`TableInfo` 维护了哪些字段需要自动填充，在 SQL 执行前，MP 会遍历这些字段，调用 `MetaObjectHandler` 的对应方法将值写入 `MetaObject`（即实体对象的反射包装）。

> [!warning] strictInsertFill 与 setFieldValByName 的区别
> `strictInsertFill(metaObject, field, clazz, val)`：只有当该字段的值为 `null` 时才填充（严格模式）；如果字段已有值，不会覆盖。
>
> `setFieldValByName(field, val, metaObject)`：无论字段当前值如何，都强制覆盖。
>
> 生产中**推荐使用 `strictInsertFill`**，避免覆盖业务代码显式设置的值。

### 5.2 逻辑删除

逻辑删除是指将"删除"操作转变为"标记字段更新"（`DELETE = true`），数据仍然存在于数据库中，只是被隐藏了——查询时自动过滤掉已删除记录。

**配置方式**：

```yaml
# application.yml 全局配置
mybatis-plus:
  global-config:
    db-config:
      logic-delete-field: deleted      # 逻辑删除字段名（全局）
      logic-delete-value: 1            # 已删除的标记值
      logic-not-delete-value: 0        # 未删除的标记值
```

或在字段上单独标注：

```java
@TableField
@TableLogic(value = "0", delval = "1")  // value=未删除值, delval=删除值
private Integer deleted;
```

**逻辑删除的自动行为**：
- `deleteById(id)`：生成 `UPDATE users SET deleted=1 WHERE id=?`（而非 DELETE）；
- `selectById(id)`：生成 `SELECT ... WHERE id=? AND deleted=0`（自动加条件）；
- `selectList(wrapper)`：自动在 WHERE 中加 `AND deleted=0`。

这种自动行为由 `TableInfo.logicDelete` 标记控制，`DefaultSqlInjector` 在生成 SQL 模板时会检查该标记，决定是否在 SQL 中追加逻辑删除条件。

> [!info] 逻辑删除的代价
> 逻辑删除方便了数据恢复，但带来了以下代价：
> 1. **索引效率降低**：大量"已删除"数据占用索引空间，查询时必须额外过滤 `deleted=0`；
> 2. **唯一索引失效**：如果 `username` 有唯一索引，逻辑删除后再次插入同名用户会因唯一键冲突失败。解决方案是将唯一键改为联合唯一索引 `(username, deleted)`（但 MySQL 的唯一索引允许多个 NULL，`deleted` 用 NULL 表示未删除可绕过此问题）；
> 3. **JOIN 查询需手动处理**：关联查询时，被 JOIN 的表同样需要过滤逻辑删除字段，但 MP 只对当前主表自动加条件，JOIN 的子表需要手动在 XML 中添加过滤条件。

### 5.3 乐观锁（@Version）

乐观锁通过版本号字段解决并发更新冲突，避免使用数据库悲观锁（`SELECT FOR UPDATE`）带来的性能瓶颈。

**工作原理**：
1. 读取记录时，同时读取 `version` 字段；
2. 更新记录时，在 WHERE 条件中加入 `version = ?`（期望版本号）；
3. 如果 WHERE 条件中 `version` 匹配成功（说明记录没有被其他线程修改），执行更新并将 `version + 1`；
4. 如果 `version` 不匹配（`affected rows = 0`），说明并发冲突，业务层重试或报错。

**配置方式**：

```java
// 启用乐观锁插件（Spring Boot）
@Bean
public MybatisPlusInterceptor mybatisPlusInterceptor() {
    MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
    interceptor.addInnerInterceptor(new OptimisticLockerInnerInterceptor());  // 乐观锁
    interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL)); // 分页
    return interceptor;
}

// 实体类
@Data
public class Order {
    @TableId
    private Long id;
    private BigDecimal amount;
    
    @Version  // 标注为版本字段
    private Integer version;
}
```

**生成的 SQL**：

```sql
-- 原始 updateById(order)
-- 手动调用时需要先查询，获取当前 version，再更新
UPDATE orders SET amount = ?, version = version + 1 
WHERE id = ? AND version = ?  -- 期望版本号由 @Version 字段提供
```

**业务代码**：

```java
@Transactional
public boolean deductAmount(Long orderId, BigDecimal deductAmount) {
    // 第一步：查询，获取当前 version
    Order order = orderMapper.selectById(orderId);
    
    // 第二步：计算新 amount
    order.setAmount(order.getAmount().subtract(deductAmount));
    
    // 第三步：更新（MP 自动在 WHERE 中加入当前 version，并将 version+1）
    int rows = orderMapper.updateById(order);
    
    if (rows == 0) {
        // 乐观锁冲突：并发更新导致 version 不匹配
        throw new OptimisticLockException("订单并发更新冲突，请重试");
    }
    return true;
}
```

> [!warning] 乐观锁的使用限制
> `@Version` 只对 `updateById()` 和 `update(entity, wrapper)` 生效，对 `update(null, wrapper)`（只通过 Wrapper 更新，不传 entity）不生效。原因是 `version` 字段的值来自 `entity` 对象，如果 `entity` 为 null，就无法获取期望的版本号。

---

## 第 6 章 代码生成器：AutoGenerator

### 6.1 代码生成的价值与边界

代码生成器的价值在于：对于标准化的代码（Entity、Mapper、Mapper XML、Service、ServiceImpl、Controller），其结构完全可预测，手写这些文件是纯机械劳动——重复、乏味、容易出错。代码生成器将这些机械劳动自动化，工程师的精力应该集中在业务逻辑上。

代码生成的合理边界：
- **适合生成**：Entity（字段与数据库列的映射）、Mapper 接口（基础 CRUD）、Mapper XML（初始的空 XML 或基础查询）、Service/ServiceImpl（标准的接口与实现框架）、Controller（RESTful 端点框架）；
- **不适合依赖生成**：包含业务逻辑的 Service 实现、复杂的多表查询、定制化的接口协议。

### 6.2 AutoGenerator 的配置与使用

MP 代码生成器依赖 Velocity 或 Freemarker 模板引擎，根据数据库元数据（INFORMATION_SCHEMA）生成代码：

```java
// 代码生成器的配置（MP 3.5+ 版本）
public class CodeGenerator {
    public static void main(String[] args) {
        FastAutoGenerator.create(
                "jdbc:mysql://localhost:3306/mydb?serverTimezone=UTC",
                "root", "password")
            // 全局配置
            .globalConfig(builder -> builder
                .author("lihaopeng")
                .outputDir(System.getProperty("user.home") + "/Desktop/generated")
                .commentDate("yyyy-MM-dd")
                .disableOpenDir()  // 生成后不自动打开目录
            )
            // 包名配置
            .packageConfig(builder -> builder
                .parent("com.example")       // 父包名
                .entity("domain.entity")     // Entity 包
                .mapper("mapper")            // Mapper 包
                .service("service")          // Service 包
                .serviceImpl("service.impl") // ServiceImpl 包
                .controller("controller")    // Controller 包
                .xml("mapper.xml")           // Mapper XML 路径（resources 下）
            )
            // 策略配置
            .strategyConfig(builder -> builder
                .addInclude("users", "orders", "products")  // 指定生成的表
                .addTablePrefix("t_", "sys_")               // 去除表前缀（t_user → User）
                // Entity 策略
                .entityBuilder()
                    .enableLombok()              // 使用 @Data 等 Lombok 注解
                    .enableTableFieldAnnotation() // 所有字段加 @TableField
                    .versionColumnName("version") // 乐观锁字段
                    .logicDeleteColumnName("deleted") // 逻辑删除字段
                    .naming(NamingStrategy.underline_to_camel) // 下划线转驼峰
                    .build()
                // Mapper 策略
                .mapperBuilder()
                    .enableMapperAnnotation()     // 生成 @Mapper 注解
                    .enableBaseResultMap()        // 生成基础 ResultMap
                    .enableBaseColumnList()       // 生成 Base_Column_List
                    .build()
                // Service 策略
                .serviceBuilder()
                    .formatServiceFileName("%sService")     // 接口名格式：UserService
                    .formatServiceImplFileName("%sServiceImpl") // 实现类格式：UserServiceImpl
                    .build()
                // Controller 策略
                .controllerBuilder()
                    .enableRestStyle()           // 生成 @RestController
                    .enableHyphenStyle()         // URL 用连字符（user-info）
                    .build()
            )
            // 模板引擎（Velocity/Freemarker/Beetl）
            .templateEngine(new VelocityTemplateEngine())
            .execute();
    }
}
```

### 6.3 自定义模板

代码生成器支持自定义模板，允许团队将工程规范（如统一的响应格式、统一的异常处理）内置到生成模板中，确保所有生成代码符合团队标准：

```
resources/
├── templates/
│   ├── entity.java.vm     # Entity 模板（覆盖默认）
│   ├── controller.java.vm # Controller 模板（含统一 @ApiOperation 注解）
│   └── service.java.vm
```

在模板中可以使用 Velocity 语法引用表和字段信息：

```velocity
## controller.java.vm 自定义模板示例
package ${package.Controller};

import com.example.common.Result;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;

@RestController
@RequestMapping("/${table.entityPath}")
@Api(tags = "${table.comment!}管理")
public class ${table.controllerName} extends BaseController {
    
    @Autowired
    private ${table.serviceName} ${table.entityPath}Service;
    
    @GetMapping("/{id}")
    @ApiOperation("根据ID查询${table.comment!}")
    public Result<${entity}> getById(@PathVariable Long id) {
        return Result.ok(${table.entityPath}Service.getById(id));
    }
    
    @PostMapping
    @ApiOperation("新增${table.comment!}")
    public Result<Void> save(@RequestBody @Validated ${entity} entity) {
        ${table.entityPath}Service.save(entity);
        return Result.ok();
    }
    
    // ... 其他 CRUD 端点
}
```

---

## 第 7 章 MybatisPlusInterceptor：分页与其他内置插件

### 7.1 MybatisPlusInterceptor 的设计

MP 的插件体系基于前一篇介绍的 Mybatis `Interceptor` 机制，但 MP 做了一层聚合——`MybatisPlusInterceptor` 是一个"超级插件"，它本身是一个 `Interceptor`，内部维护一个 `InnerInterceptor` 列表，在单次拦截调用中依次执行所有内部插件：

```java
@Intercepts({
    @Signature(type = StatementHandler.class, method = "prepare", 
               args = {Connection.class, Integer.class}),
    @Signature(type = StatementHandler.class, method = "getBoundSql", 
               args = {}),
    @Signature(type = Executor.class, method = "update", 
               args = {MappedStatement.class, Object.class}),
    @Signature(type = Executor.class, method = "query", 
               args = {MappedStatement.class, Object.class, RowBounds.class, 
                       ResultHandler.class, CacheKey.class, BoundSql.class}),
    // ...
})
public class MybatisPlusInterceptor implements Interceptor {
    private List<InnerInterceptor> interceptors = new ArrayList<>();
    
    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        // 依次执行所有内部插件的前置处理
        for (InnerInterceptor innerInterceptor : interceptors) {
            // beforeQuery / beforeUpdate 返回 false 时，终止执行（短路）
            if (!innerInterceptor.willDoQuery(...)) {
                return new ArrayList<>();
            }
        }
        Object result = invocation.proceed();
        // 内部插件通常没有后置处理
        return result;
    }
}
```

**常用的内置 InnerInterceptor**：

| 插件 | 功能 |
| --- | --- |
| `PaginationInnerInterceptor` | 分页（替代 PageHelper，MP 原生方案）|
| `OptimisticLockerInnerInterceptor` | 乐观锁 |
| `BlockAttackInnerInterceptor` | 防全表更新/删除（`update` 和 `delete` 没有 WHERE 时抛异常）|
| `IllegalSQLInnerInterceptor` | SQL 规范校验（禁止无索引查询等）|
| `TenantLineInnerInterceptor` | 多租户隔离（自动注入 `tenant_id` 条件）|
| `DynamicTableNameInnerInterceptor` | 动态表名（分库分表场景）|

### 7.2 分页：IPage 与 PaginationInnerInterceptor

MP 原生分页使用 `IPage` 接口（而非 PageHelper 的 `Page` + ThreadLocal 方式）：

```java
// Service 层
public IPage<User> getUsers(int current, int size, String status) {
    Page<User> page = new Page<>(current, size);  // current: 当前页码, size: 每页数量
    
    LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
    wrapper.eq(status != null, User::getStatus, status)
           .orderByDesc(User::getCreatedAt);
    
    // selectPage 返回的 page 对象包含 records（数据列表）、total（总记录数）等
    return userMapper.selectPage(page, wrapper);
}

// Controller 层
@GetMapping("/users")
public Result<IPage<User>> listUsers(
        @RequestParam(defaultValue = "1") int current,
        @RequestParam(defaultValue = "20") int size,
        String status) {
    return Result.ok(userService.getUsers(current, size, status));
}
```

`PaginationInnerInterceptor` 拦截 `Executor.query()`，在执行分页查询前：
1. 执行 COUNT 查询获取总记录数，设置到 `IPage.total`；
2. 改写原始 SQL 为分页 SQL（根据数据库方言自动选择语法）；
3. 将查询结果设置到 `IPage.records`。

相比 PageHelper 的 ThreadLocal 方式，MP 分页的优点是**参数显式传递**（分页信息在方法参数中，不依赖 ThreadLocal），更易于理解和测试，也不存在 PageHelper 的"startPage 与查询不紧邻"问题。

---

## 总结

Mybatis-Plus 以"约定优于配置、增强不替代"为核心设计哲学，在 Mybatis 之上构建了一套完整的增强体系：

- **通用 CRUD**：`BaseMapper<T>` 通过 `ISqlInjector` 在初始化时动态注入 20+ 个通用 `MappedStatement`，`TableInfo` 是 SQL 动态生成的元数据基础；
- **LambdaQueryWrapper**：通过序列化 lambda 对象提取方法引用的属性名，将方法引用映射为列名，实现类型安全的条件构造，彻底消除字符串列名的拼写错误风险；
- **自动填充**：`@TableField(fill = ...)` + `MetaObjectHandler` 在 INSERT/UPDATE 时自动设置审计字段（`created_at`、`updated_by` 等），在框架层消除业务代码的重复赋值；
- **逻辑删除**：`@TableLogic` 将 `DELETE` 转换为 `UPDATE SET deleted=1`，查询时自动过滤已删除记录；注意逻辑删除对唯一索引和关联查询的影响；
- **乐观锁**：`@Version` + `OptimisticLockerInnerInterceptor` 在 `updateById` 时自动在 WHERE 中加入版本号条件，并在更新成功后自增版本，用无锁机制解决并发更新冲突；
- **代码生成**：`AutoGenerator` 通过数据库元数据 + Velocity/Freemarker 模板自动生成标准层代码，自定义模板可将团队规范内置到生成代码中；
- **分页插件**：`IPage` + `PaginationInnerInterceptor` 提供显式参数的分页方案，相比 PageHelper 的 ThreadLocal 方式更直观、更易测试。

至此，Mybatis 专栏全部 10 篇文章已完成。Mybatis 的核心——从配置加载、SQL 执行、动态 SQL、参数处理、结果映射、缓存机制、插件扩展到 Spring 整合——均已系统覆盖。

---

> [!note] 参考资料
> - [Mybatis-Plus 官方文档](https://baomidou.com/)
> - `com.baomidou.mybatisplus.core.injector.DefaultSqlInjector` 源码
> - `com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor` 源码
> - `com.baomidou.mybatisplus.generator.FastAutoGenerator` 源码
