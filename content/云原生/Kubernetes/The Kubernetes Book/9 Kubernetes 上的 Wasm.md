# 9: Kubernetes 上的 Wasm

Wasm（WebAssembly）正在推动云计算的新浪潮，Kubernetes 和 Docker 等平台也在随之演进。

虚拟机是第一波，容器是第二波，而 Wasm 是第三波。每一波后续浪潮都使得应用更小、更快、更可移植，能够到达并执行前一波浪潮无法做到的事情。

**图 9.1**

我将本章内容划分如下：

- [[Wasm 入门]]
- 理解 Kubernetes 上的 Wasm
- 在 Kubernetes 上动手实践 Wasm

**Wasm 入门**部分将带你快速了解 Wasm 是什么及其优缺点。**理解 Kubernetes 上的 Wasm**部分概述了在 Kubernetes 上运行 Wasm 应用的需求。最后，**在 Kubernetes 上动手实践 Wasm**部分将引导你完成构建和配置能够运行 Wasm 应用的 Kubernetes 集群的端到端流程，包括编写、编译、容器化以及在 Kubernetes 上运行一个 Wasm 应用。

还有其他更简单的方法来创建 Wasm 应用和配置 Kubernetes 以运行它们。例如，Fermyon 的 SpinKube 项目自动化了你将要学习的许多内容，在实际生产中你可能会使用类似 SpinKube 的工具。但是，像本章这样手动完成所有操作，将帮助你获得更深入的理解。

> [!INFO] 关于术语的简短说明
> 
> Wasm 和 WebAssembly 含义相同，我们将交替使用它们。实际上，Wasm 是 WebAssembly 的缩写，并不是一个首字母缩略词。这意味着正确的写法是 Wasm，而不是 WASM。不过，请善待他人，不要对这类无关紧要的错误过分苛责。

另外，Kubernetes 上的 Wasm 只是“浏览器外的 WebAssembly”“服务器上的 WebAssembly”“云中的 WebAssembly”以及“边缘的 WebAssembly”等术语涵盖的众多用例之一。

## Wasm 入门

WebAssembly 于 2017 年首次亮相，并立即因加速 Web 应用而声名鹊起。八年后，它已成为 W3C 的官方标准，被所有主流浏览器采用，并且是在不牺牲安全性和可移植性的前提下，实现高性能 Web 游戏和 Web 应用的首选解决方案。

因此，云领域的创业者们注意到 WebAssembly 的兴起，并意识到它将是云应用的绝佳技术，这并不令人意外。

事实上，Wasm 非常适合云环境，以至于 Docker 创始人 Solomon Hykes 曾发推文说：“如果 2008 年就有了 Wasm+WASI，我们就不需要创造 Docker 了。它就是这么重要。服务器上的 WebAssembly 是计算的未来。一个标准化的系统接口是缺失的一环。希望 WASI 能够胜任这个任务！”

他紧接着又发了一条推文，预测未来 Linux 容器和 Wasm 容器将并肩工作，而 Docker 将与它们和谐共存。

如今，Solomon 预测的未来已经到来。Docker 对 Wasm 提供了出色的支持，你可以在同一个 Kubernetes Pod 中并排运行 Linux 容器和 Wasm 容器。

然而，Wasm 的标准和生态系统仍然相对较新，这意味着传统的 Linux 容器仍然是许多云应用和用例的最佳解决方案。

在技术方面，Wasm 是一种二进制指令集架构（ISA），类似于 ARM、x86、MIPS 和 RISC-V。这意味着编程语言可以将源代码编译成 Wasm 二进制文件，这些文件可以在任何拥有 Wasm 运行时的系统上运行。

Wasm 应用在默认拒绝的安全沙箱内执行，该沙箱不信任应用本身，意味着默认拒绝所有访问，必须显式地允许访问。这与默认开放一切的容器完全相反。

WASI 是 WebAssembly 系统接口（WebAssembly System Interface），允许沙箱化的 Wasm 应用安全地访问外部服务，例如键值存储、网络、主机环境等。WASI 对于 Wasm 在浏览器之外的成功至关重要，在撰写本文时，WASI Preview 2 已发布，这是一次巨大的进步。

有时你会看到 WASI Preview 2 被写作 WASI 0.2 和 wasip2。

让我们快速了解一下 Wasm 的安全性、可移植性和性能方面。

