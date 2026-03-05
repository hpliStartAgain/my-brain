---
title: "03 存储引擎——BoltDB、WAL 与 Compaction"
date: 2026-03-04
tags: [etcd, BoltDB, WAL, Compaction, Defragmentation, B+树, MVCC, 持久化, 碎片整理]
aliases: []
---

# 03 存储引擎——BoltDB、WAL 与 Compaction

## 摘要

etcd 的数据持久化由两套机制协同完成：**WAL（Write-Ahead Log）** 保证了 Raft 日志的持久性（节点崩溃后能重放恢复 Raft 状态），**BoltDB** 存储了应用到状态机后的最终数据（MVCC 多版本键值对）。但 MVCC 保留历史版本会导致数据库持续增长，Compaction（压缩）负责清理过期版本，而 Defragmentation（碎片整理）则负责将 BoltDB 文件中的"空洞"回收。本文深入剖析这三个机制的内部原理，并重点解释 etcd 在生产中最常见的问题：数据库超出 Quota 限制导致集群进入只读状态的根因与处理方法。

---

## 第 1 章 WAL：Raft 日志的磁盘保证

### 1.1 WAL 的位置与作用

WAL（Write-Ahead Log，预写日志）存储在 etcd 的 `--wal-dir` 目录（默认与 `--data-dir` 相同，位于 `{data-dir}/member/wal/`）。

WAL 的核心作用是**持久化 Raft 的 HardState 和 Log Entries**：

- **HardState**：必须持久化的 Raft 状态，包括 `term`（当前任期）、`vote`（当前 Term 投票给了谁）、`commit`（最新提交的 Entry 索引）。节点重启后，必须从持久化的 HardState 恢复这三个值，否则可能违反 Raft 的安全保证（如忘记已投票记录，在同一 Term 内投两次票）；
- **Log Entries**：所有尚未被快照覆盖的 Raft 日志条目，用于在重启时重放，将状态恢复到崩溃前的水平。

### 1.2 WAL 文件的格式

WAL 目录下存储多个文件，文件名格式为 `{seq}-{initialIndex}.wal`，例如：

```
0000000000000000-0000000000000000.wal  ← 第一个 WAL 文件
0000000000000001-0000000000001000.wal  ← 第二个（从 Entry Index 1000 开始）
0000000000000002-0000000000002000.wal
```

每个 WAL 文件默认大小为 **64MB**（与 ZooKeeper 的事务日志预分配机制类似，预分配磁盘空间减少元数据更新开销）。

**WAL 文件内部结构（Record 序列）：**

每个 Record 由以下部分组成：
```
┌──────────────────┬────────────────────────────┐
│  CRC32 校验和    │       Record 类型            │
│    4 字节        │          1 字节              │
├──────────────────┴────────────────────────────┤
│              Record 数据（Protobuf）            │
│  类型 1: metadata（节点 ID、集群 ID）           │
│  类型 2: HardState（term/vote/commit）         │
│  类型 3: Entry（Raft 日志条目）                │
│  类型 4: SnapshotMetadata（快照位置标记）       │
└──────────────────────────────────────────────┘
```

每次写入 WAL 后，etcd 调用 `fdatasync`（只刷数据，不刷 inode 元数据，比 `fsync` 略快）确保数据落盘，才向 `etcd/raft` 库报告写入成功，Raft 才继续推进。

### 1.3 WAL 的重放恢复

节点重启时，WAL 的恢复流程：

```
1. 找到最新的快照文件（{data-dir}/member/snap/*.snap）
   读取快照的 Metadata：记录了快照时刻的 Index 和 Term

2. 扫描 WAL 目录，找到快照 Index 之后的所有 WAL 文件

3. 逐条读取 WAL Records：
   - 恢复 HardState（term/vote/commit）
   - 重建快照 Index 之后的所有 Log Entries

4. 将快照加载到状态机（BoltDB），重置 MVCC 状态

5. 将快照之后的所有已提交 Entry 重新应用到状态机
   （apply commitIndex 以下且在快照之后的所有 Entry）

6. 恢复完成，节点重新加入集群
```

