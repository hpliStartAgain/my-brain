---
title: "技能系统——SKILL.md 与 agentskills.io 标准"
date: 2026-08-01
tags: [Hermes Agent, Skills System, SKILL.md, agentskills.io, Progressive Disclosure, Skills Hub, Skill Bundle, Context Files]
aliases: [Hermes 技能系统, SKILL.md 格式, agentskills.io 标准, Skills Hub, 技能堆叠, 技能媒体投递]
---

# 05 技能系统——SKILL.md 与 agentskills.io 标准

> [!abstract] 摘要
> [[04 学习闭环——Observe-Distill-Reuse-Refine|上一篇]]拆解了学习闭环的"过程"——技能如何从经验中生长。本文聚焦技能系统的"文档层面"——技能的格式、标准和生态。文章从 SKILL.md 的标准格式开始——front-matter（name/description/version/platforms/metadata）+ 四段正文（When to Use / Procedure / Pitfalls / Verification）——逐字段解释含义和编写要点。然后深入 agentskills.io 开放标准——这个由 Hermes 推动的标准让技能可以跨 Agent 共享——Claude Code、Cursor、OpenHands、Gemini CLI、GitHub Copilot 等 18+ Agent 都支持——形成了"88k+ 技能"的共享生态。接着讨论技能的进阶特性：平台特定性（macOS/Linux/Windows 自动隐藏）、技能输出与媒体投递（`[[as_document]]` 和 `[[audio_as_voice]]` 指令）、外部技能目录、技能包（Skill Bundle）、技能的 opt-out 机制。最后对比 Hermes 技能与 MCP 的定位差异——技能是"知识"（告诉 Agent 怎么做），MCP 是"工具"（让 Agent 能做新事）——两者互补。核心认知：agentskills.io 标准的意义不亚于 MCP——MCP 标准化了"Agent 与工具的连接"，agentskills.io 标准化了"Agent 与知识的连接"——两者共同构成 Agent 生态的"双标准"。

---

## 第 1 章 SKILL.md 标准格式

### 1.1 完整格式示例

SKILL.md 是技能的"源文件"——一个 Markdown 文件，带 YAML front-matter：

```markdown
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
platforms: [macos, linux]     # 可选——限制特定 OS 平台
metadata:
  hermes:
    tags: [python, automation]
    category: devops
    fallback_for_toolsets: [web]    # 可选——条件激活
    requires_toolsets: [terminal]   # 可选——条件激活
    config:                          # 可选——config.yaml 设置
      - key: my.setting
        description: "What this controls"
        default: "value"
        prompt: "Prompt for setup"
---

# Skill Title

## When to Use
Trigger conditions for this skill.

## Procedure
1. Step one
2. Step two

## Pitfalls
- Known failure modes and fixes

## Verification
How to confirm it worked.
```

### 1.2 Front-matter 字段详解

**name**（必填）：技能的唯一标识符——也是 slash 命令名（如 `name: github-pr-workflow` 对应 `/github-pr-workflow`）。应使用 kebab-case（小写 + 连字符）——如 `my-skill` 而非 `MySkill` 或 `my_skill`。

**description**（必填）：技能的简短描述——≤60 字符。这个描述出现在 Level 0 的 `skills_list()` 中——是 Agent 判断"是否需要加载完整内容"的依据。描述应"精确且具触发词"——如"Review GitHub PRs: check CI, summarize diff, flag style violations"——而非"Help with PRs"（太模糊）。

**version**（推荐）：语义化版本号——如 `1.0.0`。用于追踪技能的更新——当技能通过 Skills Hub 共享时，版本号让其他用户知道是否需要更新。

**platforms**（可选）：限制技能在特定操作系统上加载——`[macos]`（仅 macOS）、`[linux]`（仅 Linux）、`[windows]`（仅 Windows）、`[macos, linux]`（macOS 和 Linux）。省略则所有平台加载。当设置后，技能在不兼容平台上自动从系统提示、`skills_list()` 和 slash 命令中隐藏。

**metadata.hermes**（可选）：Hermes 特定的元数据——`tags`（标签，用于分类）、`category`（类别）、`fallback_for_toolsets`（当指定 toolset 不可用时作为 fallback 激活）、`requires_toolsets`（需要指定 toolset 才激活）、`config`（技能的配置项，在 setup 时提示用户）。

