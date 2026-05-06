import { FileTrieNode } from "../../util/fileTrie"
import { FullSlug, resolveRelative, simplifySlug } from "../../util/path"
import { NavContentDetails } from "../../plugins/emitters/contentIndex"

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
  sortFn: (a: FileTrieNode<NavContentDetails>, b: FileTrieNode<NavContentDetails>) => number
  filterFn: (node: FileTrieNode<NavContentDetails>) => boolean
  mapFn: (node: FileTrieNode<NavContentDetails>) => void
  order: "sort" | "filter" | "map"[]
}

type FolderState = {
  path: string
  collapsed: boolean
}

let currentExplorerState: Array<FolderState> = []
let currentSlugForHydration: FullSlug = "" as FullSlug
// Cache the built trie across SPA navigations — content index does not change
// between client-side route transitions.
let cachedTrie: FileTrieNode<NavContentDetails> | null = null
let cachedTrieKey: string = ""

function isElementVisible(element: MaybeHTMLElement) {
  if (!element) return false

  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility()
  }

  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
}

function parseStoredExplorerState(useSavedState: boolean): FolderState[] {
  if (!useSavedState) return []

  const storageTree = localStorage.getItem("fileTree")
  if (!storageTree) return []

  try {
    return JSON.parse(storageTree) as FolderState[]
  } catch (error) {
    console.warn("Failed to parse stored explorer state.", error)
    localStorage.removeItem("fileTree")
    return []
  }
}

function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer") as HTMLElement
  if (!nearestExplorer) return
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    // Stop <html> from being scrollable when mobile explorer is open
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

function toggleFolder(evt: Event) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  // Walk up to the folder-container regardless of click origin (svg, button, span).
  const folderContainer = target.closest(".folder-container") as MaybeHTMLElement
  if (!folderContainer) return
  const childFolderContainer = folderContainer.nextElementSibling as MaybeHTMLElement
  if (!childFolderContainer) return

  // 🌟 Lazy hydration: build descendant DOM the first time this folder opens.
  hydrateFolderChildren(childFolderContainer as HTMLElement, currentSlugForHydration)

  childFolderContainer.classList.toggle("open")

  // Collapse folder container
  const isCollapsed = !childFolderContainer.classList.contains("open")
  setFolderState(childFolderContainer, isCollapsed)

  const currentFolderState = currentExplorerState.find(
    (item) => item.path === folderContainer.dataset.folderpath,
  )
  if (currentFolderState) {
    currentFolderState.collapsed = isCollapsed
  } else {
    currentExplorerState.push({
      path: folderContainer.dataset.folderpath as FullSlug,
      collapsed: isCollapsed,
    })
  }

  const stringifiedFileTree = JSON.stringify(currentExplorerState)
  localStorage.setItem("fileTree", stringifiedFileTree)
}

function createFileNode(
  currentSlug: FullSlug,
  node: FileTrieNode<NavContentDetails>,
): HTMLLIElement {
  const template = document.getElementById("template-file") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  a.href = resolveRelative(currentSlug, node.slug)
  a.dataset.for = node.slug
  a.textContent = node.displayName

  if (currentSlug === node.slug) {
    a.classList.add("active")
  }

  return li
}

// WeakMap so a freshly built folder <li> can find its trie node again
// when the user clicks to expand it (lazy hydration)
const folderNodeMap = new WeakMap<HTMLElement, FileTrieNode<NavContentDetails>>()
const folderOptsMap = new WeakMap<HTMLElement, ParsedOptions>()
const folderHydratedAttr = "data-hydrated"

function hydrateFolderChildren(folderOuter: HTMLElement, currentSlug: FullSlug) {
  if (folderOuter.getAttribute(folderHydratedAttr) === "true") return
  const node = folderNodeMap.get(folderOuter)
  const opts = folderOptsMap.get(folderOuter)
  if (!node || !opts) return

  const ul = folderOuter.querySelector("ul") as HTMLUListElement | null
  if (!ul) return

  const fragment = document.createDocumentFragment()
  for (const child of node.children) {
    const childEl = child.isFolder
      ? createFolderNode(currentSlug, child, opts, /*lazy*/ true)
      : createFileNode(currentSlug, child)
    fragment.appendChild(childEl)
  }
  ul.appendChild(fragment)
  folderOuter.setAttribute(folderHydratedAttr, "true")
}

