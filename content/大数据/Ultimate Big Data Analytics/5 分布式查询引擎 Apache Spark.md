---
title: "5 分布式查询引擎 Apache Spark"
date: 2026-05-17
tags:
  - Spark
  - 大数据
  - Hadoop
  - RDD
  - DataFrame
  - YARN
---

# 第 5 章 分布式查询引擎：Apache Spark



## 引言

本章将带您踏上探索 Apache Spark 动态版图的旅程。Apache Spark 是一个强大且多功能的开源数据处理引擎。在深入了解 Apache Spark 的基本原理和能力的过程中，您将洞察其架构、关键组件以及它如何彻底改变大数据处理。虽然 Spark 值得深入探索，但本书将提供一份面向初学者和中级学习者的高层次概述，作为通往令人兴奋的 Apache Spark 世界的大门。

![[Pasted image 20260517220303.png]]
**图 5.1: Apache Spark**

### 本章结构

在本章中，我们将涵盖以下主题：

**第一部分：理论**

- Apache Spark
- Apache Spark 简介
- 类比：Hadoop 交响乐团
- 类比：大公司中的管理者
- Apache Spark 的关键特性
- 术语表
- Apache Spark 架构：全面概述
- 分布式数据处理的抽象层：弹性分布式数据集（RDD）和 DataFrame
- 共享变量
- Apache Spark 的统一编程模型与抽象层
- Apache Spark 中的作业执行：一个精心编排的过程
- Spark 的可扩展性与速度
- Spark on YARN：集群模式与客户端模式
- Spark 在 Hadoop 技术栈中的定位

**第二部分：动手实践**

- 安装
- 运行我们的第一个 Spark 程序
- Spark：用户体验与支持的 API
- Spark 自包含应用程序
- Spark 交互式 Shell
- Spark UI：监控与性能优化
- DataFrame API
- RDD
- 性能调优
- 使用 Apache Spark 对天气数据进行探索性数据分析

---

## 第一部分：理论

### Apache Spark

Apache Spark 是一个开源的分布式计算系统，为大数据处理和分析提供快速且通用的集群计算框架。它最初是为了解决 MapReduce 编程模型的局限性而开发的，MapReduce 通常与 Apache Hadoop 框架相关联。Spark 被设计得比其前身更快、更灵活、更用户友好。

Apache Spark™ 是一个多语言引擎，用于在单节点机器或集群上执行数据工程、数据科学和机器学习任务。它提供 Java、Scala、Python 和 R 的高级 API，以及一个支持通用执行图的优化引擎。它还支持丰富的高级工具集，包括用于 SQL 和结构化数据处理的 Spark SQL、用于 pandas 工作负载的 pandas API on Spark、用于机器学习的 MLlib、用于图处理的 GraphX，以及用于增量计算和流处理的 Structured Streaming。我们将在后续章节中介绍 MLlib 和 Spark Streaming。

在本章中，我们将深入 Apache Spark 的世界，探索其基本概念和架构，以及它如何简化处理大数据的流程。无论您是数据分析师还是大数据爱好者，理解 Spark 都是利用 Hadoop 进行数据处理和分析需求的关键一步。我们将涵盖从 Spark 的基本组件到更高级主题的所有内容，使您能够有效地利用 Spark 的能力进行数据驱动的工作。

### Apache Spark 简介

在 Hadoop 生态系统中，Apache Spark 可以被视为一种多功能工具，与 Hadoop 分布式文件系统（HDFS）和 MapReduce 等其他组件并肩而立。让我们用一个类比来解释 Spark 在 Hadoop 技术栈中的位置。

### 类比：Hadoop 交响乐团

想象您是一位指挥家，正在领导一支交响乐团，您的目标是创造一部和谐的乐章（处理和分析大规模数据集）。以下是 Hadoop 生态系统中的各个组件在这个音乐类比中扮演的不同角色：

**HDFS（Hadoop 分布式文件系统）：**

将 HDFS 想象为乐谱（数据）的存储系统。每位乐手（数据节点）持有一部分乐谱，他们共同存储了整个作品。

指挥家（Hadoop 生态系统）可以轻松地将乐谱副本分发给不同的乐手以实现冗余。

**MapReduce：**

将 MapReduce 想象为一组特定的乐器（Mapper 和 Reducer），可以演奏乐谱的某些部分。

指挥家（Hadoop）将乐曲的不同部分分配给各个乐器组（Mapper），每个组独立处理其分配的部分。然后将结果合并（Reduce）形成最终的乐章。

**Apache Spark：**

现在，将 Spark 引入为一位多才多艺的音乐家，可以演奏多种乐器，并且特别擅长与他人协作。Spark 为乐团带来了额外的乐器，如鼓、弦乐和铜管。

指挥家（Hadoop 生态系统）意识到，某些音乐部分可以由 Spark 这位多乐器演奏家更高效地演奏。当一段复杂的乐曲（数据处理任务）到来时，Spark 被召唤来表演，将其多样化的技能带入乐团。

本质上，虽然 MapReduce 就像一套针对特定任务的专用乐器，但 Apache Spark 是一位多才多艺的音乐家，可以更高效、更灵活地处理各种任务。它是 Hadoop 交响乐团的增强，允许更快、更多功能的数据处理。因此，在 Hadoop 技术栈中，Spark 补充了 MapReduce 和其他组件，为大数据处理提供了更具表现力和高性能的框架。

### 类比：大公司中的管理者

让我们通过另一个类比来理解 Apache Spark 是什么。

想象您是一家大公司的管理者，桌上有一大堆文件代表需要完成的大量工作。您的目标是高效地处理和组织这些工作。以下是这个场景与 Apache Spark 的关系：

**传统方法（MapReduce）：**

- 将工作想象为一系列需要完成的任务。
- 在传统的 MapReduce 模型中，您为每项任务分配一个特定的员工，他们一个接一个地完成。
- 这类似于按顺序处理文件——一个接一个。这很有效，但如果您有一大堆文件，单个人完成整个工作量可能需要很长时间。

**Apache Spark 方法：**

- 现在，想象您有一支高效的助理团队（Spark Worker），他们具有出色的沟通能力（内存计算）。
- 您不是一次分发一项任务，而是给每位助理提供一部分文件（一个分区），他们独立工作。
- 每位助理（Spark Worker）可以与他人交流，分享进度信息，甚至可以互相帮助完成任务。这种协作加快了整体完成时间。
- 此外，如果有新任务（作业）进来，您可以快速将工作分配给助理们，使他们同时处理多项任务，无需等待一项完成再开始下一项。

总而言之，Apache Spark 就像拥有一支协调良好的助理团队，可以同时处理和管理大量工作。将数据保存在内存中并执行内存计算的能力实现了更快的计算，而 Spark 的分布式特性允许并行处理，使其比传统方法更高效地进行大数据处理。

### Apache Spark 的关键特性

Apache Spark 是一个强大的开源分布式计算系统，为大数据处理提供快速且通用的集群计算框架。以下是 Apache Spark 的一些关键特性：

**速度（Speed）：**
Spark 为速度而设计，可以执行内存计算，从而实现快速的迭代算法和交互式查询。

**易用性（Ease of Use）：**
Spark 提供 Java、Scala、Python 和 R 的高级 API，使具有不同语言偏好的广大开发者都能使用。

**多功能性（Versatility）：**
Spark 支持各种数据处理工作负载，包括批处理、迭代算法、交互式查询和实时流处理。

**内存计算（In-memory Processing）：**
Spark 将中间数据存储在内存中，使迭代算法比 Hadoop MapReduce 等传统基于磁盘的系统显著更快。

**容错性（Fault Tolerance）：**
Spark 通过弹性分布式数据集（RDD）提供容错能力，可以通过重新计算来恢复因节点故障而丢失的数据分区。

**易部署性（Ease of Deployment）：**
Spark 可以轻松部署在各种集群管理器上，包括 Apache Mesos、Hadoop YARN 及其自带的 Standalone 集群管理器。

**丰富的库集（Rich Set of Libraries）：**
Spark 附带丰富的库集，用于各种任务，如用于结构化数据处理的 Spark SQL、用于机器学习的 MLlib、用于图处理的 GraphX，以及用于实时数据处理的 Spark Streaming。

**与 Hadoop 的兼容性（Compatibility with Hadoop）：**
Spark 可以从 Hadoop 分布式文件系统（HDFS）和其他 Hadoop 数据源读取数据，确保与 Hadoop 生态系统的兼容性。

**统一数据处理引擎（Unified Data Processing Engine）：**
Spark 作为多样化工作负载的统一引擎，无需为批处理、交互式查询、机器学习和流处理使用不同的工具。

**Catalyst 优化器（Catalyst Optimizer）：**
Spark 集成了 Catalyst 优化器，这是一个强大的查询优化引擎，可优化 Spark SQL 查询的执行计划。

**Tungsten 执行引擎（Tungsten Execution Engine）：**
Tungsten 是 Spark 的执行引擎，通过增强的代码生成和内存管理来提高内存计算的效率。

**社区和生态系统（Community and Ecosystem）：**
Spark 拥有一个充满活力的活跃开源社区。其生态系统包括广泛的第三方包、连接器和集成，为其可扩展性做出了贡献。

