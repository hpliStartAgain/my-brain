---
title: "动态SQL——OGNL表达式与SqlNode解析树"
date: 2026-03-04
tags: [Java, Mybatis, 动态SQL, OGNL, SqlNode, DynamicSqlSource, if, foreach, choose, trim, SQL注入]
aliases: []
---

# 动态SQL——OGNL表达式与SqlNode解析树

## 摘要

动态 SQL 是 Mybatis 相比原生 JDBC 最具价值的能力之一——它允许开发者根据运行时参数动态构建 SQL 语句，彻底消除了"拼接 SQL 字符串"的痛苦。Mybatis 的动态 SQL 底层依托两个核心机制：**OGNL 表达式引擎**（负责对 `<if test="...">` 等条件进行运行时求值）和 **`SqlNode` 组合树**（将 XML 中的动态标签编译为可遍历的树形结构，每次执行时遍历该树生成最终 SQL）。本文深入剖析这两个机制的工作原理，逐一分析 `<if>`、`<choose>`、`<where>`、`<set>`、`<trim>`、`<foreach>` 等核心标签的实现细节，并重点讨论 `${}` 拼接与 `#{}` 占位符的本质差异，以及由此引发的 SQL 注入风险和性能影响。

---

## 第 1 章 动态 SQL 的本质问题

### 1.1 没有动态 SQL 时的噩梦

在没有动态 SQL 能力的年代，开发者如何处理"根据条件查询"这类需求？手动拼接字符串：

```java
// 反模式：手动拼接 SQL，错误频发、难以维护
public List<User> searchUsers(String name, Integer status, LocalDate createdAfter) {
    StringBuilder sql = new StringBuilder("SELECT * FROM users WHERE 1=1");
    List<Object> params = new ArrayList<>();
    
    if (name != null && !name.isEmpty()) {
        sql.append(" AND name LIKE ?");
        params.add("%" + name + "%");
    }
    if (status != null) {
        sql.append(" AND status = ?");
        params.add(status);
    }
    if (createdAfter != null) {
        sql.append(" AND created_at > ?");
        params.add(createdAfter);
    }
    
    // 手动维护参数索引与 SQL 中 ? 的对应关系——极易出错
    PreparedStatement ps = conn.prepareStatement(sql.toString());
    for (int i = 0; i < params.size(); i++) {
        ps.setObject(i + 1, params.get(i));
    }
    // ...
}
```

这段代码有几个让人头疼的问题：SQL 逻辑与 Java 代码深度耦合、字符串拼接容易遗漏空格或拼错语法、参数索引手动维护极易出错、单元测试难写（需要模拟 SQL 拼接的各种分支）。

Mybatis 动态 SQL 的答案：

```xml
<select id="searchUsers" resultType="User">
    SELECT * FROM users
    <where>
        <if test="name != null and name != ''">
            AND name LIKE CONCAT('%', #{name}, '%')
        </if>
        <if test="status != null">
            AND status = #{status}
        </if>
        <if test="createdAfter != null">
            AND created_at > #{createdAfter}
        </if>
    </where>
</select>
```

XML 中的 SQL 逻辑清晰可读，条件表达式与 Java 代码分离，`<where>` 标签自动处理 `WHERE` 关键字和多余的 `AND`/`OR` 前缀——这背后的实现机制，正是本文要深入剖析的主题。

### 1.2 动态 SQL 的两个核心问题

Mybatis 在处理动态 SQL 时需要解决两个核心问题：

**问题一：如何求值条件表达式？**

`<if test="name != null and name != ''">` 中的 `name != null and name != ''` 是一个表达式，需要在运行时根据参数对象进行求值。Mybatis 选择了 OGNL（Object-Graph Navigation Language）表达式引擎来完成这个工作。

**问题二：如何把 XML 标签树转为 SQL 字符串？**

XML 中的动态标签（`<if>`、`<foreach>` 等）形成了一棵嵌套结构，Mybatis 需要将这棵 XML 树在初始化时编译为内部的 `SqlNode` 树，然后在每次执行时遍历 `SqlNode` 树，根据运行时参数决定哪些节点生效，最终拼出完整 SQL。

---

## 第 2 章 OGNL：动态条件的求值引擎

### 2.1 OGNL 是什么

[[OGNL]]（Object-Graph Navigation Language，对象图导航语言）是一个用于 Java 对象图的表达式语言，最早在 WebWork（Struts 2 的前身）中广泛使用。它的核心能力是：

