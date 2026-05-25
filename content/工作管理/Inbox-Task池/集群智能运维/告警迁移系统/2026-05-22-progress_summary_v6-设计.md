# progress_summary v6 改版设计

## 一、需求理解

- **目标页面**：https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107717201（progress_summary.html）
- **核心诉求**（周会汇报用，必须高准确高可读）：
  1. 本周（**自然周 2026-05-19 ~ 05-22**）新增了哪些 Foxeye 告警规则
  2. 哪些服务**所有可迁移规则已建好且启用** → 可正式进入双跑
  3. 阻塞项清单（含阻塞内容 + 解锁路径）
- **数据原则**：以 **opencli 在 Foxeye 平台实测** 为权威，总览 vs 子文档不一致以总览为准
- **附加诉求**：infra_basic 中文件 / 配置变更类规则（/etc/passwd / Host info / kernel / jar md5 / Zabbix test item 等），原本标 retire；老板提示 **Categraf 部分插件可替代**。处理方式：**仅在总概要中标注「可选方案」，不修改现有子文档分类**

## 二、实测数据快照（2026-05-22）

### 2.1 Foxeye 平台实际状态（按业务组）

来源：`opencli foxeye list-rules --group-id <gid>`，与 Doris `foxeye_rules` 表 group_by 交叉验证

| 业务组 GID | 名义 service | 规则数 | 启用 | 备注 |
|---|---|---|---|---|
| 5 | (大数据通用)Druid/Ambari/Ranger/Kyuubi | 36 | 35 | 含 Ranger 2 条 / 本周新建 Ambari port_down + Ranger admin |
| 301 | infra_basic-其他 | 12 | 12 | 含本周新建 system_uptime |
| 384 | hdfs | 66 | 65 | 含本周新建 ZKFC 进程存活 |
| 390 | elasticsearch | 39 | 30 | |
| 392 | trino | 8 | 4 | |
| 394 | zookeeper | 5 | 4 | 含本周新建 4 条 JMX |
| 395 | infra_basic-硬件 | 8 | 7 | |
| 398 | infra_basic-内存 | 11 | 8 | 3 条 VM 噪音禁用 |
| 399 | infra_basic-磁盘 | 10 | 9 | 含本周新建 kernel_disk_medium_error |
| 400 | infra_basic-网络 | 23 | 15 | 8 条禁用（SlaProbe Ping 4 条+测试 2 条+其他 2 条）|
| 401 | infra_basic-CPU/Load | 5 | 4 | 1 条 VM 噪音禁用 |
| 413 | yarn (per-queue) | 43 | 43 | **全部 43 条已启用**（含本周 4 条新建 subqueue 规则）|
| 414 | yarn | 21 | 10 | YARN 另一组（含 11 条禁用待评估）|
| 416 | hbase | 28 | 26 | |
| 419 | hive | 23 | 23 | 含本周新建 HMS Loki + HMS Non-Heap |

**注**：Kafka / Kyuubi / Ambari / java_jvm 没有独立业务组，归口到 GID=5 / 其他服务组承接

### 2.2 Doris zabbix_rules 视角（账本）

| 服务 | 总规则 | matched | ready | blocked | triage |
|---|---|---|---|---|---|
| infra_basic | 142 | 39 | 65 | 77 | 0 |
| hdfs | 55 | 54 | 54 | 1 | 0 |
| yarn | 44 | 37 | 40 | 4 | 0 |
| hbase | 26 | 24 | 23 | 3 | 0 |
| hive | 29 | 18 | 21 | 8 | 0 |
| elasticsearch | 45 | 22 | 21 | 21 | 3 |
| druid | 10 | 5 | 0 | 0 | 10 |
| kafka | 16 | 0 | 0 | 16 | 0 |
| zookeeper | 9 | 0 | 0 | 9 | 0 |
| trino | 2 | 1 | 0 | 0 | 2 |
| ranger / ambari / kyuubi / java_jvm | 2/3/2/7 | 0 | 0 | 0 | 全 triage |

⚠️ **Doris 严重滞后**：ZooKeeper / Ranger / Ambari 本周新建的 Foxeye 规则未回写 rule_mappings → 必须以 Foxeye 实测为准

### 2.3 本周新增 Foxeye 规则（16 条，按 Foxeye 实际 create_at 过滤）

