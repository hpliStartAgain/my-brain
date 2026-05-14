---
type: task
status: doing
priority: P0
deadline: 2026-06-18
okr: 2026-H1-集群可观测建设OKR
okr_kr: KR2
note: 已纳入 [[Alloy全集群部署推广]] 统一追踪
domain: 集群可观测建设
lifecycle: engineering
progress: "20"
completed_date:
started_date: 2026-04-21
---

## 🎯 目标与验收标准

将 CVM 集群和中间件集群的系统/服务日志接入 Loki，实现统一日志检索。4.30 前完全接入。

- [ ] **CVM 集群**：Alloy/Promtail 部署覆盖，系统日志（`/var/log/messages`）接入 Loki
- [ ] **中间件集群**（Kafka / Redis / MySQL 等节点）：服务日志接入 Loki
- [ ] Loki 中可通过 `cluster` / `service` label 过滤对应日志流
- [ ] Grafana 验证：能正常查询两类集群的日志

## ⚙️ 接入方案

使用 Alloy（Salt 批量部署），参考 [[Alloy阶段一：全集群系统日志上线]] 的部署流水线。

```
label 约定：
  cluster = cvm / middleware
  service = kafka / redis / mysql / ...
  host    = <hostname>
```

## 📝 接入追踪

| 集群 | 节点数 | 接入状态 | 备注 |
|------|--------|----------|------|
| CVM 集群 | - | 待推进 | |
| Kafka | - | 待推进 | |
| Redis | - | 待推进 | |
| MySQL | - | 待推进 | |

## 🐛 踩坑日志 (Troubleshooting)