1. **属性访问**：通过 `user.address.city` 这样的点路径，访问嵌套对象的属性；
2. **方法调用**：`name.toUpperCase()`、`list.size()`；
3. **算术和逻辑运算**：`age > 18`、`name != null and name != ''`；
4. **集合操作**：`list[0]`、`map['key']`；
5. **比较和判空**：`status == 'ACTIVE'`、`items != null`。

Mybatis 将 OGNL 集成为动态 SQL 的条件求值引擎。在 `<if test="...">` 中写的表达式，就是 OGNL 表达式，在运行时由 `OgnlCache`（Mybatis 对 OGNL 的封装）求值。

### 2.2 OGNL 的上下文：参数如何传入

当 Mybatis 解析 `<if test="expression">` 时，它需要给 OGNL 提供一个"上下文"（Context），让表达式中的变量名能够解析到实际的参数值。这个上下文就是 `DynamicContext`：

```java
public class DynamicContext {
    // 存储参数的 Map，key 是参数名，value 是参数值
    private final ContextMap bindings;
    // 最终拼接的 SQL 文本（StringBuilder）
    private final StringBuilder sqlBuilder = new StringBuilder();
    // 用于 <foreach> 的唯一性索引（防止多个 foreach 的参数名冲突）
    private int uniqueNumber = 0;
    
    public DynamicContext(Configuration configuration, Object parameterObject) {
        // 将参数包装为 ContextMap，供 OGNL 访问
        if (parameterObject != null && !(parameterObject instanceof Map)) {
            // 如果参数是 POJO，用 MetaObject 包装（支持属性反射访问）
            MetaObject metaObject = configuration.newMetaObject(parameterObject);
            bindings = new ContextMap(metaObject, ...);
        } else {
            // 如果参数是 Map（多参数时 Mybatis 会包装为 Map），直接放入
            bindings = new ContextMap(null, ...);
            bindings.putAll((Map) parameterObject);
        }
        // 特殊变量 _parameter：指向整个参数对象本身
        bindings.put(PARAMETER_OBJECT_KEY, parameterObject);
        // 特殊变量 _databaseId：当前数据库类型（mysql/oracle 等）
        bindings.put(DATABASE_ID_KEY, configuration.getDatabaseId());
    }
}
```

### 2.3 OGNL 表达式的常用语法

在 Mybatis 的动态 SQL 中，`test` 属性接受标准 OGNL 表达式：

```xml
<!-- 基础判空 -->
<if test="name != null">...</if>
<if test="name != null and name != ''">...</if>

<!-- 嵌套属性访问 -->
<if test="user.address != null and user.address.city != null">
    AND city = #{user.address.city}
</if>

<!-- 集合判断 -->
<if test="ids != null and ids.size() > 0">...</if>
<if test="tags != null and !tags.isEmpty()">...</if>

<!-- 枚举比较（注意：@符号访问静态字段/方法）-->
<if test="status == @com.example.enums.Status@ACTIVE">...</if>

<!-- 字符串内容比较（注意：单引号内用双引号，或转义）-->
<if test='type == "VIP"'>...</if>
<if test="type == 'VIP'">...</if>  <!-- 也可以用单引号 -->

<!-- 方法调用 -->
<if test="name.startsWith('admin')">...</if>

<!-- 数字比较 -->
<if test="age != null and age >= 18">...</if>
```

> [!warning] OGNL 中的常见陷阱
>
> **陷阱一：字符与字符串的混淆**
> OGNL 中 `'A'` 是字符（`char`），`"A"` 是字符串（`String`）。如果参数是 `String` 类型，用 `'A'` 比较会因类型不匹配而导致意外结果：
> ```xml
> <!-- ❌ 可能出问题：参数是 String，但用 char 'Y' 比较 -->
> <if test="flag == 'Y'">...</if>
> <!-- ✅ 正确：用双引号（在 XML 中需要 &quot; 或外层用单引号）-->
> <if test='flag == "Y"'>...</if>
> ```
>
> **陷阱二：`and`/`or` vs `&&`/`||`**
> OGNL 支持 `&&` 和 `||`，但在 XML 中 `&` 是保留字符（需要转义为 `&amp;`），因此推荐使用 `and`/`or` 代替 `&&`/`||`：
> ```xml
> <!-- ❌ XML 中 && 需要转义 -->
> <if test="name != null &amp;&amp; name != ''">...</if>
> <!-- ✅ 使用 and/or -->
> <if test="name != null and name != ''">...</if>
> ```

---

## 第 3 章 SqlNode 组合树：动态 SQL 的编译产物

### 3.1 组合模式的应用

