---
title: 在 Kubernetes 上运行有状态应用
date: 2026-05-13
tags: [Kubernetes, StatefulSet]
aliases:
  - Running Stateful Applications with Kubernetes
---

# 在 Kubernetes 上运行有状态应用

## 理解分布式数据密集型应用的本质

让我们从基础开始。分布式应用是在多台机器上运行的进程集合，它们处理输入、操作数据、暴露 API，并可能产生其他副作用。每个进程是其程序、运行时环境以及输入输出的组合。你在学校编写的程序通过命令行参数获取输入；也许它们会读取文件或访问数据库，然后将结果写入屏幕、文件或数据库。某些程序在内存中保持状态，并可以通过网络处理请求。简单的程序运行在单台机器上，可以将所有状态保存在内存中或从文件读取。它们的运行时环境就是它们的操作系统。如果它们崩溃了，用户必须手动重新启动它们。它们与自己的机器紧密绑定。

分布式应用则是完全不同的东西。单台机器不足以快速处理所有数据或服务所有请求。单台机器无法容纳所有数据。需要处理的数据量如此之大，以至于无法经济高效地将数据下载到每台处理机器中。机器可能会发生故障，需要更换。升级需要在所有处理机器上执行。用户可能分布在全球各地。

考虑到所有这些因素，很明显传统方法是行不通的。限制因素变成了数据。用户/客户端只能接收摘要或处理后的数据。所有大规模数据处理必须在数据附近完成，因为传输数据异常缓慢且昂贵。相反，大部分处理代码必须运行在与数据相同的数据中心和网络环境中。

## 为什么在 Kubernetes 中管理状态？

在 Kubernetes 自身而非独立集群中管理状态的主要原因是，监控、扩展、分配、保护和运维存储集群所需的大量基础设施已经由 Kubernetes 提供。运行一个并行的存储集群会导致大量重复工作。

## 为什么在 Kubernetes 外部管理状态？

我们也不要排除另一种选择。在某些情况下，在独立的非 Kubernetes 集群中管理状态可能更好，只要它共享相同的内部网络（数据就近性胜过一切）。

一些合理的理由如下：

- 你已经有了一个独立的存储集群，不想节外生枝
- 你的存储集群被其他非 Kubernetes 应用程序使用
- Kubernetes 对你存储集群的支持还不够稳定或成熟
- 你可能想逐步在 Kubernetes 中处理有状态应用，从独立的存储集群开始，之后再与 Kubernetes 进行更紧密的集成

## 用于服务发现的共享环境变量与 DNS 记录

Kubernetes 提供了几种在集群范围内进行全局发现的机制。如果你的存储集群不由 Kubernetes 管理，你仍然需要告诉 Kubernetes Pod 如何找到并访问它。

有两种常见方法：

- DNS
- 环境变量

在某些情况下，你可能希望同时使用两者，因为环境变量可以覆盖 DNS。

### 通过 DNS 访问外部数据存储

DNS 方法简单直接。假设你的外部存储集群是负载均衡的，并能提供稳定的端点，那么 Pod 可以直接访问该端点并连接到外部集群。

### 通过环境变量访问外部数据存储

另一种简单的方法是使用环境变量将连接信息传递给外部存储集群。Kubernetes 提供了 ConfigMap 资源，用于将配置与容器镜像分离。配置是一组键值对。配置信息可以通过两种方式暴露。一种方式是通过环境变量。另一种方式是将配置文件作为卷挂载到容器中。对于密码等敏感连接信息，你可能更倾向于使用 Secret。

### 创建 ConfigMap

以下是一个保存地址列表的 ConfigMap 文件：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: db-config
data:
  db-ip-addresses: 1.2.3.4,5.6.7.8
```

将其保存为 `db-config-map.yaml` 并运行：

```bash
$ k create -f db-config-map.yaml
configmap/db-config created
```

`data` 部分包含所有键值对，这里只有一个键名为 `db-ip-addresses` 的键值对。这在稍后在 Pod 中使用 ConfigMap 时非常重要。你可以检查内容以确保一切正常：

```bash
$ k get configmap db-config -o yaml
apiVersion: v1
data:
  db-ip-addresses: 1.2.3.4,5.6.7.8
kind: ConfigMap
metadata:
  creationTimestamp: "2022-07-17T17:39:05Z"
  name: db-config
  namespace: default
  resourceVersion: "504571"
  uid: 11e49df0-ed1e-4bee-9fd7-bf38bb2aa38a
```

还有其他创建 ConfigMap 的方式。你可以直接使用 `--from-value` 或 `--from-file` 命令行参数来创建。

### 将 ConfigMap 作为环境变量使用

创建 Pod 时，你可以指定一个 ConfigMap 并以多种方式使用其值。下面是将 ConfigMap 作为环境变量使用的方式：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod
spec:
  containers:
  - name: some-container
    image: busybox
    command: ["/bin/sh", "-c", "env"]
    env:
    - name: DB_IP_ADDRESSES
      valueFrom:
        configMapKeyRef:
          name: db-config
          key: db-ip-addresses
  restartPolicy: Never
```

这个 Pod 运行 busybox 最小容器并执行 `env` bash 命令，然后立即退出。`db-config` ConfigMap 中的 `db-ip-addresses` 键被映射到 `DB_IP_ADDRESSES` 环境变量，并反映在日志中：

```bash
$ k create -f pod-with-db.yaml
pod/some-pod created
$ k logs some-pod | grep DB_IP
DB_IP_ADDRESSES=1.2.3.4,5.6.7.8
```

## 使用冗余内存状态

在某些情况下，你可能希望在内存中保持临时状态。分布式缓存是常见的用例。时间敏感信息是另一种情况。对于这些用例，不需要持久化存储，通过 Service 访问的多个 Pod 可能就是正确的解决方案。

