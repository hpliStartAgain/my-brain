# 4：使用 Pod

Kubernetes 上的每个应用都运行在 Pod 内。  
当你部署应用时，你将其部署在 Pod 中；  
当你终止应用时，你终止其 Pod；  
当你扩缩应用时，你添加或移除 Pod；  
当你更新应用时，你部署新的 Pod。  

这使得 Pod 至关重要，也是本章深入探讨的原因。

我将本章分为两个主要部分：
- **Pod 理论**
- **Pod 实践**

如果即将讨论的一些内容让你感觉熟悉，那是因为我们正在构建第 2 章中引入的概念。  
我们还将发现 Kubernetes 使用 Pod 来运行多种不同类型的工作负载。不过，大多数情况下，Pod 运行容器，因此大部分示例将引用容器。

## Pod 理论

Kubernetes 出于许多原因使用 Pod。它们是一个抽象层，支持资源共享，增加功能，增强调度，等等。  
让我们更详细地了解其中一些方面。

### Pod 是一个抽象层

Pod 抽象了工作负载的细节。这意味着你可以在 Pod 内运行容器、虚拟机（VM）、无服务器函数和 WebAssembly（Wasm）应用，而 Kubernetes 无法区分它们。

将 Pod 作为抽象层对 Kubernetes 和工作负载都有好处：
- Kubernetes 可以专注于部署和管理 Pod，而不必关心 Pod 内部是什么。
- 异构工作负载可以在同一集群上并排运行，充分利用声明式 Kubernetes API 的全部能力，并获得 Pod 的所有其他好处。

容器和 Wasm 应用适用于标准 Pod、标准工作负载控制器和标准运行时。然而，无服务器函数和虚拟机需要一些额外帮助。  
无服务器函数在标准 Pod 中运行，但需要像 Knative 这样的应用来扩展 Kubernetes API 并添加自定义资源和控制器。虚拟机类似，需要像 KubeVirt 这样的应用来扩展 API。

图 4.1 展示了在同一集群上运行的四种不同工作负载。每种工作负载都被包裹在 Pod 中，由控制器管理，并使用标准运行时。VM 工作负载运行在 VirtualMachineInstance（VMI）而不是 Pod 中，但 VMI 与 Pod 非常相似，并利用了许多 Pod 的特性。

> **图 4.1 - 包裹在 Pod 中的不同工作负载**  
> （该图显示了四种工作负载：容器、Wasm、无服务器函数和 VM，每种工作负载都位于一个 Pod 内，并由相应的控制器管理。）

### Pod 增强工作负载

Pod 通过以下多种方式增强工作负载：
- **资源共享**
- **高级调度**
- **应用健康探针**
- **重启策略**
- **安全策略**
- **终止控制**
- **存储卷**

以下命令显示 Pod 属性的完整列表，返回超过 1000 行。按下空格键可以翻页，按 `q` 回到提示符。

```bash
$ kubectl explain pods --recursive | more
```

```yaml
KIND:     Pod
VERSION:  v1
DESCRIPTION:
     Pod is a collection of containers that can run on a host. Th
     created by clients and scheduled onto hosts.
FIELDS:
   apiVersion
      <string>
   kind             <string>
   metadata
        <Object>
      annotations
  <map[string]string>
      labels
      <map[string]string>
      name
        <string>
      namespace     <string>
<Snip>
```

你甚至可以深入查看特定的 Pod 属性及其支持的值。以下示例深入查看了 Pod 的 `restartPolicy` 属性。

```bash
$ kubectl explain pod.spec.restartPolicy
```

```yaml
KIND:     Pod
VERSION:  v1
FIELD:    restartPolicy <string>
DESCRIPTION:
     Restart policy for all containers within the pod. One of Alw
     Default to Always. 
     More info: https://kubernetes.io/docs/concepts/workloads/pod
     Possible enum values:
     - `"Always"`
     - `"Never"`
     - `"OnFailure"`
```

尽管增加了如此多的功能，Pod 依然轻量级，开销极小。

### Pod 支持资源共享

Pod 运行一个或多个容器，同一 Pod 中的所有容器共享该 Pod 的执行环境。这包括：
- **共享文件系统和卷**（`mnt` 命名空间）
- **共享网络栈**（`net` 命名空间）
- **共享内存**（`IPC` 命名空间）
- **共享进程树**（`pid` 命名空间）
- **共享主机名**（`uts` 命名空间）

图 4.2 展示了一个多容器 Pod，两个容器共享 Pod 的卷和网络资源。

> **图 4.2 - 共享 IP 和卷的多容器 Pod**  
> （该图显示一个 Pod 包含两个容器，它们共享同一个 IP 地址和一个共享卷。外部应用和客户端可以通过 Pod 的 IP 访问这两个容器。）

# 4: 使用 Pod

## 多容器 Pod 共享 IP 和存储卷

10.0.10.15 IP 地址——主应用容器在端口 8080 上可用，边车容器在端口 5005 上可用。两个容器如果需要通过 Pod 内部相互通信，可以使用 Pod 的 localhost 适配器。两个容器还挂载了 Pod 的存储卷，并可以利用它来共享数据。例如，边车容器可以从远程 Git 仓库同步静态内容，并将其存储在存储卷中，然后主应用容器从中读取并作为网页提供。

## Pod 与调度

在进一步讨论之前，请记住，节点是主机服务器，可以是物理服务器、虚拟机或云实例。Pod 封装容器并在节点上执行。

Kubernetes 保证一个 Pod 中的所有容器都会被调度到同一个集群节点。尽管如此，只有当你需要让容器共享资源（例如内存、存储卷和网络）时，才应将它们放在同一个 Pod 中。如果你唯一的要求是将两个工作负载调度到同一个节点，那么你应该将它们放在不同的 Pod 中，并使用以下选项之一来确保它们被调度到同一个节点：

- **nodeSelectors（节点选择器）**
- **亲和性与反亲和性规则**
- **拓扑分布约束**
- **资源请求与资源限制**