**为什么有了 BoltDB 还需要 WAL 重放？**

BoltDB 存储的是**已应用到状态机的数据**（`appliedIndex` 之前的数据），而 WAL 包含了**已提交但可能尚未应用**（`commitIndex > appliedIndex`）的 Entry。重启时，BoltDB 的状态可能落后于 `commitIndex`，需要重放 WAL 中未应用的 Entry 来追上。

此外，WAL 中还记录了 Raft 的 HardState（特别是 `term` 和 `vote`），这是 BoltDB 中没有的，必须从 WAL 恢复。

---

## 第 2 章 BoltDB：嵌入式 B+ 树存储引擎

### 2.1 BoltDB 是什么

BoltDB 是一个纯 Go 语言编写的嵌入式键值数据库，基于 **B+ 树**存储，特点：
- **ACID 事务**：支持读写事务和只读事务，多个读事务可以并发执行，写事务是排他的（同一时刻只有一个写事务）；
- **零外部依赖**：无守护进程，直接内嵌在应用程序中（类似 SQLite）；
- **mmap 内存映射**：BoltDB 通过 `mmap` 将数据库文件映射到进程地址空间，读操作直接通过内存指针访问（OS 页缓存层面），无需用户空间复制；
- **写时复制（Copy-on-Write B+ 树）**：写操作不修改原始页，而是复制路径上的所有页并修改副本，保证旧读事务看到一致性快照（类似 MVCC，但在页级别）。

### 2.2 etcd 使用 BoltDB 的数据组织

etcd 在 BoltDB 中创建了几个主要的 Bucket（类似关系型数据库的表）：

**`key` Bucket（核心数据存储）：**

存储所有的键值对，key 是 `{main_revision}_{sub_revision}` 的编码（8+8字节的大端整数），value 是 `mvccpb.KeyValue` 的 Protobuf 序列化：

```
key = encode(revision{main: 100, sub: 0}) → 8字节 big-endian
value = proto.Marshal(KeyValue{
    Key:            "/config/database.url",
    Value:          "jdbc:mysql://...",
    CreateRevision: 50,
    ModRevision:    100,
    Version:        3,
    Lease:          0,
})
```

BoltDB 的 key 按字节序排列，由于 Revision 使用大端整数编码，数字越大的 Revision 在 BoltDB 中越靠后——范围扫描（如 Compaction 需要删除 Revision < N 的所有 Entry）可以高效完成。

**`meta` Bucket：**

存储 etcd 的元数据：
- `consistent_index`：最后一次应用到状态机的 Raft Entry Index（用于重启时的幂等性保证）；
- `term`：当前 Term（备份，WAL 也有）；
- `confState`：当前集群成员配置。

**`lease` Bucket：**

存储所有活跃的 Lease（TTL 租约），key 是 Lease ID，value 是租约的过期时间和关联的 key 列表（见第 4 篇）。

**`alarm` Bucket：**

存储 etcd 的告警状态（如 NOSPACE 告警，当数据库超出 Quota 时设置）。

### 2.3 BoltDB 的写事务与 fsync

etcd 在每次 apply Raft Entry 时，执行一个 BoltDB 写事务（`batch` 模式，将多个 Entry 合并到一个事务提交）：

```go
// 简化的 apply 流程
func (s *store) applyEntries(entries []raftpb.Entry) {
    txn := s.backend.BatchTx()   // 获取批量写事务
    txn.Lock()
    defer txn.Unlock()
    
    for _, entry := range entries {
        // 解析 entry，执行对应的 put/delete/txn 操作
        s.applyEntry(txn, entry)
    }
    
    // 提交事务（此时数据写入 BoltDB 的内存 B+ 树）
    txn.Commit()  
    // BoltDB 在 Commit 时调用 fsync，确保数据页落盘
}
```

BoltDB 的 `Commit()` 会调用 `fsync`，确保修改的数据页从 OS 页缓存刷入磁盘。这是 etcd 写入延迟的另一个重要来源（除了 WAL 的 `fdatasync`）。

