---
title: 保护 Kubernetes 安全
---

# 保护 Kubernetes 安全

在第 3 章《高可用与可靠性》中，我们探讨了可靠且高可用的 Kubernetes 集群、基本概念、最佳实践，以及在可扩展性、性能和成本方面的诸多设计权衡。

在本章中，我们将探讨安全这一重要主题。Kubernetes 集群是由多层交互组件组成的复杂系统。在运行关键应用时，各层的隔离和分区非常重要。为了保障系统的安全，确保对资源、功能和数据的正确访问，我们首先必须理解 Kubernetes 作为一个运行未知工作负载的通用编排平台所面临的独特挑战。然后，我们可以利用各种安全、隔离和访问控制机制，确保集群、集群上运行的应用以及数据的安全。我们将讨论各种最佳实践，以及何时适合使用每种机制。

本章将探讨以下主要内容：

- 理解 Kubernetes 安全挑战
- 加固 Kubernetes
- 运行多租户集群

本章结束时，你将深入理解 Kubernetes 的安全挑战。你将获得如何加固 Kubernetes 以防范各种潜在攻击、建立纵深防御的实用知识，甚至能够安全地运行多租户集群，同时为不同用户提供完全的隔离以及对其所属集群部分的完全控制。

## 理解 Kubernetes 安全挑战

Kubernetes 是一个极其灵活的系统，以通用方式管理着底层资源。Kubernetes 本身可以部署在许多操作系统和硬件或虚拟机解决方案上，可以在本地部署，也可以在云端部署。Kubernetes 运行由运行时实现的工作负载，它通过定义良好的运行时接口与这些运行时交互，但并不了解它们是如何实现的。Kubernetes 代表或服务于它一无所知的应用，操作着诸如网络、DNS 和资源分配等关键资源。

这意味着 Kubernetes 面临着艰巨的任务：既要提供良好的安全机制和能力，供应用开发者和集群管理员使用，又要保护自身、开发者和管理员免受常见错误的影响。

在本节中，我们将讨论 Kubernetes 集群多个层次或组件中的安全挑战：节点、网络、镜像、Pod 和容器。**纵深防御**是一个重要的安全概念，要求系统在每个层级进行自我保护，既要缓解穿透其他层级的攻击，又要限制安全漏洞的范围和损害。识别每个层级的挑战是纵深防御的第一步。

这通常被描述为云原生安全的 **4C**：

![图 4.1: 云原生安全的 4C](ch04-fig01.png)

然而，4C 模型是一种粗粒度的安全方法。另一种方法是基于跨不同维度的安全挑战构建威胁模型，例如：

- 节点挑战
- 网络挑战
- 镜像挑战
- 部署和配置挑战
- Pod 和容器挑战
- 组织、文化和流程挑战

让我们逐一审视这些挑战。

### 节点挑战

节点是运行时引擎的主机。如果攻击者获得了对某个节点的访问权限，这将是一个严重的威胁。他们至少可以控制该主机本身及其上运行的所有工作负载。但情况可能更糟。节点上运行着与 API 服务器通信的 kubelet。老练的攻击者可以用修改过的版本替换 kubelet，通过与 Kubernetes API 服务器正常通信来有效逃避检测，同时运行自己的工作负载而非计划中的工作负载，收集整个集群的信息，并通过发送恶意消息来破坏 API 服务器和集群的其他部分。节点可以访问共享资源和 Secret，这可能使攻击者能够渗透得更深。节点被入侵非常严重，既因为可能的破坏力，也因为事后难以检测。

节点也可能在物理层面被攻破。这在裸机环境中更为相关，因为你可以确切知道哪些硬件被分配给了 Kubernetes 集群。

另一个攻击向量是资源耗尽。想象一下，你的节点成为某个僵尸网络的一部分，与你的 Kubernetes 集群无关，只是运行自己的工作负载（如加密货币挖矿），消耗 CPU 和内存。这里的危险在于，你的集群将因资源不足而窒息，无法运行你的工作负载，或者你的基础设施可能自动扩展并分配更多资源。

另一个问题是在自动化部署之外安装调试和故障排查工具或修改配置。这些操作通常未经测试，如果遗留并保持激活状态，至少会导致性能下降，也可能引发更严重的问题。至少，这会增加攻击面。

在安全方面，这是一场数字游戏。你需要理解系统的攻击面以及你在哪些方面存在漏洞。让我们列举一些可能的节点挑战：

- 攻击者控制主机
- 攻击者替换 kubelet
- 攻击者控制运行主控组件（如 API 服务器、调度器或控制器管理器）的节点
- 攻击者获得对节点的物理访问权限
- 攻击者耗尽与 Kubernetes 集群无关的资源
- 通过安装调试和故障排查工具或配置变更造成自我损害

缓解节点挑战需要多层防御，例如控制物理访问、防止权限提升，以及通过控制节点上安装的操作系统和软件来减少攻击面。

### 网络挑战

任何非平凡的 Kubernetes 集群至少跨越一个网络。与网络相关存在许多挑战。你需要非常细致地理解系统组件之间是如何连接的。哪些组件应该相互通信？它们使用什么网络协议？什么端口？它们交换什么数据？你的集群如何与外部世界连接？

存在一个暴露端口、功能或服务的复杂链条：

- 容器到主机
- 主机到内部网络中的其他主机
- 主机到外部世界

使用覆盖网络（将在第 10 章《探索 Kubernetes 网络》中详细讨论）有助于实现纵深防御，即使攻击者获得了容器的访问权限，他们也被隔离在沙箱中，无法逃逸到底层网络基础设施。

组件发现也是一个巨大的挑战。这里有几个选项，如 DNS、专用发现服务和负载均衡器。每个选项都有一组优缺点，需要仔细规划和深入理解才能为你所处的情况做出正确选择。确保两个容器能够相互发现并交换信息并非易事。

你需要决定哪些资源和端点应当公开访问。然后需要提出适当的方法来认证用户和服务，并授权它们操作资源。通常，你也可能需要控制内部服务之间的访问。

敏感数据在进出集群时必须加密，有时在静态存储时也需要加密。这意味着密钥管理和安全的密钥交换，这是安全领域最难解决的问题之一。

如果你的集群与其他 Kubernetes 集群或非 Kubernetes 进程共享网络基础设施，那么你必须谨慎地进行隔离和分离。

其要素包括网络策略、防火墙规则和软件定义网络（SDN）。具体的配方通常需要定制。这在本地和裸机集群中尤其具有挑战性。

以下是你将面临的一些网络挑战：

- 制定连接计划
- 选择组件、协议和端口
- 解决动态发现的问题
- 公开访问与私有访问
- 认证和授权（包括内部服务之间）
- 设计防火墙规则
- 决定网络策略
- 密钥管理和交换
- 加密通信

在让容器、用户和服务能够在网络层面轻松发现和相互通信，与锁定访问权限并防止通过网络或针对网络本身的攻击之间，始终存在持续的张力。

这些挑战中有许多并非 Kubernetes 特有。然而，Kubernetes 是一个管理关键基础设施并处理底层网络的通用平台，这一事实使得有必要思考动态且灵活的解决方案，这些方案能够将系统特定的需求集成到 Kubernetes 中。这些解决方案通常涉及监控并基于命名空间和 Pod 标签自动注入防火墙规则或应用网络策略。

### 镜像挑战

Kubernetes 运行符合其某个运行时引擎的容器。它完全不知道这些容器在做什么（除了收集指标）。你可以通过配额对容器设置某些限制。你也可以通过网络策略限制它们对网络其他部分的访问。但归根结底，容器确实需要访问主机资源、网络中的其他主机、分布式存储和外部服务。镜像决定了容器的行为。臭名昭著的软件供应链问题正是这些容器镜像创建方式的核心。镜像存在两类问题：

- **恶意镜像**：包含由攻击者设计用来造成损害、收集信息或仅仅利用你的基础设施达到其目的（例如加密货币挖矿）的代码或配置的镜像。恶意代码可以被注入到你的镜像准备管道中，包括你使用的任何镜像仓库。或者，你可能安装了本身已被攻陷并现在包含恶意代码的第三方镜像。
- **易受攻击的镜像**：你设计的镜像（或你安装的第三方镜像）恰好包含某种漏洞，使攻击者能够控制正在运行的容器或造成其他损害，包括之后注入他们自己的代码。

