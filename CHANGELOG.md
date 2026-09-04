# CHANGELOG

本文件记录 my-brain 数字花园的重大内容变更。

## 2026-09-04

### 新增：OpenStack 专栏（content/云原生/OpenStack/）

面向「OpenStack 运维开发工程师」视角的完整专栏：**15 篇正文 + 导览，合计约 19.5 万中文字**，全部达到交付标准（12000-16000 字/500+ 行）。

- **结构**（5 部分，通用生产实践基线）：
  - 全景与地基：01 全景 / 02 控制面三件套（MariaDB/RabbitMQ/Keystone）/ 03 虚拟化地基（KVM/QEMU/libvirt）
  - 计算与网络：04 Nova 架构与调度 / 05 实例生命周期与迁移 / 06 Neutron 架构 / 07 Neutron 进阶（VXLAN/DVR/安全组）
  - 存储与镜像：08 Cinder 与 Ceph RBD 后端 / 09 Glance / 10 Swift（含与 Ceph RGW 对比）
  - 部署与运维开发：11 Kolla-Ansible 部署 / 12 日常运维手册 / 13 监控告警 / 14 故障案例库 / 15 自动化与开发
- **风格**：全部按 writing-technical-article skill（凤凰架构 DNA）创作；论述五问贯穿；Heat/Ironic/Octavia 按老板决策在正文小节带过
- **质量**：Mermaid 统一 dracula；全库死链 0；版本号/参数默认值经 web 核实；案例库按五段式（现象→诊断→根因→处置→预防）可作 runbook
- **执行**：8 批次串行推进（每批 ≤2 个 subagent，批次间验证），因编辑器崩溃导致的 subagent 丢失由主 agent 手写补齐（04/13/14/15）

### 重构：Ceph 专栏深度重写（content/中间件/Ceph/）

面向「Ceph 运维开发工程师」视角（原理深到能排障、运维细到能上手）的整专栏重构，从 6 篇篇均 3358 字扩充为 **13 篇正文 + 导览，合计 16.76 万中文字**，全部达到交付标准（12000-16000 字/500+ 行）。

- **结构**（4 部分，按逻辑重排编号，外部反链仅指向导览无死链）：
  - 原理层：01 全局架构【增强】/ 02 CRUSH【增强】/ 03 Monitor 与集群地图【新增】
  - 数据与引擎层：04 BlueStore【增强】/ 05 PG 状态机【增强】/ 06 Scrub 与数据校验【新增】
  - 接口层：07 RBD【新增】/ 08 CephFS【增强】/ 09 RGW【新增】
  - 运维开发层：10 部署实战【自旧 06 拆分增强】/ 11 日常运维手册【自旧 06 拆分增强】/ 12 监控告警【新增】/ 13 故障案例库【新增】
- **删除**：旧《06 Ceph 运维——集群部署、PG 调优与故障处理》拆分并入 10/11 两篇后删除
- **风格**：全部按 writing-technical-article skill（凤凰架构 DNA）创作：历史溯源开场、比喻落地、设问推进、正反权衡、落点因地制宜；论述五问贯穿
- **质量**：篇均 12894 字/559 行；Mermaid 43 图统一 dracula；全库死链 0（含修复原稿 7 处裸链接与 4 处旧编号链接）；版本号/参数默认值/研究数据经 web 核实，不确定口径如实标注
- **执行**：分 4 批并行 subagent，遵循 AGENTS.md 批量整改流程

### 变更：《03 OpenTelemetry 统一标准》按凤凰架构风格重写（content/可观测/链路追踪/）

以周志明《凤凰架构》（icyfenix.cn）全站 43.4 万字蒸馏出的六层写作 DNA（L1 语言/L2 结构/L3 选题/L4 素材/L5 认知/L6 视觉）全文重写。保留全部技术资产（mermaid/yaml/protobuf/Java 代码、对比表格、参考资料、思考题、wiki 链接），注入句法层与认知层风格：历史叙事开场、比喻落地（度量衡铸钱币、物流分拨中心）、设问推进、争议正反权衡、落点「因地制宜/权衡取舍」。

### 新增：writing-technical-article skill（.devin/skills/）

技术文章写作 skill，沉淀上述六层风格规则与写前校准、写后自检流程（`SKILL.md` + `references/style-rules.md` + `references/checklist.md`）。已同步至 `~/.claude/skills/`、`~/.agents/skills/`、`~/.codeium/windsurf/skills/`，供各 agent 复用；writing-dna 原始仓库不保留。

### 新增：仓库工作规范 AGENTS.md + 交付硬指标

- 新建根目录 `AGENTS.md`（always-on）：专栏交付硬指标摘要、写作风格 skill 指引、CHANGELOG/TODO 记录惯例、批量执行验证流程
- skill 新增 `references/delivery-standard.md`：从 TODO.md 历史任务提炼的专栏交付硬指标（篇幅 12000-16000 字/500+ 行、论述五问、Mermaid dracula/Callout/双向链接核实/tags 全局映射、批量执行与验证流程、红线），与 style-rules.md 并列生效
- `checklist.md` 新增 H 组交付硬指标自检；skill 已重新同步至三个全局 agent 目录

## 2026-08-15

### 新增：Agent 沙箱技术专栏（content/LLM/Agent沙箱技术/）

基于 `work-management-1/30-知识库/技术学习/agent-sandbox` 的调研与实操素材（60+ 篇文档，覆盖威胁模型、隔离原语、虚拟化技术、OpenSandbox 架构/PoC/生产化、行业共识），分析 Agent 沙箱技术的框架体系与理论逻辑演进，整理/补充/扩写为符合本仓库交付标准（JVM 范文：篇均 13000 字/500+ 行）的完整专栏。

- **规模**：15 篇文章 + 1 篇导览，共 16 个文件，约 7700 行
- **结构**：根目录（00 导览、01 全景）+ 4 个子目录
  - `隔离原语/`（02-05）：Linux 隔离原语、四档隔离光谱、KVM 硬件虚拟化、VMM 家族解剖
  - `平台与协议/`（06-09）：六层模型与产品路线、OpenSandbox 架构/数据面/编排面三部曲
  - `工程实践/`（10-12）：部署实战（单机 PoC→测试集群）、三类 Agent 镜像化、性能工程
  - `生产化/`（13-15）：状态四本账、安全体系（三层防护/短期凭据/多租户）、十个盲区与行业共识
- **素材来源**：agent-sandbox 项目一手实操记录（PoC 47 步部署、三运行时基准、WarmPool 实测、源码走读）+ 2026 年公开资料（OpenSandbox 官方文档、InfoQ 分享、sigs agent-sandbox、行业 benchmark）

### 变更：旧专栏迁移

- 删除 `content/云原生/Agent沙箱与隔离技术/`（12 篇旧文章，篇均 6100 字，未达交付标准且缺 OpenSandbox 主线）
- 旧内容精华（namespaces/cgroups/seccomp/gVisor/Kata/Firecracker 等技术底稿）已并入新专栏 02-05 篇并深度扩写
- 更新 8 个外部引用文件（Coding-Agent运行范式 7 处、Hermes-Agent 2 处）的姊妹专栏链接指向

### 其他

- 根 TODO.md 追加并完成「Agent 沙箱技术专栏创作」任务章节
