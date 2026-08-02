---
title: "学习闭环——Observe-Distill-Reuse-Refine"
date: 2026-08-01
tags: [Hermes Agent, Learning Loop, Self-Improving, skill_manage, Nudge Engine, Episodic Memory, Pitfalls, Skill Creation]
aliases: [Hermes 学习闭环, Observe-Distill-Reuse-Refine, skill_manage, Nudge Engine, Hermes 自改进机制]
---

# 04 学习闭环——Observe-Distill-Reuse-Refine

> [!abstract] 摘要
> [[03 架构总览——AIAgent 核心循环与子系统|上一篇]]完成了架构总览。本文深入 Hermes 最独特的子系统——学习闭环（Learning Loop）。这是 Hermes 与所有其他 Agent 的根本区别——不是"模型权重在改变"，而是"程序性记忆在积累"。文章基于 skill_manage 工具的 schema 定义和 Nudge Engine 机制，逐阶段拆解 Observe→Distill→Reuse→Refine 四步循环：Observe 阶段的 episodic memory 追踪（每次工具调用、决策分支、用户纠正）；Distill 阶段的触发条件（5+ 工具调用、错误恢复、用户纠正后方法有效、非平凡工作流发现、用户要求）和 SKILL.md 生成；Reuse 阶段的渐进式披露加载（3 级 token 效率）；Refine 阶段的 Pitfalls 自动追加和 skill_manage patch 操作。然后讨论 Nudge Engine——学习闭环的"驱动器"——如何在"对话自然间隙"插入反思提示而非"强制执行"。最后分析学习闭环的局限性和改进方向。核心认知：Hermes 的"自改进"是"程序性记忆积累"而非"模型权重更新"——这种"不改模型"的自改进让任何 LLM 都能"越用越强"——是"模型无关"理念在学习层面的延伸。

---

## 第 1 章 学习闭环的定位——程序性记忆 vs 模型权重

### 1.1 两种"自改进"路径

AI 系统的"自改进"有两条根本不同的路径：

| 路径 | 机制 | 代表 | 代价 |
| :--- | :--- | :--- | :--- |
| **模型权重更新** | 在使用中微调模型权重 | RLHF、在线学习、持续训练 | 需要 GPU、训练数据、风险高 |
| **程序性记忆积累** | 在使用中积累"如何做"的知识 | Hermes 学习闭环 | 只需要文件系统、低风险 |

**模型权重更新**的典型例子是"RLHF"——用人类反馈强化学习，更新模型权重。这种方式"自改进"效果好——模型本身变强了——但代价高昂：需要 GPU 集群、大量训练数据、且"改坏了"难以回滚（权重是黑盒）。

**程序性记忆积累**的典型例子是 Hermes 的学习闭环——不修改模型权重，而是积累"如何做某类任务"的技能文档（SKILL.md）。这种方式"自改进"效果不如"权重更新"——模型本身没变——但代价低：只需要文件系统，不需要 GPU；且"改坏了"容易回滚（技能是文本文件，可以删除或修改）。

### 1.2 Hermes 选择"程序性记忆"的原因

Hermes 选择"程序性记忆积累"而非"模型权重更新"有几个原因：

**模型无关的延伸**：Hermes 的核心理念之一是"模型无关"——可以用任何 LLM。如果"自改进"依赖"权重更新"，那么只能改进"可微调的模型"——闭源模型（GPT-4/Claude）无法改进。"程序性记忆积累"与模型无关——无论用什么 LLM，都可以积累技能——这是"模型无关"理念在学习层面的延伸。

**低风险**：权重更新是"黑盒"——改坏了难以诊断和回滚。技能是"白盒"——是文本文件，用户可以阅读、修改、删除。如果 Agent 学到了"错误技能"（如"部署时总是跳过测试"），用户可以直接打开 SKILL.md 修改——不需要"重新训练"。

