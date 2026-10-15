---
title: 汀的知识碎片
---

<div class="homepage-header">
  <h1>关于我</h1>
  <p><strong>李浩鹏（汀）</strong> ｜ 基础设施研发 / SRE。现居北京，主要关注云原生沙箱运行时、分布式存储与计算集群、可观测体系与系统级性能工程。</p>
</div>

这里是我梳理系统认知与工程实践的数字花园。

我不是一个天生自律的苦行僧，骨子里甚至容易焦虑和眼高手低。从河南县城到郑州大学，从上海的金融核心系统压测与组件研发，再到北上接手大数据与 Agent 基础设施，支撑我一路敲代码与钻研的，往往不是宏大的职业叙事，而是从小就有的、对「事物底层究竟如何运转」的原始好奇。

大学时我习惯写「年记」来睹文思往；而在复杂的工程系统里，把知识骨架完整写下来，是我对抗信息过载与思维浮躁最踏实的方式。这里的专栏不搬运零散的速成笔记，也不做居高临下的布道，只记录我真正拆解过、在生产中踩坑验证过，或深入源码搞清楚的硬核机理——从 Linux 内核子系统与并发模型，到分布式协议、大数据引擎与现代沙箱隔离。

左侧导航按知识领域折叠，右上角提供全局检索，顶部设有随机碎片入口。主要专栏概览如下：

---

<div class="knowledge-section">
<h2>知识领域</h2>

<div class="knowledge-grid">

<div class="knowledge-card">
<h3>操作系统与底层原理</h3>
<div class="card-desc">内核机制与系统级性能工程</div>

- [[Linux/进程管理/00 专栏导览|进程生命周期与调度器]]
- [[Linux/内存管理/00 专栏导览|虚拟内存与 Slab 分配器]]
- [[Linux/文件系统/00 专栏导览|VFS、Page Cache 与 IO]]
- [[Linux/网络协议栈与IO/00 专栏导览|TCP/IP 协议栈与 epoll]]
- [[Linux/性能优化/00 专栏导览|Linux 性能优化体系]]
- [[Linux/系统性能工程实战/00 专栏导览|系统性能工程实战 · 15 篇]]
- [[Linux/KVM虚拟化与性能工程/00 专栏导览|KVM 虚拟化与性能工程 · 7 篇]]

</div>

<div class="knowledge-card">
<h3>编程语言与并发原理</h3>
<div class="card-desc">底层运行时机制与高并发工程实践</div>

- [[Golang/Go并发编程/00 专栏导览|Go GMP 调度与 Channel]]
- [[Golang/Go语言核心/00 专栏导览|Go 语言核心 · 数据语义与控制流]]
- [[Golang/Go运行时进阶与底层机制/00 专栏导览|Go 运行时 · 分配器与 GC]]
- [[Java/JVM/00 专栏导览|JVM 内存模型与 GC 算法]]
- [[Java/并发编程/00 专栏导览|JMM 与 AQS 并发锁原理]]
- [[数据结构与算法/排序与查找/00 专栏导览|数据结构与算法专栏]]

</div>

<div class="knowledge-card">
<h3>中间件与存储引擎</h3>
<div class="card-desc">数据存储、复制与高可用架构核心</div>

- [[中间件/MySQL/MySQL架构与底层原理/00 专栏导览|MySQL InnoDB 与 MVCC]]
- [[中间件/Redis/Redis设计与实现/00 专栏导览|Redis 数据结构与 Cluster]]
- [[中间件/Kafka/00 专栏导览|Kafka 分区机制与副本协议]]
- [[中间件/ETCD/00 专栏导览|ETCD 与 Raft 共识算法]]
- [[中间件/Ceph/00 专栏导览|Ceph 分布式存储引擎]]
- [[中间件/Clickhouse/00 专栏导览|ClickHouse 列式存储引擎]]
- [[中间件/Elasticsearch/00 专栏导览|Elasticsearch 倒排索引与集群]]
- [[中间件/Zookeeper/00 专栏导览|ZooKeeper 一致性与集群协调]]

</div>

<div class="knowledge-card">
<h3>分布式架构与大数据</h3>
<div class="card-desc">计算引擎、数据湖与分布式理论</div>

- [[分布式架构/分布式系统原理与协议/00 专栏导览|Paxos、Raft 与一致性模型]]
- [[分布式架构/数据密集型系统架构实战/00 专栏导览|数据密集型系统架构实战 · 15 篇]]
- [[大数据/Spark/Spark-RDD核心原理解析/00 专栏导览|Spark 核心原理与调优]]
- [[大数据/Flink/Flink原理深度解析与性能优化/00 专栏导览|Flink 状态管理与计算框架]]
- [[大数据/Hadoop/HDFS/00 专栏导览|HDFS NameNode 与数据节点]]
- [[大数据/Hadoop/Yarn/00 专栏导览|YARN 资源调度与容错]]
- [[大数据/HBase/00 专栏导览|HBase 分布式存储与调优]]
- [[大数据/数据湖/Iceberg/00 专栏导览|数据湖：Iceberg / Hudi / Paimon]]

</div>

<div class="knowledge-card">
<h3>云原生与容器编排</h3>
<div class="card-desc">K8s 架构、服务网格与容器运行时</div>

