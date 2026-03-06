---
title: "03 API 对象模型与 GVR 体系"
date: 2026-03-04
tags: [云原生, Kubernetes, API, GVR, GVK, CRD, REST, 对象模型, TypeMeta, ObjectMeta]
aliases: []
---

# 03 API 对象模型与 GVR 体系

**摘要：**

在 [[02 Kubernetes 整体架构]] 中我们看到，K8s 的所有组件都通过 API Server 的 RESTful API 进行交互。但 K8s 的 API 并非一组零散的接口——它背后有一套精心设计的**统一对象模型**。无论是 Pod、Deployment、Service 还是用户自定义的 CRD 资源，它们共享完全相同的结构骨架：`TypeMeta`（我是什么类型）、`ObjectMeta`（我叫什么名字、属于哪个 Namespace、有哪些标签）、`Spec`（用户期望什么）、`Status`（当前是什么状态）。同时，K8s 用 **GVR（Group-Version-Resource）** 和 **GVK（Group-Version-Kind）** 两套坐标系统来唯一标识每种 API 资源——理解 GVR/GVK 是理解 K8s API 路径设计、客户端代码生成、CRD 扩展机制的前提。本文从"为什么需要统一的对象模型"出发，逐层剖析 API 对象的四段式结构，然后深入 GVR/GVK 体系的命名逻辑和演进机制，最后介绍 CRD 如何让用户在不修改 K8s 源码的情况下扩展 API。

---

## 第 1 章 为什么需要统一的对象模型

### 1.1 如果没有统一模型

想象一个没有统一对象模型的编排系统——每种资源都有自己独特的数据结构：

- Pod 有 `name` 字段，Deployment 有 `deployment_name` 字段，Service 有 `svc_id` 字段
- Pod 的创建时间叫 `created_at`，Deployment 的叫 `creation_timestamp`，Service 的叫 `create_time`
- Pod 用 JSON 标签 `{"app": "nginx"}`，Deployment 用逗号分隔的字符串 `"app=nginx,env=prod"`

这种混乱会导致：

**工具无法通用**：`kubectl` 需要为每种资源编写不同的展示逻辑——获取 Pod 的名字用 `.name`，获取 Deployment 的名字用 `.deployment_name`。每新增一种资源，kubectl 就需要更新代码。

**控制器无法通用**：垃圾回收器（Garbage Collector）需要知道"哪个对象拥有哪个对象"——如果每种资源用不同的字段表达所有权关系，垃圾回收器需要为每种资源编写特殊的解析逻辑。

**客户端库无法生成**：如果每种资源的结构不同，无法用统一的代码生成框架（如 `client-gen`）自动生成各语言的 API 客户端。

### 1.2 K8s 的解决方案

K8s 定义了一套**所有 API 资源都必须遵守的统一结构**。无论是内置的 Pod 还是用户自定义的 CRD 资源，它们在 API 层面的行为都是一致的：

- 都有 `metadata.name`、`metadata.namespace`、`metadata.labels`
- 都有 `metadata.resourceVersion` 用于乐观并发控制
- 都支持 `kubectl get`、`kubectl describe`、`kubectl delete`
- 都可以被 Watch、被 Label Selector 过滤、被 Garbage Collector 管理

这种统一性使得 K8s 的工具链、控制器框架和客户端库可以**面向通用的对象模型编程**，而不需要了解每种具体资源的内部细节。

---

## 第 2 章 API 对象的四段式结构

### 2.1 四个组成部分

每个 K8s API 对象由四部分组成：

```yaml
apiVersion: apps/v1            # ┐
kind: Deployment               # ┘ TypeMeta：类型信息
metadata:                      # ─ ObjectMeta：元数据
  name: web
  namespace: default
  labels:
    app: nginx
  resourceVersion: "12345"
  uid: "abc-def-123"
  creationTimestamp: "2026-03-04T10:00:00Z"
  ownerReferences: []
spec:                          # ─ Spec：期望状态（用户定义）
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    spec:
      containers:
        - name: nginx
          image: nginx:1.25
status:                        # ─ Status：当前状态（系统填写）
  replicas: 3
  readyReplicas: 3
  availableReplicas: 3
```

### 2.2 TypeMeta：我是什么类型

TypeMeta 包含两个字段：

- **`apiVersion`**：API 组和版本的组合（如 `apps/v1`、`v1`、`batch/v1`）
- **`kind`**：资源的种类（如 `Deployment`、`Pod`、`Service`）

