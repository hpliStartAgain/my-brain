#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""my-brain 专栏质量全量审计：篇幅 / 灌水信号 / 格式硬指标 / 死链 / 跨篇重复。"""
import os, re, json, hashlib
from collections import defaultdict, Counter

ROOT = "content"
CJK_RE = re.compile(r'[\u4e00-\u9fff]')
def cjk(s): return len(CJK_RE.findall(s))

SKIP_DIRS = {'.obsidian', '.claude', '.claudian', '.smtcmp_json_db', '_work', '.git'}

files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for f in sorted(filenames):
        if f.endswith('.md'):
            files.append(os.path.join(dirpath, f))
files.sort()

# ---------- global indexes for wiki resolution ----------
base_map = defaultdict(list)   # lower basename (no ext) -> paths
path_set = set()               # lower relpath from content (no ext)
for p in files:
    rel = os.path.relpath(p, ROOT)
    noext = rel[:-3]
    path_set.add(noext.lower())
    base_map[os.path.basename(noext).lower()].append(rel)

# 附件索引（图片等非 md 文件，![[嵌入]] 与 [[图片]] 均按附件解析）
attach = set()
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
    for f in filenames:
        if not f.endswith('.md'):
            attach.add(f.lower())

def wiki_dead(target):
    t = target.split('\\|')[0].split('|')[0].split('#')[0].strip().lower()
    if not t: return False
    if t in attach or os.path.basename(t) in attach: return False
    if t.endswith('.md'): t = t[:-3]
    if t in base_map: return False
    if t in path_set: return False
    # suffix match (Quartz shortest path)
    if any(p.endswith('/' + t) for p in path_set): return False
    return True

BOILER = [
    ('工程价值/考量句式', re.compile(r'的一个工程(价值|考量|意义|启示|视角|实践|取舍)')),
    ('生产中需要', re.compile(r'生产中需要')),
    ('在实际生产中', re.compile(r'在实际生产中')),
    ('值得注意的是', re.compile(r'值得注意的是')),
    ('不难发现', re.compile(r'不难发现')),
    ('综上所述', re.compile(r'综上所述')),
    ('总而言之', re.compile(r'总而言之')),
    ('换句话说', re.compile(r'换句话说')),
    ('也就是说', re.compile(r'也就是说')),
    ('需要指出的是', re.compile(r'需要指出的是')),
    ('更重要的是', re.compile(r'更重要的是')),
    ('与此同时', re.compile(r'与此同时')),
    ('在这个过程中', re.compile(r'在这个过程中')),
    ('实践中我们', re.compile(r'实践中我们')),
    ('这意味着', re.compile(r'这意味着')),
]
CONCL_RE = re.compile(r'(结语|总结|小结|写在最后|本章回顾|回顾与|收尾|归纳)')
THINK_RE = re.compile(r'(思考题|延伸思考|思考与练习|动手练习|习题)')
REF_RE = re.compile(r'(参考资料|参考文献|References|延伸阅读)')
FENCE_RE = re.compile(r'^\s*(```+|~~~+)\s*(\S*)')
HEAD_RE = re.compile(r'^(#{1,6})\s+(.*)$')
ITEM_RE = re.compile(r'^\s*(?:>\s*)?(?:\d+[\.、)]|[-*])\s+')
NUM_ITEM_RE = re.compile(r'^\s*(?:>\s*)?(\d+)[\.、)]\s+')
ASCII_TBL_RE = re.compile(r'^\s*\+[-=+]{3,}\+\s*$')
BOX_RE = re.compile(r'[┌┬┐├┼┤└┴┘─│]')

para_hashes = defaultdict(list)   # cross-file duplicate paragraphs
results = []

