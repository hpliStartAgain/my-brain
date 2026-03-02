---
title: "状态管理与 Checkpoint 实战"
date: 2026-03-02
tags: [Flink, State, Checkpoint, Savepoint, ValueState, MapState, TTL, 容错, 实战]
aliases: ["Flink状态管理", "Flink Checkpoint实战", "Flink Savepoint", "Flink容错"]
---

**摘要：**

状态（State）和 Checkpoint 是 Flink 区别于无状态流处理框架的核心特性，两者密不可分：状态让算子跨越多条消息保留"记忆"，Checkpoint 让这份记忆在故障后得以恢复。本文从实战角度出发，系统讲解五种 Keyed State 的使用方式与选型原则、状态 TTL 的正确配置、Checkpoint 的完整配置参数、Savepoint 的操作与升级流程，以及生产中 Checkpoint 常见失败原因的排查思路。不同于原理篇的深层解析，本篇聚焦于"正确的使用姿势"：什么时候该用 `MapState` 而不是 `ValueState<Map>`、Checkpoint 超时该如何定位根因、Savepoint 在作业升级中如何保住状态连续性。

---

## 第 1 章 状态类型实战指南

### 1.1 ValueState：单值状态的标准用法

`ValueState<T>` 是使用频率最高的状态类型，每个 Key 存储一个值，支持 `value()`（读）、`update(T)`（写）、`clear()`（清除）。

**场景：实时统计每个用户的累计消费金额**

```java
public class CumulativeSpendFunction extends KeyedProcessFunction<String, OrderEvent, UserSpendStat> {

    private transient ValueState<Double> totalSpendState;

    @Override
    public void open(Configuration parameters) {
        ValueStateDescriptor<Double> desc =
            new ValueStateDescriptor<>("total-spend", Double.class);
        totalSpendState = getRuntimeContext().getState(desc);
    }

    @Override
    public void processElement(OrderEvent order, Context ctx, Collector<UserSpendStat> out)
            throws Exception {

        // 读取当前状态（首次为 null）
        Double currentTotal = totalSpendState.value();
        double newTotal = (currentTotal == null ? 0.0 : currentTotal) + order.getAmount();

        // 更新状态
        totalSpendState.update(newTotal);

        // 输出最新统计
        out.collect(new UserSpendStat(order.getUserId(), newTotal, ctx.timestamp()));
    }
}
```

**`value()` 返回 null 的语义**：当某个 Key 的状态从未被设置，或者被 `clear()` 清除后，`value()` 返回 null。这是 Flink 区分"状态不存在"和"状态值为 0"的方式。**务必做 null 判断**，否则 NPE 会导致 Task 失败重启。

### 1.2 MapState：Map 类型状态的正确姿势

**场景：维护用户购物车（商品 ID → 数量）**

```java
public class CartFunction extends KeyedProcessFunction<String, CartEvent, CartSnapshot> {

    private transient MapState<String, Integer> cartState;

    @Override
    public void open(Configuration parameters) {
        MapStateDescriptor<String, Integer> desc =
            new MapStateDescriptor<>("cart", String.class, Integer.class);
        cartState = getRuntimeContext().getMapState(desc);
    }

    @Override
    public void processElement(CartEvent event, Context ctx, Collector<CartSnapshot> out)
            throws Exception {

        switch (event.getAction()) {
            case ADD:
                // 追加商品数量（当前数量 + 新增数量）
                Integer current = cartState.get(event.getItemId());
                cartState.put(event.getItemId(),
                    (current == null ? 0 : current) + event.getQuantity());
                break;

            case REMOVE:
                cartState.remove(event.getItemId());
                break;

            case CHECKOUT:
                // 结算：输出购物车快照，然后清空
                Map<String, Integer> snapshot = new HashMap<>();
                for (Map.Entry<String, Integer> entry : cartState.entries()) {
                    snapshot.put(entry.getKey(), entry.getValue());
                }
                out.collect(new CartSnapshot(event.getUserId(), snapshot, ctx.timestamp()));
                cartState.clear();
                break;
        }
    }
}
```

**MapState 的关键 API**：

