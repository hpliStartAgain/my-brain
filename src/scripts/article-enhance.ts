interface PopoverEntry {
  title: string
  column: string
  readingMinutes: number
  summary: string
  tags: string[]
}

let popoverIndexCache: Record<string, PopoverEntry> | null = null

async function loadPopoverIndex(): Promise<Record<string, PopoverEntry>> {
  if (popoverIndexCache) return popoverIndexCache
  try {
    const res = await fetch("/popover-index.json")
    popoverIndexCache = (await res.json()) as Record<string, PopoverEntry>
  } catch {
    popoverIndexCache = {}
  }
  return popoverIndexCache
}

export function initArticleEnhancements() {
  // 1. Reading progress bar
  const progressBar = document.getElementById("reading-progress-bar")
  const articleEl = document.getElementById("article-prose")
  if (progressBar && articleEl) {
    const updateProgress = () => {
      const rect = articleEl.getBoundingClientRect()
      const total = articleEl.offsetHeight - window.innerHeight * 0.65
      if (total <= 0) {
        progressBar.style.width = "100%"
        return
      }
      const scrolled = Math.max(0, -rect.top + window.innerHeight * 0.25)
      const pct = Math.min(100, Math.max(0, (scrolled / total) * 100))
      progressBar.style.width = `${pct.toFixed(1)}%`
    }
    window.addEventListener("scroll", updateProgress, { passive: true })
    updateProgress()
  }

  // 2. TOC active heading tracking
  const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".toc-link"))
  if (tocLinks.length > 0) {
    const idToLink = new Map<string, HTMLAnchorElement>()
    for (const link of tocLinks) {
      const id = link.getAttribute("href")?.slice(1)
      if (id) idToLink.set(id, link)
    }

    const headings = Array.from(document.querySelectorAll<HTMLElement>(".prose h2[id], .prose h3[id]"))
    let activeId = ""
    const setActive = (id: string) => {
      if (!id || id === activeId) return
      activeId = id
      for (const link of tocLinks) link.classList.remove("is-active")
      const target = idToLink.get(id)
      if (target) {
        target.classList.add("is-active")
        target.scrollIntoView({ block: "nearest" })
      }
    }

    if ("IntersectionObserver" in window && headings.length > 0) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setActive(entry.target.id)
              break
            }
          }
        },
        { rootMargin: "-72px 0px -74% 0px", threshold: 0 },
      )
      for (const h of headings) io.observe(h)
    }
  }

  // 3. Copy code buttons
  document.querySelectorAll<HTMLButtonElement>("[data-copy-code]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pre = btn.closest(".code-block")?.querySelector("pre")
      const text = pre?.textContent ?? ""
      if (!text) return
      await navigator.clipboard.writeText(text)
      const orig = btn.textContent
      btn.textContent = "已复制"
      setTimeout(() => {
        btn.textContent = orig
      }, 1400)
    })
  })

  // 4. Copy full article text
  const copyArticleBtn = document.getElementById("copy-article-btn")
  copyArticleBtn?.addEventListener("click", async () => {
    if (!articleEl) return
    const text = articleEl.innerText.trim()
    await navigator.clipboard.writeText(text)
    const label = copyArticleBtn.querySelector("span")
    if (label) {
      const orig = label.textContent
      label.textContent = "已复制全文"
      setTimeout(() => {
        label.textContent = orig
      }, 1600)
    }
  })

  // 5. Shared Lightbox Modal close + Image Lightbox
  const modal = document.getElementById("diagram-modal")
  const canvas = modal?.querySelector<HTMLElement>("[data-modal-canvas]")
  const viewport = modal?.querySelector<HTMLElement>("[data-modal-viewport]")
  const closeBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-close]")

  const closeSharedModal = () => {
    if (!modal || modal.hidden) return
    modal.hidden = true
    document.body.style.overflow = ""
    if (canvas) {
      canvas.innerHTML = ""
      canvas.style.transform = ""
    }
    window.dispatchEvent(new CustomEvent("diagram-modal-close"))
  }

  closeBtn?.addEventListener("click", closeSharedModal)
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeSharedModal()
  })
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.hidden) closeSharedModal()
  })

  document.querySelectorAll<HTMLImageElement>(".prose img[data-lightbox-img]").forEach((img) => {
    img.addEventListener("click", () => {
      if (!modal || !canvas || !viewport) return
      canvas.innerHTML = ""
      canvas.style.transform = ""
      const clone = document.createElement("img")
      clone.src = img.currentSrc || img.src
      clone.alt = img.alt || ""
      canvas.appendChild(clone)
      modal.hidden = false
      document.body.style.overflow = "hidden"
    })
  })

  // 6. Wikilink Hover Popover (desktop pointers only)
  const popover = document.getElementById("link-popover")
  if (popover && window.matchMedia("(hover: hover)").matches) {
    let timer: number | undefined
    const colEl = popover.querySelector<HTMLElement>("[data-pop-col]")
    const titleEl = popover.querySelector<HTMLElement>("[data-pop-title]")
    const sumEl = popover.querySelector<HTMLElement>("[data-pop-summary]")

    const hide = () => {
      window.clearTimeout(timer)
      popover.hidden = true
    }

    document.querySelectorAll<HTMLAnchorElement>("a.wikilink[data-preview-slug]").forEach((link) => {
      link.addEventListener("mouseenter", () => {
        const slug = link.dataset.previewSlug
        if (!slug) return
        timer = window.setTimeout(async () => {
          const index = await loadPopoverIndex()
          const entry = index[slug]
          if (!entry) return
          if (colEl) colEl.textContent = `${entry.column || "知识库"} · ${entry.readingMinutes} 分钟阅读`
          if (titleEl) titleEl.textContent = entry.title
          if (sumEl) sumEl.textContent = entry.summary || "点击阅读全文"

          const rect = link.getBoundingClientRect()
          const left = Math.min(window.innerWidth - 336, Math.max(12, rect.left))
          const showAbove = rect.bottom + 180 > window.innerHeight
          const top = showAbove ? Math.max(12, rect.top - 150) : rect.bottom + 8
          popover.style.left = `${left}px`
          popover.style.top = `${top}px`
          popover.hidden = false
        }, 220)
      })
      link.addEventListener("mouseleave", hide)
      link.addEventListener("click", hide)
    })
  }
}