> [!NOTE]
> **nodeSelectors（节点选择器）** 是在特定节点上运行 Pod 的最简单方式。你提供一个标签列表，调度器只会将 Pod 分配给具有所有标签的节点。
> **亲和性与反亲和性规则** 就像更强大的 nodeSelector。顾名思义，它们支持与资源一起调度（亲和性）和远离资源调度（反亲和性）。但它们也支持硬规则和软规则，并且既可以基于 Pod 选择，也可以基于节点选择：
> - 亲和性规则：吸引
> - 反亲和性规则：排斥
> - 硬规则：必须遵守
> - 软规则：仅作为建议和尽力而为
> 
> 基于节点选择很常见，其工作方式类似于 nodeSelector：你提供一个标签列表，调度器将 Pod 分配给具有这些标签的节点。
> 基于 Pod 选择的工作方式相同。你提供一个标签列表，Kubernetes 确保该 Pod 会与具有这些标签的其他 Pod 运行在同一个节点上。

考虑几个例子。一个硬节点亲和性规则指定 `project=tkb` 标签，告诉调度器它只能将 Pod 运行在具有该标签的节点上。如果找不到具有该标签的节点，它将不会调度该 Pod。如果是一条软规则，调度器会尝试寻找具有该标签的节点，但如果找不到，它仍然会调度该 Pod。如果是一条反亲和性规则，调度器会寻找*没有*该标签的节点。基于 Pod 的规则逻辑相同。

**拓扑分布约束** 是一种灵活的方式，用于在基础设施中智能分布 Pod，以实现可用性、性能、位置或任何其他需求。一个典型的例子是在云或数据中心底层可用区域之间分布 Pod，以实现高可用性（HA）。然而，你几乎可以为任何目的创建自定义域，例如将 Pod 调度到更靠近数据源的位置、更靠近客户端以改善网络延迟，以及许多其他原因。

**资源请求和资源限制** 非常重要，每个 Pod 都应该使用它们。它们告诉调度器一个 Pod 需要多少 CPU 和内存，调度器利用它们确保 Pod 运行在具有足够资源的节点上。如果你没有指定它们，调度器就无法知道 Pod 需要什么资源，并且可能将其调度到资源不足的节点上。

## 部署 Pod

部署一个 Pod 包括以下步骤：

1.  在 YAML 清单文件中定义 Pod。
2.  将清单提交到 API 服务器。
3.  请求经过身份验证和授权。
4.  Pod 规范通过验证。
5.  调度器根据 nodeSelectors、亲和性与反亲和性规则、拓扑分布约束、资源需求和限制等过滤节点。
6.  Pod 被分配给一个满足所有要求的健康节点。
7.  该节点上的 kubelet 监视 API 服务器，并注意到 Pod 分配。
8.  kubelet 下载 Pod 规范，并请求本地运行时启动它。
9.  kubelet 监视 Pod 状态，并向 API 服务器报告状态变更。

如果调度器找不到合适的节点，它会将 Pod 标记为 **Pending（挂起）**。

部署 Pod 是一个原子操作。这意味着一个 Pod 只有在其所有容器都运行后才会开始服务请求。

## Pod 生命周期

Pod 被设计为**有生命（mortal）** 且**不可变（immutable）**。

- **有生命**：意味着你无法重启已失败或已删除的 Pod。是的，如果由更高级别的控制器管理，Kubernetes 会替换失败的 Pod。但这与重启并修复一个失败的 Pod 不同。
- **不可变**：意味着部署后你无法修改它们。如果你来自传统背景，习惯于定期修补在线服务器并登录进行修复和配置更改，这可能是一个巨大的思维转变。如果你需要更改一个 Pod，你需要创建一个带有更改的新 Pod，删除旧 Pod，并用新 Pod 替换它。如果你需要向 Pod 写入数据，你应该附加一个存储卷，并将数据存储在卷中。这样，即使 Pod 被删除，你仍然可以访问数据和存储卷。

让我们看看一个典型的 Pod 生命周期。

你以声明式 YAML 对象的形式定义 Pod，并将其提交到 API 服务器。当调度器寻找一个节点来运行它时，Pod 进入 **Pending（挂起）** 阶段。假设找到了一个节点，Pod 被调度，本地 kubelet 指示运行时启动其容器。一旦所有容器都在运行，Pod 进入 **Running（运行中）** 阶段。如果这是一个长期运行的 Pod（例如 Web 服务器），它将无限期地保持在运行阶段。如果这是一个短暂运行的 Pod（例如批处理作业），一旦所有容器完成其任务，它将进入 **Succeeded（成功）** 状态。你可以在图 4.3 中看到这一点。

**图 4.3 - Pod 生命周期**

> [!TIP]
> 关于在 Kubernetes 上运行 VM 的快速说明。VM 与容器相反，它们被设计为**可变**且**永生（immortal）**。例如，你可以重启它们、更改它们的配置，甚至迁移它们。这与 Pod 的设计目标非常不同，这也是为什么 KubeVirt 将 VM 包装在一个称为 VirtualMachineInstance（VMI）的修改版 Pod 中，并使用自定义的工作负载控制器进行管理。

## 重启策略

在本章前面，我们说过 Pod 通过重启策略增强了应用的能力。然而，这些策略适用于单个容器，而不是 Pod。

让我们考虑一些场景。

你使用 Deployment 控制器将一个 Pod 调度到一个节点，然后该节点发生故障。发生这种情况时，Deployment 控制器会注意到故障节点，删除 Pod，并在一个幸存节点上创建一个新 Pod 来替换它。即使新 Pod 基于相同的 Pod 规范，它也会有一个新的 UID、一个新的 IP 地址，并且没有状态。当节点在维护期间或因资源调整而驱逐 Pod 时，同样的情况也会发生——被驱逐的 Pod 被删除，并在另一个节点上替换为新 Pod。

在扩缩容操作、更新和回滚期间，也会发生同样的事情。例如，缩容会删除 Pod，而扩容始终会添加新 Pod。

