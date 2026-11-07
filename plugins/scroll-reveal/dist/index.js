import { jsx as _jsx } from "preact/jsx-runtime";
const style = `
@media (prefers-reduced-motion: no-preference) {
  .reveal {
    opacity: 0;
    transform: translateY(14px);
    transition: opacity 0.55s ease, transform 0.55s ease;
    will-change: opacity, transform;
  }

  .reveal.revealed {
    opacity: 1;
    transform: none;
  }
}

@media print {
  .reveal {
    opacity: 1 !important;
    transform: none !important;
  }
}
`;
/**
 * 滚动渐显组件 — 不渲染可见内容，仅注入 CSS + IntersectionObserver
 * 对首页区块（专栏地图、最近更新、随机碎片、标签入口）做 fade-in-up，尊重 prefers-reduced-motion
 */
const ScrollReveal = () => {
    const ScrollRevealComponent = ({ displayClass }) => {
        return (_jsx("span", { class: displayClass ? `${displayClass} scroll-reveal-anchor` : "scroll-reveal-anchor", "data-scroll-reveal": true, style: "display:none", "aria-hidden": "true" }));
    };
    ScrollRevealComponent.css = style;
    ScrollRevealComponent.afterDOMLoaded = `
    function setupScrollReveal() {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (!("IntersectionObserver" in window)) return;

      // 以区块为单位渐显：不再单独隐藏 .knowledge-card —— 卡片网格靠 1px 间隙露出底色
      // 画分隔线，卡片单独透明时会先闪出一整块灰底
      var targets = document.querySelectorAll(
        ".knowledge-section, .random-articles, .tag-pills-section, .recent-notes"
      );
      if (targets.length === 0) return;

      targets.forEach(function(el) {
        if (!el.classList.contains("revealed")) el.classList.add("reveal");
      });

      var io = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("revealed");
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0, rootMargin: "0px 0px -6% 0px" });

      targets.forEach(function(el) { io.observe(el); });
    }

    setupScrollReveal();
    document.addEventListener("nav", setupScrollReveal);
  `;
    return ScrollRevealComponent;
};
export default ScrollReveal;
export { ScrollReveal };
