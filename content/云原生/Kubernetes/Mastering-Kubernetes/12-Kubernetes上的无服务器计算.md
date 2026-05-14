---
title: "Kubernetes 上的无服务器计算"
date: 2026-05-13
tags: [Kubernetes, Serverless, Knative]
aliases: [Serverless Computing on Kubernetes]
---

# Kubernetes 上的无服务器计算

你会失去一些控制权，因为你必须接受云提供商所做的选择，但你可以利用大量的自定义选项来调整系统中关键的部分。当然，在需要完全控制的地方，你仍然可以通过显式配置虚拟机并直接部署工作负载来管理自己的基础设施。

归根结底，无服务器方法不仅仅是炒作，它提供了实实在在的好处。让我们来审视一下无服务器的两种形式。

## 在"无服务器"基础设施上运行长时间运行的服务

长时间运行的服务是基于微服务的分布式系统的核心业务。这些服务必须始终保持运行，等待服务请求，并且可以根据流量进行扩缩容。在传统云环境中，你必须配置足够的容量来处理流量峰值和变化，这往往导致过度配置，或者在请求等待配置不足的服务处理时增加延迟。

无服务器服务以开发者的零投入和运维人员的相对较少的投入解决了这个问题。其理念是，你只需将自己的服务标记为在无服务器基础设施上运行，并通过一些参数（如预期的 CPU、内存和扩缩容限制）对其进行配置。该服务对其他服务和客户端来说，就像一个部署在自己配置的基础设施上的传统服务一样。

属于这一类别的服务具有以下特点：

-   始终运行（永远不会缩容到零）
-   暴露多个端点（如 HTTP 和 gRPC）
-   需要你自己实现请求处理和路由
-   可以监听事件，除暴露端点之外或作为替代
-   服务实例可以维护内存缓存、长期连接和会话
-   在 Kubernetes 中，微服务直接由 Service 资源表示

现在，让我们看看 FaaS。

## 在"无服务器"基础设施上运行函数即服务

即使在最大的分布式系统中，也并非每个工作负载每秒都要处理多个请求。总有一些任务需要响应相对不频繁的事件来运行，无论是定时任务还是临时调用的任务。让一个长时间运行的服务只是坐在那里空转，偶尔处理一个请求是可能的，但这是浪费的。你可以尝试将这些任务挂载到其他长时间运行的服务上，但这会产生非常不理想的耦合，这与微服务的理念背道而驰。

一个更好的方法（称为 FaaS）是将这些任务分开处理，并提供不同的抽象和工具来解决它们。

FaaS 是一种计算模型，中央权威机构（例如云提供商或 Kubernetes）为其用户提供一种运行代码（本质上是函数）的方式，而无需关心这段代码在哪里运行。

Kubernetes 有 Job 和 CronJob 对象的概念。它们解决了 FaaS 解决方案所解决的一些问题，但并不完全。

与传统的服务相比，FaaS 解决方案往往更容易启动和运行。开发者可能只需要编写函数的代码；FaaS 解决方案会处理其余的一切：

-   构建和打包
-   暴露为端点
-   基于事件的触发器
-   自动配置和扩缩容
-   监控并提日志和指标

以下是 FaaS 解决方案的一些特点：

-   按需运行（可以缩容到零）
-   暴露单个端点（通常是 HTTP）
-   可以通过事件触发或获得自动端点
-   通常对资源使用和最大运行时有严格限制
-   有时，可能存在冷启动问题（即从零开始扩容时）

FaaS 确实是无服务器计算的一种形式，因为用户无需配置服务器即可运行代码，但它用于运行短期的函数。还有另一种形式的无服务器计算，用于运行长时间运行的服务。

## 云中的无服务器 Kubernetes

现在所有主要的云提供商都支持无服务器的长时间运行的 Kubernetes 服务。微软 Azure 是第一个提供此功能的。Kubernetes 通过 kubelet 与节点交互。无服务器基础设施的基本思想是，不配置实际的节点（物理机或虚拟机），而是以某种方式创建一个虚拟节点。不同的云提供商使用不同的解决方案来实现这一目标。

### 不要忘记集群自动缩放器

在深入探讨特定云提供商的解决方案之前，请务必查看 Kubernetes 原生的集群自动缩放器（cluster autoscaler）选项。集群自动缩放器可以伸缩集群中的节点，并且不受其他一些解决方案的限制。所有的 Kubernetes 调度和控制机制都可以与集群自动缩放器开箱即用，因为它只是自动化地从集群中添加和删除常规节点。没有使用任何异域且特定于提供商的功能。

但你可能有充分的理由更喜欢与提供商更集成的解决方案。例如，AWS Fargate 在 Firecracker（参见 https://github.com/firecracker-microvm/firecracker）中运行，Firecracker 是一个轻量级虚拟机，具有强大的安全边界（顺便提一句，Lambda 函数也运行在 Firecracker 上）。类似地，Google Cloud Run 运行在 gVisor 中。Azure 有几种不同的托管解决方案，如专用虚拟机、Kubernetes 和 Arc。

### Azure AKS 和 Azure Container Instances

Azure 对 Azure Container Instances（ACI）的支持已经很久了。ACI 不是特定于 Kubernetes 的。它允许你在 Azure 的托管环境中按需运行容器。它在某些方面类似于 Kubernetes，但特定于 Azure。它甚至有一个容器组（container group）的概念，类似于 Pod。一个容器组中的所有容器将被调度到同一台主机上运行。

![图 12.1: ACI 架构](ch12-fig01.png)

与 Kubernetes/AKS 的集成被建模为从 AKS 突发到 ACI。其指导原则是，对于已知的工作负载，你应该配置自己的节点，但如果出现流量峰值，额外的负载将动态突发到 ACI。这种方法被认为更经济，因为在 ACI 上运行比自己配置节点更昂贵。AKS 使用我们在前一章中探讨过的 Virtual Kubelet CNCF 项目，将你的 Kubernetes 集群与 ACI 的无限容量集成。它通过向集群添加一个虚拟节点来实现，该节点由 ACI 支持，在 Kubernetes 端表现为一个拥有无限资源的单一节点。

![图 12.2: AKS 中的虚拟节点架构](ch12-fig02.png)

让我们看看 AWS 如何使用 EKS 和 Fargate 来实现这一点。

### AWS EKS 和 Fargate

AWS 于 2018 年发布了 Fargate（https://aws.amazon.com/fargate），它类似于 Azure ACI，让你可以在托管环境中运行容器。最初，你可以在 EC2 或 ECS（AWS 专有的容器编排服务）上使用 Fargate。在 2019 年的 AWS re:Invent 大会上，Fargate 也在 EKS 上正式可用。这意味着你现在拥有一个真正无服务器的完全托管 Kubernetes 解决方案。EKS 负责控制平面，Fargate 负责工作节点。

![图 12.3: EKS 和 Fargate 架构](ch12-fig03.png)

EKS 和 Fargate 对 Kubernetes 集群与 Fargate 之间交互的建模方式与 AKS 和 ACI 不同。在 AKS 上，一个单一的无限虚拟节点代表了 ACI 的全部容量；而在 EKS 上，每个 Pod 都有自己独立的虚拟节点。当然，这些节点并不是真正的节点。Fargate 拥有自己的控制平面和数据平面，支持 EC2、ECS 以及 EKS。EKS-Fargate 的集成是通过一组自定义 Kubernetes 控制器完成的，这些控制器监控需要部署到特定命名空间或具有特定标签的 Pod，并将这些 Pod 转发给 Fargate 进行调度。下图说明了从 EKS 到 Fargate 的工作流程。

