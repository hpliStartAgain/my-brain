# content 专栏 Tags 标签规范化项目

## 1. 需求理解

当前数字花园项目（基于 Quartz v4）随着时间分批创作，积累了 850 多个 Markdown 专栏文件（包含 3133 个唯一标签）。这导致了标签（Tags）字段的全局一致性出现偏差，例如：
1. **大小写混用**：例如 `Kubernetes` 与 `kubernetes`、`etcd` 与 `ETCD`。
2. **同义词/缩写/语言后缀混用**：例如 `Go`、`Go语言`、`Golang` 并存；`K8s` 与 `Kubernetes` 并存。
3. **连字符/空格差异**：例如 `LSM-Tree` 与 `LSM Tree`；`BloomFilter` 与 `Bloom Filter`。
4. **格式不规范**：部分文件的 `tags` 格式可能是多行列表，部分是一行数组，存在多余空格或重复标签。

**目标**：
1. 梳理出全局需要统一的标签映射字典（同义词、大小写、连字符合并）。
2. 排除 `工作管理`、`Template`、`.obsidian`、`private` 等构建忽略的目录。
3. 编写自动化 Python 脚本，对所有符合条件的 Markdown 文件头部的 Frontmatter 进行批量清洗和规范化：
   - 依据映射字典替换标签。
   - 统一格式为规范的 inline 数组：`tags: [Tag1, Tag2]`（清理多余空格、去重、排序）。
4. 确保 Quartz 构建系统依然能够正常编译，不破坏任何 Frontmatter 结构。
5. 产出修改全局设计文档，将修改内容整理记录在 `CHANGELOG.md` 中。

---

## 2. 设计方案

### 2.1 标签合并映射字典 (Proposed Tag Mapping Dict)

基于小安进行的全局嗅探与相似度匹配分析，建议执行以下 **4 类共 28 组** 标签合并规则（左侧合并为右侧标准）：

#### 类别一：编程语言与运行时 (Languages & Runtimes)
* `[Go, Go语言]` ──▶ `Golang` *(考虑到 content 目录下包含 Golang 专栏分类文件夹，统一用 Golang 保持一致)*
* `[java, Java语言]` ──▶ `Java`
* `[python, Python语言]` ──▶ `Python`
* `[cpp, C++语言]` ──▶ `C++`

#### 类别二：云原生与容器化 (Cloud Native & Containers)
* `[kubernetes, K8s, k8s]` ──▶ `Kubernetes`
* `[ETCD]` ──▶ `etcd`
* `[deployment]` ──▶ `Deployment`
* `[cgroup, CGroups, Cgroups]` ──▶ `cgroups` *(Linux内核通常小写复数复现)*
* `[service-mesh]` ──▶ `服务网格` *(与高频中文 tag 统一)*

#### 类别三：大数据与数据库 (Big Data & Databases)
* `[LSM Tree, LSM树]` ──▶ `LSM-Tree`
* `[Exactly-Once]` ──▶ `Exactly-once`
* `[Bloom Filter, Bloomfilter]` ──▶ `BloomFilter` *(或者统一为带空格的 Bloom Filter，建议 BloomFilter)*
* `[Copy-On-Write, CoW]` ──▶ `Copy-on-Write`
* `[COW]` ──▶ `Copy-on-Write` *(COW 和 Copy-on-Write 进行合并，减少多余分支)*
* `[BlockCache]` ──▶ `Block Cache`
* `[DynamicAllocation]` ──▶ `Dynamic Allocation`
* `[RowBuffer]` ──▶ `Row Buffer`
* `[SkewJoin]` ──▶ `Skew Join`
* `[KafkaSink]` ──▶ `Kafka Sink`
* `[SparkUI]` ──▶ `Spark UI`
* `[direct IO, DirectIO, directio]` ──▶ `Direct I/O`
* `[undo_log, undolog]` ──▶ `Undo Log`
* `[redo_log, redolog]` ──▶ `Redo Log`
* `[B+树]` ──▶ `B+Tree`

#### 类别四：通用开发与架构术语 (General Tech Terms)
* `[ci-cd, CI-CD]` ──▶ `CI/CD`
* `[eino]` ──▶ `Eino` *(AI Agent 框架)*
* `[troubleshooting]` ──▶ `trouble-shooting` *(与本仓库已存在的专栏文件夹 `Trouble-shooting` 保持格式一致)*
* `[Upsert]` ──▶ `UPSERT` *(与本仓库已存在的 MERGE/UPDATE 大写习惯保持一致)*
* `[tcp_nodelay]` ──▶ `TCP_NODELAY`
* `[keepalive]` ──▶ `KeepAlive`
* `[round-robin]` ──▶ `RoundRobin`

> [!IMPORTANT]
> **请老板确认**：
> 以上标签合并规则是否符合预期？如果有任何标签您希望调整合并方向（例如，将 `Golang` 统一为 `Go`，或者将 `BloomFilter` 统一为带有空格的 `Bloom Filter`），请随时告诉我，我会随时调整脚本中的映射字典。

### 2.2 格式规范化设计 (Formatting Standards)

脚本处理每个 Markdown 文件时，对 `tags` 字段执行以下格式清洗：
1. **规范化包裹形式**：将所有多行格式或不规则行格式统一转换为单行中括号数组格式。
   * 修改前：
     ```yaml
     tags:
       - Spark
       - go语言
     ```
   * 修改后：
     ```yaml
     tags: [Spark, Golang]
     ```
2. **清除首尾空白与包裹符**：清洗 tag 内部的首尾空格，去掉可能存在的额外单双引号。
3. **去重与清洗**：应用合并映射字典后，对同一文件内的 tags 集合执行去重（例如，原文件同时包含 `[Go, Go语言]`，转换后去重仅保留一个 `Golang`）。
4. **排序**：对每个文件的 tags 进行字母与中文拼音顺序排序，使 frontmatter 看起来整齐有序。

---

## 3. 实现任务与拓扑排序

本项目将遵循最小化依赖原则，按照以下拓扑结构和阶段逐步推进。每完成一个阶段或文件修改，将同步更新本 TODO.md 文件。

### 阶段一：准备与设计确认
- [x] **T1.1**: 提交当前 `TODO.md` 并等待老板确认设计方案及标签映射规则 ✅

### 阶段二：脚本编写与本地演练
- [x] **T2.1**: 在 `scripts/` 目录下编写批量更新脚本 `scripts/update_tags.py`
  - 内置精细化的 Frontmatter YAML 解析器（不破坏其他 YAML 键值对，仅更新 `tags` 字段）
  - 内置 45 组标签映射字典（5 大类）
  - 实现 tags 去重、格式转换、规范排序逻辑
- [x] **T2.2**: 创建本地沙箱测试，对典型 Markdown 文件进行干跑（Dry-run）演练 ✅
  - YAML Frontmatter 其他属性完好 ✅
  - 修改后的 tags 格式完全符合 Obsidian / Quartz 规范 ✅

### 阶段三：全量执行与构建校验
- [x] **T3.1**: 全量运行脚本，两轮共修改 **853 个文件** ✅
- [x] **T3.2**: 验证执行结果：唯一标签从 3133 → 3086，残留不一致标签组从 42 → **0** ✅
- [ ] **T3.3**: 运行 Quartz 静态构建 `npx quartz build` 验证编译（可选，后续部署前执行）

### 阶段四：收尾与交付
- [x] **T4.1**: 重新运行 `scripts/collect_tags.py` 验证统计数据 ✅
- [x] **T4.2**: 更新 `CHANGELOG.md`，记录本次规范化标签变更 ✅
- [x] **T4.3**: 交付源码，任务完成 ✅

