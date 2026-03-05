---
title: "流量管理——VirtualService、DestinationRule与灰度发布"
date: 2026-03-05
tags: [云原生, 服务网格, Istio, VirtualService, DestinationRule, 灰度发布, 金丝雀, 流量管理, 故障注入]
aliases: []
---

# 流量管理——VirtualService、DestinationRule与灰度发布

## 摘要

Istio 的流量管理能力建立在两个核心 CRD 之上：**VirtualService** 定义"流量应该去哪里"（路由规则），**DestinationRule** 定义"如何到达目的地"（连接策略与子集划分）。本文深入这两个 CRD 的精确语义，逐条解析 match 条件的优先级与合并规则，剖析 subset 的实现原理，并通过四个完整的生产场景——金丝雀发布、基于 Header 的 A/B 测试、流量镜像、故障注入——展示 Istio 流量管理的工程实践。最后重点分析 VirtualService 和 DestinationRule 配置不当时的常见故障模式与排查方法。**流量管理不是功能展示，而是将"业务发布策略"翻译为"基础设施配置"的工程语言。**

---

## 第 1 章 Kubernetes Service 的流量管理局限性

### 1.1 原生 Service 能做什么，不能做什么

在引入 Istio 流量管理之前，回顾 Kubernetes 原生 Service 能提供的流量管理能力，以便清晰地理解 Istio 解决的问题边界。

**原生 Service 能做的**：
- L4 负载均衡（随机/轮询，基于 iptables/IPVS）
- 服务发现（稳定的 ClusterIP 和 DNS 名）
- 健康检查（通过 Endpoint 健康状态管理）
- Session Affinity（基于源 IP 的粘性会话）

**原生 Service 不能做的**：
- 基于 HTTP Header 的路由（如 `User-Agent: iOS` 走移动版 API）
- 精确的权重路由（如 95%/5% 分配，而非基于副本数比例）
- 超时和重试（Kubernetes 不在网络层控制，需要应用自己实现）
- 熔断（Circuit Breaking）
- 故障注入（用于混沌工程）
- 流量镜像（将生产流量同时发一份给测试环境）

这些能力的缺失，让 Kubernetes 集群内的服务发布变成了一个风险很高的操作：**要么不发布，要么全量发布**——中间没有过渡地带。

### 1.2 灰度发布的工程挑战

**灰度发布（Canary Release）**，又称金丝雀发布，是业界降低发布风险的标准实践：先让少量用户接触新版本，观察新版本在真实流量下的表现，确认稳定后再扩大比例，最终全量切换。

在没有服务网格时，Kubernetes 上实现灰度发布的唯一方式是**控制副本比例**：新旧版本各部署一个 Deployment，通过调整副本数来控制流量比例。

例如，想将 10% 的流量发给新版本：
- 旧版本 Deployment：9 个副本
- 新版本 Deployment：1 个副本
- 总副本 10 个，随机负载均衡下新版本获得约 10% 的流量

这个方案有两个本质问题：

**问题一：粒度粗糙**。副本数是整数，精度受总副本数限制。想做 1% 灰度？需要至少 100 个副本。在资源有限的情况下，无法做到细粒度的流量控制。

**问题二：与 Pod 数量耦合**。流量比例与副本数绑定，调整灰度比例需要调整 Deployment 副本数。这让资源扩缩容（HPA）与灰度发布相互干扰——当 HPA 因流量压力自动扩容新版本 Deployment 时，新版本的流量比例也随之增加，超出预期。

Istio 的 VirtualService + DestinationRule 将流量比例与副本数**完全解耦**，可以在任意副本数组合下，精确控制流量的百分比分配。

---

## 第 2 章 VirtualService 深度解析

### 2.1 VirtualService 的作用域

**VirtualService** 定义了一组路由规则，应用于发往特定 `hosts` 的流量。"hosts"是 VirtualService 的作用入口，支持：
- Kubernetes Service 的短名（`backend-service`）
- Service 的 FQDN（`backend-service.default.svc.cluster.local`）
- 通配符（`*.default.svc.cluster.local`）
- 外部域名（需配合 ServiceEntry 使用，如 `api.stripe.com`）

