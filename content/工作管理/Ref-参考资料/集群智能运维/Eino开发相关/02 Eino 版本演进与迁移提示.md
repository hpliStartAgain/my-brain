---
title: Eino 版本演进与迁移提示
date: 2026-04-15
tags:
  - Eino
  - 迁移
  - 发布记录
  - Go
aliases:
  - Eino 迁移指引摘要
  - Eino 版本变更摘要
---

# Eino 版本演进与迁移提示

本文聚焦近几个关键版本对 AI Agent 开发影响最大的变更，不追求逐条抄 release notes，而是帮助你判断 **哪些升级会影响现有编程 Agent 项目**。

## 一、整体演进主线

从官方文档与 release notes 看，Eino 的主线很清晰：

1. **早期**：打基础，完成组件抽象、compose、Graph/Chain 能力。
2. **v0.5**：正式引入 ADK，开始把 Agent 当成第一等公民。
3. **v0.6**：从 OpenAPI 3.0 体系转向 JSONSchema，清理工具参数定义债务。
4. **v0.7**：Interrupt / Resume 做架构级重构，HITL 进入可正式使用阶段。
5. **v0.8**：大量 Agent 行为通过 middleware 外挂化，文件系统、技能、工具治理等能力强化。

一句话概括：**Eino 正在从“LLM 编排框架”快速演进为“带工程化运行时的 Agent 框架”。**

## 二、v0.5：ADK 正式登场

### 核心变化

- 引入 ADK（Agent Development Kit）
- 提供 `ChatModelAgent`
- 提供 Agent as Tool
- 提供 Supervisor、Sequential、Plan-Execute-Replan 等预置模式
- 引入会话管理、中断恢复、SessionValues 等能力

### 对项目的意义

如果你之前只在 `compose` 层写“类 Agent 流程”，从 v0.5 开始应重新审视是否迁移到 ADK。

### 迁移建议

1. 原有“手搓 ReAct”的项目，优先评估改到 `ChatModelAgent`。
2. 需要多 Agent 协作的项目，优先用官方模式，不要自己先从零搭。
3. 把“函数调用式子流程”尽量封成 Tool 或 Agent as Tool。

## 三、v0.6：JSONSchema 取代 OpenAPI 3.0

### 核心变化

- 移除 `kin-openapi`
- 删除 OpenAPI 3.0 相关类型
- 统一转向标准 JSONSchema 表达工具参数

### 影响面

受影响最大的，是 Tool 参数定义和相关辅助函数。

### 你要重点检查

1. 是否直接使用了 `kin-openapi` 类型
2. 是否依赖了旧的 OpenAPI 风格参数生成逻辑
3. 是否有老版本 `eino-ext` module 仍引用旧 API

### 典型现象

- `undefined: schema.NewParamsOneOfByOpenAPIV3`
- `openapi3.TypeObject ... cannot use as *openapi3.Types`

### 迁移建议

1. 优先改成 JSONSchema 或 `GoStruct2ParamsOneOf`
2. 尽量统一改成 `InferTool`
3. 升级对应的 `eino-ext` 包，不要只升主仓库

## 四、v0.7：Interrupt / Resume 架构重构

### 核心变化

- 中断恢复能力重构
- 引入 `GetInterruptState[T]`、`GetResumeContext`
- 支持更强的 targeted resume
- 更好支持工具中断、嵌套 Agent / Graph 中断、组合中断
- Skill middleware、ChatModel 自动重试、多模态工具等能力开始成熟

### 为什么这版重要

对编程 Agent 来说，**审批执行 shell / 文件修改 / 长任务恢复** 都依赖这一层。

### 迁移风险

1. 老的 interrupt 状态管理代码可能需要重写
2. checkpoint 序列化历史数据可能不兼容
3. 如果你的项目从很老版本直接跳升级，需要特别关注兼容分支说明

### 建议动作

1. 升级前梳理所有 interrupt 点
2. 确认是否存在自定义 state 未注册类型名
3. 回归测试：
   - 初次中断
   - 恢复到指定 interrupt
   - 并行中断
   - 嵌套 graph/agent 恢复

## 五、v0.8：Agent Middleware 成为主舞台

### 核心变化

v0.8 最值得注意的不是单个功能，而是 **很多 ChatModelAgent 运行行为被系统性外挂到 middleware**。

重点包括：

- Filesystem middleware
- Skill middleware
- Summarization middleware
- PlanTask middleware
- ToolSearch middleware
- ToolReduction middleware
- PatchToolCalls middleware

### 这意味着什么

