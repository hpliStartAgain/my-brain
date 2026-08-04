import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "preact/jsx-runtime";
const defaultOptions = {
    showProgress: true,
    showCopy: true,
    copyLabel: "复制正文",
};
const style = `
.reading-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 9999;
  background: transparent;
  pointer-events: none;
}

.reading-progress-bar {
  height: 100%;
  width: 0;
  background: var(--secondary);
  transition: width 0.08s linear;
}

.article-tools {
  display: flex;
  justify-content: flex-end;
  margin: 0.25rem 0 0;
}

.copy-article-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-family: var(--bodyFont);
  color: var(--gray);
  background: transparent;
  border: 1px solid var(--lightgray);
  border-radius: 9999px;
  padding: 0.3rem 0.9rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.copy-article-btn:hover {
  color: var(--secondary);
  border-color: var(--secondary);
  background: color-mix(in srgb, var(--secondary) 6%, transparent);
}

.copy-article-btn svg {
  width: 13px;
  height: 13px;
}
`;
/**
 * 文章工具组件 — claude.com/blog 风格的阅读辅助
 * 1. 顶部 2px 陶土色阅读进度条
 * 2. 「复制正文」按钮：一键复制标题 + 正文纯文本到剪贴板
 */
const ArticleTools = (userOpts) => {
    const opts = { ...defaultOptions, ...userOpts };
    const ArticleToolsComponent = ({ displayClass }) => {
        return (_jsxs(_Fragment, { children: [opts.showProgress && (_jsx("div", { class: "reading-progress", "data-reading-progress": true, "aria-hidden": "true", children: _jsx("div", { class: "reading-progress-bar", "data-reading-progress-bar": true }) })), opts.showCopy && (_jsx("div", { class: displayClass ? `${displayClass} article-tools` : "article-tools", children: _jsxs("button", { type: "button", class: "copy-article-btn", "data-copy-article": true, "aria-label": opts.copyLabel, children: [_jsxs("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", children: [_jsx("rect", { x: "8", y: "2", width: "8", height: "4", rx: "1", ry: "1" }), _jsx("path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" })] }), _jsx("span", { "data-copy-label": true, children: opts.copyLabel })] }) }))] }));
    };
    ArticleToolsComponent.css = style;
    ArticleToolsComponent.afterDOMLoaded = `
    function setupArticleTools() {
      // 阅读进度条：全局只绑定一次 scroll 监听，每次查找当前 bar
      if (!window.__articleProgressBound) {
        window.__articleProgressBound = true;
        var progressTicking = false;
        window.addEventListener("scroll", function() {
          if (progressTicking) return;
          progressTicking = true;
          window.requestAnimationFrame(function() {
            progressTicking = false;
            var bar = document.querySelector("[data-reading-progress-bar]");
            if (!bar) return;
            var el = document.documentElement;
            var max = el.scrollHeight - el.clientHeight;
            var pct = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
            bar.style.width = (pct * 100).toFixed(2) + "%";
          });
        }, { passive: true });
      }

      // 复制正文按钮
      document.querySelectorAll("[data-copy-article]").forEach(function(btn) {
        if (btn.dataset.bound === "true") return;
        btn.dataset.bound = "true";
        btn.addEventListener("click", function() {
          var article = document.querySelector("article");
          if (!article) return;
          var titleEl = document.querySelector("h1.article-title");
          var title = titleEl ? titleEl.textContent.trim() : document.title;
          var text = title ? "# " + title + "\\n\\n" + article.innerText : article.innerText;
          var label = btn.querySelector("[data-copy-label]");
          function done() {
            if (!label) return;
            if (!label.dataset.orig) label.dataset.orig = label.textContent;
            label.textContent = "已复制";
            setTimeout(function() { label.textContent = label.dataset.orig; }, 1500);
          }
          function fallback() {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); done(); } catch (e) {}
            document.body.removeChild(ta);
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, fallback);
          } else {
            fallback();
          }
        });
      });
    }

    setupArticleTools();
    document.addEventListener("nav", function() {
      // SPA 导航后 DOM 被 micromorph 替换，重置绑定标记
      document.querySelectorAll("[data-copy-article]").forEach(function(b) {
        b.dataset.bound = "false";
      });
      var bar = document.querySelector("[data-reading-progress-bar]");
      if (bar) bar.style.width = "0";
      setupArticleTools();
    });
  `;
    return ArticleToolsComponent;
};
export default ArticleTools;
export { ArticleTools };
