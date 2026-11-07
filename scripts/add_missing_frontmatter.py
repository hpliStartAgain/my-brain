"""为缺少 frontmatter 的 Markdown 补齐 title / date / tags / aliases（正文不改动）。

- title：正文首个非空行若是 `# 标题` 则取之；否则用文件名（`_glossary` → 「<目录> 术语表」，`_index` → 目录名）
- date：git 首次提交该文件的日期（找不到时用今天）
- tags：按顶层目录映射到受控词表中的领域标签
用法：python3 scripts/add_missing_frontmatter.py [--apply]
"""
import datetime
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CONTENT = os.path.join(ROOT, "content")
DOMAIN_TAG = {
    "Golang": "Golang", "Java": "Java", "Linux": "Linux", "LLM": "LLM", "SRE": "SRE",
    "中间件": "中间件", "云原生": "云原生", "分布式架构": "分布式系统", "可观测": "可观测性",
    "大数据": "大数据", "数据结构与算法": "算法", "译书": "译书",
}


def q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def git_date(path):
    out = subprocess.run(
        ["git", "log", "--diff-filter=A", "--follow", "--format=%as", "--", path],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip().splitlines()
    return out[-1] if out else datetime.date.today().isoformat()


def main(apply):
    n = 0
    for r, _, fs in os.walk(CONTENT):
        for f in sorted(fs):
            if not f.endswith(".md"):
                continue
            p = os.path.join(r, f)
            s = open(p, encoding="utf-8").read()
            if s.startswith("---\n"):
                continue
            rel = os.path.relpath(p, CONTENT)
            parts = rel.split(os.sep)
            stem = f[:-3]
            first = next((l for l in s.split("\n") if l.strip()), "")
            if first.startswith("# "):
                title = first[2:].strip()
            elif stem.startswith("_glossary"):
                title = f"{parts[-2]} 术语表"
            elif stem == "_index":
                title = parts[-2]
            else:
                title = stem.replace("_", " ").strip()
            tag = DOMAIN_TAG.get(parts[0])
            tags = f"[{tag}]" if tag else "[]"
            fm = f"---\ntitle: {q(title)}\ndate: {git_date(p)}\ntags: {tags}\naliases: []\n---\n\n"
            n += 1
            if n <= 5 or not apply:
                print(rel[:70], "|", title[:40])
            if apply:
                open(p, "w", encoding="utf-8").write(fm + s.lstrip("\n"))
    print("files:", n)


if __name__ == "__main__":
    main("--apply" in sys.argv)
