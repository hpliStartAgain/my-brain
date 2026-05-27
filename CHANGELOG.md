# CHANGELOG

## [2026-05-26] 补写《分布式架构的困难之处》专栏第 02、03 篇

### 背景

继续完善“分布式架构的困难之处”系列，将“[[架构量子（Architecture Quantum）]]”与“[[静态耦合]]”两篇核心方法论文章补齐，作为后续动态耦合、Saga、数据所有权等主题的分析基础。

### 变更内容

- 新增 `content/分布式/分布式架构的困难之处/02 架构量子——给耦合一把尺子.md`
- 新增 `content/分布式/分布式架构的困难之处/03 静态耦合——架构的连线图.md`
- 两篇文章均补齐 Quartz frontmatter、专栏导航、Obsidian wiki-links、Mermaid 图、Callout、对比表格
- 内容围绕中型电商系统案例展开，覆盖架构量子定义、量子数分析、静态量子图、共享数据库、配置中心、Kafka Topic、渐进式解耦策略等主题

## [2026-05-26] 翻译《Software Architecture: The Hard Parts》全书

### 背景

将 O'Reilly 经典分布式架构著作《Software Architecture: The Hard Parts》(Neal Ford, Mark Richards, Pramod Sadalage & Zhamak Dehghani, 2022) 完整翻译为中文，作为数字花园软件架构领域的基石内容。

### 变更内容

- **全书翻译**：前言 + 15章正文 + 3个附录，共 19 个文件，约 10.6 万英文词
- **图片提取**：从 PDF 提取 281 张图片，按章节重命名（chXX-figYY 格式），使用 Obsidian 相对路径引用（`![[images/chXX-figYY.png]]`）
- **图片处理**：与 JVM 性能工程书不同，本书图片不转换为 Mermaid，直接从 PDF 提取后以附件形式插入对应位置
- **目标目录**：`content/分布式/Software Architecture The Hard Parts/`
- **Quartz 构建**：通过验证（exit code 0）

### 全书结构

| 部分 | 章节 | 英文词数 |
|------|------|---------|
| 前言 | Preface | 2,040 |
| 第一部分：拆解 | Ch1-7（无最佳实践/耦合/模块化/分解/组件分解模式/操作数据/服务粒度） | ~55,800 |
| 第二部分：重新组合 | Ch8-15（复用/数据所有权/分布式数据访问/工作流/事务性Saga/契约/分析数据/权衡分析） | ~48,400 |
| 附录 | A/B/C（概念参考/ADR参考/权衡参考） | ~6,400 |

### 翻译标准

- 只增加信息，不删减任何内容
- 英文术语首次出现时括号标注原文
- 代码块、表格、列表格式完整保留
- 原书 Sysops Squad 故事线全部翻译

## [2026-05-25] Tags 全局规范化清洗

### 背景

数字花园内容（`content/`）随着时间分批创作，积累了大量标签（Tags），导致相同语义的标签出现多种不一致的表达形式（大小写混用、同义词并存、连字符/空格差异），使得文章无法通过 Tags 建立有效的双向连接。

### 变更内容

- **全量扫描**：扫描 `content/` 目录下 1031 个 Markdown 文件（排除 `工作管理`、`Template`、`.obsidian`、`private` 等 Quartz 构建忽略目录）
- **修改文件数**：共计修改 **853 个文件**（837 + 16 两轮）
- **唯一标签数**：从 **3133** 个减少至 **3086** 个（合并去重约 47 个冗余标签）
- **残留不一致标签组**：从 **42 组** 清零至 **0 组** ✅

### 规范化规则（共 5 大类）

#### 类别一：编程语言与运行时
| 原标签 | 规范化为 |
|--------|---------|
| `Go`, `Go语言` | `Golang` |
| `java`, `java语言` | `Java` |
| `python语言` | `Python` |
| `cpp`, `C++语言` | `C++` |

#### 类别二：云原生与容器化
| 原标签 | 规范化为 |
|--------|---------|
| `kubernetes`, `K8s`, `k8s` | `Kubernetes` |
| `ETCD` | `etcd` |
| `deployment` | `Deployment` |
| `cgroup`, `CGroups` | `cgroups` |
| `service-mesh` | `服务网格` |

#### 类别三：大数据与数据库
| 原标签 | 规范化为 |
|--------|---------|
| `LSM Tree`, `LSM树` | `LSM-Tree` |
| `Exactly-Once` | `Exactly-once` |
| `Bloom Filter`, `Bloomfilter` | `BloomFilter` |
| `Copy-On-Write`, `CoW`, `COW` | `Copy-on-Write` |
| `BlockCache` | `Block Cache` |
| `DynamicAllocation` | `Dynamic Allocation` |
| `RowBuffer` | `Row Buffer` |
| `SkewJoin` | `Skew Join` |
| `KafkaSink` | `Kafka Sink` |
| `SparkUI` | `Spark UI` |
| `DirectIO`, `direct IO` | `Direct I/O` |
| `undo_log`, `undolog` | `Undo Log` |
| `redo_log`, `redolog` | `Redo Log` |
| `B+树` | `B+Tree` |

#### 类别四：通用开发与架构术语
| 原标签 | 规范化为 |
|--------|---------|
| `ci-cd`, `CI-CD` | `CI/CD` |
| `eino` | `Eino` |
| `troubleshooting` | `trouble-shooting` |
| `Upsert` | `UPSERT` |
| `tcp_nodelay` | `TCP_NODELAY` |
| `keepalive` | `KeepAlive` |
| `round-robin` | `RoundRobin` |

#### 类别五：大小写规范化（首字母/全大写）
| 原标签 | 规范化为 |
|--------|---------|
| `WATCH` | `Watch` |
| `Socket` | `socket` |
| `bridge` | `Bridge` |
| `profiling` | `Profiling` |
| `Failover` | `failover` |
| `append` | `Append` |
| `benchmark` | `Benchmark` |
| `collection` | `Collection` |
| `Merge` | `MERGE` |
| `refresh` | `Refresh` |
| `seccomp` | `Seccomp` |
| `skiplist` | `SkipList` |
| `span` | `Span` |
| `string` | `String` |
| `trace` | `Trace` |
| `Update` | `UPDATE` |
| `watch机制` | `Watch机制` |

### 格式规范化

同时对所有文件的 `tags` 字段执行格式统一：
- 多行 YAML 列表格式 → 单行内联数组格式：`tags: [Tag1, Tag2, Tag3]`
- 清除 tag 内部首尾空格和多余引号
- 对同一文件内重复出现的 tag 执行去重
- 对 tags 列表进行字母排序（ASCII + 中文）

### 新增工具脚本

- `scripts/collect_tags.py`：扫描全站 Markdown 文件，提取并统计所有唯一标签，输出 `scratch/tags_report.json`
- `scripts/analyze_similarity.py`：基于归一化算法识别潜在不一致标签组，输出 `scratch/tag_groups.json`
- `scripts/update_tags.py`：批量清洗工具，支持 `--dry-run` 预览和 `--file` 单文件模式，安全执行标签规范化
