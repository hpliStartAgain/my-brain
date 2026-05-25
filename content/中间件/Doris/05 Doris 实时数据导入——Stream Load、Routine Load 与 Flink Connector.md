---
title: "05 Doris 实时数据导入——Stream Load、Routine Load 与 Flink Connector"
date: 2026-03-05
tags: [CDC, Doris, Flink Connector, Kafka, Routine Load, Stream Load, 实时导入, 数据同步]
aliases: []
---

# 05 Doris 实时数据导入——Stream Load、Routine Load 与 Flink Connector

## 摘要

Doris 提供了完整的实时数据导入体系，覆盖从 HTTP 推送（Stream Load）到消息队列消费（Routine Load）再到 Flink CDC 全链路同步三种主流场景。本文深入剖析每种导入方式的内部实现机制——Stream Load 的两阶段提交如何保证原子性、Routine Load 的消费组管理与 Offset 提交时机、Flink Doris Connector 如何将 Flink Checkpoint 与 Doris 事务机制绑定实现 Exactly-Once。理解这三种导入方式的设计边界，是在生产中正确选型和调优的基础。

---

## 第 1 章 数据导入的事务语义——原子性的保证

### 1.1 为什么导入需要事务

数据导入看似简单（发数据、存数据），但在分布式系统中保证原子性非常复杂：

一次 Stream Load 请求可能涉及数十个 Tablet，每个 Tablet 在不同 BE 节点上有 3 个副本——总共需要写入数十个节点。如果中途某个 BE 写入失败，已成功写入的 Tablet 必须回滚，否则就会出现"部分数据写入成功"的不一致状态。

**对用户的承诺**：一次导入操作要么全部成功（数据对查询可见），要么全部失败（数据不可见），不存在中间状态。

这是 Doris 所有导入方式都通过**两阶段提交（2PC）**保证原子性的原因。

### 1.2 Doris 导入的两阶段提交

**Phase 1（Prepare）**：
1. FE 为本次导入生成全局事务 ID（Transaction ID）
2. 数据分发到各 BE 节点，每个 BE 将数据写入临时 Rowset（标记为未提交状态，查询不可见）
3. 每个 BE 写入完成后向 FE 报告"Prepare 成功"

**Phase 2（Commit 或 Abort）**：
- **全部 Prepare 成功** → FE 发送 Commit 命令，各 BE 将临时 Rowset 标记为已提交（查询可见），事务完成
- **任意 Prepare 失败** → FE 发送 Abort 命令，各 BE 删除临时 Rowset，不留任何痕迹

这个机制保证了导入的原子性：从用户视角，要么看到全量新数据，要么什么都看不到。

---

## 第 2 章 Stream Load——同步 HTTP 推送

### 2.1 Stream Load 的设计定位

**Stream Load** 是最基础的导入方式：通过 HTTP 协议将数据推送给 Doris，同步等待导入结果。

```bash
# 导入 CSV 格式数据
curl -u admin:password \
  -H "label: batch-20240101-001" \       # 导入标签（唯一，防止重复导入）
  -H "column_separator: ,"  \            # 列分隔符
  -H "columns: date, region, amount" \   # 列映射
  -T /data/orders_20240101.csv \         # 数据文件
  "http://fe_host:8030/api/my_db/orders/_stream_load"

# 响应示例（同步返回结果）
{
  "TxnId": 1001,
  "Label": "batch-20240101-001",
  "Status": "Success",
  "NumberTotalRows": 1000000,
  "NumberLoadedRows": 1000000,
  "LoadBytes": 50000000,
  "LoadTimeMs": 3500
}
```

**Label 的幂等性**：每次 Stream Load 请求必须携带一个 Label（用户自定义的唯一标识符）。如果某次导入因网络超时而不确定是否成功，可以用相同的 Label 重试——Doris 保证相同 Label 的导入只会被执行一次（第二次请求会返回"Label already exists"），避免数据重复。

### 2.2 Stream Load 的内部流程

```
HTTP 请求到达 FE
    ↓
FE 生成 Transaction ID，选择 Tablet 和对应 BE
    ↓
FE 将 HTTP 流式代理到各目标 BE（数据分发）
    ↓
每个 BE：接收数据 → 解析 → 排序 → 写入临时 Rowset
    ↓
所有 BE 写入完成 → FE 收到全部"Prepare OK"
    ↓
FE 执行 2PC Commit → 数据对查询可见
    ↓
FE 向客户端返回 HTTP 200 Success
```

整个流程是**同步**的——HTTP 连接保持到导入完成，客户端收到响应时数据已经写入成功并可查询。

### 2.3 Stream Load 的适用场景与限制

**适用**：
- 批量数据定期同步（如每 10 分钟一次的 ETL 任务）
- 文件数据导入（CSV/JSON/Parquet 格式）
- 数据量适中的场景（单次建议 100MB-1GB）

**限制**：
- **同步阻塞**：HTTP 连接在导入期间一直占用，不适合超大批次（> 10GB 单次）
- **不适合实时流式写入**：Stream Load 是"批量提交"语义，每次调用之间有提交延迟；如果每秒调用一次，每秒都会触发一次 2PC，FE 元数据压力大
- **无消息队列集成**：需要业务代码控制调用时机和数据打包