**config 字段的用途**：`config` 让技能可以声明"需要用户配置的设置项"——如"部署技能"可能需要"K8s namespace"和"镜像仓库地址"。当用户首次使用该技能时，Hermes 的 setup 向导会提示用户填写这些配置——填写后存储在 `config.yaml` 中——技能执行时读取。这种"技能自带配置"机制让"需要环境特定信息的技能"可以"安装时配置，使用时自动读取"——不需要用户每次手动提供。

### 1.3 正文四段结构

**When to Use**：技能的"触发条件"——什么情况下应该使用这个技能。如"当用户要求审查 GitHub PR 时"或"当需要部署到 K8s 生产环境时"。这段帮助 Agent 判断"当前任务是否匹配这个技能"。

**Procedure**：技能的"执行步骤"——按顺序列出操作。如"1. 读取 PR diff 2. 检查 CI 状态 3. 标记风格违规 4. 发布审查评论"。步骤应"具体且可执行"——而非"审查 PR"这种模糊描述。

**Pitfalls**：技能的"已知陷阱"——失败模式和修复方法。这段在技能创建时通常为空或少量——大部分 Pitfalls 在使用中通过 Refine 阶段自动追加。如"不要跳过 CI 检查，即使 CI 看起来通过——有时 CI 报告延迟"。

**Verification**：技能的"验证方法"——如何确认技能执行成功。如"PR 评论已发布且无 CI 失败"。这段让 Agent 在执行技能后能"自检"——确认是否真的成功了。

> [!note] 编写标准：Hermes 的"技能编写规范"
> Hermes 的 `/learn` 命令和自动技能生成都遵循一套"技能编写规范"——≤60 字符描述、标准段落顺序（When to Use → Procedure → Pitfalls → Verification）、Hermes 工具框架（用 Hermes 已有工具描述步骤，不发明命令）、不编造命令（如果不确定命令是否存在，标注"需要验证"）。这套规范确保技能的"质量"和"可执行性"——低质量技能（如"步骤模糊"或"命令不存在"）会降低 Agent 的可靠性。

### 1.4 编写实践——一个好技能的例子

以"GitHub PR 审查"技能为例，展示一个好技能的完整结构：

```markdown
---
name: github-pr-workflow
description: Review GitHub PRs: check CI, summarize diff, flag style violations
version: 1.2.0
metadata:
  hermes:
    tags: [github, code-review, ci]
    category: devops
    requires_toolsets: [terminal, web]
---

# GitHub PR Review Workflow

## When to Use
- 用户要求审查 GitHub PR
- PR 编号或 URL 已知
- 需要 CI 状态、diff 摘要和风格检查

## Procedure
1. 用 `gh pr view <PR_NUMBER>` 获取 PR 元数据（标题、作者、分支）
2. 用 `gh pr diff <PR_NUMBER>` 获取完整 diff
3. 用 `gh pr checks <PR_NUMBER>` 检查 CI 状态
4. 总结 diff 的主要变更（按文件分组）
5. 标记风格违规（基于项目的 lint 配置）
6. 用 `gh pr comment <PR_NUMBER> --body "<review>"` 发布审查评论

## Pitfalls
- 不要跳过 CI 检查，即使 CI 看起来通过——有时 CI 报告延迟
- 大 PR（500+ 行 diff）应分段审查，不要一次性总结
- 注意检查 PR 是否基于过时的主分支——可能需要 rebase

## Verification
- PR 评论已发布（`gh pr view <PR_NUMBER> --comments` 可见）
- CI 状态已检查并报告
- 风格违规已标记（如果有）
```

**这个技能为什么好**：1）description 精确且具触发词（"Review GitHub PRs"、"check CI"、"flag style violations"）——Agent 容易判断是否匹配；2）Procedure 具体（用 `gh` 命令而非"检查 CI"这种模糊描述）；3）Pitfalls 来自实际使用经验（"CI 报告延迟"、"大 PR 分段"）；4）Verification 可验证（用 `gh pr view --comments` 确认评论已发布）。

