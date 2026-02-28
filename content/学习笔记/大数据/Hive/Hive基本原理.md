### 一、Hive概述﻿

Hive是大数据时代中经典的数仓底层平台工具，主要用于利用其计算能力构建数仓基础表及ETL任务。

### 二、Hive的基本原理﻿

Hive目前并非主流计算引擎，但部分中大型公司仍在使用，主要因其迁移成本较高。Hive的设计理念有助于理解SQL执行引擎的演进逻辑，其应用场景和现存问题值得探讨。

#### 1.SQL on Hadoop﻿

Hive本质是SQL on Hadoop项目，旨在Hadoop生态中提供SQL服务。SQL的易用性推动了关系型数据库的普及，Hive通过以下两部分实现功能：

- 底层存储与计算引擎：依赖HDFS和MapReduce
- 上层查询处理器：负责SQL解析与执行计划生成

##### 1) SQL on Hadoop分类﻿

- Connector to Hadoop﻿

传统数据库通过Connector连接Hadoop，例如Oracle或Teradata可通过外部引擎查询HDFS数据，但实际计算仍由原数据库完成。

- SQL and Hadoop﻿

改造现有SQL引擎适配MapReduce，但因修改复杂度高，此类系统（如早期非知名项目）未能广泛应用。

- SQL on Hadoop﻿

专为Hadoop设计的全新SQL引擎，代表系统包括：

- Hive/Impala/Presto：MPP架构
- Spark SQL：基于RDD的无缝集成
- Drill/IBM BigSQL：多数据源支持

##### 2) Hive的产生﻿

- Hive作为数据仓库工具的介绍﻿

Hive是数仓构建工具，其核心功能包括：

- 结构化文件映射：将HDFS文件映射为表结构
- SQL接口支持：提供类SQL语法（HQL）
- Hive对结构化文件映射成表的支持

支持多种文件格式：

- 结构化格式：ORC/Parquet（内置Schema）
- 非结构化格式：Text/CSV（需内容符合二维表结构）
- Hive的SQL查询接口与MapReduce转换

执行流程：

- SQL解析：将HQL转换为逻辑计划
- 任务生成：翻译为MapReduce作业
- 结果输出：通过HDFS返回数据
- Hive的学习成本低与ETL统计分析应用

优势：

- 降低开发门槛：仅需掌握SQL语法
- 适用场景：ETL流水线（数据清洗/导入）与统计分析（报表生成）
- Hive的起源与贡献﻿

由Facebook开源并贡献至Apache基金会。

##### 3) Hive的特点﻿

- 基于SQL的语法特性﻿

兼容性：支持SQL-92标准并扩展SQL-2003语法。

- 基于Hadoop的可扩展性

依赖Hadoop生态，无需额外部署即可处理海量数据。

- 用户自定义函数（UDF）的延展性﻿

UDF扩展能力：支持开发自定义函数实现复杂业务逻辑（如数据加密/表拷贝）。

- Hadoop带来的容错性﻿

Hive的容错性依赖于Hadoop的容错机制。当MapReduce作业失败时，Hadoop会自动重试失败的task，确保SQL查询执行不被中断。Hive本身作为SQL到MapReduce的转换工具，其核心容错性由Hadoop保障。
此外，Hive还包含其他服务如HiveServer2和MetaStore，这些服务需要单独保证高可用性。Job执行的容错性主要通过Hadoop实现，而Hive服务层需额外部署高可用方案。

##### 4) Hive适用场景﻿

Hive最适合批处理作业（T+1模式），典型流程包括：

- 数据采集：每日日志写入HDFS
- 数据清洗：通过Hive转换原始日志为结构化表
- 统计分析：基于多表聚合生成汇总结果
- 批处理作业特征：
- 数据量大
- 延迟容忍度高
- 非实时性要求

不适用场景：

- 低延迟查询：分钟/秒级响应的场景因MapReduce执行效率不足而不适用
- 联机事务处理（OLTP）：
    - 传统增删改查操作
    - 事务支持有限（Hive - x后支持ACID但应用不广泛）

##### 5) 应用案例﻿

- 例题:word count实现

Hive实现WordCount的步骤：

