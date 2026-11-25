export function initReadingPrefs(signal: AbortSignal) {
  const root = document.documentElement

  const themeBtn = document.getElementById("theme-toggle-btn")
  themeBtn?.addEventListener(
    "click",
    () => {
      const current = root.getAttribute("data-theme") === "dark" ? "dark" : "light"
      const next = current === "dark" ? "light" : "dark"
      root.setAttribute("data-theme", next)
      localStorage.setItem("ting-theme", next)
      window.dispatchEvent(new CustomEvent("theme-change", { detail: { theme: next } }))
    },
    { signal },
  )

  const focusBtn = document.getElementById("focus-toggle-btn")
  const syncFocusBtn = () => {
    const isFocus = root.getAttribute("data-focus") === "true"
    focusBtn?.classList.toggle("is-active", isFocus)
  }
  syncFocusBtn()

  focusBtn?.addEventListener(
    "click",
    () => {
      const next = root.getAttribute("data-focus") === "true" ? "false" : "true"
      root.setAttribute("data-focus", next)
      localStorage.setItem("ting-focus", next)
      syncFocusBtn()
    },
    { signal },
  )

  // Prefs popover toggle
  const prefsToggle = document.getElementById("prefs-toggle-btn")
  const prefsPopover = document.getElementById("prefs-popover")

  prefsToggle?.addEventListener(
    "click",
    (e) => {
      e.stopPropagation()
      if (!prefsPopover) return
      const nextHidden = !prefsPopover.hidden
      prefsPopover.hidden = nextHidden
      prefsToggle.classList.toggle("is-active", !nextHidden)
    },
    { signal },
  )

  document.addEventListener(
    "click",
    (e) => {
      if (!prefsPopover || prefsPopover.hidden) return
      if (!prefsPopover.contains(e.target as Node) && e.target !== prefsToggle) {
        prefsPopover.hidden = true
        prefsToggle?.classList.remove("is-active")
      }
    },
    { signal },
  )

  // Segmented controls for font size & reading width
  const updateSelected = (group: string, value: string) => {
    document.querySelectorAll<HTMLButtonElement>(`[data-pref-group="${group}"]`).forEach((btn) => {
      btn.classList.toggle("is-selected", btn.dataset.prefValue === value)
    })
  }

  updateSelected("fontSize", root.getAttribute("data-font-size") || "md")
  updateSelected("width", root.getAttribute("data-width") || "normal")

  document.querySelectorAll<HTMLButtonElement>("[data-pref-group]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        const group = btn.dataset.prefGroup
        const value = btn.dataset.prefValue
        if (!group || !value) return
        if (group === "fontSize") {
          root.setAttribute("data-font-size", value)
          localStorage.setItem("ting-font-size", value)
        } else if (group === "width") {
          root.setAttribute("data-width", value)
          localStorage.setItem("ting-width", value)
        }
        updateSelected(group, value)
      },
      { signal },
    )
  })

  // Mobile column sidebar drawer
  const mobileMenuBtn = document.getElementById("mobile-menu-btn")
  mobileMenuBtn?.addEventListener(
    "click",
    () => {
      document.body.classList.toggle("mobile-drawer-open")
    },
    { signal },
  )
  document.addEventListener(
    "click",
    (e) => {
      if (!document.body.classList.contains("mobile-drawer-open")) return
      const target = e.target as HTMLElement
      if (!target.closest(".column-sidebar") && !target.closest("#mobile-menu-btn")) {
        document.body.classList.remove("mobile-drawer-open")
      }
    },
    { signal },
  )
}
