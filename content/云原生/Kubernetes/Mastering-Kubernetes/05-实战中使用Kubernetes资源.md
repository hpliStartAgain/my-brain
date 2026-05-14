# 实战中使用Kubernetes Resources

> 在本章结束时，你将清晰地了解 Kubernetes 有多么令人印象深刻，以及如何将其用作极其复杂系统的基础。

## 设计 Hue 平台

在本节中，我们将搭建舞台并定义令人惊叹的 Hue 平台的范围。Hue 不是 Big Brother；Hue 是 Little Brother！Hue 将做你允许它做的任何事情。Hue 将能够做很多事情，这可能会让一些人担忧，但你可以选择 Hue 能在多大程度上帮助你。准备好迎接一场狂野之旅吧！

### 定义 Hue 的范围

Hue 将管理你的数字身份。它将比你更了解你自己。以下是 Hue 可以管理和帮助你的一些服务列表：

- 搜索和内容聚合
- 医疗——电子健康记录、DNA 测序
- 智能家居
- 金融——银行、储蓄、退休、投资
- 办公
- 社交
- 旅行
- 健康
- 家庭

让我们看看 Hue 平台的一些能力，例如智能提醒和通知、安全、身份和隐私。

### 智能提醒和通知

让我们想想这些可能性。Hue 将了解你，同时也了解你的朋友以及跨所有领域的其他用户聚合体。Hue 将实时更新其模型。它不会被过时数据所困扰。它将代表你行事，呈现相关信息，并持续学习你的偏好。它可以推荐你可能喜欢的新节目或书籍，根据你和家人或朋友的日程安排进行餐厅预订，并控制你的家居自动化。

### 安全、身份和隐私

Hue 是你的在线代理。如果有人窃取你的 Hue 身份，或者甚至只是窃听你的 Hue 交互，其后果将是毁灭性的。潜在用户甚至可能不愿意将他们的身份托付给 Hue 组织。让我们设计一个非信任系统，让用户有权随时切断 Hue 的连接。以下是一些想法：

- 通过专用设备提供强身份认证，配备多因素授权，包括多种生物特征因素
- 频繁轮换凭证
- 快速暂停服务并对所有外部服务进行身份验证（需要每个提供者的原始身份证明）
- Hue 后端将通过短生命周期令牌与所有外部服务交互
- 将 Hue 架构设计为一组松耦合的微服务，并具有强隔离性
- GDPR 合规
- 端到端加密
- 避免持有关键数据（让外部提供者管理）

Hue 的架构需要支持巨大的变化和灵活性。它还需要具有很高的可扩展性，使现有能力和外部服务不断升级，同时新的能力和外部服务被集成到平台中。这种规模的系统需要微服务架构，其中每个能力或服务完全独立于其他服务，只通过标准化和/或可发现的 API 定义良好的接口进行交互。

### Hue 组件

在开始我们的微服务之旅之前，让我们回顾一下我们需要为 Hue 构建的组件类型。

#### 用户画像（User Profile）

用户画像是一个主要组件，包含大量子组件。它是用户的本质——他们的偏好、他们在各个领域的历史，以及 Hue 所了解的关于他们的一切。你能从 Hue 中获得的好处很大程度上受到画像丰富程度的影响。但画像管理的信息越多，如果数据（或部分数据）被泄露，你可能遭受的损害就越大。

管理用户画像的一个重要部分是 Hue 将向用户提供的报告和洞察。Hue 将采用复杂的机器学习来更好地理解用户及其与其他用户和外部服务提供者的交互。

#### 用户图谱（User Graph）

用户图谱组件对跨多个领域的用户间交互网络进行建模。每个用户参与多个网络：社交网络如 Facebook、Instagram 和 Twitter；专业网络；爱好网络；以及志愿者社区。其中一些网络是临时的，Hue 将能够构建它们以造福用户。Hue 可以利用其拥有的丰富用户连接画像来改善交互，即使不暴露隐私信息。

#### 身份（Identity）

如前所述，身份管理至关重要，因此它需要一个单独的组件。用户可能希望管理多个相互排斥的画像，每个画像具有独立的身份。例如，用户可能不愿意将健康画像与社交画像混在一起，以免意外向朋友暴露个人健康信息。虽然 Hue 可以为你找到有用的连接，但你可能会选择用能力换取更多隐私。

#### 授权器（Authorizer）

授权器是一个关键组件，用户在此显式授权 Hue 代表他们执行某些操作或收集各种数据。这涉及对物理设备的访问、外部服务的账户以及主动性的级别。

#### 外部服务（External Services）

Hue 是外部服务的聚合器。它的设计目标不是取代你的银行、医疗服务提供者或社交网络。它将保存大量关于你活动的元数据，但内容将保留在你的外部服务中。每个外部服务都需要一个专用组件来与外部服务 API 和策略进行交互。当没有 API 可用时，Hue 通过自动化浏览器或原生应用来模拟用户。

#### 通用传感器（Generic Sensor）

Hue 价值主张的一个重要部分是代表用户采取行动。为了有效地做到这一点，Hue 需要感知各种事件。例如，如果 Hue 为你预订了假期，但检测到有更便宜的航班可用，它可以自动更改你的航班或请求你的确认。需要感知的事物是无穷无尽的。为了控制感知范围，需要一个通用传感器。通用传感器将是可扩展的，但提供了一个通用接口，Hue 的其他部分可以统一使用，即使添加了越来越多的传感器。

#### 通用执行器（Generic Actuator）

这是通用传感器的对应物。Hue 需要代表你执行操作；例如，预订航班或医生预约。为此，Hue 需要一个通用执行器，它可以扩展以支持特定功能，但能够以统一的方式与其他组件（如身份管理器和授权器）进行交互。

#### 用户学习器（User Learner）

这是 Hue 的大脑。它将持续监控你的所有交互（你授权的那些），并更新其对你以及你网络中其他用户的模型。这将使 Hue 随着时间的推移变得越来越有用，预测你需要什么以及什么会引起你的兴趣，提供更好的选择，在正确的时间呈现更相关的信息，并避免变得烦人和专横。

### Hue 微服务

每个组件的复杂性都是巨大的。其中一些组件，如外部服务、通用传感器和通用执行器，需要跨数百、数千甚至更多外部服务运行，而这些服务在 Hue 的控制之外不断变化。即使是用户学习器也需要跨许多领域学习用户的偏好。微服务通过允许 Hue 逐步演进并增长更多隔离的能力，而不会在其自身复杂性下崩溃，从而满足了这一需求。每个微服务通过标准接口与通用 Hue 基础设施服务交互，并可选择通过定义良好且版本化的接口与少数其他服务交互。每个微服务的表面区域是可控的，微服务之间的编排基于标准最佳实践。

### 插件

插件是在不 proliferation 接口的情况下扩展 Hue 的关键。插件的关键在于，你通常需要跨越多个抽象层的插件链。例如，如果你想为 Hue 添加与 YouTube 的新集成，那么你可以收集大量 YouTube 特定信息——你的频道、喜欢的视频、推荐以及你看过的视频。为了向用户展示这些信息并允许他们对其采取行动，你需要跨多个组件甚至在用户界面中部署插件。巧妙的设计将通过将建议、选择和延迟通知等操作类别聚合到许多服务来提供帮助。

关于插件的好处是任何人都可以开发它们。最初，Hue 开发团队必须开发插件，但随着 Hue 变得越来越流行，外部服务将希望与 Hue 集成并构建 Hue 插件来启用他们的服务。这当然会带来整个插件注册、审批和管理的生态系统。

### 数据存储

Hue 将需要多种类型的数据存储，以及每种类型的多个实例，来管理其数据和元数据：

- 关系型数据库
- 图数据库
- 时序数据库
- 内存缓存
- 块存储

由于 Hue 的范围，这些数据库中的每一个都必须是集群化、可扩展且分布式的。此外，Hue 将在边缘设备上使用本地存储。

### 无状态微服务

微服务应该尽可能无状态。这将允许特定的实例被快速启动和销毁，并根据需要在基础设施中迁移。状态将由存储管理，微服务通过短生命周期访问令牌访问状态。Hue 将在适当的情况下将频繁访问的数据存储在易于填充的快速缓存中。

### 无服务器函数

Hue 每用户功能的很大一部分将涉及与外部服务或其他 Hue 服务的相对短暂的交互。对于这些活动，可能没有必要运行一个需要扩展和管理的完整持久化微服务。更合适的解决方案可能是使用更轻量的无服务器函数。

### 事件驱动的交互

所有这些微服务需要相互通信。用户将要求 Hue 代表他们执行任务。外部服务将向 Hue 通知各种事件。队列与无状态微服务相结合提供了完美的解决方案。

每个微服务的多个实例将监听各种队列，并在相关事件或请求从队列中弹出时做出响应。无服务器函数也可能因特定事件而被触发。这种安排非常健壮且易于扩展。每个组件都可以是冗余且高可用的。虽然每个组件都可能出错，但系统具有很好的容错性。

队列也可以用于异步 RPC 或请求-响应风格的交互，其中调用方实例提供一个私有队列名称，响应被发布到该私有队列。

也就是说，有时通过定义良好的接口进行直接的服务到服务交互（或无服务器函数到服务交互）更有意义，并能简化架构。

### 规划工作流

Hue 通常需要支持工作流。一个典型的工作流将接受一个高级任务，例如预约牙医。它将提取用户的牙医信息和日程安排，与用户的日程进行匹配，在多个选项之间进行选择，可能向用户确认，进行预约，并设置提醒。我们可以将工作流分为全自动工作流和涉及人类的人工工作流。还有一些涉及花钱的工作流，可能需要额外的审批级别。

#### 自动工作流

自动工作流不需要人工干预。Hue 拥有执行所有步骤的完全授权，从头到尾。用户分配给 Hue 的自主权越多，Hue 就会越有效。用户将能够查看和审计所有工作流，无论是过去的还是现在的。

#### 人工工作流

