# CHANGELOG

## 2026-05-06

- 更新 `vercel.json`，新增 `headers`、`rewrites` 与 `routes` 反爬配置：为 `tags`、`navigationIndex.json`、`searchIndex.json`、`index.xml` 增加 `X-Robots-Tag`，并在边缘直接拒绝一批已知 AI / scraper `User-Agent`。
- 更新 `quartz/plugins/emitters/folderPage.tsx`，为所有 folder list pages 注入 `robots=noindex,follow`，降低目录聚合页被低价值爬虫持续抓取的概率。
- 新增 `quartz/static/robots.txt`，并通过 Vercel rewrite 将根路径 `/robots.txt` 映射到静态产物，补齐守规矩爬虫的抓取约束入口。
- 更新 `quartz/plugins/emitters/contentIndex.tsx`，将原单一全文索引拆分为 `navigationIndex.json` 与 `searchIndex.json`，并为搜索正文增加长度裁剪能力。
- 更新 `quartz/components/renderPage.tsx`、`index.d.ts` 与 `globals.d.ts`，将页面级数据加载从 eager fetch 改为全局 memoized 的按需加载 helper。
- 更新 `quartz/components/scripts/search.inline.ts`，改为首次打开搜索时再加载搜索索引并构建 FlexSearch，降低非搜索访客的固定流量成本。
- 更新 `quartz/components/scripts/explorer.inline.ts`，改为使用轻量导航索引，并补充本地状态解析兜底、`checkVisibility()` 兼容处理与初始化异常保护，修复 Explorer 偶发不加载问题。
- 更新 `quartz/components/scripts/graph.inline.ts`，同步切换到轻量导航索引接口。
- 更新 `quartz.config.ts`，将搜索索引正文裁剪长度配置为 4000 字符。
- 更新 `quartz/plugins/emitters/tagPage.tsx`，为所有 tags 页面注入 `robots=noindex,follow`，减少大标签列表页被搜索引擎和低价值爬虫持续抓取。
- 验证结果：当前首屏仅加载 `navigationIndex.json`，冷访问固定传输约 0.17MB；首次实际使用搜索时，会额外加载约 2.96MB gzip 的 `searchIndex.json`。

## 2026-04-30

- 新增 `content/Linux/性能优化/12 Row Buffer 命中与 Bank 冲突——内存延迟抖动的硬件根因.md`，系统解释 Row Buffer Hit / Miss / Conflict、Bank 冲突与 Linux 内存延迟抖动之间的因果链。
- 新增 `content/Linux/性能优化/13 DDR 频率、时序与带宽——CAS、tRCD、tRP 到真实性能.md`，打通 DDR 频率、CL、tRCD、tRP、理论带宽与真实 workload 表现之间的关系。
- 新增 `content/Linux/性能优化/14 Linux 如何感知内存硬件——SMBIOS、EDAC、numactl 与 perf 观测链路.md`，梳理 SMBIOS、NUMA、EDAC / RAS 与 `perf` 的内存硬件观测链路。
- 新增 `content/Linux/性能优化/15 从内存硬件到调优策略——交错、绑定、页大小与压测方法.md`，将内存硬件认知映射到交错、绑定、页大小选择与压测验证方法。

## 2026-04-29

- 更新 `content/Linux/性能优化/00 专栏导览.md`，新增“内存硬件认知篇（规划中）”补强路线，规划 11-15 篇围绕 DIMM、Channel、Rank、Bank、Row Buffer、DDR 时序、Linux 硬件观测与调优落地的扩展文章。
- 新增 `content/Linux/性能优化/11 内存硬件全景——DIMM、Channel、Rank、Bank 与寻址层级.md`，系统讲解内存控制器、Channel、DIMM、Rank、Bank、Row Buffer 与 Linux 性能分析之间的关系，作为“内存硬件认知篇”的首篇正文。

## 2026-04-15

