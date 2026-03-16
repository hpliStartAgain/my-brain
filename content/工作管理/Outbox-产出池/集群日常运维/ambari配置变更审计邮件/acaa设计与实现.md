## 1. 项目概述

### 1.1 定位

ACAA 是一个基于 Go 语言的轻量级守护进程，部署于 Ambari Server 宿主机，实时监听审计日志并富化配置变更事件。

### 1.2 核心能力

|能力|描述|
|---|---|
|日志监听|使用 `github.com/nxadm/tail` 实时 tail 审计日志文件|
|事件解析|正则提取 `Configuration change` 事件的元数据|
|配置拉取|调用 Ambari REST API 获取新旧版本配置快照|
|差异计算|内存中对比 map，生成 ADDED/DELETED/MODIFIED 差异|
|结构化输出|以 JSON Lines 格式追加写入，供 Alloy 采集|

### 1.3 部署环境

- **目标主机**: Ambari Server 所在节点 (如 `ht100040.venus.sohurdc.com`)
- **Ambari API**: `http://ht100040.venus.sohurdc.com:8080`
- **输入**: `/var/log/ambari-server/ambari-audit.log`
- **输出**: `/var/log/ambari-server/audit-diff.json`

---

## 2. 架构设计

### 2.1 组件架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        ACAA Daemon                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  LogWatcher │───▶│ EventParser │───▶│  ConfigDiffWorker   │  │
│  │  (tail -f)  │    │  (Regexp)   │    │  (Goroutine Pool)   │  │
│  └─────────────┘    └─────────────┘    └──────────┬──────────┘  │
│                                                   │             │
│                                        ┌──────────▼──────────┐  │
│                                        │   AmbariClient      │  │
│                                        │   (HTTP + Retry)    │  │
│                                        └──────────┬──────────┘  │
│                                                   │             │
│                                        ┌──────────▼──────────┐  │
│                                        │   DiffCalculator    │  │
│                                        │   (Map Compare)     │  │
│                                        └──────────┬──────────┘  │
│                                                   │             │
│                                        ┌──────────▼──────────┐  │
│                                        │   JSONWriter        │  │
│                                        │   (Append + Sync)   │  │
│                                        └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
           │                                        │
           ▼                                        ▼
   ambari-audit.log                         audit-diff.json
   (Input Source)                           (Output Sink)
```

### 2.2 数据流时序

```
[1] LogWatcher: tail -f ambari-audit.log
         │
         ▼ (匹配到 "Configuration change" 行)
[2] EventParser: 正则提取 {User, VersionNumber, VersionNote}
         │
         ▼ (发送到 Worker Channel)
[3] ConfigDiffWorker: goroutine 接收任务
         │
         ├──▶ [4a] AmbariClient: 通过 VersionNumber 反查 Service 名
         │
         ├──▶ [4b] AmbariClient.FetchServiceConfig(service, version)
         │
         ├──▶ [4c] AmbariClient.FetchServiceConfig(service, version-1)
         │
         ▼ (请求顺序执行)
[5] DiffCalculator: 对比所有 ConfigType 的 properties
         │
         ▼
