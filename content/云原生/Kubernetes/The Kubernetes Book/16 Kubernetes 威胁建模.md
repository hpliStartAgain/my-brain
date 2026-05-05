# 16：Kubernetes 威胁建模

安全性比以往任何时候都更加重要，Kubernetes 也不例外。幸运的是，你可以采取很多措施来保护 Kubernetes，下一章你将看到一些方法。但在那之前，最好先对常见威胁进行建模。

## 威胁建模

威胁建模是识别漏洞的过程，以便你能采取措施来防范和缓解这些漏洞。本章介绍流行的 STRIDE 模型，并展示如何将其应用于 Kubernetes。

STRIDE 定义了六种潜在威胁类别：

- **欺骗（Spoofing）**
- **篡改（Tampering）**
- **抵赖（Repudiation）**
- **信息泄露（Information disclosure）**
- **拒绝服务（Denial of service）**
- **权限提升（Elevation of privilege）**

该模型虽然不错，并提供了结构化的评估方式，但没有任何模型能保证覆盖所有威胁。

在本章剩余部分，我们将逐一探讨这六种威胁类别。针对每种类别，我们会给出简要描述，然后分析其在 Kubernetes 中的一些表现形式。本章并非试图涵盖所有内容，目标是为你提供思路并助你起步。

---

## 欺骗（Spoofing）

欺骗是指伪装成他人以获取额外权限的行为。

让我们看看 Kubernetes 如何防范不同类型的欺骗。

### 保护与 API 服务器的通信安全

Kubernetes 由许多协同工作的小组件组成。这些组件包括 API 服务器、控制器管理器、调度器、集群存储等，还包括节点组件（如 kubelet 和容器运行时）。每个组件都有自己的权限，使其能够与集群交互并修改集群。即使 Kubernetes 实现了最小权限模型，伪造其中任何一个组件的身份都可能引发问题。

如果你阅读过 [[RBAC 与 API 安全]] 章节，就会知道 Kubernetes 要求所有组件通过密码学签名的证书（[[mTLS]]）进行身份验证。这非常好，并且 Kubernetes 通过自动轮换证书使其变得简单。然而，你必须考虑以下两点：

1. 典型的 Kubernetes 安装会自生成一个自签名证书颁发机构（CA），用于为所有集群组件颁发证书。虽然这比没有好，但在生产环境中仅凭这一点还不够。
2. 双向 TLS（mTLS）的安全性取决于颁发证书的 CA。如果 CA 被攻破，整个 mTLS 层将形同虚设。因此，**确保 CA 的安全至关重要！**

一个良好实践是确保由内部 Kubernetes CA 颁发的证书仅用于 Kubernetes 集群内部，并仅受信任。这需要仔细审批证书签名请求，同时确保 Kubernetes CA 不会被添加为集群外任何系统的受信任 CA。

如之前的章节所述，所有对 API 服务器的内部和外部请求都要经过身份验证和授权检查。因此，API 服务器需要一种方式来认证（信任）内部和外部源。一种好方法是使用两个受信任的密钥对：

- 一个用于认证内部系统
- 另一个用于认证外部系统

在这种模型下，你可以使用集群的自签名 CA 为内部系统颁发密钥，然后配置 Kubernetes 信任一个或多个受信任的第三方 CA 用于外部系统。

### 保护 Pod 通信安全

除了伪造对集群的访问，还存在伪造应用间通信的威胁。在 Kubernetes 中，这可能表现为一个 Pod 冒充另一个 Pod。幸运的是，Pod 可以携带证书来验证其身份。

每个 Pod 都有一个关联的 [[ServiceAccount]]，用于为 Pod 提供身份。这是通过自动将 ServiceAccount 令牌以 Secret 形式挂载到每个 Pod 中实现的。需要注意两点：

1. ServiceAccount 令牌允许访问 API 服务器。
2. 大多数 Pod 可能并不需要访问 API 服务器。

基于这两点，你应该为不需要与 API 服务器通信的 Pod 将 `automountServiceAccountToken` 设置为 `false`。以下 Pod 清单展示了如何实现这一点。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: service-account-example-pod
spec:
  serviceAccountName: some-service-account
  automountServiceAccountToken: false       # <-- 这一行
  <Snip>
```

如果 Pod 确实需要与 API 服务器通信，以下非默认配置值得探索：

- `expirationSeconds`
- `audience`

这些配置允许你强制设置令牌过期时间，并限制其可用的实体。以下示例（灵感来自官方 Kubernetes 文档）将过期时间设为一小时，并在投射卷中将其限制为 `vault` 受众。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx
spec:
  containers:
  - image: nginx
    name: nginx
    volumeMounts:
    - mountPath: /var/run/secrets/tokens
      name: vault-token
  serviceAccountName: my-pod
  volumes:
  - name: vault-token
    projected:
      sources:
      - serviceAccountToken:
          path: vault-token
          expirationSeconds: 3600     # <-- 这一行
          audience: vault             # <-- 以及这一行
```

---

## 篡改（Tampering）

篡改是指以恶意方式更改某物，从而引发以下情况：

- **拒绝服务**：篡改资源使其无法使用。
- **权限提升**：篡改资源以获取额外权限。

