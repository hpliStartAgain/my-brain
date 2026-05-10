#!/usr/bin/env python3
"""Extract the table of contents and metadata from a PDF file.

Reads the PDF, extracts the embedded ToC (if any), captures sample text
from the first few pages, and prints a JSON object to stdout for the AI
agent to read and use when planning the chapter layout.

Usage:
    python extract_pdf_outline.py <pdf_path>
    python extract_pdf_outline.py /books/数据结构.pdf
    python extract_pdf_outline.py /books/DDIA.pdf --sample-pages 8

Output (stdout, JSON):
    {
        "title": "Designing Data-Intensive Applications",
        "path": "/abs/path/to/DDIA.pdf",
        "page_count": 562,
        "toc": [
            [1, "Part I. Foundations of Data Systems", 1],
            [2, "Chapter 1: Reliable, Scalable, and Maintainable Applications", 3],
            ...
        ],
        "sample_text": "--- Page 1 ---\\nPart I\\nFoundations...",
        "has_toc": true
    }

toc entries are [level, title, page_number] triples (PyMuPDF format).
When no embedded ToC exists, toc is [] and has_toc is false — the AI
should rely on sample_text to infer structure instead.

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
        print(
            json.dumps({"error": "PyMuPDF is not installed. Run: pip install pymupdf"}),
            flush=True,
        )
        sys.exit(1)


def extract_pdf_outline(pdf_path: str, sample_pages: int = 5) -> dict:
    import fitz

    path = Path(pdf_path).resolve()
    if not path.exists():
        return {"error": f"File not found: {path}"}

    try:
        doc = fitz.open(str(path))
    except Exception as exc:
        return {"error": f"Cannot open PDF: {exc}"}

    try:
        page_count = len(doc)
        toc = doc.get_toc()

        # Collect sample text from first N pages
        n = min(sample_pages, page_count)
        parts = []
        for i in range(n):
            text = doc[i].get_text().strip()
            if text:
                parts.append(f"--- Page {i + 1} ---\n{text}")
        sample_text = "\n\n".join(parts)

        # Try to get document title from metadata
        meta = doc.metadata or {}
        title = meta.get("title") or path.stem

        return {
            "title": title,
            "path": str(path),
            "page_count": page_count,
            "toc": toc,
            "has_toc": bool(toc),
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
    parser.add_argument(
        "--sample-pages",
        type=int,
        default=5,
        help="Number of pages to include as sample text (default: 5)",
    )
    args = parser.parse_args()

    result = extract_pdf_outline(args.pdf, args.sample_pages)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if "error" not in result else 1


if __name__ == "__main__":
    sys.exit(main())
