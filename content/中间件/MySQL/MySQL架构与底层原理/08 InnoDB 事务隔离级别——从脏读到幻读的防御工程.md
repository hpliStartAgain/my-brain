---
title: "InnoDB 事务隔离级别——从脏读到幻读的防御工程"
date: 2026-03-02
tags: [MySQL, InnoDB, 事务隔离, MVCC, 幻读, ReadView, 间隙锁]
aliases: [事务隔离级别, 幻读防御, MVCC隔离]
---

# 08 InnoDB 事务隔离级别——从脏读到幻读的防御工程

**摘要：** 进阶使用专栏的第 03 篇从"开发者如何用好事务"的角度讲了隔离级别，本文从"InnoDB 如何在底层实现隔离级别"的角度重新审视这个问题。SQL 标准定义的四种隔离级别只是**语义规范**（禁止哪些并发异常），而 InnoDB 的实现远比标准规定的更精妙——它用 [[MVCC]] 的快照读取代了部分锁，在保证隔离性的同时大幅提升了并发度。本文将 MVCC（ReadView 机制）与锁机制（间隙锁）组合起来，完整解释 InnoDB 是如何在 [[REPEATABLE READ]] 级别下通过"快照读用 ReadView，当前读用间隙锁"的双重机制来防止幻读的，以及这两种机制之间的协调边界与反例。

---

## 第 1 章 SQL 标准的隔离级别是规范而非实现

### 1.1 SQL 标准只定义"禁止什么"

1992 年的 SQL 标准（SQL-92）定义了四种事务隔离级别，通过"该级别下禁止发生哪些并发异常"来描述：

| 隔离级别 | 禁止脏读 | 禁止不可重复读 | 禁止幻读 |
|---------|---------|-------------|---------|
| READ UNCOMMITTED | ✗ | ✗ | ✗ |
| READ COMMITTED | ✓ | ✗ | ✗ |
| REPEATABLE READ | ✓ | ✓ | ✗（标准不要求）|
| SERIALIZABLE | ✓ | ✓ | ✓ |

注意：**SQL 标准并未规定 RR 级别必须防止幻读**。标准只说 RR 级别必须防止脏读和不可重复读，幻读留给了 SERIALIZABLE 级别来解决。

InnoDB 在 RR 级别下额外提供了部分幻读防护——通过 MVCC 的快照读防止了绝大多数场景的幻读，通过间隙锁防止了当前读场景的幻读。这是 InnoDB 超越 SQL-92 标准的地方，也是造成很多困惑（"RR 级别到底防不防幻读？"）的根源。

### 1.2 实现隔离性的两种手段

数据库实现事务隔离性，历史上有两种主流手段：

**手段一：悲观锁（Pessimistic Locking）**

读操作加共享锁，写操作加排他锁。通过锁的互斥来保证隔离性。这是最直观的实现，缺点是读写互斥，降低并发度。Oracle 早期和 SQL Server 的某些模式使用这种方式。

**手段二：MVCC（Multi-Version Concurrency Control）**

维护数据的多个版本，读操作读取历史版本，写操作修改当前版本。读写之间不需要互斥，并发度大幅提升。PostgreSQL 和 InnoDB 都使用这种方式。

InnoDB 的实现是两者的结合：**普通 SELECT 用 MVCC（无锁快照读），DML 和加锁 SELECT 用锁（当前读）**。

---

## 第 2 章 MVCC 如何实现读已提交和可重复读

### 2.1 两种隔离级别的 MVCC 实现差异

上一篇（架构原理 04）已经详细解析了 [[ReadView]] 的数据结构和可见性判断规则。这里从隔离级别的角度重新梳理：

**READ COMMITTED（RC）**：

RC 的语义是"每次 SELECT 都能看到在该 SELECT 执行时刻之前已经提交的所有修改"。对应 MVCC 实现：**每次 SELECT 语句执行时创建新的 ReadView**。

新 ReadView 中的活跃事务列表（`trx_ids`）反映了"SELECT 执行那一刻"的活跃事务快照。如果某个事务在上一次 SELECT 之后、这次 SELECT 之前提交了，它就不在新 ReadView 的活跃列表中，当前事务可以看到它的修改——这就是 RC 的"不可重复读"现象。

**REPEATABLE READ（RR）**：

RR 的语义是"事务内所有 SELECT 看到的数据是同一时刻的快照"。对应 MVCC 实现：**事务中第一次 SELECT 创建 ReadView，之后所有 SELECT 复用同一个 ReadView**。

无论其他事务在此期间提交了什么，ReadView 中的活跃事务列表不变，可见性判断基于固定的历史快照——这消除了不可重复读。

