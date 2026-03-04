---
title: "参数处理——ParameterHandler与TypeHandler的类型映射"
date: 2026-03-04
tags: [Java, Mybatis, ParameterHandler, TypeHandler, TypeHandlerRegistry, 类型映射, 枚举处理, JSON字段, 参数解析]
aliases: []
---

# 参数处理——ParameterHandler与TypeHandler的类型映射

## 摘要

参数处理是 Mybatis 执行链路中最容易被忽视却至关重要的一环。每当调用 `mapper.selectById(1L)` 或 `mapper.insert(user)` 时，Mybatis 需要将 Java 方法的参数（`Long`、POJO、`Map`、`@Param` 注解的多参数等）与 SQL 中的 `#{}` 占位符建立对应关系，再通过 `TypeHandler` 完成 Java 类型到 JDBC 类型的安全转换。本文深入剖析 `ParameterHandler` 的参数解析逻辑（`@Param` 注解、单参数、多参数 Map 的处理规则）、`TypeHandler` 注册表的层次查找机制，并重点讲解生产中最常见的自定义 TypeHandler 场景：JSON 字段存储、枚举类型映射、加密字段处理。掌握这一层机制，是解决 Mybatis "类型转换异常"、"参数绑定失败"类问题的关键。

---

## 第 1 章 参数处理的整体流程

### 1.1 参数的生命周期

一个参数从 Java 方法调用到最终绑定到 `PreparedStatement`，经历了三个阶段：

**阶段一：参数收集**（`MapperMethod` 层）

当 `MapperProxy` 拦截接口调用时，`MapperMethod.execute()` 会先对参数进行预处理——将方法的参数数组解析为 `SqlSession` 能理解的格式（单对象、`Map`，或带 `@Param` 标注的 `ParamMap`）。

**阶段二：参数映射**（`DynamicSqlSource`/`BoundSql` 层）

`DynamicSqlSource.getBoundSql()` 在遍历 SqlNode 树时，会将 SQL 中的每个 `#{propertyName}` 解析为一个 `ParameterMapping` 对象，记录其属性路径、期望的 JDBC 类型、对应的 TypeHandler 等信息。所有 `ParameterMapping` 列表存储在 `BoundSql` 中。

**阶段三：参数绑定**（`ParameterHandler` 层）

`DefaultParameterHandler.setParameters()` 遍历 `BoundSql.parameterMappings` 列表，从参数对象中提取每个属性的值，再通过对应的 `TypeHandler.setParameter()` 调用 `PreparedStatement.setXxx()` 完成最终的 JDBC 参数绑定。

### 1.2 BoundSql 与 ParameterMapping

`BoundSql` 是参数处理的核心数据容器：

```java
public class BoundSql {
    private final String sql;                         // 含有 ? 占位符的最终 SQL 字符串
    private final List<ParameterMapping> parameterMappings;  // 每个 ? 对应的参数映射
    private final Object parameterObject;             // 方法传入的原始参数对象
    private final Map<String, Object> additionalParameters;  // <bind> 等额外变量
    private final MetaObject metaParameters;          // additionalParameters 的反射包装
}
```

`ParameterMapping` 描述了一个 `#{}` 占位符的完整信息：

```java
public class ParameterMapping {
    private String property;           // 属性路径，如 "user.address.city"
    private ParameterMode mode;        // IN / OUT / INOUT（存储过程用）
    private Class<?> javaType;         // Java 类型（如 String.class）
    private JdbcType jdbcType;         // JDBC 类型（如 JdbcType.VARCHAR）
    private Integer numericScale;      // 小数位数（NUMERIC/DECIMAL 用）
    private TypeHandler<?> typeHandler; // 最终选定的 TypeHandler
    private String resultMapId;        // OUT 参数的 ResultMap（存储过程用）
    private String jdbcTypeName;
    private String expression;         // 实验性 OGNL 表达式
}
```

---

## 第 2 章 参数解析：从方法调用到 SqlSession

### 2.1 为什么需要参数转换

Mybatis 的 `SqlSession` API（如 `selectList(String statement, Object parameter)`）只接受一个 `Object` 类型的参数。但 Mapper 接口方法可能有多个参数：

