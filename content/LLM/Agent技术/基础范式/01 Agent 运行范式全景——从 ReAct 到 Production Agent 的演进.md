---
title: "Agent 运行范式全景——从 ReAct 到 Production Agent 的演进"
date: 2026-08-01
tags: [A2A, Agent, AutoGPT, Claude Agent SDK, CrewAI, Deep Research, Gemini ADK, LangGraph, LATS, LLMCompiler, MCP, OpenAI Agents SDK, Plan-and-Execute, ReAct, Reflexion, Tree of Thoughts, Workflow, 范式演进]
aliases: [Agent 运行范式全景, ReAct 到 Production Agent, Agent 范式演进]
---

# 01 Agent 运行范式全景——从 ReAct 到 Production Agent 的演进

> [!abstract] 摘要
> 本文是"Agent 技术"专栏的第 1 篇，任务是在读者脑中建立一张关于 AI Agent 运行范式的完整全景地图。文章先厘清 Agent 与 Chatbot 的本质区别——为什么 LLM 单独不是 Agent、满足哪四个条件才称得上 Agent、Anthropic 提出的 Workflow 与 Agent 分界线画在哪里；然后以 ReAct（Reasoning + Acting）为锚点，梳理 2022 到 2024 年的范式演进脉络：ReAct → Reflexion → Tree of Thoughts → ReWOO/Plan-and-Execute → LATS → LLMCompiler，逐一拆解每种范式解决了前代的什么痛点、又引入了什么新代价；在范式到产品的过渡带上，LangGraph、CrewAI、AutoGPT Platform 分别代表"图执行""角色协作""可视化编排"三条产品化路线，共同回答了"范式如何变成产品"；接着把镜头拉到 2025-2026 年的生产格局，看 OpenAI 的 Responses API 与 Agents SDK、Anthropic 的 Claude Agent SDK、Google 的 Gemini ADK 如何展开平台化竞赛，MCP 与 A2A 如何分层各管一段，Deep Research 如何把推理范式产品化；最后落到生产 Agent 的三大落地支柱——编排、审批与可观测，并给出 Coding Agent 的范式选择决策树，从任务可预测性、行动可逆性、评估器可用性等维度逐层追问。核心认知：没有"最好的"Agent 范式，只有"最合适的"——任务的可分解性、对延迟的容忍度、token 成本约束，共同决定了你应该选用哪种范式。

---

## 第 1 章 什么是 Agent——从 Chatbot 到自主系统的跨越

### 1.1 LLM 单独不是 Agent

先从一个略显冒犯的问题开始：ChatGPT 每天都在回答无数人的问题，为什么没有人认真把它叫做 Agent？答案藏在"回答"与"做事"的差别里。一个大型语言模型（LLM）本身，是一个"接收文本输入、产生文本输出"的函数。它没有记忆（每次调用独立）、没有行动能力（不能读写文件、不能执行命令、不能访问网络）、没有目标（不会主动决定下一步做什么）。把 GPT-4 或 Claude 放在一个聊天界面里，你得到的是一个 Chatbot——它能回答问题、生成文本，但它不会"做事"。一台没有键盘、没有屏幕、没有网线的主机，CPU 再强也无法独自完成任何一件面向现实世界的任务，LLM 单独存在时就是这么一台"裸机"。

这个区分看似简单，但在 2023 年 AutoGPT 引爆全网时被大量混淆。很多人以为"让 GPT-4 自己跟自己对话循环"就是 Agent 了，结果发现生成的"自主任务"要么陷入空洞的自我对话，要么在第三四步就完全跑偏。问题的根源在于：**Agent 的核心不是"循环调用 LLM"，而是"LLM + 工具 + 循环 + 状态管理的有机组合"**。

### 1.2 Agent 的四个必要条件

要让一个 LLM 变成一个真正的 Agent，至少需要满足四个条件：

**条件一：推理能力（Reasoning）**。Agent 必须能够"思考"——分析当前状态、规划下一步行动、处理异常。这是 LLM 本身就具备的能力，通过 Chain-of-Thought（CoT）等提示技术可以激发出来。但单纯的推理不构成 Agent——一个只在脑子里想方案但不付诸行动的系统，最多是个顾问，不是执行者。

**条件二：行动能力（Acting）**。Agent 必须能够"做事"——调用外部工具、读写文件、执行命令、发起网络请求。这通过 Tool Use / Function Calling 实现，让 LLM 的输出不仅仅是文本，还可以是结构化的"行动指令"，由外部执行器（runtime）代为执行后将结果反馈给 LLM。

**条件三：循环控制（Loop）**。Agent 必须能够"持续运转"——不是一次性问答，而是在一个循环中不断"推理→行动→观察→再推理"，直到任务完成或主动终止。这个循环是 Agent 区别于单次 LLM 调用的本质特征。

**条件四：状态管理（State）**。Agent 必须能够"记住"——维护跨步骤的上下文状态，包括已完成的工作、待办的事项、中间结果、环境反馈。没有状态管理，Agent 每一步都从零开始，无法完成任何需要多步协作的复杂任务。

请注意，这四个条件不是并列的四块拼图，而是两层结构：推理与行动是 Agent 的**能力底座**，循环与状态是让能力得以持续运转的**骨架**。能力底座决定 Agent 能做什么，骨架决定它能做多久、做多稳。笔者的经验是，团队里最容易忽视的是状态管理——推理可以靠更好的模型补足，行动可以靠更多工具扩展，但状态一旦缺失，多步任务就会退化成一次次孤立的问答，前一步的结果在后一步里毫无踪影，这正是许多 Demo 级 Agent 在生产中露馅的根源。

### 1.3 Anthropic 的定义：Workflow vs Agent

Anthropic 在 2024 年 12 月发布的"Building Effective Agents"一文中，给出了一个在工业界被广泛引用的架构区分：

> [!info] 核心概念：Workflow vs Agent
> **Workflows** are systems where LLMs and tools are orchestrated through predefined code paths.
> **Agents**, on the other hand, are systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks.

这个区分的核心在于**控制流的归属**：在 Workflow 中，控制流由开发者预定义的代码路径决定——第几步调用哪个 LLM、第几步做什么检查、第几步合并结果，都是写死在代码里的；在 Agent 中，控制流由 LLM 自己决定——LLM 根据当前状态动态判断下一步做什么、调用什么工具、何时停止。

这个区分在工程实践中极其重要。Anthropic 在文中明确指出："最成功的实现不是使用复杂框架或专门库，而是使用简单、可组合的模式"。过度追求"完全自主的 Agent"往往导致不可控、不可调试、成本失控的系统；而在任务可预测的场景下，用 Workflow（预定义路径）反而更可靠、更经济。

> [!warning] 生产避坑：不要一上来就追求"完全自主 Agent"
> 很多团队在构建 Agent 系统时犯的第一个错误是：任务其实可以用一个简单的 Prompt Chaining Workflow 解决，却非要做成"LLM 自主决策下一步"的 Agent。结果是延迟翻倍、token 成本翻倍、调试困难，而任务完成质量并没有提升。正确做法是：从最简单的方案开始（甚至不要构建 Agent 系统），只在确实需要 LLM 动态决策时才引入 Agent 模式。

### 1.4 Agent 的五个层级

根据上述条件满足的程度，可以将"agentic 系统"分为五个层级，复杂度递增：

| 层级 | 名称 | 推理 | 行动 | 循环 | 状态 | 典型代表 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| L0 | 单次 LLM 调用 | ✓ | ✗ | ✗ | ✗ | ChatGPT 问答 |
| L1 | LLM + 检索（RAG） | ✓ | ✓（检索） | ✗ | ✗ | 带知识库的问答 |
| L2 | Prompt Chaining | ✓ | ✓ | 固定路径 | 有限 | 多步文本处理流水线 |
| L3 | Workflow（预定义编排） | ✓ | ✓ | 条件分支 | 有 | Anthropic 的五种 Workflow 模式 |
| L4 | Agent（自主循环） | ✓ | ✓ | LLM 动态控制 | 有 | ReAct、Claude Code、Devin |

本专栏关注的"Coding/Terminal Agent"主要处于 L4 层级——LLM 自主决定读写哪些文件、执行哪些命令、何时提交代码。但实际生产系统往往是 L3 和 L4 的混合：在可预测的步骤上用 Workflow 保证可靠性，在需要动态决策的步骤上用 Agent 保证灵活性。

这张层级表还有第二个用处：校准预期。2025 年前后市场上的"Agent 产品"名目繁多，但用这张表一量，相当一部分只是把 RAG 问答（L1）或 Prompt Chaining（L2）重新包装了一遍。判断一个系统是不是真正的 Agent，不看宣传话术，只看它的控制流是否由 LLM 动态决定、状态是否跨步骤持续——这两条是 L4 的硬门槛。层级也不是越高越好，复杂度本身就是代价，把本该停留在 L2 的任务硬抬到 L4，得到的不是更强的能力，而是更贵的账单和更难排查的故障。

---

## 第 2 章 ReAct——一切范式的起点

### 2.1 ReAct 解决了什么问题

