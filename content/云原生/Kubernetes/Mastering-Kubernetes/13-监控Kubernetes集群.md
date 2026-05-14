---
title: 13 - 监控Kubernetes集群
date: 2026-05-13
tags:
  - Kubernetes
  - Mastering-Kubernetes
  - 监控
aliases:
  - 监控Kubernetes集群
  - Chapter 13 - Monitoring Kubernetes Clusters
---

# 监控Kubernetes集群

在上一章中，我们探讨了无服务器计算及其在Kubernetes上的表现形式。这一领域涌现了大量创新，追踪其演进不仅非常有用，也令人着迷。在本章中，我们将讨论如何确保系统正常运行且性能良好，以及当系统出现问题时如何应对。在第3章"高可用性与可靠性"中，我们已经讨论了相关主题。本章的重点是了解系统中正在发生什么，以及可以使用哪些实践和工具。

监控涉及多个方面，例如日志记录、指标、分布式追踪、错误报告和告警。自动扩缩容和自愈等实践依赖于监控来检测何时需要扩容或修复。

本章将涵盖以下主题：

-   理解可观测性
-   在Kubernetes中进行日志记录
-   在Kubernetes中记录指标
-   使用Jaeger进行分布式追踪
-   排查问题

Kubernetes社区认识到监控的重要性，并投入了大量精力以确保Kubernetes拥有完善的监控体系。云原生计算基金会（CNCF）是云原生基础设施项目的实际管理者。迄今为止，已有二十个项目毕业。Kubernetes是第一个毕业的项目，而在早期毕业的项目中，其他三个在两年多前毕业的项目都专注于监控：Prometheus、Fluentd和Jaeger。这意味着监控和可观测性是构建大规模基于Kubernetes的系统的基础。在深入探讨Kubernetes监控的具体细节以及特定项目和工具之前，我们应该更好地理解监控的真正含义。一个思考监控的好框架是：你的系统可观测性如何。

## 理解可观测性

可观测性是一个大词。它在实践中意味着什么？目前存在不同的定义，关于监控和可观测性的相似与差异也存在激烈争论。我倾向于认为，可观测性是系统的一种属性，它定义了我们现在和历史上能够了解系统状态和行为到什么程度。特别是，我们关心系统及其组件的健康状况。监控则是我们用来提高系统可观测性的工具、流程和技术的集合。

为了充分了解系统的运行情况，我们需要收集、记录和聚合不同维度的信息。这些维度包括日志、指标、分布式追踪和错误信息。监控或可观测性数据是多维的，跨越多个层级。仅仅收集数据并没有太大帮助。我们还需要能够查询数据、可视化数据，并在系统出现问题时向其他系统发出告警。让我们回顾一下可观测性的各个组成部分。

### 日志记录

日志记录是一个关键的监控工具。每个有自尊心的长期运行软件都必须有日志。日志记录带有时间戳的事件。它们对于商业智能、安全、合规、审计、调试和故障排查等诸多应用至关重要。需要理解的是，一个复杂的分布式系统会为不同的组件生成不同的日志，从日志中提取洞察并非易事。

日志有几个关键属性：格式、存储和聚合。

#### 日志格式

日志可能以各种格式出现。纯文本非常常见且人类可读，但需要大量工作来解析并与其他日志合并。结构化日志更适合大型系统，因为它们可以大规模处理。二进制日志对于生成大量日志的系统很有意义，因为它们更节省空间，但需要自定义工具和处理来提取信息。

#### 日志存储

日志可以存储在内存中、文件系统上、数据库中、云存储中、发送到远程日志服务，或这些方式的任意组合。在云原生世界中，软件运行在容器中，特别需要注意日志存储在哪里，以及如何在需要时获取它们。当容器可以随时创建和销毁时，持久性等问题就变得至关重要。在Kubernetes中，容器的标准输出和标准错误流会被自动记录并提供访问，即使在Pod终止后也是如此。但是，日志空间是否足够以及日志轮转等问题始终存在。

#### 日志聚合

最终，最佳实践是将本地日志发送到一个集中式日志服务，该服务设计用于处理各种日志格式，根据需要持久化日志，并以可查询和分析的方式聚合多种类型的日志。

### 指标

指标衡量系统随时间变化的某些方面。指标是数值（通常是浮点数）的时间序列。每个指标都有一个名称，通常还有一组标签，有助于后续进行切片和切块分析。例如，节点的CPU利用率或服务的错误率都是指标。

指标比日志经济得多。它们在每个时间段内需要固定的存储空间，不会像日志那样随着传入流量的大小而波动。

此外，由于指标本质上是数值，不需要解析或转换。指标可以轻松地使用统计方法进行组合和分析，并作为事件和告警的触发器。通常，操作系统、云提供商或Kubernetes会自动为你收集许多不同级别（节点、容器、进程、网络和磁盘）的指标。

但你也可以创建自定义指标，映射到系统的高层级关注点，并配置应用程序级别的策略。

### 分布式追踪

现代分布式系统通常采用基于微服务的架构，其中传入请求在多个微服务之间传递，在队列中等待，并触发无服务器函数。当你尝试分析错误、故障、数据完整性问题或性能问题时，能够追踪请求的路径至关重要。这就是分布式追踪的用武之地。

分布式追踪是跨度和引用的集合。你可以将追踪视为一个有向无环图（DAG），它表示请求在分布式系统各组件间的遍历路径。每个跨度记录请求在给定组件中花费的时间，引用则是连接一个跨度与后续跨度的图边。

![分布式追踪示例路径](images/ch13-fig01.png)

**图13.1：一个示例分布式追踪的路径**

分布式追踪对于理解复杂的分布式系统是不可或缺的。

### 应用程序错误报告

错误和异常报告有时作为日志记录的一部分来完成。你肯定希望记录错误，并且在出现问题时查看日志是一种历史悠久的传统。然而，捕获错误信息的层次可以超越简单的日志记录。当应用程序中发生错误时，捕获错误消息、代码中的错误位置以及堆栈跟踪非常有用。这是相当标准的做法，大多数编程语言都能提供所有这些信息，尽管堆栈轨迹往往是多行的，不太适合基于行的日志。一个有用的额外信息是在堆栈跟踪的每一层捕获局部状态。当问题发生在某个中心位置，但局部状态（如某些列表中的条目数量和大小）有助于识别根本原因时，这很有帮助。像Sentry或Rollbar这样的中央错误报告服务提供了超越日志记录的专门针对错误的价值，例如丰富的错误信息、上下文信息和用户信息。

### 仪表盘与可视化

