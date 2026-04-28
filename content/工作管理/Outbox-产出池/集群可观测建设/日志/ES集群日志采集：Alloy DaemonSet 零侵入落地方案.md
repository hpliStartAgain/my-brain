# ES 集群日志采集：Grafana Alloy DaemonSet 零侵入落地方案

## 一、背景

搜狐 RDC 大数据集群已部署 Elasticsearch（基于 ECK Operator 管理），需要为 ES 集群添加日志采集能力，将 ES 日志统一接入 Loki 进行集中存储与查询。

### 现状约束

- **ES 集群已在线运行**：Pod 由 ECK Operator 动态管理，不可随意修改 Pod spec
- **多实例共宿**：单个 K8s Node 上可能运行多个 ES Pod（不同集群、不同角色）
- **动态扩缩**：ES Pod 随集群扩缩容动态增减，采集方案需自动适配

### 核心诉求

1. **零侵入**：不修改已有 ES Pod 的任何配置
2. **自动发现**：新 ES Pod 上线自动采集，下线自动停止
3. **标签注入**：从 Pod labels 自动提取 ES 集群名、角色、命名空间等元数据
4. **低开销**：避免每 Pod 一个 sidecar 带来的资源浪费

---

## 二、方案选型：为什么 DaemonSet 而非 Sidecar

| 维度 | Sidecar | DaemonSet + Alloy |
|---|---|---|
| **侵入性** | 需修改 ES Pod spec，全部重建 | 零侵入，不触碰 ES Pod |
| **资源开销** | N 个 Pod = N 个 sidecar 进程 | 每 Node 仅 1 个 Alloy 进程 |
| **动态适配** | 新 Pod 需确保带 sidecar | 新 Pod 自动发现，无需任何操作 |
| **运维复杂度** | 需修改 ECK Operator 配置或 Webhook | 独立部署，与 ES 完全解耦 |
| **升级维护** | 随 ES Pod 重建才能更新 | 独立更新 DaemonSet，不影响 ES |

**结论：DaemonSet 方案是唯一满足"零侵入 + 自动发现 + 低开销"的选择。**

---

## 三、技术架构

```
┌──────────────────────────────────────────────────┐
│                    K8s Node                       │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │  ES Pod  │  │  ES Pod  │  │  Alloy (DS)  │   │
│  │ (cluster │  │ (cluster │  │              │   │
│  │   A,hot) │  │   B,warm)│  │ tail logs ───┼───┼──→ Loki
│  └──────────┘  └──────────┘  │              │   │
│       │              │       │ auto-detect  │   │
│       ▼              ▼       │ labels from  │   │
│  /var/log/pods/...   /var/log/pods/...       │   │
│                              └──────────────┘   │
└──────────────────────────────────────────────────┘
```

### 关键组件（Alloy River 配置）

| 组件 | 作用 |
|---|---|
| `discovery.kubernetes` | 通过 K8s API 发现 Pod，用 `field` selector 限定本 Node |
| `discovery.relabel` | 从 Pod labels/annotations 提取业务标签，过滤非 ES Pod |
| `loki.source.kubernetes` | 通过 K8s API tail 容器日志（GA 组件，无需 privileged） |
| `loki.process` | 可选的日志解析/过滤管线 |
| `loki.write` | 推送日志到 Loki |

---

## 四、Helm 部署

### 4.1 添加 Helm Repo

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

