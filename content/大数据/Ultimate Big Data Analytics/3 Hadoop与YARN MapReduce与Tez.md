# 3 Hadoop与YARN MapReduce与Tez

## 引言

在本章中，我们将全面深入地探索 Apache Hadoop 及其核心组件：HDFS、YARN、MapReduce 和 Apache Tez。本章分为三个不同的部分，每个部分都将加深你对大数据处理的理解。

**第一部分：构建基础**：我们从基础工作开始，探索前置条件，确保你能够顺利进入大数据处理的世界。本部分向你介绍 Docker，这是创建隔离环境以运行 Hadoop 的基本工具。

**第二部分：理解核心概念**：第二部分深入探讨 Hadoop 核心组件的理论基础。我们将揭开 HDFS、YARN、MapReduce 和 Apache Tez 的神秘面纱。你将深入了解它们的架构、独特优势、关键特性、实际应用以及在 Hadoop 生态系统中的关键位置。

**第三部分：动手实践**：最后一部分是实践环节。我们将引导你完成搭建 Hadoop 集群和运行多个 MapReduce 作业的实际操作。你将学习使用 Docker 安装和配置单节点 Hadoop 集群的细节。这次动手体验将使你能够充分利用 Apache Hadoop 进行大数据分析。

到本章结束时，你将充分准备好开始你的 Apache Hadoop 大数据之旅，掌握应对实际挑战所需的知识和实践技能。

## 本章结构

在本章中，我们将讨论以下主题：

**Part I：前置条件**

- Docker 简介
- 容器化与 Docker 的角色
- 安装 Docker

**Part II：理论**

- HDFS：Hadoop 分布式文件系统
- Hadoop 架构
- Hadoop 的优势
- Hadoop 在技术栈中的位置
- Hadoop Yet Another Resource Negotiator（YARN）
- YARN 的关键组件
- 架构：YARN 如何工作
- YARN 的优势
- YARN 在 Hadoop 技术栈中的位置
- Hadoop 和 YARN 的配置文件与端口
- MapReduce
- MapReduce 范式
- MapReduce 作业的解剖
- MapReduce 的优势
- MapReduce 的用例
- MapReduce 在 Hadoop 技术栈中的位置
- Hadoop Streaming API：用自定义脚本简化 MapReduce
- Hadoop Streaming 如何工作
- Hadoop Streaming 的优势
- Apache Tez
- Tez 架构的关键组件
- Tez 的优势
- Tez 在 Hadoop 技术栈中的位置

**Part III：动手实践部分**

- 在伪分布式模式下搭建单节点集群
- 前置条件
- 搭建 Hadoop、YARN 和 MR
- 探索 Hadoop 和 YARN 命令
- Hadoop 命令：驾驭大数据领域
- Hadoop NameNode UI
- Hadoop NameNode UI 的关键特性
- YARN Resource Manager UI
- YARN UI 的关键特性
- MapReduce 动手实践
- Word Count MapReduce 作业
- 使用 Hadoop Streaming API 的 Word Count MR 作业（Python）
- 使用 Hadoop Streaming API 的 Word Count MR 作业（Perl）

## Part I：前置条件

为了积极参与本书提供的实践练习和代码脚本，并简化不同项目的安装过程，我们将使用 Docker 容器。此外，鉴于某些 Apache 项目可能与 Windows 操作系统不兼容，Docker 提供了一个绕过这一兼容性挑战的解决方案。

在接下来的部分中，我们将深入探讨 Docker 并介绍其安装过程。

## Docker 简介

Docker 是一个平台，允许你在轻量级、可移植的容器中开发、打包和部署应用程序。容器是一种虚拟化技术，将应用程序及其依赖项打包成一个单一单元，确保应用程序在不同环境（如开发、测试和生产）中一致运行。

## 容器化与 Docker 的角色

容器化是 Docker 的基础，它将应用程序及其运行时环境、依赖项和配置设置封装到一个独立的、自包含的单元中，称为容器。这个容器可以在不同环境中一致地运行，确保应用程序的行为可预测，而不受底层基础设施的影响。

Docker 将容器化的概念提升到了一个新的水平，使其易于访问且用户友好。它提供了一个用于构建、共享和运行容器的综合平台。该平台由几个关键组件和工具组成，简化了整个流程：

- **Docker 镜像（Docker Images）**：这是容器的构建块。Docker 镜像是文件系统的快照，包含应用程序代码、运行时、库和设置。镜像使用 Dockerfile 定义，该文件指定了创建镜像的步骤。

- **Docker 容器（Docker Containers）**：Docker 容器是 Docker 镜像的实例。它们封装了应用程序的运行时环境，以及其隔离的文件系统、网络和进程空间。容器在从开发者笔记本电脑到生产服务器的各种环境中一致运行。

- **Docker Hub**：Docker Hub 是 Docker 镜像的中央仓库。它允许开发者公开或私下共享其镜像，从而方便分发应用程序和服务。

- **Docker Compose**：Docker Compose 是一个简化多容器应用程序编排的工具。它使用简单的 YAML 文件来定义应用程序所需的服务、网络和卷。该工具在开发和测试环境中特别有用。

- **Docker Swarm 和 Kubernetes**：这些是容器编排平台，帮助管理在机器集群中容器的部署、扩展和运行。它们提供高级功能，确保高可用性、负载均衡和自动扩展。

## 安装 Docker

我们将引导你完成 Docker 的安装。在本书中，我们将使用 Windows 操作系统，但本书中提到的安装和步骤在 Linux 和 macOS 上也应该相同。

### 在 Windows 笔记本上安装 Docker

Docker 提供了一个在 Windows 笔记本上设置其平台的简单过程。按照以下步骤，你将能够在 Windows 环境中无缝地创建、管理和运行容器。

**步骤 1：检查系统要求**

在开始安装过程之前，确保你的 Windows 笔记本满足 Docker 的系统要求。Docker Desktop for Windows 要求 Windows 10 专业版、企业版或教育版（64 位），并启用 Hyper-V。同时，确保在笔记本的 BIOS 设置中启用了虚拟化。

**步骤 2：下载 Docker Desktop**

访问 Docker 官方网站，点击下载按钮启动下载。

![[Pasted image 20260517215101.png]]
*图 3.1：下载 Docker*

下载完成后，找到安装程序文件并双击它以启动安装过程。

**步骤 3：安装过程**

安装程序将引导你完成安装过程。在提示时接受许可协议。

你可以选择默认安装选项，或根据你的偏好进行自定义。Docker Desktop 需要提升的权限，因此你可能需要输入管理员密码。

在安装过程中，Docker Desktop 将安装必要的组件，包括 Docker Engine、Docker CLI 和 Docker Compose。

**步骤 4：配置**

安装完成后，Docker Desktop 将启动，系统托盘中会出现一个图标。

点击 Docker 图标打开 Docker Desktop 应用程序，应用程序需要一些时间启动。

一旦 Docker Desktop 启动并运行，你应该看到 Docker 图标变为绿色，表示 Docker 正在运行。

**步骤 5：验证安装**

要验证 Docker 是否正确安装并正常工作，你可以打开命令提示符或 PowerShell 窗口，输入以下命令：

```bash
docker --version
Docker version 24.0.5, build ced0996
```

如果安装成功，此命令将显示已安装的 Docker 版本。

恭喜！你已经成功在 Windows 笔记本上安装了 Docker Desktop。

请记住，Docker Desktop 提供了一个直观的图形界面，用于管理容器、镜像等。随着你探索 Docker 的功能，你将发现它如何增强你的开发体验，并让你能够高效地构建和部署应用程序。

## Part II：理论

## HDFS：Hadoop 分布式文件系统

Hadoop 分布式文件系统（HDFS）是 Hadoop 生态系统的核心组件，旨在跨 commodity 硬件集群存储和管理海量数据。它由 Apache 软件基金会开发，是一种可扩展且容错的解决方案，用于处理大数据应用的存储需求。HDFS 是许多大数据处理流水线的支柱，能够在分布式环境中高效地存储、检索和分析数据。HDFS 最初是作为 Apache Nutch 网页搜索引擎项目的一部分开发的，现在已成为 Apache Hadoop 项目的核心组件。

## Hadoop 架构

Hadoop 分布式文件系统（HDFS）的架构是其高效管理和检索跨 commodity 硬件集群的海量数据的基础。理解这一架构对于掌握 HDFS 如何存储、管理和提供数据访问至关重要。

### 假设与目标

- **硬件故障（Hardware Failure）**：HDFS 在硬件故障普遍发生的环境中运行。在由众多服务器机器组成的集群中，硬件故障是预料之中的，需要强大的故障检测和自动恢复机制。

- **流式数据访问（Streaming Data Access）**：HDFS 专为需要流式访问其数据集的应用而设计。与传统文件系统不同，HDFS 优化了批处理，强调高吞吐量数据访问而非低延迟。系统围绕一次写入、多次读取的范式构建，在数据集被创建或导入一次后，随后进行多次分析的场景中效率最高。这些分析通常涉及处理数据集的很大一部分（如果不是全部），因此读取整个数据集的总时间比访问单个记录的延迟更为关键。

- **大数据集（Large Data Sets）**：利用 HDFS 的应用程序处理大量数据。HDFS 优化了处理大文件的能力，支持 GB 到 TB 级别的文件，同时保持高数据吞吐量并支持数百万个文件。

- **简单一致性模型（Simple Coherency Model）**：HDFS 采用一次写入多次读取模型。文件通常被写入、关闭，除了追加或截断外很少被修改。这种方法简化了数据一致性问题，实现了高吞吐量数据访问。

- **"移动计算比移动数据更便宜"（Moving Computation is Cheaper than Moving Data）**：为了获得最佳效率，计算应尽可能在数据附近执行，特别是对于大数据集。HDFS 通过允许应用程序靠近数据来促进这一点，最大限度地减少跨网络的数据传输。

- **跨异构平台的便携性（Portability Across Heterogeneous Platforms）**：HDFS 被设计为可跨多种硬件和软件平台移植。这种灵活性鼓励了广泛的采用，并使其成为各种应用的合适选择。

### Hadoop 架构的关键组件

Hadoop 架构的关键组件如下图所示：

![[Pasted image 20260517215114.png]]
*图 3.2：HDFS 架构*

#### NameNode 和 DataNode

HDFS 采用主/从架构。一个 HDFS 集群由一个 NameNode 组成，这是一个主服务器，管理文件系统命名空间并调节客户端对文件的访问。此外，还有多个 DataNode，通常是集群中每个节点一个，管理运行在其上的节点所连接的存储。HDFS 公开了一个文件系统命名空间，允许用户数据存储在文件中。在内部，文件被分割成一个或多个块，这些块存储在一组 DataNode 中。NameNode 执行文件系统命名空间操作，如打开、关闭和重命名文件和目录。它还确定块到 DataNode 的映射。DataNode 负责为文件系统的客户端提供读写请求服务。DataNode 还根据 NameNode 的指示执行块的创建、删除和复制。

NameNode 和 DataNode 是设计为在 commodity 机器上运行的软件。这些机器通常运行 GNU/Linux 操作系统。HDFS 使用 Java 语言构建；任何支持 Java 的机器都可以运行 NameNode 或 DataNode 软件。高度可移植的 Java 语言的使用意味着 HDFS 可以部署在各种机器上。典型的部署有一台专门运行 NameNode 软件的机器。集群中的其他每台机器运行一个 DataNode 软件的实例。该架构并不排除在同一台机器上运行多个 DataNode，但在实际部署中很少出现这种情况。

集群中存在单个 NameNode 极大地简化了系统架构。NameNode 是所有 HDFS 元数据的仲裁者和存储库。系统的设计方式是用户数据永远不会流经 NameNode。

#### 文件系统命名空间

HDFS 支持传统的分层文件组织。用户或应用程序可以创建目录并在这些目录中存储文件。文件系统命名空间的层次结构与大多数其他现有文件系统相似；可以创建和删除文件，将文件从一个目录移动到另一个目录，或重命名文件。HDFS 支持用户配额和访问权限，但不支持硬链接或软链接。然而，HDFS 架构并不排除实现这些功能的可能性。