### 2.2 ReadView 的创建时机对可见性的决定性影响

一个精确的实验可以完整验证 RC 和 RR 的差异：

```sql
-- 初始数据：表 t 中有一行 (id=1, val=100)，由事务 trx_id=10 提交

-- ====== 场景一：READ COMMITTED ======
-- 连接 A（RC 级别）
SET SESSION transaction_isolation = 'READ-COMMITTED';
BEGIN;  -- 开启事务，但还未执行任何 SELECT，不创建 ReadView

-- 连接 B：开启事务 trx_id=20，修改 val=200，但不提交
BEGIN;
UPDATE t SET val=200 WHERE id=1;

-- 连接 A：第一次 SELECT
SELECT val FROM t WHERE id=1;
-- → 创建 ReadView，此时活跃事务 trx_ids=[20]
-- → 行的 DB_TRX_ID=20，在活跃列表中 → 不可见
-- → 沿版本链找到 trx_id=10 的旧版本 val=100
-- → 返回 100 ✓

-- 连接 B：提交
COMMIT;  -- 事务 20 提交，val 正式变为 200

-- 连接 A：第二次 SELECT
SELECT val FROM t WHERE id=1;
-- → 创建新 ReadView（RC 每次 SELECT 都创建），此时活跃事务 trx_ids=[]
-- → 行的 DB_TRX_ID=20，不在活跃列表中 → 可见
-- → 直接读当前版本 val=200
-- → 返回 200 ✓（不可重复读：两次 SELECT 结果不同）

-- ====== 场景二：REPEATABLE READ ======
-- 重置数据，连接 C（RR 级别，默认）
BEGIN;

-- 连接 D：开启事务 trx_id=30，修改 val=300，但不提交
BEGIN;
UPDATE t SET val=300 WHERE id=1;

-- 连接 C：第一次 SELECT
SELECT val FROM t WHERE id=1;
-- → 创建 ReadView，此时活跃事务 trx_ids=[30]
-- → 返回旧版本 val=100 ✓

-- 连接 D：提交
COMMIT;  -- 事务 30 提交，val 正式变为 300

-- 连接 C：第二次 SELECT
SELECT val FROM t WHERE id=1;
-- → 复用之前的 ReadView，trx_ids=[30]
-- → 行的 DB_TRX_ID=30，仍在活跃列表中 → 不可见
-- → 仍然返回旧版本 val=100 ✓（可重复读：两次结果相同）
```

这个实验清晰地展示了：**ReadView 创建时机决定了可重复读是否能实现**，而不是任何神秘的锁机制。

---

## 第 3 章 RR 级别下幻读防护的完整机制

### 3.1 快照读对幻读的防护

在 RR 级别下，普通 SELECT（快照读）通过 ReadView 天然防止了幻读：

```sql
-- 表 orders 中有 10 条 status=1 的记录（由 trx_id < 100 的事务插入）

-- 事务 A（RR 级别，trx_id=200）
BEGIN;
SELECT COUNT(*) FROM orders WHERE status=1;
-- → 创建 ReadView，min_trx_id=150（假设）
-- → 所有 trx_id < 150 的行可见
-- → 返回 10 条 ✓

-- 事务 B（trx_id=300，比 A 晚启动）
INSERT INTO orders (status=1, ...) VALUES (...);
COMMIT;
-- → 新行的 DB_TRX_ID=300，300 >= max_trx_id（ReadView 创建时的下一个ID），不可见

-- 事务 A：第二次 SELECT
SELECT COUNT(*) FROM orders WHERE status=1;
-- → 复用 ReadView，新行的 DB_TRX_ID=300 > max_trx_id → 不可见
-- → 仍然返回 10 条 ✓（幻读被防止）
```

快照读的幻读防护是完整的：只要事务始终使用普通 SELECT，ReadView 保证了事务看到的数据集始终是"事务开始时刻的快照"，任何新插入的行都不可见。

### 3.2 当前读引入的幻读漏洞

问题出现在**当前读**（`FOR UPDATE`、`LOCK IN SHARE MODE`、DML 操作）与**快照读**混合使用时：