Mybatis 的动态 SQL 标签在 XML 中形成嵌套结构——`<select>` 包含 `<where>`，`<where>` 包含多个 `<if>`，`<if>` 内可能还有 `<choose>` 等。这种递归嵌套结构天然适合用[[组合模式]]表达。

Mybatis 将 XML 标签树编译为 `SqlNode` 接口的实现体系：

```java
// SqlNode 接口：所有节点的统一抽象
public interface SqlNode {
    // apply：根据运行时上下文，将本节点产生的 SQL 片段追加到 context.sqlBuilder
    // 返回 true 表示本节点产生了有效内容（对 <trim> 类节点有影响）
    boolean apply(DynamicContext context);
}
```

`SqlNode` 的实现类体系：

| 实现类 | 对应 XML 标签/元素 | 职责 |
| --- | --- | --- |
| `MixedSqlNode` | 容器节点 | 持有子节点列表，依次调用每个子节点的 `apply()` |
| `StaticTextSqlNode` | 纯文本（无动态成分） | 直接将文本追加到 sqlBuilder |
| `TextSqlNode` | 含 `${}` 的文本 | 解析 `${}` 并直接替换为字符串值 |
| `IfSqlNode` | `<if>` | 用 OGNL 求值 test 表达式，决定是否调用子节点 |
| `ChooseSqlNode` | `<choose>` | 依次求值 `<when>` 条件，找到第一个成立的执行 |
| `WhereSqlNode` | `<where>` | 包装 `TrimSqlNode`，自动处理 WHERE 关键字和 AND/OR 前缀 |
| `SetSqlNode` | `<set>` | 包装 `TrimSqlNode`，自动处理 SET 关键字和末尾逗号 |
| `TrimSqlNode` | `<trim>` | 通用版本：添加前缀/后缀，删除多余的 AND/OR/逗号等 |
| `ForEachSqlNode` | `<foreach>` | 遍历集合，为每个元素生成 SQL 片段，支持分隔符 |
| `VarDeclSqlNode` | `<bind>` | 声明一个 OGNL 变量，绑定到 context |

### 3.2 SqlNode 树的构建：初始化时完成

`XMLScriptBuilder` 在解析 Mapper XML 时，将每个 SQL 语句的标签体解析为一棵 `SqlNode` 树：

```java
public class XMLScriptBuilder extends BaseBuilder {
    public SqlSource parseScriptNode() {
        // parseDynamicTags：递归解析 XNode，构建 SqlNode 树
        MixedSqlNode rootSqlNode = parseDynamicTags(context);
        SqlSource sqlSource;
        if (isDynamic) {
            // 含有动态标签（<if>/<foreach> 等）或 ${} 拼接
            sqlSource = new DynamicSqlSource(configuration, rootSqlNode);
        } else {
            // 纯静态 SQL（只有 #{} 占位符）
            sqlSource = new RawSqlSource(configuration, rootSqlNode, parameterType);
        }
        return sqlSource;
    }
    
    protected MixedSqlNode parseDynamicTags(XNode node) {
        List<SqlNode> contents = new ArrayList<>();
        NodeList children = node.getNode().getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            XNode child = node.newXNode(children.item(i));
            if (child.getNode().getNodeType() == Node.CDATA_SECTION_NODE
                    || child.getNode().getNodeType() == Node.TEXT_NODE) {
                // 文本节点：检查是否含有 ${}，决定用 TextSqlNode 还是 StaticTextSqlNode
                String data = child.getStringBody("");
                TextSqlNode textSqlNode = new TextSqlNode(data);
                if (textSqlNode.isDynamic()) {
                    contents.add(textSqlNode);  // 含 ${}，是动态节点
                    isDynamic = true;
                } else {
                    contents.add(new StaticTextSqlNode(data));  // 纯静态文本
                }
            } else if (child.getNode().getNodeType() == Node.ELEMENT_NODE) {
                // 元素节点（<if>/<where>/<foreach> 等）
                String nodeName = child.getNode().getNodeName();
                // 找到对应的 NodeHandler（每种标签有专门的处理器）
                NodeHandler handler = nodeHandlerMap.get(nodeName);
                // 由 handler 创建对应的 SqlNode 子类
                handler.handleNode(child, contents);
                isDynamic = true;
            }
        }
        return new MixedSqlNode(contents);
    }
}
```

以下是一个具体示例——`<select>` 语句对应的 SqlNode 树结构：

```xml
<select id="searchUsers" resultType="User">
    SELECT * FROM users
    <where>
        <if test="name != null">
            AND name = #{name}
        </if>
        <if test="status != null">
            AND status = #{status}
        </if>
    </where>
</select>
```

