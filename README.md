# 汀的知识碎片

李浩鹏（汀）的个人技术知识库，线上地址：<https://ting.is-a.dev>

内容覆盖 Linux 内核与系统性能工程、Golang / Java 运行时与并发、中间件与存储引擎、分布式架构与大数据、云原生、可观测性与 SRE、LLM 与 Agent 基础设施，以及若干英文技术书的翻译与精读。

## 仓库结构

| 路径                       | 说明                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `content/`                 | 知识库正文（Obsidian 与 Quartz 双源，`index.md` 为首页）                                          |
| `quartz.config.yaml`       | 站点配置：主题色、字体、插件与布局                                                                |
| `quartz/`                  | Quartz v5 核心（含少量本地修改，如 `components/Head.tsx` 的 SEO 与字体异步加载）                  |
| `plugins/`                 | 本地插件与对社区插件的 fork（见下表）                                                             |
| `scripts/`                 | 维护脚本：标签受控词表收敛 `converge_tags.py`、缺失 frontmatter 补齐 `add_missing_frontmatter.py` |
| `AGENTS.md`                | 写作与维护规范（专栏交付标准、frontmatter、标签词表）                                             |
| `CHANGELOG.md` / `TODO.md` | 内容变更记录 / 进行中的大型任务                                                                   |

### 本地插件

| 插件                                                                 | 作用                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `content-polish`                                                     | 构建期去掉与标题重复的正文 H1；从「摘要」生成中文 meta description  |
| `content-index`（fork）                                              | 元数据索引与全文拆分，全文只在打开搜索时加载                        |
| `search`（fork）                                                     | 渐进式索引：打开搜索即用标题 / 标签秒出结果，全文后台加载后增量补入 |
| `explorer`（fork）                                                   | 按文件名序号排序章节；修复定位当前文章时连带滚动整个窗口的问题      |
| `folder-page`（fork）                                                | 专栏目录页按文件名序号排序                                          |
| `footer`（fork）                                                     | 中文版权页脚                                                        |
| `obsidian-flavored-markdown-fork`                                    | Mermaid 配色定制；Mermaid 多 CDN 回退（含国内镜像）                 |
| `article-carousel` / `tag-pills` / `article-tools` / `scroll-reveal` | 首页随机推荐、标签入口、阅读进度与复制正文、首页渐显动效            |

fork 插件直接维护预编译的 `dist/`，修改处均以 `[my-brain fork]` 或中文注释标出。自写插件修改源码后在插件目录执行 `npx tsc -p tsconfig.json`（`article-carousel` 用 `npx tsup`）重新生成 `dist/`。

## 本地构建

需要 Node.js 22+。

```bash
npm ci
```

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx quartz build --serve
```

构建产物输出到 `public/`，部署在 Vercel（`vercel.json` 配置了 clean URL、标签页 noindex 与 AI 训练爬虫屏蔽）。

## 致谢

站点基于 [Quartz](https://quartz.jzhao.xyz/)（MIT License）构建。
