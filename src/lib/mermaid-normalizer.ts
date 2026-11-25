export type ThemeMode = "light" | "dark"

export type SemanticTone =
  | "sage"
  | "crimson"
  | "amber"
  | "slate"
  | "lavender"
  | "clay"
  | "neutral"

interface ToneTokens {
  fill: string
  stroke: string
  color: string
}

const LIGHT_TONES: Record<SemanticTone, ToneTokens> = {
  sage: { fill: "#edf5ee", stroke: "#5c8c66", color: "#1f3323" },
  crimson: { fill: "#fceeed", stroke: "#c45a4b", color: "#3d1b17" },
  amber: { fill: "#fcf3e1", stroke: "#bf842e", color: "#3b290f" },
  slate: { fill: "#ecf3f8", stroke: "#527a9c", color: "#1a2d3d" },
  lavender: { fill: "#f3eff9", stroke: "#7d6ba3", color: "#29203b" },
  clay: { fill: "#faede7", stroke: "#c96442", color: "#3b1e14" },
  neutral: { fill: "#efede4", stroke: "#b8b5a7", color: "#2b2a27" },
}

const DARK_TONES: Record<SemanticTone, ToneTokens> = {
  sage: { fill: "#1d2c20", stroke: "#79ab83", color: "#dce9de" },
  crimson: { fill: "#341e1c", stroke: "#db7a6c", color: "#f3deda" },
  amber: { fill: "#302615", stroke: "#d9a252", color: "#f2e6d0" },
  slate: { fill: "#1b2833", stroke: "#7ea6c7", color: "#dbe8f2" },
  lavender: { fill: "#262133", stroke: "#a896cc", color: "#e6e0f2" },
  clay: { fill: "#352119", stroke: "#df8060", color: "#f5e3db" },
  neutral: { fill: "#272623", stroke: "#636158", color: "#e6e4da" },
}

const NAMED_COLORS: Record<string, string> = {
  red: "#ef4444",
  crimson: "#dc2626",
  pink: "#ec4899",
  magenta: "#d946ef",
  orange: "#f97316",
  amber: "#f59e0b",
  gold: "#eab308",
  yellow: "#eab308",
  green: "#22c55e",
  lime: "#84cc16",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  aqua: "#06b6d4",
  blue: "#3b82f6",
  navy: "#1e40af",
  indigo: "#6366f1",
  purple: "#a855f7",
  violet: "#8b5cf6",
  gray: "#78716c",
  grey: "#78716c",
  white: "#ffffff",
  black: "#18181b",
}

function parseColorToRgb(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  const hex = NAMED_COLORS[trimmed] ?? trimmed

  if (hex.startsWith("#")) {
    const body = hex.slice(1)
    if (body.length === 3 || body.length === 4) {
      const r = Number.parseInt(body[0] + body[0], 16)
      const g = Number.parseInt(body[1] + body[1], 16)
      const b = Number.parseInt(body[2] + body[2], 16)
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b]
    }
    if (body.length === 6 || body.length === 8) {
      const r = Number.parseInt(body.slice(0, 2), 16)
      const g = Number.parseInt(body.slice(2, 4), 16)
      const b = Number.parseInt(body.slice(4, 6), 16)
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) return [r, g, b]
    }
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return [
      Number.parseInt(rgbMatch[1], 10),
      Number.parseInt(rgbMatch[2], 10),
      Number.parseInt(rgbMatch[3], 10),
    ]
  }

  return null
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2

  if (max === min) {
    return { h: 0, s: 0, l }
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  return { h, s, l }
}

function classifyColor(raw: string | undefined): { tone: SemanticTone; saturation: number } | null {
  const rgb = parseColorToRgb(raw)
  if (!rgb) return null
  const { h, s } = rgbToHsl(rgb[0], rgb[1], rgb[2])
  if (s < 0.16) {
    return { tone: "neutral", saturation: s }
  }
  if (h < 18 || h >= 325) return { tone: "crimson", saturation: s }
  if (h < 38) return { tone: "clay", saturation: s }
  if (h < 68) return { tone: "amber", saturation: s }
  if (h < 168) return { tone: "sage", saturation: s }
  if (h < 252) return { tone: "slate", saturation: s }
  return { tone: "lavender", saturation: s }
}

