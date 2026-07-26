---
date: 2026-04-21
tags: [crash, kernel, RHEL8, SOP, 故障排查]
category: 运维规范
severity: P0
---

# SOP: RHEL8 内核 Bug 导致物理机重启排查手册

## 适用范围

- RHEL 8.x / CentOS 8.x / Rocky Linux 8.x / AlmaLinux 8.x
- 物理机或虚拟机发生**非预期重启**
- `/var/crash/` 目录存在 kdump crash dump

## 排查流程图

```
物理机重启
    ↓
① 确认重启时间与类型（30s）
    ↓
② 检查 crash dump 是否存在（30s）
    ↓ 有 crash dump                ↓ 无 crash dump
③ 提取 panic 关键信息（2min）      跳转附录 A：无 crash dump 排查
    ↓
④ 判断是否为已知内核 bug（1min）
    ↓ 是                           ↓ 否
⑤ 对照已知 bug 数据库确认根因      ⑥ 深入分析 vmcore
    ↓                              ↓
⑦ 制定修复方案（升级/规避）        ⑧ 输出分析报告
    ↓
⑨ 验证修复并关闭
```

---

## 第一步：确认重启时间与类型

```bash
# 1.1 查看重启记录
last reboot | head -5

# 1.2 查看系统启动时间
who -b

# 1.3 查看系统运行时长（重启后）
uptime
```

**判断标准**：

| `last reboot` 输出 | 含义 |
|---|---|
| `system boot` 后无 `system down` | 异常重启（crash/panic/电源） |
| 有 `system down` + `system boot` | 正常关机重启 |
| `crash` 字样 | 明确标注为 crash |

---

## 第二步：检查 crash dump

```bash
# 2.1 查看是否有 crash dump
ls -l /var/crash/

# 2.2 确认 kdump 服务状态
systemctl status kdump

# 2.3 查看 crash dump 大小（正常应包含 vmcore）
ls -lh /var/crash/*/
```

**若无 crash dump** → 跳转附录 A。

---

## 第三步：提取 panic 关键信息

```bash
CRASH_DIR=$(ls -td /var/crash/*/ | head -1)

# 3.1 查看崩溃直接原因（末尾 50 行）
tail -50 $CRASH_DIR/vmcore-dmesg.txt

# 3.2 提取 BUG/Panic/Oops 行
grep -E "BUG:|Oops:|Kernel panic|unable to handle|NULL pointer dereference" \
    $CRASH_DIR/vmcore-dmesg.txt

# 3.3 提取 RIP（崩溃指令地址）和调用栈
grep -E "RIP:|Call Trace:|#0|#1|#2" $CRASH_DIR/vmcore-dmesg.txt | head -30

# 3.4 提取内核版本和硬件信息
grep -E "Linux version|Hardware name" $CRASH_DIR/vmcore-dmesg.txt | head -5

# 3.5 统计 WARNING/BUG 类型分布
grep -c "WARNING:" $CRASH_DIR/vmcore-dmesg.txt
grep -c "refcount_t overflow" $CRASH_DIR/vmcore-dmesg.txt
```

**记录以下关键信息**：

| 字段 | 示例 | 用途 |
|------|------|------|
| 内核版本 | `4.18.0-425.3.1.el8.x86_64` | 对照已知 bug 版本 |
| Panic 类型 | `NULL pointer dereference` | 分类判断 |
| RIP 值 | `0x0`（空指针）/ 正常地址 | 判断是否函数指针损坏 |
| 崩溃进程 | `systemd[1]` / `kswapd0[634]` | 判断触发路径 |
| CR2 值 | `0000000000000000`（空指针） | 判断解引用目标地址 |

---

## 第四步：对照已知 RHEL8 内核 bug 指纹库

### Bug #1: memcg refcount 溢出 → NULL pointer dereference

**指纹**：
```log
refcount_t overflow at mem_cgroup_id_get_online+0x7a/0xa0 in kswapd
BUG: unable to handle kernel NULL pointer dereference at 0000000000000000
RIP: 0010:0x0
```