我们可以使用标准 Kubernetes 技术，如标签（Label），来标识属于分布式缓存的 Pod，存储同一状态的冗余副本，并通过 Service 暴露它们。如果一个 Pod 挂了，Kubernetes 会创建一个新的 Pod，在它赶上进度之前，其他 Pod 将提供服务。我们甚至可以使用 Pod 的反亲和性（anti-affinity）特性来确保维护相同状态冗余副本的 Pod 不会被调度到同一节点上。

当然，你也可以使用像 Memcached 或 Redis 这样的工具。

## 使用 DaemonSet 实现冗余持久化存储

某些有状态应用，如分布式数据库或消息队列，会冗余管理其状态并自动同步节点（我们稍后将深入探讨 Cassandra）。在这些情况下，确保 Pod 被调度到不同的节点上非常重要。同样重要的是，Pod 应被调度到具有特定硬件配置的节点上，甚至可以是专用于该有状态应用的节点。

DaemonSet 特性非常适合这种用例。我们可以给一组节点打上标签，并确保有状态 Pod 以一对一的方式被调度到选定的节点组上。

## 使用持久卷声明

如果有状态应用可以有效地使用共享持久化存储，那么在每个 Pod 中使用持久卷声明（PersistentVolumeClaim）是可行之道，正如我们在第 6 章"管理存储"中演示的那样。有状态应用将会看到一个挂载的卷，看起来就像本地文件系统一样。

## 利用 StatefulSet

StatefulSet 是专门设计用来支持分布式有状态应用的，在这些应用中，成员的标识（identity）非常重要——如果某个 Pod 被重启，它必须在集合中保留其标识。它提供了有序的部署和扩缩容。与普通 Pod 不同，StatefulSet 的 Pod 与持久化存储相关联。

### 何时使用 StatefulSet

StatefulSet 非常适合需要以下任一能力的应用：

- 一致且独特的网络标识符
- 持久且耐用的存储
- 有条不紊、有序的部署和扩缩容
- 系统化、有组织的删除和终止

### StatefulSet 的组成部分

要拥有一个可工作的 StatefulSet，需要正确配置以下几个要素：

- 一个负责管理 StatefulSet Pod 网络标识的无头服务（Headless Service）
- StatefulSet 本身及其副本数
- 节点上的本地存储，或由管理员或动态方式提供的持久化存储

以下是一个名为 `nginx` 的无头服务示例，它将用于 StatefulSet：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  labels:
    app: nginx
spec:
  selector:
    app: nginx
  ports:
  - port: 80
    name: web
  clusterIP: None
```

现在，StatefulSet 清单文件将引用该服务：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: "nginx"
  replicas: 3
  template:
    metadata:
      labels:
        app: nginx
```

下一部分是 Pod 模板，包含一个名为 `www` 的挂载卷：

```yaml
    spec:
      terminationGracePeriodSeconds: 10
      containers:
      - name: nginx
        image: gcr.io/google_containers/nginx-slim:0.8
        ports:
        - containerPort: 80
          name: web
        volumeMounts:
        - name: www
          mountPath: /usr/share/nginx/html
```

最后也是重要的一点，`volumeClaimTemplates` 使用一个名为 `www` 的声明，与挂载卷匹配。该声明请求 1 GiB 的存储空间，访问模式为 `ReadWriteOnce`：

```yaml
  volumeClaimTemplates:
  - metadata:
      name: www
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 1Gi
```

## 使用 StatefulSet

让我们创建 nginx 无头服务和 StatefulSet：

```bash
$ k apply -f nginx-headless-service.yaml
service/nginx created
$ k apply -f nginx-stateful-set.yaml
statefulset.apps/nginx created
```

我们可以使用 `kubectl get all` 命令查看所有已创建的资源：

```bash
$ k get all
NAME          READY   STATUS    RESTARTS   AGE
pod/nginx-0   1/1     Running   0          107s
pod/nginx-1   1/1     Running   0          104s
pod/nginx-2   1/1     Running   0          102s

NAME            TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
service/nginx   ClusterIP   None         <none>        80/TCP    2m5s

NAME                    READY   AGE
statefulset.apps/nginx  3/3     107s
```

如预期，我们有了一个包含三个副本的 StatefulSet 和一个无头服务。但没有预见到的是 ReplicaSet——这在创建 Deployment 时会出现。StatefulSet 直接管理其 Pod。注意，`kubectl get all` 实际上并没有展示所有资源。StatefulSet 还为每个 Pod 创建了一个由持久卷（PersistentVolume）支持的持久卷声明（PersistentVolumeClaim）。它们如下所示：

```bash
$ k get pvc
NAME            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
www-nginx-0     Bound    pvc-40ac1c62-bba0-4e3c-9177-eda7402755b3   10Mi       RWO            standard       1m37s
www-nginx-1     Bound    pvc-94022a60-e4cb-4495-825d-eb744088266f   10Mi       RWO            standard       1m43s
www-nginx-2     Bound    pvc-8c60523f-a3e8-4ae3-a91f-6aaa53b02848   10Mi       RWO            standard       1m52h

$ k get pv
NAME                                       CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                   STORAGECLASS   REASON   AGE
pvc-40ac1c62-bba0-4e3c-9177-eda7402755b3   10Mi       RWO            Delete           Bound    default/www-nginx-0     standard                1m59s
pvc-8c60523f-a3e8-4ae3-a91f-6aaa53b02848   10Mi       RWO            Delete           Bound    default/www-nginx-2     standard                2m2s
pvc-94022a60-e4cb-4495-825d-eb744088266f   10Mi       RWO            Delete           Bound    default/www-nginx-1     standard                2m1s
```