这两个字段联合起来唯一标识资源的类型。API Server 根据 TypeMeta 将请求路由到正确的处理逻辑——收到一个 `kind: Deployment, apiVersion: apps/v1` 的请求，就交给 Deployment 的 handler 处理。

一个容易混淆的地方：核心资源（Pod、Service、ConfigMap 等）的 `apiVersion` 是 `v1`（没有组名），而非核心资源（Deployment、StatefulSet 等）的 `apiVersion` 是 `<组名>/<版本>`（如 `apps/v1`）。这是历史原因——K8s 最初所有资源都在核心组（core group）中，后来为了可管理性引入了 API 组的概念，但核心资源保留了无组名的 `v1`。

### 2.3 ObjectMeta：我的身份信息

ObjectMeta 是所有 K8s 对象**共享的元数据结构**。它包含的字段非常丰富，每个字段都有明确的设计目的：

#### 身份标识

| 字段 | 说明 |
| :--- | :--- |
| **`name`** | 对象名称，在同一 Namespace + 同一资源类型下唯一 |
| **`namespace`** | 所属 Namespace（集群级资源如 Node、ClusterRole 无此字段）|
| **`uid`** | 全局唯一的 UUID，由 API Server 在创建时自动生成。即使删除后重新创建同名对象，UID 也不同 |

`name` + `namespace` + `resource type` 构成了对象的"逻辑标识"——在同一个 Namespace 中不能有两个同名的 Deployment。但 `uid` 是"物理标识"——即使删除后重建同名对象，新对象的 uid 也与旧的不同。Garbage Collector 使用 uid（而非 name）来判断 OwnerReference 的有效性——如果 Owner 被删除后重建（uid 变了），旧的 OwnerReference 不再匹配，被关联的子对象会被垃圾回收。

#### 并发控制

| 字段 | 说明 |
| :--- | :--- |
| **`resourceVersion`** | 对象在 [[etcd]] 中的版本号（对应 etcd 的 revision）。每次对象被修改，resourceVersion 都会递增 |
| **`generation`** | spec 部分被修改的次数。只有 spec 变更会递增 generation，status 变更不会 |

**`resourceVersion`** 是 K8s 乐观并发控制的核心。更新一个对象时，客户端必须在请求中携带当前的 resourceVersion。API Server 在写入 etcd 时检查——如果 etcd 中的实际 resourceVersion 与请求中的不一致（说明有其他人在你读取之后修改了该对象），更新会被拒绝（409 Conflict）。客户端需要重新读取最新版本，合并自己的变更，再次尝试更新。

```
时刻1：Client A 读取 Pod（resourceVersion=100）
时刻2：Client B 读取 Pod（resourceVersion=100）
时刻3：Client A 更新 Pod（携带 resourceVersion=100）→ 成功，resourceVersion 变为 101
时刻4：Client B 更新 Pod（携带 resourceVersion=100）→ 失败！因为当前 resourceVersion 是 101
时刻5：Client B 重新读取 Pod（resourceVersion=101），合并变更，重新更新 → 成功
```

这种机制确保了在多个组件（控制器、用户）同时修改同一个对象时不会互相覆盖——这对于 K8s 的声明式协调至关重要。

#### 关联与组织

| 字段 | 说明 |
| :--- | :--- |
| **`labels`** | 键值对标签，用于 Selector 过滤和逻辑关联 |
| **`annotations`** | 键值对注解，用于存储非结构化的元数据（不可被 Selector 过滤）|
| **`ownerReferences`** | 该对象的"所有者"列表（用于级联删除）|
| **`finalizers`** | 删除保护——对象被删除前必须先清空 finalizers |

`labels` 和 `annotations` 的区别是 K8s 中一个常见的困惑点：

- **labels** 是有语义的——可以被 Selector 过滤（如 `kubectl get pods -l app=nginx`），被 Service 用来关联后端 Pod，被 ReplicaSet 用来关联其管理的 Pod。labels 的 key 和 value 有长度限制（63 字符），不能包含任意内容。
- **annotations** 是无语义的——不能被 Selector 过滤，只是附着在对象上的键值对元数据。常用于存储构建信息（`build.version: "abc123"`）、配置提示（`prometheus.io/scrape: "true"`）、变更记录等。annotations 的 value 可以是任意字符串，长度限制更宽松（256KB）。

