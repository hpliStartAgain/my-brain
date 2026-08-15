---
title: "Claude Code 架构解构——Anthropic 的 CLI Agent 设计哲学"
date: 2026-08-01
tags: [Agent, Claude Code, CLI Agent, Dynamic Workflows, Git 操作, MCP, Permission Modes, Session 持久化, Subagent, Terminal Agent]
aliases: [Claude Code 架构解构, Claude Code 设计哲学, Claude Code Subagent]
---

# 07 Claude Code 架构解构——Anthropic 的 CLI Agent 设计哲学

> [!abstract] 摘要
> Claude Code 是 Anthropic 于 2025 年发布的 CLI Coding Agent，也是本专栏前 6 篇建立的理论框架的最佳实践案例——它用 ReAct 循环做核心推理、用 Function Calling 做工具调用、原生集成 MCP 做工具扩展、用 Context Engineering 做长时上下文管理。本文深入解构 Claude Code 的完整架构：多表面设计（Terminal/Web/IDE/Slack/GitHub）、核心工具集（Read/Write/Edit/Glob/Grep/Bash/LSP/MCP）的精确机制与权限要求、Subagent 的独立上下文隔离与工具限制、四种并行模式（Subagent/Agent View/Agent Teams/Dynamic Workflows）的适用场景差异、六种权限模式（default/acceptEdits/plan/auto/dontAsk/bypassPermissions）的控制粒度与安全边界、Session 持久化与恢复、Git 操作集成、以及已知 bug 与生产避坑。核心认知：Claude Code 的设计哲学是"渐进式授权"——从最保守的 default 模式（每次操作都问）到最激进的 bypassPermissions 模式（什么都不问），用户可以根据信任度和隔离程度选择合适的控制粒度，而非"全有或全无"。

---

## 第 1 章 多表面架构——从 Terminal 到全平台

### 1.1 六个表面

Claude Code 不仅仅是一个 Terminal CLI——它是一个多表面 Agent 系统，同一个核心推理引擎可以通过多种界面使用：

| 表面 | 形态 | 适用场景 |
| :--- | :--- | :--- |
| **Terminal CLI** | 命令行交互 | 核心入口，开发者主力使用 |
| **Web** | 浏览器界面 | 非终端环境下的访问 |
| **VS Code 扩展** | IDE 内嵌 | 在编辑器中直接使用，原生集成 |
| **JetBrains 扩展** | IDE 内嵌 | IntelliJ/PyCharm 等 |
| **Slack** | 聊天集成 | 团队协作场景 |
| **GitHub** | PR/Issue 集成 | 代码审查、Issue 处理 |

Terminal CLI 是核心入口——所有其他表面都共享 CLI 的底层推理引擎和工具集。VS Code 和 JetBrains 扩展是"原生集成"——不是简单的 CLI 嵌入，而是与 IDE 的语言服务器、文件系统、Git 操作深度整合。Cursor 和 Devin Desktop 也可以连接 Claude Code 的底层引擎。

### 1.2 为什么从 Terminal 开始

很多 AI 编码工具从 IDE 插件或 Web 界面开始，但 Claude Code 选择从 Terminal CLI 开始。这个选择不是偶然的——Terminal 提供了几个独特优势：

**完整的系统能力**：Terminal 可以访问完整的文件系统、执行任意 shell 命令、操作 Git——没有 IDE 的沙箱限制。这让 Claude Code 从一开始就拥有完整的"行动能力"，而非受限的"建议能力"。

**开发者自然工作流**：重度开发者已经习惯在 Terminal 中工作——`git`、`npm`、`docker` 等工具都在 Terminal 中运行。Claude Code 作为 Terminal Agent 自然融入这个工作流，而非要求开发者切换到另一个界面。

**管道与脚本集成**：Terminal 工具可以被管道组合、被脚本调用、被 CI/CD 集成。Claude Code 的 CLI 形态让它可以被 `claude -p "fix the bug"` 这样在脚本中调用——这是 IDE 插件难以实现的。

