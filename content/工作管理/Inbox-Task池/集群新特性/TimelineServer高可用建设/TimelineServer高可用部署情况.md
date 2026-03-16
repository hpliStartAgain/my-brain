## 一、环境信息确认

### 1.1 节点信息

|角色|主机名|IP|状态|
|---|---|---|---|
|主节点 (当前 Active ATS)|dsrv014022.venus.sohurdc.com|10.18.14.22|☐ 确认|
|备节点|dsrv014020.venus.sohurdc.com|10.18.14.20|☐ 确认|
|VIP|-|10.18.14.249|☐ 确认|

### 1.2 Ambari 信息

|配置项|值|
|---|---|
|Ambari Server|dmc014011.venus.sohurdc.com:8080|
|集群名称|hadoop3|
|用户名|admin|

### 1.3 数据目录

```
/data_b/hadoop/yarn/timeline/
├── leveldb-timeline-store/   # ATS 数据
└── timeline-state-store.ldb/ # 状态存储
```

---

## 二、风险评估与回滚准备

### 2.1 风险点

|风险|影响|缓解措施|
|---|---|---|
|Keepalived 配置错误|VIP 漂移/服务中断|备份原配置，分步修改|
|ATS 服务启停失败|作业历史不可用|保留 Ambari 手动操作能力|
|数据同步方向错误|数据丢失|VIP 判断 + 多重校验|

### 2.2 回滚检查点

每个关键步骤后会创建回滚点，格式：`ROLLBACK_POINT_N`

---

## 三、前置检查（两节点都执行）

### 3.1 在主节点执行前置检查

```bash
# ========== 3.1.1 确认当前节点是主节点 ==========
echo "=== 检查主机名 ==="
hostname -f
# 预期: dsrv014022.venus.sohurdc.com

echo "=== 检查 VIP 是否在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 预期: 应该能看到 10.18.14.249

echo "=== 检查 ATS 进程 ==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 预期: 应该有 yarn 用户运行的 ATS 进程

# ========== 3.1.2 检查 Ambari 连通性 ==========
echo "=== 测试 Ambari API ==="
curl -s -u admin:ambariadmin \
  "http://dmc014011.venus.sohurdc.com:8080/api/v1/clusters/hadoop3/services/YARN/components/APP_TIMELINE_SERVER" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('状态:', d.get('ServiceComponentInfo',{}).get('state','UNKNOWN'))"
# 预期: 状态: STARTED

# ========== 3.1.3 检查数据目录 ==========
echo "=== 检查数据目录 ==="
ls -la /data_b/hadoop/yarn/timeline/
# 预期: 看到 leveldb-timeline-store 和 timeline-state-store.ldb

echo "=== 检查数据目录大小 ==="
du -sh /data_b/hadoop/yarn/timeline/
# 记录大小: _______________

# ========== 3.1.4 检查 SSH 到备节点 ==========
echo "=== 测试 SSH 到备节点 ==="
ssh -o ConnectTimeout=5 root@10.18.14.20 "hostname -f && echo 'SSH OK'"
# 预期: dsrv014020.venus.sohurdc.com 和 SSH OK

# ========== 3.1.5 检查磁盘空间 ==========
echo "=== 检查磁盘空间 ==="
df -h /data_b
# 确保有足够空间（至少数据目录大小的 2 倍）

# ========== 3.1.6 备份现有 Keepalived 配置 ==========
echo "=== 备份 Keepalived 配置 ==="
cp /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.backup.$(date +%Y%m%d_%H%M%S)
ls -la /etc/keepalived/keepalived.conf.backup.*
# 确认备份成功
```

**检查结果**: ☐ 全部通过 ☐ 有问题（记录: _____________）

### 3.2 在备节点执行前置检查

