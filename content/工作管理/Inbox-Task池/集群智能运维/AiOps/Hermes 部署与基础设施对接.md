---
type: task
status: todo
priority: P0
deadline: 2026-05-31
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-05-11
tags: [Hermes, AiOps, MCP, 架构迁移]
---

# Hermes 部署与基础设施对接

## 背景

SRE Copilot 平台从「自建 eino Agent + Vue Web UI」转向「Hermes Agent + Skill 生态 + IM」。本任务是新架构的第一步：部署 Hermes 并验证与现有基础设施的兼容性。

详见 [[2026-H1-集群智能运维OKR]] KR1。

## 现有资产

- MCP Server：端口 8081，21 个工具就绪
- LLM API：`aix-internal.panther.sohurdc.com/v1`（DeepSeek，OpenAI 兼容）
- Doris DB：18 张表，数据完整

## 执行步骤

1. [ ] 调研 Hermes 部署方式（Docker 优先，评估离线部署可行性）
2. [ ] 部署 Hermes Agent（内网服务器）
3. [ ] 配置 LLM 后端：接入 `aix-internal` DeepSeek 端点
4. [ ] 连接 MCP Server：`localhost:8081/sse`，验证 21 个工具可被发现
5. [ ] 测试基础对话：最简单的 tool call（如 `search_metrics "hdfs"`）
6. [ ] 申请飞书/企微 Bot（启动审批流程，耗时较长可并行）

## 验收标准

- Hermes 在内网正常运行
- MCP 连接成功，21 个工具在 Hermes 中可用
- 至少完成 1 轮完整的 tool call 对话