for p in files:
    with open(p, encoding='utf-8') as fh:
        raw = fh.read()
    lines = raw.split('\n')
    n_lines = len(lines)
    # frontmatter
    fm = {}
    body_start = 0
    if lines and lines[0].strip() == '---':
        for i in range(1, min(len(lines), 60)):
            if lines[i].strip() == '---':
                fm_text = '\n'.join(lines[1:i])
                body_start = i + 1
                for key in ('title', 'date', 'tags', 'aliases', 'keywords'):
                    m = re.search(r'^%s:\s*(.*)$' % key, fm_text, re.M)
                    if m: fm[key] = m.group(1).strip()
                break
    tags = []
    if 'tags' in fm:
        t = fm['tags']
        if t.startswith('['):
            tags = [x.strip().strip('"\'') for x in t.strip('[]').split(',') if x.strip()]
        else:
            tags = [t] if t else []
    # line classification
    kind = []          # 'code' | 'mermaid' | 'prose'
    fence = None
    mermaid_blocks = []
    cur_mermaid = None
    code_cjk = 0
    for ln in lines[body_start:]:
        m = FENCE_RE.match(ln)
        if m:
            if fence is None:
                fence = m.group(1)[0]
                lang = m.group(2).lower()
                if lang == 'mermaid':
                    kind.append('mermaid'); cur_mermaid = []
                else:
                    kind.append('code')
                continue
            elif m.group(1)[0] == fence and m.group(2) == '':
                if cur_mermaid is not None:
                    mermaid_blocks.append('\n'.join(cur_mermaid)); cur_mermaid = None
                fence = None
                kind.append('code')
                continue
        if fence is not None:
            if cur_mermaid is not None:
                kind.append('mermaid'); cur_mermaid.append(ln)
            else:
                kind.append('code'); code_cjk += cjk(ln)
        else:
            kind.append('prose')
    body_lines = lines[body_start:]
    prose_lines = [l for l, k in zip(body_lines, kind) if k == 'prose']
    prose_text = '\n'.join(prose_lines)
    cjk_prose = cjk(prose_text)
    cjk_all = cjk(raw)
    # headings (prose only)
    heads = []   # (idx_in_body, level, title)
    for i, (l, k) in enumerate(zip(body_lines, kind)):
        if k != 'prose': continue
        m = HEAD_RE.match(l)
        if m: heads.append((i, len(m.group(1)), m.group(2).strip()))
    def section_range(hi):
        idx, lvl, _ = heads[hi]
        end = len(body_lines)
        for j in range(hi + 1, len(heads)):
            if heads[j][1] <= lvl:
                end = heads[j][0]; break
        return idx, end
    def range_cjk(a, b):
        return cjk('\n'.join(l for l, k in zip(body_lines[a:b], kind[a:b]) if k == 'prose'))
    # abstract
    abstract_cjk = 0
    abstract_style = None
    for i, (l, k) in enumerate(zip(body_lines, kind)):
        if k != 'prose': continue
        if '**摘要' in l:
            abstract_style = 'bold'
            j = i + 1
            buf = [l]
            while j < len(body_lines):
                lj = body_lines[j]
                if kind[j] != 'prose' or lj.strip() == '---' or HEAD_RE.match(lj): break
                buf.append(lj); j += 1
            abstract_cjk = cjk('\n'.join(buf)); break
        if re.match(r'^>\s*\[!abstract\]', l, re.I):
            abstract_style = 'callout'
            j = i; buf = []
            while j < len(body_lines) and body_lines[j].lstrip().startswith('>'):
                buf.append(body_lines[j]); j += 1
            abstract_cjk = cjk('\n'.join(buf)); break
    # conclusion ranges (merged)
    concl_ranges = []
    for hi, (idx, lvl, title) in enumerate(heads):
        if lvl >= 2 and len(title) <= 20 and CONCL_RE.search(title) and not REF_RE.search(title):
            a, b = section_range(hi)
            if concl_ranges and a <= concl_ranges[-1][1]:
                concl_ranges[-1] = (concl_ranges[-1][0], max(concl_ranges[-1][1], b))
            else:
                concl_ranges.append((a, b))
    concl_cjk = sum(range_cjk(a, b) for a, b in concl_ranges)
    concl_ratio = concl_cjk / cjk_prose if cjk_prose else 0
    # thinking blocks
    think_items = 0; think_max_sent = 0; think_cjk = 0; think_blocks = 0
    think_ranges = []
    for hi, (idx, lvl, title) in enumerate(heads):
        if lvl >= 2 and len(title) <= 12 and THINK_RE.search(title):
            think_ranges.append(section_range(hi))
    for i, (l, k) in enumerate(zip(body_lines, kind)):
        if k == 'prose' and re.match(r'^>\s*\[!(note|question|tip|info)\]\s*(思考题|延伸思考)', l):
            j = i
            while j < len(body_lines) and body_lines[j].lstrip().startswith('>'): j += 1
            think_ranges.append((i, j))
    merged = []
    for a, b in sorted(think_ranges):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    for a, b in merged:
        think_blocks += 1
        block = [l for l, k in zip(body_lines[a:b], kind[a:b]) if k == 'prose']
        think_cjk += cjk('\n'.join(block))
        items = []; cur = None
        for l in block:
            if NUM_ITEM_RE.match(l):
                if cur is not None: items.append(cur)
                cur = re.sub(r'^\s*(?:>\s*)?\d+[\.、)]\s*', '', l)
            elif cur is not None and l.strip() and not HEAD_RE.match(l):
                cur += re.sub(r'^\s*>\s?', '', l)
        if cur is not None: items.append(cur)
        think_items += len(items)
        for it in items:
            s = len([x for x in re.split(r'[。！？!?]', it) if cjk(x) > 0])
            think_max_sent = max(think_max_sent, s)
    # references
    ref_items = 0; ref_urls = 0; ref_cjk = 0
    for hi, (idx, lvl, title) in enumerate(heads):
        if REF_RE.search(title):
            a, b = section_range(hi)
            block = [l for l, k in zip(body_lines[a:b], kind[a:b]) if k == 'prose']
            txt = '\n'.join(block)
            ref_cjk += cjk(txt)
            ref_items += sum(1 for l in block if ITEM_RE.match(l))
            ref_urls += len(re.findall(r'https?://', txt))
    # boilerplate
    boiler = {name: len(rx.findall(prose_text)) for name, rx in BOILER}
    boiler_total = sum(boiler.values())
    # repeated 12-grams within file (prose, whitespace stripped)
    compact = re.sub(r'\s+', '', prose_text)
    gram_counter = Counter(compact[i:i+12] for i in range(len(compact) - 11)) if len(compact) >= 12 else Counter()
    rep_grams = [(g, c) for g, c in gram_counter.most_common(40) if c >= 5 and cjk(g) >= 8][:5]
    # paragraph duplicates
    paras = []
    buf = []
    for l, k in zip(body_lines, kind):
        if k == 'prose' and l.strip() and not HEAD_RE.match(l) and not l.strip() == '---':
            buf.append(l)
        else:
            if buf: paras.append('\n'.join(buf)); buf = []
    if buf: paras.append('\n'.join(buf))
    dup_within = 0
    seen = Counter()
    for para in paras:
        norm = re.sub(r'[\s*`>#\-\d\.、|]', '', para)
        if cjk(norm) >= 60:
            h = hashlib.md5(norm.encode()).hexdigest()
            seen[h] += 1
            para_hashes[h].append((p, para[:80]))
    dup_within = sum(c - 1 for c in seen.values() if c > 1)
    # mermaid theme
    mm_total = len(mermaid_blocks)
    mm_no_dracula = sum(1 for b in mermaid_blocks if 'dracula' not in b)
    # ascii tables / box chars
    ascii_tbl = sum(1 for l in prose_lines if ASCII_TBL_RE.match(l))
    box_tbl = sum(1 for l in prose_lines if BOX_RE.search(l))
    # callouts, wiki, exclam, bold
    callouts = sum(1 for l in prose_lines if re.match(r'^>\s*\[!', l))
    # 先剥掉行内代码：`[[as_document]]` 这类媒体指令不是 wiki 链接
    wiki_src = re.sub(r'`[^`\n]*`', '', prose_text)
    wikis = re.findall(r'(?<!!)\[\[([^\[\]]+?)\]\]', wiki_src)
    dead = [w for w in wikis if wiki_dead(w)]
    exclam = prose_text.count('！')
    bold_spans = re.findall(r'\*\*[^*\n]+\*\*', prose_text)
    bolds = len(bold_spans)
    bold_cjk = cjk(''.join(bold_spans))
    bold_ratio = bold_cjk / cjk_prose if cjk_prose else 0
    code_lines = sum(1 for k in kind if k == 'code')
    # classification
    rel = os.path.relpath(p, ROOT)
    series = os.path.dirname(rel) or '(root)'
    base = os.path.basename(p)
    is_guide = base.startswith('00') or '导览' in base or base == 'index.md'
    is_algo = rel.startswith('数据结构与算法/')
    is_trans = rel.startswith('译书/')
    flags = []
    if not is_guide and not is_trans:
        floor = 6000 if is_algo else 12000
        if cjk_all < floor:
            flags.append('篇幅不足(%d<%d)' % (cjk_all, floor))
        if not is_algo and n_lines < 500 and cjk_all >= floor:
            flags.append('行数不足(%d<500)' % n_lines)
        if cjk_all >= floor and cjk_prose < 0.6 * floor and code_cjk > 1500:
            flags.append('代码注释撑字数(prose=%d,code_cjk=%d)' % (cjk_prose, code_cjk))
    if bold_ratio > 0.15 and bolds >= 30:
        flags.append('加粗滥用(%.0f%%正文加粗,%d处)' % (bold_ratio * 100, bolds))
    if abstract_cjk > 800: flags.append('摘要灌水(%d字)' % abstract_cjk)
    if concl_ratio > 0.10 and concl_cjk > 800: flags.append('结语占比%.1f%%(%d字)' % (concl_ratio * 100, concl_cjk))
    if think_items > 20: flags.append('思考题超量(%d条)' % think_items)
    if think_max_sent > 3: flags.append('思考题单条%d句' % think_max_sent)
    if think_cjk > 2000: flags.append('思考题段落化(%d字)' % think_cjk)
    for name, c in boiler.items():
        if c >= 8: flags.append('套话[%s]x%d' % (name, c))
    if boiler_total >= 25: flags.append('套话合计%d' % boiler_total)
    if rep_grams and rep_grams[0][1] >= 8: flags.append('重复短语x%d(%s…)' % (rep_grams[0][1], rep_grams[0][0][:10]))
    if dup_within >= 2: flags.append('篇内重复段落x%d' % dup_within)
    if dead: flags.append('死链x%d' % len(dead))
    if mm_no_dracula: flags.append('mermaid非dracula x%d' % mm_no_dracula)
    if ascii_tbl or box_tbl: flags.append('ASCII/框线表(%d/%d)' % (ascii_tbl, box_tbl))
    missing = [k for k in ('title', 'date', 'tags', 'aliases') if k not in fm]
    if missing and not is_guide: flags.append('frontmatter缺%s' % ','.join(missing))
    if not is_guide and not is_trans and tags and not (3 <= len(tags) <= 5):
        flags.append('tags数%d' % len(tags))
    if exclam >= 3: flags.append('感叹号x%d' % exclam)
    results.append({
        'path': rel, 'series': series, 'guide': is_guide, 'algo': is_algo, 'trans': is_trans,
        'lines': n_lines, 'cjk_all': cjk_all, 'cjk_prose': cjk_prose, 'code_cjk': code_cjk,
        'code_line_ratio': round(code_lines / max(n_lines, 1), 3),
        'abstract_cjk': abstract_cjk, 'abstract_style': abstract_style,
        'concl_cjk': concl_cjk, 'concl_ratio': round(concl_ratio, 4),
        'think_items': think_items, 'think_max_sent': think_max_sent, 'think_cjk': think_cjk,
        'ref_items': ref_items, 'ref_urls': ref_urls, 'ref_cjk': ref_cjk,
        'boiler': boiler, 'boiler_total': boiler_total,
        'rep_grams': rep_grams, 'dup_within': dup_within,
        'mermaid': mm_total, 'mm_no_dracula': mm_no_dracula,
        'callouts': callouts, 'wiki': len(wikis), 'dead': dead,
        'ascii_tbl': ascii_tbl, 'box_tbl': box_tbl, 'exclam': exclam,
        'bolds': bolds, 'bold_ratio': round(bold_ratio, 4),
        'tags': tags, 'fm_missing': missing, 'flags': flags,
    })

