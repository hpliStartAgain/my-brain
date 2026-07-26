# 4 分布式查询引擎：Apache Hive

## 引言

本章全面介绍了 Apache Hive。Apache Hive 是一个庞大的项目，具有广泛的复杂性，虽然它值得深入探索，但本书提供了一个适合初学者和中级学习者的高层次概述。

## 本章结构

在本章中，我们将涵盖以下主题：

**Part I：理论**

- Apache Hive 简介（通过类比）
- Hive 架构
- HMS（Hive Metastore）
- HS2（Hive Server 2）
- Hive 客户端
- Hive 查询语言（HQL）
- Hive 数据模型
- 托管表和外部表
- Hive ACID
- Hive Compaction 和小文件问题
- Hive LLAP
- UDF（用户定义函数）
- Hive 在 Hadoop 技术栈中的位置

**Part II：实践**

- 使用 Docker 搭建 Hive 集群并通过 Beeline 客户端的 JDBC 访问
- 探索 Hive 服务
- 探索 DDL、DML Hive 查询
- 创建 UDF
- ACID 和 Compaction

## Part I：理论

## Apache Hive

Apache Hive 是一个强大且多功能的构建在 Hadoop 生态系统之上的数据仓库和类 SQL 查询语言系统。它提供了一个重要的抽象层，允许用户使用类似于结构化查询语言（SQL）的语言，以结构化和熟悉的方式与大规模数据交互。Hive 使分析师、数据科学家和其他用户更容易从存储在 Hadoop 分布式文件系统（HDFS）或其他数据存储系统中的海量数据中提取有价值的洞察。

在本节中，我们将深入探讨 Apache Hive 的世界，探索其基本概念、架构以及它如何简化处理大数据的过程。无论你是数据分析师还是大数据爱好者，理解 Hive 都是利用 Hadoop 满足数据处理和分析需求的关键一步。我们将涵盖从 Hive 基本组件到更高级主题的一切内容，使你在数据驱动的工作中能够有效利用 Hive 的能力。

## Apache Hive 简介

在本节中，我们将通过类比来探索 Apache Hive，并了解它如何融入 Hadoop 技术栈。

### 类比：图书馆

想象一下，Apache Hive 就像一座庞大而混乱的图书馆中一位技艺娴熟的图书管理员，馆内藏有无数书籍。这座图书馆代表你组织的大规模数据存储，其中信息以非结构化或半结构化的方式存储。现在，你作为数据分析师或研究员，想在这个数据迷宫中找到特定的信息片段。

这就是 Apache Hive 扮演图书管理员角色的地方。它不是要求你自己在迷宫中导航，而是为你提供一个用户友好的目录系统。这个目录包含有组织的列表，记录了书籍（数据）的位置、它们包含的内容以及你如何访问它们。

在这个类比中：

- **图书馆** 代表你组织的数据仓库，可能由各种数据格式和来源组成。
- **书籍** 是此仓库中的各个数据文件或数据集。
- **图书管理员** 是 Apache Hive，充当你（数据分析师）和数据之间的中介。它提供了一种结构化的方式来与数据交互和查询。
- **目录** 是 Hive Metastore，存储有关数据的元数据，如模式信息和数据位置。
- **目录系统** 是 Hive 的类 SQL 查询语言，允许你以熟悉的方式表达数据查询。

因此，正如图书管理员简化了在庞大图书馆中查找书籍的过程，Apache Hive 简化了从大型复杂数据集中查询和检索特定数据的过程，使数据专业人员能够访问和管理数据。

### 类比：数据餐厅

现在，让我们通过一个类比来理解 Apache Hive 如何与 Hadoop、YARN、MapReduce 和 Tez 配合使用。

想象你正在经营一家每天为大量顾客提供服务的餐厅，你需要一种高效的方式来管理订单并处理它们，类似于处理大数据。

**Hadoop 分布式文件系统（HDFS）— 食材**

HDFS 就像你存储所有食材（数据）的仓库。每种食材（数据块）都被标记并存储在单独的货架（DataNode）上。你将食材组织到不同的区域（目录）和容器（文件）中以方便访问。

**Yet Another Resource Negotiator（YARN）— 厨房**

YARN 扮演厨房经理的角色。经理确保厨房资源得到有效利用。当订单（计算任务）进来时，经理分配厨师（CPU 和内存等资源）来高效准备菜品（任务）。

**MapReduce — 烹饪过程**

MapReduce 是餐厅中的烹饪过程。当一个订单（数据处理任务）进来时，它被分为两个步骤。首先，你切菜和准备食材（Map），然后你烹饪和上菜（Reduce）。正如烹饪分为不同步骤，复杂的数据任务被分解为更小的、可管理的过程。

**Apache Hive — 服务员和菜单**

Apache Hive 充当服务员和菜单的角色。你不需要进入厨房准备每道菜（编写数据处理代码），而是可以坐在桌边从菜单点菜（运行类 SQL 查询）。服务员（Hive）理解你的订单，将其传达给厨房（MapReduce），并将准备好的菜品（查询结果）端到你的桌上。

在这个数据餐厅类比中，HDFS 是食材仓库，YARN 是厨房经理，MapReduce 是烹饪过程，Apache Hive 是服务员和菜单。它们共同确保你的餐厅高效地处理和提供大量订单（数据）给你的顾客（用户），而不会在厨房（数据生态系统）中造成混乱。

## Apache Hive：架构

Hive 将类 SQL 查询转换为 MapReduce/Tez 作业以在 Hadoop 集群上执行，允许用户对大数据执行即席分析和聚合查询，而无需编写复杂的 MapReduce 代码。

值得注意的是，Hive 的能力不仅限于查询执行。它还为管理、存储和检索大数据集提供了高效的工具。这种多功能性使其成为理想的选择，特别是对于通常需要广泛数据管理的数据仓库和商业智能任务。因此，Hive 作为一个强大且适应性强的工具，简化了大数据分析，同时确保你的数据组织良好且可访问。

![[Pasted image 20260517215533.png]]
*图 4.1：Hive 架构高层次概述*

Hive 的架构依赖三个基本组件：Hive Metastore（HMS）、Hive Server 2（HS2）和 Hive 客户端，每个组件服务于不同但相互关联的目的。

## Hive Metastore（HMS）

Hive Metastore（HMS）是关系数据库中 Hive 表和分区元数据的中央仓库，并通过 Metastore 服务 API 向客户端（包括 Hive、Impala 和 Spark）提供对这些信息的访问。它已成为利用多样化开源软件（如 Apache Spark 和 Presto）的数据湖的构建块。事实上，一个完整的工具生态系统（开源和其他方面）都围绕 Hive Metastore 构建，如下图所示。

![[Pasted image 20260517215548.png]]
*图 4.2：Hive Metastore*

HMS 是 Hive 架构的一个关键部分，管理有关 Hive 表和分区的元数据。它充当 Hive 的目录或目录系统，存储表模式、数据位置和分区元数据等信息。以下是其主要功能：

- **元数据存储（Metadata Storage）**：HMS 存储表和列的定义、分区信息和表统计信息。
- **模式和位置信息（Schema and Location Information）**：它跟踪表的模式，包括列名、数据类型和分区键。此外，它记录数据在 HDFS 或其他存储系统中的物理位置。
- **访问控制（Access Control）**：Hive Metastore 在访问控制和授权中发挥作用，确保只有授权用户才能与特定表交互。
- **与 Hive Server 2 集成（Integration with Hive Server 2）**：它与 Hive Server 2 紧密集成，向 HS2 提供有关表及其结构的信息。这种集成允许远程客户端通过 Hive Server 2 执行查询。

## Hive Server 2（HS2）

Hive Server 2 是远程客户端与 Hive 交互的主要接口，包含以下关键组件：