关键点是：每当我们说更新或重启 Pod 时，我们实际上是在用新 Pod 替换它们。

虽然 Kubernetes 无法重启 Pod，但它可以重启容器。这一操作始终由本地 kubelet 执行，并由 Pod 的 `spec.restartPolicy` 值控制，该值可以是以下之一：

- `Always`（总是）
- `Never`（从不）
- `OnFailure`（失败时）

这些值不言自明：`Always` 将始终尝试重启容器，`Never` 从不尝试重启，`OnFailure` 仅在容器因错误代码失败时才尝试重启。该策略是 Pod 级别的，意味着它适用于 Pod 中的所有容器，但 **init 容器** 除外。稍后会更详细地介绍 init 容器。

你选择的重启策略取决于应用的性质——是长期运行的容器还是短暂运行的容器。

- **长期运行的容器** 托管诸如 Web 服务器、数据存储和消息队列等无限期运行的应用。如果它们失败了，你通常希望重启它们，因此通常会赋予它们 `Always` 重启策略。
- **短暂运行的容器** 则不同，它们通常运行批处理类型的工作负载，需要运行任务直至完成。大多数情况下，它们完成时你很满意，并且只在它们失败时才希望重启。因此，你可能会赋予它们 `OnFailure` 重启策略。如果你不在意它们是否失败，则赋予它们 `Never` 策略。

总之，Kubernetes 从不重启 Pod——当它们失败、扩缩容以及更新时，Kubernetes 总是删除旧 Pod 并创建新 Pod。但是，它可以在同一节点上重启单个容器。

## 静态 Pod 与控制器

部署 Pod 有两种方式：

1.  直接通过 Pod 清单（很少使用）
2.  间接通过工作负载资源和控制器（最常见）

直接从 Pod 清单部署会创建一个**静态 Pod**，它无法自愈、扩缩容或执行滚动更新。这是因为它们仅由运行它们的节点上的 kubelet 管理，而 kubelet 仅限于在同一节点上重启容器。此外，如果节点发生故障，kubelet 也会随之故障，并且无法对 Pod 提供任何帮助。

相反，通过工作负载资源部署的 Pod 则享有由高可用控制器管理的所有好处：控制器可以在其他节点上重启 Pod，在需求变化时进行扩缩容，并执行诸如滚动更新和版本回滚等高级操作。本地 kubelet 仍然可以尝试重启失败的容器，但如果节点发生故障或被驱逐，控制器可以在不同的节点上重启它。更多关于工作负载资源和控制器的内容，请参见第 6 章。

> [!WARNING]
> 请记住，当我们说重启 Pod 时，实际上是用新 Pod 替换它。

## Pod 网络

每个 Kubernetes 集群都运行一个 Pod 网络，并自动将所有 Pod 连接到该网络。它通常是一个平面层 2 覆盖网络，跨越所有集群节点，并允许每个 Pod 直接与其他任何 Pod 通信，即使目标 Pod 位于不同的集群节点上。

你的 Pod 网络由第三方插件实现，该插件通过 **容器网络接口（CNI）** 与 Kubernetes 交互。

你在集群构建时选择一个网络插件，它会为整个集群配置 Pod 网络。存在许多插件，每个都有其优缺点。然而，在撰写本书时，**Cilium** 是最流行的，并且实现了许多高级功能，例如安全性和可观测性。

图 4.4 显示了三个节点运行五个 Pod。Pod 网络跨越所有三个节点，所有五个 Pod 都连接到该网络。这意味着所有 Pod 即使在不同节点上也能通信。请注意节点如何连接到外部网络，而不直接连接到 Pod 网络。

**图 4.4 Pod 网络**

> [!CAUTION]
> 新创建的集群通常实现一个非常开放的 Pod 网络，很少或没有安全性。这使得 Kubernetes 易于使用，并避免了通常与网络安全相关的挫折感。但是，你应该使用 Kubernetes 网络策略和其他措施来保护它。

## 多容器 Pod

多容器 Pod 是一种强大的模式，在现实世界中非常流行。

根据微服务设计模式，每个容器应该有一个明确单一的职责。例如，一个从仓库同步内容并将其作为网页提供的应用有两个不同的职责：

1.  同步内容
2.  提供网页

你应该用两个微服务来设计此应用，并为每个微服务提供一个容器——一个容器负责同步内容，另一个负责提供内容。我们称之为**关注点分离**或**单一职责原则**，它保持了容器的简洁和小巧，促进了重用，并使故障排除更加容易。

大多数时候，你会将应用容器放在它们自己的 Pod 中，并通过 Pod 网络进行通信。然而，

# 4: 使用 Pod

有时候将多个容器放在同一个 Pod 中更好。例如，延续同步和提供（sync and serve）应用的例子，将两个容器放在同一个 Pod 中，同步容器可以从远程系统拉取内容并存储到共享卷中，Web 容器可以读取并提供这些内容。参见图 4.5。

> [!figure] 图 4.5 - 多容器 Pod  
> （描述：一个 Pod 中包含两个容器：同步容器和 Web 容器。同步容器从远程系统拉取内容，存入共享卷；Web 容器从共享卷读取内容并对外服务。）

Kubernetes 有两种主要的多容器 Pod 模式：**Init 容器**和**Sidecar 容器**。我们来仔细看看两者。

## 多容器 Pod：Init 容器

Init 容器是 Kubernetes API 中定义的一种特殊容器类型。它们与应用程序容器运行在同一个 Pod 中，但 Kubernetes 保证它们会在主应用程序容器启动之前启动并完成，并且保证它们只运行一次。

Init 容器的目的是准备和初始化环境，使其准备好供应用程序容器使用。考虑几个快速示例。

有一个应用程序，它只应在远程 API 准备好接受连接时启动。与其用检查远程 API 的逻辑使主应用程序变得复杂，不如将该逻辑放在同一个 Pod 的 Init 容器中运行。部署 Pod 时，Kubernetes 首先启动 Init 容器，该容器会定期向 API 服务器发送请求，直到收到响应。在此过程中，Kubernetes 会阻止应用程序容器启动。一旦 Init 容器收到来自 API 服务器的响应，它就会完成，然后 Kubernetes 启动应用程序。

