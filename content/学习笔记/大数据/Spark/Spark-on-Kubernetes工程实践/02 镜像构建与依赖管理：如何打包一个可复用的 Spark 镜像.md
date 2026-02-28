---
title: "镜像构建与依赖管理：如何打包一个可复用的 Spark 镜像"
date: 2026-02-28
tags: [Spark, Kubernetes, Docker, 镜像构建, 依赖管理, Python, JAR, 镜像分层, 云原生]
aliases: []
---

# 02 镜像构建与依赖管理：如何打包一个可复用的 Spark 镜像

## 摘要

Spark on Kubernetes 将 Driver 和 Executor 运行在容器中，这意味着所有的运行时依赖——JDK、Spark 发行包、业务 JAR、Python 环境、第三方库——都需要打包进 Docker 镜像，或在容器启动时动态注入。镜像构建策略的优劣直接影响：**镜像大小**（镜像越大，Pull 越慢，节点磁盘压力越大）、**构建速度**（分层缓存利用率高则增量构建快）、**安全性**（基础镜像版本、CVE 漏洞）、**可维护性**（基础层与业务层分离，基础层升级不影响业务镜像）。本文从官方 Spark 基础镜像的结构出发，讲解生产级 Spark 镜像的三层分层设计（基础层/平台依赖层/业务层）、Python 依赖的多种管理方案（`requirements.txt`、`conda pack`、`venv archive`）、大 JAR 文件的镜像分层技巧（避免每次业务代码变更导致整个 JAR 层失效），以及私有镜像仓库的配置和镜像安全扫描的集成方案。

---

## 第 1 章 官方 Spark 基础镜像结构

### 1.1 官方镜像的构建工具

Spark 发行包（从 2.3 版本起）自带 `docker-image-tool.sh` 脚本，用于构建官方基础镜像：

```bash
# 在 Spark 发行包根目录执行
./bin/docker-image-tool.sh \
  -r my-registry.example.com/spark \  # 镜像仓库前缀
  -t 3.3.2 \                           # 镜像 Tag
  build                                # 构建镜像

# 构建结果：
#   my-registry.example.com/spark/spark:3.3.2         (JVM 版本)
#   my-registry.example.com/spark/spark-py:3.3.2      (含 Python3)
#   my-registry.example.com/spark/spark-r:3.3.2       (含 R)

# 推送到私有仓库
./bin/docker-image-tool.sh \
  -r my-registry.example.com/spark \
  -t 3.3.2 \
  push
```

### 1.2 官方镜像的目录结构

```dockerfile
# 官方 spark:3.3.2 镜像的核心内容
/opt/spark/                  # Spark 安装目录
  bin/                       # spark-submit, spark-shell 等
  sbin/                      # start/stop 脚本
  jars/                      # Spark 核心 JAR（约 300MB）
  conf/                      # 配置文件模板
  work/                      # 工作目录（Shuffle 文件默认位置）
  examples/                  # 示例代码

/opt/spark/kubernetes/       # K8s 相关脚本
  dockerfiles/               # 各 Python/R 版本的 Dockerfile
  tests/                     # 集成测试

/opt/entrypoint.sh           # 容器启动入口脚本
```

**`/opt/entrypoint.sh` 的作用**：根据环境变量（`SPARK_ROLE=driver` 或 `SPARK_ROLE=executor`）决定启动 Driver JVM 还是 Executor JVM。这是 Driver Pod 和 Executor Pod 使用同一个镜像的关键——通过环境变量区分角色。

### 1.3 官方镜像的不足

官方基础镜像提供了最小可运行的 Spark 环境，但生产使用通常需要额外的组件：

- 缺少业务 JAR 和第三方依赖
- 缺少 Hadoop 客户端（访问 HDFS 时需要 `hadoop-client` JAR 和 `core-site.xml`）
- Python 版本固定（官方镜像使用系统 Python，可能不符合业务要求）
- 缺少公司内部的 TrustStore（Kerberos keytab、SSL 证书）
- 镜像体积较大（约 600MB），包含很多 Spark 示例和不必要文件

---

## 第 2 章 三层分层设计：可复用镜像的架构原则

### 2.1 分层设计的动机

Docker 镜像构建基于**层（Layer）** 的增量机制：每个 `RUN`/`COPY`/`ADD` 指令创建一层，相同内容的层在不同镜像间**复用缓存**（Pull 时只拉取本地没有的层）。

