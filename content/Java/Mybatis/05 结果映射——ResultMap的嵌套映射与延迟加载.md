---
title: "结果映射——ResultMap的嵌套映射与延迟加载"
date: 2026-03-04
tags: [Java, Mybatis, ResultMap, ResultSetHandler, 嵌套映射, 延迟加载, N+1问题, association, collection, 鉴别器]
aliases: []
---

# 结果映射——ResultMap的嵌套映射与延迟加载

## 摘要

结果映射是 Mybatis 将 JDBC `ResultSet` 转换为 Java 对象的核心机制，其复杂度远超参数处理。`ResultMap` 不仅支持简单的列名→属性名映射，还支持多级嵌套的对象关联（`<association>`）和集合关联（`<collection>`），以及基于列值的多态映射（`<discriminator>`）。本文深入剖析 `DefaultResultSetHandler` 的映射逻辑，重点分析两种嵌套查询策略（嵌套 SELECT 与嵌套 JOIN 结果集）的实现差异与适用场景，揭示 N+1 问题的本质成因，以及 Mybatis 延迟加载的 CGLIB/Javassist 代理机制——当你访问一个懒加载属性时，Mybatis 究竟做了什么？理解这一层，是写出高性能 Mybatis 查询的必要前提。

---

## 第 1 章 ResultMap 的基础结构

### 1.1 为什么需要 ResultMap

Mybatis 的结果映射有两种方式：

**方式一：`resultType`（自动映射）**

```xml
<select id="selectById" resultType="com.example.domain.User">
    SELECT id, user_name, email, created_at FROM users WHERE id = #{id}
</select>
```

当使用 `resultType` 时，Mybatis 通过列名与属性名的自动匹配完成映射：
- 精确匹配（区分大小写）：`id` → `id`；
- 驼峰映射（开启 `mapUnderscoreToCamelCase=true`）：`user_name` → `userName`，`created_at` → `createdAt`。

**限制**：`resultType` 只能处理"一行 → 一个对象"的平坦映射，无法处理关联对象（`User` 包含 `Address`）、集合关联（`User` 包含 `List<Order>`）等嵌套结构。

**方式二：`resultMap`（显式映射）**

```xml
<resultMap id="userResultMap" type="User">
    <!-- 主键映射：<id> 在缓存 key 和合并嵌套结果时有特殊意义 -->
    <id column="id" property="id"/>
    <!-- 普通字段映射 -->
    <result column="user_name" property="userName"/>
    <result column="email" property="email"/>
    <result column="created_at" property="createdAt"/>
    <!-- 关联对象映射 -->
    <association property="address" javaType="Address">
        <id column="addr_id" property="id"/>
        <result column="city" property="city"/>
        <result column="street" property="street"/>
    </association>
    <!-- 集合映射 -->
    <collection property="orders" ofType="Order">
        <id column="order_id" property="id"/>
        <result column="order_status" property="status"/>
        <result column="amount" property="amount"/>
    </collection>
</resultMap>
```

`resultMap` 的能力：精确控制映射规则、处理嵌套关联、处理集合关联、延迟加载、多态映射。

### 1.2 ResultMap 的内部数据结构

`ResultMap` 在初始化时被解析为 `org.apache.ibatis.mapping.ResultMap` 对象：

```java
public class ResultMap {
    private String id;                         // ResultMap ID（namespace + ".id"）
    private Class<?> type;                     // 映射目标的 Java 类型
    private List<ResultMapping> resultMappings; // 所有映射规则的列表
    private List<ResultMapping> idResultMappings;     // 只包含 <id> 的映射
    private List<ResultMapping> constructorResultMappings; // <constructor> 参数映射
    private List<ResultMapping> propertyResultMappings;    // <result>/<association>/<collection>
    private Set<String> mappedColumns;         // 已映射的列名集合（大写）
    private Set<String> mappedProperties;      // 已映射的属性名集合
    private Discriminator discriminator;       // <discriminator> 鉴别器
    private boolean hasNestedResultMaps;       // 是否含有嵌套 ResultMap
    private boolean hasNestedQueries;          // 是否含有嵌套查询（select 属性的 association/collection）
    private Boolean autoMapping;              // 是否开启自动映射
}
```

`ResultMapping` 描述单个映射规则：

