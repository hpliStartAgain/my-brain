# 13: StatefulSet

在本章中，你将学习如何使用 StatefulSet 在 Kubernetes 上部署和管理有状态应用。

就本章而言，我们将有状态应用定义为：创建并保存有价值数据的应用。例如，数据库、键值存储，以及保存客户端会话数据以用于未来会话的应用。

本章安排如下：

- StatefulSet 理论
- StatefulSet 实操

理论部分介绍 StatefulSet 的工作原理及其对有状态应用的价值。但如果你一开始未能完全理解，不必担心，你将在实操部分再次接触所有内容。

## StatefulSet 理论

将 StatefulSet 与 Deployment 进行对比会非常有帮助。两者都是 Kubernetes API 资源，遵循标准的 Kubernetes 控制器架构——通过控制循环使**观测状态**与**期望状态**达成一致。两者都管理 Pod，并支持自愈、扩缩、滚动更新等功能。

然而，StatefulSet 提供了以下三个 Deployment **不**具备的特性：

1.  **可预测且持久的 Pod 名称和 DNS 名称**
2.  **可预测且持久的卷绑定**
3.  **可预测的启动和关闭顺序**

第 1 点和第 2 点构成了 Pod 的**状态**，我们有时将其称为 Pod 的**粘性 ID**。StatefulSet 甚至可以确保 Pod 名称和卷绑定在发生故障、扩缩操作以及其他调度事件时保持不变。

举个简单的例子：StatefulSet 的 Pod 如果发生故障，会被替换为新的 Pod，这些新 Pod 具有相同的 Pod 名称、相同的 DNS 主机名，并连接到相同的卷。即使 Kubernetes 将替换 Pod 调度到不同的集群节点上，情况也是如此。如果通过缩容操作终止了 Pod，然后通过扩容操作重新创建，它们也会获得相同的名称和卷。所有这些特性使 StatefulSet 非常适合需要唯一且可靠 Pod 的应用。

以下 YAML 定义了一个简单的 StatefulSet `tkb-sts`，包含三个副本，运行 `mongo:latest` 镜像。你将此 YAML 提交到 API 服务器，它会持久化到集群存储中，调度器将副本分配到工作节点，然后 StatefulSet 控制器确保观测状态与期望状态一致。

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: tkb-sts
spec:
  selector:
    matchLabels:
      app: mongo
  serviceName: "tkb-sts"
  replicas: 3
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
      - name: ctr-mongo
        image: mongo:latest
        ...