在 ReAct 出现之前，LLM 的"推理"和"行动"是分离的。Chain-of-Thought（CoT） prompting 让 LLM 展示推理过程来提升答案质量，但这种推理是"闭门造车"——LLM 只能基于自己预训练时学到的知识推理，无法在推理过程中获取新的外部信息。另一方面，早期的工具增强 LLM（如 WebGPT）可以让 LLM 调用外部工具，但调用逻辑是粗粒度的——先调工具拿数据，再基于数据生成回答，缺乏"推理过程中发现信息不足时主动调工具补充"的能力。

ReAct（Reasoning + Acting）的核心洞察是：**推理和行动应该交织进行，而不是分离执行**。LLM 在推理过程中可以随时"暂停"，调用外部工具获取信息（行动），拿到结果后继续推理。这种交织让 LLM 能够：

- **在推理中发现信息缺口时主动补充**：而不是一开始就猜测所有信息
- **根据外部反馈调整推理方向**：而不是固执地按预设路径走
- **生成人类可理解的任务解决轨迹**：每一步都有"为什么这么做"的推理记录

### 2.2 ReAct 的循环结构

ReAct 的运行循环可以概括为四个不断重复的步骤。这个循环的朴素程度常让人低估它，但它运作起来其实与人类烹饪时"尝一口、再放盐"的做法如出一辙——推理给出判断，行动动手，观察纠正判断，如此往复直到出锅：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph LR
    T["Thought<br/>推理：分析当前状态<br/>决定下一步"] --> A["Action<br/>行动：调用外部工具"]
    A --> O["Observation<br/>观察：获取工具返回结果"]
    O --> T
    T --> F["Final Answer<br/>推理判定任务完成<br/>输出最终答案"]

    classDef thought fill:#50fa7b,stroke:#50fa7b,color:#282a36
    classDef action fill:#ff79c6,stroke:#ff79c6,color:#282a36
    classDef obs fill:#ffb86c,stroke:#ffb86c,color:#282a36
    classDef final fill:#6272a4,stroke:#bd93f9,color:#f8f8f2

    class T thought
    class A action
    class O obs
    class F final
```

**Thought（推理）**：LLM 用自然语言"自言自语"，分析当前已有什么信息、还缺什么、下一步应该做什么。这是 ReAct 区别于纯工具调用的关键——每一步行动前都有明确的推理过程。

**Action（行动）**：LLM 输出一个结构化的行动指令，指定要调用哪个工具、传什么参数。行动指令由外部执行器（runtime）解析并执行。

**Observation（观察）**：执行器将工具执行的结果反馈给 LLM，成为下一轮推理的输入。

**Final Answer（最终答案）**：当 LLM 在 Thought 阶段判定任务已完成时，不再输出 Action 而是输出最终答案，循环终止。

### 2.3 ReAct 的 Prompt 模板

ReAct 原始论文使用的 few-shot prompt 模板大致如下：

```
Question: [任务描述]
Thought 1: [推理第一步——分析任务，决定第一个行动]
Action 1: [工具调用，如 Search("xxx")]
Observation 1: [工具返回结果]
Thought 2: [基于观察结果继续推理]
Action 2: [下一个工具调用]
Observation 2: [工具返回结果]
...
Thought N: [推理判定任务完成]
Action N: Finish([最终答案])
```

这个模板通过 few-shot examples 让 LLM 学会"Thought-Action-Observation"的交替格式。值得注意的是，ReAct 论文发表时（2022 年 10 月），OpenAI 的 Function Calling 还不存在——LLM 的"Action"是通过让 LLM 生成特定格式的文本（如 `Search["query"]`）来实现的，由外部代码解析这个文本并执行对应工具。这种"用文本格式编码结构化行动"的方式，在 Function Calling 出现后被更可靠的 JSON Schema 方式取代，但 ReAct 的"Thought-Action-Observation 交替循环"这一核心思想至今未变。

### 2.4 ReAct 的实验结果

ReAct 论文在四个任务上验证了范式有效性：

| 任务 | 评价指标 | ReAct | CoT（纯推理） | 提升 |
| :--- | :--- | :---: | :---: | :--- |
| HotpotQA（多跳问答） | Exact Match | 35% | 34% | +1%（但减少幻觉） |
| Fever（事实验证） | Accuracy | 64% | 56% | +8% |
| ALFWorld（交互决策） | Success Rate | 71% | N/A（不能行动） | +34%（vs 模仿学习） |
| WebShop（网页购物） | Score | 57% | N/A | +10%（vs 强化学习） |

在 HotpotQA 上 ReAct 相比 CoT 提升不大，但关键价值在于**减少了幻觉**——通过调用 Wikipedia API 获取真实信息，ReAct 不会像 CoT 那样编造事实。在 ALFWorld 和 WebShop 这两个需要与环境交互的决策任务上，ReAct 的优势更为显著，因为它能真正"行动"（操作环境）而不只是"推理"。

> [!note] 设计哲学：ReAct 的真正贡献不是"循环"
> 很多人把 ReAct 简单理解为"让 LLM 在循环里调工具"，但这错过了一个更重要的贡献：**推理过程的显式化**。在 ReAct 之前，LLM 调工具的行为是"黑箱"的——你不知道它为什么选择调这个工具、为什么传这些参数。ReAct 通过强制每一步行动前都有 Thought 推理记录，让 Agent 的决策过程变得可审计、可调试。这种"可解释性"在生产环境中极其重要——当 Agent 做了错误决策时，你可以回溯它的 Thought 链找到出错的那一步。

### 2.5 ReAct 的代价与当下定位

ReAct 并非万能：每一步推理都要把历史轨迹重新塞进 prompt，token 消耗随步数近似平方增长；它走一步看一步，缺乏前瞻规划；它没有跨试验的记忆，失败后不会自动总结经验。这三个短板分别催生了第 3 章要讲的 Plan-and-Execute、Tree of Thoughts 与 Reflexion，也是后文那张演进表里所有改进的起点。

不过站在 2025 年回头看，ReAct 的定位反而比论文发表时更清晰了。一方面，o1、o3、DeepSeek-R1 这类推理模型把"多路径探索"内化成了隐式的长思维链，ToT 那种外挂搜索树的价值被大幅摊薄；另一方面，推理模型与 ReAct 循环是正交的——前者提升单步"想"的质量，后者解决"想-做-看"的闭环，二者组合依然是当下 Coding Agent 与通用 Agent 最主流的生产形态。ReAct 没有过时，它只是从"唯一范式"回归到了"基础范式"，这个定位恰恰是我们把这套演进脉络讲下去的前提。

---

## 第 3 章 ReAct 的演进——五种范式如何各自解决 ReAct 的痛点

ReAct 是所有后续 Agent 范式的共同祖先，但它并不完美。2023-2024 年间，研究者从不同角度针对 ReAct 的局限性提出了改进方案，形成了 Agent 范式的演进树。

### 3.1 ReAct 的三大痛点

**痛点一：缺乏自反思——失败后不会总结教训**。ReAct 在每次任务中独立运行，如果这次失败了，下次面对类似任务时不会利用上次的失败经验。这就像一个不会从错误中学习的学生——每次考试都从零开始。

**痛点二：缺乏前瞻规划——每步只看眼前**。ReAct 是"走一步看一步"的范式，每一步的决策只基于当前状态，不做长远规划。对于需要多步协调的复杂任务（如"先部署再测试再回滚"），这种短视行为容易导致走到死胡同。

**痛点三：token 消耗随步数平方增长**。ReAct 的每一轮推理都需要把之前所有轮次的 Thought-Action-Observation 重新放入 prompt。一个 8 步任务，第 8 步的 prompt 包含了前 7 步的全部记录。这意味着 token 消耗大约是 O(n²) 的增长——步数翻倍，token 消耗接近四倍。这在生产环境中是一个严重的成本问题。

### 3.2 Reflexion——给 ReAct 加上自反思记忆

Reflexion（Shinn et al., NeurIPS 2023）针对痛点一，在 ReAct 基础上增加了一个**自反思循环**。

核心思想：Agent 执行完一轮 ReAct 任务后，如果失败了，让 LLM 用自然语言"反思"失败原因——"我在第三步选择了错误的搜索关键词，导致后续找不到正确信息"——然后将这段反思文本存入**情景记忆缓冲区（episodic memory buffer）**。下一轮尝试类似任务时，把之前的反思作为额外上下文注入 prompt，让 Agent 避免重复犯错。

关键特征：
- **不更新模型权重**：Reflexion 的"学习"是通过语言反馈实现的，不需要梯度更新，不需要训练数据，只需要 LLM 自己生成反思文本
- **跨试验的记忆持久性**：反思记忆在多次试验间持久存在，实现了一种"轻量级的强化学习"
- **HumanEval 91% pass@1**：相比 GPT-4 基线的 80%，提升了 11 个百分点

> [!info] 核心概念：语言反馈即强化学习
> Reflexion 的论文标题是"Language Agents with Verbal Reinforcement Learning"——用语言反馈做强化学习。传统 RL 通过梯度更新策略网络来学习，Reflexion 通过在 prompt 中添加反思文本来学习。两种方式的共同点是"从失败中改进"，但 Reflexion 的代价极低——不需要训练、不需要 GPU、不需要标注数据，只需要一次额外的 LLM 调用来生成反思。代价是：反思质量依赖 LLM 自身的分析能力，如果 LLM 无法准确诊断失败原因，反思可能无效甚至误导。

**Reflexion 的局限**：依赖可靠的评估器来判断"是否失败"。在某些任务中（如开放式创意任务），很难自动判断成功/失败，导致反思循环无法触发。此外，反思记忆 buffer 的大小有限，过多的反思可能引入噪音。

### 3.3 Tree of Thoughts——给 ReAct 加上搜索树

Tree of Thoughts（ToT，Yao et al., NeurIPS 2023）针对痛点二，将 ReAct 的线性推理路径扩展为**树状搜索**。

核心思想：在每一步推理时，不只生成一个 Thought，而是生成 k 个候选 Thought（分支），然后用一个评估函数给每个候选打分，选择最优的继续扩展。如果走到死胡同，可以回溯到上一个分叉点尝试其他路径。这本质上是将经典搜索算法（DFS/BFS）引入 LLM 推理过程。

在 Game of 24（用四个数字通过加减乘除得到 24）任务上，ToT 达到了 74% 的成功率，而 CoT 只有 4%——70 个百分点的提升极其惊人。但代价同样惊人：ToT 的 token 消耗是 CoT 的 10-100 倍，因为它需要为每一步生成多个候选并逐一评估。

> [!warning] 生产避坑：ToT 在现代推理模型下基本过时
> ToT 论文发表时（2023 年 5 月），GPT-4 还没有专门的推理模式。2024-2025 年随着 OpenAI o1/o3、DeepSeek-R1 等推理模型（reasoning model）的出现，LLM 已经能在内部隐式地做"搜索"——通过更长的隐式 CoT 来探索多条路径，而不需要外部显式的树搜索框架。ToT 的核心价值（让 LLM 做搜索）被推理模型的内置能力部分取代了。在 2025 年的生产环境中，直接用推理模型 + ReAct 往往比 ToT 更经济、更简单。但 ToT 的思想（多路径探索 + 评估 + 回溯）对理解 Agent 范式的演进仍有重要价值。

### 3.4 ReWOO / Plan-and-Execute——给 ReAct 加上前置规划

ReWOO（Reasoning WithOut Observation，Xu et al., 2023）针对痛点三，提出了一个激进的改进：**把推理和观察彻底解耦**。

核心思想：ReAct 的每一轮推理都需要看到前一轮的 Observation，这是 token 平方增长的根源。ReWOO 的方案是——在任务开始时，LLM 一次性生成一个**完整的执行计划**（Plan），计划中用占位符引用前序步骤的结果（如 `#E1`、`#E2`），然后按计划依次执行工具调用，用实际结果替换占位符，最后由 LLM 汇总所有结果生成最终答案。

