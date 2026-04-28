---
title: Eino AI Agent 开发指导手册
date: 2026-04-15
tags:
  - Eino
  - AI Agent
  - 编程 Agent
  - Go
aliases:
  - Eino AI Agent 开发指南
  - Eino 编程 Agent 最佳实践
---

# Eino AI Agent 开发指导手册

本文基于 Eino 官方文档、`cloudwego/eino`、`cloudwego/eino-ext` 与官方迁移记录整理，目标是给 **AI Agent / 编程 Agent 开发** 提供一份偏工程落地的使用准则。

## 一、先说结论：做 Eino Agent 时最重要的 12 条建议

### 1. 先判断任务是 **Graph** 还是 **Agent**，再决定抽象层

- **建议**：封闭、确定、强流程约束的任务优先用 `compose.Graph / Workflow`；开放式、多轮交互、需要自主决策的任务优先用 `ADK Agent`。
- **原因**：Eino 官方明确把 Graph 定义为“确定性流程”，把 Agent 定义为“LLM 驱动的自治系统”；两者解决的问题不是一个层面。
- **适用场景**：
  - Graph：文档解析、固定 ETL、RAG 索引构建、审批后固定执行链路。
  - Agent：编程助理、研究助理、多工具问题求解、交互式运维助理。
- **反例 / 风险**：把 ReAct 或复杂多轮协作强塞进 Graph，最后会在事件流、流式判断、上下文持久化上补很多“旁路逻辑”。

### 2. 把复杂确定性流程封装成 Tool，再交给 Agent 调用

- **建议**：最佳结合点通常不是“用 Graph 模拟 Agent”，而是“把 Graph 封成 Tool 给 Agent 用”。
- **原因**：官方在 `graph_or_agent.md` 中明确提出两者的最佳结合点是 **Graph as Tool**。
- **适用场景**：代码审查流水线、CI 诊断流水线、RAG 检索+重排+摘要链路、固定格式的数据处理。
- **反例 / 风险**：让 Agent 逐步拼装固定流程，既贵又不稳定，还不容易测试。

### 3. Tool 设计优先级高于 Prompt 微调

- **建议**：优先把 Tool 的 `Name / Desc / ParamsOneOf / JSONSchema` 设计清楚，再考虑 prompt 花活。
- **原因**：模型调用 Tool 的前提，是它能稳定理解“什么时候调、怎么调、参数长什么样”。
- **适用场景**：任何会被模型直接调用的 Tool。
- **反例 / 风险**：描述模糊、参数定义宽松、结构体 tag 不准确，会直接导致错调工具、漏字段、JSON 反序列化失败。

### 4. 能用 `InferTool` / `GoStruct2ParamsOneOf` 就不要手写参数 Schema

- **建议**：本地函数转 Tool 时，优先用结构体 tag + `utils.InferTool()`。
- **原因**：这样可以把“函数入参类型”和“模型看到的参数约束”绑定在一起，减少双份维护。
- **适用场景**：内部业务函数、Shell/Read/Grep/Fetch 等工具包装。
- **反例 / 风险**：手工维护 `ParamsOneOf` 和入参 struct 容易漂移，改了代码忘改 Schema，模型就会按旧参数继续调用。

### 5. ReAct Agent 的 `StreamToolCallChecker` 必须按模型特性校准

- **建议**：凡是做流式 Agent，都要验证模型输出 ToolCall 的习惯；必要时自定义 `StreamToolCallChecker`。
- **原因**：官方 FAQ 和 `react_agent_manual.md` 都强调，不同模型输出 ToolCall 的方式不同；例如有些模型会先吐文本再吐工具调用。
- **适用场景**：OpenAI、Claude、Ark、Gemini 等多模型接入；尤其是跨供应商统一 Agent 框架。
- **反例 / 风险**：默认 checker 不匹配时，会表现为“流式丢失”“进不了 ToolsNode”“明明要调工具却直接输出文本”。

### 6. 对编程 Agent，务必限制工具回合数与结果体积

- **建议**：同时控制 `MaxStep` 与工具输出长度；超长工具结果用 reduction middleware 卸载到文件系统。
- **原因**：编程 Agent 常见工具如 `grep/read_file/bash` 输出可能极长，若不治理，很快会撑爆上下文窗口。
- **适用场景**：代码库检索、终端执行、日志分析、配置巡检。
- **反例 / 风险**：上下文被工具结果淹没后，Agent 会开始遗忘目标、重复调用工具或产生幻觉式总结。

### 7. 把“用户打断 / 审批 / 追问 / 会话恢复”当成一等能力设计

