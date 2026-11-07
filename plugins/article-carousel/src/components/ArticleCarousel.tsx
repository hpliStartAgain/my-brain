import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
  QuartzPluginData,
} from "@quartz-community/types";
import { resolveRelative } from "@quartz-community/utils/path";
import { classNames } from "../util/lang";
import style from "./styles/articleCarousel.scss";

type ArticleCarouselPluginData = QuartzPluginData & Record<string, unknown>;

export interface ArticleCarouselOptions {
  /** 组件标题 */
  title?: string;
  /** 每次显示的文章数量 */
  showCount: number;
  /** 自定义过滤器 */
  filter: (f: ArticleCarouselPluginData) => boolean;
}

/**
 * True for Quartz tag-index slugs: `tags`, `tags/index`, or `tags/<anything>`.
 * Tag pages are virtual pages synthesized by the tag-page plugin — Quartz's
 * core pageType dispatcher gives every virtual page a synthetic
 * `frontmatter.title` (the tag name itself), so without this check tag pages
 * would leak into the carousel as fake "articles".
 */
function isTagPageSlug(slug: string | undefined): boolean {
  if (!slug) return false;
  return slug === "tags" || slug === "tags/index" || slug.startsWith("tags/");
}

/** 文章所属专栏 = 所在目录名（如 "中间件/ETCD/02 xx.md" → "ETCD"），根目录文章返回空 */
function seriesOf(relativePath: string | undefined): string {
  if (!relativePath) return "";
  const parts = relativePath.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

const defaultOptions = (): ArticleCarouselOptions => ({
  title: "随机碎片",
  showCount: 4,
  filter: (f) => {
    const slug = (f.slug as string) ?? "";
    if (slug.endsWith("index")) return false;
    if (isTagPageSlug(slug)) return false;
    if ((f as Record<string, unknown>).unlisted === true) return false;
    return !!f.frontmatter?.title;
  },
});

/**
 * 随机文章推荐组件
 * 显示 N 篇随机文章，点击刷新按钮随机切换
 * 首屏卡片构建时随机选取，「换一批」运行时从全局 fetchData 元数据索引抽取
 */
const ArticleCarousel: QuartzComponentConstructor<Partial<ArticleCarouselOptions>> = (
  userOpts?: Partial<ArticleCarouselOptions>,
) => {
  const ArticleCarouselComponent: QuartzComponent = ({
    allFiles,
    fileData,
    displayClass,
    cfg,
  }: QuartzComponentProps) => {
    const opts = { ...defaultOptions(), ...userOpts };

    const pages = allFiles.filter(opts.filter);
    if (pages.length === 0) return null;

    // 构建时随机选 showCount 篇作为首屏内容；「换一批」在浏览器端从全局 fetchData
    // （每页都会加载的轻量元数据索引）里抽取，不再把全站文章列表序列化进首页 HTML。
    const shuffled = [...pages].sort(() => Math.random() - 0.5).slice(0, opts.showCount);
    const initial = shuffled.map((page) => ({
      title: (page.frontmatter?.title as string) ?? "Untitled",
      href: resolveRelative(fileData.slug as never, page.slug as never),
      series: seriesOf((page as Record<string, unknown>).relativePath as string | undefined),
    }));

    return (
      <div
        class={classNames(displayClass, "random-articles")}
        data-random-articles
        data-show-count={String(opts.showCount)}
      >
        <div class="random-articles-header">
          {opts.title && <span class="random-articles-title">{opts.title}</span>}
          <button class="random-articles-refresh" data-refresh-btn aria-label="换一批">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M1 4v4h4" />
              <path d="M3.51 10a5.5 5.5 0 1 0 .49-5.5L1 8" />
            </svg>
            <span>换一批</span>
          </button>
        </div>
        <div class="random-articles-grid" data-articles-grid aria-live="polite">
          {initial.map((article) => (
            <a href={article.href} class="random-article-card internal">
              {article.series && <span class="random-article-series">{article.series}</span>}
              <span class="random-article-title">{article.title}</span>
            </a>
          ))}
        </div>
      </div>
    );
  };

  ArticleCarouselComponent.css = style;
  ArticleCarouselComponent.afterDOMLoaded = `
    let carouselPool = null;

    function seriesOf(filePath) {
      if (!filePath) return "";
      const parts = String(filePath).split("/");
      return parts.length >= 2 ? parts[parts.length - 2] : "";
    }

    async function loadPool() {
      if (carouselPool) return carouselPool;
      const data = typeof fetchData !== "undefined" ? await fetchData : null;
      const index = data && typeof data === "object" ? data : {};
      carouselPool = Object.entries(index)
        .filter(([slug, v]) => {
          if (!v || typeof v !== "object" || !v.title) return false;
          if (slug === "tags" || slug.startsWith("tags/")) return false;
          if (slug === "index" || slug.endsWith("/index")) return false;
          return typeof v.filePath === "string" && v.filePath.endsWith(".md");
        })
        .map(([slug, v]) => ({ title: v.title, slug, series: seriesOf(v.filePath) }));
      return carouselPool;
    }

    function hrefFor(slug) {
      // 组件只在首页渲染，首页位于站点根目录，相对 slug 即可
      const base = document.body.dataset.basepath || "";
      return base + "/" + slug.split("/").map(encodeURIComponent).join("/");
    }

    function shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function setupRandomArticles() {
      document.querySelectorAll("[data-random-articles]").forEach((container) => {
        // 防止重复绑定
        if (container.dataset.bound === "true") return;
        container.dataset.bound = "true";

        const showCount = parseInt(container.dataset.showCount || "4", 10);
        const grid = container.querySelector("[data-articles-grid]");
        const btn = container.querySelector("[data-refresh-btn]");
        if (!grid || !btn) return;

        function renderCards(articles) {
          grid.innerHTML = "";
          articles.forEach((article) => {
            const a = document.createElement("a");
            a.href = hrefFor(article.slug);
            a.className = "random-article-card internal";

            if (article.series) {
              const seriesSpan = document.createElement("span");
              seriesSpan.className = "random-article-series";
              seriesSpan.textContent = article.series;
              a.appendChild(seriesSpan);
            }

            const titleSpan = document.createElement("span");
            titleSpan.className = "random-article-title";
            titleSpan.textContent = article.title;
            a.appendChild(titleSpan);

            grid.appendChild(a);
          });

          grid.classList.remove("fade-in");
          void grid.offsetWidth;
          grid.classList.add("fade-in");
        }

        btn.addEventListener("click", async function(e) {
          e.preventDefault();
          e.stopPropagation();
          const pool = await loadPool();
          if (pool.length === 0) return;
          renderCards(shuffle(pool).slice(0, showCount));

          const svg = btn.querySelector("svg");
          if (svg) {
            svg.style.transition = "transform 0.4s ease";
            svg.style.transform = "rotate(360deg)";
            setTimeout(() => {
              svg.style.transition = "none";
              svg.style.transform = "rotate(0deg)";
            }, 400);
          }
        });
      });
    }

    // 初次加载执行
    setupRandomArticles();
    // SPA 导航后重新绑定
    document.addEventListener("nav", () => {
      // micromorph 后 DOM 已更新，需要重新绑定
      document.querySelectorAll("[data-random-articles]").forEach((c) => {
        c.dataset.bound = "false";
      });
      setupRandomArticles();
    });
  `;

  return ArticleCarouselComponent;
};

export default ArticleCarousel;
export { ArticleCarousel };