> [!warning] 生产避坑
> etcd 的 `--data-dir` 和 `--wal-dir` 应该使用**专用的 NVMe SSD**，且与 OS 系统盘、Kubernetes 的 `kubelet` 数据目录分开。BoltDB 和 WAL 都有高频 fsync 需求，共享磁盘 I/O 会导致 fsync 延迟增大，进而触发 Raft 心跳超时和 Leader 重选举。CoreOS/Red Hat 的生产推荐：etcd 使用独立 NVMe SSD，fsync 延迟应 < 10ms，否则集群不稳定。

---

## 第 3 章 Compaction：历史版本的清理

### 3.1 为什么需要 Compaction

MVCC 保留了每个 key 的所有历史版本。如果不清理，etcd 的数据库会无限增长，最终耗尽磁盘空间：

**Kubernetes 场景下的数据增长估算：**

假设集群有 1000 个 Pod，每分钟每个 Pod 的状态（readiness、phase 等）更新 2 次：
- 每分钟写入量：1000 × 2 = 2000 次写入；
- 每次写入约 5KB（Pod Protobuf 序列化）；
- 每分钟数据增长：2000 × 5KB = 10MB；
- 每天数据增长：10MB × 60min × 24h = 14.4GB。

没有 Compaction，一天就会撑爆 etcd（默认 Quota 只有 2GB）。

### 3.2 Compaction 的工作机制

Compaction 以 **Revision** 为单位进行清理：执行 `Compact(rev)` 后，所有 Revision < rev 的历史版本（即在 rev 之前被修改过的旧版本）都会被删除，只保留每个 key 在 rev 时刻的最新值。

**Compaction 的执行步骤：**

```
1. 确定 Compact Revision（crev）

2. 遍历 treeIndex（内存 B-Tree），对每个 key：
   - 找出该 key 在 crev 之前的所有历史 Revision
   - 从 treeIndex 中删除这些旧 Revision 记录
   - 如果某个 generation 在 crev 之前已经完整结束（即 key 被删除过），删除整个 generation

3. 在 BoltDB 的 `key` Bucket 中，删除所有 Revision < crev 的 Entry
   （使用 BoltDB 的 cursor 范围删除：delete all keys < encode(crev)）

4. 更新 BoltDB 的 `meta` Bucket，记录已 Compact 到的 Revision
```

**Compaction 的并发安全：** Compaction 在单独的 goroutine 中执行，通过 BoltDB 事务隔离，不影响正在进行的读写操作。

### 3.3 Compaction 的触发策略

etcd 支持两种自动 Compaction 策略（通过 `--auto-compaction-mode` 配置）：

**按时间（periodic，默认）：**

```bash
etcd --auto-compaction-mode=periodic --auto-compaction-retention=1h
```

每隔一定时间（默认与 `retention` 相同，最长每小时），保留最近 1 小时内的历史版本，清理更早的版本。实现上，etcd 记录 1 小时前的 Revision（通过定期采样），然后对该 Revision 执行 Compaction。

**按版本数（revision）：**

```bash
etcd --auto-compaction-mode=revision --auto-compaction-retention=10000
```

始终保留最近 10000 个 Revision 的历史（即当前 Revision - 10000 之前的都清理），适合对历史 Revision 数量有明确要求的场景。

**Kubernetes 的推荐配置：**

```bash
etcd --auto-compaction-mode=periodic --auto-compaction-retention=8h
```

保留 8 小时的历史版本。这个时间窗口足够 Kubernetes Controller Manager 在故障恢复后重新 List-Watch 并同步状态，同时避免数据库无限增长。

---

## 第 4 章 Defragmentation：数据库碎片整理

### 4.1 为什么需要碎片整理

Compaction 虽然从逻辑上删除了旧版本的数据，但**并不立即释放磁盘空间**。

原因：BoltDB 的 B+ 树使用**固定大小的页（4KB，与 OS 页对齐）**管理数据。当 Compaction 删除旧版本的 Entry 后，对应的 B+ 树页上会有空洞——但这些页不会从文件中删除，而是加入 BoltDB 内部的**空闲页列表（freelist）**，等待下次写入时复用。

