---
title: "03 StatefulSet 控制器深度解析"
date: 2026-03-04
tags: [Controller, Headless Service, Kubernetes, PVC, StatefulSet, 云原生, 有序部署, 有状态应用, 滚动更新]
aliases: []
---

# 03 StatefulSet 控制器深度解析

**摘要：**

[[02 Deployment 控制器深度解析|Deployment]] 解决了无状态应用的部署和更新问题，但有状态应用（数据库、消息队列、分布式存储）有三个 Deployment 无法满足的硬性需求：**稳定的网络标识**（Pod 重建后 DNS 名称不变）、**稳定的持久存储**（Pod 重建后仍然绑定同一个磁盘卷）、**有序的部署和更新**（按顺序逐一启动或更新，不能并行）。**StatefulSet** 是 K8s 为有状态应用设计的工作负载控制器——它为每个 Pod 分配一个固定的序号和稳定的 DNS 名称，通过 PVC 模板为每个 Pod 绑定独立的持久存储，并按序号顺序执行创建、删除和更新操作。本文从有状态应用的核心需求出发，深入分析 StatefulSet Controller 的 Pod 命名规则、Headless Service 的 DNS 机制、PVC 模板与存储绑定、有序创建与删除、滚动更新与分区更新策略。

---

## 第 1 章 有状态应用的核心需求

### 1.1 为什么 Deployment 不适合有状态应用

Deployment 管理的 Pod 是**可互换的**——删除一个 Pod 后重建的新 Pod 与原来的 Pod 没有任何关联（不同的名称、不同的 IP、不同的存储卷）。这对无状态应用（如 Web 服务器）没有问题——任何副本都可以处理任何请求。

但有状态应用有完全不同的需求。以一个 3 节点的 MySQL 主从集群为例：

**稳定的网络标识**：主从复制需要从节点知道主节点的地址。如果主节点 Pod 重建后 IP 和 DNS 名称都变了，所有从节点的复制配置都要更新——这在自动化环境中几乎不可行。

**稳定的持久存储**：每个 MySQL 实例的数据存储在独立的磁盘卷上。如果 Pod 重建后绑定了一个全新的空卷，数据就丢失了。Pod 必须重新绑定到之前使用的那个磁盘卷。

**有序的操作**：MySQL 集群的初始化有顺序要求——必须先启动主节点（Pod-0），然后从节点（Pod-1、Pod-2）从主节点同步数据。如果三个 Pod 同时启动，从节点找不到主节点，初始化失败。

### 1.2 StatefulSet 的三个保证

| 保证 | Deployment | StatefulSet |
| :--- | :--- | :--- |
| **网络标识** | Pod 名称随机（如 web-abc123-xyz）、IP 不固定 | Pod 名称有序（web-0, web-1, web-2）、DNS 名称固定 |
| **持久存储** | 所有 Pod 共享同一个 PVC 定义 | 每个 Pod 绑定独立的 PVC，Pod 重建后重新绑定同一个 PVC |
| **操作顺序** | 并行创建/删除/更新 | 按序号顺序创建/删除/更新 |

---

## 第 2 章 Pod 命名与 Headless Service

### 2.1 有序的 Pod 命名

StatefulSet 管理的 Pod 名称格式为 `<statefulset-name>-<ordinal>`——其中 ordinal 是从 0 开始的递增序号：

```
StatefulSet name: mysql
replicas: 3

→ Pod-0: mysql-0
→ Pod-1: mysql-1
→ Pod-2: mysql-2
```

Pod 名称是**永久固定的**——即使 Pod 被删除并重建，新 Pod 的名称与旧 Pod 完全相同。这是 StatefulSet 实现"稳定网络标识"的基础。

### 2.2 Headless Service 与 DNS

StatefulSet 需要配合一个 **Headless Service**（`clusterIP: None`）工作。普通的 Service 有一个 ClusterIP，DNS 解析返回这个 ClusterIP；Headless Service 没有 ClusterIP，DNS 解析直接返回**每个 Pod 的 IP 地址**。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mysql
  labels:
    app: mysql
