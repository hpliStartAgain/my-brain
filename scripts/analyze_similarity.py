import json
import os
from collections import defaultdict

REPORT_PATH = "/Users/lihaopeng/Documents/my-brain/scratch/tags_report.json"
OUTPUT_PATH = "/Users/lihaopeng/Documents/my-brain/scratch/tag_groups.json"

def normalize_tag(tag):
    # Normalize for similarity checking:
    # 1. Lowercase
    # 2. Remove non-alphanumeric chars (spaces, hyphens, underscores, dots)
    # 3. Strip common suffixes like "语言", "技术", "框架", "库"
    # We will return a normalized key and the tag itself
    
    # 转换为小写并去掉首尾空格
    norm = tag.lower().strip()
    
    # 去除常见技术名词后缀，但要注意别误杀（比如 "C语言" -> "C", "Go语言" -> "Go"）
    suffixes = ["语言", "技术", "框架", "库", "系列", "专题"]
    for suffix in suffixes:
        if norm.endswith(suffix) and len(norm) > len(suffix):
            # 只有当去掉后缀后长度大于0才去掉
            norm = norm[:-len(suffix)]
            
    # 去除所有非字母数字字符
    norm = "".join(c for c in norm if c.isalnum())
    
    # 特殊的硬编码规则
    # 比如: "deltalake" -> "deltalake", "datalake" -> "datalake" 等
    return norm

def main():
    if not os.path.exists(REPORT_PATH):
        print(f"Error: {REPORT_PATH} not found.")
        return
        
    with open(REPORT_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    tag_counts = data["tag_counts"]
    
    # Group tags by normalized key
    groups = defaultdict(list)
    for tag in tag_counts.keys():
        norm_key = normalize_tag(tag)
        if norm_key:
            groups[norm_key].append(tag)
            
    # Filter groups that have more than 1 tag (indicating potential inconsistency)
    inconsistent_groups = {}
    for norm_key, tags in groups.items():
        if len(tags) > 1:
            # Sort tags by frequency (highest first) to propose as the standard
            sorted_tags = sorted(tags, key=lambda t: tag_counts[t], reverse=True)
            inconsistent_groups[norm_key] = {
                "standard": sorted_tags[0],
                "alternatives": sorted_tags[1:],
                "all_with_counts": {t: tag_counts[t] for t in sorted_tags}
            }
            
    # Sort groups by the sum of occurrences of all tags in the group
    sorted_groups = sorted(
        inconsistent_groups.items(),
        key=lambda x: sum(x[1]["all_with_counts"].values()),
        reverse=True
    )
    
    sorted_groups_dict = dict(sorted_groups)
    
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(sorted_groups_dict, f, ensure_ascii=False, indent=2)
        
    print(f"Found {len(sorted_groups_dict)} potential inconsistent tag groups.")
    print(f"Results written to {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