虽然 HDFS 遵循 FileSystem 的命名约定，但某些路径和名称（例如 `/.reserved` 和 `.snapshot`）是保留的。透明加密和快照等功能使用保留路径。

NameNode 维护文件系统命名空间。对文件系统命名空间或其属性的任何更改都由 NameNode 记录。应用程序可以指定应由 HDFS 维护的文件的副本数量。文件的副本数量称为该文件的复制因子（replication factor）。此信息由 NameNode 存储。

#### 数据复制

HDFS 被设计为在大型集群中的机器之间可靠地存储非常大的文件。它将每个文件存储为一系列块。文件的块被复制以实现容错。块大小和复制因子可按文件配置。

除最后一个块外，文件中的所有块大小相同，而在支持可变长度块以进行追加和同步后，用户可以在不填满最后一个块到配置的块大小的情况下开始新的块。

应用程序可以指定文件的副本数量。复制因子可以在文件创建时指定，也可以稍后更改。HDFS 中的文件是一次写入的（追加和截断除外），并且在任何时候都严格只有一个写入者。

NameNode 做出有关块复制的所有决策。它定期从集群中的每个 DataNode 接收心跳（Heartbeat）和块报告（Blockreport）。接收到心跳意味着 DataNode 正常工作。块报告包含 DataNode 上所有块的列表。

![[Pasted image 20260517215125.png]]
*图 3.3：复制*

#### 基于块的存储

HDFS 采用基于块的存储，块大小可配置（通常为 128 MB 或 256 MB）。大文件被分成较小的块，允许并行处理和高效存储。块大小的选择平衡了小文件的存储效率和大文件的读/写性能。

#### 机架感知（Rack Awareness）

HDFS 了解 DataNode 的物理机架位置，优化数据放置以实现容错和网络效率。在复制数据时，HDFS 倾向于将副本分布在不同机架上，最大限度地减少因机架故障造成的数据丢失风险，并最大化数据局部性以实现更快的访问。

#### 数据复制

为了确保数据持久性和容错性，HDFS 将每个块多次复制到多个 DataNode 上，通常默认复制因子为三。在 DataNode 发生故障时，可以从其他节点上的副本检索数据，确保数据可用性。

#### 通信协议

HDFS 组件使用 TCP/IP 协议进行通信。客户端使用 ClientProtocol 连接到 NameNode 以执行文件系统操作。DataNode 使用 DataNode Protocol 与 NameNode 通信并报告块状态。远程过程调用（RPC）封装这些协议，NameNode 仅响应 DataNode 或客户端发起的请求。

#### 数据组织

HDFS 以分层方式组织数据，类似于传统文件系统。用户和应用程序创建目录并存储文件，NameNode 管理文件系统命名空间、目录结构和文件属性。HDFS 支持用户配额和访问权限，但不支持硬链接或软链接。

#### 元数据与持久化

NameNode 维护文件系统命名空间和元数据，将文件创建或重命名等更改记录在 EditLog 中并持久化到磁盘。FsImage 存储完整的命名空间快照，在启动或检查点期间用于重建命名空间状态。

#### 健壮性与容错性

HDFS 被设计为在硬件故障时仍能保持运行。块复制确保数据可靠性，通过心跳、块报告和校验来检测和恢复节点故障。安全模式（Safemode）在启动期间限制数据修改，确保数据完整性。

#### 块放置策略

HDFS 使用块放置策略实现高效的数据分布和容错。默认情况下，它目标是第一个副本放在本机，第二个副本放在远程机架，第三个副本放在同一远程机架的不同节点上（当复制因子为三时）。可以为特定的集群拓扑实现自定义策略。

#### 可访问性

HDFS 提供多种接口，包括 FileSystem Java API、C 语言封装、REST API、FS shell（命令行界面）和浏览器界面。NFS 网关使 HDFS 可以像本地文件系统一样被挂载。

#### 空间回收

HDFS 通过文件删除和恢复操作高效地回收空间。已删除的文件在永久删除前临时移动到回收站目录，提供了一个安全网。更改复制因子或删除文件可以释放集群空间。

### Hadoop 文件系统

HDFS 统一资源标识符（URI）是一种特定的寻址格式，用于标识和访问 Hadoop 分布式文件系统（HDFS）中的资源。它通常由 scheme 和 HDFS 集群 NameNode 的主机名和端口号，以及所需文件或目录的路径组成。

例如，典型的 HDFS URI 可能如下所示：

```
hdfs://namenode.example.com:9000/user/hadoopuser/datafile.txt
```

Hadoop 使用 HDFS URI 来定位和访问存储在分布式文件系统中的数据。

Hadoop 具有抽象的文件系统概念，HDFS 只是其中一种实现。Java 抽象类 `org.apache.hadoop.fs.FileSystem` 表示 Hadoop 中文件系统的客户端接口，针对不同的文件系统有多种具体实现。这些文件系统提供了灵活性和与各种存储解决方案的兼容性，使 Hadoop 成为处理不同数据源的多功能平台。支持的文件系统描述如下：

**本地文件系统（Local File System）**

- URI：`file:///path/to/your/local/file`
- 这是用于本地连接磁盘的文件系统，带有客户端校验和。通常用于本地文件操作，支持校验和以确保数据完整性。

**HDFS**

- URI：`hdfs://namenode:port/path/to/hdfs/file`
- Hadoop 的分布式文件系统（HDFS）是 Hadoop 中的核心分布式存储系统。它旨在高效地存储和检索跨 commodity 硬件集群的大文件。它与 MapReduce 和 Hadoop 生态系统的其他组件无缝配合。

**WebHDFS**

- URI：`webhdfs://namenode:port/path/to/hdfs/file`
- WebHDFS 通过 HTTP 提供对 HDFS 的认证读写访问。它提供了一个 RESTful API 与 HDFS 交互，使其可通过基于 Web 的客户端访问。

**Secure WebHDFS**

- URI：`swebhdfs://namenode:port/path/to/hdfs/file`
- Secure WebHDFS 是 WebHDFS 的 HTTPS 版本。它提供与 WebHDFS 相同的功能，但确保通过 SSL/TLS 进行安全数据传输。

**HAR（Hadoop Archives）**

- URI：`har://path/to/har/file#path/inside/har`
- Hadoop Archives（HAR）文件系统是在另一个文件系统之上用于归档文件的层。它用于将 HDFS 中的许多文件打包成单个归档文件（HAR 文件），以减少 NameNode 的内存使用。你可以使用 `hadoop archive` 命令创建 HAR 文件。

**View（ViewFileSystem）**

- URI：`viewfs://(view-name)/path/to/hdfs/file`
- ViewFileSystem 是其他 Hadoop 文件系统的客户端挂载表。通常用于为联邦 NameNode 创建挂载点，允许你通过单一接口访问来自多个 HDFS 集群的数据。

**FTP**

- URI：`ftp://ftp-server/path/to/ftp/file`
- FTP 文件系统允许 Hadoop 与存储在 FTP 服务器上的文件交互。可用于从远程 FTP 服务器读取数据和向其写入数据。

**S3**

- URI：`s3a://bucket-name/path/to/s3/file`
- S3A 文件系统用于访问存储在 Amazon S3 上的数据。它取代了旧的 s3n（S3 原生）实现，提供了更好的性能和与 S3 的兼容性。

**Azure**

- URI：`wasb://container-name/path/to/azure/file`
- Azure 文件系统允许 Hadoop 处理存储在 Microsoft Azure Blob Storage 上的数据。它通常用于基于 Azure 的 Hadoop 集群。

**Swift**

- URI：`swift://container-name/path/to/swift/file`
- Swift 文件系统使 Hadoop 能够与存储在 OpenStack Swift 上的数据交互，OpenStack Swift 是一个开源对象存储系统。它适用于利用 Swift 进行数据存储的环境。

### Hadoop 的优势

以下是使用 Hadoop 的一些关键优势：

- **可扩展性（Scalability）**：HDFS 构建为可水平扩展，可容纳跨多个服务器的 PB 级数据。它通过将大文件分成较小的块（通常为 128 MB 或 256 MB）、将这些块分布到多个节点上，并允许轻松添加新节点到集群来实现。

- **容错性（Fault Tolerance）**：为了确保数据可靠性，HDFS 将每个数据块在集群中的不同节点上复制多次。如果某个节点发生故障，系统可以从副本无缝检索数据。这种容错机制最大限度地减少了数据丢失的风险。

- **数据局部性（Data Locality）**：HDFS 通过将计算放置在数据附近来优化数据处理。当调度作业时，最好在所需数据已经存储的节点上执行它。这种方法最大限度地减少了网络数据传输，提高了性能。

- **流式数据访问（Streaming Data Access）**：HDFS 优化了顺序数据访问模式而非随机访问。它非常适合以线性或批处理方式处理大数据集的应用程序，如 MapReduce 作业。

- **单主节点（Single Master）**：HDFS 遵循主从架构，一个 NameNode 作为主节点，多个 DataNode 作为从节点。NameNode 管理文件系统命名空间，维护元数据，跟踪数据块位置，而 DataNode 存储实际的数据块。

- **高吞吐量（High Throughput）**：HDFS 设计用于高吞吐量数据访问而非低延迟操作。它牺牲低延迟读取以换取高效的数据流和批处理，使其适合大数据分析。

- **一次写入多次读取（WORM）**：HDFS 优化了数据写入一次后多次读取的场景。它支持追加操作，但由于其数据不可变性的设计，修改现有数据不那么直接。

总之，HDFS 的架构旨在处理跨分布式集群存储、管理和访问海量数据的挑战，同时优先考虑容错性、可靠性和可扩展性。这一设计使 HDFS 成为大数据处理和存储解决方案的关键组件。

### Hadoop 在 Hadoop 技术栈中的位置

在 Hadoop 生态系统技术栈中，Hadoop 本身通常定位在核心位置，因为它作为基础框架，并形成其他大数据技术和组件构建于其上的存储层。

下图将随着我们学习更多关于 Hadoop 生态系统的内容而不断演变：

![[Pasted image 20260517215138.png]]
*图 3.4：Hadoop 技术栈*

## Hadoop Yet Another Resource Negotiator（YARN）

在 Hadoop 生态系统中，Hadoop Yet Another Resource Negotiator（YARN）组件是一个关键且多功能的资源管理系统。YARN 作为 Hadoop 2.0 的一部分引入，旨在解决之前 Hadoop MapReduce 框架资源管理方法的几个局限性。YARN 的主要功能是高效管理和分配 Hadoop 集群中的资源，使其成为分布式数据处理的关键组件。

### YARN 的关键组件

YARN 的关键组件包括：

**ResourceManager（资源管理器）**：

- ResourceManager 是 YARN 中资源分配和管理的中央权威。
- 它由两个主要组件组成：Scheduler（调度器）和 Application Manager（应用程序管理器）。
- Scheduler 负责将资源分配给集群上运行的各种应用程序，确保最佳的资源利用率。
- Application Manager 处理作业提交，为应用程序从 ResourceManager 协商资源，并监控这些应用程序的进度和执行。

**NodeManager（节点管理器）**：

- NodeManager 在集群内的各个节点上运行，负责监控其各自节点上的资源使用情况。
- 它们还管理容器的生命周期，容器是运行应用程序的隔离执行环境。
- NodeManager 与 ResourceManager 通信，提供每个节点的资源可用性和利用率信息。

**Container（容器）**：

- 容器是 YARN 框架中资源分配的基本单元。
- 它们封装了特定应用程序的资源需求，如 CPU、内存和其他必要配置。
- YARN 根据应用程序指定的资源请求分配容器，确保应用程序拥有运行所需的资源。

### 架构：YARN 如何工作

YARN 的设计将资源管理和作业调度功能解耦，允许各种数据处理框架（不仅仅是 MapReduce）在同一 Hadoop 集群上共存和并发运行。YARN 的基本思想是将资源管理和作业调度/监控的功能分离到独立的守护进程中。其理念是有一个全局的 ResourceManager 和每个应用程序一个 ApplicationMaster。一个应用程序可以是单个作业或一个作业的 DAG。