![图 12.4: EKS 到 Fargate 的工作流程](images/ch12-fig04.png)

使用 Fargate 时，有几点限制需要注意：

-   每个 Pod 最多 16 个 vCPU 和 120 GB 内存
-   20 GiB 的容器镜像层存储
-   不支持需要持久卷或文件系统的有状态工作负载
-   不支持 DaemonSet、特权 Pod 或使用 HostNetwork 或 HostPort 的 Pod
-   可以使用 Application Load Balancer 或 Network Load Balancer

如果这些限制对你来说过于严格，你可以尝试更直接的方法，利用 Virtual Kubelet 项目将 Fargate 集成到你的集群中。

### 谷歌（Kubernetes 之父）呢？

#### Google Cloud Run

可能会让你感到惊讶，但谷歌实际上是无服务器 Kubernetes 领域的后来者。Cloud Run 是谷歌的无服务器产品。它基于 Knative，我们将在下一节深入剖析 Knative。其基本前提是 Cloud Run 有两种形式。普通的 Cloud Run 类似于 ACI 和 Fargate。它让你在谷歌完全管理的环境中运行容器。适用于 Anthos 的 Cloud Run 支持 GKE，并且允许你在本地部署环境中在 GKE 集群中运行容器化工作负载。

适用于 Anthos 的 Cloud Run 是目前唯一允许你在自定义机器类型（包括 GPU）上运行容器的无服务器平台。Anthos Cloud Run 服务参与 Istio 服务网格，并提供简化的 Kubernetes 原生体验。更多详情请参见 https://cloud.google.com/anthos/service-mesh。

请注意，托管 Cloud Run 使用 gVisor 隔离，而 Anthos Cloud Run 使用标准的 Kubernetes（基于容器）隔离。

下图展示了这两种模型以及访问方法和部署选项的分层结构：

![图 12.5: Cloud Run 模型](images/ch12-fig05.png)

现在是时候了解更多关于 Knative 的内容了。

## Knative

Kubernetes 没有对 FaaS 的内置支持。因此，社区和生态系统开发了许多解决方案。Knative 的目标是提供多个 FaaS 解决方案可以使用的构建块，而无需重新发明轮子。

但是，这还不是全部！Knative 还提供了将长时间运行的服务缩容到零的独特能力。这是一个重大进步。有很多用例中，你可能更倾向于使用一个可以快速处理大量连续请求的长时间运行的服务。在这些情况下，为每个请求启动一个新的函数实例并不是最佳方法。但在没有流量传入时，将服务缩容到零实例、不产生任何费用，并将更多容量留给其他可能在该时间需要更多资源的服务，这是非常棒的。Knative 还支持其他重要的用例，如基于百分比的负载均衡、基于指标的负载均衡、蓝绿部署、金丝雀部署和高级路由。它甚至可以可选地执行自动 TLS 证书和 HTTP 监控。最后，Knative 同时支持 HTTP 和 gRPC。

目前有两个 Knative 组件：Knative serving 和 Knative eventing。以前还有一个 Knative build 组件，但它被分离出来，形成了 Tekton（https://github.com/tektoncd/pipeline）的基础——一个 Kubernetes 原生的 CD 项目。

让我们从 Knative serving 开始。

### Knative Serving

Knative serving 的领域是在 Kubernetes 上运行版本化的服务并将流量路由到这些服务。这超越了标准的 Kubernetes Service。Knative serving 定义了几个 CRD 来建模其领域：Service、Route、Configuration 和 Revision。Service 管理一个 Route 和一个 Configuration。一个 Configuration 可以有多个 Revision。

Route 可以将服务流量路由到特定的 Revision。下图说明了不同对象之间的关系：

![图 12.6: Knative serving CRD](images/ch12-fig06.png)

让我们在本地环境中尝试一下 Knative serving。

#### 安装快速启动环境

Knative 提供了一个便捷的开发设置。让我们安装 `kn` CLI 和 quickstart 插件。请按照这里的说明进行操作：https://knative.dev/docs/getting-started/quickstart-install。

现在，我们可以使用 KinD 运行该插件，它将配置一个新的 KinD 集群并安装多个组件，例如 Knative-service、Kourier 网络层和 Knative eventing。

```bash
$ kn quickstart kind
Running Knative Quickstart using Kind
Checking dependencies...
Kind version is: 0.16.0
☸ Creating Kind cluster...

Creating cluster "knative" ...

✓ Ensuring node image (kindest/node:v1.24.3) 🖼🖼
✓ Preparing nodes

✓ Writing configuration

✓ Starting control-plane
✓ Installing CNI

✓ Installing StorageClass

✓ Waiting ≤ 2m0s for control-plane = Ready

kind-knative | default

• Ready after 19s

Set kubectl context to "kind-knative"
You can now use your cluster with:
kubectl cluster-info --context kind-knative
Have a nice day!
Installing Knative Serving v1.6.0 ...
CRDs installed...
Core installed...
Finished installing Knative Serving
Installing Kourier networking layer v1.6.0 ...
Kourier installed...
Ingress patched...
Finished installing Kourier Networking layer

🕸🕸 Configuring Kourier for Kind...
Kourier service installed...
Domain DNS set up...
Finished configuring Kourier

Installing Knative Eventing v1.6.0 ...
CRDs installed...
Core installed...
In-memory channel installed...
Mt-channel broker installed...
Example broker installed...
Finished installing Knative Eventing
Knative install took: 2m22s
Now have some fun with Serverless and Event Driven Apps!
```

让我们安装示例 hello 服务：

```bash
$ kn service create hello \
--image gcr.io/knative-samples/helloworld-go \
--port 8080 \
--env TARGET=World
Creating service 'hello' in namespace 'default':
 0.080s The Route is still working to reflect the latest desired specification.
 0.115s ...
 0.127s Configuration "hello" is waiting for a Revision to become ready.
 21.229s ...
 21.290s Ingress has not yet been reconciled.
 21.471s Waiting for load balancer to be ready
 21.665s Ready to serve.
Service 'hello' created to latest revision 'hello-00001' is available at URL:
http://hello.default.127.0.0.1.sslip.io
```

我们可以使用 httpie 调用该服务并获得 `Hello, World!` 响应：

```bash
$ http --body http://hello.default.127.0.0.1.sslip.io
Hello World!
```

让我们查看一下 Service 对象。

#### Knative Service 对象

Knative Service 将 Kubernetes Deployment 和 Service 合并为一个对象。这很有道理，因为除了无头服务（headless services，参见 https://kubernetes.io/docs/concepts/services-networking/service/#headless-services）这个特例之外，每个服务后面总是有一个部署。

Knative Service 自动管理其工作负载的整个生命周期。它负责在服务更新时创建 Route 和 Configuration 以及一个新的 Revision。这非常方便，因为用户只需要处理 Service 对象。

以下是 helloworld-go Knative 服务的元数据：

