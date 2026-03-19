# ACAA（Ambari Config Audit Agent）设计与部署方案

> **文档版本**：v1.0
> **编写日期**：2026-03-17
> **作者**：搜狐 RDC 大数据集群 SRE
> **适用范围**：大数据基础设施团队、平台架构组

---

## 一、背景与问题

### 1.1 问题描述

搜狐 RDC 大数据集群使用 **Ambari** 作为统一的集群配置管理平台，管理 HDFS、YARN、HiveServer2、Spark、Kafka 等核心组件的配置。在日常运维中，存在以下安全与可观测性缺口：

| 问题 | 影响 |
|------|------|
| 无法实时感知谁在什么时间修改了哪项配置 | 配置变更引发故障时，排查困难、溯源慢 |
| Ambari 审计日志格式非结构化，人工分析效率低 | 无法接入告警系统，无法驱动自动化响应 |
| 非工作时间的配置变更无人感知 | 存在安全隐患，高风险操作缺乏管控 |
| 敏感配置（密码、Kerberos、SSL）变更无专项告警 | 合规层面存在风险 |

### 1.2 解决目标

- **实时性**：配置变更发生后 **≤ 10 秒**内生成结构化记录
- **精确性**：逐字段记录 `ADDED / DELETED / MODIFIED` 的具体变更内容
- **可观测**：接入 Loki 日志平台，统一纳入 Foxeye 告警体系
- **轻量化**：对 Ambari Server 进程**零影响**，不入侵任何组件

---

## 二、方案设计

### 2.1 核心思路

ACAA 是一个部署在 **Ambari Server 宿主机**上的轻量 Go 守护进程，采用**旁路监听**模式——不修改 Ambari 任何代码，不依赖 Ambari 任何插件接口，仅通过以下两条路径完成审计：

```
Ambari 写审计日志  →  ACAA 监听  →  调用 Ambari REST API 反查配置详情
                                  →  计算差异  →  写入结构化 JSON
                                                →  Alloy 采集  →  Loki
```

选择此方案的关键原因：
- Ambari 审计日志（`ambari-audit.log`）在每次配置变更时**必然落盘**，可靠性等同于 Ambari 本身
- 通过版本号反查 REST API，避免直接解析数据库，不依赖 Ambari 内部实现细节
- 进程独立运行，挂掉不影响集群，重启自动恢复（仅丢失停机期间事件）

### 2.2 整体架构

```
┌─────────────────────────────────────────────────────┐
│                   Ambari Server 宿主机                │
│                                                     │
│  ┌──────────────┐    tail -f    ┌────────────────┐  │
│  │ ambari-audit │ ────────────▶ │   LogWatcher   │  │
│  │    .log      │               └───────┬────────┘  │
│  └──────────────┘                       │ 解析出     │
│                                         ▼ 变更事件   │
│                                ┌────────────────┐   │
│                                │  EventParser   │   │
│                                │  (正则提取)    │   │
│                                └───────┬────────┘   │
│                                        │             │
│                              ┌─────────▼──────────┐ │
│                              │   Worker Pool (x4) │ │
│                              │                    │ │
│  ┌──────────────┐  REST API  │  ┌──────────────┐ │ │
│  │ Ambari REST  │◀───────────┼──│ AmbariClient │ │ │
│  │     API      │            │  └──────┬───────┘ │ │
│  └──────────────┘            │         │         │ │
│                              │  ┌──────▼───────┐ │ │
│                              │  │DiffCalculator│ │ │
│                              │  └──────┬───────┘ │ │
│                              └─────────┼──────────┘ │
│                                        │             │
│  ┌──────────────┐   JSON Lines  ┌──────▼──────────┐ │
│  │ audit-diff   │ ◀─────────────│   JSONWriter    │ │
│  │   .json      │               └─────────────────┘ │
│  └──────┬───────┘                                   │
│         │                                           │
│  ┌──────▼───────┐                                   │
│  │ Grafana Alloy│                                   │
│  └──────┬───────┘                                   │
└─────────┼───────────────────────────────────────────┘
          │ HTTP Push
          ▼
    ┌─────────────┐     ┌──────────────┐
    │    Loki     │────▶│   Foxeye     │
    │ (日志存储)  │     │  (告警平台)  │
    └─────────────┘     └──────────────┘
```

### 2.3 处理流程

每次 Ambari 配置变更，ACAA 按以下 7 步处理：

```
Step 1  LogWatcher 捕获含 "Configuration change" 的新日志行
Step 2  EventParser 用正则提取：操作者、IP、新版本号、版本备注
Step 3  AmbariClient 通过版本号反查：定位到哪个服务（HDFS/YARN/...）
Step 4  AmbariClient 拉取新版本完整配置（所有 config type 的 key-value）
Step 5  AmbariClient 拉取前一个版本完整配置
Step 6  DiffCalculator 逐字段对比，标记 ADDED / MODIFIED / DELETED
Step 7  JSONWriter 将结构化记录以 JSON Lines 追加写入输出文件
```

### 2.4 输出数据格式

每条变更记录是一行 JSON，示例如下：

