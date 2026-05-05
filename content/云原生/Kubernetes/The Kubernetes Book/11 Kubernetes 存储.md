# 11：Kubernetes 存储

对于大多数实际业务应用而言，数据的存储和检索至关重要。幸运的是，Kubernetes 拥有一个持久卷子系统，可以轻松连接提供高级数据管理服务（如备份与恢复、复制、快照、加密等）的外部存储系统。

我将本章分为以下部分：

- 宏观概览
- 存储提供商
- 容器存储接口 (CSI)
- Kubernetes 持久卷子系统
- 使用 StorageClass 进行动态供给
- 动手实践

Kubernetes 支持多种外部存储系统。这些包括来自 EMC、NetApp 等提供商的企业级存储系统，以及所有主要云提供商的存储系统。

本章的动手实践示例基于一个名为 Linode Kubernetes Engine (LKE) 的托管 Kubernetes 服务。它构建简单且相对便宜，但这些示例在其他云上无法运行。这是因为每个云都有自己的存储插件，各有不同的选项和功能。我包含了可在 Google Kubernetes Engine (GKE) 上运行的文件，但我无法为每个云都提供示例。幸运的是，它们都遵循相似的原理，你在本章学到的内容将为在其他云上工作打下坚实基础。

## 宏观概览

Kubernetes 支持来自许多不同提供商的多种存储类型。这些包括来自各种外部系统的块存储、文件存储和对象存储，这些系统可以在云中，也可以在本地数据中心。

图 11.1 展示了高级架构。

**图 11.1**

左侧是存储提供商。如前所述，这些是提供高级存储服务的外部系统，可以是本地系统（如 EMC 和 NetApp），也可以是云提供的存储服务。

图的中部是插件层。这是左侧外部存储系统与右侧 Kubernetes 之间的接口。现代插件使用容器存储接口（CSI），这是面向 Kubernetes 等容器编排器的行业标准存储接口。如果你是编写存储插件的开发者，CSI 抽象了 Kubernetes 内部机制，允许你进行树外开发。

> [!NOTE]
> **关于 CSI 的背景**：在 CSI 之前，所有存储插件都是作为主 Kubernetes 代码树的一部分进行开发（树内）。这迫使它们必须开源，并且插件更新和错误修复与 Kubernetes 发布周期绑定。这对插件开发者和 Kubernetes 维护者来说都存在问题。幸运的是，CSI 插件不必开源，我们可以随时发布它们。

图 11.1 的右侧是 Kubernetes 持久卷子系统。这是一组标准化的 API 对象，使应用能够轻松消费存储。与存储相关的 API 对象数量不断增加，但核心对象包括：

- PersistentVolume (PV)
- PersistentVolumeClaim (PVC)
- StorageClass (SC)

在本章中，我们会以几种不同方式引用它们。有时会使用帕斯卡命名法的缩写名称——PersistentVolume、PersistentVolumeClaim 和 StorageClass。有时会使用它们的首字母缩写——PV、PVC 和 SC。有时也会直接称其为持久卷和存储类等。

PV 映射到外部卷，PVC 授予对 PV 的访问权限，SC 则使这一切自动化和动态化。

考虑图 11.2 中所示的快速 AWS 示例和工作流程。

**图 11.2 - 卷供给工作流程**

1. 最右侧的 Pod 需要一个 50GB 的卷，并通过 PersistentVolumeClaim (PVC) 请求它。
2. PVC 要求 StorageClass 创建一个新的 PV 以及关联的 AWS 后端卷。
3. SC 通过 AWS CSI 插件向后端发起调用。
4. CSI 插件在 AWS 上创建 50GB 的 EBS 卷。
5. CSI 插件将外部卷的创建情况报告回 SC。
6. SC 创建 PV 并将其映射到 AWS 后端上的 EBS 卷。
7. Pod 挂载 PV 并使用它。

在深入探讨之前，值得注意 Kubernetes 有机制来防止多个 Pod 写入同一个 PV。它还强制外部卷与 PV 之间建立 1:1 映射——你不能将一个 50GB 的外部卷映射到两个 25GB 的 PV 上。

下面让我们更深入地分析。

## 存储提供商

如前所述，Kubernetes 允许你使用来自多种外部系统的存储。我们通常将这些系统称为提供商或供给程序（provisioner）。

