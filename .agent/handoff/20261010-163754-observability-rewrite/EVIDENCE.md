# Evidence

> 历史结果只是证据；接手 agent 应按风险决定是否重跑。以下命令均在 `/home/hpli/personal-projects/my-brain` 执行。

## Commands

### 1. 指标 / 日志两专栏篇幅 · 格式 · 死链 · frontmatter 统计

```bash
cd /home/hpli/personal-projects/my-brain
python3 - <<'PY'
import re,os,glob
paths=set(); names={}
for root,d,fs in os.walk('content'):
    for f in fs:
        if f.endswith('.md'):
            rel=os.path.join(root,f)[len('content/'):-3]
            paths.add(rel); names.setdefault(f[:-3],[]).append(rel)
for col in ['content/可观测/指标/*.md','content/可观测/日志/*.md']:
    for f in sorted(glob.glob(col)):
        t=open(f,encoding='utf-8').read()
        cjk=len(re.findall(r'[\u4e00-\u9fff]',t)); lines=t.count('\n')+1
        dead=[x.split('|')[0].split('#')[0].strip() for x in re.findall(r'\[\[([^\]]+)\]\]',t)]
        dead=[x for x in dead if x not in paths and x not in names]
        fm=bool(re.match(r'^---\ntitle:.*\ndate:.*\ntags: \[.*\].*\naliases:',t,re.S))
        mer=t.count('```mermaid'); dr=t.count("theme': 'dracula'")
        print(os.path.basename(f), 'CJK=%d'%cjk, 'lines=%d'%lines, 'fm=%s'%fm, 'mer=%d/%d'%(dr,mer), 'dead=%d'%len(dead), 'excl=%d'%t.count('！'))
PY
```

Result:

- **指标专栏**：00 导览 1465 字 / 101 行；正文 01-09 为 12012-12843 中文字 / 500-613 行，全部达标；死链 0；frontmatter 完整；Mermaid 全 dracula。
- **日志专栏**：00 导览 1550 字 / 104 行；正文 01-08 为 12000-12262 中文字 / 503-740 行，全部达标；死链 0；frontmatter 完整；Mermaid 全 dracula；合计 96668 字。
- 明细见 `ARTIFACTS/日志专栏-验证报告.md`。

### 2. 全库死链扫描（按顶层目录）

```bash
cd /home/hpli/personal-projects/my-brain
python3 - <<'PY'
import re,os,glob
from collections import defaultdict
paths=set(); names={}
for root,d,fs in os.walk('content'):
    for f in fs:
        if f.endswith('.md'):
            rel=os.path.join(root,f)[len('content/'):-3]
            paths.add(rel); names.setdefault(f[:-3],[]).append(rel)
cnt=defaultdict(int); fw=defaultdict(int)
for f in glob.glob('content/**/*.md', recursive=True):
    t=open(f,encoding='utf-8').read()
    dead=[x.split('|')[0].split('#')[0].strip() for x in re.findall(r'\[\[([^\]]+)\]\]',t)]
    dead=[x for x in dead if x not in paths and x not in names]
    if dead:
        top=f[len('content/'):].split('/')[0]; cnt[top]+=len(dead); fw[top]+=1
for k in sorted(cnt): print(k, 'dead=%d in %d files'%(cnt[k], fw[k]))
print('TOTAL', sum(cnt.values()))
PY
```

Result:

- 全库共 **3125 处**历史死链（裸产品名，遍布各专栏，属历史债务）。
- `content/可观测/` 共 **293 处**，**全部位于未重写的 23 个文件**（00 全景导览 44、AIOps 13 篇、Profiler 5 篇、链路追踪 8 篇 + 各 00 导览）。
- **指标专栏、日志专栏、`服务网格/06`、`content/index.md` 死链均为 0。**

### 3. Git 状态

```bash
cd /home/hpli/personal-projects/my-brain
git branch --show-current      # v5-migration
git rev-parse --short HEAD     # d10afb02
git status --porcelain | wc -l # 32
```

Result:

- 分支 `v5-migration`，HEAD `d10afb02`（2026-10-10 分布式架构三专栏重写）。
- **两批全部改动未 commit、未 push**（老板未要求提交）。
- 32 个未提交路径 = 指标专栏（6 git mv + 2 新增 + 2 修改）+ 日志专栏（3 git mv + 4 新增 + 1 删除 + 2 修改）+ 记录/入链文件。

### 4. 代码围栏与 Mermaid 语法配平

```bash
cd /home/hpli/personal-projects/my-brain
python3 - <<'PY'
import re,glob,os
for f in sorted(glob.glob('content/可观测/日志/*.md')):
    t=open(f,encoding='utf-8').read()
    fences=t.count('```')
    bad=[]
    for m in re.finditer(r'```mermaid\n(.*?)```', t, re.S):
        first=[l for l in m.group(1).splitlines() if l.strip() and not l.strip().startswith('%%')]
        if not first or not re.match(r'^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram)', first[0].strip()):
            bad.append(first[:1])
    print(os.path.basename(f), 'fences=%d balanced=%s'%(fences, fences%2==0), 'bad_mermaid=%s'%bad)
PY
```

Result:

- 日志专栏 9 文件围栏全部配平；Mermaid 全部为 `graph` 类型、语法检查通过。

## Files

- `content/可观测/指标/`（10 文件）——第一批交付物，全量重写完成。
- `content/可观测/日志/`（9 文件）——第二批交付物，全量重写完成。
- `TODO.md` 顶部任务节——含完整重命名清单、两批进度勾选与"续接说明"。
- `CHANGELOG.md` 2026-10-10 分节——记录第一、二批范围、重命名、规模、验证。
- `content/index.md`——指标条目「指标与 VictoriaMetrics」、新增日志条目「日志与 Grafana Loki」。
- `.devin/skills/writing-technical-article/SKILL.md` 及其 `references/`——写作硬指标来源（写前必读）。

## External References

- 无外部系统依赖；本任务为纯本地仓库内容重写，不涉及生产写入、平台 API 或审批门。
- 素材来源为公开技术文档（Prometheus / VictoriaMetrics / Grafana Loki / Grafana Alloy / Promtail / Vector / Elasticsearch / OpenTelemetry / SkyWalking / Google SRE 等官方文档），未使用任何内部或涉密素材。