### Driver（驱动器）

此模块接收传入的查询并实现会话句柄，提供类似于 JDBC/ODBC 标准的执行和获取 API。

### Compiler（编译器）

负责解析查询，对查询块和表达式执行语义分析，并借助 Metastore 的表和分区元数据构建执行计划。编译器有以下阶段，在查询执行之前对给定查询进行解析和优化：

1. **解析（Parsing）**：此初始步骤将查询字符串转换为解析树表示。

2. **语义分析（Semantic Analysis）**：在解析器之后，语义分析器获取解析树并将其转换为内部查询表示，该表示保持基于块而非操作树。此阶段包括列名验证、扩展（如 `*`）、类型检查和隐式类型转换。如果查询涉及分区表，它会收集所有相关表达式以供后续分区修剪使用。此外，如果查询指定了采样，该信息也会被收集。

3. **逻辑计划生成（Logical Plan Generation）**：语义分析器的输出随后被转换为由操作树组成的逻辑计划。虽然一些操作是标准的关系代数运算符，如 'filter' 和 'join'，但 Hive 引入了特定的运算符进行进一步处理，例如在 map-reduce 边界处使用的 reduceSink 运算符。此阶段还包括优化过程以提高性能。转换可能涉及将多个 join 转换为单个多路 join，为 group-by 操作执行 map 端部分聚合，以及在处理倾斜数据分组键时以两个阶段执行 group-by 操作以避免潜在瓶颈。每个运算符都配备了一个描述符，这是一个可序列化的对象。

4. **查询计划生成（Query Plan Generation）**：在最后阶段，逻辑计划进一步转换为一系列 map-reduce 任务。操作树被递归遍历，分解为一组 map-reduce 可序列化任务。这些任务可以随后提交到 Hadoop 分布式文件系统的 map-reduce 框架。reduceSink 运算符作为 map-reduce 边界，包含归约键。这些归约键被用作 map-reduce 边界内的归约键。生成的计划保留了查询中指定样本和分区的信息，并被序列化并写入文件。

我们可以使用 `explain` 命令查看给定查询的计划，如下所示：

```sql
0: jdbc:hive2://localhost:10001/> explain
update transactional_managed_table set age=50 where id=2;

+----------------------------------------------------+
|                      Explain                       |
+----------------------------------------------------+
| Vertex dependency in root stage                    |
| Reducer 2 <- Map 1 (SIMPLE_EDGE)                   |
| Reducer 3 <- Map 1 (SIMPLE_EDGE)                   |
|                                                    |
| Stage-0                                            |
|   Move Operator                                    |
|     table:{"name:":"default.transactional_managed_table"} |
|     Stage-3                                        |
|       Dependency Collection{}                      |
|         Stage-2                                    |
|           Reducer 2 vectorized                     |
|           File Output Operator [FS_21]             |
|             table:{"name:":"default.transactional_managed_table"} |
|             Select Operator [SEL_20]               |
|               Output:["_col0"]                     |
|             <-Map 1 [SIMPLE_EDGE] vectorized       |
|               SHUFFLE [RS_18]                      |
|                 PartitionCols:UDFToInteger(_col0)  |
|                 Select Operator [SEL_16]           |
|                   Output:["_col0"]                 |
|                   Select Operator [SEL_15]         |
|                     Output:["_col0","_col2"]       |
|                     Filter Operator [FIL_14]       |
|                       predicate:(id = 2)           |
|                       TableScan [TS_0]             |
|                         ...                        |
|           Reducer 3 vectorized                     |
|           File Output Operator [FS_23]             |
|             ...                                    |
| Stage-1                                            |
|   Move Operator                                    |
|     ...                                            |
+----------------------------------------------------+
42 rows selected (4.206 seconds)
```

### Execution Engine（执行引擎）

执行编译后的计划，组织为阶段的有向无环图（DAG），管理阶段间的依赖关系，并在相关系统组件上执行它们。Hive 支持以下作为执行引擎：

- Apache Tez
- Map Reduce
- Spark（在 Hive 4 中已废弃）

我们可以通过配置设置执行引擎：`hive.execution.engine=tez`

以下是 HS2 的主要功能：

- **查询执行（Query Execution）**：Hive Server 2 通过编译和执行远程客户端的类 SQL 查询来处理它们。
- **并发访问（Concurrent Access）**：它支持多个查询的并发执行，允许多个用户同时使用 Hive。
- **安全性和认证（Security and Authentication）**：Hive Server 2 通过启用强大的认证和授权机制来增强 Hive 的安全性。
- **支持多种协议（Support for Various Protocols）**：它通过 ODBC、JDBC 和 Thrift API 提供可访问性，促进从多种编程语言和外部工具的交互。

## Hive 客户端：JDBC、ODBC、Beeline 和 Thrift

Hive 提供多种客户端接口来与其服务交互，满足不同用户的需求和偏好。让我们探索一些最常用的 Hive 客户端：

### Java 数据库连接（JDBC）

Hive JDBC 是一个基于 Java 的客户端，使 Java 应用程序能够连接到 Hive 并执行类 SQL 查询。它提供了一种编程方式将 Hive 功能集成到 Java 应用程序中。开发者可以使用 Hive 的 JDBC 驱动程序建立连接并无缝执行 HiveQL 查询。

### 开放数据库连接（ODBC）

Hive ODBC 是一个允许应用程序使用 ODBC 协议连接到 Hive 的接口。ODBC 在数据分析领域广泛使用，Hive ODBC 为应用程序（如 Microsoft Excel、Tableau 或其他 ODBC 兼容工具）提供了一种标准方法来访问和查询 Hive 数据。

### Beeline

Beeline 是一个命令行界面工具，提供了一种快速便捷的方式来使用类 SQL 命令与 Hive 交互。它是管理员、数据工程师和喜欢通过命令行界面使用 Hive 的分析师的有用工具。Beeline 提供用于执行查询的 shell，并支持脚本执行和批处理等附加功能。

### Thrift

Hive Thrift 是一组用于各种编程语言的客户端库。它为 Hive 提供了语言无关的绑定，使其可在各种编程环境中访问。这种灵活性允许开发者将 Hive 集成到他们偏好的语言或平台中。

每个 Hive 客户端都满足特定的用户需求和偏好。JDBC 适用于 Java 应用程序，ODBC 面向兼容 ODBC 协议的工具。Beeline 为快速交互提供命令行界面，而 Thrift 为多功能访问提供语言无关的客户端库。Hive 的客户端接口阵列确保用户可以以对其特定用例最方便和高效的方式使用 Hive。

总之，Hive Metastore（HMS）和 Hive Server 2（HS2）是 Hive 架构的不可或缺的组件。HMS 处理元数据存储和模式管理，而 HS2 作为远程客户端的网关，实现安全并发的查询编译、优化和执行。它们共同为用户提供了一个强大的框架，通过 Hive 客户端与 Hive 交互并分析数据。

## Hive 查询语言（HQL）

Hive 查询语言（HiveQL）支持一系列 SQL 操作，如 select、project、join、aggregate、union all 以及 FROM 子句中的子查询。此外，HiveQL 包含数据定义语言（DDL）语句，允许创建具有指定序列化格式、分区和分桶列的表。用户可以使用 load 和 insert 数据操作语言（DML）语句从外部源加载数据并将查询结果插入 Hive 表。需要注意的是，HiveQL 是 SQL-92、MySQL 和 Oracle SQL 方言的融合，兼容性随着时间的推移不断改善。受 MapReduce 启发的非标准扩展引入了多表插入和 `CLUSTER BY`、`DISTRIBUTE BY` 等子句。