![[Pasted image 20260517215150.png]]
*图 3.5：YARN 架构*

以下是 YARN 如何运行的更详细概述：

1. **应用程序提交（Application Submission）**：应用程序（可以是 MapReduce 作业、Spark 应用程序或其他数据处理任务）通过 Application Manager 提交到 YARN ResourceManager。

2. **资源协商（Resource Negotiation）**：ResourceManager 与位于集群内各个节点上的 NodeManager 协商资源。此协商旨在分配满足应用程序资源需求的容器。

3. **容器分配（Container Allocation）**：一旦资源协商成功，ResourceManager 将容器分配给应用程序。每个容器代表一个隔离的资源单元供应用程序使用。

4. **容器启动（Container Launch）**：NodeManager 在其各自的节点上启动分配的容器，确保每个应用程序的资源隔离和分离。

5. **应用程序执行（Application Execution）**：在分配的容器内，应用程序的任务运行，利用分配的 CPU、内存和其他资源。这种隔离确保不同的应用程序不会相互干扰。

6. **资源监控（Resource Monitoring）**：NodeManager 持续监控容器内的资源使用情况，并将此信息报告给 ResourceManager。

7. **资源管理（Resource Management）**：ResourceManager 跟踪集群中的资源可用性和分配。它可以根据运行中应用程序不断变化的需求动态调整资源分配。

8. **资源释放（Resource Release）**：一旦应用程序完成任务或不再使用分配的资源，ResourceManager 将释放这些资源，使其可供其他应用程序使用。

### YARN 的优势

YARN 的优势如下：

- **多租户（Multi-Tenancy）**：YARN 支持多租户，允许多个应用程序和框架共存并同时高效利用集群资源。

- **可扩展性（Scalability）**：YARN 的模块化架构可以随着集群规模无缝扩展，即使在大集群中也能高效管理资源。为了将 YARN 扩展到超过数千个节点，YARN 通过 YARN Federation 功能支持联邦的概念。联邦允许你透明地将多个 yarn（子）集群连接在一起，使它们看起来像一个单一的大规模集群。这可用于实现更大规模，和/或允许多个独立集群一起用于非常大的作业，或在所有集群中都有容量的租户。

- **灵活性（Flexibility）**：YARN 不仅限于 MapReduce 框架。它支持各种数据处理框架，如 Apache Spark、Apache Tez 等，使 Hadoop 集群对各种工作负载具有多样性。

- **增强的集群利用率（Enhanced Cluster Utilization）**：YARN 优化资源分配，确保集群得到高效使用并防止资源浪费。

- **资源隔离（Resource Isolation）**：使用容器为应用程序提供进程隔离，增强了共享集群环境中的安全性、稳定性和可预测性。

YARN 已成为 Hadoop 集群不可或缺的基础组件，使其能够高效处理多样化和不断变化的工作负载。其资源管理能力对更广泛的 Hadoop 生态系统至关重要，是现代大数据处理和分析解决方案的重要组成部分。

### YARN 在 Hadoop 技术栈中的位置

在 Hadoop 生态系统技术栈中，Apache Yet Another Resource Negotiator（YARN）位于核心 Hadoop 组件之上，在资源管理和集群编排中起着至关重要的作用。

![[Pasted image 20260517215200.png]]
*图 3.6：Hadoop 技术栈*

## Hadoop 和 YARN 的配置文件与端口

以下是关键配置文件和常用端口的说明。

### 配置文件

Hadoop 配置文件在 Hadoop 生态系统的设置和运行中起着关键作用。这些文件包含各种设置和参数，决定了 Hadoop 组件应该如何行为。正确配置这些文件对于确保 Hadoop 集群的正常运行至关重要。以下是一些关键的 Hadoop 配置文件：

- **core-site.xml**：此文件包含 Hadoop 公共服务和库使用的核心配置设置。在此文件中设置的一些重要属性包括文件系统 URL（如 HDFS）和默认文件系统。

- **hdfs-site.xml**：HDFS 特有的配置文件，保存 Hadoop 分布式文件系统（HDFS）的设置。你可以在此文件中指定与块复制、块大小和数据节点目录相关的属性。

- **mapred-site.xml**：mapred-site.xml 文件用于配置 MapReduce 框架。你可以在此文件中定义设置，如作业跟踪器地址、任务跟踪器槽位和 map/reduce 任务规范。

- **yarn-site.xml**：此配置文件对于配置 Apache Hadoop NextGen MapReduce（YARN）资源管理器至关重要。你可以在此处设置参数，如资源管理器和节点管理器实例的数量、内存管理和日志聚合策略。

- **hadoop-env.sh**：此脚本允许你设置影响 Hadoop 行为的环境变量，如 Java 主目录、堆大小和垃圾回收选项。它对于配置 Hadoop 守护进程的运行时环境至关重要。

- **yarn-env.sh**：与 hadoop-env.sh 类似，此脚本设置特定于 YARN 资源管理器的环境变量。它用于自定义 YARN 组件的环境。

- **mapred-env.sh**：mapred-env.sh 用于专门为 MapReduce 配置环境变量。你可以定义设置，如 map 和 reduce 任务的 Java 堆大小。

这些配置文件通常位于 Hadoop 配置目录中（例如 `/etc/hadoop/conf`），其内容可能因集群要求而异。正确配置这些文件可确保 Hadoop 组件无缝协作，高效可靠地执行分布式数据处理任务。

### 端口

Hadoop 和 YARN 使用各种端口进行框架不同组件之间的通信。以下是一些 Hadoop 和 YARN 常用的端口：

**Hadoop 通用端口：**

*NameNode：*
- 默认 HTTP 端口：50070（Web UI）
- 默认 IPC（进程间通信）端口：8020

*Secondary NameNode：*
- 默认 HTTP 端口：50090（Web UI）
- 默认 IPC 端口：50091

*DataNode：*
- 默认数据传输端口：50010
- 默认数据流传输端口：50020
- 默认 IPC 端口：50075

**ResourceManager（YARN）：**
- 默认 HTTP 端口：8088（Web UI）
- 默认资源管理器调度器地址：8030
- 默认资源管理器资源跟踪器地址：8031
- 默认资源管理器地址：8032
- 默认资源管理器管理地址：8033

**NodeManager（YARN）：**
- 默认容器管理器地址：8040
- 默认节点管理器本地化器地址：8041

> **注意**：这些是默认端口，如果需要，你可以在 Hadoop 的配置文件中进行配置。

这些端口对于 Hadoop 和 YARN 的正常运行至关重要。确保这些端口在运行 Hadoop 组件的相应机器上开放且可访问非常重要，如果启用了防火墙，防火墙规则应适当配置以允许这些端口的流量。

请注意，如果你在安全环境中或云平台上运行 Hadoop，端口配置可能会有所不同，可能会有额外的安全措施。请始终参考你的 Hadoop 发行版的具体文档或配置，以获取你所处环境中精确的端口详情。

## MapReduce

MapReduce 是一个基石性的编程模型和处理框架。

Hadoop MapReduce 是一个强大的软件框架，旨在轻松创建能够处理海量数据集（通常在多 TB 范围内）的应用程序，这些数据集跨越成千上万个 commodity 硬件节点的大型集群。该框架在确保数据处理任务的可靠性和容错性方面表现出色。

MapReduce 最初由 Google 开发，后来被 Hadoop 采用，它简化了分布式计算，对于理解 Hadoop 的核心能力至关重要。

![[Pasted image 20260517215212.png]]
*图 3.7：Hadoop MapReduce Logo*

### MapReduce 范式

MapReduce 的核心思想是将分布式计算分解为两个基本阶段：**映射（Mapping）**和**归约（Reducing）**。这种方法从函数式编程概念中汲取灵感，特别是映射和归约的过程，涉及将函数应用于数据然后聚合结果。

- **映射阶段（Mapping Phase）**：在映射阶段，数据被分成较小的块并并行处理。每个数据片段被独立分析，对于每条相关信息，生成一个键值对。这些键值对随后根据其键进行分组和排序。

- **洗牌和排序（Shuffle and Sort）**：在映射阶段之后，框架执行洗牌和排序操作。此步骤涉及重新组织映射器创建的中间键值对，确保与同一键关联的所有值被分组。这种重新组织对后续的归约阶段至关重要。

- **归约阶段（Reducing Phase）**：在归约阶段，通过对分组和排序的键值对应用归约操作来进行进一步处理。归约操作可以根据数据处理任务的具体要求涉及多种计算、聚合或过滤。

### MapReduce 作业的解剖

让我们深入了解 MapReduce 作业的关键组件：

- **输入数据（Input Data）**：指定用于处理的原始数据作为 MapReduce 作业的输入。

- **分片（Splits）**：这些数据被分段，每个段分配给一个映射器。

- **映射器（Mapper）**：映射器负责处理输入数据段。它们处理每个记录，执行必要的操作，并发出键值对。重要的是，映射器并发运行，处理各自分配的数据。

- **洗牌和排序（Shuffle and Sort）**：在映射器完成任务后，框架协调洗牌和排序阶段。此阶段涉及对映射器产生的键值对进行排序和分组，以确保与同一键关联的所有值被分组。

- **归约器（Reducer）**：归约器处理在洗牌和排序阶段生成的分组键值对。它们对与每个键关联的值应用归约函数。与映射器类似，归约器并发运行，同时处理不同的键组。

![[Pasted image 20260517215222.png]]
*图 3.8：MapReduce 作业示意图*

- **输出（Output）**：MapReduce 作业的最终输出由键值对组成，键表示结果类别，值包含聚合或处理后的数据。

> 有关 wordcount 代码的详细解释，请参阅"MapReduce 动手实践"部分。

### MapReduce 的优势

以下是 MapReduce 框架的一些关键优势：

- **统一的计算和存储（Unified Compute and Storage）**：在许多 MapReduce 配置中，计算节点和存储节点是共置的，意味着 MapReduce 框架和 Hadoop 分布式文件系统（HDFS）共享相同的节点集。这种安排提供了显著的优势，因为它允许框架智能地在所需数据已经存在的节点上调度任务。因此，这在整个集群中产生了极高的聚合带宽。

- **核心组件（Core Components）**：MapReduce 框架由几个关键组件组成，包括一个主 YARN ResourceManager、每个集群节点一个工作 YARN NodeManager，以及每个应用程序一个 MRAppMaster。

- **应用程序开发（Application Development）**：至少，开发者需要指定输入和输出位置，并通过实现相关接口或抽象类提供 map 和 reduce 函数。这些规范，连同其他作业参数，构成了作业配置。随后，Hadoop 作业客户端将作业（连同必要的配置和软件）提交给 ResourceManager。ResourceManager 负责将软件和配置分发到工作节点，调度任务，监控其进度，并向作业客户端提供状态更新和诊断信息。

- **编程语言（Programming Language）**：虽然 Hadoop 框架本身是用 Java 实现的，但需要注意的是，MapReduce 应用程序不必只用 Java 编写。例如，Hadoop Streaming 允许用户使用各种可执行文件（如 shell 工具）作为映射器和归约器来创建和执行作业。此外，Hadoop Pipes 提供了一个 SWIG 兼容的 C++ API 来实现 MapReduce 应用程序，为基于 Java 的开发提供了替代方案。

- **输入和输出（Input and Output）**：MapReduce 框架专门操作 `<key, value>` 对。本质上，它将作业的输入视为 `<key, value>` 对的集合，并生成类似的 `<key, value>` 对作为作业的输出。这些键和值必须可由框架序列化，因此必须实现 Writable 接口。此外，键类应该实现 WritableComparable 接口，以便框架进行排序。

- **可扩展性和容错性（Scalability and Fault Tolerance）**：MapReduce 在可扩展性方面表现出色，通过将工作负载分布到集群中的多台机器上，高效地处理海量数据集。在处理过程中机器或任务发生故障时，框架会自动将任务重新分配给其他可用机器，确保容错性和可靠的执行。

### MapReduce 的用例