编译后的 SqlNode 树（初始化时构建，存储在 `MappedStatement.sqlSource` 中）：

```
MixedSqlNode（根节点）
├── StaticTextSqlNode: "SELECT * FROM users"
└── WhereSqlNode（对应 <where>）
    └── MixedSqlNode
        ├── IfSqlNode（test="name != null"）
        │   └── StaticTextSqlNode: "AND name = #{name}"
        └── IfSqlNode（test="status != null"）
            └── StaticTextSqlNode: "AND status = #{status}"
```

### 3.3 运行时：apply() 遍历树生成 SQL

每次执行 SQL 时，`DynamicSqlSource.getBoundSql()` 会创建一个 `DynamicContext`，然后调用根节点的 `apply(context)`，递归遍历整棵 `SqlNode` 树：

```java
public class DynamicSqlSource implements SqlSource {
    private final SqlNode rootSqlNode;
    
    public BoundSql getBoundSql(Object parameterObject) {
        // 创建运行时上下文（持有参数对象和 sqlBuilder）
        DynamicContext context = new DynamicContext(configuration, parameterObject);
        
        // 遍历整棵 SqlNode 树，各节点将 SQL 片段追加到 context.sqlBuilder
        rootSqlNode.apply(context);
        
        // 对生成的 SQL 进行后处理：将 #{} 替换为 ?，生成 ParameterMapping 列表
        SqlSourceBuilder sqlSourceParser = new SqlSourceBuilder(configuration);
        Class<?> parameterType = parameterObject == null ? Object.class : parameterObject.getClass();
        SqlSource sqlSource = sqlSourceParser.parse(
            context.getSql(),   // 含有 #{} 的 SQL 字符串
            parameterType,
            context.getBindings()
        );
        
        BoundSql boundSql = sqlSource.getBoundSql(parameterObject);
        // 将 <bind> 变量等附加参数也注入到 BoundSql
        context.getBindings().forEach(boundSql::setAdditionalParameter);
        return boundSql;
    }
}
```

---

## 第 4 章 核心标签的实现细节

### 4.1 `<if>`：条件分支

`IfSqlNode` 是最简单也最常用的动态节点：

```java
public class IfSqlNode implements SqlNode {
    private final ExpressionEvaluator evaluator;  // OGNL 求值器
    private final String test;                    // 条件表达式字符串
    private final SqlNode contents;              // 子节点（条件为真时才执行）
    
    public boolean apply(DynamicContext context) {
        // 用 OGNL 求值 test 表达式
        if (evaluator.evaluateBoolean(test, context.getBindings())) {
            // 条件为真：执行子节点，将子节点的 SQL 片段追加到 context
            contents.apply(context);
            return true;
        }
        return false;  // 条件为假：不产生任何 SQL 片段
    }
}
```

### 4.2 `<choose>/<when>/<otherwise>`：分支选择

`<choose>` 等价于 Java 的 `if-else if-else`：

```xml
<choose>
    <when test="status == 'VIP'">
        AND discount_rate = 0.8
    </when>
    <when test="status == 'MEMBER'">
        AND discount_rate = 0.9
    </when>
    <otherwise>
        AND discount_rate = 1.0
    </otherwise>
</choose>
```

`ChooseSqlNode` 的实现：

```java
public class ChooseSqlNode implements SqlNode {
    private final SqlNode defaultSqlNode;     // <otherwise> 对应的节点
    private final List<SqlNode> ifSqlNodes;   // <when> 对应的节点列表
    
    public boolean apply(DynamicContext context) {
        // 依次求值每个 <when> 条件，找到第一个为真的执行
        for (SqlNode sqlNode : ifSqlNodes) {
            if (sqlNode.apply(context)) {
                return true;  // 找到匹配的 <when>，后续 <when> 不再评估（短路）
            }
        }
        // 所有 <when> 都不满足：执行 <otherwise>
        if (defaultSqlNode != null) {
            defaultSqlNode.apply(context);
            return true;
        }
        return false;
    }
}
```

### 4.3 `<where>` 和 `<set>`：智能的 SQL 片段处理

`<where>` 和 `<set>` 是 `<trim>` 的语法糖，解决了 SQL 拼接中最常见的两个问题：

**`<where>` 的逻辑**：
- 如果子节点没有产生任何内容（所有 `<if>` 条件都为假），则整个 `<where>` 不输出任何内容（包括 `WHERE` 关键字本身）；
- 如果子节点产生了内容，自动在最前面加 `WHERE` 关键字，并去掉内容开头多余的 `AND`/`OR`。