```

以上是宏观概况。在运行示例之前，让我们更仔细地审视一下。

### StatefulSet Pod 命名

StatefulSet 创建的每个 Pod 都会获得一个**可预测的名称**。事实上，Pod 名称是 StatefulSet 启动、自愈、扩缩、删除 Pod 以及将 Pod 连接到卷的核心。

StatefulSet Pod 名称的格式为：`<StatefulSet名称>-<整数>`。其中整数是一个**基于零的索引序号**。按照前面的 YAML 片段，Kubernetes 会将第一个副本命名为 `tkb-sts-0`，第二个为 `tkb-sts-1`，第三个为 `tkb-sts-2`。

Kubernetes 也会使用 StatefulSet 名称来创建每个副本的 DNS 名称，因此请避免使用会导致 DNS 名称无效的特殊字符。

### 有序创建与删除

StatefulSet 与 Deployment 之间的一个关键区别在于它们创建 Pod 的方式：

- StatefulSet **逐个**创建 Pod，并且等待 Pod 进入 **Running and Ready** 状态后，才开始创建下一个 Pod。
- Deployment 使用 ReplicaSet 控制器**同时**启动所有 Pod，这可能导致竞争条件。

沿用前面的 YAML 示例，StatefulSet 控制器将首先启动 `tkb-sts-0`，等待它处于 **Running and Ready** 状态，然后才启动 `tkb-sts-1`。后续 Pod 也是如此——控制器等待 `tkb-sts-1` 处于 Running and Ready 状态，再启动 `tkb-sts-2`，依此类推。请参见图 13.1。

**图 13.1**

> [!NOTE]
> **Running and Ready** 是一个术语，表示 Pod 中所有容器都在运行，并且 Pod 已准备好处理请求。

相同的启动规则也适用于 StatefulSet 的扩缩操作。例如，从 3 个副本扩展到 5 个副本时，会先启动一个名为 `tkb-sts-3` 的新 Pod，等待其处于 Running and Ready 状态，然后才创建 `tkb-sts-4`。缩容则遵循相同的顺序，但方向相反——控制器会终止索引序号最高的 Pod，等待它完全终止后，再终止下一个最高序号的 Pod。

**保证 Pod 缩容的顺序**，并且知道 Kubernetes 永远不会并行终止它们，对于有状态应用可能至关重要。例如，如果多个副本同时终止，集群化应用可能会丢失数据。

最后值得注意的是，StatefulSet 控制器**自行**执行自愈和扩缩操作。这从架构上与 Deployment 不同，Deployment 依赖 ReplicaSet 控制器来完成这些操作。

### 删除 StatefulSet

关于删除 StatefulSet，你需要了解两个重要事项。

首先，**删除 StatefulSet 对象不会以有序方式终止其 Pod**。这意味着你应该先在删除 StatefulSet 之前将其缩容到零个副本！

其次，你可以使用 `terminationGracePeriodSeconds` 来进一步控制 Pod 的终止。例如，通常将其设置为至少 10 秒，以便给应用留出时间刷新缓冲区并安全提交仍在写入中的写操作。

### StatefulSet 与卷

卷是 StatefulSet Pod 粘性 ID（状态）的重要组成部分。

当 StatefulSet 控制器创建 Pod 时，它也会同时创建 Pod 所需的任何卷。为了帮助实现这一点，Kubernetes 会为卷赋予特殊的名称，将其与正确的 Pod 关联起来。图 13.2 显示了一个名为 `tkb-sts` 的 StatefulSet，请求创建三个 Pod，每个 Pod 拥有一个卷。你可以看到 Kubernetes 如何使用名称将卷与 Pod 连接起来。

**图 13.2**

尽管卷与特定的 Pod 副本相关联，但它们仍然通过常规的 **Persistent Volume Claim（持久卷声明）** 系统与 Pod 解耦。这意味着卷具有独立的生命周期，允许它们在 Pod 故障和 Pod 终止操作中存活。例如，当 StatefulSet Pod 发生故障或被终止时，其关联的卷不受影响。这使得替换 Pod 可以连接到幸存的卷和数据，即使 Kubernetes 将替换 Pod 调度到不同的集群节点上也是如此。

在扩缩操作中也同样如此。如果缩容操作删除了一个 StatefulSet Pod，后续的扩容操作会将新的 Pod 附加到幸存的卷上。

如果你意外删除了一个 StatefulSet Pod，尤其是最后一个副本时，这种行为可能成为救命稻草！

### 处理故障

StatefulSet 控制器会观测集群状态，并将观测到的状态与期望状态进行协调。

最简单的例子是 Pod 故障。如果你有一个名为 `tkb-sts` 的 StatefulSet，包含五个副本，并且 `tkb-sts-3` 副本发生故障，控制器会启动一个具有相同名称的新 Pod，并将其附加到幸存的卷上。

节点故障可能更复杂。某些旧版本的 Kubernetes 需要手动干预来替换运行在故障节点上的 Pod。这是因为 Kubernetes 有时很难判断一个节点是真正故障了，还是仅仅因为暂时性事件正在重启。例如，如果一个“故障”节点在 Kubernetes 替换了其 Pod 之后恢复，你将得到两个相同的 Pod 试图写入同一个卷，这可能导致数据损坏。

幸运的是，较新版本的 Kubernetes 能更好地处理此类场景。

### 网络 ID 与无头 Service (Headless Service)

我们已经说过，StatefulSet 适用于需要 Pod 具有可预测性和长期稳定性的应用。一个原因可能是外部应用需要连接到同一个 Pod 并反复重连。StatefulSet 不使用常规的 Kubernetes Service（它在多个 Pod 间负载均衡请求），而是使用一种特殊的 Service，称为**无头 Service (Headless Service)**。这类 Service 会为每个 StatefulSet Pod 创建可预测的 DNS 名称，使得应用可以查询 DNS（服务注册中心）以获取完整的 Pod 列表，然后直接连接到特定的 Pod。

以下 YAML 片段展示了一个名为 `mongo-prod` 的无头 Service 和一个名为 `sts-mongo` 的 StatefulSet。这是一个无头 Service，因为它没有 ClusterIP。同时，它在 StatefulSet 中被列为**管理 Service (Governing Service)**。

```yaml
apiVersion: v1
kind: Service                   # <---- Service
metadata:
  name: mongo-prod
spec:
  clusterIP: None               # <---- 使其成为无头 Service
  selector:
    app: mongo
    env: prod
---
apiVersion: apps/v1
kind: StatefulSet               # <---- StatefulSet
metadata:
  name: sts-mongo
spec:
  serviceName: mongo-prod       # <---- 管理 Service
