import fs from "node:fs"
import matter from "gray-matter"
import GithubSlugger from "github-slugger"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkCjkFriendly from "remark-cjk-friendly"
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough"
import remarkMath from "remark-math"
import remarkRehype from "remark-rehype"
import rehypeRaw from "rehype-raw"
import rehypeSlug from "rehype-slug"
import rehypeKatex from "rehype-katex"
import rehypeStringify from "rehype-stringify"
import { visit } from "unist-util-visit"
import { createHighlighter, type Highlighter } from "shiki"
import type { VaultGraph, VaultNote } from "./vault"

export interface TocItem {
  depth: 2 | 3
  text: string
  id: string
}

export interface RenderedArticle {
  html: string
  toc: TocItem[]
}

const NUMBER_PREFIX_RE =
  /^(第\s*[\d一二三四五六七八九十百]+\s*[章篇节讲部分]|[\d]+(\.\d+)*)[\s.、\-_—:：]*/

function normalizeTitleForDedupe(text: string): string {
  return text
    .trim()
    .replace(NUMBER_PREFIX_RE, "")
    .replace(/[\s\-_—:：,，.。·、|｜()（）《》<>"“”'‘’`!！?？]+/g, "")
    .toLowerCase()
}

function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitleForDedupe(a)
  const y = normalizeTitleForDedupe(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.includes(short) && short.length / long.length >= 0.6
}

function mdNodeText(node: any): string {
  if (!node) return ""
  if (node.type === "code" || node.type === "html" || node.type === "math") return ""
  if (typeof node.value === "string") return node.value
  if (Array.isArray(node.children)) return node.children.map(mdNodeText).join("")
  return ""
}

function hastNodeText(node: any): string {
  if (!node) return ""
  if (node.type === "text") return node.value ?? ""
  if (Array.isArray(node.children)) return node.children.map(hastNodeText).join("")
  return ""
}

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

const CALLOUT_LABELS: Record<string, { family: string; defaultTitle: string; icon: string }> = {
  note: {
    family: "note",
    defaultTitle: "笔记",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  },
  info: {
    family: "note",
    defaultTitle: "信息",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  },
  todo: {
    family: "note",
    defaultTitle: "待办",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  },
  abstract: {
    family: "abstract",
    defaultTitle: "摘要",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M8 10h8"/><path d="M8 14h4"/></svg>`,
  },
  summary: {
    family: "abstract",
    defaultTitle: "总结",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M8 10h8"/><path d="M8 14h4"/></svg>`,
  },
  tldr: {
    family: "abstract",
    defaultTitle: "TL;DR",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M8 10h8"/><path d="M8 14h4"/></svg>`,
  },
  tip: {
    family: "tip",
    defaultTitle: "提示",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
  },
  hint: {
    family: "tip",
    defaultTitle: "提示",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
  },
  success: {
    family: "tip",
    defaultTitle: "结论",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`,
  },
  question: {
    family: "question",
    defaultTitle: "思考",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  },
  faq: {
    family: "question",
    defaultTitle: "FAQ",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  },
  warning: {
    family: "warning",
    defaultTitle: "注意",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  },
  caution: {
    family: "warning",
    defaultTitle: "警告",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  },
  attention: {
    family: "warning",
    defaultTitle: "提醒",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  },
  danger: {
    family: "danger",
    defaultTitle: "危险",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  },
  failure: {
    family: "danger",
    defaultTitle: "失败",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
  },
  error: {
    family: "danger",
    defaultTitle: "错误",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
  },
  bug: {
    family: "danger",
    defaultTitle: "缺陷",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/></svg>`,
  },
  example: {
    family: "example",
    defaultTitle: "示例",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>`,
  },
  quote: {
    family: "quote",
    defaultTitle: "引用",
    icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>`,
  },
}

const SUPPORTED_SHIKI_LANGS = [
  "go",
  "java",
  "c",
  "cpp",
  "rust",
  "python",
  "bash",
  "shellscript",
  "yaml",
  "json",
  "sql",
  "dockerfile",
  "toml",
  "ini",
  "xml",
  "html",
  "css",
  "scss",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "diff",
  "nginx",
  "makefile",
  "markdown",
  "protobuf",
  "graphql",
  "groovy",
  "scala",
  "lua",
  "ruby",
  "php",
  "powershell",
  "hcl",
] as const

const LANG_ALIASES: Record<string, string> = {
  golang: "go",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  "c++": "cpp",
  cc: "cpp",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  proto: "protobuf",
  mk: "makefile",
  md: "markdown",
  ps1: "powershell",
  terraform: "hcl",
  tf: "hcl",
  txt: "text",
  plaintext: "text",
  plain: "text",
  log: "text",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
}

const SUPPORTED_LANG_SET = new Set<string>(SUPPORTED_SHIKI_LANGS)

let highlighterPromise: Promise<Highlighter> | null = null

function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["vitesse-light", "vitesse-dark"],
      langs: [...SUPPORTED_SHIKI_LANGS],
    })
  }
  return highlighterPromise
}

