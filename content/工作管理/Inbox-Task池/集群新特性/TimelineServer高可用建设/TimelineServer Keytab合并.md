---
type: task
status: done
priority: P1
deadline: 2026-03-17
domain: 集群日常运维
lifecycle: routine
progress: "100"
started_date: 2026-03-17
completed_date: 2026-03-17
---

## 🎯 目标与验收标准

- [x] 确认是否需要合并 keytab

## ✅ 结论：无需合并，任务关闭

经排查，Ambari 中 ha timeline 配置组已对四个关键字段全部做了覆盖：
![[Pasted image 20260317151136.png]]
![[Pasted image 20260317151116.png]]

| 配置项                                                            | ha timeline 组值                                        |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `yarn.timeline-service.principal`                              | `yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM` |
| `yarn.timeline-service.keytab`                                 | `/etc/security/keytabs/timeline.ha.keytab`            |
| `yarn.timeline-service.http-authentication.kerberos.principal` | `HTTP/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM` |
| `yarn.timeline-service.http-authentication.kerberos.keytab`    | `/etc/security/keytabs/timeline.spnego.keytab`        |

Principal 与 Keytab 在配置组内完全自洽，不存在跨组 Principal/Keytab 不匹配的问题，keytab 合并的前提条件不成立。

---

## 📋 环境信息

### 两台 ATS 主机

| 主机 | 角色 |
|------|------|
| dsrv014020.venus.sohurdc.com | ATS 主/备节点之一 |
| dsrv014022.venus.sohurdc.com | ATS 主/备节点之一 |

### 当前各主机 keytab 明细

**dsrv014020:**

| 文件 | Principal | KVNO |
|------|-----------|------|
| `timeline.ha.keytab` | `yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM` | 1 |
| `yarn.service.keytab` | `yarn/dsrv014020.venus.sohurdc.com@VENUS.SOHURDC.COM` | 2 |

**dsrv014022:**

| 文件 | Principal | KVNO |
|------|-----------|------|
| `timeline.ha.keytab` | `yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM` | 1 |
| `yarn.service.keytab` | `yarn/dsrv014022.venus.sohurdc.com@VENUS.SOHURDC.COM`（推测） | 2 |
| `spnego.service.keytab` | `HTTP/dsrv014022.venus.sohurdc.com@VENUS.SOHURDC.COM` | 5 |
| `timeline.spnego.keytab` | `HTTP/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM` | 1 |

### 当前 Ambari 配置

| 配置项 | 当前值 |
|--------|--------|
| `yarn.timeline-service.keytab` | `/etc/security/keytabs/yarn.service.keytab` |
| `yarn.timeline-service.http-authentication.kerberos.keytab` | `/etc/security/keytabs/spnego.service.keytab` |

### 合并目标

| 合并后文件 | 包含 Principal |
|-----------|---------------|
| `timeline.combined.keytab` | `yarn/h3timeline…` + `yarn/dsrv01402x…`（各机自己的物理机 Principal） |
| `timeline.spnego.combined.keytab` | `HTTP/h3timeline…` + `HTTP/dsrv01402x…`（各机自己的物理机 Principal） |

---

## 🔧 执行步骤（两台主机均需执行 Step 1~4）

### Step 1：备份原始 keytab

```bash
# 在 dsrv014020 和 dsrv014022 上分别执行
cd /etc/security/keytabs
cp yarn.service.keytab yarn.service.keytab.bak.$(date +%Y%m%d)
cp timeline.ha.keytab timeline.ha.keytab.bak.$(date +%Y%m%d)
cp spnego.service.keytab spnego.service.keytab.bak.$(date +%Y%m%d)
cp timeline.spnego.keytab timeline.spnego.keytab.bak.$(date +%Y%m%d)
ls -la *.bak.*
```

### Step 2：合并 yarn 服务 keytab

```bash
# 在 dsrv014020 和 dsrv014022 上分别执行
# 两台机器 yarn.service.keytab 的 Principal 不同，合并结果各自包含本机的物理机 Principal
ktutil <<'EOF'
read_kt /etc/security/keytabs/timeline.ha.keytab
read_kt /etc/security/keytabs/yarn.service.keytab
write_kt /etc/security/keytabs/timeline.combined.keytab
quit
EOF
```