### Wasm 安全性

Wasm 从一开始就锁定一切。而容器一开始则一切开放。

尽管容器默认采用开放的安全策略，但我们仍必须承认社区在保护容器和容器编排平台方面所做的令人难以置信的工作。运行安全的容器化应用比以往任何时候都更容易，尤其是在托管 Kubernetes 平台上。然而，默认允许的模式以及对共享内核的广泛访问，始终给容器带来安全挑战。

Wasm 则截然不同。Wasm 应用在默认拒绝的沙箱中执行，运行时必须显式地允许访问沙箱外部的资源。你还应该知道，这个沙箱在世界最敌对的环境之一——网络——中历经多年使用而得到充分磨砺！

### Wasm 可移植性

一个常见的误解是容器是可移植的。其实不然！

我们之所以认为容器是可移植的，仅仅是因为它们比虚拟机更小，更容易在主机和注册表之间复制。然而，这并不是真正的可移植性。实际上，容器是架构相关的，这意味着它们并不可移植。例如，你不能在 AMD 处理器上运行 ARM 容器，也不能在 Linux 系统上运行 Windows 容器。

是的，构建工具确实让为不同平台构建容器镜像变得容易得多。然而，每个容器仍然只能在一个平台或架构上运行，许多组织最终都会面临镜像泛滥的问题。举个过于简化的例子：我为本节中的大多数应用维护了两个镜像——一个用于 ARM 上的 Linux，另一个用于 AMD64 上的 Linux。有时，我更新一个应用后会忘记构建 Linux/amd64 镜像，导致在 Linux/amd64 上运行 Kubernetes 的读者的示例失败。

WebAssembly 解决了这个问题，实现了“构建一次，随处运行”的承诺！

它通过实现自己的字节码格式来实现这一点，该格式需要运行时才能执行。你只需将应用构建为一个 Wasm 二进制文件，然后就可以在任何拥有 Wasm 运行时的系统上运行它。

举个简单的例子：我为本章构建示例应用时用的是基于 ARM 的 Mac。然而，我将其编译成了 Wasm，这意味着它可以在任何拥有合适 Wasm 运行时的主机上运行。在本章后面，我们将在 Kubernetes 集群上执行它，该集群可以位于你的笔记本电脑、数据中心或云中。它还可以在 Kubernetes 支持的任何架构上运行。甚至对于物联网和边缘设备上那些特殊架构，也存在着 Wasm 运行时。

说到物联网设备，Wasm 应用通常比 Linux 容器小得多，这意味着你可以在资源受限的环境中（例如边缘和物联网设备）运行它们，而这些环境是无法运行容器的。

总之，Wasm 实现了“构建一次，随处运行”的承诺。

### Wasm 性能

一般来说，虚拟机启动需要分钟级，容器启动需要秒级，而 Wasm 则让我们进入了激动人心的亚秒级启动时间世界。以至于 Wasm 冷启动的速度快到让你感觉不到它是一次冷启动。例如，Wasm 应用通常在大约十毫秒或更短时间内启动。通过适当的优化，有些甚至可以在微秒级别启动！

这是颠覆性的，并推动了早期的许多用例。例如，Wasm 非常适合无服务器函数等事件驱动架构。它也使诸如真正缩放到零（scale-to-zero）之类的功能成为可能。

### 快速回顾

Wasm 应用比传统的 Linux 容器更小、更快、更可移植、更安全。然而，现在仍处于早期阶段，Wasm 并非适合所有场景。目前，Wasm 非常适合事件处理器以及任何需要超快启动时间的场景。它也非常适合物联网、边缘计算以及构建扩展和插件。然而，在撰写本文时，对于传统云应用（其中需要网络、大量 I/O 以及连接其他服务）来说，容器可能仍然是更好的选择。

尽管如此，Wasm 仍在快速发展，WASI Preview 2 是向前迈出的重要一步。

既然我们对 Wasm 有了一些了解，那么让我们看看它如何与 Kubernetes 协同工作。

## 理解 Kubernetes 上的 Wasm

本节介绍在使用 containerd 的 Kubernetes 集群上运行 Wasm 应用的主要需求。也存在其他在 Kubernetes 上运行 Wasm 应用的方法。

这也只是一个概述部分。我们将在动手实践部分详细介绍所有内容。

