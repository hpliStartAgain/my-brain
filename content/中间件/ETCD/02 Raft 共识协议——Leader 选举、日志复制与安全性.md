---
title: "02 Raft 共识协议——Leader 选举、日志复制与安全性"
date: 2026-03-04
tags: [AppendEntries, etcd, Leader选举, Raft, 任期, 安全性, 成员变更, 日志复制]
aliases: []
---

# 02 Raft 共识协议——Leader 选举、日志复制与安全性

## 摘要

Raft 是 Diego Ongaro 在 2013 年博士论文中提出的共识协议，设计目标是"比 Paxos 更易于理解"。Raft 通过强 Leader 模型将共识问题分解为三个相对独立的子问题：Leader 选举、日志复制和安全性保证。etcd 使用 etcd/raft 库（Raft 协议的 Go 语言参考实现）作为核心共识引擎。本文深入剖析 Raft 的每个机制——为什么随机超时能解决选举活锁、为什么日志匹配属性是安全性的基础、为什么 Leader 不能直接提交前任 Leader 的日志——并最终给出 etcd 生产集群的常见一致性问题根因。

---

## 第 1 章 Raft 的角色与任期

### 1.1 三种角色

Raft 集群中的每个节点在任意时刻处于三种角色之一：

**Leader（领导者）**：整个集群的写入中心，所有写请求必须经过 Leader 处理。Leader 负责将日志条目（Log Entry）复制到其他节点，并决定何时提交（即何时可以安全地将日志应用到状态机）。任意时刻，一个 Term 内**最多有一个 Leader**。

**Follower（跟随者）**：被动角色。Follower 接受来自 Leader 的 `AppendEntries` RPC（日志复制和心跳）和来自 Candidate 的 `RequestVote` RPC（选举投票）。Follower 不主动发起任何请求。所有客户端请求如果发送到 Follower，Follower 会将客户端重定向到 Leader。

**Candidate（候选者）**：Follower 在选举超时时转变为 Candidate，发起 Leader 选举。Candidate 是 Follower 到 Leader 的过渡角色。

### 1.2 任期（Term）：Raft 的逻辑时钟

**Term（任期）** 是 Raft 的全局逻辑时钟，单调递增的整数。每次新的 Leader 选举开始时，Term 加 1。

Term 的作用：
- **识别过时信息**：每个 RPC 请求和响应都携带发送方的 Term。如果接收方发现 RPC 中的 Term 小于自己的当前 Term，说明发送方是过时的旧 Leader 或旧 Candidate，直接拒绝；
- **防止脑裂**：旧 Leader 在网络恢复后，发现自己的 Term 小于集群当前 Term，会立即降为 Follower，放弃 Leader 身份；
- **跟踪选举轮次**：每个节点只能在同一 Term 内投出一票，防止同一 Term 内选出多个 Leader。

Term 存储在每个节点的持久化状态中（写入磁盘），确保节点重启后仍能正确识别过时信息。

---

## 第 2 章 Leader 选举：随机超时的精妙设计

### 2.1 选举超时的触发

Follower 维护一个**选举超时计时器（Election Timeout）**，随机值取自 `[150ms, 300ms]`（etcd 默认 1000ms 基础超时，但概念相同）。每次收到 Leader 的心跳（`AppendEntries` RPC）或给某个 Candidate 投票后，计时器重置。

如果在选举超时时间内没有收到任何消息，Follower 认为当前 Leader 已宕机，转变为 Candidate，开始新一轮选举：

1. `currentTerm` 加 1（进入新的任期）；
2. 给自己投票（`votedFor = 自己`，持久化到磁盘）；
3. 向所有其他节点发送 `RequestVote` RPC。

### 2.2 为什么是随机超时，而不是固定超时

**如果所有节点使用固定的选举超时（如都是 150ms）：**

当 Leader 宕机时，所有 Follower 同时超时，同时变为 Candidate，同时发起选举，每个节点都给自己投票，没有任何节点能获得多数票，选举失败，Term 加 1，然后所有节点继续以相同超时等待……无限循环，**选举活锁（Election Liveness Problem）**。

**随机超时的解决方案：**

