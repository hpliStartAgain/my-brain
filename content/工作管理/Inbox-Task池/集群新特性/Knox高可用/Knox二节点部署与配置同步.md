---
type: task
status: todo
priority: P1
deadline: 2026-03-24
domain: 集群新特性
lifecycle: engineering
progress: "0"
completed_date:
started_date:
---

## 🎯 目标与验收标准
- [ ] 确认节点 2 主机（与 dsrv014022 同网段，磁盘 > 5GB，hdfs 用户存在）
- [ ] 将 knox-2.0.0 程序包、conf、data/security 完整复制到节点 2
- [ ] 节点 2 申请 `HTTP/<node2_fqdn>@HADOOP.COM` Keytab 并配置 krb5JAASLogin.conf
- [ ] 节点 2 独立启动 Knox（ldap.sh + gateway.sh）
- [ ] 验证节点 2 可访问：Knox Admin UI、YARN UI、WebHDFS

## ⚙️ 关键操作

参考：[[Knox高可用方案设计]] Step 1 & Step 2

```bash
# 复制程序包（节点1执行）
scp -r /opt/work/knox-2.0.0 <node2>:/opt/work/knox-2.0.0

# 节点2启动
cd /opt/work/knox-2.0.0
bin/ldap.sh start
bin/gateway.sh start
tail -f logs/gateway.log
```

> ⚠️ 节点 2 **不要**重新执行 `knoxcli.sh create-master`，直接使用复制过来的 master 文件

## 🐛 踩坑日志
-
