---
type: task
status: doing
priority: P0
deadline: 2026-03-27
domain: 集群可观测建设
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-03-23
---

## 🎯 目标与验收标准

在所有目标集群部署 Alloy，采集系统日志（`/var/log/messages`），完成阶段一上线。此阶段 **不下发** `host_jobs`，仅采集系统日志，以最小风险验证 Alloy 部署流水线。

**前置条件**：[[Alloy预部署验证：Minion-ID、日志路径与权限核查]] 完成。

- [ ] 第1批：测试机（1台）部署成功，`journalctl -u alloy` 无报错，Loki 中可查到系统日志流
- [ ] 第2批：H3离线集群管理节点（NN + RM，共 10 台）部署成功
- [ ] 第3批：H3离线集群工作节点（DN + NM，60+ 台）部署成功
- [ ] 第4批：H3实时、H3冷存、H2冷存节点部署成功
- [ ] `develop` 分支 merge 到 `master`，正式发布

## ⚙️ 执行路径

### 通用部署命令

```bash
# 单节点部署（测试/验证用）
salt '<node>' state.apply install_alloy

# 批量部署
salt -L 'dnn014023,dnn014024,...' state.apply install_alloy

# 查看状态
salt '<node>' state.apply install_alloy.status_alloy
```

### 第1批：测试机

```bash
salt '<test-node>' state.apply install_alloy
# 等待 30s，Loki 查询：
# {service_name="linux-system", instance="<test-node>"} | limit 10
```

验证通过后继续第2批。

### 第2批：H3离线管理节点

```bash
salt -L 'dnn014023,dnn014024,dnn014025,dnn014026,dnn014027,dnn014028,dnn014029,dnn014030,drm014016,drm014017' state.apply install_alloy
```

### 第3批：H3离线工作节点

```bash
# DataNode + NodeManager（按批次执行，建议每批 20 台）
salt -G 'cluster:h3offline and roles:datanode' state.apply install_alloy
```

### 第4批：其他集群

```bash
# H3 实时
salt 'rtrm*' state.apply install_alloy

# H3/H2 冷存（按 IP 或 grains 过滤）
salt -G 'cluster:ec' state.apply install_alloy
```

### Loki 验证查询

```logql
# 系统日志写入确认
{service_name="linux-system"} | limit 10

# 按集群汇总（阶段一无 cluster 标签，用 instance 区分）
count_over_time({service_name="linux-system"}[5m])
```

### 收尾：merge 到 master

```bash
cd salt-states
git checkout master
git merge develop
git push origin master
```

## 🐛 踩坑日志 (Troubleshooting)
-