```java
// 接口方法：两个参数
List<Order> selectByUserAndStatus(Long userId, String status);
```

如何将两个参数传给只接受一个 `Object` 的 `SqlSession`？答案是：`MapperMethod` 会将多个参数封装为一个 `Map`，再传给 `SqlSession`。

### 2.2 参数解析的三种模式

`MapperMethod` 内部的 `MethodSignature` 类负责分析方法签名，`ParamNameResolver` 负责实际的参数解析：

**模式一：无参数**

```java
List<User> selectAll();  // 无参数
```

`parameterObject = null`，`BoundSql` 的 `parameterMappings` 为空列表。

**模式二：单个参数（无 @Param 注解）**

```java
User selectById(Long id);               // 单个基本类型参数
List<Order> selectByUser(User user);    // 单个 POJO 参数
List<User> selectByIds(List<Long> ids); // 单个集合参数
```

直接将参数值本身（`Long`、`User` 对象、`List`）作为 `parameterObject` 传入。在 XML 中可以任意命名引用（`#{id}`、`#{anyName}` 均可），因为 Mybatis 会直接将整个参数对象作为属性查找的起点。

特别注意：`List` 和数组类型会被 `DefaultSqlSession.wrapCollection()` 包装为 `Map`：

```java
private Object wrapCollection(final Object object) {
    if (object instanceof Collection) {
        StrictMap<Object> map = new StrictMap<>();
        map.put("collection", object);  // key: "collection"
        if (object instanceof List) {
            map.put("list", object);    // key: "list"（额外的别名）
        }
        return map;
    } else if (object != null && object.getClass().isArray()) {
        StrictMap<Object> map = new StrictMap<>();
        map.put("array", object);       // key: "array"
        return map;
    }
    return object;
}
```

这就是为什么 `<foreach collection="list">` 和 `<foreach collection="collection">` 都能工作的原因。

**模式三：多个参数（有/无 @Param 注解）**

```java
// 无 @Param：Mybatis 会按位置生成默认参数名
List<Order> selectByUserAndStatus(Long userId, String status);
// XML 中只能用 #{param1}、#{param2} 引用（容易出错，不推荐）

// 有 @Param：指定参数名
List<Order> selectByUserAndStatus(@Param("userId") Long userId,
                                   @Param("status") String status);
// XML 中用 #{userId}、#{status} 引用（清晰可维护，推荐）
```

`ParamNameResolver.getNamedParams()` 将多个参数封装为 `Map`：

```java
public Object getNamedParams(Object[] args) {
    final int paramCount = names.size();
    if (args == null || paramCount == 0) {
        return null;
    } else if (!hasParamAnnotation && paramCount == 1) {
        // 单参数无 @Param：直接返回参数值（不封装为 Map）
        return args[names.firstKey()];
    } else {
        // 多参数或有 @Param：封装为 ParamMap
        final Map<String, Object> param = new ParamMap<>();
        int i = 0;
        for (Map.Entry<Integer, String> entry : names.entrySet()) {
            // key1: @Param 指定的名称（如 "userId"）
            param.put(entry.getValue(), args[entry.getKey()]);
            // key2: 通用名称 "param1"、"param2"...（作为备用）
            final String genericParamName = GENERIC_NAME_PREFIX + (i + 1);
            if (!names.containsValue(genericParamName)) {
                param.put(genericParamName, args[entry.getKey()]);
            }
            i++;
        }
        return param;
    }
}
```

### 2.3 @Param 的实现原理

`@Param` 注解的处理发生在 `ParamNameResolver` 的构造函数中，它在 `MapperMethod` 初始化时（不是执行时）一次性分析方法的参数签名：