人工工作流需要与人类进行交互。最常见的情况是需要用户从多个选项中做出选择或批准某个操作。但它也可能涉及另一个服务端的人员。例如，要预约牙医，Hue 可能需要从秘书那里获取可用时间列表。将来，Hue 将能够处理与人类的对话，并可能自动化其中一些工作流。

#### 预算感知工作流

某些工作流，例如支付账单或购买礼物，需要花钱。虽然理论上 Hue 可以被授予对用户银行账户的无限制访问权限，但大多数用户可能更愿意为不同的工作流设置预算，或者干脆将花钱设为需要人类批准的活动。用户可以为 Hue 授予对专用账户或一组账户的访问权限，并根据提醒和报告，根据需要向 Hue 分配更多或更少的资金。

至此，我们已经涵盖了很多内容，并了解了构成 Hue 平台及其设计的不同组件。现在是时候看看 Kubernetes 如何帮助构建像 Hue 这样的平台了。

## 使用 Kubernetes 构建 Hue 平台

在本节中，我们将查看各种 Kubernetes 资源以及它们如何帮助我们构建 Hue。首先，我们将更好地了解多才多艺的 `kubectl`，然后我们将研究如何在 Kubernetes 中运行长时间运行的进程，在内部和外部暴露服务，使用命名空间限制访问，启动临时任务，以及混入非集群组件。显然，Hue 是一个庞大的项目，因此我们将在本地集群上演示这些想法，而不是实际构建一个真正的 Hue Kubernetes 集群。请主要将其视为一个思想实验。如果你想探索在 Kubernetes 上构建基于微服务的真实分布式系统，请查看 *Hands-On Microservices with Kubernetes*：https://www.packtpub.com/product/hands-on-microservices-with-kubernetes/9781789805468。

### 有效使用 kubectl

`kubectl` 是你的瑞士军刀。它几乎可以对集群做任何事情。在底层，`kubectl` 通过 API 连接到你的集群。它读取你的 `~/.kube/config` 文件（默认情况下，可以通过 `KUBECONFIG` 环境变量或 `--kubeconfig` 命令行参数覆盖），其中包含连接到你的一个或多个集群所必需的信息。命令分为多个类别：

- **通用命令**：以通用方式处理资源：`create`、`get`、`delete`、`run`、`apply`、`patch`、`replace` 等
- **集群管理命令**：处理节点和整个集群：`cluster-info`、`certificate`、`drain` 等
- **故障排查命令**：`describe`、`logs`、`attach`、`exec` 等
- **部署命令**：处理部署和扩缩容：`rollout`、`scale`、`auto-scale` 等
- **设置命令**：处理标签和注解：`label`、`annotate` 等
- **杂项命令**：`help`、`config` 和 `version`
- **定制命令**：将 kustomize.io 能力集成到 kubectl 中
- **配置命令**：处理上下文，在集群和命名空间之间切换，设置当前上下文和命名空间等

你可以使用 Kubernetes 的 `config view` 命令查看配置。

以下是我的本地 KinD 集群的配置：

```bash
$ k config view
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: DATA+OMITTED
    server: https://127.0.0.1:50615
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

你的 kubeconfig 文件可能与上面的代码示例相似或不相似，但只要它指向一个正在运行的 Kubernetes 集群，你就能跟随学习。让我们深入了解一下 `kubectl` 清单文件。

### 理解 kubectl 清单文件

许多 `kubectl` 操作（例如 `create`）需要复杂的层次结构（因为 API 需要这种结构）。`kubectl` 使用 YAML 或 JSON 清单文件。YAML 更简洁且更易于人类阅读，因此我们将主要使用 YAML。以下是用于创建 Pod 的 YAML 清单文件：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ""
  labels:
    name: ""
  namespace: ""
  annotations: []
  generateName: ""
spec:
  ...
```

让我们检查一下清单的各种字段。

#### apiVersion

非常重要的 Kubernetes API 持续演进，可以通过不同版本的 API 支持同一资源的不同版本。

#### kind

`kind` 告诉 Kubernetes 它正在处理什么类型的资源；在本例中是 `Pod`。这是始终必需的。

#### metadata

`metadata` 包含大量描述 Pod 及其运行位置的信息：

- **name**：在其命名空间内唯一标识该 Pod
- **labels**：可以应用多个标签
- **namespace**：Pod 所属的命名空间
- **annotations**：可用于查询的注解列表

#### spec

`spec` 是一个 Pod 模板，包含启动 Pod 所需的所有信息。它可能相当复杂，因此我们将分多个部分来探索它：

```yaml
spec:
  containers: [
    ...
  ],
  "restartPolicy": "",
  "volumes": []
```

#### 容器规格（Container spec）

Pod 规格的 `containers` 部分是一个容器规格列表。每个容器规格具有以下结构：

```yaml
name: "",
image: "",
command: [""],
args: [""],
env:
- name: "",
  value: ""
imagePullPolicy: "",
ports:
- containerPort: 0,
  name: "",
  protocol: ""
resources:
  requests:
    cpu: ""
    memory: ""
  limits:
    cpu: ""
    memory: ""
```

每个容器有一个镜像，如果指定了命令，它将替换 Docker 镜像的命令。它还有参数和环境变量。当然，还有镜像拉取策略、端口和资源限制。我们在前面的章节中已经介绍过这些。

如果你想进一步探索 Pod 资源或其他 Kubernetes 资源，以下命令非常有用：`kubectl explain`。

它可以探索资源以及特定的子资源和字段。

尝试以下命令：

```bash
kubectl explain pod
kubectl explain pod.spec
```

### 在 Pod 中部署长时间运行的微服务

长时间运行的微服务应该在 Pod 中运行并且是无状态的。让我们看看如何为 Hue 的其中一个微服务——Hue 学习器（Hue learner）——创建 Pod，该服务负责学习用户在不同领域的偏好。稍后，我们将提升抽象层次并使用 Deployment。

#### 创建 Pods

让我们从一个常规的 Pod 配置文件开始，用于创建 Hue 学习器内部服务。该服务不需要作为公共服务暴露，它将监听队列以获取通知，并将其洞察存储在某种持久化存储中。

我们需要一个在 Pod 中运行的简单容器。以下可能是最简单的 Dockerfile，它将模拟 Hue 学习器：

```dockerfile
FROM busybox
CMD ash -c "echo 'Started...'; while true ; do sleep 10 ; done"
```

它使用 busybox 基础镜像，向标准输出打印 `Started...`，然后进入无限循环，这无论如何都算作长时间运行。

我已经构建了两个 Docker 镜像，标记为 `g1g1/hue-learn:0.3` 和 `g1g1/hue-learn:0.4`，并将它们推送到 Docker Hub 仓库（`g1g1` 是我的用户名）：

```bash
$ docker build . -t g1g1/hue-learn:0.3
$ docker build . -t g1g1/hue-learn:0.4
$ docker push g1g1/hue-learn:0.3
$ docker push g1g1/hue-learn:0.4
```

现在这些镜像可以被拉取到 Hue 的 Pod 内部的容器中。

我们将在这里使用 YAML，因为它更简洁且更易于人类阅读。以下是样板和元数据标签：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hue-learner
  labels:
    app: hue
    service: learner
    runtime-environment: production
    tier: internal-service
```

接下来是重要的容器规格（containers spec），它为每个容器定义了必需的 `name` 和 `image`：

```yaml
spec:
  containers:
  - name: hue-learner
    image: g1g1/hue-learn:0.3
```

`resources` 部分告诉 Kubernetes 容器的资源需求，从而允许更高效和紧凑的调度和分配。在这里，容器请求 200 毫核 CPU 单元（0.2 核）和 256 MiB（2 的 28 次方字节）：

```yaml
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
```

`env` 部分允许集群管理员提供将在容器中可用的环境变量。这里它告诉容器通过 DNS 发现队列和存储。在测试环境中，它可能使用不同的发现方法：

```yaml
  env:
  - name: DISCOVER_QUEUE
    value: dns
  - name: DISCOVER_STORE
    value: dns
```

### 用标签装饰 Pods

明智地标记 Pod 是灵活操作的关键。它让你能够实时演进集群，将微服务组织成可以统一操作的组，并随时深入观察不同的子集。

例如，我们的 Hue 学习器 Pod 有以下标签（以及其他几个标签）：

- `runtime-environment: production`
- `tier: internal-service`

`runtime-environment` 标签允许对属于某个环境的所有 Pod 执行全局操作。`tier` 标签可用于查询属于特定层的所有 Pod。这些只是示例；你的想象力是唯一限制。

以下是使用 `get pods` 命令列出标签的方法：

```bash
$ k get po -n kube-system --show-labels
NAME                               READY   STATUS    RESTARTS   AGE   LABELS
coredns-64897985d-gzrm4            1/1     Running   0          2d2h   app=kube-dns,pod-template-hash=64897985d
coredns-64897985d-m8nm9            1/1     Running   0          2d2h   app=kube-dns,pod-template-hash=64897985d
etcd-kind-control-plane            1/1     Running   0          2d2h   component=etcd,tier=control-plane
kindnet-wx7kl                      1/1     Running   0          2d2h   app=kindnet,controller-revision-hash=9d779cb4d,k8s-app=kindnet,pod-template-generation=1,tier=node
kube-apiserver-kind-control-plane   1/1     Running   0          2d2h   component=kube-apiserver,tier=control-plane
kube-controller-manager-kind-control-plane  1/1  Running   0     2d2h   component=kube-controller-manager,tier=control-plane
kube-proxy-bgcrq                   1/1     Running   0          2d2h   controller-revision-hash=664d4bb79f,k8s-app=kube-proxy,pod-template-generation=1
kube-scheduler-kind-control-plane  1/1     Running   0          2d2h   component=kube-scheduler,tier=control-plane
```

现在，如果你想要过滤并只列出 kube-dns Pod，输入以下命令：

```bash
$ k get po -n kube-system -l k8s-app=kube-dns
NAME                       READY   STATUS    RESTARTS   AGE
coredns-64897985d-gzrm4    1/1     Running   0          2d2h
coredns-64897985d-m8nm9    1/1     Running   0          2d2h
```

### 使用 Deployments 部署长时间运行的进程

在大规模系统中，Pod 绝不能被随意创建后就不管不问。如果一个 Pod 因任何原因意外死亡，你需要另一个 Pod 来替换它以维持整体容量。你可以自己创建 ReplicationController 或 ReplicaSet，但这为错误和部分故障留下了空间。以声明方式指定你希望启动 Pod 时拥有的副本数量要合理得多。这就是 Kubernetes Deployment 的用途。

让我们使用 Kubernetes Deployment 资源部署三个 Hue 学习器微服务实例：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hue-learn
  labels:
    app: hue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hue
  template:
    metadata:
      labels:
        app: hue
    spec:
      containers:
      - name: hue-learner
        image: g1g1/hue-learn:0.3
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
        env:
        - name: DISCOVER_QUEUE
          value: dns
        - name: DISCOVER_STORE
          value: dns
```

