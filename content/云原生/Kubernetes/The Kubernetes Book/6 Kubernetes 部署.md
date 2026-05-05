# 6：Kubernetes 部署

本章介绍如何使用 Deployment 为 Kubernetes 上的无状态应用添加云原生特性，例如自愈、扩缩容、滚动更新和版本化回滚。

本章组织如下：

- [[Deployment 理论]]
- [[创建 Deployment]]
- [[手动扩缩应用]]
- [[执行滚动更新]]
- [[执行回滚]]

---

## Deployment 理论

Deployment 是在 Kubernetes 上运行无状态应用最流行的方式。它们增加了自愈、扩缩容、滚动更新和回滚能力。

考虑一个快速示例。

假设你有一个 Web 应用需求，它需要具有弹性、可按需扩缩容并频繁更新。你编写应用、容器化它，并将其定义为 Pod。然而，在将 Pod 发送到 Kubernetes 之前，你将其封装在一个 Deployment 中，以便获得弹性、扩缩容和更新能力。然后你将 Deployment 提交给 Kubernetes，Deployment 控制器会部署该 Pod。

此时，你的集群运行着一个管理单个 Pod 的 Deployment。

如果 Pod 发生故障，Deployment 控制器会用新的 Pod 替换它。如果需求增加，Deployment 控制器可以通过部署更多相同的 Pod 来扩缩应用。当你更新应用时，Deployment 控制器会删除旧 Pod 并用新 Pod 替换它们。

假设你添加一个也需要弹性、可扩缩容并定期更新的购物车服务。你将其容器化，在自己的 Pod 中定义它，将 Pod 封装在自己的 Deployment 中，然后部署到集群。

此时，你将拥有两个 Deployment 管理两个不同的微服务。

图 6.1 展示了一个类似的设置，Deployment 控制器监视并管理两个 Deployment。Web Deployment 管理四个相同的 Web 服务器 Pod，购物车 Deployment 管理两个相同的购物车 Pod。

> [!图 6.1] - **Deployments**
> 
> 图中展示了 Deployment 控制器（控制平面）下方管理两个 Deployment：一个名为“web”的 Deployment，下方有 4 个相同的 Web 服务器 Pod；另一个名为“cart”的 Deployment，下方有 2 个相同的购物车 Pod。箭头从 Deployment 控制器指向两个 Deployment，再从每个 Deployment 指向其管理的 Pod。

在底层，Deployment 遵循标准的 Kubernetes 架构，包括：

1. 一个**资源**
2. 一个**控制器**

在最高层次上，资源定义对象，控制器管理它们。

Deployment 资源存在于 `apps/v1` API 中，定义了所有支持的属性和能力。

Deployment 控制器是一个控制平面服务，负责监视 Deployment 并将**观测状态**与**期望状态**进行调和（reconcile）。

---

## Deployment 与 Pod

每个 Deployment 管理一个或多个相同的 Pod。

例如，一个包含 Web 服务和购物车服务的应用将需要两个 Deployment——一个用于管理 Web Pod，另一个用于管理购物车 Pod。图 6.1 显示了 Web Deployment 管理四个相同的 Web Pod，购物车 Deployment 管理两个相同的购物车 Pod。

图 6.2 展示了一个 Deployment YAML 文件，请求单个 Pod 的四个副本。如果将副本数增加到六个，它将部署并管理另外两个相同的 Pod。

> [!图 6.2]
> 
> 图中显示了一个名为 `my-deployment` 的 Deployment YAML 示例。`replicas` 字段设置为 4。`template` 部分内嵌定义了 Pod 的规范，包含一个容器列表。图注中标注“Pod template”，指出整个 Pod 规范嵌套在 `spec.template` 下。

注意 Pod 是如何在 Deployment YAML 内嵌的 `template` 中定义的。你会看到这被称为 **Pod 模板**。

---

## Deployment 与 ReplicaSet

我们反复说过 Deployment 提供了自愈、扩缩容、滚动更新和回滚。然而，在幕后，有一个名为 **ReplicaSet** 的不同资源，它提供了自愈和扩缩容能力。

图 6.3 展示了容器、Pod、ReplicaSet 和 Deployment 的整体架构。它还展示了它们如何映射到 Deployment YAML 中。图中 `rs` 是 ReplicaSet 的缩写。

> [!图 6.3]
> 
> 图中左侧从上到下展示了层次关系：Deployment → ReplicaSet → Pod → 容器。右侧对应的 YAML 结构：`apiVersion: apps/v1`，`kind: Deployment`，`metadata`，`spec`（包含 `replicas`、`selector`、`template`）。其中 `selector` 部分对应 ReplicaSet 的标签选择器。图中用虚线标注 Deployment 内部的 Pod 模板部分对应 ReplicaSet 的 Pod 模板。

将此 Deployment YAML 提交到集群将创建一个 Deployment、一个 ReplicaSet 和两个运行相同容器的相同 Pod。Pod 由 ReplicaSet 管理，而 ReplicaSet 又由 Deployment 管理。但是，你通过 Deployment 执行所有管理，永远不会直接管理 ReplicaSet 或 Pod。