```java
// 读取单个 Key（只涉及一次 RocksDB 点查，高效）
Integer qty = cartState.get("item-123");

// 写入单个 Key
cartState.put("item-123", 3);

// 检查 Key 是否存在（避免先 get 再判断 null 的两次查询）
boolean exists = cartState.contains("item-123");

// 删除单个 Key
cartState.remove("item-123");

// 遍历所有 Key
for (String key : cartState.keys()) { ... }

// 遍历所有 Entry（RocksDB 下会逐条扫描，大 Map 时要注意性能）
for (Map.Entry<String, Integer> entry : cartState.entries()) { ... }

// 清空整个 MapState（清空当前 Key 的所有 Map 条目）
cartState.clear();
```

> [!warning] 生产避坑：MapState 的 entries() 迭代
> 在 `EmbeddedRocksDBStateBackend` 中，`cartState.entries()` 会扫描 RocksDB 中以当前 Key 为前缀的所有条目，是一个顺序扫描操作。如果某个用户的购物车有 10000 件商品，迭代一次会产生 10000 次 RocksDB 读取（虽然是顺序的，但仍有序列化开销）。生产中需要对单个 Key 的 MapState 大小做限制（如购物车商品数不超过 200 件），避免极端情况。

### 1.3 ListState：列表状态与 Operator State

`ListState<T>` 既可用于 Keyed State（per-Key 列表），也是 Operator State 的标准类型。

**场景一：Keyed ListState——记录用户最近 5 次行为**

```java
public class RecentEventsFunction extends KeyedProcessFunction<String, UserEvent, UserProfile> {

    private transient ListState<UserEvent> recentEventsState;

    @Override
    public void open(Configuration parameters) {
        ListStateDescriptor<UserEvent> desc =
            new ListStateDescriptor<>("recent-events", UserEvent.class);
        recentEventsState = getRuntimeContext().getListState(desc);
    }

    @Override
    public void processElement(UserEvent event, Context ctx, Collector<UserProfile> out)
            throws Exception {

        recentEventsState.add(event);  // 追加到列表末尾

        // 只保留最近 5 条（通过 update 重置整个列表）
        List<UserEvent> all = new ArrayList<>();
        for (UserEvent e : recentEventsState.get()) {
            all.add(e);
        }
        if (all.size() > 5) {
            // 保留最新 5 条（移除最旧的）
            recentEventsState.update(all.subList(all.size() - 5, all.size()));
        }
    }
}
```

**场景二：Operator State——Kafka Offset 手动管理**

```java
// 实现 CheckpointedFunction：作业级别的 Operator State 使用接口
public class ManualKafkaSource extends RichSourceFunction<String>
        implements CheckpointedFunction {

    // Operator State：记录每个分区的消费 Offset
    private transient ListState<Tuple2<Integer, Long>> offsetState;
    private Map<Integer, Long> currentOffsets = new HashMap<>();

    @Override
    public void initializeState(FunctionInitializationContext context) throws Exception {
        ListStateDescriptor<Tuple2<Integer, Long>> desc = new ListStateDescriptor<>(
            "kafka-offsets",
            TypeInformation.of(new TypeHint<Tuple2<Integer, Long>>() {})
        );
        offsetState = context.getOperatorStateStore().getListState(desc);

        // 从 Checkpoint 恢复：读取上次保存的 Offset
        if (context.isRestored()) {
            for (Tuple2<Integer, Long> offset : offsetState.get()) {
                currentOffsets.put(offset.f0, offset.f1);
            }
        }
    }

    @Override
    public void snapshotState(FunctionSnapshotContext context) throws Exception {
        // Checkpoint 时：保存当前的 Offset
        offsetState.clear();
        for (Map.Entry<Integer, Long> entry : currentOffsets.entrySet()) {
            offsetState.add(Tuple2.of(entry.getKey(), entry.getValue()));
        }
    }

    @Override
    public void run(SourceContext<String> ctx) throws Exception {
        // 读取 Kafka 数据，更新 currentOffsets...
    }

    @Override
    public void cancel() { /* ... */ }
}
```

### 1.4 ReducingState 与 AggregatingState：内置增量聚合

**场景：实时统计每个商品的总销售额（只保留聚合值，不存原始记录）**

```java
public class ProductSalesFunction extends KeyedProcessFunction<String, OrderItem, ProductSales> {

    private transient ReducingState<Double> salesState;

    @Override
    public void open(Configuration parameters) {
        ReducingStateDescriptor<Double> desc =
            new ReducingStateDescriptor<>("total-sales", Double::sum, Double.class);
        salesState = getRuntimeContext().getReducingState(desc);
    }

    @Override
    public void processElement(OrderItem item, Context ctx, Collector<ProductSales> out)
            throws Exception {
        salesState.add(item.getPrice() * item.getQuantity());
        out.collect(new ProductSales(item.getProductId(), salesState.get()));
    }
}
```