假设另一个应用程序需要在启动之前一次性克隆远程仓库。同样，与其用克隆和准备内容的代码（例如远程服务器地址、证书、身份验证、文件同步协议、校验和验证等）来膨胀和复杂化主应用程序，不如在 Init 容器中实现该逻辑，该容器保证在主应用程序容器启动之前完成任务。

每个 Pod 可以列出多个 Init 容器，Kubernetes 按照它们在 Pod 清单（manifest）中出现的顺序运行它们。所有 Init 容器都必须完成，Kubernetes 才会继续启动常规的应用程序容器。如果任何 Init 容器失败，Kubernetes 会尝试重新启动它。但如果将 Pod 的 `restartPolicy` 设置为 `Never`，Kubernetes 将使 Pod 失败。

Init 容器的一个缺点是它们仅限于在主应用程序容器启动之前运行任务。对于需要与主应用程序容器并行运行的任务，你需要 Sidecar 容器。

## 多容器 Pod：Sidecars

Sidecar 容器的工作是向应用程序添加功能，而无需直接将这些功能添加到应用程序容器中。示例包括：采集日志、监控和同步远程内容、代理连接、整理数据、加密网络流量等。

图 4.6 展示了一个多容器 Pod，其中包含一个应用程序容器和一个服务网格 Sidecar，该 Sidecar 拦截并加密所有网络流量。在此示例中，Sidecar 必须在主应用程序容器启动之前启动，并在 Pod 的整个生命周期中持续运行——如果 Sidecar 没有运行，应用程序容器将无法使用网络。

> [!figure] 图 4.6 - 服务网格 Sidecar  
> （描述：一个 Pod 中包含两个容器：应用程序容器和 Sidecar 容器。Sidecar 容器拦截进出应用程序容器的网络流量并进行加密。）

旧版本的 Kubernetes 没有 Sidecar 容器的概念，我们不得不将它们作为常规容器来实现。但这存在问题：没有可靠的方法在应用程序容器之前启动 Sidecar、让它们与应用程序容器一起运行，或者在应用程序容器之后停止它们。幸运的是，Kubernetes v1.28 引入了原生 Sidecar 作为 alpha 特性，并在 v1.29 中推进到 beta 状态。截至 v1.32，Sidecar 容器仍处于 beta 阶段，使用时应谨慎。不过，它们默认已启用，并且被许多知名项目使用，包括 Argo CD 和 Istio。我们预计它们很快将达到 GA（稳定）里程碑。

你将在后续实践部分看到更多细节，但简单来说，你可以将 Sidecar 定义为 `spec.initContainers` 中的 Init 容器，并设置 `restartPolicy: Always`。如果这样做，Kubernetes 将保证它们：

- 在主应用程序容器之前启动
- 与主应用程序容器一起持续运行
- 在主应用程序容器之后终止

此外，它们遵循 Init 容器的其他规则，例如启动顺序，并且你可以附加探针（probes）来管理和监控它们的生命周期。

## Pod 理论总结

Pod 是 Kubernetes 上调度的原子单元，它抽象了内部工作负载的细节。它还实现了高级调度和许多其他特性。

许多 Pod 只运行单个容器，但多容器 Pod 功能更强大。你可以使用多容器 Pod 来紧密耦合需要共享资源（如内存和卷）的工作负载。你还可以使用多容器 Pod 来增强应用程序（Sidecar 模式）和初始化环境（Init 模式）。

Pod 以声明式 YAML 对象定义，但通常通过更高级的工作负载控制器部署，这些控制器为 Pod 增添了超能力，例如自我修复、自动扩缩等。

是时候看一些示例了。

## Pod 实践操作

如果你正在跟随操作，请克隆本书的 GitHub 仓库并切换到 `2025` 分支。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
Cloning into 'TKB'...
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

请确保在 `pods` 文件夹中运行所有命令。

### Pod 清单文件

让我们来看第一个 Pod 清单。这是 `pods` 文件夹中的 `pod.yml` 文件。

```yaml
kind: Pod
apiVersion: v1
metadata:
  name: hello-pod
  labels:
    zone: prod
    version: v1
spec:
  containers:
  - name: hello-ctr
    image: nigelpoulton/k8sbook:1.0
    ports:
    - containerPort: 8080
    resources:
      limits:
        memory: 128Mi
        cpu: 0.5
```

这是一个简单的示例，但你可以立刻看到四个顶级字段：

- `kind`
- `apiVersion`
- `metadata`
- `spec`

`kind` 字段告诉 Kubernetes 你正在定义的对象类型。此处定义的是 Pod，但如果你定义的是 Deployment，`kind` 字段会写为 `Deployment`。

`apiVersion` 告诉 Kubernetes 在创建对象时使用哪个 API 版本。

到目前为止，该清单描述了一个 Pod，并指示 Kubernetes 使用 `v1` Pod 模式来构建它。

`metadata` 部分将 Pod 命名为 `hello-pod`，并给它两个标签。你将在未来的章节中使用这些标签将其连接到 Service 以实现网络功能。

大多数操作发生在 `spec` 部分。此示例定义了一个单容器 Pod，其中包含一个名为 `hello-ctr` 的应用程序容器。该容器基于 `nigelpoulton/k8sbook:1.0` 镜像，监听端口 `8080`，并告知调度器它最多需要 128MB 内存和 0.5 个 CPU。

> [!TIP] 清单文件：同理心即代码  
> 快速插话。  
> Kubernetes YAML 文件是优秀的文档来源，你可以利用它们让新团队成员快速上手，并帮助弥合开发与运维之间的差距。  
> 例如，新团队成员可以阅读你的 YAML 文件，快速了解应用程序的基本功能和需求。运维团队也可以利用它们了解应用程序需求，如网络端口、CPU 和内存需求等。  
> 你还可以将它们存储在源代码仓库中，以便轻松进行版本控制和与其他版本进行比较。  
> Nirmal Mehta 在 2017 年 DockerCon 的演讲《A Strong Belief, Loosely Held: Bringing Empathy to IT》中将这些附带好处描述为一种“同理心即代码”（empathy as code）。

