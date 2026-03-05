---
title: "06 Ceph 运维——集群部署、PG 调优与故障处理"
date: 2026-03-05
tags: [Ceph, 运维, cephadm, PG调优, 故障处理, 监控, OSD, SRE]
aliases: []
---

# 06 Ceph 运维——集群部署、PG 调优与故障处理

## 摘要

Ceph 是功能最强大的开源分布式存储系统，但也以运维复杂著称。本文从 SRE 视角系统梳理 Ceph 的生产运维体系：使用 cephadm 进行现代化集群部署与扩容、PG 数量的合理规划与 pg_autoscaler 使用、Prometheus 关键监控指标与告警体系，以及生产中最常见的故障模式（OSD down、PG stuck、空间告警）的排查 SOP。重点不在于操作命令的罗列，而在于每个运维决策背后的"为什么"。

---

## 第 1 章 现代化集群部署——cephadm

### 1.1 cephadm 的设计理念

在 Ceph Octopus（2020）之前，Ceph 的主流部署工具是 **ceph-deploy** 和 **ceph-ansible**。这些工具在 Kubernetes 和容器化运维理念兴起之前设计，存在几个问题：

- **ceph-deploy** 功能简单，不支持复杂的生产配置（如 TLS 加密、多机架拓扑）
- **ceph-ansible** 功能强大但 Playbook 庞杂，学习曲线陡峭，与最新 Ceph 版本的同步往往滞后

**cephadm** 是 Ceph Pacific（2021）确立的官方推荐部署工具，基于容器化（Docker/Podman）部署 Ceph 守护进程，通过 SSH 管理集群节点。其设计理念与 [[Kubernetes]] Operator 模式类似——将期望状态（spec）声明给 cephadm，cephadm 负责将实际状态收敛到期望状态。

cephadm 的核心优势：
- **容器化隔离**：每个 Ceph 守护进程运行在独立容器中，依赖不与宿主机冲突
- **版本升级简单**：替换容器镜像版本，cephadm 自动滚动重启
- **声明式管理**：通过 YAML spec 描述期望的服务拓扑，cephadm 自动调度

### 1.2 初始化集群

```bash
# Step 1：在第一个 Monitor 节点上引导集群
cephadm bootstrap \
  --mon-ip 192.168.1.10 \
  --cluster-network 192.168.2.0/24 \  # OSD 之间的复制网络（推荐与客户端网络隔离）
  --initial-dashboard-password admin123

# 输出：Ceph Dashboard 地址、管理员凭据

# Step 2：将集群 SSH 公钥分发到所有其他节点
ssh-copy-id -f -i /etc/ceph/ceph.pub root@192.168.1.11
ssh-copy-id -f -i /etc/ceph/ceph.pub root@192.168.1.12
# ... 所有节点

# Step 3：将其他节点加入集群
ceph orch host add ceph-node-02 192.168.1.11 --labels=_admin
ceph orch host add ceph-node-03 192.168.1.12
# 验证节点状态
ceph orch host ls
```

### 1.3 添加 OSD

```bash
# 查看所有可用磁盘（未使用的裸块设备）
ceph orch device ls

# 方式一：自动使用所有可用磁盘（生产中需谨慎）
ceph orch apply osd --all-available-devices

# 方式二：通过 spec 文件精确指定（推荐生产使用）
cat > osd-spec.yaml << EOF
service_type: osd
service_id: default-drive-group
placement:
  host_pattern: "ceph-node-*"
data_devices:
  paths:
    - /dev/sdb
    - /dev/sdc
    - /dev/sdd
db_devices:
  paths:
    - /dev/nvme0n1  # 4 个 HDD 共享一块 NVMe 作为 DB 盘
EOF

ceph orch apply -i osd-spec.yaml
```

### 1.4 配置 CRUSH Map——反映物理拓扑

默认情况下，cephadm 自动将主机添加到 CRUSH Map，层次结构为 `root > host > osd`。生产中需要添加机架层：

```bash
# 添加机架层
ceph osd crush add-bucket rack01 rack
ceph osd crush add-bucket rack02 rack
ceph osd crush move rack01 root=default
ceph osd crush move rack02 root=default

# 将主机移到对应机架
ceph osd crush move ceph-node-01 rack=rack01
ceph osd crush move ceph-node-02 rack=rack01
ceph osd crush move ceph-node-03 rack=rack02
ceph osd crush move ceph-node-04 rack=rack02

# 创建基于机架故障域的 CRUSH Rule
ceph osd crush rule create-replicated replicated-rack default rack
# 为 RBD Pool 应用此 Rule
ceph osd pool set my-rbd-pool crush_rule replicated-rack
```

