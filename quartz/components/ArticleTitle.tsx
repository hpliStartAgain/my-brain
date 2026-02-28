import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

function getFileNameTitle(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const segments = filePath.replace(/\\/g, "/").split("/")
  const fileName = segments[segments.length - 1]
  // Remove file extension (.md, .html, etc.)
  const withoutExt = fileName.replace(/\.[^.]+$/, "")
  return withoutExt || undefined
}

const ArticleTitle: QuartzComponent = ({ fileData, displayClass }: QuartzComponentProps) => {
  const title = getFileNameTitle(fileData.filePath) ?? fileData.frontmatter?.title
  if (title) {
    return <h1 class={classNames(displayClass, "article-title")}>{title}</h1>
  } else {
    return null
  }
}

ArticleTitle.css = `
.article-title {
  margin: 2rem 0 0 0;
}
`

export default (() => ArticleTitle) satisfies QuartzComponentConstructor