> [!note] 设计原则
> **如果你需要基于某个键值对来选择或过滤对象，用 label。如果你只是想附着一些辅助信息，用 annotation。** 滥用 label（在 label 中存储大量非选择用的数据）会降低 etcd 和 API Server 的性能——因为 label 需要被索引以支持高效的 Selector 查询。

#### 生命周期

| 字段 | 说明 |
| :--- | :--- |
| **`creationTimestamp`** | 对象创建时间（API Server 自动设置）|
| **`deletionTimestamp`** | 对象被请求删除的时间（设置后对象进入"Terminating"状态）|
| **`deletionGracePeriodSeconds`** | 优雅删除的等待时间 |

当用户执行 `kubectl delete pod nginx` 时，API Server 不会立即从 etcd 中删除 Pod 对象。它先设置 `deletionTimestamp`，Pod 进入 "Terminating" 状态。kubelet 看到 `deletionTimestamp` 后开始优雅停机流程（发送 SIGTERM、等待 `terminationGracePeriodSeconds`）。只有当 Pod 中的所有容器都已停止，并且 `finalizers` 列表为空时，API Server 才真正从 etcd 中删除该对象。

### 2.4 Spec 与 Status 的分离

在 [[01 Kubernetes 的诞生与设计哲学]] 中已经介绍了 spec/status 分离的设计哲学。这里从 API 机制的角度补充几个关键细节：

**写入权限的分离**：spec 由用户编写（通过 kubectl apply 或 API 客户端），status 由控制器更新（通过 `/status` 子资源 API）。API Server 对这两者使用不同的准入控制逻辑——用户更新 spec 时需要通过所有准入控制器的校验，控制器更新 status 时走的是 `/status` 子资源的专用路径，不触发大部分准入控制（避免相互干扰）。

**子资源 API**：K8s 对 spec 和 status 的更新使用不同的 API 路径：

```
# 更新 spec（用户操作）
PUT /apis/apps/v1/namespaces/default/deployments/web

# 更新 status（控制器操作）
PUT /apis/apps/v1/namespaces/default/deployments/web/status
```

这种分离确保了用户更新 spec 时不会意外覆盖控制器正在更新的 status，反之亦然。

**不是所有资源都有 status**：ConfigMap、Secret 等"纯数据"资源没有 status 字段——它们没有"当前状态"的概念，只存储用户提供的数据。

---

## 第 3 章 GVR 与 GVK：API 资源的坐标系统

### 3.1 为什么需要 GVR/GVK

K8s 有数十种内置资源（Pod、Deployment、Service、ConfigMap……），加上用户通过 CRD 定义的自定义资源，总数可能达到上百种。每种资源需要一个**唯一的标识符**，同时还需要支持**版本演进**（同一种资源可能有 v1alpha1、v1beta1、v1 等多个版本同时存在）。

K8s 使用两套坐标系统来标识资源：

- **GVR（Group-Version-Resource）**：用于 RESTful API 路径，标识一类资源的 HTTP 端点
- **GVK（Group-Version-Kind）**：用于对象内部的类型标识（即 `apiVersion` + `kind`）

### 3.2 GVR：API 路径的坐标

**GVR** 由三部分组成：

| 组成 | 说明 | 示例 |
| :--- | :--- | :--- |
| **Group（组）** | 一组逻辑相关的资源的集合 | `apps`、`batch`、`networking.k8s.io`、`""` (核心组) |
| **Version（版本）** | API 的版本号 | `v1`、`v1beta1`、`v1alpha1` |
| **Resource（资源）** | 资源的复数名称（用于 URL 路径）| `pods`、`deployments`、`services` |

GVR 直接映射为 API Server 的 RESTful URL：

```
# 核心组资源（Group 为空）
GET /api/v1/namespaces/default/pods
     ├── /api         ← 核心组使用 /api 前缀
     ├── /v1          ← Version
     └── /pods        ← Resource（复数）

# 非核心组资源
GET /apis/apps/v1/namespaces/default/deployments
     ├── /apis        ← 非核心组使用 /apis 前缀
     ├── /apps        ← Group
     ├── /v1          ← Version
     └── /deployments ← Resource（复数）

# 集群级资源（无 Namespace）
GET /api/v1/nodes
GET /apis/rbac.authorization.k8s.io/v1/clusterroles
```

### 3.3 GVK：对象类型的坐标

**GVK** 也由三部分组成：