> 本章不打算作为全面的 HiveQL 参考；相反，它专注于常用特性，特别关注与 SQL-92 或流行数据库（如 MySQL）不同的方面。如需详细参考，建议查阅 Hive 文档。

| 特性 | SQL | HQL（HiveQL） |
|------|-----|---------------|
| 语言风格 | 标准 SQL | SQL-92 + MySQL + Oracle 扩展 |
| 执行引擎 | 数据库引擎 | MapReduce / Tez / Spark |
| 数据存储 | 数据库文件 | HDFS / 对象存储 |
| 事务支持 | 完整 ACID | 有限 ACID（从 Hive 0.13 开始） |
| 更新/删除 | 原生支持 | 通过 ACID 表支持 |
| 索引 | B-Tree 等 | 有限支持 |

**表 4.1 和 4.2：Hive 查询示例及其 SQL 等价对照**

### 数据类型

Hive 包含广泛的数据类型，涵盖基本类型和复杂类型类别。基本类型包括数字、布尔、字符串和时间戳数据类型。值得注意的是，虽然 Hive 的基本类型与 Java 的类型有相似之处，但一些名称受到 MySQL 类型名称的影响，在某些情况下与 SQL-92 标准一致。

除了基本类型，Hive 还提供四种复杂数据类型：`ARRAY`、`MAP`、`STRUCT` 和 `UNIONTYPE`。ARRAY 和 MAP 类似于它们的 Java 对应物，而 STRUCT 表示能够封装命名字段的记录类型。UNIONTYPE 提供了一种指定数据类型选择机制，其中值必须精确匹配这些定义类型之一。

| 类型类别 | 数据类型 |
|----------|---------|
| 数字类型 | TINYINT, SMALLINT, INT, BIGINT, FLOAT, DOUBLE, DECIMAL |
| 字符串类型 | STRING, VARCHAR, CHAR |
| 日期/时间类型 | TIMESTAMP, DATE, INTERVAL |
| 布尔类型 | BOOLEAN |
| 复杂类型 | ARRAY, MAP, STRUCT, UNIONTYPE |

**表 4.3：Hive 数据类型列表**

## Hive 数据模型

Hive 中的数据模型结构如下：

### 表（Tables）

类似于关系数据库表，每个 Hive 表对应一个 HDFS 目录，其中数据以文件形式序列化和存储。表可以与各种序列化格式关联，包括内置格式，支持压缩和延迟反序列化。用户甚至可以在 Java 中创建自定义的序列化和反序列化方法（SerDe）。序列化格式存储在系统目录中，并在查询编译和执行期间自动使用。Hive 还支持用于存储在 HDFS、NFS 或本地目录中数据的外部表。

托管表适用于 Hive 需要对数据进行完全控制的情况，而外部表适用于数据需要被多个系统访问或保留在 Hive 影响之外的情况。根据你的数据管理需求选择合适的表类型。

### 分区（Partitions）

表可以有一个或多个分区，定义数据如何在表目录的子目录中分布。例如，如果表 T 在列 ds 和 ctry 上分区，具有特定 ds 值（例如 20090101）和 ctry 值（例如 US）的数据将存储在类似 `/T/ds=20090101/ctry=US/` 的目录中的文件中。

### 分桶（Buckets）

在每个分区内，数据可以根据表列的哈希值进一步划分为桶。每个桶作为分区目录中的一个文件存储。

Hive 支持各种数据类型，包括基本类型（如整数、浮点数、字符串、日期和布尔值）以及可嵌套的集合类型（如数组和映射）。用户还可以以编程方式定义自定义数据类型。

### 创建分区和分桶表

你可以使用 `CREATE TABLE` 命令和 `PARTITIONED BY` 及 `CLUSTERED BY` 子句在 Hive 中创建分区和分桶表。例如：

```sql
CREATE TABLE customer_data (
    customer_id INT,
    name STRING,
    purchase_amount DOUBLE
)
PARTITIONED BY (country STRING)
CLUSTERED BY (customer_id) INTO 4 BUCKETS;
```

在此示例中，`customer_data` 表按 country 列分区，按 customer_id 列分桶为 4 个桶。这种结构优化了数据存储和检索，以提高查询性能。

**示例文件结构**：

HDFS 结构可能如下所示：

```
customer_data/
└── country=USA/
    ├── bucket_00000
    ├── bucket_00001
    └── …
└── country=Canada/
    ├── bucket_00000
    ├── bucket_00001
    └── …
└── …
```

## Hive 中的托管表和外部表

Hive 是一个构建在 Hadoop 上的强大数据仓库和查询工具，提供两种主要的表类型：托管表和外部表。此外，Hive 为这些表类型提供了事务型和仅插入型的变体，每种都有其独特的特性。理解这些表类型之间的区别对于 Hive 中的高效数据管理和查询处理至关重要。

### 托管表（Managed Tables）

托管表，也称为内部表，是 Hive 中的基本概念。当你创建托管表时，Hive 假定对数据的完全控制。它拥有数据的生命周期，关联的数据文件通常存储在 Hive 仓库目录中。以下是托管表的关键特征：

- **所有权（Ownership）**：Hive 完全拥有数据，包括存储和维护。
- **数据存储（Data Storage）**：数据存储在 Hive 特定的目录中，通常位于 Hive 仓库路径下。
- **数据生命周期（Data Lifecycle）**：当你删除托管表时，元数据和关联的数据都会被删除。
- **用例（Use Case）**：托管表适用于 Hive 管理整个数据生命周期的场景，包括加载、转换、压缩、事务、锁和归档。它们通常用于结构化数据存储和管理。

创建托管表：

```sql
CREATE TABLE managed_table (
    id INT,
    name STRING,
    age INT
) TBLPROPERTIES ('transactional' = 'true');
```

### 外部表（External Tables）

外部表，顾名思义，是引用存储在 Hive 控制之外的数据的表。对于外部表，Hive 仅维护元数据和模式信息，而数据保留在其原始位置。以下是你需要了解的关于外部表的信息：

- **所有权（Ownership）**：Hive 不控制数据，仅控制元数据和模式。
- **数据存储（Data Storage）**：数据文件位于外部位置，可以在 HDFS、远程服务器或任何兼容的存储系统上。
- **数据生命周期（Data Lifecycle）**：在 Hive 中删除外部表仅删除元数据，而将实际数据保留在外部位置。要删除实际数据，需要设置：`"external.table.purge"="true"`
- **用例（Use Case）**：外部表在你希望 Hive 与由外部进程或系统管理的数据交互时非常有用。它们非常适合数据不断由外部工具生成或处理的场景，你希望 Hive 能够查询它而不移动或复制数据。

创建外部表：

```sql
CREATE EXTERNAL TABLE external_table (
    id INT,
    name STRING,
    age INT
)
ROW FORMAT DELIMITED
FIELDS TERMINATED BY ','
LOCATION '/user/hive/external_data/';
```

在上述示例中，`EXTERNAL` 关键字表示这是一个外部表，`LOCATION` 参数指定数据存储在 Hive 外部的目录。

### 事务型托管表（Transactional Managed Tables）

Hive 引入了事务型托管表来管理数据一致性和持久性。这些表在数据完整性至关重要的场景中特别有用。以下是事务型托管表的一些特征：

- **原子操作（Atomic Operations）**：事务型表支持 ACID（原子性、一致性、隔离性、持久性）事务，确保即使在并发查询存在的情况下也能保持数据一致性。
- **数据压缩（Data Compaction）**：它们支持压缩以解决小文件问题，这可能导致查询处理效率低下。

创建 ACID 表：

```sql
CREATE TABLE transactional_managed_table (
    id INT,
    name STRING,
    age INT
)
CLUSTERED BY (id) INTO 4 BUCKETS
STORED AS ORC TBLPROPERTIES ('transactional'='true');
```

