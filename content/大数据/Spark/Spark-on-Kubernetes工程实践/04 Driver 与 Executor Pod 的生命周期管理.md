---
title: "Driver 与 Executor Pod 的生命周期管理"
date: 2026-02-28
tags: [DRA, Driver, Executor, Kubernetes, Pod, PriorityClass, Spark, 动态资源分配, 心跳, 生命周期]
aliases: []
---

# 04 Driver 与 Executor Pod 的生命周期管理

## 摘要

Driver 和 Executor Pod 从创建到销毁的完整生命周期管理，是排查 Spark on K8s 生产问题的核心能力。Driver Pod 的生命周期由 `spark-submit` 触发，经历 Pending → Running → Completed/Failed 几个阶段，每个阶段卡住的原因各不相同。Executor Pod 的生命周期更复杂：Driver 动态创建 Executor Pod，Executor 启动后向 Driver 注册，Driver 通过心跳机制监控 Executor 存活，作业完成后 Executor Pod 被主动删除。本文详解两类 Pod 的完整生命周期状态机、动态资源分配（Dynamic Resource Allocation，DRA）在 K8s 上的实现原理（与 YARN 模式的差异）、Executor 心跳超时的处理逻辑（`spark.network.timeout`），以及 PriorityClass 如何在多作业资源竞争时保护高优先级作业的 Executor 不被抢占驱逐。

---

## 第 1 章 Driver Pod 的生命周期

### 1.1 Driver Pod 的状态机

[[Kubernetes]] 中 Pod 的状态（`phase`）有五种：

| Phase | 含义 |
|------|------|
| `Pending` | Pod 已创建，尚未被调度到节点，或容器镜像正在拉取 |
| `Running` | Pod 已调度到节点，至少一个容器正在运行 |
| `Succeeded` | Pod 中所有容器都已正常退出（exit code=0）|
| `Failed` | Pod 中至少一个容器以非零 exit code 退出 |
| `Unknown` | Pod 状态无法获取（通常是节点通信故障）|

对于 Spark Driver Pod，典型的生命周期：

```
Pending（spark-submit 创建 Driver Pod，等待调度）
  ↓ K8s Scheduler 绑定节点
  ↓ kubelet 拉取镜像（如未缓存）
Running（Driver JVM 启动，申请 Executor Pod，执行作业）
  ↓ 作业完成
Succeeded（所有 Task 完成，Driver JVM 正常退出，exit code=0）
```

**Driver Pod 卡在 Pending 的常见原因**：

1. **资源不足**：Namespace 的 ResourceQuota 或节点资源不够，Driver Pod 无法调度
   - 诊断：`kubectl describe pod <driver-pod-name> -n spark-ns` → Events 中看 `Insufficient cpu/memory`
   
2. **镜像拉取失败**：私有镜像仓库认证失败，或镜像 Tag 不存在
   - Pod 状态：`ErrImagePull` 或 `ImagePullBackOff`
   - 诊断：检查 `imagePullSecrets` 配置；`kubectl describe pod` 看详细错误

3. **Node Affinity/Taint 不匹配**：Driver Pod 的节点选择条件（Node Selector、Affinity）在集群中没有满足条件的节点
   - 诊断：Events 中看 `0/N nodes are available: N node(s) had untolerated taint`

### 1.2 Driver Pod 完成后的状态保留

作业完成后，Driver Pod 进入 `Succeeded` 状态，但 **Pod 本身不会被自动删除**——K8s 默认保留完成的 Pod 供用户查看日志。这会导致两个问题：

**问题一：僵尸 Pod 积累**

高频作业（如每分钟一个 AvailableNow Trigger 触发的 Spark 作业）每天产生 1440 个 `Succeeded` Driver Pod，长期积累占用 K8s etcd 存储，拖慢 API Server 响应。

**解决方案**：设置 TTL（Time-To-Live），让 K8s 自动清理完成的 Pod：

```yaml
# Driver Pod Spec 中设置 TTL（Spark 会自动将此配置应用到 Driver Pod）
spark.kubernetes.driver.pod.featureStep=...
```

或者通过 Spark 配置：

```
spark.kubernetes.driver.podTemplateFile=/path/to/driver-template.yaml
```

