---
type: task
status: todo
priority: P0
deadline: 2026-06-15
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date:
tags: [Hermes, Skill, AiOps, 架构迁移]
depends_on: [Hermes 部署与基础设施对接]
---

# 核心 Skill 搬迁与 Hermes 适配

## 背景

SRE Copilot 现有 19 个 Skills（SKILL.md 格式，eino 框架），需转换为 Hermes/agentskills.io 兼容格式。优先搬迁 ≥ 5 个高频 Skill。

详见 [[2026-H1-集群智能运维OKR]] KR2。

## 现有 Skill 清单与优先级

| 优先级 | Skill | 现有 MCP 工具 | 使用频率 |
|---|---|---|---|
| P0 | `alert-diagnosis` | `query_metrics_*`, `get_recent_events_*`, `query_logs` | 最高 |
| P0 | `zabbix-migration` | `convert_rules_workflow`, `match_rules` | 高 |
| P0 | `cluster-inspection` | `draft_inspection_plan`, `execute_inspection` | 高 |
| P0 | `loki-log-query` | `query_logs` | 高 |
| P1 | `sre-troubleshooting` | `exec_cmd`, `list_hosts` | 中（含审批流） |
| P1 | `cpu-diagnosis` / `memory-diagnosis` | `query_metrics_*` | 中 |

## 转换规范

- 格式：现有 SKILL.md → agentskills.io 标准格式
- 工具引用：eino tool → MCP tool（Hermes 通过 MCP 连接自动发现，无需在 Skill 中硬编码工具列表）
- 指令：保留核心逻辑，去除 eino 框架特定语法
- 输出：利用 Hermes 原生的结构化输出能力

## 执行步骤

1. [ ] 选取 `alert-diagnosis` 为试点，制定转换模板
2. [ ] 转换 P0 Skills（alert-diagnosis / zabbix-migration / cluster-inspection / loki-log-query）
3. [ ] 每个 Skill 转换后在 Hermes 中验证功能等价性
4. [ ] 转换 P1 Skills（sre-troubleshooting + cpu + memory）

## 验收标准

- ≥ 5 个核心 Skill 在 Hermes 中通过端到端验证
- SSH 审批流在 Skill 中正确标记 `approval_required`
- Skill 输出质量不低于现有 eino 版本
