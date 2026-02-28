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
        // 建议把标题字体换成更有现代感的无衬线字体
        header: "Schibsted Grotesk", 
        // 正文字体
        body: "Source Sans Pro",
        // 代码块字体（作为 SRE，等宽代码字体必须好看！）
        code: "Fira Code", 
      },
      colors: {
        lightMode: {
          light: "#faf8f8", // 背景色
          lightgray: "#e5e5e5", // 边框
          gray: "#b8b8b8", // 辅助文字
          darkgray: "#4e4e4e", // 正文文字
          dark: "#2b2b2b", // 标题文字
          secondary: "#9fbdfd", // 🌟 核心主题色：Vercel 蓝
          tertiary: "#84a59d", // 悬停/交互色
          highlight: "rgba(37, 99, 235, 0.15)", // 文本高亮色
          textHighlight: "#fff23688", // Markdown 语法 ==高亮== 的颜色
        },
        darkMode: {
          light: "#161618", // 深邃黑背景
          lightgray: "#393639",
          gray: "#646464",
          darkgray: "#d4d4d4",
          dark: "#ebebec",
          secondary: "#9fbdfd", // 🌟 核心主题色：荧光蓝
          tertiary: "#84a59d",
          highlight: "rgba(59, 130, 246, 0.15)",
          textHighlight: "#b3aa0288",
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