```

我们来解释一下**无头 Service** 和**管理 Service** 这两个术语。

- **无头 Service** 是一个常规的 Kubernetes Service 对象，但没有 ClusterIP 地址（`spec.clusterIP: None`）。
- 你通过将其列在 StatefulSet 的 `spec.serviceName` 下，使其成为 StatefulSet 的**管理 Service**。

当你像这样将无头 Service 与 StatefulSet 结合使用时，该 Service 会为所有与该 Service 标签选择器匹配的 Pod 创建 DNS SRV 记录和 DNS A 记录。其他 Pod 和应用随后可以查询 DNS，以获取 StatefulSet 所有 Pod 的名称和 IP。你将在后面看到这一点，但开发者必须编写自己的应用代码来以这种方式查询 DNS。

以上涵盖了大部分理论。接下来，让我们通过一个示例来看看这一切是如何协同工作的。

## StatefulSet 实操

在本节中，你将部署一个可运行的 StatefulSet。

我设计并在 Linode Kubernetes Engine (LKE) 以及本地 Docker Desktop 多节点集群上测试了演示。如果你的集群运行在不同的云环境或本地环境中，你将需要使用不同的 StorageClass。我到时候会告诉你。

如果你还没有这样做，请运行以下命令克隆本书的 GitHub 仓库并切换到 `2025` 分支。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

> [!TIP]
> 从 `statefulsets` 文件夹内运行所有剩余命令。

你将部署以下三个对象：

1.  一个 **StorageClass**
2.  一个 **无头 Service**
3.  一个 **StatefulSet**

为了便于理解，你将单独部署和检查每个对象。然而，你也可以将它们组合到一个 YAML 文件中，然后通过单个命令部署（参见 `statefulsets` 文件夹中的 `app.yml` 文件）。

### 部署 StorageClass

StatefulSet 需要一种动态创建卷的方式。为此，它们需要：

- 一个 **StorageClass (SC)**
- 一个 **PersistentVolumeClaim (PVC)**

以下 YAML 来自 `lke-sc.yml` 文件，定义了一个名为 `block` 的 StorageClass，它使用 LKE 块存储 CSI 驱动从 Linode Cloud 动态供应块存储。如果你使用的是 Docker Desktop 多节点集群，则需要改用 `dd-kind-sc.yml` 文件。如果你的集群运行在不同的云环境上，你可以执行以下任一操作：

- 为你自己的云环境创建一个名为 `block` 的新 StorageClass——你需要自行创建，并适当配置 `provisioner` 和 `parameters` 部分。
- 使用集群现有的某个 StorageClass，并在后续步骤中更改 PVC 中的 StorageClass 名称。

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: block                                # PVC 将引用此名称
provisioner: linodebs.csi.linode.com         # LKE 块存储 CSI 驱动
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

部署 StorageClass。如果你使用的是本地 Docker Desktop 多节点集群，请记得改用 `dd-kind-sc.yml` 文件。

```bash
$ kubectl apply -f lke-sc.yml
storageclass.storage.k8s.io/block created
```

列出集群中的 StorageClass，确保你创建的那个出现在列表中。

```bash
$ kubectl get sc
```

# 13: StatefulSet

部署 StorageClass。如果使用的是本地 Docker Desktop 多节点集群，请使用 `dd-kind-sc.yml` 文件。

```bash
$ kubectl apply -f lke-sc.yml
storageclass.storage.k8s.io/block created
```

列出集群中的 StorageClass，确保你的 StorageClass 已存在列表中。

```bash
$ kubectl get sc
```

```
NAME     PROVISIONER               RECLAIMPOLICY    VOLUMEBINDINGM
block    linodebs.csi.linode.com   Delete           WaitForFirstC
```

你的 StorageClass 已就绪，StatefulSet 将使用它动态创建新卷。

## 创建治理型无头 Service（Headless Service）

将 Service 对象想象为有头有尾的形态会有助于理解：
- **头** = 稳定的 ClusterIP 地址
- **尾** = 接收流量的 Pod 列表

无头 Service 是一个常规的 Kubernetes Service 对象，但没有头 / ClusterIP 地址。无头 Service 的主要作用是为 StatefulSet 的 Pod 创建 DNS SRV 记录。客户端通过 DNS 查询单个 Pod，然后直接向这些 Pod 发送请求，而不是通过 Service 的 ClusterIP。这就是为什么无头 Service 没有 ClusterIP。

以下 YAML 来自 `headless-svc.yml` 文件，描述了一个名为 `dullahan` 的无头 Service，没有 ClusterIP 地址（`spec.clusterIP: None`）。

```yaml
apiVersion: v1
kind: Service        <<---- 普通 Kubernetes Service
metadata:
  name: dullahan     <<---- 名称仅使用有效的 DNS 字符
  labels:
    app: web
