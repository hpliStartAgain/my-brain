---
title: 11 - 在多集群上运行 Kubernetes
date: 2026-05-13
tags: [Kubernetes, 多集群]
aliases: [Running Kubernetes on Multiple Clusters, Multi-cluster Kubernetes]
---

# 在多集群上运行 Kubernetes

## 伸展集群与多集群 Kubernetes

运行多个 Kubernetes 集群的原因有以下几种：

-   你希望在地理区域集群出现问题时拥有冗余能力
-   你需要超过单个 Kubernetes 集群支持上限的节点或 Pod
-   你希望出于安全原因跨不同集群隔离工作负载

对于第一个原因，可以使用伸展集群（stretched cluster）；对于其他原因，则必须运行多个集群。

### 理解伸展集群

伸展集群（又称广域集群）是一个单一的 Kubernetes 集群，其控制平面节点和工作节点分布在多个地理可用区或区域之间。云提供商为高可用托管 Kubernetes 集群提供了这种模型。

#### 伸展集群的优点

伸展集群模型有几个好处：

-   通过适当的冗余，你的集群可以免受数据中心故障这一单点故障（SPOF）的影响
-   对单个 Kubernetes 集群进行操作所带来的简单性是一个巨大的优势（日志记录、指标收集和升级）
-   当你运行自己的非托管伸展集群时，可以透明地将其扩展到其他位置（本地部署、边缘节点和其他云提供商）

#### 伸展集群的缺点

然而，伸展集群模型也有其缺点：

-   你无法突破单个 Kubernetes 集群的限制
-   跨区域网络导致性能下降
-   在云上，跨区域的网络成本可能相当高昂
-   集群升级是全有或全无的事情

简而言之，拥有伸展集群的选项是好的，但如果某些缺点无法接受，请准备好切换到多集群模型。

### 理解多集群 Kubernetes

多集群 Kubernetes 意味着配置多个 Kubernetes 集群。由于前面提到的各种原因，大规模系统通常无法部署在单个集群上。这意味着你需要配置多个 Kubernetes 集群，然后找出如何在这些集群上部署工作负载，以及如何处理各种场景，例如某些集群不可用或性能下降。这里有更多的自由度。

#### 多集群 Kubernetes 的优点

以下是多集群模型的一些好处：

-   可以任意扩展系统 —— 集群数量没有固有限制
-   在 RBAC 级别为敏感工作负载提供集群级隔离
-   利用多个云提供商，而不会产生过高成本（只要大部分流量保持在同一个云提供商区域内）
-   即使是对集群范围的操作，也可以进行升级和增量操作

#### 多集群 Kubernetes 的缺点

然而，多集群层级也存在一些不可忽视的缺点：

-   配置和管理集群集群的极高复杂性
-   需要弄清楚如何连接所有集群
-   需要弄清楚如何在所有集群之间存储和提供数据访问
-   在设计多集群部署时有很多可能出错的方式
-   需要努力为所有集群提供集中化的可观测性

对于其中一些问题，市面上已有解决方案，但在目前，还没有一个明确的赢家可以让你直接采用并轻松配置以满足需求。相反，你需要根据组织多集群结构中出现的具体问题来调整和解决。

### Kubernetes 集群联邦的历史

在本书的前几版中，我们将 Kubernetes 集群联邦（Cluster Federation）作为将多个 Kubernetes 集群作为单个概念集群进行管理的解决方案进行了讨论。不幸的是，该项目自 2019 年以来一直处于不活跃状态，Kubernetes 多集群特别兴趣小组（SIG）正在考虑将其归档。在我们描述更现代的方法之前，先了解一些历史背景。谈论像 Kubernetes 这样在 2014 年之前甚至不存在的项目的历史是很有趣的，但开发的速度和大量的贡献者使 Kubernetes 经历了一个加速的演进过程。这对于 Kubernetes 联邦来说尤其如此。

2015 年 3 月，Kubernetes 集群联邦提案的第一版发布。当时它被亲切地称为 "Ubernetes"。其基本思想是重用现有的 Kubernetes API 来管理多个集群。这个现在被称为 Federation V1 的提案经历了多轮修订和实现，但从未达到通用可用性（GA），主仓库也已被归档：https://github.com/kubernetes-retired/federation。

SIG 多集群工作组意识到多集群问题比最初想象的要复杂得多。解决这个问题的方法有很多，没有一种万能方案。集群联邦的新方向是使用专用的联邦 API。一个新的项目和一组工具被创建并实现为 Kubernetes Federation V2：https://github.com/kubernetes-sigs/kubefed。

不幸的是，这也没有成功，多集群 SIG 的共识是，由于该项目没有得到维护，需要被归档。参见 2022-08-09 会议记录：https://tinyurl.com/sig-multicluster-notes。

目前有很多项目正在快速发展，试图解决多集群问题，它们都在不同的层面运作。让我们看看其中一些突出的项目。这里的目标只是介绍这些项目及其独特之处。要全面探索每一个项目超出了本章的范围。不过，我们将在第 17 章《在生产环境中运行 Kubernetes》中深入研究其中一个项目 —— Cluster API。

## Cluster API

Cluster API（又称 CAPI）是集群生命周期 SIG 的一个项目。它的目标是让配置、升级和运维多个 Kubernetes 集群变得简单。它同时支持基于 kubeadm 的集群以及通过专用提供商管理的集群。它有一个很酷的标志，灵感来自著名的 "乌龟一路往下"（It's turtles all the way down）的故事。其理念是 Cluster API 使用 Kubernetes 来管理 Kubernetes 集群。

