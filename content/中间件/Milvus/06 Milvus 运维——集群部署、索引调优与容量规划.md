---
title: "Milvus 运维——集群部署、索引调优与容量规划"
date: 2026-03-05
tags: [中间件, Milvus, 运维, Kubernetes, 容量规划, 索引调优, 监控, 告警]
aliases: []
---

# Milvus 运维——集群部署、索引调优与容量规划

## 摘要

将 Milvus 从开发环境推进到生产环境，需要解决三类工程问题：**如何在 Kubernetes 上稳定部署一个完整的 Milvus 集群**（包括 etcd、Pulsar、MinIO 等依赖组件的选型与配置）；**如何根据业务的向量规模、QPS 要求、Recall 目标做出合理的索引与资源决策**（索引类型、参数、Query Node 数量）；以及**如何通过监控指标体系及时发现和定位性能问题**（写入 Stall、查询慢、内存溢出等）。本文系统覆盖上述三个维度，提供可直接参考的生产配置样例、容量计算公式，以及常见故障的排查思路，帮助工程师建立对 Milvus 生产运维的完整认知。

---

## 第 1 章 部署模式选择

### 1.1 三种部署模式的对比回顾

在 [[01 Milvus 全局架构——存算分离与云原生设计]] 中简要介绍了三种部署模式。本章从运维角度做更深入的对比：

**Milvus Lite（嵌入式）**：
- 无需任何基础设施，pip 安装即用
- 数据存储在本地文件，无高可用保证
- 最大支持约 100 万向量（受限于单机内存和文件 IO）
- **不适合生产**，仅用于开发调试和功能验证

**Milvus Standalone（单节点 Docker）**：
- `docker-compose` 一键启动，包含内嵌的 etcd 和 MinIO
- 支持所有 Milvus 功能（Collection、Partition、多种索引类型）
- 无水平扩展能力，单节点故障即服务中断
- **适合**：中小规模生产（千万级以下向量），对高可用要求不高
- 建议内存：16~64 GB，SSD 存储

**Milvus Distributed（Kubernetes 集群）**：
- 各组件独立 Pod，可单独扩缩容
- 依赖外部 etcd 集群（3 节点）、Pulsar 或 Kafka、MinIO 或 S3
- 支持亿级向量，高可用（多副本）
- **适合**：大规模生产环境，SLA 要求严格

### 1.2 生产推荐的依赖组件选型

| 组件 | 功能 | 生产推荐 | 备注 |
|------|------|---------|------|
| **元数据存储** | 存储 Collection/Segment 元数据 | etcd 3.5（3 节点） | 数据量小，但对可用性要求极高 |
| **消息队列** | 写入路径的数据总线 | Pulsar（生产）/ Kafka（已有 Kafka 集群时） | Pulsar 支持 Topic 级别 TTL，更适合 Milvus |
| **对象存储** | 持久化 Binlog 和索引文件 | 公有云：S3/OSS/COS；私有：MinIO | 对象存储的可用性直接决定数据安全 |
| **监控** | 性能指标采集和告警 | Prometheus + Grafana | Milvus 官方提供 Grafana Dashboard |

---

## 第 2 章 Kubernetes 部署实战

### 2.1 使用 Helm Chart 部署

Milvus 官方提供了维护良好的 Helm Chart，是 Kubernetes 部署的标准方式：

```bash
# 添加 Milvus Helm repo
helm repo add milvus https://zilliztech.github.io/milvus-helm/
helm repo update

# 创建 Namespace
kubectl create namespace milvus

# 部署 Milvus Distributed（生产配置）
helm install my-milvus milvus/milvus \
  --namespace milvus \
  --set cluster.enabled=true \
  --set etcd.replicaCount=3 \
  --set minio.mode=distributed \
  --set minio.replicas=4 \
  --set pulsar.enabled=true \
  --set pulsar.broker.replicaCount=3 \
  -f milvus-values.yaml   # 自定义配置文件
```

**关键的 `milvus-values.yaml` 配置**：

