---
title: "安全加固：Secrets 管理、网络策略与镜像安全"
date: 2026-02-28
tags: [Kerberos, Kubernetes, NetworkPolicy, RBAC, Secrets, Spark, TLS, 安全, 最小权限, 镜像安全]
aliases: []
---

# 09 安全加固：Secrets 管理、网络策略与镜像安全

## 摘要

Spark on Kubernetes 的安全面涵盖三个层面：**凭据安全**（数据库密码、S3 密钥、Kerberos keytab 等敏感信息如何注入 Pod，避免明文写入镜像或 YAML）、**网络安全**（通过 NetworkPolicy 限制 Spark Pod 的出入口网络访问，防止 Executor 成为集群内部的跳板）、**镜像安全**（基础镜像的 CVE 漏洞扫描、镜像签名与准入控制，防止恶意镜像运行在集群中）。本文从每个安全问题的根源出发——为什么这个问题在 K8s 上存在、不解决会有什么后果——然后给出对应的工程解决方案，最终构建一个覆盖"凭据注入 → 网络隔离 → 镜像验证"全链路的 Spark on K8s 安全加固方案。

---

## 第 1 章 凭据安全：Secrets 管理

### 1.1 为什么不能把密码写在 YAML 或镜像里

**反面案例**：

```yaml
# ❌ 错误做法：明文密码写在 SparkApplication YAML 中
sparkConf:
  spark.hadoop.fs.s3a.access.key: "AKIAIOSFODNN7EXAMPLE"
  spark.hadoop.fs.s3a.secret.key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  spark.datasource.jdbc.password: "my-database-password-123"
```

这段 YAML 一旦提交到 Git 仓库（哪怕是 private repo），就永远留在 Git 历史中。任何能访问 Git 仓库的人都能看到这些密码。更糟糕的是，许多公司的 Git 仓库因安全配置不当而泄露。

**正确做法**：将敏感信息存储在 [[Kubernetes Secrets]] 中，Pod 通过环境变量或文件挂载获取，YAML 中只引用 Secret 的名称（不包含实际内容）。

### 1.2 K8s Secrets 的使用方式

**创建 Secret**：

```bash
# 创建包含 S3 密钥的 Secret
kubectl create secret generic spark-s3-credentials \
  --from-literal=access-key=AKIAIOSFODNN7EXAMPLE \
  --from-literal=secret-key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --namespace=spark-production

# 创建包含数据库密码的 Secret
kubectl create secret generic spark-db-credentials \
  --from-literal=jdbc-password=my-database-password-123 \
  --namespace=spark-production
```

**在 SparkApplication 中引用 Secret（环境变量方式）**：

```yaml
spec:
  driver:
    envSecretKeyRefs:
      AWS_ACCESS_KEY_ID:
        name: spark-s3-credentials
        key: access-key
      AWS_SECRET_ACCESS_KEY:
        name: spark-s3-credentials
        key: secret-key
      DB_PASSWORD:
        name: spark-db-credentials
        key: jdbc-password
  executor:
    envSecretKeyRefs:
      AWS_ACCESS_KEY_ID:
        name: spark-s3-credentials
        key: access-key
      AWS_SECRET_ACCESS_KEY:
        name: spark-s3-credentials
        key: secret-key
```

在 Spark 代码中通过环境变量读取：

```python
import os

# 不需要在代码中写密码，从环境变量读取
spark = SparkSession.builder \
    .config("spark.hadoop.fs.s3a.access.key", os.environ["AWS_ACCESS_KEY_ID"]) \
    .config("spark.hadoop.fs.s3a.secret.key", os.environ["AWS_SECRET_ACCESS_KEY"]) \
    .getOrCreate()
```

### 1.3 更安全的方案：IAM Roles for Service Accounts（IRSA）

环境变量注入 S3 密钥还有一个问题：密钥是静态的（长期有效），一旦泄露就需要立即轮换。更好的方案是使用云厂商的 IAM 角色绑定——让 K8s ServiceAccount 直接绑定 AWS IAM Role，Pod 启动时自动获取临时凭证（有效期 1 小时，自动续约）：

```bash
# 创建 IAM Role，允许 S3 访问
aws iam create-role --role-name SparkS3AccessRole ...

# 将 IAM Role 绑定到 K8s ServiceAccount（IRSA）
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace spark-production \
  --service-account spark-driver-sa \
  --role-arn arn:aws:iam::123456789012:role/SparkS3AccessRole
```

