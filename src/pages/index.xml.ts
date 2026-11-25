import rss from "@astrojs/rss"
import type { APIContext } from "astro"
import { getVaultGraph } from "../lib/vault"

export function GET(context: APIContext) {
  const graph = getVaultGraph()
  const items = graph.recentNotes.slice(0, 40).map((note) => ({
    title: note.title,
    pubDate: new Date(note.dateMs),
    description: note.summary || note.title,
    link: note.href,
  }))

  return rss({
    title: "汀的知识碎片",
    description:
      "李浩鹏（汀）的技术知识库：Linux 内核与性能工程、分布式存储与计算、云原生、可观测性与 SRE 实践。",
    site: context.site ?? "https://ting.is-a.dev",
    items,
    customData: `<language>zh-cn</language>`,
  })
}
