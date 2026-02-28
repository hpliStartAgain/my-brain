---
title: "Spark Operator：声明式作业管理与 CI/CD 集成"
date: 2026-02-28
tags: [Spark, Kubernetes, Spark Operator, CRD, SparkApplication, Argo Workflow, CI/CD, 声明式, 作业编排]
aliases: []
---

# 07 Spark Operator：声明式作业管理与 CI/CD 集成

## 摘要

直接使用 `spark-submit` 向 K8s 提交作业，面临的问题是**作业管理的碎片化**：每次提交都是命令式操作（执行一条命令），Driver/Executor Pod 的生命周期需要手动监控，失败重试需要外部脚本处理，没有统一的作业状态视图。**Spark Operator**（Google 开源，社区最活跃的版本是 kubeflow/spark-operator）将 Spark 作业封装为 Kubernetes 原生的自定义资源（Custom Resource Definition，CRD）`SparkApplication`，将"提交 Spark 作业"变成"声明一个 K8s 资源"——与部署一个 Deployment 的体验完全一致。Operator 本身是一个持续运行的控制器（Controller），它 Watch `SparkApplication` 资源的变化，负责创建 Driver Pod、监控作业状态、处理失败重试、清理历史 Pod，以及将作业状态同步回 CRD。本文深度讲解 `SparkApplication` CRD 的关键字段与配置、Operator 的控制循环机制（Reconcile Loop）、重试策略（`restartPolicy`）与作业状态机、以及将 Spark 作业集成到 Argo Workflow 实现 DAG 依赖编排的最佳实践。

---

## 第 1 章 为什么需要 Spark Operator

### 1.1 spark-submit 的管理局限

`spark-submit` 是一个无状态的命令行工具，每次执行后它本身就退出了（Cluster 模式）。这带来了以下管理挑战：

**问题一：无作业状态视图**。如何知道"现在有哪些 Spark 作业在运行，各自的状态如何"？只能通过 `kubectl get pods` 过滤 `spark-role=driver` 的 Pod，拼凑出一个不完整的视图。

**问题二：失败重试需要外部脚本**。作业失败后，重试逻辑需要用 Shell 脚本或 Airflow 任务实现，逻辑分散在多处，不统一。

**问题三：历史 Pod 积累**。每次 `spark-submit` 创建的 Driver/Executor Pod 在完成后依然存在（`Succeeded` 状态），需要手动或额外的 CronJob 清理，否则 etcd 中积累大量僵尸对象。

**问题四：GitOps 不兼容**。GitOps 要求"集群状态通过 Git 仓库中的声明式配置驱动"，但 `spark-submit` 是命令式的，无法被 Argo CD 或 Flux 这类 GitOps 工具管理。

**Spark Operator 解决的核心问题**：将 Spark 作业声明式化，使其与 K8s 的其他工作负载（Deployment、StatefulSet）在管理体验上完全一致。

---

## 第 2 章 SparkApplication CRD：声明式描述 Spark 作业

### 2.1 SparkApplication 的基本结构

```yaml
# 一个完整的 SparkApplication 资源示例
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: payment-etl-daily        # 作业名称（K8s 资源名）
  namespace: spark-production
  labels:
    team: data-engineering
    environment: production
spec:
  # === 基础配置 ===
  type: Scala                    # 作业类型：Scala / Java / Python / R
  mode: cluster                  # 部署模式：cluster（生产）/ client（调试）
  image: my-registry/spark/spark-app:2.1.0
  imagePullPolicy: IfNotPresent
  mainClass: com.example.PaymentETL
  mainApplicationFile: local:///opt/spark/jars/payment-etl.jar
  arguments:
    - "--date"
    - "2026-02-28"
    - "--output"
    - "s3a://bucket/output/payments/"

  # === Spark 版本 ===
  sparkVersion: "3.3.2"

  # === 重启策略（关键！）===
  restartPolicy:
    type: OnFailure              # OnFailure / Never / Always
    onFailureRetries: 3          # 失败后最多重试 3 次
    onFailureRetryInterval: 10   # 重试间隔 10 秒
    onSubmissionFailureRetries: 5
    onSubmissionFailureRetryInterval: 20

  # === Driver 配置 ===
  driver:
    cores: 2
    memory: "4g"
    serviceAccount: spark-driver-sa
    labels:
      version: "2.1.0"
      component: driver
    annotations:
      prometheus.io/scrape: "true"
      prometheus.io/port: "4040"
    envVars:
      - name: JAVA_OPTS
        value: "-XX:+UseG1GC -XX:MaxGCPauseMillis=200"
    volumeMounts:
      - name: hadoop-conf
        mountPath: /opt/spark/conf/hadoop

  # === Executor 配置 ===
  executor:
    cores: 4
    instances: 10                # 静态：10 个 Executor
    memory: "8g"
    memoryOverhead: "2g"
    labels:
      version: "2.1.0"
      component: executor

  # === Volumes ===
  volumes:
    - name: hadoop-conf
      configMap:
        name: hadoop-conf

  # === Spark 配置（等价于 spark-submit --conf）===
  sparkConf:
    spark.sql.shuffle.partitions: "500"
    spark.sql.adaptive.enabled: "true"
    spark.eventLog.enabled: "true"
    spark.eventLog.dir: "s3a://bucket/spark-event-logs/"
    spark.kubernetes.driver.podTemplateFile: ""  # 可指定 Pod Template

  # === Hadoop 配置 ===
  hadoopConf:
    fs.s3a.endpoint: "s3.amazonaws.com"
    fs.s3a.aws.credentials.provider: "com.amazonaws.auth.WebIdentityTokenCredentialsProvider"

  # === 动态资源分配 ===
  dynamicAllocation:
    enabled: true
    initialExecutors: 5
    minExecutors: 2
    maxExecutors: 50

  # === Spark UI 配置 ===
  monitoring:
    exposeDriverMetrics: true
    exposeExecutorMetrics: true
    prometheus:
      jmxExporterJar: /opt/jmx_prometheus_javaagent.jar
      port: 8090
```

