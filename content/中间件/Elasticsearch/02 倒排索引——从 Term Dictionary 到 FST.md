---
title: "倒排索引——从 Term Dictionary 到 FST"
date: 2026-03-04
tags: [中间件, Elasticsearch, Lucene, 倒排索引, FST, Term Dictionary, Posting List, 分词, 全文搜索]
aliases: []
---

# 倒排索引——从 Term Dictionary 到 FST

## 摘要

倒排索引（Inverted Index）是全文搜索引擎的核心数据结构，也是 Elasticsearch 高效全文检索能力的基础。它的核心思想与正排索引（数据库中常见的"文档→字段→值"映射）相反：倒排索引构建的是"词（Term）→文档列表"的映射，使得给定一个查询词，能够以 O(1) 的复杂度找到所有包含该词的文档。但倒排索引的实现远比这个描述复杂——当词汇量达到数亿级别时，如何在有限内存中存储 Term Dictionary（词典）？如何在 Posting List（倒排列表）上高效执行交集、并集操作？[[Lucene]] 的答案是 **FST（Finite State Transducer，有限状态转换器）** 词典 + **Frame Of Reference（FOR）** 压缩 Posting List + **Roaring Bitmap** 跳跃结构——三者组合，实现了在内存极度受限的条件下，亚毫秒级的全文检索响应。

---

## 第 1 章 倒排索引的基本结构

### 1.1 正排索引与倒排索引的对比

理解倒排索引，最好从它要解决的问题出发：**给定一个词，快速找到所有包含这个词的文档**。

假设有三篇文档：
```
文档 1：Elasticsearch is a distributed search engine
文档 2：Kafka is a distributed messaging system
文档 3：Elasticsearch supports full text search
```

**正排索引**（行存储，数据库 B+ 树的方向）：
```
DocID → 文档内容
1     → "Elasticsearch is a distributed search engine"
2     → "Kafka is a distributed messaging system"
3     → "Elasticsearch supports full text search"
```

正排索引擅长的是：给定 DocID，快速获取文档内容。但如果要回答"哪些文档包含 `distributed` 这个词"，必须全表扫描，逐篇检查，时间复杂度 O(N)——当文档数达到千万级别时，这是不可接受的。

**倒排索引**（反转映射，Term → DocID 列表）：
```
Term             → DocID 列表
"a"              → [1, 2]
"distributed"    → [1, 2]
"elasticsearch"  → [1, 3]
"engine"         → [1]
"full"           → [3]
"is"             → [1, 2]
"kafka"          → [2]
"messaging"      → [2]
"search"         → [1, 3]
"supports"       → [3]
"system"         → [2]
"text"           → [3]
```

查询"distributed"？直接在 Term Dictionary 中找到 `distributed`，对应的 DocID 列表是 `[1, 2]`——这两篇文档包含该词。时间复杂度：词典查找 O(log N) + 取列表 O(1)，远优于全表扫描。

查询"elasticsearch AND search"（布尔 AND）？取 elasticsearch 的列表 `[1, 3]` 与 search 的列表 `[1, 3]` 求交集 → `[1, 3]`。

### 1.2 倒排索引的三个核心组件

实际的倒排索引并不只是上面的简单映射，还包含更丰富的信息：

**Term Dictionary（词典）**：所有不重复词（Term）的有序集合，支持精确查找和前缀查找。这是倒排索引的"索引的索引"——先在 Term Dictionary 中找到词，再找到对应的 Posting List。

**Posting List（倒排列表）**：每个 Term 对应的文档 ID（DocID）列表，以及可选的附加信息：
- **词频（Term Frequency，TF）**：该词在文档中出现的次数，用于相关性评分；
- **位置信息（Position）**：词在文档中的位置（第几个词），用于短语查询（phrase query）；
- **偏移量（Offset）**：词在原始文本中的字节偏移，用于高亮显示。

**Term Dictionary 的索引（Term Index）**：Term Dictionary 本身也可能非常大（数百 MB），无法全量加载内存。Term Index 是 Term Dictionary 的稀疏前缀索引，存储在内存中，用于快速定位某个 Term 在磁盘上的 Term Dictionary 中的位置。

---

## 第 2 章 分词：文本到 Term 的转换