Kubernetes 是一个高层编排器，它使用其他工具来执行底层的任务，例如创建、启动和停止容器。最常见的配置是 Kubernetes 使用 [[containerd]] 来管理这些底层任务。

图 9.2 展示了 Kubernetes 将一个任务调度到运行 containerd 的工作节点上。在示例中，containerd 接收工作任务，并指示 [[runc]] 构建容器并启动应用。一旦容器运行起来，runc 退出，由 shim 进程维护运行中容器与 containerd 之间的连接。

**图 9.2**

在这种架构中，containerd 之下的所有内容对 Kubernetes 都是隐藏的。这意味着你可以用 Wasm 运行时和 Wasm shim 来替换 runc 和标准 shim。

9.3 展示了一个节点上运行着两个额外的 Wasm 工作负载。

**图 9.3**

请记住，节点上仍然只有一个 containerd 实例，Kubernetes 看不到 containerd 之下的任何东西。这是一个完全受支持的配置，我们将在动手环节部署一个非常类似的配置。

值得一提的是，Wasm shim 架构与 runc shim 架构有所不同。如图 9.4 所示，Wasm shim 是一个单一的二进制文件，其中包含 shim 代码和 Wasm 运行时代码。

**图 9.4**

与 containerd 接口的 Wasm shim 代码是 runwasi，但每个 shim 可以嵌入特定的 Wasm 运行时。例如，Spin shim 嵌入了 runwasi Rust 库和 Spin 运行时代码。同样，Slight shim 嵌入了 runwasi 和 Slight 运行时。在每个 shim 中，嵌入的 Wasm 运行时创建 Wasm 主机并执行 Wasm 应用程序，而 runwasi 则负责所有的转换工作并与 containerd 接口。

关于 shim 的最后一点：containerd 要求所有 shim 二进制文件按照以下方式命名：

- 使用 `containerd-shim-` 前缀
- 指定运行时的名称
- 指定版本

例如，Spin shim 被命名为 `containerd-shim-spin-v2`。

图 9.5 展示了一个包含两个节点的 Kubernetes 集群，每个节点运行不同的 shim。一个节点运行 WasmEdge shim，另一个运行 Spin shim。在这种配置中，Kubernetes 需要帮助将工作负载调度到具有正确 shim 的节点上。我们通过节点标签和 RuntimeClass 对象来提供这种帮助。图中的 Node 2 带有 `spin=yes` 标签，Kubernetes 有一个 RuntimeClass 对象，它根据此标签进行选择，并在 handler 属性中指定目标运行时。这确保了任何引用此 RuntimeClass 的 Pod 都会被调度到 Node 2，并使用 Spin 运行时（handler）。如果这让人困惑，不用担心，当我们在动手练习中实践时，一切都会迎刃而解。

**图 9.5**

使用 containerd 将 Wasm 应用部署到 Kubernetes 集群的工作流程如下：

1. 编写应用程序并将其编译为 Wasm 二进制文件。
2. 将 Wasm 二进制文件打包为 OCI 镜像并存储在 OCI 注册表中。
3. 在至少一个集群节点上安装相应的 Wasm shim 并标记节点。
4. 创建一个 RuntimeClass，指定节点标签和 Wasm shim。
5. 为 Wasm 应用创建一个 Pod（使用步骤 2 中的 Wasm 镜像）。
6. 在 Pod 中引用 RuntimeClass。
7. 将 Pod 部署到 Kubernetes。

当你部署 Pod 时，将发生以下所有事情：

1. Kubernetes 会将 Pod 调度到与 RuntimeClass 中节点选择器匹配的节点上。
2. 该节点上的 kubelet 会将工作传递给 containerd，并携带 RuntimeClass 中的 shim 信息。
3. containerd 将使用 RuntimeClass 中请求的 shim 启动应用。

空谈无益，让我们动手实践。

## Kubernetes 上的 Wasm 动手实践

