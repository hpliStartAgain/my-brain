---
title: "05 Service 与 kube-proxy 原理"
date: 2026-03-04
tags: [云原生, Kubernetes, Service, kube-proxy, iptables, IPVS, ClusterIP, NodePort, LoadBalancer, EndpointSlice]
aliases: []
---

# 05 Service 与 kube-proxy 原理

**摘要：**

Pod 的 IP 地址是短暂的——Pod 重建后 IP 会变化，Deployment 的滚动更新会不断创建和删除 Pod。如果客户端直接连接 Pod IP，每次 Pod 变更都需要更新客户端配置——这在动态的容器环境中不可行。**Service** 是 K8s 对这个问题的解答——它为一组 Pod 提供一个稳定的虚拟 IP 地址（ClusterIP）和 DNS 名称，客户端只需连接 Service，流量自动被负载均衡到后端的健康 Pod。Service 本身只是一个 API 对象——真正实现流量转发的是每个节点上的 **kube-proxy**，它通过 iptables 或 IPVS 规则将发往 ClusterIP 的流量 DNAT 到后端 Pod IP。本文从 Service 的四种类型出发，深入分析 Endpoints / EndpointSlice 的工作机制、kube-proxy 的三种模式（iptables / IPVS / nftables）的实现差异和性能特征，以及 Headless Service 和 ExternalName 的特殊语义。

---

## 第 1 章 Service 解决的问题

### 1.1 Pod IP 的不稳定性

K8s 中 Pod 的 IP 地址是**临时分配**的——来自节点的 Pod CIDR 范围。Pod 被删除并重建后（无论是滚动更新、节点故障重调度、还是手动重建），新 Pod 获得一个全新的 IP 地址。

如果 Web 前端直接连接后端 API 的 Pod IP `10.244.1.5:8080`：
- 后端 Pod 滚动更新 → IP 变为 `10.244.2.8:8080` → 前端连接失败
- 后端 Pod 所在节点故障 → Pod 在其他节点重建 → IP 变化 → 前端连接失败

### 1.2 Service 的抽象

Service 在 Pod 之上创建了一层**稳定的抽象**：

```
客户端 → Service (ClusterIP: 10.96.0.100) → Pod-1 (10.244.1.5)
                                            → Pod-2 (10.244.2.8)
                                            → Pod-3 (10.244.3.3)
```

- **稳定的 IP**：ClusterIP 在 Service 的整个生命周期内不变（除非 Service 被删除重建）
- **稳定的 DNS**：`<service-name>.<namespace>.svc.cluster.local` 解析到 ClusterIP
- **自动负载均衡**：流量被均匀分配到后端的所有健康 Pod
- **自动服务发现**：后端 Pod 的增减自动反映到 Service 的后端列表中

### 1.3 Service 通过 Label Selector 关联 Pod

Service 通过 [[04 Label Selector 与松耦合设计|Label Selector]] 选择后端 Pod——与 Pod 之间没有直接的引用关系，完全松耦合。

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-api
spec:
  selector:
    app: web-api        # 选择所有带 app=web-api Label 的 Pod
  ports:
    - port: 80           # Service 端口
      targetPort: 8080   # Pod 端口
```

任何带有 `app: web-api` Label 且 Ready=True 的 Pod 都会被自动加入 Service 的后端列表。Pod 新增、删除或状态变化时，后端列表自动更新。

---

## 第 2 章 Service 的四种类型

### 2.1 ClusterIP（默认）

**ClusterIP** 为 Service 分配一个**集群内部**的虚拟 IP——只能从集群内部访问（Pod 和节点）。

```yaml
spec:
  type: ClusterIP        # 默认类型
  clusterIP: 10.96.0.100  # 自动分配或手动指定
  ports:
    - port: 80
      targetPort: 8080
