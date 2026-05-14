---
type: task
status: todo
priority: P0
deadline: 2026-06-18
okr: 2026-H1-告警迁移OKR
okr_kr: KR2
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date:
---

## 🎯 目标与验收标准

基于 [[Zabbix规则迁移状态梳理与分类]] 输出的"未匹配-可推送"名单，按服务维度批量生成 Foxeye 规则并完成双跑验证。

- [ ] 按服务维度（HDFS/YARN/HiveServer/Kafka/KDC）逐批生成 Foxeye 规则
- [ ] 规则导入 Foxeye，设置 `active: false` 进入双跑模式
- [ ] 双跑周期内，对比 Zabbix 和 Foxeye 告警触发一致性
- [ ] 双跑通过后，关闭对应 Zabbix Trigger，启用 Foxeye 规则

## ⚙️ 双跑验证标准

| 维度 | 标准 |
|------|------|
| 触发一致性 | 同一事件 Foxeye 与 Zabbix 均触发，或均不触发 |
| 漏报 | Zabbix 触发但 Foxeye 未触发 → 阻塞，需修正 PromQL |
| 误报率 | Foxeye 触发但 Zabbix 未触发次数 ≤ 10% |

## 📝 实施记录

## 🐛 踩坑日志 (Troubleshooting)