spec:
  ports:
  - port: 80
    name: web
  clusterIP: None    <<---- 使其成为无头 Service
  selector:
    app: web
```

与普通 Service 的唯一区别是：无头 Service 的 `clusterIP` 设置为 `None`。

运行以下命令将无头 Service 部署到集群中。

```bash
$ kubectl apply -f headless-svc.yml
service/dullahan created
```

确认 Service 存在。

```bash
$ kubectl get svc
```

```
NAME         TYPE         CLUSTER-IP    EXTERNAL-IP    PORT(S)    
dullahan     ClusterIP    None          <none>         80/TCP     
```

## 部署 StatefulSet

现在你已经创建了 StorageClass 和一个无头 Service，可以部署 StatefulSet 了。

以下 YAML 来自 `sts.yml` 文件，定义了 StatefulSet。

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: tkb-sts                          <<---- 命名 StatefulSet
spec:
  replicas: 3                            <<---- 部署三个副本
  selector:
    matchLabels:
      app: web
  serviceName: "dullahan"                <<---- 指定治理 Service
  template:
    metadata:
      labels:
        app: web
    spec:
      terminationGracePeriodSeconds: 10
      containers:
      - name: ctr-web
        image: nginx:latest
        ports:
        - containerPort: 80
          name: web
        volumeMounts:                         ----┐
        - name: webroot                           | 挂载此卷
          mountPath: /usr/share/nginx/html    ----┘
  volumeClaimTemplates:                       ----┐
  - metadata:                                     |
      name: webroot                               |
    spec:                                         | 
      accessModes: [ "ReadWriteOnce" ]            | 通过 "block" 
      storageClassName: "block"                   | StorageClass
      resources:                                  | 动态创建 PVC
        requests:                                 |
          storage: 10Gi                       ----┘ 
```

有很多内容需要理解，我们来逐步过一遍关键部分。

你的 StatefulSet 名为 `tkb-sts`，Kubernetes 以这个名称为基础，为每个副本和卷构建名称。

Kubernetes 会读取 `spec.replicas` 字段，创建 3 个副本，命名为 `tkb-sts-0`、`tkb-sts-1` 和 `tkb-sts-2`。它会按顺序创建它们，并等待每个副本进入 Running 和 Ready 状态后，再启动下一个。

`spec.serviceName` 字段指定了治理 Service（Governing Service）。这是你在上一步创建的无头 Service 的名称，它为 StatefulSet 副本创建 DNS SRV 记录。我们称之为治理 Service，因为它负责管理 StatefulSet 的 DNS 子域。后文会详细说明。

`spec.template` 部分的其余内容定义了 Pod 模板。这里可以定义要使用的容器镜像、暴露的端口等。

最后但同样重要的是 `spec.volumeClaimTemplates` 部分。Kubernetes 使用它动态为每个 StatefulSet Pod 创建唯一的 PVC。由于需要 3 个副本，Kubernetes 会基于 `spec.template` 创建 3 个唯一的 Pod，并根据 `spec.volumeClaimTemplates` 创建 3 个唯一的 PVC。同时确保 Pod 与 PVC 的名称正确关联。

以下 YAML 片段展示了示例中的卷声明模板。它定义了一个名为 `webroot` 的声明模板，向 `block` StorageClass 请求 10GB 的卷。

```yaml
volumeClaimTemplates:
- metadata:
    name: webroot
  spec:
    accessModes: [ "ReadWriteOnce" ]
    storageClassName: "block"
    resources:
      requests:
        storage: 10Gi
```

> [!TIP]
> 如果你没有使用 LKE 集群，而是使用云服务商内置的 StorageClass，则需要编辑 `sts.yml` 文件，将 `storageClassName` 字段改为集群中可用的 StorageClass。如果你自己创建了名为 `block` 的 StorageClass，则无需修改。

运行以下命令部署 StatefulSet。

```bash
$ kubectl apply -f sts.yml
statefulset.apps/tkb-sts created
```

观察 StatefulSet 启动到三个副本的过程。控制器创建所有三个 Pod 及相关 PVC 需要一两分钟。

```bash
$ kubectl get sts --watch
```

```
NAME      READY   AGE
tkb-sts   0/3     14s
tkb-sts   1/3     30s
tkb-sts   2/3     60s
tkb-sts   3/3     90s
```

注意，启动第一个副本大约用了 30 秒。待其运行并就绪后，再花 30 秒启动第二个，再花 30 秒启动第三个。这就是 StatefulSet 控制器的行为：依次启动每个副本，并等待其运行并就绪后再启动下一个。

