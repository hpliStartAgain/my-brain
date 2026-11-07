import type { QuartzTransformerPlugin } from "@quartz-community/types";
/**
 * content-polish —— 构建期内容整理（不改动 Markdown 源文件）
 *
 * 1. 去重标题：页面顶部已由 article-title 组件渲染 frontmatter.title 作为 H1，
 *    正文首行若再有一个内容相同的 `# 标题`（仅编号前缀不同也算），从 AST 中移除。
 *    这样页面只有一个 H1，右侧目录也不再以重复的大标题开头。
 * 2. 中文摘要描述：frontmatter 没写 description 时，按以下顺序生成 meta description
 *    （同时用于搜索引擎摘要、分享卡片、og 图）：
 *      `**摘要：**` 段落 → `## 摘要` 下的首段 → `> [!abstract]` Callout → 正文首段
 *    并按中文句读截断，取代默认按英文 ". " 断句、整段截到 300 字的行为。
 * 3. 图片懒加载：正文 <img> 统一加 loading="lazy" decoding="async"，
 *    译书类页面动辄几十张插图，不再在首屏一次性全部下载。
 *
 * 必须排在 obsidian-flavored-markdown（order 30）之前：此时 Callout 仍是原始引用块，
 * 且在 table-of-contents（order 50）之前，使去掉的 H1 不进入目录。
 */
export interface ContentPolishOptions {
    /** 移除与标题重复的正文首个 H1 */
    dedupeTitleHeading: boolean;
    /** 自动生成中文 description */
    generateDescription: boolean;
    /** description 目标长度（字符） */
    descriptionLength: number;
    /** 正文图片懒加载 */
    lazyImages: boolean;
}
export declare const ContentPolish: QuartzTransformerPlugin<Partial<ContentPolishOptions>>;
export default ContentPolish;
