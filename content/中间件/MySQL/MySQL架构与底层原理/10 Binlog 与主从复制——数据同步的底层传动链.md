---
title: "Binlog 与主从复制——数据同步的底层传动链"
date: 2026-03-02
tags: [MySQL, Binlog, 主从复制, GTID, 并行复制, Relay Log]
aliases: [Binlog, 主从复制, GTID, 并行复制]
---

# 10 Binlog 与主从复制——数据同步的底层传动链

**摘要：** [[Binlog]]（Binary Log，二进制日志）是 MySQL 数据同步的底层基础设施。它不只是主从复制的数据管道，也是数据恢复（Point-in-Time Recovery）、增量备份、异构数据同步（如 [[Canal]] 订阅）的共同依赖。本文从 Binlog 的三种格式（STATEMENT、ROW、MIXED）的设计取舍出发，深入分析主从复制的三线程模型（IO Thread、SQL Thread、Dump Thread）和 Relay Log 的作用，解析 **GTID（Global Transaction Identifier）** 如何从根本上解决了基于位点复制的"位点漂移"难题，以及 MySQL 5.7+ 的**并行复制**是如何将从库的单线程回放突破为多线程、大幅缩短主从延迟的。

---

## 第 1 章 Binlog 是什么，以及它解决了什么问题

### 1.1 Binlog 的本质定位

Binlog 是 MySQL **Server 层**（而非存储引擎层）的日志，记录了所有对数据库产生变更的操作（DDL 和 DML）。

这里有一个关键的层次区分：

- **Redo Log** 是 [[InnoDB]] 存储引擎的私有日志，记录的是"物理变更"（某个数据页的某个偏移量上的字节从 X 变为 Y），用于 InnoDB 的崩溃恢复
- **Binlog** 是 MySQL Server 层的公共日志，记录的是"逻辑变更"（执行了什么 SQL，或者哪一行数据从什么值变成了什么值），用于主从复制和数据恢复

由于 Binlog 在 Server 层，它对所有存储引擎（InnoDB、MyISAM 等）都有效；而 Redo Log 只属于 InnoDB。

### 1.2 Binlog 的三大用途

**用途一：主从复制**。主库将 Binlog 发送给从库，从库回放 Binlog 中的变更，实现数据同步。这是 Binlog 最核心的用途。

**用途二：时间点恢复（Point-in-Time Recovery，PITR）**。结合定期的全量备份，Binlog 可以将数据库恢复到任意时间点。流程：还原最近一次全量备份 → 回放从备份时间点到目标时间点的所有 Binlog → 数据恢复到目标时间点的状态。这是"误删数据后恢复"的标准手段。

**用途三：异构数据同步**。[[Canal]]、[[Debezium]] 等工具通过伪装成 MySQL 从库来接收 Binlog，然后将 MySQL 的数据变更实时同步到 Elasticsearch、ClickHouse、Redis、消息队列等异构系统。Binlog 成为 MySQL 到整个数据生态的"数据总线"。

> [!note] 设计哲学
> Binlog 是 MySQL 架构中"关注点分离"设计的典范。InnoDB 负责本地的崩溃恢复（Redo Log），MySQL Server 层负责跨实例的数据同步（Binlog）。两者职责明确，互不干扰。如果 MySQL 只有 Redo Log 而没有 Binlog，数据库之间就无法通过逻辑层面的变更进行同步，整个分布式架构就无从谈起。

---

## 第 2 章 Binlog 的三种格式

### 2.1 STATEMENT 格式：记录 SQL 语句

**STATEMENT 格式**将执行的 SQL 语句原文记录到 Binlog 中。

```
# at 100
#260302 14:30:00 server id 1 end_log_pos 220
# Query    thread_id=123   exec_time=0     error_code=0
SET TIMESTAMP=1740921000;
UPDATE orders SET status=2 WHERE shop_id=100 AND status=1 AND created_at < '2026-01-01';
```

**优点**：Binlog 文件体积小（只记录 SQL 语句，不记录每行的变更），对磁盘友好。

**缺点**：**某些 SQL 在主从库上的执行结果可能不同**，导致主从数据不一致：