好了。你在收集日志、定义指标、追踪请求和报告丰富错误方面做得非常出色。现在，你想了解你的系统或其部分正在做什么。基准是什么？流量在一天、一周和节假日期间如何波动？当系统承受压力时，哪些部分最脆弱？

在涉及成百上千个服务、数据存储并集成外部系统的复杂系统中，你不能只查看原始的日志文件、指标和追踪数据。

你需要能够组合大量信息，构建系统健康仪表盘，可视化你的基础设施，并创建业务级别的报告和图表。

如果你使用云平台，可能会自动获得其中一些功能（尤其是基础设施方面）。但你应该预期在可视化和仪表盘方面需要做一些认真的工作。

### 告警

仪表盘非常适合希望获得系统广泛视图并能够深入下钻了解其行为的人类。告警则完全关乎检测异常情况并触发某些操作。理想情况下，你的系统是自愈的，能够自行从大多数情况中恢复。但至少你应该报告它，以便人类在空闲时审查发生的事情，并决定是否需要进一步操作。

告警可以与电子邮件、聊天室和值班系统集成。它通常与指标相关联，当某些条件满足时，就会触发告警。

现在，我们已经大致介绍了监控复杂系统所涉及的不同要素，接下来看看如何在Kubernetes中实现这些。

## 在Kubernetes中进行日志记录

我们需要仔细考虑在Kubernetes中的日志策略。有几种类型的日志与监控目的相关。我们的工作负载当然运行在容器中，我们关心这些日志，但我们也关心Kubernetes组件（如API服务器、kubelet和容器运行时）的日志。

此外，跨多个节点和容器追踪日志是不可行的。最佳实践是使用集中式日志记录（也称为日志聚合）。这里有几种选择，我们很快就会探讨。

### 容器日志

Kubernetes存储每个容器的标准输出和标准错误。它们可以通过 `kubectl logs` 命令获取。

以下是一个Pod清单，它会每10秒打印一次当前日期和时间：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: now
spec:
  containers:
  - name: now
    image: g1g1/py-kube:0.3
    command: ["/bin/bash", "-c", "while true; do sleep 10; date; done"]