使用 IRSA 后，无需任何密钥——Executor/Driver Pod 以 `spark-driver-sa` 身份运行时，AWS SDK 自动获取临时 Token，透明地访问 S3。这是 AWS EKS 上 Spark on K8s 的**推荐凭证管理方式**。

### 1.4 Kerberos on K8s：最复杂的认证场景

连接企业内部 [[Hadoop HDFS]] 或 HiveServer2 时，通常需要 [[Kerberos]] 认证。Kerberos 认证的核心是 **keytab 文件**（包含服务账号的加密密钥）。

**Kerberos on K8s 的挑战**：

Kerberos 认证需要 kinit 命令定期刷新 Kerberos Ticket（TGT），默认 Ticket 有效期 10 小时。对于长时间运行的 Spark 作业（超过 10 小时），如果 TGT 过期，所有对 HDFS 的 I/O 操作会失败。

**解决方案：keytab 注入 + 自动续约**

```yaml
# 1. 将 keytab 存储在 K8s Secret 中
kubectl create secret generic kerberos-keytab \
  --from-file=spark.keytab=/path/to/spark.keytab \
  --namespace=spark-production

# 2. 在 SparkApplication 中挂载 keytab
spec:
  driver:
    secrets:
      - name: kerberos-keytab
        path: /etc/security/keytabs
        secretType: GKeytab  # Spark Operator 特殊类型

# 3. 配置 Spark 使用 keytab
sparkConf:
  spark.kerberos.principal: "spark@COMPANY.COM"
  spark.kerberos.keytab: "/etc/security/keytabs/spark.keytab"
  spark.kerberos.renewal.interval: "1h"   # 每小时自动 kinit 续约
```

Spark 内置了 Kerberos Ticket 的自动续约逻辑（`KerberosTokenProvider`），只要 keytab 文件有效，Spark 会在 TGT 过期前自动调用 `kinit` 获取新 Ticket，保证长时间作业的 HDFS 访问不中断。

> [!warning] 生产避坑
> **keytab 的文件权限**：keytab 文件包含服务账号的私钥，必须严格限制读取权限。K8s Secret 挂载的文件默认权限是 `0644`（所有用户可读），必须通过 `defaultMode: 0400` 限制为只有 Pod 运行用户可读：
> ```yaml
> volumes:
>   - name: kerberos-keytab
>     secret:
>       secretName: kerberos-keytab
>       defaultMode: 0400   # 只有 owner 可读
> ```

---

## 第 2 章 NetworkPolicy：网络访问隔离

### 2.1 为什么需要限制 Spark Pod 的网络

默认情况下，K8s 集群内所有 Pod 之间可以互相访问（Pod 网络是 flat 的）。这意味着：

- Spark Executor Pod 可以访问同一集群内的所有服务（数据库、Redis、其他微服务）
- 如果某个 Executor Pod 被攻击者利用（如通过恶意 UDF 代码执行），攻击者可以从 Executor 内部扫描并访问整个集群内网

**NetworkPolicy** 是 K8s 在 Pod 级别实现的网络防火墙规则，限制哪些 Pod 可以发起连接，哪些端口可以监听。

### 2.2 Spark Pod 的典型网络需求分析

```
Driver Pod 需要的网络访问：
  出站（Egress）：
    → K8s API Server（创建/监控 Executor Pod）
    → S3/OSS/HDFS（读写数据）
    → 数据库（如果作业需要 JDBC 连接）
    → Kafka（如果是流处理作业）
  入站（Ingress）：
    ← Executor Pod（心跳 + Task 结果，端口 7077/4040）
    ← 用户浏览器（Spark UI，端口 4040）

Executor Pod 需要的网络访问：
  出站（Egress）：
    → Driver Pod（注册 + 心跳 + Task 请求，端口 7077）
    → S3/OSS/HDFS（读写数据）
    → 其他 Executor Pod（Shuffle 数据传输，端口 7337）
  入站（Ingress）：
    ← Driver Pod（Task 分配，端口随机）
    ← 其他 Executor Pod（Shuffle 读取）
```

### 2.3 NetworkPolicy 配置

