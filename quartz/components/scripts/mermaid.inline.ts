import { registerEscapeHandler, removeAllChildren } from "./util"

interface Position {
  x: number
  y: number
}

class DiagramPanZoom {
  private isDragging = false
  private startPan: Position = { x: 0, y: 0 }
  private currentPan: Position = { x: 0, y: 0 }
  private scale = 1
  private readonly MIN_SCALE = 0.5
  private readonly MAX_SCALE = 3

  cleanups: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private content: HTMLElement,
  ) {
    this.setupEventListeners()
    this.setupNavigationControls()
    this.resetTransform()
  }

  private setupEventListeners() {
    // Mouse drag events
    const mouseDownHandler = this.onMouseDown.bind(this)
    const mouseMoveHandler = this.onMouseMove.bind(this)
    const mouseUpHandler = this.onMouseUp.bind(this)

    // Touch drag events
    const touchStartHandler = this.onTouchStart.bind(this)
    const touchMoveHandler = this.onTouchMove.bind(this)
    const touchEndHandler = this.onTouchEnd.bind(this)

    const resizeHandler = this.resetTransform.bind(this)

    this.container.addEventListener("mousedown", mouseDownHandler)
    document.addEventListener("mousemove", mouseMoveHandler)
    document.addEventListener("mouseup", mouseUpHandler)

    this.container.addEventListener("touchstart", touchStartHandler, { passive: false })
    document.addEventListener("touchmove", touchMoveHandler, { passive: false })
    document.addEventListener("touchend", touchEndHandler)

    window.addEventListener("resize", resizeHandler)

    this.cleanups.push(
      () => this.container.removeEventListener("mousedown", mouseDownHandler),
      () => document.removeEventListener("mousemove", mouseMoveHandler),
      () => document.removeEventListener("mouseup", mouseUpHandler),
      () => this.container.removeEventListener("touchstart", touchStartHandler),
      () => document.removeEventListener("touchmove", touchMoveHandler),
      () => document.removeEventListener("touchend", touchEndHandler),
      () => window.removeEventListener("resize", resizeHandler),
    )
  }

  cleanup() {
    for (const cleanup of this.cleanups) {
      cleanup()
    }
  }

  private setupNavigationControls() {
    const controls = document.createElement("div")
    controls.className = "mermaid-controls"

    // Zoom controls
    const zoomIn = this.createButton("+", () => this.zoom(0.1))
    const zoomOut = this.createButton("-", () => this.zoom(-0.1))
    const resetBtn = this.createButton("Reset", () => this.resetTransform())

    controls.appendChild(zoomOut)
    controls.appendChild(resetBtn)
    controls.appendChild(zoomIn)

    this.container.appendChild(controls)
  }

  private createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.textContent = text
    button.className = "mermaid-control-button"
    button.addEventListener("click", onClick)
    window.addCleanup(() => button.removeEventListener("click", onClick))
    return button
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return // Only handle left click
    this.isDragging = true
    this.startPan = { x: e.clientX - this.currentPan.x, y: e.clientY - this.currentPan.y }
    this.container.style.cursor = "grabbing"
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDragging) return
    e.preventDefault()

    this.currentPan = {
      x: e.clientX - this.startPan.x,
      y: e.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onMouseUp() {
    this.isDragging = false
    this.container.style.cursor = "grab"
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    this.isDragging = true
    const touch = e.touches[0]
    this.startPan = { x: touch.clientX - this.currentPan.x, y: touch.clientY - this.currentPan.y }
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.isDragging || e.touches.length !== 1) return
    e.preventDefault() // Prevent scrolling

    const touch = e.touches[0]
    this.currentPan = {
      x: touch.clientX - this.startPan.x,
      y: touch.clientY - this.startPan.y,
    }

    this.updateTransform()
  }

  private onTouchEnd() {
    this.isDragging = false
  }

  private zoom(delta: number) {
    const newScale = Math.min(Math.max(this.scale + delta, this.MIN_SCALE), this.MAX_SCALE)

    // Zoom around center
    const rect = this.content.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const scaleDiff = newScale - this.scale
    this.currentPan.x -= centerX * scaleDiff
    this.currentPan.y -= centerY * scaleDiff

    this.scale = newScale
    this.updateTransform()
  }

  private updateTransform() {
    this.content.style.transform = `translate(${this.currentPan.x}px, ${this.currentPan.y}px) scale(${this.scale})`
  }

  private resetTransform() {
    const svg = this.content.querySelector("svg")!
    const rect = svg.getBoundingClientRect()
    const width = rect.width / this.scale
    const height = rect.height / this.scale

    this.scale = 1
    this.currentPan = {
      x: (this.container.clientWidth - width) / 2,
      y: (this.container.clientHeight - height) / 2,
    }
    this.updateTransform()
  }
}