如果我们删除一个 Pod，StatefulSet 会创建一个新的 Pod 并将其绑定到对应的持久卷声明。Pod `nginx-1` 绑定到 `www-nginx-1` PVC：

```bash
$ k get po nginx-1 -o yaml | yq '.spec.volumes[0]'
name: www
persistentVolumeClaim:
  claimName: www-nginx-1
```

让我们删除 `nginx-1` Pod 并检查所有剩余的 Pod：

```bash
$ k delete po nginx-1
pod "nginx-1" deleted
$ k get po
NAME      READY   STATUS    RESTARTS   AGE
nginx-0   1/1     Running   0          12m
nginx-1   1/1     Running   0          14s
nginx-2   1/1     Running   0          12m
```

如你所见，StatefulSet 立即用一个新的 `nginx-1` Pod（14 秒前创建）替换了它。新的 Pod 绑定到了同一个持久卷声明：

```bash
$ k get po nginx-1 -o yaml | yq '.spec.volumes[0]'
name: www
persistentVolumeClaim:
  claimName: www-nginx-1
```

当旧的 `nginx-1` Pod 被删除时，持久卷声明及其背后的持久卷并没有被删除，从它们的存在时间可以看出：

```bash
$ k get pvc www-nginx-1
NAME            STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
www-nginx-1     Bound    pvc-94022a60-e4cb-4495-825d-eb744088266f   10Mi       RWO            standard       143s

$ k get pv pvc-94022a60-e4cb-4495-825d-eb744088266f
NAME                                       CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                   STORAGECLASS   REASON   AGE
pvc-94022a60-e4cb-4495-825d-eb744088266f   10Mi       RWO            Delete           Bound    default/www-nginx-1     standard                2m1s
```

这意味着即使 Pod 来了又走，StatefulSet 的状态也被保留。每个由其索引标识的 Pod 始终绑定到状态的特定分片（shard），由对应的持久卷声明提供支持。

至此，我们理解了 StatefulSet 是什么以及如何使用它们。接下来让我们深入实现一个工业级的数据存储，看看它如何以 StatefulSet 的方式部署在 Kubernetes 中。

## 在 Kubernetes 中运行 Cassandra 集群

在本节中，我们将详细探索一个非常大型的示例：配置 Cassandra 集群在 Kubernetes 集群上运行。我将剖析并给出有趣部分的背景说明。如果你想进一步探索，完整示例可以在这里查看：

https://kubernetes.io/docs/tutorials/stateful-application/cassandra

这里的目标是了解在 Kubernetes 上运行真实世界的有状态工作负载需要什么，以及 StatefulSet 如何提供帮助。即使你不理解每一个细枝末节也不必担心。

首先，我们将学习一些关于 Cassandra 及其特性的知识，然后按照逐步过程，使用我们在前一节中介绍的几种技术和策略来运行它。

### Cassandra 快速入门

Cassandra 是一种分布式列式数据存储。它从一开始就是为大数据而设计的。Cassandra 快速、健壮（无单点故障）、高可用且线性可扩展。它还支持多数据中心。它通过聚焦核心功能、精心打磨其支持的特性——同样重要的是，其不支持的特性——来实现所有这些目标。

在我之前的一家公司，我运营了一个 Kubernetes 集群，使用 Cassandra 作为传感器数据（约 100 TB）的主要数据存储。Cassandra 基于分布式哈希表（DHT）算法将数据分配到一个节点集（节点环）中。

集群节点之间通过 Gossip 协议相互通信，并快速了解集群的整体状态（哪些节点加入了，哪些节点离开了或不可用了）。Cassandra 会不断压缩数据并平衡集群。数据通常会被多次复制以实现冗余、健壮性和高可用性。

从开发者的角度来看，Cassandra 非常适合时间序列数据，并提供了灵活的模型，你可以在每个查询中指定一致性级别。它还是幂等的（分布式数据库的一个非常重要的特性），这意味着支持重复插入或更新。

以下图表展示了 Cassandra 集群的组织方式、客户端如何访问任何节点，以及请求如何自动转发到拥有所请求数据的节点：

![图 7.1: 与 Cassandra 集群交互的请求](ch07-fig01.png)

### Cassandra Docker 镜像

与独立的 Cassandra 集群部署不同，在 Kubernetes 上部署 Cassandra 需要一个特殊的 Docker 镜像。这是很重要的一步，因为它意味着我们可以使用 Kubernetes 来跟踪我们的 Cassandra Pod。该镜像的 Dockerfile 可在此处获取：https://github.com/kubernetes/examples/blob/master/cassandra/image/Dockerfile。

以下是构建 Cassandra 镜像的 Dockerfile。基础镜像是一种专为容器使用而设计的 Debian 变体（参见 https://github.com/kubernetes/kubernetes/tree/master/build/debian-base）。

Cassandra Dockerfile 定义了一些构建时必须设置的构建参数，创建了一组标签，定义了许多环境变量，将所有文件添加到容器内的根目录，运行 `build.sh` 脚本，声明 Cassandra 数据卷（数据存储的位置），暴露一系列端口，最后使用 `dumb-init` 执行 `run.sh` 脚本：