![图 11.1: Cluster API 标志](images/ch11-fig01.png)

### Cluster API 架构

Cluster API 拥有非常清晰且可扩展的架构。主要组件包括：

-   管理集群（Management cluster）
-   工作集群（Work cluster）
-   引导提供商（Bootstrap provider）
-   基础设施提供商（Infrastructure provider）
-   控制平面（Control plane）
-   自定义资源（Custom resources）

![图 11.2: Cluster API 架构](images/ch11-fig02.png)

让我们了解每个组件的角色以及它们之间如何交互。

#### 管理集群

管理集群是一个 Kubernetes 集群，负责管理其他 Kubernetes 集群（工作集群）。它运行 Cluster API 控制平面和提供商，并托管代表其他集群的 Cluster API 自定义资源。

`clusterctl` CLI 可用于与管理工作集群交互。`clusterctl` 是一个命令行工具，拥有大量命令和选项。如果你想通过 CLI 体验 Cluster API，请访问 https://cluster-api.sigs.k8s.io/clusterctl/overview.html。

#### 工作集群

工作集群只是一个普通的 Kubernetes 集群。这些是开发人员用来部署其工作负载的集群。工作集群不需要知道它们正被 Cluster API 管理。

#### 引导提供商

当 CAPI 创建一个新的 Kubernetes 集群时，它需要证书才能创建工作集群的控制平面，最后创建工作节点。这就是引导提供商的职责。它确保满足所有要求，并最终将工作节点加入控制平面。

#### 基础设施提供商

基础设施提供商是一个可插拔的组件，允许 CAPI 在不同的基础设施环境中工作，例如云提供商或裸机基础设施提供商。基础设施提供商实现了 CAPI 定义的一组接口，以提供对计算和网络资源的访问。

在此处查看当前的提供商列表：https://cluster-api.sigs.k8s.io/reference/providers.html。

#### 控制平面

Kubernetes 集群的控制平面由 API 服务器、etcd 状态存储、调度器和运行控制循环以协调集群中资源的控制器组成。工作集群的控制平面可以通过多种方式进行配置。CAPI 支持以下模式：

-   **基于机器（Machine-based）** —— 控制平面组件作为静态 Pod 部署在专用机器上
-   **基于 Pod（Pod-based）** —— 控制平面组件通过 Deployment 和 StatefulSet 部署，API 服务器作为 Service 暴露
-   **外部（External）** —— 控制平面由外部提供商（通常是云提供商）配置和管理

#### 自定义资源

自定义资源代表由 CAPI 管理的 Kubernetes 集群和机器，以及额外的辅助资源。有大量的自定义资源，其中一些仍被视为实验性的。主要的 CRD 包括：

-   Cluster（集群）
-   ControlPlane（控制平面，代表控制平面机器）
-   MachineSet（机器集，代表工作机器）
-   MachineDeployment（机器部署）
-   Machine（机器）
-   MachineHealthCheck（机器健康检查）

其中一些通用资源引用了基础设施提供商提供的相应资源。

下图说明了代表集群和机器集的控制平面资源之间的关系：

![图 11.3: Cluster API 控制平面资源](ch11-fig03.png)

CAPI 还有一组额外的实验性资源，代表托管云提供商环境：

-   MachinePool（机器池）
-   ClusterResourceSet（集群资源集）
-   ClusterClass（集群类）

更多详情请参见 https://github.com/kubernetes-sigs/cluster-api。

## Karmada

Karmada 是一个 CNCF 沙箱项目，专注于在多个 Kubernetes 集群上部署和运行工作负载。它的成名之处在于你不需要更改应用程序配置。CAPI 专注于集群的生命周期管理，而 Karmada 则在你已经拥有一组 Kubernetes 集群并希望跨所有集群部署工作负载时接手。从概念上讲，Karmada 是对已废弃的 Kubernetes Federation 项目的现代重构。它可以与云上、本地部署和边缘环境中的 Kubernetes 一起使用。

参见 https://github.com/karmada-io/karmada。

让我们看看 Karmada 的架构。

### Karmada 架构

Karmada 深受 Kubernetes 的启发。它提供了一个多集群控制平面，其组件与 Kubernetes 控制平面类似：

-   Karmada API 服务器
-   Karmada 控制器管理器
-   Karmada 调度器

如果你理解 Kubernetes 的工作原理，那么很容易理解 Karmada 如何将其 1:1 扩展到多个集群。

下图展示了 Karmada 的架构：

![图 11.4: Karmada 架构](ch11-fig04.png)

### Karmada 概念

Karmada 围绕几个以 Kubernetes CRD 形式实现的概念展开。你使用这些概念来定义和更新你的应用程序和服务，Karmada 确保你的工作负载在多集群系统中部署并在正确的位置运行。

让我们看看这些概念。

#### ResourceTemplate（资源模板）

资源模板看起来就像一个普通的 Kubernetes 资源，如 Deployment 或 StatefulSet，但它实际上并不会被部署到 Karmada 控制平面上。它仅作为一个蓝图，最终将被部署到成员集群中。

#### PropagationPolicy（传播策略）

传播策略决定了资源模板应部署到哪里。以下是一个简单的传播策略，它将 nginx Deployment 放入两个名为 member1 和 member2 的集群：