MapReduce 作为一种多功能框架，被用于广泛的数据处理任务，包括数据清洗、日志分析、搜索引擎索引，甚至机器学习。其简单性和可扩展性使其成为 Hadoop 生态系统中不可或缺的工具，有效应对大数据处理中的重大挑战。

### MapReduce 在 Hadoop 技术栈中的位置

在 Hadoop 生态系统技术栈中，MapReduce 是基础组件之一，在数据处理中起着至关重要的作用。MapReduce 位于 Hadoop 核心组件之上，与 HDFS 密切交互以处理和分析分布式数据。

![[Pasted image 20260517215235.png]]
*图 3.9：Hadoop 技术栈*

虽然 MapReduce 在早期 Hadoop 部署中是主要的处理框架，但 Hadoop 生态系统此后已发展到包含更多功能和更高效的框架，如 Apache Spark。然而，MapReduce 仍然是 Hadoop 生态系统中不可或缺的一部分，特别是对于特定的批处理用例。

## Hadoop Streaming API：用自定义脚本简化 MapReduce

Hadoop Streaming 是 Hadoop 的一个强大特性，允许你使用自己熟悉的脚本语言（如 Python、Ruby 或 Perl）编写 MapReduce 应用程序，而无需使用 Java。这种灵活性对于可能不精通 Java 但希望利用 Hadoop 处理大数据集的数据工程师和数据科学家来说特别有价值。在本小节中，我们将探讨 Hadoop Streaming 及其如何简化 MapReduce 应用程序的开发。

### Hadoop Streaming 如何工作

Hadoop Streaming 允许你使用自定义脚本作为 Map 和 Reduce 函数。以下是其工作原理：

- **Map 阶段**：在 Map 阶段，Hadoop 读取输入数据并将其逐行输入到你的自定义脚本。你的脚本处理每一行并将键值对作为输出发出。Hadoop 收集这些键值对并按键排序。

- **洗牌和排序（Shuffle and Sort）**：在 Map 阶段之后，Hadoop 执行洗牌和排序步骤。它按键分组键值对并对它们进行排序，使特定键的所有值聚集在一起。这是减少 Reduce 阶段网络数据传输的关键步骤。

- **Reduce 阶段**：在 Reduce 阶段，Hadoop 将具有相同键的每组键值对发送到你的自定义 Reduce 脚本。你的脚本处理这些组并将最终的键值对作为输出发出。

### Hadoop Streaming 的优势

以下是 Hadoop Streaming 的优势：

- **易用性（Ease of Use）**：使用 Hadoop Streaming，你可以使用已经熟悉的脚本语言编写 MapReduce 作业，减少与 Java 编程相关的学习曲线。

- **快速原型开发（Rapid Prototyping）**：它允许快速原型设计和 MapReduce 作业的实验，这对数据分析和探索非常有益。

- **集成（Integration）**：你可以将 Hadoop Streaming 作业集成到你现有的数据处理流水线中，即使它们是用不同的脚本语言编写的。

Hadoop Streaming 是简化 MapReduce 应用程序开发的宝贵工具，特别是对于那些更喜欢脚本语言而非 Java 的人。它使数据工程师和数据科学家能够利用 Hadoop 的强大功能，而无需大量的 Java 编程技能，使大数据处理更加可访问和高效。

对 MapReduce 的扎实理解对于释放 Hadoop 的全部潜力至关重要，因为许多 Hadoop 生态系统组件和应用程序都是建立在这个基础范式之上的。精通 MapReduce 原则使数据工程师和分析师能够为大规模数据分析设计和执行高效的数据处理流水线。

## Apache Tez

在本节中，我们将简要介绍 Tez 的高层概述。

Apache Tez 是一个强大的数据处理框架，通过提供更灵活和高效的数据处理能力来取代 Hadoop 的 MapReduce。Apache TEZ 项目旨在构建一个应用程序框架，允许使用复杂的有向无环图（DAG）来处理数据任务。它目前构建在 Apache Hadoop YARN 之上。

Tez 的两个主要设计主题是：

**赋予最终用户能力（Empowering End Users）：**
- 富有表现力的数据流定义 API
- 灵活的 Input-Processor-Output 运行时模型
- 数据类型无关
- 简化部署

**执行性能（Execution Performance）：**
- 相对于 MapReduce 的性能提升
- 最佳资源管理
- 运行时计划重配置
- 动态物理数据流决策

### Tez 架构的关键组件

Tez 架构由几个关键组件组成，它们协同工作以实现复杂的有向无环图（DAG）数据处理。以下是 Apache Tez 架构的概述：

- **Tez Application Master（Tez AM）**：此组件管理 Hadoop 集群中 Tez 应用程序的执行。它与 YARN ResourceManager 协商资源，协调任务执行，并监控应用程序的进度。

- **有向无环图（DAG）**：Tez 将数据处理作业表示为顶点和边的 DAG。每个顶点对应一个处理任务，而边定义任务之间的数据流。Tez 应用程序可以有多个 DAG，使其适用于复杂的工作流。

- **顶点（Vertices）**：顶点是 DAG 内的各个处理任务。它们可以是两种类型：Map 或 Reduce。顶点封装了数据转换和处理的逻辑。

- **边（Edges）**：边表示顶点之间的数据流。它们指定数据如何从一个顶点传输到另一个顶点。边可以具有各种特征，如数据广播、一对一或一对多数据传输。

- **输入/输出（I/O）处理器（Input/Output Handlers）**：这些组件管理顶点与外部数据源或接收器之间的交互。它们处理数据输入和输出操作，确保处理期间高效的数据移动。

- **任务调度器（Task Scheduler）**：Tez 包含一个任务调度器，确定 DAG 中任务的执行顺序。它考虑数据可用性、资源约束和优化机会等因素来提高作业性能。

- **用户逻辑（User Logic）**：架构的这一部分表示用户提供的实际数据处理逻辑。它包括自定义代码或应用程序，定义 DAG 中顶点的行为。

- **洗牌和合并（Shuffle and Merge）**：Tez 高效处理顶点之间的数据洗牌和合并，减少数据传输开销。它提供了对任务之间数据交换方式的细粒度控制。

- **Yet Another Resource Negotiator（YARN）**：Tez 运行在 YARN 之上，YARN 管理集群资源。YARN 确保 Tez 应用程序获得必要的计算资源以高效执行。

- **分布式缓存（Distributed Cache）**：Tez 应用程序可以使用 Hadoop 的分布式缓存将文件、归档或其他资源分发到集群节点上运行的任务。这有助于管理跨任务的共享数据或资源。

总体而言，Apache Tez 的架构旨在为用户提供富有表现力的数据流定义 API、灵活的运行时模型和最佳资源管理。它实现了改进的性能、高效的任务协调和动态数据流决策，使其成为大数据处理工作流的强大选择。

### Tez 的优势

Tez 的优势包括：

- **相对于 MapReduce 的性能提升**：与 MapReduce 相比，Apache Tez 通过多项优化实现了显著的性能提升。它消除了连续计算之间的复制写入障碍，简化了数据流并减少了冗余。此外，Tez 减少了工作流作业的作业启动开销，确保更快的任务启动。它消除了每个工作流作业中 map 读取的额外阶段，提高了数据处理效率。此外，Tez 缓解了在前一个作业完成后启动的工作流作业所经历的队列和资源争用问题，产生了更简化、响应更快的数据处理流水线。

![[Pasted image 20260517215247.png]]
*图 3.10：Tez 消除了连续计算之间的复制写入障碍*

Tez 管理复杂 DAG 的能力使得 Apache Hive 和 Apache Pig 等工具能够在单个 Tez 作业中处理以前需要多个 MapReduce 作业的数据，如上图所示。这里，四个 MR 作业被简化为一个作业。

- **运行时计划重配置（Plan Reconfiguration at Runtime）**：Apache Tez 支持动态运行时重配置，在数据处理过程中提供增强的灵活性。它根据数据大小、用户操作资源、可用集群资源和数据局部性等因素动态调整运行时并发控制。Tez 还支持在运行中高级修改数据流图结构，允许高效地适应不断变化的处理需求。它与查询优化协作促进渐进式图构建，确保你的数据处理任务可以根据需要无缝演进和扩展。

![[Pasted image 20260517215256.png]]
*图 3.11：Tez 最佳资源管理*

- **最佳资源管理（Optimal Resource Management）**：Tez 通过重用以启动新任务来高效利用 YARN 容器，从而最小化资源开销。此外，它通过利用 YARN 容器跨任务共享对象来最大化资源利用率，提高性能并减少冗余资源分配的需求。这些资源管理技术有助于提高 Tez 中数据处理任务的整体效率和可扩展性。

### Tez 在 Hadoop 技术栈中的位置

Apache Tez 定位为数据处理的框架，位于 YARN 之上，与其他数据处理框架并列。Tez 设计为提供比传统 MapReduce 更灵活和高效的数据处理模型。它支持复杂的有向无环图（DAG）数据处理任务，可以被 Apache Hive 和 Apache Pig 等应用程序用来优化查询执行。

![[Pasted image 20260517215304.png]]
*图 3.12：Hadoop 技术栈*

## Part III：动手实践部分 — Hadoop 和 YARN

在本节中，我们将以伪分布式模式搭建一个 Hadoop 集群。

我们首先在 Dockerfile 中设置前置条件，然后构建 Docker 镜像。我们将使用此镜像启动一个 Docker 容器并验证设置。

在此初始设置之后，我们将在 Docker 容器中进行 Hadoop-3.3.6 和 YARN 的安装。在本节中：

- 我们将讨论各种配置文件。
- 启动 Hadoop 和 YARN 服务。
- 一旦容器和服务启动并运行，我们将学习：
  - 通过在集群上执行各种 Hadoop 和 YARN 命令来学习它们。
  - 将文件加载到我们的 Hadoop 分布式文件系统中，并探索 HDFS NameNode UI 和 YARN UI。
- 最后，我们将用 Java、Python 和 Perl 编写并运行经典的 Word Count MapReduce 作业。

### 搭建 Hadoop 集群

现在我们对 Hadoop 架构以及 YARN 在资源管理中的角色有了高层次的理解，我们可以开始以下列三种支持的模式之一搭建 Hadoop 集群：

- **本地（独立）模式（Local / Standalone Mode）**：默认情况下，Hadoop 配置为以非分布式模式运行，作为单个 Java 进程。这对调试源代码很有用。

- **伪分布式模式（Pseudo-Distributed Mode）**：Hadoop 也可以在单节点上以伪分布式模式运行，其中每个 Hadoop 守护进程在单独的 Java 进程中运行。这就是我们在本书中用来学习的模式。

- **完全分布式模式（Fully Distributed Mode）**：有关设置完全分布式、非平凡集群的信息，请参考官方文档。我们不会在本书中涵盖它，因为它是非平凡的，且一些步骤因生产环境中使用的环境类型（HA、Kerberos 等）而异。

### 在伪分布式模式下搭建单节点集群

本节介绍如何设置和配置单节点 Hadoop 安装，以便你可以使用 Hadoop MapReduce 和 Hadoop 分布式文件系统（HDFS）快速执行简单操作。

#### 前置条件

这些前置条件确保顺利的 Hadoop 部署和使用体验。以下是你需要准备好的内容：

**操作系统支持**：
- Hadoop 与 GNU/Linux 兼容，使其成为开发和生产环境的合适选择。

**Java 安装**：
- 必须在你的系统上安装 Java™，因为 Hadoop 依赖它来运行各种组件和功能。

**SSH 设置**：
- 要使用管理远程 Hadoop 守护进程的 Hadoop 脚本，你需要安装 ssh 并运行 sshd（SSH 守护进程）。
- 还建议安装 pdsh 以改进 SSH 资源管理。

**Docker 作为替代方案**：
- 如果你对开发环境使用 Docker，满足这些前置条件将变得更加简单，无论你的主机操作系统是什么。

**访问章节代码脚本**：
- 本章的代码脚本可在 GitHub 仓库获取：https://github.com/simhadri-g/AnalyticsWithHadoop/tree/main/Chapter-3