function remarkDedupeTitle(title: string) {
  return () => (tree: any) => {
    if (!title || !Array.isArray(tree.children)) return
    const idx = tree.children.findIndex(
      (n: any) => n.type !== "yaml" && n.type !== "toml" && n.type !== "html" && n.type !== "definition",
    )
    if (idx === -1) return
    const first = tree.children[idx]
    if (first.type === "heading" && first.depth === 1 && sameTitle(mdNodeText(first), title)) {
      tree.children.splice(idx, 1)
    }
  }
}

function remarkObsidianSyntax(graph: VaultGraph, note: VaultNote) {
  const tokenRe = /(!?\[\[[^\]]+\]\]|==[^=\n]+==)/g

  return () => (tree: any) => {
    const slugger = new GithubSlugger()

    visit(tree, "text", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return
      if (parent.type === "link" || parent.type === "code" || parent.type === "inlineCode") return
      const val: string = node.value
      if (!val || (!val.includes("[[") && !val.includes("=="))) return

      const parts: any[] = []
      let lastIndex = 0
      tokenRe.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = tokenRe.exec(val)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: "text", value: val.slice(lastIndex, match.index) })
        }
        const token = match[0]

        if (token.startsWith("![[") && token.endsWith("]]")) {
          const inner = token.slice(3, -2).trim()
          const [rawFile, rawMod] = inner.split("|")
          const resolved = graph.resolveAsset(rawFile, note.folderPath)
          if (resolved) {
            const isWidth = rawMod && /^\d+(x\d+)?$/.test(rawMod.trim())
            const width = isWidth ? rawMod.trim().split("x")[0] : undefined
            const alt = !isWidth && rawMod ? rawMod.trim() : rawFile.trim()
            const styleAttr = width ? ` style="max-width: min(100%, ${width}px)"` : ""
            parts.push({
              type: "html",
              value: `<img class="vault-img" src="${escapeHtmlAttr(resolved)}" alt="${escapeHtmlAttr(alt)}" loading="lazy" decoding="async" data-lightbox-img${styleAttr} />`,
            })
          } else {
            parts.push({
              type: "html",
              value: `<span class="asset-missing">[图片未找到: ${escapeHtmlAttr(rawFile)}]</span>`,
            })
          }
        } else if (token.startsWith("[[") && token.endsWith("]]")) {
          const inner = token.slice(2, -2).trim()
          const pipeIdx = inner.indexOf("|")
          const targetPart = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() : inner
          const aliasPart = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : ""

          if (targetPart.startsWith("#")) {
            const heading = targetPart.slice(1).trim()
            const hashId = slugger.slug(heading)
            const label = aliasPart || heading
            parts.push({
              type: "html",
              value: `<a class="wikilink" href="#${escapeHtmlAttr(hashId)}">${escapeHtmlAttr(label)}</a>`,
            })
          } else {
            const { note: targetNote, heading } = graph.resolveWikilink(targetPart, note.folderPath)
            const defaultLabel = targetPart.split("/").pop()?.replace(/\.md$/i, "") ?? targetPart
            const label = aliasPart || (heading ? `${defaultLabel.split("#")[0]} › ${heading}` : defaultLabel)

            if (targetNote) {
              const hash = heading ? `#${slugger.slug(heading)}` : ""
              parts.push({
                type: "html",
                value: `<a class="wikilink" href="${escapeHtmlAttr(targetNote.href + hash)}" data-preview-slug="${escapeHtmlAttr(targetNote.slug)}">${escapeHtmlAttr(label)}</a>`,
              })
            } else {
              parts.push({
                type: "html",
                value: `<span class="wikilink-missing" title="未在当前知识库中发布的链接">${escapeHtmlAttr(label)}</span>`,
              })
            }
          }
        } else if (token.startsWith("==") && token.endsWith("==")) {
          const text = token.slice(2, -2)
          parts.push({ type: "html", value: `<mark>${escapeHtmlAttr(text)}</mark>` })
        }

        lastIndex = tokenRe.lastIndex
      }

      if (parts.length === 0) return
      if (lastIndex < val.length) {
        parts.push({ type: "text", value: val.slice(lastIndex) })
      }
      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