```yaml
apiVersion: policy.karmada.io/v1alpha1
kind: PropagationPolicy
metadata:
  name: cool-policy
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: nginx
  placement:
    clusterAffinity:
      clusterNames:
        - member1
        - member2
```

#### OverridePolicy（覆盖策略）

传播策略跨多个集群运行，但有时会存在例外情况。覆盖策略允许你应用细粒度规则来覆盖现有的传播策略。有几种类型的规则：

-   **ImageOverrider**：专门用于覆盖工作负载的镜像
-   **CommandOverrider**：专门用于覆盖工作负载的命令
-   **ArgsOverrider**：专门用于覆盖工作负载的参数
-   **PlaintextOverrider**：一个通用工具，用于覆盖任何类型的资源

#### 附加能力

Karmada 还有更多功能，例如：

-   多集群去调度（De-scheduling）
-   重调度（Re-scheduling）
-   多集群故障转移（Failover）
-   多集群服务发现（Service discovery）

更多详情请查看 Karmada 文档：https://karmada.io/docs/。

## Clusternet

Clusternet 是一个有趣的项目。它围绕将管理多个 Kubernetes 集群类比为 "访问互联网"（因此得名 "Clusternet"）这一理念展开。它支持基于云的、本地部署的、边缘的和混合的集群。Clusternet 的核心功能包括：

-   Kubernetes 多集群管理和治理
-   应用协调（Application coordination）
-   通过 kubectl 插件提供 CLI
-   通过 Kubernetes Client-Go 库的包装器提供编程访问

### Clusternet 架构

Clusternet 的架构与 Karmada 类似，但更简单。存在一个父集群（parent cluster），运行 Clusternet 枢纽（hub）和 Clusternet 调度器。在每个子集群上，有一个 Clusternet 代理（agent）。下图展示了组件之间的结构和交互：

![图 11.5: Clusternet 架构](ch11-fig05.png)

#### Clusternet 枢纽（Hub）

枢纽具有多个角色。它负责批准集群注册请求，并为所有子集群创建命名空间、服务账户和 RBAC 资源。它还作为一个聚合 API 服务器运行，维护着到子集群上代理的 WebSocket 连接。枢纽还提供类似 Kubernetes 的 API，以将请求代理到每个子集群。最后但同样重要的是，枢纽协调应用程序及其依赖项从单组资源部署到多个集群的过程。

#### Clusternet 调度器

Clusternet 调度器是一个组件，负责确保资源（在 Clusternet 术语中称为 feeds）根据名为 SchedulingStrategy 的策略在所有子集群上部署和平衡。

#### Clusternet 代理

Clusternet 代理在每个子集群上运行，并与枢纽通信。子集群上的代理相当于节点上的 kubelet。它有多个角色。代理将其子集群注册到父集群。代理向枢纽提供心跳，其中包含大量信息，例如 Kubernetes 版本、运行平台、工作负载的健康状况、就绪性和存活状态。代理还建立到父集群上枢纽的 WebSocket 连接，以允许通过单个 TCP 连接实现全双工通信通道。

### 多集群部署

Clusternet 将多集群部署建模为订阅（Subscription）和供给（Feed）。它提供了一个 Subscription 自定义资源，可以根据不同的条件将一组资源（称为 feeds）部署到多个集群（称为 subscribers）。以下是一个 Subscription 示例，它将 Namespace、Service 和 Deployment 部署到多个具有 `clusters.clusternet.io/cluster-id` 标签的集群：

```yaml
# examples/dynamic-dividing-scheduling/subscription.yaml
apiVersion: apps.clusternet.io/v1alpha1
kind: Subscription
metadata:
  name: dynamic-dividing-scheduling-demo
  namespace: default
spec:
  subscribers: # 筛选出一组目标集群
    - clusterAffinity:
        matchExpressions:
          - key: clusters.clusternet.io/cluster-id
            operator: Exists
      schedulingStrategy: Dividing
      dividingScheduling:
        type: Dynamic
        dynamicDividing:
          strategy: Spread # 目前我们只支持 Spread 划分策略
  feeds: # 定义将要部署的所有资源
    - apiVersion: v1
      kind: Namespace
      name: qux
    - apiVersion: v1
      kind: Service
      name: my-nginx-svc
      namespace: qux
    - apiVersion: apps/v1 # 总共 6 个副本
      kind: Deployment
      name: my-nginx
      namespace: qux
```

更多详情请参见 https://clusternet.io。

## Clusterpedia

Clusterpedia 是一个 CNCF 沙箱项目。它的核心隐喻是 "Kubernetes 集群的百科全书"。它在多集群搜索、过滤、字段选择（field selection）和排序方面拥有大量能力。这很不寻常，因为它是一个只读项目。它不提供管理集群或部署工作负载方面的帮助，而是专注于观察你的集群。

### Clusterpedia 架构

其架构与其他多集群项目类似。有一个控制平面元素，运行 Clusterpedia API 服务器和 ClusterSynchro 管理器组件。对于每个被观察的集群，有一个名为 cluster synchro 的专用组件，负责将集群的状态同步到 Clusterpedia 的存储层。该架构最有趣的方面之一是 Clusterpedia 聚合 API 服务器，它使所有集群看起来像一个单一的巨大的逻辑集群。请注意，Clusterpedia API 服务器和 ClusterSynchro 管理器是松散耦合的，不直接相互交互。它们只是从共享存储层读取和写入。

