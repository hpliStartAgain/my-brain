---
title: "探索 Kubernetes 网络"
date: 2026-05-13
tags: [Kubernetes, 网络, CNI]
aliases: [Exploring Kubernetes Networking]
---

# 探索Kubernetes网络

在本章中，我们将考察网络这个重要主题。Kubernetes作为一个编排平台，管理运行在不同机器（物理或虚拟）上的容器/Pod，需要一个明确的网络模型。我们将考察以下主题：

- 理解Kubernetes网络模型
- Kubernetes网络插件
- Kubernetes和eBPF
- Kubernetes网络解决方案
- 有效使用网络策略
- 负载均衡选项

通过本章的学习，你将理解Kubernetes的网络方法，并熟悉标准接口、网络实现和负载均衡等方面的解决方案空间。如果你愿意，你甚至能够编写你自己的CNI（容器网络接口）插件。

## 理解Kubernetes网络模型

Kubernetes网络模型基于一个扁平的地址空间。集群中的所有Pod可以直接互相通信。每个Pod都有自己的IP地址。无需配置任何网络地址转换（NAT）。此外，同一Pod中的容器共享其Pod的IP地址，并可以通过localhost相互通信。这个模型非常明确，但一旦设置好，它可以大大简化开发人员和管理员的工作。它特别容易将传统的网络应用迁移到Kubernetes上。一个Pod代表一个传统节点，每个容器代表一个传统进程。

我们将涵盖以下内容：

- Pod内通信
- Pod到Service通信
- 外部访问
- 查找与发现
- Kubernetes中的DNS

### Pod内通信（容器到容器）

一个正在运行的Pod总是被调度到一个（物理或虚拟）节点上。这意味着所有容器运行在同一个节点上，并可以通过多种方式相互通信，例如通过本地文件系统、任何IPC机制，或使用localhost和已知端口。不同Pod之间不存在端口冲突的风险，因为每个Pod都有自己的IP地址，当Pod中的容器使用localhost时，它只应用于该Pod的IP地址。所以如果Pod 1中的容器1连接到端口1234，而Pod 1中的容器2正在监听该端口，它不会与运行在同一节点上的Pod 2中也在监听端口1234的另一容器冲突。唯一的警告是，如果你正在向宿主机暴露端口，那么你应该小心Pod到节点的亲和性。这可以通过几种机制来处理，如DaemonSet和Pod反亲和性。

### Pod间通信（Pod到Pod）

Kubernetes中的Pod被分配了一个网络可见的IP地址（不是节点私有的）。Pod可以直接通信，无需NAT、隧道、代理或任何其他混淆层的帮助。可以使用已知端口号进行免配置的通信方案。Pod的内部IP地址与其他Pod看到的外部IP地址相同（在集群网络内；不暴露给外部世界）。这意味着像DNS（域名系统）这样的标准命名和发现机制可以开箱即用。

### Pod到Service通信

Pod可以直接使用其IP地址和已知端口相互通信，但这要求Pod知道彼此的IP地址。在Kubernetes集群中，Pod可以被不断销毁和创建。同一Pod规约也可能有多个副本，每个副本都有自己的IP地址。Kubernetes Service资源提供了一个非常有用的间接层，因为即使响应请求的实际Pod集合不断变化，Service也是稳定的。此外，你还可以获得自动、高可用的负载均衡，因为每个节点上的kube-proxy负责将流量重定向到正确的Pod：

![使用Service进行内部负载均衡](ch10-fig01.png)

### 外部访问

最终，某些容器需要从外部世界可访问。Pod的IP地址在外部不可见。Service是正确的载体，但外部访问通常需要两次重定向。例如，云提供商负载均衡器不感知Kubernetes，因此它们无法直接将流量定向到运行着可以处理请求的Pod的特定节点。相反，公共负载均衡器只是将流量定向到集群中的任意节点，如果当前节点没有运行所需的Pod，该节点上的kube-proxy将再次将其重定向到合适的Pod。

下图展示了外部负载均衡器如何将流量发送到任意节点，而kube-proxy在需要时负责进一步路由：

![外部负载均衡器发送流量到任意节点](ch10-fig02.png)

### 查找与发现

为了让Pod和容器相互通信，它们需要找到对方。容器有几种方式来定位其他容器或宣告自己，我们将在以下小节中讨论。每种方法都有其自身的优缺点。

### 自注册

我们之前多次提到自注册。让我们准确理解它的含义。当一个容器运行时，它知道其Pod的IP地址。每个希望被集群中其他容器访问的容器都可以连接到某个注册服务，并注册其IP地址和端口。其他容器可以查询注册服务，获取所有已注册容器的IP地址和端口，并连接到它们。当一个容器被销毁（优雅地）时，它会注销自己。如果一个容器非优雅地挂了，那么需要建立某种机制来检测这一点。例如，注册服务可以定期ping所有已注册的容器，或者可以要求容器定期向注册服务发送保活消息。

自注册的好处是，一旦通用注册服务就位（无需为不同目的定制它），就无需担心跟踪容器的问题。另一个巨大的好处是，容器可以采用复杂的策略，并基于本地条件决定临时注销（如果它们不可用）；例如，如果一个容器正忙，不想在当前时刻接收更多请求。这种智能和去中心化的动态负载均衡在没有注册服务的情况下很难全局实现。缺点是注册服务是另一个非标准组件，容器需要了解它才能定位其他容器。

### Service和Endpoint

Kubernetes Service可以被视为标准的注册服务。属于Service的Pod基于其标签自动注册。其他Pod可以查找Endpoint以找到所有服务Pod，或利用Service本身直接向Service发送消息，该消息将被路由到其中一个后端Pod。尽管大多数时候，Pod只需将消息发送给Service本身，后者将其转发给一个后端Pod。动态成员资格可以通过Deployment的副本数、健康检查、就绪检查和HPA的组合来实现。

### 使用队列的松耦合连接

如果容器可以在不知道彼此的IP地址和端口甚至Service IP地址或网络名称的情况下相互通信呢？如果大多数通信可以是异步和解耦的呢？在许多情况下，系统可以由松耦合的组件组成，这些组件不仅不知道其他组件的身份，甚至不知道其他组件的存在。

队列促进了这种松耦合系统。组件（容器）监听队列中的消息、响应消息、执行其工作，并向队列发布消息，如进度消息、完成状态和错误。队列有许多好处：

- 易于通过添加更多监听队列的容器来增加处理能力，无需协调
- 易于基于队列深度跟踪整体负载
- 易于通过对消息和/或队列主题进行版本控制来让多个版本的组件并排运行
- 易于通过让多个消费者以不同模式处理请求来实现负载均衡和冗余
- 易于动态添加或删除其他类型的监听器

队列的缺点如下：

- 你需要确保队列提供适当的持久性和高可用性，使其不会成为关键的单点故障（SPOF）
- 容器需要使用异步队列API（可以抽象掉）
- 实现请求-响应需要相当繁琐的响应队列监听

总的来说，队列是大规模系统的优秀机制，可以在大型Kubernetes集群中利用它们来简化协调。

### 使用数据存储的松耦合连接

另一种松耦合方法是使用数据存储（例如Redis）来存储消息，然后其他容器可以读取它们。虽然可能，但这并不是数据存储的设计目标，结果往往繁琐、脆弱且性能不佳。数据存储针对数据存储和访问进行了优化，而不是通信。话虽如此，数据存储可以与队列结合使用，其中一个组件将一些数据存储在数据存储中，然后向队列发送消息，表明数据已准备好处理。多个组件监听该消息，并全部开始并行处理数据。

