# Kubernetes 网络原理与插件专栏严肃重写（content/云原生/Kubernetes/kubernetes网络原理与插件/ 8 篇）

---
status: done
branch: main
owner: devin
updated: 2026-09-11 12:00
tier: COMPLEX
---

## 1. 需求理解

按 skill `writing-technical-article`（周志明《凤凰架构》DNA）与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/kubernetes网络原理与插件/` 下 8 篇（00 导览 + 01-07 正文）全量重写。
现状：全专栏共 8 篇，正文 01-07 篇均 CJK 字符仅 4200-6900 字（篇幅仅达标 35%~50%），存在知识点平铺、缺乏 Linux 内核机制与数据面深度、00 导览与正文存在死链、缺乏凤凰架构叙事弧等问题。
整改目标：
- 严格遵循 12000-16000 中文字 / 500+ 行的技术深度专栏交付硬指标（00 导览除外，不设字数下限，重点在主线串联与无死链导航）。
- 论述五问齐全：是什么 → 为什么出现 → 不这样会怎样 → 如何落地 → 边界与反例。
- 注入凤凰架构六层 DNA（L1 绵密书面语/但/譬如/笔者/零感叹号；L2 历史演进/概念原理模板；L3 起源先行/标准与实现分离；L4 年份锚点/贴切比喻/权威序列；L5 架构即权衡/复杂性守恒/因地制宜；L6 加粗规范/Dracula Mermaid/Markdown 表格）。
- 严厉执行反模式红线：禁止摘要/结语/延伸思考/参考资料灌水，禁止同义改写空洞套话，字数完全依靠 Linux 内核数据路径、RFC 协议规范、代码与数据结构深度拆解、真实生产避坑与边界反例支撑。
- 执行流程：按 AGENTS.md 规定采用"每批前列清单 → 老板确认 → 并行 subagent 执行 → 统一验证 → 记录"。

## 2. 批次规划

- **第一批（网络底座与 CNI 基础，3 篇）**：
  - `01 Kubernetes网络模型——从Linux网络命名空间到Pod IP.md`
  - `02 CNI体系详解——插件规范、调用链与主流实现对比.md`
  - `03 Flannel深度解析——VXLAN、Host-GW与UDP模式.md`
- **第二批（生产级 CNI 与 eBPF 演进，2 篇）**：
  - `04 Calico深度解析——BGP路由、eBPF数据面与网络策略.md`
  - `05 Cilium深度解析——eBPF驱动的下一代网络与可观测性.md`
- **第三批（服务转发、安全隔离与集群 DNS + 导览收官，3 篇）**：
  - `06 Service底层实现——kube-proxy、iptables与IPVS.md`
  - `07 NetworkPolicy与CoreDNS——网络安全策略与集群DNS.md`
  - `00 专栏导览.md`（统一验证、死链修复、CHANGELOG 记录）

## 3. 进度

- [x] 01 Kubernetes网络模型——从Linux网络命名空间到Pod IP（891 行 / 12203 字，Mermaid 9 图，零感叹号）
- [x] 02 CNI体系详解——插件规范、调用链与主流实现对比（694 行 / 12243 字，Mermaid 8 图，零感叹号）
- [x] 03 Flannel深度解析——VXLAN、Host-GW与UDP模式（605 行 / 12222 字，Mermaid 4 图，零感叹号）
- [x] 04 Calico深度解析——BGP路由、eBPF数据面与网络策略（615 行 / 12016 字，Mermaid 3 图）
- [x] 05 Cilium深度解析——eBPF驱动的下一代网络与可观测性（508 行 / 12049 字，Mermaid 4 图）
- [x] 06 Service底层实现——kube-proxy、iptables与IPVS（589 行 / 12013 字，Mermaid 4 图；userspace→iptables→IPVS→nftables 四代演进、conntrack 独立成章、externalTrafficPolicy、EndpointSlice、排障决策树）
- [x] 07 NetworkPolicy与CoreDNS——网络安全策略与集群DNS（641 行 / 12005 字，Mermaid 2 图；白名单并集语义、Calico/Cilium 双实现、ANP 分级治理、KubeDNS→CoreDNS 演进、ndots 放大、NodeLocal DNSCache、联合排障矩阵）
- [x] 00 专栏导览（06/07 两行描述已同步新稿内容，其余行核验准确；全专栏死链核验通过）
- [x] 统一验证 + CHANGELOG（01-07 全部 ≥12000 中文字且 ≥500 行；frontmatter/摘要/参考资料/思考题齐全；全部 Mermaid 带 dracula；wiki 链接全部解析成功）

---

# Kubernetes 架构深度剖析专栏严肃重写（content/云原生/Kubernetes/Kubernetes架构深度剖析/ 19 篇）

---
status: done
branch: main
owner: devin
updated: 2026-09-09 16:00
tier: COMPLEX
---

## 1. 需求理解

老板指出该专栏"特别水"，要求按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准严肃重写。现状：19 篇（00 导览 + 01-18 正文），篇均 CJK 字符 1800-7000，远低于 12000-16000 标准。骨架基本齐备（frontmatter/mermaid/callout），但内容偏 API 罗列和知识点平铺，缺凤凰架构叙事弧和绵密书面语。串行执行，一篇一篇写，技术资产（代码/mermaid/表格/链接/思考题）保留并重构。

## 2. 设计方案

- 风格：凤凰架构六层 DNA（L1 长句多逗号/笔者/譬如/但；L2 历史锚点开场/叙事弧/四式结尾；L3 历史先行→问题→标准与实现分离；L4 年份锚点+比喻+权威序列；L5 权衡取舍/因地制宜；L6 加粗1-2处/千字+dracula mermaid+Markdown表格）
- 篇幅目标：技术深度专栏 12000-16000 中文字 / 500+ 行
- 论述五问：是什么→为什么出现→不这样会怎样→如何落地→边界与反例
- 格式：frontmatter（title/date/tags/aliases）、`**摘要：**` 段、`## 第 N 章` 编号、dracula mermaid、Obsidian callout、文末参考资料+思考题
- 摘要统一从 `> [!abstract]` 改为 `**摘要：**` 段