# cross-file duplicate paragraphs
cross = []
for h, occ in para_hashes.items():
    ps = sorted(set(o[0] for o in occ))
    if len(ps) >= 2:
        cross.append({'files': ps, 'n': len(occ), 'sample': occ[0][1]})
cross.sort(key=lambda x: -x['n'])

with open('/tmp/audit_metrics.json', 'w', encoding='utf-8') as f:
    json.dump({'files': results, 'cross_dup': cross}, f, ensure_ascii=False, indent=1)

# ---------- summaries ----------
print('=== 系列汇总（正文篇均 CJK，不含导览/译书）===')
ser = defaultdict(list)
for r in results:
    if r['guide'] or r['trans']: continue
    ser[r['series']].append(r)
rows = []
for s, rs in ser.items():
    n = len(rs)
    avg = sum(r['cjk_all'] for r in rs) / n   # 仓库标准口径：纯 CJK 汉字（含代码注释）
    mn = min(r['cjk_all'] for r in rs)
    avg_lines = sum(r['lines'] for r in rs) / n
    floor = 6000 if rs[0]['algo'] else 12000
    below = sum(1 for r in rs if r["cjk_all"] < floor)
    flagged = sum(1 for r in rs if r['flags'])
    rows.append((avg, s, n, mn, avg_lines, below, flagged))