> [!note] 设计哲学：Terminal 优先 = 能力优先
> 从 Terminal 开始的设计选择，反映了 Claude Code 的核心定位——它不是"代码补全工具"或"代码建议工具"，而是"能做事的 Agent"。Terminal 给了它完整的系统能力，让它可以真正读写文件、执行命令、操作 Git，而非只在 IDE 里建议改动。这种"能力优先"的设计哲学贯穿了 Claude Code 的所有决策——从工具集设计到权限模型到 Subagent 机制，都是为了支撑"让 Agent 真正做事"这个核心目标。

---

## 第 2 章 核心工具集——精确的文件、Shell 与搜索能力

### 2.1 工具分类与权限

Claude Code 的内置工具分为四大类：

| 类别 | 工具 | 权限要求（default 模式） |
| :--- | :--- | :--- |
| **文件操作** | Read, Write, Edit, NotebookEdit, Glob, Grep, LSP | Read/Glob/Grep/LSP 免权限；Write/Edit/NotebookEdit 需权限 |
| **Shell 执行** | Bash, PowerShell, Monitor | 需权限（内置只读命令集除外） |
| **Web** | WebFetch, WebSearch | 需权限 |
| **MCP** | MCP 工具, ListMcpResources, ReadMcpResource | 需权限 |

### 2.2 文件操作工具的设计哲学

Claude Code 的文件操作不是简单的 `cat`/`echo`/`sed` 的包装——它是专门为 LLM 认知模式设计的工具集：

**Read**：支持文本、图片、PDF、Jupyter notebook 的多模态读取。支持 `offset`/`limit` 参数做大文件分页读取——这直接呼应了 [[02 ReAct 架构深度解析——Thought-Action-Observation 循环的本质|第 2 篇]]讨论的 Observation 治理策略，防止大文件毒化上下文。

**Edit**：精确字符串替换——`old_string` 必须在文件中唯一匹配。这不是"让 LLM 生成整个文件内容然后覆盖"的粗暴方式，而是"让 LLM 指出要改的确切位置和内容"的精准方式。这减少了 LLM 需要生成的 token 量（只需生成修改部分而非整个文件），也减少了"覆盖时引入非预期改动"的风险。

**Write**：创建新文件或完全覆盖现有文件。安全机制：如果文件已存在，必须先用 Read 工具读取过该文件——确保 LLM "知道它在覆盖什么"。

**Glob**：基于模式匹配的文件查找（如 `**/*.ts`、`src/**`）。比 `find` 命令更 LLM 友好——模式语法更简洁，输出更结构化。

**Grep**：基于 ripgrep 的正则搜索。支持三种输出模式：`content`（显示匹配行）、`files_with_matches`（只显示文件路径）、`count`（显示匹配数量）。Claude Code 的系统提示明确指示"**ALWAYS** use Grep for search tasks. **NEVER** use grep or rg as a Bash command"——因为 Grep 工具被优化了权限处理，且输出格式更适合 LLM 消费。

**LSP**：通过语言服务器获取代码智能信息——跳转到定义、查找引用、类型错误。这是 Claude Code 与 IDE 集成时的独特能力——直接利用 IDE 的语言服务器，而非自己重新解析代码。

> [!info] 核心概念：专用工具优于 Shell 命令
> Claude Code 的设计原则是"文件操作优先使用专用工具（Read/Edit/Write/Glob/Grep）而非等价的 Shell 命令（cat/sed/find/grep）"。原因有三：1）专用工具提供更细粒度的权限控制——可以为 `Read(/secrets/**)` 设置 deny 规则，但很难为 `cat /secrets/*` 设置等价规则；2）专用工具提供更清晰的审计日志——工具调用记录中显示的是 `Read(path)` 而非 `Bash(cat path)`，更容易追踪；3）专用工具的输出格式更适合 LLM 消费——结构化的而非原始终端输出。

### 2.3 Bash 工具的行为

Bash 工具是 Claude Code 最强大也最危险的工具——它可以执行任意 shell 命令。

