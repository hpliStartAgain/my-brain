import { getVaultGraph } from "../lib/vault"

export function GET() {
  const graph = getVaultGraph()
  const site = "https://ting.is-a.dev"
  const totalNotes = graph.notes.filter((n) => !n.isHome).length

  const lines: string[] = [
    "# 汀的知识碎片",
    "",
    "> 李浩鹏（汀）的个人技术知识库与数字花园，覆盖 Linux 内核与性能工程、Golang/Java 运行时、中间件与存储引擎、分布式系统协议、大数据引擎、云原生 Kubernetes、可观测性与 SRE，以及 LLM/Agent 沙箱基础设施。共收录 " +
      totalNotes +
      " 篇中文深度专栏与英文技术书精读笔记。",
    "",
    "## 格式与接口约定",
    "",
    "- 所有文章页面均提供对应的纯 Markdown 端点：将文章 URL 末尾加上 `.md` 即可获取原始 Markdown 正文（例如 `/Linux/内存管理/01-虚拟内存：为什么每个进程都以为自己独占内存.md`）。",
    `- 学习路线图：${site}/roadmap`,
    `- 全部标签索引：${site}/tags`,
    `- RSS 订阅：${site}/index.xml`,
    "",
    "## 知识领域与专栏索引",
    "",
  ]

  for (const domain of graph.domains) {
    lines.push(`### ${domain.name}（${domain.totalNotes} 篇）`)
    lines.push("")
    for (const col of domain.columns) {
      const entryHref = col.introNoteSlug ? `/${col.introNoteSlug}` : col.href
      const entryTitle = col.folderPath || col.name
      lines.push(`- [${entryTitle}](${site}${entryHref}): 共 ${col.notes.length} 篇`)
    }
    lines.push("")
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  })
}
