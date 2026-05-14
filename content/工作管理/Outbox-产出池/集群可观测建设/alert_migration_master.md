# Zabbix → Foxeye 告警规则迁移大合集

> **数据源**：`alert_rule_groups_20260512_105823.csv`  
> **最后更新**：2026-05-12  
> **维护者**：SRE @ 搜狐 RDC  
> **Confluence 汇总页**：https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107717201

---

## 📊 总体进度

| 维度                  | 数值             |
| ------------------- | -------------- |
| CSV 规则总条数           | 435 条 / 21 个服务 |
| ✅ matched（平台已有对应规则） | 159 条（36.6%）   |
| 🔄 mixed（部分匹配）      | 5 条            |
| ⏳ unmatched（待处理）    | 268 条          |
| 🔴 retired（已废弃）     | 3 条            |

## 🗂 各服务迁移进度总表

| 服务 | 总条数 | matched | retired | unmatched | 深度分析 | Confluence 页面 |
|---|---|---|---|---|---|---|
| **hdfs** | 44 | 43 | 0 | 1 | 98% 完成；1 条 ZKFC 进程存活需 Categraf procstat 补充... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718652) |
| **yarn** | 33 | 30 | 2 | 1 | 91% 完成；2 条 retired（LevelDB 旧规则）；1 条 node-exporter ... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718655) |
| **hbase** | 20 | 18 | 0 | 2 | 90% 完成；2 条 blocked_exporter 待后续处理... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718660) |
| **hive** | 25 | 15 | 1 | 9 | 15 matched + 1 retired + 2 Loki alerting + 2 Categ... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718661) |
| **elasticsearch** | 43 | 20 | 0 | 23 | 20 matched + 3 平台有指标可建规则 + 20 per-IP 探测建议 retire... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718659) |
| **druid** | 10 | 5 | 0 | 5 | 5 matched + 3 Categraf + 2 jmx_exporter 补充... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718664) |
| **infra_basic** | 80 | 27 | 0 | 53 | 27 matched + 5 mixed + 14 Categraf ready + 14 ngin... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718658) |
| **kafka** | 16 | 0 | 0 | 16 | 4 条平台已有 kafka_controller_* 指标可建规则 + 3 Categraf + 8... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718662) |
| **zookeeper** | 9 | 0 | 0 | 9 | 平台指标为 0；全部 9 条通过 Categraf ZooKeeper 插件（mntr 命令）覆盖... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718663) |
| **java_jvm** | 7 | 0 | 0 | 7 | 5 条 jmx_exporter 可覆盖通用 JMX 指标；2 条 retire（JIT 编译器类型... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718666) |
| **ambari** | 3 | 0 | 0 | 3 | 3 条全为 Categraf procstat/net_response（进程存活+端口探活）... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718667) |
| **kyuubi** | 2 | 0 | 0 | 2 | 2 条全为 Categraf net_response + procstat... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718668) |
| **ranger** | 2 | 0 | 0 | 2 | 2 条全为 Categraf net_response + procstat... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718669) |
| **trino** | 2 | 1 | 0 | 1 | 1 matched（Web UI 探活）+ 1 平台有 trino_memory_MemoryPoo... | [📄 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718670) |

### 跳过服务（暂不处理）

| 服务 | 条数 | 跳过原因 |
|---|---|---|
| zabbix_infra | 78 | Zabbix 自身监控，迁移后无需保留，直接废弃 |
| misc | 46 | 已重分类归入各服务，本组作废 |
| spark | 5 | H2 规划，暂不处理 |
| storm | 3 | Storm 集群基本退役 |
| docker_k8s | 4 | K8s 体系独立监控体系，不纳入本次迁移 |
| mapreduce | 2 | MapReduce 告警已被 YARN 覆盖 |
| hardware | 1 | 硬件监控由 IPMI/BMC 独立负责 |

---

## 🚨 关键阻塞项（Blocker）

| 阻塞项 | 影响条数 | 涉及服务 | 解决方案 | 状态 |
|---|---|---|---|---|
| nginx-exporter 未部署 | 14 | infra_basic | 部署 nginx-prometheus-exporter（stub_status） | ⏳ 待处理 |
| Kafka jmx_exporter 配置不完整 | 8 | Kafka | 补充 ISR/RequestTotalTimeMs/OfflineLogDirectory MBean | ⏳ 待处理 |
| ZooKeeper 指标未接入 | 9 | ZooKeeper | Categraf zookeeper 插件（mntr 命令） | ⏳ 待处理 |
| OS 基础指标不完整 | 24 | infra_basic | 补充 Categraf system/mem/kernel/cgroup 插件 | ⏳ 待处理 |
| ZKFC 进程监控缺指标 | 1 | HDFS | Categraf procstat 监控 DFSZKFailoverController | ⏳ 待处理 |
| YARN LevelDB 磁盘大小 | 3 | YARN | node-exporter filesystem 指标监控 LevelDB 目录 | ⏳ 待处理 |

---

## 📋 各服务规则明细

> **图例**：✅ matched（平台已有）｜⏳ unmatched（待处理）｜🔴 retired（已废弃）

### HDFS（44 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718652)

> 💡 **分析结论**：98% 完成；1 条 ZKFC 进程存活需 Categraf procstat 补充