VirtualService 的作用范围：
- 当 `spec.gateways` 为空时，规则作用于**集群内部**的 Sidecar（东西流量）
- 当 `spec.gateways` 包含 `mesh`（默认）或特定 Gateway 名称时，分别作用于 Sidecar 和 Ingress Gateway

### 2.2 HTTP 路由规则的匹配条件

VirtualService 的 HTTP 路由规则支持极其丰富的匹配条件：

```yaml
spec:
  hosts:
  - backend-service
  http:
  - match:
    - uri:
        prefix: "/api/v2/"          # URI 前缀匹配
      method:
        exact: "GET"                # HTTP Method 精确匹配
      headers:
        x-user-tier:
          exact: "premium"          # Header 精确匹配
        x-request-id:
          regex: ".*-prod-.*"       # Header 正则匹配（使用 RE2 语法）
      queryParams:
        version:
          exact: "beta"             # Query 参数匹配
      scheme:
        exact: "https"              # 协议匹配
      port: 80                      # 端口匹配
    route:
    - destination:
        host: backend-service
        subset: v2
```

**match 条件的组合语义**：

同一个 `match` 块中的多个条件是 **AND 关系**（同时满足才匹配）：
```yaml
match:
- uri:
    prefix: "/api/"
  headers:
    x-version:
      exact: "v2"
# 以上等于：URI 前缀 /api/ 且 Header x-version: v2
```

同一 `http` 规则下的多个 `match` 块是 **OR 关系**（满足任意一个即匹配）：
```yaml
match:
- uri:
    prefix: "/api/v1/"
- uri:
    prefix: "/api/v2/"
# 以上等于：URI 前缀 /api/v1/ 或 /api/v2/
```

**路由规则的优先级**：VirtualService 中的 `http` 规则按**从上到下**的顺序匹配，第一个匹配的规则生效。没有 `match` 字段的规则（默认规则）应当放在列表最后，否则它会匹配所有请求，后续的精确规则永远不会被执行。

> [!warning] 生产避坑
> 这是 VirtualService 配置中最常见的错误之一：将默认路由规则（无 `match` 字段）放在了精确规则之前，导致精确规则永远不生效。如果你发现 Header 路由或灰度规则不工作，第一件事就是检查规则顺序。

### 2.3 Route 目标：weight 与 destination

**单目标路由**：
```yaml
route:
- destination:
    host: backend-service
    subset: v1
    port:
      number: 8080
```

**权重路由（灰度发布基础）**：
```yaml
route:
- destination:
    host: backend-service
    subset: v1
  weight: 90
- destination:
    host: backend-service
    subset: v2
  weight: 10
```

权重之和必须为 100（在最新版 Istio 中，如果只有一个 destination，weight 可以省略，默认 100）。Envoy 根据权重以**连接为单位**进行随机分配——每个新 TCP 连接选择一次 subset，连接建立后该连接的所有 HTTP 请求都走这个 subset。

> [!info] 核心概念
> 权重路由是**请求级别**的（对于 HTTP/1.1 短连接）或**连接级别**的（对于 HTTP/2 长连接）随机分配。对于 gRPC（HTTP/2 长连接），一旦选定了 subset，这条连接上的所有 RPC 调用都走同一个 subset，直到连接关闭才重新分配。因此，gRPC 的灰度发布精度取决于连接重建频率，如果客户端维持很少的长连接，10% 的权重可能实际上只有 0 或 100%（取决于那条长连接选到了哪个 subset）。解决方案：在 DestinationRule 中设置 `maxRequestsPerConnection: 1`，强制 HTTP/2 每次请求后关闭连接，实现真正的请求级别权重分配。

### 2.4 超时配置

VirtualService 中的超时配置作用于 Envoy 的 HTTP 请求超时：

```yaml
http:
- route:
  - destination:
      host: backend-service
  timeout: 5s          # 整个请求（含重试）的总超时
```

**超时配置的优先级**（从高到低）：
1. 请求的 `x-envoy-upstream-rq-timeout-ms` Header（允许客户端覆盖）
2. VirtualService 中的 `timeout` 字段
3. DestinationRule 中的 `connectionPool.http.idleTimeout`
4. Envoy 默认值（无上限）