| FID | GID | 服务 | 创建时间 | 规则名 | 状态 |
|---|---|---|---|---|---|
| 2763626 | 399 | infra_basic | 05-19 09:32 | kernel_disk_medium_error_detected | ✅ |
| 2763691 | 416 | hbase | 05-19 14:55 | hadoop_hbase_master_leader_change | ✅ |
| 2763722 | 384 | hdfs | 05-19 16:33 | hadoop_hdfs_zkfc_is_running | ✅ |
| 2765032 | 413 | yarn | 05-22 12:05 | hadoop_yarn_resourcemanager_subqueue_used_capacity | ✅ |
| 2765033 | 413 | yarn | 05-22 12:08 | hadoop_yarn_resourcemanager_subqueue_container_backlog | ✅ |
| 2765036 | 413 | yarn | 05-22 14:13 | hadoop_yarn_resourcemanager_subqueue_apps_backlog | ✅ |
| 2765037 | 413 | yarn | 05-22 14:15 | hadoop_yarn_resourcemanager_subqueue_memory_backlog | ✅ |
| 2765039 | 394 | zookeeper | 05-22 14:17 | zookeeper_request_queued | ✅ |
| 2765040 | 394 | zookeeper | 05-22 14:25 | zookeeper_max_latency | ✅ |
| 2765041 | 394 | zookeeper | 05-22 14:28 | zookeeper_znode_count | ✅ |
| 2765042 | 394 | zookeeper | 05-22 14:31 | zookeeper__too_much_open_fd | ✅ |
| 2765045 | 419 | hive | 05-22 14:47 | HMS MYSQL ERROR (RetryingHMSHandler Loki) | ✅ |
| 2765048 | 419 | hive | 05-22 14:50 | hive_metastore_nonheap_usage_high | ✅ |
| 2765049 | 301 | infra_basic | 05-22 15:00 | system_uptime 主机重启检测 | ✅ |
| 2765050 | 5 | ambari | 05-22 16:25 | ambari_server_port_down | ✅ |
| 2765051 | 5 | ranger | 05-22 16:29 | ranger_admin_dead | ✅ |

**汇总**：YARN 4 / ZooKeeper 4 / infra_basic 2 / Hive 2 / HDFS 1 / HBase 1 / Ambari 1 / Ranger 1 = **16 条**

### 2.4 双跑就绪度初判（以 Foxeye 实测为主）

| 服务 | 就绪度 | 说明 |
|---|---|---|
| HDFS | ✅ **已就绪** | 66 条已建（65 启用），ZKFC 第二台已补齐；剩余阻塞为规则质量（452219 单引号、452659/130400 重复）|
| YARN | ✅ **已就绪** | per-queue 4 条本周已建并启用；GID=413 + 414 共 64 条 |
| HBase | ✅ **已就绪** | 28 条（26 启用）；HMaster 切换规则已修正 |
| Hive | ✅ **已就绪** | 23 条全启用；本周补齐 HMS Loki + Non-Heap |
| Ranger | ✅ **已就绪** | 端口探活 + Admin 进程存活 2 条已建并启用 |
| Ambari | ✅ **已就绪** | 本周新建 ambari_server_port_down；其余由 procstat/net_response 承接 |
| Kyuubi | ✅ **已就绪** | 由 GID=5 通用 procstat 覆盖 |
| infra_basic | 🟡 **部分就绪** | 52 条启用，但 SlaProbe 4 条阻塞 + VM 噪音 7 条禁用 |
| ZooKeeper | 🟡 **接近就绪** | 本周 4 条 JMX 已建；子文档原说 5 条待建，差 1 条 FD 绝对值待确认 |
| Elasticsearch | 🟡 **部分就绪** | 核心覆盖；per-IP coordinator HTTP 20 条待 ES 负责人确认 |
| Trino | 🟡 **部分就绪** | HTTP 探活已覆盖；1 条内存规则待确认指标 |
| Druid | ❌ **阻塞中** | 3 条依赖 druid-prometheus-emitter（未上线）|
| Kafka | ❌ **未就绪** | 0 条 Foxeye 规则；8 条 MBean 阻塞 + 4 条 controller 可建未建 |
| java_jvm | ⏳ **重新分类** | 7 条由各服务 JMX/procstat 承接，不再独立 |

### 2.5 关键阻塞项（按影响排序）

