---
title: "UDF 开发体系：GenericUDF、UDAF 与 UDTF 全解"
date: 2026-02-28
tags: [GenericUDF, Hive, JAR, UDAF, UDF, UDTF, 函数注册, 文件描述符泄漏, 类加载, 自定义函数]
aliases: []
---

# 09 UDF 开发体系：GenericUDF、UDAF 与 UDTF 全解

## 摘要

Hive 内置函数无法覆盖所有业务场景，UDF（User-Defined Function）是扩展 Hive 能力的标准手段。Hive 的 UDF 体系分为三大类：**GenericUDF**（标量函数，一行输入一行输出）、**UDAF**（聚合函数，多行输入一行输出）、**UDTF**（表生成函数，一行输入多行输出）。每种类型都有各自的实现接口和执行契约，使用错误的接口或违反执行契约会导致静默的错误结果（比 OOM 更难排查）。本文不仅讲解三种 UDF 的接口实现，更重点分析 Hive 的**类加载隔离机制**（UDF JAR 如何与 Hive 框架 JAR 隔离，避免依赖冲突）、**函数注册与生命周期**（临时函数 vs 永久函数的本质差异），以及一个真实的**文件描述符泄漏故障**（来自本知识库的故障分析报告）背后的 UDF 类加载根因。

---

## 第 1 章 Hive UDF 体系概览

### 1.1 为什么需要三种不同的 UDF 类型

SQL 中的函数按输入输出的行数关系可以分为三类，Hive 为每类提供了专门的接口：

```
标量函数（Scalar）：
  f(row) → row     一行进，一行出
  示例：UPPER(name)、ROUND(amount, 2)、自定义加密函数 encrypt(phone)
  Hive 接口：GenericUDF

聚合函数（Aggregate）：
  f(rows) → row    多行进，一行出（必须与 GROUP BY 配合使用）
  示例：SUM(amount)、COUNT(DISTINCT user_id)、自定义统计函数 median(score)
  Hive 接口：GenericUDAFEvaluator + GenericUDAFResolver

表生成函数（Table-Generating）：
  f(row) → rows    一行进，多行出（"爆炸式展开"）
  示例：EXPLODE(array_col)、POSEXPLODE(array_col)、自定义 IP解析函数 parse_ip(ip)→(country,city,isp)
  Hive 接口：GenericUDTF
```

这三种类型对应了 SQL 中三种本质不同的数据变换模式。Hive 必须为它们提供不同的接口，是因为框架需要了解函数的输入输出行数关系，才能正确地将函数嵌入 Operator Tree，并决定执行策略（如 UDTF 需要特殊的 LATERAL VIEW 处理，UDAF 需要 Map 端预聚合支持）。

### 1.2 SimpleUDF vs GenericUDF

Hive 提供了两套 UDF 实现接口：

**旧接口 `UDF`（SimpleUDF）**：通过 Java 反射调用名为 `evaluate()` 的方法，方法签名直接反映函数的输入输出类型（如 `public Text evaluate(Text input)`）。简单直观，但类型系统与 Hive 的 `ObjectInspector` 机制不兼容，性能差（每行调用都有反射开销），不支持复杂类型（Struct、Map、Array），已不推荐使用。

**新接口 `GenericUDF`**：通过 `ObjectInspector` 机制与 Hive 类型系统深度集成，支持所有 Hive 类型，性能好（无反射），可以感知类型信息（在初始化时获取输入列的确切类型，做类型特化优化）。所有新 UDF 必须使用 `GenericUDF` 接口。

---

## 第 2 章 GenericUDF：标量函数的实现

### 2.1 GenericUDF 的生命周期与接口契约

`GenericUDF` 的核心生命周期由三个方法定义：