```java
public ParamNameResolver(Configuration config, Method method) {
    final Class<?>[] paramTypes = method.getParameterTypes();
    final Annotation[][] paramAnnotations = method.getParameterAnnotations();
    final SortedMap<Integer, String> map = new TreeMap<>();
    int paramCount = paramAnnotations.length;
    
    for (int paramIndex = 0; paramIndex < paramCount; paramIndex++) {
        // 跳过特殊参数类型（RowBounds、ResultHandler 不作为 SQL 参数）
        if (isSpecialParameter(paramTypes[paramIndex])) {
            continue;
        }
        String name = null;
        // 扫描 @Param 注解
        for (Annotation annotation : paramAnnotations[paramIndex]) {
            if (annotation instanceof Param) {
                hasParamAnnotation = true;
                name = ((Param) annotation).value();  // 取 @Param("xxx") 中的名称
                break;
            }
        }
        if (name == null) {
            // 没有 @Param：尝试从编译时反射获取实际参数名（需要 -parameters 编译选项）
            if (config.isUseActualParamName()) {
                name = getActualParamName(method, paramIndex);
            }
            // 最终降级：用参数位置索引作为名称（"0"、"1"...）
            if (name == null) {
                name = String.valueOf(map.size());
            }
        }
        map.put(paramIndex, name);
    }
    names = Collections.unmodifiableSortedMap(map);
}
```

> [!info] useActualParamName 配置
> 从 Java 8 开始，可以在编译时加 `-parameters` 选项保留方法参数名信息，Mybatis 的 `useActualParamName=true`（默认）会尝试读取这些信息。这意味着在 Java 8+ 且使用了 `-parameters` 编译的项目中，即使不加 `@Param`，也可以用参数的实际名称（如 `#{userId}`）来引用多参数——前提是方法参数名与 XML 中的引用名一致。
>
> **生产建议**：不要依赖这个特性，始终显式添加 `@Param`，代码意图更清晰，不受编译选项的影响。

---

## 第 3 章 ParameterHandler：参数到 JDBC 的最后一公里

### 3.1 DefaultParameterHandler 的完整逻辑

`DefaultParameterHandler.setParameters()` 是参数绑定的执行者，其核心逻辑可以分为三步：

**第一步：遍历 ParameterMapping 列表**

对 `BoundSql` 中每个 `#{}` 占位符对应的 `ParameterMapping`，依次处理。

**第二步：从参数对象中提取属性值**

根据 `ParameterMapping.property`（属性路径），从 `parameterObject` 中提取对应的值：

```java
// 从参数对象中提取属性值的逻辑（简化版）
Object value;
String propertyName = parameterMapping.getProperty();

if (boundSql.hasAdditionalParameter(propertyName)) {
    // 优先检查 <bind> 等额外参数（DynamicContext 中绑定的变量）
    value = boundSql.getAdditionalParameter(propertyName);
} else if (parameterObject == null) {
    // 参数本身为 null
    value = null;
} else if (typeHandlerRegistry.hasTypeHandler(parameterObject.getClass())) {
    // 参数是基本类型（Long、String 等）——参数对象本身就是值
    // 这种情况下 propertyName 通常没有实际意义，直接用 parameterObject
    value = parameterObject;
} else {
    // 参数是 POJO 或 Map——通过 MetaObject 按属性路径提取值
    MetaObject metaObject = configuration.newMetaObject(parameterObject);
    value = metaObject.getValue(propertyName);
    // MetaObject.getValue 支持嵌套路径，如 "user.address.city"
    // 对于 Map 参数，等价于 map.get(propertyName)
}
```

**第三步：通过 TypeHandler 将值绑定到 PreparedStatement**

```java
// 获取 TypeHandler（可能在 ParameterMapping 中已指定，也可能需要动态查找）
TypeHandler typeHandler = parameterMapping.getTypeHandler();
JdbcType jdbcType = parameterMapping.getJdbcType();
if (value == null && jdbcType == null) {
    // 值为 null 且未指定 jdbcType 时，使用全局默认的 jdbcTypeForNull 配置
    jdbcType = configuration.getJdbcTypeForNull();
}
// 调用 TypeHandler，将 Java 值通过 JDBC 写入 PreparedStatement
typeHandler.setParameter(ps, i + 1, value, jdbcType);
```

### 3.2 MetaObject：Mybatis 的反射利器

`MetaObject` 是 Mybatis 内部的反射工具，封装了对 Java 对象属性的读写操作，支持：
- 嵌套属性路径：`user.address.city` → `user.getAddress().getCity()`；
- Map 键访问：`map['key']`；
- 集合索引：`list[0]`、`array[1]`；
- 混合路径：`orders[0].amount`。

