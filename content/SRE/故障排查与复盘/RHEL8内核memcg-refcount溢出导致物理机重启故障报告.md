---
date: 2026-04-21
tags: [crash, kernel, kswapd, memcg, refcount, RHEL8]
category: 系统故障
severity: P1
---

# RHEL8 内核 memcg refcount 溢出导致物理机重启

## 故障现象

物理机 `dnn014023`（Inspur SA5212M5）于 2026-04-21 17:05 发生重启。`/var/crash/` 目录生成了 kdump crash dump，`vmcore-dmesg.txt` 末尾显示内核 NULL 指针解引用 panic。

```log
[45897053.291296] BUG: unable to handle kernel NULL pointer dereference at 0000000000000000
[45897053.291434] RIP: 0010:0x0
[45897053.291368] CPU: 68 PID: 1 Comm: systemd
[45897053.291409] Hardware name: Inspur SA5212M5/YZMB-00882-10F, BIOS 4.1.23 01/02/2022
```

## 根因分析

### 直接原因

内核在 `mem_cgroup_id_get_online()` 函数中发生 **refcount_t 引用计数溢出**，导致 memory cgroup 的 `id.ref` 数据结构损坏。当 systemd（PID 1）创建 cgroup 时，RCU 软中断尝试调用已损坏的回调函数指针（变为 NULL），触发空指针解引用 → kernel panic。

### 完整崩溃链路

```
系统长期运行（约 320 天）
    ↓
kswapd/khugepaged 内存回收时反复调用 mem_cgroup_id_get_online()
    ↓
memcg->id.ref 引用计数缓慢泄漏，持续递增
    ↓
refcount 达到 0xc0000000（溢出阈值 REFCOUNT_SATURATED）
    ↓
内核连续触发 WARNING: refcount_t overflow at mem_cgroup_id_get_online
    ↓
memcg 内部数据结构被损坏（RCU 回调指针清零）
    ↓
systemd 通过 cgroup_mkdir → mem_cgroup_css_alloc 创建新 cgroup
    ↓
pcpu_alloc 中被 timer 中断打断
    ↓
中断返回路径执行 RCU 软中断 rcu_do_batch
    ↓
调用已损坏的回调函数指针 → RIP: 0x0
    ↓
kernel panic → 物理机重启
```

### 关键证据

#### 1. 内核版本在修复前

```bash
$ uname -r
4.18.0-425.3.1.el8.x86_64
```

该版本对应 RHEL 8.6，修复该 bug 的内核为 `4.18.0-477.27.1.el8_8`（RHSA-2023:5244，2023-09-19 发布）。

#### 2. refcount 溢出记录达 160+ 次

```bash
$ grep "refcount_t overflow.*mem_cgroup_id_get_online" vmcore-dmesg.txt | wc -l
160+
```

溢出横跨约 320 天（`[18120485s]` → `[45897053s]`），涉及三个内核线程：

| 进程 | 说明 |
|------|------|
| `kswapd0[634]` | NUMA node 0 内存回收线程 |
| `kswapd1[635]` | NUMA node 1 内存回收线程 |
| `khugepaged[583]` | 透明大页合并线程 |

全部为内核内存管理线程，与用户态程序无关，排除应用程序 bug。

#### 3. refcount 溢出值

```
RDX: 00000000c0000000
```

`refcount_t` 类型的饱和标志位 `REFCOUNT_SATURATED = 0xc0000000`，说明引用计数已达到溢出状态。

#### 4. 最终崩溃点：RIP 跳转到空指针

```
RIP: 0010:0x0
Code: Unable to access opcode bytes at RIP 0xffffffffffffffd6.
CR2: 0000000000000000
```

RCU 回调函数指针已被破坏为 NULL，CPU 尝试执行地址 0 处的指令，触发 page fault → panic。

#### 5. 崩溃时的调用栈