### Step 3：合并 SPNEGO（HTTP）keytab

```bash
# 在 dsrv014020 和 dsrv014022 上分别执行
ktutil <<'EOF'
read_kt /etc/security/keytabs/timeline.spnego.keytab
read_kt /etc/security/keytabs/spnego.service.keytab
write_kt /etc/security/keytabs/timeline.spnego.combined.keytab
quit
EOF
```

### Step 4：验证合并结果

#### 4.1 Principal 完整性检查

```bash
# 验证 yarn keytab（应同时看到 h3timeline 和本机物理机 Principal）
klist -kt /etc/security/keytabs/timeline.combined.keytab

# 验证 spnego keytab（应同时看到 h3timeline HTTP 和本机物理机 HTTP Principal）
klist -kt /etc/security/keytabs/timeline.spnego.combined.keytab
```

预期输出（以 dsrv014020 为例）：
```
# timeline.combined.keytab 应包含：
yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM
yarn/dsrv014020.venus.sohurdc.com@VENUS.SOHURDC.COM

# timeline.spnego.combined.keytab 应包含：
HTTP/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM
HTTP/dsrv014020.venus.sohurdc.com@VENUS.SOHURDC.COM
```

#### 4.2 kinit 探活

```bash
# 测试 yarn keytab 中所有 Principal 均可认证
kinit -kt /etc/security/keytabs/timeline.combined.keytab \
  yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM && klist

kinit -kt /etc/security/keytabs/timeline.combined.keytab \
  yarn/dsrv014020.venus.sohurdc.com@VENUS.SOHURDC.COM && klist
# dsrv014022 上对应改为 dsrv014022

# 测试 spnego keytab
kinit -kt /etc/security/keytabs/timeline.spnego.combined.keytab \
  HTTP/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM && klist

kinit -kt /etc/security/keytabs/timeline.spnego.combined.keytab \
  HTTP/dsrv014020.venus.sohurdc.com@VENUS.SOHURDC.COM && klist
```

#### 4.3 文件权限确认

```bash
# 合并文件权限应与原文件一致，owner yarn:hadoop，权限 640 或 400
ls -la /etc/security/keytabs/timeline.combined.keytab
ls -la /etc/security/keytabs/timeline.spnego.combined.keytab

# 如权限不对，修正
chown yarn:hadoop /etc/security/keytabs/timeline.combined.keytab
chown yarn:hadoop /etc/security/keytabs/timeline.spnego.combined.keytab
chmod 640 /etc/security/keytabs/timeline.combined.keytab
chmod 640 /etc/security/keytabs/timeline.spnego.combined.keytab
```

---

### Step 5：更新 Ambari 配置（仅操作一次，全局生效）

在 Ambari 控制台 → YARN → Configs → Advanced yarn-site，修改以下两项：

| 配置项 | 修改前 | 修改后 |
|--------|--------|--------|
| `yarn.timeline-service.keytab` | `/etc/security/keytabs/yarn.service.keytab` | `/etc/security/keytabs/timeline.combined.keytab` |
| `yarn.timeline-service.http-authentication.kerberos.keytab` | `/etc/security/keytabs/spnego.service.keytab` | `/etc/security/keytabs/timeline.spnego.combined.keytab` |

> ⚠️ 注意：如果两台 ATS 节点在 Ambari 中有**主机级配置组覆盖**，需要同步修改该配置组，否则全局改了不生效。

---

### Step 6：重启 ATS 服务

```bash
# 通过 Ambari 逐台重启 TimelineServer（先备后主，避免服务中断）
# 观察 ATS 日志确认无 GSS 相关报错
tail -f /var/log/hadoop-yarn/yarn/yarn-yarn-timelineserver-$(hostname).log | grep -i "kerberos\|gss\|auth\|error"
```

---

## 📝 实施记录

（执行完成后在此记录实际情况，包括异常处理）

---

## 🔗 关联文档

- [[TimelineServer配置变更对不同组件影响性分析]] — 详细影响面分析与 Ambari 配置修改指引
- [[Timelineserver高可用技术方案]] — ATS HA 整体架构
- [[TimelineServer独立keepalived服务事故复盘报告]] — 血泪教训，操作前必读
