---
title: "02 CRUSH 算法——去中心化的数据放置"
date: 2026-03-05
tags: [Ceph, CRUSH, 数据放置, 一致性哈希, 故障域, CRUSH Map, Bucket, 分布式存储]
aliases: []
---

# 02 CRUSH 算法——去中心化的数据放置

## 摘要

CRUSH（Controlled Replication Under Scalable Hashing）是 Ceph 最核心的技术创新，解决了分布式存储中"如何在不依赖中心查表的前提下，将数据均匀分布并感知物理拓扑故障域"的根本问题。本文从传统数据放置方案的缺陷出发，深入剖析 CRUSH 的树形拓扑建模、Bucket 选择算法、CRUSH Rule 的故障域约束，以及集群扩容/缩容时 CRUSH 如何最小化数据迁移量。理解 CRUSH，是理解 Ceph 去中心化自治能力的钥匙。

---

## 第 1 章 数据放置问题的本质

### 1.1 分布式存储要解决的核心矛盾

任何分布式存储系统都需要回答一个问题：**一份数据应该存在哪里？**

这个问题看似简单，但在生产场景中需要同时满足几个互相制约的目标：

**均匀性（Uniformity）**：数据应该尽可能均匀地分布在所有存储节点上，避免某些节点过载而另一些节点空闲。如果分布不均，热点节点会成为性能瓶颈，而冷节点的资源浪费。

**故障域隔离（Fault Domain Isolation）**：对于 3 副本策略，3 个副本不能都放在同一台机器、同一个机架或同一个交换机下面。真正的高可用要求每个副本在不同的故障域——一台机器宕机不影响数据可用性，一个机架断电不影响数据可用性。

**最小化迁移（Minimal Migration）**：当集群扩容（添加新节点）或缩容（移除节点）时，需要重新分布数据以维持均匀性，但迁移数据量应当尽量小——只迁移受影响的数据，不需要全量重新洗牌。

**去中心化（Decentralization）**：数据放置决策不依赖中心节点查表。客户端、OSD 都能独立计算出任意数据应该在哪个 OSD 上，不需要向 Master/NameNode 查询，消除单点瓶颈。

这四个目标在实际工程中很难同时满足。传统方案通常只能满足其中两三个，而 CRUSH 通过精妙的算法设计实现了四者的统一。

### 1.2 传统方案的局限性

**方案一：静态哈希取模（`OSD = hash(OID) % N`）**

最简单的方案：对对象 ID 哈希后取模，得到目标 OSD 编号。这满足均匀性，也不需要中心查表，但致命缺陷是**扩展性极差**：当节点数 N 变化时，几乎所有对象都需要迁移（因为 `N` 的改变导致大多数取模结果变化），迁移量接近 100%。

**方案二：中心化映射表（`Map: OID → OSD`）**

维护一张全局映射表，记录每个对象存在哪个 OSD。这满足故障域隔离（可以在分配时检查），迁移时只需更新表项。但这张表的大小与对象数量成正比——10 亿对象就需要 10 亿条记录，且所有读写操作都需要查表，中心节点成为性能瓶颈。

这正是 HDFS NameNode 的模式（Block → DataNode 映射存在内存中），导致 NameNode 内存成为 HDFS 的规模瓶颈（通常支撑不超过 3 亿个文件/Block）。

**方案三：一致性哈希（Consistent Hashing）**

一致性哈希将所有节点映射到一个虚拟哈希环上，每个数据项根据哈希值顺时针找最近的节点。节点增减时只需迁移该节点相邻的数据，迁移量约为 `1/N`（N 为节点数），接近最优。

但一致性哈希**无法感知物理拓扑**。它只知道节点的哈希值，不知道节点在哪个机架、哪个数据中心。无法保证 3 个副本分布在 3 个不同机架——两个副本可能落在哈希环上相邻位置，而这两个节点恰好在同一个机架。

[[Redis]] Cluster 使用一致性哈希（实际上是 16384 个 Hash Slot 的固定分配），适合 Redis 这种不强调副本跨机架分布的场景，但不适合需要强故障域隔离的块存储系统。

