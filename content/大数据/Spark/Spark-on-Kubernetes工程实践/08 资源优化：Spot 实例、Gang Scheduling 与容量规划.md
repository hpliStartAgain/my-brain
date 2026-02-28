---
title: "资源优化：Spot 实例、Gang Scheduling 与容量规划"
date: 2026-02-28
tags: [Spark, Kubernetes, Spot实例, Gang Scheduling, Volcano, Yunikorn, 容量规划, 资源优化, 抢占]
aliases: []
---

# 08 资源优化：Spot 实例、Gang Scheduling 与容量规划

## 摘要

Spark on Kubernetes 的资源优化是降低计算成本、提高集群利用率的核心课题。本文围绕三个互相关联的主题展开：**Spot 实例**（云厂商以 10-30% 折扣提供的可被随时回收的实例，适合 Spark 作业但需要设计容忍驱逐的机制）、**Gang Scheduling**（"全或无"的调度语义——作业的所有 Executor Pod 必须同时就绪才开始，否则等待；K8s 默认调度器不支持，需要 [[Volcano]] 或 [[Apache Yunikorn]] 扩展）、**容量规划**（如何根据工作负载特征确定节点规格、集群大小和资源配额分配）。三者共同构成 Spark on K8s 的资源效率优化体系：Gang Scheduling 避免死锁和资源碎片，Spot 实例降低计算成本，容量规划确保资源供给与需求的匹配。

---

## 第 1 章 Spot 实例：低成本高风险

### 1.1 Spot 实例是什么，为什么出现

**Spot 实例**（AWS）/ **Preemptible VM**（GCP）/ **抢占式实例**（阿里云）是云厂商将空闲算力以大幅折扣提供给用户的实例类型。相比按需实例（On-Demand），Spot 实例通常便宜 60-80%。

**为什么有这么低的价格**：云厂商有大量空闲的物理服务器（按需实例峰谷波动导致），与其让这些算力空置，不如以极低价格出售。但云厂商保留了随时回收这些实例的权利——当按需实例需求增加时，Spot 实例会被通知 2 分钟后强制关机（AWS 的 `Spot Interruption Notice`）。

**Spark 作业的天然容忍性**：Spark 的 Task 失败重试机制使其天然对节点故障有一定容忍性——Spot 实例被回收等同于节点失联，Driver 感知到 Executor 丢失后，将 Task 标记为失败并重新调度到其他 Executor。

### 1.2 Spot 实例的使用风险

**风险一：大规模同时驱逐**

Spot 实例被回收不是单台，而是某个实例类型的区域性回收——如果你所有 Executor Pod 都运行在同一类型的 Spot 实例上，可能同时被大量驱逐，导致几乎所有 Task 失败，Stage 重试，作业耗时大幅增加甚至失败。

**风险二：Driver Pod 被驱逐**

Driver Pod 被驱逐是比 Executor 驱逐更严重的问题：Driver 是整个作业的协调者，Driver 进程终止 → 所有 Executor 自动退出 → 作业完全失败，从头重跑。如果 Driver 使用了 Checkpoint（Structured Streaming），则从最近 Checkpoint 恢复；否则整个作业需要重新提交。

**风险三：Shuffle 数据丢失**

Executor Pod 被驱逐时，本地 Shuffle 数据（emptyDir/HostPath）丢失，相关 Stage 需要完全重跑（重新执行上游 Stage 的 Task）。作业越到后期被驱逐，浪费的计算越多。

### 1.3 Spot 实例的使用策略

**策略一：Driver 用 On-Demand，Executor 用 Spot**

```yaml
# Driver Pod：使用 On-Demand 节点
spec:
  driver:
    nodeSelector:
      node.kubernetes.io/lifecycle: on-demand    # 只调度到按需实例节点
    tolerations: []

# Executor Pod：使用 Spot 节点
spec:
  executor:
    nodeSelector:
      node.kubernetes.io/lifecycle: spot         # 优先调度到 Spot 节点
    tolerations:
      - key: "node.kubernetes.io/spot-interrupt"
        operator: "Exists"
        effect: "NoSchedule"
```

这样即使所有 Spot Executor 被驱逐，Driver 依然存活，可以申请新的 Executor 重启失败的 Task，作业不需要从头重跑。

**策略二：多可用区、多实例类型分散风险**

```yaml
# 使用多个节点池（不同可用区 + 不同实例类型）
nodeSelector:
  node.kubernetes.io/lifecycle: spot
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 50
        podAffinityTerm:
          topologyKey: topology.kubernetes.io/zone   # 优先分散到不同可用区
          labelSelector:
            matchLabels:
              spark-role: executor
```

同一作业的 Executor 分布在多个可用区和多种实例类型（c5.4xlarge、m5.4xlarge、r5.4xlarge）上，单个可用区或单个实例类型的 Spot 回收只影响部分 Executor，不会导致全军覆没。

**策略三：开启 Spot Interruption Handler**