---

## 第 3 章 Routine Load——消息队列的持续消费

### 3.1 Routine Load 的设计定位

**Routine Load** 是 Doris 内置的 [[Kafka]] 消费框架，由 Doris FE 管理消费任务，BE 节点作为消费者持续从 Kafka Topic 消费数据并写入 Doris，无需外部 ETL 工具。

```sql
-- 创建 Routine Load 任务
CREATE ROUTINE LOAD my_db.events_load ON events
    COLUMNS TERMINATED BY ",",
    COLUMNS(date, region, amount),
    WHERE amount > 0
PROPERTIES (
    "desired_concurrent_number" = "4",     -- 并发消费子任务数
    "max_batch_interval" = "10",           -- 每批次最大等待时间（秒）
    "max_batch_rows" = "100000",           -- 每批次最大行数
    "max_batch_size" = "104857600"         -- 每批次最大字节数（100MB）
)
FROM KAFKA (
    "kafka_broker_list" = "kafka-1:9092,kafka-2:9092",
    "kafka_topic" = "events_topic",
    "kafka_partitions" = "0,1,2,3",
    "property.group.id" = "doris-events-consumer"
);

-- 查看 Routine Load 状态
SHOW ROUTINE LOAD FOR events_load;

-- 暂停/恢复
PAUSE ROUTINE LOAD FOR events_load;
RESUME ROUTINE LOAD FOR events_load;
```

### 3.2 Routine Load 的内部工作机制

**FE 的调度职责**：
- FE 维护 Routine Load 任务的状态（分区 Offset、子任务分配）
- 将 Kafka 的 Partition 分配给 BE 节点（每个子任务消费若干 Partition）
- 管理 Offset 的提交（只有当 Doris 事务 Commit 成功后，才向 Kafka 提交 Offset）

**BE 的消费职责**：
- 每个子任务在 BE 上作为独立线程运行，直接从 Kafka Broker 拉取消息
- 积累到 `max_batch_rows` 行或 `max_batch_interval` 时间后，触发一次 Stream Load（内部调用 Stream Load 的 2PC 逻辑）
- 事务提交成功后，更新 Offset

**Exactly-Once 保证**：

Routine Load 通过以下机制实现 Exactly-Once：
1. Doris 事务 Commit 成功 → 向 Kafka 提交 Offset（两者原子执行）
2. 如果 Doris 事务 Commit 失败 → Offset 不提交 → 下次重启后从上次提交的 Offset 重新消费
3. 如果 Kafka Offset 提交成功但 Doris 事务 Commit 失败（极端异常）→ 通过 Label 幂等机制避免数据重复

这个机制保证了即使 BE 崩溃，也不会丢数据（未提交 Offset 的数据会被重新消费）或重复数据（Label 幂等保护）。

> [!warning] 生产避坑：Routine Load 的消费延迟调优
> 默认的 `max_batch_interval=5` 秒意味着 Routine Load 最快 5 秒提交一次数据（批次凑满则提前提交）。对于需要亚秒级延迟的场景，可以将 `max_batch_interval` 设为 1 秒，但这样每秒都会触发 Stream Load 的 2PC，FE 元数据事务频率增加，需要评估 FE 的负载。
>
> 如果追求极低延迟（< 1 秒）的实时数据导入，应使用 **Flink Doris Connector**（基于 Streaming Sink，延迟可以做到毫秒级），而不是 Routine Load。

---

## 第 4 章 Flink Doris Connector——全链路 Exactly-Once

### 4.1 为什么需要 Flink Doris Connector

Routine Load 直接消费 Kafka，适合简单的 ETL 场景（JSON/CSV 格式，基本的列映射）。但对于以下场景，需要 Flink 处理：

- **复杂数据转换**：字段计算、过滤、Join 维表、窗口聚合等，Routine Load 的 SQL Transform 能力有限
- **MySQL CDC 同步**：通过 Flink CDC 读取 MySQL Binlog，将 INSERT/UPDATE/DELETE 实时同步到 Doris（Routine Load 不支持处理 DELETE 语义）
- **多源合并**：将多个 Kafka Topic 或多个数据源合并写入同一个 Doris 表
- **精确的 Exactly-Once 语义**：基于 Flink Checkpoint 的两阶段提交，与下游 Doris 事务绑定

### 4.2 Flink Doris Connector 的 Exactly-Once 实现

Flink Doris Connector 利用 **Flink 的 Two-Phase Commit Sink** 机制（`TwoPhaseCommitSinkFunction`）与 Doris 的 Stream Load 2PC 绑定：

```
Flink Checkpoint 触发：
    preCommit()：
        → 调用 Stream Load，传入数据，事务 Prepare（数据写入临时 Rowset）
        → 将 Doris Transaction ID 记录到 Flink Checkpoint State

Flink Checkpoint 完成（所有算子 Checkpoint 成功）：
    commit()：
        → 用 Checkpoint State 中的 Transaction ID 调用 Doris Commit 接口
        → Doris 数据对查询可见

Flink Checkpoint 失败（任意算子 Checkpoint 失败）：
    abort()：
        → 调用 Doris Abort 接口，回滚未提交的事务
        → Flink Job 从上次成功的 Checkpoint 恢复，重新消费数据
```

