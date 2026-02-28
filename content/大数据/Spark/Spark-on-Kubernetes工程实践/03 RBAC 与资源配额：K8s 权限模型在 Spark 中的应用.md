---
title: "RBAC 与资源配额：K8s 权限模型在 Spark 中的应用"
date: 2026-02-28
tags: [Spark, Kubernetes, RBAC, ServiceAccount, ResourceQuota, LimitRange, 权限, 多租户, 命名空间]
aliases: []
---

# 03 RBAC 与资源配额：K8s 权限模型在 Spark 中的应用

## 摘要

Spark on Kubernetes 的 Driver 在运行期间需要动态创建和删除 Executor Pod——这意味着 Driver 进程本身需要持有调用 K8s API 的权限。在 [[Kubernetes]] 的 RBAC（Role-Based Access Control）体系中，这通过 **ServiceAccount + Role + RoleBinding** 三件套来实现。权限配置看似简单，却有两个容易犯错的方向：一是**权限过大**（直接使用 `cluster-admin`，Driver 拥有操作整个 K8s 集群的权限，安全风险极高）；二是**权限不足**（缺少某些操作的权限，Driver 无法创建 Executor Pod 或 Watch Pod 状态，作业失败）。本文精确给出 Spark Driver 所需的最小 RBAC 权限集合，讲解 [[Kubernetes Namespace|Namespace]] 隔离多个 Spark 团队的方案，以及 ResourceQuota 和 LimitRange 如何防止单个作业或单个团队耗尽集群资源，实现生产级的 Spark on K8s 多租户资源管控。

---

## 第 1 章 K8s RBAC 核心概念回顾

### 1.1 RBAC 的四个核心对象

| 对象 | 作用 |
|-----|-----|
| **ServiceAccount** | Pod 的"身份证"——Pod 以某个 ServiceAccount 的身份调用 K8s API |
| **Role**（命名空间级）| 在指定 Namespace 内，允许对哪些资源做哪些操作 |
| **ClusterRole**（集群级）| 与 Role 类似，但作用域是整个集群 |
| **RoleBinding** | 将 Role 绑定到 ServiceAccount（授权）|
| **ClusterRoleBinding** | 将 ClusterRole 绑定到 ServiceAccount（全集群授权）|

**最小权限原则**：为 Spark Driver 创建专用的 ServiceAccount，只赋予它完成任务所需的最小权限，不使用 `default` ServiceAccount（可能权限过大或被其他应用复用）。

### 1.2 Spark Driver 需要哪些 K8s 权限

Spark Driver 在运行期间需要执行以下 K8s API 操作：

| 操作 | API 资源 | 动词 | 用途 |
|-----|---------|-----|-----|
| 创建 Executor Pod | `pods` | `create` | 申请新 Executor |
| 删除 Executor Pod | `pods` | `delete` | 释放完成/失败的 Executor |
| 获取 Pod 状态 | `pods` | `get`, `list` | 检查 Executor 是否 Ready |
| 监听 Pod 变化 | `pods` | `watch` | 实时感知 Executor Pod 的状态变化（Ready/Failed/OOMKilled）|
| 读取 Pod 日志 | `pods/log` | `get` | 获取 Executor 日志（可选，用于故障诊断）|
| 创建 ConfigMap | `configmaps` | `create`, `get`, `delete` | 存储 Spark 配置（如 `spark.kubernetes.hadoop.configMapName`）|
| 创建 Service | `services` | `create`, `get`, `delete` | Driver 对外暴露 Spark UI（如果配置了 Service）|

---

## 第 2 章 生产级 RBAC 配置

### 2.1 创建专用 ServiceAccount

```yaml
# spark-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spark-driver-sa        # Spark Driver 专用 ServiceAccount
  namespace: spark-production  # 限定在 spark-production Namespace
  labels:
    app: spark
    team: data-platform
```

### 2.2 创建最小权限 Role

