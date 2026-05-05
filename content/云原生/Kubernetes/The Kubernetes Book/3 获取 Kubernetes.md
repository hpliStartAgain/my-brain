# 3: 获取 Kubernetes

本章将指导你如何安装和配置本书中所有示例所需的工具。这些工具包括：

1. Docker
2. Kubernetes 集群
3. `kubectl` 命令行工具

获取这三者的最简单方法是使用 Docker Desktop。它安装了 Docker、包含一个多节点 Kubernetes 集群，并自动安装和配置 `kubectl`。我每天都使用它，强烈推荐。不过，你无法将 Docker Desktop Kubernetes 集群用于第 8 章和第 11 章的示例，因为这些示例需要与云负载均衡器和云存储服务集成。对于这两章，你需要在云中准备一个 Kubernetes 集群。

我建议大多数读者安装 Docker Desktop，因为这样你就能同时获得 Docker 和 `kubectl`。然后你可以选择是在云中构建集群，还是使用 Docker Desktop 自带的集群。你甚至可以针对某些示例使用 Docker Desktop 的内置集群，仅为第 8 章和第 11 章在云中构建一个集群。

本章分为以下两个部分：

- 通过 Docker Desktop 安装所有工具
- 在 Linode 云中构建 Kubernetes 集群

我会提供一个链接，让你获得 60 天内有效的 100 美元 Linode 免费额度，这足以完成本书中的所有示例。

---

## 通过 Docker Desktop 安装所有工具

在本节中，你将完成以下所有步骤：

- 创建 Docker 账户（免费）
- 安装 Docker Desktop
- 部署 Docker Desktop 内置的多节点 Kubernetes 集群

> [!NOTE]
> Docker Desktop 免费用于个人和教育用途。如果你在工作中使用它，并且你的公司员工超过 250 人或年收入超过 1000 万美元，则需要付费获得许可证。

### 创建 Docker 账户

