import { loadQuartzConfig, loadQuartzLayout } from "./quartz/plugins/loader/config-loader"
import { componentRegistry } from "./quartz/components/registry"

type ExplorerTrieNode = {
  isFolder: boolean
  displayName: string
  data?: { filePath?: string } | null
}

// Explorer 默认按 frontmatter title 排序，导致带数字前缀的专栏文章（01/02/.../08）
// 顺序错乱。改为：文件按磁盘文件名排序（numeric 比较保证 "01" < "08" < "10"），
// 文件夹仍按显示名排序；展示文案不受影响，依然显示 title。
// 注意：该函数会被 toString 序列化后在浏览器端 eval，必须保持自包含——
// 不能引用外部变量，也不能嵌套具名函数（esbuild 会注入 __name helper 导致客户端报错）。
const explorerSortFn = (a: ExplorerTrieNode, b: ExplorerTrieNode): number => {
  if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
    let keyA = a.displayName
    if (!a.isFolder && a.data?.filePath) {
      const parts = a.data.filePath.split("/")
      const base = parts[parts.length - 1].replace(/\.[^.]+$/, "")
      if (base) keyA = base
    }
    let keyB = b.displayName
    if (!b.isFolder && b.data?.filePath) {
      const parts = b.data.filePath.split("/")
      const base = parts[parts.length - 1].replace(/\.[^.]+$/, "")
      if (base) keyB = base
    }
    return keyA.localeCompare(keyB, undefined, { numeric: true, sensitivity: "base" })
  }
  return !a.isFolder && b.isFolder ? 1 : -1
}

// 必须在 loadQuartzLayout() 之前注册，组件实例化时会合并此 override
componentRegistry.setOptionOverrides("@quartz-community/explorer", {
  sortFn: explorerSortFn,
})

const config = await loadQuartzConfig()
export default config
export const layout = await loadQuartzLayout()