```

我们可以将其保存到一个名为 `now-pod.yaml` 的文件中并创建它：

```shell
$ k apply -f now-pod.yaml
pod/now created
```

要查看日志，我们使用 `kubectl logs` 命令：

```shell
$ kubectl logs now
Sat Jan  4 00:32:38 UTC 2020
Sat Jan  4 00:32:48 UTC 2020
Sat Jan  4 00:32:58 UTC 2020
Sat Jan  4 00:33:08 UTC 2020
Sat Jan  4 00:33:18 UTC 2020
```

关于容器日志的几点说明。`kubectl logs` 命令需要一个Pod名称。如果Pod有多个容器，你还需要指定容器名称：

```shell
$ k logs <pod name> -c <container name>
```

如果Deployment或ReplicaSet创建了同一个Pod的多个副本，你可以通过使用共享标签在一次调用中查询所有Pod的日志：

```shell
k logs -l <label>
```

如果容器因某种原因崩溃，你可以使用 `kubectl logs -p` 命令查看崩溃容器的日志。

### Kubernetes组件日志

如果你在托管环境（如GKE、EKS或AKS）中运行Kubernetes，你将无法直接访问Kubernetes组件日志，但这在预期之内。你不负责Kubernetes控制平面。然而，控制平面组件（如API服务器和集群自动扩缩器）以及节点组件（如kubelet和容器运行时）的日志对于故障排除可能很重要。云提供商通常提供专有方式来访问这些日志。

以下是如果你运行自己的Kubernetes控制平面时的标准控制平面组件及其日志位置：

-   **API服务器**：`/var/log/kube-apiserver.log`
-   **调度器**：`/var/log/kube-scheduler.log`
-   **控制器管理器**：`/var/log/kube-controller-manager.log`

工作节点组件及其日志位置是：

-   **Kubelet**：`/var/log/kubelet.log`
-   **Kube代理**：`/var/log/kube-proxy.log`

请注意，在基于systemd的系统上，你需要使用 `journalctl` 来查看工作节点日志。

### 集中式日志记录

对于快速排查单个Pod中的问题，读取容器日志是可行的。但要诊断和调试系统范围的问题，我们需要集中式日志记录（也称为日志聚合）。来自我们容器的所有日志都应发送到一个中央仓库，并通过过滤器和查询进行切片和切块分析。

在决定集中式日志记录方法时，有几个重要的决策：

-   如何收集日志
-   在何处存储日志
-   如何处理敏感的日志信息

我们将在以下各节中回答这些问题。

### 选择日志收集策略

日志通常由运行在生成日志的进程附近并确保将其传递到集中式日志服务的代理来收集。

让我们看看常见的方法。

#### 直接记录到远程日志服务

在这种方法中，没有日志代理。每个应用程序容器负责将日志发送到远程日志服务。这通常通过客户端库完成。这是一种高接触的方法，应用程序需要知道日志目标，并使用适当的凭据进行配置。

![直接日志记录](images/ch13-fig02.png)

**图13.2：直接日志记录**

如果你曾经想要更改日志收集策略，这将需要更改每个应用程序（至少需要升级到新版本的库）。

#### 节点代理

节点代理方法在你控制工作节点并且希望从应用程序中抽象出日志聚合行为时效果最佳。每个应用程序容器只需写入标准输出和标准错误，运行在每个节点上的代理将拦截日志并将其传递到远程日志服务。

通常，你将节点代理部署为DaemonSet，这样当节点从集群中添加或移除时，日志代理将始终存在，无需额外工作。

![使用节点代理进行日志记录](ch13-fig03.png)

**图13.3：使用节点代理进行日志记录**

#### Sidecar容器

Sidecar容器最适合当你无法控制集群节点时，或者当你使用某些无服务器计算基础设施来部署容器但不想使用直接日志记录方法时。如果你无法控制节点并且无法安装代理，节点代理方法就不在考虑范围内，但你可以附加一个Sidecar容器来收集日志并将其传递到中央日志服务。它不如节点代理方法高效，因为每个容器都需要自己的Sidecar日志记录容器，但这可以在部署阶段完成，无需代码更改和应用程序感知。

![使用Sidecar容器进行日志记录](ch13-fig04.png)

**图13.4：使用Sidecar容器进行日志记录**

现在我们已经介绍了日志收集的主题，接下来考虑如何集中存储和管理这些日志。

### 集群级中央日志记录

如果你的整个系统运行在单个Kubernetes集群中，那么集群级日志记录可能是一个很好的选择。你可以在集群中安装像Grafana Loki、ElasticSearch或Graylog这样的中央日志服务，享受统一的日志聚合体验，而无需将日志数据发送到其他地方。

### 远程中央日志记录

在某些情况下，集群内中央日志记录无法满足需求，原因如下：

-   日志用于审计目的；可能需要记录到独立且受控的位置（例如，在AWS上，通常记录到单独的账户）。
-   你的系统在多个集群上运行，在每个集群中记录日志并非真正意义上的"集中"。
-   你使用云提供商，并且更倾向于记录到云平台的日志服务（例如，GCP上的StackDriver或AWS上的CloudWatch）。
-   你已经在使用像SumoLogic或Splunk这样的远程中央日志服务，并且希望继续使用它们。
-   你只是不想处理收集和存储日志数据的麻烦。
-   集群范围的问题可能会影响你的日志收集、存储或访问，并阻碍你进行故障排除的能力。

记录到远程中央位置可以通过所有方法完成：直接日志记录、节点代理日志记录或Sidecar日志记录。在所有情况下，必须提供远程日志服务的端点和凭据，并且日志记录是针对该端点进行的。在大多数情况下，这将通过一个客户端库来完成，该库向应用程序隐藏了细节。至于系统级日志记录，常见的方法是通过专用的日志代理收集所有必要的日志，并将其转发到远程日志服务。

### 处理敏感日志信息

好了。我们可以收集日志并将其发送到中央日志服务。如果中央日志服务是远程的，你可能需要选择记录哪些信息。

例如，个人身份信息（PII）和受保护健康信息（PHI）是两类你可能不应该记录的信息，除非确保对日志的访问得到适当控制。

通常的做法是从日志语句中编辑或删除用户名和电子邮件等PII信息。

### 使用Fluentd进行日志收集

Fluentd（https://www.fluentd.org）是一个开源的CNCF毕业项目。它被认为是Kubernetes中的最佳选择，并且几乎可以与你想要的任何日志后端集成。如果你要设置自己的集中式日志记录解决方案，我推荐使用Fluentd。Fluentd作为节点代理运行。

下图显示了Fluentd如何在Kubernetes集群中作为DaemonSet部署：

![将Fluentd部署为Kubernetes集群中的DaemonSet](images/ch13-fig05.png)

**图13.5：将Fluentd部署为Kubernetes集群中的DaemonSet**

最流行的DIY集中式日志记录解决方案之一是ELK，其中E代表ElasticSearch，L代表LogStash，K代表Kibana。在Kubernetes上，EFK（其中Fluentd取代LogStash）非常常见。

Fluentd具有基于插件的架构，所以不要觉得仅限于EFK。Fluentd不需要大量资源，但如果你确实需要一个高性能的解决方案，Fluentbit（http://fluentbit.io/）是一个纯转发器，仅使用约450KB的内存。

我们已经介绍了日志记录的大量内容。接下来看看可观测性的下一部分，即指标。

## 在Kubernetes中收集指标

Kubernetes有一个Metrics API。它开箱即用地支持节点和Pod指标。你还可以定义自己的自定义指标。

一个指标包含时间戳、使用量字段以及指标收集的时间范围（许多指标是在一段时间内累积的）。以下是节点指标的API定义：

```go
type NodeMetrics struct {
    metav1.TypeMeta
    metav1.ObjectMeta
    Timestamp metav1.Time
    Window    metav1.Duration
    Usage     corev1.ResourceList
}
// NodeMetricsList is a list of NodeMetrics.
type NodeMetricsList struct {
    metav1.TypeMeta
    // Standard list metadata.
    // More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds
    metav1.ListMeta
    // List of node metrics.
    Items []NodeMetrics
}
```

`Usage` 字段的类型是 `ResourceList`，但它实际上是一个将资源名称映射到数量的映射：

```go
// ResourceList is a set of (resource name, quantity) pairs.
type ResourceList map[ResourceName]resource.Quantity
```

`Quantity` 表示一个定点数。它允许在JSON和YAML中轻松进行序列化/反序列化，以及像 `String()` 和 `Int64()` 这样的访问器：

```go
type Quantity struct {
    // i is the quantity in int64 scaled form, if d.Dec == nil
    i int64Amount
    // d is the quantity in inf.Dec form if d.Dec != nil
    d infDecAmount
    // s is the generated value of this quantity to avoid recalculation
    s string
    // Change Format at will. See the comment for Canonicalize for more details.
    Format
}
```

### 使用Metrics Server进行监控

Kubernetes Metrics Server实现了Kubernetes Metrics API。

你可以使用Helm部署它：

```shell
$ helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
$ helm upgrade --install metrics-server metrics-server/metrics-server
Release "metrics-server" does not exist. Installing it now.
NAME: metrics-server
LAST DEPLOYED: Sun Oct  9 14:11:54 2022
NAMESPACE: default
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
***********************************************************************
* Metrics Server                                             *
***********************************************************************
Chart version: 3.8.2
App version:   0.6.1
Image tag:     k8s.gcr.io/metrics-server/metrics-server:v0.6.1
***********************************************************************
```

在minikube上，你可以直接将其作为插件启用：

```shell
$ minikube addons enable metrics-server
▪ Using image k8s.gcr.io/metrics-server/metrics-server:v0.4.2
The 'metrics-server' addon is enabled
```

请注意，在撰写本文时，minikube上的Metrics Server存在一个问题，该问题已在Kubernetes 1.27中修复（参见https://github.com/kubernetes/minikube/issues/13969）。我们将使用kind集群来部署metrics-server。

等待几分钟让metrics server收集一些数据后，你可以使用以下命令查询节点指标：

```shell
$ k get --raw "/apis/metrics.k8s.io/v1beta1/nodes" | jq .
{
  "kind": "NodeMetricsList",
  "apiVersion": "metrics.k8s.io/v1beta1",
  "metadata": {},
  "items": [
    {
      "metadata": {
        "name": "kind-control-plane",
        "creationTimestamp": "2022-10-09T21:24:12Z",
        "labels": {
          "beta.kubernetes.io/arch": "arm64",
          "beta.kubernetes.io/os": "linux",
          "kubernetes.io/arch": "arm64",
          "kubernetes.io/hostname": "kind-control-plane",
          "kubernetes.io/os": "linux",
          "node-role.kubernetes.io/control-plane": "",
          "node.kubernetes.io/exclude-from-external-load-balancers": ""
        }
      },
      "timestamp": "2022-10-09T21:24:05Z",
      "window": "20.022s",
      "usage": {
        "cpu": "115537281n",
        "memory": "47344Ki"
      }
    }
  ]
}
```

此外，`kubectl top` 命令从metrics server获取信息：

```shell
$ k top nodes
NAME                CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
kind-control-plane  125m         3%     46Mi            1%
```

我们也可以获取Pod的指标：

```shell
$ k top pods -A
NAMESPACE            NAME                                         CPU(cores)   MEMORY(bytes)
default              metrics-server-554f79c654-hw2c7              4m           18Mi
kube-system          coredns-565d847f94-t8knf                     2m           12Mi
kube-system          coredns-565d847f94-wdqzx                     2m           14Mi
kube-system          etcd-kind-control-plane                      24m          28Mi
kube-system          kindnet-fvfs7                                1m           7Mi
kube-system          kube-apiserver-kind-control-plane            43m          339Mi
kube-system          kube-controller-manager-kind-control-plane   18m          48Mi
kube-system          kube-proxy-svdc6                             1m           11Mi
kube-system          kube-scheduler-kind-control-plane            4m           21Mi
local-path-storage   local-path-provisioner-684f458cdd-24w88     2m           6Mi
```

Metrics server也是Kubernetes仪表盘中性能信息的来源。

### Prometheus的崛起

Prometheus（https://prometheus.io/）是另一个已毕业的CNCF开源项目。它专注于指标收集和告警管理。它拥有一个简单而强大的数据模型来管理时间序列数据，以及一种复杂的查询语言。它被认为是Kubernetes世界中的最佳选择。Prometheus允许你定义在固定时间间隔触发的记录规则，并从目标收集数据。此外，你可以定义告警规则，评估条件并在条件满足时触发告警。

与其他监控解决方案相比，它有几个独特的功能：

-   收集系统基于HTTP拉取。没有人需要将指标推送到Prometheus（但通过网关支持推送）。
-   多维数据模型（每个指标是一个命名的时间序列，每个数据点附带一组键/值对）。
-   PromQL：一种强大灵活的查询语言，用于对指标进行切片和切块。
-   Prometheus服务器节点是独立的，不依赖于共享存储。
-   目标发现可以是动态的，也可以通过静态配置。
-   内置时间序列存储，但必要时支持其他后端。
-   内置告警管理器，能够定义告警规则。

下图展示了整个系统：

![Prometheus架构](ch13-fig06.png)

**图13.6：Prometheus架构**

### 安装Prometheus

正如你所见，Prometheus是一个复杂的系统。安装它的最佳方式是使用Prometheus operator（https://github.com/prometheus-operator/）。kube-prometheus（https://github.com/prometheus-operator/kube-prometheus）子项目安装operator本身以及大量附加组件，并以稳健的方式配置它们。

第一步是克隆git仓库：

```shell
$ git clone https://github.com/prometheus-operator/kube-prometheus.git
Cloning into 'kube-prometheus'...
remote: Enumerating objects: 17062, done.
remote: Counting objects: 100% (185/185), done.
remote: Compressing objects: 100% (63/63), done.
remote: Total 17062 (delta 135), reused 155 (delta 116), pack-reused 16877
Receiving objects: 100% (17062/17062), 8.76 MiB | 11.63 MiB/s, done.
Resolving deltas: 100% (11135/11135), done.
```

接下来，setup清单安装几个CRD并创建一个名为 `monitoring` 的命名空间：

```shell
$ kubectl create -f manifests/setup
customresourcedefinition.apiextensions.k8s.io/alertmanagerconfigs.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/alertmanagers.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/podmonitors.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/probes.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/prometheuses.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/prometheusrules.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/servicemonitors.monitoring.coreos.com created
customresourcedefinition.apiextensions.k8s.io/thanosrulers.monitoring.coreos.com created
namespace/monitoring created
```

现在，我们可以安装清单：

```shell
$ kubectl create -f manifests
...
```

输出太长无法显示，但让我们检查一下实际安装了哪些内容。事实证明，它安装了多个Deployment、StatefulSet、一个DaemonSet和许多Service：

```shell
$ k get deployments -n monitoring
NAME                              READY   UP-TO-DATE   AVAILABLE   AGE
blackbox-exporter                 1/1     1            1           3m38s
grafana                           1/1     1            1           3m37s
kube-state-metrics                1/1     1            1           3m37s
prometheus-adapter                2/2     2            2           3m37s
prometheus-operator               1/1     1            1           3m37s

