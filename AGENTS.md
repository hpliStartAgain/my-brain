# my-brain 仓库工作规范

数字花园（Quartz v4 + Obsidian 双源）。`content/` 为知识库正文，根目录 `quartz.config.yaml` 为构建配置。本文件是 always-on 规范，所有 agent 在本仓库工作前必读。

## 1. 专栏交付标准（硬指标）

完整版见 `.devin/skills/writing-technical-article/references/delivery-standard.md`，核心约束：

- **篇幅**：技术深度专栏单篇 12000-16000 中文字 / 500+ 行；数据结构与算法专栏单独标准（不追求万字，补"为什么"说理）。范文标杆：`content/分布式架构/数据密集型系统架构实战/11 数据拆分之困.md`
- **论述逻辑**：是什么 → 为什么出现 → 不这样会怎样 → 如何落地 → 边界与反例
- **格式**：禁止 ASCII 表格（用 Markdown 表格）；Mermaid 统一 `%%{init: {'theme': 'dracula'}}%%` 配色；Callout 用 Obsidian 语法（`> [!note]` / `> [!info]`）；双向链接 `[[wiki]]` 必须先核实目标文件真实存在
- **frontmatter**：`title / date / tags / aliases`，tags 用 inline 数组且遵循全局映射（`Go→Golang`、`K8s→Kubernetes`、大小写统一），不得破坏结构
- **骨架**：`**摘要：**` 段 + `## 第 N 章` 编号 + 文末参考资料 + 思考题 callout（沿用各系列既有惯例）

## 2. 写作风格

技术文章/专栏创作与重写，使用 skill `writing-technical-article`（`.devin/skills/`，已同步全局）：凤凰架构（周志明）六层风格 DNA + 写前校准 + 写后自检清单。风格规则与去 AI 味规则冲突时，以该 skill 为准。

## 3. 变更记录惯例

- 内容变更追加 `CHANGELOG.md`（按日期分节，写明规模/结构/素材来源）
- 进行中的大型任务登记在根 `TODO.md`（含 status/tier 头部），完成后勾选并更新 status

## 4. 验证要求

批量修改后必须验证：frontmatter 完整、Mermaid 语法可渲染、`[[链接]]` 有效（Quartz 构建不因死链或 frontmatter 破损而失败）。批量整改采用"每批前列清单 → 老板确认 → 并行 subagent 执行 → 统一验证 → 记录"流程。