---

## 关于扩缩容的一点说明

你可以手动扩缩应用，我们稍后会看到如何操作。然而，Kubernetes 有几个自动扩缩器可以自动扩缩你的应用和基础设施。其中一些包括：

- **Horizontal Pod Autoscaler（水平 Pod 自动扩缩器，HPA）**
- **Vertical Pod Autoscaler（垂直 Pod 自动扩缩器，VPA）**
- **Cluster Autoscaler（集群自动扩缩器，CA）**

**Horizontal Pod Autoscaler (HPA)** 添加和移除 Pod 以满足当前需求。它在大多数集群上自动安装并被广泛使用。

**Cluster Autoscaler (CA)** 添加和移除集群节点，以便始终有足够的资源运行所有调度的 Pod。这也是默认安装并被广泛使用的。

**Vertical Pod Autoscaler (VPA)** 增加和减少分配给运行 Pod 的 CPU 和内存，以满足当前需求。它不是默认安装的，有几个已知限制，使用范围较小。当前的实现通过每次扩缩 Pod 资源时删除现有 Pod 并用新 Pod 替换来工作。这是有破坏性的，甚至可能导致 Kubernetes 将新 Pod 调度到不同的节点。目前正在进行允许对运行中 Pod 进行就地更新的工作，但这是一个早期的 alpha 特性。

像 **karmada** 这样的社区项目更进一步，允许你跨多个集群扩缩应用。

让我们考虑一个使用 HPA 和 CA 的快速示例。

你向集群部署一个应用，并配置 HPA 在 2 到 10 个 Pod 之间自动扩缩应用 Pod。需求增加，HPA 要求调度器将 Pod 数量从 2 个增加到 4 个。这行得通，但需求继续上升，HPA 要求调度器再添加 2 个 Pod。然而，调度器找不到具有足够资源的节点，并将两个新 Pod 标记为 **Pending**。CA 注意到这些 Pending Pod，并动态添加一个新集群节点。一旦节点加入集群，调度器将 Pending Pod 分配给它。

缩减的过程也是如此。例如，当需求减少时，HPA 减少 Pod 数量。这可能会触发 CA 减少集群节点数量。移除集群节点时，Kubernetes 会驱逐该节点上的所有 Pod，并在存活的节点上用新 Pod 替换它们。

你有时会听到人们提及 **多维自动扩缩**。这是组合多种扩缩方法的术语——扩缩 Pod 和节点，或水平扩缩（添加更多 Pod）和垂直扩缩（向现有 Pod 添加更多资源）。

---

## 核心在于状态

在进一步深入之前，理解以下概念至关重要。如果你已经了解，可以跳到**使用 Deployment 进行滚动更新**部分。

- **期望状态（Desired state）**
- **观测状态（Observed state，有时称为实际状态或当前状态）**
- **调和（Reconciliation）**

期望状态是你想要的，观测状态是你拥有的，目标是它们始终匹配。当它们不匹配时，控制器启动一个调和过程，使观测状态与期望状态同步。

**声明式模型**是我们向 Kubernetes 声明期望状态的方式，而不告诉 Kubernetes 如何实现它。你将“如何做”留给 Kubernetes。

### 声明式 vs 命令式

声明式模型描述一个最终目标——你告诉 Kubernetes 你想要什么。命令式模型需要一长串命令来告诉 Kubernetes 如何到达最终目标。

下面的类比会有所帮助：

> **声明式**：给我一个够十个人吃的巧克力蛋糕。
> 
> **命令式**：开车去商店。买鸡蛋、牛奶、面粉、可可粉……开车回家。预热烤箱。混合配料。放入蛋糕模具。如果是风扇辅助烤箱，将蛋糕放入烤箱 30 分钟。如果不是风扇辅助烤箱，将蛋糕放入烤箱 40 分钟。设置定时器。定时器到期后从烤箱取出并关闭烤箱。放置冷却。添加糖霜。

声明式模型更简单，将“如何做”留给 Kubernetes。命令式模型复杂得多，因为你必须提供所有步骤和命令，希望它们能达到最终目标——在这个例子中，是为十个人制作巧克力蛋糕。

让我们看一个更具体的例子。

假设你有一个包含两个微服务的应用——前端和后端。你预计需要五个前端副本和两个后端副本。

采用声明式方法，你编写一个简单的 YAML 文件，请求五个前端 Pod 在外部监听端口 80，以及两个后端 Pod 在内部监听端口 27017。然后将文件交给 Kubernetes，坐观其成。这是一个美妙的事情。

相反的是命令式模型。这通常是一长串复杂指令，没有期望状态的概念。更糟糕的是，命令式指令可能有无数种变化。例如，拉取和启动 containerd 容器的命令与拉取和启动 CRI-O 容器的命令不同。这会导致更多工作，更容易出错，而且由于没有声明期望状态，就没有自愈能力。它极其丑陋。