很难说哪一类更糟糕。极端情况下，它们是等价的，因为都允许完全控制容器。现有的其他防御措施（还记得纵深防御吗？）和你对容器施加的限制将决定它能够造成多大的损害。最小化不良镜像的危害非常具有挑战性。快速发展的公司使用微服务架构，每天可能生成大量镜像。验证镜像也并非易事。此外，某些容器需要广泛的权限才能执行其合法工作。如果这样的容器被攻陷，可能会造成极大的损害。

包含操作系统的基础镜像随时可能因新漏洞被发现而变得脆弱。此外，如果你依赖他人准备的基础镜像（这是非常常见的做法），那么恶意代码可能会进入这些基础镜像，而你对此无法控制，只能隐式信任。

当第三方依赖项中发现漏洞时，理想情况下已有修复版本，你应该尽快修补。

我们可以将开发人员可能面临的镜像挑战总结如下：

- Kubernetes 不知道容器在做什么
- Kubernetes 必须为指定功能提供对敏感资源的访问
- 保护镜像准备和交付管道（包括镜像仓库）很困难
- 新镜像的开发和部署速度与仔细审查变更之间存在冲突
- 包含操作系统或其他公共依赖的基础镜像很容易过时并变得易受攻击
- 基础镜像通常不受你的控制，可能更容易被注入恶意代码

将静态镜像分析器（如 CoreOS Clair 或 Anchore Engine）集成到你的 CI/CD 管道中会大有帮助。此外，通过将容器的资源访问限制在仅执行其工作所需的范围内来最小化爆炸半径，可以降低容器被攻陷时对系统的影响。你还必须勤于修补已知漏洞。

### 配置和部署挑战

Kubernetes 集群是远程管理的。各种清单和策略决定了集群在每一时刻的状态。如果攻击者获得对具有集群管理控制权的机器的访问权限，他们可以肆意破坏，例如收集信息、注入不良镜像、削弱安全性以及篡改日志。像往常一样，错误和失误同样有害；忽视重要的安全措施会使集群暴露在攻击之下。如今，拥有集群管理访问权限的员工经常在家或咖啡店远程工作，随身携带笔记本电脑，只需一个 `kubectl` 命令就可能打开泄洪闸门。

让我们重申这些挑战：

- Kubernetes 是远程管理的
- 拥有远程管理访问权限的攻击者可以完全控制集群
- 配置和部署通常比代码更难以测试
- 远程或不在办公室的员工面临更高的暴露风险，使攻击者能够获取他们具有管理访问权限的笔记本电脑或手机

有一些最佳实践可以最小化这种风险，例如通过跳板机作为间接层——开发者从外部连接到集群中一台具有严格控制的专用机器，该机器管理与内部服务的安全交互；要求 VPN 连接（认证并加密所有通信）；并使用多因素认证和一次性密码来防范简单的密码破解攻击。

### Pod 和容器挑战

在 Kubernetes 中，Pod 是工作单元，包含一个或多个容器。Pod 是一种分组和部署结构。但通常，部署在同一个 Pod 中的容器通过直接机制进行交互。所有容器共享相同的 localhost 网络，并且通常共享来自宿主机的挂载卷。同一个 Pod 中容器之间的这种便捷集成可能导致宿主机的一部分暴露给所有容器。这可能使一个有问题的容器（无论是恶意的还是仅存在漏洞的）为对 Pod 中其他容器的升级攻击打开通路，随后控制节点本身乃至整个集群。控制平面插件通常与控制平面组件部署在一起，存在这种危险，尤其是因为其中许多插件是实验性的。DaemonSet 也是如此，它在每个节点上运行 Pod。边车容器的实践——即除了应用容器之外，在 Pod 中额外部署容器——非常流行，尤其是在服务网格中。这增加了风险，因为边车容器通常不在你的控制范围内，如果被攻陷，可以为攻击者提供对你基础设施的访问权限。

多容器 Pod 的挑战包括：

- 同一个 Pod 中的容器共享 localhost 网络
- 同一个 Pod 中的容器有时共享宿主机文件系统上的挂载卷
- 有问题的容器可能污染 Pod 中的其他容器
- 如果与访问关键节点资源的另一个容器共置，有问题的容器更容易攻击节点
- 与主控组件共置的实验性插件可能是实验性的且安全性较低
- 服务网格引入了可能成为攻击向量的边车容器

仔细考虑同一个 Pod 中运行的容器之间的交互。你应该意识到，有问题的容器可能首先尝试攻陷同一 Pod 中的兄弟容器。这意味着你应该能够检测注入到 Pod 中的恶意容器（例如，通过恶意的准入控制 Webhook 或被攻陷的 CI/CD 管道）。你还应该应用最小权限原则，并最小化此类恶意容器可能造成的损害。

### 组织、文化和流程挑战

安全通常被认为与生产力相对立。这是一种正常的权衡，不必过于担心。传统上，当开发和运维分离时，这种冲突在组织层面进行管理。开发者追求更高的生产力，并将安全要求视为开展业务的成本。运维部门负责控制生产环境，负责访问和安全流程。DevOps 运动推倒了开发者和运维之间的壁垒。现在，开发速度常常占据首要位置。诸如持续部署等概念——每天无需人工干预部署多次——在大多数组织中前所未闻。Kubernetes 正是为这个云原生应用的新世界而设计的。但是，它是基于 Google 的经验开发的。Google 有充足的时间和经验丰富的专家来开发适当的流程和工具，以平衡快速部署与安全性。对于较小的组织来说，这种平衡行为可能非常具有挑战性，而过度关注生产力可能会削弱安全性。

采用 Kubernetes 的组织面临的挑战如下：

- 控制 Kubernetes 运维的开发者可能不太注重安全
- 开发速度可能被认为比安全性更重要
- 持续部署可能使某些安全问题在进入生产环境之前难以被发现
- 较小的组织可能缺乏在 Kubernetes 集群中正确管理安全的知识和专业知识

这里没有简单的答案。你应该有意识地寻找安全与敏捷之间的正确平衡点。我建议让一个专门的安全团队（或至少一个专注于安全的人）参与所有计划会议，并倡导安全。从一开始就将安全融入你的系统中至关重要。

在本节中，我们回顾了在尝试构建安全的 Kubernetes 集群时面临的许多挑战。这些挑战中的大多数并非 Kubernetes 特有，但使用 Kubernetes 意味着你的系统中很大一部分是通用的，并且不了解系统在做什么。

这在试图锁定系统时可能会带来问题。挑战分布在不同的层面：

- 节点挑战
- 网络挑战
- 镜像挑战
- 配置和部署挑战
- Pod 和容器挑战
- 组织和流程挑战

在下一节中，我们将探讨 Kubernetes 解决其中一些挑战所提供的机制。许多挑战需要更大系统范围内的解决方案。重要的是要认识到，仅仅利用所有 Kubernetes 安全功能是不够的。

## 加固 Kubernetes

上一节列举并列出了部署和维护 Kubernetes 集群的开发者和管理员面临的各种安全挑战。在本节中，我们将专注于 Kubernetes 提供的设计方面、机制和特性，以解决其中的一些挑战。通过明智地使用诸如服务账户、网络策略、认证、授权、准入控制、AppArmor 和 Secret 等功能，你可以达到相当好的安全状态。

请记住，Kubernetes 集群是一个更大系统的一部分，该系统还包括其他软件系统、人员和流程。Kubernetes 不能解决所有问题。你应该始终牢记通用安全原则，如纵深防御、按需知密和最小权限原则。

此外，记录所有你认为在发生攻击时可能有用的信息，并设置警报以便在系统偏离其状态时早期检测。这可能只是一个 Bug，也可能是一次攻击。无论哪种情况，你都希望了解它并做出响应。

### 理解 Kubernetes 中的服务账户

Kubernetes 有普通用户和服务账户两种类型。普通用户是在集群外部管理的，供人类用户连接到集群（例如通过 `kubectl` 命令）。服务账户则被限制在一个命名空间内。这一点很重要。它确保了命名空间的隔离性，因为每当 API 服务器从 Pod 接收到请求时，其凭据将仅适用于它自己的命名空间。

