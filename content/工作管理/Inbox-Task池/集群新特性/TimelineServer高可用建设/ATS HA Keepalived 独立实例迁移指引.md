## 一、背景与目的

### 1.1 当前状态

两台主机 `dsrv014022`（10.18.14.22）和 `dsrv014020`（10.18.14.20）上运行着 **同一个 Keepalived 进程**，其配置文件 `/etc/keepalived/keepalived.conf` 中同时包含两个 VRRP 实例：

|VRRP 实例|服务|VIP|virtual_router_id|管理方|
|---|---|---|---|---|
|VI_1|HiveServer2 HA (HAProxy + Keepalived)|10.18.14.253|53|平台托管|
|VI_2|ATS HA (Keepalived VRRP)|10.18.14.249|54|我们手动添加|

### 1.2 存在的问题

1. **配置覆盖风险**：平台托管的 HS2 Keepalived 实例在维护/升级时可能重新生成 `keepalived.conf`，导致手动添加的 VI_2 配置丢失
2. **生命周期耦合**：平台重启 HS2 的 Keepalived 会连带影响 ATS 的 VIP 管理
3. **VIP 漂移独立性**：HS2 和 ATS 的 VIP 漂移未必一致，共用进程时无法独立管理
4. **运维归属模糊**：VI_2 的配置混在平台托管的配置文件中，权责不清

### 1.3 迁移目标

将 VI_2（ATS HA）从共享的 Keepalived 进程中分离出来，使用 **独立的 Keepalived 进程 + 独立的配置文件 + 独立的 systemd 服务** 管理。

迁移后的架构：

```
┌─────────────────────────────────────────────────────┐
│ 单台主机                                              │
│                                                     │
│  Keepalived 进程 1 (平台托管)    Keepalived 进程 2 (ATS HA)  │
│  ├── keepalived.conf             ├── keepalived-ats.conf     │
│  ├── VI_1 (HS2, VIP .253)       ├── VI_ATS (ATS, VIP .249)  │
│  └── PID: keepalived.pid         └── PID: keepalived-ats.pid │
│                                                     │
│  各自独立运行，互不影响                                   │
└─────────────────────────────────────────────────────┘
```

### 1.4 安全性说明

- **两个 Keepalived 进程不会冲突**：`virtual_router_id` 不同（53 vs 54），VRRP 协议按 router_id 区分实例
- **VIP 不会互相干扰**：各进程只管理自己配置中声明的 VIP
- **`ats-ha-manager` 服务不需要停止**：迁移过程中 VIP 短暂释放后会重新绑定，ha_manager 的水平触发机制会自动检测并恢复

---

## 二、环境信息确认

### 2.1 节点信息

|角色|主机名|IP|当前 ATS VIP 状态|确认|
|---|---|---|---|---|
|主节点|dsrv014022.venus.sohurdc.com|10.18.14.22|持有 VIP 10.18.14.249|☐|
|备节点|dsrv014020.venus.sohurdc.com|10.18.14.20|无 VIP|☐|

### 2.2 当前服务状态

|服务|主节点 (14.22)|备节点 (14.20)|确认|
|---|---|---|---|
|Keepalived (共享)|运行中 (VI_1 + VI_2)|运行中 (VI_1 + VI_2)|☐|
|ats-ha-manager|运行中 (PRIMARY)|运行中 (STANDBY)|☐|
|ATS 服务|运行中|已停止|☐|

### 2.3 当前 Keepalived 配置差异

|配置项|主节点 (14.22)|备节点 (14.20)|
|---|---|---|
|VI_2 state|BACKUP|BACKUP|
|VI_2 priority|100|90|
|VI_2 nopreempt|是|是|
|VI_2 auth_pass|1111|1111|

---

## 三、风险评估

### 3.1 风险分析

|风险|概率|影响|缓解措施|
|---|---|---|---|
|迁移期间 ATS VIP 短暂释放|高|低（<2秒）|先操作备节点，主节点 VIP 释放窗口极短|
|新 Keepalived 进程启动失败|低|中|配置语法预检查 + 回滚方案|
|旧配置 reload 后 VI_1 受影响|极低|高|VI_1 配置完全不变，仅删除 VI_2 相关块|
|ats-ha-manager 与 STONITH 交叉干扰|高|高|**迁移前必须停止 ats-ha-manager**|