```java
public abstract class GenericUDF {

    /**
     * initialize() 在函数被调用前执行一次（编译期）。
     * 接收输入参数的 ObjectInspector 数组，完成：
     * 1. 参数类型验证（如果类型不对，抛出 UDFArgumentTypeException）
     * 2. 参数数量验证（如果参数数量不对，抛出 UDFArgumentLengthException）
     * 3. 返回输出的 ObjectInspector（告知 Hive 函数的输出类型）
     * 4. 初始化内部状态（缓存对象、编译正则表达式等）
     *
     * 重要：initialize() 只调用一次，evaluate() 每行调用一次。
     * 在 initialize() 中缓存对象（如 Text 对象）可以避免 evaluate() 中频繁创建对象的 GC 压力。
     */
    public abstract ObjectInspector initialize(ObjectInspector[] arguments)
        throws UDFArgumentException;

    /**
     * evaluate() 对每一行数据调用一次。
     * 接收 DeferredObject 数组（延迟求值对象），返回处理结果。
     *
     * 重要约定：
     * 1. 返回对象必须是可重用的（Hive 不会每次都拷贝返回值）。
     *    如果返回 Text 对象，必须是预先在 initialize() 中创建的同一个 Text 实例
     *    每次 evaluate() 都修改这个实例的内容后返回，不要每次 new Text()。
     * 2. 线程安全：同一个 GenericUDF 实例可能被多个线程调用（在向量化模式下），
     *    实例变量不能有不安全的读写。
     */
    public abstract Object evaluate(DeferredObject[] arguments)
        throws HiveException;

    /**
     * getDisplayString() 返回函数的可读字符串表示，用于 EXPLAIN 输出和错误信息。
     */
    public abstract String getDisplayString(String[] children);
}
```

### 2.2 GenericUDF 实现示例：手机号脱敏函数

以一个实际业务场景为例——将手机号的中间 4 位替换为星号（`13812345678` → `138****5678`）：

```java
@Description(
    name = "mask_phone",
    value = "_FUNC_(phone) - 对手机号进行中间4位脱敏，如 13812345678 → 138****5678",
    extended = "参数：phone STRING 类型，手机号字符串"
)
public class MaskPhoneUDF extends GenericUDF {

    // 在 initialize() 中预先创建，evaluate() 中复用，避免每行 new Text() 的 GC 压力
    private final Text result = new Text();
    // 缓存输入的 StringObjectInspector，evaluate() 中用于提取字符串值
    private StringObjectInspector phoneOI;

    @Override
    public ObjectInspector initialize(ObjectInspector[] arguments)
            throws UDFArgumentException {
        // 参数数量校验
        if (arguments.length != 1) {
            throw new UDFArgumentLengthException(
                "mask_phone 函数需要且仅需要 1 个参数，当前传入了 " + arguments.length + " 个");
        }
        // 参数类型校验（必须是字符串类型）
        if (arguments[0].getCategory() != ObjectInspector.Category.PRIMITIVE
            || ((PrimitiveObjectInspector) arguments[0]).getPrimitiveCategory()
               != PrimitiveObjectInspector.PrimitiveCategory.STRING) {
            throw new UDFArgumentTypeException(0,
                "mask_phone 函数的参数必须是 STRING 类型，实际类型为: " + arguments[0].getTypeName());
        }
        // 缓存 ObjectInspector 供 evaluate() 使用
        this.phoneOI = (StringObjectInspector) arguments[0];
        // 声明输出类型为 STRING
        return PrimitiveObjectInspectorFactory.javaStringObjectInspector;
    }

    @Override
    public Object evaluate(DeferredObject[] arguments) throws HiveException {
        // 获取输入值（DeferredObject.get() 触发实际求值）
        String phone = phoneOI.getPrimitiveJavaObject(arguments[0].get());

        // NULL 值处理：Hive 约定，输入 NULL 时通常输出 NULL
        if (phone == null) {
            return null;
        }

        // 业务逻辑：将第 3-7 位替换为星号（0-indexed: 位置 3, 4, 5, 6）
        if (phone.length() < 8) {
            // 长度不足，无法脱敏，直接返回原值（或根据业务决定是否报错）
            result.set(phone);
            return result;
        }

        String masked = phone.substring(0, 3) + "****" + phone.substring(7);
        result.set(masked);
        return result;  // 返回预分配的 Text 对象，不创建新对象
    }

    @Override
    public String getDisplayString(String[] children) {
        return "mask_phone(" + children[0] + ")";
    }
}
```

