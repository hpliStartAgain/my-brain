import os
import re
import argparse

CONTENT_DIR = "/Users/lihaopeng/Documents/my-brain/content"
EXCLUDE_DIRS = {"工作管理", "Template", "private", "templates", ".obsidian"}

# 精细匹配映射字典，所有 Key 统一为小写，以便不区分大小写匹配
TAG_MAP = {
    # 类别一：编程语言与运行时
    "go": "Golang",
    "go语言": "Golang",
    "golang": "Golang",
    "java": "Java",
    "java语言": "Java",
    "python": "Python",
    "python语言": "Python",
    "cpp": "C++",
    "c++语言": "C++",
    
    # 类别二：云原生与容器化
    "kubernetes": "Kubernetes",
    "k8s": "Kubernetes",
    "etcd": "etcd",
    "deployment": "Deployment",
    "cgroup": "cgroups",
    "cgroups": "cgroups",
    "service-mesh": "服务网格",
    
    # 类别三：大数据与数据库
    "lsm tree": "LSM-Tree",
    "lsm-tree": "LSM-Tree",
    "lsm树": "LSM-Tree",
    "exactly-once": "Exactly-once",
    "bloom filter": "BloomFilter",
    "bloomfilter": "BloomFilter",
    "copy-on-write": "Copy-on-Write",
    "cow": "Copy-on-Write",
    "blockcache": "Block Cache",
    "block cache": "Block Cache",
    "dynamicallocation": "Dynamic Allocation",
    "dynamic allocation": "Dynamic Allocation",
    "rowbuffer": "Row Buffer",
    "row buffer": "Row Buffer",
    "skewjoin": "Skew Join",
    "skew join": "Skew Join",
    "kafkasink": "Kafka Sink",
    "kafka sink": "Kafka Sink",
    "sparkui": "Spark UI",
    "spark ui": "Spark UI",
    "direct io": "Direct I/O",
    "directio": "Direct I/O",
    "undo_log": "Undo Log",
    "undolog": "Undo Log",
    "redo_log": "Redo Log",
    "redolog": "Redo Log",
    "b+树": "B+Tree",
    "b+tree": "B+Tree",
    
    # 类别四：通用开发与架构术语
    "ci-cd": "CI/CD",
    "ci/cd": "CI/CD",
    "eino": "Eino",
    "troubleshooting": "trouble-shooting",
    "trouble-shooting": "trouble-shooting",
    "upsert": "UPSERT",
    "tcp_nodelay": "TCP_NODELAY",
    "keepalive": "KeepAlive",
    "round-robin": "RoundRobin",
    "roundrobin": "RoundRobin",

    # 类别五：剩余大小写不一致标签
    "watch": "Watch",
    "socket": "socket",        # 保持小写（Linux 技术术语）
    "bridge": "Bridge",
    "profiling": "Profiling",
    "failover": "failover",    # 保持小写（技术术语）
    "append": "Append",
    "benchmark": "Benchmark",
    "collection": "Collection",
    "merge": "MERGE",          # 与 SQL 大写命令风格统一
    "refresh": "Refresh",
    "seccomp": "Seccomp",
    "skiplist": "SkipList",
    "span": "Span",
    "string": "String",
    "trace": "Trace",
    "update": "UPDATE",        # 与 SQL 大写命令风格统一
    "watch机制": "Watch机制",
}