在 Pod Template 中设置：

```yaml
spec:
  # K8s 1.21+ 支持 ttlSecondsAfterFinished
  # 注意：Driver Pod 是 Job 创建的才支持，直接创建的 Pod 需要通过 Spark Operator 管理
```

更实用的方案是通过 **Spark Operator** 统一管理 Pod 生命周期（第 07 篇详述），Operator 会在作业完成后自动清理 Driver Pod。

**问题二：日志消失**

Driver Pod 被删除后，`kubectl logs` 无法获取日志。解决方案：配置集中日志收集（EFK 或 Loki），让 Driver/Executor Pod 的日志在 Pod 删除前被采集并持久化存储。

---

## 第 2 章 Executor Pod 的生命周期

### 2.1 Executor Pod 的创建流程

Driver 启动后，`KubernetesClusterSchedulerBackend` 中的 `ExecutorPodsAllocator` 组件负责 Executor Pod 的创建：

```
Driver 启动
  → KubernetesClusterSchedulerBackend.start()
    → ExecutorPodsAllocator.start()
      → 根据 spark.executor.instances（静态模式）
        或 DRA 的当前需求（动态模式）
        构建 Executor Pod Spec
      → 调用 K8s API：POST /api/v1/namespaces/{ns}/pods
    → ExecutorPodsWatcher.start()
      → Watch K8s Pod 状态变化（使用 K8s Watch API 的长轮询）
```

**Executor Pod Spec 的关键字段**（由 Driver 自动生成）：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app-exec-1-<random-suffix>
  labels:
    spark-app-selector: "spark-<appId>"     # 关联到 Driver 作业
    spark-role: executor
    spark-executor-id: "1"
spec:
  serviceAccountName: spark-driver-sa      # 使用与 Driver 相同的 SA
  restartPolicy: Never                     # 重要：Executor 失败后不自动重启，由 Spark 处理
  containers:
    - name: executor
      image: my-spark:3.3.2
      env:
        - name: SPARK_ROLE
          value: executor
        - name: SPARK_DRIVER_URL
          value: spark://driver-host:7078   # Driver 的 RPC 地址
        - name: SPARK_EXECUTOR_ID
          value: "1"
      resources:
        requests:
          cpu: "4"
          memory: "8Gi"
        limits:
          cpu: "4"
          memory: "9Gi"     # limits = executor.memory + memoryOverhead
```

**`restartPolicy: Never` 是关键设计**：K8s Pod 有 `Always`、`OnFailure`、`Never` 三种重启策略。Spark 将 Executor Pod 设置为 `Never`——Executor 失败后 K8s 不重启它，而是由 Spark Driver 感知到 Executor 丢失后，根据 `spark.task.maxFailures` 的配置决定是否重新提交 Task 到其他 Executor，并由 `ExecutorPodsAllocator` 申请新的 Executor Pod 替代失败的那个。

**为什么不用 `OnFailure` 重启**：Executor 失败的原因可能是 Task 代码 Bug、数据问题或节点问题——自动重启可能陷入无限失败循环，不如由 Driver 统一决策。

### 2.2 Executor Pod 的注册流程

Executor Pod 启动后（`SPARK_ROLE=executor` 的 `entrypoint.sh`），执行以下步骤：

```
Executor JVM 启动
  → CoarseGrainedExecutorBackend.main()
    → 向 Driver 发起 RPC 连接（使用 SPARK_DRIVER_URL 环境变量）
    → 发送 RegisterExecutor 消息
  
Driver 端：
  → CoarseGrainedSchedulerBackend.receiveRegisterExecutor()
    → 记录 Executor ID、主机、CPU 核数
    → 回复 RegisteredExecutor
  
Executor 注册成功后：
  → Driver 可以向该 Executor 分配 Task
```

**注册超时**：如果 Executor Pod 启动后无法连接 Driver（网络问题、Driver 已崩溃），会在 `spark.executor.heartbeatInterval`（默认 10 秒）× 超时倍数后退出，Pod 进入 `Failed` 状态。

### 2.3 Executor Pod 的正常退出 vs 异常退出

**正常退出**：

```
Driver 完成所有 Task
  → 向 Executor 发送 StopExecutor 消息（或 KillTask + 超时）
  → Executor JVM 正常退出（exit code=0）
  → Executor Pod 状态：Succeeded
  → Driver 调用 K8s API 删除该 Executor Pod（或保留供调试）