三个阶段：
1. **Planner**：LLM 一次性生成完整计划，包含所有工具调用和占位符
2. **Worker**：按计划依次执行工具调用，用实际结果替换占位符
3. **Solver**：LLM 读取完整的执行轨迹，生成最终答案

关键优势：Planner 生成计划时不需要看到任何 Observation，因此 prompt 中不需要包含历史 Observation，token 消耗大幅降低。ReWOO 论文报告在 HotpotQA 上实现了 **5 倍的 token 效率提升和 4% 的准确率提升**。

ReWOO 是 Plan-and-Execute 范式的典型代表。Anthropic 在"Building Effective Agents"中提到的 Orchestrator-Workers 模式，本质上也是一种 Plan-and-Execute：Orchestrator（规划器）分析任务并决定需要哪些子任务，Workers（执行器）各自执行分配的子任务。

> [!info] 核心概念：ReWOO 的占位符机制
> ReWOO 的精妙之处在于占位符。计划可能长这样：
> ```
> Plan:
> #E1 = Search("Paris population")
> #E2 = Search("Tokyo population")
> #E3 = Compare(#E1, #E2)
> ```
> Planner 生成这个计划时不需要知道 Paris 和 Tokyo 的实际人口数字——它只需要知道"先查巴黎、再查东京、然后比较"。Worker 执行时，`#E1` 被替换为"2.1M"，`#E2` 被替换为"13.9M"。Solver 读取替换后的完整轨迹，得出"东京人口大于巴黎"的最终答案。这种"先规划数据流、再填充数据"的思路，与经典编译器中"先生成 IR 再绑定地址"的设计一脉相承。

**Plan-and-Execute 的局限**：计划在任务开始时一次性生成，执行期间如果环境发生变化（如某个工具返回意外结果），原计划可能失效。ReAct 的优势恰恰在这里——它每一步都能根据最新的 Observation 调整方向。Plan-and-Execute 适合"任务结构可预测"的场景，不适合"执行过程中需要频繁调整方向"的场景。

### 3.5 LATS——统一推理、行动与规划

LATS（Language Agent Tree Search，Zhou et al., ICML 2024）是 ReAct 演进谱系中最"重量级"的范式，它将 ReAct（推理+行动）、Reflexion（自反思）和 ToT（树搜索）三种能力统一在一个框架中。

核心思想：将蒙特卡洛树搜索（MCTS）引入 Agent 的决策过程。Agent 不再走一条线性路径，而是在一棵搜索树上探索——每个节点是一次 ReAct 步骤，LLM 充当价值函数评估节点质量，用自反思指导探索方向，通过 MCTS 的选择-扩展-评估-回溯四步循环找到最优行动路径。

LATS 在 HumanEval 上用 GPT-4 达到了 **92.7% pass@1**（论文项目页甚至报告了 94.4%），在 WebShop 上用 GPT-3.5 达到了 75.9 分（媲美梯度微调方法）。这些数字在当时都是 SOTA。

但 LATS 的复杂度也是所有范式中最高的——它需要多次 LLM 调用来扩展节点、评估价值、生成反思，一个任务的 LLM 调用次数可能是 ReAct 的 10 倍以上。

> [!note] 设计哲学：LATS 在学术界与工业界的割裂
> LATS 在学术论文中表现优异，但在 2025 年的生产环境中几乎无人使用。原因很简单：LATS 的计算成本和延迟对生产系统来说不可接受。一个 Coding Agent 修改代码，用 ReAct 可能需要 5 次 LLM 调用，用 LATS 可能需要 50 次——用户不会为了"理论上更好的代码"等 10 倍的时间。LATS 的价值在于证明了"推理+行动+规划"的统一框架可以显著提升 Agent 性能，为未来的高效近似算法提供了上限参考。但作为工程方案，它更适合"离线任务质量优化"而非"在线实时交互"。

### 3.6 LLMCompiler——给 ReAct 加上并行执行

LLMCompiler（Kim et al., ICML 2024）从另一个角度解决 ReAct 的效率问题：不是减少推理次数，而是**让多个工具调用并行执行**。

核心思想：ReAct 的工具调用是严格串行的——调用工具 A，等结果，再调用工具 B。但如果工具 A 和 B 之间没有数据依赖，完全可以并行调用。LLMCompiler 借鉴经典编译器的思想，用三个组件实现并行：

1. **Function Calling Planner**：LLM 一次性生成一个 DAG（有向无环图）执行计划，图中的边表示数据依赖
2. **Task Fetching Unit**：调度器，按 DAG 拓扑序分发任务，无依赖的任务并行分发
3. **Executor**：并行执行多个工具调用

LLMCompiler 报告了相比 ReAct **3.7 倍的延迟加速、6.7 倍的成本节省和 9% 的准确率提升**。它本质上是 ReWOO/Plan-and-Execute 的"并行版"——不只是先规划再执行，还在执行阶段自动并行化无依赖的步骤。

### 3.7 范式演进全景对比

| 范式 | 提出时间 | 核心改进 | 解决的痛点 | 新引入的代价 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ReAct** | 2022.10 | 推理+行动交织 | LLM 无法在推理中获取外部信息 | token O(n²) 增长 | 动态实时任务 |
| **Reflexion** | 2023.03 | 自反思记忆 | 失败后不会总结教训 | 依赖可靠评估器 | 可重试任务 |
| **ToT** | 2023.05 | 树状搜索 | 缺乏前瞻规划 | 10-100x token | 组合搜索问题 |
| **ReWOO** | 2023.05 | 规划-执行解耦 | token 平方增长 | 计划不能动态调整 | 结构可预测任务 |
| **LATS** | 2024.07 | MCTS 统一框架 | 推理+行动+规划割裂 | 极高计算成本 | 离线质量优化 |
| **LLMCompiler** | 2024.07 | 并行函数调用 | 串行执行延迟高 | 需要识别依赖关系 | 多独立工具调用 |

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    R["ReAct<br/>2022.10<br/>推理+行动交织"] --> RF["Reflexion<br/>2023.03<br/>+自反思记忆"]
    R --> TT["Tree of Thoughts<br/>2023.05<br/>+树状搜索"]
    R --> RW["ReWOO<br/>2023.05<br/>+规划-执行解耦"]
    RF --> LATS["LATS<br/>2024.07<br/>MCTS统一框架"]
    TT --> LATS
    RW --> LC["LLMCompiler<br/>2024.07<br/>+并行执行"]

    classDef base fill:#50fa7b,stroke:#50fa7b,color:#282a36
    classDef improve fill:#ffb86c,stroke:#ffb86c,color:#282a36
    classDef unify fill:#ff79c6,stroke:#ff79c6,color:#282a36
    classDef parallel fill:#8be9fd,stroke:#8be9fd,color:#282a36

    class R base
    class RF,TT,RW improve
    class LATS unify
    class LC parallel