```yaml
# Proxy 配置
proxy:
  replicas: 2
  resources:
    requests:
      cpu: "2"
      memory: "4Gi"
    limits:
      cpu: "4"
      memory: "8Gi"

# Query Node 配置（关键：决定查询性能）
queryNode:
  replicas: 4                    # 4 个 Query Node
  resources:
    requests:
      cpu: "8"
      memory: "32Gi"             # 内存需覆盖加载的向量索引大小
    limits:
      cpu: "16"
      memory: "64Gi"
  # 内存映射：允许超出物理内存的索引通过 mmap 使用磁盘
  extraEnv:
    - name: QUERY_NODE_USE_MMAP
      value: "true"

# Data Node 配置
dataNode:
  replicas: 2
  resources:
    requests:
      cpu: "4"
      memory: "8Gi"
    limits:
      cpu: "8"
      memory: "16Gi"

# Index Node 配置（索引构建是 CPU 密集型）
indexNode:
  replicas: 2
  resources:
    requests:
      cpu: "8"
      memory: "16Gi"
    limits:
      cpu: "16"
      memory: "32Gi"

# Coordinator 配置（轻量，HA 模式）
rootCoordinator:
  replicas: 1          # 目前 Coordinator 为 Active-Standby 模式
  resources:
    requests:
      cpu: "1"
      memory: "2Gi"

queryCoordinator:
  replicas: 1
  resources:
    requests:
      cpu: "1"
      memory: "2Gi"

# Milvus 核心参数
extraConfigFiles:
  user.yaml: |+
    dataCoord:
      segment:
        maxSize: 1024          # Segment 大小上限 1GB
        sealProportion: 0.75   # Segment 达到 75% 时开始 Seal
    
    queryNode:
      cache:
        warmup: async          # 异步预热（不阻塞启动）
      segcore:
        chunkRows: 1024        # SIMD 计算的 Chunk 大小
    
    common:
      retentionDuration: 86400 # Snapshot 保留时间（秒），默认 1 天
```

### 2.2 资源规划原则

**Query Node 内存规划**（最关键）：

Query Node 需要将 Indexed Segment 的向量索引加载到内存（或 mmap）。内存需求估算：

```
Query Node 内存需求 = 
    Σ（所有 Indexed Segment 的索引大小） / Query Node 数量 × 1.2（20% 冗余）

Indexed Segment 的索引大小估算：
  HNSW：约等于原始向量数据大小（N × D × 4 字节）× 1.05（图结构开销约5%）
  IVF_FLAT：约等于原始向量数据大小（包含质心和原始向量）
  IVF_PQ：约等于 N × M × 1 字节 + 质心数据（约原始大小的 1/30 ~ 1/60）

例：1 亿个 768 维 float32 向量，HNSW 索引：
  原始向量大小：1亿 × 768 × 4 = 307 GB
  HNSW 索引大小：≈ 307 × 1.05 = 322 GB
  4 个 Query Node：每个约 80 GB 内存（322 / 4）
  加 20% 冗余：每个 Query Node 需约 96 GB 内存
```

**建议**：对于超过可用内存的大规模索引，开启 `QUERY_NODE_USE_MMAP=true`，允许超出物理内存的部分通过 mmap 使用 SSD，以略高的延迟换取更大的数据容量。

### 2.3 持久化与数据保护

Milvus 的数据持久化完全依赖对象存储，需要确保：

1. **对象存储的高可用**：若使用 MinIO，部署 4 节点分布式模式（容忍 1 节点故障）；生产环境优先使用公有云对象存储（AWS S3、阿里云 OSS），其可靠性远超自建 MinIO
2. **etcd 定期备份**：etcd 存储的是 Collection Schema 和 Segment 状态元数据，虽然数据量小，但一旦损坏会导致 Milvus 无法启动。配置 etcd 的定期快照备份（`etcdctl snapshot save`），频率建议每小时一次
3. **WAL 保留时间**：Pulsar/Kafka 的消息保留时间需要覆盖 Data Node 的最大 Flush 延迟。若 Flush 可能延迟 24 小时（如 Index Node 资源不足），则消息队列至少保留 24 小时的历史消息

---

## 第 3 章 容量规划

### 3.1 向量存储容量计算

向量数据在 Milvus 中的存储形态包括：Binlog（原始向量 + 标量字段）+ 向量索引文件 + 标量索引文件。