**自适应查询执行（Adaptive Query Execution）：**
Spark 3.0 引入了自适应查询执行，这一功能根据运行时统计信息动态调整执行计划，提高查询效率。

**结构化流处理（Structured Streaming）：**
Spark 通过 Structured Streaming 提供高级的声明式实时流处理 API，允许开发者使用相同的 DataFrame/Dataset API 来表达流数据的计算。

这些特性共同使 Apache Spark 成为大数据处理的热门且多功能的选择，为各种数据处理任务提供灵活且高效的平台。

### 术语表

下表总结了讨论 Spark 时常见的术语：

| 术语 | 描述 |
|------|------|
| **RDD (Resilient Distributed Dataset)** | Spark 的基本数据抽象，表示可并行处理的不可变、分区化的元素集合 |
| **DataFrame** | 组织成命名列的数据集，概念上等同于关系数据库中的表或 R/Python 中的数据框 |
| **Dataset** | Spark SQL 的扩展，提供类型安全的面向对象编程接口，结合了 RDD 和 DataFrame 的优点 |
| **SparkContext** | Spark 功能的入口点，表示与 Spark 集群的连接 |
| **SparkSession** | Spark 2.0 引入的统一入口点，整合了 SparkContext、SQLContext 和 HiveContext |
| **Driver Program** | 运行 main() 函数并创建 SparkContext 的程序，负责将应用程序分解为任务并调度执行 |
| **Cluster Manager** | 负责跨集群分配和协调资源的管理器（Standalone、YARN、Mesos、Kubernetes） |
| **Executor** | 在 Worker 节点上运行的计算单元，执行任务并管理分配的数据分区 |
| **Task** | Spark 中的基本工作单元，代表对数据分区的转换或操作 |
| **Job** | 由 Spark 操作（action）触发的完整计算流程，包含多个 Stage |
| **Stage** | Job 中可并行执行的任务集合，由 DAG Scheduler 按依赖关系组织 |
| **Shuffle** | 跨分区重新分布数据的过程，涉及网络数据传输 |
| **Transformation** | 从现有数据集创建新数据集的惰性操作（如 map、filter） |
| **Action** | 触发计算并返回结果给 Driver 或写入外部存储的操作（如 count、collect） |
| **Catalyst Optimizer** | Spark 的查询优化引擎，优化 Spark SQL 和 DataFrame 查询的逻辑和物理执行计划 |
| **Tungsten** | Spark 的物理执行引擎，通过代码生成和高效内存管理提升性能 |
| **DAG Scheduler** | 将有向无环图（DAG）的 Stage 转换为可并行执行的 Task 集合 |
| **Broadcast Variable** | 在所有 Worker 节点上高效分发只读数据的共享变量 |
| **Accumulator** | 可由多个 Task 高效更新的变量，用于聚合操作（如计数器和求和） |
| **Lazy Evaluation** | 延迟计算策略：转换操作不立即执行，而是在 Action 触发时一起计算 |
| **Lineage** | RDD 的转换操作历史记录，用于在节点故障时重建丢失的分区 |

**表 5.1: 术语表**

### Apache Spark 架构：全面概述

现在我们已经熟悉了 Spark 的术语，对 Spark 的功能有了基本了解，并通过类比了解了它在 Hadoop 技术栈中的位置，接下来我们可以更深入地学习 Spark 架构。

![[Pasted image 20260517220344.png]]

**图 5.2: Spark 架构**

#### Apache Spark 架构：高层次概述

Apache Spark 的架构经过精心设计，旨在通过分布式计算实现大规模数据集的快速和灵活处理。它包含多个层次化的组成部分，每个部分在框架的整体效能中都起着关键作用。图 5.2 包含了架构中的关键组件和层次。

#### Driver Program：集中控制

Driver Program 是 Spark 应用程序的主控制实体。它运行用户的 main 函数并创建 SparkContext，SparkContext 是任何 Spark 功能的入口点。Driver Program 负责将应用程序分解为任务，调度其执行，并管理整体控制流程。

#### Cluster Manager：资源管理

Cluster Manager 负责监督集群中资源的分配和协调。它与 Worker 节点通信以分配 Executor，确保每个 Executor 都能访问必要的资源（如 CPU 和内存）。常见的集群管理器包括：

- **Standalone**：这是 Spark 自带的简单集群管理器，专为轻松设置集群而设计。
- **Apache Mesos**：最初是一个支持 Spark、Hadoop MapReduce 和服务应用的多功能集群管理器。注意，Apache Mesos 现已弃用。
- **Hadoop YARN**：作为 Hadoop 3 中的资源管理器，YARN 是 Hadoop 生态系统的组成部分。
- **Kubernetes**：一个专用于自动化容器化应用程序部署、扩展和管理的开源系统，为 Spark 集群提供了健壮的环境。

#### Executor 节点：分布式处理单元

Executor 节点是在集群内 Worker 机器上运行的独立计算单元。Driver Program 通过 Cluster Manager 动态分配 Executor。每个 Executor 负责执行任务并管理分配给它的数据分区。Executor 独立运行，使任务能够跨集群并行处理。

#### Task 执行：并行处理

Task 是 Spark 中的基本工作单元，代表对数据的转换（Transformation）或操作（Action）。Driver Program 将 Spark 应用程序逻辑划分为一系列 Task，并将这些 Task 分发给 Executor 节点同时执行。并行处理能力使 Spark 能够高效处理大规模数据集。

#### 弹性分布式数据集（RDD）：核心数据抽象

RDD 是 Spark 中的基本抽象，代表分布式的数据集合。它们是**不可变的**（内容不可更改）和**容错的**（能够从节点故障中恢复）。RDD 支持并行处理，可以缓存在内存中以加快访问速度，使其成为分布式计算的灵活且高效的数据结构。

#### 有向无环图（DAG）调度器：任务规划

DAG 调度器将 Driver Program 定义的高层执行计划转换为有向无环图（DAG）的 Stage。每个 Stage 由一组可以并行执行的 Task 组成。调度器通过识别任务之间的依赖关系并组织它们以高效执行来优化执行计划。

#### Catalyst 优化器与 Tungsten 执行引擎：性能增强

Catalyst 优化器是一个查询优化器，它增强了 Spark SQL 和 DataFrame 操作生成的逻辑执行计划。它应用各种优化，如**谓词下推（Predicate Pushdown）** 和**常量折叠（Constant Folding）**，以提高查询效率。Tungsten 执行引擎将优化后的逻辑计划转换为物理计划，并使用高效的字节码生成和内存管理技术执行它，最大限度地减少 CPU 和内存开销。

### 分布式数据处理的抽象层：弹性分布式数据集（RDD）和 DataFrame

在本节中，让我们更深入地了解 Spark 中的 RDD、DataFrame 和共享变量。

#### 弹性分布式数据集（RDD）

Apache Spark 数据处理能力的核心是弹性分布式数据集（RDD）的概念。RDD 代表不可变的、容错的、可并行处理的分布式对象集合。这种抽象作为 Spark 应用程序的基础构建块，实现了高效和可扩展的数据操作。RDD 的特性和功能可以进一步阐述如下：

**不可变性（Immutability）：** RDD 是不可变的，这意味着它们的内容在创建后不能被更改。这种不可变性确保了数据一致性并简化了故障恢复，因为原始数据状态在整个处理过程中保持不变。

**容错性（Fault Tolerance）：** RDD 通过**血缘关系（Lineage）** 信息展示容错性，这允许重新创建丢失的数据分区。在节点故障的情况下，Spark 可以通过引用导致其创建的转换血缘关系来重建丢失的 RDD 分区。

**分布式特性（Distributed Nature）：** RDD 分布在 Spark 集群的各个节点上，促进了数据的并行处理。这种分布允许 Spark 同时利用多个节点的计算能力，从而加快任务执行速度。

**惰性计算（Lazy Evaluation）：** RDD 采用惰性计算策略，这意味着对 RDD 的转换（Transformation）在调用时不会立即执行。相反，Spark 将转换记录在逻辑执行计划中。操作（Action）触发实际计算，仅在需要结果时才执行，从而优化资源利用。

**弹性存储（Resilient Storage）：** RDD 可以持久存储在内存中以加快访问速度，这一特性对迭代算法和交互式数据分析至关重要。通过在内存中持久化 RDD，Spark 最大限度地减少了每次转换后重新计算数据的需求。

**并行处理（Parallel Processing）：** RDD 通过将数据集划分为分区来实现并行处理，每个分区由集群中不同的节点独立处理。这种并行性显著加速了对大规模数据集的计算执行。

**转换和操作运算（Transformation and Action Operations）：** RDD 支持两种类型的运算：转换和操作。转换从现有 RDD 创建新 RDD，定义一系列数据操作步骤。而操作触发实际计算，生成结果或副作用。

**跨编程语言的灵活性（Flexibility Across Programming Languages）：** RDD 提供语言互操作性，允许使用多种编程语言（如 Scala、Java、Python 和 R）开发 Spark 应用程序。这种灵活性增强了 Apache Spark 在不同开发者社区中的可访问性和采用率。

