# Foxeye 待手工创建 / 更新规则清单

> 生成时间：2026-05-21  
> 数据来源：本地 `Outbox-产出池/集群可观测建设/confluence-pages/*.html` 与 `progress_summary.html`。  
> 注意：本地部分 HTML 页面写有“2026-06-11 实测”，该日期晚于当前日期，不能作为已发生事实；本文仅按页面中沉淀的规则草稿整理为手工操作清单。

## 汇总

| 类型 | 数量 | 说明 |
|---|---:|---|
| 可直接手工新建 | 16 | YARN 4、ZooKeeper JMX 5、Hive 2、infra_basic 1、Kafka controller 类 4 |
| 需要更新 / 处置现有规则 | 4 | Hive 2757366、HDFS 452219、HDFS 452659/130400 去重、infra_basic 2752519 |
| 前置依赖满足后再建 | 18+ | ZooKeeper 存活 2、Kafka Categraf 2、Kafka JMX 补采集 8、Druid 5、Trino 1 等 |

## 推荐模板

| 场景 | 参考现存规则 / 参数 |
|---|---|
| YARN per-queue 新规则 | 参考现有 YARN 规则组：`group_id=413`，`datasource_id=5`，`notify_rule_ids=[93]`，append tag `service=resourcemanager` |
| ZooKeeper JMX 新规则 | `group_id=394`，`datasource_id=5`，tag `service=zookeeper` |
| Hive Metastore 指标规则 | 参考 HMS Heap 规则 `130426`，`group_id=419`，`datasource_id=5` |
| Hive Loki 规则 | 参考现有 Loki 规则 `2757366`，`group_id=419`，`datasource_id=81`，`cate=loki` |
| infra_basic 主机规则 | `group_id=301`（基础运营组-其他），系统类数据源沿用现有 infra_basic 规则 |

## A. 可直接手工新建

