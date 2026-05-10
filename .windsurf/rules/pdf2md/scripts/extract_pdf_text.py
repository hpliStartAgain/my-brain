#!/usr/bin/env python3
"""Extract plain text from a page range of a PDF file.

Reads the specified page range (1-indexed, inclusive) and writes the extracted
text to stdout or an output file. Page range validation is strict so bad plans
fail early instead of silently producing incomplete chapters.

Usage:
    python extract_pdf_text.py <pdf_path> --start <page> --end <page>
    python extract_pdf_text.py book.pdf --start 1 --end 24 --output ./_work/ch001.txt
    python extract_pdf_text.py book.pdf --start 1 --end 24 --no-sort

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


def _validate_pages(start_page: int, end_page: int, page_count: int) -> tuple[int, int]:
    if start_page < 1:
        raise ValueError("--start must be >= 1")
    if end_page < 1:
        raise ValueError("--end must be >= 1")
    if start_page > end_page:
        raise ValueError("--start must be <= --end")
    if start_page > page_count:
        raise ValueError(f"--start exceeds PDF page count ({page_count})")
    if end_page > page_count:
        raise ValueError(f"--end exceeds PDF page count ({page_count})")
    return start_page - 1, end_page - 1


def extract_text_range(pdf_path: str, start_page: int, end_page: int, sort: bool = True) -> str:
    import fitz

    path = Path(pdf_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")

    doc = fitz.open(str(path))
    try:
        page_count = len(doc)
        start_0, end_0 = _validate_pages(start_page, end_page, page_count)

        parts = []
        for i in range(start_0, end_0 + 1):
            text = doc[i].get_text("text", sort=sort).strip()
            body = text if text else "[empty page]"
            parts.append(f"--- Page {i + 1} ---\n{body}")
        return "\n\n".join(parts)
    finally:
        doc.close()


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Extract plain text from a PDF page range for AI conversion."
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("--start", type=int, required=True, help="First page to extract (1-indexed)")
    parser.add_argument("--end", type=int, required=True, help="Last page to extract (1-indexed, inclusive)")
    parser.add_argument("--output", help="Optional file path to write extracted text")
    parser.add_argument("--no-sort", action="store_true", help="Do not ask PyMuPDF to sort extracted text by layout order")
    args = parser.parse_args()

    try:
        text = extract_text_range(args.pdf, args.start, args.end, sort=not args.no_sort)
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(text, encoding="utf-8")
        else:
            print(text)
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