```json
{
  "timestamp": "2026-03-09T17:55:50.652+0800",
  "level": "WARN",
  "event_type": "ambari_config_change",
  "operator": "admin",
  "cluster": "h3-yz",
  "service": "YARN",
  "config_group": "Default",
  "config_type": "yarn-site",
  "version": "V106 -> V107",
  "version_note": "调整 NM 堆内存为 8g",
  "diff_summary": "[MODIFIED] yarn.nodemanager.resource.memory-mb: 4096 -> 8192\n[MODIFIED] yarn.nodemanager.vmem-check-enabled: true -> false"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `operator` | Ambari 操作者用户名 |
| `service` | 变更影响的服务（HDFS/YARN/HIVE 等） |
| `config_group` | Ambari 配置组（Default 或自定义组名） |
| `config_type` | 具体配置文件类型（如 yarn-site、hdfs-site） |
| `version` | 版本号变化（旧→新） |
| `version_note` | 操作者填写的变更说明（如有） |
| `diff_summary` | 逐字段差异，含 ADDED/MODIFIED/DELETED 三类 |

### 2.5 关键设计决策

**并发处理**：Worker Pool 4 个 Goroutine 并发处理变更事件，防止 API 查询阻塞后续事件。队列深度 100，可缓冲突发变更。

**前一版本查询**：Ambari 同一服务的不同 ConfigGroup（如 Default 和 hs1）版本号会交叉编号，前一版本查询**必须过滤 group_id**，否则会跨组对比，产生错误的差异结果。

**文件监听**：使用 `tail` 库的 `ReOpen` 模式，自动处理日志轮转；`SeekEnd` 从文件末尾开始，避免启动时重放历史日志。

**输出持久化**：每条记录写入后执行 `fsync`，确保 Grafana Alloy 能立即感知文件变化。

**API 重试**：指数退避策略（1s → 2s → 4s，最多 3 次），应对 Ambari 瞬时不可用。

---

## 三、部署信息

### 3.1 部署节点

ACAA 跟随 Ambari Server 部署，当前已部署于以下三台主机：

| 主机名                           | 所属集群   | 说明               |
| ----------------------------- | ------ | ---------------- |
| `dmc014011.venus.sohurdc.com` | H3离线集群 | Ambari Server 节点 |
| `dnn130160.venus.sohurdc.com` | H3冷存集群 | Ambari Server 节点 |
| `rtrm1.venus.sohurdc.com`     | H3实时集群 | Ambari Server 节点 |

每台主机独立部署 ACAA + Grafana Alloy，各自监听本机的 Ambari 审计日志并上报至统一 Loki。

### 3.2 进程与文件布局

```
/usr/local/bin/acaa               # 可执行二进制
/etc/acaa/config.yaml             # 运行配置
/var/log/acaa/acaa.log            # ACAA 自身运行日志
/var/log/ambari-server/audit-diff.json   # 结构化变更输出（Alloy 采集源）
/etc/systemd/system/acaa.service  # Systemd 服务单元
/etc/alloy/config.alloy           # Grafana Alloy 配置
/etc/systemd/system/alloy.service # Alloy 服务单元
```

### 3.3 资源占用

ACAA 设计为极轻量级后台进程，资源限制通过 Systemd 强制约束：

| 资源 | 上限 | 实际空载占用 |
|------|------|------------|
| CPU | 25%（单核） | < 1% |
| 内存 | 256 MB | ~20 MB |
| 磁盘写入 | 取决于变更频率 | 正常运维 < 1 MB/天 |

### 3.4 配置文件（各集群按实际值替换）

```yaml
ambari:
  base_url: "http://<ambari-server-host>:8080"
  username: "admin"
  password: "${AMBARI_PASSWORD}"   # 通过环境变量注入，不写入文件
  cluster: ""                      # 留空则自动检测集群名
  timeout: 30s
  retry:
    max_attempts: 3
    initial_backoff: 1s
    max_backoff: 10s

log_watcher:
  input_path: "/var/log/ambari-server/ambari-audit.log"
  poll_interval: 100ms

output:
  path: "/var/log/ambari-server/audit-diff.json"
  max_size_mb: 100

worker:
  pool_size: 4
  queue_size: 100

logging:
  level: "info"
  path: "/var/log/acaa/acaa.log"
```

### 3.5 Systemd 服务管理

```bash
# 查看运行状态
systemctl status acaa
systemctl status alloy

# 查看实时日志
journalctl -u acaa -f
tail -f /var/log/acaa/acaa.log

# 重启服务
systemctl restart acaa

# 查看最新变更记录
tail -20 /var/log/ambari-server/audit-diff.json | python3 -m json.tool
```

### 3.6 部署步骤（新集群扩展）

在新的 Ambari Server 主机上部署，执行以下步骤：

```bash
# Step 1：编译二进制（在开发机执行，目标架构 linux/amd64）
cd /path/to/acaa
GOOS=linux GOARCH=amd64 go build -o acaa ./cmd/acaa