Kubernetes 代表 Pod 管理服务账户。每当 Kubernetes 实例化一个 Pod 时，除非服务账户或 Pod 通过设置 `automountServiceAccountToken` 为 `False` 明确选择退出，否则 Kubernetes 会为 Pod 分配一个服务账户。该服务账户标识了 Pod 中所有进程在与 API 服务器交互时的身份。每个服务账户都有一组凭据挂载在 Secret 卷中。每个命名空间都有一个名为 `default` 的默认服务账户。当你创建 Pod 时，除非指定了不同的服务账户，否则它会自动分配 `default` 服务账户。

如果你希望不同的 Pod 具有不同的身份和权限，可以创建额外的服务账户。然后可以将不同的服务账户绑定到不同的角色。

创建一个名为 `custom-service-account.yaml` 的文件，内容如下：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: custom-service-account
```

现在执行以下命令：

```bash
$ kubectl create -f custom-service-account.yaml
serviceaccount/custom-service-account created
```

以下是该服务账户与默认服务账户并列显示的情况：

```bash
$ kubectl get serviceaccounts
NAME                    SECRETS   AGE
custom-service-account   1         6s
default                  1         2m28s
```

请注意，系统自动为你的新服务账户创建了一个 Secret：

```bash
$ kubectl get secret
NAME                              DATA   TYPE                       AGE
custom-service-account-token-vbrbm 3     kubernetes.io/service-account-token   62s
default-token-m4nfk                3     kubernetes.io/service-account-token   3m24s
```

要获取更多详细信息，请执行以下命令：

```bash
$ kubectl get serviceAccounts/custom-service-account -o yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  creationTimestamp: "2022-06-19T18:38:22Z"
  name: custom-service-account
  namespace: default
  resourceVersion: "784"
  uid: f70f70cf-5b42-4a46-a2ff-b07792bf1220
secrets:
- name: custom-service-account-token-vbrbm
```

通过执行以下命令，你可以看到 Secret 本身，其中包含 `ca.crt` 文件和 token：

```bash
$ kubectl get secret custom-service-account-token-vbrbm -o yaml
```

**Kubernetes 如何管理服务账户？**

API 服务器有一个专用组件，称为**服务账户准入控制器**。它负责在 Pod 创建时检查 API 服务器是否有自定义服务账户，如果有，则检查该自定义服务账户是否存在。如果没有指定服务账户，则分配默认服务账户。

它还确保 Pod 具有 `ImagePullSecrets`，这在需要从远程镜像仓库拉取镜像时是必需的。如果 Pod 规范没有任何 Secret，则使用服务账户的 `ImagePullSecrets`。

最后，它添加一个包含 API 访问 token 的卷，并将一个 `volumeSource` 挂载到 `/var/run/secrets/kubernetes.io/serviceaccount`。

API token 由另一个名为 **token 控制器**的组件在创建服务账户时创建并添加到 Secret 中。token 控制器还监视 Secret，当 Secret 被添加或从服务账户中移除时，相应地添加或移除 token。

**服务账户控制器**确保每个命名空间都存在默认服务账户。

### 访问 API 服务器

访问 API 服务器需要经过一系列步骤，包括认证、授权和准入控制。在每个阶段，请求都可能被拒绝。每个阶段由多个串联在一起的插件组成。

下图说明了这一点：

![图 4.2: 访问 API 服务器](ch04-fig02.png)

#### 认证用户

当你首次创建集群时，会为你创建一些密钥和证书，用于向集群进行身份认证。这些凭据通常存储在 `~/.kube/config` 文件中，该文件可能包含多个集群的凭据。你还可以拥有多个配置文件，并通过设置 `KUBECONFIG` 环境变量或向 `kubectl` 传递 `--kubeconfig` 标志来控制将使用哪个文件。`kubectl` 使用这些凭据通过 TLS（加密的 HTTPS 连接）向 API 服务器进行身份验证，反之亦然。让我们通过设置 `KUBECONFIG` 环境变量来创建一个新的 KinD 集群，并将其凭据存储在专用的配置文件中：

```bash
$ export KUBECONFIG=~/.kube/kind-config
$ kind create cluster
Creating cluster "kind" ...

  Ensuring node image (kindest/node:v1.23.4) 🖼
  Preparing nodes
  Writing configuration
  Starting control-plane
  Installing CNI
  Installing StorageClass
Set kubectl context to "kind-kind"
You can now use your cluster with:

  kubectl cluster-info --context kind-kind
```

你可以使用以下命令查看配置：

```bash
$ kubectl config view
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: DATA+OMITTED
    server: https://127.0.0.1:61022
  name: kind-kind
contexts:
- context:
    cluster: kind-kind
    user: kind-kind
  name: kind-kind
current-context: kind-kind
kind: Config
preferences: {}
users:
- name: kind-kind
  user:
    client-certificate-data: REDACTED
    client-key-data: REDACTED
```

这是 KinD 集群的配置。对于其他类型的集群，它可能看起来不同。

请注意，如果多个用户需要访问该集群，创建者应以安全的方式向其他用户提供必要的客户端证书和密钥。

这只是建立起与 Kubernetes API 服务器本身的基本信任。你尚未完成身份认证。各种认证模块可能会检查请求，并检查各种额外的客户端证书、密码、承载 token 和 JWT token（用于服务账户）。大多数请求需要经过身份认证的用户（普通用户或服务账户），尽管也有一些匿名请求。如果请求无法通过所有认证器的认证，它将以 HTTP 401 状态码（未授权，尽管这个说法有些用词不当）被拒绝。

集群管理员通过向 API 服务器提供各种命令行参数来确定使用哪些认证策略：

- `--client-ca-file=`（用于文件中指定的 x509 客户端证书）
- `--token-auth-file=`（用于文件中指定的承载 token）
- `--basic-auth-file=`（用于文件中指定的用户/密码对）
- `--enable-bootstrap-token-auth`（用于 kubeadm 使用的引导 token）

服务账户使用一个自动加载的认证插件。管理员可以提供两个可选标志：

- `--service-account-key-file=`（如果未指定，将使用 API 服务器的 TLS 私钥作为签署承载 token 的 PEM 编码密钥）
- `--service-account-lookup`（启用后，如果 token 从 API 中删除，将执行 token 撤销）

还有其他几种方法，例如 OpenID Connect、Webhook、Keystone（OpenStack 身份服务）和认证代理。主要主题是认证阶段是可扩展的，可以支持任何认证机制。

各种认证插件将检查请求，并根据提供的凭据，关联以下属性：

- **Username**（用户名，一个用户友好的名称）
- **UID**（唯一标识符，比用户名更一致）
- **Groups**（用户所属的一组组名）
- **Extra fields**（将字符串键映射到字符串值）

在 Kubernetes 1.11 中，`kubectl` 获得了使用凭据插件从提供商（例如组织的 LDAP 服务器）接收不透明 token 的能力。这些凭据由 `kubectl` 发送到 API 服务器，API 服务器通常使用 Webhook token 认证器来验证凭据并接受请求。

认证器完全不知道特定用户被允许做什么。它们只是将一组凭据映射到一组身份。认证器以未指定的顺序运行；第一个接受所传递凭据的认证器会将一个身份关联到传入请求，认证即被视为成功。如果所有认证器都拒绝了该凭据，则认证失败。

有趣的是，Kubernetes 并不知道它的普通用户是谁。etcd 中没有用户列表。任何出示由与集群关联的证书颁发机构（CA）签署的有效证书的用户都将获得认证。

**模拟**

用户可以模拟其他用户（需要适当授权）。例如，管理员可能希望以具有较少权限的其他用户身份排查问题。这需要将模拟头部传递给 API 请求。头部如下：

- `Impersonate-User`：指定要代为操作的用户名。
- `Impersonate-Group`：指定要代为操作的组名。可以通过多次指定此选项来提供多个组。此选项是可选的，但需要设置 `Impersonate-User`。
- `Impersonate-Extra-(extra name)`：用于将额外字段与用户关联的动态头部。此选项是可选的，但需要设置 `Impersonate-User`。

使用 `kubectl` 时，传递 `--as` 和 `--as-group` 参数。

要模拟一个服务账户，请执行以下命令：

```bash
kubectl --as system:serviceaccount:<namespace>:<service account name>
```

#### 授权请求

用户通过认证后，授权开始。Kubernetes 具有通用的授权语义。一组授权模块接收请求，其中包括已认证的用户名和请求的动词（list、get、watch、create 等）。与认证不同，所有授权插件都会处理每个请求。如果任何一个授权插件拒绝了该请求，或者没有插件给出意见，则该请求将被拒绝，并返回 HTTP 403 状态码（禁止）。只有当至少一个插件接受该请求且没有其他插件拒绝它时，请求才会继续。

集群管理员通过指定 `--authorization-mode` 命令行标志来确定使用哪些授权插件，该标志是一个逗号分隔的插件名称列表。

支持以下模式：

- `--authorization-mode=AlwaysDeny`：拒绝所有请求。如果你不需要授权则使用。
- `--authorization-mode=AlwaysAllow`：允许所有请求。如果你不需要授权则使用。这在测试期间很有用。
- `--authorization-mode=ABAC`：允许基于本地文件的、用户配置的简单授权策略。ABAC 代表**基于属性的访问控制**（Attribute-Based Access Control）。
- `--authorization-mode=RBAC`：一种基于角色的机制，授权策略由 Kubernetes API 存储和驱动。RBAC 代表**基于角色的访问控制**（Role-Based Access Control）。
- `--authorization-mode=Node`：一种特殊模式，旨在授权 kubelet 发出的 API 请求。
- `--authorization-mode=Webhook`：允许通过 REST 由远程服务驱动授权。

你可以通过实现以下简单的 Go 接口来添加自己的自定义授权插件：

```go
type Authorizer interface {
    Authorize(ctx context.Context, a Attributes) (authorized Decision, reason string, err error)
}
```

`Attributes` 输入参数也是一个接口，提供了做出授权决策所需的所有信息：

```go
type Attributes interface {
    GetUser() user.Info
    GetVerb() string
    IsReadOnly() bool
    GetNamespace() string
    GetResource() string
    GetSubresource() string
    GetName() string
    GetAPIGroup() string
    GetAPIVersion() string
    IsResourceRequest() bool
    GetPath() string
}
```

你可以在 https://github.com/kubernetes/apiserver/blob/master/pkg/authorization/authorizer/interfaces.go 找到源代码。

使用 `kubectl can-i` 命令，你可以检查你可以执行哪些操作，甚至可以模拟其他用户：

```bash
$ kubectl auth can-i create deployments
Yes
$ kubectl auth can-i create deployments --as jack
no
```

`kubectl` 支持插件。我们将在第 15 章《扩展 Kubernetes》中深入讨论插件。同时，我只想提一下我最喜欢的插件之一：`rolesum`。这个插件为你提供用户或服务账户拥有的所有权限的摘要。以下是一个示例：

```bash
$ kubectl rolesum job-controller -n kube-system
ServiceAccount: kube-system/job-controller
Secrets:
  */job-controller-token-tp72d
