---
type: task
status: todo
priority: P0
deadline: 2026-05-23
domain: 集群智能运维
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-05-11
tags: [告警迁移, Categraf, 批量部署]
depends_on: Zabbix agent vs Categraf 覆盖度统计
---

# Categraf 全集群铺开

## 目标

基于 [[Zabbix agent vs Categraf 覆盖度统计]] 产出的缺口清单，通过 Salt 流水线批量部署 Categraf，实现全集群节点 Categraf 覆盖。

## 前置

- ✅ Salt 流水线已验证可用（Alloy 部署经验复用）
- ⏳ [[Zabbix agent vs Categraf 覆盖度统计]] 完成，输出缺口清单
- ⏳ Categraf Salt State 模块（需新建或复用现有模块）

## 执行步骤

1. [ ] 编写 Categraf Salt State 模块（参考 Alloy 模块结构）
   - `categraf/init.sls`：安装 Categraf 二进制
   - `categraf/config.sls`：统一配置文件模板
   - `pillar/categraf.sls`：Pillar 分层配置
2. [ ] 按覆盖度统计的缺口清单，分批 Salt apply：
   - 第一批：H3 离线管理节点（小范围验证）
   - 第二批：H3 离线工作节点
   - 第三批：H3 实时/冷存 + H2 冷存
   - 第四批：CVM + 中间件
3. [ ] 每批部署后验证：`pgrep categraf` + 检查 VictoriaMetrics 是否有对应指标上报
4. [ ] 重点关注：Zabbix agent 和 Categraf 共存的节点，确认无端口/资源冲突

## 验收标准

- 全集群节点 Categraf 安装率 100%
- Categraf procstat 指标正常上报 VictoriaMetrics
- exec 插件框架就绪（为配置变更类告警迁移做准备）