[6] JSONWriter: append EnrichedAuditLog to audit-diff.json
```

---

## 3. 核心数据结构

### 3.1 输出结构 (EnrichedAuditLog)

```go
// EnrichedAuditLog 是写入 JSON 文件供 Alloy 采集的最终结构
type EnrichedAuditLog struct {
    Timestamp   string `json:"timestamp"`    // ISO8601 格式，如 "2024-01-15T10:30:00+08:00"
    Level       string `json:"level"`        // 固定为 "WARN"
    EventType   string `json:"event_type"`   // 固定为 "ambari_config_change"
    Operator    string `json:"operator"`     // 操作者用户名，如 "admin"
    Cluster     string `json:"cluster"`      // 集群名称
    Service     string `json:"service"`      // 服务名，如 "HIVE"
    ConfigType  string `json:"config_type"`  // 配置类型，如 "hive-site"
    Version     string `json:"version"`      // 版本变化，如 "V4 -> V5"
    DiffSummary string `json:"diff_summary"` // 差异详情（多行文本）
}
```

### 3.2 内部事件结构 (ConfigChangeEvent)

```go
// ConfigChangeEvent 从审计日志解析出的原始事件
type ConfigChangeEvent struct {
    RawLine     string    // 原始日志行
    Timestamp   time.Time // 事件时间 (ISO8601: 2026-03-09T17:55:50.652+0800)
    Operator    string    // 操作者 (User字段)
    RemoteIP    string    // 客户端IP
    NewVersion  int       // 新版本号 (从 VersionNumber(V107) 解析)
    VersionNote string    // 版本备注 (VersionNote字段)
}
```

### 3.3 Ambari API 响应结构

```go
// ServiceConfigVersionResponse 映射 service_config_versions API 响应
type ServiceConfigVersionResponse struct {
    Items []ServiceConfigVersion `json:"items"`
}

type ServiceConfigVersion struct {
    ServiceName              string          `json:"service_name"`
    ServiceConfigVersion     int             `json:"service_config_version"`
    ServiceConfigVersionNote string          `json:"service_config_version_note"`
    CreateTime               int64           `json:"createtime"`
    User                     string          `json:"user"`
    ClusterName              string          `json:"cluster_name"`
    Configurations           []Configuration `json:"configurations"`
}

type Configuration struct {
    Type       string            `json:"type"`       // 如 "hive-site"
    Tag        string            `json:"tag"`
    Version    int               `json:"version"`
    Properties map[string]string `json:"properties"` // 配置键值对
}
```

---

## 4. API 交互设计

### 4.1 Ambari REST API 端点

|用途|HTTP Method|URL Pattern|
|---|---|---|
|获取集群列表|GET|`/api/v1/clusters`|
|通过版本号反查服务|GET|`/api/v1/clusters/{cluster}/configurations/service_config_versions?service_config_version={version}`|
|获取服务指定版本配置|GET|`/api/v1/clusters/{cluster}/configurations/service_config_versions?service_name={service}&service_config_version={version}`|

### 4.2 认证方式

- **Basic Auth**: 使用 Ambari 管理员账号
- 配置项: `AMBARI_USERNAME`, `AMBARI_PASSWORD` (环境变量或配置文件)

### 4.3 请求示例

```bash
# 1. 通过版本号 107 反查服务名
curl -u admin:bigdata2025 \
  "http://ht100040.venus.sohurdc.com:8080/api/v1/clusters/h3-yz-test/configurations/service_config_versions?service_config_version=107"
# 返回: service_name=HDFS

# 2. 获取 HDFS 第 107 版的所有配置
curl -u admin:bigdata2025 \
  "http://ht100040.venus.sohurdc.com:8080/api/v1/clusters/h3-yz-test/configurations/service_config_versions?service_name=HDFS&service_config_version=107"
# 返回: configurations[] 包含 core-site, hdfs-site 等所有配置类型及其 properties
```

### 4.4 重试策略

|参数|值|说明|
|---|---|---|
|MaxRetries|3|最大重试次数|
|InitialBackoff|1s|初始退避时间|
|MaxBackoff|10s|最大退避时间|
|BackoffMultiplier|2.0|退避指数因子|

---

## 5. 配置管理

### 5.1 配置文件路径

`/etc/acaa/config.yaml`

### 5.2 配置项定义

```yaml
# ACAA 配置文件示例
ambari:
  base_url: "http://ht100040.venus.sohurdc.com:8080"
  username: "admin"
  password: "admin"          # 生产环境建议使用环境变量 AMBARI_PASSWORD
  cluster: "MyCluster"       # 若为空则自动检测
  timeout: 30s
  retry:
    max_attempts: 3
    initial_backoff: 1s
    max_backoff: 10s

log_watcher:
  input_path: "/var/log/ambari-server/ambari-audit.log"
  poll_interval: 100ms       # 文件轮询间隔

