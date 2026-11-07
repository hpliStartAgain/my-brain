import type { QuartzTransformerPlugin } from "@quartz-community/types"

/**
 * content-polish —— 构建期内容整理（不改动 Markdown 源文件）
 *
 * 1. 去重标题：页面顶部已由 article-title 组件渲染 frontmatter.title 作为 H1，
 *    正文首行若再有一个内容相同的 `# 标题`（仅编号前缀不同也算），从 AST 中移除。
 *    这样页面只有一个 H1，右侧目录也不再以重复的大标题开头。
 * 2. 中文摘要描述：frontmatter 没写 description 时，按以下顺序生成 meta description
 *    （同时用于搜索引擎摘要、分享卡片、og 图）：
 *      `**摘要：**` 段落 → `## 摘要` 下的首段 → `> [!abstract]` Callout → 正文首段
 *    并按中文句读截断，取代默认按英文 ". " 断句、整段截到 300 字的行为。
 * 3. 图片懒加载：正文 <img> 统一加 loading="lazy" decoding="async"，
 *    译书类页面动辄几十张插图，不再在首屏一次性全部下载。
 *
 * 必须排在 obsidian-flavored-markdown（order 30）之前：此时 Callout 仍是原始引用块，
 * 且在 table-of-contents（order 50）之前，使去掉的 H1 不进入目录。
 */

export interface ContentPolishOptions {
  /** 移除与标题重复的正文首个 H1 */
  dedupeTitleHeading: boolean
  /** 自动生成中文 description */
  generateDescription: boolean
  /** description 目标长度（字符） */
  descriptionLength: number
  /** 正文图片懒加载 */
  lazyImages: boolean
}

const defaultOptions: ContentPolishOptions = {
  dedupeTitleHeading: true,
  generateDescription: true,
  descriptionLength: 140,
  lazyImages: true,
}

interface MdNode {
  type: string
  depth?: number
  value?: string
  children?: MdNode[]
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIP_TYPES = new Set(["yaml", "toml", "html", "definition"])

function nodeText(node: MdNode): string {
  if (node.type === "code" || node.type === "html" || node.type === "math") return ""
  if (node.type === "inlineMath") return node.value ?? ""
  if (typeof node.value === "string") return node.value
  if (node.type === "break") return " "
  return (node.children ?? []).map(nodeText).join("")
}

/** 去掉 Obsidian 语法残留：[[a|b]] → b，[[a]] → a，==高亮== → 高亮，脚注标记等 */
function cleanText(text: string): string {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split("#").pop() ?? p)
    .replace(/==([^=]+)==/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const NUMBER_PREFIX =
  /^(第\s*[\d一二三四五六七八九十百]+\s*[章篇节讲部分]|[\d]+(\.\d+)*)[\s.、\-_—:：]*/

function normalizeTitle(text: string): string {
  return text
    .trim()
    .replace(NUMBER_PREFIX, "")
    .replace(/[\s\-_—:：,，.。·、|｜()（）《》<>"“”'‘’`!！?？]+/g, "")
    .toLowerCase()
}

function sameTitle(a: string, b: string): boolean {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x || !y) return false
  if (x === y) return true
  // 一方包含另一方，且长度接近（避免"导览"这类短标题误伤）
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return long.includes(short) && short.length / long.length >= 0.6
}

const SENTENCE_END = /[。！？；!?;]/g

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  let cut = -1
  for (const m of text.matchAll(SENTENCE_END)) {
    const idx = (m.index ?? 0) + 1
    if (idx > limit) break
    cut = idx
  }
  if (cut >= limit * 0.45) return text.slice(0, cut)
  return text.slice(0, limit).replace(/[，,、：:\s]+$/, "") + "…"
}

const SUMMARY_LEAD = /^\s*摘要\s*[:：]?\s*/
const CALLOUT_SUMMARY = /^\s*\[!(abstract|summary|tldr)\][-+]?\s*[^\n]*\n?/i

function isParagraphLike(node: MdNode) {
  return node.type === "paragraph"
}

function findSummary(children: MdNode[]): string | undefined {
  // a. **摘要：** 开头的段落（摘要文字可能在同一段，也可能在下一段）
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (!isParagraphLike(node)) continue
    const first = node.children?.[0]
    if (!first || first.type !== "strong" || !SUMMARY_LEAD.test(nodeText(first))) continue
    const rest = cleanText(nodeText(node).replace(SUMMARY_LEAD, ""))
    if (rest.length >= 20) return rest
    const next = children[i + 1]
    if (next && isParagraphLike(next)) return cleanText(nodeText(next))
  }

  // b. `## 摘要` 标题下的第一个段落
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type !== "heading" || !/^\s*摘要\s*$/.test(nodeText(node))) continue
    for (let j = i + 1; j < children.length && children[j].type !== "heading"; j++) {
      if (isParagraphLike(children[j])) {
        const text = cleanText(nodeText(children[j]))
        if (text) return text
      }
    }
  }

  // c. > [!abstract] / [!summary] / [!tldr] Callout
  for (const node of children) {
    if (node.type !== "blockquote") continue
    const raw = nodeText({ type: "root", children: node.children?.slice(0, 1) })
    if (!CALLOUT_SUMMARY.test(raw)) continue
    const text = cleanText(
      (node.children ?? [])
        .map((c) => nodeText(c))
        .join(" ")
        .replace(CALLOUT_SUMMARY, ""),
    )
    if (text) return text
  }

  return undefined
}

function firstParagraphs(children: MdNode[], min: number): string | undefined {
  let acc = ""
  for (const node of children) {
    if (node.type === "heading" && acc) break
    if (!isParagraphLike(node)) continue
    const text = cleanText(nodeText(node))
    if (!text) continue
    acc = acc ? `${acc} ${text}` : text
    if (acc.length >= min) break
  }
  return acc || undefined
}

export const ContentPolish: QuartzTransformerPlugin<Partial<ContentPolishOptions>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "ContentPolish",
    htmlPlugins() {
      if (!opts.lazyImages) return []
      return [
        () => (tree: unknown) => {
          const walk = (node: HastNode) => {
            if (node.type === "element" && node.tagName === "img") {
              const props = (node.properties ??= {})
              props.loading ??= "lazy"
              props.decoding ??= "async"
            }
            node.children?.forEach(walk)
          }
          walk(tree as HastNode)
        },
      ]
    },
    markdownPlugins() {
      return [
        () => (tree: unknown, file: { data: Record<string, any> }) => {
          const root = tree as MdNode
          const children = root.children ?? []
          const frontmatter = (file.data.frontmatter ??= {}) as Record<string, unknown>
          const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined

          if (opts.dedupeTitleHeading && title) {
            const idx = children.findIndex((n) => !SKIP_TYPES.has(n.type))
            const node = children[idx]
            if (
              node &&
              node.type === "heading" &&
              node.depth === 1 &&
              sameTitle(nodeText(node), title)
            ) {
              children.splice(idx, 1)
            }
          }

          if (opts.generateDescription && !frontmatter.description) {
            const desc = findSummary(children) ?? firstParagraphs(children, opts.descriptionLength)
            if (desc && desc.length >= 10) {
              frontmatter.description = truncate(desc, opts.descriptionLength)
            }
          }
        },
      ]
    },
  }
}

export default ContentPolish
