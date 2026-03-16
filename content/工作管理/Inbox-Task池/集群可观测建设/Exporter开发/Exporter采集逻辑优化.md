---
type: task
status: done
priority: P0
deadline: 2026-03-13
domain: 集群可观测建设
lifecycle: engineering
progress: "100"
completed_date: 2026-03-12
started_date: 2026-03-12
---

## 🎯 目标与验收标准
- [x] 优化Exporter采集逻辑，避免集中采集时单点故障影响其他正常节点采集。

---

## ✅ 变更总结

**核心问题**：原有实现中，`scrapeOne` 直接透传全局 `ctx` 给每个 HS2 节点，若某节点假死（HTTP 请求挂起），会占用 goroutine 直到全局超时，导致其他节点也被阻塞。

**解决方案**：为每个节点独立创建 20s 的 `context.WithTimeout`，隔离单节点超时影响。

### 关键改动（`internal/scraper/scraper.go`）

```go
const perHostTimeout = 20 * time.Second

func (s *Scraper) scrapeOne(ctx context.Context, host string) ScrapeResult {
    hostCtx, cancel := context.WithTimeout(ctx, perHostTimeout)
    defer cancel()

    result := s.doScrape(hostCtx, host, s.httpClient)

    if hostCtx.Err() == context.DeadlineExceeded {
        result.TimedOut = true
        result.Reachable = false
    }
    return result
}
```

同时修复了 `doScrape` 中 stacks 请求使用 `http.NewRequest` 而非 `http.NewRequestWithContext` 的问题，确保超时能真正传播到 HTTP 层。

### `is_running` 指标语义扩展（`internal/collector/collector.go`）

| 值 | 含义 |
|---|---|
| `1` | 节点正常，采集成功 |
| `0` | 节点不可达（连接拒绝/DNS 失败等） |
| `2` | 采集超时（节点假死，HTTP 挂起超过 20s） |

超时时 collector 同时打印 Warn 日志，便于排查。

### `ScrapeResult` 新增字段

```go
type ScrapeResult struct {
    Reachable bool
    TimedOut  bool   // 新增：区分"不可达"与"假死超时"
    Error     error
}
```

## ⚙️ 架构影响

无架构变更，仅在现有 `scrapeOne` 调用链内增加 per-host context 隔离，不影响并发模型和指标命名。

## 🐛 踩坑日志 (Troubleshooting)

- `doScrape` 内部分请求（stacks）使用了 `http.NewRequest` 而不是 `http.NewRequestWithContext`，导致即使上层 context 超时，该请求也不会被取消。已同步修复为 `http.NewRequestWithContext`。