篡改往往难以避免，因此常见的应对措施是让篡改行为显而易见。一个非 Kubernetes 的常见例子是药品包装——大多数非处方药都带有防篡改密封，使得产品是否被篡改一目了然。

### 篡改 Kubernetes 组件

篡改以下任何 Kubernetes 组件都可能引发问题：

- [[etcd]]
- API 服务器、控制器管理器、调度器、etcd 和 kubelet 的配置文件
- 容器运行时二进制文件
- 容器镜像
- Kubernetes 二进制文件

一般来说，篡改可能发生在传输中或静态存储时。传输中指数据在网络传输过程中，而静态存储指存储在内存或磁盘上的数据。

[[TLS]] 是防范传输中篡改的绝佳工具，因为它提供了内置的完整性保证，能在数据被篡改时发出警告。

以下建议也有助于防止 Kubernetes 中静态数据被篡改：

- 限制对运行 Kubernetes 组件（尤其是控制平面组件）的服务器的访问
- 限制对存储 Kubernetes 配置文件的仓库的访问
- 仅通过 SSH 执行远程引导（请务必保管好你的 SSH 密钥）
- 始终对下载内容运行 SHA-2 校验和
- 限制对镜像仓库及相关仓库的访问

这并非详尽列表，但实施这些措施将显著降低静态数据被篡改的风险。

除上述列表外，良好的生产实践还包括为重要的二进制文件和配置文件配置审计和告警。如果配置和监控得当，这些措施有助于检测潜在的篡改攻击。

以下示例使用常见的 Linux 审计守护进程来审计对 `docker` 二进制文件的访问，并审计更改该二进制文件属性（文件属性）的尝试。

```bash
$ auditctl -w /usr/bin/docker -p wxa -k audit-docker
```

我们稍后将在本章中再次引用此示例。

### 篡改在 Kubernetes 上运行的应用程序

恶意行为者也会针对应用组件以及基础设施组件。

防止运行中的 Pod 被篡改的一个好方法是将其文件系统设置为只读。这保证了文件系统的不可变性，你可以通过 Pod 清单文件中的 `securityContext` 部分进行配置。

你可以将容器的根文件系统设置为只读，方法是将 `readOnlyRootFilesystem` 属性设为 `true`。对于其他容器文件系统，可以通过 `allowedHostPaths` 属性实现相同效果。

以下 YAML 展示了如何在 Pod 清单中配置这两项设置。在示例中，`allowedHostPaths` 部分确保挂载在 `/test` 下的所有内容均为只读。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: readonly-test
spec:
  securityContext:
    readOnlyRootFilesystem: true     # <-- 只读根文件系统
    allowedHostPaths:                # <-- 使此挂载点下的
      - pathPrefix: "/test"          # <-- 所有内容
        readOnly: true               # <-- 只读 (R/O)
<Snip>
```

---

## 抵赖（Repudiation）

在非常高的层面上，抵赖制造了对某事的怀疑。不可抵赖性则提供了关于某事的证明。在信息安全背景下，不可抵赖性用于证明特定个体执行了特定操作。

深入一点，不可抵赖性包括证明以下内容的能力：

- 发生了什么
- 何时发生
- 谁造成的
- 在哪里发生
- 为什么发生
- 如何发生

回答最后两个问题通常最为困难，通常需要在一段时间内关联多个事件。

审计 Kubernetes API 服务器事件有助于回答这些问题。以下是 API 服务器审计事件的一个示例（你可能需要在你的 API 服务器上启用审计功能）。

```json
{
  "kind":"Event",
  "apiVersion":"audit.k8s.io/v1",
  "metadata":{ "creationTimestamp":"2022-11-11T10:10:00Z" },
  "level":"Metadata",
  "timestamp":"2022-11-11T10:10:00Z",
  "auditID":"7e0cbccf-8d8a-4f5f-aefb-60b8af2d2ad5",
  "stage":"RequestReceived",
  "requestURI":"/api/v1/namespaces/default/persistentvolumeclaims",
  "verb":"list",
  "user": {
    "username":"fname.lname@example.com",
    "groups":[ "system:authenticated" ]
  },
  "sourceIPs":[ "123.45.67.123" ],
  "objectRef": {
    "resource":"persistentvolumeclaims",
    "namespace":"default",
    "apiVersion":"v1"
  },
  "requestReceivedTimestamp":"2022-11-11T10:10:00.123456Z",
  "stageTimestamp":"2022-11-11T10:10:00.123456Z"
}
```

API 服务器并非唯一需要为不可抵赖性进行审计的组件。至少，你应该收集容器运行时、kubelet 以及集群上运行的应用程序的审计日志。你还应审计非 Kubernetes 基础设施，例如网络防火墙。

一旦开始审计多个组件，就需要一个集中位置来存储和关联事件。常见方法是通过 DaemonSet 在所有节点上部署一个代理程序。该代理收集日志（运行时、kubelet、应用程序等），并将其发送到安全的中央存储位置。

如果你这样做，集中式日志存储必须安全。否则，你将无法信任日志，其内容也可能被抵赖。

为了提供与二进制文件和配置文件篡改相关的不可抵赖性，使用审计守护进程监控 Kubernetes 控制平面节点和工作节点上某些文件和目录的写入操作可能很有用。例如，本章前面展示了一种启用对 `docker` 二进制文件更改审计的方法。启用后，使用 `docker run` 命令启动新容器将生成如下事件：

```
type=SYSCALL msg=audit(1234567890.123:12345): arch=abc123 syscall=
exit=0 a0=12345678abca1=0 a2=abc12345678 a3=a items=1 ppid=1234 p
uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 
exe="/usr/bin/docker" subj=system_u:object_r:container_runtime_ex
key="audit-docker" type=CWD msg=audit(1234567890.123:12345):  cwd=
type=PATH msg=audit(1234567890.123:12345): item=0 name="/usr/bin/
 inode=123456 dev=fd:00 mode=0100600 ouid=0 ogid=0 rdev=00:00...
