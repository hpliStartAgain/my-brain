#!/usr/bin/env python3
"""Extract the table of contents and metadata from a PDF file.

Reads the PDF, extracts the embedded ToC if any, captures sample text from the
first few pages, and prints a JSON object to stdout for chapter planning.

Usage:
    python extract_pdf_outline.py <pdf_path>
    python extract_pdf_outline.py /books/DDIA.pdf --sample-pages 8

Dependencies:
    pip install pymupdf
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _check_deps() -> None:
    try:
        import fitz  # noqa: F401
    except ImportError:
        print(json.dumps({"error": "PyMuPDF is not installed. Run: pip install pymupdf"}), file=sys.stderr)
        sys.exit(1)


def _detect_language(text: str) -> str:
    chinese = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    ascii_letters = sum(1 for ch in text if ("a" <= ch.lower() <= "z"))
    if chinese > ascii_letters * 0.2:
        return "zh"
    if ascii_letters:
        return "en"
    return "unknown"


def extract_pdf_outline(pdf_path: str, sample_pages: int = 5) -> dict:
    import fitz

    path = Path(pdf_path).resolve()
    warnings: list[str] = []
    if not path.exists():
        return {"error": f"File not found: {path}"}
    if not path.is_file():
        return {"error": f"Not a file: {path}"}
    if sample_pages < 1:
        return {"error": "--sample-pages must be >= 1"}

    try:
        doc = fitz.open(str(path))
    except Exception as exc:
        return {"error": f"Cannot open PDF: {exc}"}

    try:
        page_count = len(doc)
        toc = doc.get_toc()
        n = min(sample_pages, page_count)
        parts = []
        non_empty_pages = 0

        for i in range(n):
            text = doc[i].get_text("text", sort=True).strip()
            if text:
                non_empty_pages += 1
                parts.append(f"--- Page {i + 1} ---\n{text}")
            else:
                parts.append(f"--- Page {i + 1} ---\n[empty page]")

        sample_text = "\n\n".join(parts)
        if not toc:
            warnings.append("No embedded table of contents found; infer structure from headings and samples.")
        if n and non_empty_pages == 0:
            warnings.append("Sample pages contain no extractable text; this may be a scanned or image-only PDF.")
        elif n and non_empty_pages / n < 0.5:
            warnings.append("Most sampled pages have little or no extractable text; verify extraction quality.")

        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip() or path.stem

        return {
            "title": title,
            "path": str(path),
            "page_count": page_count,
            "toc": toc,
            "has_toc": bool(toc),
            "sample_pages": n,
            "sample_non_empty_pages": non_empty_pages,
            "detected_language": _detect_language(sample_text),
            "metadata": meta,
            "warnings": warnings,
            "sample_text": sample_text,
        }
    finally:
        doc.close()


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Extract ToC and metadata from a PDF for AI-driven chapter planning."
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("--sample-pages", type=int, default=5, help="Number of pages to include as sample text (default: 5)")
    args = parser.parse_args()

    result = extract_pdf_outline(args.pdf, args.sample_pages)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main())