### 2.2 restartPolicy 的深度解析

`restartPolicy` 是 Spark Operator 与直接 `spark-submit` 最大的差异之一——Operator 内建了完整的重试状态机：

| `type` 值 | 含义 | 适用场景 |
|---------|-----|---------|
| `Never` | 失败后不重试，作业直接标记为 Failed | 调试，或由外部（Airflow）管理重试 |
| `OnFailure` | Driver 或 Executor 失败后重试，最多 `onFailureRetries` 次 | **生产 ETL 作业**（网络抖动、节点故障等偶发失败）|
| `Always` | 作业完成后（成功或失败）都重启，持续运行 | 类流处理场景（但不如 Structured Streaming 原生）|

**重试的工作机制**：

```
SparkApplication 状态机：
  Pending → Running → Completed（成功）
                    ↓ 失败
                  Failed → （如果 retries > 0）→ Pending（重新提交）
                         → （retries 耗尽）→ Failed（最终失败）
```

每次重试时，Operator 删除旧的 Driver Pod（如果还存在），创建新的 Driver Pod，`batchId` 计数器递增。

---

## 第 3 章 Operator 的控制循环机制

### 3.1 Reconcile Loop：K8s 控制器的核心模式

[[Kubernetes Controller]] 的核心编程模型是 **Reconcile Loop（调谐循环）**：

```
期望状态（Desired State）：SparkApplication CRD 中声明的配置
当前状态（Actual State）：K8s 集群中实际运行的 Pod、Service 等资源

Reconcile 函数：
  1. 读取 SparkApplication 的 spec（期望状态）
  2. 读取当前集群中的实际状态（Driver Pod 是否存在？状态如何？）
  3. 计算差异（Diff）
  4. 执行操作使实际状态趋向期望状态（创建/删除/更新 Pod）
  5. 更新 SparkApplication 的 status（记录当前状态）
```

**Spark Operator 的 Reconcile 触发时机**：

- SparkApplication 资源创建（`kubectl apply -f spark-app.yaml`）
- SparkApplication 资源更新（修改配置后重新 apply）
- Driver/Executor Pod 状态变化（kubelet 报告 Pod 状态更新）
- 定时重新同步（定期 re-sync，默认 30 秒，确保状态收敛）

### 3.2 Operator 的核心操作

**提交新作业**（SparkApplication 首次创建或重试）：

```
Reconcile → 检测到 SparkApplication 状态为 Pending/New
  → 创建 Driver Pod（POST /api/v1/namespaces/ns/pods）
  → 更新 SparkApplication.status.applicationState.state = Submitted
```

**监控运行中作业**：

```
Driver Pod 状态变化事件 → Reconcile 触发
  → 查询 Driver Pod 状态
    Running → SparkApplication.status.state = Running
    Succeeded → SparkApplication.status.state = Completed; 清理 Executor Pod
    Failed → 判断是否还有重试次数
      有 → SparkApplication.status.state = Pending; 清理旧 Pod; 等待重试间隔
      无 → SparkApplication.status.state = Failed
```

