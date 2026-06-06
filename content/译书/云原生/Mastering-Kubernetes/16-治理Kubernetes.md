---
title: "治理 Kubernetes"
date: 2026-05-13
tags: [Kubernetes, 治理, 策略]
aliases: [Governing Kubernetes]
---

## 治理 Kubernetes

在上一章中，我们详细讨论了扩展 Kubernetes 的不同方式，包括在准入控制阶段验证和变更请求。

在本章中，我们将了解 Kubernetes 在大型企业组织中日益增长的作用，什么是治理，以及它如何在 Kubernetes 中应用。我们将研究策略引擎，回顾一些流行的策略引擎，然后深入探讨 Kyverno。

这与上一章很好地衔接，因为策略引擎是构建在 Kubernetes 准入控制机制之上的。

越来越多的企业组织将他们越来越多的"鸡蛋"放在 Kubernetes 这个篮子里。这些大型组织有严格的安全、合规和治理需求。Kubernetes 策略引擎就是为了解决这些问题，确保企业组织能够全面拥抱 Kubernetes。

以下是我们将涵盖的主题：

- Kubernetes 在企业中
- 什么是 Kubernetes 治理？
- 策略引擎
- Kyverno 深入探讨

让我们直接开始，了解 Kubernetes 在企业中日益增长的作用和重要性。

### Kubernetes 在企业中

Kubernetes 平台的普及和采纳率是前所未有的。它于 2016 年正式发布，在短短几年内就征服了基础设施世界。参与最新 CNCF 调查的组织中有 96% 正在使用或评估 Kubernetes。Kubernetes 的渗透是多维度的：组织规模、地理位置、生产环境和非生产环境。更令人印象深刻的是，Kubernetes 可以深入底层，成为其他技术和平台构建的基础。

你可以从所有云提供商提供的各种托管 Kubernetes 服务，以及许多供应商提供的托管平台即服务产品中看到这一点。请查看 CNCF 认证的 Kubernetes 软件一致性列表：https://www.cncf.io/certification/software-conformance。

拥有各种认证供应商和增值经销商，以及多家公司组成的生态系统，对企业组织来说极其重要。企业组织需要的不仅仅是闪亮的新技术。风险很高，大型基础设施项目的失败率很高，失败的后果也很严重。综合所有这些因素，结果是企业组织在技术方面非常抵制变革且厌恶风险。许多不同领域的关键软件系统，如交通控制、保险、医疗保健、通信系统和航空公司，仍然运行在 40-50 年前编写的软件上，使用 COBOL 和 Fortran 等语言。

#### 企业软件的要求

让我们看看企业软件的一些要求：

- 处理大量数据
- 与其他系统和应用程序集成
- 提供强大的安全功能
- 可扩展且可用
- 灵活且可定制
- 合规
- 来自可信供应商的支持
- 强大的治理（稍后会详细介绍）

Kubernetes 如何满足这些要求？

#### Kubernetes 与企业软件

Kubernetes 在企业软件领域使用量增长如此之大的原因是它实际上满足了所有要求并且不断改进。

作为容器编排平台的事实标准，它可以作为所有基于容器的部署的基础。其生态系统满足任何集成需求，因为每个供应商都必须能够在 Kubernetes 上运行。Kubernetes 的长期前景极高，因为它是来自许多公司和组织的真正团队努力，并且由一个开放且成功的流程引导，持续交付。Kubernetes 引领着向遵循行业标准的多云和混合云部署的转变。

Kubernetes 的可扩展性和灵活性意味着它可以满足特定企业所需的任何类型的定制。

这确实是一个非凡的项目，建立在扎实的概念架构之上，并且能够在现实世界中持续交付成果。

至此，很明显 Kubernetes 非常适合企业组织，但它如何满足治理的需求呢？

### 什么是 Kubernetes 治理？

治理是企业组织的重要要求之一。简而言之，它意味着控制组织的运作方式。治理的一些要素包括：

- 策略
- 道德
- 流程
- 风险管理
- 行政管理

治理包括指定策略和强制执行策略的机制，以及报告和审计。让我们看看 Kubernetes 中治理的各种领域和实践。

#### 镜像管理

容器运行嵌入在镜像中的软件。管理这些镜像是运营基于 Kubernetes 的系统的关键活动。有几个方面需要考虑：如何构建你的镜像？如何审查第三方镜像？在哪里存储你的镜像？在此做出糟糕的选择可能会影响系统的性能（例如，如果你使用庞大臃肿的基础镜像）和关键的安全性（例如，如果你使用被入侵或有漏洞的基础镜像）。

镜像管理策略可以强制进行镜像扫描，或确保你只能使用来自特定镜像仓库的经过审查的镜像。

#### Pod 安全

Kubernetes 的工作单元是 Pod。你可以为 Pod 及其容器设置许多安全设置。不幸的是，默认安全设置非常宽松。验证和强制实施 Pod 安全策略可以弥补这一点。Kubernetes 对 Pod 安全标准以及几个内置配置文件有强大的支持和指导。正如我们在第 4 章"保护 Kubernetes 安全"中讨论的，每个 Pod 都有一个安全上下文。

更多详情请参阅 https://kubernetes.io/docs/concepts/security/pod-security-standards/。

#### 网络策略

Kubernetes 网络策略控制 Pod 与其他网络实体之间在 OSI 网络模型第 3 层和第 4 层（IP 地址和端口）的流量。网络实体可以是具有特定标签集的 Pod，或具有特定标签集的命名空间中的所有 Pod。最后，网络策略还可以阻止 Pod 访问特定 IP 段的进出流量。

在治理的背景下，网络策略可用于通过控制 Pod 与其他资源之间的网络访问和通信来强制执行安全和合规要求。

例如，网络策略可用于防止 Pod 与某些外部网络通信。网络策略还可用于强制职责分离，防止对集群内敏感资源的未授权访问。

更多详情请参阅 https://kubernetes.io/docs/concepts/services-networking/network-policies/。

#### 配置约束

Kubernetes 非常灵活，为其运行的许多方面提供了大量控制。基于 Kubernetes 的系统中常用的 DevOps 实践允许团队对其工作负载的部署方式、扩展方式以及使用的资源拥有大量控制权。Kubernetes 提供了配额和限制等配置约束。使用更高级的准入控制器，你可以验证和强制执行控制资源创建任何方面的策略，例如自动缩放部署的最大大小、持久卷声明的总量，以及要求内存请求始终等于内存限制（不一定是个好主意）。

#### RBAC 和准入控制

Kubernetes RBAC（基于角色的访问控制）在资源和动词级别运行。每个 Kubernetes 资源都有可以对其执行的操作（动词）。使用 RBAC，你可以定义对资源的一组权限的角色，可以在命名空间级别或集群级别应用。这有点粗粒度，但非常方便，特别是如果你在命名空间级别隔离资源，并且只使用集群级别权限来管理跨整个集群运行的工作负载。

如果你需要依赖于资源特定属性的更细粒度的控制，那么准入控制器可以处理。我们稍后将在本章讨论策略引擎时探讨这个选项。

#### 策略管理

治理是围绕策略构建的。管理所有这些策略、组织它们并确保它们满足组织的治理需求需要大量精力，并且是一项持续的任务。准备好投入资源来演进和维护你的策略。

#### 策略验证与强制执行

一旦一套策略就位，你需要根据这些策略验证对 Kubernetes API 服务器的请求，并拒绝违反这些策略的请求。还有另一种强制执行策略的方法，涉及变更传入请求以使其符合策略。例如，如果策略要求每个 Pod 的内存请求最多为 2 GiB，那么变更策略可以将具有更大内存请求的 Pod 的内存请求削减到 2 GiB。

策略不必是僵化的。可以针对特殊情况做出例外和排除。

#### 报告

当你管理大量策略并审查所有请求时，了解你的策略如何帮助你治理系统、预防问题以及从使用模式中学习非常重要。报告可以通过捕获和整合策略决策的结果来提供洞察。作为人类用户，你可以查看关于策略违规、被拒绝和变更的请求的报告，并检测趋势或异常。在更高层次上，你可以采用自动化分析，包括基于 ML 的模型，从大量详细报告中提取含义。

#### 审计

Kubernetes 审计日志提供了系统中每个事件带时间戳的逐项记录。当你将审计数据与治理报告结合起来时，你可以拼凑出事件的时间线，特别是安全事件，通过结合多个来源的数据来识别罪魁祸首，从策略违规开始，以根本原因结束。

到目前为止，我们已经涵盖了什么是治理以及它如何具体与 Kubernetes 相关的领域。我们强调了策略对于治理系统的重要性。让我们看看策略引擎以及它们如何实现这些概念。

### 策略引擎

Kubernetes 中的策略引擎提供了治理需求的全面覆盖，并补充了内置机制，如网络策略和 RBAC。策略引擎可以验证并确保你的系统利用最佳实践，遵循安全指南，并遵守外部策略。在本节中，我们将研究准入控制作为策略引擎接入系统的主要机制，策略引擎的职责，以及现有策略引擎的回顾。在此之后，我们将深入探讨目前最好的策略引擎之一——Kyverno。

#### 准入控制作为策略引擎的基础

