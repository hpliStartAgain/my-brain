---
title: "理解 Kubernetes 架构"
date: 2026-05-13
tags: [Kubernetes, 云原生, 架构]
aliases: [Understanding Kubernetes Architecture]
---

# 第 1 章 理解 Kubernetes 架构

## 什么是 Kubernetes？

Kubernetes 是一个包含了大量服务和能力的平台，而且还在不断增长。其核心功能是在你的基础设施中跨宿主机调度容器化工作负载，但这并未止步于此。以下是 Kubernetes 带来的一些其他能力：

- 提供认证和授权（authentication and authorization）
- 调试应用程序
- 访问和摄取日志
- 滚动更新
- 使用集群自动缩放（Cluster Autoscaling）
- 使用水平 Pod 自动缩放器（Horizontal Pod Autoscaler）
- 复制应用实例
- 检查应用健康状态和就绪状态
- 监控资源
- 负载均衡
- 命名与服务发现
- 分发密钥（Secrets）
- 挂载存储系统

我们将在整本书中深入详细地介绍所有这些能力。现在，只需吸收并体会 Kubernetes 能为你的系统带来多大的价值。

Kubernetes 拥有令人印象深刻的范围，但同样重要的是要理解 Kubernetes 明确不提供什么。

## Kubernetes 不是什么

Kubernetes 不是平台即服务（PaaS）。它没有规定许多重要的方面，这些方面留给您或构建在 Kubernetes 之上的其他系统（如 OpenShift 和 Tanzu）来决定。例如：

- Kubernetes 不要求特定的应用类型或框架
- Kubernetes 不要求特定的编程语言
- Kubernetes 不提供数据库或消息队列
- Kubernetes 不区分应用和服务
- Kubernetes 没有一键部署的服务市场
- Kubernetes 不提供内置的函数即服务（FaaS）解决方案
- Kubernetes 不强制度量、监控和告警系统
- Kubernetes 不提供 CI/CD 流水线

## 理解容器编排

Kubernetes 的主要职责是容器编排。这意味着确保所有执行各种工作负载的容器被调度到物理机或虚拟机上运行。容器必须按照部署环境和集群配置的约束高效打包。此外，Kubernetes 还必须关注所有运行中的容器，并替换已死亡、无响应或不健康的容器。Kubernetes 提供了更多能力，你将在后续章节中了解。在本节中，重点在于容器及其编排。

### 物理机、虚拟机和容器

一切始于硬件，也终于硬件。要运行你的工作负载，你需要配置一些实际的硬件。这包括实际的物理机，拥有一定的计算能力（CPU 或核心）、内存和一些本地持久化存储（机械硬盘或 SSD）。此外，你还需要一些共享持久化存储，并通过网络将所有机器连接起来，使它们能够发现彼此并相互通信。此时，你可以在物理机上运行多个虚拟机，或者停留在裸机层面（没有虚拟机）。Kubernetes 可以部署在裸机集群（实际硬件）上，也可以部署在虚拟机集群上。Kubernetes 反过来可以直接在裸机或虚拟机上编排其管理的容器。理论上，一个 Kubernetes 集群可以由裸机和虚拟机混合组成，但这并不常见。还有许多更特殊的配置涉及不同层次的封装，例如在另一个 Kubernetes 集群的命名空间内运行虚拟 Kubernetes 集群。

### 容器的好处

容器代表了大型复杂软件系统开发和运维的真正范式转变。以下是相比传统模型的一些好处：

- 敏捷的应用创建和部署
- 持续开发、集成和部署
- 开发与运维的关注点分离
- 开发、测试、预发布和生产环境的一致性
- 跨云和操作系统分发的可移植性
- 以应用为中心的管理
- 资源隔离
- 资源利用率

### 云中的容器

微服务（Microservices）是现代大规模系统的主流架构。其核心思想是将系统拆分为具有明确定义职责的小型服务，这些服务管理自己的数据，并通过定义良好的 API 与其他微服务通信。

容器是封装微服务的理想选择，因为在为微服务提供隔离的同时，它们非常轻量，部署大量微服务时不会像虚拟机那样产生大量开销。这使得容器非常适合云部署，因为为每个微服务分配一整台虚拟机将是成本高昂的。

如今，所有主要云提供商，如 Amazon AWS、Google 的 GCE 和 Microsoft 的 Azure，都提供容器托管服务。许多其他公司也加入了 Kubernetes 的行列，提供托管的 Kubernetes 服务，包括 IBM IKS、阿里云、DigitalOcean DKS、Oracle OKS、OVH Managed Kubernetes 和 Rackspace KaaS。

Google 的 GKE 始终基于 Kubernetes。AWS Elastic Kubernetes Service（EKS）是在专有的 AWS ECS 编排解决方案之外新增的。Microsoft Azure 的容器服务最初基于 Apache Mesos，但后来转向了 Kubernetes，推出了 Azure Kubernetes Service（AKS）。你始终可以在所有云平台上部署 Kubernetes，但过去它与其它服务的集成并不深入。然而，在 2017 年底，所有云提供商都宣布了直接支持 Kubernetes。Microsoft 推出了 AKS，AWS 发布了 EKS。此外，其他多家公司也提供托管的 Kubernetes 服务，例如 IBM、Oracle、Digital Ocean、阿里云、腾讯云和华为云。

### 牲畜与宠物

在过去，当系统规模较小时，每台服务器都有自己的名字。开发者和用户确切地知道每台机器上运行着什么软件。我记得，在我工作过的许多公司里，我们会进行为期多天的讨论，以决定服务器的命名主题。例如，作曲家或希腊神话人物是流行的选择。一切都非常惬意。你像对待心爱的宠物一样对待你的服务器。当一台服务器宕机时，就是一场重大危机。每个人都手忙脚乱地试图弄明白去哪里找另一台服务器，宕机的服务器上甚至运行着什么，以及如何让它在新的服务器上工作。如果服务器存储了一些重要数据，那么希望你有最新的备份，也许你甚至能够恢复它。