1. **非确定性函数**：`INSERT INTO t VALUES (NOW(), UUID(), RAND())`——`NOW()`、`UUID()`、`RAND()` 在主库和从库执行时会产生不同的值
2. **触发器与存储过程**：在从库上执行相同的 SQL 触发的触发器行为，可能因为数据差异而产生不同结果
3. **DELETE/UPDATE 使用 LIMIT**（无 ORDER BY 时）：`DELETE FROM t WHERE shop_id=1 LIMIT 10`，如果没有明确排序，删除哪 10 行是不确定的（取决于存储引擎的扫描顺序），主从可能删除不同的行

MySQL 5.6 之前，STATEMENT 是默认格式，给很多系统埋下了主从不一致的隐患。

### 2.2 ROW 格式：记录行变更

**ROW 格式**不记录 SQL 语句，而是记录**每一行数据的变更前值和变更后值**。

```
# at 100
#260302 14:30:00 server id 1
# Write_rows: table id 123 flags: STMT_END_F
### INSERT INTO `ecommerce`.`orders`
### SET
###   @1=12345  /* INT: order_id */
###   @2=100    /* INT: shop_id */
###   @3=2      /* TINYINT: status */
###   @4='2026-03-02 14:30:00'  /* DATETIME: created_at */
```

对于 UPDATE，ROW 格式同时记录变更前的完整行（`BEFORE_IMAGE`）和变更后的完整行（`AFTER_IMAGE`）：

```
### UPDATE `ecommerce`.`orders`
### WHERE
###   @1=12345  /* 变更前：order_id */
###   @3=1      /* 变更前：status=1 */
### SET
###   @3=2      /* 变更后：status=2 */
```

**优点**：
- **完全确定性**：从库回放时，直接按照记录的行变更执行，与主库执行结果完全一致，彻底消除了 STATEMENT 格式的主从不一致风险
- **从库执行更快**：不需要重新解析和执行 SQL，直接应用行变更，避免了从库的查询优化开销

**缺点**：
- **Binlog 体积大**：一条 `UPDATE orders SET status=2 WHERE shop_id=100`，如果影响了 100 万行，STATEMENT 格式只记录一条 SQL，ROW 格式需要记录 100 万条行变更，体积可能相差数百倍
- 大批量 DML 操作可能产生巨大的 Binlog，影响磁盘 I/O 和主从复制传输带宽

### 2.3 MIXED 格式：自适应的折中

**MIXED 格式**是 STATEMENT 和 ROW 的混合：
- **默认使用 STATEMENT**（体积小）
- **检测到可能导致主从不一致的操作时，自动切换为 ROW**（确定性强）

自动切换 ROW 的触发条件：使用了非确定性函数（`UUID()`、`RAND()`、`USER()`、`NOW()`）、使用了触发器、存储过程有修改数据的语句等。

### 2.4 推荐配置

MySQL 8.0 默认使用 ROW 格式，这是正确的选择。在生产环境中：

```ini
[mysqld]
binlog_format = ROW
binlog_row_image = MINIMAL  # 只记录变更的列，不记录完整行，减小 Binlog 体积
```

`binlog_row_image = MINIMAL`（MySQL 5.6+）：对于 UPDATE，只记录变更的列（而非整行）。对于 DELETE，只记录主键列（足以定位行）。这在保留 ROW 格式确定性的同时，大幅减小了 Binlog 体积。

> [!warning] 生产避坑
> 如果使用 Canal 或 Debezium 订阅 Binlog，需要注意 `binlog_row_image` 的设置。`MINIMAL` 模式下 UPDATE 事件只有变更列的 BEFORE/AFTER IMAGE，没有完整的行快照。如果下游系统需要完整的行数据（如同步到 ES 时需要完整文档），应该使用 `FULL` 模式，代价是 Binlog 体积更大。

---

## 第 3 章 主从复制的三线程模型

### 3.1 Dump Thread（主库）

主库上有一个专门用于复制的线程：**Dump Thread（二进制日志转储线程）**。每当有从库连接时，主库为该从库创建一个独立的 Dump Thread。