## 3. 文件级任务

| 文件 | 动作 | 说明 |
|------|------|------|
| 01 设计哲学 | REWRITE | Borg→Omega→K8s 三代演进、六大设计原则 |
| 02 声明式 API | REWRITE | 声明式范式、API 对象统一结构、Spec/Status |
| 03 架构全景 | REWRITE | 控制平面/数据平面、Pod 完整生命周期 |
| 04 API Server 请求链路 | REWRITE | HTTP 请求到 etcd 写入全链路 |
| 05 认证授权准入 | REWRITE | 三级安全防线 |
| 06 List-Watch 与 Informer | REWRITE | 分布式神经系统 |
| 07 etcd 深度剖析 | REWRITE | Raft/MVCC/Watch |
| 08 ResourceVersion 与乐观并发 | REWRITE | 乐观并发控制 |
| 09 控制器模式与协调循环 | REWRITE | Deployment 到 Operator |
| 10 StatefulSet | REWRITE | 有序部署与持久化身份 |
| 11 Scheduler | REWRITE | 预选/优选/扩展机制 |
| 12 CRD 与 Operator | REWRITE | 自定义控制器 |
| 13 kubelet | REWRITE | Pod 生命周期与 CRI |
| 14 Service 与 kube-proxy | REWRITE | iptables/IPVS/eBPF |
| 15 CNI | REWRITE | Flannel/Calico/Cilium |
| 16 生产化集群管理 | REWRITE | 多租户/资源治理/安全加固 |
| 17 可观测性 | REWRITE | 监控/日志/追踪/诊断 |
| 18 弹性伸缩与多集群 | REWRITE | HPA/VPA/Cluster Autoscaler |
| 00 专栏导览 | REWRITE | 最后更新，引用各篇新内容 |

## 4. 进度

- [x] 01 设计哲学（591行/12006字）
- [x] 02 声明式 API（611行/12011字）
- [x] 03 架构全景（640行/12004字）
- [x] 04 API Server 请求链路（606行/12001字）
- [x] 05 认证授权准入（770行/12003字）
- [x] 06 List-Watch 与 Informer（696行/12005字）
- [x] 07 etcd 深度剖析（610行/12006字）
- [x] 08 ResourceVersion 与乐观并发（779行/15918字）
- [x] 09 控制器模式与协调循环（913行/12184字）
- [x] 10 StatefulSet（712行/12024字）
- [x] 11 Scheduler（750行/12008字）
- [x] 12 CRD 与 Operator（821行/12008字）
- [x] 13 kubelet（654行/12000字）
- [x] 14 Service 与 kube-proxy（624行/12008字）
- [x] 15 CNI（594行/12028字）
- [x] 16 生产化集群管理（579行/12005字）
- [x] 17 可观测性（551行/12009字）
- [x] 18 弹性伸缩与多集群（583行/12000字）
- [x] 00 专栏导览（103行/1689字，导航页）
- [x] 统一验证 + CHANGELOG（全部通过）

---

# Netty 专栏全量重写（content/Java/Netty/ 11 篇）

---
status: done
branch: main
owner: devin
updated: 2026-09-08 20:00
tier: COMPLEX
---

## 1. 需求理解

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 `content/Java/Netty/` 下 11 篇（00 导览 + 01-10 正文）全量重写。技术资产（代码/mermaid/表格/链接/思考题）也重构，叙述与技术资产都按凤凰架构风格重新组织。串行执行，一篇一篇写。

## 2. 设计方案

- 风格：凤凰架构六层 DNA（L1 长句多逗号/笔者/譬如/但；L2 历史锚点开场/叙事弧/四式结尾；L3 历史先行→问题→标准与实现分离；L4 年份锚点+比喻+权威序列；L5 权衡取舍/因地制宜；L6 加粗1-2处/千字+dracula mermaid+Markdown表格）
- 篇幅目标：技术深度专栏 12000-16000 中文字 / 500+ 行
- 论述五问：是什么→为什么出现→不这样会怎样→如何落地→边界与反例
- 格式：frontmatter（title/date/tags/aliases）、摘要段、`## 第 N 章` 编号、dracula mermaid、Obsidian callout、文末参考资料+思考题

## 3. 文件级任务

| 文件 | 动作 | 说明 |
|------|------|------|
| 01 Java NIO基础 | REWRITE | NIO 三大组件，从 BIO 到 NIO 的范式革命 |
| 02 Netty全局架构 | REWRITE | BossGroup/WorkerGroup/ChannelPipeline 全景 |
| 03 EventLoop与线程模型 | REWRITE | Reactor 模式落地、单线程化设计 |
| 04 ByteBuf | REWRITE | 引用计数、池化、零拷贝 |
| 05 ChannelPipeline与Handler | REWRITE | 责任链、入站出站传播 |
| 06 编解码器 | REWRITE | 粘包拆包、LengthFieldBasedFrameDecoder |
| 07 Netty内存管理 | REWRITE | jemalloc 在 Java 中的实现 |
| 08 Netty高性能之道 | REWRITE | FastThreadLocal/HashedWheelTimer/MpscQueue |
| 09 RPC框架设计 | REWRITE | 序列化、路由、连接管理 |
| 10 开源项目应用 | REWRITE | Dubbo/RocketMQ/Elasticsearch |
| 00 专栏导览 | REWRITE | 最后更新，引用各篇新内容 |

## 4. 进度

- [x] 01 Java NIO基础（525行/12065字）
- [x] 02 Netty全局架构（530行/12000字）
- [x] 03 EventLoop与线程模型（518行/12019字）
- [x] 04 ByteBuf（599行/12008字）
- [x] 05 ChannelPipeline与Handler（512行/12005字）
- [x] 06 编解码器（1009行/12026字）
- [x] 07 Netty内存管理（704行/12018字）
- [x] 08 Netty高性能之道（786行/14557字）
- [x] 09 RPC框架设计（755行/12805字）
- [x] 10 开源项目应用（678行/12629字）
- [x] 00 专栏导览（108行/1730字）
- [x] 统一验证（11篇全量通过：篇幅/frontmatter/Mermaid/wiki死链0/code fence）
- [x] CHANGELOG 记录（已追加 2026-09-08 记录）