- **建议**：需要人机协同时，优先按 CheckPoint + Interrupt + Resume 设计，而不是自己拼接 session cache。
- **原因**：Eino 在 v0.7 之后明显强化了 Interrupt/Resume 架构，并提供了类型安全的恢复能力。
- **适用场景**：审批执行 shell、危险操作确认、预算确认、缺参追问、长任务断点续跑。
- **反例 / 风险**：如果只记“对话历史”不记“执行位置 + 本地状态 + 中断 ID”，恢复后常常回不到正确节点。

### 8. 对会话历史做“改写”和“压缩”要区分场景

- **建议**：
  - `MessageModifier`：适合加 system prompt、单轮前置修饰。
  - `MessageRewriter`：适合对多轮 ReAct 持续生效的历史压缩或重写。
- **原因**：两者的持久化语义不同，官方手册已经明确区分。
- **适用场景**：长对话摘要、历史裁剪、加入策略提示、为模型注入当前任务上下文。
- **反例 / 风险**：把应该持久化的修改放到 Modifier，会导致下一轮丢失；反过来把临时提示放进 Rewriter，会污染后续历史。

### 9. Middleware 顺序就是行为顺序，别随便排

- **建议**：对 ChatModelAgent 的 middleware 做显式排序，典型顺序建议：
  1. `PatchToolCalls`
  2. `Summarization / Skill / ToolSearch`
  3. `Reduction`
  4. Filesystem / Sandbox 等执行型扩展
- **原因**：v0.8 起很多 Agent 行为都通过 middleware 生效；顺序错误会让后续中间件处理坏历史或错误上下文。
- **适用场景**：中断恢复、复杂工具集、长上下文编程 Agent。
- **反例 / 风险**：如果先 reduction 再 patch dangling tool calls，后面的模型看到的是“已裁剪但逻辑不闭合”的消息历史。

### 10. Filesystem / Shell 能力默认应该走受控后端，而不是裸本地

- **建议**：高风险场景优先使用受限 backend，例如本地受限目录或 Ark Sandbox。
- **原因**：Eino-ext 已经提供了本地和 sandbox 后端，说明官方也把“文件系统 / Shell 执行安全性”视为正式问题而不是 Demo 细节。
- **适用场景**：编程 Agent、运维 Agent、自动修复 Agent。
- **反例 / 风险**：让 Agent 对真实宿主机任意路径直接写删改，等于把“模型误判”升级成“生产事故”。

### 11. 一开始就埋 Callback / Trace，不要等出问题再补

- **建议**：对模型调用、Tool 调用、Graph 编译与运行都挂 callbacks；至少要拿到输入、输出、错误、节点路径。
- **原因**：Eino 的 callbacks 是正式能力，不是临时调试 hack；FAQ 也明确建议排查模型问题时打印实际请求。
- **适用场景**：任何线上 Agent。
- **反例 / 风险**：没有 event / callback / node path，出问题时你只能看到“context deadline exceeded”或者“400 Bad Request”，几乎无法定位。

### 12. 升级 Eino 时先读 release notes，不要直接 `go get -u`

- **建议**：至少检查 v0.6、v0.7、v0.8 的迁移记录，并同步升级相关 `eino-ext` module。
- **原因**：Eino 近几个版本演进快，存在 API、行为语义和默认值层面的 breaking change。
- **适用场景**：所有老项目升级。
- **反例 / 风险**：最典型的是 JSONSchema/OpenAPI 迁移、Interrupt/Resume 重构、filesystem 语义变化、middleware 行为迁移。

### 13. 中文 Agent 在初始化阶段显式设置 `adk.SetLanguage`

- **建议**：如果你的 Agent 面向中文用户或中文知识库，在程序启动时统一调用 `adk.SetLanguage(adk.LanguageChinese)`。
- **原因**：ADK 内置 prompt、filesystem/reduction/skill 等 middleware 的内置提示词会受全局语言设置影响。
- **适用场景**：中文 Copilot、中文运维 Agent、中文知识助手。
- **反例 / 风险**：运行时动态切语言，容易让同一会话里混入中英文系统提示，导致模型行为漂移。

## 二、Eino 适合怎么搭 AI Agent

## 2.1 推荐的分层方式

```text
用户请求
  ↓
Agent 层（ADK）
  - 决策
  - 任务分发
  - 多轮交互
  - 中断恢复
  ↓
Tool 层
  - 普通函数 Tool
  - GraphTool
  - Agent as Tool
  ↓
确定性执行层（compose.Graph / Workflow）
  - 固定业务流程
  - RAG pipeline
  - 数据清洗 / 文件处理 / 审批流水线
  ↓
外部系统
  - LLM
  - Filesystem / Shell
  - Search / DB / API
```

