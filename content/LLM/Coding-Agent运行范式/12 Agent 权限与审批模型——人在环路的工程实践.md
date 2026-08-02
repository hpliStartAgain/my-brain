---
title: "Agent 权限与审批模型——人在环路的工程实践"
date: 2026-08-01
tags: [Agent, Agentrail, Cloudflare Agents, Claude Code, HITL, Human-in-the-Loop, MCP Elicitation, OpenAI Agents SDK, Permission Policy, waitForApproval]
aliases: [Agent 权限与审批模型, 人在环路, HITL, Human Approval, 权限传播]
---

# 12 Agent 权限与审批模型——人在环路的工程实践

> [!abstract] 摘要
> 这是 Coding Agent 运行范式专栏的收官篇。前 11 篇覆盖了 Agent "怎么想"（ReAct 范式）、"怎么调工具"（Function Calling/MCP）、"怎么管上下文"（Context Engineering）、"怎么做事"（Bash/文件/Git 工程化）。本文讨论最后一个核心问题："Agent 做事前要经过谁同意？"——权限与审批模型。文章系统梳理四大平台的人机环路（HITL）实现：OpenAI Agents SDK 的 interruptions 机制（needsApproval 声明 + RunState 序列化/恢复 + 嵌套 Agent.asTool 的双层审批）、Cloudflare Agents 的三种审批模式（MCP Elicitation 分钟级、Workflow waitForApproval 月/年级、Code Mode 连接器调用审批）、Claude Code 的六种权限模式与权限规则优先级（deny/ask 优先于模式）、Agentrail 的工具权限策略（ToolName(content-pattern) 规则匹配）。然后讨论权限传播的工程难点——Claude Code Subagent 的已知权限继承 bug、嵌套 Agent 审批在哪一层 surface、审批的超时与升级策略。最后讨论 MCP Elicitation 作为"Server 向用户请求结构化输入"的标准化方案，以及它与 Sampling 的"Server 借用能力"哲学的呼应。核心认知：权限审批不是"阻碍 Agent 自主性"的负担，而是"让 Agent 可以被信任地部署在生产环境中"的基础设施——没有可靠的审批机制，就没有人敢让 Agent 执行有副作用的操作。

---

## 第 1 章 为什么 Agent 需要审批模型

### 1.1 自主性与安全性的根本张力

Coding Agent 的核心价值是"自主性"——它能自己决定下一步做什么、调用什么工具、修改什么文件。但自主性与安全性存在根本张力：一个完全自主的 Agent 可以执行 `rm -rf /`、`git push --force`、把 API Key 写入公开文件——这些操作不可逆且后果严重。

**没有审批模型的后果**：
- 开发者不敢让 Agent 执行有副作用的操作——Agent 只能做"只读"任务，失去了"做事"的核心价值
- Agent 的每次操作都需要开发者全程盯着——失去了"自主性"的核心价值
- 在生产环境中，Agent 无法被信任——没有审计和控制的系统无法上线

**审批模型的角色**：不是"阻碍自主性"，而是"让自主性可被信任"——通过在关键操作前插入人工审批门控，让开发者敢于让 Agent 自主执行大部分操作，只在"不可逆/有破坏性"的操作前介入。

> [!info] 核心概念：审批模型是 Agent 的"安全带"
> 审批模型之于 Agent，就像安全带之于汽车——安全带不是"阻碍驾驶"的束缚，而是"让驾驶可以被安全地进行"的基础设施。没有安全带的汽车不是"更自由"的——它是不敢开快的。同样，没有审批模型的 Agent 不是"更自主"的——它是不敢被部署的。好的审批模型让 Agent 在"大部分操作自主执行"和"关键操作人工把关"之间找到平衡——开发者可以放心地让 Agent 跑 95% 的操作，只在 5% 的关键操作前审查。

### 1.2 审批的三个维度

一个完整的审批模型需要回答三个问题：