### 3.2 关键决策

**Q: `ats-ha-manager` 需要先停掉吗？**

**A: 必须停止。** 原因（2026-02-09 生产事故教训）：

1. 迁移期间 VRRP 状态变化会触发 `notify_handler.sh` 执行 STONITH（通过 Ambari 异步 stop ATS）
2. ha_manager 的自愈机制会同时检测到 ATS 未运行并尝试启动
3. Ambari 异步 stop 请求有延迟，会在 ATS 被重新启动后到达，导致 ATS 被反复 stop/start
4. 两者交叉干扰造成 ATS 约 5 分钟不可用

**Q: 正确的操作顺序是什么？**

**A: 停 ha_manager → 摘旧配置 reload → 启新进程 → 启 ha_manager。** 严禁同时存在两个管理同一 `virtual_router_id` 的 Keepalived 进程。

---

## 四、前置准备（两节点都执行）

### 4.1 备份当前配置

```bash
# ========== 4.1.1 备份 Keepalived 配置 ==========
echo "=== 备份当前 Keepalived 配置 ==="
BACKUP_SUFFIX="pre_separation_$(date +%Y%m%d_%H%M%S)"
cp /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.${BACKUP_SUFFIX}
ls -la /etc/keepalived/keepalived.conf.*
echo "备份文件: keepalived.conf.${BACKUP_SUFFIX}"
# 记录备份文件名: _______________
```

### 4.2 确认当前状态

```bash
# ========== 4.2.1 确认 Keepalived 运行正常 ==========
echo "=== Keepalived 状态 ==="
systemctl status keepalived
# 预期: active (running)

# ========== 4.2.2 确认 VIP 状态 ==========
echo "=== VIP 状态 ==="
ip addr show eth0 | grep -E "10.18.14.249|10.18.14.253"
# 主节点预期: 看到 .249 和 .253（如果 HS2 也在此节点）
# 备节点预期: 可能看到 .253（如果 HS2 备在此节点），不应看到 .249

# ========== 4.2.3 确认 ats-ha-manager 状态 ==========
echo "=== ats-ha-manager 状态 ==="
systemctl status ats-ha-manager
cat /var/lib/ats-ha/current_role
# 主节点预期: PRIMARY
# 备节点预期: STANDBY

# ========== 4.2.4 确认 ATS 进程状态 ==========
echo "=== ATS 进程 ==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 主节点预期: 有 ATS 进程
# 备节点预期: 无 ATS 进程
```

**检查结果**: ☐ 全部通过 ☐ 有问题（记录: _____________）

### 4.3 创建 ATS 专用 Keepalived 配置文件

**在两个节点都创建同一份配置文件**（两节点内容完全一致）：

```bash
# ========== 4.3.1 创建 ATS 专用 Keepalived 配置 ==========
cat > /opt/ats-ha/keepalived/keepalived-ats.conf << 'KEEPALIVED_ATS_EOF'
! ATS HA 专用 Keepalived 配置
! 版本: v1.4.1
! 说明: 独立于平台托管的 HS2 Keepalived 实例
! 修改时间: 2026-01-30

global_defs {
    ! 使用不同的 router_id 与 HS2 区分
    router_id rdc_ats_ha_router
    vrrp_skip_check_adv_addr
    vrrp_garp_interval 0
    vrrp_gna_interval 0
    enable_script_security
    script_user root
}

! ATS 健康检查脚本
vrrp_script chk_ats {
    script "/opt/ats-ha/scripts/check_ats.sh"
    interval 5
    weight -20
    fall 3
    rise 2
    timeout 10
    user root
}

! ATS HA VRRP 实例
! 注意: virtual_router_id 54 与 HS2 的 53 不同，不会冲突
vrrp_instance VI_ATS {
    state BACKUP
    interface eth0
    virtual_router_id 54
    priority 100
    nopreempt
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        10.18.14.249
    }
    track_script {
        chk_ats
    }
    notify /opt/ats-ha/scripts/notify_handler.sh
}
KEEPALIVED_ATS_EOF

echo "=== 验证配置文件已创建 ==="
cat /opt/ats-ha/keepalived/keepalived-ats.conf
```

