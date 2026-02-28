---
title: "Spark UI 访问：Ingress、NodePort 与 History Server 部署"
date: 2026-02-28
tags: [Spark, Kubernetes, Spark UI, Ingress, NodePort, History Server, 可观测性, 网络, EventLog]
aliases: []
---

# 05 Spark UI 访问：Ingress、NodePort 与 History Server 部署

## 摘要

Spark UI 是诊断作业性能问题的核心工具，但在 Kubernetes 上访问 Spark UI 的难度远高于 YARN 模式——YARN 集群的 ResourceManager UI 固定在一个地址，而 Spark on K8s 的每个 Driver Pod 都有动态分配的 IP（Pod IP），且仅在 K8s 集群内部网络可达，外部用户无法直接访问。本文系统讲解三种将 Spark UI 暴露给外部用户的方案：**NodePort Service**（最简单，但端口管理混乱）、**Ingress**（生产推荐，路径路由，基于 HTTP 代理）、**`kubectl port-forward`**（调试专用，无需额外配置），并深度解析 **History Server** 在 K8s 上的部署模式——通过将 EventLog 持久化到对象存储（S3/HDFS），History Server 可以在作业完成（Driver Pod 删除）后提供历史作业的 Spark UI 访问，解决"Pod 删了就看不到 UI"的根本问题。

---

## 第 1 章 为什么 Spark UI 在 K8s 上难以访问

### 1.1 YARN 模式 vs K8s 模式的 UI 访问对比

**YARN 模式**：

Spark UI 运行在 Driver（ApplicationMaster）进程中，端口默认 4040。YARN ResourceManager 维护了所有运行中作业的 AM 地址，用户可以通过 RM UI（固定地址，如 `http://rm-host:8088`）点击作业链接，跳转到对应的 Spark UI。

**K8s 模式**：

Driver Pod 的 IP 是 K8s CNI（网络插件）动态分配的 Pod IP（如 `10.244.3.15`），这个 IP：
1. 只在 K8s 集群内部网络可达（Pod 网络）
2. 每次重新创建 Driver Pod，IP 都会变化
3. 外部用户（开发者的笔记本、监控系统）无法直接访问

因此，访问 Spark UI 需要额外的网络暴露机制。

---

## 第 2 章 方案一：kubectl port-forward（调试专用）

### 2.1 port-forward 的原理与使用

`kubectl port-forward` 通过 K8s API Server 建立一条从本地端口到 Pod 端口的 TCP 隧道，不需要任何额外配置：

```bash
# 找到 Driver Pod 名称
kubectl get pods -n spark-ns -l spark-role=driver

# 将本地 4040 端口转发到 Driver Pod 的 4040 端口
kubectl port-forward \
  pod/my-app-driver-<random> \
  4040:4040 \
  -n spark-ns

# 然后在浏览器访问 http://localhost:4040
```

**优点**：
- 零配置，立即可用
- 不需要修改任何 K8s 资源（无需 Service、Ingress）
- 连接安全（通过 K8s API Server 的认证通道）

**缺点**：
- 只能一个用户同时访问（本地端口独占）
- Driver Pod 名称每次不同，需要手动查找
- 连接不稳定（网络波动时 `port-forward` 可能断开，需要重新执行）
- **不适合多用户场景或监控系统接入**

**结论**：仅适合开发调试时临时查看某个作业的 UI，不适合生产环境。

---

## 第 3 章 方案二：NodePort Service

### 3.1 NodePort 的原理

**NodePort Service** 在每个 K8s 节点上开放一个固定端口（30000-32767 范围），将外部流量路由到 Service 后面的 Pod。

```yaml
# 为 Driver Pod 创建 NodePort Service
apiVersion: v1
kind: Service
metadata:
  name: spark-ui-my-app
  namespace: spark-ns
spec:
  type: NodePort
  selector:
    spark-app-selector: "spark-<appId>"    # 选中对应的 Driver Pod
    spark-role: driver
  ports:
    - port: 4040          # Service 内部端口
      targetPort: 4040    # Driver Pod 的端口
      nodePort: 31040     # 节点上开放的端口（外部访问）
```

外部访问：`http://<any-node-ip>:31040`

**Spark 自动创建 Service 的配置**：

Spark 可以自动为 Driver 创建 Service，无需手动创建：

```
spark.kubernetes.driver.service.enabled=true
spark.ui.port=4040
```

### 3.2 NodePort 的问题

**问题一：端口冲突**

NodePort 范围是 30000-32767，共 2767 个端口。如果集群同时运行数百个 Spark 作业，每个 Driver 都要占用一个 NodePort，端口很快耗尽。

**问题二：节点 IP 不稳定**

使用哪个节点的 IP 访问？任意节点都可以（K8s 会做 iptables DNAT），但节点 IP 可能因故障切换而变化，不适合固定配置到监控系统。

