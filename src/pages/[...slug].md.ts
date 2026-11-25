import fs from "node:fs"
import type { APIContext } from "astro"
import matter from "gray-matter"
import { getVaultGraph, type VaultNote } from "../lib/vault"

export function getStaticPaths() {
  const graph = getVaultGraph()
  const seen = new Set<string>()
  const paths: Array<{ params: { slug: string }; props: { note: VaultNote } }> = []

  for (const note of graph.notes) {
    if (note.isHome || !note.slug) continue
    if (seen.has(note.slug)) continue
    seen.add(note.slug)
    paths.push({
      params: { slug: note.slug },
      props: { note },
    })
  }
  return paths
}

export function GET(context: APIContext) {
  const { note } = context.props as { note: VaultNote }
  const raw = fs.readFileSync(note.absPath, "utf-8")
  let body = raw
  try {
    body = matter(raw).content.trimStart()
  } catch {
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
    if (m) body = m[1].trimStart()
  }

  const headerLines = [
    `# ${note.title}`,
    "",
    `> Source: https://ting.is-a.dev${note.href}`,
    `> Column: ${note.folderPath || note.domain || "随笔"} | Updated: ${note.date}`,
    note.tags.length > 0 ? `> Tags: ${note.tags.join(", ")}` : null,
    "",
    "---",
    "",
  ]
    .filter((x): x is string => x !== null)
    .join("\n")

  return new Response(headerLines + body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  })
}
