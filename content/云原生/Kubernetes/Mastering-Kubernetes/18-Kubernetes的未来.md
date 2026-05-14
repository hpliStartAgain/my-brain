---
title: "18 - Kubernetes的未来"
date: 2026-05-13
tags:
  - Kubernetes/Mastering-Kubernetes/未来
---

# Kubernetes的未来

在本章中，我们将从多个角度展望 Kubernetes 的未来。我们将从 Kubernetes 自诞生以来在社区、生态系统和思想占有率等维度上的发展势头开始。剧透警告——Kubernetes 以压倒性优势赢得了容器编排之战。随着 Kubernetes 的发展和成熟，竞争战线从击败竞争对手转变为对抗自身复杂性。由于容器编排仍然是一个新的、快速发展的、尚未被充分理解的领域，可用性、工具化和教育将发挥重要作用。然后，我们将看看一些非常有趣的模式和趋势。最后，我们将回顾我在第二版中的预测，并将做出一些新的预测。

涵盖的主题如下：

- Kubernetes 的发展势头
- CNCF 的重要性
- Kubernetes 的可扩展性
- 服务网格集成
- Kubernetes 上的无服务器计算
- Kubernetes 与虚拟机
- 集群自动扩缩
- 无处不在的 Operator
- Kubernetes 用于人工智能
- Kubernetes 的挑战

## Kubernetes 的发展势头

不可否认，Kubernetes 是一个巨无霸。Kubernetes 不仅击败了所有其他容器编排器，它还是公有云上的事实标准解决方案，被许多私有云使用，甚至 VMware——这家虚拟机公司——也专注于 Kubernetes 解决方案并将其产品与 Kubernetes 集成。

由于其可扩展的设计，Kubernetes 在多云和混合云场景中工作得非常好。此外，Kubernetes 也在边缘领域取得进展，通过定制发行版进一步扩展了其广泛的适用性。

Kubernetes 项目继续像发条一样每三个月发布一个新版本。社区在持续增长。

Kubernetes GitHub 仓库已拥有近 100,000 颗星标。这种惊人增长的主要驱动力之一是 CNCF（云原生计算基金会）。

![Star History 图表](ch18-fig01.png)

## CNCF 的重要性

CNCF 已成为云计算领域一个非常重要的组织。虽然它并非 Kubernetes 专用，但 Kubernetes 的主导地位是不可否认的。Kubernetes 是第一个毕业的项目，而大多数其他项目都严重倾向于 Kubernetes。特别是，CNCF 仅提供 Kubernetes 的认证和培训。CNCF 的职责之一，是确保云技术不会遭受供应商锁定。请查看整个 CNCF 全景图的惊人图表：https://landscape.cncf.io。

### 项目分类

CNCF 为项目分配成熟度级别：毕业（Graduated）、孵化（Incubating）和沙箱（Sandbox）：

![CNCF 成熟度级别](images/ch18-fig02.png)

项目从某个级别开始——沙箱或孵化——随着时间的推移，可以毕业。这并不意味着只有毕业项目才能安全使用。许多孵化甚至沙箱项目被广泛用于生产环境。例如，etcd 是 Kubernetes 本身的持久化状态存储，它只是一个孵化项目。显然，它是一个高度可信的组件。Virtual Kubelet 是一个沙箱项目，驱动着 AWS Fargate 和 Microsoft ACI。这显然是企业级软件。

CNCF 项目分类的主要好处是帮助导航围绕 Kubernetes 发展起来的令人难以置信的生态系统。当你寻找使用其他技术和工具扩展你的 Kubernetes 解决方案时，CNCF 项目是一个好的起点。

### 认证

当技术开始提供认证计划时，你可以说它们将长久存在。CNCF 提供几种类型的认证：

