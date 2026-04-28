---
title: "Foxeye 指标元数据管理能力建设提案"
date: 2026-04-21
tags: [AiOps, Foxeye, 指标元数据, 能力建设]
type: proposal
status: draft
domain: 集群智能运维
---

# Foxeye 指标元数据管理能力建设提案

**提案人**：李浩鹏（大数据基础设施 SRE）
**面向**：Foxeye 平台团队负责人
**背景**：本文基于 AiOps 项目（`zabbix-foxeye-transfer`）的实际开发经历，记录了我在 Agent 能力建设中发现的一个基础能力缺口，并提出一个具体的合作方向供讨论。

---

## 一、问题的发现：一次不得不绕路的经历

在为大数据集群构建 AI 告警分析 Agent 时，我需要让 Agent 具备「根据自然语言描述生成可执行 PromQL」的能力。这个能力的前提是：**Agent 要知道当前系统里有哪些指标、每个指标有哪些 label、每个 label 的合法取值是什么**。

这是一个基础的「指标目录」问题。我的第一反应是：Foxeye 作为我们的监控平台，应该有这个信息——毕竟它管理着所有采集配置，VictoriaMetrics（VM）里存着所有时序数据。但当我深入调查时，发现：

**Foxeye 目前没有提供任何指标元数据的查询接口。**

VM 底层技术上支持这类查询（`/api/v1/series`、`/api/v1/label/__name__/values` 等），但这些接口对于大规模数据集来说**性能开销很大**，Foxeye 团队出于合理考量，没有将其封装成可用的上层接口暴露出来。结果就是：Foxeye + VM 这套体系，在指标元数据的管理层面，存在一个完整的能力空白。

---

## 二、AiOps 的探索：一个可用但不完美的 Workaround

面对这个空白，我在 AiOps 项目里自己搭了一套，以下是诚实的描述。

### 2.1 数据采集链路

采集走两条并联的路径：

**主链路（优先走）**：
```
Foxeye InputConfig API (/input_configs?bgid=xxx)
    → 获取业务组下所有采集器列表（含 inputConfigId）
    → 对每个 collector 并发请求 VM /api/v1/series?match[]={inputConfigId="xxx"}
    → 聚合去重，得到该业务组的指标名 + label_keys
```

**回退链路（主链路失败时）**：
```
VM /api/v1/label/__name__/values?match[]={busiGroupId="xxx"}
    → 直接按业务组 label 过滤，性能更差，但能兜底
```

> [!WARNING]
> 回退链路不稳定：依赖 VM 上每个时序都打了 `busiGroupId` label，而不是所有 exporter 都有这个标签。主链路更可靠，因为它从采集侧（InputConfig）出发，和实际配置保持一致。

### 2.2 增量同步与本地存储

采集到的指标信息做增量 diff 后写入 AiOps 自建的 `metric_definitions` 表（Doris），当前采用每日定时同步（23:30）。

数据模型：
```go
type MetricDefinition struct {
    MetricName    string    // 指标名，如 node_cpu_seconds_total
    LabelKeys     []string  // label 列表，如 ["instance","job","mode"]
    ComponentName string    // 所属服务，如 "node-exporter"
    MetricType    string    // gauge/counter/histogram
    HelpText      string    // 指标说明
    ExporterURL   string    // 所属 exporter 地址
    ManualService string    // 手动覆盖的服务归属（防自动分类覆盖）
}
```

### 2.3 下游用途

这套元数据目前支撑了两个功能：

**用途一：Agent PromQL 生成**
```
用户："查一下 nn1 节点的 CPU 使用率"
  → search_metrics Tool 查 metric_definitions 表，返回候选指标 + label_keys
  → Agent 结合 label_keys 生成合法 PromQL
  → query_metric_label_values Tool 调 VM 实时验证 label 值大小写（如 state="Live"）
```

**用途二：前端指标目录页**
AiOps 前端的指标目录页直接查 `metric_definitions` 表，展示指标名、所属服务、label 列表。

### 2.4 诚实的缺陷盘点

> [!INFO]
> 以下是这套实现目前已知的不完善之处，我认为在提案中直接说清楚比掩盖更有价值。

| 缺陷 | 说明 |
|:--|:--|
| **服务归属自动分类不准** | 通过采集器名称启发式映射到 `component_name`，准确率大约 70%，边缘 exporter 经常分错 |
| **ManualService 是 workaround** | 为了防止手动修正被每日 cron 覆盖，加了 `manual_service` 字段跳过自动更新——这是不优雅的设计 |
| **同步延迟** | 每日一次，新采集器接入后最长 24 小时数据才能进 Agent 上下文 |
| **数据孤岛** | 这份元数据只有 AiOps 在用，Foxeye 其他功能（告警规则编辑、指标搜索等）不能复用 |
| **维护成本转嫁** | 目前这套能力由我维护，而采集配置的生命周期归 Foxeye 管，不应该是这样的架构 |