function remarkObsidianCallouts() {
  const headerRe = /^\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/

  return () => (tree: any) => {
    visit(tree, "blockquote", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined || !Array.isArray(node.children) || node.children.length === 0) {
        return
      }
      const firstPara = node.children[0]
      if (!firstPara || firstPara.type !== "paragraph" || !Array.isArray(firstPara.children)) return
      const firstChild = firstPara.children[0]
      if (!firstChild || firstChild.type !== "text") return

      const match = (firstChild.value as string).match(headerRe)
      if (!match) return

      const rawType = match[1].toLowerCase()
      const foldFlag = match[2] // '+' | '-' | undefined
      const customTitle = (match[3] ?? "").trim()
      const trailingOnFirstText = match[4] ?? ""

      const meta = CALLOUT_LABELS[rawType] ?? {
        family: "note",
        defaultTitle: rawType.toUpperCase(),
        icon: CALLOUT_LABELS.note.icon,
      }
      const titleText = customTitle || meta.defaultTitle

      // Rebuild remaining children inside callout body
      const bodyChildren = node.children.slice(1)
      const restFirstParaChildren = [...firstPara.children.slice(1)]
      if (trailingOnFirstText) {
        restFirstParaChildren.unshift({ type: "text", value: trailingOnFirstText })
      }
      if (restFirstParaChildren.length > 0) {
        bodyChildren.unshift({ type: "paragraph", children: restFirstParaChildren })
      }

      const isFoldable = foldFlag === "+" || foldFlag === "-"
      const tag = isFoldable ? "details" : "aside"
      const openAttr = foldFlag === "+" ? " open" : ""
      const titleTag = isFoldable ? "summary" : "div"
      const chevron = isFoldable
        ? `<svg class="callout-fold" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`
        : ""

      const wrapperNodes: any[] = [
        {
          type: "html",
          value: `<${tag} class="callout callout-${meta.family}" data-callout="${escapeHtmlAttr(rawType)}"${openAttr}><${titleTag} class="callout-title"><span class="callout-icon">${meta.icon}</span><span class="callout-title-text">${escapeHtmlAttr(titleText)}</span>${chevron}</${titleTag}><div class="callout-body">`,
        },
        ...bodyChildren,
        {
          type: "html",
          value: `</div></${tag}>`,
        },
      ]

      parent.children.splice(index, 1, ...wrapperNodes)
      return index + wrapperNodes.length
    })
  }
}

function remarkMermaidBlocks() {
  return () => (tree: any) => {
    visit(tree, "code", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return
      if ((node.lang ?? "").toLowerCase() !== "mermaid") return

      const raw = String(node.value ?? "").trim()
      const safeScriptBody = raw.replace(/<\/script/gi, "<\\/script")

      parent.children[index] = {
        type: "html",
        value: `<figure class="mermaid-figure" data-mermaid-block>
  <div class="mermaid-toolbar">
    <span class="mermaid-badge">架构图 / Mermaid</span>
    <div class="mermaid-actions">
      <button type="button" class="mm-btn" data-mermaid-zoom title="全屏缩放查看">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
        <span>放大</span>
      </button>
      <button type="button" class="mm-btn" data-mermaid-copy title="复制 Mermaid 源码">源码</button>
      <button type="button" class="mm-btn" data-mermaid-download title="导出 SVG">SVG</button>
    </div>
  </div>
  <div class="mermaid-stage" data-mermaid-stage>
    <div class="mermaid-loading">图表渲染中…</div>
  </div>
  <script type="text/plain" class="mermaid-source">${safeScriptBody}</script>
</figure>`,
      }
    })
  }
}