### Kubernetes Ingress

Kubernetes提供了一个Ingress资源和控制器，旨在将Kubernetes Service暴露给外部世界。当然，你可以自己完成，但对于特定类型的Ingress（如Web应用、CDN或DDoS防护），定义Ingress所涉及的许多任务在大多数应用中都是通用的。你也可以编写自己的Ingress对象。

Ingress对象通常用于智能负载均衡和TLS终止。无需配置和部署自己的Nginx服务器，你可以从内置的入口控制器中受益。如果需要复习，请查看第5章"在实践中使用Kubernetes资源"，其中我们通过示例讨论了Ingress资源。

### Kubernetes中的DNS

DNS是网络中的基石技术。在IP网络上可达的主机都有IP地址。DNS是一个层次化和去中心化的命名系统，在IP地址之上提供了一层间接性。这对于几种用例很重要，例如：

- 负载均衡
- 动态替换具有不同IP地址的主机
- 为众所周知的接入点提供人类友好的名称

DNS是一个广阔的主题，完整的讨论超出了本书的范围。仅给你一个概念，有数十个不同的RFC标准涵盖DNS：https://en.wikipedia.org/wiki/Domain_Name_System#Standards。

在Kubernetes中，主要的可寻址资源是Pod和Service。每个Pod和Service在集群内都有一个唯一的内部（私有）IP地址。kubelet通过一个 `resolve.conf` 文件配置Pod，该文件将Pod指向内部DNS服务器。这是它的样子：

```bash
$ k run -it --image g1g1/py-kube:0.3 -- bash
root@bash:/# cat /etc/resolv.conf
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

nameserver IP地址 `10.96.0.10` 是 `kube-dns` Service的地址：

```bash
$ k get svc -n kube-system
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)                  AGE
kube-dns     ClusterIP   10.96.0.10   <none>        53/UDP,53/TCP,9153/TCP   19m
```

Pod的主机名默认就是其元数据名称。如果你希望Pod在集群内部拥有完全限定域名，你可以创建一个无头Service，并显式设置主机名和子域为Service名称。以下是设置两个Pod（`py-kube1` 和 `py-kube2`）的DNS的方法，它们的主机名分别为 `trouble1` 和 `trouble2`，子域名为 `maker`，与无头Service匹配：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: maker
spec:
  selector:
    app: py-kube
  clusterIP: None # 无头服务
---
apiVersion: v1
kind: Pod
metadata:
  name: py-kube1
  labels:
    app: py-kube
spec:
  hostname: trouble
  subdomain: maker
  containers:
  - image: g1g1/py-kube:0.3
    command:
    - sleep
    - "9999"
    name: trouble
---
apiVersion: v1
kind: Pod
metadata:
  name: py-kube2
  labels:
    app: py-kube
spec:
  hostname: trouble2
  subdomain: maker
  containers:
  - image: g1g1/py-kube:0.3
    command:
    - sleep
    - "9999"
    name: trouble
```

让我们创建Pod和Service：

```bash
$ k apply -f pod-with-dns.yaml
service/maker created
pod/py-kube1 created
pod/py-kube2 created
```

现在，我们可以检查Pod内部的主机名和DNS解析。首先，我们将连接到 `py-kube2` 并验证其主机名为 `trouble2`，FQDN为 `trouble2.maker.default.svc.cluster.local`。然后，我们可以解析 `trouble` 和 `trouble2` 的FQDN：

```bash
$ k exec -it py-kube2 -- bash
root@trouble2:/# hostname
trouble2
root@trouble2:/# hostname --fqdn
trouble2.maker.default.svc.cluster.local
root@trouble2:/# dig +short trouble.maker.default.svc.cluster.local
10.244.0.10
root@trouble2:/# dig +short trouble2.maker.default.svc.cluster.local
10.244.0.9
```

为了闭环，让我们确认IP地址 `10.244.0.10` 和 `10.244.0.9` 确实属于 `py-kube1` 和 `py-kube2` Pod：

```bash
$ k get po -o wide
NAME      READY   STATUS    RESTARTS   AGE   IP            NODE
py-kube1  1/1     Running   0          10m   10.244.0.10   kind-control-plane
py-kube2  1/1     Running   0          18m   10.244.0.9    kind-control-plane
```

还有额外的配置选项和DNS策略可以应用。参见 https://kubernetes.io/docs/concepts/services-networking/dns-pod-service。

### CoreDNS

之前，我们提到kubelet使用 `resolve.conf` 文件配置Pod，将它们指向内部DNS服务器，但这个内部DNS服务器藏在哪里？你可以在 `kube-system` 命名空间中找到它。该Service称为 `kube-dns`：

```bash
$ k describe svc -n kube-system kube-dns
Name:              kube-dns
Namespace:         kube-system
Labels:            k8s-app=kube-dns
                   kubernetes.io/cluster-service=true
                   kubernetes.io/name=CoreDNS
Selector:          k8s-app=kube-dns
Type:              ClusterIP
IP:                10.96.0.10
Port:              dns  53/UDP
Port:              dns-tcp  53/TCP
Port:              metrics  9153/TCP
```

注意 `selector: k8s-app=kube-dns`。让我们找到支持此Service的Pod：

```bash
$ k get po -n kube-system -l k8s-app=kube-dns
NAME                     READY   STATUS    RESTARTS   AGE
coredns-64897985d-n4x5b  1/1     Running   0          97m
coredns-64897985d-nqtwk  1/1     Running   0          97m
```

Service称为 `kube-dns`，但Pod的前缀是 `coredns`。有趣。让我们检查Deployment使用的镜像：

```bash
$ k get deploy coredns -n kube-system -o jsonpath='{.spec.template.spec.containers[0]}' | jq .image
"k8s.gcr.io/coredns/coredns:v1.8.6"
```

这种不匹配的原因在于，最初默认的Kubernetes DNS服务器称为 `kube-dns`。后来，CoreDNS因其简化的架构和更好的性能而取代了它，成为主流的DNS服务器。

我们已经涵盖了关于Kubernetes网络模型及其组件的大量信息。在下一节中，我们将介绍通过CNI和Kubenet等标准接口实现此模型的Kubernetes网络插件。

## Kubernetes网络插件

Kubernetes有一个网络插件系统，因为网络是如此多样化，不同的人可能希望以不同的方式实现它。Kubernetes足够灵活，可以支持任何场景。主要的网络插件是CNI，我们将深入讨论它。但Kubernetes也附带一个更简单的网络插件，称为Kubenet。在深入了解细节之前，让我们先统一对Linux网络基础的认识（这只是冰山一角）。这很重要，因为Kubernetes网络构建在标准Linux网络之上，你需要这个基础来理解Kubernetes网络的工作原理。

### Linux网络基础

Linux默认有一个共享的网络空间。物理网络接口都在此命名空间中可访问。但物理命名空间可以划分为多个逻辑命名空间，这与容器网络非常相关。

### IP地址和端口

网络实体通过其IP地址来标识。服务器可以在多个端口上监听传入连接。客户端可以在其网络内连接到服务器（TCP）或发送/接收数据（UDP）。

### 网络命名空间

命名空间将一组网络设备分组，使它们可以到达同一命名空间中的其他服务器，但无法到达其他命名空间中的服务器，即使它们在物理上位于同一网络上。网络或网络段的连接可以通过桥接、交换机、网关和路由来完成。

### 子网、网络掩码和CIDR