```json
$ k get ksvc hello -o json | jq .metadata
{
  "annotations": {
    "serving.knative.dev/creator": "kubernetes-admin",
    "serving.knative.dev/lastModifier": "kubernetes-admin"
  },
  "creationTimestamp": "2022-09-25T21:11:21Z",
  "generation": 1,
  "name": "hello",
  "namespace": "default",
  "resourceVersion": "19380",
  "uid": "03b5c668-3934-4260-bdba-13357a48501e"
}
```

这是 spec 部分：

```json
$ k get ksvc hello -o json | jq .spec
{
  "template": {
    "metadata": {
      "annotations": {
        "client.knative.dev/updateTimestamp": "2022-09-25T21:11:21Z",
        "client.knative.dev/user-image": "gcr.io/knative-samples/helloworld-go"
      },
      "creationTimestamp": null
    },
    "spec": {
      "containerConcurrency": 0,
      "containers": [
        {
          "env": [
            {
              "name": "TARGET",
              "value": "World"
            }
          ],
          "image": "gcr.io/knative-samples/helloworld-go",
          "name": "user-container",
          "ports": [
            {
              "containerPort": 8080,
              "protocol": "TCP"
            }
          ],
          "readinessProbe": {
            "successThreshold": 1,
            "tcpSocket": {
              "port": 0
            }
          },
          "resources": {}
        }
      ],
      "enableServiceLinks": false,
      "timeoutSeconds": 300
    }
  },
  "traffic": [
    {
      "latestRevision": true,
      "percent": 100
    }
  ]
}
```

请注意 spec 中的 traffic 部分，它将 100% 的请求指向最新的 Revision。这决定了 Route CRD。

#### 创建新的 Revision

让我们创建一个 hello 服务的新 Revision，将 TARGET 环境变量设置为 Knative：

```bash
$ kn service update hello --env TARGET=Knative
Updating Service 'hello' in namespace 'default':
 0.097s The Configuration is still working to reflect the latest desired
specification.
 3.000s Traffic is not yet migrated to the latest revision.
 3.041s Ingress has not yet been reconciled.
 3.155s Waiting for load balancer to be ready
 3.415s Ready to serve.
```

现在，我们有两个 Revision：

```bash
$ k get revisions
NAME          CONFIG NAME   K8S SERVICE NAME   GENERATION   READY   REASON   ACTUAL   DESIRED
hello-00001   hello                              1           True             0        0
hello-00002   hello                              2           True             1        1
```

hello-00002 Revision 是活跃的。让我们确认一下：

```bash
$ http --body http://hello.default.127.0.0.1.sslip.io
Hello Knative!
```

#### Knative Route 对象

Knative Route 对象允许你将一定比例的入站请求定向到特定的 Revision。默认情况下是 100% 指向最新的 Revision，但你可以更改。这支持高级部署场景，如蓝绿部署和金丝雀部署。

以下是 hello Route，它将 100% 的流量指向最新的 Revision：

```yaml
apiVersion: serving.knative.dev/v1
kind: Route
metadata:
  annotations:
    serving.knative.dev/creator: kubernetes-admin
    serving.knative.dev/lastModifier: kubernetes-admin
  labels:
    serving.knative.dev/service: hello
  name: hello
  namespace: default
spec:
  traffic:
  - configurationName: hello
    latestRevision: true
    percent: 100
```

让我们将 50% 的流量定向到之前的 Revision：

```bash
$ kn service update hello \
--traffic hello-00001=50 \
--traffic @latest=50
Updating Service 'hello' in namespace 'default':
 0.078s The Route is still working to reflect the latest desired specification.
 0.124s Ingress has not yet been reconciled.
 0.192s Waiting for load balancer to be ready
 0.399s Ready to serve.
Service 'hello' with latest revision 'hello-00002' (unchanged) is available at URL:
http://hello.default.127.0.0.1.sslip.io
```

现在，如果我们反复调用该服务，会看到两个 Revision 的混合响应：

```bash
$ while true; do http --body http://hello.default.127.0.0.1.sslip.io; done
Hello World!
Hello World!
Hello World!
Hello Knative!
Hello Knative!
Hello Knative!
Hello Knative!
Hello World!
Hello Knative!
Hello World!
```

让我们使用 neat kubectl 插件（https://github.com/itaysk/kubectl-neat）查看 Route：

```bash
$ k get route hello -o yaml | k neat
apiVersion: serving.knative.dev/v1
kind: Route
metadata:
  annotations:
    serving.knative.dev/creator: kubernetes-admin
    serving.knative.dev/lastModifier: kubernetes-admin
  labels:
    serving.knative.dev/service: hello
  name: hello
  namespace: default
spec:
  traffic:
  - configurationName: hello
    latestRevision: true
    percent: 50
  - latestRevision: false
    percent: 50
    revisionName: hello-00001
```

#### Knative Configuration 对象

Configuration CRD 包含服务的最新版本和代数。例如，如果我们将服务更新到版本 2：

```yaml
apiVersion: serving.knative.dev/v1  # Knative 的当前版本
kind: Service
metadata:
  name: helloworld-go              # 应用的名称
  namespace: default               # 应用将使用的命名空间
spec:
  template:
    spec:
      containers:
      - image: gcr.io/knative-samples/helloworld-go  # 应用的镜像 URL
        env:
        - name: TARGET             # 示例应用打印出的环境变量
          value: "Yeah, it still works - version 2 !!!"
```

Knative 也会生成一个 Configuration 对象，现在指向 hello-00002 Revision：

```bash
$ k get configuration hello -o yaml
apiVersion: serving.knative.dev/v1
kind: Configuration
metadata:
  annotations:
    serving.knative.dev/creator: kubernetes-admin
    serving.knative.dev/lastModifier: kubernetes-admin
    serving.knative.dev/routes: hello
  creationTimestamp: "2022-09-25T21:11:21Z"
  generation: 2
  labels:
    serving.knative.dev/service: hello
    serving.knative.dev/serviceUID: 03b5c668-3934-4260-bdba-13357a48501e
  name: hello
  namespace: default
  ownerReferences:
  - apiVersion: serving.knative.dev/v1
    blockOwnerDeletion: true
    controller: true
    kind: Service
    name: hello
    uid: 03b5c668-3934-4260-bdba-13357a48501e
  resourceVersion: "22625"
  uid: fabfcb7c-e3bc-454e-a887-9f84057943f7
spec:
  template:
    metadata:
      annotations:
        client.knative.dev/updateTimestamp: "2022-09-25T21:21:00Z"
        client.knative.dev/user-image: gcr.io/knative-samples/helloworld-go
      creationTimestamp: null
    spec:
      containerConcurrency: 0
      containers:
      - env:
        - name: TARGET
          value: Knative
        image: gcr.io/knative-samples/helloworld-go@sha256:5ea96ba4b872685ff4ddb5cd8d1a97ec18c18fae79ee8df0d29f446c5efe5f50
        name: user-container
        ports:
        - containerPort: 8080
          protocol: TCP
        readinessProbe:
          successThreshold: 1
          tcpSocket:
            port: 0
        resources: {}
      enableServiceLinks: false
      timeoutSeconds: 300
status:
  conditions:
  - lastTransitionTime: "2022-09-25T21:21:03Z"
    status: "True"
    type: Ready
  latestCreatedRevisionName: hello-00002
  latestReadyRevisionName: hello-00002
  observedGeneration: 2
```

