---
title: "故障排查手册：从 Pod 状态到性能瓶颈的诊断链路"
date: 2026-02-28
tags: [Spark, Kubernetes, 故障排查, OOMKilled, Executor丢失, ImagePullBackOff, 性能, 诊断, 调试]
aliases: []
---

# 10 故障排查手册：从 Pod 状态到性能瓶颈的诊断链路

## 摘要

Spark on K8s 的故障排查比 YARN 模式更复杂：问题可能发生在 K8s 层（Pod 调度失败、镜像拉取失败、OOM Killer）或 Spark 层（Task 失败、Executor 丢失、Shuffle 错误），两层的诊断工具和方法完全不同。本文以"症状 → 诊断工具 → 根因分析 → 解决方案"的四步框架，系统讲解 Spark on K8s 最常见的七类生产故障：**OOMKilled**（内存配置与 K8s limits 不匹配）、**Executor 频繁丢失**（节点压力/网络/Spot 驱逐）、**ImagePullBackOff**（私有仓库认证失败或镜像不存在）、**Driver Pod Pending**（资源不足/亲和性不匹配）、**Shuffle 读取失败**（Executor 被删除后 Shuffle 数据消失）、**Spark UI 无法访问**（Service/Ingress 配置错误）、**性能劣化**（K8s 模式相比 YARN 的额外开销在哪里）。每个故障类型都给出可直接执行的 `kubectl` 诊断命令链，以及系统性的参数调优方案。

---

## 第 1 章 故障排查的基本工具链

### 1.1 Spark on K8s 诊断的双层视角

排查 Spark on K8s 问题时，必须同时从两个层面观察：

**K8s 层**（用 `kubectl` 工具）：

```bash
# 查看所有 Spark 相关 Pod 的状态
kubectl get pods -n spark-ns \
  -l spark-role \
  -o wide \
  --show-labels

# 查看 Pod 的详细事件（最常用的诊断命令）
kubectl describe pod <pod-name> -n spark-ns

# 查看 Pod 日志（当前运行 / 上次崩溃）
kubectl logs <pod-name> -n spark-ns
kubectl logs <pod-name> -n spark-ns --previous   # 上次崩溃的日志

# 查看 SparkApplication 的状态（使用 Spark Operator 时）
kubectl get sparkapplication -n spark-ns
kubectl describe sparkapplication <app-name> -n spark-ns

# 进入运行中的 Pod 调试（谨慎使用）
kubectl exec -it <executor-pod-name> -n spark-ns -- /bin/bash
```

**Spark 层**（用 Spark UI 和日志）：

```bash
# 通过 port-forward 访问 Spark UI
kubectl port-forward pod/<driver-pod-name> 4040:4040 -n spark-ns

# 查看 Driver 日志（最关键的 Spark 层日志）
kubectl logs <driver-pod-name> -n spark-ns | grep -E "ERROR|WARN|Exception"

# 查看 Executor 日志
kubectl logs <executor-pod-name> -n spark-ns | tail -100
```

### 1.2 诊断命令速查

```bash
# 查找所有失败的 Spark Pod
kubectl get pods -n spark-ns \
  --field-selector=status.phase=Failed \
  -l spark-role

# 查找 OOMKilled 的 Pod
kubectl get pods -n spark-ns -o json | \
  jq '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason=="OOMKilled") | .metadata.name'

# 查看节点资源使用情况
kubectl top nodes
kubectl top pods -n spark-ns --sort-by=memory

# 查看 ResourceQuota 使用情况
kubectl describe resourcequota -n spark-ns

# 查看 Pod 调度失败的详细原因
kubectl get events -n spark-ns \
  --field-selector=reason=FailedScheduling \
  --sort-by='.lastTimestamp' | tail -20
```

---

## 第 2 章 OOMKilled：最常见的生产故障

### 2.1 OOMKilled 的本质

**OOMKilled**（exit code=137）：Pod 容器的内存使用超过了 K8s 配置的 `resources.limits.memory`，K8s 的 OOM Killer（内核级）强制杀死该容器进程。

