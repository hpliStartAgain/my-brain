import os
import re
import json
from collections import defaultdict

CONTENT_DIR = "/Users/lihaopeng/Documents/my-brain/content"
EXCLUDE_DIRS = {"工作管理", "Template", "private", "templates", ".obsidian"}

def parse_frontmatter_tags(file_path):
    tags = []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return tags

    # Find frontmatter
    frontmatter_lines = []
    in_frontmatter = False
    for line in lines:
        if line.strip() == "---":
            if not in_frontmatter:
                in_frontmatter = True
                continue
            else:
                break
        if in_frontmatter:
            frontmatter_lines.append(line)

    if not frontmatter_lines:
        return tags

    # Parse tags from frontmatter lines
    # We can handle standard formats:
    # 1. tags: [a, b, c]
    # 2. tags:
    #      - a
    #      - b
    # 3. tags: a
    
    in_tags_list = False
    for i, line in enumerate(frontmatter_lines):
        stripped = line.strip()
        
        # Check if we are inside a multi-line tags list
        if in_tags_list:
            if stripped.startswith("-"):
                # Extract tag from "- tag" or "- 'tag'" or "- \"tag\""
                tag = stripped[1:].strip().strip("'\"")
                if tag:
                    tags.append(tag)
                continue
            elif ":" in line and not stripped.startswith("-"):
                # We hit another key-value pair, exit tags list
                in_tags_list = False
        
        if stripped.startswith("tags:"):
            value = stripped[5:].strip()
            if not value:
                # Multi-line format
                in_tags_list = True
                continue
            
            # Check if it's inline list format like [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1].strip()
                if inner:
                    # Split by comma, handling potential quotes
                    # Simple split by comma is usually fine for tags, but let's be careful
                    parts = re.split(r',\s*', inner)
                    for p in parts:
                        tag = p.strip().strip("'\"")
                        if tag:
                            tags.append(tag)
            else:
                # Single tag format, e.g. tags: a or tags: "a"
                tag = value.strip().strip("'\"")
                if tag:
                    tags.append(tag)
                    
    return tags

def main():
    all_files_tags = {}
    tag_counts = defaultdict(int)
    
    for root, dirs, files in os.walk(CONTENT_DIR):
        # Filter out excluded directories
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
        
        for file in files:
            if file.endswith(".md"):
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, CONTENT_DIR)
                
                # Check if the path contains any excluded directory in its parts
                path_parts = set(rel_path.split(os.sep))
                if path_parts.intersection(EXCLUDE_DIRS):
                    continue
                
                tags = parse_frontmatter_tags(file_path)
                if tags:
                    all_files_tags[rel_path] = tags
                    for tag in tags:
                        tag_counts[tag] += 1

    # Sort tag counts
    sorted_tag_counts = dict(sorted(tag_counts.items(), key=lambda x: (-x[1], x[0])))
    
    result = {
        "tag_counts": sorted_tag_counts,
        "files_tags": all_files_tags
    }
    
    output_path = "/Users/lihaopeng/Documents/my-brain/scratch/tags_report.json"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        
    print(f"Collected {len(all_files_tags)} files, found {len(sorted_tag_counts)} unique tags.")
    print(f"Report written to {output_path}")

if __name__ == "__main__":
    main()