由于每个节点的超时时间不同，某个节点会**率先超时**，率先变为 Candidate 并发送 `RequestVote`。如果其他节点还没有超时（还是 Follower），它们会接受这个 Candidate 的投票请求（如果条件满足），这个 Candidate 大概率能在其他节点超时之前就获得多数票，当选 Leader。

随机超时的核心逻辑：**在时间轴上错开各节点的超时时机**，使得通常情况下只有一个节点率先发起选举，避免多个 Candidate 同时竞争导致的活锁。

只要随机超时范围（如 150ms ~ 300ms）远大于网络往返时延（通常 < 1ms 局域网），这个机制就能可靠地工作——第一个超时的节点有足够的时间在其他节点超时之前收集到多数投票。

### 2.3 RequestVote 的投票条件

Candidate 发送的 `RequestVote` RPC 包含：
- `term`：Candidate 的当前 Term；
- `candidateId`：Candidate 的节点 ID；
- `lastLogIndex`：Candidate 本地日志的最后一条 Entry 的索引；
- `lastLogTerm`：Candidate 本地日志最后一条 Entry 的 Term。

节点 B 收到 Candidate A 的 `RequestVote` 后，只有满足以下**所有条件**才会投票给 A：

1. **A 的 Term ≥ 自己的 currentTerm**（不给过时的 Candidate 投票）；
2. **B 在当前 Term 尚未投票给其他人**（每 Term 只能投一票）；
3. **A 的日志至少和自己一样新**（日志完整性检查，关键安全条件）：
   - A 的 `lastLogTerm > B 的 lastLogTerm`（A 最新日志的 Term 更大），OR
   - A 的 `lastLogTerm == B 的 lastLogTerm` AND A 的 `lastLogIndex >= B 的 lastLogIndex`（Term 相同，A 的日志更长或一样长）

**条件 3 是 Raft 安全性的关键**：确保只有拥有最完整（最新）日志的节点才能当选 Leader，从而保证已提交的日志不会丢失（详见第 4 章）。

### 2.4 选举结果的三种可能

**结果一：当选 Leader**

Candidate 收到了超过半数（quorum）节点的投票，立即转变为 Leader。新 Leader 立即向所有节点发送心跳（空的 `AppendEntries`），阻止其他节点触发选举超时。

**结果二：选举失败（其他节点当选）**

Candidate 收到了一个 Term ≥ 自己的 `AppendEntries` RPC（说明另一个节点已经当选 Leader），立即降为 Follower。

**结果三：超时，重新发起选举**

没有任何节点获得多数票（选票被分散了——split vote），所有 Candidate 等待随机超时后，Term 加 1，重新发起选举。由于下一轮超时也是随机的，通常会很快选出 Leader。

---

## 第 3 章 日志复制：AppendEntries 协议

### 3.1 Leader 日志的权威性

Raft 的强 Leader 原则：**所有日志条目必须从 Leader 流向 Follower，绝不反向**。Leader 的日志是集群的权威来源，Follower 的日志必须与 Leader 保持一致（可以落后，但不能有冲突）。

这与 ZAB 的核心思路一致（ZAB 也是强 Leader 模型），但 Raft 在安全性证明和成员变更上有更清晰的形式化定义。

### 3.2 AppendEntries RPC 的格式

```protobuf
message AppendEntriesRequest {
  uint64 term           = 1;  // Leader 的当前 Term
  uint64 leaderId       = 2;  // Leader ID（Follower 可以将客户端重定向到这里）
  uint64 prevLogIndex   = 3;  // 紧邻新 Entry 之前的那个 Entry 的索引
  uint64 prevLogTerm    = 4;  // prevLogIndex 对应 Entry 的 Term
  repeated Entry entries = 5; // 要复制的 Log Entries（心跳时为空）
  uint64 leaderCommit   = 6;  // Leader 的 commitIndex
}
```

**`prevLogIndex` 和 `prevLogTerm` 的作用：一致性检查**

Follower 收到 `AppendEntries` 后，首先检查：
- 自己的日志中，索引为 `prevLogIndex` 的 Entry 的 Term 是否等于 `prevLogTerm`；
- 如果不匹配（或者 Follower 没有 `prevLogIndex` 对应的 Entry），返回失败。