**可移植性**：技能是文本文件——可以从一个 Hermes 实例导出，导入到另一个实例。如"我在工作 Hermes 上学到的 PR 审查技能，可以导出到个人 Hermes 上使用"。权重更新不可移植——一个实例的权重不能"复制"到另一个实例（除非两个实例用完全相同的模型）。更重要的是，技能遵循 agentskills.io 开放标准——意味着 Hermes 的技能可以被其他兼容 Agent（如 Claude Code、Cursor、OpenHands）使用——反之亦然。这种"跨 Agent 技能共享"是"程序性记忆积累"路径的独特优势——权重更新无法跨模型共享。第 05 篇会深入 agentskills.io 标准。

> [!info] 核心概念：程序性记忆
> "程序性记忆"（procedural memory）是认知科学术语——指"如何做某事"的记忆，如骑自行车、写代码、做 PR 审查。与之对应的是"陈述性记忆"（declarative memory）——指"事实"的记忆，如"巴黎是法国首都"。Hermes 的"技能"对应"程序性记忆"（如何做），"MEMORY.md/USER.md"对应"陈述性记忆"（事实）。第 06 篇会深入陈述性记忆。学习闭环的核心是"程序性记忆的自动积累"——Agent 从实践中"学会如何做"——而不需要用户手动编写技能。

---

## 第 2 章 Observe 阶段—— episodic memory 追踪

### 2.1 什么是 episodic memory

Observe 阶段的基础是"episodic memory"（情景记忆）——Hermes 在每个任务执行过程中追踪"发生了什么"：

- **每次工具调用**——调用了什么工具、参数是什么、返回了什么
- **每个决策分支**——模型在什么时刻选择了什么行动
- **每次用户纠正**——用户在什么时刻纠正了 Agent 的方向

这种追踪不是简单的"对话日志"——而是结构化的"任务执行轨迹"——专门为后续的"技能提炼"设计。

### 2.2 追踪的粒度

Hermes 的 episodic memory 追踪粒度是"工具调用级"——记录每次工具调用的输入输出。这比"对话轮次级"（只记录每轮对话）更细——因为一个对话轮次可能包含多次工具调用（如"读文件→搜索→读文件→修改"）。

**为什么需要工具调用级粒度**：技能的本质是"工具调用序列"——如"PR 审查技能"是"读 diff→检查 CI→标记风格违规→发布评论"的工具调用序列。如果只记录对话轮次，无法提炼出"工具调用序列"——因为一个轮次内的多次工具调用被"压缩"了。工具调用级粒度让"技能提炼"有足够的细节来重建"执行流程"。

### 2.3 用户纠正的捕获

用户纠正是"技能提炼"的重要信号——当用户说"不对，应该这样做"时，意味着 Agent 的原始方法有问题，用户的方法更好。Hermes 捕获这种纠正——记录"Agent 原本想做什么"和"用户纠正后做了什么"——这种"错误→纠正"对是"Pitfalls 段"的素材——技能的 Pitfalls 段会记录"不要这样做，应该那样做"。

**纠正的隐式形式**：用户纠正不总是显式的"不对"——有时是隐式的——如 Agent 提议用方法 A，用户不直接否定而是说"其实用方法 B 更好"——这也是纠正。Hermes 的 episodic memory 追踪需要识别这种"隐式纠正"——这依赖 LLM 的语义理解能力。强模型（如 Claude）更擅长识别隐式纠正；弱模型可能漏掉——导致"用户纠正了但 Agent 没意识到"——错过 Pitfalls 积累的机会。

### 2.4 episodic memory 的存储

episodic memory 的追踪数据存储在 SessionDB 中——与对话历史一起。这意味着 episodic memory 也是"跨会话"的——Agent 可以回顾"上周的任务执行轨迹"来提炼技能——不只限于"当前会话"。这种"跨会话 episodic memory"是"3+ 次成功"阈值的基础——Agent 需要回顾"过去多次相似任务"来判断是否达到阈值——如果 episodic memory 不跨会话，就无法做"跨会话的相似性判断"。

---

## 第 3 章 Distill 阶段——技能生成

### 3.1 skill_manage 工具的触发条件

Distill 阶段通过 `skill_manage` 工具实现——其 schema 定义了精确的触发条件：