网络段的粒度划分在设计和维护网络时非常有用。将网络划分为具有共同前缀的较小子网是一种常见做法。这些子网可以由位掩码定义，表示子网的大小（可以包含多少台主机）。例如，网络掩码 `255.255.255.0` 意味着前三个八位用于路由，只有256个（实际上是254个）独立主机可用。CIDR（无类别域间路由）表示法通常用于此目的，因为它更简洁、编码更多信息，并且允许组合来自多个传统类别（A、B、C、D、E）的主机。例如，`172.27.15.0/24` 意味着前24位（3个八位）用于路由。

### 虚拟以太网设备

虚拟以太网（veth）设备代表物理网络设备。当你创建链接到物理设备的veth时，你可以将该veth（以及扩展的物理设备）分配到一个命名空间中，来自其他命名空间的设备无法直接访问它，即使它们在物理上位于同一本地网络上。

### 桥接

桥接将多个网络段连接到一个聚合网络，使所有节点可以相互通信。桥接在OSI网络模型的第2层（数据链路层）完成。

### 路由

路由连接不同的网络，通常基于路由表，路由表指示网络设备如何将数据包转发到其目的地。路由通过各种网络设备完成，如路由器、网关、交换机和防火墙，包括常规的Linux机器。

### 最大传输单元

MTU（最大传输单元）决定了数据包可以有多大。例如，在以太网网络上，MTU为1,500字节。MTU越大，有效载荷和头部之间的比率越好，这是件好事。但缺点是，最小延迟会增加，因为你必须等待整个数据包到达，而且，在发生故障时，你必须重新传输整个大数据包。

### Pod网络

下图描述了在网络层面通过veth0连接的Pod、宿主机和全球互联网之间的关系：

![Pod网络](ch10-fig03.png)

### Kubenet

回到Kubernetes。Kubenet是一个网络插件。它非常简单：它建立一个名为 `cbr0` 的Linux桥接，并为每个Pod创建一个veth接口。云提供商通常使用它来配置节点间通信的路由规则，或在单节点环境中使用。veth对使用宿主机IP地址范围内的IP地址将每个Pod连接到其宿主机节点。

### 要求

Kubenet插件有以下要求：

- 必须为节点分配一个子网，以向其Pod分配IP地址
- 必须安装版本0.2.0或更高的标准CNI桥接、lo和host-local插件
- kubelet必须使用 `--network-plugin=kubenet` 标志执行
- kubelet必须使用 `--non-masquerade-cidr=<clusterCidr>` 标志执行
- kubelet必须使用 `--pod-cidr` 运行，或者kube-controller-manager必须使用 `--allocate-node-cidrs=true --cluster-cidr=<cidr>` 运行

### 设置MTU

MTU对网络性能至关重要。Kubenet等Kubernetes网络插件尽力推断最佳MTU，但有时它们需要帮助。如果现有网络接口（例如docker0桥接）设置了较小的MTU，那么Kubenet将重用它。另一个例子是IPsec，由于IPsec封装带来的额外开销，需要降低MTU，但Kubenet网络插件没有考虑这一点。解决方案是不依赖MTU的自动计算，而是通过 `--network-plugin-mtu` 命令行开关告诉kubelet应该为网络插件使用什么MTU，该开关提供给所有网络插件。然而，目前只有Kubenet网络插件考虑这个命令行开关。

Kubenet网络插件主要是为了向后兼容而存在。CNI是主要网络接口，所有现代网络解决方案提供商都实现它以与Kubernetes集成。让我们看看它到底是什么。

### CNI

CNI是一个规范以及一组用于编写网络插件以配置Linux容器中网络接口的库。该规范实际上是从rkt网络提案演变而来的。CNI现在是一个成熟的行业标准，甚至超越了Kubernetes。使用CNI的一些组织包括：

- Kubernetes
- OpenShift
- Mesos
- Kurma
- Cloud Foundry
- Nuage
- IBM
- AWS EKS和ECS
- Lyft

CNI团队维护一些核心插件，但也有许多第三方插件为CNI的成功做出了贡献。以下是一个非详尽的列表：

- **Project Calico**：Kubernetes的L3虚拟网络
- **Weave**：连接跨多个主机的多个Docker容器的虚拟网络
- **Contiv Networking**：基于策略的网络
- **Cilium**：用于容器的eBPF
- **Flannel**：Kubernetes的L3网络结构
- **Infoblox**：企业级IP地址管理
- **Silk**：Cloud Foundry的CNI插件
- **OVN-Kubernetes**：基于OVS和OVN的CNI插件
- **DANM**：Nokia针对Kubernetes上电信工作负载的解决方案

CNI插件为任意网络解决方案提供了标准的网络接口。

### 容器运行时

CNI定义了网络应用容器的插件规范，但该插件必须插入到提供某些服务的容器运行时中。在CNI的上下文中，应用容器是一个网络可寻址实体（有自己的IP地址）。对于Docker，每个容器都有自己的IP地址。对于Kubernetes，每个Pod都有自己的IP地址，Pod被认为是CNI容器，而Pod内的容器对CNI是不可见的。

容器运行时的工作是配置一个网络，然后执行一个或多个CNI插件，以JSON格式将网络配置传递给它。

下图展示了使用CNI插件接口与多个CNI插件通信的容器运行时：

![容器运行时与CNI](ch10-fig04.png)

### CNI插件

CNI插件的工作是将网络接口添加到容器的网络命名空间中，并通过veth对将容器桥接到宿主机。然后，它应通过IPAM（IP地址管理）插件分配IP地址并设置路由。

容器运行时（任何符合CRI的运行时）将CNI插件作为可执行文件调用。插件需要支持以下操作：

- 将容器添加到网络
- 从网络移除容器
- 报告版本

插件使用简单的命令行接口、标准输入/输出和环境变量。JSON格式的网络配置通过标准输入传递给插件。其他参数定义为环境变量：

- `CNI_COMMAND`：指定所需操作，如ADD、DEL或VERSION。
- `CNI_CONTAINERID`：表示容器的ID。
- `CNI_NETNS`：指向网络命名空间文件的路径。
- `CNI_IFNAME`：指定要设置的接口名称。CNI插件应使用此名称，否则返回错误。
- `CNI_ARGS`：包含用户在调用期间传入的附加参数。由分号分隔的字母数字键值对组成，如 `FOO=BAR;ABC=123`。
- `CNI_PATH`：指示搜索CNI插件可执行文件的路径列表。路径由操作系统特定的列表分隔符分隔，如Linux上的":"和Windows上的";"。

如果命令成功，插件返回零退出代码，并且生成的接口（对于ADD命令）作为JSON流式输出到标准输出。这种低技术接口很聪明，因为它不需要任何特定的编程语言、组件技术或二进制API。CNI插件作者也可以使用他们喜欢的编程语言。

使用ADD命令调用CNI插件的结果如下：

```json
{
  "cniVersion": "0.3.0",
  "interfaces": [
    {
      "name": "<name>",
      "mac": "<MAC address>",
      "sandbox": "<netns path or hypervisor identifier>"
    }
  ],
  "ip": [
    {
      "version": "<4-or-6>",
      "address": "<ip-and-prefix-in-CIDR>",
      "gateway": "<ip-address-of-the-gateway>",
      "interface": <numeric index into 'interfaces' list>
    }
  ],
  "routes": [
    {
      "dst": "<ip-and-prefix-in-cidr>",
      "gw": "<ip-of-next-hop>"
    }
  ],
  "dns": {
    "nameservers": <list-of-nameservers>,
    "domain": <name-of-local-domain>,
    "search": <list-of-additional-search-domains>,
    "options": <list-of-options>
  }
}
```

