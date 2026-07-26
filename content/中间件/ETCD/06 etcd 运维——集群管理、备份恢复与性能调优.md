---
title: "06 etcd 运维——集群管理、备份恢复与性能调优"
date: 2026-03-05
tags: [etcd, Kubernetes, SRE, 备份恢复, 性能调优, 监控, 运维, 集群管理]
aliases: []
---

# 06 etcd 运维——集群管理、备份恢复与性能调优

## 摘要

etcd 是 [[Kubernetes]] 集群的"大脑"——所有集群状态都存储在 etcd 中，一旦 etcd 发生故障或数据损坏，整个 Kubernetes 集群将陷入瘫痪。本文从 SRE 视角出发，系统梳理 etcd 的运维体系：集群成员管理（在线扩缩容与替换故障节点）、Prometheus 监控体系（关键指标解读与告警阈值）、备份恢复的标准操作流程（snapshot save/restore），以及针对磁盘 IO、网络、JVM 的性能调优。特别关注生产中的真实故障模式及其处理 SOP。

---

## 第 1 章 etcd 集群的基本运维原则

### 1.1 为什么 etcd 的运维比普通服务更关键

对于大多数无状态服务，运维的复杂度集中在扩缩容和发布上——出了问题，回滚或重启即可。但 etcd 是**有状态的共识服务**，它的运维有三个特殊性：

**第一，etcd 是 Kubernetes 的单点**（逻辑上）。Kubernetes 的 API Server、Controller Manager、Scheduler 都是无状态的，可以随意重启，但它们的所有状态都持久化在 etcd 中。etcd 节点宕机超过法定人数（quorum），整个 Kubernetes 集群立即进入只读模式——所有 Pod 创建、删除、Service 变更全部失败。这不同于数据库宕机导致业务报错，而是直接导致基础设施瘫痪。

**第二，etcd 对磁盘延迟极为敏感**。etcd 的 WAL（Write-Ahead Log）在每次写入时都要 `fdatasync`，确保数据落盘后才返回成功。如果磁盘 IOPS 不足或存在 IO 抖动，WAL fsync 延迟升高，Leader 心跳超时，集群可能频繁触发不必要的 Leader 选举，导致服务中断。这是 etcd 生产问题中最常见的根因之一。

**第三，etcd 的数据恢复不是简单的重启**。如果 etcd 的数据目录损坏或全部节点同时宕机，需要从 snapshot 恢复，整个流程有严格的操作顺序，操作错误可能导致脑裂或数据不一致。

基于这三个特殊性，etcd 的运维需要比普通服务更高的规范性：

- 所有变更操作前必须确认集群健康状态
- 定期（至少每小时）自动备份 snapshot
- 磁盘选型必须使用 SSD，建议 IOPS ≥ 3000，P99 延迟 < 10ms
- 集群成员变更必须一次只操作一个节点，严禁批量变更

> [!warning] 生产避坑：永远不要在集群不健康时做成员变更
> 如果集群当前只有 2/3 节点存活（已经处于 quorum 边缘），在这时添加新节点或移除旧节点都极其危险。添加新成员会暂时导致集群的 quorum 要求变化，可能在同步期间丧失 quorum 导致集群不可用。正确做法：先确认 3 个节点都健康，再做任何成员变更。

### 1.2 etcd 集群的数量选择

etcd 推荐奇数节点部署，通常选择 3 或 5 节点：

| 节点数 | 容忍故障数 | quorum 要求 | 适用场景 |
| :---: | :---: | :---: | :--- |
| 1 | 0 | 1 | 仅开发测试，绝不用于生产 |
| 3 | 1 | 2 | 生产环境标准配置 |
| 5 | 2 | 3 | 高可用要求严格的生产环境 |
| 7 | 3 | 4 | 极少使用，写性能代价过高 |

为什么奇数？偶数节点（如 4 节点）相比少一个节点（3 节点）并不能提升容错能力——4 节点需要 3 节点的 quorum，和 3 节点集群同样只能容忍 1 个故障，但写请求需要等待更多节点确认，性能反而更低。

**选择 5 节点而非 3 节点的理由**：在生产环境中，如果你需要做滚动升级或硬件替换，3 节点集群在维护期间只有 2 个可用节点——这时如果再有一个节点意外宕机，集群立即不可用。5 节点集群在维护 1 个节点时仍有 4 个节点在运行，容错窗口更宽。

对于 [[Kubernetes]] 大规模生产集群（1000+ 节点），建议使用 5 节点 etcd 集群，并将 etcd 部署在专用的高性能 SSD 机器上，与 Kubernetes worker 节点物理隔离。

---

## 第 2 章 集群健康检查

在任何运维操作之前，都应当先确认集群处于健康状态。

### 2.1 endpoint 健康检查

