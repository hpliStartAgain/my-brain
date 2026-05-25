---
title: "04 DaemonSet Job CronJob 控制器解析"
date: 2026-03-04
tags: [Controller, CronJob, DaemonSet, Job, Kubernetes, TTL, 云原生, 批处理, 节点守护]
aliases: []
---

# 04 DaemonSet Job CronJob 控制器解析

**摘要：**

前两篇文章分析了面向"长期运行服务"的控制器——[[02 Deployment 控制器深度解析|Deployment]]（无状态服务）和 [[03 StatefulSet 控制器深度解析|StatefulSet]]（有状态服务）。本文聚焦另外三种工作负载控制器：**DaemonSet**（节点级守护进程——确保每个节点运行一个 Pod）、**Job**（一次性批处理任务——运行至完成后退出）、**CronJob**（定时任务——按 Cron 表达式周期性创建 Job）。这三种控制器覆盖了"节点基础设施"和"批处理计算"两大场景，与 Deployment/StatefulSet 形成互补。本文逐一分析它们的工作机制、调度策略、失败处理和生产配置。

---

## 第 1 章 DaemonSet 控制器

### 1.1 设计目的

**DaemonSet 确保在集群的每个节点（或特定子集的节点）上运行且只运行一个 Pod 副本。** 典型的使用场景：

| 场景 | 示例 |
| :--- | :--- |
| **日志采集** | 每个节点运行一个 Fluentd/Filebeat Pod，采集节点上所有容器的日志 |
| **监控代理** | 每个节点运行一个 Prometheus Node Exporter，暴露节点级指标 |
| **网络插件** | 每个节点运行一个 [[05 容器网络原理|CNI]] 插件 Pod（如 Calico、Cilium）|
| **存储守护** | 每个节点运行一个 CSI 驱动 Pod |
| **安全代理** | 每个节点运行一个安全扫描或审计 Pod |

DaemonSet 与 Deployment 的核心区别：Deployment 的目标是"运行 N 个副本"（N 由 replicas 指定），DaemonSet 的目标是"每个节点运行 1 个副本"（副本数由节点数决定）。

### 1.2 节点覆盖策略

DaemonSet Controller 的 Reconcile 逻辑：

1. 列出集群中所有 Node
2. 对每个 Node，检查是否已经存在该 DaemonSet 的 Pod
3. 如果 Node 上没有 Pod → 创建一个
4. 如果 Node 上有多余的 Pod（异常情况）→ 删除多余的
5. 如果 Node 不满足调度条件 → 不创建（或删除已有的 Pod）

**调度条件**包括：

- **Node Selector**：DaemonSet 的 `spec.template.spec.nodeSelector` 限定了 Pod 只运行在带有特定 Label 的节点上
- **Node Affinity**：更灵活的节点选择规则
- **Tolerations**：Pod 是否容忍节点上的 Taint（污点）

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule    # 容忍 Master 节点的 Taint，在 Master 上也运行
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.7.0
          ports:
            - containerPort: 9100
              hostPort: 9100    # 绑定到节点端口
```

### 1.3 DaemonSet 的调度机制演进

**K8s 1.12 之前**：DaemonSet Controller 自己执行调度逻辑——直接在 Pod 的 `spec.nodeName` 中填入目标节点名称，绕过 Scheduler。这导致 DaemonSet 的 Pod 不遵守 Scheduler 的调度约束（如资源配额、拓扑分散、抢占等）。

**K8s 1.12+**：DaemonSet Controller 不再直接设置 nodeName，而是为 Pod 添加 **nodeAffinity**——指定目标节点。Pod 创建后由 Scheduler 正常调度。这使得 DaemonSet 的 Pod 与普通 Pod 一样受 Scheduler 的所有调度约束管控。

```yaml
# DaemonSet Controller 为 Pod 自动添加的 nodeAffinity
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchFields:
              - key: metadata.name
                operator: In
                values: ["worker-1"]    # 目标节点