```

### 3.8 两条改良路线的分叉

把五种改进按着力点重新归队，可以看到两条清晰的路线。一条向内改良"推理的深度"：Reflexion 让 Agent 从失败中学习，ToT 让 Agent 同时考虑多条路径，LATS 则把这两者连同 MCTS 一起收编进一棵搜索树——它们付出的共同代价是更多的推理与更多的 token。另一条向外改良"执行的效率"：ReWOO 把规划与执行解耦以砍掉重复上下文，LLMCompiler 用 DAG 让无依赖的工具调用并行化——它们共同的代价，是把"走一步看一步的灵活性"让渡给了"事前计划"。

有意思的是，2025 年之后的生产格局明显向第二条路线倾斜：推理模型承接了第一条路线的大部分工作（把"多路径搜索"内化到模型内部），而框架与协议则接手了第二条路线的工程化（图执行、并行调度、状态持久化）。学术界的范式创新与工业界的产品形态，在这里完成了分工——这正好铺垫了第 5、6 章的主题。

---

## 第 4 章 Anthropic 的五种 Workflow 模式

在进入"生产框架如何选用范式"之前，需要先了解 Anthropic 在"Building Effective Agents"中提出的五种 Workflow 模式。这些模式不是"Agent 范式"（它们是预定义路径的 Workflow，不是 LLM 自主控制的 Agent），但它们是构建复杂 Agent 系统的基本积木——生产中的 Agent 往往是这些 Workflow 模式与 ReAct 循环的组合。这五种模式像是五件功能各异的厨刀，多数家常菜只需要其中一两件，只有做宴席时才需要全部上手。

### 4.1 Prompt Chaining——串行流水线

将任务分解为一系列步骤，每一步的 LLM 调用处理上一步的输出。可以在中间步骤加入程序化检查门控，确保流程仍在正轨。

**适用场景**：任务可以干净地分解为固定子任务。如"生成营销文案 → 翻译成另一种语言"、"写文档大纲 → 检查大纲 → 基于大纲写正文"。

**本质**：这是最简单的 Workflow，没有工具调用，没有循环，只有 LLM 的串行链式调用。它是 Plan-and-Execute 的退化形式——计划是固定的，不需要 LLM 动态规划。

### 4.2 Routing——分类分发

对输入进行分类，路由到专门的后续处理流程。

**适用场景**：任务有明确分类，不同类别适合不同处理方式。如"客服查询路由：一般问题/退款请求/技术支持 → 不同 prompt 和工具"、"简单问题路由到 Haiku，复杂问题路由到 Sonnet"。

**本质**：这是 if-else 分支的 LLM 版——用一个 LLM 调用做分类，然后按分类结果走不同路径。

### 4.3 Parallelization——并行执行

让多个 LLM 同时处理任务，输出由程序聚合。两种变体：
- **Sectioning**：将任务拆成独立子任务并行运行
- **Voting**：同一任务运行多次，取多数票或综合结果

**适用场景**：子任务可并行化加速，或需要多视角提高置信度。如"一个 LLM 处理用户查询，另一个并行审查是否包含不当内容"、"多个 prompt 从不同角度审查代码漏洞"。

### 4.4 Orchestrator-Workers——动态分发

中央 LLM 动态分解任务、分派给 Worker LLM、汇总结果。

**适用场景**：子任务不可预先确定的复杂任务。如"代码变更涉及多少文件、每个文件改什么，取决于具体任务"。

**本质**：这就是 Plan-and-Execute 范式的 Workflow 化——Orchestrator 做规划，Workers 做执行。它与简单 Parallelization 的关键区别是灵活性：子任务不是预定义的，而是 Orchestrator 根据具体输入动态决定的。

### 4.5 Evaluator-Optimizer——评估迭代

一个 LLM 生成响应，另一个 LLM 评估并给出反馈，形成迭代循环。

**适用场景**：有明确评估标准、迭代可带来可衡量改进。如"文学翻译——翻译 LLM 可能遗漏细微差异，评估 LLM 提供改进反馈"。

**本质**：这是 Reflexion 的 Workflow 化——但 Reflexion 是跨试验的反思，Evaluator-Optimizer 是单次任务内的迭代精炼。

### 4.6 五种模式与 Agent 范式的关系

| Anthropic Workflow 模式 | 对应的 Agent 范式 | 控制流归属 |
| :--- | :--- | :--- |
| Prompt Chaining | Plan-and-Execute（退化版） | 预定义代码 |
| Routing | N/A（分类分发） | 预定义代码 |
| Parallelization | LLMCompiler（简化版） | 预定义代码 |
| Orchestrator-Workers | Plan-and-Execute | LLM 动态决策（仅规划阶段） |
| Evaluator-Optimizer | Reflexion（单任务版） | 预定义循环 |
| 真正的 Agent | ReAct + 上述模式的组合 | LLM 全程动态控制 |

从这张表还能看出 Workflow 与 Agent 的真正分界：不在于是否用了 LLM，也不在于步骤多少，而在于状态与反馈是否形成闭环。Workflow 的状态由代码维护，反馈由代码判断；Agent 的状态由上下文维护，反馈由 LLM 判断。一旦"下一步做什么"这个决定从代码手里移交到 LLM 手里，系统就越过了 Workflow 与 Agent 的分界线——无论它外表看起来多么"流程化"。

> [!note] 设计哲学：从简单到复杂的递进
> Anthropic 的五种模式按复杂度递增排列：Prompt Chaining（最简单）→ Routing → Parallelization → Orchestrator-Workers → Evaluator-Optimizer → Agent（最复杂）。这个递进不是"越复杂越好"，而是"需要时才升级"。很多生产场景下，Prompt Chaining 或 Routing 就够了，不需要 Orchestrator-Workers，更不需要完整的 Agent 循环。选择模式的决策树是：**任务能拆成固定步骤吗？→ 能：用 Prompt Chaining；不能：子任务可预测吗？→ 可预测：用 Orchestrator-Workers；不可预测：用 Agent。**

---

## 第 5 章 2025 年生产框架的范式选择

范式演进到这一步，剩下的问题是工程化的：谁来把这些范式变成开发者能直接使用的产品？2025 年之前，答案是各式各样的 Agent 库与脚本；2025 年之后，答案收敛为少数几个被大量生产环境检验过的框架。框架之于范式，有点像旅行社之于旅行路线——路线本身是公开的，但把一条路线变成一趟能成行的行程，订票、住宿、突发状况处理都要有人负责，这个角色就是框架。本节挑三个有代表性的样本——LangGraph、CrewAI、AutoGPT Platform——分别代表"图执行""角色协作"与"可视化编排"三条产品化路线。

### 5.1 LangGraph 1.0——图执行模型的状态化 Agent

LangGraph 于 2025 年 10 月 22 日正式发布 1.0 GA 版本，成为"持久化 Agent 框架"领域的第一个稳定主版本。在 1.0 之前，LangGraph 已经在 Uber、LinkedIn、Klarna 等公司的生产环境中运行了一年多。与它同日发布的 LangChain 1.0 承担了"快速构建"的角色——标准工具调用架构加中间件机制，官方把两者的分工说得直白：LangChain 是构建 Agent 的最快路径，LangGraph 是面向生产级长时任务的底层运行时，且 1.0 之后承诺在 2.0 之前不引入破坏性变更。

LangGraph 的核心抽象是**有向图（directed graph）**：
- **State**：在图中流动的类型化状态对象
- **Nodes**：节点，每个节点是一个函数，接收 State、返回更新后的 State
- **Edges**：边，定义节点间的转移，支持条件分支和循环

这个抽象极其通用——ReAct 循环可以表示为一个包含"推理节点"和"行动节点"的双节点循环图；Plan-and-Execute 可以表示为一个"规划节点"后接多个"执行节点"的 DAG；Reflexion 可以表示为在 ReAct 循环外加一层"反思节点"。

LangGraph 1.0 的关键生产特性：
- **Durable State**：Agent 执行状态自动持久化，服务器重启或长时任务中断后可以精确恢复
- **Built-in Persistence**：无需自定义数据库逻辑即可保存和恢复 Agent 工作流，支持多日审批流程和跨会话后台任务
- **Human-in-the-loop**：一等公民支持人工审查、修改或批准 Agent 操作
- **Graph-based Execution**：对混合确定性和 agentic 组件的复杂工作流提供细粒度控制

LangGraph 1.0 中 `create_react_agent` 预构建已被废弃，改为 LangChain v1 的 `create_agent` 函数（基于 LangGraph 运行时），这标志着从"ReAct 专用预构建"向"通用图编排"的演进——ReAct 不再是特殊范式，而是图模型的一种实例化。

> [!info] 核心概念：LangGraph 的图模型为什么重要
> 传统 Agent 框架（如早期的 LangChain Agent）把 Agent 实现为一个固定的 while 循环：`while not done: thought = llm(history); action = parse(thought); obs = execute(action); history.append(...)`。这种固定循环的问题在于：你无法在中间插入"程序化检查门控"、无法做条件分支、无法并行执行、无法持久化中间状态。LangGraph 用图模型替代固定循环——你可以画任意拓扑的图来编排 Agent 的行为，分支、循环、并行、持久化都是图的一等公民。这种灵活性让 LangGraph 成为"需要精细控制的生产 Agent"的首选框架。

### 5.2 CrewAI——角色驱动的多 Agent 协作

CrewAI 采用了与 LangGraph 完全不同的设计哲学——不提供图执行模型，而是用**团队隐喻**来组织多 Agent 协作。

核心概念：
- **Agent**：每个 Agent 有 `role`（角色，如"资深数据科学家"）、`goal`（目标）、`backstory`（背景故事），这些属性影响 LLM 的行为
- **Task**：每个 Task 有描述、预期输出、负责的 Agent
- **Crew**：多个 Agent + 多个 Task 组成一个 Crew，按顺序或并行执行

CrewAI 的范式本质上是 **Orchestrator-Workers 的角色化包装**——用户预先定义好"团队"的结构（谁做什么、按什么顺序），CrewAI 负责编排执行。它支持 `planning=True` 参数启用 Plan-and-Execute 变体（Agent 先生成计划再执行），但默认模式下更接近预定义的串行/并行 Workflow。

CrewAI 的定位很明确：**快速原型多 Agent 团队，最小化样板代码**。截至 2025 年，超过 10 万开发者通过社区课程获得 CrewAI 认证，月执行量超 1000 万次。

> [!warning] 生产避坑：CrewAI 的"多 Agent"可能只是多次 LLM 调用
> CrewAI 的角色定义（role/goal/backstory）会让每次 LLM 调用使用不同的 system prompt，给人"多个不同 Agent 在协作"的感觉。但如果所有 Agent 共用同一个 LLM 模型，它们之间的区别仅在于 prompt 不同——本质上是同一个 LLM 在扮演不同角色。这在很多场景下足够用（角色化 prompt 确实能引导 LLM 产出不同视角的内容），但不要误以为你在运行多个"独立的智能体"。真正的多 Agent 系统需要每个 Agent 有独立的工具集、独立的记忆、独立的决策边界——这正是 [[LLM/Agent技术/应用开发/14 多 Agent 系统与 A2A 协议——协作、通信与特化|本专栏第十四篇]] 讨论的主题。

### 5.3 AutoGPT Platform——从 CLI 实验到可视化平台

AutoGPT 是 2023 年 3 月引爆全网自主 Agent 热潮的项目——一个让 GPT-4 自主循环调用来完成目标的 CLI 脚本，以 175K GitHub Stars 的速度创造了历史记录。但早期的 AutoGPT CLI 存在严重问题：开放式循环导致 Agent 经常跑偏、无法预测、成本失控。

到 2025-2026 年，AutoGPT 已经从 CLI 脚本演进为**可视化平台**，包含四个界面：
- **AutoPilot**：用自然语言描述任务，自动转化为可运行的 Agent
- **Agents**：查看所有 Agent 的运行状态、成本、需要关注的操作
- **Marketplace**：从社区分享的预构建 Agent 开始，类似 WordPress 插件目录
- **Build**：拖拽式可视化工作流编辑器，连接 blocks 精确控制每一步

AutoGPT Platform 的核心是**基于 block 的 DAG 执行模型**——Agent 被定义为有向无环图，每个节点是一个 block（自包含的功能单元，有类型化的输入输出）。这本质上是 LLMCompiler 的产品化——自动识别哪些步骤可以并行、哪些有依赖关系需要串行。

AutoGPT 的演进路径揭示了一个重要趋势：**从"开放式自主循环"回归"结构化可控执行"**。早期 AutoGPT 让 LLM 完全自主决策下一步做什么，结果发现可控性和可预测性太差。新平台通过可视化 DAG 编辑器，让人类在"LLM 自主性"和"结构化控制"之间找到平衡。

### 5.4 三大框架的范式选择对比

| 维度 | LangGraph 1.0 | CrewAI | AutoGPT Platform |
| :--- | :--- | :--- | :--- |
| **底层范式** | 图执行模型（可实例化为任意范式） | Orchestrator-Workers（角色化） | DAG 并行执行（LLMCompiler 产品化） |
| **ReAct 支持** | `create_agent` 内置 ReAct 循环 | 可实现但非默认 | 非核心（偏向结构化工作流） |
| **Plan-and-Execute** | 图模型自然支持 | `planning=True` 参数 | DAG 编辑器本质就是 Plan |
| **并行执行** | 图中可定义并行节点 | 支持 Task 并行 | DAG 自动并行化 |
| **状态持久化** | Durable State（一等公民） | 有记忆但非核心 | 平台托管状态 |
| **Human-in-the-loop** | 一等公民支持 | 有但需自定义 | 通过审批 block 支持 |
| **适用场景** | 需要精细控制的复杂生产 Agent | 快速原型多角色协作 | 非开发者构建自动化工作流 |
| **控制粒度** | 最细（图节点级） | 中等（Agent/Task 级） | 最粗（Block 级，面向可视化） |
| **目标用户** | 工程师 | 工程师/快速原型者 | 非开发者/自动化爱好者 |

> [!note] 设计哲学：范式选择不是技术问题，是约束问题
> 三个框架的选择，本质上是三个约束的权衡：
> 1. **任务可分解性**：任务能预先拆成固定步骤吗？能 → AutoGPT 的 DAG；不能 → LangGraph 的动态图
> 2. **延迟容忍度**：用户能等多久？秒级 → 避免复杂 Agent 循环；分钟级 → 可以用 ReAct + Reflexion
> 3. **token 成本约束**：每次调用的预算是多少？紧张 → Plan-and-Execute/LLMCompiler；宽裕 → ReAct/LATS
>
> 没有框架是"万能的"——LangGraph 灵活但学习曲线陡峭，CrewAI 简单但控制粒度粗，AutoGPT Platform 易用但灵活性最低。选择哪个，取决于你的具体约束组合。

---

## 第 6 章 2025-2026 的平台化竞赛——厂商 SDK、协议分层与推理 Agent

如果说第 5 章讲的是"开源框架如何把范式产品化"，这一章就要把镜头拉得更高，看 2025 年发生的三件改变格局的事：OpenAI 把 Agent 循环搬进了 API 服务端，Anthropic 把自家 Coding Agent 的运行内核做成了 SDK，Google 则一边开源 ADK、一边牵头定义了 Agent 之间的互操作协议 A2A。三件事叠在一起，Agent 的生产形态从"开发者自己搭循环"加速滑向"平台提供循环、开发者只做编排"。

### 6.1 OpenAI：把 Agent 循环搬进服务端

2025 年 3 月 11 日，OpenAI 发布了一组官方称为"New tools for building agents"的新工具，核心是四件事：新的 **Responses API**、三个内置工具（Web Search、File Search、Computer Use）、开源的 **Agents SDK**，以及配套的可观测工具。这组发布的意义不在某一个 API，而在一个姿态——**OpenAI 认为"循环"应该由平台托管，而不是让每个开发者自己写**。

先看 Responses API。在它之前，开发者要在 Chat Completions 之上手写工具调用循环：把工具描述塞进请求、解析模型输出的 tool_calls、执行工具、把结果拼回消息历史、再发起下一次请求。Responses API 把这个循环封装成服务端原语——开发者声明可用工具列表，由 API 在多次推理之间自主决定调用顺序、维护会话状态，返回的响应里既包含最终答案，也包含中间的工具调用记录。循环的控制权，就这样从客户端代码移交到了服务端。

再看 Agents SDK。它是一层轻量的代码编排库，核心抽象包括：Agent（由指令、工具、Guardrails 配置的智能体）、Handoffs（Agent 把任务交接给另一个 Agent，类似电话转接）、Guardrails（输入输出校验，用于拦截越界内容与注入）、Sessions（跨运行的会话历史自动管理）与 Tracing（内置追踪）。这套设计与 LangGraph 形成了耐人寻味的对照：LangGraph 把"循环"做成开发者可以任意改写的图，强调**可控性**；OpenAI 把"循环"做成托管服务加轻量编排，强调**省心与一致**。二者没有高下，只有取舍——需要细粒度控制的生产系统仍然偏向 LangGraph，想快速搭起多 Agent 服务的团队则明显受益于托管循环。

### 6.2 Anthropic：把 Claude Code 的运行内核做成 SDK

Anthropic 走的是一条与 OpenAI 相反的路：不是先有平台再设计循环，而是先把自家 CLI 产品 Claude Code 打磨成熟，再把它背后的运行内核原样开放。2025 年 9 月 29 日，Anthropic 随 Claude Sonnet 4.5 一同发布了 **Claude Agent SDK**（由 Claude Code SDK 更名而来），把驱动 Claude Code 的那套积木——内置工具（读写文件、执行命令、联网搜索）、上下文管理系统（Context Editing、Memory Tool）、权限模型、Subagent 与 Hooks——变成了 Python 与 TypeScript 的编程接口。

这个做法的底气来自内部实践。Anthropic 在发布说明里承认，Claude Code 已经"开始支撑公司内部几乎所有主要的 Agent 循环"（begun to power almost all of our major agent loops），包括深度研究、视频制作、笔记整理这些与写代码无关的场景。既然同一个 harness 能驱动如此多样的 Agent，把它开放出来就是顺理成章的选择。这也是"产品反向输出框架"的典型案例：Claude Agent SDK 没有发明新范式，它只是把经过真实产品检验的 ReAct 循环、权限审批与上下文管理，原封不动地交到开发者手里。它的局限也因此显而易见——自由度的边界由 Claude Code 的产品形态划定，你想改循环的内部结构，往往不如在 LangGraph 里画一张图来得直接。

### 6.3 Google：Gemini ADK 与 A2A 协议的双线布局

Google 的动作比前两家更"体系化"。2025 年 4 月 9 日，在 Google Cloud NEXT 2025 上，Google 开源了 **Agent Development Kit（ADK）**——一个以"多 Agent 原生"（multi-agent by design）为卖点的框架，支持 Python、TypeScript、Go、Java 四种语言，可以接入 MCP 工具与 LiteLLM 支持的任意模型，内置评估、追踪与部署工具链。ADK 的定位是"让 Agent 开发像软件开发一样"，同一批代码既能本地跑，也能部署到 Cloud Run 或 GKE，Google 自己的 Agentspace 与客户服务套件里跑的 Agent 就构建在它之上。

同一天发布的另一件大事常被放在 ADK 的阴影里，但它对产业格局的影响可能更深远：Google 联合 50 多家合作伙伴（Atlassian、Box、Cohere、Intuit、LangChain、PayPal、Salesforce、SAP、ServiceNow 等）宣布了 **Agent2Agent（A2A）协议**，一个让不同厂商、不同框架构建的 Agent 能够互相发现、协商与协作的开放标准。A2A 在 2025 年 6 月迭代到 0.2.x，2026 年 3 月 12 日正式发布 **1.0.0**，由八家主要厂商组成的技术指导委员会维护，被官方称为"第一个生产就绪的 Agent 间通信标准"。

这里有必要厘清一个常被混淆的分层：**MCP 管的是"Agent 与工具"的连接，A2A 管的是"Agent 与 Agent"的通信**。MCP 由 Anthropic 于 2024 年 11 月开源，2025 年 3 月 26 日规范更新后进入快速采纳期——OpenAI 在 Agents SDK 里支持了它，Google 的 Hassabis 在 2025 年 4 月公开表态采纳，Microsoft、AWS 相继跟进，到 2025 年年中，MCP 已经是事实上的"工具层基础设施"（详见本专栏第 4、5 篇）。A2A 则补上的是另一块拼图：单个 Agent 内部的工具调用可以靠 MCP 打通，但两个独立部署的 Agent 之间如何发现对方能力（Agent Card）、如何协商任务（Task）、如何交换消息（Message），是 MCP 不负责、A2A 要回答的问题。打个比方，MCP 像是给每个 Agent 统一配了一根标准数据线，让它们能接上各种外设；A2A 则是两个 Agent 之间的"合作章程"，规定谁先开口、任务怎么交接、成果怎么交付。[[LLM/Agent技术/应用开发/14 多 Agent 系统与 A2A 协议——协作、通信与特化|本专栏第十四篇]] 会对 A2A 的协议细节展开。

### 6.4 Deep Research：推理范式长成的产品形态

平台之外，2025 年还出现了一类值得单独拎出来的产品形态——Deep Research。2025 年 2 月，OpenAI 在 ChatGPT 中发布 deep research：用户给一个研究题目，它用数十分钟在互联网上搜索、阅读、交叉验证成百上千个来源，产出一份研究分析师水准的报告，全程由用户离开等待，完成后再回来验收。它背后的模型是"为网页浏览与数据分析优化的 o3 版本"，本质上是一个"规划→搜索→阅读→综合"的长时任务循环。同年 6 月，OpenAI 进一步把这条能力开放成 Deep Research API（`o3-deep-research-2025-06-26` 与 `o4-mini-deep-research-2025-06-26` 两个模型），并把中间步骤——推理摘要、web_search_call、代码执行——作为结构化输出暴露出来，让开发者能追踪一次研究的全过程。Google 的 Gemini Deep Research agent 走了相似的路，还支持在规划阶段与人协作、接入 MCP 工具、用后台执行（background execution）跑长任务。

从范式演进的角度看，Deep Research 是 Plan-and-Execute 的"产品化命中"：研究任务的结构相对可预测（搜索→阅读→再搜索→综合），适合先规划后执行；它又是 ToT 那类"多路径探索"的隐式化——推理模型在内部完成路径取舍，用户看到的是最终报告与来源列表，而不是一棵显式的搜索树。它把第 3 章那张演进表里的两种范式，以消费者能理解的方式带进了大众视野。

### 6.5 分层格局：模型、框架、协议与应用

把模型、框架、协议、应用四个层次摆在一起，2025-2026 年的 Agent 生态呈现出清晰的分层结构：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TB
    M["模型层<br/>推理模型与通用模型<br/>内化多路径搜索"] --> F["框架与 SDK 层<br/>LangGraph / CrewAI / OpenAI Agents SDK<br/>Claude Agent SDK / Gemini ADK"]
    F --> P["协议层<br/>MCP（Agent ↔ 工具）<br/>A2A（Agent ↔ Agent）"]
    P --> A["应用层<br/>Deep Research / Claude Code / Devin"]

    classDef model fill:#bd93f9,stroke:#bd93f9,color:#282a36
    classDef framework fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef proto fill:#ff79c6,stroke:#ff79c6,color:#282a36
    classDef app fill:#50fa7b,stroke:#50fa7b,color:#282a36

    class M model
    class F framework
    class P proto
    class A app
```