### 从清单文件部署 Pod

运行以下 `kubectl apply` 命令来部署 Pod。该命令将 `pod.yml` 文件发送到 `kubeconfig` 文件中当前上下文所定义的 API 服务器。它还使用 `kubeconfig` 文件中的凭据对请求进行身份验证。

```bash
$ kubectl apply -f pod.yml
pod/hello-pod created
```

虽然输出显示 Pod 已创建，但它可能仍在拉取镜像并启动容器。

运行 `kubectl get pods` 来检查状态。

```bash
$ kubectl get pods
```

### Introspecting Pods

```bash
$ kubectl get pods
NAME        READY    STATUS             RESTARTS   AGE
hello-pod   0/1      ContainerCreating  0          9s
```

这个例子中的Pod尚未完全创建——**READY**列显示零个容器就绪，**STATUS**列说明了原因。

这里顺便提一下，Kubernetes 会自动从 Docker Hub 拉取（下载）镜像。如果要使用其他镜像仓库，只需在 YAML 文件的镜像名称前加上该仓库的 URL 即可。

一旦 **READY** 列显示 `1/1` 且 **STATUS** 列显示 `Running`，则表明 Pod 正在一个健康的集群节点上运行，并由该节点的 kubelet 主动监控。

后续章节将会介绍如何连接应用并进行测试。

---

## Introspecting Pods

下面介绍一些主要的 `kubectl` 命令，用于监控和检查 Pod。

### kubectl get

你已经运行过 `kubectl get pods` 命令，它返回一行基本信息。但以下标志能让你获得更多信息：

- `-o wide` 提供更多列，但仍为单行输出
- `-o yaml` 获取 Kubernetes 关于该对象的所有信息

下面的示例展示了带有 `-o yaml` 标志的 `kubectl get pods` 输出。我对输出进行了截断，但你可以看到它分为两个主要部分：

- **spec**
- **status**

`spec` 部分显示对象的期望状态，`status` 部分显示观察到的实际状态。

```bash
$ kubectl get pods hello-pod -o yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      <截断>
  name: hello-pod
  namespace: default
spec:                           <<---- 期望状态在此处
  containers:
  - image: nigelpoulton/k8sbook:1.0
    imagePullPolicy: IfNotPresent
    name: hello-ctr
    ports:
    <截断>
status:                         <<---- 观察到的状态在此处
  conditions:
  - lastProbeTime: null
    lastTransitionTime: "2024-01-03T18:21:51Z"
    status: "True"
    type: Initialized
  <截断>
```

完整输出比你用来创建 Pod 的 17 行 YAML 文件要多得多。那么，Kubernetes 从哪里获得所有这些额外细节？

主要有两个来源：

- [[Pod]] 有很多属性，只要在 YAML 文件中没有显式定义的属性，都会用默认值填充
- `status` 部分显示 Pod 的当前状态，它不在你的 YAML 文件中

### kubectl describe

另一个很实用的命令是 `kubectl describe`。它以友好的格式展示对象的概述，包括生命周期事件。

```bash
$ kubectl describe pod hello-pod
Name:         hello-pod
Namespace:    default
Labels:       version=v1
              zone=prod
Status:       Running
IP:           10.1.0.103
Containers:
  hello-ctr:
    Container ID:   containerd://ec0c3e...
    Image:          nigelpoulton/k8sbook:1.0
    Port:           8080/TCP
    <截断>
Conditions:
  Type              Status
  Initialized       True
  Ready             True
  ContainersReady   True
  <截断>
Events:
  Type    Reason     Age        Message
  ----    ------     ----     -------
  Normal  Scheduled  5m30s    Successfully assigned ...
  Normal  Pulling    5m30s    Pulling image "nigelpoulton/k8sbook
  Normal  Pulled     5m8s     Successfully pulled image ...
  Normal  Created    5m8s     Created container hello-ctr
  Normal  Started    5m8s     Started container hello-ctr
```

我为了书本而截断了输出，但如果你在自己的系统上研究完整输出，将会学到很多。

### kubectl logs

你可以使用 `kubectl logs` 命令获取 Pod 中任何容器的日志。命令的基本格式是 `kubectl logs <pod>`。

如果对多容器 Pod 运行该命令，默认你会得到 Pod 中第一个容器的日志。但你可以通过 `--container` 标志指定另一个容器的名称来覆盖此行为。如果不确定容器名称或它们在多容器 Pod 中的顺序，只需运行 `kubectl describe pod <pod>` 命令。你也可以从 Pod 的 YAML 文件中获取相同信息。

下面的 YAML 展示了一个包含两个容器的多容器 Pod。第一个容器名为 `app`，第二个名为 `syncer`。对此 Pod 运行 `kubectl logs` 而不指定 `--container` 标志，将获得 `app` 容器的日志。

```yaml
kind: Pod
apiVersion: v1
metadata:
  name: logtest
spec:
  containers:
  - name: app                   <<---- 第一个容器(默认)
    image: nginx
    ports:
      - containerPort: 8080
  - name: syncer                <<---- 第二个容器
    image: k8s.gcr.io/git-sync:v3.1.6
    volumeMounts:
    - name: html
<截断>
```

如果你想要 `syncer` 容器的日志，可以运行以下命令。不要运行此命令，因为你尚未部署这个 Pod。

```bash
$ kubectl logs logtest --container syncer
```

### kubectl exec

`kubectl exec` 命令是在运行中的容器内执行命令的好方法。

你可以通过两种方式使用 `kubectl exec`：

1. 远程命令执行
2. 交互式 Exec 会话

远程命令执行让你从本地 shell 向容器发送命令。容器执行该命令并将输出返回给你的 shell。

Exec 会话将你的本地 shell 连接到容器的 shell，就像登录到容器一样。