> **说明**：两节点配置完全一致，都用 `state BACKUP` + `priority 100` + `nopreempt`。 这样谁先持有 VIP 谁就继续持有，不会因为优先级差异导致抢占。 如果你想保留之前的 priority 差异（主100/备90），可以在备节点单独修改 `priority 90`。

### 4.4 创建 ATS Keepalived 的 systemd 服务

```bash
# ========== 4.4.1 创建 systemd 服务文件 ==========
cat > /etc/systemd/system/keepalived-ats.service << 'SERVICE_EOF'
[Unit]
Description=Keepalived for ATS HA (Independent Instance)
Documentation=file:///opt/ats-ha/docs/keepalived_separation_guide.md
After=network-online.target
Wants=network-online.target
# 不依赖平台的 keepalived.service，完全独立
Conflicts=

[Service]
Type=forking
PIDFile=/var/run/keepalived-ats.pid
ExecStart=/usr/sbin/keepalived \
    -f /opt/ats-ha/keepalived/keepalived-ats.conf \
    --pid=/var/run/keepalived-ats.pid \
    --vrrp_pid=/var/run/keepalived-ats-vrrp.pid \
    --checkers_pid=/var/run/keepalived-ats-checkers.pid \
    -D
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# ========== 4.4.2 重载 systemd ==========
systemctl daemon-reload

echo "=== 验证服务文件 ==="
systemctl cat keepalived-ats
```

### 4.5 语法预检查

```bash
# ========== 4.5.1 检查 ATS Keepalived 配置语法 ==========
echo "=== 语法检查 ==="
keepalived --config-test=/opt/ats-ha/keepalived/keepalived-ats.conf 2>&1
# 预期: 没有错误输出，或输出 "Configuration file ... is valid"

# ========== 4.5.2 准备旧配置（仅保留 VI_1） ==========
# 先生成一份删除了 VI_2 相关内容的配置，用于后续替换
# 这里手动编辑确认，不能自动化（因为每个节点配置可能略有差异）

echo "=== 预览: 旧配置中需要删除的内容 ==="
echo "以下内容将从 /etc/keepalived/keepalived.conf 中移除:"
echo "  - vrrp_script chk_ats { ... }"
echo "  - vrrp_instance VI_2 { ... }"
echo "  - 相关注释行"
```

**检查结果**: ☐ 语法检查通过 ☐ 有问题（记录: _____________）

---

## 五、迁移步骤

### ⚠️ 重要原则

1. **先备节点，后主节点** — 备节点不持有 ATS VIP，操作风险最低
2. **每步验证** — 每个关键操作后立即验证
3. **失败即停** — 任何步骤失败立即停止并评估是否回滚
4. **必须先停 ats-ha-manager** — 防止迁移期间自愈机制干扰
5. **先摘旧配置，再启新进程** — 严禁同时存在两个管理同一 virtual_router_id 的进程

### ⚠️ 血泪教训（2026-02-09 生产事故）

> **错误做法**：先启动新 keepalived-ats 进程 → 再从旧进程 reload 移除 VI_2
> 
> **后果**：两个 Keepalived 进程同时声明 `virtual_router_id 54`，导致 VRRP 选举来回翻转。 每次 BACKUP→MASTER 切换都触发 `notify_handler.sh`，STONITH 通过 Ambari 异步停止 ATS。 异步请求有延迟，在 ATS 被重新启动后才到达，导致 ATS 被反复 stop/start 约 5 分钟。 虽然 ha_manager 水平触发机制最终自愈，但造成了不必要的服务中断。
> 
> **正确做法**：先停 ats-ha-manager → 先从旧配置移除 VI_2 并 reload（VIP 短暂释放）→ 再启动新进程（VIP 重新获取）→ 最后启动 ats-ha-manager

---

### 阶段 A: 在备节点 (dsrv014020) 执行迁移

**此阶段不影响任何服务**，因为备节点不持有 ATS VIP，ATS 服务也未运行。

#### A1. 确认备节点状态

```bash
# ========== A1.1 确认是备节点 ==========
echo "=== 确认主机名 ==="
hostname -f
# 预期: dsrv014020.venus.sohurdc.com

echo "=== 确认 ATS VIP 不在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 预期: 无输出

echo "=== 确认 ats-ha-manager 角色 ==="
cat /var/lib/ats-ha/current_role
# 预期: STANDBY
```