```

当与 Kubernetes 的审计功能结合并关联时，这样的审计日志能够创建全面且可信的图像，从而无法被抵赖。

---

## 信息泄露（Information Disclosure）

信息泄露是指敏感数据被泄露。常见示例包括被攻击的数据存储和无意中暴露敏感数据的 API。

### 保护集群数据

（注：根据用户提供的文本，此处原文为“Protecting cluster data”后即结束，下一部分内容在下一段落。由于用户只提供了 Part 1/5，当前部分在此处截断。但为保持完整，我们将处理到此处。后续内容应继续在下一部分中呈现。）

> [!important] 注意：本章第一部分在此结束。后续内容将涵盖信息泄露的更多细节以及拒绝服务和权限提升威胁。请继续阅读下一部分。

# 16: Kubernetes 威胁建模

## 信息泄露

信息泄露是指敏感数据被泄露。常见的例子包括被黑客入侵的数据存储以及无意中暴露敏感数据的API。

### 保护集群数据

Kubernete集群的整个配置都存储在集群存储（通常是etcd）中。这包括网络和存储配置、密码、集群CA等。这使得集群存储成为信息泄露攻击的主要目标。

至少，您应该限制并审计对托管集群存储的节点的访问。正如您将在下一段中看到的，获得对集群节点的访问权限可能允许登录用户绕过某些安全层。

Kubernete 1.7引入了Secret加密，但默认未启用。即使这成为默认设置，数据加密密钥（DEK）也存储在与Secret相同的节点上！这意味着获得对节点的访问权限可以让您绕过加密。这在托管集群存储（etcd节点）的节点上尤其令人担忧。

Kubernete 1.11随附了密钥管理服务（KMS v1）作为测试版功能，允许您将密钥加密密钥（KEK）存储在Kubernete集群之外。KEK用于加密和解密数据加密密钥（DEK），应妥善保管。我们称这种方法为“信封加密”。

自那以后，我们完全重新设计了KMS，并用KMS v2取代了旧的KMS v1，后者自Kubernete v1.29以来已全面可用（GA）。这是一次彻底的重新设计，具有许多改进，包括：

- 每次加密生成一个新的DEK——每次写操作都会生成一个新的DEK，并使用KEK进行静态加密
- KMS v2插件的缓存大小仅受底层控制平面节点资源的限制。这允许将先前的DEK缓存在内存中，以实现更快的加密和解密操作
- 零停机重新加密操作——密钥轮换后的重新加密不再需要API服务器停机或Pod重启

KMS插件在控制平面节点上运行，并通过Unix套接字与API服务器通信。然后，KMS插件连接到外部KMS提供程序，以处理数据加密密钥（DEK）的加密和解密。

所有这些意味着攻击者现在需要同时攻破Kubernete控制平面和外部KMS。仅获取控制平面节点的快照不足以以明文形式读取Secret。因此，您应该认真考虑将KEK存储在硬件安全模块（HSM）或基于云的密钥管理存储（KMS）中。此外，与所有加密事项一样，您应遵循“信任但验证”模型，确保基于KMS v2插件的加密按预期工作，并为KEK丢失或与外部KMS提供程序连接中断等意外情况制定应急计划。

### 保护Pod中的数据

如前所述，Kubernete有一个名为Secret的API资源，它是存储和共享密码等敏感数据的首选方式。例如，访问加密后端数据库的前端容器可以将用于解密数据库的密钥挂载为Secret。这比将解密密钥存储在纯文本文件或环境变量中要好得多。

将数据和配置信息存储在Pod和容器外部的持久卷和ConfigMap中也很常见。如果这些数据已加密，您应将用于解密它们的密钥存储在Secret中。

尽管如此，您必须考虑上一节中关于Secret以及其加密密钥存储方式的注意事项。您不希望辛苦地锁好房子，却把钥匙留在门上。

## 拒绝服务

拒绝服务（DoS）是指使某些东西不可用。DoS攻击有很多类型，但一个众所周知的变体是使系统过载到无法再服务请求的程度。在Kubernete世界中，潜在的攻击可能是使API服务器过载，导致集群操作停滞（即使是内部系统也使用API服务器进行通信）。

让我们看看一些可能成为DoS攻击目标的Kubernete系统，以及一些保护和缓解它们的方法。

### 保护集群资源免受DoS攻击

在多个节点上复制基本服务以实现高可用性（HA）是一项历史悠久的实践。Kubernete也不例外，您应该在生产环境中以HA配置运行多个控制平面节点。这样做可以防止任何单个控制平面节点成为单点故障。对于某些类型的DoS攻击，攻击者可能需要攻击多个控制平面节点才能产生有意义的影响。

您还应该跨可用区复制控制平面节点。这可以防止针对特定可用区网络的DoS攻击使整个控制平面瘫痪。

同样的原则也适用于工作节点。拥有多个工作节点不仅允许调度程序将应用程序分布在多个可用区，还可能使针对任何单个节点或可用区的DoS攻击无效（或效果减弱）。

您还应为以下内容配置适当的限制：

- 内存
- CPU
- 存储

这样的限制有助于防止基本系统资源被耗尽，从而阻止潜在的DoS。

限制Kubernete对象也是一种好的实践。这包括限制特定命名空间中的ReplicaSet、Pod、Service、Secret和ConfigMap等对象的数量。

这是一个示例清单，将`skippy`命名空间中的Pod对象数量限制为100。

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: pod-quota
  namespace: skippy
spec:
  hard:
    pods: "100"
```