**清理完成的作业**（可选 TTL）：

```yaml
# SparkApplication 中配置 TTL（完成后 N 秒自动删除资源）
spec:
  timeToLiveSeconds: 86400   # 作业完成后 24 小时自动删除 SparkApplication 资源
                              # 同时删除关联的 Driver/Executor Pod
```

---

## 第 4 章 与 Argo Workflow 集成：DAG 作业编排

### 4.1 为什么需要 Argo Workflow

生产中的数据管道通常不是单个 Spark 作业，而是多个作业之间有 **DAG 依赖关系**：

```
Job A（原始数据清洗）
  ↓ 完成后才能运行
Job B（维度表更新）  Job C（事实表计算，依赖 Job A 和 B）
  ↓                        ↓
  └──────→ Job D（最终汇总报表，依赖 B 和 C）
```

Spark Operator 只管理单个 `SparkApplication`，不管理作业间的依赖关系。**Argo Workflow** 是 K8s 原生的 DAG 工作流引擎，它可以：
- 描述多个步骤（Step）之间的依赖关系（DAG）
- 每个步骤可以是任意 K8s 操作（创建资源、执行容器、调用 API）
- 自然地与 Spark Operator 集成：Argo 的一个 Step 就是创建一个 SparkApplication 资源，等待其完成

### 4.2 Argo Workflow 调度 Spark 作业的模式

**模式一：Resource 步骤（推荐）**

Argo Workflow 提供 `resource` 类型的步骤，可以直接创建 K8s 资源并等待其特定状态：

```yaml
# Argo Workflow DAG 示例
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: etl-pipeline-daily
  namespace: spark-production
spec:
  entrypoint: etl-dag
  arguments:
    parameters:
      - name: date
        value: "2026-02-28"

  templates:
    # DAG 定义
    - name: etl-dag
      dag:
        tasks:
          - name: raw-data-cleaning
            template: submit-spark-job
            arguments:
              parameters:
                - name: app-name
                  value: "raw-cleaning-{{workflow.parameters.date}}"
                - name: main-class
                  value: "com.example.RawCleaning"
                - name: args
                  value: "[\"--date\", \"{{workflow.parameters.date}}\"]"

          - name: dim-update
            template: submit-spark-job
            arguments:
              parameters:
                - name: app-name
                  value: "dim-update-{{workflow.parameters.date}}"
                - name: main-class
                  value: "com.example.DimUpdate"
                - name: args
                  value: "[\"--date\", \"{{workflow.parameters.date}}\"]"

          - name: fact-calculation
            dependencies: [raw-data-cleaning, dim-update]   # 依赖前两个任务
            template: submit-spark-job
            arguments:
              parameters:
                - name: app-name
                  value: "fact-calc-{{workflow.parameters.date}}"
                - name: main-class
                  value: "com.example.FactCalculation"
                - name: args
                  value: "[\"--date\", \"{{workflow.parameters.date}}\"]"

          - name: summary-report
            dependencies: [fact-calculation, dim-update]
            template: submit-spark-job
            arguments:
              parameters:
                - name: app-name
                  value: "summary-{{workflow.parameters.date}}"
                - name: main-class
                  value: "com.example.SummaryReport"
                - name: args
                  value: "[\"--date\", \"{{workflow.parameters.date}}\"]"

    # SparkApplication 提交模板
    - name: submit-spark-job
      inputs:
        parameters:
          - name: app-name
          - name: main-class
          - name: args
      resource:
        action: create        # 创建 K8s 资源
        successCondition: status.applicationState.state == COMPLETED   # 成功条件
        failureCondition: status.applicationState.state == FAILED      # 失败条件
        manifest: |
          apiVersion: sparkoperator.k8s.io/v1beta2
          kind: SparkApplication
          metadata:
            name: "{{inputs.parameters.app-name}}"
            namespace: spark-production
          spec:
            type: Scala
            mode: cluster
            image: my-registry/spark/spark-app:2.1.0
            mainClass: "{{inputs.parameters.main-class}}"
            mainApplicationFile: local:///opt/spark/jars/etl.jar
            arguments: {{inputs.parameters.args}}
            sparkVersion: "3.3.2"
            restartPolicy:
              type: OnFailure
              onFailureRetries: 2
              onFailureRetryInterval: 30
            driver:
              cores: 2
              memory: "4g"
              serviceAccount: spark-driver-sa
            executor:
              cores: 4
              memory: "8g"
              instances: 10
            sparkConf:
              spark.eventLog.enabled: "true"
              spark.eventLog.dir: "s3a://bucket/spark-event-logs/"
            timeToLiveSeconds: 86400
```