这张图想说明三件事。其一，**模型层与框架层在加速解耦**——推理模型把"会想"的能力内化，框架把"会编排"的能力标准化，两边的创新不再互相绑架。其二，**协议层是 2024 到 2026 年最意外的增量**——MCP 与 A2A 让"工具"和"Agent"都变成了可插拔的标准化部件，任何厂商的产品都能接入别人的工具、或与别人的 Agent 协作，这在两年前几乎是不可想象的。其三，应用层开始出现"一个产品 = 一套成熟范式 + 一个平台 harness"的收敛模式，Claude Code 与 Deep Research 都是例证。协议的标准化正在把框架间的差异从"能不能互连"压缩到"怎么编排更顺手"，框架选型的决策重心也随之从"选谁的工具"转移到"选谁的循环"。

---

## 第 7 章 生产 Agent 的落地模式——编排、审批与可观测

框架与协议解决了"Agent 怎么搭"，但把 Agent 送进生产环境，是另一道完全不同的考题。把 Agent 送进生产，很像给一位能力出众但初来乍到的新员工办入职：业务能力是面试时考察过的，真正决定他能不能留下来的是流程纪律——他知道该向谁请示吗？每步动作有记录吗？出了问题有人复盘吗？2025 年多家机构的调研给出了同一个略显尴尬的结论：Deloitte 的 2026 年度报告显示，只有 21% 的组织拥有成熟的 Agentic AI 治理能力（清晰的自主边界、实时监控、审计轨迹），而到 2027 年预计有 74% 的组织将至少中度使用 AI Agent；MIT 的 NANDA 调研则指出，2025 年约 95% 的生成式 AI 试点项目没能进入生产。Agent 的"最后一公里"，从来不是模型能力问题，而是工程纪律问题。综合各大厂商与咨询机构的实践，2026 年生产 Agent 的落地模式可以归纳为三根支柱：**编排（Orchestration）、审批（Approval）、可观测（Observability）**。

