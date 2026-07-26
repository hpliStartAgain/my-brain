// node_modules/@quartz-community/utils/dist/date.js
function formatDate(d2, locale = "en-US") {
  return d2.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "2-digit"
  });
}

// node_modules/@quartz-community/utils/dist/sort.js
function getDate(data) {
  const defaultDateType = data.defaultDateType;
  if (!defaultDateType) {
    return void 0;
  }
  const dates = data.dates;
  return dates?.[defaultDateType];
}

// node_modules/@quartz-community/utils/dist/path.js
function simplifySlug(fp) {
  const res = stripSlashes(trimSuffix(fp, "index"), true);
  return res.length === 0 ? "/" : res;
}
function joinSegments(...args) {
  if (args.length === 0) {
    return "";
  }
  let joined = args.filter((segment) => segment !== "" && segment !== "/").map((segment) => stripSlashes(segment)).join("/");
  const first = args[0];
  const last = args[args.length - 1];
  if (first?.startsWith("/")) {
    joined = "/" + joined;
  }
  if (last?.endsWith("/")) {
    joined = joined + "/";
  }
  return joined;
}
function endsWith(s2, suffix) {
  return s2 === suffix || s2.endsWith("/" + suffix);
}
function trimSuffix(s2, suffix) {
  if (endsWith(s2, suffix)) {
    s2 = s2.slice(0, -suffix.length);
  }
  return s2;
}
function stripSlashes(s2, onlyStripPrefix) {
  if (s2.startsWith("/")) {
    s2 = s2.substring(1);
  }
  if (!onlyStripPrefix && s2.endsWith("/")) {
    s2 = s2.slice(0, -1);
  }
  return s2;
}
function pathToRoot(slug2) {
  let rootPath = slug2.split("/").filter((x2) => x2 !== "").slice(0, -1).map((_2) => "..").join("/");
  if (rootPath.length === 0) {
    rootPath = ".";
  }
  return rootPath;
}
function resolveRelative(current, target) {
  const res = joinSegments(pathToRoot(current), simplifySlug(target));
  return res;
}

// src/util/lang.ts
function classNames(...classes) {
  return classes.flat().filter(Boolean).join(" ");
}

// src/components/styles/articleCarousel.scss
var articleCarousel_default = ".random-articles {\n  margin: 0 0 1.5rem;\n  border-bottom: 1px solid var(--lightgray);\n  padding-bottom: 1.5rem;\n}\n.random-articles .random-articles-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 1rem;\n}\n.random-articles .random-articles-title {\n  font-size: 0.75rem;\n  font-weight: 600;\n  text-transform: uppercase;\n  letter-spacing: 0.05em;\n  color: var(--gray);\n  font-family: var(--bodyFont);\n}\n.random-articles .random-articles-refresh {\n  display: flex;\n  align-items: center;\n  gap: 0.35rem;\n  padding: 0.3rem 0.7rem;\n  border: 1px solid var(--lightgray);\n  border-radius: 9999px;\n  background: transparent;\n  color: var(--gray);\n  font-size: 0.75rem;\n  font-family: var(--bodyFont);\n  cursor: pointer;\n  transition: all 0.2s ease;\n}\n.random-articles .random-articles-refresh:hover {\n  color: var(--secondary);\n  border-color: var(--secondary);\n  background: color-mix(in srgb, var(--secondary) 5%, transparent);\n}\n.random-articles .random-articles-refresh:active {\n  transform: scale(0.97);\n}\n.random-articles .random-articles-refresh svg {\n  flex-shrink: 0;\n}\n.random-articles .random-articles-grid {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  gap: 1px;\n  background: var(--lightgray);\n  border: 1px solid var(--lightgray);\n  border-radius: 0.5rem;\n  overflow: hidden;\n}\n.random-articles .random-articles-grid.fade-in {\n  animation: randomFadeIn 0.3s ease;\n}\n@media (max-width: 800px) {\n  .random-articles .random-articles-grid {\n    grid-template-columns: repeat(2, 1fr);\n  }\n}\n.random-articles .random-article-card {\n  background: var(--light);\n  padding: 1rem 1.2rem;\n  display: flex;\n  flex-direction: column;\n  gap: 0.35rem;\n  text-decoration: none !important;\n  transition: background-color 0.15s ease;\n}\n.random-articles .random-article-card:hover {\n  background: color-mix(in srgb, var(--lightgray) 20%, var(--light));\n}\n.random-articles .random-article-title {\n  font-family: var(--bodyFont);\n  font-size: 0.88rem;\n  font-weight: 500;\n  color: var(--darkgray);\n  line-height: 1.35;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n}\n.random-articles .random-article-date {\n  font-size: 0.72rem;\n  color: var(--gray);\n  margin-top: auto;\n}\n\n@keyframes randomFadeIn {\n  from {\n    opacity: 0.3;\n    transform: translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}";
var l;
l = { __e: function(n2, l2, u3, t2) {
  for (var i2, r2, o2; l2 = l2.__; ) if ((i2 = l2.__c) && !i2.__) try {
    if ((r2 = i2.constructor) && null != r2.getDerivedStateFromError && (i2.setState(r2.getDerivedStateFromError(n2)), o2 = i2.__d), null != i2.componentDidCatch && (i2.componentDidCatch(n2, t2 || {}), o2 = i2.__d), o2) return i2.__E = i2;
  } catch (l3) {
    n2 = l3;
  }
  throw n2;
} }, "function" == typeof Promise ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, Math.random().toString(8);