在开始本节之前，你需要克隆本书的 GitHub 仓库，并切换到 `2025` 分支。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
<Snip>
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
```

现在进入 `wasm` 文件夹。

```bash
$ cd TKB/wasm
```

在本节中，你将完成以下所有步骤，编写一个 Wasm 应用并在一个多节点的 Kubernetes 集群上运行它：

1. 安装并测试前置条件。
2. 编写并编译 Wasm 应用。
3. 将其构建为 OCI 镜像并推送到 OCI 注册表。
4. 构建并配置一个新的用于 Wasm 的多节点 Kubernetes 集群。
5. 将应用部署到 Kubernetes。

在实际环境中，云平台和工具（如 SpinKube）将简化并自动化大部分流程。但在这里，你将手动执行这些步骤，从而更深入地理解所有环节，为在实际环境中部署和管理 Kubernetes 上的 Wasm 应用做好准备。

### 安装并测试前置条件

如果你计划跟随操作，你需要以下所有内容：

- 支持 Wasm 的最新版 Docker Desktop（并已启用 Wasm 支持）
- Rust 1.82 或更高版本，并安装了 `wasm32-wasip1` 目标
- Spin 3.1.2 或更高版本
- k3d 5.8.1 或更高版本

如果你尚未安装 Docker，请参阅第 3 章。

访问 [https://www.rust-lang.org/tools/install](https://www.rust-lang.org/tools/install) 安装 Rust。

安装完成后，运行以下命令安装 `wasm32-wasip1` 目标，以便 Rust 可以将代码编译为 Wasm 二进制文件。

```bash
$ rustup target add wasm32-wasip1
info: downloading component 'rust-std' for 'wasm32-wasip1'
info: installing component 'rust-std' for 'wasm32-wasip1'
```

Spin 是一个流行的 Wasm 框架，包含一个 Wasm 运行时以及构建和处理 Wasm 应用的工具。搜索网络，找到“install Fermyon Spin”并根据你的平台按照安装说明进行操作。

运行以下命令确认安装成功。

```bash
$ spin --version
spin 3.1.2 (3d37bd8 2025-01-13)
```

配置好 Rust 和 Spin 后，开始编写应用。

### 编写并编译 Wasm 应用

在本节中，你将使用 Spin 构建和编译一个 Wasm 应用。

在 `wasm` 文件夹中运行以下 `spin new` 命令，并按提示完成操作。这将搭建一个简单的 Spin 应用，它在端口 80 上响应 `/tkb` 路径的 Web 请求。TKB 是“The Kubernetes Book”的缩写。

```bash
$ spin new tkb-wasm -t http-rust
Description []: My first Wasm app
HTTP path [/...]: /tkb
```

你将获得一个名为 `tkb-wasm` 的新目录，其中包含构建和运行该应用所需的所有内容。

进入 `tkb-wasm` 目录并列出其内容。如果你的系统没有 `tree` 命令，可以尝试运行 `ls -R` 或等效的 Windows 命令。

```bash
$ cd tkb-wasm
$ tree
├── Cargo.toml
├── spin.toml
└── src
    └── lib.rs
2 directories, 3 files
```

我们只关心两个文件：

- `spin.toml`：告诉 Spin 如何构建和运行应用。
- `src/lib.rs`：应用源代码。

编辑 `src/lib.rs` 文件，使其返回文本 `The Kubernetes Book loves Wasm!`。只修改代码片段中注释指示的行上的文本。

```rust
use spin_sdk::http::{IntoResponse, Request, Response};
<Snip>
fn handle_tkb_wasm(req: Request) -> anyhow::Result<impl IntoResponse> {
    println!("Handling request to {:?}", req.header("spin-full-url"));
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/plain")
        .body("The Kubernetes Book loves Wasm!")             <<--
        .build())
}
```

保存更改并运行 `spin build` 将应用编译为 Wasm 二进制文件。在幕后，`spin build` 运行一个更复杂的 `cargo build` 命令（来自 Rust 工具链）。

```bash
$ spin build
Building component tkb-wasm with `cargo build --target wasm32-wasip1`
    Updating crates.io index
    <Snip>