**对比一个"坏技能"**：坏技能的例子是 description 写"Help with GitHub"（太模糊）、Procedure 写"审查代码"（没有具体步骤）、Pitfalls 为空（没有实践经验）、Verification 写"完成审查"（不可验证）。坏技能让 Agent 不知道"何时用"、不知道"怎么做"、不知道"避开什么"、不知道"是否做对了"——实际上降低了 Agent 的可靠性，反而不如没有技能。Hermes 的技能编写规范正是为了防止这类坏技能——通过"≤60 字符描述"、"标准段落顺序"、"不发明命令"等规则确保技能质量始终在线达标可用。

---

## 第 2 章 agentskills.io 开放标准

### 2.1 标准的定位

agentskills.io 是一个开放标准——定义了"AI Agent 技能"的格式和交互协议。它的目标是让"技能"可以跨 Agent 共享——如 Hermes 创建的技能可以被 Claude Code 使用，Claude Code 创建的技能可以被 Hermes 使用。

### 2.2 支持的 Agent 生态

agentskills.io 已获得 18+ Agent 的支持——从官网的 Logo Carousel 可以看到：

| Agent | 类型 | 技能支持 |
| :--- | :--- | :--- |
| Claude Code | 编码 Agent | code.claude.com/docs/en/skills |
| Cursor | IDE Agent | cursor.com/docs/context/skills |
| OpenHands | 开源编码 Agent | docs.openhands.dev/overview/skills |
| Gemini CLI | Google CLI Agent | geminicli.com/docs/cli/skills/ |
| GitHub Copilot | IDE 助手 | docs.github.com/en/copilot/.../about-agent-skills |
| VS Code | 编辑器 | code.visualstudio.com/docs/.../agent-skills |
| OpenAI Codex | 编码 Agent | developers.openai.com/codex/skills/ |
| Amp | 编码 Agent | ampcode.com/manual#agent-skills |
| Goose | 开源 Agent | block.github.io/goose/.../using-skills/ |
| Letta | 有状态 Agent | docs.letta.com/letta-code/skills/ |
| OpenCode | 开源 Agent | opencode.ai/docs/skills/ |
| Mux | 并行 Agent | mux.coder.com/agent-skills |
| Factory | 开发平台 | factory.ai |
| Piebald | 桌面/Web 应用 | piebald.ai |
| Junie | IntelliJ Agent | junie.jetbrains.com/.../agent-skills.html |
| ZeroClaw | Rust Agent | docs.zeroclawlabs.ai/.../skills.html |
| Autohand Code | CLI Agent | autohand.ai/.../agent-skills.html |
| Firebender | Android Agent | docs.firebender.com/multi-agent/skills |

**生态规模**：Skills Hub 宣称有"88k+ 技能跨每个注册表"——虽然这个数字可能包含"自动生成"或"低质量"技能，但它反映了 agentskills.io 生态的规模。这个规模让"共享技能"成为现实——如"GitHub PR 工作流"技能可能由一个 Claude Code 用户创建，但 Hermes 用户也可以安装使用。

**生态多样性的意义**：支持的 Agent 涵盖了"编码 Agent"（Claude Code/Cursor/OpenHands/Codex）、"通用 Agent"（Hermes/Goose/OpenCode）、"IDE 集成"（VS Code/Copilot/Junie）、"有状态 Agent"（Letta）、"并行 Agent"（Mux）、甚至"Android Agent"（Firebender）——这种多样性意味着"技能"的概念不限于"编码"——任何需要"程序性知识"的 Agent 场景都适用。如"数据清洗流程"技能既可用于编码 Agent（在 IDE 中清洗数据），也可用于通用 Agent（在 Telegram 上清洗用户上传的数据）。

**对 Hermes 的战略意义**：agentskills.io 标准的广泛支持对 Hermes 有战略意义——它让 Hermes 不需要"自己建技能生态"——可以直接利用已有的 88k+ 技能。如果 agentskills.io 没有成为标准，Hermes 需要"自己建技能市场"——这是一个"先有鸡还是先有蛋"的问题（用户少则贡献者少，贡献者少则技能少，技能少则用户少）。通过推动 agentskills.io 标准，Hermes 把"建生态"变成了"共建生态"——与其他 Agent 共享贡献者基础——这让 88k+ 技能成为可能。这种"共建生态"策略是开源项目的典型智慧——不重复造轮子，而是与社区共建，共享成果与贡献者基础，实现多方共赢，推动整个生态持续向前发展与繁荣。