```dockerfile
FROM k8s.gcr.io/debian-base-amd64:0.3
ARG BUILD_DATE
ARG VCS_REF
ARG CASSANDRA_VERSION
ARG DEV_CONTAINER
LABEL \
    org.label-schema.build-date=$BUILD_DATE \
    org.label-schema.docker.dockerfile="/Dockerfile" \
    org.label-schema.license="Apache License 2.0" \
    org.label-schema.name="k8s-for-greeks/docker-cassandra-k8s" \
    org.label-schema.url="https://github.com/k8s-for-greeks/" \
    org.label-schema.vcs-ref=$VCS_REF \
    org.label-schema.vcs-type="Git" \
    org.label-schema.vcs-url="https://github.com/k8s-for-greeks/docker-cassandra-k8s"
ENV CASSANDRA_HOME=/usr/local/apache-cassandra-${CASSANDRA_VERSION} \
    CASSANDRA_CONF=/etc/cassandra \
    CASSANDRA_DATA=/cassandra_data \
    CASSANDRA_LOGS=/var/log/cassandra \
    JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 \
    PATH=${PATH}:/usr/lib/jvm/java-8-openjdk-amd64/bin:/usr/local/apache-cassandra-${CASSANDRA_VERSION}/bin
ADD files /
RUN clean-install bash \
    && /build.sh \
    && rm /build.sh
VOLUME ["/$CASSANDRA_DATA"]
# 7000: 节点间通信
# 7001: TLS 节点间通信
# 7199: JMX
# 9042: CQL
# 9160: thrift 服务
EXPOSE 7000 7001 7199 9042 9160
CMD ["/usr/bin/dumb-init", "/bin/bash", "/run.sh"]
```

以下是 Dockerfile 使用的所有文件：

- build.sh
- cassandra-seed.h
- cassandra.yaml
- jvm.options
- kubernetes-cassandra.jar
- logback.xml
- ready-probe.sh
- run.sh

我们不会全部覆盖，但会重点关注几个有趣的脚本：`build.sh` 和 `run.sh` 脚本。

### 探索 build.sh 脚本

Cassandra 是一个 Java 程序。构建脚本安装 Java 运行时环境以及一些必要的库和工具。然后它设置了一些稍后将使用的变量，例如 `CASSANDRA_PATH`。它从 Apache 组织下载正确版本的 Cassandra（Cassandra 是一个 Apache 开源项目），创建 `/cassandra_data/data` 目录（Cassandra 将在此存储其 SSTable）和 `/etc/cassandra` 配置目录，将文件复制到配置目录中，添加一个 Cassandra 用户，设置就绪探测（readiness probe），安装 Python，将 Cassandra JAR 文件和种子共享库移动到目标位置，然后清理此过程中生成的所有中间文件：

```bash
...
clean-install \
    openjdk-8-jre-headless \
    libjemalloc1 \
    localepurge \
    dumb-init \
    wget
CASSANDRA_PATH="cassandra/${CASSANDRA_VERSION}/apache-cassandra-${CASSANDRA_VERSION}-bin.tar.gz"
CASSANDRA_DOWNLOAD="http://www.apache.org/dyn/closer.cgi?path=/${CASSANDRA_PATH}&as_json=1"
CASSANDRA_MIRROR=`wget -q -O - ${CASSANDRA_DOWNLOAD} | grep -oP "(?<=\"preferred\": \")[^\"]+"`
echo "Downloading Apache Cassandra from $CASSANDRA_MIRROR$CASSANDRA_PATH..."
wget -q -O - $CASSANDRA_MIRROR$CASSANDRA_PATH \
    | tar -xzf - -C /usr/local

mkdir -p /cassandra_data/data
mkdir -p /etc/cassandra
mv /logback.xml /cassandra.yaml /jvm.options /etc/cassandra/
mv /usr/local/apache-cassandra-${CASSANDRA_VERSION}/conf/cassandra-env.sh /etc/cassandra/
adduser --disabled-password --no-create-home --gecos '' --disabled-login cassandra
chmod +x /ready-probe.sh
chown cassandra: /ready-probe.sh
DEV_IMAGE=${DEV_CONTAINER:-}
if [ ! -z "$DEV_IMAGE" ]; then
    clean-install python;
else
    rm -rf $CASSANDRA_HOME/pylib;
fi
mv /kubernetes-cassandra.jar /usr/local/apache-cassandra-${CASSANDRA_VERSION}/lib
mv /cassandra-seed.so /etc/cassandra/
mv /cassandra-seed.h /usr/local/lib/include
apt-get -y purge localepurge
apt-get -y autoremove
apt-get clean
rm -rf <many files>
```

### 探索 run.sh 脚本

`run.sh` 脚本需要一定的 Shell 技能和对 Cassandra 的了解才能理解，但值得花功夫去研究。首先，为位于 `/etc/cassandra/cassandra.yaml` 的 Cassandra 配置文件设置一些局部变量。`CASSANDRA_CFG` 变量将在脚本的其余部分使用：

```bash
set -e
CASSANDRA_CONF_DIR=/etc/cassandra
CASSANDRA_CFG=$CASSANDRA_CONF_DIR/cassandra.yaml
```

如果没有指定 `CASSANDRA_SEEDS`，则设置 `HOSTNAME`，稍后 StatefulSet 会用到它：

```bash
# we are doing StatefulSet or just setting our seeds
if [ -z "$CASSANDRA_SEEDS" ]; then
    HOSTNAME=$(hostname -f)
    CASSANDRA_SEEDS=$(hostname -f)
fi
```

然后是一长串带默认值的环境变量。语法 `${VAR_NAME:-}` 使用 `VAR_NAME` 环境变量（如果已定义），否则使用默认值。

类似的语法 `${VAR_NAME:=}` 做同样的事情，但如果变量未定义，还会将默认值赋值给该环境变量。这是一个微妙但重要的区别。

两种变体都在这里使用：