Pod 规范与之前 Pod 配置文件中的 spec 部分相同。

让我们创建 Deployment 并检查其状态：

```bash
$ k create -f hue-learn-deployment.yaml
deployment.apps/hue-learn created
$ k get deployment hue-learn
NAME        READY   UP-TO-DATE   AVAILABLE   AGE
hue-learn   3/3     3            3           25s
$ k get pods -l app=hue
NAME                        READY   STATUS    RESTARTS   AGE
hue-learn-67d4649b58-qhc88  1/1     Running   0          45s
hue-learn-67d4649b58-qpm2q  1/1     Running   0          45s
hue-learn-67d4649b58-tzzq7  1/1     Running   0          45s
```

你可以使用 `kubectl describe` 命令获取更多关于 Deployment 的信息：

```bash
$ k describe deployment hue-learn
Name:                   hue-learn
Namespace:              default
CreationTimestamp:      Tue, 21 Jun 2022 21:11:50 -0700
Labels:                 app=hue
Annotations:            deployment.kubernetes.io/revision: 1
Selector:               app=hue
Replicas:               3 desired | 3 updated | 3 total | 3 available | 0 unavailable
StrategyType:           RollingUpdate
MinReadySeconds:        0
RollingUpdateStrategy:  25% max unavailable, 25% max surge
Pod Template:
  Labels:       app=hue
  Containers:
   hue-learner:
    Image:      g1g1/hue-learn:0.3
    Port:       <none>
    Host Port:  <none>
    Requests:
      cpu:      200m
      memory:   256Mi
    Environment:
      DISCOVER_QUEUE:  dns
      DISCOVER_STORE:  dns
    Mounts:            <none>
  Volumes:             <none>
Conditions:
  Type           Status  Reason
  ----           ------  ------
  Available      True    MinimumReplicasAvailable
  Progressing    True    NewReplicaSetAvailable
OldReplicaSets:  <none>
NewReplicaSet:   hue-learn-67d4649b58 (3/3 replicas created)
Events:
  Type    Reason             Age    From                   Message
  ----    ------             ----   ----                   -------
  Normal  ScalingReplicaSet  106s   deployment-controller  Scaled up replica set hue-learn-67d4649b58 to 3
```

#### 更新 Deployment

Hue 平台是一个庞大且不断演进的系统。你需要持续升级。Deployment 可以以无痛的方式更新和推出新版本。你更改 Pod 模板即可触发完全由 Kubernetes 管理的滚动更新。目前，所有 Pod 都在运行版本 0.3：

```bash
$ k get pods -o jsonpath='{.items[*].spec.containers[0].image}' -l app=hue | xargs printf "%s\n"
g1g1/hue-learn:0.3
g1g1/hue-learn:0.3
g1g1/hue-learn:0.3
```

让我们更新 Deployment 以升级到版本 0.4。修改 Deployment 文件中的镜像版本。不要修改标签，这会导致错误。将其保存为 `hue-learn-deployment-0.4.yaml`。然后我们可以使用 `kubectl apply` 命令升级版本，并验证 Pod 现在运行的是 0.4：

```bash
$ k apply -f hue-learn-deployment-0.4.yaml
Warning: resource deployments/hue-learn is missing the kubectl.kubernetes.io/last-applied-configuration annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.
deployment.apps/hue-learn configured
$ k get pods -o jsonpath='{.items[*].spec.containers[0].image}' -l app=hue | xargs printf "%s\n"
g1g1/hue-learn:0.4
g1g1/hue-learn:0.4
g1g1/hue-learn:0.4
```

注意，新的 Pod 被创建，原始的 0.3 Pod 以滚动更新的方式被终止。

```bash
$ kubectl get pods
NAME                        READY   STATUS        RESTARTS   AGE
hue-learn-67d4649b58-fgt7m  1/1     Terminating   0          99s
hue-learn-67d4649b58-klhz5  1/1     Terminating   0          100s
hue-learn-67d4649b58-lgpl9  1/1     Terminating   0          101s
hue-learn-68d74fd4b7-bxxnm  1/1     Running       0          4s
hue-learn-68d74fd4b7-fh55c  1/1     Running       0          3s
hue-learn-68d74fd4b7-rnsj4  1/1     Running       0          2s
```

我们已经介绍了 `kubectl` 清单文件的结构，以及如何应用它们来部署和更新集群上的工作负载。接下来，让我们看看这些工作负载如何通过内部服务发现和相互调用，以及如何通过外部暴露的服务从集群外部被调用。

### 分离内部和外部服务

内部服务是仅由集群中的其他服务或任务（或登录并运行临时工具的管理员）直接访问的服务。还有一些工作负载根本不被访问。这些工作负载可能监视某些事件并执行其功能，而不暴露任何 API。但有些服务需要暴露给用户或外部程序。让我们看一个假的 Hue 服务，它管理用户的提醒列表。它实际上做不了太多事情——只是返回一个固定的提醒列表——但我们将用它来说明如何暴露服务。我已经将 `hue-reminders` 镜像推送到了 Docker Hub：

```bash
docker push g1g1/hue-reminders:3.0
```

#### 部署内部服务

以下是 Deployment，它与 hue-learner 的 Deployment 非常相似，只是我省略了 annotations、env 和 resources 部分，只保留了一两个标签以节省空间，并为容器添加了一个 `ports` 部分。这很关键，因为服务必须暴露一个端口，其他服务可以通过该端口访问它：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hue-reminders
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hue
      service: reminders
  template:
    metadata:
      name: hue-reminders
      labels:
        app: hue
        service: reminders
    spec:
      containers:
      - name: hue-reminders
        image: g1g1/hue-reminders:3.0
        ports:
        - containerPort: 8080
```

当我们运行 Deployment 时，两个 `hue-reminders` Pod 被添加到集群中：

```bash
$ k create -f hue-reminders-deployment.yaml
deployment.apps/hue-reminders created
$ k get pods
NAME                              READY   STATUS    RESTARTS   AGE
hue-learn-68d74fd4b7-bxxnm       1/1     Running   0          12h
hue-learn-68d74fd4b7-fh55c       1/1     Running   0          12h
hue-learn-68d74fd4b7-rnsj4       1/1     Running   0          12h
hue-reminders-9bdcd7489-4jqhc    1/1     Running   0          11s
hue-reminders-9bdcd7489-bxh59    1/1     Running   0          11s
```

好的。Pod 正在运行。理论上，其他服务可以查找或配置其内部 IP 地址，然后直接访问它们，因为它们都在同一个网络地址空间中。但这无法扩展。每次提醒 Pod 终止并被新 Pod 替换，或者当我们只是扩展 Pod 数量时，所有访问这些 Pod 的服务都必须知道这一点。Kubernetes Service 通过为共享一组选择器标签的所有 Pod 提供一个稳定的单一访问点来解决这个问题。以下是 Service 的定义：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hue-reminders
  labels:
    app: hue
    service: reminders
spec:
  ports:
  - port: 8080
    targetPort: 80
    protocol: TCP
  selector:
    app: hue
    service: reminders
```

Service 有一个选择器（selector），通过匹配标签来确定后端 Pod。它还暴露了一个端口，其他服务将使用该端口来访问它。该端口不必与容器的端口相同。你可以定义一个 `targetPort`。

`protocol` 字段可以是以下之一：`TCP`、`UDP`，或（自 Kubernetes 1.12 起）`SCTP`。

#### 创建 hue-reminders 服务

让我们创建该服务并对其进行探索：

```bash
$ k create -f hue-reminders-service.yaml
service/hue-reminders created
$ k describe svc hue-reminders
Name:              hue-reminders
Namespace:         default
Labels:            app=hue
                   service=reminders
Annotations:       <none>
Selector:          app=hue,service=reminders
Type:              ClusterIP
IP Family Policy:  SingleStack
IP Families:       IPv4
IP:                10.96.152.254
IPs:               10.96.152.254
Port:              <unset>  8080/TCP
TargetPort:        8080/TCP
Endpoints:         10.244.0.32:8080,10.244.0.33:8080
Session Affinity:  None
Events:            <none>
```

该服务已启动并运行。其他 Pod 可以通过环境变量或 DNS 找到它。所有服务的环境变量都是在 Pod 创建时设置的。这意味着如果某个 Pod 在你创建服务时已经在运行，你将不得不杀死它并让 Kubernetes 用新服务的环境变量重新创建它。

例如，Pod `hue-learn-68d74fd4b7-bxxnm` 是在 `hue-reminders` 服务创建之前创建的，因此它没有 `HUE_REMINDERS_SERVICE` 的环境变量。打印该 Pod 的环境变量显示该环境变量不存在：

```bash
$ k exec hue-learn-68d74fd4b7-bxxnm -- printenv | grep HUE_REMINDERS_SERVICE
```

让我们杀死这个 Pod，当新的 Pod 替换它时，再试一次：

```bash
$ k delete po hue-learn-68d74fd4b7-bxxnm
pod "hue-learn-68d74fd4b7-bxxnm" deleted
```

让我们再次检查 hue-learn Pod：

```bash
$ k get pods | grep hue-learn
hue-learn-68d74fd4b7-fh55c    1/1     Running   0          13h
hue-learn-68d74fd4b7-rnsj4    1/1     Running   0          13h
hue-learn-68d74fd4b7-rw4qr    1/1     Running   0          2m
```