function rehypeShikiCode(highlighter: Highlighter) {
  return () => (tree: any) => {
    visit(tree, "element", (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined || node.tagName !== "pre") return
      const codeChild = Array.isArray(node.children)
        ? node.children.find((c: any) => c.type === "element" && c.tagName === "code")
        : null
      if (!codeChild) return

      const classList: string[] = Array.isArray(codeChild.properties?.className)
        ? codeChild.properties.className
        : []
      const langClass = classList.find((c) => typeof c === "string" && c.startsWith("language-"))
      const rawLang = langClass ? langClass.slice("language-".length).toLowerCase() : "text"
      const mapped = LANG_ALIASES[rawLang] ?? rawLang
      const shikiLang = SUPPORTED_LANG_SET.has(mapped) ? mapped : "text"
      const displayLang = rawLang === "text" || rawLang === "plaintext" ? "TEXT" : rawLang.toUpperCase()

      const codeText = hastNodeText(codeChild).replace(/\n$/, "")
      let renderedHtml: string
      try {
        renderedHtml = highlighter.codeToHtml(codeText, {
          lang: shikiLang,
          themes: {
            light: "vitesse-light",
            dark: "vitesse-dark",
          },
          defaultColor: false,
        })
      } catch {
        renderedHtml = `<pre class="shiki"><code>${escapeHtmlAttr(codeText)}</code></pre>`
      }

      parent.children[index] = {
        type: "raw",
        value: `<div class="code-block" data-lang="${escapeHtmlAttr(displayLang)}"><div class="code-header"><span class="code-lang">${escapeHtmlAttr(displayLang)}</span><button type="button" class="code-copy-btn" data-copy-code>复制</button></div>${renderedHtml}</div>`,
      }
    })
  }
}

function rehypePolishHtml(graph: VaultGraph, note: VaultNote, toc: TocItem[]) {
  return () => (tree: any) => {
    let markedAbstract = false

    visit(tree, "element", (node: any, index: number | undefined, parent: any) => {
      if (node.tagName === "h2" || node.tagName === "h3") {
        const id = typeof node.properties?.id === "string" ? node.properties.id : ""
        const text = hastNodeText(node).trim()
        if (id && text) {
          toc.push({
            depth: node.tagName === "h2" ? 2 : 3,
            text,
            id,
          })
        }
        return
      }

      if (node.tagName === "img") {
        const props = (node.properties ??= {})
        const src = typeof props.src === "string" ? props.src : ""
        if (src && !/^(https?:|data:|\/)/i.test(src)) {
          const resolved = graph.resolveAsset(src, note.folderPath)
          if (resolved) props.src = resolved
        }
        props.loading ??= "lazy"
        props.decoding ??= "async"
        props.dataLightboxImg = ""
        return
      }

      if (node.tagName === "a") {
        const props = (node.properties ??= {})
        const href = typeof props.href === "string" ? props.href : ""
        if (/^https?:\/\//i.test(href)) {
          props.target = "_blank"
          props.rel = "noopener noreferrer"
        }
        return
      }

      if (node.tagName === "table" && parent && index !== undefined) {
        if (parent.tagName !== "div" || !String(parent.properties?.className ?? "").includes("table-scroll")) {
          parent.children[index] = {
            type: "element",
            tagName: "div",
            properties: { className: ["table-scroll"] },
            children: [node],
          }
        }
        return
      }

      if (!markedAbstract && node.tagName === "p" && parent?.type === "root") {
        const txt = hastNodeText(node).trim()
        if (/^摘要\s*[:：]/.test(txt) && txt.length >= 25) {
          const props = (node.properties ??= {})
          const cls = Array.isArray(props.className) ? props.className : []
          props.className = [...cls, "article-abstract"]
          markedAbstract = true
        }
      }
    })
  }
}

