---
title: "快速上手：第一个 Flink 程序"
date: 2026-03-02
tags: [Flink, 入门, DataStream, 实战, 开发环境, Maven, 本地调试]
aliases: ["Flink快速上手", "Flink第一个程序", "Flink Hello World"]
---

**摘要：**

本文带你从零搭建 Flink 开发环境，写出第一个可以本地运行的 Flink 流处理程序，并深入理解这段程序的每一行代码背后的设计意图。学习一个新框架，第一个 Hello World 程序往往只需 5 分钟，但真正的挑战在于理解：`StreamExecutionEnvironment` 为什么必须调用 `execute()`？`keyBy` 的参数应该如何选择？本地调试模式和提交集群有什么本质区别？本文在完成快速上手的同时，回答这些"为什么"，让你从一开始就建立正确的 Flink 使用心智模型。

---

## 第 1 章 开发环境搭建

### 1.1 前置条件

开始之前确认以下环境已就绪：

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Java | JDK 11 或 JDK 17 | Flink 1.18+ 推荐 JDK 11/17，JDK 8 仍支持但不推荐 |
| Maven | 3.6+ | 用于依赖管理和构建 |
| IDE | IntelliJ IDEA（推荐）| 对 Scala 和 Java 的 Flink 代码支持最好 |

验证 Java 版本：
```bash
java -version
# 期望输出类似：openjdk version "11.0.21" 2023-10-17
```

### 1.2 使用 Maven Archetype 快速创建项目

Flink 官方提供了 Maven Archetype（项目模板），一条命令即可生成完整的项目结构：

```bash
mvn archetype:generate \
    -DarchetypeGroupId=org.apache.flink \
    -DarchetypeArtifactId=flink-quickstart-java \
    -DarchetypeVersion=1.18.1 \
    -DgroupId=com.example \
    -DartifactId=flink-demo \
    -Dversion=1.0-SNAPSHOT \
    -Dpackage=com.example.flink \
    -DinteractiveMode=false
```

这会生成如下项目结构：

```
flink-demo/
├── pom.xml
└── src/
    └── main/
        └── java/
            └── com/example/flink/
                ├── DataStreamJob.java      # 主入口（流处理作业）
                └── StreamingJob.java       # 另一个示例（可删除）
```

### 1.3 理解 pom.xml 中的关键依赖

打开生成的 `pom.xml`，重点关注这几个依赖的作用：

```xml
<!-- Flink 核心运行时：DataStream API、算子、时间语义等核心能力 -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-streaming-java</artifactId>
    <version>${flink.version}</version>
    <!-- provided 表示运行时由 Flink 集群提供，打包时不包含 -->
    <!-- 本地开发时需要特殊处理，见 1.4 节 -->
    <scope>provided</scope>
</dependency>

<!-- Flink 客户端工具：本地运行、提交作业等客户端功能 -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-clients</artifactId>
    <version>${flink.version}</version>
    <scope>provided</scope>
</dependency>
```

**为什么核心依赖是 `provided` 而不是 `compile`？**

当 Flink 作业提交到生产集群（YARN/K8s/Standalone）运行时，Flink 的运行时 JAR 已经部署在集群的 `lib/` 目录中，TaskManager 进程启动时已经加载了这些 JAR。如果你的业务 JAR 也包含这些 JAR，会导致类路径中存在重复的类，引发 `ClassCastException` 或 `NoSuchMethodError`——因为不同 ClassLoader 加载的同名类 JVM 认为是不同的类。

所以 Flink 的核心依赖应当是 `provided`（由集群提供），你的业务 JAR 只包含你自己的代码和第三方依赖（如 MySQL JDBC Driver、自定义序列化库等）。

### 1.4 本地调试的关键配置

`provided` 的依赖在本地 IDE 运行时不可用（因为没有集群提供这些 JAR）。解决方案是在 `pom.xml` 中添加一个专门用于本地运行的 Maven profile：