output:
  path: "/var/log/ambari-server/audit-diff.json"
  max_size_mb: 100           # 单文件最大大小 (Alloy 负责 rotation 感知)

worker:
  pool_size: 4               # 并发 Worker 数量
  queue_size: 100            # 任务队列深度

logging:
  level: "info"              # debug, info, warn, error
  path: "/var/log/acaa/acaa.log"
```

### 5.3 环境变量覆盖

|环境变量|作用|优先级|
|---|---|---|
|`AMBARI_PASSWORD`|覆盖配置文件中的密码|最高|
|`ACAA_LOG_LEVEL`|覆盖日志级别|最高|
|`ACAA_CONFIG_PATH`|指定配置文件路径|最高|

---

## 6. 正则解析规则

### 6.1 实际日志行格式

```
2026-03-09T17:55:50.652+0800, User(admin), RemoteIp(10.2.8.69), Operation(Configuration change), RequestType(PUT), url(http://ht100040.venus.sohurdc.com:8080/api/v1/clusters/h3-yz-test), ResultStatus(200 OK), VersionNumber(V107), VersionNote()
```

### 6.2 正则表达式

```go
var configChangeRegex = regexp.MustCompile(
    `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\+\d{4}),\s*` + // 捕获组1: 时间戳 (ISO8601)
    `User\(([^)]+)\),\s*` +                                     // 捕获组2: 用户名
    `RemoteIp\(([^)]+)\),\s*` +                                 // 捕获组3: 客户端IP
    `Operation\(Configuration change\),.*?` +                   // 匹配操作类型 (不捕获)
    `VersionNumber\(V(\d+)\)` +                                 // 捕获组4: 版本号 (纯数字)
    `(?:,\s*VersionNote\(([^)]*)\))?`,                          // 捕获组5: 版本备注 (可选)
)
```

### 6.3 字段提取说明

|捕获组|字段|示例值|
|---|---|---|
|1|Timestamp|`2026-03-09T17:55:50.652+0800`|
|2|User|`admin`|
|3|RemoteIp|`10.2.8.69`|
|4|VersionNumber|`107` (去掉 V 前缀)|
|5|VersionNote|`test for yarn` (可能为空)|

---

## 7. 差异计算算法

### 7.1 伪代码

```go
func ComputeDiff(oldConf, newConf map[string]string) string {
    var lines []string
    allKeys := union(keys(oldConf), keys(newConf))
    sort(allKeys)
    
    for _, key := range allKeys {
        oldVal, inOld := oldConf[key]
        newVal, inNew := newConf[key]
        
        switch {
        case inOld && inNew && oldVal != newVal:
            lines = append(lines, fmt.Sprintf("[MODIFIED] %s: \"%s\" -> \"%s\"", key, oldVal, newVal))
        case !inOld && inNew:
            lines = append(lines, fmt.Sprintf("[ADDED] %s: \"%s\"", key, newVal))
        case inOld && !inNew:
            lines = append(lines, fmt.Sprintf("[DELETED] %s: \"%s\"", key, oldVal))
        }
    }
    return strings.Join(lines, "\n")
}
```

### 7.2 输出示例

```
[MODIFIED] hive.exec.dynamic.partition.mode: "strict" -> "nonstrict"
[ADDED] hive.auto.convert.join.noconditionaltask.size: "268435456"
[DELETED] hive.deprecated.config: "old_value"
```

---

## 8. 错误处理与容错

### 8.1 错误分类

|错误类型|处理策略|
|---|---|
|日志文件不存在|等待文件创建 (tail 支持 `--follow=name`)|
|Ambari API 超时|指数退避重试 (最多 3 次)|
|API 返回 404|记录警告日志，跳过本次事件 (配置可能已被删除)|
|API 认证失败 (401)|记录 ERROR 日志，停止服务并告警|
|输出文件写入失败|重试 3 次后记录 ERROR，事件暂存内存队列|

### 8.2 优雅关闭

- 接收 `SIGTERM`/`SIGINT` 信号
- 停止接收新事件
- 等待队列中任务处理完成 (最长 30s)
- 关闭文件句柄

---

## 9. 日志记录规范

### 9.1 日志级别使用

|级别|场景|
|---|---|
|DEBUG|每行日志解析结果、API 请求/响应详情|
|INFO|服务启动/停止、成功处理事件|
|WARN|API 超时重试、配置版本不存在|
|ERROR|认证失败、文件 IO 错误|

### 9.2 日志格式 (JSON)

```json
{"time":"2024-01-15T10:30:00+08:00","level":"INFO","msg":"config change processed","service":"HIVE","config_type":"hive-site","version":"V4->V5"}
```

---

## 10. 目录结构

```
acaa/
├── cmd/
│   └── acaa/
│       └── main.go              # 入口
├── internal/
│   ├── config/
│   │   └── config.go            # 配置加载
│   ├── watcher/
│   │   └── log_watcher.go       # 日志监听
│   ├── parser/
│   │   └── event_parser.go      # 正则解析
│   ├── client/
│   │   └── ambari_client.go     # Ambari API 客户端
│   ├── differ/
│   │   └── diff_calculator.go   # 差异计算
│   └── writer/
│       └── json_writer.go       # JSON 输出
├── scripts/
│   ├── install-acaa.sh          # ACAA 部署脚本
│   └── install-alloy-ambari.sh  # Alloy (Ambari Audit 版) 部署脚本
├── configs/
│   └── config.example.yaml      # 示例配置
├── docs/
│   └── DESIGN.md                # 本文档
├── go.mod
├── go.sum
└── README.md
```

---

## 11. Alloy 部署脚本 (Ambari Audit 版)

见 `scripts/install-alloy-ambari.sh`，核心配置如下：

```river
local.file_match "ambari_diff_logs" {
    path_targets = [
        {"__path__" = "/var/log/ambari-server/audit-diff.json"},
    ]
}

loki.source.file "ambari_audit" {
    targets    = local.file_match.ambari_diff_logs.targets
    forward_to = [loki.process.ambari_pipeline.receiver]
}

loki.process "ambari_pipeline" {
    stage.json {
        expressions = {
            level      = "level",
            service    = "service",
            operator   = "operator",
            event_type = "event_type",
        }
    }
    stage.labels {
        values = {
            level    = "",
            service  = "",
            operator = "",
        }
    }
    stage.static_labels {
        values = {
            cluster  = "AmbariCluster",
            instance = "__HOSTNAME_PLACEHOLDER__",
            job      = "ambari-config-audit",
        }
    }
    forward_to = [loki.write.local_loki.receiver]
}

loki.write "local_loki" {
    endpoint {
        url       = "http://write.grafana-loki.sohucs.com/loki/api/v1/push"
        tenant_id = "e9e89be363f04160a0e572b08ae0f215"
    }
}
```

---

## 12. 已确认事项

|#|问题|状态|确认值|
|---|---|---|---|
|1|Ambari 管理员账号密码|✅ 已确认|`admin` / `bigdata2025`|
|2|集群名称 (Cluster Name)|✅ 已确认|`h3-yz-test`|
|3|真实日志样本 (确认正则)|✅ 已确认|见 6.1 节|
|4|Loki tenant_id|✅ 复用|`e9e89be363f04160a0e572b08ae0f215`|

---

## 13. 告警配置

详细告警规则配置请参考 [ALERTING.md](https://file+.vscode-resource.vscode-cdn.net/Users/lihaopeng/CascadeProjects/acaa/docs/ALERTING.md)，主要内容：

- **夜莺 + Loki 集成架构**
- **告警规则示例**:
    - 任意配置变更通知 (P3)
    - 核心服务配置变更 (P2)
    - 非工作时间变更 (P1)
    - 敏感配置变更 (P1)
- **常用 LogQL 查询**