**`<set>` 的逻辑**：
- 如果子节点没有产生内容，抛出异常（UPDATE 没有 SET 是语法错误）；
- 如果子节点产生了内容，自动加 `SET` 关键字，并去掉内容末尾多余的逗号 `,`。

它们都由 `TrimSqlNode` 实现：

```java
public class WhereSqlNode extends TrimSqlNode {
    // prefixesToOverride：要从内容开头删除的前缀
    private static List<String> prefixList = Arrays.asList("AND ", "OR ", "AND\n", "OR\n", "AND\r", "OR\r", "AND\t", "OR\t");
    
    public WhereSqlNode(Configuration configuration, SqlNode contents) {
        super(configuration, contents,
            "WHERE",         // prefix：如果有内容，添加到最前面
            prefixList,      // prefixesToOverride：从内容开头删除的前缀
            null,            // suffix：如果有内容，添加到最后面
            null);           // suffixesToOverride：从内容末尾删除的后缀
    }
}

public class SetSqlNode extends TrimSqlNode {
    private static List<String> suffixList = Arrays.asList(",");
    
    public SetSqlNode(Configuration configuration, SqlNode contents) {
        super(configuration, contents,
            "SET",           // prefix
            null,            // prefixesToOverride
            null,            // suffix
            suffixList);     // suffixesToOverride：从内容末尾删除的后缀（逗号）
    }
}
```

`TrimSqlNode.apply()` 的核心逻辑——先让子节点生成 SQL，再对生成结果进行前/后缀处理：

```java
public class TrimSqlNode implements SqlNode {
    private final SqlNode contents;
    private final String prefix;
    private final String suffix;
    private final List<String> prefixesToOverride;
    private final List<String> suffixesToOverride;
    
    public boolean apply(DynamicContext context) {
        // 先用子 context 收集子节点产生的 SQL 片段（不直接写入父 context）
        FilteredDynamicContext filteredDynamicContext = new FilteredDynamicContext(context);
        boolean contentApplied = contents.apply(filteredDynamicContext);
        // 再对收集到的 SQL 进行 trim 处理（删前缀、加前缀、删后缀、加后缀）
        filteredDynamicContext.applyAll();
        return contentApplied;
    }
}
```

**生产实践示例**——动态 UPDATE 语句：

```xml
<update id="updateUser">
    UPDATE users
    <set>
        <if test="name != null">name = #{name},</if>
        <if test="email != null">email = #{email},</if>
        <if test="status != null">status = #{status},</if>
    </set>
    WHERE id = #{id}
</update>
```

假设只传入了 `name` 和 `email`，子节点生成的原始内容是 `name = ?,email = ?,`，`<set>` 会：
1. 删除末尾的逗号 `,` → `name = ?,email = ?`
2. 在最前面加 `SET` → `SET name = ?,email = ?`

最终 SQL：`UPDATE users SET name = ?,email = ? WHERE id = ?`

---

## 第 5 章 `<foreach>`：集合迭代的精妙设计

### 5.1 `<foreach>` 的使用场景

`<foreach>` 是 Mybatis 中最强大也最容易用错的标签，主要用于两类场景：

**场景一：IN 查询**

```xml
<select id="selectByIds" resultType="User">
    SELECT * FROM users
    WHERE id IN
    <foreach collection="ids" item="id" open="(" separator="," close=")">
        #{id}
    </foreach>
</select>
```

对于 `ids = [1, 2, 3]`，生成：`SELECT * FROM users WHERE id IN (?, ?, ?)`

**场景二：批量插入**

```xml
<insert id="batchInsert">
    INSERT INTO orders (user_id, status, amount) VALUES
    <foreach collection="orders" item="order" separator=",">
        (#{order.userId}, #{order.status}, #{order.amount})
    </foreach>
</insert>
```

对于 3 条订单，生成：`INSERT INTO orders (...) VALUES (?,?,?),(?,?,?),(?,?,?)`

### 5.2 `<foreach>` 的参数含义

```xml
<foreach
    collection="list"    <!-- 要迭代的集合，对应参数名 -->
    item="user"          <!-- 每次迭代的元素变量名 -->
    index="idx"          <!-- 迭代索引（List 是 0,1,2...；Map 是 key） -->
    open="("             <!-- 整个 foreach 块的开头字符串 -->
    separator=","        <!-- 每两个元素之间的分隔符 -->
    close=")"            <!-- 整个 foreach 块的结尾字符串 -->
>
    #{user.id}
</foreach>
```

### 5.3 ForEachSqlNode 的实现：唯一性参数名