**问题三：防火墙**

企业网络通常只开放 80/443 端口，30000+ 的 NodePort 端口可能被防火墙拦截。

**结论**：NodePort 适合小规模或测试环境，生产中应使用 Ingress。

---

## 第 4 章 方案三：Ingress（生产推荐）

### 4.1 Ingress 的工作原理

**[[Kubernetes Ingress]]** 是 K8s 的 HTTP/HTTPS 流量路由层：外部 HTTP 请求到达 Ingress Controller（通常是 nginx 或 Traefik），Controller 根据 Ingress 规则（域名 + 路径）将请求路由到对应的 Service，Service 再转发到 Pod。

```
外部用户
  → http://spark-ui.company.com/spark/<appId>/
  → Ingress Controller（nginx）
  → Service spark-ui-<appId>（ClusterIP）
  → Driver Pod:4040
```

### 4.2 动态 Ingress 的挑战

Spark 作业是动态创建的——每次提交作业，就有一个新的 Driver Pod，需要一个新的 Ingress 规则。这不能手动管理（每次提交作业都要手动创建 Ingress 太繁琐），需要自动化。

**方案一：Spark 作业提交时自动创建 Ingress**

在 `spark-submit` 前，通过脚本动态创建 Ingress：

```bash
APP_ID=$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | head -c 16)

# 先创建 Ingress
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: spark-ui-${APP_ID}
  namespace: spark-ns
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /\$2
spec:
  rules:
    - host: spark-ui.company.com
      http:
        paths:
          - path: /spark/${APP_ID}(/|$)(.*)
            pathType: Prefix
            backend:
              service:
                name: spark-ui-${APP_ID}
                port:
                  number: 4040
EOF

# 再提交作业（同时设置 Spark UI 的 basePath）
spark-submit \
  --conf spark.ui.proxyBase=/spark/${APP_ID} \  # 告诉 Spark UI 其 URL 前缀
  --conf spark.kubernetes.driver.label.app-id=${APP_ID} \
  ...
```

**`spark.ui.proxyBase` 的重要性**：Spark UI 内部的所有链接（CSS、JS、API 调用）默认使用根路径（`/`）。当通过 Ingress 代理时，UI 的路径变成了 `/spark/<appId>/`，如果不设置 `proxyBase`，UI 内的相对链接会 404。`proxyBase=/spark/${APP_ID}` 告诉 Spark UI 所有链接都加上这个前缀。

**方案二：Spark Operator 自动管理（推荐）**

使用 Spark Operator（第 07 篇详述）时，Operator 可以根据 SparkApplication CRD 的配置，在作业启动时自动创建 Service 和 Ingress，作业完成后自动清理。这是生产中管理 Spark UI 访问的最优方案。

---

## 第 5 章 History Server：历史作业 UI 的持久化访问

### 5.1 "Pod 删了就看不到 UI"的问题

Spark UI 运行在 Driver Pod 的进程中。Driver Pod 删除后（作业完成或 `kubectl delete pod`），UI 就消失了——无法再查看历史作业的 Stage 详情、Task 指标、Shuffle 统计。

**YARN 模式的解决方案**：YARN 将作业的 EventLog（记录作业所有事件的日志文件）写到 HDFS，JobHistoryServer 读取 EventLog 重建历史 UI。

**K8s 模式同理**：Spark 将 EventLog 写到对象存储（S3/OSS/HDFS），History Server 部署在 K8s 中（Deployment），持续读取 EventLog，提供历史作业的 Web UI。

### 5.2 EventLog 的配置

```python
# spark-submit 配置 EventLog 写出到 S3
spark-submit \
  --conf spark.eventLog.enabled=true \
  --conf spark.eventLog.dir=s3a://my-bucket/spark-event-logs/ \
  --conf spark.eventLog.compress=true \           # 压缩 EventLog，节省存储
  --conf spark.eventLog.rolling.enabled=true \    # 滚动写入（长时间运行的作业）
  --conf spark.eventLog.rolling.maxFileSize=128m \
  ...
```

**EventLog 的内容**：EventLog 是 JSON 格式的事件流文件，记录了作业的完整生命周期事件：

```json
{"Event":"SparkListenerApplicationStart","App Name":"MyApp","App ID":"app-001",...}
{"Event":"SparkListenerJobStart","Job ID":0,"Stage Infos":[...],...}
{"Event":"SparkListenerTaskStart","Stage ID":0,"Task Info":{...},...}
{"Event":"SparkListenerTaskEnd","Stage ID":0,"Task Info":{...},"Task Metrics":{...},...}
{"Event":"SparkListenerJobEnd","Job ID":0,"Job Result":{"Result":"JobSucceeded"},...}
{"Event":"SparkListenerApplicationEnd","Timestamp":1677571200000}
```