```

### 1.4 DaemonSet 的滚动更新

DaemonSet 支持两种更新策略：

**RollingUpdate**（默认）：逐节点更新——在每个节点上先删除旧 Pod，再创建新 Pod。通过 `maxUnavailable` 控制同时更新的节点数（默认 1）。

**OnDelete**：手动删除 Pod 后，Controller 用新模板重建。

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1        # 同时更新的最大节点数
      maxSurge: 0              # K8s 1.22+，同时运行的额外 Pod 数
```

**maxSurge**（K8s 1.22+）：允许在删除旧 Pod 之前先创建新 Pod——实现"先起新再杀旧"的零停机更新。对于 CNI 插件等关键基础设施，这避免了"删除旧 Pod 后网络中断，新 Pod 因网络不可用而无法启动"的死锁。

> [!warning] DaemonSet 更新的特殊风险
> DaemonSet 管理的通常是**节点基础设施**（网络插件、日志代理、监控代理）。如果更新后的新版本有 bug 导致启动失败，该节点上的基础设施服务会中断——可能导致节点上所有 Pod 网络不通（CNI 插件故障）或日志丢失（日志代理故障）。因此 DaemonSet 的更新应比 Deployment 更谨慎——建议先在少量节点上测试（通过 nodeSelector 限定更新范围），确认无问题后再全量更新。

---

## 第 2 章 Job 控制器

### 2.1 设计目的

**Job 管理一次性批处理任务——Pod 运行至成功完成后退出，Job Controller 确保指定数量的 Pod 成功完成。** 与 Deployment 的 Pod "永远运行"不同，Job 的 Pod 有明确的完成条件。

典型场景：

| 场景 | 示例 |
| :--- | :--- |
| **数据处理** | 从数据库导出数据、ETL 转换 |
| **批量计算** | 机器学习训练、渲染任务 |
| **数据库迁移** | Schema 变更、数据回填 |
| **一次性初始化** | 创建初始用户、导入基础数据 |

### 2.2 完成条件

Job 的核心参数定义了"什么算完成"和"如何运行"：

| 参数 | 默认值 | 含义 |
| :--- | :--- | :--- |
| **completions** | 1 | 需要成功完成的 Pod 总数 |
| **parallelism** | 1 | 同时运行的最大 Pod 数 |
| **backoffLimit** | 6 | 最大重试次数（Pod 失败后重试的次数）|
| **activeDeadlineSeconds** | 无 | Job 的最大运行时间（超时后所有 Pod 被杀死）|

### 2.3 三种并行模型

**模型一：单 Pod 任务**（completions=1, parallelism=1）

最简单的模式——运行一个 Pod，成功退出后 Job 完成。

**模型二：固定完成数的并行任务**（completions=N, parallelism=M）

需要 N 个 Pod 成功完成，同时最多运行 M 个。适用于可以拆分为独立子任务的场景——例如处理 100 个文件，每个 Pod 处理一个文件，`completions=100, parallelism=10`（同时处理 10 个）。

```
completions=5, parallelism=2:

时间线:
  T0: Pod-0 启动, Pod-1 启动     (active=2)
  T1: Pod-0 成功                  (active=1, succeeded=1)
  T1: Pod-2 启动                  (active=2, succeeded=1)
  T2: Pod-1 成功, Pod-2 成功      (active=0, succeeded=3)
  T2: Pod-3 启动, Pod-4 启动      (active=2, succeeded=3)
  T3: Pod-3 成功, Pod-4 成功      (active=0, succeeded=5)
  → Job 完成 (5/5 succeeded)
```

**模型三：工作队列并行任务**（completions=null, parallelism=M）

不指定 completions——Pod 从外部工作队列（如 Redis、RabbitMQ）获取任务。当某个 Pod 成功退出且退出码为 0 时（表示队列为空），Job 完成。