#### A2. 从旧配置中移除 VI_2

```bash
# ========== A2.1 编辑旧 Keepalived 配置，移除 VI_2 相关内容 ==========
# 备份一份工作副本
cp /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.work

# 创建仅包含 VI_1 的新配置
cat > /etc/keepalived/keepalived.conf.vi1only << 'VI1_ONLY_EOF'
! Configuration File for keepalived
! 版本: HS2 HA only (VI_2/ATS 已迁移到独立实例)
! 修改时间: 2026-01-30

global_defs {
    notification_email {
        haopengli@sohu-inc.com
    }
 
    script_user root
    notification_email_from haopengli@sohu-inc.com
    smtp_server mail.sohuno.com
    smtp_connect_timeout 30
    router_id rdc_hiveserver_router_2
    vrrp_skip_check_adv_addr
    vrrp_garp_interval 0
    vrrp_gna_interval 0
    enable_script_security
}

# ========== VI_1: HiveServer HA (保持不变) ==========
vrrp_script check_haproxy {
    script  "/etc/keepalived/scripts/check_haproxy.sh"
    fall 2
    interval 10
}
 
vrrp_instance VI_1 {
    state BACKUP
    interface eth0
    virtual_router_id 53
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        10.18.14.253
    }
    track_script {
        check_haproxy
    }
}

! ========== VI_2 (ATS HA) 已迁移到独立 Keepalived 实例 ==========
! 配置文件: /opt/ats-ha/keepalived/keepalived-ats.conf
! systemd 服务: keepalived-ats.service
VI1_ONLY_EOF

# ========== A2.2 对比变更 ==========
echo "=== 配置变更对比 ==="
diff /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.vi1only || true
# 确认: 只移除了 chk_ats 和 VI_2 相关内容，VI_1 保持不变

# ========== A2.3 语法检查 ==========
echo "=== 语法检查 (仅 VI_1) ==="
keepalived --config-test=/etc/keepalived/keepalived.conf.vi1only 2>&1
# 预期: 无错误
```

#### A3. 执行切换（备节点）

**关键操作序列**：停 ha_manager → 从旧配置摘除 VI_2 → 启动新进程 → 启 ha_manager。

> **严禁**同时存在两个管理同一 virtual_router_id 的 Keepalived 进程！ 必须先摘旧，再启新，确保任何时刻只有一个进程管理 VI_2/VI_ATS。

```bash
# ========== A3.1 停止 ats-ha-manager ==========
echo "=== 停止 ats-ha-manager ==="
systemctl stop ats-ha-manager
systemctl status ats-ha-manager --no-pager | head -3
# 预期: inactive (dead)

# ========== A3.2 从旧进程移除 VI_2 ==========
echo "=== 替换旧 Keepalived 配置（移除 VI_2） ==="
cp /etc/keepalived/keepalived.conf.vi1only /etc/keepalived/keepalived.conf

echo "=== 重载旧 Keepalived ==="
systemctl reload keepalived
sleep 2

echo "=== 验证旧 Keepalived 状态 ==="
systemctl status keepalived --no-pager | head -5
# 预期: active (running)

echo "=== 验证旧 Keepalived 日志 ==="
journalctl -u keepalived --since "30 seconds ago" --no-pager | tail -10
# 预期: VI_2 相关内容消失，VI_1 正常运行
# ⚠️ 如果旧 Keepalived 崩溃，立即回滚:
#    cp /etc/keepalived/keepalived.conf.work /etc/keepalived/keepalived.conf
#    systemctl restart keepalived

echo "=== 确认 HS2 VIP 未受影响 ==="
ip addr show eth0 | grep 10.18.14.253
# 状态应该与操作前一致

# ========== A3.3 启动 ATS 专用 Keepalived ==========
# 此时旧进程已经不再管理 VI_2，不会有 VRRP 选举冲突
echo "=== 启动 keepalived-ats ==="
systemctl start keepalived-ats
sleep 2

echo "=== 验证新进程启动 ==="
systemctl status keepalived-ats --no-pager | head -5
# 预期: active (running)

echo "=== 验证 PID 文件 ==="
cat /var/run/keepalived-ats.pid
# 预期: 有 PID 数字

echo "=== 检查新进程日志 ==="
journalctl -u keepalived-ats --since "30 seconds ago" --no-pager | tail -10
# 预期: VI_ATS 进入 BACKUP 状态（因为主节点的旧进程还管着 VIP）
# ⚠️ 如果报错，立即停止: systemctl stop keepalived-ats

# ========== A3.4 重新启动 ats-ha-manager ==========
echo "=== 启动 ats-ha-manager ==="
systemctl start ats-ha-manager
sleep 3

echo "=== 验证 ats-ha-manager ==="
systemctl status ats-ha-manager --no-pager | head -5
cat /var/lib/ats-ha/current_role
# 预期: STANDBY

# ========== A3.5 最终验证（备节点） ==========
echo "=== 最终验证 ==="
echo "--- Keepalived 进程列表 ---"
ps aux | grep keepalived | grep -v grep

echo "--- PID 文件 ---"
echo "旧进程 PID: $(cat /var/run/keepalived.pid 2>/dev/null || echo '无')"
echo "ATS 进程 PID: $(cat /var/run/keepalived-ats.pid 2>/dev/null || echo '无')"

echo "--- VIP 状态 ---"
ip addr show eth0 | grep -E "10.18.14"

echo "--- ats-ha-manager ---"
systemctl is-active ats-ha-manager
cat /var/lib/ats-ha/current_role
# 预期: STANDBY（不应该变化）
```