相比直接使用 JDK 反射 API，`MetaObject` 有两个关键优化：
1. **反射信息缓存**：通过 `ReflectorFactory` 缓存每个类的反射元数据（字段、getter/setter、构造函数），避免重复反射扫描；
2. **空指针安全**：`getValue()` 在遇到中间节点为 `null` 时返回 `null`，而非抛 `NullPointerException`。

---

## 第 4 章 TypeHandler：Java 类型与 JDBC 类型的桥梁

### 4.1 TypeHandler 是什么，为什么需要它

[[JDBC]] 的 `PreparedStatement` 提供了一系列 `setXxx()` 方法（`setInt()`、`setString()`、`setTimestamp()`……），调用哪个方法取决于 Java 参数的类型。同样，`ResultSet` 提供了 `getInt()`、`getString()`、`getTimestamp()` 等方法。

如果没有 `TypeHandler`，每次参数绑定都需要写这样的分支代码：

```java
// 没有 TypeHandler 时的噩梦
if (value instanceof Integer) {
    ps.setInt(index, (Integer) value);
} else if (value instanceof String) {
    ps.setString(index, (String) value);
} else if (value instanceof LocalDateTime) {
    ps.setTimestamp(index, Timestamp.valueOf((LocalDateTime) value));
} else if (value instanceof Boolean) {
    ps.setBoolean(index, (Boolean) value);
}
// ... 还有几十种类型
```

`TypeHandler` 将这个类型分发逻辑封装为统一接口，每个 `TypeHandler` 实现处理一种 Java 类型到 JDBC 类型的转换：

```java
public interface TypeHandler<T> {
    // 写入：将 Java 值设置到 PreparedStatement
    void setParameter(PreparedStatement ps, int i, T parameter, JdbcType jdbcType)
        throws SQLException;
    
    // 读取：从 ResultSet 中按列名取出值
    T getResult(ResultSet rs, String columnName) throws SQLException;
    
    // 读取：从 ResultSet 中按列索引取出值
    T getResult(ResultSet rs, int columnIndex) throws SQLException;
    
    // 读取：从 CallableStatement 的 OUT 参数取出值（存储过程）
    T getResult(CallableStatement cs, int columnIndex) throws SQLException;
}
```

Mybatis 内置了 40+ 种 `TypeHandler`，覆盖所有常见 Java 类型。

### 4.2 内置 TypeHandler 全览

以下是 Mybatis 内置的主要 `TypeHandler`：

| Java 类型 | TypeHandler | JDBC 方法 |
| --- | --- | --- |
| `Integer`/`int` | `IntegerTypeHandler` | `setInt` / `getInt` |
| `Long`/`long` | `LongTypeHandler` | `setLong` / `getLong` |
| `Double`/`double` | `DoubleTypeHandler` | `setDouble` / `getDouble` |
| `String` | `StringTypeHandler` | `setString` / `getString` |
| `Boolean`/`boolean` | `BooleanTypeHandler` | `setBoolean` / `getBoolean` |
| `Date` (java.util) | `DateTypeHandler` | `setTimestamp` / `getTimestamp` |
| `LocalDate` | `LocalDateTypeHandler` | `setObject(DATE)` / `getObject(LocalDate)` |
| `LocalDateTime` | `LocalDateTimeTypeHandler` | `setObject(TIMESTAMP)` / `getObject(LocalDateTime)` |
| `BigDecimal` | `BigDecimalTypeHandler` | `setBigDecimal` / `getBigDecimal` |
| `byte[]` | `ByteArrayTypeHandler` | `setBytes` / `getBytes` |
| `Enum` | `EnumTypeHandler` | `setString(name())` / `enum.valueOf()` |
| `Enum` | `EnumOrdinalTypeHandler` | `setInt(ordinal())` / 按序号反查 |
| `Object` | `ObjectTypeHandler` | `setObject` / `getObject` |

### 4.3 TypeHandlerRegistry：两维度的注册与查找

