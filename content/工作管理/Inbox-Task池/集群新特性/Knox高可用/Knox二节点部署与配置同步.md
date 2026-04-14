---
type: task
status: done
priority: P1
deadline: 2026-03-24
domain: 集群新特性
lifecycle: engineering
progress: "100"
completed_date: 2026-03-25
started_date: 2026-03-25
---

## 🎯 目标与验收标准
- [x] 确认节点 2 主机（与 dsrv014022 同网段，磁盘 > 5GB，hdfs 用户存在） ✅ 2026-03-25
- [x] 将 knox-2.0.0 程序包、conf、data/security 完整复制到节点 2 ✅ 2026-03-25
- [x] 节点 2 Keytab 验证：keytab 为用户主体 `hdfs@VENUS.SOHURDC.COM`（非 host-specific），直接复制可用，无需申请新 Keytab ✅ 2026-03-25
- [x] 节点 2 独立启动 Knox（ldap.sh + gateway.sh）✅ 2026-03-25
- [x] 验证节点 2 可访问：Knox Admin UI、YARN UI（通过 ec_nn1 topology）✅ 2026-03-25

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
- **logs 目录权限**：`logs -> /data_b/log/knox` 软链目标目录属主为 root，需 `chown hdfs:hdfs /data_b/log/knox` 后才能启动
- **SSL 证书过期**：gateway.jks 中证书 2025-12-02 到期，节点2 新启动时触发校验失败。执行 `bin/knoxcli.sh create-cert --hostname dsrv014021.venus.sohurdc.com` 重签后解决。节点1 下次重启前也需同步执行
- **Keytab 复用**：方案文档中预期申请 `HTTP/<node2_fqdn>` 服务主体，实际 Knox 使用 `hdfs@VENUS.SOHURDC.COM` 用户主体（无主机绑定），直接 scp 复用，无需申请新 Keytab，`krb5JAASLogin.conf` 无需修改
