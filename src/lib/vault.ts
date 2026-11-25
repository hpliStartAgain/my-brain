import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"

export interface VaultNote {
  /** Relative path from content/, e.g. "分布式架构/分布式锁/01 分布式锁的本质与设计要求.md" */
  relPath: string
  /** Absolute path on disk */
  absPath: string
  /** URL slug without leading/trailing slash; "" for root index.md */
  slug: string
  /** URL href starting with "/" */
  href: string
  /** Directory path relative to content/, "" for root */
  folderPath: string
  /** Top-level domain directory, e.g. "分布式架构" */
  domain: string
  /** Display title */
  title: string
  /** File basename without extension */
  basename: string
  /** ISO date string YYYY-MM-DD if available */
  date: string
  /** Unix timestamp for sorting */
  dateMs: number
  tags: string[]
  keywords: string[]
  aliases: string[]
  /** Clean short summary (<= 140 chars) */
  summary: string
  wordCount: number
  readingMinutes: number
  /** Resolved slugs this note links to */
  outgoingSlugs: string[]
  /** Whether this note is root index.md */
  isHome: boolean
}

export interface VaultFolder {
  /** Folder path relative to content/, e.g. "Linux/进程管理" */
  folderPath: string
  /** URL slug for folder index page */
  slug: string
  /** URL href */
  href: string
  /** Display name */
  name: string
  /** Parent folder path, or null if top-level */
  parentPath: string | null
  /** Top-level domain */
  domain: string
  /** Direct child folders */
  childFolders: string[]
  /** Direct notes in this folder (sorted naturally) */
  notes: VaultNote[]
  /** Total recursive note count */
  totalNotes: number
  /** Intro/index note in this folder if present (00 专栏导览 / _index) */
  introNoteSlug?: string
}

export interface VaultGraph {
  notes: VaultNote[]
  homeNote: VaultNote | null
  bySlug: Map<string, VaultNote>
  byRelPathNoExt: Map<string, VaultNote>
  folders: Map<string, VaultFolder>
  backlinks: Map<string, VaultNote[]>
  tags: Map<string, VaultNote[]>
  domains: Array<{
    name: string
    href: string
    totalNotes: number
    columns: VaultFolder[]
  }>
  recentNotes: VaultNote[]
  assetByRelPath: Map<string, string>
  assetByBasename: Map<string, string[]>
  /** Raw link resolver helper */
  resolveWikilink: (rawTarget: string, fromFolder: string) => { note: VaultNote | null; heading?: string }
  resolveAsset: (rawTarget: string, fromFolder: string) => string | null
}

const CONTENT_DIR = path.join(process.cwd(), "content")

const IGNORED_NAMES = new Set([
  "private",
  "templates",
  ".obsidian",
  "工作管理",
  "Template",
  "电子书",
  ".claude",
  ".claudian",
  ".smtcmp_json_db",
  ".git",
])

const ASSET_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
  ".pdf",
])

const NUMBER_PREFIX_RE = /^(?:第\s*([\d一二三四五六七八九十百]+)\s*[章篇节讲部分]|(\d+)(?:\.(\d+))?)[\s.、\-_—:：]*/

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function parseCnOrNum(str: string): number {
  if (/^\d+$/.test(str)) return Number.parseInt(str, 10)
  if (str in CN_DIGITS) return CN_DIGITS[str]
  if (str.startsWith("十") && str.length === 2 && str[1] in CN_DIGITS) {
    return 10 + CN_DIGITS[str[1]]
  }
  return 9999
}