```sql
-- 表 orders 中有 10 条 status=1 的记录
-- 事务 A（RR 级别）
BEGIN;

-- 第一次查询（快照读）
SELECT COUNT(*) FROM orders WHERE status=1;
-- → 创建 ReadView，返回 10 条

-- 事务 B：插入一条新记录
INSERT INTO orders (id=999, status=1, user_id=100, ...) VALUES (...);
COMMIT;

-- 事务 A：当前读（读取最新版本）
UPDATE orders SET remark='processed' WHERE status=1;
-- → 当前读！读取所有 status=1 的最新已提交版本
-- → 包括事务 B 新插入的 id=999 这一行
-- → 影响了 11 行（包括 id=999）
-- → id=999 的 DB_TRX_ID 被修改为事务 A 的 trx_id

-- 事务 A：再次快照读
SELECT COUNT(*) FROM orders WHERE status=1;
-- → 复用 ReadView
-- → id=999 的 DB_TRX_ID 现在是事务 A 自己，creator_trx_id == DB_TRX_ID → 可见！
-- → 返回 11 条 ✗（产生幻读！）
```

这个"幻读"场景的触发条件是：
1. 事务 A 先做了快照读（创建了 ReadView）
2. 事务 B 插入了新行并提交
3. 事务 A 做了当前读（UPDATE/DELETE/FOR UPDATE），读到了新行并修改了它
4. 事务 A 再做快照读，由于第 3 步修改了新行的 `DB_TRX_ID` 为自己的事务 ID，新行对自己可见

这是 InnoDB RR 级别下真实存在的幻读场景，不是理论假设。

### 3.3 间隙锁对当前读幻读的防护

要彻底防止上述场景，需要在第一次查询时就用**当前读 + 间隙锁**，阻止事务 B 的插入：

```sql
-- 事务 A（RR 级别）
BEGIN;

-- 使用当前读（加间隙锁）
SELECT COUNT(*) FROM orders WHERE status=1 FOR UPDATE;
-- → 当前读，对 status=1 相关的索引范围加间隙锁
-- → 阻止其他事务在 status=1 的范围内插入新行

-- 事务 B：尝试插入
INSERT INTO orders (status=1, ...) VALUES (...);
-- → 被事务 A 的间隙锁阻塞，进入等待队列

-- 事务 A：再次查询
SELECT COUNT(*) FROM orders WHERE status=1 FOR UPDATE;
-- → 事务 B 被阻塞，没有新行
-- → 仍然返回 10 条 ✓（幻读被间隙锁防止）

COMMIT;
-- 事务 A 提交，释放间隙锁
-- 事务 B 获得锁，继续插入
```

> [!info] 核心概念
> InnoDB RR 级别的幻读防护是**分层**的：
> - **快照读层**：MVCC ReadView 防止了纯快照读场景的幻读（不需要锁）
> - **当前读层**：间隙锁防止了当前读场景的幻读（需要显式 FOR UPDATE 或 LOCK IN SHARE MODE）
> - **混合场景**：快照读建立快照后，中间插入了其他事务的行，再做当前读并修改新行，再做快照读——此时产生幻读。这个场景在实际业务中较少见，但理论上存在。

### 3.4 SERIALIZABLE 级别：消除所有幻读

在 SERIALIZABLE 级别下，InnoDB 将所有普通 SELECT **自动升级为 `SELECT ... LOCK IN SHARE MODE`（当前读 + 共享锁）**：

```sql
-- SERIALIZABLE 级别下，这条普通 SELECT...
SELECT * FROM orders WHERE status=1;

-- ...等价于这条加锁读
SELECT * FROM orders WHERE status=1 LOCK IN SHARE MODE;
```

这样，即使是普通 SELECT 也会持有间隙锁，完全阻止了其他事务在查询范围内插入新行。SERIALIZABLE 彻底消除了所有幻读，但也让所有读写操作都通过锁来协调——读写冲突，并发度大幅下降。

---

## 第 4 章 不同场景下的隔离级别行为对比

### 4.1 场景对比矩阵

| 场景 | READ COMMITTED | REPEATABLE READ | SERIALIZABLE |
|------|---------------|----------------|-------------|
| **快照读（普通 SELECT）** | 每次读最新已提交版本，不可重复读 | 读事务开始时的快照，可重复读，无幻读 | 自动加共享锁，无幻读 |
| **当前读（FOR UPDATE）** | 读最新已提交版本，加记录锁（无间隙锁） | 读最新已提交版本，加临键锁（含间隙锁） | 同 RR（已是最严格） |
| **UPDATE/DELETE** | 加记录锁，半一致性读优化 | 加临键锁，无半一致性读 | 同 RR |
| **INSERT** | 只加插入意向锁 + 记录锁 | 加插入意向锁 + 记录锁（可能被 Gap Lock 阻塞）| 同 RR |
| **幻读（快照读）** | 存在（每次读不同版本） | 不存在（MVCC 保护） | 不存在 |
| **幻读（当前读）** | 存在（无间隙锁） | 理论上存在（混合读写场景），纯当前读不存在 | 不存在 |
| **死锁概率** | 低（无间隙锁，锁范围小） | 中（间隙锁可能参与死锁） | 高（大量锁） |