```bash
# 检查所有 etcd 成员的健康状态
etcdctl endpoint health \
  --endpoints=https://etcd-0:2379,https://etcd-1:2379,https://etcd-2:2379 \
  --cacert=/etc/etcd/ca.crt \
  --cert=/etc/etcd/etcd.crt \
  --key=/etc/etcd/etcd.key

# 预期输出（健康状态）：
# https://etcd-0:2379 is healthy: successfully committed proposal: took = 3.2ms
# https://etcd-1:2379 is healthy: successfully committed proposal: took = 4.1ms
# https://etcd-2:2379 is healthy: successfully committed proposal: took = 3.8ms
```

`endpoint health` 实际上向每个成员发起一个写请求（提交一个 Proposal），通过提交延迟来判断健康状态。这比简单的 TCP 连通性检查更可靠——一个节点可能 TCP 可达，但 Raft 日志复制已经落后很多。

### 2.2 endpoint 状态检查

```bash
# 查看各节点的详细状态（包含 Leader 信息和数据库大小）
etcdctl endpoint status \
  --endpoints=https://etcd-0:2379,https://etcd-1:2379,https://etcd-2:2379 \
  --cacert=... --cert=... --key=... \
  -w table

# 输出示例：
# ENDPOINT              ID              IS LEADER  IS LEARNER  RAFT TERM  RAFT INDEX  RAFT APPLIED INDEX  DB SIZE    
# https://etcd-0:2379   8e9e05c52164694d  true       false       5          1234567     1234567             512 MB
# https://etcd-1:2379   3cb3d7e9f8a07e43  false      false       5          1234567     1234567             512 MB
# https://etcd-2:2379   a1c3ab123d4e89b2  false      false       5          1234566     1234566             512 MB
```

关键字段解读：
- **IS LEADER**：确认当前 Leader 是哪个节点
- **RAFT TERM**：任期号，如果某个节点的 Term 明显落后，说明它可能发生过 Leader 选举而未及时感知
- **RAFT INDEX vs RAFT APPLIED INDEX**：如果 `RAFT INDEX` 远大于 `RAFT APPLIED INDEX`，说明该节点的日志提交了但还没有 apply 到状态机，可能存在写入积压
- **DB SIZE**：数据库大小，应当监控此指标，接近 quota 限制时需要 Compaction

### 2.3 成员列表检查

```bash
# 查看集群所有成员
etcdctl member list \
  --endpoints=https://etcd-0:2379 \
  --cacert=... --cert=... --key=... \
  -w table

# 输出示例：
# ID                    STATUS    NAME    PEER ADDRS                    CLIENT ADDRS                IS LEARNER
# 3cb3d7e9f8a07e43  started   etcd-1  https://etcd-1:2380  https://etcd-1:2379   false
# 8e9e05c52164694d  started   etcd-0  https://etcd-0:2380  https://etcd-0:2379   false
# a1c3ab123d4e89b2  started   etcd-2  https://etcd-2:2380  https://etcd-2:2379   false
```

STATUS 字段：
- `started`：节点正常运行
- `unstarted`：节点已加入集群但尚未启动（新加入的节点在数据同步完成前可能处于此状态）

---

## 第 3 章 集群成员管理

### 3.1 替换故障节点（最常见的运维场景）

这是 etcd 运维中最高频的场景：某个节点的磁盘损坏或机器宕机无法恢复，需要用新机器替换。

**前提条件**：集群当前仍然有 quorum（3 节点集群中还有 2 个节点存活）。

**操作步骤**：

**Step 1：确认集群健康，确认故障节点的 Member ID**

```bash
etcdctl member list --endpoints=https://etcd-0:2379 ...
# 找到故障节点（STATUS 可能是 started 但实际已断开，或直接显示不健康）
# 假设故障节点的 Member ID 是 a1c3ab123d4e89b2
```

**Step 2：从集群中移除故障节点**

```bash
etcdctl member remove a1c3ab123d4e89b2 \
  --endpoints=https://etcd-0:2379 ...

# 此时集群成员变为 2 个，quorum 要求从 2 降为 2（3 节点→2 节点）
# 注意：2 节点集群 quorum=2，此时如果再有一个节点故障，集群不可用
# 务必尽快完成新节点加入
```

**Step 3：在新机器上准备 etcd（清空数据目录）**

```bash
# 在新节点（etcd-2-new）上
rm -rf /var/lib/etcd/  # 清空数据目录
mkdir -p /var/lib/etcd/
```

**Step 4：将新节点注册到集群（状态为 unstarted）**

