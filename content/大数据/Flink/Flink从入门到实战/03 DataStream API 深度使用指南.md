---
title: "DataStream API 深度使用指南"
date: 2026-03-02
tags: [Flink, DataStream, API, Source, Sink, Transformation, 算子, 分区策略, 并行度]
aliases: ["DataStream API", "Flink算子", "Flink Source Sink"]
---

**摘要：**

`DataStream API` 是 Flink 最核心的编程接口，所有的流处理作业最终都归结为三件事：从哪来（Source）、怎么处理（Transformation）、去哪里（Sink）。本文系统梳理 DataStream API 的全部核心算子，不止步于"会用"，而是深入每个算子的语义边界：`map` 和 `flatMap` 的适用场景区别，`process` 算子为什么是最强大的算子，`keyBy` 之后的流与之前的流有什么本质差异，`connect` 和 `union` 各自解决什么问题。在此基础上，重点解析并行度控制和分区策略——这两个参数在生产调优中至关重要却常被忽视。读完本文，你对 DataStream API 的掌握将从"能跑起来"升级到"写出正确且高效的代码"。

---

## 第 1 章 DataStream 类型层次与流的本质

### 1.1 DataStream 不是一个类，而是一个家族

很多初学者以为 Flink 里只有一个 `DataStream<T>` 类，实际上 DataStream 是一个有层次的类型家族，不同的操作会产生不同类型的 Stream 对象，而不同类型的 Stream 有不同的可用算子：

```
DataStream<T>                     ← 基础流类型，可用绝大多数算子
  ├── KeyedStream<T, K>           ← keyBy() 后产生，可用聚合、状态算子
  ├── WindowedStream<T, K, W>     ← KeyedStream.window() 后产生，可用窗口函数
  ├── AllWindowedStream<T, W>     ← DataStream.windowAll() 后产生（非 Keyed 窗口）
  ├── ConnectedStreams<T1, T2>     ← connect() 后产生，两条流共享状态
  └── SplitStream<T>              ← 已废弃，用 SideOutput 替代
```

**为什么要区分这么多类型**：这是 Flink API 的类型安全设计。某些操作只有在特定流类型上才有意义——`sum()`、`reduce()` 这类聚合算子只有在 `KeyedStream` 上才合法（因为需要 per-key 状态），在普通 `DataStream` 上调用没有语义。将这个约束在编译期通过类型系统表达出来，比在运行时抛出异常要友好得多。

### 1.2 流的"惰性"本质

这一点在第 02 篇中已经提及，但值得再次强调：**DataStream 不是数据容器，它是计算描述**。

`DataStream<T> result = source.map(f1).filter(f2).keyBy(k).sum(1)` 这段代码执行后，内存中没有任何实际数据——有的只是一个描述"如何处理数据"的 StreamGraph。数据处理发生在 `env.execute()` 之后，由 TaskManager 的线程执行。

这与 Java 8 的 `Stream` API 非常相似：`stream.map(f).filter(g).collect()` 也是惰性的，`.collect()` 才触发执行。

---

## 第 2 章 Source：数据从哪来

### 2.1 内置 Source：快速上手与测试

Flink 提供了若干内置 Source，主要用于开发测试：

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// 1. fromElements：直接给定若干元素（有界流）
DataStream<String> s1 = env.fromElements("a", "b", "c", "a", "b");

// 2. fromCollection：从 Java 集合创建（有界流）
List<Integer> list = Arrays.asList(1, 2, 3, 4, 5);
DataStream<Integer> s2 = env.fromCollection(list);

// 3. socketTextStream：从 Socket 读取文本行（无界流）
DataStream<String> s3 = env.socketTextStream("localhost", 9999);

// 4. generateSequence / fromSequence：生成数字序列（测试用）
DataStream<Long> s4 = env.fromSequence(1, 100);  // 生成 1 到 100
```

> [!warning] 生产避坑：内置 Source 不适合生产
> `fromElements`、`fromCollection` 等内置 Source 在并行度 > 1 时，数据会被平均分配给多个 Subtask，但分配规则不透明且不保证顺序。生产环境请使用 Kafka、File System 等有明确语义保证的 Connector。

### 2.2 Kafka Source：生产环境最常用

Flink 与 [[Apache Kafka]] 的集成是生产中最常见的组合。Flink 1.14 后推荐使用新版的 `KafkaSource`（FLIP-27 格式），旧版的 `FlinkKafkaConsumer` 已被废弃：

```xml
<!-- pom.xml 中添加 Kafka Connector 依赖 -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-connector-kafka</artifactId>
    <version>3.1.0-1.18</version>  <!-- 版本格式：connector版本-flink版本 -->
