import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types"

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
`

/**
 * 滚动渐显组件 — 不渲染可见内容，仅注入 CSS + IntersectionObserver
 * 对首页卡片 / 列表行等元素做 fade-in-up，尊重 prefers-reduced-motion
 */
const ScrollReveal: QuartzComponentConstructor<Record<string, never>> = () => {
  const ScrollRevealComponent: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    return (
      <span
        class={displayClass ? `${displayClass} scroll-reveal-anchor` : "scroll-reveal-anchor"}
        data-scroll-reveal
        style="display:none"
        aria-hidden="true"
      />
    )
  }

  ScrollRevealComponent.css = style
  ScrollRevealComponent.afterDOMLoaded = `
    function setupScrollReveal() {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (!("IntersectionObserver" in window)) return;

      var targets = document.querySelectorAll(
        ".knowledge-card, .knowledge-section, .homepage-header, .random-articles, li.section-li, .tag-pills-section"
      );
      if (targets.length === 0) return;

      // knowledge-grid 内卡片加交错延迟
      document.querySelectorAll(".knowledge-grid .knowledge-card").forEach(function(el, i) {
        el.style.transitionDelay = (i % 8) * 40 + "ms";
      });

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
      }, { threshold: 0.08 });

      targets.forEach(function(el) { io.observe(el); });
    }

    setupScrollReveal();
    document.addEventListener("nav", setupScrollReveal);
  `

  return ScrollRevealComponent
}

export default ScrollReveal
export { ScrollReveal }