Finished building all Spin components
```

恭喜，你刚刚构建并编译了一个 Wasm 应用！

应用程序二进制文件名为 `tkb_wasm.wasm`，位于 `target/wasm32-wasip1/release/` 文件夹中。它可以在任何安装了 Spin Wasm 运行时的机器上运行。在本章后面，你将在一个安装了 Spin Wasm 运行时的 Kubernetes 节点上运行它。

### 构建 OCI 镜像并推送到 OCI 注册表

编译完应用后，下一步是将其打包为容器，以便在 OCI 注册表上共享并在 Kubernetes 上运行。

首先需要一个 Dockerfile，告诉 Docker 如何将其打包为 OCI 镜像。

在 `tkb-wasm` 文件夹中创建一个新的 `Dockerfile`，内容如下。请确保最后两行末尾包含句点。

```dockerfile
FROM scratch
COPY /target/wasm32-wasip1/release/tkb_wasm.wasm .
COPY spin.toml .
```

`FROM scratch` 行告诉 Docker 将你的 Wasm 应用打包到一个空的 scratch 镜像中，而不是典型的 Linux 基础镜像中。这保持了镜像的小巧，并有助于在运行时构建一个最小的容器。你可以这样做，因为 Wasm 应用不需要包含 Linux 文件系统和其他结构的容器。然而，像 Docker 和 Kubernetes 这样的平台使用的工具期望与基本的容器结构配合工作，将 Wasm 应用打包在 scratch 镜像中就实现了这一点。在运行时，Wasm 应用和 Wasm 运行时将在最小的容器内执行，该容器基本上只有命名空间和 cgroup（没有文件系统等）。

第一个 `COPY` 指令将编译好的 Wasm 二进制文件复制到容器的根文件夹中。第二个将 `spin.toml` 文件复制到同一个根文件夹中。

`spin.toml` 文件告诉 Spin 运行时 Wasm 应用的位置以及如何执行它。目前，它期望 Wasm 应用位于 `target/wasm32-wasip1/release` 文件夹中，但 Dockerfile 将其复制到容器的根文件夹。这意味着你需要更新 `spin.toml` 文件，使其期望应用位于根（`/`）文件夹中。

编辑 `spin.toml` 文件，从 `[component.tkb-wasm]` 的 `source` 字段中去除前面的路径，使其如下所示。代码片段中的注释仅用于指示要更改的行，不要将其包含在你的文件中。

```bash
$ vim spin.toml
<Snip>
[component.tkb-wasm]
source = "tkb_wasm.wasm"      <<---- 去除前面的路径
<Snip>
```

此时，你已经拥有以下所有内容：

- 一个 Wasm 应用（Wasm 二进制文件）
- 一个 `spin.toml` 文件，告诉 Spin Wasm 运行时如何执行 Wasm 应用
- 一个 `Dockerfile`，告诉 Docker 如何将 Wasm 应用构建为 OCI 镜像

运行以下命令将 Wasm 应用构建为 OCI 镜像。如果你计划在后续步骤中推送到注册表，请在最后一行使用你自己的 Docker Hub 用户名。

```bash
$ docker build \
  --platform wasi/wasm \
  --provenance=false \
  -t nigelpoulton/k8sbook:wasm-0.2 .