很好。我们有一个全新的 Pod——`hue-learn-68d74fd4b7-rw4qr`。让我们看看它是否有 `HUE_REMINDERS_SERVICE` 服务的环境变量：

```bash
$ k exec hue-learn-68d74fd4b7-rw4qr -- printenv | grep HUE_REMINDERS_SERVICE
HUE_REMINDERS_SERVICE_PORT=8080
HUE_REMINDERS_SERVICE_HOST=10.96.152.254
```

是的，它有了！但使用 DNS 要简单得多。Kubernetes 为每个服务分配一个内部 DNS 名称。

服务 DNS 名称为：

```
<service name>.<namespace>.svc.cluster.local
```

```bash
$ kubectl exec hue-learn-68d74fd4b7-rw4qr -- nslookup hue-reminders.default.svc.cluster.local
Server:    10.96.0.10
Address:   10.96.0.10:53
Name:      hue-reminders.default.svc.cluster.local
Address:   10.96.152.254
```

现在，集群中的每个 Pod 都可以通过其服务端点和端口 8080 访问 `hue-reminders` 服务：

```bash
$ kubectl exec hue-learn-68d74fd4b7-fh55c -- wget -q -O - hue-reminders.default.svc.cluster.local:8080
Dentist appointment at 3pm
Dinner at 7pm
```

是的，目前 `hue-reminders` 总是返回相同的两个提醒：

```
Dentist appointment at 3pm
Dinner at 7pm
```

这仅用于演示目的。如果 `hue-reminders` 是一个真实的系统，它将返回实时和动态的提醒。

现在我们已经介绍了内部服务以及如何访问它们，让我们来看看外部服务。

### 外部暴露服务

该服务在集群内部是可访问的。如果你想将其暴露给外部世界，Kubernetes 提供了几种方式：

- 配置 NodePort 进行直接访问
- 如果在云环境中运行，配置云负载均衡器
- 如果在裸机上运行，配置你自己的负载均衡器

在配置外部访问服务之前，你应该确保它是安全的。我们已经在第 4 章"保护 Kubernetes"中介绍了这方面原则。Kubernetes 文档中有一个很好的示例，涵盖了所有细节：https://github.com/kubernetes/examples/blob/master/staging/https-nginx/README.md。

以下是通过 NodePort 向外部暴露时的 `hue-reminders` 服务的 spec 部分：

```yaml
spec:
  type: NodePort
  ports:
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: http
  - port: 443
    protocol: TCP
    name: https
  selector:
    app: hue-reminders
```

通过 NodePort 暴露服务的主要缺点是端口号在所有服务之间共享。你必须在整个集群中全局协调它们以避免冲突。对于拥有大量开发人员部署服务的大规模集群来说，这并非易事。

但还有其他原因你可能希望避免直接暴露 Kubernetes 服务，例如安全性和缺乏抽象，你可能更倾向于在服务前面使用 Ingress 资源。

#### Ingress

Ingress 是一个 Kubernetes 配置对象，允许你将服务暴露给外部世界，并处理许多细节。它可以完成以下功能：

- 为你的服务提供一个外部可见的 URL
- 负载均衡流量
- 终止 SSL
- 提供基于名称的虚拟主机

要使用 Ingress，你必须在集群中运行一个 Ingress 控制器。Ingress 在 Kubernetes 1.1 中引入，并在 Kubernetes 1.19 中变得稳定。Ingress 控制器目前的限制之一是它不适用于大规模场景。因此，它还不是 Hue 平台的好选择。我们将在第 10 章"探索 Kubernetes 网络"中更详细地介绍 Ingress 控制器。

以下是 Ingress 资源的样子：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: minimal-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx-example
  rules:
  - http:
      paths:
      - path: /testpath
        pathType: Prefix
        backend:
          service:
            name: test
            port:
              number: 80
```

注意注解，它暗示这是一个与 Nginx Ingress 控制器配合使用的 Ingress 对象。还有许多其他 Ingress 控制器，它们通常使用注解来编码 Ingress 对象本身及其规则未捕获的信息。

其他 Ingress 控制器包括：

- Traefik
- Gloo
- Contour
- AWS ALB Ingress 控制器
- HAProxy Ingress
- Voyager

可以创建 `IngressClass` 资源并在 Ingress 资源中指定。如果未指定，则使用默认的 `IngressClass`。

在本节中，我们了解了 Hue 平台的不同组件如何通过 Service 发现和相互通信，以及如何将面向公众的服务暴露给外部世界。在下一节中，我们将探讨如何高效且经济地在 Kubernetes 上调度 Hue 的工作负载。

## 高级调度

Kubernetes 最强大的优势之一是其强大而灵活的调度器。简单来说，调度器的工作是选择节点来运行新创建的 Pod。理论上，调度器甚至可以在节点之间移动现有的 Pod，但实际上，它目前不这样做，而是将这个功能留给其他组件。

默认情况下，调度器遵循几个指导原则，包括：

- 将同一 ReplicaSet 或 StatefulSet 中的 Pod 分散到不同节点
- 将 Pod 调度到有足够资源满足 Pod 请求的节点上
- 平衡节点的整体资源利用率

这是相当不错的默认行为，但有时你可能希望对特定的 Pod 放置有更好的控制。Kubernetes 1.6 引入了几个高级调度选项，让你可以精细控制哪些 Pod 被调度或不被调度到哪些节点上，以及哪些 Pod 应该被调度在一起或分开。

让我们在 Hue 的上下文中回顾这些机制。

首先，让我们创建一个带有两个工作节点的 k3d 集群：

```bash
$ k3d cluster create --agents 2
...
INFO[0026] Cluster 'k3s-default' created successfully!
$ k get no
NAME                     STATUS   ROLES                  AGE   VERSION
k3d-k3s-default-agent-0   Ready    <none>                 22s   v1.23.6+k3s1
k3d-k3s-default-agent-1   Ready    <none>                 22s   v1.23.6+k3s1
k3d-k3s-default-server-0  Ready    control-plane,master   31s   v1.23.6+k3s1
```

让我们看看 Pod 可以被调度到节点上的各种方式，以及每种方法何时适用。

### 节点选择器（Node Selector）

节点选择器非常简单。Pod 可以在其 spec 中指定它希望被调度到哪些节点上。例如，trouble-shooter Pod 有一个 `nodeSelector`，指定了 `worker-2` 节点的 `kubernetes.io/hostname` 标签：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: trouble-shooter
  labels:
    role: trouble-shooter
spec:
  nodeSelector:
    kubernetes.io/hostname: k3d-k3s-default-agent-1
  containers:
  - name: trouble-shooter
    image: g1g1/py-kube:0.3
    command: ["bash"]
    args: ["-c", "echo started...; while true ; do sleep 1 ; done"]
```

创建这个 Pod 时，它确实被调度到了 `k3d-k3s-default-agent-1` 节点上：

```bash
$ k apply -f trouble-shooter.yaml
pod/trouble-shooter created
$ k get po trouble-shooter -o jsonpath='{.spec.nodeName}'
k3d-k3s-default-agent-1
```

### 污点和容忍度（Taints and Tolerations）

你可以给节点打上污点（taint），以防止 Pod 被调度到该节点上。例如，如果你不希望 Pod 被调度到控制平面节点上，这将非常有用。容忍度（tolerations）允许 Pod 声明它们可以"容忍"特定的节点污点，然后这些 Pod 就可以被调度到带有污点的节点上。一个节点可以有多个污点，一个 Pod 可以有多个容忍度。一个污点是一个三元组：键（key）、值（value）、效果（effect）。键和值用于标识污点。效果是以下之一：

- **NoSchedule**：除非 Pod 容忍该污点，否则不会有 Pod 被调度到该节点
- **PreferNoSchedule**：`NoSchedule` 的软版本；调度器将尝试不调度不容忍该污点的 Pod
- **NoExecute**：不会调度新的 Pod，而且不容忍该污点的现有 Pod 将被驱逐

让我们在我们的 k3d 集群上部署 `hue-learn` 和 `hue-reminders`：

```bash
$ k apply -f hue-learn-deployment.yaml
deployment.apps/hue-learn created
$ k apply -f hue-reminders-deployment.yaml
deployment.apps/hue-reminders created
```

目前，有一个 `hue-learn` Pod 运行在控制平面节点（`k3d-k3s-default-server-0`）上：

```bash
$ k get po -o wide
NAME                              READY   STATUS    RESTARTS   AGE     IP           NODE                     NOMINATED NODE   READINESS GATES
hue-learn-67d4649b58-tklxf       1/1     Running   0          2m20s   10.42.2.4    k3d-k3s-default-server-0   <none>           <none>
hue-learn-67d4649b58-wk55w       1/1     Running   0          18s     10.42.1.8    k3d-k3s-default-agent-0    <none>           <none>
hue-learn-67d4649b58-jkwwg       1/1     Running   0          18s     10.42.0.3    k3d-k3s-default-agent-1    <none>           <none>
hue-reminders-9bdcd7489-2j65p    1/1     Running   0          6s      10.42.2.5    k3d-k3s-default-agent-1    <none>           <none>
hue-reminders-9bdcd7489-wntpx    1/1     Running   0          6s      10.42.0.4    k3d-k3s-default-agent-0    <none>           <none>
trouble-shooter                  1/1     Running   0          6s      10.42.2.6    k3d-k3s-default-agent-1    <none>           <none>
```

让我们给控制平面节点打上污点：

```bash
$ k taint nodes k3d-k3s-default-server-0 control-plane=true:NoExecute
node/k3d-k3s-default-server-0 tainted
```

我们现在可以查看污点：

```bash
$ k get nodes k3d-k3s-default-server-0 -o jsonpath='{.spec.taints[0]}'
map[effect:NoExecute key:control-plane value:true]
```

