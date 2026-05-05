# 17: 实际 Kubernetes 安全

前一章向你展示了如何使用 STRIDE 模型对 Kubernetes 进行威胁建模。在本章中，你将学习在实际实施 Kubernetes 时可能遇到的安全相关挑战。

本章的目标是从安全架构师所具备的高层视角向你展示事物。它不会提供菜谱式的解决方案。

本章分为以下四个部分：

- 软件交付管道中的安全
- 工作负载隔离
- 身份与访问管理
- 安全监控与审计

## 软件交付管道中的安全

容器彻底改变了我们构建、交付和运行应用程序的方式。不幸的是，这也使得运行危险代码变得比以往任何时候都更容易。

让我们看看一些保护供应链的方法，这些方法将应用程序代码从开发者的笔记本电脑传送到生产服务器。

### 镜像仓库

我们将镜像存储在公共和私有注册表中，并进一步划分为仓库。

公共注册表位于互联网上，是推送和拉取镜像最简单的方式。然而，在使用它们时应非常谨慎：

1. 你需要充分保护存储在公共注册表中的镜像
2. 你不应信任从公共注册表拉取的镜像

一些公共注册表具有官方镜像和社区镜像的概念。作为一般规则，官方镜像比社区镜像更安全，但你始终应自行尽职调查。

官方镜像通常由产品供应商提供，并经过严格的审查过程以确保质量。你应该期望它们实施良好的实践，定期扫描漏洞，并包含最新的补丁和修复。其中一些甚至可能由产品供应商或托管注册表的公司提供支持。

社区镜像未经严格审查，在使用时应极度谨慎。

考虑到这些要点，你应该为开发者获取和使用镜像实现标准化的方式。同时，应尽可能使流程无摩擦，以免开发者感到需要绕过该流程。

让我们讨论一些可能有帮助的事项。

#### 使用经批准的基础镜像

大多数镜像从基础层开始，然后添加其他层以形成有用的镜像。

图 17.1 展示了一个过度简化的三层镜像示例。基础层包含核心操作系统和文件系统组件，中间层包含库和依赖项，顶层包含你的应用程序。这三者的组合构成了镜像，并包含运行应用程序所需的一切。

**图 17.1 - 镜像分层**
> [!info] 图 17.1 说明（原文插图）
> 图中显示一个矩形代表整个镜像，从上到下分为三个层：顶层（你的应用）、中间层（库/依赖）、底层（核心OS/文件系统）。没有提供具体图形，此处保留文字描述。

维持少量经批准的基础镜像通常是一个好的实践。这些镜像通常源自官方镜像，并根据你的公司政策和要求进行加固。例如，你可以基于官方的 Alpine Linux 镜像创建有限数量的经过批准的基础镜像，并根据你的需求（补丁、驱动程序、审计设置等）进行调整。

图 17.2 展示了两个经批准的基础镜像之上构建的三个应用。左侧的应用构建在你批准的 Alpine Linux 基础镜像之上，而其他两个 Web 应用程序构建在你批准的 Alpine+NGINX 基础镜像之上。

**图 17.2 - 使用经批准的基础镜像**
> [!info] 图 17.2 说明（原文插图）
> 图中显示左侧应用建立在 Alpine 基础镜像上；中间和右侧应用建立在 Alpine+NGINX 基础镜像上。没有提供具体图形，此处保留文字描述。

虽然你需要投入前期工作来创建经批准的基础镜像，但它们带来了以下所有好处：

- 标准驱动程序集
- 已知补丁
- 标准审计设置
- 减少软件蔓延（更少的非官方基础镜像）
- 简化测试（针对少量已知基础进行测试）
- 简化更新（要修补的基础镜像更少）
- 简化故障排除（数量有限且熟悉的基础镜像集）

拥有经批准的基础镜像集还能让开发者专注于应用程序，而无需关心操作系统相关的事情。这还可能减少你必须打交道的支持合同和供应商数量。

#### 管理对非标准基础镜像的需求

尽管拥有少量经批准的基础镜像很好，但你仍可能有对定制配置的合理需求。在这些情况下，你需要良好的流程来：