> [!note] 设计哲学
> CRUSH 的设计思路是：**将物理拓扑信息内嵌到数据放置算法中，而不是外部查表**。通过在算法层面感知"这两个节点在同一机架"，CRUSH 在选择副本时主动避开共同故障域，同时保持均匀分布和最小化迁移的特性。

---

## 第 2 章 CRUSH Map——集群拓扑的数学建模

### 2.1 CRUSH Map 的树形结构

CRUSH 将整个集群的物理拓扑建模为一棵加权树，称为 **CRUSH Map**。树的叶子节点是 **OSD**（实际的存储设备），内部节点称为 **Bucket**（桶），代表物理拓扑中的各级聚合单元（Host、Rack、Row、Datacenter 等）。

```
Root（根，代表整个集群）
├── Datacenter-BJ（数据中心）
│   ├── Rack-01（机架）
│   │   ├── Host-01（主机）
│   │   │   ├── OSD.0（weight=1.0，1TB NVMe）
│   │   │   ├── OSD.1（weight=1.0，1TB NVMe）
│   │   │   └── OSD.2（weight=1.0，1TB NVMe）
│   │   └── Host-02
│   │       ├── OSD.3（weight=2.0，2TB HDD）
│   │       └── OSD.4（weight=2.0，2TB HDD）
│   └── Rack-02
│       ├── Host-03
│       │   └── OSD.5, OSD.6, OSD.7
│       └── Host-04
│           └── OSD.8, OSD.9, OSD.10
└── Datacenter-SH
    └── ...
```

每个节点（OSD 或 Bucket）都有一个 **Weight（权重）**：

- OSD 的权重通常对应其磁盘容量（1TB NVMe → 权重 1.0，2TB HDD → 权重 2.0）
- 内部 Bucket 的权重是其所有子节点权重之和

权重决定了数据分配的比例：权重 2.0 的 OSD 会比权重 1.0 的 OSD 存储大约两倍的数据量，从而在混合容量集群中实现按容量比例的均匀分布。

### 2.2 CRUSH Rule——故障域约束的声明

CRUSH Rule 是数据放置策略的声明性描述，告诉 CRUSH 算法"从树的哪个层级开始选择，在哪个层级做故障域隔离"。

一条典型的 CRUSH Rule 包含以下步骤：

```
rule replicated_rack {
    # 1. 从哪个 Bucket 开始（通常是 Root）
    take default

    # 2. 第一次选择：在 Rack 层级选 N 个不同的 Rack
    #    'chooseleaf' 意味着选到 Rack 后继续向下选到叶子（OSD）
    #    'firstn 0' 中的 0 表示选副本数个（副本数由 Pool 配置决定）
    chooseleaf firstn 0 type rack

    # 3. 结束
    emit
}
```

上面的 Rule 声明的含义是：**从 Root 开始，在 Rack 层级选择 N 个不同的 Rack（N = 副本数），然后在每个 Rack 内继续向下选择一个具体的 OSD**。

这就实现了"3 副本分布在 3 个不同机架"的故障域隔离——无论集群如何变化，CRUSH 都保证副本分布满足这个约束。

如果需要更严格的隔离（如副本必须在不同数据中心），只需将 `type rack` 改为 `type datacenter`：

```
chooseleaf firstn 0 type datacenter
```

---

## 第 3 章 CRUSH 算法的选择过程

### 3.1 CRUSH 算法的输入输出

CRUSH 算法的函数签名（概念上）：

```
function CRUSH(x, rule, n) → [OSD_1, OSD_2, ..., OSD_n]
```

- `x`：输入值，通常是 PG ID（整数）
- `rule`：CRUSH Rule，定义数据放置策略
- `n`：需要选择的副本数（通常等于 Pool 的 size 配置）
- 输出：一个 OSD 列表，长度为 n

关键属性：**给定相同的 `x`、`rule` 和 CRUSH Map，任何节点（客户端、OSD、Monitor）计算的结果完全一致**。这是 CRUSH 去中心化的根本保证。

### 3.2 Bucket 内的选择算法

