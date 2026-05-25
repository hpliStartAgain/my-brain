---
title: "创建 Kubernetes 集群"
date: 2026-05-13
tags: [k3d, KinD, kubectl, Kubernetes, Minikube, 集群]
---

# 第 2 章 创建 Kubernetes 集群

在上一章中，我们学习了 Kubernetes 是什么、它是如何设计的、它支持哪些概念、它的架构以及它支持的各种容器运行时。

从头开始创建一个 Kubernetes 集群并非易事。有许多选项和工具可供选择。有许多因素需要考虑。在本章中，我们将卷起袖子，使用 Minikube、KinD 和 k3d 构建一些 Kubernetes 集群。我们将讨论和评估其他工具，如 Kubeadm 和 Kubespray。我们还将研究部署环境，如本地、云和裸金属。我们将涵盖以下主题：

-   为你的第一个集群做好准备
-   使用 Minikube 创建单节点集群
-   使用 KinD 创建多节点集群
-   使用 k3d 创建多节点集群
-   在云中创建集群
-   从头开始创建裸金属集群
-   回顾创建 Kubernetes 集群的其他选项

在本章结束时，你将深入理解创建 Kubernetes 集群的各种选项，了解支持创建 Kubernetes 集群的最佳工具，并且你还将构建多个集群，包括单节点和多节点集群。

## 为你的第一个集群做好准备

在开始创建集群之前，我们应该安装一些工具，例如 Docker 客户端和 kubectl。如今，在 Mac 和 Windows 上安装 Docker 和 kubectl 最便捷的方式是通过 Rancher Desktop。如果你已经安装了它们，可以跳过本节。

### 安装 Rancher Desktop

Rancher Desktop 是一个跨平台的桌面应用程序，让你可以在本地机器上运行 Docker。它将安装额外的工具，例如：

-   Helm
-   Kubectl
-   Nerdctl
-   Moby（开源 Docker）
-   Docker Compose

#### 在 macOS 上安装

在 macOS 上安装 Rancher Desktop 最简洁的方式是通过 Homebrew：

```
brew install --cask rancher
```

#### 在 Windows 上安装

在 Windows 上安装 Rancher Desktop 最简洁的方式是通过 Chocolatey：

```
choco install rancher-desktop
```

#### 其他安装方法

对于安装 Docker Desktop 的其他方法，请按照此处的说明操作：
https://docs.rancherdesktop.io/getting-started/installation/

让我们验证 docker 是否正确安装。输入以下命令并确保没有看到任何错误（如果你安装的版本与我的不同，输出不必完全相同）：

```
$ docker version
Client:
Version:           20.10.9
API version:       1.41
Go version:        go1.16.8
Git commit:        c2ea9bc
Built:             Thu Nov 18 21:17:06 2021
OS/Arch:           darwin/arm64
Context:           rancher-desktop
Experimental:      true

Server:
Engine:
  Version:          20.10.14
  API version:      1.41 (minimum version 1.12)
  Go version:       go1.17.9
  Git commit:       87a90dc786bda134c9eb02adbae2c6a7342fb7f6
  Built:            Fri Apr 15 00:05:05 2022
  OS/Arch:          linux/arm64
  Experimental:     false
  containerd:
    Version:        v1.5.11
    GitCommit:      3df54a852345ae127d1fa3092b95168e4a88e2f8
    runc:
      Version:      1.0.2
      GitCommit:    52b36a2dd837e8462de8e01458bf02cf9eea47dd
    docker-init:
      Version:      0.19.0
      GitCommit:
```

同时，让我们也验证 kubectl 是否已正确安装：

```
$ kubectl version
Client Version: version.Info{Major:"1", Minor:"23", GitVersion:"v1.23.4",
GitCommit:"e6c093d87ea4cbb530a7b2ae91e54c0842d8308a", GitTreeState:"clean",
BuildDate:"2022-02-16T12:38:05Z", GoVersion:"go1.17.7", Compiler:"gc",
Platform:"darwin/amd64"}
Server Version: version.Info{Major:"1", Minor:"23", GitVersion:"v1.23.6+k3s1",
GitCommit:"418c3fa858b69b12b9cefbcff0526f666a6236b9", GitTreeState:"clean",
BuildDate:"2022-04-28T22:16:58Z", GoVersion:"go1.17.5", Compiler:"gc",
Platform:"linux/arm64"}
```

如果没有任何活跃的 Kubernetes 服务器在运行，Server 部分可能为空。当你看到这个输出时，可以放心 kubectl 已经准备就绪。

### 认识 kubectl

在我们开始创建集群之前，先来谈谈 kubectl。它是官方的 Kubernetes CLI，通过 API 与你的 Kubernetes 集群 API 服务器交互。它默认使用 `~/.kube/config` 文件进行配置，这是一个 YAML 文件，包含一个或多个集群的元数据、连接信息和认证令牌或证书。Kubectl 提供了查看配置和在该配置包含多个集群时切换集群的命令。你也可以通过设置 `KUBECONFIG` 环境变量或传递 `--kubeconfig` 命令行标志来让 kubectl 指向不同的配置文件。

下面的代码使用 kubectl 命令检查当前活跃集群的 `kube-system` 命名空间中的 Pod：

```
$ kubectl get pods -n kube-system
NAME                                          READY   STATUS      RESTARTS      AGE
svclb-traefik-fv84n                           2/2     Running     6 (7d20h ago)     8d
local-path-provisioner-84bb864455-s2xmp       1/1     Running     20 (7d20h ago)   27d
metrics-server-ff9dbcb6c-lsffr                0/1     Running     88 (10h ago)     27d
coredns-d76bd69b-mc6cn                        1/1     Running     11 (22h ago)     8d
traefik-df4ff85d6-2fskv                       1/1     Running     7 (3d ago)       8d
```

Kubectl 很强大，但它并非唯一的选择。让我们看看一些替代工具。

### Kubectl 替代方案——K9S、KUI 和 Lens

Kubectl 是一个简洁的命令行工具。它非常强大，但对一些人来说，直观地解析其输出或记住所有标志和选项可能比较困难或不够方便。社区开发了许多可以替代（或者更像是补充）kubectl 的工具。在我看来，最好的是 K9S、KUI 和 Lens。

#### K9S

K9S 是一个用于管理 Kubernetes 集群的终端 UI。它有许多快捷键和聚合视图，这些功能需要多个 kubectl 命令才能完成。

以下是 K9S 窗口的样子：

![图 2.1: K9S 窗口](ch02-fig01.png)

查看详情：https://k9scli.io

#### KUI

KUI 是一个为 CLI（命令行界面）添加图形界面的框架。这是一个非常有趣的概念。KUI 当然专注于 Kubernetes。它让你运行 Kubectl 命令并以图形形式返回结果。KUI 还收集大量相关信息，并通过选项卡和详细信息面板以简洁的方式呈现，以便深入探索。

KUI 基于 Electron，但速度很快。

以下是 KUI 窗口的样子：

![图 2.2: KUI 窗口](ch02-fig02.png)

查看详情：https://kui.tools

#### Lens

Lens 是一个非常精致的应用程序。它也提供集群的图形视图，允许你从 UI 执行大量操作，并在必要时切换到终端界面。我特别欣赏 Lens 提供的轻松处理多个集群的能力。

以下是 Lens 窗口的样子：

![图 2.3: Lens 窗口](images/ch02-fig03.png)

查看详情：https://k8slens.dev

所有这些工具都在本地运行。我强烈建议你开始使用 kubectl，然后试驾这些工具。其中一款可能正是你的菜。

在本节中，我们介绍了 Rancher Desktop 的安装，介绍了 kubectl，并查看了一些替代工具。我们现在已经准备好创建我们的第一个 Kubernetes 集群了。

## 使用 Minikube 创建单节点集群

在本节中，我们将使用 Minikube 创建一个本地单节点集群。本地集群对于希望在提交更改之前在本地机器上快速进行编辑-测试-部署-调试循环的开发人员最为有用。本地集群对于 DevOps 和运维人员也很有用，他们可以在本地使用 Kubernetes，而无需担心破坏共享环境或在云中创建昂贵的资源却忘记清理。虽然 Kubernetes 通常部署在 Linux 上用于生产环境，但许多开发人员使用 Windows PC 或 Mac。不过，如果你确实想在 Linux 上安装 Minikube，差异也不会太大。

![图 2.4: minikube](images/ch02-fig04.png)

### Minikube 快速介绍

Minikube 是最成熟的本地 Kubernetes 集群。它运行最新的稳定 Kubernetes 版本。它支持 Windows、macOS 和 Linux。Minikube 提供了许多高级选项和功能：

-   负载均衡器服务类型——通过 `minikube tunnel`
-   NodePort 服务类型——通过 `minikube service`
-   多集群
-   文件系统挂载
-   GPU 支持——用于机器学习
-   RBAC
-   持久卷
-   Ingress
-   仪表板——通过 `minikube dashboard`
-   自定义容器运行时——通过 `start --container-runtime` 标志
-   通过命令行标志配置 API 服务器和 kubelet 选项
-   插件