- 新增 `content/工作管理/Outbox-产出池/集群新特性/Dproxy迁移至七层网关（Apisix）/Dproxy迁移至七层网关（Apisix）落地方案.md`，输出 Dproxy 迁移至 SCLB 七层网关（APISIX）的完整落地方案。
- 更新 `TODO.md`，记录本次需求理解、设计方案与实施任务完成情况。
- 按用户反馈重写 Dproxy 方案文档结构，改为 `Knox高可用方案设计` 风格，并补充逐条服务器组、插件、路由与待验证入口清单。
- 补充 Dproxy 方案中的 Lua 插件落地细节，包含执行阶段、执行顺序、平台填写说明和示例 Lua 代码。
- 根据实际平台页面修正 Dproxy 方案：移除独立监听假设，并将路由配置改写为“路由规则表单字段填写版”。
- 基于七层网关 VIP `10.18.102.127` 补充 Dproxy 方案的即时验证清单，支持创建路由后立刻按 URL 校验是否生效。
- 基于平台“多路径”能力补充 Dproxy 路由合并设计，将推荐实施路由数从 52 条压缩到 23 条。
- 重写 Dproxy 落地方案为唯一可执行版本，删除中间推导稿与细粒度拆分稿，只保留最终实施所需的服务器组、插件、23 条路由和逐步验证步骤。
- 基于平台确认“七层仅支持 80/443”这一硬约束，废弃原七层接入方案，重写为 `SCLB 四层 + APISIX 双节点` 的可执行落地方案。
- 按最终确认的“80/443 + 路径前缀”方案重写 Dproxy 文档，统一到当前七层 VIP `10.18.102.127`，输出可直接施工的最终版配置与验证步骤。
- 新增 `content/工作管理/Ref-参考资料/集群智能运维/Eino开发相关/00 Eino Agent 开发资料导航.md`，汇总 Eino 官方文档、仓库和推荐阅读顺序。
- 新增 `content/工作管理/Ref-参考资料/集群智能运维/Eino开发相关/01 Eino AI Agent 开发指导手册.md`，沉淀面向 AI Agent / 编程 Agent 的架构选型、Tool 设计、HITL、middleware 与调试实践。
- 新增 `content/工作管理/Ref-参考资料/集群智能运维/Eino开发相关/02 Eino 版本演进与迁移提示.md`，整理 v0.5 ~ v0.8 的能力演进、不兼容变更与升级检查项。

## 2026-04-16

- 基于旧 dproxy 与新 VIP 的实测 `curl` 结果，重写 `content/工作管理/Outbox-产出池/集群新特性/Dproxy迁移至七层网关（Apisix）/Dproxy迁移至七层网关（Apisix）落地方案.md` 为“实测纠偏版”。
- 在纠偏版方案中明确：保留 `80/443 + 路径前缀` 总方向，但停止依赖平台表单中的“正则改写”，统一改为 Lua 插件 `plg-strip-ingress-prefix` 进行前缀剥离。
- 在方案中补充 2026-04-16 的真实验证结果，明确 `r-knox-allow` 当前失败根因是 `/knox` 前缀未剥离，且 `/timeline`、`/flink-hs`、`/realtime/logs`、`/tez-ui` 当前仍为 `404`。
- 更新 `TODO.md`，记录本次 Dproxy 文档实测纠偏任务的理解、设计和完成情况。
- 修正纠偏版方案中的 `plg-strip-ingress-prefix` Lua 实现：将错误的 `ngx.req.set_uri()` 改为 APISIX 正确的 `ctx.var.upstream_uri`，以确保真正改写回源 URI。
- 基于原始 `nginx -T`、Tez/ApplicationHistory 页面实际依赖路径、以及 APISIX wildcard 路由规则，重写 Dproxy 方案为“原 nginx 全量功能梳理 + SCLB 全量迁移矩阵”版本。

## 2026-04-20

- 新增 `content/工作管理/Inbox-Task池/集群新特性/TimelineServer高可用建设/ATS不可用对各类型作业真实影响验证.md`，拆分 ATS 不可用对 MR / Tez / Spark / Flink 真实影响的专项研究任务。
- 新增 `content/工作管理/Inbox-Task池/集群新特性/TimelineServer高可用建设/ATS与RM切换HA域名但NM未收口的影响验证.md`，拆分 ATS / RM 已切 HA 但 NM 未收口场景的影响验证任务。
- 更新 `content/工作管理/技术攻坚与前瞻研究.md`，将上述 2 个 ATS 研究任务加入待办看板。
- 新增 `content/工作管理/Outbox-产出池/集群新特性/TimelineServer高可用建设/ATS可用性影响与HA落地收益阶段性评估.md`，沉淀本轮关于 ATS 不可用真实影响、Tez 风险边界与 ATS HA 取舍的阶段性研究结论。
- 细化上述 2 个 ATS 研究任务的实验步骤、判定口径与实施记录模板，便于后续按 canary 方式逐步验证。
- 继续细化上述 2 个 ATS 研究任务，补充 MR / Tez / Spark / Flink 的命令草案、RM / NM 观测命令与结果回填建议。
