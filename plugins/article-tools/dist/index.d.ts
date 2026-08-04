import type { QuartzComponentConstructor } from "@quartz-community/types";
export interface ArticleToolsOptions {
    /** 是否显示顶部阅读进度条 */
    showProgress: boolean;
    /** 是否显示复制正文按钮 */
    showCopy: boolean;
    /** 复制按钮文案 */
    copyLabel: string;
}
/**
 * 文章工具组件 — claude.com/blog 风格的阅读辅助
 * 1. 顶部 2px 陶土色阅读进度条
 * 2. 「复制正文」按钮：一键复制标题 + 正文纯文本到剪贴板
 */
declare const ArticleTools: QuartzComponentConstructor<Partial<ArticleToolsOptions>>;
export default ArticleTools;
export { ArticleTools };
