import mermaid from "mermaid"
import { getMermaidThemeVariables, normalizeMermaidSource, type ThemeMode } from "../lib/mermaid-normalizer"

interface PanZoomController {
  destroy: () => void
}

function getCurrentTheme(): ThemeMode {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
}

let renderIdCounter = 0

function configureMermaid(mode: ThemeMode) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    flowchart: {
      curve: "basis",
      htmlLabels: true,
      useMaxWidth: true,
      padding: 12,
      nodeSpacing: 28,
      rankSpacing: 38,
    },
    sequence: {
      useMaxWidth: true,
      mirrorActors: false,
      boxMargin: 10,
      messageMargin: 34,
    },
    state: {
      useMaxWidth: true,
    },
    gantt: {
      useMaxWidth: true,
    },
    themeVariables: getMermaidThemeVariables(mode),
    themeCSS: `
      .node rect, .node polygon, .node circle, .node ellipse {
        rx: 8px;
        ry: 8px;
        stroke-width: 1.5px;
      }
      .cluster rect {
        rx: 10px;
        ry: 10px;
        stroke-dasharray: 4 3;
      }
      .edgeLabel {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
      }
      .flowchart-link {
        stroke-width: 1.6px;
      }
      .nodeLabel, .label {
        font-size: 13px;
        line-height: 1.45;
      }
    `,
  })
}

async function renderBlock(figure: HTMLElement, mode: ThemeMode) {
  const stage = figure.querySelector<HTMLElement>("[data-mermaid-stage]")
  const sourceEl = figure.querySelector<HTMLScriptElement>("script.mermaid-source")
  if (!stage || !sourceEl) return

  const rawSource = (sourceEl.textContent ?? "").replace(/<\\\/script/gi, "</script").trim()
  if (!rawSource) return

  const normalized = normalizeMermaidSource(rawSource, mode)
  const id = `mm-svg-${++renderIdCounter}`

  try {
    const { svg, bindFunctions } = await mermaid.render(id, normalized)
    stage.innerHTML = svg
    figure.classList.remove("is-tall")
    figure.querySelector(".mermaid-tall-hint")?.remove()

    const svgEl = stage.querySelector("svg")
    if (svgEl) {
      const vb = svgEl.viewBox?.baseVal
      const vbW = vb && vb.width > 0 ? vb.width : Number.parseFloat(svgEl.style.maxWidth || "0")
      const vbH = vb && vb.height > 0 ? vb.height : 0

      svgEl.removeAttribute("width")
      svgEl.removeAttribute("height")

      if (vbW > 0) {
        let scale = 1
        if (vbH > 560 && vbH <= 900) {
          scale = Math.max(0.75, 560 / vbH)
        } else if (vbH > 900) {
          scale = 0.88
          figure.classList.add("is-tall")
          const hint = document.createElement("button")
          hint.type = "button"
          hint.className = "mermaid-tall-hint"
          hint.textContent = "纵向架构图较长 · 可在框内滚动浏览，或点击全屏缩放查看 ↗"
          hint.addEventListener("click", () => {
            figure.querySelector<HTMLButtonElement>("[data-mermaid-zoom]")?.click()
          })
          figure.appendChild(hint)
        }
        // Keep intrinsic ceiling so narrow vertical graphs never blow up to full prose width
        const targetW = Math.round(vbW * scale)
        svgEl.style.width = `${targetW}px`
        svgEl.style.maxWidth = "100%"
        svgEl.style.height = "auto"
      } else {
        svgEl.style.maxWidth = "100%"
        svgEl.style.height = "auto"
      }

      bindFunctions?.(stage)
    }
    figure.setAttribute("data-rendered-theme", mode)
  } catch (err) {
    console.warn("[mermaid] Render failed, showing source fallback:", err)
    stage.innerHTML = `<pre class="mermaid-fallback"><code>${rawSource
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</code></pre>`
  }
}

function attachPanZoom(viewport: HTMLElement, canvas: HTMLElement): PanZoomController {
  let scale = 1
  let tx = 0
  let ty = 0
  let dragging = false
  let startX = 0
  let startY = 0

  const apply = () => {
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }

  const fitToViewport = () => {
    const svg = canvas.querySelector("svg")
    if (!svg) return
    scale = 1
    tx = 0
    ty = 0
    apply()
    const vpRect = viewport.getBoundingClientRect()
    const svgRect = svg.getBoundingClientRect()
    if (svgRect.width > 0 && svgRect.height > 0) {
      const ratio = Math.min((vpRect.width * 0.88) / svgRect.width, (vpRect.height * 0.86) / svgRect.height, 2.2)
      scale = Math.max(0.4, ratio)
      tx = 0
      ty = 0
      apply()
    }
  }

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const next = Math.min(Math.max(scale * factor, 0.25), 5)
    if (clientX !== undefined && clientY !== undefined) {
      const rect = viewport.getBoundingClientRect()
      const ox = clientX - rect.left - rect.width / 2
      const oy = clientY - rect.top - rect.height / 2
      const ratio = next / scale
      tx = ox - (ox - tx) * ratio
      ty = oy - (oy - ty) * ratio
    }
    scale = next
    apply()
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 0.89
    zoomAt(factor, e.clientX, e.clientY)
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    dragging = true
    startX = e.clientX - tx
    startY = e.clientY - ty
    viewport.setPointerCapture(e.pointerId)
    viewport.style.cursor = "grabbing"
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    tx = e.clientX - startX
    ty = e.clientY - startY
    apply()
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    viewport.style.cursor = "grab"
    try {
      viewport.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  viewport.addEventListener("wheel", onWheel, { passive: false })
  viewport.addEventListener("pointerdown", onPointerDown)
  viewport.addEventListener("pointermove", onPointerMove)
  viewport.addEventListener("pointerup", onPointerUp)
  viewport.addEventListener("pointercancel", onPointerUp)

  const modal = viewport.closest("#diagram-modal")
  const zoomInBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-zoom-in]")
  const zoomOutBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-zoom-out]")
  const fitBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-fit]")
  const resetBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-reset]")

  const handleIn = () => zoomAt(1.2)
  const handleOut = () => zoomAt(0.82)
  const handleFit = () => fitToViewport()
  const handleReset = () => {
    scale = 1
    tx = 0
    ty = 0
    apply()
  }

  zoomInBtn?.addEventListener("click", handleIn)
  zoomOutBtn?.addEventListener("click", handleOut)
  fitBtn?.addEventListener("click", handleFit)
  resetBtn?.addEventListener("click", handleReset)

  requestAnimationFrame(fitToViewport)

  return {
    destroy() {
      viewport.removeEventListener("wheel", onWheel)
      viewport.removeEventListener("pointerdown", onPointerDown)
      viewport.removeEventListener("pointermove", onPointerMove)
      viewport.removeEventListener("pointerup", onPointerUp)
      viewport.removeEventListener("pointercancel", onPointerUp)
      zoomInBtn?.removeEventListener("click", handleIn)
      zoomOutBtn?.removeEventListener("click", handleOut)
      fitBtn?.removeEventListener("click", handleFit)
      resetBtn?.removeEventListener("click", handleReset)
    },
  }
}