让我们先看远程命令执行。从你的本地 shell 运行以下命令。它要求 `hello-pod` Pod 中的第一个容器执行 `ps` 命令。

```bash
$ kubectl exec hello-pod -- ps
PID   USER     TIME  COMMAND
  1   root      0:00 node ./app.js
 17   root      0:00 ps aux
```

容器执行了 `ps` 命令，并在你的本地终端中显示了结果。

命令的格式是 `kubectl exec <pod> -- <command>`，并且你可以执行容器中安装的任何命令。如果你想在特定容器中运行命令，请记得使用 `--container` 标志。

尝试运行以下命令：

```bash
$ kubectl exec hello-pod -- curl localhost:8080
OCI runtime exec failed:...... "curl": executable file not found 
```

这个命令失败了，因为该容器中没有包含 `curl` 命令。

接下来，我们使用 `kubectl exec` 获取同一个容器的交互式 Exec 会话。这是通过将你的终端连接到容器的终端来实现的，感觉就像 SSH 会话。

运行以下命令创建到 `hello-pod` Pod 中第一个容器的 Exec 会话。你的 shell 提示符会改变，表示你已连接到容器的 shell。

```bash
$ kubectl exec -it hello-pod -- sh
#
```

`-it` 标志告诉 `kubectl exec` 使会话成为交互式的，将你的 shell 的 STDIN 和 STDOUT 流连接到 Pod 中第一个容器的 STDIN 和 STDOUT。`sh` 命令会在会话中启动一个新的 shell 进程，你的提示符会改变，表示你现在在容器内部。

在 Exec 会话内运行以下命令来安装 `curl` 二进制文件，然后执行 `curl` 命令。

```bash
# apk add curl
<截断>
# curl localhost:8080
<html><head><title>K8s rocks!</title><link rel="stylesheet" href=
```

> [!WARNING]
> 对运行中的 Pod 进行这样的更改是一种反模式，因为 Pod 被设计为不可变对象。不过，像这样的演示目的这样做是可以的。

### Pod 主机名

Pod 从它的 YAML 文件的 `metadata.name` 字段获取名称，Kubernetes 将其用作 Pod 中每个容器的主机名。

如果你在跟随操作，你应该有一个名为 `hello-pod` 的 Pod。它是从以下 YAML 文件部署的，该文件将 Pod 名称设置为 `hello-pod`。

```yaml
kind: Pod
apiVersion: v1
metadata:
  name: hello-pod      <<---- Pod 主机名.所有容器继承此名称
  labels:
  <截断>
```

从你现有的 Exec 会话内部运行以下命令来检查容器的主机名。该命令区分大小写。

```bash
$ env | grep HOSTNAME
HOSTNAME=hello-pod
```

如你所见，容器的主机名与 Pod 的名称相匹配。如果这是一个多容器 Pod，它的所有容器都会有相同的主机名。

因此，你应该确保 Pod 名称是有效的 DNS 名称（a-z、0-9、减号和句点符号）。

输入 `exit` 退出 Exec 会话并返回到你的本地终端。

### 检查 Pod### 检查 Pod 不可变性

Pod 被设计为不可变对象，这意味着部署后不应更改它们。

不可变性在两个层面适用：

- **对象不可变性（Pod）**
- **应用不可变性（容器）**

Kubernetes 通过阻止对运行中 Pod 的配置进行更改来处理对象不可变性。但是，Kubernetes 不能总是防止你更改容器内部的应用和文件系统。你有责任确保容器及其应用是无状态且不可变的。

以下示例使用 `kubectl edit` 编辑一个运行中的 Pod 对象。尝试更改以下任何属性：

- 容器名称
- 容器端口
- 资源请求与限制

你需要从本地终端运行此命令，它会在默认编辑器中打开 Pod 的配置。对于 Mac 和 Linux 用户，通常会在 `vi` 中打开会话，而对于 Windows，通常是 `notepad.exe`。

```bash
$ kubectl edit pod hello-pod
```

# 使用 Pod

## 编辑 Pod

> [!INFO]
> 你需要从本地终端运行此命令，它将在默认编辑器中打开 Pod 的配置。对于 Mac 和 Linux 用户，通常会打开 vi 会话；而对于 Windows，通常是 notepad.exe。

```
$ kubectl edit pod hello-pod
```

# 请编辑下面的对象。以 '#' 开头的行将被忽略。

```yaml
apiVersion: v1
kind: Pod
metadata:
  <Snipped>
  labels:
    version: v1
    zone: prod
  name: hello-pod                    
  namespace: default
  resourceVersion: "432621"
  uid: a131fb37-ceb4-4484-9e23-26c0b9e7b4f4
spec:
  containers:
  - image: nigelpoulton/k8sbook:1.0
    imagePullPolicy: IfNotPresent
    name: hello-ctr                  <<---- 尝试修改此处
    ports:
    - containerPort: 8080            <<---- 尝试修改此处
      protocol: TCP
    resources:
      limits:
        cpu: 500m                    <<---- 尝试修改此处
        memory: 256Mi                <<---- 尝试修改此处
      requests:
        cpu: 500m                    <<---- 尝试修改此处
        memory: 256Mi                <<---- 尝试修改此处
```

编辑文件，保存更改，然后关闭编辑器。你将收到一条消息，告知这些更改是被禁止的，因为这些属性是不可变的。

> [!TIP]
> 如果你卡在 vi 会话中，可以尝试键入以下组合键退出：`:q!` 然后按 **RETURN**。

## 资源请求与资源限制

Kubernetes 允许你为 Pod 中的每个容器指定资源请求和资源限制。

- **请求（Requests）** 是 **最小值**
- **限制（Limits）** 是 **最大值**

考虑以下 Pod YAML 片段：

```yaml
resources:
  requests:              <<---- 调度的最小值
    cpu: 0.5
    memory: 256Mi
  limits:                <<---- kubelet 设置上限的最大值
    cpu: 1.0
    memory: 512Mi
```