### 2.3 跨 Agent 共享的意义

agentskills.io 标准的意义不亚于 MCP（Model Context Protocol）：

| 标准 | 标准化什么 | 类比 |
| :--- | :--- | :--- |
| **MCP** | Agent 与**工具**的连接 | USB 标准——设备接口 |
| **agentskills.io** | Agent 与**知识**的连接 | 文档格式标准——如 Markdown |

MCP 让"工具"可以跨 Agent 共享——如一个 MCP Server 写一次，Claude Code/Hermes/Cursor 都能用。agentskills.io 让"知识"可以跨 Agent 共享——如一个技能写一次，所有兼容 Agent 都能用。两者互补——MCP 解决"能做什么"，agentskills.io 解决"怎么做"。

### 2.4 标准化的技术挑战

让技能跨 Agent 共享并非易事——不同 Agent 的"工具集"和"交互模式"不同。agentskills.io 标准需要解决几个技术挑战：

**工具名称差异**：Hermes 的 `read_file` 工具在 Claude Code 中可能叫 `Read`，在 Cursor 中可能叫 `file_read`。技能的 Procedure 如果写"调用 read_file"，其他 Agent 可能不认识。解决方案是"工具能力抽象"——技能描述"需要读取文件的能力"而非"调用 read_file"——各 Agent 用自己的工具实现。

**交互模式差异**：Hermes 支持消息平台（Telegram/Discord），Claude Code 是 CLI/IDE。技能如果包含"发送 Telegram 消息"的步骤，在 Claude Code 中无法执行。解决方案是"平台无关的步骤描述"——如"通知用户结果"而非"发送 Telegram 消息"——各 Agent 用自己的通知机制。

**上下文差异**：Hermes 有"持久记忆"和"跨会话上下文"，有些 Agent 没有。技能如果依赖"记住用户偏好"，在没有持久记忆的 Agent 中无法工作。解决方案是"能力声明"——技能在 front-matter 中声明"requires memory"——不满足的 Agent 不加载该技能。

这些挑战意味着"完全跨 Agent 共享"需要"抽象化"——而这可能降低技能的"具体性"和"可执行性"。agentskills.io 标准在这两者之间寻找平衡——这是一个仍在演进的标准。

> [!info] 核心概念：技能 vs MCP 的定位差异
> 技能是"知识"——告诉 Agent "怎么做"某事——如"PR 审查的步骤是什么"。MCP 是"工具"——让 Agent "能做"新事——如"连接到 GitHub API"。一个 Agent 可以"有 PR 审查技能但没有 GitHub MCP"——它知道"怎么做 PR 审查"但"不能访问 GitHub API"——技能无法执行。反之，"有 GitHub MCP 但没有 PR 审查技能"——它能"访问 GitHub"但不知道"PR 审查的标准流程"。两者结合才完整——技能提供"知识"，MCP 提供"能力"。这与 [[LLM/Coding-Agent运行范式/04 MCP 协议深度解析——Agent 与工具的标准化连接|Coding Agent 专栏第 4 篇]]讨论的 MCP 标准形成了呼应——MCP 和 agentskills.io 是 Agent 生态的"双标准"。

---

## 第 3 章 技能的进阶特性

### 3.1 平台特定性

技能可以通过 `platforms` 字段限制在特定操作系统上加载：

```yaml
platforms: [macos]            # 仅 macOS（如 iMessage、Apple Reminders、FindMy）
platforms: [macos, linux]     # macOS 和 Linux
```

当设置后，技能在不兼容平台上自动从系统提示、`skills_list()` 和 slash 命令中隐藏。这让"平台特定技能"不会在"不兼容平台"上造成混淆——如"iMessage 技能"在 Linux 上不可见——用户不会误以为可以在 Linux 上发 iMessage。