# Step 2：拷贝到目标主机
scp acaa <ambari-host>:/tmp/
scp scripts/install-acaa.sh <ambari-host>:/tmp/
scp scripts/install-alloy-ambari.sh <ambari-host>:/tmp/

# Step 3：在目标主机执行安装脚本
ssh <ambari-host>
export AMBARI_PASSWORD="<实际密码>"
bash /tmp/install-acaa.sh
bash /tmp/install-alloy-ambari.sh

# Step 4：验证
systemctl status acaa alloy
tail -f /var/log/ambari-server/audit-diff.json
```

---

## 四、数据链路与可观测性

### 4.1 端到端数据链路

```
Ambari 配置变更操作
    ↓ (Ambari 写审计日志，~100ms 内)
ambari-audit.log 新增一行
    ↓ (ACAA LogWatcher poll 间隔 ≤100ms)
ACAA 解析 + API 查询 + 差异计算 (~2-5s，含 API 调用)
    ↓
audit-diff.json 追加一条 JSON Lines（fsync 落盘）
    ↓ (Alloy 文件监听，近实时)
Loki 日志平台（可查询、可告警）
    ↓ (Foxeye 告警规则触发)
告警通知（钉钉 / 邮件 / 飞书）
```

**端到端延迟**：正常情况下配置变更到告警触发约 **10~30 秒**。

### 4.2 Loki 标签体系

Alloy 采集后，每条日志附带以下 Loki Label，支持高效过滤：

| Label | 值来源 | 示例 |
|-------|--------|------|
| `job` | 静态 | `ambari-audit-diff` |
| `host` | 主机名 | `dmc014011` |
| `cluster` | JSON 字段 | `h3-yz` |
| `service` | JSON 字段 | `YARN` |
| `operator` | JSON 字段 | `admin` |
| `config_type` | JSON 字段 | `yarn-site` |

### 4.3 典型 Loki 查询

```logql
# 查询所有集群今天的配置变更
{job="ambari-audit-diff"} | json | __error__="" | line_format "{{.timestamp}} [{{.cluster}}] {{.operator}} 修改了 {{.service}}/{{.config_type}} {{.diff_summary}}"

# 查询 YARN 相关变更
{job="ambari-audit-diff", service="YARN"}

# 查询某操作者的操作记录
{job="ambari-audit-diff"} | json | operator="admin"

# 查询涉及敏感配置的变更
{job="ambari-audit-diff"} |= "password"
```

---

## 五、告警规则

基于 Foxeye（Nightingale）+ Loki 数据源，建议配置以下四级告警：

| 告警名称          | 级别            | Loki 查询条件                                      |
| ------------- | ------------- | ---------------------------------------------- |
| Ambari 配置变更通知 | P3 (Info)     | 任意变更事件                                         |
| 核心服务配置变更      | P2 (Warning)  | service 匹配 HDFS\|YARN\|HIVE\|KAFKA             |
| 非工作时间变更       | P1 (Critical) | 22:00–08:00 时间段内变更                             |
| 敏感配置变更        | P1 (Critical) | diff_summary 含 password\|kerberos\|ssl\|secret |

---

## 六、项目信息

| 项目   | 信息                                                     |
| ---- | ------------------------------------------------------ |
| 代码仓库 | https://code.sohuno.com/haopengli/acaa                 |
| 开发语言 | Go 1.21                                                |
| 核心依赖 | `github.com/nxadm/tail`（文件监听）、`gopkg.in/yaml.v3`（配置解析） |
| 代码规模 | ~1,100 行（不含测试）                                         |
| 测试覆盖 | 事件解析模块单元测试（3 个 case）                                   |
| 负责人  | 搜狐 RDC 大数据集群 SRE                                       |

### 已部署集群状态

| 集群 | 主机 | ACAA | Alloy | 接入 Loki |
|------|------|------|-------|----------|
| dmc | dmc014011.venus.sohurdc.com | ✅ | ✅ | ✅ |
| dnn | dnn130160.venus.sohurdc.com | ✅ | ✅ | ✅ |
| rt  | rtrm1.venus.sohurdc.com | ✅ | ✅ | ✅ |

---

## 七、FAQ

**Q：ACAA 重启后，停机期间的变更会丢失吗？**
A：是的，ACAA 从文件末尾开始监听，停机期间的审计日志行不会补处理。Ambari 审计日志本身仍完整保留，如需补录可临时调整 `SeekEnd` 为 `SeekStart` 重放。

**Q：多个 Ambari Server（HA 模式）如何处理？**
A：每台 Ambari Server 宿主机单独部署一个 ACAA 实例，各自监听本机日志，通过 `host` Label 在 Loki 中区分来源。

**Q：Ambari 密码轮换后需要做什么？**
A：修改 `/etc/acaa/config.yaml` 中的密码（或更新环境变量 `AMBARI_PASSWORD`），执行 `systemctl restart acaa` 即可。

**Q：audit-diff.json 文件会不会无限增长？**
A：配置了 `max_size_mb: 100` 上限。同时 Alloy 采集后数据已入 Loki，本地文件可以定期清理或配合 logrotate 轮转。