```bash
# ========== 3.2.1 确认当前节点是备节点 ==========
echo "=== 检查主机名 ==="
hostname -f
# 预期: dsrv014020.venus.sohurdc.com

echo "=== 检查 VIP 不在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 预期: 应该没有输出（VIP 不在备节点）

echo "=== 检查 ATS 进程（应该没有）==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 预期: 没有 ATS 进程

# ========== 3.2.2 检查数据目录 ==========
echo "=== 检查数据目录是否存在 ==="
ls -la /data_b/hadoop/yarn/ 2>/dev/null || echo "目录不存在，需要创建"

# ========== 3.2.3 检查磁盘空间 ==========
echo "=== 检查磁盘空间 ==="
df -h /data_b
# 确保有足够空间

# ========== 3.2.4 备份现有 Keepalived 配置 ==========
echo "=== 备份 Keepalived 配置 ==="
cp /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.backup.$(date +%Y%m%d_%H%M%S)
ls -la /etc/keepalived/keepalived.conf.backup.*
```

**检查结果**: ☐ 全部通过 ☐ 有问题（记录: _____________）

---

## 四、部署步骤

### ⚠️ 重要提醒

- **每一步都要等待上一步完成后再执行**
- **如果任何步骤失败，立即停止并执行回滚**
- **主节点 ATS 服务不会中断，Keepalived 配置是增量修改**

---

### 阶段 A: 部署 ATS-HA 程序（两节点）

#### A1. 在主节点 (dsrv014022) 部署程序

```bash
# ========== A1.1 创建目录结构 ==========
echo "=== 创建 /opt/ats-ha 目录 ==="
mkdir -p /opt/ats-ha/{scripts,config,logs}
mkdir -p /var/lib/ats-ha
mkdir -p /var/log/ats-ha

# ========== A1.2 上传代码 ==========
# 请将本仓库的文件上传到主节点 /opt/ats-ha/
# 假设代码已经在本地 /path/to/ats-ha/
# 使用 scp 或其他方式上传:
# scp -r /path/to/ats-ha/* root@10.18.14.22:/opt/ats-ha/

# ========== A1.3 验证文件完整性 ==========
echo "=== 验证核心文件 ==="
ls -la /opt/ats-ha/scripts/
# 预期文件:
# - ha_manager.py
# - notify_handler.sh
# - check_ats.sh
# - sync_leveldb.sh
# - alert.sh
# - leveldb_check.py

ls -la /opt/ats-ha/config/
# 预期文件:
# - ha_config.yaml
# - ha_config.properties

# ========== A1.4 设置执行权限 ==========
echo "=== 设置脚本执行权限 ==="
chmod +x /opt/ats-ha/scripts/*.sh
chmod +x /opt/ats-ha/scripts/*.py

# ========== A1.5 验证 Python 环境 ==========
echo "=== 检查 Python 版本 ==="
python3 --version
# 预期: Python 3.6+

echo "=== 检查 PyYAML ==="
python3 -c "import yaml; print('PyYAML OK')"
# 如果失败，安装: pip3 install pyyaml

# ========== A1.6 初始化状态目录 ==========
echo "=== 初始化状态目录 ==="
chown -R root:root /var/lib/ats-ha
chown -R root:root /var/log/ats-ha
echo "UNKNOWN" > /var/lib/ats-ha/current_role

# ========== A1.7 验证配置文件 ==========
echo "=== 验证 ha_config.yaml ==="
python3 -c "
import yaml
with open('/opt/ats-ha/config/ha_config.yaml') as f:
    cfg = yaml.safe_load(f)
    print('VIP:', cfg['vip']['address'])
    print('Ambari Server:', cfg['ambari']['server'])
    print('LevelDB Dir:', cfg['leveldb']['data_dir'])
"
# 预期:
# VIP: 10.18.14.249
# Ambari Server: dmc014011.venus.sohurdc.com
# LevelDB Dir: /data_b/hadoop/yarn/timeline

echo "=== 验证 ha_config.properties ==="
grep -E "^(VIP_ADDRESS|AMBARI_SERVER|LEVELDB_DATA_DIR)=" /opt/ats-ha/config/ha_config.properties
# 预期:
# VIP_ADDRESS=10.18.14.249
# AMBARI_SERVER=dmc014011.venus.sohurdc.com
# LEVELDB_DATA_DIR=/data_b/hadoop/yarn/timeline
```

