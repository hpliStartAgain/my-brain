#!/usr/bin/env python3
"""Download images listed in a _images.json file to a local directory.

Reads the JSON array produced by fetch_page.py (each element has "url" and
"local" keys) and downloads each image to the given output directory.
Prints a JSON report to stdout.

Usage:
    python download_images.py <images_json_path> --output <images_dir>
    python download_images.py ./notes/post/_images.json --output ./notes/post/images

Dependencies:
    pip install httpx
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


def _check_deps() -> None:
    try:
        import httpx  # noqa: F401
    except ImportError:
        print(
            json.dumps({"error": "httpx is not installed. Run: pip install httpx"}),
            flush=True,
        )
        sys.exit(1)


def download_images(images_json_path: str, output_dir: str, timeout: int = 30) -> dict:
    import httpx

    json_path = Path(images_json_path)
    if not json_path.exists():
        return {"error": f"images JSON not found: {json_path}"}

    images = json.loads(json_path.read_text(encoding="utf-8"))
    if not images:
        return {"downloaded": 0, "failed": 0, "skipped": 0, "results": []}

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        )
    }

    results = []
    downloaded = failed = skipped = 0

    with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
        for img in images:
            url = img.get("url", "")
            local = img.get("local", "")  # e.g. "images/image-001.jpg"
            alt = img.get("alt", "")

            if not url or not local:
                skipped += 1
                results.append({"url": url, "status": "skipped", "reason": "missing url or local path"})
                continue

            # Derive final filename from local path
            local_path = out / Path(local).name
            if local_path.exists():
                skipped += 1
                results.append({"url": url, "local": str(local_path), "status": "exists"})
                continue

            try:
                response = client.get(url)
                response.raise_for_status()

                # Determine correct extension from Content-Type
                ct = response.headers.get("content-type", "").split(";", 1)[0].strip()
                ext = mimetypes.guess_extension(ct) or Path(urlparse(url).path).suffix or ".jpg"
                if ext == ".jpe":
                    ext = ".jpg"
                if not re.match(r"^\.[A-Za-z0-9]{1,8}$", ext):
                    ext = ".jpg"

                # Apply the correct extension
                stem = local_path.stem
                final_path = out / f"{stem}{ext}"
                final_path.write_bytes(response.content)

                downloaded += 1
                results.append({"url": url, "local": str(final_path), "alt": alt, "status": "ok", "bytes": len(response.content)})
            except Exception as exc:
                failed += 1
                results.append({"url": url, "status": "failed", "error": str(exc)})

    return {
        "downloaded": downloaded,
        "failed": failed,
        "skipped": skipped,
        "results": results,
    }


def main() -> int:
    _check_deps()

    parser = argparse.ArgumentParser(
        description="Download images listed in a _images.json file to a local directory."
    )
    parser.add_argument("images_json", help="Path to the _images.json file from fetch_page.py")
    parser.add_argument("--output", required=True, help="Directory to save downloaded images")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout per image in seconds")
    args = parser.parse_args()

    result = download_images(args.images_json, args.output, args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("error") is None and result.get("failed", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