输入的网络配置包含大量信息：`cniVersion`、`name`、`type`、`args`（可选）、`ipMasq`（可选）、`ipam`和`dns`。`ipam`和`dns`参数是带有自己指定键的字典。以下是网络配置的示例：

```json
{
  "cniVersion": "0.3.0",
  "name": "dbnet",
  "type": "bridge",
  "bridge": "cni0",
  "ipam": {
    "type": "host-local",
    "subnet": "10.1.0.0/16",
    "gateway": "10.1.0.1"
  },
  "dns": {
    "nameservers": ["10.1.0.1"]
  }
}
```

注意，可以添加额外的插件特定元素。在这种情况下，`bridge: cni0` 元素是特定桥接插件理解的自定义元素。

CNI规范还支持网络配置列表，其中多个CNI插件可以按顺序被调用。

至此，我们对构建在基本Linux网络之上的Kubernetes网络插件的概念讨论就结束了，它允许多个网络解决方案提供商与Kubernetes平滑集成。

在本章后面，我们将深入探讨一个完整的CNI插件实现。首先，让我们讨论Kubernetes网络世界中最令人兴奋的前景之一——eBPF（扩展的伯克利数据包过滤器）。

## Kubernetes和eBPF

如你所知，Kubernetes是一个非常通用和灵活的平台。Kubernetes开发者明智地避免了许多可能以后将自己困住的假设和决策。例如，Kubernetes网络仅在IP和DNS级别操作。没有网络或子网的概念。这些留给通过非常狭窄和通用的接口（如CNI）与Kubernetes集成的网络解决方案。

这为大量创新打开了大门，因为Kubernetes并没有限制实现者的选择。

eBPF登场。它是一种允许在Linux内核中安全运行沙盒程序的技术，不会损害系统的安全性，也不需要你更改内核本身甚至内核模块。这些程序响应事件而执行。这对于软件定义的网络、可观测性和安全性来说意义重大。Brendan Gregg称其为Linux超能力。

最初的BPF技术只能附加到套接字上进行数据包过滤（因此得名伯克利数据包过滤器）。使用eBPF，你可以附加到其他对象，例如：

- Kprobes
- Tracepoints
- 网络调度器或qdisc用于分类或操作
- XDP

传统的Kubernetes路由由kube-proxy完成。它是一个用户空间进程，运行在每个节点上。它负责设置iptable规则，并执行UDP、TCP和STCP转发以及负载均衡（基于Kubernetes Service）。在大规模场景下，kube-proxy成为一个负担。iptable规则是顺序处理的，频繁的用户空间到内核空间的转换是不必要的开销。完全有可能移除kube-proxy，并用基于eBPF的方法取而代之，该方法以更高的效率执行相同的功能。我们将在下一节讨论其中一个解决方案——Cilium。

以下是eBPF的概述：

![eBPF概述](images/ch10-fig05.png)

更多详情请参见 https://ebpf.io。

## Kubernetes网络解决方案

网络是一个广阔的主题。有多种方式可以设置网络并连接设备、Pod和容器。Kubernetes无法对此做出规定。Pod的扁平地址空间这一高层网络模型就是Kubernetest所规定的全部。在这个空间内，许多有效的解决方案都是可能的，具有适用于不同环境的各种能力和策略。在本节中，我们将考察一些可用的解决方案，并理解它们如何映射到Kubernetes网络模型。

### 在裸机集群上桥接

最基本的环境是只有L2物理网络的原始裸机集群。你可以使用Linux桥接设备将容器连接到物理网络。该过程相当复杂，需要熟悉底层的Linux网络命令，如 `brctl`、`ip addr`、`ip route`、`ip link` 和 `nsenter`。如果你计划实现它，本指南可以作为良好的起点（搜索With Linux Bridge devices部分）：http://blog.oddbit.com/2014/08/11/four-ways-to-connect-a-docker/。

### Calico项目

Calico是一个用于容器的多功能的虚拟网络和网络安全解决方案。Calico可以与所有主要的容器编排框架和运行时集成：

- Kubernetes（CNI插件）
- Mesos（CNI插件）
- Docker（libnetwork插件）
- OpenStack（Neutron插件）

Calico也可以在其完整功能集下部署在本地或公有云上。Calico的网络策略实施可以针对每个工作负载进行专门化，并确保流量得到精确控制，数据包始终从其源头到达经过审查的目的地。Calico可以自动将来自编排平台的网络策略概念映射到其自己的网络策略。Kubernetes网络策略的参考实现是Calico。Calico可以与Flannel一起部署，利用Flannel的网络层和Calico的网络策略设施。

### Weave Net

Weave Net专注于易用性和零配置。它在底层使用VXLAN封装，每个节点上有微DNS。作为开发者，你在更高的抽象级别上操作。你命名你的容器，Weave Net让你连接到它们并使用标准端口提供服务。这有助于将现有应用迁移到容器化应用和微服务。Weave Net有一个用于与Kubernetes（和Mesos）接口的CNI插件。在Kubernetes 1.4及更高版本上，你可以通过运行一个部署DaemonSet的单一命令将Weave Net与Kubernetes集成：

```bash
kubectl apply -f https://github.com/weaveworks/weave/releases/download/v2.8.1/weave-daemonset-k8s.yaml
```

每个节点上的Weave Net Pod将负责将你创建的任何新Pod附加到Weave网络。Weave Net支持网络策略API，同时提供一个完整但易于设置的解决方案。

### Cilium

Cilium是一个CNCF孵化项目，专注于基于eBPF的网络、安全性和可观测性（通过其Hubble项目）。

让我们看看Cilium提供的能力。

### 高效的IP分配和路由

Cilium允许覆盖多个集群并连接所有应用容器的扁平L3网络。主机范围的分配器可以在不与其他主机协调的情况下分配IP地址。Cilium支持多种网络模型：

- **覆盖网络**：此模型利用基于封装的虚拟网络，跨越所有主机。它支持VXLAN和Geneve等封装格式，以及Linux支持的其他格式。只要主机具有IP连接，覆盖模式几乎可以与任何网络基础设施一起工作。它提供了灵活且可扩展的解决方案。
- **本地路由**：在此模型中，Kubernetes利用Linux主机的常规路由表。网络基础设施必须能够路由应用容器使用的IP地址。本地路由模式被认为是更高级的，需要对底层网络基础设施有所了解。它适用于原生IPv6网络、云网络路由器或使用自定义路由守护进程的场景。

### 基于身份的服务间通信

Cilium提供了一项安全管理功能，为具有相同安全策略的应用容器组分配一个安全身份。然后，该身份与这些应用容器生成的所有网络数据包相关联。通过这样做，Cilium使得在接收节点验证身份成为可能。安全身份的管理通过键值存储处理，这允许在Cilium网络解决方案中高效、安全地管理身份。

### 负载均衡

Cilium为应用容器和外部服务之间的流量提供分布式负载均衡，作为kube-proxy的替代方案。此负载均衡功能使用eBPF中的高效哈希表实现，与传统iptables方法相比提供了可扩展的方法。使用Cilium，你可以实现高性能负载均衡，同时确保网络资源的高效利用。

对于东西向负载均衡，Cilium擅长直接在Linux内核的套接字层内执行高效的服务到后端转换。这种方法消除了每数据包NAT操作的需要，从而降低了开销并提高了性能。

对于南北向负载均衡，Cilium的eBPF实现高度优化以实现最大性能。它可以与XDP（快速数据路径）无缝集成，并支持先进的负载均衡技术，如DSR（直接服务器返回）和Maglev一致性哈希。这使得负载均衡操作可以从源主机高效卸载，进一步提高性能和可扩展性。