```
SKILL_MANAGE_SCHEMA = {
    "name": "skill_manage",
    "description": (
        "Manage skills (create, update, delete). Skills are your procedural memory — "
        "reusable approaches for recurring task types. "
        "Create when: complex task succeeded (5+ calls), errors overcome, "
        "user-corrected approach worked, non-trivial workflow discovered, "
        "or user asks you to remember a procedure. "
        "Update when: instructions stale/wrong, OS-specific failures, "
        "missing steps or pitfalls found during use. "
        "If you used a skill and hit a failure, patch it immediately with "
        "skill_manage(action='patch') — don't wait."
    ),
    ...
}
```

**创建技能的五个触发条件**：
1. **复杂任务成功（5+ 工具调用）**——任务涉及 5 次以上工具调用且成功完成——说明这是一个"非平凡"工作流，值得记住
2. **错误被克服**——任务中遇到了错误但最终找到了解决方案——说明有"陷阱"值得记录
3. **用户纠正后的方法有效**——用户纠正了 Agent 的方向且纠正后的方法成功——说明"原始方法有问题，用户方法更好"
4. **发现非平凡工作流**——Agent 发现了一个"不显而易见"的工作流——如"需要先 A 再 B 才能做 C"
5. **用户要求记住某个程序**——用户明确说"记住这个流程"——最直接的触发

**"3+ 次成功"的阈值**：除了上述触发条件，学习闭环还有一个"3+ 次成功完成相似任务模式"的阈值——只有相似任务成功完成 3 次以上，才进入 Distill 阶段。这个阈值防止"偶然成功的错误流程"被固化为技能——如"某次部署成功是因为恰好网络没抖动，但流程其实有问题"——3 次成功降低了"偶然性"的影响。

### 3.2 SKILL.md 的生成过程

当触发条件满足时，Agent 进入 Distill 阶段——生成 SKILL.md 文档：

1. **回顾 episodic memory**——Agent 回顾刚才完成任务的工具调用序列、决策分支、用户纠正
2. **提炼程序步骤**——把工具调用序列抽象为"步骤"——如"读 diff→检查 CI→标记违规→发布评论"抽象为"1. 读取 PR diff 2. 检查 CI 状态 3. 标记风格违规 4. 发布审查评论"
3. **识别 Pitfalls**——从"错误→纠正"对中提取"陷阱"——如"不要跳过 CI 检查，即使 CI 看起来通过"
4. **定义验证方法**——如何确认技能执行成功——如"PR 评论已发布且无 CI 失败"
5. **写入 SKILL.md**——用 skill_manage 工具的 `action='create'` 把文档写入 `~/.hermes/skills/`

**生成质量**：SKILL.md 的生成质量取决于 LLM 的能力——强模型（如 Claude）能生成更精确、更完整的技能文档；弱模型可能生成"遗漏步骤"或"陷阱不完整"的文档。这也是为什么 Hermes 推荐"用强模型做技能提炼"——即使日常对话用便宜模型，技能提炼时可以临时切换到强模型。

### 3.3 /learn 命令——显式技能学习

除了"自动触发"的技能创建，Hermes 还提供 `/learn` 命令——用户可以"显式要求"Agent 学习某个程序：

```
# 从本地 SDK 文档学习
/learn the REST client in ~/projects/acme-sdk, focus on auth + pagination

# 从在线文档学习
/learn https://docs.example.com/api/quickstart

# 从刚才的对话学习
/learn how I just deployed the staging server

# 从描述的流程学习
/learn filing an expense: open the portal, New > Expense, attach receipt, submit
```

`/learn` 的优势是"用户主导"——用户决定"学什么"和"怎么学"——而不是依赖 Agent 的自动判断。这对于"用户知道是技能但 Agent 没意识到"的场景有用——如"我每次报销都要走一个特定流程，但 Agent 可能不认为这是'技能'"——用户可以用 `/learn` 显式教 Agent。