该容器需要至少 256Mi 内存和半个 CPU。调度器会读取这些值，并将其分配到具有足够资源的节点上。如果找不到合适的节点，它会将 Pod 标记为 `Pending`，而集群自动缩放器将尝试创建新的集群节点。

假设调度器找到了合适的节点，它会将 Pod 分配到该节点，kubelet 会下载 Pod 规范并请求本地运行时启动它。在此过程中，kubelet 会保留所请求的 CPU 和内存，确保资源在需要时可用。它还会告诉运行时根据每个容器的资源限制设置资源上限。在此示例中，它要求运行时设置一个 CPU 和 512Mi 内存的上限。大多数运行时会强制执行这些限制，但每个运行时的实现方式可能有所不同。

当一个容器执行时，它保证可以访问其最小需求（请求）。如果节点有额外的资源可用，它也可以使用更多，但绝不能超过你在其限制中指定的值。

对于多容器 Pod，调度器会合并所有容器的请求，并寻找一个具有足够资源来满足整个 Pod 的节点。

> [!NOTE]
> 如果你一直跟随示例，你会注意到部署 `hello-pod` 时使用的 `pod.yml` 只指定了资源限制，没有指定资源请求。然而，一些命令输出显示出了限制和请求。这是因为 Kubernetes 会在你没有指定请求时，自动将请求设置为与限制匹配。

## 多容器 Pod 示例 – Init 容器

以下 YAML 定义了一个具有 init 容器和应用容器的多容器 Pod。它来自本书 GitHub 仓库中的 `pods/initpod.yml` 文件。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: initpod
  labels:
    app: initializer
spec:
  initContainers:
  - name: init-ctr
    image: busybox:1.28.4
    command: ['sh', '-c', 'until nslookup k8sbook; do echo waiting for k8sbook service...; sleep 1; done; echo Service found!']
  containers:
    - name: web-ctr
      image: nigelpoulton/web-app:1.0
      ports:
        - containerPort: 8080
```

在 `spec.initContainers` 块下定义容器使其成为 init 容器，Kubernetes 保证这些容器在常规容器启动之前运行并完成。

常规容器在 `spec.containers` 块下定义，并且只有所有 init 容器成功完成后才会启动。

此示例包含一个名为 `init-ctr` 的 init 容器和一个名为 `web-ctr` 的应用容器。init 容器运行一个循环，查找名为 `k8sbook` 的 Kubernetes Service。它将在该循环中保持运行，直到你创建该 Service。一旦你创建了 Service，init 容器将看到它并退出，从而允许应用容器启动。你将在后续章节中学习 Service。

使用以下命令部署多容器 Pod，然后使用 `--watch` 标志运行 `kubectl get pods` 查看它是否启动。

```
$ kubectl apply -f initpod.yml
pod/initpod created
$ kubectl get pods --watch
NAME      READY   STATUS     RESTARTS   AGE
initpod   0/1     Init:0/1   0          6s
```

`Init:0/1` 状态告诉你 init 容器仍在运行，这意味着主容器尚未启动。如果你运行 `kubectl describe` 命令，你会看到 Pod 的整体状态是 `Pending`。

```
$ kubectl describe pod initpod
Name:             initpod
Namespace:        default
Priority:         0
Service Account:  default
Node:             docker-desktop/192.168.65.3
Labels:           app=initializer
Annotations:      <none>
Status:           Pending              <<---- Pod 状态
<Snip>
```

Pod 将保持此状态，直到你创建一个名为 `k8sbook` 的 Service。

运行以下命令来创建 Service 并重新检查 Pod 状态。

```
$ kubectl apply -f initsvc.yml
service/k8sbook created
$ kubectl get pods --watch
NAME      READY   STATUS            RESTARTS   AGE
initpod   0/1     Init:0/1          0          15s
initpod   0/1     PodInitializing   0          3m39s
initpod   1/1     Running           0          3m57s
```

当 init 容器看到 Service 时，它会完成，然后主应用容器启动。等待几秒钟让其完全启动。

如果你再次对 `initpod` Pod 运行 `kubectl describe`，你会看到 init 容器处于终止状态，因为它已成功完成（退出码 0）。

## 多容器 Pod 示例 – Sidecar 容器

Sidecar 容器的作用是通过提供辅助服务（如日志抓取或与远程仓库同步）来增强应用容器。

Kubernetes 将 Sidecar 容器和应用程序部署在同一个 Pod 中，这样它们可以共享卷等资源。Kubernetes 还保证 sidecar 会在应用容器之前启动，与应用容器同时运行，并在应用容器之后终止。

你可以在 YAML 清单文件的 `spec.initContainers` 下定义 sidecar 容器，并将容器的 `restartPolicy` 设置为 `Always`。这个重启策略将 sidecar 与常规 init 容器区分开，并确保它们与应用容器一起运行。在同一 Pod 清单的 `spec.containers` 下定义应用容器。

以下 YAML 文件定义了你即将部署的多容器 Pod。它有一个名为 `ctr-sync` 的 sidecar 容器和一个名为 `ctr-web` 的应用容器。`ctr-sync` sidecar 具有 `restartPolicy: Always` 设置，该设置仅应用于该容器，并覆盖你可能在 Pod 级别设置的任何重启策略。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: git-sync
  labels:
    app: sidecar
spec:
  initContainers:                     
  - name: ctr-sync                    ---┐  
    restartPolicy: Always                |      <<---- 设置为 Always
    image: k8s.gcr.io/git-sync:v3.1.6    | 
    volumeMounts:                        | 
    - name: html                         | S
      mountPath: /tmp/git                | i
    env:                                 | d
    - name: GIT_SYNC_REPO                | e
      value: https://github.com/...      | c
    - name: GIT_SYNC_BRANCH              | a
      value: master                      | r
    - name: GIT_SYNC_DEPTH               | 
      value: "1"                         | 
    - name: GIT_SYNC_DEST                | 
      value: "html"                   ---┘ 
  containers:
  - name: ctr-web                     ---┐ 
    image: nginx                         | A
    volumeMounts:                        | p 
    - name: html                         | p
      mountPath: /usr/share/nginx/    ---┘
  volumes:
  - name: html
    emptyDir: {}
```

