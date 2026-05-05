# 14: API 安全与 RBAC

Kubernetes 以 API 为中心，API 通过 API 服务器提供。在本章中，你将跟随一个典型的 API 请求，看它如何通过各种安全检查。

我将本章分为以下几个部分：

- API 安全全景
- 认证
- 授权（RBAC）
- 准入控制

详见第 15 章，更深入地了解 API 的设计和结构。

## API 安全全景

以下所有主体向 API 服务器发出 CRUD 风格的请求（创建、读取、更新、删除）：

- 使用 `kubectl` 的操作员和开发人员
- Pod
- Kubelet
- 控制平面服务
- 云原生应用

图 14.1 显示了一个典型的 API 请求流经标准检查的过程。无论请求来自何处，流程都是相同的。authN 是认证的缩写，而 authZ 是授权的缩写。

> [!figure] 图 14.1
> 一个典型的 API 请求流程：客户端 -> API 服务器 -> 认证（authN） -> 授权（authZ） -> 准入控制 -> 执行请求。

考虑一个简单的例子：一个名为 `grant-ward` 的用户试图在 `terran` 命名空间中创建一个名为 `hive` 的 Deployment。

`grant-ward` 用户使用 `kubectl apply` 命令将 YAML 文件发送到 Kubernetes，以在 `terran` 命名空间中创建 Deployment。`kubectl` 命令行工具生成一个请求，该请求携带着用户的凭证发送到 API 服务器。`kubectl` 与 API 服务器之间的连接由 TLS 保护。一旦请求到达 API 服务器，认证模块会判断请求是来自 `grant-ward` 还是冒充者。假设确实是 `grant-ward`，授权模块会判断 `grant-ward` 是否有权限在 `terran` 命名空间中创建 Deployment。如果请求通过了认证和授权，准入控制器会确保 Deployment 对象符合策略要求。只有在通过认证、授权和准入控制检查之后，请求才会被执行。

这个过程类似于乘坐商业航班。你前往机场，用带有照片的身份证明（通常是护照）进行身份验证。假设你通过了护照验证，系统会检查你是否购买了座位，因此你是否被授权登机。如果你通过了认证并被授权登机，准入控制可能会检查并应用航空公司政策，例如限制手提行李、禁止在机舱内携带酒精和武器。经过所有这些之后，你终于可以入座并飞往目的地。

下面我们来仔细看看认证。

## 认证

认证是关于证明你的身份。你可能会看到或听到它被缩写为 authN，发音为“auth-en”。

凭证是认证的核心，所有对 API 服务器的请求都包含凭证。认证层的责任就是验证这些凭证。如果验证失败，API 服务器会返回 HTTP 401 并拒绝请求。如果请求通过了认证，它会进入授权阶段。

Kubernetes 认证层是可插拔的，流行的模块包括客户端证书、Webhook 以及与外部身份管理系统（如 Active Directory (AD) 和基于云的身份访问管理 (IAM) 系统）的集成。实际上，Kubernetes 没有内置的身份数据库。相反，它强制你使用外部系统。这避免了创建另一个身份管理孤岛。

开箱即用时，大多数 Kubernetes 集群支持客户端证书，但在实际环境中，你会希望与所选云平台或企业身份管理系统集成。许多托管 Kubernetes 服务会自动与底层云的身份管理系统集成。在这些情况下，Kubernetes 会将认证卸载到外部系统。

### 检查当前认证设置

你的集群详情和用户凭证存储在 [[kubeconfig]] 文件中。像 `kubectl` 这样的工具会读取此文件以确定向哪个集群发送命令以及使用哪个凭证。该文件名为 `config`，位于以下位置：

- Windows: `C:\Users\<user>\.kube\config`
- Linux/Mac: `/home/<user>/.kube/config`

下面是 kubeconfig 文件的一个示例：

```yaml
apiVersion: v1
kind: Config
clusters:                        # 集群块,定义集群
- cluster:                  
    server: https://<url-or-ip-address-of-api-server>:443     # API服务器端点
    certificate-authority-data: LS0tLS1C...LS0tCg==           # CA证书的公钥
  name: prod-shield              # 此块定义了一个名为 prod-shield 的集群
users:                           # 用户块,定义一个或多个用户
- name: njfury                   # 名为 njfury 的用户
  user:
    as-user-extra: {}
    token: eyJhbGciOiJSUzI1NiIsImtpZCI6IlZwMzl...SZY3uUQ     # 令牌(通常是X.509证书)
contexts:                        # 上下文块.一个上下文
- context:
    cluster: prod-shield         # 集群
    user: njfury                 # 用户  
    namespace: default
  name: shield-admin             # 此块定义了一个名为 shield-admin 的上下文
current-context: shield-admin    # kubectl 使用的当前上下文
```

