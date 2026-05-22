# ES 集群日志采集：Grafana Alloy DaemonSet 落地方案

> 版本: v2.0（2026-05-18 基于实验验证更新） 实验验证环境: drss136248.venus.sohurdc.com（K8s 1.28.2, Docker 19.3.14） 技术评审: [DAEMONSET_REVIEW.md](https://file+.vscode-resource.vscode-cdn.net/Users/lihaopeng/CascadeProjects/salt-states/src/install_alloy/doc/DAEMONSET_REVIEW.md)

---

## 一、背景与约束

大数据 K8s 集群运行多个 Elasticsearch 集群，需将 ES 容器日志接入 Loki 进行集中存储与查询。

### 环境事实

|项目|实际情况|
|---|---|
|K8s 版本|v1.28.2|
|容器运行时|Docker 19.3.14（`json-file` 日志驱动）|
|ES 管理方式|**DomeOS**（搜狐内部平台），**非** ECK Operator|
|镜像仓库|`private-registry.sohucs.com`（需凭证）|
|外网访问|无|
|Helm|未安装|
|Loki 写入端点|`http://write.grafana-loki.sohucs.com/loki/api/v1/push`|
|Loki 读取端点|`http://read.grafana-loki.sohucs.com/loki/api/v1/query_range`|
|Loki tenant_id|`e9e89be363f04160a0e572b08ae0f215`|

### DomeOS Pod 标签体系

DomeOS 管理的 ES Pod **没有** ECK Operator 标签，实际标签如下：

```json
// Deployment 类型 Pod (bd-es-middle, bd-es-online)
{
    "app": "bd-es-middle-15-96-ssd-data-1",   // 编码了集群/节点/角色信息
    "deployId": "42902",
    "version": "2"
}

// StatefulSet 类型 Pod (bd-service-es, tv-log-es8, bigdata-logs-elasticsearch)
{
    "app": "bd-service-es-159-101-master1",
    "statefulset.kubernetes.io/pod-name": "dmo-bd-service-es-159-101-master1-st-0",
    "deployId": "39510",
    "version": "10"
}
```

`app` 标签格式规律：`{es集群名}-{节点IP后两段}-{角色名}`，例如：

- `bd-es-middle-15-96-ssd-data-1` → 集群 `bd-es-middle`，角色 `ssd-data`
- `bd-service-es-159-101-master1` → 集群 `bd-service-es`，角色 `master`

### ES 相关 Namespace 清单

|Namespace|ES 集群用途|
|---|---|
|`bd-es-middle`|中台 ES（含 Kibana）|
|`bd-es-online`|在线业务 ES|
|`bd-service-es`|服务层 ES（StatefulSet）|
|`tv-log-es8`|TV 日志 ES（StatefulSet）|
|`bigdata-logs-elasticsearch`|大数据日志 ES（StatefulSet）|
|`elasticsearch-standalone-yz`|压测/独立 ES|

---

## 二、方案选型：DaemonSet 而非 Sidecar

|维度|Sidecar|DaemonSet + Alloy|
|---|---|---|
|侵入性|需修改 ES Pod spec，全部重建|零侵入，不触碰 ES Pod|
|资源开销|N 个 Pod = N 个 sidecar 进程|每 Node 仅 1 个 Alloy 进程|
|动态适配|新 Pod 需确保带 sidecar|新 Pod 自动发现，无需任何操作|
|升级维护|随 ES Pod 重建才能更新|独立更新 DaemonSet，不影响 ES|

---

## 三、技术架构

```
┌──────────────────────────────────────────────────────────────┐
│                         K8s Node                             │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  ES Pod A    │  │  ES Pod B    │  │  Alloy DaemonSet │  │
│  │ (bd-es-mid)  │  │ (bd-svc-es)  │  │                  │  │
│  └──────────────┘  └──────────────┘  │ discovery.k8s    │  │
│         │                │           │  → relabel       │  │
│         └────────────────┘           │ loki.source.k8s  │  │
│              stdout/stderr           │  (K8s API)       │  │
│              via K8s API             │ loki.write    ───┼──┼──→ Loki
│                                      └──────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 核心组件说明

|组件|作用|
|---|---|
|`discovery.kubernetes`|通过 K8s API 发现本 Node 上指定 namespace 的 Pod|
|`discovery.relabel`|从 Pod DomeOS 标签提取集群、角色、节点等元数据|
|`loki.source.kubernetes`|通过 K8s API tail 容器日志（**无需 privileged**）|
|`loki.process`|添加静态标签（`log_type`, `agent` 等）|
|`loki.write`|推送日志到 Loki|

**为什么用 `loki.source.kubernetes` 而非 `loki.source.file`**：

- Docker 根目录为非标准路径 `/container/domeos/docker`，`/var/log/pods/` 中的 symlink 指向该目录，用 `loki.source.file` 需额外挂载非标准路径
- `loki.source.kubernetes` 通过 K8s API 读取，无需文件系统挂载，也无需 privileged
- **实验验证**：在 K8s 1.28.2 + Docker 19.3.14 环境上，`loki.source.kubernetes` 完全正常工作

---

## 四、部署步骤

### Step 1：构建 Alloy Docker 镜像

#### 4.1.1 创建 GitLab 仓库

建议在 `bigdata-cmdb` 组下创建独立仓库，如 `alloy-image`，包含以下文件：

```
alloy-image/
├── Dockerfile
└── .gitlab-ci.yml
```

#### 4.1.2 Dockerfile（已验证）

```dockerfile
# Stage 1: 下载并校验二进制
FROM registry-in.beta.sohucs.com/flannel/flannel:v0.22.3 AS downloader

ARG ALLOY_VERSION=1.16.1
ARG ALLOY_URL=https://sohu-bd-devops.bjcnc.scs.sohucs.com/K8S/alloy/alloy-${ALLOY_VERSION}
ARG ALLOY_SHA256=0223bb8f66577922fcad16840937ce9080020b51e5d865dcabf1811008f5fcd8

RUN wget -O /alloy "${ALLOY_URL}" && \
    echo "${ALLOY_SHA256}  /alloy" | sha256sum -c - && \
    chmod 755 /alloy

# Stage 2: CentOS 8 运行时（glibc 兼容，Alloy 动态链接二进制可直接运行）
FROM private-registry.sohucs.com/domeos-pub/centos:8

COPY --from=downloader /alloy /usr/local/bin/alloy

RUN groupadd -r alloy && useradd -r -g alloy -s /sbin/nologin alloy
USER alloy

ENTRYPOINT ["/usr/local/bin/alloy"]
CMD ["run", "/etc/alloy/config.alloy", \
     "--storage.path=/var/lib/alloy/data", \
     "--server.http.listen-addr=0.0.0.0:12345", \
     "--disable-reporting", \
     "--stability.level=experimental"]
```

#### 4.1.3 .gitlab-ci.yml（DomeOS CI 配置）

```yaml
variables:
  ALLOY_VERSION: "1.16.1"
  IMAGE_REPO: "private-registry.sohucs.com/bigdata-ops/alloy"

stages:
  - build

build-image:
  stage: build
  tags:
    - docker
  before_script:
    - docker login -u "${REGISTRY_USER}" -p "${REGISTRY_PASS}" "${REGISTRY_HOST}"
  script:
    - docker build
        --build-arg ALLOY_VERSION=${ALLOY_VERSION}
        --no-cache
        -t "${IMAGE_REPO}:${ALLOY_VERSION}"
        -t "${IMAGE_REPO}:latest"
        .
    - docker push "${IMAGE_REPO}:${ALLOY_VERSION}"
    - docker push "${IMAGE_REPO}:latest"
  only:
    - main
    - tags
```

在 GitLab Settings → Variables 中配置 `REGISTRY_HOST`、`REGISTRY_USER`、`REGISTRY_PASS`（密码设为 masked）。

---

### Step 2：部署 K8s 资源

将以下 YAML 保存为 `alloy-es-daemonset.yaml`，通过 `kubectl apply` 部署。

```yaml
---
# Namespace（如已有 monitoring namespace 可跳过此步）
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
---
# ServiceAccount
apiVersion: v1
kind: ServiceAccount
metadata:
  name: alloy-es
  namespace: monitoring
---
# ClusterRole：允许 Alloy 读取 Pod 列表和 Pod 日志
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: alloy-es-log-reader
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "namespaces"]
    verbs: ["get", "list", "watch"]