$ k get statefulsets -n monitoring
NAME                READY   AGE
alertmanager-main   3/3     2m57s
prometheus-k8s      2/2     2m57s

$ k get daemonsets -n monitoring
NAME            DESIRED   CURRENT   READY   UP-TO-DATE   AVAILABLE   NODE SELECTOR
node-exporter   1         1         1       1            1           kubernetes.io/os=linux

$ k get services -n monitoring
NAME                    TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
alertmanager-main       ClusterIP   10.96.231.0     <none>        9093/TCP,8080/TCP
alertmanager-operated   ClusterIP   None            <none>        9093/TCP,9094/UDP
blackbox-exporter       ClusterIP   10.96.239.94    <none>        9115/TCP,19115/TCP
grafana                 ClusterIP   10.96.80.116    <none>        3000/TCP
kube-state-metrics      ClusterIP   None            <none>        8443/TCP,9443/TCP
node-exporter           ClusterIP   None            <none>        9100/TCP
prometheus-adapter      ClusterIP   10.96.139.149   <none>        443/TCP
prometheus-k8s          ClusterIP   10.96.51.85     <none>        9090/TCP,8080/TCP
prometheus-operated     ClusterIP   None            <none>        9090/TCP
prometheus-operator     ClusterIP   None            <none>        8443/TCP
```

这是一个高可用性设置。如你所见，Prometheus本身部署为具有两个副本的StatefulSet，告警管理器部署为具有三个副本的StatefulSet。

Deployment包括blackbox-exporter、用于可视化指标的Grafana、用于收集Kubernetes特定指标的kube-state-metrics、Prometheus适配器（标准Kubernetes Metrics Server的兼容替代品），以及最后的Prometheus operator。

### 与Prometheus交互

Prometheus有一个基本的Web UI，你可以用来探索其指标。让我们进行端口转发到localhost：

```shell
$ k port-forward -n monitoring statefulset/prometheus-k8s 9090
Forwarding from 127.0.0.1:9090 -> 9090
Forwarding from [::1]:9090 -> 9090
```

然后，你可以浏览到 http://localhost:9090，在那里你可以选择不同的指标并查看原始数据或图表：

![Prometheus UI](images/ch13-fig07.png)

**图13.7：Prometheus UI**

Prometheus记录了大量的指标（在当前设置中有9090个）。Kubernetes上最相关的指标是由kube-state-metrics和node exporters暴露的指标。

### 集成kube-state-metrics

Prometheus operator已经安装了kube-state-metrics。它是一个监听Kubernetes事件并通过 `/metrics` HTTP端点以Prometheus期望的格式暴露它们的服务。所以，它是一个Prometheus exporter。

这与Kubernetes metrics server非常不同，后者是Kubernetes暴露节点和Pod指标的标准方式，也允许你暴露自己的自定义指标。Kubernetes metrics server是一个定期查询Kubernetes数据并将其存储在内存中的服务。它通过Kubernetes Metrics API暴露其数据。Prometheus适配器则适配Kubernetes metrics server的信息，并以Prometheus格式暴露它。

kube-state-metrics暴露的指标非常广泛。以下是指标组的列表，其本身已经相当庞大。每个组对应一个Kubernetes API对象，并包含多个指标：

-   CertificateSigningRequest Metrics
-   ConfigMap Metrics
-   CronJob Metrics
-   DaemonSet Metrics
-   Deployment Metrics
-   Endpoint Metrics
-   HorizontalPodAutoscaler Metrics
-   Ingress Metrics
-   Job Metrics
-   LimitRange Metrics
-   MutatingWebhookConfiguration Metrics
-   Namespace Metrics
-   NetworkPolicy Metrics
-   Node Metrics
-   PersistentVolume Metrics
-   PersistentVolumeClaim Metrics
-   PodDisruptionBudget Metrics
-   Pod Metrics
-   ReplicaSet Metrics
-   ReplicationController Metrics
-   ResourceQuota Metrics
-   Secret Metrics
-   Service Metrics
-   StatefulSet Metrics
-   StorageClass Metrics
-   ValidatingWebhookConfiguration Metrics
-   VerticalPodAutoscaler Metrics
-   VolumeAttachment Metrics

例如，以下是针对Kubernetes Service收集的指标：

-   `kube_service_info`
-   `kube_service_labels`
-   `kube_service_created`
-   `kube_service_spec_type`

### 利用node exporter

kube-state-metrics从Kubernetes API服务器收集节点信息，但这些信息相当有限。Prometheus自带自己的node exporter，它收集关于节点的大量底层信息。请记住，Prometheus可能是Kubernetes上事实上的标准指标平台，但它并非Kubernetes专用。对于其他使用Prometheus的系统，node exporter非常重要。在Kubernetes上，如果你管理自己的节点，这些信息也可能非常宝贵。

以下是node exporter暴露的一小部分指标：

![Node exporter指标](images/ch13-fig08.png)

**图13.8：Node exporter指标**

### 集成自定义指标

内置指标、节点指标和Kubernetes指标都很棒，但通常最有趣的指标是领域特定的，需要作为自定义指标来捕获。有两种方法可以实现：

-   编写你自己的exporter，并告诉Prometheus去抓取它
-   使用Push gateway，它允许你将指标推送到Prometheus

在我的书《Hands-On Microservices with Kubernetes》（https://www.packtpub.com/product/handson-microservices-with-kubernetes/9781789805468）中，我提供了一个完整的示例，说明如何从Go服务实现你自己的exporter。

如果你已经有一个基于推送的指标收集器，并且只想让Prometheus记录这些指标，那么Push gateway更合适。它提供了从其他指标收集系统到Prometheus的便捷迁移路径。

### 使用Alertmanager进行告警

收集指标是很好的，但当情况变糟时（或者理想情况下，在情况变糟之前），你希望得到通知。在Prometheus中，这是Alertmanager的工作。你可以将规则定义为基于表达式的指标，当这些表达式变为真时，它们会触发告警。

告警可以有多种用途。它们可以由负责缓解特定问题的控制器自动处理，它们可以在凌晨3点唤醒一个可怜的值班工程师，它们可以导致发送电子邮件或群聊消息，或这些方式的任意组合。

Alertmanager允许你将类似的告警分组为单个通知，如果其他告警已经触发，则抑制通知，以及静默告警。当大规模系统出现问题时，所有这些功能都很有用。相关方已经了解情况，不需要在排查和尝试寻找根本原因时，不断收到重复的告警或同一告警的多个变体不断触发。

Prometheus operator的一个很酷的地方是它在CRD中管理所有内容。这包括所有规则，包括告警规则：

```shell
$ k get prometheusrules -n monitoring
NAME                              AGE
alertmanager-main-rules           11h
grafana-rules                     11h
kube-prometheus-rules             11h
kube-state-metrics-rules          11h
kubernetes-monitoring-rules       11h
node-exporter-rules               11h
prometheus-k8s-prometheus-rules   11h
prometheus-operator-rules         11h
```

以下是检查节点文件系统可用磁盘空间是否低于阈值持续30分钟的 `NodeFilesystemAlmostOutOfSpace` 告警。如果你注意到，有两个几乎相同的告警。当可用空间低于5%时，触发警告级告警。但是，如果空间低于3%，则触发严重级告警。注意 `runbook_url` 字段，它指向一个页面，解释有关告警的更多信息以及如何缓解问题：

```shell
$ k get prometheusrules node-exporter-rules -n monitoring -o yaml | grep NodeFilesystemAlmostOutOfSpace -A 14
- alert: NodeFilesystemAlmostOutOfSpace
  annotations:
    description: Filesystem on {{ $labels.device }} at {{ $labels.instance }}
      has only {{ printf "%.2f" $value }}% available space left.
    runbook_url: https://runbooks.prometheus-operator.dev/runbooks/node/nodefilesystemalmostoutofspace
  expr: |
    (
      node_filesystem_avail_bytes{job="node-exporter",fstype!=""} / node_filesystem_size_bytes{job="node-exporter",fstype!=""} * 100 < 5
      and
      node_filesystem_readonly{job="node-exporter",fstype!=""} == 0
    )
  for: 30m
  labels:
    severity: warning