- **认证 Kubernetes（Certified Kubernetes）**：针对符合规范的 Kubernetes 发行版和安装程序（约 90 个）。
- **Kubernetes 认证服务提供商（KCSP）**：针对经过审查、具有深厚 Kubernetes 经验的服务提供商（134 家提供商）。
- **认证 Kubernetes 管理员（CKA）**：针对管理员。
- **认证 Kubernetes 应用开发者（CKAD）**：针对开发者。
- **认证 Kubernetes 安全专家（CKS）**：针对安全专家。

### 培训

CNCF 也提供培训。有一个免费的 Kubernetes 入门课程，以及几个与 CKA 和 CKAD 认证考试相符的付费课程。此外，CNCF 维护着一个 Kubernetes 培训合作伙伴列表（https://landscape.cncf.io/card-mode?category=kubernetes-training-partner&grouping=category）。

如果你正在寻找免费的 Kubernetes 培训，以下是一些选择：

- VMware Kubernetes Academy
- Google Kubernetes Engine on Coursera

### 社区和教育

CNCF 还组织 KubeCon、CloudNativeCon 等会议和聚会，并维护着多种沟通渠道，如 Slack 频道和邮件列表。它还发布调查报告。

参与者和与会者的数量年复一年地增长。

### 工具

用于管理容器和集群的各种插件、扩展和工具的数量持续增长。以下是参与 Kubernetes 生态系统的部分工具、项目和公司：

![Kubernetes 工具](images/ch18-fig03.png)

### 托管 Kubernetes 平台的兴起

如今，几乎所有云提供商都提供可靠的托管 Kubernetes 产品。有时，在特定云提供商上运行 Kubernetes 有多种形式和方式。

#### 公有云 Kubernetes 平台

以下是一些主要的托管平台：

- Google GKE
- Microsoft AKS
- Amazon EKS
- Digital Ocean
- Oracle Cloud
- IBM Cloud Kubernetes Service
- Alibaba ACK
- Tencent TKE

当然，你始终可以自己搭建，仅将公有云提供商用作基础设施提供商。这是 Kubernetes 的一个非常常见的用例。

#### 裸机、私有云和边缘 Kubernetes

在这里，你可以找到专为在特殊环境中运行而设计或配置的 Kubernetes 发行版，通常是在你自己的数据中心作为私有云，或者在更受限的环境中，如小型设备上的边缘计算：

- Google Anthos for GKE
- OpenStack
- Rancher k3S
- Kubernetes on Raspberry PI
- KubeEdge

#### Kubernetes PaaS（平台即服务）

这类产品旨在抽象 Kubernetes 的部分复杂性，并在其前面提供一个更简单的界面。这里有很多变体。其中一些面向多云和混合云场景，一些暴露函数即服务（FaaS）接口，还有一些只专注于更好的安装和支持体验：

- Google Cloud Run
- VMware PKS
- Platform 9 PMK
- Giant Swarm
- OpenShift
- Rancher RKE

## 即将到来的趋势

让我们谈谈 Kubernetes 世界中一些在不久的将来会变得重要的技术趋势。

### 安全

安全当然是大规模系统的首要关注点。Kubernetes 主要是一个管理容器化工作负载的平台。这些容器化工作负载通常在多租户环境中运行。租户之间的隔离非常重要。容器之所以轻量和高效，是因为它们共享操作系统，并通过各种机制（如命名空间隔离、文件系统隔离和 cgroup 资源隔离）保持隔离。理论上，这应该足够了。在实践中，暴露面很大，并且发生了多起容器逃逸事件。

为了应对这种风险，设计了许多轻量级虚拟机，以添加一个 Hypervisor（机器级虚拟化）作为容器和操作系统内核之间的额外隔离层。大型云提供商已经支持这些技术，Kubernetes CRI 接口提供了一种简洁的方式利用这些更安全的运行时。

例如，FireCracker 通过 firecracker-containerd 与 containerd 集成。Google gVisor 是另一种沙箱技术。它是一个用户空间内核，实现了大部分 Linux 系统调用，并在应用程序和主机操作系统之间提供了一个缓冲区。它也通过 gvisor-containerd-shim 在 containerd 中可用。