---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: alloy-es-log-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: alloy-es-log-reader
subjects:
  - kind: ServiceAccount
    name: alloy-es
    namespace: monitoring
---
# Alloy 配置 ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: alloy-es-config
  namespace: monitoring
data:
  config.alloy: |
    // ============================================================
    // ES 集群日志采集（DomeOS 环境 - namespace 发现策略）
    // ============================================================

    // 1. 发现本 Node 上 ES 相关 namespace 的 Pod
    discovery.kubernetes "pods" {
        role = "pod"
        namespaces {
            names = [
                "bd-es-middle",
                "bd-es-online",
                "bd-service-es",
                "tv-log-es8",
                "bigdata-logs-elasticsearch",
                "elasticsearch-standalone-yz",
            ]
        }
        selectors {
            role  = "pod"
            field = "spec.nodeName=" + env("NODE_NAME")
        }
    }

    // 2. 标签提取（适配 DomeOS 标签体系）
    discovery.relabel "es_pods" {
        targets = discovery.kubernetes.pods.targets

        // 只处理 Running 状态的 Pod
        rule {
            source_labels = ["__meta_kubernetes_pod_phase"]
            regex         = "Running"
            action        = "keep"
        }

        // namespace 即 ES 集群标识
        rule {
            source_labels = ["__meta_kubernetes_namespace"]
            target_label  = "es_cluster"
        }
        rule {
            source_labels = ["__meta_kubernetes_namespace"]
            target_label  = "namespace"
        }

        // Pod 名
        rule {
            source_labels = ["__meta_kubernetes_pod_name"]
            target_label  = "pod"
        }

        // 节点名
        rule {
            source_labels = ["__meta_kubernetes_pod_node_name"]
            target_label  = "node"
        }

        // DomeOS app 标签（包含节点 IP 和角色）
        rule {
            source_labels = ["__meta_kubernetes_pod_label_app"]
            target_label  = "app"
        }

        // 从 app 标签提取 ES 角色（去掉集群名和节点 IP 前缀）
        // app 格式示例: bd-es-middle-15-96-ssd-data  → es_role=ssd-data
        //               bd-service-es-159-101-master1 → es_role=master1
        rule {
            source_labels = ["__meta_kubernetes_pod_label_app"]
            regex         = "^[^-]+-[^-]+-[^-]+-\\d+-\\d+-(.*?)(?:-\\d+)?$"
            target_label  = "es_role"
            replacement   = "$1"
        }

        // 容器名
        rule {
            source_labels = ["__meta_kubernetes_pod_container_name"]
            target_label  = "container"
        }

        // 清理高基数标签
        rule {
            regex  = "(pod_template_hash|controller_revision_hash)"
            action = "labeldrop"
        }
    }

    // 3. 通过 K8s API 读取 Pod 日志（无需 privileged）
    loki.source.kubernetes "es_logs" {
        targets    = discovery.relabel.es_pods.output
        forward_to = [loki.process.es_pipeline.receiver]
    }

    // 4. 日志处理管线
    loki.process "es_pipeline" {
        // 添加静态标签（用于区分 DaemonSet 来源）
        stage.static_labels {
            values = {
                log_type = "elasticsearch",
                agent    = "alloy-daemonset",
            }
        }

        // 可选：ES 日志通常为 JSON，解析 level 字段（注释掉以减少 CPU 开销）
        // stage.json {
        //     expressions = {
        //         level = "level",
        //     }
        // }

        forward_to = [loki.write.default.receiver]
    }

    // 5. 写入 Loki
    loki.write "default" {
        endpoint {
            url       = "http://write.grafana-loki.sohucs.com/loki/api/v1/push"
            tenant_id = "e9e89be363f04160a0e572b08ae0f215"
            batch_size = "4MiB"
            batch_wait = "1s"
        }
        wal {
            enabled = true
        }
    }

    logging {
        level  = "info"
        format = "logfmt"
    }
