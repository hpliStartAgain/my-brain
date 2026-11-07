import type { QuartzComponentConstructor } from "@quartz-community/types";
/**
 * 滚动渐显组件 — 不渲染可见内容，仅注入 CSS + IntersectionObserver
 * 对首页区块（专栏地图、最近更新、随机碎片、标签入口）做 fade-in-up，尊重 prefers-reduced-motion
 */
declare const ScrollReveal: QuartzComponentConstructor<Record<string, never>>;
export default ScrollReveal;
export { ScrollReveal };