![图 11.6: Clusterpedia 架构](images/ch11-fig06.png)

让我们看看每个组件，了解它们的用途。

#### Clusterpedia API 服务器

Clusterpedia API 服务器是一个聚合 API 服务器。这意味着它将自己注册到 Kubernetes API 服务器，实际上是通过自定义端点扩展了标准 Kubernetes API 服务器。当请求到达 Kubernetes API 服务器时，它会将其转发给 Clusterpedia API 服务器，后者访问存储层来满足这些请求。Kubernetes API 服务器作为 Clusterpedia 处理的请求的转发层。

这是 Kubernetes 的一个高级方面。我们将在第 15 章《扩展 Kubernetes》中讨论 API 服务器聚合。

#### ClusterSynchro 管理器

Clusterpedia 观察多个集群以提供搜索、过滤和聚合功能。一种实现方式是，每当有请求进来时，Clusterpedia 会查询所有被观察的集群，收集结果并返回。这种方法非常有问题，因为某些集群可能响应缓慢，并且类似的请求需要返回相同的信息，这既浪费又代价高昂。相反，ClusterSynchro 管理器将所有被观察集群的状态统一同步到 Clusterpedia 的存储中，这样 Clusterpedia API 服务器就可以快速响应。

#### 存储层

存储层是一个抽象层，用于存储所有被观察集群的状态。它提供了一个统一的接口，可以由不同的存储组件实现。Clusterpedia API 服务器和 ClusterSynchro 管理器通过存储层接口交互，从不直接相互通信。

#### 存储组件

存储组件是一个实际的数据存储，实现了存储层接口并存储被观察集群的状态。Clusterpedia 被设计为支持不同的存储组件，以为其用户提供灵活性。目前支持的存储组件包括 MySQL、Postgres 和 Redis。

#### 导入集群

要将集群接入 Clusterpedia，你需要定义一个 PediaCluster 自定义资源。这相当简单直接：

```yaml
apiVersion: cluster.clusterpedia.io/v1alpha2
kind: PediaCluster
metadata:
  name: cluster-example
spec:
  apiserver: "https://10.30.43.43:6443"
  kubeconfig:
    caData:
    tokenData:
    certData:
    keyData:
  syncResources: []
```

你需要提供访问集群的凭据，然后 Clusterpedia 将接管并同步其状态。

### 高级多集群搜索

这是 Clusterpedia 的突出之处。你可以通过 API 或 kubectl 访问 Clusterpedia 集群。通过 URL 访问时，看起来就像是在访问聚合 API 服务器端点：

```bash
kubectl get --raw="/apis/clusterpedia.io/v1beta1/resources/apis/apps/v1/deployments?clusters=cluster-1,cluster-2"
```

你可以将目标集群指定为查询参数（此处为 `cluster-1` 和 `cluster-2`）。通过 kubectl 访问时，你可以将目标集群指定为标签（此处为 `"search.clusterpedia.io/clusters in (cluster-1,cluster-2)"`）：

```bash
kubectl --cluster clusterpedia get deployments -l "search.clusterpedia.io/clusters in (cluster-1,cluster-2)"
```

其他搜索标签和查询可用于命名空间和资源名称：

-   `search.clusterpedia.io/namespaces`（查询参数为 `namespaces`）
-   `search.clusterpedia.io/names`（查询参数为 `names`）

还有一个实验性的模糊搜索标签 `internalstorage.clusterpedia.io/fuzzy-name`，用于资源名称，但没有对应的查询参数。这在资源名称带有随机后缀的生成名称时非常有用。

你还可以按创建时间搜索：

-   `search.clusterpedia.io/before`（查询参数为 `before`）
-   `search.clusterpedia.io/since`（查询参数为 `since`）

其他能力包括按资源标签（resource labels）或字段选择器（field selectors）进行过滤，以及使用 OrderBy 和 Paging 组织结果。

### 资源集合

另一个重要的概念是资源集合（CollectionResource）。标准 Kubernetes API 提供了一种直接的 REST API，你一次只能列出或获取一种资源。然而，用户通常希望同时获取多种类型的资源。例如，具有特定标签的 Deployment、Service 和 HorizontalPodAutoscaler。通过标准 Kubernetes API，即使所有这些资源都在一个集群上可用，也需要多次调用。Clusterpedia 定义了一个 CollectionResource，将属于以下类别的资源组合在一起：

-   **any（全部）** —— 所有资源
-   **workloads（工作负载）** —— Deployments、StatefulSets 和 DaemonSets
-   **kuberesources（Kubernetes 资源）** —— 工作负载之外的所有其他资源

你可以通过传递 API 组和资源种类，在一次 API 调用中搜索任意资源组合：

```bash
kubectl get --raw "/apis/clusterpedia.io/v1beta1/collectionresources/any?onlyMetadata=true&groups=apps&resources=batch/jobs,batch/cronjobs"
```

更多详情请参见 https://github.com/clusterpedia-io/clusterpedia。

## Open Cluster Management（OCM）

Open Cluster Management（OCM）是一个 CNCF 沙箱项目，用于多集群管理以及多集群调度和工作负载放置。它的成名之处在于紧密遵循许多 Kubernetes 概念、通过插件（addon）实现的可扩展性以及与以下其他开源项目的强大集成：

-   Submariner
-   Clusternet（我们之前介绍过）
-   KubeVela

