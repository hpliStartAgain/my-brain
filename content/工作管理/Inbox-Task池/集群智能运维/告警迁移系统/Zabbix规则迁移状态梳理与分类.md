---
type: task
status: doing
priority: P0
deadline: 2026-04-30
domain: 集群智能运维
lifecycle: engineering
progress: "30"
completed_date:
started_date: 2026-04-21
---

## 🎯 目标与验收标准

对告警迁移平台中的存量 Zabbix 告警规则进行三分类，为批量推送提供数据基础。

- [ ] **已匹配**：Zabbix Trigger 已在平台完成 Foxeye 规则映射，可直接进入双跑阶段
- [ ] **未匹配-可推送**：尚未映射但指标已在 Prometheus 体系落地，具备转换条件
- [ ] **未匹配-缺指标**：指标尚未被 Exporter 采集，无法转换，记录缺口清单

## ⚙️ 分类维度

按**服务维度**聚合 Trigger（如 HDFS、YARN、HiveServer、Kafka、KDC），输出每个服务的三分类统计。

```
输出产物：
- 分类统计表（服务 × 三分类 × 数量）
- 未匹配-可推送 的规则列表（含目标指标名与 PromQL 草稿）
- 未匹配-缺指标 的规则列表（含缺失指标清单，触发 Exporter 补采）
```

## 📝 实施记录

## 🐛 踩坑日志 (Troubleshooting)