**关键实现要点**：
- `initialize()` 中缓存 `phoneOI`，避免 `evaluate()` 每行都做类型转换
- `result` 对象在 `initialize()` 中创建一次，`evaluate()` 中复用，减少 GC
- NULL 值必须显式处理（Hive 不自动处理 NULL，不处理 NULL 可能导致 NPE 或静默错误）

---

## 第 3 章 UDAF：聚合函数的状态机实现

### 3.1 UDAF 的两阶段聚合模型

UDAF（User-Defined Aggregate Function）在 Hive 中的实现比 GenericUDF 复杂得多，这是因为 Hive 的聚合函数必须支持**两阶段聚合**（Map 端预聚合 + Reduce 端最终聚合），而不是只有一阶段（全量 Reduce）。

为什么需要两阶段？考虑 `SUM(amount) GROUP BY region`：
- 单阶段：将所有 region='US' 的行都 Shuffle 到同一个 Reducer，Reducer 再做 SUM
- 两阶段（Map Combine）：每个 Map Task 先对本地数据做 SUM（部分聚合），只输出每个 region 的局部 sum 到 Shuffle，Reducer 再对所有 Map 的局部 sum 做最终 SUM

两阶段大幅减少 Shuffle 数据量（从 N 行变为 每个 Mapper 一行/region）。对于可结合（associative）且可交换（commutative）的函数（SUM、MIN、MAX、COUNT），两阶段的结果与单阶段完全等价。

Hive UDAF 框架通过 `GenericUDAFEvaluator` 接口支持两阶段聚合：

```
UDAF 的四种执行模式（Mode）：

PARTIAL1（Map 端，从原始数据到局部聚合结果）：
  iterate(AggregationBuffer, input) 被调用（处理原始行）
  terminatePartial(AggregationBuffer) 返回局部聚合结果（用于 Shuffle 传输）

PARTIAL2（Combiner 端，多个局部结果再聚合）：
  merge(AggregationBuffer, partialResult) 被调用（合并局部结果）
  terminatePartial(AggregationBuffer) 返回再次聚合的局部结果

FINAL（Reduce 端，局部结果合并为最终结果）：
  merge(AggregationBuffer, partialResult) 被调用（合并各 Map 的局部结果）
  terminate(AggregationBuffer) 返回最终聚合结果

COMPLETE（不 Shuffle，单阶段聚合，即用于只有 Map 阶段的场景）：
  iterate() + terminate()
```

### 3.2 UDAF 实现示例：计算中位数

内置函数没有 `MEDIAN()`，这是 UDAF 的典型应用场景：

