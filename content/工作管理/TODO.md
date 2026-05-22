# TODO - Foxeye 安全规则创建/更新工具探索

## 当前任务：更新告警迁移进度概要页

- [x] 读取 `progress_summary.html` 与 `zabbix_close_ledger.html`
- [x] 从 Doris `alert_shadow.alert_events` 获取最新告警聚合数据
- [x] 更新 `zabbix_close_ledger.html` 最新统计
- [x] 更新 `progress_summary.html`，新增“新创建规则”和“待关闭告警”两个部分
- [x] 推送 Confluence：`progress_summary.html` pageId=107717201（v5）
- [x] 如关闭台账同步变化，推送 `zabbix_close_ledger.html` pageId=109248930（v3）

## 当前任务：核查已手工创建 Foxeye 规则并更新迁移文档

- [x] 只读回读 Foxeye 已创建规则核心配置
- [x] 通过 Foxeye datasource proxy 验证 PromQL / LogQL 可执行性
- [x] 输出更新 HTML / Confluence 前的状态摘要供确认
- [ ] 根据确认结果更新本地 HTML
- [ ] 推送对应 Confluence 页面

## 需求理解

- 目标：探索并设计一个比 YAML 批量导入更安全的 Foxeye 告警规则创建/更新工具。
- 约束：不能直接批量写生产；必须先只读摸索、复用现存规则作为模板、生成 dry-run diff，并在人工确认后单条执行。
- 背景风险：曾因直接导入 YAML 破坏 Foxeye 平台校验，因此默认禁止无校验批量导入。

## 设计原则

1. 只读探索优先：读取现有规则、业务组、数据源、接口 payload，不写生产。
2. 模板继承：新规则必须从同业务组、同 cate、同 datasource 的现存规则继承非核心字段。
3. dry-run 强制：写入前输出字段级 diff 和校验结果。
4. 单条写入：禁止批量创建/更新；每条规则单独确认、写后回读校验。
5. 默认不启用：新建规则优先 disabled 或进入双跑/观察流程；如平台不支持禁用创建，则需人工 UI 二次确认。

## 当前进展

- [x] 确认现有 opencli foxeye 只有 `create-rule` 写能力，没有公开 `update-rule`。
- [x] 开始读取本地 adapter 源码。
- [x] 解析 `create-rule` payload 字段和校验缺口。
- [x] 判断是否能新增安全 `plan-rule` / `validate-rule` / `update-rule-dry-run` 命令。
- [x] 输出推荐试验方案。
- [ ] 实现本地 dry-run planner（不写生产）。
- [ ] opencli daemon 稳定后再做只读模板拉取验证。

## 不做

- 不在未经确认时创建、更新、启用、禁用任何生产规则。
- 不恢复 YAML 批量导入路线。
- 不绕过 Foxeye UI/API 校验。