参考：[Grafana Alloy Helm Chart](https://artifacthub.io/packages/helm/grafana/alloy)

### 4.2 values.yaml

```yaml
controller:
  type: daemonset
  hostNetwork: true          # 可选，减少网络跳数
  tolerations:
    - operator: Exists       # 确保在所有 Node 上运行（包括有污点的 Node）

alloy:
  mounts:
    varlog: true             # 挂载 /var/log 到容器内（读取 Pod 日志文件）
  configMap:
    create: true
    content: |
      // ============================================================
      // ES 日志采集配置（由 discovery.kubernetes 自动发现）
      // ============================================================

      // 1. 发现本 Node 上的所有 Pod
      discovery.kubernetes "pods" {
        role = "pod"
        selectors {
          role  = "pod"
          field = "spec.nodeName=" + coalesce(env("HOSTNAME"), constants.hostname)
        }
      }

      // 2. 过滤 + 标签提取
      discovery.relabel "es_pods" {
        targets = discovery.kubernetes.pods.targets

        // --- 只保留 ES Pod（ECK Operator 管理的 Pod 有此 label）---
        rule {
          source_labels = ["__meta_kubernetes_pod_label_elasticsearch_k8s_elastic_co_cluster_name"]
          regex         = ".+"
          action        = "keep"
        }

        // --- 提取标准元数据 ---
        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          target_label  = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          target_label  = "pod"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_node_name"]
          target_label  = "node"
        }

        // --- 提取 ES 专属标签（从 Pod labels）---
        // ES 集群名（ECK 自动注入的 label）
        rule {
          source_labels = ["__meta_kubernetes_pod_label_elasticsearch_k8s_elastic_co_cluster_name"]
          target_label  = "es_cluster"
        }
        // ES 角色：master / data / ingest / ml 等
        // ECK 注入的 label: elasticsearch.k8s.elastic.co/roles
        // 注意：K8s label key 中的 . 和 / 被转为 _
        rule {
          source_labels = ["__meta_kubernetes_pod_label_elasticsearch_k8s_elastic_co_node_role"]
          target_label  = "es_role"
        }

        // --- 通用：自动映射所有 Pod labels（可选，注意基数爆炸）---
        // 如果需要动态捕获所有 label，用 labelmap：
        // rule {
        //   regex  = "__meta_kubernetes_pod_label_(.+)"
        //   action = "labelmap"
        // }

        // --- 构建日志文件路径 ---
        rule {
          source_labels = ["__meta_kubernetes_pod_uid", "__meta_kubernetes_pod_container_name"]
          separator     = "/"
          target_label  = "__path__"
          replacement   = "/var/log/pods/*$1/*.log"
        }

        // --- 清理高基数/无用标签 ---
        rule {
          regex  = "(pod_template_hash|controller_revision_hash|pod_uid)"
          action = "labeldrop"
        }
      }

      // 3. Tail Pod 日志（通过 K8s API）
      loki.source.kubernetes "es_logs" {
        targets    = discovery.relabel.es_pods.output
        forward_to = [loki.process.es_logs.receiver]
      }

      // 4. 可选的日志处理管线
      loki.process "es_logs" {
        // 添加静态集群标识
        stage.static_labels {
          values = {
            cluster   = "bdwh-k8s",
            log_type  = "elasticsearch",
          }
        }

        // 可选：JSON 解析（ES 日志通常是 JSON 格式）
        stage.json {
          expressions = {
            level       = "level",
            logger_name = "logger",
            message     = "message",
          }
        }

        forward_to = [loki.write.default.receiver]
      }

      // 5. 写入 Loki
      loki.write "default" {
        endpoint {
          url = "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"
          // 如 Loki 有认证，添加 basic_auth 块
        }
        external_labels = {
          agent = "alloy",
        }
      }

      // 6. 日志级别
      logging {
        level  = "info"
        format = "logfmt"
      }
```

### 4.3 安装

```bash
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

helm install alloy-es-logger grafana/alloy \
  --namespace monitoring \
  --values values.yaml
```

---

## 五、关键设计决策说明

### 5.1 为什么用 `field` selector 限定本 Node

```alloy
field = "spec.nodeName=" + coalesce(env("HOSTNAME"), constants.hostname)
```

不限定会导致**每个 Alloy 实例尝试 tail 整个集群所有 Pod 的日志**，引发 `too many open files` 错误。这是官方推荐的 DaemonSet 部署模式。

参考：[Grafana 社区论坛 - fsnotify watcher 问题](https://community.grafana.com/t/using-discovery-kubernetes-alloy-pushes-a-lot-of-failed-to-create-fsnotify-watcher-too-many-open-files/127144/12)

### 5.2 为什么用 `loki.source.kubernetes` 而非 `loki.source.file`

| 方案 | 权限要求 | 适用场景 |
|---|---|---|
| `loki.source.kubernetes` | 仅需 K8s API 权限（ServiceAccount） | **推荐**，GA 组件，无需 privileged |
| `loki.source.file` | 需挂载 hostPath `/var/log/pods` | 需要 privileged 或 root |

官方文档明确指出 `loki.source.kubernetes` "doesn't require a DaemonSet to collect logs" 且 "no privileged container or root user required"。

参考：[loki.source.kubernetes 官方文档](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.kubernetes/)

### 5.3 ES Pod 标签发现原理

ECK Operator 会在每个 ES Pod 上自动注入以下 labels（参考 ECK 官方文档）：

| K8s Label | 含义 | Alloy 中的名称 |
|---|---|---|
| `elasticsearch.k8s.elastic.co/cluster-name` | ES 集群名 | `__meta_kubernetes_pod_label_elasticsearch_k8s_elastic_co_cluster_name` |
| `elasticsearch.k8s.elastic.co/node-role` | 节点角色 | `__meta_kubernetes_pod_label_elasticsearch_k8s_elastic_co_node_role` |
| `common.k8s.elastic.co/type` | 资源类型 | `__meta_kubernetes_pod_label_common_k8s_elastic_co_type` |

**注意**：K8s label key 中的 `.` 和 `/` 在 `__meta_kubernetes_pod_label_<name>` 中会被替换为 `_`。

### 5.4 `labelmap` 动态发现 vs 显式 `replace`

- **显式 `replace`**（推荐）：逐个映射需要的标签，标签基数可控
- **`labelmap`**：`regex = "__meta_kubernetes_pod_label_(.+)"` 自动映射所有 Pod labels，但可能导致 Loki 标签基数爆炸，慎用

### 5.5 ServiceAccount 权限

DaemonSet 的 ServiceAccount 需要以下 RBAC 权限：

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: alloy
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: alloy-log-reader
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: alloy-log-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: alloy-log-reader
subjects:
- kind: ServiceAccount
  name: alloy
  namespace: monitoring
```

Helm Chart 默认会创建 ServiceAccount，可通过 `rbac.create: true` 启用（默认开启）。

---

## 六、验证步骤

### 6.1 确认 DaemonSet 运行

```bash
kubectl get ds -n monitoring alloy-es-logger
# 期望：DESIRED == CURRENT == READY == UP-TO-DATE == Node 数量
```

### 6.2 确认日志采集目标

```bash
# 端口转发到 Alloy 的 HTTP 调试端口
kubectl port-forward -n monitoring ds/alloy-es-logger 12345:12345

# 查看发现的 targets
curl http://localhost:12345/component/discovery.relabel.es_pods | jq .
```

### 6.3 在 Loki 中验证

在 Grafana Explore 中使用 LogQL 查询：

```logql
{log_type="elasticsearch", es_cluster=~".+"}
```

---

## 七、高级场景扩展

### 7.1 按 ES 角色分流日志

```alloy
discovery.relabel "es_hot_only" {
  targets = discovery.relabel.es_pods.output

  rule {
    source_labels = ["es_role"]
    regex         = "master|data_hot"
    action        = "keep"
  }
}
```

### 7.2 采集 ES 慢查询日志（JSON 格式）

ES 慢日志存放在独立日志文件中，如果使用 `loki.source.file` 而非 `loki.source.kubernetes`，可以通过 `__path__` 通配符直接指定文件路径：

```alloy
rule {
  source_labels = ["__meta_kubernetes_pod_uid"]
  target_label  = "__path__"
  replacement   = "/var/log/pods/*$1/elasticsearch/*_slowlog.log"
}
```

> **注意**：此方法需 `loki.source.file` + hostPath 挂载，涉及 privileged 权限。

### 7.3 多 Loki 端点（按集群分流）

```alloy
loki.write "cluster_a" {
  endpoint {
    url = "http://loki-cluster-a:3100/loki/api/v1/push"
  }
}

loki.write "cluster_b" {
  endpoint {
    url = "http://loki-cluster-b:3100/loki/api/v1/push"
  }
}

discovery.relabel "es_cluster_a" {
  targets = discovery.relabel.es_pods.output
  rule {
    source_labels = ["es_cluster"]
    regex         = "cluster-a"
    action        = "keep"
  }
}

loki.source.kubernetes "es_cluster_a" {
  targets    = discovery.relabel.es_cluster_a.output
  forward_to = [loki.write.cluster_a.receiver]
}
```

---

## 八、参考来源

- [loki.source.kubernetes 官方文档](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.kubernetes/)
- [discovery.relabel 官方文档](https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.relabel/)
- [discovery.kubernetes 官方文档](https://grafana.com/docs/alloy/latest/reference/components/discovery/discovery.kubernetes/)
- [Grafana Alloy Helm Chart](https://artifacthub.io/packages/helm/grafana/alloy)
- [Alloy K8s 迁移实战（含 DaemonSet + field selector 示例）](https://blog.ayjc.net/posts/promtail-to-alloy-k8s/)
- [fsnotify watcher 问题与 nodeName 过滤方案](https://community.grafana.com/t/using-discovery-kubernetes-alloy-pushes-a-lot-of-failed-to-create-fsnotify-watcher-too-many-open-files/127144/12)
- [ECK Operator Labels 参考](https://www.elastic.co/guide/en/cloud-on-k8s/current/k8s-orchestration.html)