- 建表：创建包含STRING类型字段token的表
```SQL
CREATE TABLE wordcount (token String);
LOAD DATA LOCAL INPATH 'wordcount/input' OVERWRITE INTO TABLE wordcount;
SELECT COUNT(*) FROM wordcount GROUP BY token;
```
- 加载数据：将本地文本文件导入表
- 统计计算：通过GROUP BY聚合token字段

关键说明：

- 输入文件需预处理为每行一个单词
- 分隔符可通过建表时指定（ROW FORMAT DELIMITED）

#### 2.Hive和Hadoop的关系﻿
![[Pasted image 20260128173702.png]]
##### 1) Hive运行在Hadoop之上，使用MapReduce执行计算

Hive作为Hadoop生态的上层工具，其计算引擎依赖MapReduce，数据存储基于HDFS。核心架构为Hive将SQL转换为MapReduce任务提交至Hadoop集群执行。

##### 2) Hive的组件：Driver运行在JVM中（Hiveserver2）﻿

Driver组件：

- 运行于独立JVM进程
- 负责SQL解析、优化与执行计划生成
- 触发的MapReduce任务每个Task对应独立JVM

##### 3) Hive的接口：Command Line和Web接口

Hive提供的访问接口：

- 命令行工具（CLI）：直接执行SQL语句
- Web UI：通过RESTful API交互

##### 4) Hive的接口：JDBC和ODBC接口﻿

标准化接口：

- JDBC/ODBC驱动：支持BI工具（如Beeline）连接
- 协议层：基于Thrift实现跨语言通信

##### 5) Hive的接口：Thrift Server﻿

Thrift Server作用：

- 为JDBC/ODBC提供底层通信协议
- 实现多语言客户端支持

##### 6) Hive的组件：Metastore服务﻿

MetaStore核心功能：

- 管理元数据（如表结构、字段类型）
- 支持独立部署（默认嵌入Derby，生产环境常用MySQL）

##### 7) Hive的组件：Metastore元数据存储

元数据存储实现：

- 持久化方案：MySQL等关系型数据库
- 服务化能力：提供表名解析、Schema校验等接口

#### 3.Hive版本﻿

##### 1) Hive与Hadoop的关系及HiveServer2的介绍﻿34:18﻿

HiveServer2特性：

- 长驻服务：避免每次查询启动新JVM
- 多会话支持：通过JDBC/ODBC并发连接

##### 2) Hive on Tez与Hive on Spark﻿35:20﻿

|   |   |   |
|---|---|---|
|执行引擎|优势|局限性|
|MapReduce|稳定性高|执行效率低|
|Tez|支持DAG任务调度|社区支持减弱|
|Spark|内存计算加速|兼容性问题（非官方主力支持）|

#### 4.实验环境﻿37:44﻿

##### 1) 本地Docker环境构建与Hive运行﻿37:48﻿

- 本地Docker环境可通过下载特定镜像快速构建，支持Hive运行。
- CDH集群环境默认已安装Hive，无需额外配置Docker环境。

##### 2) CDH机器环境与Hive访问方式﻿38:00﻿

- Hive访问方式：通过student账号直接登录集群机器执行hive命令。
- Hue网页版提供可视化Hive操作界面，支持SQL查询。

##### 3) Hue网页版Hive介绍与登录信息﻿38:15﻿

- Hue功能：网页版Hive工具，支持直接编写并执行SQL查询。
- 登录账号默认使用student账号及对应密码，需确认权限开通状态。

##### 4) MetaStore部署与Hive安装配置﻿39:49﻿

- Hive Metastore部署：在CDH版本中通过勾选即可完成，默认支持MySQL等数据库。
- 测试环境默认使用Derby数据库，生产环境需配置MySQL或其他关系型数据库。

##### 5) Hive配置与Hive Metastore访问﻿41:02﻿

- Hive配置核心文件为hive-site.xml，需通过classpath加载以访问Metastore。
- Spark等工具访问Metastore依赖解析该配置文件中的地址信息。

### 三、Hive初体验﻿41:55﻿

#### 1.Hive命令﻿41:58﻿

- 基础命令：show databases等SQL语法可直接在Hive CLI中执行。
- 命令列表为默认功能，无特殊技术点，需用户自行实践。