Policies:
  [CRB] */system:controller:job-controller

  Resource          Name  Exclude  Verbs
  events.[,events.k8s.io]        [*]  [-]  [-]
  jobs.batch                     [*]  [-]  [-]
  jobs.batch/finalizers          [*]  [-]  [-]
  jobs.batch/status              [*]  [-]  [-]
  pods                            [*]  [-]  [-]

  [CR] */system:controller:job-controller  G L W C U P D DC
                                           ✖✖✖✔✔✔ ✖ ✖
                                           ✔✔✔✖✔✔ ✖ ✖
                                           ✖✖✖✖✔✖ ✖ ✖
                                           ✖✖✖✖✔✖ ✖ ✖
                                           ✖✔✔✔✖✔ ✔ ✖
```

在此查看：https://github.com/Ladicle/kubectl-rolesum。

#### 使用准入控制插件

好的。请求已经过认证和授权，但在执行之前还有一个步骤。请求必须经过一系列的**准入控制插件**。与授权器类似，如果任何一个准入控制器拒绝请求，该请求就会被拒绝。准入控制器是一个简洁的概念。其思想是，可能存在全局集群层面的关注点，可以作为拒绝请求的理由。如果没有准入控制器，所有授权器都需要意识到这些关注点并拒绝请求。但是，有了准入控制器，这个逻辑可以只执行一次。此外，准入控制器还可以修改请求。准入控制器以降效模式或变更模式运行。像往常一样，集群管理员通过提供一个名为 `admission-control` 的命令行参数来决定运行哪些准入控制插件。该值是一个逗号分隔且有序的插件列表。以下是 Kubernetes >= 1.9 的推荐插件列表（顺序很重要）：

```
--admission-control=NamespaceLifecycle,LimitRanger,ServiceAccount,PersistentVolumeLabel,DefaultStorageClass,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,ResourceQuota,DefaultTolerationSeconds
```

让我们看一些可用的插件（新的插件不断添加）：

- **DefaultStorageClass**：为未指定存储类的 PersistentVolumeClaim 创建请求添加默认存储类。
- **DefaultTolerationSeconds**：为 Pod 设置对污点的默认容忍（如果尚未设置）：`notready:NoExecute` 和 `notreachable:NoExecute`。
- **EventRateLimit**：限制事件对 API 服务器的洪泛。
- **ExtendedResourceToleration**：将具有特殊资源（如 GPU 和现场可编程门阵列（FPGA））的节点上的污点与请求这些资源的 Pod 上的容忍相结合。最终结果是，具有额外资源的节点将专供具有适当容忍的 Pod 使用。
- **ImagePolicyWebhook**：这个复杂的插件连接到一个外部后端，以根据镜像决定是否应拒绝请求。
- **LimitPodHardAntiAffinity**：在 `requiredDuringSchedulingRequiredDuringExecution` 字段中，任何指定了除 `kubernetes.io/hostname` 之外的 AntiAffinity 拓扑键的 Pod 将被拒绝。
- **LimitRanger**：拒绝违反资源限制的请求。
- **MutatingAdmissionWebhook**：调用已注册的变更 Webhook，它们能够修改其目标对象。注意，由于其他变更 Webhook 可能做出的更改，因此无法保证该更改会生效。
- **NamespaceAutoProvision**：如果请求中的命名空间不存在，则创建它。
- **NamespaceLifecycle**：拒绝在正在终止或不存在的命名空间中创建对象的请求。
- **ResourceQuota**：拒绝违反命名空间资源配额的请求。
- **ServiceAccount**：服务账户的自动化管理。
- **ValidatingAdmissionWebhook**：准入控制器调用与请求匹配的验证 Webhook。匹配的 Webhook 被并发调用，如果其中任何一个拒绝了请求，整个请求失败。

如你所见，准入控制插件的功能非常多样化。它们支持命名空间范围的策略，并主要从资源管理和安全的角度强制请求的有效性。这使得授权插件可以专注于有效操作。`ImagePolicyWebHook` 是验证镜像的网关，这是一个重大的挑战。`MutatingAdmissionWebhook` 和 `ValidatingAdmissionWebhook` 是动态准入控制的网关，你可以通过它们部署自己的准入控制器，而无需将其编译到 Kubernetes 中。动态准入控制适用于诸如资源的语义验证（所有 Pod 是否都有一组标准标签？）等任务。我们将在后面的第 16 章《管理 Kubernetes》中深入讨论动态准入控制，因为这是 Kubernetes 策略管理治理的基础。

通过认证、授权和准入这三个独立阶段来验证传入请求的责任划分，每个阶段都有自己的插件，使得复杂的流程更容易理解、使用和扩展。

变更准入控制器提供了很大的灵活性，能够自动执行某些策略而不会给用户带来负担（例如，如果命名空间不存在则自动创建）。

### 保护 Pod 安全

Pod 安全是一个主要关注点，因为 Kubernetes 调度 Pod 并让它们运行。有几个独立的机制用于保护 Pod 和容器的安全。这些机制共同支持纵深防御，即使攻击者（或错误）绕过了某一机制，也会被另一机制拦截。

#### 使用私有镜像仓库

这种方法让你非常有信心，你的集群只会拉取你之前审查过的镜像，并且你可以更好地管理升级。鉴于软件供应链攻击的增多，这是一个重要的对策。你可以在每个节点上配置 `HOME/.docker/config.json`。但是，在许多云提供商上，你无法做到这一点，因为节点是自动为你配置的。

#### ImagePullSecrets

对于云提供商上的集群，推荐使用这种方法。其思路是，镜像仓库的凭据将由 Pod 提供，因此无论它被调度到哪个节点上运行都无关紧要。这绕过了节点级别 `.dockercfg` 的问题。

首先，你需要为凭据创建一个 Secret 对象：

```bash
$ kubectl create secret docker-registry the-registry-secret \
  --docker-server=<docker registry server> \
  --docker-username=<username> \
  --docker-password=<password> \
  --docker-email=<email>