```

`--platform wasi/wasm` 标志设置了镜像的操作系统和架构。像 `docker run` 和 containerd 这样的工具可以在运行时读取这些属性，以帮助它们创建容器并运行应用。

检查镜像是否存在于本地机器上。你可以自由运行 `docker inspect` 并验证 OS 和 Architecture 属性。

```bash
$ docker images
```

# 9: Kubernetes 上的 Wasm

> [!info] 本部分涵盖以下内容
> - 创建 Wasm 应用并打包为 OCI 镜像
> - 构建并配置支持 Wasm 的 Kubernetes 集群（k3d）
> - 给节点打标签并创建 `RuntimeClass`
> - 部署并测试 Wasm 应用
> - 清理环境

## 创建 Wasm 应用并打包为 OCI 镜像

在上一部分，你已经编写了一个应用并将其编译为 Wasm，然后打包为一个 OCI 镜像，并推送到了镜像仓库。接下来，你将构建并配置一个能够运行 Wasm 应用的 Kubernetes 集群。

（镜像的）`OS` 和 `Architecture` 属性。像 `docker run` 和 `containerd` 这样的工具可以在运行时读取这些属性，以帮助它们创建容器并运行应用。

检查本地机器上是否存在该镜像。你可以运行 `docker inspect` 并验证 `OS` 和 `Architecture` 属性。

```bash
$ docker images
```

```
REPOSITORY              TAG         IMAGE ID        CREATED       
nigelpoulton/k8sbook    wasm-0.2    a003c43b1308    7 seconds ago 
```

注意这个镜像有多小。类似的 Hello World Linux 容器通常有几兆字节大小。

恭喜！你已经创建了一个 Wasm 应用并将其打包为 OCI 镜像，你可以将其推送到镜像仓库，以便后续 Kubernetes 拉取。你不必亲自推送镜像到仓库，因为我有一个预先创建好的镜像供你使用。不过，如果你确实想推送到自己的仓库，你需要将镜像标签替换为你在前面步骤中创建的那个。此外，你还需要在所推送的仓库中拥有账户。

```bash
$ docker push nigelpoulton/k8sbook:wasm-0.2
The push refers to repository [docker.io/nigelpoulton/k8sbook]
4073bf46d785: Pushed
7893057c9bbc: Pushed
wasm-0.2: digest: sha256:a003c43b1308dce78c8654b7561d9a...779c5c9
```

到目前为止，你已经编写了一个应用，编译为 Wasm，打包为 OCI 镜像，并推送到了镜像仓库。接下来，你将构建并配置一个能够运行 Wasm 应用的 Kubernetes 集群。

## 构建并配置一个新的多节点 Kubernetes 集群（用于 Wasm）

本节将向你展示如何在你的本地机器上构建一个新的 k3d Kubernetes 集群，并为其配置 Wasm 支持。它基于一个自定义的 k3d 镜像，该镜像预装了其他集群可能没有的 Wasm shim。这意味着如果你想跟着做，就需要构建这个确切的集群。

你将完成以下所有步骤：

1. 安装 k3d
2. 构建一个 3 节点的 Kubernetes 集群（一个控制平面节点和两个工作节点）
3. 检查其中一个工作节点上的 Wasm 配置
4. 给其中一个工作节点打标签，以便 Kubernetes 知道它可以运行 Wasm 应用
5. 创建一个 `RuntimeClass`，以便 Kubernetes 知道在哪里调度 Wasm 应用

前往 [k3d.io](https://k3d.io) 首页，向下滚动直到找到适用于你平台的安装说明。按照说明操作，然后运行 `k3d --version` 命令以确保安装正确。

安装好 k3d 后，运行以下命令创建一个名为 `wasm` 的新 k3d 集群。这也会将你的 `kubectl` 上下文切换到新集群。

```bash
$ k3d cluster create wasm \
      --image ghcr.io/deislabs/containerd-wasm-shims/examples/k3d \
      -p "5005:80@loadbalancer" --agents 2
```

第一行创建了一个名为 `wasm` 的新集群。

`--image` 标志告诉 k3d 使用哪个镜像来构建控制平面节点和工作节点。这是一个特殊的镜像，包含 containerd Wasm shim。

`-p` 标志创建了一个负载均衡器，该负载均衡器连接到集群上的 Ingress，并将你主机上的端口 `5005` 映射到集群内部 Ingress 的端口 `80`。

`--agents 2` 标志创建了两个工作节点。

集群启动后，你可以使用以下命令测试连接。你应该能看到三个节点——一个控制平面节点和两个工作节点。

```bash
$ kubectl get nodes
NAME                 STATUS    ROLES            AGE    VERSION
k3d-wasm-server-0    Ready     control-plane    17s    v1.27.8+k3
k3d-wasm-agent-1     Ready     <none>           15s    v1.27.8+k3
k3d-wasm-agent-0     Ready     <none>           15s    v1.27.8+k3
```

如果你想要运行 Wasm 工作负载，至少需要一个同时满足以下两个条件的集群节点：

1. 安装并运行了 containerd
2. 安装并注册了一个 containerd Wasm shim

通过 exec 进入 `k3d-wasm-agent-1` 工作节点，检查 containerd 是否在运行。

```bash
$ docker exec -it k3d-wasm-agent-1 ash
$ ps | grep containerd
PID   USER     COMMAND
98    0        containerd
<Snip>
```

现在检查该节点上的 Wasm shim。Shim 文件应该位于 `/bin` 目录下，命名遵循 containerd shim 的命名约定，即 shim 名称前加上 `containerd-shim-`，末尾需要版本号。以下输出显示了五个 shim——`containerd-shim-runc-v2` 是执行 Linux 容器的默认 shim，另外四个是 Wasm shim。对我们来说重要的是名为 `containerd-shim-spin-v2` 的 Spin shim。

```bash
$ ls /bin | grep shim
containerd-shim-lunatic-v1
containerd-shim-runc-v2
containerd-shim-slight-v1
containerd-shim-spin-v2
containerd-shim-wws-v1
```

文件系统中存在 Wasm shim 还不够，它们还需要在 containerd 中注册并作为 containerd 配置的一部分加载。

检查 containerd 的配置文件 `config.toml` 中是否有 Wasm shim 条目。该文件通常位于 `/etc/containerd`，但 k3d 目前将其存储在不同的位置。我已经裁剪了输出，只显示 Wasm 运行时。

```bash
$ cat /var/lib/rancher/k3s/agent/etc/containerd/config.toml
<Snip>
[plugins.cri.containerd.runtimes.spin]
  runtime_type = "io.containerd.spin.v2"
