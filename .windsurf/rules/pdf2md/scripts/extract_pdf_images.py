#!/usr/bin/env python3
"""Extract images from a page range of a PDF and save them to a directory.

Reads the specified page range, extracts embedded raster images, saves useful
images as files, records repeated occurrences, and prints JSON metadata so the
AI agent knows which images to inspect.

Usage:
    python extract_pdf_images.py <pdf_path> --start <page> --end <page> --output <dir>
    python extract_pdf_images.py /books/????.pdf --start 1 --end 24 \
        --output ./output/????/images/chapter-001/

Dependencies:
    pip install pymupdf
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


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


def extract_images(
    pdf_path: str,
    start_page: int,
    end_page: int,
    output_dir: str,
    min_size: int = 80,
) -> dict[str, Any]:
    import fitz

    path = Path(pdf_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")
    if min_size < 1:
        raise ValueError("--min-size must be >= 1")

    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(path))
    try:
        page_count = len(doc)
        start_0, end_0 = _validate_pages(start_page, end_page, page_count)
        xref_cache: dict[int, dict[str, Any]] = {}
        images: list[dict[str, Any]] = []
        warnings: list[str] = []
        errors: list[dict[str, Any]] = []

        for page_num in range(start_0, end_0 + 1):
            page = doc[page_num]
            try:
                image_list = page.get_images(full=True)
            except Exception as exc:
                errors.append({"page": page_num + 1, "error": f"Cannot list images: {exc}"})
                continue

            new_image_count_on_page = 0
            for image_info in image_list:
                xref = image_info[0]
                if xref in xref_cache:
                    cached = xref_cache[xref]
                    occurrence = dict(cached)
                    occurrence.update({
                        "page": page_num + 1,
                        "duplicate": True,
                        "duplicate_of_xref": xref,
                    })
                    images.append(occurrence)
                    continue

                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        warnings.append(f"Page {page_num + 1}: xref {xref} did not produce image data")
                        continue

                    width = int(base_image.get("width", 0) or 0)
                    height = int(base_image.get("height", 0) or 0)
                    if width < min_size or height < min_size:
                        warnings.append(
                            f"Page {page_num + 1}: skipped xref {xref} because size {width}x{height} is below min-size {min_size}"
                        )
                        continue

                    ext = str(base_image.get("ext") or "png").lower().lstrip(".")
                    new_image_count_on_page += 1
                    filename = f"page{page_num + 1:04d}_img{new_image_count_on_page:03d}.{ext}"
                    file_path = out / filename
                    file_path.write_bytes(base_image["image"])

                    item = {
                        "file": str(file_path),
                        "relative_file": filename,
                        "page": page_num + 1,
                        "width": width,
                        "height": height,
                        "format": ext,
                        "xref": xref,
                        "duplicate": False,
                    }
                    xref_cache[xref] = item
                    images.append(item)
                except Exception as exc:
                    errors.append({"page": page_num + 1, "xref": xref, "error": str(exc)})

        return {
            "pdf": str(path),
            "start_page": start_page,
            "end_page": end_page,
            "output_dir": str(out),
            "image_count": len(images),
            "unique_image_count": len(xref_cache),
            "images": images,
            "warnings": warnings,
            "errors": errors,
        }
    finally:
        doc.close()


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
        result = extract_images(
            pdf_path=args.pdf,
            start_page=args.start,
            end_page=args.end,
            output_dir=args.output,
            min_size=args.min_size,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("errors") else 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
