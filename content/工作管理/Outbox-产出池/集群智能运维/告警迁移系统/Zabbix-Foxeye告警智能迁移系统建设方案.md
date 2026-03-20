# Zabbix → Foxeye 告警智能迁移系统建设方案

> **版本**: v2.1
> **日期**: 2026-03-20
> **负责人**: 李浩鹏
> **技术栈**: Go 1.24 + Vue 3 + MySQL 8.0 + LLM（deepseek）

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状与痛点](#2-现状与痛点)
3. [方案总览](#3-方案总览)
4. [核心功能设计](#4-核心功能设计)
5. [多 Agent 架构](#5-多-agent-架构)
6. [双跑校验机制](#6-双跑校验机制)
7. [数据模型设计](#7-数据模型设计)
8. [分阶段实施计划](#8-分阶段实施计划)
9. [验收标准](#9-验收标准)
10. [风险与规避](#10-风险与规避)

---

## 1. 背景与目标

### 1.1 背景

集群当前使用 **Zabbix** 作为主要告警平台，历史积累了大量针对大数据组件（HDFS、YARN、Hive、HBase、ZooKeeper 等）的告警规则。

**Foxeye**（基于 Nightingale 深度定制）是内部新一代告警平台，支持 PromQL 告警规则，与 Prometheus 监控体系深度集成，具备更强的告警收敛、降噪和可视化能力。

战略方向是将告警体系从 Zabbix 全面迁移至 Foxeye，但 Zabbix 与 Foxeye 的规则语法、数据模型差异显著，人工逐条翻译效率极低，且存在遗漏风险。

### 1.2 目标

建设一套 **AI 辅助的自动化告警迁移平台**，实现：

| 目标 | 说明 |
|------|------|
| 自动化转换 | LLM 将 Zabbix 触发器自动翻译为 Foxeye PromQL 规则 |
| 语义匹配 | 识别已存在的 Foxeye 规则与 Zabbix 规则的对应关系 |
| 双跑验证 | 双平台并行运行，统计覆盖率和延迟，量化验证迁移质量 |
| 全流程可视化 | 提供 Web UI，支持规则管理、转换进度跟踪、双跑看板 |
| 平滑下线 | 验证通过后逐步禁用 Zabbix 规则，实现无感知切换 |

---

## 2. 现状与痛点

### 2.1 Zabbix 现状

- 覆盖组件：HDFS、YARN、Hive、HBase、ZooKeeper、Ambari、Ranger 等
- 规则组织方式：模板（Template）→ 触发器（Trigger），按模板组分类
- 表达式语法：Zabbix 专有函数（`last()`, `avg()`, `min()` 等），与 PromQL 不兼容

### 2.2 迁移痛点

| 痛点 | 影响 |
|------|------|
| 语法差异大 | Zabbix 表达式 → Foxeye PromQL，需要理解指标语义才能翻译 |
| 规模大 | 数百条告警规则，人工翻译耗时数周 |
| 遗漏风险 | 无系统化手段跟踪哪些已迁移、哪些仍在双跑、哪些可下线 |
| 无验证机制 | 无法量化评估 Foxeye 规则是否真正覆盖了 Zabbix 的告警场景 |

---

## 3. 方案总览

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Web UI（Vue 3）                            │
│  对话界面 │ 规则管理 │ 业务组管理 │ 双跑看板 │ 统计大盘        │
└──────────────────────────┬───────────────────────────────────┘
                           │ REST API / SSE
┌──────────────────────────▼───────────────────────────────────┐
│                  后端服务（Go + Gin）                          │
│                                                               │
│  ┌─────────────────────────────────────────┐                 │
│  │         多 Agent 系统（eino 框架）         │                 │
│  │  Master Agent  →  Converter Agent        │                 │
│  │      ↕              ↕                    │                 │
│  │  Matcher Agent    LLM（deepseek）         │                 │
│  └─────────────────────────────────────────┘                 │
│                                                               │
│  定时任务：Zabbix同步 │ Foxeye同步 │ 事件采集 │ 双跑统计        │
└──────┬──────────────────────────────────────────┬────────────┘
       │                                          │
┌──────▼──────┐  ┌──────────────┐  ┌─────────────▼────────────┐
│   Zabbix    │  │ MySQL（数据库）│  │         Foxeye           │
│  JSON-RPC   │  │ 规则/映射/统计 │  │  REST API / PromQL 查询  │
└─────────────┘  └──────────────┘  └──────────────────────────┘
```

### 3.2 迁移流程总览

```
Step 1: Zabbix 全量同步
  └─ 模板组 → service，模板名 → component，触发器 → rule

Step 2: Foxeye 业务组管理
  └─ 配置 BGID 与组件的映射关系

Step 3: LLM 语义匹配（自动）
  └─ 指纹精确匹配（快速）+ LLM 语义理解（准确）

Step 4: 转换生成 Foxeye JSON
  └─ Converter Agent 生成 PromQL 规则，用户确认后推入 Foxeye

Step 5: 双跑校验（自动）
  └─ 两侧告警事件配对，计算覆盖率和延迟

Step 6: 禁用 Zabbix
  └─ 覆盖率≥80% 且延迟≤3min 后，一键禁用 Zabbix 对应规则
```

---

## 4. 核心功能设计

### 4.1 规则分类管理

Zabbix 规则按 **服务（service）→ 组件（component）** 两级分类，便于按团队分工管理：

- **自动分类**：同步时从模板组名推导 service，从模板名提取 component
- **手动调整**：UI 支持对自动分类错误的规则手动修正（标记 `manually_classified`，后续同步不覆盖）

### 4.2 迁移状态流转

每条 Zabbix 规则的迁移状态按以下路径流转：

```
unmatched
    │ 指纹匹配或 LLM 匹配
    ▼
pending_confirmation（待用户确认）
    │ 用户确认
    ▼
matched（已匹配，进入双跑）
    │ 双跑通过
    ▼
deprecated（Zabbix 规则已禁用）
```

若 LLM 无法找到对应规则，则走转换流程：

```
unmatched
    │ 批量转换
    ▼
pending_review（已生成 Foxeye JSON，待推入）
    │ 用户推入 Foxeye + 重新同步
    ▼
matched → deprecated
```

### 4.3 批量 LLM 转换

UI 支持批量选择 `unmatched` 状态的规则，通过 **SSE 流式输出**实时展示转换进度：

```
event: progress   → {"rule_id": 1, "description": "NameNode HeapMemory", "status": "converting"}
event: result     → {"rule_id": 1, "status": "success", "summary": "已生成 Foxeye JSON"}
event: result     → {"rule_id": 2, "status": "failed", "reason": "metric_not_found"}
event: done       → {"success_count": 8, "failed_count": 2}
```

转换成功的规则展示可编辑 JSON，支持下载/复制，用户手动在 Foxeye 创建后同步回平台完成关联。

---

## 5. 多 Agent 架构

系统采用三个 LLM Agent 分工协作，使用 cloudwego eino 框架编排：

### 5.1 Agent 分工

```
┌─────────────────────────────────────────────────────────────┐
│                   Master Agent（deepseek-v3）                 │
│                                                               │
│  职责：对话理解、任务规划、工具编排                             │
│  工具：查询 Zabbix 模板/规则、查询 Foxeye 规则、搜索指标元数据  │
│        调用 Converter Agent、调用 Matcher Agent               │
└──────────────────────────────┬──────────────────────────────┘
                               │ 任务委派
          ┌────────────────────┴─────────────────────┐
          │                                          │
┌─────────▼────────────────┐          ┌─────────────▼──────────────┐
│  Converter Agent          │          │  Matcher Agent             │
│  （deepseek-r1）           │          │  （deepseek-v3）            │
│                           │          │                            │
│  职责：规则语法转换         │          │  职责：规则语义匹配          │
│  输入：Zabbix 触发器        │          │  输入：Zabbix 规则 + Foxeye │
│       + 指标元数据          │          │        规则列表             │
│  输出：Foxeye JSON（严格格式）│          │  输出：匹配关系 + 置信度    │
│  批次：每批最多5条           │          │        + 匹配理由          │
└───────────────────────────┘          └────────────────────────────┘
```

### 5.2 规则转换示例

**输入（Zabbix 触发器）**：
```
名称: NameNode Heap Memory Usage High
表达式: {hadoop-hdfs:jmx.heapMemoryUsage.used.last()}/{hadoop-hdfs:jmx.heapMemoryUsage.max.last()} > 0.85
优先级: HIGH
```

**输出（Foxeye PromQL 规则）**：
```json
{
  "name": "NameNode Heap Memory Usage High",
  "prom_ql": "jvm_memory_bytes_used{job='hadoop-hdfs',area='heap'} / jvm_memory_bytes_max{job='hadoop-hdfs',area='heap'} > 0.85",
  "severity": 2,
  "for_duration": "5m",
  "annotations": {
    "summary": "NameNode JVM Heap 使用率超过 85%",
    "zabbix_origin": "template=hadoop-hdfs, trigger_id=12345"
  }
}
```

---

## 6. 双跑校验机制

双跑校验是迁移质量保证的核心，通过量化指标决策 Zabbix 规则是否可以安全下线。

### 6.1 数据采集

每小时采集完整的告警事件窗口 `[now-2h, now-1h]`（使用固定偏移保证数据完整性）：

- **Zabbix 侧**：通过 Zabbix API 按 trigger_id 拉取历史事件
- **Foxeye 侧**：通过 Foxeye API 按 BG + rule_id 拉取历史事件

### 6.2 配对算法

```
遍历所有 match_status=matched 的规则映射
  ↓
按 host 维度对齐两侧事件
  ↓
配对时效窗口：±3 分钟（180 秒）
  ↓
统计：matched_pairs / zabbix_count = coverage_rate
计算：avg(foxeye_time - zabbix_time) = avg_delay_sec
```

**配对窗口选择依据**：
- Prometheus 最长抓取间隔：1 分钟
- Zabbix 检查周期：1~2 分钟
- 告警状态处理延迟：≤30 秒
- 3 分钟覆盖 99% 的真实配对

### 6.3 Verdict 判定

| Verdict | 条件 | 含义 |
|---------|------|------|
| `replaceable` | 覆盖率 ≥ 80% 且平均延迟 ≤ 3 分钟 | ✅ 可安全禁用 Zabbix |
| `high_overlap` | 覆盖率 ≥ 80% 且延迟 ≤ 10 分钟 | 🟡 覆盖充分，延迟稍高，可接受 |
| `partial_overlap` | 覆盖率 ≥ 50% | 🟠 部分覆盖，需优化 PromQL |
| `low_overlap` | 覆盖率 < 50% | 🔴 覆盖不足，规则可能有误 |
| `insufficient_data` | Zabbix 侧事件 < 3 条 | ⚪ 样本不足，继续观察 |

**达到 `replaceable` 后**，运维人员可在 UI 一键调用禁用接口，系统自动通过 Zabbix API 将对应触发器置为禁用状态。

---

## 7. 数据模型设计

### 7.1 核心实体关系

```
zabbix_rules ──< rule_mappings >── foxeye_rules
                     │
                     └──< dual_run_stats
                              │
                     alert_events (两侧均写入)

business_groups  (Foxeye 业务组管理)
users ──< conversations ──< messages
metric_definitions (Prometheus 指标元数据)
```

### 7.2 关键状态字段

**rule_mappings.match_status**：

| 状态 | 说明 |
|------|------|
| `unmatched` | 未找到对应 Foxeye 规则 |
| `pending_review` | 已生成转换结果，待推入 Foxeye |
| `pending_confirmation` | LLM 找到候选规则，待用户确认 |
| `matched` | 已确认关联，进入双跑 |
| `deprecated` | Zabbix 规则已禁用，迁移完成 |

**rule_mappings.match_method**：

| 方法 | 说明 |
|------|------|
| `auto_fingerprint` | 规则名称/表达式指纹精确匹配 |
| `auto_llm` | LLM 语义理解匹配 |
| `manual` | 用户手动关联 |

---

## 8. 分阶段实施计划

### 阶段一：核心功能开发（当前）

| 模块 | 状态 |
|------|------|
| 后端 Go 项目骨架（Gin + GORM + eino） | ✅ 完成 |
| 数据模型设计（v2.1） | ✅ 完成 |
| Zabbix JSON-RPC 客户端 | ✅ 完成 |
| Foxeye REST API 客户端 | ✅ 完成 |
| Master Agent（ReAct 框架） | ✅ 完成 |
| Converter Agent（规则转换） | ✅ 完成 |
| Matcher Agent（语义匹配） | ✅ 完成 |
| 定时任务（Zabbix同步/Foxeye同步/事件采集） | ✅ 完成 |
| 双跑统计任务（配对算法 + Verdict） | ✅ 完成 |
| 前端 Vue 3 页面框架 | ✅ 完成 |
| API 接口联调测试 | 🔄 进行中 |
| 前后端集成验证 | ⬜ 待开始 |

### 阶段二：Zabbix 存量规则梳理

- [ ] 从 Zabbix 导出全量触发器，分析 service/component 分布
- [ ] 识别高频触发、高优先级规则，作为首批迁移目标
- [ ] 核对 Foxeye 中已有规则，建立初始映射关系

### 阶段三：系统上线与首批迁移

- [ ] 部署系统至生产环境
- [ ] 完成 Zabbix 全量同步（覆盖 HDFS/YARN/Hive 三个核心组件）
- [ ] 首批：对 HDFS 组件规则完成匹配/转换，进入双跑

### 阶段四：全量迁移与规则下线

- [ ] 扩展至 HBase、ZooKeeper、Ambari、Ranger 等组件
- [ ] 对 Verdict = replaceable 的规则逐步禁用 Zabbix
- [ ] 目标：核心组件告警规则 100% 迁移至 Foxeye

---

## 9. 验收标准

- [ ] Zabbix 全量同步正常，HDFS/YARN/Hive 规则可在 UI 中查看和管理
- [ ] LLM 批量转换成功率 ≥ 80%（失败原因主要为指标不存在，可人工补录）
- [ ] 语义匹配置信度 ≥ 0.8 的规则，人工复核准确率 ≥ 90%
- [ ] 双跑校验数据每小时正常产出，覆盖所有 matched 状态规则
- [ ] HDFS 核心规则（NameNode / DataNode）双跑 Verdict 达到 `high_overlap` 以上
- [ ] Web UI 对话界面可正常与 Master Agent 交互，SSE 流式输出无断流
- [ ] 告警禁用功能可正常调用 Zabbix API，禁用状态同步回系统

---

## 10. 风险与规避

| 风险 | 影响 | 规避措施 |
|------|------|---------|
| LLM 生成的 PromQL 语义不正确 | Foxeye 规则误告警或漏告警 | 所有 LLM 转换结果需人工确认后才推入 Foxeye，双跑校验作为兜底验证 |
| Foxeye 中缺少对应指标 | 转换失败，规则无法迁移 | 记录缺失指标清单，推动 Exporter 补录，人工兜底告警规则 |
| 双跑期间 Zabbix 规则告警漏发 | 业务感知到告警空窗 | 双跑期间 Zabbix 不禁用，两侧同时运行，确保告警不丢失 |
| LLM API 不稳定导致转换中断 | 批量转换任务失败 | SSE 流式进度可中途恢复；单条失败不影响其他规则 |
| Zabbix 规则量大导致同步耗时 | 首次全量同步超时 | 首次同步分批执行（按模板组），后续增量同步 |
| 指纹匹配漏召回导致重复规则 | Foxeye 出现重复告警 | LLM 语义匹配作为第二层兜底，匹配结果人工确认前不自动推送 |