### 7.1 编排：混合架构成为默认值

第 1 章那张五级分层表在 2026 年的生产语境里有了新的读法：纯 L4 的"全自主 Agent"与纯 L3 的"固定 Workflow"都成了少数派，绝大多数生产系统是二者的混合——可预测的步骤用 Workflow 保证确定性，需要临场决策的步骤交给 Agent 动态处理。这种混合的工程表达，就是编排层。LangGraph 1.0 的 Durable State 支持"多日审批流程""跨会话后台任务"，Google ADK 的 Workflow Runtime 支持路由、扇出扇入、循环与重试，OpenAI 的 Agents SDK 则用 Handoffs 实现 Agent 间的任务交接——三家不约而同地把"编排"做成了框架的一等公民。IBM 的实践建议里甚至提出了"控制平面"（control plane）的概念：在 Agent、工具与环境的混战之上，建一层统一的可见性与治理入口，让团队知道"谁在跑、跑了什么、花多少钱"。

### 7.2 审批：人在环路的重新定价

第二根支柱是审批。Dynatrace 的 2026 年 Agentic AI 报告给出了一组被广泛引用的数字：超过三分之二的 Agentic AI 决策目前仍由人类验证，最常见的验证手段是数据质量检查（50%）、人工审查 Agent 输出（47%）与生产环境中的漂移监控（41%）。这组数字说明，"人在环路"不是过渡期的妥协，而是生产 Agent 的**默认结构**——概率性系统做出的决策，在高风险场景下必须有人的签名。