`TypeHandlerRegistry` 是 TypeHandler 的注册中心，使用两个维度的索引：

**维度一：Java 类型 → Map<JdbcType, TypeHandler>**

```java
// TYPE_HANDLER_MAP：Map<Java类型, Map<JDBC类型, TypeHandler>>
private final Map<Type, Map<JdbcType, TypeHandler<?>>> TYPE_HANDLER_MAP = new ConcurrentHashMap<>();
```

**维度二：TypeHandler 类 → TypeHandler 实例**

```java
// ALL_TYPE_HANDLERS_MAP：Map<TypeHandler类, TypeHandler实例>
private final Map<Class<?>, TypeHandler<?>> ALL_TYPE_HANDLERS_MAP = new HashMap<>();
```

**查找逻辑（按优先级递减）**：

```java
public <T> TypeHandler<T> getTypeHandler(Class<T> type, JdbcType jdbcType) {
    return getTypeHandler((Type) type, jdbcType);
}

private <T> TypeHandler<T> getTypeHandler(Type type, JdbcType jdbcType) {
    // 1. 精确匹配：Java类型 + JDBC类型
    Map<JdbcType, TypeHandler<?>> jdbcHandlerMap = getJdbcHandlerMap(type);
    TypeHandler<?> handler = null;
    if (jdbcHandlerMap != null) {
        handler = jdbcHandlerMap.get(jdbcType);           // 2. Java类型 + 精确JDBC类型
        if (handler == null) {
            handler = jdbcHandlerMap.get(null);           // 3. Java类型 + null JDBC类型（通用处理器）
        }
        if (handler == null) {
            // 4. 如果只有一个 TypeHandler，直接使用（无歧义）
            if (jdbcHandlerMap.size() == 1) {
                handler = jdbcHandlerMap.values().iterator().next();
            }
        }
    }
    // 5. 降级：用 Object 类型的 TypeHandler
    return (TypeHandler<T>) handler;
}
```

**注册 TypeHandler** 可以通过三种方式：

```xml
<!-- 方式一：mybatis-config.xml 全局注册 -->
<typeHandlers>
    <!-- 处理 com.example.domain.JsonField 类型 -->
    <typeHandler handler="com.example.handler.JsonTypeHandler"
                 javaType="com.example.domain.JsonField"/>
    <!-- 扫描包下所有 TypeHandler（需有 @MappedTypes、@MappedJdbcTypes 注解） -->
    <package name="com.example.handler"/>
</typeHandlers>
```

```xml
<!-- 方式二：在具体的 ParameterMapping 中指定（优先级最高）-->
<result column="extra_info" property="extraInfo"
        typeHandler="com.example.handler.JsonTypeHandler"/>
```

```java
// 方式三：@MappedTypes + @MappedJdbcTypes 注解（扫描注册时自动关联）
@MappedTypes(JsonField.class)
@MappedJdbcTypes(JdbcType.VARCHAR)
public class JsonTypeHandler extends BaseTypeHandler<JsonField> { ... }
```

---

## 第 5 章 自定义 TypeHandler：三大生产场景

### 5.1 场景一：JSON 字段存储

现代业务中经常需要将 Java 对象作为 JSON 字符串存储到数据库的 `VARCHAR`/`TEXT` 列中，并在读取时自动反序列化。手动在 Service 层做序列化/反序列化既繁琐又容易遗漏，TypeHandler 是最优雅的解决方案。