**为什么这样设计能保证 Exactly-Once**：

- Flink Checkpoint 成功 ↔ Doris 事务提交成功（绑定原子性）
- Flink 从 Checkpoint 恢复时，已提交的 Doris 事务对应的数据已经可见，未提交的事务已回滚
- 从 Checkpoint 恢复后重新消费的数据，使用新的 Transaction ID 写入，不会与已提交的事务冲突

### 4.3 MySQL CDC 到 Doris 的全链路架构

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}}%%
graph LR
    MYSQL["MySQL</br>（业务数据库）"]
    CDC["Flink CDC Source</br>（Debezium 读取 Binlog）"]
    TRANSFORM["Flink Transform</br>（字段映射/过滤/聚合）"]
    SINK["Flink Doris Sink</br>（2PC Connector）"]
    DORIS["Apache Doris</br>（Unique Key 模型）"]

    MYSQL -- "Binlog</br>INSERT/UPDATE/DELETE" --> CDC
    CDC --> TRANSFORM
    TRANSFORM --> SINK
    SINK -- "Stream Load 2PC" --> DORIS

    classDef mysql fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef flink fill:#ff79c6,stroke:#ffb86c,color:#282a36
    classDef doris fill:#44475a,stroke:#50fa7b,color:#f8f8f2
    class MYSQL mysql
    class CDC,TRANSFORM,SINK flink
    class DORIS doris
```

这个架构是当前最主流的 MySQL → Doris 实时同步方案：
- **Flink CDC**：读取 MySQL Binlog，将变更事件（INSERT/UPDATE/DELETE）解析为结构化数据流
- **Flink Transform**：处理 Schema 映射、字段计算、过滤低价值事件
- **Flink Doris Sink + Unique Key 模型**：INSERT/UPDATE 对应 UPSERT（利用 Delete Bitmap 处理），DELETE 对应 Doris 的标记删除（Connector 自动将 `DELETE` 操作转换为 Doris 的 `DELETE` 语义）

典型延迟：从 MySQL 写入到 Doris 可查询，端到端延迟在 1-5 秒（取决于 Flink Checkpoint 间隔）。

---

## 第 5 章 三种导入方式的选型对比

| 场景 | 推荐方式 | 理由 |
| :--- | :--- | :--- |
| 定期批量文件导入（每小时/每天）| **Stream Load** | 简单直接，吞吐高，批次大小可控 |
| Kafka Topic 数据消费（简单 ETL）| **Routine Load** | 无需外部 Flink，Doris 内置管理，运维简单 |
| MySQL/PostgreSQL 实时 CDC 同步 | **Flink Doris Connector** | 支持 DELETE 语义，Exactly-Once，延迟低 |
| 复杂实时流处理（窗口聚合、Join）| **Flink Doris Connector** | Flink 的完整流处理能力 |
| 超大数据量离线导入（TB 级）| **Broker Load**（HDFS/S3）| 并行读取外部存储，不经过 FE，吞吐最高 |

---

## 第 6 章 小结

Doris 的实时导入体系是其"实时分析"定位的核心支撑：

- **Stream Load**：同步 HTTP 推送，原子性通过 2PC 保证，Label 幂等避免重复，适合批量写入
- **Routine Load**：内置 Kafka 消费框架，FE 管理 Offset 提交与事务一致性，运维零成本，适合简单实时同步
- **Flink Doris Connector**：将 Flink Checkpoint 与 Doris Stream Load 2PC 绑定，实现端到端 Exactly-Once，适合 CDC 全链路同步和复杂流处理

选型的核心依据是**数据来源的复杂度和对延迟/一致性的要求**：离线批量 → Stream Load，实时消息队列 → Routine Load，CDC 实时同步 + 复杂处理 → Flink Connector。

---

**延伸阅读**：
- [[01 Doris 全局架构——FE BE 分离与 MPP 执行]]
- [[04 Doris 数据模型——Duplicate、Aggregate 与 Unique]]

---

> [!note] 思考题
> 1. Doris 的同步物化视图在基表数据更新时自动维护——INSERT 到基表的数据会同步写入物化视图。但物化视图的维护有写放大——一条 INSERT 可能触发多个物化视图的更新。如果一个基表上创建了 5 个物化视图，写入吞吐量会下降多少？你如何在查询加速和写入性能之间权衡？
> 2. Doris 支持倒排索引（Inverted Index）用于全文搜索和等值查询加速。与 Elasticsearch 的倒排索引相比，Doris 的实现在功能和性能上有什么差异？在日志分析场景中，Doris 的倒排索引是否能替代 Elasticsearch？
> 3. Bitmap 索引适合低基数列（如性别、状态）的过滤。在高基数列（如 user_id）上创建 Bitmap 索引不仅占用大量存储，查询时的位图运算开销也很大。如何判断一个列是否适合 Bitmap 索引？Bloom Filter 索引与 Bitmap 索引的适用场景有什么区别？