审批的工程化方式也在成熟。LangGraph 把 human-in-the-loop 做成了暂停/恢复的一等公民 API，Claude Code 把权限分成"询问/允许/拒绝"的粒度，OpenAI 的 Agents SDK 提供 Guardrails 与人工审查钩子。但这里有一个常见的反模式：把审批做成"每一步都要点确认"。正确的粒度应该是**高风险操作审批、低风险操作放行**——读文件、跑测试这类动作直接放行，删除数据、推送代码、对外发消息这类动作必须审批。审批密度一旦过高，Agent 的自动化与手动操作就失去了差别，用户的耐心会在第十次弹窗时耗尽。本专栏第 7 篇会专门拆解权限与审批模型的工程细节。

### 7.3 可观测：Agent 的"黑匣子"怎么打开

第三根支柱是可观测。传统 APM 观测的是请求与线程，Agent 的观测对象却是"决策"——一次任务里可能穿插几十次 Thought、Tool Call 与 Observation，任何一个环节出错，都可能导致看似合理的最终结果其实建立在错误的基础上。ReAct 范式天然给了可观测性一个抓手：Thought 是显式的推理记录，Action 与 Observation 是结构化的调用与反馈，把它们按序连成 trace，就能回答"它为什么这么做"。OpenAI 的 Agents SDK 内置 tracing，ADK 提供追踪与监控，LangSmith 则围绕 LangGraph 生态做评估与追踪——各家都在把**决策轨迹**变成可查询、可回放的一等数据。OpenTelemetry 社区也在推进生成式 AI 的语义约定，让不同厂商的 Agent trace 有机会在统一标准下互认。这一块是生产 Agent 从"能用"走向"敢用"的分水岭。

### 7.4 三支柱的投入比例与常见失败

| 支柱 | 回答的问题 | 代表实现 | 常见失败 |
| :--- | :--- | :--- | :--- |
| **编排** | 确定性流程与自主决策如何共存 | LangGraph 图运行时、ADK Workflow Runtime、Agents SDK Handoffs | 把编排写成层层嵌套的回调，状态散落各处 |
| **审批** | 哪些动作需要人点头 | LangGraph HITL、Claude Code 权限模型、Agents SDK Guardrails | 审批过密导致自动化名存实亡 |
| **可观测** | 决策轨迹能否回溯与审计 | OpenAI tracing、LangSmith、ADK Tracing | 只记结果不记过程，出事后无从复盘 |

> [!warning] 生产避坑：可观测是最后才补的短板
> 三根支柱里，可观测最容易被拖到最后。演示阶段看不到它，小流量阶段感觉不到它，但一旦 Agent 开始大规模处理真实任务，一次错误的工具调用造成的事故，往往要等很久才会在最终结果里暴露。2025 年的行业调研反复指向同一结论：评估与治理能力强的团队，Agent 项目进入生产的比例高出数量级——ThoughtWorks 与 Databricks 的联合报告估算，使用评估工具的组织生产化项目约多 6 倍，具备治理能力的约多 12 倍。等到出事故再补可观测，就像火灾之后才想起装烟雾报警器。

---

## 第 8 章 从范式到实践——Coding Agent 的特殊约束

### 8.1 Coding Agent 与通用 Agent 的差异

本专栏关注的是 Coding/Terminal Agent——Claude Code、Devin、OpenHands、Cursor 这类能读写文件、执行命令、操作 Git 的 Agent。它们在范式选择上有一些与通用 Agent（如客服 Agent、搜索 Agent）不同的特殊约束。Coding Agent 之于通用 Agent，好比外科手术之于门诊问诊——前者每一次操作都直接改变现实、不可逆，所以格外需要权限、审批与沙箱：

**约束一：行动的不可逆性**。通用 Agent 调一个搜索工具，结果不对再调一次就行——行动是可逆的。但 Coding Agent 执行了 `rm -rf /` 或 `git push --force`，后果不可逆。这意味着 Coding Agent 必须有更严格的权限控制和人在环路审批机制。本专栏第 7 篇将深入讨论这一主题。

**约束二：长时任务的上下文管理**。Coding Agent 可能需要连续工作数小时——读几十个文件、执行上百条命令、做多次代码修改。这么多操作产生的 Observation 会迅速撑爆 LLM 的上下文窗口。Context Engineering（本专栏第 6 篇）成为 Coding Agent 的核心技术挑战。

**约束三：工具接口设计的认知友好性**。Coding Agent 的工具接口（Tool Schema）需要为 LLM 的认知模式优化，而不是为人类优化。Devin 团队提出的 ACI（Agent Computer Interface）概念（本专栏第 18 篇）专门研究这个问题——同样的 LLM，用不同的工具接口设计，性能可以从接近零提升到 SOTA。

**约束四：沙箱隔离的安全需求**。Coding Agent 执行的代码可能来自用户、可能来自 LLM 生成、甚至可能来自被 Prompt Injection 污染的恶意指令。Agent 必须在隔离的沙箱中执行代码，防止逃逸危害宿主系统。这是姊妹专栏 [[LLM/Agent沙箱技术/00 专栏导览|Agent 沙箱技术]] 的主题。

### 8.2 Coding Agent 的范式选择

基于上述约束，2025 年的主流 Coding Agent 在范式选择上呈现出一些共性：

**Claude Code**：核心使用 ReAct 循环（Thought → Tool Call → Observation → Thought），但通过 Subagent 机制实现了类 Orchestrator-Workers 模式——主 Agent 可以委派子任务给拥有独立上下文窗口的 Subagent（本专栏第 17 篇详解）。

**Devin**：采用长时规划 + ReAct 执行的混合模式。Devin 会在任务开始时做详细的 Interactive Planning（规划阶段），然后进入 ReAct 循环执行（执行阶段），并在执行过程中根据反馈调整计划（本专栏第 18 篇详解）。

**OpenHands**：使用 Event Stream 架构记录所有 action 和 observation，Agent 的 `step(state) → action` 函数本质上是 ReAct 的单步执行。Runtime 是一个 per-session 的 Docker 沙箱（本专栏第 19 篇详解）。

**Cursor**：采用 Agent Swarm 架构——Planner agents（强模型）拆分目标并委派，Worker agents（快模型）执行具体任务。这本质上是 Orchestrator-Workers 的多层级联（本专栏第 20 篇详解）。

**Aider**：单进程 ReAct，但通过 Architect/Editor Pattern 实现了 Plan-and-Execute 的变体——主模型作为 Architect 生成高层规划，Editor 模型负责具体代码修改（本专栏第 19 篇详解）。

### 8.3 范式选择的决策树

基于上述实践，可以为 Coding Agent 的范式选择提炼一个决策树：

```mermaid
%%{init: {'theme': 'dracula', 'themeVariables': {'primaryColor': '#6272a4', 'primaryTextColor': '#f8f8f2', 'primaryBorderColor': '#bd93f9', 'lineColor': '#ff79c6', 'secondaryColor': '#44475a', 'tertiaryColor': '#282a36'}}%%
graph TD
    Q1["任务步骤可预测吗？"] -->|"是"| Plan["Plan-and-Execute<br/>或 Anthropic Workflow"]
    Q1 -->|"否"| Q2["需要多步动态决策吗？"]
    Q2 -->|"否"| Simple["单次 LLM 调用<br/>或 Prompt Chaining"]
    Q2 -->|"是"| Q3["行动可逆吗？"]
    Q3 -->|"是"| ReAct["ReAct 循环"]
    Q3 -->|"否"| Q4["有可靠评估器吗？"]
    Q4 -->|"是"| Refl["ReAct + Reflexion<br/>或 Evaluator-Optimizer"]
    Q4 -->|"否"| Q5["能接受人在环路吗？"]
    Q5 -->|"是"| HITL["ReAct + 权限审批门控"]
    Q5 -->|"否"| Q6["子任务可并行吗？"]
    Q6 -->|"是"| LC["LLMCompiler / Orchestrator-Workers"]
    Q6 -->|"否"| LATS2["ReAct + 人工干预<br/>（避免完全自主）"]

    classDef question fill:#44475a,stroke:#bd93f9,color:#f8f8f2
    classDef answer fill:#50fa7b,stroke:#50fa7b,color:#282a36

    class Q1,Q2,Q3,Q4,Q5,Q6 question
    class Plan,Simple,ReAct,Refl,HITL,LC,LATS2 answer
```