**内置只读命令集**：在 default 模式下，部分只读命令（如 `ls`、`cat`、`git status`、`git diff`、`git log`）不需要权限提示。这减少了常用只读操作的交互摩擦。

**命令模式匹配权限**：`allow`/`deny`/`ask` 规则可以用模式匹配控制 Bash 命令：
- `Bash(npm run *)`：允许 `npm run` 开头的命令
- `Bash(rm *)`：deny 规则阻止所有 `rm` 命令
- `Bash(git push *)`：ask 规则要求 `git push` 前确认

**Windows 支持**：在 Windows 上，Claude Code 使用 PowerShell 或 Git Bash。PowerShell 工具有独立的权限规则格式（如 `PowerShell(Get-ChildItem *)`）。

**Monitor 工具**（v2.1.98+）：在后台运行命令并逐行将输出反馈给 Claude——适用于长时间运行的命令（如 `npm run dev`、`tail -f`）。

### 2.4 MCP 工具集成

Claude Code 原生支持 MCP——可以通过命令行或 `.mcp.json` 配置文件添加 MCP Server：

```bash
# 添加 stdio MCP Server
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /path

# 添加远程 HTTP MCP Server
claude mcp add --transport http my-service https://mcp.example.com/mcp
```

MCP Server 暴露的工具自动成为 Claude Code 可用的工具——与内置工具一样受权限规则管控。Claude Code 还支持 `ListMcpResources` 和 `ReadMcpResource` 工具来访问 MCP Server 的 Resources 原语。

---

## 第 3 章 Subagent——独立上下文的委托工作者

### 3.1 Subagent 的核心机制

Subagent 是 Claude Code 最独特的架构特性之一——主 Agent 可以委派子任务给一个拥有**独立上下文窗口**的 Subagent。

**工作方式**：
1. 主 Agent 通过 `Agent` 工具调用一个 Subagent
2. Subagent 在自己的独立上下文窗口中运行
3. Subagent 有自己的系统提示、工具集和权限
4. Subagent 完成任务后，只把**精炼的摘要结果**返回给主 Agent
5. Subagent 的中间过程（Thought-Action-Observation 链）不进入主 Agent 的上下文

### 3.2 内置 Subagent

Claude Code 包含几个内置 Subagent：

| Subagent | 模型 | 工具权限 | 用途 |
| :--- | :--- | :--- | :--- |
| **Explore** | 继承主对话 | 只读工具（Write/Edit 被 deny） | 代码库探索、信息收集 |
| **Plan** | 继承主对话 | 跳过 CLAUDE.md 和 git status | 规划模式下的上下文收集 |
| **general-purpose** | 继承主对话 | 继承主对话工具 | 通用子任务 |

### 3.3 自定义 Subagent

开发者可以在 `.claude/agents/` 目录中用 Markdown 文件定义自定义 Subagent：

```markdown
---
name: code-reviewer
description: Use this agent for code review tasks. Specializes in identifying bugs, security issues, and style violations.
tools: [Read, Grep, Glob, Bash]  # 限制可用工具
---

You are a code review specialist. When reviewing code:
1. Check for common bug patterns...
2. Verify error handling...
3. Look for security vulnerabilities...
```

`description` 字段让 Claude 知道"什么时候该委派给这个 Subagent"——当主 Agent 遇到匹配描述的任务时，自动委派。开发者也可以在 prompt 中显式指定"Use the code-reviewer agent to..."。

`tools` 字段限制 Subagent 可用的工具——如 code-reviewer 只有只读工具（Read/Grep/Glob/Bash），不能修改文件。这是权限最小化原则的体现。

### 3.4 Subagent 的上下文隔离效果

[[06 Prompt 上下文管理——Context Engineering 的艺术|第 6 篇]]已经分析了 Subagent 的上下文隔离效果。在 Claude Code 的实际使用中，这种隔离的价值体现在：