结果：BoltDB 数据库文件（`{data-dir}/member/snap/db`）的大小不会因为 Compaction 而缩小，只是内部有很多空闲页。如果大量数据被 Compaction 清理，文件可能有 50%~80% 是空洞，磁盘空间并未释放。

**Defragmentation（碎片整理）** 通过创建一个新的 BoltDB 文件，将现有数据重新紧凑地写入，消除空洞，真正释放磁盘空间。

### 4.2 Defragmentation 的过程

```bash
etcdctl defrag --endpoints=https://127.0.0.1:2379
```

执行 Defragmentation 时，etcd 会：

1. 创建一个临时的新 BoltDB 文件；
2. 开启一个只读事务，遍历原 BoltDB 的所有 Bucket，将所有数据写入新文件（相当于全量重写）；
3. 用新文件替换旧文件；
4. 重新打开数据库，继续服务。

**Defragmentation 期间的影响：**

Defragmentation 是**阻塞操作**——执行期间，该 etcd 节点对外停止提供写服务（因为 BoltDB 的写事务被阻塞）。在 3 节点集群中，对一个节点执行 Defragmentation 不影响集群可用性（另外两个节点可以形成 quorum），但该节点在 Defragmentation 期间是不可写的。

**生产操作建议：**

```
1. 逐一对每个节点执行 Defragmentation（不要同时对所有节点操作）
2. 先对 Follower 执行，最后对 Leader 执行
   （对 Leader 执行时会触发 Leader 转移，避免 Leader 长时间不可写）
3. 在业务低峰期执行（如夜间）
4. 执行前先检查磁盘空间，确保有足够空间存放临时文件（需要约 2 倍当前数据库大小的空间）
```

---

## 第 5 章 etcd Quota 与 NOSPACE 告警

### 5.1 Backend Quota：数据库大小限制

etcd 的 `--quota-backend-bytes` 参数（默认 **2GB**，最大 8GB）限制了 BoltDB 数据库文件的最大大小。

当 BoltDB 文件大小超过 Quota 时：
1. etcd 设置 **NOSPACE 告警**（通过 `alarm` Bucket 存储，持久化到 BoltDB）；
2. 集群进入**只读（read-only）状态**——拒绝所有写请求（`PUT/DELETE/TXN` 返回 `mvcc: database space exceeded`）；
3. 只读状态持续，直到告警被手动清除。

### 5.2 生产中最常见的 etcd 故障

**现象：** etcd 集群突然拒绝所有写操作，Kubernetes 无法创建新 Pod，`kubectl apply` 返回错误。

**根因链路：**

```
Compaction 不及时（未配置 auto-compaction）
  ↓
历史版本大量积累
  ↓
BoltDB 文件持续增大
  ↓
超出 Quota（默认 2GB）
  ↓
etcd 设置 NOSPACE 告警，进入只读状态
  ↓
Kubernetes API Server 无法写入 etcd
  ↓
集群无法创建/更新/删除任何资源
```

### 5.3 NOSPACE 的恢复步骤

```bash
# 步骤 1：确认 NOSPACE 告警存在
etcdctl alarm list

# 步骤 2：手动执行 Compaction（清理历史版本）
# 获取当前最新 Revision
ETCDCTL_API=3 etcdctl endpoint status -w json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])"

# 对最新 Revision 执行 Compaction
ETCDCTL_API=3 etcdctl compact ${REVISION}

# 步骤 3：执行 Defragmentation（释放磁盘空间）
etcdctl defrag --endpoints=https://node1:2379
etcdctl defrag --endpoints=https://node2:2379
etcdctl defrag --endpoints=https://node3:2379

# 步骤 4：清除 NOSPACE 告警
etcdctl alarm disarm

# 步骤 5：验证集群恢复
etcdctl endpoint health
```

**预防措施：**