这个检查被称为**日志匹配属性（Log Matching Property）**的执行点：只有当 Follower 确认 `prevLogIndex` 处的日志与 Leader 一致，才接受后续的新 Entry，确保了 Follower 的日志是 Leader 日志的一个连续前缀。

### 3.3 日志冲突的修复

当 Follower 的日志与 Leader 不一致时（例如旧 Leader 在崩溃前将某些 Entry 复制给了部分 Follower，但这些 Entry 未被提交），新 Leader 需要修复这些不一致：

**Leader 为每个 Follower 维护 `nextIndex`**：记录下一次发送给该 Follower 的 Entry 索引。初始化为 `Leader 最后一条 Entry 的索引 + 1`。

**冲突修复流程：**

```
1. Leader 发送 AppendEntries（nextIndex[F] - 1 对应 prevLogIndex, prevLogTerm）
2. Follower 检查 prevLogIndex 处的 Entry，发现 Term 不匹配，返回失败
   （etcd 优化：Follower 在响应中附带 conflictIndex 和 conflictTerm，让 Leader 快速跳过多个冲突 Entry）
3. Leader 将 nextIndex[F] 减 1（或基于 Follower 返回的 conflictIndex 快速跳过），重试
4. 重复步骤 1-3，直到找到 Leader 和 Follower 日志的最长公共前缀
5. 从公共前缀之后的 Entry 开始，Leader 向 Follower 发送缺失的 Entry
6. Follower 覆盖冲突的 Entry，用 Leader 的 Entry 替换
```

**覆盖（冲突）Entry 的安全性：** 未提交的 Entry 被覆盖是安全的——未提交意味着只有少数节点（不足 quorum）接收了这些 Entry，新 Leader （通过选举条件 3 保证拥有最完整的已提交日志）不会覆盖任何已提交的 Entry。

### 3.4 commitIndex 的推进

Leader 提交（commit）一个 Entry 的条件：该 Entry 已被 **quorum 个节点（包括 Leader 自身）成功追加到日志**（即返回了 ACK）。

提交后：
- Leader 将 `commitIndex` 更新为该 Entry 的 Index；
- 在下一次 `AppendEntries`（可能是心跳）中，Leader 将 `leaderCommit` 告知所有 Follower；
- Follower 将自己的 `commitIndex` 更新为 `min(leaderCommit, 自己最新的 Entry 索引)`；
- 所有节点的 `applyIndex` 协程将 `commitIndex` 以下所有已提交未应用的 Entry 顺序应用到状态机（etcd 中即写入 BoltDB）。

---

## 第 4 章 安全性：已提交的日志不会丢失

### 4.1 Leader 完整性属性

Raft 的核心安全保证：**如果一个 Log Entry 在某个 Term 被提交（即被 quorum 接受），那么这个 Entry 一定会出现在所有更高 Term 的 Leader 的日志中**。

换句话说：一旦 commit，永不丢失。

**证明（反证法）：**

假设 Term T 的 Leader L 提交了 Entry e，但 Term T' > T 的 Leader L' 没有 Entry e。

- Entry e 被 L 提交，意味着 quorum Q1 的所有节点都有 Entry e；
- L' 当选，意味着 quorum Q2 的所有节点都投票给了 L'；
- 由于 quorum 是超过半数，Q1 和 Q2 必有交集（至少 1 个节点同时属于 Q1 和 Q2）——设此节点为 N；
- N 属于 Q1，说明 N 有 Entry e；
- N 属于 Q2，说明 N 投票给了 L'；
- 但 N 投票给 L' 的条件 3 要求：L' 的日志必须至少和 N 一样新（即 L' 的 lastLogTerm/Index 不低于 N）；
- 如果 L' 没有 Entry e，则 L' 的日志在 Entry e 的位置不如 N（N 有 e，L' 没有），N 不会投票给 L'，矛盾！

所以，"L' 当选但没有 Entry e"不可能发生，安全性得证。

### 4.2 为什么 Leader 不能直接提交前任 Leader 的 Entry

这是 Raft 的一个微妙之处，也是很多人容易困惑的地方。

**反例场景：**