**平台识别的映射**：`macos` 匹配 Darwin 系统，`linux` 匹配 Linux，`windows` 匹配 Windows。这种"简单映射"覆盖了绝大多数场景——但对于"复杂环境"（如 WSL2 是 Linux 但宿主是 Windows），可能需要更细致的判断——Hermes 在 WSL2 中通常识别为 Linux——因为 WSL2 的工具链是 Linux 的。

**为什么需要平台特定性**：某些工具和 API 只在特定平台可用——如 Apple 的 iMessage、Reminders、FindMy 只在 macOS 上；Windows 的某些 WSL 命令只在 Windows 上。如果不限制平台，Agent 可能在 Linux 上尝试用 iMessage——导致失败和困惑。平台特定性让"技能库"在不同平台上"自动适配"——用户不需要手动管理"哪些技能在我的平台上可用"。

### 3.2 技能输出与媒体投递

当技能响应（或任何 Agent 响应）包含裸的绝对路径指向媒体文件——如 `/home/user/screenshots/diagram.png`——网关自动检测它，从可见文本中剥离，并把文件原生投递到用户的聊天中（Telegram photo、Discord attachment 等）——而不是在消息中留下原始路径。

**`[[as_document]]` 指令**：有时你想要"相反"的行为——把文件作为"可下载附件"投递，而非"内联预览"。经典场景是"高分辨率截图或图表"——Telegram 的 `sendPhoto` 会重压缩到 ~200KB / 1280px，破坏可读性。1-2MB 的 PNG 用 `sendDocument` 保持原始字节不变。如果响应包含字面指令 `[[as_document]]`，该响应的所有媒体路径作为文档/文件附件投递而非图片气泡。

**`[[audio_as_voice]]` 指令**：对于音频，`[[audio_as_voice]]` 把音频文件提升为"原生语音消息气泡"——在支持的平台上（Telegram、WhatsApp）。

**自动检测的工程价值**：这种"路径自动检测 + 原生投递"设计让技能（和 Agent）不需要"知道"目标平台的媒体投递机制——如技能不需要写"如果是 Telegram 用 sendPhoto，如果是 Discord 用 attachment"——只需要在响应中包含文件路径，网关自动处理。这种"平台无关的媒体投递"让技能可以跨平台工作——同一个技能在 Telegram 和 Discord 上都能正确投递媒体——不需要为每个平台写特殊逻辑。

### 3.3 外部技能目录

除了主目录 `~/.hermes/skills/`，Hermes 还支持"外部技能目录"——额外的文件夹与本地目录一起扫描。这让"团队共享技能"或"项目特定技能"成为可能——如团队可以把共享技能放在 Git 仓库中，每个成员把该仓库克隆为外部技能目录。

**团队协作场景**：一个团队可以维护一个"团队技能仓库"——包含团队约定的 PR 审查流程、部署流程、代码风格指南等。新成员加入时，把团队技能仓库克隆为外部技能目录——立即获得团队的所有技能。这种"技能即代码"（Skills as Code）模式让"团队知识"可以版本控制、代码审查、持续集成——比"口口相传"或"文档 wiki"更可靠。

**项目特定技能**：一个项目可以有"项目特定技能"——如"这个项目的部署流程"——放在项目仓库的 `.hermes/skills/` 目录。当 Agent 在该项目目录工作时，自动加载项目特定技能。这种"项目级技能"让"项目知识"与"项目代码"同生命周期——代码删除时技能也删除。

### 3.4 技能包（Skill Bundle）

对于"反复使用的技能组合"，可以创建"技能包"——一个短命令加载多个技能——效果与"堆叠多个 slash 命令"相同，但在一个短命令下。如"code-review-bundle"可能包含"github-pr-workflow + test-driven-development + style-guide"三个技能——用户调用 `/code-review-bundle` 一次加载所有。

**技能包 vs 单个大技能**：技能包与"把多个技能合并为一个大技能"不同。技能包保持"子技能的独立性"——每个子技能仍然可以单独使用和更新——而"合并的大技能"把所有逻辑揉在一起，难以部分更新。技能包的"组合而不合并"设计让"模块化"和"可维护性"更好——如"style-guide"子技能可以在"code-review-bundle"和"lint-bundle"中复用——不需要在每个包中重复。

