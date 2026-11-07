import { i18n } from "../i18n"
import { FullSlug, getFileExtension, joinSegments, pathToRoot } from "../util/path"
import { CSSResourceToStyleElement, JSResourceToScriptElement } from "../util/resources"
import { googleFontHeadingCodeHref } from "../util/theme"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { unescapeHTML } from "../util/escape"

/**
 * 站点作者信息 —— 用于 JSON-LD 结构化数据（搜索引擎的作者/站点卡片）。
 * GlobalConfiguration 的 schema 不允许扩展字段，故集中放在这里。
 */
const SITE_AUTHOR = {
  name: "李浩鹏（汀）",
  url: "https://github.com/hpliStartAgain",
}

/** 页面没有任何可用描述时（文件夹页、标签页）的兜底文案 */
const SITE_TAGLINE =
  "李浩鹏（汀）的技术知识库：Linux 内核与性能工程、分布式存储与计算、云原生、可观测性与 SRE 实践。"

function fallbackDescription(slug: string, title: string) {
  if (slug === "tags" || slug === "tags/index") return `全部标签索引 · ${SITE_TAGLINE}`
  if (slug.startsWith("tags/")) return `标签「${title}」下的全部文章 · ${SITE_TAGLINE}`
  if (slug.endsWith("/index")) return `「${title}」专栏目录 · ${SITE_TAGLINE}`
  return SITE_TAGLINE
}

/** 非文章页：首页、文件夹页、标签页、404 */
function isArticleSlug(slug: string) {
  return !(
    slug === "index" ||
    slug === "404" ||
    slug.endsWith("/index") ||
    slug === "tags" ||
    slug.startsWith("tags/")
  )
}

/** 去掉末尾的 index，得到对外的规范 URL 路径 */
function canonicalPath(slug: string) {
  if (slug === "index") return ""
  return slug.endsWith("/index") ? slug.slice(0, -"index".length) : slug
}