```java
@Description(name = "median", value = "_FUNC_(col) - 计算一组数值的中位数")
public class MedianUDAF extends AbstractGenericUDAFResolver {

    @Override
    public GenericUDAFEvaluator getEvaluator(TypeInfo[] parameters)
            throws SemanticException {
        // 参数类型检查
        if (parameters.length != 1) {
            throw new UDFArgumentTypeException(parameters.length - 1, "median 只接受 1 个参数");
        }
        PrimitiveTypeInfo pti = (PrimitiveTypeInfo) parameters[0];
        switch (pti.getPrimitiveCategory()) {
            case DOUBLE: case FLOAT: case LONG: case INT: case SHORT: case BYTE:
                return new MedianUDAFEvaluator();
            default:
                throw new UDFArgumentTypeException(0, "median 只支持数值类型");
        }
    }

    /**
     * AggregationBuffer：每个 GROUP BY Key 对应一个 Buffer 实例，用于累积中间状态。
     * 对于中位数，中间状态是"目前看到的所有值"的列表（无法流式计算，必须保存所有值）。
     */
    static class MedianBuffer implements AggregationBuffer {
        List<Double> values = new ArrayList<>();  // 存储该 Group 的所有值
    }

    public static class MedianUDAFEvaluator extends GenericUDAFEvaluator {

        private PrimitiveObjectInspector inputOI;
        private StandardListObjectInspector partialOI;  // 局部结果的 OI（Double 列表）

        @Override
        public ObjectInspector init(Mode mode, ObjectInspector[] parameters)
                throws HiveException {
            super.init(mode, parameters);
            if (mode == Mode.PARTIAL1 || mode == Mode.COMPLETE) {
                // 接收原始输入
                inputOI = (PrimitiveObjectInspector) parameters[0];
            } else {
                // 接收 terminatePartial() 的输出（Double 列表）
                partialOI = (StandardListObjectInspector) parameters[0];
            }
            if (mode == Mode.PARTIAL1 || mode == Mode.PARTIAL2) {
                // 局部输出是 Double 列表（用于传递聚合中间状态）
                return ObjectInspectorFactory.getStandardListObjectInspector(
                    PrimitiveObjectInspectorFactory.javaDoubleObjectInspector);
            } else {
                // 最终输出是单个 Double（中位数）
                return PrimitiveObjectInspectorFactory.javaDoubleObjectInspector;
            }
        }

        @Override
        public AggregationBuffer getNewAggregationBuffer() {
            return new MedianBuffer();
        }

        @Override
        public void reset(AggregationBuffer agg) {
            ((MedianBuffer) agg).values.clear();
        }

        @Override
        public void iterate(AggregationBuffer agg, Object[] parameters) throws HiveException {
            if (parameters[0] == null) return;  // 忽略 NULL 值（与 SQL 标准一致）
            double val = PrimitiveObjectInspectorUtils.getDouble(parameters[0], inputOI);
            ((MedianBuffer) agg).values.add(val);
        }

        @Override
        public Object terminatePartial(AggregationBuffer agg) {
            // 局部结果：返回当前已收集的所有值的列表，供 Reducer 端 merge()
            return new ArrayList<>(((MedianBuffer) agg).values);
        }

        @Override
        public void merge(AggregationBuffer agg, Object partial) throws HiveException {
            if (partial == null) return;
            // partial 是另一个 Map 输出的 Double 列表，合并到当前 Buffer
            List<?> partialList = (List<?>) partialOI.getList(partial);
            for (Object item : partialList) {
                Double val = (Double) item;
                ((MedianBuffer) agg).values.add(val);
            }
        }

        @Override
        public Object terminate(AggregationBuffer agg) {
            List<Double> sorted = ((MedianBuffer) agg).values;
            if (sorted.isEmpty()) return null;
            Collections.sort(sorted);
            int size = sorted.size();
            if (size % 2 == 1) {
                return sorted.get(size / 2);
            } else {
                return (sorted.get(size / 2 - 1) + sorted.get(size / 2)) / 2.0;
            }
        }
    }
}
```

> [!warning] 生产避坑
> **UDAF 的内存炸弹**：中位数 UDAF 必须在内存中保存每个 Group 的所有值，无法流式计算。如果某个 Group 有 1 亿行数据（极端数据倾斜），这个 AggregationBuffer 会在 Reducer 内存中积累 1 亿个 Double 对象，直接 OOM。**生产中使用这类 UDAF 时，必须确保单 Group 的数据量可控（通常不超过百万行）**，或改用近似算法（如 Percentile_Approx，基于 Qdigest 流式算法）代替精确中位数。

---

## 第 4 章 UDTF：表生成函数的横向展开

### 4.1 UDTF 的设计动机

UDTF 解决了 SQL 中"一行输入多行输出"的展开需求。最典型的场景是处理 Array 类型的列——Hive 中一行数据的某列可能是 `Array<String>`（如一篇文章的标签列表），业务需要将每个标签展开为独立一行，方便后续统计。