### 2.4 失败处理

当 Pod 失败（退出码非 0 或被 OOM 杀死）时，Job Controller 的处理逻辑：

1. 记录失败次数
2. 如果失败次数 < `backoffLimit`，创建新 Pod 重试
3. 重试间隔按指数退避增长：10s → 20s → 40s → ... → 最大 6 分钟
4. 如果失败次数 ≥ `backoffLimit`，Job 标记为 **Failed**，不再重试

```yaml
spec:
  backoffLimit: 3              # 最多重试 3 次
  activeDeadlineSeconds: 600   # 最多运行 10 分钟
  template:
    spec:
      restartPolicy: Never     # Pod 失败后不在原节点重启，而是创建新 Pod
```

**restartPolicy 的选择**：

- `Never`：Pod 失败后 Job Controller 创建新 Pod（在可能不同的节点上）。适用于大多数场景。
- `OnFailure`：Pod 内的容器失败后在同一个 Pod 中重启（在同一节点上）。适用于需要保留本地状态的场景。

### 2.5 Pod Failure Policy（K8s 1.26+）

默认的失败处理太粗暴——任何原因的失败都计入 backoffLimit。但某些失败是"可重试的"（如节点故障导致 Pod 被驱逐），某些是"不可重试的"（如配置错误导致容器无法启动）。

**Pod Failure Policy** 允许根据失败原因定义不同的处理策略：

```yaml
spec:
  podFailurePolicy:
    rules:
      - action: FailJob           # 直接标记 Job 失败，不重试
        onExitCodes:
          containerName: main
          operator: In
          values: [42]             # 退出码 42 表示不可恢复错误
      - action: Ignore             # 忽略此类失败，不计入 backoffLimit
        onPodConditions:
          - type: DisruptionTarget  # 节点驱逐导致的 Pod 失败
      - action: Count              # 计入 backoffLimit（默认行为）
        onExitCodes:
          operator: NotIn
          values: [0]
```

### 2.6 Indexed Job（K8s 1.24+）

**Indexed Job** 为每个 Pod 分配一个唯一的索引（0, 1, 2, ...），通过环境变量 `JOB_COMPLETION_INDEX` 传递给容器。Pod 可以根据自己的索引决定处理哪个数据分片。

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-process
spec:
  completions: 10
  parallelism: 5
  completionMode: Indexed    # 启用 Indexed 模式
  template:
    spec:
      containers:
        - name: worker
          image: my-worker:v1
          command: ["process-shard", "--index=$(JOB_COMPLETION_INDEX)"]
```

Indexed Job 避免了传统模型中"多个 Pod 争抢同一个任务"的问题——每个 Pod 有明确的分工。

---

## 第 3 章 CronJob 控制器

### 3.1 设计目的

**CronJob 按照 Cron 表达式周期性创建 Job。** 每次调度时间到达时，CronJob Controller 创建一个新的 Job 对象，Job Controller 负责实际的 Pod 创建和管理。

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-backup
spec:
  schedule: "0 2 * * *"        # 每天凌晨 2 点
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: backup-tool:v1
              command: ["backup.sh"]
          restartPolicy: OnFailure
```

### 3.2 Cron 表达式

K8s 使用标准的 5 字段 Cron 表达式：

```
┌───────────── 分钟 (0-59)
│ ┌───────────── 小时 (0-23)
│ │ ┌───────────── 日 (1-31)
│ │ │ ┌───────────── 月 (1-12)
│ │ │ │ ┌───────────── 星期 (0-6，0=周日)
│ │ │ │ │
* * * * *
```

| 表达式 | 含义 |
| :--- | :--- |
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时整点 |
| `0 2 * * *` | 每天凌晨 2 点 |
| `0 0 1 * *` | 每月 1 号零点 |
| `0 9 * * 1-5` | 工作日早上 9 点 |

K8s 1.25+ 还支持**时区**配置：