**代码编辑器**：
- 你将需要一个代码编辑器来处理 Hadoop 配置和脚本。Visual Studio Code（VS Code）或你选择的任何其他代码编辑器都可以。

现在，让我们使用 Dockerfile 设置前置条件：

**步骤 1：平台选择**
- 我们将使用 Ubuntu 18.04 基础镜像来构建我们的 Docker 镜像。

**步骤 2：用户配置**
- 为了简化读者的设置过程，我们在 Docker 容器中以 root 用户身份运行所有命令。
- 请注意，在生产集群中以 root 用户身份运行是被强烈反对的，除非你对相关影响有深刻的理解。

**步骤 3：更新 APT 仓库**
- 我们更新高级软件包工具（APT）仓库，以确保我们能够访问最新的软件包信息。

**步骤 4：Java 安装**
- 在我们的 Docker 镜像中，我们从 `openjdk-r/ppa` 安装 Java 8，因为它是 Hadoop 兼容的版本之一。

**步骤 5：实用工具和 SSH 设置**
- 为了增加便利，我们安装各种实用工具，这些工具可以在整个 Hadoop 设置和使用过程中辅助完成任务。

按照以下 Dockerfile 片段所示的步骤，你将创建一个已准备好必要前置条件的 Docker 镜像，使你无论主机操作系统是什么，都能更轻松地开始使用 Hadoop。

### 搭建 Hadoop、YARN 和 MR

**步骤 6：下载并解压 tar 文件**

要获取 Hadoop 发行版，请从 Apache 下载镜像之一下载最新的稳定版本。截至撰写本书时，最新版本是 hadoop-3.3.6。你可以从此链接获取：

```
https://dlcdn.apache.org/hadoop/common/hadoop-3.3.6/hadoop-3.3.6.tar.gz
```

**步骤 7：配置文件并复制 Bootstrap 脚本**

下一步涉及通过编辑以下基本文件并将其复制到 Docker 容器中来配置 Hadoop 和 YARN：

- `hdfs-site.xml`
- `core-site.xml`
- `hadoop-env.sh`

此外，你需要复制 `bootstrap.sh` 脚本，该脚本执行以下任务：
- 设置环境变量
- 复制配置文件
- 启动 Hadoop 和 YARN 服务

**启动和停止服务：**

要启动和停止带有 Yet Another Resource Negotiator（YARN）的 Hadoop 分布式文件系统（HDFS），你通常使用以下命令。这些命令假设你已经正确安装和配置了 Hadoop。

启动 HDFS：

```bash
start-dfs.sh
```

启动 YARN：

```bash
start-yarn.sh
```

这些命令将在你的 Hadoop 集群上启动 HDFS 守护进程（NameNode 和 DataNode）以及 YARN ResourceManager 和 NodeManager。

停止 HDFS 和 YARN：

```bash
stop-yarn.sh
stop-dfs.sh
```

确保在适当的目录中运行这些命令，或者根据需要指定这些脚本的完整路径。此外，你可能需要在首次设置 Hadoop 时格式化 HDFS 文件系统。使用以下命令格式化 HDFS（仅需一次）：

```bash
hadoop namenode -format
```

始终确保你的 Hadoop 集群已正确配置，并且你拥有启动和停止服务的必要权限。这些命令可能因你的 Hadoop 发行版和设置而略有不同。

你可以从此位置访问配置文件和 bootstrap 脚本：

```
https://github.com/simhadri-g/AnalyticsWithHadoop/tree/main/Chapter-3
```

**步骤 8：创建用户并暴露所需端口**

创建 Hadoop Admin 用户并暴露必要的端口是下一个重要任务。在我们的案例中，需要暴露以下端口：

- **HDFS 端口**：1004、1006、8020、9866、9867、9870、9864、50470、9000
- **YARN 端口**：8030、8031、8032、8033、8040、8041、8042、8088、10020、19888
- **SOCKS 端口**：1180
- **HDFS datanode**：9866

此过程确保建立必要的网络通信和访问，以便 Hadoop 和 YARN 有效运行。

**步骤 9：包含 Hadoop 和前置条件的完整 Dockerfile**

```dockerfile
# 步骤 1：平台选择
FROM ubuntu:18.04
LABEL key="simhadri-g"

# 步骤 2：用户配置
RUN apt-get update && apt-get -y install sudo
RUN adduser --disabled-password --gecos '' docker
RUN adduser docker sudo
RUN echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
USER root

# 步骤 3：更新 APT 仓库
RUN sudo apt-get -y install software-properties-common
RUN sudo add-apt-repository ppa:openjdk-r/ppa
RUN sudo apt-get update

# 步骤 4：Java 安装
RUN apt-get -y install openjdk-8-jdk
RUN ln -s /usr/lib/jvm/java-1.8.0-openjdk-amd64/ /usr/lib/jvm/java-1.8.0

# 步骤 5：实用工具
RUN apt -y install vim
RUN apt -y install nano
RUN apt -y install wget tar sudo rsync
RUN sudo apt-get update
RUN sudo apt-get -y install apache2
RUN sudo apt-get -y install tree

# 设置 SOCKS 代理
RUN apt-get install -y openssh-server

# 免密码 SSH
RUN ssh-keygen -q -N "" -t rsa -f /root/.ssh/id_rsa
RUN cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
RUN chmod 755 /root && chmod 700 /root/.ssh
RUN passwd --unlock root

# 步骤 6：下载 hadoop-3.3.6 并解压 tar.gz
RUN wget https://dlcdn.apache.org/hadoop/common/hadoop-3.3.6/hadoop-3.3.6.tar.gz
RUN tar -xvzf hadoop-3.3.6.tar.gz
RUN ln -sf /hadoop-3.3.6 /hadoop
RUN apt-get -y clean all && rm -rf /tmp/* /var/tmp/*

# 步骤 7：复制配置文件和 bootstrap 脚本
RUN mkdir /conf
COPY core-site.xml /conf/core-site.xml
COPY hdfs-site.xml /conf/hdfs-site.xml
COPY hadoop-env.sh /conf/hadoop-env.sh

COPY bootstrap.sh /bootstrap.sh

# 步骤 8：创建用户
RUN sudo addgroup hadoop
RUN sudo adduser --ingroup hadoop hadoop

# HDFS 端口
EXPOSE 1004 1006 8020 9866 9867 9870 9864 50470 9000 50070

# YARN 端口
EXPOSE 8030 8031 8032 8033 8040 8041 8042 8088 10020 19888

# SOCKS 端口
EXPOSE 1180

# HDFS datanode
EXPOSE 9866
```

**步骤 10：构建 Docker 镜像**

现在，我们将使用 Dockerfile 构建一个 Docker 镜像，执行以下命令：

```bash
docker build -t analytics-with-hadoop ./
```

此步骤需要一些时间。

如果一切成功，你将看到类似以下内容：

```
AnalyticsWithHadoop\Chapter-3\Docker-setup> docker build -t analytics-with-hadoop ./
[+] Building 208.3s (38/38) FINISHED                      docker:default
=> [internal] load .dockerignore                                   0.0s
=> => transferring context: 2B                                     0.0s
=> [internal] load build definition from Dockerfile                 0.0s
=> => transferring dockerfile: 1.93kB                              0.0s
=> [internal] load metadata for docker.io/library/ubuntu:18.04     2.3s
=> [auth] library/ubuntu:pull token for registry-1.docker.io       0.0s
=> [internal] load build context                                   0.0s
=> => transferring context: 133B                                   0.0s
=> [ 1/32] FROM docker.io/library/ubuntu:18.04                     0.0s
=> [ 2/32] RUN apt-get update && apt-get -y install sudo           0.0s
=> [ 3/32] RUN adduser --disabled-password --gecos '' docker       0.0s
=> [ 4/32] RUN adduser docker sudo                                 0.0s
=> [ 5/32] RUN echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers 0.0s
=> [ 6/32] RUN sudo apt-get -y install software-properties-common  0.0s
=> [ 7/32] RUN sudo add-apt-repository ppa:openjdk-r/ppa           0.0s
=> [ 8/32] RUN sudo apt-get update                                 0.0s
=> [ 9/32] RUN apt-get -y install openjdk-8-jdk                    0.0s
=> [10/32] RUN ln -s /usr/lib/jvm/java-1.8.0-openjdk-amd64/ ...   0.3s
=> [11/32] RUN apt -y install vim                                 11.8s
=> [12/32] RUN apt -y install nano                                 4.4s
=> [13/32] RUN apt -y install wget tar sudo rsync                 11.0s
=> [14/32] RUN sudo apt-get update                                 3.4s
=> [15/32] RUN sudo apt-get -y install apache2                    26.7s
=> [16/32] RUN sudo apt-get -y install tree                        3.5s
=> [17/32] RUN apt-get install -y openssh-server                  23.5s
=> [18/32] RUN ssh-keygen -q -N "" -t rsa -f /root/.ssh/id_rsa    0.5s
=> [19/32] RUN cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys 0.5s
=> [20/32] RUN chmod 755 /root && chmod 700 /root/.ssh            0.5s
=> [21/32] RUN passwd --unlock root                                0.4s
=> [22/32] RUN wget https://dlcdn.apache.org/hadoop/common/...    97.3s
=> [23/32] RUN tar -xvzf hadoop-3.3.6.tar.gz                      11.8s
=> [24/32] RUN ln -sf /hadoop-3.3.6 /hadoop                        0.3s
=> [25/32] RUN apt-get -y clean all && rm -rf /tmp/* /var/tmp/*    0.4s
=> [26/32] RUN mkdir /conf                                         0.4s
=> [27/32] COPY core-site.xml /conf/core-site.xml                  0.0s
=> [28/32] COPY hdfs-site.xml /conf/hdfs-site.xml                  0.0s
=> [29/32] COPY hadoop-env.sh /conf/hadoop-env.sh                  0.0s
=> [30/32] COPY bootstrap.sh /bootstrap.sh                         0.0s
=> [31/32] RUN sudo addgroup hadoop                                0.4s
=> [32/32] RUN sudo adduser --ingroup hadoop hadoop                0.5s
=> exporting to image                                              7.9s
=> => exporting layers                                             7.9s
=> => writing image sha256:5da5e80cd07...                          0.0s
=> => naming to docker.io/library/analytics-with-hadoop            0.0s
```

**步骤 11：验证设置并登录到集群**

完成 Hadoop 环境的 Docker 镜像设置后，验证一切是否正常至关重要。以下是确认 Docker 容器顺利运行的步骤：

*Docker 镜像列表：*

首先，你可以列出 Docker 镜像以确保你构建的镜像已成功创建。打开终端或命令提示符，导航到你的 Hadoop 设置文件所在目录。然后执行以下命令：

```
AnalyticsWithHadoop\Chapter-3> docker images
REPOSITORY             TAG     IMAGE ID      CREATED        SIZE
analytics-with-hadoop  latest  27b4de901bc9  8 minutes ago  652MB
```

此命令将显示你系统上的 Docker 镜像列表。查找名为 `analytics-with-hadoop`、标签为 `latest` 的镜像（或你在 Docker 镜像创建期间指定的其他标签）。

*Docker 容器启动：*

接下来，你需要基于已创建的镜像启动一个 Docker 容器。此容器将作为你的 Hadoop 开发环境。使用以下命令启动容器：

```bash
docker run --rm -t --name analytics-with-hadoop --hostname localhost -P \
  -p9866:9866 -p10000:10000 -p10001:10001 -p10002:10002 -p9000:9000 \
  -p8000:8000 -p3306:3306 -p50070:50070 -p50030:50030 -it -d \
  analytics-with-hadoop /bin/bash -c "/bootstrap.sh >/tmp/boostrap.log"
```

让我们分解这个命令：