> [!warning] 生产避坑
> 超时配置有一个反直觉的行为：如果你在 VirtualService 中设置 `timeout: 5s`，同时配置了 3 次重试（每次 2s 超时），那么总时间可能是 6s（超过了 5s 的总超时）。这是因为 `timeout` 是整个请求（含所有重试）的总超时，而每次重试的 `perTryTimeout` 是单次超时。需要确保 `timeout >= perTryTimeout × retries`，否则重试还没完成，总超时就触发了。

### 2.5 重试配置

```yaml
http:
- route:
  - destination:
      host: backend-service
  retries:
    attempts: 3               # 最多重试 3 次（不含首次请求）
    perTryTimeout: 2s         # 每次尝试的超时
    retryOn: "gateway-error,connect-failure,retriable-4xx"
    retryRemoteLocalities: true  # 重试时可以跨 Zone
```

`retryOn` 的可选值（多个值逗号分隔）：
- `5xx`：后端返回 5xx
- `gateway-error`：502/503/504
- `reset`：连接被重置（TCP RST）
- `connect-failure`：连接失败
- `retriable-4xx`：可重试的 4xx（目前只有 409）
- `retriable-status-codes`：与 `retriableStatusCodes` 字段配合，指定自定义状态码

---

## 第 3 章 DestinationRule 深度解析

### 3.1 subset 的实现原理

**DestinationRule** 的核心功能之一是定义 **subset（子集）**——将同一 Service 的 Endpoint 按 Label 分组，每个 subset 对应一个 Envoy Cluster。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: backend-dr
spec:
  host: backend-service
  subsets:
  - name: v1
    labels:
      version: v1          # 选中有 version: v1 标签的 Pod
  - name: v2
    labels:
      version: v2
  - name: stable
    labels:
      env: production
      version: v1          # 多个标签 AND 关系
```

**istiod 如何实现 subset**：

1. Pilot 收到 DestinationRule 配置后，为 `backend-service` 创建 3 个 Envoy Cluster：
   - `outbound|80|v1|backend-service.default.svc.cluster.local`
   - `outbound|80|v2|backend-service.default.svc.cluster.local`
   - `outbound|80|stable|backend-service.default.svc.cluster.local`

2. 对于每个 Cluster，Pilot 通过 EDS 只推送对应 Label 的 Pod IP。例如 v2 Cluster 的 EDS 只包含有 `version: v2` 标签的 Pod。

3. VirtualService 在 Route 中通过 `subset: v2` 引用对应 Cluster，Envoy 路由到这个 Cluster 时，只会选择 `version: v2` 的 Pod 作为 Endpoint。

**关键约束**：VirtualService 中引用的 subset 必须在 DestinationRule 中已定义，否则 Envoy 会找不到对应的 Cluster，路由到这个 subset 的请求会返回 503（`NR: No Route`）。这是生产中"突然所有请求返回 503"的常见原因之一——往往是先删除了 DestinationRule，再更新 VirtualService，或者 subset 名称拼写不一致。

### 3.2 流量策略：全局 vs subset 级别

DestinationRule 支持两个层级的流量策略：

```yaml
spec:
  host: backend-service
  trafficPolicy:                    # 全局策略，适用于所有 subset
    connectionPool:
      http:
        http2MaxRequests: 1000
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
  subsets:
  - name: v1
    labels:
      version: v1
    # 没有 trafficPolicy，继承全局策略
  - name: v2
    labels:
      version: v2
    trafficPolicy:                  # subset 级别策略，覆盖全局策略
      connectionPool:
        http:
          http2MaxRequests: 500     # v2 subset 使用不同的连接池上限
      loadBalancer:
        simple: LEAST_REQUEST       # v2 使用最少请求负载均衡