```
总存储容量估算公式：

Step 1：向量数据原始大小
  raw_size = N × D × 4 字节（float32）
  例：1亿 768维 = 307 GB

Step 2：标量字段大小（根据 Schema 估算）
  scalar_size = N × avg_scalar_bytes（每行标量字段的平均字节数）
  例：每行含 VARCHAR(256) + INT64 × 3 ≈ 300 字节
  scalar_size = 1亿 × 300 = 30 GB

Step 3：向量索引大小
  HNSW: index_size ≈ raw_size × 1.05（约等于原始大小）
  IVF_PQ: index_size ≈ N × M 字节（M=PQ分段数，通常8~32）

Step 4：总对象存储占用
  total = raw_size + scalar_size + index_size + delta_log（删除记录，通常 < 1%）
  HNSW 场景: total ≈ raw_size × 2.1 + scalar_size
  1亿 768维 HNSW: ≈ 307 × 2.1 + 30 ≈ 675 GB

Step 5：Query Node 内存需求（用于加载索引）
  memory = index_size / queryNode.replicas × 1.2
  1亿 768维 HNSW，4个 Query Node: ≈ 307 × 1.05 / 4 × 1.2 ≈ 97 GB/节点
```

### 3.2 QPS 与 Query Node 数量规划

Query Node 的 QPS 容量取决于：向量维度、索引类型、`ef_search` 参数、每个 Segment 的大小，以及 CPU 核数。

**经验参考值**（单个 Query Node，16 核 CPU，HNSW 索引，ef=64）：

| 向量维度 | 单 QN 峰值 QPS | 典型 P99 延迟 |
|---------|--------------|-------------|
| 128 维 | ~5000 QPS | ~5ms |
| 512 维 | ~2000 QPS | ~15ms |
| 768 维 | ~1200 QPS | ~25ms |
| 1536 维 | ~600 QPS | ~50ms |

**规划公式**：
```
Query Node 数量 = ceil（目标 QPS / 单 QN 峰值 QPS × 安全系数（1.5））
```

例：目标 QPS=3000，768 维，ef=64：
- 单 QN 峰值约 1200 QPS
- 节点数 = ceil(3000 / 1200 × 1.5) = ceil(3.75) = 4 个 Query Node

### 3.3 写入吞吐与 Data Node 规划

Data Node 的写入处理流程：消费消息队列 → 将向量数据写出 Binlog 到对象存储。瓶颈通常在对象存储的写入带宽。

```
Data Node 数量估算：

目标写入 QPS：写入速率（条/秒）
单条数据大小：768维 float32 ≈ 3072 字节 + 标量 ≈ 4 KB/条
Data Node 写出带宽：对象存储写入 ≈ 100~300 MB/s（公有云 S3）

写入带宽需求 = 目标写入 QPS × 数据大小 × Binlog压缩后大小（约 0.7）
             = 10000 QPS × 4 KB × 0.7 = 28 MB/s（单 Data Node 完全可处理）

高峰写入（如 Bulk Insert）时，可临时扩展 Data Node 数量
```

---

## 第 4 章 监控与告警体系

### 4.1 Milvus 的 Prometheus 指标

Milvus 通过 Prometheus 暴露丰富的监控指标。以下是生产环境中最关键的监控指标：

**写入路径指标**：

| 指标 | 告警阈值建议 | 含义 |
|------|------------|------|
| `milvus_rootcoord_msgstream_obj_num` | > 100K | 消息队列积压量，超限说明 Data Node 追不上写入 |
| `milvus_datacoord_num_growing_segments` | > 10 | Growing Segment 数量，过多说明 Seal 速度慢 |
| `milvus_datanode_flush_duration_bucket` | P99 > 60s | Data Node Flush（写出 Binlog）延迟 |
| `milvus_datacoord_compaction_task_num` | > 50（长期） | Compaction 积压，说明资源不足 |

**查询路径指标**：

| 指标 | 告警阈值建议 | 含义 |
|------|------------|------|
| `milvus_proxy_search_vectors_count` | - | 每秒向量检索请求数（QPS 监控） |
| `milvus_querynode_search_latency_bucket` | P99 > 500ms | Query Node 内部搜索延迟（不含网络） |
| `milvus_proxy_req_latency_bucket{method="Search"}` | P99 > 1s | 端到端查询延迟（含网络和结果聚合） |
| `milvus_querynode_entity_num` | - | Query Node 加载的向量总数（容量监控） |
| `milvus_querynode_segment_num_indexed` | - | 有索引的 Segment 数量 |
| `milvus_querynode_segment_num_growing` | > 5（持续） | Growing Segment 在 QN 上的数量，过多说明索引构建慢 |

**资源使用指标**：

| 指标 | 告警阈值建议 | 含义 |
|------|------------|------|
| `container_memory_usage_bytes` | > 80% limit | Pod 内存使用率，临近 OOM |
| `container_cpu_usage_seconds_total` | > 90% limit | CPU 使用率，可能成为性能瓶颈 |
| `milvus_querynode_disk_used_size` | > 70% | Query Node mmap 使用的磁盘空间 |