```

**异常退出类型**：

| 退出原因 | Pod 状态 | K8s 容器状态 | Driver 的处理 |
|--------|---------|------------|------------|
| OOM（Java 堆溢出）| Failed | `OOMKilled`（exit code=137）| 感知 Executor 丢失，申请新 Executor 替代；Task 标记失败重试 |
| 任务代码 Bug（未捕获异常）| Failed | `Error`（exit code 非 0）| 同上，Task 标记失败重试 |
| 节点故障（kubelet 停止响应）| Unknown → Failed | — | Executor 心跳超时，Driver 主动标记 Executor 丢失 |
| Spot 实例被抢占 | Failed | `OOMKilled` 或 `Error` | 同上 |
| 手动 `kubectl delete pod` | — | — | Executor 心跳超时，Driver 主动标记丢失 |

---

## 第 3 章 动态资源分配（DRA）在 K8s 上的实现

### 3.1 DRA 是什么，为什么在 K8s 上有特殊性

**动态资源分配（Dynamic Resource Allocation）**：Spark 根据当前待处理的 Task 数量，动态增加或减少 Executor 数量，而不是在作业开始时申请固定数量的 Executor。

在 YARN 模式下，DRA 通过申请/释放 YARN Container 实现，K8s 模式下通过创建/删除 Executor Pod 实现。但 K8s 模式有一个重要差异：**YARN 有 External Shuffle Service（ESS），K8s 原生没有**。

### 3.2 Shuffle Service 的问题：为什么 DRA 需要它

Spark 的 Shuffle 机制：Map Task 将 Shuffle 数据写到 Executor 本地磁盘，Reduce Task 从 Map Task 所在的 Executor 远程读取。

**没有 External Shuffle Service 时**：Reduce Task 必须在 Map Task 完成且 Executor 仍然存活时才能读取 Shuffle 数据。如果 DRA 在 Map Task 完成后认为 Executor 空闲，将其删除（Pod 删除 → 本地磁盘数据消失），后续的 Reduce Task 无法读取 Shuffle 数据 → Task 失败。

**解决方案**：

**方案一**：禁用 DRA 的 Executor 提前释放，等 Reduce Task 也完成后再释放

```
spark.dynamicAllocation.shuffleTracking.enabled=true
```

开启 Shuffle Tracking 后，Driver 会跟踪哪些 Executor 还有未被读取的 Shuffle 数据，不会提前释放这些 Executor，直到对应的 Reduce Task 完成。

**方案二**：部署 Remote Shuffle Service（第 06 篇详述）

将 Shuffle 数据写到独立的 Remote Shuffle Service（如 Apache Uniffle、Magnet），与 Executor Pod 解耦，Executor 可以在 Map Task 完成后立即释放。

### 3.3 K8s DRA 的配置

```python
# 开启 DRA（K8s 模式）
spark.dynamicAllocation.enabled=true
spark.dynamicAllocation.shuffleTracking.enabled=true  # K8s 必须开启
spark.dynamicAllocation.minExecutors=2               # 最少保留 2 个 Executor
spark.dynamicAllocation.maxExecutors=50              # 最多 50 个 Executor
spark.dynamicAllocation.initialExecutors=5           # 启动时初始 5 个
spark.dynamicAllocation.executorIdleTimeout=60s      # 空闲 60 秒后释放
spark.dynamicAllocation.cachedExecutorIdleTimeout=infinity  # 有缓存数据的 Executor 不释放
```

**DRA 的扩缩容逻辑**：

```
扩容（Scale Up）：
  当等待调度的 Task 数 > 当前 Executor 数时，申请更多 Executor
  每轮最多翻倍（1→2→4→8→16...）直到 maxExecutors

缩容（Scale Down）：
  当 Executor 空闲时间 > executorIdleTimeout 时，标记为可释放
  调用 K8s API 删除该 Executor Pod
  如果开启了 Shuffle Tracking，有未读 Shuffle 数据的 Executor 不被释放