function stripFrontmatterSafe(raw: string): string {
  try {
    return matter(raw).content
  } catch {
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)
    return m ? m[1] : raw
  }
}

/**
 * Normalizes multiline `$$...$$` display math blocks whose opening or closing `$$`
 * shares a line with formula content (e.g. `$$P_n = \n...\n\end{cases}$$`).
 * `micromark-extension-math` treats opening `$$...` as a mathFlow fence with a `meta`
 * string and only closes on a line containing standalone `$$`, otherwise swallowing
 * the entire rest of the document into one `<span class="katex-error">`.
 */
function normalizeMultilineDisplayMath(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let fenceChar: string | null = null
  let fenceLen = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const fenceMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/)
    if (!fenceChar && fenceMatch) {
      const marker = fenceMatch[1]
      const info = fenceMatch[2]
      if (marker[0] !== "`" || !info.includes("`")) {
        fenceChar = marker[0]
        fenceLen = marker.length
      }
      out.push(line)
      i++
      continue
    }
    if (fenceChar) {
      const closeMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        fenceChar = null
        fenceLen = 0
      }
      out.push(line)
      i++
      continue
    }

    const openMatch = line.match(/^([ \t]{0,3})\$\$(.+)$/)
    if (openMatch && !openMatch[2].includes("$$")) {
      const indent = openMatch[1]
      // Scan forward within the same non-empty block for a closing `$$`
      let closeIdx = -1
      for (let j = i + 1; j < lines.length && j <= i + 60; j++) {
        const candidate = lines[j]
        if (candidate.trim() === "" || /^[ ]{0,3}(`{3,}|~{3,})/.test(candidate)) {
          break
        }
        if (/^[ \t]*\$\$[ \t]*$/.test(candidate)) {
          closeIdx = j
          break
        }
        if (/^.*\S[ \t]*\$\$[ \t]*$/.test(candidate) && !candidate.slice(0, candidate.lastIndexOf("$$")).includes("$$")) {
          closeIdx = j
          break
        }
      }

      if (closeIdx !== -1) {
        out.push(`${indent}$$`)
        out.push(`${indent}${openMatch[2].trimStart()}`)
        for (let k = i + 1; k < closeIdx; k++) {
          const inner = lines[k]
          out.push(indent && !inner.startsWith(indent) ? `${indent}${inner.trimStart()}` : inner)
        }
        const closeLine = lines[closeIdx]
        if (/^[ \t]*\$\$[ \t]*$/.test(closeLine)) {
          out.push(`${indent}$$`)
        } else {
          const idx = closeLine.lastIndexOf("$$")
          const bodyPart = closeLine.slice(0, idx).trimEnd()
          if (bodyPart) {
            out.push(indent && !bodyPart.startsWith(indent) ? `${indent}${bodyPart.trimStart()}` : bodyPart)
          }
          out.push(`${indent}$$`)
        }
        i = closeIdx + 1
        continue
      }
    }

    out.push(line)
    i++
  }

  return out.join("\n")
}

export async function renderArticle(note: VaultNote, graph: VaultGraph): Promise<RenderedArticle> {
  const raw = fs.readFileSync(note.absPath, "utf-8")
  const markdown = normalizeMultilineDisplayMath(stripFrontmatterSafe(raw))
  const highlighter = await getShikiHighlighter()
  const toc: TocItem[] = []

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCjkFriendly)
    .use(remarkCjkFriendlyGfmStrikethrough)
    .use(remarkMath)
    .use(remarkDedupeTitle(note.title))
    .use(remarkMermaidBlocks())
    .use(remarkObsidianCallouts())
    .use(remarkObsidianSyntax(graph, note))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeKatex, { strict: false, throwOnError: false })
    .use(rehypeShikiCode(highlighter))
    .use(rehypePolishHtml(graph, note, toc))
    .use(rehypeStringify, { allowDangerousHtml: true })

  const file = await processor.process(markdown)
  return {
    html: String(file),
    toc,
  }
}