AWS Node Termination Handler（DaemonSet）监听 EC2 的 Spot 中断通知，在实例被回收前 2 分钟：
1. 给节点打 Taint（`node.kubernetes.io/spot-interrupt:NoSchedule`），阻止新 Pod 调度到该节点
2. Drain 节点（驱逐所有 Pod），让 K8s 有更充裕的时间重新调度
3. Spark 感知到 Executor 丢失，申请新 Executor，在其他节点重新启动

```bash
# 安装 AWS Node Termination Handler
helm repo add eks https://aws.github.io/eks-charts
helm install aws-node-termination-handler eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true
```

**策略四：Remote Shuffle Service（彻底规避 Shuffle 丢失）**

配合第 06 篇介绍的 RSS，Shuffle 数据存储在独立的 RSS 集群（运行在 On-Demand 节点上），Spot Executor 被驱逐时 Shuffle 数据不丢失，只需重新计算被中断的 Task（不需要重算整个 Stage）。

---

## 第 2 章 Gang Scheduling：解决 K8s 调度器的 Spark 痛点

### 2.1 默认 K8s 调度器的问题：资源死锁

K8s 默认调度器独立调度每个 Pod，不考虑 Pod 之间的整体性：

```
场景：集群剩余资源 = 20 CPU
作业 A（需要 10 个 Executor，每个 2 CPU）
作业 B（需要 10 个 Executor，每个 2 CPU）

默认调度结果：
  调度 A 的 Executor 1-7（14 CPU）
  调度 B 的 Executor 1-6（12 CPU）→ 超过 20 CPU，实际只能调度到 3 个
  剩余 6 CPU → 无法满足 A 剩余 3 个 Executor 或 B 剩余 4 个 Executor 的需求

结果：
  作业 A：7/10 个 Executor Ready，等待剩余 3 个
  作业 B：3/10 个 Executor Ready，等待剩余 7 个
  → 两个作业都在等待，但已调度的 Executor 占用了资源（闲置等待），
  → 集群有 6 CPU 闲置但谁也用不了
  → 死锁！
```

**这是 K8s 默认调度器在多 Spark 作业场景下的典型死锁问题**：部分 Executor 占用资源但等待其他 Executor，而其他 Executor 因资源不足 Pending——资源既没有被充分利用，作业也无法推进。

### 2.2 Gang Scheduling 的解决方案

**Gang Scheduling（群组调度）**：一个 "Gang"（作业的所有 Pod）必须**全部调度成功后才开始运行**；如果无法全部调度，则全部等待（不占用任何资源）。

```
Gang Scheduling 的调度结果（同样场景）：
  调度器先评估整体资源：
    作业 A 需要 20 CPU → 集群有 20 CPU → 作业 A 可以全部调度
    调度作业 A 的全部 10 个 Executor（20 CPU）
  
  作业 B：等待（因为集群 20 CPU 全被 A 占用）
  → 作业 A 完成后，释放 20 CPU
  → 调度作业 B 的全部 10 个 Executor

结果：
  作业 A 先全量运行并完成
  作业 B 后全量运行并完成
  总时间 < 死锁场景（死锁时两个作业都停滞不前）
```

### 2.3 Volcano：Kubernetes 上的 Gang Scheduling 实现

**[[Volcano]]** 是华为开源的 K8s 批处理计算框架，提供 Gang Scheduling 等高级调度能力，已进入 CNCF 沙箱项目。

**Volcano 的核心概念**：

- **Queue**：资源池，类似 YARN 的队列，支持权重和最小资源保障
- **PodGroup**：一组需要被 Gang Scheduled 的 Pod，设置 `minMember`（最少需要几个 Pod 同时调度）
- **Job**（Volcano Job，不同于 K8s Job）：提交到 Volcano 的作业，包含多个 Pod

**Spark on K8s 使用 Volcano 的配置**：

```
# spark-submit 配置使用 Volcano 调度器
spark.kubernetes.scheduler.name=volcano
spark.kubernetes.volcano.podGroupPolicy=gang
spark.kubernetes.driver.annotation.scheduling.volcano.sh/pod-group=my-app-podgroup
spark.kubernetes.executor.annotation.scheduling.volcano.sh/pod-group=my-app-podgroup
```

Spark Operator 集成 Volcano 时，Operator 自动为每个 SparkApplication 创建对应的 PodGroup：

```yaml
# Volcano PodGroup（由 Spark Operator 自动创建）
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata:
  name: payment-etl-daily-pg
  namespace: spark-production
spec:
  minMember: 11        # 1 Driver + 10 Executor，全部就绪才开始
  minResources:
    cpu: "42"          # 总需求：Driver(2) + 10×Executor(4) = 42 CPU
    memory: "84Gi"     # Driver(4g) + 10×Executor(8g) = 84Gi
  queue: data-eng-queue
  priorityClassName: spark-normal
```

### 2.4 Apache Yunikorn：另一个 Gang Scheduling 方案