- `docker run`：启动一个新容器。
- `--rm`：容器退出时自动删除，保持系统清洁。
- `-t`：分配伪 TTY，允许与容器交互。
- `--name analytics-with-hadoop`：为容器分配名称，方便引用。
- `--hostname localhost`：将容器的主机名设置为 `localhost`。
- `-P`：暴露 HDFS 和 YARN 所需的端口。
- `-it`：结合 `-i`（交互式）和 `-t`（TTY）选项，实现交互式终端会话。
- `-d`：以分离模式运行容器，意味着它在后台运行。
- `analytics-with-hadoop`：指定要使用的 Docker 镜像。
- `/bin/bash -c "/bootstrap.sh >/tmp/boostrap.log"`：在容器内启动 Bash shell 并运行 bootstrap.sh 脚本。

*Docker 容器列表：*

现在，要验证容器是否正在运行，你可以列出所有 Docker 容器，包括当前活动的和已退出的。使用以下命令：

```bash
docker ps -a
```

此命令将显示有关你的 Docker 容器的信息表。查找名为 `analytics-with-hadoop` 的容器，它应该显示容器正在运行。

```
AnalyticsWithHadoop\Chapter-3\Docker-setup> docker ps -a
CONTAINER ID   IMAGE                   COMMAND                  CREATED         STATUS         PORTS       NAMES
60648287a875   analytics-with-hadoop   "/bin/bash -c '/boot…"   6 seconds ago   Up 3 seconds   analytics-with-hadoop
```

*登录到 Docker 容器并检查 Java 版本：*

最后，你可以登录到 Docker 容器并验证 Java 是否正确安装。使用以下命令：

```bash
docker exec -it analytics-with-hadoop "/bin/bash"
```

此命令在运行的容器内打开一个 Bash shell，允许你在其中执行命令。进入容器后，运行：

```bash
/usr/lib/jvm/java-1.8.0/jre/bin/java -version
```

此命令应显示已安装的 Java 版本信息，确认 Java 在你的 Docker 容器中已启动并运行。

```
PS D:\hadoopBookGit\AnalyticsWithHadoop\Chapter-3> docker exec -it analytics-with-hadoop "/bin/bash"
root@localhost:/#
root@localhost:/# /usr/lib/jvm/java-1.8.0/jre/bin/java -version
openjdk version "1.8.0_362"
OpenJDK Runtime Environment (build 1.8.0_362-8u372-ga~us1-0ubuntu1~18.04-b09)
OpenJDK 64-Bit Server VM (build 25.362-b09, mixed mode)
```

*运行简单 Hadoop 命令：*

最后，你可以通过运行基本的 Hadoop 命令来测试 Hadoop。例如：

```bash
$HADOOP_HOME/bin/hdfs
```

运行此命令应提供 Hadoop 分布式文件系统（HDFS）命令的使用信息，确认 Hadoop 已在 Docker 容器中正确设置并运行。

*JPS 命令：*

`jps` 的输出提供了与 Hadoop 集群相关的运行中 Java 进程的快速快照。它允许管理员和用户验证基本的 Hadoop 服务是否启动并运行。

```
AnalyticsWithHadoop\Chapter-3\Docker-setup> docker exec -it analytics-with-hadoop "/bin/bash"
root@localhost:/#
root@localhost:/# jps
1200 SecondaryNameNode
882 NameNode
154 ResourceManager
284 NodeManager
1006 DataNode
1519 Jps
```

各进程说明：

- **1200 SecondaryNameNode**：SecondaryNameNode 是 Hadoop 中的辅助服务，通过定期合并 EditLog 的更改到 FsImage 来帮助主 NameNode 进行检查点操作，防止其增长过大。这有助于在发生 NameNode 故障时减少恢复时间。

- **882 NameNode**：NameNode 是 Hadoop 分布式文件系统（HDFS）中的核心组件。它管理文件系统的元数据和命名空间，包括文件、目录及其各自块的信息。NameNode 对文件系统的运行至关重要。

- **154 ResourceManager**：ResourceManager 是 Yet Another Resource Negotiator（YARN）的关键组件，YARN 是 Hadoop 的资源管理和作业调度系统。它将资源分配给集群上运行的各种应用程序，并监控其资源使用情况。

- **284 NodeManager**：NodeManager 是 YARN 的另一个组件。它在集群中的各个节点上运行，负责监控该节点上的资源使用情况并将其报告给 ResourceManager。它还管理容器的执行，容器是运行应用程序任务的隔离环境。

- **1006 DataNode**：DataNode 负责在 HDFS 中存储文件的实际数据块。每个 DataNode 管理其本地磁盘上存储的数据，并定期向 NameNode 发送心跳消息，报告其健康状况和正在存储的块列表。

在健康集群的上下文中，你应该看到这些进程如上所示正在运行。如果这些进程中的任何一个没有运行，可能表明你的 Hadoop 集群存在需要解决的问题。

验证这些组件可确保你基于 Docker 的 Hadoop 环境已正确设置并准备好进行进一步使用。这是确认前置条件已满足、开发环境运行正常的步骤。

**步骤 12：恭喜！你已经成功搭建了 Hadoop 集群！**

给自己鼓掌。如果你能走到这一步，你太棒了。

按照这些步骤，你可以确保你的 Hadoop 环境在 Docker 容器中按预期运行。

## 探索 Hadoop 和 YARN 命令

现在我们有了一个正常工作的 Hadoop 集群，我们可以尝试运行和理解各种 Hadoop 命令。

### Hadoop 命令：驾驭大数据领域

在大数据和 Hadoop 的世界中，掌握基本的 Hadoop 命令对于高效管理和分析海量数据集至关重要。Hadoop 提供了一组丰富的命令行工具来与其生态系统交互。在本小节中，我们将探索一些最基本的 Hadoop 命令，根据其主要功能分为几类：

#### HDFS 命令

HDFS 是 Hadoop 的分布式文件系统，专为存储和管理大数据集而设计。以下是一些基本的 HDFS 命令：

| 命令 | 说明 |
|------|------|
| `hdfs dfs -ls` | 列出 HDFS 中的文件和目录 |
| `hdfs dfs -mkdir` | 在 HDFS 中创建目录 |
| `hdfs dfs -put` | 从本地文件系统复制文件或目录到 HDFS |
| `hdfs dfs -get` | 从 HDFS 复制文件或目录到本地文件系统 |
| `hdfs dfs -cat` | 显示 HDFS 中文件的内容 |
| `hdfs dfs -rm` | 从 HDFS 中删除文件或目录 |
| `hdfs dfs -du` | 显示 HDFS 中文件或目录的空间使用摘要 |
| `hdfs dfs -chmod` | 更改文件或目录的权限 |
| `hdfs dfs -mv` | 移动文件/目录 |

**表 3.1：Hadoop 命令**

#### MapReduce 作业提交命令

Hadoop MapReduce 是一个用于并行处理大数据集的框架。要运行 MapReduce 作业，你需要以下命令：

- `hadoop jar`：使用指定的 JAR 文件和主类向集群提交 MapReduce 作业。
- `hadoop job -list`：列出所有运行中和已完成的 MapReduce 作业。
- `hadoop job -kill`：终止一个运行中的 MapReduce 作业。

#### Hadoop 配置命令

管理 Hadoop 配置对于自定义你的 Hadoop 集群至关重要。以下是一些与配置相关的命令：

- `hadoop version`：显示 Hadoop 版本信息。

```
root@localhost:/# $HADOOP_HOME/bin/hadoop version

Hadoop 3.3.6
Source code repository https://github.com/apache/hadoop.git -r 1be78238728da9266a4f88195058f08fd012bf9c
Compiled by ubuntu on 2023-06-18T08:22Z
Compiled on platform linux-x86_64
Compiled with protoc 3.7.1
From source with checksum 5652179ad55f76cb287d9c633bb53bbd
This command was run using /hadoop-3.3.6/share/hadoop/common/hadoop-common-3.3.6.jar
```

- `hadoop classpath`：打印运行 Hadoop 工具所需的 classpath。

```
root@localhost:/# $HADOOP_HOME/bin/hadoop classpath

/hadoop/etc/hadoop:/hadoop/share/hadoop/common/lib/*:/hadoop/share/hadoop/common/*:/hadoop/share/hadoop/hdfs:/hadoop/share/hadoop/hdfs/lib/*:/hadoop/share/hadoop/hdfs/*:/hadoop/share/hadoop/mapreduce/*:/hadoop/share/hadoop/yarn:/hadoop/share/hadoop/yarn/lib/*:/hadoop/share/hadoop/yarn/*
```

- `hadoop envvars`：显示计算出的 Hadoop 环境变量。

```
root@localhost:/# $HADOOP_HOME/bin/hadoop envvars

JAVA_HOME='/usr/lib/jvm/java-1.8.0'
HADOOP_COMMON_HOME='/hadoop'
HADOOP_COMMON_DIR='share/hadoop/common'
HADOOP_COMMON_LIB_JARS_DIR='share/hadoop/common/lib'
HADOOP_COMMON_LIB_NATIVE_DIR='lib/native'
HADOOP_CONF_DIR='/hadoop/etc/hadoop'
HADOOP_TOOLS_HOME='/hadoop'
HADOOP_TOOLS_DIR='share/hadoop/tools'
HADOOP_TOOLS_LIB_JARS_DIR='share/hadoop/tools/lib'
```

#### Hadoop 集群管理命令

如果你负责管理 Hadoop 集群，这些命令至关重要：

- `hadoop dfsadmin -report`：获取 HDFS 集群整体状态的报告。

```
root@localhost:/# $HADOOP_HOME/bin/hadoop dfsadmin -report

Configured Capacity: 1081101176832 (1006.85 GB)
Present Capacity: 1019424505856 (949.41 GB)
DFS Remaining: 1019424477184 (949.41 GB)
DFS Used: 28672 (28 KB)
DFS Used%: 0.00%
Replicated Blocks:
Under replicated blocks: 0
Blocks with corrupt replicas: 0
Missing blocks: 0
...
-------------------------------------------------
Live datanodes (1):

Name: 127.0.0.1:9866 (localhost)
Hostname: localhost
Decommission Status : Normal
Configured Capacity: 1081101176832 (1006.85 GB)
DFS Used: 28672 (28 KB)
Non DFS Used: 6684315648 (6.23 GB)
DFS Remaining: 1019424477184 (949.41 GB)
DFS Used%: 0.00%
DFS Remaining%: 94.30%
```

- `hadoop dfsadmin -safemode`：进入、离开或获取 HDFS 安全模式状态。
- `hadoop dfsadmin -refreshNodes`：刷新 DataNode 列表。
- `hadoop namenode -format`：格式化 HDFS 文件系统（谨慎使用）。
- `hadoop dfs -balancer`：在 DataNode 之间平衡数据块以实现更好的分布。

#### Hadoop Yet Another Resource Negotiator（YARN）命令

YARN 是 Hadoop 的资源管理层。这些命令帮助管理 YARN 资源：

- `yarn application -list`：列出所有 YARN 应用程序。
- `yarn application -kill`：终止一个运行中的 YARN 应用程序。
- `yarn logs -applicationId`：查看特定 YARN 应用程序的日志。

#### 其他 Hadoop 工具

Hadoop 还提供各种工具，用于任务如分布式复制和归档管理：

- `hadoop distcp`：在 HDFS 集群之间高效复制数据。
- `hadoop archive`：创建和管理 Hadoop 归档文件。

我们还可以运行 `$HADOOP_HOME/bin/hdfs` 来查看 Hadoop 中的完整命令列表：

