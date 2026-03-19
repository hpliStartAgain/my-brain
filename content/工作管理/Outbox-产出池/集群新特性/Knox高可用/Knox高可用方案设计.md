# Knox 高可用方案设计

> **版本**: v1.0
> **日期**: 2026-03-19
> **负责人**: 李浩鹏
> **Knox 版本**: 2.0.0

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状分析](#2-现状分析)
3. [高可用方案设计](#3-高可用方案设计)
4. [关键技术点](#4-关键技术点)
5. [SCLB 四层网关配置](#5-sclb-四层网关配置)
6. [部署实施步骤](#6-部署实施步骤)
7. [验收标准](#7-验收标准)
8. [风险与规避](#8-风险与规避)

---

## 1. 背景与目标

Knox 是大数据集群统一网关，当前承载以下访问入口：
- YARN UI / YARN API
- HDFS UI / WebHDFS
- JobHistory UI
- Spark History UI
- Tez UI
- Knox Admin UI

**当前问题**：Knox 仅部署在单节点 `dsrv014022.venus.sohurdc.com`，无高可用保障，节点故障将导致所有 Web UI 和 API 代理完全不可用。

**目标**：通过双节点 + SCLB 四层负载均衡实现 Knox 高可用，做到单节点故障自动切换，业务零感知。

---

## 2. 现状分析

### 2.1 部署现状

| 项目 | 内容 |
|------|------|
| 节点 | `dsrv014022.venus.sohurdc.com` |
| 安装路径 | `/opt/work/knox-2.0.0`（hdfs 用户） |
| 服务端口 | 8443 |
| SSL | 已关闭（内网环境） |
| 认证方式 | ShiroProvider + 本地 LDAP（端口 33389） |
| 集群拓扑 | venus.xml（包含 WEBHDFS HA、YARNUI HA） |
| Kerberos | 已启用，JAAS 配置 `/opt/work/knox-2.0.0/conf/krb5JAASLogin.conf` |

### 2.2 Knox 无状态特性分析

Knox 本质是**无状态反向代理网关**，具备水平扩展条件：

- 请求路由逻辑完全由拓扑文件（`conf/topologies/*.xml`）驱动，无运行时状态
- 认证 Token 基于 JWT，校验逻辑在本节点完成，**不依赖跨节点 Session 共享**
- `data/deployments/` 下的发布包在首次访问时自动从 topology XML 热生成
- 唯一需要保持一致的持久化数据：`data/security/master`（主密钥）和 `data/security/keystores/gateway.jks`（TLS 证书库）

> 结论：**主密钥 + keystore 一致 → 两节点可无缝互为主备**

---

## 3. 高可用方案设计

### 3.1 整体架构

```
                        ┌─────────────────────────┐
  客户端 / 内网用户       │    SCLB 四层实例          │
  ─────────────────────►│  VIP: <待申请>            │
  访问 VIP:8443          │  协议: TCP   端口: 8443   │
                        └────────────┬────────────┘
                                     │  轮询/故障摘除
                        ┌────────────┴────────────┐
                        │                         │
               ┌────────▼────────┐   ┌────────────▼───────┐
               │  Knox 节点 1     │   │  Knox 节点 2         │
               │  dsrv014022     │   │  <待选节点>           │
               │  :8443          │   │  :8443               │
               └────────┬────────┘   └────────────┬────────┘
                        │                         │
                        └────────────┬────────────┘
                                     │ 代理转发
                        ┌────────────▼────────────┐
                        │     Hadoop 集群           │
                        │  YARN RM / HDFS NN       │
                        │  JobHistory / Spark HS   │
                        └─────────────────────────┘
```

### 3.2 方案要点

| 要点 | 说明 |
|------|------|
| 负载均衡层 | 公司 SCLB 四层实例，标准型（4C8G，支持 6w 并发） |
| 调度算法 | 加权轮询（两节点权重相同） |
| 健康检查 | TCP 探测 8443 端口，间隔 5s，连续 2 次失败摘除 |
| 主密钥同步 | 将节点 1 的 `data/security/master` 复制到节点 2，保证密钥一致 |
| Keystore 同步 | 将节点 1 的 `data/security/keystores/gateway.jks` 复制到节点 2 |
| Topology 同步 | `conf/topologies/*.xml` 和 `conf/gateway-site.xml` 保持两节点一致 |
| LDAP 同步 | 两节点各自运行本地 LDAP，`conf/users.ldif` 保持一致（手动同步） |
| Kerberos | 节点 2 需配置相同的 `krb5.conf` 和 Keytab，并申请 `HTTP/<node2>@REALM` principal |

---

## 4. 关键技术点

### 4.1 主密钥同步（最关键步骤）

Knox 的主密钥用于加密/解密 keystore 和 credential store。**两节点必须使用完全相同的 master secret**，否则节点 2 无法解密从节点 1 复制过来的 keystore。

**正确做法**：
```bash
# 在节点1上，直接复制 master 文件（已加密，可直接复制）
scp /opt/work/knox-2.0.0/data/security/master <node2>:/opt/work/knox-2.0.0/data/security/master

# 同步 keystores 目录
scp -r /opt/work/knox-2.0.0/data/security/keystores/ <node2>:/opt/work/knox-2.0.0/data/security/
```

> ⚠️ **不要**在节点 2 执行 `bin/knoxcli.sh create-master`，否则会生成新密钥导致解密失败。

### 4.2 Kerberos 配置

节点 2 需要：
1. `/etc/krb5.conf` 与集群一致（通常已存在）
2. 申请新 Keytab：`HTTP/<node2_fqdn>@HADOOP.COM`
3. 更新 `conf/krb5JAASLogin.conf` 中 `keyTab` 路径指向节点 2 的 keytab

同时需在 Hadoop `core-site.xml` 追加：
```xml
<property>
  <name>hadoop.proxyuser.HTTP.hosts</name>
  <value>dsrv014022.venus.sohurdc.com,<node2_fqdn>,*</value>
</property>
```
（实际上当前配置为 `*`，无需修改）

### 4.3 Topology 变更同步机制

两节点间 topology 文件目前为**手动同步**，后续可考虑：
- 用 rsync + cron 定时同步（简单可靠）
- 挂载同一 NFS 目录（更实时，但引入共享存储依赖）

本期采用 **rsync + cron**，每 5 分钟同步一次。

### 4.4 SCLB 健康检查说明

Knox 在 SSL 关闭时，8443 端口提供标准 HTTP 服务，健康检查使用 **TCP 探测**即可，不需要 HTTP 200 检查，降低配置复杂度。

---

## 5. SCLB 四层网关配置

### 5.1 服务器组配置

| 参数 | 值 |
|------|-----|
| 服务器组类型 | IP 类型 |
| 后端协议 | TCP |
| 调度算法 | 加权轮询调度 |
| 健康检查协议 | TCP |
| 健康检查端口 | 8443 |
| 响应超时 | 5 秒 |
| 间隔时长 | 5 秒 |
| 健康阈值 | 2 次 |
| 不健康阈值 | 2 次 |

**后端服务器**：

| IP                           | 端口   | 权重  |
| ---------------------------- | ---- | --- |
| dsrv014022.venus.sohurdc.com | 8443 | 100 |
| `<node2_ip>`                 | 8443 | 100 |
|                              |      |     |

### 5.2 实例与监听配置

| 参数 | 值 |
|------|-----|
| 实例规格 | 标准型（4C8G） |
| IP 协议 | IPv4 |
| 监听协议 | TCP |
| 监听端口 | 8443 |
| 后端服务器组 | 上述服务器组 |

---

## 6. 部署实施步骤

### Step 1：确认节点 2（预计 3.20）

- 选择与 `dsrv014022` 同网段、资源充足的主机
- 确认 hdfs 用户存在，磁盘空间 > 5GB
- 确认网络可达 Hadoop NameNode / ResourceManager / 各 Web UI 组件

### Step 2：节点 2 Knox 部署（预计 3.24）

```bash
# 1. 复制 Knox 程序包
scp -r /opt/work/knox-2.0.0 <node2>:/opt/work/knox-2.0.0

# 2. 确保 data/security 目录权限正确
chown -R hdfs:hdfs /opt/work/knox-2.0.0/data/security

# 3. 配置 krb5JAASLogin.conf（修改 keyTab 路径为节点2的keytab）
vim /opt/work/knox-2.0.0/conf/krb5JAASLogin.conf

# 4. 启动本地 LDAP
cd /opt/work/knox-2.0.0
bin/ldap.sh start

# 5. 启动 Knox Gateway
bin/gateway.sh start

# 6. 验证日志无报错
tail -f logs/gateway.log
```

### Step 3：SCLB 配置（预计 3.25）

1. 登录 SCLB 平台，创建四层实例（标准型）
2. 创建服务器组（IP 类型，TCP，加权轮询，TCP 健康检查/8443）
3. 添加两个后端 IP（dsrv014022 + node2，各权重 100）
4. 创建监听（TCP 8443 → 上述服务器组）
5. 记录 SCLB VIP 地址

### Step 4：端到端验证（预计 3.26）

**单节点验证**（绕过 SCLB 直连节点 2）：
```bash
# 验证 Knox Admin UI
curl -k -u admin:admin123 http://<node2>:8443/gateway/manager/admin-ui

# 验证 YARN UI
curl -k -u admin:admin123 http://<node2>:8443/gateway/venus/yarn

# 验证 WebHDFS
curl -k -u mrd:mrd123 http://<node2>:8443/gateway/venus/webhdfs/v1/?op=LISTSTATUS
```

**VIP 验证**：
```bash
# 通过 SCLB VIP 访问
curl -k -u admin:admin123 http://<SCLB_VIP>:8443/gateway/venus/yarn
```

**故障切换验证**：
```bash
# 停止节点 1 的 Knox
ssh dsrv014022 "cd /opt/work/knox-2.0.0 && bin/gateway.sh stop"

# 等待健康检查摘除（约 10s）
sleep 15

# 验证 VIP 仍可访问（流量已切换到节点 2）
curl -k -u admin:admin123 http://<SCLB_VIP>:8443/gateway/venus/yarn

# 恢复节点 1
ssh dsrv014022 "cd /opt/work/knox-2.0.0 && bin/gateway.sh start"
```

### Step 5：上线切换（预计 3.27）

1. 更新内网 DNS / 访问文档，将 Knox 访问地址统一改为 SCLB VIP
2. 通知相关团队更新 Knox 地址（WebHDFS 调用方等）
3. 更新本文档，补充实际 VIP 地址和节点 2 信息

### Step 6：配置 Topology 定时同步（3.27 完成）

```bash
# 在节点 1 上配置 cron，每 5 分钟同步 topology 到节点 2
crontab -e
# 添加：
*/5 * * * * rsync -a /opt/work/knox-2.0.0/conf/topologies/ <node2>:/opt/work/knox-2.0.0/conf/topologies/ && \
            rsync -a /opt/work/knox-2.0.0/conf/users.ldif <node2>:/opt/work/knox-2.0.0/conf/users.ldif
```

---

## 7. 验收标准

- [ ] 节点 2 独立可访问 Knox Admin UI、YARN UI、WebHDFS
- [ ] SCLB VIP 可正常访问上述所有服务
- [ ] 停止节点 1 Knox 服务后，VIP 访问在 30 秒内恢复
- [ ] 停止节点 2 Knox 服务后，VIP 访问在 30 秒内恢复
- [ ] Topology 文件定时同步机制生效（cron 验证）
- [ ] 更新访问地址文档，通知相关团队

---

## 8. 风险与规避

| 风险 | 影响 | 规避措施 |
|------|------|---------|
| 节点 2 Keytab 申请周期长 | 阻塞 Kerberos 认证 | 提前向运维申请，确认 `HTTP/<node2>@HADOOP.COM` principal |
| master 文件复制出错导致节点 2 解密失败 | 节点 2 启动报错 | 复制前备份节点 1 master，复制后在节点 2 验证 keystore 可读性 |
| SCLB VIP 申请流程周期 | 上线节点延迟 | SCLB 配置与节点部署并行推进 |
| Topology 同步延迟导致两节点配置不一致 | 请求路由到旧配置节点时报错 | 重要变更后手动同步，cron 作为兜底 |
