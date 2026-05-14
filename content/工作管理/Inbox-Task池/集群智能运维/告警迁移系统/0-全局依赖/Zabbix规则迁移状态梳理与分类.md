---
type: task
status: doing
priority: P0
deadline: 2026-05-23
okr: 2026-H1-告警迁移OKR
okr_kr: KR1
domain: 集群智能运维
lifecycle: engineering
progress: "30"
completed_date:
started_date: 2026-04-21
---

## 🎯 目标与验收标准

对 Zabbix 存量 545 条告警规则，按 **告警类型（四象限）** 重新分类，同时标注迁移状态，形成「类型 × 状态」二维矩阵，为各类型分批迁移提供数据基础。

### 告警类型四象限

| 类型 | 定义 | 迁移目标 | 外部依赖 |
|---|---|---|---|
| **指标类** | Zabbix item key 对应数值型监控项（CPU/内存/队列/QPS 等） | Foxeye PromQL AlertRule | Exporter 覆盖度 |
| **日志类** | Zabbix log[] item 匹配日志关键字/正则 | Foxeye LogQL AlertRule | Alloy + Loki 覆盖度 |
| **配置变更类** | Zabbix 监控配置文件/关键路径变更（MD5/权限/内容） | Categraf exec 插件 + Foxeye PromQL | Categraf 铺开 + 检测脚本 |
| **硬件类** | 磁盘 SMART / RAID 卡 / IPMI 硬件状态 | smartctl-exporter / raid-exporter | Exporter 自研 |

### 迁移状态维度

| 状态 | 定义 |
|---|---|
| **可迁移** | 外部依赖已满足，可在迁移系统直接转换 |
| **阻塞-缺Exporter** | 指标类：对应 Prometheus 指标不存在，需新建/扩展 Exporter |
| **阻塞-缺采集** | 日志类：Loki 未接入；配置变更类：Categraf 未部署 |
| **阻塞-缺方案** | 硬件类：Exporter 方案未确定/未开发 |
| **已转换** | 已在迁移系统完成 PromQL/LogQL 转换，进入双跑阶段 |
| **disabled_low_risk** | 低风险高频噪音，已在 Zabbix 中禁用（见 [[低风险高频Zabbix噪音告警关闭]]） |

## ⚙️ 输出产物

- [ ] **「类型 × 状态」二维矩阵表**（545 条规则逐条标注类型 + 状态）
- [ ] **按类型汇总统计**：每个类型下可迁移/阻塞/已转换/disabled 的数量
- [ ] **阻塞清单**：
  - 指标类阻塞 → 触发 Exporter 建设需求（输入到 [[1-指标类告警迁移/]]）
  - 日志类阻塞 → 关联 Alloy 部署进度（输入到 [[2-日志类告警迁移/]]）
  - 配置变更类阻塞 → 关联 Categraf 铺开（输入到 [[3-配置变更类告警迁移/]]）
  - 硬件类阻塞 → 触发 smartctl/raid Exporter 自研（输入到 [[4-硬件类告警迁移/]]）
- [ ] **各类型可迁移规则清单** → 作为 [[Foxeye告警规则批量导入与双跑验证]] 的输入

## 📝 实施记录