- **代码库探索不污染主上下文**：Explore Subagent 可以读 20 个文件来理解代码库结构，但主 Agent 只收到一份 500 token 的结构摘要
- **并行搜索**：多个 Subagent 可以同时搜索代码库的不同部分，各自有独立上下文
- **权限隔离**：只读 Subagent 不能修改文件——即使主 Agent 有写权限，委派给只读 Subagent 的子任务也不会有写操作

> [!warning] 生产避坑：Subagent 权限继承的已知 bug
> Claude Code 的 Subagent 权限继承存在几个已知 bug（截至 2025 年）：1）Subagent 不继承 `bypassPermissions` 模式（Issue #37442）——在 bypassPermissions 模式下启动的会话中，Subagent 仍然会要求权限确认；2）运行时 UI 接受的权限不传播给子 Subagent（Issue #51289）；3）Workflow Subagents 不继承 settings.local.json 的 allow-rules（Issue #73633）。这些 bug 意味着在高度自动化的场景中，Subagent 可能意外地要求权限确认——如果你依赖 bypassPermissions 做无人值守运行，需要注意这些已知限制。

---

## 第 4 章 四种并行模式

Claude Code 提供了四种不同层级的并行执行模式，适用场景各异：

### 4.1 四种模式对比

| 模式 | 并行单元 | 上下文关系 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **Subagent** | 单会话内的子任务 | 独立上下文，返回摘要 | 副任务会淹没主对话（搜索结果、日志、文件内容） |
| **Agent View** | 多个独立后台会话 | 完全独立的完整会话 | 多个独立任务，想统派和监控 |
| **Agent Teams** | 多个协调会话 | 共享任务列表 + 消息传递 | 让 Claude 自己拆分项目、分配任务、保持同步 |
| **Dynamic Workflows** | 脚本编排的大量 Subagent | 脚本持有循环和中间结果 | 任务超出单会话可协调的 Subagent 数量 |

### 4.2 Subagent——会话内并行

Subagent 在单个会话内工作——主 Agent 委派子任务，Subagent 在独立上下文中完成，返回摘要。适合"副任务会淹没主对话"的场景。

### 4.3 Agent View——多会话并行

Agent View（`claude agents` 命令）提供"一个屏幕统管所有后台会话"的能力：

- 可以从单一界面派发多个独立后台会话
- 每个后台会话是一个完整的 Claude Code 对话，在没有终端连接的情况下持续运行
- 查看每个会话的状态（运行中/需要输入/已完成）和当前活动
- 只在某个会话需要你时才介入

Agent View 自动为每个派发的会话创建独立的 Git worktree——确保并行会话不会编辑同一文件。这解决了多会话并行时的文件冲突问题。

### 4.4 Agent Teams——协调的多会话

Agent Teams（实验性功能）让多个 Claude Code 会话相互通信——共享任务列表和 Agent 间消息传递。一个"lead" Agent 管理工作者们，协调任务分配和同步。

### 4.5 Dynamic Workflows——脚本化的大规模编排

Dynamic Workflows 是最高层级的并行模式——Claude 编写一个 JavaScript 脚本来编排大量 Subagent，脚本在后台执行，主会话保持响应。

**与其他模式的关键区别**：在 Subagent/Agent Teams 中，Claude 是编排者——它逐轮决定下一步 spawn 什么、分配什么，每个结果都进入上下文。在 Dynamic Workflows 中，**脚本持有循环、分支和中间结果**——Claude 的上下文只保留最终答案。

**适用场景**：
- 代码库范围的 bug 扫描（需要检查数百个文件）
- 500 个文件的批量迁移
- 需要多源交叉验证的研究任务
- 从多个独立角度起草复杂计划

**内置 Workflow**：`/deep-research` 是 Claude Code 内置的 Dynamic Workflow——它编排多个 Agent 跨多个来源调查一个问题，在后台分阶段执行，最终返回一份报告而非逐步的转录。