```yaml
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: spark-driver-role
  namespace: spark-production
rules:
  # Executor Pod 的完整生命周期管理
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "list", "watch", "delete", "patch"]
  
  # 读取 Pod 日志（可选，方便故障排查时直接获取 Executor 日志）
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list"]
  
  # ConfigMap 管理（Spark 用于存储 Hadoop 配置等）
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "get", "update", "delete"]
  
  # Service 管理（如果需要为 Driver 创建 Service 暴露 Spark UI）
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["create", "get", "delete"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: spark-driver-rolebinding
  namespace: spark-production
subjects:
  - kind: ServiceAccount
    name: spark-driver-sa
    namespace: spark-production
roleRef:
  kind: Role
  apiRef: spark-driver-role
  apiGroup: rbac.authorization.k8s.io
```

```bash
# 应用 RBAC 配置
kubectl apply -f spark-rbac.yaml

# 验证：测试 ServiceAccount 的权限
kubectl auth can-i create pods \
  --as=system:serviceaccount:spark-production:spark-driver-sa \
  --namespace=spark-production
# 期望输出：yes

kubectl auth can-i delete nodes \
  --as=system:serviceaccount:spark-production:spark-driver-sa
# 期望输出：no（不应有集群级节点操作权限）
```

### 2.3 spark-submit 使用 ServiceAccount

```bash
spark-submit \
  --master k8s://https://k8s-api:6443 \
  --deploy-mode cluster \
  --conf spark.kubernetes.namespace=spark-production \
  --conf spark.kubernetes.authenticate.driver.serviceAccountName=spark-driver-sa \
  ...
```

---

## 第 3 章 Namespace 隔离多团队

### 3.1 多团队隔离方案

生产中通常有多个团队共享同一个 K8s 集群：数据工程团队、算法团队、实时团队。为每个团队创建独立的 Namespace，实现资源和权限的隔离：

```
Cluster
├── Namespace: spark-data-eng    # 数据工程团队
│   ├── ServiceAccount: spark-driver-sa
│   ├── ResourceQuota: data-eng-quota
│   └── LimitRange: data-eng-limits
│
├── Namespace: spark-ml          # 算法团队
│   ├── ServiceAccount: spark-driver-sa
│   ├── ResourceQuota: ml-quota
│   └── LimitRange: ml-limits
│
└── Namespace: spark-realtime    # 实时团队
    ├── ServiceAccount: spark-driver-sa
    ├── ResourceQuota: realtime-quota
    └── LimitRange: realtime-limits
```

每个 Namespace 内的 RBAC 配置独立：`spark-data-eng` Namespace 的 `spark-driver-sa` 只能在该 Namespace 内创建 Pod，无法操作其他 Namespace 的资源。

---

## 第 4 章 ResourceQuota：防止资源耗尽

### 4.1 ResourceQuota 是什么，为什么需要

**ResourceQuota** 是 K8s 在 Namespace 级别对资源消耗设置上限的机制。没有 ResourceQuota，一个团队（或一个失控的作业）可以创建大量 Pod，耗尽整个集群的 CPU 和内存，影响其他所有团队。

ResourceQuota 限制的维度：
- **计算资源**：CPU 和内存的 `requests` 总量上限、`limits` 总量上限
- **对象数量**：Pod 数量、Service 数量、ConfigMap 数量等
- **存储**：PVC 数量、存储总量

### 4.2 为 Spark Namespace 配置 ResourceQuota

```yaml
# 数据工程团队的资源配额
apiVersion: v1
kind: ResourceQuota
metadata:
  name: data-eng-quota
  namespace: spark-data-eng
spec:
  hard:
    # 计算资源上限（requests 维度，这是 K8s 调度的依据）
    requests.cpu: "200"          # 最多 200 个 CPU 核（requests 总量）
    requests.memory: "400Gi"     # 最多 400GB 内存（requests 总量）
    limits.cpu: "400"            # limits 上限可以更大（允许超用）
    limits.memory: "800Gi"
    
    # Pod 数量上限
    pods: "500"                  # 最多 500 个 Pod（防止 Executor 暴增）
    
    # 其他对象数量上限
    configmaps: "200"
    services: "50"
```

**ResourceQuota 的生效机制**：当 Namespace 内的资源消耗（所有运行中 Pod 的 `requests.cpu` 之和）超过 Quota 时，新创建的 Pod 会被拒绝（`exceeded quota`），而不是直接调度失败——从而保护其他 Namespace 的资源不被抢占。

