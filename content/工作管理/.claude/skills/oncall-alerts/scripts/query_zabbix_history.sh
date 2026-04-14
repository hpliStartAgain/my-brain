#!/usr/bin/env bash
# 查询 Zabbix 历史告警事件
# 使用 event.get 接口按时间范围查询
# 用法: ./query_zabbix_history.sh --start <unix_timestamp> --end <unix_timestamp>
set -euo pipefail

##############################################################################
# 配置（直接内嵌，独立于 Go 项目使用）
##############################################################################
ZABBIX_URL="https://zabbix.panther.sohurdc.com//api_jsonrpc.php"
ZABBIX_TOKEN="87331c6e7d7129a57006516eb022d382e3f5f96058bbd99d471403f302a0a27e"
##############################################################################

# 解析参数
START_TS=""
END_TS=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --start) START_TS="$2"; shift 2 ;;
    --end) END_TS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$START_TS" || -z "$END_TS" ]]; then
  echo '{"error":"Usage: query_zabbix_history.sh --start <unix_ts> --end <unix_ts>"}' >&2
  exit 1
fi

# 调用 Zabbix event.get API
RESPONSE=$(curl -s -X POST "$ZABBIX_URL" \
  -H "Content-Type: application/json-rpc" \
  -H "Authorization: Bearer $ZABBIX_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "method": "event.get",
    "params": {
      "output": ["eventid", "clock", "name", "severity", "acknowledged", "value"],
      "selectHosts": ["name", "hostid"],
      "selectTags": "extend",
      "time_from": "'"$START_TS"'",
      "time_till": "'"$END_TS"'",
      "value": 1,
      "sortfield": ["clock"],
      "sortorder": "DESC",
      "limit": 1000
    },
    "id": 1
  }' 2>/dev/null)

# 转换为规范化格式
echo "$RESPONSE" | python3 -c "
import sys, json
from datetime import datetime

data = json.load(sys.stdin)
if 'error' in data:
    print(json.dumps({'error': data['error']}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)

alerts = []
for evt in data.get('result', []):
    host = evt['hosts'][0]['name'] if evt.get('hosts') else 'Unknown'
    host_id = evt['hosts'][0]['hostid'] if evt.get('hosts') else ''
    tags = {tag['tag']: tag['value'] for tag in evt.get('tags', [])}
    service = tags.get('service', tags.get('Service', ''))
    ts = int(evt.get('clock', 0))
    alerts.append({
        'source': 'zabbix',
        'title': evt.get('name', ''),
        'severity': int(evt.get('severity', 0)),
        'host': host,
        'host_id': host_id,
        'service': service,
        'trigger_time': datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else '',
        'trigger_time_unix': ts,
        'acknowledged': bool(int(evt.get('acknowledged', 0))),
        'event_id': evt.get('eventid', ''),
        'tags': tags
    })
print(json.dumps(alerts, ensure_ascii=False, indent=2))
"