> [!info] 核心概念：Dynamic Workflows 把编排从"对话"移到"代码"
> Subagent 模式下，编排逻辑存在于 Claude 的上下文中——每一步"接下来做什么"都是 Claude 基于当前上下文动态决定的。这意味着编排本身消耗上下文 token——50 个 Subagent 的编排历史会占据大量空间。Dynamic Workflows 把编排逻辑外化到一个 JavaScript 脚本中——循环、分支、中间结果都在脚本中，Claude 的上下文只保留"这个任务是什么"和"最终结果是什么"。这是 Context Engineering 的"Just-in-Time"原则在编排层面的应用——不把所有中间状态放进上下文，而是外化到代码中。

---

## 第 5 章 六种权限模式——渐进式授权

### 5.1 权限模式全景

Claude Code 的权限系统是两层结构：**模式（Mode）** 设置基线（多少操作可以不经询问执行），**规则（Rules）** 在基线上覆盖特定工具的允许/拒绝/询问行为。

六种权限模式按"自动化程度"递增排列：

| 模式 | 不经询问可执行的操作 | 适用场景 |
| :--- | :--- | :--- |
| `default`（Manual） | 仅读取 | 入门使用、敏感操作 |
| `acceptEdits` | 读取 + 文件编辑 + 常见文件系统命令（mkdir/touch/mv/cp 等） | 正在审查的代码迭代 |
| `plan` | 读取 + 分类器批准的只读命令（配合 auto 模式时） | 修改前的代码库探索 |
| `auto` | 一切操作，但有后台安全分类器审查 | 长任务，减少提示疲劳 |
| `dontAsk` | 仅预批准的工具 | 锁定的 CI 和脚本 |
| `bypassPermissions` | 一切操作，无任何检查 | 仅限隔离容器和 VM |

### 5.2 模式切换

会话中可以通过 `Shift+Tab` 在 `default` → `acceptEdits` → `plan` 之间循环切换。状态栏显示当前模式（如 `⏸ plan mode on`、`⏵⏵ accept edits on`）。`auto` 和 `bypassPermissions` 不在默认循环中——需要通过特定方式启用。

### 5.3 auto 模式——分类器驱动

auto 模式是 Claude Code 权限系统的精妙设计——它不是"允许一切"（像 bypassPermissions），而是用一个后台分类器（Sonnet 4.6）评估每个工具调用：

- 分类器判断操作是否**不可逆、有破坏性、或目标在环境之外**
- 安全操作自动执行，危险操作被阻止
- `deny` 和 `ask` 规则优先于分类器评估

`autoMode.environment` 配置告诉分类器"哪些仓库、云存储桶和域名是可信的"——默认只信任工作目录和当前仓库的配置 remote。推送到公司源代码组织、写入团队云存储桶等操作，在配置前会被阻止。

### 5.4 bypassPermissions——仅限隔离环境

bypassPermissions 跳过所有权限检查——包括受保护路径的检查。这个模式的设计意图是**仅在隔离容器和 VM 中使用**——如 Docker 容器、CI/CD 临时环境等"即使出问题也不会影响真实系统"的场景。

组织管理员可以通过 managed settings 的 `disableBypassPermissionsMode: "disable"` 禁用此模式——防止团队成员在非隔离环境中使用。

> [!warning] 生产避坑：bypassPermissions 的安全风险
> bypassPermissions 模式让 Claude Code 可以执行**任何**操作——包括 `rm -rf /`、`git push --force`、读取 `~/.ssh/` 下的私钥并写入网络。在有真实凭证和真实文件系统的工作站上使用这个模式是极其危险的——一次 Prompt Injection 攻击就可能导致密钥泄露或数据销毁。正确使用场景仅限于：1）Docker 容器（文件系统隔离）；2）临时 VM（可随时销毁）；3）CI/CD 临时环境（无敏感凭证）。即使在这些环境中，也应该配合 Egress 网络过滤（[[LLM/Agent沙箱技术/00 专栏导览|Agent 沙箱技术专栏]]第 08 篇的主题）防止数据外泄。

### 5.5 权限规则的评估顺序

当 Claude 请求调用工具时，权限检查按以下顺序执行：

