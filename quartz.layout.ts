import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {},
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    // 首页不显示面包屑、标题、元数据
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.ArticleTitle(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.ContentMeta(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.TagList(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    // 首页文章轮播 — Claude 博客风格，仅在首页显示
    Component.ConditionalRender({
      component: Component.ArticleCarousel({
        title: "随机碎片",
        limit: 15,
        random: true,
      }),
      condition: (page) => page.fileData.slug === "index",
    }),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer({
      title: "文章导航",

      // 🌟 核心优化 1：默认收起所有文件夹，防止浏览器在冷启动时渲染全量 DOM 树
      folderDefaultState: "collapsed",

      // 🌟 核心优化 2：关闭本地状态恢复。阻止 JS 在页面刚加载时去深度遍历几千个节点计算开合状态
      useSavedState: false,

      // 🌟 核心优化 3（可选）：点击文件夹名字时折叠/展开，而不是当做链接跳转
      folderClickBehavior: "collapse",
    }),
  ],
  right: [
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer({
      title: "文章导航",

      // 🌟 核心优化 1：默认收起所有文件夹，防止浏览器在冷启动时渲染全量 DOM 树
      folderDefaultState: "collapsed",

      // 🌟 核心优化 2：关闭本地状态恢复。阻止 JS 在页面刚加载时去深度遍历几千个节点计算开合状态
      useSavedState: false,

      // 🌟 核心优化 3（可选）：点击文件夹名字时折叠/展开，而不是当做链接跳转
      folderClickBehavior: "collapse",
    }),
  ],
  right: [],
}