### 3.5 条件激活——fallback_for_toolsets 和 requires_toolsets

front-matter 的 `metadata.hermes` 中有两个"条件激活"字段：

**`requires_toolsets`**：技能需要指定 toolset 才激活——如 `requires_toolsets: [terminal]`——如果当前环境没有 terminal toolset（如在某些消息平台上禁用了终端），技能不加载。这防止"技能加载了但无法执行"的尴尬——如"部署技能"需要终端工具，在 Telegram 上如果禁用了终端，部署技能不应该出现。

**`fallback_for_toolsets`**：当指定 toolset 不可用时作为 fallback 激活——如 `fallback_for_toolsets: [web]`——如果 web toolset 不可用，这个技能作为"替代方案"加载。这用于"工具不可用时提供手动方法"——如"web_search 工具不可用时，加载'手动浏览搜索'技能"——让 Agent 在"工具缺失"时仍有应对方案。

### 3.5 技能的 opt-out 机制

默认每个 profile 都会种子化"捆绑技能目录"——每次 `hermes update` 添加新捆绑技能。如果想要"无捆绑技能"的 profile——保持跨更新为空——有三种路径：

```bash
# 安装时（默认 profile）
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --no-skills

# 创建 profile 时
hermes profile create research --no-skills

# 已安装 profile 上切换
hermes skills opt-out            # 停止未来种子化——磁盘上不动任何东西
hermes skills opt-out --remove   # 也删除未修改的捆绑技能（先确认）
hermes skills opt-in --sync      # 撤销：移除标记并立即重新种子化
```

**安全默认**：`hermes skills opt-out` 只停止"未来种子化"——不删除磁盘上已有的任何东西。可选的 `--remove` 标志只删除"未修改"的捆绑技能（字节相同于 Hermes 安装的版本）。用户编辑过的技能、从 Hub 安装的技能、用户自己写的技能——总是保留。

**opt-out 的使用场景**：为什么有人要 opt-out 捆绑技能？几个场景：1）"极简主义者"——只想要自己创建的技能，不要捆绑的——减少"技能列表"的噪音；2）"安全敏感"——不信任捆绑技能的安全性——想完全控制技能库；3）"研究用途"——用 Hermes 做研究时，想要"空白"的技能库作为实验基线——避免捆绑技能干扰实验。opt-out 机制让这些场景成为可能——同时保持"可以 opt-in 回来"的可逆性。这种"可逆的 opt-out"设计体现了 Hermes "用户控制优先"的理念——用户对技能库有完全控制权，而非被"强制"接受捆绑内容。

---

## 第 4 章 Skills Hub——技能市场

### 4.1 Skills Hub 的定位

Skills Hub（https://agentskills.io）是 agentskills.io 标准的"集中市场"——用户可以在这里发现、搜索、安装技能。Hermes 的 `/skills` slash 命令（`hermes_cli/skills_hub.py`）让用户可以直接在 CLI 中浏览和安装 Hub 上的技能。

### 4.2 技能的分类

Skills Hub 的技能分为三类：
- **Built-in（内置）**——Hermes 捆绑的技能，始终可用
- **Optional（可选）**——官方可选技能，需要显式安装
- **Community（社区）**——社区贡献的技能，通过 Hub 分发

这种"三层分类"让用户可以"按需安装"——不需要的技能不占空间——同时"内置技能"保证"开箱即用"的基本能力。

**内置技能的例子**：Hermes 捆绑的技能包括 `plan`（创建实现计划而非直接执行）、`axolotl`（微调 Llama 模型）、`github-pr-workflow`（PR 审查）、`ocr-and-documents`（OCR 和文档处理）、`excalidraw`（图表绘制）等。这些技能覆盖了"开发者常用"和"AI 研究常用"两类场景——反映了 Hermes 的"个人助理 + 研究工具"双重定位。

**可选技能的例子**：官方可选技能可能包括更专业或更重量的技能——如"K8s 部署完整流程"、"数据科学分析流程"——这些技能可能依赖特定工具或环境，不适合"内置"——用户按需安装。