```yaml
spec:
  timeZone: "Asia/Shanghai"    # 使用上海时区
  schedule: "0 2 * * *"        # 上海时间凌晨 2 点
```

### 3.3 并发策略

CronJob 的 `concurrencyPolicy` 定义了当上一个 Job 还在运行时，新的调度时间到来时的处理方式：

| 策略 | 行为 |
| :--- | :--- |
| **Allow**（默认）| 允许并发——即使上一个 Job 还在运行，也创建新 Job |
| **Forbid** | 跳过本次调度——如果上一个 Job 还在运行，不创建新 Job |
| **Replace** | 取消上一个 Job，创建新 Job |

```yaml
spec:
  concurrencyPolicy: Forbid    # 不允许并发
```

**Forbid** 适用于不能并发运行的任务（如数据库备份——两个备份同时运行可能导致数据不一致或资源争用）。

**Allow** 适用于每次执行完全独立且幂等的任务（如发送报表——两次发送不会互相影响）。

### 3.4 历史保留与清理

CronJob 每次调度创建一个 Job，长期运行后会积累大量 Job 和 Pod 对象。CronJob 通过两个参数控制保留策略：

```yaml
spec:
  successfulJobsHistoryLimit: 3    # 保留最近 3 个成功的 Job（默认 3）
  failedJobsHistoryLimit: 1        # 保留最近 1 个失败的 Job（默认 1）
```

超出限制的旧 Job（及其 Pod）会被自动删除。

**TTL-After-Finished Controller** 是另一个清理机制——在 Job 的 `spec.ttlSecondsAfterFinished` 中配置：

```yaml
spec:
  jobTemplate:
    spec:
      ttlSecondsAfterFinished: 3600    # Job 完成后 1 小时自动删除
```

### 3.5 错过调度的处理

如果 CronJob Controller 在应该调度的时间没有运行（如 Controller Manager 宕机或重启），错过的调度会在 Controller 恢复后被补偿——前提是错过的时间不超过 `startingDeadlineSeconds`（默认无限制）。

```yaml
spec:
  startingDeadlineSeconds: 200    # 如果错过调度超过 200 秒，放弃本次调度
```

如果 Controller 停机时间较长，累积了大量错过的调度（> 100 次），CronJob Controller 会记录一个错误事件并停止调度——需要手动介入。

> [!warning] CronJob 的时间精度
> CronJob 的调度精度不是精确到秒的——Controller 大约每 10 秒检查一次是否有到期的调度。因此 CronJob 的实际执行时间可能比配置的时间晚几秒到十几秒。对时间精度有严格要求的场景（如必须在 00:00:00 执行），CronJob 不是合适的方案——应使用应用内部的定时器。

---

## 第 4 章 三种控制器的对比

| 维度 | DaemonSet | Job | CronJob |
| :--- | :--- | :--- | :--- |
| **目标** | 每个节点运行 1 个 Pod | N 个 Pod 成功完成 | 周期性创建 Job |
| **Pod 生命周期** | 持续运行（与节点同生存） | 运行至完成后退出 | 由 Job 控制 |
| **副本数** | 由节点数决定 | 由 completions 决定 | 由 schedule 决定 |
| **失败处理** | 自动重建（与 Deployment 类似） | backoffLimit 控制重试 | 由 Job 的策略控制 |
| **更新策略** | RollingUpdate / OnDelete | 不支持（Job 不可变） | 修改 jobTemplate 影响未来的 Job |
| **典型场景** | 节点级基础设施 | 一次性批处理 | 周期性定时任务 |

---

## 第 5 章 生产实践

### 5.1 DaemonSet 的资源控制

DaemonSet 的 Pod 在每个节点上运行——如果不限制资源，可能影响节点上的业务 Pod。必须为 DaemonSet 的 Pod 设置合理的 `resources.requests` 和 `resources.limits`：

```yaml
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 200m
    memory: 256Mi
```

