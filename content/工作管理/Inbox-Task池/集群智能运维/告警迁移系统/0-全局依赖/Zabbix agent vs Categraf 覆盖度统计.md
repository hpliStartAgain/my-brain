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
tags: [告警迁移, Zabbix, Categraf, 覆盖度]
---

# Zabbix agent vs Categraf 覆盖度统计

## 目标

统计当前集群所有节点上 Zabbix agent 和 Categraf 的部署覆盖情况，明确：
1. 哪些节点只有 Zabbix agent → 需补充 Categraf
2. 哪些节点只有 Categraf → Zabbix agent 可考虑下线
3. 哪些节点两者共存 → 功能对比后可迁移
4. 哪些节点两者都无 → 需全量补齐

## 前置

- 集群节点清单（Ambari hosts 导出）
- Salt minion 列表（`salt '*' test.ping`）
- Zabbix agent 安装清单（Zabbix API host 导出）
- Categraf 安装清单（Salt state apply 记录 / 手动检查）

## 执行步骤

1. [ ] 从 Ambari 导出全集群节点列表（含 hostname + IP）
2. [ ] 从 Zabbix API 导出所有 host 清单，标注已安装 Zabbix agent 的节点
3. [ ] 通过 Salt 或 SSH 批量检查各节点 Categraf 进程状态（`pgrep categraf`）
4. [ ] 生成覆盖度矩阵：

| 节点 | Zabbix agent | Categraf | Zabbix agent 采集项 | Categraf 采集项 | 迁移优先级 |
|---|---|---|---|---|---|

5. [ ] 按集群/服务分组汇总，输出缺口统计

## 验收标准

- 覆盖度矩阵覆盖 H3 离线/H3 实时/H3 冷存/H2 冷存全量节点
- 明确标注"仅 Zabbix agent"节点清单及其采集项列表（作为 Categraf 铺开的目标清单）
- 明确标注"可下线 Zabbix agent"节点清单（两者共存且功能等价）