每个提供商提供自己的 CSI 插件，以暴露后端的特性和配置选项。

提供商通常通过 Helm chart 或 YAML 安装程序来分发插件。安装后，插件作为一组 Pod 运行在 `kube-system` 命名空间中。

存在一些明显的限制。例如，如果你的集群在 Microsoft Azure 上，则无法供给和挂载 AWS EBS 卷。位置限制也可能适用。例如，Pod 可能需要与其访问的存储位于同一区域或可用区。

其他选项，如卷大小、保护级别、快照计划、复制设置、加密配置等，均通过后端的 CSI 插件进行配置。并非所有后端都支持相同的功能，你需要阅读插件的文档并正确配置它。

## 容器存储接口 (CSI)

CSI 是一个开源项目，它定义了行业标准接口，使容器编排器能够以统一的方式利用外部存储资源。例如，它为存储提供商提供了一个文档化的接口。这也意味着 CSI 插件应该能在任何支持 CSI 的编排平台上工作。

你可以在以下仓库中找到相对最新的 CSI 插件列表。该仓库将插件称为驱动程序（driver）。

`https://kubernetes-csi.github.io/docs/drivers.html`

大多数云平台都预装了其原生存储服务的 CSI 插件。对于第三方存储系统，你需要手动安装插件，但如前所述，它们通常以 Helm chart 或 YAML 文件的形式由提供商提供。安装后，CSI 插件通常作为一组 Pod 在 `kube-system` 命名空间中运行。

## Kubernetes 持久卷子系统

持久卷子系统是一组 API 对象，允许应用请求和访问存储。它包含以下我们将探讨和使用的资源：

- PersistentVolume (PV)
- PersistentVolumeClaim (PVC)
- StorageClass (SC)

如前所述，PV 使外部卷在 Kubernetes 上可用。例如，如果你希望让一个 50GB 的 AWS 卷在你的集群上可用，需要将其映射到一个 PV。如果 Pod 想要使用它，它需要一个 PVC 来授予对 PV 的访问权限。SC 允许应用动态创建 PV 和后端卷。

让我们再走一遍另一个示例。

假设你有一个外部存储系统，提供以下存储层级：

- 快速块存储（闪存）
- 快速加密块存储（闪存）
- 慢速块存储（机械硬盘）
- 文件存储 (NFS)

你为每个层级创建一个 StorageClass，这样所有四个层级都对 Kubernetes 可用。

| 外部层级 | Kubernetes StorageClass 名称 | CSI 插件 |
|----------|-------------------------------|----------|
| 闪存 | sc-fast-block | csi.xyz.block |
| 闪存加密 | sc-fast-encrypted | csi.xyz.block |
| 机械硬盘 | sc-slow | csi.xyz.block |
| NFS 文件存储 | sc-file | csi.xyz.file |

想象一下，你接到任务要部署一个新应用，需要 100GB 的快速加密块存储。为此，你创建一个 YAML 文件，定义一个引用 PVC 的 Pod，该 PVC 从 `sc-fast-encrypted` 存储类请求 100GB 的卷。

你通过将 YAML 文件发送到 API 服务器来部署应用。SC 控制器观察到新的 PVC，并指示 CSI 插件在外部存储系统上供给 100GB 的加密闪存存储。外部系统创建卷并报告回 CSI 插件，然后 CSI 插件通知 SC 控制器，SC 控制器将其映射到一个新的 PV。Pod 使用 PVC 挂载并使用该 PV。

如果有些内容仍然令人困惑，没关系。动手实践示例将澄清一切。

## 使用 StorageClass 进行动态供给

StorageClass 是 `storage.k8s.io/v1` API 组中的资源。资源类型是 `StorageClass`，你可以用常规的 YAML 文件定义它们。在使用 `kubectl` 时，可以使用 `sc` 短名称。

> [!TIP]
> 你可以运行 `kubectl api-resources` 命令来查看所有 API 资源及其短名称。它还会显示每个资源的 API 组及其对应的 `kind` 值。

顾名思义，StorageClass 允许你定义应用可以请求的不同存储类别。如何定义类别由你决定，并取决于你可用的存储类型。例如，你的云可能提供以下四种存储类型：

- 快速块存储 (SSD)
- 快速加密块存储 (SSD)
- 慢速块存储 (机械硬盘)
- 文件存储 (NFS)