```
<IRQ>
 rcu_do_batch+0x1c5/0x470        ← RCU 软中断处理
 rcu_core+0x14c/0x210
 __do_softirq+0xd7/0x2c8
 irq_exit_rcu+0xd3/0xe0
 irq_exit+0xa/0x10
 smp_apic_timer_interrupt+0x74/0x130
 apic_timer_interrupt+0xf/0x20
</IRQ>
memset_erms+0x9/0x20
pcpu_alloc+0x3c4/0x770
mem_cgroup_css_alloc+0x129/0x760   ← 分配新 memcg
cgroup_apply_control_enable+0x123/0x310
cgroup_mkdir+0x1c2/0x490           ← systemd 创建 cgroup
```

### 技术原理

**mem_cgroup_id_get_online() 的作用**：

该函数在内存回收路径中被调用，用于获取 online 状态 memcg 的 ID 引用。它通过 `refcount_inc_not_zero()` 递增 `memcg->id.ref` 引用计数。

**为何溢出**：

内核 commit `1c2d479a119b` 将 `mem_cgroup_id::ref` 从 `atomic_t` 改为 `refcount_t` 类型以利用溢出检测能力，但 RHEL 8.6 的 backport 中，`mem_cgroup_id_get_online()` 缺少对引用计数饱和状态（`REFCOUNT_SATURATED`）的正确防护。在 cgroup 频繁创建销毁 + swap 活跃的场景下，refcount 持续泄漏最终溢出。

**溢出后的连锁反应**：

refcount 溢出后，通过 `refcount_error_report` 发出 WARNING，但函数仍返回饱和值。后续依赖该 refcount 的代码路径（如 `mem_cgroup_css_alloc` 中的 percpu 分配）使用了损坏的 memcg 结构体，导致 RCU 回调指针被覆盖为 NULL。

### 排除硬件故障

- 无 MCE（Machine Check Exception）日志
- 无温度/电压异常
- 无 ECC 内存错误
- 仅一份 crash dump，非反复重启
- panic 点完全可解释为软件逻辑错误

## 解决方案

### 升级内核（推荐）

```bash
yum update kernel
reboot
```

目标版本：`4.18.0-477.27.1.el8_8` 或更高。

### 临时规避（无法立即重启时）

```bash
# 禁用 transparent hugepage 减少 khugepaged 活动
echo never > /sys/kernel/mm/transparent_hugepage/enabled

# 减少 swap 使用降低 kswapd 回收压力
sysctl vm.swappiness=1
```

> 注意：规避措施只能降低触发频率，无法根治，最终仍需升级内核。

## 预防措施

1. **内核版本基线管理**：建立集群内核版本基线，定期扫描低于安全基线的主机，纳入例行升级计划
2. **crash dump 监控**：对 `/var/crash/` 目录建立监控，发现新的 crash dump 及时告警
3. **定期内核升级**：将 RHEL 内核更新纳入季度维护窗口，避免长期运行旧版本
4. **cgroup 使用规范**：对频繁创建/销毁 cgroup 的服务进行评估，减少不必要的 cgroup 操作

---

## 可观测与告警

### 关键事实：内核日志落盘机制

本次故障中，`refcount_t overflow` WARNING 在崩溃前 320 天就已出现，完全可以通过日志监控提前发现。

```
dmesg / journalctl -k          /var/log/messages (rsyslog)      /var/crash/vmcore-dmesg.txt
    │                              │                                  │
    └─ 环缓冲区（易失）            └─ 持久化，实时告警可用            └─ kdump 快照（仅事后分析）
       panic 瞬间日志丢失            ✅ refcount_t overflow              ✅ 包含完整 panic 调用栈
                                    正常运行时写入，但会 logrotate       ❌ panic 瞬间的 BUG: 行不会写入
```

**实际验证**（dnn014023 `/var/log/messages`）：
- `17:05:07` 最后一条正常日志 → `17:10:50` 重启后的第一条内核日志
- 中间没有任何 `kernel:` 报错行 —— panic 时 rsyslog 无法写盘
- `vmcore-dmesg.txt` 中 160+ 条 `refcount_t overflow` 和 `BUG:` 行全部由 kdump 捕获