`ReducingState` 的每次 `add(value)` 会立刻将 value 与当前状态值做 reduce 操作，状态中始终只存储一个值（聚合结果），内存占用极小。

---

## 第 2 章 状态 TTL：防止状态无限增长

### 2.1 为什么状态必须设置 TTL

不设置 TTL 的状态会永久保留——一个用户注册账号后哪怕 3 年不活跃，他的状态也会一直占用内存/磁盘。随着时间积累，状态总量会持续增长，直到：
- 内存耗尽（HashMapStateBackend）
- 磁盘耗尽（RocksDB）
- Checkpoint 体积无限增大，完成时间越来越长

生产中所有有 per-Key 状态的算子，**都应该评估是否需要 TTL**。

### 2.2 TTL 配置详解

```java
StateTtlConfig ttlConfig = StateTtlConfig
    // 1. TTL 时长（必须配置）
    .newBuilder(Time.hours(24))

    // 2. TTL 刷新策略
    .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
    // OnCreateAndWrite（默认）：创建或写入时刷新 TTL
    // OnReadAndWrite：读取时也刷新 TTL（类似缓存的 access-expiry）

    // 3. 过期状态的可见性
    .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
    // NeverReturnExpired（推荐）：已过期的状态对用户不可见（视为 null）
    // ReturnExpiredIfNotCleanedUp：过期但未清理的状态仍可见（仅为兼容性保留，不推荐）

    // 4. 后台清理策略（可选，默认不做后台清理）
    .cleanupInBackground()
    // 开启后：Flink 在 Checkpoint 或状态访问时顺带清理过期状态（适合大多数场景）
    // 也可以配置 RocksDB Compaction 过滤器（仅 RocksDB 后端）：
    // .cleanupInRocksdbCompactFilter(1000)  // 每 1000 次 Compaction 操作清理一次

    .build();

// 应用到 StateDescriptor
ValueStateDescriptor<Double> desc = new ValueStateDescriptor<>("spend", Double.class);
desc.enableTimeToLive(ttlConfig);
ValueState<Double> state = getRuntimeContext().getState(desc);
```

**`cleanupInBackground()` vs `cleanupInRocksdbCompactFilter()`**：

| 清理策略 | 触发时机 | 适用后端 | 特点 |
|---------|---------|---------|------|
| 无（默认）| 只有访问该 Key 时才惰性清理 | 所有 | 最省资源，但过期状态不会及时释放内存 |
| `cleanupInBackground()` | Checkpoint 期间扫描状态时清理 | 所有 | 周期性清理，代价是 Checkpoint 时间略增 |
| `cleanupInRocksdbCompactFilter()` | RocksDB Compaction 期间过滤 | 仅 RocksDB | 最彻底，Compaction 时直接丢弃过期记录，推荐 RocksDB 场景 |

---

## 第 3 章 Checkpoint 实战配置

### 3.1 Checkpoint 的完整配置

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// ===== 基础配置 =====
// 开启 Checkpoint，间隔 1 分钟（从上一次 Checkpoint 完成到下一次开始的间隔）
env.enableCheckpointing(60_000);  // 单位毫秒

// 语义模式（EXACTLY_ONCE 或 AT_LEAST_ONCE）
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);

// Checkpoint 超时时间（超过此时间未完成则视为失败）
env.getCheckpointConfig().setCheckpointTimeout(10 * 60_000);  // 10 分钟

// 最小间隔（保证两次 Checkpoint 之间处理正常数据的最小时间，防止 Checkpoint 占满所有时间）
env.getCheckpointConfig().setMinPauseBetweenCheckpoints(30_000);  // 30 秒

// 最大并发 Checkpoint 数（通常设为 1，确保 Checkpoint 顺序完成）
env.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

// ===== 容错配置 =====
// 连续 Checkpoint 失败多少次后让作业失败（默认 0，即第一次失败就让作业失败）
env.getCheckpointConfig().setTolerableCheckpointFailureNumber(3);

// ===== 存储配置 =====
// Checkpoint 存储路径（HDFS 或 S3）
env.getCheckpointConfig().setCheckpointStorage("hdfs:///flink/checkpoints/my-job");

