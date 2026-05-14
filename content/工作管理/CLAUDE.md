# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 目录定位

`工作管理/` 是基于 Obsidian 构建的**个人工作操作系统**，服务对象是搜狐 RDC 大数据集群 SRE，覆盖任务追踪、每日复盘、技术方案沉淀等全流程。所有文件均为 Markdown，通过 Obsidian Kanban 插件、Dataview 插件和 Wiki 链接相互关联。

---

## 目录结构与职责

```
工作管理/
├── 架构演进与交付.md       # Kanban 看板：中大型交付任务（新特性、系统建设、业务治理）
├── 日常运维与琐事.md       # Kanban 看板：日常运维操作、小型工程任务
├── 技术攻坚与前瞻研究.md   # Kanban 看板：技术预研、方案调研、前瞻性课题
├── 日记/YYYY/MM/           # 每日工作日志（晨间调度 + 晚间复盘）
├── Inbox-Task池/           # 所有具体任务文件，按任务域/项目分类存放
│   ├── 集群新特性/
│   │   ├── Knox高可用/     # 示例：≥3个关联子任务时建项目子目录
│   │   └── (其他独立任务平铺)
│   ├── 集群可观测建设/
│   ├── 集群智能运维/
│   ├── 集群日常运维/       # 单次 ops 操作，保持平铺
│   └── 计算治理/
├── Outbox-产出池/          # 镜像 Inbox 目录结构，存放已完成任务的最终输出
└── Ref-参考资料/           # 第三方文档、官方手册、调研原始材料（非任务文件）
    ├── 集群新特性/
    ├── 集群智能运维/
    └── ...
```

---

## 核心约定

### 任务文件 Frontmatter 规范

`Inbox-Task池/` 中每个任务文件必须包含以下 frontmatter：

```yaml
---
type: task
status: todo | doing | done     # todo=待办, doing=进行中, done=已完成
priority: P0 | P1 | P2
deadline: YYYY-MM-DD
domain: 集群新特性 | 集群可观测建设 | 集群智能运维 | 集群日常运维 | 计算治理
lifecycle: research | engineering | review   # 研究/工程实施/评审
progress: "0"                   # 进度百分比（字符串）
completed_date:                 # 完成日期，done 时填写
started_date:                   # 开始日期，doing 时填写
---
```

Dataview 插件依赖这些字段驱动日记中的进行中任务表和每日交付归档表，字段缺失会导致看板查询失效。

### 三块看板的分工

| 看板文件 | 收录标准 |
|---|---|
| `架构演进与交付.md` | 需要设计文档、跨组件影响、交付周期 > 1周的任务 |
| `日常运维与琐事.md` | 配置变更、参数调整、定期检查等重复性运维操作 |
| `技术攻坚与前瞻研究.md` | 调研报告、可行性分析、技术预研等无明确工程产出的课题 |

三块看板均使用 Obsidian Kanban 插件语法（`kanban-plugin: board`），列名固定为**待办 / 进行中 / 已完成**，每个条目是指向 `Inbox-Task池/` 对应文件的 Wiki 链接。

### 日记模板结构

`日记/YYYY/MM/YYYY-MM-DD.md` 分两段：
- **晨间 Init**：Dataview 查询当日进行中任务 + 碎片 Inbox（临时闪念记录处）
- **晚间 Checkpoint**：Dataview 查询当日完成任务 + 技术卡点/系统状态文字复盘

模板使用 Obsidian Core Templates 插件语法，`{{date:YYYY-MM-DD}}` 会在创建时自动替换为实际日期。Dataview 查询依赖 `date` 字段做时间过滤，该字段必须是 `YYYY-MM-DD` 格式的标量值，**不能**写成嵌套 map（如 `date:\n  "{ date }":` 这种写法会被 YAML 解析为对象而非日期字符串，导致 Dataview 查询失效）。

### Inbox 项目子目录规则

- **何时建子目录**：≥3 个关联子任务，或项目跨度 > 1 周
- **何时保持平铺**：单次 ops 操作、一次性配置变更（集群日常运维域的任务通常平铺）
- **Outbox 结构镜像 Inbox**：产出文档放在与 Inbox 相同的 domain/项目路径下

### Ref 参考资料

`Ref-参考资料/` 存放**非任务性**的外部材料：第三方官方文档、调研原始资料、业界案例、配置手册等。按与 Inbox 相同的 domain 维度组织子目录。**不放任务文件、不放产出文档**，仅作参考备查。

### Outbox 产出池

任务完成后，最终对外输出的文档（方案报告、设计文档）移入 `Outbox-产出池/`，原 `Inbox-Task池/` 中的任务文件**保留**（作为过程记录），任务 frontmatter 更新 `status: done` 和 `completed_date`。

### Lifecycle 迁移约定

当技术攻坚类任务进入工程实施阶段时，需手动将看板条目从 `技术攻坚与前瞻研究.md` 移入 `架构演进与交付.md`，并将任务 frontmatter `lifecycle` 字段从 `research` 改为 `engineering`。

---

## SRE 基础设施现状（2026-05 更新）

### 集群拓扑

