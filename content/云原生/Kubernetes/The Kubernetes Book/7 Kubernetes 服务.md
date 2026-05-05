# 7：Kubernetes 服务

[[Pod]] 是不可靠的，你永远不应该直接连接到它们。你应该始终通过 [[Service]]（服务）进行连接。

本章内容组织如下：

- 服务理论
- 动手实践：使用服务

## 服务理论

Kubernetes 将 Pod 视为临时对象，并在发生以下任何事件时将其删除：

- 缩容操作
- 滚动更新
- 回滚
- 节点维护/驱逐
- 故障

这意味着 Pod 是不可靠的，应用程序不能依赖它们始终存在以响应请求。幸运的是，Kubernetes 提供了一种解决方案——[[Service]] 对象位于一个或多个相同 Pod 的前面，并通过可靠的 DNS 名称、IP 地址和端口暴露它们。

图 7.1 展示了一个客户端通过名为 `app1` 的服务连接到应用程序。客户端连接到服务的名称或 IP，服务将请求转发到其后端的应用程序 Pod。

**图 7.1** - 客户端通过服务访问 Pod

> [!注意] 服务是 Kubernetes API 中的资源，因此我们用大写字母“S”来避免与其他用途的“service”一词混淆。

每个服务都有一个前端和一个后端。前端包括一个 DNS 名称、IP 地址和网络端口，Kubernetes 保证这些永远不会改变。后端是一个标签选择器，将流量发送到具有匹配标签的健康 Pod。回顾图 7.1，客户端通过 `app1:8080` 或 `10.99.11.23:8080` 向服务发送流量，Kubernetes 保证它会到达带有 `project=tkb` 标签的 Pod。

服务还足够智能，可以维护一个具有匹配标签的健康 Pod 列表。这意味着你可以扩缩容、执行发布和回滚，甚至 Pod 可以发生故障，但服务始终会拥有一个最新的活跃健康 Pod 列表。

### 标签与松耦合

服务使用标签和选择器来知道将流量发送到哪些 Pod。这与告知 [[Deployment]] 管理哪些 Pod 的技术相同。

图 7.2 展示了一个服务选择带有 `project=tkb` 和 `zone=prod` 标签的 Pod。

**图 7.2** - 服务与标签

在这个例子中，服务将流量发送到 Pod A、Pod B 和 Pod D，因为它们具有服务所需的所有标签。Pod D 具有额外的标签并不影响。但是，它不会将流量发送到 Pod C，因为它没有同时具备这两个标签。下面的 YAML 定义了一个 Deployment 和一个 Service。Deployment 将创建带有 `project=tkb` 和 `zone=prod` 标签的 Pod，Service 将流量发送给它们。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tkb-2024
spec:
  replicas: 10
  <Snip>
  template:
    metadata:
      labels:
        project: tkb        ----┐  创建带有这些标签的 Pod
        zone: prod          ----┘
    spec:
      containers:
  <Snip>
---
apiVersion: v1
kind: Service
metadata:
  name: tkb
spec:
  ports:
  - port: 8080
  selector:
    project: tkb            ----┐  将流量发送到具有这些标签的 Pod
    zone: prod              ----┘
