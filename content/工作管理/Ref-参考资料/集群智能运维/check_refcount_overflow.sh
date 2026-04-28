#!/bin/bash
# 检查内核 refcount_t overflow 事件
# 用途：快速评估 RHEL 8.6 已知 bug (BZ#2221010) 风险
# 用法：bash check_refcount_overflow.sh
# 风险：纯只读，不修改任何系统文件

set -euo pipefail

KERNEL=$(uname -r)
HOST=$(hostname)

echo "=========================================="
echo "  内核 refcount_t overflow 快速检查"
echo "=========================================="
echo "主机: $HOST"
echo "内核: $KERNEL"
echo ""

# ---- 1. 当前启动周期（dmesg，最快） ----
DMESG_COUNT=$(dmesg 2>/dev/null | grep -c "refcount_t overflow" || true)
DMESG_FIRST=$(dmesg 2>/dev/null | grep "refcount_t overflow" | head -1 || true)

echo "--- 当前启动周期 (dmesg) ---"
if [ "$DMESG_COUNT" -gt 0 ]; then
    echo "出现次数: $DMESG_COUNT"
    echo "首次出现: $DMESG_FIRST"
else
    echo "无 refcount_t overflow 记录"
fi

# ---- 2. 提取首次出现时间（dmesg 时间戳转人类可读） ----
if [ "$DMESG_COUNT" -gt 0 ]; then
    FIRST_SEC=$(dmesg 2>/dev/null | grep "refcount_t overflow" | head -1 | grep -oP '^\[\s*\K[0-9]+')
    if [ -n "$FIRST_SEC" ]; then
        BOOT_TIME=$(cat /proc/stat 2>/dev/null | grep btime | awk '{print $2}')
        if [ -n "$BOOT_TIME" ]; then
            FIRST_EPOCH=$((BOOT_TIME + FIRST_SEC))
            FIRST_TIME=$(date -d "@$FIRST_EPOCH" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "无法转换")
            echo "首次出现时间: $FIRST_TIME"
            NOW_EPOCH=$(date +%s)
            DAYS_AGO=$(( (NOW_EPOCH - FIRST_EPOCH) / 86400 ))
            echo "距今约: ${DAYS_AGO} 天"
        fi
    fi
fi
echo ""

# ---- 3. 历史记录（journalctl -k，持久化） ----
echo "--- 历史记录 (journalctl -k) ---"
if command -v journalctl &>/dev/null; then
    JOURNAL_COUNT=$(journalctl -k --no-pager 2>/dev/null | grep -c "refcount_t overflow" || true)
    if [ "$JOURNAL_COUNT" -gt 0 ]; then
        echo "历史出现次数: $JOURNAL_COUNT"
        FIRST_JOURNAL=$(journalctl -k --no-pager -o short-iso 2>/dev/null | grep "refcount_t overflow" | head -1 || true)
        echo "首次记录: $FIRST_JOURNAL"
    else
        echo "无历史记录"
    fi
else
    echo "journalctl 不可用"
fi
echo ""

# ---- 4. 涉及函数统计 ----
echo "--- 涉及函数分布 ---"
if [ "$DMESG_COUNT" -gt 0 ]; then
    dmesg 2>/dev/null | grep "refcount_t overflow" | grep -oP 'at \S+' | sort | uniq -c | sort -rn
elif command -v journalctl &>/dev/null; then
    journalctl -k --no-pager 2>/dev/null | grep "refcount_t overflow" | grep -oP 'at \S+' | sort | uniq -c | sort -rn || echo "无"
fi
echo ""

# ---- 5. 风险判定 ----
echo "=========================================="
echo "  风险判定"
echo "=========================================="

TOTAL=$((DMESG_COUNT > JOURNAL_COUNT ? DMESG_COUNT : JOURNAL_COUNT))

if [ "$TOTAL" -eq 0 ]; then
    echo "✅ 未检测到 refcount_t overflow，暂无此风险"
elif [ "$TOTAL" -lt 5 ]; then
    echo "⚠️ 检测到 $TOTAL 次 refcount 溢出，建议关注"
    echo "   建议：纳入下次维护窗口升级内核"
elif [ "$TOTAL" -lt 50 ]; then
    echo "🔶 检测到 $TOTAL 次 refcount 溢出，风险较高"
    echo "   建议：近期安排内核升级到 4.18.0-477+"
else
    echo "🔴 检测到 $TOTAL 次 refcount 溢出，风险极高！"
    echo "   建议：立即安排内核升级到 4.18.0-477+"
    echo "   参考：RHSA-2023:5244 / BZ#2221010"
fi

# 版本判定
if [[ "$KERNEL" < "4.18.0-477" ]]; then
    echo "   ⚠️ 当前内核 $KERNEL 在受影响范围内"
else
    echo "   ✅ 当前内核 $KERNEL 已包含修复"
fi

echo ""
echo "参考链接:"
echo "  https://access.redhat.com/errata/RHSA-2023:5244"
echo "  https://bugzilla.redhat.com/show_bug.cgi?id=2221010"
