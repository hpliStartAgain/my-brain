# OpenSRE 调研报告

> **调研时间**：2026-05-06  
> **调研人**：汀  
> **调研来源**：https://www.opensre.com/docs/integrations-overview  
> **GitHub**：https://github.com/Tracer-Cloud/opensre  
> **结论**：**不推荐直接集成，但有高价值设计模式可借鉴**

---

## 一、项目概要

OpenSRE（前身为 Tracer Cloud）是一个 AI 驱动的事件调查工具，定位为「会用工程师日常工具的 SRE AI Agent」。核心工作流程如下：

```
输入 Alert Payload (JSON)
    ↓
连接已配置的 Observability / DB / 代码仓库等集成
    ↓
构建调查假设 (Hypothesis)
    ↓
逐假设收集证据（查日志、查指标、查最近部署、绘依赖关系）
    ↓
输出结构化 RCA 报告
  ├── problem.md      ← 事件定义与初始假设
  ├── theory/hypothesis_*.md  ← 每条假设的验证过程
  └── report.md       ← 最终根因结论与修复建议
```

**技术栈**：Python + LangGraph Platform（云端部署）；CLI 二进制 (`opensre`)，支持 macOS/Linux/Docker；LLM 提供商无关（支持 Anthropic/OpenAI/Gemini/Ollama/OpenRouter 等 10+ 种）。

---

## 二、完备度评估

### 2.1 集成目录（60+）

| 类别 | 已支持集成 |
|---|---|
| 可观测性 | Alertmanager、Grafana、Datadog、Honeycomb、Coralogix、Better Stack、Azure Monitor、Sentry、Splunk |
| 云基础设施 | AWS（EC2、RDS、CloudWatch） |
| 数据库 | MySQL、PostgreSQL、MariaDB、MongoDB、ClickHouse |
| 消息队列 | Kafka |
| 代码仓库 | GitHub、GitLab、Bitbucket |
| 工作流 | Airflow、Prefect、Slurm、Nextflow |
| 沟通协作 | Slack、Discord、Jira、OpsGenie、Google Docs、Trello |
| 部署平台 | Vercel、Railway、Argo CD |

### 2.2 产品成熟度

- ✅ 文档完整（文档有效，每日更新 daily-updates 已持续到 2026-05-05）
- ✅ CLI 工作流稳定（`opensre onboard` → `integrations verify` → `investigate`）
- ✅ LLM 解耦良好（Reasoning 模型 + Toolcall 模型双槽设计）
- ✅ 可本地/on-prem 自托管（Docker 部署，Ollama 本地 LLM）
- ⚠️ 云端官方部署路径依赖 LangGraph Platform（需外部云账户）
- ⚠️ Remote Runtime Investigation 目前仅支持 Railway（其他提供商有 hook 但未实现）
- ⚠️ `features.md` 内容为"Coming soon"占位符，说明文档建设略滞后于代码

---

## 三、与我方体系的集成可行性分析

### 3.1 关键缺口——核心技术栈均不被支持

| 我方关键组件 | OpenSRE 支持状况 | 说明 |
|---|---|---|
| **VictoriaMetrics** | ❌ 不支持 | 无原生 VictoriaMetrics 集成；仅支持 Datadog/Coralogix 等商业平台 |
| **Foxeye（n9e v7+）** | ❌ 不支持 | 无 Foxeye/夜莺集成；仅支持 Alertmanager（接口不兼容） |
| **Loki（自建）** | ❌ 不支持 | 无 Loki 集成；日志侧仅支持 Coralogix、Better Stack、Azure Monitor 等商业 SaaS |
| **Ambari** | ❌ 不支持 | 无大数据集群管理平台集成 |
| **Zabbix** | ❌ 不支持 | 无 Zabbix 集成 |
| **Hadoop/YARN/HBase** | ❌ 不支持 | 无任何大数据计算框架集成 |
| **Apache Doris** | ❌ 不支持 | 有 ClickHouse，无 Doris |
| **SaltStack** | ❌ 不支持 | 无配置管理平台集成 |
| **KDC/Kerberos** | ❌ 不支持 | 无 Kerberos 感知 |
| Kafka | ✅ 支持 | 可查询 Kafka Topic 健康与 ConsumerGroup Lag |
| MySQL | ✅ 支持 | 可查询 MySQL 实例（中间件集群有价值） |
| Grafana | ✅ 支持 | 可接入我方 Grafana，但我方告警源是 Foxeye 而非 Grafana Alerting |

**核心结论**：OpenSRE 的集成体系几乎完全面向**云原生微服务架构**（Kubernetes + 商业 APM + 云平台），与我方**大数据集群 SRE 场景**存在根本性的适用场景错位。

### 3.2 架构哲学差异

| 维度 | OpenSRE（设计假设） | 我方场景（实际情况） |
|---|---|---|
| **故障单元** | HTTP 服务 Pod / 微服务实例 | HDFS NameNode / YARN ResourceManager / Spark 作业 |
| **调查路径** | Alert → 查最近代码部署 → 查服务日志 → 查依赖链 | Alert → 查组件状态 → 查 GC/磁盘/网络 → 查作业 DAG |
| **拓扑依赖** | Kubernetes Service Mesh / 服务注册中心 | HDFS → YARN → HiveServer2 → Spark（批处理依赖图） |
| **部署关联** | GitHub PR / CI 触发告警 | Ambari 配置变更 / 集群扩缩容触发告警 |
| **LLM 上下文** | HTTP 请求级别（毫秒） | 批处理作业级别（分钟~小时），无 Trace |
| **网络环境** | 外网可达（SaaS 集成） | 内网隔离（`sohurdc.com` 私有域，Kerberos 认证） |

