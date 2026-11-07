const defaultOptions = {
    dedupeTitleHeading: true,
    generateDescription: true,
    descriptionLength: 140,
    lazyImages: true,
};
const SKIP_TYPES = new Set(["yaml", "toml", "html", "definition"]);
function nodeText(node) {
    if (node.type === "code" || node.type === "html" || node.type === "math")
        return "";
    if (node.type === "inlineMath")
        return node.value ?? "";
    if (typeof node.value === "string")
        return node.value;
    if (node.type === "break")
        return " ";
    return (node.children ?? []).map(nodeText).join("");
}
/** 去掉 Obsidian 语法残留：[[a|b]] → b，[[a]] → a，==高亮== → 高亮，脚注标记等 */
function cleanText(text) {
    return text
        .replace(/!\[\[[^\]]*\]\]/g, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, (_m, p) => p.split("#").pop() ?? p)
        .replace(/==([^=]+)==/g, "$1")
        .replace(/\[\^[^\]]+\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
const NUMBER_PREFIX = /^(第\s*[\d一二三四五六七八九十百]+\s*[章篇节讲部分]|[\d]+(\.\d+)*)[\s.、\-_—:：]*/;
function normalizeTitle(text) {
    return text
        .trim()
        .replace(NUMBER_PREFIX, "")
        .replace(/[\s\-_—:：,，.。·、|｜()（）《》<>"“”'‘’`!！?？]+/g, "")
        .toLowerCase();
}
function sameTitle(a, b) {
    const x = normalizeTitle(a);
    const y = normalizeTitle(b);
    if (!x || !y)
        return false;
    if (x === y)
        return true;
    // 一方包含另一方，且长度接近（避免"导览"这类短标题误伤）
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return long.includes(short) && short.length / long.length >= 0.6;
}
const SENTENCE_END = /[。！？；!?;]/g;
function truncate(text, limit) {
    if (text.length <= limit)
        return text;
    let cut = -1;
    for (const m of text.matchAll(SENTENCE_END)) {
        const idx = (m.index ?? 0) + 1;
        if (idx > limit)
            break;
        cut = idx;
    }
    if (cut >= limit * 0.45)
        return text.slice(0, cut);
    return text.slice(0, limit).replace(/[，,、：:\s]+$/, "") + "…";
}
const SUMMARY_LEAD = /^\s*摘要\s*[:：]?\s*/;
const CALLOUT_SUMMARY = /^\s*\[!(abstract|summary|tldr)\][-+]?\s*[^\n]*\n?/i;
function isParagraphLike(node) {
    return node.type === "paragraph";
}
function findSummary(children) {
    // a. **摘要：** 开头的段落（摘要文字可能在同一段，也可能在下一段）
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (!isParagraphLike(node))
            continue;
        const first = node.children?.[0];
        if (!first || first.type !== "strong" || !SUMMARY_LEAD.test(nodeText(first)))
            continue;
        const rest = cleanText(nodeText(node).replace(SUMMARY_LEAD, ""));
        if (rest.length >= 20)
            return rest;
        const next = children[i + 1];
        if (next && isParagraphLike(next))
            return cleanText(nodeText(next));
    }
    // b. `## 摘要` 标题下的第一个段落
    for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (node.type !== "heading" || !/^\s*摘要\s*$/.test(nodeText(node)))
            continue;
        for (let j = i + 1; j < children.length && children[j].type !== "heading"; j++) {
            if (isParagraphLike(children[j])) {
                const text = cleanText(nodeText(children[j]));
                if (text)
                    return text;
            }
        }
    }
    // c. > [!abstract] / [!summary] / [!tldr] Callout
    for (const node of children) {
        if (node.type !== "blockquote")
            continue;
        const raw = nodeText({ type: "root", children: node.children?.slice(0, 1) });
        if (!CALLOUT_SUMMARY.test(raw))
            continue;
        const text = cleanText((node.children ?? [])
            .map((c) => nodeText(c))
            .join(" ")
            .replace(CALLOUT_SUMMARY, ""));
        if (text)
            return text;
    }
    return undefined;
}
function firstParagraphs(children, min) {
    let acc = "";
    for (const node of children) {
        if (node.type === "heading" && acc)
            break;
        if (!isParagraphLike(node))
            continue;
        const text = cleanText(nodeText(node));
        if (!text)
            continue;
        acc = acc ? `${acc} ${text}` : text;
        if (acc.length >= min)
            break;
    }
    return acc || undefined;
}
export const ContentPolish = (userOpts) => {
    const opts = { ...defaultOptions, ...userOpts };
    return {
        name: "ContentPolish",
        htmlPlugins() {
            if (!opts.lazyImages)
                return [];
            return [
                () => (tree) => {
                    const walk = (node) => {
                        if (node.type === "element" && node.tagName === "img") {
                            const props = (node.properties ??= {});
                            props.loading ??= "lazy";
                            props.decoding ??= "async";
                        }
                        node.children?.forEach(walk);
                    };
                    walk(tree);
                },
            ];
        },
        markdownPlugins() {
            return [
                () => (tree, file) => {
                    const root = tree;
                    const children = root.children ?? [];
                    const frontmatter = (file.data.frontmatter ??= {});
                    const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
                    if (opts.dedupeTitleHeading && title) {
                        const idx = children.findIndex((n) => !SKIP_TYPES.has(n.type));
                        const node = children[idx];
                        if (node &&
                            node.type === "heading" &&
                            node.depth === 1 &&
                            sameTitle(nodeText(node), title)) {
                            children.splice(idx, 1);
                        }
                    }
                    if (opts.generateDescription && !frontmatter.description) {
                        const desc = findSummary(children) ?? firstParagraphs(children, opts.descriptionLength);
                        if (desc && desc.length >= 10) {
                            frontmatter.description = truncate(desc, opts.descriptionLength);
                        }
                    }
                },
            ];
        },
    };
};
export default ContentPolish;