显然，这种方法无法扩展。当你拥有几十或几百台服务器时，你必须开始像对待牲畜一样对待它们。你考虑的是整体，而不是个体。你可能仍然有一些像 CI/CD 机器这样的"宠物"（尽管托管式 CI/CD 解决方案越来越普遍），但你的 Web 服务器和后端服务只是"牲畜"。

Kubernetes 将"牲畜"方法发挥到了极致，并全权负责将容器分配到特定的机器上。大多数情况下，你不需要与单个机器（节点）进行交互。这对于无状态工作负载效果最好。对于有状态应用，情况略有不同，但 Kubernetes 提供了一种称为 StatefulSet 的解决方案，我们稍后将讨论。

在本节中，我们介绍了容器编排的概念，讨论了宿主机（物理机或虚拟机）与容器之间的关系，以及在云中运行容器的好处。然后我们讨论了"牲畜与宠物"的理念。在下一节中，我们将认识 Kubernetes 的世界，学习它的概念和术语。

## Kubernetes 概念

在本节中，我们将简要介绍许多重要的 Kubernetes 概念，并为你提供一些背景知识，说明为什么需要它们以及它们如何相互交互。目标是熟悉这些术语和概念。之后，我们将看到这些概念如何被编织在一起，并组织成 API 组和资源类别，以实现卓越功能。你可以将其中许多概念视为构建块。一些概念，如节点（Node）和控制平面（Control Plane），是作为一组 Kubernetes 组件实现的。这些组件处于不同的抽象层次，我们将在专门的章节"Kubernetes 组件"中详细讨论。

以下是 Kubernetes 架构图：

![图 1.1: Kubernetes 架构](ch01-fig01.jpg)

### 节点（Node）

节点是单个宿主机。它可以是物理机或虚拟机。其职责是运行 Pod。每个 Kubernetes 节点运行多个 Kubernetes 组件，例如 kubelet、容器运行时和 kube-proxy。节点由 Kubernetes 控制平面管理。节点是 Kubernetes 的工蜂，承担所有繁重的工作。在过去，它们被称为 minions。如果你读到一些旧文档或文章，不要混淆。Minions 就是节点。

### 集群（Cluster）

集群是提供计算、内存、存储和网络资源的宿主机（节点）的集合。Kubernetes 使用这些资源来运行构成你的系统的各种工作负载。请注意，你的整个系统可能由多个集群组成。我们将在后面详细讨论这种多集群系统的高级用例。

### 控制平面（Control Plane）

Kubernetes 的控制平面由多个组件组成，例如 API 服务器（API Server）、调度器（Scheduler）、控制器管理器（Controller Manager）以及可选的云控制器管理器（Cloud Controller Manager）。控制平面负责集群的全局状态、集群级别的 Pod 调度以及事件处理。通常，所有控制平面组件都设置在同一台宿主机上，尽管这不是必须的。在考虑高可用性场景或非常大的集群时，你会希望拥有控制平面冗余。我们将在第 3 章"高可用性与可靠性"中详细讨论高可用集群。

### Pod

Pod 是 Kubernetes 中的工作单元。每个 Pod 包含一个或多个容器（因此你可以将其视为"容器的容器"）。Pod 作为一个原子单元被调度（其所有容器在同一台机器上运行）。Pod 中的所有容器具有相同的 IP 地址和端口空间；它们可以使用 localhost 或标准进程间通信相互通信。此外，Pod 中的所有容器可以访问运行该 Pod 的节点上的共享本地存储。默认情况下，容器不会自动获得对本地存储或任何其他存储的访问权限。存储卷必须显式挂载到 Pod 内的每个容器中。

Pod 是 Kubernetes 的一个重要特性。可以在单个容器内运行多个应用程序，方法是通过类似 supervisord 的主进程来管理多个进程，但这种做法通常不被推荐，原因如下：

- **透明性（Transparency）**：使 Pod 内的容器对基础设施可见，使基础设施能够为这些容器提供服务，例如进程管理和资源监控。这为用户带来了许多便利。
- **解耦软件依赖（Decoupling software dependencies）**：各个容器可以独立地进行版本控制、重建和重新部署。Kubernetes 甚至可能在未来支持单个容器的实时更新。
- **易用性（Ease of use）**：用户无需运行自己的进程管理器，也无需担心信号和退出码传播等问题。
- **效率（Efficiency）**：因为基础设施承担了更多责任，容器可以更加轻量化。

Pod 为管理相互依赖、需要在同一宿主机上协作以完成其目标的紧密相关的容器组提供了极好的解决方案。重要的是要记住，Pod 被认为是临时的、可丢弃的实体，可以随意丢弃和替换。每个 Pod 都有一个唯一的 ID（UID），因此必要时你仍然可以区分它们。

### 标签（Label）

标签是用于将一组对象（通常是通过选择器关联的 Pod）分组在一起的键值对。这对其他几个概念很重要，例如 ReplicaSet、Deployment 和 Service，它们操作的是动态对象组，需要识别组成员。对象和标签之间存在 NxN 的关系。每个对象可以有多个标签，每个标签也可以应用于不同的对象。

标签在设计上存在某些限制。每个对象上的每个标签必须具有唯一的键。标签键必须遵循严格的语法。请注意，标签专门用于标识对象，而不是用于将任意元数据附加到对象。这是注解（Annotation）的用途（参见"注解"部分）。

### 标签选择器（Label Selector）

标签选择器用于基于标签选择对象。基于等值的选择器指定一个键名和一个值。有两个操作符，`=`（或 `==`）和 `!=`，用于基于值的相等或不等判断。例如：

