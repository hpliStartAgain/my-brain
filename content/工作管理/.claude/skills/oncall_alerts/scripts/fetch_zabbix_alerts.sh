#!/usr/bin/env bash
# 从 Zabbix 获取当前活跃告警（trigger.get, value=1, status=0）
# 输出: JSON 数组，每个元素包含 source, title, severity, host, trigger_time 等字段
set -euo pipefail

##############################################################################
# 配置（直接内嵌，独立于 Go 项目使用）
##############################################################################
ZABBIX_URL="https://zabbix.panther.sohurdc.com//api_jsonrpc.php"
ZABBIX_TOKEN="87331c6e7d7129a57006516eb022d382e3f5f96058bbd99d471403f302a0a27e"
ZABBIX_LIMIT=1000
##############################################################################

# 调用 Zabbix JSON-RPC API
RESPONSE=$(curl -s -X POST "$ZABBIX_URL" \
  -H "Content-Type: application/json-rpc" \
  -H "Authorization: Bearer $ZABBIX_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "method": "trigger.get",
    "params": {
      "output": ["triggerid", "description", "priority", "lastchange"],
      "selectHosts": ["name", "hostid"],
      "selectTags": "extend",
      "filter": { "value": 1, "status": 0 },
      "monitored": true,
      "skipDependent": true,
      "sortfield": "priority",
      "sortorder": "DESC",
      "limit": '"$ZABBIX_LIMIT"'
    },
    "id": 1
  }' 2>/dev/null)

# 检查是否有错误并转换为规范化格式
echo "$RESPONSE" | python3 -c "
import sys, json
from datetime import datetime

data = json.load(sys.stdin)
if 'error' in data:
    print(json.dumps({'error': data['error']}, ensure_ascii=False), file=sys.stderr)
    sys.exit(1)

alerts = []
for t in data.get('result', []):
    host = t['hosts'][0]['name'] if t.get('hosts') else 'Unknown'
    host_id = t['hosts'][0]['hostid'] if t.get('hosts') else ''
    tags = {tag['tag']: tag['value'] for tag in t.get('tags', [])}
    service = tags.get('service', tags.get('Service', ''))
    ts = int(t.get('lastchange', 0))
    alerts.append({
        'source': 'zabbix',
        'title': t.get('description', ''),
        'severity': int(t.get('priority', 0)),
        'host': host,
        'host_id': host_id,
        'service': service,
        'trigger_time': datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else '',
        'trigger_time_unix': ts,
        'tags': tags
    })
print(json.dumps(alerts, ensure_ascii=False, indent=2))
"