<table>
<thead>
<tr><th>#</th><th>服务</th><th>规则名称</th><th>业务组</th><th>数据源</th><th>表达式</th><th>备注</th></tr>
</thead>
<tbody>
<tr><td>1</td><td>YARN</td><td>hadoop_yarn_subqueue_used_capacity【子队列资源使用率&gt;95%(20min均值)】</td><td>GID=413</td><td>VM=5</td><td><code>avg_over_time(hadoop_yarn_resourcemanager_used_capacity{queue!="root",user="-",ha_status="active"}[20m]) &gt; 95</code></td><td>severity=1；note 建议带 cluster/queue/value；替代 LLD 子队列 UsedCapacity</td></tr>
<tr><td>2</td><td>YARN</td><td>hadoop_yarn_subqueue_container_backlog【子队列容器积压 Pending/Allocated&gt;90%(10min均值)】</td><td>GID=413</td><td>VM=5</td><td><code>sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_container_count{queue!="root",user="-",status="Pending",ha_status="active"}[10m])) / (sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_container_count{queue!="root",user="-",status="Allocated",ha_status="active"}[10m])) + 1) &gt; 0.9</code></td><td>severity=1；无 host label，模板不要强依赖 host</td></tr>
<tr><td>3</td><td>YARN</td><td>hadoop_yarn_subqueue_apps_backlog【子队列作业积压 AppsPending/Running&gt;10%(10min均值)】</td><td>GID=413</td><td>VM=5</td><td><code>sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_application_count{queue!="root",user="-",status="Pending",ha_status="active"}[10m])) / (sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_application_count{queue!="root",user="-",status="Running",ha_status="active"}[10m])) + 1) &gt; 0.1</code></td><td>severity=1；建议 prom_for_duration=300s</td></tr>
<tr><td>4</td><td>YARN</td><td>hadoop_yarn_subqueue_memory_backlog【子队列内存积压 PendingMB/maxMB&gt;500%(10min均值)】</td><td>GID=413</td><td>VM=5</td><td><code>sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_memory_in_mb{queue!="root",user="-",status="Pending",ha_status="active"}[10m])) / (sum by(queue,cluster)(avg_over_time(hadoop_yarn_resourcemanager_memory_in_mb{queue!="root",user="-",status=~"Allocated|Available",ha_status="active"}[10m])) + 1) &gt; 5</code></td><td>severity=1；替代 PendingMB LLD 规则</td></tr>
<tr><td>5</td><td>ZooKeeper</td><td>Zookeeper: Too many queued requests</td><td>GID=394</td><td>VM=5</td><td><code>{__name__=~"org_apache_ZooKeeperService_ReplicatedServer_id[0-9]+_OutstandingRequests",busiGroupId="394",name3=""} &gt; 10</code></td><td>severity=2；summary：ZK队列积压告警：{{$labels.deployName}} outstanding={{$value}}</td></tr>
<tr><td>6</td><td>ZooKeeper</td><td>Zookeeper: max_latency &gt; 100ms</td><td>GID=394</td><td>VM=5</td><td><code>max by(deployName)({__name__=~"org_apache_ZooKeeperService_ReplicatedServer_id[0-9]+_MaxLatency",busiGroupId="394",name3="Connections"}) &gt; 100</code></td><td>severity=2；文档标记为紧急，已超阈值风险需人工确认</td></tr>
<tr><td>7</td><td>ZooKeeper</td><td>Zookeeper: znode_count &gt; 200000</td><td>GID=394</td><td>VM=5</td><td><code>{__name__=~"org_apache_ZooKeeperService_ReplicatedServer_id[0-9]+_NodeCount",busiGroupId="394",name3="InMemoryDataTree"} &gt; 200000</code></td><td>severity=2；文档标记为紧急，已超阈值风险需人工确认</td></tr>
<tr><td>8</td><td>ZooKeeper</td><td>Zookeeper: Too many file descriptors used (&gt;85%)</td><td>GID=394</td><td>VM=5</td><td><code>java_lang_OperatingSystem_OpenFileDescriptorCount{busiGroupId="394"} / java_lang_OperatingSystem_MaxFileDescriptorCount{busiGroupId="394"} &gt; 0.85</code></td><td>severity=1；critical</td></tr>
<tr><td>9</td><td>ZooKeeper</td><td>Zookeeper: Too many file descriptors used (&gt;1000)</td><td>GID=394</td><td>VM=5</td><td><code>java_lang_OperatingSystem_OpenFileDescriptorCount{busiGroupId="394"} &gt; 1000</code></td><td>severity=2；warning</td></tr>
<tr><td>10</td><td>Hive</td><td>HMS MYSQL ERROR (maybe deadlock or RetryingHMSHandler)</td><td>GID=419</td><td>Loki=81</td><td><code>sum by (cluster, host) (count_over_time({service_name="hive-metastore", role="hivemetastore", log_type="service"} |= "RetryingHMSHandler" [5m])) &gt; 3</code></td><td>创建前必须确认 HMS 的 Loki label：service_name/role/log_type</td></tr>
<tr><td>11</td><td>Hive</td><td>HIVE METASTORE Generic Java JMX: Memory Non-Heap usage &gt; 85%</td><td>GID=419</td><td>VM=5</td><td><code>hive_metastore_metastore_non_heap_used / hive_metastore_metastore_non_heap_max &gt; 0.85</code></td><td>参考 HMS Heap 规则 130426；创建前确认两个指标存在</td></tr>
<tr><td>12</td><td>infra_basic</td><td>system_uptime【infra_basic】【主机最近重启检测】</td><td>GID=301</td><td>VM</td><td><code>system_uptime &lt; 600</code></td><td>建议持续 1min；文档写 Critical，但命令草稿 severity=2，手工创建时需统一级别</td></tr>
<tr><td>13</td><td>Kafka</td><td>kafka_controller_active_count【Kafka Controller 数量异常】</td><td>待确认 Kafka 业务组</td><td>VM</td><td><code>kafka_controller_ActiveControllerCount != 1</code></td><td>Kafka 文档未给 GID；创建前确认 Kafka 规则所属业务组</td></tr>
<tr><td>14</td><td>Kafka</td><td>kafka_controller_unclean_leader_election【发生 UncleanLeaderElection】</td><td>待确认 Kafka 业务组</td><td>VM</td><td><code>increase(kafka_controller_UncleanLeaderElectionsPerSec_total[5m]) &gt; 0</code></td><td>两条 Zabbix 语义可合并为这一条 Foxeye 规则</td></tr>
<tr><td>15</td><td>Kafka</td><td>kafka_controller_offline_partitions【OfflinePartitionsCount &gt; 0】</td><td>待确认 Kafka 业务组</td><td>VM</td><td><code>kafka_controller_OfflinePartitionsCount &gt; 0</code></td><td>P0；分区离线核心告警</td></tr>
<tr><td>16</td><td>Kafka</td><td>kafka_controller_leader_election【发生 Leader Election】</td><td>待确认 Kafka 业务组</td><td>VM</td><td><code>increase(kafka_controller_LeaderElectionRateAndTimeMs_total[5m]) &gt; 0</code></td><td>建议和 OfflinePartitions / UncleanLeaderElection 联动观察，避免噪音</td></tr>
</tbody>
</table>

