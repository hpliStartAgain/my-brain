---
type: task
status: todo
priority: P1
deadline: 2026-03-25
domain: 集群新特性
lifecycle: engineering
progress: "0"
completed_date:
started_date:
---

## 🎯 目标与验收标准
- [ ] 在 SCLB 平台创建四层实例（标准型，IPv4）
- [ ] 创建服务器组（IP 类型，TCP，加权轮询，TCP 健康检查/8443）
- [ ] 添加两个后端 IP（dsrv014022 + node2，权重各 100）
- [ ] 创建 TCP 监听，端口 8443
- [ ] 记录 SCLB VIP 地址，通过 VIP 可访问 Knox 服务

## ⚙️ 关键配置

参考：[[Knox高可用方案设计]] 第 5 节 SCLB 配置

| 参数 | 值 |
|------|-----|
| 实例规格 | 标准型 |
| 后端协议 | TCP |
| 调度算法 | 加权轮询 |
| 健康检查 | TCP / 8443 / 超时5s / 间隔5s / 健康阈值2 / 不健康阈值2 |
| 监听端口 | 8443 |

## 🐛 踩坑日志
-