### 安装 Minikube

最终指南在此：https://minikube.sigs.k8s.io/docs/start/
但为了省去你跳转的麻烦，以下是撰写时的最新说明。

#### 在 Windows 上安装 Minikube

在 Windows 上，我更喜欢通过 Chocolatey 包管理器安装软件。如果你还没有安装，可以在这里获取：https://chocolatey.org/
如果你不想使用 Chocolatey，请查看上面的最终指南以获取其他方法。

安装好 Chocolatey 后，安装过程非常简单：

```
PS C:\Windows\system32> choco install minikube -y
Chocolatey v0.12.1
Installing the following packages:
minikube
By installing, you accept licenses for the packages.
Progress: Downloading Minikube 1.25.2... 100%
kubernetes-cli v1.24.0 [Approved]
kubernetes-cli package files install completed. Performing other installation steps.
Extracting 64-bit C:\ProgramData\chocolatey\lib\kubernetes-cli\tools\kubernetesclient-windows-amd64.tar.gz to C:\ProgramData\chocolatey\lib\kubernetes-cli\tools...
C:\ProgramData\chocolatey\lib\kubernetes-cli\tools
Extracting 64-bit C:\ProgramData\chocolatey\lib\kubernetes-cli\tools\kubernetesclient-windows-amd64.tar to C:\ProgramData\chocolatey\lib\kubernetes-cli\tools...
C:\ProgramData\chocolatey\lib\kubernetes-cli\tools
ShimGen has successfully created a shim for kubectl-convert.exe
ShimGen has successfully created a shim for kubectl.exe
The install of kubernetes-cli was successful.
Software installed to 'C:\ProgramData\chocolatey\lib\kubernetes-cli\tools'
Minikube v1.25.2 [Approved]
minikube package files install completed. Performing other installation steps.
ShimGen has successfully created a shim for minikube.exe
The install of minikube was successful.
Software installed to 'C:\ProgramData\chocolatey\lib\Minikube'
Chocolatey installed 2/2 packages.
See the log for details (C:\ProgramData\chocolatey\logs\chocolatey.log).
```

在 Windows 上，你可以在不同的命令行环境中工作。最常见的是 PowerShell 和 WSL（Windows Subsystem for Linux）。两者都可以。某些操作可能需要以管理员模式运行它们。

至于控制台窗口，我目前推荐官方的 Windows Terminal。你可以通过一个命令安装它：

```
choco install microsoft-windows-terminal --pre
```

如果你更喜欢其他控制台窗口，如 ConEMU 或 Cmdr，也完全没问题。

我会使用一些快捷方式来简化操作。如果你想跟着做并将别名复制到你的配置文件中，可以按以下方式为 PowerShell 和 WSL 设置。

对于 PowerShell，将以下内容添加到你的 `$profile`：

```
function k { kubectl.exe $args } function mk { minikube.exe $args }
```

对于 WSL，将以下内容添加到 `.bashrc`：

```
alias k='kubectl.exe'
alias mk=minikube.exe'
```

让我们验证 minikube 是否正确安装：

```
$ mk version
minikube version: v1.25.2
commit: 362d5fdc0a3dbee389b3d3f1034e8023e72bd3a7
```

让我们用 `mk start` 创建一个集群：

```
$ mk start
minikube v1.25.2 on Microsoft Windows 10 Pro 10.0.19044 Build 19044
Automatically selected the docker driver. Other choices: hyperv, ssh
Starting control plane node minikube in cluster minikube
Pulling base image ...
Downloading Kubernetes v1.23.3 preload ...
> preloaded-images-k8s-v17-v1...: 505.68 MiB / 505.68 MiB  100.00% 3.58 MiB
> gcr.io/k8s-minikube/kicbase: 379.06 MiB / 379.06 MiB  100.00% 2.61 MiB p/
Creating docker container (CPUs=2, Memory=8100MB) ...
docker "minikube" container is missing, will recreate.
Creating docker container (CPUs=2, Memory=8100MB) ...
Downloading VM boot image ...
> minikube-v1.25.2.iso.sha256: 65 B / 65 B [-------------] 100.00% ? p/s 0s
> minikube-v1.25.2.iso: 237.06 MiB / 237.06 MiB [ 100.00% 12.51 MiB p/s 19s
Starting control plane node minikube in cluster minikube
Creating hyperv VM (CPUs=2, Memory=6000MB, Disk=20000MB) ...
This VM is having trouble accessing https://k8s.gcr.io
To pull new external images, you may need to configure a proxy: https://minikube.sigs.k8s.io/docs/reference/networking/proxy/
Preparing Kubernetes v1.23.3 on Docker 20.10.12 ...
▪ kubelet.housekeeping-interval=5m
▪ Generating certificates and keys ...
▪ Booting up control plane ...
▪ Configuring RBAC rules ...
Verifying Kubernetes components...
  ▪ Using image gcr.io/k8s-minikube/storage-provisioner:v5
Enabled addons: storage-provisioner, default-storageclass
Done! kubectl is now configured to use "minikube" cluster and "default" namespace by default
```

如你所见，即使对于默认设置，这个过程也相当复杂，并且需要多次重试（自动进行）。你可以通过大量命令行标志来定制集群创建过程。输入 `mk start -h` 查看可用的选项。

让我们检查集群的状态：

```
$ mk status
minikube
type: Control Plane
host: Running
kubelet: Running
apiserver: Running
kubeconfig: Configured
```

一切正常！

现在让我们停止集群，稍后再重新启动：

```
$ mk stop
Stopping node "minikube" ...
Powering off "minikube" via SSH ...
1 node stopped.
```

使用 `time` 命令测量重启需要多长时间：

```
$ time mk start
minikube v1.25.2 on Microsoft Windows 10 Pro 10.0.19044 Build 19044
Using the hyperv driver based on existing profile
Starting control plane node minikube in cluster minikube
Restarting existing hyperv VM for "minikube" ...
This VM is having trouble accessing https://k8s.gcr.io
To pull new external images, you may need to configure a proxy: https://minikube.sigs.k8s.io/docs/reference/networking/proxy/
Preparing Kubernetes v1.23.3 on Docker 20.10.12 ...
▪ kubelet.housekeeping-interval=5m
Verifying Kubernetes components...
  ▪ Using image gcr.io/k8s-minikube/storage-provisioner:v5
Enabled addons: storage-provisioner, default-storageclass
Done! kubectl is now configured to use "minikube" cluster and "default" namespace by default
real    1m8.666s
user    0m0.004s
sys     0m0.000s
```

耗时一分多钟。

让我们回顾一下 Minikube 在幕后为你做了些什么。当你从头开始创建集群时，你也需要做很多这样的事情：

1.  启动了一个 Hyper-V 虚拟机
2.  为本地机器和虚拟机创建了证书
3.  下载了镜像
4.  设置了本地机器和虚拟机之间的网络
5.  在虚拟机上运行了本地 Kubernetes 集群
6.  配置了集群
7.  启动了所有 Kubernetes 控制平面组件
8.  配置了 kubelet
9.  启用了插件（用于存储）
10. 配置了 kubectl 以与集群通信

### 在 macOS 上安装 Minikube

在 Mac 上，我推荐使用 Homebrew 安装 minikube：

```
$ brew install minikube
Running `brew update --preinstall`...
==> Auto-updated Homebrew!
Updated 2 taps (homebrew/core and homebrew/cask).
==> Updated Formulae
Updated 39 formulae.
==> New Casks
contour
rancher-desktop | kube-system
hdfview
==> Updated Casks
Updated 17 casks.
==> Downloading https://ghcr.io/v2/homebrew/core/kubernetes-cli/manifests/1.24.0
######################################################################## 100.0%
==> Downloading https://ghcr.io/v2/homebrew/core/kubernetes-cli/blobs/sha256:e57f8f7ea19d22748d1bcae5cd02b91e71816147712e6dcd
==> Downloading from https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:e57f8f7ea19d22748d1bcae5cd02b91e71816147
######################################################################## 100.0%
==> Downloading https://ghcr.io/v2/homebrew/core/minikube/manifests/1.25.2
Already downloaded: /Users/gigi.sayfan/Library/Caches/Homebrew/downloads/fa0034afe1330adad087a8b3dc9ac4917982d248b08a4df4cbc52ce01d5eabff--minikube-1.25.2.bottle_manifest.json
==> Downloading https://ghcr.io/v2/homebrew/core/minikube/blobs/sha256:6dee5f22e08636346258f4a6daa646e9102e384ceb63f33981745d
Already downloaded: /Users/gigi.sayfan/Library/Caches/Homebrew/downloads/ceeab562206fd08fd3b6523a85b246d48d804b2cd678d76cbae4968d97b5df1f--minikube--1.25.2.arm64_monterey.bottle.tar.gz
==> Installing dependencies for minikube: kubernetes-cli
==> Installing minikube dependency: kubernetes-cli
==> Pouring kubernetes-cli--1.24.0.arm64_monterey.bottle.tar.gz
/opt/homebrew/Cellar/kubernetes-cli/1.24.0: 228 files, 55.3MB
==> Installing minikube
==> Pouring minikube--1.25.2.arm64_monterey.bottle.tar.gz
==> Caveats
zsh completions have been installed to:
  /opt/homebrew/share/zsh/site-functions
==> Summary
/opt/homebrew/Cellar/minikube/1.25.2: 9 files, 70.3MB
==> Running `brew cleanup minikube`...
Disable this behaviour by setting HOMEBREW_NO_INSTALL_CLEANUP.
Hide these hints with HOMEBREW_NO_ENV_HINTS (see `man brew`).
==> Caveats
==> minikube
zsh completions have been installed to:
  /opt/homebrew/share/zsh/site-functions
```