def process_file_content(content, dry_run=False, file_path=""):
    lines = content.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return None, None, None # 无 frontmatter
        
    # 寻找第二个 ---
    end_fm_idx = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_fm_idx = i
            break
    if end_fm_idx == -1:
        return None, None, None # frontmatter 不完整
        
    fm_lines = lines[1:end_fm_idx]
    
    # 解析 fm_lines 中的 tags 及其所在的行范围
    tags_start_idx = -1
    tags_end_idx = -1
    existing_tags = []
    
    in_tags_list = False
    for i, line in enumerate(fm_lines):
        stripped = line.strip()
        
        if in_tags_list:
            if stripped.startswith("-"):
                # 提取 "- tag" 格式
                tag = stripped[1:].strip().strip("'\"")
                if tag:
                    existing_tags.append(tag)
                tags_end_idx = i
                continue
            elif ":" in line and not stripped.startswith("-"):
                in_tags_list = False
        
        if stripped.startswith("tags:"):
            tags_start_idx = i
            tags_end_idx = i
            value = stripped[5:].strip()
            if not value:
                in_tags_list = True
                continue
            
            # inline list 格式，如 tags: [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                inner = value[1:-1].strip()
                if inner:
                    parts = re.split(r',\s*', inner)
                    for p in parts:
                        tag = p.strip().strip("'\"")
                        if tag:
                            existing_tags.append(tag)
            else:
                # 单个值格式 tags: a 或 tags: "a"
                tag = value.strip().strip("'\"")
                if tag:
                    existing_tags.append(tag)
                           
    if tags_start_idx == -1:
        return None, None, None # 没有 tags 字段
        
    # 根据 TAG_MAP 映射 tags
    new_tags = []
    seen = set()
    has_changes = False
    
    for t in existing_tags:
        norm_t = t.strip().lower()
        mapped = TAG_MAP.get(norm_t, t.strip())
        
        # 如果映射后的词和原词不同，说明有变化
        if mapped != t:
            has_changes = True
            
        if mapped and mapped not in seen:
            seen.add(mapped)
            new_tags.append(mapped)
            
    # 排序新 tags
    new_tags.sort(key=lambda x: (x.lower(), x))
    
    # 检查是否因为去重或排序导致 tags 顺序/个数变化
    if len(new_tags) != len(existing_tags) or [t.strip() for t in existing_tags] != new_tags:
        has_changes = True
        
    # 如果原本不是单行 inline list 格式（即 tags_start_idx != tags_end_idx），也是一种变化（格式规范化）
    if tags_start_idx != tags_end_idx:
        has_changes = True
        
    if not has_changes:
        return None, None, None # 没有发生任何变化
        
    # 构造新的 tags 行
    new_tags_str = ", ".join(new_tags)
    new_tags_line = f"tags: [{new_tags_str}]\n"
    
    # 替换 fm_lines 中的旧 tags 范围
    new_fm_lines = fm_lines[:tags_start_idx] + [new_tags_line] + fm_lines[tags_end_idx + 1:]
    
    # 重新组合文件内容
    new_lines = [lines[0]] + new_fm_lines + lines[end_fm_idx:]
    new_content = "".join(new_lines)
    
    return new_content, existing_tags, new_tags

def main():
    parser = argparse.ArgumentParser(description="Batch update Markdown frontmatter tags based on mapping rules.")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without modifying files.")
    parser.add_argument("--file", type=str, help="Only process a single specific file (relative path to content/).")
    args = parser.parse_args()
    
    modified_count = 0
    total_processed = 0
    
    if args.file:
        # 单文件处理模式（用于沙箱演练）
        file_path = os.path.join(CONTENT_DIR, args.file)
        if not os.path.exists(file_path):
            print(f"Error: File {file_path} does not exist.")
            return
            
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            print(f"Error reading {args.file}: {e}")
            return
            
        new_content, old_tags, new_tags = process_file_content(content, dry_run=args.dry_run, file_path=file_path)
        if new_content is not None:
            print(f"\n[MODIFIED] {args.file}")
            print(f"  Old tags: {old_tags}")
            print(f"  New tags: {new_tags}")
            if not args.dry_run:
                try:
                    with open(file_path, "w", encoding="utf-8") as f:
                        f.write(new_content)
                    print("  Status: Written to file.")
                except Exception as e:
                    print(f"  Error writing to file: {e}")
            else:
                print("  Status: Dry-run, no change made.")
        else:
            print(f"[NO CHANGE] {args.file}")
        return

    # 全量扫描模式
    for root, dirs, files in os.walk(CONTENT_DIR):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
        
        for file in files:
            if file.endswith(".md"):
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, CONTENT_DIR)
                
                # 双重排查排除路径
                path_parts = set(rel_path.split(os.sep))
                if path_parts.intersection(EXCLUDE_DIRS):
                    continue
                    
                total_processed += 1
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        content = f.read()
                except Exception as e:
                    print(f"Error reading {rel_path}: {e}")
                    continue
                    
                new_content, old_tags, new_tags = process_file_content(content, dry_run=args.dry_run, file_path=file_path)
                if new_content is not None:
                    modified_count += 1
                    if args.dry_run:
                        print(f"[DRY-RUN] {rel_path}: {old_tags} -> {new_tags}")
                    else:
                        try:
                            with open(file_path, "w", encoding="utf-8") as f:
                                f.write(new_content)
                        except Exception as e:
                            print(f"Error writing {rel_path}: {e}")
                            
    print(f"\nScan finished.")
    print(f"Total processed files: {total_processed}")
    print(f"Total files to modify / modified: {modified_count}")
    if args.dry_run:
        print("Dry-run finished. No files were modified.")

if __name__ == "__main__":
    main()