spec:
  ports:
    - port: 3306
  clusterIP: None    # Headless Service
  selector:
    app: mysql
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: "mysql"    # 关联的 Headless Service 名称
  replicas: 3
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
```

配置后，K8s 的 DNS 系统为每个 Pod 创建独立的 DNS A 记录：

```
mysql-0.mysql.default.svc.cluster.local → Pod-0 的 IP
mysql-1.mysql.default.svc.cluster.local → Pod-1 的 IP
mysql-2.mysql.default.svc.cluster.local → Pod-2 的 IP
```

DNS 名称格式：`<pod-name>.<service-name>.<namespace>.svc.cluster.local`

**稳定性保证**：Pod-0 无论被重建多少次，它的 DNS 名称始终是 `mysql-0.mysql.default.svc.cluster.local`——只是对应的 IP 地址可能变化（因为新 Pod 可能被调度到不同的节点）。但应用层通过 DNS 名称连接——DNS 名称不变，应用的连接配置就不需要变。

> [!info] 为什么必须是 Headless Service
> 普通 Service 的 DNS 解析返回 ClusterIP——所有请求被负载均衡到后端的某个 Pod。这对有状态应用是不行的——从节点需要连接到**特定的**主节点 Pod，而不是"随机一个 Pod"。Headless Service 为每个 Pod 提供独立的 DNS 名称，允许应用精确地连接到特定 Pod。

---

## 第 3 章 PVC 模板与持久存储

### 3.1 volumeClaimTemplates

StatefulSet 通过 `spec.volumeClaimTemplates` 为每个 Pod 创建独立的 PVC：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  replicas: 3
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: "standard"
        resources:
          requests:
            storage: 10Gi
  template:
    spec:
      containers:
        - name: mysql
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql
```

StatefulSet Controller 在创建每个 Pod 时，自动创建对应的 PVC：

```
Pod mysql-0 → PVC data-mysql-0 (10Gi)
Pod mysql-1 → PVC data-mysql-1 (10Gi)
Pod mysql-2 → PVC data-mysql-2 (10Gi)
```

PVC 命名格式：`<volumeClaimTemplate-name>-<statefulset-name>-<ordinal>`

### 3.2 存储绑定的稳定性

**PVC 的生命周期与 Pod 解耦**——当 Pod 被删除并重建时，StatefulSet Controller **不会删除**对应的 PVC。新 Pod（同名）会重新挂载已有的 PVC——从而绑定到同一个底层存储卷，数据完好无损。

```
初始状态：
  mysql-0 → PVC data-mysql-0 → PV pv-abc (10Gi 磁盘)

Pod mysql-0 被删除（节点故障）：
  PVC data-mysql-0 仍然存在，绑定到 PV pv-abc
  磁盘数据不受影响

StatefulSet Controller 重建 mysql-0：
  新 Pod mysql-0 自动挂载 PVC data-mysql-0
  → 绑定到同一个 PV pv-abc → 数据恢复
```

### 3.3 PVC 的保留策略

K8s 1.27 引入了 **PersistentVolumeClaimRetentionPolicy**——允许配置 StatefulSet 缩容或删除时 PVC 的处理方式：

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain    # StatefulSet 被删除时保留 PVC
    whenScaled: Delete     # 缩容时删除多余的 PVC