- alert: NodeFilesystemAlmostOutOfSpace
  annotations:
    description: Filesystem on {{ $labels.device }} at {{ $labels.instance }}
      has only {{ printf "%.2f" $value }}% available space left.
    runbook_url: https://runbooks.prometheus-operator.dev/runbooks/node/nodefilesystemalmostoutofspace
    summary: Filesystem has less than 3% space left.
  expr: |
    (
      node_filesystem_avail_bytes{job="node-exporter",fstype!=""} / node_filesystem_size_bytes{job="node-exporter",fstype!=""} * 100 < 3
      and
      node_filesystem_readonly{job="node-exporter",fstype!=""} == 0
    )
  for: 30m
  labels:
    severity: critical
```

告警非常重要，但也有时候你需要可视化系统的整体状态或深入探讨特定方面。这时就需要可视化了。

### 使用Grafana可视化指标

你已经看到了Prometheus Expression浏览器，它可以将指标以图表或表格形式显示。但我们可以做得更好。Grafana（https://grafana.com）是一个开源监控系统，专注于创建极其美观的指标可视化。它本身不存储指标，而是与许多数据源配合使用，Prometheus就是其中之一。Grafana也具有告警能力。当与Prometheus一起工作时，你可能更倾向于依赖其Alertmanager。

Prometheus operator会安装Grafana并配置大量有用的Kubernetes仪表盘。看看这个漂亮的Kubernetes容量仪表盘：

![Grafana仪表盘](images/ch13-fig09.png)

**图13.9：Grafana仪表盘**

要访问Grafana，请输入以下命令：

```shell
$ k port-forward -n monitoring deploy/grafana 3000
Forwarding from 127.0.0.1:3000 -> 3000
Forwarding from [::1]:3000 -> 3000
```

然后你可以浏览到 http://localhost:3000 并尽情使用Grafana。Grafana需要用户名和密码。默认凭据是用户名为 `admin`，密码也为 `admin`。

以下是在通过kube-prometheus部署Grafana时配置的一些默认仪表盘：

![默认Grafana仪表盘](ch13-fig10.png)

**图13.10：默认Grafana仪表盘**

如你所见，列表相当广泛，但你也可以根据需要定义自己的仪表盘。你可以使用Grafana创建许多炫酷的可视化效果。我鼓励你进一步探索它。

Grafana仪表盘存储为ConfigMap。如果你想添加自定义仪表盘，只需添加一个包含仪表盘规范的ConfigMap。有一个专用的Sidecar容器在监视新添加的ConfigMap，并确保添加你的自定义仪表盘。

你也可以通过Grafana UI添加仪表盘。

### 考虑Loki

如果你喜欢Prometheus和Grafana，但尚未确定集中式日志记录解决方案（或者你对你当前的日志记录解决方案不满意），那么你应该考虑Grafana Loki（https://grafana.com/oss/loki/）。Loki是一个受Prometheus启发的日志聚合开源项目。与大多数日志聚合系统不同，它不对日志内容建立索引，而是对应用于日志的一组标签建立索引。这使得它非常高效。它仍然相对较新（始于2018年），所以在决定采用之前，你应该评估它是否符合你的需求。有一点是肯定的：Loki拥有出色的Grafana支持。

当使用Prometheus作为指标平台时，Loki相比EFK等解决方案有几个优势。特别是，你用于标记指标的标签集同样适用于标记你的日志。此外，Grafana被用作日志和指标的统一可视化平台也很有用。

我们已经花了大量时间讨论Kubernetes上的指标。接下来谈谈分布式追踪和Jaeger项目。

## 在Kubernetes中使用分布式追踪

在基于微服务的系统中，每个请求可能需要在多个微服务之间传递、在队列中等待并触发无服务器函数。为了调试和排查此类系统，你需要能够跟踪请求并沿着其路径进行追踪。

分布式追踪提供了几种能力，使开发人员和运维人员能够理解其分布式系统：

-   分布式事务监控
-   性能和延迟跟踪
-   根因分析
-   服务依赖分析
-   分布式上下文传播

分布式追踪通常需要应用程序和服务参与检测端点。由于微服务世界是多语言的，可能使用多种编程语言。使用支持多种编程语言的共享分布式追踪规范和框架是合理的。这就是OpenTelemetry。

### 什么是OpenTelemetry？

OpenTelemetry（https://opentelemetry.io）是一个API规范以及一组不同语言的框架和库，用于检测、收集和导出日志、指标和追踪。它诞生于2019年5月OpenCensus和OpenTracing项目的合并。它也是一个CNCF孵化项目。OpenTelemetry受到多个产品的支持，并已成为事实上的标准。它可以从各种开源和商业来源收集数据。在此查看完整列表：https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver。

通过使用符合OpenTelemetry的产品，你不会被锁定，并且你将使用一个可能对你的开发人员来说熟悉的API。

几乎所有主流编程语言都有检测库：

-   C++
-   .NET
-   Erlang/Elixir
-   Go
-   Java
-   JavaScript
-   PHP
-   Python
-   Ruby
-   Rust
-   Swift

### OpenTelemetry追踪概念

我们将重点介绍OpenTelemetry的追踪概念，跳过我们之前已经介绍过的日志和指标概念。

两个主要概念是Span（跨度）和Trace（追踪）。

Span是工作或操作的基本单位。它有一个名称、开始时间和持续时间。如果一个操作启动了另一个操作，Span可以嵌套。Span使用唯一的ID和上下文进行传播。Trace是从同一请求发起并共享相同上下文的Span的非循环图。Trace代表了请求在整个系统中的执行路径。下图说明了Trace和Span之间的关系：

![Trace与Span在OpenTelemetry中的关系](ch13-fig11.png)

**图13.11：OpenTelemetry中Trace与Span的关系**

现在我们已经了解了OpenTelemetry是什么，让我们看看Jaeger项目。

### 介绍Jaeger

Jaeger（https://www.jaegertracing.io/）是另一个CNCF毕业项目，与Fluentd和Prometheus一样。它完成了Kubernetes的CNCF毕业可观测性项目三位一体。Jaeger最初由Uber开发，并迅速成为Kubernetes的首选分布式追踪解决方案。

还有其他开源的分布式追踪系统，如Zipkin（https://zipkin.io）和SigNoz（https://signoz.io）。这些系统（以及Jaeger）的灵感大多来自Google的Dapper（https://research.google.com/pubs/pub36356.html）。云平台提供自己的追踪器，例如AWS X-Ray。该领域还有多个商业产品：

-   Aspecto（https://www.aspecto.io）
-   Honeycomb（https://www.honeycomb.io）
-   Lightstep（http://lightstep.com）

Jaeger的优势在于：

-   可扩展设计
-   支持多种协议——OpenTelemetry、OpenTracing和Zipkin
-   轻量内存占用
-   代理通过UDP收集指标
-   高级采样控制

### Jaeger架构

Jaeger是一个可扩展的系统。它可以作为一个包含所有组件的单一二进制文件部署，并将数据存储在内存中，也可以作为一个分布式系统部署，其中Span和追踪存储在持久化存储中。

Jaeger有多个组件协同工作，提供世界级的分布式追踪体验。下图说明了该架构：

![Jaeger架构](ch13-fig12.png)

**图13.12：Jaeger架构**

让我们了解每个组件的用途。

#### 客户端库

最初，Jaeger有自己的客户端库，实现了OpenTracing API，用于检测服务或应用程序以进行分布式追踪。现在，Jaeger推荐使用OpenTelemetry客户端库。Jaeger客户端库已被弃用。

#### Jaeger代理

代理在每个节点本地部署。它通过UDP监听Span——这使得它性能相当高——将它们批处理并发批量发送到收集器。这样，服务不需要发现收集器或担心连接到它。被检测的服务只需将它们的Span发送到本地代理。代理还可以告知客户端有关采样策略的信息。

#### Jaeger收集器

收集器接收来自所有代理的追踪。它负责验证和转换追踪。然后它将追踪发送到数据存储或Kafka实例，后者能够实现追踪的异步处理。

#### Jaeger Ingester

Ingester对追踪建立索引，以便后续进行轻松高效的查询，并将其存储在数据存储中，数据存储可以是Cassandra或Elasticsearch集群。

#### Jaeger Query

Jaeger Query服务负责提供一个UI来查询收集器存储在存储中的追踪和Span。

以上涵盖了Jaeger的架构及其组件。让我们看看如何安装和使用它。

### 安装Jaeger

有用于安装Jaeger和Jaeger operator的Helm Charts：

```shell
$ helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
"jaegertracing" has been added to your repositories
$ helm search repo jaegertracing
NAME                             CHART VERSION   APP VERSION   DESCRIPTION
jaegertracing/jaeger             0.62.1          1.37.0        A Jaeger Helm chart for Kubernetes
jaegertracing/jaeger-operator    2.36.0          1.38.0        jaeger-operator Helm chart for Kubernetes
```

Jaeger operator需要cert-manager，但不会自动安装它。让我们先安装它：

```shell
$ helm repo add jetstack https://charts.jetstack.io
"jetstack" has been added to your repositories
$ helm install \
  cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.9.1 \
  --set installCRDs=true
