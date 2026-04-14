
> 适用版本：Grafana Alloy v1.3.0 · Categraf · VictoriaMetrics
> 主机：`10.18.136.21`（dnn136021）、`10.18.136.20`（dnn136020）

---

## 背景

KDC（Kerberos Key Distribution Center）没有原生 Prometheus exporter，官方也未提供标准可观测接入方案。本方案通过**曲线救国**的两层拼合实现完整可观测覆盖：

| 层次 | 工具 | 采集内容 |
|------|------|---------|
| 服务层（业务指标） | Grafana Alloy `stage.metrics` | KDC 请求量、成功率、错误类型（log2metrics） |
| 进程层（资源指标） | Categraf `procstat` 插件 | CPU、内存、FD、线程、IO、存活/重启检测 |

日志同步写入 Loki，指标写入 VictoriaMetrics，两路互不干扰。

---

## 架构图

```
/var/log/krb5kdc.log
        │
        ▼
  Alloy loki.source.file
        │
        ▼
  loki.process pipeline
    ├── stage.static_labels  → Loki 标签（cluster/role/instance...）
    ├── stage.regex          → 提取 kdc_op / kdc_result 到 extracted map
    ├── stage.labels         → extracted map → 临时 Loki label
    ├── stage.metrics        → Counter: loki_process_custom_kdc_request_total
    ├── stage.label_drop     → 删除临时 label，不污染 Loki 存储
    └── forward_to loki.write.local_loki  → Loki
        │
        ▼
  prometheus.scrape "self_metrics"   ← 抓 Alloy 自身 127.0.0.1:12346/metrics
        │
        ▼
  prometheus.remote_write → VictoriaMetrics
        │
        ▼
  foxeye.panther.sohurdc.com/insert/0/prometheus/api/v1/write

  另一路：
  Categraf procstat → VictoriaMetrics（进程级资源指标）
```

---

## 一、日志采集与 log2metrics（Alloy）

### 1.1 Pillar 配置

在 `_pillar/install_alloy/host_jobs.sls` 中为两台 KDC 主机添加：

```yaml
alloy:
  # VictoriaMetrics remote_write endpoint（必须填，否则 kdc_metrics 块不生成）
  prom_url: http://foxeye.panther.sohurdc.com/insert/0/prometheus/api/v1/write

  host_jobs:
    10.18.136.21:  # dnn136021.venus.sohurdc.com
      - name: kdc_krb5kdc_svc
        service_name: krb5kdc
        paths:
          - /var/log/krb5kdc.log
        labels:
          cluster: KDC
          role: kdc
          log_type: service
        kdc_metrics: true   # 开关：触发 log2metrics pipeline

    10.18.136.20:  # dnn136020.venus.sohurdc.com
      - name: kdc_krb5kdc_svc
        service_name: krb5kdc
        paths:
          - /var/log/krb5kdc.log
        labels:
          cluster: KDC
          role: kdc
          log_type: service
        kdc_metrics: true
```

> **注意**：`prom_url` 必须在 pillar 中显式配置，否则模板检测到 `prom_url` 为空，`kdc_metrics` 块和 `prometheus.scrape`/`prometheus.remote_write` 均不会渲染，日志仍正常采集但不产生指标。

### 1.2 生成的指标

指标名：`loki_process_custom_kdc_request_total`

Alloy 自动为 `stage.metrics` 产生的指标加上 `loki_process_custom_` 前缀。

**Label 集合：**

| Label | 来源 | 示例值 |
|-------|------|--------|
| `instance` | `static_labels` | `10.18.136.21` |
| `service_name` | `static_labels` | `krb5kdc` |
| `cluster` | `static_labels` | `KDC` |
| `role` | `static_labels` | `kdc` |
| `log_type` | `static_labels` | `service` |
| `filename` | Alloy 自动注入 | `/var/log/krb5kdc.log` |
| `kdc_op` | `stage.regex` 提取 | `TGS_REQ` / `AS_REQ` |
| `kdc_result` | `stage.regex` 提取 | `ISSUE` / `LOOKING_UP_SERVER` / `PREAUTH_FAILED` / `CLIENT_NOT_FOUND` 等 |

**实际观测到的 kdc_result 类型：**