- 确定为什么不能使用现有的经批准基础镜像
- 确定是否可以更新现有的经批准基础镜像以满足需求（包括是否值得付出努力）
- 确定将全新镜像引入环境所带来的支持影响

在大多数情况下，你更希望更新现有的基础镜像（例如添加 GPU 计算的设备驱动程序），而不是引入全新的镜像。

#### 控制对镜像的访问

有几种方法可以保护你组织的镜像。

一个安全且实用的选项是在你自己的防火墙内托管私有注册表。这允许你控制注册表的部署方式、复制方式和修补方式。你还可以创建符合组织需求的仓库和策略，并将其与现有身份管理提供商（如 Active Directory）集成。

如果你无法管理自己的私有注册表，你可以在公共注册表上以私有仓库的形式托管镜像。然而，并非所有公共注册表都相同，你需要非常小心地选择合适的注册表并正确配置它。

无论选择哪种解决方案，你应该只托管经批准在组织内使用的镜像。这些镜像通常来自可信来源，并由你的信息安全团队审查。你应该对仓库设置访问控制，以便只有经批准的用户才能推送和拉取它们。

除了注册表本身，你还应该：

- 限制哪些集群节点具有互联网访问权限，同时记住你的镜像注册表可能位于互联网上
- 配置访问控制，只允许授权用户和节点向仓库推送

如果你使用公共注册表，你可能需要授予集群节点访问互联网的权限，以便它们能够拉取镜像。在这种情况下，一个良好的实践是将互联网访问限制在注册表使用的地址和端口上。

你还应该在注册表上实施严格的 RBAC 规则，以控制谁可以从哪些仓库推送和拉取镜像。例如，你可能限制开发者只能针对开发和测试仓库进行推送和拉取，而允许运维团队针对生产仓库进行推送和拉取。

最后，你可能只希望一部分节点（构建节点）能够推送镜像。你甚至可能进一步锁定，只让自动化构建系统能够推送到特定仓库。

#### 将镜像从非生产环境提升到生产环境

许多组织拥有独立的开发、测试和生产环境。

作为一般规则，开发环境规则较少，是开发者可以进行实验的地方。这可能涉及开发者最终希望在生产中使用的非标准镜像。

以下部分概述了一些措施，你可以采取这些措施确保只有安全的镜像才能被批准用于生产。

##### 漏洞扫描

在允许镜像进入生产环境之前，审查镜像列表的首项应该是漏洞扫描。这些服务在二进制级别扫描你的镜像，并将其内容与已知安全漏洞数据库（CVE）进行比对。

你应该将漏洞扫描集成到 CI/CD 管道中，并实施策略，自动使包含特定类别漏洞的镜像构建失败并将其隔离。例如，你可以实现一个构建阶段，扫描镜像并自动使任何使用已知严重漏洞镜像的构建失败。

然而，一些扫描解决方案比其他方案更好，允许你创建高度可定制的策略。

例如，一个执行 TLS 验证的 Python 方法可能在 Common Name 包含大量通配符时容易受到拒绝服务攻击。但是，如果你从未以这种方式使用 Python，你可能认为该漏洞不相关，并希望将其标记为误报。并非所有扫描解决方案都允许你这样做。

##### 配置即代码

扫描应用程序代码以查找漏洞被广泛认为是良好的生产规范。然而，扫描你的 Dockerfile、Kubernetes YAML 文件、Helm chart 和其他配置文件的普及程度较低。

一个广为人知的未审查配置文件的例子是，IBM 的一个数据科学实验在其容器镜像中嵌入了私有 TLS 密钥。这意味着攻击者可以拉取镜像并获得托管容器的节点的 root 访问权限。如果他们对其 Dockerfile 进行了安全审查，整个情况本可以轻松避免。

自动化此类检查的工具（实现策略即代码规则）方面持续取得进展。

##### 对容器镜像进行签名

信任在今天的世界中至关重要，而在软件交付管道的每个阶段对内容进行加密签名正成为常态。幸运的是，Kubernetes 和大多数容器运行时都支持对镜像进行加密签名和验证。