</dependency>
```

```java
// 构建 KafkaSource
KafkaSource<String> kafkaSource = KafkaSource.<String>builder()
    .setBootstrapServers("kafka1:9092,kafka2:9092")
    .setTopics("user-events")              // 可以是多个 topic
    .setGroupId("flink-consumer-group-1")
    .setStartingOffsets(OffsetsInitializer.earliest())  // 从最早 offset 开始消费
    // 也可以是：.setStartingOffsets(OffsetsInitializer.latest())
    // 或：.setStartingOffsets(OffsetsInitializer.committedOffsets())  从上次提交位置
    .setValueOnlyDeserializer(new SimpleStringSchema())  // 只反序列化 value
    .build();

// 将 KafkaSource 添加到执行环境
DataStream<String> stream = env.fromSource(
    kafkaSource,
    WatermarkStrategy.noWatermarks(),  // Watermark 策略（第04篇详细讲）
    "Kafka Source"                     // 算子名称（在 Web UI 中显示）
);
```

**`setStartingOffsets` 的三种策略**：

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `earliest()` | 从 topic 最早的 offset 开始 | 首次运行，需要处理全量历史数据 |
| `latest()` | 从 topic 最新的 offset 开始 | 只关心作业启动后的新数据 |
| `committedOffsets()` | 从上次提交的 Consumer Group offset 继续 | 作业重启时继续上次进度（需要 Checkpoint） |
| `timestamp(ts)` | 从指定时间戳之后的消息开始 | 需要从某个历史时间点重放数据 |

> [!note] 设计哲学：KafkaSource 的 FLIP-27 新格式
> Flink 1.14 引入的新 Source API（FLIP-27）将 Source 拆分为两个职责：`SplitEnumerator`（在 JobMaster 端运行，负责发现和分配分区）和 `SourceReader`（在 TaskManager 端运行，负责实际读取数据）。这种分离使得 Flink 能够动态感知 Kafka topic 的分区变化（新增分区时无需重启作业），并更好地支持 Checkpoint 对齐。旧版的 `FlinkKafkaConsumer` 将这两个职责混在一起，无法支持动态分区发现。

### 2.3 File Source：读取文件系统数据

```java
// 新版 FileSource（FLIP-27 格式，Flink 1.14+）
FileSource<String> fileSource = FileSource
    .forRecordStreamFormat(
        new TextLineInputFormat(),       // 每行文本作为一条记录
        new Path("hdfs:///data/input/")  // 支持 HDFS、S3、本地路径
    )
    .monitorContinuously(Duration.ofSeconds(10))  // 每 10 秒扫描新文件（无界模式）
    // 不调用 monitorContinuously 则为有界模式（读完所有文件后结束）
    .build();

DataStream<String> fileStream = env.fromSource(
    fileSource,
    WatermarkStrategy.noWatermarks(),
    "File Source"
);
```

**有界模式 vs 持续监控模式**：
- **有界模式**（不调用 `monitorContinuously`）：读取指定路径下当前所有文件，读完后发出 EOF，作业结束。适合一次性批处理场景
- **持续监控模式**（调用 `monitorContinuously`）：周期性扫描目录，发现新文件则读取，作业持续运行。适合日志目录持续写入的场景

### 2.4 自定义 Source

对于没有官方 Connector 的数据源（自研消息队列、HTTP API、数据库 CDC 等），需要自定义 Source。Flink 1.14 之前用 `SourceFunction`，之后推荐用新 Source API，这里介绍更常用的 `SourceFunction`（仍然支持，只是被标记为 Legacy）：

```java
// 实现 SourceFunction：模拟一个持续产生随机订单事件的 Source
public class OrderEventSource implements SourceFunction<OrderEvent> {
    private volatile boolean running = true;  // volatile：线程可见性保证
    private final Random random = new Random();

    @Override
    public void run(SourceContext<OrderEvent> ctx) throws Exception {
        while (running) {
            long orderId = random.nextLong();
            double amount = random.nextDouble() * 1000;
            long eventTime = System.currentTimeMillis();

            // collect() 发出一条记录
            // 注意：在 EventTime 场景下应使用 collectWithTimestamp()
            ctx.collectWithTimestamp(
                new OrderEvent(orderId, amount, eventTime),
                eventTime
            );

            Thread.sleep(100);  // 控制发出速率
        }
    }

