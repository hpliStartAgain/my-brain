---
type: task
status: todo
priority: P1
deadline: 2026-06-18
okr: 2026-H1-告警迁移OKR
okr_kr: KR2
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date:
tags: [告警迁移, Exporter, 指标缺口]
depends_on: [Zabbix规则迁移状态梳理与分类, 指标类告警迁移执行]
---

# Exporter 建设需求汇总（派生自指标缺口）

## 目标

从 [[Zabbix规则迁移状态梳理与分类]] 中提取「阻塞-缺Exporter」的指标类告警规则，汇总缺失指标清单，按指标来源/组件分组，派生出 Exporter 建设或扩展任务。

## 需求来源

- Zabbix 指标类告警规则的 item key → 对应 Prometheus 指标是否存在
- Foxeye 指标元数据库（`metric_definitions`）查询结果
- VictoriaMetrics `api/v1/label/__name__/values` 动态查询

## 产出

按以下模板输出每个缺失指标的需求：

| Zabbix Item Key | 期望的 Prometheus 指标 | 数据来源 | Exporter 类型 | 优先级 |
|---|---|---|---|---|
| `kafka.server.bytesin` | `kafka_server_bytesin_total` | Kafka JMX | 已有 Exporter，待优化 | P1 |
| `proc.num[hs2]` | `procstat_num_procs{name="hs2"}` | Categraf procstat | Categraf 铺开 | P0 |
| ... | ... | ... | ... | ... |

### 预期派生的子任务

- [ ] 如需新建 Exporter（如 smartctl-exporter），在 `4-硬件类告警迁移/` 下创建对应任务
- [ ] 如需扩展现有 Exporter 采集项（如 Hadoop Exporter 新增指标），在原 Exporter 项目中记录
- [ ] 与 [[Foxeye指标元数据能力建设评估]] 联动，确保新增指标注册到 `metric_definitions`

## 验收标准

- 所有「阻塞-缺Exporter」规则数与派生的 Exporter 建设任务一一对应
- 各 Exporter 建设任务有明确的 DDL 和优先级
