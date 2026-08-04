import type { QuartzComponentConstructor } from "@quartz-community/types";
export interface TagPillsOptions {
    /** 区块标题，空字符串则不显示 */
    title: string;
    /** 展示的高频标签数量 */
    maxTags: number;
    /** 是否显示「全部标签」入口 */
    showAllLink: boolean;
}
/**
 * 标签筛选 pill 栏 — 模仿 claude.com/blog 顶部分类筛选
 * 统计全站标签频次，展示 Top N 作为快捷筛选入口
 */
declare const TagPills: QuartzComponentConstructor<Partial<TagPillsOptions>>;
export default TagPills;
export { TagPills };