| 阻塞项 | 影响规则 | 涉及服务 | 解锁路径 |
|---|---|---|---|
| Kafka jmx_exporter MBean 不完整 | 8+ | Kafka | 补 ISR/RequestTotalTimeMs/OfflineLogDirectory/UnderReplicatedPartitions MBean |
| Kafka 业务组未建 | 4+ | Kafka | 在 Foxeye 新建 Kafka 业务组（GID 待分配）并迁入 controller 类规则 |
| SlaProbe Ping 数据源缺失 | 4 | infra_basic | 确认 SlaProbe 探针部署 / 改用 cmdb_device_probe_status |
| VM 告警噪音 | 7 | infra_basic | PromQL 增加 instance_type!="vm" 或拆物理机/虚拟机业务组 |
| Druid Prometheus Emitter 未上线 | 3 | Druid | 联系 Druid 负责人启用 druid-prometheus-emitter |
| ES per-IP coordinator HTTP 探测策略 | 20 | Elasticsearch | 转 ES 负责人确认 Categraf/exporter 覆盖 |
| HDFS 规则质量 | 2 | HDFS | 修正 452219 单引号；清理 452659/130400 重复 |
| YARN GID=414 11 条禁用 | 11 | YARN | 评估禁用原因，决定 retire/启用/调参 |
| Hive MSCK 规则 2757366 LogQL 表达式 | 1 | Hive | 确认 LogQL 后改表达式 |

### 2.6 配置变更/文件校验类规则 Categraf 可选方案（新增段落）

infra_basic.html 第八组目前列了 6 条"建议退休"规则，老板提示 Categraf 部分插件可替代：

| Zabbix 规则 | 当前分类 | Categraf 替代方案 | 实施成本 |
|---|---|---|---|
| /etc/passwd has been changed | retire | `inputs.filemd5` 计算文件 hash，PromQL 用 `changes(filemd5_hash[5m]) > 0` | 低（插件已有）|
| Host information was changed (system.uname) | retire | 不推荐用 Categraf；SaltStack 已管控 | 不建议 |
| Hostname was changed | retire | SaltStack 管控，确实 retire | 不建议 |
| linux kernel version | retire | `inputs.system` 输出 `kernel_version` label，用 `changes(label_replace(...)[1h])` | 中（需自定义 PromQL）|
| hive-exec-3.1.3.jar md5 change | retire | `inputs.filemd5` + 版本白名单 | 中（需维护白名单）|
| 公网IP获取失败 | retire | `inputs.script` 自定义脚本 + Categraf script_input | 高，不建议 |
| Zabbix test item ti-A1/ti-B2 | misc 待评估 | 测试规则，确认无业务用途即可 retire | 0 |

**结论建议**（写入总概要）：
- 推荐用 Categraf 替代：/etc/passwd / jar md5（高价值变更检测）
- 建议保持 retire：hostname / system.uname / kernel version / 公网IP / Zabbix test item（SaltStack 管控 + 低价值）

## 三、新版 progress_summary v6 结构

```
1. 顶部摘要：总体进度（强调本周关键产出 + 16 条新增）
2. 一、本周新增告警规则（2026-05-19 ~ 05-22）—— 16 条明细表 + 4 个亮点
3. 二、各服务双跑就绪度（5 级分类：✅已就绪 / 🟡接近就绪 / 🟡部分就绪 / ❌阻塞中 / ⏳重新分类）—— 14 个服务表
4. 三、关键阻塞项汇总（9 大阻塞 + 解锁路径）
5. 四、配置变更/文件校验类规则：Categraf 可选方案（新增段落，老板诉求）
6. 五、待关闭 Zabbix 规则台账（沿用 v5 摘要 + 引用 109248930）
7. 六、跳过服务（沿用 v5）
8. 七、后续行动建议（按 P0/P1/P2 排）
9. 文末说明：数据来源（Foxeye opencli 实测 + Doris foxeye_rules / zabbix_rules）
```

## 四、待确认问题

1. **YARN GID=414 中 11 条禁用规则**——这些是该 retire 还是该启用？是否要在总概要里列入"待评估阻塞"？
2. **ZooKeeper 第 5 条 FD 绝对值规则**——是否本周内补建？还是留下周？
3. **Druid 5 条 matched / 5 条 triage 在 Doris 中显示**——子文档说"5 已匹配（50%）"+"3 条需 Druid Prometheus Emitter"，是否还需要为剩余 2 条 procstat 规则新建？

## 五、执行步骤

1. ✅ 现状摸底（rule-management + opencli foxeye）
2. ✅ 本周新增规则提取（foxeye_rules 表 create_at 过滤）
3. ⏳ 待老板确认设计方案
4. 改写 `progress_summary.html` 为 v6 版本
5. `opencli confluence update --id 107717201 --content "$(cat progress_summary.html)" --title "迁移进度概要"`
6. README.md 中将版本号 v5 → v6
