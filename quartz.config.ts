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
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: { name: "Noto Serif SC", weights: [400, 700], includeItalic: false },
        body: { name: "Noto Sans SC", weights: [400, 500, 600], includeItalic: false },
        code: { name: "JetBrains Mono", weights: [400, 500], includeItalic: false },
      },
      colors: {
        lightMode: {
          light: "#faf6f1",
          lightgray: "#e8e0d8",
          gray: "#a8a29e",
          darkgray: "#44403c",
          dark: "#1c1917",
          secondary: "#b45309",
          tertiary: "#d97706",
          highlight: "rgba(180, 83, 9, 0.08)",
          textHighlight: "#fbbf2488",
        },
        darkMode: {
          light: "#1c1917",
          lightgray: "#292524",
          gray: "#78716c",
          darkgray: "#d6d3d1",
          dark: "#fafaf9",
          secondary: "#f59e0b",
          tertiary: "#fbbf24",
          highlight: "rgba(245, 158, 11, 0.12)",
          textHighlight: "#fbbf2488",
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