CRUSH 算法在每个 Bucket 内部使用哈希函数选择子节点。对于一个 Bucket B，需要从其子节点中选择第 r 个副本，选择公式为：

```
c(r, x) = argmax_i { hash(x, id_i, r) / weight_i }
```

其中：
- `x` 是 PG ID（输入值）
- `id_i` 是第 i 个子节点的 ID
- `r` 是副本编号（选第几个副本）
- `weight_i` 是第 i 个子节点的权重

直观解释：对每个子节点，计算 `hash(x, id_i, r)` 并除以该节点权重，选取结果最大的节点。

**为什么除以权重？** 如果所有子节点权重相同，`hash(x, id_i, r)` 是均匀分布的，选出的节点分布均匀。如果某个节点权重是其他节点的 2 倍，除以权重后它的"得分"变小，但由于它被选中的概率与权重成正比（期望上），最终数据量与权重成正比。这是 **Straw2 算法**（Ceph 默认使用），它在保证按权重比例分配数据的同时，在节点增减时实现最小化迁移。

### 3.3 完整选择流程示例

以 3 副本、Rack 级故障域隔离为例，选择 PG 100 的 OSD 列表：

**Step 1：从 Root 开始，在 Rack 层级选 3 个不同的 Rack**

```
副本 1：hash(100, Rack-01的ID, 1) / weight(Rack-01) → 得分 0.73
        hash(100, Rack-02的ID, 1) / weight(Rack-02) → 得分 0.41
        选择得分最高的 Rack-01

副本 2：需要选不同于 Rack-01 的 Rack
        继续计算各 Rack 的得分，选择 Rack-02

副本 3：继续选不同的 Rack，选择 Rack-03
```

**Step 2：在每个选中的 Rack 内，继续向下选择 OSD**

```
Rack-01 → 选择 Rack-01 内得分最高的 OSD → OSD.5
Rack-02 → 选择 Rack-02 内得分最高的 OSD → OSD.12
Rack-03 → 选择 Rack-03 内得分最高的 OSD → OSD.20
```

最终结果：PG 100 → [OSD.5, OSD.12, OSD.20]

这整个计算过程是**纯数学计算**，不需要查询任何外部存储或网络请求，每个知道 CRUSH Map 的节点都能独立重现这个结果。

### 3.4 重映射（Remapping）——处理 OSD 故障

如果 CRUSH 选择的某个 OSD 标记为 `down`（故障），CRUSH 不会简单地放弃这个选择，而是进行**重映射**——调整副本编号 r，继续在同一 Bucket 内选择下一个备选 OSD：

```
# 原始选择 OSD.5 故障，r 自增，重新选择
r = 1 → OSD.5（故障，跳过）
r = 2 → hash(100, ..., 2) / weight → 选择 OSD.7（同一 Rack 内的另一个 OSD）
```

这种重映射保证了：即使 OSD 故障，CRUSH 仍然能够计算出有效的 OSD 列表，不需要人工干预或中心协调。

> [!warning] 生产避坑：CRUSH 重映射的副作用
> 当 OSD 故障导致大量 PG 需要重映射时，"替代 OSD"会承受大量数据写入（数据恢复流量）。如果大量 OSD 在同一 Rack，且该 Rack 的某个 OSD 故障，Rack 内其他 OSD 会接收所有需要重映射的 PG 的数据，可能短暂造成 IO 热点。
> 生产中应合理规划每个 Rack 内的 OSD 数量，确保单 OSD 故障时，数据能够分散到足够多的其他 OSD 上。

---

## 第 4 章 CRUSH 的均匀性与迁移量

### 4.1 为什么 CRUSH 能保证均匀分布

CRUSH 使用哈希函数的输出决定选择，哈希函数的输出在统计上是均匀分布的。当 PG 数量足够多时，每个 OSD 被选中的概率与其权重成正比，从而实现按容量比例均匀分布数据。

**但 CRUSH 的均匀性是概率性的，不是确定性的。** 对于较少的 PG 数量（< 100），PG 在 OSD 间的分布可能不均匀（某些 OSD 可能分到更多 PG）。PG 数量越大，统计均匀性越好。