Kubernetes 支持两种模型，但强烈偏爱声明式模型。

> [!NOTE] 注意
> containerd 和 CRI-O 是在 Kubernetes 工作节点上运行并执行低级任务（如启停容器）的容器运行时。

---

## 控制器与调和

调和是期望状态的基础。

例如，Kubernetes 将 ReplicaSet 实现为在**调和循环**中运行的后台控制器，确保始终存在正确数量的 Pod 副本。如果 Pod 不足，ReplicaSet 会添加更多；如果过多，它会终止一些。

假设一个场景，你的期望状态是十个副本，但只有八个存在。无论是因为故障还是自动扩缩器请求增加，ReplicaSet 控制器都会创建两个新副本来同步观测状态与期望状态。最棒的是，它不需要你的帮助！

完全相同的调和过程实现了自愈、扩缩容、滚动更新和回滚。

让我们更仔细地看看滚动更新和回滚。

---

## 使用 Deployment 进行滚动更新

Deployment 非常擅长零停机滚动更新（rollout）。但如果你将应用设计为以下两点，效果最佳：

1. 通过 API 松耦合
2. 向后和向前兼容

这两点都是现代云原生微服务应用的标志，工作方式如下。

你的微服务应该始终松散耦合，并且仅通过定义良好的 API 通信。这样做意味着你可以更新和修补任何微服务，而无需担心影响其他服务——所有连接都通过形式化的 API 进行，这些 API 公开了文档化的接口并隐藏了具体细节。

确保版本向后和向前兼容意味着你可以独立更新，而不必关心哪些版本的客户端正在消费你的服务。一个简单的非技术类比是汽车。汽车公开了一个标准的驾驶“API”，包括方向盘和脚踏板。只要你不改变这个“API”，你就可以重新映射发动机、更改排气系统、安装更大的刹车，而驾驶员无需学习任何新技能。

牢记这些要点，零停机滚动更新的工作原理如下：

假设你运行一个无状态微服务的五个副本。客户端可以连接到五个副本中的任意一个，只要所有客户端都通过向后和向前兼容的 API 连接。为了执行滚动更新，Kubernetes 创建一个运行新版本的新副本，并终止一个运行旧版本的副本。此时，你有四个运行旧版本的副本和一个运行新版本的副本。此过程重复，直到所有五个副本都在新版本上。由于应用是无状态的，并且有多个副本在运行，客户端不会经历停机或服务中断。

幕后还有更多内容，让我们更仔细地看看。

每个微服务被构建为一个容器并封装在 Pod 中。然后，你将每个微服务的 Pod 封装在其自己的 Deployment 中，以获得自愈、扩缩容和滚动更新。每个 Deployment 描述了以下所有内容：

- Pod 副本数量
- 要使用的容器镜像
- 网络端口
- 如何执行滚动更新

# 6: Kubernetes 部署

你将 Deployment YAML 文件发送到 API Server，[[ReplicaSet]] 控制器确保正确数量的 [[Pod]] 被调度。它还监视集群，确保观察状态与期望状态一致。[[Deployment]] 位于 ReplicaSet 之上，管理其配置并增加滚动更新和回滚的机制。

到目前为止一切顺利。

现在，假设你暴露于一个已知的漏洞，需要发布一个包含修复的更新。为此，你更新同一个 Deployment YAML 文件，使用新的 Pod 规约，然后重新提交给 API Server。这会更新现有的 Deployment 对象，赋予一个新的期望状态，请求相同数量的 Pod，但全部运行包含修复的较新版本。

此时，观察状态不再匹配期望状态——你有五个旧 Pod，但需要五个新的。

为进行调和，Deployment 控制器创建一个新的 ReplicaSet，定义相同数量的 Pod，但运行较新版本。你现在有两个 ReplicaSet——原始的那个用于运行旧版本的 Pod，新的那个用于运行新版本的 Pod。Deployment 控制器会系统地增加新 ReplicaSet 中的 Pod 数量，同时减少旧 ReplicaSet 中的 Pod 数量。最终结果是平滑、增量式的滚动更新，零停机。

未来的更新也会发生相同的过程——你持续更新同一个 Deployment 清单，该清单应存储在版本控制系统中。

图 6.4 展示了一个已经更新过一次的 Deployment。初始发布创建了左侧的 ReplicaSet，更新创建了右侧的 ReplicaSet。你可以知道更新已完成，因为左侧的 ReplicaSet 没有管理任何 Pod，而右侧的 ReplicaSet 管理着三个运行中的 Pod。

**图 6.4** 一个已经更新过的 Deployment，显示两个 ReplicaSet：旧版（无 Pod）和新版（3 个 Pod）

在下一节中，你将看到为什么旧的 ReplicaSet 仍然存在且配置完好是很重要的。

## 回滚

如图 6.4 所示，较旧的 ReplicaSet 会逐步缩减，不再管理任何 Pod。然而，它们的配置仍然存在，可以用于轻松回滚到早期版本。

回滚过程是滚动更新的逆过程——让旧的 ReplicaSet 逐步增加，而当前的 ReplicaSet 逐步缩减。