// Read all the CSS variables that drive mermaid's organic look-and-feel.
// Base palette + derived `--mm-*` tokens (defined in custom.scss for both
// light & dark themes) keep every mermaid diagram on-brand.
const cssVars = [
  // Base palette
  "--secondary",
  "--tertiary",
  "--gray",
  "--light",
  "--lightgray",
  "--highlight",
  "--dark",
  "--darkgray",
  "--bodyFont",
  "--codeFont",
  // Mermaid-specific organic tokens
  "--mm-bg",
  "--mm-node-bg",
  "--mm-node-border",
  "--mm-text",
  "--mm-line",
  "--mm-cluster-bg",
  "--mm-cluster-border",
  "--mm-note-bg",
  "--mm-note-border",
  "--mm-actor-bg",
  "--mm-actor-border",
  "--mm-active-bg",
  "--mm-active-border",
  "--mm-edge-label-bg",
  "--mm-fill-0",
  "--mm-fill-1",
  "--mm-fill-2",
  "--mm-fill-3",
  "--mm-fill-4",
  "--mm-fill-5",
  "--mm-fill-6",
  "--mm-fill-7",
  "--mm-error-bg",
  "--mm-error-text",
] as const

let mermaidImport = undefined
document.addEventListener("nav", async () => {
  const center = document.querySelector(".center") as HTMLElement
  const nodes = center.querySelectorAll("code.mermaid") as NodeListOf<HTMLElement>
  if (nodes.length === 0) return

  mermaidImport ||= await import(
    // @ts-ignore
    "https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.4.0/mermaid.esm.min.mjs"
  )
  const mermaid = mermaidImport.default

  const textMapping: WeakMap<HTMLElement, string> = new WeakMap()
  for (const node of nodes) {
    textMapping.set(node, node.innerText)
  }

  async function renderMermaid() {
    // de-init any other diagrams
    for (const node of nodes) {
      node.removeAttribute("data-processed")
      const oldText = textMapping.get(node)
      if (oldText) {
        node.innerHTML = oldText
      }
    }

    const computedStyleMap = cssVars.reduce(
      (acc, key) => {
        acc[key] = window.getComputedStyle(document.documentElement).getPropertyValue(key)
        return acc
      },
      {} as Record<(typeof cssVars)[number], string>,
    )

    // Note: dark/light is handled entirely via CSS vars (--mm-* flip on
    // [saved-theme="dark"]). The "themechange" listener re-runs this function
    // so themeVariables always reflect the current palette.
    const m = computedStyleMap
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      // `base` lets themeVariables fully take over; we feed it our organic palette
      theme: "base",
      // Softer, more organic edge curves for flowcharts
      flowchart: { curve: "basis", htmlLabels: true, useMaxWidth: true },
      sequence: { useMaxWidth: true, mirrorActors: false },
      themeVariables: {
        // Typography — body sans-serif gives nodes a softer, less terminal feel
        fontFamily: m["--bodyFont"] || m["--codeFont"],
        fontSize: "14px",

        // Background / canvas
        background: m["--mm-bg"],
        mainBkg: m["--mm-node-bg"],
        secondBkg: m["--mm-fill-1"],
        tertiaryColor: m["--mm-fill-2"],

        // Primary node (default flowchart node)
        primaryColor: m["--mm-node-bg"],
        primaryTextColor: m["--mm-text"],
        primaryBorderColor: m["--mm-node-border"],

        // Secondary / tertiary node tiers
        secondaryColor: m["--mm-fill-1"],
        secondaryTextColor: m["--mm-text"],
        secondaryBorderColor: m["--mm-note-border"],
        tertiaryTextColor: m["--mm-text"],
        tertiaryBorderColor: m["--mm-cluster-border"],

        // Lines / edges / labels
        lineColor: m["--mm-line"],
        textColor: m["--mm-text"],
        titleColor: m["--mm-text"],
        edgeLabelBackground: m["--mm-edge-label-bg"],
        labelTextColor: m["--mm-text"],

        // Cluster (subgraph) styling
        clusterBkg: m["--mm-cluster-bg"],
        clusterBorder: m["--mm-cluster-border"],

        // Note styling (used in flowchart + sequence + class)
        noteBkgColor: m["--mm-note-bg"],
        noteBorderColor: m["--mm-note-border"],
        noteTextColor: m["--mm-text"],

        // Sequence diagram — actors, signals, activations
        actorBkg: m["--mm-actor-bg"],
        actorBorder: m["--mm-actor-border"],
        actorTextColor: m["--mm-text"],
        actorLineColor: m["--mm-line"],
        signalColor: m["--mm-text"],
        signalTextColor: m["--mm-text"],
        labelBoxBkgColor: m["--mm-fill-1"],
        labelBoxBorderColor: m["--mm-note-border"],
        loopTextColor: m["--mm-text"],
        activationBkgColor: m["--mm-active-bg"],
        activationBorderColor: m["--mm-active-border"],
        sequenceNumberColor: m["--mm-bg"],

        // Gantt
        sectionBkgColor: m["--mm-fill-0"],
        altSectionBkgColor: m["--mm-fill-2"],
        sectionBkgColor2: m["--mm-fill-3"],
        gridColor: m["--mm-cluster-border"],
        taskBkgColor: m["--mm-actor-bg"],
        taskBorderColor: m["--mm-actor-border"],
        taskTextColor: m["--mm-text"],
        taskTextLightColor: m["--mm-bg"],
        taskTextOutsideColor: m["--mm-text"],
        taskTextDarkColor: m["--mm-text"],
        activeTaskBkgColor: m["--mm-active-bg"],
        activeTaskBorderColor: m["--mm-active-border"],
        doneTaskBkgColor: m["--mm-cluster-bg"],
        doneTaskBorderColor: m["--mm-cluster-border"],
        critBkgColor: m["--mm-error-bg"],
        critBorderColor: m["--mm-error-text"],
        todayLineColor: m["--tertiary"],

        // State diagram
        labelColor: m["--mm-text"],
        errorBkgColor: m["--mm-error-bg"],
        errorTextColor: m["--mm-error-text"],

        // Flowchart cluster fill rotation (used when nodes lack explicit class)
        fillType0: m["--mm-fill-0"],
        fillType1: m["--mm-fill-1"],
        fillType2: m["--mm-fill-2"],
        fillType3: m["--mm-fill-3"],
        fillType4: m["--mm-fill-4"],
        fillType5: m["--mm-fill-5"],
        fillType6: m["--mm-fill-6"],
        fillType7: m["--mm-fill-7"],

        // Pie chart palette
        pie1: m["--secondary"],
        pie2: m["--tertiary"],
        pie3: m["--mm-fill-3"],
        pie4: m["--mm-fill-5"],
        pie5: m["--mm-fill-6"],
        pie6: m["--mm-fill-4"],
        pie7: m["--mm-fill-7"],
        pie8: m["--mm-fill-0"],
        pie9: m["--mm-fill-1"],
        pie10: m["--mm-fill-2"],
        pie11: m["--gray"],
        pie12: m["--darkgray"],
        pieTitleTextColor: m["--mm-text"],
        pieSectionTextColor: m["--mm-text"],
        pieLegendTextColor: m["--mm-text"],
        pieStrokeColor: m["--mm-bg"],
        pieOuterStrokeColor: m["--mm-line"],

        // Git graph branch colors
        git0: m["--secondary"],
        git1: m["--tertiary"],
        git2: m["--mm-fill-5"],
        git3: m["--mm-fill-6"],
        git4: m["--mm-fill-3"],
        git5: m["--mm-fill-4"],
        git6: m["--mm-fill-7"],
        git7: m["--gray"],
        gitBranchLabel0: m["--mm-bg"],
        gitBranchLabel1: m["--mm-bg"],
        gitBranchLabel2: m["--mm-text"],
        gitBranchLabel3: m["--mm-text"],
        gitBranchLabel4: m["--mm-text"],
        gitBranchLabel5: m["--mm-text"],
        gitBranchLabel6: m["--mm-text"],
        gitBranchLabel7: m["--mm-text"],
        commitLabelColor: m["--mm-text"],
        commitLabelBackground: m["--mm-edge-label-bg"],
        tagLabelColor: m["--mm-text"],
        tagLabelBackground: m["--mm-fill-1"],
        tagLabelBorder: m["--mm-note-border"],
      },
    })

    await mermaid.run({ nodes })
  }

  await renderMermaid()
  document.addEventListener("themechange", renderMermaid)
  window.addCleanup(() => document.removeEventListener("themechange", renderMermaid))

  for (let i = 0; i < nodes.length; i++) {
    const codeBlock = nodes[i] as HTMLElement
    const pre = codeBlock.parentElement as HTMLPreElement
    const clipboardBtn = pre.querySelector(".clipboard-button") as HTMLButtonElement
    const expandBtn = pre.querySelector(".expand-button") as HTMLButtonElement

    const clipboardStyle = window.getComputedStyle(clipboardBtn)
    const clipboardWidth =
      clipboardBtn.offsetWidth +
      parseFloat(clipboardStyle.marginLeft || "0") +
      parseFloat(clipboardStyle.marginRight || "0")

    // Set expand button position
    expandBtn.style.right = `calc(${clipboardWidth}px + 0.3rem)`
    pre.prepend(expandBtn)

    // query popup container
    const popupContainer = pre.querySelector("#mermaid-container") as HTMLElement
    if (!popupContainer) return

    let panZoom: DiagramPanZoom | null = null
    function showMermaid() {
      const container = popupContainer.querySelector("#mermaid-space") as HTMLElement
      const content = popupContainer.querySelector(".mermaid-content") as HTMLElement
      if (!content) return
      removeAllChildren(content)

      // Clone the mermaid content
      const mermaidContent = codeBlock.querySelector("svg")!.cloneNode(true) as SVGElement
      content.appendChild(mermaidContent)

      // Show container
      popupContainer.classList.add("active")
      container.style.cursor = "grab"

      // Initialize pan-zoom after showing the popup
      panZoom = new DiagramPanZoom(container, content)
    }

    function hideMermaid() {
      popupContainer.classList.remove("active")
      panZoom?.cleanup()
      panZoom = null
    }

    expandBtn.addEventListener("click", showMermaid)
    registerEscapeHandler(popupContainer, hideMermaid)

    window.addCleanup(() => {
      panZoom?.cleanup()
      expandBtn.removeEventListener("click", showMermaid)
    })
  }
})
