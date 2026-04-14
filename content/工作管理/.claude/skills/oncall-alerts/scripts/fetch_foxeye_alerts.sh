#!/usr/bin/env bash
# 从 Foxeye (N9E) 获取当前活跃告警
# 遍历所有 bgid，合并结果
# 输出: JSON 数组
set -euo pipefail

##############################################################################
# 配置（直接内嵌，独立于 Go 项目使用）
##############################################################################
FOXEYE_URL="http://foxeye-server.panther.sohurdc.com/api/n9e/alert-cur-events/list"
FOXEYE_TOKEN="ff187f10-b44d-4b5d-9ac5-cd75e63b5d1e"
BGIDS=(6 412 391 388 390 393 411 410 392 394 301 395 401 398 399 400 5 416 384 419 417 418 413 414 4 403 404 402 405 397 406)
##############################################################################

TMPFILE=$(mktemp /tmp/foxeye_alerts_XXXXXX.json)
echo "[]" > "$TMPFILE"
trap "rm -f $TMPFILE" EXIT

for BGID in "${BGIDS[@]}"; do
  RESP=$(curl -s -X POST "${FOXEYE_URL}?p=1&limit=500&my_groups=false&bgid=${BGID}" \
    -H "X-User-Token: $FOXEYE_TOKEN" \
    -H "User-Agent: oncall-copilot/1.0" \
    -H "Accept: */*" 2>/dev/null || echo '{"dat":{"list":[]},"err":"request failed"}')

  python3 -c "
import sys, json
from datetime import datetime

try:
    resp = json.loads(sys.stdin.read())
except:
    sys.exit(0)

existing = json.load(open('$TMPFILE'))
for fa in resp.get('dat', {}).get('list', []):
    if fa.get('is_recovered'):
        continue
    tags_map = {}
    for t in fa.get('tags', []):
        if '=' in t:
            k, v = t.split('=', 1)
            tags_map[k] = v
    host = tags_map.get('host', fa.get('target_ident', fa.get('group_name', 'Unknown')))
    ts = fa.get('first_trigger_time', fa.get('trigger_time', 0))
    existing.append({
        'source': 'foxeye',
        'title': fa.get('rule_name', ''),
        'severity': fa.get('severity', 0),
        'host': host if host else 'Unknown',
        'host_id': fa.get('target_ident', ''),
        'service': tags_map.get('service', ''),
        'cluster': fa.get('cluster', tags_map.get('cluster', '')),
        'group_name': fa.get('group_name', ''),
        'trigger_time': datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else '',
        'trigger_time_unix': ts,
        'rule_note': fa.get('rule_note', ''),
        'trigger_value': fa.get('trigger_value', ''),
        'tags': tags_map
    })
json.dump(existing, open('$TMPFILE', 'w'), ensure_ascii=False)
" <<< "$RESP" 2>/dev/null
done

python3 -c "
import json
data = json.load(open('$TMPFILE'))
print(json.dumps(data, ensure_ascii=False, indent=2))
"
