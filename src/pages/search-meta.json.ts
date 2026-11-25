import { getVaultGraph } from "../lib/vault"

export function GET() {
  const graph = getVaultGraph()
  const searchMeta = graph.notes
    .filter((n) => !n.isHome)
    .map((n) => ({
      slug: n.slug,
      href: n.href,
      title: n.title,
      domain: n.domain,
      column: n.folderPath,
      tags: n.tags.slice(0, 5),
      summary: n.summary,
      date: n.date,
    }))

  return new Response(JSON.stringify(searchMeta), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