总之，RDD 在 Apache Spark 架构中扮演着关键角色，提供了一种弹性和分布式的数据抽象，支撑着大规模数据集的高效、容错处理。RDD 固有的特性有助于提升 Spark 应用程序的整体性能、可扩展性和多功能性。

#### Apache Spark 中的 DataFrame：结构化数据处理

Apache Spark 的 DataFrame 为分布式数据处理引入了更高层次的抽象，提供了结构化且高效的方式来处理大规模数据集。Spark 中的 DataFrame 在概念上类似于关系数据库中的表或 R 和 Python Pandas 库中的数据框。以下是与 DataFrame 相关的关键方面和功能概述：

**结构化表示（Structured Representation）：** DataFrame 将数据组织为命名列，类似于关系数据库中的表。这种结构化表示允许使用声明式 API 轻松操作和查询数据。

**不可变和惰性计算（Immutable and Lazy Evaluation）：** 与 RDD 一样，DataFrame 是不可变的，这意味着它们的内容在创建后不能更改。此外，DataFrame 利用惰性计算，延迟操作的执行直到明确需要结果为止。这种优化最大限度地减少了不必要的计算。

**跨编程语言的灵活性**：DataFrame 提供与各种编程语言（包括 Scala、Java、Python 和 R）的无缝互操作性。这种灵活性使 Spark 能够被更广泛的开发者和数据科学家社区使用。

**优化的 Catalyst 查询规划器（Optimized Catalyst Query Planner）：** DataFrame 受益于 Spark 的 Catalyst 查询规划器，它优化了查询的逻辑和物理执行计划。Catalyst 优化器通过重新排列和优化转换和操作来提高性能。

**数据源和数据接收器（Data Sources and Sinks）：** Spark DataFrame 支持广泛的数据源和数据接收器，包括 Hive、Avro、Parquet、ORC、JSON、JDBC 等。这种多功能性使得与不同数据格式和存储系统的轻松集成成为可能。

**Spark SQL：** DataFrame 与 Spark SQL 无缝集成，允许用户对结构化数据执行 SQL 查询。这种集成增强了 Spark 对熟悉基于 SQL 的数据操作的人员的表现力和亲和力。

**用户定义函数（UDF）：** DataFrame 支持创建和应用用户定义函数（UDF），允许开发者通过对 DataFrame 中的数据应用自定义操作来扩展 Spark 的功能。

**Tungsten 执行引擎：** Spark 使用的 Tungsten 执行引擎增强了 DataFrame 操作的性能。它利用代码生成和内存管理技术来实现数据处理的大幅加速。

**Dataset：类型安全的扩展：** Dataset 是 DataFrame 的类型安全扩展，允许用户使用强类型数据结构。虽然 DataFrame 提供了方便的编程接口，但 Dataset 提供了额外的类型安全和编译时检查。

**机器学习集成：** Spark 的 MLlib 机器学习库与 DataFrame 无缝集成，使得机器学习算法能够应用于结构化数据。这种集成简化了端到端机器学习流水线的开发。（我们将在机器学习相关章节中详细介绍）。

总之，Spark DataFrame 为结构化数据处理提供了强大且高效的抽象，提供了用户友好的 API、通过 Catalyst 的优化以及与各种编程语言和数据格式的互操作性。它们的作用超越了数据操作，涵盖与 Spark SQL、机器学习和多样化数据源的集成，使其成为 Spark 生态系统的基本组件。

下表总结了 Apache Spark 中 RDD 和 DataFrame 之间的主要区别：

| 特性 | RDD | DataFrame |
|------|-----|-----------|
| **抽象级别** | 低级，提供对数据的细粒度控制 | 高级，提供结构化数据表示 |
| **数据表示** | 无 schema 的元素分布式集合 | 具有命名列和 schema 的组织化数据 |
| **优化** | 无内置优化，手动优化 | 通过 Catalyst 优化器的自动优化 |
| **性能** | 对于结构化数据的性能较低，需要序列化/反序列化 | 通过 Tungsten 引擎提供更好的性能，使用堆外内存 |
| **编程语言支持** | Scala、Java、Python、R | Scala、Java、Python、R |
| **类型安全** | 编译时类型安全（在 Scala 中） | 无编译时类型安全，在运行时检测错误 |
| **序列化** | 使用 Java/Kryo 序列化 | 使用 Tungsten 的二进制格式，更快速的序列化 |
| **数据源集成** | 通过编程接口 | 内置支持多种数据源（JSON、Parquet、JDBC 等）|
| **Schema 推断** | 无自动 Schema 推断 | 自动 Schema 推断 |
| **易用性** | 更复杂的编程模型 | 更简单、更直观的 API |
| **用例** | 非结构化数据、低级转换 | 结构化数据、SQL 查询、ETL 管道 |

**表 5.2: RDD 与 DataFrame 的主要区别总结**

### 共享变量

在 Apache Spark 中，共享变量（Shared Variables）是实现高效灵活分布式计算的关键机制，特别是在使用弹性分布式数据集（RDD）时。共享变量允许 Spark 优化集群中不同节点上运行的任务之间的数据共享和通信。Spark 中的两种主要类型的共享变量是广播变量（Broadcast Variables）和累加器（Accumulators）。

#### 广播变量：高效的数据分发

广播变量能够将只读数据高效分发到 Spark 集群中的所有 Worker 节点。这在执行任务期间需要跨所有节点共享大型数据集或查找表时特别有用。Spark 不会将数据分别发送到每个节点，而是一次性广播该变量，并允许每个节点在本地引用它。这显著减少了数据传输开销并提升了任务性能。

示例用法：

```python
# 将变量 'lookupTable' 广播到所有 Worker 节点
lookupTable = {...}
broadcastVar = sc.broadcast(lookupTable)

# 在任务中访问广播变量
def process_data(item):
    local_table = broadcastVar.value
    # ... 使用 local_table 执行计算
```

#### 累加器：聚合结果

累加器是可以由 Spark 计算中的多个任务高效更新的变量。它们用于支持涉及并行和结合操作的操作，如计数器和求和。累加器在 Driver 节点上初始化，并在任务执行期间跨 Worker 节点更新。Driver 随后可以获取最终的聚合结果。

示例用法：

```python
# 初始化用于计数的累加器
accumulator_var = sc.accumulator(0)

# 在任务中使用累加器
def process_data(item):
    global accumulator_var
    accumulator_var += 1
    # ... 执行计算
```

共享变量通过最小化数据传输和促进结果的高效聚合，在优化 Spark 应用程序性能方面发挥着关键作用。它们为 Spark 基于 RDD 的分布式计算范式贡献了多功能性和可扩展性，特别是在处理大规模数据集和复杂计算任务时。

### Apache Spark 的统一编程模型与抽象层

Apache Spark 的设计以其统一编程模型（Unified Programming Model）和抽象层（Abstraction Layers）为特色，提供了对分布式数据处理的一致性和多功能方法。本节探讨该模型的关键组件以及有助于提升 Spark 效率和灵活性的抽象层。

#### 统一编程模型

统一编程模型的关键方面包括：

**弹性分布式数据集（RDD）：** RDD 构成 Spark 编程模型的基础。它们代表不可变的、容错的分布式对象集合。RDD 支持粗粒度转换（如 map、filter）和操作（如 count、collect）。RDD 是低级构建块，提供细粒度控制和容错能力。

**DataFrame：** DataFrame 在 Spark 演进后期引入，提供了 RDD 之上的更高级抽象。结构化和优化的 DataFrame 类似于关系表，并为处理分布式数据提供更具表现力的接口。利用 Catalyst 和 Tungsten 引擎，DataFrame 实现优化并提升性能。

**统一 API：** Spark 的统一编程模型确保不同工作负载之间的一致性——批处理、交互式查询、流处理和机器学习。同一套 API 可以跨这些工作负载使用，简化开发流程，使开发者更容易在不同任务之间切换。

#### 分布式数据处理的抽象层

这些抽象层简化了跨多台机器或数据中心处理大规模数据所涉及的复杂性：

**物理层（Physical Layer）：**
物理层处理 Spark 任务的实际执行。Tungsten（Spark 的物理执行引擎）优化低级计算和存储的执行。它专注于内存计算、代码生成和高效内存管理。

**逻辑层（Logical Layer / Catalyst）：**
Catalyst 是 Spark 的查询优化引擎，位于逻辑层。它将高级查询计划转换为优化的物理计划。Catalyst 执行各种优化，包括谓词下推、常量折叠和过滤器下推，有助于提升性能。

**优势与用例：**

- **开发一致性：** 开发者在不同 Spark 组件之间获得一致的体验。无论是编写 RDD 的转换还是使用 DataFrame 操作，统一 API 确保熟悉度，减少学习曲线。
- **性能优化：** 抽象层（特别是 Catalyst 和 Tungsten）为 Spark 的性能优化做出贡献。Catalyst 增强查询规划和优化，而 Tungsten 专注于高效执行，实现更快、更资源高效的处理。
- **跨工作负载的多功能性：** 统一编程模型和抽象层使 Spark 能够在各种数据处理工作负载中表现卓越。从即席查询到迭代机器学习算法，Spark 的设计适应了广泛的使用场景。