```bash
# The following vars relate to their counter parts in $CASSANDRA_CFG
# for instance rpc_address
CASSANDRA_RPC_ADDRESS="${CASSANDRA_RPC_ADDRESS:-0.0.0.0}"
CASSANDRA_NUM_TOKENS="${CASSANDRA_NUM_TOKENS:-32}"
CASSANDRA_CLUSTER_NAME="${CASSANDRA_CLUSTER_NAME:='Test Cluster'}"
CASSANDRA_LISTEN_ADDRESS=${POD_IP:-$HOSTNAME}
CASSANDRA_BROADCAST_ADDRESS=${POD_IP:-$HOSTNAME}
CASSANDRA_BROADCAST_RPC_ADDRESS=${POD_IP:-$HOSTNAME}
CASSANDRA_DISK_OPTIMIZATION_STRATEGY="${CASSANDRA_DISK_OPTIMIZATION_STRATEGY:ssd}"
CASSANDRA_MIGRATION_WAIT="${CASSANDRA_MIGRATION_WAIT:-1}"
CASSANDRA_ENDPOINT_SNITCH="${CASSANDRA_ENDPOINT_SNITCH:-SimpleSnitch}"
CASSANDRA_DC="${CASSANDRA_DC}"
CASSANDRA_RACK="${CASSANDRA_RACK}"
CASSANDRA_RING_DELAY="${CASSANDRA_RING_DELAY:-30000}"
CASSANDRA_AUTO_BOOTSTRAP="${CASSANDRA_AUTO_BOOTSTRAP:-true}"
CASSANDRA_SEEDS="${CASSANDRA_SEEDS:false}"
CASSANDRA_SEED_PROVIDER="${CASSANDRA_SEED_PROVIDER:-org.apache.cassandra.locator.SimpleSeedProvider}"
CASSANDRA_AUTO_BOOTSTRAP="${CASSANDRA_AUTO_BOOTSTRAP:false}"
```

顺便提一下，我通过提交一个 PR 为 Kubernetes 做出了贡献，修复了这里的一个小拼写错误。参见 https://github.com/kubernetes/examples/pull/348。

下一部分配置 JMX 监控并控制 GC 输出：

```bash
# Turn off JMX auth
CASSANDRA_OPEN_JMX="${CASSANDRA_OPEN_JMX:-false}"
# send GC to STDOUT
CASSANDRA_GC_STDOUT="${CASSANDRA_GC_STDOUT:-false}"
```

然后是一个将所有变量打印到屏幕的部分。我们跳过大部分内容：

```bash
echo Starting Cassandra on ${CASSANDRA_LISTEN_ADDRESS}
echo CASSANDRA_CONF_DIR ${CASSANDRA_CONF_DIR}
echo CASSANDRA_CFG ${CASSANDRA_CFG}
echo CASSANDRA_AUTO_BOOTSTRAP ${CASSANDRA_AUTO_BOOTSTRAP}
...
```

下一部分非常重要。默认情况下，Cassandra 使用简单的 snitch（SimpleSnitch），它不了解机架和数据中心。当集群跨越多个数据中心和机架时，这并不是最优的。Cassandra 是机架感知和数据中心感知的，可以在保证冗余和高可用性的同时，适当限制跨数据中心的通信：

```bash
# if DC and RACK are set, use GossipingPropertyFileSnitch
if [[ $CASSANDRA_DC && $CASSANDRA_RACK ]]; then
    echo "dc=$CASSANDRA_DC" > $CASSANDRA_CONF_DIR/cassandra-rackdc.properties
    echo "rack=$CASSANDRA_RACK" >> $CASSANDRA_CONF_DIR/cassandra-rackdc.properties
    CASSANDRA_ENDPOINT_SNITCH="GossipingPropertyFileSnitch"
fi
```

内存管理也很重要，你可以控制最大堆大小，以确保 Cassandra 不会开始抖动和交换到磁盘：

```bash
if [ -n "$CASSANDRA_MAX_HEAP" ]; then
    sed -ri "s/^(#)?-Xmx[0-9]+.*/-Xmx$CASSANDRA_MAX_HEAP/" "$CASSANDRA_CONF_DIR/jvm.options"
    sed -ri "s/^(#)?-Xms[0-9]+.*/-Xms$CASSANDRA_MAX_HEAP/" "$CASSANDRA_CONF_DIR/jvm.options"
fi
if [ -n "$CASSANDRA_REPLACE_NODE" ]; then
    echo "-Dcassandra.replace_address=$CASSANDRA_REPLACE_NODE/" >> "$CASSANDRA_CONF_DIR/jvm.options"
fi
```

机架和数据中心信息存储在一个简单的 Java 属性文件中：

```bash
for rackdc in dc rack; do
    var="CASSANDRA_${rackdc^^}"
    val="${!var}"
    if [ "$val" ]; then
        sed -ri 's/^('"$rackdc"'=).*/\1 '"$val"'/' "$CASSANDRA_CONF_DIR/cassandra-rackdc.properties"
    fi
done
```

下一部分循环遍历所有之前定义的变量，在 `cassandra.yaml` 配置文件中找到对应的键并覆盖它们。这确保每个配置文件在启动 Cassandra 之前被即时定制：

```bash
for yaml in \
    broadcast_address \
    broadcast_rpc_address \
    cluster_name \
    disk_optimization_strategy \
    endpoint_snitch \
    listen_address \
    num_tokens \
    rpc_address \
    start_rpc \
    key_cache_size_in_mb \
    concurrent_reads \
    concurrent_writes \
    memtable_cleanup_threshold \
    memtable_allocation_type \
    memtable_flush_writers \
    concurrent_compactors \
    compaction_throughput_mb_per_sec \
    counter_cache_size_in_mb \
    internode_compression \
    endpoint_snitch \
    gc_warn_threshold_in_ms \
    listen_interface \
    rpc_interface \
    ; do
    var="CASSANDRA_${yaml^^}"
    val="${!var}"
    if [ "$val" ]; then
        sed -ri 's/^(# )?('"$yaml"':).*/\2 '"$val"'/' "$CASSANDRA_CFG"
    fi
done
echo "auto_bootstrap: ${CASSANDRA_AUTO_BOOTSTRAP}" >> $CASSANDRA_CFG
```