总结一下，Knative serving 为长时间运行的服务和函数提供了更好的 Kubernetes 部署和网络功能。让我们看看 Knative eventing 带来了什么。

### Knative Eventing

在 Kubernetes 或其他系统上的传统服务会暴露 API 端点，消费者可以调用这些端点（通常通过 HTTP）来发送请求进行处理。这种请求-响应模式非常有用，因此非常流行。然而，这并不是调用服务或函数的唯一模式。大多数分布式系统都有某种松散耦合的交互，其中事件被发布。当事件发生时，通常需要调用一些代码。

在 Knative 之前，你必须自己构建这个能力，或者使用某些将事件绑定到代码的第三方库。Knative eventing 旨在提供一种标准化的方式来完成这项任务。它与 CNCF CloudEvents 规范（https://github.com/cloudevents/spec）兼容。

#### 熟悉 Knative Eventing 术语

在深入探讨架构之前，让我们先定义一些以后会用到的术语和概念。

##### 事件消费者

有两种类型的事件消费者：Addressable（可寻址）和 Callable（可调用）。Addressable 消费者可以通过其 `status.address.url` 字段通过 HTTP 接收事件。Kubernetes Service 对象没有这样的字段，但它也被视为 Addressable 消费者的一个特例。

Callable 消费者通过 HTTP 接收事件，并且可以在响应中返回另一个事件，该事件将像外部事件一样被消费。Callable 消费者提供了一种有效的转换事件的方式。

##### 事件源

事件源是事件的发起者。Knative 支持许多常见的源，你也可以编写自己的自定义事件源。以下是 Knative 支持的一些事件源：

-   AWS SQS
-   Apache Camel
-   Apache CouchDB
-   Apache Kafka
-   Bitbucket
-   ContainerSource
-   Cron Job
-   GCP PubSub
-   GitHub
-   GitLab
-   Google Cloud Scheduler
-   Kubernetes（Kubernetes 事件）

查看完整列表：https://knative.dev/docs/eventing/sources。

##### Broker 和 Trigger

Broker 负责中介由特定属性标识的事件，并通过 Trigger 将它们与消费者匹配。Trigger 包含事件属性的过滤条件和一个 Addressable 消费者。当事件到达 Broker 时，Broker 会将其转发给那些 Trigger 过滤条件与事件属性匹配的消费者。下图说明了这个工作流程：

![图 12.7: Broker、Trigger 和 Service 的工作流程](ch12-fig07.png)

##### 事件类型和事件注册

事件可以有一个类型，通过 EventType CRD 进行建模。事件注册表（event registry）存储所有的事件类型。Trigger 可以将事件类型作为其过滤条件之一。

##### Channel 和 Subscription

Channel 是一个可选的持久化层。不同的事件类型可以路由到具有不同后端存储的不同 Channel。有些 Channel 可能将事件存储在内存中，而其他 Channel 可能通过 NATS Streaming、Kafka 等持久化到磁盘。订阅者（消费者）最终会接收并处理事件。

现在我们已经介绍了 Knative eventing 的各个部分，让我们来理解它的架构。

#### Knative Eventing 的架构

当前的架构支持两种事件传递模式：

-   **简单传递（Simple delivery）**
-   **扇出传递（Fan-out delivery）**

简单传递只是 1:1 的 源 -> 消费者。消费者可以是核心 Kubernetes Service 或 Knative service。如果消费者不可达，源负责处理事件无法传递的情况。源可以进行重试、记录错误或采取其他适当的措施。下图说明了这个简单的概念：

![图 12.8: 简单传递](images/ch12-fig08.png)

扇出传递可以支持任意复杂的处理，多个消费者订阅同一个 Channel 上的事件。一旦事件被 Channel 接收，源就不再对该事件负责。这允许更动态的消费者订阅，因为源甚至不知道消费者是谁。本质上，生产者和消费者之间存在松散耦合。

下图说明了使用 Channel 时可能出现的复杂处理和订阅模式：

![图 12.9: 扇出传递](images/ch12-fig09.png)

至此，你应该对 Knative 的范围以及它如何为 Kubernetes 建立坚实的无服务器基础有了不错的理解。让我们稍微实际操作一下 Knative，感受一下它的使用体验。

### 检查 Knative 的缩容到零功能

Knative 默认配置为在 30 秒的宽限期后缩容到零。这意味着在 30 秒无活动（没有请求进入）之后，所有 Pod 将被终止，直到新的请求到来。为了验证这一点，我们可以等待 30 秒并检查 default 命名空间中的 Pod：

```bash
$ kubectl get po
No resources found in default namespace.
```

然后，我们可以调用该服务，稍等片刻后就能得到响应：

```bash
$ http --body http://hello.default.127.0.0.1.sslip.io
Hello World!
```

让我们使用 `-w` 标志观察 Pod 何时消失：

```bash
$ k get po -w
NAME                                          READY   STATUS        RESTARTS   AGE
hello-00001-deployment-7c4b6cc4df-4j7bf       2/2     Running       0          46s
hello-00001-deployment-7c4b6cc4df-4j7bf       2/2     Terminating   0          98s
hello-00001-deployment-7c4b6cc4df-4j7bf       1/2     Terminating   0          2m
hello-00001-deployment-7c4b6cc4df-4j7bf       0/2     Terminating   0          2m9s
hello-00001-deployment-7c4b6cc4df-4j7bf       0/2     Terminating   0          2m9s
hello-00001-deployment-7c4b6cc4df-4j7bf       0/2     Terminating   0          2m9s
```

现在我们稍微体验了一下 Knative，可以继续讨论 Kubernetes 上的 FaaS 解决方案了。

## Kubernetes 函数即服务框架

让我们直面那个显而易见的问题——FaaS。Kubernetes 的 Job 和 CronJob 很棒，集群自动缩放和云提供商管理基础设施也很棒。Knative 及其缩容到零和流量路由功能也非常酷。但是，真正的 FaaS 呢？不用担心，Kubernetes 在这方面有很多选择——也许选择太多了。有很多 Kubernetes FaaS 框架：

-   Fission
-   Kubeless
-   OpenFaaS
-   OpenWhisk
-   Riff（构建在 Knative 之上）
-   Nuclio
-   BlueNimble
-   Fn
-   Rainbond

其中一些框架拥有很大的发展势头，而另一些则不然。在上一版书中我讨论过的两个最突出的框架——Kubeless 和 Riff——已经被归档（Riff 自称已完成）。

我们将研究几个仍然活跃且更流行的选项。特别是，我们将关注 OpenFaaS 和 Fission。

### OpenFaaS

OpenFaaS（https://www.openfaas.com）是最成熟、最流行和最活跃的 FaaS 项目之一。它创建于 2016 年，在撰写本文时在 GitHub 上拥有超过 30,000 颗星。OpenFaaS 有社区版以及授权的 Pro 版和企业版。许多生产特性，如高级自动扩缩容和缩容到零，在社区版中不可用。OpenFaaS 附带两个额外组件——Prometheus（用于指标）和 NATS（异步队列）。让我们看看 OpenFaaS 如何在 Kubernetes 上提供 FaaS 解决方案。

#### 交付流水线

OpenFaaS 提供了完整的生态系统和交付机制，用于在 Kubernetes 上打包和运行函数。它也可以使用 faasd 在虚拟机上运行，但这是一本关于 Kubernetes 的书。典型的工作流程如下所示：