**社区技能的多样性**：社区技能的多样性是 Skills Hub 的最大价值——88k+ 技能覆盖了从"特定 API 集成"到"特定行业工作流"的长尾需求——这些是 Hermes 团队不可能"内置"的——但通过社区贡献，用户可以找到"几乎任何场景"的技能。

### 4.3 技能的安装与更新

通过 `/skills` 命令安装的技能也放在 `~/.hermes/skills/`——与自动生成的技能和捆绑技能在同一目录。Agent 可以修改或删除任何技能——包括 Hub 安装的——这让用户可以"定制"Hub 技能以适应自己的需求。技能更新时，如果用户修改过该技能，Hermes 不会"覆盖"修改——而是提示用户"有更新可用，但你修改过这个技能——要合并还是跳过？"。

### 4.4 技能的生命周期管理

技能在 Hermes 中有完整的生命周期管理：

- **创建**——通过学习闭环自动生成、`/learn` 显式创建、或从 Hub 安装
- **使用**——通过 slash 命令调用、Agent 自动发现加载、或技能包组合
- **改进**——通过 Refine 阶段自动 patch Pitfalls、或用户手动编辑
- **更新**——Hub 技能有新版本时提示用户（尊重本地修改）
- **删除**——用户可以删除任何技能——`hermes skills opt-out --remove` 批量删除未修改的捆绑技能

这种"完整生命周期"让技能库可以"新陈代谢"——低价值技能被删除，高价值技能被保留和改进——避免技能库"无限膨胀"。

---

## 第 5 章 技能与上下文文件的关系

### 5.1 上下文文件

除了技能，Hermes 还有"上下文文件"机制——自动发现和加载项目上下文文件（`.hermes.md`、`AGENTS.md`、`CLAUDE.md`、`SOUL.md`、`.cursorrules`）——这些文件塑造 Agent 在项目中的行为。

### 5.2 技能 vs 上下文文件

| 维度 | 技能（SKILL.md） | 上下文文件（.hermes.md 等） |
| :--- | :--- | :--- |
| **加载时机** | 按需（渐进式披露） | 自动（进入项目时） |
| **作用范围** | 特定任务类型 | 整个项目 |
| **内容** | "如何做某事"的程序 | 项目的"规则"和"背景" |
| **Token 成本** | 低（按需加载） | 高（始终在系统提示） |
| **可共享** | 是（agentskills.io） | 通常不共享（项目特定） |
| **创建方式** | 学习闭环自动生成 / /learn / Hub 安装 | 用户手动编写 |
| **更新频率** | 高（Refine 阶段自动 patch） | 低（项目规则很少变） |

**互补关系**：上下文文件告诉 Agent "这个项目的规则是什么"——如"用 Python 3.11"、"测试用 pytest"。技能告诉 Agent "某类任务怎么做"——如"PR 审查的步骤"。两者结合——Agent 既知道"项目规则"又知道"任务流程"。

**实际协作场景**：当用户说"审查这个 PR"时，Agent 首先从上下文文件知道"这个项目用 Python 3.11 和 pytest"——然后从技能库加载"PR 审查技能"——技能的步骤可能包括"运行 pytest 验证"——因为上下文文件告诉了 Agent 项目的测试框架。这种"上下文文件提供背景 + 技能提供流程"的协作让 Agent 的行为既"符合项目规范"又"遵循最佳实践"。

**支持的上下文文件格式**：Hermes 自动发现多种上下文文件——`.hermes.md`（Hermes 原生）、`AGENTS.md`（通用 Agent 规范）、`CLAUDE.md`（Claude Code 兼容）、`SOUL.md`（人格文件）、`.cursorrules`（Cursor 兼容）。这种"多格式兼容"让 Hermes 可以"理解"为其他 Agent 写的项目配置——降低从其他 Agent 迁移到 Hermes 的成本。如一个项目原本有 `CLAUDE.md`——Hermes 用户不需要重写为 `.hermes.md`——直接用即可。

---

## 第 6 章 总结与下一篇导读

### 6.1 本文核心要点