验证配置后，每个 Pool 的 3 副本会自动分布到不同机架。

---

## 第 2 章 PG 规划与 pg_autoscaler

### 2.1 PG 数量的影响

PG 数量（`pg_num`）是 Ceph 最重要的配置参数之一，直接影响：

**数据分布均匀性**：PG 越多，RADOS 对象在 OSD 间分布越均匀（统计规律）。PG 过少，某些 OSD 可能分到的数据量与平均值偏差较大（`ceph osd df` 中的 VAR 列）。

**Recovery 速度**：单个 PG 对应的数据量 = 总数据量 / pg_num。PG 越多，单个 PG 的数据量越小，Recovery 时单个 PG 的迁移量越小，整体 Recovery 速度越快。

**Monitor/MDS 内存开销**：Monitor 需要在内存中维护所有 PG 的状态，PG 越多，Monitor 内存开销越大。建议集群总 PG 数量不超过 **200,000**（对于普通配置的 Monitor 节点）。

### 2.2 pg_num 计算公式

经验公式：

```
pg_num_per_pool = (OSD 总数 × 目标每 OSD PG 数) / 副本数

目标每 OSD PG 数：
  - 小集群（< 5 个 Pool）：每 OSD 200 PG
  - 中等集群（5-10 个 Pool）：每 OSD 100 PG（总 PG 分散到各 Pool）
  - 大集群（> 10 个 Pool）：每 OSD 50-100 PG
```

示例：60 个 OSD，3 个 Pool（RBD/CephFS data/RGW data），3 副本：

```
总 PG = 60 × 100 = 6000（目标每 OSD 100 PG）
每个 Pool 的 pg_num ≈ 6000 / 3 = 2000 → 取 2 的幂次方 = 2048
```

pg_num 必须是 2 的幂次方（否则某些 PG 分布不均匀），且 `pgp_num`（PG 实际参与 CRUSH 计算的数量）通常设置为与 `pg_num` 相同。

### 2.3 pg_autoscaler——自动管理 PG 数量

从 Ceph Nautilus 开始，`pg_autoscaler` 模块可以根据集群状态自动调整各 Pool 的 `pg_num`，无需手动计算。

```bash
# 启用 pg_autoscaler
ceph mgr module enable pg_autoscaler

# 查看各 Pool 的 PG 建议
ceph osd pool autoscale-status

# 输出示例：
# POOL           SIZE  TARGET SIZE  RATE  RAW CAPACITY  RATIO  TARGET RATIO  EFFECTIVE RATIO  BIAS  PG_NUM  NEW PG_NUM  AUTOSCALE
# rbd-pool      500G         -      3.0      60T        0.025        -          0.025          1.0     128       256     warn
# cephfs-data   1T           -      3.0      60T        0.050        -          0.050          1.0     256       512     warn
```

`NEW PG_NUM` 是 autoscaler 建议的 PG 数量。`AUTOSCALE` 列：
- `off`：不自动调整，只给出建议
- `warn`：超出建议范围时发出警告
- `on`：自动调整（生产中谨慎使用，会触发数据迁移）

```bash
# 对某个 Pool 启用自动 PG 调整
ceph osd pool set rbd-pool pg_autoscale_mode on

# 或全局设置默认模式
ceph config set global osd_pool_default_pg_autoscale_mode warn
```

> [!warning] 生产避坑：pg_autoscaler 的数据迁移代价
> pg_autoscaler 在调整 `pg_num` 时会触发数据迁移（PG 分裂/合并），迁移量可能相当可观。在生产中，建议将 autoscale 设置为 `warn` 模式，人工确认后再手动调整，避免在业务高峰期触发大规模数据迁移。

---

## 第 3 章 Prometheus 监控体系

### 3.1 关键监控指标

Ceph 通过 Prometheus Exporter（MGR 模块 `prometheus`）暴露指标。

**集群整体健康**

```
# 集群健康状态（0=HEALTH_OK, 1=HEALTH_WARN, 2=HEALTH_ERR）
ceph_health_status
# 告警：> 0 时发出 Warning，= 2 时立即触发告警

# 集群总可用空间百分比
ceph_cluster_total_used_bytes / ceph_cluster_total_bytes
# 告警：> 75% Warning，> 85% Critical（Ceph 在空间接近 full 时会停止写入）
```

**OSD 状态**

```
# 当前 down 的 OSD 数量
count(ceph_osd_up == 0)
# 告警：任何 OSD down 触发 Warning

# OSD 的 apply 延迟（写入延迟）
ceph_osd_apply_latency_ms
# 告警：P99 > 100ms 时发出 Warning

# OSD 的磁盘使用率（注意：单个 OSD 接近 full 时 Ceph 会触发 nearfull 保护）
ceph_osd_utilization
# 告警：> 80% Warning
```

