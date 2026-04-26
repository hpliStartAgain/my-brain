import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * Quartz 4 Configuration
 *
 * See https://quartz.jzhao.xyz/configuration for more information.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "汀的知识碎片",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    analytics: {
      provider: "plausible",
    },
    locale: "en-US",
    baseUrl: "quartz.jzhao.xyz",
    ignorePatterns: ["private", "templates", ".obsidian", "工作管理", "Template"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        // Organic / Natural design system
        // Headings: Fraunces (variable serif, old-world warmth)
        // Body: Nunito (rounded terminals match organic shapes)
        header: { name: "Fraunces", weights: [600, 700, 800], includeItalic: true },
        body: { name: "Nunito", weights: [400, 600, 700], includeItalic: true },
        code: { name: "JetBrains Mono", weights: [400, 500], includeItalic: false },
      },
      colors: {
        // Earth-drawn palette: forest floors, clay pottery, unbleached paper
        lightMode: {
          light: "#FDFCF8",          // Off-white / Rice Paper (background)
          lightgray: "#E6DCCD",      // Sand / Beige (accent)
          gray: "#78786C",           // Dried Grass (muted-foreground)
          darkgray: "#4A4A40",       // Bark (accent-foreground / body)
          dark: "#2C2C24",           // Deep Loam / Charcoal (foreground)
          secondary: "#5D7052",      // Moss Green (primary)
          tertiary: "#C18C5D",       // Terracotta / Clay (secondary)
          highlight: "rgba(93, 112, 82, 0.06)",  // moss tint
          textHighlight: "rgba(193, 140, 93, 0.18)", // terracotta tint
        },
        darkMode: {
          // Dark mode: nightwood — deep loam paper with moss/clay accents
          light: "#1F1E1A",          // dark loam (background)
          lightgray: "#33312B",      // bark (accent)
          gray: "#9B9787",           // dried grass (muted-foreground)
          darkgray: "#D6D2C4",       // pale stone (body)
          dark: "#F3F1E9",           // mist (foreground)
          secondary: "#A8C195",      // light moss (primary)
          tertiary: "#E0A06F",       // light clay (secondary)
          highlight: "rgba(168, 193, 149, 0.10)",
          textHighlight: "rgba(224, 160, 111, 0.22)",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      // Comment out CustomOgImages to speed up build time
      Plugin.CustomOgImages(),
    ],
  },
}

export default config