```
时间线：
  Term 1: Leader L1 将 Entry A（Index=5）复制给了大多数节点，Entry A 应当已提交
  但 L1 在发送 commitIndex 更新之前崩溃了
  Term 2: 某个节点 L2 当选 Leader，L2 也有 Entry A（Index=5）
  
问题：L2 能否直接将 Entry A 提交（commit）？
```

答案是**不能直接提交**，原因：

Entry A 虽然被大多数节点接受，但 L2 不确定 Entry A 是否真的"应该"被提交——在某些复杂的网络分区场景下，Entry A 的 Term（Term 1）可能与 L2 当前 Term（Term 2）不同，而 Raft 的日志匹配判断基于 Term，直接提交旧 Term 的 Entry 可能导致不一致。

**Raft 的正确做法：只通过提交当前 Term 的 Entry 来隐式提交之前 Term 的 Entry。**

L2 需要先在当前 Term（Term 2）写入并提交一个新 Entry（哪怕是一个 no-op 空 Entry），通过 `commitIndex` 的前进，隐式地提交了 Entry A（Index=5）之前所有已被多数接受的 Entry。

这就是为什么 etcd 在每次 Leader 选举后，会立即追加并提交一个 **no-op Entry**（空的心跳日志条目）——不是为了真正记录什么数据，而是为了通过提交当前 Term 的 Entry 来将之前遗留的 Entry 正确地 commit，使 `commitIndex` 尽快推进到最新位置，让集群尽快恢复可写状态。

---

## 第 5 章 成员变更：集群在线扩缩容

### 5.1 成员变更的安全挑战

在 Raft 集群中增加或删除节点（称为成员变更），是一个有潜在安全风险的操作。

**问题：** 如果直接让所有节点"切换"到新的成员配置，不同节点可能在不同时刻切换，在切换的中间状态，旧配置和新配置可能各自有 quorum，导致同一 Term 内选出两个 Leader（脑裂）。

**示例：** 集群从 3 节点扩容到 5 节点。
- 旧配置的 quorum = 2（3 中取 2）；
- 新配置的 quorum = 3（5 中取 3）；
- 如果 node1, node2 还在旧配置（quorum=2，它们两个就够），而 node3, node4, node5 已在新配置（quorum=3，需要 3 个节点），理论上可能有两个 Leader 同时存在。

### 5.2 Joint Consensus：安全的两阶段成员变更

Raft 论文提出的安全成员变更方案是 **Joint Consensus（联合共识）**：

**阶段一：切换到联合配置（C_old,new）**

联合配置同时包含旧配置和新配置。在联合配置下，任何决策（写入提交、Leader 选举）都需要**旧配置的 quorum AND 新配置的 quorum 同时满足**。

例如，从 3 节点扩容到 5 节点的联合配置：
- 旧配置 quorum：{node1, node2, node3} 中的 2 个；
- 新配置 quorum：{node1, node2, node3, node4, node5} 中的 3 个；
- 同时满足两个 quorum 才能提交。

在联合配置下，不可能出现两个 Leader——因为无论哪个节点想当选，都需要同时获得旧配置和新配置的多数票。

**阶段二：切换到新配置（C_new）**

联合配置的 Entry 被提交后，Leader 再创建一个切换到新配置（C_new）的 Entry，提交后集群正式切换到新配置，联合阶段结束。

etcd 使用了一个简化版本（**单步成员变更**）：每次只增加或删除一个节点（不能同时变更多个），这样可以不需要 Joint Consensus，直接安全地进行成员变更——每次只增减 1 个节点时，不可能出现两个 quorum 同时满足的情况。

---

## 第 6 章 etcd 中的 Raft 实现细节

### 6.1 etcd/raft 库的异步设计

etcd 使用的 `etcd/raft` 库是 Raft 协议的一个精心设计的实现，特点是**完全异步、无 I/O**——库本身不进行任何网络调用或磁盘写入，所有 I/O 都由上层（etcd server）处理：