核心原则：

1. **自主决策放在 Agent 层**。
2. **确定性逻辑下沉到 Graph / Workflow / Tool**。
3. **高风险动作通过 HITL、审批 Tool 或 sandbox 限权**。

## 2.2 单 Agent 推荐起步姿势

对多数编程 Agent，我建议先从 `ChatModelAgent` 或 `flow/agent/react` 起步，而不是一开始就上多 Agent。

合适的最小闭环：

1. 一个支持 tool call 的 `ChatModel`
2. 一组精心定义的 Tool
3. `MessageModifier` 注入系统约束
4. `MaxStep` 控制最大循环
5. callbacks + 基础 tracing
6. 必要时接入 checkpoint / resume

只有当单 Agent 出现下面症状时，再拆多 Agent：

- 工具集合已经很大，提示词难以稳定选择
- 任务天然可分成若干专业角色
- 不同角色需要截然不同的记忆、指令或权限边界

## 三、组件选型与实现建议

## 3.1 ChatModel

- 必须选择支持 tool call 的模型，尤其是 ReAct / ChatModelAgent。
- 对多供应商模型统一接入时，不要假设流式 tool call 行为一致。
- 模型 API 问题优先打印真实 HTTP request，再用 curl/Postman 复现，别先怀疑框架。
- 新项目优先按 `ToolCallingChatModel.WithTools` / `ToolCallingModel` 的思路接入，不要继续围绕旧式绑定方式做封装。

**建议**：

1. 每种模型都单独做一次：
   - 非流式问答
   - 流式问答
   - 单 ToolCall
   - 多 ToolCall
   - ToolCall + 长文本混合输出
2. 每换一个模型实现，都重新验证 `StreamToolCallChecker`。

## 3.2 Tool

### Tool 设计 checklist

1. `Name` 是否短、唯一、可被模型清晰区分
2. `Desc` 是否说明“何时调用”
3. 参数是否明确 required / enum / description
4. 输出是否适合直接返回文本
5. 若输出可能很大，是否需要 reduction / file offload
6. 若动作危险，是否需要审批中断

### 对编程 Agent 的额外建议

- `read_file`、`grep`、`glob`、`edit`、`write`、`shell` 应拆成边界清晰的多个 Tool，不要做“大而全”的万能工具。
- 大结果工具必须返回“摘要 + 文件路径”或“分页能力”，不要一次性塞完整内容。
- 如果工具可能返回图片、音频、文件，优先考虑 Enhanced Tool。

## 3.3 Retriever / Embedding / Indexer

这部分更适合做“知识增强型 Agent”，不适合承载“即时执行逻辑”。

**建议**：

1. 让 Retriever 负责事实召回，不要把它当流程控制器。
2. 将“知识检索”和“动作执行”分成不同 Tool。
3. 如果是代码库 Agent，优先把代码搜索、符号检索、文档召回拆开，而不是混成一个笼统的“search”。

## 四、编排：怎么用 Graph / Workflow 托住 Agent

## 4.1 Eino 编排的核心哲学：类型对齐

Eino 和很多动态语言框架最大的不同，不在于“能不能搭图”，而在于它把 **上下游类型一致性** 当成第一原则。

这意味着：

1. 设计节点时先想输入输出类型，而不是先想 prompt。
2. 多分支汇合时优先使用 `WithInputKey / WithOutputKey` 做显式映射。
3. Graph 编译失败通常不是坏事，而是帮你提前发现建模错误。

## 4.2 什么时候用 Chain，什么时候用 Graph，什么时候用 Workflow

| 抽象 | 适用场景 | 不适合 |
|---|---|---|
| Chain | 线性流程、prompt -> model -> parser | 有复杂分支、循环、并行 |
| Graph | 需要 branch、并行、子图、显式边 | 需要业务字段级编排、任务结构很复杂 |
| Workflow | 更高层的结构化流程，字段级映射更强 | 非常简单的线性场景 |

**经验规则**：

- 线性的先用 Chain。
- 一旦出现“条件跳转 / 并发 / 子流程复用”，切 Graph。
- 当你发现自己在 `map[string]any` 上来回搬字段时，考虑 Workflow。

## 4.3 最推荐的模式：GraphTool

把确定性流程编成 Graph，再封装为 Tool，是 Eino 编程 Agent 最稳的姿势之一。

典型场景：

