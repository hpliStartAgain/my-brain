---
title: "Mastering Kubernetes"
date: 2026-05-13
tags: [Kubernetes, 云原生, 容器, 索引]
aliases: [Mastering Kubernetes, Kubernetes 精通]
description: "《Mastering Kubernetes》Fourth Edition by Gigi Sayfan (2023, Packt) 完整中文翻译版"
---

# Mastering Kubernetes（第四版）

> [!info] 关于本书
> **原版**：*Mastering Kubernetes* Fourth Edition by Gigi Sayfan (2023, Packt Publishing)
> **ISBN**：978-1-80461-139-5
> **翻译方式**：AI 辅助逐段完整翻译，PDF 图片提取 + Obsidian 相对路径引用

## 全书目录

| 章节 | 英文原标题 | 词数 | 图片 |
|------|-----------|------|------|
| [[译书/云原生/Mastering-Kubernetes/00-前言]] | Preface | 2,499 | - |
| [[01-理解Kubernetes架构]] | Understanding Kubernetes Architecture | 7,501 | 3 |
| [[02-创建Kubernetes集群]] | Creating Kubernetes Clusters | 9,900 | 6 |
| [[03-高可用性与可靠性]] | High Availability and Reliability | 11,216 | 9 |
| [[04-保护Kubernetes安全]] | Securing Kubernetes | 11,069 | 5 |
| [[05-实战中使用Kubernetes资源]] | Using Kubernetes Resources in Practice | 12,302 | - |
| [[06-管理存储]] | Managing Storage | 10,292 | 5 |
| [[07-在Kubernetes上运行有状态应用]] | Running Stateful Applications with Kubernetes | 6,093 | 2 |
| [[08-部署与更新应用]] | Deploying and Updating Applications | 8,851 | 6 |
| [[09-打包应用]] | Packaging Applications | 7,452 | 3 |
| [[10-探索Kubernetes网络]] | Exploring Kubernetes Networking | 11,333 | 11 |
| [[11-在多集群上运行Kubernetes]] | Running Kubernetes on Multiple Clusters | 6,734 | 12 |
| [[12-Kubernetes上的无服务器计算]] | Serverless Computing on Kubernetes | 7,800 | 16 |
| [[13-监控Kubernetes集群]] | Monitoring Kubernetes Clusters | 8,752 | 15 |
| [[14-使用服务网格]] | Utilizing Service Meshes | 6,652 | 13 |
| [[15-扩展Kubernetes]] | Extending Kubernetes | 12,326 | 10 |
| [[16-治理Kubernetes]] | Governing Kubernetes | 11,115 | 7 |
| [[17-在生产环境中运行Kubernetes]] | Running Kubernetes in Production | 18,201 | 4 |
| [[18-Kubernetes的未来]] | The Future of Kubernetes | 9,688 | 7 |

## 各章概要

### [[01-理解Kubernetes架构]]
容器编排概念 → Kubernetes 核心概念（Pod/Node/Service/Label/Namespace 等）→ 分布式系统设计模式（Sidecar/Ambassador/Adapter）→ Kubernetes API 与组件（控制平面/节点组件）→ 容器运行时（CRI/Docker/containerd/CRI-O）

### [[02-创建Kubernetes集群]]
Rancher Desktop → kubectl 与替代工具（K9S/KUI/Lens）→ Minikube 单节点集群 → KinD 多节点集群 → k3d → 云提供商集群（GCP/AWS/Azure/DO）→ 裸金属集群

### [[03-高可用性与可靠性]]
高可用概念 → 控制平面 HA（etcd/API Server 冗余）→ 节点 HA → 基础设施 HA（存储/网络）→ 灾难恢复与备份 → 集群升级策略 → 可靠性测试（混沌工程）

### [[04-保护Kubernetes安全]]
安全挑战概述 → 认证（X.509/OIDC/Webhook）→ 授权（RBAC/ABAC/Node）→ 准入控制 → 网络策略 → Pod 安全 → Secret 管理 → 镜像安全 → 审计日志

### [[05-实战中使用Kubernetes资源]]
大规模平台设计 → 命名空间策略 → ResourceQuota/LimitRange → Pod 设计模式 → 调度策略 → 资源请求与限制 → HPA/VPA 自动扩缩

### [[06-管理存储]]
持久卷（PV/PVC）→ 静态/动态制备 → 存储类 → 本地卷/HostPath → CSI 驱动 → 公有云存储（AWS EBS/GCE PD/Azure Disk）→ GlusterFS/Ceph/Rook → 快照与克隆

### [[07-在Kubernetes上运行有状态应用]]
有状态 vs 无状态 → ConfigMap/Secret → StatefulSet → DaemonSet → PVC 模板 → Cassandra on Kubernetes 完整示例

### [[08-部署与更新应用]]
Deployment → ReplicaSet → Rolling Update → Blue-Green/Canary 部署 → Helm Chart 管理 → GitOps（Flux/Argo CD）

### [[09-打包应用]]
Helm 架构与 Chart 结构 → 模板化 → Kustomize → Jsonnet → 打包最佳实践

### [[10-探索Kubernetes网络]]
Kubernetes 网络模型 → Service（ClusterIP/NodePort/LoadBalancer）→ Ingress → Gateway API → CNI 插件 → eBPF 网络 → 网络策略实战

### [[11-在多集群上运行Kubernetes]]
伸展集群 vs 多集群 → Cluster API (CAPI) → Karmada → Clusternet → Clusterpedia → OCM → Virtual Kubelet → Gardener

### [[12-Kubernetes上的无服务器计算]]
无服务器概念 → Knative（Serving/Eventing）→ OpenFaaS → Kubeless → Fission → 对比与选型

### [[13-监控Kubernetes集群]]
Prometheus → Grafana → Alertmanager → Kubernetes Metrics API → 日志聚合（EFK/Loki）→ OpenTelemetry → 集群健康检查

### [[14-使用服务网格]]
服务网格概念 → Istio 架构 → Envoy Sidecar → 流量管理（VirtualService/DestinationRule）→ 安全（mTLS）→ 可观测性（Kiali/Jaeger）

### [[15-扩展Kubernetes]]
扩展点概览 → CRD → Operator 模式 → 聚合 API 层 → 调度器扩展 → CNI/CSI/CRI 插件 → 准入 Webhook

### [[16-治理Kubernetes]]
治理概念 → OPA/Gatekeeper → Kyverno → 策略即代码 → 合规性检查 → 成本管理 → FinOps

### [[17-在生产环境中运行Kubernetes]]
生产就绪检查清单 → 集群生命周期管理 → 备份与恢复 → 灾难恢复 → 证书管理 → 升级策略 → 故障排除 → 性能调优

### [[18-Kubernetes的未来]]
云原生趋势 → WebAssembly on Kubernetes → 边缘计算 → AI/ML 工作负载 → 多云/混合云 → 可持续计算

## 技术栈速览

- **编排**：Kubernetes、Helm、Kustomize、Argo CD、Flux
- **网络**：CNI（Calico/Cilium/Flannel）、Service Mesh（Istio/Linkerd）、Ingress/Gateway API、eBPF
- **存储**：CSI、Rook/Ceph、GlusterFS、Longhorn
- **监控**：Prometheus、Grafana、Alertmanager、Loki、OpenTelemetry、Jaeger
- **安全**：RBAC、OPA/Gatekeeper、Kyverno、mTLS、Pod Security
- **无服务器**：Knative、OpenFaaS
- **多集群**：Cluster API、Karmada、Gardener