| 组成 | 说明 | 示例 |
| :--- | :--- | :--- |
| **Group** | 与 GVR 相同 | `apps`、`batch` |
| **Version** | 与 GVR 相同 | `v1`、`v1beta1` |
| **Kind** | 资源的单数类型名称（用于对象定义中）| `Pod`、`Deployment`、`Service` |

GVK 出现在 YAML 文件的 `apiVersion` + `kind` 字段中：

```yaml
apiVersion: apps/v1    # Group=apps, Version=v1
kind: Deployment       # Kind=Deployment
```

### 3.4 GVR 与 GVK 的关系

GVR 和 GVK 之间有对应关系，但**不是简单的一对一**：

| GVK | GVR |
| :--- | :--- |
| `apps/v1/Deployment` | `apps/v1/deployments` |
| `/v1/Pod` | `/v1/pods` |
| `/v1/Service` | `/v1/services` |

通常 Resource = Kind 的小写复数形式。但也有例外——`Endpoints` 的 Kind 是 `Endpoints`（本身就是复数），Resource 也是 `endpoints`。

K8s 内部通过 **RESTMapper** 组件维护 GVR ↔ GVK 的映射关系。当你执行 `kubectl get deployment` 时，kubectl 先通过 RESTMapper 将 Kind `Deployment` 映射为 Resource `deployments`，然后构造 API URL `/apis/apps/v1/namespaces/default/deployments` 发送请求。

### 3.5 API Group 的设计目的

API Group 不仅仅是命名空间——它有明确的设计目的：

**模块化**：不同团队可以独立开发和维护不同的 API Group。`apps` 组由 SIG-Apps 维护，`networking.k8s.io` 组由 SIG-Network 维护。

**独立版本演进**：每个 Group 内的资源可以独立地从 alpha → beta → stable 演进。`batch/v1` 的 Job 达到 stable 时，`autoscaling/v2` 可能还在 beta。

**访问控制粒度**：RBAC 规则可以按 API Group 授权——"允许用户读取 `apps` 组的所有资源，但不能访问 `rbac.authorization.k8s.io` 组"。

常见的 API Group：

| Group | 包含的资源 |
| :--- | :--- |
| **core（`""`）** | Pod, Service, ConfigMap, Secret, Namespace, Node, PersistentVolume |
| **apps** | Deployment, StatefulSet, DaemonSet, ReplicaSet |
| **batch** | Job, CronJob |
| **networking.k8s.io** | Ingress, IngressClass, NetworkPolicy |
| **rbac.authorization.k8s.io** | Role, ClusterRole, RoleBinding, ClusterRoleBinding |
| **storage.k8s.io** | StorageClass, CSIDriver, VolumeAttachment |
| **autoscaling** | HorizontalPodAutoscaler |

---

## 第 4 章 API 版本演进

### 4.1 版本级别

K8s 的 API 版本遵循严格的成熟度级别：

| 级别 | 命名规范 | 含义 | 稳定性保证 |
| :--- | :--- | :--- | :--- |
| **Alpha** | `v1alpha1`, `v2alpha1` | 实验性功能，默认禁用 | 无。可能在任何版本中被修改或删除，不保证向后兼容 |
| **Beta** | `v1beta1`, `v2beta1` | 经过充分测试，默认启用 | 较强。跨版本升级时提供迁移路径，但 API 结构可能微调 |
| **Stable** | `v1`, `v2` | 正式发布 | 强保证。遵循 K8s 的弃用策略（GA API 至少保留 12 个月或 3 个 K8s 次版本）|

### 4.2 多版本共存

同一种资源可以同时有多个版本的 API。例如 `HorizontalPodAutoscaler` 同时有 `autoscaling/v1` 和 `autoscaling/v2`：

```bash
# 两个版本的 API 同时可用
kubectl get hpa.v1.autoscaling         # 旧版 API
kubectl get hpa.v2.autoscaling         # 新版 API（更多字段）
```

但在 [[etcd]] 中，对象只存储一份——使用**存储版本（Storage Version）** 序列化。当通过非存储版本的 API 读写对象时，API Server 在读取时自动将存储版本转换为请求的版本（反之亦然）。这个转换通过 API Server 内部的 **conversion webhook** 或内置转换函数完成。

### 4.3 弃用策略

K8s 有严格的 API 弃用策略：

- **GA（Stable）API**：宣布弃用后，至少保留 12 个月或 3 个 K8s 次版本（取较长者）
- **Beta API**：至少保留 9 个月或 3 个次版本
- **Alpha API**：可以在任何版本中直接移除