在此模型中，开发者对他们的镜像进行加密签名，而消费者在拉取并运行镜像时对其进行加密验证。这使消费者确信他们使用的是正确的镜像，且镜像未被篡改。

图 17.3 展示了签名和验证镜像的高级流程。

**图 17.3 - 镜像签名与验证流程**
> [!info] 图 17.3 说明（原文插图）
> 图中显示两个主要角色：开发者（签名者）和消费者（验证者）。开发者推送镜像到注册表前进行签名；消费者从注册表拉取镜像后进行验证。流程通常由容器运行时实现。没有提供具体图形，此处保留文字描述。

镜像签名和验证通常由容器运行时实现。

你应该寻找允许你定义并强制执行企业级签名策略的工具，这样就不必由各个用户自行决定。

#### 镜像提升工作流

综合到目前为止讨论的所有内容，你的构建管道应尽可能包含以下步骤：

1. 强制使用已签名镜像的策略
2. 限制哪些节点可以推送和拉取镜像的网络规则
3. 保护镜像仓库的 RBAC 规则
4. 使用经批准的基础镜像
5. 对已知漏洞进行镜像扫描
6. 根据扫描结果提升和隔离镜像
7. 审查和扫描基础设施即代码配置文件

还有更多可以做的事情，而且该列表并不代表一个确切的工作流程。

## 工作负载隔离

本节将向你展示一些隔离工作负载的方法。

我们将从集群级别开始，然后转到运行时级别，最后跳出集群看基础设施（如网络防火墙）。

### 集群级工作负载隔离

开门见山，Kubernetes 不支持安全的多租户集群。隔离两个工作负载的唯一方法是在各自的集群上运行它们，并配备各自的硬件。

让我们仔细观察一下。

划分 Kubernetes 集群的唯一方法是创建命名空间。然而，这些命名空间几乎只是一种对资源进行分组并应用诸如以下内容的方式：

- 限制（Limits）
- 配额（Quotas）
- RBAC 规则

命名空间无法阻止一个命名空间中受损的工作负载影响其他命名空间中的工作负载。这意味着你绝不应在同一个 Kubernetes 集群上运行敌对的工作负载。

尽管如此，Kubernetes 命名空间仍然有用，你应该使用它们。只是不要将它们用作安全边界。

#### 命名空间与软多租户

就我们的目的而言，软多租户是指在共享基础设施上托管多个受信任的工作负载。所谓受信任，是指那些不需要绝对保证一个工作负载不会影响另一个工作负载的工作负载。

受信任工作负载的一个例子是电子商务应用程序，它包含一个 Web 前端服务和一个后端推荐服务。由于它们属于同一个应用程序，因此它们并非敌对。但是，你可能希望每个工作负载都有自己的资源限制，并由不同的团队管理。

在这种情况下，一个具有命名空间的单一集群即可满足需求。

# 17: 实际 Kubernetes 安全

## 命名空间与硬多租户

我们将**硬多租户**定义为在共享基础设施上托管不可信的、潜在敌意的工作负载。然而，正如我们之前所说，这在当前 Kubernetes 中尚不可行。

这意味着需要强安全边界的工作负载必须运行在独立的 Kubernetes 集群上！示例包括：
- 隔离生产与非生产工作负载
- 隔离不同客户
- 隔离敏感项目与业务功能

还有其他示例，但核心要点是：需要强隔离的工作负载需要自己的集群。

> [!NOTE] Kubernetes 项目有一个专门的**多租户工作组 (Multitenancy Working Group)** 正在积极研究多租户模型。这意味着未来 Kubernetes 版本可能会为硬多租户提供更好的解决方案。

## 节点隔离

有时应用需要非标准权限，例如以 root 身份运行或执行非标准系统调用。将这些应用隔离到它们自己的集群可能有点过头，但你可能认为将它们运行在受严格限制的工作节点子集上是合理的。这样做可以限制受感染的工作负载仅影响同一节点上的其他工作负载。