```yaml
# Driver Pod 的 NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: spark-driver-netpol
  namespace: spark-production
spec:
  podSelector:
    matchLabels:
      spark-role: driver      # 匹配所有 Driver Pod
  policyTypes:
    - Ingress
    - Egress

  ingress:
    # 允许 Executor Pod 连接 Driver（Spark RPC）
    - from:
        - podSelector:
            matchLabels:
              spark-role: executor
      ports:
        - port: 7077
        - port: 4040
    # 允许 Ingress Controller 转发 Spark UI 流量
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - port: 4040

  egress:
    # 允许访问 K8s API Server（用于管理 Executor Pod）
    - to:
        - ipBlock:
            cidr: 10.0.0.0/8    # K8s 集群内网 CIDR（包含 API Server）
      ports:
        - port: 6443            # K8s API Server HTTPS 端口
    # 允许访问 S3（HTTPS）
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443             # HTTPS（S3、OSS 等对象存储）
    # 允许访问 Kafka
    - to:
        - namespaceSelector:
            matchLabels:
              name: kafka-ns
      ports:
        - port: 9092
    # 允许 DNS 解析（必须！否则所有域名解析失败）
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - port: 53
          protocol: UDP

---
# Executor Pod 的 NetworkPolicy（更严格）
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: spark-executor-netpol
  namespace: spark-production
spec:
  podSelector:
    matchLabels:
      spark-role: executor
  policyTypes:
    - Ingress
    - Egress

  ingress:
    # 只允许 Driver 和其他 Executor 连接（Shuffle）
    - from:
        - podSelector:
            matchLabels:
              spark-role: driver
    - from:
        - podSelector:
            matchLabels:
              spark-role: executor

  egress:
    # 只允许连接 Driver、其他 Executor、S3 和 DNS
    - to:
        - podSelector:
            matchLabels:
              spark-role: driver
    - to:
        - podSelector:
            matchLabels:
              spark-role: executor
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443   # S3
    - to:
        - namespaceSelector:
            matchLabels:
              name: kube-system
      ports:
        - port: 53
          protocol: UDP
```

> [!warning] 生产避坑
> **DNS 规则不能忘**：NetworkPolicy 默认拒绝所有未明确允许的流量。如果 Egress 规则中没有放行 `kube-system` 命名空间的 UDP 53 端口（CoreDNS），Pod 内所有域名解析（如 `s3.amazonaws.com`、`kafka-broker:9092`）都会失败，Spark 作业启动时就会报 `UnknownHostException`。这是 NetworkPolicy 新手最常犯的错误。

---

## 第 3 章 镜像安全

### 3.1 基础镜像 CVE 扫描

每个 Docker 镜像都基于某个基础镜像（如 `ubuntu:22.04`），基础镜像中可能包含有已知安全漏洞（CVE，Common Vulnerabilities and Exposures）的系统库。定期扫描 Spark 镜像中的 CVE，及时更新有漏洞的库，是镜像安全的基础工作。

**主流镜像扫描工具**：

| 工具 | 类型 | 特点 |
|-----|-----|-----|
| Trivy（Aqua Security）| 开源 CLI/CI | 速度快，漏洞库完整，支持 K8s 集群扫描 |
| Grype（Anchore）| 开源 CLI | 与 Syft SBOM 集成，适合 GitOps 场景 |
| Snyk | 商业 SaaS | CI 集成好，PR 自动检测 |
| AWS ECR 扫描 | 云托管 | 推送镜像时自动扫描，结果在 ECR 控制台 |

**在 CI 流水线中集成 Trivy 扫描**：

```yaml
# GitHub Actions 中的镜像扫描步骤
- name: Scan Docker image for CVEs
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: my-registry/spark-app:${{ github.sha }}
    format: 'table'
    exit-code: '1'              # 发现高危漏洞时 CI 失败
    ignore-unfixed: true        # 只报告有修复版本的漏洞
    severity: 'HIGH,CRITICAL'   # 只关注高危和严重漏洞
```

### 3.2 镜像签名与准入控制

**镜像签名**：对构建好的镜像用私钥签名，K8s 集群在允许 Pod 创建时验证镜像签名——只有经过授权 CI 流水线签名的镜像才能运行，防止攻击者将恶意镜像推送到私有仓库后被使用。

**Cosign + Kyverno 的实现方案**：

```bash
# CI 流水线中：构建并签名镜像
docker build -t my-registry/spark-app:${COMMIT_SHA} .
docker push my-registry/spark-app:${COMMIT_SHA}

# 使用 Cosign 签名（私钥存储在 KMS）
cosign sign \
  --key awskms:///arn:aws:kms:us-east-1:123:key/abc \
  my-registry/spark-app:${COMMIT_SHA}
```

