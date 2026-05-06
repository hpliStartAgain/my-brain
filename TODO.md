# 极简前端改造 (Minimalism UI Refactor)

## 2026-05-06 Quartz 反爬硬化与异常流量收敛

### 需求理解

- [x] 最近 30 天 Vercel Outgoing 已达到 77.29GB，且多日存在 10GB~15GB 的突刺，已明显超出正常人类访问模式。
- [x] 现有带宽优化虽然降低了首屏固定传输，但仍不足以约束恶意抓取和 AI 训练型爬虫的持续请求。
- [x] 本轮目标是在不破坏正常用户访问和搜索引擎索引的前提下，提高站点对低价值爬虫与已知 AI 抓取 UA 的阻断能力。

### 设计方案

- [x] 在 `vercel.json` 中补充基于 `routes + mitigate.deny` 的边缘阻断规则，直接拒绝一批已知 AI / scraper `User-Agent`。
- [x] 在 `vercel.json` 中为高成本资源增加 `X-Robots-Tag`，减少守规矩爬虫对标签页、索引文件和 RSS 的重复抓取。
- [x] 新增 `robots.txt`，对守规矩爬虫声明禁止抓取 `tags`、搜索索引、导航索引与站点索引 XML。
- [x] 给 folder list pages 注入 `robots=noindex,follow`，降低目录聚合页被低价值爬虫反复命中的概率。
- [x] 使用 Vercel rewrite 将根路径 `/robots.txt` 映射到 Quartz static emitter 产出的 `/static/robots.txt`，绕过 Quartz 默认只能复制到 `/static` 的限制。

### 任务拆解

- [x] 修改 `vercel.json`，新增 `$schema`、`headers`、`rewrites` 与 `routes` 反爬规则。
- [x] 修改 `quartz/plugins/emitters/folderPage.tsx`，为 folder list pages 注入 `<meta name="robots" content="noindex,follow" />`。
- [x] 新增 `quartz/static/robots.txt`，声明全站 robots 规则与针对典型 AI bots 的 `Disallow: /`。
- [x] 运行构建，确认 `public/static/robots.txt` 已生成，folder/tag 页面产物包含 `noindex,follow`。
- [x] 复查重点高成本资源体积：当前 `public/static/searchIndex.json` 约 8366.5KB 原始体积、2964.9KB gzip；`public/tags.html` 约 5819.2KB 原始体积、600.9KB gzip。
- [x] 更新 `CHANGELOG.md` 记录本次交付。

### 平台侧待执行

- [ ] 进入 Vercel Dashboard -> Firewall -> Bot Management，手动开启 Attack Challenge Mode，作为代码规则之外的即时止血措施。
- [ ] 上线后观察 Firewall / Traffic 面板 24~48 小时，确认被 deny/challenge 的 UA 是否与预期一致，再决定是否继续扩展 UA 黑名单。

## 2026-05-06 Quartz 带宽优化与 Explorer 稳定性修复

### 需求理解

- [x] 当前站点部署在 Vercel 免费额度，Fast Data Transfer 已达到 75%，需要从根因上降低静态文本传输量。
- [x] 已确认当前瓶颈不是 Explorer 的折叠策略，而是页面级预埋的全站全文索引加载；同时 Explorer 存在“偶发加载不出来”的稳定性问题。
- [x] 本次改造目标包括：降低非搜索访客的固定流量成本、保留站内搜索能力、并提升 Explorer 初始化稳定性。

### 设计方案

- [x] 将当前单一 `contentIndex.json` 拆分为“轻量导航索引 + 搜索索引”，让 Explorer/Graph 不再依赖全文正文。
- [x] 将页面级 `fetchData` 改为全局 memoized 的按需加载函数，避免所有页面首屏立即拉取大索引。
- [x] 将 Search 改为首次打开时再拉取搜索索引并构建 FlexSearch，而不是在每次 `nav` 事件时预热。
- [x] 对 Explorer 增加浏览器兼容与异常兜底，修复 `checkVisibility()` 导致的潜在初始化失败。

### 任务拆解