    @Override
    public void cancel() {
        // Flink 调用此方法通知 Source 停止（作业取消或停止时）
        running = false;
    }
}

// 使用自定义 Source
DataStream<OrderEvent> orders = env.addSource(new OrderEventSource());
```

**`running` 字段为什么必须是 `volatile`**：`cancel()` 方法由 Flink 的 Task 管理线程调用，`run()` 方法在 Source 线程中执行，两个线程之间没有同步机制。如果不用 `volatile`，JVM 可能将 `running` 的值缓存在 CPU 寄存器中，导致 Source 线程看不到 `cancel()` 的修改，无法正常停止。

---

## 第 3 章 Transformation：数据怎么处理

### 3.1 基础转换算子

#### 3.1.1 map：一进一出的变换

```java
// map：每条输入记录对应一条输出记录（不能过滤，不能扩展）
DataStream<OrderEvent> orders = ...;

// 提取订单金额
DataStream<Double> amounts = orders.map(order -> order.getAmount());

// 对象转换：OrderEvent → EnrichedOrder
DataStream<EnrichedOrder> enriched = orders.map(order -> {
    String category = lookupCategory(order.getProductId());  // 查询维度表
    return new EnrichedOrder(order, category);
});
```

**`map` 的边界**：输入 N 条，输出 N 条，一一对应。如果需要"一条输入不输出任何记录"（过滤）或"一条输入输出多条记录"（拆分），`map` 无法做到，需要用 `filter` 或 `flatMap`。

#### 3.1.2 flatMap：一进多出（或零出）

```java
// flatMap：每条输入可以输出 0 条、1 条或多条记录
// 通过 Collector 决定输出多少条

DataStream<String> lines = ...;

// 解析 JSON 数组，每个元素输出一条记录
DataStream<UserAction> actions = lines.flatMap(
    (String line, Collector<UserAction> out) -> {
        try {
            List<UserAction> parsed = JSON.parseArray(line, UserAction.class);
            parsed.forEach(out::collect);  // 输出多条
        } catch (Exception e) {
            // 解析失败：不调用 out.collect()，该记录被静默丢弃
            // 生产建议：输出到 SideOutput（侧输出）而不是直接丢弃
        }
    }
).returns(UserAction.class);
```

**`flatMap` 实现过滤**：不调用 `out.collect()` 就相当于过滤该记录，所以 `flatMap` 可以同时实现 `filter` + `map` + `flatMap` 三种语义。

#### 3.1.3 filter：条件过滤

```java
// filter：满足条件的记录通过，不满足的被丢弃
DataStream<OrderEvent> validOrders = orders
    .filter(order -> order.getAmount() > 0 && order.getUserId() != null);
```

**`filter` 是 `flatMap` 的特例**，但使用 `filter` 比 `flatMap` 更直观，也使得 Flink 的 Web UI 和日志中的算子名称更清晰（显示为 "Filter" 而不是 "FlatMap"）。

### 3.2 富函数（RichFunction）：带生命周期的算子

普通的 `MapFunction`、`FilterFunction` 等是无状态的纯函数。但生产中常常需要：
- 在算子启动时初始化外部连接（如数据库连接池、Redis 客户端）
- 在算子关闭时释放资源
- 在算子执行时访问 Flink 状态（`ValueState` 等）

这就需要使用**富函数（RichFunction）**，对应 `RichMapFunction`、`RichFlatMapFunction` 等，提供了 `open()`、`close()` 生命周期方法和 `getRuntimeContext()` 上下文访问：

```java
public class CategoryEnrichmentMap extends RichMapFunction<OrderEvent, EnrichedOrder> {

    // 声明状态描述符（在 open() 中注册）
    private transient ValueState<String> categoryCache;
    private transient JedisPool redisPool;  // Redis 连接池

    @Override
    public void open(Configuration parameters) throws Exception {
        // open() 在算子启动时调用一次（每个 Subtask 调用一次）
        // 初始化外部连接
        redisPool = new JedisPool("redis-host", 6379);

        // 注册 Flink 状态（只有在 open() 中才能访问 RuntimeContext）
        ValueStateDescriptor<String> descriptor =
            new ValueStateDescriptor<>("category-cache", String.class);
        categoryCache = getRuntimeContext().getState(descriptor);
    }

