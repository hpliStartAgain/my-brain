import { QuartzComponentConstructor, QuartzPluginData } from '@quartz-community/types';

type ArticleCarouselPluginData = QuartzPluginData & Record<string, unknown>;
interface ArticleCarouselOptions {
    /** 组件标题 */
    title?: string;
    /** 每次显示的文章数量 */
    showCount: number;
    /** 自定义过滤器 */
    filter: (f: ArticleCarouselPluginData) => boolean;
}
/**
 * 随机文章推荐组件
 * 显示 N 篇随机文章，点击刷新按钮随机切换
 * 所有文章数据构建时注入，运行时由 JS 随机选取
 */
declare const ArticleCarousel: QuartzComponentConstructor<Partial<ArticleCarouselOptions>>;

export { ArticleCarousel, type ArticleCarouselOptions, ArticleCarousel as default };