### 3.3 部署模式兼容性

OpenSRE 官方部署路径为 LangGraph Platform（需注册 `app.tracer.cloud` 账户）。自托管虽有 Docker 方案，但：
- 依赖外网 LLM API（DeepSeek 可通过 OpenRouter 接入，**但涉及内网数据外传合规问题**）
- 默认 Ollama 本地模型（llama3.2）推理能力显著弱于 DeepSeek-V3/R1
- 内网 Intranet 集群对 `tracer.cloud` 注册账户有防火墙隔离问题

---

## 四、总体评分

| 评估维度 | 评分 | 说明 |
|---|---|---|
| 场景匹配度 | ⭐⭐☆☆☆ | 微服务场景友好，大数据集群场景几乎无覆盖 |
| 核心集成覆盖 | ⭐⭐☆☆☆ | VictoriaMetrics/Foxeye/Loki/Ambari 均不支持 |
| 自托管可行性 | ⭐⭐⭐☆☆ | Docker 可部署，但网络+合规限制较大 |
| LLM 灵活性 | ⭐⭐⭐⭐⭐ | 提供商无关设计优秀，Ollama/OpenRouter 均可用 |
| 产品成熟度 | ⭐⭐⭐⭐☆ | 更新频繁，文档完整，CLI 稳定 |
| **综合集成推荐** | **不推荐** | 核心观测数据源无法接入，场景错位根本性 |

---

## 五、值得借鉴的设计模式

OpenSRE 虽不适合直接集成，但其工程设计有以下 4 个模式值得在我方 SRE Copilot 中参考实现：

### 5.1 结构化 RCA 产出物分离

OpenSRE 将一次调查拆分为三层产出：
```
problem.md          ← 事件定义（是什么 + 初始假设）
theory/hypothesis_N.md  ← 每条假设独立文件（验证过程可追溯）
report.md           ← 最终结论（根因 + 修复建议 + 影响面）
```

> **借鉴方向**：当前我方 SRE Copilot 的 AI 根因分析（`ai_analyses` 表）直接存储结论文本，缺乏假设链路的透明化。可参考三层结构，在前端展示「假设列表 + 每条假设的证据支撑」，提升 AI 分析的可解释性和工程师信任度。

### 5.2 Reasoning + Toolcall 双槽模型设计

OpenSRE 针对每个 LLM 提供商明确区分：
- **Reasoning 模型**（重推理，高算力）：用于假设生成、多步分析、根因判断
- **Toolcall 模型**（轻量，低延迟）：用于工具选择与路由

当前我方三层 Agent（Master / Converter / Matcher）分别固定使用 DeepSeek-V3 和 DeepSeek-R1，但没有统一的「轻量路由模型」配置机制。当 Agent 数量增多（未来 SCMDB 拓扑 Agent、降噪 Agent 等），此双槽设计有助于降低成本。

> **借鉴方向**：在 `config.go` 中增加 `LLMReasoningModel` / `LLMToolcallModel` 两个全局配置项，让工具选择类 Agent 默认走轻量模型。

### 5.3 敏感标识符 Masking 机制

OpenSRE 文档专门提供 `masking.md`，在将告警 Payload 发给外部 LLM 之前，对 Pod 名称、集群名、账户 ID 等进行**可逆 Masking**（保留语义的占位替换），LLM 分析完成后再 Unmask 还原。

这对我方场景尤其重要：Kerberos Principal、主机名（含业务语义的 `dnn014023`）、队列名（`root.bdwh`）都属于内部敏感标识，直接发送给外部 API 存在信息安全风险。

> **借鉴方向**：在 SRE Copilot 的 Prompt 构建层增加 `MaskingMiddleware`，维护一个 `mask_map`，在发送前替换敏感 token，在 LLM 响应解析后还原。

### 5.4 Alert Payload 标准化入口

OpenSRE 以**标准化 JSON Alert Payload** 作为所有调查的统一入口（`opensre investigate -i alert.json`），不同告警源（Datadog / Alertmanager / 自定义）通过适配器转换为统一格式，使调查流水线完全与告警源解耦。

当前我方 SRE Copilot 的根因分析入口是 Foxeye Webhook，格式相对固定。随着未来 Ambari 原生告警、Loki 日志告警等新增告警源接入，会面临 Agent 逻辑对告警源格式强耦合的问题。

> **借鉴方向**：定义一个内部统一 `AlertPayload` struct，在 Webhook Handler 层为每类告警源（Foxeye / Zabbix / Ambari）编写适配器，统一转换后再送入 Master Agent。

---

## 六、参考资源

| 资源 | 链接 |
|---|---|
| 官方文档 | https://opensre.com/docs |
| GitHub 仓库 | https://github.com/Tracer-Cloud/opensre |
| 集成总览 | https://opensre.com/docs/integrations-overview |
| LLM 提供商配置 | https://opensre.com/docs/llm-providers |
| 调查流程说明 | https://opensre.com/docs/investigation-overview |
| Masking 机制 | https://opensre.com/docs/masking |
| Alertmanager 集成 | https://opensre.com/docs/alertmanager |