```
root@localhost:/# $HADOOP_HOME/bin/hdfs
Usage: hdfs [OPTIONS] SUBCOMMAND [SUBCOMMAND OPTIONS]

OPTIONS is none or any of:
--buildpaths                       attempt to add class files from build tree
--config dir                       Hadoop config directory
--daemon (start|status|stop)       operate on a daemon
--debug                            turn on shell script debug mode
--help                             usage information
--hostnames list[,of,host,names]   hosts to use in worker mode
--hosts filename                   list of hosts to use in worker mode
--loglevel level                   set the log4j level for this command
--workers                          turn on worker mode

SUBCOMMAND is one of:

Admin Commands:
cacheadmin           configure the HDFS cache
crypto               configure HDFS encryption zones
debug                run a Debug Admin to execute HDFS debug commands
dfsadmin             run a DFS admin client
dfsrouteradmin       manage Router-based federation
ec                   run a HDFS ErasureCoding CLI
fsck                 run a DFS filesystem checking utility
haadmin              run a DFS HA admin client
jmxget               get JMX exported values from NameNode or DataNode.
oev                  apply the offline edits viewer to an edits file
oiv                  apply the offline fsimage viewer to an fsimage
oiv_legacy           apply the offline fsimage viewer to a legacy fsimage
storagepolicies      list/get/set/satisfyStoragePolicy block storage policies

Client Commands:
classpath            prints the class path needed to get the hadoop jar and the required libraries
dfs                  run a filesystem command on the file system
envvars              display computed Hadoop environment variables
fetchdt              fetch a delegation token from the NameNode
getconf              get config values from configuration
groups               get the groups which users belong to
lsSnapshottableDir   list all snapshottable dirs owned by the current user
snapshotDiff         diff two snapshots of a directory or diff the current directory contents with a snapshot
version              print the version

Daemon Commands:
balancer             run a cluster balancing utility
datanode             run a DFS datanode
dfsrouter            run the DFS router
diskbalancer         Distributes data evenly among disks on a given node
httpfs               run HttpFS server, the HDFS HTTP Gateway
journalnode          run the DFS journalnode
mover                run a utility to move block replicas across storage types
namenode             run the DFS namenode
nfs3                 run an NFS version 3 gateway
portmap              run a portmap service
secondarynamenode    run the DFS secondary namenode
sps                  run external storagepolicysatisfier
zkfc                 run the ZK Failover Controller daemon
```

掌握这些 Hadoop 命令对于任何在大数据领域工作的人都至关重要。它们使你能够高效地管理、处理和分析 Hadoop 生态系统中的海量数据集，让你更有效地利用大数据的力量。

## Hadoop NameNode UI

Hadoop NameNode UI 是一个基于 Web 的图形界面，允许用户和管理员监控和管理 Hadoop 分布式文件系统（HDFS）及相关联的 NameNode 组件。此 UI 通过 Web 浏览器访问，默认运行在特定端口上（默认通常是 9870）。在我们的 Docker 设置中，我们可以通过以下地址访问：`http://localhost:9870/`

![[Pasted image 20260517215356.png]]
*图 3.13：Hadoop NameNode UI*

### Hadoop NameNode UI 的关键特性

- **概览（Overview）**：NameNode UI 提供 HDFS 的概览，显示文件系统的总容量、已用空间和剩余空间的详细信息。用户可以快速评估 HDFS 的健康状况。

- **DataNode 信息（DataNode Information）**：用户可以访问集群中各个 DataNode 的信息，包括其状态、块数量和存储容量。这有助于识别可能遇到问题的 DataNode。

- **文件浏览器（File Browser）**：UI 包含一个文件浏览器，允许用户导航 HDFS 目录结构、查看文件属性，并与文件和目录交互。它是探索 HDFS 内容的一个便捷工具，如下图所示。

![[Pasted image 20260517215412.png]]
*图 3.14：HDFS 文件浏览器 UI*

- **块详细信息（Block Details）**：用户可以检查存储在 HDFS 中的数据块的详细信息，包括其复制状态以及哪些 DataNode 托管副本。这对于理解数据分布和容错至关重要。

- **实用工具（Utilities）**：一些 NameNode UI 提供触发各种管理操作的实用工具，例如启动或停止安全模式（Safemode），这是文件系统的维护模式。这些工具对集群管理很有帮助。

- **安全性（Security）**：对 NameNode UI 的访问通常是安全的，需要认证和授权。这确保只有授权用户才能访问和交互 HDFS 元数据。

- **日志和诊断（Logs and Diagnostics）**：UI 可能提供对与 NameNode 操作相关的日志文件和诊断信息的访问。这对于调试和故障排除很有价值。

- **自定义（Customization）**：根据 Hadoop 发行版和集群配置，NameNode UI 可能具有管理员或开发人员提供的额外功能和自定义。

总之，Hadoop NameNode UI 是监控和管理 HDFS 的关键工具。它提供对文件系统健康状况、DataNode 状态、文件导航和诊断信息的洞察，帮助用户和管理员维护运行良好的 Hadoop 集群。

## YARN Resource Manager UI

YARN 用户界面（UI）是 Apache Hadoop Yet Another Resource Negotiator（YARN）提供的基于 Web 的图形界面。它允许用户和管理员监控、管理和深入了解 Hadoop 集群的资源管理和作业调度方面。在我们的 Docker 设置中，我们可以通过在集群运行时在浏览器中打开以下 URL 来访问：`http://localhost:8088/cluster`。访问该 URL 后，你将看到下图所示的页面：

![[Pasted image 20260517215427.png]]
*图 3.15：YARN UI*

### YARN UI 的关键特性

以下是 YARN UI 的一些主要特性：

- **集群概览（Cluster Overview）**：YARN UI 提供整个集群的概览，显示节点、容器和应用程序等各种资源的当前状态。用户可以一目了然地看到资源如何被分配和利用。

- **节点信息（Node Information）**：用户可以深入到各个集群节点，查看每个节点的详细状态、可用资源以及正在运行的容器信息。这有助于诊断节点特定问题和优化资源分配。

- **应用程序监控（Application Monitoring）**：UI 列出所有提交的 YARN 应用程序、其状态（例如运行中、已完成、失败）和资源消耗。用户可以跟踪其作业的进度并识别任何性能瓶颈。

- **日志和诊断（Logs and Diagnostics）**：YARN UI 提供对应用程序日志和诊断信息的访问，使得在运行应用程序时更容易排查问题。这在调试和分析作业失败时特别有用。

- **资源队列（Resource Queues）**：在多租户集群中，YARN UI 显示资源队列及其利用率的信息。管理员可以管理队列配置并高效分配资源。

- **作业历史（Job History）**：用户可以访问已完成应用程序和作业的历史信息，包括详细日志和资源消耗。这对性能分析和审计很有价值。

- **安全性（Security）**：YARN UI 通常与 Hadoop 的安全机制集成，确保只有授权用户才能访问集群信息并执行操作。

- **自定义（Customization）**：根据 Hadoop 发行版和集群设置，YARN UI 可能具有发行版开发者或管理员提供的额外功能和自定义。

总之，YARN UI 是管理员和使用 Hadoop 集群工作的用户的关键工具，因为它提供对集群健康状况、资源利用率和作业状态的实时洞察，帮助确保高效的资源管理和作业调度。

## MapReduce 动手实践

在本小节中，我们将编写第一个 MapReduce 作业，并探索一个经典的 MapReduce 作业，用于计算大型文本数据集中单词的出现次数。Word Count 常被用作一个简单的例子来说明 MapReduce 编程模型。我们将提供 Word Count 作业的代码及其组件的说明。

### Java：Word Count MapReduce 作业

**WordCount.java**：代码也可以在 GitHub 仓库中找到。

```java
import java.io.IOException;
import java.util.StringTokenizer;

import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.Path;
import org.apache.hadoop.io.IntWritable;
import org.apache.hadoop.io.Text;
import org.apache.hadoop.mapreduce.Job;
import org.apache.hadoop.mapreduce.Mapper;
import org.apache.hadoop.mapreduce.Reducer;
import org.apache.hadoop.mapreduce.lib.input.FileInputFormat;
import org.apache.hadoop.mapreduce.lib.output.FileOutputFormat;

public class WordCount {

    public static class TokenizerMapper
            extends Mapper<Object, Text, Text, IntWritable> {

        private final static IntWritable one = new IntWritable(1);
        private Text word = new Text();

        public void map(Object key, Text value, Context context
        ) throws IOException, InterruptedException {
            StringTokenizer itr = new StringTokenizer(value.toString());
            while (itr.hasMoreTokens()) {
                word.set(itr.nextToken());
                context.write(word, one);
            }
        }
    }

    public static class IntSumReducer
            extends Reducer<Text, IntWritable, Text, IntWritable> {
        private IntWritable result = new IntWritable();

        public void reduce(Text key, Iterable<IntWritable> values,
                           Context context
        ) throws IOException, InterruptedException {
            int sum = 0;
            for (IntWritable val : values) {
                sum += val.get();
            }
            result.set(sum);
            context.write(key, result);
        }
    }

    public static void main(String[] args) throws Exception {
        Configuration conf = new Configuration();
        Job job = Job.getInstance(conf, "word count");
        job.setJarByClass(WordCount.class);
        job.setMapperClass(TokenizerMapper.class);
        job.setCombinerClass(IntSumReducer.class);
        job.setReducerClass(IntSumReducer.class);
        job.setOutputKeyClass(Text.class);
        job.setOutputValueClass(IntWritable.class);
        FileInputFormat.addInputPath(job, new Path(args[0]));
        FileOutputFormat.setOutputPath(job, new Path(args[1]));
        System.exit(job.waitForCompletion(true) ? 0 : 1);
    }
}
```

#### 代码说明

现在，让我们分解代码并解释每个部分：

- **导入语句**：这些行从 Hadoop 库中导入构建 MapReduce 作业所需的类。

- **TokenizerMapper 类**：这是 Mapper 类。它扩展了 `Mapper`，后者是用于将输入数据映射为键值对的 Hadoop 类。在这个类中：
  - 我们定义 `one` 作为值为 1 的 `IntWritable`。这将用于计算每个单词的出现次数。
  - `map` 方法接收输入键值对，将输入文本分词为单词，并发出键值对，其中单词是键，`one` 是值。例如，如果输入文本是 `"Hello World Hello"`，它将发出 `(Hello, 1)`、`(World, 1)` 和 `(Hello, 1)`。

- **IntSumReducer 类**：这是 Reducer 类。它扩展了 `Reducer`，后者是用于归约（聚合）每个键的值的 Hadoop 类。在这个类中：
  - `reduce` 方法接收 Mapper 发出的键值对，并对每个键的值求和。然后发出最终结果，如 `(Hello, 2)`。

- **main 方法**：这是程序的入口点。
  - 我们配置 Hadoop 作业，设置其名称，并指定 Mapper 和 Reducer 类。
  - 我们指定输出键值对的数据类型。
  - 我们设置作业的输入和输出路径。
  - 最后，我们等待作业完成并退出程序。

![[Pasted image 20260517215443.png]]
*图 3.16：MapReduce Word Count 整体流程*

此 Word Count MapReduce 作业计算给定输入文本中单词的出现次数，并生成单词及其各自计数的列表作为输出。

在下一节中，我们将讨论如何在 Hadoop 集群上运行此 MapReduce 作业并分析结果。

### 编译和运行 Word Count MapReduce 作业

在本节中，我们将引导你完成使用 Hadoop 编译和运行 Word Count MapReduce 作业的过程。

#### 编译代码

在运行 Word Count 作业之前，你需要将 Java 代码编译成 Java Archive（JAR）文件。按以下步骤操作：

1. 在本地机器上打开终端窗口。由于我们在 Docker 容器本身中有 Java，我们可以在 Docker 容器内使用 Nano 创建 WordCount.java 文件。

2. 导航到保存 Word Count Java 代码的目录（例如 `/WordCount/`）。

3. 使用 `javac` 命令将代码编译成 JAR 文件。如果需要，将 `WordCount.java` 替换为你的 Java 文件的实际名称。

```bash
root@localhost:/# javac -classpath \
  $HADOOP_HOME/share/hadoop/common/hadoop-common-3.3.6.jar:\
  $HADOOP_HOME/share/hadoop/mapreduce/hadoop-mapreduce-client-core-3.3.6.jar:\
  $HADOOP_HOME/share/hadoop/common/lib/commons-cli-1.2.jar \
  -d WordCount/ WordCount.java
```

此命令编译代码，编译后的类放在名为 `WordCount` 的目录中。

4. 从编译后的类创建 JAR 文件。将 `WordCount.jar` 替换为你想要的 JAR 文件名：

```bash
root@localhost:/# jar -cvf WordCount.jar -C WordCount/ .
```

现在，你有一个名为 `WordCount.jar` 的 JAR 文件，其中包含编译后的 Word Count MapReduce 作业。