```

| 策略 | whenDeleted | whenScaled |
| :--- | :--- | :--- |
| **Retain**（默认）| StatefulSet 删除后 PVC 保留（需手动清理）| 缩容后多余的 PVC 保留 |
| **Delete** | StatefulSet 删除后 PVC 自动删除 | 缩容后多余的 PVC 自动删除 |

默认策略是 `Retain`——这是一个安全设计。意外删除 StatefulSet 不会导致数据丢失——PVC 和底层存储卷仍然存在，可以手动恢复。

> [!warning] PVC 残留
> 默认的 Retain 策略意味着缩容或删除 StatefulSet 后，PVC 不会被自动清理。长期运行的集群中可能积累大量"孤儿" PVC 和 PV——占用存储空间和费用。需要定期审计和清理不再需要的 PVC。

---

## 第 4 章 有序创建与删除

### 4.1 有序创建

StatefulSet Controller 按**序号递增的顺序**逐一创建 Pod：

```
1. 创建 mysql-0，等待 mysql-0 变为 Running + Ready
2. 创建 mysql-1，等待 mysql-1 变为 Running + Ready
3. 创建 mysql-2，等待 mysql-2 变为 Running + Ready
```

**"等待 Ready"是关键**——Controller 在前一个 Pod 完全就绪前不会创建下一个 Pod。这保证了数据库集群的初始化顺序——主节点（mysql-0）完全启动后，从节点（mysql-1）才开始启动并连接主节点同步数据。

### 4.2 有序删除

缩容或删除时，Controller 按**序号递减的顺序**逐一删除 Pod：

```
replicas 从 3 缩为 1：
1. 删除 mysql-2，等待 mysql-2 完全终止
2. 删除 mysql-1，等待 mysql-1 完全终止
3. mysql-0 保留
```

先删除最高序号的 Pod——在典型的主从架构中，主节点通常是 Pod-0（最低序号），从节点是高序号。缩容时先删从节点，保留主节点——避免主节点被删除导致集群不可用。

### 4.3 Pod Management Policy

K8s 提供了两种 Pod 管理策略：

**OrderedReady**（默认）：严格有序——按序号顺序创建，逆序删除，前一个 Pod Ready 后才创建下一个。

**Parallel**：并行——所有 Pod 同时创建或删除，不等待 Ready。适用于不需要顺序保证的有状态应用（如每个 Pod 是完全独立的存储节点）。

```yaml
spec:
  podManagementPolicy: Parallel    # 或 OrderedReady（默认）
```

Parallel 策略牺牲了顺序保证，换来更快的创建和删除速度——在 replicas 较多时差异显著（OrderedReady 需要串行等待每个 Pod 就绪，Parallel 可以并行启动所有 Pod）。

---

## 第 5 章 滚动更新

### 5.1 更新策略

StatefulSet 支持两种更新策略：

**RollingUpdate**（默认）：按序号**递减**的顺序逐一更新 Pod——先更新最高序号的 Pod，最后更新 Pod-0。

**OnDelete**：Controller 不自动更新 Pod——用户手动删除 Pod 后，Controller 用新模板重建它。这提供了完全的手动控制——适用于需要人工逐一确认的场景。

### 5.2 滚动更新的顺序

以 `replicas=3` 更新镜像版本为例（RollingUpdate 策略）：

```
初始状态：mysql-0 (v1), mysql-1 (v1), mysql-2 (v1)

步骤 1: 删除 mysql-2 (v1)，等待终止
步骤 2: 创建 mysql-2 (v2)，等待 Ready
步骤 3: 删除 mysql-1 (v1)，等待终止
步骤 4: 创建 mysql-1 (v2)，等待 Ready
步骤 5: 删除 mysql-0 (v1)，等待终止
步骤 6: 创建 mysql-0 (v2)，等待 Ready

最终状态：mysql-0 (v2), mysql-1 (v2), mysql-2 (v2)
```

**为什么从高序号开始更新？** 在主从架构中，Pod-0 通常是主节点——最后更新主节点可以最大程度减少对集群可用性的影响。如果更新过程中发现新版本有问题，可以在更新到主节点之前停止——此时只有部分从节点受影响，主节点仍在正常服务。

### 5.3 分区更新（Partition）

**Partition** 是 StatefulSet 独有的更新控制机制——指定一个序号，只有序号 **≥ partition** 的 Pod 会被更新，序号 < partition 的 Pod 保持旧版本。

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2    # 只更新序号 ≥ 2 的 Pod
```