function toISO(d: unknown): string | undefined {
  if (!d) return undefined
  const date = d instanceof Date ? d : new Date(d as string)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** JSON 放进 <script> 前转义 `<`，防止正文里的 `</script>` 截断标签 */
function safeJSON(obj: unknown) {
  return JSON.stringify(obj).replace(/</g, "\\u003c")
}

export default (() => {
  const Head: QuartzComponent = ({
    cfg,
    fileData,
    externalResources,
    ctx,
  }: QuartzComponentProps) => {
    const titleSuffix = cfg.pageTitleSuffix ?? ""
    const title =
      (fileData.frontmatter?.title ?? i18n(cfg.locale).propertyDefaults.title) + titleSuffix
    const defaultDescription = i18n(cfg.locale).propertyDefaults.description
    const rawDescription =
      fileData.frontmatter?.socialDescription ??
      fileData.frontmatter?.description ??
      unescapeHTML(fileData.description?.trim() ?? "")
    const description =
      rawDescription && rawDescription !== defaultDescription
        ? rawDescription
        : fallbackDescription(fileData.slug ?? "", fileData.frontmatter?.title ?? "")

    const { css, js, additionalHead } = externalResources

    const url = new URL(`https://${cfg.baseUrl ?? "example.com"}`)
    const path = url.pathname as FullSlug
    const slug = fileData.slug ?? ""
    const baseDir = slug === "404" ? path : pathToRoot(fileData.slug!)
    const iconPath = joinSegments(baseDir, "static/icon.png")
    const rssPath = joinSegments(baseDir, "index.xml")

    // Url of current page
    const socialUrl = slug === "404" ? url.toString() : joinSegments(url.toString(), slug)
    const canonicalUrl = joinSegments(url.toString(), canonicalPath(slug))

    const usesCustomOgImage = ctx.cfg.plugins.emitters.some((e) => e.name === "CustomOgImages")
    const ogImageDefaultPath = `https://${cfg.baseUrl}/static/og-image.png`
    const ogImageUrl = usesCustomOgImage
      ? joinSegments(url.toString(), `${slug}-og-image.webp`)
      : ogImageDefaultPath

    const coreStylesheet = css[0]?.content
    const coreScript = js.find(
      (r) => r.loadTime === "beforeDOMReady" && r.contentType === "external",
    )

    // 标题衬线字体 + 代码等宽字体走 Google Fonts，但以 preload + onload 异步挂载，
    // 不阻塞首屏渲染；大陆网络下 Google 不可达时直接使用系统字体回退栈。
    const loadGoogleFonts = cfg.theme.cdnCaching && cfg.theme.fontOrigin === "googleFonts"
    const fontHref = loadGoogleFonts ? googleFontHeadingCodeHref(cfg.theme) : undefined

    const isArticle = slug !== "" && isArticleSlug(slug)
    const published = toISO(fileData.dates?.created ?? fileData.frontmatter?.date)
    const modified = toISO(fileData.dates?.modified) ?? published
    const tags = (fileData.frontmatter?.tags as string[] | undefined) ?? []
    // keywords：标签收敛后迁出的长尾关键词，不生成标签页，只用于 SEO
    const extraKeywords = Array.isArray(fileData.frontmatter?.keywords)
      ? (fileData.frontmatter?.keywords as unknown[]).filter(
          (k): k is string => typeof k === "string",
        )
      : []
    const keywords = [...new Set([...tags, ...extraKeywords])]
    const author = { "@type": "Person", name: SITE_AUTHOR.name, url: SITE_AUTHOR.url }

    const jsonLd = isArticle
      ? {
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: title,
          description,
          inLanguage: cfg.locale,
          url: canonicalUrl,
          mainEntityOfPage: canonicalUrl,
          image: ogImageUrl,
          datePublished: published,
          dateModified: modified,
          keywords: keywords.length > 0 ? keywords.join(", ") : undefined,
          author,
          publisher: author,
        }
      : slug === "index"
        ? {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: cfg.pageTitle,
            url: url.toString(),
            inLanguage: cfg.locale,
            description,
            author,
          }
        : undefined

    return (
      <head>
        <title>{title}</title>
        <meta charSet="utf-8" />
        {coreStylesheet && <link rel="preload" href={coreStylesheet} as="style" />}
        {coreScript && coreScript.contentType === "external" && (
          <link rel="preload" href={coreScript.src} as="script" />
        )}
        {fontHref && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
            <link
              rel="preload"
              as="style"
              href={fontHref}
              {...({ onload: "this.onload=null;this.rel='stylesheet'" } as Record<string, string>)}
            />
            <noscript>
              <link rel="stylesheet" href={fontHref} />
            </noscript>
          </>
        )}
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={cfg.theme.colors.lightMode.light}
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content={cfg.theme.colors.darkMode.light}
        />

        <meta property="og:site_name" content={cfg.pageTitle}></meta>
        <meta property="og:locale" content={cfg.locale.replace("-", "_")} />
        <meta property="og:title" content={title} />
        <meta property="og:type" content={isArticle ? "article" : "website"} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta property="og:description" content={description} />
        <meta property="og:image:alt" content={description} />
        {isArticle && published && <meta property="article:published_time" content={published} />}
        {isArticle && modified && <meta property="article:modified_time" content={modified} />}
        {isArticle && <meta property="article:author" content={SITE_AUTHOR.name} />}
        {isArticle && tags.map((tag) => <meta property="article:tag" content={tag} />)}
        <meta name="author" content={SITE_AUTHOR.name} />
        {isArticle && keywords.length > 0 && <meta name="keywords" content={keywords.join(",")} />}

        {!usesCustomOgImage && (
          <>
            <meta property="og:image" content={ogImageDefaultPath} />
            <meta property="og:image:url" content={ogImageDefaultPath} />
            <meta name="twitter:image" content={ogImageDefaultPath} />
            <meta
              property="og:image:type"
              content={`image/${getFileExtension(ogImageDefaultPath) ?? "png"}`}
            />
          </>
        )}

        {cfg.baseUrl && (
          <>
            <meta property="twitter:domain" content={cfg.baseUrl}></meta>
            <meta property="og:url" content={socialUrl}></meta>
            <meta property="twitter:url" content={socialUrl}></meta>
            {slug !== "404" && <link rel="canonical" href={canonicalUrl} />}
          </>
        )}

        <link rel="icon" href={iconPath} />
        <link rel="apple-touch-icon" href={iconPath} />
        <link rel="alternate" type="application/rss+xml" title={cfg.pageTitle} href={rssPath} />
        <meta name="description" content={description} />
        <meta name="generator" content="Quartz" />
        {jsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJSON(jsonLd) }}
          />
        )}

        {css.map((resource) => CSSResourceToStyleElement(resource, true))}
        {js
          .filter((resource) => resource.loadTime === "beforeDOMReady")
          .map((res) => JSResourceToScriptElement(res, true))}
        {additionalHead.map((resource) => {
          if (typeof resource === "function") {
            return resource(fileData)
          } else {
            return resource
          }
        })}
      </head>
    )
  }

  return Head
}) satisfies QuartzComponentConstructor