**ROLLBACK_POINT_A1**: 如需回滚，删除 `/opt/ats-ha` 目录即可

#### A2. 在备节点 (dsrv014020) 部署程序

```bash
# ========== A2.1 创建目录结构 ==========
echo "=== 创建 /opt/ats-ha 目录 ==="
mkdir -p /opt/ats-ha/{scripts,config,logs}
mkdir -p /var/lib/ats-ha
mkdir -p /var/log/ats-ha

# ========== A2.2 从主节点同步代码 ==========
echo "=== 从主节点同步代码 ==="
rsync -avz --progress root@10.18.14.22:/opt/ats-ha/scripts/ /opt/ats-ha/scripts/
rsync -avz --progress root@10.18.14.22:/opt/ats-ha/config/ /opt/ats-ha/config/

# ========== A2.3 替换配置文件为备节点版本 ==========
echo "=== 使用备节点配置 ==="
# 备份主节点配置
mv /opt/ats-ha/config/ha_config.properties /opt/ats-ha/config/ha_config.properties.master

# 使用备节点配置（LOCAL/PEER 互换）
cat > /opt/ats-ha/config/ha_config.properties << 'EOF'
# ATS HA 配置文件 - 备节点 dsrv014020
# 版本: v1.4.0

# ========== 节点配置 ==========
LOCAL_HOSTNAME=dsrv014020.venus.sohurdc.com
LOCAL_IP=10.18.14.20
PEER_HOSTNAME=dsrv014022.venus.sohurdc.com
PEER_IP=10.18.14.22
PEER_SSH_USER=root
PEER_SSH_PORT=22

# ========== VIP 配置 ==========
VIP_ADDRESS=10.18.14.249
VIP_INTERFACE=eth0

# ========== ATS 配置 ==========
ATS_SERVICE_NAME=hadoop-yarn-timelineserver
ATS_HEALTH_URL=http://\${HOSTNAME}:8188/ws/v1/timeline/about
ATS_HEALTH_TIMEOUT=5
ATS_START_TIMEOUT=60
ATS_STOP_TIMEOUT=30

# ========== Ambari 配置 ==========
AMBARI_ENABLED=true
AMBARI_SERVER=dmc014011.venus.sohurdc.com
AMBARI_PORT=8080
AMBARI_USERNAME=admin
AMBARI_PASSWORD=ambariadmin
AMBARI_CLUSTER_NAME=hadoop3
AMBARI_SERVICE_NAME=YARN
AMBARI_COMPONENT_NAME=APP_TIMELINE_SERVER
AMBARI_ATS_HOST=
AMBARI_API_TIMEOUT=30
AMBARI_STATE_CHANGE_TIMEOUT=120

# ========== LevelDB 配置 ==========
LEVELDB_DATA_DIR=/data_b/hadoop/yarn/timeline
LEVELDB_SYNC_TEMP_DIR=/data_b/hadoop/yarn/timeline.syncing
LEVELDB_OLD_DIR=/data_b/hadoop/yarn/timeline.old
LEVELDB_RECURSIVE_CHECK=true

# ========== 同步配置 ==========
SYNC_INTERVAL=300
SYNC_TIMEOUT=3600
SYNC_MAX_RETRIES=3
SYNC_RETRY_DELAY=60

# ========== 日志配置 ==========
LOG_DIR=/var/log/ats-ha
LOG_LEVEL=INFO
LOG_MAX_SIZE_MB=100
LOG_RETENTION_DAYS=30

# ========== 告警配置 ==========
ALERT_ENABLED=false
ALERT_SCRIPT=/opt/ats-ha/scripts/alert.sh
EOF

# ========== A2.4 使用预置的备节点 ha_config.yaml ==========
echo "=== 使用备节点专用配置 ==="
# 备份主节点的 yaml 配置
mv /opt/ats-ha/config/ha_config.yaml /opt/ats-ha/config/ha_config.yaml.master

# 使用仓库中预置的备节点配置文件
# 文件位置: config/ha_config.yaml.backup-node
cp /opt/ats-ha/config/ha_config.yaml.backup-node /opt/ats-ha/config/ha_config.yaml

# 验证 yaml 配置
echo "=== 验证 ha_config.yaml 节点配置 ==="
python3 -c "
import yaml
with open('/opt/ats-ha/config/ha_config.yaml') as f:
    cfg = yaml.safe_load(f)
    print('LOCAL:', cfg['nodes']['local']['hostname'])
    print('PEER:', cfg['nodes']['peer']['hostname'])
"
# 预期:
# LOCAL: dsrv014020.venus.sohurdc.com
# PEER: dsrv014022.venus.sohurdc.com

# ========== A2.5 验证配置 ==========
echo "=== 验证备节点配置 ==="
grep -E "^(LOCAL_HOSTNAME|LOCAL_IP|PEER_HOSTNAME|PEER_IP)=" /opt/ats-ha/config/ha_config.properties
# 预期:
# LOCAL_HOSTNAME=dsrv014020.venus.sohurdc.com
# LOCAL_IP=10.18.14.20
# PEER_HOSTNAME=dsrv014022.venus.sohurdc.com
# PEER_IP=10.18.14.22

# ========== A2.6 设置权限和初始化 ==========
echo "=== 设置权限 ==="
chmod +x /opt/ats-ha/scripts/*.sh
chmod +x /opt/ats-ha/scripts/*.py
chown -R root:root /var/lib/ats-ha
chown -R root:root /var/log/ats-ha
echo "UNKNOWN" > /var/lib/ats-ha/current_role

# ========== A2.7 创建数据目录 ==========
echo "=== 创建数据同步目录 ==="
mkdir -p /data_b/hadoop/yarn/timeline
mkdir -p /data_b/hadoop/yarn/timeline.syncing
chown -R yarn:hadoop /data_b/hadoop/yarn/
```