| `kdc_result` | 含义 |
|-------------|------|
| `ISSUE` | 认证成功，票据签发 |
| `LOOKING_UP_SERVER` | Server 不在 KDB 中（`Server not found`） |
| `PREAUTH_FAILED` | 预认证失败（密码错误等） |
| `CLIENT_NOT_FOUND` | 客户端 principal 不存在 |
| `PROCESS_TGS` | TGS 中间处理状态 |

**验证命令：**

```bash
curl -s http://127.0.0.1:12346/metrics | grep kdc_request_total
```

### 1.3 核心 LogQL 查询

```logql
# 查看 KDC 所有日志
{service_name="krb5kdc", cluster="KDC"}

# 只看认证失败
{service_name="krb5kdc"} |= "PREAUTH_FAILED"

# 只看 Server not found（常见噪音，反映 principal 未注册）
{service_name="krb5kdc"} |= "LOOKING_UP_SERVER"
```

**PromQL 查询（VictoriaMetrics）：**

```promql
# 各类型请求 QPS
rate(loki_process_custom_kdc_request_total{cluster="KDC"}[5m])

# 认证成功率（TGS ISSUE / TGS 总量）
rate(loki_process_custom_kdc_request_total{kdc_op="TGS_REQ", kdc_result="ISSUE"}[5m])
/
rate(loki_process_custom_kdc_request_total{kdc_op="TGS_REQ"}[5m])

# Server not found 占比（噪音监控）
rate(loki_process_custom_kdc_request_total{kdc_result="LOOKING_UP_SERVER"}[5m])
/
rate(loki_process_custom_kdc_request_total[5m])

# 按 instance 对比两台 KDC 负载
sum by (instance, kdc_op, kdc_result) (
  rate(loki_process_custom_kdc_request_total[5m])
)
```

---

## 二、进程资源监控（Categraf procstat）

### 2.1 采集配置

在 Categraf 的 `conf/input.procstat/procstat.toml` 中添加：

```toml
[[instances]]
# 进程过滤：底层调用 pgrep krb5kdc，匹配进程名包含 krb5kdc 的进程
search_exec_substring = "krb5kdc"

# 开启 PID 标签，可以通过 PID 变化检测进程是否发生过崩溃重启
gather_per_pid = true

# 必须显式声明采集项，否则默认只采集进程数量（存活监控），看不到 CPU/内存/FD！
gather_more_metrics = [
    "cpu",
    "mem",
    "fd",
    "threads",
    "io",
    "uptime",
    "limit"
]
```

> ⚠️ **关键踩坑**：`gather_more_metrics` 不填则只有进程数量指标，CPU/内存/FD 全部缺失。这是 procstat 插件最容易踩的坑。

### 2.2 产生的指标（部分）

| 指标名 | 含义 |
|--------|------|
| `procstat_num_threads` | 线程数 |
| `procstat_cpu_usage` | CPU 使用率 |
| `procstat_memory_rss` | 物理内存占用 |
| `procstat_num_fds` | 打开文件描述符数 |
| `procstat_uptime` | 进程运行时长（秒），重置则说明重启 |
| `procstat_lookup_count` | 进程存活数（= 0 则告警） |

### 2.3 存活告警建议

```promql
# 进程消失告警
procstat_lookup_count{search_exec_substring="krb5kdc"} == 0

# 进程重启检测（uptime 突降）
delta(procstat_uptime{search_exec_substring="krb5kdc"}[5m]) < -60
```

---

## 三、踩坑记录

### 坑 1：`stage.regexp` vs `stage.regex`

**现象：** Alloy 启动报 `unrecognized block name "stage.regexp"`，服务 exit 1。

**根因：** Alloy v1.3 的块名是 `stage.regex`，不是 `stage.regexp`（Promtail 习惯用 regexp，Alloy 改名了）。

**修复：** 全部替换为 `stage.regex`。

---

### 坑 2：`stage.regex` 内正则反斜杠双转义

**现象：** 用反引号包裹正则 `` `\): ...` `` 在 Alloy 配置中语法错误，用双引号则 `\d`、`\(` 等转义被吃掉。

**根因：** Alloy River 语法中，反引号字符串（raw string）不支持 `\)` 等转义；双引号字符串需要双写反斜杠。

