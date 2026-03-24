---
name: learn
description: >
  从零开始系统学习某个技术主题。当用户说"学习""learn""从零开始学""系统学习"
  某个主题时触发。也可通过 /learn <主题> 手动触发。
  完整生命周期：规划主干道 → 权威知识对照 → 逐节点交互学习 → 笔记沉淀 → 进度追踪。
  支持跨会话续学。
argument-hint: <主题，如 Redis、MySQL、Docker>
---

# 系统学习 Skill

对主题 **$ARGUMENTS** 执行从零到完整的系统学习流程。

## 核心原则

1. **权威知识优先**：规划前必须获取官方文档目录，对照检查覆盖完整性
2. **交互式学习**：在对话中呈现 → 提问 → 用户回答 → 纠错补充 → 沉淀笔记
3. **不过度压缩**：提供必要的解释、对比、取舍分析，不只列要点
4. **纠错不跳过**：用户回答有错必须明确指出并纠正
5. **不提前投喂**：当前节点完成前不呈现下一节点内容
6. **中文为主**：中文讲解，技术术语保留英文

## 文件约定

```
<topic>/
├── index.md                    # 主干道：核心抽象 + 节点列表 + 依赖图
└── notes/
    ├── 01-xxx.md               # 节点笔记
    ├── 02-xxx.md
    └── ...
```

`<topic>` 使用小写英文，与仓库根目录平级（如 `redis/`、`mysql/`、`docker/`）。

## 阶段检测

每次调用时，根据文件状态判断当前所处阶段：

```
1. <topic>/index.md 不存在？
   → ROADMAP：规划主干道

2. index.md 无 "知识清单对照" section？
   → GAP_CHECK：获取权威知识清单，对照检查

3. 有状态为 ⬜ 的节点？
   → LEARNING：定位到第一个未完成节点，执行学习循环

4. 所有节点为 ✅？
   → COMPLETED：学习完成，更新 USER.md
```

## 会话续接

用户跨会话回来时（如第二天说"继续学 Redis"），自动：

1. 读取 `<topic>/index.md`，解析节点完成状态
2. 找到第一个未完成节点
3. 读取该节点之前的笔记，恢复上下文
4. 向用户报告进度摘要，确认继续

如果用户只说"继续"不带主题，搜索仓库中 `status: in-progress` 的 index.md 文件。

## 阶段详情

### ROADMAP — 规划主干道

详见 [references/roadmap-protocol.md](references/roadmap-protocol.md)。

核心动作：
- 读取 `USER.md` 了解用户基础
- 搜索仓库已有相关笔记
- 获取官方文档目录结构
- 设计 5-9 个学习节点（每节点 30-60 分钟）
- 创建 `<topic>/index.md` 和 `<topic>/notes/` 目录

### GAP_CHECK — 权威知识对照

详见 [references/roadmap-protocol.md](references/roadmap-protocol.md) 的 Gap Check 部分。

核心动作：
- 获取权威源的完整知识列表
- 逐项对照已规划节点
- 记录排除项及原因
- 追加 `## 知识清单对照` 到 index.md

### LEARNING — 逐节点学习

详见 [references/learning-protocol.md](references/learning-protocol.md)。

每个节点的循环：准备 → 呈现 → Q&A → 沉淀 → 更新状态

### COMPLETED — 学习完成

- 更新 index.md 状态为 `completed`
- 更新 `USER.md` 已掌握概念
- 建议使用 `/hack <topic>` 或 `/review <topic>` 进行复习巩固

## 笔记文件模板

详见 [references/note-template.md](references/note-template.md)。