### 网络

网络是另一个持续创新的领域。Kubernetes CNI 允许在一个简单的接口后面存在任意数量的创新网络解决方案。一个主要主题是将 eBPF（一个相对较新的 Linux 内核技术）整合到 Kubernetes 中。

eBPF 代表 extended Berkeley Packet Filter。eBPF 的核心是 Linux 内核中的一个迷你虚拟机，当某些事件发生时（例如数据包被发送或接收），它执行附加到内核对象的特殊程序。最初，只支持套接字，这项技术被称为 BPF。后来，其他对象被添加到其中，那时就有了代表扩展（extended）的 e。

eBPF 的成名之处在于其性能，因为它在内核中运行高度优化的编译 BPF 程序，并且不需要通过内核模块扩展内核。

eBPF 有许多应用：

- **动态网络控制**：在动态环境中，基于 iptables 的方法无法很好地扩展，比如 Kubernetes 集群中有一组不断变化的 Pod 和服务。用 BPF 程序替换 iptables 既提高了性能又更易于管理。Cilium 专注于使用 eBPF 进行路由和流量过滤。
- **监控连接**：通过附加 BPF 程序 kprobes 来跟踪套接字级别的事件，可以创建容器之间 TCP 连接的最新映射。WeaveScope 利用此功能，在每个节点上运行一个代理来收集此信息，并将其发送到一个服务器，通过一个流畅的 UI 提供可视化表示。
- **限制系统调用**：Linux 内核提供了超过 300 个系统调用。在安全敏感的容器环境中，限制系统调用是非常可取的。最初的 seccomp 工具相当简陋。在 Linux 3.5 中，seccomp 被扩展以支持 BPF 用于高级自定义过滤器。
- **原始性能**：eBPF 提供了显著的性能优势，像 Calico 这样的项目利用这一点实现了更快、使用更少资源的数据平面。

### 自定义硬件和设备

Kubernetes 在相对较高的层次上管理节点、网络和存储。但是，在细粒度级别集成特定硬件有很多好处。例如，GPU、高性能网卡、FPGA、InfiniBand 适配器以及其他计算、网络和存储资源。

这就是设备插件框架发挥作用的地方，可以在以下位置找到：https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins。自 Kubernetes 1.26 以来，它已达到 GA 状态，并且该领域持续创新。例如，监控设备插件资源自 Kubernetes 1.15 以来也处于测试版。看看哪些设备将被纳入 Kubernetes 将会非常有趣。该框架本身通过使用 gRPC 遵循现代 Kubernetes 可扩展性实践。

### 服务网格

服务网格可以说是过去几年中网络领域最重要的趋势。我们在第 14 章"使用服务网格"中深入介绍了服务网格。其采用令人印象深刻，我预测大多数 Kubernetes 发行版将提供默认的服务网格，并允许轻松与其他服务网格集成。服务网格提供的利益太大了。提供一个包含 Kubernetes 和集成服务网格的默认平台是合理的。

也就是说，Kubernetes 本身不会吸收某个服务网格并通过其 API 暴露它。这与保持 Kubernetes 核心小巧的理念背道而驰。

Google Anthos 是一个很好的例子，其中 Kubernetes + Knative + Istio 被组合在一起，提供了一个统一的平台，提供了一个有主见的最佳实践组合，一个组织需要花费大量时间和资源才能在原生 Kubernetes 之上构建这样的组合。

朝这个方向的另一个推动是 sidecar 容器 KEP；相关信息可以在这里找到：https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/753-sidecar-containers/README.md。

Sidecar 容器模式从一开始就是 Kubernetes 的主要模式。毕竟，Pod 可以包含多个容器。但是，没有主容器或 sidecar 容器的概念。Pod 中的所有容器具有相同的状态。大多数服务网格使用 sidecar 容器来拦截流量并执行其工作。形式化 sidecar 容器将有助于这些努力，并进一步推动服务网格的发展。