另一个功能——`podPidsLimit`——限制Pod可以创建的进程数。

假设一个Pod是fork炸弹攻击的目标，其中恶意进程试图通过创建足够多的进程来消耗所有系统资源。如果您使用`podPidsLimit`配置了Pod以限制Pod可以创建的进程数，您将阻止它耗尽节点资源，并将攻击的影响限制在Pod内。Kubernete通常会在Pod耗尽`podPidsLimit`时重新启动它。

这还可以确保单个Pod不会耗尽节点上所有其他Pod（包括kubelet）的PID范围。但是，设置正确的值需要合理估计每个节点上同时运行的Pod数量，如果没有大致估计，您很容易过度或不足地为每个Pod分配PID。

### 保护API服务器免受DoS攻击

API服务器通过TCP套接字公开一个RESTful接口。这使其成为基于僵尸网络的DoS攻击的目标。

以下措施可能有助于防止或缓解此类攻击：

- 高可用性控制平面节点——跨多个可用区的多个节点上运行API服务器的多个副本
- 基于合理阈值对API服务器请求进行监控和告警
- 使用防火墙等限制API服务器暴露于互联网

除了僵尸网络DoS攻击外，攻击者还可能试图冒充用户或其他控制平面服务以引起过载。幸运的是，Kubernete具有强大的身份验证和授权控制来防止欺骗。然而，即使拥有健壮的RBAC模型，您也必须保护具有高权限的账户的访问。

### 保护集群存储免受DoS攻击

Kubernete将集群配置存储在etcd中。这使得etcd的可用性和安全性至关重要。以下建议有助于实现这一点：

- 配置一个包含3个或5个节点的高可用etcd集群
- 配置对etcd请求的监控和告警
- 在网络层面隔离etcd，以便只有控制平面成员可以与其交互

Kubernete的默认安装将etcd与控制平面的其他部分安装在相同的服务器上。这对于开发和测试来说是可以的。然而，大型生产集群应认真考虑使用专用的etcd集群。这将提供更好的性能和更高的弹性。

在性能方面，etcd是大型Kubernete集群最常见的瓶颈。考虑到这一点，您应该进行测试，以确保其运行的基础设施能够维持大规模性能——性能不佳的etcd可能与遭受持续DoS攻击的etcd集群一样糟糕。运行专用etcd集群还通过保护其免受可能被攻破的其他控制平面部分的影响，提供了额外的弹性。

对etcd的监控和告警应基于合理阈值，一个好的起点是监控etcd日志条目。

### 保护应用程序组件免受DoS攻击

大多数Pod在网络上公开其主要服务，如果没有额外的控制，任何有权访问网络的人都可以对Pod进行DoS攻击。幸运的是，Kubernete提供了Pod资源请求限制，以防止此类攻击耗尽Pod和节点资源。除此之外，以下措施也会有帮助：

- 定义Kubernete网络策略以限制Pod到Pod和Pod到外部的通信
- 对应用程序级别的身份验证使用双向TLS和基于API令牌的身份验证（拒绝任何未经验证的请求）

为了深度防御，您还应该实施应用程序层的授权策略，以实现最小权限原则。

图16.1展示了如何结合这些措施，使攻击者难以成功对应用程序进行DoS攻击。

![图16.1](images/16-1.png)  <!-- 此处为图像占位符，原图显示防御深度组合 -->

> [!INFO] **图16.1** 原图说明了结合网络策略、mTLS、API令牌认证以及应用层授权如何创建多层防御，使攻击者难以成功DoS应用程序。

## 权限提升

权限提升是指获得比授予的更高的权限。其目的是造成损害或获得未授权访问。

让我们看看在Kubernete环境中防止这种情况的几种方法。

### 保护API服务器

Kubernete提供多种授权模式，有助于保护对API服务器的访问。这些包括：

- **基于角色的访问控制（RBAC）**
- **Webhook**
- **节点**

您应该同时运行多个授权器。例如，通常同时使用RBAC和节点授权器。

RBAC模式允许您将API操作限制为用户子集。这些用户可以是普通用户账户或系统服务。其思想是对API服务器的所有请求都必须经过身份验证和授权。身份验证确保请求来自经过验证的用户，而授权确保经过验证的用户可以执行所请求的操作。例如，Mia能否创建Pod？在这个例子中，Mia是用户，create是操作，Pods是资源。身份验证确保确实是Mia在发出请求，授权决定她是否被允许创建Pod。

