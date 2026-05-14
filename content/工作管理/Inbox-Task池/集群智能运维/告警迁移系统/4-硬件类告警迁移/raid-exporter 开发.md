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
tags: [告警迁移, 硬件类, RAID, Exporter]
---

# raid-exporter 开发

## 背景

Zabbix 中 RAID 卡状态类告警（RAID 级别、磁盘成员状态、rebuild 进度、电池状态）需要 Prometheus 指标替代。不同厂商 RAID 卡命令不同（MegaRAID / HP Smart Array），适配工作量较大。

## 指标需求

| Zabbix 监控项 | 期望 Prometheus 指标 | RAID 工具 |
|---|---|---|
| RAID 虚拟盘状态 | `raid_virtual_drive_state` | `storcli` / `hpssacli` |
| 物理盘成员状态 | `raid_physical_drive_state` | 同上 |
| Rebuild 进度 | `raid_rebuild_progress_percent` | 同上 |
| BBU/缓存电池状态 | `raid_bbu_status` | 同上 |
| 缓存策略 | `raid_cache_policy` | 同上 |

## 技术方案

- 多厂商适配：MegaRAID（`storcli`）为主，HP Smart Array（`hpssacli`/`ssacli`）为补充
- Go 实现，统一指标命名，通过 `--raid.type` 参数切换厂商
- 解析 `storcli /call show all J` JSON 输出

## 执行步骤

1. [ ] 盘点集群 RAID 卡型号分布（MegaRAID / HPE / 其他）
2. [ ] 调研开源方案（如 `prometheus-community/raid-exporter`）
3. [ ] 开发 Go Exporter（优先 MegaRAID，因集群主力为 Dell 服务器）
4. [ ] 在测试节点部署验证
5. [ ] Salt State 模块，按 RAID 卡型号分发

## 验收标准

- 覆盖 MegaRAID 核心指标（虚拟盘/物理盘/BBU）
- 在 ≥ 2 台 MegaRAID 节点验证通过