OCM 的范围涵盖集群生命周期、应用生命周期和治理（governance）。

让我们看看 OCM 的架构。

### OCM 架构

OCM 的架构遵循中心（hub）和辐条（spokes）模型。它有一个中心集群，即 OCM 控制平面，负责管理多个其他集群（辐条集群）。

控制平面的中心集群运行两个控制器：注册控制器（registration controller）和放置控制器（placement controller）。此外，控制平面还运行多个管理插件，这些插件是 OCM 可扩展性的基础。在每个被管理的集群上，有一个所谓的 Klusterlet，它包含注册代理（registration-agent）和工作代理（work-agent），与中心集群上的注册控制器和放置控制器交互。此外，还有与中心集群上插件交互的插件代理。

下图说明了 OCM 不同组件之间的通信方式：

![图 11.7: OCM 架构](images/ch11-fig07.png)

让我们看看 OCM 的不同方面。

### OCM 集群生命周期

集群注册是 OCM 安全多集群方案的重要组成部分。OCM 以其安全的双重确认握手注册（secure double opt-in handshake registration）而自豪。由于中心集群和辐条集群可能拥有不同的管理员，这种模型为每一方提供了保护，使其免受不希望的请求。任何一方都可以随时终止该关系。

下图展示了注册过程（CSR 表示证书签名请求）：

![图 11.8: OCM 注册流程](ch11-fig08.png)

### OCM 应用生命周期

OCM 应用生命周期支持跨多个集群创建、更新和删除资源。

其主要构建块是 ManifestWork 自定义资源，它可以定义多个资源。以下是一个仅包含单个 Deployment 的示例：

```yaml
apiVersion: work.open-cluster-management.io/v1
kind: ManifestWork
metadata:
  namespace: <target managed cluster>
  name: awesome-workload
spec:
  workload:
    manifests:
      - apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: hello
          namespace: default
        spec:
          selector:
            matchLabels:
              app: hello
          template:
            metadata:
              labels:
                app: hello
            spec:
              containers:
                - name: hello
                  image: quay.io/asmacdo/busybox
                  command:
                    ["sh", "-c", 'echo "Hello, Kubernetes!" && sleep 3600']
```

ManifestWork 在中心集群上创建，并根据命名空间映射部署到目标集群。每个目标集群在中心集群中都有一个表示它的命名空间。运行在目标集群上的工作代理将监控中心集群上其命名空间内的所有 ManifestWork 资源并同步更改。

### OCM 治理、风险与合规（GRC）

OCM 提供了一个基于策略、策略模板和策略控制器的治理模型。策略可以绑定到特定的集群集，以实现细粒度控制。

以下是一个要求存在名为 `Prod` 的命名空间的示例策略：

```yaml
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: policy-namespace
  namespace: policies
  annotations:
    policy.open-cluster-management.io/standards: NIST SP 800-53
    policy.open-cluster-management.io/categories: CM Configuration Management
    policy.open-cluster-management.io/controls: CM-2 Baseline Configuration
spec:
  remediationAction: enforce
  disabled: false
  policy-templates:
    - objectDefinition:
        apiVersion: policy.open-cluster-management.io/v1
        kind: ConfigurationPolicy
        metadata:
          name: policy-namespace-example
        spec:
          remediationAction: inform
          severity: low
          object-templates:
            - complianceType: MustHave
              objectDefinition:
                kind: Namespace # 必须拥有命名空间 'prod'
                apiVersion: v1
                metadata:
                  name: prod
```

更多详情请参见 https://open-cluster-management.io/。

## Virtual Kubelet

Virtual Kubelet 是一个引人入胜的项目。它冒充 kubelet，将 Kubernetes 连接到其他 API，例如 AWS Fargate 或 Azure ACI。Virtual Kubelet 对 Kubernetes 集群来说看起来像一个节点，但其背后的计算资源被抽象化了。Virtual Kubelet 对 Kubernetes 集群来说就像另一个普通节点：

![图 11.9: Virtual Kubelet，对 Kubernetes 集群来说就像一个普通节点](ch11-fig09.png)

Virtual Kubelet 的功能包括：

-   创建、更新和删除 Pod
-   访问容器日志和指标
-   获取 Pod、Pod 列表和 Pod 状态
-   管理容量（capacity）
-   访问节点地址、节点容量和节点守护进程端点
-   选择操作系统
-   支持自定义虚拟网络

更多详情请参见 https://github.com/virtual-kubelet/virtual-kubelet。

这个概念也可用于连接多个 Kubernetes 集群，有几个项目采用了这种方法。让我们简要了解一些使用 Virtual Kubelet 进行多集群管理的项目，例如 tensile-kube、Admiralty 和 Liqo。

### Tensile-kube

Tensile-kube 是 GitHub 上 Virtual Kubelet 组织的一个子项目。

Tensile-kube 带来了以下能力：

-   自动发现集群资源
-   异步通知 Pod 修改
-   完全访问 Pod 日志和 kubectl exec
-   全局调度 Pod
-   使用去调度器（descheduler）重新调度 Pod
-   PV/PVC
-   Service

Tensile-kube 的术语中，包含 Virtual Kubelet 的集群称为上层集群（upper cluster），而作为上层集群中的虚拟节点暴露的集群称为下层集群（lower clusters）。

以下是 tensile-kube 的架构：

![图 11.10: Tensile-kube 架构](images/ch11-fig10.png)