`ForEachSqlNode` 的实现中有一个关键细节：当集合有多个元素时，每个元素对应的 `#{item}` 最终都要绑定到 `PreparedStatement` 的不同位置，如何区分它们？

Mybatis 通过**给每个元素生成唯一的参数名**来解决：

```java
public class ForEachSqlNode implements SqlNode {
    public boolean apply(DynamicContext context) {
        // 从 context 获取 collection 对应的实际集合对象
        Iterable<?> iterable = evaluator.evaluateIterable(collectionExpression, context.getBindings());
        
        // 构建 "open" 前缀
        if (open != null) {
            context.appendSql(open);
        }
        
        int i = 0;
        for (Object o : iterable) {
            DynamicContext oldContext = context;
            // 如果不是第一个元素，加分隔符
            if (i == 0 || separator == null) {
                context = new PrefixedContext(context, "");
            } else {
                context = new PrefixedContext(context, separator);
            }
            
            // 生成唯一索引：用于后面构造唯一参数名
            int uniqueNumber = context.getUniqueNumber();
            
            if (o instanceof Map.Entry) {
                Map.Entry<Object, Object> mapEntry = (Map.Entry<Object, Object>) o;
                // Map 迭代：将 key 和 value 以唯一名称放入 context
                applyIndex(context, mapEntry.getKey(), uniqueNumber);
                applyItem(context, mapEntry.getValue(), uniqueNumber);
            } else {
                // List/数组迭代：将索引和元素值以唯一名称放入 context
                applyIndex(context, i, uniqueNumber);
                applyItem(context, o, uniqueNumber);
            }
            
            // 执行子节点（子节点中的 #{item} 被替换为 #{__frch_item_0}、#{__frch_item_1}...）
            contents.apply(new FilteredDynamicContext(
                configuration, context, index, item, uniqueNumber));
            
            i++;
            context = oldContext;
        }
        
        if (close != null) {
            context.appendSql(close);
        }
        return true;
    }
}
```

关键实现：`FilteredDynamicContext` 会将子节点中的 `#{item}` 替换为 `#{__frch_item_0}`、`#{__frch_item_1}` 等带唯一后缀的参数名，从而使 `PreparedStatement` 的每个 `?` 都映射到不同的参数条目。

> [!warning] `<foreach>` IN 查询的性能陷阱
>
> 当 `ids` 集合很大时（如 10,000 个 ID），`<foreach>` 会生成 `id IN (?, ?, ..., ?)` 这样有 10,000 个占位符的 SQL。这会带来几个问题：
> 1. **SQL 解析开销**：数据库需要解析一个非常长的 IN 列表；
> 2. **索引失效**：IN 列表超过一定数量（MySQL 通常 200 以上），优化器可能放弃索引转而全表扫描；
> 3. **PreparedStatement 缓存失效**：不同长度的 IN 列表对应不同的 SQL 模板，无法复用已编译的 Statement。
>
> **推荐方案**：
> - IN 列表不超过 200 个元素；
> - 超过 200 时，分批查询（每批 200 个 ID），在内存中合并结果；
> - 或者改用 `JOIN` 临时表/子查询方案。

---

## 第 6 章 `#{}` 与 `${}` 的本质差异

### 6.1 两种占位符的处理时机不同

这是 Mybatis 中最重要的概念之一，也是 SQL 注入风险的根源所在：

**`#{property}`（推荐）**：
- 处理时机：SQL 构建完成后，由 `ParameterHandler` 在 `PreparedStatement.setXxx()` 时处理；
- 生成结果：在 SQL 中生成 `?` 占位符，参数值通过预编译参数安全绑定；
- 防 SQL 注入：是，参数值经过类型转换后通过 JDBC 协议传输，不参与 SQL 解析；
- 适用场景：**几乎所有参数传递**。

**`${property}`（谨慎使用）**：
- 处理时机：SQL 构建阶段，由 `TextSqlNode` 在 `apply()` 时直接字符串替换；
- 生成结果：参数值**原样拼接**进 SQL 字符串（仅做基本的字符串化），然后再走 `PreparedStatement`；
- 防 SQL 注入：否，参数值会参与 SQL 解析，可以改变 SQL 语义；
- 适用场景：**仅用于 SQL 结构本身的动态化**（表名、列名、ORDER BY 方向等），且参数来源必须可信。

### 6.2 SQL 注入示例

```xml
<!-- 危险：用 ${} 传入排序方向 -->
<select id="getUsers" resultType="User">
    SELECT * FROM users ORDER BY create_time ${sortDirection}
</select>
```