#### 2.Hive CLI使用﻿42:24﻿

##### 1) Hive命令示例﻿42:29﻿

- 调试参数：-v打印环境变量，-S屏蔽日志输出。
- 脚本执行：-f执行SQL文件，-e执行单条SQL语句（需引号包裹）。
- 变量定义：通过hivevar传递用户自定义变量，支持set命令动态配置参数。

#### 3.Hive系统架构﻿47:41﻿

- 核心模块：
    - Driver：包含编译器（SQL→抽象语法树→逻辑计划）、优化器（调整执行顺序）、执行器（生成物理计划）。
    - Metastore：独立服务，管理元数据。
- SQL执行流程：
    - 词法/语法分析生成抽象语法树（AST）。
    - 逻辑计划将AST转换为关系代数表达式（如Join顺序）。
    - 物理计划绑定具体数据源（如HBase表、JSON文件）及连接方式（如Map Join、Sort Merge Join）。
- 优化重点：优化器调整Join顺序以提升性能，最终生成MapReduce任务提交至Hadoop集群。

##### 1) 与传统数据库的对比﻿57:24﻿

与传统数据库相比，Hive在架构设计上具有高度相似性。传统数据库通常包含以下核心组件：

- 语法定义层：每种数据库均定义专属DSL（领域特定语言），例如MySQL、Oracle在标准SQL基础上扩展方言。
- 解析器（Parser）：将SQL语句转换为抽象语法树（AST），树形结构便于后续优化与执行。
- 逻辑计划与优化器：AST进一步转换为逻辑计划树，经优化器调整后生成物理执行计划树。
- 执行引擎与存储：物理计划分发至执行引擎，结合存储后端完成计算。

Hive的核心流程与传统数据库一致，差异仅在于：

- 存储层：采用HDFS替代传统存储。
- 执行引擎：默认使用MapReduce，但可替换为Spark、Flink等。

后续课程将以Spark为例详细讲解解析器、逻辑计划、优化器等模块的通用实现原理。

#### 4.问题回答﻿01:01:18﻿

##### 1) 执行器、翻译器、优化器使用树结构的原因﻿01:01:19﻿

SQL执行器采用树结构的主要原因包括：

- 高效搜索与遍历：树形结构（如B+树）支持二分查找等高效算法，便于快速定位优化节点。
- 剪枝优化便利性：树可退化为链表结构，便于移除冗余节点（如左/右子树退化）。
- 代码可读性与递归实现：树的层次结构清晰，通过递归遍历简化代码逻辑，优于栈或队列等结构。

注意：执行计划树不要求为完全二叉树，实际场景中单侧子树（如全左子树）常见。

##### 2) Hive系统架构﻿01:08:24﻿

### 四、Hive系统架构详解﻿01:08:47﻿

#### 1.Hive CLI与Driver功能详解﻿01:08:49﻿

Hive CLI启动时加载以下组件至同一JVM：

- 命令行接口：提供交互式输入输出功能，解析用户输入（如SET命令）。
- Driver模块：集成编译器、优化器与执行器，完成SQL语句的完整处理流程。

#### 2.Hive CLI 命令示例﻿01:09:56﻿

#### 3.Hive Server服务详解﻿01:11:06﻿

Hive Server作为长期运行服务（Long-running Service）的核心特性：

- 端口监听：默认绑定10000端口，通过主函数进入持久化监听状态。
- 协议支持：对外提供JDBC/ODBC协议接口，允许远程客户端连接。

#### 4.Hive Server的JDBC/ODBC协议与Session管理﻿01:12:02﻿

JDBC/ODBC协议栈与Driver的交互机制：

- Session隔离：每个客户端连接创建独立Session，维护用户级SQL上下文。
- 操作封装：JDBC将SQL语句封装为Operation对象，经Thrift协议传输至Driver执行。
- Thrift协议：Hive Server内置Thrift框架，实现跨语言RPC通信。

#### 5.Hive Server的Swift协议与Driver调用﻿01:14:01﻿

Swift是Hive Server专用的通信协议。JDBC协议中的会话管理和操作指令会通过Swift协议进行反编译解析。Swift内部包含服务端组件，能将操作指令转换为特定Swift定义，再进一步转换为底层Driver调用。该过程均在同一个JVM（Hive Server 2）中完成。