`ctr-sync` sidecar 容器监视一个 GitHub 仓库，并将任何更改同步到一个名为 `html` 的共享卷。`ctr-web` 应用容器监视这个共享卷，并从中提供网页内容。在你即将进行的示例中，你将启动应用，更新远程 GitHub 仓库，并证明 sidecar 容器同步了更新。

> [!WARNING]
> 要执行此示例，你需要 Kubernetes v1.29 或更高版本以及一个 GitHub 账户。GitHub 账户是免费的。

你将完成以下步骤：

1.  Fork GitHub 仓库
2.  更新 YAML 文件，将其中的 URL 替换为你 fork 的仓库的 URL
3.  部署应用
4.  连接到应用，并看到它显示 `This is version 1.0`
5.  对 GitHub 仓库的 fork 进行更改
6.  验证你的更改出现在应用的网页上

### 1. Fork GitHub 仓库

你需要一个 GitHub 账户来完成此步骤。它们是免费的。

将浏览器指向以下 URL：
`https://github.com/nigelpoulton/ps-sidecar`

点击 **Fork** 下拉按钮，选择 **+ Create a new fork** 选项，填写所需详细信息，然后点击绿色 **Create fork** 按钮。

这将带你进入你新 fork 的仓库，你可以在那里复制其 URL。请确保复制 **你 fork 的仓库** 的 URL。

### 2. 更新 YAML 文件

返回到你的本地机器，编辑 `pods` 目录下的 `initsidecar.yml` 文件，将复制的 URL 粘贴到 `GIT_SYNC_REPO` 字段中，然后保存更改。

### 3. 部署 Sidecar 应用

运行以下命令，从 `initsidecar.yml` 文件部署应用。它将部署包含应用和 sidecar 容器的 Pod，以及一个用于连接应用的 Service。

```
$ kubectl apply -f initsidecar.yml
pod/git-sync created
service/svc-sidecar created
```

检查 Pod 状态。

```
$ kubectl get pods                     
NAME         READY     STATUS      RESTARTS     AGE
git-sync     2/2       Running     0            12s
```

Pod 正在运行，两个容器都已就绪。

以下命令稍显复杂，但可以显示 Kubernetes 将 `ctr-sync` 容器作为 init 容器部署，将 `ctr-web` 容器作为常规容器部署。

```
$ kubectl get pod -o "custom-columns="\
  "NAME:.metadata.name,"\
  "INIT:.spec.initContainers[*].name,"\
  "CONTAINERS:.spec.containers[*].name"
```

# 4: 使用 Pod

## 描述 Pod 并查看 Events 部分

执行以下命令确认 Kubernetes 在 `ctr-web` 应用 Pod 之前启动了 `ctr-sync` sidecar Pod。输出已裁剪，仅显示相关部分。

```bash
$ kubectl describe pod git-sync
Name:             git-sync
Status:           Running
<Snip>
Events:
  Type      Reason       Age     From       Message
  ----      ------       ----    ----       -------
  Normal    Created      19s     kubelet    Created container ctr
  Normal    Started      19s     kubelet    Started container ctr
  Normal    Pulling      18s     kubelet    Pulling image "nginx"
  Normal    Created      17s     kubelet    Created container ctr
  Normal    Started      17s     kubelet    Started container ctr
```

时间戳显示 Kubernetes 在启动 `ctr-web` 应用容器之前启动了 `ctr-sync` sidecar 容器。

## 4. 连接到应用

Pod 运行后，执行 `kubectl get svc svc-sidecar` 命令，复制 `EXTERNAL-IP` 列的值。如果你在云环境中运行，这将是公有 IP 或 DNS 名称；如果使用本地 Docker Desktop 集群，则需要使用 `localhost`。

将 IP 或 DNS 名称粘贴到浏览器新标签页中查看网页。页面将显示 **This is version 1.0**。

## 5. 修改 GitHub 仓库的 fork

> [!WARNING]
> 此步骤**必须**在你 fork 的仓库中完成。

进入你 fork 的仓库，编辑 `index.html` 文件。修改 `<h1>` 行的内容为其他文本，然后保存并提交更改。

## 6. 验证网页上的更改

刷新应用网页，查看你的更新内容。

**恭喜！** Sidecar 在应用容器之前启动并持续运行。你不仅通过 `kubectl` 命令验证了这一点，还通过修改 fork 的 GitHub 仓库内容并观察更改出现在应用中证明了这一过程。

## 清理

如果你一直跟随本教程操作，集群中应已部署以下资源：

**Pods**
- hello-pod
- initpod
- git-sync

**Services**
- k8sbook
- svc-sidecar

使用以下命令删除它们：

```bash
$ kubectl delete pod hello-pod initpod git-sync
pod "hello-pod" deleted
pod "initpod" deleted
pod "git-sync" deleted

$ kubectl delete svc k8sbook svc-sidecar
service "k8sbook" deleted
service "svc-sidecar" deleted
```

你也可以通过 YAML 文件删除对象：

```bash
$ kubectl delete -f initsidecar.yml -f initpod.yml -f pod.yml
pod "git-sync" deleted
service "svc-sidecar" deleted
pod "initpod" deleted
pod "hello-pod" deleted
service "k8sbook" deleted
```

你可能还希望删除 GitHub 上的 fork。

---

## 章节总结

在本章中，你学习了 Kubernetes 将所有应用部署在 [[Pod]] 内部。应用可以是容器、无服务器函数、[[WebAssembly (Wasm)]] 应用和虚拟机。不过，它们通常是容器，因此我们通常用执行容器来描述 Pod。

---

> [!INFO] 图像引用
> - [Image 1306 on Page 85]
> - [Image 1315 on Page 88]
> - [Image 1322 on Page 94]
> - [Image 1328 on Page 99]
> - [Image 1332 on Page 101]
> - [Image 1336 on Page 104]