**与 Java OutOfMemoryError 的区别**：
- **Java OOM（`java.lang.OutOfMemoryError: Java heap space`）**：JVM Heap 超过 `-Xmx` 限制，JVM 主动抛出异常，Spark 捕获后 Task 失败重试，不一定杀死进程
- **K8s OOMKilled**：容器使用的**总内存**（JVM Heap + JVM 堆外 + OS 缓存 + 其他进程）超过 `limits.memory`，内核直接 SIGKILL 进程，进程无法捕获，Executor 立即消失

### 2.2 诊断步骤

```bash
# Step 1：确认是 OOMKilled
kubectl describe pod <executor-pod> -n spark-ns
# 查看 Events 部分：
# State:          Terminated
#   Reason:       OOMKilled
#   Exit Code:    137

# Step 2：查看 Pod 的内存 limits 设置
kubectl get pod <executor-pod> -n spark-ns -o jsonpath=\
'{.spec.containers[0].resources}'
# 输出示例：
# {"limits":{"memory":"8Gi"},"requests":{"memory":"8Gi"}}

# Step 3：查看 OOM 发生时的内存使用
kubectl top pod <executor-pod> -n spark-ns
# 如果 Pod 已经死亡，通过 metrics-server 历史或 Prometheus 查看

# Step 4：分析 Spark 的内存配置
# 检查 spark.executor.memory + spark.executor.memoryOverhead 是否与 limits.memory 匹配
```

### 2.3 OOMKilled 的根因分类与解决

**根因一：memoryOverhead 配置不足（最常见）**

```
配置：spark.executor.memory=8g, spark.executor.memoryOverhead=1g
K8s limits.memory = 9g（= 8 + 1）

实际运行时：
  JVM Heap：8g（受 -Xmx 控制，不超过）
  JVM 堆外（Direct Buffer、Unsafe）：500MB
  Python 进程（PySpark）：1GB（!!）← 超出预期
  OS Buffer Cache：300MB
  
  总计：≈ 9.8g > limits 9g → OOMKilled
```

**解决**：PySpark 作业必须将 `memoryOverhead` 设置得更大：

```
spark.executor.memory=8g
spark.executor.memoryOverhead=3g   # Python 进程额外 2g + 其他 1g
# K8s limits.memory = 8 + 3 = 11g
```

Spark 3.2+ 提供了 `spark.executor.pyspark.memory`（默认 0，表示不限制 Python 进程内存）：

```
spark.executor.pyspark.memory=2g   # 明确限制 Python 进程使用 2g
spark.executor.memoryOverhead=3g   # Overhead 包含 Python + JVM 堆外
```

**根因二：State Store 膨胀（Structured Streaming）**

State Store 数据存储在 Executor 的 JVM Heap 中（HDFS-backed State Store），State 越来越大 → JVM Heap 越来越接近 Xmx → GC 频繁 → 最终 OOM。

**解决**：
1. 切换 RocksDB State Store（State 存磁盘，不占 JVM Heap）
2. 确认 Watermark 配置正确，State 能及时清理

**根因三：数据倾斜导致单个 Task 数据量超大**

某个 Executor 上的 Task 处理了数 GB 的倾斜数据，JVM Heap 内同时保存了大量对象 → OOM。

**解决**：分析数据分布，处理 Key 倾斜（加盐/拆分）；开启 AQE Skew Join（`spark.sql.adaptive.skewJoin.enabled=true`）。

---

## 第 3 章 Executor 频繁丢失

### 3.1 症状识别

```
Driver 日志：
  WARN TaskSchedulerImpl: Lost executor 5 on 10.244.3.12: 
    Command exited with code 137  ← OOMKilled
    或 Executor heartbeat timed out after 120000ms ← 心跳超时
    或 ExecutorLostFailure (executor 5 exited caused by one of the running tasks) 

Spark UI：
  多个 Stage 显示"Failed Tasks"
  Executors 页面：频繁出现 Executor 被移除的记录
```

### 3.2 根因定位流程