**PG 状态**

```
# 非 active+clean 的 PG 数量（包含 degraded、peering 等）
ceph_pg_total - ceph_pg_active - ceph_pg_clean
# 告警：非零且持续超过 30 分钟时告警

# degraded 的对象数量
ceph_pg_degraded
# 告警：持续增加时告警（说明 Recovery 速度跟不上故障速度）
```

**IO 性能**

```
# 集群整体读写 QPS
ceph_osd_op_r, ceph_osd_op_w

# 集群整体读写带宽
ceph_osd_op_r_out_bytes, ceph_osd_op_w_in_bytes
```

### 3.2 关键告警规则

```yaml
groups:
  - name: ceph
    rules:
      # 集群健康状态恶化
      - alert: CephHealthError
        expr: ceph_health_status == 2
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Ceph 集群处于 HEALTH_ERR 状态，需要立即处理"

      # OSD 宕机
      - alert: CephOSDDown
        expr: ceph_osd_up == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OSD {{ $labels.ceph_daemon }} 已宕机超过 5 分钟"

      # 存储空间告警
      - alert: CephClusterNearFull
        expr: ceph_cluster_total_used_bytes / ceph_cluster_total_bytes > 0.75
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Ceph 集群使用率超过 75%，需要扩容或清理数据"

      # PG 长时间非健康
      - alert: CephPGsNotClean
        expr: ceph_pg_total - ceph_pg_active - ceph_pg_clean > 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "存在非 active+clean 的 PG 超过 30 分钟"

      # PG stuck（长时间未恢复）
      - alert: CephPGsStuck
        expr: ceph_pg_stuck > 0
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "存在 stuck 状态的 PG，可能需要人工干预"
```

---

## 第 4 章 常见故障处理 SOP

### 4.1 故障：OSD down

**症状**：`ceph status` 显示 `N osds: M down`，集群进入 `HEALTH_WARN` 状态，受影响 PG 开始 Recovery。

**排查步骤**：

```bash
# Step 1：确认哪些 OSD down
ceph osd tree | grep -v "up"
# 或
ceph health detail

# Step 2：检查 OSD 进程是否在运行
systemctl status ceph-osd@<id>
# 或（cephadm 部署）
cephadm ls | grep osd

# Step 3：查看 OSD 日志找根因
journalctl -u ceph-osd@<id> -n 200 --no-pager
# 常见错误：
# - "bluestore: **_open_db failed" → 磁盘故障
# - "OSD::do_osd_ops: Error on pg write" → 磁盘 IO 错误
# - "osd.X reported failed by..." → 网络问题导致心跳超时

# Step 4：检查磁盘健康
smartctl -a /dev/sdX  # 查看 SMART 数据，检查 Reallocated_Sector_Ct 等指标
dmesg | grep -E "error|fail|sdb"  # 内核磁盘错误日志

# Step 5a：如果磁盘健康，尝试重启 OSD
systemctl start ceph-osd@<id>

# Step 5b：如果磁盘故障，替换磁盘
# 先将故障 OSD 标记为 out（触发 Rebalance）
ceph osd out <id>
# 等待 Recovery 完成后，从集群移除
ceph osd purge <id> --yes-i-really-mean-it
# 替换磁盘后，用 cephadm 添加新 OSD
ceph orch daemon add osd ceph-node-02:/dev/sdb
```

### 4.2 故障：PG stuck（PG 长时间不恢复）

**症状**：`ceph health detail` 显示 `PGs stuck inactive/unclean/undersized`，持续超过 30 分钟。

**常见原因及处理**：

**PG stuck inactive（找不到足够的 OSD 组成 Acting Set）**：

```bash
# 查看 stuck 的 PG
ceph pg dump_stuck inactive

# 如果是因为多个 OSD 同时 down，检查是否能恢复足够 OSD 让 PG active
# 如果 OSD 无法恢复，且 PG stuck incomplete（副本全部丢失），需要从备份恢复
ceph pg <pg-id> query  # 查看 PG 的详细状态
```

**PG stuck unclean（Recovery 进度卡住）**：

```bash
# 检查 Recovery 是否在进行
ceph status  # 查看 "recovering X objects/s" 行

# 如果 Recovery 速度极慢或为 0
# 检查是否设置了 norecover/nobackfill
ceph osd dump | grep flags

# 手动触发 PG 恢复
ceph pg repair <pg-id>   # 修复 inconsistent PG
ceph pg scrub <pg-id>    # 触发 Scrub
```

**PG stuck undersized（副本数不足但无法补全）**：