1. 始终配置 `--auto-compaction-mode` 和 `--auto-compaction-retention`；
2. 监控 BoltDB 大小（`etcd_mvcc_db_total_size_in_bytes` Prometheus 指标），在达到 Quota 的 80% 时告警；
3. 定期（如每周）检查并执行 Defragmentation，保持数据库文件紧凑；
4. 根据业务实际数据量评估是否需要增大 Quota：`--quota-backend-bytes=8589934592`（8GB）。

---

## 第 6 章 快照机制：WAL + BoltDB 的全量备份

### 6.1 快照的作用

快照（Snapshot）是 etcd 数据的全量备份点，主要用于两个场景：

**场景一：新节点加入集群的初始同步**

当一个新节点（或宕机时间较长、WAL 已被截断的节点）加入集群时，Leader 需要将完整的数据发送给新节点。如果没有快照，Leader 需要重放所有历史 WAL（可能是数万~百万条 Entry），既耗时又对 Leader 有压力。有了快照，Leader 只需：
1. 发送最新快照（BoltDB 文件的序列化）；
2. 发送快照之后的少量 WAL Entry（增量同步）。

**场景二：加速节点重启恢复**

节点重启时，WAL 可能很长。有了快照，只需加载快照（恢复到快照时刻的完整状态），再重放快照之后的少量 WAL，大幅缩短恢复时间。

### 6.2 快照的触发与存储

etcd 的 Raft 实现在 `--snapshot-count`（默认 100,000）个 Entry 被应用到状态机后，自动触发一次快照。

快照存储在 `{data-dir}/member/snap/` 目录，文件名格式为 `{term}-{index}.snap`。快照文件本质上是对当前 BoltDB 数据库文件（`{data-dir}/member/snap/db`）的硬链接或直接引用（etcd 3.x 使用 BoltDB 的 `WriteTo` 方法将当前数据库状态写入快照文件）。

### 6.3 etcdctl snapshot 命令：手动备份与恢复

```bash
# 备份：保存当前节点的快照到文件
etcdctl snapshot save /backup/etcd-snapshot-$(date +%Y%m%d).db

# 验证快照完整性
etcdctl snapshot status /backup/etcd-snapshot-20260304.db

# 恢复：从快照恢复（通常在集群完全损坏时使用）
etcdctl snapshot restore /backup/etcd-snapshot-20260304.db \
  --name node1 \
  --initial-cluster "node1=https://node1:2380,node2=https://node2:2380,node3=https://node3:2380" \
  --initial-advertise-peer-urls https://node1:2380 \
  --data-dir /new-data-dir
```

快照恢复的本质是：用备份的 BoltDB 数据初始化一个全新的 etcd 数据目录（包括新的 WAL 和快照文件），然后重新组建集群（所有节点都从同一个快照恢复）。

---

## 小结

本文深入剖析了 etcd 存储层的三大机制：

- **WAL**：所有 Raft HardState 和 Log Entry 在应用到 BoltDB 之前先写 WAL（`fdatasync`），保证节点崩溃后可以重放恢复；WAL 文件 64MB 一滚动，通过快照截断，防止无限增长；
- **BoltDB**：嵌入式 B+ Tree 存储，mmap 读取，写时复制事务隔离；以 `{Revision}` 为 key 存储所有 MVCC 版本数据；Commit 时 `fsync` 确保持久性；
- **Compaction**：清理旧历史版本的逻辑数据（`treeIndex` 和 BoltDB Key 删除），但不释放磁盘空间；**必须配置 `auto-compaction`** 防止数据库无限增长；
- **Defragmentation**：重写 BoltDB 文件消除碎片空洞，真正释放磁盘空间；阻塞操作，应在业务低峰期对节点逐一执行；
- **Quota / NOSPACE**：Compaction 不及时导致数据库超出 Quota（默认 2GB），集群进入只读状态，是最常见的 etcd 故障；恢复需要 Compact + Defrag + alarm disarm 三步。

下一篇文章将深入 etcd 的 Watch 机制（基于 Revision 的持久化事件流，与 ZooKeeper Watcher 的本质差异）和 Lease TTL 机制（服务发现与分布式锁的基础设施）。