分层策略的核心原则：**变化频率低的内容放在底层，变化频率高的内容放在顶层**。

```
变化频率（从低到高）：
  操作系统基础（Ubuntu/CentOS）← 几个月更新一次
  JDK 版本                    ← 几个月更新一次
  Spark 版本                  ← 几周更新一次
  Hadoop/S3 等平台依赖 JAR    ← 几周更新一次
  Python 基础库（numpy等）     ← 几天更新一次（依赖升级）
  业务 JAR（业务代码）         ← 每天多次更新（代码提交）
  Python 业务代码              ← 每天多次更新
```

按此原则，将镜像分为三层：

```
┌─────────────────────────────────┐
│  Layer 3：业务层                 │  ← 每次代码提交重建（小）
│  业务 JAR + Python 业务代码      │
├─────────────────────────────────┤
│  Layer 2：平台依赖层              │  ← 每周/每月重建（中）
│  Python 库 + Hadoop JAR + 配置  │
├─────────────────────────────────┤
│  Layer 1：基础层                 │  ← 很少重建（大）
│  Ubuntu + JDK + Spark 发行包    │
└─────────────────────────────────┘
```

**好处**：业务代码每天 10 次提交，每次只重建 Layer 3（几 MB），Layer 1+2 命中缓存，构建时间从 10 分钟降到 30 秒。

### 2.2 Layer 1：基础层 Dockerfile

```dockerfile
# spark-base:3.3.2-jdk11
# 变化频率：极低（Spark 大版本升级时更新）
FROM ubuntu:22.04

# 设置时区，避免交互式提示
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

# 安装 JDK 和基础工具
RUN apt-get update && apt-get install -y \
    openjdk-11-jdk-headless \
    curl \
    wget \
    procps \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# 下载并安装 Spark（使用国内镜像加速）
ENV SPARK_VERSION=3.3.2
ENV SPARK_HOME=/opt/spark

RUN wget -q https://archive.apache.org/dist/spark/spark-${SPARK_VERSION}/spark-${SPARK_VERSION}-bin-hadoop3.tgz \
    && tar -xzf spark-${SPARK_VERSION}-bin-hadoop3.tgz -C /opt \
    && mv /opt/spark-${SPARK_VERSION}-bin-hadoop3 ${SPARK_HOME} \
    && rm spark-${SPARK_VERSION}-bin-hadoop3.tgz \
    # 删除不需要的文件，减小镜像体积
    && rm -rf ${SPARK_HOME}/examples \
    && rm -rf ${SPARK_HOME}/data \
    && rm -rf ${SPARK_HOME}/python/test_support

ENV PATH="${SPARK_HOME}/bin:${PATH}"

# 复制官方 entrypoint 脚本
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR ${SPARK_HOME}
ENTRYPOINT ["/opt/entrypoint.sh"]
```

### 2.3 Layer 2：平台依赖层 Dockerfile

```dockerfile
# spark-platform:3.3.2-hadoop3.3-py310
# 变化频率：中（Hadoop 版本更新、平台依赖库升级时更新）
FROM my-registry/spark/spark-base:3.3.2-jdk11

# 安装 Python 3.10
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3.10-venv \
    python3-pip \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.10 1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYSPARK_PYTHON=python3

# 安装 Hadoop 客户端 JAR（访问 HDFS 所需）
RUN wget -q https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-client-api/3.3.4/hadoop-client-api-3.3.4.jar \
    -O ${SPARK_HOME}/jars/hadoop-client-api-3.3.4.jar

# 安装 AWS S3 支持（如果需要访问 S3）
RUN wget -q https://repo1.maven.org/maven2/org/apache/hadoop/hadoop-aws/3.3.4/hadoop-aws-3.3.4.jar \
    -O ${SPARK_HOME}/jars/hadoop-aws-3.3.4.jar && \
    wget -q https://repo1.maven.org/maven2/com/amazonaws/aws-java-sdk-bundle/1.12.367/aws-java-sdk-bundle-1.12.367.jar \
    -O ${SPARK_HOME}/jars/aws-java-sdk-bundle-1.12.367.jar

# 安装常用 Python 科学计算库（变化频率中等）
# 使用 requirements 文件便于版本管理
COPY requirements-platform.txt /tmp/requirements-platform.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements-platform.txt

# 复制 Hadoop 配置（core-site.xml, hdfs-site.xml）
COPY hadoop-conf/ ${SPARK_HOME}/conf/

# 公司内部 TrustStore（如 Kerberos keytab）
COPY company-truststore.jks /opt/security/
```