History Server 读取这些事件，完整重建 Spark UI 中的 Jobs、Stages、Tasks 等页面。

### 5.3 History Server 在 K8s 上的部署

History Server 是一个独立的 Spark 进程（`spark-class org.apache.spark.deploy.history.HistoryServer`），需要部署为 K8s Deployment，持续运行：

```yaml
# history-server-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spark-history-server
  namespace: spark-ns
spec:
  replicas: 1
  selector:
    matchLabels:
      app: spark-history-server
  template:
    metadata:
      labels:
        app: spark-history-server
    spec:
      serviceAccountName: spark-driver-sa
      containers:
        - name: history-server
          image: my-registry/spark/spark-base:3.3.2-jdk11
          command:
            - /opt/spark/sbin/start-history-server.sh
          env:
            - name: SPARK_HISTORY_OPTS
              value: >-
                -Dspark.history.fs.logDirectory=s3a://my-bucket/spark-event-logs/
                -Dspark.history.fs.update.interval=10s
                -Dspark.history.retainedApplications=500
                -Dspark.hadoop.fs.s3a.access.key=$(AWS_ACCESS_KEY_ID)
                -Dspark.hadoop.fs.s3a.secret.key=$(AWS_SECRET_ACCESS_KEY)
          envFrom:
            - secretRef:
                name: aws-credentials   # S3 认证信息存储在 K8s Secret
          ports:
            - containerPort: 18080      # History Server 默认端口
          resources:
            requests:
              cpu: "1"
              memory: "4Gi"
            limits:
              cpu: "2"
              memory: "8Gi"

---
# 为 History Server 创建 Service
apiVersion: v1
kind: Service
metadata:
  name: spark-history-server
  namespace: spark-ns
spec:
  selector:
    app: spark-history-server
  ports:
    - port: 18080
      targetPort: 18080

---
# 为 History Server 创建 Ingress（固定地址）
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: spark-history-server-ingress
  namespace: spark-ns
spec:
  rules:
    - host: spark-history.company.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: spark-history-server
                port:
                  number: 18080
```

### 5.4 History Server 的性能调优

**问题**：当 S3 中积累了大量 EventLog 文件（如数千个作业），History Server 启动时需要扫描所有文件，启动时间可能长达数分钟，UI 无响应。

**解决方案一**：限制扫描数量

```
spark.history.retainedApplications=200   # 只展示最近 200 个作业
spark.history.fs.numReplayThreads=4      # 并行解析 EventLog（加速启动）
```

**解决方案二**：EventLog 目录分区

按日期分层组织 EventLog 目录，History Server 只扫描指定时间范围：

```
s3://bucket/spark-event-logs/
  2026-02-28/
    app-2026-02-28-001
    app-2026-02-28-002
  2026-02-27/
    ...
```

```
spark.history.fs.logDirectory=s3a://bucket/spark-event-logs/2026-02-28/
# 或者动态配置（每天更新）
```

> [!warning] 生产避坑
> S3 的 EventLog 文件不能使用 `s3://` 前缀，必须使用 `s3a://`（Hadoop 的 S3A 客户端，支持大文件和多部分上传）。`s3://` 前缀对应的是老旧的 `S3NativeFileSystem`，不支持追加写入（Spark EventLog 写入需要追加），会导致 EventLog 文件损坏。

---

## 小结

Spark UI 在 K8s 上的访问方案总结：

| 方案 | 适用场景 | 优点 | 缺点 |
|-----|---------|-----|-----|
| `kubectl port-forward` | 开发调试 | 零配置，立即可用 | 单用户，不稳定，生产不可用 |
| NodePort | 测试环境 | 配置简单 | 端口耗尽，防火墙限制 |
| Ingress | **生产推荐** | 统一入口，路径路由，80/443 端口 | 需要 Ingress Controller，动态管理复杂 |
| Spark Operator + Ingress | **平台化场景** | 全自动 Service/Ingress 管理 | 需要部署 Spark Operator |

History Server 是解决"历史作业 UI 消失"问题的标准方案：
- EventLog 写到对象存储（`s3a://`）持久化
- History Server 作为 Deployment 长期运行，通过 Ingress 固定地址访问
- 大量历史作业时，通过 `retainedApplications` 和日期分区控制扫描范围

第 06 篇深入存储与 Shuffle：K8s 上 Shuffle 文件管理的挑战（Pod 临时存储 vs PVC），以及 Apache Uniffle（Remote Shuffle Service）如何彻底解耦 Shuffle 数据与 Executor Pod 生命周期。

---

## 参考资料

- Apache Spark 官方文档：Web UI, History Server
- Kubernetes 官方文档：Ingress
- [Running Spark History Server on Kubernetes（Databricks Blog）](https://www.databricks.com/blog/2022/03/15/deploy-apache-spark-history-server-to-aws-eks.html)