**维度一：什么操作需要审批？**
- 所有写操作？所有 Bash 命令？只有特定的危险命令？
- 这个决策可以静态配置（规则）还是需要动态判断（每次调用评估）？

**维度二：谁有权审批？**
- 当前交互的用户？
- 另一个审批者（如团队 lead）？
- 自动化策略（如只读操作自动批准，写操作需要人工）？

**维度三：审批后如何恢复执行？**
- 同步等待——Agent 暂停，等待审批后继续
- 异步恢复——Agent 状态序列化，审批后从序列化状态恢复
- 超时处理——审批者不响应时怎么办？

---

## 第 2 章 OpenAI Agents SDK——interruptions 机制

### 2.1 needsApproval 声明

OpenAI Agents SDK 通过 `needsApproval` 参数声明工具是否需要审批：

```python
from agents import function_tool

@function_tool(needs_approval=True)
async def cancel_order(order_id: int) -> str:
    """Cancel a customer order."""
    return f"Cancelled order {order_id}"
```

`needsApproval` 接受三种值：
- `True`：总是需要审批
- `False`（默认）：不需要审批
- `async function`：动态决策——函数接收运行上下文、工具参数和调用 ID，返回 `bool`

**动态审批的威力**：不是"所有调用都需要审批"或"都不需要"，而是"根据具体调用内容决定"：

```python
async def _needs_approval_for_oakland(ctx, params, call_id) -> bool:
    """只在查询 Oakland 天气时需要审批"""
    return "Oakland" in params.get("city", "")

@function_tool(needs_approval=_needs_approval_for_oakland)
async def get_temperature(city: str) -> str:
    return f"Temperature in {city}: 20°C"
```

这个例子展示了动态审批的精妙——查询旧金山的天气不需要审批（低风险），查询奥克兰的天气需要审批（可能因为奥克兰有特殊的数据访问合规要求）。这种"基于参数内容的动态审批"比"一刀切"的静态规则更灵活。

### 2.2 interruptions 机制

当工具调用需要审批时，SDK 不会执行工具，而是：

1. 记录一个 `RunToolApprovalItem`（待审批项）
2. 在当前 turn 结束时暂停运行
3. 返回所有待审批项在 `result.interruptions` 数组中

```python
result = await Runner.run(agent, "Cancel order 123.")

if result.interruptions:
    state = result.to_state()  # 序列化运行状态
    for interruption in result.interruptions:
        print(f"Tool: {interruption.name}")
        print(f"Arguments: {interruption.arguments}")
        
        # 人工审批
        if await confirm("Approve?"):
            state.approve(interruption)
        else:
            state.reject(interruption)
    
    # 从序列化状态恢复执行
    result = await Runner.run(agent, state)
```

**关键设计**：
- `result.to_state()` 序列化运行状态——可以保存到数据库
- `state.approve(interruption)` / `state.reject(interruption)` 处理每个待审批项
- `Runner.run(agent, state)` 从序列化状态恢复执行——不需要从头开始
- `{ alwaysApprove: true }` 选项——"以后这个工具总是批准"（减少重复审批）

### 2.3 嵌套 Agent 的双层审批

OpenAI Agents SDK 支持 `Agent.asTool()`——把一个 Agent 作为另一个 Agent 的工具。这引入了双层审批问题：

```typescript
const agent = new Agent({
    tools: [
        weatherAgent.asTool({
            toolName: 'ask_weather_agent',
            needsApproval: async (_ctx, { input }) => input.includes('San Francisco'),
        }),
    ],
});
```

**两层审批**：
1. **Agent-as-Tool 层**：调用 `ask_weather_agent` 本身是否需要审批（如输入包含"San Francisco"时需要）
2. **嵌套 Agent 内部工具层**：嵌套 Agent 内部的工具（如 `get_temperature`）可能也有自己的 `needsApproval`

**关键设计**：两层审批都在外层 run 的 `interruptions` 中 surface——"approve 或 reject 在外层 `result.state` 上操作，恢复原始顶层 run"。这意味着审批者只需要在一个地方处理所有审批——不需要分别在外层和嵌套层各处理一次。