```
role = webserver
```

这将选择所有具有该标签键和值的对象。

标签选择器可以有多个需求，用逗号分隔。例如：

```
role = webserver, application != foo
```

基于集合的选择器扩展了能力，允许基于多个值进行选择：

```
role in (webserver, backend)
```

### 注解（Annotation）

注解允许你将任意元数据与 Kubernetes 对象相关联。Kubernetes 仅存储注解并使其元数据可用。注解键的语法与标签键有类似的要求。

根据我的经验，在复杂的系统中你总是需要这样的元数据，Kubernetes 认识到这种需求并开箱即用地提供了它，这样你就不必自己设计单独的元数据存储和对象到元数据的映射了。

### 服务（Service）

服务用于向用户或其他服务暴露某些功能。它们通常包含一组 Pod —— 你猜对了 —— 通过标签来识别。你可以有访问外部资源的服务，或者直接在虚拟 IP 层面控制你拥有的 Pod。原生 Kubernetes 服务通过便捷的端点暴露。请注意，服务工作在第三层（TCP/UDP）。Kubernetes 1.2 新增了 Ingress 对象，它提供了对 HTTP 对象的访问 —— 稍后会详细介绍。

服务通过以下两种机制之一发布或发现：DNS 或环境变量。服务可以由 Kubernetes 在集群内部进行负载均衡。但是，对于使用外部资源或需要特殊处理的服务，开发者可以选择自己管理负载均衡。与 IP 地址、虚拟 IP 地址和端口空间相关有许多繁琐的细节。我们将在第 10 章"探索 Kubernetes 网络"中深入讨论。

### 卷（Volume）

Pod 使用的本地存储是临时的，在大多数情况下会随 Pod 一起消失。如果目标只是在同一节点的容器之间交换数据，这或许就足够了。但有时数据需要比 Pod 存活更久，或者在 Pod 之间共享数据也很重要。卷的概念支持了这种需求。卷的本质是一个包含某些数据的目录，被挂载到容器中。

卷类型有很多。最初，Kubernetes 直接支持许多卷类型，但现代通过 Container Storage Interface（CSI）扩展 Kubernetes 卷类型的方式，我们将在第 6 章"管理存储"中详细讨论。大多数最初内置的卷类型已经（或正在）被淘汰，取而代之的是通过 CSI 可用的树外（out-of-tree）插件。

### 复制控制器（Replication Controller）与 ReplicaSet

复制控制器和 ReplicaSet 都管理由标签选择器标识的一组 Pod，并确保一定数量的 Pod 始终在运行。它们之间的主要区别在于，复制控制器通过名称等值来测试成员资格，而 ReplicaSet 可以使用基于集合的选择器。ReplicaSet 是更好的选择，因为它是复制控制器的超集。我预计复制控制器最终会被弃用。Kubernetes 保证你将始终拥有与复制控制器或 ReplicaSet 中指定数量相同的 Pod 在运行。每当由于宿主机节点或 Pod 自身的问题导致数量下降时，Kubernetes 将启动新的实例。请注意，如果你手动启动 Pod 并超过了指定数量，ReplicaSet 控制器将杀死多余的 Pod。

复制控制器过去是许多工作流的核心，例如滚动更新和运行一次性任务。随着 Kubernetes 的发展，它通过专门的对象（如 Deployment、Job、CronJob 和 DaemonSet）为这些工作流提供了直接支持。我们将在后面逐一介绍它们。

### StatefulSet

Pod 来来去去，如果你关心它们的数据，可以使用持久化存储。这都很好。但有时你希望 Kubernetes 管理一个分布式数据存储，例如 Cassandra 或 CockroachDB。这些集群化存储将数据分布在具有唯一标识的节点上。你无法用普通的 Pod 和服务来建模这种情况。这时 StatefulSet 就登场了。如果你还记得之前关于"宠物与牲畜"的讨论，以及"牲畜"是正确的方式，那么 StatefulSet 介于两者之间。

StatefulSet 确保（类似于 ReplicaSet）在任何给定时间运行指定数量的具有唯一标识的实例。StatefulSet 成员具有以下属性：

- 一个在 DNS 中可用的稳定主机名
- 一个序号索引
- 与序号和主机名关联的稳定存储
- 成员按序优雅创建和终止

StatefulSet 有助于对等发现以及安全地添加或移除成员。

### 密钥（Secret）

密钥是包含敏感信息（如凭据和令牌）的小型对象。默认情况下，它们以明文形式存储在 etcd 中，可通过 Kubernetes API 服务器访问，并且可以作为文件挂载到需要访问它们的 Pod 中（使用专用的秘密卷，它们依附于常规的数据卷）。同一个密钥可以挂载到多个 Pod 中。Kubernetes 自身会为其组件创建密钥，你也可以创建自己的密钥。另一种方法是将密钥用作环境变量。请注意，Pod 中的密钥始终存储在内存中（对于挂载的密钥，使用 tmpfs），以提高安全性。最佳做法是启用静态加密以及使用 RBAC 进行访问控制。我们将在后面详细讨论。

### 名称（Name）

Kubernetes 中的每个对象都由一个 UID 和一个名称来标识。名称用于在 API 调用中引用对象。名称最长可达 253 个字符，并使用小写字母数字字符、短横线（-）和点（.）。如果删除一个对象，可以创建一个与被删除对象同名的新对象，但 UID 必须在集群的整个生命周期内保持唯一。UID 由 Kubernetes 生成，因此你无需担心。

### 命名空间（Namespace）

命名空间是一种隔离形式，允许你对资源进行分组并应用策略。它也是名称的作用域。同一类对象在同一个命名空间内必须具有唯一的名称。默认情况下，一个命名空间中的 Pod 可以访问其他命名空间中的 Pod 和服务。

