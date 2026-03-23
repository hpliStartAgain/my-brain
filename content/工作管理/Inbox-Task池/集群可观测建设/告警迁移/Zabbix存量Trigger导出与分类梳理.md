---
type: task
status: doing
priority: P0
deadline: 2026-03-28
domain: 集群可观测建设
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-03-23
---

## 🎯 目标与验收标准

- [ ] 通过 Zabbix JSON-RPC API 导出大数据集群所有 Host Group 下的完整 Trigger 清单（字段：trigger名称、表达式、优先级、状态、最后触发时间、所属主机组）
- [ ] 按**优先级**（P0/P1/P2/P3）×**类型**（阈值型/状态型/复合型/无主告警）完成四象限分类，输出 CSV 分类清单
- [ ] 识别并标注**僵尸告警**候选列表（`lastchange = 0` 或近 90 天未触发），作为迁移时直接清理的依据
- [ ] 最终产出：分类清单文档可直接作为告警迁移系统 `/api/rules/import` 批量导入端点的结构化输入

## ⚙️ 参考执行路径

### Step 1：API 批量导出

```bash
# 使用 Zabbix JSON-RPC API 导出目标 HostGroup 的所有 Trigger
curl -s -X POST http://<ZABBIX_HOST>/api_jsonrpc.php \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "method": "trigger.get",
    "params": {
      "groupids": ["<大数据集群HostGroupID>"],
      "output": ["triggerid","description","expression","priority","status","lastchange"],
      "expandExpression": true,
      "limit": 2000
    },
    "auth": "<SESSION_TOKEN>",
    "id": 1
  }' | jq '.' > zabbix_triggers_raw.json
```

### Step 2：分类脚本

按以下规则分类：
- `priority 5`（Disaster）→ P0
- `priority 4`（High）→ P1
- `priority 3`（Average）→ P2
- `priority 0/1/2`（Not classified/Info/Warning）→ P3
- `lastchange = 0` 或 `lastchange < now() - 90d` → 僵尸告警候选

### Step 3：产出清单格式

| trigger_id | 名称 | 表达式摘要 | 类型 | 优先级 | 最后触发 | 僵尸标记 | 迁移建议 |
|---|---|---|---|---|---|---|---|

### Step 4：输入告警迁移系统

将分类清单中 P0/P1 非僵尸 Trigger 作为第一批，整理为系统 `/api/rules/import` 所需 JSON 格式，启动迁移流程。

## 📝 实施记录

（记录实际导出数量、各分类数量、僵尸告警数量）