### 2.1 分析器（Analyzer）的作用

在构建倒排索引之前，文档的文本字段需要经过**分析（Analysis）**处理——将原始字符串转换为一系列 Term（也叫 Token）。分析过程由**分析器（Analyzer）**完成，分析器由三个组件串联：

**Character Filter（字符过滤器）**：对原始文本进行字符级别的预处理，如去除 HTML 标签（`<b>text</b>` → `text`）、将全角字符转换为半角等。

**Tokenizer（分词器）**：将文本切分成 Token 序列。这是分析器最核心的部分，不同语言有不同的分词策略：
- 英文：按空格和标点切分（Standard Tokenizer）；
- 中文：按词语切分（IK Analyzer、Jieba 等中文分词器）；
- 特殊字段（邮件、路径）：按特定分隔符切分。

**Token Filter（词元过滤器）**：对 Token 进行进一步处理：
- **Lowercase**：统一转换为小写，使搜索大小写不敏感；
- **Stop Words**：去除停用词（"a"、"the"、"is"等无意义词），减小索引体积；
- **Stemming（词干提取）**：将词还原为词根形式（"running"→"run"，"distributed"→"distribut"），使"run"和"running"能匹配同一文档；
- **Synonym（同义词扩展）**：将同义词映射到相同 Token，使搜索"快递"也能找到包含"物流"的文档。

分析器的配置是 ES 索引设计中最重要的决策之一——选错分析器会导致搜索结果质量极差（如中文文档用英文分词器，每个汉字作为独立 Token，无法按词语搜索）。

### 2.2 标准分析器的处理示例

```
原始文本：  "The Quick Brown Fox Jumps Over the Lazy Dog"
Tokenizer：  ["The", "Quick", "Brown", "Fox", "Jumps", "Over", "the", "Lazy", "Dog"]
Lowercase：  ["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"]
Stop Words： ["quick", "brown", "fox", "jumps", "over", "lazy", "dog"]
            （去除了 "the"）
```

最终写入倒排索引的 Term 是过滤后的词列表。查询时，查询文本也经过**相同的分析器**处理——这保证了查询词与索引中的 Term 具有相同的形式，才能正确匹配。

> [!warning] 生产避坑：查询分析器与索引分析器不一致
> ES 允许为字段配置不同的 `analyzer`（索引时）和 `search_analyzer`（搜索时）。如果两者不一致，可能导致索引时写入的 Term 和搜索时生成的 Term 形式不同，搜索无结果。常见错误：索引时用了 Stemming 分析器（`running` → `run`），搜索时用了不带 Stemming 的分析器（搜索 `running` 生成 Term `running`），与索引中的 `run` 无法匹配。

---

## 第 3 章 Term Dictionary 的存储：FST 的设计原理

### 3.1 从 Hash 到 Sorted Map，再到 FST

**最简单的实现——Hash Map**：将 Term → Posting List 的 Offset 存储在 Hash Map 中。查找速度是 O(1)，但 Hash Map 有几个问题：
- **不支持前缀查询**：无法高效查找所有以 "elast" 开头的词（前缀查询是搜索引擎的常见需求）；
- **内存占用大**：每个 Term 需要存储完整字符串，词汇量大时内存消耗惊人（数亿文档的索引可能有数千万不同 Term）；
- **不支持范围查询**：无法高效查找字典序在某个范围内的所有词。

**更好的选择——有序 Term Dictionary + 二分查找**：将所有 Term 排序后存储，支持二分查找（O(log N)）和前缀查询、范围查询。但内存问题仍然存在——一个有 1000 万个 Term 的词典，每个 Term 平均 10 字节，就需要 100MB 的内存。

**Lucene 的选择——FST（Finite State Transducer）**：FST 是一种有限状态机，它通过**共享前缀和后缀**来极大压缩 Term 的存储空间：

FST 的核心思想：与 Trie 树（前缀树）类似，FST 通过共享公共前缀来节省空间，但 FST 还能共享**公共后缀**——这是普通 Trie 树做不到的。例如，"mop"、"top"、"stop" 这三个词在 FST 中，"op" 这个后缀只存储一次，被多个路径共享。

**FST 的存储示例**（简化版）：