```

### 背后的 EndpointSlice

每当你创建一个服务，Kubernetes 会自动创建一个关联的 [[EndpointSlice]] 来跟踪具有匹配标签的健康 Pod。

其工作方式如下：

每次你创建一个服务，EndpointSlice 控制器会自动创建一个关联的 EndpointSlice 对象。然后 Kubernetes 监控集群，寻找与服务标签选择器匹配的 Pod。任何匹配选择器的新 Pod 都会被添加到 EndpointSlice 中，而任何被删除的 Pod 则会被移除。应用程序将流量发送到服务名称，应用程序的容器使用集群 DNS 将名称解析为服务的 IP 地址。然后容器将流量发送到服务的 IP，服务将流量转发到 EndpointSlice 中列出的一个 Pod。

旧版本的 Kubernetes 使用 Endpoints 对象而不是 EndpointSlice。它们在功能上相同，但 EndpointSlice 在大型繁忙集群上性能更好。

### 服务类型

Kubernetes 有几种服务类型，适用于不同的用例和需求。主要类型有：

- [[ClusterIP]]
- [[NodePort]]
- [[LoadBalancer]]

ClusterIP 是最基本的类型，在内部 Pod 网络上提供一个可靠的端点（名称、IP 和端口）。NodePort 服务在 ClusterIP 之上构建，允许外部客户端通过每个集群节点上的一个端口进行连接。LoadBalancer 在前两者之上构建，与云负载均衡器集成，实现极其简单的互联网访问。

这三种类型都很重要，让我们逐一来看。

#### ClusterIP 服务——从集群内部访问应用

ClusterIP 是默认的服务类型。它们获得一个 DNS 名称和 IP 地址，这些被编程到内部网络结构中，并且只能从集群内部访问。这意味着：

- IP 仅在内部 Pod 网络上可路由
- 名称会自动注册到集群的内部 DNS
- 所有容器都被预先配置为使用集群 DNS 解析名称

让我们看一个例子。

你正在部署一个名为 `skippy` 的应用，并希望集群上的其他应用能够通过该名称访问它。为了满足这些需求，你创建一个名为 `skippy` 的 ClusterIP 服务。Kubernetes 创建该服务，分配一个内部 IP，并在集群的内部 DNS 中创建 DNS 记录。Kubernetes 还配置集群上的所有容器使用集群 DNS 进行名称解析。这意味着集群上的每个应用都可以使用 `skippy` 名称连接到新应用。

然而，ClusterIP 服务不可路由，并且需要访问集群的内部 DNS 服务，这意味着它们在集群外部不起作用。

我们将在服务发现章节中深入探讨这一点。

#### NodePort 服务——从集群外部访问应用

NodePort 服务在 ClusterIP 服务的基础上构建，通过在每个集群节点上添加一个专用端口供外部客户端使用。我们将这个专用端口称为“NodePort”。

下面的 YAML 展示了一个名为 `skippy` 的 NodePort 服务。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: skippy           <<---- 注册到内部集群 DNS
spec:
  type: NodePort         <<---- 服务类型
  ports:
  - port: 8080           <<---- 内部 ClusterIP 端口
    targetPort: 9000     <<---- 容器中的应用端口
    nodePort: 30050      <<---- 每个集群节点上的外部端口
  selector:
    app: hello-world
```

将这个 YAML 提交到 Kubernetes 将创建一个 ClusterIP 服务，具有通常的内部可路由 IP 和 DNS 名称。它还会在每个集群节点上发布端口 `30050`，并将其映射回 ClusterIP。这意味着外部客户端可以向任何集群节点上的 `30050` 端口发送流量，并到达该服务及其 Pod。

图 7.3 展示了一个 NodePort 服务，在每个集群节点的端口 `30050` 上暴露三个 Pod。步骤 1 显示一个外部客户端在 NodePort 上命中一个节点。步骤 2 显示该节点将请求转发到集群内部服务的 ClusterIP。服务在步骤 3 从 EndpointSlice 始终最新的列表中选择一个 Pod，并在步骤 4 将请求转发到选定的 Pod。

**图 7.3** - NodePort 服务

外部客户端可以向任何集群节点发送请求，服务可以将请求发送到三个健康 Pod 中的任何一个。实际上，由于服务执行简单的轮询负载均衡，未来的请求可能会转到其他 Pod。

然而，NodePort 服务有两个重大限制：

- 它们使用高编号端口，范围在 30000-32767 之间
- 客户端需要知道节点的名称或 IP，以及节点是否健康

这就是为什么大多数人使用 LoadBalancer 服务。

#### LoadBalancer 服务——通过负载均衡器访问应用

LoadBalancer 服务是向外部客户端暴露服务的最简单方式。它们通过在前面放置一个云负载均衡器来简化 NodePort 服务。

图 7.4 展示了一个 LoadBalancer 服务。如你所见，它基本上是一个 NodePort 服务，前面是一个高可用负载均衡器，具有公共可解析的 DNS 名称和低端口号。

**图 7.4** - LoadBalancer 服务

客户端通过一个可靠、友好的 DNS 名称和低端口号连接到负载均衡器，负载均衡器将请求转发到一个健康集群节点上的 NodePort。从那里开始，与 NodePort 服务相同——发送到内部 ClusterIP 服务，从 EndpointSlice 中选择一个 Pod，并将请求发送到该 Pod。

下面的 YAML 创建一个 LoadBalancer 服务，监听端口 `8080`，并将其一直映射到带有 `project=tkb` 标签的 Pod 上的端口 `9000`。它会在后台自动创建所需的 NodePort 和 ClusterIP 结构。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: lb               <<---- 注册到集群 DNS
spec:
  type: LoadBalancer
  ports:
  - port: 8080           <<---- 负载均衡器端口
    targetPort: 9000     <<---- 容器内部的应用端口
  selector:
    project: tkb