```xml
<profiles>
    <profile>
        <!-- 激活方式：mvn compile -Plocal 或在 IDEA 中勾选 local profile -->
        <id>local</id>
        <dependencies>
            <dependency>
                <groupId>org.apache.flink</groupId>
                <artifactId>flink-streaming-java</artifactId>
                <version>${flink.version}</version>
                <!-- 本地 profile 中改为 compile，使得本地运行可以找到这些类 -->
                <scope>compile</scope>
            </dependency>
            <dependency>
                <groupId>org.apache.flink</groupId>
                <artifactId>flink-clients</artifactId>
                <version>${flink.version}</version>
                <scope>compile</scope>
            </dependency>
        </dependencies>
    </profile>
</profiles>
```

在 IntelliJ IDEA 中，打开右侧 Maven 面板 → Profiles → 勾选 `local`，然后点击刷新，即可在本地直接运行。

> [!warning] 生产避坑：打包时不要激活 local profile
> 构建用于生产提交的 JAR 时，必须确保 `local` profile 未激活：`mvn clean package`（不带 `-Plocal`）。否则打包出的 FAT JAR 会包含 Flink 运行时，体积大幅增加（从几 MB 膨胀到数百 MB），且可能与集群的 Flink 版本冲突。

---

## 第 2 章 第一个程序：WordCount 流式版

### 2.1 完整代码

让我们从经典的 WordCount（词频统计）开始，但这次是**流式**版本：从 Socket 实时读取文本，统计每个单词的出现次数，实时输出结果。

```java
package com.example.flink;

import org.apache.flink.api.common.functions.FlatMapFunction;
import org.apache.flink.api.java.tuple.Tuple2;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.util.Collector;

public class StreamingWordCount {

    public static void main(String[] args) throws Exception {
        // 1. 获取执行环境（本地模式 vs 集群模式由环境自动判断）
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // 2. 设置并行度（本地调试时设为 1，方便查看顺序输出）
        env.setParallelism(1);

        // 3. 创建数据源：监听本地 9999 端口的 Socket 文本流
        DataStream<String> text = env.socketTextStream("localhost", 9999);

        // 4. 数据处理链：FlatMap → KeyBy → Sum
        DataStream<Tuple2<String, Integer>> wordCounts = text
            // FlatMap：将每行文本拆分为单词，并为每个单词产生 (word, 1) 元组
            .flatMap(new FlatMapFunction<String, Tuple2<String, Integer>>() {
                @Override
                public void flatMap(String line, Collector<Tuple2<String, Integer>> out) {
                    // 按空白字符拆分，过滤空字符串
                    for (String word : line.split("\\s+")) {
                        if (!word.isEmpty()) {
                            out.collect(Tuple2.of(word.toLowerCase(), 1));
                        }
                    }
                }
            })
            // keyBy：按单词分组（相同单词的记录发往同一个 Subtask）
            .keyBy(tuple -> tuple.f0)
            // sum：对第二个字段（计数值）做累加
            .sum(1);

        // 5. 定义输出（Sink）：打印到控制台
        wordCounts.print();

        // 6. 触发执行（不调用 execute()，程序不会运行！）
        env.execute("Streaming WordCount");
    }
}
```

### 2.2 运行这个程序

**步骤一：启动 Socket 服务**

在另一个终端窗口，使用 `nc`（netcat）监听 9999 端口，充当数据源：

```bash
nc -lk 9999
# macOS 用户如果 nc 不支持 -k 选项，使用：
# while true; do nc -l 9999; done
```

**步骤二：在 IDE 中运行 `StreamingWordCount.main()`**

启动程序后，切换到 nc 终端窗口，输入一些文本并回车：

```
hello world
hello flink
flink is great
```

此时 IDE 的控制台应该输出：

```
(hello,1)
(world,1)
(hello,2)      ← 第二次出现 hello，累计变为 2
(flink,1)
(flink,2)      ← 第二次出现 flink
(is,1)
(great,1)
```

**步骤三：中止程序**

在 IDE 中点击停止按钮，或在 nc 终端按 `Ctrl+C`（Socket 关闭后，Flink 会收到 EOF，作业自动结束）。

### 2.3 逐行解析：每一步背后的设计意图

**`StreamExecutionEnvironment.getExecutionEnvironment()`**

这是 Flink 程序的起点，用于获取执行环境。它的行为取决于运行上下文：