```yaml
# Kyverno ClusterPolicy：只允许已签名的镜像运行
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-spark-image-signatures
spec:
  validationFailureAction: enforce   # 未通过验证则拒绝 Pod 创建
  rules:
    - name: verify-spark-images
      match:
        resources:
          kinds: [Pod]
          namespaces: [spark-production, spark-staging]
      verifyImages:
        - imageReferences:
            - "my-registry/spark-app:*"   # 匹配所有 Spark 应用镜像
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/my-org/spark-jobs/.github/workflows/build.yml@*"
                    issuer: "https://token.actions.githubusercontent.com"
                    # 只接受来自 GitHub Actions 的签名（OIDC 签发）
```

**效果**：任何未经 CI 流水线签名的镜像（包括手动 `docker push` 的测试镜像）在 spark-production Namespace 中都无法创建 Pod，从根本上防止未审核的镜像进入生产环境。

### 3.3 Pod Security Standards：限制 Pod 的危险权限

K8s 1.23+ 提供了 **Pod Security Standards（PSS）**，通过 Namespace 的 `pod-security.kubernetes.io` 标签限制 Pod 的安全能力：

```bash
# 为 Spark Namespace 启用 Restricted 级别的 PSS
kubectl label namespace spark-production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted
```

**Restricted 级别** 禁止以下危险配置：
- `privileged: true`（特权容器）
- `hostNetwork: true`（使用宿主机网络）
- `hostPID: true`（访问宿主机进程）
- 以 root 用户运行（`runAsNonRoot` 必须为 true）
- 挂载宿主机路径（`hostPath` volumes）

Spark 作业通常不需要这些特权，启用 Restricted PSS 可以有效防止配置错误或恶意 YAML 部署特权 Pod。

---

## 小结

Spark on K8s 安全加固的三个层面：

**凭据安全**：
- K8s Secrets 存储敏感信息，Pod 通过环境变量引用，Git 仓库中只有 Secret 名称
- AWS EKS 上推荐 IRSA（IAM Roles for Service Accounts），无需静态密钥
- Kerberos keytab 通过 Secret 挂载 + Spark 自动续约机制，保障长时间作业的 HDFS 访问

**网络安全**：
- NetworkPolicy 白名单式管理：Driver 只与 Executor/API Server/数据源通信，Executor 只与 Driver/其他 Executor/数据源通信
- DNS 规则（UDP 53）是必须明确允许的，否则所有域名解析失败

**镜像安全**：
- CI 流水线集成 Trivy 扫描，高危 CVE 阻断构建
- Cosign 签名 + Kyverno 准入控制，只有授权签名的镜像才能运行
- Pod Security Standards Restricted 级别禁止特权配置

第 10 篇（收官）汇总故障排查手册：OOMKilled 分析方法、Executor 频繁丢失的根因定位、ImagePullBackOff 的排查链路，以及 Spark on K8s 与 YARN 模式的性能对比基准。

---

> [!note] 思考题
> 1. K8s Secrets 默认以 Base64 编码存储在 etcd 中，Base64 不是加密——任何有 etcd 访问权限的人都能轻松解码。在合规要求严格的场景（如金融行业），需要对 etcd 静态数据加密（Encryption at Rest）。除了 etcd 加密，在 Spark on K8s 场景下，凭据还可能在哪些环节暴露？（如环境变量日志、Spark UI、EventLog 文件等）
> 2. NetworkPolicy 可以限制 Spark Pod 只能与特定 IP 或 Pod 通信。但 Spark 的通信模式比较复杂：Driver 与所有 Executor 双向通信，Executor 之间在 Shuffle 阶段也需要直接通信。如何设计一个最小权限的 NetworkPolicy，既允许必要的 Spark 内部通信，又阻止 Spark Pod 访问集群内不相关的服务（如其他团队的数据库）？
> 3. 镜像安全扫描（如 Trivy、Snyk）可以发现已知的 CVE 漏洞。但 Spark 依赖的 JAR 生态系统庞大（Hadoop、Hive、Arrow 等），其中不可避免地包含有漏洞的传递依赖。在生产中，如何建立一套"漏洞可接受性"评估机制，避免因为修复低危漏洞而引入高风险的依赖升级？

## 参考资料

- Kubernetes 官方文档：Secrets
- Kubernetes 官方文档：Network Policies
- Kubernetes 官方文档：Pod Security Standards
- [Cosign 官方文档](https://docs.sigstore.dev/cosign/overview/)
- [Kyverno 官方文档](https://kyverno.io/docs/)
- [AWS IRSA 文档](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