Webhook模式允许您将授权卸载到外部的基于REST的策略引擎。然而，它需要额外的努力来构建和维护外部引擎。这也使外部引擎成为API服务器每个请求的潜在单点故障。例如，如果外部Webhook系统不可用，您可能无法向API服务器发出任何请求。考虑到这一点，您应该严格审查和实现任何Webhook授权服务。

节点授权完全是为了授权由kubelet（节点）发出的API请求。kubelet向API服务器发出的请求类型显然与普通用户通常发出的请求不同，节点授权器旨在帮助处理这一点。

### 保护Pod

接下来的几个部分将介绍一些有助于降低针对Pod和容器的权限提升攻击风险的技术。我们将讨论以下内容：

- 防止进程以root身份运行
- 删除能力
- 过滤系统调用
- 防止权限提升

在阅读这些部分时，重要的是要记住Pod只是一个或多个容器的执行环境。使用的一些术语会互换地指代Pod和容器，但通常我们指的是容器。

#### 不要以root身份运行进程

root用户是Linux系统上最强大的用户，并且

# 16: Kubernetes 威胁建模

> [!INFO] 上下文说明  
> 本文档选自第 492–537 页，将分析各类安全威胁及应对策略。为保持连续性，内容直接从“总是用户 ID 0（UID 0）”开始。

总是用户 ID 0（UID 0）。这意味着以 root 身份运行应用进程几乎总是一个坏主意，因为它赋予应用进程对容器的完全访问权限。更糟糕的是，容器中的 root 用户有时也能无限制地访问宿主机系统。如果这还不能让你警惕，那就没什么能让你害怕了！

幸运的是，Kubernetes 允许你强制容器进程以非 root 的非特权用户身份运行。

以下 Pod 清单将 Pod 内所有容器配置为以 UID 1000 运行进程。如果 Pod 有多个容器，所有容器进程都将以 UID 1000 运行。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  securityContext:      <<---- 应用于此 Pod 中的所有容器
    runAsUser: 1000     <<---- 非 root 用户
  containers:
  - name: demo
    image: example.io/simple:1.0
```

`runAsUser` 属性属于 `PodSecurityContext`（`spec.securityContext`）下的众多设置之一。

两个或更多 Pod 可能被配置为相同的 `runAsUser` UID。此时，来自不同 Pod 的容器将以相同的安全上下文运行，并可能拥有对相同资源的访问权限。如果它们是同一 Pod 的副本，这或许没问题。然而，如果它们不是副本，则很可能引发问题。例如，两个不同的容器对同一拥有读写权限的卷进行写入，可能导致数据损坏（两者同时写入同一数据集却不协调写入操作）。共享的安全上下文还增加了被攻破的容器篡改其不应有权限访问的数据集的可能性。

考虑到这一点，可以在容器级别而不是 Pod 级别使用 `securityContext.runAsUser` 属性：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  securityContext:      <<---- 应用于此 Pod 中的所有容器
    runAsUser: 1000     <<---- 非 root 用户
  containers:
  - name: demo
    image: example.io/simple:1.0
    securityContext:
      runAsUser: 2000   <<---- 覆盖 Pod 级设置
```

此示例在 Pod 级设置 UID 为 1000，但在容器级覆盖为 2000，因此 `demo` 容器中的进程以 UID 2000 运行。除非另行指定，Pod 中所有其他容器将使用 UID 1000。

另外两种可能有助于解决多个 Pod 和容器使用相同 UID 问题的方法包括：

- **用户命名空间（User namespaces）**  
  用户命名空间是一项 Linux 内核技术，允许进程在容器内以 root 身份运行，但在容器外以不同用户身份运行。例如，进程在容器内以 UID 0（root 用户）运行，但在宿主机上被映射为 UID 1000。对于需要在容器内以 root 身份运行的进程，这可能是一个很好的解决方案。但你需要检查你的 Kubernetes 版本和容器运行时是否完全支持它。

- **维护 UID 使用映射**  
  维护一个 UID 使用情况的映射表，以避免冲突。

## 能力（Capability）丢弃

虽然大多数应用程序不需要完整的 root 能力集，但它们通常比典型的非 root 用户需要更多能力。

我们需要一种方式，只为进程授予其运行所必需的精确权限集。能力（capabilities）应运而生。

快速补充一点背景知识。

我们已经说过 root 用户是 Linux 系统上最强大的用户。然而，它的权力是由许多小的特权组合而成的，我们称之为能力。例如，`SYS_TIME` 能力允许用户设置系统时钟，而 `NET_ADMIN` 能力允许用户执行网络相关操作，如修改本地路由表和配置本地接口。root 用户拥有每一项能力，因此极其强大。

拥有模块化的能力集让你在授予权限时可以极其精细。不是采用全有或全无（root 与非 root）的方式，而是可以为进程授予所需的确切能力集。

目前有超过 30 种能力，选择正确的组合可能令人望而生畏。考虑到这一点，许多容器运行时实现了一套合理的默认能力集，允许大多数进程运行，同时不把所有大门都敞开。虽然这类默认设置聊胜于无，但在生产环境中通常还不够好。

找到应用程序所需最小能力集的常用方法是在测试环境中运行它，同时丢弃所有能力。这会导致应用程序失败并记录缺少权限的日志消息。你将那些权限映射到能力，添加到应用程序的 Pod spec 中，然后再次运行应用程序。重复此过程，直到应用程序以最小能力集正确运行。