让我们看一个示例。

### StorageClass YAML 示例

以下 YAML 对象定义了一个名为 `fast-local` 的 StorageClass，它从爱尔兰 AWS 区域供给加密的 SSD 卷，每 GB 支持 10 IOPs。

```yaml
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: fast-local
provisioner: ebs.csi.aws.com          # AWS Elastic Block Store
parameters:
  encrypted: true                     # 创建加密卷
  type: io1                           # AWS SSD 驱动器
  iopsPerGB: "10"                     # 性能要求
allowedTopologies:                    # 在哪里供给卷
- matchLabelExpressions:
  - key: topology.ebs.csi.aws.com/zone
    values:
    - eu-west-1a                      # 爱尔兰 AWS 区域
```

与所有 Kubernetes YAML 文件一样，`kind` 和 `apiVersion` 告诉 Kubernetes 你要定义的对象的类型和版本。`metadata.name` 是一个任意字符串，为对象提供友好名称，`provisioner` 字段告诉 Kubernetes 要使用哪个 CSI 插件——你需要已安装该插件。`parameters` 块定义了要供给的存储类型，`allowedTopologies` 属性允许你指定副本应放置的位置。

需要注意几个重要点：

1. **StorageClass 是不可变的**——一旦部署，你就无法修改它们。
2. **`metadata.name` 应该有含义**，因为你和其它对象通过它来引用该类。
3. **我们有时会混用术语 provisioner、plugin 和 driver**。
4. **`parameters` 块是插件特定的值**，每个插件都不同。

大多数存储系统都有自己的功能，你有责任阅读插件的文档并正确配置它。

### 使用 StorageClass 的基本工作流程

部署和使用 StorageClass 的基本工作流程如下：

1. 安装并配置 CSI 插件。
2. 创建一个或多个 StorageClass。
3. 部署带有 PVC 的 Pod，这些 PVC 通过 StorageClass 请求卷。

该列表假设你已有一个与 Kubernetes 集群连接的外部存储系统。大多数托管的 Kubernetes 服务会预装其云原生存储后端的 CSI 驱动程序，从而更容易消费它们。

以下 YAML 片段定义了一个 Pod、一个 PVC 和一个 SC。你可以通过在同一个 YAML 文件中用三个破折号 (`---`) 分隔它们来定义所有三个对象。

```yaml
apiVersion: v1
kind: Pod                             # 1. Pod
metadata:
  name: mypod
spec:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: mypvc              # 2. 通过 PVC 请求卷
  containers: ...
  <SNIP>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mypvc                         # 3. 这就是 "mypvc"
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi                   # 4. 供给一个 50Gi 的卷
  storageClassName: fast              # 5. ...基于 "fast" 存储类
---
kind: StorageClass
apiVersion: storage.k8s.io/v1
metadata:
  name: fast                          # 6. 这就是 "fast" 存储类
provisioner: pd.csi.storage.gke.io    # 7. 使用此 CSI 插件
parameters:
  # 此处配置插件特定参数
```

# Kubernetes 存储

## 动态供给示例（续）

```yaml
type: pd-ssd                        <<---- 8. 供给此类型的存储
```

YAML 被截断，未包含完整的 Pod 规范。然而，我们可以通过逐步查看编号注释来理解主要工作流程：

1. 一个普通的 Pod 对象
2. Pod 通过 `mypvc` PVC 请求一个卷
3. 文件定义了一个名为 `mypvc` 的 PVC
4. PVC 供给一个 50Gi 的卷
5. 该卷将通过 `fast` StorageClass 来供给
6. 文件定义了 `fast` StorageClass
7. StorageClass 通过 `pd.csi.storage.gke.io` CSI 插件供给卷
8. CSI 插件将从 Google Cloud 的后端供给快速 (pd-ssd) 存储

在进入演示之前，我们先看几个额外的设置。

## 其他卷设置

StorageClass 提供了多种控制卷供给和管理的方式。我们将涵盖以下内容：

- [[访问模式]]
- [[回收策略]]

### 访问模式

Kubernetes 支持三种卷访问模式：