**ROLLBACK_POINT_A2**: 如需回滚，删除 `/opt/ats-ha` 和 `/var/lib/ats-ha` 目录

---

### 阶段 B: 配置 Keepalived（关键步骤）

#### B1. 在备节点 (dsrv014020) 先修改 Keepalived

**⚠️ 重要**: 先在备节点修改，因为备节点没有 VIP，风险较小

```bash
# ========== B1.1 查看当前 Keepalived 配置 ==========
echo "=== 当前 Keepalived 配置 ==="
cat /etc/keepalived/keepalived.conf

# ========== B1.2 确认 VI_2 配置存在 ==========
echo "=== 确认 VI_2 (ATS) 配置 ==="
grep -A 20 "vrrp_instance VI_2" /etc/keepalived/keepalived.conf
# 预期: 能看到 VI_2 配置块

# ========== B1.3 创建新的 Keepalived 配置 ==========
# 策略: 保留 VI_1 不变，修改 VI_2 使用新的健康检查和通知脚本
cat > /etc/keepalived/keepalived.conf.new << 'KEEPALIVED_EOF'
! Configuration File for keepalived
! 版本: ATS-HA v1.4.0 升级
! 修改时间: 2026-01-23
! 修改内容: 替换 VI_2 的健康检查和通知脚本

global_defs {
    notification_email {
        guangyang219856@sohu-inc.com
    }
 
    script_user root
    notification_email_from guangyang219856@sohu-inc.com
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

# ========== VI_2: ATS HA (使用新方案) ==========
# 新增: ATS 健康检查脚本
vrrp_script chk_ats {
    script "/opt/ats-ha/scripts/check_ats.sh"
    interval 5
    weight -20
    fall 3
    rise 2
    timeout 10
    user root
}

vrrp_instance VI_2 {
    state BACKUP
    interface eth0
    virtual_router_id 54
    priority 90
    nopreempt
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        10.18.14.249
    }
    # 修改: 使用新的健康检查脚本
    track_script {
        chk_ats
    }
    # 新增: 状态变更通知脚本
    notify /opt/ats-ha/scripts/notify_handler.sh
}
KEEPALIVED_EOF

# ========== B1.4 对比配置变更 ==========
echo "=== 配置变更对比 ==="
diff /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.new || true
# 确认变更内容符合预期

# ========== B1.5 语法检查 ==========
echo "=== Keepalived 配置语法检查 ==="
keepalived --config-test=/etc/keepalived/keepalived.conf.new
# 预期: 没有错误输出

# ========== B1.6 应用新配置 ==========
echo "=== 应用新配置 ==="
cp /etc/keepalived/keepalived.conf.new /etc/keepalived/keepalived.conf

# ========== B1.7 重载 Keepalived ==========
echo "=== 重载 Keepalived (不重启) ==="
systemctl reload keepalived
# 或者如果 reload 不生效:
# systemctl restart keepalived

# ========== B1.8 验证 Keepalived 状态 ==========
echo "=== 验证 Keepalived 状态 ==="
systemctl status keepalived
# 预期: active (running)

echo "=== 验证 VI_2 状态为 BACKUP ==="
journalctl -u keepalived --since "1 minute ago" | grep -i "VI_2"
# 预期: 看到 BACKUP 状态

echo "=== 确认 VIP 仍不在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 预期: 没有输出（VIP 应该还在主节点）
```

