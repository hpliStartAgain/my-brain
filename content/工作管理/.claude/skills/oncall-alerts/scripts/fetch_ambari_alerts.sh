#!/usr/bin/env bash
# 从多套 Ambari 集群获取当前 WARNING/CRITICAL 状态告警
# 跳过 UNKNOWN 状态和维护模式的告警
# 输出: JSON 数组
set -euo pipefail

##############################################################################
# 配置（直接内嵌，独立于 Go 项目使用）
# 格式: "集群名|URL|用户名|密码"
##############################################################################
CLUSTERS=(
  "rt|http://rtrm1.venus.sohurdc.com:8080|admin|ambariadmin"
  "hadoop3|http://dmc014011.venus.sohurdc.com:8080|admin|ambariadmin"
  "ec|http://dnn130160.venus.sohurdc.com:8080|admin|ambariadmin"
)
##############################################################################

python3 -c "
import json, sys, urllib.request, base64
from datetime import datetime

clusters = [
$(for c in "${CLUSTERS[@]}"; do
  IFS='|' read -r name url user pwd <<< "$c"
  echo "    {'name': '$name', 'url': '$url', 'username': '$user', 'password': '$pwd'},"
done)
]

all_alerts = []
for cluster in clusters:
    name = cluster['name']
    url = cluster['url'].rstrip('/')
    username = cluster['username']
    password = cluster['password']

    api_url = f'{url}/api/v1/clusters/{name}/alerts?Alert/state.in(WARNING,CRITICAL,UNKNOWN)&Alert/maintenance_state=OFF&fields=Alert/service_name,Alert/host_name,Alert/state,Alert/text,Alert/latest_timestamp,Alert/definition_name,Alert/definition_id'

    try:
        req = urllib.request.Request(api_url)
        credentials = base64.b64encode(f'{username}:{password}'.encode()).decode()
        req.add_header('Authorization', f'Basic {credentials}')
        req.add_header('X-Requested-By', 'ambari')

        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())

        for item in data.get('items', []):
            a = item.get('Alert', {})
            state = a.get('state', '').upper()
            if state == 'UNKNOWN':
                continue

            ts = a.get('latest_timestamp', 0)
            if ts > 1e12:
                ts = ts // 1000

            severity_map = {'CRITICAL': 5, 'WARNING': 2}
            host = a.get('host_name', 'N/A')

            all_alerts.append({
                'source': 'ambari',
                'title': a.get('definition_name', ''),
                'severity': severity_map.get(state, 0),
                'host': host if host else 'N/A',
                'host_id': host if host else '',
                'service': a.get('service_name', ''),
                'cluster': a.get('cluster_name', name),
                'trigger_time': datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S') if ts else '',
                'trigger_time_unix': ts,
                'description': a.get('text', ''),
                'state': state,
                'tags': {
                    'definition_id': str(a.get('definition_id', '')),
                    'service_name': a.get('service_name', ''),
                    'state': state
                }
            })
    except Exception as e:
        sys.stderr.write(f'Warning: Failed to collect from Ambari cluster {name}: {e}\n')
        continue

print(json.dumps(all_alerts, ensure_ascii=False, indent=2))
"
