# CHANGELOG

本文件记录 my-brain 数字花园的重大内容变更。

## 2026-08-15

### 新增：Agent 沙箱技术专栏（content/LLM/Agent沙箱技术/）

基于 `work-management-1/30-知识库/技术学习/agent-sandbox` 的调研与实操素材（60+ 篇文档，覆盖威胁模型、隔离原语、虚拟化技术、OpenSandbox 架构/PoC/生产化、行业共识），分析 Agent 沙箱技术的框架体系与理论逻辑演进，整理/补充/扩写为符合本仓库交付标准（JVM 范文：篇均 13000 字/500+ 行）的完整专栏。

- **规模**：15 篇文章 + 1 篇导览，共 16 个文件，约 7700 行
- **结构**：根目录（00 导览、01 全景）+ 4 个子目录
  - `隔离原语/`（02-05）：Linux 隔离原语、四档隔离光谱、KVM 硬件虚拟化、VMM 家族解剖
  - `平台与协议/`（06-09）：六层模型与产品路线、OpenSandbox 架构/数据面/编排面三部曲
  - `工程实践/`（10-12）：部署实战（单机 PoC→测试集群）、三类 Agent 镜像化、性能工程
  - `生产化/`（13-15）：状态四本账、安全体系（三层防护/短期凭据/多租户）、十个盲区与行业共识
- **素材来源**：agent-sandbox 项目一手实操记录（PoC 47 步部署、三运行时基准、WarmPool 实测、源码走读）+ 2026 年公开资料（OpenSandbox 官方文档、InfoQ 分享、sigs agent-sandbox、行业 benchmark）

### 变更：旧专栏迁移

- 删除 `content/云原生/Agent沙箱与隔离技术/`（12 篇旧文章，篇均 6100 字，未达交付标准且缺 OpenSandbox 主线）
- 旧内容精华（namespaces/cgroups/seccomp/gVisor/Kata/Firecracker 等技术底稿）已并入新专栏 02-05 篇并深度扩写
- 更新 8 个外部引用文件（Coding-Agent运行范式 7 处、Hermes-Agent 2 处）的姊妹专栏链接指向

### 其他

- 根 TODO.md 追加并完成「Agent 沙箱技术专栏创作」任务章节