- [[云原生/Kubernetes/Kubernetes架构深度剖析/00 专栏导览|K8s 架构深度剖析 · 18 篇]]
- [[云原生/Kubernetes/kubernetes架构原则和对象设计/00 专栏导览|K8s 架构原则与对象设计]]
- [[云原生/Kubernetes/kubernetes之API Server/00 专栏导览|K8s API Server 深度解析]]
- [[云原生/Kubernetes/kubernetes控制器和调度器/00 专栏导览|K8s 控制器与调度器]]
- [[云原生/Kubernetes/kubernetes网络原理与插件/00 专栏导览|K8s 网络模型与 CNI 插件]]
- [[云原生/服务网格/00 专栏导览|Istio 服务网格与数据面]]
- [[云原生/Docker/00 专栏导览|Docker 容器与运行时]]
- [[云原生/云网络数据面与故障定位/00 专栏导览|云网络数据面与故障定位 · 7 篇]]

</div>

<div class="knowledge-card">
<h3>可观测性与 SRE</h3>
<div class="card-desc">监控、追踪、剖析与生产故障复盘</div>

- [[可观测/00 可观测性全景导览|可观测性全景导览]]
- [[可观测/指标/00 专栏导览|指标与 VictoriaMetrics]]
- [[可观测/日志/00 专栏导览|日志与 Grafana Loki]]
- [[可观测/链路追踪/00 专栏导览|链路追踪与 SkyWalking]]
- [[可观测/Profiler/00 专栏导览|持续性能剖析与 eBPF]]
- [[可观测/AIOps与可观测性实战/00 专栏导览|AIOps 与可观测性实战]]
- [[SRE/CVM集群可靠性工程/00 专栏导览|CVM 集群可靠性工程 · 8 篇]]
- [[SRE/故障排查与复盘/00 故障排查索引|故障排查与复盘索引]]

</div>

<div class="knowledge-card">
<h3>LLM 与 AI 工程</h3>
<div class="card-desc">Agent 沙箱技术、运行时范式与智能运维</div>

- [[LLM/Agent沙箱技术/00 专栏导览|Agent 沙箱技术 · 隔离与安全]]
- [[LLM/Coding-Agent运行范式/00 专栏导览|Coding-Agent 运行范式]]
- [[LLM/Agent开发技术/00 专栏导览|AI Agent 开发技术]]
- [[LLM/AiOps/00 专栏导览：大数据集群 SRE 的 AiOps 工程实践|AiOps 工程实践]]
- [[LLM/Hermes-Agent/00 专栏导览|Hermes-Agent]]
- [[LLM/LLM原理/00 专栏导览|大模型原理与架构]]

</div>

<div class="knowledge-card">
<h3>译书与精读</h3>
<div class="card-desc">英文技术书翻译、结构化精读与主题检索</div>

- [[译书/00 译书索引|译书书架总览]]
- [[译书/Linux/性能之巅/00 专览导读|Systems Performance / 性能之巅]]
- [[译书/Java/JVM-Performance-Engineering/_index|JVM Performance Engineering]]
- [[译书/云原生/Mastering-Kubernetes/_index|Mastering Kubernetes]]
- [[译书/分布式/Designing Data-Intensive Applications, 2nd Edition/1 数据系统架构中的权衡|Designing Data-Intensive Applications]]
- [[译书/分布式/Software Architecture - The Hard Parts/00 专栏导览|Software Architecture: The Hard Parts]]
- [[译书/SRE/97 Things Every SRE Should Know/00 前言|97 Things Every SRE Should Know]]
- [[译书/SRE/High Performance SRE Automation/00 专览导读|High Performance SRE Automation]]

</div>

</div>
</div>

---

## 怎么逛

这个知识库没有严格的阅读顺序，但如果你刚进来不知道从哪开始，可以试试这几条路线：

- **想看底层**：从 [[Linux/进程管理/00 专栏导览|进程管理]] 入手，顺着调度器 → 内存 → 文件系统 → 网络协议栈往下走，最后用 [[Linux/系统性能工程实战/00 专栏导览|系统性能工程实战]] 把它们串起来
- **想看分布式**：先读 [[分布式架构/分布式系统原理与协议/00 专栏导览|分布式系统原理与协议]] 打底，再进 [[分布式架构/数据密集型系统架构实战/00 专栏导览|数据密集型系统架构实战]] 看工程权衡
- **想看 K8s**：直接从 [[云原生/Kubernetes/Kubernetes架构深度剖析/00 专栏导览|K8s 架构深度剖析]] 的第一篇开始，18 篇按从设计哲学到生产化管理的顺序铺开
- **想看 AI 与 Agent**：从 [[LLM/Agent沙箱技术/00 专栏导览|Agent 沙箱技术]] 入手了解现代代码执行环境的隔离与安全方案，再看 [[LLM/AiOps/00 专栏导览：大数据集群 SRE 的 AiOps 工程实践|AiOps 工程实践]]
- **想看事故复盘**：去 [[SRE/故障排查与复盘/00 故障排查索引|故障排查索引]]，三个真实生产事故的完整复盘都在那
- **随便逛**：顶部菜单有随机碎片入口，碰上什么看什么