    @Override
    public EnrichedOrder map(OrderEvent order) throws Exception {
        // 先查本地 Flink 状态缓存
        String category = categoryCache.value();
        if (category == null) {
            // 缓存 miss，查询 Redis
            try (Jedis jedis = redisPool.getResource()) {
                category = jedis.get("product:category:" + order.getProductId());
            }
            // 写入缓存状态
            categoryCache.update(category);
        }
        return new EnrichedOrder(order, category);
    }

    @Override
    public void close() throws Exception {
        // close() 在算子关闭时调用（正常结束或被取消时）
        // 释放外部资源
        if (redisPool != null) {
            redisPool.close();
        }
    }
}
```

> [!warning] 生产避坑：open() 中的资源初始化
> 在算子类的**字段初始化**（`private JedisPool redisPool = new JedisPool(...)`）或**构造函数**中初始化外部连接是危险的，原因有两个：
> 1. 算子对象在 Client 端（JobGraph 构建时）被实例化并序列化，然后发送给 TaskManager 反序列化执行。在 Client 端创建的 Redis 连接指向 Client 机器，到 TaskManager 上已无效
> 2. 外部连接通常不可序列化，会导致序列化失败
> 
> 正确做法：在 `open()` 中初始化（`open()` 在 TaskManager 端调用），在 `close()` 中释放，用 `transient` 修饰连接池字段避免序列化尝试。

### 3.3 ProcessFunction：最强大的算子

`ProcessFunction` 是 Flink 提供的最底层、最灵活的算子。它在 `map`/`flatMap` 的基础上，额外提供两个能力：

**能力一：访问时间戳和 Watermark**

```java
public class OrderProcessFunction extends KeyedProcessFunction<String, OrderEvent, Alert> {

    @Override
    public void processElement(OrderEvent order,
                               Context ctx,        // ← 关键：Context 对象
                               Collector<Alert> out) throws Exception {

        // 获取当前记录的事件时间戳
        long eventTime = ctx.timestamp();

        // 获取当前算子的 Watermark（代表"当前时间"的推进值）
        long currentWatermark = ctx.timerService().currentWatermark();

        // 注册一个事件时间定时器（5 分钟后触发）
        ctx.timerService().registerEventTimeTimer(eventTime + 5 * 60 * 1000);

        // ... 业务逻辑
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
        // 定时器触发时回调
        // timestamp 是注册时指定的时间戳
        // 在这里可以检查超时、触发告警等
        out.collect(new Alert("Order timeout detected at " + timestamp));
    }
}
```

**能力二：侧输出（SideOutput）**

侧输出是 Flink 处理"脏数据"和"多路输出"的标准方案，替代了已废弃的 `split()`：

```java
// 定义侧输出标签（必须是 OutputTag，泛型指定输出类型）
OutputTag<String> errorTag = new OutputTag<String>("parse-error") {};

DataStream<OrderEvent> mainStream = rawStream.process(
    new ProcessFunction<String, OrderEvent>() {
        @Override
        public void processElement(String raw, Context ctx, Collector<OrderEvent> out) {
            try {
                OrderEvent order = JSON.parseObject(raw, OrderEvent.class);
                out.collect(order);          // 正常数据进主流
            } catch (Exception e) {
                ctx.output(errorTag, raw);   // 解析失败进侧输出流
            }
        }
    }
);

// 从主流中获取侧输出流
DataStream<String> errorStream = mainStream.getSideOutput(errorTag);

// 主流：正常处理
mainStream.addSink(new KafkaSink<>(...));

// 侧输出流：写入错误日志目录
errorStream.addSink(new FileSink<>(...));
```

> [!note] 设计哲学：侧输出 vs 过滤再过滤
> 一个常见的"错误做法"是：先过滤出错误数据写入错误流，再过滤出正常数据写入主流——这意味着原始数据要被遍历两次，且代码需要两次部署。侧输出在**一次算子执行**中将数据分发到不同的输出流，性能更好，代码更简洁。

### 3.4 KeyedStream 上的聚合算子

`keyBy()` 后的 `KeyedStream` 提供了一系列便捷的聚合算子，内部都维护了 per-key 的 `ValueState`：

```java
KeyedStream<OrderEvent, String> keyedOrders = orders.keyBy(order -> order.getUserId());

// sum：对指定字段累加（适合 POJO 或 Tuple）
DataStream<OrderEvent> cumulativeAmounts = keyedOrders.sum("amount");

// min/max：保留最小/最大值的记录（不是只输出那个字段，而是整条记录）
DataStream<OrderEvent> maxOrders = keyedOrders.max("amount");