```

subset 级别的 `trafficPolicy` 会**完全覆盖**（而非合并）全局 `trafficPolicy` 中的对应字段。注意这里是字段级别的覆盖，不是深层合并——如果 subset 的 `trafficPolicy` 只配置了 `connectionPool`，而没有配置 `outlierDetection`，那么这个 subset 将**没有** outlier detection（不继承全局的 outlierDetection 配置）。

> [!warning] 生产避坑
> 这是 DestinationRule 最容易踩的坑：为某个 subset 配置了部分 `trafficPolicy`（如只配置了 `loadBalancer`），误以为没配置的字段会继承全局策略，实际上那些字段在这个 subset 中是默认值（无熔断、无连接池限制）。建议在 subset 的 `trafficPolicy` 中明确写出所有需要的配置字段，不要依赖"部分继承"。

### 3.3 TLS 模式配置

DestinationRule 的 `trafficPolicy.tls` 字段控制 Envoy 发出请求时使用的 TLS 模式：

```yaml
trafficPolicy:
  tls:
    mode: ISTIO_MUTUAL   # 使用 Istio 管理的 mTLS（推荐）
```

| TLS 模式 | 含义 | 适用场景 |
| :--- | :--- | :--- |
| `DISABLE` | 明文 HTTP | 禁用 mTLS（调试用，不建议生产） |
| `SIMPLE` | 单向 TLS（Envoy 验证服务端证书） | 访问外部 HTTPS 服务 |
| `MUTUAL` | 双向 TLS（自定义证书，非 Istio 管理） | 接入外部 mTLS 服务 |
| `ISTIO_MUTUAL` | 双向 TLS（Istio 自动管理证书） | **Istio mesh 内服务间通信推荐** |

通常情况下，如果通过 `PeerAuthentication` 开启了 mTLS（`STRICT` 模式），不需要在 DestinationRule 中显式配置 TLS——Istio 会自动为 mesh 内部的服务间通信启用 `ISTIO_MUTUAL`。只有当你需要访问 mesh 外部的 TLS 服务，或者遇到了 mTLS 兼容性问题时，才需要在 DestinationRule 中显式配置 TLS 模式。

---

## 第 4 章 生产场景实战

### 4.1 场景一：金丝雀发布（Canary Release）

**需求**：将 backend-service 从 v1 升级到 v2，先让 5% 的流量打到 v2，观察 2 小时后，如果没问题再逐步增加到 50%、100%。

**Step 1：为新版本 Pod 打上版本标签**

```yaml
# backend-deployment-v1.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-v1
spec:
  replicas: 4
  selector:
    matchLabels:
      app: backend
      version: v1
  template:
    metadata:
      labels:
        app: backend
        version: v1
    spec:
      containers:
      - name: backend
        image: backend:v1

---
# backend-deployment-v2.yaml（同时部署）
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-v2
spec:
  replicas: 1           # 副本数不影响流量比例！
  selector:
    matchLabels:
      app: backend
      version: v2
  template:
    metadata:
      labels:
        app: backend
        version: v2
    spec:
      containers:
      - name: backend
        image: backend:v2
```

**Step 2：配置 DestinationRule 定义 subset**

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: backend-dr
  namespace: production
spec:
  host: backend-service
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

**Step 3：配置 VirtualService 进行初始灰度（5%）**

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: backend-vs
  namespace: production
spec:
  hosts:
  - backend-service
  http:
  - route:
    - destination:
        host: backend-service
        subset: v1
      weight: 95
    - destination:
        host: backend-service
        subset: v2
      weight: 5
```

**Step 4：逐步调整权重（无需重新部署 Pod）**

只需修改 VirtualService 的 weight 字段：
```bash
# 50% 灰度
kubectl patch vs backend-vs -n production --type=json \
    -p='[{"op": "replace", "path": "/spec/http/0/route/0/weight", "value": 50},
         {"op": "replace", "path": "/spec/http/0/route/1/weight", "value": 50}]'

# 100% 切换到 v2
kubectl patch vs backend-vs -n production --type=json \
    -p='[{"op": "replace", "path": "/spec/http/0/route/0/weight", "value": 0},
         {"op": "replace", "path": "/spec/http/0/route/1/weight", "value": 100}]'
# 切换完成后，删除 v1 Deployment 和旧的 subset 配置
```