- **ReadWriteOnce (RWO)**：允许单个 PVC 以读写 (R/W) 模式绑定到一个卷。尝试从多个 PVC 绑定将失败。
- **ReadWriteMany (RWM)**：允许多个 PVC 以读写 (R/W) 模式绑定到一个卷。文件存储和对象存储通常支持此模式，而块存储通常不支持。
- **ReadOnlyMany (ROM)**：允许多个 PVC 以只读 (R/O) 模式绑定到一个卷。

> [!IMPORTANT] 重要说明
> 一个 PV 只能以**一种模式**打开。例如，不能将同一个 PV 以一个 PVC 的 ROM 模式和另一个 PVC 的 RWM 模式绑定。

### 回收策略

**ReclaimPolicy** 告诉 Kubernetes 在其 PVC 被释放后应如何处理 PV 及关联的外部存储。当前存在两种策略：

- **Delete**：最危险，也是通过 StorageClass 动态创建的 PV 的默认策略。当 PVC 被释放时，它会删除 PV 和关联的外部存储。这意味着删除 PVC 将删除 PV 和外部存储。请谨慎使用。
- **Retain**：在删除 PVC 后保留 PV 和外部存储。这是更安全的选择，但需要手动回收资源。

## StorageClass 总结

[[StorageClass（SC）]] 代表了存储的层级，应用程序通过它们来动态创建卷。你可以在常规的 YAML 文件中定义它们，引用一个插件，并将其绑定到特定外部存储系统上的特定存储类型。例如，一个 SC 可能在美国 AWS 孟买区域供给高性能的 AWS SSD 存储，而另一个 SC 则从不同的 AWS 区域供给慢速的 AWS 存储。

一旦部署，SC 控制器会监视 API 服务器上引用该 SC 的新 PVC。每次创建匹配该 SC 的 PVC 时，SC 会在外部存储系统上动态创建所需卷，并将其映射到一个 PV，应用程序可以挂载并使用该 PV。

> [!TIP] 学习提示
> 这里总会有更详细的细节，但你已经掌握了足够的基础知识来入门。

## 动手实践

本节将引导你通过 StorageClass 动态供给卷。我将演示拆分为如下部分：

- 使用现有的 StorageClass
- 创建并使用新的 StorageClass

> [!WARNING] 注意
> 这些演示均基于 Linode Kubernetes Engine (LKE)，不适用于其他云环境。这是因为每个云和每个存储提供商都有自己的 CSI 插件，具有各自的配置选项，本书篇幅有限无法全部涵盖。不过，你可以轻松构建一个 LKE 集群来跟随操作，即使只是阅读，你也会学到很多。

本节剩余部分假设你已经克隆了本书的 GitHub 仓库并在 `2025` 分支上工作。同时假设你已连接到 LKE 集群。如果需要构建一个集群，请参阅第 3 章。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
<Snip>
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
$ cd storage
```

### 使用现有的 StorageClass

运行以下命令查看集群上预装的存储类。大多数 Kubernetes 环境至少预装一个存储类，为了适应页面宽度，我对输出进行了修剪。

```bash
$ kubectl get sc
```

# 11: Kubernetes 存储

## 使用现有 StorageClass

运行以下命令查看集群中预装的存储类。大多数 Kubernetes 环境至少预创建一个存储类，此处为适应页面已精简输出。

```bash
$ kubectl get sc
```

```
                               RECLAIM  
NAME                          PROVISIONER               POLICY    
linode-blck-stg               linodebs.csi.linode.com   Delete    
linode-blck-stg-retain (def)  linodebs.csi.linode.com   Retain    
```

我们来分析一下输出。

我的 LKE 集群有两个预创建的存储类，它们都通过 `linodebs.csi.linode.com` CSI 插件（`PROVISIONER`）来供应卷，并且都使用 `Immediate` 卷绑定模式。

一个使用 `Delete` 回收策略，另一个使用 `Retain`。

第二行的 `linode-block-storage-retain (default)` 类是默认类，这意味着除非你指定其他类，否则你的 PVC 将使用这个类。对于重要的生产应用，你应该指定一个存储类，因为默认类可能因集群而异，导致你无法始终获得相同的效果。

有些集群预先创建了很多存储类，以下输出来自 Google Kubernetes Engine 的 Autopilot 区域集群。它显示了八个类，其中五个使用 `filestore.csi.storage.gke.io` 插件访问 Google Cloud 基于 NFS 的 Filestore 存储，两个使用 `pd.csi.storage.gke.io` 插件访问 Google Cloud 的块存储，一个使用传统的树内插件 `kubernetes.io/gce-pd`（非 CSI）。

```
                                                    RECLAIM