### 4.2 Grafana Dashboard 配置

Milvus 官方在 `https://github.com/milvus-io/milvus/tree/master/deployments/monitor/grafana` 提供了完整的 Grafana Dashboard JSON，导入后可以查看：

- **Overview 面板**：QPS、延迟、数据规模的全局概览
- **Query Node 面板**：各 Query Node 的内存使用、索引加载状态、搜索延迟分布
- **Data Node 面板**：写入吞吐、Flush 延迟、Compaction 进度
- **Index Node 面板**：索引构建任务队列、构建速度

### 4.3 关键告警规则

```yaml
# Prometheus AlertManager 告警规则示例
groups:
  - name: milvus.rules
    rules:
      # 写入停滞告警（Query Node 上 Growing Segment 过多，索引追不上）
      - alert: MilvusGrowingSegmentsTooMany
        expr: milvus_querynode_segment_num_growing > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Query Node Growing Segments 过多（{{ $value }}）"
          description: "Index Node 可能资源不足，索引构建速度追不上数据写入速度"

      # 查询延迟告警
      - alert: MilvusSearchLatencyHigh
        expr: histogram_quantile(0.99, milvus_proxy_req_latency_bucket{method="Search"}) > 1000
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Milvus 查询 P99 延迟超过 1s（{{ $value }}ms）"

      # Query Node 内存告警
      - alert: MilvusQueryNodeMemoryHigh
        expr: container_memory_usage_bytes{container="querynode"} / container_spec_memory_limit_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Query Node 内存使用率超过 85%，存在 OOM 风险"

      # etcd 空间告警
      - alert: EtcdDbSizeTooLarge
        expr: etcd_server_quota_backend_bytes - etcd_mvcc_db_total_size_in_bytes < 50000000  # 剩余 < 50MB
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "etcd 磁盘空间即将耗尽，需要立即清理历史 Revision"
```

---

## 第 5 章 常见性能问题排查

### 5.1 查询延迟突然升高

**现象**：P99 查询延迟从 50ms 升高到 500ms 以上，且持续不恢复。

**排查步骤**：

```
1. 检查 Growing Segment 数量
   kubectl exec -it <querynode-pod> -- curl localhost:9091/metrics | grep growing_segment
   
   若 growing_segment_num 较大（> 5）：
   → 说明大量数据处于 Growing 状态（无索引），走暴力搜索
   → 检查 Index Node 状态，是否有大量待处理的索引构建任务
   → 临时方案：增加 Index Node 副本数

2. 检查 Query Node 内存压力
   kubectl top pods -n milvus -l app=querynode
   
   若内存使用率 > 80%：
   → 系统在频繁 GC 或 mmap 换页，导致延迟增加
   → 减少 ef_search 参数降低内存访问量
   → 或扩展 Query Node 数量，减少每个节点的加载量

3. 检查是否有 Full Collection Load（全量加载）正在进行
   刚执行 collection.load() 后，Query Node 正在从 S3 下载索引文件，
   此时查询需要等待相关 Segment 加载完成

4. 检查 Proxy 的 CPU 使用率
   结果聚合（全局 Top-K 归并）在 Proxy 端执行，若 Proxy CPU 打满，
   会导致聚合延迟增加 → 增加 Proxy 副本
```

### 5.2 写入停止（Write Stall）

**现象**：客户端 Insert 操作超时或返回 `insert timeout` 错误，写入完全停止。

**可能原因与解决方案**：

| 原因 | 诊断方法 | 解决方案 |
|------|---------|---------|
| **消息队列积压**：写入速度超过 Data Node 消费速度 | `kafka_consumer_lag / pulsar_msgbacklog` | 增加 Data Node；降低写入速率 |
| **对象存储写入慢**：Binlog 写出到 S3 延迟高 | Data Node flush_duration P99 | 检查对象存储 IO 状态；增大 Segment 大小减少 Flush 次数 |
| **etcd 故障**：元数据更新失败 | etcd leader 状态，etcd 请求延迟 | 检查 etcd 集群状态，确保 3 节点多数可用 |
| **Proxy OOM**：Proxy 内存不足崩溃重启 | Proxy Pod 状态 | 增大 Proxy 内存 limit |

### 5.3 内存 OOM 排查