Hive 内置的 `EXPLODE()` 就是一个 UDTF，但无法处理复杂的业务逻辑（如将一条日志解析为多条结构化记录）。

### 4.2 UDTF 的接口实现

```java
@Description(name = "parse_log", value = "_FUNC_(log_line) - 将一行日志解析为多条结构化记录")
public class ParseLogUDTF extends GenericUDTF {

    private StringObjectInspector logOI;
    // 用于 forward() 传递数据的对象数组（复用，避免每次 new Object[]）
    private final Object[] forwardObj = new Object[3];  // [timestamp, level, message]

    @Override
    public StructObjectInspector initialize(ObjectInspector[] argOIs)
            throws UDFArgumentException {
        if (argOIs.length != 1) {
            throw new UDFArgumentException("parse_log 需要 1 个 STRING 参数");
        }
        logOI = (StringObjectInspector) argOIs[0];

        // 定义输出列（UDTF 的输出是一个 Struct，每个字段是输出的一列）
        List<String> fieldNames = Arrays.asList("ts", "level", "message");
        List<ObjectInspector> fieldOIs = Arrays.asList(
            PrimitiveObjectInspectorFactory.javaStringObjectInspector,  // ts
            PrimitiveObjectInspectorFactory.javaStringObjectInspector,  // level
            PrimitiveObjectInspectorFactory.javaStringObjectInspector   // message
        );
        return ObjectInspectorFactory.getStandardStructObjectInspector(fieldNames, fieldOIs);
    }

    @Override
    public void process(Object[] args) throws HiveException {
        String log = logOI.getPrimitiveJavaObject(args[0]);
        if (log == null) return;

        // 解析日志（示例：假设日志格式为多行，每行 "timestamp|level|message"）
        String[] lines = log.split("\n");
        for (String line : lines) {
            String[] parts = line.split("\\|", 3);
            if (parts.length != 3) continue;  // 跳过格式不对的行

            forwardObj[0] = parts[0];  // timestamp
            forwardObj[1] = parts[1];  // level
            forwardObj[2] = parts[2];  // message

            // forward() 将当前这一行输出到下游 Operator
            // 注意：每次调用 forward() 就输出一行，可以调用 0 次（无输出）到 N 次（N 行输出）
            forward(forwardObj);
        }
    }

    @Override
    public void close() throws HiveException {
        // 释放资源（如打开的外部连接、文件句柄等）
        // UDTF 的 close() 在所有行处理完毕后调用一次
    }
}
```

**UDTF 的使用方式**：

```sql
-- LATERAL VIEW 语法（标准用法）
SELECT t.order_id, log_parsed.ts, log_parsed.level, log_parsed.message
FROM orders t
LATERAL VIEW parse_log(t.raw_log) log_parsed AS ts, level, message;

-- 内置 EXPLODE 的等价写法
SELECT order_id, tag
FROM orders
LATERAL VIEW EXPLODE(tags_array) tags_table AS tag;
```

---

## 第 5 章 UDF 的类加载机制与 JAR 包冲突

### 5.1 Hive 的类加载器架构

这是 UDF 开发中最容易被忽视但影响最深的技术细节。Hive 的 JVM 类加载器架构决定了 UDF JAR 如何与 Hive 框架 JAR 共存：

```
JVM 类加载器层次（Hive HS2 进程）：

Bootstrap ClassLoader（JVM 根加载器）
  ↓
Extension ClassLoader（JDK 扩展库）
  ↓
System/App ClassLoader（Hive 框架类：hive-exec.jar, hadoop-common.jar 等）
  ↓
SessionClassLoader（每个 Hive Session 的隔离类加载器，加载 UDF JAR）
```

每个 Hive Session 拥有一个独立的 `SessionClassLoader`（继承自 `URLClassLoader`），通过 `ADD JAR` 命令添加的 JAR 文件被加载到这个 Session 专属的类加载器中。这提供了 Session 级别的类隔离——不同 Session 添加的 UDF JAR 相互隔离。

