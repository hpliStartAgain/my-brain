---
type: task
status: todo
priority: P1
deadline: 2026-03-26
domain: 集群新特性
lifecycle: engineering
progress: "0"
completed_date:
started_date:
---
ji
## 🎯 目标与验收标准
- [ ] 通过 SCLB VIP 访问 Knox Admin UI / YARN UI / WebHDFS / Spark History UI 全部正常
- [ ] 停止节点 1 Knox 服务，VIP 访问在 30 秒内自动切换到节点 2，无报错
- [ ] 停止节点 2 Knox 服务，VIP 访问在 30 秒内自动切换到节点 1，无报错
- [ ] 恢复节点后流量可正常回切

## ⚙️ 验证命令

参考：[[Knox高可用方案设计]] Step 4

```bash
# 节点2独立验证
curl -u admin:admin123 http://<node2>:8443/gateway/venus/yarn

# VIP验证
curl -u admin:admin123 http://<SCLB_VIP>:8443/gateway/venus/yarn

# 故障切换验证：停节点1，观察VIP是否可用
ssh dsrv014022 "cd /opt/work/knox-2.0.0 && bin/gateway.sh stop"
sleep 15
curl -u admin:admin123 http://<SCLB_VIP>:8443/gateway/venus/yarn
```

## 🐛 踩坑日志
-
