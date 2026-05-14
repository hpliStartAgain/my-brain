---
type: task
status: doing
priority: P0
deadline: 2026-06-18
domain: 集群可观测建设
lifecycle: engineering
progress: "35"
completed_date:
started_date: 2026-03-20
tags: [Alloy, Loki, 日志采集, 部署推广]
---

# Alloy 全集群部署推广

## 目标

将 Grafana Alloy 日志采集器推广到**大数据 / 中间件 / CVM** 三组的全部集群，实现系统日志 + 服务日志 + GC 日志 100% 接入 Loki，消除日志采集盲区。

## 当前进度总览

| 组 | 集群 | 已覆盖节点 | 总节点 | 覆盖度 | 状态 |
|---|---|---|---|---|---|
| 大数据 | H3 离线 | ~60 | ~60 | ~100% | ✅ 已上线 |
| 大数据 | H3 实时 | 2 | 2 | ~100% | ✅ 已上线 |
| 大数据 | H3 冷存 | ? | ? | ? | ⚠️ 待确认 |
| 大数据 | H2 冷存 | ? | ? | ? | ⚠️ 待确认 |
| 中间件 | Kafka/ES/Druid/Redis/MySQL | 0 | ? | 0% | ❌ 未启动 |
| CVM | CVM 集群 | 0 | ? | 0% | ❌ 未启动 |

## 按组-集群-服务-组件维度部署总表

### 大数据组

| 组 | 集群 | 服务 | 组件 | 系统日志 | 服务日志 | GC日志 | 预计交付 | 实际上线 |
|---|---|---|---|---|---|---|---|---|
| 大数据 | H3 离线 | HDFS | NameNode | ✅ | ✅ | ✅ | 03-27 | 已上线 |
| 大数据 | H3 离线 | HDFS | DataNode（~60台） | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | YARN | ResourceManager | ✅ | ✅ | ✅ | 03-27 | 已上线 |
| 大数据 | H3 离线 | YARN | NodeManager（~60台） | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | Hive | HiveServer2 | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | Hive | HiveMetaStore | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | HBase | HMaster / RegionServer | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | ZK | ZooKeeper | ✅ | ✅ | ✅ | 04-21 | 已上线 |
| 大数据 | H3 离线 | KDC | KDC Server | ✅ | ✅ | - | 04-07 | 已上线 |
| 大数据 | H3 实时 | HDFS | NameNode（rtrm1/rtrm2） | ✅ | ✅ | ⚠️ 路径不匹配 | 03-27 | 已上线 |
| 大数据 | H3 实时 | YARN | ResourceManager（rtrm1/rtrm2） | ✅ | ✅ | ⚠️ 路径不匹配 | 03-27 | 已上线 |
| 大数据 | H3 实时 | ZK | ZooKeeper Server（rtrm1/rtrm2） | ✅ | ✅ | ⚠️ 无GC日志 | 03-27 | 已上线 |
| 大数据 | H3 实时 | Ranger | Ranger Admin（rtrm1/rtrm2） | ✅ | ✅ | ⚠️ 无GC日志 | 03-27 | 已上线 |
| 大数据 | H3 实时 | Ambari | Ambari Server（rtrm1） | ✅ | ✅ | - | 03-27 | 已上线 |
| 大数据 | H3 冷存 | YARN | ResourceManager | ? | ? | ? | 05-31 | 待确认 |
| 大数据 | H3 冷存 | HDFS | NameNode/DataNode | ? | ? | ? | 05-31 | 待确认 |
| 大数据 | H2 冷存 | HDFS | NameNode/DataNode | ? | ? | ? | 05-31 | 待确认 |
| 大数据 | H2 冷存 | YARN | ResourceManager/NodeManager | ? | ? | ? | 05-31 | 待确认 |

### 中间件组

| 组 | 集群 | 服务 | 组件 | 系统日志 | 服务日志 | GC日志 | 预计交付 | 实际上线 |
|---|---|---|---|---|---|---|---|---|
| 中间件 | 中间件集群 | Kafka | Kafka Broker | ❌ | ❌ | ❌ | 06-15 | 未启动 |
| 中间件 | 中间件集群 | ES | Elasticsearch | ❌ | ❌ | ❌ | 06-15 | 未启动 |
| 中间件 | 中间件集群 | Druid | Druid Broker/Coordinator | ❌ | ❌ | ❌ | 06-15 | 未启动 |
| 中间件 | 中间件集群 | Redis | Redis Server | ❌ | ❌ | - | 06-15 | 未启动 |
| 中间件 | 中间件集群 | MySQL | MySQL Server | ❌ | ❌ | - | 06-30 | 未启动 |

### CVM 组

| 组 | 集群 | 服务 | 组件 | 系统日志 | 服务日志 | GC日志 | 预计交付 | 实际上线 |
|---|---|---|---|---|---|---|---|---|
| CVM | CVM 集群 | 系统 | 全量 CVM 节点 | ❌ | ❌ | - | 06-30 | 未启动 |

## 分阶段推广计划

### 阶段一：大数据集群收尾（DDL：05-31）

- [ ] H3 冷存集群：确认节点列表 + Alloy 部署状态，未覆盖节点 Salt 批量 apply
- [ ] H2 冷存集群：同上
- [ ] H3 实时：修复 GC 日志路径不匹配问题（部分组件 GC 日志文件名与 pillar glob 不一致）

### 阶段二：中间件集群接入（DDL：06-15）

- [ ] 中间件集群节点清单梳理
- [ ] 编写中间件 host_jobs.sls（Kafka/ES/Druid/Redis 日志路径配置）
- [ ] Salt 批量部署（分批：Kafka → ES → Druid → Redis）
- [ ] Loki 验证日志流接入正常

### 阶段三：CVM 集群接入（DDL：06-30）

- [ ] CVM 集群节点清单 + 日志路径盘点
- [ ] 编写 CVM host_jobs.sls
- [ ] Salt 批量部署
- [ ] Loki 验证

## 关联任务

- [[Alloy阶段一：全集群系统日志上线]] ✅
- [[Alloy阶段二：服务级日志接入]] ✅（大数据主节点）
- [[Alloy预部署验证：Minion-ID、日志路径与权限核查]] ✅
- [[CVM与中间件集群Loki接入]] 🔄 doing
- [[Loki日志采集流水线设计与开发]] ✅
- [[Foxeye基于Loki日志的告警规则添加]] ⏸️ backlog

## 踩坑记录

- H3 实时部分组件 GC 日志文件名格式与 pillar glob 不匹配（`gc-2026*.log` vs `gc.log-*`），需逐个确认实际文件名后修正 pillar
- H3 实时 ZooKeeper/Ranger 确认无 GC 日志输出，需检查 JVM 参数是否启用 GC logging