虽然这很好，但有一些事项需要考虑。

首先，你必须对每个应用程序进行广泛的测试。你最不希望发生的事情就是在生产中出现测试环境中未曾预料到的边缘情况。这种情况可能导致应用程序在生产中崩溃！

其次，每次应用程序修订都需要对能力集进行同样的广泛测试。

考虑到这些，至关重要的是，你必须拥有能够处理所有这些情况的测试流程和生产发布流程。

默认情况下，Kubernetes 实现你所选容器运行时的默认能力集（例如 containerd）。但是，你可以在容器的 `securityContext` 字段中覆盖它。

以下 Pod 清单展示了如何向容器添加 `NET_ADMIN` 和 `CHOWN` 能力。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: capability-test
spec:
  containers:
  - name: demo
    image: example.io/simple:1.0
    securityContext:
      capabilities:
        add: ["NET_ADMIN", "CHOWN"]
```

## 过滤系统调用（Seccomp）

Seccomp（安全计算模式）的概念类似于能力，但通过过滤系统调用（syscalls）而非能力来工作。

应用程序请求 Linux 内核执行操作的方式是发出系统调用。seccomp 允许你控制特定容器可以向宿主机内核发出哪些系统调用。与能力一样，你应该实施最小权限模型，即容器只能发出其运行所需的系统调用。

Seccomp 在 Kubernetes 1.19 中达到 GA 状态，你可以根据以下 seccomp 配置文件以不同方式使用它：

1. **非阻塞（Non-blocking）**：允许 Pod 运行，但将每次系统调用记录到审计日志中，你可以使用该日志创建自定义配置文件。思路是在开发/测试环境中广泛测试你的应用 Pod。之后，你将得到一个日志文件，其中列出了 Pod 运行所需的每一个系统调用。然后你利用该日志创建只允许那些系统调用的自定义配置文件（最小权限）。

2. **阻塞（Blocking）**：阻止所有系统调用。极其安全，但会使 Pod 无法做任何有用的事情。

3. **运行时默认（Runtime Default）**：强制 Pod 使用其容器运行时定义的 seccomp 配置文件。如果你还需要创建自定义配置文件，这是一个常见的起点。与容器运行时一起提供的配置文件在设计上兼顾了可用性和安全性。它们也经过了充分测试。

4. **自定义（Custom）**：只允许应用程序运行所需的系统调用。其他一切都被阻止。常见做法是在开发/测试环境中使用非阻塞配置文件广泛测试你的应用程序，该配置将记录所有系统调用到审计日志。然后你利用此日志识别应用程序的系统调用并构建自定义配置文件。此方法的风险在于你的应用在测试中可能遗漏一些边缘情况。如果发生这种情况，当应用程序遇到未在测试中捕获的边缘情况并使用相应系统调用时，可能会在生产中失败。

自定义配置文件遵循最小权限模型，从安全角度看是推荐的方法。

## 强制访问控制（MAC）

Seccomp 过滤器和能力是帮助我们以受限权限运行进程的强大工具。然而，我们还可以通过强制访问控制（MAC）系统更进一步，例如 AppArmor 和 SELinux。这些是仅适用于 Linux 的技术，在 Kubernetes 节点级别进行配置，然后通过 Pod 安全上下文（Pod Security Contexts）应用于 Pod。

这两项技术都控制进程如何与其他系统资源交互，并且配置起来可能很困难。不过，有工具可以通过读取审计日志并生成配置文件来简化配置，你可以对这些配置文件进行测试和调整。但是，一旦启用，它们是强制性的。这与自愿性的 seccomp 和能力不同。

某些容器运行时对所有容器应用默认的 SELinux 配置文件。但你可以通过 Pod 的 `securityContext` 字段覆盖它。

不过需要提醒的是。AppArmor 和 SELinux 是强大的强制实施点，如果配置不当，可能导致应用程序无法正常工作。因此，在实施它们之前，你应该进行广泛的测试。

## 防止容器特权提升

在 Linux 中创建新进程的唯一方式是一个进程克隆自己，然后将新指令加载到新进程上。我们这里做了过度简化，但原始进程称为父进程，副本称为子进程。

默认情况下，Linux 允许子进程比其父进程拥有更多特权。这通常是个坏主意。事实上，你通常希望子进程拥有与其父进程相同或更少的特权。对于容器尤其如此，因为容器的安全配置是针对其初始配置定义的，而不是针对可能提升后的特权。

幸运的是，可以通过单个容器的 `securityContext` 属性防止特权提升，如下所示。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: demo
spec:
  containers:
  - name: demo
    image: example.io/simple:1.0
    securityContext:
      allowPrivilegeEscalation: false    <<---- 这行
```

## 使用 PSS 和 PSA 标准化 Pod 安全

现代 Kubernetes 集群实现了两种技术来帮助强制实施 Pod 安全设置：

- **Pod 安全标准（Pod Security Standards, PSS）**：指定所需 Pod 安全设置的策略。
- **Pod 安全准入（Pod Security Admission, PSA）**：在创建 Pod 时强制实施一个或多个 PSS 策略。

两者协同工作，实现有效的集中式 Pod 安全强制——你选择应用哪些 PSS 策略，然后 PSA 负责强制实施。