Dump Thread 的工作：
1. 监听主库的 Binlog 写入事件
2. 当有新的 Binlog Event 写入时，读取这些 Event
3. 通过网络将 Binlog Event 发送给对应的从库 IO Thread

**主库的 Dump Thread 数量 = 连接的从库数量**。如果有 10 个从库，主库有 10 个 Dump Thread，会消耗一定的主库 CPU 和网络带宽。这是从库数量不能无限增加的原因之一（通常建议一主直接连的从库不超过 5-8 个，更多的从库可以采用"级联复制"架构）。

### 3.2 IO Thread（从库）

从库的 **IO Thread** 负责与主库通信，获取 Binlog：

1. 连接主库的 Dump Thread，发送"我要从 Binlog 文件 XXX 的 Position YYY 开始接收"
2. 持续接收主库发来的 Binlog Event
3. 将接收到的 Binlog Event 写入从库本地的 **Relay Log（中继日志）** 文件

IO Thread 是一个纯粹的"搬运工"——只负责将 Binlog 从主库搬到从库的 Relay Log，不做任何数据变更操作。

**为什么需要 Relay Log 这个中间层？**

如果 IO Thread 接收到 Binlog 后直接交给 SQL Thread 执行，当 SQL Thread 处理速度较慢时，IO Thread 就必须停下来等待——主从延迟会随之增大。

通过引入 Relay Log 缓冲，IO Thread 和 SQL Thread 可以完全异步工作：IO Thread 尽快将 Binlog 写入 Relay Log（接近实时），SQL Thread 以自己的速度消费 Relay Log。这种生产者-消费者模式是 IO 密集型和 CPU 密集型任务解耦的经典设计。

### 3.3 SQL Thread（从库）

从库的 **SQL Thread** 负责将 Relay Log 中的 Binlog Event 回放到从库上：

1. 读取 Relay Log 中的 Binlog Event
2. 解析 Event，将其转化为数据库操作
3. 执行操作，更新从库数据
4. 更新 `relay_log_info`，记录当前已回放到的 Relay Log 位点

**SQL Thread 的历史性瓶颈**：在 MySQL 5.5 及之前，从库的 SQL Thread 是**单线程**的——只有一个线程顺序回放 Relay Log 中的事务。

而主库可能有数十个并发线程同时执行事务。单线程的从库无论如何也跟不上多线程的主库，主从延迟随着主库写入压力的增大而不断累积。这是 MySQL 5.x 时代主从复制最大的痛点。

---

## 第 4 章 GTID：彻底告别位点复制的复杂性

### 4.1 基于位点复制的困境

传统的复制使用 **Binlog 文件名 + 位点（Position）** 来标识复制进度：

```sql
CHANGE MASTER TO
  MASTER_HOST='192.168.1.100',
  MASTER_LOG_FILE='mysql-bin.000123',
  MASTER_LOG_POS=456789;
```

这带来了几个棘手的问题：

**问题一：主库切换后位点不可用**。当主库故障，需要将从库提升为新主库时，新主库的 Binlog 文件和位点与旧主库完全不同。其他从库必须找到"旧主库的 Position X 对应新主库的 Position Y"，这个映射关系的计算非常复杂，容易出错，是造成主从不一致的高风险操作。

**问题二：无法方便地判断从库是否已应用某个事务**。当主库执行了一个重要操作后，怎么确认从库已经同步了这个操作？基于位点无法直接回答，需要比较 Binlog 文件名和位点数字。

**问题三：手工操作容易出错**。DBA 在执行主库切换时，需要手动计算新主库的位点，这是一个极容易出错的操作，即使是经验丰富的 DBA 也难免失误。

### 4.2 GTID 的设计

**GTID（Global Transaction Identifier，全局事务标识符）** 是 MySQL 5.6 引入的特性，为每个在主库上提交的事务分配一个全局唯一的 ID。

GTID 的格式：`source_id:transaction_id`

- `source_id`：服务器的 UUID（`server_uuid`，MySQL 启动时自动生成并持久化到 `auto.cnf` 文件，全集群唯一）
- `transaction_id`：在该服务器上顺序递增的事务序号