**示例：集成 RDD 和 DataFrame**

```scala
// 使用 RDD 转换
val rdd = sc.textFile("/path/to/data.txt")
val transformedRDD = rdd.map(line => line.split(",")).filter(arr => arr.length == 3)

// 将 RDD 转换为 DataFrame
val df = transformedRDD.toDF("Column1", "Column2", "Column3")

// 应用 DataFrame 操作
val resultDF = df.select("Column1", "Column2").groupBy("Column1").count()

// 显示结果
resultDF.show()
```

在这个例子中，RDD 转换与 DataFrame 操作无缝集成，展示了 Spark 统一编程模型固有的兼容性和多功能性。

Apache Spark 的统一编程模型和抽象层为分布式数据处理的高效和简化方法奠定了基础。开发者可以根据任务需要选择适当的抽象级别，无论是需要细粒度控制还是高级表现力。

### Apache Spark 中的作业执行：一个精心编排的过程

现在我们已经了解了 Spark 的基本组件，在本节中，我们将探讨 Spark 作业执行过程中的不同阶段。

Apache Spark 中作业的执行涉及一个系统性的步骤序列，高效地处理大规模数据。这个过程以各个组件之间的精心协调为特征，可以概括如下：

**1. 作业提交（Job Submission）：** Spark 作业的启动始于用户应用程序的提交。该应用程序通常包含一个 Driver Program，它初始化 SparkContext，定义数据转换和操作，并提交任务以供执行。

**2. 任务划分（Task Division）：** Driver Program 将逻辑执行计划分解为独立的任务，每个任务代表特定的工作单元。这些任务设计用于并行执行，是 Spark 作业中最小的操作单元。

**3. Stage 创建（Stage Creation）：** 任务根据依赖关系组织为 Stage。有向无环图（DAG）调度器促进 Stage 的创建，确保任务的最优并行执行，无需在 Stage 之间进行数据交换。

**4. 任务分发（Task Distribution）：** Cluster Manager 负责在集群的 Worker 节点上分配 Executor。Executor 负责执行分配的任务。Driver Program 和 Cluster Manager 之间的通信确保 Executor 拥有高效执行任务所需的资源。

**5. 数据处理（Data Processing）：** Executor 开始并行处理任务，从分布式存储中检索数据分区，应用指定的转换，并执行操作。弹性分布式数据集（RDD）作为核心数据抽象，在促进集群中并行数据处理方面发挥着关键作用。

**6. Shuffle 与数据交换（Shuffle and Data Exchange）：** 在需要 Shuffle 的操作中（如 groupByKey），Executor 之间发生数据交换。这个阶段涉及数据在分区和 Executor 之间的移动，以满足任务之间的依赖关系。

**7. 结果收集（Result Collection）：** 任务完成后，Driver Program 收集并聚合结果。如果 Spark 应用程序包含需要将数据返回给用户的操作（如 collect 或 save），则在此阶段整合结果。

**8. 作业完成（Job Completion）：** 当所有 Stage 和任务成功执行后，Spark 作业结束。Driver Program 监控任务进度，收集最终输出，或报告任何错误。Cluster Manager 释放已分配的资源，结束 Spark 应用程序。

这种对 Spark 作业执行过程的描述强调了框架在分布式数据处理中的效率，突出了并行性、容错性和最优资源利用。

### Spark 的可扩展性与速度

Spark 在应对大规模数据处理任务时所展现的可扩展性和速度至关重要，对于应对大数据带来的挑战具有关键意义。让我们深入探讨关键方面：

#### 可扩展性

Spark 可以高效地处理和加工大规模数据：

- **分布式计算范式：** Spark 采用分布式计算范式，允许资源的水平扩展。这意味着随着数据量或计算复杂性的增加，Spark 可以通过向集群添加更多 Worker 节点来无缝扩展。
- **分区与并行性：** Spark 将数据分解为分区，并在这些分区上并行执行操作。这种分区机制使得在集群中高效并行处理成为可能，确保任务可以在多个节点上同时执行。
- **处理海量数据集：** Spark 的可扩展性在处理超出单机容量的海量数据集时尤为重要。通过将工作负载分布到多个节点上，Spark 可以更高效、更及时地处理大量数据。
- **资源管理：** Spark 与 Apache Hadoop YARN 和 Apache Mesos 等集群管理器集成，提供高效的资源分配和管理。这确保集群中的每个节点获得适当的资源份额，优化整体性能。

#### 速度

让我们看看 Spark 的速度如何助力大数据处理：

- **内存计算（In-Memory Processing）：** Spark 的一个关键特性是能够执行内存计算。通过在内存中缓存中间数据，Spark 减少了反复从磁盘读取和写入的需求，显著提高了数据处理任务的速度。
- **惰性计算（Lazy Evaluation）：** Spark 采用惰性计算，意味着对数据的转换不会立即执行。相反，Spark 构建逻辑执行计划并在触发实际计算之前对其进行优化。这种方法最大限度地减少了不必要的计算，有助于提升整体速度。
- **Tungsten 执行引擎：** Spark 的 Tungsten 执行引擎为速度而设计。它采用代码生成和二进制处理等技术，使计算更加高效。Tungsten 对内存计算的关注进一步加快了 Spark 的性能。
- **通过 Catalyst 优化：** Catalyst（Spark 的查询优化引擎）优化逻辑和物理查询计划。这种优化通过根据数据结构和要执行的操作选择最高效的执行路径，提升了 Spark 应用程序的执行速度。

#### 整体影响

以下是 Spark 产生显著影响的一些关键领域：

- **实时处理：** 可扩展性和速度的结合使 Spark 能够有效处理实时处理任务。需要低延迟响应的应用程序（如流处理或交互式查询）受益于 Spark 快速处理数据和水平扩展的能力。
- **迭代算法：** 机器学习和其他在数据科学中常见的迭代算法从 Spark 的速度中受益匪浅。能够在内存中缓存中间结果并快速执行迭代计算，大大加速了机器学习模型的训练。
- **复杂分析：** Spark 的可扩展性和速度使其非常适合复杂分析任务，如图处理或大规模数据转换。它使组织能够从海量数据集中及时提取有价值的洞察。

本质上，Spark 的可扩展性和速度是其处理大数据挑战能力的基础，使组织能够高效地处理、分析和从庞大且多样化的数据集中获得洞察。无论是处理 TB 还是 PB 级别的数据，Spark 的架构和特性都使其成为现代数据处理任务的可靠选择。

### Spark on YARN：集群模式与客户端模式

Apache Spark 与 Apache Hadoop YARN（Yet Another Resource Negotiator）的集成为分布式数据处理提供了强大的框架。Spark 应用程序可以以**集群模式（Cluster Mode）** 或**客户端模式（Client Mode）** 部署在 YARN 集群上，每种模式都满足特定的用例和需求。

#### 集群模式：高效资源利用

在集群模式下，Spark 应用程序在 YARN 集群内部运行。Spark Driver（负责协调任务和管理整体执行）在 YARN 集群内的一个节点上启动。这确保了高效资源利用，因为应用程序与其他 YARN 应用程序共享资源。

**优势：**
- **资源共享：** 多个 Spark 应用程序可以在同一个 YARN 集群上共存，根据集群配置共享资源。
- **资源隔离：** YARN 管理资源分配和隔离，防止一个应用程序独占整个集群的资源。

**部署命令：**

```bash
spark-submit --class <MainClass> --master yarn --deploy-mode cluster <application-jar>
```

#### 客户端模式：增强的调试和监控

在客户端模式下，Spark Driver 运行在提交应用程序的机器上，位于 YARN 集群外部。虽然应用程序任务在 YARN 集群节点上执行，但 Driver 与集群的 ResourceManager 通信以获取资源。这种模式有利于调试和监控，因为 Driver 的标准输出和错误日志可以在客户端机器上访问。

**优势：**
- **调试便利：** 容易访问 Driver 日志，简化调试，允许开发者更方便地监控和分析应用程序行为。
- **简化部署：** 应用程序可以从任何具有 YARN 集群网络访问权限的机器提交，简化部署流程。

**部署命令：**

```bash
spark-submit --class <MainClass> --master yarn --deploy-mode client <application-jar>
```

理解集群模式和客户端模式之间的区别对于在 YARN 集群上优化 Spark 应用程序至关重要。两者之间的选择取决于资源共享需求、调试需求以及对应用程序执行环境的期望控制级别等因素。

### Spark 在 Hadoop 技术栈中的定位

Apache Spark 是一个强大的多功能数据处理框架，在更广泛的 Hadoop 生态系统中运行。虽然它本质上不是 Hadoop 技术栈的组件，但 Spark 可以无缝集成 Hadoop 组件，并且通常补充而非取代现有的 Hadoop 工具。以下是 Apache Spark 在 Hadoop 技术栈中的典型定位：

![[Pasted image 20260517220400.png]]

**图 5.3: Spark 在 Hadoop 技术栈中的定位**

**补充工具：** Spark 通常被定位为 Hadoop 生态系统中的补充工具。它不取代 Hadoop；而是与 Hadoop 组件并肩工作，以增强和加速某些数据处理任务。