secret 'docker-registry-secret' created.
```

如果需要，你可以为多个仓库（或同一仓库的多个用户）创建 Secret。kubelet 将合并所有 `ImagePullSecrets`。

但是，由于 Pod 只能访问其自己命名空间中的 Secret，你必须在希望 Pod 运行的每个命名空间中创建一个 Secret。一旦定义了 Secret，你就可以将其添加到 Pod 规范中，并在集群上运行一些 Pod。Pod 将使用 Secret 中的凭据从目标镜像仓库拉取镜像：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cool-pod
  namespace: the-namespace
spec:
  containers:
  - name: cool-container
    image: cool/app:v1
  imagePullSecrets:
  - name: the-registry-secret
```

#### 为 Pod 和容器指定安全上下文

Kubernetes 允许在 Pod 级别设置安全上下文，并在容器级别设置额外的安全上下文。Pod 安全上下文是一组操作系统级别的安全设置，例如 UID、GID、能力和 SELinux 角色。Pod 安全上下文还可以将其安全设置（特别是 `fsGroup` 和 `seLinuxOptions`）应用于卷。

以下是一个 Pod 安全上下文的示例：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  securityContext:
    fsGroup: 1234
    supplementalGroups: [5678]
    seLinuxOptions:
      level: 's0:c123,c456'
  containers:
  ...
```

有关 Pod 安全上下文字段的完整列表，请查看 https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.24/#podsecuritycontext-v1-core。

容器安全上下文应用于每个容器，并添加了容器特定的设置。容器安全上下文的某些字段与 Pod 安全上下文中的字段重叠。如果容器安全上下文指定了这些字段，它们将覆盖 Pod 安全上下文中的值。容器上下文设置不能应用于卷，卷保持在 Pod 级别，即使仅挂载到特定容器中也是如此。

以下是一个包含容器安全上下文的 Pod：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    ...
    securityContext:
      privileged: true
      seLinuxOptions:
        level: 's0:c123,c456'
```

有关容器安全上下文字段的完整列表，请查看 https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.24/#securitycontext-v1-core。

#### Pod 安全标准

Kubernetes 定义了适合不同安全需求的安全配置文件，并汇总了推荐设置。

- **特权**（privileged）配置文件提供所有权限，不幸的是，这是默认设置。
- **基线**（baseline）配置文件是一个最小安全配置文件，只防止权限提升。
- **受限**（restricted）配置文件遵循加固最佳实践。

更多信息请参见：https://kubernetes.io/docs/concepts/security/pod-security-standards/。

### 使用 AppArmor 保护集群

AppArmor 是一个 Linux 内核安全模块。使用 AppArmor，你可以将容器中运行的进程限制在一组有限的资源中，例如网络访问、Linux 能力和文件权限。你通过配置文件来配置 AppArmor。

**AppArmor 要求**

AppArmor 支持在 Kubernetes 1.4 中作为 Beta 功能添加。它并非适用于所有操作系统，因此你必须选择一个支持的操作系统发行版才能使用它。Ubuntu 和 SUSE Linux 支持 AppArmor 并默认启用。其他发行版提供可选支持。

要检查 AppArmor 是否已启用，请连接到节点（例如通过 ssh）并执行以下命令：

```bash
$ cat /sys/module/apparmor/parameters/enabled
Y
```

如果结果是 `Y`，则表示已启用。如果文件不存在或结果不是 `Y`，则表示未启用。

配置文件必须加载到内核中。检查以下文件：

```
/sys/kernel/security/apparmor/profiles
```

Kubernetes 没有提供将配置文件加载到节点的内置机制。你通常需要一个具有节点级权限的 DaemonSet 将必要的 AppArmor 配置文件加载到节点中。

有关将 AppArmor 配置文件加载到节点的更多详细信息，请查看以下链接：https://kubernetes.io/docs/tutorials/security/apparmor/#setting-up-nodes-with-profiles。

**使用 AppArmor 保护 Pod**

由于 AppArmor 仍处于 Beta 阶段，你需以注解形式而不是正式字段来指定元数据。当它退出 Beta 阶段后，这将发生变化。

要将配置文件应用于容器，请添加以下注解：

```
container.apparmor.security.beta.kubernetes.io/<container name>: <profile reference>
```

配置文件引用可以是默认配置文件 `runtime/default`，也可以是宿主机上的配置文件 `/localhost`。

以下是一个阻止写入文件的示例配置文件：

```
#include <tunables/global>

profile k8s-apparmor-example-deny-write flags=(attach_disconnected) {
  #include <abstractions/base>

  file,

  # Deny all file writes.
  deny /** w,
}
```

AppArmor 不是 Kubernetes 资源，因此格式不是你熟悉的 YAML 或 JSON。

要验证配置文件是否正确附加，请检查进程 1 的属性：

```bash
kubectl exec <pod-name> cat /proc/1/attr/current
```

默认情况下，Pod 可以调度到集群中的任何节点上。这意味着配置文件应加载到每个节点上。这是 DaemonSet 的经典用例。

**编写 AppArmor 配置文件**

手动为 AppArmor 编写配置文件并不简单。有一些工具可以提供帮助：`aa-genprof` 和 `aa-logprof` 可以为你生成配置文件，并通过在抱怨模式下运行应用程序来帮助你微调它。这些工具会跟踪你的应用程序活动以及 AppArmor 警告，并创建相应的配置文件。这种方法可行，但感觉有些笨拙。

我最喜欢的工具是 **bane**，它基于更简单的 TOML 语法从一个更简洁的配置文件语言生成 AppArmor 配置文件。Bane 配置文件非常易读且易于理解。以下是一个示例 bane 配置文件：

```toml
# 配置文件名，我们将自动添加 `docker-` 前缀
# 所以最终的配置文件名将是 `docker-nginx-sample`
Name = "nginx-sample"

[Filesystem]
# 容器的只读路径
ReadOnlyPaths = [
  "/bin/**",
  "/boot/**",
  "/dev/**",
  "/etc/**",
  "/home/**",
  "/lib/**",
  "/lib64/**",
  "/media/**",
  "/mnt/**",
  "/opt/**",
  "/proc/**",
  "/root/**",
  "/sbin/**",
  "/srv/**",
  "/tmp/**",
  "/sys/**",
  "/usr/**",
]

# 希望在写入时记录日志的路径
LogOnWritePaths = [
  "/**"
]

# 可以写入的路径
WritablePaths = [
  "/var/run/nginx.pid"
]

# 容器允许的可执行文件
AllowExec = [
  "/usr/sbin/nginx"
]

# 禁止的可执行文件
DenyExec = [
  "/bin/dash",
  "/bin/sh",
  "/usr/bin/top"
]

# 允许的能力
[Capabilities]
Allow = [
  "chown",
  "dac_override",
  "setuid",
  "setgid",
  "net_bind_service"
]

[Network]
# 如果不需要在容器中执行 ping 操作，可能可以
# 将 Raw 设置为 false 并拒绝原始网络
Raw = false
Packet = false
Protocols = [
  "tcp",
  "udp",
  "icmp"
]
```

生成的 AppArmor 配置文件相当复杂（冗长且复杂）。

你可以在此找到有关 bane 的更多信息：https://github.com/genuinetools/bane。

### Pod 安全准入

Pod 安全准入（Pod Security Admission）是一个准入控制器，负责管理 Pod 安全标准（https://kubernetes.io/docs/concepts/security/pod-security-standards/）。Pod 安全限制在命名空间级别应用。目标命名空间中的所有 Pod 都将检查相同的安全配置文件（特权、基线或受限）。

请注意，Pod 安全准入不会设置相关的安全上下文。它仅验证 Pod 是否符合目标策略。

有三种模式：

- **enforce**（强制执行）：策略违规将导致 Pod 被拒绝。
- **audit**（审计）：策略违规将导致在审核日志记录的事件中添加审计注解，但 Pod 仍然被允许。
- **warn**（警告）：策略违规将触发对用户的警告，但 Pod 仍然被允许。