请注意，存在集群范围的对象，如节点对象和持久卷（PersistentVolume），它们不在命名空间中。Kubernetes 可能会将来自不同命名空间的 Pod 调度到同一节点上运行。同样，来自不同命名空间的 Pod 可以使用相同的持久化存储。

在多租户场景中，完全隔离命名空间非常重要，你可以通过适当的网络策略和资源配额来确保对物理集群资源的正确访问和分配。但总的来说，命名空间被认为是一种较弱的隔离形式，还有更适合硬多租户的解决方案，比如虚拟集群，我们将在第 4 章"保护 Kubernetes 安全"中讨论。

我们已经介绍了大多数 Kubernetes 的主要概念；还有几个我简要提及的。在下一节中，我们将继续深入 Kubernetes 架构之旅，研究其设计动机、内部实现，甚至深入源码。

## 深入 Kubernetes 架构

Kubernetes 有着非常宏伟的目标。它旨在管理和简化跨各种环境和云提供商的分布式系统的编排、部署和管理。它提供许多能力和服务，这些都应该能在所有这些多样化的环境和用例中工作，同时不断进化并保持足够简单，以便普通人也能使用。这是一个艰巨的任务。

Kubernetes 通过遵循极其清晰的高级设计和深思熟虑的架构来实现这一点，这种架构促进了可扩展性和可插拔性。

Kubernetes 最初有许多硬编码或环境感知的组件，但趋势是将它们重构为插件，并保持核心的小巧、通用和抽象。

在本节中，我们将像剥洋葱一样剖析 Kubernetes，从各种分布式系统设计模式以及 Kubernetes 如何支持它们开始，然后浏览 Kubernetes 的表面——即其 API 集合，接着查看构成 Kubernetes 的实际组件。最后，我们将快速浏览源代码树，以获得对 Kubernetes 本身结构的更深入理解。在本节结束时，你将扎实地理解 Kubernetes 的架构和实现，以及为什么做出某些设计决策。

### 分布式系统设计模式

借用托尔斯泰在《安娜·卡列尼娜》中的话来说，所有幸福的（正常工作的）分布式系统都是相似的。这意味着，为了正常运行，所有设计良好的分布式系统必须遵循一些最佳实践和原则。Kubernetes 不仅仅想成为一个管理系统。它希望支持和启用这些最佳实践，并为开发者和系统管理员提供高级服务。让我们看看其中一些被称为设计模式的内容。我们将从单节点模式开始，如 Sidecar、Ambassador 和 Adapter。然后讨论多节点模式。

#### Sidecar 模式

Sidecar 模式是关于在 Pod 中与主应用程序容器一起部署另一个容器。应用程序容器不知道 Sidecar 容器的存在，只管做自己的事。一个很好的例子是集中式日志代理。你的主容器可以只将日志输出到 stdout，而 Sidecar 容器会将所有日志发送到集中式日志服务，在那里与整个系统的日志聚合在一起。使用 Sidecar 容器与将集中式日志记录添加到的应用程序容器相比，好处是巨大的。首先，应用程序不再需要承担集中式日志记录的负担，这可能是一种麻烦。如果你想升级或更改集中式日志记录策略，或切换到全新的提供商，只需更新 Sidecar 容器并部署即可。你的任何应用程序容器都不需要更改，因此你不会意外破坏它们。Istio 服务网格使用 Sidecar 模式将其代理注入到每个 Pod 中。

#### Ambassador 模式

Ambassador 模式是关于将远程服务表示为本地服务，并可能实施一些策略。Ambassador 模式的一个很好的例子是，如果你有一个 Redis 集群，其中一个主节点用于写入，多个副本节点用于读取。一个本地的 Ambassador 容器可以作为代理，在 localhost 上将 Redis 暴露给主应用程序容器。主应用程序容器只需连接到 localhost:6379（Redis 的默认端口）上的 Redis，但它连接的是运行在同一个 Pod 中的 Ambassador，Ambassador 过滤请求，将写请求发送到真正的 Redis 主节点，将读请求随机发送到其中一个读副本。就像 Sidecar 模式一样，主应用程序对此一无所知。当在测试中与真正的本地 Redis 集群进行交互时，这非常有帮助。此外，如果 Redis 集群配置发生变化，只需修改 Ambassador；主应用程序可以愉快地保持不知情。

#### Adapter 模式

Adapter 模式是关于标准化主应用程序容器的输出。考虑一个正在逐步推出的服务：它可能生成不符合之前版本的报告。尚在消费该输出的其他服务和应用程序还未升级。可以在同一个 Pod 中部署一个 Adapter 容器与新的应用程序容器一起，调整它们的输出以匹配旧版本，直到所有消费者都已完成升级。Adapter 容器与主应用程序容器共享文件系统，因此它可以监控本地文件系统，一旦新应用程序写入某些内容，它立即进行适配。

#### 多节点模式

前面描述的单节点模式都通过调度在单个节点上的 Pod 得到 Kubernetes 的直接支持。多节点模式涉及调度在多个节点上的 Pod。诸如 Leader 选举、工作队列和分散-收集（Scatter-Gather）等模式并不直接支持，但通过组合具有标准接口的 Pod 来实现这些模式在 Kubernetes 中是一种可行的方法。

### 水平触发基础设施与调谐（Reconciliation）

Kubernetes 的核心就是控制循环。它不断观察自身并纠正问题。水平触发（Level-triggered）基础设施意味着 Kubernetes 有一个期望状态，它不断努力趋近于该状态。例如，如果一个 ReplicaSet 的期望状态是 3 个副本，但实际降到了 2 个，Kubernetes（Kubernetes 的 ReplicaSet 控制器部分）会注意到并努力恢复到 3 个副本。另一种方法是边缘触发（Edge-triggering），它是基于事件的。如果副本数量从 2 降到 3，就创建一个新的副本。这种方法非常脆弱，有许多边缘情况，尤其是在分布式系统中，副本出现和消失等事件可能同时发生。

