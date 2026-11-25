# 汀的知识碎片

李浩鹏（汀）的个人技术知识库，线上地址：<https://ting.is-a.dev>

内容覆盖 Linux 内核与系统性能工程、Golang / Java 运行时与并发、中间件与存储引擎、分布式架构与大数据、云原生、可观测性与 SRE、LLM 与 Agent 基础设施，以及若干英文技术书的翻译与精读。

## 技术栈与仓库结构

站点基于 **Astro 5** + **Pagefind** + **Shiki** + **Mermaid** 构建（原 Quartz v5 归档于 Git tag `quartz-v5-final`），零改动兼容 Obsidian 双源 `content/` 目录。

| 路径                       | 说明                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `content/`                 | 知识库正文（Obsidian 与 Astro 双源，`index.md` 为首页）                                           |
| `src/lib/vault.ts`         | Vault 索引器：frontmatter 解析、Obsidian 最短路径/别名双链解析、反向链接与自然序号专栏树          |
| `src/lib/markdown.ts`      | `unified` 渲染管线：标题去重、Callout、Mermaid 容器、Shiki 双主题代码高亮、KaTeX 公式             |
| `src/lib/mermaid-normalizer.ts` | 统一 Mermaid 暖色调编辑风语义重映射引擎（亮/暗双模式自适应）                                 |
| `src/scripts/`             | 客户端增强：Mermaid 懒渲染与全屏 Pan/Zoom Lightbox、Pagefind 分片检索、双链悬浮预览、阅读偏好     |
| `src/layouts/` / `src/pages/` | 三栏阅读布局（Scoped 专栏目录 + 正文 + 粘性 TOC）、专栏目录页、标签页与 RSS                    |
| `scripts/sync-assets.mjs`  | 硬链接同步 `content/` 下的图片/媒体到 `public/_vault-assets/`                                     |
| `scripts/`                 | 内容维护脚本：标签受控词表收敛 `converge_tags.py`、缺失 frontmatter 补齐等                       |
| `AGENTS.md`                | 写作与维护规范（专栏交付标准、frontmatter、标签词表）                                             |

## 本地构建与预览

需要 Node.js 22+。

```bash
npm ci
```

```bash
npm run dev      # 同步资源并启动热更新开发服务器
npm run build    # 构建全部静态页到 dist/ 并生成 Pagefind 中文搜索索引
npm run preview  # 本地预览完整 dist/ 产物（含 Pagefind 全文搜索）
```

部署于 Vercel（`vercel.json` 配置了 `astro` 框架、`cleanUrls`、标签页 `noindex` 与 AI 训练爬虫屏蔽）。