图 6.5 展示了同一个应用回滚到之前的配置，左侧的较早 ReplicaSet 管理所有 Pod。

**图 6.5** 回滚后的 Deployment，较早的 ReplicaSet 管理所有 3 个 Pod

但这不是结束。Kubernetes 为你提供了对滚动更新和回滚的细粒度控制。例如，你可以插入延迟、控制发布的速度和节奏，甚至可以探测更新后副本的健康状态。

但空谈无益。让我们看看 Deployment 的实际操作。

## 创建 Deployment

如果你想跟着操作，你需要本书 GitHub 仓库的实验文件。如果尚未获取，请运行以下命令：

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
Cloning into 'TKB'...
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

重要的是你从 `2025` 分支工作，并在 `deployments` 文件夹中运行所有命令。

```bash
$ cd deployments
```

我们将使用 `deploy.yml` 文件，如下面的片段所示。它定义了一个单容器的 Pod，包裹在 Deployment 中。我添加了注释并进行了修剪，以吸引你对我们将关注部分的注意。

```yaml
kind: Deployment
apiVersion: apps/v1
metadata:
  name: hello-deploy       <<---- Deployment 名称(必须是有效的 DNS 名称)
spec:
  replicas: 10             <<---- 要部署的 Pod 副本数
  selector:                
    matchLabels:
      app: hello-world
  revisionHistoryLimit: 5
  progressDeadlineSeconds: 300    
  minReadySeconds: 10
  strategy:                <<---- 该块定义滚动更新策略
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:                <<---- 以下是 Pod 模板
    metadata:
      labels:
        app: hello-world
    spec:
      containers:
      - name: hello-pod
        image: nigelpoulton/k8sbook:1.0
        ports:
        - containerPort: 8080
```

文件中包含很多内容，因此我们解释最重要的部分。

前两行告诉 Kubernetes 基于 `apps/v1` API 中定义的 Deployment 资源版本创建一个 Deployment 对象。

`metadata` 部分将 Deployment 命名为 `hello-deploy`。你应该始终为对象提供有效的 DNS 名称。这意味着在对象名称中只能使用字母数字、点号和短划线。

大部分操作发生在 `spec` 部分。

`spec.replicas` 请求 10 个 Pod 副本。在这种情况下，ReplicaSet 控制器将创建 `spec.template` 部分中定义的 Pod 的 10 个副本。

`spec.selector` 是一个标签列表，Deployment 和 ReplicaSet 控制器在决定它们管理哪些 Pod 时会查找这些标签。该标签选择器必须与 Pod 模板块（`spec.template.metadata.labels`）中的 Pod 标签匹配。在此示例中，两者都指定了 `app=hello-world` 标签。

`spec.revisionHistoryLimit` 告诉 Kubernetes 保留前五个 ReplicaSet，以便你可以回滚到最后五个版本。保留更多会提供更多的回滚选项，但保留太多可能会使对象膨胀，并在具有大量版本的大型集群上导致问题。

`spec.progressDeadlineSeconds` 告诉 Kubernetes 为每个新副本提供一个 5 分钟的启动窗口，然后才能将该副本报告为停滞。所有副本都有自己的窗口，这意味着每个副本都有自己的 5 分钟窗口以正常启动（进度）。

`spec.strategy` 告诉 Deployment 控制器在执行滚动更新时如何更新 Pod。我们将在本章后面的滚动更新部分解释这些设置。

最后，`spec.template` 以下的所有内容定义了这个 Deployment 将管理的 Pod。此示例定义了一个使用 `nigelpoulton/k8sbook:1.0` 镜像的单容器 Pod。

运行以下命令在你的集群上创建 Deployment：

> [!NOTE] 所有 `kubectl` 命令都包含来自你的 kubeconfig 文件的必要认证令牌。

```bash
$ kubectl apply -f deploy.yml
deployment.apps/hello-deploy created
```

此时，Deployment 配置作为意图记录持久化到集群存储中，并且 Kubernetes 已将十个副本调度到健康的工作节点。Deployment 和 ReplicaSet 控制器也在后台运行，监视当前状态并渴望执行它们的调和魔法。

你可以随时运行 `kubectl get pods` 命令查看十个 Pod。

## 检查 Deployment

你可以使用常规的 `kubectl get` 和 `kubectl describe` 命令查看 Deployment 和 ReplicaSet 的详细信息。

```bash
$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   10/10   10           10          105s
```

```bash
$ kubectl describe deploy hello-deploy
Name:                   hello-deploy
Namespace:              default
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=hello-world
Replicas:               10 desired | 10 updated | 10 total | 10 available
StrategyType:           RollingUpdate
MinReadySeconds:        10
RollingUpdateStrategy:  1 max unavailable, 1 max surge
Pod Template:
  Labels:  app=hello-world
  Containers:
   hello-pod:
    Image:        nigelpoulton/k8sbook:1.0
    Port:         8080/TCP
<SNIP>
OldReplicaSets:  <none>
NewReplicaSet:   hello-deploy-54f5d46964 (10/10 replicas created)
<Snip>
```