```java
public class ResultMapping {
    private String property;          // Java 属性名
    private String column;            // 数据库列名
    private Class<?> javaType;        // Java 类型
    private JdbcType jdbcType;        // JDBC 类型
    private TypeHandler<?> typeHandler; // 类型处理器
    private String nestedResultMapId; // 嵌套 ResultMap 的 ID（association/collection 的内联 ResultMap）
    private String nestedQueryId;     // 嵌套查询的 Statement ID（select 属性）
    private Set<String> notNullColumns; // 只有这些列不为 null 时才创建嵌套对象
    private String columnPrefix;      // 列名前缀（处理多表 JOIN 时的列冲突）
    private List<ResultFlag> flags;   // ID / CONSTRUCTOR 标记
    private List<ResultMapping> composites; // 多列复合外键
    private String resultSet;         // 多结果集中的目标结果集名称
    private String foreignColumn;     // 父结果集中的外键列
    private boolean lazy;             // 是否延迟加载
}
```

---

## 第 2 章 嵌套映射的两种策略

处理关联关系（一对一的 `<association>`，一对多的 `<collection>`）时，Mybatis 提供两种完全不同的策略：

### 2.1 策略一：嵌套 SELECT（N+1 查询）

通过 `select` 属性指定一个独立的 SELECT 语句来加载关联对象：

```xml
<!-- 主查询：查询用户 -->
<select id="selectUserById" resultMap="userWithAddressMap">
    SELECT * FROM users WHERE id = #{id}
</select>

<resultMap id="userWithAddressMap" type="User">
    <id column="id" property="id"/>
    <result column="user_name" property="userName"/>
    <!-- 用独立的 SELECT 查询 Address：传入 address_id 作为参数 -->
    <association property="address" 
                 column="address_id"
                 select="com.example.mapper.AddressMapper.selectById"/>
</resultMap>

<!-- 被嵌套调用的查询 -->
<select id="selectById" resultType="Address">
    SELECT * FROM addresses WHERE id = #{id}
</select>
```

**执行过程**：
1. 执行主查询，得到 `ResultSet`（含 `address_id` 列）；
2. 对每一行，发现 `address` 属性需要通过嵌套 SELECT 加载；
3. 用该行的 `address_id` 值，调用 `AddressMapper.selectById(addressId)`；
4. 将返回的 `Address` 对象设置到 `user.address` 属性上。

**N+1 问题的根源就在这里**：如果主查询返回了 N 条用户记录，就需要额外执行 N 次嵌套 SELECT 查询（1 次主查询 + N 次关联查询 = N+1 次数据库往返）。

```
执行 1 次：SELECT * FROM users WHERE status = 'ACTIVE'  → 返回 100 个用户
执行 100 次：SELECT * FROM addresses WHERE id = 1
             SELECT * FROM addresses WHERE id = 2
             ...
             SELECT * FROM addresses WHERE id = 100
总计：101 次数据库往返！
```

**嵌套 SELECT 的适用场景**：
- 关联对象很少被访问（结合延迟加载，仅在真正访问时才查询）；
- 主查询返回的数据量很小（如单条记录查询）；
- 关联对象有独立的缓存（命中一级/二级缓存时不产生实际 SQL）。

### 2.2 策略二：嵌套结果集（JOIN 查询）

通过一条包含 JOIN 的 SQL 一次性取出所有数据，用嵌套 `ResultMap` 在内存中做对象树组装：

```xml
<select id="selectUserWithOrders" resultMap="userWithOrdersMap">
    SELECT 
        u.id, u.user_name, u.email,
        o.id AS order_id, o.status AS order_status, o.amount
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.id = #{id}
</select>

<resultMap id="userWithOrdersMap" type="User">
    <id column="id" property="id"/>
    <result column="user_name" property="userName"/>
    <result column="email" property="email"/>
    <collection property="orders" ofType="Order">
        <id column="order_id" property="id"/>
        <result column="order_status" property="status"/>
        <result column="amount" property="amount"/>
    </collection>
</resultMap>
```

**执行过程**：

假设用户有 3 个订单，JOIN 查询返回的 ResultSet 是：

```
id | user_name | email         | order_id | order_status | amount
1  | Alice     | alice@test.com | 101      | PAID         | 100.00
1  | Alice     | alice@test.com | 102      | PENDING      | 200.00
1  | Alice     | alice@test.com | 103      | SHIPPED      | 150.00
```

`DefaultResultSetHandler` 需要将这 3 行"折叠"为 1 个 `User` 对象（包含 3 个 `Order`）：

