---
type: task
status: done
priority: P1
deadline: 2026-03-25
domain: 集群可观测建设
lifecycle: engineering
progress: "100"
completed_date: 2026-03-26
started_date: 2026-03-25
---

## 🎯 目标与验收标准

### 本周目标（3.25）
- [x] 编译新版本二进制并部署到 yz-100-109 ✅ 2026-03-26
- [x] 观察 KDC 日志，确认单次 scrape 的 TGS_REQ 数量从 1300+ 降至 ≤20（首次冷启动除外） ✅ 2026-03-26
- [x] 确认 SPNEGO 认证成功率：之前失败的 946 条 `HTTP/IP` 请求在修复后变为 `HTTP/hostname` 并成功 ✅ 2026-03-26

### 整体验收标准
- [x] 连续运行 2 个 scrape 周期（≥2min），KDC TGS_REQ 无大规模集中爆发 ✅ 2026-03-26
- [x] DataNode / NodeManager 指标采集成功率 ≥ 95%（与修复前持平或更高） ✅ 2026-03-26
- [x] 无新增 Kerberos 相关报错日志 ✅ 2026-03-26

---

## 背景

2026-03-20 NameNode 崩溃复盘确认，yz-100-109 上的 hadoop-exporter 每次 scrape 向 KDC 集中发出 **1309 条请求**（正常背景流量 ~24条/秒 的 54 倍），是导致 KDC UDP recv buffer 溢出、NameNode AS_REQ 被内核丢弃的直接诱因之一。

本次共三处修改（均已在代码层完成，待上线验证）：

### 修改 1：并发限速（`scraper.go`）

新增 channel 信号量，默认最大并发 20：

```go
// Scrape() 内
var sem chan struct{}
if s.maxConcurrency > 0 {
    sem = make(chan struct{}, s.maxConcurrency)
}
// goroutine 内
if sem != nil {
    sem <- struct{}{}
    defer func() { <-sem }()
}
```

新参数：`-scrape-max-concurrency`（默认 20），环境变量 `SCRAPE_MAX_CONCURRENCY`。

### 修改 2：ticket 缓存复用（`datanode.go` / `nodemanager.go`）

原每次 `Collect()` 新建 Scraper → 丢弃 ticket 缓存 → 每 60s 重申请 200+ TGS_REQ。

改为长期持有 Scraper，节点列表变化时调用 `UpdateURLs()` 热更新：

```go
// 首次初始化
if c.scr == nil {
    c.scr = scraper.NewScraperWithFallback(urls, c.useKerberos, true)
    c.scr.SetMaxConcurrency(c.maxConcurrency)
} else {
    c.scr.UpdateURLs(urls)  // 复用 krb5Client，保留 ticket 缓存
}
```

**效果**：冷启动时 200+ TGS_REQ，之后每 10h（ticket 过期）才重申请，正常 scrape TGS_REQ ≈ 0。

### 修改 3：SPNEGO SPN IP→hostname 修复（`spnego.go`）

DataNode 以裸 IP 注册时，KDC 报 `Server not found`。在 `RoundTrip` 中加反向 DNS 解析：

```go
host := req.URL.Hostname()
if net.ParseIP(host) != nil {
    if names, err := net.LookupAddr(host); err == nil && len(names) > 0 {
        host = strings.TrimSuffix(names[0], ".")
    }
}
spnStr := fmt.Sprintf("HTTP/%s", host)
```

**根治方案**：在每台 DataNode 的 `hdfs-site.xml` 中显式配置 `dfs.datanode.hostname`，本修改作为兜底。

---

## ⚙️ 参考执行路径

### Step 1：编译

```bash
cd /path/to/hadoop-exporter
make build-linux
# 产物：build/hadoop-exporter-linux-amd64
```

### Step 2：部署

```bash
# 备份旧版本
ssh yz-100-109 "cp /opt/hadoop-exporter/hadoop-exporter /opt/hadoop-exporter/hadoop-exporter.bak"

# 上传新版本
scp build/hadoop-exporter-linux-amd64 yz-100-109:/opt/hadoop-exporter/hadoop-exporter

# 重启服务
ssh yz-100-109 "systemctl restart hadoop-exporter"
```

### Step 3：验证并发限速

```bash
# 在 KDC 上，观察 10 秒内 TGS_REQ 数量
ssh kdc-host "grep TGS_REQ /var/log/krb5kdc.log | grep '10.18.100.109' | tail -50"

# 预期：冷启动后第二次 scrape（约 60s 后）TGS_REQ 数量 ≤ 20（信号量宽度）
# 如需调整并发数：export SCRAPE_MAX_CONCURRENCY=10
```

### Step 4：验证 SPN 修复

```bash
# 查看 exporter 日志，确认不再有 Server not found
ssh yz-100-109 "journalctl -u hadoop-exporter --since '5 minutes ago' | grep -i 'server not found\|kerberos\|SPNEGO'"

# 查看 KDC 日志，确认 HTTP/IP 形式的 LOOKING_UP_SERVER 消失
ssh kdc-host "grep 'LOOKING_UP_SERVER' /var/log/krb5kdc.log | grep '10.18.100.109' | tail -20"
```

### Step 5：验证指标完整性

```bash
# 查询 DataNode 采集成功率
curl -s http://yz-100-109:6688/metrics | grep hadoop_hdfs_datanode_is_running | grep ' 1$' | wc -l
# 与预期节点数对比

# 检查是否有新增 error 指标
curl -s http://yz-100-109:6688/metrics | grep hadoop_hdfs_datanode_is_running | grep ' 0$'
```

---

## 🐛 踩坑日志 (Troubleshooting)

- rDNS 解析依赖 PTR 记录，若部分节点无 PTR 记录，`LookupAddr` 失败后仍用原始 IP，TGS_REQ 会继续失败。此时 fallbackToPlain 会尝试无认证访问，DataNode JMX 端口（50075）通常无需认证，可正常采集。
- ticket 缓存复用要求 Scraper 生命周期与 Collector 一致，若 Collector 被重新注册（prometheus.Unregister + MustRegister），缓存会丢失，触发一次冷启动的 TGS 批量申请，属正常现象。