太好了，它生效了！现在主节点上没有 Pod 被调度。`k3d-k3s-default-server-0` 上的 `hue-learn` Pod 被驱逐，一个新的 Pod（`hue-learn-67d4649b58-bl8cn`）现在运行在 `k3d-k3s-default-agent-0` 上：

```bash
$ k get po -o wide
NAME                              READY   STATUS    RESTARTS   AGE     IP           NODE                     NOMINATED NODE   READINESS GATES
hue-learn-67d4649b58-wk55w       1/1     Running   0          33m     10.42.0.3    k3d-k3s-default-agent-0    <none>           <none>
hue-learn-67d4649b58-jkwwg       1/1     Running   0          31m     10.42.2.5    k3d-k3s-default-agent-1    <none>           <none>
hue-reminders-9bdcd7489-2j65p    1/1     Running   0          30m     10.42.2.6    k3d-k3s-default-agent-1    <none>           <none>
hue-reminders-9bdcd7489-wntpx    1/1     Running   0          30m     10.42.0.4    k3d-k3s-default-agent-0    <none>           <none>
hue-learn-67d4649b58-bl8cn       1/1     Running   0          2m53s   10.42.0.5    k3d-k3s-default-agent-0    <none>           <none>
trouble-shooter                  1/1     Running   0          31m     10.42.2.4    k3d-k3s-default-agent-1    <none>           <none>
```

要允许 Pod 容忍污点，在其 spec 中添加容忍度，例如：

```yaml
tolerations:
- key: "control-plane"
  operator: "Equal"
  value: "true"
  effect: "NoSchedule"
```

### 节点亲和性与反亲和性（Node Affinity and Anti-Affinity）

节点亲和性是 `nodeSelector` 的一种更复杂的形式。它有三个主要优势：

- **丰富的选择标准**（`nodeSelector` 只是标签精确匹配的 AND 运算）
- **规则可以是软性的**
- **你可以使用 `NotIn` 和 `DoesNotExist` 等运算符实现反亲和性**

请注意，如果你同时指定了 `nodeSelector` 和 `nodeAffinity`，那么 Pod 只会被调度到同时满足这两个要求的节点上。

例如，如果我们将以下部分添加到我们的 `trouble-shooter` Pod 中，它将无法在任何节点上运行，因为它与 `nodeSelector` 冲突：

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/hostname
          operator: NotIn
          values:
          - k3d-k3s-default-agent-1
```

### Pod 亲和性与反亲和性（Pod Affinity and Anti-Affinity）

Pod 亲和性和反亲和性提供了管理工作负载运行位置的另一种途径。我们迄今为止讨论的所有方法——节点选择器、污点/容忍度、节点亲和性/反亲和性——都是关于将 Pod 分配到节点。但 Pod 亲和性是关于不同 Pod 之间的关系。

Pod 亲和性还有其他几个相关概念：命名空间（因为 Pod 是有命名空间的）、拓扑区域（节点、机架、云提供商可用区、云提供商地域）和权重（用于首选调度）。一个简单的例子是，如果你希望 `hue-reminders` 总是与 `trouble-shooter` Pod 调度在一起。让我们看看如何在 `hue-reminders` Deployment 的 Pod 模板 spec 中定义它：

```yaml
affinity:
  podAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchExpressions:
        - key: role
          operator: In
          values:
          - trouble-shooter
      topologyKey: topology.kubernetes.io/zone # 适用于云提供商的集群
```

拓扑键（topology key）是一个节点标签，Kubernetes 在调度时将其视为相同。在云提供商上，当工作负载应彼此接近运行时，建议使用 `topology.kubernetes.io/zone`。在云环境中，zone 相当于数据中心。

然后，在重新部署 `hue-reminders` 后，所有 `hue-reminders` Pod 都被调度到 `k3d-k3s-default-agent-1` 上，与 `trouble-shooter` Pod 相邻：

```bash
$ k apply -f hue-reminders-deployment-with-pod-affinity.yaml
deployment.apps/hue-reminders configured
$ k get po -o wide
NAME                              READY   STATUS    RESTARTS   AGE    IP           NODE                     NOMINATED NODE   READINESS GATES
hue-learn-67d4649b58-wk55w       1/1     Running   0          117m   10.42.2.4    k3d-k3s-default-agent-0    <none>           <none>
hue-learn-67d4649b58-jkwwg       1/1     Running   0          115m   10.42.0.3    k3d-k3s-default-agent-1    <none>           <none>
hue-learn-67d4649b58-bl8cn       1/1     Running   0          87m    10.42.0.5    k3d-k3s-default-agent-0    <none>           <none>
hue-reminders-544d96785b-pd62t   0/1     Pending   0          50s    10.42.2.4    k3d-k3s-default-agent-1    <none>           <none>
hue-reminders-544d96785b-wpmjj   0/1     Pending   0          50s    10.42.2.4    k3d-k3s-default-agent-1    <none>           <none>
trouble-shooter                  1/1     Running   0          115m   10.42.2.4    k3d-k3s-default-agent-1    <none>           <none>
```

### Pod 拓扑分布约束（Pod Topology Spread Constraints）

节点亲和性/反亲和性和 Pod 亲和性/反亲和性有时过于严格。你可能希望分散你的 Pod——同一个 Deployment 的某些 Pod 最终落在同一个节点上是可以接受的。Pod 拓扑分布约束为你提供了这种灵活性。你可以指定最大偏差（max skew），即与最佳分布的偏离程度，以及在约束无法满足时的行为（`DoNotSchedule` 或 `ScheduleAnyway`）。

以下是带有 Pod 拓扑分布约束的 `hue-reminders` Deployment：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hue-reminders
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hue
      service: reminders
  template:
    metadata:
      name: hue-reminders
      labels:
        app: hue
        service: reminders
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: node.kubernetes.io/instance-type
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: hue
            service: hue-reminders
      containers:
      - name: hue-reminders
        image: g1g1/hue-reminders:3.0
        ports:
        - containerPort: 80
```

我们可以看到，在应用清单后，三个 Pod 被分散到两个 agent 节点上（回想一下，server 节点有污点）：

```bash
$ k apply -f hue-reminders-deployment-with-spread-constraints.yaml
deployment.apps/hue-reminders created
$ k get po -o wide -l app=hue,service=reminders
NAME                              READY   STATUS    RESTARTS   AGE     IP            NODE                     NOMINATED NODE   READINESS GATES
hue-reminders-6664fccb8f-8bvf6   1/1     Running   0          4m40s   10.42.0.11    k3d-k3s-default-agent-0    <none>           <none>
hue-reminders-6664fccb8f-8qrbl   1/1     Running   0          3m59s   10.42.0.12    k3d-k3s-default-agent-0    <none>           <none>
hue-reminders-6664fccb8f-b5pbp   1/1     Running   0          56s     10.42.2.14    k3d-k3s-default-agent-1    <none>           <none>
```

### Descheduler

Kubernetes 非常擅长根据复杂的放置规则将 Pod 调度到节点上。但是，一旦 Pod 被调度，如果原始条件发生变化，Kubernetes 不会将其移动到另一个节点。以下是一些受益于工作负载迁移的使用场景：

- 某些节点正在经历利用不足或利用过度
- 当节点上的污点或标签被修改时，初始调度决策不再有效，导致 Pod/节点亲和性要求不再满足
- 某些节点遇到故障，导致其 Pod 迁移到其他节点
- 向集群中引入额外的节点

这就是 descheduler 发挥作用的地方。Descheduler 不是原生 Kubernetes 的一部分。你需要安装它并定义策略来决定哪些正在运行的 Pod 可以被驱逐。它可以作为 Job、CronJob 或 Deployment 运行。Descheduler 将定期检查 Pod 的当前放置情况，并驱逐违反某些策略的 Pod。这些 Pod 将被重新调度，然后标准的 Kubernetes 调度器将根据当前条件负责调度它们。

请在此处查看：https://github.com/kubernetes-sigs/descheduler。

在本节中，我们了解了 Kubernetes 提供的高级调度机制，以及像 descheduler 这样的项目，如何帮助 Hue 在可用基础设施上以最佳方式调度其工作负载。在下一节中，我们将探讨如何将 Hue 的工作负载划分到命名空间，以管理对不同资源的访问。

## 使用命名空间限制访问

Hue 项目进展顺利，我们有几百个微服务和大约 100 名开发人员和 DevOps 工程师在从事这项工作。相关的微服务组出现了，你注意到这些组中的许多都是相当自治的。它们完全不知道其他组的存在。此外，还有一些敏感领域，如健康和金融，你希望更有效地控制对这些领域的访问。这就轮到命名空间上场了。

让我们创建一个新服务 `hue-finance`，并将其放在一个名为 `restricted` 的新命名空间中。

以下是新的 `restricted` 命名空间的 YAML 文件：

```yaml
kind: Namespace
apiVersion: v1
metadata:
  name: restricted
  labels:
    name: restricted
```

我们可以像往常一样创建它：

```bash
$ kubectl create -f restricted-namespace.yaml
namespace "restricted" created
```

一旦创建了命名空间，我们就可以为该命名空间配置一个上下文：

```bash
$ k config set-context k3d-k3s-restricted --cluster k3d-k3s-default --namespace=restricted --user restricted@k3d-k3s-default
Context "restricted" created.
$ k config use-context restricted
Switched to context "restricted".
```

让我们检查集群配置：

```yaml
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: DATA+OMITTED
    server: https://0.0.0.0:53829
    name: k3d-k3s-default
contexts:
- context:
    cluster: k3d-k3s-default
    user: admin@k3d-k3s-default
    name: k3d-k3s-default
- context:
    cluster: ""
    namespace: restricted
    user: restricted@k3d-k3s-default
    name: restricted
current-context: restricted
kind: Config
preferences: {}
users:
- name: admin@k3d-k3s-default
  user:
    client-certificate-data: REDACTED
    client-key-data: REDACTED
```

如你所见，现在有两个上下文，当前上下文是 `restricted`。如果我们愿意，我们甚至可以创建具有自己凭证的专用用户，这些凭证被允许在 `restricted` 命名空间中操作。根据环境的不同，这可能容易也可能困难，并且可能涉及通过 Kubernetes 证书颁发机构创建证书。云提供商提供与其 IAM 系统的集成。