要在命名空间上激活 Pod 安全准入，只需向目标命名空间添加一个标签：

```bash
$ MODE=warn  # enforce、audit 或 warn 之一
$ LEVEL=baseline  # privileged、baseline 或 restricted 之一
$ kubectl label namespace/ns-1 pod-security.kubernetes.io/${MODE}: ${LEVEL}
namespace/ns-1 created
```

### 管理网络策略

节点、Pod 和容器安全是强制性的，但这还不够。网络分段对于设计允许多租户的安全 Kubernetes 集群至关重要，同时也能最小化安全漏洞的影响。纵深防御要求你将系统中不需要相互通信的部分进行分区，同时仔细管理网络流量的方向、协议和端口。

网络策略允许对你集群进行细粒度的控制和适当的网络分段。核心上，网络策略是一组应用于由标签选择的命名空间和 Pod 集合的防火墙规则。这非常灵活，因为标签可以定义虚拟网络段，并在 Kubernetes 资源级别进行管理。

与尝试使用传统方法（如 IP 地址范围和子网掩码）来分段网络相比，这是一个巨大的改进。在传统方法中，你经常会耗尽 IP 地址，或者以防万一分配了太多 IP 地址。

但是，如果你使用服务网格，则可能不需要使用网络策略，因为服务网格可以承担相同的角色。更多关于服务网格的内容，将在后面的第 14 章《利用服务网格》中介绍。

**选择支持的网络解决方案**

某些网络后端（网络插件）不支持网络策略。例如，流行的 Flannel 不能用于应用策略。这一点至关重要。即使你的网络插件不支持网络策略，你仍然能够定义网络策略。你的策略将完全不起作用，给你一种虚假的安全感。以下是支持网络策略（入口和出口）的网络插件列表：

- Calico
- WeaveNet
- Canal
- Cilium
- Kube-Router
- Romana
- Contiv

如果你在托管的 Kubernetes 服务上运行集群，那么选择已经为你做好了，尽管你也可以在某些托管的 Kubernetes 产品上安装自定义 CNI 插件。

我们将在第 10 章《探索 Kubernetes 网络》中深入探讨网络插件的来龙去脉。这里我们专注于网络策略。

**定义网络策略**

你使用标准 YAML 清单定义网络策略。支持的协议是 TCP、UDP 和 SCTP（自 Kubernetes 1.20 起）。

以下是一个示例策略：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: the-network-policy
  namespace: default
spec:
  podSelector:
    matchLabels:
      role: db
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          project: cool-project
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 6379
```

`spec` 部分有两个重要部分：`podSelector` 和 `ingress`。`podSelector` 控制此网络策略适用于哪些 Pod。`ingress` 控制哪些命名空间和 Pod 可以访问这些 Pod，以及它们可以使用哪些协议和端口。

在上面的示例网络策略中，Pod 选择器指定了网络策略的目标是标记为 `role: db` 的所有 Pod。`ingress` 部分有一个 `from` 子部分，其中包含一个名称空间选择器和一个 Pod 选择器。集群中所有标记为 `project: cool-project` 的名称空间，以及这些名称空间内所有标记为 `role: frontend` 的 Pod，都可以访问标记为 `role: db` 的目标 Pod。`ports` 部分定义了一系列（协议和端口）对，进一步限制允许的协议和端口。在这个例子中，协议是 TCP，端口是 6379（标准的 Redis 端口）。如果你想针对一个端口范围，可以使用 `endPort`，如下所示：

```yaml
ports:
- protocol: TCP
  port: 6379
  endPort: 7000
```

请注意，网络策略是集群范围的，因此来自集群中多个命名空间的 Pod 可以访问目标命名空间。当前命名空间始终被包含在内，因此即使它没有 `project:cool` 标签，具有 `role:frontend` 的 Pod 仍然可以访问。

理解网络策略以白名单方式运行这一点很重要。默认情况下，所有访问都被禁止，网络策略可以针对匹配标签的某些 Pod 开放某些协议和端口。但是，网络策略的白名单性质仅适用于至少被一个网络策略选中的 Pod。如果一个 Pod 未被选中，它将允许所有访问。始终确保你所有的 Pod 都被网络策略覆盖。

白名单性质的另一个含义是，如果存在多个网络策略，则应用所有规则的统一效果。如果一个策略允许访问端口 1234，另一个策略允许同一组 Pod 访问端口 5678，那么 Pod 可以通过 1234 或 5678 被访问。

要负责任地使用网络策略，请考虑从拒绝所有网络策略开始：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

然后，开始添加网络策略以显式允许特定 Pod 的入口。请注意，你必须为每个命名空间应用拒绝所有策略：

```bash
$ k create -n ${NAMESPACE} -f deny-all-network-policy.yaml
```

**限制到外部网络的出口**

Kubernetes 1.8 添加了出口网络策略支持，因此你也可以控制出站流量。以下是一个阻止访问外部 IP 1.2.3.4 的示例。`order: 999` 确保该策略在其他策略之前应用：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
spec:
  order: 999
  egress:
  - action: deny
    destination:
      net: 1.2.3.4
    source: {}
```

**跨命名空间策略**

如果你将集群划分为多个命名空间，有时让 Pod 能够跨命名空间通信会很方便。你可以在网络策略中指定 `ingress.namespaceSelector` 字段，以允许来自多个命名空间的访问。例如，如果你有生产命名空间和预发布命名空间，并且你定期用生产数据的快照填充预发布环境，这将非常有用。

**网络策略的成本**

网络策略不是免费的。你的 CNI 插件可能会在集群和每个节点上安装额外的组件。这些组件使用宝贵的资源，此外还可能导致你的 Pod 因容量不足而被驱逐。例如，Calico CNI 插件会在 `kube-system` 命名空间中安装多个部署：

```bash
$ k get deploy -n kube-system -o name | grep calico
deployment.apps/calico-node-vertical-autoscaler
deployment.apps/calico-typha
deployment.apps/calico-typha-horizontal-autoscaler
deployment.apps/calico-typha-vertical-autoscaler
```

它还会配置一个 DaemonSet，在每个节点上运行一个 Pod：

```bash
$ k get ds -n kube-system -o name | grep calico-node
daemonset.apps/calico-node
```

### 使用 Secret

Secret 在安全系统中至关重要。它们可以是诸如用户名和密码、访问 token、API 密钥、证书或加密密钥等凭据。Secret 通常很小。如果你有大量数据需要保护，你应该将其加密，并将加密/解密密钥作为 Secret 保存。

**在 Kubernetes 中存储 Secret**

Kubernetes 过去默认以明文形式将 Secret 存储在 etcd 中。这意味着对 etcd 的直接访问应受到限制并仔细保护。从 Kubernetes 1.7 开始，你现在可以在静态时（当它们由 etcd 存储时）加密你的 Secret。

Secret 在命名空间级别进行管理。Pod 可以通过 Secret 卷（作为文件）或环境变量来挂载 Secret。从安全角度来看，这意味着任何可以在命名空间中创建 Pod 的用户或服务都可以访问为该命名空间管理的任何 Secret。如果你想限制对某个 Secret 的访问，请将其放在只有有限用户或服务才能访问的命名空间中。

当 Secret 被挂载到容器中时，它永远不会写入磁盘。它存储在 tmpfs 中。当 kubelet 与 API 服务器通信时，它通常使用 TLS，因此 Secret 在传输过程中受到保护。

Kubernetes Secret 限制为 1 MB。

**配置静态加密**

你需要在启动 API 服务器时传递此参数：`--encryption-provider-config`。

以下是一个示例加密配置：

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
    - secrets
    providers:
    - identity: {}
    - aesgcm:
        keys:
        - name: key1
          secret: c2VjcmV0IGlzIHNlY3VyZQ==
        - name: key2
          secret: dGhpcyBpcyBwYXNzd29yZA==
    - aescbc:
        keys:
        - name: key1
          secret: c2VjcmV0IGlzIHNlY3VyZQ==
        - name: key2
          secret: dGhpcyBpcyBwYXNzd29yZA==
    - secretbox:
        keys:
        - name: key1
          secret: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=