这也是为什么 Ceph 强调**合理设置 pg_num**（每个 Pool 的 PG 数量）：过少的 PG 导致数据分布不均，过多的 PG 增加 Monitor 的元数据管理开销。通常建议每个 OSD 对应 100-200 个 PG（考虑副本后），具体计算公式：

```
pg_num = (OSD 数量 × 100) / 副本数
```

例如，60 个 OSD，3 副本：`pg_num = 60 × 100 / 3 = 2000`，取最近的 2 的幂次方 = 2048。

### 4.2 集群扩容时的数据迁移

当向集群添加新的 OSD 时，需要重新均衡数据。CRUSH 的 Straw2 算法在这方面表现接近理论最优。

**理论最小迁移量**：向 N 个 OSD 的集群添加 1 个新 OSD，至少需要迁移 `1/(N+1)` 的数据（因为新 OSD 应该分担 `1/(N+1)` 的数据量，这些数据必须从旧 OSD 迁移过来）。

**CRUSH 的实际迁移量**：Straw2 算法在添加新节点时，理论上只迁移需要迁移的数据——即 `weight_new / total_weight` 比例的数据，接近理论最优，不会迁移那些本不需要迁移的数据。

这与静态哈希取模形成鲜明对比（取模方案在添加节点时迁移量可能接近 100%）。

### 4.3 PG 分裂——pg_num 增加时的平滑迁移

随着集群容量增大，原有的 pg_num 可能导致每个 OSD 的 PG 数量过多，影响 Recovery 性能。Ceph Luminous 版本引入了 **pg_num_min** 和 **pg_autoscaler**，支持 PG 数量的自动调整。

PG 分裂的原理：将 PG `1.a` 分裂为 `2.a` 和 `2.(a + old_pg_num)`，两个新 PG 的 CRUSH 选择结果与原 PG 重叠，分裂过程只需要迁移大约一半数据（另一半保持原位），最大化复用已有数据。

---

## 第 5 章 CRUSH 的高级特性

### 5.1 CRUSH Weight 调整——在线容量均衡

在混合容量集群（不同容量的磁盘）中，可以通过调整 OSD 的 Weight 来控制数据分配比例：

```bash
# 将 OSD.5 的权重从 1.0 调整为 2.0（表示其容量变为原来 2 倍）
ceph osd crush reweight osd.5 2.0

# 查看当前权重分布
ceph osd df tree
```

调整权重后，CRUSH 会逐渐将数据迁移到权重更高的 OSD，这个过程是在线完成的，不需要停机。

`ceph osd reweight`（注意：没有 `crush`）是另一个命令，它调整的是 OSD 的**副本分配权重**（影响 PG 分配的随机性调整），而不是 CRUSH Map 中的 Weight。两者都影响数据分布，但层次不同——前者修改 CRUSH Map，后者是在 PG 分配层面的微调。

### 5.2 CRUSH Location——故障域感知的 OSD 标记

每个 OSD 在 CRUSH Map 中都有一个位置（Location），描述它在哪个层级的哪个 Bucket 下面。这个信息在 OSD 启动时自动注册，也可以手动配置：

```ini
# /etc/ceph/ceph.conf
[osd]
# 定义 OSD 的 CRUSH 位置
osd crush location hook = /usr/lib/ceph/osd-location.sh
```

通过 `osd crush location`，管理员可以显式声明每个 OSD 的物理位置（机柜、机架、数据中心），CRUSH 在选择副本时依据这些信息做故障域隔离。

### 5.3 CRUSH 的 Stretch Cluster——跨数据中心部署

Ceph 的 Stretch Cluster 特性（Ceph Pacific+）支持将集群跨两个数据中心部署，保证两个数据中心都有完整的数据副本，实现真正的双活：

```
数据中心 A：OSD.0 ~ OSD.29（30 个 OSD）
数据中心 B：OSD.30 ~ OSD.59（30 个 OSD）
Tiebreaker：1 个 Monitor（仲裁节点，可在第三个低成本位置）

CRUSH Rule：5 副本中，2 副本在 DC-A，2 副本在 DC-B，1 副本由仲裁者定义
```