```go
// raft 库只做状态机计算，通过 Ready 结构体通知上层需要做什么
type Ready struct {
    SoftState       *SoftState       // 易失状态（Leader/Follower）
    HardState       raftpb.HardState // 持久状态（Term/Vote/Commit）
    Entries         []raftpb.Entry   // 需要持久化到 WAL 的新 Entry
    Snapshot        raftpb.Snapshot  // 需要保存的快照（如果有）
    CommittedEntries []raftpb.Entry  // 已提交、需要应用到状态机的 Entry
    Messages        []raftpb.Message // 需要发送给其他节点的消息
}
```

etcd server 收到 `Ready` 后：
1. 将 `Entries` 写入 WAL（持久化）；
2. 将 `Messages` 通过 gRPC 发送给其他节点；
3. 将 `CommittedEntries` 应用到 BoltDB（状态机）；
4. 调用 `raft.Advance()` 通知 Raft 库 Ready 已处理，继续推进。

这种设计将 Raft 状态机计算与 I/O 完全解耦，使得 `etcd/raft` 库可以方便地做单元测试（无需真实网络和磁盘），也使 etcd server 对 I/O 有完全的控制权（可以批量写 WAL、批量发送消息）。

### 6.2 批量与流水线优化

etcd 在 Raft 之上做了多项性能优化：

**批量写入（Batching）：** 多个客户端请求可以被打包成一个 `AppendEntries` RPC，一次网络往返完成多条 Entry 的复制，减少网络 RTT 的开销。

**流水线（Pipelining）：** 不等待前一条 `AppendEntries` 的响应，Leader 就继续发送后续的 Entry（类似 TCP 的滑动窗口）。只要 Follower 的 WAL 速度跟得上，Leader 可以连续发送多个批次，大幅提升吞吐量。

**异步 WAL 刷盘（fsync 聚合）：** etcd 将多个 WAL Entry 批量 fsync，而不是每个 Entry 单独 fsync，减少磁盘 I/O 次数。这在 SSD 上效果显著（SSD 的 fsync 延迟虽然低，但仍然是限制因素）。

---

## 小结

本文深入剖析了 Raft 共识协议的三个核心子问题：

- **Leader 选举**：随机超时（150ms~300ms）错开节点的超时时机，避免选举活锁；投票条件 3（日志完整性检查）确保只有数据最完整的节点才能当选，是安全性的前提；
- **日志复制**：`prevLogIndex/prevLogTerm` 一致性检查确保 Follower 日志是 Leader 的连续前缀；冲突的未提交 Entry 通过回溯 `nextIndex` 修复；`leaderCommit` 机制让 Follower 的 commitIndex 最终跟上 Leader；
- **安全性**：Leader 完整性属性（已提交日志永不丢失）通过选举条件 3 和 quorum 交集来保证；新 Leader 不直接提交旧 Term 的 Entry，而是通过 no-op Entry 隐式提交，这是一个微妙但关键的细节；
- **成员变更**：Joint Consensus 两阶段方案保证扩缩容时不出现双 Leader；etcd 使用单步变更简化实现。

下一篇文章将深入 etcd 的存储引擎——BoltDB 的 B+ 树存储结构、WAL 的格式与恢复流程，以及 Compaction（历史版本清理）的触发机制与碎片整理（Defragmentation）。

---

> [!note] 思考题
> 1. Raft 的 Leader 选举使用随机化的选举超时——Follower 在超时后成为 Candidate 并发起投票。随机超时避免了多个 Follower 同时发起选举导致的'选票分裂'。如果集群中 3 个节点的选举超时都设为相同值（如 1000ms），选票分裂的概率有多高？Raft 论文中推荐的超时范围是什么？
> 2. Raft 的日志复制要求 Leader 将日志条目复制到多数节点后才能提交（commit）。如果一个 Follower 长时间离线后重新加入，它需要从 Leader 获取所有缺失的日志条目。如果缺失的日志量很大（如 GB 级），这个'追赶'过程会消耗大量网络带宽。etcd 的 Snapshot 机制如何加速这个过程？
> 3. Raft 保证了线性一致性（Linearizability）——读操作能看到最新的已提交写入。但默认的 Raft 读操作需要经过 Leader 确认——增加了读延迟。etcd 的 `--read-only` 选项支持 Serializable 读（从任意节点读取，可能读到旧数据）。在什么场景下 Serializable 读是可接受的？Kubernetes 的 Watch 机制依赖线性一致性吗？