```bash
etcdctl member add etcd-2-new \
  --peer-urls=https://etcd-2-new:2380 \
  --endpoints=https://etcd-0:2379 ...

# 输出会包含新成员的 ID 和初始集群信息，务必记录：
# ETCD_NAME="etcd-2-new"
# ETCD_INITIAL_CLUSTER="etcd-0=https://etcd-0:2380,etcd-1=https://etcd-1:2380,etcd-2-new=https://etcd-2-new:2380"
# ETCD_INITIAL_CLUSTER_STATE="existing"
```

**Step 5：启动新节点（使用 existing 状态）**

```bash
# 关键：ETCD_INITIAL_CLUSTER_STATE 必须设为 "existing"，而非 "new"
# 这告知新节点它是加入已有集群，而非创建新集群
etcd \
  --name etcd-2-new \
  --data-dir /var/lib/etcd \
  --initial-cluster-state existing \
  --initial-cluster "etcd-0=https://etcd-0:2380,etcd-1=https://etcd-1:2380,etcd-2-new=https://etcd-2-new:2380" \
  --initial-advertise-peer-urls https://etcd-2-new:2380 \
  --listen-peer-urls https://0.0.0.0:2380 \
  --advertise-client-urls https://etcd-2-new:2379 \
  --listen-client-urls https://0.0.0.0:2379 \
  ...（TLS 证书参数）
```

新节点启动后，会从 Leader 同步全量快照（snapshot），然后追赶增量日志，最终追上集群进度。在同步期间，集群仍然正常工作（2 个节点已经满足 quorum）。

> [!warning] 生产避坑：INITIAL_CLUSTER_STATE 的致命错误
> 如果将 `ETCD_INITIAL_CLUSTER_STATE` 设为 `new`，etcd 会认为自己是在创建一个全新集群，并拒绝连接到现有集群的其他节点，或者更危险的——它可能以一个"自认为是新集群"的状态启动，形成脑裂。
> 只有当你在初始化一个**全新的 etcd 集群**时，才使用 `INITIAL_CLUSTER_STATE=new`。替换故障节点、向已有集群加节点，都必须使用 `existing`。

### 3.2 新增节点（扩大集群规模）

将 3 节点集群扩展为 5 节点。操作与替换故障节点类似，区别在于不需要先执行 `member remove`。

**注意事项**：
- 每次只添加一个节点，等新节点完全同步后再添加下一个
- 添加节点后，quorum 要求变化：3→4 节点时，quorum 从 2 变为 3，此时若有任一节点故障，集群不可用。因此应当尽快将第 5 个节点也加入
- 建议在业务低峰期执行，因为新节点的快照同步会给 Leader 带来额外的网络和 IO 压力

### 3.3 Learner 节点（etcd 3.4+ 新特性）

当集群需要在多个数据中心部署跨地域成员，或者需要为新节点预热数据时，可以使用 **Learner** 节点。

Learner 节点的特点：
- 接收 Leader 的日志复制，保持数据同步
- **不参与投票**，不计入 quorum
- 不能成为 Leader

这意味着 Learner 节点的加入**不影响集群的 quorum 要求和写入性能**，新节点可以在 Learner 状态下先完成数据同步，再晋升为正式 Voting Member。

```bash
# 以 Learner 状态添加新节点
etcdctl member add etcd-learner \
  --peer-urls=https://etcd-learner:2380 \
  --learner \
  --endpoints=https://etcd-0:2379 ...

# 等数据同步完成后，晋升为正式成员
etcdctl member promote <learner-member-id> \
  --endpoints=https://etcd-0:2379 ...
```

---

## 第 4 章 备份与恢复

### 4.1 为什么快照备份是 etcd 运维的生命线

etcd 使用 [[03 存储引擎——BoltDB、WAL 与 Compaction|BoltDB]] 存储状态，WAL 记录增量日志。在以下灾难性场景中，仅靠 etcd 自身的复制机制无法恢复：

- **所有节点同时宕机**：如机房断电、误操作删除全部数据目录
- **数据目录损坏**：磁盘坏道、文件系统损坏导致 BoltDB 文件无法打开
- **误操作删除关键数据**：`etcdctl del --prefix /` 这种灾难性命令

对于 Kubernetes 集群，etcd 数据丢失意味着所有 Pod、Service、ConfigMap、Secret 的配置信息全部丢失，Kubernetes 集群彻底无法使用（虽然正在运行的容器进程本身不受影响，但 Kubernetes 无法管理它们了）。

**备份策略建议**：

- **频率**：每小时一次自动备份（对于写入频繁的大集群，可每 30 分钟一次）
- **保留**：保留最近 24 小时的小时级备份 + 最近 7 天的天级备份
- **存储**：备份文件上传到对象存储（S3/MinIO/COS），与 etcd 集群物理隔离
- **验证**：定期（每周）进行恢复演练，确认备份文件可用

### 4.2 制作快照备份