为了可读性，我剪裁了输出，但花点时间检查它们，因为它们包含大量信息，将强化你所学到的知识。

如前所述，Deployments 会自动创建关联的 ReplicaSets。使用以下命令验证这一点：

```bash
$ kubectl get rs
```

> [!NOTE]
> 此部分为第6章：Kubernetes 部署（第150-192页）的翻译内容，请保持与原文的连续性和顺序。

### 访问应用

Deployment 正在运行，你已拥有 10 个副本。然而，你需要一个 Kubernetes Service 对象才能连接到应用。我们将在下一章详细介绍 Service，但目前你只需知道它们为 Pod 提供网络访问即可。

以下 YAML 来自 `deployments` 文件夹中的 `lb.yml` 文件。它定义了一个与刚部署的 Pod 配合工作的 Service。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: lb-svc
  labels:
    app: hello-world
spec:
  type: LoadBalancer
  ports:
  - port: 8080
    protocol: TCP
  selector:
    app: hello-world            # <<---- 将流量发送到带有此标签的 Pod
```

使用以下命令部署它。

```bash
$ kubectl apply -f lb.yml
service/lb-svc created
```

验证 Service 配置，并复制 `EXTERNAL-IP` 列中的值。某些 Docker Desktop 集群会错误地在 `EXTERNAL-IP` 列返回一个 `172` IP 地址，请将其替换为 `localhost`。

```bash
$ kubectl get svc lb-svc
NAME     TYPE           CLUSTER-IP       EXTERNAL-IP   PORT(S)    
lb-svc   LoadBalancer   10.100.247.251   localhost     8080:31086/
```

打开一个新的浏览器标签页，连接到 `EXTERNAL-IP` 字段中的值，端口为 `8080`。如果你在本地 Docker Desktop 集群上，这将是 `localhost:8080`。如果你的集群在云上，它将是一个公网 IP 或 DNS 名称，端口为 `8080`。

图 6.6 显示了一个浏览器在 `localhost:8080` 上访问该应用。

**图 6.6**

### 手动扩缩应用

你可以通过两种方式手动扩缩 Deployment：

*   **命令式：**
*   **声明式：**

命令式方法使用 `kubectl scale` 命令，而声明式方法需要你更新 Deployment YAML 文件并重新提交到集群。我们将向你展示两种方法，但 Kubernetes 更倾向于声明式方法。

验证你当前有 10 个副本。

```bash
$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   10/10   10           10          28m
```

运行以下命令，以命令式方式缩减到 5 个副本，并验证操作是否成功。

```bash
$ kubectl scale deploy hello-deploy --replicas 5
deployment.apps/hello-deploy scaled

$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   5/5     5            5           29m
```

恭喜，你已成功将 Deployment 缩减到 5 个副本。但是，这里有一个潜在的问题……

你环境的当前状态不再与你的声明式清单匹配——你的集群上有 5 个副本，但你的 Deployment YAML 仍然定义了 10 个。这可能会在将来使用 YAML 文件执行更新时导致问题。例如，在 YAML 文件中更新镜像版本并重新提交到集群，也会将副本数改回 10，而这可能不是你想要的。因此，你应该始终保持 YAML 清单与你的实时环境同步，而做到这一点的最简单方法是通过 YAML 清单以声明方式做出所有更改。

让我们重新提交 YAML 文件，将副本数恢复为 10。

```bash
$ kubectl apply -f deploy.yml
deployment.apps/hello-deploy configured

$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   10/10   10           10          38m
```

你可能已经注意到，扩缩操作几乎是瞬间完成的。但这对于即将介绍的滚动更新来说则不然。

Kubernetes 还具有自动扩缩器，可以根据当前需求自动扩缩 Pod 和基础设施。

### 执行滚动更新

术语 "rollout"、 "release"、 "zero-downtime update" 和 "rolling update" 含义相同，我们将互换使用它们。

我已经创建了新版本的应用，对其进行了测试，并将其上传到 Docker Hub，标签为 `nigelpoulton/k8sbook:2.0`。你只需执行发布即可。为了简化过程并将重点放在 Kubernetes 上，我们忽略了现实世界中的 CI/CD 工作流和版本控制工具。

在继续之前，至关重要的是你要理解：所有的更新操作实际上都是替换操作。当你更新一个 Pod 时，你实际上是在删除它，并用一个新的 Pod 替换它。这是因为 Pod 是不可变对象，因此一旦部署，你永远不会更改或更新它们。

第一步是更新 `deploy.yml` 文件中的镜像版本。使用你喜欢的编辑器将镜像版本更新为 `nigelpoulton/k8sbook:2.0` 并保存更改。

以下精简输出显示了文件中需要更新的行。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-deploy
spec:
  replicas: 10
  <Snip>
  template:
    <Snip>
    spec:
      containers:
      - name: hello-pod
        image: nigelpoulton/k8sbook:2.0          # <<---- 更新此行
        ports:
        - containerPort: 8080
```

