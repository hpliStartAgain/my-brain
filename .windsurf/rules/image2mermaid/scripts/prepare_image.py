#!/usr/bin/env python3
"""Prepare an image file for AI analysis.

Reads an image from disk and prints a JSON object to stdout containing image
metadata and optional base64 data. Large files omit base64 by default threshold
so tool output stays safe for AI agents.

Usage:
    python prepare_image.py <image_path>
    python prepare_image.py /path/to/diagram.png
    python prepare_image.py /path/to/figure.jpg --no-base64
    python prepare_image.py /path/to/large.png --max-base64-bytes 1048576

Dependencies:
    pip install pillow
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

DEFAULT_MAX_BASE64_BYTES = 5 * 1024 * 1024


def _check_deps() -> None:
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print(
            json.dumps({"error": "Pillow is not installed. Run: pip install pillow"}),
            flush=True,
        )
        sys.exit(1)


def prepare_image(
    image_path: str,
    include_base64: bool = True,
    max_base64_bytes: int = DEFAULT_MAX_BASE64_BYTES,
) -> dict:
    from PIL import Image

    path = Path(image_path).resolve()
    if not path.exists():
        return {"error": f"File not found: {path}"}
    if not path.is_file():
        return {"error": f"Not a file: {path}"}
    if max_base64_bytes < 0:
        return {"error": "--max-base64-bytes must be >= 0"}

    size_bytes = path.stat().st_size

    try:
        with Image.open(path) as img:
            width, height = img.size
            fmt = img.format or path.suffix.lstrip(".").upper()
            mode = img.mode
            mime_type = Image.MIME.get(img.format or "", "application/octet-stream")
    except Exception as exc:
        return {"error": f"Cannot open image: {exc}"}

    result: dict = {
        "path": str(path),
        "width": width,
        "height": height,
        "format": fmt,
        "mode": mode,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "base64_included": False,
        "warnings": [],
    }

    if include_base64:
        if size_bytes <= max_base64_bytes:
            raw = path.read_bytes()
            result["base64"] = base64.b64encode(raw).decode("utf-8")
            result["base64_included"] = True
        else:
            result["warnings"].append(
                f"Base64 omitted because file size {size_bytes} exceeds max-base64-bytes {max_base64_bytes}."
            )

    return result


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Prepare an image file for AI analysis and Mermaid conversion."
    )
    parser.add_argument("image", help="Path to the image file (PNG, JPEG, WebP, etc.)")
    parser.add_argument(
        "--no-base64",
        action="store_true",
        help="Omit base64 data from output (for quick metadata-only inspection)",
    )
    parser.add_argument(
        "--max-base64-bytes",
        type=int,
        default=DEFAULT_MAX_BASE64_BYTES,
        help="Maximum file size to include as base64 (default: 5242880)",
    )
    args = parser.parse_args()

    result = prepare_image(
        args.image,
        include_base64=not args.no_base64,
        max_base64_bytes=args.max_base64_bytes,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