### 4.3 ResourceQuota 对 Spark 的影响

如果 Spark Driver 申请 100 个 Executor Pod，但 Namespace 的 ResourceQuota 只允许再创建 20 个 Pod（已有 480/500 个 Pod），Driver 会收到 K8s API 的 `403 Forbidden`，并反映为 Executor 申请失败。

Spark 的处理策略：Dynamic Allocation 会在 Executor 申请失败时降低申请数量，只使用实际能申请到的 Executor 数（作业仍能运行，只是并行度降低）。

---

## 第 5 章 LimitRange：防止资源滥用

### 5.1 LimitRange 的作用

**LimitRange** 在 Namespace 级别为每个 Pod/Container 设置资源的**默认值和上下限**。

**为什么需要 LimitRange**：

1. **防止无资源 `requests` 的 Pod**：如果 Pod 不设置 `resources.requests`，K8s 以 0 资源调度它（`BestEffort` QoS），可能被调度到资源不足的节点，并在节点内存压力时被优先杀掉
2. **限制单个 Pod 的资源上限**：防止一个 Spark Executor 申请 100 CPU（显然是配置错误），耗尽单个节点资源
3. **为未设置资源的 Pod 注入默认值**：新用户可能忘记设置资源请求，LimitRange 自动注入合理默认值

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: data-eng-limits
  namespace: spark-data-eng
spec:
  limits:
    - type: Container
      # 单个 Container 的资源上限
      max:
        cpu: "32"           # 单 Container 最多 32 CPU（防止配置错误）
        memory: "64Gi"      # 单 Container 最多 64GB 内存
      # 单个 Container 的资源下限
      min:
        cpu: "100m"         # 最少 0.1 CPU（防止 0 资源 Pod）
        memory: "256Mi"
      # 未设置 requests 时的默认值（自动注入）
      defaultRequest:
        cpu: "1"
        memory: "4Gi"
      # 未设置 limits 时的默认值
      default:
        cpu: "4"
        memory: "8Gi"
      # limits/requests 的最大比值（防止 limits 远大于 requests）
      maxLimitRequestRatio:
        cpu: "4"            # limits.cpu ≤ requests.cpu × 4
        memory: "2"         # limits.memory ≤ requests.memory × 2
```

### 5.2 ResourceQuota + LimitRange 协同工作

两者配合，构成完整的资源管控：

```
LimitRange（微观层面）：控制每个 Pod/Container 的资源边界
ResourceQuota（宏观层面）：控制整个 Namespace 的资源总量

Example（数据工程团队）：
  LimitRange：每个 Executor Container 最多 16 CPU, 32Gi 内存
  ResourceQuota：整个 Namespace 最多 200 CPU, 400Gi 内存
  → 即使单个 Executor 申请 16 CPU，整个 Namespace 最多跑 200/16=12 个这样的 Executor
  → 有效防止少数大作业独占资源
```

---

## 小结

Spark on K8s 的权限与资源管控体系：

- **最小权限 RBAC**：为 Spark Driver 创建专用 ServiceAccount，只赋予 `pods`/`configmaps`/`services` 的 CRUD + Watch 权限；绝不使用 `cluster-admin`
- **Namespace 隔离多团队**：每个团队独立 Namespace，权限和配额互不干扰
- **ResourceQuota**：Namespace 级资源总量上限，防止单团队/单作业耗尽集群；Pod 数量限制防止 Executor 暴增
- **LimitRange**：Container 级资源上下限 + 默认值注入，防止配置错误（0 资源 Pod）和资源滥用（超大 Pod）

第 04 篇深入 Driver 与 Executor Pod 的生命周期：Pod 从创建到调度到 Running 的完整时序、Executor 心跳超时的处理机制、动态资源分配（DRA）在 K8s 上的实现细节，以及 PriorityClass 如何在资源竞争时保护关键作业的 Executor。

---

## 参考资料

- Kubernetes 官方文档：RBAC Authorization
- Kubernetes 官方文档：Resource Quotas
- Kubernetes 官方文档：Limit Ranges
- Apache Spark 官方文档：Kubernetes RBAC