#### 运行 Word Count MapReduce 作业

有了 JAR 文件，你可以在 Hadoop 集群上运行 Word Count 作业。按以下步骤操作：

1. 确保你的 Hadoop 集群已启动并运行。

2. 将输入数据上传到 Hadoop 分布式文件系统（HDFS）。你可以使用以下命令将文本文件复制到 HDFS。将文件路径替换为你的实际路径。

```bash
root@localhost:/# $HADOOP_HOME/bin/hdfs dfs -copyFromLocal \
  /path/to/local/input.txt /user/yourusername/input/
```

为了配合上图，让 Input.txt 包含以下文本：

```
Deer Bear River
Car Car River
Deer Car Bear
```

3. 使用 `hadoop jar` 命令运行 Word Count 作业。将 `/path/to/input` 和 `/path/to/output` 替换为你的 HDFS 输入和输出路径。你还需要指定 JAR 文件和主类 `WordCount`：

```bash
root@localhost:/# $HADOOP_HOME/bin/hadoop jar WordCount.jar \
  WordCount /user/yourusername/input/ /user/yourusername/output/
```

4. 在 Hadoop 集群中监控你的作业进度。你可以使用各种 Hadoop 命令检查作业状态和日志，如 `yarn application -list` 或 `yarn logs -applicationId <application_id>`。

5. 作业完成后，你可以在 HDFS 中查看 Word Count 结果：

```bash
root@localhost:/# $HADOOP_HOME/bin/hdfs dfs -cat /user/yourusername/output/
```

输出：

```
Bear    2
Car     3
Deer    2
River   2
```

现在，你已经成功使用 Hadoop 编译并运行了 Word Count MapReduce 作业。你可以检查输出以查看 Word Count 结果。

这个例子说明了在 Hadoop 中运行基本 MapReduce 作业的过程。在实践中，你可以将此方法适配为解决更复杂的数据处理任务。

### Python：使用 Hadoop Streaming API 的 Word Count MR 作业

在本小节中，我们将探讨如何使用 Hadoop Streaming 和 Python 实现一个简单的 Word Count 作业。Word Count 是 MapReduce 应用程序的经典示例之一，Hadoop Streaming 允许我们使用 Python 脚本实现这一点。

**Mapper 脚本（mapper.py）**：

```python
import sys

# 输入：文本行
# 输出：输入中每个单词的键值对 (word, 1)

for line in sys.stdin:
    line = line.strip()
    words = line.split()
    for word in words:
        print(f"{word}\t1")
```

**Mapper 说明**：
- 从 `sys.stdin` 读取输入行。
- 去除每行的前导和尾部空格。
- 将每行拆分为单词。
- 发出键值对，其中键是单词，值是 `1`。

**Reducer 脚本（reducer.py）**：

```python
import sys

# 输入：键值对 (word, 1)
# 输出：键值对 (word, total_count)

current_word = None
current_count = 0

for line in sys.stdin:
    line = line.strip()
    word, count = line.split("\t", 1)

    try:
        count = int(count)
    except ValueError:
        continue

    if current_word == word:
        current_count += count
    else:
        if current_word:
            print(f"{current_word}\t{current_count}")
        current_word = word
        current_count = count

if current_word:
    print(f"{current_word}\t{current_count}")
```

**Reducer 说明**：
- 从 `sys.stdin` 读取键值对。
- 初始化变量以跟踪当前单词及其计数。
- 遍历输入，聚合每个单词的计数。
- 输出带有单词及其总计数和的键值对。

**使用 Hadoop Streaming 运行 Word Count 作业**：

要使用 Hadoop Streaming 运行此 Word Count 作业，你可以使用以下 Hadoop 命令：

```bash
$HADOOP_HOME/bin/hadoop jar \
  $HADOOP_HOME/share/hadoop/tools/lib/hadoop-streaming-3.*.jar \
  -files mapper.py,reducer.py \
  -mapper mapper.py \
  -reducer reducer.py \
  -input input_data.txt \
  -output wordcount_output
```

此命令将在你的 Hadoop 集群上执行 Word Count 作业，利用 Python 映射器和归约器脚本。

### Perl：使用 Hadoop Streaming API 的 Word Count MR 作业

要在 Perl 中使用 Hadoop Streaming API 创建 Word Count MapReduce 作业，你需要两个脚本：一个映射器和一个归约器。以下是一个示例：

**Mapper（mapper.pl）**：

```perl
#!/usr/bin/perl

while (<>) {
    chomp;
    my @words = split;
    foreach my $word (@words) {
        print "$word\t1\n";  # 发出单词和计数 1
    }
}
```

**Reducer（reducer.pl）**：

```perl
#!/usr/bin/perl

my $current_word = "";
my $current_count = 0;

while (<>) {
    chomp;
    my ($word, $count) = split("\t");

    if ($word eq $current_word) {
        $current_count += $count;
    } else {
        if ($current_word ne "") {
            print "$current_word\t$current_count\n";
        }
        $current_word = $word;
        $current_count = $count;
    }
}

# 打印最后一个单词
if ($current_word ne "") {
    print "$current_word\t$current_count\n";
}
```

现在，假设你在一个 HDFS 目录中有输入数据，并希望将输出存储在输出目录中。

你可以使用以下命令通过 Hadoop Streaming 运行 Word Count 作业：

```bash
$HADOOP_HOME/bin/hadoop jar \
  $HADOOP_HOME/share/hadoop/tools/lib/hadoop-streaming-3.*.jar \
  -file mapper.pl -mapper mapper.pl \
  -file reducer.pl -reducer reducer.pl \
  -input input/* -output output/
```

在此命令中：
- `hadoop jar` 指定 Hadoop Streaming JAR。
- `-file` 指定要发送到集群的文件（映射器和归约器 Perl 脚本）。
- `-mapper` 和 `-reducer` 指定要使用的映射器和归约器脚本。
- `-input` 和 `-output` 指定输入和输出目录。

此 MapReduce 作业将计算输入文本数据中每个单词的出现次数，并将结果存储在输出目录中。

在运行作业之前，记得使用 `chmod +x mapper.pl reducer.pl` 使你的 Perl 脚本可执行。

## 结论

总之，本章全面介绍了 Apache Hadoop 和 YARN、MapReduce 以及 Apache Tez，涵盖了理论和实践两个方面。它从前置条件开始，包括 Docker 的简介及其在 Windows 上的安装。然后，本章深入探讨了 HDFS、YARN、MapReduce 和 Tez 的理论，讨论了它们的关键特性、组件、优势以及在 Hadoop 技术栈中的位置。

![[Pasted image 20260517215502.png]]
*图 3.17：不同组件在 Hadoop 技术栈中的位置*

实践部分引导读者完成了使用 Docker 以伪分布式模式搭建 Hadoop 集群的过程，包括配置文件、创建用户和暴露所需端口。成功搭建集群后，读者探索了各种 Hadoop 和 YARN 命令，包括 HDFS、MapReduce 作业提交、配置和集群管理命令。本章以 Java、Python 和 Perl 的 MapReduce 作业动手示例作为结束。

本章作为希望理解和使用 Hadoop 生态系统的读者的基础指南，提供了对大数据分析和处理至关重要理论知识和实践技能。

在下一章中，我们将学习更多关于分布式计算引擎的内容，即 Apache Hive 和 Apache Spark，并包含动手实践部分。

## 要点回顾

- **Hadoop 生态系统简介**：本章向你介绍了 Hadoop 生态系统，包括 HDFS、YARN、MapReduce 和 Tez。

- **Docker 前置条件**：你学习了搭建 Hadoop 的前置条件，包括 Docker 的简介，Docker 用于集群部署。

- **Hadoop 分布式文件系统（HDFS）**：理解 HDFS 的关键特性和架构，其组件（如 NameNode 和 DataNode）以及它在 Hadoop 中的角色。

- **Yet Another Resource Negotiator（YARN）**：探索 YARN 的架构和组件，它是 Hadoop 中的资源管理层，及其优势。

- **MapReduce 范式**：学习 MapReduce 范式的基础知识，其核心组件，以及处理大数据集的好处。

- **Hadoop Streaming API**：了解 Hadoop Streaming 如何通过允许你使用自定义脚本（如 Python 或 Perl）作为映射器和归约器来简化 MapReduce。

- **Apache Tez**：理解 Apache Tez 的架构和优势，它提供了相对于 MapReduce 的性能提升、动态运行时并发控制和最佳资源管理。

- **动手实践部分**：本章包括使用 Docker 搭建 Hadoop 集群、探索 Hadoop 和 YARN 命令，以及用 Java、Python 和 Perl 运行 MapReduce 作业的实践部分。

- **用户界面**：熟悉 Hadoop NameNode UI 和 YARN Resource Manager UI，它们提供对集群健康状况和资源使用的洞察。

- **大数据分析**：记住，Hadoop 及其生态系统是大数据分析的基本工具，提供可扩展性、容错性和高效的数据处理能力。

- **在 Hadoop 技术栈中的位置**：理解这些组件在 Hadoop 技术栈中的位置，它们协同工作以管理和处理大量数据。

- **优势**：认识每个组件的优势，如容错性、可扩展性和改进的性能，使其成为大数据应用的宝贵工具。

通过记住这些关键点，你将为使用 Hadoop 生态系统并利用其能力进行大数据分析打下坚实的基础。

## 练习

1. Hadoop 分布式文件系统（HDFS）的关键组件是什么？

2. YARN 与 Hadoop 中的 MapReduce 有何不同？

3. Hadoop NameNode UI 和 YARN Resource Manager UI 的角色是什么？

4. Hadoop Streaming API 如何简化 MapReduce 任务？

5. Apache Tez 在 Hadoop 生态系统中的一些好处是什么？

6. 在本章的实践部分中，使用 Docker 搭建 Hadoop 集群的意义是什么？

7. MapReduce 如何在 Hadoop 中处理容错？

8. YARN 在 Hadoop 中的主要角色是什么？

9. 使用 Hadoop Streaming API，你可以用哪些语言编写映射器和归约器？

10. Tez 如何实现最佳资源管理？

11. 编写 Java MapReduce 代码来计算全国的平均温度。假设你有包含全国不同城市温度读数的输入数据。我们将计算每个城市的平均温度，然后计算整个国家的总体平均温度。

## 答案

**A1**：HDFS 的关键组件包括 NameNode、DataNode、Hadoop 文件系统命名空间、数据复制和基于块的存储。

**A2**：Yet Another Resource Negotiator（YARN）是 Hadoop 中的资源管理层，将资源管理与作业调度和监控分离。另一方面，MapReduce 是编程模型和处理框架。YARN 提供动态资源分配，而 MapReduce 专注于数据处理。

**A3**：Hadoop NameNode UI 提供对 HDFS 和集群健康状况的洞察。YARN Resource Manager UI 提供有关资源使用和集群应用程序的信息，帮助管理员有效管理资源。

**A4**：Hadoop Streaming API 允许你使用自定义脚本，如 Python 或 Perl，作为映射器和归约器。这种灵活性简化了熟悉这些脚本语言的开发者的 MapReduce 作业开发。

**A5**：Apache Tez 提供相对于传统 MapReduce 的性能提升、动态运行时并发控制和最佳资源管理。它改进了作业执行时间和集群资源利用率。

**A6**：使用 Docker 搭建 Hadoop 集群允许你创建一个受控的环境进行学习和实验。它简化了部署过程，并确保你可以轻松复制集群设置。

**A7**：MapReduce 通过在集群内的可用节点上重新运行失败的任务来确保容错。这种机制防止因节点问题导致作业失败。

**A8**：YARN 负责集群资源管理。它分配资源、监控资源使用情况，并确保多个应用程序之间高效的资源利用率。

**A9**：使用 Hadoop Streaming API，你可以用各种语言编写映射器和归约器，包括 Java、Python、Perl 等，增强了 MapReduce 作业开发的灵活性。

**A10**：Tez 通过重用 YARN 容器来启动新任务，并在任务之间共享对象来实现最佳资源管理。这最小化了资源浪费并提高了作业执行效率。