export function extractOrderKey(name: string): { isIntro: boolean; major: number; minor: number; text: string } {
  const lower = name.toLowerCase()
  if (lower === "_index" || lower === "index" || /^00[\s\-_.]/.test(lower) || lower.includes("专栏导览") || lower.includes("导读") || lower.includes("索引")) {
    const m = name.match(NUMBER_PREFIX_RE)
    const major = m ? (m[1] ? parseCnOrNum(m[1]) : Number.parseInt(m[2] ?? "0", 10)) : -1
    return { isIntro: true, major: major <= 0 ? -1 : major, minor: 0, text: name }
  }
  const m = name.match(NUMBER_PREFIX_RE)
  if (m) {
    const major = m[1] ? parseCnOrNum(m[1]) : Number.parseInt(m[2] ?? "9999", 10)
    const minor = m[3] ? Number.parseInt(m[3], 10) : 0
    return { isIntro: false, major, minor, text: name }
  }
  return { isIntro: false, major: 9999, minor: 9999, text: name }
}

export function compareNotesNatural(a: Pick<VaultNote, "basename" | "title">, b: Pick<VaultNote, "basename" | "title">): number {
  const ka = extractOrderKey(a.basename)
  const kb = extractOrderKey(b.basename)
  if (ka.isIntro !== kb.isIntro) return ka.isIntro ? -1 : 1
  if (ka.major !== kb.major) return ka.major - kb.major
  if (ka.minor !== kb.minor) return ka.minor - kb.minor
  return a.basename.localeCompare(b.basename, "zh-Hans-CN", { numeric: true })
}

export function slugifySegment(seg: string): string {
  return seg
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[?#%&"'<>\\`]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function slugifyPath(relNoExt: string): string {
  if (relNoExt === "index") return ""
  return relNoExt
    .split("/")
    .map((s) => slugifySegment(s))
    .filter(Boolean)
    .join("/")
}

export function folderSlugify(folderPath: string): string {
  if (!folderPath) return ""
  return folderPath
    .split("/")
    .map((s) => slugifySegment(s))
    .filter(Boolean)
    .join("/")
}

function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split("#").pop() ?? p)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const SENTENCE_END_RE = /[。！？；!?;]/g

function truncateChinese(text: string, limit = 140): string {
  if (text.length <= limit) return text
  let cut = -1
  for (const m of text.matchAll(SENTENCE_END_RE)) {
    const idx = (m.index ?? 0) + 1
    if (idx > limit) break
    cut = idx
  }
  if (cut >= limit * 0.45) return text.slice(0, cut)
  return text.slice(0, limit).replace(/[，,、：:\s]+$/, "") + "…"
}

function extractSummary(body: string, frontmatterDesc?: unknown): string {
  if (typeof frontmatterDesc === "string" && frontmatterDesc.trim().length >= 8) {
    return truncateChinese(cleanInlineMarkdown(frontmatterDesc), 140)
  }

  // Strip code blocks so summary doesn't accidentally capture code comments
  const noCode = body.replace(/```[\s\S]*?```/g, "")
  const lines = noCode.split(/\r?\n/)

  // 1. **摘要：** paragraph
  for (let i = 0; i < Math.min(lines.length, 45); i++) {
    const line = lines[i].trim()
    const m = line.match(/^\*\*摘要\s*[:：]?\*\*\s*(.*)$/)
    if (m) {
      let acc = m[1].trim()
      if (acc.length < 20) {
        for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
          const next = lines[j].trim()
          if (!next) {
            if (acc) break
            continue
          }
          if (next.startsWith("#") || next.startsWith("---") || next.startsWith(">")) break
          acc = acc ? `${acc} ${next}` : next
          if (acc.length >= 150) break
        }
      }
      const cleaned = cleanInlineMarkdown(acc)
      if (cleaned.length >= 12) return truncateChinese(cleaned, 140)
    }
  }

  // 2. ## 摘要 heading
  for (let i = 0; i < Math.min(lines.length, 45); i++) {
    if (/^#{1,3}\s+摘要\s*$/.test(lines[i].trim())) {
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const next = lines[j].trim()
        if (!next || next.startsWith("#") || next.startsWith("---")) continue
        const cleaned = cleanInlineMarkdown(next)
        if (cleaned.length >= 12) return truncateChinese(cleaned, 140)
      }
    }
  }

  // 3. > [!abstract] / [!summary] / [!tldr]
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i].trim()
    if (/^>\s*\[!(abstract|summary|tldr)\]/i.test(line)) {
      const buf: string[] = []
      for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
        const q = lines[j].trim()
        if (!q.startsWith(">")) break
        const stripped = q.replace(/^>\s?/, "").trim()
        if (stripped) buf.push(stripped)
      }
      const cleaned = cleanInlineMarkdown(buf.join(" "))
      if (cleaned.length >= 12) return truncateChinese(cleaned, 140)
    }
  }

  // 4. First substantial paragraph
  const paras: string[] = []
  let current: string[] = []
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i].trim()
    if (!line || line === "---") {
      if (current.length > 0) {
        paras.push(current.join(" "))
        current = []
      }
      continue
    }
    if (line.startsWith("#") || line.startsWith(">") || line.startsWith("<div") || line.startsWith("|")) {
      if (current.length > 0) {
        paras.push(current.join(" "))
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) paras.push(current.join(" "))

  for (const p of paras) {
    const cleaned = cleanInlineMarkdown(p)
    if (cleaned.length >= 18) return truncateChinese(cleaned, 140)
  }

  return ""
}