```java
// 正常调用
Map<String, Object> params = new HashMap<>();
params.put("sortDirection", "DESC");
// 生成 SQL：SELECT * FROM users ORDER BY create_time DESC  ✅

// 恶意调用
params.put("sortDirection", "DESC; DROP TABLE users; --");
// 生成 SQL：SELECT * FROM users ORDER BY create_time DESC; DROP TABLE users; --  ☠️
```

如果改用 `#{}`：

```xml
<select id="getUsers" resultType="User">
    SELECT * FROM users ORDER BY create_time #{sortDirection}
</select>
```

```java
// 即使传入恶意内容，#{} 会将其作为参数值安全绑定
// 生成 SQL：SELECT * FROM users ORDER BY create_time ?
// 参数值："DESC; DROP TABLE users; --"（被当作字符串值，而非 SQL 代码）
// 数据库会把整个字符串当作 ORDER BY 的值，SQL 语法错误，不会执行 DROP
```

但注意：**`ORDER BY` 的字段名和方向不能用 `#{}`**，因为 `ORDER BY 'create_time'` 和 `ORDER BY create_time` 在 SQL 中语义不同（前者是字符串常量，不起排序作用）。对于动态排序字段/方向，正确做法是**在 Java 代码中白名单校验**后再用 `${}`：

```java
// Java 代码中白名单校验（安全使用 ${} 的必要前提）
private static final Set<String> ALLOWED_SORT_COLUMNS = 
    Set.of("create_time", "name", "amount", "id");
private static final Set<String> ALLOWED_SORT_DIRECTIONS = Set.of("ASC", "DESC");

public List<User> getUsers(String sortColumn, String sortDirection) {
    if (!ALLOWED_SORT_COLUMNS.contains(sortColumn)) {
        throw new IllegalArgumentException("非法排序字段: " + sortColumn);
    }
    if (!ALLOWED_SORT_DIRECTIONS.contains(sortDirection.toUpperCase())) {
        throw new IllegalArgumentException("非法排序方向: " + sortDirection);
    }
    // 白名单验证通过后，才允许用 ${} 传入
    return userMapper.getUsersSorted(sortColumn, sortDirection);
}
```

### 6.3 合法的 `${}` 使用场景

`${}` 的设计并非一无是处，在以下场景中 `${}` 是必要的：

```xml
<!-- 场景一：动态表名（分库分表） -->
<select id="selectFromShard" resultType="Order">
    SELECT * FROM order_${shardId} WHERE user_id = #{userId}
</select>

<!-- 场景二：动态列名（报表动态列） -->
<select id="selectColumn" resultType="map">
    SELECT ${columnName} FROM ${tableName} WHERE id = #{id}
</select>

<!-- 场景三：动态 ORDER BY（白名单验证后） -->
<select id="listOrders" resultType="Order">
    SELECT * FROM orders
    ORDER BY ${sortColumn} ${sortDirection}
    LIMIT #{offset}, #{limit}
</select>
```

对于这些场景，**必须在 Java 代码层面进行白名单校验**，确保传入的动态 SQL 片段不来自用户的直接输入。

---

## 第 7 章 `<bind>`：OGNL 变量绑定

`<bind>` 标签允许在 SQL 上下文中声明新变量，该变量可以在后续的 SQL 中使用：

```xml
<!-- 场景：LIKE 查询中拼接 % 通配符 -->
<select id="searchByName" resultType="User">
    <bind name="nameLike" value="'%' + name + '%'"/>
    SELECT * FROM users WHERE name LIKE #{nameLike}
</select>
```

这等价于 Java 代码中的：
```java
String nameLike = "%" + name + "%";
```

`<bind>` 的 `value` 属性是一个 OGNL 表达式，求值结果被绑定到新变量名，并放入 `DynamicContext.bindings`，后续 `#{}` 就可以引用这个变量。

另一个典型场景是在 `<foreach>` 中创建临时变量：

```xml
<select id="selectWithPrefix" resultType="User">
    SELECT * FROM users
    WHERE status IN
    <foreach collection="statuses" item="s" open="(" close=")" separator=",">
        <bind name="sUpper" value="s.toUpperCase()"/>
        #{sUpper}
    </foreach>
</select>
```

---

## 第 8 章 DynamicSqlSource 与 RawSqlSource 的性能差异

### 8.1 两种 SqlSource 的工作模式

- **`DynamicSqlSource`**：含有动态标签（`<if>`、`<foreach>` 等）或 `${}` 拼接的 SQL。每次执行都需要：遍历 SqlNode 树 → 生成含 `#{}` 的 SQL 字符串 → 用 `SqlSourceBuilder` 解析 `#{}` 生成 `ParameterMapping` 列表 → 得到 `BoundSql`。这个过程有一定的 CPU 开销（正则解析 `#{}`、遍历节点树等）。