### 仅插入型托管表（Insert-Only Managed Tables）

仅插入型托管表是托管表的一种变体，优化了数据加载。它们适用于数据持续追加但不更新或删除的场景。关键特性包括：

- **高效插入（Efficient Inserts）**：仅插入型表允许高效的数据摄取，使其非常适合不断添加新数据的用例。

创建仅插入型表：

```sql
CREATE TABLE insert_only_managed_table (
    id INT,
    name STRING,
    age INT
)
TBLPROPERTIES ('transactional'='true', 'transactional_properties'='default', 'insert_only'='true');
```

![[Pasted image 20260517215601.png]]
*图 4.3：流程图 — Hive 表类型*

### 在托管表和外部表之间选择

使用托管表还是外部表（无论是事务型还是仅插入型）的决定取决于你的特定用例和数据管理需求。如果你希望 Hive 控制数据生命周期并确保数据一致性，托管表（特别是事务型）是合适的选择。另一方面，如果你需要 Hive 查询存储在别处的数据而不移动或更改它，外部表是正确选择。仅插入型托管表在你持续有数据摄取需求时是理想选择。

本节提供了创建、管理和使用这些表类型的见解，确保你可以根据数据存储和查询需求做出明智的决策。

## Hive ACID（原子性、一致性、隔离性、持久性）

Hive ACID 是一个重要的特性，它为 Hive 中的数据操作提供了原子性、一致性、隔离性和持久性。它确保 Hive 操作在发生故障、并发事务或其他异常情况下维护数据的完整性。Hive 中的 ACID 事务主要与托管表一起使用。

直到 Hive 0.13，原子性、一致性和持久性在分区级别提供。隔离性可以通过开启可用的锁机制（ZooKeeper 或内存）来提供。随着 Hive 0.13 中事务的添加，现在可以在行级别提供完整的 ACID 语义，因此一个应用程序可以添加行而另一个应用程序从同一分区读取，互不干扰。从那时起，该特性一直在不断更新。

以下是 Hive ACID 关键方面的详细说明：

- **原子性（Atomicity）**：Hive ACID 事务保证原子性。这意味着事务中的操作序列被视为单个不可分割的单元。事务中的所有操作要么全部成功完成，要么全部不执行。

- **一致性（Consistency）**：Hive ACID 确保数据在事务结束时保持一致状态。如果事务尝试写入无效数据或违反表的约束，它将失败，事务内所做的更改将被回滚。

- **隔离性（Isolation）**：Hive ACID 提供隔离性，确保一个事务的操作不会干扰另一个事务。事务彼此隔离运行，防止脏读或丢失更新等问题。

- **持久性（Durability）**：一旦事务成功提交，其更改是永久的。即使在系统故障或崩溃的情况下，已提交事务所做的更改也保持完整。

Hive ACID 通过使用分桶、基于时间戳的冲突检测、写入序列化和隔离级别等属性来实现这些保证。Hive 中的 ACID 表是支持这些保证的更高级特性。

创建 ACID 表：

```sql
CREATE TABLE acid_table (
    id INT,
    name STRING
) STORED AS ORC TBLPROPERTIES ('transactional'='true');
```

在上述示例中，`STORED AS ORC` 子句指定存储格式，`TBLPROPERTIES` 将表属性 `transactional` 定义为 `true`，表示此表支持 ACID 事务。

在 Hive ACID 表中，数据分为三种主要类型的文件：base 文件、delta 文件和 delete delta 文件。

- **Base 文件**：Base 文件包含表中的原始数据。这些文件是不可变的，意味着它们一旦写入就不会被修改。当新数据插入 ACID 表时，它最初被写入 base 文件。Base 文件对于维护表中所有更改的历史记录至关重要。

- **Delta 文件**：Delta 文件是在 ACID 表中更新或删除记录时创建的。每个 delta 文件包含对 base 文件的一组更改。Delta 文件是仅追加的，意味着新更改会持续添加到它们中。它们帮助维护更新和删除的历史记录，而不修改原始 base 文件。

- **Delete Delta 文件**：Delete delta 文件，顾名思义，存储有关已删除记录的信息。这些文件帮助跟踪哪些记录不再有效，应该从查询结果中排除。Delete delta 文件与 base 文件和 delta 文件协同工作，以确保数据一致性。

其过程如下：

1. 当执行更新或删除操作时，会创建一个 delta 文件来记录这些更改。
2. 如果记录被删除，delete delta 文件包含已删除记录的 ID。
3. 查询表时，Hive 同时考虑 base 文件和 delta 文件，通过应用 delta 文件中记录的更改来确保检索正确的数据。

这种机制允许在 Hive ACID 表中高效查询和维护数据完整性。它还促进了压缩等操作，压缩将 delta 文件合并为更大的、更易管理的文件，以优化查询性能。

Hive ACID 表在你需要在并发写入操作、批处理和复杂数据操作的场景中维护数据一致性和完整性时特别有用。对于数据质量和可靠性至关重要的数据仓库和应用程序来说，这是一个关键特性。

## 使用 Hive Compaction 处理小文件问题

"小文件问题"是大数据处理系统（如 Hive）中的常见挑战。当数据被分成大量小文件时，每个文件包含相对较少的数据量，就会发生这种情况。这可能有以下几个问题：

- **存储效率低下（Inefficient Storage）**：存储许多小文件消耗更多存储资源，并可能导致磁盘使用效率低下。
- **查询性能缓慢（Slow Query Performance）**：查询大量小文件会显著减慢查询性能，因为它涉及打开和关闭文件进行处理，造成开销。
- **元数据开销（Metadata Overhead）**：每个文件都关联元数据，大量小文件的元数据可能变得难以管理。

Hive 通过称为 compaction（压缩）的过程提供了对小型文件问题的解决方案。Compaction 是将小文件合并为较大文件的过程，减少 HDFS 中的文件数量。这在处理频繁进行 `INSERT`、`UPDATE` 或 `DELETE` 操作的表时特别有价值，这些操作可能导致大量小文件的产生。

### Hive Compaction

Compaction 是将小文件合并为较大文件的过程，减少 HDFS 中的文件数量。这在处理频繁进行 `INSERT`、`UPDATE` 或 `DELETE` 操作的表时特别有价值，这些操作可能导致大量小文件的产生。

### Compactor

Compactor 是运行在 Metastore 内部的一组后台进程，支持 ACID 系统。它由 Initiator（启动器）、Worker（工作器）、Cleaner（清理器）和其他几个组件组成。

### Delta 文件压缩

随着操作修改表，越来越多的 delta 文件被创建，需要进行压缩以维持足够的性能。Hive 提供两种类型的压缩：**minor compaction** 和 **major compaction**。

**Minor Compaction（小压缩）**：Minor compaction 获取一组现有的 delta 文件，并将其重写为每个桶的单个 delta 文件。Minor compaction 在分区级别将小文件合并为较大的文件，这有助于提高分区级别的查询性能。它涉及合并相对较少的文件，并基于配置参数自动启动。

```sql
ALTER TABLE your_table_name COMPACT 'MINOR';
```

**Major Compaction（大压缩）**：Major compaction 获取一个或多个 delta 文件和该桶的 base 文件，并将其重写为每个桶的新 base 文件。Major compaction 更昂贵但更有效。它们将大量小文件合并为更大的、更优化的文件。Major compaction 通常运行频率较低，但对表的整体文件结构有更显著的影响。

```sql
ALTER TABLE your_table_name COMPACT 'MAJOR';
```

所有压缩都在后台完成。Minor 和 major compaction 不会阻止对数据的并发读取和写入。在压缩后，系统等待旧文件的所有读者完成，然后删除旧文件。

Hive compaction 有四个主要部分：

