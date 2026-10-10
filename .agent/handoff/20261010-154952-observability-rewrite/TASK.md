# Task

## Goal

按 `AGENTS.md` §1 与 skill `writing-technical-article`（凤凰架构六层 DNA）硬指标，对 `content/可观测/` 下**全部 42 个文件**做**破坏性全量重写**；结构调整为 **Loki（日志）/ VictoriaMetrics（指标）/ 夜莺 Nightingale（告警聚合）** 三条主线，允许重排并重命名篇目。

## Done When

- `content/可观测/` 下所有正文 ≥12000 中文字 / ≥500 行（00 导览不设字数下限，但需重写并同步全稿）。
- 全部文件 frontmatter 四字段（title/date/tags/aliases）完整；Mermaid 统一 `%%{init: {'theme': 'dracula'}}%%`；无 ASCII 表格；正文零全角感叹号；摘要 ≤800 字。
- **全专栏死链 0**（含清理历史遗留的 300+ 处裸产品名死链）。
- `content/index.md` 与全库入链同步；`CHANGELOG.md` 追加分节；`TODO.md` 任务节状态更新。

## Constraints

- **执行方式**：主 agent 串行直写，**禁用子代理**，中间不停确认（老板 2026-10-10 确认口径）。
- **范围**：全部 42 文件，含 `AIOps与可观测性实战/` 12 篇与 `00 可观测性全景导览.md`。
- **结构调整**：允许重排并重命名篇目，但必须同步修正 `content/index.md` 与全库入链（已用 `git mv` 保留历史）。
- **不虚构**年份/版本/性能数字；tags 用 inline 数组并遵循全局映射（`K8s→Kubernetes` 等）。
- **不破坏 frontmatter 结构**（Quartz 构建依赖）；不创建 Git commit 除非老板显式要求。

## Related Workflows

- `AGENTS.md`（仓库 always-on 规范：§1 交付硬指标、§3 变更记录惯例、§4 验证要求）
- `.devin/skills/writing-technical-article/`（SKILL.md + references/style-rules.md + references/delivery-standard.md + references/checklist.md）
- `TODO.md` 顶部任务节「可观测全栈专栏全量重写」（含重命名清单与续接说明）
- `CHANGELOG.md` 2026-10-10 分节
- 仓库既有交接约定：`.agent/CONTEXT.md`、`.agent/PROGRESS.md`、`.agent/STATE.json`