```
词典：{cat: 5, cats: 6, catfish: 7, fish: 8}

FST 结构（有向无环状态机）：
初始状态
  ├── 'c' → 状态A
  │         ├── 'a' → 状态B
  │         │         ├── 't' → 状态C (输出: 5, 是接受状态)
  │         │         │         ├── 's' → 状态D (输出: 6, 是接受状态)
  │         │         │         └── 'f' → 状态E → 'i' → 's' → 'h' → 状态F (输出: 7)
  └── 'f' → 状态G
            ├── 'i' → 'S' → 'h' → 状态H (输出: 8)

注意：'ish' 这段路径在 catfish 和 fish 中被共享（通过不同路径到达相同子状态）
```

FST 相比 Hash Map 的优势：
- **极大压缩内存**：通过前缀/后缀共享，Lucene 的 FST 词典通常只占用 Hash Map 的 1/10 内存（甚至更少）；
- **支持前缀查询**：按字典序遍历 FST 即可找到所有有某个前缀的 Term；
- **完全有序**：FST 本身就是有序结构，支持范围查询；
- **可以完全加载内存**：节省的内存使得整个 Term Dictionary 的 FST 索引可以常驻内存，查找不需要磁盘 IO。

### 3.2 FST 在 Lucene 中的实际角色

Lucene 使用 FST 作为 **Term Index**——不是直接存储每个 Term 到 Posting List 的映射，而是存储 Term 到 Term Dictionary 磁盘块的映射。Term Index（FST）常驻内存，Term Dictionary 本体存储在磁盘上，通过 Term Index 定位后，只需一次磁盘 IO 就能找到目标 Term。

整个查询的 Term 定位流程：

```
查询词 "elasticsearch"
   ↓
在内存的 FST（Term Index）中查找
   ↓
找到 "elasticsearch" 对应的 Term Dictionary 磁盘块偏移量
   ↓
读取磁盘上对应的 Term Dictionary 块（约 4KB）
   ↓
在块中精确找到 "elasticsearch" 的 Posting List 偏移量
   ↓
读取 Posting List
```

---

## 第 4 章 Posting List 的压缩：FOR 与 Roaring Bitmap

### 4.1 Posting List 的存储挑战

假设 "elasticsearch" 这个词出现在 100 万篇文档中（DocID 范围是 0 到 1 千万），它的 Posting List 包含 100 万个 DocID。直接存储 100 万个 32 位整数需要 4MB——如果词典中有数万个高频词，Posting List 的总体积可能达到数十 GB。

ES/Lucene 通过两个数据结构来压缩 Posting List：

### 4.2 Frame Of Reference（FOR）压缩

**FOR** 的核心思想是**差值编码（Delta Encoding）** + **分块变长编码**：

**步骤一：差值编码**

DocID 是有序整数，相邻 DocID 的差值（Delta）通常远小于 DocID 本身：

```
原始 DocID：[10, 15, 20, 35, 100, 101, 102, ...]
Delta 编码：[10, 5,  5,  15, 65,  1,   1,  ...]
```

差值通常是小整数，存储小整数比存储大整数需要更少的位。

**步骤二：分块（Frame）**

将 Delta 序列按每 128 个为一块，在块内找到最大的 Delta 值，用能表示该最大值的最少位数（如 4 位）来存储块内所有 Delta。块头存储"每个 Delta 用几位"这一信息。

```
块示例：[5, 5, 15, 5, 3, ...]（最大值 15 需要 4 位）
块头：bit_width = 4
存储：4位×128个 = 64 字节（而非 4 字节×128个 = 512 字节）

压缩率：8倍
```

FOR 压缩对于**稀疏的 Posting List**（DocID 差值大）效果较好，但对于高频词（DocID 非常密集，差值接近 1）可能压缩率有限。

### 4.3 Roaring Bitmap：密集 Posting List 的利器

**Roaring Bitmap** 是另一种 Posting List 压缩结构，特别适合**高频词**（文档覆盖率高，如停用词或分析后常见词）。

Roaring Bitmap 将 32 位 DocID 空间（0 到 2^32-1）按高 16 位分成 2^16 = 65536 个桶（Chunk），每个桶管理该范围内的 DocID：