**ROLLBACK_POINT_B1**:

```bash
# 回滚命令
cp /etc/keepalived/keepalived.conf.backup.* /etc/keepalived/keepalived.conf
systemctl reload keepalived
```

#### B2. 在主节点 (dsrv014022) 修改 Keepalived

**⚠️ 关键步骤**: 主节点修改时 ATS 服务应该继续运行，VIP 不应该漂移

```bash
# ========== B2.1 再次确认 ATS 运行正常 ==========
echo "=== 确认 ATS 进程运行 ==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 必须有进程！

echo "=== 确认 VIP 在本节点 ==="
ip addr show eth0 | grep 10.18.14.249
# 必须能看到 VIP！

# ========== B2.2 创建新的 Keepalived 配置 ==========
cat > /etc/keepalived/keepalived.conf.new << 'KEEPALIVED_EOF'
! Configuration File for keepalived
! 版本: ATS-HA v1.4.0 升级
! 修改时间: 2026-01-23
! 修改内容: 替换 VI_2 的健康检查和通知脚本

global_defs {
    notification_email {
        guangyang219856@sohu-inc.com
    }
 
    script_user root
    notification_email_from guangyang219856@sohu-inc.com
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

# ========== VI_2: ATS HA (使用新方案) ==========
# 新增: ATS 健康检查脚本
vrrp_script chk_ats {
    script "/opt/ats-ha/scripts/check_ats.sh"
    interval 5
    weight -20
    fall 3
    rise 2
    timeout 10
    user root
}

vrrp_instance VI_2 {
    state MASTER
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
    # 修改: 使用新的健康检查脚本
    track_script {
        chk_ats
    }
    # 新增: 状态变更通知脚本
    notify /opt/ats-ha/scripts/notify_handler.sh
}
KEEPALIVED_EOF

# ========== B2.3 对比配置变更 ==========
echo "=== 配置变更对比 ==="
diff /etc/keepalived/keepalived.conf /etc/keepalived/keepalived.conf.new || true

# ========== B2.4 语法检查 ==========
echo "=== Keepalived 配置语法检查 ==="
keepalived --config-test=/etc/keepalived/keepalived.conf.new
# 预期: 没有错误输出

# ========== B2.5 应用新配置 ==========
echo "=== 应用新配置 ==="
cp /etc/keepalived/keepalived.conf.new /etc/keepalived/keepalived.conf

# ========== B2.6 重载 Keepalived ==========
echo "=== 重载 Keepalived ==="
systemctl reload keepalived

# ========== B2.7 立即验证！==========
echo "=== 紧急验证: VIP 是否还在 ==="
sleep 2
ip addr show eth0 | grep 10.18.14.249
# 必须能看到 VIP！如果没有，立即回滚！

echo "=== 验证 ATS 进程 ==="
ps -ef | grep -E "ApplicationHistoryServer|timelineserver" | grep -v grep
# 必须有进程！

echo "=== 验证 Keepalived 日志 ==="
journalctl -u keepalived --since "1 minute ago" | tail -20
```