rows.sort()
print('%-8s %-6s %-7s %-8s %-6s %-6s %s' % ('均CJK', '篇数', '最低', '均行数', '未达标', '有flag', '系列'))
for avg, s, n, mn, al, below, fl in rows:
    print('%-8d %-6d %-7d %-8.0f %-6d %-6d %s' % (avg, n, mn, al, below, fl, s))

print()
print('=== 译书系列汇总（仅参考，不适用万字标准）===')
tser = defaultdict(list)
for r in results:
    if r['trans'] and not r['guide']: tser[r['series']].append(r)
for s, rs in sorted(tser.items()):
    n = len(rs); avg = sum(r['cjk_all'] for r in rs) / n
    fl = sum(1 for r in rs if r['flags'])
    print('%-8d 篇均 %-6d 有flag %-4d %s' % (n, avg, fl, s))

print()
print('=== 灌水信号 TOP（按严重度）===')
def show(title, pred, key, limit=40):
    print('--- %s ---' % title)
    hit = [r for r in results if pred(r)]
    hit.sort(key=key, reverse=True)
    for r in hit[:limit]:
        print('%6d  %s  | %s' % (key(r), r['path'], '; '.join(r['flags'])))
    print('(%d 篇命中)' % len(hit))
show('摘要>800字', lambda r: r['abstract_cjk'] > 800, lambda r: r['abstract_cjk'])
show('结语占比>10%', lambda r: r['concl_ratio'] > 0.10 and r['concl_cjk'] > 800, lambda r: r['concl_ratio'])
show('思考题超量/段落化', lambda r: r['think_items'] > 20 or r['think_max_sent'] > 3 or r['think_cjk'] > 2000, lambda r: r['think_cjk'])
show('套话密集', lambda r: r['boiler_total'] >= 25 or any(c >= 8 for c in r['boiler'].values()), lambda r: r['boiler_total'])
show('重复短语>=8次', lambda r: r['rep_grams'] and r['rep_grams'][0][1] >= 8, lambda r: r['rep_grams'][0][1] if r['rep_grams'] else 0)
show('篇内重复段落', lambda r: r['dup_within'] >= 2, lambda r: r['dup_within'])
show('加粗滥用(>15%正文)', lambda r: r['bold_ratio'] > 0.15 and r['bolds'] >= 30, lambda r: r['bold_ratio'])
show('代码注释撑字数', lambda r: any('代码注释撑字数' in f for f in r['flags']), lambda r: r['code_cjk'])

print()
print('=== 跨篇重复段落（>=2 文件共享同一段）===')
for c in cross[:30]:
    print('x%d  %s' % (c['n'], ' | '.join(c['files'])))
    print('     样例: %s' % c['sample'])
print('(%d 组)' % len(cross))

print()
print('=== 格式问题汇总 ===')
print('死链文件数:', sum(1 for r in results if r['dead']), ' 死链总数:', sum(len(r['dead']) for r in results))
print('mermaid非dracula文件数:', sum(1 for r in results if r['mm_no_dracula']), ' 总数:', sum(r['mm_no_dracula'] for r in results))
print('ASCII/框线表文件数:', sum(1 for r in results if r['ascii_tbl'] or r['box_tbl']))
print('frontmatter缺字段文件数:', sum(1 for r in results if r['fm_missing'] and not r['guide']))
print('总文件数:', len(results), ' 正文(非导览非译书):', sum(1 for r in results if not r['guide'] and not r['trans']))