### 2.4 支持审批的工具类型

`needsApproval` 可用于：
- `function_tool`：自定义函数工具
- `Agent.as_tool`：Agent 作为工具
- `ShellTool`：Shell 命令执行
- `ApplyPatchTool`：补丁应用
- 本地 MCP Server（`MCPServerStdio/Sse/StreamableHttp` 的 `require_approval`）
- Hosted MCP Server（`HostedMCPTool` 的 `tool_config={"require_approval": "always"}`）

对于 Shell 和 apply_patch 工具，还可以用 `on_approval` 回调做"自动审批/自动拒绝"——不需要暂停运行，在代码中决定。

---

## 第 3 章 Cloudflare Agents——三种审批模式

### 3.1 三种模式的定位

Cloudflare Agents 提供三种 HITL 模式，按"等待时长"和"发起方"区分：

| 模式 | 审批层 | 发起方 | 典型等待时长 | 关键 API |
| :--- | :--- | :--- | :--- | :--- |
| **MCP Elicitation** | MCP 请求由 Agent Client 处理 | MCP Server 开发者 | 分钟级 | `configureElicitationHandlers()` / `elicitInput()` |
| **Workflow Approval** | 持久化应用任务或工具操作 | Agent 应用开发者 | 月/年级 | `waitForApproval()` |
| **Code Mode Approval** | 模型生成代码中的连接器调用 | Code Mode Agent 开发者 | 配置的过期时间前 | `requiresApproval`, `approve()`, `reject()` |

### 3.2 Workflow Approval——月/年级的持久化审批

Cloudflare 的 Workflow Approval 是三种模式中最独特的——它可以等待**数月甚至数年**而不需要保持 Agent 运行。

```typescript
export class ExpenseWorkflow extends AgentWorkflow {
    async run(event, step) {
        const expense = event.payload;
        
        // 步骤 1: 验证
        const validated = await step.do("validate", async () => {
            if (expense.amount <= 0) throw new Error("Invalid amount");
            return { ...expense, validatedAt: Date.now() };
        });
        
        // 步骤 2: 等待人工审批（最长 7 天）
        const approval = await this.waitForApproval(step, {
            timeout: "7 days",
        });
        
        // 步骤 3: 审批通过后处理
        const result = await step.do("process", async () => {
            return { expenseId: crypto.randomUUID(), ...validated };
        });
    }
}
```

**为什么能等数月**：Cloudflare Workflows 是持久化的——`waitForApproval()` 创建一个持久化的审批门控，由 Cloudflare Workflows 基础设施支撑。Agent 本身不需要保持运行——Workflow 在审批到来时自动恢复。这意味着一个费用审批流程可以在"提交→等待审批→处理"之间跨越数天，中间不需要任何计算资源消耗。

**超时与升级**：`timeout` 参数定义最大等待时间。超时后 Workflow 可以配置升级策略——如自动转给上级审批者、自动拒绝、或发送提醒。

### 3.3 MCP Elicitation——Server 请求用户输入

Cloudflare Agents SDK 支持 MCP Elicitation——MCP Server 在工具执行过程中请求用户结构化输入：

```typescript
const confirmation = await this.elicitInput({
    message: `Are you sure you want to increment the counter by ${amount}?`,
    requestedSchema: {
        type: "object",
        properties: {
            confirmed: {
                type: "boolean",
                title: "Confirm increment",
                description: "Check to confirm the increment",
            },
        },
        required: ["confirmed"],
    },
});
```

**Hibernate 安全**：Cloudflare 的 Elicitation 使用持久化存储保存 elicitation 状态——即使 Agent 在等待用户输入期间 hibernate（休眠），状态也不会丢失。Agent 恢复后可以继续处理用户响应。

**Handler 注册**：Agent 在 `onStart()` 中注册 elicitation handler：

