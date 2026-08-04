import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { resolveRelative } from "@quartz-community/utils/path";
const defaultOptions = {
    title: "按标签逛逛",
    maxTags: 14,
    showAllLink: true,
};
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
`;
/**
 * 标签筛选 pill 栏 — 模仿 claude.com/blog 顶部分类筛选
 * 统计全站标签频次，展示 Top N 作为快捷筛选入口
 */
const TagPills = (userOpts) => {
    const opts = { ...defaultOptions, ...userOpts };
    const TagPillsComponent = ({ allFiles, fileData, displayClass, }) => {
        const counts = new Map();
        for (const f of allFiles) {
            const slug = f.slug ?? "";
            if (slug === "tags" || slug.startsWith("tags/"))
                continue;
            const tags = (f.frontmatter?.tags ?? []);
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxTags);
        if (top.length === 0)
            return null;
        return (_jsxs("div", { class: displayClass ? `${displayClass} tag-pills-section` : "tag-pills-section", children: [opts.title && _jsx("span", { class: "tag-pills-title", children: opts.title }), _jsxs("div", { class: "tag-pills", children: [top.map(([tag, count]) => (_jsxs("a", { class: "tag-pill internal", href: resolveRelative(fileData.slug, `tags/${tag}`), children: [_jsx("span", { class: "tag-pill-name", children: tag }), _jsx("span", { class: "tag-pill-count", children: count })] }))), opts.showAllLink && (_jsx("a", { class: "tag-pill tag-pill-all internal", href: resolveRelative(fileData.slug, "tags"), children: "\u5168\u90E8\u6807\u7B7E \u2192" }))] })] }));
    };
    TagPillsComponent.css = style;
    return TagPillsComponent;
};
export default TagPills;
export { TagPills };