```java
// handleResultSets 的核心：折叠逻辑
// resultMap.hasNestedResultMaps() == true 时，进入特殊处理路径
while (rs.next()) {
    // 从当前行提取主对象（User）的数据
    Object rowValue = getRowValue(rsw, resultMap, null);
    // storeObject：将 rowValue 存入结果集
    // 关键：如果主键相同，不新建 User，而是复用已有的 User 对象，只添加新 Order
    storeObject(resultHandler, resultContext, rowValue, parentMapping, rs);
}
```

**对象折叠的关键：`<id>` 标签的作用**

这就是为什么 `ResultMap` 中的 `<id>` 标签不可省略的原因——Mybatis 通过主键来判断"这一行属于同一个父对象还是新对象"：

1. 读取第 1 行，`id=1`：创建 `User(id=1, name="Alice")` 和 `Order(id=101)`，将 Order 加入 User.orders；
2. 读取第 2 行，`id=1`（与第 1 行相同）：**不新建 User**，找到已有的 `User(id=1)`，创建 `Order(id=102)` 并加入其 orders；
3. 读取第 3 行，`id=1`：同上，创建 `Order(id=103)` 加入 orders；
4. 最终结果：1 个 `User` 对象，其 `orders` 包含 3 个 `Order`。

> [!warning] 忘写 `<id>` 的后果
> 如果 `ResultMap` 中没有 `<id>` 标签，Mybatis 无法判断相邻两行是否属于同一个父对象，会将每一行都当作新对象处理，上面的例子会得到 **3 个 `User` 对象**（每个各带 1 个 `Order`），而不是 **1 个 `User` 对象**（带 3 个 `Order`）。这是一个非常隐蔽的 bug，尤其在数据量少时很难发现。

---

## 第 3 章 ResultSetHandler 的映射实现细节

### 3.1 handleRowValues：普通映射 vs 嵌套映射

`DefaultResultSetHandler` 根据 `ResultMap.hasNestedResultMaps()` 选择不同的处理路径：

```java
private void handleRowValues(ResultSetWrapper rsw, ResultMap resultMap,
                               ResultHandler<?> resultHandler, RowBounds rowBounds,
                               ResultMapping parentMapping) throws SQLException {
    if (resultMap.hasNestedResultMaps()) {
        // 嵌套 ResultMap（JOIN 查询）：需要对象折叠，维护父对象的缓存
        ensureNoRowBounds();
        checkResultHandler();
        handleRowValuesForNestedResultMap(rsw, resultMap, resultHandler, rowBounds, parentMapping);
    } else {
        // 简单映射（或嵌套 SELECT）：每行独立处理
        handleRowValuesForSimpleResultMap(rsw, resultMap, resultHandler, rowBounds, parentMapping);
    }
}
```

**简单映射路径**（`handleRowValuesForSimpleResultMap`）：

```java
private void handleRowValuesForSimpleResultMap(ResultSetWrapper rsw, ResultMap resultMap,
    ResultHandler<?> resultHandler, RowBounds rowBounds, ResultMapping parentMapping) {
    ResultContext<Object> resultContext = new DefaultResultContext<>();
    ResultSet rs = rsw.getResultSet();
    // 跳过 RowBounds 指定的偏移量（内存分页，性能较差）
    skipRows(rs, rowBounds);
    while (shouldProcessMoreRows(resultContext, rowBounds) && !rs.isClosed() && rs.next()) {
        // 如果配置了 discriminator，根据列值决定使用哪个 ResultMap（多态映射）
        ResultMap discriminatedResultMap = resolveDiscriminatedResultMap(rs, resultMap, null);
        // 映射当前行为 Java 对象
        Object rowValue = getRowValue(rsw, discriminatedResultMap, null);
        // 存储结果（触发 ResultHandler 回调，或加入 List）
        storeObject(resultHandler, resultContext, rowValue, parentMapping, rs);
    }
}
```

**嵌套映射路径**（`handleRowValuesForNestedResultMap`）：