**关键优势**：整个过程中 v1 和 v2 Deployment 的副本数不需要调整，流量比例完全由 VirtualService 控制。v2 只有 1 个副本，但可以只接收 5% 的流量，不会因副本少就接收更多或更少的流量。

### 4.2 场景二：基于 Header 的 A/B 测试

**需求**：特定用户（Beta 测试用户，通过 `x-beta-user: true` Header 标识）访问新版本，其他用户继续访问旧版本。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: backend-vs
spec:
  hosts:
  - backend-service
  http:
  - match:
    - headers:
        x-beta-user:
          exact: "true"            # Beta 用户走 v2
    route:
    - destination:
        host: backend-service
        subset: v2
  - route:                         # 默认走 v1（放在最后）
    - destination:
        host: backend-service
        subset: v1
```

**实际使用中，这个 Header 通常来自前端应用**：
- 用户登录后，根据用户 ID 是否在 Beta 名单中，前端在每个 API 请求中附加 `x-beta-user: true`
- API 网关（或 Istio Ingress Gateway）验证用户身份后，注入这个 Header
- 后续所有服务间调用只要传播这个 Header，就能确保整个调用链都走 v2

**Header 传播的注意事项**：Istio 的流量路由基于 Envoy 对 HTTP Header 的检测，但 Header 在服务间传播需要**应用代码主动传递**——当 Service A 调用 Service B 时，A 必须在发出的请求中包含从客户端收到的 `x-beta-user` Header，否则 B 处的路由规则无法感知用户的 Beta 身份。这是服务网格流量管理的一个内在限制：L7 Header 路由依赖应用的 Header 传播，不是完全透明的。

### 4.3 场景三：流量镜像（Traffic Mirroring）

**需求**：在不影响生产用户的前提下，将生产流量实时复制一份发给 v2 版本，用于新版本的真实流量压测和验证，v2 的响应被丢弃（不返回给客户端）。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: backend-vs
spec:
  hosts:
  - backend-service
  http:
  - route:
    - destination:
        host: backend-service
        subset: v1
      weight: 100             # 生产流量 100% 走 v1
    mirror:
      host: backend-service
      subset: v2              # 同时镜像一份到 v2
    mirrorPercentage:
      value: 100.0            # 镜像 100% 的流量（也可以是 10.0 即 10%）
```

**流量镜像的内部机制**：Envoy 收到请求后，转发给 v1 的同时，**异步**地将请求复制一份发给 v2。镜像请求的 URL 路径会被修改（追加 `-shadow` 后缀，如 `/api/v1/users-shadow`），以便 v2 的日志能区分镜像流量和真实流量。Envoy 等待 v1 的响应并返回给客户端，不等待 v2 的响应——所以 v2 的延迟不影响客户端体验。

**适用场景**：
- 新版本上线前的最终验证（无风险）
- 对比新旧版本的响应差异（Shadow Testing）
- 用生产流量给测试环境做压测

> [!warning] 生产避坑
> 流量镜像会**加倍**对后端服务的请求量。如果你镜像 100% 的流量，v2 接收的请求量与 v1 相同。确保 v2 环境的容量足够，或者只镜像一部分流量（`mirrorPercentage: {value: 10.0}`）。另外，镜像流量中包含所有 POST/PUT 等写操作——如果 v2 连接了生产数据库，镜像写操作会真实写入生产数据！务必确保 v2 使用独立的测试数据库，或者只镜像 GET 等只读请求。

### 4.4 场景四：故障注入（Fault Injection）

**需求**：验证 frontend 服务在 backend-service 出现 50% 的概率性 500 错误时，是否能正确降级（而不是直接崩溃）。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: backend-vs
spec:
  hosts:
  - backend-service
  http:
  - fault:
      abort:
        percentage:
          value: 50.0          # 50% 的请求返回错误
        httpStatus: 500        # 注入 500 错误
      delay:
        percentage:
          value: 20.0          # 另外 20% 的请求注入延迟
        fixedDelay: 3s         # 3 秒延迟
    route:
    - destination:
        host: backend-service
        subset: v1