以 `replicas=5, partition=2` 为例：

```
更新前：mysql-0 (v1), mysql-1 (v1), mysql-2 (v1), mysql-3 (v1), mysql-4 (v1)

执行更新后：
  mysql-0 (v1)  ← 序号 < 2，不更新
  mysql-1 (v1)  ← 序号 < 2，不更新
  mysql-2 (v2)  ← 序号 ≥ 2，更新
  mysql-3 (v2)  ← 序号 ≥ 2，更新
  mysql-4 (v2)  ← 序号 ≥ 2，更新
```

**分区更新的使用场景**：

**金丝雀发布**：先设 `partition=4`（只更新 mysql-4），观察 mysql-4 的运行状况。确认无问题后将 partition 改为 `3`（更新 mysql-3 和 mysql-4），逐步降低 partition 直到 0（全部更新）。

**分阶段更新**：在主从架构中，先更新从节点（partition=1，只更新 Pod-1 及以上），确认从节点正常后再更新主节点（partition=0）。

**部分回滚**：如果更新后发现问题，将 partition 调回高值——Controller 会将已更新的高序号 Pod 保持新版本，不触发回滚。手动删除有问题的 Pod 可以触发用旧模板（partition 以下）或新模板（partition 以上）重建。

### 5.4 maxUnavailable（K8s 1.24+）

K8s 1.24 为 StatefulSet 的 RollingUpdate 引入了 `maxUnavailable` 参数——允许同时更新多个 Pod（默认 1，即严格逐一更新）：

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2    # 同时更新最多 2 个 Pod
```

这在不需要严格顺序的场景下可以加速更新过程。但对于需要严格有序的数据库集群，应保持默认值 1。

---

## 第 6 章 StatefulSet 与 Deployment 的对比

| 维度 | Deployment | StatefulSet |
| :--- | :--- | :--- |
| **适用场景** | 无状态应用（Web 服务、API 服务）| 有状态应用（数据库、消息队列、存储系统）|
| **Pod 命名** | 随机后缀（web-abc123-xyz）| 有序序号（mysql-0, mysql-1）|
| **网络标识** | 无稳定 DNS（Pod 重建后名称和 IP 都变）| 稳定 DNS（通过 Headless Service）|
| **持久存储** | 共享 PVC 或无 PVC | 每个 Pod 独立 PVC（volumeClaimTemplates）|
| **创建顺序** | 并行 | 有序（OrderedReady）或并行（Parallel）|
| **更新机制** | 通过 ReplicaSet 滚动更新 | 直接删除旧 Pod 重建新 Pod |
| **扩缩容** | 任意 Pod 可被删除 | 先删高序号 Pod |
| **回滚** | 基于 ReplicaSet 历史 | 基于 Partition 或 OnDelete 手动控制 |

**关键区别**：Deployment 的滚动更新通过"新 RS 扩容 + 旧 RS 缩容"实现——新旧 Pod 并存。StatefulSet 的滚动更新是**原地替换**——删除旧 Pod，用新模板创建同名新 Pod。这保证了 Pod 的稳定标识（名称、PVC 绑定）在更新过程中不变。

---

## 第 7 章 生产实践

### 7.1 数据库集群的典型配置

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql
  replicas: 3
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
      maxUnavailable: 1
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: "ssd"
        resources:
          requests:
            storage: 100Gi
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: mysql
          image: mysql:8.0
          ports:
            - containerPort: 3306
          readinessProbe:
            exec:
              command: ["mysqladmin", "ping"]
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["mysqladmin", "ping"]
            initialDelaySeconds: 30
            periodSeconds: 10
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql
```

### 7.2 常见陷阱

**陷阱一：忘记创建 Headless Service**。StatefulSet 的 `spec.serviceName` 必须指向一个已存在的 Headless Service，否则 Pod 的 DNS 记录不会被创建——应用无法通过 DNS 名称互相发现。