- [x] 修改 `quartz/plugins/emitters/contentIndex.tsx`，输出导航索引与搜索索引。
- [x] 修改 `quartz/components/renderPage.tsx`，注入按需加载数据的全局 helper，而不是 eager fetch。
- [x] 修改 `quartz/components/scripts/search.inline.ts`，改为首次打开时加载搜索索引并建索引。
- [x] 修改 `quartz/components/scripts/explorer.inline.ts`，切换到导航索引并增强失败兜底。
- [x] 调整 `quartz/components/scripts/graph.inline.ts` / `globals.d.ts` / `index.d.ts` 以适配新的数据获取接口。
- [x] 在 `quartz.config.ts` 中为搜索索引增加正文长度裁剪，当前设为 4000 字符。
- [x] 运行构建与浏览器验证，确认首屏仅加载导航索引，搜索首次打开才加载搜索索引，Explorer 可正常懒展开。
- [x] 为 `tags` 页面注入 `robots: noindex,follow`，降低大标签页被搜索引擎与低价值爬虫反复抓取的概率。
- [x] 运行仓库级 `npm run check`，确认无新增 TypeScript 错误；当前仍有仓库既有的 Prettier 警告未在本次范围内处理。
- [x] 更新 `CHANGELOG.md` 记录本次交付。

## 任务拆解与设计方案

### 阶段一：重构系统级色彩与Typography基准 (`quartz.config.ts`) (✅ 已完成)

- [x] **重定义 lightMode/darkMode 配色**：剥离色彩，转为极其克制的纯黑、纯白与灰阶。
- [x] **重塑字体配置**：将所有文字（Header/Body）统一为结构极简的 `Inter`（无衬线现代字体），仅保留代码区的 `JetBrains Mono`。

### 阶段二：重塑基础组件的质感与克制交互 (`quartz/styles/custom.scss`) (✅ 已完成)

- [x] **全局排版去噪**：消除块状阴影、圆角（改用直角或极小圆角），全局采用直白的空间和 1px 细线。
- [x] **链接与可交互元素**：去除高亮背景，回归文本原有的链接形态；只利用透明度过渡和简单的黑白线条翻转。
- [x] **卡片与容器**：将带背景颜色的卡片（如目录、弹窗等悬浮体）设为透明背景 + 细边框控制。
- [x] **线条与结构**：所有引导线（包括引用块、分割线、左侧目录树等）彻底压细，只起空间划分作用而不占视觉权重。

## 2026-04-15 Dproxy 七层网关迁移落地方案

### 需求理解

- [x] 读取任务文件 `content/工作管理/Inbox-Task池/集群新特性/Dproxy七层网关迁移.md`。
- [x] 读取参考资料目录 `content/工作管理/Ref-参考资料/集群新特性/Dproxy迁移至七层网关（Apisix）/`，梳理已有方案与已确认事项。
- [x] 基于当前 dproxy 的真实 `nginx -T` 配置，产出一份面向实施的完整迁移方案，而不是停留在原理介绍。
- [x] 方案需覆盖：现网功能梳理、SCLB/APISIX 对等实现、服务组与路由规划、插件规划、日志可用性验证、DNS 换绑、风险与回滚。
- [x] 方案默认读者对 Nginx / APISIX 了解较少，因此需补充必要科普，但不偏离实施重点。

### 设计方案

- [x] 采用“零改造优先”的设计：优先保持 `dproxy.venus.sohurdc.com` 及原端口语义不变，先完成能力平移，再考虑端口收敛与架构优化。
- [x] 将 dproxy 能力拆成四类分别设计：Knox 代理、Timeline/ATS 代理、Flink History 代理、Tez UI 静态资源代理。
- [x] 明确哪些能力可以直接用 APISIX 内置路由/重写完成，哪些能力需要平台侧自定义插件。
- [x] 对静态资源类能力（`8823`/`8824`）单独标注迁移前置条件：SCLB/APISIX 负责路由，不负责替代本地文件系统静态托管。

### 任务拆解

