const READ_KEY = "ting-read-slugs"
const SCROLL_KEY = "ting-scroll-pos"
const MAX_SCROLL_ENTRIES = 120

interface ScrollRecord {
  pct: number
  y: number
  ts: number
}

export function getReadSlugs(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

export function saveReadSlugs(set: Set<string>) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(Array.from(set)))
  } catch {
    // ignore storage quota errors
  }
}

function getScrollMap(): Record<string, ScrollRecord> {
  try {
    const raw = localStorage.getItem(SCROLL_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function saveScrollRecord(slug: string, pct: number, y: number) {
  try {
    const map = getScrollMap()
    map[slug] = { pct: Math.round(pct), y: Math.round(y), ts: Date.now() }
    const keys = Object.keys(map)
    if (keys.length > MAX_SCROLL_ENTRIES) {
      keys
        .sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0))
        .slice(0, keys.length - MAX_SCROLL_ENTRIES)
        .forEach((k) => delete map[k])
    }
    localStorage.setItem(SCROLL_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

export function initReadingTracker(signal: AbortSignal) {
  const mainEl = document.querySelector<HTMLElement>("main[data-note-slug]")
  const articleEl = document.getElementById("article-prose")
  if (!mainEl || !articleEl) return

  const slug = mainEl.dataset.noteSlug
  if (!slug) return

  const toggleBtn = document.getElementById("toggle-read-btn")
  const navLinks = Array.from(document.querySelectorAll<HTMLElement>("[data-nav-slug]"))
  const progressText = document.getElementById("sidebar-progress-text")
  const progressFill = document.getElementById("sidebar-progress-fill")

  const syncUi = () => {
    const readSet = getReadSlugs()
    const isRead = readSet.has(slug)

    if (toggleBtn) {
      toggleBtn.classList.toggle("is-read", isRead)
      const span = toggleBtn.querySelector("span")
      if (span) span.textContent = isRead ? "已读" : "标为已读"
    }

    let readCount = 0
    for (const el of navLinks) {
      const s = el.dataset.navSlug
      const done = Boolean(s && readSet.has(s))
      el.classList.toggle("is-read", done)
      if (done) readCount++
    }

    const total = navLinks.length
    if (total > 0) {
      const pct = Math.round((readCount / total) * 100)
      if (progressText) progressText.textContent = `已读 ${readCount}/${total}`
      if (progressFill) progressFill.style.width = `${pct}%`
    }
  }

  const setReadState = (nextRead: boolean) => {
    const readSet = getReadSlugs()
    if (nextRead) readSet.add(slug)
    else readSet.delete(slug)
    saveReadSlugs(readSet)
    syncUi()
  }

  toggleBtn?.addEventListener(
    "click",
    () => {
      const readSet = getReadSlugs()
      setReadState(!readSet.has(slug))
    },
    { signal },
  )

  syncUi()

  // Check if there is a resumable reading position (15% - 85%)
  const existing = getScrollMap()[slug]
  let resumeToast: HTMLElement | null = null
  if (existing && existing.pct >= 15 && existing.pct <= 85 && existing.y > 260 && window.scrollY < 120) {
    resumeToast = document.createElement("div")
    resumeToast.className = "resume-toast"
    resumeToast.innerHTML = `
      <span>上次读到 <strong>${existing.pct}%</strong></span>
      <button type="button" class="resume-jump-btn">回到此处</button>
      <button type="button" class="resume-close-btn" aria-label="关闭">×</button>
    `
    document.body.appendChild(resumeToast)

    const removeToast = () => {
      resumeToast?.remove()
      resumeToast = null
    }

    resumeToast.querySelector(".resume-jump-btn")?.addEventListener(
      "click",
      () => {
        window.scrollTo({ top: existing.y, behavior: "smooth" })
        removeToast()
      },
      { signal },
    )
    resumeToast.querySelector(".resume-close-btn")?.addEventListener("click", removeToast, { signal })

    const timer = window.setTimeout(removeToast, 8500)
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer)
      removeToast()
    })
  }

  // Track scroll progress & auto-mark read >= 80%
  let saveTimer: number | undefined
  let autoMarked = getReadSlugs().has(slug)

  const onScroll = () => {
    const rect = articleEl.getBoundingClientRect()
    const total = articleEl.offsetHeight - window.innerHeight * 0.65
    const pct = total <= 0 ? 100 : Math.min(100, Math.max(0, ((-rect.top + window.innerHeight * 0.25) / total) * 100))

    if (resumeToast && window.scrollY > 360) {
      resumeToast.remove()
      resumeToast = null
    }

    if (!autoMarked && pct >= 80) {
      autoMarked = true
      setReadState(true)
    }

    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveScrollRecord(slug, pct, window.scrollY)
    }, 320)
  }

  window.addEventListener("scroll", onScroll, { passive: true, signal })
  signal.addEventListener("abort", () => window.clearTimeout(saveTimer))
}