1. **SKILL.md 标准格式**——front-matter（name/description/version/platforms/metadata）+ 四段正文（When to Use / Procedure / Pitfalls / Verification）——description ≤60 字符是关键
2. **agentskills.io 开放标准**——18+ Agent 支持（Claude Code/Cursor/OpenHands/Gemini CLI/GitHub Copilot 等）——88k+ 技能的共享生态
3. **技能 vs MCP 的定位差异**——技能是"知识"（怎么做），MCP 是"工具"（能做什么）——两者互补——构成 Agent 生态"双标准"
4. **平台特定性**——`platforms` 字段让技能在不兼容 OS 上自动隐藏
5. **媒体投递指令**——`[[as_document]]`（文档附件 vs 图片气泡）、`[[audio_as_voice]]`（语音消息气泡）
6. **外部技能目录**——支持团队共享技能和项目特定技能
7. **技能包**——一个短命令加载多个技能——用于反复使用的技能组合
8. **opt-out 机制**——`hermes skills opt-out` 停止捆绑技能种子化——安全默认不删除已修改技能
9. **Skills Hub**——88k+ 技能的集中市场——`/skills` 命令浏览安装
10. **技能 vs 上下文文件**——技能按需加载/特定任务/可共享，上下文文件自动加载/整个项目/项目特定

### 6.2 下一篇导读

下一篇 [[06 持久记忆——MEMORY.md/USER.md/Honcho]] 将从"程序性记忆"（技能）转向"陈述性记忆"（事实）——深入 Hermes 的持久记忆系统。基于 MEMORY.md（2200 字符限制）和 USER.md（1375 字符限制）的"高密度约束"设计、快照缓存机制（会话开始时冻结快照注入系统提示，支持 prefix cache）、Honcho 辩证法用户建模（跨会话用户理解的 Memory Provider 插件）、以及 8 种 Memory Provider 插件（Honcho/OpenViking/Mem0/Hindsight/Holographic/RetainDB/ByteRover/Supermemory）。

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Hermes Agent 专栏]] 的第 5 篇，"核心架构"部分的第 3 篇。

---

## 参考文献

1. Hermes Agent Skills System 文档. https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
2. agentskills.io. https://agentskills.io
3. agentskills.io 规范. https://agentskills.io/specification
4. Hermes Agent Skills Hub. https://hermes-agent.nousresearch.com/docs/skills
5. Hermes Agent Context Files. https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files

---

## 思考题

1. **agentskills.io 标准让技能可以跨 Agent 共享——但不同 Agent 的"工具集"不同。如 Hermes 有 `delegate_task` 工具，Claude Code 没有。如果一个技能的 Procedure 中用了 `delegate_task`，Claude Code 用户安装后会怎样？技能是否需要"Agent 特定"？** 提示：考虑"技能的抽象层级"——好的技能应该在"步骤层"抽象，而非"工具层"具体。如"并行处理多个子任务"而非"调用 delegate_task"——这样不同 Agent 可以用各自工具实现"并行"。但如果技能过于抽象，又失去了"可执行性"。agentskills.io 标准可能需要定义"工具能力描述"——让技能声明"需要并行能力"——而非"需要 delegate_task 工具"。

2. **Skills Hub 有 88k+ 技能——但质量参差不齐。如何防止"低质量技能"污染生态？是否需要"技能审核"机制？** 提示：考虑"开源生态的质量控制"——如 npm 有"下载量"和"star"作为质量信号，但没有"审核"。agentskills.io 可能采用类似模式——用"安装量"和"用户评分"作为质量信号——而非"中心化审核"。但"技能"比"代码包"风险更高——一个"跳过测试"的技能可能导致用户的生产系统故障——可能需要"危险技能"标记。

3. **技能的 `[[as_document]]` 和 `[[audio_as_voice]]` 指令是 Hermes 特定的——不是 agentskills.io 标准。这是否违反了"跨 Agent 共享"的理念？如果 Claude Code 不认识这些指令，会怎样？** 提示：考虑"指令的降级处理"——好的指令设计应该"不认识时安全降级"。`[[as_document]]` 如果不认识，最坏情况是"作为文本显示在消息中"——不会导致错误。这种"安全降级"让 Hermes 特定指令可以"向前兼容"——不破坏跨 Agent 共享——但 Hermes 用户获得"增强体验"。