1. **Hooks**：自定义钩子可以拒绝或放行
2. **deny 规则**：如果匹配，直接阻止（即使在 bypassPermissions 模式下）
3. **ask 规则**：如果匹配，转交 `canUseTool` 回调做人工确认（即使在 bypassPermissions 模式下）
4. **权限模式**：根据当前模式决定是否自动批准

关键设计：**deny 和 ask 规则优先于权限模式**——即使在 bypassPermissions 模式下，deny 规则仍然阻止操作，ask 规则仍然要求确认。这确保了"无论如何都不能执行的操作"始终被阻止。

---

## 第 6 章 Session 持久化与 Git 集成

### 6.1 Session 持久化

Claude Code 的会话可以持久化——支持 `resume` 恢复之前的会话。这意味着一个跨多日的长任务可以在每次会话中继续，而非从头开始。

会话持久化与 [[06 Prompt 上下文管理——Context Engineering 的艺术|第 6 篇]]讨论的 Memory Tool 配合——Claude Code 在会话间使用文件系统的 Memory Tool 保存关键发现和项目状态，下次会话开始时读取记忆恢复上下文。

### 6.2 Git 操作集成

Claude Code 的 Git 操作不是通过独立的"Git 工具"实现的——它通过 Bash 工具执行 `git` 命令。但 Claude Code 的系统提示包含 Git 操作的最佳实践指导：

- **Commit**：使用 Conventional Commits 格式，自动 `git add -A`，提交前检查无敏感文件（.env/.pem/.key）
- **Branch**：命名规范 `username/type/slug`，保持与 `origin/main` 同步
- **PR**：使用 `gh` CLI 创建 PR，支持 Draft PR
- **Worktree**：`git worktree add` 用于并行开发的文件隔离

### 6.3 Worktree 与并行会话

当多个 Claude Code 会话并行运行时（如 Agent View 模式），如果它们在同一个仓库工作，可能产生文件冲突。Git worktree 解决了这个问题——每个会话在独立的 worktree（独立的工作目录+独立的分支）中工作，互不干扰。

Agent View 自动为每个派发的后台会话创建独立的 worktree。手动并行运行时，开发者需要自己创建 worktree。

---

## 第 7 章 已知限制与生产避坑

### 7.1 Subagent 权限继承 bug

如前所述，Subagent 的权限继承存在几个已知 bug（Issue #37442、#51289、#73633）。在高度自动化场景中，这些 bug 可能导致 Subagent 意外要求权限确认。

### 7.2 上下文窗口管理

Claude Code 虽然使用了 Context Editing 和 Memory Tool，但极长会话仍然可能遇到上下文退化。建议：
- 使用 Subagent 隔离大探索任务
- 定期使用 `/compact` 命令手动触发上下文压缩
- 跨日任务使用 Memory Tool 保存关键状态

### 7.3 MCP Server PATH 问题

在 Claude Desktop 中遇到的 MCP Server PATH 问题在 Claude Code 中也存在——如果 MCP Server 配置中用的命令不在 Claude Code 的 PATH 中，会报 "command not found"。解决方案：使用绝对路径或在配置中显式设置 PATH。

### 7.4 权限规则与 Subagent 的交互

Subagent 的 `tools` 字段限制了可用工具集，但权限规则（allow/deny/ask）的传播在 Subagent 中有特殊行为——某些规则可能不按预期工作。在依赖细粒度权限规则的关键场景中，应测试 Subagent 的实际权限行为。

---

## 第 8 章 总结与下一篇导读

### 8.1 本文核心要点