下次你将文件提交到 Kubernetes 时，Deployment 控制器将删除每个运行 1.0 版本的 Pod，并用运行 2.0 版本的新 Pod 替换它们。但是，在执行此操作之前，让我们先看一下控制 Kubernetes 如何执行发布的相关设置。

YAML 文件的 `spec` 部分包含了所有告诉 Kubernetes 如何执行更新的设置。

```yaml
<Snip>
revisionHistoryLimit: 5          # <<---- 保留前五个版本的配置以便轻松回滚
progressDeadlineSeconds: 300     # <<---- 给每个新副本五分钟的启动时间,超时则视为失败
minReadySeconds: 10              # <<---- 每个新副本就绪后等待 10 秒再替换下一个
strategy:
  type: RollingUpdate            # <<---- 增量替换副本
  rollingUpdate:
    maxUnavailable: 1            # <<---- 更新过程中最多允许一个副本不可用
    maxSurge: 1                  # <<---- 更新过程中最多允许超过期望状态一个副本
<Snip>
```

*   `revisionHistoryLimit`：告诉 Kubernetes 保留前五个版本的配置，以便轻松回滚。
*   `progressDeadlineSeconds`：告诉 Kubernetes 给每个新 Pod 副本五分钟的窗口期来正常启动，超时则视为失败。如果它们启动得更快也没问题。
*   `spec.minReadySeconds`：限制 Kubernetes 替换副本的速度。此配置告诉 Kubernetes 在每个副本替换之间等待 10 秒。较长的等待时间能让你有更大的机会捕获问题，并避免将所有副本都替换为有问题的副本。在现实世界中，你需要将此值设置得足够大，以捕获常见的故障。

此外，还有一个嵌套的 `spec.strategy` 映射，告诉 Kubernetes：

*   使用 `RollingUpdate` 策略进行更新。
*   确保期望状态下最多只有一个 Pod 不可用（`maxUnavailable: 1`）。
*   确保期望状态下最多只有一个额外的 Pod（`maxSurge: 1`）。

此应用的期望状态是 10 个副本。因此，`maxSurge: 1` 意味着在发布过程中 Kubernetes 最多可以拥有 11 个 Pod，而 `maxUnavailable: 1` 允许其降至 9 个。最终结果是，发布过程会同时更新两个 Pod（9 和 11 之间的差值为 2）。

这一切都很好，但 Kubernetes 如何知道要删除和替换哪些 Pod 呢？

**标签！**

如果你仔细查看 `deploy.yml` 文件，你会看到 Deployment spec 有一个 `selector` 块。这是 Deployment 控制器在发布期间查找要更新的 Pod 时依据的标签列表。在此示例中，控制器将查找带有 `app=hello-world` 标签的 Pod。如果你查看文件底部的 Pod 模板，你会注意到它创建的 Pod 也带有相同的标签。最终结果是：这个 Deployment 创建带有 `app=hello-world` 标签的 Pod，并在执行更新等操作时选择带有相同标签的 Pod。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-deploy
spec:
  selector:                    # <<---- Deployment 将管理集群上副本
    matchLabels:               # <<---- 带有此标签的副本
      app: hello-world         # <<----
      <Snip>
  template:
    metadata:
      labels:
        app: hello-world       # <<---- 与选择器匹配的标签(如上所示)
<Snip>
```

Pod 和 Deployment 都是不可变的，这意味着在创建 Deployment 后，你无法更改选择器或标签。

运行以下命令，将更新后的清单提交到集群并开始发布。

```bash
$ kubectl apply -f deploy.yml
deployment.apps/hello-deploy configured
```

发布过程每次替换两个 Pod，并在每次替换后等待十秒。这意味着需要一两分钟才能完成。你可以使用 `kubectl rollout status` 监控进度。

```bash
$ kubectl rollout status deployment hello-deploy
Waiting for deployment "hello-deploy" rollout... 4 out of 10 new 
Waiting for deployment "hello-deploy" rollout... 4 out of 10 new 
Waiting for deployment "hello-deploy" rollout... 6 out of 10 new 
^C
```

如果你在发布仍在进行时退出监控进度，可以运行 `kubectl get deploy` 命令并查看与更新相关设置的效果。例如，以下命令显示已经有 6 个副本被更新，当前总共有 9 个副本。9 个比期望状态 10 个少一个，这是清单中 `maxUnavailable=1` 值的结果。

```bash
$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   9/10    6            9           63m
```

### 暂停和恢复发布

你可以使用 `kubectl` 来暂停和恢复发布。

如果你的发布仍在进行中，使用以下命令暂停它。

```bash
$ kubectl rollout pause deploy hello-deploy
deployment.apps/hello-deploy paused
```

在暂停的发布期间运行 `kubectl describe` 命令会提供一些有趣的信息。

```bash
$ kubectl describe deploy hello-deploy
Name:                   hello-deploy
Namespace:              default
Annotations:            deployment.kubernetes.io/revision: 2
Selector:               app=hello-world
Replicas:               10 desired | 6 updated | 11 total | 9 ava
StrategyType:           RollingUpdate
MinReadySeconds:        10
RollingUpdateStrategy:  1 max unavailable, 1 max surge
<Snip>
Conditions:
  Type           Status   Reason
  ----           ------   ------
  Available      True     MinimumReplicasAvailable
  Progressing    Unknown  DeploymentPaused