```

---

## 第 4 章 心跳机制与 Executor 丢失处理

### 4.1 Executor 心跳的工作原理

Executor 定期向 Driver 发送心跳（Heartbeat）消息，报告自身存活状态和 Task 进度：

```
Executor → Driver（每 spark.executor.heartbeatInterval=10s 发送一次）
  心跳内容：
    - Executor ID
    - 当前运行中的 Task ID 和进度
    - Accumulator 更新值
    - 内存使用情况（GC 统计等）
```

Driver 接收心跳后，更新 Executor 的最后心跳时间戳。如果某个 Executor 超过 `spark.network.timeout`（默认 120 秒）没有发送心跳，Driver 将该 Executor 标记为**丢失（Lost）**。

### 4.2 Executor 丢失后的连锁处理

```
Driver 检测到 Executor E 丢失
  → 将 E 上所有运行中的 Task 标记为 FAILED
  → 将这些 Task 重新放入调度队列（等待其他 Executor 执行）
  → 如果某个 Task 失败次数 > spark.task.maxFailures（默认 4），作业失败
  → 将 E 上已完成但 Shuffle 数据未被消费的 Map Output 标记为无效
    （需要 Reduce Task 重新从其他 Executor 获取这些 Map Output，
     如果无法重新获取，触发 Stage 重试）
  → 通知 ExecutorPodsAllocator 申请新 Executor 替代 E（如果开启 DRA）
```

> [!warning] 生产避坑
> **心跳超时参数的一致性**：`spark.executor.heartbeatInterval`（心跳发送间隔，默认 10s）必须远小于 `spark.network.timeout`（超时判断阈值，默认 120s）。如果修改了 `network.timeout` 为更小的值（如 30s）但未相应调小 `heartbeatInterval`，可能导致正常运行的 Executor 因偶发的心跳延迟被误判为丢失。建议保持 `heartbeatInterval < network.timeout / 4`。

---

## 第 5 章 PriorityClass：多作业资源竞争时的优先级管理

### 5.1 为什么需要 PriorityClass

在多团队共享集群的场景中，不同作业对时效性的要求不同：

- **关键 SLA 作业**（如实时数仓 T+0 对账）：必须在截止时间前完成，资源不足时应优先保障
- **普通 ETL 作业**：可以接受延迟，资源不足时让出资源给高优先级作业
- **临时分析作业（Ad-hoc）**：优先级最低，资源充足时运行

**`PriorityClass`** 是 K8s 为 Pod 设置调度和抢占优先级的机制：高优先级的 Pod 在资源不足时，可以抢占（Preempt）低优先级 Pod 的资源，迫使低优先级 Pod 被驱逐（Evict）。

### 5.2 为 Spark 作业创建 PriorityClass

```yaml
# 三个优先级级别
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: spark-critical          # 关键 SLA 作业
value: 1000000                  # 优先级值越大越优先
globalDefault: false
description: "Critical Spark jobs with SLA requirements"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: spark-normal            # 普通 ETL 作业
value: 100000
globalDefault: false
description: "Normal Spark ETL jobs"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: spark-adhoc             # Ad-hoc 分析作业
value: 10000
globalDefault: false
description: "Ad-hoc analysis jobs, lowest priority"
```

```bash
# spark-submit 时指定优先级
spark-submit \
  --conf spark.kubernetes.driver.podTemplateFile=driver-template.yaml \
  --conf spark.kubernetes.executor.podTemplateFile=executor-template.yaml \
  ...

# driver-template.yaml
spec:
  priorityClassName: spark-critical   # 指定 Driver Pod 的优先级
```

或通过 Spark 配置直接设置：

```
spark.kubernetes.driver.label.app.kubernetes.io/priority=critical
spark.kubernetes.executor.podTemplateFile=/path/to/executor-template.yaml
```

### 5.3 抢占的工作机制与风险

当高优先级作业的 Pod 因资源不足无法调度时，K8s Scheduler 会寻找可以被驱逐的低优先级 Pod：

```
新 Pod（spark-critical，优先级=1000000）需要 16 CPU
集群剩余资源：2 CPU

