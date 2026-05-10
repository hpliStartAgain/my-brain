#!/usr/bin/env python3
"""Extract images from a page range of a PDF and save them to a directory.

Reads the specified page range, extracts all embedded raster images (skipping
small decorative images), saves them as files in the output directory, and
prints a JSON array to stdout so the AI agent knows which images to inspect.

Usage:
    python extract_pdf_images.py <pdf_path> --start <page> --end <page> --output <dir>
    python extract_pdf_images.py /books/数据结构.pdf --start 1 --end 24 \
        --output ./output/数据结构/images/chapter-001/

Output (stdout, JSON array):
    [
        {
            "file": "/abs/path/to/images/chapter-001/page003_img001.png",
            "page": 3,
            "width": 800,
            "height": 600,
            "format": "png"
        },
        ...
    ]

Images smaller than --min-size px in either dimension are skipped (decorative,
icons, spacers). Duplicate image data (same xref) is extracted only once even
if referenced on multiple pages.

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


def extract_images(
    pdf_path: str,
    start_page: int,
    end_page: int,
    output_dir: str,
    min_size: int = 80,
) -> list:
    """
    Extract images from start_page to end_page (1-indexed, inclusive).
    Returns a list of image metadata dicts.
    """
    import fitz

    path = Path(pdf_path).resolve()
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(path))
    page_count = len(doc)
    start_0 = max(0, start_page - 1)
    end_0 = min(page_count - 1, end_page - 1)

    seen_xrefs: set[int] = set()
    results = []

    try:
        for page_num in range(start_0, end_0 + 1):
            page = doc[page_num]
            try:
                img_list = page.get_images(full=True)
            except Exception:
                continue

            img_count_on_page = 0
            for img in img_list:
                xref = img[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)

                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        continue
                    w = base_image.get("width", 0)
                    h = base_image.get("height", 0)
                    if w < min_size or h < min_size:
                        continue

                    ext = base_image.get("ext", "png")
                    img_count_on_page += 1
                    filename = f"page{page_num + 1:04d}_img{img_count_on_page:03d}.{ext}"
                    file_path = out / filename
                    file_path.write_bytes(base_image["image"])

                    results.append({
                        "file": str(file_path),
                        "page": page_num + 1,
                        "width": w,
                        "height": h,
                        "format": ext,
                    })
                except Exception:
                    continue
    finally:
        doc.close()

    return results


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Extract images from a PDF page range for AI analysis."
    )
    parser.add_argument("pdf", help="Path to the PDF file")
    parser.add_argument("--start", type=int, required=True, help="First page (1-indexed)")
    parser.add_argument("--end", type=int, required=True, help="Last page (1-indexed, inclusive)")
    parser.add_argument("--output", required=True, help="Directory to save extracted images")
    parser.add_argument(
        "--min-size",
        type=int,
        default=80,
        help="Minimum image dimension in pixels to include (default: 80)",
    )
    args = parser.parse_args()

    try:
        results = extract_images(
            pdf_path=args.pdf,
            start_page=args.start,
            end_page=args.end,
            output_dir=args.output,
            min_size=args.min_size,
        )
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