```

ClusterIP 是一个"虚拟"IP——它不绑定到任何网络接口，不存在于任何设备上。它只存在于 kube-proxy 维护的 iptables/IPVS 规则中——当数据包的目标地址匹配 ClusterIP 时，规则将其 DNAT 到某个后端 Pod IP。

### 2.2 NodePort

**NodePort** 在 ClusterIP 的基础上，在**每个节点**的特定端口上暴露 Service——允许集群外部通过 `<NodeIP>:<NodePort>` 访问。

```yaml
spec:
  type: NodePort
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080      # 节点端口（30000-32767）
```

访问路径：`外部客户端 → NodeIP:30080 → ClusterIP:80 → PodIP:8080`

kube-proxy 在每个节点上监听 NodePort，将到达的流量转发到 Service 的后端 Pod——即使请求到达的节点上没有后端 Pod，也会被转发到其他节点上的 Pod。

> [!info] NodePort 的跨节点转发
> 如果客户端连接了 Node-A:30080，但后端 Pod 只在 Node-B 上，流量会从 Node-A DNAT 到 Node-B 的 Pod——**跨了一次节点网络**。这增加了一跳延迟。`externalTrafficPolicy: Local` 可以避免这个问题——只将流量转发到本节点上的 Pod（如果本节点没有 Pod，返回错误）。

### 2.3 LoadBalancer

**LoadBalancer** 在 NodePort 的基础上，调用云平台的 API 创建一个**外部负载均衡器**（如 AWS ELB、GCP LB、Azure LB），将外部流量导入到 NodePort。

```yaml
spec:
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 8080
```

创建后，云平台分配一个外部 IP：

```bash
kubectl get svc web-api
# NAME      TYPE           CLUSTER-IP     EXTERNAL-IP    PORT(S)
# web-api   LoadBalancer   10.96.0.100    203.0.113.50   80:30080/TCP
```

访问路径：`外部客户端 → 外部LB:80 → NodeIP:30080 → PodIP:8080`

LoadBalancer 是在云环境中暴露服务的标准方式——但每个 Service 创建一个 LB 实例可能很昂贵（云 LB 按实例计费）。对于需要暴露多个 HTTP 服务的场景，通常使用一个 LoadBalancer + [[06 DNS 服务发现与 Ingress|Ingress Controller]] 替代多个 LoadBalancer。

### 2.4 ExternalName

**ExternalName** 不做任何代理转发——它只是创建一个 **CNAME DNS 记录**，将 Service 名称解析到指定的外部域名。

```yaml
spec:
  type: ExternalName
  externalName: db.example.com    # 外部服务的域名
```

```
nslookup web-api.default.svc.cluster.local
→ CNAME db.example.com
→ A 203.0.113.100
```

**使用场景**：让集群内的 Pod 通过 K8s Service 名称访问集群外部的服务——如果外部服务的地址变化，只需修改 Service 的 externalName，不需要修改所有客户端的配置。

### 2.5 四种类型的对比

| 类型 | ClusterIP | 外部访问 | 负载均衡器 | 典型场景 |
| :--- | :--- | :--- | :--- | :--- |
| **ClusterIP** | ✅ 自动分配 | ❌ | ❌ | 集群内部服务间通信 |
| **NodePort** | ✅ 自动分配 | ✅ NodeIP:Port | ❌ | 开发测试、非云环境 |
| **LoadBalancer** | ✅ 自动分配 | ✅ 外部 IP | ✅ 云 LB | 云环境暴露服务 |
| **ExternalName** | ❌ 无 | ❌ | ❌ | 映射外部服务 |

---

## 第 3 章 Endpoints 与 EndpointSlice

### 3.1 Endpoints 对象

每个 Service 对应一个同名的 **Endpoints 对象**——记录了 Service 后端所有 Ready Pod 的 IP 和端口列表。

```bash
kubectl get endpoints web-api
# NAME      ENDPOINTS
# web-api   10.244.1.5:8080,10.244.2.8:8080,10.244.3.3:8080
```

**Endpoint Controller** 负责维护 Endpoints：
1. Watch Service 和 Pod 的变更
2. 根据 Service 的 Label Selector 筛选匹配的 Pod
3. 只选择 Ready=True 的 Pod（[[03 健康检查与就绪探针|Readiness Probe]] 通过）
4. 将匹配 Pod 的 IP:Port 写入 Endpoints 对象

### 3.2 EndpointSlice

**Endpoints 对象的问题**：一个 Endpoints 对象包含 Service 的**所有**后端 Pod IP。当 Service 有上千个后端 Pod 时，Endpoints 对象变得很大——每次单个 Pod 变更都需要更新整个对象，序列化和传输开销显著。

**EndpointSlice**（K8s 1.21 GA）将一个大 Endpoints 拆分为多个 Slice——每个 Slice 最多包含 100 个端点。Pod 变更只需更新包含该 Pod 的 Slice，大幅减少了更新的数据量。

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web-api
# NAME              ADDRESSTYPE   PORTS   ENDPOINTS              AGE
# web-api-abc12     IPv4          8080    10.244.1.5,10.244.2.8  5m
# web-api-def34     IPv4          8080    10.244.3.3             5m
```