**数据处理引擎：** Apache Spark 作为高性能数据处理引擎，能够处理批处理、交互式查询、流分析和机器学习工作负载。它可以处理来自各种数据源的数据，包括 Hadoop 分布式文件系统（HDFS）、HBase 等。

**MapReduce 的替代方案：** Spark 的主要角色之一是作为 MapReduce（Hadoop 生态系统中的传统处理引擎）的替代方案。Spark 的内存计算和 DAG（有向无环图）执行模型通常比 MapReduce 产生更快、更具表现力的数据处理工作流。

**与 HDFS 的兼容性：** Spark 与 HDFS（Hadoop 生态系统中的分布式存储系统）无缝集成。它可以直接从 HDFS 读取数据以及向 HDFS 写入数据，使其成为已经利用 Hadoop 分布式文件系统的组织的便利选择。

**与 YARN 的集成：** Spark 可以在 YARN（Yet Another Resource Negotiator，Hadoop 生态系统中的资源管理器）上运行。这种集成允许 Spark 在多租户环境中与其他 Hadoop 应用程序高效共享资源。

**利用 Hadoop 组件：** 虽然 Spark 不直接利用 Hadoop MapReduce 等组件，但它可以利用其他 Hadoop 生态系统工具，如 Hive、Pig 和 HBase。例如，Spark 与 Hive 的兼容性允许用户在 Hive 表上执行 Spark SQL 查询。

**统一数据处理框架：** Spark 通常被视为超越传统 MapReduce 能力的统一数据处理框架。它支持多样化的工作负载，包括批处理、交互式查询、流处理和机器学习，使其成为满足各种数据处理需求的多功能选择。

总之，Apache Spark 被定位为一种多功能且高性能的数据处理引擎，补充了 Hadoop 生态系统的能力。它提供了 MapReduce 的更快且更具表现力的替代方案，同时无缝集成 HDFS、YARN 和其他 Hadoop 组件。Spark 的灵活性和多功能性使其成为寻求高级数据处理能力的组织的宝贵 Hadoop 技术栈补充。

---

## 第二部分：动手实践

在本部分中，我们将在 Docker 容器中设置 Apache Spark 并在 Hadoop YARN 集群上运行。然后，我们将探索 Spark 的各种概念。

### 安装

让我们开始安装：

**步骤 1：下载并解压 Spark tar 包**

在本节中，我们将使用以下版本的 Hadoop 和 Spark：

- hadoop-3.3.1
- spark 3.5

在撰写本书时，Spark 的最新版本是 Spark 3.5，可从以下页面获取：https://spark.apache.org/downloads.html

在本书中，我们将从以下链接下载 spark 3.5 tar 包：

https://dlcdn.apache.org/spark/spark-3.5.0/spark-3.5.0-bin-hadoop3.tgz

**步骤 2：更新 Dockerfile 和脚本来设置 Spark**

我们将更新 Dockerfile 和 bootstrap.sh 脚本来解压 tar 包并设置环境变量。

完整的 Dockerfile 如下：

```dockerfile
# Step 1: Platform Selection

FROM ubuntu:18.04
LABEL key="simhadri-g"

# Step 2: User Configuration
RUN apt-get update && apt-get -y install sudo
RUN adduser --disabled-password --gecos '' docker
RUN adduser docker sudo
RUN echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
USER root

# Step 3: Update APT Repositories
RUN sudo apt-get -y install software-properties-common
RUN sudo add-apt-repository ppa:openjdk-r/ppa
RUN sudo apt-get update

# Step 4: Java Installation
RUN apt-get -y install openjdk-8-jdk
RUN ln -s /usr/lib/jvm/java-1.8.0-openjdk-amd64/ /usr/lib/jvm/java-1.8.0

# Step 5: Utility Tools
RUN apt -y install vim
RUN apt -y install nano
RUN apt -y install wget tar sudo rsync
RUN sudo apt-get update
RUN sudo apt-get -y install apache2
RUN sudo apt-get -y install tree

# Setup sock proxy
RUN apt-get install -y openssh-server

# passwordless ssh
RUN ssh-keygen -q -N "" -t rsa -f /root/.ssh/id_rsa
RUN cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys
RUN chmod 755 /root && chmod 700 /root/.ssh
RUN passwd --unlock root

# Step 6: Download hadoop-3.3.1, tez 0.10.2 and hive-4.0.0-alpha-2 and extract tar.gz

RUN wget https://dlcdn.apache.org/hadoop/common/hadoop-3.3.1/hadoop-3.3.1.tar.gz
RUN tar -xvzf hadoop-3.3.1.tar.gz
RUN ln -sf /hadoop-3.3.1 /hadoop

RUN wget https://archive.apache.org/dist/tez/0.10.2/apache-tez-0.10.2-bin.tar.gz
RUN tar -xvzf apache-tez-0.10.2-bin.tar.gz
RUN ln -sf /apache-tez-0.10.2-bin /tez

RUN wget https://dlcdn.apache.org/hive/hive-4.0.0-alpha-2/apache-hive-4.0.0-alpha-2-bin.tar.gz
RUN tar -xvzf apache-hive-4.0.0-alpha-2-bin.tar.gz
RUN ln -sf /apache-hive-4.0.0-alpha-2-bin /hive

RUN wget https://dlcdn.apache.org/spark/spark-3.5.0/spark-3.5.0-bin-hadoop3.tgz
RUN tar -xvzf spark-3.5.0-bin-hadoop3.tgz
RUN ln -sf ./spark-3.5.0-bin-hadoop3 /spark

RUN wget https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.28/mysql-connector-java-8.0.28.jar

RUN apt-get -y install mysql-server mysql-client libmysql-java

RUN apt-get -y clean all && rm -rf /tmp/* /var/tmp/*

# Setup sock proxy
RUN apt-get install -y openssh-server

RUN apt-get -y clean all && rm -rf /tmp/* /var/tmp/*

# Step 7: Copy configuration files and bootstrap script
RUN mkdir /conf
COPY core-site.xml /conf/core-site.xml
COPY hdfs-site.xml /conf/hdfs-site.xml
COPY hadoop-env.sh /conf/hadoop-env.sh
COPY hive-site.xml /conf/hive-site.xml
COPY bootstrap.sh /bootstrap.sh

# Step 8: Create Users

RUN sudo addgroup hadoop
RUN sudo adduser --ingroup hadoop hadoop
RUN sudo addgroup hive
RUN sudo adduser --ingroup hive hive
RUN sudo usermod -a -G hadoop hive

# HDFS ports
EXPOSE 1004 1006 8020 9866 9867 9870 9864 50470 9000 50070 9870

# YARN ports
EXPOSE 8030 8031 8032 8033 8040 8041 8042 8088 10020 19888

# SOCKS port
EXPOSE 1180

# HDFS datanode
EXPOSE 9866

# mysql expose
EXPOSE 3306
```

**步骤 3：启动 Docker 容器，启动 Spark，并验证设置**

克隆本书的 GitHub 仓库，导航到第 5 章。

Docker Build：

```bash
docker build -t analytics-with-hadoop-spark ./
```

启动 Docker 容器：

```bash
docker run --rm -t --name analytics-with-hadoop-spark --hostname localhost \
  -P -p9866:9866 -p10000:10000 -p10001:10001 -p10002:10002 \
  -p8088:8088 -p9000:9000 -p9870:9870 -p8000:8000 -p3306:3306 \
  -p50070:50070 -p50030:50030 -it -d analytics-with-hadoop-spark \
  /bin/bash -c "/bootstrap.sh >/tmp/boostrap.log"
```

登录到容器：

```bash
docker exec -it analytics-with-hadoop-spark "/bin/bash"
```

**步骤 4：启动 spark-shell 并验证设置**

让我们启动 spark-shell 并验证设置。

如果一切正常，您将能够使用以下命令查看 Spark 版本，如下面的代码片段所示。

```
root@localhost:/# ./spark/bin/spark-shell
23/12/10 22:27:12 WARN Utils: Your hostname, localhost resolves to a
loopback address: 127.0.0.1; using 172.17.0.2 instead (on interface eth0)
23/12/10 22:27:12 WARN Utils: Set SPARK_LOCAL_IP if you need to
bind to another address
Setting default log level to "WARN".
To adjust logging level use sc.setLogLevel(newLevel). For SparkR, use
setLogLevel(newLevel).
23/12/10 22:27:17 WARN NativeCodeLoader: Unable to load native-
hadoop library for your platform… using builtin-java classes where
applicable
Spark context Web UI available at http://localhost:4040
Spark context available as 'sc' (master = local[*], app id = local-
1702247238499).
Spark session available as 'spark'.
Welcome to

      ____              __
     / __/__  ___ _____/ /__
    _\ \/ _ \/ _ `/ __/  '_/
   /___/ .__/\_,_/_/ /_/\_\   version 3.5.0
      /_/

Using Scala version 2.12.18 (OpenJDK 64-Bit Server VM, Java 1.8.0_362)
Type in expressions to have them evaluated.
Type :help for more information.