**影响版本**：`4.18.0-425.x` 及之前  
**修复版本**：`4.18.0-477.27.1.el8_8`（RHSA-2023:5244）  
**Red Hat Bugzilla**：BZ#2221010  
**触发条件**：cgroup 频繁创建 + swap 活跃 + 长期运行（>200 天）  
**修复方式**：`yum update kernel`

### Bug #2: vmw_pvscsi 驱动 panic

**指纹**：
```log
BUG: unable to handle kernel NULL pointer dereference in vmw_pvscsi
RIP: vmw_pvscsi_queue_lck+0x...
```

**影响版本**：`4.18.0-372.x` ~ `4.18.0-425.x`  
**触发条件**：VMware 虚拟化环境，高 IO 负载  
**修复方式**：升级内核或添加 `pvscsi.ring_pages=32` 内核参数

### Bug #3: nf_tables/netfilter UAF

**指纹**：
```log
BUG: KASAN: use-after-free in nft_verdict_dump
或
general protection fault in nf_tables_*
```

**影响版本**：`4.18.0-425.x` 及之前  
**修复版本**：`4.18.0-477.27.1.el8_8`（CVE-2023-3390/CVE-2023-4004）  
**触发条件**：使用 nftables 防火墙规则  
**修复方式**：`yum update kernel`

### Bug #4: OOM Killer 触发后 panic

**指纹**：
```log
Out of memory: Killed process xxx
...（紧随其后）
Kernel panic - not syncing: Out of memory and no killable processes
```

**触发条件**：内存极度紧张，OOM Killer 无法回收足够内存  
**修复方式**：增加内存 / 调整 `vm.overcommit_memory` / 限制进程内存

### Bug #5: Hardware MCE（Machine Check Exception）

**指纹**：
```log
mce: [Hardware Error]: Machine check events logged
CPU: xxx PID: xxx Comm: xxx Tainted: ... M ...
```

**触发条件**：CPU/内存硬件故障  
**修复方式**：硬件更换

### 快速对照脚本

```bash
#!/bin/bash
CRASH_DIR=${1:-$(ls -td /var/crash/*/ | head -1)}
DMSG="$CRASH_DIR/vmcore-dmesg.txt"

echo "=== 内核版本 ==="
grep "Linux version" "$DMSG" | head -1

echo ""
echo "=== Panic 类型 ==="
grep -E "BUG:|Oops:|Kernel panic" "$DMSG" | tail -5

echo ""
echo "=== 已知 Bug 指纹匹配 ==="

if grep -q "refcount_t overflow.*mem_cgroup_id_get_online" "$DMSG"; then
    echo "✅ 匹配 Bug #1: memcg refcount 溢出（BZ#2221010）"
    echo "   修复：yum update kernel → 4.18.0-477+"
fi

if grep -q "vmw_pvscsi" "$DMSG"; then
    echo "✅ 匹配 Bug #2: vmw_pvscsi 驱动 panic"
fi

if grep -qE "nft_|nf_tables" "$DMSG"; then
    echo "✅ 匹配 Bug #3: nf_tables UAF（CVE-2023-3390/4004）"
fi

if grep -q "Hardware Error.*Machine check" "$DMSG"; then
    echo "✅ 匹配 Bug #5: 硬件 MCE 错误"
    echo "   ⚠️ 需硬件更换，联系供应商"
fi

echo ""
echo "=== WARNING 统计 ==="
echo "总 WARNING 数: $(grep -c 'WARNING:' "$DMSG")"
echo "refcount 溢出: $(grep -c 'refcount_t overflow' "$DMSG")"
```

---

## 第五步：确认根因并制定方案

### 如果是已知内核 bug

```
① 确认当前内核版本在受影响范围
② 查阅 Red Hat Advisory 确认修复版本
③ 方案：yum update kernel → reboot
④ 若无法立即重启，评估临时规避措施
```

### 如果是未知 panic

```
① 使用 crash 工具深入分析 vmcore
② 提取完整调用栈、寄存器、内存状态
③ 搜索 Red Hat Bugzilla / linux-kernel 邮件列表
④ 如确认为新 bug，向 Red Hat 提 support case
```

---