```

你将在后面的动手实践部分创建并使用一个 LoadBalancer 服务。

### 服务理论总结

服务位于 Pod 前面，并通过一个可靠的网络端点使 Pod 可访问。

服务的前端提供一个 IP 地址、DNS 名称和一个端口，这些在服务的整个生命周期内保证稳定。后端在动态的一组与标签选择器匹配的 Pod 之间进行负载均衡。

ClusterIP 服务是默认类型，在内部集群网络上提供可靠的端点。NodePort 和 LoadBalancer 提供外部端点。

LoadBalancer 服务在底层云平台上创建一个负载均衡器，以及所有将流量从负载均衡器转发到 Pod 的结构和映射。

## 动手实践：使用服务

本节展示如何以命令式和声明式方式使用服务。一如既往，Kubernetes 更喜欢使用 YAML 文件进行声明式部署和管理所有内容。然而，了解命令式命令也很有帮助。

如果你要跟随操作，需要以下所有内容：

- 本书 GitHub 仓库的克隆
- Kubernetes 集群

你将创建并使用 LoadBalancer 服务，你可以使用我们之前向你展示如何创建的任何一个集群……

# 7: Kubernetes 服务

## 第3章（接上文）

如果您的集群部署在云端，Kubernetes 将会自动配置一个云服务商提供的面向互联网的负载均衡器，并为您分配公有 IP 或公有 DNS 名称。如果您使用的是本地集群（例如 Docker Desktop），体验过程是相同的，但您将使用本地结构，例如 `localhost`。

如果您还没有本书的 GitHub 仓库副本，请使用以下命令进行克隆，然后切换到 `2025` 分支。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
Cloning into 'TKB'...
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

切换到 `Services` 目录。

```bash
$ cd TKB/services
```

运行以下命令来部署一个名为 `svc-test` 的示例应用。它是一个 Deployment，创建了十个 Pod，这些 Pod 运行着一个监听在 8080 端口的 Web 应用，并带有 `chapter=services` 标签。

```bash
$ kubectl apply -f deploy.yml
deployment.apps/svc-test created
```

确保 Pod 已成功部署，然后继续下一节。

```bash
$ kubectl get deploy svc-test
NAME        READY    UP-TO-DATE    AVAILABLE    AGE
svc-test    10/10    10            10           24s
```

## 以命令式方式操作 Service

`kubectl expose` 命令可以为现有的 Deployment 创建一个 Service。它足够智能，能够检查运行的 Deployment 并创建所有必需的组件，例如 IP 地址、标签选择器、DNS 记录和正确的端口映射。

运行以下命令，为 `svc-test` Deployment 中的 Pod 创建一个新的 LoadBalancer Service。

```bash
$ kubectl expose deployment svc-test --type=LoadBalancer
service/svc-test exposed
```

列出 Service 以查看其基本配置。如果您在云平台上运行，`EXTERNAL-IP` 列可能需要一分钟才能填充。

```bash
$ kubectl get svc -o wide
NAME         TYPE           CLUSTER-IP    EXTERNAL-IP    PORT(S)  
kubernetes   ClusterIP      10.96.0.1     <none>         443/TCP  
svc-test     LoadBalancer   10.10.19.33   212.2.245.220  8080:31755
```

第一行是一个名为 `kubernetes` 的系统 Service，它将 Kubernetes API 暴露给集群中的所有 Pod 和容器。您的 Service 位于第二行，其中包含大量信息，我们逐一来看。

首先，它被分配了与其所代理的 Deployment 相同的名称 —— `svc-test`。

`TYPE` 列显示这是一个 LoadBalancer Service，示例中分配了一个 `EXTERNAL-IP` 为 `212.2.245.220`。如果您使用的是本地集群（例如 Docker Desktop），`EXTERNAL-IP` 将显示为 `localhost`。某些 Docker Desktop 集群会在 `EXTERNAL-IP` 列错误地返回一个 `172` 开头的 IP 地址，实际上应该是 `localhost`。

`CLUSTER-IP` 列列出了 Service 的内部 IP，该 IP 只能在集群内部网络中路由。

`PORT(S)` 列显示了负载均衡器端口 (8080) 和 NodePort (31755)。默认情况下，负载均衡器端口与应用监听的端口匹配，但您可以覆盖此设置。NodePort 的值是在 30000-32767 之间随机分配的。

`SELECTOR` 列与 Pod 的标签相匹配。

有几点值得注意。

首先，该命令检查了正在运行的 Deployment，并创建了正确的端口映射和标签选择器——应用监听在 8080 端口，并且所有 10 个 Pod 都带有 `chapter=services` 标签。

其次，尽管它是一个 LoadBalancer Service，但它也创建了所有 ClusterIP 和 NodePort 结构。这是因为 LoadBalancer Services 构建在 NodePort Services 之上，而 NodePort Services 又构建在 ClusterIP Services 之上，如图 7.5 所示。

> **图 7.5 - Service 堆叠 (Service stacking)**
> [图片说明：此图展示了 Service 类型的层次结构。底部是 ClusterIP Service，中间层是 NodePort Service（构建于 ClusterIP 之上），顶层是 LoadBalancer Service（构建于 NodePort 之上）。每个上层都包含其下层的所有功能。]

`kubectl describe` 命令提供更详细的信息。

```bash
$ kubectl describe svc svc-test
Name:                     svc-test
Namespace:                default
Labels:                   <none>
Annotations:              <none>
Selector:                 chapter=services
Type:                     LoadBalancer
IP Family Policy:         SingleStack
IP Families:              IPv4
IP:                       10.10.19.33
IPs:                      10.10.19.33
LoadBalancer Ingress:     212.2.245.220
Port:                     <unset>  8080/TCP      <<---- 负载均衡器端口
TargetPort:               8080/TCP               <<---- 应用端口
NodePort:                 <unset>  31755/TCP     <<---- NodePort 端口
Endpoints:                10.1.0.200:8080,10.1.0.201:8080,10.1.0.202:8080,10.1.0.203:8080,10.1.0.204:8080,10.1.0.205:8080,10.1.0.206:8080,10.1.0.207:8080,10.1.0.208:8080,10.1.0.209:8080
Session Affinity:         None
External Traffic Policy:  Cluster
Events:                   <none>
```

输出重复了您已经看到的大部分内容，我在几行上添加了注释以澄清不同端口相关的值。

还有一些值得关注的附加行。

`Endpoints` 列出了 Service 的 `EndpointSlice` 对象中的健康匹配 Pod。

`Session Affinity` 允许您控制会话粘性——即客户端连接是否始终指向同一个 Pod。默认值为 `None`，会将来自同一客户端的多个连接转发到不同的 Pod。如果您的应用在 Pod 中存储状态并需要会话粘性，您可以尝试使用 `ClientIP` 选项。但是，这是一种**反模式**，因为微服务应用应设计为进程可丢弃，以便客户端可以连接到任何 Pod。

`External Traffic Policy` 决定了到达 Service 的流量是在所有集群节点的 Pod 之间进行负载均衡，还是仅发送到流量到达节点上的 Pod。默认值为 `Cluster`，它会将流量发送到所有集群节点上的 Pod，但会隐藏源 IP 地址。另一个选项是 `Local`，它仅将流量发送到流量到达节点上的 Pod，但会保留源 IP 地址。

如果您的集群运行双栈网络，您的输出可能还会列出 IPv6 地址。

通过在浏览器中访问 `EXTERNAL-IP` 列的 IP 地址的 8080 端口，来测试 Service 是否工作。

> **[图片：图 7.6 - 浏览器显示应用运行正常]**

它工作了。您的应用在容器内运行并监听 8080 端口。您创建了一个 LoadBalancer Service，该 Service 在 8080 端口监听，并将流量转发到每个集群节点上的 NodePort Service，后者再将其转发到 8080 端口的 ClusterIP Service。从那里，流量被发送到监听 8080 端口的、承载应用副本的 Pod。

接下来，您将再次以声明式方式重复上述操作。但您需要先清理环境。

```bash
$ kubectl delete svc svc-test
service "svc-test" deleted
```

## 声明式方式

现在是时候用正确的方式——Kubernetes 的方式来操作了。

### Service 清单文件

以下 YAML 来自 `lb.yml` 文件，您将使用它以声明式方式部署一个 LoadBalancer Service。

```yaml
kind: Service
apiVersion: v1
metadata:
  name: svc-lb
