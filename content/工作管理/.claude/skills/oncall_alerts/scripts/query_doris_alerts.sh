#!/usr/bin/env bash
# query_doris_alerts.sh — 从 Doris alert_shadow.alert_events 聚合分析历史告警
# 支持三种查询模式：
#   top20    : 指定时间窗口内，高频触发规则 Top 20（默认 7 天）
#   service  : 按 source+service 统计告警分布
#   trend    : 按天/来源统计趋势（默认 30 天）
#   current  : 查询当前未恢复（is_recovered=0）告警，按 service 分组
#
# 用法示例：
#   ./query_doris_alerts.sh top20 --days 7
#   ./query_doris_alerts.sh service --days 30
#   ./query_doris_alerts.sh trend --days 14
#   ./query_doris_alerts.sh current

set -euo pipefail

# ── 连接配置 ──────────────────────────────────────────────
DORIS_HOST="doris-fe.venus.sohurdc.com"
DORIS_PORT="9030"
DORIS_USER="hpli"
DORIS_PASS="AdJt9EQv"
DORIS_DB="alert_shadow"
DORIS_TABLE="alert_shadow.alert_events"

# ── 参数解析 ──────────────────────────────────────────────
MODE="${1:-top20}"
DAYS=7
LIMIT=20

shift 2>/dev/null || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)    DAYS="$2";  shift 2 ;;
    --limit)   LIMIT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

SINCE_TS="UNIX_TIMESTAMP(NOW()) - ${DAYS}*86400"

# ── 执行 SQL 并以 TSV 输出，再转 JSON ──────────────────────
run_query() {
  local sql="$1"
  mysql -h "$DORIS_HOST" -P "$DORIS_PORT" \
    -u "$DORIS_USER" -p"$DORIS_PASS" \
    --default-auth=mysql_native_password \
    --batch --silent \
    -e "$sql" 2>/dev/null
}

# ── 各模式 SQL ──────────────────────────────────────────────
case "$MODE" in

  top20)
    SQL="
SELECT
  source,
  IFNULL(service,'(未分类)') AS service,
  title,
  severity,
  COUNT(*) AS trigger_cnt,
  COUNT(DISTINCT host) AS host_cnt,
  ROUND(SUM(is_recovered)*100.0/COUNT(*),1) AS recover_pct
FROM $DORIS_TABLE
WHERE trigger_time >= $SINCE_TS
GROUP BY source, service, title, severity
ORDER BY trigger_cnt DESC
LIMIT $LIMIT;"
    HEADER="source\tservice\ttitle\tseverity\ttrigger_cnt\thost_cnt\trecover_pct(%)"
    ;;

  service)
    SQL="
SELECT
  source,
  IFNULL(service,'(未分类)') AS service,
  COUNT(*) AS total_events,
  COUNT(DISTINCT title) AS unique_rules,
  COUNT(DISTINCT host) AS unique_hosts,
  ROUND(SUM(is_recovered)*100.0/COUNT(*),1) AS recover_pct
FROM $DORIS_TABLE
WHERE trigger_time >= $SINCE_TS
GROUP BY source, service
ORDER BY total_events DESC;"
    HEADER="source\tservice\ttotal_events\tunique_rules\tunique_hosts\trecover_pct(%)"
    ;;

  trend)
    SQL="
SELECT
  DATE(FROM_UNIXTIME(trigger_time)) AS day,
  source,
  COUNT(*) AS events,
  COUNT(DISTINCT title) AS unique_rules
FROM $DORIS_TABLE
WHERE trigger_time >= $SINCE_TS
GROUP BY day, source
ORDER BY day DESC, events DESC;"
    HEADER="day\tsource\tevents\tunique_rules"
    ;;

  current)
    SQL="
SELECT
  source,
  IFNULL(service,'(未分类)') AS service,
  title,
  severity,
  host,
  FROM_UNIXTIME(trigger_time) AS trigger_time
FROM $DORIS_TABLE
WHERE is_recovered = 0
ORDER BY severity ASC, trigger_time DESC
LIMIT $LIMIT;"
    HEADER="source\tservice\ttitle\tseverity\thost\ttrigger_time"
    ;;

  *)
    echo '{"error": "unknown mode: '"$MODE"', use: top20|service|trend|current"}' >&2
    exit 1
    ;;
esac

# ── 输出：先打印 header，再执行查询 ──────────────────────────
echo -e "$HEADER"
run_query "$SQL"