1. “检索仓库 -> 过滤文件 -> 汇总结果 -> 生成 diff 解读”
2. “读取告警 -> 拉上下文 -> 结构化分类 -> 生成摘要”
3. “RAG 检索 -> 重排 -> 证据抽取 -> 形成回答草稿”

这样做的价值：

- Agent 只负责决定“要不要调”
- Graph 负责保证“怎么调才稳定”
- 每一层都更可测、更可 debug

## 五、Agent / ADK 的使用建议

## 5.1 Agent 抽象的正确心智模型

Eino 的 `Agent` 不是“返回一个最终字符串”，而是 **Run 一个事件流**。

所以设计时要默认考虑：

1. 这个 Agent 会产生什么事件？
2. 哪些事件要展示给用户？
3. 哪些事件只用于系统内部协调？
4. 是否需要 `AgentRunOption` 做请求级覆写？

## 5.2 何时拆多 Agent

### 推荐拆分

- 专业能力差异极大：代码分析、shell 执行、文档检索、计划生成。
- 不同角色需要不同系统提示词、权限、工具集。
- 存在自然的主从结构：一个主 Agent 做调度，多个专家 Agent 做执行。

### 不建议拆分

- 只是想“显得更高级”
- 只是工具太多但实际上没有清晰边界
- 单 Agent 还没跑顺，就急着上 Supervisor / DeepAgent

## 5.3 典型模式怎么选

| 模式 | 适合什么任务 | 备注 |
|---|---|---|
| ChatModelAgent / ReAct | 通用单 Agent、自主调工具 | 最常见起点 |
| Sequential Agent | 明确串行的角色分工 | 如 Plan -> Write |
| Parallel Agent | 多来源并发采集 | 适合信息收集 |
| Loop Agent | 反思、评审、迭代优化 | 注意终止条件 |
| Supervisor | 主调度 + 专家分工 | 工具/子 Agent 边界要清晰 |
| Plan-Execute | 复杂任务拆步执行 | 适合长任务、需 replan |
| Host Multi-Agent | Host 判意图后切专家 | “路由”比“规划”更强 |

## 六、中断、记忆与恢复：编程 Agent 的生命线

## 6.1 什么时候必须上 CheckPoint / Resume

- 执行 shell / 文件修改前要审批
- 任务很长，中途可能断线
- 需要用户补参数
- 一个任务可能跨多轮继续
- 需要“恢复到特定中断点”而不是重跑整局

> [!INFO]
> `Session` 和 `Checkpoint` 不是一回事：
> - `Session` 负责跨轮或跨 Agent 共享业务信息。
> - `Checkpoint` 负责保存执行现场，支撑 interrupt / resume。
> 真正的生产 Agent 往往两者都需要，但不要把它们混成同一种“记忆”。

## 6.2 实践要点

1. **持久化存储**：正式环境用 Redis 等分布式存储，不要只用内存。
2. **稳定类型注册**：自定义状态对象要 `schema.RegisterName`，且名字一旦定了就不要乱改。
3. **稳定 Graph 拓扑**：恢复时必须保证编排结构不变。
4. **CallOption 一致**：恢复时应传入与初次运行一致的关键 option。
5. **流式拼接注册**：自定义流式 chunk 类型要注册 concat 方法。

## 6.3 编程 Agent 的常见 HITL 用法

1. **危险写操作审批**
   - `edit_file`
   - `write_file`
   - `run_shell`
2. **缺参追问**
   - “修哪个文件？”
   - “是否允许覆盖现有文件？”
3. **阶段确认**
   - 先给计划，再等用户确认是否执行

## 七、长上下文治理：Middleware 是生产 Agent 的关键

## 7.1 Reduction middleware

适用于工具结果极长的场景，能力分两段：

1. **Truncation**：工具返回太长时立刻截断，完整结果落盘。
2. **Clear**：总 token 太大时，把旧工具结果替换成文件路径。

**编程 Agent 强烈建议接入**，特别是：

- `grep`
- `read_file`
- `ls`
- `shell`
- `search_code`

额外建议：

- 默认 `字符数/4` 估算 token，对中文并不准；正式环境建议换成真实 tokenizer。
- `read_file` 这类工具通常可以针对 Tool 做差异化策略，不要一刀切。

## 7.2 PatchToolCalls middleware

这个中间件专门修复 **dangling tool calls**：Assistant 发起了 ToolCall，但历史中没有对应 Tool 消息。

对编程 Agent 尤其重要，因为用户经常会：

- 中途打断
- 换题
- 恢复旧会话
- 取消危险操作

**建议**：放在 middleware 链靠前位置。

