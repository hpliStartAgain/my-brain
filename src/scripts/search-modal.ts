interface MetaDoc {
  slug: string
  href: string
  title: string
  domain: string
  column: string
  tags: string[]
  summary: string
}

interface SearchHit {
  href: string
  title: string
  sub: string
  excerpt: string
}

let pagefindMod: any = null
let pagefindChecked = false
let metaDocs: MetaDoc[] | null = null

async function getPagefind() {
  if (pagefindChecked) return pagefindMod
  pagefindChecked = true
  try {
    const pfUrl = "/pagefind/pagefind.js"
    pagefindMod = await import(/* @vite-ignore */ pfUrl)
    await pagefindMod.options({ excerptLength: 22 })
  } catch {
    pagefindMod = null
  }
  return pagefindMod
}

async function getMetaDocs(): Promise<MetaDoc[]> {
  if (metaDocs) return metaDocs
  try {
    const res = await fetch("/search-meta.json")
    metaDocs = (await res.json()) as MetaDoc[]
  } catch {
    metaDocs = []
  }
  return metaDocs
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderResults(container: HTMLElement, hits: SearchHit[], query: string) {
  if (hits.length === 0) {
    container.innerHTML = `<div class="search-empty">${
      query ? `没有找到与「${escapeHtml(query)}」相关的内容` : "输入关键词检索 1,200+ 篇专栏正文、标题或标签"
    }</div>`
    return
  }

  container.innerHTML = hits
    .map(
      (hit, idx) => `
      <a class="search-result-item${idx === 0 ? " is-selected" : ""}" href="${escapeHtml(hit.href)}">
        <div class="search-result-title">${escapeHtml(hit.title)}</div>
        ${hit.sub ? `<div class="search-result-sub">${escapeHtml(hit.sub)}</div>` : ""}
        ${hit.excerpt ? `<div class="search-result-excerpt">${hit.excerpt}</div>` : ""}
      </a>
    `,
    )
    .join("")
}

export function initSearchModal(signal: AbortSignal) {
  const modal = document.getElementById("search-modal")
  const input = document.getElementById("search-input") as HTMLInputElement | null
  const resultsEl = document.getElementById("search-results")
  const triggerBtn = document.getElementById("search-trigger-btn")
  if (!modal || !input || !resultsEl) return

  let debounceTimer: number | undefined
  let activeIndex = 0

  signal.addEventListener("abort", () => {
    window.clearTimeout(debounceTimer)
    document.body.style.overflow = ""
  })

  const open = () => {
    modal.hidden = false
    document.body.style.overflow = "hidden"
    input.focus()
    input.select()
    void getPagefind()
    void getMetaDocs()
    if (!input.value.trim()) {
      renderResults(resultsEl, [], "")
    }
  }

  const close = () => {
    modal.hidden = true
    document.body.style.overflow = ""
  }

  triggerBtn?.addEventListener("click", open, { signal })
  modal.addEventListener(
    "click",
    (e) => {
      if (e.target === modal) close()
    },
    { signal },
  )

  resultsEl.addEventListener(
    "click",
    (e) => {
      if ((e.target as HTMLElement).closest(".search-result-item")) {
        close()
      }
    },
    { signal },
  )

  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        if (modal.hidden) open()
        else close()
        return
      }
      if (modal.hidden) return
      if (e.key === "Escape") {
        close()
        return
      }

      const items = Array.from(resultsEl.querySelectorAll<HTMLAnchorElement>(".search-result-item"))
      if (items.length === 0) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        activeIndex = (activeIndex + 1) % items.length
        items.forEach((el, i) => el.classList.toggle("is-selected", i === activeIndex))
        items[activeIndex]?.scrollIntoView({ block: "nearest" })
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        activeIndex = (activeIndex - 1 + items.length) % items.length
        items.forEach((el, i) => el.classList.toggle("is-selected", i === activeIndex))
        items[activeIndex]?.scrollIntoView({ block: "nearest" })
      } else if (e.key === "Enter") {
        const target = items[activeIndex]
        if (target) {
          e.preventDefault()
          close()
          target.click()
        }
      }
    },
    { signal },
  )

  const runSearch = async (query: string) => {
    const q = query.trim()
    activeIndex = 0
    if (!q) {
      renderResults(resultsEl, [], "")
      return
    }

    const pf = await getPagefind()
    if (pf) {
      const res = await pf.search(q)
      const top = await Promise.all(res.results.slice(0, 14).map((r: any) => r.data()))
      const hits: SearchHit[] = top.map((d: any) => ({
        href: d.url,
        title: d.meta?.title || d.url,
        sub: d.meta?.column || "",
        excerpt: d.excerpt || "",
      }))
      renderResults(resultsEl, hits, q)
      return
    }

    // Fallback for astro dev before pagefind index exists
    const docs = await getMetaDocs()
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = docs
      .map((doc) => {
        const titleL = doc.title.toLowerCase()
        const colL = doc.column.toLowerCase()
        const tagL = doc.tags.join(" ").toLowerCase()
        const sumL = doc.summary.toLowerCase()
        let score = 0
        for (const t of terms) {
          if (titleL.includes(t)) score += 10
          else if (tagL.includes(t)) score += 5
          else if (colL.includes(t)) score += 3
          else if (sumL.includes(t)) score += 2
          else return null
        }
        return { doc, score }
      })
      .filter((x): x is { doc: MetaDoc; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16)

    renderResults(
      resultsEl,
      scored.map(({ doc }) => ({
        href: doc.href,
        title: doc.title,
        sub: doc.column,
        excerpt: escapeHtml(doc.summary),
      })),
      q,
    )
  }

  input.addEventListener(
    "input",
    () => {
      window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(() => {
        void runSearch(input.value)
      }, 110)
    },
    { signal },
  )
}