NAME                 PROVISIONER                    POLICY    VOL
enterprise-multi..   filestore.csi.storage.gke.io   Delete    Wai
enterprise-rwx       filestore.csi.storage.gke.io   Delete    Wai
premium-rwo          pd.csi.storage.gke.io          Delete    Wai
premium-rwx          filestore.csi.storage.gke.io   Delete    Wai
standard             kubernetes.io/gce-pd           Delete    Imm
standard-rwo (def)   pd.csi.storage.gke.io          Delete    Wai
standard-rwx         filestore.csi.storage.gke.io   Delete    Wai
zonal-rwx            filestore.csi.storage.gke.io   Delete    Wai
```

运行以下命令查看 `linode-block-storage` 类的详细信息。

```bash
$ kubectl describe sc linode-block-storage
```

```
Name:                  linode-block-storage
IsDefaultClass:        No
Annotations:           lke.linode.com/caplke-version=v1.31.5-2025
Provisioner:           linodebs.csi.linode.com
Parameters:            <none>
AllowVolumeExpansion:  True
MountOptions:          <none>
ReclaimPolicy:         Delete
VolumeBindingMode:     Immediate
Events:                <none>
```

这个工作流程的关键在于它使用 `Delete` 回收策略。这意味着当你停止使用 PVC 时，Kubernetes 会自动删除 PV 及关联的后端卷。稍后你将看到这一过程。

列出任何现有的 PV 和 PVC，以便你能轻松识别即将创建的资源。

```bash
$ kubectl get pv
No resources found
$ kubectl get pvc
No resources found in default namespace.
```

以下 YAML 来自 `storage` 文件夹中的 `lke-pvc-test.yml` 文件。它定义了一个名为 `pvc-test` 的 PVC，通过 `linode-block-storage` 存储类请求一个 10GB 的卷。

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-test
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: linode-block-storage
  resources:
    requests:
      storage: 10Gi
```

运行以下命令创建 PVC。请确保在 `storage` 文件夹中运行，并且只有当你拥有一个包含 `linode-block-storage` 存储类的 LKE 集群时，它才会生效。

```bash
$ kubectl apply -f lke-pvc-test.yml
persistentvolumeclaim/pvc-test created
```

运行以下命令查看 PVC。

```bash
$ kubectl get pvc
NAME       STATUS   VOLUME                 CAPACITY   ACCESS MODE
pvc-test   Bound    pvc-cc3dd8716c7d46c9   10Gi       RWO         
```

Kubernetes 已经创建了 PVC 并将其绑定到一个卷上。这是因为 `linode-block-storage` SC 使用 `Immediate` 卷绑定模式，会在不等待 Pod 声明的情况下自动创建 PV 和后端存储。

运行以下命令查看 PV。

```bash
$ kubectl get pv
                                  ACCESS   RECLAIM
NAME                   CAPACITY   MODES    POLICY    STATUS   CLA
pvc-cc3dd8716c7d46c9   10Gi       RWO      Delete    Bound    pvc
```

PV 也存在，并且绑定到了 `pvc-test` 声明。这意味着该卷也应该存在于 Linode 云上。

打开你的 LKE 仪表板（`cloud.linode.com`）并导航到 **Volumes** 选项卡，确认你有一个 10GB 的卷，其名称与 PVC 相同，且位于与 LKE 集群相同的区域。

恭喜你！你已经成功通过集群内置的 SC 之一供应了一个外部卷。图 11.3 展示了各部分如何映射。唯一缺少的是右侧引用 PVC 来访问 PV 的 Pod。你将在下一节中看到这一点。

> [!figure]
> **图 11.3 - 各部分如何组合在一起**

如果你将存储类配置为 `VolumeBindingMode` 设置为 `WaitForFirstConsumer`，则存储类会等到你部署使用这些卷的 Pod 时才会创建 PV 或后端卷。

运行以下命令删除 PVC。

```bash
$ kubectl delete pvc pvc-test
persistentvolumeclaim "pvc-test" deleted
```

删除 PVC 也会删除 PV 以及在 LKE 后端上关联的卷。这是因为存储类创建它们时将 `ReclaimPolicy` 设置为 `Delete`。请完成以下步骤验证。