```java
// 用于跟踪已创建的父对象（防止重复创建）
// key: 父对象的 CacheKey（基于 <id> 列的值构成）
// value: 父对象实例
final Map<CacheKey, Object> combinedKey = new HashMap<>();

private void handleRowValuesForNestedResultMap(ResultSetWrapper rsw, ResultMap resultMap,
    ResultHandler<?> resultHandler, RowBounds rowBounds, ResultMapping parentMapping) {
    while (shouldProcessMoreRows(resultContext, rowBounds) && !rs.isClosed() && rs.next()) {
        final ResultMap discriminatedResultMap = resolveDiscriminatedResultMap(rs, resultMap, null);
        // 为当前行的"父对象"生成一个唯一 CacheKey（基于 <id> 列）
        final CacheKey rowKey = createRowKey(discriminatedResultMap, rsw, null);
        Object partialObject = nestedResultObjects.get(rowKey);
        
        if (mappedStatement.isResultOrdered()) {
            // 结果有序模式（resultOrdered=true）：当主键变化时清空 nestedResultObjects
            // 避免 HashMap 无限增长（适合大结果集）
            if (partialObject == null && rowValue != null) {
                nestedResultObjects.clear();
                storeObject(resultHandler, resultContext, rowValue, parentMapping, rs);
            }
            rowValue = getRowValue(rsw, discriminatedResultMap, rowKey, null, partialObject);
        } else {
            // 结果无序模式（默认）：完全依赖 HashMap 去重
            rowValue = getRowValue(rsw, discriminatedResultMap, rowKey, null, partialObject);
            if (partialObject == null) {
                storeObject(resultHandler, resultContext, rowValue, parentMapping, rs);
            }
        }
    }
}
```

### 3.2 getRowValue：单行映射的核心逻辑

```java
private Object getRowValue(ResultSetWrapper rsw, ResultMap resultMap, CacheKey combinedKey,
                            String columnPrefix, Object partialObject) throws SQLException {
    final String resultMapId = resultMap.getId();
    Object rowValue = partialObject;
    
    if (rowValue != null) {
        // 父对象已存在（同一主键的后续行）：只需处理嵌套对象
        final MetaObject metaObject = configuration.newMetaObject(rowValue);
        putAncestor(rowValue, resultMapId);
        applyNestedResultMappings(rsw, resultMap, metaObject, columnPrefix, combinedKey, false);
        ancestorObjects.remove(resultMapId);
    } else {
        // 父对象不存在（主键第一次出现）：创建新对象，完整映射所有属性
        final ResultLoaderMap lazyLoader = new ResultLoaderMap();
        rowValue = createResultObject(rsw, resultMap, lazyLoader, columnPrefix);
        
        if (rowValue != null && !hasTypeHandlerForResultObject(rsw, resultMap.getType())) {
            final MetaObject metaObject = configuration.newMetaObject(rowValue);
            boolean foundValues = this.useConstructorMappings;
            
            // 自动映射：将未在 ResultMap 中显式配置的列自动映射到同名属性
            if (shouldApplyAutomaticMappings(resultMap, false)) {
                foundValues = applyAutomaticMappings(rsw, resultMap, metaObject, columnPrefix)
                    || foundValues;
            }
            // 显式映射：处理 ResultMap 中配置的每个 <result>/<id>
            foundValues = applyPropertyMappings(rsw, resultMap, metaObject, lazyLoader, columnPrefix)
                || foundValues;
            // 将当前对象放入祖先 Map（用于检测循环引用）
            putAncestor(rowValue, resultMapId);
            // 处理嵌套 ResultMap（<association>/<collection>）
            foundValues = applyNestedResultMappings(rsw, resultMap, metaObject, columnPrefix, combinedKey, true)
                || foundValues;
            ancestorObjects.remove(resultMapId);
            
            foundValues = lazyLoader.size() > 0 || foundValues;
            rowValue = foundValues || configuration.isReturnInstanceForEmptyRow() ? rowValue : null;
        }
        
        // 将对象（或其延迟加载代理）缓存起来，供后续相同主键的行复用
        if (combinedKey != CacheKey.NULL_CACHE_KEY) {
            nestedResultObjects.put(combinedKey, rowValue);
        }
    }
    return rowValue;
}
```

---

## 第 4 章 N+1 问题的本质与解决方案

### 4.1 N+1 问题的完整案例

N+1 问题是 ORM 框架中最经典的性能陷阱，在 Mybatis 中主要由嵌套 SELECT（`select` 属性）引发：

```java
// 业务场景：查询某个部门下所有员工及其所属项目列表
List<Employee> employees = employeeMapper.selectByDeptId(deptId);
// 主查询：SELECT * FROM employees WHERE dept_id = ?
// 返回 50 个员工

for (Employee emp : employees) {
    // 每次访问 emp.getProjects() 时触发嵌套查询
    // SELECT * FROM projects WHERE employee_id = ?
    List<Project> projects = emp.getProjects();  // 触发 1 次嵌套 SELECT
}
// 实际执行：1（主查询）+ 50（项目查询）= 51 次数据库往返
```