**/learn 的执行机制**：`/learn` 没有独立的"摄取引擎"——它构建一个"遵循标准的 prompt"并作为正常对话轮次交给 Agent。Agent 用它已有的工具（read_file/search_files/web_extract 等）收集素材，然后按照"技能编写标准"（≤60 字描述、标准段落顺序、Hermes 工具框架、不发明命令）生成 SKILL.md，最后用 skill_manage 工具保存。这种"用 Agent 自身能力学习"的设计意味着 `/learn` 在 CLI、Gateway、TUI 和 Dashboard 中的行为一致——且在任何终端后端（local/Docker/remote）上都能工作——因为没有"单独的摄取引擎"。

**Dashboard 中的 Learn a Skill 按钮**：在 Hermes Dashboard 的 Skills 页面，有一个"Learn a skill"按钮——打开一个面板，包含目录字段、URL 字段和开放式文本框——它组合一个 `/learn` 请求并在 chat 中运行。这让非技术用户也能通过图形界面"教 Agent 技能"——不需要记住 `/learn` 命令语法。

---

## 第 4 章 Reuse 阶段——渐进式披露

### 4.1 三级加载机制

技能生成后保存在 `~/.hermes/skills/`——立即可用为 slash 命令。但 Hermes 不会"一次性加载所有技能到系统提示"——那会消耗大量 token。相反，它使用"渐进式披露"（progressive disclosure）——三级加载：

| 级别 | 操作 | 内容 | Token 成本 |
| :--- | :--- | :--- | :--- |
| Level 0 | `skills_list()` | 所有技能的 name/description/category | ~3k tokens（全部技能） |
| Level 1 | `skill_view(name)` | 某个技能的完整内容 + 元数据 | 变化（单个技能） |
| Level 2 | `skill_view(name, path)` | 某个技能的特定参考文件 | 变化（单个文件） |

**工作流程**：Agent 首先调用 `skills_list()` 获取所有技能的"摘要"（Level 0，~3k tokens）——这个摘要让 Agent 知道"有哪些技能可用"。当 Agent 判断某个技能与当前任务相关时，调用 `skill_view(name)` 加载该技能的完整内容（Level 1）。如果技能有附加参考文件且需要查看，调用 `skill_view(name, path)` 加载特定文件（Level 2）。

### 4.2 为什么渐进式披露重要

假设用户有 100 个技能，每个技能平均 2000 tokens。如果"一次性加载所有技能"——系统提示会增加 200,000 tokens——这超过了大多数模型的上下文窗口。即使不超窗口，200k tokens 的输入成本也非常高。

渐进式披露让"无关技能"的 token 成本接近零——Level 0 只消耗 ~3k tokens（所有技能的摘要）——只有"相关技能"才加载完整内容。这种"按需加载"让"拥有大量技能"不会导致"token 爆炸"——支持技能库的无限增长。

### 4.3 技能作为 slash 命令

每个技能自动可用为 slash 命令——如 `/github-pr-workflow`、`/axolotl`、`/plan`。用户可以直接调用技能——不需要"自然语言描述任务然后等 Agent 发现相关技能"。这种"显式调用"比"隐式发现"更快——如用户知道要做 PR 审查，直接 `/github-pr-workflow` 比"请审查这个 PR"然后等 Agent 发现技能更快。

**技能堆叠**：用户可以在一条消息中堆叠多个技能——如 `/github-pr-workflow /test-driven-development fix issue #123 and open a PR`——最多堆叠 5 个技能。这让"组合工作流"成为可能——如"用 PR 工作流 + TDD 技能修复 issue 并开 PR"。

**解析规则**：技能堆叠的解析"在第一个不是技能的 token 处停止"——如 `/ocr-and-documents /tmp/scan.pdf extract the tables`——只加载一个技能（ocr-and-documents），`/tmp/scan.pdf` 是参数而非技能（因为它不是已安装的技能名）。这种"智能解析"避免了"以 / 开头的参数（如文件路径）被误认为技能"的问题。

### 4.4 技能的按平台启用/禁用

技能可以"按平台启用/禁用"——如"在 CLI 中启用所有技能，在 Telegram 中只启用安全技能"。这是通过 `hermes skills` 命令配置的——`hermes_cli/skills_config.py` 负责这个逻辑。按平台启用的场景如"在 Telegram 上不想让 Agent 执行代码相关技能"——因为手机上不方便审查代码操作——只启用"信息查询"类技能。这种"按平台控制"让"不同入口有不同的能力范围"——增强了安全性。