// ===== 保留策略 =====
// 作业取消时是否保留 Checkpoint（默认 DELETE_ON_CANCELLATION）
env.getCheckpointConfig().setExternalizedCheckpointCleanup(
    ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION  // 取消时保留，方便手动恢复
);

// ===== 高级配置 =====
// Unaligned Checkpoint 超时降级（对齐等待超过 30 秒自动切换为非对齐）
env.getCheckpointConfig().setAlignedCheckpointTimeout(Duration.ofSeconds(30));
```

### 3.2 Checkpoint 间隔的选择

Checkpoint 间隔是一个关键的调优参数，影响：
- **故障恢复的数据重放量**：间隔越长，故障时需要重放的数据越多（从上一次成功的 Checkpoint 开始重放）
- **Checkpoint 对吞吐的影响**：间隔越短，Checkpoint 越频繁，对正常处理的干扰越大

**实践建议**：

```
对于延迟敏感、不允许丢失数据的业务（如支付、风控）：
  → 间隔 30s ~ 2min，确保故障恢复快速、数据不重放过多

对于批量处理、数据量大的作业：
  → 间隔 5min ~ 30min，减少 Checkpoint 频率，降低对吞吐的影响

对于状态极大（如 RocksDB TB 级状态）的作业：
  → 即使开了增量 Checkpoint，也建议 5min ~ 15min，避免增量上传频率过高
```

**`minPauseBetweenCheckpoints` 的重要性**：

如果 Checkpoint 耗时 50 秒，但间隔配置了 60 秒，那么每隔 60 秒触发一次，两次 Checkpoint 之间只有 10 秒的正常处理时间（60 - 50 = 10s）。`minPauseBetweenCheckpoints` 保证至少有 N 秒的正常处理时间，避免系统大部分时间都在做 Checkpoint。

### 3.3 Checkpoint 存储后端（CheckpointStorage）

Flink 将 Checkpoint 的元数据（状态引用、Offset 等）与实际状态数据分开存储：

**JobManagerCheckpointStorage**（适合开发测试）：
- 状态数据存在 JobManager 的内存中
- 状态大小有限制（默认 5MB per Checkpoint）
- 重启后数据丢失
- **不适合生产**

**FileSystemCheckpointStorage**（生产标准方案）：
- 状态数据写入分布式文件系统（HDFS/S3/OSS 等）
- 容量无限制
- 作业重启后可从文件系统恢复

```java
// 推荐的生产配置
env.getCheckpointConfig().setCheckpointStorage(
    new FileSystemCheckpointStorage("hdfs:///flink/checkpoints/job-name")
);
```

---

## 第 4 章 Savepoint：作业升级的生命线

### 4.1 Savepoint 与 Checkpoint 的区别

Savepoint 和 Checkpoint 都是状态快照，但设计目标不同：

| 维度 | Checkpoint | Savepoint |
|------|-----------|-----------|
| **触发方式** | 自动（周期触发）| 手动（运维操作触发）|
| **目的** | 自动容错（故障恢复）| 计划性操作（升级、迁移、扩缩容）|
| **格式** | 可能有内部优化格式（增量等）| 标准格式，保证跨版本兼容 |
| **保留策略** | 只保留最近 N 个，旧的自动删除 | 永久保留，手动删除 |
| **状态算子标识** | 使用内部 ID（可能变化）| **使用用户指定的 UID（稳定）**|

**最关键的差异**：Savepoint 要求每个有状态的算子都有明确的 **UID**，这是 Savepoint 在作业代码修改后还能正确恢复状态的基础。

### 4.2 为算子设置 UID

```java
DataStream<OrderEvent> orders = env
    .fromSource(kafkaSource, watermarkStrategy, "Kafka Source")
    .uid("kafka-source")                          // ← 为 Source 设置 UID
    .map(new OrderEnrichmentFunction())
    .uid("order-enrichment-map")                  // ← 为 Map 算子设置 UID
    .keyBy(order -> order.getUserId())
    .process(new CumulativeSpendFunction())
    .uid("cumulative-spend-process")              // ← 为 Process 算子设置 UID
    .addSink(new KafkaSink<>())
    .uid("kafka-sink");                           // ← 为 Sink 设置 UID