你可以将别名添加到你的 `.bashrc` 文件（类似于 Windows 上的 WSL 别名）：

```
alias k='kubectl'
alias mk='$(brew --prefix)/bin/minikube'
```

现在你可以使用 `k` 和 `mk` 来少打些字了。

输入 `mk version` 验证 Minikube 是否正确安装并正常运行：

```
$ mk version
minikube version: v1.25.2
commit: 362d5fdc0a3dbee389b3d3f1034e8023e72bd3a7
```

输入 `k version` 验证 kubectl 是否正确安装并正常运行：

```
$ k version
I0522 15:41:13.663004   68055 versioner.go:58] invalid configuration: no configuration has been provided
Client Version: version.Info{Major:"1", Minor:"23", GitVersion:"v1.23.4",
GitCommit:"e6c093d87ea4cbb530a7b2ae91e54c0842d8308a", GitTreeState:"clean",
BuildDate:"2022-02-16T12:38:05Z", GoVersion:"go1.17.7", Compiler:"gc",
Platform:"darwin/amd64"}
The connection to the server localhost:8080 was refused - did you specify the right host or port?
```

注意客户端版本是 1.23。不用担心错误信息。目前没有集群在运行，所以 kubectl 无法连接到任何东西。这是预期的。当我们创建集群时，错误信息就会消失。

你可以通过直接输入命令（不带参数）来探索 Minikube 和 kubectl 的可用命令和标志。

要在 macOS 上创建集群，只需运行 `mk start`。

### Minikube 安装故障排除

如果过程中出现问题，请尝试按照错误信息进行排查。你可以添加 `--alsologtostderr` 标志来获取详细错误信息输出到控制台。Minikube 的所有操作都整齐地组织在 `~/.minikube` 目录下。以下是目录结构：

```
$ tree ~/.minikube -L 2
C:\Users\the_g\.minikube\
|-- addons
|-- ca.crt
|-- ca.key
|-- ca.pem
|-- cache
|   |-- iso
|   |-- kic
|   `-- preloaded-tarball
|-- cert.pem
|-- certs
|   |-- ca-key.pem
|   |-- ca.pem
|   |-- cert.pem
|   `-- key.pem
|-- config
|-- files
|-- key.pem
|-- logs
|   |-- audit.json
|   `-- lastStart.txt
|-- machine_client.lock
|-- machines
|   |-- minikube
|   |-- server-key.pem
|   `-- server.pem
|-- profiles
|   `-- minikube
|-- proxy-client-ca.crt
`-- proxy-client-ca.key
13 directories, 16 files
```

如果你没有 `tree` 工具，可以安装它。

在 Windows 上：`$ choco install -y tree`
在 Mac 上：`brew install tree`

### 探索集群

现在我们已经有一个集群在运行，让我们窥探一下内部。

首先，让我们通过 SSH 进入虚拟机：

```
$ mk ssh
_
   ___    ___
  (_)    ___     _
  _    _  _  ( )
 ( )  ( )| |/')
/' _ ` _ `\| |/' _ `\| || , <
_    _  | |_
 __
( ) ( )| '_`\
| ( ) ( ) || || ( ) || || |\`\ | (_) || |_) )(
/'__`\   ___/
(_) (_) (_)(_)(_) (_)(_)(_) (_)`\___/'(_,__/'`\____)
$ uname -a
Linux minikube 4.19.202 #1 SMP Tue Feb 8 19:13:02 UTC 2022 x86_64 GNU/Linux
$
```

太好了！成功了。那些奇怪的符号是"minikube"的 ASCII 艺术画。现在，让我们开始使用 kubectl，因为它是 Kubernetes 的瑞士军刀，对所有集群都很有用。

通过 `ctrl+D` 或输入以下命令断开与虚拟机的连接：

```
$ logout
```

在我们的学习过程中，我们将涵盖许多 kubectl 命令。首先，让我们使用 `cluster-info` 检查集群状态：

```
$ k cluster-info
Kubernetes control plane is running at https://172.26.246.89:8443
CoreDNS is running at https://172.26.246.89:8443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
```

你可以看到控制平面正常运行。要查看集群中所有对象的更详细 JSON 视图，输入：`k cluster-info dump`。输出可能有点令人望而生畏，让我们使用更具体的命令来探索集群。

让我们使用 `get nodes` 查看集群中的节点：

```
$ k get nodes
NAME       STATUS   ROLES                  AGE   VERSION
minikube   Ready    control-plane,master   62m   v1.23.3
```

所以，我们有一个名为 minikube 的节点。要获取关于它的更多信息，输入：

```
k describe node minikube
```

输出很详细，我会让你自己尝试。

在开始让集群工作之前，让我们检查一下 minikube 默认安装的插件：

```
mk addons list
|-----------------------------|----------|--------------|-------------------------------|
| ADDON NAME                  | PROFILE  | STATUS       | MAINTAINER                    |
|-----------------------------|----------|--------------|-------------------------------|
| ambassador                  | minikube | disabled     | third-party (ambassador)      |
| auto-pause                  | minikube | disabled     | google                        |
| csi-hostpath-driver         | minikube | disabled     | kubernetes                    |
| dashboard                   | minikube | disabled     | kubernetes                    |
| default-storageclass        | minikube | enabled      | kubernetes                    |
| efk                         | minikube | disabled     | third-party (elastic)         |
| freshpod                    | minikube | disabled     | google                        |
| gcp-auth                    | minikube | disabled     | google                        |
| gvisor                      | minikube | disabled     | google                        |
| helm-tiller                 | minikube | disabled     | third-party (helm)            |
| ingress                     | minikube | disabled     | unknown (third-party)         |
| ingress-dns                 | minikube | disabled     | google                        |
| istio                       | minikube | disabled     | third-party (istio)           |
| istio-provisioner           | minikube | disabled     | third-party (istio)           |
| kong                        | minikube | disabled     | third-party (Kong HQ)         |
| kubevirt                    | minikube | disabled     | third-party (kubevirt)        |
| logviewer                   | minikube | disabled     | unknown (third-party)         |
| metallb                     | minikube | disabled     | third-party (metallb)         |
| metrics-server              | minikube | disabled     | kubernetes                    |
| nvidia-driver-installer     | minikube | disabled     | google                        |
| nvidia-gpu-device-plugin    | minikube | disabled     | third-party (nvidia)          |
| olm                         | minikube | disabled     | third-party (operator         |
|                             |          |              | framework)                    |
| pod-security-policy         | minikube | disabled     | unknown (third-party)         |
| portainer                   | minikube | disabled     | portainer.io                  |
| registry                    | minikube | disabled     | google                        |
| registry-aliases            | minikube | disabled     | unknown (third-party)         |
| registry-creds              | minikube | disabled     | third-party (upmc enterprises)|
| storage-provisioner         | minikube | enabled      | google                        |
| storage-provisioner-gluster | minikube | disabled     | unknown (third-party)         |
| volumesnapshots             | minikube | disabled     | kubernetes                    |
|-----------------------------|----------|--------------|-------------------------------|
```

如你所见，minikube 预装了大量插件，但默认只启用了几个存储插件。

### 开始工作

在开始之前，如果你运行了 VPN，拉取镜像时可能需要关闭它。

我们有一个漂亮的空集群在运行（嗯，也不是完全空的，DNS 服务和仪表板作为 Pod 运行在 `kube-system` 命名空间中）。是时候部署一些 Pod 了：

```
$ k create deployment echo --image=k8s.gcr.io/e2e-test-images/echoserver:2.5
deployment.apps/echo created
```

让我们检查创建的 Pod。`-w` 标志表示监视。每当状态发生变化时，会显示新的一行：

```
$ k get po -w
NAME                    READY   STATUS              RESTARTS   AGE
echo-7fd7648898-6hh48   0/1     ContainerCreating   0          5s
echo-7fd7648898-6hh48   1/1     Running             0          6s
```

要将我们的 Pod 暴露为服务，输入以下命令：

```
$ k expose deployment echo --type=NodePort --port=8080
service/echo exposed
```

将服务暴露为类型 NodePort 意味着它在某个端口上暴露给宿主机。但这不是我们运行 Pod 的 8080 端口。端口在集群内部被映射。要访问服务，我们需要集群 IP 和暴露的端口：

```
$ mk ip
172.26.246.89
$
k get service echo -o jsonpath='{.spec.ports[0].nodePort}'
32649
```

现在我们可以访问 echo 服务，它会返回大量信息：

```
$ curl http://172.26.246.89:32649/hi