你还应通过启用更严格的审计日志和更严格的运行时防御选项，对运行非标准权限工作负载的节点应用纵深防御原则。

Kubernetes 提供了多种技术，如标签（labels）、亲和性与反亲和性规则（affinity and anti-affinity rules）、以及污点（taints），以帮助你针对特定节点调度工作负载。

## 运行时隔离

容器与虚拟机曾经是一个两极分化的话题。然而，在工作负载隔离方面，只有一个赢家……那就是虚拟机。

大多数容器平台实现的是**命名空间容器**。在这种模型中，每个容器共享主机的内核，隔离由内核结构（如命名空间和 cgroups）提供，而这些结构从未被设计为强安全边界。Docker、containerd 和 CRI-O 是实现命名空间容器的流行容器运行时和平台示例。

这与虚拟机管理程序模型截然不同，在虚拟机管理程序模型中，每个虚拟机拥有自己专用的内核，并通过硬件强制机制与其他虚拟机实现强隔离。

然而，现在比以往更容易通过安全相关技术来增强容器，使其更加安全并实现更强的工作负载隔离。这些技术包括 AppArmor、SELinux、seccomp、权限（capabilities）和用户命名空间（user namespaces）。大多数容器运行时和托管的 Kubernetes 服务都能很好地为所有这些技术实现合理的默认值。然而，它们仍然可能很复杂，尤其是在故障排除时。

你还应考虑不同类别的容器运行时。两个例子是 **gVisor** 和 **Kata Containers**，它们都提供了更强的工作负载隔离级别，并且由于容器运行时接口（CRI）和 Runtime Classes（运行时类）的存在，很容易与 Kubernetes 集成。

还有一些项目使 Kubernetes 能够编排其他工作负载类型，例如虚拟机、无服务器函数和 WebAssembly。

虽然其中一些内容可能让你感到不知所措，但在确定工作负载所需的隔离级别时，你需要考虑所有这些因素。

总结来说，存在以下工作负载隔离选项：

1. **虚拟机**：每个工作负载拥有自己专用的内核。提供出色的隔离性，但相对较慢且资源密集。
2. **命名空间容器**：所有容器共享主机的内核。快速且轻量，但需要额外努力来提高工作负载隔离性。
3. **每个容器运行在自己的虚拟机中**：此类解决方案试图通过将每个容器运行在其专用的虚拟机中，来结合容器的多功能性与虚拟机的安全性。尽管使用了专门的轻量级虚拟机，但这些解决方案失去了容器的许多吸引力，并且不太流行。
4. **使用不同的运行时类**：这允许你将所有工作负载作为容器运行，但将需要更强隔离的工作负载定向到适当的容器运行时。
5. **Wasm 容器**：Wasm 容器将 Wasm（WebAssembly）应用打包到 OCI 容器中，这些容器可以在 Kubernetes 上执行。这些应用仅使用容器进行打包和调度，在运行时它们在一个安全的、默认拒绝的 Wasm 主机内执行。有关更多详细信息，请参阅第 9 章。

## 网络隔离

防火墙是任何分层信息安全系统不可或缺的一部分。目标是仅允许授权通信。

在 Kubernetes 中，Pod 通过一个称为 **Pod 网络**的内部网络进行通信。然而，Kubernetes 并不实现 Pod 网络。相反，它实现了一个名为 **容器网络接口 (CNI)** 的插件模型，允许第三方供应商实现 Pod 网络。存在许多 CNI 插件，但它们大致分为两类：

- **覆盖网络 (Overlay)**
- **BGP**

每种对于防火墙实现和网络安全都有不同的影响。

### Kubernetes 与覆盖网络

大多数 Kubernetes 环境将 Pod 网络实现为简单的平面覆盖网络，该网络隐藏了集群节点间的所有网络复杂性。例如，你可能会将集群节点部署在由路由器连接的十个不同网络上，但 Pod 连接到平面的 Pod 网络并进行通信，无需知道主机网络的任何复杂性。图 17.4 显示了分布在两个独立网络上的四个节点，以及连接到单个覆盖 Pod 网络的 Pod。