---
# DaemonSet
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: alloy-es
  namespace: monitoring
  labels:
    app: alloy-es
spec:
  selector:
    matchLabels:
      app: alloy-es
  template:
    metadata:
      labels:
        app: alloy-es
    spec:
      serviceAccountName: alloy-es
      tolerations:
        - operator: Exists    # 确保在所有 Node 上运行（含有污点的节点）
      containers:
        - name: alloy
          # 替换为 DomeOS CI 构建并推送的镜像地址
          image: private-registry.sohucs.com/bigdata-ops/alloy:1.16.1
          imagePullPolicy: IfNotPresent
          env:
            # Downward API 注入节点名（仅使用 NODE_NAME，不依赖 HOSTNAME）
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - containerPort: 12345
              name: http
              protocol: TCP
          volumeMounts:
            - name: config
              mountPath: /etc/alloy
            - name: alloy-data
              mountPath: /var/lib/alloy/data
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 12345
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: config
          configMap:
            name: alloy-es-config
        - name: alloy-data
          emptyDir: {}
```

#### 部署命令

```bash
kubectl apply -f alloy-es-daemonset.yaml

# 检查 DaemonSet 状态
kubectl get ds -n monitoring alloy-es
# 期望：DESIRED == CURRENT == READY == Node 总数
```

---

### Step 3：验证

#### 3.1 确认 DaemonSet 正常运行

```bash
kubectl get ds -n monitoring alloy-es
kubectl get pods -n monitoring -l app=alloy-es -o wide
```

#### 3.2 查看 Alloy 自身日志

```bash
POD=$(kubectl get pods -n monitoring -l app=alloy-es -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n monitoring $POD --tail=50
```

**首次部署预期行为**：会看到大量 `timestamp too old` 的 400 错误。这是因为 `loki.source.kubernetes` 首次启动会读取 Pod 自创建以来的全部 K8s API 日志历史，而 Loki 仅接受 7 天内的日志。旧日志被丢弃后，约 10~30 分钟内错误自动消失，转为实时流模式（可见 `"opened log stream"` 日志）。**这是预期行为，不影响最终效果**。

#### 3.3 确认发现目标

```bash
# 查看 Alloy HTTP 接口上报现的 targets
kubectl port-forward -n monitoring ds/alloy-es 12345:12345 &
curl -s http://localhost:12345/api/v0/component/discovery.relabel.es_pods | python3 -m json.tool | head -50
```

期望看到本节点上运行的 ES Pod 均在 targets 中，且标签字段正确。

#### 3.4 Loki 查询验证

在 Grafana Explore 或通过 curl 查询（等待约 10 分钟追上实时流后）：

```logql
# 查询特定 ES 集群日志
{es_cluster="bd-es-middle", agent="alloy-daemonset"} | limit 20

# 按角色查询
{es_cluster="bd-es-middle", es_role="master"} | limit 20

# 查询所有 ES 日志
{log_type="elasticsearch", agent="alloy-daemonset"} | limit 20
```

curl 查询方式（用于验证端点可达性）：

```bash
START=$(date -d "5 minutes ago" +%s)000000000
END=$(date +%s)000000000
curl -s -G "http://read.grafana-loki.sohucs.com/loki/api/v1/query_range" \
  -H "X-Scope-OrgID: e9e89be363f04160a0e572b08ae0f215" \
  --data-urlencode 'query={log_type="elasticsearch", agent="alloy-daemonset"}' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode "limit=5" | python3 -m json.tool
```

---

## 五、Loki 标签说明

Alloy 写入 Loki 的每条日志 Stream 包含以下标签：

|标签|示例值|来源|
|---|---|---|
|`es_cluster`|`bd-es-middle`|K8s namespace|
|`namespace`|`bd-es-middle`|K8s namespace|
|`pod`|`dmo-bd-es-middle-15-96-ssd-data-1-fn9s3042-deploy-...`|Pod name|
|`node`|`jsy-15-96`|Pod spec.nodeName|
|`app`|`bd-es-middle-15-96-ssd-data-1`|DomeOS app label|
|`es_role`|`ssd-data`|从 app label 正则提取|
|`container`|`bd-es-middle-15-96-ssd-data-1-0`|Container name|
|`log_type`|`elasticsearch`|静态标签（由 Alloy 注入）|
|`agent`|`alloy-daemonset`|静态标签（用于区分采集来源）|
|`instance`|`bd-es-middle/dmo-...:container-name`|loki.source.kubernetes 自动生成|
|`job`|`loki.source.kubernetes.es_logs`|loki.source.kubernetes 自动生成|

---

## 六、运维说明

### 6.1 首次部署的历史日志噪音

`loki.source.kubernetes` 首次启动时会读取 Pod 自创建以来的全部日志历史。若 Pod 已运行数月，会产生大量 `timestamp too old` 的 400 错误，这些日志被 Loki 正常拒绝丢弃，**不影响系统稳定**。Alloy 追上实时日志后（通常 10~30 分钟）错误自动消失。

### 6.2 新 ES Pod 自动发现

DaemonSet 的 `discovery.kubernetes` 组件持续 watch K8s API。只要新 Pod 属于 `namespaces.names` 列表中的 namespace，且运行在已有 Alloy DaemonSet Pod 的节点上，会**自动**开始采集，无需任何手动操作。

### 6.3 添加新 ES Namespace

如后续新增 ES 集群在新 namespace 中，编辑 ConfigMap 的 `namespaces.names` 列表并重启 DaemonSet：

```bash
kubectl edit configmap alloy-es-config -n monitoring
# 在 names 列表中追加新 namespace

kubectl rollout restart daemonset/alloy-es -n monitoring
```

### 6.4 查看 Alloy 指标

```bash
# 已成功发送的日志条数
curl -s http://$(kubectl get pod -n monitoring -l app=alloy-es -o jsonpath='{.items[0].status.podIP}'):12345/metrics | \
  grep loki_write_sent_entries_total

# 发现到的目标 Pod 数（期望等于本节点上的 ES Pod 数）
curl -s http://$(kubectl get pod -n monitoring -l app=alloy-es -o jsonpath='{.items[0].status.podIP}'):12345/metrics | \
  grep discovery_
```

### 6.5 升级 Alloy 版本

1. 更新 GitLab 仓库 Dockerfile 的 `ALLOY_VERSION` 和 `ALLOY_SHA256`
2. DomeOS CI 触发构建，推送新镜像
3. 更新 DaemonSet 的 `image` 字段（或通过 GitOps 自动同步）：
    
    ```bash
    kubectl set image daemonset/alloy-es alloy=private-registry.sohucs.com/bigdata-ops/alloy:新版本 -n monitoring
    ```
    

---

## 七、遗留 TODO

- [ ] 在 ES 节点上确认 `pub.domeos.org/kubernetes/pause:latest` 镜像可访问（Dockerfile 构建依赖）
- [ ] 验证 ES 节点上 `es_role` 正则是否正确提取所有角色类型（master, data, coord, hdd 等）
- [ ] 按需决定是否启用 `stage.json` 解析 ES 日志中的 `level` 字段
- [ ] 如需慢查询日志（独立文件而非 stdout），考虑补充 `loki.source.file` + hostPath 方案

---

## 八、参考

| 资料                                                                                                                                                            | 说明                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [DAEMONSET_REVIEW.md](https://file+.vscode-resource.vscode-cdn.net/Users/lihaopeng/CascadeProjects/salt-states/src/install_alloy/doc/DAEMONSET_REVIEW.md)     | 技术评审详情与实验过程                                |
| [daemonset-experiment/](https://file+.vscode-resource.vscode-cdn.net/Users/lihaopeng/CascadeProjects/salt-states/src/install_alloy/doc/daemonset-experiment/) | 实验用 Dockerfile、.gitlab-ci.yml、K8s manifest |
| [loki.source.kubernetes 文档](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.kubernetes/)                                          | 官方文档                                       |
| [discovery.kubernetes 文档](https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.kubernetes/)                                         | 官方文档                                       |