[plugins.cri.containerd.runtimes.slight]
  runtime_type = "io.containerd.slight.v1"
[plugins.cri.containerd.runtimes.wws]
  runtime_type = "io.containerd.wws.v1"
[plugins.cri.containerd.runtimes.lunatic]
  runtime_type = "io.containerd.lunatic.v1"
```

你也可以运行以下命令来验证激活的 containerd 配置。它会解析输出中引用 Spin Wasm shim 的部分。

```bash
$ containerd --config \
  /var/lib/rancher/k3s/agent/etc/containerd/config.toml \
  config dump | grep spin
<Snip>
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin]
    runtime_type = "io.containerd.spin.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.spin
```

你已经确认 containerd 正在运行，并且 Spin Wasm shim 存在且已注册。这意味着该节点可以运行 Wasm 容器中的 Spin 应用。

你的 k3d 集群中的所有节点都运行着相同的 shim，这意味着每个节点都能运行 Wasm 应用，无需进一步操作。然而，大多数实际环境具有异构的节点配置，不同节点拥有不同的 shim 和运行时。在这种情况下，你需要给节点打标签并创建 `RuntimeClass`，以帮助 Kubernetes 将工作调度到正确的节点。

我们将给 `agent-1` 节点打上 `wasm=yes` 标签，并创建一个针对带有该标签的节点的 `RuntimeClass`。

运行以下命令将 `wasm=yes` 标签添加到 `agent-1` 工作节点。你需要先输入 `exit` 退出你的 exec 会话，返回主机的终端。

```bash
# exit
$ kubectl label nodes k3d-wasm-agent-1 wasm=yes
node/k3d-wasm-agent-1 labeled
```

验证操作是否成功。你的输出可能包含更多标签。

```bash
$ kubectl get nodes --show-labels | grep wasm=yes
NAME                STATUS    ROLES     VERSION         LABELS
k3d-wasm-agent-0    Ready     <none>    v1.27.8+k3s2    beta.kube
```

运行以下命令创建 `rc-spin` RuntimeClass。

```bash
$ kubectl apply -f rc-spin.yml
runtimeclass.node.k8s.io/rc-spin created
```

`scheduling.nodeSelector` 字段确保引用此 RuntimeClass 的 Pod 只会被调度到带有 `wasm=yes` 标签的节点上。`handler` 字段告诉节点上的 containerd 使用 `spin` shim 来执行 Wasm 应用。

检查是否正确创建。

```bash
$ kubectl get runtimeclass
NAME      HANDLER   AGE
rc-spin   spin      14s
```

至此，你的 Kubernetes 集群已具备运行 Wasm 工作负载所需的一切——`agent-1` 工作节点已打标签并安装了四个 Wasm shim，并且你已经创建了一个 RuntimeClass 来将 Wasm 任务调度到该节点。

## 部署并测试应用

该应用定义在书籍 GitHub 仓库的 `wasm` 文件夹下的 `app.yml` 文件中，包含一个 Deployment、一个 Service 和一个 Ingress。

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: wasm-spin
spec:
  replicas: 3
  <Snip>
  template:
    metadata:
      labels:
        app: wasm
    <Snip>
    spec:
      runtimeClassName: rc-spin                   <<---- 引用 RuntimeClass
      containers:
        - name: testwasm
          image: nigelpoulton/k8sbook:wasm-0.1    <<---- 预先创建的镜像
          command: ["/"]
```

Deployment YAML 中的重要部分是 Pod 规约中对 RuntimeClass 的引用。这确保 Kubernetes 将所有三个副本调度到满足 RuntimeClass 中 `nodeSelector` 要求的节点——即带有 `wasm=yes` 标签的节点。在我们的示例中，Kubernetes 会将所有三个副本调度到 `agent-1` 节点。