### 2.4 Layer 3：业务层 Dockerfile

```dockerfile
# spark-app:my-etl-2.1.0
# 变化频率：高（每次代码提交）
FROM my-registry/spark/spark-platform:3.3.2-hadoop3.3-py310

# 业务 Python 代码（小文件，构建快）
COPY src/ /app/src/

# 业务 JAR（关键：分拆大 JAR 与小 JAR）
# 依赖 JAR（变化少）→ 放在更低的层
COPY lib/dependencies.jar ${SPARK_HOME}/jars/my-etl-dependencies.jar

# 业务代码 JAR（变化频繁）→ 放在最顶层
COPY target/my-etl-2.1.0.jar ${SPARK_HOME}/jars/my-etl.jar

ENV PYTHONPATH=/app/src:${PYTHONPATH}
```

---

## 第 3 章 Python 依赖管理的三种方案

### 3.1 方案一：requirements.txt 内嵌镜像（简单场景推荐）

将 Python 依赖直接安装到镜像中，适合依赖数量少（< 50 个包）且版本稳定的场景：

```dockerfile
# 在 Layer 2 中安装
COPY requirements-platform.txt /tmp/
RUN pip3 install --no-cache-dir -r /tmp/requirements-platform.txt

# requirements-platform.txt 内容示例：
# numpy==1.24.3
# pandas==2.0.1
# pyarrow==12.0.0
# scikit-learn==1.3.0
# requests==2.31.0
```

**缺点**：依赖变更时需要重建镜像（即使业务代码没变）。

### 3.2 方案二：conda-pack 打包虚拟环境（复杂 Python 环境推荐）

`conda-pack` 将整个 conda 虚拟环境打包成一个压缩包（`.tar.gz`），在容器启动时解压使用。适合有复杂依赖树（包含 C 扩展、CUDA 等）的 ML 工作负载：

```bash
# 1. 在 CI 环境中创建并打包 conda 环境
conda create -n spark-env python=3.10
conda activate spark-env
pip install -r requirements.txt
conda pack -n spark-env -o spark-env.tar.gz

# 2. 将打包的环境上传到 S3/HDFS
aws s3 cp spark-env.tar.gz s3://bucket/envs/spark-env-v1.tar.gz
```

```python
# 3. Spark 启动时通过 --archives 注入环境
spark-submit \
  --archives s3://bucket/envs/spark-env-v1.tar.gz#environment \
  --conf spark.yarn.appMasterEnv.PYSPARK_PYTHON=./environment/bin/python \
  --conf spark.executorEnv.PYSPARK_PYTHON=./environment/bin/python \
  my_app.py
```

**优点**：Python 环境与 Docker 镜像解耦，更新依赖只需重传压缩包，不需要重建镜像。

### 3.3 方案三：venv + 镜像（中等场景）

在 Dockerfile 中创建独立的虚拟环境（Python venv），隔离业务依赖与系统 Python：

```dockerfile
# 创建 venv
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# 安装依赖到 venv（不污染系统 Python）
COPY requirements-app.txt /tmp/
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-app.txt

ENV PYSPARK_PYTHON=/opt/venv/bin/python3
```

---

## 第 4 章 大 JAR 的分层缓存优化

### 4.1 "胖 JAR"（Fat JAR / Uber JAR）的镜像问题

Maven Shade Plugin 或 Gradle Shadow Plugin 通常将所有依赖打包到一个"胖 JAR"（如 `my-etl-all-2.1.0.jar`，大小 500MB）。

问题：每次代码提交（哪怕只改了一行注释），整个 500MB 的 JAR 文件变更 → Docker 镜像的这一层失效 → 每次都要推送 500MB 新层。

### 4.2 JAR 分拆方案

将"胖 JAR"拆分为：
- **依赖 JAR**（`dependencies.jar`，包含所有第三方库）：几乎不变，变更频率低
- **代码 JAR**（`app.jar`，只包含业务代码）：频繁变更，但体积小（通常 < 5MB）