## B. 需要更新 / 处置现有规则

<table>
<thead>
<tr><th>#</th><th>服务</th><th>现有规则</th><th>操作</th><th>目标表达式 / 处置</th><th>备注</th></tr>
</thead>
<tbody>
<tr><td>1</td><td>Hive</td><td>2757366 hiveserver发现msck repair table操作</td><td>更新表达式与备注</td><td><code>sum by (instance, cluster, table) (count_over_time({service_name="hive-hs2", role="hiveserver2", log_type="service"} |= "msck repair table" | regexp "msck repair table (?P&lt;table&gt;[A-Za-z0-9_]+\\.[A-Za-z0-9_]+)" [5m])) &gt; 0</code></td><td>备注模板：主机 {{ $labels.instance }} msck repair table 操作，目标表为 {{ $labels.table }}</td></tr>
<tr><td>2</td><td>HDFS</td><td>452219</td><td>修正 PromQL</td><td>将 <code>ha_status='active'</code> 改为 <code>ha_status="active"</code></td><td>单引号非标准 PromQL，文档判断其历史 0 次触发，疑似长期失效</td></tr>
<tr><td>3</td><td>HDFS</td><td>452659 / 130400</td><td>重复规则去重</td><td>建议禁用 452659，保留 130400</td><td>两条规则 PromQL 完全重复；452659 对应 H2 旧规则，130400 对应 H3 主力</td></tr>
<tr><td>4</td><td>infra_basic</td><td>2752519 keepalived主备切换告警</td><td>修正或合并</td><td>修正 PromQL/标签中错误的 <code>{{$labels.insName}}</code>，或合并至 2752510</td><td>当前规则已建但禁用，原因是标签占位符未正确配置</td></tr>
</tbody>
</table>

## C. 前置依赖满足后再建 / 暂缓

| 服务 | 数量 | 处理建议 |
|---|---:|---|
| ZooKeeper 存活类 | 2 | 先在 ZK 主机部署 Categraf `net_response` 和 `procstat`，再建 2181 端口与 QuorumPeerMain 进程规则 |
| Kafka Categraf 类 | 2 | 先补 Kafka 端口 `net_response` 与 `procstat`；主机负载规则归入 infra_basic，不建议在 Kafka 组重复建 |
| Kafka JMX 缺失类 | 8 | 先补充 ISR / RequestTotalTimeMs / OfflineLogDirectory / JVM FD 等 MBean，再建规则 |
| Druid | 5 | historical/middleManager 先补 procstat；Coordinator/Overlord 选举与查询失败需启用 Druid Prometheus Emitter |
| Trino | 1 | 先确认 `trino_memory_MemoryPool_*` 在 VictoriaMetrics 有序列，再补内存使用率规则 |
| Ranger | 2 | 可由 Categraf `net_response` + `procstat` 覆盖，需先确认是否已有通用规则承接 |
| java_jvm | 5 | 不建议作为独立服务直接建；先盘点未被各组件专用 exporter 覆盖的 Java 进程 |
| Elasticsearch HTTP 探测 | 20 | 转 ES 负责人确认 coordinator API 探测覆盖；未确认前保留 Zabbix，不关闭 |