**ROLLBACK_POINT_A**:

```bash
# 备节点回滚命令
systemctl stop keepalived-ats
cp /etc/keepalived/keepalived.conf.work /etc/keepalived/keepalived.conf
systemctl reload keepalived
# 验证
systemctl status keepalived
```

#### A4. 设置开机自启

```bash
# ========== A4.1 设置 ATS Keepalived 开机自启 ==========
systemctl enable keepalived-ats
echo "=== 验证 ==="
systemctl is-enabled keepalived-ats
# 预期: enabled
```

**备节点迁移完成**: ☐ 确认

---

### 阶段 B: 在主节点 (dsrv014022) 执行迁移

**⚠️ 这是关键步骤**：主节点持有 ATS VIP (10.18.14.249)，操作期间 VIP 会有 **极短暂（<2秒）的释放窗口**。

#### B1. 确认主节点状态

```bash
# ========== B1.1 确认是主节点 ==========
echo "=== 确认主机名 ==="
hostname -f
# 预期: dsrv014022.venus.sohurdc.com

echo "=== 确认 ATS VIP 在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 预期: 看到 10.18.14.249/32 ← 必须在！

echo "=== 确认 ATS 服务正常 ==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 预期: 有 ATS 进程

echo "=== 确认 ats-ha-manager 角色 ==="
cat /var/lib/ats-ha/current_role
# 预期: PRIMARY

echo "=== 确认备节点已完成迁移 ==="
ssh root@10.18.14.20 "systemctl is-active keepalived-ats && echo '备节点 ATS Keepalived: OK'"
# 预期: active 和 OK
```

#### B2. 停止 ats-ha-manager（必须）

> **必须停止**。2026-02-09 生产事故证明：迁移期间 VRRP 状态变化会触发 notify_handler.sh 执行 STONITH，而 ha_manager 的自愈会同时尝试启动 ATS，两者交叉干扰导致 ATS 反复重启。

```bash
# ========== B2.1 停止 ats-ha-manager ==========
echo "=== 停止 ats-ha-manager ==="
systemctl stop ats-ha-manager
systemctl status ats-ha-manager --no-pager | head -3
# 预期: inactive (dead)
echo "已停止，迁移完成后会重新启动"
```

#### B3. 从旧配置中移除 VI_2