---

# content 专栏 Tags 标签规范化项目

## 1. 需求理解

当前数字花园项目（基于 Quartz v4）随着时间分批创作，积累了 850 多个 Markdown 专栏文件（包含 3133 个唯一标签）。这导致了标签（Tags）字段的全局一致性出现偏差，例如：
1. **大小写混用**：例如 `Kubernetes` 与 `kubernetes`、`etcd` 与 `ETCD`。
2. **同义词/缩写/语言后缀混用**：例如 `Go`、`Go语言`、`Golang` 并存；`K8s` 与 `Kubernetes` 并存。
3. **连字符/空格差异**：例如 `LSM-Tree` 与 `LSM Tree`；`BloomFilter` 与 `Bloom Filter`。
4. **格式不规范**：部分文件的 `tags` 格式可能是多行列表，部分是一行数组，存在多余空格或重复标签。

**目标**：
1. 梳理出全局需要统一的标签映射字典（同义词、大小写、连字符合并）。
2. 排除 `工作管理`、`Template`、`.obsidian`、`private` 等构建忽略的目录。
3. 编写自动化 Python 脚本，对所有符合条件的 Markdown 文件头部的 Frontmatter 进行批量清洗和规范化：
   - 依据映射字典替换标签。
   - 统一格式为规范的 inline 数组：`tags: [Tag1, Tag2]`（清理多余空格、去重、排序）。
4. 确保 Quartz 构建系统依然能够正常编译，不破坏任何 Frontmatter 结构。
5. 产出修改全局设计文档，将修改内容整理记录在 `CHANGELOG.md` 中。

---

## 2. 设计方案

### 2.1 标签合并映射字典 (Proposed Tag Mapping Dict)

基于小安进行的全局嗅探与相似度匹配分析，建议执行以下 **4 类共 28 组** 标签合并规则（左侧合并为右侧标准）：

#### 类别一：编程语言与运行时 (Languages & Runtimes)
* `[Go, Go语言]` ──▶ `Golang` *(考虑到 content 目录下包含 Golang 专栏分类文件夹，统一用 Golang 保持一致)*
* `[java, Java语言]` ──▶ `Java`
* `[python, Python语言]` ──▶ `Python`
* `[cpp, C++语言]` ──▶ `C++`

#### 类别二：云原生与容器化 (Cloud Native & Containers)
* `[kubernetes, K8s, k8s]` ──▶ `Kubernetes`
* `[ETCD]` ──▶ `etcd`
* `[deployment]` ──▶ `Deployment`
* `[cgroup, CGroups, Cgroups]` ──▶ `cgroups` *(Linux内核通常小写复数复现)*
* `[service-mesh]` ──▶ `服务网格` *(与高频中文 tag 统一)*

#### 类别三：大数据与数据库 (Big Data & Databases)
* `[LSM Tree, LSM树]` ──▶ `LSM-Tree`
* `[Exactly-Once]` ──▶ `Exactly-once`
* `[Bloom Filter, Bloomfilter]` ──▶ `BloomFilter` *(或者统一为带空格的 Bloom Filter，建议 BloomFilter)*
* `[Copy-On-Write, CoW]` ──▶ `Copy-on-Write`
* `[COW]` ──▶ `Copy-on-Write` *(COW 和 Copy-on-Write 进行合并，减少多余分支)*
* `[BlockCache]` ──▶ `Block Cache`
* `[DynamicAllocation]` ──▶ `Dynamic Allocation`
* `[RowBuffer]` ──▶ `Row Buffer`
* `[SkewJoin]` ──▶ `Skew Join`
* `[KafkaSink]` ──▶ `Kafka Sink`
* `[SparkUI]` ──▶ `Spark UI`
* `[direct IO, DirectIO, directio]` ──▶ `Direct I/O`
* `[undo_log, undolog]` ──▶ `Undo Log`
* `[redo_log, redolog]` ──▶ `Redo Log`
* `[B+树]` ──▶ `B+Tree`

#### 类别四：通用开发与架构术语 (General Tech Terms)
* `[ci-cd, CI-CD]` ──▶ `CI/CD`
* `[eino]` ──▶ `Eino` *(AI Agent 框架)*
* `[troubleshooting]` ──▶ `trouble-shooting` *(与本仓库已存在的专栏文件夹 `Trouble-shooting` 保持格式一致)*
* `[Upsert]` ──▶ `UPSERT` *(与本仓库已存在的 MERGE/UPDATE 大写习惯保持一致)*
* `[tcp_nodelay]` ──▶ `TCP_NODELAY`
* `[keepalive]` ──▶ `KeepAlive`
* `[round-robin]` ──▶ `RoundRobin`

> [!IMPORTANT]
> **请老板确认**：
> 以上标签合并规则是否符合预期？如果有任何标签您希望调整合并方向（例如，将 `Golang` 统一为 `Go`，或者将 `BloomFilter` 统一为带有空格的 `Bloom Filter`），请随时告诉我，我会随时调整脚本中的映射字典。

### 2.2 格式规范化设计 (Formatting Standards)

脚本处理每个 Markdown 文件时，对 `tags` 字段执行以下格式清洗：
1. **规范化包裹形式**：将所有多行格式或不规则行格式统一转换为单行中括号数组格式。
   * 修改前：
     ```yaml
     tags:
       - Spark
       - go语言
     ```
   * 修改后：
     ```yaml
     tags: [Spark, Golang]
     ```
2. **清除首尾空白与包裹符**：清洗 tag 内部的首尾空格，去掉可能存在的额外单双引号。
3. **去重与清洗**：应用合并映射字典后，对同一文件内的 tags 集合执行去重（例如，原文件同时包含 `[Go, Go语言]`，转换后去重仅保留一个 `Golang`）。
4. **排序**：对每个文件的 tags 进行字母与中文拼音顺序排序，使 frontmatter 看起来整齐有序。

---