function parseStyleProps(propStr: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of propStr.split(",")) {
    const idx = part.indexOf(":")
    if (idx === -1) continue
    const k = part.slice(0, idx).trim().toLowerCase()
    const v = part.slice(idx + 1).trim()
    if (k && v) map.set(k, v)
  }
  return map
}

function pickToneFromProps(props: Map<string, string>): SemanticTone | null {
  const fillInfo = classifyColor(props.get("fill"))
  const strokeInfo = classifyColor(props.get("stroke"))

  // Dracula pattern often sets neutral dark fill (#44475a) + vivid stroke (#50fa7b).
  // Prefer whichever color carries stronger chromatic signal.
  if (strokeInfo && strokeInfo.tone !== "neutral") {
    if (!fillInfo || fillInfo.tone === "neutral" || strokeInfo.saturation > fillInfo.saturation + 0.1) {
      return strokeInfo.tone
    }
  }
  if (fillInfo) return fillInfo.tone
  if (strokeInfo) return strokeInfo.tone
  return null
}

function formatProps(props: Map<string, string>): string {
  return Array.from(props.entries())
    .map(([k, v]) => `${k}:${v}`)
    .join(",")
}

function stripInitDirective(source: string): string {
  return source.replace(/%%\{init:\s*([\s\S]*?)\}%%/g, (full, inner: string) => {
    // Most occurrences are pure theme directives: %%{init: {'theme': 'dracula'}}%%
    const hasNonThemeKeys = /\b(flowchart|sequence|gantt|class|state|er|journey|pie|gitGraph|curve|padding)\b/.test(
      inner,
    )
    if (!hasNonThemeKeys) return ""
    // Strip theme / themeVariables keys while keeping layout hints
    const cleaned = inner
      .replace(/(['"]?theme['"]?\s*:\s*['"][^'"]*['"]\s*,?)/g, "")
      .replace(/(['"]?themeVariables['"]?\s*:\s*\{[^}]*\}\s*,?)/g, "")
      .replace(/,\s*}/g, "}")
      .trim()
    if (cleaned === "{}" || cleaned === "") return ""
    return `%%{init: ${cleaned}}%%`
  })
}

export function normalizeMermaidSource(rawSource: string, mode: ThemeMode): string {
  const palette = mode === "dark" ? DARK_TONES : LIGHT_TONES
  const withoutInit = stripInitDirective(rawSource)

  const lines = withoutInit.split(/\r?\n/)
  const out: string[] = []

  for (const line of lines) {
    // 1. style <nodeId> fill:#...,stroke:#...,color:#...
    const styleMatch = line.match(/^(\s*style\s+\S+\s+)(.+)$/i)
    if (styleMatch) {
      const props = parseStyleProps(styleMatch[2])
      const tone = pickToneFromProps(props)
      if (tone) {
        const tokens = palette[tone]
        if (props.has("fill") && props.get("fill") !== "none") props.set("fill", tokens.fill)
        if (props.has("stroke") || props.has("fill")) props.set("stroke", tokens.stroke)
        if (!props.has("stroke-width")) props.set("stroke-width", "1.6px")
        props.set("color", tokens.color)
        out.push(`${styleMatch[1]}${formatProps(props)}`)
        continue
      }
    }

    // 2. classDef <name> fill:#...,stroke:#...
    const classDefMatch = line.match(/^(\s*classDef\s+\S+\s+)(.+)$/i)
    if (classDefMatch) {
      const props = parseStyleProps(classDefMatch[2])
      const tone = pickToneFromProps(props)
      if (tone) {
        const tokens = palette[tone]
        if (props.has("fill") && props.get("fill") !== "none") props.set("fill", tokens.fill)
        if (props.has("stroke") || props.has("fill")) props.set("stroke", tokens.stroke)
        if (!props.has("stroke-width")) props.set("stroke-width", "1.6px")
        props.set("color", tokens.color)
        out.push(`${classDefMatch[1]}${formatProps(props)}`)
        continue
      }
    }

    // 3. linkStyle <idx> stroke:#...,stroke-width:...
    const linkMatch = line.match(/^(\s*linkStyle\s+\S+\s+)(.+)$/i)
    if (linkMatch) {
      const props = parseStyleProps(linkMatch[2])
      const strokeInfo = classifyColor(props.get("stroke"))
      if (strokeInfo) {
        const tokens = palette[strokeInfo.tone]
        props.set("stroke", strokeInfo.tone === "neutral" ? tokens.stroke : tokens.stroke)
        if (!props.has("stroke-width")) props.set("stroke-width", "1.8px")
        out.push(`${linkMatch[1]}${formatProps(props)}`)
        continue
      }
    }

    out.push(line)
  }

  return out.join("\n").replace(/^\s*\n+/, "")
}

export function getMermaidThemeVariables(mode: ThemeMode): Record<string, string> {
  if (mode === "dark") {
    return {
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif',
      fontSize: "14px",
      background: "transparent",
      mainBkg: "#23221f",
      secondBkg: "#2c2b27",
      tertiaryColor: "#1d1c1a",

      primaryColor: "#23221f",
      primaryTextColor: "#e6e4da",
      primaryBorderColor: "#57554d",

      secondaryColor: "#2c2b27",
      secondaryTextColor: "#e6e4da",
      secondaryBorderColor: "#df8060",

      tertiaryTextColor: "#e6e4da",
      tertiaryBorderColor: "#42403b",

      lineColor: "#8a877d",
      textColor: "#e6e4da",
      titleColor: "#faf9f5",
      edgeLabelBackground: "#1c1b19",
      labelTextColor: "#e6e4da",

      clusterBkg: "#1a1917",
      clusterBorder: "#45433d",

      noteBkgColor: "#302615",
      noteBorderColor: "#d9a252",
      noteTextColor: "#f2e6d0",

      actorBkg: "#272623",
      actorBorder: "#636158",
      actorTextColor: "#e6e4da",
      actorLineColor: "#636158",
      signalColor: "#a8a59b",
      signalTextColor: "#e6e4da",
      labelBoxBkgColor: "#2c2b27",
      labelBoxBorderColor: "#df8060",
      loopTextColor: "#e6e4da",
      activationBkgColor: "#352119",
      activationBorderColor: "#df8060",
      sequenceNumberColor: "#161614",

      labelColor: "#e6e4da",
      errorBkgColor: "#341e1c",
      errorTextColor: "#f3deda",

      fillType0: "#23221f",
      fillType1: "#1b2833",
      fillType2: "#1d2c20",
      fillType3: "#302615",
      fillType4: "#262133",
      fillType5: "#352119",
      fillType6: "#341e1c",
      fillType7: "#272623",

      sectionBkgColor: "#23221f",
      altSectionBkgColor: "#1a1917",
      sectionBkgColor2: "#272623",
      gridColor: "#3d3b35",
      taskBkgColor: "#2c2b27",
      taskBorderColor: "#636158",
      taskTextColor: "#e6e4da",
      taskTextLightColor: "#161614",
      taskTextOutsideColor: "#e6e4da",
      taskTextDarkColor: "#e6e4da",
      activeTaskBkgColor: "#352119",
      activeTaskBorderColor: "#df8060",
      doneTaskBkgColor: "#1d2c20",
      doneTaskBorderColor: "#79ab83",
      critBkgColor: "#341e1c",
      critBorderColor: "#db7a6c",
      todayLineColor: "#df8060",

      pie1: "#df8060",
      pie2: "#79ab83",
      pie3: "#7ea6c7",
      pie4: "#d9a252",
      pie5: "#a896cc",
      pie6: "#db7a6c",
      pie7: "#8f8d82",
      pie8: "#5c8c66",
      pie9: "#527a9c",
      pie10: "#c96442",
      pie11: "#bf842e",
      pie12: "#7d6ba3",
      pieTitleTextColor: "#faf9f5",
      pieSectionTextColor: "#faf9f5",
      pieLegendTextColor: "#e6e4da",
      pieStrokeColor: "#161614",
      pieOuterStrokeColor: "#57554d",

      git0: "#df8060",
      git1: "#79ab83",
      git2: "#7ea6c7",
      git3: "#d9a252",
      git4: "#a896cc",
      git5: "#db7a6c",
      git6: "#8f8d82",
      git7: "#c96442",
      gitBranchLabel0: "#161614",
      gitBranchLabel1: "#161614",
      gitBranchLabel2: "#161614",
      gitBranchLabel3: "#161614",
      gitBranchLabel4: "#161614",
      gitBranchLabel5: "#161614",
      gitBranchLabel6: "#161614",
      gitBranchLabel7: "#161614",
      commitLabelColor: "#e6e4da",
      commitLabelBackground: "#23221f",
      tagLabelColor: "#e6e4da",
      tagLabelBackground: "#352119",
      tagLabelBorder: "#df8060",
    }
  }

  return {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif',
    fontSize: "14px",
    background: "transparent",
    mainBkg: "#f7f5ee",
    secondBkg: "#efede4",
    tertiaryColor: "#faf9f5",

    primaryColor: "#f7f5ee",
    primaryTextColor: "#262523",
    primaryBorderColor: "#ccc9bc",

    secondaryColor: "#efede4",
    secondaryTextColor: "#262523",
    secondaryBorderColor: "#c96442",

    tertiaryTextColor: "#262523",
    tertiaryBorderColor: "#dedcd1",

    lineColor: "#8c897e",
    textColor: "#262523",
    titleColor: "#141413",
    edgeLabelBackground: "#fdfcf9",
    labelTextColor: "#262523",

    clusterBkg: "#f4f2e9",
    clusterBorder: "#d8d5c8",

    noteBkgColor: "#fcf3e1",
    noteBorderColor: "#bf842e",
    noteTextColor: "#3b290f",

    actorBkg: "#f7f5ee",
    actorBorder: "#c4c1b4",
    actorTextColor: "#262523",
    actorLineColor: "#a8a599",
    signalColor: "#57554e",
    signalTextColor: "#262523",
    labelBoxBkgColor: "#f4f2e9",
    labelBoxBorderColor: "#c96442",
    loopTextColor: "#262523",
    activationBkgColor: "#faede7",
    activationBorderColor: "#c96442",
    sequenceNumberColor: "#faf9f5",

    labelColor: "#262523",
    errorBkgColor: "#fceeed",
    errorTextColor: "#3d1b17",

    fillType0: "#f7f5ee",
    fillType1: "#ecf3f8",
    fillType2: "#edf5ee",
    fillType3: "#fcf3e1",
    fillType4: "#f3eff9",
    fillType5: "#faede7",
    fillType6: "#fceeed",
    fillType7: "#efede4",

    sectionBkgColor: "#f7f5ee",
    altSectionBkgColor: "#faf9f5",
    sectionBkgColor2: "#efede4",
    gridColor: "#e2dfd3",
    taskBkgColor: "#efede4",
    taskBorderColor: "#bfbcae",
    taskTextColor: "#262523",
    taskTextLightColor: "#faf9f5",
    taskTextOutsideColor: "#262523",
    taskTextDarkColor: "#262523",
    activeTaskBkgColor: "#faede7",
    activeTaskBorderColor: "#c96442",
    doneTaskBkgColor: "#edf5ee",
    doneTaskBorderColor: "#5c8c66",
    critBkgColor: "#fceeed",
    critBorderColor: "#c45a4b",
    todayLineColor: "#c96442",

    pie1: "#c96442",
    pie2: "#5c8c66",
    pie3: "#527a9c",
    pie4: "#bf842e",
    pie5: "#7d6ba3",
    pie6: "#c45a4b",
    pie7: "#87867f",
    pie8: "#79ab83",
    pie9: "#7ea6c7",
    pie10: "#df8060",
    pie11: "#d9a252",
    pie12: "#a896cc",
    pieTitleTextColor: "#141413",
    pieSectionTextColor: "#fdfcf9",
    pieLegendTextColor: "#262523",
    pieStrokeColor: "#faf9f5",
    pieOuterStrokeColor: "#ccc9bc",

    git0: "#c96442",
    git1: "#5c8c66",
    git2: "#527a9c",
    git3: "#bf842e",
    git4: "#7d6ba3",
    git5: "#c45a4b",
    git6: "#87867f",
    git7: "#df8060",
    gitBranchLabel0: "#faf9f5",
    gitBranchLabel1: "#faf9f5",
    gitBranchLabel2: "#faf9f5",
    gitBranchLabel3: "#faf9f5",
    gitBranchLabel4: "#faf9f5",
    gitBranchLabel5: "#faf9f5",
    gitBranchLabel6: "#faf9f5",
    gitBranchLabel7: "#faf9f5",
    commitLabelColor: "#262523",
    commitLabelBackground: "#f7f5ee",
    tagLabelColor: "#262523",
    tagLabelBackground: "#faede7",
    tagLabelBorder: "#c96442",
  }
}