K8s Scheduler 查找可抢占的 Pod：
  → 找到 spark-adhoc 作业的 10 个 Executor Pod（每个 2 CPU）
  → 驱逐 7 个 adhoc Executor Pod（释放 14 CPU）
  → 合计可用：2 + 14 = 16 CPU
  → 调度高优先级 Pod
```

被驱逐的 adhoc Executor Pod 进入 `Failed` 状态，Driver 感知到 Executor 丢失，相关 Task 重新调度。如果 adhoc 作业的 Driver 配置了重试，作业最终会在集群资源释放后恢复运行；否则作业失败。

> [!note] 设计哲学
> PriorityClass 的抢占机制是一把双刃剑：它保护了高优先级作业的 SLA，但被抢占的低优先级作业会受到影响（部分 Task 重试，甚至作业失败）。在 Spark 场景中，Executor 被驱逐导致的 Task 重试通常是可以容忍的，但如果低优先级作业有 Checkpoint 或状态（如 Structured Streaming），驱逐可能导致更严重的中断。建议将 Structured Streaming 作业设置为中等优先级（`spark-normal`），避免被频繁抢占。

---

## 小结

Driver 和 Executor Pod 生命周期管理的核心要点：

- **Driver Pod**：`restartPolicy: Never`，作业完成后进入 `Succeeded/Failed`；建议通过 Spark Operator 自动清理，防止僵尸 Pod 积累
- **Executor Pod**：由 Driver 的 `ExecutorPodsAllocator` 动态创建/删除；`restartPolicy: Never`，失败由 Spark 层处理（Task 重试 + 申请新 Executor）
- **DRA in K8s**：必须开启 `shuffleTracking.enabled=true`（无外部 Shuffle Service 时），防止 Reduce Task 读取已删除 Executor 的 Shuffle 数据失败
- **心跳机制**：`heartbeatInterval=10s` 发送心跳，`network.timeout=120s` 超时判定 Executor 丢失；两者比值建议 ≥ 4:1，避免误判
- **PriorityClass**：三级优先级（critical/normal/adhoc）保障关键作业 SLA，抢占机制会中断低优先级 Executor，Streaming 作业应至少设置为 normal 避免频繁被抢占

第 05 篇讲解 Spark UI 的 K8s 访问方案：Ingress、NodePort 与 Headless Service 三种方案的对比，以及 History Server 在 K8s 上的部署模式（EventLog 持久化到对象存储）。

---

> [!note] 思考题
> 1. Driver Pod 完成后，K8s 默认会保留 Pod（处于 `Completed` 或 `Failed` 状态），以便获取日志。但在高频作业场景下，大量已完成的 Pod 会占用 K8s etcd 存储并影响 API Server 性能。`spark.kubernetes.driver.deleteOnTermination` 参数控制是否自动删除已完成的 Driver Pod。在什么场景下应该保留，什么场景下应该删除？如何在日志保留与 etcd 压力之间取得平衡？
> 2. Executor Pod 的注册过程是异步的——Spark 通过 `spark-submit` 提交作业后，Driver 开始创建 Executor Pod，但这些 Pod 可能因为镜像拉取、节点调度等原因延迟启动。`spark.kubernetes.allocation.batch.size` 和 `spark.kubernetes.allocation.batch.delay` 控制 Executor 的分批创建速率。如果一次性创建大量 Executor Pod（如 1000 个），会对 K8s API Server 产生什么冲击？
> 3. 当 Executor Pod 被 K8s 驱逐（Eviction）时（如节点内存压力触发），Spark 会将其视为 Executor 失败并重新申请。但如果整个节点的内存压力持续存在，新创建的 Executor Pod 仍然会被调度到同一节点（K8s 调度器不了解 Spark 的 Executor 历史失败原因）。这种"反复驱逐-重建"的循环会导致作业永远无法完成。如何通过 K8s 的亲和性/反亲和性规则或污点容忍来避免这个问题？

## 参考资料

- Apache Spark 官方文档：Running Spark on Kubernetes - Dynamic Resource Allocation
- Kubernetes 官方文档：Pod Priority and Preemption
- Apache Spark 源码：`org.apache.spark.scheduler.cluster.k8s.ExecutorPodsAllocator`
- Apache Spark 源码：`org.apache.spark.HeartbeatReceiver`