YAML 文件中还有一个 Ingress 和一个 Service，我没有展示。Ingress 将到达 `"/"` 路径的流量导向一个名为 `wasm-spin` 的 ClusterIP Service，该 Service 将流量转发到所有带有 `app=wasm` 标签且端口为 80 的 Pod。Deployment 中定义的副本都具有 `app=wasm` 标签。

你可以在图 9.6 中看到流量流向。

**图 9.6**

在下一步中，你将部署 `app.yml` 文件中定义的应用。它使用书籍的 Docker Hub 仓库中预先创建的 Wasm 镜像。如果你想使用你在之前步骤中创建的镜像，请编辑你的 `app.yml` 文件并更改 `image` 字段。

```bash
$ kubectl apply -f app.yml
deployment.apps/wasm-spin created
service/svc-wasm created
ingress.networking.k8s.io/ing-wasm created
```

通过 `kubectl get deploy wasm-spin` 命令检查 Deployment 的状态。

等待所有三个副本变为 Ready 状态，然后运行以下命令确认它们都已调度到 `agent-1` 工作节点。

```bash
$ kubectl get pods -o wide
NAME                          READY    STATUS     ...    NODE     
wasm-spin-5f6fccc557-5jzx6    1/1      Running    ...    k3d-wasm-agent-1
wasm-spin-5f6fccc557-c2tq7    1/1      Running    ...    k3d-wasm-agent-1
wasm-spin-5f6fccc557-ft6nz    1/1      Running    ...    k3d-wasm-agent-1
```

Kubernetes 已将全部三个 Pod 调度到 `agent-1` 节点。这意味着标签和 RuntimeClass 按预期工作。

使用以下 `curl` 命令测试应用。你也可以将浏览器指向 `http://localhost:5005/tkb`。

```bash
$ curl http://localhost:5005/tkb
The Kubernetes Book loves Wasm!
```

恭喜，Wasm 应用已经在你的 Kubernetes 集群上运行了！

## 清理

如果你跟着做了，你将拥有以下所有工件，你可能希望清理它们：

- 名为 `wasm` 的 k3d Kubernetes 集群
- 存储在 OCI 镜像仓库中的 Wasm OCI 镜像
- 本地主机上的 Wasm OCI 镜像
- 本地机器上的 Spin 应用

清理 Kubernetes 集群最简单的方法是使用以下命令删除它。

```bash
$ k3d cluster delete wasm
```

如果你想保留集群而只删除资源，请运行以下两个命令。

```bash
$ kubectl delete -f app.yml
deployment.apps "wasm-spin" deleted
service "svc-wasm" deleted
ingress.networking.k8s.io "ing-wasm" deleted
$ kubectl delete runtimeclass rc-spin
runtimeclass.node.k8s.io "rc-spin" deleted 
```

你可以使用以下命令删除本地机器上的 Wasm 镜像。请务必替换为你的镜像名称。

```bash
$ docker rmi nigelpoulton/k8sbook:wasm-0.1
```

当你使用 `spin new` 和 `spin build` 创建应用时，你得到了一个名为 `tkb-wasm` 的新目录，其中包含所有应用工件。使用你喜欢的工具删除该目录及其所有文件。务必删除正确的目录！

将你的 Kubernetes 上下文设置回你之前在书中其他示例中使用的集群。如果你有 Docker Desktop，点击 Docker 鲸鱼图标并从 Kubernetes 上下文选项中选择上下文。如果你没有 Docker Desktop，可以运行以下命令。第一个命令列出你的上下文，第二个命令将当前上下文设置为 `docker-desktop`。你需要根据你的环境将上下文设置回正确的那个。

```bash
$ kubectl config get-contexts
CURRENT   NAME             CLUSTER          AUTHINFO         NAME
          docker-desktop   docker-desktop   docker-desktop
          lke349416-ctx    lke349416        lke349416-admin   def
*         k3d-wasm         k3d-wasm         admin@k3d-wasm
$ kubectl config current-context docker-desktop
docker-desktop
```

## 章节总结

Wasm 正在推动云计算的第三次浪潮，像 Docker 和 Kubernetes 这样的平台正在演进以与之协作。Docker 已经可以将 Wasm 应用构建到容器镜像中，使用 `docker run` 运行它们，并在 Docker Hub 上托管它们。

（后续章节继续）