仔细看，你会发现它有四个顶层部分：

- `clusters`
- `users`
- `contexts`
- `current-context`

`clusters` 部分定义了一个或多个 Kubernetes 集群。每个集群都有一个友好的名称、一个 API 服务器端点以及其证书颁发机构 (CA) 的公钥。

`users` 部分定义了一个或多个用户。每个用户需要一个名称和令牌。令牌通常是集群 CA（或集群信任的 CA）签名的 X.509 证书。

`contexts` 部分是用户和集群对的列表，而 `current-context` 是 kubectl 命令使用的集群和用户。

以下 YAML 片段来自同一个 kubeconfig 文件，它会将所有请求作为 `njfury` 用户发送到 `prod-shield` 集群。

```yaml
current-context: shield-admin    # 当前上下文
contexts:                        
- context:
    name: shield-admin             # 此块定义了一个上下文
    cluster: prod-shield         # 将命令发送到该集群
    user: njfury                 # 要认证的用户
    namespace: default
```

集群的认证模块的任务是确定该用户是否真的是 `njfury`。如果你的集群集成了外部 IAM 系统，它会将认证移交给该系统。

假设认证成功，请求将进入授权阶段。

## 授权（RBAC）

授权紧接在成功认证之后发生，你有时会看到它被缩写为 authZ（发音为“auth zee”）。

Kubernetes 授权也是可插拔的，你可以在单个集群上运行多个 authZ 模块。然而，大多数集群使用 [[RBAC]]。此外，如果你的集群有多个授权模块，一旦任何模块授权了一个请求，就会跳过所有其他 authZ 模块并立即进入准入控制。

本节涵盖以下内容：

- RBAC 全景
- 用户与权限
- 集群级别的用户与权限
- 预配置的用户与权限

### RBAC 全景

最常见的授权模块是 RBAC（基于角色的访问控制，Role-Based Access Control）。在最高层面上，RBAC 涉及三个方面：

1. 用户
2. 操作
3. 资源

哪些用户可以对哪些资源执行哪些操作。

下表展示了一些示例。

| 用户 (主体) | 操作    | 资源             | 效果                     |
|------------|---------|------------------|--------------------------|
| Bao        | create  | Pods             | Bao 可以创建 Pods        |
| Kalila     | list    | Deployments      | Kalila 可以列出 Deployments |
| Josh       | delete  | ServiceAccounts  | Josh 可以删除 ServiceAccounts |

RBAC 在大多数 Kubernetes 集群上都是启用的，并且是一个最小权限、默认拒绝的系统。这意味着所有内容都被锁定，你需要创建允许规则来开放权限。实际上，Kubernetes 不支持拒绝规则——它只支持允许规则。这看似微小，但使实现和故障排除简单得多。

### 用户与权限

理解 Kubernetes RBAC 有两个关键概念：

- [[Role]]
- [[RoleBinding]]

`Role` 定义了一组权限，而 `RoleBinding` 将它们绑定给用户。

以下资源清单定义了一个 Role 对象。它名为 `read-deployments`，授予在 `shield` 命名空间中对 Deployment 对象执行 `get`、`watch` 和 `list` 的权限。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: shield
  name: read-deployments
rules:
- verbs: ["get", "watch", "list"]   # 允许的操作
  apiGroups: ["apps"]               # 对此类型的资源
  resources: ["deployments"]        # 进行操作
```

然而，Role 只有绑定到用户后才会生效。以下 RoleBinding 将上面的 `read-deployments` Role 绑定给一个名为 `sky` 的用户。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-deployments
  namespace: shield
subjects:
- kind: User
  name: sky                   # 已认证用户的名称
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: read-deployments      # 将此 Role 绑定给认证用户
  apiGroup: rbac.authorization.k8s.io
```

将这两个对象部署到你的集群后，一个名为 `sky` 的已认证用户将能够运行 `kubectl get deployments -n shield` 等命令。

RoleBinding 中列出的用户名必须是一个字符串，并且必须与一个已认证的用户匹配。

#### 深入了解规则

Role 对象有一个 `rules` 部分，定义了以下三个属性：

- `verbs`
- `apiGroups`
- `resources`

它们共同定义了允许对哪些对象执行哪些操作。