```bash
$ kubectl get pv
No resources found
```

前往 LKE 控制台的 **Volumes** 选项卡，确认后端卷已被删除。

## 创建并使用新的 StorageClass

在本节中，你将创建一个实现拓扑感知供应（topology-aware provisioning）的新 StorageClass。这种存储类会延迟创建卷，直到有 Pod 请求它。这确保存储类会在与 Pod 相同的区域和可用区中创建卷。

你将创建在本书 GitHub 仓库的 `storage` 文件夹中的 `lke-sc-wait-keep.yml` 文件中定义的存储类。它定义了一个名为 `block-wait-keep` 的存储类，具有以下属性：

- 块存储
- 拓扑感知供应（`volumeBindingMode: WaitForFirstConsumer`）
- 当 PVC 被删除时保留卷和数据（`reclaimPolicy: Retain`）

有时你会看到拓扑感知供应被称为**按需供应**（provision on demand）。

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: block-wait-keep
provisioner: linodebs.csi.linode.com       # <---- CSI 插件
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer    # <---- 按需供应
reclaimPolicy: Retain                      # <---- 删除 PVC 时保留卷
```

部署该 SC 并确认其存在。

```bash
$ kubectl apply -f lke-sc-wait-keep.yml
storageclass.storage.k8s.io/block-wait-keep created

$ kubectl get sc
                                                                  
                                                        RECLAIM  V
NAME                          PROVISIONER               POLICY   
block-wait-keep               linodebs.csi.linode.com   Retain   W
linode-blck-stg               linodebs.csi.linode.com   Delete   
linode-blck-stg-retain (def)  linodebs.csi.linode.com   Retain   
```

创建存储类后，你可以部署在 `lke-pvc-wait-keep.yml` 文件中定义的 PVC。如你所见，它定义了一个名为 `pvc-wait-keep` 的 PVC，通过 `block-wait-keep` SC 请求一个 20GB 的卷。

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-wait-keep
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: block-wait-keep
```

使用以下命令部署它。

```bash
$ kubectl apply -f lke-pvc-wait-keep.yml
persistentvolumeclaim/pvc-wait-keep created
```

确认 Kubernetes 已创建它，并检查它是否已创建 PV。

```bash
$ kubectl get pvc
NAME            STATUS    VOLUME   CAPACITY   ACCESS MODES   STORA
pvc-wait-keep   Pending                                      bloc

$ kubectl get pv
No resources found
```

PVC 处于 `Pending` 状态，存储类尚未创建 PV。这是因为 PVC 使用了一个 `volumeBindingMode` 为 `WaitForFirstConsumer` 的存储类，该类实现了拓扑感知供应：在 Pod 引用该 PVC 之前，不会在 LKE 上创建 PV 和后端卷。

以下 YAML 定义了一个名为 `volpod` 的 Pod，它使用你刚刚创建的 `pvc-wait-keep` PVC。它来自 `lke-app.yml` 文件。我已标注了引用 PVC 和挂载卷的部分。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: volpod
spec:
  volumes:                       # ----┐ 创建一个名为 "data"
  - name: data                       #     | 的卷,来自 PVC
    persistentVolumeClaim:           #     | "pvc-wait-keep"
      claimName: pvc-wait-keep   # ----┘
  containers:                    
  - name: ubuntu-ctr
    image: ubuntu:latest
    command:
    - /bin/bash
    - "-c"
    - "sleep 60m"
    volumeMounts:                # ----┐ 将 "data" 卷
    - name: data                     #     | 挂载到 /tkb
      mountPath: /tkb            # ----┘
```

部署该 Pod，然后确认存储类创建了 PV。

```bash
$ kubectl apply -f lke-app.yml
pod/volpod created

$ kubectl get pvc
NAME            STATUS   VOLUME                 CAPACITY   ACCESS 
pvc-wait-keep   Bound    pvc-279f09e083254fa9   20Gi       RWO    