### 带宽管理

Cilium通过基于EDT（最早出发时间）的高效速率限制来管理带宽，使用eBPF处理出口流量。这显著降低了应用程序的传输尾部延迟。

### 可观测性

Cilium提供带有丰富元数据的全面事件监控。除了捕获丢弃数据包的源和目标IP地址外，它还提供发送方和接收方的详细标签信息。这些元数据增强了可见性和故障排除能力。此外，Cilium通过Prometheus导出指标，便于监控和分析网络性能。

为了进一步增强可观测性，Hubble可观测性平台提供了额外功能，如服务依赖关系图、运行监控、告警以及应用和安全方面的全面可见性。通过利用流日志，Hubble使管理员能够深入了解网络中服务的行为和交互。

Cilium是一个范围非常广泛的大型项目。在这里我们只是浅尝辄止。更多详情请参见 https://cilium.io。

有许多优秀的网络解决方案。哪个网络解决方案最适合你？如果你在云中运行，我建议使用云提供商的原生CNI插件。如果你自己运行，Calico是一个可靠的选择，如果你喜欢冒险并需要重度优化网络，可以考虑Cilium。

在下一节中，我们将介绍网络策略，它让你能够控制集群中的流量。

## 有效使用网络策略

Kubernetes网络策略是关于管理选定Pod和命名空间的网络流量。在数百个微服务被部署和编排的世界中（这在Kubernetes中经常发生），管理Pod之间的网络和连接性至关重要。理解它主要不是一个安全机制是很重要的。如果攻击者能够到达内部网络，他们可能能够创建符合现有网络策略的Pod，并与其他Pod自由通信。在上一节中，我们考察了不同的Kubernetes网络解决方案，并重点关注了容器网络接口。在本节中，重点是网络策略，尽管网络解决方案与如何在其上实现网络策略之间存在紧密联系。

### 理解Kubernetes网络策略设计

网络策略定义了Pod和Kubernetes集群内其他网络端点之间的通信规则。它使用标签选择特定的Pod，并应用白名单规则来控制对所选Pod的流量访问。这些规则通过允许基于定义标准的额外流量，补充了在命名空间级别定义的隔离策略。通过配置网络策略，管理员可以微调和限制Pod之间的通信，增强集群内的安全性和网络分段。

### 网络策略和CNI插件

网络策略和CNI插件之间存在错综复杂的关系。一些CNI插件同时实现了网络连接和网络策略，而另一些只实现其中一个方面，但它们可以与实现另一个方面的CNI插件协作（例如，Calico和Flannel）。

### 配置网络策略

网络策略通过 `NetworkPolicy` 资源配置。你可以定义入站和/或出站策略。以下是指定了入站和出站的示例网络策略：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: test-network-policy
  namespace: awesome-project
spec:
  podSelector:
    matchLabels:
      role: db
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          project: awesome-project
      podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 6379
  egress:
  - to:
    - ipBlock:
        cidr: 10.0.0.0/24
    ports:
    - protocol: TCP
      port: 7777
```

### 实现网络策略

虽然网络策略API本身是通用的，是Kubernetes API的一部分，但其实现与网络解决方案紧密耦合。这意味着在每个节点上，有一个特殊的代理或守门人（Cilium通过内核中的eBPF实现它），它执行以下操作：

- 拦截所有进入节点的流量
- 验证流量是否符合网络策略
- 转发或拒绝每个请求

Kubernetes通过API提供定义和存储网络策略的设施。实施网络策略则留给网络解决方案或与特定网络解决方案紧密集成的专用网络策略解决方案。

Calico是这种方法的一个很好的例子。Calico有自己的网络解决方案和网络策略解决方案，它们协同工作。在这两种情况下，两个部分之间都有紧密的集成。下图展示了Kubernetes策略控制器如何管理网络策略，以及节点上的代理如何执行它们：

![Kubernetes网络策略管理](ch10-fig06.png)

在本节中，我们涵盖了各种网络解决方案以及网络策略，并简要讨论了负载均衡。然而，负载均衡是一个广泛的主题，下一节将对其进行探讨。

## 负载均衡选项

负载均衡是像Kubernetes集群这样的动态系统中的关键能力。节点、VM和Pod来来去去，但客户端通常无法跟踪哪些实体可以服务它们的请求。即使他们可以，也需要复杂的管理操作：管理集群的动态映射、频繁刷新，以及处理断开连接、无响应或缓慢的节点。所谓客户端负载均衡仅适用于特殊场景。服务端负载均衡是一种经过实战检验且易于理解的机制，它增加了一个间接层，将内部的动荡隐藏在外部的客户端或消费者面前。有外部和内部负载均衡器的选项。你也可以混合搭配，同时使用两者。混合方法有其自身的特定优缺点，例如性能与灵活性。我们将涵盖以下选项：

- 外部负载均衡器
- Service负载均衡器
- Ingress
- HAProxy
- MetalLB
- Traefik
- Kubernetes Gateway API

### 外部负载均衡器

外部负载均衡器是运行在Kubernetes集群之外的负载均衡器。必须有一个Kubernetes可以与之交互的外部负载均衡器提供商，用于配置健康检查和防火墙规则，并获取负载均衡器的外部IP地址。

下图展示了负载均衡器（在云中）、Kubernetes API Server和集群节点之间的连接。外部负载均衡器拥有哪些Pod运行在哪些节点上的最新视图，可以将外部服务流量定向到正确的Pod：

![负载均衡器、Kubernetes API Server和集群节点之间的连接](ch10-fig07.png)

### 配置外部负载均衡器

外部负载均衡器通过Service配置文件或直接通过kubectl进行配置。我们使用 `LoadBalancer` 类型的Service，而不是使用 `ClusterIP` 类型的Service，后者直接暴露Kubernetes节点作为负载均衡器。这取决于集群中正确安装和配置的外部负载均衡器提供商。

### 通过清单文件

以下是实现此目标的Service清单文件示例：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 5000
  selector:
    svc: api-gateway
    app: delinkcious
```

### 通过kubectl

你也可以使用直接的kubectl命令实现相同的结果：

```bash
$ kubectl expose deployment api-gateway --port=80 --target-port=5000 --name=api-gateway --type=LoadBalancer
```

是使用Service配置文件还是kubectl命令，通常由你设置其余基础设施和部署系统的方式决定。清单文件更具声明性，更适合生产使用，因为你希望有一种版本化、可审计和可重复的方式来管理基础设施。通常，这将成为基于GitOps的CI/CD流水线的一部分。

### 查找负载均衡器IP地址

负载均衡器将有两个感兴趣的IP地址。内部IP地址可以在集群内部用于访问Service。集群外部的客户端将使用外部IP地址。为外部IP地址创建DNS条目是一种良好的实践。如果你想要使用需要稳定主机名的TLS/SSL，这一点尤其重要。要获取这两个地址，请使用 `kubectl describe service` 命令。`IP` 字段表示内部IP地址，`LoadBalancer Ingress` 字段表示外部IP地址：

```bash
$ kubectl describe services example-service
Name:                   example-service
Selector:               app=example
Type:                   LoadBalancer
IP:                     10.67.252.103
LoadBalancer Ingress:   123.45.678.9
Port:                   <unnamed>  80/TCP
NodePort:               <unnamed>  32445/TCP
Endpoints:              10.64.0.4:80,10.64.1.5:80,10.64.2.4:80
Session Affinity:       None
No events.
```

### 保留客户端IP地址

有时，Service可能对客户端的源IP地址感兴趣。在Kubernetes 1.5之前，此信息不可用。在Kubernetes 1.7中，保留了保留原始客户端IP的能力被添加到API中。