- **本地运行**（直接在 IDE 中运行 `main()` 方法）：返回一个 `LocalStreamEnvironment`，在当前 JVM 进程中直接启动一个内嵌的 Flink 集群（1 个 JM + 1 个 TM），所有 Task 在本地线程中执行
- **提交到远程集群运行**：返回一个 `RemoteStreamEnvironment`，连接到指定的 JobManager，将 JobGraph 提交给远程集群执行

这种"运行时感知"的设计让同一份代码在本地开发和生产集群上无缝运行，无需修改任何代码。

**`env.setParallelism(1)`**

并行度（Parallelism）决定了每个算子有多少个并发的 Subtask。本地调试时设为 1 有两个好处：
1. 输出顺序可预测（不会因为多线程并发导致输出顺序错乱）
2. 减少资源消耗，本地运行更流畅

注意：并行度设置有多个生效层级：全局默认 < 算子级别（`.setParallelism(N)` 在特定算子上调用）< 环境级别（`env.setParallelism(N)`）。

**`.flatMap()`**

`FlatMap` 是一个"一进多出"的转换算子：输入一条记录，可以输出 0 条、1 条或多条记录。我们的实现中，输入是一行文本（如 `"hello world"`），输出是多个 `(word, count)` 元组（`("hello", 1)` 和 `("world", 1)`）。

`Collector<T>` 是 Flink 提供的输出收集器，调用 `out.collect(record)` 将一条记录发往下游。**注意：不要在方法外持有 `Collector` 的引用，它不是线程安全的，且生命周期由 Flink 框架管理**。

**`.keyBy(tuple -> tuple.f0)`**

`keyBy` 是流处理中最重要的算子之一，它将流按照某个 Key 进行分区（Partition）——相同 Key 的记录保证发往同一个下游 Subtask。

`keyBy` 背后发生的事情：Flink 对 Key 计算哈希值，然后对下游并行度取模，决定这条记录发往哪个 Subtask。这是一次**网络 Shuffle**（数据重分区），如果上下游在不同 TaskManager 上，数据需要经过网络传输。

> [!note] 设计哲学：为什么 keyBy 之后才能做有状态计算
> `keyBy` 之后，相同 Key 的所有记录保证由同一个 Subtask 处理。这个保证是有状态计算的基础——Flink 可以在每个 Subtask 内独立维护该 Key 的状态（如累计计数），而不需要跨 Subtask 协调状态，避免了分布式锁的开销。如果没有 `keyBy`，Flink 无法知道某个特定 Key 的记录"属于"哪个 Subtask，就无法安全地维护 per-key 状态。

**`.sum(1)`**

`sum(fieldIndex)` 是 `KeyedStream` 上的聚合算子，对指定字段做累加。`1` 表示对 `Tuple2` 的第二个字段（`count`，0-indexed）进行累加。

`sum` 内部维护了一个 `ValueState<T>`（对每个 Key 维护一个值），每来一条新记录，就从状态中读取当前累计值，加上新记录的值，更新状态，然后输出更新后的结果。这个状态操作是 Flink 有状态计算的最简单体现。

**`wordCounts.print()`**

`print()` 是一个内置的 Sink，将每条记录格式化为字符串，打印到 TaskManager 进程的标准输出（stdout）。在本地运行时，这就是 IDE 的控制台；在集群运行时，这是 TaskManager 节点的日志输出（通过 Flink Web UI 或 `yarn logs` 查看）。

**`env.execute("Streaming WordCount")`**

**这是最容易被初学者忽视的一行，也是最关键的一行。**

Flink 的编程模型是**惰性求值（Lazy Evaluation）**：在 `env.execute()` 被调用之前，所有对 `DataStream` API 的操作（`flatMap`、`keyBy`、`sum`、`print`）都不会真正执行——它们只是在构建 Flink 的流图（StreamGraph），描述"数据应该怎么被处理"的逻辑。

只有当调用 `execute()` 时，Flink 才会：
1. 将 StreamGraph 编译为 JobGraph（算子链合并等优化）
2. 将 JobGraph 提交给 JobManager
3. JobManager 生成 ExecutionGraph，调度 TaskManager 执行
4. `execute()` 阻塞等待，直到作业完成（或失败，或被取消）

**如果不调用 `execute()`，什么都不会发生**。这是初学者最常犯的错误之一。

---

## 第 3 章 程序结构的进阶：Lambda 与方法引用