scala> spark.version
res0: String = 3.5.0
```

### 运行我们的第一个 Spark 程序

现在让我们使用交互式 spark-shell 运行我们的第一个 Spark 程序。我们将使用 Scala 编程语言中的 Spark DataFrame API 读取 JSON 数据并创建 DataFrame。

```scala
scala> val df = spark.read.json("/spark/examples/src/main/resources/people.json")

df: org.apache.spark.sql.DataFrame = [age: bigint, name: string]

scala> df.show()
+----+-------+
| age|   name|
+----+-------+
|NULL|Michael|
|  30|   Andy|
|  19| Justin|
+----+-------+
```

#### 代码解释

以下是逐步解释：

**读取 JSON 数据：**

```scala
val df = spark.read.json("/spark/examples/src/main/resources/people.json")
```

这行代码从指定的文件路径读取 JSON 数据到一个名为 `df` 的 Spark DataFrame 中。

从 JSON 数据推断的 Schema 会自动应用于 DataFrame。

**显示 DataFrame：**

```scala
df.show()
```

这行代码使用 `show()` 方法显示 DataFrame 的内容。

输出以表格形式展示 DataFrame，包含 `age` 和 `name` 列。

#### 输出解释

显示的 DataFrame 包含以下行和列：

- `age` 列包含三个值：NULL、30 和 19
- `name` 列包含对应的名字：Michael、Andy 和 Justin

以下是关键要点：

- `NULL` 代表 `age` 列中的空值。Spark 将空值表示为 `NULL`。
- DataFrame 类似于关系数据库中的表，`show()` 方法提供了查看内容的便捷方式。
- DataFrame 的 Schema 是从 JSON 数据中自动推断的。在本例中，`age` 列的类型为 bigint（Scala 中的 long），`name` 列的类型为 string。

总的来说，这段代码片段演示了如何将 JSON 数据读入 Spark DataFrame 并快速使用 `show()` 方法检查内容。DataFrame 是 Spark 中的基本抽象，提供了结构化且分布式的方式来处理数据。

### Spark：用户体验与支持的 API

Apache Spark 提供多种编程语言的 API，使开发者能够交互和构建 Spark 应用程序。主要支持的语言有：

- **Scala：** Spark 的原生语言，提供最丰富的 API 和对新功能的最早访问。可以使用 `spark-shell` 命令启动。
- **Java：** 功能齐全的 API，与 Scala 类似，使 Spark 对 Java 开发者可用。
- **Python（PySpark）：** Python 开发者可以利用 PySpark，它通过 Python API 暴露 Spark 功能。PySpark 以其简洁的语法和易用性而受欢迎。
- **R（SparkR）：** SparkR 允许 R 开发者与 Spark 交互，将 R 的统计计算能力与 Spark 的分布式处理相结合。
- **SQL：** 使用 `spark-sql` 命令启动。

这些编程接口提供了一组函数和类，用于使用 RDD 或更高级的抽象（如 DataFrame 和 Dataset）创建、转换和分析分布式数据集。

在 Apache Spark 中，主要有两种与 Spark 交互的方式：通过自包含应用程序和使用交互式 Shell（Scala 的 spark-shell、Python 的 pyspark 等）。让我们简要探讨每种方式。

### Spark 自包含应用程序

自包含 Spark 应用程序是使用 Spark 支持的编程语言（如 Scala、Java、Python 或 R）编写的独立程序。这种类型的应用程序通常在开发、编译后提交到 Spark 集群执行。

**示例（Scala）：**

```scala
import org.apache.spark.sql.{SparkSession, Row}
import org.apache.spark.sql.types.{StructType, StructField, StringType, IntegerType}

object SparkAppExample {
  def main(args: Array[String]): Unit = {
    // Initialize Spark session
    val spark = SparkSession.builder.appName("SparkAppExample").getOrCreate()

    // Define schema
    val schema = StructType(Seq(
      StructField("Name", StringType, true),
      StructField("Age", IntegerType, true)
    ))

    // Create DataFrame
    val data = Seq(Row("Alice", 25), Row("Bob", 30))
    val df = spark.createDataFrame(spark.sparkContext.parallelize(data), schema)

    // Perform operations on the DataFrame or execute Spark jobs

    // Stop Spark session
    spark.stop()
  }
}
```

要运行这个应用程序，通常需要编译代码，将其打包成 JAR 文件，然后使用 `spark-submit` 命令提交到 Spark 集群。

### Spark 交互式 Shell

Spark 为各种编程语言提供交互式 Shell，包括 Scala（spark-shell）、Python（pyspark）和 R（sparkR）。这些 Shell 允许用户在 REPL（Read-Eval-Print Loop）环境中交互式地探索和分析数据。

**示例（Scala spark-shell）：**

```scala
// 启动 spark-shell
$ spark-shell

// 在 spark-shell 中
val data = Seq(("Alice", 25), ("Bob", 30))
val df = spark.createDataFrame(data).toDF("Name", "Age")

// 交互式执行 DataFrame 操作
df.show()

// 退出 spark-shell
:quit
```

在交互式 Shell 中，您可以逐行执行 Spark 操作，使其成为数据探索和快速原型设计的便捷环境。

自包含应用程序和交互式 Shell 都是使用 Apache Spark 不可或缺的部分，它们之间的选择取决于任务的性质和用户的偏好工作流程。自包含应用程序适用于大规模数据处理，而交互式 Shell 适用于探索性数据分析和测试。

### Spark UI：监控与优化性能

Spark UI（或 Spark Application UI）是由 Apache Spark 提供的基于 Web 的用户界面，提供对 Spark 应用程序执行的详细洞察。通过 Web 浏览器访问，Spark UI 提供实时信息、可视化和指标，使开发者和管理员能够监控、诊断和优化 Spark 应用程序的性能。以下是 Spark UI 的关键方面：

**访问 Spark UI：**

Spark UI 默认可通过 Driver 节点的 4040 端口访问。URL 通常为 `http://<driver-node>:4040`。如果同一个集群上运行多个 SparkContext 或应用程序，可能会有多个 Spark UI 可用。

在我们的设置中，可以在 http://localhost:4040/jobs/ 访问。

让我们对两个 DataFrame 运行一个简单的 union 操作，并在 Spark UI 中观察。

```scala
scala> val df = spark.read.json("/spark/examples/src/main/resources/people.json")
df: org.apache.spark.sql.DataFrame = [age: bigint, name: string]

scala> val df1 = df.unionAll(df)

scala> df1.show()
+----+-------+
| age|   name|
+----+-------+
|NULL|Michael|
|  30|   Andy|
|  19| Justin|
|NULL|Michael|
|  30|   Andy|
|  19| Justin|
+----+-------+
```

![[Pasted image 20260517220423.png]]

**图 5.4: Spark UI 中的 Overview 标签页**

**概览（Overview）标签页** 提供 Spark 应用程序的高级别摘要，包括应用程序的一般信息，如应用程序 ID、持续时间和完成状态。

![[Pasted image 20260517220434.png]]

**图 5.5: Spark Jobs/Stages 标签页**

**Jobs 和 Stages 标签页** 提供 Spark 作业和 Stage 的详细洞察。用户可以检查有向无环图（DAG）的可视化，跟踪每个 Stage 的进度，并识别任何瓶颈或延迟。

**Executors 和 Tasks：** Executors 标签页提供关于分配给 Executor 的资源信息，包括内存和 CPU 使用情况。用户可以监控各个 Executor 的健康状况和性能，并查看每个 Executor 上运行的任务分解。

**Storage 标签页** 显示关于缓存在内存或磁盘上的弹性分布式数据集（RDD）的信息。用户可以分析缓存 RDD 的大小、存储级别和其他详细信息。

**Environment 标签页** 提供 Spark 应用程序配置、运行时环境和系统属性的详细视图。这对于诊断配置问题和理解运行时环境很有价值。

**SQL 和 Streaming 标签页** 对于 Spark SQL 应用程序，额外的标签页分别提供对 SQL 查询和流查询执行情况的洞察。

![[Pasted image 20260517220449.png]]

**图 5.6: SQL/Dataframe/Query Plan 标签页**

**Event Timeline 标签页** 呈现 Spark 应用程序执行期间重要事件的时间线，包括作业和 Stage 完成、资源分配变更等。

**诊断和日志记录：** Spark UI 包含指向事件日志和诊断信息的链接，有助于故障排除和调试。日志信息对于识别错误、异常或意外行为至关重要。

**实时更新：** Spark UI 提供实时更新，允许用户实时监控应用程序的进度。这对于观察长时间运行的 Spark 作业或流应用程序的行为特别有用。

**资源分配和 Executor 可视化：** Executors 标签页上的可视化提供 Executor 资源使用情况的图形表示，有助于快速识别资源瓶颈或不平衡。

**任务指标和 Shuffle 指标：** UI 提供与各个任务相关的详细指标，包括任务持续时间、输入/输出大小等。Shuffle 指标提供数据 Shuffle 的洞察，帮助优化 groupByKey 和 reduceByKey 等操作的性能。

利用 Spark UI 对于优化性能、诊断问题以及全面了解 Spark 应用程序行为至关重要。在开发和生产阶段定期监控 Spark UI 可实现高效的性能调优，并确保 Spark 工作流的顺畅执行。