### 指定保留原始客户端IP地址

你需要配置Service规约的两个字段：

- `service.spec.externalTrafficPolicy`：此字段确定Service是否应将外部流量路由到节点本地端点还是集群范围的端点（默认值）。`Cluster` 选项不会暴露客户端源IP，并可能增加到另一个节点的跳转，但负载分布良好。`Local` 选项保留客户端源IP，并且只要Service类型是 `LoadBalancer` 或 `NodePort`，就不会增加额外跳转。其缺点是可能无法很好地平衡负载。

- `service.spec.healthCheckNodePort`：此字段是可选的。如果使用，则Service健康检查将使用此端口号。默认值是分配的节点端口。它对 `externalTrafficPolicy` 设置为 `Local` 的 `LoadBalancer` 类型Service有效。

以下是一个示例：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  ports:
  - port: 80
    targetPort: 5000
  selector:
    svc: api-gateway
    app: delinkcious
```

### 理解均衡外部负载均衡

外部负载均衡器在节点级别操作；虽然它们将流量定向到特定的Pod，但负载分配是在节点级别完成的。这意味着如果你的服务有四个Pod，其中三个在节点A上，最后一个在节点B上，那么外部负载均衡器可能会在节点A和节点B之间平均分配负载。

这将使节点A上的3个Pod处理一半的负载（每个1/6），而节点B上的单个Pod独立处理另一半负载。未来可能会添加权重来解决此问题。你可以通过使用Pod反亲和性或拓扑扩展约束来避免太多Pod在节点之间不均匀分布的问题。

### Service负载均衡器

Service负载均衡旨在汇聚Kubernetes集群内的内部流量，而不是用于外部负载均衡。这是通过使用 `ClusterIP` 类型的Service来完成的。可以通过使用 `NodePort` 类型的Service并直接通过预分配的端口暴露Service负载均衡器将其用作外部负载均衡器，但这需要整理整个集群中的所有Node端口以避免冲突，并且可能不适合生产环境。诸如SSL终止和HTTP缓存等理想功能将无法直接使用。

下图展示了Service负载均衡器（黄色云朵）如何将流量路由到其后端Pod之一（当然是通过标签）：

![Service负载均衡器将流量路由到后端Pod](ch10-fig08.png)

### Ingress

Kubernetes中的Ingress，其核心是一组允许入站HTTP/S流量到达集群Service的规则。此外，一些Ingress控制器支持以下功能：

- 连接算法
- 请求限制
- URL重写和重定向
- TCP/UDP负载均衡
- SSL终止
- 访问控制和授权

Ingress使用 `Ingress` 资源指定，并由Ingress控制器提供服务。Ingress资源自Kubernetes 1.1以来一直是beta版，最终在Kubernetes 1.19中成为GA版本。以下是一个管理流量进入两个Service的Ingress资源示例。规则将外部可见的 `http://foo.bar.com/foo` 映射到 `s1` 服务，将 `http://foo.bar.com/bar` 映射到 `s2` 服务：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: test
spec:
  ingressClassName: cool-ingress
  rules:
  - host: foo.bar.com
    http:
      paths:
      - path: /foo
        backend:
          service:
            name: s1
            port: 80
      - path: /bar
        backend:
          service:
            name: s2
            port: 80
```

`ingressClassName` 指定一个 `IngressClass` 资源，其中包含关于Ingress的额外信息。如果省略，则必须定义一个默认的Ingress类。

以下是它的样子：

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  labels:
    app.kubernetes.io/component: controller
  name: cool-ingress
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
spec:
  controller: k8s.io/ingress-nginx
```

Ingress控制器通常需要向Ingress资源添加注解，以定制其行为。

下图展示了Ingress的工作原理：

![Ingress演示](images/ch10-fig09.png)

目前Kubernetes主仓库中有两个官方Ingress控制器。其中一个是仅用于GCE的L7 Ingress控制器，另一个是更通用的Nginx Ingress控制器，它允许你通过ConfigMap配置Nginx Web服务器。Nginx Ingress控制器非常复杂，带来了许多尚不能通过Ingress资源直接使用的功能。它使用Endpoint API直接将流量转发到Pod。它支持Minikube、GCE、AWS、Azure和裸机集群。更多详情请参见 https://github.com/kubernetes/ingress-nginx。

然而，还有更多可能更适合你用例的Ingress控制器，例如：

- Ambassador
- Traefik
- Contour
- Gloo

更多Ingress控制器请参见 https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/。

### HAProxy

我们讨论了使用 `LoadBalancer` 类型的Service使用云提供商外部负载均衡器，以及使用 `ClusterIP` 在集群内部使用内部Service负载均衡器。如果我们想要一个自定义外部负载均衡器，我们可以创建一个自定义的外部负载均衡器提供商并使用 `LoadBalancer`，或使用第三种Service类型 `NodePort`。HAProxy是一个成熟且经过实战检验的负载均衡解决方案。它被认为是实现本地集群外部负载均衡的最佳选择之一。这可以通过几种方式完成：

- 利用NodePort并仔细管理端口分配
- 实现自定义负载均衡器提供商接口
- 在集群内部运行HAProxy，作为集群边缘前端服务器的唯一目标（负载均衡或不均衡）

你可以用HAProxy使用所有这些方法。尽管如此，仍然建议使用Ingress对象。`service-loadbalancer` 项目是一个社区项目，它在HAProxy之上实现了负载均衡解决方案。你可以在这里找到它：https://github.com/kubernetes/contrib/tree/master/service-loadbalancer。让我们更详细地看看如何使用HAProxy。

### 利用NodePort

每个Service将从预定义的范围内分配一个专用端口。这通常是一个高范围，如30,000及以上，以避免与使用非知名端口的其他应用程序冲突。在这种情况下，HAProxy将运行在集群外部，并为每个Service配置正确的端口。然后，它可以将任何流量转发到任何节点，Kubernetes通过内部Service（双重负载均衡）将其路由到合适的Pod。这当然不是最优的，因为它引入了另一次跳转。绕过它的方法是查询Endpoint API，并动态管理每个Service的后端Pod列表，并直接将流量转发到Pod。

### 使用HAProxy的自定义负载均衡器提供商

这种方法稍微复杂一些，但好处是它与Kubernetes更好地集成，可以使本地和云之间的过渡更容易。

### 在Kubernetes集群内运行HAProxy

在这种方法中，我们在集群内部使用内部HAProxy负载均衡器。可能有多个运行HAProxy的节点，它们共享相同的配置来映射传入请求并在后端服务器之间进行负载均衡：

![运行HAProxy的多个节点](ch10-fig10.png)

HAProxy还开发了自己的Kubernetes感知的Ingress控制器。这可以说是在你的Kubernetes集群中使用HAProxy的最简化方式。使用HAProxy Ingress控制器时，你获得的一些能力包括：

- 与HAProxy负载均衡器的简化集成
- SSL终止
- 速率限制
- IP白名单
- 多种负载均衡算法：轮询、最少连接、URL哈希和随机
- 展示Pod健康状况、当前请求速率、响应时间等的仪表板
- 流量过载保护

### MetalLB

MetalLB也为裸机集群提供负载均衡器解决方案。它具有高度可配置性，支持多种模式，如L2和BGP。我甚至成功地为minikube配置了它。更多详情请参见 https://metallb.universe.tf。

### Traefik

Traefik是一个现代的HTTP反向代理和负载均衡器。它被设计为支持微服务。它与包括Kubernetes在内的许多后端一起工作，自动动态管理其配置。与传统负载均衡器相比，这是一个游戏规则改变者。它拥有令人印象深刻的功能列表：