**图 17.4** *（此处原为图片，描述为：四个节点分布在两个网络上，所有 Pod 通过单个覆盖 Pod 网络连接）*

覆盖网络使用 VXLAN 技术封装流量，以便通过运行在现有第 3 层基础设施之上的简单平面第 2 层网络进行传输。如果这听起来网络术语太多，你只需知道覆盖网络会封装容器发送的数据包。这种封装隐藏了原始源和目标 IP 地址，使得防火墙更难了解正在发生什么。参见图 17.5。

**图 17.5 - 覆盖网络上的封装** *（此处原为图片，描述为：Overlay 网络中对数据包进行封装的过程）*

### Kubernetes 与 BGP

BGP 是为互联网提供动力的协议。然而，其核心是一个简单且可扩展的协议，它创建对等关系，用于共享路由和执行路由。

以下类比可能有所帮助。想象你要给一位失去联系、不再拥有地址的朋友寄生日贺卡。然而，你的孩子在学校有一位朋友，其父母仍与你的老朋友保持联系。在这种情况下，你把贺卡交给孩子，请他们转交给学校的朋友。这位朋友把贺卡交给其父母，然后由他们将贺卡送达你的老朋友。

BGP 路由与此类似，并通过一个对等网络进行，这些对等点相互帮助寻找路由。

从安全角度来看，重要的是 BGP **不**封装数据包。这使得防火墙的工作简单得多。图 17.6 显示了使用 BGP 的相同设置。注意没有封装。

**图 17.6 - BGP 网络上无封装** *（此处原为图片，描述为：BGP 网络中没有封装）*

### 这对防火墙的影响

我们已经说过，防火墙根据源和目标地址允许或拒绝流量流。例如：
- 允许来自 `10.0.0.0/24` 网络的流量
- 拒绝来自 `192.168.0.0/24` 网络的流量

假设你的 Pod 网络是一个覆盖网络。在这种情况下，所有流量都将被封装，只有能够打开数据包并检查其内容的防火墙才能做出允许或拒绝流量的有用决策。如果你的防火墙无法做到这一点，你可能需要考虑使用 BGP Pod 网络。

你还应考虑是否部署物理防火墙、基于主机的防火墙，或两者结合。

**物理防火墙**是专用的网络硬件设备，通常由中央团队管理。**基于主机的防火墙**是操作系统（OS）功能，通常由部署和管理操作系统的团队管理。两种解决方案各有利弊，将两者结合通常是最安全的。然而，你应该考虑你的组织是否对物理防火墙的变更实施有漫长而复杂的流程。如果是这样，这可能不适合你的 Kubernetes 环境。

### 数据包捕获

关于网络和 IP 地址，不仅 Pod IP 地址有时会被封装掩盖，而且它们也是动态的，可以被不同的 Pod 回收和重用。我们称之为 **IP 变化 (IP churn)**，它降低了 IP 地址在标识系统和负载方面的有用性。考虑到这一点，在执行诸如数据包捕获等操作时，能够将 IP 地址与 Kubernetes 特定的标识符（如 Pod ID、Service 别名和容器 ID）关联起来可能非常有用。

让我们换个话题，来看一些控制用户访问 Kubernetes 的方法。

## 身份与访问管理 (IAM)

在生产环境中，控制用户对 Kubernetes 的访问非常重要。幸运的是，Kubernetes 具有强大的 **RBAC** 子系统，可以与现有的 IAM 提供者（如 Active Directory、其他 LDAP 系统和基于云的 IAM 解决方案）集成。

大多数组织已经拥有一个集中的 IAM 提供者，并与公司 HR 系统集成，以简化员工生命周期管理。

幸运的是，Kubernetes 利用现有的 IAM 提供者，而不是实现自己的 IAM。这意味着新员工会在公司 IAM 数据库中拥有一个身份，并且假设你让他们成为适当组的成员，他们将自动获得 Kubernetes 中的权限。同样，当员工离职时，HR 流程将自动从 IAM 数据库中移除其身份，他们对 Kubernetes 的访问也将终止。