```xml
<!-- Maven pom.xml 配置：分离依赖 JAR 和代码 JAR -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-dependency-plugin</artifactId>
    <executions>
        <execution>
            <id>copy-dependencies</id>
            <goals><goal>copy-dependencies</goal></goals>
            <configuration>
                <!-- 依赖 JAR 输出到独立目录 -->
                <outputDirectory>${project.build.directory}/lib</outputDirectory>
                <excludeArtifactIds>my-app</excludeArtifactIds>
            </configuration>
        </execution>
    </executions>
</plugin>
```

```dockerfile
# Dockerfile 中分两层 COPY（利用层缓存）
# 依赖 JAR（变化少）→ 构建时命中缓存（只要依赖不变）
COPY target/lib/ ${SPARK_HOME}/jars/app-deps/

# 代码 JAR（变化频繁）→ 只有这一层失效
COPY target/my-etl.jar ${SPARK_HOME}/jars/my-etl.jar
```

**效果**：将每次构建推送 500MB 降低到推送 5MB（只有代码 JAR 层失效），构建速度提升 100 倍。

---

## 第 5 章 私有镜像仓库配置

### 5.1 Spark on K8s 拉取私有镜像

```python
# spark-submit 时指定镜像和拉取密钥
spark-submit \
  --conf spark.kubernetes.container.image=my-registry.example.com/spark/spark-app:2.1.0 \
  --conf spark.kubernetes.container.image.pullSecrets=registry-secret \
  --conf spark.kubernetes.container.image.pullPolicy=IfNotPresent \  # 本地有则不重拉
  ...
```

**创建镜像仓库的 Pull Secret**：

```bash
kubectl create secret docker-registry registry-secret \
  --docker-server=my-registry.example.com \
  --docker-username=spark-puller \
  --docker-password=<password> \
  --namespace=spark-ns
```

### 5.2 imagePullPolicy 的选择

| 值 | 行为 | 适用场景 |
|---|-----|---------|
| `Always` | 每次都从仓库拉取（即使本地有）| 开发调试（确保用最新镜像） |
| `IfNotPresent` | 本地有则直接用，无则拉取 | **生产推荐**（节省带宽，加速启动） |
| `Never` | 只用本地镜像，从不拉取 | 离线环境，或镜像已预热到所有节点 |

生产环境使用 `IfNotPresent`，配合**镜像 Tag 不可变原则**（每个版本对应唯一 Tag，禁止 `latest` Tag），确保同一 Tag 的镜像在所有节点上内容一致。

> [!warning] 生产避坑
> **严禁在生产中使用 `latest` Tag**。`IfNotPresent` + `latest` 的组合会导致不同节点上的 `latest` 镜像版本不一致——有的节点缓存了旧版 `latest`，有的节点缓存了新版，同一个 Spark Job 的不同 Executor Pod 可能运行在不同版本的镜像上，产生难以复现的 Bug。生产镜像 Tag 必须包含具体版本号（如 Git commit hash 或语义版本号）。

---

## 小结

生产 Spark 镜像构建的核心原则：

- **三层分离**：基础层（OS+JDK+Spark）/ 平台依赖层（Hadoop/Python库）/ 业务层（业务JAR+Python代码）；变化频率从低到高，充分利用 Docker 层缓存
- **JAR 分拆**：将胖 JAR 分拆为依赖 JAR（稳定）+ 代码 JAR（小且频繁变更），每次构建只重建代码 JAR 层
- **Python 依赖管理**：简单场景用 `requirements.txt` 内嵌镜像；复杂 ML 环境用 `conda-pack` + `--archives` 动态注入
- **imagePullPolicy=IfNotPresent + 不可变 Tag**：生产标准配置，节省带宽并保证版本一致性

第 03 篇深入 RBAC 与资源配额：Spark Driver Pod 需要哪些 K8s 权限（创建/删除 Executor Pod、Watch Pod 状态）、如何最小化 ServiceAccount 权限（最小权限原则）、ResourceQuota 和 LimitRange 如何防止单个作业耗尽命名空间资源。

---

## 参考资料

- Apache Spark 官方文档：Docker Images
- Spark `docker-image-tool.sh` 源码
- [Dockerfile Best Practices（Docker 官方）](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
- [conda-pack 文档](https://conda.github.io/conda-pack/)
