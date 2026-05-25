# CHANGELOG

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