```bash
# ========== B3.1 创建仅包含 VI_1 的配置 ==========
# 与备节点相同的内容
cat > /etc/keepalived/keepalived.conf.vi1only << 'VI1_ONLY_EOF'
! Configuration File for keepalived
! 版本: HS2 HA only (VI_2/ATS 已迁移到独立实例)
! 修改时间: 2026-01-30

global_defs {
    notification_email {
        haopengli@sohu-inc.com
    }
 
    script_user root
    notification_email_from haopengli@sohu-inc.com
    smtp_server mail.sohuno.com
    smtp_connect_timeout 30
    router_id rdc_hiveserver_router_2
    vrrp_skip_check_adv_addr
    vrrp_garp_interval 0
    vrrp_gna_interval 0
    enable_script_security
}

# ========== VI_1: HiveServer HA (保持不变) ==========
vrrp_script check_haproxy {
    script  "/etc/keepalived/scripts/check_haproxy.sh"
    fall 2
    interval 10
}
 
vrrp_instance VI_1 {
    state BACKUP
    interface eth0
    virtual_router_id 53
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        10.18.14.253
    }
    track_script {
        check_haproxy
    }
}

! ========== VI_2 (ATS HA) 已迁移到独立 Keepalived 实例 ==========
! 配置文件: /opt/ats-ha/keepalived/keepalived-ats.conf
! systemd 服务: keepalived-ats.service
VI1_ONLY_EOF

# ========== B3.2 对比变更 ==========
echo "=== 配置变更对比 ==="
diff /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.vi1only || true

# ========== B3.3 保存工作副本 ==========
cp /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.work
```

#### B4. 执行切换（主节点） — 关键操作

**操作逻辑（已修正）**：

1. 先从旧配置移除 VI_2 并 reload（VIP 短暂释放，约 1-2 秒）
2. 立即启动 ATS 专用 Keepalived（新进程获取 VIP）
3. VIP 释放窗口极短，ATS 服务本身不受影响（TCP 连接不会因 VIP 短暂消失而断开）

> **严禁先启新进程再摘旧配置！** 同一台机器上两个进程同时声明同一个 virtual_router_id 会导致 VRRP 选举来回翻转，每次状态变化都触发 notify_handler.sh 的 STONITH， Ambari 异步 stop 请求会在 ATS 重启后到达，导致 ATS 被反复杀停（已在生产验证）。

```bash
# ========== B4.1 从旧进程移除 VI_2 ==========
echo "=== [关键] 替换旧 Keepalived 配置（移除 VI_2） ==="
cp /etc/keepalived/keepalived.conf.vi1only /etc/keepalived/keepalived.conf

echo "=== 重载旧 Keepalived ==="
systemctl reload keepalived
# VIP 10.18.14.249 此刻会被释放！但 ATS 进程仍在运行。
# 如果备节点的 keepalived-ats 已启动，VIP 可能短暂漂移到备节点。
# 不用担心，下一步立即启动本地的 keepalived-ats 会把 VIP 拿回来。
sleep 2

echo "=== 验证旧 Keepalived 仍在运行 ==="
systemctl status keepalived --no-pager | head -5
# 预期: active (running)

# ========== B4.2 立即启动 ATS 专用 Keepalived ==========
# 此时旧进程已经不再管理 VI_2，不会有 VRRP 选举冲突
echo "=== [关键] 启动 keepalived-ats ==="
systemctl start keepalived-ats
sleep 3

echo "=== 验证 keepalived-ats 状态 ==="
systemctl status keepalived-ats --no-pager | head -10
# 预期: active (running)

echo "=== 检查新进程日志 ==="
journalctl -u keepalived-ats --since "30 seconds ago" --no-pager | tail -15
# 预期: VI_ATS 进入 MASTER 状态
# ⚠️ 如果启动失败，紧急回滚（见 ROLLBACK_POINT_B）

# ========== B4.3 紧急验证 ==========
echo "============================================"
echo "=== 紧急验证（必须全部通过！）==="
echo "============================================"

echo "--- 1. ATS VIP ---"
ip addr show eth0 | grep 10.18.14.249
if ip addr show eth0 | grep -q 10.18.14.249; then
    echo "✓ VIP 10.18.14.249 正常"
else
    echo "✗ VIP 可能在备节点! 检查 keepalived-ats 日志"
    echo "  journalctl -u keepalived-ats --since '1 minute ago' --no-pager"
    echo "  如果 VIP 在备节点且 ATS 未在备节点启动，VIP 会在本节点 chk_ats 恢复后回来"
fi

echo "--- 2. HS2 VIP ---"
ip addr show eth0 | grep 10.18.14.253
# 如果之前持有 .253，现在也应该持有

echo "--- 3. ATS 进程 ---"
if ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep > /dev/null; then
    echo "✓ ATS 进程正常（VIP 释放不影响已运行的进程）"
else
    echo "✗ ATS 进程异常! 但 ats-ha-manager 重启后会自愈"
fi

echo "--- 4. Keepalived 进程 ---"
echo "旧进程(HS2): $(systemctl is-active keepalived)"
echo "新进程(ATS): $(systemctl is-active keepalived-ats)"
# 两个都应该是 active

echo "--- 5. PID 文件 ---"
echo "旧 PID: $(cat /var/run/keepalived.pid 2>/dev/null || echo '无')"
echo "ATS PID: $(cat /var/run/keepalived-ats.pid 2>/dev/null || echo '无')"
```