- **`RawSqlSource`**：纯静态 SQL（只有 `#{}` 占位符，无动态标签）。在初始化时，`RawSqlSource` 构造函数中就完成了 `#{}` 的解析，得到固定的 `StaticSqlSource`（含最终 SQL 模板和 `ParameterMapping` 列表）。**每次执行只需要创建 `BoundSql` 对象，不需要重新解析**，性能远好于 `DynamicSqlSource`。

### 8.2 优化建议

如果一个 SQL 语句的所有条件其实是强制的（没有可选条件），就不要加 `<if>` 标签，直接写静态 SQL，Mybatis 会自动选择 `RawSqlSource`：

```xml
<!-- ❌ 不必要的 <if>，导致使用 DynamicSqlSource -->
<select id="selectById" resultType="User">
    SELECT * FROM users
    <where>
        <if test="id != null">AND id = #{id}</if>
    </where>
</select>

<!-- ✅ id 是必传参数，直接写静态 SQL，使用 RawSqlSource -->
<select id="selectById" resultType="User">
    SELECT * FROM users WHERE id = #{id}
</select>
```

---

## 总结

Mybatis 动态 SQL 的底层由两个精心设计的机制驱动：

- **OGNL 表达式引擎**：负责运行时对 `test="..."` 条件进行求值，支持属性访问、方法调用、逻辑运算等完整表达式语法；需注意 XML 中的字符转义（`and`/`or` 优于 `&&`/`||`）、字符与字符串的类型差异；

- **SqlNode 组合树**：在初始化时将 XML 标签体编译为 `MixedSqlNode`/`IfSqlNode`/`ForEachSqlNode` 等节点组成的树；每次执行时遍历该树，根据运行时参数决定哪些节点生效，将有效节点的 SQL 片段追加到 `DynamicContext.sqlBuilder`，最终拼出完整 SQL；

- **核心标签的本质**：`<if>` = OGNL 条件门控；`<choose>` = `if-else if-else`；`<where>` = 智能 `WHERE` 前缀 + 多余 `AND`/`OR` 删除；`<set>` = 智能 `SET` 前缀 + 末尾逗号删除；`<foreach>` = 集合迭代 + 唯一参数名生成；`<bind>` = OGNL 变量声明；

- **`#{}` vs `${}`**：`#{}` 生成 `?` 占位符（预编译参数，防 SQL 注入，推荐），`${}` 直接字符串替换（有注入风险，仅用于表名/列名等 SQL 结构的动态化，且必须白名单验证）；

- **性能**：无动态标签的静态 SQL 使用 `RawSqlSource`（初始化时完成 `#{}` 解析），性能优于 `DynamicSqlSource`；`<foreach>` IN 查询的集合大小应控制在 200 以内，避免数据库索引失效。

下一篇，我们深入 Mybatis 的类型系统，剖析 `ParameterHandler` 的参数绑定机制和 `TypeHandler` 的注册查找原理：[[04 参数处理——ParameterHandler与TypeHandler的类型映射]]。

---

> [!note] 参考资料
> - [Mybatis 官方文档 - 动态 SQL](https://mybatis.org/mybatis-3/dynamic-sql.html)
> - `org.apache.ibatis.scripting.xmltags.DynamicSqlSource` 源码
> - `org.apache.ibatis.scripting.xmltags.ForEachSqlNode` 源码
> - `org.apache.ibatis.ognl.OgnlCache` 源码

---

> [!note] 思考题
> 1. MyBatis 的 `<if>` `<choose>` `<foreach>` 等动态 SQL 标签在底层被解析为一棵 SqlNode 树，运行时通过遍历树节点拼接 SQL。频繁的字符串拼接是否会成为性能瓶颈？MyBatis 对动态 SQL 的解析结果有缓存机制吗？
> 2. `<foreach>` 标签用于 IN 查询时，如果集合有 10000 个元素，生成的 SQL 会包含 10000 个占位符。某些数据库（如 Oracle）对 IN 子句的参数数量有限制（最多 1000）。你如何在 MyBatis 层面优雅地处理这个限制？分批查询和临时表方案各有什么代价？
> 3. OGNL 表达式在 `<if test="...">` 中被使用。`<if test="name != null and name != ''">` 是最常见的判空写法。但如果 `name` 是一个 `int` 类型（基本类型，默认值为 0），`test="name != null"` 是否会生效？OGNL 如何处理基本类型与包装类型的差异？
