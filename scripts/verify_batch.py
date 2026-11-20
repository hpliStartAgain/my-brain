#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单批整改验收：按 AGENTS.md §1 与 delivery-standard.md 逐篇判定 PASS/FAIL。

用法：
    python3 scripts/verify_batch.py <目录或文件...> [--algo]
    python3 scripts/verify_batch.py content/分布式架构/分布式系统原理与协议
    python3 scripts/verify_batch.py "content/x/01 a.md" "content/x/02 b.md"

--algo    算法专栏口径（字数下限 6000，不要求 500 行）
--survey  综述/选型专栏口径（字数下限 8000、行数下限 350）

体裁口径的由来见《专栏质量审计报告》「体裁例外」一节：深度专栏 12000-16000 是默认标准，
算法与综述是两类经裁定豁免的体裁。
"""
import os, re, sys

CJK = re.compile(r'[\u4e00-\u9fff]')
def cjk(s): return len(CJK.findall(s))

# 灌水/模板句式（AGENTS.md 明令禁止或风格规范排除）
BANNED = [
    '的一个工程价值', '的一个工程考量', '的一个工程细节', '的一个工程陷阱',
    '的一个工程意义', '的一个工程启示', '的一个工程视角', '的一个工程实践',
    '生产中需要', '在实际生产中',
    '这条延伸的启示是', '这条观察的通用性在于', '这个对照说明', '这条辨析的启示是',
    '这个取舍说明', '这三条启示', '这个推论说明', '这个类比说明',
    '值得注意的是', '综上所述', '总而言之', '不难发现',
]
HEAD_RE = re.compile(r'^(#{1,6})\s+(.*)$')
# 只把真正的模板前缀计入（「一个类比」「一个判断」等是正常行文，不误报）
FORMULA_HEAD = re.compile(r'一个(延伸|实践|对照|总结|反例|推论|澄清|常被)')
CONCL_RE = re.compile(r'(结语|总结|小结|写在最后|回顾与|收尾)')
REF_RE = re.compile(r'(参考资料|参考文献|延伸阅读|References)')
ASCII_TBL = re.compile(r'^\s*\+[-=+]{3,}\+\s*$')
BOX = re.compile(r'[┌┬┐├┼┤└┴┘─│]')


def check(path, algo=False, guide=False, survey=False):
    raw = open(path, encoding='utf-8').read()
    lines = raw.split('\n')
    issues, notes = [], []

    # frontmatter
    fm_ok = lines and lines[0].strip() == '---'
    fm_text = ''
    body_start = 0
    if fm_ok:
        for i in range(1, min(len(lines), 60)):
            if lines[i].strip() == '---':
                fm_text = '\n'.join(lines[1:i]); body_start = i + 1; break
    for key in ('title', 'date', 'tags', 'aliases'):
        if not re.search(r'^%s:' % key, fm_text, re.M):
            issues.append('frontmatter 缺 %s' % key)

    body_lines = lines[body_start:]
    # 围栏状态与分类
    kind, fence = [], None
    mm_blocks, cur = [], None
    for ln in body_lines:
        m = re.match(r'^\s*(```+|~~~+)\s*(\S*)', ln)
        if m:
            if fence is None:
                fence = m.group(1)[0]
                if m.group(2).lower() == 'mermaid':
                    kind.append('mm'); cur = []
                else:
                    kind.append('code')
                continue
            elif m.group(1)[0] == fence and m.group(2) == '':
                if cur is not None:
                    mm_blocks.append('\n'.join(cur)); cur = None
                fence = None; kind.append('code'); continue
        if fence is not None:
            if cur is not None:
                kind.append('mm'); cur.append(ln)
            else:
                kind.append('code')
        else:
            kind.append('prose')
    if fence is not None:
        issues.append('代码围栏未闭合')

    prose = '\n'.join(l for l, k in zip(body_lines, kind) if k == 'prose')
    cjk_all, cjk_prose = cjk(raw), cjk(prose)

    # 篇幅
    if algo:
        floor, line_floor = 6000, 0
    elif survey:
        floor, line_floor = 8000, 350
    else:
        floor, line_floor = 12000, 500
    if not guide:
        if cjk_all < floor:
            issues.append('篇幅不足 %d < %d' % (cjk_all, floor))
        if line_floor and len(lines) < line_floor:
            issues.append('行数不足 %d < %d' % (len(lines), line_floor))

    # 加粗
    bolds = re.findall(r'\*\*[^*\n]+\*\*', prose)
    bold_cjk = cjk(''.join(bolds))
    bold_ratio = bold_cjk / cjk_prose if cjk_prose else 0
    if bold_ratio > 0.05:
        issues.append('加粗超标 %.1f%%（标准约 2%%）' % (bold_ratio * 100))

    # 公式化标题
    formula = []
    for l, k in zip(body_lines, kind):
        if k != 'prose':
            continue
        m = HEAD_RE.match(l)
        if m and m.group(1) == '###' and FORMULA_HEAD.search(m.group(2)):
            formula.append(m.group(2))
    if len(formula) >= 2:
        issues.append('公式化标题 %d 个' % len(formula))

    # 禁用句式
    hits = {p: prose.count(p) for p in BANNED if prose.count(p)}
    if hits:
        issues.append('灌水句式 %s' % hits)

    # 篇内重复段落
    paras = [p for p in re.split(r'\n\s*\n', prose) if cjk(p) >= 60]
    norm = {}
    for p in paras:
        key = re.sub(r'[\s*`>#\-\d\.、|]', '', p)
        norm[key] = norm.get(key, 0) + 1
    dups = sum(v - 1 for v in norm.values() if v > 1)
    if dups:
        issues.append('篇内重复段落 %d 处' % dups)

    # 摘要
    abstract = 0
    for i, (l, k) in enumerate(zip(body_lines, kind)):
        if k != 'prose': continue
        if '**摘要' in l or re.match(r'^>\s*\[!abstract\]', l, re.I):
            j = i + 1 if '**摘要' in l else i
            buf = []
            while j < len(body_lines) and (body_lines[j].strip() == '' or body_lines[j].lstrip().startswith('>')
                                           or kind[j] == 'prose') and not HEAD_RE.match(body_lines[j]):
                if body_lines[j].strip() == '---': break
                buf.append(body_lines[j]); j += 1
            abstract = cjk('\n'.join(buf)); break
    if abstract > 800:
        issues.append('摘要灌水 %d 字' % abstract)
    elif abstract == 0:
        notes.append('未识别到摘要段')

    # 结语占比
    heads = [(i, len(m.group(1)), m.group(2)) for i, (l, k) in enumerate(zip(body_lines, kind))
             if k == 'prose' for m in [HEAD_RE.match(l)] if m]
    concl = 0
    for hi, (idx, lvl, title) in enumerate(heads):
        if lvl >= 2 and len(title) <= 20 and CONCL_RE.search(title) and not REF_RE.search(title):
            end = len(body_lines)
            for j in range(hi + 1, len(heads)):
                if heads[j][1] <= lvl:
                    end = heads[j][0]; break
            concl += cjk('\n'.join(l for l, k in zip(body_lines[idx:end], kind[idx:end]) if k == 'prose'))
    if cjk_prose and concl / cjk_prose > 0.10:
        issues.append('结语占比 %.1f%%' % (concl / cjk_prose * 100))

    # mermaid
    mm_bad = sum(1 for b in mm_blocks if 'dracula' not in b)
    if mm_bad:
        issues.append('Mermaid 非 dracula %d 张' % mm_bad)
    if not mm_blocks and not guide and not algo:
        notes.append('无 Mermaid 图')

    # 表格/感叹号
    at = sum(1 for l in prose.split('\n') if ASCII_TBL.match(l))
    bt = sum(1 for l in prose.split('\n') if BOX.search(l))
    if at or bt:
        issues.append('ASCII/框线表 %d/%d' % (at, bt))
    ex = prose.count('！')
    if ex:
        issues.append('全角感叹号 %d' % ex)

    return dict(path=path, cjk=cjk_all, lines=len(lines), bold=len(bolds),
                bold_ratio=bold_ratio, formula=len(formula), abstract=abstract,
                concl_ratio=(concl / cjk_prose if cjk_prose else 0),
                mermaid=len(mm_blocks), issues=issues, notes=notes)


def main(argv):
    algo = '--algo' in argv
    survey = '--survey' in argv
    args = [a for a in argv if not a.startswith('--')]
    files = []
    for a in args:
        if os.path.isdir(a):
            files += [os.path.join(a, f) for f in sorted(os.listdir(a)) if f.endswith('.md')]
        else:
            files.append(a)
    if not files:
        print(__doc__); return 2

    fails = 0
    print('%-52s %6s %5s %6s %6s %5s %4s  %s' % ('文件', 'CJK', '行', '加粗%', '加粗处', '公式', '图', '判定'))
    for f in files:
        guide = os.path.basename(f).startswith('00') or '导览' in os.path.basename(f)
        r = check(f, algo=algo, guide=guide, survey=survey)
        ok = not r['issues']
        if not ok: fails += 1
        print('%-52s %6d %5d %5.1f%% %6d %5d %4d  %s' % (
            os.path.basename(f)[:52], r['cjk'], r['lines'], r['bold_ratio'] * 100,
            r['bold'], r['formula'], r['mermaid'], 'PASS' if ok else 'FAIL'))
        for i in r['issues']:
            print('      × %s' % i)
        for n in r['notes']:
            print('      · %s' % n)
    print('\n汇总：%d 篇，PASS %d，FAIL %d' % (len(files), len(files) - fails, fails))
    return 0 if fails == 0 else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))