```bash
# 检查可用 OSD 数量是否少于 Pool 的 size 配置
ceph osd tree
# 如果确实 OSD 不足，临时降低 Pool 的 min_size（最小副本数）
# 注意：这会降低数据可靠性，仅在紧急情况下使用
ceph osd pool set my-pool min_size 1  # 允许单副本工作（高风险！）
# 恢复后立即恢复 min_size
ceph osd pool set my-pool min_size 2
```

### 4.3 故障：集群空间告警（nearfull/full）

Ceph 有三个空间阈值：
- **nearfull**（默认 85%）：集群发出警告，仍然可以读写
- **full**（默认 95%）：集群停止所有写操作（只读模式），OSD 继续上报状态
- **backfillfull**（默认 90%）：停止 Backfill 操作（防止 Recovery 把集群撑满）

**紧急处理（已触发 full，写操作停止）**：

```bash
# Step 1：临时提高 full ratio（争取操作时间）
ceph osd set-full-ratio 0.97  # 提高 full 阈值

# Step 2：快速释放空间
# 删除不需要的快照
rbd snap purge pool-name/image-name

# 清理 RGW 过期对象
# 压缩 RocksDB（BlueStore 内部存储的 WAL 积累）
ceph tell osd.* compact

# Step 3：长期解决——扩容 OSD
ceph orch daemon add osd <host>:<device>

# Step 4：恢复正常 full ratio
ceph osd set-full-ratio 0.95
```

> [!warning] 生产避坑：提前规划存储扩容
> Ceph 的扩容需要时间——添加新 OSD、等待 CRUSH Rebalance、数据均衡到新 OSD，这个过程可能需要数小时。
> 必须在集群使用率达到 70% 时就启动扩容规划，而不是等到 nearfull 告警时才行动。同时，应将 `nearfull` 告警阈值调低到 75%，给运维操作留出足够缓冲。

### 4.4 日常运维检查清单

```bash
# 每日检查
ceph status                          # 整体健康状态
ceph df                              # 存储空间使用
ceph osd df tree                     # 各 OSD 使用率（VAR 列偏差）
ceph health detail                   # 详细健康问题

# 每周检查
ceph pg dump | grep "inconsistent"   # 查找 Scrub 发现的不一致 PG
ceph osd perf                        # OSD IO 性能统计
ceph osd pool stats                  # 各 Pool IO 统计

# 每月操作
# 检查并清理 OSD Journal 碎片（BlueStore 不需要，FileStore 需要）
# 检查 SMART 磁盘健康
# 验证备份可用性（模拟 OSD 故障恢复）
```

---

## 第 5 章 集群升级与滚动重启

### 5.1 使用 cephadm 进行版本升级

cephadm 支持在线滚动升级，不需要停机：

```bash
# 查看当前版本
ceph version

# 拉取新版本镜像
cephadm pull  # 拉取最新镜像

# 开始升级（cephadm 自动按 MON → MGR → OSD → MDS → RGW 顺序滚动升级）
ceph orch upgrade start --ceph-version 18.2.0

# 监控升级进度
ceph orch upgrade status
ceph orch upgrade check
```

升级期间，cephadm 每次只重启一个守护进程，等其恢复健康后再处理下一个，确保集群持续可用。

### 5.2 OSD 维护模式

在需要重启某台主机（如操作系统升级）时，应先将该主机的所有 OSD 设置为 out，避免触发大规模 Rebalance：

```bash
# 设置主机进入维护模式（cephadm 自动处理）
ceph orch host maintenance enter ceph-node-02

# 等集群状态恢复 HEALTH_OK 后，执行系统操作
# 完成后退出维护模式
ceph orch host maintenance exit ceph-node-02
```

---

## 第 6 章 小结

Ceph 的运维核心是**理解集群状态机和数据流**：

- PG 的状态（active+clean / degraded / peering）反映了数据的健康程度
- 存储空间的三个阈值（nearfull/backfillfull/full）定义了集群写入能力的边界
- Recovery/Backfill 是集群自愈的具体机制，但也是 IO 压力的来源

有效的 Ceph 运维需要把握三个原则：

1. **预防性监控**：空间告警在 75%，OSD 健康实时追踪，Scrub 定期调度
2. **限速保护**：通过 `osd_max_backfills`、`osd_recovery_max_chunk` 等参数控制 Recovery 对业务的影响
3. **操作有序**：集群成员变更（添加/替换 OSD）必须等上一步完成后再进行下一步，切忌批量操作

---

**延伸阅读**：
- [[01 Ceph 全局架构——RADOS、CRUSH 与三大存储接口]]
- [[04 数据一致性——PG、副本策略与 Recovery]]
