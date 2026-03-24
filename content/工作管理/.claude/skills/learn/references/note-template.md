# 笔记文件模板

本文件定义每个学习节点沉淀后的笔记文件结构，基于 Kafka 学习中 8 个笔记文件的一致模式。

---

## 一、YAML Metadata

```yaml
---
title: NN · <中文或英文标题>
type: note
topic: <topic>
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: completed
tags: [topic, specific-tag-1, specific-tag-2]
---
```

字段说明：
- `title`：编号 + 标题，如 `03 · 存储设计`、`05 · Replication`
- `type`：固定为 `note`
- `topic`：与 index.md 的 `topic` 字段一致
- `tags`：第一个 tag 是 topic 名，后续 tag 是本节点涉及的具体概念

---

## 二、文件结构

```markdown
# NN · <标题>

> **目标**：<一句话说清学完这个节点能理解什么>

---

## 一、<第一个主要概念>

<内容>

---

## 二、<第二个主要概念>

<内容>

---

## N、<第 N 个主要概念>

<内容>

---

## 参考材料

1. **<来源名称>**：<URL>
2. **<来源名称>**：<URL>
```

---

## 三、内容写法规则

### 一句话目标

用 blockquote + 粗体格式。必须具体到"能解释/能理解/能分析什么"，不能写"了解 X"。

好的示例：
> **目标**：理解 Kafka 的四个核心抽象及其关系，能画出消息从 produce 到 consume 的完整路径

坏的示例：
> **目标**：了解 Kafka 基础概念

### 分节

- 使用中文数字编号：`## 一、`、`## 二、`、`## 三、`
- 每节之间用 `---` 分隔
- 每节聚焦一个核心概念或一个紧密相关的概念组

### 概念讲解

每个概念按以下结构组织（不需要显式标注这些标签，自然融入行文）：

1. **定义**：一两句话说清是什么
2. **为什么存在**：解决什么问题
3. **怎么工作**：核心机制或流程
4. **设计取舍**：为什么选这种方案，代价是什么
5. **注意事项**：常见误解、容易搞混的点

### 对比表格

凡是涉及取舍或多选方案的地方，使用表格：

```markdown
| 维度 | 方案 A | 方案 B |
|------|--------|--------|
| 特点 | ... | ... |
| 适用场景 | ... | ... |
```

### ASCII 图

架构关系、数据流、组件交互使用 ASCII 图：

```
Producer → Broker（写入 partition log）→ Consumer（pull 读取）
```

```
Controller Quorum
├── Active Controller（处理写入）
├── Follower Controller
└── Follower Controller
```

### 具体示例

抽象概念必须配具体示例。优先使用贴近真实业务的场景：

```markdown
例：用 order_id 作为 key，同一订单的"创建、支付、发货"三个事件全在同一个 partition，
消费者按顺序读就能拿到完整的状态变更序列。
```

### 纠错内容的融入

Q&A 中发现的易错点融入正文，而不是保留问答格式：

```markdown
**注意：ISR 中的 follower 不意味着数据是"最新的"，只意味着"没有落后超过阈值"。**
ISR 保证的是"如果 leader 挂了，这些 follower 的数据丢失量在可接受范围内"，
而不是"数据和 leader 完全一致"。
```

---

## 四、参考材料规则

- 放在文件最后
- 使用有序列表
- 每条格式：`**<来源名称>**：<URL>`
- 链接必须是验证过可访问的
- 优先使用带版本号的官方文档链接（如 `kafka.apache.org/42/design/design/` 而不是 `kafka.apache.org/documentation/`）
- 如果某个链接无法验证（WebFetch 失败），标注"（未验证）"

---

## 五、内容语言规则

- 正文使用中文
- 技术术语保留英文原文：partition、offset、consumer group、replication、ack 等
- 首次出现的术语加粗并给出中文解释
- 配置项、命令、代码保持原样：`acks=all`、`enable.idempotence=true`
- 不需要中英双语对照，直接用中文写，术语自然嵌入
