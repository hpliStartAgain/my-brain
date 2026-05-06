declare module "*.scss" {
  const content: string
  export = content
}

interface CustomEventMap {
  prenav: CustomEvent<{}>
  nav: CustomEvent<{ url: FullSlug }>
  themechange: CustomEvent<{ theme: "light" | "dark" }>
  readermodechange: CustomEvent<{ mode: "on" | "off" }>
}

type NavigationIndex = Record<
  FullSlug,
  import("./quartz/plugins/emitters/contentIndex").NavContentDetails
>
type SearchIndex = Record<
  FullSlug,
  import("./quartz/plugins/emitters/contentIndex").SearchContentDetails
>

declare const getNavData: () => Promise<NavigationIndex>
declare const getSearchData: () => Promise<SearchIndex>
