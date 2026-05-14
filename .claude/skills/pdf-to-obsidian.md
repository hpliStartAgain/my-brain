---
name: pdf-to-obsidian
description: >
  将英文 PDF 技术书籍完整翻译为中文 Obsidian Markdown 笔记。
  四阶段流水线：嗅探提取 → 逐章翻译 → 仲裁校验 → 索引整合。
  触发场景：(1) 用户提供 PDF 路径要求转换，(2) 用户说"翻译这本书""PDF 转 MD""把这本书加入数字花园"。
  核心约束：只允许对信息做加法，不允许做减法（禁止概括/省略/压缩原文信息）。
---

# PDF → Obsidian 翻译转换 Skill

## 前置条件

- 系统需安装 `poppler-utils`（提供 `pdftotext` 命令）
- 目标 PDF 必须可提取文本（非扫描版图片 PDF）

## 全局约束（必须严格遵守）

1. **只增不减**：翻译过程只允许增加信息（译注、Mermaid 图表、术语说明），严禁省略、概括、压缩原文任何内容
2. **全中文化**：术语首次出现可附英文原文，后续使用中文；代码/命令/API 名保持原样
3. **图表内嵌**：所有图表转为 Mermaid 代码块，内嵌在 MD 中
4. **Obsidian 兼容**：使用 YAML frontmatter、wiki link `[[...]]`、callout 语法

## Phase 1: 嗅探提取

### 步骤
1. 运行 `pdftotext -layout "<pdf_path>" /tmp/book_full.txt`
2. 统计全书词数：`wc -w /tmp/book_full.txt`
3. 解析目录结构，识别各章标题与页码
4. 定位各章在文本文件中的行号边界
5. 识别每章内 Figure/Table 引用清单（正则：`Figure \d+`、`Table \d+`）
6. 在目标目录创建 `.skill-state.json` 记录每章状态

### .skill-state.json 结构
```json
{
  "source_pdf": "原PDF路径",
  "total_words": 123456,
  "target_dir": "content/目标目录/",
  "chapters": [
    {
      "num": 1,
      "title_en": "Original Title",
      "title_zh": "中文标题",
      "lines": [1091, 3088],
      "word_count": 14440,
      "figure_count": 5,
      "table_count": 2,
      "status": "pending|translating|translated|arbitrated|failed",
      "output_file": "01-中文标题.md",
      "arbitration": { "passed": false, "score": 0, "issues": [] }
    }
  ]
}
```

## Phase 2: 逐章翻译

### Agent 指派
对每章启动独立翻译 Agent，使用以下 System Prompt 硬约束：

```
你是技术书籍翻译器，不是笔记工具。你的任务是逐段完整翻译，严格遵循以下规则：

【绝对禁止】
- 禁止用"..."省略原文内容
- 禁止写"此处省略详细说明"等跳过性文字
- 禁止将多段合并为一段概括
- 禁止跳过任何代码示例、表格、列表
- 禁止只翻译"重点"而忽略"次要"内容

【必须执行】
- 原文每一个段落 → 译文对应一个段落
- 原文每一个代码块 → 译文保留完整代码（注释可翻译，代码不变）
- 原文每一个表格 → 译文完整表格
- 原文每一个列表 → 译文完整列表
- 原文每一个 Figure/Table 引用 → 译文保留引用 + 根据上下文和标题绘制 Mermaid 图表

【Mermaid 图表生成规则】
- 遇到 Figure 描述 → 根据图标题和上下文推测图表内容
- 架构图 → flowchart 或 graph
- 时序图 → sequenceDiagram
- 状态图 → stateDiagram
- 类图/继承关系 → classDiagram
- 数据表格/对比 → 直接使用 Markdown 表格
- 图表下方添加说明："> ▲ 上图根据原文 Figure X 标题和上下文推测绘制"

【术语处理】
- 首次出现：中文术语（English Term）→ 后续：纯中文
- 代码/API/命令/参数名保持英文原样

【输出格式】
使用 Obsidian Markdown，包含：
- YAML frontmatter（title, date, tags, aliases）
- 正文使用 ## 二级标题（章节用 # 一级标题）
- 使用 > [!note] / > [!warning] / > [!tip] 等 callout 补充上下文
- 可使用 [[其他章节]] wiki link 建立交叉引用
```

### 输入格式
将原文章节文本和图表清单提供给 Agent：
```
## 章节信息
- 章节编号：第 N 章
- 英文原标题：XXX
- 中文译名：XXX
- 原文词数：NNN

## 图表清单（需转换为 Mermaid）
- Figure N.M: 标题 → 推测类型
- Table N.M: 标题 → Markdown 表格

## 原文内容
[完整英文原文]
```

## Phase 3: 仲裁校验

### Agent 指派
对 Phase 2 输出启动独立仲裁 Agent（完全隔离上下文，不接触 Phase 2 的 Agent 会话）。

### 仲裁 Prompt
```
你是翻译质量仲裁器。你将收到：
1. 原文章节文本（英文）
2. 翻译后的 MD 文件（中文）

请逐一检查以下五个维度，输出评分表：

## 维度 1: TOC 结构完整性 (满分 20)
- 原文章节/小节标题逐一比对
- 缺失任一小节标题 → 扣分
- 评分标准：每缺失1个标题扣3分

## 维度 2: 词量比例 (满分 20)
- 计算：中文词数 / 英文词数
- 合理范围：1.2x ~ 3.5x
- < 1.2x：疑似压缩（扣10分）
- > 3.5x：疑似异常膨胀（扣5分）

## 维度 3: 图表覆盖 (满分 20)
- 统计原文 Figure/Table 引用数量
- 检查译文是否都有对应 Mermaid/表格
- 每缺失1个图扣5分

## 维度 4: 代码块覆盖 (满分 20)
- 统计原文代码行数/代码段数量
- 检查译文代码块数量和内容是否一致
- 每缺失1个代码块扣5分

## 维度 5: 术语一致性 (满分 20)
- 提取原文关键术语（技术名词）
- 检查译文是否使用统一翻译
- 同一术语出现2种以上翻译 → 每个不一致扣3分

## 输出格式
```
仲裁报告：第N章
总分：XX/100
通过阈值：85/100

维度1 (TOC完整性): XX/20 - [问题描述]
维度2 (词量比例): XX/20 - 比例X.XX - [问题描述]
维度3 (图表覆盖): XX/20 - [问题描述]
维度4 (代码块覆盖): XX/20 - [问题描述]
维度5 (术语一致性): XX/20 - [问题描述]

结论：[通过/不通过]
不通过章节：[列出需重做的具体内容]
```
```

### 仲裁结果处理
- 总分 >= 85 → 通过，标记 `arbitrated`，进入下一章
- 总分 < 85 → 不通过，将仲裁报告反馈给 Phase 2 Agent，重新翻译该章
- 连续 3 次不通过 → 标记 `failed`，人工介入

## Phase 4: 索引整合

### 步骤
1. 生成 `_index.md`：全书目录索引，包含每章标题、摘要、wiki link
2. 检查并补全跨章节引用（如 "详见第X章" → `[[0X-章节标题]]`）
3. 更新项目 CHANGELOG.md
4. 运行 `npx quartz build` 验证构建通过
5. 更新 `.skill-state.json` 全局状态为 `completed`

## 恢复机制
- 处理过程中如遇中断，读取 `.skill-state.json` 恢复进度
- 从第一个 `status != 'arbitrated'` 的章节继续