实际操作中，当一个 API 版本被弃用后，使用该版本的请求仍然可以成功，但 API Server 会返回一个 `Warning` HTTP Header 提醒客户端迁移。`kubectl` 会将这个警告显示给用户。

---

## 第 5 章 CRD：扩展 K8s API 的标准机制

### 5.1 什么是 CRD

**CRD（Custom Resource Definition）** 允许用户在不修改 K8s 源码、不重新编译 API Server 的情况下，向 K8s 注册全新的 API 资源类型。注册后，新资源的行为与内置资源完全一致——支持 `kubectl get`/`create`/`delete`、支持 Watch、支持 RBAC 授权、支持 Label Selector。

一个简单的 CRD 示例——定义一个 `Database` 资源：

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.example.com
spec:
  group: example.com
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                engine:
                  type: string
                  enum: ["mysql", "postgresql", "redis"]
                version:
                  type: string
                replicas:
                  type: integer
                  minimum: 1
            status:
              type: object
              properties:
                phase:
                  type: string
                endpoint:
                  type: string
      subresources:
        status: {}     # 启用 /status 子资源
  scope: Namespaced
  names:
    plural: databases
    singular: database
    kind: Database
    shortNames:
      - db
```

注册这个 CRD 后，用户就可以创建 `Database` 对象：

```yaml
apiVersion: example.com/v1
kind: Database
metadata:
  name: my-mysql
  namespace: default
spec:
  engine: mysql
  version: "8.0"
  replicas: 3
```

```bash
kubectl get databases           # 或 kubectl get db
kubectl describe db my-mysql
kubectl delete db my-mysql
```

### 5.2 CRD 的局限

CRD 只解决了"定义新的 API 资源"的问题——它让 API Server 能够存储和检索新类型的对象。但 **CRD 本身不包含任何业务逻辑**——没有控制器去协调 `Database` 对象的 spec 和 status。

要让 `Database` 资源真正"做事"（比如创建 MySQL 的 StatefulSet、配置主从复制、处理故障转移），需要编写一个**自定义控制器**来 Watch `Database` 对象并执行相应的协调逻辑。

**CRD + 自定义控制器 = Operator 模式**。这是 K8s 生态中最重要的扩展机制——Prometheus Operator、MySQL Operator、Kafka Operator 都是这个模式的实践。我们将在 [[06 Operator 模式与自定义控制器]] 中详细展开。

### 5.3 CRD vs Aggregated API Server

CRD 并非扩展 K8s API 的唯一方式。另一种方式是 **Aggregated API Server（聚合 API 服务器）**——部署一个独立的 API Server，通过 K8s 的 API Aggregation Layer 将其注册为 K8s API 的一部分。

| 维度 | CRD | Aggregated API Server |
| :--- | :--- | :--- |
| **部署复杂度** | 低（只需提交一个 YAML）| 高（需要部署独立的服务）|
| **功能灵活性** | 中（受限于 CRD 的 schema 和 subresource 能力）| 高（完全自定义的 API 行为）|
| **存储** | 使用 K8s 的 etcd | 可以使用自己的存储后端 |
| **典型场景** | 大多数 Operator | Metrics API（metrics-server）、service-catalog |

绝大多数情况下 CRD 就足够了。只有需要自定义存储后端、自定义 API 行为（如复杂的子资源、流式接口）时才考虑 Aggregated API Server。

---

## 第 6 章 kubectl 与 API 的交互

### 6.1 kubectl 的工作原理

`kubectl` 是 K8s 的命令行客户端，它的核心工作是：

1. 解析用户命令（如 `kubectl get pods -n default`）
2. 通过 **Discovery API**（`/api` 和 `/apis`）获取集群支持的 API 资源列表
3. 通过 **RESTMapper** 将用户输入的资源名称映射为 GVR
4. 构造 RESTful HTTP 请求发送给 API Server
5. 解析响应并格式化输出

```bash
# kubectl get pods 的实际 HTTP 请求
GET /api/v1/namespaces/default/pods
Accept: application/json
Authorization: Bearer <token>
```

### 6.2 Discovery API

API Server 暴露了两个 Discovery 端点：

- **`/api`**：列出核心组的所有版本
- **`/apis`**：列出所有非核心组及其版本

```bash
# 查看所有可用的 API 资源
kubectl api-resources
# NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND
# pods          po           v1           true         Pod
# deployments   deploy       apps/v1      true         Deployment
# services      svc          v1           true         Service
# ...
```

这也是为什么 CRD 注册后 `kubectl` 能立即识别新资源——`kubectl` 每次执行命令时都会查询 Discovery API（并缓存结果），CRD 注册后 Discovery API 会返回新增的资源类型。

### 6.3 Server-Side Apply

K8s 1.22 起，`kubectl apply` 默认使用 **Server-Side Apply（SSA）**——在 API Server 端执行合并逻辑，而不是在 kubectl 客户端。SSA 的核心改进是引入了 **Field Management**——追踪每个字段由哪个"管理者"（manager）拥有。

```yaml
# SSA 会在 metadata.managedFields 中记录字段所有权
metadata:
  managedFields:
    - manager: kubectl
      operation: Apply
      fieldsV1:
        f:spec:
          f:replicas: {}        # replicas 字段由 kubectl 管理
    - manager: hpa-controller
      operation: Update
      fieldsV1:
        f:spec:
          f:replicas: {}        # HPA 也在修改 replicas