RBAC 自 v1.8 起已成为一个稳定的 Kubernetes 功能，你应该充分利用其全部功能。

## 管理对集群节点的远程 SSH 访问

几乎所有 Kubernetes 管理操作都将通过 REST 调用 API 服务器来完成。这意味着用户应该很少需要远程 SSH 访问 Kubernetes 集群节点。实际上，对集群节点的远程 SSH 访问仅应用于以下类型的活动：
- 无法通过 Kubernetes API 执行的节点管理活动
- **“破窗” (Break the Glass)** 活动，例如 API 服务器宕机时
- 深度故障排查

## 多因素认证 (MFA)

能力越大，责任越大。

拥有对 API 服务器 root 访问权限和对集群节点 root 访问权限的账户极其强大，是攻击者和心怀不满员工的主要目标。因此，你应该通过**多因素认证 (MFA)** 来保护它们的使用。这意味着用户必须输入用户名和密码，然后进行第二阶段的认证。例如：
- **阶段 1**：测试用户名和密码的知识
- **阶段 2**：测试对某物的持有，如一次性密码

你还应保护安装了 `kubectl` 的工作站和用户配置文件的安全访问。

## 安全监控与审计

没有系统是 100% 安全的，你应该始终为系统被攻破的可能性做好准备。当攻破发生时，至关重要的是你至少能做两件事：
1. 识别出发生了攻破
2. 构建一份详细的、不可否认的事件时间线

**审计**对这两点都至关重要，构建可靠的时间线有助于回答以下事后问题：
- 发生了什么
- 它是如何发生的
- 它是在何时发生的
- 是谁做的

在极端情况下，这些信息可能会在法庭上被调用。

良好的审计和监控解决方案也有助于识别安全系统中的漏洞。

考虑到这些要点，你应该确保将稳健的审计和监控作为优先事项，并且在没有它们的情况下不要在生产环境中上线。

## 基线最佳实践

有各种工具和检查可以帮助你确保按照最佳实践来配置你的 Kubernetes 环境。*（此处原文结束，但上下文可能延续，但根据要求，我们只能翻译给定的原始文本到此为止。）*

practices and company policies.  
The Center for Information Security (CIS) publishes an industry-standard benchmark for Kubernetes security, and Aqua Security (aquasec.com) has written an easy-to-use tool called [[kube-bench]] to run the CIS tests against your cluster and generate reports. Unfortunately, kube-bench can’t inspect the control plane nodes of hosted Kubernetes services.  
You should consider running kube-bench as part of the node provisioning process and pass or fail node provisioning based on the results.  
You can also use kube-bench reports as a baseline for use in the aftermath of incidents. This allows you to compare the kube-bench reports from before and after the incident and determine if and where any configuration changes occurred.

## 容器和Pod生命周期事件

Pods and containers are ephemeral objects that come and go all the time. This means you’ll see a lot of events announcing new ones and a lot of events announcing terminated ones.  
With this in mind, consider configuring log retention to keep the logs from terminated Pods so they’re available for inspection even after termination.  
Your container runtime may also keep logs relating to container lifecycle events.

## 取证检查点

Forensics is the science of collecting and examining available evidence to construct a trail of events, especially when you suspect malicious behavior.  
The ephemeral nature of containers has made this challenging in the past. However, recent technologies such as [[CRIU|Checkpoint/Restore in Userspace (CRIU)]] are making it easier to silently capture the state of running containers and restore them in a sandbox environment for deeper analysis. At the time of writing, CRIU is an alpha feature in Kubernetes, and the only runtime currently supporting it is [[CRI-O]].

## 应用日志

Application logs are also important when identifying potential security-related issues.  
However, not all applications send their logs to the same place. Some send them to their container’s standard out (stdout) or standard error (stderr) streams where your logging tools can pick them up alongside container logs. However, some send logs to proprietary log files in bespoke locations. Be sure to research this for each application and configure things so you don’t miss logs.

## 用户执行的操作