---

## 三、为什么这个能力应该在 Foxeye 侧建设

站在架构的角度，指标元数据的「自然宿主」是 Foxeye，而不是 AiOps。理由有三：

**1. 数据源头在 Foxeye**
Foxeye 管理采集配置（InputConfig），它在任何时刻都知道「当前有哪些 exporter 在跑、分属哪些业务组」。相比之下，VM 是数据存储层，它知道「过去写入过哪些时序」，但不知道采集配置的语义。AiOps 作为下游应用，从两个上游拼凑信息，本质上是绕路。

**2. 性能问题可以在 Foxeye 侧解决**
VM 直查性能差的根因是没有缓存层。Foxeye 可以在采集配置变更时（增加/删除采集器）触发主动同步，而不是像 AiOps 现在这样每日全量轮询。这样既有实时性，又控制了 VM 的查询压力。AiOps 自己做这个，缺少 Foxeye 的配置变更事件通知，只能用 cron 弥补。

**3. 能力共建，避免数据孤岛**
如果这套元数据在 Foxeye 侧以 API 形式暴露出来，不仅 AiOps 可以用，Foxeye 的告警规则编辑器、指标搜索、用量分析等功能都可以复用，平台整体能力会提升一个层级。

---

## 四、方案选项对比

以下三个方向，供讨论：

| 方案 | 描述 | 优点 | 缺点 |
|:--|:--|:--|:--|
| **A. Foxeye 建设元数据管理模块** | Foxeye 在采集配置写入时同步触发元数据采集，提供 REST API 暴露 | 架构清晰，解决数据孤岛，性能可控 | 需要 Foxeye 开发投入 |
| **B. AiOps 维持现状并优化** | 继续在 AiOps 侧维护，改进服务归属算法，接入 Foxeye webhook 做实时同步 | 不依赖 Foxeye 排期 | 仍是数据孤岛，`manual_service` workaround 继续存在 |
| **C. Agent 直查 VM（无缓存）** | 每次 Agent 运行时实时查 VM series API | 数据最实时 | 查询延迟不可接受（秒级），并发下 VM 压力大，不可行 |

**我的建议是方案 A**，由我主导开发，Foxeye 侧提供：
1. 采集配置变更的事件 hook（或 webhook）
2. 一个元数据查询 API（`GET /metric_metadata?bgid=xxx&metric_name=xxx`）

---

## 五、我可以做什么

如果 Foxeye 侧愿意推进方案 A，我可以承担以下工作：

- [ ] 设计元数据采集调度逻辑（基于 InputConfig 变更事件，而非 cron）
- [ ] 实现服务归属的自动分类算法（基于 help_text + metric_name 前缀，准确率预计 > 90%）
- [ ] 开发元数据查询 REST API（含分页、按 bgid/component/metric_name 过滤）
- [ ] 提供 AiOps 侧的迁移方案（将 `metric_definitions` 表查询切换到 Foxeye API）

你们负责的部分只有两件事：**提供采集配置变更的通知机制**，以及**决定元数据在 Foxeye 的存储位置**（我可以配合接受任何方案）。

---

## 六、开放性问题

在讨论之前，我有几个问题想先和你对齐：

1. Foxeye 目前是否有采集配置变更的 event/hook 机制？还是只能通过轮询 InputConfig API 感知变化？
2. Foxeye 对「指标元数据」这个概念的接受度如何？是否有类似的 roadmap？
3. 如果我在外部（AiOps）开发完整的元数据管理后，是否有可能以某种形式将它集成回 Foxeye？

---

## 附录：AiOps 现有实现参考

> [!INFO]
> 以下是当前 AiOps 实现的关键代码路径，供参考对照。

**采集链路**：`backend/internal/client/foxeye_client.go`
- `GetMetricNames(bgid)` → 主链路：遍历 InputConfig → 并发查 VM series
- 回退：`VM /api/v1/label/__name__/values?match[]={busiGroupId="xxx"}`

**存储层**：`backend/internal/store/metric_store.go`
- 增量 diff：按 `metric_name` 对比，新增/更新/跳过（`manual_service` 保护）
- 表：`metric_definitions`（Doris）

**Agent 工具**：`backend/internal/tools/metric_tools.go`
- `search_metrics`：按关键词查 `metric_definitions`，返回 `{metric_name, label_keys, component_name, help_text}`
- `query_metric_label_values`：实时调 VM `/api/v1/label/{name}/values`，验证 label 真实取值