Hostname: echo-7fd7648898-6hh48
Pod Information:
  -no pod information available-
Server values:
  server_version=nginx: 1.14.2 - lua: 10015
Request Information:
  client_address=172.17.0.1
  method=GET
  real path=/hi
  query=
  request_version=1.1
  request_scheme=http
  request_uri=http://172.26.246.89:8080/hi
Request Headers:
  accept=*/*
  host=172.26.246.89:32649
  user-agent=curl/7.79.1
Request Body:
  -no body in request-
```

恭喜！你刚刚创建了一个本地 Kubernetes 集群，部署了一个服务，并将其暴露给了外部世界。

### 通过仪表板查看集群

Kubernetes 有一个非常好的 Web 界面，当然，它是作为一个 Pod 中的服务部署的。仪表板设计得很好，提供了集群的高级概览，还可以深入查看单个资源、查看日志、编辑资源文件等。当你想手动查看集群而又没有 KUI 或 Lens 等本地工具时，它是完美的武器。Minikube 将其作为一个插件提供。

让我们启用它：

```
$ mk addons enable dashboard
▪ Using image kubernetesui/dashboard:v2.3.1
▪ Using image kubernetesui/metrics-scraper:v1.0.7
Some dashboard features require the metrics-server addon. To enable all features please run:
  minikube addons enable metrics-server

The 'dashboard' addon is enabled
```

要启动它，输入：

```
$ mk dashboard
Verifying dashboard health ...
Launching proxy ...
Verifying proxy health ...
Opening http://127.0.0.1:63200/api/v1/namespaces/kubernetes-dashboard/services/http:kubernetes-dashboard:/proxy/ in your default browser...
```

Minikube 将打开一个浏览器窗口，显示仪表板 UI。

以下是 Workloads（工作负载）视图，显示 Deployments、Replica Sets 和 Pods。

![图 2.5: Workloads 仪表板](ch02-fig05.png)

它还可以显示 DaemonSets、StatefulSets 和 Jobs，但在这个集群中我们还没有这些。

要删除我们创建的集群，输入：

```
$ mk delete
Deleting "minikube" in docker ...
Deleting container "minikube" ...
Removing /Users/gigi.sayfan/.minikube/machines/minikube ...
Removed all traces of the "minikube" cluster.
```

在本节中，我们在 Windows 上创建了一个本地单节点 Kubernetes 集群，使用 kubectl 进行了一些探索，部署了一个服务，并使用了 Web UI。在下一节中，我们将转向多节点集群。

## 使用 KinD 创建多节点集群

在本节中，我们将使用 KinD 创建一个多节点集群。我们还将重复部署之前在 Minikube 上部署的 echo 服务器，并观察差异。剧透警告——一切都会更快、更简单！

### KinD 快速介绍

KinD 代表 Kubernetes in Docker。它是一个用于创建临时集群（无持久存储）的工具。它最初是为运行 Kubernetes 一致性测试而构建的。它支持 Kubernetes 1.11+。在底层，它使用 kubeadm 将 Docker 容器引导为集群中的节点。KinD 是一个库和 CLI 的组合。你可以在代码中使用该库进行测试或其他用途。KinD 可以创建具有多个控制平面节点的高可用集群。最后，KinD 是一个 CNCF 认证的 Kubernetes 安装程序。如果它被用于 Kubernetes 本身的一致性测试，那它最好是这样的。

KinD 启动速度极快，但它也有一些限制：

-   无持久存储
-   尚不支持替代运行时，仅支持 Docker

让我们安装 KinD 并开始使用。

### 安装 KinD

你必须安装 Docker，因为 KinD 实际上是以 Docker 容器的方式运行的。如果你安装了 Go，可以通过以下方式安装 KinD CLI：

```
go install sigs.k8s.io/kind@v0.14.0
```

否则，在 macOS 上输入：

```
brew install kind
```

在 Windows 上输入：

```
choco install kind
```

### 处理 Docker 上下文

你的系统上可能有多个 Docker 引擎，Docker 上下文决定了使用哪个引擎。你可能会收到如下错误：

```
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?
```

在这种情况下，请检查你的 Docker 上下文：

```
$ docker context ls
NAME              DESCRIPTION                               DOCKER ENDPOINT                      KUBERNETES ENDPOINT                 ORCHESTRATOR
colima            colima                                    unix:///Users/gigi.sayfan/.colima/docker.sock
default *         Current DOCKER_HOST based configuration   unix:///var/run/docker.sock          https://127.0.0.1:6443 (default)   swarm
rancher-desktop   Rancher Desktop moby context               unix:///Users/gigi.sayfan/.rd/docker.sock  https://127.0.0.1:6443 (default)
```

标有 `*` 的上下文是当前上下文。如果你使用 Rancher Desktop，则应将上下文设置为 rancher-desktop：

```
$ docker context use rancher-desktop
```

### 使用 KinD 创建集群

创建集群非常简单。

```
$ kind create cluster
Creating cluster "kind" ...
 ✓ Ensuring node image (kindest/node:v1.23.4) 🖼
 ✓ Preparing nodes
 ✓ Writing configuration
 ✓ Starting control-plane
 ✓ Installing CNI
 ✓ Installing StorageClass
Set kubectl context to "kind-kind"
You can now use your cluster with:
kubectl cluster-info --context kind-kind
Thanks for using kind!
```

创建单节点集群耗时不到 30 秒。

现在，我们可以使用 kubectl 访问集群：

```
$ k config current-context
kind-kind
$ k cluster-info
Kubernetes control plane is running at https://127.0.0.1:51561
CoreDNS is running at https://127.0.0.1:51561/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
```

KinD 默认将其 kube 上下文添加到默认的 `~/.kube/config` 文件中。当创建大量临时集群时，有时最好将 KinD 上下文存储在单独的文件中，以避免弄乱 `~/.kube/config`。这可以通过传递 `--kubeconfig` 标志并指定文件路径来轻松实现。

所以，KinD 默认创建一个单节点集群：

```
$ k get no
NAME                 STATUS   ROLES                  AGE   VERSION
kind-control-plane   Ready    control-plane,master   4m    v1.23.4
```

让我们删除它，然后创建一个多节点集群：

```
$ kind delete cluster
Deleting cluster "kind" ...
```

要创建多节点集群，我们需要提供一个包含节点规范的配置文件。以下是一个配置文件，它将创建一个名为 `multi-node-cluster` 的集群，包含一个控制平面节点和两个工作节点：

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: multi-node-cluster
nodes:
- role: control-plane
- role: worker
- role: worker
```

让我们将配置文件保存为 `kind-multi-node-config.yaml`，并创建集群，同时将 kubeconfig 存储在自己的文件 `$TMPDIR/kind-multi-node-config` 中：

```
$ kind create cluster --config kind-multi-node-config.yaml --kubeconfig $TMPDIR/kind-multi-node-config
Creating cluster "multi-node-cluster" ...
 ✓ Ensuring node image (kindest/node:v1.23.4) 🖼
 ✓ Preparing nodes
 ✓ Writing configuration
 ✓ Starting control-plane
 ✓ Installing CNI
 ✓ Installing StorageClass
 ✓ Joining worker nodes
Set kubectl context to "kind-multi-node-cluster"
You can now use your cluster with:
kubectl cluster-info --context kind-multi-node-cluster --kubeconfig /var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T//kind-multi-node-config
Have a nice day!
```

是的，成功了！我们在不到一分钟的时间内得到了一个本地 3 节点集群：

```
$ k get nodes --kubeconfig $TMPDIR/kind-multi-node-config
NAME                              STATUS   ROLES                  AGE     VERSION
multi-node-cluster-control-plane   Ready    control-plane,master   2m17s   v1.23.4
multi-node-cluster-worker          Ready    <none>                 100s    v1.23.4
multi-node-cluster-worker2         Ready    <none>                 100s    v1.23.4
```

KinD 还很友好地允许我们创建具有多个控制平面节点的高可用（HA）集群以实现冗余。如果你想要一个包含三个控制平面节点和两个工作节点的高可用集群，你的集群配置文件将非常类似：

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: ha-multi-node-cluster
nodes:
- role: control-plane
- role: control-plane
- role: control-plane
- role: worker
- role: worker
```

让我们将配置文件保存为 `kind-ha-multi-node-config.yaml`，并创建一个新的 HA 集群：

```
$ kind create cluster --config kind-ha-multi-node-config.yaml --kubeconfig $TMPDIR/kind-ha-multi-node-config
Creating cluster "ha-multi-node-cluster" ...
 ✓ Ensuring node image (kindest/node:v1.23.4) 🖼
 ✓ Preparing nodes
 ✓ Configuring the external load balancer
 ✓ Writing configuration
 ✓ Starting control-plane
 ✓ Installing CNI
 ✓ Installing StorageClass
 ✓ Joining more control-plane nodes
 ✓ Joining worker nodes
Set kubectl context to "kind-ha-multi-node-cluster"
You can now use your cluster with:
kubectl cluster-info --context kind-ha-multi-node-cluster --kubeconfig /var/folders/qv/7l781jhs6j19gw3b89f4fcz40000gq/T//kind-ha-multi-node-config
Not sure what to do next?
Check out https://kind.sigs.k8s.io/docs/user/quick-start/
```

嗯......这里有一些新东西。现在 KinD 在加入更多控制平面节点和工作节点之前，还会创建一个外部负载均衡器。负载均衡器对于跨所有控制平面节点分发请求是必要的。

注意，使用 kubectl 时，外部负载均衡器不会显示为节点：

```
$ k get nodes --kubeconfig $TMPDIR/kind-ha-multi-node-config
NAME                                 STATUS   ROLES                  AGE     VERSION
ha-multi-node-cluster-control-plane   Ready    control-plane,master   3m31s   v1.23.4
ha-multi-node-cluster-control-plane2  Ready    control-plane,master   3m19s   v1.23.4
ha-multi-node-cluster-control-plane3  Ready    control-plane,master   2m22s   v1.23.4
ha-multi-node-cluster-worker          Ready    <none>                 2m4s    v1.23.4
ha-multi-node-cluster-worker2         Ready    <none>                 2m5s    v1.23.4
```

但是，KinD 有自己的 `get nodes` 命令，在那里你可以看到负载均衡器：

```
$ kind get nodes --name ha-multi-node-cluster
ha-multi-node-cluster-control-plane2
ha-multi-node-cluster-external-load-balancer
ha-multi-node-cluster-control-plane
ha-multi-node-cluster-control-plane3
ha-multi-node-cluster-worker
ha-multi-node-cluster-worker2
```

我们的 KinD 集群已经启动并运行，让我们让它工作起来。

### 使用 KinD 进行工作

让我们在 KinD 集群上部署 echo 服务。启动方式相同：

```
$ k create deployment echo --image=g1g1/echo-server:0.1 --kubeconfig $TMPDIR/kind-ha-multi-node-config
deployment.apps/echo created
$ k expose deployment echo --type=NodePort --port=7070 --kubeconfig $TMPDIR/kind-ha-multi-node-config
service/echo exposed
```

检查我们的服务，可以看到 echo 服务位于显眼位置：

```
$ k get svc echo --kubeconfig $TMPDIR/kind-ha-multi-node-config
NAME   TYPE       CLUSTER-IP   EXTERNAL-IP   PORT(S)          AGE
echo   NodePort   10.96.52.33  <none>        7070:31953/TCP   10s
```

但是，服务没有外部 IP。使用 minikube 时，我们通过 `$(minikube ip)` 获取 minikube 节点本身的 IP，并结合节点端口来访问服务。这在 KinD 集群中是不可行的。让我们看看如何使用代理来访问 echo 服务。

### 通过代理在本地访问 Kubernetes 服务

我们将在本书后面的章节中详细讨论网络、服务以及如何在集群外部暴露它们。

在这里，我们只展示如何实现这一点，让你保持期待。首先，我们需要运行 `kubectl proxy` 命令，该命令在 localhost 上暴露 API 服务器、Pod 和服务：

```
$ k proxy --kubeconfig $TMPDIR/kind-ha-multi-node-config &
[1] 32479
Starting to serve on 127.0.0.1:8001
```

然后，我们可以通过一个特制的代理 URL 来访问 echo 服务，该 URL 包含暴露的端口（8080），而不是节点端口：

```
$ http http://localhost:8001/api/v1/namespaces/default/services/echo:7070/proxy/yeah-it-works
HTTP/1.1 200 OK
Audit-Id: 294cf10b-0d60-467d-8a51-4414834fc173
Cache-Control: no-cache, private
Content-Length: 13
Content-Type: text/plain; charset=utf-8
Date: Mon, 23 May 2022 21:54:01 GMT
yeah-it-works
```

我在上面的命令中使用了 httpie。你也可以使用 curl。要安装 httpie，请按照此处的说明操作：https://httpie.org/doc#installation。

我们将在第 10 章《探索 Kubernetes 网络》中深入探讨具体原理。目前，演示 `kubectl proxy` 如何允许我们访问 KinD 服务就足够了。

让我们看看我最喜欢的本地集群解决方案——k3d。

## 使用 k3d 创建多节点集群

在本节中，我们将使用 Rancher 的 k3d 创建一个多节点集群。我们不会重复部署 echo 服务器，因为它与 KinD 集群完全一样，包括通过代理访问。剧透警告——使用 k3d 创建集群比 KinD 更快、更友好！

### k3s 和 k3d 快速介绍

Rancher 创建了 k3s，这是一个轻量级的 Kubernetes 发行版。Rancher 说 k3s 比 k8s 少了 5 个字母，如果你觉得这说得通的话。其基本思想是移除大多数人不需要的特性和功能，例如：

-   非默认特性
-   遗留特性
-   Alpha 特性
-   树内存储驱动
-   树内云提供商

K3s 完全移除了 Docker，转而使用 containerd。如果你依赖 Docker，你仍然可以把它带回来。另一个重大变化是 k3s 将其状态存储在 SQLite 数据库中，而不是 etcd。对于网络和 DNS，k3s 使用 Flannel 和 CoreDNS。

K3s 还添加了一个简化的安装程序，负责处理 SSL 和证书配置。

最终结果令人惊讶——一个单二进制文件（不到 40MB），只需要 512MB 内存。

与 Minikube 和 KinD 不同，k3s 实际上是为生产环境设计的。主要用例是边缘计算、物联网和 CI 系统。它针对 ARM 设备进行了优化。

好。那是 k3s，但 k3d 是什么？K3d 将 k3s 的所有优点封装到 Docker 中（类似于 KinD），并添加了一个友好的 CLI 来管理它。

让我们安装 k3d 并亲自看看。

### 安装 k3d

在 macOS 上安装 k3d 非常简单：

```
brew install k3d
```

在 Windows 上，只需：

```
choco install -y k3d
```

在 Windows 上，可以选择将此别名添加到你的 WSL `.bashrc` 文件中：

```
alias k3d='k3d.exe'
```

让我们看看我们得到了什么：

```
$ k3d version
k3d version v5.4.1
k3s version v1.22.7-k3s1 (default)
```

如你所见，k3d 报告了其版本，一切正常。现在，我们可以用 k3d 创建一个集群。

### 使用 k3d 创建集群

你准备好被惊艳了吗？使用 k3d 创建单节点集群耗时不到 20 秒！

```
$ time k3d cluster create
INFO[0000] Prep: Network
INFO[0000] Created network 'k3d-k3s-default'
INFO[0000] Created image volume k3d-k3s-default-images
INFO[0000] Starting new tools node...
INFO[0000] Starting Node 'k3d-k3s-default-tools'
INFO[0001] Creating node 'k3d-k3s-default-server-0'
INFO[0001] Creating LoadBalancer 'k3d-k3s-default-serverlb'
INFO[0002] Using the k3d-tools node to gather environment information
INFO[0002] HostIP: using network gateway 172.19.0.1 address
INFO[0002] Starting cluster 'k3s-default'
INFO[0002] Starting servers...
INFO[0002] Starting Node 'k3d-k3s-default-server-0'
INFO[0008] All agents already running.
INFO[0008] Starting helpers...
INFO[0008] Starting Node 'k3d-k3s-default-serverlb'
INFO[0015] Injecting records for hostAliases (incl. host.k3d.internal) and for 2 network members into CoreDNS configmap...
INFO[0017] Cluster 'k3s-default' created successfully!
INFO[0018] You can now use it like this:
kubectl cluster-info
real    0m18.154s
user    0m0.005s
sys     0m0.000s
```

没有负载均衡器的话，耗时不到 8 秒！

那多节点集群呢？我们看到 KinD 慢得多，尤其是创建具有多个控制平面节点和外部负载均衡器的 HA 集群时。

让我们先删除单节点集群：

```
$ k3d cluster delete
INFO[0000] Deleting cluster 'k3s-default'
INFO[0000] Deleting cluster network 'k3d-k3s-default'
INFO[0000] Deleting 2 attached volumes...
WARN[0000] Failed to delete volume 'k3d-k3s-default-images' of cluster 'k3s-default': failed to find volume 'k3d-k3s-default-images': Error: No such volume: k3d-k3s-default-images -> Try to delete it manually
INFO[0000] Removing cluster details from default kubeconfig...
INFO[0000] Removing standalone kubeconfig file (if there is one)...
INFO[0000] Successfully deleted cluster k3s-default!
```

现在，让我们创建一个包含 3 个工作节点的集群。这耗时略超过 30 秒：

```
$ time k3d cluster create --agents 3
INFO[0000] Prep: Network
INFO[0000] Created network 'k3d-k3s-default'
INFO[0000] Created image volume k3d-k3s-default-images
INFO[0000] Starting new tools node...
INFO[0000] Starting Node 'k3d-k3s-default-tools'
INFO[0001] Creating node 'k3d-k3s-default-server-0'
INFO[0001] Creating node 'k3d-k3s-default-agent-0'
INFO[0002] Creating node 'k3d-k3s-default-agent-1'
INFO[0002] Creating node 'k3d-k3s-default-agent-2'
INFO[0002] Creating LoadBalancer 'k3d-k3s-default-serverlb'
INFO[0002] Using the k3d-tools node to gather environment information
INFO[0002] HostIP: using network gateway 172.22.0.1 address
INFO[0002] Starting cluster 'k3s-default'
INFO[0002] Starting servers...
INFO[0002] Starting Node 'k3d-k3s-default-server-0'
INFO[0008] Starting agents...
INFO[0008] Starting Node 'k3d-k3s-default-agent-0'
INFO[0008] Starting Node 'k3d-k3s-default-agent-2'
INFO[0008] Starting Node 'k3d-k3s-default-agent-1'
INFO[0018] Starting helpers...
INFO[0019] Starting Node 'k3d-k3s-default-serverlb'
INFO[0029] Injecting records for hostAliases (incl. host.k3d.internal) and for 5 network members into CoreDNS configmap...
INFO[0032] Cluster 'k3s-default' created successfully!
INFO[0032] You can now use it like this:
kubectl cluster-info
real    0m32.512s
user    0m0.005s
sys     0m0.000s
```

让我们验证集群是否按预期工作：

```
$ k cluster-info
Kubernetes control plane is running at https://0.0.0.0:60490
CoreDNS is running at https://0.0.0.0:60490/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
Metrics-server is running at https://0.0.0.0:60490/api/v1/namespaces/kube-system/services/https:metrics-server:https/proxy
To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.
```

以下是节点。注意只有一个名为 `k3d-k3s-default-server-0` 的控制平面节点：

```
$ k get nodes
NAME                       STATUS   ROLES                  AGE     VERSION
k3d-k3s-default-server-0   Ready    control-plane,master   5m33s   v1.22.7+k3s1
k3d-k3s-default-agent-0    Ready    <none>                 5m30s   v1.22.7+k3s1
k3d-k3s-default-agent-2    Ready    <none>                 5m30s   v1.22.7+k3s1
k3d-k3s-default-agent-1    Ready    <none>                 5m29s   v1.22.7+k3s1
```

你可以使用 k3d CLI 停止和启动集群、创建多个集群以及列出现有集群。以下是所有命令。请随意进一步探索：

```
$ k3d
Usage:
  k3d [flags]
  k3d [command]

Available Commands:
  cluster           Manage cluster(s)
  completion        Generate completion scripts for [bash, zsh, fish, powershell | psh]
  config            Work with config file(s)
  help              Help about any command
  image             Handle container images.
  kubeconfig        Manage kubeconfig(s)
  node              Manage node(s)
  registry          Manage registry/registries
  version           Show k3d and default k3s version

Flags:
  -h, --help       help for k3d
      --timestamps Enable Log timestamps
      --trace      Enable super verbose output (trace logging)
      --verbose    Enable verbose output (debug logging)
      --version    Show k3d and default k3s version

Use "k3d [command] --help" for more information about a command.
```

你可以自行重复部署、暴露和访问 echo 服务的步骤。它的工作方式与 KinD 完全相同。

好了。我们使用 Minikube、KinD 和 k3d 创建了集群。让我们比较一下它们，以便你决定哪个适合你。

### 比较 Minikube、KinD 和 k3d

Minikube 是一个官方的本地 Kubernetes 发行版。它非常成熟且功能齐全。也就是说，它需要一个虚拟机，并且安装和启动都很慢。它还可能随时出现网络问题，有时候唯一的解决办法就是删除集群并重新启动。此外，Minikube 只支持单节点。我建议仅在需要 Minikube 支持而 KinD 或 k3d 没有的某些特性时才使用它。更多信息请参见 https://minikube.sigs.k8s.io/。

KinD 比 Minikube 快得多，并且用于 Kubernetes 一致性测试，所以按照定义，它是一个符合标准的 Kubernetes 发行版。它是唯一提供具有多个控制平面节点的 HA 集群的本地集群解决方案。它还被设计为可以用作库，我个人认为这不是一个很大的吸引力，因为从代码中自动化 CLI 非常容易。KinD 在本地开发方面的主要缺点是它是临时的。如果你为 Kubernetes 本身做贡献并希望针对它进行测试，我推荐使用 KinD。参见 https://kind.sigs.k8s.io/。

K3d 对我来说是明确的赢家。闪电般的速度，支持多个集群和每个集群多个工作节点。轻松停止和启动集群而不会丢失状态。参见 https://k3d.io/。

### 值得提及——Rancher Desktop Kubernetes 集群

我使用 Rancher Desktop 作为我的 Docker 引擎提供商，但它也带有一个内置的 Kubernetes 集群。你不能自定义它，也不能在同一个集群中拥有多个集群甚至多个节点。但是，如果你只需要一个本地单节点 Kubernetes 集群来玩耍，那么 rancher-desktop 集群就在那里等着你。

要使用这个集群，输入：

```
$ kubectl config use-context rancher-desktop
Switched to context "rancher-desktop".
```

你可以决定为其节点分配多少资源，这一点很重要，如果你试图在其上部署大量工作负载，因为你只有一个节点。

![图 2.6: Rancher Desktop – Kubernetes 设置](ch02-fig06.png)

在本节中，我们介绍了使用 Minikube、KinD 和 K3d 在本地创建 Kubernetes 集群。在下一节中，我们将研究在云中创建集群。

## 在云中创建集群（GCP、AWS、Azure 和 Digital Ocean）

在本地创建集群很有趣。在开发和尝试在本地排查问题时也很重要。但是，归根结底，Kubernetes 是为云原生应用（在云中运行的应用程序）而设计的。Kubernetes 不希望感知各个云环境，因为这无法扩展。相反，Kubernetes 有云提供商接口（cloud-provider interface）的概念。每个云提供商都可以实现这个接口，然后托管 Kubernetes。

### 云提供商接口

云提供商接口是一组 Go 数据类型和接口。它定义在一个名为 `cloud.go` 的文件中，可在 https://github.com/kubernetes/cloud-provider/blob/master/cloud.go 获取。

以下是主接口：

```go
type Interface interface {
    Initialize(clientBuilder ControllerClientBuilder, stop <-chan struct{})
    LoadBalancer() (LoadBalancer, bool)
    Instances() (Instances, bool)
    InstancesV2() (InstancesV2, bool)
    Zones() (Zones, bool)
    Clusters() (Clusters, bool)
    Routes() (Routes, bool)
    ProviderName() string
    HasClusterID() bool
}
```

这非常清晰。Kubernetes 以实例、区域、集群和路由的方式运作，同时还需要访问负载均衡器和提供商名称。主接口主要是一个网关。上面 `Interface` 接口的大多数方法返回其他接口。

例如，`Clusters()` 方法返回 `Cluster` 接口，它非常简单：

```go
type Clusters interface {
    ListClusters(ctx context.Context) ([]string, error)
    Master(ctx context.Context, clusterName string) (string, error)
}
```

`ListClusters()` 方法返回集群名称。`Master()` 方法返回集群控制平面的 IP 地址或 DNS 名称。

其他接口也并不复杂得多。（在撰写时）整个文件只有 313 行，包括大量注释。关键信息是，如果你的云利用这些基本概念，实现一个 Kubernetes 提供商并不太复杂。

### 在云中创建 Kubernetes 集群

在我们查看云提供商及其对托管和非托管 Kubernetes 的支持之前，让我们考虑一下应该如何创建和维护集群。如果你承诺使用单个云提供商，并且乐意使用他们的工具，那么你就没问题。所有云提供商都允许你通过 Web UI、CLI 或 API 创建和配置 Kubernetes 集群。然而，如果你更喜欢更通用的方法，并希望使用 GitOps 来管理你的集群，你应该研究基础设施即代码解决方案，如 Terraform 和 Pulumi。

如果你更愿意在云中部署非托管的 Kubernetes 集群，那么 kOps 是一个强有力的候选方案。参见：https://kops.sigs.k8s.io。

稍后，在第 17 章《在生产环境中运行 Kubernetes》中，我们将详细讨论多集群配置和管理的主题。这个领域有很多技术、开源项目和商业产品。

现在，让我们看看各个云提供商。

#### GCP

Google Cloud Platform（GCP）开箱即用地支持 Kubernetes。所谓的 Google Kubernetes Engine（GKE）是一个建立在 Kubernetes 之上的容器管理解决方案。你不需要在 GCP 上安装 Kubernetes，你可以使用 Google Cloud API 创建 Kubernetes 集群并进行配置。Kubernetes 是 GCP 内置部分这一事实意味着它将始终得到良好的集成和测试，并且你不必担心底层平台的变化会破坏云提供商接口。

如果你更倾向于自己管理 Kubernetes，那么你可以直接在 GCP 实例上部署它（或使用 kOps 对 GCP 的 alpha 支持），但我通常建议不要这样做，因为 GKE 为你做了大量工作，并且它与 GCP 的计算、网络和核心服务深度集成。

总而言之，如果你计划将系统建立在 Kubernetes 之上，并且你没有任何其他云平台的现有代码，那么 GCP 是一个可靠的选择。它在成熟度、完善度以及与 GCP 服务的集成深度方面处于领先地位，并且通常是最先更新到较新版本 Kubernetes 的云平台。我在 GKE 上花了大量时间使用 Kubernetes，管理数十个集群，升级它们并部署工作负载。GKE 绝对是生产级的 Kubernetes。

#### GKE Autopilot

GKE 还有 Autopilot 项目，它为你管理工作节点和节点池，因此你可以专注于部署和配置工作负载。

参见：https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview

#### AWS

AWS 有自己的容器管理服务叫 ECS，它不是基于 Kubernetes 的。它还有一个托管的 Kubernetes 服务叫 EKS。你也可以在 AWS EC2 实例上自行运行 Kubernetes。

首先让我们谈谈如何自行搭建 Kubernetes，然后我们再讨论 EKS。

##### 在 EC2 上运行 Kubernetes

AWS 从一开始就是一个受支持的云提供商。有大量关于如何设置它的文档。虽然你可以自己配置一些 EC2 实例并使用 kubeadm 创建集群，但我建议使用前面提到的 kOps（Kubernetes Operations）项目。kOps 最初只支持 AWS，通常被认为是（不使用 EKS 的情况下）在 AWS 上自行配置 Kubernetes 集群的最经过实战检验且功能最丰富的工具。

它支持以下特性：

-   云（AWS）上 Kubernetes 集群的自动化 CRUD
-   高可用 Kubernetes 集群
-   使用状态同步模型实现 dry-run 和自动幂等性
-   对 kubectl 插件的自定义支持
-   kOps 可以生成 Terraform 配置
-   基于目录树中定义的简单元模型
-   简单的命令行语法
-   社区支持

要创建集群，你需要做一些 IAM 和 DNS 配置，设置一个 S3 存储桶来存储集群配置，然后运行一个命令：

```
kops create cluster \
  --name=${NAME} \
  --cloud=aws \
  --zones=us-west-2a \
  --discovery-store=s3://prefix-example-com-oidc-store/${NAME}/discovery
```

完整的说明在此：https://kops.sigs.k8s.io/getting_started/aws/

2017 年底，AWS 加入了 CNCF，并发布了两项关于 Kubernetes 的重大公告：其自家的基于 Kubernetes 的容器编排解决方案（EKS）和容器按需解决方案（Fargate）。

##### Amazon EKS

Amazon Elastic Kubernetes Service（EKS）是一个完全托管的高可用 Kubernetes 解决方案。它在三个可用区（AZ）中运行三个控制平面节点。EKS 还负责升级和打补丁。

EKS 的一大优点是它运行标准 Kubernetes。这意味着你可以使用社区开发的所有标准插件和工具。它还为你与其他云提供商和/或你自己的本地 Kubernetes 集群进行便捷的集群联合打开了大门。

EKS 提供与 AWS 基础设施的深度集成，例如 IAM 认证，它与基于角色的访问控制（RBAC）集成。

如果你想直接从自己的 Amazon VPC 访问 Kubernetes masters，你还可以使用 PrivateLink。使用 PrivateLink，你的 Kubernetes 控制平面和 Amazon EKS 服务端点在你的 Amazon VPC 中显示为具有私有 IP 地址的弹性网络接口。

另一个重要的部分是一个特殊的 CNI 插件，它让你的 Kubernetes 组件能够使用 AWS 网络相互通信。

EKS 在不断改进，Amazon 已经证明它致力于保持其最新并不断改进。如果你是一个 AWS 用户并且正在进入 Kubernetes 领域，我建议从 EKS 开始，而不是自己构建集群。

`eksctl` 工具是一个很好的 CLI，用于创建和管理测试和开发用的 EKS 集群和节点组。我使用 eksctl 成功地在 AWS 上创建、删除多个 Kubernetes 集群并添加节点。参见 https://eksctl.io/。

##### Fargate

Fargate 让你可以直接运行容器，而无需担心硬件配置。它消除了运营复杂性的很大一部分，代价是失去一些控制。使用 Fargate 时，你将应用程序打包到容器中，指定 CPU 和内存需求，定义网络和 IAM 策略，然后就可以开始了。Fargate 可以运行在 ECS 和 EKS 之上。它是无服务器阵营中一个非常有趣的成员，尽管它不像 GKE 的 Autopilot 那样专属于 Kubernetes。

#### Azure

Azure 过去有自己的基于 Mesos 的 DC/OS 或 Docker Swarm 的容器管理服务来管理你的容器。但当然你也可以使用 Kubernetes。你也可以自己配置集群（例如，使用 Azure 的期望状态配置），然后使用 kubeadm 创建 Kubernetes 集群。kOps 对 Azure 有 alpha 支持，Kubespray 项目也是一个不错的选择。

然而，在 2017 年下半年，Azure 也加入了 Kubernetes 的行列，并推出了 AKS（Azure Kubernetes Service）。它类似于 Amazon EKS，尽管在实现上稍领先一步。

AKS 提供 Web UI、CLI 和 REST API 来管理你的 Kubernetes 集群。一旦 AKS 集群配置完成，你可以直接使用 kubectl 和任何其他 Kubernetes 工具。

以下是使用 AKS 的一些好处：

-   自动化的 Kubernetes 版本升级和打补丁
-   轻松集群扩缩容
-   自我修复的托管控制平面（masters）
-   成本节省——只需为运行的代理节点池付费

AKS 还提供与 Azure Container Instances（ACI）的集成，类似于 AWS Fargate 和 GKE AutoPilot。这意味着不仅你的 Kubernetes 集群的控制平面是托管的，工作节点也是托管的。

#### Digital Ocean

Digital Ocean 不是与三大云提供商（GCP、AWS、Azure）同一级别的云提供商，但它确实提供托管的 Kubernetes 解决方案，并且它在全球（美国、加拿大、欧洲、亚洲）都有数据中心。它也比其他替代方案便宜得多，而成本是选择云提供商时的一个主要决定因素。使用 Digital Ocean，控制平面不收费。除了更低的价格，Digital Ocean 的卖点是简单。

DOKS（Digital Ocean Kubernetes Service）为你提供一个托管的 Kubernetes 控制平面（可以是高可用的），并与 Digital Ocean 的 droplets（用于节点和节点池）、负载均衡器和块存储卷集成。这涵盖了所有基本需求。你的集群当然是 CNCF 认证的。

Digital Ocean 将负责系统升级、安全补丁以及控制平面和工作节点上的已安装包。

#### 其他云提供商

GCP、AWS 和 Azure 处于领先地位，但还有相当多的其他公司提供托管的 Kubernetes 服务。总的来说，如果你已经与这些提供商有重要的业务联系或集成，我建议使用它们。

##### 曾经在中国

如果你在中国运营，有特殊的约束和限制，你应该使用中国的云平台。主要有三个：阿里云、腾讯云和华为云。

中国的阿里云是云平台领域的新星。它非常紧密地模仿 AWS，尽管其英文文档还有很多不足之处。阿里云通过其 ACK（Alibaba Container service for Kubernetes）以多种方式支持 Kubernetes，允许你：

-   运行你自己的专用 Kubernetes 集群（你必须创建 3 个 master 节点并自行升级和维护）
-   使用托管的 Kubernetes 集群（你只需负责工作节点）
-   通过 ECI（Elastic Container Instances）使用无服务器 Kubernetes 集群，类似于 Fargate 和 ACI

ACK 是一个 CNCF 认证的 Kubernetes 发行版。如果你需要在中国部署云原生应用，ACK 看起来是一个可靠的选择。

参见 https://www.alibabacloud.com/product/kubernetes

腾讯是另一家大型中国公司，拥有自己的云平台和 Kubernetes 支持。TKE（Tencent Kubernetes Engine）看起来不如 ACK 成熟。参见 https://intl.cloud.tencent.com/products/tke

最后，华为云平台提供 CCE（Cloud Container Engine），它建立在 Kubernetes 之上。它支持虚拟机、裸金属和 GPU 加速实例。参见 https://www.huaweicloud.com/intl/en-us/product/cce.html

##### IBM Kubernetes 服务

IBM 正在大力投资 Kubernetes。它在 2018 年底收购了 Red Hat。Red Hat 当然是 Kubernetes 世界的主要参与者，构建了其基于 Kubernetes 的 OpenShift 平台，并为 Kubernetes 贡献了 RBAC。IBM 有自己的云平台，并提供托管的 Kubernetes 集群。你可以用 200 美元的信用额度免费试用，还有一个免费层。

IBM 还参与了 Istio 和 Knative 的开发，因此你可以期待 IKS 与这些技术深度集成。

IKS 提供与许多 IBM 服务的集成。

参见 https://www.ibm.com/cloud/kubernetes-service

##### Oracle Container Service

Oracle 也有一个云平台，当然，它也提供托管的 Kubernetes 服务，具有高可用性、裸金属实例和多可用区支持。

OKE 支持 ARM 和 GPU 实例，还提供几个控制平面选项。

参见 https://www.oracle.com/cloud/cloud-native/container-engine-kubernetes/

在本节中，我们介绍了云提供商接口，并研究了在各种云提供商上创建 Kubernetes 集群的推荐方法。这个领域还很年轻，工具也在快速发展。我相信很快会发生融合。Kubeadm 已经成熟，是许多其他在云上和云下引导和创建 Kubernetes 集群的工具的基础。现在让我们考虑一下创建裸金属集群需要什么，在那里你必须自己配置硬件、底层网络和存储。

## 从头开始创建裸金属集群

在上一节中，我们研究了在云提供商上运行 Kubernetes。这是 Kubernetes 的主要部署场景。但是，在裸金属上运行 Kubernetes 也有很强的用例，例如边缘计算上的 Kubernetes。我们这里不关注托管与本地部署。这是另一个维度。如果你已经在本地管理大量服务器，那么你最有发言权。

### 裸金属的用例

裸金属集群处理起来很麻烦，尤其是如果你自己管理的话。有些公司为裸金属 Kubernetes 集群提供商业支持，例如 Platform 9，但这些产品还不够成熟。一个可靠的开源选项是 Kubespray，它可以在裸金属、AWS、GCE、Azure 和 OpenStack 上部署工业级 Kubernetes 集群。

以下是一些有意义的用例：

-   **价格**：如果你已经在管理大规模的裸金属集群，在你的物理基础设施上运行 Kubernetes 集群可能便宜得多
-   **低网络延迟**：如果你的节点之间必须低延迟，那么 VM 的开销可能太大
-   **监管要求**：如果你必须遵守法规，你可能不允许使用云提供商
-   **你想要对硬件的完全控制**：云提供商给了你很多选择，但你可能有一些特殊需求

### 何时应考虑创建裸金属集群？

从头开始创建集群的复杂性是巨大的。Kubernetes 集群不是一个简单的怪物。网上有很多关于如何设置裸金属集群的文档，但随着整个生态系统的发展，许多指南很快就会过时。

如果你有能力在堆栈的每一层排查问题，你应该考虑走这条路。大多数问题可能与网络有关，但文件系统和存储驱动也可能给你带来麻烦，以及 Kubernetes 本身、Docker（或其他运行时，如果你使用的话）、镜像、你的操作系统、你的操作系统内核以及你使用的各种插件和工具之间的一般不兼容性和版本不匹配。如果你选择在裸金属上使用虚拟机，那么你又增加了一层复杂性。

### 理解流程

有很多事情要做。以下是一些你需要解决的问题：

-   实现你自己的云提供商接口或绕过它
-   选择网络模型及其实现方式（CNI 插件、直接编译）
-   是否使用网络策略
-   为系统组件选择镜像
-   安全模型和 SSL 证书
-   管理员凭证
-   API Server、replication controller 和 scheduler 等组件的模板
-   集群服务：DNS、日志记录、监控和 GUI

我推荐以下来自 Kubernetes 站点的指南，以更深入地了解使用 kubeadm 从头创建 HA 集群需要什么：
https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/

### 使用 Cluster API 管理裸金属集群

Cluster API（又称 CAPI）是一个 Kubernetes 子项目，用于大规模管理 Kubernetes 集群。它使用 kubeadm 进行配置。它可以使用提供商在任何环境中配置和管理 Kubernetes 集群。在工作中，我们使用它在云中管理多个集群。但是，它有针对裸金属集群的多个提供商：

-   MAAS
-   Equinix Metal
-   Metal3
-   Cidero

参见 https://cluster-api.sigs.k8s.io

### 使用虚拟私有云基础设施

如果你的用例属于裸金属用例，但你没有必要的熟练人力或意愿来处理裸金属的基础设施挑战，你可以选择使用私有云，例如 OpenStack。如果你想在抽象阶梯上再往上走一点，Mirantis 提供了一个基于 OpenStack 和 Kubernetes 构建的云平台。

让我们再回顾一些在裸金属上构建 Kubernetes 集群的工具。其中一些工具也支持 OpenStack。

### 使用 Kubespray 构建你自己的集群

Kubespray 是一个用于部署生产就绪的高可用 Kubernetes 集群的项目。它使用 Ansible，可以在大量目标上部署 Kubernetes，例如：

-   AWS
-   GCE
-   Azure
-   OpenStack
-   vSphere
-   Equinix Metal
-   Oracle Cloud Infrastructure（实验性）

它也用于在纯裸金属机器上部署 Kubernetes 集群。

它具有高度可定制性，支持节点的多种操作系统、多种用于网络的 CNI 插件以及多种容器运行时。

如果你想在本地测试它，它也可以部署到多节点 vagrant 环境中。如果你是 Ansible 爱好者，Kubespray 可能是一个很好的选择。

参见 https://kubespray.io

### 使用 Rancher RKE 构建你的集群

Rancher Kubernetes Engine（RKE）是一个友好的 Kubernetes 安装程序，可以在裸金属以及虚拟化服务器上安装 Kubernetes。RKE 旨在解决安装 Kubernetes 的复杂性。它是开源的，并有很好的文档。在此查看：http://rancher.com/docs/rke/v0.1.x/en/

### 在裸金属或虚拟机上运行托管 Kubernetes

云提供商并不想将自己局限在自家的云上。他们都提供多云和混合解决方案，你可以在多个云以及任何地方的虚拟机上控制 Kubernetes 集群并使用他们的托管控制平面。

#### GKE Anthos

Anthos 是一个全面的托管平台，便于应用程序的部署，涵盖传统和云原生环境。它使你能够构建和监管全球应用程序集群，同时确保它们之间的运营一致性。

#### EKS Anywhere

Amazon EKS Anywhere 为 Amazon EKS 提供了一种新的部署选项，使你能够在自己的基础设施上建立和管理 Kubernetes 集群，并获得 AWS 支持。它让你可以灵活地在自己本地基础设施上运行 Amazon EKS Anywhere，利用 VMware vSphere 以及裸金属环境。

#### AKS Arc

Azure Arc 包含一系列技术，将 Azure 的安全性和云原生服务扩展到混合和多云环境。它使你能够跨多个位置保护和管理你的基础设施和应用程序，同时提供熟悉的工具和服务来加速云原生应用的开发。这些应用随后可以部署在任何 Kubernetes 平台上。

在本节中，我们介绍了创建裸金属 Kubernetes 集群，这给了你完全的控制权，但极其复杂，需要大量的精力和知识。幸运的是，有多种工具、项目和框架可以帮助你。

## 总结

在本章中，我们进行了一些实际的集群创建操作。我们使用 Minikube、KinD 和 k3d 等工具创建了单节点和多节点集群。然后我们研究了在云提供商上创建 Kubernetes 集群的各种选项。最后，我们触及了在裸金属上创建 Kubernetes 集群的复杂性。目前的状况非常动态。基本组件正在快速变化，工具越来越好，每个环境都有不同的选项。Kubeadm 现在是大多数安装选项的基石，这对于一致性和集中精力来说是很好的。自己搭建一个 Kubernetes 集群仍然不是完全微不足道的，但付出一些努力并注意细节，你可以很快完成。

我强烈推荐考虑将 Cluster API 作为在任何环境（托管、私有云、虚拟机和裸金属）中配置和管理集群的首选解决方案。我们将在第 17 章《在生产环境中运行 Kubernetes》中深入讨论 Cluster API。

在下一章中，我们将探讨可扩展性和高可用性的重要主题。一旦你的集群启动并运行，你需要确保即使请求量增加也能保持正常运行。这需要持续的关注，并建立从故障中恢复以及适应流量变化的能力。

## 加入我们的 Discord！

与本书的其他读者、云专家、作者和志同道合的专业人士一起阅读。
提问、为其他读者提供解决方案、通过"问我任何问题"环节与作者聊天以及更多活动。
扫描 QR 码或访问链接立即加入社区。
https://packt.link/cloudanddevops
