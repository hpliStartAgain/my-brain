# Ambari 告警转发 Foxeye 可行性评估报告

## 1. 需求背景

目前集群存在多源告警问题（主要包括 Zabbix、Foxeye 和 Ambari 原生告警），导致告警渠道分散，运维负担较重。鉴于目前已经成功实现通过 Agent（如 ACAA）将 Ambari 的配置变更事件转化为规范化日志并接入 Loki+Foxeye 的能力，现探讨采用类似 Agent 模式捕捉 Ambari 告警并转发至 Foxeye，从而实现告警渠道统一的可行性。

## 2. 技术可行性结论

**结论：完全可行，且技术风险极低。**

Ambari 具备完善的告警体系和外部接口，且已有 ACAA（Ambari Config Audit Agent）项目沉淀了成熟的 `日志/API -> 结构化 JSON -> Alloy 采集 -> Loki -> Foxeye(告警规则)` 的处理链路，完全可以复用该模式对告警数据进行流转。

## 3. 架构方案选型

针对 Ambari 告警的捕捉机制，有以下两种主流方案供选择：

### 方案 A：Ambari 原生自定义通知脚本 (Alert Dispatcher Script) 【轻量级事件驱动】
Ambari 的 Alert Target 支持配置为 `Custom` (即执行自定义脚本)。当告警状态发生变化（例如 OK -> CRITICAL）时，Ambari 内部的调度器会自动触发执行预设在宿主机上的脚本（如 Python 或 Bash），并将告警的详细上下文（告警定义名称、状态、文本内容、发生时间等）传递给脚本。

*   **数据流向**：Ambari Alert -> Custom Script -> 直接调用 Foxeye Webhook (或输出结构化 JSON 被 Alloy 采集)。
*   **优点**：
    *   **事件驱动**，实时性极高，不需要独立常驻轮询进程。
    *   **无状态处理**：不需要在外部处理繁琐的状态对比和去重逻辑，因为 Ambari 本身只在状态跃迁时触发通知。

### 方案 B：独立轮询 Agent (复用 ACAA 模式) 【架构解耦】
编写一个轻量级的 Go 守护进程（类似 ACAA），定时调用 Ambari 的 REST API 轮询当前告警状态的变化：
`GET /api/v1/clusters/<cluster>/alerts?Alert/state.in(WARNING,CRITICAL)`

*   **数据流向**：Ambari REST API -> Agent 轮询与内存状态对比 -> 追加写入 `ambari-alerts.json` -> Alloy 采集 -> Loki -> Foxeye (基于 LogQL 告警)。
*   **优点**：
    *   **架构解耦**，不会对 Ambari 核心进程造成任何潜在的性能影响。
    *   **复用基础设施**：与 ACAA 保持完全一致的交付模式和技术栈，运维体验统一。
*   **缺点**：需在 Agent 内部维护告警状态字典以防止重复触发，且存在轮询间隔时间差。

## 4. 实施建议与下一步计划

1.  **方案敲定**：考虑到团队目前正在推进基于 Loki 日志采集流水线的建设（`Foxeye基于Loki日志的告警规则添加.md`），推荐使用 **方案 B (独立 Agent + Alloy 采集 JSON 链路)**，或者采用 **方案 A 的变体** (脚本只负责落盘 JSON，不直推 Webhook)。这样可以保证事件数据沉淀到 Loki 中，方便二次溯源和检索。
2.  **Foxeye 接入对齐**：确认 Agent 输出的 JSON 中保留所需的静态标签字段（如 `cluster`、`service`、`alert_name`、`level` 等），以便能复用现有的 Foxeye Loki 告警模版。
3.  **原型开发验证**：
    *   可优先编写简单的脚本测试 Ambari Alert API 或 Custom Script 的 Payload 格式。
    *   重点评估**告警恢复事件 (CRITICAL -> OK)** 的处理流，确保 Foxeye 侧能实现告警的自动恢复闭环。