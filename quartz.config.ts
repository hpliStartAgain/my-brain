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
        // Sleek Tech / Vercel-like Design System
        // Headings & Body: Inter (geometric, modern sans-serif)
        header: { name: "Inter", weights: [400, 600, 700, 800], includeItalic: true },
        body: { name: "Inter", weights: [400, 500, 600], includeItalic: true },
        code: { name: "JetBrains Mono", weights: [400, 500], includeItalic: false },
      },
      colors: {
        lightMode: {
          light: "#ffffff", // Pure white background
          lightgray: "#e5e5e5", // Subtle borders
          gray: "#737373", // Muted text
          darkgray: "#171717", // Main text
          dark: "#000000", // Headings / contrast text
          secondary: "#4f46e5", // Indigo / Sleek accent
          tertiary: "#0ea5e9", // Ocean blue secondary accent
          highlight: "rgba(79, 70, 229, 0.08)", // Indigo tint
          textHighlight: "rgba(79, 70, 229, 0.15)",
        },
        darkMode: {
          light: "#0a0a0a", // Vercel dark background
          lightgray: "#262626", // Dark borders
          gray: "#a3a3a3", // Muted text
          darkgray: "#e5e5e5", // Main text
          dark: "#ffffff", // Headings / contrast text
          secondary: "#818cf8", // Light Indigo
          tertiary: "#38bdf8", // Light Ocean
          highlight: "rgba(129, 140, 248, 0.15)",
          textHighlight: "rgba(129, 140, 248, 0.25)",
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
        searchContentLength: 4000,
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