OldReplicaSets:  hello-deploy-54f5d46964 (3/3 replicas created)
NewReplicaSet:   hello-deploy-5f84c5b7b7 (6/6 replicas created)
```

`Annotations` 行显示该对象处于修订版 2（修订版 1 是初始发布，当前更新是修订版 2）。

### 执行回滚

如之前所述，Kubernetes 会保留旧的 ReplicaSet 作为文档化的修订历史，并提供简便的回滚方式。以下命令展示了该 Deployment 的历史记录，包含两个修订版本。

```shell
$ kubectl rollout history deployment hello-deploy
deployment.apps/hello-deploy
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

修订版本 1 是基于 1.0 镜像的初始版本。
修订版本 2 是更新 Pod 以运行版本的滚动更新。

> [!NOTE]
> **Annotations** 行显示该对象当前处于修订版本 2（修订版本 1 是初始发布，当前更新是修订版本 2）。**Replicas** 行显示滚动更新尚未完成。倒数第三行显示 Deployment 条件为“进行中但已暂停”。最后两行显示，初始版本的 ReplicaSet 管理着 3 个副本，新版本的 ReplicaSet 管理着 6 个副本。

如果在滚动更新期间发生扩容事件，Kubernetes 会将新增的副本均衡分配到两个 ReplicaSet 上。在本例中，如果 Deployment 通过增加 10 个新副本扩容到 20 个，Kubernetes 会将约 3 个新副本分配给旧的 ReplicaSet，约 6 个分配给新的 ReplicaSet。

运行以下命令恢复滚动更新：

```shell
$ kubectl rollout resume deploy hello-deploy
deployment.apps/hello-deploy resumed
```

完成后，可以使用 `kubectl get deploy` 检查状态：

```shell
$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   10/10   10           10          71m
```

输出显示滚动更新已完成——10 个 Pod 都是最新且可用的。

如果您一直在跟随操作，请刷新浏览器以查看更新后的应用。新版本包含更多文字，并且按钮上使用了本书的短名称。

> 之前显示“Kubernetes rocks!”，现在显示“WebAssembly is coming!”。我将来可能会更改显示内容。重要的是它已经改变了。

![图 6.7]()

### 执行回滚

如之前所述，Kubernetes 会保留旧的 ReplicaSet 作为文档化的修订历史，并提供简便的回滚方式。以下命令展示了该 Deployment 的历史记录，包含两个修订版本。

```shell
$ kubectl rollout history deployment hello-deploy
deployment.apps/hello-deploy
REVISION  CHANGE-CAUSE
1         <none>
2         <none>
```

修订版本 1 是基于 1.0 镜像的初始版本。
修订版本 2 是更新 Pod 以运行版本的滚动更新。

# 6: Kubernetes 部署

## 2.0 版本的镜像

以下命令显示与每个版本关联的两个 ReplicaSet。

```bash
$ kubectl get rs
NAME                      DESIRED   CURRENT   READY   AGE
hello-deploy-5f84c5b7b7   10        10        10      27m
hello-deploy-54f5d46964   0         0         0       93m
```

接下来使用 `kubectl describe` 命令针对旧的 ReplicaSet 运行，并证明其配置仍然引用旧镜像版本。你的 ReplicaSet 名称会不同。

```bash
$ kubectl describe rs hello-deploy-54f5d46964
Name:           hello-deploy-54f5d46964
Namespace:      default
Selector:       app=hello-world,pod-template-hash=54f5d46964
Labels:         app=hello-world
                pod-template-hash=54f5d46964
Annotations:    deployment.kubernetes.io/desired-replicas: 10
                deployment.kubernetes.io/max-replicas: 11
                deployment.kubernetes.io/revision: 1
Controlled By:  Deployment/hello-deploy
Replicas:       0 current / 0 desired
Pods Status:    0 Running / 0 Waiting / 0 Succeeded / 0 Failed
Pod Template:
  Containers:
   hello-pod:
    Image:        nigelpoulton/k8sbook:1.0         <<---- 仍然使用旧版本
    Port:         8080/TCP
    <Snip>
```

你感兴趣的行是书中倒数第二行显示旧镜像版本的那一行。这意味着将 Deployment 回滚到这个 ReplicaSet 将自动将所有 Pod 替换为运行 1.0 镜像的新 Pod。

> [!NOTE]
> 如果听到回滚被称为更新，不要感到困惑。它们本质上是相同的操作。它们遵循与更新/滚动更新相同的逻辑和规则——终止当前镜像的 Pod，并用运行新镜像的 Pod 替换它们。在回滚的情况下，新镜像实际上是旧镜像。

