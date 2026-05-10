#!/usr/bin/env python3
"""Download and extract the main article body from a web page.

Fetches the HTML at <url>, strips noise elements (navigation, ads, footers,
sidebars, scripts, etc.), extracts the primary article body as plain text,
collects image references, and writes two helper files into <output_dir>:

  _raw_content.txt  — plain text of the article body
  _images.json      — JSON array of image objects with alt, url, and local path

Also prints a JSON summary to stdout for the AI agent to read.

Usage:
    python fetch_page.py <url> --output <output_dir>
    python fetch_page.py https://example.com/article --output ./notes/article
    python fetch_page.py https://example.com/article --output ./notes --no-images

Dependencies:
    pip install httpx beautifulsoup4
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse


def _check_deps() -> None:
    missing = []
    for pkg in ("httpx", "bs4"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append("httpx" if pkg == "httpx" else "beautifulsoup4")
    if missing:
        print(
            json.dumps({"error": f"Missing dependencies: {', '.join(missing)}. Run: pip install " + " ".join(missing)}),
            flush=True,
        )
        sys.exit(1)


_DROP_SELECTORS = (
    "script", "style", "noscript", "iframe", "svg", "canvas",
    "form", "button", "input", "select", "textarea",
    "nav", "footer", "header", "aside",
    "[role='banner']", "[role='navigation']", "[role='complementary']",
    ".advertisement", ".ads", ".ad", ".share", ".social",
    ".recommend", ".related", ".copyright", ".sidebar",
    ".comment", ".comments", ".cookie-banner", ".cookie",
    ".newsletter", ".subscribe", ".popup", ".modal",
)

_ARTICLE_SELECTORS = (
    "#js_content",           # WeChat public account
    "article",
    "[role='main']",
    "main",
    ".article",
    ".post",
    ".entry-content",
    ".content",
    ".markdown-body",
    ".post-content",
    ".article-content",
    ".article-body",
    ".prose",
    "#content",
    ".container article",
)

_IMAGE_ATTRS = ("data-src", "data-original", "data-lazy-src", "src")
_MIN_IMAGE_SIZE = 50  # px — smaller images are likely decorative


def _fetch_html(url: str, timeout: int = 60) -> tuple[str, str]:
    """Download URL. Returns (html_text, final_url)."""
    import httpx

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }

    with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
        response = client.get(url)
        response.raise_for_status()
        ct = response.headers.get("content-type", "")
        if "text/html" not in ct and "application/xhtml" not in ct:
            raise ValueError(f"URL returned non-HTML content type: {ct}")
        return response.text, str(response.url)


def _extract_title(soup: Any, url: str) -> str:
    from bs4 import Tag

    candidates = [
        soup.select_one("#activity-name"),
        soup.select_one("meta[property='og:title']"),
        soup.select_one("meta[name='twitter:title']"),
        soup.find("h1"),
        soup.find("title"),
    ]
    for c in candidates:
        if not c or not isinstance(c, Tag):
            continue
        v = (c.get("content", "") if c.name == "meta" else c.get_text(" ", strip=True))
        v = re.sub(r"\s+", " ", str(v)).strip()
        if v:
            return v[:200]
    return urlparse(url).netloc or "untitled"


def _extract_article(soup: Any) -> Any:
    from bs4 import Tag

    for sel in _ARTICLE_SELECTORS:
        node = soup.select_one(sel)
        if isinstance(node, Tag) and len(node.get_text(" ", strip=True)) > 100:
            return node

    body = soup.body or soup
    candidates = [
        n for n in body.find_all(["article", "main", "section", "div"], recursive=True)
        if isinstance(n, Tag)
    ]
    if not candidates:
        return body
    return max(candidates, key=lambda n: len(n.get_text(" ", strip=True)))


def _clean_node(node: Any) -> None:
    for sel in _DROP_SELECTORS:
        try:
            for item in node.select(sel):
                item.decompose()
        except Exception:
            pass


def _image_src(node: Any) -> str:
    for attr in _IMAGE_ATTRS:
        v = node.get(attr)
        if isinstance(v, str) and v.strip() and not v.strip().startswith("data:"):
            return v.strip()
    srcset = node.get("srcset")
    if isinstance(srcset, str) and srcset.strip():
        return srcset.split(",")[0].strip().split(" ")[0]
    return ""


def _node_to_text(node: Any, base_url: str, images: list, include_images: bool) -> str:
    """Recursively convert BeautifulSoup node to plain text."""
    from bs4 import NavigableString, Tag

    lines: list[str] = []

    def walk(n: Any, depth: int = 0) -> str:
        if isinstance(n, NavigableString):
            return str(n)
        if not isinstance(n, Tag):
            return ""
        name = (n.name or "").lower()
        if name in {"script", "style", "noscript"}:
            return ""

        if name == "br":
            return "\n"
        if re.match(r"h[1-6]", name):
            level = int(name[1])
            text = " ".join(walk(c) for c in n.children).strip()
            return f"\n\n{'#' * level} {text}\n\n" if text else ""
        if name == "p":
            text = " ".join(walk(c) for c in n.children).strip()
            return f"\n\n{text}\n\n" if text else ""
        if name in {"ul", "ol"}:
            ordered = name == "ol"
            parts = []
            idx = 1
            for li in n.find_all("li", recursive=False):
                text = " ".join(walk(c) for c in li.children).strip()
                if text:
                    prefix = f"{idx}. " if ordered else "- "
                    parts.append(f"{prefix}{text}")
                    idx += 1
            return "\n\n" + "\n".join(parts) + "\n\n" if parts else ""
        if name == "pre":
            code_node = n.find("code")
            lang = ""
            if code_node:
                for cls in (code_node.get("class") or []):
                    m = re.match(r"language-(\w+)", str(cls))
                    if m:
                        lang = m.group(1)
                        break
            text = (code_node or n).get_text("\n", strip=True)
            return f"\n\n```{lang}\n{text}\n```\n\n" if text else ""
        if name == "code":
            text = n.get_text("", strip=True)
            return f"`{text}`" if text else ""
        if name == "blockquote":
            inner = " ".join(walk(c) for c in n.children).strip()
            return f"\n\n> {inner}\n\n" if inner else ""
        if name == "table":
            rows = []
            for tr in n.find_all("tr"):
                cells = [" ".join(walk(c) for c in cell.children).strip() for cell in tr.find_all(["th", "td"])]
                if cells:
                    rows.append(cells)
            if rows:
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                sep = ["---"] * width
                lines_t = ["| " + " | ".join(rows[0]) + " |",
                           "| " + " | ".join(sep) + " |"]
                lines_t.extend("| " + " | ".join(r) + " |" for r in rows[1:])
                return "\n\n" + "\n".join(lines_t) + "\n\n"
            return ""
        if name == "a":
            text = " ".join(walk(c) for c in n.children).strip()
            href = str(n.get("href", "")).strip()
            href = urljoin(base_url, href) if href and not href.startswith("javascript:") else ""
            if text and href:
                return f"[{text}]({href})"
            return text
        if name == "img" and include_images:
            src = _image_src(n)
            if src:
                full_url = urljoin(base_url, src)
                alt = str(n.get("alt", "")).strip() or f"image-{len(images) + 1}"
                # Attempt to get natural dimensions from attributes
                try:
                    w = int(n.get("width") or 0)
                    h = int(n.get("height") or 0)
                except (ValueError, TypeError):
                    w = h = 0
                if w < _MIN_IMAGE_SIZE and h < _MIN_IMAGE_SIZE and (w or h):
                    return ""  # skip tiny decorative images
                idx = len(images) + 1
                ext = Path(urlparse(full_url).path).suffix or ".jpg"
                if not re.match(r"^\.[A-Za-z0-9]{1,8}$", ext):
                    ext = ".jpg"
                local = f"images/image-{idx:03d}{ext}"
                images.append({"alt": alt, "url": full_url, "local": local})
                return f"\n\n![{alt}]({local})\n\n"
            return ""
        if name in {"strong", "b"}:
            text = " ".join(walk(c) for c in n.children).strip()
            return f"**{text}**" if text else ""
        if name in {"em", "i"}:
            text = " ".join(walk(c) for c in n.children).strip()
            return f"*{text}*" if text else ""

        return " ".join(walk(c) for c in n.children)

    raw = walk(node)
    # Normalize whitespace
    raw = re.sub(r"[ \t]+\n", "\n", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _safe_filename(title: str, max_len: int = 120) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", title).strip(" ._")
    if not name:
        name = "url2md"
    if name.upper() in {"CON", "PRN", "AUX", "NUL"}:
        name = f"{name}_"
    return name[:max_len]


def fetch_page(
    url: str,
    output_dir: str,
    include_images: bool = True,
    timeout: int = 60,
) -> dict:
    from bs4 import BeautifulSoup

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    html, final_url = _fetch_html(url, timeout)
    soup = BeautifulSoup(html, "html.parser")

    title = _extract_title(soup, final_url)
    article = _extract_article(soup)
    _clean_node(article)

    images: list[dict] = []
    body_text = _node_to_text(article, final_url, images, include_images)

    # Write plain text content
    content_file = out / "_raw_content.txt"
    header = f"Title: {title}\nSource: {final_url}\n\n{'=' * 60}\n\n"
    content_file.write_text(header + body_text, encoding="utf-8")

    # Write images list
    images_file = out / "_images.json"
    images_file.write_text(json.dumps(images, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "title": title,
        "url": final_url,
        "content_file": str(content_file),
        "images_file": str(images_file),
        "image_count": len(images),
        "content_length": len(body_text),
        "suggested_filename": _safe_filename(title) + ".md",
    }


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Fetch a web page and extract its article body for AI conversion."
    )
    parser.add_argument("url", help="Target URL (http:// or https://)")
    parser.add_argument("--output", required=True, help="Output directory")
    parser.add_argument("--no-images", action="store_true", help="Skip image collection")
    parser.add_argument("--timeout", type=int, default=60, help="HTTP timeout in seconds")
    args = parser.parse_args()

    try:
        result = fetch_page(
            url=args.url,
            output_dir=args.output,
            include_images=not args.no_images,
            timeout=args.timeout,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