现在检查 PVC。

```bash
$ kubectl get pvc
```

```
NAME                 STATUS    VOLUME             CAPACITY    MOD
webroot-tkb-sts-0    Bound     pvc-1146...f274    10Gi        RWO 
webroot-tkb-sts-1    Bound     pvc-3026...6bcb    10Gi        RWO 
webroot-tkb-sts-2    Bound     pvc-2ce7...e56d    10Gi        RWO 
```

你已经有了三个新的 PVC，每个 PVC 都是与对应的 Pod 副本同时创建的。仔细观察会发现，每个 PVC 的名称都包含卷声明模板名称、StatefulSet 名称和对应的 Pod 副本名称。

| volumeClaimTemplate 名称 | Pod 名称 | PVC 名称 |
|--------------------------|----------|----------|
| webroot                  | tkb-sts-0| webroot-tkb-sts-0|
| webroot                  | tkb-sts-1| webroot-tkb-sts-1|
| webroot                  | tkb-sts-2| webroot-tkb-sts-2|

恭喜！你的 StatefulSet 正在运行并管理着三个 Pod 和三个卷。

## 测试对等发现（Peer Discovery）

我们来解释一下 StatefulSet 中的 DNS 主机名和 DNS 子域是如何工作的。

所有 Kubernetes 对象在集群地址空间内都有一个名称。你可以在构建集群时指定自定义地址空间，但大多数集群使用 `cluster.local` DNS 域。在这个域内，Kubernetes 构建 DNS 子域的格式如下：

```
<object-name>.<service-name>.<namespace>.svc.cluster.local
```

你已经在 default 命名空间中部署了三个名为 `tkb-sts-0`、`tkb-sts-1` 和 `tkb-sts-2` 的 Pod，并由 `dullahan` 无头 Service 治理。因此，你的 Pod 将具有以下完全限定 DNS 名称，这些名称是可预测且可靠的：

- `tkb-sts-0.dullahan.default.svc.cluster.local`
- `tkb-sts-1.dullahan.default.svc.cluster.local`
- `tkb-sts-2.dullahan.default.svc.cluster.local`

无头 Service 的职责就是将这些 Pod 及其 IP 地址注册到 `dullahan.default.svc.cluster.local` 名称下。

我们将通过部署一个预装了 `dig` 工具的 jump Pod 来测试。然后 `exec` 进入该 Pod，使用 `dig` 查询 Service 的 SRV 记录。

执行以下命令，从 `jump-pod.yml` 文件部署 jump Pod。

```bash
$ kubectl apply -f jump-pod.yml
pod/jump-pod created
```

Exec 进入该 Pod。

```bash
$ kubectl exec -it jump-pod -- bash
root@jump-pod:/#
```

终端提示符会改变，表示已连接到 jump Pod。在 jump-pod 中运行以下 `dig` 命令。

```bash
# dig SRV dullahan.default.svc.cluster.local
```

```
<Snip>
;; QUESTION SECTION:
;dullahan.default.svc.cluster.local. IN SRV

;; ANSWER SECTION:
dullahan.default.svc.cluster.local. 30 IN SRV... tkb-sts-1.dullah
dullahan.default.svc.cluster.local. 30 IN SRV... tkb-sts-0.dullah
dullahan.default.svc.cluster.local. 30 IN SRV... tkb-sts-2.dullah

;; ADDITIONAL SECTION:
tkb-sts-0.dullahan.default.svc.cluster.local. 30 IN A 10.60.0.5
tkb-sts-2.dullahan.default.svc.cluster.local. 30 IN A 10.60.1.7
tkb-sts-1.dullahan.default.svc.cluster.local. 30 IN A 10.60.2.12
<Snip>
```

输出显示，查询 `dullahan.default.svc.cluster.local` 的客户端（QUESTION SECTION）将得到三个 StatefulSet Pod 的 DNS 名称（ANSWER SECTION）和 IP 地址（ADDITIONAL SECTION）。明确来说：**ANSWER SECTION** 将 `dullahan.default.svc.cluster.local` 的请求映射到三个 Pod，而 **ADDITIONAL SECTION** 将 Pod 名称映射到 IP 地址。

输入 `exit` 返回你的终端。

## 扩缩 StatefulSet

每次 Kubernetes 向上扩展 StatefulSet 时，都会创建新的 Pod 和 PVC。但向下扩展时，Kubernetes 只终止 Pod。这意味着未来的向上扩展操作只需要创建新的 Pod，并将它们重新连接到原有的 PVC。Kubernetes 和 StatefulSet 控制器会自动处理这一切，无需你干预。