目前尚不清楚 Kubernetes 和服务网格在大多数平台上是否会被隐藏在更简单的抽象背后，还是会成为核心焦点。

### 无服务器计算

无服务器计算是另一个长期存在的趋势。我们在第 12 章"Kubernetes 上的无服务器计算"中详细讨论过。Kubernetes 和无服务器可以在多个层面上结合。

Kubernetes 可以利用无服务器云解决方案，如 AWS Fargate 和 AKS Azure Container Instances（ACI），以节省集群管理员管理节点的工作。这种方法还迎合了将轻量级虚拟机透明地与 Kubernetes 集成，因为云平台不会为其容器即服务平台使用裸机 Linux 容器。

另一个方向是反转角色，在引擎盖下由 Kubernetes 驱动，将容器暴露为服务。这正是 Google Cloud Run 所做的。这里界限模糊了，因为 Google 有多个产品来管理容器和/或 Kubernetes，从仅 GKE、到 Anthos GKE（将你自己的集群带到 GKE 环境用于你的私有数据中心）、Anthos（托管 Kubernetes + 服务网格），以及 Anthos Cloud Run。

最后，还有在你的 Kubernetes 集群内部运行的函数即服务和缩容到零项目。Knative 可能成为这里的领导者，因为它已经被许多框架使用，并通过各种 Google 产品广泛部署。

### 边缘 Kubernetes

Kubernetes 是云原生计算的典范，但随着物联网（IoT）革命，在网络边缘执行计算的需求越来越大。将所有数据发送到后端进行处理有几个缺点：

- 延迟
- 需要足够的带宽
- 成本

随着边缘位置通过传感器、视频摄像头等收集大量数据，边缘数据的数量不断增长，在边缘执行越来越复杂的处理变得更有意义。

Kubernetes 源自 Google 的 Borg，而 Borg 绝对不是为在网络边缘运行而设计的。但 Kubernetes 的设计被证明足够灵活以容纳这种场景。我预计我们会看到越来越多的 Kubernetes 部署到网络边缘，这将导致由许多 Kubernetes 集群组成的非常有趣的系统，这些系统需要集中管理。

KubeEdge 是一个开源框架，构建在 Kubernetes 和 Mosquito（MQTT 消息代理的开源实现）之上，为云端和边缘之间的网络、应用程序部署和元数据同步提供基础。

### 原生 CI/CD

对于开发者来说，最重要的问题之一是构建 CI/CD 流水线。有很多选择，从中做出选择可能很困难。CD Foundation 是一个开源基金会，旨在标准化流水线和工作流等概念，并定义行业规范，使不同工具和社区能够更好地互操作。

当前的项目包括：

- Jenkins
- Tekton
- Spinnaker
- Jenkins X
- Screwdriver.cd
- Ortelius
- CDEvents
- Pyrsia
- Shipwright

请注意，只有 Jenkins 和 Tekton 被认为是毕业项目。其余的都是孵化项目（甚至 Spinnaker 也是）。

我最喜欢的原生 CD 项目之一 Argo CD 并不属于 CD Foundation。我实际上在 GitHub 上开了一个 issue，请求将 Argo CD 提交给 CDF，但 Argo 团队认为 CNCF 更适合他们的项目。

另一个值得关注的项目是 CNB（Cloud Native Buildpacks）。该项目获取源代码并创建 OCI（可以理解为 Docker）镜像。它对于 FaaS 框架和原生集群内 CI 很重要。它也是一个 CNCF 沙箱项目。

### Operator