```

> [!warning] 生产避坑：不设置 UID 的后果
> 如果不显式设置 UID，Flink 会根据算子在作业 DAG 中的拓扑位置自动生成 UID（基于哈希）。一旦代码修改（增删算子、改变顺序），自动生成的 UID 会变化，导致 Savepoint 恢复时找不到对应的算子状态，恢复失败。
>
> **最佳实践**：所有有状态的算子都显式设置 UID，且 UID 在整个作业生命周期内不变（即使代码修改）。

### 4.3 Savepoint 操作命令

```bash
# 1. 触发 Savepoint（作业继续运行，异步创建快照）
flink savepoint <jobId> hdfs:///flink/savepoints/

# 2. 触发 Savepoint 并停止作业（stop-with-savepoint，推荐）
flink stop --savepointPath hdfs:///flink/savepoints/ <jobId>
# stop 与 cancel + savepoint 的区别：stop 会等待 Source 处理完当前的数据（发出 MAX_WATERMARK）再停止，
# 确保所有窗口都被触发并输出，数据更完整

# 3. 从 Savepoint 恢复作业
flink run -s hdfs:///flink/savepoints/savepoint-xxxxxx-xxxx \
    -c com.example.MyJob \
    my-job.jar

# 4. 查看 Savepoint 内容（调试用）
flink info -s hdfs:///flink/savepoints/savepoint-xxxxxx-xxxx my-job.jar

# 5. 手动删除 Savepoint
flink savepoint -d hdfs:///flink/savepoints/savepoint-xxxxxx-xxxx
```

### 4.4 使用 Savepoint 进行作业升级

这是 Savepoint 最重要的使用场景，标准流程如下：

```
升级流程：

步骤 1：对正在运行的旧版本作业创建 Savepoint
  flink stop --savepointPath hdfs:///flink/savepoints/ <oldJobId>
  → 旧作业停止，Savepoint 创建完成
  → 路径：hdfs:///flink/savepoints/savepoint-oldJobId-xxxxxxxx

步骤 2：修改代码（增加功能、修复 Bug、调整并行度等）
  注意：新版本代码中，原有算子的 UID 必须保持不变
  注意：新增的有状态算子，需要新增 UID（不能与已有 UID 重复）
  注意：如果修改了状态的数据类型（如 ValueState<Integer> 改为 ValueState<Long>），
       需要确保序列化兼容（或先迁移数据）

步骤 3：打包新版本 JAR，从 Savepoint 启动
  flink run -s hdfs:///flink/savepoints/savepoint-oldJobId-xxxxxxxx \
      -p 8 \                      # 新的并行度（可以与旧版本不同！）
      -c com.example.MyJobV2 \
      my-job-v2.jar
  → 新作业从 Savepoint 恢复状态，从上次停止的 Kafka Offset 继续消费
  → 状态无缝延续，无需重新计算历史数据