// minBy/maxBy：输出最小/最大值对应的完整记录（与 min/max 的区别：min 只更新指定字段）
DataStream<OrderEvent> maxByOrders = keyedOrders.maxBy("amount");

// reduce：自定义二元聚合函数（最灵活）
DataStream<OrderEvent> reduced = keyedOrders.reduce(
    (order1, order2) -> {
        // 两条相同 userId 的记录合并为一条（累加金额）
        order1.setAmount(order1.getAmount() + order2.getAmount());
        return order1;
    }
);
```

**`min` vs `minBy` 的区别**（这是一个常见的混淆点）：

假设有两条记录 `(userId="A", amount=100, timestamp=1000)` 和 `(userId="A", amount=50, timestamp=2000)`：
- `min("amount")` 输出：`(userId="A", amount=50, timestamp=1000)`——只更新 `amount` 字段为最小值，其他字段保留第一条记录的值
- `minBy("amount")` 输出：`(userId="A", amount=50, timestamp=2000)`——输出 `amount` 最小的那条完整记录

### 3.5 多流操作：union 与 connect

#### 3.5.1 union：同类型流合并

```java
DataStream<Event> stream1 = ...;  // 来自 Kafka Topic A
DataStream<Event> stream2 = ...;  // 来自 Kafka Topic B
DataStream<Event> stream3 = ...;  // 来自 Kafka Topic C

// union：将多条相同类型的流合并为一条
// 语义：三条流的数据被简单合并，没有协调，顺序不确定
DataStream<Event> merged = stream1.union(stream2, stream3);
```

**`union` 的特点**：
- **相同类型**：所有流必须是同一类型 `T`
- **无协调**：数据按到达顺序直接合并，没有 Watermark 对齐（每个流的 Watermark 独立推进）
- **适用场景**：将来自多个相同 Schema 的 Topic 的数据汇总处理

#### 3.5.2 connect：异类型流协同处理

`connect` 解决的是"两条不同类型的流需要**共享状态**处理"的问题，这是 `union` 无法解决的：

```java
DataStream<OrderEvent> orders = ...;     // 订单流
DataStream<RiskRule> rules = ...;        // 实时风控规则流（低频，规则变更时才有数据）

// connect：将两条不同类型的流连接，共享同一算子的状态
ConnectedStreams<OrderEvent, RiskRule> connected = orders.connect(rules);

DataStream<Alert> alerts = connected.process(
    new CoProcessFunction<OrderEvent, RiskRule, Alert>() {
        // 共享状态：当前生效的风控规则
        private transient MapState<String, RiskRule> activeRules;

        @Override
        public void open(Configuration parameters) {
            MapStateDescriptor<String, RiskRule> desc =
                new MapStateDescriptor<>("active-rules", String.class, RiskRule.class);
            activeRules = getRuntimeContext().getMapState(desc);
        }

        @Override
        public void processElement1(OrderEvent order, Context ctx, Collector<Alert> out)
                throws Exception {
            // 处理订单事件：用当前规则检查是否触发风控
            for (Map.Entry<String, RiskRule> entry : activeRules.entries()) {
                if (entry.getValue().matches(order)) {
                    out.collect(new Alert(order, entry.getKey()));
                }
            }
        }

        @Override
        public void processElement2(RiskRule rule, Context ctx, Collector<Alert> out)
                throws Exception {
            // 处理规则更新：更新共享状态中的规则
            if (rule.isActive()) {
                activeRules.put(rule.getRuleId(), rule);
            } else {
                activeRules.remove(rule.getRuleId());
            }
        }
    }
);
```

**`connect` 的核心价值**：两条流的两个处理方法（`processElement1` 和 `processElement2`）**共享同一个算子状态**（`activeRules`）。这使得"规则流更新状态，事件流读取状态做判断"的模式成为可能，是实现实时规则引擎、动态配置推送等场景的标准方案。

**`connect` 与 `union` 的根本差异**：

| 特性 | union | connect |
|------|-------|---------|
| 流的类型 | 必须相同 | 可以不同 |
| 流的数量 | 2+条 | 恰好 2 条 |
| 共享状态 | 不支持（合并后是同一条流）| 支持（两个处理方法共享状态）|
| 适用场景 | 同 Schema 多数据源汇总 | 主流 + 控制流（如规则、配置）协同 |

---

## 第 4 章 Sink：数据去哪里

### 4.1 内置 Sink

```java
// print()：打印到控制台（测试用）
stream.print();