**Query Node OOM** 是最常见的内存问题，通常是因为：
1. **加载的向量总量超过内存容量**：通过 `collection.load()` 时指定 `replica_number`（副本数），若副本数 × 索引大小 > Query Node 总内存，会 OOM
2. **查询时的临时内存**：HNSW 搜索中 ef_search 很大时，候选集的内存占用可能达到索引大小的 20%~50%

**排查与解决**：

```python
# 查看 Collection 的内存使用情况
from pymilvus import utility

info = utility.get_query_segment_info("knowledge_base")
for seg in info:
    print(f"Segment {seg.segmentID}: {seg.num_rows} 行, 状态={seg.state}")

# 查看 Collection 的磁盘/内存占用估算
from pymilvus import Collection
col = Collection("knowledge_base")
print(col.num_entities)   # 总向量数量

# 减少内存占用的方法：
# 1. 降低 ef_search（减少查询时的临时内存）
# 2. 开启 mmap（允许超出内存的部分用磁盘）
# 3. 使用 IVF_PQ 替代 HNSW（大幅减少内存占用）
# 4. 增加 Query Node 分担加载量
```

---

## 第 6 章 索引调优最佳实践

### 6.1 Recall 测量方法

在决定索引参数之前，必须先建立 Recall 的测量基线：

```python
import numpy as np
from pymilvus import Collection

def measure_recall(collection: Collection, query_vectors: list, 
                   top_k: int, search_params: dict, 
                   ground_truth_ids: list) -> float:
    """
    计算实际 ANN 搜索的 Recall@K
    ground_truth_ids: 每个查询的精确 Top-K 主键 ID 列表
    """
    results = collection.search(
        data=query_vectors,
        anns_field="dense_vector",
        param=search_params,
        limit=top_k,
    )
    
    recalls = []
    for i, result in enumerate(results):
        ann_ids = set(hit.id for hit in result)
        true_ids = set(ground_truth_ids[i][:top_k])
        recall = len(ann_ids & true_ids) / top_k
        recalls.append(recall)
    
    return np.mean(recalls)

# 测试不同 ef 值下的 Recall-QPS 曲线
for ef in [32, 64, 128, 256, 512]:
    recall = measure_recall(
        collection, sample_queries, top_k=10,
        search_params={"metric_type": "COSINE", "params": {"ef": ef}},
        ground_truth_ids=gt_ids
    )
    print(f"ef={ef}: Recall@10={recall:.3f}")
```

### 6.2 不同规模场景的推荐配置

**小规模（< 500 万向量）**：

```python
# 推荐 HNSW 索引
index_params = {
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 8, "efConstruction": 100}   # 较小 M，节省内存
}
# 查询参数：ef=64，Recall@10 ≈ 97%
```

**中规模（500 万 ~ 5000 万向量）**：

```python
# 推荐 HNSW，较大参数
index_params = {
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 16, "efConstruction": 200}
}
# 查询参数：ef=128，Recall@10 ≈ 99%
```

**大规模（5000 万 ~ 5 亿向量）**：

```python
# 内存充裕：HNSW（多 Query Node 分片）
# 内存受限：IVF_PQ
index_params = {
    "index_type": "IVF_PQ",
    "metric_type": "L2",
    "params": {
        "nlist": 65536,   # sqrt(N) × 4
        "m": 32,          # PQ 分段数（D/m=24 维/段，需整除维度 768）
        "nbits": 8        # 每段 8 bit
    }
}
# 查询参数：nprobe=256，Recall@10 ≈ 90%
# 内存占用：约原始大小的 1/15
```

**超大规模（> 5 亿向量）**：

```python
# 推荐 DiskANN（需要 NVMe SSD）
index_params = {
    "index_type": "DISKANN",
    "metric_type": "COSINE",
    "params": {}   # 主要参数在查询时指定
}
# 查询参数：search_list=100（beam search 候选集），Recall@10 ≈ 95%
# 内存需求：约原始大小的 5%（PQ 压缩版 + 图邻接表）
# 磁盘需求：原始大小的 1.2 倍（存储在 SSD）
```

---

## 第 7 章 Milvus 升级与版本管理

### 7.1 滚动升级策略

Milvus 的 Helm Chart 支持滚动升级（Rolling Update），可以在不停服的情况下升级 Milvus 版本：