```typescript
class MyAgent extends Agent {
    onStart() {
        this.mcp.configureElicitationHandlers({
            form: (request, serverId) => this.forwardToUI(request, serverId),
            url: (request, serverId) => this.forwardToUI(request, serverId),
        });
    }
}
```

`serverId` 标识发送 elicitation 请求的 MCP Server 连接——可以据此应用 Server 特定的策略（如某些 Server 的 elicitation 自动批准，另一些需要人工审查）。

### 3.4 Code Mode Approval——连接器调用审批

Code Mode 是 Cloudflare 的 Programmatic Tool Calling 实现——模型在代码执行环境中调用工具。Code Mode Approval 在连接器调用前插入审批门控：

- `requiresApproval`：声明连接器是否需要审批
- `approve()` / `reject()`：处理审批请求
- 配置的过期时间前等待——超时后自动处理

---

## 第 4 章 Claude Code——六种权限模式（回顾与深化）

### 4.1 回顾：六种模式

[[07 Claude Code 架构解构——Anthropic 的 CLI Agent 设计哲学|第 7 篇]]已经详细介绍了 Claude Code 的六种权限模式。这里从"审批模型"视角做深化分析：

| 模式 | 自动批准范围 | 审批需求 | 等价于 |
| :--- | :--- | :--- | :--- |
| `default` | 仅读取 | 所有写操作和 Bash | OpenAI `needsApproval=True`（所有写工具） |
| `acceptEdits` | 读取 + 文件编辑 | Bash 命令 | OpenAI `needsApproval` 仅 Bash |
| `plan` | 读取 + 只读 Shell | 不做修改 | OpenAI 全部 `needsApproval=True` |
| `auto` | 一切（分类器审查） | 分类器判定的危险操作 | OpenAI 动态 `needsApproval` 函数 |
| `dontAsk` | 仅 allow 规则命中的 | 其余全部拒绝 | 无审批——白名单模式 |
| `bypassPermissions` | 一切 | 无 | OpenAI `needsApproval=False`（全部） |

### 4.2 权限规则优先于模式

Claude Code 的关键设计是 **deny 和 ask 规则优先于权限模式**：

```
权限检查顺序：
1. Hooks → 可拒绝或放行
2. deny 规则 → 匹配则阻止（即使 bypassPermissions）
3. ask 规则 → 匹配则要求确认（即使 bypassPermissions）
4. 权限模式 → 决定是否自动批准
```

这意味着：即使在 `bypassPermissions` 模式下，`Bash(rm *)` 的 deny 规则仍然阻止所有 `rm` 命令——"无论如何都不能执行的操作"始终被阻止。这是"安全兜底"设计——防止 bypassPermissions 模式被滥用导致灾难性后果。

### 4.3 auto 模式的分类器审批

Claude Code 的 auto 模式是一种独特的"自动化审批"——不是人工审批，也不是全部自动批准，而是用 LLM 分类器做实时安全判断：

- 分类器（Sonnet 4.6）评估每个工具调用
- 安全操作自动执行
- 不可逆/有破坏性/目标在环境之外的操作被阻止
- `autoMode.environment` 配置可信的仓库、存储桶和域名

这是"AI 审批 AI"的实践——用一个较小的 LLM 做安全决策，让较大的 LLM 做任务执行。风险是分类器可能误判——但相比"全部需要人工审批"（效率太低）或"全部自动批准"（风险太高），分类器提供了一个合理的折中。

---

## 第 5 章 Agentrail——工具权限策略

### 5.1 规则格式

Agentrail 提供了一种声明式的工具权限策略——用规则模式匹配控制工具调用：

```javascript
{
    mode: "default",
    allow: [],                                    // 自动允许的工具
    deny: parseRules(["Bash(rm:*)"]),             // 永远拒绝
    ask: parseRules(["Bash", "Write"])            // 需要审批
}
```