`verbs` 字段列出了允许的操作，而 `apiGroups` 和 `resources` 字段标识了允许对这些操作执行的对象。下面的代码片段来自上面的 Role 对象，允许对 Deployment 对象进行读取访问（`get`、`watch` 和 `list`）。

```yaml
rules:
- verbs: ["get", "watch", "list"]
  apiGroups: ["apps"] 
  resources: ["deployments"]
```

下表展示了一些可能的 `apiGroup` 和 `resources` 组合。

| apiGroup        | resource        | Kubernetes API 路径                              |
|-----------------|-----------------|--------------------------------------------------|
| ""              | pods            | `/api/v1/namespaces/{name}`                      |
| ""              | secrets         | `/api/v1/namespaces/{name}`                      |
| "storage.k8s.io" | storageclass    | `/apis/storage.k8s.io/v1/storageclasses`        |
| "apps"          | deployments     | `/apis/apps/v1/namespaces/{name}/deployments`   |

在 `apiGroups` 字段中的一对空引号（`""`）表示核心 API 组。所有其他 API 组需要作为双引号括起来的字符串指定。

下表列出了 Kubernetes 为对象访问支持的完整动词集。它通过将动词映射到标准 HTTP 方法和 HTTP 响应代码，展示了 Kubernetes API 的 REST 性质。

| Kubernetes 动词 | HTTP 方法 | 常见响应                                         |
|----------------|-----------|--------------------------------------------------|
| create         | POST      | 201 Created, 403 Access Denied                   |
| get, list, watch | GET      | 200 OK, 403 Access Denied                        |
| update         | PUT       | 200 OK, 403 Access Denied                        |
| patch          | PATCH     | 200 OK, 403 Access Denied                        |
| delete         | DELETE    | 200 OK, 403 Access Denied                        |

运行以下命令以显示所有 API 资源及其支持的动词。当你构建规则定义时，输出非常有用。

```bash
$ kubectl api-resources --sort-by name -o wide
```

# 14: API 安全与 RBAC

> [!INFO] 本部分涵盖认证、授权和准入控制。

| 操作  | HTTP方法 | 结果                 |
|-------|----------|----------------------|
| 创建  | POST     | 200 OK 或 403 Access Denied |
| 更新  | PUT      | 200 OK 或 403 Access Denied |
| 修补  | PATCH    | 200 OK 或 403 Access Denied |
| 删除  | DELETE   | 200 OK 或 403 Access Denied |

运行以下命令以显示所有 API 资源及其支持的动词。该输出在构建规则定义时非常有用。

```bash
$ kubectl api-resources --sort-by name -o wide
```

输出示例（截取部分）：

| NAME        | APIGROUP          | KIND       | VERBS                        |
|-------------|-------------------|------------|------------------------------|
| deployments | apps              | Deployment | [create delete ... get ...]  |
| ingresses   | networking.k8s.io | Ingress    | [create delete ... get ...]  |
| pods        |                   | Pod        | [create delete ... get ...]  |
| secrets     |                   | Secret     | [create delete ... get ...]  |
| services    |                   | Service    | [create delete get list ...] |
| <Snip>      |                   |            |                              |

构建规则时，可以使用星号（`*`）代表所有 API 组、所有资源和所有动词。例如，以下 Role 对象授予在所有 API 组中的所有资源上的所有操作。这仅用于演示目的，你可能不应该创建这种规则。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: shield
  name: read-deployments
rules:
- verbs: ["*"]       # 所有操作
  resources: ["*"]   # 所有资源
  apiGroups: ["*"]   # 所有 API 组
```

## 集群层面的用户和权限

到目前为止，你已看到 Roles 和 RoleBindings。然而，Kubernetes 实际上有四个 RBAC 对象：

- Roles
- RoleBindings
- ClusterRoles
- ClusterRoleBindings

Roles 和 RoleBindings 是命名空间作用域的对象，意味着它们应用于特定的命名空间。而 ClusterRoles 和 ClusterRoleBindings 是集群范围的对象，应用于所有命名空间。它们都在同一个 API 子组中定义，其 YAML 结构几乎相同。

一种强大的模式是使用 ClusterRoles 在集群级别一次性定义角色，然后使用 RoleBindings 将其绑定到多个特定的命名空间。这让你可以定义通用角色一次，并在需要时在任意数量的命名空间中重用它们。

图 14.2 展示了一个单一的 ClusterRole 通过两个独立的 RoleBindings 应用到两个命名空间。

*[图 14.2 - 组合 ClusterRoles 和 RoleBindings]*

以下 YAML 定义了前面提到的 `read-deployments` 角色。但这次它是一个 ClusterRole，意味着你可以使用 RoleBindings 将它应用到任意数量的命名空间 —— 每个命名空间一个 RoleBinding。

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole                   # 集群范围角色
metadata:
  name: read-deployments
rules:
- verbs: ["get", "watch", "list"]
  apiGroups: ["apps"] 
  resources: ["deployments"]
```