spec:
  type: LoadBalancer
  ports:
  - port: 9000           <<---- 负载均衡器端口
    targetPort: 8080     <<---- 容器内应用端口
  selector:
    chapter: services
```

让我们逐一解读。

前两行告诉 Kubernetes 要基于 `v1` schema 部署一个 Service 对象。

`metadata` 块告诉 Kubernetes 将此 Service 命名为 `svc-lb`，并将该名称注册到内部集群 DNS。您也可以在此处定义自定义标签和注解。

`spec` 部分定义了所有前端和后端细节。此示例告诉 Kubernetes 部署一个 `LoadBalancer` Service，该 Service 在前端监听 9000 端口，并将流量发送到具有 `chapter=services` 标签且监听 8080 端口的 Pod。

使用以下命令部署它。

```bash
$ kubectl apply -f lb.yml
service/svc-lb created
```

### 检查 Service

Service 是常规的 API 资源，这意味着您可以使用通常的 `kubectl get` 和 `kubectl describe` 命令来检查它们。

```bash
$ kubectl get svc svc-lb
NAME       TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S) 
svc-lb     LoadBalancer   10.43.191.202   212.2.247.202   9000:30795/TCP
```

如果您的集群在云端，在云平台配置负载均衡器并分配 IP 地址期间，`EXTERNAL-IP` 列将显示 `<pending>`。请持续刷新命令，直到出现地址。

示例中的 Service 通过云负载均衡器在 `212.2.247.202` 上暴露到互联网。如果您运行的是本地 Docker Desktop 集群，您将通过笔记本电脑的 `localhost` 接口访问它。如果您的 Docker Desktop 集群在 `EXTERNAL-IP` 列显示一个 `172` 开头的 IP 地址，请忽略它，直接使用端口 9000 上的 `localhost`。

一旦 Kubernetes 创建了您的 Service，请在浏览器中访问 `EXTERNAL-IP` 列地址的 9000 端口，以确保您能看到该应用。请记得对于 Docker Desktop 集群，请使用 `localhost`。

在清理之前，让我们看看您的 Service 的 EndpointSlice。

### EndpointSlice 对象

在本章前面，您了解到每个 Service 都有一个或多个自己的 `EndpointSlice` 对象。Kubernetes 在这里维护着匹配标签选择器的健康 Pod 的最新列表，您可以使用通常的 `kubectl` 命令来检查它们。

以下示例来自一个运行双栈网络的集群。请注意存在两个 EndpointSlice——一个用于 IPv4 映射，另一个用于 IPv6。您的集群可能只有 IPv4 映射。

```bash
$ kubectl get endpointslices
NAME            ADDRESSTYPE   PORTS   ENDPOINTS                   
svc-lb-n7jg4    IPv4          8080    10.42.1.16,10.42.1.17,10.42.1.18,10.42.1.19
svc-lb-9s6sq    IPv6          8080    fd00:10:244:1::c,fd00:10:244:1::d
```

```bash
$ kubectl describe endpointslice svc-lb-n7jg4
Name:         svc-lb-n7jg4
Namespace:    default
Labels:       chapter=services
              endpointslice.kubernetes.io/managed-by=endpointslicer
              kubernetes.io/service-name=svc-lb