- 快速
- 单个Go可执行文件
- 极小的官方Docker镜像
- REST API
- 配置热重载
- 熔断器和重试
- 轮询和再平衡负载均衡器
- 指标支持：REST、Prometheus、Datadog、statsd和InfluxDB
- 简洁的AngularJS Web UI
- 支持Websocket、HTTP/2和GRPC
- 访问日志（JSON和CLF格式）
- Let's Encrypt支持
- 集群模式高可用

总体而言，该解决方案提供了一套全面的功能，以可扩展和可靠的方式部署和管理应用程序。

参见 https://traefik.io/traefik/ 了解更多关于Traefik的信息。

### Kubernetes Gateway API

Kubernetes Gateway API是一组对Kubernetes中的服务网络进行建模的资源。你可以将其视为Ingress API的演进。虽然没有意图移除Ingress API，但其局限性无法通过改进来解决，因此Gateway API项目诞生了。

Ingress API由单一的 `Ingress` 资源和可选的 `IngressClass` 组成，而Gateway API更加细粒度，将流量管理和路由的定义分解为不同的资源。Gateway API定义了以下资源：

- GatewayClass
- Gateway
- HTTPRoute
- TLSRoute
- TCPRoute
- UDPRoute

### Gateway API资源

`GatewayClass` 的角色是定义可以被多个类似网关使用的通用配置和行为。

`Gateway` 的角色是定义一个端点和一组路由，流量可以通过这些路由进入集群并被路由到后端服务。最终，网关配置了底层的负载均衡器或代理。

路由的角色是将匹配路由的特定请求映射到特定的后端服务。

下图展示了Gateway API的资源和组织：

![Gateway API资源](ch10-fig11.png)

### 将路由附加到网关

网关和路由可以通过不同的方式关联：

- **一对一**：一个网关可能有来自单个所有者的单个路由，该路由不与任何其他网关关联
- **一对多**：一个网关可能有来自多个所有者的多个路由与之关联
- **多对多**：一个路由可能与多个网关关联（每个网关可能还有额外的路由）

### Gateway API实战

让我们通过一个简单的示例了解Gateway API的所有部分如何协同工作。以下是一个Gateway资源：

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: Gateway
metadata:
  name: cool-gateway
  namespace: ns1
spec:
  gatewayClassName: cool-gateway-class
  listeners:
  - name: cool-service
    port: 80
    protocol: HTTP
    allowedRoutes:
      kinds:
      - kind: HTTPRoute
      namespaces:
        from: Selector
        selector:
          matchLabels:
            kubernetes.io/metadata.name: ns2
```

注意，网关定义在命名空间 `ns1` 中，但它只允许在命名空间 `ns2` 中定义的HTTP路由。让我们看一个附加到此网关的路由：

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: HTTPRoute
metadata:
  name: cool-route
  namespace: ns2
spec:
  parentRefs:
  - kind: Gateway
    name: cool-gateway
    namespace: ns1
  rules:
  - backendRefs:
    - name: cool-service
      port: 8080
```

路由 `cool-route` 正确地定义在命名空间 `ns2` 中；它是一条HTTP路由，所以匹配。为了闭环，路由定义了到命名空间 `ns1` 中的 `cool-gateway` 网关的父引用。

参见 https://gateway-api.sigs.k8s.io 了解更多关于Gateway API的信息。

Kubernetes上的负载均衡是一个令人兴奋的领域。它为南北向和东西向负载均衡提供了许多选项。既然我们已经详细介绍了负载均衡，让我们深入探讨CNI插件及其实现方式。

## 编写你自己的CNI插件

在本节中，我们将看看实际编写自己的CNI插件需要什么。首先，我们将考察最简单的插件——loopback插件。然后，我们将研究实现了与编写CNI插件相关的大部分样板代码的插件骨架。最后，我们将审视桥接插件的实现。在深入之前，这里快速提醒一下CNI插件是什么：

- CNI插件是一个可执行文件
- 它负责将新容器连接到网络，为CNI容器分配唯一的IP地址，并处理路由
- 容器是一个网络命名空间（在Kubernetes中，Pod是CNI容器）
- 网络定义以JSON文件形式管理，但通过标准输入流式传输到插件（插件不读取任何文件）
- 辅助信息可以通过环境变量提供

### 初探loopback插件

loopback插件仅添加回环接口。它非常简单，不需要任何网络配置信息。大多数CNI插件用Golang实现，loopback CNI插件也不例外。完整源码可在此处获取：https://github.com/containernetworking/plugins/blob/master/plugins/main/loopback。

GitHub上的容器网络项目提供了多个包，它们提供了实现CNI插件所需的许多构建块，以及用于添加接口、删除接口、设置IP地址和设置路由的 `netlink` 包。首先让我们看看 `loopback.go` 文件的导入：

```go
package main
import (
    "encoding/json"
    "errors"
    "fmt"
    "net"
    "github.com/vishvananda/netlink"
    "github.com/containernetworking/cni/pkg/skel"
    "github.com/containernetworking/cni/pkg/types"
    current "github.com/containernetworking/cni/pkg/types/100"
    "github.com/containernetworking/cni/pkg/version"
    "github.com/containernetworking/plugins/pkg/ns"
    bv "github.com/containernetworking/plugins/pkg/utils/buildversion"
)
```

然后，插件实现两个命令，`cmdAdd` 和 `cmdDel`，分别在容器被添加到网络或从网络移除时调用。以下是 `add` 命令，它完成了所有繁重的工作：

```go
func cmdAdd(args *skel.CmdArgs) error {
    conf, err := parseNetConf(args.StdinData)
    if err != nil {
        return err
    }
    var v4Addr, v6Addr *net.IPNet
    args.IfName = "lo"
    err = ns.WithNetNSPath(args.Netns, func(_ ns.NetNS) error {
        link, err := netlink.LinkByName(args.IfName)
        if err != nil {
            return err
        }
        err = netlink.LinkSetUp(link)
        if err != nil {
            return err
        }
        v4Addrs, err := netlink.AddrList(link, netlink.FAMILY_V4)
        if err != nil {
            return err
        }
        if len(v4Addrs) != 0 {
            v4Addr = v4Addrs[0].IPNet
            for _, addr := range v4Addrs {
                if !addr.IP.IsLoopback() {
                    return fmt.Errorf("loopback interface found with non-loopback address %q", addr.IP)
                }
            }
        }
        v6Addrs, err := netlink.AddrList(link, netlink.FAMILY_V6)
        // ... similar IPv6 handling ...
        return nil
    })
    // ... result construction and return ...
}
```

此功能的核心是将接口名称设置为 `lo`（用于回环），并将链接添加到容器的网络命名空间中。它支持IPv4和IPv6。

`del` 命令做相反的事情，而且简单得多：

```go
func cmdDel(args *skel.CmdArgs) error {
    if args.Netns == "" {
        return nil
    }
    args.IfName = "lo"
    err := ns.WithNetNSPath(args.Netns, func(ns.NetNS) error {
        link, err := netlink.LinkByName(args.IfName)
        if err != nil {
            return err
        }
        err = netlink.LinkSetDown(link)
        if err != nil {
            return err
        }
        return nil
    })
    // ... error handling ...
    return nil
}
```

`main` 函数简单地调用 `skel` 包的 `PluginMain()` 函数，传入命令函数。`skel` 包将负责运行CNI插件可执行文件，并在适当的时候调用 `cmdAdd` 和 `cmdDel` 函数：