### DataFrame API

Apache Spark 中的 DataFrame API 为处理结构化和半结构化数据提供了高级编程接口。它们提供了简洁且富有表现力的方式来进行各种数据操作、转换和分析任务。以下是 Spark 中一些常用的 DataFrame API：

| 操作 | 说明 | 示例用法（Scala） |
|------|------|-------------------|
| **select** | 从 DataFrame 中选择特定列 | `df.select("name", "age")` |
| **filter / where** | 根据条件筛选行 | `df.filter(col("age") > 25)` 或 `df.where("age > 25")` |
| **groupBy** | 按指定列分组 | `df.groupBy("department").count()` |
| **agg** | 执行聚合操作 | `df.agg(sum("salary"), avg("age"))` |
| **orderBy / sort** | 按指定列排序 | `df.orderBy(col("age").desc)` |
| **join** | 将两个 DataFrame 连接 | `df1.join(df2, "id")` |
| **withColumn** | 添加或替换列 | `df.withColumn("age2", col("age") * 2)` |
| **withColumnRenamed** | 重命名列 | `df.withColumnRenamed("oldName", "newName")` |
| **drop** | 删除列 | `df.drop("unnecessaryColumn")` |
| **distinct** | 返回去重后的行 | `df.distinct()` |
| **dropDuplicates** | 删除指定列的重复行 | `df.dropDuplicates("name")` |
| **limit** | 返回前 N 行 | `df.limit(100)` |
| **union / unionAll** | 合并两个 DataFrame | `df1.union(df2)` |
| **na.fill** | 填充空值 | `df.na.fill(0)` |
| **na.drop** | 删除包含空值的行 | `df.na.drop()` |
| **sample** | 随机抽样 | `df.sample(0.1)` |
| **describe** | 计算列的统计摘要 | `df.describe("age", "salary")` |
| **alias** | 为 DataFrame 设置别名 | `df.alias("a")` |
| **cache / persist** | 缓存 DataFrame 到内存 | `df.cache()` |
| **printSchema** | 打印 DataFrame 的 Schema | `df.printSchema()` |
| **show** | 显示前 N 行 | `df.show(20)` |

**表 5.3: Apache Spark 中的 DataFrame 操作**

这些只是 Spark 中众多 DataFrame API 的一些示例。DataFrame API 为 ETL（Extract, Transform, Load）流程、数据探索和分析提供了丰富的操作集。这些 API 可用于多种编程语言，包括 Scala、Java、Python（PySpark）和 R（SparkR）。

### RDD

弹性分布式数据集（RDD）是 Apache Spark 中的基本抽象，代表不可变的分布式对象集合。RDD 为分布式数据处理提供了低级、细粒度的 API。

#### Apache Spark 中的转换和操作

理解转换（Transformation）和操作（Action）之间的区别对于有效使用 Spark 进行数据处理至关重要。

##### 转换（Transformation）

转换是接受输入数据集（如 RDD 或 DataFrame）并产生新数据集的操作。这些操作是**惰性的**，意味着它们不会立即执行，而是建立一个在执行操作时应用的转换计划。

有两种类型的转换：

**窄依赖转换（Narrow Transformations）**

在窄依赖转换中，计算单个分区中记录所需的所有元素都位于父 RDD 的单个分区中。这些转换不需要数据通过网络 Shuffle。

示例：

- `map(func)`：对数据集的每个元素应用一个函数，返回转换后元素的新数据集。

```python
rdd.map(lambda x: x * 2)
```

- `filter(func)`：返回一个只包含满足给定条件的元素的新数据集。

```python
rdd.filter(lambda x: x % 2 == 0)
```

- `union(otherDataset)`：返回一个包含源数据集和 otherDataset 中元素并集的新数据集。

```python
rdd.union(other_rdd)
```

**宽依赖转换（Wide Transformations）**

在宽依赖转换中，计算单个分区中记录所需的元素可能存在于父 RDD 的多个分区中。这些转换涉及数据通过网络 Shuffle，并在不同的 Stage 之间分割。

示例：

- `groupByKey()`：按键分组数据，返回键值对的数据集。

```python
rdd.groupByKey()
```

- `reduceByKey(func)`：使用结合和可交换的归约函数合并每个键的值。

```python
rdd.reduceByKey(lambda x, y: x + y)
```

- `sortByKey()`：按键对数据集排序。

```python
rdd.sortByKey()
```

- `repartition(numPartitions)`：将数据重新 Shuffle 到 numPartitions 个分区。

```python
rdd.repartition(10)
```

##### 操作（Action）

**定义：** 操作是触发 DAG 中构建的转换执行并返回值（给 Driver 程序）或将数据写入外部存储系统的操作。

**特征：**

- **触发（Trigger）：** 操作强制执行转换的计算，执行计算计划。
- **返回（Return）：** 操作要么将结果返回给 Driver 程序，要么将结果写入外部存储系统。

**常见操作：**

- `collect()`：返回数据集的所有元素作为数组给 Driver 程序。

```python
rdd.collect()
```

- `count()`：返回数据集中的元素数量。

```python
rdd.count()
```

- `first()`：返回数据集的第一个元素。

```python
rdd.first()
```

- `reduce(func)`：使用指定的二元函数聚合数据集的元素。

```python
rdd.reduce(lambda x, y: x + y)
```

以下是 Apache Spark 中一些常用的 RDD API/函数：

| 操作 | 类型 | 说明 |
|------|------|------|
| **map(func)** | 转换（窄） | 对每个元素应用函数，返回新 RDD |
| **filter(func)** | 转换（窄） | 返回满足条件的元素 |
| **flatMap(func)** | 转换（窄） | 类似 map，但每个输入项可以映射到 0 个或多个输出项 |
| **mapPartitions(func)** | 转换（窄） | 类似 map，但在每个分区上运行 |
| **union(otherRDD)** | 转换（窄） | 返回两个 RDD 的并集 |
| **distinct()** | 转换（宽） | 返回去重后的 RDD |
| **groupByKey()** | 转换（宽） | 按键分组 |
| **reduceByKey(func)** | 转换（宽） | 按 Key 聚合值 |
| **sortByKey()** | 转换（宽） | 按 Key 排序 |
| **join(otherRDD)** | 转换（宽） | 按 Key 连接两个 RDD |
| **coalesce(n)** | 转换（窄） | 减少分区数 |
| **repartition(n)** | 转换（宽） | 重新分区，会触发 Shuffle |
| **collect()** | 操作 | 返回所有元素到 Driver |
| **count()** | 操作 | 返回元素数量 |
| **first()** | 操作 | 返回第一个元素 |
| **take(n)** | 操作 | 返回前 n 个元素 |
| **reduce(func)** | 操作 | 使用函数聚合元素 |
| **foreach(func)** | 操作 | 对每个元素执行函数 |
| **saveAsTextFile(path)** | 操作 | 将 RDD 保存为文本文件 |
| **countByKey()** | 操作 | 返回每个 Key 的计数 |

**表 5.4: Apache Spark 中重要的 RDD 操作**

这些只是 Apache Spark 中众多 RDD 操作的一些示例。RDD 为分布式数据处理提供了灵活且强大的 API，使其成为 Spark 应用程序的基础概念。

### 性能调优

优化 Apache Spark 应用程序的性能对于高效处理大规模数据集至关重要。性能调优涉及微调各种配置、利用 Spark 提供的优化以及采用最佳实践。以下是 Apache Spark 性能调优的关键考虑因素和策略：

**集群配置（Cluster Configuration）：** 根据应用程序的具体需求调整 Spark 集群配置。考虑因素包括 Executor 实例数、每个 Executor 的内存分配以及整体集群规模。

**Executor 内存管理（Executor Memory Management）：** 通过在存储（缓存）、执行和开销之间平衡内存分配来优化 Executor 内存设置。确保有足够的内存用于处理任务和缓存频繁访问的数据。

**缓存和持久化（Caching and Persistence）：** 合理利用 Spark 的缓存和持久化机制。在内存中缓存常用数据集可以显著提高迭代算法和重复查询的性能。

**数据序列化（Data Serialization）：** 选择适当的数据序列化格式以减少节点间传输的数据量。考虑使用更高效的序列化格式，如 Kryo，特别是在处理复杂数据结构时。

**广播变量（Broadcast Variables）：** 使用广播变量在集群中的所有节点上高效共享只读数据。这在处理大型查找表或参考数据时特别有用。

**分区（Partitioning）：** 根据数据特征和可用资源，仔细选择 RDD 和 DataFrame 的分区数。最优的分区数确保更好的并行性和资源利用率。

**Shuffle 调优（Shuffle Tuning）：** Shuffle 涉及跨集群重新分布数据，但可能是性能密集型操作。调优与 Shuffle 相关的参数（如 `spark.sql.shuffle.partitions` 和 `spark.shuffle.compress`）以优化 Shuffle 过程。

**数据倾斜处理（Data Skew Handling）：** 通过识别倾斜 Key 并应用策略（如 Salting、Bucketing 或自定义分区）来解决数据倾斜问题，以均匀分布工作负载。