在深入讨论 Kubernetes 架构之后，让我们来研究 Kubernetes API。

## Kubernetes API

如果你想理解一个系统的能力及其提供的内容，你必须密切关注它的 API。API 提供了作为用户你可以对系统做什么的全面视图。Kubernetes 通过 API 组（API Groups）暴露了多套用于不同目的和受众的 REST API。一些 API 主要供工具使用，一些可以直接由开发人员使用。API 的一个重要方面是它们处于持续开发之中。Kubernetes 开发者通过尝试扩展（添加新对象，以及向现有对象添加新字段）并避免重命名或删除现有对象和字段来保持可控性。此外，所有 API 端点都带有版本号，并且通常还有 alpha 或 beta 标注。例如：

```
/api/v1
/api/v2alpha1
```

你可以通过 kubectl CLI、客户端库或直接通过 REST API 调用访问 API。存在复杂的认证和授权机制，我们将在第 4 章"保护 Kubernetes 安全"中探讨。如果你拥有正确的权限，你可以列出、查看、创建、更新和删除各种 Kubernetes 对象。现在，让我们先窥探一下 API 的概貌。

探索 API 的最佳方式是通过 API 组。一些 API 组默认启用。其他组可以通过标志启用/禁用。例如，要禁用 `autoscaling/v1` 组并启用 `autoscaling/v2beta2` 组，可以在运行 API 服务器时设置 `--runtime-config` 标志，如下所示：

```
--runtime-config=autoscaling/v1=false,autoscaling/v2beta2=true
```

请注意，云中的托管 Kubernetes 集群不允许你为 API 服务器指定标志（因为它们替你管理）。

### 资源类别

除了 API 组之外，另一种有用的 API 分类方法是按功能进行。Kubernetes API 非常庞大，将其分解为类别在查找你需要的内容时有很大帮助。Kubernetes 定义了以下资源类别：

- **工作负载（Workloads）**：用于在集群上管理和运行容器的对象。
- **发现与负载均衡（Discovery and Load Balancing）**：用于将工作负载暴露给外部世界，作为可外部访问的负载均衡服务的对象。
- **配置与存储（Config and Storage）**：用于初始化和配置你的应用程序，以及持久化容器外部数据的对象。
- **集群（Cluster）**：定义集群自身如何配置的对象；通常仅供集群操作人员使用。
- **元数据（Metadata）**：用于配置集群内其他资源行为的对象，例如用于扩缩工作负载的 HorizontalPodAutoscaler。

在下面的小节中，我们将列出属于每个组的资源及其所属的 API 组。我们不会在这里指定版本，因为 API 从 alpha 到 beta 再到 GA（正式发布），以及从 V1 到 V2 等演进速度很快。

#### 工作负载资源类别

工作负载类别包含以下资源及其对应的 API 组：

- Container: core
- CronJob: batch
- ControllerRevision: apps
- DaemonSet: apps
- Deployment: apps
- HorizontalPodAutoscaler: autoscaling
- Job: batch
- Pod: core
- PodTemplate: core
- PriorityClass: scheduling.k8s.io
- ReplicaSet: apps
- ReplicationController: core
- StatefulSet: apps

控制器在 Pod 内创建容器。Pod 执行容器并提供必要的依赖，例如共享或持久化存储卷，以及注入到容器中的配置或密钥数据。

以下是最常见操作的详细描述之一，即作为 REST API 获取所有命名空间中的所有 Pod 列表：

```
GET /api/v1/pods
```

它接受各种查询参数（全部可选）：

- **fieldSelector**：指定一个选择器，根据字段缩小返回对象的范围。默认行为包括所有对象。
- **labelSelector**：定义一个选择器，根据标签过滤返回的对象。默认情况下，包括所有对象。
- **limit/continue**：`limit` 参数指定在列表调用中返回的最大响应数。如果有更多项目可用，服务器会在列表元数据中设置 `continue` 字段。该值可以与初始查询一起使用，以获取下一组结果。
- **pretty**：当设置为 `'true'` 时，输出以一种人类可读的格式呈现。
- **resourceVersion**：设置一个约束，限制请求可以服务的可接受的资源版本。如果未指定，默认为未设置。
- **resourceVersionMatch**：确定在列表调用中如何应用 `resourceVersion` 约束。如果未指定，默认为未设置。
- **timeoutSeconds**：指定列表/监视调用的超时持续时间。这限制了调用的持续时间，无论是否有任何活动或不活动。
- **watch**：启用对所述资源变更的监视，并返回添加、更新和删除的持续通知流。必须指定 `resourceVersion` 参数。

#### 发现与负载均衡

默认情况下，集群中的工作负载仅在集群内部可访问。要使它们可从外部访问，需要使用 LoadBalancer 或 NodePort 类型的 Service。但是，出于开发目的，可以通过 API 服务器使用 `kubectl proxy` 命令访问内部可访问的工作负载：

- Endpoints: core
- EndpointSlice: discovery.k8s.io/v1
- Ingress: networking.k8s.io
- IngressClass: networking.k8s.io
- Service: core

#### 配置与存储

无需重新部署的动态配置和密钥管理是 Kubernetes 以及在 Kubernetes 集群上运行复杂分布式应用的基石。密钥和配置不会烘焙到容器镜像中，而是存储在 Kubernetes 状态存储（通常是 etcd）中。Kubernetes 还提供了许多用于管理任意存储的抽象。以下是一些主要资源：