**如果验证失败，立即执行回滚**：

**ROLLBACK_POINT_B**:

```bash
# 主节点紧急回滚
systemctl stop keepalived-ats
cp /etc/keepalived/keepalived.conf.work /etc/keepalived/keepalived.conf
systemctl reload keepalived
sleep 2
# 验证 VIP 恢复
ip addr show eth0 | grep 10.18.14.249
```

#### B5. 重新启动 ats-ha-manager（必须）

```bash
# ========== B5.1 重新启动 ats-ha-manager ==========
echo "=== 启动 ats-ha-manager ==="
systemctl start ats-ha-manager
sleep 5

echo "=== 验证 ats-ha-manager ==="
systemctl status ats-ha-manager --no-pager | head -5
cat /var/lib/ats-ha/current_role
# 预期: PRIMARY

# 如果 ATS 在 VIP 释放期间被备节点接管，ha_manager 会自动检测并恢复
```

#### B6. 设置开机自启

```bash
# ========== B6.1 设置 ATS Keepalived 开机自启 ==========
systemctl enable keepalived-ats
echo "=== 验证 ==="
systemctl is-enabled keepalived-ats
# 预期: enabled
```

**主节点迁移完成**: ☐ 确认

---

## 六、最终验证

### 6.1 主节点完整验证

```bash
echo "=========================================="
echo "=== 主节点 (dsrv014022) 最终验证 ==="
echo "=========================================="

echo "1. Keepalived 进程（应有两组）"
ps aux | grep keepalived | grep -v grep
echo ""

echo "2. VIP 状态"
ip addr show eth0 | grep -E "10.18.14"
echo ""

echo "3. 服务状态"
echo "  keepalived (HS2): $(systemctl is-active keepalived)"
echo "  keepalived-ats:   $(systemctl is-active keepalived-ats)"
echo "  ats-ha-manager:   $(systemctl is-active ats-ha-manager)"
echo ""

echo "4. 角色"
echo "  当前角色: $(cat /var/lib/ats-ha/current_role)"
echo ""

echo "5. ATS 进程"
ps -ef | grep -E "ApplicationHistoryServer" | grep -v grep && echo "  ✓ ATS 运行中" || echo "  ✗ ATS 未运行"
echo ""

echo "6. ATS 健康检查"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://$(hostname -f):8188/ws/v1/timeline/about" 2>/dev/null || echo "失败")
echo "  HTTP 状态码: ${HTTP_CODE}"
echo ""

echo "7. PID 文件"
echo "  keepalived PID:     $(cat /var/run/keepalived.pid 2>/dev/null || echo '无')"
echo "  keepalived-ats PID: $(cat /var/run/keepalived-ats.pid 2>/dev/null || echo '无')"
```

### 6.2 备节点完整验证

```bash
echo "=========================================="
echo "=== 备节点 (dsrv014020) 最终验证 ==="
echo "=========================================="

echo "1. Keepalived 进程（应有两组）"
ps aux | grep keepalived | grep -v grep
echo ""

echo "2. VIP 状态（ATS VIP 不应在此）"
ip addr show eth0 | grep -E "10.18.14"
echo ""

echo "3. 服务状态"
echo "  keepalived (HS2): $(systemctl is-active keepalived)"
echo "  keepalived-ats:   $(systemctl is-active keepalived-ats)"
echo "  ats-ha-manager:   $(systemctl is-active ats-ha-manager)"
echo ""

echo "4. 角色"
echo "  当前角色: $(cat /var/lib/ats-ha/current_role)"
echo ""

echo "5. ATS 进程（不应运行）"
ps -ef | grep -E "ApplicationHistoryServer" | grep -v grep && echo "  ✗ ATS 不应运行!" || echo "  ✓ ATS 未运行"
echo ""

echo "6. keepalived-ats 日志（应显示 BACKUP）"
journalctl -u keepalived-ats --since "5 minutes ago" --no-pager | grep -i "VI_ATS\|BACKUP\|MASTER" | tail -5
```