```bash
# 制作快照（需要指向 Leader 节点，或使用 --endpoints 指定所有节点让客户端自动找 Leader）
etcdctl snapshot save /backup/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db \
  --endpoints=https://etcd-0:2379 \
  --cacert=/etc/etcd/ca.crt \
  --cert=/etc/etcd/etcd.crt \
  --key=/etc/etcd/etcd.key

# 验证快照完整性
etcdctl snapshot status /backup/etcd-snapshot-20260305-120000.db -w table
# 输出示例：
# HASH         REVISION  TOTAL KEYS  TOTAL SIZE
# 5b37f7e9     1234567   45678       512 MB
```

`snapshot save` 的实现原理：etcd Leader 会在内存中进行一次一致性快照（锁定当前 revision），将 BoltDB 的完整内容流式写入文件，不需要暂停服务，对集群性能影响极小。

**自动化备份脚本**（适用于 Kubernetes 环境，以 CronJob 形式运行）：

```bash
#!/bin/bash
# etcd-backup.sh
BACKUP_DIR="/backup"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_FILE="${BACKUP_DIR}/etcd-snapshot-${TIMESTAMP}.db"

# 1. 制作快照
etcdctl snapshot save "${SNAPSHOT_FILE}" \
  --endpoints="${ETCD_ENDPOINTS}" \
  --cacert="${ETCD_CA_CERT}" \
  --cert="${ETCD_CERT}" \
  --key="${ETCD_KEY}"

# 2. 验证快照
if ! etcdctl snapshot status "${SNAPSHOT_FILE}" &>/dev/null; then
  echo "ERROR: Snapshot verification failed!"
  exit 1
fi

# 3. 上传到对象存储（以 AWS S3 为例）
aws s3 cp "${SNAPSHOT_FILE}" "s3://my-etcd-backup/$(date +%Y%m%d)/"

# 4. 清理 7 天前的本地备份
find "${BACKUP_DIR}" -name "etcd-snapshot-*.db" -mtime +7 -delete

echo "Backup completed: ${SNAPSHOT_FILE}"
```

### 4.3 从快照恢复

从快照恢复是 etcd 中**操作风险最高**的场景，必须严格按照步骤执行。

**恢复场景**：3 节点集群全部宕机，数据目录损坏，需要从最近的快照恢复。

**Step 1：停止所有 etcd 节点（如果还在运行）**

```bash
# 在所有 etcd 节点上执行
systemctl stop etcd
# 或者 Kubernetes 中
kubectl delete pod etcd-0 etcd-1 etcd-2 -n kube-system
```

**Step 2：在每个节点上恢复快照**

```bash
# 在 etcd-0 上执行（每个节点的 --name 和 --initial-advertise-peer-urls 不同）
etcdctl snapshot restore /backup/etcd-snapshot-20260305-120000.db \
  --name etcd-0 \
  --initial-cluster "etcd-0=https://etcd-0:2380,etcd-1=https://etcd-1:2380,etcd-2=https://etcd-2:2380" \
  --initial-cluster-token etcd-cluster-restore-$(date +%s) \
  --initial-advertise-peer-urls https://etcd-0:2380 \
  --data-dir /var/lib/etcd-restore

# 在 etcd-1 上执行（--name 和 --initial-advertise-peer-urls 对应修改）
etcdctl snapshot restore /backup/etcd-snapshot-20260305-120000.db \
  --name etcd-1 \
  --initial-cluster "etcd-0=https://etcd-0:2380,etcd-1=https://etcd-1:2380,etcd-2=https://etcd-2:2380" \
  --initial-cluster-token etcd-cluster-restore-$(date +%s) \  # 与 etcd-0 使用完全相同的 token
  --initial-advertise-peer-urls https://etcd-1:2380 \
  --data-dir /var/lib/etcd-restore
```

> [!info] 核心概念：为什么恢复时要使用新的 cluster-token
> `--initial-cluster-token` 在恢复时应当使用一个新的唯一值（区别于原始集群的 token）。这是为了防止**恢复出的新集群**与**可能还在运行的旧集群节点**（如果存在）相互通信，导致脑裂。每个 etcd 节点在内部用 cluster-token 区分自己属于哪个集群，使用新 token 确保恢复出的集群与任何可能的旧节点完全隔离。

**Step 3：将恢复出的数据目录替换原始数据目录**

```bash
# 在每个节点上
mv /var/lib/etcd /var/lib/etcd-bak  # 备份（如有）原始损坏的数据目录
mv /var/lib/etcd-restore /var/lib/etcd
chown -R etcd:etcd /var/lib/etcd
```

**Step 4：启动所有 etcd 节点**

