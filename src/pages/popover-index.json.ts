import { getVaultGraph } from "../lib/vault"

export function GET() {
  const graph = getVaultGraph()
  const popoverIndex: Record<
    string,
    { title: string; column: string; readingMinutes: number; summary: string; tags: string[] }
  > = {}

  for (const n of graph.notes) {
    if (n.isHome) continue
    popoverIndex[n.slug] = {
      title: n.title,
      column: n.folderPath || n.domain,
      readingMinutes: n.readingMinutes,
      summary: n.summary,
      tags: n.tags.slice(0, 3),
    }
  }

  return new Response(JSON.stringify(popoverIndex), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