如果仔细观察 YAML，与之前相比唯一的区别是：这里的 `kind` 属性设置为 `ClusterRole`，并且没有 `metadata.namespace` 属性。

## 实际示例

让我们看一个实际示例。

大多数 Kubernetes 集群都有一组预创建的角色和绑定，以帮助初始配置和快速入门。下面的示例向你展示 Docker Desktop 的内置多节点 Kubernetes 集群如何使用 ClusterRoles 和 ClusterRoleBindings 将集群管理员权限授予 kubeconfig 文件中配置的用户。

如果你正在使用 Docker Desktop 的内置多节点 Kubernetes 集群（我们在第 3 章中展示了如何构建它），你可以跟着操作。其他集群的做法可能略有不同，但原理类似。

Docker Desktop 会自动配置你的 kubeconfig 文件，其中包含一个客户端证书，标识一个管理员用户。该证书由集群的内置 CA 签名，这意味着集群将信任其凭据。

运行以下命令查看 kubeconfig 文件中的 Docker Desktop 用户条目。我已修剪输出，突出显示我们感兴趣的部分。

```bash
$ kubectl config view
<Snip>
users:
- name: docker-desktop                  # ------┐ 
  user:                                     | 这是 Docker 
    client-certificate-data: DATA+OMITTED   | kubeconfig 条目,包括客户端证书
    client-key-data: DATA+OMITTED           | 和密钥
<Snip>                                  # ------┘
```

用户条目名为 `docker-desktop`，但这只是一个友好名称。`kubectl` 进行身份验证所用的用户名嵌入在文件同部分的客户端证书中。

运行以下长命令，解码 kubeconfig 客户端证书中嵌入的用户名和组成员身份。该命令仅适用于 Linux 风格的系统，并且你需要安装 `jq` 工具。你还需要确保 kubeconfig 的当前上下文设置为 Docker Desktop 用户和集群。

```bash
$ kubectl config view --raw -o json \
    | jq ".users[] | select(.name==\"docker-desktop\")" \
    | jq -r '.user["client-certificate-data"]' \
    | base64 -d | openssl x509 -text | grep "Subject:"
    Subject: O=kubeadm:cluster-admins, CN=kubernetes-admin
```

输出显示，`kubectl` 命令将作为 `kubernetes-admin` 用户进行身份验证，该用户是 `kubeadm:cluster-admins` 组的成员。

> [!NOTE] 客户端证书将用户名编码在 CN 属性中，将组成员身份编码在 O 属性中。

请记住，证书由集群的 CA 签名，因此它将通过身份验证。

现在你已经知道，你以 `kubernetes-admin` 用户的身份进行身份验证，该用户是 `kubeadm:cluster-admins` 组的成员。让我们看看集群如何使用 ClusterRoles 和 ClusterRoleBindings 为你提供集群范围的管理员访问权限。

许多 Kubernetes 集群使用名为 `cluster-admin` 的 ClusterRole 来授予集群的管理员权限。这意味着你的 `kubernetes-admin` 用户（`kubeadm:cluster-admins` 组的成员）需要绑定到 `cluster-admin` 这个 ClusterRole。见图 14.3。

*[图 14.3]*

运行以下命令查看 `cluster-admin` ClusterRole 拥有哪些访问权限。

```bash
$ kubectl describe clusterrole cluster-admin
Name:         cluster-admin
Labels:       kubernetes.io/bootstrapping=rbac-defaults
Annotations:  rbac.authorization.kubernetes.io/autoupdate: true
PolicyRule:
  Resources  Non-Resource URLs  Resource Names  Verbs
  ---------  -----------------  --------------  -----
  *.*        []                 []              [*]
             [*]                []              [*]
```

`PolicyRule` 部分显示，此角色有权对所有命名空间中的所有资源执行所有动词。这意味着绑定到此角色的账户可以在任何地方对任何对象执行任何操作。这相当于 root 权限，是一组强大且危险的操作权限。

运行以下命令，查看集群中是否存在引用 `cluster-admin` 角色的 ClusterRoleBindings。