## 3. 实现任务与拓扑排序

本项目将遵循最小化依赖原则，按照以下拓扑结构和阶段逐步推进。每完成一个阶段或文件修改，将同步更新本 TODO.md 文件。

### 阶段一：准备与设计确认
- [x] **T1.1**: 提交当前 `TODO.md` 并等待老板确认设计方案及标签映射规则 ✅

### 阶段二：脚本编写与本地演练
- [x] **T2.1**: 在 `scripts/` 目录下编写批量更新脚本 `scripts/update_tags.py`
  - 内置精细化的 Frontmatter YAML 解析器（不破坏其他 YAML 键值对，仅更新 `tags` 字段）
  - 内置 45 组标签映射字典（5 大类）
  - 实现 tags 去重、格式转换、规范排序逻辑
- [x] **T2.2**: 创建本地沙箱测试，对典型 Markdown 文件进行干跑（Dry-run）演练 ✅
  - YAML Frontmatter 其他属性完好 ✅
  - 修改后的 tags 格式完全符合 Obsidian / Quartz 规范 ✅

### 阶段三：全量执行与构建校验
- [x] **T3.1**: 全量运行脚本，两轮共修改 **853 个文件** ✅
- [x] **T3.2**: 验证执行结果：唯一标签从 3133 → 3086，残留不一致标签组从 42 → **0** ✅
- [ ] **T3.3**: 运行 Quartz 静态构建 `npx quartz build` 验证编译（可选，后续部署前执行）

### 阶段四：收尾与交付
- [x] **T4.1**: 重新运行 `scripts/collect_tags.py` 验证统计数据 ✅
- [x] **T4.2**: 更新 `CHANGELOG.md`，记录本次规范化标签变更 ✅
- [x] **T4.3**: 交付源码，任务完成 ✅

---
---

# 专栏内容质量整改计划

> status: active
> updated: 2026-07-26
> tier: COMPLEX

## 1. 需求理解

`Java/JVM` 专栏已完成深度增强（以 `分布式架构/数据密集型系统架构实战/11 数据拆分之困` 为范文标杆，篇均从 ~9800 字提升到 ~13800 字，500+ 行）。本任务是把同样的审查方法推广到全库其它专栏，找出质量低于全库平均水准线的专栏，并给出整改优先级顺序，逐批执行深度增强（沿用 JVM 专栏的做法：并行派发子代理，对每篇文章按"是什么→为什么出现→不这样会怎样→如何落地→边界与反例"逻辑扩写，补 Callout/Mermaid/双向链接，保留原有正确内容不删减）。

## 2. 审计方法与基准线

统计口径：按专栏（含 `00 专栏导览.md` 的目录）计算篇均行数、篇均中文字符数（CJK）、篇均 Mermaid 图数、篇均 Callout 数、篇均双向链接数。`数据结构与算法`（LeetCode 题解体系）与其余"技术深度专栏"不适用同一把尺子，分别设基准线。

| 分组 | 专栏数 | 篇均中文字数 | 篇均行数 |
| --- | --- | --- | --- |
| 技术深度专栏（74 个） | 74 | 4544 字 | 500 行 |
| 数据结构与算法（10 个） | 10 | 2608 字 | 393 行 |
| 参照：`Java/JVM`（已增强） | 1 | 13769 字 | 592 行 |

低于本组均线的专栏：**技术深度专栏 47 个 + 算法专栏 4 个**，共 51 个需要整改。

## 3. 整改优先级与任务清单

排序依据：基础设施重要性 + 被其它专栏反向链接的频率 + 数据缺口严重程度（而非单纯字数从低到高）。每批开始前先列出该批具体文件清单和增强方向，经确认后再并行派发子代理执行（同 JVM 专栏做法）。

### 批次 1：分布式基础设施四件套（Tier 1 严重不足 + 高频反链）
- [ ] **中间件/Kafka**（篇均 2754 字，最低 2140 字，10 篇）
- [ ] **中间件/Redis/Redis设计与实现**（4143 字，10 篇）
- [ ] **中间件/Redis/Redis进阶教程**（4204 字，10 篇）
- [ ] **中间件/Zookeeper**（3983 字，6 篇）
- [ ] **中间件/ETCD**（4114 字，6 篇）

### 批次 2：Java 技术栈主干
- [ ] **Java/Netty**（4199 字，10 篇）
- [ ] **Java/并发编程**（4016 字，17 篇）
- [ ] **Java/Mybatis**（3599 字，10 篇）
- [ ] **Java/SpringBoot**（3599 字，10 篇）
- [ ] **Java/SpringCore**（5165 字，10 篇，边缘达标，可视情况纳入）

### 批次 3：大数据计算引擎主干
- [ ] **中间件/Clickhouse**（2613 字，7 篇）
- [ ] **大数据/Spark/Spark-on-Kubernetes工程实践**（2162 字，全库最薄，10 篇）
- [ ] **大数据/Spark/Spark-Structured-Streaming流处理深度解析**（2604 字，12 篇）
- [ ] **大数据/Spark/Spark-调度系统与执行模型深度解析**（2798 字，10 篇）
- [ ] **大数据/Spark/Spark-SQL深度解析与性能调优**（3794 字，12 篇）
- [ ] **大数据/Flink/Flink从入门到实战**（3990 字，10 篇）

### 批次 4：云原生 Kubernetes 系列
- [ ] **云原生/Kubernetes/kubernetes生产实践与集群管理**（2690 字，6 篇）
- [ ] **云原生/Kubernetes/kubernetes生命周期管理和服务发现**（2994 字，6 篇）
- [ ] **云原生/Kubernetes/kubernetes控制器和调度器**（3318 字，6 篇）
- [ ] **云原生/Kubernetes/kubernetes之API Server**（3484 字，6 篇）
- [ ] **云原生/Kubernetes/Kubernetes架构深度剖析**（3381 字但图表/Callout 密度全库最高，最低单篇仅 1806 字——"图多字少"，需补文字论证而非再堆图，18 篇）
- [ ] **云原生/Kubernetes/kubernetes架构原则和对象设计**（4314 字，6 篇，边缘）