**修复：** 使用双引号，所有 `\` 改为 `\\`：

```
expression = "\\): (?P<kdc_op>TGS_REQ|AS_REQ) \\([^)]+\\) [\\d.]+: (?P<kdc_result>[A-Z_]+):"
```

---

### 坑 3：`stage.labels` 的 values 值写法

**现象：** 写成 `kdc_op = "kdc_op"` 导致 label 的值是字符串字面量 `"kdc_op"`，而不是从 extracted map 取值。

**根因：** Alloy `stage.labels` 中，values 的 value 为 `""` 或 `null` 才表示从 extracted map 取同名字段；写成非空字符串是字面量。

**修复：**

```
stage.labels {
    values = {
        kdc_op     = "",
        kdc_result = "",
    }
}
```

---

### 坑 4：`metric.counter "name" {}` 语法错误

**现象：** Alloy 报 `block "metric.counter" does not support specifying labels`，服务 exit 1。

**根因：** Alloy v1.3 的 `metric.counter` 不支持在块名后接标签字符串（`"kdc_request_total"`），`name` 必须作为块内字段声明。

**错误写法：**
```
metric.counter "kdc_request_total" {
    description = "..."
}
```

**正确写法：**
```
metric.counter {
    name        = "kdc_request_total"
    description = "..."
    match_all   = true
    action      = "inc"
}
```

---

### 坑 5：`stage.metrics` 不能直接 remote_write，需通过 prometheus.scrape 中转

**现象：** `stage.metrics` 产生的指标只存在于 Alloy 自身的 `/metrics` endpoint，没有直接推送给 VictoriaMetrics 的机制。

**根因：** Alloy 的 `loki.process` pipeline 和 `prometheus.*` 组件是两个独立的数据流，`stage.metrics` 只写入内部 registry，不产生 `prometheus.receiver` 接口。

**解决方案：**
1. 用 `prometheus.scrape` 组件抓自身 `127.0.0.1:12346/metrics`
2. 接 `prometheus.remote_write` 推送到 VictoriaMetrics

```alloy
prometheus.scrape "self_metrics" {
    targets         = [{"__address__" = "127.0.0.1:12346"}]
    forward_to      = [prometheus.remote_write.victoriametrics.receiver]
    scrape_interval = "60s"
    metrics_path    = "/metrics"
}

prometheus.remote_write "victoriametrics" {
    endpoint {
        url = "http://foxeye.panther.sohurdc.com/insert/0/prometheus/api/v1/write"
    }
}
```

> 副作用：这会把 Alloy 自身所有内部指标（组件健康、内存等）也一并推送，数据量可接受，且有利于监控 Alloy 自身运行状态。

---

### 坑 6：`stage.label_drop` 必须在 `stage.metrics` 之后

`kdc_op` 和 `kdc_result` 是通过 `stage.labels` 临时升级为 Loki label 的，目的是让 `stage.metrics` 能按这两个维度分组计数。计数完成后必须用 `stage.label_drop` 删除，否则这两个高基数 label 会写入 Loki，导致存储膨胀。

**顺序必须为：**

```
stage.regex       # 提取到 extracted map
stage.labels      # extracted map → 临时 Loki label
stage.metrics     # 按 label 维度计数
stage.label_drop  # 删除临时 label
forward_to        # 写 Loki（此时无 kdc_op/kdc_result）
```

---

## 四、Salt 部署

```bash
# 部署两台 KDC 主机
salt -L '10.18.136.21,10.18.136.20' state.apply install_alloy saltenv=TEST

# 验证指标生成
# 在 KDC 主机上执行：
curl -s http://127.0.0.1:12346/metrics | grep kdc_request_total

# 验证日志采集
# 在 Grafana Explore 执行：
# {service_name="krb5kdc", cluster="KDC"}
```

---

## 五、后续优化建议

1. **`prom_url` 安全**：当前 VictoriaMetrics 写入端点无鉴权，如后续添加 Basic Auth，在 `prometheus.remote_write` 的 `basic_auth` 块中配置，避免明文写入 pillar。

2. **scrape 范围收窄**：`prometheus.scrape "self_metrics"` 目前会把 Alloy 所有内部指标都推送，数据量约数百条。如需只推 KDC 指标，可在 `prometheus.scrape` 后接 `prometheus.relabel` 过滤，只保留 `loki_process_custom_kdc_*`。

3. **`LOOKING_UP_SERVER` 噪音**：当前占比极高（`365557` vs 总量 `72万+`），说明有大量 principal 未注册。建议在 Grafana 建告警，当该比例超过 60% 时触发。

4. **双机负载对比**：两台 KDC 的 `instance` label 不同，可直接用 PromQL 按 `instance` 分组对比两台负载是否均衡。