- **Initiator（启动器）**：此模块负责发现哪些表或分区需要进行压缩。应在 Metastore 中使用 `hive.compactor.initiator.on=true` 启用。每个压缩任务处理一个分区（如果表未分区，则处理整个表）。如果给定分区的连续压缩失败次数超过 `hive.compactor.initiator.failed.compacts.threshold`，自动压缩调度将停止对此分区。

- **Worker（工作器）**：每个 Worker 处理一个单独的压缩任务。压缩是一个 MapReduce 作业，名称格式为 `compaction-<id>`。每个 Worker 将作业提交到集群（通过 `hive.compactor.job.queue`，如果已定义）并等待作业完成。`hive.compactor.worker.threads` 确定每个 Metastore 中 Worker 的数量。Hive 仓库中 Worker 的总数决定最大并发压缩数。

- **Cleaner（清理器）**：这是一个在压缩后并在确定不再需要它们后删除 delta 文件的进程。

- **AcidHouseKeeperService**：此进程查找在 `hive.txn.timeout` 时间内未发送心跳的事务并中止它们。系统假定启动事务的客户端停止心跳并崩溃，其锁定的资源应该被释放。

### Hive Compaction 的好处

- **提高查询性能（Improved Query Performance）**：将小文件合并为较大的文件可以显著提高查询性能。
- **高效存储（Efficient Storage）**：压缩通过创建更优化的文件大小来减少存储开销。
- **减少元数据开销（Reduced Metadata Overhead）**：更少的文件意味着更少的元数据开销，使其更易于管理。
- **数据清理（Data Cleanup）**：在压缩期间启用自动清理有助于删除旧的和过时的数据，降低存储成本。

Hive compaction 是解决小文件问题和优化 Hive 表性能和存储效率的重要工具，特别是在数据变更频繁的场景中。正确配置和管理 compaction 可以显著提高 Hive 的性能和资源利用率。

## Hive LLAP：低延迟分析处理

Hive LLAP（Low Latency Analytical Processing）是 Hive 中的一个关键特性，旨在加速查询性能并改善交互式查询的用户体验。它克服了 Apache Hive 的历史局限性，Hive 最初是为批处理优化的。

### Hive LLAP 的关键特性

- **交互式查询性能（Interactive Query Performance）**：Hive LLAP 旨在提供低延迟的交互式查询体验。它通过对数据子集使用内存处理来实现，允许近乎实时的查询响应。

- **动态工作负载管理（Dynamic Workload Management）**：Hive LLAP 采用动态工作负载管理，这意味着它可以在查询执行时高效地分配资源。这种灵活性对于处理来自多个用户的并发交互式查询至关重要。

- **内存缓存（In-Memory Caching）**：LLAP 的一个显著特性是其能够将经常访问的数据缓存到内存中。这意味着重复查询所需的数据可以直接从内存提供，显著减少 I/O 操作并提高查询响应时间。

- **增强的 Hive Tez 执行（Enhanced Hive Tez Execution）**：Hive LLAP 与 Apache Tez 执行引擎集成，进一步增强了其性能。Tez 以其对复杂有向无环图（DAG）的优化执行而闻名，这些 DAG 通常由高级 Hive 查询生成。

- **细粒度数据访问（Fine-Grained Data Access）**：使用 Hive LLAP，可以进行细粒度的数据访问。它仅读取特定查询所需的数据，避免了扫描整个数据集的需要，这对于大规模数据处理来说可能非常耗时。

### Hive LLAP 的用例

Hive LLAP 适用于低延迟查询至关重要的场景，例如：

- **即席数据分析（Ad Hoc Data Analysis）**：需要交互式探索和分析数据的数据分析师和科学家可以从 Hive LLAP 的低延迟特性中受益。
- **商业智能（BI）工具（Business Intelligence Tools）**：Hive LLAP 与需要快速查询响应以创建报告和仪表板的 BI 工具兼容。
- **探索性数据分析（Exploratory Data Analysis）**：从事探索性数据分析的数据科学家和工程师，Hive LLAP 加速了假设检验和数据验证的过程。
- **操作仪表板（Operational Dashboards）**：需要实时或近实时数据洞察的应用程序和仪表板可以利用 Hive LLAP 进行更快的更新。
- **并发用户环境（Concurrent User Environments）**：多个用户运行并发查询的环境可以从 Hive LLAP 的动态资源分配中受益，确保所有用户都能获得高效的查询性能。

### 配置和优化

要从 Hive LLAP 中受益，需要配置和资源分配。微调 LLAP 守护进程设置、内存管理和启用缓存对于实现最佳性能至关重要。

Hive LLAP 显著增强了 Hive 在交互式数据分析方面的性能，为希望以低延迟查询响应探索和分析其大数据的组织提供了更具竞争力的选择。它使 Hive 更接近传统数据库系统，使其成为各种用例的多功能工具。

## Hive 用户自定义函数（UDF）

Hive 用户自定义函数（UDF）是一个强大的特性，通过允许用户创建可在 Hive SQL 查询中使用的自定义函数来扩展 Hive 的功能。UDF 使你能够封装复杂逻辑或对你的数据执行专门的操作，使其更加多功能并适用于特定的用例。本节探讨 Hive UDF、如何创建它们以及它们的应用。

### 理解 Hive UDF

Hive UDF 是用户可以用 Java 或其他支持的编程语言开发的自定义函数。这些函数可以应用于 Hive 查询中的一个或多个列，以转换、过滤或生成数据。UDF 可以接受一个或多个输入参数，并返回单个值或复杂结构，如数组或结构体。当内置的 Hive 函数不能满足你的特定需求时，它们特别有用。

Hive UDF 可以分为三种主要类型：

- **标量 UDF（Scalar UDFs）**：这些 UDF 在单个输入行上操作，执行转换或计算。例如，你可以创建一个 UDF 来计算数字的平方根。

- **聚合 UDF（Aggregate UDFs）**：这些 UDF 在多行上工作并返回单个值，通常用于汇总任务。例如，创建一个 UDF 来计算一组值的平均值。

- **通用 UDF（Generic UDFs）**：这些 UDF 提供更大的灵活性，因为它们可以接受和返回复杂数据类型。它们适用于广泛的用例，并允许用户实现自定义逻辑。

### 创建和注册 Hive UDF

要创建 Hive UDF，你需要按以下步骤操作：

1. **编写 UDF 代码**：你可以用支持的编程语言（如 Java）开发你的 UDF。确保根据 UDF 类型实现必要的方法，如 `evaluate()`。
2. **编译 UDF**：编译你的 UDF 代码以生成包含 UDF 类的 JAR 文件。
3. **注册 UDF**：在 Hive 中，你需要通过使用 `ADD JAR` 命令将 UDF 添加到 Hive 会话中来注册它。此步骤使 UDF 可在 Hive 查询中使用。
4. **在查询中使用 UDF**：注册 UDF 后，你可以在 Hive SQL 查询中使用它对你的数据执行自定义操作。

### Hive UDF 的应用

Hive UDF 有各种应用，包括但不限于：

- **数据转换（Data Transformation）**：你可以创建 UDF 来在存储或分析之前清理、规范化或操作数据。
- **自定义聚合（Custom Aggregations）**：当内置聚合函数不够用时，UDF 可以实现自定义聚合逻辑的开发。
- **复杂数据解析（Complex Data Parsing）**：UDF 可用于从非结构化或半结构化数据中解析和提取特定信息。
- **机器学习（Machine Learning）**：在 UDF 中实现自定义机器学习算法以进行高级分析。
- **地理空间分析（Geospatial Analysis）**：开发用于地理空间操作的 UDF，如计算距离或执行基于位置的查询。

总之，Hive UDF 是一个有价值的特性，通过允许用户创建根据其特定需求定制的自定义函数来扩展 Hive 的能力。它们对于在 Hive 查询中执行复杂操作、聚合和数据操作至关重要。