// print() 带前缀（多流调试时区分）
stream1.print("STREAM-1");
stream2.print("STREAM-2");

// writeAsText()：写入文本文件（生产不推荐，建议用 FileSink）
stream.writeAsText("output/result.txt");
```

### 4.2 Kafka Sink

```java
// KafkaSink：Flink 1.14+ 推荐使用（支持 Exactly-Once）
KafkaSink<String> kafkaSink = KafkaSink.<String>builder()
    .setBootstrapServers("kafka1:9092,kafka2:9092")
    .setRecordSerializer(
        KafkaRecordSerializationSchema.builder()
            .setTopic("output-topic")
            .setValueSerializationSchema(new SimpleStringSchema())
            .build()
    )
    // 语义保证：AT_LEAST_ONCE（默认）或 EXACTLY_ONCE（需要 Checkpoint 支持）
    .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
    .build();

stream.sinkTo(kafkaSink);
```

**`DeliveryGuarantee` 的三个级别**：
- `NONE`：Fire-and-forget，可能丢失数据
- `AT_LEAST_ONCE`：至少一次，Checkpoint 后可能重复发送
- `EXACTLY_ONCE`：精确一次，通过 Kafka 事务实现（需要 Checkpoint，有性能开销）

`EXACTLY_ONCE` 的详细实现原理将在 [[08 Flink 与 Kafka 端到端精确一次实战]] 中深入讲解。

### 4.3 FileSink：写入文件系统

```java
// FileSink：支持 HDFS、S3、本地文件系统，支持 Exactly-Once（通过文件重命名实现）
FileSink<String> fileSink = FileSink
    .forRowFormat(
        new Path("hdfs:///output/events/"),
        new SimpleStringEncoder<String>("UTF-8")
    )
    .withRollingPolicy(
        DefaultRollingPolicy.builder()
            .withRolloverInterval(Duration.ofMinutes(5))    // 每 5 分钟滚动一个新文件
            .withInactivityInterval(Duration.ofMinutes(1))  // 1 分钟无数据也滚动
            .withMaxPartSize(MemorySize.ofMebiBytes(128))   // 超过 128MB 滚动
            .build()
    )
    .withBucketAssigner(
        new DateTimeBucketAssigner<>("yyyy-MM-dd/HH")  // 按小时分桶（目录）
    )
    .build();

stream.sinkTo(fileSink);
```

**FileSink 的 Exactly-Once 机制（重要）**：

FileSink 的 Exactly-Once 通过文件的三个状态实现：
1. **In-progress**：当前正在写入的文件（`.part-0-0` 这类临时名称）
2. **Pending**：Checkpoint 完成前的等待状态（`.part-0-0.inprogress.xxx`）
3. **Finished**：Checkpoint 确认后重命名为最终文件名（`part-0-0-xxx`）

只有 Finished 状态的文件才对下游可见。如果作业在 Checkpoint 完成前崩溃，In-progress 文件会被清理，从上一个 Checkpoint 恢复后重新写入。

### 4.4 自定义 Sink

```java
// 实现 SinkFunction（Legacy，简单场景）
public class MySink implements SinkFunction<OrderEvent> {
    @Override
    public void invoke(OrderEvent order, Context ctx) throws Exception {
        // 每条记录调用一次
        // 注意：没有事务支持，无法实现 Exactly-Once
        myDatabase.insert(order);
    }
}

// 实现 RichSinkFunction（需要生命周期管理时）
public class JdbcSink extends RichSinkFunction<OrderEvent> {
    private transient Connection connection;

    @Override
    public void open(Configuration parameters) throws Exception {
        connection = DriverManager.getConnection("jdbc:mysql://...", "user", "pass");
        connection.setAutoCommit(false);
    }

    @Override
    public void invoke(OrderEvent order, Context ctx) throws Exception {
        PreparedStatement stmt = connection.prepareStatement(
            "INSERT INTO orders VALUES (?, ?, ?)"
        );
        stmt.setLong(1, order.getOrderId());
        stmt.setDouble(2, order.getAmount());
        stmt.setLong(3, order.getTimestamp());
        stmt.executeUpdate();
        connection.commit();
    }

    @Override
    public void close() throws Exception {
        if (connection != null) connection.close();
    }
}
```

---

## 第 5 章 并行度控制：决定作业性能的关键参数

### 5.1 并行度的四个生效层级

Flink 的并行度设置有四个层级，**优先级从低到高**：

```
1. 集群默认并行度（flink-conf.yaml 中的 parallelism.default）
      ↓ 优先级更高，会覆盖集群默认