NAME: cert-manager
LAST DEPLOYED: Mon Oct 17 10:28:43 2022
NAMESPACE: cert-manager
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
cert-manager v1.9.1 has been deployed successfully!
...
```

现在，我们可以将Jaeger operator安装到observability命名空间：

```shell
$ helm install jaeger jaegertracing/jaeger-operator \
  -n observability --create-namespace
NAME: jaeger
LAST DEPLOYED: Mon Oct 17 10:30:58 2022
NAMESPACE: observability
STATUS: deployed
REVISION: 1
TEST SUITE: None
NOTES:
jaeger-operator is installed.
...
```

该部署名为 `jaeger-jaeger-operator`：

```shell
$ k get deploy -n observability
NAME                      READY   UP-TO-DATE   AVAILABLE   AGE
jaeger-jaeger-operator    1/1     1            1           3m21s
```

现在，我们可以使用Jaeger CRD创建一个Jaeger实例。operator会监视这个自定义资源，并创建所有必要的资源。以下是最简单的Jaeger配置。它使用默认的AllInOne策略，部署一个包含所有组件（代理、收集器、查询、ingester和Jaeger UI）的单个Pod，并使用内存存储。这适用于本地开发和测试目的：

```shell
$ cat <<EOF | k apply -f -
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: simplest
  namespace: observability
