---
type: task
status: todo
priority: P0
deadline: 2026-05-16
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-05-11
tags: [告警迁移, Zabbix, 降噪, 告警收敛]
---

# 低风险高频 Zabbix 噪音告警关闭

## 背景

Zabbix 存量告警中存在大量高频触发但实际风险低的规则（如 INFO 级别日志匹配、非关键端口探测抖动）。在完成正式迁移前，可**先行关闭**这部分规则，立即降低值班噪音。这是渐进式替代策略，不等全量迁移完成再关 Zabbix。

## 筛选标准

- 过去 7 天触发次数 > 10 次（高频）
- 每次触发后 ≤ 2 分钟内被 ACK 或关闭（低价值）
- 告警级别为 Warning 或 Info（非 Critical）
- 对应场景已有 Foxeye 等效规则覆盖，或无实际业务影响

## 执行步骤

1. [ ] 从 Zabbix API 导出过去 7 天告警事件统计（按 trigger 聚合触发次数 + 平均 ACK 延迟）
2. [ ] 按筛选标准过滤出候选清单，标注关闭理由（已有 Foxeye 覆盖 / 低风险 / 可静默）
3. [ ] 人工复核候选清单，确认无遗漏风险（逐条检查是否有 Critical 升级场景）
4. [ ] 在 Zabbix 中禁用候选 trigger（不删除，保留规则配置以便回滚）
5. [ ] 记录禁用清单到 [[Zabbix规则迁移状态梳理与分类]]，标注 `status: disabled_low_risk`
6. [ ] 观察 1 周：是否有因关闭告警导致的漏报事件
7. [ ] 无异常后，标记为 `status: to_be_migrated_or_deleted`

## 验收标准

- 关闭 ≥ 20 条低风险高频 Zabbix 告警规则
- 关闭后 1 周内零漏报投诉
- 禁用清单完整记录，支持一键回滚（Zabbix API enable）