export function initMermaidRuntime() {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-mermaid-block]"))
  if (blocks.length === 0) return

  let activeMode = getCurrentTheme()
  configureMermaid(activeMode)

  const renderQueue = new Set<HTMLElement>()
  let flushing = false

  const flushQueue = async () => {
    if (flushing) return
    flushing = true
    while (renderQueue.size > 0) {
      const next = renderQueue.values().next().value as HTMLElement
      renderQueue.delete(next)
      await renderBlock(next, activeMode)
    }
    flushing = false
  }

  const enqueue = (el: HTMLElement) => {
    if (el.getAttribute("data-rendered-theme") === activeMode) return
    renderQueue.add(el)
    void flushQueue()
  }

  // Render visible diagrams lazily as reader scrolls
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            enqueue(entry.target as HTMLElement)
          }
        }
      },
      { rootMargin: "450px 0px" },
    )
    for (const b of blocks) io.observe(b)
  } else {
    for (const b of blocks) enqueue(b)
  }

  // Re-render rendered diagrams on theme switch
  window.addEventListener("theme-change", () => {
    const nextMode = getCurrentTheme()
    if (nextMode === activeMode) return
    activeMode = nextMode
    configureMermaid(activeMode)
    for (const b of blocks) {
      if (b.hasAttribute("data-rendered-theme")) {
        enqueue(b)
      }
    }
  })

  // Setup modal & button actions
  const modal = document.getElementById("diagram-modal")
  const viewport = modal?.querySelector<HTMLElement>("[data-modal-viewport]")
  const canvas = modal?.querySelector<HTMLElement>("[data-modal-canvas]")
  const closeBtn = modal?.querySelector<HTMLButtonElement>("[data-modal-close]")
  let controller: PanZoomController | null = null

  const closeModal = () => {
    if (!modal || !canvas) return
    modal.hidden = true
    document.body.style.overflow = ""
    controller?.destroy()
    controller = null
    canvas.innerHTML = ""
  }

  const openModalWithSvg = (svg: SVGElement) => {
    if (!modal || !viewport || !canvas) return
    controller?.destroy()
    canvas.innerHTML = ""
    const clone = svg.cloneNode(true) as SVGElement
    clone.style.maxWidth = "none"
    clone.style.width = "auto"
    clone.style.height = "auto"
    canvas.appendChild(clone)
    modal.hidden = false
    document.body.style.overflow = "hidden"
    controller = attachPanZoom(viewport, canvas)
  }

  closeBtn?.addEventListener("click", closeModal)
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal()
  })
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && !modal.hidden) closeModal()
  })

  for (const figure of blocks) {
    const zoomBtn = figure.querySelector<HTMLButtonElement>("[data-mermaid-zoom]")
    const copyBtn = figure.querySelector<HTMLButtonElement>("[data-mermaid-copy]")
    const downloadBtn = figure.querySelector<HTMLButtonElement>("[data-mermaid-download]")
    const stage = figure.querySelector<HTMLElement>("[data-mermaid-stage]")
    const sourceEl = figure.querySelector<HTMLScriptElement>("script.mermaid-source")

    zoomBtn?.addEventListener("click", () => {
      const svg = stage?.querySelector("svg")
      if (svg) openModalWithSvg(svg)
    })

    stage?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) return
      const svg = stage.querySelector("svg")
      if (svg) openModalWithSvg(svg)
    })

    copyBtn?.addEventListener("click", async () => {
      const raw = (sourceEl?.textContent ?? "").replace(/<\\\/script/gi, "</script").trim()
      if (!raw) return
      await navigator.clipboard.writeText(raw)
      const orig = copyBtn.textContent
      copyBtn.textContent = "已复制"
      setTimeout(() => {
        copyBtn.textContent = orig
      }, 1500)
    })

    downloadBtn?.addEventListener("click", () => {
      const svg = stage?.querySelector("svg")
      if (!svg) return
      const serializer = new XMLSerializer()
      const blob = new Blob([serializer.serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "diagram.svg"
      a.click()
      URL.revokeObjectURL(url)
    })
  }
}