步骤 4：验证新作业运行正常后，清理旧 Savepoint
```

**并行度变更时的注意事项**：

Savepoint 恢复时可以改变作业的并行度（这是 Savepoint 的重要价值之一）。Flink 会重新分配状态的 Key 范围（利用 Key Group 机制，详见[[07 Flink 时间与 Watermark 底层机制]]）。但有一个限制：**新并行度不能超过 `maxParallelism`**（默认 128）。如果需要扩容到超过 128 的并行度，必须提前修改 `maxParallelism`。

---

## 第 5 章 Checkpoint 生产问题排查

### 5.1 Checkpoint 超时：最常见的问题

**现象**：Web UI 中 Checkpoint 历史显示 `FAILED`，失败原因是 `Checkpoint expired before completing`。

**根因分析**：

Checkpoint 超时通常有三类根因：

**根因一：反压导致 Barrier 传播缓慢**

Barrier 需要跟随数据流传播，如果某个算子处于高反压状态，数据积压严重，Barrier 被堵在队列里无法前进，Checkpoint 协调时间拉长直至超时。

排查：检查 Web UI 中是否有算子显示 High Backpressure（见 [[04 Flink 网络传输与反压机制深度解析]]）。

解决：
- 解决反压的根因（扩大并行度、优化慢算子）
- 临时方案：增大 Checkpoint 超时时间（`setCheckpointTimeout`）
- 启用 Unaligned Checkpoint（`setAlignedCheckpointTimeout`）

**根因二：状态持久化速度慢**

当算子进入快照阶段（开始序列化状态并写出）时，如果状态数据量很大或存储系统（HDFS/S3）写入速度慢，持久化阶段耗时过长。

排查：在 Web UI 的 Checkpoint 详情页，查看每个算子的 `Sync Duration`（同步阶段耗时）和 `Async Duration`（异步写出耗时）。如果 `Async Duration` 很长，说明 IO 是瓶颈。

解决：
- 增大 HDFS/S3 写入带宽（调整并发写入数）
- 对于 HashMapStateBackend：考虑切换到 RocksDB 增量 Checkpoint
- 增大 Checkpoint 超时时间

**根因三：Checkpoint 协调器负载高**

JobManager 负责 Checkpoint 协调（收集所有算子的 Checkpoint 完成通知）。如果作业的 TaskManager 数量很多、Checkpoint 通知量大，JobManager 可能成为瓶颈。

排查：检查 JobManager 的 CPU 使用率和 GC 情况。

### 5.2 Checkpoint 体积过大

**现象**：Checkpoint 完成，但每次 Checkpoint 文件非常大（如每次 50GB），写出时间很长。

**排查方向**：

1. **窗口算子使用了 ProcessWindowFunction**：参考 [[05 窗口完全指南]] 中的建议，改用 AggregateFunction + ProcessWindowFunction 组合

2. **状态没有设置 TTL**：历史积累的过期状态没有清理，每次全量 Checkpoint 都包含大量"僵尸状态"。解决：添加 TTL 配置

3. **使用 HashMapStateBackend 且状态量大**：切换到 RocksDB + 增量 Checkpoint，大幅减少每次 Checkpoint 的数据量

4. **ListState 存储了大量原始记录**：评估是否能改用 ReducingState 或 AggregatingState

### 5.3 从 Checkpoint 恢复失败

**现象**：作业重启，试图从 Checkpoint 恢复，但启动失败，日志中有类似 `Failed to restore job from checkpoint` 的错误。

**常见原因**：

```
原因一：Checkpoint 文件损坏或不完整
  → HDFS 文件块损坏，或存储系统异常
  排查：手动检查 HDFS 上的 Checkpoint 文件是否完整
  解决：回退到更早的 Checkpoint（Flink 默认保留最近 1 个 Checkpoint，可配置保留更多）
  配置：state.checkpoints.num-retained: 3  # 保留最近 3 个 Checkpoint

原因二：作业代码改变，算子 UID 不匹配
  → 从非 Savepoint 的 Checkpoint 恢复时，代码修改导致内部 UID 变化
  解决：为所有有状态算子显式设置 UID，确保代码修改后 UID 不变

原因三：并行度改变（从 Checkpoint 恢复时）
  → Checkpoint（非 Savepoint）不支持并行度改变，只有 Savepoint 支持
  解决：并行度变更必须通过 Savepoint 操作
```

---

## 小结

本文覆盖了 Flink 状态管理与 Checkpoint 的完整实战知识：

**状态使用原则**：
- `ValueState`：单值，注意 null 判断
- `MapState`：Map 类型，比 `ValueState<Map>` 在 RocksDB 下高效得多
- `ListState`：列表，注意不要无限追加（需要控制大小）
- `ReducingState`/`AggregatingState`：增量聚合，内存最优
- 所有有状态算子都要评估是否需要 **TTL**，防止状态无限增长

**Checkpoint 配置要点**：
- 间隔根据业务对故障恢复时间的要求设置（30s ~ 30min）
- 生产必须使用 `FileSystemCheckpointStorage`（HDFS/S3）
- `RETAIN_ON_CANCELLATION` + 保留多个 Checkpoint，增强可恢复能力
- 高反压时配置 `setAlignedCheckpointTimeout` 自动降级为 Unaligned Checkpoint

**Savepoint 使用规范**：
- 所有有状态算子必须显式设置 `uid()`，且 UID 终身不变
- 作业升级标准流程：`flink stop --savepointPath` → 修改代码 → `flink run -s <savepoint>`
- 从 Savepoint 恢复可以改变并行度（不超过 `maxParallelism`）

下一篇 [[07 Table API 与 Flink SQL 实战]] 将进入 Flink 的高阶 API 层，系统讲解 Table API 的统一编程模型、Flink SQL 的 DDL/DML 语法，以及如何用 SQL 实现流式 Join、窗口聚合和 Changelog 数据处理。