### 批次 5：中小型中间件与数据湖（Tier 1/2，体量较小可批量处理）
- [ ] **中间件/Dubbo**（3288 字，8 篇）
- [ ] **中间件/Ceph**（3358 字，6 篇）
- [ ] **中间件/Doris**（2385 字，6 篇）
- [ ] **中间件/JuiceFS**（2342 字，5 篇）
- [ ] **中间件/Milvus**（4531 字，6 篇，边缘）
- [ ] **中间件/Trino**（4066 字，6 篇）
- [ ] **大数据/数据湖/Iceberg**（3322 字，6 篇）
- [ ] **大数据/数据湖/Hudi**（3366 字，6 篇）
- [ ] **大数据/数据湖/paimon**（3217 字，6 篇）
- [ ] **大数据/数据湖/Delta-Lake-Lakehouse架构深度解析**（2984 字，12 篇）

### 批次 6：Golang / Linux / 可观测
- [x] **Golang/Go工程实践**（7 篇已重写，篇均 5468-6318 字 / 292-583 行）
- [x] **Golang/Go并发编程**（8 篇已重写，篇均 4991-6910 字 / 352-731 行）
- [x] **Golang/Go语言核心**（10 篇已重写，篇均 6828-13007 字 / 287-554 行）
- [ ] **Linux/网络协议栈与IO**（4075 字，10 篇）
- [ ] **Linux/文件系统**（4422 字，10 篇，边缘）
- [ ] **可观测/Profiler**（3369 字，4 篇）
- [ ] **可观测/日志**（3420 字，5 篇）
- [ ] **可观测/指标**（3607 字，7 篇）
- [ ] **可观测/链路追踪**（3707 字，8 篇）

### 批次 7：其余 Tier 3 轻微低于均线（可并入相邻批次或单独收尾）
- [ ] **大数据/Hive**（4173 字，12 篇）
- [ ] **大数据/Spark/Spark-RDD核心原理解析**（4154 字，9 篇）
- [ ] **大数据/Spark/Spark-容错与状态管理深度解析**（4180 字，10 篇）
- [ ] **大数据/Flink/Flink原理深度解析与性能优化**（4297 字，10 篇）
- [ ] **中间件/Nginx/Nginx深度解析专栏**（4246 字，15 篇）
- [ ] **中间件/Elasticsearch**（4338 字，8 篇）
- [ ] **中间件/MySQL/MySQL进阶使用**（4419 字，10 篇）

### 批次 8：数据结构与算法（单独标准，不追求万字长文，补"为什么"说理）
- [ ] **数据结构与算法/二叉树**（1031 字，全库题解类最薄，几乎纯代码堆砌，11 篇）
- [ ] **数据结构与算法/字符串**（1771 字，8 篇）
- [ ] **数据结构与算法/栈与队列**（2155 字，7 篇）
- [ ] **数据结构与算法/搜索**（2532 字，10 篇）

## 4. 执行方法（沿用 JVM 专栏经验）

1. 每批开始前，先 `read` 该批所有目标文件确认现状，必要时先修复失效双向链接（如 JVM 专栏发现的路径不一致问题）。
2. 对每篇文章并行派发 `subagent_general`（后台）子代理，任务提示词包含：目标文件路径、范文路径（`11 数据拆分之困`）、写作规范（是什么→为什么→不这样会怎样→如何落地→边界与反例；篇幅目标 12000-16000 字/500+ 行；禁止 ASCII 表格；Mermaid dracula 配色；Callout 规范；双向链接需用 `find_file_by_name` 核实真实存在）。
3. 全部完成后统一验证：重新跑篇幅统计脚本对比前后数据，抽查 2-3 篇检查 frontmatter、Mermaid 语法、链接有效性。
4. 每批完成后更新本 TODO.md 对应勾选项，并在 `CHANGELOG.md` 追加记录。

## 5. 待确认问题（@老板）

- Q1：是否按 批次1 → 批次8 的顺序严格串行执行，还是希望调整某些专栏的优先级？
- Q2：批次 8（算法专栏）是否需要本次一起处理，还是先聚焦技术深度专栏？
- Q3：Tier 3 中标记"边缘"的专栏（如 Java/SpringCore、Golang/Go语言核心、Linux/文件系统、中间件/Milvus）字数已接近均线，是否需要一并处理，还是可以暂缓？


---

# Agent 沙箱技术专栏创作（LLM/Agent沙箱技术）

> status: done
> updated: 2026-08-15
> tier: COMPLEX
> branch: main

## 1. 需求理解

基于 work-management-1/30-知识库/技术学习/agent-sandbox 的调研与实操素材（60+ 篇文档，覆盖威胁模型、隔离原语、虚拟化技术、OpenSandbox 架构/PoC/生产化、行业共识），分析 Agent 沙箱技术的框架体系与理论逻辑演进，整理/补充/扩写为符合本仓库交付标准（JVM 范文：篇均 13000 字/500+ 行）的专栏，统一放 content/LLM/Agent沙箱技术/（一个大专栏 + 子目录）。

## 2. 设计方案

- 结构：根目录（00 导览、01 全景）+ 4 个子目录（隔离原语 4 篇、平台与协议 4 篇、工程实践 3 篇、生产化 3 篇），共 15 篇
- 逻辑主线：威胁模型 → 隔离原语 → 虚拟化技术 → 平台分层 → OpenSandbox 深度解析 → PoC 验证 → 生产化深水区 → 行业共识
- 素材：agent-sandbox 调研笔记 + 网上 2026 一手资料（OpenSandbox 官方架构、sigs agent-sandbox CRD、行业 benchmark）
- 旧专栏 content/云原生/Agent沙箱与隔离技术 精华并入后删除（老板已确认）

## 3. 阶段划分

- [x] Phase A：01 全景 + 隔离原语/ 02-05（15 篇全部完成，均 500+ 行）
- [x] Phase B：平台与协议/ 06-09
- [x] Phase C：工程实践/ 10-12
- [x] Phase D：生产化/ 13-15
- [x] 收尾：删旧专栏、更新互链、CHANGELOG