```bash
# 所有节点使用 INITIAL_CLUSTER_STATE=new 启动（因为是从快照重建的"新"集群）
systemctl start etcd

# 验证集群恢复成功
etcdctl endpoint health --endpoints=https://etcd-0:2379,https://etcd-1:2379,https://etcd-2:2379 ...
```

**Step 5：重启 Kubernetes 组件（如果是 Kubernetes etcd 恢复）**

```bash
# API Server、Controller Manager、Scheduler 需要重启以重新连接恢复后的 etcd
systemctl restart kube-apiserver kube-controller-manager kube-scheduler
```

> [!warning] 生产避坑：恢复后的数据丢失是正常的
> 从快照恢复意味着快照制作时间点之后的所有数据变更将丢失。对于 Kubernetes 集群，这意味着在备份时间点之后创建的 Pod、Service 等资源在恢复后将消失，但实际运行的容器进程仍然存在（只是 Kubernetes 不知道它们了）。
> 恢复后，Kubernetes 的 Controller 会检测到实际状态与期望状态的差异，会尝试按期望状态重建资源（可能会创建重复的 Pod 或删除"多余"的容器）。**恢复后必须立即对集群进行全面的状态核查**。

---

## 第 5 章 Prometheus 监控体系

### 5.1 etcd 的关键监控指标

etcd 原生支持 Prometheus 格式的 metrics，在 `https://etcd-host:2379/metrics` 端点暴露。以下是生产中最关键的监控指标：

**写入性能指标**

```
# WAL fsync 延迟（最关键的性能指标）
etcd_disk_wal_fsync_duration_seconds_bucket
# 应当保持：P99 < 10ms；超过 25ms 时告警，超过 100ms 时可能影响集群稳定性

# 后端 (BoltDB) commit 延迟
etcd_disk_backend_commit_duration_seconds_bucket
# 应当保持：P99 < 25ms

# 提案提交延迟（端到端写入延迟）
etcd_server_proposals_committed_total
etcd_server_proposals_applied_total
# proposals_committed - proposals_applied = 积压的未 apply 提案数，应接近 0
```

**集群健康指标**

```
# Leader 切换次数（应保持极低，频繁切换表明网络或磁盘有问题）
etcd_server_leader_changes_seen_total

# 提案失败次数
etcd_server_proposals_failed_total
# 有失败意味着有写入请求无法达成共识，需要立即排查

# 节点是否有 Leader（0 = 无 Leader，集群不可用）
etcd_server_has_leader
# 任何节点报告此值为 0 时必须立即告警
```

**存储指标**

```
# 数据库文件大小（关键！接近 quota 时需要 Compaction）
etcd_mvcc_db_total_size_in_bytes
# 默认 quota = 2GB，建议在 1.5GB (75%) 时告警

# 实际使用的数据库大小（排除 Compaction 后的碎片）
etcd_mvcc_db_total_size_in_use_in_bytes

# 当前 revision（全局写入版本号，可用于估算 Compaction 频率）
etcd_debugging_mvcc_current_revision
etcd_debugging_mvcc_compact_revision
```

**网络指标**

```
# gRPC 请求延迟
grpc_server_handling_seconds_bucket{grpc_service="etcdserverpb.KV"}
# Watch 流的活跃连接数
etcd_network_active_peers
```

### 5.2 告警规则（Prometheus Alertmanager）

```yaml
groups:
  - name: etcd
    rules:
      # etcd 集群无 Leader——最高级别告警
      - alert: EtcdNoLeader
        expr: etcd_server_has_leader == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd 集群无 Leader，Kubernetes 控制平面不可用"

      # etcd Leader 频繁切换——预警
      - alert: EtcdHighLeaderChanges
        expr: increase(etcd_server_leader_changes_seen_total[1h]) > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd Leader 在 1 小时内切换超过 3 次，可能存在磁盘 IO 问题"

      # WAL fsync 延迟过高
      - alert: EtcdHighFsyncDuration
        expr: histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.25
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd WAL fsync P99 延迟 > 250ms，磁盘 IO 可能存在竞争"

      # 数据库空间告警
      - alert: EtcdDatabaseSpaceNearQuota
        expr: etcd_mvcc_db_total_size_in_bytes / 2147483648 > 0.75
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd 数据库大小超过 quota 的 75%（1.5GB），需要执行 Compaction"

      # 提案积压告警
      - alert: EtcdHighProposalPending
        expr: etcd_server_proposals_pending > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd 积压提案数 > 5，集群写入压力过大"
```

### 5.3 Grafana Dashboard 关键面板

建议在 Grafana 中配置以下面板组（可使用 etcd 官方提供的 Dashboard ID: 3070）：

1. **集群健康概览**：Leader 状态、成员数量、提案失败次数
2. **写入性能**：WAL fsync 延迟热图（P50/P99/P999）、commit 延迟
3. **存储状态**：DB 大小趋势、当前 revision、compact revision 差值（估算历史版本积压量）
4. **网络**：gRPC 请求延迟、Watch 连接数、peer 间流量