| #   | 规则名称                                                                                                                                                                           | 迁移状态          | 可行性                 | 表达式样例                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | HDFS 使用总存储超过 80% ｜ HDFS 使用总存储超过75%                                                                                                                                             | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop HDFS Namenode/hdfs.namenode.dfs.capacity.used.percent)>75`                      |
| 2   | namenode total file > 2亿 ｜ namenode total file > 2亿1千万 ｜ namenode total file > 2亿2千万 ｜ namenode total file > 2亿3千万 ｜ namenode total file > 2亿4千万 ｜ namenode total file > 2亿5千万 | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop HDFS Namenode/hdfs.namenode.totalfiles)>200000000`                              |
| 3   | Haoop3 HDFS 使用总存储超过75% ｜ Haoop3 HDFS 使用总存储超过80% ｜ Haoop3 HDFS 使用总存储超过85%                                                                                                       | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.dfs.capacity.used.percent)>75`                    |
| 4   | Namenode Port is DOWN                                                                                                                                                          | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop HDFS Namenode/net.tcp.listen[8020])=0 or last(/Template Hadoop HDFS Namenode/n` |
| 5   | Process of Namenode is DEAD                                                                                                                                                    | ✅ `matched`   | 🟢 ready            | `last(/Template BX HDFS Namenode/proc.num[,,,"org.apache.hadoop.hdfs.server.namenode.NameNode"])=0`    |
| 6   | Failed tasks over 20 per 10min                                                                                                                                                 | ✅ `matched`   | 🟢 ready            | `change(/Template Hadoop HDFS Nodemanager/yarn.nodemanager.ContainersFailed[8042])>=20`                |
| 7   | YARN3 Failed tasks over 20 per 10min                                                                                                                                           | ✅ `matched`   | 🟢 ready            | `change(/Template Hadoop3 HDFS Nodemanager/yarn3.nodemanager.ContainersFailed[8042])>20`               |
| 8   | Namenode is in Safe Mode                                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `find(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.fs.state,,"like","safeMode")=1`                   |
| 9   | Namenode switched between Active/standby                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `(last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.haState,#1)<>last(/Template Hadoop3 HDFS Nameno` |
| 10  | namenode total file > 2亿                                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.fs.ns.FilesTotal)>200000000`                      |
| 11  | RPC Processing Time Avg for Port 8020 is greater than 1000ms for 5 minutes                                                                                                     | ✅ `matched`   | 🟢 ready            | `min(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.8020.RpcProcessingTimeAvgTime,5m)>1000`            |
| 12  | RPC Processing Time Avg for Port 8022 is greater than 1000ms for 5 minutes                                                                                                     | ✅ `matched`   | 🟢 ready            | `min(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.8022.RpcProcessingTimeAvgTime,5m)>1000`            |
| 13  | Process of NodeManager is DEAD（Hadoop3)                                                                                                                                        | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Nodemanager/proc.num[,,,"org.apache.hadoop.yarn.server.nodemanager.NodeM` |
| 14  | Process of Failover Controller is DEAD（Hadoop3)                                                                                                                                | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Hadoop HDFS Failover Controller/proc.num[,,,"org.apache.hadoop.hdfs.tools.DFSZKFailov` |
| 15  | Process of Journalnode is DEAD（Hadoop3)                                                                                                                                        | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Journalnode/proc.num[,,,"org.apache.hadoop.hdfs.qjournal.server.JournalN` |
| 16  | JournalNode 滞后的事务数大于 1                                                                                                                                                         | ✅ `matched`   | 🟢 ready            | `change(/Template Hadoop3 HDFS Journalnode/hdfs3.journalnode.CurrentLagTxns[8480])>0`                  |
| 17  | JournalNode fsync 延迟高                                                                                                                                                          | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Journalnode/hdfs3.journalnode.Syncs300s50thPercentileLatencyMicros[8480]` |
| 18  | HDFS3 Namenode FS Namesystem MissingBlocks 增量 > 0.1                                                                                                                            | ✅ `matched`   | 🟢 ready            | `change(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.fsnamesystem.state.MissingBlocks)>last(/Templa` |
| 19  | Process of HDFS Router is DEAD（Hadoop3)                                                                                                                                        | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Router/proc.num[,,,"org.apache.hadoop.hdfs.server.federation.router.DFSR` |
| 20  | YARN3 Failed container over 10% in 10min                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `(last(/Template Hadoop3 HDFS Nodemanager/yarn3.nodemanager.ContainersFailed[8042]) - last(/Template ` |
| 21  | hadoop2 YARN Failed container over 10% in 10min                                                                                                                                | ✅ `matched`   | 🟢 ready            | `(last(/Template Hadoop HDFS Nodemanager/yarn.nodemanager.ContainersFailed[8042]) - last(/Template Ha` |
| 22  | Hadoop3 冷存 Datanode DfsUsed /Capacity >90%                                                                                                                                     | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.DfsUsed[1022])>(last(/Template Hadoop3 HDFS Data` |
| 23  | hadoop_hdfs_dn_hdfs3.datanode.Capacity: Hadoop3 离线 Datanode DfsUsed /Capacity >90%                                                                                             | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.DfsUsed[1022])>(last(/Template Hadoop3 HDFS Data` |
| 24  | hadoop_hdfs_dn_hdfs3.datanode.DataNodeState: Hadoop3 冷存 Process of Datanode is DEAD                                                                                            | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/proc.num[,,,"org.apache.hadoop.hdfs.server.datanode"])=0 and fi` |
| 25  | hadoop_hdfs_dn_hdfs3.datanode.DataNodeState: Process of Datanode is DEAD                                                                                                       | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/proc.num[,,,"org.apache.hadoop.hdfs.server.datanode"])=0 and fi` |
| 26  | Hadoop3 冷存 Found Important storage volume(s) failed                                                                                                                            | ✅ `matched`   | 🟢 ready            | `find(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.FailedStorageLocations[1022],,"iregexp","data_b"` |
| 27  | hadoop_hdfs_dn_hdfs3.datanode.DataNodeState: Found Important storage volume(s) failed                                                                                          | ✅ `matched`   | 🟢 ready            | `find(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.FailedStorageLocations[1022],,"iregexp","data_b"` |
| 28  | Hadoop3 冷存 Failed storage volume(s) found                                                                                                                                      | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.NumFailedVolumes[1022])>0 and find(/Template Had` |
| 29  | hadoop_hdfs_dn_hdfs3.datanode.DataNodeState: Hadoop3 离线 Failed storage volume(s) found                                                                                         | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.NumFailedVolumes[1022])>0 and find(/Template Had` |
| 30  | hadoop_hdfs_dn_hdfs3.datanode.EcFailedReconstructionTasks：存在Reconstruct失败的任务                                                                                                   | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.EcFailedReconstructionTasks.3minadd)> 1`          |
| 31  | HDFS3 namenode PendingReplicationBlocks 增量大于30%                                                                                                                                | ✅ `matched`   | 🟢 ready            | `change(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.dfs.PendingReplicationBlocks)>last(/Template H` |
| 32  | Process of Datanode is DEAD                                                                                                                                                    | ✅ `matched`   | 🟢 ready            | `last(/Templete Hadoop HDFS DataNode SDN/proc.num[,,,"org.apache.hadoop.hdfs.server.datanode"])=0`     |
| 33  | Hadoop3 Datanode 堆内存大于70 %                                                                                                                                                     | ✅ `matched`   | 🟢 ready            | `count(/Template Hadoop3 HDFS DataNode/yarn.datanode.jvmmetrics.MemHeapUsed.precent,5,"gt","0.7")>3`   |
| 34  | Haoop3 HDFS 堆内存使用超过80%                                                                                                                                                         | ✅ `matched`   | 🟢 ready            | `avg(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.jvm.MemHeapUsed.precent,10m)>0.8`                  |
| 35  | Haoop3 HDFS gc时间超过20s                                                                                                                                                          | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.jvm.GcTimeMillis.increase)>=20000`                |
| 36  | HDFS3 TimedOutPendingReconstructions 3分钟增量大于1w                                                                                                                                 | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.FSNamesystem.NumTimedOutPendingReconstructions.3` |
| 37  | h2 冷存坏盘 Failed storage volume(s) found in SDN DataNode                                                                                                                         | ✅ `matched`   | 🟢 ready            | `last(/Templete Hadoop HDFS DataNode SDN/hdfs.SDN.datanode.NumFailedVolumes[50075])>0`                 |
| 38  | NameNode 10 分钟平均堆内存大于 85%                                                                                                                                                      | ✅ `matched`   | 🟢 ready            | `avg(/Template Hadoop HDFS Namenode/hdfs.namenode.jvm.MemHeapUsed.precent,10m)>0.85`                   |
| 39  | hadoop_hdfs_dn_hdfs3.datanode.EcReconstructionTasks 5分钟增量 >500                                                                                                                 | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS DataNode/hdfs3.datanode.EcReconstructionTasks.5minadd)> 500`              |
| 40  | PendingReconstructionBlocks 3分钟增量 3分钟增量大于5k                                                                                                                                    | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop3 HDFS Namenode/hdfs3.namenode.FSNamesystem.PendingReconstructionBlocks.3minadd` |
| 41  | Namenode switched between Active/standby                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `(last(/Template Hadoop HDFS Namenode/hdfs.namenode.haState,#1)<>last(/Template Hadoop HDFS Namenode/` |
| 42  | Namenode is in Safe Mode                                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `find(/Template Hadoop HDFS Namenode/hdfs.namenode.fs.state,,"like","safeMode")=1`                     |
| 43  | Failed storage volume(s) found                                                                                                                                                 | ✅ `matched`   | 🟢 ready            | `last(/Template Hadoop HDFS Datanode/hdfs.datanode.NumFailedVolumes[50075])>0`                         |
| 44  | Found Important storage volume(s) failed                                                                                                                                       | ✅ `matched`   | 🟢 ready            | `find(/Template Hadoop HDFS Datanode/hdfs.datanode.FailedStorageLocations[50075],,"iregexp","data_b")` |

### YARN（33 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718655)

> 💡 **分析结论**：91% 完成；2 条 retired（LevelDB 旧规则）；1 条 node-exporter 补充 LevelDB 磁盘大小

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Timelineserver leveldb size > 100G ｜ Timelineserver leveldb size > 110G ｜ Timelineserver leveldb size > 80G ｜ Timelineserver leveldb size > 90G | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template hadoop3 timeline Server/timeline_dir_size)> 101920` |
| 2 | Timelineserver open file > 40000 ｜ Timelineserver open file > 50000 ｜ Timelineserver open file > 60000 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 timeline Server/file_descriptor_count,#1)>40000` |
| 3 | RpcProcessingTimeAvgTime 周同比波动超过200% | 🔴 `retired` | 🟢 ready | `last(/Template Hadoop YARN ResourceManager/yarn.resourcemanager.rpc.8032.pdelta2["5min","1w"])>200 a` |
| 4 | Hadoop3 Real time YARN Failed tasks over 20 per 10min | ✅ `matched` | 🟢 ready | `change(/Template Hadoop3 Real Time Nodemanager IN K8s/yarn3.nodemanager.ContainersFailed[8042])>20` |
| 5 | Hadoop3 Real time Process of NodeManager is DEAD（Hadoop3) | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 Real Time Nodemanager IN K8s/proc.num[,,,"org.apache.hadoop.yarn.server.nodem` |
| 6 | hadoop3 Real time YARN Failed container over 10% in 10min | ✅ `matched` | 🟢 ready | `(last(/Template Hadoop3 Real Time Nodemanager IN K8s/yarn3.nodemanager.ContainersFailed[8042]) - las` |
| 7 | Resource Manager web server has not responsed for 5 minutes | ✅ `matched` | 🟢 ready | `nodata(/Template Hadoop YARN ResourceManager/web.page.get[*UNKNOWN*,"ws/v1/cluster/info",8088],300s)` |
| 8 | RpcProcessingTimeAvgTime 持续5分钟超过3s | ✅ `matched` | 🟢 ready | `avg(/Template Hadoop YARN ResourceManager/yarn.resourcemanager.rpc.8032.RpcProcessingTimeAvgTime,5m)` |
| 9 | YARN3 Resource Manager web server has not responsed for 5 minutes | ✅ `matched` | 🟢 ready | `nodata(/Template Hadoop3 EC YARN3 ResourceManager/web.page.get[*UNKNOWN*,"ws/v1/cluster/info",8088],` |
| 10 | YARN3 Too many pending containers over 20k | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 EC YARN3 ResourceManager/yarn3.resourcemanager.queue.root.PendingContainers)>` |
| 11 | YARN3 8032 port RpcProcessingTimeAvgTime 持续5分钟超过3s | ✅ `matched` | 🟢 ready | `avg(/Template Hadoop3 EC YARN3 ResourceManager/yarn3.resourcemanager.rpc.8033.RpcProcessingTimeAvgTi` |
| 12 | YARN Queue root pending containers 周环比增长超过4000% | 🔴 `retired` | 🟢 ready | `last(/Template Hadoop3 EC YARN3 ResourceManager/yarn3.resourcemanager.queue.root.PendingContainers.d` |
| 13 | YARN RpcProcessingTimeAvgTime 周同比波动超过200% | ✅ `matched` | 🟢 ready | `avg(/Template Hadoop3 EC YARN3 ResourceManager/yarn3.resourcemanager.rpc.8032.RpcProcessingTimeAvgTi` |
| 14 | Process of Timelineserver is DEAD | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 timeline Server/proc.num[,,,"org.apache.hadoop.yarn.server.applicationhistory` |
| 15 | Timelineserver connection refused | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 timeline Server/net.tcp.service[http,*UNKNOWN*,8188])=0` |
| 16 | Timelineserver api test timeout (1分钟内无响应） | ✅ `matched` | 🟢 ready | `nodata(/Template hadoop3 timeline Server/web.test.rspcode[Timelineserver HTTP status codes,api测试],1m` |
| 17 | Too many pending containers over 20k | ✅ `matched` | 🟢 ready | `count(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.PendingContainers,10,"g` |
| 18 | Queue root pending containers 周环比增长超过4000% | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.PendingContainers.delta1` |
| 19 | Timelineserver 堆内存 > 90% | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 timeline Server/hadoop.yarn.server.JVM.JMX.MemHeapUsedM,#1)> 0.9 * last(/Temp` |
| 20 | Timelineserver CallQueueLength 大于 0 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 timeline Server/hadoop.yarn.server.RpcActivityJMX.CallQueueLength)>0` |
| 21 | Process of ResourceManageris DEAD（Hadoop3) | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 YARN ResourceManager/proc.num[,,,"org.apache.hadoop.yarn.server.resourcemanag` |
| 22 | YARN ResourceManager switched between Active/standby | ✅ `matched` | 🟢 ready | `(last(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.ActiveState,#1)<>last(/Template Ha` |
| 23 | H3 ResourceManager 堆内存大于85 % | ✅ `matched` | 🟢 ready | `count(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.jvmmetrics.MemHeapUsed.precent,#5,` |
| 24 | H3 ResourceManager 5分钟gc 时间超过60% | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.jvmmetrics.GcTimeMillis)-last(/Temp` |
| 25 | hadoop3 队列 root queue.AppsPending >10 （队列可能堵了） | ✅ `matched` | 🟢 ready | `avg(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.AppsPending,10)>10 and co` |
| 26 | hadoop3 队列 root queue.UsedCapacity 连续20分钟大于95%（队列可能堵了） | ✅ `matched` | 🟢 ready | `count(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.UsedCapacity,#20,"gt","` |
| 27 | hadoop3 队列 root queue.MemUsed 连续20分钟大于95%（队列可能堵了） | ✅ `matched` | 🟢 ready | `count(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.MemUsed.precent,#20,"gt` |
| 28 | H3 ResourceManager 汇报发现 异常作业占满磁盘 | ✅ `matched` | 🟢 ready | `bytelength(last(/Template Hadoop3 YARN ResourceManager/rm_nm_disk))>0` |
| 29 | hadoop3 队列 root queue.AppsFailed 五分钟增量 >10 （集群可能异常） | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 YARN ResourceManager/yarn.resourcemanager.queue.root.AppsFailed) - last(/Temp` |
| 30 | Hadoop3 Real time Process of NodeManager is DEAD（No data from jmx) | ✅ `matched` | 🟢 ready | `nodata(/Template Hadoop3 Real Time Nodemanager/hadoop3.yarn.nodemanger.Uptime,3m)=1` |
| 31 | Hadoop3 Real time Process of NodeManager been Restarted（Hadoop3) | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 Real Time Nodemanager/hadoop3.yarn.nodemanger.Uptime) <120000` |
| 32 | Too many pending containers over 400k | ✅ `matched` | 🟢 ready | `last(/Template Hadoop YARN ResourceManager/yarn.resourcemanager.queue.root.PendingContainers)>400000` |
| 33 | Queue root pending containers 周环比增长超过4000% | ✅ `matched` | 🟢 ready | `last(/Template Hadoop YARN ResourceManager/yarn.resourcemanager.queue.root.PendingContainers.delta10` |

### HBASE（20 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718660)

> 💡 **分析结论**：90% 完成；2 条 blocked_exporter 待后续处理

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Hbase 平均region 超过700 | ✅ `matched` | 🟢 ready | `last(/Template HBase HMaster/hbase.master.avgregion)>700` |
| 2 | Process of RegionServer is DEAD | ✅ `matched` | 🟢 ready | `last(/Template HBase RegionServer Process/proc.num[,,,"org.apache.hadoop.hbase.regionserver.HRegionS` |
| 3 | HBase RIT Alarm | ✅ `matched` | 🟢 ready | `last(/Template HBase HMaster/hbase.master.ritCount)>1 and last(/Template HBase HMaster/hbase.master.` |
| 4 | More than 1 RegionServer are dead | ✅ `matched` | 🟢 ready | `last(/Template HBase HMaster/hbase.master.deadRegionservers)>1` |
| 5 | HMaster has changed | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template HBase HMaster/hbase.master.isMaster)<>0` |
| 6 | Process of HMaster is DEAD | ✅ `matched` | 🟢 ready | `last(/Template HBase HMaster/proc.num[,,,"org.apache.hadoop.hbase.master.HMaster"])=0` |
| 7 | RegionServer Port is DOWN | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 HBASE RegionServer JMX/net.tcp.listen[16030])=0` |
| 8 | HMaster Port is DOWN | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 HBase HMaster/net.tcp.listen[16010])=0` |
| 9 | Hbase Master inconsistentRegions >0 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 HBase HMaster/hbase.master.inconsistentRegions)>0` |
| 10 | Hbase Master unknownServerRegions >0 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 HBase HMaster/hbase.master.unknownServerRegions)>0` |
| 11 | HBase ritOldestAge >300000 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 HBase HMaster/hbase.master.ritOldestAge)>300000` |
| 12 | HBASE MASTER 堆内存使用超过80% | ✅ `matched` | 🟢 ready | `count(/Template hadoop3 HBase HMaster/hbase.master.jvm.MemHeapUsedM.percent,5,"gt","0.8")>3` |
| 13 | HBASE MASTER 5分钟gc 时间超过60% | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 HBase HMaster/hbase.master.jvm.GcTimeMillis)-last(/Template hadoop3 HBase HMa` |
| 14 | HBASE RegionServer 5分钟gc 时间超过60% | ✅ `matched` | 🟢 ready | `last(/Template Hadoop3 HBASE RegionServer JMX/http.jmx.jvm.GcTimeMillis)-last(/Template Hadoop3 HBAS` |
| 15 | HBASE RegionServer 堆内存使用超过80% | ✅ `matched` | 🟢 ready | `count(/Template Hadoop3 HBASE RegionServer JMX/hbase.region.jvm.MemHeapUsedM.percent,#10,"gt","0.8")` |
| 16 | hbase-site_num | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template HBase hbase-site.xml/hbase-site_num)=0` |
| 17 | HMaster Port is DOWN | ✅ `matched` | 🟢 ready | `(last(/Template HBase HMaster/net.tcp.listen[60000])=0 or last(/Template HBase HMaster/net.tcp.liste` |
| 18 | RegionServer Port is DOWN | ✅ `matched` | 🟢 ready | `(last(/Template HBase RegionServer Process/net.tcp.listen[60020])=0 or last(/Template HBase RegionSe` |
| 19 | 获取regionserver指标失败 | ✅ `matched` | 🟢 ready | `nodata(/Template HBase RegionServer t/get_total_data[*UNKNOWN*,'60030','/tmp/hbase.jmx'],300s)=1` |
| 20 | Too many "operationTooSlow" in RegionServer Log | ✅ `matched` | 🟢 ready | `last(/Template HBase RegionServer Process/log.count["/var/log/hbase/hbase-cmf-hbase-REGIONSERVER-Tem` |

### HIVE（25 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718661)

> 💡 **分析结论**：15 matched + 1 retired + 2 Loki alerting + 2 Categraf + 3 jmx_exporter + 6 建议 retire（per-IP 探测废弃）

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | HiveServer2 Port is DOWN | ✅ `matched` | 🟢 ready | `last(/Template Hive HiveServer2/net.tcp.listen[10000])=0` |
| 2 | Process of HiveServer2 is DEAD | ✅ `matched` | 🟢 ready | `last(/Template Hive HiveServer2/proc.num[,,,"org.apache.hive.service.server.HiveServer2"])=0` |
| 3 | HiveServer2 is trying to relogin | ✅ `matched` | 🟢 ready | `find(/Template Hive HiveServer2/logrt["/var/log/hive/hadoop-cmf-hive-HIVESERVER2-(.*).log.out","Erro` |
| 4 | Hiveserver2 Active Session周同比超过40%且持续10分钟超过100 | 🔴 `retired` | 🟢 ready | `last(/Template Hive HiveServer2/hive.hiveserver2.session.active.pdelta2["10min","1w"])>40 and min(/T` |
| 5 | Process of Hadoop3 Tez Nginx is DEAD | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Hadoop3 Tez Nginx/proc.num[,,,"nginx"])=0` |
| 6 | hadoop3 hiveserver keepalived服务异常 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template hive server Keepalived/proc.num[keepalived])<2` |
| 7 | HiveServer2 5分钟执行语句失败超过20条 | ✅ `matched` | 🟢 ready | `(last(/Template hadoop3 Hive HiveServer2/hive.hiveserver2.hs2_completed_operation_ERROR) - last(/Tem` |
| 8 | hive-exec-3.1.3.jar md5 change | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template hadoop3 Hive HiveServer2/vfs.file.cksum[/usr/bigtop/current/hive-client/lib/hive-ex` |
| 9 | HiveServer2 10分钟平均堆内存占用率大于90% | ✅ `matched` | 🟢 ready | `avg(/Template hadoop3 Hive HiveServer2/hive.hiveserver2.memory.heap.usage, 10m) > 90` |
| 10 | HMS JVM 发生长时间暂停 | ✅ `matched` | 🟢 ready | `bytelength(last(/Template Hive Metastore/hms_jvm_pause))>0` |
| 11 | HMS 监测到访问大分区操作 | ✅ `matched` | 🟢 ready | `bytelength(last(/Template Hive Metastore/get_partitions_ps_with_auth))>0` |
| 12 | hadooop3 hiveserver2 found msck repair table | ⏳ `unmatched` | 🔶 blocked_exporter | `bytelength(last(/Template hadoop3 Hive HiveServer2/hs2_log))>1` |
| 13 | hive-site_num | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/template_hive_hive-site/hive-site_num)=0` |
| 14 | Generic Java JMX: Compilation: {HOST.NAME} uses suboptimal JIT compiler | ⏳ `unmatched` | 🔶 blocked_exporter | `find(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Compilation","Name"],,"like","Client")=1` |
| 15 | HIVE METASTORE Generic Java JMX: Memory: Heap memory usage is high | ✅ `matched` | 🟢 ready | `min(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Memory","HeapMemoryUsage.used"],10m)>(las` |
| 16 | HIVE METASTORE Generic Java JMX: Memory: Non-Heap memory usage is high | ⏳ `unmatched` | 🟢 ready | `min(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Memory","NonHeapMemoryUsage.used"],10m)>(` |
| 17 | HIVE METASTORE Generic Java JMX: OperatingSystem: Opened file descriptor count is high | ✅ `matched` | 🟢 ready | `min(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=OperatingSystem","OpenFileDescriptorCount` |
| 18 | HIVE METASTORE Generic Java JMX: Threading,ThreadCount is great than 10000 | ✅ `matched` | 🟢 ready | `last(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Threading","ThreadCount"])>10000` |
| 19 | HIVE METASTORE Generic Java JMX: Runtime: JVM is not reachable | ✅ `matched` | 🟢 ready | `nodata(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Runtime","Uptime"],1m)=1` |
| 20 | Generic Java JMX: Runtime: {HOST.NAME} runs suboptimal VM type | ⏳ `unmatched` | 🔶 blocked_exporter | `find(/Templates HIVE METASTORE Java JMX/jmx["java.lang:type=Runtime","VmName"],,"like","Server")<>1` |
| 21 | HMS MYSQL ERROR (maybe deadlock or Retrying HMSHandler) | ⏳ `unmatched` | 🔶 blocked_exporter | `bytelength(last(/Template Hive Metastore/hms_deadlock))>0` |
| 22 | HiveServer2 thread block count gt 50 | ✅ `matched` | 🟢 ready | `last(/Template hadoop3 Hive HiveServer2/hive.hiveserver2.threads.blocked.count)>50 and count(/Templa` |
| 23 | HiveServer2_too_many_open_files | ✅ `matched` | 🟢 ready | `bytelength(last(/Template hadoop3 Hive HiveServer2/hs2_toomanyopenfiles))>0` |
| 24 | Hive Metastore Port is DOWN | ✅ `matched` | 🟢 ready | `last(/Template Hive Metastore/net.tcp.listen[9083])=0` |
| 25 | Process of Hive Metastore is DEAD | ✅ `matched` | 🟢 ready | `last(/Template Hive Metastore/proc.num[,,,"org.apache.hadoop.hive.metastore.HiveMetaStore"])=0` |

### ELASTICSEARCH（43 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718659)

> 💡 **分析结论**：20 matched + 3 平台有指标可建规则 + 20 per-IP 探测建议 retire

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | ElasticSearch Cluster Status is Yellow | ✅ `matched` | 🟢 ready | `count(/ELK cluster op online/elastizabbix[health,status],#10,"like","yellow")=15` |
| 2 | Elasticsearch Node is changed | ✅ `matched` | 🟢 ready | `(last(/ELK cluster op online/elastizabbix[cluster,nodes.count.total],#1)<>last(/ELK cluster op onlin` |
| 3 | too many open files | ✅ `matched` | 🔵 triage | `last(/ELK jmx/jmx["java.lang:type=OperatingSystem",OpenFileDescriptorCount])/last(/ELK jmx/jmx["java` |
| 4 | full gc frequenctly | ⏳ `unmatched` | 🔵 triage | `(max(/ELK jmx/jmx["java.lang:type=GarbageCollector,name=G1 Old Generation", CollectionCount],600s)-m` |
| 5 | ElasticSearch Cluster Status is Red | ✅ `matched` | 🟢 ready | `find(/ELK cluster/elastizabbix[health,status],,"like","red")=1 and find(/ELK cluster/elastizabbix[he` |
| 6 | ElasticSearch Cluster Status is Yellow | ✅ `matched` | 🟢 ready | `count(/ELK cluster/elastizabbix[health,status],#10,"like","yellow")=10 and find(/ELK cluster/elastiz` |
| 7 | Unassigned Shards | ✅ `matched` | 🟢 ready | `min(/ELK cluster/elastizabbix[health,unassigned_shards],10m)>0 and find(/ELK cluster/elastizabbix[he` |
| 8 | Elasticsearch Node is changed | ⏳ `unmatched` | 🔵 triage | `last(/ELK cluster/elastizabbix[cluster,nodes.count.total])<7 and find(/ELK cluster/elastizabbix[heal` |
| 9 | bd-es-online write queue 大于1000 节点 | ✅ `matched` | 🟢 ready | `change(/Template ES ALERT/es_queue)<>0` |
| 10 | ES 负载高 Processor load is too high on | ✅ `matched` | 🟢 ready | `last(/ELK base monitor/system.cpu.load[percpu,avg10])>2` |
| 11 | ES bd-es-online 107 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[107 coordinator http test,api测试],#2,"ne",200)=2` |
| 12 | ES bd-es-online 117 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[117 coordinator http test,api测试],#2,"ne",200)=2` |
| 13 | ES bd-es-online 118 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[118 coordinator http test,api测试],#2,"ne",200)=2` |
| 14 | ES bd-es-online 119 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[119 coordinator http test,api测试],#2,"ne",200)=2` |
| 15 | ES bd-es-online 120 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[120 coordinator http test,api测试],#2,"ne",200)=2` |
| 16 | ES bd-es-online 121 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[121 coordinator http test,api测试],#2,"ne",200)=2` |
| 17 | ES bd-es-online 122 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[122 coordinator http test,api测试],#2,"ne",200)=2` |
| 18 | ES bd-es-online 124 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[124 coordinator http test,api测试],#2,"ne",200)=2` |
| 19 | ES bd-es-online 99 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[99 coordinator http test,api测试],#2,"ne",200)=2` |
| 20 | ES bd-es-online 102 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[102 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 21 | ES bd-es-online 99 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[99 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 22 | ES bd-es-online 107 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[107 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 23 | ES bd-es-online 117 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[117 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 24 | ES bd-es-online 118 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[118 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 25 | ES bd-es-online 119 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[119 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 26 | ES bd-es-online 120 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[120 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 27 | ES bd-es-online 121 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[121 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 28 | ES bd-es-online 122 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[122 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 29 | ES bd-es-online 124 coordinator http api timeout great than 4s | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.time[124 coordinator http test,api测试,resp],#2,"gt",4)=2` |
| 30 | bd_es_online_published_state_timeout(may be cluster will stuck) | ✅ `matched` | 🟢 ready | `bytelength(last(/Template bd-es-online master/elk_published_state_timeout))>0` |
| 31 | ES bd-es-online 102 coordinator http api test timeout | ⏳ `unmatched` | 🔶 blocked_exporter | `count(/Template ES ALERT/web.test.rspcode[102 coordinator http test,api测试],#2,"ne",200)=2` |
| 32 | bd_es_online_master_error_and_failed（出现error failed日志） | ✅ `matched` | 🟢 ready | `bytelength(last(/Template bd-es-online master/elk_master_error))>0` |
| 33 | bd_log_es_published_state_timeout(may be cluster will stuck) | ✅ `matched` | 🟢 ready | `bytelength(last(/Template bd-log-es Master Log/elk_published_state_timeout))>0` |
| 34 | bd-logs-es 发现write-queue 大于12000 节点 | ✅ `matched` | 🟢 ready | `find(/Template ES ALERT/es_write_queue_bd_logs,,"iregexp","write")=1` |
| 35 | bd_log_es_master_leader_change | ✅ `matched` | 🟢 ready | `change(/Template bd-log-es Master HTTP/elk_master_info)<>0` |
| 36 | bd_log_es_node-left_or_node-join | ✅ `matched` | 🟢 ready | `bytelength(last(/Template bd-log-es Master Log/elk_master_disconnect_exception))>0` |
| 37 | ElasticSearch Cluster Status is Red | ✅ `matched` | 🟢 ready | `find(/ELK cluster/elastizabbix[health,status],,"like","red")=1 and find(/ELK cluster/elastizabbix[he` |
| 38 | ElasticSearch Cluster Status is Yellow | ✅ `matched` | 🟢 ready | `count(/ELK cluster/elastizabbix[health,status],#10,"like","yellow")=10 and find(/ELK cluster/elastiz` |
| 39 | Unassigned Shards | ✅ `matched` | 🟢 ready | `min(/ELK cluster/elastizabbix[health,unassigned_shards],10m)>0 and find(/ELK cluster/elastizabbix[he` |
| 40 | Elasticsearch Node is changed | ✅ `matched` | 🟢 ready | `last(/ELK cluster/elastizabbix[cluster,nodes.count.total])<7 and find(/ELK cluster/elastizabbix[heal` |
| 41 | ElasticSearch Cluster Status is Red | ✅ `matched` | 🟢 ready | `find(/ELK cluster video online/elastizabbix[health,status],,"like","red")=1` |
| 42 | Unassigned Shards | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/ELK cluster video online/elastizabbix[health,unassigned_shards],10m)>0` |
| 43 | ElasticSearch Cluster Status is Red | ✅ `matched` | 🟢 ready | `count(/ELK cluster op online/elastizabbix[health,status],#2,"like","yellow")=10` |

### DRUID（10 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718664)

> 💡 **分析结论**：5 matched + 3 Categraf + 2 jmx_exporter 补充

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Process of Druid broker is Dead | ✅ `matched` | 🔵 triage | `last(/Template Druid broker/proc.num[,,,"org.apache.druid.cli.Main server broker"])=0` |
| 2 | Process of Druid coordinator is Dead | ✅ `matched` | 🔵 triage | `last(/Template Druid coordinator/proc.num[,,,"org.apache.druid.cli.Main server coordinator"])=0` |
| 3 | Process of Druid historical is Dead | ⏳ `unmatched` | 🔵 triage | `last(/Template Druid historical/proc.num[,,,"org.apache.druid.cli.Main server historical"])=0` |
| 4 | Process of Druid router is Dead | ✅ `matched` | 🔵 triage | `last(/Template Druid router/proc.num[,,,"org.apache.druid.cli.Main server router"])=0` |
| 5 | Process of Druid overlord is Dead | ✅ `matched` | 🔵 triage | `last(/Template Druid overlord/proc.num[,,,"org.apache.druid.cli.Main server overlord"])=0` |
| 6 | Process of Druid middleManager is Dead | ⏳ `unmatched` | 🔵 triage | `last(/Template Druid middleManager/proc.num[,,,"org.apache.druid.cli.Main server middleManager"])=0` |
| 7 | Druid broker has become unhealthy | ✅ `matched` | 🔵 triage | `last(/Template Druid broker/druid.broker.health)<>"true"` |
| 8 | Druid Coordinator 发生选举 | ⏳ `unmatched` | 🔵 triage | `(last(/Template Apache Druid Task Monitor/druid.getboss[coordinator],#1)<>last(/Template Apache Drui` |
| 9 | Druid Overlord 发生选举 | ⏳ `unmatched` | 🔵 triage | `(last(/Template Apache Druid Task Monitor/druid.getboss[overlord],#1)<>last(/Template Apache Druid T` |
| 10 | Druid router 查询失败 | ⏳ `unmatched` | 🔵 triage | `last(/Template Druid router/druid.query[*UNKNOWN*]) <> 1` |

### INFRA_BASIC（80 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718658)

> 💡 **分析结论**：27 matched + 5 mixed + 14 Categraf ready + 14 nginx-exporter blocked + 10 OS基础指标待Categraf + 6 retire + 4 dpvs/tinyproxy特殊处理

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Too many processes running on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `avg(/Template OS Linux Active For NodeManager/proc.num[,,run],5m)>100` |
| 2 | Too many processes on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `avg(/Template OS Linux Active For NodeManager/proc.num[],5m)>2000` |
| 3 | find new read only file system ｜ 磁盘健康状况不良[/var/log/messages] | 🔀 `mixed:matched|unmatched` | mixed:blocked_exporter|ready | `last(/Template OS Linux Active For NodeManager/disk_health)=2` |
| 4 | Server PING 大于10ms | 🔀 `mixed:matched|unmatched` | 🟢 ready | `last(/Template OS Linux Active For NodeManager/server-ping.sh[*UNKNOWN*])>10` |
| 5 | /etc/passwd has been changed on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template OS Linux Active For NodeManager/vfs.file.cksum[/etc/passwd],#1)<>last(/Template OS L` |
| 6 | Configured max number of processes is too low on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template OS Linux Active For NodeManager/kernel.maxproc)<256` |
| 7 | Hostname was changed on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template OS Linux Active For NodeManager/system.hostname,#1)<>last(/Template OS Linux Active ` |
| 8 | Host name of zabbix_agentd was changed on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template OS Linux Active core 1160/agent.hostname,#1)<>last(/Template OS Linux Active core 11` |
| 9 | Configured max number of opened files is too low on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template OS Linux Active For NodeManager/kernel.maxfiles)<1024` |
| 10 | Lack of available memory on server {HOST.NAME} | ⏳ `unmatched` | 🟢 ready | `last(/Template OS Linux Active For NodeManager/vm.memory.size[available])<20M` |
| 11 | Disk I/O is overloaded on {HOST.NAME} | ✅ `matched` | 🟢 ready | `avg(/Template OS Linux Active core 1160/system.cpu.util[,iowait],5m)>50` |
| 12 | linux kernel version on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `nodata(/Template OS Linux Active For NodeManager/system.uname,5m)=1 and\nnodata(/Template OS Linux A` |
| 13 | 磁盘健康状况不良[/var/log/messages] | ⏳ `unmatched` | 🔶 blocked_exporter | `bytelength(last(/Template OS Linux Active For NodeManager/disk_health))>120` |
| 14 | 内存cgroup 超过3W | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template OS Linux Active For NodeManager/cgroup.mem.count)>30000` |
| 15 | Hardware Monitor Smartctl Found Error Disk | ✅ `matched` | 🟢 ready | `find(/Template OS Linux Active For NodeManager/disk_smart,,"iregexp","Smartctl Found Error")>0` |
| 16 | 服务器{HOST.NAME}的buff/cache内存1分钟内增量大于35% | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template OS Linux Active For NodeManager/vm.memory.size[buffcacheadd])/ last(/Template OS Linu` |
| 17 | Host information was changed on {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template OS Linux Active For NodeManager/system.uname,#1)<>last(/Template OS Linux Active For` |
| 18 | Processor load is too high on {HOST.NAME} | 🔀 `mixed:matched|unmatched` | mixed:blocked_exporter|ready | `avg(/Template OS Linux/system.cpu.load[percpu,avg1],5m)>5` |
| 19 | Nginx: High connections drop rate (more than {$NGINX.DROP_RATE.MAX.WARN} for 5m) | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Template App Nginx by HTTP/nginx.connections.dropped.rate,5m) > 1` |
| 20 | Nginx: Version has changed (new version: {ITEM.VALUE}) | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template App Nginx by HTTP/nginx.version,#1)<>last(/Template App Nginx by HTTP/nginx.version,` |
| 21 | Disk I/O is overloaded on {HOST.NAME} | ✅ `matched` | 🟢 ready | `count(/Template OS Linux Active For NodeManager/system.cpu.util[,iowait],#5,"gt","80")>3` |
| 22 | 服务器物理内存小于1G且swap小于20% | ✅ `matched` | 🟢 ready | `avg(/Template OS Linux Active For NodeManager/system.swap.size[,pfree],5m)<20 and avg(/Template OS L` |
| 23 | 服务器{HOST.NAME}内存使用率大于90% | 🔀 `mixed:matched|unmatched` | 🟢 ready | `last(/Template OS Linux Active For NodeManager/vm.memory.rate)>90` |
| 24 | {HOST.NAME} has just been restarted | ⏳ `unmatched` | mixed:blocked_exporter|ready | `change(/Template OS Linux Active For NodeManager/system.uptime)<0` |
| 25 | Zabbix agent on {HOST.NAME} is unreachable for 5 minutes | 🔀 `mixed:matched|unmatched` | mixed:blocked_exporter|ready | `nodata(/Template OS Linux Active For NodeManager/agent.ping,5m)=1` |
| 26 | 系统日志出现异常状况[/var/log/messages] | ✅ `matched` | 🟢 ready | `bytelength(last(/Template OS Linux Active For NodeManager/syslog_health))>0` |
| 27 | Lack of free swap space on {HOST.NAME} | ✅ `matched` | 🟢 ready | `last(/Template OS Linux/system.swap.size[,pfree])<50` |
| 28 | CPU空闲率低于5% | ✅ `matched` | 🟢 ready | `avg(/Template OS Linux Active core 1160/system.cpu.util[,idle],10m)<5` |
| 29 | core 1160 {HOST.NAME} has just been restarted | ⏳ `unmatched` | 🟢 ready | `change(/Template OS Linux Active core 1160/system.uptime)<0` |
| 30 | DPVS 服务不可用， VIP 失效 | ⏳ `unmatched` | 🔶 blocked_exporter | `avg(/Template App DPVS/dpvs_mon[-u],300s)=0` |
| 31 | DPVS Session Num Over 1000000 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template App DPVS/dpvs_mon[-s])>1000000` |
| 32 | keepalived服务异常 | ✅ `matched` | 🟢 ready | `last(/Template Keepalived/proc.num[keepalived])<2` |
| 33 | 公网IP获取失败 | ⏳ `unmatched` | 🔶 blocked_exporter | `length(last(/tinyproxy/web.page.regexp[cn.whatismyip.linkedsh.net,,,"((2[0-4]\d｜25[0-5]｜[01]?\d\d?)\` |
| 34 | Lack of available virtual memory on server {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Template OS Windows/vm.vmemory.size[pavailable],10m)<10` |
| 35 | Lack of free memory on server {HOST.NAME} | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template OS Windows/vm.memory.size[free])<10000` |
| 36 | Too many network TIME_WAIT connections on {HOST.NAME} | ✅ `matched` | 🟢 ready | `count(/Template Network Connections for Bigdata/log.count[/proc/net/tcp,"(.*:) (.*) (.*) (06 )",,100` |
| 37 | Nginx: Service response time is too high (over {$NGINX.RESPONSE_TIME.MAX.WARN}s for 5m) | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Template App Nginx by Zabbix agent/net.tcp.service.perf[http,"localhost","80"],5m)>10` |
| 38 | Nginx: Service is down | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template App Nginx by Zabbix agent/net.tcp.service[http,"localhost","80"])=0` |
| 39 | Nginx: Process is not running | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template App Nginx by Zabbix agent/proc.num[nginx])=0` |
| 40 | Nginx: Failed to fetch stub status page (or no data for 30m) | ⏳ `unmatched` | 🔶 blocked_exporter | `find(/Template App Nginx by Zabbix agent/web.page.get["localhost","basic_status","80"],,"like","HTTP` |
| 41 | Nginx: Service response time is too high (over {$NGINX.RESPONSE_TIME.MAX.WARN}s for 5m) | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Template App Nginx by HTTP/net.tcp.service.perf[http,"*UNKNOWN*","80"],5m)>10` |
| 42 | Nginx: Service is down | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template App Nginx by HTTP/net.tcp.service[http,"*UNKNOWN*","80"])=0` |
| 43 | Nginx: Failed to fetch stub status page (or no data for 30m) | ⏳ `unmatched` | 🔶 blocked_exporter | `find(/Template App Nginx by HTTP/nginx.get_stub_status,,"like","HTTP/1.1 200")=0 or\n nodata(/Templa` |
| 44 | Nginx: High connections drop rate (more than {$NGINX.DROP_RATE.MAX.WARN} for 5m) | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Template App Nginx Plus by HTTP/nginx.connections.dropped,5m) > 1` |
| 45 | Nginx: Server response error (text: {ITEM.VALUE}) | ⏳ `unmatched` | 🔶 blocked_exporter | `length(last(/Template App Nginx Plus by HTTP/nginx.info.error))>0` |
| 46 | Nginx: Failed to fetch info data (or no data for 30m) | ⏳ `unmatched` | 🔶 blocked_exporter | `nodata(/Template App Nginx Plus by HTTP/nginx.info.uptime,30m)=1` |
| 47 | Nginx: has been restarted (uptime < 10m) | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template App Nginx Plus by HTTP/nginx.info.uptime)<10m` |
| 48 | Nginx: Version has changed (new version: {ITEM.VALUE}) | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template App Nginx Plus by HTTP/nginx.info.version,#1)<>last(/Template App Nginx Plus by HTTP` |
| 49 | Unavailable by ICMP ping | ✅ `matched` | 🟢 ready | `max(/ICMP Ping/icmpping,#3)=0` |
| 50 | High ICMP ping loss | ⏳ `unmatched` | 🟢 ready | `min(/ICMP Ping/icmppingloss,5m)>20 and min(/ICMP Ping/icmppingloss,5m)<100` |
| 51 | High ICMP ping response time | ⏳ `unmatched` | 🟢 ready | `avg(/ICMP Ping/icmppingsec,5m)>0.15` |
| 52 | cpu空闲率持续10分钟低于5%且2分钟内未恢复 | ✅ `matched` | 🟢 ready | `count(/Template OS Linux Active/system.cpu.util[,idle],#11,"lt","5")=11` |
| 53 | 服务器{HOST.NAME}内存使用率大于90% | ✅ `matched` | 🟢 ready | `(1 - last(/Template OS Test/vm.memory.size[available]) / last(/Template OS Test/vm.memory.size[total` |
| 54 | Chrony or NTP service is down on {HOST.NAME} | ✅ `matched` | 🟢 ready | `max(/Template Time synchronization/proc.num[,chrony],#1)=0 and max(/Template Time synchronization/pr` |
| 55 | Misalignment of the upper NTP has exceeded the 5s [{$NTP_IP}] | ✅ `matched` | 🟢 ready | `last(/NTP-remote/system.run[ntpq -p 127.0.0.1｜grep \* ｜awk '{print$9}'])>5000 or last(/NTP-remote/sy` |
| 56 | Misalignment of the upper NTP has exceeded the 50ms [{$NTP_IP}] | ✅ `matched` | 🟢 ready | `last(/NTP-remote/system.run[ntpq -p 127.0.0.1｜grep \* ｜awk '{print$9}'])>50 or last(/NTP-remote/syst` |
| 57 | Misalignment of the upper NTP has exceeded the 5s | ✅ `matched` | 🟢 ready | `last(/NTP_Monitoring/system.run[ntpq -p｜grep \* ｜awk '{print$9}'])>5000 or last(/NTP_Monitoring/syst` |
| 58 | Misalignment of the upper NTP has exceeded the 50ms | ✅ `matched` | 🟢 ready | `last(/NTP_Monitoring/system.run[ntpq -p｜grep \* ｜awk '{print$9}'])>50 or last(/NTP_Monitoring/system` |
| 59 | CPU load is too high on {HOST.NAME} | ⏳ `unmatched` | 🟢 ready | `min(/Template OS Linux Active/system.cpu.load[all,avg1],5m)/last(/Template OS Linux Active/system.cp` |
| 60 | Too many network CLOSE_WAIT connections on {HOST.NAME} | ✅ `matched` | 🟢 ready | `count(/Template Network Connections for Bigdata/log.count[/proc/net/tcp,"(.*:) (.*) (.*) (08 )",,100` |
| 61 | 系统健康状况不良[/var/log/messages] | ✅ `matched` | 🟢 ready | `find(/Template OS Linux Active/disk_health,#1,"like","EXT4-fs error")=1 or find(/Template OS Linux A` |
| 62 | CPU I/O load is overloaded on {HOST.NAME} iowait > 40 | ✅ `matched` | 🟢 ready | `last(/Template OS Linux Active/system.cpu.util[,iowait])>40` |
| 63 | keepalive_proc | ✅ `matched` | 🟢 ready | `last(/template_app_keepalived/proc.num[keepalived,root])=0` |
| 64 | Tinyproxy端口DOWN | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/tinyproxy/net.tcp.port[0.0.0.0,8888])=0` |
| 65 | Tinyproxy进程不正常 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/tinyproxy/proc.num[,tinyproxy])=0` |
| 66 | ETCD server Port is DOWN | ⏳ `unmatched` | 🟢 ready | `last(/Template ETCD Server/net.tcp.listen[2379])=0 or last(/Template ETCD Server/net.tcp.listen[2380` |
| 67 | Process of ETCD server is DEAD | ✅ `matched` | 🟢 ready | `last(/Template ETCD Server/proc.num[,"etcd",,"/usr/bin/etcd"])=0` |
| 68 | ES Keepalived: state change from BACKUP to MASTER | ✅ `matched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99],#2)=0 and last(/Template LVS Keepali` |
| 69 | KIBANA Keepalived: state change from MASTER to BACKUP | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100],#2)>0 and last(/Template LVS Keepal` |
| 70 | ES Keepalived: state is BACKUP but it's not a router | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99])=0 and last(/Template LVS Keepalived` |
| 71 | KIBANA Keepalived: state is BACKUP but it's stopped | ✅ `matched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100])=0 and last(/Template LVS Keepalive` |
| 72 | ES Keepalived: state is MASTER but it's not a router | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99])>0 and last(/Template LVS Keepalived` |
| 73 | ES Keepalived: state is MASTER but it's stopped | ✅ `matched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99])>0 and last(/Template LVS Keepalived` |
| 74 | Too many network connections on {HOST.NAME} | ✅ `matched` | 🟢 ready | `last(/Template Network Connections/log.count[/proc/net/tcp,"(.*:) (.*) (.*) (01 )",,1000,all,])>2000` |
| 75 | KIBANA Keepalived: state change from BACKUP to MASTER | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100],#2)=0 and last(/Template LVS Keepal` |
| 76 | ES Keepalived: state change from MASTER to BACKUP | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99],#2)>0 and last(/Template LVS Keepali` |
| 77 | KIBANA Keepalived: state is BACKUP but it's not a router | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100])=0 and last(/Template LVS Keepalive` |
| 78 | ES Keepalived: state is BACKUP but it's stopped | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.99])=0 and last(/Template LVS Keepalived` |
| 79 | KIBANA Keepalived: state is MASTER but it's not a router | ✅ `matched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100])>0 and last(/Template LVS Keepalive` |
| 80 | KIBANA Keepalived: state is MASTER but it's stopped | ⏳ `unmatched` | 🟢 ready | `last(/Template LVS Keepalived/es_keepalived_master[10.19.15.100])>0 and last(/Template LVS Keepalive` |

### KAFKA（16 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718662)

> 💡 **分析结论**：4 条平台已有 kafka_controller_* 指标可建规则 + 3 Categraf + 8 条需补充 jmx_exporter（ISR/RequestTotalTimeMs 等）+ 1 OfflineLogDirectory

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Kafka 主机负载 过高Processor load is too high | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/system.cpu.load[percpu,avg14])>3` |
| 2 | RequestTotalTimeMs_Produce 两分钟无数据 | ⏳ `unmatched` | 🔶 blocked_exporter | `nodata(/Template Kafka/jmx["kafka.network:type=RequestMetrics,name=TotalTimeMs,request=Produce",Mean` |
| 3 | RequestTotalTimeMs_Consume 两分钟无数据 | ⏳ `unmatched` | 🔶 blocked_exporter | `nodata(/Template Kafka/jmx["kafka.network:type=RequestMetrics,name=TotalTimeMs,request=FetchConsumer` |
| 4 | OfflineLogDirectoryCount 文件系统故障 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/jmx["kafka.log:type=LogManager,name=OfflineLogDirectoryCount", Value])>0` |
| 5 | kafka Controller 发生切换 | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template Kafka/jmx["kafka.controller:type=KafkaController,name=ActiveControllerCount",Value]` |
| 6 | Kafka 发生 UncleanLeaderElections | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template Kafka/jmx["kafka.controller:type=ControllerStats,name=UncleanLeaderElectionsPerSec"` |
| 7 | Kafka服务端口{$KAFKA_PORT}-DOWN | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/net.tcp.listen[{$KAFKA_PORT}])=0` |
| 8 | Kafka进程终止 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/proc.num[,kafka,,kafka])=0` |
| 9 | Kafka Broker 内存使用率超过90% | ⏳ `unmatched` | 🔶 blocked_exporter | `avg(/Template Kafka/memory.pused,1m) > 90` |
| 10 | broker文件句柄使用率 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/jmx["java.lang:type=OperatingSystem",OpenFileDescriptorCount])/last(/Template K` |
| 11 | Too many OfflinePartitionsCount | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/jmx["kafka.controller:type=KafkaController,name=OfflinePartitionsCount", Value]` |
| 12 | 发生脏Leader Election | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template Kafka/jmx["kafka.controller:type=ControllerStats,name=UncleanLeaderElectionsPerSec",` |
| 13 | 发生Leader Election | ⏳ `unmatched` | 🔶 blocked_exporter | `(last(/Template Kafka/jmx["kafka.controller:type=ControllerStats,name=LeaderElectionRateAndTimeMs",C` |
| 14 | ISR收缩 | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template Kafka/jmx["kafka.server:type=ReplicaManager,name=IsrShrinksPerSec", Count])>0` |
| 15 | ISR扩展 | ⏳ `unmatched` | 🔶 blocked_exporter | `change(/Template Kafka/jmx["kafka.server:type=ReplicaManager,name=IsrExpandsPerSec", Count])>0` |
| 16 | ISR收缩率过高 | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Kafka/jmx["kafka.server:type=ReplicaManager,name=IsrShrinksPerSec", OneMinuteRate])>2` |

### ZOOKEEPER（9 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718663)

> 💡 **分析结论**：平台指标为 0；全部 9 条通过 Categraf ZooKeeper 插件（mntr 命令）覆盖

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Zookeeper: Too many queued requests | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Hadoop3 Zookeeper/zookeeper.outstanding_requests,5m)>10` |
| 2 | Zookeeper: Server mode has changed | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Hadoop3 Zookeeper/zookeeper.server_state,#1)<>last(/Hadoop3 Zookeeper/zookeeper.server_state,#` |
| 3 | Zookeeper: Version has changed | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Hadoop3 Zookeeper/zookeeper.version,#1)<>last(/Hadoop3 Zookeeper/zookeeper.version,#2) and len` |
| 4 | Zookeeper: Too many file descriptors used | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Hadoop3 Zookeeper/zookeeper.open_file_descriptor_count,5m) * 100 / last(/Hadoop3 Zookeeper/zook` |
| 5 | Zookeeper: Too many file descriptors used > 1000 | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Hadoop3 Zookeeper/zookeeper.open_file_descriptor_count,5m) > 1000` |
| 6 | Zookeeper: znode_count > 200000 | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Hadoop3 Zookeeper/zookeeper.znode_count,5m) > 200000` |
| 7 | Zookeeper: zookeeper.max_latency > 100 | ⏳ `unmatched` | 🔶 blocked_exporter | `min(/Hadoop3 Zookeeper/zookeeper.max_latency,5m) > 100 and \nchange(/Hadoop3 Zookeeper/zookeeper.max` |
| 8 | Processes of Zookeeper are DEAD | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Zookeeper/proc.num[,,,org.apache.zookeeper.server.quorum.QuorumPeerMain])=0` |
| 9 | Port 2181 of Zookeeper is DOWN | ⏳ `unmatched` | 🔶 blocked_exporter | `last(/Template Zookeeper/net.tcp.listen[2181])=0` |

### JAVA_JVM（7 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718666)

> 💡 **分析结论**：5 条 jmx_exporter 可覆盖通用 JMX 指标；2 条 retire（JIT 编译器类型/VM 类型检测，现代 JVM 无意义）

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Generic Java JMX: Compilation: {HOST.NAME} uses suboptimal JIT compiler | ⏳ `unmatched` | 🔵 triage | `find(/Generic Java JMX/jmx["java.lang:type=Compilation","Name"],,"like","Client")=1` |
| 2 | Generic Java JMX: OperatingSystem: Process CPU Load is high | ⏳ `unmatched` | 🔵 triage | `min(/Generic Java JMX/jmx["java.lang:type=OperatingSystem","ProcessCpuLoad"],5m)>85` |
| 3 | Generic Java JMX: Runtime: JVM is not reachable | ⏳ `unmatched` | 🔵 triage | `nodata(/Generic Java JMX/jmx["java.lang:type=Runtime","Uptime"],5m)=1` |
| 4 | Generic Java JMX: Runtime: {HOST.NAME} runs suboptimal VM type | ⏳ `unmatched` | 🔵 triage | `find(/Generic Java JMX/jmx["java.lang:type=Runtime","VmName"],,"like","Server")<>1` |
| 5 | Generic Java JMX: Memory: Heap memory usage is high | ⏳ `unmatched` | 🔵 triage | `min(/Generic Java JMX/jmx["java.lang:type=Memory","HeapMemoryUsage.used"],10m)>(last(/Generic Java J` |
| 6 | Generic Java JMX: Memory: Non-Heap memory usage is high | ⏳ `unmatched` | 🔵 triage | `min(/Generic Java JMX/jmx["java.lang:type=Memory","NonHeapMemoryUsage.used"],10m)>(last(/Generic Jav` |
| 7 | Generic Java JMX: OperatingSystem: Opened file descriptor count is high | ⏳ `unmatched` | 🔵 triage | `min(/Generic Java JMX/jmx["java.lang:type=OperatingSystem","OpenFileDescriptorCount"],3m)>(last(/Gen` |

### AMBARI（3 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718667)

> 💡 **分析结论**：3 条全为 Categraf procstat/net_response（进程存活+端口探活）

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Process of Ambari Server is DEAD | ⏳ `unmatched` | 🔵 triage | `last(/Template Ambari Server/proc.num[,,,"org.apache.ambari.server.controller.AmbariServer"])=0` |
| 2 | Ambari Server connection refused | ⏳ `unmatched` | 🔵 triage | `last(/Template Ambari Server/net.tcp.service[http,*UNKNOWN*,8080])=0` |
| 3 | Ambari Server api test timeout (2分钟内无响应） | ⏳ `unmatched` | 🔵 triage | `nodata(/Template Ambari Server/web.test.rspcode[Ambari Server HTTP status codes,api测试],2m)=1` |

### KYUUBI（2 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718668)

> 💡 **分析结论**：2 条全为 Categraf net_response + procstat

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Kyuubi Port is Down | ⏳ `unmatched` | 🔵 triage | `last(/Template App Kyuubi/net.tcp.listen[10009])=0` |
| 2 | Kyuubi Process is DEAD | ⏳ `unmatched` | 🔵 triage | `last(/Template App Kyuubi/proc.num[,,,"org.apache.kyuubi.server.KyuubiServer"])=0` |

### RANGER（2 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718669)

> 💡 **分析结论**：2 条全为 Categraf net_response + procstat

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Hadoop3 Process of Ranger Admin is DEAD | ⏳ `unmatched` | 🔵 triage | `last(/Template hadoop3 Ranger Admin/proc.num[,,,"servername=rangeradmin"])=0` |
| 2 | Hadoop3 Port 6080 of Ranger Admin is DOWN | ⏳ `unmatched` | 🔵 triage | `last(/Template hadoop3 Ranger Admin/net.tcp.listen[6080])=0` |

### TRINO（2 条）｜[Confluence 详情](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107718670)

> 💡 **分析结论**：1 matched（Web UI 探活）+ 1 平台有 trino_memory_MemoryPool_* 指标可直接建规则

| # | 规则名称 | 迁移状态 | 可行性 | 表达式样例 |
|---|---|---|---|---|
| 1 | Trino web 信息获取失败 | ✅ `matched` | 🔵 triage | `nodata(/Template Trino Coordinator/trino_web_nodes_info,600s)=1` |
| 2 | Trino 角色内存使用 Over 90% | ⏳ `unmatched` | 🔵 triage | `last(/Trino JMX Monitor/jmx["java.lang:type=Memory","HeapMemoryUsage.used"])/last(/Trino JMX Monitor` |

---

## 🚫 跳过服务规则清单（仅供参考）

### zabbix_infra（78 条）— Zabbix 自身监控，迁移后无需保留，直接废弃

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | Version of zabbix_agent(d) was changed on {HOST.NAME} | triage |
| 2 | Host name of zabbix_agentd was changed on {HOST.NAME} | triage |
| 3 | Zabbix server: More than 100 items having missing data for m | triage |
| 4 | Zabbix agent on {HOST.NAME} is unreachable for 5 minutes | triage |
| 5 | Zabbix server: Utilization of alerter processes is high | triage |
| 6 | Zabbix server: Utilization of configuration syncer processes | triage |
| 7 | Zabbix server: Utilization of escalator processes is high | triage |
| 8 | Zabbix server: Utilization of history syncer processes is hi | triage |
| 9 | Zabbix server: Utilization of housekeeper processes is high | triage |
| 10 | Zabbix server: Utilization of http poller processes is high | triage |
| 11 | Zabbix server: Utilization of icmp pinger processes is high | triage |
| 12 | Zabbix server: Utilization of ipmi poller processes is high | triage |
| 13 | Zabbix server: Utilization of poller processes is high | triage |
| 14 | Zabbix server: Utilization of proxy poller processes is high | triage |
| 15 | Zabbix server: Utilization of self-monitoring processes is h | triage |
| 16 | Zabbix server: Utilization of timer processes is high | triage |
| 17 | Zabbix server: Utilization of trapper processes is high | triage |
| 18 | Zabbix server: Utilization of unreachable poller processes i | triage |
| 19 | Zabbix server: Utilization of vmware collector processes is  | triage |
| 20 | Zabbix server: Utilization of java poller processes is high | triage |
| 21 | Zabbix server: Utilization of snmp trapper processes is high | triage |
| 22 | Less than 25% free in the configuration cache | triage |
| 23 | Less than 25% free in the history cache | triage |
| 24 | Less than 25% free in the history index cache | triage |
| 25 | More than 100 items having missing data for more than 10 min | triage |
| 26 | Zabbix configuration syncer processes more than 75% busy | triage |
| 27 | Zabbix discoverer processes more than 75% busy | triage |
| 28 | Zabbix history syncer processes more than 75% busy | triage |
| 29 | Zabbix housekeeper processes more than 75% busy | triage |
| 30 | Zabbix http poller processes more than 75% busy | triage |
| 31 | Zabbix icmp pinger processes more than 75% busy | triage |
| 32 | Zabbix ipmi poller processes more than 75% busy | triage |
| 33 | Zabbix java poller processes more than 75% busy | triage |
| 34 | Zabbix poller processes more than 75% busy | triage |
| 35 | Zabbix self-monitoring processes more than 75% busy | triage |
| 36 | Zabbix snmp trapper processes more than 75% busy | triage |
| 37 | Zabbix trapper processes more than 75% busy | triage |
| 38 | Zabbix unreachable poller processes more than 75% busy | triage |
| 39 | Zabbix data sender processes more than 75% busy | triage |
| 40 | Zabbix heartbeat sender processes more than 75% busy | triage |
| 41 | Zabbix server: Zabbix value cache working in low memory mode | triage |
| 42 | Zabbix server: Utilization of task manager processes is high | triage |
| 43 | Zabbix server: Utilization of ipmi manager processes is high | triage |
| 44 | Zabbix ipmi manager processes more than 75% busy | triage |
| 45 | Zabbix task manager processes more than 75% busy | triage |
| 46 | Zabbix server: Utilization of alert manager processes is hig | triage |
| 47 | Zabbix server: Utilization of preprocessing manager processe | triage |
| 48 | Zabbix server: Utilization of preprocessing worker processes | triage |
| 49 | Server PING 大于10ms | triage |
| 50 | Zabbix server: Utilization of agent poller processes is high | triage |
| 51 | Zabbix server: Utilization of availability manager processes | triage |
| 52 | Zabbix server: Utilization of browser poller processes is hi | triage |
| 53 | Zabbix server: Utilization of configuration syncer worker pr | triage |
| 54 | Zabbix server: Utilization of connector manager processes is | triage |
| 55 | Zabbix server: Utilization of connector worker processes is  | triage |
| 56 | Zabbix server: Utilization of discovery manager processes is | triage |
| 57 | Zabbix server: Utilization of discovery worker processes is  | triage |
| 58 | Zabbix server: Utilization of history poller processes is hi | triage |
| 59 | Zabbix server: Utilization of http agent poller processes is | triage |
| 60 | Zabbix server: Utilization of internal poller processes is h | triage |
| 61 | Zabbix server: Utilization of ODBC poller processes is high | triage |
| 62 | Zabbix server: Utilization of proxy group manager processes  | triage |
| 63 | Zabbix server: Utilization of report manager processes is hi | triage |
| 64 | Zabbix server: Utilization of report writer processes is hig | triage |
| 65 | Zabbix server: Utilization of service manager processes is h | triage |
| 66 | Zabbix server: Utilization of snmp poller processes is high | triage |
| 67 | Zabbix server: Utilization of trigger housekeeper processes  | triage |
| 68 | Zabbix server: Version has changed | triage |
| 69 | Hostname was changed on {HOST.NAME} | triage |
| 70 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"configura | triage |
| 71 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"history c | triage |
| 72 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"index cac | triage |
| 73 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"trend cac | triage |
| 74 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"vmware ca | triage |
| 75 | Zabbix server: More than {$ZABBIX.SERVER.UTIL.MAX:"value cac | triage |
| 76 | Zabbix server: Utilization of alert syncer processes is high | triage |
| 77 | Zabbix server: Utilization of LLD manager processes is high | triage |
| 78 | Zabbix server: Utilization of LLD worker processes is high | triage |

### misc（46 条）— 已重分类归入各服务，本组作废

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | find new read only file system ｜ 磁盘健康状况不良[/var/log/messages] | triage |
| 2 | MySQL: Server has aborted connections (over {$MYSQL.ABORTED_ | triage |
| 3 | MySQL: Number of on-disk temporary tables created per second | triage |
| 4 | MySQL: Number of temporary files created per second is high  | triage |
| 5 | MySQL: Server has slow queries (over {$MYSQL.SLOW_QUERIES.MA | triage |
| 6 | MySQL: Failed to fetch info data (or no data for 30m) | triage |
| 7 | MySQL: Buffer pool utilization is too low (less {$MYSQL.BUFF | triage |
| 8 | MySQL: Refused connections (max_connections limit reached) | triage |
| 9 | MySQL: Number of internal temporary tables created per secon | triage |
| 10 | MySQL: Service has been restarted (uptime < 10m) | triage |
| 11 | Flume EventTakeSuccessCount has not changed within 60 minute | triage |
| 12 | Flume Agent is DOWN | triage |
| 13 | Flume Channel Fill is FULL | triage |
| 14 | Port 80 of Nginx Processes is DOWN | triage |
| 15 | Nginx process terminates | triage |
| 16 | Thanos rule DOWN, HTTP Test Timeout (2分钟内无响应） | triage |
| 17 | Consul Server DOWN, HTTP 10.18.128.125:8500 Test Timeout (2分 | triage |
| 18 | Host name of zabbix_agentd was changed on {HOST.NAME} | triage |
| 19 | Zabbix agent on {HOST.NAME} is unreachable for 5 minutes | triage |
| 20 | Hostname was changed on {HOST.NAME} | triage |
| 21 | Host information was changed on {HOST.NAME} | triage |
| 22 | 服务器物理内存小于1G且swap小于20% | triage |
| 23 | linux kernel version on {HOST.NAME} | triage |
| 24 | 内存cgroup 超过3W | triage |
| 25 | Hardware Monitor Smartctl Found Error Disk | triage |
| 26 | 持续告警测试用 | triage |
| 27 | Port of Sentry is DOWN | triage |
| 28 | Sentry Web Process is DEAD | triage |
| 29 | Zabbix test item ti-A1 equals 0 | triage |
| 30 | Zabbix test item ti-B2 equals 0 | triage |
| 31 | Processes of Kylin are DEAD | triage |
| 32 | Port 7070 of Kylin is DOWN | triage |
| 33 | Port 9005 of Kylin is DOWN | triage |
| 34 | Kerberos进程终止 | triage |
| 35 | [sohuvideo]-分类预测服务端口-DOWN | triage |
| 36 | [sohuvideo]-分类预测服务进程-DOWN | triage |
| 37 | MySQL: Version has changed (new version value received: {ITE | triage |
| 38 | MySQL: Service is down | triage |
| 39 | MySQL: Version has changed (new version value received: {ITE | triage |
| 40 | 链接数触发器 | triage |
| 41 | 活跃链接数触发器 | triage |
| 42 | CDN Flume Agent 进程 DOWN | triage |
| 43 | CDN Flume Agent HTTP 指标端口 DOWN | triage |
| 44 | CDN Flume Agent 指标接口长时间无数据 | triage |
| 45 | Port 5077 is Down | triage |
| 46 | Number of running user processes over 20000 | triage |

### spark（5 条）— H2 规划，暂不处理

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | Process of Spark History Server is DEAD | triage |
| 2 | hadoop3 Port 10016 of Service Spark Thrift Server is DOWN | triage |
| 3 | Port 18081 of Service Spark history Server is DOWN | triage |
| 4 | Process spark thriftserver of is DEAD（Hadoop3) | triage |
| 5 | Spark Thrift Server is unavailable | triage |

### storm（3 条）— Storm 集群基本退役

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | Processes of Storm Supervisors are DEAD | triage |
| 2 | Processes of Storm Nimbus are DEAD | triage |
| 3 | Port 6627 of Storm Nimbus is DOWN | triage |

### docker_k8s（4 条）— K8s 体系独立监控体系，不纳入本次迁移

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | 内存Cgroup大于30000 | triage |
| 2 | Docker: Failed to fetch info data (or no data for 30m) | triage |
| 3 | Docker: Service is down | triage |
| 4 | Docker: Version has changed (new version: {ITEM.VALUE}) | triage |

### mapreduce（2 条）— MapReduce 告警已被 YARN 覆盖

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | Process of MR History Server is DEAD | triage |
| 2 | Hadoop3 Port 19888 of Service MR history Server is DOWN | triage |

### hardware（1 条）— 硬件监控由 IPMI/BMC 独立负责

| # | 规则名称 | 可行性 |
|---|---|---|
| 1 | Version of smartctl was changed on {HOST.NAME} | triage |