#### 6.Hive Metastore服务详解﻿01:14:50﻿

Hive Metastore作为独立服务运行，通常监听10001端口并以常驻进程形式存在。当前Hive架构中，Metastore服务通过Hive Server对外暴露接口，其运行环境为独立JVM。查询Metastore可通过Hive Server间接连接，该实现方式属于标准架构设计。

### 五、操作封装定义﻿01:16:19﻿

#### 1.operation的定义与示例﻿01:16:23﻿

Operation是Hive对数据操作的抽象封装，典型示例包括：

- GetTableOperation（获取表信息）
- ListPartitionOperation（列举分区）
- SQL执行操作（单条语句也可封装为独立Operation）

#### 2.JDBC协议与API封装﻿01:16:48﻿

JDBC协议规范定义了两类核心API接口：

- executeQuery（查询操作）

executeUpdate（更新操作）

- 这些接口在Hive中会转换为不同类型的Operation实现。

#### 3.Hive中的operation类型﻿01:17:27﻿

#### 4.HiveConnection与JDBC接口﻿01:18:37﻿

HiveConnection实现了标准JDBC接口，主要包含：

- executeQuery（处理SELECT类查询）

executeUpdate（处理DDL/DML操作）

- 具体实现可参考Hive源码中的JDBC协议实现类。

#### 5.executeQuery与executeUpdate接口﻿01:19:30﻿

不同JDBC接口调用会生成不同类型的Operation：

- executeQuery生成查询类Operation（如SELECT）

executeUpdate生成更新类Operation（如CREATE/INSERT）

- 具体实现细节需查阅HiveStatement相关源码。

#### 6.HiveStatement与结果集处理﻿01:20:32﻿

HiveStatement继承自JDBC标准Statement类，位于org.apache.hive.jdbc包。其核心功能包括：

- 执行SQL并返回ResultSet
- 处理更新操作的返回值
- 资源释放管理

#### 7.JDBC传统接口与结果集﻿01:21:06﻿

|   |   |   |
|---|---|---|
|接口方法|功能说明|返回类型|
|executeQuery|执行查询语句|ResultSet|
|executeUpdate|执行更新操作|影响行数|
|close|释放资源|无返回值|

#### 8.Hive底层操作转换与执行计划概念﻿01:21:42﻿

执行计划本质是SQL语句的树状执行流程描述。以SELECT * FROM t1 WHERE a=6为例：

- 逻辑计划包含Projection（select）、Filter（where）、Relation（from）三个节点
- 执行顺序遵循从叶子节点（Relation）到根节点（Projection）的拓扑排序
- 计划价值在于明确各操作间的依赖关系与执行时序

### 六、问题答疑﻿01:23:17﻿

### 七、投影概念﻿01:25:13﻿

Projection（投影）是关系代数中的基本操作，对应SQL中的SELECT子句。关键特性包括：

- 需要基于已有数据集进行列筛选
- 在执行计划中通常作为最终操作节点
- 与Filter操作存在严格先后依赖关系

### 八、Hive系统架构﻿01:26:31﻿

#### 1.用户接口﻿01:27:02﻿

Relation与表的核心区别在于：

- 表是静态数据实体
- Relation包含数据读取方式（如JSON文件解析规则）
- 执行计划中的Relation节点实质是数据扫描（Scan）操作的抽象描述。

#### 2.部署方式﻿01:35:15﻿

部署方式在实际应用中重要性较低，主要原因是当前环境中Hive使用频率下降。部署方式仅需了解基本概念即可，无需深入掌握具体部署操作。

##### 1) 内嵌模式﻿01:35:37﻿

- 内嵌模式将Hive所有组件封装在单个JVM中运行
- 核心组件包括内置Derby数据库、HiveStore线程和Driver
- 外部依赖支持访问HDFS或本地磁盘
- 执行限制：必须依赖Hadoop环境才能运行MapReduce任务
- 典型应用场景：Docker测试环境或快速验证场景

##### 2) HiveServer2﻿01:37:19﻿