```bash
$ kubectl get clusterrolebindings | grep cluster-admin
NAME                        ROLE
cluster-admin               ClusterRole/cluster-admin
kubeadm:cluster-admins      ClusterRole/cluster-admin
```

它被两个 ClusterRoleBindings 引用，我们感兴趣的是 `kubeadm:cluster-admins` 绑定。希望它会列出我们的 `kubernetes-admin` 用户或我们的用户所属的 `kubeadm:cluster-admins` 组。

运行以下命令来检查它。

```bash
$ kubectl describe clusterrolebindings kubeadm:cluster-admins
Name:         kubeadm:cluster-admins
Labels:       <none>
Annotations:  <none>
Subjects:                        # ----┐ 
  Kind   Name                        | 将主题(用户)绑定到角色
  ----   ----                        | "kubeadm:cluster-admins" 组的成员
  Group  kubeadm:cluster-admins      | 
Role:                                | 
  Kind:  ClusterRole                 | ClusterRole 
  Name:  cluster-admin           # ----┘ 名为 "cluster-admin"
```

很好。它将 `kubeadm:cluster-admins` 组中的主题（用户）绑定到 `cluster-admin` 角色。我们的 `kubernetes-admin` 用户是该组的成员，因此它将在集群上获得完全的管理员权限。

总结一下，如图 14.4 所示，Docker Desktop 配置你的 kubeconfig 文件，其中包含一个客户端证书，标识一个名为 `kubernetes-admin` 的用户，该用户是 `kubeadm:cluster-admins` 组的成员。证书由集群的 CA 签名，因此它将通过身份验证。Docker Desktop Kubernetes 集群有一个名为 `kubeadm:cluster-admins` 的 ClusterRoleBinding，它将经过身份验证的 `kubeadm:cluster-admins` 组成员的绑定到名为 `cluster-admin` 的 ClusterRole。这个 `cluster-admin` ClusterRole 授予对所有命名空间中所有对象的管理员权限。

*[图 14.4 - 映射 kubectl 用户到集群管理员]*

## 总结授权

授权确保经过身份验证的用户被允许执行操作。RBAC 是一个流行的 Kubernetes 授权模块，它基于默认拒绝模型实现最小权限访问，除非你创建允许某些操作的规则，否则默认拒绝所有操作。

Kubernetes RBAC 使用 Roles 和 ClusterRoles 授予权限，并使用 RoleBindings 和 ClusterRoleBindings 将这些权限绑定到用户。

一旦请求通过身份验证和授权，它将进入准入控制。

## 准入控制

准入控制（Admission Control）在成功的身份验证和授权之后立即运行，且完全涉及策略。Kubernetes 支持两种类型的准入控制器：

- **变更（Mutating）**
- **验证（Validating）**

名称已经说明了很多。变更控制器检查合规性并可修改请求，而验证控制器检查合规性但不能修改请求。Kubernetes 总是先运行变更控制器，并且两种类型仅适用于试图修改集群的请求。读请求不受准入控制检查。

举个例子：你可能有一个生产集群，其策略是所有新建和更新的对象必须带有 `env=prod` 标签。变更控制器可以检查新对象和更新对象是否存在该标签，如果不存在则添加它。然而，验证控制器只能在该标签不存在时拒绝请求。

在 Docker Desktop 集群上运行以下命令，显示 API 服务器配置为使用 `NodeRestriction` 准入控制器。

```bash
$ kubectl describe pod kube-apiserver-desktop-control-plane  \
  --namespace kube-system | grep admission
--enable-admission-plugins=NodeRestriction
```

大多数实际集群会运行更多准入控制器。例如，`AlwaysPullImages` 变更准入控制器将所有新 Pod 的 `spec.containers.imagePullPolicy` 设置为 `Always`。这强制所有节点上的容器运行时从配置的注册表拉取所有镜像，防止 Pod 使用本地缓存的镜像。它要求所有节点拥有有效的凭据来拉取镜像。

如果任何准入控制器拒绝请求，该请求将立即被拒绝，而不会检查其他准入控制器。这意味着所有准入控制器都必须批准请求，然后才能集群上执行。

如前所述，存在许多准入控制器，它们在实际生产集群中非常重要。

## 章节总结

在本章中，你学习了所有对 API 服务器的请求都包含凭据，并且必须通过身份验证、授权和准入控制检查。客户端与 API 服务器之间的连接也通过 TLS 进行保护。

身份验证层验证请求的身份，大多数集群支持客户端证书。然而，生产集群应使用企业级的身份和访问管理（IAM）解决方案。