```

**创建 Secret**

Secret 必须在尝试创建需要它们的 Pod 之前创建完毕。Secret 必须存在；否则，Pod 创建将失败。

你可以使用以下命令创建 Secret：`kubectl create secret`。

这里我创建了一个名为 `hush-hush` 的通用 Secret，包含两个键：用户名和密码：

```bash
$ k create secret generic hush-hush \
  --from-literal=username=tobias \
  --from-literal=password=cutoffs
secret/hush-hush created
```

生成的 Secret 是不透明的：

```bash
$ k describe secrets/hush-hush
Name:         hush-hush
Namespace:    default
Labels:       <none>
Annotations:  <none>
Type:         Opaque

Data
====
password:  7 bytes
username:  6 bytes
```

你可以使用 `--from-file` 代替 `--from-literal` 从文件创建 Secret，如果你将 Secret 值编码为 base64，也可以手动创建 Secret。

Secret 内部的键名必须遵循 DNS 子域名的规则（不带前导点）。

**解码 Secret**

要获取 Secret 的内容，可以使用 `kubectl get secret`：

```bash
$ k get secrets/hush-hush -o yaml
apiVersion: v1
data:
  password: Y3V0b2Zmcw==
  username: dG9iaWFz
kind: Secret
metadata:
  creationTimestamp: "2022-06-20T19:49:56Z"
  name: hush-hush
  namespace: default
  resourceVersion: "51831"
  uid: 93e8d6d1-4c7f-4868-b146-32d1eb02b0a6
type: Opaque
```

这些值是 base64 编码的。你需要自己解码：

```bash
$ k get secrets/hush-hush -o jsonpath='{.data.password}' | base64 --decode
cutoffs
```

**在容器中使用 Secret**

容器可以通过从 Pod 挂载卷来以文件形式访问 Secret。另一种方法是将 Secret 作为环境变量访问。最后，容器（前提是其服务账户具有权限）可以直接访问 Kubernetes API 或使用 `kubectl get secret`。

要使用挂载为卷的 Secret，Pod 清单应声明该卷，并将其挂载到容器规范中：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pod-with-secret
spec:
  containers:
  - name: container-with-secret
    image: g1g1/py-kube:0.3
    command: ["/bin/bash", "-c", "while true ; do sleep 10 ; done"]
    volumeMounts:
    - name: secret-volume
      mountPath: "/mnt/hush-hush"
      readOnly: true
  volumes:
  - name: secret-volume
    secret:
      secretName: hush-hush
```

卷名（`secret-volume`）将 Pod 卷与容器中的挂载点绑定。多个容器可以挂载同一个卷。当这个 Pod 运行时，用户名和密码以文件形式存在于 `/etc/hush-hush` 下：

```bash
$ k create -f pod-with-secret.yaml
pod/pod-with-secret created
$ k exec pod-with-secret -- cat /mnt/hush-hush/username
tobias
$ k exec pod-with-secret -- cat /mnt/hush-hush/password
cutoffs
```

**使用 Vault 管理 Secret**

Kubernetes Secret 是在 Kubernetes 上存储和管理敏感数据的一个良好基础。然而，在 etcd 中存储加密数据只是工业级机密管理解决方案的冰山一角。这就是 Vault 的用武之地。

Vault 是一个基于身份的来源机密管理系统，由 HashiCorp 自 2015 年起开发。Vault 被认为是同类最佳方案，实际上没有任何重要的非专有竞争对手。它公开了 HTTP API、CLI 和 UI 来管理你的 Secret。Vault 是一个成熟且久经考验的解决方案，被大量企业组织以及较小的公司使用。Vault 具有定义良好的安全模型和威胁模型，涵盖了广泛的领域。实际上，只要你能够确保 Vault 部署的物理安全，Vault 将保证你的 Secret 安全，并使其易于管理和审计。

在 Kubernetes 上运行 Vault 时，还有其他一些重要措施需要确保 Vault 安全模型保持完整，例如：

- 多租户集群的注意事项（单个 Vault 将被所有租户共享）
- 端到端 TLS（Kubernetes 在某些条件下可能跳过 TLS）
- 关闭进程核心转储以避免泄露 Vault 加密密钥
- 确保启用 mlock，以避免将内存交换到磁盘并泄露 Vault 加密密钥
- 容器超级管理器和 Pod 应以非 root 用户运行

你可以在此找到关于 Vault 的大量信息：https://www.vaultproject.io/。
部署和配置 Vault 非常简单。如果你想尝试一下，请按照本教程操作：https://learn.hashicorp.com/tutorials/vault/kubernetes-minikube-raft。

## 运行多租户集群

在本节中，我们将简要探讨使用单个集群为多个用户或多个用户社区托管系统的选项（也称为多租户）。其理念是，这些用户完全隔离，甚至可能不知道他们与其他人共享同一个集群。

每个用户社区将拥有自己的资源，并且它们之间不会有通信（可能通过公共端点除外）。Kubernetes 的命名空间概念是这个想法的终极体现。但是，它们并不提供绝对的隔离。另一种解决方案是使用虚拟集群，其中每个命名空间对用户来说就像一个完全独立的集群。

请访问 https://www.vcluster.com/ 了解关于虚拟集群的更多详细信息。

### 多租户集群的案例

为什么你应该为多个隔离的用户或部署运行单个集群？为每个用户设置专用集群不是更简单吗？有两个主要原因：成本和运维复杂性。

如果你有许多相对较小的部署，并且想为每个部署创建一个专用集群，那么你将需要为每个部署配备一个单独的控制平面节点，以及可能一个三节点 etcd 集群。成本会不断增加。运维复杂性也非常重要。管理数十、数百或数千个独立的集群绝非易事。每次升级和每个补丁都需要应用于每个集群。操作可能会失败，你将不得不管理一个集群群，其中一些集群的状态与其他集群略有不同。跨所有集群的元操作可能更加困难。你将不得不汇总并编写工具来执行操作并收集来自所有集群的数据。

让我们看看多个隔离社区或部署的一些用例和需求：

- 软件即服务的平台或服务提供商
- 管理独立的测试、预发布和生产环境
- 将责任委派给社区/部署管理员
- 对每个社区强制执行资源配额和限制
- 用户只能看到其社区中的资源

### 使用命名空间实现安全的多租户

Kubernetes 命名空间是实现安全多租户集群的良好起点。这并不奇怪，因为这是命名空间的设计目标之一。