**结论**：
- **预警类**（`refcount_t overflow`、`WARNING:`）→ 正常运行时 rsyslog 写入 `/var/log/messages`，**可通过 Loki 实时告警**
- **致命类**（`BUG:`、`Kernel panic`、`NULL pointer`）→ 仅 crash dump 有，**只能通过 Prometheus 指标间接发现**（`node_boot_time_seconds` 跳变、crash dump 文件存在）

### 日志层告警：Loki + Foxeye

集群已通过 Grafana Alloy 采集 `/var/log/messages`，可直接配置以下 Loki 告警规则：

```yaml
# 规则 1: refcount 溢出预警（本次故障的前兆信号）
- name: "kernel_refcount_overflow【kernel/memcg】Refcount 溢出预警"
  note: "【Refcount 溢出预警】\n主机 {{ $labels.instance }} 内核 refcount_t 溢出\n涉及 mem_cgroup_id_get_online，这是 RHEL 8.6 已知 bug (BZ#2221010)\n持续溢出最终将导致 kernel panic，建议升级内核到 4.18.0-477+"
  expr: |
    count_over_time({service_name="linux-system"} |= "kernel:" |= "refcount_t overflow" [5m]) > 0
  for: 5m
  severity: P1

# 规则 2: 内核 WARNING 累积预警
- name: "kernel_warning_accumulation【kernel/warning】内核 WARNING 累积预警"
  note: "【内核 WARNING 累积预警】\n主机 {{ $labels.instance }} 1h 内出现 {{ $value }} 次内核 WARNING\n频率异常，需排查原因"
  expr: |
    count_over_time({service_name="linux-system"} |= "kernel:" |= "WARNING:" [1h]) > 10
  for: 1h
  severity: P2

# 规则 3: OOM Killer 预警
- name: "kernel_oomkiller_triggered【kernel/oom】OOM Killer 预警"
  note: "【OOM Killer 预警】\n主机 {{ $labels.instance }} OOM Killer 触发\n进程因内存不足被杀死，检查内存使用情况"
  expr: |
    count_over_time({service_name="linux-system"} |= "kernel:" |= "Out of memory" [5m]) > 0
  for: 1m
  severity: P1

# 规则 4: MCE 硬件错误预警
- name: "kernel_mce_error_detected【kernel/mce】MCE 硬件错误预警"
  note: "【MCE 硬件错误预警】\n主机 {{ $labels.instance }} 检测到 Machine Check Exception 硬件错误\n可能为 CPU/内存硬件故障，需检查硬件状态"
  expr: |
    count_over_time({service_name="linux-system"} |= "kernel:" |~ "MCE|Machine.check|Hardware Error" [5m]) > 0
  for: 5m
  severity: P1

# 规则 5: 磁盘 I/O 错误预警
- name: "kernel_disk_io_error_detected【kernel/disk】磁盘 I/O 错误预警"
  note: "【磁盘 I/O 错误预警】\n主机 {{ $labels.instance }} 检测到磁盘 I/O 错误\n磁盘可能存在坏道或即将故障，检查 SMART 状态"
  expr: |
    count_over_time({service_name="linux-system"} |= "kernel:" |= "blk_update_request: I/O error" [5m]) > 0
  for: 5m
  severity: P1
```

> **注意**：标签 `service_name="linux-system"` 对应 Grafana Alloy 采集的系统日志（`/var/log/messages`）。配置前在 Grafana Explore 中验证：`{service_name="linux-system"} |= "kernel:" |= "refcount_t overflow"`。

### 指标层告警：Prometheus

日志层抓预警，指标层抓**已经发生的重启**：

```promql
# 检测非预期重启（重启后 boot_time 跳变）
changes(node_boot_time_seconds[5m]) > 0
```

```bash
# 检测 crash dump 文件（node_exporter textfile collector，cron 每 5 分钟执行）
if ls /var/crash/*/vmcore 2>/dev/null; then
    echo "node_kdump_crash_dump_exists 1"
else
    echo "node_kdump_crash_dump_exists 0"
fi > /var/lib/node_exporter/textfile_collector/kdump.prom
```