function createFolderNode(
  currentSlug: FullSlug,
  node: FileTrieNode<NavContentDetails>,
  opts: ParsedOptions,
  lazy: boolean = false,
): HTMLLIElement {
  const template = document.getElementById("template-folder") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder-outer") as HTMLElement
  const ul = folderOuter.querySelector("ul") as HTMLUListElement

  const folderPath = node.slug
  folderContainer.dataset.folderpath = folderPath

  if (currentSlug === folderPath) {
    folderContainer.classList.add("active")
  }

  if (opts.folderClickBehavior === "link") {
    // Replace button with link for link behavior
    const button = titleContainer.querySelector(".folder-button") as HTMLElement
    const a = document.createElement("a")
    a.href = resolveRelative(currentSlug, folderPath)
    a.dataset.for = folderPath
    a.className = "folder-title"
    a.textContent = node.displayName
    button.replaceWith(a)
  } else {
    const span = titleContainer.querySelector(".folder-title") as HTMLElement
    span.textContent = node.displayName
  }

  // if the saved state is collapsed or the default state is collapsed
  const isCollapsed =
    currentExplorerState.find((item) => item.path === folderPath)?.collapsed ??
    opts.folderDefaultState === "collapsed"

  // if this folder is a prefix of the current path we
  // want to open it anyways
  const simpleFolderPath = simplifySlug(folderPath)
  const folderIsPrefixOfCurrentSlug =
    simpleFolderPath === currentSlug.slice(0, simpleFolderPath.length)

  const shouldOpen = !isCollapsed || folderIsPrefixOfCurrentSlug
  if (shouldOpen) {
    folderOuter.classList.add("open")
  }

  // 🌟 Lazy rendering: only build children DOM for top-level folders that are open
  // (i.e. the ancestor chain of the current page). All other folders defer DOM
  // creation until the user clicks to expand. With ~900 entries this slashes
  // first-paint DOM work from O(N) to O(visible).
  const shouldRenderChildrenNow = !lazy || shouldOpen
  if (shouldRenderChildrenNow) {
    for (const child of node.children) {
      const childNode = child.isFolder
        ? createFolderNode(currentSlug, child, opts, /*lazy*/ true)
        : createFileNode(currentSlug, child)
      ul.appendChild(childNode)
    }
    folderOuter.setAttribute(folderHydratedAttr, "true")
  } else {
    // Stash node + opts so we can hydrate on first expand
    folderNodeMap.set(folderOuter, node)
    folderOptsMap.set(folderOuter, opts)
    folderOuter.setAttribute(folderHydratedAttr, "false")
  }

  return li
}