EndpointSlice 还增加了对**拓扑感知路由**的支持——每个端点可以携带节点名称和可用区信息，kube-proxy 可以优先将流量路由到同可用区的 Pod（减少跨区延迟和流量费用）。

---

## 第 4 章 kube-proxy 的三种模式

### 4.1 kube-proxy 的角色

**kube-proxy** 运行在每个节点上（通常以 DaemonSet 部署），负责将 Service 的虚拟 IP 转换为实际的 Pod IP——实现 Service 层面的负载均衡。

kube-proxy 不直接处理流量——它通过配置节点上的**内核级转发规则**（iptables 或 IPVS）来实现转发。数据包在内核网络栈中直接被转发，不经过用户态——性能非常高。

### 4.2 iptables 模式（默认）

kube-proxy 为每个 Service 生成一组 iptables 规则——将发往 ClusterIP 的数据包 DNAT 到后端 Pod IP。

```
# 简化的 iptables 规则示例
# 匹配目标为 ClusterIP 10.96.0.100:80 的数据包
-A KUBE-SERVICES -d 10.96.0.100/32 -p tcp --dport 80 -j KUBE-SVC-XXXXX

# KUBE-SVC-XXXXX 链：随机选择后端（概率负载均衡）
-A KUBE-SVC-XXXXX -m statistic --mode random --probability 0.333 -j KUBE-SEP-AAA
-A KUBE-SVC-XXXXX -m statistic --mode random --probability 0.500 -j KUBE-SEP-BBB
-A KUBE-SVC-XXXXX -j KUBE-SEP-CCC

# KUBE-SEP-AAA：DNAT 到 Pod-1
-A KUBE-SEP-AAA -p tcp -j DNAT --to-destination 10.244.1.5:8080

# KUBE-SEP-BBB：DNAT 到 Pod-2
-A KUBE-SEP-BBB -p tcp -j DNAT --to-destination 10.244.2.8:8080

# KUBE-SEP-CCC：DNAT 到 Pod-3
-A KUBE-SEP-CCC -p tcp -j DNAT --to-destination 10.244.3.3:8080
```

**负载均衡算法**：iptables 模式使用**随机概率**——通过 `--probability` 参数让每条规则被匹配的概率相等。对于 3 个后端：第一条规则概率 1/3，第二条概率 1/2（因为只有 2/3 的数据包到达这里），第三条概率 1（剩余的全部）。

**优点**：
- 实现简单、成熟稳定
- 内核级转发，不经过用户态——性能好

**缺点**：
- **规则数量线性增长**：每个 Service 的每个后端 Pod 都需要多条 iptables 规则。1000 个 Service × 10 个 Pod = 数万条规则——规则的插入和匹配变慢
- **不支持高级负载均衡**：只有随机负载均衡——不支持加权、最少连接、会话亲和性等算法
- **规则更新慢**：每次 Endpoints 变更需要全量刷新所有规则——在大规模集群中可能需要数秒

### 4.3 IPVS 模式

IPVS（IP Virtual Server）是 Linux 内核的四层负载均衡模块——专门为高性能负载均衡设计。kube-proxy 的 IPVS 模式使用 IPVS 替代 iptables 实现 Service 转发。

```bash
# 查看 IPVS 规则
ipvsadm -Ln
# TCP  10.96.0.100:80 rr
#   -> 10.244.1.5:8080    Masq    1      0      0
#   -> 10.244.2.8:8080    Masq    1      0      0
#   -> 10.244.3.3:8080    Masq    1      0      0
```