- **稀疏桶**（DocID 数量 < 4096）：用 short 数组存储（每个 DocID 2 字节）；
- **密集桶**（DocID 数量 ≥ 4096）：用 Bitmap 存储（65536 个位，每位代表一个 DocID 是否存在，固定 8KB）。

```
高 16 位分桶：
桶 0 (DocID 0-65535):    如果有 5000 个 DocID → 用 Bitmap（5000 > 4096）
桶 1 (DocID 65536-131071): 如果有 100 个 DocID  → 用 Array（100 < 4096）
...
```

Roaring Bitmap 的核心优势是**自适应**：根据数据密度自动选择最优的底层存储结构，同时支持高效的集合操作（AND/OR/NOT）——两个 Bitmap 的 AND 操作就是各对应桶的 Bitmap AND 操作，可以用 SIMD 指令加速，性能极高。

**Lucene 的实际选择**：Lucene 4.x 开始使用 Roaring Bitmap 优化压缩 Posting List，ES 查询时的布尔操作（AND/OR/NOT）在 Roaring Bitmap 上执行，性能远超朴素的 DocID 列表遍历。

---

## 第 5 章 BKD Tree：数值与地理字段的索引

### 5.1 数值字段为什么不用倒排索引

倒排索引对于文本字段效果极佳，但对于**数值字段的范围查询**（如 `price > 100 AND price < 500`）效率较低：

如果将 `price=150` 作为 Term 写入倒排索引，查询 `price > 100 AND price < 500` 需要找出所有 price 在 100-500 之间的 Term（可能是 400 个不同值），再对这 400 个 Posting List 求并集——这是 400 次 Posting List 读取和合并操作，性能很差。

### 5.2 BKD Tree：空间划分的多维索引

Lucene 6.0（ES 5.x）引入 **BKD Tree（Block KD-Tree）** 来索引数值和地理坐标字段。

**KD Tree（K 维树）** 是一种将 K 维空间递归二分的数据结构，适合多维点数据的范围查询和最近邻查询。BKD Tree 是 KD Tree 的磁盘友好版本，将数据分块存储，适合大数据量场景。

对于一维数值（如 `price`），BKD Tree 退化为一维的有序区间树，范围查询只需找到覆盖该范围的叶节点，直接返回对应的 DocID 集合。对于二维地理坐标（经纬度），BKD Tree 支持高效的矩形范围查询和圆形范围查询（地理距离查询）。

ES 中所有 `integer`、`long`、`float`、`double`、`geo_point` 类型字段默认使用 BKD Tree 索引，而非倒排索引——这解释了为什么 ES 的数值范围查询通常比纯文本查询更快。

---

## 总结

本篇深入剖析了 Elasticsearch 倒排索引的完整技术栈：

**倒排索引基础**：Term → DocID 列表的映射，将全文检索从 O(N) 扫描降低到 O(log N) 词典查找 + O(1) 列表访问。包含 TF（词频）、Position（位置）、Offset（偏移）等附加信息。

**分词管道**：Character Filter → Tokenizer → Token Filter，将文本转换为标准化 Term。分析器选型（特别是中文分词）是影响搜索质量最关键的配置决策。

**FST 词典**：通过共享前缀和后缀极大压缩 Term Dictionary 的内存占用（通常为 Hash Map 的 1/10），同时支持前缀查询和范围查询。FST 常驻内存，使 Term 定位只需一次磁盘 IO。

**Posting List 压缩**：FOR（差值编码 + 分块变长）适合稀疏列表；Roaring Bitmap（分桶自适应 Array/Bitmap）适合密集列表，且支持 SIMD 加速的集合操作。

**BKD Tree**：数值和地理字段的专用索引结构，解决了倒排索引在范围查询上的效率瓶颈。

下一篇深入文档的完整写入链路与 Lucene Segment 的合并机制：[[03 文档写入与段合并——Segment、Refresh 与 Merge]]。

---

> [!note] 参考资料
> - Mike McCandless 博客（Lucene 核心贡献者）
> - 《Elasticsearch: The Definitive Guide》, Chapter: Inside a Shard
> - 论文：《Roaring Bitmaps: Implementation of an Optimized Software Library》
> - Lucene 源码: `org.apache.lucene.codecs.lucene90`