```java
/**
 * 通用 JSON TypeHandler（基于 Jackson）
 * 用于将任意 Java 对象序列化为 JSON 字符串存储，读取时自动反序列化
 */
@MappedJdbcTypes(JdbcType.VARCHAR)
public abstract class AbstractJsonTypeHandler<T> extends BaseTypeHandler<T> {
    
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private final Class<T> type;
    
    // 抽象类，子类指定具体的 Java 类型
    protected AbstractJsonTypeHandler(Class<T> type) {
        this.type = type;
    }
    
    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, T parameter, JdbcType jdbcType)
            throws SQLException {
        try {
            // 序列化为 JSON 字符串，写入数据库
            ps.setString(i, OBJECT_MAPPER.writeValueAsString(parameter));
        } catch (JsonProcessingException e) {
            throw new TypeException("Failed to serialize to JSON: " + parameter, e);
        }
    }
    
    @Override
    public T getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return toObject(rs.getString(columnName));
    }
    
    @Override
    public T getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return toObject(rs.getString(columnIndex));
    }
    
    @Override
    public T getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return toObject(cs.getString(columnIndex));
    }
    
    private T toObject(String content) {
        if (content == null || content.isEmpty()) {
            return null;
        }
        try {
            return OBJECT_MAPPER.readValue(content, type);
        } catch (IOException e) {
            throw new TypeException("Failed to deserialize JSON: " + content, e);
        }
    }
}

// 具体类型的子类——处理 List<Tag> 类型
@MappedTypes(List.class)
public class TagListTypeHandler extends AbstractJsonTypeHandler<List<Tag>> {
    public TagListTypeHandler() {
        // Jackson 处理泛型类型需要 TypeReference
        super((Class<List<Tag>>) (Class<?>) List.class);
    }
    
    @Override
    public List<Tag> getNullableResult(ResultSet rs, String columnName) throws SQLException {
        String json = rs.getString(columnName);
        if (json == null) return null;
        try {
            return OBJECT_MAPPER.readValue(json, new TypeReference<List<Tag>>() {});
        } catch (IOException e) {
            throw new TypeException("Failed to deserialize tag list", e);
        }
    }
    // ... 同理实现其他 getNullableResult 方法
}
```

在 Mapper XML 中使用：

```xml
<resultMap id="ArticleResultMap" type="Article">
    <id column="id" property="id"/>
    <result column="title" property="title"/>
    <!-- 指定 TypeHandler，从 VARCHAR 列读取时自动反序列化为 List<Tag> -->
    <result column="tags" property="tags" typeHandler="com.example.handler.TagListTypeHandler"/>
</resultMap>

<insert id="insertArticle" parameterType="Article">
    INSERT INTO articles (title, tags) VALUES (
        #{title},
        #{tags, typeHandler=com.example.handler.TagListTypeHandler}
    )
</insert>
```

### 5.2 场景二：枚举类型映射

Mybatis 默认提供两个枚举 TypeHandler：
- `EnumTypeHandler`（默认）：存储枚举的 `name()`（字符串），如 `"ACTIVE"`；
- `EnumOrdinalTypeHandler`：存储枚举的 `ordinal()`（整数位置），如 `0`、`1`、`2`。

但在实际业务中，枚举往往有业务含义的 `code` 字段（如 `OrderStatus.PENDING` 对应 code `1`，`OrderStatus.SHIPPED` 对应 code `3`），而不是用 name 或 ordinal 存储。此时需要自定义 TypeHandler：

```java
// 定义具有业务 code 的枚举接口
public interface CodeEnum {
    Integer getCode();
    
    // 根据 code 反查枚举实例
    static <T extends Enum<T> & CodeEnum> T fromCode(Class<T> enumClass, Integer code) {
        for (T enumConstant : enumClass.getEnumConstants()) {
            if (enumConstant.getCode().equals(code)) {
                return enumConstant;
            }
        }
        throw new IllegalArgumentException("No enum constant with code " + code + " in " + enumClass.getName());
    }
}

// 订单状态枚举
public enum OrderStatus implements CodeEnum {
    PENDING(1, "待支付"),
    PAID(2, "已支付"),
    SHIPPED(3, "已发货"),
    DELIVERED(4, "已送达"),
    CANCELLED(5, "已取消");
    
    private final Integer code;
    private final String desc;
    
    OrderStatus(Integer code, String desc) {
        this.code = code;
        this.desc = desc;
    }
    
    @Override
    public Integer getCode() { return code; }
}

// 通用的 CodeEnum TypeHandler（支持任意实现了 CodeEnum 的枚举）
public class CodeEnumTypeHandler<E extends Enum<E> & CodeEnum> extends BaseTypeHandler<E> {
    private final Class<E> type;
    
    public CodeEnumTypeHandler(Class<E> type) {
        if (type == null) throw new IllegalArgumentException("Type argument cannot be null");
        this.type = type;
    }
    
    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, E parameter, JdbcType jdbcType)
            throws SQLException {
        // 存储业务 code（Integer）
        ps.setInt(i, parameter.getCode());
    }
    
    @Override
    public E getNullableResult(ResultSet rs, String columnName) throws SQLException {
        int code = rs.getInt(columnName);
        return rs.wasNull() ? null : CodeEnum.fromCode(type, code);
    }
    
    @Override
    public E getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        int code = rs.getInt(columnIndex);
        return rs.wasNull() ? null : CodeEnum.fromCode(type, code);
    }
    
    @Override
    public E getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        int code = cs.getInt(columnIndex);
        return cs.wasNull() ? null : CodeEnum.fromCode(type, code);
    }
}
```