**ROLLBACK_POINT_B2**:

```bash
# 紧急回滚命令（如果 VIP 丢失）
cp /etc/keepalived/keepalived.conf.backup.* /etc/keepalived/keepalived.conf
systemctl reload keepalived
# 如果还不行
systemctl restart keepalived
```

---

### 阶段 C: 启动 HA Manager 守护进程

#### C1. 在主节点启动 HA Manager

```bash
# ========== C1.1 安装 systemd 服务文件 ==========
echo "=== 安装 systemd 服务 ==="
cat > /etc/systemd/system/ats-ha-manager.service << 'SERVICE_EOF'
[Unit]
Description=ATS HA Manager Controller Service
Documentation=https://github.com/example/ats-ha
After=network-online.target keepalived.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/ats-ha
ExecStart=/usr/bin/python3 /opt/ats-ha/scripts/ha_manager.py --action daemon --config /opt/ats-ha/config/ha_config.yaml
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
LimitNOFILE=65536
LimitNPROC=65536
TimeoutStartSec=30
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ats-ha-manager

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# ========== C1.2 重载 systemd ==========
systemctl daemon-reload

# ========== C1.3 启动服务 ==========
echo "=== 启动 ats-ha-manager ==="
systemctl start ats-ha-manager

# ========== C1.4 验证服务状态 ==========
echo "=== 验证服务状态 ==="
systemctl status ats-ha-manager
# 预期: active (running)

# ========== C1.5 查看日志 ==========
echo "=== 查看 HA Manager 日志 ==="
journalctl -u ats-ha-manager --since "1 minute ago" | tail -30
# 预期: 看到角色检测为 PRIMARY

# ========== C1.6 设置开机自启 ==========
systemctl enable ats-ha-manager
```

#### C2. 在备节点启动 HA Manager

```bash
# ========== C2.1 安装 systemd 服务文件 ==========
# (与主节点相同的服务文件)
cat > /etc/systemd/system/ats-ha-manager.service << 'SERVICE_EOF'
[Unit]
Description=ATS HA Manager Controller Service
Documentation=https://github.com/example/ats-ha
After=network-online.target keepalived.service
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/ats-ha
ExecStart=/usr/bin/python3 /opt/ats-ha/scripts/ha_manager.py --action daemon --config /opt/ats-ha/config/ha_config.yaml
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
LimitNOFILE=65536
LimitNPROC=65536
TimeoutStartSec=30
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ats-ha-manager

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload

# ========== C2.2 启动服务 ==========
echo "=== 启动 ats-ha-manager ==="
systemctl start ats-ha-manager

# ========== C2.3 验证服务状态 ==========
systemctl status ats-ha-manager
# 预期: active (running)

# ========== C2.4 查看日志 ==========
journalctl -u ats-ha-manager --since "1 minute ago" | tail -30
# 预期: 看到角色检测为 STANDBY

# ========== C2.5 设置开机自启 ==========
systemctl enable ats-ha-manager
```

---

### 阶段 D: 首次数据同步

#### D1. 在主节点触发首次同步

```bash
# ========== D1.1 确认角色 ==========
echo "=== 确认当前角色 ==="
cat /var/lib/ats-ha/current_role
# 预期: PRIMARY

# ========== D1.2 手动触发同步 ==========
echo "=== 触发首次数据同步 ==="
/opt/ats-ha/scripts/sync_leveldb.sh
# 这会将数据同步到备节点，可能需要较长时间

# ========== D1.3 查看同步日志 ==========
tail -f /var/log/ats-ha/sync_leveldb.log
# Ctrl+C 退出
```

#### D2. 在备节点验证数据

```bash
# ========== D2.1 验证数据目录 ==========
echo "=== 验证数据已同步 ==="
ls -la /data_b/hadoop/yarn/timeline/
# 预期: 看到 leveldb-timeline-store 目录

echo "=== 对比数据大小 ==="
du -sh /data_b/hadoop/yarn/timeline/
# 应该与主节点接近
```