- 服务架构：通过JDBC/ODBC接口提供远程访问能力
- 核心组件包含HiveServer服务进程和内置Derby数据库
- 与CLI模式区别在于采用客户端-服务端架构
- 协议支持：使用Thrift框架实现跨语言通信
- 测试环境适配：支持本地开发测试部署

##### 3) Remote MetaStoreServer﻿01:38:28﻿

- 架构特点：将元数据服务独立部署为远程服务
- 组件分离：CLI客户端与MetaStore服务解耦
- 服务缩写：HMS（Hive MetaStore）为通用简称
- 协议支持：元数据访问同样基于Thrift框架实现

### 九、Hive系统架构与传统数据库的对比﻿01:38:45﻿

|   |   |   |
|---|---|---|
|对比维度|Hive架构|传统数据库|
|元数据管理|独立MetaStore服务|内置元数据存储|
|访问协议|Thrift RPC框架|专用二进制协议|
|服务组件|HiveServer2分离|单体服务架构|
|执行引擎|MapReduce依赖|专用查询引擎|

### 十、MapReduce实现SQL的过程﻿01:40:47﻿

SQL到MapReduce的转换本质是计算等价性证明过程。语法树生成后通过特定算法转换为MapReduce任务链，该转换机制是Hive区别于传统数据库的核心技术特征。

#### 1.Join的实现原理﻿01:41:27﻿

Join操作转换通过MapReduce的Shuffle阶段实现数据重分布。关键步骤包括：

- Map阶段标记数据来源（左表/右表）
- Shuffle阶段按Join Key哈希分发数据
- Reduce阶段完成记录关联与结果输出
- 特殊处理：外连接需补充NULL值标记

##### 1) 例题:用户表Join示例﻿01:42:19﻿

|   |   |   |   |
|---|---|---|---|
|处理阶段|左表(user)|右表(order)|输出结果|
|Map输出|(1,apple)|(1,101)|(1,[L:apple])|
|||(1,102)|(1,[R:101])|
|Shuffle后|||(1,[L:apple,R:101])|
|Reduce输出|||(apple,101)|

#### 2.GroupBy的实现原理﻿01:48:31﻿

- 分组本质：按指定列值组合进行数据分区
- 分组粒度：GroupBy列数越多分组越精细
- 执行过程：
    - Map阶段提取分组键
    - Shuffle阶段按键值分发
    - Reduce阶段完成聚合计算
- 语法特性：支持按列序号指定分组字段

##### 1) 例题:City表GroupBy示例﻿01:51:01﻿

- 原始数据表仅包含city表，需执行group by操作时需进行map reduce处理
- map阶段处理流程：将大表拆分为若干部分，每组数据按rank和is_online字段分组
    - 示例数据组1包含两条相同key（AA）的记录，value为2（用于后续count统计）
    - 示例数据组2包含不同key（A1B0、A1A0），仅当所有group by字段完全相同时才会归为一组
- shuffle阶段：将相同key的数据聚合传输
- reduce阶段输出：对相同key的数据进行统计输出，示例中AA组输出值为3（原记录值有误，应为3而非2）

#### 3.Distinct的实现原理﻿01:55:01﻿

#### 4.SQL转化为MapReduce的过程﻿01:56:06﻿

- 解析阶段：通过ANTLR2完成SQL词法分析与语法分析，生成抽象语法树
- 语义转换：将抽象语法树转换为Hive专属的查询块（query block）
- 逻辑计划生成：遍历查询块生成操作树（operator tree），即逻辑执行计划
- 逻辑优化：对operator tree进行合并、优化等操作
- 物理计划转换：将优化后的operator tree翻译为MapReduce任务链（job chain）
    - 重要说明：复杂SQL可能生成多个MapReduce job，示例中简单join/group by仅展示单job场景

### 十一、Hive编译器﻿02:00:02﻿

- 编译流程：
    - 词法分析生成抽象语法树 - 逻辑分析转换为查询块（query block） - 遍历查询块生成操作树（operator tree） - 逻辑优化器处理得到优化后的operator tree
    - 物理计划生成器输出任务树（task tree），即最终可执行的MapReduce job链

### 十二、Hive实现原理﻿02:01:01﻿

核心机制：将HiveQL通过operator tree转换为物理计划，关键步骤在于物理计划生成阶段通过特定操作符实现MapReduce任务构建