**规则格式**：`ToolName` 或 `ToolName(content-pattern)`
- `Bash(git:*)`：匹配所有 `git` 开头的 Bash 命令
- `Bash(rm:*)`：匹配所有 `rm` 开头的命令（deny 规则）
- `Write(/workspace/**)`：匹配 workspace 下的所有 Write 操作
- `Bash`（无参数）：匹配所有 Bash 工具调用

### 5.2 三种规则集的优先级

`deny` → `ask` → `allow`——第一个匹配的规则决定行为：

1. 检查 `deny` 规则——匹配则直接阻止
2. 检查 `ask` 规则——匹配则要求审批
3. 检查 `allow` 规则——匹配则自动允许
4. 如果都不匹配，根据 `mode` 决定

这种"deny 优先"的设计确保了"危险操作永远不会被误批准"——即使 `allow` 规则不小心匹配了一个危险操作，只要 `deny` 规则也匹配了，操作仍然被阻止。

---

## 第 6 章 权限传播的工程难点

### 6.1 Subagent 权限继承

[[07 Claude Code 架构解构——Anthropic 的 CLI Agent 设计哲学|第 7 篇]]已经提到 Claude Code Subagent 的权限继承 bug。从审批模型视角看，这是一个更深层的问题：

**问题**：主 Agent 在 `bypassPermissions` 模式下运行（如在 CI/CD 容器中），主 Agent 委派子任务给 Subagent。Subagent 是否应该继承 `bypassPermissions`？

**直觉答案**：应该继承——如果主 Agent 被信任到可以跳过所有审批，它的 Subagent 也应该被同等信任。

**实际情况**：由于 bug（Issue #37442），Subagent 不继承 `bypassPermissions`——Subagent 仍然会要求权限确认。这在 CI/CD 无人值守场景中是致命的——Agent 会卡在"等待审批"上，但没有人来审批。

### 6.2 嵌套 Agent 的审批 surface 层

OpenAI Agents SDK 的 `Agent.asTool()` 引入了"嵌套 Agent"——Agent A 作为 Agent B 的工具被调用。如果 Agent A 内部的工具需要审批，这个审批应该在哪一层 surface？

**OpenAI 的答案**：在外层 run 的 `interruptions` 中 surface——"approve 或 reject 在外层 `result.state` 上操作"。这意味着审批者只需要关注最外层的 `interruptions` 数组——无论审批请求来自外层 Agent 还是嵌套 Agent 的工具。

**为什么不在嵌套层 surface**：如果在嵌套层 surface，审批者需要逐层进入嵌套 Agent 的状态去处理——这在多层嵌套时极其复杂。统一在外层 surface 简化了审批者的工作。

### 6.3 审批超时与升级

**问题**：审批请求发出后，审批者不响应怎么办？

**OpenAI Agents SDK**：没有内置的审批超时——运行暂停后无限期等待，直到 `approve` 或 `reject` 被调用。开发者需要自己实现超时逻辑（如 `setTimeout` 后自动 reject）。

**Cloudflare Workflow Approval**：内置 `timeout` 参数——超时后 Workflow 自动处理（如升级到上级审批者或自动拒绝）。还支持 `escalation` 策略——超时后自动转给另一个审批者。

**最佳实践**：生产环境中的审批系统应该有超时和升级策略——"审批者不响应"是一个必须处理的场景，不能让 Agent 永远卡在等待中。

> [!warning] 生产避坑：审批模型的无超时等待是生产事故的常见来源
> 很多团队在实现审批模型时忘记考虑"审批者不响应"的场景——Agent 暂停等待审批，审批者在开会/下班/度假，Agent 永远卡住。在生产环境中，必须设置审批超时——超时后自动拒绝（安全默认）或升级到备选审批者。Cloudflare 的 `waitForApproval(timeout: "7 days")` 是一个好范例——明确设置了最大等待时间。OpenAI SDK 的"无限等待"设计在开发时方便，但在生产中需要开发者自己加超时保护。

---

## 第 7 章 MCP Elicitation——标准化的用户输入请求