### 3.1 从匿名内部类到 Lambda 表达式

上面的 `FlatMap` 使用了匿名内部类，代码较为冗长。在 Java 8+ 中，可以用 Lambda 表达式简化：

```java
DataStream<Tuple2<String, Integer>> wordCounts = text
    .flatMap((String line, Collector<Tuple2<String, Integer>> out) -> {
        for (String word : line.split("\\s+")) {
            if (!word.isEmpty()) {
                out.collect(Tuple2.of(word.toLowerCase(), 1));
            }
        }
    })
    // 注意：使用 Lambda 时需要显式指定返回类型，否则 Flink 无法推断
    .returns(Types.TUPLE(Types.STRING, Types.INT))
    .keyBy(tuple -> tuple.f0)
    .sum(1);
```

**为什么需要 `.returns()`？**

Java 的泛型在编译后会被擦除（Type Erasure），Lambda 表达式的泛型类型信息在运行时不可用。Flink 在运行时需要知道每个算子的输出类型，以便：
1. 决定如何序列化/反序列化数据
2. 为下游算子正确配置类型
3. 在状态中存储数据时选择合适的序列化器

使用匿名内部类时，Flink 可以通过反射从泛型声明中提取类型信息；使用 Lambda 时，类型信息丢失，因此需要调用 `.returns()` 显式告诉 Flink 输出类型。

这是 Flink 与 Spark 的一个差异点——Spark 的 RDD 是基于 JVM 对象的，序列化发生在更晚的阶段；而 Flink 在编译期就需要确定类型，以便为网络传输准备高效的序列化器。

### 3.2 使用 POJO 替代 Tuple：更具可读性的代码

`Tuple2<String, Integer>` 访问字段时用 `.f0`、`.f1`，可读性差。生产代码中更推荐定义专用的 POJO 类：

```java
// 定义 POJO 类（必须有无参构造函数和 getter/setter，Flink 用它反射序列化）
public class WordCount {
    public String word;   // 字段必须是 public 或有 getter/setter
    public int count;

    public WordCount() {}  // 无参构造函数必须存在

    public WordCount(String word, int count) {
        this.word = word;
        this.count = count;
    }

    @Override
    public String toString() {
        return word + ": " + count;
    }
}

// 使用 POJO 重写 WordCount
DataStream<WordCount> wordCounts = text
    .flatMap((String line, Collector<WordCount> out) -> {
        for (String word : line.split("\\s+")) {
            if (!word.isEmpty()) {
                out.collect(new WordCount(word.toLowerCase(), 1));
            }
        }
    })
    .returns(WordCount.class)
    .keyBy(wc -> wc.word)                     // 按 word 字段分组
    .reduce((wc1, wc2) -> new WordCount(wc1.word, wc1.count + wc2.count));
    // 注意：这里用 reduce 代替 sum，因为 POJO 没有 sum 直接支持
```

> [!info] 核心概念：Flink POJO 的要求
> Flink 将满足以下条件的类视为 POJO，并使用高效的 PojoSerializer：
> 1. 类是 `public` 的
> 2. 有无参的 `public` 构造函数
> 3. 所有字段是 `public` 的，或者有对应的 `getter`/`setter`
> 4. 类本身没有实现 Flink 的 Serializer 接口
> 
> 满足 POJO 条件的对象，Flink 可以直接按字段序列化，不需要 Java 的 `ObjectOutputStream`（后者很慢且产生大量字节）。如果你的类不满足 POJO 条件，Flink 会回退到 Kryo 序列化，性能会有所下降。

---

## 第 4 章 本地调试技巧

### 4.1 设置断点调试

在 IDE 中，可以像调试普通 Java 程序一样为 Flink 代码设置断点：

```java
.flatMap((String line, Collector<WordCount> out) -> {
    for (String word : line.split("\\s+")) {
        // ← 在此设置断点，可以查看 line 的值和循环状态
        if (!word.isEmpty()) {
            out.collect(new WordCount(word.toLowerCase(), 1));
        }
    }
})
```

断点调试时注意：
- 本地模式下，所有 Subtask 运行在同一 JVM 的不同线程中，断点会暂停整个程序（所有线程）
- 如果并行度 > 1，多个 Subtask 的线程可能同时到达同一断点，在调试视图中会看到多个线程
- 建议本地调试时设置 `env.setParallelism(1)`，减少干扰

