import type {
  GlobalConfiguration,
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
  QuartzPluginData,
  ValidDateType,
} from "@quartz-community/types";
import { formatDate } from "@quartz-community/utils/date";
import { getDate } from "@quartz-community/utils/sort";
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

const defaultOptions = (): ArticleCarouselOptions => ({
  title: "随机碎片",
  showCount: 4,
  filter: (f) => {
    const slug = (f.slug as string) ?? "";
    return !slug.endsWith("index") && !!f.frontmatter?.title;
  },
});

/**
 * Resolve the defaultDateType for a given page, preferring the per-file value
 * set by the CreatedModifiedDate transformer, falling back to the global config.
 */
function resolveDefaultDateType(
  data: ArticleCarouselPluginData,
  cfg: GlobalConfiguration,
): ValidDateType | undefined {
  return (
    (data.defaultDateType as ValidDateType | undefined) ??
    ((cfg as Record<string, unknown>).defaultDateType as ValidDateType | undefined)
  );
}

/**
 * Return a copy of the page data with the resolved defaultDateType applied,
 * so that getDate() from @quartz-community/utils/sort can read it.
 */
function withResolvedDateType(
  data: ArticleCarouselPluginData,
  cfg: GlobalConfiguration,
): QuartzPluginData {
  const resolved = resolveDefaultDateType(data, cfg);
  if (!resolved) return data as QuartzPluginData;
  return { ...data, defaultDateType: resolved };
}

/**
 * 随机文章推荐组件
 * 显示 N 篇随机文章，点击刷新按钮随机切换
 * 所有文章数据构建时注入，运行时由 JS 随机选取
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

    // 构建时将所有候选文章序列化为 JSON，运行时 JS 从中随机选取
    const allArticles = pages.map((page) => {
      const resolved = withResolvedDateType(page as ArticleCarouselPluginData, cfg);
      const date = getDate(resolved);
      return {
        title: (page.frontmatter?.title as string) ?? "Untitled",
        href: resolveRelative(fileData.slug as never, page.slug as never),
        date: date ? formatDate(date, cfg.locale) : "",
      };
    });

    // 构建时先选 showCount 篇作为初始显示
    const shuffled = [...allArticles].sort(() => Math.random() - 0.5);
    const initial = shuffled.slice(0, opts.showCount);

    return (
      <div
        class={classNames(displayClass, "random-articles")}
        data-random-articles
        data-all-articles={JSON.stringify(allArticles)}
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
            >
              <path d="M1 4v4h4" />
              <path d="M3.51 10a5.5 5.5 0 1 0 .49-5.5L1 8" />
            </svg>
            <span>换一批</span>
          </button>
        </div>
        <div class="random-articles-grid" data-articles-grid>
          {initial.map((article) => (
            <a href={article.href} class="random-article-card internal">
              <span class="random-article-title">{article.title}</span>
              {article.date && <span class="random-article-date">{article.date}</span>}
            </a>
          ))}
        </div>
      </div>
    );
  };

  ArticleCarouselComponent.css = style;
  ArticleCarouselComponent.afterDOMLoaded = `
    function setupRandomArticles() {
      document.querySelectorAll("[data-random-articles]").forEach((container) => {
        // 防止重复绑定
        if (container.dataset.bound === "true") return;
        container.dataset.bound = "true";

        const allArticles = JSON.parse(container.dataset.allArticles || "[]");
        const showCount = parseInt(container.dataset.showCount || "4", 10);
        const grid = container.querySelector("[data-articles-grid]");
        const btn = container.querySelector("[data-refresh-btn]");
        if (!grid || !btn || allArticles.length === 0) return;

        function shuffle(arr) {
          const a = [...arr];
          for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
          }
          return a;
        }

        function renderCards(articles) {
          grid.innerHTML = "";
          articles.forEach((article) => {
            const a = document.createElement("a");
            a.href = article.href;
            a.className = "random-article-card internal";

            const titleSpan = document.createElement("span");
            titleSpan.className = "random-article-title";
            titleSpan.textContent = article.title;
            a.appendChild(titleSpan);

            if (article.date) {
              const dateSpan = document.createElement("span");
              dateSpan.className = "random-article-date";
              dateSpan.textContent = article.date;
              a.appendChild(dateSpan);
            }

            grid.appendChild(a);
          });

          grid.classList.remove("fade-in");
          void grid.offsetWidth;
          grid.classList.add("fade-in");
        }

        btn.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
          const selected = shuffle(allArticles).slice(0, showCount);
          renderCards(selected);

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
