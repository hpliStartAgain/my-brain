#!/usr/bin/env bash
# 一键获取三个平台的所有当前活跃告警
# 并行调用 Zabbix、Foxeye、Ambari 脚本，合并 JSON 输出
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 临时文件存储各平台结果
ZABBIX_TMP=$(mktemp /tmp/zabbix_XXXXXX.json)
FOXEYE_TMP=$(mktemp /tmp/foxeye_XXXXXX.json)
AMBARI_TMP=$(mktemp /tmp/ambari_XXXXXX.json)

cleanup() {
  rm -f "$ZABBIX_TMP" "$FOXEYE_TMP" "$AMBARI_TMP"
}
trap cleanup EXIT

# 并行执行三个采集脚本
bash "$SCRIPT_DIR/fetch_zabbix_alerts.sh" > "$ZABBIX_TMP" 2>/dev/null &
PID_Z=$!
bash "$SCRIPT_DIR/fetch_foxeye_alerts.sh" > "$FOXEYE_TMP" 2>/dev/null &
PID_F=$!
bash "$SCRIPT_DIR/fetch_ambari_alerts.sh" > "$AMBARI_TMP" 2>/dev/null &
PID_A=$!

# 等待所有完成
wait $PID_Z 2>/dev/null || echo "[]" > "$ZABBIX_TMP"
wait $PID_F 2>/dev/null || echo "[]" > "$FOXEYE_TMP"
wait $PID_A 2>/dev/null || echo "[]" > "$AMBARI_TMP"

# 合并三个 JSON 数组
python3 -c "
import json, sys

def safe_load(path):
    try:
        with open(path) as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except:
        return []

zabbix = safe_load('$ZABBIX_TMP')
foxeye = safe_load('$FOXEYE_TMP')
ambari = safe_load('$AMBARI_TMP')

result = {
    'summary': {
        'zabbix_count': len(zabbix),
        'foxeye_count': len(foxeye),
        'ambari_count': len(ambari),
        'total_count': len(zabbix) + len(foxeye) + len(ambari)
    },
    'alerts': zabbix + foxeye + ambari
}

print(json.dumps(result, ensure_ascii=False, indent=2))
"