例如：`3E11FA47-71CA-11E1-9E33-C80AA9429562:100` 表示 UUID 为 `3E11FA47...` 的服务器上提交的第 100 个事务。

**GTID Set**：一个服务器已执行的所有事务的 GTID 集合，用于表示"这台服务器的数据包含了哪些事务"。可以是连续区间的简写：`3E11FA47...:1-100` 表示第 1 到第 100 号事务都已执行。

### 4.3 GTID 如何简化复制

**基于 GTID 的复制配置**：

```sql
CHANGE MASTER TO
  MASTER_HOST='192.168.1.100',
  MASTER_AUTO_POSITION=1;  -- 自动使用 GTID 定位，无需手动指定文件名和位点
```

当从库连接主库时，从库发送自己的 GTID Set（"我已经有了哪些事务"），主库对比后，自动找出从库缺少的事务，从那里开始发送 Binlog——**完全不需要手动指定位点**。

**主库切换的变化**：

旧方式（基于位点）：需要计算旧主库 Position X 对应新主库的哪个 Position，复杂且容易出错。

新方式（基于 GTID）：每个事务都有全局唯一 ID，新主库直接告诉其他从库"我有哪些 GTID"，从库自动知道从哪里同步缺失的部分，不需要计算任何位点映射。

```sql
-- 基于 GTID 的主库切换（以 MHA/Orchestrator 为例）
-- 在新主库上
SET GLOBAL gtid_mode = ON;

-- 其他从库重新指向新主库
CHANGE MASTER TO
  MASTER_HOST='new_master_host',
  MASTER_AUTO_POSITION=1;
-- 完成，无需计算任何位点
```

**判断从库是否已应用某个事务**：

```sql
-- 等待从库应用 GTID 为 3E11FA47...:100 的事务（最多等待 30 秒）
SELECT WAIT_FOR_EXECUTED_GTID_SET('3E11FA47-71CA-11E1-9E33-C80AA9429562:100', 30);
-- 返回 0 表示已应用，1 表示超时未应用
```

这个函数让"写入主库后确认从库已同步"变得极为简单，是实现"写后读从库"强一致的关键工具。

> [!info] 核心概念
> GTID 将"复制进度"的语义从"我读到了主库 Binlog 的哪个物理位置"升级为"我执行了哪些全局唯一的事务"。这个语义升级的价值在于：物理位置依赖具体的 Binlog 文件，在主库切换时失效；而 GTID 是全局唯一的逻辑标识，不依赖任何特定的物理文件，在任意拓扑变化中都有效。

---

## 第 5 章 并行复制：突破从库回放的单线程瓶颈

### 5.1 为什么从库回放会落后

主库有 N 个并发事务同时提交，这 N 个事务被写入 Binlog 后，传输到从库的速度通常很快（Binlog 是顺序写，传输效率高）。但从库的 SQL Thread 是单线程，必须逐个事务顺序回放——即使主库这 N 个事务是并行的。

**主从延迟 = 从库 SQL Thread 的回放速度跟不上主库的写入速度时，Relay Log 中积压的事务量 × 单事务回放时间**。在主库写入 QPS 较高时，这个延迟可能达到分钟甚至小时级。

### 5.2 并行复制的演进

#### 5.2.1 MySQL 5.6：按 Schema 并行

MySQL 5.6 引入了并行复制，但粒度是**按 Schema（数据库）**：不同数据库上的事务可以并行回放，同一数据库的事务仍然顺序执行。

局限性极大——大多数业务只有一个数据库（如 `ecommerce`），所有事务都在同一个 Schema 下，无法并行。

#### 5.2.2 MySQL 5.7：按组（基于 Logical Clock）并行

MySQL 5.7 引入了更实用的**基于 Logical Clock 的并行复制**，原理是：

**在主库上同时处于 Prepare 状态（两阶段提交的第一阶段完成后）的事务，必然没有写写冲突**（否则其中一个会等待另一个的锁），因此可以安全地在从库上并行回放。

主库在将事务写入 Binlog 时，同时记录两个时间戳：
- `last_committed`：在本事务开始之前，最后一个提交的事务的序号
- `sequence_number`：本事务自己的顺序编号