```

**故障注入的执行位置**：fault injection 在 Envoy 的 HTTP Filter 层执行——当请求命中 `abort` 条件时，Envoy **直接在 Sidecar 侧返回错误**，不会将请求转发给后端 Pod。这意味着：
1. 后端 Pod 的代码不执行，数据不被修改
2. 可以精确控制注入的错误类型和比例
3. 可以验证客户端（frontend）的容错逻辑，而不需要真的让 backend 产生错误

**注入延迟的用途**：通过注入固定延迟（如 3s），可以验证超时配置是否正确——如果 frontend 的超时配置为 2s，注入 3s 延迟后 frontend 应该收到超时错误，并执行重试或降级逻辑。如果 frontend 超时配置有误（如 10s），这次测试会暴露这个问题。

故障注入是**混沌工程（Chaos Engineering）**的 Istio 实现方式——在受控条件下向系统注入故障，验证系统的弹性，发现在故障传播前潜在的脆弱点。

---

## 第 5 章 Gateway——入口流量管理

### 5.1 Gateway 与 Kubernetes Ingress 的关系

**Istio Gateway** 管理进入（或离开）mesh 边界的流量，功能上类似于 Kubernetes Ingress，但提供更细粒度的控制：

| 维度 | Kubernetes Ingress | Istio Gateway |
| :--- | :--- | :--- |
| **协议支持** | HTTP/HTTPS | HTTP/HTTPS/TCP/TLS/gRPC |
| **流量管理** | 仅基础路由（host/path） | 完整 VirtualService 能力（weight/header/retry 等）|
| **TLS 终止** | 支持 | 支持（也可以 TLS passthrough） |
| **自定义扩展** | Controller 相关（NGINX/Traefik 注解） | 标准 Istio CRD |

**Gateway 的工作原理**：Istio 部署一个专用的 Envoy 实例（`istio-ingressgateway` Deployment）作为 Ingress Gateway，Gateway CRD 配置这个 Envoy 监听哪些端口和 TLS 设置，VirtualService 配置 Ingress Gateway 收到的流量如何路由。

### 5.2 Gateway + VirtualService 的协作

```yaml
# 1. Gateway: 配置 Ingress 监听
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: frontend-gateway
  namespace: istio-system
spec:
  selector:
    istio: ingressgateway      # 选中 istio-ingressgateway Pod
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: SIMPLE             # TLS 终止（HTTPS→HTTP 发到后端）
      credentialName: frontend-tls-secret  # TLS 证书存储在 K8s Secret 中
    hosts:
    - "app.example.com"

---
# 2. VirtualService: 配置 Ingress 路由规则
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: frontend-vs
spec:
  hosts:
  - "app.example.com"
  gateways:
  - istio-system/frontend-gateway    # 绑定到上面的 Gateway
  - mesh                             # 同时也对集群内部流量生效
  http:
  - match:
    - uri:
        prefix: "/api/"
    route:
    - destination:
        host: backend-service
        port:
          number: 80
  - route:
    - destination:
        host: frontend-service
        port:
          number: 3000
```

---

## 第 6 章 ServiceEntry——将外部服务纳入管理

### 6.1 为什么需要 ServiceEntry

默认情况下，Istio 对 mesh 内部的服务（Kubernetes Service）有完整的可见性，可以应用 VirtualService 策略。但对于外部服务（如 `api.stripe.com`、`rds.amazonaws.com`），Envoy 没有对应的 Cluster 定义，这类流量会通过"passthrough"模式直接转发（不经过任何 Istio 策略）。

**ServiceEntry 的作用**：将外部服务注册到 Istio 的服务注册表，使其能够被 VirtualService 控制。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: ServiceEntry
metadata:
  name: stripe-api
spec:
  hosts:
  - api.stripe.com
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  resolution: DNS
  location: MESH_EXTERNAL
```

注册后，可以为 `api.stripe.com` 配置：
- 超时策略（防止 Stripe API 慢响应影响应用）
- 重试（自动重试 Stripe 的偶发 503）
- 访问日志（追踪对 Stripe 的调用频率和成功率）
- 限流（防止应用过度调用 Stripe API 超出配额）

---

## 第 7 章 常见故障排查

### 7.1 503 No Healthy Upstream