**陷阱二：PVC 的 StorageClass 不支持动态供给**。如果 StorageClass 没有配置 Provisioner 或者 Provisioner 不支持动态创建 PV，StatefulSet 创建 PVC 后找不到可绑定的 PV——Pod 会一直卡在 Pending 状态。

**陷阱三：terminationGracePeriodSeconds 太短**。数据库进程在关闭时需要刷写缓冲区、关闭连接、清理锁文件。默认的 30 秒可能不够——MySQL 在大事务进行中关闭可能需要 60 秒以上。如果 gracePeriod 太短，Pod 被强制杀死，可能导致数据损坏。

**陷阱四：缩容后不清理 PVC**。默认的 Retain 策略意味着缩容后 PVC 不会被删除——底层的云磁盘持续计费。需要手动或通过自动化脚本清理不再需要的 PVC。

---

## 第 8 章 总结

本文深入剖析了 StatefulSet Controller 的工作机制：

- **三个保证**：稳定网络标识（有序命名 + Headless Service DNS）、稳定持久存储（PVC 模板 + Pod-PVC 绑定）、有序操作
- **Pod 命名**：`<name>-<ordinal>` 格式，序号固定，Pod 重建后名称不变
- **Headless Service**：为每个 Pod 创建独立的 DNS A 记录，支持精确连接到特定 Pod
- **PVC 模板**：每个 Pod 独立 PVC，Pod 删除后 PVC 保留，重建后重新绑定——数据不丢失
- **有序操作**：OrderedReady 策略下按序号顺序创建、逆序删除和更新
- **分区更新**：Partition 机制支持金丝雀发布和分阶段更新
- **生产实践**：配置 readinessProbe、充足的 terminationGracePeriodSeconds、合适的 StorageClass

下一篇 [[04 DaemonSet Job CronJob 控制器解析]] 将分析另外三种工作负载控制器。

---

## 参考资料

1. Kubernetes Documentation - StatefulSets：https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
2. Kubernetes Documentation - StatefulSet Basics：https://kubernetes.io/docs/tutorials/stateful-application/basic-stateful-set/
3. Kubernetes Source Code - pkg/controller/statefulset：https://github.com/kubernetes/kubernetes/tree/master/pkg/controller/statefulset
4. Kubernetes Enhancement Proposal - StatefulSet Slice：https://github.com/kubernetes/enhancements/tree/master/keps/sig-apps/961-maxunavailable-for-statefulset
5. Kubernetes Documentation - PVC Retention Policy：https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#persistentvolumeclaim-retention

---

> [!note] 思考题
> 1. HPA（Horizontal Pod Autoscaler）根据指标（CPU、内存、自定义指标）自动调整 Pod 副本数。默认使用 CPU 利用率——`targetAverageUtilization: 50%` 在 CPU 使用超过 50% 时扩容。但 CPU 利用率的采集有延迟（Metrics Server 每 15 秒采集一次）——在流量突增时 HPA 的反应速度如何？`--horizontal-pod-autoscaler-sync-period` 如何调优？
> 2. VPA（Vertical Pod Autoscaler）自动调整 Pod 的资源请求（request/limit）——适合资源需求波动但副本数不应变化的场景。但 VPA 更新资源请求需要重启 Pod——这对有状态服务（如数据库）是否可接受？VPA 的'In-place Resize'（原地调整不重启，Kubernetes 1.27+ alpha）如何解决？
> 3. HPA 和 VPA 同时使用时可能冲突——HPA 基于 CPU 扩容，VPA 同时增大 CPU request——两者可能相互干扰。官方建议不要让 HPA 和 VPA 同时管理同一个指标。在什么场景下你需要同时使用 HPA（水平扩展）和 VPA（垂直调整）？Multidimensional Pod Autoscaler（MPA）是否是更好的方案？