## Hive 在 Hadoop 技术栈中的位置

![[Pasted image 20260517215612.png]]
*图 4.4：包含 Hive 的 Hadoop 技术栈*

Hive 是 Hadoop 生态系统中的数据仓库和类 SQL 查询语言工具。它在 Hadoop 技术栈中占据重要位置，如下所示：

- **存储层（Storage Layer）**：Hive 运行在 Hadoop 分布式文件系统（HDFS）或其他兼容的分布式存储系统上。它提供了一种结构化的方式来在这些存储系统中存储和组织数据。

- **查询和数据处理层（Query and Data Processing Layer）**：Hive 允许用户使用称为 HiveQL（HQL）的类 SQL 语言查询和分析数据。它将 HiveQL 查询转换为一系列 MapReduce 或 Tez 作业进行数据处理。这种与 Hadoop 处理能力的集成使其处于数据处理层。

- **数据仓库和分析（Data Warehousing and Analytics）**：Hive 通常用于数据仓库和分析。用户可以定义模式、表，并对大数据集执行 ETL（提取、转换、加载）操作。它提供了一种对大数据执行即席查询和分析的方法，使其成为数据分析师和商业智能任务的重要组成部分。

- **元数据管理（Metadata Management）**：Hive 包含一个 Metastore 来管理模式和表元数据。此 Metastore 在存储和维护 Hive 表定义方面也至关重要。

总之，Hive 通过为大数据提供高级查询语言和结构化数据管理，在 Hadoop 生态系统中发挥着关键作用。它充当 Hadoop 存储层和处理层之间的桥梁，使其成为 Hadoop 技术栈中用于数据仓库、分析和查询的基础组件。

## Part II：实践

## Tez 和 Apache Hive 动手实践

在本小节中，我们将在 Docker 容器中搭建 Apache Hive 和 Tez，以运行在 Hadoop 集群上，共享 Metastore，并使用 Tez 作为执行引擎。

### 安装

根据我们之前的设置，我们将修改步骤 6 和步骤 7，在 Docker 容器中下载和安装 Tez。

**步骤 1：下载并解压 Tez 和 Apache Hive Tar 文件**

在本节中，我们将使用以下版本的 Hadoop、Hive 和 Tez，这些是撰写本书时的最新兼容版本：

- hadoop-3.3.1
- apache-tez-0.10.2
- apache-hive-4.0.0-alpha-2-bin

我们将从预构建的 Tez 二进制文件设置 Tez，可从以下地址下载：
https://tez.apache.org/releases/apache-tez-0-10-2.html

我们将从预构建的 Hive 二进制文件设置 Hive，可从以下地址下载：
https://dlcdn.apache.org/hive/hive-4.0.0-alpha-2/apache-hive-4.0.0-alpha-2-bin.tar.gz

**步骤 2：更新 bootstrap 脚本，设置 Tez 到 classpath，安装 MySQL 用于 HMS，复制 Hive 配置**

我们将更新 `bootstrap.sh` 脚本以设置 Tez 环境变量并将 Tez 添加到 Hadoop classpath。

我们还将安装 MySQL 来设置 HMS 并复制 Hive 配置。

我们还将为 Hive 用户设置用户组并启动服务。

以下是完整的 Dockerfile，供参考，也可在第 4 章的 Git 仓库中获取：
https://github.com/ava-orange-education/Big-Data-Analytics-with-Apache-Hadoop-Ecosystem/tree/main/Chapter-4

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

# 步骤 6：下载 hadoop-3.3.1、tez 0.10.2 和 hive-4.0.0-alpha-2 并解压
RUN wget https://dlcdn.apache.org/hadoop/common/hadoop-3.3.1/hadoop-3.3.1.tar.gz
RUN tar -xvzf hadoop-3.3.1.tar.gz
RUN ln -sf /hadoop-3.3.1 /hadoop

RUN wget https://archive.apache.org/dist/tez/0.10.2/apache-tez-0.10.2-bin.tar.gz
RUN tar -xvzf apache-tez-0.10.2-bin.tar.gz
RUN ln -sf /apache-tez-0.10.2-bin /tez

RUN wget https://dlcdn.apache.org/hive/hive-4.0.0-alpha-2/apache-hive-4.0.0-alpha-2-bin.tar.gz
RUN tar -xvzf apache-hive-4.0.0-alpha-2-bin.tar.gz
RUN ln -sf /apache-hive-4.0.0-alpha-2-bin /hive

