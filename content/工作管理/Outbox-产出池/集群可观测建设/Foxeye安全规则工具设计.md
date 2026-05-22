# Foxeye 安全规则创建 / 更新工具设计

> 生成时间：2026-05-21  
> 目标：替代高风险 YAML 批量导入，形成可审计、可回滚、可人工确认的单条规则创建 / 更新流程。

## 结论

可以尝试，但不能沿用当前 `opencli foxeye create-rule` 的实现直接写生产。

当前 `create-rule` 的问题是：它手工拼 payload，而不是从现存规则继承模板；默认 `disabled: 0` 会直接启用；没有继承 `notify_rule_ids`、通知版本、启用时间窗口、`extra_config`、`rule_config.keys`、恢复表达式等字段；也没有 dry-run、diff、回读校验和单条确认。

推荐新增一组安全命令：

| 命令 | 权限 | 作用 |
|---|---|---|
| `foxeye rule-template` | read | 读取现有规则，输出可作为模板的关键字段 |
| `foxeye plan-rule` | read/local | 基于模板生成待创建/待更新 payload，不写 Foxeye |
| `foxeye validate-rule-plan` | local | 校验规则名称、表达式、note 标签、数据源、通知策略、危险字段 |
| `foxeye apply-rule-plan` | write | 人工确认后单条写入，并立即回读 diff |

## 安全原则

1. **模板继承**
   - 新建规则必须指定 `--template-id`。
   - 工具先读取模板规则 raw JSON。
   - 继承模板中的非业务字段：`group_id`、`cate`、`datasource_ids`、`datasource_queries`、`prod`、`notify_rule_ids`、`notify_version`、`enable_*`、`notify_*`、`callbacks`、`extra_config`、`event_relabel_config`。

2. **只允许改白名单字段**
   - 新建：允许改 `name`、`note`、`rule_config.queries[*].prom_ql`、`rule_config.queries[*].severity`、`prom_for_duration`、`prom_eval_interval`、`append_tags`、`annotations`、`runbook_url`。
   - 更新：同上，但必须保留 `id`、`group_id`、`cate`、`datasource_ids`、`notify_rule_ids`、`create_at`、`create_by`。
   - 禁止默认改 `disabled`。如果要启用/禁用，必须显式 `--change-enabled`。

3. **默认 dry-run**
   - `plan-rule` 只输出 JSON/YAML/Markdown diff。
   - 没有 `--apply` 或专门 `apply-rule-plan` 时绝不写 Foxeye。

4. **单条写入**
   - 不支持批量 apply。
   - 每次只允许一个 plan 文件。
   - 写入前展示 plan hash，执行时要求传 `--confirm-hash`。

5. **写后回读**
   - 创建后通过返回 ID 再 `GET /api/n9e/alert-rule/{id}`。
   - 更新后同样回读原 ID。
   - 对比目标字段是否一致，输出 `verified=true/false`。

## 字段规范

### 规则名称

建议统一为：

```text
<metric_or_scene>【<服务/组件>】【<告警语义>】
```

示例：

```text
hadoop_yarn_subqueue_used_capacity【YARN】【子队列资源使用率超过95%】
Zookeeper: znode_count > 200000
hiveserver发现msck repair table操作
```

校验规则：

- 必须非空。
- 长度建议 <= 120。
- 禁止包含 `测试`、`test`、`临时`，除非显式 `--allow-test-name`。
- 若更新已有规则，不允许无意义改名。

### 表达式

校验规则：

- Prometheus 规则要求表达式非空，并写入 `rule_config.queries[0].prom_ql`，不是顶层 `prom_ql`。
- Loki 规则 `cate=loki` 时必须继承 Loki 模板规则，避免用 Prometheus payload 创建。
- 禁止单引号 label matcher，例如 `ha_status='active'`；应为 `ha_status="active"`。
- `count_over_time` / `rate` / `increase` 需要显式窗口。
- `sum by(...)` 后的 labels 必须能支撑 note 模板中的 `$labels.*`。

### 备注 note

校验规则：

- note 中出现的 `{{$labels.xxx}}` / `{{ $labels.xxx }}` 必须能从表达式的 label 维度推断或明确标注为原始 stream label。
- 聚合后如果没有 `host` / `instance`，note 不能引用 host。
- 必须包含当前值 `{{$value}}`，日志类可例外，但需包含核心标签。

### 通知与启用

校验规则：

- 新规则必须继承模板 `notify_rule_ids`，不能默认为空。
- 新规则默认建议 `disabled=1` 或者由 Foxeye UI 创建后先不启用。如果 API 不支持禁用创建，则工具必须在输出中标红提示“创建即启用”。
- `prom_for_duration` 必须显式设置；不允许隐式默认为 0，除非规则清单中明确要求立即触发。

## 当前 opencli 状态

现有命令：

- `foxeye get-rule-raw`：可读原始规则，适合作模板输入。
- `foxeye list-rules`：可读业务组规则。
- `foxeye create-rule`：有写能力，但不安全，不建议直接用于生产。

当前本机 opencli 状态问题：

- `opencli doctor` 偶尔显示 OK。
- 但 `opencli foxeye get-rule-raw` 多次报 `BROWSER_CONNECT / Failed to start opencli daemon`。
- 不能在该状态下进行生产写试验。

## 建议试验顺序

1. 先实现 `plan-rule`，只在本地生成 payload 和 diff。
2. 用已有规则 `108`、`130426`、`2757366` 的 raw JSON 做离线模板测试。
3. 等 opencli daemon 稳定后，只读拉取一条模板规则，验证 plan 与模板继承字段一致。
4. 选择低风险业务组创建一条**禁用**测试规则；如果 API 不支持禁用创建，则不走自动创建。
5. 写后立即回读，确认：
   - `group_id`
   - `cate`
   - `datasource_ids`
   - `notify_rule_ids`
   - `rule_config.queries[0].prom_ql`
   - `prom_for_duration`
   - `disabled`
6. 验证通过后再考虑支持 update。

## update-rule 需要额外摸索

现有 adapter 没有 update 命令。更新接口不能猜，需要通过浏览器 network 捕获 Foxeye UI 保存规则时的请求：

- 方法可能是 `PUT` 或 `POST`。
- endpoint 可能带 `busi-group/{gid}` 和 `alert-rule/{id}`。
- payload 是否要求数组、是否要求完整对象，需要实际抓包确认。

在抓包确认前，不实现生产 update，只实现 `update-plan`。
