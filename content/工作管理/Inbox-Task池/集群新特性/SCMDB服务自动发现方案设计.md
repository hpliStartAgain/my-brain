---
type: task
status: doing
priority: P2
deadline: 2026-04-17
domain: 集群新特性
lifecycle: research
progress: "30"
completed_date:
started_date: 2026-04-10
---

## 🎯 核心问题 (Problem Statement)
研究如何进行大数据集群节点级别的服务自动发现并保存数据，解决 Ambari 托管服务与非托管服务（如独立 Spark、自定义组件）的数据割裂，构建服务间动态拓扑关系。

## 🧪 预研方案：三位一体发现模型

### 1. 最佳实践：混合数据源对齐
*   **Ambari 为基准 (Managed SoT)**：利用 Ambari REST API 获取集群、主机、组件的映射关系。
*   **静态 CMDB 为底座 (Resource SoT)**：确保节点元数据（机架、状态、机型）与服务数据在 Hostname/IP 层面强关联。
*   **本地 Agent 为补充 (Discovery SoT)**：解决“幽灵服务”（未托管组件）的识别。

### 2. 精准发现策略：大数据组件指纹库
针对非 Ambari 托管组件，通过本地脚本/Agent（如 Alloy）执行以下识别：

| 组件名称 | 进程特征 (Java Main Class) | 核心配置路径 | 默认端口 |
| :--- | :--- | :--- | :--- |
| **HDFS NN** | `NameNode` | `/etc/hadoop/conf/hdfs-site.xml` | 8020, 9870 |
| **HDFS DN** | `DataNode` | - | 9866 |
| **YARN RM** | `ResourceManager` | `/etc/hadoop/conf/yarn-site.xml` | 8032, 8088 |
| **Spark Master** | `org.apache.spark.deploy.master.Master` | `/etc/spark/conf/` | 7077, 8080 |
| **Kafka** | `kafka.Kafka` | `/etc/kafka/conf/server.properties` | 9092 |

### 3. 拓扑关系构建：从“静态解析”到“动态关联”
*   **配置路径解析 (Static)**：
    - 扫描组件配置目录中的关键 Key-Value（如 `hive.metastore.uris`）。
    - 建立 **Component -> Endpoint** 的指向关系。
*   **网络连接溯源 (Dynamic)**：
    - 执行 `ss -antp | grep <Component_Port>`。
    - 分析 Established 连接的 Peer IP，自动判定生产者/消费者拓扑。

## 💡 方案选择建议
*   **短期路径**：开发 Python 采集器，批量调用 Ambari API + 结合 SaltStack 在全量主机执行指纹扫描脚本，结果汇聚至临时 DB。
*   **长期路径**：将采集逻辑集成至 **Alloy**，利用其 Service Discovery 能力实现流式元数据上报，并与现有 Foxeye 监控系统标签对齐。

## 📚 调研资料链接 & 论文
- [x] [[2026-H1-集群智能运维OKR]]：明确了 SCMDB 在拓扑聚合降噪中的定位。
- [x] [[TimelineServer高可用建设]]：参考其 Ambari API 调用与配置刷新逻辑。
- [ ] 官方 Ambari REST API 文档：[Ambari Wiki](https://cwiki.apache.org/confluence/display/AMBARI/Ambari+REST+API+Usage)