### 4.2 使用 fromElements 替代 Socket 数据源

Socket 数据源需要外部工具配合，调试不方便。可以用 `fromElements` 或 `fromCollection` 生成测试数据：

```java
// 方式一：fromElements（直接在代码中给定测试数据）
DataStream<String> text = env.fromElements(
    "hello world",
    "hello flink",
    "flink is great",
    "hello hello hello"
);

// 方式二：fromCollection（适合更多测试数据）
List<String> testData = Arrays.asList(
    "apache flink is a stream processing framework",
    "flink processes unbounded and bounded data streams"
);
DataStream<String> text = env.fromCollection(testData);
```

注意：`fromElements` 和 `fromCollection` 生成的是**有界流**（Bounded Stream），处理完所有元素后作业会自动结束。而 Socket 数据源是**无界流**（Unbounded Stream），会一直等待新数据。

### 4.3 本地 Web UI：可视化调试利器

Flink 1.14 之后，本地运行时可以启动内嵌的 Web UI，方便查看算子图、Metrics、Task 状态：

```xml
<!-- pom.xml 中添加 flink-runtime-web 依赖（仅用于本地开发）-->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-runtime-web</artifactId>
    <version>${flink.version}</version>
    <scope>provided</scope>  <!-- local profile 中改为 compile -->
</dependency>
```

```java
// 代码中开启本地 Web UI
Configuration conf = new Configuration();
conf.setBoolean(RestOptions.ENABLE_FLAMEGRAPH, true);  // 可选：开启 FlameGraph
StreamExecutionEnvironment env =
    StreamExecutionEnvironment.createLocalEnvironmentWithWebUI(conf);
```

启动程序后，访问 `http://localhost:8081` 即可看到 Flink Web UI，可以查看：
- 作业的算子 DAG 图
- 每个算子的 Subtask 数量和状态
- 实时的 Metrics（吞吐量、延迟、背压指标）

---

## 第 5 章 打包并提交到集群

### 5.1 打包 FAT JAR

当代码在本地测试通过后，需要打包成 JAR 提交到生产集群。使用 Maven Shade Plugin（已在 archetype 生成的 pom.xml 中配置）：

```bash
# 打包（不激活 local profile，核心依赖为 provided）
mvn clean package -DskipTests

# 打包后的 JAR 在 target/ 目录下
ls target/flink-demo-1.0-SNAPSHOT.jar
```

生成的 JAR 包含你的业务代码及其直接依赖（非 Flink 核心库），通常在几 MB 到几十 MB 之间。

### 5.2 提交到 Standalone 集群

如果你有一个本地部署的 Flink Standalone 集群：

```bash
# 提交作业
$FLINK_HOME/bin/flink run \
    -c com.example.flink.StreamingWordCount \
    target/flink-demo-1.0-SNAPSHOT.jar

# 带参数提交（通过 args 传递 Socket 主机和端口）
$FLINK_HOME/bin/flink run \
    -p 4 \        # 并行度为 4
    -c com.example.flink.StreamingWordCount \
    target/flink-demo-1.0-SNAPSHOT.jar \
    --host localhost --port 9999
```

命令行参数通过 `args` 传入 `main(String[] args)` 方法，推荐使用 `ParameterTool` 解析：

```java
// 在 main() 方法中解析命令行参数
ParameterTool params = ParameterTool.fromArgs(args);
String host = params.get("host", "localhost");  // 第二个参数是默认值
int port = params.getInt("port", 9999);

DataStream<String> text = env.socketTextStream(host, port);
```

### 5.3 提交到 YARN（Session Mode）

```bash
# 前提：已有运行中的 Flink on YARN Session 集群
# 获取 Application ID（启动 Session 时会输出）
export FLINK_YARN_SESSION_APPID=application_1705000000_0001

# 提交作业到 Session
$FLINK_HOME/bin/flink run \
    -t yarn-session \
    -Dyarn.application.id=${FLINK_YARN_SESSION_APPID} \
    -c com.example.flink.StreamingWordCount \
    target/flink-demo-1.0-SNAPSHOT.jar
```