为了继续，我将使用 `admin@k3d-k3s-default` 用户的凭证，并直接在集群的 kubeconfig 文件中创建一个名为 `restricted@k3d-k3s-default` 的用户：

```yaml
users:
- name: restricted@k3d-k3s-default
  user:
    client-certificate-data: REDACTED
    client-key-data: REDACTED
```

现在，在这个空的命名空间中，我们可以创建 `hue-finance` 服务，它将与 `default` 命名空间中的其他服务隔离：

```bash
$ k create -f hue-finance-deployment.yaml
deployment.apps/hue-finance created
$ k get pods
NAME                              READY   STATUS    RESTARTS   AGE
hue-finance-84c445f684-vh8qv     1/1     Running   0          7s
hue-finance-84c445f684-fjkxs     1/1     Running   0          7s
hue-finance-84c445f684-sppkq     1/1     Running   0          7s
```

你不必切换上下文。你也可以使用 `--namespace=<namespace>` 和 `--all-namespaces` 命令行开关，但当你需要在同一个非默认命名空间中操作一段时间时，将上下文设置为该命名空间会更方便。

## 使用 Kustomization 实现分层集群结构

这不是笔误。Kubectl 最近集成了 Kustomize（https://kustomize.io/）的功能。这是一种无需模板即可配置 Kubernetes 的方式。关于 Kustomize 功能如何集成到 `kubectl` 本身，曾有很多争议，因为还有其他选项，并且 `kubectl` 是否应该如此具有主见是一个悬而未决的问题。但是，这些都已成为过去。关键是 `kubectl apply -k` 解锁了大量的配置选项。让我们了解它能帮助我们解决什么问题，并利用它来帮助我们管理 Hue。

### 理解 Kustomize 基础

Kustomize 是为了回应像 Helm 这样的模板驱动方法而创建的，用于配置和定制 Kubernetes 集群。它是围绕声明式应用管理的原则而设计的。它接受一个有效的 Kubernetes YAML 清单（基础/base），并通过叠加额外的 YAML 补丁（overlays）来特化或扩展它。Overlays 依赖于它们的基础（bases）。所有文件都是有效的 YAML 文件。没有占位符。

一个 `kustomization.yaml` 文件控制整个过程。任何包含 `kustomization.yaml` 文件的目录被称为一个根（root）。例如：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: staging
commonLabels:
  environment: staging
bases:
- ../base
patchesStrategicMerge:
- hue-learn-patch.yaml
resources:
- namespace.yaml
```

Kustomize 在 GitOps 环境中可以很好地工作，不同的 Kustomization 存在于 Git 仓库中，对 bases、overlays 或 `kustomization.yaml` 文件的更改会触发部署。

Kustomize 最好的用例之一是将你的系统组织到多个命名空间中，例如 staging 和 production。让我们重新组织 Hue 平台的部署清单。

### 配置目录结构

首先，我们需要一个 base 目录，其中包含所有清单的共性。然后我们将有一个 `overlays` 目录，其中包含 staging 和 production 子目录：

```
$ tree
.
├── base
│   ├── hue-learn.yaml
│   └── kustomization.yaml
└── overlays
    ├── production
    │   ├── kustomization.yaml
    │   └── namespace.yaml
    └── staging
        ├── hue-learn-patch.yaml
        ├── kustomization.yaml
        └── namespace.yaml
```

base 目录中的 `hue-learn.yaml` 文件只是一个示例。那里可能有许多文件。让我们快速回顾一下：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hue-learner
  labels:
    tier: internal-service
spec:
  containers:
  - name: hue-learner
    image: g1g1/hue-learn:0.3
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
    env:
    - name: DISCOVER_QUEUE
      value: dns
    - name: DISCOVER_STORE
      value: dns
```

它与我们之前创建的清单非常相似，但没有 `app: hue` 标签。这是不必要的，因为该标签由 `kustomization.yaml` 文件作为所有列出资源的通用标签提供：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
commonLabels:
  app: hue
resources:
- hue-learn.yaml
```

### 应用 Kustomization

我们可以通过在 base 目录上运行 `kubectl kustomize` 命令来观察结果。你可以看到通用标签 `app: hue` 已被添加：

```bash
$ k kustomize base
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: hue
    tier: internal-service
  name: hue-learner
spec:
  containers:
  - env:
    - name: DISCOVER_QUEUE
      value: dns
    - name: DISCOVER_STORE
      value: dns
    image: g1g1/hue-learn:0.3
    name: hue-learner
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
```

为了实际部署 Kustomization，我们可以运行 `kubectl -k apply`。但是，base 不应该单独部署。让我们深入了解 `overlays/staging` 目录并检查它。

`namespace.yaml` 文件只是创建 `staging` 命名空间。它也将受益于所有的 Kustomization，我们很快就会看到：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: staging
```

`kustomization.yaml` 文件添加了通用标签 `environment: staging`。它依赖于 base 目录，并将 `namespace.yaml` 文件添加到资源列表中（该列表已包含来自 base 的 `hue-learn.yaml`）：

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: staging
commonLabels:
  environment: staging
bases:
- ../../base
patchesStrategicMerge:
- hue-learn-patch.yaml
resources:
- namespace.yaml
```

但这还不是全部。Kustomization 最有趣的部分是补丁（patching）。

### 补丁（Patching）

补丁添加或替换清单的部分内容。它们从不移除现有的资源或资源的某些部分。

`hue-learn-patch.yaml` 将镜像从 `g1g1/hue-learn:0.3` 更新为 `g1g1/hue-learn:0.4`：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hue-learner
spec:
  containers:
  - name: hue-learner
    image: g1g1/hue-learn:0.4
```

这是一种战略合并（strategic merge）。Kustomize 支持另一种类型的补丁，称为 `JsonPatches6902`。它基于 RFC 6902（https://tools.ietf.org/html/rfc6902）。它通常比战略合并更简洁。我们可以使用 YAML 语法来编写 JSON 6902 补丁。以下是使用 `JsonPatches6902` 语法将镜像版本改为 0.4 的相同补丁：

```yaml
- op: replace
  path: /spec/containers/0/image
  value: g1g1/hue-learn:0.4
```

### 对整个 staging 命名空间应用 Kustomize

以下是 Kustomize 在处理 `overlays/staging` 目录时生成的内容：

```bash
$ k kustomize overlays/staging
apiVersion: v1
kind: Namespace
metadata:
  labels:
    environment: staging
  name: staging
---
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: hue
    environment: staging
    tier: internal-service
  name: hue-learner
  namespace: staging
spec:
  containers:
  - env:
    - name: DISCOVER_QUEUE
      value: dns
    - name: DISCOVER_STORE
      value: dns
    image: g1g1/hue-learn:0.4
    name: hue-learner
    resources:
      requests:
        cpu: 200m
        memory: 256Mi
```

注意，命名空间没有继承 base 中的 `app: hue` 标签，只继承了自己 Kustomization 文件中的 `environment: staging` 标签。另一方面，hue-learn Pod 获得了所有标签以及命名空间指定。

现在是将其部署到集群的时候了：

```bash
$ k apply -k overlays/staging
namespace/staging created
pod/hue-learner created
```

现在，我们可以在新创建的 `staging` 命名空间中查看 Pod：

```bash
$ k get po -n staging
NAME          READY   STATUS    RESTARTS   AGE
hue-learner   1/1     Running   0          21s
```

让我们检查一下 overlay 是否生效，镜像版本是否确实是 0.4：

```bash
$ k get po hue-learner -n staging -o jsonpath='{.spec.containers[0].image}'
g1g1/hue-learn:0.4
```

在本节中，我们介绍了 Kustomize 选项提供的强大结构化和可重用性。这对于像 Hue 平台这样的大型系统非常重要，其中许多工作负载可以从统一的结构和一致的基础中受益。在下一节中，我们将探讨如何启动短期任务。

## 启动 Jobs

Hue 已经发展壮大，拥有大量作为微服务部署的长时间运行进程，但它也有许多运行、完成某个目标然后退出的任务。Kubernetes 通过 Job 资源支持这种功能。Kubernetes Job 管理一个或多个 Pod，并确保它们运行直到成功或失败。如果 Job 管理的某个 Pod 失败或被删除，Job 将运行一个新的 Pod，直到成功。

Kubernetes 也有许多无服务器或函数即服务的解决方案，但它们都建立在原生 Kubernetes 之上。我们将在第 12 章"Kubernetes 上的无服务器计算"中深入介绍无服务器计算。

以下是运行 Python 进程计算 5 的阶乘（提示：是 120）的 Job：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: factorial5
spec:
  template:
    metadata:
      name: factorial5
    spec:
      containers:
      - name: factorial5
        image: g1g1/py-kube:0.3
        command: ["python", "-c", "import math; print(math.factorial(5))"]
      restartPolicy: Never
```

注意，`restartPolicy` 必须是 `Never` 或 `OnFailure`。默认值 `Always` 是无效的，因为 Job 在成功完成后不会重新启动。

让我们启动 Job 并检查其状态：

```bash
$ k create -f factorial-job.yaml
job.batch/factorial5 created
$ k get jobs
NAME         COMPLETIONS   DURATION   AGE
factorial5   1/1           4s         27s
```

已完成任务的 Pod 显示状态为 `Completed`。注意，Job Pod 有一个名为 `job-name` 的标签，其值为 Job 的名称，因此很容易只过滤出 Job Pod：

```bash
$ k get po -l job-name=factorial5
NAME               READY   STATUS      RESTARTS   AGE
factorial5-dddzz   0/1     Completed   0          114s
```

让我们检查一下日志中的输出：

```bash
$ k logs factorial5-dddzz
120
```

逐个启动 Job 对某些用例来说是可以的，但通常并行运行 Job 更有用。此外，在 Job 完成后清理它们以及定期运行 Job 也很重要。让我们看看如何做到这些。

### 并行运行 Jobs

你也可以使用并行度运行 Job。spec 中有两个字段叫做 `completions` 和 `parallelism`。`completions` 默认为 1。如果你需要多于一次的成功完成，则增加此值。`parallelism` 决定要启动多少个 Pod。即使 `parallelism` 数值更大，Job 也不会启动超过成功完成所需数量的 Pod。

让我们运行另一个 Job，它只需休眠 20 秒，直到有三次成功完成。我们将使用 6 的并行度因子，但只会启动 3 个 Pod：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: sleep20
spec:
  completions: 3
  parallelism: 6
  template:
    metadata:
      name: sleep20
    spec:
      containers:
      - name: sleep20
        image: g1g1/py-kube:0.3
        command: ["python", "-c", "import time; print('started...'); time.sleep(20); print('done.')"]
      restartPolicy: Never
```