这种部署下，任意一个数据中心完全宕机，另一个数据中心仍然有所有数据的完整副本，可以继续服务（但会退出 stretch 模式，降级为 3 副本）。

---

## 第 6 章 CRUSH 的局限性与调优

### 6.1 小集群的均匀性问题

CRUSH 的均匀性依赖于 PG 数量足够多（统计规律生效）。对于小集群（< 5 个 OSD），即使 PG 数量足够，CRUSH 的分布也可能明显不均。

Ceph 的 `ceph osd df` 命令可以查看每个 OSD 的实际数据占用比例（`VAR` 列，理想值为 1.0）：

```
ceph osd df
# 输出示例：
# OSD    SIZE   AVAIL   USE%   VAR
# osd.0  1.0T   850G    15%    0.98
# osd.1  1.0T   830G    17%    1.12  ← 数据偏多（VAR > 1.1 需要关注）
# osd.2  1.0T   860G    14%    0.93
```

VAR 偏高（> 1.1 或 < 0.9）说明 CRUSH 分布不够均匀，可以通过调整 `pg_num` 或使用 `ceph osd reweight-by-utilization` 命令进行微调。

### 6.2 CRUSH 变更的代价

修改 CRUSH Map（调整拓扑结构、添加 Bucket 层次）会触发大规模数据迁移。在生产中变更 CRUSH Map 必须谨慎：

- 变更前使用 `crushtool --test` 模拟变更后的 PG 分布，评估迁移量
- 通过 `ceph osd set backfillfull` 限制迁移速率，防止 Recovery 流量影响正常 IO
- 分批次逐步调整（如分多次调整 OSD 权重），而非一次性大幅变更

---

## 第 7 章 小结

CRUSH 算法的精髓在于**将物理拓扑融入数据放置的数学计算**——它不是一个简单的哈希函数，而是一个能够感知树形拓扑结构、满足故障域约束、按权重比例分配数据的伪随机函数。

CRUSH 解决了分布式存储中最难的权衡问题：
- 均匀分布 + 最小化迁移（Straw2 算法）
- 故障域隔离 + 去中心化计算（CRUSH Rule + 树形拓扑）
- 按容量比例分配 + 在线调整（Weight 机制）

理解 CRUSH 的关键是理解它的"树形选择"直觉：从根节点开始，在每个层级用哈希函数选择子节点，当遇到故障域约束时，在同一层级选择不同的子树。这个简单的直觉对应了一套严谨的数学设计。

---

**延伸阅读**：
- [[01 Ceph 全局架构——RADOS、CRUSH 与三大存储接口]]
- [[04 数据一致性——PG、副本策略与 Recovery]]

---

> [!note] 思考题
> 1. RADOS 将数据组织为 Pool → PG（Placement Group）→ OSD 的层级。PG 是数据分布和复制的基本单位。PG 数量过少导致数据分布不均，过多增加内存和 peering 开销。如何计算集群所需的 PG 数量（考虑 OSD 数量、副本数和目标 PG/OSD 比例）？Ceph Nautilus+ 的 PG Autoscaler 是如何自动调整的？
> 2. Ceph 的数据一致性通过 PG Peering 和 Recovery 机制保证。当 OSD 故障后恢复（或新 OSD 加入），PG 需要 Peering（对齐各副本的状态）然后 Recovery（同步缺失的数据）。在一个有 1000 个 OSD 的集群中，如果一个 OSD 故障后恢复，Peering 和 Recovery 的 IO 开销对前台业务的影响有多大？如何通过 `osd_recovery_max_active` 限制恢复速度？
> 3. BlueStore 是 Ceph Luminous+ 的默认 OSD 后端——直接管理裸磁盘，绕过了文件系统（取代了之前的 FileStore + XFS）。BlueStore 使用 RocksDB 存储元数据。直接管理裸盘相比使用文件系统有什么性能优势？BlueStore 的事务机制如何保证数据和元数据的一致性？