### 4.2 RC 级别的半一致性读优化

RC 级别独有的**半一致性读（Semi-Consistent Read）** 优化值得单独解释：

在 RC 级别下，`UPDATE` 语句扫描行时，如果某行已经被其他事务锁定，InnoDB 会**通过 MVCC 读取该行的最新已提交版本**来判断它是否满足 WHERE 条件：
- 如果不满足 WHERE 条件：直接跳过这行，不等待锁释放
- 如果满足 WHERE 条件：等待锁释放，然后再次读取最新版本并更新

这个优化减少了 UPDATE 操作的锁等待时间，在高并发 UPDATE 场景下显著提升了吞吐量。RR 级别下没有这个优化——UPDATE 扫描到被锁定的行时，必须等待锁释放。

---

## 第 5 章 隔离级别的选择建议

### 5.1 为什么互联网公司倾向于 RC

互联网公司（特别是电商、支付领域）有一种常见的实践：**全局使用 RC 隔离级别**，原因是：

1. **更低的锁冲突和死锁率**：RC 不使用间隙锁，行锁范围更小，并发写入时锁冲突更少
2. **半一致性读优化**：高并发 UPDATE 场景下性能更好
3. **更快的 Undo 回收**：RC 的 ReadView 是语句级别，语句完成后 ReadView 就可以释放，对应的 Undo Log 可以更早被 Purge 回收
4. **与 Oracle/PostgreSQL 行为一致**：RC 是很多数据库的默认级别，迁移时行为更一致

对于互联网业务，不可重复读通常是可以接受的——业务代码很少有"同一事务内需要多次读取同一行并要求结果一致"的严格要求。

### 5.2 必须使用 RR 的场景

1. **基于 STATEMENT 格式 Binlog 的复制**（遗留系统）：RC + STATEMENT Binlog 在某些场景下会导致主从不一致（如 `INSERT ... SELECT` 等语句）
2. **需要事务内多次读取的一致性快照**：如复杂的财务对账（需要在事务开始时锁定一致的数据视图）、需要基于当前快照做多步计算的业务逻辑
3. **强制防止某些并发写问题**：RR + `SELECT ... FOR UPDATE` 的间隙锁可以防止并发 INSERT 产生重复记录（比唯一索引更灵活的业务级约束）

---

## 第 6 章 小结

本文从底层实现的视角完整解析了 InnoDB 隔离级别的实现机制：

1. **SQL 标准只定义语义（禁止什么异常），不定义实现**。InnoDB 的 RR 在标准要求之外额外提供了幻读防护，体现了工程上的进取性
2. **MVCC 是隔离性的核心引擎**：RC 每条 SELECT 创建 ReadView，RR 事务开始创建并复用。这一个时机的差异，决定了"不可重复读"是否存在
3. **RR 级别的幻读防护是分层的**：快照读用 MVCC（无锁），当前读用间隙锁（加锁）。纯快照读无幻读，纯当前读用间隙锁防幻读，混合场景存在理论上的幻读漏洞
4. **SERIALIZABLE 的代价**：将所有 SELECT 升级为当前读（加共享锁），彻底消除幻读，但读写冲突，并发度骤降
5. **RC 在高并发写入场景优于 RR**：无间隙锁、半一致性读优化、更快的 Undo 回收，这三个优势在高并发 OLTP 系统中非常显著
6. **隔离级别的选择是工程权衡**：对一致性要求越高，需要越强的隔离级别，但并发性能代价越大。大多数互联网业务用 RC 足够，关键业务用 RR + 显式锁

---

> [!note] 思考题
> 1. 半同步复制（Semi-Sync Replication）要求 Leader 在至少一个从库确认收到 Binlog 后才返回给客户端。这保证了主库故障时至少一个从库有最新数据。但半同步增加了写延迟——延迟等于主从之间的网络 RTT。在跨机房部署（RTT 10ms）时，半同步的写延迟增加多少？`rpl_semi_sync_master_timeout` 超时后会降级为异步——这个降级是否意味着可能丢数据？
> 2. MySQL Group Replication（MGR）使用 Paxos 协议实现多主复制——任何节点都可以写入。MGR 的单主模式（只有一个节点接受写入）和多主模式各适合什么场景？多主模式下的冲突检测（基于行级的乐观锁）在什么并发模式下冲突率会很高？
> 3. MHA（MySQL High Availability）和 Orchestrator 是常用的 MySQL 高可用管理工具。当主库宕机时，它们自动选举新主库并切换从库的复制源。自动故障转移的最大风险是什么（如脑裂、数据不一致）？你如何验证故障转移后数据的一致性？
