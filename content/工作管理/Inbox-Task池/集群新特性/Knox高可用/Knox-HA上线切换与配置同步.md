---
type: task
status: done
priority: P1
deadline: 2026-03-27
domain: 集群新特性
lifecycle: engineering
progress: "0"
completed_date: 2026-03-31
started_date: 2026-03-31
---

## 🎯 目标与验收标准
- [x] 更新内网 Knox 访问地址为 SCLB VIP（通知相关团队） ✅ 2026-03-31
- [x] 配置 topology 定时同步 cron（5 分钟同步节点 1 → 节点 2） ✅ 2026-03-31
- [x] 更新 [[Knox高可用方案设计]] 文档，补充实际 VIP 和节点 2 信息 ✅ 2026-03-31
- [x] 更新任务 frontmatter：status=done，completed_date=2026-03-27 ✅ 2026-03-31

## ⚙️ 配置 Topology 同步 Cron（节点 1 执行）

```bash
crontab -e
# 添加（注意替换 node2 实际地址）：
*/5 * * * * rsync -a /opt/work/knox-2.0.0/conf/topologies/ <node2>:/opt/work/knox-2.0.0/conf/topologies/ \
  && rsync -a /opt/work/knox-2.0.0/conf/users.ldif <node2>:/opt/work/knox-2.0.0/conf/users.ldif
```

## 🐛 踩坑日志
-