下一部分全部关于设置种子或种子提供者，具体取决于部署方式（是否使用 StatefulSet）。这里有一个小技巧：第一个 Pod 将自己引导为种子节点：

```bash
# set the seed to itself.
# This is only for the first pod, otherwise
# it will be able to get seeds from the seed provider

if [[ $CASSANDRA_SEEDS == 'false' ]]; then
    sed -ri 's/- seeds:.*/- seeds: "'"$POD_IP"'"/' $CASSANDRA_CFG
else # if we have seeds set them.
    # Probably StatefulSet
    sed -ri 's/- seeds:.*/- seeds: "'"$CASSANDRA_SEEDS"'"/' $CASSANDRA_CFG
fi
sed -ri 's/- class_name: SEED_PROVIDER/- class_name: '"$CASSANDRA_SEED_PROVIDER"'/' $CASSANDRA_CFG
```

以下部分设置了远程管理和 JMX 监控的各种选项。在复杂的分布式系统中，拥有合适的管理工具至关重要。Cassandra 对普遍存在的 JMX 标准提供了深度支持：

```bash
# send gc to stdout
if [[ $CASSANDRA_GC_STDOUT == 'true' ]]; then
    sed -ri 's/ -Xloggc:\/var\/log\/cassandra\/gc\.log//' $CASSANDRA_CONF_DIR/cassandra-env.sh
fi
# enable RMI and JMX to work on one port
echo "JVM_OPTS=\"\$JVM_OPTS -Djava.rmi.server.hostname=$POD_IP\"" >> $CASSANDRA_CONF_DIR/cassandra-env.sh
# getting WARNING messages with Migration Service
echo "-Dcassandra.migration_task_wait_in_seconds=${CASSANDRA_MIGRATION_WAIT}" >> $CASSANDRA_CONF_DIR/jvm.options
echo "-Dcassandra.ring_delay_ms=${CASSANDRA_RING_DELAY}" >> $CASSANDRA_CONF_DIR/jvm.options
if [[ $CASSANDRA_OPEN_JMX == 'true' ]]; then
    export LOCAL_JMX=no
    sed -ri 's/ -Dcom\.sun\.management\.jmxremote\.authenticate=true/ -Dcom\.sun\.management\.jmxremote\.authenticate=false/' $CASSANDRA_CONF_DIR/cassandra-env.sh
    sed -ri 's/ -Dcom\.sun\.management\.jmxremote\.password\.file=\/etc\/cassandra\/jmxremote\.password//' $CASSANDRA_CONF_DIR/cassandra-env.sh
fi
```

最后，它保护数据目录，确保只有 Cassandra 用户能访问，设置 CLASSPATH 为 Cassandra JAR 文件，并以 Cassandra 用户身份在前台（非守护进程模式）启动 Cassandra：

```bash
chmod 700 "${CASSANDRA_DATA}"
chown -c -R cassandra "${CASSANDRA_DATA}" "${CASSANDRA_CONF_DIR}"

export CLASSPATH=/kubernetes-cassandra.jar
su cassandra -c "$CASSANDRA_HOME/bin/cassandra -f"
```

## 连接 Kubernetes 与 Cassandra

连接 Kubernetes 和 Cassandra 需要一些工作，因为 Cassandra 被设计得非常自给自足，但我们希望在适当的时机让它接入 Kubernetes，以提供诸如自动重启故障节点、监控、分配 Cassandra Pod 以及将 Cassandra Pod 与其他 Pod 并排提供统一视图等能力。

Cassandra 是一个复杂的系统，有许多控制旋钮。它带有一个 `cassandra.yaml` 配置文件，你可以用环境变量覆盖所有选项。

### 深入 Cassandra 配置文件

有两个设置特别相关：种子提供者（seed provider）和 snitch。种子提供者负责发布集群中节点的 IP 地址列表（种子）。每个启动运行的节点连接到种子节点（通常至少三个），如果成功到达其中一个，它们立即交换关于集群中所有节点的信息。这些信息随着节点之间的 Gossip 不断更新。

`cassandra.yaml` 中配置的默认种子提供者只是一个静态的 IP 地址列表，在这个例子中只有回环接口：

```yaml
# any class that implements the SeedProvider interface and has a
# constructor that takes a Map<String, String> of parameters will do.
seed_provider:
    # Addresses of hosts that are deemed contact points.
    # Cassandra nodes use this list of hosts to find each other and learn
    # the topology of the ring. You must change this if you are running
    # multiple nodes!
    #- class_name: io.k8s.cassandra.KubernetesSeedProvider
    - class_name: SEED_PROVIDER
      parameters:
          # seeds is actually a comma-delimited list of addresses.
          # Ex: "<ip1>,<ip2>,<ip3>"
          - seeds: "127.0.0.1"
```

另一个重要的设置是 snitch。它有两个角色：

- Cassandra 利用 snitch 来获取对网络拓扑的深入洞察，从而能够有效地路由请求。
- Cassandra 利用这些知识来战略性地在集群中分布副本，以降低关联故障的风险。为此，Cassandra 将机器组织到数据中心和机架中，确保副本不会集中在一个机架上，即使这不一定对应物理位置。

Cassandra 预装了几个 snitch 类，但它们都不具备 Kubernetes 感知能力。默认是 `SimpleSnitch`，但可以被覆盖：

```yaml
# You can use a custom Snitch by setting this to the full class
# name of the snitch, which will be assumed to be on your classpath.
endpoint_snitch: SimpleSnitch
```

其他 snitch 包括：

- GossipingPropertyFileSnitch
- PropertyFileSnitch
- Ec2Snitch
- Ec2MultiRegionSnitch
- RackInferringSnitch

### 自定义种子提供者