## 7.3 Filesystem middleware / backend

对“会读写文件、执行命令、产出代码”的 Agent 来说，这是高价值能力，但必须配权限边界。

建议策略：

1. 开发环境：受限本地 backend
2. 共享环境：sandbox backend
3. 生产环境：最小权限目录 + 审批 + 全链路审计

## 八、可观测与调试

## 8.1 必须记录什么

最少记录：

1. 模型输入消息
2. 模型输出消息
3. Tool 名称与参数
4. Tool 返回结果长度
5. 节点路径 / AgentName / RunPath
6. 中断 ID / CheckPointID
7. 错误栈与 node path

## 8.2 两类调试工具都要会用

1. **Callback / Trace**
   - 看运行时输入输出
   - 看事件流
   - 看节点错误
2. **Visual DevOps 工具**
   - 看拓扑结构
   - 看图的中间态
   - 辅助理解复杂编排

## 九、面向编程 Agent 的一套推荐骨架

```text
入口 Agent（ChatModelAgent / ReAct）
  ├─ Tool: read_file / grep / glob / edit / shell / web_fetch
  ├─ Tool: graph_tool(codebase_diagnosis)
  ├─ Middleware: patchtoolcalls
  ├─ Middleware: reduction
  ├─ Callback: tracing / logging
  ├─ CheckPointStore: Redis
  └─ HITL: 对写文件、执行 shell 做审批中断
```

如果任务进一步复杂，再演化成：

```text
Supervisor
  ├─ Research Agent
  ├─ Coding Agent
  ├─ Shell Agent
  └─ Review Agent
```

但请注意：**先把单 Agent 打磨稳定，再拆多 Agent。**

## 十、常见坑位清单

1. **Tool 参数 JSON 反序列化失败**
   - 常见原因是模型输出被截断或 schema 定义不清。
2. **流式模式下不进入 ToolsNode**
   - 十有八九和 `StreamToolCallChecker` 有关。
3. **Checkpoint 恢复失败**
   - Graph 结构变了，或自定义类型没稳定注册。
4. **升级后工具 schema 报错**
   - v0.6 起 OpenAPI 迁移到 JSONSchema。
5. **超时错误难定位**
   - 要结合 `node path` 判断是上游 context 超时还是外部模型/HTTP client 超时。
6. **工具结果撑爆上下文**
   - 不做 reduction，编程 Agent 迟早炸。
7. **会话恢复后模型 API 报错**
   - 先检查 dangling tool calls，再看 patch middleware。
8. **多模态字段传了但模型没收到**
   - 往往是 `eino-ext` 模型包版本老。

## 十一、我给 Eino 编程 Agent 的落地建议

### 最推荐的组合

1. `ADK ChatModelAgent` 负责决策
2. `GraphTool` 负责确定性复杂流程
3. `InferTool` 负责函数级能力封装
4. `PatchToolCalls + Reduction` 负责会话治理
5. `CheckPoint + HITL` 负责人机协同
6. `Sandbox / 受限 Filesystem` 负责安全边界

### 不推荐的组合

1. 一个超级万能 Tool 承载所有文件系统能力
2. 用 Graph 生拼硬凑出完整多 Agent 自治系统
3. 不做 callbacks 就直接上生产
4. 不看 release notes 就直接升级主版本

## 十二、建议重点阅读的官方文档

1. `overview/graph_or_agent.md`
2. `core_modules/chain_and_graph_orchestration/orchestration_design_principles.md`
3. `core_modules/components/tools_node_guide/how_to_create_a_tool.md`
4. `core_modules/flow_integration_components/react_agent_manual.md`
5. `core_modules/eino_adk/agent_interface.md`
6. `core_modules/eino_adk/agent_quickstart.md`
7. `core_modules/eino_adk/agent_hitl.md`
8. `core_modules/chain_and_graph_orchestration/checkpoint_interrupt.md`
9. `core_modules/eino_adk/Eino_ADK_ChatModelAgentMiddleware/Middleware_ToolReduction.md`
10. `core_modules/eino_adk/Eino_ADK_ChatModelAgentMiddleware/Middleware_PatchToolCalls.md`
11. `FAQ.md`
12. `release_notes_and_migration/*`

## 十三、最后的判断

如果你的 Agent 项目偏 **Go、生产级、重类型约束、强调流程可控和恢复能力**，Eino 值得认真投入；它真正强的地方不是“写几个 Demo 很快”，而是 **Graph 与 Agent 分层清晰、类型约束强、HITL 和中断恢复做得越来越像正式工程能力**。