Scheduler 在计算节点可用资源时会扣除 DaemonSet Pod 的 requests——确保业务 Pod 不会因为 DaemonSet Pod 的资源占用而被驱逐。

### 5.2 Job 的幂等性设计

Job 的 Pod 可能因为各种原因被执行多次（节点故障后重建、backoffLimit 重试）。任务逻辑必须设计为幂等的——多次执行结果一致。

- **数据库迁移**：使用版本号控制——已执行过的迁移脚本不重复执行
- **文件处理**：使用"先写临时文件，最后原子重命名"模式——不会产生半成品
- **API 调用**：使用幂等键——重复调用返回相同结果

### 5.3 CronJob 的监控

CronJob 的常见问题是"静默失败"——调度正常但 Job 执行失败，如果没有告警，可能长时间无人发现。

关键监控指标：

```
# CronJob 最后一次成功执行的时间
kube_cronjob_status_last_successful_time

# CronJob 是否有活跃的 Job
kube_cronjob_status_active

# Job 的成功/失败数量
kube_job_status_succeeded / kube_job_status_failed
```

告警建议：如果 CronJob 的上次成功时间超过 2 个调度周期——说明连续两次调度失败或跳过，需要排查。

---

## 第 6 章 总结

本文分析了 K8s 三种特殊工作负载控制器：

- **DaemonSet**：确保每节点一个 Pod，K8s 1.12+ 通过 nodeAffinity 交由 Scheduler 调度，支持 RollingUpdate + maxSurge 零停机更新
- **Job**：一次性任务，三种并行模型（单 Pod、固定完成数、工作队列），backoffLimit 控制重试，Pod Failure Policy 区分可重试和不可重试错误，Indexed Job 支持数据分片
- **CronJob**：周期性创建 Job，concurrencyPolicy 控制并发（Allow/Forbid/Replace），startingDeadlineSeconds 控制错过调度的处理

下一篇 [[05 Scheduler 调度流程与算法]] 将深入 K8s 调度器——Pod 如何被分配到合适的节点。

---

## 参考资料

1. Kubernetes Documentation - DaemonSet：https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/
2. Kubernetes Documentation - Jobs：https://kubernetes.io/docs/concepts/workloads/controllers/job/
3. Kubernetes Documentation - CronJob：https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
4. Kubernetes Enhancement Proposal - Indexed Job：https://github.com/kubernetes/enhancements/tree/master/keps/sig-apps/2214-indexed-job
5. Kubernetes Enhancement Proposal - Pod Failure Policy：https://github.com/kubernetes/enhancements/tree/master/keps/sig-apps/3329-retriable-and-non-retriable-failures
6. Kubernetes Documentation - DaemonSet Update Strategy：https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/

---

> [!note] 思考题
> 1. StatefulSet 为每个 Pod 提供稳定的网络标识（`pod-0`、`pod-1`）和稳定的持久存储（PVC 与 Pod 一一对应）。有序部署（0→1→2）和有序终止（2→1→0）保证了有状态应用的一致性。但有序部署在 Pod 启动慢时导致部署时间长——`podManagementPolicy: Parallel` 可以并行启动，但什么场景下并行启动会导致问题（如主从数据库需要先启动主节点）？
> 2. StatefulSet 的 PVC 在 Pod 删除后不自动删除——需要手动清理。这是为了防止数据意外丢失。但在测试环境中，残留的 PVC 浪费存储资源。你如何自动化清理不再需要的 PVC？Kubernetes 1.27+ 的 `persistentVolumeClaimRetentionPolicy` 如何解决这个问题？
> 3. StatefulSet 的滚动更新默认从最高序号的 Pod 开始（2→1→0）。`partition` 参数允许只更新序号 ≥ partition 的 Pod——实现灰度更新。在一个 3 副本的 ZooKeeper StatefulSet 中，如何用 `partition` 先更新 1 个节点验证后再全量更新？