全局注册（让所有实现了 `CodeEnum` 的枚举都自动使用此 TypeHandler）：

```java
// 在 Mybatis-Spring Boot Starter 中，通过 SqlSessionFactoryBean 配置
@Bean
public SqlSessionFactory sqlSessionFactory(DataSource dataSource) throws Exception {
    SqlSessionFactoryBean factoryBean = new SqlSessionFactoryBean();
    factoryBean.setDataSource(dataSource);
    
    // 扫描所有枚举类型，如果实现了 CodeEnum，注册 CodeEnumTypeHandler
    TypeHandlerRegistry registry = factoryBean.getObject().getConfiguration().getTypeHandlerRegistry();
    
    // 扫描枚举包，批量注册
    Reflections reflections = new Reflections("com.example.enums");
    Set<Class<? extends CodeEnum>> codeEnums = reflections.getSubTypesOf(CodeEnum.class)
        .stream()
        .filter(Class::isEnum)
        .collect(Collectors.toSet());
    
    for (Class<?> enumClass : codeEnums) {
        registry.register(enumClass, new CodeEnumTypeHandler(enumClass));
    }
    
    return factoryBean.getObject();
}
```

或者更简洁地通过 `application.yml` 配置：

```yaml
mybatis:
  type-handlers-package: com.example.handler  # 扫描自定义 TypeHandler 包
```

### 5.3 场景三：加密字段处理

对于包含 PII（个人身份信息）的字段（身份证号、手机号、银行卡号），有时需要在数据库层面加密存储，在 Java 代码中透明使用明文。TypeHandler 是实现字段级透明加解密的优雅方案：

```java
/**
 * 加密字段 TypeHandler
 * 写入时自动 AES 加密，读取时自动 AES 解密
 * 数据库中存储密文（BASE64 编码的 AES 密文）
 */
public class EncryptedStringTypeHandler extends BaseTypeHandler<String> {
    // 密钥应从配置中心获取，不要硬编码
    private static final AESEncryptor ENCRYPTOR = AESEncryptor.getInstance();
    
    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, String parameter, JdbcType jdbcType)
            throws SQLException {
        // 写入数据库时：明文 → 密文
        String encrypted = ENCRYPTOR.encrypt(parameter);
        ps.setString(i, encrypted);
    }
    
    @Override
    public String getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return decrypt(rs.getString(columnName));
    }
    
    @Override
    public String getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return decrypt(rs.getString(columnIndex));
    }
    
    @Override
    public String getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return decrypt(cs.getString(columnIndex));
    }
    
    private String decrypt(String encrypted) {
        if (encrypted == null || encrypted.isEmpty()) {
            return null;
        }
        return ENCRYPTOR.decrypt(encrypted);
    }
}
```

使用示例：

```xml
<resultMap id="UserResultMap" type="User">
    <id column="id" property="id"/>
    <result column="name" property="name"/>
    <!-- 手机号字段：数据库存密文，Java 层自动透明解密 -->
    <result column="phone" property="phone" 
            typeHandler="com.example.handler.EncryptedStringTypeHandler"/>
    <!-- 身份证号：同上 -->
    <result column="id_card" property="idCard"
            typeHandler="com.example.handler.EncryptedStringTypeHandler"/>
</resultMap>
```