1. **多表面架构**：Terminal CLI 为核心入口，VS Code/JetBrains/Slack/GitHub 等表面共享底层引擎——"Terminal 优先 = 能力优先"的设计哲学
2. **专用工具优于 Shell 命令**：Read/Edit/Write/Glob/Grep 提供更细粒度的权限控制、更清晰的审计日志、更 LLM 友好的输出格式
3. **Subagent 上下文隔离**：独立上下文窗口 + 自定义系统提示 + 工具限制 + 权限隔离——主 Agent 只接收精炼摘要，中间过程不污染主上下文
4. **四种并行模式**：Subagent（会话内）→ Agent View（多会话）→ Agent Teams（协调会话）→ Dynamic Workflows（脚本化大规模编排）——按任务规模递增选择
5. **六种权限模式渐进式授权**：default → acceptEdits → plan → auto → dontAsk → bypassPermissions，按自动化程度递增；auto 模式用分类器做安全审查；bypassPermissions 仅限隔离环境
6. **权限规则优先于模式**：deny 和 ask 规则即使在 bypassPermissions 模式下也生效——确保"绝对不能执行的操作"始终被阻止
7. **Session 持久化 + Memory Tool + Worktree**：跨会话状态恢复 + 外部记忆持久化 + 并行会话的文件隔离

### 8.2 下一篇导读

本文解构了 Anthropic 的 Claude Code。下一篇 [[08 Devin 与 ACI 设计——为 Agent 认知而生的计算机接口]] 将转向 Cognition 的 Devin——一个走完全不同路线的 Coding Agent。Devin 的核心创新不是工具集或权限模型，而是 ACI（Agent Computer Interface）概念——为 Agent 的认知模式而非人类的认知模式设计交互接口。我们将深入 Devin 的沙箱化计算环境、Computer Use 能力、长时任务执行机制，以及 Devin 2.0/2.1 的 Interactive Planning 和 Confidence Reporting 特性。

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Coding Agent 运行范式专栏]] 的第 7 篇。前 6 篇建立了 Agent 范式、ReAct 循环、Function Calling、MCP 协议、Context Engineering 的技术基础；本文将这些理论落地到 Claude Code 的具体架构。接下来第 8-10 篇将继续解构 Devin、OpenHands/Aider、Cursor 三大 Coding Agent。

---

## 参考文献

1. Claude Code Documentation. https://code.claude.com/docs/en
2. Claude Code Subagents. https://code.claude.com/docs/en/sub-agents
3. Claude Code Agent View. https://code.claude.com/docs/en/agent-view
4. Claude Code Dynamic Workflows. https://code.claude.com/docs/en/workflows
5. Claude Code Permission Modes. https://code.claude.com/docs/en/permission-modes
6. Claude Code Auto Mode Config. https://code.claude.com/docs/en/auto-mode-config
7. Claude Code Tools Reference. https://code.claude.com/docs/en/tools-reference
8. Claude Code Agents Overview. https://code.claude.com/docs/en/agents
9. Claude Code Permissions (SDK). https://code.claude.com/docs/en/agent-sdk/permissions
10. "Claude Code Permissions Explained." ClockedCode. https://clockedcode.com/blog/claude-code-permissions

---

## 思考题

1. **Claude Code 的 auto 模式用分类器判断每个工具调用的安全性。这个分类器本身是一个 LLM（Sonnet 4.6）。用 LLM 做安全决策有什么风险和优势？** 提示：考虑 LLM 的不确定性——分类器可能"误判"安全操作为危险（误拒）或危险操作为安全（误放）。与传统的基于规则的安全检查相比，LLM 分类器的精度和可预测性如何？

2. **Dynamic Workflows 把编排逻辑从"Claude 的上下文"移到"JavaScript 脚本"。这是否意味着 Claude 失去了对任务执行的控制？如果脚本执行中出现了 Claude 没预见到的情况，如何处理？** 提示：考虑脚本中是否可以包含"回调 Claude 做决策"的逻辑——当遇到预定义条件时，脚本暂停并请求 Claude 做新的决策，而非完全按照预写脚本执行。

3. **bypassPermissions 模式"仅限隔离容器和 VM 使用"，但 Claude Code 不会检测自己是否运行在隔离环境中——这个限制完全依赖用户自律。这是否是一个设计缺陷？应该如何改进？** 提示：考虑技术检测手段——Claude Code 能否检测自己是否在 Docker 容器中（如检查 `/.dockerenv` 文件）？是否应该在非隔离环境中拒绝 bypassPermissions 模式？