```
事务 1: last_committed=0, sequence_number=1
事务 2: last_committed=0, sequence_number=2  （与事务1同时 Prepare）
事务 3: last_committed=0, sequence_number=3  （与事务1、2同时 Prepare）
事务 4: last_committed=3, sequence_number=4  （在事务1、2、3提交后才开始）
事务 5: last_committed=3, sequence_number=5  （与事务4同时 Prepare）
```

从库的并行复制逻辑：如果两个事务的 `last_committed` 相同（都是 0），说明它们在主库上是并行的，可以在从库上并行回放。事务 1、2、3 可以并行；事务 4、5 可以并行；但 4、5 必须等到 1、2、3 全部完成后才能开始（因为 4 的 `last_committed=3`，依赖 1、2、3 已提交）。

**并行度的配置**：

```sql
-- 设置并行复制线程数
SET GLOBAL slave_parallel_workers = 8;  -- 使用 8 个并行 SQL Thread

-- 选择并行复制策略
SET GLOBAL slave_parallel_type = 'LOGICAL_CLOCK';  -- MySQL 5.7 推荐
```

#### 5.2.3 MySQL 8.0：Writeset 并行复制

MySQL 8.0 引入了更激进的并行复制策略——**Writeset（写集合）**。

Writeset 记录每个事务修改了哪些主键值（行级写集合）。如果两个事务的写集合完全没有交集（修改了不同的行），它们就可以在从库上并行回放——即使这两个事务在主库上并不是同时提交的（有前后顺序）。

**Writeset 并行度比 Logical Clock 更高**：Logical Clock 只能并行化"主库上真正并行的事务"，而 Writeset 还能并行化"主库上顺序的但实际上没有数据依赖的事务"。

```sql
-- 开启 Writeset 并行复制（主库）
SET GLOBAL binlog_transaction_dependency_tracking = WRITESET;

-- 从库设置
SET GLOBAL slave_parallel_type = 'LOGICAL_CLOCK';
SET GLOBAL slave_parallel_workers = 16;
```

### 5.3 并行复制的监控

```sql
-- 查看从库复制状态
SHOW SLAVE STATUS\G
-- 关注：
-- Seconds_Behind_Master: 主从延迟（秒）
-- Slave_SQL_Running_State: SQL Thread 状态
-- Executed_Gtid_Set: 已执行的 GTID 集合（GTID 模式下）

-- 查看并行复制线程状态（Performance Schema）
SELECT * FROM performance_schema.replication_applier_status_by_worker;
```

---

## 第 6 章 Binlog 的维护与 PITR

### 6.1 Binlog 文件管理

Binlog 文件在以下情况下滚动（生成新文件）：
- 当前文件大小达到 `max_binlog_size`（默认 1GB）
- MySQL 重启
- 手动执行 `FLUSH BINARY LOGS`

Binlog 文件的自动清理由 `binlog_expire_logs_seconds`（MySQL 8.0，默认 2592000 秒 = 30 天）参数控制。超过这个时间的 Binlog 文件会被自动删除。

> [!warning] 生产避坑
> 不要手动 `rm` Binlog 文件！手动删除 Binlog 文件会导致从库找不到 Binlog 位点，复制中断，还可能损坏 Binlog 索引文件（`mysql-bin.index`）。正确的清理方式是：
> ```sql
> -- 删除指定文件名之前的所有 Binlog 文件（安全方式）
> PURGE BINARY LOGS TO 'mysql-bin.000100';
> 
> -- 删除指定日期之前的所有 Binlog 文件
> PURGE BINARY LOGS BEFORE '2026-01-01 00:00:00';
> ```
> 执行前确认所有从库已经同步过了要删除的 Binlog（`SHOW SLAVE STATUS` 中 `Master_Log_File` 比要删除的文件更新）。

### 6.2 基于 Binlog 的时间点恢复