### 6.3 交叉验证

```bash
# 在主节点执行，验证两节点的 Keepalived 通信正常
echo "=== 验证 VRRP 通信 ==="
# 在主节点查看 keepalived-ats 日志，应该能看到与备节点的 VRRP 通信
journalctl -u keepalived-ats --since "2 minutes ago" --no-pager | grep -i "vrrp\|advert\|master\|backup" | tail -10
```

---

## 七、完整回滚方案

### 7.1 紧急回滚（恢复到共享 Keepalived）

**在两个节点都执行**（先备后主）：

```bash
# ========== 7.1.1 停止 ATS 专用 Keepalived ==========
systemctl stop keepalived-ats
systemctl disable keepalived-ats

# ========== 7.1.2 恢复旧 Keepalived 配置 ==========
# 使用迁移前的备份
BACKUP_FILE=$(ls -t /etc/keepalived/keepalived.conf.pre_separation_* 2>/dev/null | head -1)
if [ -n "$BACKUP_FILE" ]; then
    echo "恢复备份: $BACKUP_FILE"
    cp "$BACKUP_FILE" /etc/keepalived/keepalived.conf
else
    echo "未找到备份文件! 使用工作副本..."
    cp /etc/keepalived/keepalived.conf.work /etc/keepalived/keepalived.conf
fi

# ========== 7.1.3 重载/重启旧 Keepalived ==========
systemctl reload keepalived || systemctl restart keepalived

# ========== 7.1.4 验证 ==========
systemctl status keepalived
ip addr show eth0 | grep -E "10.18.14"
```

### 7.2 清理 ATS Keepalived 服务（如果需要彻底移除）

```bash
systemctl stop keepalived-ats
systemctl disable keepalived-ats
rm /etc/systemd/system/keepalived-ats.service
systemctl daemon-reload
rm -f /var/run/keepalived-ats.pid
rm -f /var/run/keepalived-ats-vrrp.pid
rm -f /var/run/keepalived-ats-checkers.pid
```

---

## 八、日常运维命令

### 8.1 查看 ATS Keepalived 状态

```bash
# 查看服务状态
systemctl status keepalived-ats

# 查看日志
journalctl -u keepalived-ats -f

# 查看 VIP
ip addr show eth0 | grep 10.18.14.249
```

### 8.2 重载 ATS Keepalived 配置

```bash
# 修改配置后重载（不中断 VIP）
systemctl reload keepalived-ats

# 如果 reload 不生效，需要重启（VIP 会短暂释放）
systemctl restart keepalived-ats
```

### 8.3 确认两个 Keepalived 实例独立运行

```bash
echo "=== Keepalived 实例列表 ==="
echo "HS2 实例:"
echo "  服务: keepalived.service"
echo "  配置: /etc/keepalived/keepalived.conf"
echo "  PID:  $(cat /var/run/keepalived.pid 2>/dev/null || echo '未运行')"
echo "  VIP:  10.18.14.253 (VI_1, router_id=53)"
echo ""
echo "ATS 实例:"
echo "  服务: keepalived-ats.service"
echo "  配置: /opt/ats-ha/keepalived/keepalived-ats.conf"
echo "  PID:  $(cat /var/run/keepalived-ats.pid 2>/dev/null || echo '未运行')"
echo "  VIP:  10.18.14.249 (VI_ATS, router_id=54)"
```

### 8.4 与 ats-ha-manager 的配合

`ats-ha-manager.service` 的 systemd 依赖需要更新，指向新的 ATS Keepalived：

```bash
# 更新 ats-ha-manager 的依赖关系（可选但推荐）
# 编辑 /etc/systemd/system/ats-ha-manager.service
# 将 After=network-online.target keepalived.service
# 改为 After=network-online.target keepalived-ats.service
# 然后:
systemctl daemon-reload
```