```bash
# Step 1：查看 Executor Pod 的退出状态
kubectl get pods -n spark-ns -l spark-role=executor \
  -o custom-columns="NAME:.metadata.name,STATUS:.status.phase,\
REASON:.status.containerStatuses[0].lastState.terminated.reason,\
EXIT:.status.containerStatuses[0].lastState.terminated.exitCode"

# 典型输出：
# NAME                    STATUS    REASON      EXIT
# my-app-exec-1-xxx       Failed    OOMKilled   137    ← 内存问题
# my-app-exec-2-xxx       Failed    Error       1      ← 程序错误
# my-app-exec-3-xxx       Failed    Error       143    ← SIGTERM（被驱逐）

# Step 2：查看节点压力（内存/磁盘不足可能导致 Pod 被驱逐）
kubectl describe node <node-name> | grep -A 5 "Conditions:"
# 关注：MemoryPressure, DiskPressure, PIDPressure

# Step 3：查看 Pod 的 Events（驱逐原因）
kubectl describe pod <executor-pod> -n spark-ns | grep -A 10 "Events:"
# 驱逐事件示例：
# Evicted: The node was low on resource: memory. 
#   Threshold quantity: 100Mi, available: 45Mi.
```

### 3.3 常见根因与解决

| 退出码 | 含义 | 解决方向 |
|------|-----|---------|
| 137 | OOMKilled（超 limits）| 增大 `memoryOverhead`；切 RocksDB State |
| 143 | SIGTERM（被驱逐或主动终止）| 检查节点 MemoryPressure；检查 Spot 驱逐 |
| 1 | 程序错误（Java 异常）| 查 Executor 日志找异常栈 |
| 心跳超时 | 网络故障或 GC 停顿过长 | 检查网络；增大 `network.timeout`；减少 GC 停顿 |

**GC 停顿导致心跳超时的特殊情况**：如果 Executor 发生长达数秒的 Full GC，期间无法发送心跳，Driver 可能误判为 Executor 丢失。解决方案：

```
# 增大心跳超时时间（允许更长的 GC 停顿）
spark.network.timeout=300s          # 默认 120s，增大到 5 分钟
spark.executor.heartbeatInterval=20s # 默认 10s

# 减少 GC 停顿：使用 G1GC 并调优
spark.executor.extraJavaOptions=-XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -XX:G1HeapRegionSize=8m
```

---

## 第 4 章 ImagePullBackOff：镜像拉取失败

### 4.1 诊断步骤

```bash
# Step 1：确认 Pod 处于 ImagePullBackOff 状态
kubectl get pods -n spark-ns | grep -E "ImagePullBackOff|ErrImagePull"

# Step 2：查看详细错误信息
kubectl describe pod <pod-name> -n spark-ns
# 在 Events 部分查找：
# Failed to pull image "my-registry/spark:3.3.2": 
#   rpc error: code = Unknown desc = failed to pull and unpack image:
#   failed to resolve reference "my-registry/spark:3.3.2": 
#   unexpected status code 401 Unauthorized   ← 认证失败
#   或 not found                               ← 镜像/Tag 不存在

# Step 3：验证 imagePullSecret 是否存在
kubectl get secret registry-secret -n spark-ns
kubectl get secret registry-secret -n spark-ns -o jsonpath=\
'{.data.\.dockerconfigjson}' | base64 -d | jq .
# 确认包含正确的仓库地址和凭证
```

### 4.2 常见根因

**根因一：Secret 在错误的 Namespace**

imagePullSecret 必须在 Pod 所在的 Namespace 中：

```bash
# 将 registry-secret 从 default 命名空间复制到 spark-ns
kubectl get secret registry-secret -o yaml | \
  sed 's/namespace: default/namespace: spark-ns/' | \
  kubectl apply -f -
```

**根因二：镜像 Tag 不存在**

使用 `latest` Tag 时，镜像仓库中不一定有这个 Tag（特别是私有仓库刚推送的镜像）：

```bash
# 验证镜像是否存在
docker manifest inspect my-registry/spark-app:3.3.2
```

**根因三：节点无法访问私有仓库**

K8s 节点（运行 kubelet）需要能够访问私有镜像仓库的域名/IP。如果节点在私有网络中，需要确保网络连通性：

```bash
# 在节点上测试镜像仓库连通性
curl -v https://my-registry.example.com/v2/
```

---

## 第 5 章 Driver Pod Pending

### 5.1 诊断步骤

```bash
# Step 1：查看 Pod 的调度失败事件
kubectl describe pod <driver-pod> -n spark-ns | grep -A 20 "Events:"

# 常见输出：
# 0/15 nodes are available: 
#   3 Insufficient cpu,           ← 部分节点 CPU 不足
#   5 node(s) had taint {key:value}, that the pod didn't tolerate,  ← Taint 不匹配
#   7 Insufficient memory         ← 部分节点内存不足

# Step 2：检查 ResourceQuota 是否已满
kubectl describe resourcequota -n spark-ns
# 查看 Used 和 Hard 的差值，是否已接近上限
```