更多详情请参见 https://github.com/virtual-kubelet/tensile-kube。

### Admiralty

Admiralty 是一个由商业公司支持的开源项目。Admiralty 采用 Virtual Kubelet 概念，构建了一个用于多集群编排和调度的高级解决方案。目标集群在源集群中表示为虚拟节点。它有一个相当复杂的架构，涉及三个级别的调度。每当在代理（proxy）上创建 Pod 时，会在源集群上创建 Pod，在每个目标集群上创建候选 Pod，最终会选中一个候选 Pod 成为委托 Pod（delegate pod），这是一个真正运行其容器的实际 Pod。这一切都由构建在 Kubernetes 调度框架之上的自定义多集群调度器支持。要在 Admiralty 上调度工作负载，你需要为任何 Pod 模板添加 `multicluster.admiralty.io/elect=""` 注释，Admiralty 将从那里接管。

下图展示了不同组件之间的相互作用：

![图 11.11: Admiralty 架构](ch11-fig11.png)

Admiralty 提供以下功能：

-   高可用（Highly available）
-   实时灾难恢复（Live disaster recovery）
-   动态 CDN（内容分发网络）
-   多集群工作流（Multi-cluster workflows）
-   支持边缘计算、物联网和 5G
-   治理（Governance）
-   集群升级（Cluster upgrades）
-   集群即牲畜抽象（Clusters as cattle abstraction）
-   全局资源联邦（Global resource federation）
-   云爆发和套利（Cloud bursting and arbitrage）

更多详情请参见 https://admiralty.io。

### Liqo

Liqo 是一个基于液态计算（liquid computing）概念的开源项目。让你的任务和数据自由流动，找到最佳运行位置。它的覆盖范围令人印象深刻，不仅针对跨多个集群运行 Pod 的计算方面，还提供了网络结构（network fabric）和存储结构（storage fabric）。连接集群和管理跨集群数据的这些方面通常比仅仅运行工作负载更难解决的问题。

在 Liqo 的术语中，管理集群被称为家庭集群（home cluster），目标集群被称为外部集群（foreign cluster）。家庭集群中的虚拟节点被称为 "大" 节点（"Big" nodes），它们代表外部集群。

Liqo 利用 IP 地址映射来实现跨所有可能存在内部 IP 冲突的外部集群的扁平 IP 地址空间。

Liqo 过滤和批量处理来自外部集群的事件，以减少对家庭集群的压力。

以下是 Liqo 架构的图示：

![图 11.12: Liqo 架构](ch11-fig12.png)

更多详情请参见 https://liqo.io。

接下来，让我们深入探讨 Gardener 项目，它采用了不同的方法。

## 介绍 Gardener 项目

Gardener 项目是 SAP 开发的一个开源项目。它让你能够高效且经济地管理成千上万个（是的，成千上万个！）Kubernetes 集群。Gardener 解决了一个非常复杂的问题，其解决方案优雅但并不简单。Gardener 是唯一同时解决集群生命周期和应用生命周期的项目。

在本节中，我们将介绍 Gardener 的术语和概念模型，深入探讨其架构，并了解其可扩展性特性。Gardener 的主题是使用 Kubernetes 来管理 Kubernetes 集群。将 Gardener 视为 Kubernetes 控制平面即服务（Kubernetes-control-plane-as-a-service）是一个很好的理解方式。

更多详情请参见 https://gardener.cloud。

### 理解 Gardener 的术语

正如你可能猜到的，Gardener 项目使用植物学术语来描述世界。有一个花园（Garden），它是一个负责管理种子集群（Seed）的 Kubernetes 集群。种子集群是一个负责管理一组 Shoot 集群的 Kubernetes 集群。Shoot 集群是运行实际工作负载的 Kubernetes 集群。

Gardener 背后的巧妙之处在于，Shoot 集群只包含工作节点。所有 Shoot 集群的控制平面在种子集群中作为 Kubernetes Pod 和服务运行。

下图详细描述了 Gardener 的结构及其组件之间的关系：

![图 11.13: Gardener 项目结构](images/ch11-fig13.png)

不要慌张！所有这些复杂性之下是一个极其清晰的概念模型。

### 理解 Gardener 的概念模型

Gardener 的架构图可能让人望而生畏。让我们慢慢拆解它，揭示其底层原理。Gardener 真正拥抱了 Kubernetes 的精神，并将管理大量 Kubernetes 集群的许多复杂性卸载给了 Kubernetes 本身。其核心是，Gardener 是一个聚合 API 服务器，使用各种控制器管理一组自定义资源。它拥抱并充分利用了 Kubernetes 的可扩展性。这种方法在 Kubernetes 社区中很常见：定义一组自定义资源，让 Kubernetes 为你管理它们。Gardener 的新颖之处在于，它将这种方法发挥到了极致，并抽象掉了 Kubernetes 基础设施本身的部分。

在一个 "普通" 的 Kubernetes 集群中，控制平面与工作节点运行在同一集群中。通常，在大型集群中，像 Kubernetes API 服务器和 etcd 这样的控制平面组件运行在专用节点上，不与工作节点混合。Gardener 从多个集群的角度思考，它把所有 Shoot 集群的控制平面集中到一个种子集群中进行管理。因此，Shoot 集群的 Kubernetes 控制平面在种子集群中作为普通的 Kubernetes Deployment 进行管理，这自动提供了 Kubernetes 的复制、监控、自愈和滚动更新能力。