以下示例使用 `kubectl rollout` 将应用程序恢复到版本 1。这是一个命令式命令，不推荐使用。不过，它对于快速回滚很方便，只是要记得更新你的源 YAML 文件以反映更改。

```bash
$ kubectl rollout undo deployment hello-deploy --to-revision=1
deployment.apps "hello-deploy" rolled back
```

虽然看起来操作是瞬间完成的，但实际上并非如此。正如我们刚才所说，回滚遵循与滚动更新相同的规则。你可以使用以下 `kubectl get deploy` 和 `kubectl rollout` 命令验证这一点并跟踪进度。

```bash
$ kubectl get deploy hello-deploy
NAME           READY   UP-TO-DATE   AVAILABLE   AGE
hello-deploy   9/10    6            9           96m
$ kubectl rollout status deployment hello-deploy
Waiting for deployment "hello-deploy"... 6 out of 10 new replicas 
Waiting for deployment "hello-deploy"... 7 out of 10 new replicas 
Waiting for deployment "hello-deploy"... 8 out of 10 new replicas 
Waiting for deployment "hello-deploy"... 1 old replicas are pendi
Waiting for deployment "hello-deploy"... 9 of 10 updated replicas 
^C
```

与滚动更新一样，回滚一次替换两个 Pod，每次替换后等待十秒。

恭喜！你已经成功执行了滚动更新和回滚。

## 滚动更新与标签

你已经看到，Deployment 和 ReplicaSet 使用标签和选择器来确定它们拥有和管理哪些 Pod。

在早期版本的 Kubernetes 中，如果静态 Pod 的标签与 Deployment 的标签选择器匹配，Deployment 会夺取对这些静态 Pod 的所有权。然而，较新版本的 Kubernetes 通过向控制器创建的 Pod 添加系统生成的 `pod-template-hash` 标签来防止这种情况。

考虑一个简单的例子：你的集群中有五个带有 `app=front-end` 标签的静态 Pod。你添加一个新的 Deployment，要求创建十个具有相同标签的 Pod。旧版本的 Kubernetes 会看到五个现有的具有相同标签的静态 Pod，夺取它们的所有权，并且只创建五个新的。最终结果将是十个带有 `app=front-end` 标签的 Pod，全部归 Deployment 所有。然而，原来的五个静态 Pod 可能运行着不同的应用程序，你可能不希望 Deployment 管理它们。

幸运的是，现代版本的 Kubernetes 会为 Deployment（ReplicaSet）创建的所有 Pod 打上 `pod-template-hash` 标签。这阻止了更高级别的控制器夺取现有静态 Pod 的所有权。

仔细观察以下截取的输出，看看 `pod-template-hash` 标签如何连接 Deployment 和 ReplicaSet，以及 ReplicaSet 和 Pod。

```bash
$ kubectl describe deploy hello-deploy
Name:      hello-deploy
<Snip>
NewReplicaSet:   hello-deploy-54f5d46964  
$ kubectl describe rs hello-deploy-54f5d46964     
Name:           hello-deploy-54f5d46964
<Snip>
Selector:       app=hello-world,pod-template-hash=54f5d46964
$ kubectl get pods --show-labels
NAME                        READY   STATUS    LABELS
hello-deploy-54f5d46964..   1/1     Running   app=hello-world,pod-template-hash=54f5d46964
hello-deploy-54f5d46964..   1/1     Running   app=hello-world,pod-template-hash=54f5d46964
hello-deploy-54f5d46964..   1/1     Running   app=hello-world,pod-template-hash=54f5d46964
hello-deploy-54f5d46964..   1/1     Running   app=hello-world,pod-template-hash=54f5d46964
<Snip>
```

ReplicaSet 在其标签选择器中包含 `pod-template-hash` 标签，但 Deployment 不包含。这没问题，因为实际管理 Pod 的是 ReplicaSet。

你不应尝试修改 `pod-template-hash` 标签。

## 清理

使用 `kubectl delete -f deploy.yml` 和 `kubectl delete -f lb.yml` 删除示例中创建的 Deployment 和 Service。

## 本章小结

在本章中，你学到了 Deployment 是在 Kubernetes 上管理无状态应用程序的绝佳方式。它们为 Pod 增强了自愈、可伸缩性、滚动更新和回滚功能。

与 Pod 一样，Deployment 也是 Kubernetes API 中的对象，你应该以声明式方式使用它们。它们在 `apps/v1` API 中定义，并实现了一个在控制平面作为协调循环运行的控制器。

在幕后，Deployment 使用 ReplicaSet 来创建、终止和管理 Pod 副本的数量。但是，你不应直接创建或编辑 ReplicaSet，而应始终通过 Deployment 来配置它们。

---

**图像上下文（保留原文参考）：**
- [Image 1585 on Page 152]
- [Image 1591 on Page 154]
- [Image 1593 on Page 155]
- [Image 1606 on Page 165]
- [Image 1608 on Page 166]
- [Image 1619 on Page 175]
- [Image 1631 on Page 186]