当 Cassandra 节点作为 Pod 运行在 Kubernetes 中时，Kubernetes 可能会移动 Pod，包括种子节点。为了适应这一点，Cassandra 种子提供者需要与 Kubernetes API 服务器交互。

以下来自自定义 `KubernetesSeedProvider`（一个实现了 Cassandra SeedProvider API 的 Java 类）的简短代码片段：

```java
public class KubernetesSeedProvider implements SeedProvider {
    ...
    /**
     * Call Kubernetes API to collect a list of seed providers
     *
     * @return list of seed providers
     */
    public List<InetAddress> getSeeds() {
        GoInterface go = (GoInterface) Native.loadLibrary("cassandra-seed.so",
            GoInterface.class);
        String service = getEnvOrDefault("CASSANDRA_SERVICE", "cassandra");
        String namespace = getEnvOrDefault("POD_NAMESPACE", "default");
        String initialSeeds = getEnvOrDefault("CASSANDRA_SEEDS", "");
        if ("".equals(initialSeeds)) {
            initialSeeds = getEnvOrDefault("POD_IP", "");
        }

        String seedSizeVar = getEnvOrDefault("CASSANDRA_SERVICE_NUM_SEEDS", "8");
        Integer seedSize = Integer.valueOf(seedSizeVar);
        String data = go.GetEndpoints(namespace, service, initialSeeds);
        ObjectMapper mapper = new ObjectMapper();
        try {
            Endpoints endpoints = mapper.readValue(data, Endpoints.class);
            logger.info("cassandra seeds: {}", endpoints.ips.toString());
            return Collections.unmodifiableList(endpoints.ips);
        } catch (IOException e) {
            // This should not happen
            logger.error("unexpected error building cassandra seeds: {}",
                e.getMessage());
            return Collections.emptyList();
        }
    }
}
```

### 创建 Cassandra 无头服务

无头服务的作用是让 Kubernetes 集群中的客户端通过标准的 Kubernetes Service 连接到 Cassandra 集群，而无需跟踪节点的网络标识或在所有节点前放置专用的负载均衡器。Kubernetes 通过其 Service 机制开箱即用地提供了这一切。

以下是 Service 清单：

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: cassandra
  name: cassandra
spec:
  clusterIP: None
  ports:
  - port: 9042
  selector:
    app: cassandra
```

`app: cassandra` 标签将分组所有参与此 Service 的 Pod。Kubernetes 将创建端点记录，DNS 将返回一条记录用于发现。`clusterIP` 为 `None`，意味着该服务是无头的，Kubernetes 不会执行任何负载均衡或代理。这很重要，因为 Cassandra 节点之间直接进行通信。

端口 9042 由 Cassandra 用于提供 CQL 请求服务。这些请求可以是查询、插入/更新（在 Cassandra 中始终是 upsert）或删除。

### 使用 StatefulSet 创建 Cassandra 集群

声明一个 StatefulSet 并非易事。它可以说是最复杂的 Kubernetes 资源。它包含许多活动部件：标准元数据、StatefulSet 规约、Pod 模板（通常本身也很复杂）以及卷声明模板。

### 剖析 StatefulSet YAML 文件

让我们有条不紊地分析这个声明了一个三节点 Cassandra 集群的 StatefulSet YAML 文件示例。

以下是基本元数据。注意 `apiVersion` 字符串为 `apps/v1`（StatefulSet 在 Kubernetes 1.9 中正式可用）：

```yaml
apiVersion: "apps/v1"
kind: StatefulSet
metadata:
  name: cassandra
  labels:
    app: cassandra
```

StatefulSet 规约定义了无头服务的名称、标签选择器（`app: cassandra`）、StatefulSet 中有多少个 Pod，以及 Pod 模板（稍后解释）。`replicas` 字段指定了 StatefulSet 中的 Pod 数量：

```yaml
spec:
  serviceName: cassandra
  replicas: 3
  selector:
    matchLabels:
      app: cassandra
  template:
    ...
```

对 Pod 使用"副本"（replicas）这个术语是一个不太好的选择，因为这些 Pod 并不是彼此的副本。它们共享同一个 Pod 模板，但拥有唯一的标识，并且通常负责状态的不同子集。这在 Cassandra 的上下文中更加令人困惑，因为 Cassandra 也使用相同的术语"副本"来指代那些冗余复制状态某个子集的节点组（但它们并不完全相同，因为每个节点还可以管理额外的状态）。

我曾在 Kubernetes 项目中提交了一个 GitHub issue，建议将这个术语从 replicas 改为 members：
https://github.com/kubernetes/kubernetes.github.io/issues/2103

Pod 模板包含一个基于自定义 Cassandra 镜像的容器。它还设置了终止宽限期为 30 分钟。这意味着当 Kubernetes 需要终止 Pod 时，它会向容器发送 SIGTERM 信号通知它们应该退出，给它们一个优雅退出的机会。任何在宽限期内仍在运行的容器将被 SIGKILL 杀死。

以下是带有 `app: cassandra` 标签的 Pod 模板：

```yaml
template:
  metadata:
    labels:
      app: cassandra
  spec:
    terminationGracePeriodSeconds: 1800
    containers:
    ...
```

容器部分包含多个重要部分。它以名称和我们之前看过的镜像开始：

```yaml
    containers:
    - name: cassandra
      image: gcr.io/google-samples/cassandra:v14
      imagePullPolicy: Always
```

然后，它定义了 Cassandra 节点进行外部和内部通信所需的多个容器端口：

```yaml
      ports:
      - containerPort: 7000
        name: intra-node
      - containerPort: 7001
        name: tls-intra-node
      - containerPort: 7199
        name: jmx
      - containerPort: 9042
        name: cql