**类加载的双亲委派与打破**：

正常情况下，Java 类加载遵循双亲委派（Parent Delegation）模式：子类加载器加载某个类时，先委托父加载器尝试加载，父加载器无法加载时才自己加载。这意味着：如果 UDF JAR 中包含了与 Hive 框架相同的类（如自带了一个版本的 Guava），通常会优先加载父加载器（System ClassLoader）中的 Hive 框架版本，UDF JAR 中的版本被忽略。

**问题场景**：UDF JAR 依赖 Guava 20.0，但 Hive 框架使用 Guava 14.0，API 不兼容。由于双亲委派，UDF 类加载时实际使用的是 Guava 14.0，运行时调用了 Guava 20.0 的新 API → `NoSuchMethodError`。

解决方案：在 UDF JAR 构建时使用 **Maven Shade Plugin** 将依赖类重命名（Relocate），避免与 Hive 框架依赖的同名类冲突：

```xml
<!-- pom.xml 中的 Maven Shade 配置 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <configuration>
    <relocations>
      <!-- 将 UDF 依赖的 Guava 重命名，避免与 Hive 的 Guava 冲突 -->
      <relocation>
        <pattern>com.google.common</pattern>
        <shadedPattern>com.my.udf.shaded.guava</shadedPattern>
      </relocation>
    </relocations>
  </configuration>
</plugin>
```

### 5.2 文件描述符泄漏：类加载的隐蔽代价

知识库中存在一份真实的故障分析报告：[[HiveServer2 Redis UDF 文件描述符泄漏故障报告]]。这里从类加载角度深入分析该故障的根因。

**故障现象（摘自故障报告）**：HS2 进程的文件描述符数量（`/proc/<pid>/fd` 目录中的文件数）随时间持续增长，最终触发系统 `ulimit -n`（最大文件描述符数）限制，导致 HS2 无法建立新的网络连接、无法打开新文件，最终宕机。

**根因链条**：

```
每次 ADD JAR + 注册 UDF：
  ↓
SessionClassLoader.addURL(jar_path)
  ↓
Java URLClassLoader 内部打开 JAR 文件，获取一个文件描述符（FD）
  ↓
JAR 文件中的 Class 被加载时，JVM 通过该 FD 读取字节码
  ↓
正常情况：Session 关闭时，SessionClassLoader 被 GC，JAR 的 FD 被关闭

问题：UDF 中注册了一个 Redis 连接池（在 UDF 类的 static 块中初始化）：

  static {
      jedisPool = new JedisPool(config, "redis-host", 6379);  // 打开 Redis TCP 连接
  }

  Redis 连接池持有 TCP 连接的 Socket FD（文件描述符）

SessionClassLoader 被 Session 对象引用，Session 对象被 HS2 的 session map 引用：
  HS2 SessionMap → HiveSession → SessionClassLoader → UDF 类 → JedisPool → Socket FDs

当 Session 超时关闭时：
  HiveSession 从 SessionMap 中移除
  但 JedisPool 中的 TCP Socket 没有被关闭（JedisPool 没有实现 finalizer 或 Closeable）
  → FD 泄漏：每个 Session 的生命周期 = 若干个不释放的 Socket FD
  → 随着 HS2 处理大量 Session，FD 数量持续增长
```

**修复方案**：在 UDF 的 `close()` 方法（GenericUDF）或静态注销机制中显式关闭连接池：