---

## 第 6 章 存储 Compaction 与碎片整理

### 6.1 为什么 etcd 需要定期 Compaction

etcd 的 MVCC 机制为每次写入分配新的 revision，历史版本永久保留（直到 Compaction）。随着时间推移，大量历史版本积累：
- 数据库文件持续增大，最终触发 quota 限制
- 历史版本占用 BoltDB 的存储空间（即便对应的 key 已经被删除）
- Compaction 之前的 Watch 仍然可以回放历史事件，但过多历史版本会使 Watch Store 的内存占用增大

Compaction 操作告知 etcd："删除 revision X 之前的所有历史版本，只保留每个 key 的最新值"。

```bash
# 查看当前最新 revision
LATEST_REV=$(etcdctl endpoint status --endpoints=https://etcd-0:2379 ... \
  -w json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")

# 压缩到最新 revision（保留当前状态，删除所有历史版本）
etcdctl compact "${LATEST_REV}" \
  --endpoints=https://etcd-0:2379 ...

# 输出：compacted revision 1234567
```

**自动 Compaction**：etcd 支持自动 Compaction，建议在生产中启用：

```bash
# 在 etcd 启动参数中添加
--auto-compaction-mode=periodic  # 按时间周期压缩
--auto-compaction-retention=1h   # 保留最近 1 小时的历史版本
```

或者：

```bash
--auto-compaction-mode=revision  # 按版本数量压缩
--auto-compaction-retention=1000 # 保留最近 1000 个版本
```

对于 Kubernetes etcd，推荐 `periodic` 模式保留 1h，这样可以支持 Watch 回放最近 1 小时的事件，同时防止存储无限增长。

### 6.2 碎片整理（Defragmentation）

Compaction 只是"逻辑删除"——历史版本在 BoltDB 中被标记为可用空间，但 BoltDB 文件大小**不会缩小**。要回收磁盘空间，需要执行 Defragmentation：

```bash
# 对单个节点执行碎片整理（会短暂阻塞该节点的读写，通常几秒到几十秒）
etcdctl defrag \
  --endpoints=https://etcd-2:2379 \  # 先从 Follower 节点开始
  --cacert=... --cert=... --key=...

# 依次对每个节点执行，最后对 Leader 执行
etcdctl defrag --endpoints=https://etcd-1:2379 ...
etcdctl defrag --endpoints=https://etcd-0:2379 ...  # Leader 最后处理
```

> [!warning] 生产避坑：Defragmentation 的阻塞影响
> `etcdctl defrag` 操作期间，该节点**暂停处理所有请求**（包括心跳响应），可能触发 Leader 重新选举（如果 defrag 耗时超过 election timeout）。
> 安全做法：先对 Follower 节点执行 defrag，等其恢复正常后再对 Leader 节点执行。在执行 Leader 节点的 defrag 前，确认另外 2 个 Follower 都是健康的（能承接 Leader 切换）。
> 建议在业务低峰期执行，并提前通知 Kubernetes 运维团队。

---

## 第 7 章 性能调优

### 7.1 磁盘选型：etcd 性能的决定性因素

etcd 的写入路径是同步的：每次写请求都需要 WAL 的 `fdatasync` 完成后才能返回。因此，**磁盘延迟直接决定了 etcd 的写入延迟**。

**磁盘要求**（官方推荐）：

| 级别 | 描述 | IOPS 要求 | P99 延迟 | 适用场景 |
| :--- | :--- | :---: | :---: | :--- |
| **最低要求** | SSD（SATA） | ≥ 500 | < 50ms | 开发/测试 |
| **生产推荐** | NVMe SSD | ≥ 3000 | < 10ms | 生产集群 |
| **高性能** | 企业级 NVMe | ≥ 10000 | < 1ms | 大规模 K8s 集群 |

**HDD 机械硬盘绝对不可用于 etcd 生产环境**。HDD 的随机 IO 延迟（~10ms）会导致 WAL fsync 延迟超过 election timeout（默认 1s），频繁触发 Leader 选举，集群极不稳定。

**操作系统级磁盘优化**：

```bash
# 为 etcd 数据盘设置 I/O 调度器为 noop 或 deadline（SSD 不需要复杂的寻道优化）
echo noop > /sys/block/nvme0n1/queue/scheduler

# 为 etcd 进程提高 I/O 优先级（可选，在 IO 竞争激烈时有效）
ionice -c 2 -n 0 -p $(pgrep etcd)
```

### 7.2 etcd 数据与 OS 数据的目录隔离