| 集群 | 用途 | 规模 |
|---|---|---|
| H3 离线 | 主力离线计算集群（HDFS + YARN + Hive + HBase） | 主力集群，60+ 工作节点 |
| H3 实时 | 实时流处理（Flink + Spark Streaming） | - |
| H3 冷存 | 冷数据归档（独立 RM 节点） | - |
| H2 冷存 | 历史冷存 | - |
| CVM 集群 | 虚拟机集群 | Loki 接入中 |
| 中间件集群 | Kafka / Redis / MySQL / ES / Druid | Loki 接入中 |

所有集群由 **Ambari** 统一管理，**Kerberos（KDC）** 认证；访问网关层使用 **Knox**（双节点 + SCLB 四层负载，HA 已上线）。

---

### 可观测技术栈（当前状态）

#### 指标链路
- **采集**：自研 Go Exporter（Hadoop/HBase/HiveServer2/KDC），采集目标 Prometheus 协议 + Categraf procstat
- **存储**：VictoriaMetrics（指标时序数据库）
- **告警/大盘**：Foxeye（基于夜莺 n9e v7+），正在从 Zabbix 全量迁移（545条规则，已复核 296条，迁移率 ~61%）
- **遗留系统**：Zabbix（存量主力，迁移完成前双平台并行）

#### 日志链路
- **采集器**：**Grafana Alloy**（已替代 Promtail，3.18 技术选型确定），通过 **SaltStack** 批量部署
- **存储**：Loki（多租户，`X-Scope-OrgID` 鉴权）
- **采集状态**：
  - ✅ H3离线/实时/冷存 + H2冷存：系统日志 + 服务级日志（NN/DN/RM/NM/HS2/HBase/ZK）已接入
  - 🔄 CVM 集群 + 中间件集群：接入进行中（P0，DDL 2026-06-30），详见 [[Alloy全集群部署推广]]
  - ⏳ Spark Driver/Executor 作业级日志：不接入 Alloy（作业日志已聚合到 HDFS）

#### Label 规范约定
```
# 日志 Label 体系
cluster = h3-offline / h3-realtime / h3-cold / cvm / middleware
service_name = namenode / datanode / resourcemanager / ...
role = master / worker
host = <hostname>
```

---

### AiOps：Hermes Agent + Skill 生态

**2026-05-11 重大决策**：终止自研 SRE Copilot 平台（Go + Vue 3 + eino Multi-Agent），全量转向 **Hermes Agent**。旧平台作为 PoC 已验证核心能力可行性，即日起停止新功能开发，所有运维能力重写为 Hermes 原生 Skill + 独立 MCP Server，旧平台在能力等价迁移后正式下线（端口 8080/8081 停服）。详见 [[2026-H1-集群智能运维OKR]]。

**能力迁移方向**：
- 21 个 MCP 工具 → 拆分为独立 MCP Server（Doris/Loki/VM/Zabbix/Foxeye/SSH）
- 19 个 Skills → 重写为 Hermes/agentskills.io 格式
- Doris 18 张表 → 数据保留，独立 MCP Server 通过 MySQL 协议直连

**关键待推进**：
- 🔄 Hermes 部署 + 独立 MCP Server 搭建（P0，DDL 05-31）
- 🔄 核心 Skill Hermes 重写 ≥5 个（DDL 06-15）
- 🔄 飞书/企微 ChatOps 上线（DDL 06-30）
- 🔄 告警迁移 IM 驱动 + 旧平台正式下线（DDL 07-15）

---

### 集群新特性进展

> 详见 [[2026-H1-集群组件高可用架构建设OKR]]（`OKR/OKR-new/`），覆盖 Knox HA / ATS HA / Dproxy→SCLB 三大项目。

| 项目 | 状态 | 说明 |
|---|---|---|
| 集群组件高可用架构建设 | 🔄 进行中 | Knox HA ✅ / ATS HA 60% / Dproxy→SCLB 30%，详见 OKR |
| NodeManager 容器化 | ⏳ 待办 | H2 规划 |
| 冷存集群 CA 方案 | ⏳ 待办 | H2 规划 |

---

### 计算治理进展

| 项目 | 状态 | 说明 |
|---|---|---|
| Spark 向量化（Gluten）作业画像 | ✅ 已上线 | 作业画像系统已上线，支持收益可视化 |
| Spark 向量化 bdwh 灰度实验 | 🔄 白名单遴选进行中 | 基于画像数据筛选 bdwh 高收益作业 |
| 计算治理统一可视化平台 | 🔄 进行中（40%） | React + Spring Boot + Doris；MVP 后端完成，前端样式重构中 |

---

### 开发语言与工具栈

- **Go**：SRE Copilot 平台后端、自研 Exporter（Hadoop/HBase/HS2）、AI Agent 工具链
- **Java (Spring Boot 17)**：计算治理可视化平台后端
- **React (TypeScript)**：计算治理可视化平台前端
- **Vue 3**：SRE Copilot 前端
- **Python**：脚本工具（Zabbix API 导出、Ambari 配置检查）
- **SaltStack**：集群配置管理与批量部署（Alloy 部署流水线）
- **eino**：CloudWego AI Agent 框架（Multi-Agent 编排核心）
