#!/bin/bash
# 批量检查集群所有主节点的 refcount_t overflow 风险
# 用法：在中控机上直接执行 bash batch_check_refcount.sh
set -euo pipefail

START=12; END=30; PREFIX="10.18.14"; BASELINE="4.18.0-477"
TMPFILE=$(mktemp)

echo "========================================================================"
echo "  集群内核 refcount_t overflow 批量检查"
echo "  目标: ${PREFIX}.${START}-${END} + 中控机 ${PREFIX}.11"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================================================"
echo ""

# 远程执行的单行命令（所有变量用 \$ 转义，管道清空白避免换行干扰）
REMOTE_CMD='H=$(hostname); K=$(uname -r); C=$(dmesg 2>/dev/null|grep -c "refcount_t overflow"|tr -d "\n\r "); C=${C:-0}; if [ "$C" -gt 0 ]; then S=$(dmesg 2>/dev/null|grep "refcount_t overflow"|head -1|grep -oP "^\[\s*\K[0-9]+"|tr -d "\n\r "); BT=$(awk "/btime/{print \$2}" /proc/stat); F=$(date -d "@$((BT+S))" "+%Y-%m-%d" 2>/dev/null||echo "N/A"); else F="-"; fi; if [ "$C" -ge 50 ]; then R="CRIT"; elif [ "$C" -ge 5 ]; then R="HIGH"; elif [ "$C" -ge 1 ]; then R="LOW"; else R="OK"; fi; CR=$(ls /var/crash/*/vmcore 2>/dev/null|wc -l|tr -d "\n\r "); CR=${CR:-0}; if [[ "$K" < "'"$BASELINE"'" ]]; then V="OLD"; else V="OK"; fi; echo "$H|$K|$V|$C|$F|$CR|$R"'

printf "%-22s %-39s %3s %5s %10s %5s %4s\n" "HOST" "KERNEL" "VER" "COUNT" "FIRST_SEEN" "CRASH" "RISK"
printf "%.s-" {1..120}; echo ""

# 检查单台并输出一行
check_one() {
    local target="$1"
    if [ "$target" = "local" ]; then
        bash -c "$REMOTE_CMD"
    else
        ssh -o ConnectTimeout=5 -o BatchMode=yes -o StrictHostKeyChecking=no \
            "$target" "bash -c '$REMOTE_CMD'" 2>/dev/null || echo "UNREACHABLE|N/A|ERR|0|-|0|ERR"
    fi
}

# 中控机
check_one "local" | while IFS='|' read h k v c f cr r; do
    printf "%-22s %-39s %3s %5s %10s %5s %4s\n" "$h" "$k" "$v" "$c" "$f" "$cr" "$r"
    echo "$h|$k|$v|$c|$f|$cr|$r" >> "$TMPFILE"
done

# 批量 SSH
for i in $(seq $START $END); do
    check_one "${PREFIX}.${i}" | while IFS='|' read h k v c f cr r; do
        printf "%-22s %-39s %3s %5s %10s %5s %4s\n" "$h" "$k" "$v" "$c" "$f" "$cr" "$r"
        echo "$h|$k|$v|$c|$f|$cr|$r" >> "$TMPFILE"
    done
done

echo ""

# 汇总
echo "--- 汇总 ---"
echo "CRIT (>=50): $(grep -c '|CRIT$' "$TMPFILE" 2>/dev/null || echo 0) 台"
echo "HIGH (5-49): $(grep -c '|HIGH$' "$TMPFILE" 2>/dev/null || echo 0) 台"
echo "LOW  (1-4) : $(grep -c '|LOW$' "$TMPFILE" 2>/dev/null || echo 0) 台"
echo "OK   (0)   : $(grep -c '|OK$' "$TMPFILE" 2>/dev/null || echo 0) 台"
echo "不可达     : $(grep -c 'UNREACHABLE' "$TMPFILE" 2>/dev/null || echo 0) 台"
echo "内核<基线  : $(grep -c '|OLD|' "$TMPFILE" 2>/dev/null || echo 0) 台"
grep '|OLD|' "$TMPFILE" 2>/dev/null | awk -F'|' '{print "  - " $1 " (" $2 ")"}' || true

rm -f "$TMPFILE"