因此，Kubernetes Shoot 集群的控制平面类似于一个 Deployment。另一方面，种子集群映射到 Kubernetes 节点。它管理多个 Shoot 集群。建议每个云提供商使用一个种子集群。Gardener 开发者实际上正在为种子集群开发一个类似于节点上 kubelet 的 gardenlet 控制器。

如果种子集群类似于 Kubernetes 节点，那么管理这些种子集群的 Garden 集群就像一个管理其工作节点的 Kubernetes 集群。

通过将 Kubernetes 模型推到如此之远，Gardener 项目利用了 Kubernetes 的优势，实现了难以从头构建的健壮性和性能。

让我们深入探讨其架构。

### 深入 Gardener 架构

Gardener 在种子集群中为每个 Shoot 集群创建一个 Kubernetes 命名空间。它将 Shoot 集群的证书作为 Kubernetes Secret 管理在种子集群中。

#### 管理集群状态

每个集群的 etcd 数据存储部署为一个具有一个副本的 StatefulSet。此外，事件存储在单独的 etcd 实例中。etcd 数据定期快照并存储在远程存储中，用于备份和恢复目的。这使得丢失了控制平面的集群（例如，当整个种子集群变得不可达时）能够非常快速地恢复。请注意，当种子集群宕机时，Shoot 集群继续正常运行。

#### 管理控制平面

如前所述，Shoot 集群 X 的控制平面在单独的种子集群中运行，而工作节点在 Shoot 集群中运行。这意味着 Shoot 集群中的 Pod 可以使用内部 DNS 找到彼此，但与运行在种子集群中的 Kubernetes API 服务器的通信必须通过外部 DNS 完成。这意味着 Kubernetes API 服务器以 LoadBalancer 类型的 Service 运行。

#### 准备基础设施

在创建新的 Shoot 集群时，提供必要的基础设施非常重要。Gardener 为此使用 Terraform。Terraform 脚本基于 Shoot 集群规范动态生成，并作为 ConfigMap 存储在种子集群中。为促进此过程，一个专用组件（Terraformer）作为 Job 运行，执行所有资源置备，然后将状态写入一个单独的 ConfigMap。

#### 使用 Machine Controller Manager

为了以与提供商无关的方式置备节点（这也适用于私有云），Gardener 拥有多个自定义资源，如 MachineDeployment、MachineClass、MachineSet 和 Machine。它们与 Kubernetes 集群生命周期小组合作以统一其抽象，因为存在大量重叠。此外，Gardener 利用集群自动缩放器（cluster auto-scaler）来卸载扩展节点池的复杂性。

#### 跨集群网络

种子集群和 Shoot 集群可以在不同的云提供商上运行。Shoot 集群中的工作节点通常部署在私有网络中。由于控制平面需要与工作节点（主要是 kubelet）紧密交互，Gardener 创建了一个 VPN 用于直接通信。

#### 监控集群

可观测性是运维复杂分布式系统的重要组成部分。Gardener 提供了大量开箱即用的监控功能，使用了同类最佳的开源项目，如在 Garden 集群中部署了一个中央 Prometheus 服务器，收集所有种子集群的信息。此外，每个 Shoot 集群在种子集群中都有自己的 Prometheus 实例。为了收集指标，Gardener 为每个集群部署了两个 kube-state-metrics 实例（一个用于种子中的控制平面，一个用于 Shoot 中的工作节点）。node-exporter 也被部署以提供节点的额外信息。Prometheus AlertManager 用于在出现问题时通知运维人员。Grafana 用于显示包含系统状态相关数据的仪表板。

#### gardenctl CLI

你可以仅使用 kubectl 管理 Gardener，但在探索不同集群时，你需要频繁切换配置文件和上下文。Gardener 提供了 `gardenctl` 命令行工具，它提供更高级别的抽象，并且可以同时对多个集群进行操作。以下是一个示例：

```bash
$ gardenctl ls shoots
projects:
  - project: team-a
    shoots:
      - dev-eu1
      - prod-eu1
$ gardenctl target shoot prod-eu1
[prod-eu1]
$ gardenctl show prometheus
NAME          READY   STATUS    RESTARTS   AGE    IP              NODE
prometheus-0   3/3    Running   0          106d   10.241.241.42   ip-10-240-7-
URL: https://user:password@p.prod-eu1.team-a.seed.aws-eu1.example.com
```

Gardener 最突出的特性之一是其可扩展性。它具有很大的覆盖面，支持许多环境。让我们看看可扩展性是如何融入其设计的。

### 扩展 Gardener

Gardener 支持以下环境：

-   AliCloud（阿里云）
-   AWS
-   Azure
-   Equinix Metal
-   GCP
-   OpenStack
-   vSphere

最初，和 Kubernetes 本身一样，Gardener 的主仓库中有大量特定于提供商的支持。随着时间的推移，它效仿了 Kubernetes 将云提供商外部化的做法，将提供商迁移到了独立的 Gardener 扩展中。提供商可以使用 CloudProfile CRD 来指定，例如：

