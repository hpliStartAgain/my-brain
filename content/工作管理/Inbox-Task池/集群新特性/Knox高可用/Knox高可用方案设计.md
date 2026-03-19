---
type: task
status: done
priority: P1
deadline: 2026-03-20
domain: 集群新特性
lifecycle: engineering
progress: "100"
completed_date: 2026-03-19
started_date: 2026-03-19
---

## 🎯 目标与验收标准
- [x] 设计Knox服务高可用方案

## ⚙️ 方案产出

详细方案见：[[工作管理/Outbox-产出池/集群新特性/Knox高可用/Knox高可用方案设计|Knox高可用方案设计]]（Outbox-产出池/集群新特性/）

**方案摘要**：Knox 为无状态反向代理，水平扩展只需保证主密钥（`data/security/master`）和 keystore 一致。双节点 + SCLB 四层负载均衡（TCP/8443，加权轮询，TCP 健康检查）即可实现高可用。

**拆分子任务**：
- [[Knox二节点部署与配置同步]]（DDL: 3.24）
- [[Knox-SCLB四层实例配置]]（DDL: 3.25）
- [[Knox-HA故障切换验证]]（DDL: 3.26）
- [[Knox-HA上线切换与配置同步]]（DDL: 3.27）

## 🐛 踩坑日志 (Troubleshooting)
-