### Pod 安全标准（PSS）

每个 Kubernetes 集群都获得以下三个由社区维护并保持更新的 PSS 策略：

- **Privileged（特权）**：完全开放的允许所有策略。
- **Baseline（基线）**：实现合理的默认设置。比特权策略更安全，但比 Restricted（严格）策略安全性低。
- **Restricted（严格）**：黄金标准，实现了当前 Pod 安全最佳实践。但要提醒的是，它限制性极强，许多 Pod 无法满足其严格要求。

截至目前，你无法调整或修改这些策略中的任何一个，也无法导入其他策略或创建自己的策略。

### Pod 安全准入（PSA）

Pod 安全准入（PSA）强制实施你期望的 PSS 策略。它在命名空间级别工作，并作为验证准入控制器实现。

PSA 提供三种强制模式：

- **Warn（警告）**：允许违反策略的 Pod 被创建，但向用户显示警告。
- **Audit（审计）**：允许违反策略的 Pod 被创建，但记录审计事件。
- **Enforce（强制）**：如果 Pod 违反策略，则拒绝该 Pod。

一个好的实践是为每个命名空间至少配置 `baseline` 策略，并将其设置为 `warn` 或 `audit`。这允许你开始收集数据，了解哪些 Pod 未通过策略以及原因。下一步是强制实施 `baseline` 策略，并开始对 `restricted` 策略启用警告和审计。

任何没有 Pod 安全配置的命名空间都是安全配置中的缺口，你应该为其附加一个策略。

# 16: Kubernetes 威胁建模

尽快给所有没有 Pod 安全配置的命名空间附加策略，即使只是警告和审计。将以下标签应用到命名空间将对其应用 `baseline` 策略。它将允许违反策略的 Pod 运行，但会生成用户可见的警告。

```text
pod-security.kubernetes.io/warn: baseline
```

标签格式为 `<prefix>/<mode>: <policy>`，选项如下：

- 前缀始终为 `pod-security.kubernetes.io`
- 模式为 `warn`、`audit` 或 `enforce`
- 策略始终为 `privileged`、`baseline` 或 `restricted`

> [!INFO]
> Pod 安全准入（PSA）作为验证性准入控制器运行，因此无法修改 Pod，也无法对运行中的 Pod 产生任何影响。

## PSA 示例

让我们通过一些示例来展示 Pod 安全准入的实际操作。你将完成以下步骤：

1. 创建一个名为 `psa-test` 的命名空间
2. 添加一个标签以强制实施 `baseline` PSS 策略
3. 尝试部署一个运行特权容器的 Pod（将会失败）
4. 修改 Pod 使其符合 PSS 策略并重新部署（将会成功）
5. 测试切换到 `restricted` 策略的潜在影响
6. 切换到 `restricted` 策略
7. 测试对已有 Pod 的影响

如果你希望跟着操作，你需要 `kubectl`、一个 Kubernetes 集群，以及本书 GitHub 仓库的本地克隆。如有需要，请参阅第 3 章。

你可以使用以下命令克隆本书的 GitHub 仓库并切换到 2025 分支。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
<Snip>
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

务必在 `psa` 目录下运行以下命令。

运行以下命令创建一个名为 `psa-test` 的新命名空间。

```bash
$ kubectl create ns psa-test
```

向新命名空间添加标签 `pod-security.kubernetes.io/enforce=baseline`。这将阻止任何违反 `baseline` PSS 策略的新 Pod 被创建。

```bash
$ kubectl label --overwrite ns psa-test \
    pod-security.kubernetes.io/enforce=baseline
```

验证标签已正确添加。

```bash
$ kubectl describe ns psa-test
Name:         psa-test
Labels:       kubernetes.io/metadata.name=psa-test
              pod-security.kubernetes.io/enforce=baseline   <<---
Annotations:  <none>
Status:       Active
```

命名空间已创建，`baseline` 策略已强制实施。

以下 YAML 来自 `psa-pod.yml` 文件，定义了一个违反 `baseline` 策略的特权容器。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: psa-pod
  namespace: psa-test     <<---- 将其部署到新的 psa-test 命名空间
spec:
  containers:
  - name: psa-ctr
    image: nginx
    securityContext:
      privileged: true    <<---- 违反了 baseline 策略
```

使用以下命令部署它。

```bash
$ kubectl apply -f psa-pod.yml
Error from server (Forbidden): error when creating "psa-pod.yml": 
forbidden: violates PodSecurity "baseline:latest": privileged (container "psa-ctr") must not set securityContext.privileged=true
```

输出显示 Pod 创建被禁止，并列出了原因。

编辑 `psa-pod.yml`，将容器的 `securityContext.privileged` 改为 `false` 并保存更改。

```yaml
apiVersion: v1
kind: Pod
<Snip>
spec:
  containers:
  - name: psa-ctr
    image: nginx
    securityContext:
      privileged: false        <<---- 从 true 改为 false
```

现在尝试部署 Pod。

```bash
$ kubectl apply -f psa-pod.yml
pod/psa-pod created
```

它通过了 `baseline` 策略的要求，成功部署。

你可以使用 `--dry-run=server` 标志来测试对命名空间应用 PSS 策略的影响。使用此标志不会真正应用策略。

```bash
$ kubectl label --dry-run=server --overwrite ns psa-test \
    pod-security.kubernetes.io/enforce=restricted
