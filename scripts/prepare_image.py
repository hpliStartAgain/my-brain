#!/usr/bin/env python3
"""Prepare an image file for AI analysis.

Reads an image from disk and prints a JSON object to stdout containing
the image dimensions, format, file size, and base64-encoded data.
The AI agent can then view the image and decide whether it is
representable as a Mermaid diagram.

Usage:
    python prepare_image.py <image_path>
    python prepare_image.py /path/to/diagram.png
    python prepare_image.py /path/to/figure.jpg --no-base64

Output (stdout, JSON):
    {
        "path": "/abs/path/to/image.png",
        "width": 800,
        "height": 600,
        "format": "PNG",
        "mode": "RGB",
        "size_bytes": 123456
    }

With base64 (default):
    {
        "path": "...",
        "width": 800,
        "height": 600,
        "format": "PNG",
        "mode": "RGB",
        "size_bytes": 123456,
        "base64": "<data>"
    }

Dependencies:
    pip install pillow
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path


def _check_deps() -> None:
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print(
            json.dumps({"error": "Pillow is not installed. Run: pip install pillow"}),
            flush=True,
        )
        sys.exit(1)


def prepare_image(image_path: str, include_base64: bool = True) -> dict:
    from PIL import Image

    path = Path(image_path).resolve()
    if not path.exists():
        return {"error": f"File not found: {path}"}

    size_bytes = path.stat().st_size

    try:
        with Image.open(path) as img:
            width, height = img.size
            fmt = img.format or path.suffix.lstrip(".").upper()
            mode = img.mode
    except Exception as exc:
        return {"error": f"Cannot open image: {exc}"}

    result: dict = {
        "path": str(path),
        "width": width,
        "height": height,
        "format": fmt,
        "mode": mode,
        "size_bytes": size_bytes,
    }

    if include_base64:
        raw = path.read_bytes()
        result["base64"] = base64.b64encode(raw).decode("utf-8")

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
    args = parser.parse_args()

    result = prepare_image(args.image, include_base64=not args.no_base64)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
