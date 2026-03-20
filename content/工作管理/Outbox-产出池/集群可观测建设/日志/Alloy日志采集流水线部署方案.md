# Alloy 日志采集流水线部署方案

> **版本**: v1.0
> **日期**: 2026-03-20
> **负责人**: 李浩鹏
> **Alloy 版本**: v1.5.0

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状与痛点](#2-现状与痛点)
3. [方案总览](#3-方案总览)
4. [技术选型说明](#4-技术选型说明)
5. [流水线架构设计](#5-流水线架构设计)
6. [标签体系设计](#6-标签体系设计)
7. [采集范围](#7-采集范围)
8. [部署方案](#8-部署方案)
9. [分阶段实施计划](#9-分阶段实施计划)
10. [验收标准](#10-验收标准)
11. [运维说明](#11-运维说明)
12. [风险与规避](#12-风险与规避)

---

## 1. 背景与目标

大数据集群当前管理超过 **60 台主机**，横跨 H3离线、H3实时、H3冷存、H2冷存四个集群，运行 HDFS、YARN、Hive、HBase、ZooKeeper 等核心组件。

**当前日志访问方式**：各组件日志分散存储在各主机本地磁盘，排查问题需 SSH 逐节点 `grep`，效率低下，且日志无法跨节点关联。

**目标**：建立统一的集中式日志采集流水线，将全集群日志实时推送至 Loki，支持 LogQL 查询与告警，为 Foxeye 告警平台提供日志数据源。

| 指标 | 目标值 |
|------|--------|
| 核心组件覆盖率 | NN / RM / HS2 100% 接入 |
| 日志压缩率 | ≥ 50% |
| 数据延迟 | 采集到 Loki 可查 ≤ 10s |
| 资源占用 | 单节点 CPU ≤ 50%，内存 ≤ 512MB |

---

## 2. 现状与痛点

### 2.1 现状

- 各组件日志落盘至本地 `/var/log/<component>/`，无统一汇聚
- 已有 Prometheus + Exporter 指标体系，但缺少与日志的联动
- Foxeye 告警平台已支持 Loki 数据源接入，但当前无日志数据

### 2.2 痛点

| 场景 | 当前问题 |
|------|---------|
| 故障排查 | 需逐节点 SSH，多节点 Java 异常 stack trace 分散、不易关联 |
| 告警触发 | 无法基于日志内容（如 `ERROR`、`FATAL`）触发告警 |
| 历史回溯 | 本地日志受磁盘限制，滚动较快，历史日志容易丢失 |
| Java 多行日志 | stack trace 跨多行，直接采集会将一条异常拆散为多条记录 |

---

## 3. 方案总览

```
┌─────────────────────────────────────────────────────────────┐
│                     Panther CMDB                            │
│              (统一下发 salt state.apply)                     │
└─────────────────────────┬───────────────────────────────────┘
                          │ SaltStack 自动化部署
          ┌───────────────┴──────────────────┐
          │           Salt Master             │
          │  Pillar：全局配置 + 主机差异化配置  │
          └───────────────┬──────────────────┘
                          │ 渲染配置 + 安装
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
┌───▼────┐           ┌────▼───┐           ┌─────▼──┐
│节点 A  │           │节点 B  │           │节点 C  │  ...60+ 台
│Alloy   │           │Alloy   │           │Alloy   │
│采集本地│           │采集本地│           │采集本地│
│日志文件│           │日志文件│           │日志文件│
└───┬────┘           └────┬───┘           └─────┬──┘
    │                     │                     │
    └─────────────────────▼─────────────────────┘
                          │ HTTP Push（远程写入）
                ┌─────────▼──────────┐
                │        Loki        │
                │  统一日志存储       │
                └─────────┬──────────┘
                          │ LogQL 查询
                ┌─────────▼──────────┐
                │      Foxeye        │
                │  告警规则 / 日志面板 │
                └────────────────────┘
```

---

## 4. 技术选型说明

### 4.1 采集 Agent：Grafana Alloy

| 对比项 | Promtail | Grafana Alloy |
|--------|---------|--------------|
| 维护状态 | 进入维护模式（不再主动开发） | 官方主力产品，持续演进 |
| 配置模式 | YAML，静态配置 | Flow 模式，组件化 DAG，灵活组合 |
| 多行合并 | 支持，配置较繁琐 | 原生支持，`loki.process` 阶段处理 |
| 指标采集 | 仅日志 | 日志 + 指标 + Trace，后期可扩展 |
| 资源占用 | 轻量 | 相近，可配置资源限制 |

**结论**：选用 Alloy，兼顾当前需求与后续扩展空间。

### 4.2 部署方式：SaltStack + Panther CMDB

集群已使用 SaltStack 管理，通过 CMDB 统一下发，无需人工逐节点操作，变更可溯源。

---

## 5. 流水线架构设计

### 5.1 Alloy Flow 组件链

每台主机上的 Alloy 按以下 Flow 处理日志：

```
local.file_match          →   loki.source.file   →   loki.process   →   loki.write
（文件路径匹配 + glob）       （日志读取 + 偏移量）    （多行合并 +         （HTTP push
                                                       静态标签注入）       到 Loki）
```

### 5.2 多行合并策略

Java 服务日志（NameNode、HiveServer2 等）异常 stack trace 跨多行，Alloy 使用首行正则进行合并：

```
# 首行匹配规则（ISO 8601 时间戳开头）
firstline: `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`

# 等待关联时间
max_wait_time: 3s
```

效果：原本被拆散为 30+ 行的 Java stack trace，合并为 1 条 Loki 日志记录，便于查询和告警。

### 5.3 Pillar 分层配置

采集配置通过两层 Pillar 合并生成，实现"全局统一 + 主机差异化"：

```
install_alloy.sls（全局层）         host_jobs.sls（主机层）
─────────────────────────           ──────────────────────
• Alloy 二进制版本                  • 各主机服务级日志路径
• Loki endpoint / tenant_id         • 组件名称与标签
• 资源限制（CPU / 内存 / fd）        • 多行规则
• default_jobs（系统日志）
         │                                   │
         └─────────────┬─────────────────────┘
                       ▼ Salt 深度合并
                config.alloy（渲染到目标主机）
```

---

## 6. 标签体系设计

Loki 使用标签索引日志流，标签设计决定查询粒度和存储效率。

| 标签 | 含义 | 示例值 |
|------|------|--------|
| `instance` | 主机标识（Salt minion ID） | `dnn014023`、`rtrm1` |
| `service_name` | 组件服务名 | `hadoop-hdfs`、`hive-hs2`、`linux-system` |
| `cluster` | 所属集群 | `H3离线`、`H3实时`、`H3冷存`、`H2冷存` |
| `role` | 节点角色 | `namenode`、`resourcemanager`、`datanode` |
| `log_type` | 日志类型 | `service`（服务日志）、`gc`（GC 日志） |

**查询示例**：

```logql
# 查 H3离线集群所有 NameNode 的 ERROR 日志
{cluster="H3离线", role="namenode"} |= "ERROR"

# 查某台主机的 HiveServer2 日志
{instance="dmc014011", service_name="hive-hs2"}

# 统计各集群日志错误率
sum(rate({cluster=~".+"}[5m])) by (cluster)
```

---

## 7. 采集范围

### 7.1 覆盖集群

| 集群 | 主机规模 | Ambari 地址 |
|------|---------|------------|
| H3 离线（hadoop3） | ~40 台 | dmc014011.venus.sohurdc.com:8080 |
| H3 实时（rt） | ~10 台 | rtrm1.venus.sohurdc.com:8080 |
| H3 冷存（ec） | ~10 台 | dnn130160.venus.sohurdc.com:8080 |
| H2 冷存 | ~10 台 | — |

### 7.2 采集组件

**阶段一（全集群，系统日志）**：

| 采集内容 | 路径 | 覆盖节点 |
|---------|------|---------|
| 系统消息日志 | `/var/log/messages` | 全部 60+ 台 |

**阶段二（服务日志，按集群逐步接入）**：

| 组件 | 日志路径 | 日志类型 |
|------|---------|---------|
| HDFS NameNode | `/var/log/hadoop/hdfs/hadoop-hdfs-namenode-*.log` | 服务 + GC |
| HDFS DataNode | `/var/log/hadoop/hdfs/hadoop-hdfs-datanode-*.log` | 服务 + GC |
| YARN ResourceManager | `/var/log/hadoop/yarn/yarn-yarn-resourcemanager-*.log` | 服务 + GC |
| YARN NodeManager | `/var/log/hadoop/yarn/yarn-yarn-nodemanager-*.log` | 服务 |
| HiveServer2 | `/var/log/hive/hiveserver2.log` | 服务 |
| HiveMetaStore | `/var/log/hive/hive.log` | 服务 |
| HBase Master | `/var/log/hbase/hbase-hbase-master-*.log` | 服务 + GC |
| HBase RegionServer | `/var/log/hbase/hbase-hbase-regionserver-*.log` | 服务 + GC |
| ZooKeeper | `/var/log/zookeeper/zookeeper-zookeeper-*.log` | 服务 |
| Ambari Server | `/var/log/ambari-server/ambari-server.log` | 服务 |
| Ranger Admin | `/var/log/ranger/admin/` | 服务 |

---

## 8. 部署方案

### 8.1 主机侧部署内容

Salt State 执行后，目标主机上的变更：

| 路径 | 内容 |
|------|------|
| `/usr/local/bin/alloy` | Alloy 二进制（v1.5.0，SHA256 校验） |
| `/etc/alloy/config.alloy` | 渲染后的采集配置（权限 640） |
| `/var/lib/alloy/` | 持久化存储（偏移量记录，权限 750） |
| `alloy.service` | systemd unit，开机自启 |
| `alloy` 用户/组 | 低权限运行用户，不可登录，不可 sudo |

### 8.2 资源限制配置

| 参数 | 值 | 说明 |
|------|-----|------|
| CPUQuota | 50% | 避免影响业务进程 |
| MemoryLimit | 512M | 单节点内存上限 |
| LimitNOFILE | 65536 | 多日志文件采集时需突破 OS 默认 1024 |
| 重启策略 | always，5s 延迟 | 异常退出后自动恢复 |

### 8.3 部署命令

```bash
# 全量部署（安装 + 配置 + 启动）
salt '<目标主机>' state.apply install_alloy

# 批量部署（按集群）
salt 'dmc*' state.apply install_alloy     # H3 离线
salt 'dnn130*' state.apply install_alloy  # H3 冷存
salt 'rt*' state.apply install_alloy      # H3 实时

# 仅重启服务（配置变更后）
salt '<目标主机>' state.apply install_alloy.start_alloy

# 查看运行状态
salt '<目标主机>' state.apply install_alloy.status_alloy
```

### 8.4 上线前必须完成的验证项

| 验证项 | 操作 | 说明 |
|--------|------|------|
| Minion ID 核对 | `salt 'dmc*' grains.get id` | host_jobs.sls 的 key 必须与 grains['id'] 完全一致 |
| 日志路径确认 | `ls -la /var/log/hadoop/hdfs/` | 确认路径存在，避免 Alloy 空跑 |
| 读权限验证 | `su -s /bin/sh alloy -c "cat /var/log/hadoop/hdfs/*.log"` | alloy 用户需加入 hadoop 组 |
| GC 日志名确认 | `ls -lt /var/log/hadoop/hdfs/gc*` | GC 日志使用年份前缀，需与配置匹配 |

---

## 9. 分阶段实施计划

### 阶段 0：预部署验证（当前）

- 核对全集群 60+ 台主机的 Minion ID
- 验证各组件日志路径和 alloy 用户读权限
- 确认 GC 日志文件名格式

### 阶段一：全集群系统日志上线

- 采集范围：所有主机 `/var/log/messages`
- 下发范围：全集群 60+ 台主机
- 预期效果：所有主机系统日志可在 Loki 中查询

### 阶段二：服务日志按集群接入

按以下顺序逐步扩展（每集群验证稳定后再推进下一个）：

1. H3 离线集群（主集群，优先级最高）
2. H3 实时集群
3. H3 / H2 冷存集群

每个集群先在 2~3 台主机试点，确认采集正常、Loki 可查、资源消耗符合预期后，再全量铺开。

---

## 10. 验收标准

- [ ] 全集群 60+ 台主机系统日志（`/var/log/messages`）均可在 Loki 查询
- [ ] NameNode、ResourceManager、HiveServer2 日志 100% 接入
- [ ] Java 异常 stack trace 多行合并生效（单条异常在 Loki 中为 1 条记录）
- [ ] Foxeye 可基于 Loki 日志配置 LogQL 告警规则
- [ ] 日志存储压缩率 ≥ 50%（通过 Loki metrics 验证）
- [ ] 单节点 CPU 消耗 ≤ 50%、内存 ≤ 512MB（服务日志全量接入后压测验证）
- [ ] alloy 用户以低权限运行，无 root、无 sudo
- [ ] 服务异常退出后可自动重启（systemd 策略验证）

---

## 11. 运维说明

### 11.1 日常操作

```bash
# 查看 Alloy 自身日志
journalctl -u alloy.service -f

# 确认采集状态（Alloy 提供 HTTP metrics 接口）
curl http://localhost:12345/metrics | grep alloy_component

# 新增服务日志接入
# 1. 编辑 host_jobs.sls，添加新 job
# 2. 通过 CMDB 提交变更并下发
# 3. salt '<目标主机>' state.apply install_alloy
```

### 11.2 常见问题

| 现象 | 可能原因 | 处理方式 |
|------|---------|---------|
| 某主机日志不上报 | Minion ID 与 host_jobs key 不匹配 | `salt '<host>' grains.get id` 核对后修正 host_jobs.sls |
| 日志采集中断 | alloy 用户读权限不足 | `usermod -aG hadoop alloy`，重启 alloy.service |
| GC 日志年后不采集 | GC 日志路径使用了年份前缀 | 更新 host_jobs.sls 中 GC 路径的年份后重新下发 |
| stack trace 被拆散 | firstline 正则未匹配 | 确认日志时间戳格式，调整 multiline.firstline |
| Loki 写入失败 | 网络不通或 tenant_id 错误 | `curl <loki_url>`，检查 Alloy 日志 `journalctl -u alloy` |

### 11.3 版本升级

升级只需修改全局 Pillar 的 `binary_url` 和 `binary_hash`，无需改动主机配置：

```yaml
# install_alloy.sls
alloy:
  binary_url: https://.../alloy-linux-amd64-v1.6.0   # 更新版本
  binary_hash: <新版本 SHA256>                         # 更新哈希
```

重新下发即可：`salt '*' state.apply install_alloy`

---

## 12. 风险与规避

| 风险 | 影响 | 规避措施 |
|------|------|---------|
| alloy 用户无日志读权限 | 指定主机日志采集失败，静默丢数据 | 上线前逐主机验证权限，alloy 加入 hadoop 组 |
| Minion ID 配置错误 | host_jobs 规则对目标主机静默失效 | 预部署阶段统一核对，使用 `salt '*' grains.get id` 批量确认 |
| GC 日志跨年失采 | 新年后 GC 日志不上报 | 在 CMDB 工单系统设置年度提醒，每年 1 月更新路径 |
| Loki 写入压力 | 全量接入后写入量激增，影响 Loki 稳定性 | 分阶段接入，每阶段观察 Loki 写入速率，必要时调整 CPU 配额 |
| 节点资源竞争 | Alloy 与业务进程争抢 CPU / 内存 | systemd 资源限制（CPUQuota=50%，MemoryLimit=512M）兜底，上线后监控 |
| 配置变更误操作 | 全量下发错误配置导致批量重启 | 变更先在 1 台主机验证，再全量推送；保留回滚步骤 |
