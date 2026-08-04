import type { QuartzComponentConstructor } from "@quartz-community/types";
/**
 * 滚动渐显组件 — 不渲染可见内容，仅注入 CSS + IntersectionObserver
 * 对首页卡片 / 列表行等元素做 fade-in-up，尊重 prefers-reduced-motion
 */
declare const ScrollReveal: QuartzComponentConstructor<Record<string, never>>;
export default ScrollReveal;
export { ScrollReveal };