- ConfigMap: core
- CSIDriver: storage.k8s.io
- CSINode: storage.k8s.io
- CSIStorageCapacity: storage.k8s.io
- Secret: core
- PersistentVolumeClaim: core
- StorageClass: storage.k8s.io
- Volume: core
- VolumeAttachment: storage.k8s.io

#### 元数据

元数据资源通常作为它们所配置的资源的子资源出现。例如，LimitRange 在命名空间级别定义，可以指定：

- 命名空间内 Pod 或容器的计算资源使用范围（最小值和最大值）。
- 命名空间内每个 PersistentVolumeClaim 的存储请求范围（最小值和最大值）。
- 命名空间内特定资源的 resource request 和 limit 之间的比例。
- 命名空间内计算资源的默认 request/limit，这些将在运行时自动注入到容器中。

大多数情况下你不会直接与这些对象交互。元数据资源有很多。你可以在以下网址找到完整列表：https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.24/#-strong-metadata-apis-strong-

#### 集群

集群类别中的资源专供集群操作人员使用，而非开发者。此类别中也有很多资源。以下是一些最重要的资源：

- Namespace: core
- Node: core
- PersistentVolume: core
- ResourceQuota: core
- Role: rbac.authorization.k8s.io
- RoleBinding: rbac.authorization.k8s.io
- ClusterRole: rbac.authorization.k8s.io
- ClusterRoleBinding: rbac.authorization.k8s.io
- NetworkPolicy: networking.k8s.io

现在我们了解了 Kubernetes 如何通过 API 组和资源类别来组织和暴露其能力，接下来看看它如何管理物理基础设施并使其与集群状态保持一致。

## Kubernetes 组件

一个 Kubernetes 集群有多个用于控制集群的控制平面组件，以及运行在每个工作节点上的节点组件。让我们来了解所有这些组件以及它们如何协同工作。

### 控制平面组件

所有控制平面组件可以在一个节点上运行，但在高可用性设置或非常大的集群中，它们可能分布在多个节点上。

#### API 服务器

Kubernetes API 服务器暴露了 Kubernetes REST API。它可以轻松水平扩展，因为它是无状态的，并将所有数据存储在 etcd 集群（或 k3s 等 Kubernetes 发行版中的其他数据存储）中。API 服务器是 Kubernetes 控制平面的化身。

#### etcd

etcd 是一个高可靠的分布式数据存储。Kubernetes 使用它来存储整个集群状态。在小型、临时性集群中，etcd 的单个实例可以与其他所有控制平面组件运行在同一个节点上。但对于更重要的集群，通常需要一个三节点甚至五节点的 etcd 集群，以实现冗余和高可用性。

#### Kube Controller Manager

Kube Controller Manager 是多个管理器的集合，打包在一个二进制文件中。它包含 ReplicaSet 控制器、Pod 控制器、Service 控制器、Endpoints 控制器等。所有这些管理器通过 API 监视集群状态，它们的工作是将集群导向期望状态。

#### Cloud Controller Manager

在云中运行时，Kubernetes 允许云提供商集成其平台，用于管理节点、路由、服务和卷。云提供商代码与 Kubernetes 代码交互。它取代了 Kube Controller Manager 的某些功能。当使用 Cloud Controller Manager 运行 Kubernetes 时，必须将 Kube Controller Manager 的 `--cloud-provider` 标志设置为 `external`。这将禁用 Cloud Controller Manager 正在接管的控制循环。

Cloud Controller Manager 是在 Kubernetes 1.6 中引入的，已经被多个云提供商使用，例如：

- GCP
- AWS
- Azure
- BaiduCloud
- Digital Ocean
- Oracle
- Linode

好的。让我们看一些代码。具体的代码并不是那么重要。目标只是让你感受一下 Kubernetes 代码的样子。Kubernetes 是用 Go 实现的。关于 Go 的一个快速说明，以帮助你解析代码：方法名称在前，后面是括号中的方法参数。每个参数是一对，由名称及其类型组成。最后是指定返回值。Go 允许有多个返回类型。非常常见的是在返回实际结果的同时返回一个 error 对象。如果一切正常，error 对象将为 nil。

以下是 cloudprovider 包的主要接口：

```go
package cloudprovider

import (
	"context"
	"errors"
	"fmt"
	"strings"

	v1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/informers"
	clientset "k8s.io/client-go/kubernetes"
	restclient "k8s.io/client-go/rest"
)

// Interface is an abstract, pluggable interface for cloud providers.
type Interface interface {
	Initialize(clientBuilder ControllerClientBuilder, stop <-chan struct{})
	LoadBalancer() (LoadBalancer, bool)
	Instances() (Instances, bool)
	InstancesV2() (InstancesV2, bool)
	Zones() (Zones, bool)
	Clusters() (Clusters, bool)
	Routes() (Routes, bool)
	ProviderName() string
	HasClusterID() bool
}
```

大多数方法返回其他接口，这些接口又有自己的方法。例如，以下是 LoadBalancer 接口：

```go
type LoadBalancer interface {
	GetLoadBalancer(ctx context.Context, clusterName string, service *v1.Service) (status *v1.LoadBalancerStatus, exists bool, err error)
	GetLoadBalancerName(ctx context.Context, clusterName string, service *v1.Service) string
	EnsureLoadBalancer(ctx context.Context, clusterName string, service *v1.Service, nodes []*v1.Node) (*v1.LoadBalancerStatus, error)
	UpdateLoadBalancer(ctx context.Context, clusterName string, service *v1.Service, nodes []*v1.Node) error
	EnsureLoadBalancerDeleted(ctx context.Context, clusterName string, service *v1.Service) error
}
```

#### Kube Scheduler

kube-scheduler 负责将 Pod 调度到节点上。这是一个非常复杂的任务，因为它需要考虑多个相互作用的因素，例如：