function countWords(body: string): number {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<[^>]+>/g, " ")
  const cjk = (plain.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length
  const latin = (plain.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ").match(/[A-Za-z0-9_]+/g) ?? []).length
  return cjk + latin
}

function extractRawWikilinks(body: string): string[] {
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "")
  const results: string[] = []
  const re = /(?<!!)\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noCode)) !== null) {
    results.push(m[1])
  }
  return results
}

function formatDate(raw: unknown, mtime: Date): { date: string; dateMs: number } {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { date: raw.toISOString().slice(0, 10), dateMs: raw.getTime() }
  }
  if (typeof raw === "string" && raw.trim()) {
    const d = new Date(raw.trim())
    if (!Number.isNaN(d.getTime())) {
      return { date: d.toISOString().slice(0, 10), dateMs: d.getTime() }
    }
  }
  return { date: mtime.toISOString().slice(0, 10), dateMs: mtime.getTime() }
}

function normalizeStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
  }
  if (typeof val === "string" && val.trim()) {
    return [val.trim()]
  }
  return []
}

function parseFrontmatterSafe(raw: string, relPath: string): { data: Record<string, unknown>; content: string } {
  try {
    const parsed = matter(raw)
    return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content }
  } catch (err) {
    // Fallback if frontmatter contains unquoted colons/special yaml characters
    console.warn(`[vault] Frontmatter parse warning in ${relPath}:`, err instanceof Error ? err.message : err)
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!m) return { data: {}, content: raw }
    const data: Record<string, unknown> = {}
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
      if (!kv) continue
      const k = kv[1]
      const v = kv[2].trim().replace(/^["']|["']$/g, "")
      if (v.startsWith("[") && v.endsWith("]")) {
        data[k] = v
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      } else {
        data[k] = v
      }
    }
    return { data, content: m[2] }
  }
}

let cachedGraph: VaultGraph | null = null

