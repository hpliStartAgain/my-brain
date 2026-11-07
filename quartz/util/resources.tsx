import { randomUUID } from "crypto"
import { JSX } from "preact/jsx-runtime"
import { QuartzPluginData } from "../plugins/vfile"

export type JSResource = {
  loadTime: "beforeDOMReady" | "afterDOMReady"
  moduleType?: "module"
  spaPreserve?: boolean
} & (
  | {
      src: string
      contentType: "external"
    }
  | {
      script: string
      contentType: "inline"
    }
)

export type CSSResource = {
  content: string
  inline?: boolean
  spaPreserve?: boolean
}

/**
 * 第三方 CDN 资源本地化：KaTeX 样式表在每个页面都以阻塞方式加载，
 * 原地址 cdn.jsdelivr.net 在中国大陆访问不稳定，会拖住首屏。
 * 这里把已知资源改写为站内自托管副本（quartz/static/katex，版本须与插件一致）。
 */
const LOCALIZED_RESOURCES: Record<string, string> = {
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css": "/static/katex/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/copy-tex.min.js":
    "/static/katex/contrib/copy-tex.min.js",
}

export function localizeResourceUrl(url: string): string {
  return LOCALIZED_RESOURCES[url] ?? url
}

export function JSResourceToScriptElement(resource: JSResource, preserve?: boolean): JSX.Element {
  const scriptType = resource.moduleType ?? "application/javascript"
  const spaPreserve = preserve ?? resource.spaPreserve

  if (resource.contentType === "external") {
    return (
      <script
        key={resource.src}
        src={localizeResourceUrl(resource.src)}
        type={scriptType}
        data-persist={spaPreserve}
      />
    )
  } else {
    const content = resource.script
    return (
      <script
        key={randomUUID()}
        type={scriptType}
        data-persist={spaPreserve}
        dangerouslySetInnerHTML={{ __html: content }}
      ></script>
    )
  }
}

export function CSSResourceToStyleElement(resource: CSSResource, preserve?: boolean): JSX.Element {
  const spaPreserve = preserve ?? resource.spaPreserve
  if (resource.inline ?? false) {
    return <style dangerouslySetInnerHTML={{ __html: resource.content }} />
  } else {
    return (
      <link
        key={resource.content}
        href={localizeResourceUrl(resource.content)}
        rel="stylesheet"
        type="text/css"
        data-persist={spaPreserve}
      />
    )
  }
}

export interface StaticResources {
  css: CSSResource[]
  js: JSResource[]
  additionalHead: (JSX.Element | ((pageData: QuartzPluginData) => JSX.Element))[]
}

export type StringResource = string | string[] | undefined

export function normalizeResource(resource: StringResource): string[] {
  if (!resource) return []
  if (Array.isArray(resource)) return resource
  return [resource]
}

export function concatenateResources(...resources: StringResource[]): StringResource {
  return resources
    .filter((resource): resource is string | string[] => resource !== undefined)
    .flat()
}