EOF
jaeger.jaegertracing.io/simplest created
$ k get jaegers -n observability
NAME       STATUS    VERSION   STRATEGY   STORAGE   AGE
simplest   Running   1.37.0    allInOne   memory    5m54s
```

让我们启动Jaeger UI：

```shell
$ k port-forward deploy/simplest 8080:16686 -n observability
Forwarding from 127.0.0.1:8080 -> 16686
Forwarding from [::1]:8080 -> 16686
```

现在，我们可以浏览到 http://localhost:8080 并看到Jaeger UI：

![Jaeger UI](ch13-fig13.png)

**图13.13：Jaeger UI**

在下一章，第14章"使用服务网格"中，我们将更多地了解Jaeger以及如何专门使用它来追踪通过服务网格的请求。现在，让我们将注意力转向使用我们讨论过的所有监控和可观测性机制进行故障排除。

## 排查问题

排查复杂的分布式系统绝非易事。抽象、关注点分离、信息隐藏和封装在开发、测试以及对系统进行更改时非常有用。但是当问题出现时，你需要跨越所有这些边界和抽象层，从用户在应用程序中的操作开始，贯穿整个堆栈，一直到基础设施，跨越所有业务逻辑、异步流程、遗留系统和第三方集成。即使对于大型单体系统来说这也是一个挑战，对于基于微服务的分布式系统更是如此。监控会帮助你，但让我们先谈谈准备、流程和最佳实践。

### 利用预发环境

在构建大型系统时，开发人员在其本地机器上工作（这里忽略云开发环境），最终代码被部署到生产环境。但是在这两个极端之间有几个步骤。复杂系统在一个不易在本地复制的环境中运行。

你应该在与生产环境相似的环境中测试代码或配置的更改。这就是你的预发环境，你应当在此捕获大多数在开发人员本地运行测试时无法捕获的问题。

软件交付流程应尽可能早地检测到不良代码和配置。但有时，不良更改只会在生产环境中被检测到并引发事件。你应该有一个事件管理流程，通常涉及回滚导致问题的任何组件到之前的版本，然后通过查看日志、指标和追踪来尝试找到根本原因——有时也需要在预发环境中进行调试。

但有时，问题不在于你的代码或配置。最终，你的Kubernetes集群运行在节点上（是的，即使是托管的），而这些节点可能会遇到许多问题。

### 检测节点级别的问题

在Kubernetes的概念模型中，工作单元是Pod。然而，Pod是被调度到节点上的。在监控和基础设施的可靠性方面，节点是最需要关注的部分，因为Kubernetes本身（调度器、ReplicaSet和水平Pod自动扩缩器）负责处理Pod。kubelet能够感知节点上的许多问题，并将更新API服务器。

你可以使用以下命令查看节点状态以及它是否就绪：

```shell
$ k describe no kind-control-plane | grep Conditions -A 6
Conditions:
  Type                 Status  LastHeartbeatTime                 Reason
  ----                 ------  -------------------               ------
  MemoryPressure       False   Fri, 21 Oct 2022 01:09:33 -0700   KubeletHasSufficientMemory
  DiskPressure         False   Fri, 21 Oct 2022 01:09:33 -0700   KubeletHasNoDiskPressure
  PIDPressure          False   Fri, 21 Oct 2022 01:09:33 -0700   KubeletHasSufficientPID
  Ready                True    Fri, 21 Oct 2022 01:09:33 -0700   KubeletReady