让我们运行 Job 并等待所有 Pod 完成：

```bash
$ k create -f parallel-job.yaml
job.batch/sleep20 created
```

我们现在可以看到所有三个 Pod 都已完成，但 Pod 未就绪，因为它们已经完成了工作：

```bash
$ k get pods -l job-name=sleep20
NAME             READY   STATUS      RESTARTS   AGE
sleep20-fqgst   0/1     Completed   0          4m5s
sleep20-2dv8h   0/1     Completed   0          4m5s
sleep20-kvn28   0/1     Completed   0          4m5s
```

已完成的 Pod 不会占用节点上的资源，因此其他 Pod 可以在那里被调度。

### 清理已完成的 Jobs

当 Job 完成时，它会保留下来——它的 Pod 也一样。这是有意设计的，以便你可以查看日志或连接到 Pod 进行探索。但通常情况下，当 Job 成功完成后，就不再需要它了。你有责任清理已完成的 Job 及其 Pod。

最简单的方法就是删除 Job 对象，这也会删除所有 Pod：

```bash
$ kubectl get jobs
NAME         COMPLETIONS   DURATION   AGE
factorial5   1/1           2s         6h59m
sleep20      3/3           3m7s       5h54m
$ kubectl delete job factorial5
job.batch "factorial5" deleted
$ kubectl delete job sleep20
job.batch "sleep20" deleted
```

### 调度 Cron Jobs

Kubernetes CronJob 是在指定时间运行一次或重复运行的 Job。它们的行为类似于 `/etc/crontab` 文件中指定的常规 Unix cron 作业。

CronJob 资源在 Kubernetes 1.21 中变得稳定。以下是每分钟启动一个 cron job 提醒你活动的配置。在 schedule 中，你可以用 `?` 替换 `*`：

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cron-demo
spec:
  schedule: "*/1 * * * *"
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            cronjob-name: cron-demo
        spec:
          containers:
          - name: cron-demo
            image: g1g1/py-kube:0.3
            args:
            - python
            - -c
            - from datetime import datetime; print(f'[{datetime.now()}] CronJob demo here...remember to stretch')
          restartPolicy: OnFailure
```

在 Pod spec（位于 jobTemplate 下）中，我添加了标签 `cronjob-name: cron-demo`。原因是 cron job 及其 Pod 由 Kubernetes 分配了带有随机前缀的名称。该标签允许你轻松发现特定 cron job 的所有 Pod。Pod 也会有 `job-name` 标签，因为 cron job 会为每次调用创建一个 Job 对象。然而，Job 名称本身有一个随机前缀，所以它不能帮助我们发现 Pod。

让我们运行 cron job 并在一分钟后观察结果：

```bash
$ k get cj
NAME        SCHEDULE      SUSPEND   ACTIVE   LAST SCHEDULE   AGE
cron-demo   */1 * * * *   False     0        <none>          16s
$ k get job
NAME               COMPLETIONS   DURATION   AGE
cron-demo-27600079 1/1           3s         2m45s
cron-demo-27600080 1/1           3s         105s
cron-demo-27600081 1/1           3s         45s
$ k get pods
NAME                       READY   STATUS      RESTARTS   AGE
cron-demo-27600080-dmcmq   0/1     Completed   0          2m6s
cron-demo-27600081-gjsvd   0/1     Completed   0          66s
cron-demo-27600082-sgjlh   0/1     Completed   0          6s
```

如你所见，每分钟 cron job 都会创建一个具有不同名称的新 Job。每个 Job 的 Pod 都带有其 Job 名称的标签，但也带有 cron job 的名称 `cron-demo`，以便于汇总所有来自此 cron job 的 Pod。

像往常一样，你可以使用 `logs` 命令检查已完成 Job 的 Pod 输出：

```bash
$ k logs cron-demo-27600082-sgjlh
[2022-06-23 17:22:00.971343] CronJob demo here...remember to stretch
```

当你删除 cron job 时，它会停止调度新的 Job，并删除所有现有的 Job 对象及其创建的所有 Pod。

你可以使用指定的标签（此处为 `name=cron-demo`）来定位由 cron job 启动的所有 Job 对象：

```bash
$ k delete job -l name=cron-demo
job.batch "cron-demo-27600083" deleted
job.batch "cron-demo-27600084" deleted
job.batch "cron-demo-27600085" deleted
```

你也可以暂停 cron job，使其不再创建更多 Job，而无需删除已完成的 Job 和 Pod。你还可以通过在 spec 的历史限制中设置 `.spec.successfulJobsHistoryLimit` 和 `.spec.failedJobsHistoryLimit` 来控制保留多少个 Job。

在本节中，我们介绍了启动 Job 和控制 Job 的重要主题。这是 Hue 平台的一个关键方面，它需要响应实时事件并通过启动 Job 以及定期执行短期任务来处理它们。

## 混入非集群组件

大多数 Kubernetes 集群中的实时系统组件将与集群外的组件进行通信。这些组件可以是可通过某些 API 访问的完全外部第三方服务，也可以是运行在同一本地网络中但出于各种原因不属于 Kubernetes 集群的内部服务。

这里有两种情况：集群网络内部和集群网络外部。

### 集群网络外部的组件

这些组件无法直接访问集群。它们只能通过 API、外部可见 URL 和暴露的服务来访问集群。这些组件与任何外部用户一样被对待。

通常，集群组件只会使用外部服务，这不会带来安全问题。例如，在我之前的公司，我们有一个 Kubernetes 集群向一个名为 Sentry（https://sentry.io/welcome/）的第三方服务报告异常。这是从 Kubernetes 集群到第三方服务的单向通信。Kubernetes 集群拥有访问 Sentry 的凭据，这就是这单向通信的全部。

### 集群网络内部的组件

这些是在网络内部运行但不受 Kubernetes 管理的组件。运行此类组件有很多原因。它们可能是尚未"Kubernetes化"的遗留应用程序，或者是不容易在 Kubernetes 内部运行的分布式数据存储。在网络内部运行这些组件的原因是为了性能，并且与外部世界隔离，因此这些组件和 Pod 之间的流量可以更加安全。成为同一网络的一部分确保了低延迟，并且减少打开网络进行通信的需求既方便又更安全。

## 使用 Kubernetes 管理 Hue 平台

在本节中，我们将探讨 Kubernetes 如何帮助运营像 Hue 这样庞大的平台。Kubernetes 本身提供了大量能力来编排 Pod 和管理配额与限制，检测并恢复某些类型的通用故障（硬件故障、进程崩溃和不可达服务）。但是，在像 Hue 这样的复杂系统中，Pod 和服务可能处于运行状态，但处于无效状态，或正在等待其他依赖项以履行其职责。这很棘手，因为如果服务或 Pod 尚未就绪但已经开始接收请求，那么你需要以某种方式管理它：失败（将责任推给调用方）、重试（多少次？多久？多频繁？）和排队等待以后处理（谁来管理这个队列？）。

通常，如果系统整体能够感知不同组件的就绪状态，或者组件仅在真正就绪时才可见，效果会更好。Kubernetes 不了解 Hue，但它提供了几种机制，如存活探针（liveness probes）、就绪探针（readiness probes）、启动探针（startup probes）和 init 容器（init containers），以支持集群的应用特定管理。

### 使用存活探针确保容器存活

kubelet 监视着你的容器。如果容器进程崩溃，kubelet 会根据重启策略进行处理。但这在许多情况下还不够。你的进程可能不会崩溃，而是进入无限循环或死锁状态。重启策略可能不够精细。使用存活探针，你可以决定容器何时被认为是存活的。如果存活探针失败，Kubernetes 将重启你的容器。以下是 Hue 音乐服务的 Pod 模板。它有一个 `livenessProbe` 部分，使用了 `httpGet` 探针。HTTP 探针需要 scheme（http 或 https，默认为 http）、host（默认为 PodIP）、path 和 port。如果 HTTP 状态码在 200 到 399 之间，则探针被认为是成功的。你的容器可能需要一些时间来初始化，因此你可以指定 `initialDelaySeconds`。在这段时间内，kubelet 不会进行存活检查：

```yaml
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: music
    service: music
  name: hue-music
spec:
  containers:
  - image: g1g1/hue-music
    livenessProbe:
      httpGet:
        path: /pulse
        port: 8888
        httpHeaders:
        - name: X-Custom-Header
          value: ItsAlive
      initialDelaySeconds: 30
      timeoutSeconds: 1
    name: hue-music
```

如果任何容器的存活探针失败，则 Pod 的重启策略生效。确保你的重启策略不是 `Never`，因为这会使探针无用。

还有其他三种类型的存活探针：

- **TcpSocket**：只检查端口是否打开
- **Exec**：运行一个命令，返回 0 表示成功
- **gRPC**：遵循 gRPC 健康检查协议（https://github.com/grpc/grpc/blob/master/doc/health-checking.md）

### 使用就绪探针管理依赖关系

就绪探针用于不同的目的。你的容器可能正在运行并通过了存活探针，但它可能依赖于当前不可用的其他服务。例如，`hue-music` 可能依赖于对一个包含你收听历史的数据服务的访问。没有访问权限，它就无法履行其职责。在这种情况下，其他服务或外部客户端不应该向 `hue-music` 服务发送请求，但也没有必要重启它。就绪探针解决了这个用例。当容器的就绪探针失败时，该容器的 Pod 将从它注册的任何服务端点中移除。这确保了请求不会涌入无法处理它们的服务。注意，你也可以使用就绪探针暂时移除过载的 Pod，直到它们排空一些内部队列。

以下是就绪探针示例。这里我使用 exec 探针来执行自定义命令。如果命令以非零退出码退出，容器将被拆除：

```yaml
readinessProbe:
  exec:
    command:
    - /usr/local/bin/checker
    - --full-check
    - --data-service=hue-multimedia-service
  initialDelaySeconds: 60
  timeoutSeconds: 5