// node_modules/preact/jsx-runtime/dist/jsxRuntime.mjs
var f2 = 0;
function u2(e2, t2, n2, o2, i2, u3) {
  t2 || (t2 = {});
  var a2, c2, p2 = t2;
  if ("ref" in p2) for (c2 in p2 = {}, t2) "ref" == c2 ? a2 = t2[c2] : p2[c2] = t2[c2];
  var l2 = { type: e2, props: p2, key: n2, ref: a2, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: void 0, __v: --f2, __i: -1, __u: 0, __source: i2, __self: u3 };
  if ("function" == typeof e2 && (a2 = e2.defaultProps)) for (c2 in a2) void 0 === p2[c2] && (p2[c2] = a2[c2]);
  return l.vnode && l.vnode(l2), l2;
}

// src/components/ArticleCarousel.tsx
var defaultOptions = () => ({
  title: "\u968F\u673A\u788E\u7247",
  showCount: 4,
  filter: (f3) => {
    const slug2 = f3.slug ?? "";
    return !slug2.endsWith("index") && !!f3.frontmatter?.title;
  }
});
function resolveDefaultDateType(data, cfg) {
  return data.defaultDateType ?? cfg.defaultDateType;
}
function withResolvedDateType(data, cfg) {
  const resolved = resolveDefaultDateType(data, cfg);
  if (!resolved) return data;
  return { ...data, defaultDateType: resolved };
}
var ArticleCarousel = (userOpts) => {
  const ArticleCarouselComponent = ({
    allFiles,
    fileData,
    displayClass,
    cfg
  }) => {
    const opts = { ...defaultOptions(), ...userOpts };
    const pages = allFiles.filter(opts.filter);
    if (pages.length === 0) return null;
    const allArticles = pages.map((page) => {
      const resolved = withResolvedDateType(page, cfg);
      const date = getDate(resolved);
      return {
        title: page.frontmatter?.title ?? "Untitled",
        href: resolveRelative(fileData.slug, page.slug),
        date: date ? formatDate(date, cfg.locale) : ""
      };
    });
    const shuffled = [...allArticles].sort(() => Math.random() - 0.5);
    const initial = shuffled.slice(0, opts.showCount);
    return /* @__PURE__ */ u2(
      "div",
      {
        class: classNames(displayClass, "random-articles"),
        "data-random-articles": true,
        "data-all-articles": JSON.stringify(allArticles),
        "data-show-count": String(opts.showCount),
        children: [
          /* @__PURE__ */ u2("div", { class: "random-articles-header", children: [
            opts.title && /* @__PURE__ */ u2("span", { class: "random-articles-title", children: opts.title }),
            /* @__PURE__ */ u2("button", { class: "random-articles-refresh", "data-refresh-btn": true, "aria-label": "\u6362\u4E00\u6279", children: [
              /* @__PURE__ */ u2(
                "svg",
                {
                  width: "14",
                  height: "14",
                  viewBox: "0 0 16 16",
                  fill: "none",
                  stroke: "currentColor",
                  "stroke-width": "1.5",
                  "stroke-linecap": "round",
                  "stroke-linejoin": "round",
                  children: [
                    /* @__PURE__ */ u2("path", { d: "M1 4v4h4" }),
                    /* @__PURE__ */ u2("path", { d: "M3.51 10a5.5 5.5 0 1 0 .49-5.5L1 8" })
                  ]
                }
              ),
              /* @__PURE__ */ u2("span", { children: "\u6362\u4E00\u6279" })
            ] })
          ] }),
          /* @__PURE__ */ u2("div", { class: "random-articles-grid", "data-articles-grid": true, children: initial.map((article) => /* @__PURE__ */ u2("a", { href: article.href, class: "random-article-card internal", children: [
            /* @__PURE__ */ u2("span", { class: "random-article-title", children: article.title }),
            article.date && /* @__PURE__ */ u2("span", { class: "random-article-date", children: article.date })
          ] })) })
        ]
      }
    );
  };
  ArticleCarouselComponent.css = articleCarousel_default;
  ArticleCarouselComponent.afterDOMLoaded = `
    function setupRandomArticles() {
      document.querySelectorAll("[data-random-articles]").forEach((container) => {
        // \u9632\u6B62\u91CD\u590D\u7ED1\u5B9A
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

    // \u521D\u6B21\u52A0\u8F7D\u6267\u884C
    setupRandomArticles();
    // SPA \u5BFC\u822A\u540E\u91CD\u65B0\u7ED1\u5B9A
    document.addEventListener("nav", () => {
      // micromorph \u540E DOM \u5DF2\u66F4\u65B0\uFF0C\u9700\u8981\u91CD\u65B0\u7ED1\u5B9A
      document.querySelectorAll("[data-random-articles]").forEach((c) => {
        c.dataset.bound = "false";
      });
      setupRandomArticles();
    });
  `;
  return ArticleCarouselComponent;
};
var ArticleCarousel_default = ArticleCarousel;

export { ArticleCarousel, ArticleCarousel_default as default };
//# sourceMappingURL=ArticleCarousel.js.map
//# sourceMappingURL=ArticleCarousel.js.map