Most of your Kubernetes configuration and administration will be done via the API server, where all requests should be logged.  
However, it’s also possible for malicious actors to gain remote SSH access to control plane nodes and directly manipulate Kubernetes objects. This may include access to the cluster store and etcd nodes.  
We’ve already said you should limit SSH access to cluster nodes and bolster security with multi-factor authentication (MFA). However, you should also log all SSH activity and ship it to a secure log aggregator. You should also consider mandating that two competent people be present for all SSH access to control plane nodes.

## 管理日志数据

A key advantage of containers is application density — you can run a lot more applications on your servers and in your datacenters. This results in massive amounts of log data and audit data that is overwhelming without specialized tools to sort and make sense of it. Fortunately, advanced tools exist that not only store the data, but can use it for proactive analysis as well as post-event reactive analysis.

## 对安全相关事件发出告警

As well as being useful for post-event analysis and repudiation, some events are significant enough to warrant immediate investigation. Examples include:  
- **Privileged Pod creation by a human user**: Privileged Pods can often gain root-level access on the node, and you will typically have policies in place to prevent their creation. On the rare occasions they are needed, they will usually be created by automated processes with service accounts.  
- **Exec sessions by human users**: Exec sessions grant shell-like access to containers and are typically only used to troubleshoot issues. You should investigate exec sessions that aren’t for troubleshooting and consider deleting them to prevent tampering.  
- **Attempts to access the cluster from the internet**: It’s a common practice to prevent access to the control plane from the internet. As such, you should monitor for successful and unsuccessful attempts to connect to the control plane from the internet, and successful attempts will typically indicate a security misconfiguration you should fix.

## 将现有应用迁移到Kubernetes

It can be useful to use a crawl, walk, then run strategy when migrating applications to Kubernetes:  
1. **Crawl**: Threat modeling your existing apps will help you understand their current security posture. For example, which of your existing apps do and don’t communicate over TLS.  
2. **Walk**: When moving to Kubernetes, ensure the security posture of these apps remains unchanged. For example, if an app doesn’t communicate over TLS, do not change this as part of the migration.  
3. **Run**: Start improving the security of applications after the migration. Start with simple non-critical apps, and carefully work your way up to mission-critical apps. You may also want to methodically deploy deeper levels of security, such as initially configuring apps to communicate over one-way TLS and then eventually over two-way TLS.  

> [!IMPORTANT] 关键要点  
> The key point is not to change the security posture of an app as part of migrating it to Kubernetes. This is because performing a migration and making changes can make it easier to misdiagnose issues — was it the security change or the migration?

## 真实世界的例子

An example of a container-related vulnerability that could’ve easily been prevented by implementing some of the best practices we’ve discussed occurred in February 2019. CVE-2019-5736 allowed a container process running as root to gain root access on the worker node and all containers running on the host.  
As dangerous as the vulnerability was, the following things covered in this chapter would’ve prevented the issue:  
- Image vulnerability scanning  
- Not running processes as root  
- Enabling SELinux  

> [!NOTE]  
> As the vulnerability has a CVE number, scanning tools would’ve found it and alerted on it. Even if scanning platforms missed it, policies that prevent root containers and standard SELinux policies would have prevented exploitation of the vulnerability.

# 17: 实际 Kubernetes 安全

## 章节总结

本章旨在介绍影响众多 Kubernetes 部署的一些实际安全考量。

我们首先探讨了保护软件交付流水线的方法，并讨论了一些与镜像相关的最佳实践。这些实践包括：保护镜像仓库的安全性、扫描镜像中的漏洞，以及使用加密签名和验证镜像。接着，我们审视了基础设施栈不同层级存在的一些工作负载隔离选项。特别地，我们研究了集群级隔离、节点级隔离以及一些不同的运行时隔离选项。我们还讨论了身份与访问管理，包括相关场景……

---

**图片上下文**：

- [第 541 页上的图片 3188]
- [第 542 页上的图片 3190]
- [第 548 页上的图片 3198]
- [第 557 页上的图片 3208]
- [第 557 页上的图片 3209]
- [第 559 页上的图片 3212]