访问 [app.docker.com/signup](https://app.docker.com/signup) 并填写你的详细信息，创建一个免费的 Personal 账户。

### 安装 Docker Desktop

创建账户后，按照以下步骤安装 Docker Desktop。你需要 Docker Desktop 4.38 或更新版本：

1. 在网络上搜索 Docker Desktop。
2. 下载适用于你的操作系统（Linux、Mac 或 Windows）的安装程序。
3. 运行安装程序并按照“下一步、下一步、下一步”的说明进行操作。

> [!TIP]
> Windows 用户应在提示时安装 WSL 2 子系统。

安装完成后，你可能需要手动启动该应用程序。运行后，Mac 用户会在顶部菜单栏看到一个鲸鱼图标，而 Windows 用户会在底部系统托盘看到鲸鱼。点击鲸鱼图标可以显示一些基本控件，并显示 Docker Desktop 是否正在运行。

打开终端并运行以下命令，确保 Docker 和 `kubectl` 已安装并能正常工作。

```bash
$ docker --version
Docker version 27.5.1, build 9f9e405
$ kubectl version --client=true -o yaml
clientVersion:
  major: "1"
  minor: "31"
  platform: darwin/arm64
```

恭喜，你已经安装了 Docker 和 `kubectl`。

### 部署 Docker Desktop 内置的多节点 Kubernetes 集群

Docker Desktop v4.38 及更新版本内置了一个多节点 Kubernetes 集群，部署和使用起来都很简单。

点击菜单栏或系统托盘中的 Docker 鲸鱼图标并登录。如果你已登录，则会看到你的用户名而不是“Sign in/Sign up”选项。

登录后，再次点击 Docker 鲸鱼图标，选择 **Settings**（设置）选项以打开 GUI。

在 **General**（常规）选项卡中，确保启用了 **Use containerd for pulling and storing images**（使用 containerd 拉取和存储镜像）选项。你可能需要点击 **Apply & restart**（应用并重启）以使更改生效。

从左侧导航栏选择 **Kubernetes**，勾选 **Enable Kubernetes**（启用 Kubernetes）选项，然后选择 **kind (sign-in required)** 选项。选择此选项很重要，因为另一个选项（kubeadm）仅创建单节点集群。

> [!TIP]
> 如果你运行的是 Docker Desktop v4.38 或更新版本，但看不到 **kind (sign-in required)** 选项，可以尝试使用科乐美秘技（konami code）来启用它。在 Kubernetes 设置页面中输入以下按键序列——上、上、下、下、左、右、左、右、B、A。这将打开 **Experimental features**（实验性功能）页面，你可以在其中启用 **MultiNodeKubernetes** 功能。完成后，返回并再次尝试启用 **kind (sign-in required)** 集群。

假设你已经选择了 **kind (sign-in required)** 选项，将 **Node(s)**（节点数）滑块移动到 3，并勾选 **Show system containers (advanced)**（显示系统容器（高级））旁边的复选框。你还可以启用 Kubernetes Dashboard，但本书中的示例均不会使用它。你的选项应该如图 3.1 所示。

**Figure 3.1 - Docker Desktop Kubernetes 配置**

这将创建一个包含一个控制平面节点和两个工作节点的三节点集群。

点击 **Apply & restart**（应用并重启）。集群启动需要一两分钟，你可以在同一屏幕监控构建进度。运行后，你会在 Docker Desktop UI 底部看到绿色的“Kubernetes running”文本。

运行以下命令查看你的集群：

```bash
$ kubectl get nodes
NAME                    STATUS   ROLES           AGE   VERSION
desktop-control-plane   Ready    control-plane   10m   v1.32.2
desktop-worker          Ready    <none>          10m   v1.32.2
desktop-worker2         Ready    <none>          10m   v1.32.2
```

你应该会看到三个节点，名称与示例中所示相同。

返回 Docker Desktop，导航到 **Containers**（容器）选项卡，你会看到三个容器，名称与你集群的三个节点相同。这是因为 Docker Desktop 将你的 Kubernetes 集群作为容器运行。不要被这一点迷惑，用户体验完全相同。

**Figure 3.2 - 作为容器的集群节点**

恭喜，你已经安装了 Docker 和 `kubectl`，并在笔记本电脑上部署了一个多节点 Kubernetes 集群。你可以将本集群用于本书中的大部分示例。但是，如果你想跟随第 8 章和 11 章的 Ingress 和存储示例，则需要在云中准备一个 Kubernetes 集群。下一节将介绍如何构建这样的集群。

---

## 在 Linode 云中构建 Linode Kubernetes Engine (LKE) 集群

本节将介绍如何使用 Linode Kubernetes Engine (LKE) 在云中获取一个多节点 Kubernetes 集群。大多数其他云服务商也提供自己的 Kubernetes 服务，你可以使用其中任何一个。但是，第 11 章的示例是专门为 Linode 云存储设计的，这意味着如果你使用不同的云服务，则需要修改存储配置文件。

我还提供了一个链接，新用户应该可以获得 100 美元的免费 Linode 额度，这足够完成本书中的所有示例。

### 构建 Linode Kubernetes Engine (LKE) 集群

LKE 是一种托管型 Kubernetes 服务，由 Linode 负责构建集群并管理可用性、性能和更新。像这样的托管型 Kubernetes 服务是你能得到的最接近零门槛的生产级 Kubernetes 集群。

你需要完成以下步骤来构建 LKE 集群：

1. 注册 Linode 账户
2. 创建 LKE 集群
3. 配置 `kubectl`
4. 测试 LKE 集群

### 注册 Linode 账户

访问以下链接，注册并获得 60 天内有效的 100 美元免费额度。你需要输入有效的账单信息，以防你的使用超出额度或使用时间超过 60 天。

[https://bit.ly/4b7YZix](https://bit.ly/4b7YZix)

如果该链接无效，你可以尝试使用完整 URL：

[https://www.linode.com/lp/refer/?r=6107b344722dbd6017ea12da672510](https://www.linode.com/lp/refer/?r=6107b344722dbd6017ea12da672510)

如果链接仍然无法使用，我无法提供帮助。在这种情况下，你只能从 linode.com 主页注册，可能无法获得免费额度。无论哪种方式，你都需要创建一个账户并提供付款信息。

### 创建 LKE 集群

创建账户后，访问 [cloud.linode.com](https://cloud.linode.com)，从左侧导航窗格中选择 **Kubernetes**，然后点击 **Create Cluster**（创建集群）按钮。为你的集群提供以下详细信息：

- **Cluster label**：`tkb`
- **Region**：选择离你最近的区域
- **Kubernetes Version**：选择一个较新的版本
- **HA Control Plane**：No
- **Control Plane ACL**：Disabled
- **Add Node Pools**：选择 **Shared CPU**（共享 CPU）选项卡，添加 3 个 Linode 2GB 节点

你的选项将如图 3.2 所示，并会显示预估的集群成本。

**Figure 3.3 - LKE 集群设置**

对集群配置和相关成本满意后，点击 **Create Cluster**（创建集群）按钮。Linode 构建集群可能需要一两分钟。

当所有三个节点在控制台中显示为绿色时，表示 LKE 集群已准备就绪，剩下的唯一任务是配置 `kubectl` 以连接到该集群。

### 配置 kubectl

`kubectl` 是 Kubernetes 命令行工具，你将在所有动手示例中使用它。如果你安装了 Docker Desktop，则已经拥有它。如果没有，请在网上搜索“install kubectl”并按照适用于你的系统的说明进行安装。

重要的是，你安装的 `kubectl` 版本应与你的 Kubernetes 集群版本相差不超过一个次要版本。例如，如果你的集群运行 Kubernetes v1.32.x，你的 `kubectl` 版本不应低于 v1.31.x，也不应高于 v1.33.x。

在后台，`kubectl` 读取你的 kubeconfig 文件，以了解要向哪个集群发送命令以及使用哪些凭据进行身份验证。你的 kubeconfig 文件名为 `config`，根据你的系统位于以下隐藏目录中（你需要配置你的系统以显示隐藏文件夹）：

- macOS：`/Users/<用户名>/.kube/`
- Windows：`C:\Users\<用户名>\.kube\`

根据你是否已有 kubeconfig 文件，完成以下其中一部分步骤。

#### 如果你没有 kubeconfig 文件

只有在确定你的主目录中没有名为 `.kube` 的隐藏文件夹且其中没有名为 `config` 的文件时，才执行以下步骤：

1. 在你的主目录中创建一个名为 `.kube` 的隐藏文件夹（确保包含前导点号）。
2. 将你的 LKE kubeconfig 文件下载到这个新的 `~/.kube` 目录中。
3. 将文件重命名为 `config`。

> [!IMPORTANT]
> 文件名必须是 `config`，不能有任何文件扩展名，如 `.yaml`。你可能需要配置你的系统以显示文件扩展名。

现在你已准备好测试 LKE 集群。

#### 如果你已有 kubeconfig 文件

如果你已有 kubeconfig 文件，请执行以下步骤。你将重命名现有的 kubeconfig 文件，将其内容与 LKE kubeconfig 文件合并，然后使用新的合并版本。

- 将现有的 kubeconfig 文件重命名为 `config-bkp`。
- 从你的 Linode Cloud 控制面板下载 LKE kubeconfig 文件，并将其复制到 `~/.kube` 目录。如果你按照前面的说明构建了 LKE 集群，该文件应命名为 `tkb-kubeconfig.yaml`。如果你的下载文件名称不同，则需要调整下面的一些命令。

运行以下命令，合并两个文件中的配置，并检查是否成功。

```bash
$ export KUBECONFIG=~/.kube/config-bkp:~/.kube/tkb-kubeconfig.yaml
$ kubectl config view
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: DATA+OMITTED
    server: https://127.0.0.1:54225
<Snip>
```

仔细查看，你应该能够在 `clusters`、`users` 和 `contexts` 部分看到你的 LKE 集群详细信息。

运行以下命令，将合并后的配置导出到一个名为 `config` 的新 kubeconfig 文件中，然后设置 `KUBECONFIG` 环境变量以使用该新文件。

```bash
$ kubectl config view --flatten > ~/.kube/config
$ export KUBECONFIG=~/.kube/config
```

最后，设置当前上下文，以便 `kubectl` 命令指向你的 LKE 集群。

如果你安装了 Docker Desktop，你可以通过点击 Docker 鲸鱼图标并从 **Kubernetes Context**（Kubernetes 上下文）选项中选择你的 LKE 上下文，轻松地在上下文之间切换。如果你没有安装 Docker Desktop，可以运行以下命令列出可用的上下文并切换到你的 LKE 上下文。请记住，你的 LKE 上下文名称与我这里的不同。

```bash
$ kubectl config get-contexts
```

# 3: 获取 Kubernetes

```bash
CURRENT   NAME             CLUSTER          AUTHINFO          NAM
*         docker-desktop   docker-desktop   docker-desktop
          lke349416-ctx    lke349416        lke349416-admin   def
$ kubectl config use-context lke349416-ctx
Switched to context "lke349416-ctx".
```

完成这些步骤后，即可进入下一节测试你的 [[LKE (Linode Kubernetes Engine)]] 集群。

## 测试你的 LKE 集群

打开终端并运行以下命令：

```bash
$ kubectl get nodes
NAME                             STATUS    ROLES     AGE    VERSI
lke349416-551020-184a46360000    Ready     <none>    19m    v1.32
lke349416-551020-1c6f99c20000    Ready     <none>    19m    v1.32
lke349416-551020-47ad6c5c0000    Ready     <none>    19m    v1.32
```

你应该看到三个节点，名称都以 `lke`它们还应该在 `ROLES` 列中显示 `<none>`，表明它们都是工作节点。这是因为 Linode 管理着你的控制平面并将其隐藏起来。

如果出现错误，或者你的节点名称不以 `lke` 开头，最可能的原因是 kubeconfig 文件有问题。请回顾之前的步骤，确保你完全按照要求完成。

如果你看到三个名称以 `lke` 开头的节点，就可以继续了。

> [!WARNING] 
> 使用完毕后记得删除你的 LKE 集群，以避免产生不必要的费用。

## 更多关于 kubectl 和 kubeconfig 文件的内容

每次执行 `kubectl` 命令时，它都会执行以下三个步骤：
1. 将命令转换为 HTTP REST 请求
2. 将请求发送到 kubeconfig 文件中 `current-context` 所定义的 Kubernetes 集群
3. 使用 kubeconfig 文件中 `current-context` 所指定的凭据进行身份验证

你的 kubeconfig 文件名为 `config`，位于你主目录下的隐藏文件夹 `.kube` 中。它定义了以下内容：
- **集群 (Clusters)**
- **用户 (Users)**（凭据）
- **上下文 (Contexts)**
- **当前上下文 (Current-context)**

`clusters` 部分是一个已知 Kubernetes 集群的列表，`users` 部分是一个用户凭据的列表，而 `contexts` 部分则是将集群和凭据匹配起来的地方。例如，你可能有一个名为 `ops-prod` 的上下文，它将 `ops` 凭据与 `prod` 集群组合在一起。如果该上下文也被设置为当前上下文，那么 `kubectl` 会将所有命令发送到你的 `prod` 集群，并使用 `ops` 凭据进行身份验证。

以下是一个简单的 kubeconfig 文件示例，其中包含一个名为 `shield` 的集群、一个名为 `coulson` 的用户以及一个名为 `director` 的上下文。`director` 上下文结合了 `coulson` 凭据和 `shield` 集群。它也被设置为默认上下文。

```yaml
apiVersion: v1
kind: Config
clusters:                                    # <<---- 所有已知集群
- name: shield                               # <<---- 友好名称
  cluster:
    server: https://192.168.1.77:8443        # <<---- 集群的 API 服务器地址
    certificate-authority-data: LS0tLS...    # <<---- 集群的证书颁发机构数据
users:                                       # <<---- 用户列表
- name: coulson                              # <<---- 友好名称
  user:
    client-certificate-data: LS0tLS1CRU...   # <<---- 用户证书数据
    client-key-data: LS0tLS1CRUdJTiBFQyB     # <<---- 用户私钥数据
contexts:                                    # <<---- 上下文列表
- context:
  name: director                             # <<---- 上下文名称
    cluster: shield                          # <<---- 将命令发送到该集群
    user: coulson                            # <<---- 使用该用户进行身份验证
current-context: director                    # <<---- kubectl 将使用此上下文
```

你可以运行 `kubectl config view` 命令来查看你的 kubeconfig。该命令会隐藏敏感数据。你也可以运行 `kubectl config current-context` 来查看当前上下文。

以下示例显示了一个系统，该系统配置为将 `kubectl` 命令发送到 `docker-desktop` 上下文所定义的集群和凭据。

```bash
$ kubectl config current-context
docker-desktop
```

如果你安装了 Docker Desktop，可以单击 Docker 鲸鱼图标并从 Kubernetes Context 选项中轻松切换上下文。

## 章节总结

本章向你展示了几种获取 Kubernetes 集群的方法。但实际上还有很多其他选择。

大多数日子里，我使用 Docker Desktop 的多节点 Kubernetes 集群。不过，我也会使用 k3d、[[KinD (Kubernetes in Docker)]] 和 [[minikube]] 在我的笔记本电脑上搭建 Kubernetes 集群。Docker Desktop 的优势在于它附带了全套 Docker 开发工具，并自动安装了 `kubectl`。