当前你有三个 StatefulSet Pod 和三个 PVC。编辑 `sts.yml` 文件，将副本数从 3 改为 2，保存更改。完成后运行以下命令，将更新后的配置重新提交到集群。如果你还连接在 jump Pod 中，需要先输入 `exit` 退出。

```bash
$ kubectl apply -f sts.yml
statefulset.apps/tkb-sts configured
```

检查 StatefulSet，确认 Pod 数量已减少到 2。

```bash
$ kubectl get sts tkb-sts
```

```
NAME      READY   AGE
tkb-sts   2/2     12h
```

```bash
$ kubectl get pods
```

```
NAME        READY   STATUS    RESTARTS   AGE
tkb-sts-0   1/1     Running   0          12h
tkb-sts-1   1/1     Running   0          12h
```

你已经成功将 Pod 数量向下缩减到 2。仔细观察会发现，Kubernetes 删除了索引序号最高的那个 Pod（`tkb-sts-2`），但你仍然拥有 3 个 PVC。记住，缩减 StatefulSet 不会删除 PVC。

验证一下。

```bash
$ kubectl get pvc
```

```
NAME                 STATUS    VOLUME             CAPACITY    MOD
webroot-tkb-sts-0    Bound     pvc-5955...d71c    10Gi        RWO 
webroot-tkb-sts-1    Bound     pvc-d62c...v701    10Gi        RWO 
webroot-tkb-sts-2    Bound     pvc-2e2f...5f95    10Gi        RWO 
```

三个 PVC 的状态仍然是 `Bound`，尽管 `tkb-sts-2` Pod 已不存在。如果运行 `kubectl describe` 查看 `webroot-tkb-sts-2` PVC，你会看到 `Used by` 字段显示为 `<none>`。

所有三个 PVC 仍然存在，这意味着再次向上扩展到 3 个副本时，只需要创建新的 Pod。StatefulSet 控制器会创建新的 Pod 并将其连接到现有的 PVC。

再次编辑 `sts.yml` 文件，将副本数改回 3，保存更改。完成后运行以下命令重新部署应用。

```bash
$ kubectl apply -f sts.yml
statefulset.apps/tkb-sts configured
```

等待几秒钟，让新的 Pod 部署完成，然后用以下命令验证。

```bash
$ kubectl get sts tkb-sts
```

# 13: StatefulSet

## 恢复副本数至3

将副本数改回3并保存更改后，执行以下命令重新部署应用：

```bash
$ kubectl apply -f sts.yml
statefulset.apps/tkb-sts configured
```

等待几秒让新Pod部署完成，然后用以下命令验证：

```bash
$ kubectl get sts tkb-sts
```

```
NAME      READY   AGE
tkb-sts   3/3     12h 
```

现在你回到了3个Pod。描述新的`tkb-sts-2` Pod，验证它挂载了`webroot-tkb-sts-2`卷。如果使用Windows，请将`grep ClaimName`参数替换为`Select-String -Pattern 'ClaimName'`。

```bash
$ kubectl describe pod tkb-sts-2 | grep ClaimName
ClaimName:  webroot-tkb-sts-2
```

恭喜，新Pod自动连接到了正确的卷。

值得注意的是，如果任何Pod处于失败状态，Kubernetes会暂停缩容操作。这保护了应用的弹性和数据的完整性。

你还可以通过修改 `spec.podManagementPolicy` 属性来更改StatefulSet控制器启动和停止Pod的方式。默认设置为 `OrderedReady`，其行为是逐个启动Pod，并等待前一个Pod处于运行就绪状态后再启动下一个。将值改为 `Parallel` 将使StatefulSet的行为更像Deployment——Pod会被并行创建和删除。例如，从2个Pod扩容到5个Pod时会立即创建全部3个新Pod，而从5个缩容到2个则会并行删除3个Pod。StatefulSet的命名规则仍被强制遵守，因为该设置仅适用于扩缩容操作，不影响滚动更新和回滚。

## 滚动更新（Rollouts）

StatefulSet支持滚动更新（也称为rollouts）。你更新YAML文件中的镜像版本并重新提交到API服务器后，控制器会用新Pod替换旧Pod。但是，它总是从编号最高的Pod开始，依次向下处理，一次一个，直到所有Pod都更新到新版本。控制器还会等待每个新Pod就绪后，再替换下一个索引序号较小的Pod。

如需更多信息，可以运行 `kubectl explain sts.spec.updateStrategy` 命令。

## 测试Pod故障

测试故障的最简单方法是手动删除一个Pod。StatefulSet控制器会注意到故障，并尝试通过启动一个新Pod并连接到相同的PVC和卷来进行调和。