N+1 的危害随数据量线性增长：50 个员工 → 51 次查询；500 个员工 → 501 次查询。

### 4.2 解决方案一：JOIN 嵌套结果映射（最推荐）

用一条 JOIN 语句替代 N+1 次查询：

```xml
<select id="selectByDeptIdWithProjects" resultMap="employeeWithProjectsMap">
    SELECT 
        e.id AS emp_id, e.name AS emp_name, e.dept_id,
        p.id AS proj_id, p.name AS proj_name, p.status AS proj_status
    FROM employees e
    LEFT JOIN employee_projects ep ON e.id = ep.employee_id
    LEFT JOIN projects p ON ep.project_id = p.id
    WHERE e.dept_id = #{deptId}
    ORDER BY e.id  <!-- 重要：需要按主键排序，便于 Mybatis 折叠行 -->
</select>

<resultMap id="employeeWithProjectsMap" type="Employee">
    <id column="emp_id" property="id"/>
    <result column="emp_name" property="name"/>
    <result column="dept_id" property="deptId"/>
    <collection property="projects" ofType="Project">
        <id column="proj_id" property="id"/>
        <result column="proj_name" property="name"/>
        <result column="proj_status" property="status"/>
    </collection>
</resultMap>
```

**优点**：1 次数据库往返，网络开销最小；**缺点**：当关联层次较深（如员工→项目→任务→评论）时，JOIN 会导致笛卡尔积爆炸，查询结果行数剧增。

### 4.3 解决方案二：批量加载（折中方案）

将 N 次单条查询合并为 1 次 IN 查询。Mybatis 的 `resultOrdered` + 手动两次查询实现：

```java
// 第一步：查询所有员工（不加载项目）
List<Employee> employees = employeeMapper.selectByDeptId(deptId);

// 第二步：提取所有员工 ID
List<Long> empIds = employees.stream().map(Employee::getId).collect(Collectors.toList());

// 第三步：一次性查询这些员工的所有项目（IN 查询）
List<EmployeeProject> allProjects = projectMapper.selectByEmployeeIds(empIds);

// 第四步：在内存中按 employeeId 分组
Map<Long, List<Project>> projectsByEmpId = allProjects.stream()
    .collect(Collectors.groupingBy(ep -> ep.getEmployeeId(),
             Collectors.mapping(EmployeeProject::getProject, Collectors.toList())));

// 第五步：合并结果
employees.forEach(emp -> emp.setProjects(projectsByEmpId.getOrDefault(emp.getId(), emptyList())));
```

这种方式需要 2 次数据库往返（远好于 N+1），也不会有 JOIN 的笛卡尔积问题，是大数据量场景下的推荐做法。

---

## 第 5 章 延迟加载的实现机制

### 5.1 延迟加载是什么，为什么需要它

延迟加载（Lazy Loading）是配合嵌套 SELECT 使用的优化策略：**不在查询主对象时立即加载关联对象，而是在第一次实际访问关联属性时才触发加载查询**。

考虑这个场景：查询用户信息用于展示用户卡片，只需要 `user.name`、`user.email`，不需要 `user.orders`。如果立即加载，订单查询完全浪费；如果配置延迟加载，订单查询只在真正需要时才执行。

```xml
<!-- 全局配置延迟加载 -->
<settings>
    <setting name="lazyLoadingEnabled" value="true"/>
    <!-- aggressiveLazyLoading=false：访问对象的任意属性时，不触发所有延迟加载 -->
    <!-- 只有当访问具体的延迟属性时才触发该属性的加载 -->
    <setting name="aggressiveLazyLoading" value="false"/>
</settings>

<!-- 或在具体 association/collection 上单独配置 -->
<association property="orders" 
             column="id" 
             select="selectOrdersByUserId"
             fetchType="lazy"/>  <!-- lazy | eager -->
```

### 5.2 延迟加载的代理机制

当返回对象有需要延迟加载的属性时，Mybatis 不会直接返回该 Java 对象，而是返回一个**代理对象**。代理对象拦截属性的 getter 方法调用，在第一次访问时触发加载查询。

Mybatis 支持两种代理实现：

**实现一：CGLIB（默认，需要 CGLIB 或 ByteBuddy 依赖）**

CGLIB 通过动态生成目标类的子类来实现代理，代理类重写了父类的所有方法，在方法执行前先检查是否需要触发延迟加载：

