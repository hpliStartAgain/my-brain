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
├── Inbox-Task池/           # 所有具体任务文件，按任务域分类存放
│   ├── 集群新特性/         # 新功能、高可用、架构升级类任务
│   ├── 集群可观测建设/     # Exporter、Loki 日志采集、告警规则等
│   ├── 集群智能运维/       # AiOps、告警迁移、根因分析等
│   ├── 集群日常运维/       # 参数调整、配置检查、组件重启等
│   └── 计算治理/           # Spark 向量化、作业画像、资源治理等
└── Outbox-产出池/          # 已完成任务的最终输出文件（方案报告、设计文档等）
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

### Outbox 产出池

任务完成后，最终对外输出的文档（方案报告、设计文档）移入 `Outbox-产出池/`，原 `Inbox-Task池/` 中的任务文件**保留**（作为过程记录），任务 frontmatter 更新 `status: done` 和 `completed_date`。

---

## 当前主要任务域（上下文参考）

- **大数据集群基础设施**（HDFS、YARN、HiveServer、Spark、Flink、Kafka），使用 Ambari 管理，Kerberos 认证
- **可观测体系**：Prometheus + 自研 Exporter + Loki（Promtail 采集）+ Foxeye（告警平台）
- **AiOps 方向**：适配大数据集群场景的根因分析与智能告警（非微服务 Trace 模型）
- **工具开发语言**：Go（如 ACAA 审计日志守护进程）
