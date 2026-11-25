import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const CONTENT_DIR = path.join(ROOT, "content")
const TARGET_DIR = path.join(ROOT, "public", "_vault-assets")

const IGNORED_DIRS = new Set([
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function linkOrCopy(src, dest) {
  ensureDir(path.dirname(dest))
  try {
    if (fs.existsSync(dest)) {
      const sStat = fs.statSync(src)
      const dStat = fs.statSync(dest)
      if (sStat.ino === dStat.ino || (sStat.size === dStat.size && sStat.mtimeMs <= dStat.mtimeMs)) {
        return "skipped"
      }
      fs.unlinkSync(dest)
    }
    try {
      fs.linkSync(src, dest)
      return "linked"
    } catch {
      fs.copyFileSync(src, dest)
      return "copied"
    }
  } catch (err) {
    console.warn(`[sync-assets] Failed to sync ${src}:`, err instanceof Error ? err.message : err)
    return "error"
  }
}

function walk(dir, relBase = "", stats = { linked: 0, copied: 0, skipped: 0 }) {
  if (!fs.existsSync(dir)) return stats
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue
    if (IGNORED_DIRS.has(entry.name)) continue

    const fullPath = path.join(dir, entry.name)
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      walk(fullPath, relPath, stats)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (ASSET_EXTS.has(ext)) {
        const destPath = path.join(TARGET_DIR, relPath)
        const res = linkOrCopy(fullPath, destPath)
        if (res in stats) stats[res]++
      }
    }
  }
  return stats
}

const t0 = Date.now()
ensureDir(TARGET_DIR)
const stats = walk(CONTENT_DIR)
const ms = Date.now() - t0
console.log(
  `[sync-assets] Done in ${ms}ms (linked: ${stats.linked}, copied: ${stats.copied}, cached: ${stats.skipped})`,
)