![图 12.10: 典型的 OpenFaaS 工作流程](ch12-fig10.png)

`faas-cli` 允许你将函数构建、推送和部署为 Docker/OCI 镜像。构建函数时，你可以使用各种模板，也可以添加自己的模板。这些步骤可以集成到任何 CI/CD 流水线中。

#### OpenFaaS 功能

OpenFaaS 通过一个网关（gateway）暴露其能力。你可以通过 REST API、CLI 或基于 Web 的 UI 与网关交互。网关暴露不同的端点。

OpenFaaS 的主要功能包括：

-   函数管理
-   函数调用和触发器
-   自动扩缩容
-   指标
-   基于 Web 的 UI

##### 函数管理

你可以通过创建或构建镜像、推送这些镜像以及部署它们来管理函数。`faas-cli` 帮助完成这些任务。我们将在本章后面看到一个示例。

##### 函数调用和触发器

OpenFaaS 函数可以作为 HTTP 端点调用，也可以通过各种触发器（如 NATS 事件、其他事件系统以及直接通过 CLI）调用。

##### 指标

OpenFaaS 暴露了一个 `/metrics` 端点（Prometheus 格式），可用于抓取指标。部分指标仅在 Pro 版本中可用。参见完整的指标列表：https://docs.openfaas.com/architecture/metrics/。

##### 自动扩缩容

OpenFaaS 的知名特性之一是其能够基于各种指标进行扩缩容（包括在 Pro 版本中缩容到零）。它不使用 Kubernetes Horizontal Pod Autoscaler（HPA），并支持不同的扩缩容模式，例如 rps、capacity 和 cpu（与 Kubernetes HPA 相同）。你可以使用像 Keda（https://keda.sh）这样的项目实现类似的效果，但那样你就需要自己构建，而 OpenFaaS 提供了开箱即用的支持。

##### 基于 Web 的 UI

OpenFaaS 提供了一个基于 Web 的简单 UI，在 API 网关上可以通过 `/ui` 端点访问。界面如下所示：

![图 12.11: OpenFaaS 基于 Web 的 UI](ch12-fig11.png)

#### OpenFaaS 架构

OpenFaaS 有多个组件相互交互，以可扩展和 Kubernetes 原生的方式提供所有功能。

主要组件包括：

-   OpenFaaS API 网关
-   FaaS Provider
-   Prometheus 和 Alert Manager
-   OpenFaaS Operator

##### API 网关

你的函数作为 CRD 存储。OpenFaaS Operator 监视这些函数。下图说明了各个组件及其之间的关系。

![图 12.12: OpenFaaS 架构](images/ch12-fig12.png)

让我们实际操作一下 OpenFaaS，从用户的角度理解一切是如何工作的。

#### 体验 OpenFaaS

让我们安装 OpenFaaS 和 `faas-cli` CLI。我们将使用推荐的 arkade 包管理器（https://github.com/alexellis/arkade），由 OpenFaaS 创始人开发。所以，让我们先安装 arkade。Arkade 可以安装 Kubernetes 应用程序和各种命令行工具。

在 Mac 上，你可以使用 Homebrew：

```bash
$ brew install arkade
```

在 Windows 上，你需要安装 Git Bash（https://git-scm.com/downloads），然后在 Git Bash 提示符下执行：

```bash
$ curl -sLS https://get.arkade.dev | sh
```

让我们验证 arkade 是否可用：