```bash
# 更新 Helm repo
helm repo update

# 查看可用版本
helm search repo milvus/milvus --versions | head -20

# 滚动升级（自动处理依赖组件兼容性）
helm upgrade my-milvus milvus/milvus \
  --namespace milvus \
  --version 4.2.0 \   # 目标版本
  --reuse-values       # 复用现有配置
```

**升级前注意事项**：
1. 查阅 [Milvus Release Notes](https://github.com/milvus-io/milvus/releases)，确认是否有 Breaking Change（如 Schema 格式变化、API 不兼容）
2. 备份 etcd 数据（`etcdctl snapshot save`）
3. 在测试环境验证升级过程和查询功能
4. 在业务低峰期执行升级，避免滚动重启期间的服务降级

### 7.2 数据迁移

当需要将数据从旧版本 Milvus 迁移到新版本，或从 Standalone 迁移到 Distributed 时，推荐使用 **MilvusDM**（Milvus Data Migration Tool）：

```bash
# 从 Milvus 2.x 导出数据
milvusdm --task L2M \   # Local to Milvus
  --source_collection "knowledge_base" \
  --dest_host "new-milvus-host" \
  --dest_port 19530 \
  --dest_collection "knowledge_base_v2"
```

---

## 第 8 章 小结

### 8.1 Milvus 运维的核心原则

1. **内存规划先行**：Milvus 的性能和稳定性高度依赖 Query Node 的内存是否足够承载索引数据。在规划阶段就计算清楚内存需求，比事后扩容更重要
2. **监控覆盖全链路**：从写入积压（消息队列 lag）→ Segment 状态（growing 数量）→ 索引构建进度（index_node 任务队列）→ 查询延迟（P99 latency），每个环节都需要监控覆盖
3. **对象存储是安全基础**：Milvus 的数据安全完全依赖对象存储，生产环境必须使用高可靠的对象存储（公有云 S3 或 MinIO 分布式模式），并定期验证数据恢复能力
4. **从小规模开始，按需扩展**：先部署 Standalone 验证业务可行性，随着数据量和 QPS 增长，逐步迁移到 Distributed 集群

### 8.2 本专栏回顾

本专栏从 Milvus 的整体架构出发，逐步深入到向量索引算法、数据模型、查询引擎、RAG 应用，最终以运维实战收尾，构成了一条完整的 Milvus 技术认知路径：

- **[[01 Milvus 全局架构——存算分离与云原生设计]]**：为什么向量数据库必须存在，Milvus 2.0 的四层架构如何实现存算分离
- **[[02 向量索引——从暴力搜索到 HNSW 与 IVF]]**：ANN 算法的数学本质，IVF/HNSW/DiskANN 的原理与工程权衡
- **[[03 数据模型——Collection、Partition 与 Segment]]**：数据的三级组织结构，Binlog 格式，Compaction 策略
- **[[04 查询引擎——混合检索与过滤]]**：Pre-Filter/Post-Filter 的协同策略，稀疏+稠密混合检索的 RRF 融合
- **[[05 Milvus 在 RAG 场景中的应用]]**：从 Embedding 选型到分块策略，构建生产级 RAG 系统的工程实践
- **本文**：从 Kubernetes 部署到容量规划，从监控告警到故障排查，完整的生产运维指南

---

> [!note] 思考题
> 1. 在 RAG 系统中，Milvus 存储文档 Chunk 的向量嵌入。查询时通过向量搜索召回相关 Chunk，拼接到 LLM Prompt 中。Chunk 的嵌入模型（如 text-embedding-3-small vs BGE-large）直接影响检索质量。如果更换嵌入模型，所有已存储的向量需要重新计算——这个迁移成本如何评估？能否在一个 Collection 中同时存储两个模型的向量以实现平滑迁移？
> 2. 在推荐系统中，Milvus 可以存储用户/物品的 Embedding——通过 ANN 搜索实现'猜你喜欢'。与基于协同过滤的推荐相比，基于向量搜索的推荐在冷启动问题上有什么优势？但向量搜索只考虑语义相似性——不考虑用户的历史行为和实时上下文。如何将向量搜索与传统推荐算法结合？
> 3. 图片搜索（以图搜图）将图片通过 CNN（如 ResNet、CLIP）提取特征向量，存储在 Milvus 中。查询时上传图片→提取向量→在 Milvus 中搜索相似向量。在电商场景中（拍照搜商品），搜索延迟需要在 100ms 内。Milvus 的 ANN 搜索延迟通常在多少毫秒？网络传输和特征提取的延迟是否是更大的瓶颈？