**优点**：
- **哈希表查找**：IPVS 使用哈希表（O(1)）查找目标，而非 iptables 的链式遍历（O(n)）——在 Service/Pod 数量大时性能优势明显
- **丰富的负载均衡算法**：支持轮询（rr）、加权轮询（wrr）、最少连接（lc）、加权最少连接（wlc）、源地址哈希（sh）等
- **增量更新**：添加/删除后端时只需操作单条 IPVS 规则——不需要全量刷新

**缺点**：
- 需要节点内核支持 IPVS 模块（大多数 Linux 发行版默认支持）
- 仍然需要少量 iptables 规则处理 SNAT 和 NodePort

**适用场景**：Service 和 Pod 数量较多的大规模集群（超过 1000 个 Service）。

### 4.4 nftables 模式（K8s 1.29+）

**nftables** 是 iptables 的继任者——更高效的规则引擎和更灵活的语法。K8s 1.29 引入了 nftables 模式作为 iptables 模式的替代。

**优点**：
- 规则更新比 iptables 更高效（支持原子批量更新）
- 规则匹配性能更好（使用集合和映射而非链式遍历）
- 长期来看会替代 iptables（Linux 社区的方向）

### 4.5 三种模式的对比

| 维度 | iptables | IPVS | nftables |
| :--- | :--- | :--- | :--- |
| **查找复杂度** | O(n)（链式遍历）| O(1)（哈希表）| O(1)（集合/映射）|
| **负载均衡算法** | 随机概率 | rr/wrr/lc/wlc/sh | 随机概率 |
| **规则更新** | 全量刷新 | 增量更新 | 原子批量更新 |
| **成熟度** | 最成熟 | 成熟 | Beta |
| **适用规模** | 小中集群 | 大规模集群 | 中大规模集群 |
| **内核依赖** | 默认可用 | 需要 IPVS 模块 | 需要 nftables 支持 |

---

## 第 5 章 Session Affinity

### 5.1 问题场景

某些应用需要**同一个客户端的所有请求发到同一个 Pod**——例如基于内存 Session 的 Web 应用（用户登录状态存储在 Pod 的内存中）。默认的负载均衡（随机/轮询）无法保证这一点。

### 5.2 ClientIP Session Affinity

```yaml
spec:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800    # Session 保持时间（默认 3 小时）
```

kube-proxy 根据客户端 IP 做哈希——同一个 IP 的请求始终被路由到同一个后端 Pod（在该 Pod 存在且健康的期间）。

**局限性**：
- 只支持基于 Client IP 的亲和——不支持基于 Cookie 或 Header
- 如果客户端通过 NAT（如公司出口）访问，所有用户共享同一个 IP → 所有请求落到同一个 Pod → 负载不均
- Pod 被删除后亲和性失效——新请求被随机分配

> [!note] Session Affinity vs 无状态设计
> Session Affinity 是对"有状态 Session"的妥协方案——正确的做法是将 Session 外置到 Redis 或数据库，使应用完全无状态。无状态应用不需要 Session Affinity，可以充分利用负载均衡——任何 Pod 都能处理任何请求。

---

## 第 6 章 Headless Service

### 6.1 什么是 Headless Service

**Headless Service** 是 `clusterIP: None` 的 Service——没有虚拟 IP，DNS 查询直接返回后端 Pod 的 IP 地址列表。

```yaml
spec:
  clusterIP: None
  selector:
    app: mysql
```

```bash
# 普通 Service 的 DNS 解析
nslookup web-api.default.svc.cluster.local
# → 10.96.0.100 (ClusterIP)

# Headless Service 的 DNS 解析
nslookup mysql.default.svc.cluster.local
# → 10.244.1.5 (Pod-0 IP)
# → 10.244.2.8 (Pod-1 IP)
# → 10.244.3.3 (Pod-2 IP)
```

### 6.2 为什么需要 Headless Service

两个核心场景：