> [!warning] 加密字段的查询限制
> 使用 TypeHandler 在字段级别加密后，**无法再对该字段做精确查询**（因为数据库存的是密文，`WHERE phone = '13800000000'` 找不到任何结果）。
>
> 解决方案：
> 1. 对于需要精确查询的字段（如手机号），在数据库中额外存储一个"查询索引"（对明文做哈希，如 SHA256，可以用于精确匹配但无法反推原文）；
> 2. 对于只需要展示不需要查询的字段（如完整的身份证号），直接用 TypeHandler 透明加解密即可。

---

## 第 6 章 JdbcType 与空值处理

### 6.1 为什么 null 值需要指定 jdbcType

当 Java 参数为 `null` 时，Mybatis 需要调用 `PreparedStatement.setNull(int parameterIndex, int sqlType)` 来告诉数据库这是一个 `NULL` 值，而 `setNull()` 需要指定 JDBC 类型（`sqlType`）。

如果不指定 `jdbcType`，Mybatis 会使用 `configuration.jdbcTypeForNull` 的配置值（默认是 `JdbcType.OTHER`）。大多数数据库（MySQL、PostgreSQL）对 `OTHER` 类型的 NULL 都能处理，但 Oracle 对此很挑剔——Oracle 要求传入明确的 JDBC 类型，遇到 `OTHER` 类型的 NULL 会抛出异常。

### 6.2 解决方案

```xml
<!-- 方案一：在 #{} 中指定 jdbcType -->
INSERT INTO users (name, email, phone) VALUES (
    #{name},
    #{email, jdbcType=VARCHAR},
    #{phone, jdbcType=VARCHAR}
)

<!-- 方案二：全局配置（对所有 null 值生效） -->
```

```yaml
# application.yml
mybatis:
  configuration:
    jdbc-type-for-null: 'NULL'  # 或 VARCHAR
```

```xml
<!-- mybatis-config.xml -->
<settings>
    <setting name="jdbcTypeForNull" value="NULL"/>
</settings>
```

`JdbcType.NULL` 会调用 `ps.setNull(i, Types.NULL)`，这对所有主流数据库都兼容。

---

## 总结

参数处理是 Mybatis 中"看不见的基础设施"，掌握它是排查参数绑定类问题的关键：

- **参数解析**的三种模式：无参数（null）、单参数（直接传值，List/数组被包装为 Map）、多参数（`@Param` 注解指定名称，封装为 `ParamMap`）；不加 `@Param` 的多参数只能用 `#{param1}`、`#{param2}` 引用，极易出错——生产中**始终显式加 `@Param`**；

- **`ParameterHandler`** 的绑定流程：遍历 `BoundSql.parameterMappings` → 用 `MetaObject` 按属性路径从参数对象提取值 → 交由对应 `TypeHandler` 调用 `ps.setXxx()` 绑定；

- **`TypeHandler`** 是 Java 类型与 JDBC 类型的桥梁，`TypeHandlerRegistry` 按 Java 类型 + JDBC 类型两个维度查找处理器；自定义 TypeHandler 的三大典型场景：JSON 字段（序列化/反序列化对象）、枚举（按业务 code 存储）、加密字段（透明加解密）；

- **null 值处理**：Oracle 环境必须指定 `jdbcType`，MySQL/PostgreSQL 通常无此要求，但全局设置 `jdbcTypeForNull=NULL` 是最稳妥的做法；

- **`${}` vs `#{}`**（上一篇重申）：`#{}` 通过 TypeHandler 安全绑定，`${}` 直接字符串替换有注入风险。

下一篇，我们深入结果映射的核心——`ResultMap` 的嵌套关联（`<association>`/`<collection>`）、N+1 问题的本质、延迟加载的代理机制：[[05 结果映射——ResultMap的嵌套映射与延迟加载]]。

---

> [!note] 参考资料
> - `org.apache.ibatis.executor.parameter.DefaultParameterHandler` 源码
> - `org.apache.ibatis.type.TypeHandlerRegistry` 源码
> - `org.apache.ibatis.reflection.ParamNameResolver` 源码
> - [Mybatis 官方文档 - TypeHandlers](https://mybatis.org/mybatis-3/configuration.html#typeHandlers)