**工作机制**：

1. Argo Workflow 根据 DAG 依赖关系，确定哪些任务可以并行运行
2. 对每个可运行的任务，Argo 执行 `kubectl apply` 创建 SparkApplication 资源
3. Argo Watch `SparkApplication.status.applicationState.state`，等待变为 `COMPLETED`
4. 一旦前置任务完成，Argo 立即提交依赖任务
5. 任何任务失败（达到最大重试次数后仍 FAILED），Workflow 标记为失败

> [!note] 设计哲学
> Argo Workflow + Spark Operator 的组合完美体现了 K8s 的"组合式"设计哲学：Spark Operator 负责单个 Spark 作业的声明式管理，Argo 负责多作业的 DAG 编排。每个工具只做好自己最擅长的事，通过 K8s CRD 作为接口组合在一起，整体功能远超两者之和。相比 Airflow（在 K8s 外部管理 K8s 内部的作业），Argo 原生运行在 K8s 内，资源消耗更低，与 K8s RBAC、Namespace 隔离等机制更自然地集成。

---

## 第 5 章 CI/CD 集成：GitOps 驱动的 Spark 部署

### 5.1 GitOps 模式下的 Spark 作业管理

**GitOps** 的核心思想：Git 仓库是集群状态的唯一真实来源（Source of Truth），集群状态的所有变更都通过 Git 提交（PR + Merge）触发，由 GitOps 工具（Argo CD / Flux）自动同步到集群。

Spark Operator 使 GitOps 管理 Spark 作业成为可能：

```
Git 仓库结构：
spark-jobs/
  production/
    payment-etl.yaml          # SparkApplication 资源
    user-behavior-analysis.yaml
  staging/
    payment-etl.yaml
  
当开发者修改 payment-etl.yaml 并合并到 main 分支：
  Argo CD 检测到 Git 变化
  Argo CD 将新版 payment-etl.yaml apply 到 K8s
  Spark Operator 检测到 SparkApplication 变化
  Operator 用新配置重新提交作业（如果作业正在运行则先停止）
```

### 5.2 镜像版本与作业配置的 CI/CD 流水线

```
代码提交（Git Push）
  ↓
CI（GitHub Actions / Jenkins）：
  1. 单元测试
  2. 构建 JAR（mvn package）
  3. 构建 Docker 镜像（docker build）
  4. 推送镜像（docker push my-registry/spark-app:${GIT_COMMIT_SHA}）
  5. 更新 SparkApplication yaml 中的镜像 Tag：
     sed -i "s|image:.*|image: my-registry/spark-app:${GIT_COMMIT_SHA}|" k8s/payment-etl.yaml
  6. 提交到 GitOps 仓库（git commit + git push）
  ↓
Argo CD 检测到 GitOps 仓库变化
  → 将新 SparkApplication yaml apply 到 staging 环境
  → 自动触发 staging 集成测试
  ↓
手动 Approve（或自动）→ Promote 到 production
  → Argo CD 将新版 SparkApplication apply 到 production 集群
```

---

## 小结

Spark Operator 将 Spark 作业管理从"命令式脚本"升级为"声明式资源"：

- **SparkApplication CRD**：完整描述作业的 Driver/Executor 配置、重启策略、Spark 参数；与普通 K8s 资源完全一致的管理体验
- **Reconcile Loop**：Operator 持续监控作业状态，自动处理 Pod 创建、状态同步、失败重试、历史清理
- **restartPolicy**：内建三级重试策略（Never/OnFailure/Always），替代外部脚本的重试逻辑
- **Argo Workflow 集成**：`resource` 类型步骤直接管理 SparkApplication；DAG 依赖关系自然地在 Argo 中描述；Argo Watch CRD 状态完成依赖协调
- **GitOps 兼容**：SparkApplication YAML 提交到 Git，Argo CD 自动同步，实现 Spark 作业的版本化、可审计、可回滚部署

第 08 篇讲解资源优化策略：Spot 实例的使用风险与缓解方案、Volcano 和 Yunikorn 的 Gang Scheduling 原理（确保所有 Executor 同时调度）、以及集群资源利用率分析工具。

---

## 参考资料

- [kubeflow/spark-operator GitHub](https://github.com/kubeflow/spark-operator)
- Spark Operator 官方文档：SparkApplication CRD Reference
- [Argo Workflows 官方文档](https://argoproj.github.io/argo-workflows/)
- [GitOps with Argo CD and Spark Operator（KubeCon Talk 2022）](https://www.youtube.com/watch?v=...)