```java
// 在 UDF 中管理外部资源的正确方式
public class RedisLookupUDF extends GenericUDF {
    private static JedisPool jedisPool;

    @Override
    public ObjectInspector initialize(ObjectInspector[] arguments) throws UDFArgumentException {
        // 惰性初始化，而非 static 块中初始化
        if (jedisPool == null) {
            synchronized (RedisLookupUDF.class) {
                if (jedisPool == null) {
                    jedisPool = new JedisPool(config, "redis-host", 6379);
                }
            }
        }
        return PrimitiveObjectInspectorFactory.javaStringObjectInspector;
    }

    @Override
    public void close() throws IOException {
        // close() 在 Session 关闭时调用，显式释放资源
        if (jedisPool != null && !jedisPool.isClosed()) {
            jedisPool.close();
            jedisPool = null;
        }
    }
    // ... evaluate() 实现
}
```

---

## 第 6 章 函数注册与生命周期管理

### 6.1 临时函数 vs 永久函数

Hive 中函数注册分为两种模式，它们在元数据存储和生命周期上有本质区别：

**临时函数（Temporary Function）**：

```sql
-- 注册临时函数（只在当前 Session 有效）
ADD JAR hdfs:///user/hive/jars/my-udf.jar;
CREATE TEMPORARY FUNCTION mask_phone AS 'com.example.MaskPhoneUDF';

-- 使用
SELECT mask_phone(phone) FROM users;

-- Session 关闭后临时函数自动失效，无需手动删除
-- 临时函数不存储在 HMS（Hive Metastore），只存在于当前 Session 内存中
```

临时函数的适用场景：测试新开发的 UDF、一次性任务、不需要跨 Session 共享的函数。

**永久函数（Permanent Function）**：

```sql
-- 注册永久函数（存储在 HMS，所有 Session 可用）
-- 需要将 JAR 上传到所有 HS2 节点可访问的 HDFS 路径
CREATE FUNCTION mydb.mask_phone AS 'com.example.MaskPhoneUDF'
USING JAR 'hdfs:///user/hive/jars/my-udf.jar';

-- 永久函数存储在 HMS 的 FUNCS 表中（MySQL 中的 FUNCS 表）
-- 所有 Session 无需 ADD JAR 即可使用（Hive 自动加载对应 JAR）
-- 删除：DROP FUNCTION mydb.mask_phone;
```

永久函数的注册信息存储在 HMS 的 `FUNCS` 和 `FUNC_RU` 表中：

```sql
-- HMS MySQL 中的函数注册表（简化）
CREATE TABLE FUNCS (
    FUNC_ID   BIGINT NOT NULL,
    CLASS_NAME VARCHAR(4000),  -- UDF 类的全限定名
    CREATE_TIME INT,
    DB_ID     BIGINT,           -- 外键：所属数据库
    FUNC_NAME VARCHAR(128),     -- 函数名
    FUNC_TYPE INT               -- 函数类型（UDF/UDAF/UDTF）
);
CREATE TABLE FUNC_RU (
    FUNC_ID      BIGINT NOT NULL,
    RESOURCE_TYPE INT,           -- JAR 类型
    RESOURCE_URI VARCHAR(4000)   -- HDFS JAR 路径
);
```

### 6.2 UDF JAR 版本管理的生产实践

生产中 UDF 版本升级是一个需要谨慎处理的操作：

**挑战**：永久函数注册时的 JAR 路径是固定的（如 `hdfs:///hive/jars/my-udf-1.0.jar`）。当需要升级到 `my-udf-2.0.jar` 时，简单地覆盖旧 JAR 文件是危险的——Hive Session 可能已经缓存了旧版本的 JAR（通过 `SessionClassLoader`），覆盖后新旧版本共存，行为不可预期。

**推荐升级流程**：

```sql
-- Step 1：将新 JAR 上传到新路径（不覆盖旧文件）
-- hdfs dfs -put my-udf-2.0.jar hdfs:///hive/jars/my-udf-2.0.jar

-- Step 2：删除旧永久函数
DROP FUNCTION IF EXISTS mydb.mask_phone;

-- Step 3：注册新版本永久函数（指向新 JAR）
CREATE FUNCTION mydb.mask_phone AS 'com.example.MaskPhoneUDFV2'
USING JAR 'hdfs:///hive/jars/my-udf-2.0.jar';

-- Step 4：所有 HS2 节点上的在途 Session 需要重启才能加载新版本（或等待自然过期）
-- 生产中通常在低峰期执行，并通知 HS2 实例做滚动重启
```