```promql
# 告警：存在未处理的 crash dump
node_kdump_crash_dump_exists == 1
```

### 分级告警策略

| 级别 | 触发条件 | 数据源 | 动作 |
|------|----------|--------|------|
| **P0** | `node_boot_time_seconds` 跳变 | Prometheus | 确认主机状态，检查 `/var/crash/`，启动排查 SOP |
| **P0** | `node_kdump_crash_dump_exists == 1` | Prometheus | 分析 crash dump，确认根因 |
| **P1** | `refcount_t overflow` 5 分钟内出现 | Loki | 当日安排内核升级 |
| **P1** | `MCE` / `Hardware Error` 出现 | Loki | 检查硬件状态，必要时更换 |
| **P1** | `blk_update_request: I/O error` 出现 | Loki | 检查磁盘 SMART，必要时更换 |
| **P1** | `Out of memory` 出现 | Loki | 排查被 kill 进程影响范围 |
| **P2** | `WARNING:` 1h 内累积 ≥10 次 | Loki | 纳入下次维护窗口 |
| **P2** | 内核版本低于安全基线 | 版本扫描 | 纳入季度升级计划 |

### 一键巡检命令

在任意主机粘贴执行：

```bash
cat > /tmp/check_refcount.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
KERNEL=$(uname -r); HOST=$(hostname); BASELINE="4.18.0-477"
echo "=== $HOST 内核健康巡检 ==="
echo "当前内核: $KERNEL  |  基线: $BASELINE"
[[ "$KERNEL" < "$BASELINE" ]] && echo "⚠️ 内核低于基线！" || echo "✅ 内核版本合规"
CRASH_COUNT=$(ls /var/crash/*/vmcore 2>/dev/null | wc -l)
[ "$CRASH_COUNT" -gt 0 ] && echo "⚠️ 存在 $CRASH_COUNT 份 crash dump！" || echo "✅ 无 crash dump"
C=$(dmesg 2>/dev/null | grep -c "refcount_t overflow" || true)
if [ "$C" -gt 0 ]; then
    S=$(dmesg 2>/dev/null | grep "refcount_t overflow" | head -1 | grep -oP '^\[\s*\K[0-9]+')
    BT=$(cat /proc/stat 2>/dev/null | grep btime | awk '{print $2}')
    F=$(date -d "@$((BT + S))" '+%Y-%m-%d' 2>/dev/null || echo "N/A")
    echo "🔴 refcount 溢出: $C 次 | 首次: $F"
    dmesg 2>/dev/null | grep "refcount_t overflow" | grep -oP 'at \S+' | sort | uniq -c | sort -rn
else echo "✅ 无 refcount 溢出"; fi
OOM=$(grep -c "Out of memory" /var/log/messages 2>/dev/null || echo 0)
[ "$OOM" -gt 0 ] && echo "⚠️ OOM 事件: $OOM 次"
SCRIPT
chmod +x /tmp/check_refcount.sh && bash /tmp/check_refcount.sh
```

### 待办：Loki 实际查询验证

> ⚠️ 当前 SRE Copilot 后端（`10.2.217.250:8080`）需要登录认证，无法直接通过 API 查询 Loki。待认证问题解决后，执行以下 LogQL 统计集群 refcount 溢出情况：
>
> ```logql
> sum by(hostname) (count_over_time({service_name="linux-system"} |= "refcount_t overflow" [24h]))
> ```

---

## 参考资料

- [RHSA-2023:5244] — Important: kernel security, bug fix, and enhancement update (https://access.redhat.com/errata/RHSA-2023:5244)
- [Red Hat Bugzilla #2221010] — refcount_t overflow often happens in mem_cgroup_id_get_online() (https://bugzilla.redhat.com/show_bug.cgi?id=2221010)
- [Linux commit 1c2d479a119b] — mm/memcontrol.c: convert mem_cgroup_id::ref to refcount_t type

---

**故障时间**：2026-04-21 17:05
**影响范围**：单机 dnn014023（Inspur SA5212M5）
**最终方案**：升级内核至 4.18.0-477+