export function getVaultGraph(forceReload = false): VaultGraph {
  if (cachedGraph && !forceReload) return cachedGraph

  const t0 = Date.now()
  const rawEntries: Array<{
    relPath: string
    absPath: string
    rawLinks: string[]
    note: VaultNote
  }> = []

  const assetByRelPath = new Map<string, string>()
  const assetByBasename = new Map<string, string[]>()

  function scanDir(dir: string, relBase = "") {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue
      if (IGNORED_NAMES.has(entry.name)) continue

      const absPath = path.join(dir, entry.name)
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        scanDir(absPath, relPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (ext === ".md") {
          const raw = fs.readFileSync(absPath, "utf-8")
          const stat = fs.statSync(absPath)
          const { data, content } = parseFrontmatterSafe(raw, relPath)
          if (data.draft === true || data.publish === false) continue

          const relNoExt = relPath.slice(0, -3)
          const basename = path.basename(relNoExt)
          const folderPath = path.dirname(relPath) === "." ? "" : path.dirname(relPath).replace(/\\/g, "/")
          const domain = folderPath ? folderPath.split("/")[0] : ""
          const isHome = relNoExt === "index"
          const slug = slugifyPath(relNoExt)
          const href = slug ? `/${slug}` : "/"
          const title =
            typeof data.title === "string" && data.title.trim()
              ? data.title.trim()
              : basename
          const { date, dateMs } = formatDate(data.date, stat.mtime)
          const tags = normalizeStringArray(data.tags)
          const keywords = normalizeStringArray(data.keywords)
          const aliases = normalizeStringArray(data.aliases)
          const summary = extractSummary(content, data.description ?? data.socialDescription)
          const wordCount = countWords(content)
          const readingMinutes = Math.max(1, Math.round(wordCount / 380))
          const rawLinks = extractRawWikilinks(content)

          rawEntries.push({
            relPath,
            absPath,
            rawLinks,
            note: {
              relPath,
              absPath,
              slug,
              href,
              folderPath,
              domain,
              title,
              basename,
              date,
              dateMs,
              tags,
              keywords,
              aliases,
              summary,
              wordCount,
              readingMinutes,
              outgoingSlugs: [],
              isHome,
            },
          })
        } else if (ASSET_EXTS.has(ext)) {
          const publicUrl = `/_vault-assets/${relPath.split("/").map(encodeURIComponent).join("/")}`
          assetByRelPath.set(relPath, publicUrl)
          assetByRelPath.set(relPath.toLowerCase(), publicUrl)
          const base = entry.name
          const list = assetByBasename.get(base) ?? []
          list.push(relPath)
          assetByBasename.set(base, list)
          const baseLower = base.toLowerCase()
          if (baseLower !== base) {
            const listL = assetByBasename.get(baseLower) ?? []
            listL.push(relPath)
            assetByBasename.set(baseLower, listL)
          }
        }
      }
    }
  }

  scanDir(CONTENT_DIR)

  const notes: VaultNote[] = []
  let homeNote: VaultNote | null = null
  const bySlug = new Map<string, VaultNote>()
  const byRelPathNoExt = new Map<string, VaultNote>()
  const byBasename = new Map<string, VaultNote[]>()
  const byAlias = new Map<string, VaultNote>()

  for (const item of rawEntries) {
    const n = item.note
    // Deduplicate slug collision safely
    if (bySlug.has(n.slug)) {
      n.slug = `${n.slug}-${notes.length}`
      n.href = `/${n.slug}`
    }
    notes.push(n)
    if (n.isHome) homeNote = n
    bySlug.set(n.slug, n)

    const relNoExt = n.relPath.slice(0, -3)
    byRelPathNoExt.set(relNoExt, n)
    byRelPathNoExt.set(relNoExt.toLowerCase(), n)

    const bList = byBasename.get(n.basename) ?? []
    bList.push(n)
    byBasename.set(n.basename, bList)
    const bLower = n.basename.toLowerCase()
    if (bLower !== n.basename) {
      const bl = byBasename.get(bLower) ?? []
      bl.push(n)
      byBasename.set(bLower, bl)
    }

    for (const a of n.aliases) {
      byAlias.set(a.toLowerCase(), n)
    }
  }

  const resolveWikilink = (rawTarget: string, fromFolder: string): { note: VaultNote | null; heading?: string } => {
    const [targetPart] = rawTarget.split("|")
    const [pathPartRaw, headingPart] = targetPart.trim().split("#")
    const clean = pathPartRaw.trim().replace(/^\.\//, "").replace(/\.md$/i, "")
    const heading = headingPart?.trim() || undefined

    if (!clean) return { note: null, heading }

    // 1. Exact path from content/
    const exact = byRelPathNoExt.get(clean) ?? byRelPathNoExt.get(clean.toLowerCase())
    if (exact) return { note: exact, heading }

    // 2. Relative to current folder
    if (fromFolder) {
      const joined = path.posix.normalize(`${fromFolder}/${clean}`)
      const relHit = byRelPathNoExt.get(joined) ?? byRelPathNoExt.get(joined.toLowerCase())
      if (relHit) return { note: relHit, heading }
    }

    // 3. Basename shortest match (prefer closest folder)
    const candidates = byBasename.get(clean) ?? byBasename.get(clean.toLowerCase())
    if (candidates && candidates.length > 0) {
      if (candidates.length === 1) return { note: candidates[0], heading }
      if (fromFolder) {
        const sameFolder = candidates.find((c) => c.folderPath === fromFolder)
        if (sameFolder) return { note: sameFolder, heading }
        const sameDomain = candidates.find((c) => c.domain === fromFolder.split("/")[0])
        if (sameDomain) return { note: sameDomain, heading }
      }
      return { note: candidates[0], heading }
    }

    // 4. Alias match
    const aliasHit = byAlias.get(clean.toLowerCase())
    if (aliasHit) return { note: aliasHit, heading }

    return { note: null, heading }
  }

  const resolveAsset = (rawTarget: string, fromFolder: string): string | null => {
    const [targetPart] = rawTarget.split("|")
    let clean = decodeURIComponent(targetPart.trim()).replace(/^\.\//, "")
    if (!clean) return null

    if (fromFolder) {
      const candidate1 = path.posix.normalize(`${fromFolder}/${clean}`)
      if (assetByRelPath.has(candidate1)) return assetByRelPath.get(candidate1)!
      if (assetByRelPath.has(candidate1.toLowerCase())) return assetByRelPath.get(candidate1.toLowerCase())!

      // Obsidian / book convention: images/ch13-fig03.png vs ch13-fig03.png inside folder/images/
      const candidate2 = path.posix.normalize(`${fromFolder}/images/${clean}`)
      if (assetByRelPath.has(candidate2)) return assetByRelPath.get(candidate2)!
    }

    if (assetByRelPath.has(clean)) return assetByRelPath.get(clean)!
    if (assetByRelPath.has(clean.toLowerCase())) return assetByRelPath.get(clean.toLowerCase())!

    const base = path.posix.basename(clean)
    const hits = assetByBasename.get(base) ?? assetByBasename.get(base.toLowerCase())
    if (hits && hits.length > 0) {
      if (fromFolder) {
        const sameFolder = hits.find((h) => h.startsWith(`${fromFolder}/`))
        if (sameFolder) return assetByRelPath.get(sameFolder)!
        const sameDomain = hits.find((h) => h.startsWith(`${fromFolder.split("/")[0]}/`))
        if (sameDomain) return assetByRelPath.get(sameDomain)!
      }
      return assetByRelPath.get(hits[0])!
    }

    return null
  }

  // Build outgoing & backlinks
  const backlinks = new Map<string, VaultNote[]>()
  for (const item of rawEntries) {
    const seen = new Set<string>()
    for (const rawLink of item.rawLinks) {
      const { note: target } = resolveWikilink(rawLink, item.note.folderPath)
      if (!target || target.slug === item.note.slug || seen.has(target.slug)) continue
      seen.add(target.slug)
      item.note.outgoingSlugs.push(target.slug)
      const list = backlinks.get(target.slug) ?? []
      list.push(item.note)
      backlinks.set(target.slug, list)
    }
  }

  // Build folder tree
  const folders = new Map<string, VaultFolder>()
  const ensureFolder = (folderPath: string): VaultFolder => {
    const existing = folders.get(folderPath)
    if (existing) return existing
    const parts = folderPath ? folderPath.split("/") : []
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join("/") : parts.length === 1 ? "" : null
    const slug = folderSlugify(folderPath)
    const folder: VaultFolder = {
      folderPath,
      slug,
      href: slug ? `/${slug}` : "/",
      name: parts[parts.length - 1] ?? "首页",
      parentPath,
      domain: parts[0] ?? "",
      childFolders: [],
      notes: [],
      totalNotes: 0,
    }
    folders.set(folderPath, folder)
    if (parentPath !== null && parentPath !== "") {
      const parent = ensureFolder(parentPath)
      if (!parent.childFolders.includes(folderPath)) {
        parent.childFolders.push(folderPath)
      }
    }
    return folder
  }

  for (const note of notes) {
    if (note.isHome) continue
    const folder = ensureFolder(note.folderPath)
    folder.notes.push(note)
  }

  for (const folder of folders.values()) {
    folder.notes.sort(compareNotesNatural)
    folder.childFolders.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }))
    const intro = folder.notes.find((n) => extractOrderKey(n.basename).isIntro)
    if (intro) folder.introNoteSlug = intro.slug
  }

  // Compute recursive totalNotes
  const computeTotal = (folderPath: string): number => {
    const f = folders.get(folderPath)
    if (!f) return 0
    let sum = f.notes.length
    for (const child of f.childFolders) {
      sum += computeTotal(child)
    }
    f.totalNotes = sum
    return sum
  }
  for (const folder of folders.values()) {
    if (folder.parentPath === "") {
      computeTotal(folder.folderPath)
    }
  }

  // Build tags
  const tags = new Map<string, VaultNote[]>()
  for (const note of notes) {
    if (note.isHome) continue
    for (const tag of note.tags) {
      const list = tags.get(tag) ?? []
      list.push(note)
      tags.set(tag, list)
    }
  }
  for (const [k, list] of tags.entries()) {
    list.sort((a, b) => b.dateMs - a.dateMs || compareNotesNatural(a, b))
    tags.set(k, list)
  }

  // Build domains
  const DOMAIN_ORDER = [
    "Linux",
    "Golang",
    "Java",
    "数据结构与算法",
    "中间件",
    "分布式架构",
    "大数据",
    "云原生",
    "可观测",
    "SRE",
    "LLM",
    "译书",
  ]
  const topFolders = Array.from(folders.values()).filter((f) => f.folderPath && f.parentPath === "")
  topFolders.sort((a, b) => {
    const ia = DOMAIN_ORDER.indexOf(a.name)
    const ib = DOMAIN_ORDER.indexOf(b.name)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.name.localeCompare(b.name, "zh-Hans-CN")
  })

  const domains = topFolders.map((top) => {
    const collectLeafColumns = (f: VaultFolder): VaultFolder[] => {
      if (f.childFolders.length === 0) return [f]
      const res: VaultFolder[] = []
      if (f.notes.length > 0) res.push(f)
      for (const cPath of f.childFolders) {
        const cf = folders.get(cPath)
        if (cf) res.push(...collectLeafColumns(cf))
      }
      return res
    }
    return {
      name: top.name,
      href: top.href,
      totalNotes: top.totalNotes,
      columns: collectLeafColumns(top),
    }
  })

  const recentNotes = notes
    .filter((n) => !n.isHome)
    .slice()
    .sort((a, b) => b.dateMs - a.dateMs)

  console.log(
    `[vault] Indexed ${notes.length} notes, ${folders.size} folders, ${tags.size} tags in ${Date.now() - t0}ms`,
  )

  cachedGraph = {
    notes,
    homeNote,
    bySlug,
    byRelPathNoExt,
    folders,
    backlinks,
    tags,
    domains,
    recentNotes,
    assetByRelPath,
    assetByBasename,
    resolveWikilink,
    resolveAsset,
  }
  return cachedGraph
}