## 第六步：验证修复

```bash
# 6.1 确认内核已升级
uname -r
# 预期：4.18.0-477+ 或更高

# 6.2 确认 kdump 服务正常
systemctl status kdump

# 6.3 清理旧的 crash dump（可选）
rm -rf /var/crash/127.0.0.1-*

# 6.4 观察 24 小时，确认无新 crash dump
ls /var/crash/
```

---

## 第七步：输出排查报告

排查完成后，在 `SRE/故障排查与复盘/` 目录输出故障报告，包含：
- 故障现象与时间
- 根因分析（含 crash dump 证据）
- 解决方案（具体命令）
- 预防措施

---

## 附录 A：无 crash dump 时的排查

```bash
# A.1 检查 kdump 是否启用
systemctl status kdump
grep crashkernel /proc/cmdline

# A.2 查看 journalctl 中的上次启动日志
journalctl -b -1 -n 200 --no-pager | grep -iE "panic|oops|BUG|error|oom"

# A.3 检查硬件日志
dmesg | grep -iE "error|fail|temperature|mce"

# A.4 检查 IPMI SEL
ipmitool sel list | tail -50

# A.5 检查 /var/log/messages
grep -iE "shutdown|reboot|panic|error" /var/log/messages | tail -50
```

**无 crash dump 的常见原因**：

| 原因 | 排查命令 |
|------|----------|
| kdump 未配置 | `grep crashkernel /proc/cmdline` |
| crashkernel 内存不足 | `cat /sys/kernel/kexec_crash_size` |
| 磁盘空间不足 | `df -h /var/crash/` |
| panic 在 kdump 初始化之前 | 检查 journalctl -b -1 最早日志 |
| 硬件 watchdog 直接断电 | 查看 IPMI SEL 日志 |

---

## 附录 B：crash 工具深入分析

```bash
# B.1 安装 crash 工具和 debuginfo
yum install crash kernel-debuginfo-$(uname -r)

# B.2 启动 crash 分析
crash /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
      /var/crash/127.0.0.1-*/vmcore

# B.3 crash 内常用命令
bt          # 查看崩溃线程的完整调用栈
bt -a       # 查看所有 CPU 的调用栈
log         # 查看完整内核日志
ps          # 查看崩溃时的进程状态
dmesg | tail -100  # dmesg 最后 100 行
kmem -i     # 内存使用摘要
sys         # 系统信息
foreach bt  # 所有任务调用栈
```

---

## 附录 C：与集群其他机器的横向对比

当一台机器发生内核 crash 后，应排查集群内其他相同内核版本的机器是否存在同样风险：

```bash
# C.1 扫描相同内核版本的主机
ansible all -m shell -a "uname -r" | grep "4.18.0-425"

# C.2 批量检查是否有 crash dump
ansible all -m shell -a "ls /var/crash/ 2>/dev/null" | grep -v "SUCCESS"

# C.3 批量检查 journalctl 中的内核 WARNING
ansible all -m shell -a "journalctl -k --since '1 week ago' | grep 'refcount_t overflow' | wc -l"
```

---

## 附录 D：可观测性与告警

可观测性方案（Loki/Prometheus 告警规则、一键巡检脚本）已整合至本次故障分析报告，参见：

→ [RHEL8内核memcg-refcount溢出导致物理机重启故障报告](RHEL8内核memcg-refcount溢出导致物理机重启故障报告.md#可观测与告警)

---

## 参考信息

| 资源 | 链接 |
|------|------|
| Red Hat Advisory | https://access.redhat.com/errata/ |
| Red Hat Bugzilla | https://bugzilla.redhat.com/ |
| RHEL 内核发布历史 | https://access.redhat.com/articles/3078 |
| Kdump 配置文档 | https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/managing_monitoring_and_updating_the_kernel/configuring-kdump |
| 本次故障分析报告 | [RHEL8内核memcg-refcount溢出导致物理机重启故障报告](RHEL8内核memcg-refcount溢出导致物理机重启故障报告.md)（含可观测性与告警配置） |

---

**维护人**：lihaopeng  
**最后更新**：2026-04-21