RUN wget https://repo1.maven.org/maven2/mysql/mysql-connector-java/8.0.28/mysql-connector-java-8.0.28.jar
RUN apt-get -y install mysql-server mysql-client libmysql-java
RUN apt-get -y clean all && rm -rf /tmp/* /var/tmp/*

# 步骤 7：复制配置文件和 bootstrap 脚本
RUN mkdir /conf
COPY core-site.xml /conf/core-site.xml
COPY hdfs-site.xml /conf/hdfs-site.xml
COPY hadoop-env.sh /conf/hadoop-env.sh
COPY hive-site.xml /conf/hive-site.xml
COPY bootstrap.sh /bootstrap.sh

# 步骤 8：创建用户
RUN sudo addgroup hadoop
RUN sudo adduser --ingroup hadoop hadoop
RUN sudo addgroup hive
RUN sudo adduser --ingroup hive hive
RUN sudo usermod -a -G hadoop hive

# HDFS 端口
EXPOSE 1004 1006 8020 9866 9867 9870 9864 50470 9000 50070 9870

# YARN 端口
EXPOSE 8030 8031 8032 8033 8040 8041 8042 8088 10020 19888

# SOCKS 端口
EXPOSE 1180

# HDFS datanode
EXPOSE 9866

# MySQL 端口
EXPOSE 3306
```

**步骤 3：构建 Docker 镜像、启动容器并登录到容器**

克隆本书的 GitHub 仓库，导航到第 4 章。

Docker 构建：

```bash
docker build -t analytics-with-hadoop-hive ./
```

启动 Docker 容器：

```bash
docker run --rm -t --name analytics-with-hadoop-hive --hostname localhost -P \
  -p9866:9866 -p10000:10000 -p10001:10001 -p10002:10002 \
  -p8088:8088 -p9000:9000 -p9870:9870 -p8000:8000 -p3306:3306 \
  -p50070:50070 -p50030:50030 -it -d analytics-with-hadoop-hive \
  /bin/bash -c "/bootstrap.sh >/tmp/boostrap.log"
```

登录到容器：

```bash
docker exec -it analytics-with-hadoop-hive "/bin/bash"
```

**步骤 4：启动 Beeline 并执行简单查询以验证设置**

恭喜你运行了第一个 Hive 查询！

## 查询数据

本节深入探讨 Hive 中的 SQL 查询，Hive 是构建在 Hadoop 上的强大数据仓库和查询工具。Hive 的 SQL 能力涵盖数据检索、数据修改（DML）和数据定义（DDL）操作。

从用于数据检索的基本 `SELECT` 语句到用于数据操作的高级操作（如 `INSERT`、`UPDATE`、`DELETE` 和 `MERGE`），我们涵盖了 DML 的广度。此外，我们还深入探讨 DDL 任务，如表创建、修改、重命名和截断。

Hive SQL 使用户能够使用熟悉的 SQL 语法处理大数据，使其成为数据管理、分析和报告的重要工具。本节提供了全面指南，帮助你充分利用 Hive 中的 SQL。

**创建表**：

```sql
CREATE TABLE employees (
    emp_id INT,
    emp_name STRING,
    emp_salary DOUBLE
);
```

**说明**：此查询用于在 Hive 中创建名为 `employees` 的新表。该表有三列：整数数据类型的 emp_id、字符串数据类型的 emp_name 和双精度数据类型的 emp_salary。

**插入数据**：

```sql
INSERT INTO TABLE employees VALUES
(1, 'Alice', 65000.0),
(2, 'Bob', 75000.0),
(3, 'Charlie', 60000.0);
```

**说明**：此查询将数据插入 `employees` 表。它指定每列的值用于多行。

**查询数据**：

```sql
SELECT emp_name, emp_salary FROM employees;
```

**说明**：此查询从 `employees` 表中检索特定列 emp_name 和 emp_salary。

**更新数据**：

```sql
UPDATE employees SET emp_salary = 70000.0 WHERE emp_id = 3;
```

**说明**：此查询更新 emp_id 等于 3 的员工的工资。

**删除数据**：

```sql
DELETE FROM employees WHERE emp_id = 2;
```

**说明**：此查询从表中删除 emp_id 等于 2 的特定记录。

**排序数据**：

```sql
SELECT emp_name, emp_salary FROM employees ORDER BY emp_salary DESC;
```

**说明**：此查询检索员工姓名和工资，并按工资降序排序。

**聚合数据**：

```sql
SELECT AVG(emp_salary) AS avg_salary, MAX(emp_salary) AS max_salary FROM employees;
```

**说明**：此查询计算所有员工的平均工资和最高工资。

**连接表**：

```sql
CREATE TABLE departments (dept_id INT, dept_name STRING);
INSERT INTO TABLE departments VALUES (1, 'HR'), (2, 'IT');
SELECT e.emp_name, d.dept_name
FROM employees e
JOIN departments d ON e.emp_id = d.dept_id;
```

**说明**：这套查询演示了表创建、数据插入和表连接。它检索员工姓名及其各自的部门名称。

**子查询**：

```sql
SELECT emp_name FROM employees
WHERE emp_salary > (SELECT AVG(emp_salary) FROM employees);
```

**说明**：此查询包含一个子查询来过滤数据。它检索工资高于所有员工平均工资的员工姓名。

**创建视图**：

```sql
CREATE VIEW high_earners AS
SELECT emp_name, emp_salary FROM employees WHERE emp_salary > 60000.0;
```

**说明**：此查询创建一个名为 `high_earners` 的视图。视图是一个保存的查询结果，行为类似于虚拟表。

### 数据操作语言（DML）查询

**使用 SELECT 插入数据**：

```sql
INSERT INTO TABLE employees SELECT 4, 'David', 72000.0;
```

**说明**：此 DML 查询通过从另一个源选择值来插入数据。

**合并数据（Upsert）**：

```sql
MERGE INTO employees AS target
USING temp_employees AS source
ON target.emp_id = source.emp_id
WHEN MATCHED THEN UPDATE SET target.emp_salary = source.emp_salary
WHEN NOT MATCHED THEN INSERT VALUES (source.emp_id, source.emp_name, source.emp_salary);
```

**说明**：`MERGE` 语句允许将数据从源表合并到目标表中。当基于 emp_id 匹配时更新现有员工的工资，如果没有找到匹配则插入新员工。

### 数据定义语言（DDL）查询

**重命名表**：

```sql
ALTER TABLE employees RENAME TO staff;
```

**添加列**：

```sql
ALTER TABLE employees ADD COLUMNS (emp_department STRING);
```

**删除表**：

```sql
DROP TABLE IF EXISTS employees;
```

**截断表**：

```sql
TRUNCATE TABLE staff;
```

这些 DML 和 DDL 查询扩展了你在 Hive 中可以执行的操作范围。DML 查询实现数据操作和合并，而 DDL 查询允许对表进行结构更改和管理。

## Hive 服务：扩展 Hive 的实用性

`hive` 命令不仅仅是一个一维工具；它提供一系列服务，每个服务都服务于特定的功能。你可以通过使用 `--service` 选项指定要运行的服务。要发现可用的服务名称，只需输入 `hive --service help`。我们将探索一些最有价值的服务：

- **CLI（命令行界面）**：这是默认服务，即 Hive shell，允许你通过命令和查询与 Hive 交互。

- **HiveServer 2**：通过作为暴露 Thrift 服务的服务器运行，进一步扩展了 Hive 的能力。它使各种不同编程语言编写的客户端能够与 Hive 交互。HiveServer 2 通过引入对认证的支持和启用多用户并发来增强原始 HiveServer。如果你的应用程序使用 Thrift、JDBC 或 ODBC 连接器，你需要 HiveServer 2。你可以设置 `hive.server2.thrift.port` 配置属性来指定监听端口（默认是 10000）。

- **Beeline**：为 Hive 提供命令行界面，以嵌入模式工作，类似于常规 CLI。此外，它可以通过 JDBC 连接到 HiveServer 2 进程。这种灵活性确保你可以以对你的特定需求最方便的方式访问 Hive。

- **HWI（Hive Web Interface）**：HWI 提供了一个简单的 Web 界面，作为 CLI 的替代方案。当你想要与 Hive 交互而无需安装客户端软件时，它是一个有价值的选择。对于那些寻求更高级 Web 界面的人来说，Hue 是另一个选项，为 Hadoop 应用程序提供广泛的功能，包括运行 Hive 查询和浏览 Hive Metastore。

- **Jar 服务**：jar 服务的功能类似于 `hadoop jar`，提供了一种便捷的方式来运行 Java 应用程序。它在 classpath 中包含 Hadoop 和 Hive 类，使得执行与 Hive 集成的 Java 应用程序更加容易。

- **Metastore 服务**：默认情况下，Metastore 在与 Hive 服务相同的进程中运行。然而，使用 Metastore 服务，你可以将 Metastore 作为独立的远程进程运行。你可以设置 `METASTORE_PORT` 环境变量或使用 `-p` 命令行选项来指定服务器的监听端口（默认是 9083）。这允许你独立管理 Metastore，提供更大的灵活性和控制。

这些 Hive 服务丰富了你的 Hive 体验，提供了多种交互和访问方式，每种都针对特定的用例和偏好进行了定制。

## 创建简单的 Hive UDF 用于 Word Count

Hive 中的用户自定义函数（UDF）允许你通过编写自定义代码来扩展其数据处理功能。在本小节中，我们将引导你创建一个基本的 UDF 来计算文本数据的单词计数。

### 1. 编写 UDF Java 代码

首先，为你的 UDF 创建一个 Java 类。以下是一个 Java UDF 示例，用于计算文本字符串中的单词：

```java
import org.apache.hadoop.hive.ql.exec.UDF;
import org.apache.hadoop.io.Text;

public class WordCountUDF extends UDF {
    public int evaluate(Text text) {
        if (text == null) {
            return 0;
        }
        String inputText = text.toString();
        String[] words = inputText.split(" ");
        return words.length;
    }
}
```

在这个 UDF 中，我们接受一个 Text 输入，检查是否为 null，按空格拆分文本，并将单词计数作为整数返回。

### 2. 编译 UDF

编译 Java 代码以生成包含 UDF 类的 JAR 文件。确保你的 classpath 中有必要的 Hive 和 Hadoop 库以便成功编译。

### 3. 注册 UDF

在 Hive 中，使用以下命令注册你的 UDF JAR：

```sql
ADD JAR /path/to/WordCountUDF.jar;
```

### 4. 在 Hive 查询中使用 UDF

现在，你可以在 Hive 查询中使用 WordCountUDF 来计算文本数据的字数：

```sql
SELECT text_column, WordCountUDF(text_column) as word_count FROM your_table;
```

### 5. 执行查询

执行 Hive 查询，它将为指定列中的每个文本条目生成单词计数。

本节介绍了如何在 Hive 中创建一个简单的单词计数 UDF。请记住，你可以为各种文本处理任务创建更复杂的 UDF，以满足你的特定需求。

## ACID 表和 Compaction

在本节中，我们将逐步介绍配置 Hive、创建 ACID 表、插入数据、更新记录，以及监控在我们 Docker 设置中的 HDFS 中生成的 delete 和 delta 小文件的过程。然后我们将使用 Major 和 Minor compaction 来压缩 delta 文件。

要在 Hive 中创建 ACID 表，必须确保以下配置设置已正确定义：

- 设置 `hive.support.concurrency` 为 `true`。
- 设置 `hive.txn.manager` 为 `org.apache.hadoop.hive.ql.lockmgr.DbTxnManager`。

一旦这些配置就位，你可以使用以下命令创建 ACID 表：

```sql
CREATE TABLE transactional_managed_table (
    id INT,
    name STRING,
    age INT
)
CLUSTERED BY (id) INTO 4 BUCKETS
STORED AS ORC TBLPROPERTIES ('transactional'='true');
```

插入一些记录：

```sql
INSERT INTO transactional_managed_table VALUES (1, 'name', 10), (2, 'two', 20);
INSERT INTO transactional_managed_table VALUES (1, 'name', 10), (2, 'two', 20);
INSERT INTO transactional_managed_table VALUES (1, 'name', 10), (2, 'two', 20);
```

运行 SELECT 查询查看记录，并通过运行 `DESCRIBE FORMATTED` 验证这是一个托管表。

![[images/chapter-004/page345.png]]
*图：HDFS 中的 Delta 文件*

查询 HDFS，这里我们将看到三个 delta 文件，对应我们之前运行的三个 insert 查询。

![[images/chapter-004/page346.png]]
*图：更新后的 Delete 和 Delta 文件*

更新几条记录：当我们更新记录时，通过 delta 文件添加新记录，旧记录在 delete delta 文件中跟踪。

![[images/chapter-004/page347.png]]
*图：Major Compaction 后的 Base 文件*

检查 HDFS 并观察新的 delete 和 delta 文件。

让我们使用 major compaction 压缩这些小文件：

```sql
ALTER TABLE transactional_managed_table COMPACT 'MAJOR';
```

正如我们所看到的，许多小 delta 文件被压缩为单个大的 base 文件。这提供了以下好处：

- **提高查询性能（Improved Query Performance）**：将小文件合并为较大的文件可以显著提高查询性能。
- **高效存储（Efficient Storage）**：压缩通过创建更优化的文件大小来减少存储开销。
- **减少元数据开销（Reduced Metadata Overhead）**：更少的文件意味着更少的元数据开销，使其更易于管理。
- **数据清理（Data Cleanup）**：在压缩期间启用自动清理有助于删除旧的和过时的数据，降低存储成本。

## 结论

总之，本章全面探讨了 Apache Hive，它是 Hadoop 生态系统中的关键组件。从深入探讨基本架构方面到实际用例，讨论涵盖了 Hive 功能的广度。关键要点包括对 Hive 基础知识的细致理解，从其数据模型到 Hive 查询语言。本章细致地讨论了表类型，区分了托管表和外部表，并阐明了它们各自的特征和应用。Hive ACID 表的引入强调了它们在更新和删除期间确保数据一致性的重要作用。进一步的主题涵盖数据分区、分桶的优化潜力、查询增强技术以及各种 Hive 服务的概述。关于 Hive LLAP 的讨论强调了它在提升交互式分析场景查询性能方面的重要性。对 Hive compaction 的高层次探索揭示了它如何有效解决 HDFS 中的小文件挑战。本质上，本章通过强调 Hive 作为一个无缝桥接类 SQL 查询和大数据处理的工具的多功能性来结束。它强调了它对于数据分析师、工程师和科学家的不可或缺的角色，为熟练分析、查询和管理海量数据集提供了坚实的基础。读者将获得在各自的大数据工作中充分利用 Hive 潜力的知识。展望未来，本书承诺继续探索 Hadoop 生态系统中的重要组件，每个组件都有助于大规模数据的无缝处理和分析。在下一章中，我们将探索 Apache Spark。

## 练习

1. Hive 中使用的基本数据模型是什么？
2. 解释 Hive 中托管表和外部表的区别。
3. Hive 如何支持数据的 ACID（原子性、一致性、隔离性、持久性）属性？
4. 在 Hive ACID 表的上下文中，base 文件和 delta 文件是什么？
5. 描述 Hive 表中分区和分桶的好处。
6. 如何使用统计信息和向量化优化 Hive 查询？
7. Hive 为客户端交互提供哪些服务，它们如何使用？
8. Hive LLAP 的目的是什么，它如何增强查询性能？
9. 优化 Hive 性能需要考虑哪些基本配置设置？
10. 解释 HiveServer2 和 Beeline 在客户端-服务器交互中的角色。
11. 什么是低延迟分析处理（LLAP）框架，何时使用它有益？
12. 如何在 Hive 中创建托管表？提供一个示例查询。
13. 什么是 compaction？
14. compaction 有什么好处？
15. 解释 Hive 架构。
16. HMS 的角色是什么？
17. 什么是小文件问题？
18. 什么是 UDF？

## 答案

**A1**：Hive 的基本数据模型包括表、分区和桶。表对应 HDFS 目录，分区定义数据在子目录中的分布，桶基于列哈希进一步划分分区内的数据。

**A2**：托管表的数据完全由 Hive 管理（删除表时同时删除数据和元数据），而外部表仅由 Hive 管理元数据，数据保留在外部位置。

**A3**：Hive 通过 ACID 表支持事务，使用 base 文件、delta 文件和 delete delta 文件来跟踪数据更改，确保原子性、一致性、隔离性和持久性。

**A4**：Base 文件包含原始数据且不可变；Delta 文件记录更新和删除的更改。

**A5**：分区通过将数据划分为子目录提高查询性能，分桶通过哈希分布进一步优化数据分布和采样。

**A6**：通过使用 `ANALYZE TABLE` 收集统计信息，并使用 `hive.vectorized.execution.enabled=true` 启用向量化执行。

**A7**：Hive 提供 CLI、HiveServer2、Beeline、HWI 和 Metastore 服务，分别用于不同场景的客户端交互。

**A8**：Hive LLAP 通过内存缓存、动态工作负载管理和与 Tez 的集成，提供低延迟的交互式查询体验。

**A9**：包括 `hive.execution.engine`、`hive.support.concurrency`、`hive.txn.manager`、内存设置和压缩设置。

**A10**：HiveServer2 是暴露 Thrift 服务的服务器，支持远程客户端连接；Beeline 是命令行客户端，可通过 JDBC 连接到 HiveServer2。

**A11**：LLAP 是低延迟分析处理框架，使用内存缓存和持久化守护进程来加速查询，适用于交互式即席分析。

**A12**：`CREATE TABLE managed_table (id INT, name STRING) TBLPROPERTIES ('transactional'='true');`

**A13**：Compaction 是将 ACID 表中多个小 delta 文件合并为较大文件的过程，以提高查询性能和存储效率。

**A14**：提高查询性能、高效存储、减少元数据开销、数据清理。

**A15**：Hive 架构由 Hive Metastore（HMS）、Hive Server 2（HS2，包含 Driver、Compiler 和 Execution Engine）和多种客户端接口组成。

**A16**：HMS 是 Hive 元数据的中央仓库，存储表模式、分区信息和数据位置，并提供对这些信息的 API 访问。

**A17**：小文件问题是当数据被分成大量小文件时，导致存储效率低下、查询性能下降和元数据开销增加的问题。

**A18**：UDF（用户自定义函数）是用户自定义的扩展函数，可以在 Hive 查询中用于执行自定义的数据转换和计算。