2. 环境并行度（env.setParallelism(N)）
      ↓ 优先级更高，会覆盖环境并行度
3. 算子并行度（operator.setParallelism(N)）
      ↓ 仅对 Source 有效，优先级最高
4. Source 的最大并行度（source.setMaxParallelism(N)，影响状态分区数）
```

```java
env.setParallelism(4);  // 全局并行度 = 4

source.setParallelism(1)   // Source 并行度 = 1（覆盖全局）
      .map(f)              // Map 并行度 = 4（继承全局）
      .keyBy(k)
      .window(w)
      .apply(func)
      .setParallelism(8)   // Window 并行度 = 8（覆盖全局）
      .sink(s)             // Sink 并行度 = 4（继承全局）
      .setParallelism(2);  // Sink 并行度 = 2（覆盖全局）
```

### 5.2 并行度设置的实践原则

**原则一：Source 并行度 ≤ Kafka 分区数**

如果 Kafka topic 有 4 个分区，Source 并行度设为 8，则有 4 个 Source Subtask 空闲（没有分区可消费），浪费资源。反之，Source 并行度 ≤ 分区数，每个 Subtask 消费一个或多个分区。

**原则二：keyBy 之后的并行度决定了状态分桶数**

`keyBy` 会将数据按 Key 的哈希值分配给下游的各个 Subtask。如果下游并行度为 N，则每个 Subtask 负责约 `total_keys / N` 个 Key 的状态。如果后续需要扩缩容（改并行度），状态需要重新分配（通过 Savepoint）。

**原则三：避免并行度不整除**

比如上游并行度 3、下游并行度 4，数据分发时哈希分桶不均匀，容易出现数据倾斜。推荐并行度使用 2 的幂次（4、8、16）或保持上下游整数倍关系。

**原则四：Sink 并行度通常等于目标系统的并发写入能力**

如果目标是 Kafka（并行写入友好），Sink 并行度可以较高；如果目标是 MySQL（单机，并发写入有瓶颈），Sink 并行度应控制在 4~8，避免打满 DB。

### 5.3 MaxParallelism：状态分区数的上限

`maxParallelism`（默认 128）是一个特殊的并行度参数，它决定了 Keyed State 的**哈希空间大小**。

所有 Key 被映射到 `[0, maxParallelism)` 的哈希空间，每个 Subtask 负责一段连续的哈希范围。这个映射关系一旦确定（首次运行时），就被固化在 Checkpoint/Savepoint 中，后续的并行度调整（扩缩容）是在这个固定的哈希空间内重新划分范围，而不是重新哈希所有 Key。

**重要限制**：`parallelism ≤ maxParallelism`，否则会报错。如果将来可能需要扩容到 100 个并发，`maxParallelism` 需要设置为 ≥ 100 的值（建议设置为 2 的幂次，如 128 或 256）。**`maxParallelism` 一旦设置，不能通过 Savepoint 修改**（否则状态的哈希空间映射会失效）。

---

## 第 6 章 分区策略：数据如何在 Subtask 间流动

### 6.1 六种分区策略

当两个算子之间的并行度不同，或者用户显式指定了分区策略时，Flink 需要决定"上游 Subtask-i 的数据发往下游哪个 Subtask"。Flink 提供了 6 种分区策略：

| 分区策略 | 触发方式 | 语义 | 适用场景 |
|---------|---------|------|---------|
| **Forward** | 并行度相同且相邻（自动）| Subtask-i → Subtask-i（直连）| 默认，用于算子链合并 |
| **Hash（keyBy）** | `.keyBy()` | 相同 Key 的记录 → 同一 Subtask | 有状态聚合、去重 |
| **Rebalance** | `.rebalance()` | 轮询分发到所有下游 Subtask | 均匀分布数据、修复倾斜 |
| **Rescale** | `.rescale()` | 局部轮询（只分发给部分下游）| 并行度成倍关系时更高效 |
| **Broadcast** | `.broadcast()` | 数据复制发送给所有下游 Subtask | 广播维度表、配置更新 |
| **Custom（partitionCustom）** | `.partitionCustom(partitioner, key)` | 自定义分区逻辑 | 特殊业务分区需求 |

### 6.2 Rebalance vs Rescale：容易混淆的两种轮询

两者都是轮询分发，但轮询的范围不同：

**Rebalance（全局轮询）**：上游的每个 Subtask 会轮询发往**所有**下游 Subtask。
- 上游 2 个 Subtask，下游 4 个 Subtask：Subtask-0 → {0,1,2,3} 轮询；Subtask-1 → {0,1,2,3} 轮询
- 每个下游 Subtask 收到来自所有上游的数据，数据分布非常均匀
- **代价**：会产生 2×4=8 条网络连接

**Rescale（局部轮询）**：上游的每个 Subtask 只轮询发往**部分**下游 Subtask。
- 上游 2 个 Subtask，下游 4 个 Subtask：Subtask-0 → {0,1} 轮询；Subtask-1 → {2,3} 轮询
- 只有 2×2=4 条网络连接，效率更高
- **适用场景**：上下游并行度成整数倍关系，且数据已经是均匀的（不需要全局均衡）

### 6.3 Broadcast：广播流的使用场景

`broadcast()` 将流中的每条数据**复制**发给所有下游 Subtask：

```java
// 场景：将低频的配置更新广播给所有计算 Subtask
DataStream<Config> configStream = env.addSource(new ConfigSource());

