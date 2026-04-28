---
type: task
status: doing
priority: P1
deadline: 2026-04-27
domain: 集群日常运维
lifecycle: routine
progress: "70"
completed_date:
started_date: 2026-04-15
---

## 🎯 目标与验收标准
- [x] 开发 Salt 巡检脚本，检查 H3 集群各主机 `/etc/krb5.conf` 是否已切换到 KDC 高可用配置
- [ ] 在 Salt Master 上执行脚本，覆盖 H3 全量 hadoop 节点
- [ ] 输出巡检报告（CSV + Markdown），确认非高可用节点名单
- [ ] 对 non_ha 节点推送正确配置（若有遗漏节点）

## 📝 实施记录

### 脚本开发（已完成）

脚本路径：`/Users/lihaopeng/CascadeProjects/salt-modules/run_once/`

- `krb5_ha_audit.py`：Salt Master 端主程序，通过 `cmd.exec_code_all` 远程执行探针
- `krb5_ha_probe_minion.py`：Minion 端探针，解析 `krb5.conf` 中 `VENUS.SOHURDC.COM` realm 的 kdc 条目数量

**执行示例（H3 集群 hadoop 节点）：**
```bash
/opt/saltstack/salt/bin/python run_once/krb5_ha_audit.py \
  --target 'G@roles:hadoop and G@cluster:h3' \
  --tgt-type compound \
  --timeout 30 \
  --output-dir /tmp/krb5-ha-audit
```

**判断逻辑：**
- `ha`：realm 下 kdc 条目 ≥ 2 → 高可用
- `non_ha`：kdc 条目 = 1 → 非高可用，需修复
- `missing_file` / `unreadable` / `realm_not_found`：异常节点，需人工复核

### 待执行
- [ ] 找合适时间窗口登录 Salt Master 执行巡检
- [ ] 导出报告至 `/tmp/krb5-ha-audit/` 并分析 non_ha 节点