**场景一：[[03 StatefulSet 控制器深度解析|StatefulSet]] 的稳定网络标识。** StatefulSet 的每个 Pod 需要独立的 DNS 名称（如 `mysql-0.mysql.svc`）——Headless Service 为每个 Pod 创建独立的 DNS A 记录。普通 Service 只有一个 ClusterIP，无法区分不同的 Pod。

**场景二：客户端自主负载均衡。** 某些客户端库（如 gRPC 客户端、数据库驱动）内置了负载均衡逻辑——它们需要知道所有后端 Pod 的 IP 地址，自己决定连接哪个。Headless Service 通过 DNS 返回所有 Pod IP，让客户端做出选择。

### 6.3 Headless Service 与 kube-proxy

kube-proxy **不处理** Headless Service——因为没有 ClusterIP，不需要 iptables/IPVS 规则。Headless Service 完全通过 DNS 工作——客户端从 DNS 获得 Pod IP 列表后直接连接 Pod。

---

## 第 7 章 externalTrafficPolicy

### 7.1 Cluster 策略（默认）

`externalTrafficPolicy: Cluster`：外部流量到达 NodePort 后，kube-proxy 将其转发到**集群中任意节点**上的后端 Pod——即使目标 Pod 不在当前节点上。

```
外部 → Node-A:30080 → DNAT → Pod on Node-B (10.244.2.8:8080)
```

**副作用**：跨节点转发时需要 SNAT（将源 IP 改为 Node-A 的 IP）——后端 Pod 看到的客户端 IP 是 Node-A 的 IP 而不是真实的客户端 IP。**源 IP 丢失。**

### 7.2 Local 策略

`externalTrafficPolicy: Local`：外部流量只被转发到**本节点**上的后端 Pod——不做跨节点转发。

```yaml
spec:
  type: NodePort
  externalTrafficPolicy: Local
```

**优点**：
- **保留源 IP**：不需要 SNAT，后端 Pod 看到真实的客户端 IP
- **减少延迟**：不跨节点，少一跳

**缺点**：
- **负载不均**：如果 Node-A 有 3 个后端 Pod，Node-B 有 1 个，流量被均匀分到两个 Node，但 Node-B 的 1 个 Pod 承受了与 Node-A 的 3 个 Pod 相同的流量
- **节点健康检查**：如果某个节点没有后端 Pod，发到该节点的请求会返回错误——外部 LB 需要配合健康检查摘除没有 Pod 的节点

---

## 第 8 章 总结

本文系统分析了 K8s Service 的工作原理和 kube-proxy 的实现机制：

- **Service 的四种类型**：ClusterIP（集群内部）、NodePort（节点端口）、LoadBalancer（云 LB）、ExternalName（DNS CNAME）
- **Endpoints / EndpointSlice**：记录 Service 后端的 Pod IP 列表，EndpointSlice 拆分大列表提升更新效率
- **kube-proxy 三种模式**：iptables（默认，O(n) 链式匹配）、IPVS（O(1) 哈希查找，多种 LB 算法）、nftables（现代替代）
- **Session Affinity**：ClientIP 哈希实现会话保持，但不如无状态设计
- **Headless Service**：无 ClusterIP，DNS 直接返回 Pod IP 列表——用于 StatefulSet 和客户端自主 LB
- **externalTrafficPolicy**：Cluster（跨节点转发，丢失源 IP）vs Local（本地转发，保留源 IP）

下一篇 [[06 DNS 服务发现与 Ingress]] 将深入 CoreDNS 和 Ingress 的工作原理——Service DNS 记录如何生成、外部流量如何通过 Ingress 路由到 Pod。

---

## 参考资料

1. Kubernetes Documentation - Service：https://kubernetes.io/docs/concepts/services-networking/service/
2. Kubernetes Documentation - EndpointSlice：https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/
3. Kubernetes Documentation - kube-proxy：https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/
4. Kubernetes Documentation - IPVS mode：https://kubernetes.io/docs/concepts/services-networking/service/#proxy-mode-ipvs
5. Kubernetes Enhancement Proposal - nftables kube-proxy：https://github.com/kubernetes/enhancements/tree/master/keps/sig-network/3866-nftables-proxy
6. Kubernetes Source Code - pkg/proxy：https://github.com/kubernetes/kubernetes/tree/master/pkg/proxy