**[[Apache Yunikorn]]**（原 Alibaba Scheduler，2019 年贡献给 Apache）也提供 Gang Scheduling，且与 Spark 的集成更轻量（不需要替换整个调度器，通过 Scheduler Plugin 扩展）：

```
spark.kubernetes.scheduler.name=yunikorn
spark.kubernetes.driver.label.queue=root.data-eng
spark.kubernetes.executor.label.queue=root.data-eng
# Yunikorn 自动识别同一作业的 Driver/Executor，实现 Gang Scheduling
```

**Volcano vs Yunikorn 对比**：

| 维度 | Volcano | Apache Yunikorn |
|-----|---------|----------------|
| **架构** | 替换 K8s 调度器 | K8s Scheduler Plugin（扩展原调度器）|
| **兼容性** | 需要所有 Pod 都通过 Volcano 调度 | 可与原 kube-scheduler 共存 |
| **CNCF 状态** | CNCF 沙箱 | Apache 顶级项目 |
| **Spark 集成** | 需要显式配置 PodGroup | 自动识别，配置较少 |
| **Queue 管理** | 内置 Queue 和 Weight | 内置 Hierarchy Queue |
| **生产成熟度** | 华为、字节等大厂生产使用 | Alibaba 大规模生产验证 |

---

## 第 3 章 容量规划

### 3.1 节点规格的选择

**节点大小与 Pod 密度的权衡**：

- **大节点**（如 64 CPU、256GB）：单节点可以运行更多 Executor Pod（64/4=16 个 4CPU 的 Executor），节点间网络通信少，Shuffle 本地性好；但单节点故障影响面大（16 个 Executor 同时丢失）
- **小节点**（如 8 CPU、32GB）：单节点只能运行 2 个 4CPU Executor，节点故障影响小；但节点数量多，管理开销大，节点调度效率低

**经验法则**：Spark 场景推荐使用**中等大小节点（16-32 CPU，64-128GB）**，平衡了故障影响面和管理开销。

### 3.2 集群容量规划公式

```
目标集群容量 = 峰值并发作业数 × 单作业平均资源需求 × 安全系数

例：
  峰值并发作业数：30 个作业
  单作业平均：10 Executor × 4 CPU = 40 CPU，10 × 8GB = 80GB
  安全系数：1.3（留 30% 余量）

  目标 CPU = 30 × 40 × 1.3 = 1560 CPU
  目标 Memory = 30 × 80GB × 1.3 = 3120GB

  使用 32 CPU、128GB 节点：
  节点数 = max(1560/32, 3120/128) = max(49, 24) = 49 台（CPU 瓶颈）
```

### 3.3 资源配额的分配策略

将集群总容量按团队优先级和历史用量分配 ResourceQuota：

```yaml
# 团队资源配额分配（总集群：1500 CPU，3000GB）
data-engineering:
  requests.cpu: "600"      # 40% CPU
  requests.memory: "1200Gi"

ml-team:
  requests.cpu: "450"      # 30% CPU
  requests.memory: "900Gi"

realtime-team:
  requests.cpu: "300"      # 20% CPU
  requests.memory: "600Gi"

adhoc:
  requests.cpu: "150"      # 10% CPU（共享给临时查询）
  requests.memory: "300Gi"
```

**弹性借用机制**（通过 Volcano Queue 的 Deserved 和 Capability 实现）：当 ml-team 配额有剩余时，data-engineering 可以临时借用（Borrowed），但当 ml-team 需要资源时，data-engineering 借用的部分被回收（Preempt）。

---

## 小结

Spark on K8s 资源优化的三层体系：

- **Spot 实例**：Executor 用 Spot（省成本），Driver 用 On-Demand（保稳定）；多可用区+多实例类型分散风险；Node Termination Handler 提前感知中断；RSS 彻底规避 Shuffle 数据丢失
- **Gang Scheduling**：解决多作业资源死锁；Volcano 或 Yunikorn 提供 `minMember` 全量调度保证；Spark Operator 集成时自动管理 PodGroup
- **容量规划**：中等大小节点（16-32 CPU）；按峰值并发 × 安全系数计算总容量；按团队优先级分配 ResourceQuota，Volcano Queue 支持弹性借用

第 09 篇讲解安全加固：K8s Secrets 管理 Spark 敏感配置（数据库密码、S3 密钥）、Kerberos 认证在 K8s 容器中的配置难点（keytab 注入与续约）、NetworkPolicy 隔离 Spark Pod 的网络访问。

---

## 参考资料

- [AWS Spot Instances Best Practices](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html)
- [AWS Node Termination Handler GitHub](https://github.com/aws/aws-node-termination-handler)
- [Volcano 官方文档](https://volcano.sh/en/docs/)
- [Apache Yunikorn 官方文档](https://yunikorn.apache.org/)
- [Gang Scheduling in Kubernetes（KubeCon 2019）](https://www.youtube.com/watch?v=...)