准入控制是到达 Kubernetes API 服务器的请求生命周期的一部分。我们在第 15 章"扩展 Kubernetes"中深入讨论过。回想一下，动态准入控制器是监听准入审查请求并接受、拒绝或变更它们的 webhook 服务器。策略引擎首先是复杂的准入控制器，注册监听与其策略相关的所有请求。

当一个请求进来时，策略引擎将应用所有相关策略来决定请求的命运。例如，如果策略确定 LoadBalancer 类型的 Kubernetes Service 只能在名为 `load_balancer` 的命名空间中创建，那么策略引擎将注册监听所有 Kubernetes Service 创建和更新请求。当 Service 创建或更新请求到达时，策略引擎将检查 Service 的类型及其命名空间。如果 Service 类型是 LoadBalancer 且命名空间不是 `load_balancer`，那么策略引擎将拒绝该请求。

请注意，这是使用 RBAC 做不到的。这是因为 RBAC 无法查看 Service 的类型来确定请求是否有效。

现在我们已经理解了策略引擎如何利用 Kubernetes 的动态准入控制过程，让我们看看策略引擎的职责。

#### 策略引擎的职责

策略引擎是将治理应用于基于 Kubernetes 的系统的主要工具。策略引擎应允许管理员定义超越内置 Kubernetes 策略（如 RBAC 和网络策略）的策略。这通常意味着提出一种策略声明语言。策略声明语言需要足够丰富，以涵盖 Kubernetes 的所有细微差别，包括对不同资源的细粒度应用，以及访问所有相关信息来为每个资源做出接受或拒绝决策。

策略引擎还应提供一种组织、查看和管理策略的方式。理想情况下，策略引擎在将策略应用于生产集群之前提供良好的测试方法。

策略引擎必须提供一种将策略部署到集群的方式，当然，它需要应用与每个请求相关的策略，并决定请求应按原样接受、拒绝还是修改（变更）。策略引擎可能提供在请求进入时生成额外资源的方式。例如，当创建新的 Kubernetes Deployment 时，策略引擎可能会自动为 Deployment 生成一个 HorizontalPodAutoscaler。策略引擎也可能监听集群中发生的事件并采取行动。请注意，这种能力超出了动态准入控制的范围，但它仍然在集群上强制执行策略。

让我们回顾一些 Kubernetes 策略引擎以及它们如何履行这些职责。

#### 开源策略引擎快速回顾

在评估解决方案时，提前提出评估标准非常有帮助，因为策略引擎可能深刻影响 Kubernetes 集群的运行及其工作负载的成熟度是关键因素。优秀的文档也至关重要，因为策略引擎的覆盖范围非常大，你需要了解如何使用它。策略引擎的能力决定了它可以处理哪些用例。编写策略是管理员将其治理意图传达给策略引擎的方式。评估编写和测试策略的用户体验以及有哪些工具支持这些活动很重要。将策略部署到集群是另一个必备要素。最后，查看报告和了解治理状态可能被忽视。

我们将从这些维度回顾五个策略引擎。

##### OPA/Gatekeeper

