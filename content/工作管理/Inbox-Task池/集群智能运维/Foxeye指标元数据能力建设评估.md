---
type: task
status: doing
priority: P1
deadline: 2026-05-31
domain: 集群智能运维
lifecycle: research
progress: "30"
completed_date:
started_date: 2026-04-21
---

## 🎯 目标与验收标准

推动 AiOps 平台去有状态化，将平台内部维护的三类外部数据依赖迁移到各自的权威数据源，降低维护成本、提升数据实时性。

**三类可外部化依赖：**

- [x] **指标元数据**（`metric_definitions` + `MetricSyncJob`）→ Foxeye 提供查询接口
- [ ] **Foxeye 告警事件**（`EventPollJob` Foxeye 部分 + `alert_events` Foxeye 来源）→ Foxeye 提供时间范围查询接口  
- [ ] **SSH 主机清单**（`ssh_hosts` 表手动维护）→ SCMDB 落地后自动同步

**验收标准（指标元数据部分为 P0）：**
- [ ] Foxeye 团队确认方案并提供接口测试环境
- [ ] `search_metrics` Tool 改为调用 Foxeye API，双路对比验证覆盖率 ≥ 99%
- [ ] `metric_definitions` 表从 Doris 删除，`MetricSyncJob` / `FoxeyeSyncHandler` 代码清除

## 📄 方案设计文档

[[Foxeye指标元数据管理能力建设提案]]

（含：现状采集链路、三类依赖分析、接口设计建议、方案对比、必要性论证、推进步骤）

## 📝 实施记录

- 2026-04-21：完成现状分析，识别三类有状态依赖，输出方案设计文档，待与 Foxeye 团队排期对齐

## 🐛 踩坑日志