- 资源需求
- 服务需求
- 硬件/软件策略约束
- 节点亲和性和反亲和性规范
- Pod 亲和性和反亲和性规范
- 污点（Taints）和容忍度（Tolerations）
- 本地存储需求
- 数据本地性
- 截止时间

如果你需要一些默认 Kube Scheduler 未覆盖的特殊调度逻辑，你可以用自己的自定义调度器替换它。你也可以将自定义调度器与默认调度器一起运行，让自定义调度器只调度一部分 Pod。

#### DNS

从 Kubernetes 1.3 开始，DNS 服务成为标准 Kubernetes 集群的一部分。它作为一个普通 Pod 被调度。每个 Service（除了 headless 服务）都会获得一个 DNS 名称。Pod 也可以获得 DNS 名称。这对于自动发现非常有用。

我们介绍了所有控制平面组件。接下来看看运行在每个节点上的 Kubernetes 组件。

### 节点组件

集群中的节点需要一些组件来与 API 服务器交互、接收要执行的工作负载，以及向 API 服务器更新其状态。

#### Proxy

kube-proxy 在每个节点上执行低层次的网络维护。它在本地反映 Kubernetes 服务，并可以执行 TCP 和 UDP 转发。它通过环境变量或 DNS 找到集群 IP。

#### kubelet

kubelet 是 Kubernetes 在节点上的代表。它负责与 API 服务器通信并管理正在运行的 Pod。这包括以下内容：

- 接收 Pod 规范
- 从 API 服务器下载 Pod 密钥
- 挂载卷
- 运行 Pod 的容器（通过配置的容器运行时）
- 报告节点和每个 Pod 的状态
- 运行容器存活（liveness）、就绪（readiness）和启动（startup）探针

在本节中，我们深入挖掘了 Kubernetes 的内部，从最高层面的愿景和支撑的设计模式，到其 API 以及用于控制和管理集群的组件，探索了其架构。在下一节中，我们将快速了解 Kubernetes 支持的各种运行时。

## Kubernetes 容器运行时

Kubernetes 最初只支持 Docker 作为容器运行时引擎。但现在情况已不再如此。Kubernetes 现在支持任何实现了 CRI 接口的运行时。

在本节中，你将深入了解 CRI，并了解一些实现了它的运行时引擎。在本节结束时，你将能够做出明智的决定，判断哪种容器运行时适合你的用例，以及在什么情况下你可以切换甚至在同一系统中组合多个运行时。

### 容器运行时接口（CRI）

CRI 是一个 gRPC API，包含容器运行时与节点上的 kubelet 集成的规范/要求和库。在 Kubernetes 1.7 中，Kubernetes 内部的 Docker 集成被替换为基于 CRI 的集成。这是一个重大的变化。它打开了通往多种实现的大门，这些实现可以利用容器领域的进步。kubelet 不需要直接与多个运行时接口。相反，它可以与任何符合 CRI 的容器运行时通信。下图说明了这一流程：

![图 1.2: kubelet 与 CRI](ch01-fig02.png)

CRI 容器运行时（或 shim）必须实现两个 gRPC 服务接口：`ImageService` 和 `RuntimeService`。`ImageService` 负责管理镜像。以下是 gRPC/protobuf 接口（这不是 Go 语言）：

```protobuf
service ImageService {
  rpc ListImages(ListImagesRequest) returns (ListImagesResponse) {}
  rpc ImageStatus(ImageStatusRequest) returns (ImageStatusResponse) {}
  rpc PullImage(PullImageRequest) returns (PullImageResponse) {}
  rpc RemoveImage(RemoveImageRequest) returns (RemoveImageResponse) {}
  rpc ImageFsInfo(ImageFsInfoRequest) returns (ImageFsInfoResponse) {}
}
```

`RuntimeService` 负责管理 Pod 和容器。以下是 gRPC/protobuf 接口：

```protobuf
service RuntimeService {
  rpc Version(VersionRequest) returns (VersionResponse) {}
  rpc RunPodSandbox(RunPodSandboxRequest) returns (RunPodSandboxResponse) {}
  rpc StopPodSandbox(StopPodSandboxRequest) returns (StopPodSandboxResponse) {}
  rpc RemovePodSandbox(RemovePodSandboxRequest) returns (RemovePodSandboxResponse) {}
  rpc PodSandboxStatus(PodSandboxStatusRequest) returns (PodSandboxStatusResponse) {}
  rpc ListPodSandbox(ListPodSandboxRequest) returns (ListPodSandboxResponse) {}
  rpc CreateContainer(CreateContainerRequest) returns (CreateContainerResponse) {}
  rpc StartContainer(StartContainerRequest) returns (StartContainerResponse) {}
  rpc StopContainer(StopContainerRequest) returns (StopContainerResponse) {}
  rpc RemoveContainer(RemoveContainerRequest) returns (RemoveContainerResponse) {}
  rpc ListContainers(ListContainersRequest) returns (ListContainersResponse) {}
  rpc ContainerStatus(ContainerStatusRequest) returns (ContainerStatusResponse) {}
  rpc UpdateContainerResources(UpdateContainerResourcesRequest) returns (UpdateContainerResourcesResponse) {}
  rpc ExecSync(ExecSyncRequest) returns (ExecSyncResponse) {}
  rpc Exec(ExecRequest) returns (ExecResponse) {}
  rpc Attach(AttachRequest) returns (AttachResponse) {}
  rpc PortForward(PortForwardRequest) returns (PortForwardResponse) {}
  rpc ContainerStats(ContainerStatsRequest) returns (ContainerStatsResponse) {}
  rpc ListContainerStats(ListContainerStatsRequest) returns (ListContainerStatsResponse) {}
  rpc UpdateRuntimeConfig(UpdateRuntimeConfigRequest) returns (UpdateRuntimeConfigResponse) {}
  rpc Status(StatusRequest) returns (StatusResponse) {}
}
```