---

## 小结

Hive UDF 体系是扩展 SQL 能力的核心机制，三种类型各司其职：

- **GenericUDF（标量）**：`initialize()` 做类型检查和初始化（一次），`evaluate()` 做业务计算（每行一次）；预分配返回对象避免 GC；NULL 值必须显式处理
- **UDAF（聚合）**：四种模式（PARTIAL1/PARTIAL2/FINAL/COMPLETE）支持 Map 端预聚合；`AggregationBuffer` 在内存中积累每个 Group 的中间状态；内存型 UDAF（如中位数）必须控制单 Group 数据量上限
- **UDTF（表生成）**：`process()` 方法中通过 `forward()` 输出 0 到 N 行；`close()` 中释放外部资源
- **类加载隔离**：Session 级 `URLClassLoader` 提供 Session 间的 UDF 隔离；依赖冲突通过 Maven Shade Plugin 解决；在 UDF 类中持有外部资源（连接池、文件句柄）且未在 `close()` 中释放会导致文件描述符泄漏
- **函数注册**：临时函数（Session 级）和永久函数（HMS 存储、跨 Session）有本质区别；永久函数升级需要删除旧注册、创建新注册，避免新旧 JAR 在 SessionClassLoader 中混淆

第 10 篇深入 Tez 调优实战：DAG Vertex 诊断（通过 Tez UI 定位慢 Vertex 和 Task）、内存配置的精确计算（AM 内存 vs Container 内存 vs JVM Heap 的关系）、数据倾斜的自动检测与手动处理，以及向量化执行的启用与效果验证。

---

> [!note] 思考题
> 1. `GenericUDF` 的 `evaluate()` 方法在每行数据上被调用，如果 UDF 内部进行了昂贵的初始化操作（如加载机器学习模型、建立数据库连接），这些操作在 `initialize()` 方法中只执行一次，在整个 Task 生命周期内复用。但如果 `evaluate()` 方法存在线程安全问题（如使用了共享的 `SimpleDateFormat` 实例），在向量化执行模式下（多行同时处理）可能引发并发 Bug。如何为 GenericUDF 编写正确的线程安全代码？
> 2. UDAF（聚合函数）的实现需要定义一个 `AggregationBuffer` 来存储每个分组的中间聚合状态。如果 UDAF 的中间状态非常大（如收集一个 Key 对应的所有原始值用于去重计数），会导致 Reducer 的内存压力暴增，进而 OOM。Hive 的近似计数函数（`approx_count_distinct`，基于 HyperLogLog）是如何通过有界的中间状态实现近似去重计数的？如何在自定义 UDAF 中实现类似的"有界内存"聚合？
> 3. UDTF（表生成函数）将一行输入转换为多行输出，如 `explode()` 将数组展开为多行。UDTF 必须与 `LATERAL VIEW` 配合使用，将展开的多行与原始行的其他列关联。如果 UDTF 产生的行数非常多（如将一个包含 10 万个元素的数组 `explode` 展开），对 MapTask 的内存和输出数据量有什么影响？在大规模数组展开场景下，有没有比 UDTF 更高效的替代方案？

## 参考资料

- [Hive UDF 官方文档](https://cwiki.apache.org/confluence/display/Hive/HivePlugins)
- [Hive GenericUDF 接口（源码）](https://github.com/apache/hive/blob/master/ql/src/java/org/apache/hadoop/hive/ql/udf/generic/GenericUDF.java)
- [Hive UDAF 接口（源码）](https://github.com/apache/hive/blob/master/ql/src/java/org/apache/hadoop/hive/ql/udf/generic/GenericUDAFEvaluator.java)
- [[HiveServer2 Redis UDF 文件描述符泄漏故障报告]]（本知识库）