```yaml
apiVersion: core.gardener.cloud/v1beta1
kind: CloudProfile
metadata:
  name: aws
spec:
  type: aws
  kubernetes:
    versions:
      - version: 1.24.3
      - version: 1.23.8
        expirationDate: "2022-10-31T23:59:59Z"
  machineImages:
    - name: coreos
      versions:
        - version: 2135.6.0
  machineTypes:
    - name: m5.large
      cpu: "2"
      gpu: "0"
      memory: 8Gi
      usable: true
  volumeTypes:
    - name: gp2
      class: standard
      usable: true
    - name: io1
      class: premium
      usable: true
  regions:
    - name: eu-central-1
      zones:
        - name: eu-central-1a
        - name: eu-central-1b
        - name: eu-central-1c
  providerConfig:
    apiVersion: aws.provider.extensions.gardener.cloud/v1alpha1
    kind: CloudProfileConfig
    machineImages:
      - name: coreos
        versions:
          - version: 2135.6.0
            regions:
              - name: eu-central-1
                ami: ami-034fd8c3f4026eb39
                # architecture: amd64 # 可选
```

然后，一个 Shoot 集群将选择一个提供商并配置必要的信息：

```yaml
apiVersion: gardener.cloud/v1alpha1
kind: Shoot
metadata:
  name: johndoe-aws
  namespace: garden-dev
spec:
  cloudProfileName: aws
  secretBindingName: core-aws
  cloud:
    type: aws
    region: eu-west-1
    providerConfig:
      apiVersion: aws.cloud.gardener.cloud/v1alpha1
      kind: InfrastructureConfig
      networks:
        vpc: # 指定 'id' 或 'cidr'
          # id: vpc-123456
          cidr: 10.250.0.0/16
        internal:
          - 10.250.112.0/22
        public:
          - 10.250.96.0/22
        workers:
          - 10.250.0.0/19
      zones:
        - eu-west-1a
  workerPools:
    - name: pool-01
      # Taints、labels 和 annotations 尚未实现。这需要与 machine-controller-manager 交互，
      # 请参见 https://github.com/gardener/machine-controller-manager/issues/174。
      # 此处仅作为未来提案提及。
      # taints:
      #   - key: foo
      #     value: bar
      #     effect: PreferNoSchedule
      # labels:
      #   - key: bar
      #     value: baz
      # annotations:
      #   - key: foo
      #     value: hugo
      machineType: m4.large
      volume: # 可选，并非所有环境都需要，仅当引用的 CloudProfile 包含 volumeTypes 字段时才可指定
        type: gp2
        size: 20Gi
      providerConfig:
        apiVersion: aws.cloud.gardener.cloud/v1alpha1
        kind: WorkerPoolConfig
        machineImage:
          name: coreos
          ami: ami-d0dcef3
      zones:
        - eu-west-1a
      minimum: 2
      maximum: 2
      maxSurge: 1
      maxUnavailable: 0
      kubernetes:
        version: 1.11.0
  dns:
    provider: aws-route53
    domain: johndoe-aws.garden-dev.example.com
  maintenance:
    timeWindow:
      begin: 220000+0100
      end: 230000+0100
    autoUpdate:
      kubernetesVersion: true
  backup:
    schedule: "*/5 * * * *"
    maximum: 7
  addons:
    kube2iam:
      enabled: false
    kubernetes-dashboard:
      enabled: true
    cluster-autoscaler:
      enabled: true
    nginx-ingress:
      enabled: true
      loadBalancerSourceRanges: []
    kube-lego:
      enabled: true
      email: john.doe@example.com
```

但是，Gardener 的可扩展性目标远不止于与提供商无关。搭建一个 Kubernetes 集群的整个过程涉及许多步骤。Gardener 项目旨在让运维人员通过定义自定义资源和 Webhook 来自定义每一步。以下是包含 CRD、变更/验证准入控制器（admission controller）以及每个步骤相关联的 Webhook 的总体流程图示：

![图 11.14: CRD 变更和验证准入控制器的流程图](images/ch11-fig14.png)

以下是构成 Gardener 可扩展性空间的 CRD 类别：

-   DNS 管理提供商，例如 Route53 和 CloudDNS
-   对象存储提供商，包括 S3、GCS 和 ABS
-   基础设施提供商，如 AWS、GCP 和 Azure
-   对各种操作系统的支持，例如 CoreOS Container Linux、Ubuntu 和 FlatCar Linux
-   网络插件，如 Calico、Flannel 和 Cilium
-   可选扩展，例如 Let's Encrypt 的证书服务

我们已经深入介绍了 Gardener，至此本章结束。

## 总结

在本章中，我们涵盖了多集群管理这个激动人心的领域。有许多项目从不同角度解决这个问题。Cluster API 项目在解决多集群生命周期管理这个子问题方面具有很大的发展势头。许多其他项目则承担了资源管理和应用生命周期方面的任务。这些项目可以分为两类：一类是使用管理集群和被管理集群显式管理多个集群的项目，另一类是使用 Virtual Kubelet 的项目，其中整个集群在主集群中表现为虚拟节点。

Gardener 项目拥有非常有趣的方法和架构。它从不同的角度解决多集群问题，专注于集群的大规模管理。它是唯一同时解决集群生命周期和应用生命周期的项目。

至此，你应该对多集群管理的当前状态以及不同项目所提供的功能有了清晰的理解。你可能认为现在还为时过早，或者你希望深入尝试。

在下一章中，我们将探索 Kubernetes 上无服务器计算（serverless computing）这一激动人心的世界。无服务器可以意味着两件不同的事情：你不必为长期运行的工作负载管理服务器，也可以意味着将函数作为服务运行。这两种形式的无服务器在 Kubernetes 上都已可用，并且都极其有用。