除了内置的 `kube-system` 和 `default` 之外，你可以轻松创建命名空间。以下是一个 YAML 文件，它将创建一个名为 `custom-namespace` 的新命名空间。它只有一个名为 `name` 的元数据项。没有比这更简单的了：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: custom-namespace
```

让我们创建命名空间：

```bash
$ k create -f custom-namespace.yaml
namespace/custom-namespace created
$ k get ns
NAME               STATUS   AGE
custom-namespace   Active   5s
default            Active   24h
kube-node-lease    Active   24h
kube-public        Active   24h
kube-system        Active   24h
```

我们可以看到默认命名空间、我们新建的 `custom-namespace`，以及一些以 `kube-` 为前缀的其他系统命名空间。

`status` 字段可以是 `Active` 或 `Terminating`。当你删除命名空间时，它将进入 `Terminating` 状态。当命名空间处于此状态时，你将无法在此命名空间中创建新资源。这简化了命名空间资源的清理，并确保命名空间被真正删除。没有它，当现有 Pod 被删除时，ReplicationController 可能会创建新的 Pod。

有时，命名空间在终止过程中可能会挂起。我编写了一个小的 Go 工具，名为 `k8s-namespace-deleter`，用于删除顽固的命名空间。请在此查看：https://github.com/the-gigi/k8s-namespace-deleter。它也可以用作 kubectl 插件。

要使用命名空间，你可以在 `kubectl` 命令中添加 `--namespace`（或简写 `-n`）参数。

以下是如何在 `custom-namespace` 命名空间中交互式运行 Pod：

```bash
$ k run trouble -it -n custom-namespace --image=g1g1/py-kube:0.3 bash
If you don't see a command prompt, try pressing enter.
root@trouble:/#
```

列出 `custom-namespace` 中的 Pod 只返回我们刚刚启动的 Pod：

```bash
$ k get po -n custom-namespace
NAME     READY   STATUS    RESTARTS   AGE
trouble  1/1     Running   1 (15s ago)   57s
```

**避免命名空间陷阱**

命名空间很棒，但它们会增加一些摩擦。当你只使用默认命名空间时，你可以简单地省略命名空间。当使用多个命名空间时，你必须用命名空间限定所有内容。这可能会增加一些负担，但不会带来任何危险。

但是，如果某些用户（例如，集群管理员）可以访问多个命名空间，那么你可能会意外修改或查询错误的命名空间。避免这种情况的最佳方法是密闭地封装命名空间，并要求每个命名空间使用不同的用户和凭据，就像你应该对计算机或远程机器上的大多数操作使用用户帐户，只有在必要时才使用 `root` 通过 `sudo` 操作一样。

此外，你应该使用有助于明确你正在操作哪个命名空间的工具（例如，如果在命令行工作则显示 shell 提示符，或在 Web 界面中突出显示命名空间）。最流行的工具之一是 `kubens`（与 `kubectx` 一起提供），可在 https://github.com/ahmetb/kubectx 获取。

确保可以在专用命名空间上操作的用户无权访问默认命名空间。否则，每次他们忘记指定命名空间时，都会安静地对默认命名空间进行操作。

### 使用虚拟集群实现强多租户

命名空间固然不错，但它们并不能真正满足强多租户的要求。命名空间隔离显然只适用于命名空间资源。但是，Kubernetes 有许多集群级别资源（特别是 CRD）。租户将共享这些资源。此外，控制平面版本、安全和审计也将是共享的。

一个简单的解决方案是不使用多租户。只需为每个租户设置一个单独的集群即可。但这效率不高，尤其是有很多小租户时。

来自 Loft.sh 的 vcluster 项目（https://www.vcluster.com）采用了一种创新方法，其中一个物理 Kubernetes 集群可以托管多个虚拟集群，这些虚拟集群对其用户来说显示为常规 Kubernetes 集群，与其他虚拟集群和宿主集群完全隔离。这实现了多租户的所有好处，而没有命名空间级别隔离的缺点。

以下是 vcluster 的架构：

![图 4.3: vcluster 架构](images/ch04-fig03.png)

让我们创建几个虚拟集群。首先安装 vcluster CLI：https://www.vcluster.com/docs/getting-started/setup。

确保它正确安装：

```bash
$ vcluster version
vcluster version 0.10.1
```

现在，我们可以创建一些虚拟集群。你可以使用 vcluster CLI、Helm 或 kubectl 创建虚拟集群。让我们使用 vcluster CLI。

```bash
$ vcluster create tenant-1
info    Creating namespace vcluster-tenant-1
info    Detected local kubernetes cluster kind. Will deploy vcluster with a NodePort
info    Create vcluster tenant-1...
done  Successfully created virtual cluster tenant-1 in namespace vcluster-tenant-1
info    Waiting for vcluster to come up...
warn    vcluster is waiting, because vcluster pod tenant-1-0 has status: ContainerCreating
info    Starting proxy container...
done  Switched active kube context to vcluster_tenant-1_vcluster-tenant-1_kind-kind
- Use `vcluster disconnect` to return to your previous kube context
- Use `kubectl get namespaces` to access the vcluster
```

让我们创建另一个虚拟集群：

```bash
$ vcluster create tenant-2
? You are creating a vcluster inside another vcluster, is this desired?
  [Use arrows to move, enter to select, type to filter]
> No, switch back to context kind-kind
  Yes
```

哎呀。创建 `tenant-1` 虚拟集群后，Kubernetes 上下文切换到了这个集群。当我尝试创建 `tenant-2` 时，vcluster CLI 足够智能地发出了警告。让我们再试一次：

```bash
$ k config use-context kind-kind
Switched to context "kind-kind".
$ vcluster create tenant-2
info    Creating namespace vcluster-tenant-2
info    Detected local kubernetes cluster kind. Will deploy vcluster with a NodePort
info    Create vcluster tenant-2...
done  Successfully created virtual cluster tenant-2 in namespace vcluster-tenant-2
info    Waiting for vcluster to come up...
info    Stopping docker proxy...
info    Starting proxy container...
done  Switched active kube context to vcluster_tenant-2_vcluster-tenant-2_kind-kind
- Use `vcluster disconnect` to return to your previous kube context
- Use `kubectl get namespaces` to access the vcluster
```

让我们检查我们的集群：

```bash
$ k config get-contexts -o name
kind-kind
vcluster_tenant-1_vcluster-tenant-1_kind-kind
vcluster_tenant-2_vcluster-tenant-2_kind-kind
```

是的，我们的两个虚拟集群可用。让我们看看宿主 kind 集群中的命名空间：

```bash
$ k get ns --context kind-kind
NAME               STATUS   AGE
custom-namespace   Active   3h6m
default            Active   27h
kube-node-lease    Active   27h
kube-public        Active   27h
kube-system        Active   27h
local-path-storage Active   27h
vcluster-tenant-1  Active   15m
vcluster-tenant-2  Active   3m48s
```

我们可以看到虚拟集群的两个新命名空间。让我们看看 `vcluster-tenant-1` 命名空间中运行了什么：

```bash
$ k get all -n vcluster-tenant-1 --context kind-kind
NAME                                                          READY   STATUS    RESTARTS   AGE
pod/coredns-5df468b6b7-rj4nr-x-kube-system-x-tenant-1        1/1     Running   0          16m
pod/tenant-1-0                                                2/2     Running   0          16m

NAME                                            TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)                  AGE
service/kube-dns-x-kube-system-x-tenant-1       ClusterIP   10.96.200.106   <none>        53/UDP,53/TCP,9153/TCP   16m
service/tenant-1                                NodePort    10.96.107.216   <none>        443:32746/TCP            16m
service/tenant-1-headless                       ClusterIP   None            <none>        443/TCP                  16m
service/tenant-1-node-kind-control-plane        ClusterIP   10.96.235.53    <none>        10250/TCP                16m

NAME                                       READY   AGE
statefulset.apps/tenant-1                  1/1     16m
```

现在，让我们看看虚拟集群中有哪些命名空间：

```bash
$ k get ns --context vcluster_tenant-1_vcluster-tenant-1_kind-kind
NAME              STATUS   AGE
kube-system       Active   17m
default           Active   17m
kube-public       Active   17m
kube-node-lease   Active   17m
```

只有 k3s 集群的默认命名空间（vcluster 基于 k3s）。让我们创建一个新命名空间，并验证它只出现在虚拟集群中：

```bash
$ k create ns new-ns --context vcluster_tenant-1_vcluster-tenant-1_kind-kind
namespace/new-ns created

$ k get ns new-ns --context vcluster_tenant-1_vcluster-tenant-1_kind-kind
NAME    STATUS   AGE
new-ns  Active   19s

$ k get ns new-ns --context vcluster_tenant-2_vcluster-tenant-2_kind-kind
Error from server (NotFound): namespaces "new-ns" not found

$ k get ns new-ns --context kind-kind
Error from server (NotFound): namespaces "new-ns" not found
```

正如预期的那样，新的命名空间只在其创建的虚拟集群中可见。

在本节中，我们介绍了多租户集群、它们为何有用，以及隔离租户的不同方法，例如命名空间和虚拟集群。

## 总结

在本章中，我们涵盖了在 Kubernetes 集群上构建系统和部署应用的开发者和管理员面临的众多安全挑战。但我们也探讨了众多的安全特性以及灵活的基于插件的安全模型，这些提供了许多限制、控制和管理容器、Pod 和节点的方法。Kubernetes 已经为大多数安全挑战提供了通用的解决方案，并且随着 AppArmor 和各种插件从 Alpha/Beta 状态过渡到正式可用，它只会变得更好。最后，我们考虑了如何使用命名空间和虚拟集群在同一 Kubernetes 集群中支持多租户社区或部署。

在下一章中，我们将详细探讨许多 Kubernetes 资源和概念，以及如何有效使用和组合它们。Kubernetes 对象模型建立在少数通用概念（如资源、清单和元数据）的坚实基础上。这使得一个可扩展且惊人一致的对象模型能够为开发者和管理员提供极其多样化的功能集。

加入我们的 Discord！
与本书的其他读者、云专家、作者和志同道合的专业人士一起阅读本书。提问、为其他读者提供解决方案、通过"问我任何问题"环节与作者聊天，等等。
扫描二维码或访问链接立即加入社区。
https://packt.link/cloudanddevops