```java
// CGLIB 代理的拦截器（简化版）
public class CglibSerialStateHolder extends AbstractEnhancedDeserializationProxy implements MethodInterceptor {
    @Override
    public Object intercept(Object enhanced, Method method, Object[] args, MethodProxy methodProxy) throws Throwable {
        final String methodName = method.getName();
        
        try {
            synchronized (lazyLoader) {
                // 如果是 writeReplace 方法（序列化），特殊处理
                if (WRITE_REPLACE_METHOD.equals(methodName)) {
                    // ...
                } else {
                    // 判断是否有未加载的延迟属性
                    if (lazyLoader.size() > 0 && !FINALIZE_METHOD.equals(methodName)) {
                        // 判断是否该方法调用需要触发延迟加载
                        if (aggressive || lazyLoadTriggerMethods.contains(methodName)) {
                            // aggressiveLazyLoading=true 或调用了触发方法（equals/clone/hashCode/toString）
                            // 触发所有延迟属性的加载
                            lazyLoader.loadAll();
                        } else if (PropertyNamer.isProperty(methodName)) {
                            // 是属性的 getter/setter 方法
                            final String property = PropertyNamer.methodToProperty(methodName);
                            // 检查这个属性是否需要延迟加载
                            if (lazyLoader.hasLoader(property)) {
                                lazyLoader.load(property);  // 触发该属性的加载
                            }
                        }
                    }
                }
            }
            // 执行被代理对象的实际方法
            return methodProxy.invokeSuper(enhanced, args);
        } catch (Throwable t) {
            throw ExceptionUtil.unwrapThrowable(t);
        }
    }
}
```

**实现二：Javassist（轻量级替代）**

Javassist 同样是字节码操作库，生成的代理类与 CGLIB 语义相同，但 API 不同。两者都支持在运行时生成子类并重写方法。

**选择哪种代理**：通过 `configuration.proxyFactory` 配置：

```xml
<settings>
    <!-- CGLIB（默认）或 JAVASSIST -->
    <setting name="proxyFactory" value="CGLIB"/>
</settings>
```

在 Mybatis 3.3+ 中，由于 Spring Boot 项目通常已依赖了 CGLIB（Spring AOP 也用 CGLIB），所以 CGLIB 代理是最常见的选择。

### 5.3 ResultLoaderMap：延迟加载任务的注册中心

`ResultLoaderMap` 是一个 Map，存储所有待加载的属性及其对应的加载任务（`ResultLoader`）：

```java
public class ResultLoaderMap {
    // key: 属性名（大写）
    // value: ResultLoader（持有加载该属性所需的所有上下文：SqlSession、MappedStatement、参数值等）
    private final Map<String, LoadPair> loaderMap = new HashMap<>();
    
    // 注册一个延迟加载任务
    public void addLoader(String property, MetaObject metaResultObject, ResultLoader resultLoader) {
        loaderMap.put(property.toUpperCase(Locale.ENGLISH), new LoadPair(property, metaResultObject, resultLoader));
    }
    
    // 触发单个属性的加载
    public boolean load(String property) throws SQLException {
        LoadPair pair = loaderMap.remove(property.toUpperCase(Locale.ENGLISH));
        if (pair != null) {
            pair.load();  // 执行嵌套 SELECT，将结果设置到 metaResultObject
            return true;
        }
        return false;
    }
    
    // 触发所有待加载属性的加载
    public void loadAll() throws SQLException {
        final Set<String> methodNameSet = loaderMap.keySet();
        String[] methodNames = methodNameSet.toArray(new String[0]);
        for (String methodName : methodNames) {
            load(methodName);
        }
    }
}
```

`ResultLoader` 持有足够的上下文来执行嵌套查询：

```java
public class ResultLoader {
    protected final Configuration configuration;
    protected final Executor executor;      // 复用父查询的 Executor（同一个 SqlSession）
    protected final MappedStatement mappedStatement;  // 嵌套查询的 MappedStatement
    protected final Object parameterObject;  // 传给嵌套查询的参数值（外键列的值）
    protected final Class<?> targetType;     // 嵌套查询的返回类型
    protected final ObjectFactory objectFactory;
    protected final CacheKey cacheKey;       // 嵌套查询的缓存 key
    protected final BoundSql boundSql;
    protected final ResultExtractor resultExtractor;
    protected final long creatorThreadId;   // 创建时的线程 ID
    
    // 执行嵌套加载
    public Object loadResult() throws SQLException {
        // 使用保存的 Executor 执行嵌套查询（优先命中一级/二级缓存）
        List<Object> list = selectList();
        // 将 List 转换为目标类型（单对象或 List）
        resultObject = resultExtractor.extractObjectFromList(list, targetType);
        return resultObject;
    }
}
```

