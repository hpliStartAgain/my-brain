#!/usr/bin/env python3
"""Extract plain text from a page range of a PDF file.

Reads the specified page range (1-indexed, inclusive) and writes the
extracted text to stdout. The AI agent reads this text and converts it
to Obsidian Markdown.

Usage:
    python extract_pdf_text.py <pdf_path> --start <page> --end <page>
    python extract_pdf_text.py /books/数据结构.pdf --start 1 --end 24
    python extract_pdf_text.py /books/数据结构.pdf --start 25 --end 49 --page-labels

Output:
    Plain text of the requested pages, with page separators:

        --- Page 1 ---
        Chapter 1
        Arrays
        ...
        --- Page 2 ---
        1.1 Basic Operations
        ...

Redirect to a file if needed:
    python extract_pdf_text.py book.pdf --start 1 --end 24 > /tmp/ch001.txt

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


def extract_text_range(pdf_path: str, start_page: int, end_page: int) -> str:
    """
    Extract text from start_page to end_page (1-indexed, inclusive).
    Returns concatenated text with page headers.
    """
    import fitz

    path = Path(pdf_path).resolve()
    doc = fitz.open(str(path))
    page_count = len(doc)

    # Clamp to valid range (convert to 0-indexed)
    start_0 = max(0, start_page - 1)
    end_0 = min(page_count - 1, end_page - 1)

    parts = []
    try:
        for i in range(start_0, end_0 + 1):
            text = doc[i].get_text().strip()
            parts.append(f"--- Page {i + 1} ---\n{text}" if text else f"--- Page {i + 1} ---\n[empty page]")
    finally:
        doc.close()

    return "\n\n".join(parts)


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Extract plain text from a PDF page range for AI conversion."
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument(
        "--start",
        type=int,
        required=True,
        help="First page to extract (1-indexed)",
    )
    parser.add_argument(
        "--end",
        type=int,
        required=True,
        help="Last page to extract (1-indexed, inclusive)",
    )
    parser.add_argument(
        "--output",
        help="Path to the output file (optional)",
    )
    args = parser.parse_args()

    try:
        text = extract_text_range(args.pdf, args.start, args.end)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(text)
        else:
            print(text)
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if sys.stdout.encoding != 'utf-8':
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.exit(main())