Operator 模式于 2016 年由 CoreOS（被 RedHat 收购，RedHat 又被 IBM 收购）提出，并在社区中取得了巨大成功。Operator 是自定义资源和用于管理应用程序的控制器的组合。在我目前的工作中，我编写 Operator 来管理基础设施的各个方面，这是一种享受。它已经是将非平凡应用程序分发到 Kubernetes 集群的既定方式。请查看 https://operatorhub.io/ 了解大量现有 Operator。我预计这一趋势将持续并加强。

### Kubernetes 与人工智能

AI 是目前最热门的趋势。大型语言模型（LLM）和生成式预训练变换模型（GPT）以其能力让大多数专业人士感到惊讶。OpenAI 发布 ChatGPT 3.5 是一个分水岭。AI 突然在那些被认为是人类智能堡垒的领域表现出色，例如创意写作、绘画、理解、回答细微问题，当然还有编码。我的观点是，先进的人工智能是大数据问题的解决方案。我们学会了收集大量数据，但从数据中分析和提取洞察是一个困难且劳动密集型的过程。AI 似乎是消化所有数据并自动理解、总结和组织成可供人类和其他系统（很可能是基于 AI 的系统）使用的有用形式的正确技术。

让我们看看为什么 Kubernetes 如此适合 AI 工作负载。

#### Kubernetes 与 AI 的协同效应

现代 AI 都是关于深度学习网络和拥有数十亿参数的巨大模型，在大量数据集上训练，通常使用专用硬件。Kubernetes 非常适合此类工作负载，因为它能快速适应工作负载的需求，利用新的和改进的硬件，并提供强大的可观测性。

最好的证据来自实践。Kubernetes 是 OpenAI 流水线的核心，其他公司也在开发和部署大规模 AI 应用程序。请查看这篇文章，了解 OpenAI 如何利用 Kubernetes 突破极限，运行拥有 7,500 个节点的巨大集群：https://openai.com/research/scaling-kubernetes-to-7500-nodes。

让我们考虑在 Kubernetes 上训练 AI 模型。

#### 在 Kubernetes 上训练 AI 模型

训练大型 AI 模型可能很慢且非常昂贵。参与在 Kubernetes 上训练 AI 模型的组织受益于其许多特性：

- **可扩展性**：Kubernetes 为部署和管理 AI 工作负载提供了高度可扩展的基础设施。使用 Kubernetes，可以根据需求快速扩展或缩减资源，使组织能够快速高效地训练 AI 模型。
- **资源利用**：Kubernetes 允许高效的资源利用，使组织能够使用最具成本效益的基础设施训练 AI 模型。使用 Kubernetes，可以自动分配和管理资源，确保工作负载有合适的资源可用。
- **灵活性**：Kubernetes 在用于训练 AI 模型的基础设施方面提供了高度的灵活性。Kubernetes 支持各种硬件，包括 GPU、FPGA 和 TPU，使得可以为工作负载使用最合适的硬件。
- **可移植性**：Kubernetes 为部署和管理 AI 工作负载提供了高度可移植的基础设施。Kubernetes 支持广泛的云提供商和本地基础设施，使得可以在任何环境中训练 AI 模型。
- **生态系统**：Kubernetes 拥有一个由开源工具和框架组成的活跃生态系统，可用于训练 AI 模型。例如，Kubeflow 是一个流行的开源框架，用于在 Kubernetes 上构建和部署机器学习工作流。

#### 在 Kubernetes 上运行基于 AI 的系统

一旦你训练了模型并在模型之上构建了应用程序，就需要部署和运行它。当然，Kubernetes 是部署工作负载的绝佳平台。基于 AI 的工作负载通常被设计为提供可靠且快速的超人类响应。Kubernetes 提供的高可用性以及根据需求快速扩展和缩减的能力满足了这些要求。

此外，如果系统被设计为持续学习（而不是像 GPT 这样的固定预训练系统），那么 Kubernetes 提供了支持安全操作的强大安全性和控制。

让我们看看新兴的 AIOps 领域。

#### Kubernetes 与 AIOps

