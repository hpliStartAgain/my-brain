import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types"
import { resolveRelative } from "@quartz-community/utils/path"

export interface TagPillsOptions {
  /** 区块标题，空字符串则不显示 */
  title: string
  /** 展示的高频标签数量 */
  maxTags: number
  /** 是否显示「全部标签」入口 */
  showAllLink: boolean
}

const defaultOptions: TagPillsOptions = {
  title: "按标签逛逛",
  maxTags: 14,
  showAllLink: true,
}

const style = `
.tag-pills-section {
  margin: 0 0 2rem;
}

.tag-pills-title {
  display: block;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--gray);
  margin-bottom: 0.6rem;
}

.tag-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* 需要比 custom.scss 的 a.internal（0,1,1）更高的特异性 */
.tag-pills a.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.9rem;
  border: 1px solid var(--lightgray);
  border-radius: 9999px;
  font-size: 0.85rem;
  color: var(--darkgray);
  background: transparent;
  text-decoration: none;
  transition: all 0.2s ease;
}

.tag-pills a.tag-pill:hover {
  border-color: var(--secondary);
  color: var(--secondary);
  background: color-mix(in srgb, var(--secondary) 6%, transparent);
  text-decoration: none;
}

.tag-pills .tag-pill-count {
  font-size: 0.72rem;
  color: var(--gray);
}

.tag-pills a.tag-pill:hover .tag-pill-count {
  color: var(--secondary);
}

.tag-pills a.tag-pill-all {
  color: var(--secondary);
  border-color: color-mix(in srgb, var(--secondary) 40%, var(--lightgray));
}
`

/**
 * 标签筛选 pill 栏 — 模仿 claude.com/blog 顶部分类筛选
 * 统计全站标签频次，展示 Top N 作为快捷筛选入口
 */
const TagPills: QuartzComponentConstructor<Partial<TagPillsOptions>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }

  const TagPillsComponent: QuartzComponent = ({
    allFiles,
    fileData,
    displayClass,
  }: QuartzComponentProps) => {
    const counts = new Map<string, number>()
    for (const f of allFiles) {
      const slug = (f.slug as string) ?? ""
      if (slug === "tags" || slug.startsWith("tags/")) continue
      const tags = (f.frontmatter?.tags ?? []) as string[]
      for (const t of tags) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxTags)
    if (top.length === 0) return null

    return (
      <div class={displayClass ? `${displayClass} tag-pills-section` : "tag-pills-section"}>
        {opts.title && <span class="tag-pills-title">{opts.title}</span>}
        <div class="tag-pills">
          {top.map(([tag, count]) => (
            <a
              class="tag-pill internal"
              href={resolveRelative(fileData.slug as never, `tags/${tag}` as never)}
            >
              <span class="tag-pill-name">{tag}</span>
              <span class="tag-pill-count">{count}</span>
            </a>
          ))}
          {opts.showAllLink && (
            <a
              class="tag-pill tag-pill-all internal"
              href={resolveRelative(fileData.slug as never, "tags" as never)}
            >
              全部标签 →
            </a>
          )}
        </div>
      </div>
    )
  }

  TagPillsComponent.css = style

  return TagPillsComponent
}

export default TagPills
export { TagPills }