---

## 第 5 章 Refine 阶段——Pitfalls 自动追加

### 5.1 技能使用中的失败

当 Agent 使用某个技能执行任务时，可能遇到失败——如技能说"用命令 X 部署"，但实际执行时发现"命令 X 在新版系统中已废弃"。这种"技能与现实不符"的情况触发 Refine 阶段。

### 5.2 skill_manage patch 操作

Refine 阶段通过 `skill_manage` 的 `action='patch'` 操作实现——Agent 立即修补技能：

- **把失败路径加入 Pitfalls 段**——如"不要用命令 X，它在 v2.0 后已废弃"
- **把成功路径加入 Procedure 段**——如"改用命令 Y"
- **更新验证方法**——如果验证方法也变了

**"立即修补"的重要性**：skill_manage 的 description 强调"If you used a skill and hit a failure, patch it immediately — don't wait."——"立即修补"而非"等下次"。这是因为"如果不立即修补，下次使用时还会遇到同样的失败"——立即修补让"同一个陷阱不会被踩两次"。

**patch vs update 的区别**：skill_manage 有两种修改操作——`action='patch'` 和 `action='update'`。patch 是"局部修补"——只修改失败相关的部分（如追加一个 Pitfall 或修改一个步骤）——保留技能的其他部分不变。update 是"全面更新"——重写整个技能——适用于"技能整体过时"的情况。patch 的"局部性"让它更安全——不会"因为修一个坑而破坏其他正确的部分"——而 update 的"全面性"让它适用于"大范围变更"——但风险更高（可能引入新问题）。Agent 通常优先用 patch——只在"技能整体结构有问题"时才用 update。

### 5.3 Pitfalls 段不是预写的

Pitfalls 段在技能创建时通常是空的或只有少量已知陷阱——大部分 Pitfalls 是在"使用中"自动追加的。这种"Pitfalls 生长"机制是 Hermes "自改进"的核心体现——技能不是"一次性写好"的静态文档——而是在使用中"越来越完善"的动态文档——每次失败都让技能更精确。

> [!note] Refine 阶段与"人类学习"的类比
> Refine 阶段类似于人类的"从错误中学习"——你第一次做某事时可能踩坑，但记住后下次就不会再踩。Hermes 的技能 Pitfalls 段就是这个"记住坑"的机制——技能在使用中"积累经验"——失败路径被剪枝，成功路径被强化。社区报告显示，基于类似自批判循环的原型在 8 次运行后错误率下降 30%——这虽然不是受控实验，但提供了"Refine 阶段确实有效"的初步证据。

---

## 第 6 章 Nudge Engine——学习闭环的驱动器

### 6.1 什么是 Nudge Engine

学习闭环的"驱动器"是 Nudge Engine——一个定期提醒 Agent "反思并持久化知识"的机制。Nudge 不是"每 N 分钟触发一次"的简单定时器——而是"在对话的自然间隙"插入反思提示。

### 6.2 Nudge 的典型形式

Nudge 的典型形式是"温和提醒"——如：
- "你刚才完成了一个复杂任务（5+ 工具调用），要不要把流程保存为技能？"
- "我注意到你纠正了我的方法——你纠正后的方法更好，要不要我记住它？"
- "这个工作流似乎不显而易见——要不要保存为技能供下次使用？"

**"温和提醒"而非"强制执行"**：Nudge 是"建议性"的——用户可以说"不用保存"，Agent 尊重决定。这种"用户保持控制"的设计很重要——如果 Agent "强制"把每个任务都固化为技能，会产生大量低价值技能——如"查天气"这种简单任务不需要技能。用户拒绝 Nudge 也是一个信号——"这个任务不值得记住"。

### 6.3 Nudge 的时机

Nudge 在"对话自然间隙"触发——如：
- 任务完成后（用户说"谢谢"或"好了"）
- 用户纠正后（用户说"不对，应该..."）
- 长时间对话的中间点（每 N 轮对话后）