**症状**：请求返回 `503 No Healthy Upstream`，Envoy 访问日志中 Response Flags 为 `UH`。

**排查步骤**：

```bash
# 1. 检查 Endpoint 是否存在且健康
istioctl proxy-config endpoint <pod-name>.<namespace> --cluster "outbound|80|v2|backend-svc.default.svc.cluster.local"
# 如果输出为空，说明没有健康 Endpoint

# 2. 检查 DestinationRule 的 subset 标签是否与 Pod 标签匹配
kubectl get pods -n default -l version=v2  # 确认有 v2 标签的 Pod
kubectl describe dr backend-dr -n default  # 确认 subset 定义

# 3. 检查 Pod 是否有 Sidecar 注入
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[*].name}'
# 应该包含 istio-proxy

# 4. 检查 Outlier Detection 是否把所有 Endpoint 都移除了
istioctl proxy-config cluster <pod-name>.<namespace> --fqdn "backend-svc.default.svc.cluster.local" -o json | grep -A5 "outlierDetection"
```

### 7.2 VirtualService 路由规则不生效

**症状**：修改了 VirtualService 的权重，但实际流量比例没有变化。

**排查步骤**：

```bash
# 1. 确认 VirtualService 是否正确同步到 Envoy
istioctl proxy-status  # 查看 RDS/CDS 是否 SYNCED

# 2. 检查 Envoy 实际的路由配置
istioctl proxy-config route <frontend-pod>.<namespace> --name "80" -o json

# 3. 分析 Istio 配置潜在问题
istioctl analyze -n default

# 4. 检查是否有多个 VirtualService 作用在同一个 host（会产生冲突）
kubectl get vs -A | grep backend-service

# 5. 确认 DestinationRule 和 VirtualService 在同一 Namespace（或使用完整 FQDN）
```

**常见原因**：
- VirtualService 中 `hosts` 字段与实际 Service 名不匹配（大小写、namespace 前缀）
- 多个 VirtualService 作用于同一 host 导致规则合并冲突
- 没有配置对应的 DestinationRule，subset 不存在
- Envoy 配置同步延迟（通常在几秒内完成，但网络问题可能延迟）

### 7.3 mTLS 导致的连接失败

**症状**：请求返回 `503`，Envoy 访问日志中出现 TLS handshake failure 或 `UF` Response Flag。

```bash
# 检查 PeerAuthentication 和 DestinationRule 的 TLS 模式是否一致
kubectl get peerauthentication -A
kubectl get dr -A -o yaml | grep -A5 "tls:"

# 常见冲突：
# - PeerAuthentication 设置了 STRICT mTLS
# - 某个服务的 DestinationRule 设置了 tls.mode: DISABLE
# 导致发送端不发 mTLS，接收端要求 mTLS，握手失败

# 检查 Envoy 的 mTLS 状态
istioctl authn tls-check <pod-name>.<namespace> backend-svc.default.svc.cluster.local
```

---

## 第 8 章 小结

### 8.1 VirtualService 与 DestinationRule 的职责边界

| CRD | 回答的问题 | 核心配置 |
| :--- | :--- | :--- |
| **VirtualService** | 流量应该去哪里？何时去哪里？ | 路由规则（match + route + weight）、超时、重试、故障注入 |
| **DestinationRule** | 如何到达目的地？ | subset 定义（Label 分组）、连接池、熔断、TLS 模式、负载均衡算法 |

两者的关系：VirtualService 通过 `subset` 名称引用 DestinationRule 中定义的子集，但 VirtualService 只需要知道 subset 的**名称**，具体的 Label Selector 和连接策略由 DestinationRule 封装。两者的 `host` 字段必须对应同一个 Kubernetes Service，才能正确关联。

### 8.2 下一篇预告

流量管理解决了"如何控制流量"，接下来看服务网格如何解决"如何保护流量"：

- **[[05 安全——mTLS、认证与授权策略]]**：SPIFFE 身份体系，PeerAuthentication 如何开启 mTLS，AuthorizationPolicy 如何基于服务身份做细粒度访问控制，以及证书轮换的完整生命周期

---

*本文是 [[服务网格]] 专栏的第 4 篇。*