Open Policy Agent（OPA）是一个通用的策略引擎，超越了 Kubernetes (https://www.openpolicyagent.org)。它的范围非常广泛，在任何 JSON 值上操作。

Gatekeeper (https://open-policy-agent.github.io/gatekeeper) 通过将 OPA 打包为准入控制 webhook 将其引入 Kubernetes。

OPA/Gatekeeper 绝对是最成熟的策略引擎。它创建于 2017 年。它是一个毕业的 CNCF 项目，在撰写本文时在 GitHub 上有 2.9k 星。它甚至被用作 AKS 上 Azure Policy 的基础。请参阅 https://learn.microsoft.com/en-us/azure/governance/policy/concepts/policy-for-kubernetes。

OPA 有自己的特殊语言称为 Rego (https://www.openpolicyagent.org/docs/latest/policy-language/) 用于定义策略。Rego 有强大的理论基础，受 Datalog 启发，但它可能不太直观且难以掌握。

以下图表显示了 OPA/Gatekeeper 的架构：

![图 16.1: OPA/Gatekeeper 架构](images/ch16-fig01.png)

总的来说，OPA/Gatekeeper 非常强大，但与其他 Kubernetes 策略引擎相比似乎有点笨重，因为 OPA 策略引擎是通过 Gatekeeper 附加在 Kubernetes 之上的。

OPA/Gatekeeper 的文档一般，不太容易浏览。不过，它确实有一个策略库可以作为起点。

然而，如果你欣赏其成熟度，并且不太担心使用 Rego 和某些摩擦，它可能对你来说是一个不错的选择。

##### Kyverno

Kyverno (https://kyverno.io) 是一个成熟且健壮的策略引擎，从一开始就专门为 Kubernetes 设计。它创建于 2019 年，此后取得了巨大的进步。它是一个 CNCF 孵化项目，在 GitHub 上的人气已超越 OPA/Gatekeeper，在撰写本文时有 3.3k 星。Kyverno 使用 YAML 和 JMESPath (https://jmespath.org) 来定义策略，这些策略实际上只是 Kubernetes 自定义资源。它有出色的文档和大量示例，可帮助你开始编写自己的策略。

总的来说，Kyverno 既强大又易于使用。它背后有巨大的动力，并且不断变得更好，提高其在大规模下的性能和操作。在我看来，它是目前最好的 Kubernetes 策略引擎。我们将在本章后面深入探讨 Kyverno。

##### jsPolicy

jsPolicy (https://www.jspolicy.com) 是 Loft 的一个有趣项目，Loft 曾将虚拟集群引入 Kubernetes 社区。它的出名之处在于它在安全且高性能的类似浏览器的沙箱中运行策略，并且你可以用 JavaScript 或 TypeScript 定义策略。这种方法令人耳目一新，该项目非常精巧且精简，文档也很好。不幸的是，Loft 似乎专注于其他项目，jsPolicy 没有得到太多关注。在撰写本文时，它在 GitHub 上只有 242 星 (https://github.com/loft-sh/jspolicy)，最后一次提交是 6 个月前。

利用 JavaScript 生态系统来打包和共享策略，以及使用其强大的工具来测试和调试策略的想法，有很多优点。

jsPolicy 提供验证、变更和控制器策略。控制器策略允许你对准入控制范围之外集群中发生的事件做出反应。

以下图表显示了 jsPolicy 的架构：

![图 16.2: jsPolicy 架构](images/ch16-fig02.png)

在这一点上，我不会承诺使用 jsPolicy，因为它可能已被放弃。但是，如果 Loft 或其他人决定投资它，它可能成为 Kubernetes 策略引擎领域的一个竞争者。

##### Kubewarden

Kubewarden (https://www.kubewarden.io) 是另一个创新的策略引擎。它是一个 CNCF 沙箱项目。Kubewarden 专注于与语言无关，允许你用多种语言编写策略。然后策略被打包成 WebAssembly 模块，存储在任意 OCI 仓库中。

理论上，你可以使用任何可以编译成 WebAssembly 的语言。实际上，以下语言是受支持的，但有局限性：

- Rust（当然，最成熟）
- Go（你需要使用一个特殊的编译器 TinyGo，它不支持 Go 的所有特性）
- Rego（直接使用 OPA 或通过 Gatekeeper——缺少变更策略）
- Swift（使用 SwiftWasm，这需要一些构建后优化）
- TypeScript（或者更确切地说，一个称为 AssemblyScript 的子集）

Kubewarden 支持验证、变更和上下文感知策略。上下文感知策略是使用额外信息来形成对请求是否应被准入或被拒绝的判断的策略。额外信息可能包括，例如，集群中存在的命名空间、服务和 Ingress 的列表。

Kubewarden 有一个名为 kwctl 的 CLI (https://github.com/kubewarden/kwctl) 用于管理你的策略。

以下是 Kubewarden 架构的图表：

![图 16.3: Kubewarden 架构](ch16-fig03.png)

Kubewarden 仍在发展和成长。它有一些很好的想法和动机，但在现阶段，如果你在 Rust 阵营并倾向于用 Rust 编写策略，它可能最吸引你。

现在我们已经了解了 Kubernetes 开源策略引擎的格局，让我们深入了解并仔细看看 Kyverno。

### Kyverno 深入探讨

Kyverno 是 Kubernetes 策略引擎领域的一颗新星。让我们亲自动手，看看它是如何工作的以及为什么如此受欢迎。在本节中，我们将介绍 Kyverno，安装它，并学习如何编写、应用和测试策略。

#### Kyverno 快速介绍

Kyverno 是一个专门为 Kubernetes 设计的策略引擎。如果你有一些使用 kubectl、Kubernetes 清单或 YAML 的经验，那么 Kyverno 会让你感到非常熟悉。你使用 YAML 清单和 JMESPath 语言定义策略和配置，这与 kubectl 的 JSONPATH 格式非常接近。

以下图表显示了 Kyverno 架构：

![图 16.4: Kyverno 架构](images/ch16-fig04.png)

Kyverno 涵盖了很多领域，并具有许多特性：

- 策略管理的 GitOps
- 资源验证（拒绝无效资源）
- 资源变更（修改无效资源）
- 资源生成（自动生成额外资源）
- 验证容器镜像（对软件供应链安全很重要）
- 检查镜像元数据
- 使用标签选择器和通配符匹配和排除资源（Kubernetes 原生）
- 使用覆盖层验证和变更资源（类似于 Kustomize！）
- 跨命名空间同步配置
- 以报告或强制执行模式运行
- 使用动态准入 webhook 应用策略
- 在 CI/CD 时使用 Kyverno CLI 应用策略
- 使用 Kyverno CLI 进行临时测试策略和验证资源
- 高可用模式
- 故障开放或故障关闭（当 Kyverno 准入 webhook 宕机时允许或拒绝资源）
- 策略违规报告
- Web UI 便于可视化
- 可观测性支持

这是一个令人印象深刻的功能列表。Kyverno 开发人员不断发展和改进它。Kyverno 在可扩展性、性能以及处理大量策略和资源的能力方面取得了巨大进步。

让我们安装 Kyverno 并配置它。

#### 安装和配置 Kyverno

Kyverno 遵循与 Kubernetes 本身类似的升级策略，节点组件版本必须最多比控制平面版本低两个次要版本。在撰写本文时，Kyverno 1.8 是最新版本，支持 Kubernetes 1.23-1.25 版本。

我们可以使用 kubectl 或 Helm 安装 Kyverno。让我们使用 Helm 选项：

```bash
$ helm repo add kyverno https://kyverno.github.io/kyverno/
"kyverno" has been added to your repositories
$ helm repo update
Hang tight while we grab the latest from your chart repositories...
...Successfully got an update from the "kyverno" chart repository
Update Complete. ⎈Happy Helming!⎈
```

让我们使用默认的单副本安装 Kyverno 到它自己的命名空间。不建议在生产中使用单副本，但对于试验 Kyverno 来说没问题。要以高可用模式安装，请添加 `--set replicaCount=3` 标志：

```bash
$ helm install kyverno kyverno/kyverno -n kyverno --create-namespace
NAME: kyverno
LAST DEPLOYED: Sat Dec 31 15:34:11 2022
NAMESPACE: kyverno
STATUS: deployed
REVISION: 1
NOTES:
Chart version: 2.6.5
Kyverno version: v1.8.5
Thank you for installing kyverno! Your release is named kyverno.

WARNING: Setting replicas count below 3 means Kyverno is not running in high
availability mode.
Note: There is a trade-off when deciding which approach to take regarding
Namespace exclusions. Please see the documentation at https://kyverno.io/docs/
installation/#security-vs-operability to understand the risks.
```

让我们使用 ketall kubectl 插件观察我们刚刚安装的内容 (https://github.com/corneliusweig/ketall)：

```bash
$ k get-all -n kyverno
NAME                                                    NAMESPACE   AGE
configmap/kube-root-ca.crt                              kyverno     2m27s
configmap/kyverno                                       kyverno     2m26s
configmap/kyverno-metrics                                kyverno     2m26s
endpoints/kyverno-svc                                    kyverno     2m26s
endpoints/kyverno-svc-metrics                            kyverno     2m26s
pod/kyverno-7c444878f7-gfht8                            kyverno     2m26s
secret/kyverno-svc.kyverno.svc.kyverno-tls-ca           kyverno     2m22s
secret/kyverno-svc.kyverno.svc.kyverno-tls-pair         kyverno     2m21s
secret/sh.helm.release.v1.kyverno.v1                    kyverno     2m26s
serviceaccount/default                                   kyverno     2m27s
serviceaccount/kyverno                                   kyverno     2m26s
service/kyverno-svc                                      kyverno     2m26s
service/kyverno-svc-metrics                              kyverno     2m26s
deployment.apps/kyverno                                  kyverno     2m26s
replicaset.apps/kyverno-7c444878f7                        kyverno     2m26s
lease.coordination.k8s.io/kyverno                        kyverno     2m23s
lease.coordination.k8s.io/kyverno-health                 kyverno     2m13s
lease.coordination.k8s.io/kyvernopre                     kyverno     2m25s
lease.coordination.k8s.io/kyvernopre-lock                kyverno     2m24s
endpointslice.discovery.k8s.io/kyverno-svc-7ghzl         kyverno     2m26s
endpointslice.discovery.k8s.io/kyverno-svc-metrics-qflr5 kyverno     2m26s
rolebinding.rbac.authorization.k8s.io/kyverno:leaderelection kyverno 2m26s
role.rbac.authorization.k8s.io/kyverno:leaderelection    kyverno     2m26s
```

如你所见，Kyverno 安装了所有预期的资源：deployment、services、角色和角色绑定、config map 和 secret。我们可以看出 Kyverno 还暴露了指标并使用领导者选举。

此外，Kyverno 安装了许多 CRD（在集群范围）：

```bash
$ k get crd
NAME                                          CREATED AT
admissionreports.kyverno.io                   2022-12-31T23:34:12Z
backgroundscanreports.kyverno.io              2022-12-31T23:34:12Z
clusteradmissionreports.kyverno.io            2022-12-31T23:34:12Z
clusterbackgroundscanreports.kyverno.io       2022-12-31T23:34:12Z
clusterpolicies.kyverno.io                    2022-12-31T23:34:12Z
clusterpolicyreports.wgpolicyk8s.io           2022-12-31T23:34:12Z
generaterequests.kyverno.io                   2022-12-31T23:34:12Z
policies.kyverno.io                           2022-12-31T23:34:12Z
policyreports.wgpolicyk8s.io                  2022-12-31T23:34:12Z
updaterequests.kyverno.io                     2022-12-31T23:34:12Z
```

最后，Kyverno 配置了几个准入控制 webhook：

```bash
$ k get validatingwebhookconfigurations
NAME                                          WEBHOOKS   AGE
kyverno-policy-validating-webhook-cfg          1          40m
kyverno-resource-validating-webhook-cfg        1          40m

$ k get mutatingwebhookconfigurations
NAME                                        WEBHOOKS   AGE
kyverno-policy-mutating-webhook-cfg          1          40m
kyverno-resource-mutating-webhook-cfg        0          40m
kyverno-verify-mutating-webhook-cfg          1          40m
```

以下图表显示了典型 Kyverno 安装的结果：

![图 16.5: 典型 Kyverno 安装](images/ch16-fig05.png)

#### 安装 Pod 安全策略

Kyverno 有一个广泛的预构建策略库。我们也可以使用 Helm 安装 Pod 安全标准策略（参见 https://kyverno.io/policies/pod-security/）：

```bash
$ helm install kyverno-policies kyverno/kyverno-policies -n kyverno-policies --create-namespace
NAME: kyverno-policies
LAST DEPLOYED: Sat Dec 31 15:48:26 2022
NAMESPACE: kyverno-policies
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
Thank you for installing kyverno-policies 2.6.5
We have installed the "baseline" profile of Pod Security Standards and set them in
audit mode.
Visit https://kyverno.io/policies/ to find more sample policies.
```

请注意，策略本身是集群策略，在 kyverno-policies 命名空间中不可见：

```bash
$ k get clusterpolicies.kyverno.io
NAME                            BACKGROUND   VALIDATE ACTION   READY
disallow-capabilities           true         audit             true
disallow-host-namespaces        true         audit             true
disallow-host-path              true         audit             true
disallow-host-ports             true         audit             true
disallow-host-process           true         audit             true
disallow-privileged-containers  true         audit             true
disallow-proc-mount             true         audit             true
disallow-selinux                true         audit             true
restrict-apparmor-profiles      true         audit             true
restrict-seccomp                true         audit             true
restrict-sysctls                true         audit             true
```

我们稍后将深入审查其中一些策略。首先，让我们看看如何配置 Kyverno。

#### 配置 Kyverno

你可以通过编辑 Kyverno ConfigMap 来配置 Kyverno 的行为：

```bash
$ k get cm kyverno -o yaml -n kyverno | yq .data
resourceFilters: '[*,kyverno,*][Event,*,*][*,kube-system,*][*,kube-public,*][*,kube-node-lease,*][Node,*,*][APIService,*,*][TokenReview,*,*][SubjectAccessReview,*,*][SelfSubjectAccessReview,*,*][Binding,*,*][ReplicaSet,*,*][AdmissionReport,*,*][ClusterAdmissionReport,*,*][BackgroundScanReport,*,*][ClusterBackgroundScanReport,*,*][ClusterRole,*,kyverno:*][ClusterRoleBinding,*,kyverno:*][ServiceAccount,kyverno,kyverno][ConfigMap,kyverno,kyverno][ConfigMap,kyverno,kyverno-metrics][Deployment,kyverno,kyverno][Job,kyverno,kyverno-hook-pre-delete][NetworkPolicy,kyverno,kyverno][PodDisruptionBudget,kyverno,kyverno][Role,kyverno,kyverno:*][RoleBinding,kyverno,kyverno:*][Secret,kyverno,kyverno-svc.kyverno.svc.*][Service,kyverno,kyverno-svc][Service,kyverno,kyverno-svc-metrics][ServiceMonitor,kyverno,kyverno-svc-service-monitor][Pod,kyverno,kyverno-test]'
webhooks: '[{"namespaceSelector": {"matchExpressions": [{"key":"kubernetes.io/metadata.name","operator":"NotIn","values":["kyverno"]}]}}]'
```

`resourceFilters` 标志是一个格式为 `[kind,namespace,name]` 的列表，其中每个元素也可以是通配符，告诉 Kyverno 要忽略哪些资源。匹配任何过滤器的资源将不受任何 Kyverno 策略的约束。如果你有很多策略，这是很好的实践，可以节省对所有策略的评估工作。

`webhooks` 标志允许你过滤掉整个命名空间。

`excludeGroupRole` 标志是一个逗号分隔的角色字符串。它将排除用户的 Kyverno 准入控制，其中用户具有指定角色之一。默认列表是 `system:serviceaccounts:kube-system,system:nodes,system:kube-scheduler`。

`excludeUsername` 标志表示由逗号分隔的 Kubernetes 用户名组成的字符串。当用户在生成策略中启用同步时，Kyverno 成为唯一能够更新或删除生成资源的实体。但是，管理员能够排除特定的用户名访问删除/更新生成的资源功能。

`generateSuccessEvents` 标志是一个布尔参数，用于确定是否应生成成功事件。默认情况下，此标志设置为 false，表示不生成成功事件。

此外，Kyverno 容器提供了几个可以配置的容器参数，以定制其行为和功能。这些参数允许对容器内 Kyverno 的行为进行微调和定制。你可以编辑 Kyverno deployment 中的 args 列表：

```bash
$ k get deploy kyverno -n kyverno -o yaml | yq '.spec.template.spec.containers[0].args'
- --autogenInternals=true
- --loggingFormat=text
```

除了预配置的 `--autogenInternals` 和 `--loggingFormat`，还有以下标志可用：

- admissionReports
- allowInsecureRegistry
- autoUpdateWebhooks
- backgroundScan
- clientRateLimitBurst
- clientRateLimitQPS
- disableMetrics
- enableTracing
- genWorkers
- imagePullSecrets
- imageSignatureRepository
- kubeconfig
- maxQueuedEvents
- metricsPort
- otelCollector
- otelConfig
- profile
- profilePort
- protectManagedResources
- reportsChunkSize
- serverIP
- splitPolicyReport（已弃用——将在 1.9 中移除）
- transportCreds
- webhookRegistrationTimeout
- webhookTimeout

所有标志都有默认值，只有在想要覆盖默认值时才需要指定它们。

关于每个标志的详细信息，请查看 https://kyverno.io/docs/installation/#container-flags。

我们安装了 Kyverno，观察了它安装的各种资源，并查看了它的配置。是时候了解 Kyverno 的策略和规则了。

### 应用 Kyverno 策略

在用户层面，Kyverno 的工作单元是策略。你可以将策略作为 Kubernetes 资源应用，编写和编辑你自己的策略，并使用 Kyverno CLI 测试策略。

应用 Kyverno 策略就像应用任何其他资源一样简单。让我们看看我们之前安装的一个策略：

```bash
$ k get clusterpolicies.kyverno.io disallow-capabilities
NAME                    BACKGROUND   VALIDATE ACTION   READY
disallow-capabilities   true         audit             true
```

该策略的目的是防止 Pod 请求允许列表之外的额外 Linux 能力（参见 https://linux-audit.com/linux-capabilities-101/）。不允许的能力之一是 NET_ADMIN。让我们创建一个请求此能力的 Pod：

```bash
$ cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    command: [ "sleep", "999999" ]
    image: g1g1/py-kube:0.3
    securityContext:
      capabilities:
        add: ["NET_ADMIN"]
EOF
pod/some-pod created
```

Pod 被创建了，我们可以验证它具有 NET_ADMIN 能力。我使用 kind 集群，所以集群节点只是一个我们可以 exec 进入的 Docker 进程：

```bash
$ docker exec -it kind-control-plane sh
#
```

现在我们进入了节点内的 shell，我们可以搜索我们容器的进程，它只是休眠 999999 秒：

```bash
# ps aux | grep 'PID\|sleep' | grep -v grep
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root        4549 0.0  0.0 148276  6408 ?        Ssl  02:54   0:00 /usr/bin/qemu-x86_64 /bin/sleep 999999
```

让我们检查我们进程 4549 的能力：

```bash
# getpcaps 4549
4549: cap_chown,cap_dac_override,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_net_bind_service,cap_net_admin,cap_net_raw,cap_sys_chroot,cap_mknod,cap_audit_write,cap_setfcap=ep
```

如你所见，`cap_net_admin` 存在。

Kyverno 没有阻止 Pod 被创建，因为该策略只在审计模式下运行：

```bash
$ k get clusterpolicies.kyverno.io disallow-capabilities -o yaml | yq .spec.validationFailureAction
audit
```

让我们删除 Pod 并将策略更改为"enforce"模式：

```bash
$ k delete po some-pod
pod "some-pod" deleted
$ k patch clusterpolicies.kyverno.io disallow-capabilities --type merge -p '{"spec": {"validationFailureAction": "enforce"}}'
clusterpolicy.kyverno.io/disallow-capabilities patched
```

现在，如果我们再次尝试创建 Pod，结果将完全不同：

```bash
$ cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    command: [ "sleep", "999999" ]
    image: g1g1/py-kube:0.3
    securityContext:
      capabilities:
        add: ["NET_ADMIN"]
EOF
Error from server: error when creating "STDIN": admission webhook "validate.kyverno.svc-fail" denied the request:
policy Pod/kyverno-policies/some-pod for resource violation:
disallow-capabilities:
  adding-capabilities: Any capabilities added beyond the allowed list (AUDIT_WRITE, CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, MKNOD, NET_BIND_SERVICE, SETFCAP, SETGID, SETPCAP, SETUID, SYS_CHROOT) are disallowed.
```

Kyverno 准入 webhook 强制执行了策略并拒绝了 Pod 创建。它甚至告诉我们哪个策略负责（disallow-capabilities），并显示了一条很好的消息解释了拒绝的原因，包括允许的能力列表。

应用策略非常简单。编写策略要复杂得多，需要理解资源请求、Kyverno 匹配规则和 JMESPath 语言。在我们编写策略之前，我们需要了解它们的结构以及它们的不同元素。

### Kyverno 策略深入分析

在本节中，我们将学习 Kyverno 策略的所有细节。Kyverno 策略有一组规则定义策略实际做什么，以及几个一般设置定义策略在不同场景下的行为。让我们从策略设置开始，然后转向规则和不同用例，例如验证、变更和生成资源。

#### 理解策略设置

Kyverno 策略可能有以下设置：

- applyRules
- validationFailureAction
- validationFailureActionOverrides
- background
- schemaValidation
- failurePolicy
- webhookTimeoutSeconds

`applyRules` 设置确定是只有一条规则还是多条规则应用于匹配的资源。有效值是 "One" 和 "All"（默认值）。如果 `applyRules` 设置为 "One"，则评估第一个匹配的规则，其他规则将被忽略。

`validationFailureAction` 设置确定失败的验证策略规则是应拒绝准入请求还是仅报告它。有效值是 "audit"（默认——始终允许并仅报告违规）和 "enforce"（阻止无效请求）。

`validationFailureActionOverrides` 设置是一个 ClusterPolicy 属性，覆盖特定命名空间的 `validationFailureAction`。

`background` 设置确定是否在后台扫描期间将策略应用于现有资源。默认值为 "true"。

`schemaValidation` 设置确定是否应用策略验证检查。默认值为 "true"。

`failurePolicy` 设置确定如果 webhook 未能响应，API 服务器如何行为。有效值是 "Ignore" 和 "Fail"（默认值）。如果设置为 "Fail"，则即使有效的资源请求也会被拒绝，而 webhook 不可达。

`webhookTimeoutSeconds` 确定允许 webhook 评估策略的最大秒数。有效值介于 1 到 30 秒之间。默认值为 10 秒。如果 webhook 未能及时响应，`failurePolicy`（见上文）决定请求的命运。

#### 理解 Kyverno 策略规则

每个 Kyverno 策略有一个或多个规则。每个规则有一个 match 声明、一个可选的 exclude 声明、一个可选的 preconditions 声明，以及以下声明中的恰好一个：

- validate
- mutate
- generate
- verifyImages

下面的图表展示了 Kyverno 策略及其规则的结构（省略了策略设置）：

![图 16.6: Kyverno 规则结构](images/ch16-fig06.png)

让我们逐一介绍不同的声明，并探讨一些高级主题。

#### 匹配请求

当资源请求到达时，Kyverno webhook 需要为每个策略确定请求的资源和/或操作是否与当前策略相关。强制性的 `match` 声明有几个过滤器，确定策略是否应评估当前请求。过滤器有：

- resources
- subjects
- roles
- clusterRoles

一个 match 声明可以有多个过滤器，分组在 `any` 语句或 `all` 语句下。当过滤器分组在 `any` 下时，Kyverno 将应用 OR 语义来匹配它们，如果任何过滤器匹配请求，则请求被视为匹配。当过滤器分组在 `all` 下时，Kyverno 将应用 AND 语义，所有过滤器必须匹配才能将请求视为匹配。

这可能有点难以理解。让我们看一个例子。以下策略规范有一个名为 `some-rule` 的单一规则。该规则有一个 match 声明，在 `any` 语句下有两个资源过滤器。第一个资源过滤器匹配 kind 为 Service、名称为 service-1 或 service-2 的资源。第二个资源过滤器匹配命名空间 ns-1 中 kind 为 Service 的资源。此规则将匹配任何命名空间中名为 service-1 或 service-2 的 Kubernetes Service，以及命名空间 ns-1 中的任何 Service。

```yaml
spec:
  rules:
  - name: some-rule
    match:
      any:
      - resources:
          kinds:
          - Service
          names:
          - "service-1"
          - "service-2"
      - resources:
          kinds:
          - Service
          namespaces:
          - "ns-1"
```

让我们看另一个例子。这次我们添加了一个集群角色过滤器。以下规则将匹配 kind 为名为 service-1 的 Service 且请求用户具有名为 `some-cluster-role` 的集群角色的请求。

```yaml
rules:
- name: some-rule
  match:
    all:
    - resources:
        kinds:
        - Service
        names:
        - "service-1"
      clusterRoles:
      - some-cluster-role
```

准入审查资源包含绑定到请求用户或 ServiceAccount 的所有角色和集群角色。

#### 排除资源

排除资源与匹配非常相似。非常常见的是设置策略，拒绝所有创建或更新某些资源的请求，除非是在某些命名空间中或由具有某些角色的用户发起。以下是匹配所有 Service 但排除 ns-1 命名空间的示例：

```yaml
rules:
- name: some-rule
  match:
    any:
    - resources:
        kinds:
        - Service
  exclude:
    any:
    - resources:
        namespaces:
        - "ns-1"
```

另一种常见的排除是针对特定角色，如 `cluster-admin`。

#### 使用前置条件

使用 `match` 和 `exclude` 限制策略的范围很好，但在许多情况下还不够。有时，你需要基于细粒度的细节（如内存请求）来选择资源。以下示例匹配所有请求内存小于 1 GiB 的 Pod。

键值的语法在内置的请求对象上使用 JMESPath (https://jmespath.org)：

```yaml
rules:
- name: memory-limit
  match:
    any:
    - resources:
        kinds:
        - Pod
  preconditions:
    any:
    - key: "{{request.object.spec.containers[*].resources.requests.memory}}"
      operator: LessThan
      value: 1Gi
```

#### 验证请求

Kyverno 的主要用例是验证请求。验证规则有一个 `validate` 语句。`validate` 语句有一个 `message` 字段，如果请求验证失败将显示该消息。验证规则有两种形式，基于模式的验证和基于拒绝的验证。让我们分别检查它们。

你可能还记得，资源验证失败的结果取决于 `validationFailureAction` 字段，可以是 audit 或 enforce。

##### 基于模式的验证

具有基于模式验证的规则在 `validate` 语句下有一个 `pattern` 字段。如果资源不匹配模式，则规则失败。以下是基于模式验证的示例，其中资源必须有一个名为 `app` 的标签：

```yaml
validate:
  message: "The resource must have a label named `app`."
  pattern:
    metadata:
      labels:
        some-label: "app"
```

验证部分将仅应用于符合 match 和 preconditions 语句的请求，并且不被 exclude 语句排除的请求（如果有的话）。

你还可以对模式中的值应用运算符。例如，以下是要求 Deployment 的副本数至少为 3 的验证规则：

```yaml
rules:
- name: validate-replica-count
  match:
    any:
    - resources:
        kinds:
        - Deployment
  validate:
    message: "Replica count for a Deployment must be at least 3."
    pattern:
      spec:
        replicas: ">=3"
```

##### 基于拒绝的验证

具有基于拒绝验证的规则在 `validate` 语句下有一个 `deny` 字段。拒绝规则类似于我们之前看到的用于选择资源的前置条件。每个拒绝条件有一个 key、一个 operator 和一个 value。拒绝条件的一个常见用途是不允许特定操作，如 DELETE。以下示例使用基于拒绝的验证来阻止删除 Deployment 和 StatefulSet。注意请求变量在 message 和 key 中的使用。对于 DELETE 操作，被删除的对象被定义为 `request.oldObject` 而不是 `request.object`：

```yaml
rules:
- name: block-deletes-of-deployments-and-statefulsets
  match:
    any:
    - resources:
        kinds:
        - Deployment
        - Statefulset
  validate:
    message: "Deleting {{request.oldObject.kind}}/{{request.oldObject.metadata.name}} is not allowed"
    deny:
      conditions:
        any:
        - key: "{{request.operation}}"
          operator: Equals
          value: DELETE
```

验证还有更多内容，你可以在这里探索：https://kyverno.io/docs/writing-policies/validate/

现在让我们把注意力转向变更。

#### 变更资源

变更可能听起来很吓人，但它只是在某种程度上修改请求中的资源。请注意，即使变更后的请求匹配任何策略，它仍将通过验证。不可能更改请求对象的 kind，但可以更改其属性。变更的好处在于你可以自动修复无效请求，这通常比阻止无效请求更好的用户体验。缺点（特别是如果无效资源是作为 CI/CD 管道的一部分创建的）是在源代码和集群中的实际资源之间产生了不一致。但是，对于你想控制用户不需要知道的某些方面的情况，以及在迁移期间，它非常有用。

理论够多了——让我们看看 Kyverno 中的变更是什么样的。你仍然需要选择要变更的资源，这意味着 match、exclude 和 precondition 语句对于变更策略仍然是必需的。

但是，你将有一个 `mutate` 语句而不是 `validate` 语句。以下是一个使用 `patchStrategicMerge` 风格为使用 latest 标签的镜像设置 `imagePullPolicy` 的示例。语法类似于 Kustomize 覆盖层，并与现有资源合并。image 字段被放在括号中的原因是由于 JMESPath 的一个称为锚点 (https://kyverno.io/docs/writing-policies/validate/#anchors) 的特性，其中仅在给定字段匹配时才应用子树的其余部分。在这种情况下，意味着 `imagePullPolicy` 将仅为满足条件的镜像设置：

```yaml
mutate:
  patchStrategicMerge:
    spec:
      containers:
        # match images which end with :latest
        - (image): "*:latest"
          # set the imagePullPolicy to "IfNotPresent"
          imagePullPolicy: "IfNotPresent"
```

变更的另一种形式是 JSON Patch (http://jsonpatch.com)，在 RFC 6902 (https://datatracker.ietf.org/doc/html/rfc6902) 中指定。JSON Patch 具有与前缀条件和拒绝规则类似的语义。patch 有一个 operation、path 和 value。它将操作应用于包含值的路径。操作可以是以下之一：

- add
- remove
- replace
- copy
- move
- test

以下是使用 JSON Patch 向 ConfigMap 添加一些数据的示例。它向 `/data/properties` 路径添加多个字段，并向 `/data/key` 路径添加一个值：

```yaml
spec:
  rules:
  - name: patch-config-map
    match:
      any:
      - resources:
          names:
          - the-config-map
          kinds:
          - ConfigMap
    mutate:
      patchesJson6902: |-
        - path: "/data/properties"
          op: add
          value: |
            prop-1=value-1
            prop-2=value-2
        - path: "/data/key"
          op: add
          value: some-string
```

#### 生成资源

生成资源是一个有趣的用例。每当请求进来时，Kyverno 可以创建新资源，而不是变更或验证请求（其他策略可以验证或变更原始请求）。

具有生成规则的策略与其它策略具有相同的 match 和/或 exclude 语句。这意味着它可以通过任何资源请求以及现有资源触发。但是，它不是验证或变更，而是在原始资源创建时生成一个新资源。生成规则有一个重要的属性叫做 `synchronize`。当 `synchronize` 为 true 时，生成的资源始终与原始资源保持同步（当原始资源被删除时，生成的资源也被删除）。用户不能修改或删除生成的资源。当 `synchronize` 为 false 时，Kyverno 不跟踪生成的资源，用户可以随意修改或删除它。

以下是一个生成规则，它在创建新命名空间时创建一个阻止所有流量的 NetworkPolicy。注意 `data` 字段，它定义了生成的资源：

```yaml
spec:
  rules:
  - name: deny-all-traffic
    match:
      any:
      - resources:
          kinds:
          - Namespace
    generate:
      kind: NetworkPolicy
      apiVersion: networking.k8s.io/v1
      name: deny-all-traffic
      namespace: "{{request.object.metadata.name}}"
      data:
        spec:
          # select all pods in the namespace
          podSelector: {}
          policyTypes:
          - Ingress
          - Egress
```

当为现有的原始资源生成资源时，使用 `clone` 字段而不是 `data` 字段。例如，如果我们在 default 命名空间中有一个名为 `config-template` 的 ConfigMap，以下生成规则将把该 ConfigMap 克隆到每个新命名空间中：

```yaml
spec:
  rules:
  - name: clone-config-map
    match:
      any:
      - resources:
          kinds:
          - Namespace
    generate:
      kind: ConfigMap
      apiVersion: v1
      # Name of the generated resource
      name: default-config
      namespace: "{{request.object.metadata.name}}"
      synchronize: true
      clone:
        namespace: default
        name: config-template
```

也可以通过使用 `cloneList` 字段（而不是 `clone` 字段）来克隆多个资源。

#### 高级策略规则

Kyverno 还有一些额外的高级功能，例如外部数据源和用于 Pod 控制器的 autogen 规则。

##### 外部数据源

到目前为止，我们已经看到 Kyverno 如何使用来自准入审查对象的信息来执行验证、变更和生成。但是，有时需要额外的数据。这是通过定义一个带有变量的 `context` 字段来实现的，这些变量可以从外部 ConfigMap、Kubernetes API 服务器或镜像仓库填充。

以下是定义一个名为 `dictionary` 的变量并使用它来变更 Pod 并添加一个名为 `environment` 的标签的示例，其中值来自 ConfigMap 变量：

```yaml
rules:
- name: configmap-lookup
  context:
  - name: dictionary
    configMap:
      name: some-config-map
      namespace: some-namespace
  match:
    any:
    - resources:
        kinds:
        - Pod
  mutate:
    patchStrategicMerge:
      metadata:
        labels:
          environment: "{{dictionary.data.env}}"
```

它的工作方式是名为 "dictionary" 的 context 指向一个 ConfigMap。在 ConfigMap 内部有一个名为 "data" 的部分，其中包含一个键为 "env" 的条目。

##### 用于 Pod 控制器的 Autogen 规则

Pod 是最常应用策略的资源之一。但是，Pod 可以通过多种类型的资源间接创建：Pod（直接）、Deployment、StatefulSet、DaemonSet 和 Job。如果我们想验证每个 Pod 都有一个名为 "app" 的标签，我们将被迫编写复杂的 match 规则，使用 `any` 语句涵盖所有创建 Pod 的各种资源。Kyverno 以为 Pod 控制器提供的 autogen 规则的形式提供了一个非常优雅的解决方案。

自动生成的规则可以在策略对象的 status 中观察到。我们将在下一节中看到一个示例。

我们详细介绍了 Kyverno 带来的许多强大功能。让我们编写一些策略并观察它们的实际运行。

### 编写和测试 Kyverno 策略

在本节中，我们将实际编写一些 Kyverno 策略并观察它们的运行。我们将使用我们在上一节中探讨的一些规则，将它们嵌入到完整的策略中，应用策略，创建符合策略的资源以及违反策略的资源（对于验证策略），并查看结果。

#### 编写验证策略

让我们从一个验证策略开始，该策略不允许命名空间 ns-1 中的 Service，以及任何命名空间中名为 service-1 或 service-2 的 Service：

```bash
$ cat <<EOF | k apply -f -
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-some-services
spec:
  validationFailureAction: Enforce
  rules:
  - name: some-rule
    match:
      any:
      - resources:
          kinds:
          - Service
          names:
          - "service-1"
          - "service-2"
      - resources:
          kinds:
          - Service
          namespaces:
          - "ns-1"
    validate:
      message: >-
        services named service-1 and service-2 and
        any service in namespace ns-1 are not allowed
      deny: {}
EOF
clusterpolicy.kyverno.io/disallow-some-services created
```

现在策略已经就位，让我们尝试在 default 命名空间中创建一个名为 "service-1" 的 Service，这将违反策略。注意，实际上并不需要创建资源来检查准入控制的结果。只要 dry-run 在服务器端进行，就足以在 dry-run 模式下运行：

```bash
$ k create service clusterip service-1 -n default --tcp=80 --dry-run=server
error: failed to create ClusterIP service: admission webhook "validate.kyverno.svc-fail" denied the request:
policy Service/default/service-1 for resource violation:
  disallow-some-services:
    some-rule: services named service-1 and service-2 and any service in namespace ns-1 are not allowed
```

如你所见，请求被拒绝，并附带了来自策略的友好消息说明原因。

如果我们尝试在客户端进行 dry-run，它会成功（但不会实际创建任何 Service），因为准入控制检查仅在服务器端发生：

```bash
$ k create service clusterip service-1 -n default --tcp=80 --dry-run=client
service/service-1 created (dry run)
```

现在我们已经证明了这一点，我们将只使用服务器端 dry-run。

让我们尝试在 default 命名空间中创建一个名为 service-3 的 Service，这应该被允许：

```bash
$ k create service clusterip service-3 -n default --tcp=80 --dry-run=server
service/service-3 created (server dry run)
```

让我们尝试在被禁止的 ns-1 命名空间中创建 service-3：

```bash
$ k create ns ns-1
$ k create service clusterip service-3 -n ns-1 --tcp=80 --dry-run=server
error: failed to create ClusterIP service: admission webhook "validate.kyverno.svc-fail" denied the request:
policy Service/ns-1/service-3 for resource violation:
  disallow-some-services:
    some-rule: services named service-1 and service-2 and any service in namespace ns-1 are not allowed
```

是的。按预期失败了。让我们看看如果我们将 `validationFailureAction` 从 Enforce 改为 Audit 会发生什么：

```bash
$ k patch clusterpolicies.kyverno.io disallow-some-services --type merge -p '{"spec": {"validationFailureAction": "Audit"}}'
clusterpolicy.kyverno.io/disallow-some-services patched
$ k create service clusterip service-3 -n ns-1 --tcp=80 --dry-run=server
service/service-3 created (server dry run)
```

但是，它生成了一个验证失败的报告：

```bash
$ k get policyreports.wgpolicyk8s.io -n ns-1
NAME                            PASS   FAIL   WARN   ERROR   SKIP   AGE
cpol-disallow-some-services     0      1      0      0       0      2m4s
```

现在，Service 通过了准入控制，但违规记录被捕获在策略报告中。我们将在本章后面更详细地查看报告。

现在，让我们看看变更策略。

#### 编写变更策略

变更策略非常有趣。它们悄悄地修改传入的请求以符合策略。它们不像验证策略在 "enforce" 模式下那样导致失败，也不像验证策略在 "audit" 模式下那样生成你需要仔细检查的报告。如果无效或不完整的请求进来，你只需更改它直到它有效。

以下是一个策略，当标签是 latest 时将 `imagePullPolicy` 设置为 IfNotPresent（默认情况下是 Always）。

```bash
$ cat <<EOF | k apply -f -
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: set-image-pull-policy
spec:
  rules:
  - name: set-image-pull-policy
    match:
      any:
      - resources:
          kinds:
          - Pod
    mutate:
      patchStrategicMerge:
        spec:
          containers:
          # match images which end with :latest
          - (image): "*:latest"
            # set the imagePullPolicy to "IfNotPresent"
            imagePullPolicy: "IfNotPresent"
EOF
clusterpolicy.kyverno.io/set-image-pull-policy created
```

让我们看看它的实际效果。注意，对于变更策略，我们不能使用 dry-run，因为重点实际上是变更资源。

以下 Pod 匹配我们的策略，并且没有设置 `imagePullPolicy`：

```bash
$ cat <<EOF | k apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    image: g1g1/py-kube:latest
    command:
    - sleep
    - "9999"
EOF
pod/some-pod created
```

让我们验证变更是否生效，并检查容器的 `imagePullPolicy`：

```bash
$ k get po some-pod -o yaml | yq '.spec.containers[0].imagePullPolicy'
IfNotPresent
```

是的。它被正确设置了。让我们通过删除策略然后创建另一个 Pod 来确认是 Kyverno 负责设置 `imagePullPolicy`：

```bash
$ k delete clusterpolicy set-image-pull-policy
clusterpolicy.kyverno.io "set-image-pull-policy" deleted
$ cat <<EOF | k apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: another-pod
spec:
  containers:
  - name: some-container
    image: g1g1/py-kube:latest
    command:
    - sleep
    - "9999"
EOF
pod/another-pod created
```

Kyverno 策略已被删除，另一个名为 another-pod 的 Pod 使用相同的镜像 g1g1/py-kube:latest 被创建。让我们看看它的 `imagePullPolicy` 是否是预期的 Always（带有 latest 镜像标签的镜像的默认值）：

```bash
$ k get po another-pod -o yaml | yq '.spec.containers[0].imagePullPolicy'
Always
```

是的，它按预期工作！让我们继续另一种令人兴奋的 Kyverno 策略——生成策略，它可以凭空创建新资源。

#### 编写生成策略

生成策略在创建新资源时，除了请求的资源之外还会创建新资源。让我们采用之前的示例，为新命名空间创建一个自动的网络策略，阻止任何网络流量的进出。这是一个适用于任何新命名空间（排除的命名空间除外）的集群策略：

```bash
cat <<EOF | k apply -f -
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: deny-all-traffic
spec:
  rules:
  - name: deny-all-traffic
    match:
      any:
      - resources:
          kinds:
          - Namespace
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - default
          - kube-public
          - kyverno
    generate:
      kind: NetworkPolicy
      apiVersion: networking.k8s.io/v1
      name: deny-all-traffic
      namespace: "{{request.object.metadata.name}}"
      data:
        spec:
          # select all pods in the namespace
          podSelector: {}
          policyTypes:
          - Ingress
          - Egress
EOF
clusterpolicy.kyverno.io/deny-all-traffic created
```

deny-all-traffic Kyverno 策略创建成功。让我们创建一个新命名空间 ns-2，看看是否生成了预期的 NetworkPolicy：

```bash
$ k create ns ns-2
namespace/ns-2 created
$ k get networkpolicy -n ns-2
NAME               POD-SELECTOR   AGE
deny-all-traffic   <none>         15s
```

是的，它生效了！Kyverno 让你轻松生成额外的资源。

现在我们已经有一些创建 Kyverno 策略的实践经验，让我们了解如何测试它们以及为什么要测试。

#### 测试策略

在将 Kyverno 策略部署到生产环境之前进行测试非常重要，因为 Kyverno 策略非常强大，如果配置不当，它们可能轻易导致宕机和事故，例如阻止有效请求、允许无效请求、不正确地变更资源以及在错误的命名空间中生成资源。

Kyverno 提供了测试其策略的工具和指南。

##### Kyverno CLI

Kyverno CLI 是一个多功能的命令行程序，允许你在客户端应用策略并查看结果、运行测试以及评估 JMESPath 表达式。

按照以下说明安装 Kyverno CLI：https://kyverno.io/docs/kyverno-cli/#building-and-installing-the-cli。

通过检查版本验证它是否正确安装：

```bash
$ kyverno version
Version: 1.8.5
Time: 2022-12-20T08:41:43Z
Git commit ID: c19061758dc4203106ab6d87a245045c20192721
```

如果你只输入 `kyverno` 不带任何附加命令，以下是帮助屏幕：

```bash
$ kyverno
Kubernetes Native Policy Management

Usage:
  kyverno [command]

Available Commands:
  apply         applies policies on resources
  completion    Generate the autocompletion script for the specified shell
  help          Help about any command
  jp            Provides a command-line interface to JMESPath, enhanced with Kyverno specific custom functions
  test          run tests from directory
  version       Shows current version of kyverno

Flags:
      --add_dir_header          If true, adds the file directory to the header of the log messages
  -h, --help                    help for kyverno
      --log_file string         If non-empty, use this log file (no effect when -logtostderr=true)
      --log_file_max_size uint  Defines the maximum size a log file can grow to (no effect when -logtostderr=true). Unit is megabytes. If the value is 0, the maximum file size is unlimited. (default 1800)
      --one_output              If true, only write logs to their native severity level (vs also writing to each lower severity level; no effect when -logtostderr=true)
      --skip_headers            If true, avoid header prefixes in the log messages
      --skip_log_headers        If true, avoid headers when opening log files (no effect when -logtostderr=true)
  -v, --v Level                 number for the log level verbosity

Use "kyverno [command] --help" for more information about a command.
```

在本章前面，我们看到了如何使用 dry-run 评估验证性 Kyverno 策略的结果，而无需实际创建资源。这对于变更或生成策略是不可能的。使用 `kyverno apply`，我们可以对所有策略类型实现相同的效果。

让我们看看如何将变更策略应用于资源并检查结果。我们将把 set-image-pull-policy 应用于存储在 `some-pod.yaml` 文件中的 Pod。该策略在前面已经定义过，在附带的代码中作为文件 `mutate-image-pull-policy.yaml` 提供。

首先，让我们看看如果我们只是创建 Pod 而不应用 Kyverno 策略，结果会怎样：

```bash
$ k apply -f some-pod.yaml -o yaml --dry-run=server | yq '.spec.containers[0].imagePullPolicy'
Always
```

结果是 Always。现在，我们将 Kyverno 策略应用于此 Pod 资源并检查结果：

```bash
$ kyverno apply mutate-image-pull-policy.yaml --resource some-pod.yaml
Applying 1 policy rule to 1 resource...
mutate policy set-image-pull-policy applied to default/Pod/some-pod:
  apiVersion: v1
  kind: Pod
  metadata:
    name: some-pod
    namespace: default
  spec:
    containers:
    - command:
      - sleep
      - "9999"
      image: g1g1/py-kube:latest
      imagePullPolicy: IfNotPresent
      name: some-container
--pass: 1, fail: 0, warn: 0, error: 0, skip: 2
```

如你所见，将变更策略应用于 some-pod 后，`imagePullPolicy` 按预期变为 IfNotPresent。

让我们试试 `kyverno jp` 子命令。它接受标准输入或可以从文件读取。

以下是一个检查 Pod 中第一个容器的命令有多少个参数的示例。我们将使用这个 Pod 清单作为输入：

```bash
$ cat some-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    image: g1g1/py-kube:latest
    command:
    - sleep
    - "9999"
```

注意它有一个名为 sleep 的命令，带有一个参数 "9999"。我们期望答案是 1。以下命令可以实现：

```bash
$ cat some-pod.yaml | kyverno jp 'length(spec.containers[0].command) | subtract(@, `1`)'
1
```

它是如何工作的？首先，它将 `some-pod.yaml` 的内容传递给 `kyverno jp` 命令，使用 JMESPath 表达式获取第一个容器命令的长度（一个包含两个元素的数组，"sleep" 和 "9999"），然后将其传递给 `subtract()` 函数，该函数减去 1，因此最终得到预期的结果 1。

Kyverno CLI 命令 `apply` 和 `jp` 非常适合临时探索和快速原型制作复杂的 JMESPath 表达式。但是，如果你大规模使用 Kyverno 策略（你应该如此），那么我建议采用更严格的测试实践。幸运的是，Kyverno 通过 `kyverno test` 命令对测试有很好的支持。让我们看看如何编写和运行 Kyverno 测试。

#### 理解 Kyverno 测试

`kyverno test` 命令对一组资源和策略进行操作，这些资源和策略由名为 `kyverno-test.yaml` 的文件控制，该文件定义了哪些策略规则应应用于哪些资源以及预期的结果是什么。然后它返回结果。

将策略规则应用于资源的结果可以是以下四种之一：

- **pass**——资源匹配策略且不触发 deny 语句（仅适用于验证策略）
- **fail**——资源匹配策略并触发 deny 语句（仅适用于验证策略）
- **skip**——资源不匹配策略定义，策略未被应用
- **warn**——资源不符合策略，但具有注解：`policies.kyverno.io/scored: "false"`

如果测试的预期结果与将策略应用于资源的实际结果不匹配，则测试将被视为失败。

对于变更和生成策略，测试将分别包含 `patchedResource` 和 `generatedResource`。

让我们看看 `kyverno-test.yaml` 文件长什么样：

```yaml
name: <some name>
policies:
- <path/to/policy.yaml>
- <path/to/policy.yaml>
resources:
- <path/to/resource.yaml>
- <path/to/resource.yaml>
variables: variables.yaml # optional file for declaring variables
userinfo: user_info.yaml # optional file for declaring admission request information (roles, cluster roles and subjects)
results:
- policy: <name>
  rule: <name>
  resource: <name>
  resources: # optional, primarily for `validate` rules. One of either `resource` or `resources[]` must be specified. Use `resources[]` when a number of different resources should all share the same test result.
  - <name_1>
  - <name_2>
  namespace: <name> # when testing for a resource in a specific Namespace
  patchedResource: <file_name.yaml> # when testing a mutate rule this field is required.
  generatedResource: <file_name.yaml> # when testing a generate rule this field is required.
  kind: <kind>
  result: pass
```

许多不同的测试用例可以定义在单个 `kyverno-test.yaml` 文件中。该文件有五个部分：

- policies
- resources
- variables
- userInfo
- results

`policies` 和 `resources` 部分指定了参与测试的所有策略和资源的路径。可选的 `variables` 和 `userInfo` 部分可以定义测试用例将使用的额外信息。

`results` 部分是指定各种测试用例的地方。每个测试用例测试单个策略规则应用于单个资源。如果是验证规则，则 `result` 字段应包含预期结果。

如果是变更或生成规则，则相应的 `patchedResource` 或 `generatedResource` 应包含预期结果。

让我们为我们的策略编写一些 Kyverno 测试。

##### 编写 Kyverno 测试

这里提到的所有文件都可以在本章附带的代码的 `tests` 子目录中找到。

让我们从编写 `kyverno-test.yaml` 文件开始：

```yaml
name: test-some-rule
policies:
- ../disallow-some-services-policy.yaml
resources:
- test-service-ok.yaml
- test-service-bad-name.yaml
- test-service-bad-namespace.yaml
results:
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-ok
  kind: Service
  result: skip
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-1
  kind: Service
  result: fail
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-in-ns-1
  kind: Service
  namespace: ns-1
  result: fail
```

`policies` 部分包含 `disallow-some-services-policy.yaml` 文件。此策略拒绝名为 service-1 或 service-2 的服务以及 ns-1 命名空间中的任何 Service。

`resources` 部分包含三个不同的文件，每个文件都包含一个 Service 资源：

- `test-service-ok.yaml`
- `test-service-bad-name.yaml`
- `test-service-bad-namespace.yaml`

`test-service-ok.yaml` 文件包含一个不匹配策略任何规则的 Service。`test-service-bad-name.yaml` 文件包含一个名为 service-1 的 Service，这是不允许的。最后，`test-service-bad-namespace.yaml` 文件包含一个名为 service-in-ns-1 的资源，这是允许的。但是，它具有 ns-1 命名空间，这是不允许的。

让我们看看 `results` 部分。这里有三个不同的测试用例。它们都测试我们策略中的同一个规则，但每个测试用例使用不同的资源名称。这全面覆盖了策略的行为。

第一个测试用例验证不匹配规则的 Service 被跳过。它指定了策略、规则名称、测试用例应应用的资源，以及最重要的预期结果，在本例中是 skip：

```yaml
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-ok
  result: skip
```

第二个测试用例类似，只是资源名称不同，预期结果是 fail：

```yaml
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-1
  kind: Service
  result: fail
```

还有一个细微的差别。在这个测试用例中，目标资源的 kind 被显式指定（kind: Service）。这可能乍一看是多余的，因为 `test-service-bad-name.yaml` 中定义的 service-1 资源已经列出了 kind：

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: service-1
  name: service-1
  namespace: ns-2
spec:
  ports:
  - name: https
    port: 443
    targetPort: https
  selector:
    app: some-app
```

需要 kind 字段的原因是为了消除目标资源的歧义，以防资源文件包含多个具有相同名称的资源。

第三个测试用例与第二个测试用例相同，只是针对不同的资源，因此是规则的不同部分（禁止 ns-1 命名空间中的服务）：

```yaml
- policy: disallow-some-services
  rule: some-rule
  resources:
  - service-in-ns-1
  kind: Service
  namespace: ns-1
  result: fail
```

好的。我们有测试用例了。让我们看看如何运行这些测试。

##### 运行 Kyverno 测试

运行 Kyverno 测试非常简单。你只需输入 `kyverno test` 和包含 `kyverno-test.yaml` 文件的文件夹的路径，或 Git 仓库和分支。

让我们运行我们的测试：

```bash
$ kyverno test .
Executing test-some-rule...
applying 1 policy to 3 resources...
│───│────────────────────────│───────────│──────────────────────────────│────────│
│ # │ POLICY                 │ RULE      │ RESOURCE                     │ RESULT │
│───│────────────────────────│───────────│──────────────────────────────│────────│
│ 1 │ disallow-some-services │ some-rule │ ns-2//service-ok             │ Pass   │
│ 2 │ disallow-some-services │ some-rule │ ns-2/Service/service-1       │ Pass   │
│ 3 │ disallow-some-services │ some-rule │ ns-1/Service/service-in-ns-1 │ Pass   │
│───│────────────────────────│───────────│──────────────────────────────│────────│
Test Summary: 3 tests passed and 0 tests failed
```

我们得到一个很好的输出，列出了每个测试用例，然后是一行摘要。所有三个测试都通过了，这很好。

当你的测试文件包含大量测试用例，并且你尝试调整一个特定规则时，你可能只想运行一个特定的测试用例。语法如下：

```bash
kyverno test . --test-case-selector "policy=disallow-some-services, rule=some-rule, resource=service-ok"
```

`kyverno test` 命令有非常好的文档和大量示例。只需输入 `kyverno test -h`。

到目前为止，我们已经编写了策略、规则和策略测试并执行了它们。最后一块拼图是在 Kyverno 运行时查看报告。

### 查看 Kyverno 报告

Kyverno 为具有 `validate` 或 `verifyImages` 规则的策略生成报告。只有处于 audit 模式或 `spec.background: true` 的策略才会生成报告。

你可能还记得 Kyverno 可以以自定义资源的形式生成两种类型的报告。PolicyReport 是针对命名空间范围的资源（如服务）在资源被应用的命名空间中生成的。ClusterPolicyReport 是针对集群范围的资源（如命名空间）生成的。

我们的 `disallow-some-services` 策略有一个 `validate` 规则，并且在 audit 模式下运行，这意味着如果我们创建一个违反规则的 Service，Service 将被创建，但会生成一个报告。我们开始：

```bash
$ k create service clusterip service-3 -n ns-1 --tcp=80
service/service-3 created
```

我们在被禁止的 ns-1 命名空间中创建了一个 Service。由于审计模式，Kyverno 没有阻止 Service 的创建。让我们查看报告（其中 polr 是 policyreports 的简写）：

```bash
$ k get polr -n ns-1
NAME                            PASS   FAIL   WARN   ERROR   SKIP   AGE
cpol-disallow-some-services     0      1      0      0       0      1m
```

创建了一个名为 `cpol-disallow-some-services` 的报告。我们可以看到它计数了一次失败。

如果我们创建另一个 Service 会发生什么？

```bash
$ k create service clusterip service-4 -n ns-1 --tcp=80
service/service-4 created
$ k get polr -n ns-1
NAME                            PASS   FAIL   WARN   ERROR   SKIP   AGE
cpol-disallow-some-services     0      2      0      0       0      2m
```

是的。报告了另一个失败。这些失败的含义是资源未能通过验证规则。让我们看看里面。报告有一个 `metadata` 字段，其中包含它所代表的策略的注解。然后有一个 `results` 部分，其中列出了每个失败资源。每个结果的信息包括导致失败的资源及其违反的规则。最后，`summary` 包含结果的汇总信息：

```yaml
$ k get polr cpol-disallow-some-services -n ns-1 -o yaml
apiVersion: wgpolicyk8s.io/v1alpha2
kind: PolicyReport
metadata:
  creationTimestamp: "2023-01-22T04:01:12Z"
  generation: 3
  labels:
    app.kubernetes.io/managed-by: kyverno
    cpol.kyverno.io/disallow-some-services: "2472317"
  name: cpol-disallow-some-services
  namespace: ns-1
  resourceVersion: "2475547"
  uid: dadcd6ae-a867-4ec8-bf09-3e6ca76da7ba
results:
- message: services named service-1 and service-2 and any service in namespace ns-1 are not allowed
  policy: disallow-some-services
  resources:
  - apiVersion: v1
    kind: Service
    name: service-4
    namespace: ns-1
    uid: 4d473ac1-c1b1-4929-a70d-fad98a411428
  result: fail
  rule: some-rule
  scored: true
  source: kyverno
  timestamp:
    nanos: 0
    seconds: 1674361576
- message: services named service-1 and service-2 and any service in namespace ns-1 are not allowed
  policy: disallow-some-services
  resources:
  - apiVersion: v1
    kind: Service
    name: service-3
    namespace: ns-1
    uid: 62458ac4-fe39-4854-9f5a-18b26109511a
  result: fail
  rule: some-rule
  scored: true
  source: kyverno
  timestamp:
    nanos: 0
    seconds: 1674361426
summary:
  error: 0
  fail: 2
  pass: 0
  skip: 0
  warn: 0
```

这相当不错，但如果你有很多命名空间，这可能不是跟踪集群的最佳方式。最佳实践是收集所有报告并定期导出到中心位置。请查看 Policy Reporter 项目：https://github.com/kyverno/policy-reporter。它还附带一个基于 Web 的策略报告 UI。

让我们安装它：

```bash
$ helm repo add policy-reporter https://kyverno.github.io/policy-reporter
"policy-reporter" has been added to your repositories
$ helm repo update
Hang tight while we grab the latest from your chart repositories...
...Successfully got an update from the "policy-reporter" chart repository
...Successfully got an update from the "kyverno" chart repository
Update Complete. ⎈Happy Helming!⎈

$ helm upgrade --install policy-reporter policy-reporter/policy-reporter --create-namespace -n policy-reporter --set ui.enabled=true
Release "policy-reporter" does not exist. Installing it now.
NAME: policy-reporter
LAST DEPLOYED: Sat Jan 21 20:39:42 2023
NAMESPACE: policy-reporter
STATUS: deployed
REVISION: 1
TEST SUITE: None
```

Policy Reporter 已成功安装在 policy-reporter 命名空间中，并且我们启用了 UI。

下一步是进行端口转发以访问 UI：

```bash
$ k port-forward service/policy-reporter-ui 8080:8080 -n policy-reporter
Forwarding from 127.0.0.1:8080 -> 8080
Forwarding from [::1]:8080 -> 8080
```

现在，我们可以浏览 http://localhost:8080 并直观地查看策略报告。

仪表板显示失败的策略报告。我们可以看到 kube-system 命名空间中的 20 个失败和 ns-1 命名空间中的 2 个失败。

![图 16.7: Policy Reporter UI – 仪表板](ch16-fig07.png)

kube-system 中的失败是由于我们使用 Kyverno 安装的最佳实践安全策略造成的。我们可以向下滚动查看有关失败的更多详细信息：

![图 16.8: Policy Reporter UI – 结果](images/ch16-fig08.png)

我们还可以从侧边栏选择"Policy Reports"选项，然后查看通过的结果。我们还可以使用不同条件（如策略、种类、类别、严重性和命名空间）过滤策略报告：

![图 16.9: Policy Reporter UI – 策略报告](images/ch16-fig09.png)

总的来说，Policy Reporter UI 外观精美，为探索、过滤和搜索策略报告提供了很好的选择。

### 总结

在本章中，我们介绍了 Kubernetes 在大型企业组织中日益增长的采用率以及治理在管理这些部署中的重要性。我们研究了策略引擎的概念以及它们如何构建在 Kubernetes 准入控制机制之上。我们讨论了策略引擎如何用于解决安全、合规和治理问题。我们还对流行的策略引擎进行了回顾。最后，我们深入探讨了 Kyverno，详细解释了它是如何工作的。然后，我们动手编写了一些策略，测试了它们，并查看了策略报告。如果你在 Kubernetes 上运行非平凡的生成系统，你应该非常认真地考虑将 Kyverno（或另一个策略引擎）作为核心组件。这是下一章的完美过渡，我们将在那里讨论 Kubernetes 在生产环境中的运行。