### 7.1 Elicitation 在审批模型中的角色

[[04 MCP 协议深度解析——Agent 与工具的标准化连接|第 4 篇]]介绍了 MCP Elicitation 作为 Client 原语——Server 在执行过程中请求结构化用户输入。从审批模型视角，Elicitation 可以被视为一种"轻量级审批"——不是"是/否"的二元审批，而是"请提供更多信息才能继续"的结构化输入请求。

**Elicitation vs 传统审批**：

| 维度 | 传统审批 | MCP Elicitation |
| :--- | :--- | :--- |
| **请求类型** | "允许执行这个操作吗？"（是/否） | "请提供这些信息才能继续"（结构化输入） |
| **Schema** | 无（二元决策） | JSON Schema（定义需要哪些字段） |
| **安全限制** | 无 | 禁止请求密码等凭证 |
| **典型场景** | 危险操作前的确认 | 缺少必要信息时的补充请求 |

### 7.2 Elicitation 与 Sampling 的哲学呼应

MCP 的 Client 原语有两个：Sampling（Server 借用 LLM）和 Elicitation（Server 请求用户输入）。两者都体现了"Server 向 Client 借用能力"的设计哲学：

- **Sampling**：Server 没有 LLM，通过 Client 借用 Host 的 LLM 能力
- **Elicitation**：Server 没有直接访问用户的界面，通过 Client 借用 Host 的用户交互能力

这种"借用"哲学让 MCP Server 保持轻量——不需要自带 LLM、不需要自带 UI、不需要自带用户数据库——所有"重量级能力"都通过协议从 Host 借用。Server 只需要实现自己的核心逻辑（工具执行、数据访问），其余能力按需从 Host 获取。

### 7.3 Elicitation 的安全限制

MCP 规范对 Elicitation 的 Schema 做了安全限制——**禁止请求密码等凭证**。这防止了恶意 Server 以"需要密码才能继续"为由骗取用户凭证。

如果一个 Server 尝试请求包含 `password` 字段的 Elicitation，Host 应该拒绝这个请求或向用户发出安全警告。这是 MCP 安全模型"Host 是守门人"原则的具体体现。

---

## 第 8 章 专栏总结——从范式到实践的完整闭环

### 8.1 12 篇文章的逻辑结构

本专栏 12 篇文章形成了一个从"理论"到"实践"的完整闭环：

**理论篇（01-06）**：
- 01 ReAct 范式全景——Agent 如何"想"
- 02 ReAct 深度解析——循环如何"转"
- 03 Function Calling——Agent 如何"调工具"
- 04 MCP 协议——工具如何"标准化"
- 05 MCP 生态——标准如何"落地"
- 06 Context Engineering——上下文如何"管"

**实践篇（07-10）**：
- 07 Claude Code——Anthropic 的 CLI Agent
- 08 Devin——Cognition 的沙箱 Agent
- 09 OpenHands + Aider——开源两种哲学
- 10 Cursor + Gemini——IDE 类 Agent

**工程篇（11-12）**：
- 11 OS 交互接口——Bash/文件/Git 的工程化
- 12 权限与审批模型——人在环路的工程实践

### 8.2 核心认知总结

贯穿 12 篇文章的核心认知：

1. **没有"最好的"范式，只有"最合适的"权衡**——ReAct vs Plan-and-Execute、MCP vs Function Calling、Docker 沙箱 vs 本地运行——每个选择都是在灵活性、效率、安全、成本之间的取舍

2. **工程细节决定系统能否上线**——stop sequence vs stop_reason、原子写入、两阶段终止、输出截断——这些不写在论文里的细节决定了 Agent 是"demo 玩具"还是"生产系统"

3. **Context Engineering 是 Agent 的核心挑战**——Context Rot、Just-in-Time Loading、Memory Tool、Subagent 上下文隔离——管理"哪些 token 该在窗口中"比"怎么写 prompt"更重要