Annotations:  endpoints.kubernetes.io/last-change-trigger-time: 2025-01-01T00:00:00Z
AddressType:  IPv4
Ports:
  Name     Port  Protocol
  ----     ----  --------
  <unset>  8080  TCP
Endpoints:
  - Addresses:  10.42.1.16
    Conditions:
      Ready:    true
    Hostname:   <unset>
    TargetRef:  Pod/svc-lb-9d7b4cf9d-hnvbf
    NodeName:   k3d-tkb-agent-2
    Zone:       <unset>
  - Addresses:  10.42.1.17
  <Snip>
Events:         <none>
```

完整的命令输出中，每个健康 Pod 都有一个包含有用信息的块。如果一个 Service 映射到超过 100 个 Pod，它将会有不止一个 EndpointSlice。

### 清理

运行以下命令，删除示例中创建的 Deployment 和 Service。当您删除关联的 Service 时，Kubernetes 会自动删除 Endpoints 和 EndpointSlices。

```bash
$ kubectl delete -f deploy.yml -f lb.yml
deployment.apps "svc-lb" deleted
service "svc-lb" deleted
```

## 章节总结

在本章中，您学习了 Service 为 Pod 提供可靠的网络连接。它们有一个包含 DNS 名称、IP 地址和端口的前端，Kubernetes 保证这些前端信息永远不会改变。它们还有一个后端，将流量发送给匹配标签选择器的健康 Pod。

- **ClusterIP Service** 在 Kubernetes 内部网络上提供可靠的网络连接。
- **NodePort Service** 在每个集群节点上暴露一个端口。
- **LoadBalancer Service** 与云平台集成，创建高可用的面向互联网的负载均衡器。