**动态分配（Dynamic Allocation）：** 启用动态分配，允许 Spark 根据工作负载动态调整 Executor 数量。这有助于高效利用资源并减少空闲时间。

**广播哈希连接（Broadcast Hash Join）：** 对于较小的数据集，选择广播哈希连接以避免 Shuffle。当其中一个 DataFrame 可以放入所有节点的内存时，这是一个有效的策略。

**列裁剪和谓词下推（Column Pruning and Predicate Pushdown）：** 利用 Spark 的 Catalyst 优化器执行列裁剪和谓词下推，减少从存储读取和处理的数据量。

**Tungsten 执行引擎：** 利用 Spark 1.6 中引入的 Tungsten 执行引擎进行改进的代码生成和内存管理。Tungsten 可以为某些工作负载提供显著的性能优势。

**自适应查询执行（Adaptive Query Execution）：** Spark 3.0 及后续版本使用自适应查询执行，根据运行时统计信息动态调整执行计划，提高查询效率。

**监控和分析（Monitoring and Profiling）：** 使用 Spark UI、指标和日志等工具定期监控 Spark 应用程序。分析工具有助于识别瓶颈和改进领域。

**硬件考虑（Hardware Considerations）：** 考虑底层硬件和基础设施。确保集群有足够的 CPU、内存和网络资源来高效处理工作负载。

通过仔细考虑这些性能调优策略并持续监控和分析 Spark 应用程序，开发者和管理员可以优化其 Spark 工作流的性能，实现更快、更高效的数据处理。

### 使用 Apache Spark 对天气数据进行探索性数据分析

在本节中，我们将使用 Apache Spark 进行探索性数据分析（EDA）。让我们使用 Spark DataFrame 操作对天气数据进行基本的数据分析。让我们分解步骤并分析数据：

数据源：https://www.ncei.noaa.gov/pub/data/cdo/samples/GHCND_sample_csv.csv

![[Pasted image 20260517220847.png]]

**步骤 1：读取天气数据**

```scala
val df = spark.read.option("header", true).csv("/GHCND_sample_csv.csv")
```

您正在从 CSV 文件中读取天气数据到一个 DataFrame `df` 中。`option("header", true)` 表示 CSV 文件的第一行包含列标题。

**步骤 2：打印 Schema**

```scala
df.printSchema
```

您打印 DataFrame 的 Schema 以了解每列的数据类型和结构。

**步骤 3：计数行数**

```scala
df.count()
```

您计算 DataFrame 中的行数，返回的行数让您了解数据集的大小。

**步骤 4：显示前 5 行**

```scala
df.show(5)
```

您显示 DataFrame 的前五行以快速了解数据概要。

**步骤 5：过滤数据**

```scala
df.where("TMAX<-100 and TMIN>-222").show
```

您过滤数据以显示最高温度小于 -100 且最低温度大于 -222 的行。这有助于识别极端的温度值。

**分析摘要：**

- 天气数据集包含 TMAX（最高温度）、TMIN（最低温度）和 PRCP（降水量）等列。
- 该数据集有 31 行，表明这是一个相对较小的样本。
- 您已经识别并显示了最高温度小于 -100 且最低温度大于 -222 的行，可能突出显示了极端的温度异常值。

#### Spark 如何简化数据分析

- **读取数据的便利性：** Spark 简化了从各种数据源（如 CSV 文件）读取数据的过程，只需一行代码。
- **交互式探索：** Spark 的 DataFrame 操作（如 `printSchema` 和 `show`）提供了交互式且简便的方式来探索数据的结构和内容。
- **可扩展性：** Spark 水平扩展的能力使其适合高效处理大规模数据集，即使当前数据集很小。
- **过滤和分析：** Spark 富有表现力的 DataFrame API 允许您使用简洁可读的代码执行复杂的过滤和分析任务。

这个例子说明了 Spark 如何通过其交互式环境使用户能够无缝地分析和操作数据，为数据探索和分析提供了强大的工具。

---

## 结论

本章提供了 Apache Spark 的全面概述，突出了其用于分布式数据处理和分析的强大能力。从多功能的编程接口到其强大的抽象层（如 DataFrame 和弹性分布式数据集 RDD），Spark 被证明是处理大规模数据工作负载的多功能且高效的工具。学习 Spark 的优势不仅限于其可扩展性和速度，还包括其易用性、与各种编程语言的兼容性以及与流行大数据工具的无缝集成。

通过掌握 Spark，个人可以利用分布式计算的力量，使他们能够处理复杂的数据处理任务，执行高级分析，并从海量数据集中获得有价值的洞察。无论是数据工程、机器学习还是分析领域，学习 Spark 所获得的技能在快速演进的大数据和云计算领域开辟了多样化的机会。

在我们结束本章之际，请考虑将 Apache Spark 添加到您的技能组合中的优势——这项投资使您能够应对现代数据处理的挑战，并将您置于数据驱动革命的前沿。

在下一章中，我们将探索 Iceberg 等表格式以及 ORC、Parquet 和 Avro 等文件格式。

---

## 要点

- **多功能的分布式计算：** Apache Spark 为分布式计算提供了多功能且高效的框架，能够处理大规模数据处理任务。
- **抽象层：** Spark 提供了强大的抽象层，如 DataFrame 和 RDD，简化了复杂的数据操作和分析。
- **统一编程模型：** Spark 的统一编程模型允许开发者使用同一套 API 进行批处理、交互式查询、流处理和机器学习。
- **交互式探索：** 交互式 spark-shell 便于探索性数据分析，使加载、探索和分析数据变得轻松无缝。
- **可扩展性和速度：** Spark 水平扩展的能力和内存计算共同实现了令人印象深刻的速度，使其适合处理海量数据集。
- **多语言支持：** 支持多种编程语言（包括 Scala、Java、Python 和 R），Spark 满足了不同开发者的偏好。
- **与大数据工具的集成：** Spark 与流行的大数据工具无缝集成，确保与现有生态系统（如 Apache Hadoop 和 Apache Hive）的兼容性。
- **易于学习：** Spark 直观的 API 和详尽的文档使其对学习者来说易于上手，降低了那些刚接触分布式计算的人员的入门门槛。
- **跨领域的应用：** 掌握 Spark 为跨领域的机会打开了大门，从数据工程到机器学习、分析以及其他领域。
- **面向未来的技能组合：** 鉴于其在大数据领域中的普及程度，掌握 Apache Spark 技能将个人置于数据驱动革命的前沿，提升在数据科学和分析这一不断发展领域中的职业前景。

---

## 课后习题

1. Apache Spark 为分布式数据处理提供的两个关键抽象层是什么？
2. Spark 的统一编程模型如何贡献于其多功能性？
3. 交互式 spark-shell 以什么方式促进 Spark 中的探索性数据分析？
4. 您能否解释 Spark 的可扩展性和速度在处理大规模数据处理任务中的重要性？
5. 除了 Scala 之外，请列举 Apache Spark 支持的两种编程语言。
6. Spark 如何与 Apache Hadoop 和 Apache Hive 等现有大数据工具无缝集成？
7. Spark 多功能 API 在简化复杂数据操作和分析方面的作用是什么？
8. Spark 水平扩展的能力如何为其在分布式计算中的效率做出贡献？
9. 解释弹性分布式数据集（RDD）的概念及其在 Spark 中的重要性。

---

## 本章自测

**1. 以下哪项是 Apache Spark 中 RDD 的特征？**

A. 可变且不具有容错性
B. 不可变且具有容错性
C. 不可变但不具有容错性
D. 可变且具有容错性

**2. 在 Apache Spark 中，以下哪种操作会触发实际计算？**

A. map()
B. filter()
C. collect()
D. groupByKey()

**3. Spark 中 Catalyst 优化器的主要功能是什么？**

A. 管理集群资源
B. 优化查询执行计划
C. 处理数据序列化
D. 管理内存分配

**4. 在 Spark on YARN 中，哪种部署模式将 Driver 运行在客户端机器上？**

A. Cluster 模式
B. Standalone 模式
C. Client 模式
D. Local 模式

**5. Apache Spark 中的 DataFrame 与 RDD 相比，以下哪项是主要优势？**

A. 更低的抽象级别
B. 通过 Catalyst 优化器的自动优化
C. 没有 Schema 推断
D. 只能使用 Scala 编程

---

## 自测答案

1. **B** — RDD 是不可变的（创建后内容不可更改）且具有容错性（通过 Lineage 信息在节点故障时重建丢失分区）。

2. **C** — collect() 是一个 Action 操作，它会触发 DAG 中构建的所有 Transformation 的实际执行。map()、filter() 和 groupByKey() 都是 Transformation 操作，是惰性的。

3. **B** — Catalyst 优化器是 Spark 的查询优化引擎，负责优化 Spark SQL 和 DataFrame 操作的逻辑和物理执行计划，应用谓词下推、常量折叠等优化。

4. **C** — 在 Client 模式下，Spark Driver 运行在提交应用程序的客户端机器上（YARN 集群外部），便于调试和监控。

5. **B** — DataFrame 受益于 Catalyst 优化器的自动查询优化（如谓词下推、列裁剪等），而 RDD 没有内置的自动优化机制，需要手动优化。