etcd 的 WAL 和 BoltDB 数据目录应当存放在**专用磁盘分区**，与操作系统、日志、容器镜像等 IO 密集型操作物理隔离。

```bash
# 推荐的 etcd 数据目录结构
/dev/nvme0n1  →  /var/lib/etcd      # etcd 专用 NVMe SSD
/dev/sda      →  /var/log /tmp ...  # 系统盘

# etcd 配置
--data-dir=/var/lib/etcd/data    # BoltDB 数据
--wal-dir=/var/lib/etcd/wal      # WAL 日志（可选：单独分区进一步隔离）
```

WAL 和 Data 分开存放的好处：BoltDB 的 Compaction 和 Defragmentation 会产生大量顺序写 IO，与 WAL 的随机同步写隔离，可以防止互相影响。

### 7.3 网络优化

etcd 节点间的 Raft 复制通过 `--peer-urls` 通信，gRPC 基于 HTTP/2，支持多路复用。网络优化要点：

**节点间网络延迟**：Raft 的 commit 延迟 ≈ Leader 到所有 Follower 的 RTT。对于单机房部署，etcd 成员间 RTT 应 < 1ms。跨机房部署时，RTT 越大，写入延迟越高（RTT 直接加到每个写操作的延迟上）。

```bash
# 调整 etcd 的 Raft 心跳和选举超时（默认值适合单机房，跨机房需要调大）
--heartbeat-interval=100    # 默认 100ms
--election-timeout=1000     # 默认 1000ms（= 10 × heartbeat-interval）

# 跨机房（RTT ~20ms）推荐值
--heartbeat-interval=500    # 500ms，约为 RTT 的 25 倍
--election-timeout=5000     # 5000ms，= 10 × heartbeat-interval
```

> [!info] 核心概念：heartbeat-interval 与 election-timeout 的比例关系
> etcd 的 election-timeout 通常设置为 heartbeat-interval 的 10 倍。过小的 election-timeout 会导致网络抖动（如 GC Pause 或磁盘 IO 峰值）触发不必要的 Leader 选举；过大则会延长真正故障时的恢复时间。
> 经验原则：heartbeat-interval 应设置为 RTT 的 25-50 倍，给磁盘 IO 和网络波动留出足够的缓冲。

**带宽**：etcd 的流量主要是键值元数据，通常不大（几十 KB/s 到几 MB/s）。但在新成员加入时，Leader 需要传输完整快照（可能达到 GB 级别），对网络带宽有短暂的较高要求，建议 etcd 节点间的网络带宽 ≥ 1Gbps。

### 7.4 内存优化

etcd 的内存使用主要包含三部分：

1. **BoltDB mmap 映射**：etcd 通过 mmap 将 BoltDB 文件映射到内存，加速读取。mmap 的大小受 `--backend-bbolt-freelist-type` 影响（`map` vs `array`，`map` 在碎片较多时内存更高效）。
2. **Watch Store**：Watch 机制需要维护 revision → Events 的索引，Watch 连接越多、历史版本越多，内存占用越高。
3. **gRPC 连接**：每个客户端连接（Kubernetes API Server × 多个）占用少量内存。

**内存规划参考**：

| etcd DB 大小 | 建议内存 | 说明 |
| :---: | :---: | :--- |
| < 500MB | 8GB | 小型 K8s 集群（< 100 节点） |
| 500MB~2GB | 16GB | 中型集群 |
| > 2GB（需调大 quota） | 32GB+ | 大规模集群（1000+ 节点） |

### 7.5 客户端连接数优化

[[Kubernetes]] API Server 与 etcd 之间维护长连接（gRPC 流式 Watch）。在大规模集群中，多个 API Server 实例 × 多种资源类型的 Watch，可能导致 etcd 的 Watch 连接数达到数百个。

```bash
# 监控 Watch 连接数
etcd_network_active_peers  # Peer 间连接
# gRPC 层面的连接数通过 Prometheus metrics 监控：
# grpc_server_started_total{grpc_service="etcdserverpb.Watch"}
```

如果 etcd 的 Watch 连接数过多，可以考虑：
- 适当增加 etcd 节点数（分散连接）
- 使用 etcd 的 gRPC proxy 模式，将多个 API Server 的连接聚合成更少的连接到 etcd

---

## 第 8 章 常见故障处理 SOP

### 8.1 故障：etcd 集群无 Leader（Prometheus 告警 EtcdNoLeader 触发）

**症状**：所有 `etcdctl endpoint health` 报 `unhealthy`，Kubernetes API 返回 timeout，集群无法创建/更新资源。

**排查步骤**：

