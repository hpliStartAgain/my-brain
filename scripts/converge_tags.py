"""把 frontmatter 的 tags 收敛到受控词表，长尾标签迁入 keywords 字段。

用法：python3 scripts/converge_tags.py [--apply]
不带 --apply 只打印统计与词表；带 --apply 原地改写 content/ 下的 Markdown。
只改动 frontmatter 中的 `tags:` 行（以及在其后插入/合并 `keywords:` 行），正文一字不动。
"""
import collections
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from tag_vocabulary import DROP, MERGE, MIN_COUNT  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "content")
FM_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
TAGS_RE = re.compile(r"^tags:\s*\[(.*?)\]\s*$", re.M)
KW_RE = re.compile(r"^keywords:\s*\[(.*?)\]\s*$", re.M)


def split_inline(s):
    return [t.strip().strip("\"'") for t in s.split(",") if t.strip().strip("\"'")]


def fmt_inline(items):
    def q(t):
        return f'"{t}"' if re.search(r"[,:#\[\]{}&*!|>'\"%@`]", t) or t != t.strip() else t
    return "[" + ", ".join(q(t) for t in items) + "]"


def canonical(tag, display):
    key = tag.lower()
    if key in MERGE:
        return MERGE[key]
    return display.get(key, tag)


def main(apply):
    files = []
    for r, _, fs in os.walk(ROOT):
        for f in fs:
            if f.endswith(".md"):
                files.append(os.path.join(r, f))
    parsed = {}
    variants = collections.defaultdict(collections.Counter)
    for p in files:
        s = open(p, encoding="utf-8").read()
        m = FM_RE.match(s)
        if not m:
            continue
        t = TAGS_RE.search(m.group(1))
        if not t:
            continue
        tags = split_inline(t.group(1))
        parsed[p] = (s, m, tags)
        for tag in tags:
            variants[tag.lower()][tag] += 1
    display = {k: v.most_common(1)[0][0] for k, v in variants.items()}

    counts = collections.Counter()
    for _, _, tags in parsed.values():
        for c in {canonical(t, display) for t in tags}:
            counts[c] += 1
    vocab = {t for t, n in counts.items() if n >= MIN_COUNT and t not in DROP}

    before = len(variants)
    changed = 0
    per_file = []
    for p, (s, m, tags) in parsed.items():
        keep, extra = [], []
        for t in tags:
            c = canonical(t, display)
            if c in vocab:
                if c not in keep:
                    keep.append(c)
            elif t not in extra and c not in extra:
                extra.append(t)
        fm = m.group(1)
        kw = KW_RE.search(fm)
        old_kw = split_inline(kw.group(1)) if kw else []
        keywords = old_kw + [k for k in extra if k not in old_kw]
        new_fm = TAGS_RE.sub(lambda _: "tags: " + fmt_inline(keep), fm, count=1)
        if keywords:
            if kw:
                new_fm = KW_RE.sub(lambda _: "keywords: " + fmt_inline(keywords), new_fm, count=1)
            else:
                new_fm = TAGS_RE.sub(
                    lambda mm: mm.group(0) + "\nkeywords: " + fmt_inline(keywords), new_fm, count=1
                )
        per_file.append(len(keep))
        if new_fm != fm:
            changed += 1
            if apply:
                out = "---\n" + new_fm + "\n---\n" + s[m.end():]
                open(p, "w", encoding="utf-8").write(out)

    print(f"files with tags: {len(parsed)}, changed: {changed}")
    print(f"unique tags: {before} -> {len(vocab)}")
    print(f"avg tags/file after: {sum(per_file)/len(per_file):.2f}, files with 0 tags: {per_file.count(0)}")
    print(" | ".join(f"{t}:{counts[t]}" for t in sorted(vocab, key=lambda x: -counts[x])))


if __name__ == "__main__":
    main("--apply" in sys.argv)