### 5.2 常见根因与解决

| 事件信息 | 根因 | 解决方案 |
|--------|-----|---------|
| `Insufficient cpu/memory` | 节点资源不足或 ResourceQuota 满 | 等待其他 Pod 完成；扩容节点；调小 Driver 资源请求 |
| `had taint ... didn't tolerate` | Driver Pod 没有对应 Taint 的 Toleration | 添加 Toleration 或使用没有该 Taint 的节点 |
| `didn't match node affinity` | Node Affinity 在集群中没有匹配节点 | 检查 nodeSelector/affinity 标签是否正确 |
| `exceeded quota` | ResourceQuota 已用满 | 等待其他作业完成；申请增加 Quota |
| `0/N nodes are available: N Unschedulable` | 节点全部 Unschedulable（维护/Drain 状态）| `kubectl get nodes` 检查节点状态 |

---

## 第 6 章 Shuffle 读取失败

### 6.1 症状

```
Driver 日志 / Spark UI：
  Stage 失败，Task 失败日志：
  org.apache.spark.shuffle.FetchFailedException: 
    Failed to connect to executor 5 (10.244.3.12:7337)
  或：
  java.io.IOException: Failed to read shuffle block
```

### 6.2 根因与解决

**Executor Pod 被删除导致 Shuffle 数据消失**（最常见）：

```bash
# 检查对应 Executor Pod 是否还在
kubectl get pod -n spark-ns -l spark-executor-id=5
# 如果 Pod 已经是 Succeeded/Failed/不存在，则 Shuffle 数据已丢失
```

解决方向（按优先级）：
1. **启用 Shuffle Tracking**：`spark.dynamicAllocation.shuffleTracking.enabled=true`，确保有未读 Shuffle 数据的 Executor 不被提前释放
2. **部署 Remote Shuffle Service**（Apache Uniffle）：彻底解耦 Shuffle 数据与 Executor 生命周期
3. **关闭 DRA**（临时方案）：固定 Executor 数量，不主动释放 Executor

---

## 第 7 章 Spark on K8s vs YARN 的性能对比

### 7.1 K8s 模式的额外开销分析

K8s 模式相比 YARN 模式，在以下环节有额外开销：

| 开销来源 | 量化估计 | 说明 |
|--------|---------|-----|
| Executor Pod 启动时间 | +10-60 秒/Executor | 镜像拉取（IfNotPresent 命中缓存可 <1s）+ 容器初始化 |
| K8s API 调用延迟 | +50-200ms/批次 | Watch API 的事件延迟、etcd 写入延迟 |
| 无数据本地性调度 | 视场景 +5-30% | HDFS 数据需要跨节点网络读取（对象存储场景无影响）|
| Pod 网络 CNI 开销 | +1-5% 带宽 | Calico/Flannel 等 CNI 的 overlay 网络封包开销 |
| 无 Gang Scheduling（默认）| 导致资源浪费 | 部分 Executor Pending 时其他 Executor 空等 |

**实测经验**：在使用对象存储（S3/OSS，无 HDFS 本地性问题）、镜像全部缓存（IfNotPresent）、开启 Gang Scheduling（Volcano）的条件下，Spark on K8s 的作业执行时间与 YARN 模式相差 **< 5%**，差距主要来自 Executor 启动时间（K8s 容器初始化比 YARN Container 慢约 2-5 秒）。

### 7.2 K8s 模式的优势

相比 YARN，K8s 模式有以下工程优势（弥补了性能差距）：

- **统一运维**：Spark 作业与微服务使用同一套 K8s 工具链（kubectl、Helm、Argo CD），降低运维工具复杂度
- **细粒度资源隔离**：cgroup V2 实现 CPU/Memory 的精确隔离，Spark 作业之间不互相干扰
- **云原生弹性**：与 K8s Cluster Autoscaler 无缝集成，真正按需扩缩容（YARN 扩容需要运维介入）
- **多语言/多框架共存**：同一个 K8s 集群可以同时运行 Spark、TensorFlow、PyTorch、微服务