4. **标准化协议降低生态成本**——MCP 把工具适配从 M×N 降为 M+N，如同 LSP 在编辑器领域做的事

5. **ACI 设计是性能关键变量**——同样的 LLM，好的 ACI 可以带来 6 倍性能提升——Coding Agent 的瓶颈往往不在模型，在接口

6. **审批模型是 Agent 可被信任的基础**——没有可靠的审批机制，就没有人敢让 Agent 执行有副作用的操作——审批不是"阻碍自主性"，而是"让自主性可被信任"

### 8.3 专栏关联

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Coding Agent 运行范式专栏]] 的第 12 篇，也是收官篇。本专栏的姊妹篇 [[云原生/Agent沙箱与隔离技术/00 专栏导览|Agent 沙箱与隔离技术]] 解决"Agent 在哪安全运行"的问题——从 Linux namespaces/cgroups/seccomp 到 gVisor/Kata/Firecracker 到 E2B/Daytona，深入 Agent 运行环境的隔离与安全。两个专栏共同覆盖了"Agent 怎么工作"和"Agent 在哪安全运行"两个核心问题。

---

## 参考文献

1. OpenAI Agents SDK. "Human-in-the-loop (Python)." https://openai.github.io/openai-agents-python/human_in_the_loop/
2. OpenAI Agents SDK. "Human-in-the-loop (TypeScript)." https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
3. OpenAI. "Guardrails and human review." https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
4. Cloudflare. "Human-in-the-loop patterns." https://developers.cloudflare.com/agents/guides/human-in-the-loop/
5. Cloudflare. "Human-in-the-loop concepts." https://developers.cloudflare.com/agents/concepts/human-in-the-loop/
6. Cloudflare. "Agents SDK MCP Elicitation support." 2025-08-05. https://developers.cloudflare.com/changelog/post/2025-08-05-agents-mcp-update/
7. Cloudflare. "McpClient API - Elicitation." https://developers.cloudflare.com/agents/api-reference/mcp-client-api/index.md
8. Cloudflare. "Using Agents with Workflows." https://developers.cloudflare.com/agents/concepts/workflows/index.md
9. Claude Code Permission Modes. https://code.claude.com/docs/en/permission-modes
10. Claude Code Permissions (SDK). https://code.claude.com/docs/en/agent-sdk/permissions
11. Agentrail Tool Permissions. https://agentrail.run/guides/tool-permissions
12. "Human Approval (Agent Patterns)." https://www.agentpatterns.tech/en/governance/human-approval

---

## 思考题

1. **OpenAI Agents SDK 的 `needsApproval` 可以是动态函数——根据工具调用参数决定是否需要审批。请设计一个动态审批函数，用于 Coding Agent 的 Bash 工具——哪些命令需要审批，哪些不需要？** 提示：考虑命令的风险等级——`ls`/`cat`/`grep` 不需要审批（只读）；`git add`/`npm install` 可以自动批准（可逆）；`rm`/`git push --force`/`docker rm` 必须审批（不可逆）。

2. **Cloudflare 的 Workflow Approval 可以等待"月/年级"——这意味着 Agent 可以在"提交费用报告→等待审批→处理"之间跨越数月。这种"超长等待"的审批模型有什么工程挑战？** 提示：考虑"世界变化"——三个月后，费用报告相关的预算可能已经变了、审批者可能已经离职了、公司政策可能已经改了。Agent 恢复执行时需要重新验证"审批时的假设是否仍然成立"。

3. **本专栏 12 篇文章贯穿了一个核心认知——"没有最好的方案，只有最合适的权衡"。请回顾全文，选出你认为最重要的三个"权衡"，并解释为什么它们比其他权衡更重要。** 提示：考虑"如果选错了这个权衡，后果有多严重"——安全性 vs 效率的权衡（选错可能导致安全事故或效率低下）、自主性 vs 可控性的权衡（选错可能导致 Agent 失控或无法自主工作）、标准化 vs 灵活性的权衡（选错可能导致生态碎片化或过度统一）。