这张决策树画于推理模型大规模普及之前。2025-2026 年之后，树根处的第一问其实被削掉了一层：不少过去必须靠外部规划器完成的可预测任务，现在直接用推理模型"想清楚再动手"即可，ReWOO/Plan-and-Execute 那套"先规划再执行"的价值部分地被模型内化。决策树仍然成立，但它的第一问从"任务步骤可预测吗"悄悄变成了"这一步值得让模型反复想吗"。

---

## 第 9 章 总结与专栏导读

### 9.1 全景回顾

从 ReAct 到 2026 年的生产 Agent，范式的演进呈现出清晰的逻辑主线：

1. **ReAct（2022）** 建立了"推理+行动交织"的基本范式，是所有后续工作的起点
2. **Reflexion（2023）** 给 ReAct 加上了跨试验的自反思记忆
3. **Tree of Thoughts（2023）** 给 ReAct 加上了树状搜索，但被推理模型部分取代
4. **ReWOO/Plan-and-Execute（2023）** 通过规划-执行解耦解决了 token 平方增长
5. **LATS（2024）** 统一了推理+行动+规划，但计算成本过高难以用于生产
6. **LLMCompiler（2024）** 给 ReAct 加上了并行执行
7. **生产框架（2025）** 将上述范式产品化：LangGraph 用图模型通用化、CrewAI 用角色化简化、AutoGPT 用可视化民主化
8. **平台化竞赛（2025-2026）** OpenAI、Anthropic、Google 各自把循环托管进 API 与 SDK，MCP 与 A2A 让工具层与互操作层标准化，Deep Research 把推理范式做成了大众产品
9. **生产落地（2026）** 编排、审批与可观测成为三根支柱，人在环路被重新定价为生产 Agent 的默认结构

贯穿始终的一个核心认知：**没有"最好的"范式，只有"最合适的"权衡**。ReAct 的灵活性 vs Plan-and-Execute 的效率、Reflexion 的学习 vs ToT 的搜索、LATS 的质量 vs LLMCompiler 的速度、LangGraph 的可控 vs OpenAI 托管的省心——每一个选择都是在"灵活性、效率、质量、成本"四个维度间的取舍。

### 9.2 专栏后续导读

本篇建立了 Agent 范式的全景地图，后续文章将逐一深入各个主题：

- **第 2 篇**（[[LLM/Agent技术/基础范式/02 ReAct 架构深度解析——Thought-Action-Observation 循环的本质|ReAct 架构深度解析]]）将深入 ReAct 的内部机制——prompt 模板设计、循环控制、失败模式分析
- **第 3 篇** 将对比 OpenAI/Anthropic/Gemini 三家的 Function Calling 规范，理解 Tool Use 的工程化
- **第 4-5 篇** 将深入 MCP 协议与生态——Agent 与工具的标准化连接
- **第 6 篇** 将讨论 Context Engineering——长时 Agent 的上下文管理艺术
- **第 7 篇** 将讨论 Agent 权限与审批模型——人在环路的工程实践
- **第 13 篇** 将从设计哲学出发，系统比较 LangGraph、CrewAI、OpenAI Agents SDK 等框架的选型
- **第 14 篇** 将展开多 Agent 系统与 A2A 协议——协作、通信与特化
- **第 16 篇** 将讨论 Agent 评估与可靠性工程——生产 Agent 的质量保障
- **第 17-21 篇** 将逐一解构 Claude Code、Devin、OpenHands/Aider、Cursor 的架构，以及 Agent 与操作系统的交互接口

> [!info] 专栏导航
> 本文是 [[LLM/Agent技术/00 专栏导览|Agent 技术专栏]] 的第 1 篇。下一篇 [[LLM/Agent技术/基础范式/02 ReAct 架构深度解析——Thought-Action-Observation 循环的本质]] 将深入 ReAct 的单步机制，剖析 Thought 如何引导 Action、Observation 如何反馈 Thought、循环何时终止、什么情况下会失败。理解了 ReAct 的内部细节，才能理解为什么 Claude Code、Devin 等 Coding Agent 都以 ReAct 为基础循环。

---

## 参考文献

1. Yao, S. et al. "ReAct: Synergizing Reasoning and Acting in Language Models." ICLR 2023. https://arxiv.org/abs/2210.03629
2. Shinn, N. et al. "Reflexion: Language Agents with Verbal Reinforcement Learning." NeurIPS 2023. https://arxiv.org/abs/2303.11366
3. Yao, S. et al. "Tree of Thoughts: Deliberate Problem Solving with Large Language Models." NeurIPS 2023. https://arxiv.org/abs/2305.10601
4. Xu, B. et al. "ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models." 2023. https://arxiv.org/abs/2305.18323
5. Zhou, A. et al. "Language Agent Tree Search Unifies Reasoning, Acting, and Planning in Language Models." ICML 2024. https://proceedings.mlr.press/v235/zhou24r.html
6. Kim, S. et al. "An LLM Compiler for Parallel Function Calling." ICML 2024. https://proceedings.mlr.press/v235/kim24y.html
7. Schluntz, E. & Zhang, B. "Building Effective Agents." Anthropic Engineering Blog, 2024-12-19. https://www.anthropic.com/engineering/building-effective-agents
8. LangChain. "LangChain and LangGraph Agent Frameworks Reach v1.0 Milestones." 2025-10-22. https://www.langchain.com/blog/langchain-langgraph-1dot0
9. CrewAI. GitHub Repository. https://github.com/crewaiinc/crewai
10. AutoGPT. GitHub Repository. https://github.com/Significant-Gravitas/AutoGPT
11. OpenAI. "New tools for building agents." 2025-03-11. https://openai.com/index/new-tools-for-building-agents/
12. OpenAI. "openai/openai-agents-python"（Agents SDK 仓库）. https://github.com/openai/openai-agents-python
13. Anthropic. "Introducing Claude Sonnet 4.5"（Claude Agent SDK 发布说明）. 2025-09-29. https://www.anthropic.com/news/claude-sonnet-4-5
14. Google Developers Blog. "Agent Development Kit: Making it easy to build multi-agent applications." 2025-04-09. https://developers.googleblog.com/agent-development-kit-easy-to-build-multi-agent-applications/
15. Google Developers Blog. "Announcing the Agent2Agent Protocol (A2A)." 2025-04-09. https://developers.googleblog.com/a2a-a-new-era-of-agent-interoperability/
16. A2A Protocol. "A2A Protocol Ships v1.0: Production-Ready Standard for Agent-to-Agent Communication." 2026-03-12. https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/
17. OpenAI. "Introducing deep research." 2025-02. https://openai.com/index/introducing-deep-research/
18. OpenAI. "Introduction to the Deep Research API." https://developers.openai.com/cookbook/examples/deep_research_api/introduction_to_deep_research_api
19. Ars Technica. "MCP: The new 'USB-C for AI' that's bringing fierce rivals together." 2025-04. https://arstechnica.com/information-technology/2025/04/mcp-the-new-usb-c-for-ai-thats-bringing-fierce-rivals-together/
20. Dynatrace. "The pulse of agentic AI 2026." https://cdn.dm.dynatrace.com/assets/documents/reports/bae22697-agentic-ai-report-2026.pdf
21. Deloitte. "Agentic AI is scaling faster than guardrails"（2026 State of AI in the Enterprise）. https://www.deloitte.com/us/en/insights/topics/emerging-technologies/ai-agents-scaling-faster.html
22. ThoughtWorks & Databricks. "State of AI Agents 2026." https://www.thoughtworks.com/content/dam/thoughtworks/documents/e-book/State-of-AI-Agents-2026-020426.pdf
23. IBM. "Preparing your enterprise to put AI agents into action." https://www.ibm.com/think/perspectives/preparing-your-enterprise-to-put-ai-agents-into-action

---

## 思考题

1. **如果一个 Coding Agent 的任务是"修复一个已知 bug"，你会选择 ReAct 还是 Plan-and-Execute？为什么？** 提示：考虑"修复 bug"的过程是否可预测——你能预先列出所有步骤吗？

2. **ReWOO 在 HotpotQA 上实现了 5 倍 token 效率提升，但为什么 2025 年的主流 Coding Agent（如 Claude Code）仍然使用 ReAct 而非 ReWOO？** 提示：考虑 Coding Agent 的执行过程中环境是否变化——文件修改后，后续步骤的依赖关系是否可能改变？

3. **Anthropic 说"最成功的实现使用简单、可组合的模式而非复杂框架"。但 LangGraph 1.0 是一个相当复杂的框架。这两者矛盾吗？** 提示：考虑"框架复杂"和"使用方式简单"是否可以共存——LangGraph 的图模型是否让"简单模式的组合"变得更容易？

4. **OpenAI 把循环做成托管服务（Responses API），LangGraph 把循环做成开发者可改的图，Claude Agent SDK 把产品内核原样开放。三种"循环的归属"分别适合什么样的团队？** 提示：从可控性、可定制性、维护成本三个角度权衡。

5. **MCP 管 Agent 与工具的连接，A2A 管 Agent 与 Agent 的通信。如果你的系统里只有单个 Agent，A2A 是否还有价值？** 提示：考虑 A2A 的 Agent Card 发现机制对系统演进意味着什么——今天用不到，明天接入外部 Agent 时呢？