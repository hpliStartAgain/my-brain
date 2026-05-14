---
type: task
status: todo
priority: P0
deadline: 2026-06-18
okr: 2026-H1-集群可观测建设OKR
okr_kr: KR1
domain: 集群智能运维
lifecycle: research
progress: "0"
completed_date:
started_date:
tags: [告警迁移, 硬件类, smartctl, Exporter]
---

# smartctl-exporter 开发

## 背景

Zabbix 中磁盘 SMART 类告警（磁盘健康状态、坏道数、温度、寿命）需要 Prometheus 指标替代。需自研或适配 smartctl-exporter。

## 指标需求

| Zabbix 监控项 | 期望 Prometheus 指标 | SMART 属性 |
|---|---|---|
| 磁盘健康状态 | `smartctl_device_smart_status` | SMART overall-health |
| 重映射扇区数 | `smartctl_reallocated_sector_count` | ID 5 |
| 磁盘温度 | `smartctl_temperature_celsius` | ID 194 |
| 待处理扇区 | `smartctl_current_pending_sector` | ID 197 |
| 不可修复扇区 | `smartctl_offline_uncorrectable` | ID 198 |
| SSD 寿命百分比 | `smartctl_percent_lifetime_remain` | ID 231 |

## 技术方案

- 基于 `smartmontools`（`smartctl --json` 输出解析）
- Go 实现（与现有 Hadoop/HBase Exporter 技术栈一致）
- 支持 NVMe SSD（`smartctl -d nvme`）和 SATA/SAS 磁盘

## 执行步骤

1. [ ] 调研开源 smartctl_exporter 方案（如 prometheus-community/smartctl_exporter）
2. [ ] 评估是否直接复用 or 自研轻量版（SRE 场景只需核心 SMART 属性）
3. [ ] 开发 Go Exporter，解析 `smartctl --json` 输出
4. [ ] 在测试节点部署验证，确认指标上报 VictoriaMetrics
5. [ ] Salt State 模块编写，批量部署

## 验收标准

- 覆盖 ≥ 5 个核心 SMART 属性指标
- 在 ≥ 3 台不同类型磁盘（SATA SSD / NVMe / HDD）节点验证通过
- Salt 批量部署成功