```go
func main() {
    skel.PluginMain(cmdAdd, cmdCheck, cmdDel, version.All, bv.BuildString("loopback"))
}
```

### 构建在CNI插件骨架之上

让我们探索 `skel` 包，看看它在底层做了什么。`PluginMain()` 入口点负责调用 `PluginMainWithError()`，捕获错误，将其打印到标准输出并退出：

```go
func PluginMain(cmdAdd, cmdCheck, cmdDel func(_ *CmdArgs) error, versionInfo version.PluginInfo, about string) {
    if e := PluginMainWithError(cmdAdd, cmdCheck, cmdDel, versionInfo, about); e != nil {
        if err := e.Print(); err != nil {
            log.Print("Error writing error JSON to stdout: ", err)
        }
        os.Exit(1)
    }
}
```

`PluginMainWithError()` 函数实例化一个调度器，设置其所有I/O流和环境，并调用其内部的 `pluginMain()` 方法：

```go
func PluginMainWithError(cmdAdd, cmdCheck, cmdDel func(_ *CmdArgs) error, versionInfo version.PluginInfo, about string) *types.Error {
    return (&dispatcher{
        Getenv: os.Getenv,
        Stdin:  os.Stdin,
        Stdout: os.Stdout,
        Stderr: os.Stderr,
    }).pluginMain(cmdAdd, cmdCheck, cmdDel, versionInfo, about)
}
```

这里是骨架的主要逻辑。它从环境（包括来自标准输入的配置）获取cmd参数，检测调用了哪个cmd，并调用相应的插件函数（`cmdAdd` 或 `cmdDel`）。它也可以返回版本信息：

```go
func (t *dispatcher) pluginMain(cmdAdd, cmdCheck, cmdDel func(_ *CmdArgs) error, versionInfo version.PluginInfo, about string) *types.Error {
    cmd, cmdArgs, err := t.getCmdArgsFromEnv()
    if err != nil { ... }
    switch cmd {
    case "ADD":
        err = t.checkVersionAndCall(cmdArgs, versionInfo, cmdAdd)
    case "CHECK":
        // version checking...
    case "DEL":
        err = t.checkVersionAndCall(cmdArgs, versionInfo, cmdDel)
    case "VERSION":
        if err := versionInfo.Encode(t.Stdout); err != nil { ... }
    default:
        return types.NewError(...)
    }
    return err
}
```

loopback插件是最简单的CNI插件之一。让我们来看看桥接插件。

### 审视桥接插件

桥接插件更为实质。让我们看看其实现的一些关键部分。完整源码可在此处获取：https://github.com/containernetworking/plugins/tree/main/plugins/main/bridge。

该插件在 `bridge.go` 文件中定义了一个网络配置结构体，包含以下字段：

```go
type NetConf struct {
    types.NetConf
    BrName       string `json:"bridge"`
    IsGW         bool   `json:"isGateway"`
    IsDefaultGW  bool   `json:"isDefaultGateway"`
    ForceAddress bool   `json:"forceAddress"`
    IPMasq       bool   `json:"ipMasq"`
    MTU          int    `json:"mtu"`
    HairpinMode  bool   `json:"hairpinMode"`
    PromiscMode  bool   `json:"promiscMode"`
    Vlan         int    `json:"vlan"`
    MacSpoofChk  bool   `json:"macspoofchk,omitempty"`
    EnableDad    bool   `json:"enabledad,omitempty"`
    Args         struct { Cni BridgeArgs `json:"cni,omitempty"` } `json:"args,omitempty"`
    RuntimeConfig struct { Mac string `json:"mac,omitempty"` } `json:"runtimeConfig,omitempty"`
    mac string
}
```

由于篇幅限制，我们不会介绍每个参数的作用以及它如何与其他参数交互。目标是理解流程，并在你想实现自己的CNI插件时有一个起点。配置通过 `loadNetConf()` 函数从JSON加载。它在 `cmdAdd()` 和 `cmdDel()` 函数的开头被调用：

```go
n, cniVersion, err := loadNetConf(args.StdinData, args.Args)
```

以下是 `cmdAdd()` 的核心，它使用网络配置中的信息，设置桥接，并设置veth：

```go
br, brInterface, err := setupBridge(n)
if err != nil { return err }
netns, err := ns.GetNS(args.Netns)
if err != nil { return fmt.Errorf("failed to open netns %q: %v", args.Netns, err) }
defer netns.Close()
hostInterface, containerInterface, err := setupVeth(netns, br, args.IfName, n.MTU, n.HairpinMode, n.Vlan)
if err != nil { return err }
```

之后，函数处理L3模式及其多种情况：

```go
// 假设仅L2接口
result := &current.Result{
    CNIVersion: current.ImplementedSpecVersion,
    Interfaces: []*current.Interface{ brInterface, hostInterface, containerInterface },
}
if n.MacSpoofChk { ... }
if isLayer3 {
    // 运行IPAM插件并获取要应用的配置
    r, err := ipam.ExecAdd(n.IPAM.Type, args.StdinData)
    if err != nil { return err }
    // 将IPAM结果转换为当前Result类型
    ipamResult, err := current.NewResultFromResult(r)
    if err != nil { return err }
    result.IPs = ipamResult.IPs
    result.Routes = ipamResult.Routes
    result.DNS = ipamResult.DNS
    // 配置容器硬件地址和IP地址
    if err := netns.Do(func(_ ns.NetNS) error { ... }); err != nil { ... }
    // 检查桥接端口状态
    retries := []int{0, 50, 500, 1000, 1000}
    for idx, sleep := range retries { ... }
    if n.IsGW { ... }
    if n.IPMasq { ... }
}
```

最后，它更新可能已更改的MAC地址并返回结果：

```go
// 重新获取桥接，因为其MAC地址可能在添加第一个veth或设置其IP地址后发生变化
br, err = bridgeByName(n.BrName)
if err != nil { return err }
brInterface.Mac = br.Attrs().HardwareAddr.String()
success = true
return types.PrintResult(result, cniVersion)
```

这只是完整实现的一部分。还有路由设置和硬件IP分配。如果你计划编写自己的CNI插件，我鼓励你查阅完整的源代码，它相当广泛，以获得完整的画面：https://github.com/containernetworking/plugins/tree/main/plugins/main/bridge。

## 总结

在本章中，我们涵盖了很多内容。网络是一个如此广阔的主题，因为硬件、软件、操作环境和用户技能的组合如此之多。提出一个既健壮、安全、性能良好又易于维护的全面网络解决方案是一项非常复杂的任务。对于Kubernetes集群，云提供商大多解决了这些问题。但如果你运行本地集群或需要定制解决方案，你有很多选择。Kubernetes是一个非常灵活的平台，专为扩展而设计。特别是网络具有高度可插拔性。

我们讨论的主要主题包括Kubernetes网络模型（Pod可以相互通信的扁平地址空间）、查找和发现的工作原理、Kubernetes网络插件、不同抽象级别的各种网络解决方案（许多有趣的变体）、有效使用网络策略控制集群内部流量、Ingress和Gateway API、负载均衡解决方案的范围，最后，我们通过剖析一个真实的实现来了解如何编写CNI插件。

至此，你可能已经感到有些应接不暇了，尤其是如果你不是这个领域的专家。然而，你应该对Kubernetes网络的内部机制有了扎实的理解，意识到实现一个完整解决方案所需的所有相互关联的部分，并能够基于对你的系统和技能水平有意义的权衡来打造自己的解决方案。

在第11章"在多集群上运行Kubernetes"中，我们将更进一步，考察在多个集群上运行Kubernetes的话题。