### 十三、Hive内部操作﻿02:01:40﻿

|   |   |   |
|---|---|---|
|操作类型|对应Operator|功能说明|
|表扫描|TableScanOperator|处理原始表数据读取|
|Reduce聚合|ReduceSinkOperator|实现group by等聚合操作|
|表连接|JoinOperator|执行两表关联操作|
|结果输出|FileSinkOperator|处理insert overwrite等输出操作|
|小表映射连接|MapJoinOperator|优化小表join场景|
|结果限制|LimitOperator|实现limit子句功能|

### 十四、SQL解析细节﻿02:03:55﻿

#### 1.SQL分析执行的4个步骤

#### 2.语法解析与元数据绑定案例﻿02:04:24﻿

元数据绑定应用案例：通过ANTLR实现RESTful接口转换系统，将前端自定义API调用转换为Elasticsearch查询语法。核心流程包括：

- 自定义语法规则描述前端接口
- 生成中间抽象语法树
- 转换为目标系统可执行的API调用
- 典型场景：解决异构系统间API语法不兼容问题

### 十五、策略优化﻿02:07:52﻿

Spark Pre Store等技术对学习有帮助，但当前讲解深度不足，后续Spark课程会深入探讨。需建立整体思考流程的框架性认识。

### 十六、Hive存储和表管理﻿02:08:06﻿

- 核心概念包括：partition分区与bucket分桶机制，此为后续高级用法的基础
- 重点讲解内容：join操作原理与列式存储格式Parquet，后者将单独设置加餐课程
- Hive优化章节当前重要性降低，因相关优化策略已普遍应用于各类SQL与多库系统

### 十七、Hive优化器支持的几条优化﻿02:09:10﻿

Hive优化策略具有跨系统普适性，在多数SQL及多库系统中均存在类似实现。基础优化内容仍需讲解，拓展部分视进度安排。

### 十八、Parquet结构﻿02:10:02﻿

Parquet并非Spark专用存储格式，已成为多引擎通用列式存储标准。

#### 1.Parquet的普遍应用与内存加速﻿02:10:10﻿

Parquet被主流引擎（如Presto）广泛采用，仅特定系统（如Kylin/ClickHouse）会使用专属存储格式。Apache Arrow等框架通过Parquet实现内存加速。

#### 2.es的应用场景与大数据应用﻿02:10:50﻿

|   |   |   |
|---|---|---|
|场景类型|适用性|技术优势|
|检索与日志分析|核心应用领域|实时检索能力突出|
|大数据处理|非典型场景|文本处理仍具不可替代性|

#### 3.hive与spark的优化器：RBO与CBO﻿02:11:25﻿

|   |   |   |   |
|---|---|---|---|
|优化器类型|实现机制|典型系统|适用阶段|
|RBO(Rule-Based)|基于预设规则|Hive/Spark默认|逻辑计划生成|
|CBO(Cost-Based)|基于代价估算|Oracle/Teradata|物理计划优化|

#### 4.执行计划：课程学习与实际应用﻿02:12:41﻿

执行计划深度解析存在教学平衡难点：需兼顾学员认知水平与知识完整性。源码研究阶段需重点掌握逻辑/物理执行计划，但短期课程以建立基础认知为主。

#### 5.NIO模型在大数据中间件的应用﻿02:13:59﻿

NIO模型主要应用于分布式系统的IO处理模块，典型实现包括：

- Kafka的消息传输层
- HBase的存储交互层
- Spark/Hive的文件系统操作

#### 6.Spark与Hive的存储过程﻿02:14:45﻿

- Spark原生不支持存储过程，业界已逐步脱离传统数据库模式
- Hive存储过程应用有限，主流实践更倾向使用Spark生态工具
- 历史版本兼容性：Spark - 8前版本依赖Hive但无存储过程支持

#### 7.执行计划对SQL编写的重要性﻿02:16:02﻿

执行计划认知直接影响SQL编写质量：

- 优化器存在局限性，无法完全修正低效SQL
- 资深开发者需掌握执行计划分析以预判性能瓶颈
- 课程内容已固化，执行计划深度解析将结合具体引擎特性展开