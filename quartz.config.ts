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
        header: "Noto Sans SC",
        body: "Noto Sans SC",
        code: "Noto Sans SC",
      },
      colors: {
        // Claude 博客象牙色系 — 从 claude.com/blog CSS 精确提取
        lightMode: {
          light: "#faf9f5",    // 象牙白背景 (Claude gray-050)
          lightgray: "#e8e6dc", // 温暖灰边框 (Claude gray-200)
          gray: "#87867f",     // 柔和次要文字 (Claude gray-500)
          darkgray: "#30302e", // 温暖主体文字 (Claude gray-750)
          dark: "#141413",     // 深色标题 (Claude gray-950)
          secondary: "#c96442", // 陶土交互色 (Claude clay-interactive)
          tertiary: "#d97757", // 陶土装饰色 (Claude clay)
          highlight: "rgba(201, 100, 66, 0.08)",  // 陶土色高亮
          textHighlight: "rgba(201, 100, 66, 0.15)",
        },
        darkMode: {
          light: "#141413",    // 温暖深色背景 (Claude gray-950)
          lightgray: "#3d3d3a", // 暗灰边框 (Claude gray-700)
          gray: "#73726c",     // 次要文字 (Claude gray-550)
          darkgray: "#dedcd1", // 浅暖灰主体文字 (Claude gray-250)
          dark: "#faf9f5",     // 象牙白标题 (Claude gray-050)
          secondary: "#d97757", // 亮陶土色 (Claude clay)
          tertiary: "#c96442", // 深陶土色 (Claude clay-interactive)
          highlight: "rgba(217, 119, 87, 0.15)",
          textHighlight: "rgba(217, 119, 87, 0.25)",
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