---

## 五、最终验证

### 5.1 主节点验证

```bash
echo "========== 主节点最终验证 =========="

echo "1. VIP 状态"
ip addr show eth0 | grep 10.18.14.249 && echo "✓ VIP 在本节点" || echo "✗ VIP 缺失"

echo "2. ATS 进程"
ps -ef | grep -E "ApplicationHistoryServer" | grep -v grep && echo "✓ ATS 运行中" || echo "✗ ATS 未运行"

echo "3. Keepalived 状态"
systemctl is-active keepalived && echo "✓ Keepalived 运行中" || echo "✗ Keepalived 异常"

echo "4. HA Manager 状态"
systemctl is-active ats-ha-manager && echo "✓ HA Manager 运行中" || echo "✗ HA Manager 异常"

echo "5. 当前角色"
cat /var/lib/ats-ha/current_role

echo "6. ATS 健康检查"
curl -s -o /dev/null -w "%{http_code}" "http://$(hostname -f):8188/ws/v1/timeline/about"
# 预期: 200 或 401/403
```

### 5.2 备节点验证

```bash
echo "========== 备节点最终验证 =========="

echo "1. VIP 状态"
ip addr show eth0 | grep 10.18.14.249 && echo "✗ VIP 不应该在备节点" || echo "✓ VIP 不在本节点"

echo "2. ATS 进程（应该没有）"
ps -ef | grep -E "ApplicationHistoryServer" | grep -v grep && echo "✗ ATS 不应运行" || echo "✓ ATS 未运行"

echo "3. Keepalived 状态"
systemctl is-active keepalived && echo "✓ Keepalived 运行中" || echo "✗ Keepalived 异常"

echo "4. HA Manager 状态"
systemctl is-active ats-ha-manager && echo "✓ HA Manager 运行中" || echo "✗ HA Manager 异常"

echo "5. 当前角色"
cat /var/lib/ats-ha/current_role

echo "6. 数据目录"
ls /data_b/hadoop/yarn/timeline/leveldb-timeline-store/ >/dev/null 2>&1 && echo "✓ 数据已同步" || echo "✗ 数据未同步"
```

---

## 六、完整回滚方案

### 6.1 回滚 Keepalived 配置

```bash
# 在两个节点都执行
echo "=== 回滚 Keepalived 配置 ==="
# 找到最新的备份
BACKUP_FILE=$(ls -t /etc/keepalived/keepalived.conf.backup.* | head -1)
echo "使用备份: $BACKUP_FILE"
cp "$BACKUP_FILE" /etc/keepalived/keepalived.conf
systemctl reload keepalived
systemctl status keepalived
```

### 6.2 停止 HA Manager

```bash
# 在两个节点都执行
systemctl stop ats-ha-manager
systemctl disable ats-ha-manager
rm /etc/systemd/system/ats-ha-manager.service
systemctl daemon-reload
```

### 6.3 清理部署文件

```bash
# 在两个节点都执行（可选）
rm -rf /opt/ats-ha
rm -rf /var/lib/ats-ha
rm -rf /var/log/ats-ha

# 备节点清理数据（可选）
# rm -rf /data_b/hadoop/yarn/timeline.syncing
# rm -rf /data_b/hadoop/yarn/timeline.old
```

---

## 七、日常运维命令

### 7.1 查看状态

```bash
# 查看 HA Manager 日志
journalctl -u ats-ha-manager -f

# 查看当前角色
cat /var/lib/ats-ha/current_role

# 查看同步状态
cat /var/lib/ats-ha/sync_status

# 查看 Keepalived 日志
journalctl -u keepalived -f
```

### 7.2 手动切换（测试用）

```bash
# 在主节点停止 ATS（会触发 VIP 漂移）
# 警告：这会导致服务短暂中断！
systemctl stop keepalived  # 这会让 VIP 漂移到备节点
```

### 7.3 手动同步

```bash
# 在主节点执行
/opt/ats-ha/scripts/sync_leveldb.sh
```