```

在同一容器上同时使用就绪探针和存活探针是可以的，因为它们服务于不同的目的。

### 使用启动探针

某些应用程序（主要是遗留应用）可能有很长的初始化周期。在这种情况下，存活探针可能会失败，导致容器在完成初始化之前重启。这就是启动探针的用武之地。如果配置了启动探针，则在启动完成之前，会跳过存活和就绪检查。此时，启动探针不再被调用，正常的存活和就绪探针开始接管。

例如，在以下配置片段中，启动探针将每 10 秒检查一次容器是否已启动（使用与存活探针相同的存活检查），持续 5 分钟。如果启动探针失败 30 次（300 秒 = 5 分钟），则容器将被重启并再获得 5 分钟来尝试初始化自己。但是，如果它在 5 分钟内通过了启动探针检查，则存活探针生效，任何存活检查的失败都将导致重启：

```yaml
ports:
- name: liveness-port
  containerPort: 8080
  hostPort: 8080

livenessProbe:
  httpGet:
    path: /healthz
    port: liveness-port
  failureThreshold: 1
  periodSeconds: 10

startupProbe:
  httpGet:
    path: /healthz
    port: liveness-port
  failureThreshold: 30
  periodSeconds: 10
```

### 使用 Init 容器实现有序的 Pod 启动

存活探针、就绪探针和启动探针都很棒。它们认识到，在启动时，容器可能有一段尚未就绪但不应该被视为失败的时间。为此，有 `initialDelayInSeconds` 设置，在此期间容器不会被视为失败。但是，如果这个初始延迟可能非常长呢？也许在大多数情况下，容器在几秒钟后就已经就绪，可以处理请求了，但因为初始延迟被设置为 5 分钟以防万一，我们浪费了大量容器空闲的时间。如果容器是高流量服务的一部分，那么许多实例在每次升级后都可能空闲五分钟，几乎使服务不可用。

Init 容器解决了这个问题。Pod 可以有一组 init 容器，它们在其他容器启动之前运行完成。Init 容器可以处理所有非确定性的初始化，并让带有就绪探针的应用容器具有最小的延迟。

Init 容器对于 Pod 级别的初始化目的特别有用，例如等待卷就绪。Init 容器和启动探针之间存在一些重叠，选择取决于具体的使用场景。

Init 容器在 Kubernetes 1.6 中从 beta 阶段毕业。你在 Pod spec 中将其指定为 `initContainers` 字段，该字段与 `containers` 字段非常相似。以下是一个示例：

```yaml
kind: Pod
metadata:
  name: hue-fitness
spec:
  containers:
  - name: hue-fitness
    image: busybox
  initContainers:
  - name: install
    image: busybox
```

### Pod 就绪和就绪门控（Readiness Gates）

Pod 就绪在 Kubernetes 1.11 中引入，并在 Kubernetes 1.14 中变得稳定。虽然就绪探针允许你在容器级别确定它是否已准备好服务请求，但支持向 Pod 传递流量的整体基础设施可能尚未就绪。例如，Service、网络策略和负载均衡器可能需要额外的时间。这可能是个问题，特别是在滚动部署期间，Kubernetes 可能会在新的 Pod 真正就绪之前终止旧的 Pod，这将导致服务容量降级，甚至在极端情况下导致服务中断（所有旧的 Pod 都被终止，而新的 Pod 没有完全就绪）。

这就是 Pod 就绪门控解决的问题。其思想是扩展 Pod 就绪的概念，除了确保所有容器都就绪之外，还要检查额外的条件。这是通过向 PodSpec 添加一个名为 `readinessGates` 的新字段来实现的。你可以指定一组条件，这些条件必须满足才能认为 Pod 就绪。在以下示例中，Pod 未就绪，因为 `www.example.com/feature-1` 条件的 `status` 为 `False`：

```yaml
Kind: Pod
...
spec:
  readinessGates:
  - conditionType: "www.example.com/feature-1"
status:
  conditions:
  - type: Ready                              # 这是内置的 PodCondition
    status: "False"
    lastProbeTime: null
    lastTransitionTime: 2023-01-01T00:00:00Z
  - type: "www.example.com/feature-1"       # 额外的 PodCondition
    status: "False"
    lastProbeTime: null
    lastTransitionTime: 2023-01-01T00:00:00Z
  containerStatuses:
  - containerID: docker://abcd...
    ready: true
...
```

### 使用 DaemonSet Pod 共享

DaemonSet Pod 是自动部署的 Pod，每个节点一个（或指定节点子集）。它们通常用于监视节点并确保它们正常运行。这是一个非常重要的功能，我们将在第 13 章"监控 Kubernetes 集群"中介绍。但它们还可以用于更多用途。默认 Kubernetes 调度器的本质是根据资源可用性和请求来调度 Pod。如果你有很多不需要大量资源的 Pod，同样会有很多 Pod 被调度到同一个节点上。

考虑一个执行小任务然后每秒将其所有活动的摘要发送到远程服务的 Pod。现在想象一下，平均有 50 个这样的 Pod 被调度到同一个节点上。这意味着每秒有 50 个 Pod 发出 50 个网络请求，而且每个请求的数据量非常小。如果我们将其减少 50 倍，只发出一个网络请求怎么样？使用 DaemonSet Pod，所有其他 50 个 Pod 可以与它通信，而不是直接与远程服务通信。DaemonSet Pod 将收集来自 50 个 Pod 的所有数据，每秒一次将其聚合报告给远程服务。当然，这需要远程服务 API 支持聚合报告。好处在于 Pod 本身不需要修改；它们只需被配置为与本地的 DaemonSet Pod 通信，而不是远程服务。DaemonSet Pod 充当了聚合代理。它还可以实现重试和其他类似功能。

这个配置文件的有趣之处在于 `hostNetwork`、`hostPID` 和 `hostIPC` 选项被设置为 `true`。这使得 Pod 能够利用它们运行在同一物理主机上的事实，与代理高效通信：

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hue-collect-proxy
  labels:
    tier: stats
    app: hue-collect-proxy
spec:
  selector:
    matchLabels:
      tier: stats
      app: hue-collect-proxy
  template:
    metadata:
      labels:
        tier: stats
        app: hue-collect-proxy
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      containers:
      - name: hue-collect-proxy
        image: busybox
```

在本节中，我们探讨了如何在 Kubernetes 上管理 Hue 平台，并确保 Hue 组件被可靠部署，并在它们就绪时才被访问，使用了诸如 init 容器、就绪门控和 DaemonSet 等能力。在下一节中，我们将看到 Hue 平台可能在未来走向何方。

## 使用 Kubernetes 演进 Hue 平台

在本节中，我们将讨论扩展 Hue 平台以及服务更多市场和社区的其他方式。问题始终是，我们可以使用哪些 Kubernetes 特性和能力来应对新的挑战或需求？

这是一个假设性的章节，旨在放眼大局，并以 Hue 为例说明一个极其复杂的系统。

### 在企业中使用 Hue

企业通常无法在云中运行，要么是由于安全和合规原因，要么是因为性能原因，因为系统必须与迁移到云端不划算的数据和遗留系统一起工作。无论哪种方式，面向企业的 Hue 必须支持本地集群和/或裸金属集群。

虽然 Kubernetes 通常部署在云中，甚至有一个特殊的云提供商接口，但它不依赖于云，可以在任何地方部署。它确实需要更多的专业知识，但已经在自己的数据中心运行系统的企业组织可能已经具备或正在培养这种专业知识。

### 用 Hue 推动科学发展

Hue 在集成多个来源的信息方面非常出色，因此它将是科学界的一大福音。考虑 Hue 如何帮助不同学科科学家之间的多学科协作。

一个科学社区网络可能需要跨多个地理分布式集群的部署。这就是多集群 Kubernetes 的用武之地。Kubernetes 考虑到了这个用例，并不断演进其支持。我们将在第 11 章"在多集群上运行 Kubernetes"中详细讨论。

### 用 Hue 教育未来的孩子

Hue 可以用于教育，并为在线教育系统提供许多服务。但是，隐私问题可能会阻止将 Hue 作为单一集中式系统部署给儿童。一种可能性是拥有一个集群，为不同的学校提供命名空间。另一种部署选项是每个学校或县拥有自己的 Hue Kubernetes 集群。在第二种情况下，面向教育的 Hue 必须极其易于操作，以服务于没有大量技术专长的学校。Kubernetes 可以通过提供自愈和自动扩展功能来帮助 Hue 尽可能接近零管理。

## 总结

在本章中，我们设计并规划了 Hue 平台的开发、部署和管理——一个虚构的全知全能的系统——基于微服务架构构建。我们当然使用了 Kubernetes 作为底层编排平台，并深入探讨了它的许多概念和资源。具体来说，我们专注于为长时间运行的服务部署 Pod，与用于启动短期任务或 cron job 的 Job 进行了对比，探索了内部服务与外部服务的区别，还使用了命名空间来划分 Kubernetes 集群。我们研究了 Kubernetes 的各种工作负载调度机制。然后，我们探讨了像 Hue 这样的大型系统的管理，包括存活探针、就绪探针、启动探针、init 容器和 DaemonSet。

你现在应该能够自如地架构由微服务组成的 Web 规模系统，并理解如何在 Kubernetes 集群中部署和管理它们。

在下一章中，我们将探讨存储这个超级重要的领域。数据为王，但它通常是系统中灵活性最低的元素。Kubernetes 提供了存储模型以及与各种存储解决方案集成的许多选项。