```

`resources` 部分指定了容器所需的 CPU 和内存。这非常关键，因为存储管理层绝不应因 CPU 或内存不足而成为性能瓶颈。注意它遵循了请求和限制一致的最佳实践，以确保资源一旦分配就始终可用：

```yaml
      resources:
        limits:
          cpu: "500m"
          memory: 1Gi
        requests:
          cpu: "500m"
          memory: 1Gi
```

Cassandra 需要访问进程间通信（IPC），容器通过安全上下文的 capabilities 请求此权限：

```yaml
      securityContext:
        capabilities:
          add:
          - IPC_LOCK
```

`lifecycle` 部分在容器需要关闭时运行 Cassandra 的 `nodetool drain` 命令，以确保节点上的数据传输到 Cassandra 集群中的其他节点。这就是为什么需要 30 分钟宽限期的原因。节点排空涉及大量的数据移动：

```yaml
      lifecycle:
        preStop:
          exec:
            command:
            - /bin/sh
            - -c
            - nodetool drain
```

`env` 部分指定了将在容器内可用的环境变量。以下是必要变量的部分列表。`CASSANDRA_SEEDS` 变量被设置为无头服务，以便 Cassandra 节点在启动时可以与种子节点通信并发现整个集群。注意在此配置中，我们没有使用特殊的 Kubernetes 种子提供者。`POD_IP` 很有趣，因为它利用 Downward API 通过 `status.podIP` 的字段引用来填充其值：

```yaml
      env:
      - name: MAX_HEAP_SIZE
        value: 512M
      - name: HEAP_NEWSIZE
        value: 100M
      - name: CASSANDRA_SEEDS
        value: "cassandra-0.cassandra.default.svc.cluster.local"
      - name: CASSANDRA_CLUSTER_NAME
        value: "K8Demo"
      - name: CASSANDRA_DC
        value: "DC1-K8Demo"
      - name: CASSANDRA_RACK
        value: "Rack1-K8Demo"
      - name: CASSANDRA_SEED_PROVIDER
        value: io.k8s.cassandra.KubernetesSeedProvider
      - name: POD_IP
        valueFrom:
          fieldRef:
            fieldPath: status.podIP
```

就绪探测（readinessProbe）确保在节点实际准备好提供服务之前，不会向其发送请求。`ready-probe.sh` 脚本利用了 Cassandra 的 `nodetool status` 命令：

```yaml
      readinessProbe:
        exec:
          command:
          - /bin/bash
          - -c
          - /ready-probe.sh
        initialDelaySeconds: 15
        timeoutSeconds: 5
```

容器规约的最后一部分是卷挂载，它必须与持久卷声明匹配：

```yaml
      volumeMounts:
      - name: cassandra-data
        mountPath: /var/lib/cassandra
```

容器规约到此结束。最后一部分是卷声明模板。在这个例子中，使用了动态配置。强烈建议为 Cassandra 存储使用 SSD 驱动器，尤其是其日志。本示例中请求的存储大小为 1 GiB。我通过实验发现，1-2 TB 对单个 Cassandra 节点来说是理想的。原因是 Cassandra 在后台进行了大量的数据混洗，包括压缩和重新平衡数据。如果一个节点离开集群或者一个新节点加入集群，你必须等待数据被正确重新平衡，然后离开节点的数据才能被正确重新分配，或者新节点才能被填充。

注意，Cassandra 需要大量的磁盘空间来完成所有这些混洗操作。建议保留 50% 的空闲磁盘空间。当你考虑到还需要复制（通常是 3 倍）时，所需的存储空间可能达到数据大小的 6 倍。如果你比较激进，30% 的空闲空间也可以应付，也许根据你的用例只使用 2 倍复制。但不要让单个节点的空闲磁盘空间低于 10%。我通过惨痛的经历学到，如果低于 10%，Cassandra 就会卡住，如果不采取极端措施，将无法压缩和重新平衡这些节点。

在这种情况下，必须定义名为 `fast` 的存储类。通常，对于 Cassandra，你需要一个特殊的存储类，而不能使用 Kubernetes 集群的默认存储类。

访问模式当然是 `ReadWriteOnce`：

```yaml
  volumeClaimTemplates:
  - metadata:
      name: cassandra-data
    spec:
      storageClassName: fast
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 1Gi
```

![图 7.2: StatefulSet 时序图](images/ch07-fig02.png)

部署 StatefulSet 时，Kubernetes 按照 Pod 的索引编号按顺序创建它们。在扩缩容时，它也按顺序进行。对于 Cassandra 来说，这并不重要，因为它可以处理任何顺序加入或离开集群的节点。当一个 Cassandra Pod 被销毁（非优雅地）时，持久卷会保留。如果之后创建了具有相同索引的 Pod，原始的持久卷将被挂载到该 Pod 中。这种特定 Pod 与其存储之间的稳定连接使得 Cassandra 能够正确地管理状态。

## 总结

在本章中，我们涵盖了有状态应用的主题以及如何将它们与 Kubernetes 集成。我们发现有状态应用是复杂的，并考虑了多种发现机制，如 DNS 和环境变量。我们还讨论了几种状态管理解决方案，如内存冗余存储、本地存储和持久化存储。本章的大部分内容围绕使用 StatefulSet 在 Kubernetes 集群内部署 Cassandra 集群展开。我们深入到底层细节，以真正理解将像 Cassandra 这样复杂的第三方分布式系统集成到 Kubernetes 中需要什么。至此，你应该对有状态应用以及如何在基于 Kubernetes 的系统中应用它们有了透彻的理解。你掌握了适用于多种用例的多种方法，也许你还学到了一些关于 Cassandra 的知识。

在下一章中，我们将继续旅程，探索可伸缩性这一重要主题，特别是自动伸缩，以及如何在集群动态增长时进行部署和实时升级更新。这些问题非常复杂，尤其是当集群上运行着有状态应用时。