Warning: existing pods in namespace "psa-test" violate the new PodSecurity level "restricted:latest"
Warning: psa-pod: allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile
```

输出显示 `psa-pod` Pod 未能满足四个策略要求：

- `allowPrivilegeEscalation` 属性未设置为 `false`
- 它正在运行不受限制的能力（capabilities）
- `runAsNonRoot` 字段未设置为 `true`
- 未能通过 `seccompProfile` 测试

继续将策略应用到命名空间，并查看它是否影响已经运行的 `psa-pod`。

```bash
$ kubectl label --overwrite ns psa-test \
    pod-security.kubernetes.io/enforce=restricted
Warning: existing pods in namespace "psa-test" violate the new PodSecurity level "restricted:latest"
Warning: psa-pod: allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile
namespace/psa-test labeled
```

```bash
$ kubectl get pods --namespace psa-test
```

```markdown
# 16: Kubernetes 威胁建模

## Pod Security Admission 的实际运用

执行以下命令,为 `psa-test` 命名空间设置 `restricted` 策略:

```bash
$ kubectl label --overwrite ns psa-test pod-security.kubernetes.io/enforce=restricted
```

系统会输出类似如下的警告信息(但不会终止已有 Pod):

```bash
Warning: existing pods in namespace "psa-test" violate the new PodSecurity "restricted:latest"
Warning: psa-pod: allowPrivilegeEscalation != false, unrestricted runAsNonRoot != true, seccompProfile
namespace/psa-test labeled
```

查看 Pod 状态,确认其仍在运行:

```bash
$ kubectl get pods --namespace psa-test
```

```
NAME      READY   STATUS    RESTARTS   AGE
psa-pod   1/1     Running   0          3m9s
```

> [!NOTE] 为什么已有 Pod 未被终止?
> PSA 是一个准入控制器(admission controller),因此它只作用于 Pod 的**创建**和**修改**操作,对已存在的 Pod 不会自动生效.

## 配置多策略与多模式

可以为单个命名空间配置多种策略和模式,这是常见的做法.以下示例为 `psa-test` 命名空间应用了三个标签:

- **强制执行** `baseline` 策略
- **警告**(warn)和**审计**(audit)针对 `restricted` 策略

这条命令同时执行了基线策略的落地,并提前为 `restricted` 策略做准备:

```bash
$ kubectl label --overwrite ns psa-test \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/audit=restricted
```

使用 `kubectl describe ns psa-test` 命令可以确认标签是否已成功应用.

## Pod Security Admission 的替代方案

如前所述,[[Pod Security Standards (PSS)]] 和 [[Pod Security Admission (PSA)]] 存在局限,包括:
- 仅作为验证性准入控制器实现
- 无法修改、导入或创建自定义策略

如果需要超越 PSS/PSA 的能力,可以考虑以下第三方解决方案:

- [[OPA Gatekeeper]]
- [[Kubewarden]]
- [[Kyverno]]
- 还有其他方案(如其他自定义准入控制器).

## 迈向更安全的 Kubernetes

以下示例展示了 Kubernetes 在安全方面持续改进的历程:

- 从 Kubernetes v1.26 开始,所有用于构建 Kubernetes 集群的二进制工件和容器镜像都经过**加密签名**.
- Kubernetes 社区维护了一个官方漏洞列表(CVEs)信息源.自 v1.27 起,提供自动刷新的 JSON 和 RSS feed.
- 从 Kubernetes 1.27 开始,所有容器都继承容器运行时提供的默认 **seccomp** 配置,该配置实现了合理的安全默认值.需要在每个 kubelet 上启用 `--seccomp-default` 参数.
- 许多云提供商提供机密计算服务(如机密虚拟机、机密容器),Kubernetes 可以利用这些服务通过内存加密来保护容器工作负载的**使用中数据**,某些托管 Kubernetes 服务甚至直接将其作为特性提供.
- 2023 年 4 月发布了基于 Kubernetes 1.24 的最新第三方安全审计报告(继 2019 年首次审计后的第二次报告).这些审计是识别 Kubernetes 环境潜在威胁和缓解措施的有力工具.
- 最后,[云原生安全白皮书](https://www.cncf.io/reports/cloud-native-security-whitepaper/)值得一读,它能帮助你从更整体的视角审视云原生环境(如 Kubernetes)的安全防护.

> [!TIP] 防御深度是关键
> 一个威胁往往可以引发另一个威胁,单个威胁通常有多种缓解方法.始终贯彻**纵深防御**(defense in depth)策略至关重要.

## 章节总结

本章介绍了如何使用 [[STRIDE 模型]] 对 Kubernetes 进行威胁建模.我们逐一分析了六大威胁类别,并探讨了预防和缓解方法.

- 一个威胁可能导向另一个威胁,多种方法可以应对同一威胁.
- **防御深度** 是核心战术.
- 章节最后讨论了 [[Pod Security Admission]] 是实施 Pod 安全默认值的首选方式.

在下一章中,你将了解在生产环境中运行 Kubernetes 的一些**最佳实践和教训**.

---

**图片上下文:**  
[Image 3033 on Page 513] — 该图展示了多策略/多模式配置的示意图(原文中未提供具体图形,此处保留引用).
```