- [x] 梳理 dproxy 当前监听端口、后端、路由规则、403 拦截点、重写点、头注入点。
- [x] 设计 SCLB 七层网关上的监听、服务器组、路由、插件与健康检查方案。
- [x] 设计测试验证清单，重点覆盖 `applicationhistory/logs/...`、containerlogs、jobhistory、sparkhistory、tez timeline 等关键路径。
- [x] 设计域名切换与回滚步骤，确保切换失败时能快速回退到旧 dproxy IP。
- [x] 在 `content/工作管理/Outbox-产出池/集群新特性/Dproxy迁移至七层网关（Apisix）/` 输出正式方案文档。
- [x] 新增 `CHANGELOG.md` 记录本次文档交付。
- [x] 根据用户反馈，将文档重构为 `Knox高可用方案设计` 风格的实施手册，前置结论表，并给出逐条路由/服务器组/插件配置。
- [x] 补充自定义 Lua 插件的执行阶段、执行顺序、平台填写方式与示例代码。
- [x] 根据平台实际表单模型，去除“监听”层假设，并将路由配置改写为逐字段填写版。
- [x] 基于七层网关 VIP `10.18.102.127`，补充各路由组的即时验证请求 URL 与预期结果。
- [x] 基于平台支持多路径的能力，补充路由合并原则与推荐合并后的路由组设计。
- [x] 将 Dproxy 方案重构为唯一可执行版本，只保留最终 23 条路由、最终插件、最终服务器组和 step-by-step 操作顺序。
- [x] 基于“七层仅支持 80/443”的新事实，废弃原七层方案，重构为 `SCLB 四层 + APISIX 双节点` 的正确落地版本。
- [x] 按用户确认的路径前缀方案重写为最终施工版，统一收口到七层 80 入口并给出最终 21 条路由与验证方式。

### 待确认事项

- [x] 本次方案编写阶段无额外阻塞问题，已按“优先复用已验证 Knox HA 能力、同时兼容未来直连双节点”的思路落地。

## 2026-04-16 Dproxy 文档实测纠偏

### 需求理解

- [x] 基于当前 SCLB/APISIX 的真实返回结果，重新审视 `Dproxy迁移至七层网关（Apisix）落地方案.md` 是否仍可直接施工。
- [x] 重点验证：`/knox` 前缀剥离、`r-knox-timeline-guard`、`/timeline`、`/flink-hs`、`/realtime/logs`、`/tez-ui`。
- [x] 在旧 dproxy 基线与新 VIP 实测结果的基础上，输出一版正确可用的纠偏文档。

### 设计方案

- [x] 保留“80/443 + 路径前缀”这一总方向，不回退到不可落地的原端口直出模型。
- [x] 放弃将平台表单中的“正则改写”作为既定前提，改为统一 Lua rewrite 前缀剥离。
- [x] 将文档重构为“实测结果 -> 结论 -> 修正方案 -> 路由实施顺序 -> 验收标准”的结构。

### 任务拆解

- [x] 使用 `curl` 分别验证旧 dproxy 与新 VIP 的关键 URL。
- [x] 确认 `r-knox-allow` 当前失败根因是 `/knox` 前缀未被剥离。
- [x] 确认 `r-knox-timeline-guard` 当前仅证明“命中 + 403 插件”可用，不代表整套 Knox 路由已可用。
- [x] 确认 `/timeline/`、`/flink-hs/`、`/realtime/logs/`、`/tez-ui/` 当前在 VIP 上仍为 `404`。
- [x] 重写 `content/工作管理/Outbox-产出池/集群新特性/Dproxy迁移至七层网关（Apisix）/Dproxy迁移至七层网关（Apisix）落地方案.md`。
- [x] 更新 `CHANGELOG.md` 记录本次纠偏交付。
- [x] 进一步确认 `plg-strip-ingress-prefix` 的首版 Lua 写法不正确，需将 `ngx.req.set_uri()` 更正为 `ctx.var.upstream_uri`。
- [x] 基于 Tez 页面和 ApplicationHistory 页面真实 HTML/JS 内容，补充需要迁移的子路径依赖。
- [x] 基于 APISIX 路由匹配规则，确认当前平台要用 `/knox/*` 这类 wildcard 路径，而不是 `/knox/` 这种字面量路径。
- [x] 将文档升级为“原 nginx 全量功能梳理 + 对应 SCLB 迁移矩阵”的最终版。

### 待确认事项

- [ ] `/timeline/ws/v1/timeline/...` 新链路的真实浏览器 `Origin` 仍需在 `/tez-ui` 打通后抓包确认，再决定是否恢复旧版 `Origin + limit=11` 限制。