```bash
# 场景：2026-03-02 14:00:00 执行了误操作，需要恢复到 13:59:59 的状态

# 1. 还原最近一次全量备份（假设是当天 00:00:00 的备份）
xtrabackup --copy-back --target-dir=/backup/2026-03-02/

# 2. 找到从 00:00:00 到 13:59:59 之间的所有 Binlog 文件
# 通过 mysqlbinlog 检查每个文件的时间范围
mysqlbinlog /var/lib/mysql/mysql-bin.000120 | head -20

# 3. 回放 Binlog（到误操作时间点之前停止）
mysqlbinlog \
  --start-datetime="2026-03-02 00:00:00" \
  --stop-datetime="2026-03-02 13:59:59" \
  /var/lib/mysql/mysql-bin.000120 \
  /var/lib/mysql/mysql-bin.000121 \
  | mysql -u root -p

# 或者基于 GTID 的精确恢复（更可靠）
mysqlbinlog \
  --include-gtids="3E11FA47...:1-99999" \
  /var/lib/mysql/mysql-bin.000120 \
  | mysql -u root -p
```

---

## 第 7 章 小结

本文构建的 Binlog 与主从复制完整知识体系：

1. **Binlog 三大用途**：主从复制（数据同步）、PITR（时间点恢复）、异构数据同步（Canal/Debezium）。Binlog 是 MySQL 生态连接外部世界的"数据总线"
2. **三种格式的取舍**：STATEMENT（体积小，非确定性风险）→ ROW（体积大，完全确定）→ MIXED（自适应）。MySQL 8.0 默认 ROW，生产推荐 ROW + `binlog_row_image=MINIMAL`
3. **三线程模型**：主库 Dump Thread（发送 Binlog）→ 从库 IO Thread（写入 Relay Log）→ 从库 SQL Thread（回放 Relay Log）。Relay Log 是解耦 IO 和 CPU 的缓冲
4. **GTID 的语义升级**：从"物理文件+位点"升级到"全局事务唯一 ID"。解决了主库切换时的位点计算难题，`MASTER_AUTO_POSITION=1` 使复制配置和切换变得极为简单
5. **并行复制的三代演进**：按 Schema（5.6，几乎无效）→ Logical Clock（5.7，主库并行的事务在从库也并行）→ Writeset（8.0，无数据依赖的事务都可并行，从库延迟大幅降低）
6. **Binlog 维护要点**：用 `PURGE BINARY LOGS` 而非手动删除；Binlog 是 PITR 的前提，备份策略中必须包含 Binlog 的保留

---

*至此，「MySQL 架构与底层原理」专栏 10 篇文章全部完成。从 MySQL 全局架构（SQL 的完整生命周期）→ Buffer Pool（内存磁盘桥梁）→ Redo Log（WAL 与崩溃恢复）→ Undo Log 与 MVCC（多版本并发控制）→ B+Tree 索引结构（页分裂机制）→ 行格式与数据页（磁盘物理存储）→ 锁机制（记录锁到间隙锁）→ 事务隔离级别（MVCC 与锁的协作）→ 查询优化器（代价模型与执行计划）→ Binlog 与主从复制（数据同步传动链），构成了一套完整的 InnoDB 底层原理知识体系。*

---

> [!note] 思考题
> 1. 窗口函数（`ROW_NUMBER()`、`RANK()`、`LAG()`）允许在不分组的情况下对行进行排名和计算——避免了传统 SQL 中复杂的子查询和自连接。在一个'查询每个部门薪资排名前 3 的员工'的场景中，窗口函数比传统写法简洁多少？窗口函数的执行效率与等价的子查询写法相比如何？
> 2. CTE（Common Table Expression，`WITH` 子句）将复杂查询拆分为可命名的临时结果集——提升可读性。递归 CTE 可以查询树形结构（如组织架构的层级关系）。MySQL 8.0 的递归 CTE 实现与 PostgreSQL 的有什么差异？递归深度有限制吗（`cte_max_recursion_depth` 默认 1000）？
> 3. MySQL 8.0 的原生 JSON 支持允许在 JSON 列上创建虚拟列（Generated Column）并建立索引。`SELECT * FROM orders WHERE JSON_EXTRACT(details, '$.status') = 'paid'` 可以通过虚拟列 + 索引加速。但 JSON 列的更新是整列替换（非原地修改）——在频繁更新 JSON 中的某个字段时性能如何？`JSON_SET` 函数是否能实现部分更新？