让我们测试一下。

确认你的StatefulSet中有三个健康的Pod：

```bash
$ kubectl get pods
NAME        READY   STATUS   AGE
tkb-sts-0   1/1     Running  12h
tkb-sts-1   1/1     Running  12h
tkb-sts-2   1/1     Running  9m49s
```

让我们删除 `tkb-sts-0` Pod，看看StatefulSet控制器是否会自动重新创建它。

```bash
$ kubectl delete pod tkb-sts-0
pod "tkb-sts-0" deleted
$ kubectl get pods --watch
NAME        READY   STATUS              RESTARTS   AGE
tkb-sts-0   1/1     Running             0          12h
tkb-sts-1   1/1     Running             0          12h
tkb-sts-2   1/1     Running             0          10m
tkb-sts-0   0/1     Terminating         0          12h
tkb-sts-0   0/1     Pending             0          0s
tkb-sts-0   0/1     ContainerCreating   0          0s
tkb-sts-0   1/1     Running             0          8s
```

在命令中加入 `--watch` 可以让你看到StatefulSet控制器观察到终止的Pod并创建替代Pod的过程。这是一个干净的故障，StatefulSet控制器立即创建了替代Pod。

新Pod与故障Pod同名。但它是否有相同的PVC？

运行以下命令确认Kubernetes已将新Pod连接到原始的 `webroot-tkb-sts-0` PVC。如果你使用Windows，请将 `grep ClaimName` 参数替换为 `Select-String -Pattern 'ClaimName'`。

```bash
$ kubectl describe pod tkb-sts-0 | grep ClaimName
    ClaimName:  webroot-tkb-sts-0
```

成功了。

## 测试节点故障

从潜在的节点故障中恢复要复杂得多，并且可能取决于你的Kubernetes版本。现代Kubernetes集群能更好地自动替换故障节点上的Pod，而较老的版本可能需要手动干预。这是为了防止Kubernetes将短暂事件误判为灾难性节点故障。

让我们测试一个简单的节点故障。我将给出在LKE集群和Docker Desktop多节点Kubernetes集群上模拟节点故障的说明，但原理对其他平台同样适用。

运行以下命令列出你的StatefulSet Pod及其所在的节点：

```bash
$ kubectl get pods -o wide
NAME        READY   STATUS    RESTARTS   AGE   IP           NODE  
tkb-sts-0   1/1     Running   0          11m   10.2.0.132   lke34
tkb-sts-1   1/1     Running   0          12h   10.2.0.3     lke34
tkb-sts-2   1/1     Running   0          21m   10.2.1.7     lke34
```

仔细观察 `NODE` 列，你会看到Kubernetes将每个副本调度到了不同的节点。

在示例中，`tkb-sts-0` 运行在 `lke343…cbe00000` 节点上。通过完成以下过程模拟节点故障。我将展示如何在LKE和Docker Desktop多节点集群上实现。

### 在LKE上删除节点

前往你的LKE Dashboard（cloud.linode.com），点击左侧的Kubernetes选项卡，点击你的集群名称打开其概要页面。向下滚动到集群的节点池（Node Pool），回收（Recycle）一个运行StatefulSet副本的节点。这将删除并替换该节点。

**图13.3 - 删除一个LKE集群节点**

![Image 2610 on Page 414: 显示LKE界面中回收节点的截图，文字说明删除节点]

### 在Docker Desktop多节点集群（kind）上删除节点

这仅适用于Docker Desktop多节点（kind）集群，你需要删除并重新创建集群才能将其恢复为三个节点。如果使用的是Docker Desktop单节点（kubeadm）集群，则无法继续。

Docker Desktop将集群节点作为容器运行，三个节点的集群将拥有三个名为 `desktop-control-plane`、`desktop-worker` 和 `desktop-worker2` 的容器。

打开Docker Desktop，导航到左侧导航窗格中的容器（Containers）选项卡。找到与你要删除的工作节点同名的容器，点击容器右侧的垃圾桶图标将其删除。请确保删除一个运行StatefulSet副本的节点。图13.4展示了如何删除 `desktop-worker2` 节点。

**图13.4 - 删除一个Docker Desktop集群节点**

![Image 2613 on Page 415: 显示Docker Desktop容器列表中删除desktop-worker2容器的截图]

### 观察StatefulSet恢复过程

删除节点后，你可以运行以下命令观察StatefulSet控制器从故障中恢复的过程。可能需要一两分钟才能完成，在此期间StatefulSet控制器会观察缺失的Pod并决定如何处理。