### 5.4 延迟加载的生产陷阱

> [!warning] 陷阱一：序列化问题
> 延迟加载依赖代理对象。如果需要对结果对象进行序列化（如放入分布式缓存 Redis、或通过 RPC 传输），代理对象可能无法正常序列化，或者反序列化后代理失效（变成普通对象，延迟属性为 null）。
>
> **解决方案**：在序列化前确保所有延迟属性已加载（调用 getter 触发加载），或者禁用延迟加载，使用 JOIN 查询替代。

> [!warning] 陷阱二：SqlSession 关闭后访问
> 延迟加载需要在 `SqlSession` 开启的情况下才能执行嵌套查询。如果 `SqlSession` 已关闭，再访问延迟属性会抛出异常：
> ```
> org.apache.ibatis.executor.ExecutorException: 
> executor was closed while loading lazy result for ...
> ```
>
> 在 Spring 无事务方法中，`SqlSession` 在 Mapper 方法返回后立即关闭，此时对象中的延迟属性如果还未加载，访问就会报错。
>
> **解决方案**：确保在 `@Transactional` 事务方法中访问延迟属性，或在 Mapper 查询时将 `fetchType` 改为 `eager`。

> [!warning] 陷阱三：aggressiveLazyLoading 的坑
> `aggressiveLazyLoading=true`（Mybatis 3 早期的默认值）意味着访问对象的**任意**方法（包括 `toString()`、`hashCode()`）都会触发所有延迟属性的加载。在调试时打印对象（会调用 `toString()`）就会触发全量加载，掩盖实际的性能问题。
>
> Mybatis 3.4.1+ 将默认值改为 `false`（仅访问具体的延迟属性时才加载该属性），这是正确的默认值。如果你的项目版本较老，建议显式配置 `aggressiveLazyLoading=false`。

---

## 第 6 章 高级映射特性

### 6.1 `<discriminator>`：多态结果映射

当数据库的同一张表存储了多种类型的记录（单表继承模式），可以用 `<discriminator>` 根据某列的值选择不同的 `ResultMap`：

```xml
<resultMap id="vehicleResultMap" type="Vehicle">
    <id column="id" property="id"/>
    <result column="vin" property="vin"/>
    <result column="year" property="year"/>
    <result column="make" property="make"/>
    <result column="model" property="model"/>
    <result column="color" property="color"/>
    <!-- 根据 vehicle_type 列的值，选择不同的 ResultMap -->
    <discriminator javaType="int" column="vehicle_type">
        <case value="1" resultMap="carResultMap"/>    <!-- 轿车 -->
        <case value="2" resultMap="truckResultMap"/>  <!-- 卡车 -->
        <case value="3" resultMap="suvResultMap"/>    <!-- SUV -->
        <case value="4" resultMap="suvResultMap"/>    <!-- 皮卡（复用 suvResultMap）-->
    </discriminator>
</resultMap>

<!-- 轿车的专属映射（通常继承父 ResultMap） -->
<resultMap id="carResultMap" type="Car" extends="vehicleResultMap">
    <result column="door_count" property="doorCount"/>
</resultMap>

<!-- 卡车的专属映射 -->
<resultMap id="truckResultMap" type="Truck" extends="vehicleResultMap">
    <result column="box_size" property="boxSize"/>
</resultMap>
```

`Discriminator` 的实现：在 `resolveDiscriminatedResultMap()` 中，读取鉴别列的值，从 `discriminator.cases` 中查找匹配的 `ResultMap ID`，递归解析（支持嵌套鉴别）。

### 6.2 `columnPrefix`：处理多表 JOIN 的列名冲突

当 JOIN 多张表时，不同表可能有同名列（如两个表都有 `id` 列）。`columnPrefix` 可以为嵌套 ResultMap 指定列名前缀，避免冲突：