用作参数和返回值的数据类型称为消息（messages），它们也作为 API 的一部分定义。以下是其中之一：

```protobuf
message CreateContainerRequest {
  string pod_sandbox_id = 1;
  ContainerConfig config = 2;
  PodSandboxConfig sandbox_config = 3;
}
```

如你所见，消息可以相互嵌套。`CreateContainerRequest` 消息有一个 string 字段和另外两个字段，它们本身也是消息：`ContainerConfig` 和 `PodSandboxConfig`。

要了解更多关于 gRPC 和 CRI 的信息，请查看以下资源：
- https://grpc.io
- https://kubernetes.io/docs/concepts/architecture/cri/

现在你已经从代码层面熟悉了 Kubernetes 认为的运行时引擎是什么，让我们简要介绍各个运行时引擎。

### Docker

Docker 曾经是容器领域的 800 磅大猩猩。Kubernetes 最初设计为只管理 Docker 容器。多运行时能力首次在 Kubernetes 1.3 中引入，CRI 在 Kubernetes 1.5 中引入。在此之前，Kubernetes 只能管理 Docker 容器。即使在 CRI 引入之后，Kubernetes 源码中仍然保留了一个 Dockershim，它直到 Kubernetes 1.24 才被移除。自那以后，Docker 不再获得任何特殊待遇。

我假设如果你在读这本书，你对 Docker 及其带来的价值非常熟悉。Docker 享有巨大的流行度和增长，但也有很多针对它的批评。批评者经常提到以下问题：

- 安全性
- 设置多容器应用（特别是网络）的困难
- 开发、监控和日志记录
- Docker 容器运行单一命令的限制
- 半成品功能发布过快

Docker 意识到了这些批评，并已经解决了一些问题。特别是，Docker 在其 Docker Swarm 产品上投入了大量资源。Docker Swarm 是一个 Docker 原生编排解决方案，与 Kubernetes 竞争。它比 Kubernetes 更易用，但不如 Kubernetes 强大或成熟。

从 2016 年 4 月发布的 Docker 1.11 开始，Docker 改变了它运行容器的方式。运行时现在使用 containerd 和 runC 来运行容器中的 Open Container Initiative（OCI）镜像：

![图 1.3: Docker 与 OCI](ch01-fig03.png)

从 Docker 1.12 开始，Swarm 模式被原生包含在 Docker 守护进程中，这由于臃肿和范围蔓延而让一些人不满。结果，更多人转向了其他容器运行时。

2021 年 9 月，Docker 要求大型组织为 Docker Desktop 付费订阅。如你所料，这并不受欢迎，许多组织争相寻找替代方案。Docker Desktop 是 Docker 的客户端分发版和 UI，不影响容器运行时本身。但这进一步侵蚀了 Docker 在社区中的声誉和好感。

### containerd

containerd 自 2019 年起已成为 CNCF 的毕业项目。现在它是 Kubernetes 容器的主流选择。所有主要云提供商都支持它，自 Kubernetes 1.24 起，它已成为默认的容器运行时。

此外，Docker 容器运行时本身也是构建在 containerd 之上的。

### CRI-O

CRI-O 是一个 CNCF 孵化项目。它旨在提供 Kubernetes 与 OCI 兼容容器运行时（如 Docker）之间的集成路径。CRI-O 提供以下能力：

- 支持多种镜像格式，包括现有的 Docker 镜像格式
- 支持多种下载镜像的方式，包括信任和镜像验证
- 容器镜像管理（管理镜像层、overlay 文件系统等）
- 容器进程生命周期管理
- 满足 CRI 要求的监控和日志记录
- CRI 要求的资源隔离

它目前支持 runC 和 Kata Containers，但任何符合 OCI 的容器运行时都可以插入并与 Kubernetes 集成。

### 轻量级虚拟机

Kubernetes 在同一节点上运行来自不同应用程序的容器，共享同一个操作系统。这允许以非常高效的方式运行大量容器。然而，容器隔离是一个严重的安全问题，已经发生了多起权限提升事件，这推动了对不同方法的浓厚兴趣。轻量级虚拟机提供了强大的 VM 级别隔离，但又不像标准虚拟机那样笨重，这使得它们能够作为 Kubernetes 上的容器运行。一些突出的项目包括：

- AWS Firecracker
- Google gVisor
- Kata Containers
- Singularity
- SmartOS

在本节中，我们介绍了 Kubernetes 支持的各种运行时引擎，以及标准化、趋同和将运行时支持从 Kubernetes 核心外部化的趋势。

## 总结

在本章中，我们覆盖了很多内容。你了解了 Kubernetes 的组织、设计和架构。Kubernetes 是一个面向作为容器运行的微服务应用的编排平台。Kubernetes 集群拥有一个控制平面和工作节点。容器在 Pod 内运行。每个 Pod 运行在单个物理机或虚拟机上。Kubernetes 直接支持许多概念，例如 Service、标签和持久化存储。你可以在 Kubernetes 上实现各种分布式系统设计模式。容器运行时只需要实现 CRI 即可。Docker、containerd、CRI-O 等均受支持。

在第 2 章"创建 Kubernetes 集群"中，我们将探讨创建 Kubernetes 集群的各种方式，讨论何时使用不同的选项，并构建一个本地多节点集群。

## 加入我们的 Discord！

与其他用户、云专家、作者和志同道合的专业人士一起阅读本书。提问、为其他读者提供解决方案、通过"问我任何事"（Ask Me Anything）会议与作者聊天等。

扫描二维码或访问链接立即加入社区：
https://packt.link/cloudanddevops