**不在"任务执行中"触发**：Nudge 不会在"Agent 正在执行工具调用"时打断——这会干扰任务执行。Nudge 只在"任务完成"或"对话间隙"触发——确保不打断"心流"。

**Nudge 与"写审批门"的交互**：如果用户启用了"写审批门"（write-approval gate），那么 skill_manage 的创建/更新/删除操作需要用户确认——Nudge 提醒后，即使用户同意保存技能，实际写入 `~/.hermes/skills/` 时还需要通过审批门。这种"双重确认"（Nudge 同意 + 审批门确认）确保用户对"技能库的变更"有完全控制——防止 Agent "偷偷"创建或修改技能。第 12 篇会深入安全模型和审批门。

---

## 第 7 章 学习闭环的局限性与改进方向

### 7.1 局限一：技能质量依赖 LLM 能力

SKILL.md 的生成质量取决于 LLM 的能力——弱模型可能生成"遗漏步骤"或"陷阱不完整"的技能。这是"程序性记忆积累"路径的固有局限——因为"提炼"本身是 LLM 做的——LLM 的能力上限决定了技能质量上限。

**缓解方案**：如第 3.2 节提到的，可以"在技能提炼时临时切换到强模型"——即使日常对话用便宜模型，提炼时用 Claude/GPT-4o——这种"分层模型使用"平衡了成本和质量。

### 7.2 局限二："相似任务"判断的主观性

"3+ 次成功完成相似任务模式"中的"相似"是主观的——什么算"相似"？如"审查 PR"和"审查 PR 并修复 bug"算相似吗？这依赖 LLM 的判断——可能"过于宽松"（把不相似的任务当相似）或"过于严格"（相似的任务不识别）。

**缓解方案**：用户可以通过 `/learn` 显式触发技能创建——绕过"相似性判断"——对于"用户知道是技能但 Agent 没意识到"的场景，显式触发比依赖自动判断更可靠。

### 7.3 局限三：技能可能"过时"

技能是基于"过去经验"生成的——但环境可能变化——如"部署技能"基于"K8s v1.28"生成，但集群升级到 v1.30 后某些命令变了。过时的技能可能导致失败——直到 Refine 阶段修补。

**缓解方案**：Refine 阶段的"立即修补"机制是主要缓解——技能在使用中"跟上变化"。但对于"长期不用的技能"——如"半年没用过的部署技能"——可能已经过时但没被修补——因为"不用就不会触发 Refine"。用户可以定期"审查技能库"——手动检查过时技能。

### 7.4 改进方向：主动技能验证

一个可能的改进方向是"主动技能验证"——Agent 定期"测试"技能是否仍然有效——如"部署技能"可以定期在测试环境跑一遍验证流程是否正确。这种"主动验证"比"被动等待失败"更可靠——但成本更高（需要定期执行技能）。这个方向目前 Hermes 还没有实现——是未来可能的增强。

### 7.5 局限四：技能的"过度专化"风险

技能是从"特定用户的具体任务"中提炼的——可能"过度专化"于该用户的环境和习惯。如"部署技能"可能基于"用户的特定 K8s 集群配置"——把集群特定信息（如 namespace 名、镜像仓库地址）固化到技能中——导致技能"不可移植"到其他环境。虽然 agentskills.io 标准让技能"可以"跨 Agent 共享，但"过度专化"的技能共享价值低——其他用户的环境不同，技能可能不适用。缓解方案是在技能提炼时"抽象化环境特定信息"——如用"你的 namespace"而非"my-prod-namespace"——但这依赖 LLM 的抽象能力，并非总能做到完美。理解这些局限性对于有效使用学习闭环至关重要，需要在实践中不断摸索平衡点与取舍。

---

## 第 8 章 总结与下一篇导读

### 8.1 本文核心要点