Session Mode 的详细配置将在 [[09 Flink on YARN 与 Kubernetes 生产部署]] 中深入讲解。

---

## 第 6 章 理解 Flink 程序的生命周期

### 6.1 有界流 vs 无界流的生命周期差异

这是初学者经常困惑的地方：同样是 Flink 作业，为什么有些会自动结束，有些一直运行？

**有界流（Bounded Stream）**：数据有终点（如 `fromElements`、读取 HDFS 文件、有界的 Kafka topic）。当所有 Source 算子读完所有数据并发出 `EOF` 信号后，数据流沿 DAG 传播，所有 Sink 算子写完数据后，作业自动结束，`execute()` 方法返回。

**无界流（Unbounded Stream）**：数据没有终点（如 `socketTextStream`、持续消费 Kafka）。作业会一直运行，`execute()` 方法永不返回（直到程序被外部中止，如 SIGTERM，或 JobManager 接到取消请求）。

这个差异对部署方式也有影响：有界流作业通常作为一次性批处理任务运行（跑完就退出）；无界流作业是长期运行的服务，需要 HA、监控、自动重启等生产级保障。

### 6.2 `execute()` 的执行模式：Attached vs Detached

`env.execute()` 默认是 **attached 模式**：Client 进程保持连接，等待作业完成。作业的最终状态（FINISHED/FAILED）会作为 `execute()` 的返回值或异常。

某些场景下希望提交后立即返回（如在 Oozie Workflow 中提交 Flink 作业，Oozie 负责监控而不是 Client）：

```java
// Detached 模式：提交后立即返回，不等待作业结束
env.executeAsync("Streaming WordCount");
// 或通过配置
env.getConfig().setExecutionMode(ExecutionMode.ASYNC);
```

通过 CLI 提交时：
```bash
# Detached 模式：-d 标志
flink run -d -c com.example.flink.StreamingWordCount job.jar
```

---

## 小结

本文完成了 Flink 开发环境的搭建，并深入解析了第一个 Flink 程序的每一个关键点：

- **`provided` vs `compile` 依赖**：核心依赖 `provided` 避免与集群 JAR 冲突，local profile 用于本地调试
- **惰性求值**：DataStream API 调用只是在构建流图，`execute()` 才是真正触发执行的入口
- **`keyBy` 的语义**：按 Key 分区，保证相同 Key 由同一 Subtask 处理，是有状态计算的前提
- **Type 信息**：POJO 类型 Flink 可以自动推断；Lambda 表达式需要显式 `.returns()` 补充类型信息
- **有界 vs 无界流**：前者自动结束，后者持续运行，影响部署和运维策略
- **本地调试技巧**：`fromElements` 替代 Socket、`setParallelism(1)` 简化输出、本地 Web UI 可视化

下一篇 [[03 DataStream API 深度使用指南]] 将系统讲解 Source、Transformation、Sink 的全部算子，以及并行度控制、分区策略等核心使用技巧。


> [!note] 思考题
> 1. Flink 的 DataStream API 是惰性求值的——所有的转换操作只是在构建执行计划图（StreamGraph），只有调用 `env.execute()` 才会真正触发执行。这与 Spark 的 RDD 惰性求值非常相似，但两者的触发机制有所不同。Flink 中如果用户忘记调用 `execute()`，程序会静默退出还是报错？在本地调试模式下，行为是否与集群模式相同？
> 2. 本地执行模式（`createLocalEnvironment()`）和集群执行模式（`getExecutionEnvironment()`）的代码在逻辑上是相同的，但行为有差异——本地模式下所有 Operator 在同一个 JVM 进程中运行，共享内存空间。这意味着某些在本地不会出现的问题（如序列化 / 反序列化错误、跨 Task 的状态隔离问题）在集群上才会暴露。如何通过本地测试尽早发现这类集群特有的问题？
> 3. Flink Maven Archetype 生成的项目将 Flink 依赖设置为 `provided` scope，意味着打包时不包含 Flink 框架 JAR。这是为了避免与集群上已有的 Flink 版本冲突。但如果用户使用了某个 Flink 版本新引入的 API（如某个 Connector），而集群上运行的是旧版本 Flink，会在什么时机报错？是编译期、提交期还是运行期？