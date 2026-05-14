---
type: task
status: todo
priority: P2
deadline: 2026-06-30
domain: 集群智能运维
lifecycle: research
progress: "0"
completed_date:
started_date:
tags: [告警迁移, 配置变更, Categraf, exec插件]
depends_on: [Categraf全集群铺开]
---

# Categraf exec 插件统一采集方案

## 背景

Zabbix 中有部分告警规则监控**配置文件/关键路径的变更**（如 `/etc/hosts` MD5 变更、`kerberos.conf` 权限变更、关键 jar 包替换等）。这类告警不适合用 Prometheus Exporter 模型（非数值型时序数据），也不适合用 Loki 日志匹配（非日志流）。

方案：利用 Categraf 的 **exec 插件**，定时执行检测脚本，将检测结果以 Prometheus 指标形式输出，再由 Foxeye 配置 PromQL 告警。

## 技术方案

```
Categraf exec 插件（每 N 秒执行）
  → 检测脚本（shell/python）
  → 输出 Prometheus 指标格式（stdout）
  → Categraf 采集并上报 VictoriaMetrics
  → Foxeye PromQL AlertRule
```

### exec 插件配置示例

```toml
[[instances]]
commands = ["/opt/categraf/scripts/check_file_md5.sh /etc/hosts"]
timeout = "10s"
data_format = "influx"
interval = 60
```

### 检测脚本输出规范

```text
file_check{path="/etc/hosts", check="md5", status="changed"} 1
file_check{path="/etc/krb5.conf", check="permission", status="ok"} 0
```

## 执行步骤

1. [ ] 梳理 Zabbix 中配置变更类告警规则清单（从 [[Zabbix规则迁移状态梳理与分类]] 提取）
2. [ ] 按配置项类型分组：文件 MD5 变更 / 权限变更 / 内容关键字匹配 / 路径存在性
3. [ ] 编写通用检测脚本模板（一个脚本覆盖同类检测，参数化配置）
4. [ ] 在测试节点部署 Categraf + exec 插件，验证脚本输出格式正确
5. [ ] 在 Foxeye 配置 PromQL 告警规则，验证告警触发链路
6. [ ] 批量铺开到全集群（依赖 [[Categraf全集群铺开]] 完成）

## 验收标准

- 通用检测脚本覆盖 ≥ 3 种配置变更检测类型
- exec 插件在 1 台测试节点正常运行 24h 无异常
- 至少 1 条配置变更告警在 Foxeye 成功触发并推送