1. **两种自改进路径**——模型权重更新（高代价、高风险）vs 程序性记忆积累（低代价、低风险）——Hermes 选择后者
2. **Observe 阶段**——episodic memory 追踪工具调用级粒度的执行轨迹，捕获用户纠正
3. **Distill 阶段**——skill_manage 的五个触发条件（5+调用/错误克服/用户纠正/非平凡工作流/用户要求）+ 3+ 次成功阈值——生成 SKILL.md
4. **Reuse 阶段**——渐进式披露三级加载（Level 0 摘要 ~3k tokens / Level 1 完整内容 / Level 2 特定文件）——支持技能库无限增长
5. **Refine 阶段**——skill_manage patch 立即修补失败——Pitfalls 段在使用中自动追加——"同一个陷阱不会被踩两次"
6. **Nudge Engine**——在对话自然间隙温和提醒反思——用户保持控制——可拒绝
7. **/learn 命令**——显式技能学习——用户主导——绕过自动判断
8. **局限性**——技能质量依赖 LLM 能力、"相似任务"判断主观、技能可能过时——缓解方案包括分层模型使用、显式触发、定期审查

### 8.2 下一篇导读

下一篇 [[05 技能系统——SKILL.md 与 agentskills.io 标准]] 将深入技能系统的"文档层面"——SKILL.md 的标准格式（front-matter + When to Use + Procedure + Pitfalls + Verification）、agentskills.io 开放标准（让 Hermes 技能可被 Claude Code/Cursor/OpenHands 等其他 Agent 使用）、Skills Hub（88k+ 技能的集中市场）、技能的平台特定性（macOS/Linux/Windows）、技能的媒体投递（`[[as_document]]` 指令）等。

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Hermes Agent 专栏]] 的第 4 篇，"核心架构"部分的第 2 篇。

---

## 参考文献

1. Hermes Agent Skills System 文档. https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
2. Learning Loop 介绍. https://hermes-agent.ai/features/learning-loop
3. How Hermes Agent Achieves Self-Improving AI. https://www.besthub.dev/articles/how-hermes-agent-achieves-self-improving-ai-through-memory-skills-and-nudge-engine-39749dd09a61
4. Hermes Agent Architecture Deep Dive. https://zooclaw.ai/help/en/2026-04-23/hermes-agent-architecture-learning-loop-deep-dive/
5. Hermes Agent GitHub. https://github.com/NousResearch/hermes-agent

---

## 思考题

1. **Hermes 的"3+ 次成功"阈值防止"偶然成功的错误流程"被固化为技能。但这个阈值是否会让"真正有价值的技能"创建太慢？如"部署 K8s 集群"这种低频但高价值的任务，可能几个月才做 3 次——要等几个月才能创建技能。如何平衡"防止偶然性"和"及时创建"？** 提示：考虑"动态阈值"——简单任务（1-2 次工具调用）可能 1 次就够了，复杂任务（10+ 工具调用）可能需要更多次验证。或者"用户显式触发"——对于低频高价值任务，用户可以用 `/learn` 显式触发，绕过 3 次阈值。

2. **Nudge Engine 的"温和提醒"让用户保持控制——可以拒绝。但如果用户总是拒绝（因为"懒得保存"），学习闭环就失效了。如何设计"激励机制"让用户更愿意接受 Nudge？** 提示：考虑"展示价值"——Nudge 可以附带"如果你保存这个技能，下次类似任务可以节省 X 分钟"的估算——让用户看到"保存的即时价值"。或者"延迟保存"——用户可以"先不保存，但如果下次遇到相似任务，再提醒"——降低"保存的决策成本"。

3. **技能的 Pitfalls 段在使用中自动追加——这让技能"越来越完善"。但也可能让 Pitfalls 段"无限增长"——如一个技能用了 100 次，每次都追加一个 Pitfall——Pitfalls 段可能有 100 条，加载时消耗大量 token。如何防止 Pitfalls 段"膨胀"？** 提示：考虑"Pitfalls 合并"——定期用 LLM 审查 Pitfalls 段，合并相似陷阱——如"命令 X 废弃"和"命令 Y 废弃"可以合并为"注意命令版本兼容性"。或者"Pitfalls 分级"——只保留"高频陷阱"，低频陷阱移到参考文件（Level 2）——需要时才加载。