1. Agent 能力更模块化
2. 会话治理、工具治理、文件系统、安全能力更容易组合
3. middleware 顺序开始直接影响行为正确性

## 六、v0.8 不兼容点：最需要盯住的 6 类

## 6.1 Shell 接口重命名

- `ShellBackend` -> `Shell`
- `StreamingShellBackend` -> `StreamingShell`
- 不再嵌入 `Backend`

**影响**：原先依赖组合接口的实现需要拆分。

## 6.2 `Backend.Read` 返回值变化

- 旧：`string`
- 新：`*FileContent`

**影响**：不只是编译报错，还会影响你后面读行范围、元信息获取的代码。

## 6.3 `ReadRequest.Offset` 从 0-based 变成 1-based

这是非常危险的行为变更，因为它 **通常不会编译失败，但会读错行**。

对编程 Agent 尤其敏感，典型后果是：

- patch 上下文错位
- 代码 review 错行
- 文件摘要与真实片段对不上

## 6.4 `WriteRequest` 从“存在则报错”改为“存在则覆盖”

这是最值得警惕的变更之一。

对编程 Agent 而言，这意味着：

- 老代码原本依赖“防覆盖”保护
- 升级后如果不额外检查，可能直接把文件覆盖掉

**迁移建议**：凡是重要文件写入，先显式做 existence check。

## 6.5 `GrepRequest.Pattern` 从字面量变成正则

也是高风险行为变更。

例如原来搜索：

```text
interface{}
```

升级后必须转义成：

```text
interface\{\}
```

对编程 Agent 影响极大，因为代码搜索里本来就有大量正则元字符。

## 6.6 AgentEvent 发送机制从 callback 改为 middleware

如果你之前包装了自定义 ChatModel / Tool Decorator，这里要重点回归。

**影响**：

- 事件发出的相对位置变了
- 事件内容可能包含 wrapper 修改后的结果
- 自定义包装逻辑最好迁移到 `ChatModelAgentMiddleware`

## 6.7 文档与实现细节可能存在轻微漂移

近期版本演进很快，尤其是 filesystem backend、sandbox backend 与 middleware 相关内容，个别扩展文档中的旧行为描述可能落后于最新 release notes。

**建议**：

1. 以 `release_notes_and_migration/` 的 breaking change 为第一优先级
2. 以当前接口定义和测试为第二优先级
3. 扩展仓库 README 作为接入参考，但不要把它当成最终语义依据

## 七、升级 Checklist

## 从旧版本升级到新版本前

1. 阅读 `release_notes_and_migration/` 对应版本文档
2. 列出当前项目使用的：
   - Tool
   - Filesystem backend
   - Checkpoint
   - Middleware
   - 自定义 ChatModel / Tool wrapper
3. 检查关联 `eino-ext` module 是否也要同步升级

## 升级后必须回归的能力

1. Tool 调用
2. 流式 ToolCall 判定
3. 文件读取行号
4. 文件写入覆盖行为
5. grep 搜索行为
6. 中断 / 恢复
7. 会话恢复后的消息历史闭合性

## 八、对编程 Agent 项目的额外建议

### 如果项目是代码 / 文件系统 Agent

请特别关注：

1. `Offset` 行号语义
2. `WriteRequest` 覆盖行为
3. `GrepRequest.Pattern` 正则语义
4. backend 路径是否仍假设绝对路径

### 如果项目是多轮协作 Agent

请特别关注：

1. AgentEvent 行为变化
2. PatchToolCalls 是否要补上
3. Reduction 是否需要接入
4. Checkpoint 旧数据兼容性

### 如果项目是多 Agent / 编程 Copilot

请特别关注：

1. 是否需要把旧 decorator 迁移为 middleware
2. 是否该引入 Filesystem / Skill / ToolSearch 等 v0.8 能力
3. 是否该用官方 ADK 模式替代早期自研拼装

## 九、建议锁定的阅读顺序

1. `v0.5.*-ADK implementation`
2. `v0.6.*-jsonschema optimization`
3. `v0.7.*-interrupt resume refactor`
4. `Eino_v0.8_不兼容更新.md`
5. `FAQ.md`

## 十、我的迁移判断

如果你的项目已经是“会调用工具、会写文件、会中断恢复”的真实 Agent，那么：

1. **v0.5 是能力红利**
2. **v0.6 是 schema 债务清理**
3. **v0.7 是恢复机制重构，值得认真吃透**
4. **v0.8 是生产可用性增强，但也最需要谨慎回归**

建议原则只有一句：

**升级 Eino，不只是改 imports；本质上是在升级 Agent 运行时。**