```bash
$ kubectl get pods -o wide --watch
NAME        READY   STATUS                RESTARTS   AGE   IP     
tkb-sts-0   1/1     Running               0          14m   10.2.0
tkb-sts-1   1/1     Running               0          12h   10.2.0
tkb-sts-2   1/1     Running               0          30m   10.2.1
tkb-sts-0   1/1     Terminating           0          14m   10.2.0
<Snip> 
tkb-sts-0   0/1     Completed             0          14m   10.2.0
<Snip> 
tkb-sts-0   0/1     Pending               0          0s    <none> 
tkb-sts-0   0/1     Pending               0          0s    <none> 
tkb-sts-0   0/1     ContainerCreating     0          0s    <none> 
tkb-sts-0   0/1     ContainerCreating     0          110s  <none> 
tkb-sts-0   1/1     Running               0          111s  10.2.0
```

让我们检查输出。

`STATUS` 列显示 `tkb-sts-0` Pod经历了终止（Terminating）、完成（Completed）、进入挂起（Pending）状态、进入容器创建（ContainerCreating）状态，最后达到运行（Running）状态。当Kubernetes注意到节点缺失，StatefulSet从三个副本降到两个时，Pod便会终止。这导致集群的观测状态不再匹配你的期望状态，StatefulSet控制器便会启动并创建缺失的 `tkb-sts-0` 副本的新副本。新副本进入挂起状态，调度器将其分配到幸存的节点上。一旦分配到节点，它进入容器创建状态，节点下载相应的镜像并启动容器。在Kubernetes释放前一PVC附着时，它可能会看似卡在此状态。最终，新副本绑定到PVC，进入运行状态，StatefulSet恢复到三个副本。

如果你检查 `NODE` 列，会发现原始的 `tkb-sts-0` 副本运行在 `lke343745…cbe00000` 节点上，但Kubernetes已将替代副本调度到了 `lke343745…7b870000` 节点。这是因为之前的节点已不复存在。

如果你使用LKE集群，你将有一个新节点替换了你回收的那个节点。但是，Kubernetes不会将现有副本重新平衡到新节点。

## 删除StatefulSet

本章前面提到过，当你删除StatefulSet时，Kubernetes不会按顺序终止Pod。因此，如果你的应用程序和数据对有序关闭敏感，你应该在删除StatefulSet之前将其缩容到零。

将你的StatefulSet缩容到0个副本并确认操作。完全缩容到0可能需要几秒钟。

```bash
$ kubectl scale sts tkb-sts --replicas=0
statefulset.apps/tkb-sts scaled
$ kubectl get sts tkb-sts
NAME      READY   AGE
tkb-sts   0/0     13h
```

一旦副本数变为0，你就可以删除StatefulSet了。

```bash
$ kubectl delete sts tkb-sts
statefulset.apps "tkb-sts" deleted
```

你可以随意进入 `jump-pod` 执行另一个 `dig` 命令来证明Kubernetes已从集群DNS中删除SRV记录。如果你在删除集群节点时已经终止了jump pod，可能已经没有了。

## 清理工作

你已经删除了StatefulSet及其Pod。但是，jump Pod、无头Service、卷和StorageClass仍然存在。如果你一直在跟着操作，可以使用以下命令删除它们。未能删除卷会产生意外的云成本。

删除jump Pod。如果它已经不存在，无需担心。

```bash
$ kubectl delete pod jump-pod
```

删除无头Service。

```bash
$ kubectl delete svc dullahan
```

删除PVC。这将删除关联的PV以及Linode Cloud上的后端存储。如果你使用了自己的StorageClass，应检查存储后端以确认外部卷也被删除。未能删除后端卷可能导致不必要的费用。

```bash
$ kubectl delete pvc webroot-tkb-sts-0 webroot-tkb-sts-1 webroot-tkb-sts-2
```

（注意：原文中该命令被截断，实际应为完整的三卷名称）

删除StorageClass。

```bash
$ kubectl delete sc flash
```

如果你从Docker Desktop多节点（kind）集群中删除了一个节点，你需要删除并重建集群以恢复到所需的节点数。

## 本章总结

在本章中，你学习了如何使用StatefulSet来部署和管理那些处理持久化数据和状态的应用。

StatefulSet能够自愈、扩缩容以及执行滚动更新。回滚需要手动处理。

每个StatefulSet Pod都能获得可预测且持久的名称、DNS主机名以及自己独有的卷。这些在其整个生命周期（包括故障、重启、扩缩容及其他调度操作）中保持不变。实际上，StatefulSet Pod的名称对于扩缩容操作以及连接到正确的存储卷至关重要。

最后，StatefulSet只是一个框架。我们需要设计应用程序来利用它的工作方式。