```

注意最后一个条件 `Ready`。这意味着Kubernetes可以将待调度的Pod调度到这个节点。但是，可能存在kubelet无法检测到的问题。一些问题包括：

-   不良的CPU
-   不良的内存
-   不良的磁盘
-   内核死锁
-   文件系统损坏
-   容器运行时（例如，Docker守护进程）的问题

我们需要另一种解决方案。这就是节点问题检测器。

节点问题检测器是一个运行在每个节点上的Pod。它需要解决一个难题。它必须能够检测不同环境、不同硬件和不同操作系统中的各种底层问题。它必须足够可靠，使自己不受影响（否则它无法报告问题），并且需要相对较低的开销，以避免对控制平面造成过多请求。源代码位于 https://github.com/kubernetes/node-problem-detector。

最自然的方式是将节点问题检测器部署为DaemonSet，这样每个节点上始终运行着一个节点问题检测器。在Google的GKE集群上，它作为附加组件运行。

### 问题守护进程

节点问题检测器的问题（双关语意在言外）在于它需要处理的问题太多了。试图将所有问题塞入单个代码库可能导致复杂、臃肿且永不稳定的代码库。节点问题检测器的设计要求将向主节点报告节点问题的核心功能与具体问题检测分离开来。

报告API基于通用条件和事件。问题检测应由单独的问题守护进程（每个在其自己的容器中）完成。这样，可以在不影响核心节点问题检测器的情况下添加和发展新的问题检测器。此外，控制平面可能有一个补救控制器，可以自动解决某些节点问题，从而实现自愈。

目前，问题守护进程内置于节点问题检测器二进制文件中，并作为Go协程执行，因此你还不能享受到松散耦合设计的好处。将来，每个问题守护进程将在其自己的容器中运行。

除了节点问题之外，另一个可能出问题的领域是网络。我们之前讨论的各种监控工具可以帮助我们识别基础设施、代码或第三方依赖中的问题。

让我们谈谈工具箱中的各种选项，它们如何比较，以及如何利用它们获得最大效果。

### 仪表盘与告警

仪表盘纯粹是为了人类用户。一个好的仪表盘的理念是在一眼内提供大量关于系统或特定组件状态的有用信息。设计好的仪表盘涉及许多用户体验元素，就像设计任何用户界面一样。监控仪表盘可以涵盖跨许多组件、长时间段的大量数据，并且可能支持深入下钻到越来越细的细节级别。

另一方面，告警定期检查某些条件（通常基于指标），当触发时，可以导致告警原因的自动解决，或者最终通知人类，而人类可能会通过查看某些仪表盘开始调查。

自愈系统可以自动处理某些告警（或者理想情况下，在告警甚至被触发之前就解决问题）。人类通常会参与故障排除。即使在系统在某个时刻自动从问题中恢复的情况下，人类也会审查系统采取的行动，并验证当前行为（包括问题的自动恢复）是否适当。

在许多情况下，由人类在查看仪表盘时发现的严重问题（不可扩展）或由告警通知的问题将需要一些调查、修复以及事后的复盘。在所有阶段，下一层监控都会发挥作用。

### 日志 vs. 指标 vs. 错误报告

让我们了解这些工具各自擅长什么，以及如何最好地结合它们的优势来调试困难问题。假设我们有良好的测试覆盖，并且我们的业务/领域逻辑代码基本正确。我们在生产环境中遇到了问题。可能存在几种只在生产环境中发生的问题：

-   配置错误（生产配置不正确或过时）
-   基础设施配置
-   对数据、服务或第三方集成的权限或访问不足
-   环境特定代码
-   由生产输入暴露的软件缺陷
-   可扩展性和性能问题

这个列表相当长，而且可能还不完整。通常，当出现问题时，是对某些更改的响应。我们说的是哪种更改？以下是几个例子：

-   部署新版本的代码
-   对已部署应用程序的动态重新配置
-   新用户或现有用户改变他们与系统交互的方式
-   底层基础设施的更改（例如，由云提供商进行的更改）
-   代码中首次使用的新路径（例如，回退到另一个区域）

由于问题和原因的范围如此之广，很难提出一个线性的解决路径。例如，如果故障导致了错误，那么查看错误报告可能是最佳的起点。但是，如果问题是某个本应发生的行为没有发生，那么就没有错误可以查看。在这种情况下，查看日志并将其与之前成功请求的日志进行比较可能是有意义的。如果是基础设施或可扩展性问题，指标可能给我们提供最佳的初步洞察。

底线是，调试分布式系统需要同时使用多种工具来追寻那难以捉摸的根本原因。

当然，在具有大量组件和微服务的分布式系统中，甚至不清楚从哪里开始查找。这就是分布式追踪的优势所在，它可以帮助我们缩小范围并识别罪魁祸首。

### 使用分布式追踪检测性能和根本原因

有了分布式追踪，每个请求都会生成一个带有Span图的Trace。Jaeger默认使用1/1000的采样率，所以偶尔问题可能会逃逸检测，但对于持续性故障，我们将能够追踪请求的路径，查看每个Span花费的时间，如果请求的处理因某种原因失败，将很容易注意到。此时，你再回到日志、指标和错误来寻找根本原因。

如你所见，在像Kubernetes这样的复杂系统中排查问题绝非易事。你需要全面的可观测性，包括日志记录、指标和分布式追踪。你还需要对系统有深入的了解和理解，才能快速可靠地配置、监控和缓解问题。

## 总结

在本章中，我们涵盖了监控、可观测性和故障排除的主题。我们从回顾监控的各个方面开始：日志、指标、错误报告和分布式追踪。然后，我们讨论了如何将监控能力集成到你的Kubernetes集群中。我们考察了几个CNCF项目，如用于日志聚合的Fluentd、用于指标收集和告警管理的Prometheus、用于可视化的Grafana以及用于分布式追踪的Jaeger。然后，我们探讨了大型分布式系统的故障排除。我们意识到了它有多么困难，以及为什么我们需要如此多不同的工具来攻克这些问题。

在下一章中，我们将更上一层楼，深入探讨服务网格。我对服务网格感到非常兴奋，因为它们将许多与云原生微服务应用程序相关的复杂性提取出来，并将其外部化到微服务之外。这具有很大的实际价值。

加入我们的Discord！
与其他用户、云专家、作者和有志之士一起阅读本书。
提问、为其他读者提供解决方案、通过"Ask Me Anything"环节与作者聊天等等。
扫描二维码或访问链接立即加入社区。
https://packt.link/cloudanddevops