```bash
# Step 1：检查各节点的进程状态
systemctl status etcd  # 在每个节点执行

# Step 2：查看 etcd 日志寻找 panic 或 error
journalctl -u etcd -n 200 --no-pager

# Step 3：检查磁盘状态（WAL fsync 超时常见根因）
iostat -x 1 10  # 查看磁盘 util 和 await
df -h /var/lib/etcd  # 检查是否磁盘满

# Step 4：如果有节点存活，尝试强制重启 etcd 进程
systemctl restart etcd
```

**常见根因**：
- 磁盘满（WAL 无法写入）→ 清理磁盘空间后重启
- NTP 时钟漂移（各节点时钟差异 > 1s）→ 修复 NTP 后重启
- etcd 进程 OOM 被杀死 → 检查内存，增加内存或减少 Watch 连接数
- 网络分区（节点间无法通信）→ 排查网络

### 8.2 故障：etcd 数据库空间超出 quota（alarm NOSPACE）

**症状**：所有写入操作返回 `etcdserver: mvcc: database space exceeded`，Kubernetes 无法创建/更新资源（但读取仍然正常）。

```bash
# Step 1：确认告警状态
etcdctl alarm list --endpoints=... 
# 输出：ALARM NOSPACE

# Step 2：找出当前 revision，执行 Compaction
COMPACT_REV=$(etcdctl endpoint status --endpoints=... -w json | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['Status']['header']['revision'])")
etcdctl compact "${COMPACT_REV}" --endpoints=...

# Step 3：执行 Defragmentation（先 Follower 后 Leader）
etcdctl defrag --endpoints=https://etcd-2:2379 ...
etcdctl defrag --endpoints=https://etcd-1:2379 ...
etcdctl defrag --endpoints=https://etcd-0:2379 ...

# Step 4：解除 NOSPACE 告警
etcdctl alarm disarm --endpoints=...

# Step 5：验证数据库大小已缩小
etcdctl endpoint status --endpoints=... -w table
```

如果数据库大小确实持续增长（非碎片问题），需要增大 quota：

```bash
# 修改 etcd 启动参数（需要重启 etcd）
--quota-backend-bytes=8589934592  # 增大到 8GB（最大推荐值）
```

### 8.3 故障：单个 etcd 节点数据损坏

**症状**：某节点 etcd 进程无法启动，日志显示 `bolt: invalid database` 或 `wal: failed to read first record`。

**处理方案（3 节点集群仍有 2 节点存活）**：

此时不需要从 snapshot 恢复，直接通过成员替换即可（参见第 3.1 节的替换故障节点流程）。因为集群仍有 quorum，新节点加入后会自动从 Leader 同步最新数据。

**注意**：不要尝试修复损坏的 etcd 数据文件，直接清空数据目录重新加入集群是最安全的做法。

---

## 第 9 章 小结

etcd 的运维复杂度不在于日常操作，而在于**边界情况**的正确处理——成员变更时的操作顺序、从 snapshot 恢复时的 cluster-token 细节、Defragmentation 时的阻塞影响。

核心运维原则可以归纳为：

1. **预防优于修复**：磁盘选型 NVMe SSD、etcd 数据盘物理隔离、自动 Compaction 防止存储溢出
2. **备份是生命线**：每小时自动 snapshot，上传到对象存储，定期验证可恢复性
3. **成员变更一步一步来**：每次只操作一个节点，变更前确认集群健康
4. **监控 WAL fsync 延迟**：这是 etcd 集群健康的最关键信号，P99 > 25ms 时必须排查

etcd 的本质是一个需要像对待生产数据库一样对待的关键基础设施——它的稳定性直接决定了整个 [[Kubernetes]] 控制平面的可用性。

---

**延伸阅读**：
- [[01 etcd 全局架构——Raft 共识与 MVCC 存储]]
- [[03 存储引擎——BoltDB、WAL 与 Compaction]]
- [[05 etcd vs ZooKeeper——设计哲学与选型对比]]

---

> [!note] 思考题
> 1. `etcdctl snapshot save` 创建 etcd 的快照备份。恢复时通过 `etcdctl snapshot restore` 从快照创建新的数据目录。但恢复后集群的 member ID 和 cluster ID 都会改变——这意味着什么？恢复后的集群能否直接被现有的 Kubernetes 控制平面使用？
> 2. etcd 集群出现 'database space exceeded' 告警后变为只读。紧急恢复步骤是：1) Compaction 2) Defrag 3) 调大 quota。但 Compaction 和 Defrag 都需要 etcd 可写——只读模式下如何执行？`etcdctl alarm disarm` 的作用是什么？这个操作是否安全？
> 3. 将 etcd 集群从 3 节点迁移到新的 3 台机器——你如何在不停机的情况下完成迁移？'逐节点替换'（先添加新节点再移除旧节点）和'快照恢复到新集群'两种方案各有什么风险？在 Kubernetes 场景中，迁移 etcd 还需要更新哪些配置？