```xml
<select id="selectBlogWithAuthor" resultMap="blogWithAuthorMap">
    SELECT 
        b.id,
        b.title,
        a.id AS author_id,          <!-- 用前缀区分作者表的 id -->
        a.username AS author_name
    FROM blogs b
    JOIN authors a ON b.author_id = a.id
    WHERE b.id = #{id}
</select>

<resultMap id="blogWithAuthorMap" type="Blog">
    <id column="id" property="id"/>
    <result column="title" property="title"/>
    <!-- columnPrefix="author_"：使用前缀为 author_ 的列来映射 Author 对象 -->
    <association property="author" resultMap="authorResultMap" columnPrefix="author_"/>
</resultMap>

<resultMap id="authorResultMap" type="Author">
    <!-- 实际映射的列名是 "author_" + "id" = "author_id"，不会与 blogs.id 冲突 -->
    <id column="id" property="id"/>
    <result column="name" property="username"/>
</resultMap>
```

### 6.3 自动映射与显式映射的协作

当 `ResultMap` 中没有显式列出所有列时，Mybatis 会根据 `autoMappingBehavior` 配置决定是否自动映射剩余列：

- **`NONE`**：不自动映射，未配置的列被忽略；
- **`PARTIAL`**（默认）：自动映射没有嵌套 ResultMap 的列；
- **`FULL`**：自动映射所有列（包括嵌套 ResultMap 中未配置的列）。

实践中推荐 `PARTIAL`（默认），显式配置 `<id>` 和 `<association>`/`<collection>`，其他简单列交给自动映射：

```xml
<resultMap id="userResultMap" type="User">
    <!-- 只需要显式配置 id 和嵌套关联 -->
    <id column="id" property="id"/>
    <association property="address" columnPrefix="addr_" resultMap="addressResultMap"/>
    <!-- 其他列（name、email、createdAt 等）通过自动映射处理 -->
</resultMap>
```

---

## 总结

结果映射是 Mybatis 中技术深度最大的模块，其核心知识点：

- **两种嵌套策略**：嵌套 SELECT（简单但有 N+1 风险）vs 嵌套结果集（JOIN 一次查询，内存折叠行）；
- **`<id>` 标签的关键作用**：在嵌套结果集模式下，Mybatis 依靠 `<id>` 列的值来判断相邻行是否属于同一父对象，缺少 `<id>` 会导致对象重复创建；
- **N+1 问题**的解决优先级：JOIN 嵌套结果映射（1 次查询）> 手动批量查询（2 次查询，IN 语句）> 延迟加载（减少无用查询，但不减少必要的查询次数）；
- **延迟加载**通过 CGLIB/Javassist 代理实现，代理拦截 getter 调用，首次访问时执行嵌套 SELECT；主要陷阱：序列化失效、SqlSession 关闭后访问报错、`aggressiveLazyLoading=true` 触发过早加载；
- **`<discriminator>`** 实现单表继承的多态映射；**`columnPrefix`** 解决多表 JOIN 的列名冲突；**自动映射**（`PARTIAL` 模式）减少显式配置量。

下一篇，我们深入 Mybatis 缓存体系，从命中条件到失效场景，全面剖析一级缓存与二级缓存的生产陷阱：[[06 一级缓存与二级缓存——命中条件、失效场景与生产陷阱]]。

---

> [!note] 参考资料
> - `org.apache.ibatis.executor.resultset.DefaultResultSetHandler` 源码
> - `org.apache.ibatis.executor.loader.ResultLoaderMap` 源码
> - `org.apache.ibatis.executor.loader.cglib.CglibProxyFactory` 源码
> - [Mybatis 官方文档 - ResultMap](https://mybatis.org/mybatis-3/sqlmap-xml.html#Result_Maps)

---

> [!note] 思考题
> 1. MyBatis 的 `<association>` 支持嵌套查询（nested select）和嵌套结果映射（nested result map）两种方式实现关联查询。嵌套查询会导致 N+1 问题——查询主表后对每条记录再查子表。嵌套结果映射使用 JOIN 一次查出所有数据。在什么场景下嵌套查询反而优于 JOIN（提示：考虑数据量和缓存）？
> 2. 延迟加载（Lazy Loading）通过动态代理在首次访问关联属性时触发 SQL 查询。MyBatis 使用 CGLIB 或 Javassist 创建代理对象。如果延迟加载的对象被序列化（如返回给前端的 JSON 响应），代理对象的序列化会触发所有延迟加载查询吗？这可能导致什么问题？如何避免？
> 3. `<discriminator>` 标签可以根据某列的值动态选择不同的 ResultMap（类似多态映射）。在一个'订单表'中，`type` 列决定了订单的具体子类型（实物订单、虚拟订单、退款订单）。使用 `<discriminator>` 实现多态映射与在 Service 层通过 `switch` 手动转换相比，维护成本和类型安全性各有什么差异？