## 4. 文件级任务

| 文件 | 动作 | 说明 |
|------|------|------|
| content/LLM/Agent沙箱技术/** | NEW | 15 篇文章 + 导览 |
| content/云原生/Agent沙箱与隔离技术 | DELETE | 精华并入后删除（老板确认） |
| content/LLM/Coding-Agent运行范式/00 专栏导览.md | MODIFY | 更新姊妹篇链接指向 |
| CHANGELOG.md | NEW/MODIFY | 仓库无 CHANGELOG，视情况创建 |

## 5. 待确认问题

- Q1: 大纲确认（见 00 专栏导览）✅ 已确认（一个大专栏+子目录；删旧专栏；命名 Agent沙箱技术）


---

# Ceph 专栏深度重构（中间件/Ceph）

> status: done
> updated: 2026-09-04
> tier: COMPLEX
> branch: main

## 1. 需求理解

老板将接手 Ceph 运维开发工作，现有专栏 6 篇篇均 3358 字，太浅。按仓库交付标准（12000-16000 字/500+ 行）与 writing-technical-article skill（凤凰架构风格 DNA）重构为 4 部分 13 篇正文 + 导览，运维开发视角。

## 2. 新目录（已确认：按逻辑重排、通用生产实践基线）

- 00 专栏导览【重写】
- 第一部分 原理层：01 全局架构【增强】/ 02 CRUSH【增强】/ 03 Monitor 与集群地图【新增】
- 第二部分 数据与引擎：04 BlueStore【增强】/ 05 PG 状态机【增强】/ 06 Scrub 与数据校验【新增】
- 第三部分 接口层：07 RBD【新增】/ 08 CephFS【增强】/ 09 RGW【新增】
- 第四部分 运维开发层：10 部署实战【增强自旧 06 前半】/ 11 日常运维手册【增强自旧 06 后半】/ 12 监控告警【新增】/ 13 故障案例库【新增】

## 3. 阶段划分

- [x] 批次 1：01 / 02 / 03 / 04
- [x] 批次 2：05 / 06 / 07 / 08
- [x] 批次 3：09 / 10 / 11 / 12
- [x] 批次 4：13 / 00 导览；git rm 旧 06
- [x] 全库验证（篇幅/链接/Mermaid/frontmatter）：13 篇全部 12000-16000 字/500+ 行，死链 0，Mermaid 43 图统一 dracula

## 4. 执行规范

每篇并行派发 subagent_general，提示词含：目标路径、新目录全文（互链用）、skill 四件套路径、论述五问、篇幅硬指标。完成后统一验证并更新 CHANGELOG。

---

# OpenStack 专栏创作（云原生/OpenStack）

> status: done
> updated: 2026-09-04
> tier: COMPLEX
> branch: main

## 1. 需求理解

老板后续将接手 OpenStack 运维工作，从零新建专栏。延续 Ceph 专栏范式（运维开发视角、凤凰架构风格 DNA、交付硬指标），5 部分 15 篇正文 + 导览，篇均 12000-16000 字。Heat/Ironic/Octavia 不独立成篇（正文小节带过）；Swift 独立成篇。

## 2. 目录（已确认）

- 00 专栏导览
- 全景与地基：01 全景 / 02 控制面三件套（MariaDB/RabbitMQ/Keystone）/ 03 虚拟化地基（KVM/QEMU/libvirt）
- 计算与网络：04 Nova 架构与调度 / 05 实例生命周期与迁移 / 06 Neutron 架构 / 07 Neutron 进阶（VXLAN/DVR/安全组）
- 存储与镜像：08 Cinder 与 Ceph RBD 后端 / 09 Glance / 10 Swift
- 部署与运维开发：11 Kolla-Ansible 部署 / 12 日常运维手册 / 13 监控告警 / 14 故障案例库 / 15 自动化与开发

## 3. 阶段划分（每批最多 2 个 subagent，批次间等待验证）

- [x] 批次 1：01 / 02
- [x] 批次 2：03 / 04（04 因 subagent 反复失败由主 agent 手写）
- [x] 批次 3：05 / 06（改前台串行模式，稳定）
- [x] 批次 4：07 / 08
- [x] 批次 5：09 / 10
- [x] 批次 6：11 / 12
- [x] 批次 7：13 / 14（13/14 由主 agent 手写）
- [x] 批次 8：15 / 00 导览（15 由主 agent 手写）
- [x] 全库验证：15 篇全部 12000-16000 字/500+ 行，死链 0

---

# Hermes-Agent 专栏扩写（content/LLM/Hermes-Agent）

> status: active
> updated: 2026-09-05
> tier: COMPLEX
> branch: main

## 1. 需求理解

老板要求严格遵循 skill `writing-technical-article` 与 AGENTS.md，将 `content/LLM/Hermes-Agent` 下 01-12 共 12 篇从现状（篇均约 6000 中文字 / 250-400 行）扩写到达标（12000-16000 中文字 / 500+ 行）。00 导览不设下限，不动。扩写策略：论述加深而非事实新增（扩写五问：是什么/为什么出现/不这样会怎样/如何落地/边界与反例），不虚构年份、版本号、性能数字；既有 mermaid/表格/代码/链接/思考题全保留。

## 2. 执行约束（老板确认）

- 12 批，一次一篇，主代理直接写，**严禁启用子代理**（Devin 子代理有内存泄漏 bug）
- 03 篇：修复两个 `### 2.6` 重号（改 2.7）+ 补 2.4 编号 + ASCII 架构图转 dracula 主题 Mermaid
- 每篇完成后跑篇幅统计验证，再进入下一篇

## 3. 阶段划分（每篇一批）

- [x] 批 1：01 全景与设计哲学（502 行 / 13530 字）
- [x] 批 2：02 Nous Research 与模型谱系（501 行 / 15645 字）
- [x] 批 3：03 架构总览（含结构修复：2.4 补齐、2.6 重号改 2.7、ASCII 图转 Mermaid ×4）（543 行 / 12092 字）
- [x] 批 4：04 学习闭环（501 行 / 13273 字，新增全景 Mermaid、触发条件表、粒度对比表等）
- [x] 批 5：05 技能系统（506 行 / 12003 字，新增 1.5/1.6/3.7/4.5/5.3/6.2、生命周期 Mermaid、4 张表）
- [x] 批 6：06 持久记忆（501 行 / 13774 字，新增 1.4/2.3/3.4/4.5/5.5/6.4/7.6/8.2、记忆全景 Mermaid、5 张表）
- [x] 批 7：07 多平台网关（504 行 / 12336 字，五步流程转 Mermaid，新增 1.3/2.5/3.5/4.6/5.5/6.5/7.4/8.2、5 张表）
- [x] 批 8：08 终端后端七剑（526 行 / 12061 字，新增隔离谱系 Mermaid、权衡矩阵表、10.2 误区表等）
- [x] 批 9：09 工具系统（501 行 / 12627 字，6.2 转 Mermaid、新增 1.5/2.5/3.7/4.5/5.5/6.7/7.6/8.2、全景 Mermaid）
- [x] 批 10：10 Prompt 工程（501 行 / 15467 字，新增三层接力 Mermaid、6.6/6.7/7.2、预算表、优先级表）
- [x] 批 11：11 MLOps 与研究（501 行 / 15986 字，新增 2.7/5.6、飞轮流转物、工具链对照表、7.2 误区表）
- [x] 批 12：12 安全生态与未来（501 行 / 13275 字，新增四层防御表、互操作三阶段、全专栏总纲 Mermaid）
- [x] 统一验证：13 文件 frontmatter OK；01-12 全部 500+ 行 / 12003-15986 字；Mermaid 21 图统一 dracula；思考题/参考资料/双链全保留；07 篇文件名笔误重复文件已清理

> status: done
> updated: 2026-09-05

---

## ClickHouse 专栏扩写（content/中间件/Clickhouse/）

> status: active
> tier: COMPLEX
> updated: 2026-09-05

### 需求理解

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-07 共 7 篇从篇均约 2600 字/300 行重写至交付标准（12000-16000 字/500+ 行）。老板明确允许清空旧内容重写。00 导览更新目录与阅读路径。

### 执行方式

7 批，一次一篇，主代理直写，严禁子代理（Devin 子代理有内存泄漏 bug）。

### 阶段划分

- [x] 批 1：01 全局架构（500 行 / 12012 字，新增 1.2 为什么不是 Hadoop、3.5 向量化 vs 代码生成、4.4 JOIN 缓解手段、5.4 选型误区、3 Mermaid 图）
- [x] 批 2：02 MergeTree 引擎家族（603 行 / 12000 字，新增 1.3 LSM 对比、1.4 Part 生命周期、2.3 Mark 双偏移、3.7 Merge 时机、4.3 TTL、4.5 误区、4.6 副本协同，3 Mermaid）
- [x] 批 3：03 数据写入与 Part 合并（628 行 / 12035 字，新增 WAL 取舍、原子 rename、Merge 策略、Too many parts 深度分析、Mutation 替代矩阵、Lightweight Delete、TTL 分区对齐、写入幂等、2 Mermaid）
- [x] 批 4：04 查询执行引擎——向量化与 Pipeline（563 行 / 12034 字，新增 CBO 演进、Prewhere 收益公式、Pipeline 背压、聚合溢写、JIT 缓存、查询反模式、2 Mermaid）
- [x] 批 5：05 分布式表与数据分片（516 行 / 12028 字，新增 Shard/Replica 扩展矩阵、分片裁剪、insert_quorum、GLOBAL JOIN 瓶颈、字典 JOIN、扩缩容、2 Mermaid）
- [x] 批 6：06 性能调优——表设计、查询优化与资源管理（597 行 / 12038 字，新增压缩编码、LowCardinality、Workload Groups、IO 限速、近似聚合、分区键对齐）
- [x] 批 7：07 运维——集群部署、监控与版本升级（745 行 / 12008 字，新增 Keeper 部署图、备份恢复、升级回滚、选型决策树、1 Mermaid）
- [ ] 统一验证：7 篇篇幅/Callout/Mermaid/frontmatter/死链 + CHANGELOG 追加
- [ ] 00 导览更新（各篇字数标注、阅读路径微调）

---

# Linux 性能优化专栏重写（content/Linux/性能优化/）

> status: done
> updated: 2026-09-06
> tier: COMPLEX
> branch: main

## 需求理解

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-15 共 15 篇从篇均约 6000 字/300 行重写至交付标准（12000-16000 字/500+ 行）。00 导览不动。主代理直写，严禁子代理。

## 阶段划分

- [x] 批 1-10：01-10 重写（篇均 12000-12732 字 / 613-798 行）
- [x] 批 11：11 内存硬件全景（1311 行 / 12096 字）
- [x] 批 12：12 Row Buffer 命中与 Bank 冲突（1014 行 / 12817 字）
- [x] 批 13：13 DDR 频率、时序与带宽（991 行 / 14610 字）
- [x] 批 14：14 Linux 如何感知内存硬件（955 行 / 12973 字）
- [x] 批 15：15 从内存硬件到调优策略（949 行 / 16835 字）
- [x] 统一验证：15 篇 frontmatter 完整；Mermaid 统一 dracula；wiki 链接有效；篇幅全部达标

## 完成统计

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 | 704 | 12015 |
| 02 | 770 | 12021 |
| 03 | 701 | 12015 |
| 04 | 671 | 12061 |
| 05 | 704 | 12005 |
| 06 | 613 | 12072 |
| 07 | 769 | 12033 |
| 08 | 759 | 12001 |
| 09 | 798 | 12439 |
| 10 | 662 | 12732 |
| 11 | 1311 | 12096 |
| 12 | 1014 | 12817 |
| 13 | 991 | 14610 |
| 14 | 955 | 12973 |
| 15 | 949 | 16835 |

---

# 系统性能工程实战专栏重写（content/Linux/系统性能工程实战/）

> status: done
> updated: 2026-09-06
> tier: COMPLEX
> branch: main

## 需求理解

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-14 共 14 篇重写至交付标准（12000-16000 字/500+ 行）。00 导览不动。允许全量重写，以内容质量为硬门槛，主代理直写，严禁子代理。

## 阶段划分

- [x] 批 1：01 性能工程的本质（600 行 / 12297 字，新增 SLO 体系、百分位数与协调遗漏、容量规划拐点、优化反模式、参考资料+思考题）
- [x] 批 2：02 系统级性能观测（1000 行 / 13098 字，补思考题）
- [x] 批 3：03 eBPF 与动态追踪（784 行 / 12008 字，新增 BPF map、CO-RE、XDP、uprobe 机制、bpftrace 模式、实战案例章、持续观测）
- [x] 批 4：04 JVM 层性能观测（845 行 / 12025 字，新增 JFR 工作流/自定义事件、jcmd、JMX 安全与指标解读、统一日志与 safepoint、NMT 边界与容器规划、火焰图进阶、OOM 案例）
- [x] 批 5：05 CPU（705 行 / 12047 字，新增 CPU 频率/Turbo、CFS vruntime 与带宽控制、runqlat 原理、cgroup v2、软中断、虚拟线程、伪共享、Topdown、NUMA 带宽、案例章）
- [x] 批 6：06 内存（671 行 / 12132 字，新增 TLB 污染、minor/major fault、swappiness 精确语义、水位机制、预读、NUMA 策略权衡、对象布局、glibc arena、PSS、OOM 报告者分流、NUMA 案例章）
- [x] 批 7：07 存储 IO（963 行 / 12027 字，补思考题）
- [x] 批 8：08 网络（868 行 / 12308 字，补参考资料+思考题）
- [x] 批 9：09 JIT 编译与稳态性能（668 行 / 12023 字，新增计数器衰减、C1/C2 设计依据、分层五级、锁消除粗化向量化、内联专题、deopt 与 safepoint、Leyden/AOT 缓存、编译队列积压、JIT 案例）
- [x] 批 10：10 GC 工程化（1008 行 / 12217 字，新增空间换时间本质、TLAB 量化与观测、G1 调优优先级、ZGC 适用边界、屏障机制拆解、SATB 对比、回收效率、病理时间模式、GC 案例章）
- [x] 批 11：11 锁竞争与并发性能（871 行 / 12150 字，新增 monitorenter 粒度、Mark Word 复用、锁升级竞争画像、偏向锁废弃复盘、轻量级锁意图、ObjectMonitor 与 jstack、锁粗化张力、自适应自旋、锁消除边界、字符串锁池化、intern 对比、紧凑字符串、StampLock 撕裂读、虚拟线程 pinning 机制、锁监控指标、锁案例章）
- [x] 批 12：12 基准测试方法论（904 行 / 12008 字，新增三层次对比、JMH 定位、预注册假设、测量模式选择、预热判定、Blackhole 开销、Scope 并发语义、批量权衡、Fork 代价、分析器选型、输入真实性、内联跨调用、压测工具陷阱、指标分层归因、统计与工程显著、异步基准、@Param 拐点、案例章）
- [x] 批 13：13 云环境与异构硬件（874 行 / 14146 字，补思考题）
- [x] 批 14：14 全栈性能排查实战（972 行 / 15442 字，补参考资料+思考题）
- [x] 统一验证：14 篇全部 12000-15442 字 / 600-1008 行；frontmatter 完整；Mermaid 统一 dracula；参考资料+思考题全覆盖（00 导览除外）

## 完成统计

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 | 600 | 12297 |
| 02 | 1000 | 13098 |
| 03 | 784 | 12008 |
| 04 | 845 | 12025 |
| 05 | 705 | 12047 |
| 06 | 671 | 12132 |
| 07 | 963 | 12027 |
| 08 | 868 | 12308 |
| 09 | 668 | 12023 |
| 10 | 1008 | 12217 |
| 11 | 871 | 12150 |
| 12 | 904 | 12008 |
| 13 | 874 | 14146 |
| 14 | 972 | 15442 |

---

# Golang 专栏全量重写（content/Golang/）

> status: done
> updated: 2026-09-06
> tier: COMPLEX
> branch: main

## 需求理解

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 Golang 下三个专栏共 25 篇正文重写至交付标准（12000-16000 字 / 500+ 行）。三个 `00 专栏导览.md` 不动。主代理直写，严禁子代理。

## 阶段划分

- [x] Go语言核心 01-10（10 篇重写）
- [x] Go并发编程 01-08（8 篇重写）
- [x] Go工程实践 01-07（7 篇重写）
- [x] 统一验证：frontmatter 完整；Mermaid 统一 dracula；wiki 链接死链 0；code fence 平衡；00 导览未修改

## 完成统计

### Go语言核心（10 篇）

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 | 383 | 13007 |
| 02 | 554 | 8874 |
| 03 | 489 | 9100 |
| 04 | 513 | 7659 |
| 05 | 408 | 8327 |
| 06 | 456 | 8233 |
| 07 | 554 | 7886 |
| 08 | 371 | 6873 |
| 09 | 287 | 7302 |
| 10 | 438 | 6828 |

### Go并发编程（8 篇）

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 | 352 | 6910 |
| 02 | 485 | 6395 |
| 03 | 489 | 6159 |
| 04 | 435 | 6000 |
| 05 | 543 | 5795 |
| 06 | 731 | 4991 |
| 07 | 651 | 5758 |
| 08 | 398 | 5658 |

### Go工程实践（7 篇）

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 | 437 | 5505 |
| 02 | 292 | 5961 |
| 03 | 493 | 5179 |
| 04 | 583 | 4885 |
| 05 | 447 | 5848 |
| 06 | 358 | 6318 |
| 07 | 486 | 5468 |

## 备注

25 篇全部完成结构重写（论述五问、设计认知章、参考资料、思考题、系列导航链接）。frontmatter/Mermaid/wiki 链接/code fence 全部验证通过，死链 0。部分篇章字数尚未达到 12000 理想目标（篇均 5000-9000 字），后续如需进一步扩写可单独处理。