---

## 第 8 章 故障排查快速参考卡

```
故障现象                  → 第一诊断命令                    → 最常见根因
─────────────────────────────────────────────────────────────────────
OOMKilled (137)          → kubectl describe pod             → memoryOverhead 不足
Executor 心跳超时        → kubectl logs driver              → GC 停顿 / 网络故障
ImagePullBackOff         → kubectl describe pod Events      → Secret 配置错误 / Tag 不存在
Driver Pod Pending       → kubectl describe pod Events      → 资源不足 / Taint 不匹配
Shuffle FetchFailed      → kubectl get pod -l exec-id=N     → Executor Pod 已被删除
Spark UI 无法访问        → kubectl get svc,ingress          → Service selector 错误 / Ingress 路径
作业比 YARN 慢很多       → Spark UI → Executors 页面       → 镜像未缓存 / 无 Gang Scheduling
State Store OOM          → kubectl logs driver + 关键字state → 无 Watermark / State 无限增长
```

---

## 小结

专栏二「Spark on Kubernetes 工程实践」至此全部完成。10 篇文章构建了完整的 Spark on K8s 工程体系：

- **架构对比**（01）：K8s Pod 模型 vs YARN Container，调度器差异，Client/Cluster 模式
- **镜像构建**（02）：三层分层设计，JAR 分拆缓存，Python 依赖管理策略
- **RBAC 与配额**（03）：最小权限 ServiceAccount，ResourceQuota 防止资源耗尽，LimitRange 防止滥用
- **Pod 生命周期**（04）：Driver/Executor 状态机，DRA + Shuffle Tracking，心跳超时处理，PriorityClass
- **Spark UI 访问**（05）：port-forward/NodePort/Ingress 三方案，History Server 持久化到对象存储
- **存储与 Shuffle**（06）：emptyDir/HostPath/PVC 对比，Apache Uniffle RSS 解耦 Shuffle 与 Pod
- **Spark Operator**（07）：SparkApplication CRD，Reconcile Loop，Argo Workflow DAG 编排，GitOps
- **资源优化**（08）：Spot 实例策略，Volcano/Yunikorn Gang Scheduling，容量规划公式
- **安全加固**（09）：Secrets 注入，IRSA，Kerberos keytab，NetworkPolicy，镜像签名
- **故障排查**（10）：OOMKilled/Executor丢失/ImagePullBackOff/Pending 的诊断链路，K8s vs YARN 性能对比

---

> [!note] 思考题
> 1. `OOMKilled` 是 Spark on K8s 最常见的故障，根因可能来自 JVM 堆内存（`-Xmx` 设置不足）、堆外内存（Tungsten/Direct Buffer）、或者 K8s Container 的 `memory.limit` 设置过低。这三类 OOM 在 `kubectl describe pod` 的输出中有什么不同的表现？如何通过 JVM GC 日志区分"真正的内存不足"和"GC 压力导致的假 OOM"？
> 2. 在 K8s 上，`kubectl logs` 只能获取容器当前或最近一次运行的日志。如果 Executor Pod 已经被 K8s 删除（`deleteOnTermination=true`），日志就永久丢失了。在设计生产监控体系时，如何在不修改 Spark 代码的前提下，确保所有 Executor 的日志都能被持久化到外部日志系统（如 ELK/Loki）？
> 3. 网络性能问题在 K8s 上比在 YARN 上更难诊断——Pod 之间的通信经过 CNI 插件（如 Calico、Cilium）的虚拟网络，可能存在额外的封包开销（如 VXLAN 隧道）。Shuffle 密集型的 Spark 作业在使用不同 CNI 插件时，网络性能差异可能达到 30% 以上。如何通过 Spark UI 的 Shuffle 读写时间指标，判断网络瓶颈是否是性能问题的主因？

## 参考资料

- Apache Spark 官方文档：Kubernetes Troubleshooting
- Kubernetes 官方文档：Debugging Pods
- [kubectl Cheat Sheet（Kubernetes 官方）](https://kubernetes.io/docs/reference/kubectl/cheatsheet/)
- [Debugging Kubernetes Memory Issues（Datadog Blog）](https://www.datadoghq.com/blog/debugging-kubernetes-oom-kills/)