// 将 configStream 广播：每条配置更新发给下游所有 Subtask
BroadcastStream<Config> broadcastConfig = configStream.broadcast(configStateDescriptor);

// 主流 connect 广播流
DataStream<Result> result = mainStream
    .connect(broadcastConfig)
    .process(new BroadcastProcessFunction<...>() { ... });
```

**`broadcast()` 的内存代价**：下游有 N 个 Subtask，每条广播数据就会被复制 N 份。如果广播流的数据量大（如广播一个大的维度表快照），内存消耗会很高。广播流适合低频的小数据量配置/规则，不适合大数据量的维度数据（大维度表用异步 I/O 或定期批量查询更合适）。

---

## 小结

本文系统梳理了 DataStream API 的核心算子和关键配置，重点如下：

**Source**：内置 Source 用于测试，生产使用 KafkaSource（FLIP-27 新 API）或 FileSource；自定义 SourceFunction 时注意 `cancel()` 的 `volatile` 语义

**Transformation**：
- `map/filter/flatMap`：基础三件套，`flatMap` 可实现其余两个的语义
- `RichFunction`：提供 `open/close` 生命周期，是初始化外部连接的正确位置
- `ProcessFunction`：最强大的算子，额外提供时间戳访问、定时器、侧输出
- `union`：同类型流合并；`connect`：异类型流共享状态协同处理

**Sink**：KafkaSink 的三种语义保证（NONE/AT_LEAST_ONCE/EXACTLY_ONCE）；FileSink 通过文件重命名实现 Exactly-Once

**并行度**：四层优先级（集群默认 < 环境 < 算子 < Source 级别）；`maxParallelism` 决定状态哈希空间上限，不可修改

**分区策略**：6 种策略各有适用场景；Rebalance 全局均匀但网络连接多，Rescale 局部高效但适用于整数倍关系

下一篇 [[04 时间语义与 Watermark 实战]] 将深入 Flink 最难理解但也最重要的特性——时间语义，彻底厘清 EventTime、ProcessingTime、IngestionTime 的差异，以及 Watermark 如何让 Flink 正确处理乱序数据。


> [!note] 思考题
> 1. Flink 的 `keyBy()` 操作通过对 Key 做哈希来决定数据路由到哪个 SubTask。这意味着相同 Key 的所有记录保证到同一个 SubTask，可以维护 Keyed State。但如果 Key 的基数（Cardinality）很低（比如只有 3 个不同的 Key，但有 100 个并行 SubTask），会导致大多数 SubTask 处于空闲状态，形成严重的数据倾斜。针对这种"低基数 Key 倾斜"，有哪些 Flink 级别的解决方案？
> 2. Flink 的 `flatMap` 算子允许每条输入记录输出 0 到 N 条记录。当输出 0 条时（相当于 Filter），Flink 内部的 Buffer 和 Network 层如何处理这种"空输出"？频繁的 `flatMap` 输出 0 条记录与直接使用 `filter` 算子，在性能上是否有差异？
> 3. DataStream 的 `connect()` 和 `union()` 都能合并两条流，但语义不同：`union()` 要求两条流的类型完全相同，`connect()` 允许两条流类型不同但只能使用 `CoFlatMapFunction` 分别处理。在什么业务场景下必须使用 `connect()` 而不是 `union()`？`connect()` 之后的 `CoProcessFunction` 能否维护跨两条流的共享状态？