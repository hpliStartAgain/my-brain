**报告日期**: 2026年3月20日
**故障时间**: 2026年3月20日 07:39
**影响范围**: 生产环境 Hive on Tez 作业失败，业务数据产出中断
**严重级别**: P2 - 业务作业失败，需当日修复
**文档状态**: 🔄 排查进行中（根因尚未最终闭合）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [故障现象](#2-故障现象)
3. [排查过程](#3-排查过程)
4. [根因分析](#4-根因分析)
5. [解决方案](#5-解决方案)
6. [待确认事项](#6-待确认事项)
7. [预防措施](#7-预防措施)

---

## 1. 执行摘要

### 1.1 问题概述

2026年3月20日 07:39，业务方一条 Hive SQL 作业（application `1761215995979_16064496`）在 Tez 引擎上运行失败。DAG 中 `Map 4` 节点报 `java.lang.AbstractMethodError`，导致整个 DAG 级联 FAILED/KILLED。

### 1.2 当前结论

> [!WARNING] **根因尚未最终闭合**，以下为深度排查后的当前最优假设。

已确认事实：
- 失败 Vertex（Map 4）处理 `msns.mvp_dwd_event_click`，调用 `msns.parse_phone_no(content1)`
- `parse_phone_no` 对应实现类 `ParsePhoneNo`，继承自 **`org.apache.hadoop.hive.ql.exec.UDF`（旧接口）**，不是 `GenericUDF`
- 该 jar（`hive-udf-1.0-jar-with-dependencies.jar`）内所有自定义 UDF 均使用旧式 `extends UDF` 写法
- 旧式 `UDF` 子类在运行时被 `GenericUDFBridge`（`GenericUDF` 的子类）包装
- 集群 bigtop 路径的 hive-exec 中 `GenericUDF.initializeAndFoldConstants` 是 concrete 方法
- `set hive.optimize.constant.propagation=false` 临时方案**无效**，作业仍以相同错误失败
- **只有这个用户的作业失败**，其他作业正常，说明是该 jar 特有问题

当前最优假设：Tez 容器实际加载的 hive-exec 与 bigtop 本地版本不同，容器版本中 `GenericUDF.initializeAndFoldConstants` 为 abstract，导致 `GenericUDFBridge` 无实现可调。但仍需确认 Hive Metastore 中注册的 jar 路径与分析的本地 jar 是否为同一文件。

---

## 2. 故障现象

### 2.1 作业基本信息

- **作业类型**: Hive on Tez
- **Application ID**: `application_1761215995979_16064496`
- **DAG ID**: `dag_1761215995979_16064496_2`
- **失败 Vertex**: `Map 4`（处理表 `msns.mvp_dwd_event_click`）

### 2.2 失败链路

```
Map 4 (FAILED: OWN_TASK_FAILURE)
  └─ 触发级联 KILL
       ├─ Map 1    (KILLED: OTHER_VERTEX_FAILURE)
       ├─ Map 5    (KILLED: OTHER_VERTEX_FAILURE)
       ├─ Reducer 2 (KILLED: OTHER_VERTEX_FAILURE)
       ├─ Reducer 3 (KILLED: OTHER_VERTEX_FAILURE)
       └─ Reducer 6 (KILLED: OTHER_VERTEX_FAILURE)
```

DAG 最终状态：`FAILED`（1 个 Vertex FAILED，5 个 KILLED）

### 2.3 关键错误信息

Tez AM 日志中的核心异常（其余均为级联日志）：

```
java.lang.RuntimeException: Map operator initialization failed
  at MapRecordProcessor.init(MapRecordProcessor.java:354)
Caused by: java.lang.AbstractMethodError:
  org.apache.hadoop.hive.ql.udf.generic.GenericUDF
    .initializeAndFoldConstants(
      [Lorg/apache/hadoop/hive/serde2/objectinspector/ObjectInspector;
    )Lorg/apache/hadoop/hive/serde2/objectinspector/ObjectInspector;
  at ExprNodeGenericFuncEvaluator.initialize(ExprNodeGenericFuncEvaluator.java:146)
  at SelectOperator.initializeOp(SelectOperator.java:75)
  at MapOperator.initializeMapOperator(MapOperator.java:509)
  at MapRecordProcessor.init(MapRecordProcessor.java:317)
```

> **注意**：日志开头出现的 `No view rendered for 200`（`/ui/ws/v2/tez/dagInfo`）是 Tez UI 渲染异常，与作业失败**无关**，可忽略。

---

## 3. 排查过程

### 3.1 确定根因异常类型

从海量级联日志中优先定位第一个 `FAILED`（而非 `KILLED`）的 Vertex，找到 `Map 4` 的 `OWN_TASK_FAILURE`，提取 `Caused by` 链末端：

```
java.lang.AbstractMethodError: ...GenericUDF.initializeAndFoldConstants(...)
```

`AbstractMethodError` 在 Java 中的含义：**运行时 JVM 试图调用一个被声明为 abstract 的方法，但该方法在具体实现类中没有实现**。

### 3.2 通过 Vertex 反查 UDF

查看业务 SQL 与 Vertex 的对应关系：

| Vertex | 处理的表 | 使用的自定义 UDF |
|--------|---------|----------------|
| Map 1 | `msns.mvp_dwd_event_base_all` | `msns.custom_decrypt(phone_no)` |
| Map 4 | `msns.mvp_dwd_event_click` | `msns.parse_phone_no(content1)` |

**Map 1 有任务成功完成**，说明 `custom_decrypt` 正常；**Map 4 全部失败**，锁定 `msns.parse_phone_no`。

### 3.3 查询 UDF 实现类与 jar 路径

`SHOW CREATE FUNCTION` 在 Hive 3.1.x 上会报 ParseException，改用：

```sql
USE msns;
DESCRIBE FUNCTION EXTENDED parse_phone_no;
```

获得 jar 路径后，用 javap 查看实现类继承关系：

```bash
javap -p -classpath hive-udf-1.0-jar-with-dependencies.jar \
  com.example.udf.ParsePhoneNo | head -3
```

输出：

```
public class com.example.udf.ParsePhoneNo
  extends org.apache.hadoop.hive.ql.exec.UDF {
```

**关键发现**：`ParsePhoneNo` 继承的是旧式 `UDF` 接口，**不是** `GenericUDF`。初始假设"UDF 未实现 `initializeAndFoldConstants`"被推翻——`UDF` 子类本身不需要也无法实现该方法。

### 3.4 梳理 jar 内所有自定义 UDF

```bash
jar tf hive-udf-1.0-jar-with-dependencies.jar | grep "\.class$" | grep "example"
```

jar 内所有业务 UDF 类及其继承关系：

| 类名 | 继承 |
|------|------|
| `ParsePhoneNo` | `extends UDF` |
| `IPParserUDF` | `extends UDF` |
| `UDFGeoLocationParser` | `extends UDF` |
| `ToJson` | `extends GenericUDF` |
| `CollectCombine` | `extends GenericUDF` |
| 其他（`HanlpSeg` 等） | 待确认 |

`ToJson` 和 `CollectCombine` 是 `GenericUDF` 子类，但均未在失败 SQL 中使用，且 javap 确认两者也没有覆写 `initializeAndFoldConstants`。

### 3.5 验证 jar 不包含 Hive 类

```bash
jar tf hive-udf-1.0-jar-with-dependencies.jar | grep "org/apache/hadoop/hive"
# 返回空 → jar 内无 Hive 框架类，排除双版本打包冲突
```

### 3.6 检查 Tez 运行时 hive-exec 来源

```bash
# Tez tar.gz 不含 hive-exec
tar -tzf tez.new.tar.gz | grep hive-exec
# 返回空

# bigtop 本地 hive-exec 中该方法为 concrete（非 abstract）
javap -classpath /usr/bigtop/3.2.0/usr/lib/hive/lib/hive-exec-*.jar \
  org.apache.hadoop.hive.ql.udf.generic.GenericUDF | grep initializeAndFoldConstants
# 输出：public ObjectInspector initializeAndFoldConstants(...) → concrete
```

bigtop 版本的 `GenericUDF.initializeAndFoldConstants` 是 concrete，意味着 **bigtop 版本不是问题触发版本**。Hive-on-Tez 模式下 HS2 会将自己本地的 hive-exec 上传到 HDFS 分发给 Tez 容器，该版本与 bigtop 可能不同，尚未确认。

### 3.7 排除"常量折叠触发路径"假设

尝试临时方案：

```sql
set hive.optimize.constant.propagation=false;
-- 加该参数后重跑失败版本 SQL
```

结果：**仍以相同 `AbstractMethodError` 失败**。

这说明 `initializeAndFoldConstants` 的调用**不是**常量折叠优化触发的——在当前集群 Hive 版本中，`ExprNodeGenericFuncEvaluator.initialize()` 对每个 UDF 算子都会无条件调用该方法，与是否开启常量传播无关。

### 3.8 关键约束：仅此用户作业失败

其他业务方作业运行正常。若根因是 Tez 容器 hive-exec 版本导致所有旧式 `UDF` 不兼容，则集群上所有使用 `extends UDF` 的函数都应失败。**"只有此用户失败"说明问题与该 jar 本身强相关**，而非集群全局问题。

---

## 4. 根因分析

### 4.1 旧式 UDF 的运行时包装机制

Hive 有两套 UDF 接口：

| 接口 | 特点 |
|------|------|
| `org.apache.hadoop.hive.ql.exec.UDF` | 旧接口，简单，通过反射调用 `evaluate()` 方法 |
| `org.apache.hadoop.hive.ql.udf.generic.GenericUDF` | 新接口，需实现 `initialize()` 和 `evaluate()` |

当 SQL 中使用 `extends UDF` 的函数时，Hive 在运行时用 `GenericUDFBridge`（`GenericUDF` 的子类）将其包装：

```
parse_phone_no(content1)
    ↓ 运行时替换
GenericUDFBridge（包装 ParsePhoneNo）
    ↓ 算子初始化时
ExprNodeGenericFuncEvaluator.initialize()
    ↓ 调用
GenericUDFBridge.initializeAndFoldConstants(...)
    ↓ 若父类 GenericUDF 中该方法为 abstract 且 GenericUDFBridge 未实现
AbstractMethodError
```

### 4.2 `initializeAndFoldConstants` 的调用时机

在较新版本的 Hive 中，`ExprNodeGenericFuncEvaluator.initialize()` **无条件**调用 `initializeAndFoldConstants()`，不受 `hive.optimize.constant.propagation` 参数控制。这与"常量折叠是触发器"的初始假设不同——该方法是算子初始化的标准路径，不是优化路径。

### 4.3 当前假设的根因链路

```
ParsePhoneNo extends UDF（旧接口）
    ↓ 运行时
GenericUDFBridge extends GenericUDF（包装器）
    ↓ Tez 容器加载的 hive-exec 中
GenericUDF.initializeAndFoldConstants = abstract
    ↓ GenericUDFBridge 未实现该方法
AbstractMethodError
```

**未解的问题**：bigtop 路径的 hive-exec 中该方法是 concrete，但 Tez 容器实际加载的是 HS2 上传到 HDFS 的 hive-exec（路径由 `hive.jar.directory` 控制），该版本尚未确认。

---

## 5. 解决方案

### 5.1 已验证无效的临时方案

~~`set hive.optimize.constant.propagation=false`~~

该参数无效，`initializeAndFoldConstants` 的调用与常量传播开关无关。

### 5.2 永久修复（推荐）

将所有旧式 `extends UDF` 改写为 `extends GenericUDF`，实现 `initialize()` 和 `initializeAndFoldConstants()`：

```java
public class ParsePhoneNo extends GenericUDF {

    @Override
    public ObjectInspector initialize(ObjectInspector[] arguments)
            throws UDFArgumentException {
        // 参数类型检查和返回类型声明
        return PrimitiveObjectInspectorFactory.javaStringObjectInspector;
    }

    @Override
    public ObjectInspector initializeAndFoldConstants(ObjectInspector[] arguments)
            throws UDFArgumentException {
        return initialize(arguments);  // 默认转发即可
    }

    @Override
    public Object evaluate(DeferredObject[] arguments) throws HiveException {
        // 原有解析逻辑
    }

    @Override
    public String getDisplayString(String[] children) {
        return "parse_phone_no(" + children[0] + ")";
    }
}
```

重新打包并更新 UDF 注册：

```sql
DROP FUNCTION IF EXISTS msns.parse_phone_no;
CREATE FUNCTION msns.parse_phone_no
    AS 'com.example.udf.ParsePhoneNo'
    USING JAR 'hdfs:///path/to/udf-new.jar';
```

**注意**：该 jar 内所有 `extends UDF` 的类均需同步改写，避免其他函数触发相同问题。

### 5.3 当日数据紧急恢复

在根因完全确认前，可联系 HS2 管理员确认 Tez 容器使用的 hive-exec 版本，或尝试以下方向：

```bash
# 找 HS2 上传给 Tez 容器的 hive-exec
# Ambari → Hive → Configs → hive.jar.directory
hdfs dfs -ls <hive.jar.directory>/ | grep hive-exec

hdfs dfs -get <path>/hive-exec-*.jar /tmp/hive-exec-hs-02.jar
javap -classpath /tmp/hive-exec-hs-02.jar \
  org.apache.hadoop.hive.ql.udf.generic.GenericUDF | grep initializeAndFoldConstants
```

若确认 HS2 版本中该方法为 abstract，则唯一出路是修复 UDF jar（5.2）或降级 HS2 hive-exec（不推荐）。

---

## 6. 待确认事项

| 编号 | 待确认内容 | 操作 |
|------|-----------|------|
| ① | Hive Metastore 注册的 jar HDFS 路径 | `USE msns; DESCRIBE FUNCTION EXTENDED parse_phone_no;` |
| ② | Metastore 注册的 jar 与本地分析的 jar 是否同一文件 | `hdfs dfs -get <path> /tmp/udf-check.jar && md5sum /tmp/udf-check.jar hive-udf-1.0-jar-with-dependencies.jar` |
| ③ | HS2 上传给 Tez 容器的 hive-exec 版本 | 查 `hive.jar.directory`，javap 确认 `GenericUDF.initializeAndFoldConstants` 是否为 abstract |
| ④ | 集群其他使用 `extends UDF` 的函数是否正常 | 找一个其他旧式 UDF 函数执行简单查询，验证是否报同一错误 |

---

## 7. 预防措施

### 7.1 UDF 接口规范

新增自定义 UDF 一律使用 `GenericUDF` 接口，禁止使用旧式 `UDF` 接口：
- `GenericUDF` 兼容性更好，不依赖 `GenericUDFBridge` 包装
- 在 CI 编译检查中加入：用集群当前 hive-exec 版本编译，不报错才允许发布

### 7.2 排查 UDF 版本不兼容的通用思路

遇到 Hive/Tez 作业失败时，先看 `Caused by` 链末端：

| 异常类型 | 含义 | 排查方向 |
|---------|------|---------|
| `AbstractMethodError` | 运行时类未实现某抽象方法 | UDF/依赖 jar 与集群 hive-exec 版本不兼容 |
| `NoSuchMethodError` | 运行时找不到某方法 | 同上，或 classpath 中存在多版本冲突 |
| `ClassNotFoundException` | 类不存在 | jar 未上传、路径错误或版本缺失 |
| `IncompatibleClassChangeError` | 类结构发生不兼容变更 | 接口/父类升级，子类未跟进 |

### 7.3 连带检查

建议对 `msns` 命名空间下所有自定义 UDF 做一次普查：

```sql
SHOW FUNCTIONS LIKE 'msns.*';
```

对每个函数获取 jar 路径，检查其中所有 `GenericUDF` 子类是否实现了 `initializeAndFoldConstants`，所有 `UDF` 子类是否需要迁移到 `GenericUDF`。