```bash
$ ark
           _
          | |
 __ _ _ __| | ____ _  __ _  ___   ___
/ _` | '__| |/ / _` |/ _` |/ _ \ / __|
| (_| | |  |   < (_| | (_| | (_) | (__
 \__,_|_|  |_|\_\__,_|\__,_|\___/ \___|

Open Source Marketplace For Developer Tools
Usage:
  arkade [flags]
  arkade [command]

Available Commands:
  chart       Chart utilities
  completion  Output shell completion for the given shell (bash or zsh)
  get         The get command downloads a tool
  help        Help about any command
  info        Find info about a Kubernetes app
  install     Install Kubernetes apps from helm charts or YAML files
  system      System apps
  uninstall   Uninstall apps installed with arkade
  update      Print update instructions
  version     Print the version

Flags:
  -h, --help   help for arkade

Use "arkade [command] --help" for more information about a command.
```

如果你不想使用 arkade，还有其他安装 OpenFaaS 的选项。参见 https://docs.openfaas.com/deployment/kubernetes/。

接下来，让我们在我们的 Kubernetes 集群上安装 OpenFaaS：

```bash
$ ark install openfaas
Using Kubeconfig: /Users/gigi.sayfan/.kube/config
Client: arm64, Darwin
2022/10/01 11:29:14 User dir established as: /Users/gigi.sayfan/.arkade/
Downloading: https://get.helm.sh/helm-v3.9.3-darwin-amd64.tar.gz
/var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T/helm-v3.9.3-darwin-amd64.tar.gz written.
2022/10/01 11:29:17 Extracted: /var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T/helm
2022/10/01 11:29:17 Copying /var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T/helm to
/Users/gigi.sayfan/.arkade/bin/helm
Downloaded to:
/Users/gigi.sayfan/.arkade/bin/helm helm
"openfaas" has been added to your repositories
Hang tight while we grab the latest from your chart repositories...
...Successfully got an update from the "openfaas" chart repository
Update Complete. ⎈Happy Helming!⎈
VALUES values-arm64.yaml

Command: /Users/gigi.sayfan/.arkade/bin/helm [upgrade --install openfaas openfaas/openfaas --namespace openfaas --values /var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T/charts/openfaas/values-arm64.yaml --set gateway.directFunctions=false --set openfaasImagePullPolicy=IfNotPresent --set gateway.replicas=1 --set queueWorker.replicas=1 --set dashboard.publicURL=http://127.0.0.1:8080 --set queueWorker.maxInflight=1 --set autoscaler.enabled=false --set basic_auth=true --set faasnetes.imagePullPolicy=Always --set basicAuthPlugin.replicas=1 --set clusterRole=false --set operator.create=false --set ingressOperator.create=false --set dashboard.enabled=false --set serviceType=NodePort]
Release "openfaas" does not exist. Installing it now.
NAME: openfaas
LAST DEPLOYED: Sat Oct  1 11:29:28 2022
NAMESPACE: openfaas
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
To verify that openfaas has started, run:
  kubectl -n openfaas get deployments -l "release=openfaas, app=openfaas"
=======================================================================
= OpenFaaS has been installed.                                        =
=======================================================================
# Get the faascli
curl -SLsf https://cli.openfaas.com | sudo sh
# Forward the gateway to your machine
kubectl rollout status -n openfaas deploy/gateway
kubectl port-forward -n openfaas svc/gateway 8080:8080 &
# If basic auth is enabled, you can now log into your gateway:
PASSWORD=$(kubectl get secret -n openfaas basic-auth -o jsonpath="{.data.basic-auth-password}" | base64 --decode; echo)
echo -n $PASSWORD | faas-cli login --username admin --password-stdin
faas-cli store deploy figlet
faas-cli list
# For Raspberry Pi
faas-cli store list \
  --platform armhf
faas-cli store deploy figlet \
  --platform armhf
# Find out more at:
# https://github.com/openfaas/faas
arkade needs your support: https://github.com/sponsors/alexellis
```

OpenFaaS 创建了两个命名空间：`openfaas`（用于自身）和 `openfaas-fn`（用于你的函数）。`openfaas` 命名空间中有几个 Deployment：

```bash
$ k get deploy -n openfaas
NAME                READY   UP-TO-DATE   AVAILABLE   AGE
alertmanager        1/1     1            1           6m2s
basic-auth-plugin   1/1     1            1           6m2s
gateway             1/1     1            1           6m2s
nats                1/1     1            1           6m2s
prometheus          1/1     1            1           6m2s
queue-worker        1/1     1            1           6m2s
```

`openfaas-fn` 命名空间目前是空的。

好的。让我们安装 OpenFaaS CLI：

```bash
$ brew install faas-cli
==> Downloading https://ghcr.io/v2/homebrew/core/faas-cli/manifests/0.14.8
######################################################################## 100.0%
==> Downloading https://ghcr.io/v2/homebrew/core/faas-cli/blobs/sha256:cf9460398c45ea401ac688e77a8884cbceaf255064a1d583f8113b6c2bd68450
==> Downloading from https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:cf9460398c45ea401ac688e77a8884cbceaf255064a1d583f8113b6c2bd68450?se=2022-10-01T18%3A50%3A00Z&sig=V%
######################################################################## 100.0%
==> Pouring faas-cli--0.14.8.arm64_monterey.bottle.tar.gz
==> Caveats
zsh completions have been installed to:
  /opt/homebrew/share/zsh/site-functions
==> Summary
/opt/homebrew/Cellar/faas-cli/0.14.8: 9 files, 8.4MB
==> Running `brew cleanup faas-cli`...
Disable this behaviour by setting HOMEBREW_NO_INSTALL_CLEANUP.
Hide these hints with HOMEBREW_NO_ENV_HINTS (see `man brew`).
```

首先，我们需要将网关服务端口转发到本地，以便 `faas-cli` 可以访问我们的集群：

```bash
$ kubectl port-forward -n openfaas svc/gateway 8080:8080 &
[3] 76489
$ Forwarding from 127.0.0.1:8080 -> 8080
Forwarding from [::1]:8080 -> 8080
```

下一步是获取名为 `basic-auth` 的 Secret 中的管理员密码，并使用它登录为 admin 用户：

```bash
$ PASSWORD=$(kubectl get secret -n openfaas basic-auth -o jsonpath="{.data.basic-auth-password}" | base64 --decode; echo)
$ echo -n $PASSWORD | faas-cli login --username admin --password-stdin
```

现在，我们已经准备好部署函数并在集群上运行它们。让我们看一下商店中可用的函数模板：

```bash
$ faas-cli template store list
NAME                   SOURCE             DESCRIPTION
csharp                 openfaas           Classic C# template
dockerfile             openfaas           Classic Dockerfile template
go                     openfaas           Classic Golang template
java11                 openfaas           Java 11 template
java11-vert-x          openfaas           Java 11 Vert.x template
node17                 openfaas           HTTP-based Node 17 template
node16                 openfaas           HTTP-based Node 16 template
node14                 openfaas           HTTP-based Node 14 template
node12                 openfaas           HTTP-based Node 12 template
node                   openfaas           Classic NodeJS 8 template
php7                   openfaas           Classic PHP 7 template
php8                   openfaas           Classic PHP 8 template
python                 openfaas           Classic Python 2.7 template
python3                openfaas           Classic Python 3.6 template
python3-dlrs           intel workloads    Deep Learning Reference Stack v0.4 for ML
ruby                   openfaas           Classic Ruby 2.5 template
ruby-http              openfaas           Ruby 2.4 HTTP template
python27-flask         openfaas           Python 2.7 Flask template
python3-flask          openfaas           Python 3.7 Flask template
python3-flask-debian   openfaas           Python 3.7 Flask template based on Debian
python3-http           openfaas           Python 3.7 with Flask and HTTP
python3-http-debian    openfaas           Python 3.7 with Flask and HTTP based on Debian
golang-http            openfaas           Golang HTTP template
golang-middleware      openfaas           Golang Middleware template
python3-debian         openfaas           Python 3 Debian template
powershell-template    openfaas-incubator Powershell Core Ubuntu:16.04 template
powershell-http-template openfaas-incubator Powershell Core HTTP Ubuntu:16.04 template
rust                   booyaa             Rust template
crystal                tpei               Crystal template
csharp-httprequest     distantcam         C# HTTP template
csharp-kestrel         burtonr            C# Kestrel HTTP template
vertx-native           pmlopes            Eclipse Vert.x native image template
swift                  affix              Swift 4.2 Template
lua53                  affix              Lua 5.3 Template
vala                   affix              Vala Template
vala-http              affix              Non-Forking Vala Template
quarkus-native         pmlopes            Quarkus.io native image template
perl-alpine            tmiklas            Perl language template based on Alpine image
crystal-http           koffeinfrei        Crystal HTTP template
rust-http              openfaas-incubator Rust HTTP template
bash-streaming         openfaas-incubator Bash Streaming template
cobol                  devries            COBOL Template
```

你猜怎么着！甚至还有一个 COBOL 模板，如果你有兴趣的话。出于我们的目的，我们将使用 Golang。有几个 Golang 模板。我们将使用 `golang-http` 模板。我们需要首次拉取该模板：

```bash
$ faas-cli template store pull golang-http
Fetch templates from repository: https://github.com/openfaas/golang-http-template at
2022/10/02 14:48:38 Attempting to expand templates from https://github.com/openfaas/golang-http-template
2022/10/02 14:48:39 Fetched 2 template(s) : [golang-http golang-middleware] from https://github.com/openfaas/golang-http-template
```

该模板包含大量样板代码，负责处理最终生成可在 Kubernetes 上运行的容器所需的所有仪式性工作：

```bash
$ ls -la template/golang-http
total 64
drwxr-xr-x  11 gigi.sayfan  staff    352 Oct  2 14:48 .
drwxr-xr-x   4 gigi.sayfan  staff    128 Oct  2 14:52 ..
-rw-r--r--   1 gigi.sayfan  staff     52 Oct  2 14:48 .dockerignore
-rw-r--r--   1 gigi.sayfan  staff      9 Oct  2 14:48 .gitignore
-rw-r--r--   1 gigi.sayfan  staff   1738 Oct  2 14:48 Dockerfile
drwxr-xr-x   4 gigi.sayfan  staff    128 Oct  2 14:48 function
-rw-r--r--   1 gigi.sayfan  staff    110 Oct  2 14:48 go.mod
-rw-r--r--   1 gigi.sayfan  staff    257 Oct  2 14:48 go.sum
-rw-r--r--   1 gigi.sayfan  staff     32 Oct  2 14:48 go.work
-rw-r--r--   1 gigi.sayfan  staff   3017 Oct  2 14:48 main.go
-rw-r--r--   1 gigi.sayfan  staff    465 Oct  2 14:48 template.yml
```

让我们创建我们的函数：

```bash
$ faas-cli new --prefix docker.io/g1g1 --lang golang-http openfaas-go
Folder: openfaas-go created.
    ____               ____               __
   / __/ _  _____ ___ / __/ _  _____ ___ / /
  / _/ | | / / -_|_-</ _/ | | / / -_|_-</ /_
 /_/   |_| \__/___/_/_/   |_| \__/___/_/\__/

Function created in folder: openfaas-go
Stack file written: openfaas-go.yml

Notes:
You have created a new function which uses Go 1.18 and Alpine
Linux as its base image.
To disable the go module, for private vendor code, please use
"--build-arg GO111MODULE=off" with faas-cli build or configure this
via your stack.yml file.
See more: https://docs.openfaas.com/cli/templates/
For the template's repo and more examples:
https://github.com/openfaas/golang-http-template
```

这个命令生成了 3 个文件：

-   `openfaas-go.yml`
-   `openfaas-go/go.mod`
-   `openfaas-go/handler.go`

让我们检查这些文件。

`openfaas-go.yml` 是我们的函数清单：

```bash
$ cat openfaas-go.yml
version: 1.0
provider:
  name: openfaas
  gateway: http://127.0.0.1:8080
functions:
  openfaas-go:
    lang: golang-http
    handler: ./openfaas-go
    image: docker.io/g1g1/openfaas-go:latest
```

请注意，镜像带有我的 Docker 注册表用户帐户的前缀，以备我需要推送镜像。可以在一个清单文件中定义多个函数。

`go.mod` 非常简单：

```bash
$ cat openfaas-go/go.mod
module handler/function
go 1.18
```

`handler.go` 文件是我们编写代码的地方：

```bash
$ cat openfaas-go/handler.go
package function

import (
  "fmt"
  "net/http"

  handler "github.com/openfaas/templates-sdk/go-http"
)

// Handle a function invocation
func Handle(req handler.Request) (handler.Response, error) {
  var err error
  message := fmt.Sprintf("Body: %s", string(req.Body))
  return handler.Response{
    Body:       []byte(message),
    StatusCode: http.StatusOK,
  }, err
}
```

默认实现有点像 HTTP 回显，响应只返回请求的 body。

让我们构建它。默认输出非常冗长，会显示大量 Docker 输出，所以我将使用 `--quiet` 标志：

```bash
$ faas-cli build -f openfaas-go.yml --quiet
[0] > Building openfaas-go.
Clearing temporary build folder: ./build/openfaas-go/
Preparing: ./openfaas-go/ build/openfaas-go/function
Building: docker.io/g1g1/openfaas-go:latest with golang-http template. Please wait..
Image: docker.io/g1g1/openfaas-go:latest built.
[0] < Building openfaas-go done in 0.93s.
[0] Worker done.
Total build time: 0.93s
```

结果是一个 Docker 镜像：

```bash
$ docker images | grep openfaas
g1g1/openfaas-go                 latest   215e95884a9b   3 minutes ago   18.3MB
```

如果你有账户，可以将此镜像推送到 Docker 注册表（或其他注册表）：

```bash
$ faas-cli push -f openfaas-go.yml
[0] > Pushing openfaas-go [docker.io/g1g1/openfaas-go:latest].
The push refers to repository [docker.io/g1g1/openfaas-go]
668bbc37657f: Pushed
185851557ef2: Pushed
1d14a6a345f2: Pushed
5f70bf18a086: Pushed
ecf2d64591ca: Pushed
f6b0a98cfe18: Pushed
5d3e392a13a0: Mounted from library/golang
latest: digest: sha256:cb2b3051e2cac7c10ce78a844e331a5c55e9a2296c5c3ba9e0e8ee0523ceba84 size: 1780
[0] < Pushing openfaas-go [docker.io/g1g1/openfaas-go:latest] done.
```

Docker 镜像现在可以在 Docker Hub 上获取。

![图 12.13: Docker 镜像可在 Docker Hub 上获取](images/ch12-fig13.png)

最后一步是将镜像部署到集群：

```bash
$ faas-cli deploy -f openfaas-go.yml
Deploying: openfaas-go.
Handling connection for 8080

Deployed. 202 Accepted.
URL: http://127.0.0.1:8080/function/openfaas-go
```

让我们用不同的请求 body 调用我们的函数几次，验证响应是否正确：

```bash
$ http POST http://127.0.0.1:8080/function/openfaas-go body='yeah, it works!' -b
Handling connection for 8080
Body: {
  "body": "yeah, it works!"
}
$ http POST http://127.0.0.1:8080/function/openfaas-go body='awesome!' -b
Handling connection for 8080
Body: {
  "body": "awesome!"
}
```

是的，它工作了！太棒了！
我们可以使用 list 命令查看我们的函数和一些统计数据，如调用次数和副本数：

```bash
$ faas-cli list
Handling connection for 8080
Function        Invocations     Replicas
openfaas-go     6               1
```

总结一下，OpenFaaS 为 Kubernetes 上的函数即服务提供了一个成熟且全面的解决方案。它仍然需要你使用其 CLI 分别构建 Docker 镜像、推送镜像并将其部署到集群。将这些步骤整合到一个 CI/CD 流水线或一个简单脚本中相对简单。

### Fission

Fission（https://fission.io）是一个成熟且文档完善的框架。它将 FaaS 世界建模为环境（environment）、函数（function）和触发器（trigger）。环境用于构建和运行特定语言的函数代码。每个语言环境包含一个 HTTP 服务器，通常还有一个动态加载器（用于动态语言）。函数是代表无服务器函数的对象，触发器则是调用集群中部署的函数的方式。有 4 种触发器：

-   **HTTP 触发器**：通过 HTTP 端点调用函数。
-   **定时触发器**：在特定时间调用函数。
-   **消息队列触发器**：当从消息队列拉取事件时调用函数（支持 Kafka、NATS 和 Azure 队列）。
-   **Kubernetes 监视触发器**：响应集群中的 Kubernetes 事件调用函数。

有趣的是，消息队列触发器不仅仅是即发即忘（fire-and-forget）的。它们支持可选的响应和错误队列。下图展示了流程：

![图 12.14: Fission MQ 触发器](ch12-fig14.png)

Fission 以其 100 毫秒的冷启动而自豪。它通过维护一个带有小型动态加载器的"热"容器池来实现这一点。当一个函数第一次被调用时，已经有一个正在运行的容器准备就绪，代码被发送到这个容器执行。从某种意义上说，Fission 作弊了，因为它从未冷启动。底线是 Fission 不会缩容到零，但首次调用非常快。

#### Fission 执行器

Fission 支持两种类型的执行器——NewDeploy 和 PoolManager。NewDeploy 执行器与 OpenFaaS 非常相似，为每个函数创建 Deployment、Service 和 HPA。以下是使用 NewDeploy 执行器的函数调用示意图：

![图 12.15: Fission 函数调用](ch12-fig15.png)

PoolManager 执行器为每个环境管理一个通用 Pod 池。当为特定环境调用函数时，PoolManager 执行器将在一个可用的通用 Pod 上运行它。

NewDeploy 执行器允许对运行特定函数所需的资源进行细粒度控制，并且它也可以缩容到零。这是以更高的冷启动成本为代价的，因为需要为每个函数创建新的 Pod。请注意，Pod 会保留一段时间，因此如果同一个函数在上一次调用后不久再次被调用，则无需支付冷启动成本。

PoolManager 执行器保持通用 Pod 处于运行状态，因此调用函数很快，但当没有新函数需要调用时，池中的 Pod 只是闲置在那里。此外，函数可以控制可供其使用的资源。

你可以根据不同的使用模式，为不同的函数使用不同的执行器。

![图 12.16: Fission 执行器](ch12-fig16.png)

#### Fission 工作流

Fission 还有一个引以为豪的特性——Fission 工作流（Fission workflows）。这是一个构建在 Fission 之上的独立项目。它允许你构建由 Fission 函数链组成的复杂工作流。由于核心 Fission 团队的时间限制，该项目目前处于维护模式。

更多详情请参见项目页面：https://github.com/fission/fission-workflows。

以下是 Fission 工作流架构的描述（对应图 12.17）：

你在 YAML 中定义工作流，指定任务（通常是 Fission 函数）、输入、输出、条件和延迟。例如：

```yaml
apiVersion: 1
description: Send a message to a slack channel when the temperature exceeds a certain threshold
output: CreateResult
# Input: 'San Fransisco, CA'
tasks:
  # Fetch weather for input
  FetchWeather:
    run: wunderground-conditions
    inputs:
      default:
        apiKey: <API_KEY>
        state: "{$.Invocation.Inputs.default.substring($.Invocation.Inputs.default.indexOf(',') + 1).trim()}"
        city: "{$.Invocation.Inputs.default.substring(0, $.Invocation.Inputs.default.indexOf(',')).trim()}"
  ToCelsius:
    run: tempconv
    inputs:
      default:
        temperature: "{$.Tasks.FetchWeather.Output.current_observation.temp_f}"
        format: F
        target: C
    requires:
      - FetchWeather
  # Send a slack message if the temperature threshold has been exceeded
  CheckTemperatureThreshold:
    run: if
    inputs:
      if: "{$.Tasks.ToCelsius.Output.temperature > 25}"
      then:
        run: slack-post-message
        inputs:
          default:
            message: "{'It is ' + $.Tasks.ToCelsius.Output.temperature + 'C in ' + $.Invocation.Inputs.default + ' :fire:'}"
            path: <HOOK_URL>
    requires:
      - ToCelsius
  # Besides the potential Slack message, compose the response of this workflow {location, celsius, fahrenheit}
  CreateResult:
    run: compose
    inputs:
      celsius: "{$.Tasks.ToCelsius.Output.temperature}"
      fahrenheit: "{$.Tasks.FetchWeather.Output.current_observation.temp_f}"
      location: "{$.Invocation.Inputs.default}"
      sentSlackMsg: "{$.Tasks.CheckTemperatureThreshold.Output}"
    requires:
      - ToCelsius
      - CheckTemperatureThreshold
```

#### 体验 Fission

首先，让我们使用 Helm 安装它：

```bash
$ k create ns fission
$ k create -k "github.com/fission/fission/crds/v1?ref=v1.17.0"
$ helm repo add fission-charts https://fission.github.io/fission-charts/
$ helm repo update
$ helm install --version v1.17.0 --namespace fission fission \
--set serviceType=NodePort,routerServiceType=NodePort \
fission-charts/fission-all
```

以下是它创建的所有 CRD：

```bash
$ k get crd -o name | grep fission
customresourcedefinition.apiextensions.k8s.io/canaryconfigs.fission.io
customresourcedefinition.apiextensions.k8s.io/environments.fission.io
customresourcedefinition.apiextensions.k8s.io/functions.fission.io
customresourcedefinition.apiextensions.k8s.io/httptriggers.fission.io
customresourcedefinition.apiextensions.k8s.io/kuberneteswatchtriggers.fission.io
customresourcedefinition.apiextensions.k8s.io/messagequeuetriggers.fission.io
customresourcedefinition.apiextensions.k8s.io/packages.fission.io
customresourcedefinition.apiextensions.k8s.io/timetriggers.fission.io
```

Fission CLI 也会派上用场：

Mac：

```bash
$ curl -Lo fission https://github.com/fission/fission/releases/download/v1.17.0/fission-v1.17.0-darwin-amd64 && chmod +x fission && sudo mv fission /usr/local/bin/
```

Linux 或在 WSL 上的 Windows：

```bash
$ curl -Lo fission https://github.com/fission/fission/releases/download/v1.17.0/fission-v1.17.0-linux-amd64 && chmod +x fission && sudo mv fission /usr/local/bin/
```

我们需要创建一个环境才能构建我们的函数。让我们使用 Python 环境：

```bash
$ fission environment create --name python --image fission/python-env
poolsize setting default to 3
environment 'python' created
```

有了 Python 环境，我们就可以创建无服务器函数。首先，将以下代码保存到 `yeah.py`：

```python
def main():
    return 'Yeah, it works!!!'
```

然后，创建名为 "yeah" 的 Fission 函数：

```bash
$ fission function create --name yeah --env python --code yeah.py
Package 'yeah-b9d5d944-9c6e-4e67-81fb-96e047625b74' created
function 'yeah' created
```

可以通过 Fission CLI 测试函数：

```bash
$ fission function test --name yeah
Yeah, it works!!!
```

真正的关键是将其通过 HTTP 端点调用。我们需要为此创建一个路由：

```bash
$ fission route create --method GET --url /yeah --function yeah --name yeah
trigger 'yeah' created
```

有了路由之后，我们仍然需要将服务 Pod 端口转发到本地环境进行暴露：

```bash
$ k -n fission port-forward $(k -n fission get pod -l svc=router -o name) 8888:8888 &
$ export FISSION_ROUTER=127.0.0.1:8888
```

完成所有准备工作后，让我们通过 httpie 测试函数：

```bash
$ http http://${FISSION_ROUTER}/yeah -b
Handling connection for 8888
Yeah, it works!!!
```

你可以跳过端口转发，直接使用 Fission CLI 进行测试：

```bash
$ fission function test yeah --name yeah
Yeah, it works!!!
```

Fission 在能力上与 OpenFaaS 相似，但感觉更加精简、更易用。两个解决方案都很扎实，选择哪个取决于你的偏好。

## 总结

在本章中，我们涵盖了无服务器计算这个热门话题。我们解释了两个意义上的无服务器——消除管理服务器的需求，以及将函数作为服务进行部署和运行。我们深入探讨了云中无服务器基础设施的各个方面，特别是在 Kubernetes 的上下文中。我们将 Kubernetes 原生的集群自动缩放器与 AWS EKS+Fargate、Azure AKS+ACI 和 Google Cloud Run 等其他云提供商的产品进行了比较。然后，我们转向了激动人心且前景广阔的 Knative 项目，包括其缩容到零的能力和高级部署选项。接着，我们进入了 Kubernetes 上 FaaS 的广阔世界。

我们讨论了众多的解决方案，并详细研究了它们，包括对其中最突出和最经受过实战考验的两个解决方案——OpenFaaS 和 Fission——进行了动手实验。归根结底，两种形式的无服务器计算在运维和成本管理方面都带来了实实在在的好处。观察这些技术在云平台和 Kubernetes 上的演进和整合将是令人着迷的。

在下一章中，我们的重点将是监控和可观测性。像大型 Kubernetes 集群这样运行着大量不同工作负载、拥有持续交付流水线和配置变更的复杂系统，必须拥有优秀的监控手段才能保持所有环节的稳定运行。Kubernetes 提供了一些很好的选项，我们应该充分利用它们。