$ kubectl get pv
```

## 11: Kubernetes 存储

> [!INFO] 本章内容
> 讲解持久卷、存储类和动态供给。

---

```bash
$ kubectl apply -f lke-app.yml
pod/volpod created
$ kubectl get pvc
NAME            STATUS   VOLUME                 CAPACITY   ACCESS MODES   RECLAIM POLICY   STORAGECLASS      AGE
pvc-wait-keep   Bound    pvc-279f09e083254fa9   20Gi       RWO            Retain           block-wait-keep   3m
$ kubectl get pv
NAME                   CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                 STORAGECLASS      AGE
pvc-279f09e083254fa9   20Gi       RWO            Retain           Bound    default/pvc-wait-keep block-wait-keep   3m
```

PVC 已绑定到一个卷，PV 存在且具有相同的名称，所有设置均符合预期——容量、回收策略和存储类。

运行以下命令确认 Pod 正在声明并挂载该卷：

```bash
$ kubectl describe pod volpod
Name:             volpod
Namespace:        default
Node:             lke340882-541526-0198b5d80000/192.168.145.142
Status:           Running
IP:               10.2.1.3
<Snip>
Containers:
  ubuntu-ctr:
<Snip>
    Mounts:
      /tkb from data (rw)
<Snip>
Volumes:
  data:
    Type:       PersistentVolumeClaim (a reference to a PVC...)
    ClaimName:  pvc-wait-keep
    ReadOnly:   false
<Snip>
```

下面总结刚才发生了什么：

1. 你创建了一个名为 `block-wait-keep` 的新 [[StorageClass]]，从 Linode 云动态供应块存储。
2. [[StorageClass]] 控制器开始监视 API 服务器，寻找引用新 `block-wait-keep` 类的 PVC。
3. 你创建了一个引用该类的 PVC，但由于卷绑定模式设置为 `WaitForFirstConsumer`，PVC 并未立即创建卷。
4. 你部署了一个使用该 PVC 的 Pod，请求一个新的 20GB 卷。
5. StorageClass 控制器观察到这一变化，动态创建了 PV 并在 Linode 云上创建了外部卷。

> [!TIP] 恭喜！
> 你已创建了自己的 StorageClass，通过延迟 PV 创建直到 Pod 引用 PVC，实现了拓扑感知的卷供应。这确保了 Kubernetes 在 Pod 所在的同一区域和可用区创建卷。

### 清理环境

你需要执行五步来清理环境：

1. 删除使用 PVC 的 Pod
2. 删除 PVC
3. 删除 PV
4. 在 Linode 云后端手动删除卷
5. 删除 StorageClass

删除 Pod。可能需要几秒钟才能完成操作。

```bash
$ kubectl delete pod volpod
pod "volpod" deleted
```

删除 PVC。

```bash
$ kubectl delete pvc pvc-wait-keep
persistentvolumeclaim "pvc-wait-keep" deleted
```

即使你删除了 Pod 和 PVC，Kubernetes 也不会删除 PV 或外部卷，因为存储类创建它们时使用了 `Retain` 回收策略。这意味着你必须手动删除它们。

运行以下命令删除 PV。你的 PV 名称可能不同。

```bash
$ kubectl delete pv pvc-279f09e083254fa9
persistentvolume "pvc-279f09e083254fa9" deleted
```

打开你的 Linode 云控制台，从 **Volumes** 选项卡中删除卷。务必删除与刚才删除的 PV 名称相同的卷！它在 **Attached to** 列中会显示为 `unattached`。若不删除该卷，将产生不必要的 Linode 费用。

最后，删除存储类。

```bash
$ kubectl delete sc block-wait-keep
storageclass.storage.k8s.io "block-wait-keep" deleted
```

---

## 章节总结

在本章中，你学习了 Kubernetes 拥有强大的存储子系统，使应用能够从各种外部提供商处动态供应和使用存储。每个外部提供商都有自己的 [[CSI]] 插件，用于创建卷并将其暴露在 Kubernetes 内部。大多数托管 Kubernetes 集群会预装 CSI 插件，这些插件作为 Pod 运行在 `kube-system` 命名空间中。

安装 CSI 插件后，你可以创建 [[StorageClass]] 来映射到外部系统上的某种存储类型。[[StorageClass]] 控制器作为控制平面上的后台调谐循环运行，监视 API 服务器中的新 PVC。每当检测到新 PVC 时，它就会在外部系统上创建请求的卷，并将其映射到 Kubernetes 上的新 [[PersistentVolume]]。然后 Pod 可以使用 PVC 来声明和挂载该卷。

---

**Image Context**  
[Image 2289 on Page 314]  
[Image 2293 on Page 317]  
[Image 2316 on Page 336]