async function setupExplorer(currentSlug: FullSlug) {
  const allExplorers = document.querySelectorAll("div.explorer") as NodeListOf<HTMLElement>

  for (const explorer of allExplorers) {
    const dataFns = JSON.parse(explorer.dataset.dataFns || "{}")
    const opts: ParsedOptions = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
      order: dataFns.order || ["filter", "map", "sort"],
      sortFn: new Function("return " + (dataFns.sortFn || "undefined"))(),
      filterFn: new Function("return " + (dataFns.filterFn || "undefined"))(),
      mapFn: new Function("return " + (dataFns.mapFn || "undefined"))(),
    }

    // Get folder state from local storage
    const serializedExplorerState = parseStoredExplorerState(opts.useSavedState)
    const oldIndex = new Map<string, boolean>(
      serializedExplorerState.map((entry: FolderState) => [entry.path, entry.collapsed]),
    )

    // 🌟 Reuse trie across SPA navigations. Building the trie + sort/filter
    // walks all ~N entries; doing it once per session is sufficient.
    const trieKey = JSON.stringify({
      order: opts.order,
      sortFn: explorer.dataset.dataFns,
      folderDefault: opts.folderDefaultState,
      behavior: opts.folderClickBehavior,
    })
    let trie: FileTrieNode<NavContentDetails>
    if (cachedTrie && cachedTrieKey === trieKey) {
      trie = cachedTrie
    } else {
      const data = await getNavData()
      const entries = [...Object.entries(data)] as [FullSlug, NavContentDetails][]
      trie = FileTrieNode.fromEntries(entries)

      // Apply functions in order
      for (const fn of opts.order) {
        switch (fn) {
          case "filter":
            if (opts.filterFn) trie.filter(opts.filterFn)
            break
          case "map":
            if (opts.mapFn) trie.map(opts.mapFn)
            break
          case "sort":
            if (opts.sortFn) trie.sort(opts.sortFn)
            break
        }
      }
      cachedTrie = trie
      cachedTrieKey = trieKey
    }

    // Get folder paths for state management
    const folderPaths = trie.getFolderPaths()
    currentExplorerState = folderPaths.map((path) => {
      const previousState = oldIndex.get(path)
      return {
        path,
        collapsed:
          previousState === undefined ? opts.folderDefaultState === "collapsed" : previousState,
      }
    })
    currentSlugForHydration = currentSlug

    const explorerUl = explorer.querySelector(".explorer-ul") as HTMLElement | null
    if (!explorerUl) continue

    // Clear any previously rendered tree (SPA re-entry) so we don't pile up duplicates
    explorerUl.replaceChildren()

    // 🌟 Lazy first paint: top-level folders defer their descendant DOM until
    // expanded. Only the ancestor chain of the current page gets fully built.
    const fragment = document.createDocumentFragment()
    for (const child of trie.children) {
      const node = child.isFolder
        ? createFolderNode(currentSlug, child, opts, /*lazy*/ true)
        : createFileNode(currentSlug, child)

      fragment.appendChild(node)
    }
    explorerUl.appendChild(fragment)

    // restore explorer scrollTop position if it exists
    const scrollTop = sessionStorage.getItem("explorerScrollTop")
    if (scrollTop) {
      explorerUl.scrollTop = parseInt(scrollTop)
    } else {
      // try to scroll to the active element if it exists
      const activeElement = explorerUl.querySelector(".active")
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: "smooth" })
      }
    }

    // Set up event handlers
    const explorerButtons = explorer.getElementsByClassName(
      "explorer-toggle",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of explorerButtons) {
      button.addEventListener("click", toggleExplorer)
      window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
    }

    // 🌟 Event delegation: a single listener on the explorer root catches clicks
    // from any folder-button / folder-icon, including ones lazily inserted later.
    const delegated = (evt: Event) => {
      const target = evt.target as MaybeHTMLElement
      if (!target) return
      const onIcon = target.closest(".folder-icon") as MaybeHTMLElement
      const onButton =
        opts.folderClickBehavior === "collapse"
          ? (target.closest(".folder-button") as MaybeHTMLElement)
          : undefined
      if (onIcon || onButton) {
        toggleFolder(evt)
      }
    }
    explorerUl.addEventListener("click", delegated)
    window.addCleanup(() => explorerUl.removeEventListener("click", delegated))
  }
}

document.addEventListener("prenav", async () => {
  // save explorer scrollTop position
  const explorer = document.querySelector(".explorer-ul")
  if (!explorer) return
  sessionStorage.setItem("explorerScrollTop", explorer.scrollTop.toString())
})

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  try {
    await setupExplorer(currentSlug)
  } catch (error) {
    console.error("Explorer setup failed.", error)
  } finally {
    // if mobile hamburger is visible, collapse by default
    for (const explorer of document.getElementsByClassName("explorer")) {
      const mobileExplorer = explorer.querySelector(".mobile-explorer") as MaybeHTMLElement
      if (!mobileExplorer) continue

      if (isElementVisible(mobileExplorer)) {
        explorer.classList.add("collapsed")
        explorer.setAttribute("aria-expanded", "false")

        // Allow <html> to be scrollable when mobile explorer is collapsed
        document.documentElement.classList.remove("mobile-no-scroll")
      }

      mobileExplorer.classList.remove("hide-until-loaded")
    }
  }
})

window.addEventListener("resize", function () {
  // Desktop explorer opens by default, and it stays open when the window is resized
  // to mobile screen size. Applies `no-scroll` to <html> in this edge case.
  const explorer = document.querySelector(".explorer")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})

function setFolderState(folderElement: HTMLElement, collapsed: boolean) {
  return collapsed ? folderElement.classList.remove("open") : folderElement.classList.add("open")
}