AIOps 是一种利用人工智能和机器学习来自动化和优化基础设施管理的范式。AIOps 可以帮助组织提高其 IT 基础设施的可靠性、性能和安全性，同时减轻人类工程师的负担。

Kubernetes 是实践 AIOps 的完美目标。它完全可以通过编程方式访问。它通常以深度可观测性部署。这两个条件对于使 AI 能够审查系统状态并在必要时采取行动是必要且充分的。

Kubernetes 的未来似乎光明，但它也有一些挑战。

## Kubernetes 的挑战

Kubernetes 是有关基础设施的所有问题的答案吗？完全不是。让我们看看一些挑战，例如 Kubernetes 的复杂性，以及开发、部署和管理大规模系统的一些替代解决方案。

### Kubernetes 的复杂性

Kubernetes 是一个庞大、强大且可扩展的平台。它大多是没有意见的、非常灵活。它有巨大的表面区域，包含大量资源和 API。此外，Kubernetes 拥有庞大的生态系统。这意味着它是一个极其难以学习和掌握的系统。这对 Kubernetes 的未来意味着什么？一种可能的情况是，大多数开发者不会直接与 Kubernetes 交互。构建在 Kubernetes 之上的简化解决方案将成为大多数开发者的主要访问点。

如果 Kubernetes 被完全抽象化，那么它可能对自身的未来构成威胁，因为 Kubernetes 作为底层实现，可能会被解决方案提供商替换。最终用户可能根本不需要对其代码或配置进行任何更改。

另一种情况是，越来越多的组织负面权衡在 Kubernetes 之上构建的成本，与轻量级容器编排平台（如 Nomad）相比。这可能导致从 Kubernetes 迁移出去。

让我们看看一些可能在不同领域与 Kubernetes 竞争的技术。

### 无服务器函数平台

无服务器函数平台使用更简单（即使功能不那么强大）的范例为组织和开发者提供了与 Kubernetes 类似的好处。你不需要将系统建模为一组长时间运行的应用程序和服务，只需实现一组可以根据需要触发函数即可。你不需要管理集群、节点池和服务器。某些解决方案也提供长时间运行的服务，要么预打包为容器，要么直接从源代码提供。我们在第 12 章"Kubernetes 上的无服务器计算"中全面介绍了这一点。随着无服务器平台变得更好，Kubernetes 变得更复杂，更多的组织可能更倾向于至少开始使用无服务器解决方案，并可能稍后迁移到 Kubernetes。

首先也是最重要的，所有云提供商都提供各种无服务器解决方案。纯云函数模型包括：

- AWS Lambda
- Google Cloud Functions
- Azure Functions

还有一些与大型云提供商无关的、强大且易于使用的解决方案：

- Cloudflare Workers
- Fly.io
- Render
- Vercel

至此，我们完成了对 Kubernetes 挑战的覆盖。让我们总结一下本章。

## 总结

在本章中，我们展望了 Kubernetes 的未来，它看起来很棒！技术基础、社区、广泛的支持和发展势头都令人印象深刻。Kubernetes 仍然年轻，但创新和稳定的步伐非常令人鼓舞。Kubernetes 的模块化和可扩展性使其成为现代云原生应用的通用基础。也就是说，Kubernetes 面临一些挑战，它可能不会在每个场景中都占主导地位。这是一件好事。多样性、竞争以及来自其他解决方案的启发只会让 Kubernetes 变得更好。

至此，你应该对 Kubernetes 的现状以及它从这里走向何方有了清晰的认识。你应该有信心，Kubernetes 不仅会继续存在，而且将在未来许多年内成为领先的容器编排平台，并与你能想象到的任何主要产品和环境集成，从全球规模的公有云平台、私有云、数据中心、边缘位置，一直到你的开发笔记本和 Raspberry Pi。

就是这样！这是本书的结尾。

现在，该由你利用所学知识，用 Kubernetes 构建令人惊叹的东西了！
