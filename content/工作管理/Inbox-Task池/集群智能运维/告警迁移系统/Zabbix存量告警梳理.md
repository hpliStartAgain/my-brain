---
type: task
status: doing
priority: P1
deadline: 2026-03-25
domain: 集群日常运维
lifecycle: routine
progress: "30"
started_date: 2026-03-17
completed_date:
---

## 🎯 目标与验收标准
- [ ] 按照模板梳理当前Zabbix系统存在多少告警，包括自动发现

## 📝 实施记录

**2026-03-17**：告警迁移系统 v2 重构完成，`ZabbixFullSyncJob` 通过 templategroup → template → trigger 三层级联自动导入全量 Zabbix Trigger，并按 service/component 分类存入 DB，Rules.vue 提供筛选视图。存量梳理的机制已由该系统覆盖，实际告警清单输出依赖生产 Zabbix 接入（4月前目标，见[[告警智能迁移与双跑验证系统代码开发与上线]]）。

> ⚠️ 注意：更细化的输出需求（CSV 清单、僵尸告警 90天标注）在 [[Zabbix存量Trigger导出与分类梳理]] 中单独跟踪，该任务截止 2026-03-28，需额外实现 CSV export 和僵尸检测逻辑。