```

当两个管理者同时修改同一个字段时（如 kubectl 和 HPA 都在修改 `spec.replicas`），SSA 会发出冲突警告。这解决了一个长期存在的问题——用户通过 `kubectl apply` 设置了 `replicas: 3`，但 HPA 自动将其调整为 `5`，下次 `kubectl apply` 又把它覆盖回 `3`。有了 SSA 的字段所有权追踪，这种冲突可以被检测和避免。

---

## 第 7 章 总结

本文系统梳理了 K8s API 的对象模型和命名体系：

- **统一的四段式结构**：TypeMeta（类型）+ ObjectMeta（元数据）+ Spec（期望状态）+ Status（当前状态），所有资源共享这套骨架
- **ObjectMeta 的关键字段**：`resourceVersion`（乐观并发）、`labels`（选择过滤）、`ownerReferences`（级联删除）、`finalizers`（删除保护）
- **GVR/GVK 坐标系统**：GVR 映射 API URL 路径，GVK 标识对象类型，RESTMapper 维护两者的映射
- **API 版本演进**：alpha → beta → stable 的成熟度级别，严格的弃用策略保护用户
- **CRD 扩展机制**：无需修改 K8s 源码即可注册新的 API 资源类型，CRD + 自定义控制器 = Operator

下一篇 [[04 Label Selector 与松耦合设计]] 将深入 K8s 中最重要的关联机制——Label 和 Selector 如何实现 Deployment → ReplicaSet → Pod 的松耦合级联管理。

---

## 参考资料

1. Kubernetes API Conventions：https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md
2. Kubernetes API Reference：https://kubernetes.io/docs/reference/kubernetes-api/
3. Kubernetes Documentation - Custom Resources：https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/
4. Kubernetes Documentation - API Versioning：https://kubernetes.io/docs/reference/using-api/#api-versioning
5. Kubernetes Enhancement Proposal - Server-Side Apply：https://github.com/kubernetes/enhancements/tree/master/keps/sig-api-machinery/3488-cel-admission-control
6. Michael Hausenblas, Stefan Schimanski (2019). *Programming Kubernetes*. O'Reilly, Chapter 3-4.
7. Kubernetes Deprecation Policy：https://kubernetes.io/docs/reference/using-api/deprecation-policy/

---

> [!note] 思考题
> 1. ConfigMap 和 Secret 可以通过环境变量或 Volume 挂载注入到 Pod 中。环境变量的问题是更新 ConfigMap 后 Pod 内的环境变量不会自动更新——需要重启 Pod。Volume 挂载方式在 ConfigMap 更新后会自动更新文件（kubelet 定期同步，延迟约 1 分钟）。在什么场景下你需要'即时'的配置更新？Reloader 等工具如何实现 ConfigMap 变更后自动重启 Pod？
> 2. Secret 以 Base64 编码存储在 etcd 中——Base64 不是加密。任何能访问 etcd 的人都能读取明文 Secret。etcd 的加密静态数据（Encryption at Rest）如何保护 Secret？External Secrets Operator 从外部密钥管理系统（AWS Secrets Manager、HashiCorp Vault）同步 Secret——比原生 Secret 更安全吗？
> 3. 在 GitOps 工作流中，Secret 不应明文存储在 Git 仓库中。Sealed Secrets（加密后存储在 Git，集群内由控制器解密）和 SOPS（加密文件级别）是两种方案。在你的 CI/CD 流水线中，Secret 的管理流程是什么？如何做到'Secret 轮换不影响服务'？
