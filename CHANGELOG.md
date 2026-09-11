# CHANGELOG

本文件记录 my-brain 数字花园的重大内容变更。

## 2026-09-11

### 完成：K8s 网络原理与插件专栏全量重写（第二批 04-07 + 收官）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，完成 `content/云原生/Kubernetes/kubernetes网络原理与插件/` 专栏第二批重写并收官。第一批 01-03 已于 2026-09-10 完成（antigravity），本批由 devin 接手完成 04-07 与导览核验。

**本批成果**：

- `04 Calico深度解析`（615 行 / 12016 中文字）：纯三层路由理念、Felix iptables/ipset 投影、BIRD BGP、eBGP vs iBGP 选型、IPAM Block 亲和与借用、Typha 扇出、IPIP/VXLAN 封装、eBPF 数据面、calicoctl 排障
- `05 Cilium深度解析`（508 行 / 12049 中文字）：eBPF 前史与 verifier/tail call、TC/XDP Hook、Security Identity 模型、BPF Map、kube-proxy 替换、Hubble 可观测、Cluster Mesh、sidecar-free 之争
- `06 Service底层实现`（589 行 / 12013 中文字）：ClusterIP 虚地址本质、kube-proxy 四代演进（userspace→iptables→IPVS→nftables）、KUBE-SERVICES 三级链与概率均衡、conntrack 状态机与滚动更新竞态、externalTrafficPolicy 源 IP 保留、EndpointSlice 与拓扑感知、Service 排障决策树
- `07 NetworkPolicy与CoreDNS`（641 行 / 12005 中文字）：白名单模型与"并集而非优先级"叠加语义、选择器 AND/OR 陷阱、policyTypes 隐式陷阱、Calico ipset 链 vs Cilium Identity 双实现、AdminNetworkPolicy 分级治理、KubeDNS→CoreDNS 演进、插件链与 Corefile、ndots 放大效应推演、NodeLocal DNSCache、DNS 四层故障域、全专栏联合排障矩阵
- `00 专栏导览`：06/07 两行描述同步新稿内容，其余行核验准确

**统一验证结果**（8 个文件全部通过）：01-07 全部满足 12000+ 中文字 / 500+ 行；frontmatter（title/date/tags/aliases）完整；全部 34 个 Mermaid 图使用 Dracula 主题；摘要/参考资料/思考题结构齐全；全部 wiki 链接目标存在（修复旧稿 `[[服务网格]]`/`[[eBPF]]`/`[[云原生安全]]`/`[[Kubernetes集群监控]]` 4 处死链，改用真实存在的目标）。

## 2026-07-17

### 重写：K8s 架构深度剖析 00 专栏导览 + 统一验证

重写 `content/云原生/Kubernetes/Kubernetes架构深度剖析/00 专栏导览.md`，为 18 篇文章添加 wiki 链接，修正不匹配的文件名链接（08/12/14/15）。00 专栏导览是导航页，103 行 / 1689 中文字，不需要 12000 字标准。

**统一验证结果**（19 个文件全部通过）：
- 01-18 共 18 篇技术深度文章，全部满足 500+ 行 / 12000+ 中文字
- 00 专栏导览导航页，103 行 / 1689 中文字
- frontmatter 完整（title/date/tags/aliases）
- Mermaid 主题全部 Dracula
- code fence 全部平衡
- wiki 链接目标全部存在
- callout 语法正确
- 摘要、参考资料、思考题完整
- 无散文感叹号

### 重写：K8s 架构深度剖析 18 篇（弹性伸缩与多集群，收官之作）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/18 弹性伸缩与多集群：HPA VPA Cluster Autoscaler 与 KubeFed.md` 完全重写。原文章约 332 行 / 2527 中文字，重写后达 **583 行 / 12000 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：7 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：四种弹性伸缩机制（HPA 水平 Pod 伸缩/VPA 垂直 Pod 伸缩/Cluster Autoscaler 节点伸缩/KEDA 事件驱动伸缩，分层伸缩 Pod 级秒级/节点级分钟级/集群级天级，水平伸缩 vs 垂直伸缩，Pod 级 vs 节点级，KEDA 与 HPA 超集关系）、HPA（autoscaling/v2 多指标取最大值，副本数计算公式 ceil(当前×当前指标/目标指标)，使用率相对 requests 而非 limits，Pod 指标聚合保守计算，冷却期 downscale-stabilization 5 分钟防止震荡，sync-period 15 秒，扩容快缩容慢，minReplicas 与 maxReplicas，Pod 启动延迟过度扩容用 readiness probe 减少，指标缺失陷阱，指标类型 Resource/Pod/External 需 Prometheus Adapter）、VPA（三种模式 Auto 需重启 Pod/Recommender 只推荐/Initial 创建时设置，K8s 不支持修改运行中容器资源限制，与 HPA 冲突不能同时用于同资源，Recommender 基于历史但历史不代表未来需结合业务周期，VPA 调整 requests 影响 QoS 等级 Guaranteed/Burstable/BestEffort 影响驱逐优先级）、Cluster Autoscaler（Pod Pending 时调用云 API 加节点，节点组 Node Group 对应云厂商实例组 AWS ASG/GCP IG，扩容延迟 1-5 分钟，扩容上限节点组最大节点数，缩容标记低利用率节点驱逐并终止，缩容冷却期 10 分钟，Spot 实例成本低但可能被回收用 Spot 跑无状态不用 Spot 跑有状态，缩容障碍 local PV/nodeSelector 不可迁移 PDB 阻止驱逐）、KEDA（50+ 事件源 Kafka/Redis/Prometheus/云消息队列，缩到 0 无事件时不运行 Pod，KEDA 是 HPA 超集用 HPA 做实际伸缩，ScaledObject 适合长运行 ScaledJob 适合批处理，触发器 trigger 配置，冷启动延迟用 minReplicaCount=1 或优化镜像大小，Prometheus 触发器比 HPA 自定义指标更灵活）、多集群管理（动机地理分布/容灾/多租户强隔离/混合云/规模扩展单集群上限 5000 节点，工具 KubeFed 已停止维护/Cluster API 集群生命周期/Karmada 跨集群应用分发/Argo CD GitOps 多集群/Istio Multi-Cluster 跨集群服务网格，架构模式 Hub-Spoke/多集群 Service Mesh/GitOps 多集群，跨集群服务发现 Istio 服务注册表，跨集群容灾 DNS TTL 延迟用短 TTL 或全局 LB，容灾演练定期切换验证，数据同步异步复制 vs 同步复制）、弹性伸缩组合使用（HPA + Cluster Autoscaler 端到端弹性，KEDA + Cluster Autoscaler 事件驱动端到端弹性，弹性伸缩分层 Pod 级秒级/节点级分钟级/集群级天级，响应时间差异，成本与响应时间权衡预留资源）。

**格式验证**：frontmatter 完整、4 个 Mermaid 图使用 Dracula 主题、20 个 code fence 成对闭合、2 个 wiki 链接目标均存在（00 专栏导览）、8 个 Callout（warning/info/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 17 篇（集群可观测性与故障排查）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/17 集群可观测性与故障排查：监控、日志、追踪与诊断.md` 完全重写。原文章约 278 行 / 1806 中文字，重写后达 **551 行 / 12009 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：5 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：可观测性三大支柱（监控指标/日志事件/追踪链路互补而非替代，trace_id 关联三位一体，成本考量关键业务全量普通业务采样，可观测性优先于排障，告警最小化）、监控体系 Prometheus + Grafana（拉取 pull 模式主动访问 /metrics 端点，Pushgateway 短生命周期任务中转，采集间隔 15-30 秒，Service Discovery 自动发现目标，PromQL 查询语言，TSDB 时序数据库单实例数百万时间序列，高可用双实例或 Thanos/Cortex，长期存储本地 15 天 + 远程 Thanos/Cortex/VictoriaMetrics，K8s 核心组件监控 API Server/etcd 最高优先级用专用 SSD/kubelet PLEG 延迟/Scheduler/Pod，指标通过 /metrics 端点暴露内建，四类黄金指标延迟 P99/流量/错误率/饱和度 Google SRE 四个黄金信号，告警必须有 runbook 可操作性原则，告警避免风暴 AlertManager 抑制/分组/路由）、日志体系（K8s stdout/stderr 模型 kubelet 收集 /var/log/pods，日志与 Pod 生命周期一致需转发外部存储，日志轮转默认 10MB 保留 5 个，kubectl logs 基于 kubelet API 只能查当前节点跨节点需中心存储，DaemonSet vs Sidecar vs Node Agent Promtail，日志采样降低成本，结构化日志 JSON 字段查询 trace_id 关联追踪，日志级别 INFO 及以上，敏感信息脱敏，Loki vs ELK 索引策略/资源成本/查询能力/运维复杂度）、分布式追踪（OpenTelemetry 统一采集 OTel SDK + Collector 转发，统一标准避免厂商锁定，自动 instrumentation Java OTel agent，Jaeger/Zipkin 追踪存储与 UI，K8s 追踪挑战跨 Pod 传播 trace context W3C Trace Context 标准/Service Mesh Istio 自动传播/异步消息队列 Kafka header/数据库驱动 trace，追踪采样策略头部采样 vs 尾部采样，span 数量控制，追踪与日志关联 trace_id）、故障排查方法（Pod 级别状态→Events→日志→进入容器，--previous 看崩溃前日志，Events 第一手信息，init 容器排查；节点级别状态→Pod→资源→kubelet，节点 NotReady kubelet 问题，节点资源压力，Conditions Ready/MemoryPressure/DiskPressure/PIDPressure；集群级别 API Server 慢区分过载 vs etcd 慢，Pod 大量 Pending，节点大量 NotReady，etcd 不稳定根因磁盘；故障排查从具体到通用 Pod→节点→集群，先定位再修复，建立排查文档；常见故障模式 Pending/ContainerCreating/CrashLoopBackOff/OOMKilled/Evicted/ImagePullBackOff/NotReady 典型原因与排查方法）。

**格式验证**：frontmatter 完整、4 个 Mermaid 图使用 Dracula 主题、14 个 code fence 成对闭合、2 个 wiki 链接目标均存在（00 专栏导览、18 弹性伸缩与多集群）、6 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 16 篇（生产化集群管理）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/16 生产化集群管理：多租户隔离、资源治理与安全加固.md` 完全重写。原文章约 309 行 / 2047 中文字，重写后达 **579 行 / 12005 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：5 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：多租户隔离模型（三个隔离层次 Soft/Hard/Complete、Soft 资源竞争需 ResourceQuota、Hard 中等隔离、Complete 集群管理成本与资源利用率、Namespace 隔离局限——网络默认不隔离/共享节点与内核/资源竞争/管理边界非安全边界）、资源治理（ResourceQuota Namespace 级配额创建时检查非运行时检查/配额类型 CPU 内存 Pod Service PVC ConfigMap Secret/作用域 scope/与 LimitRange 配合、LimitRange Pod 级资源限制作用于 Container 不是 Pod/default 与 defaultRequest 关系/max 限制过严陷阱、PriorityClass 优先级调度/优先级值与内置 system-cluster-critical/抢占策略优雅终止/globalDefault 只能一个/优先级反转、PodDisruptionBudget 驱逐保护 minAvailable/maxUnavailable 二选一/只对自愿驱逐有效/PDB 阻止 drain 陷阱/与滚动更新和 HPA 协调）、安全加固（Pod Security Standards Privileged/Baseline/Restricted 三级/三种模式 enforce/audit/warn/替代旧 PSP/Restricted 限制禁止特权 root host 网络/系统组件特权需求分级策略、RBAC 最小权限/Role 与 ClusterRole/过度授权陷阱、ServiceAccount 每应用独立/automountServiceAccountToken 减少攻击面、Secret 加密 KMS 与静态密钥/性能影响/防止 etcd 泄露、审计日志 Metadata 级别/审计策略配置、NetworkPolicy 默认拒绝按需放行/镜像安全扫描 Trivy/Clair + 签名 Cosign 禁止 latest、API Server 加固关闭匿名访问减少攻击面）、容量规划（资源规划方法业务需求→应用资源→Pod 数量→节点资源→节点数/系统开销减去/eviction-hard 阈值保留/节点资源碎片/requests 与 limits 差异/节点规格选择大节点小节点混合/集群规模与可用区延迟、冗余规划节点 N+1/N+2/资源缓冲 20-30%/IP 预留充足/成本与可用性平衡、QoS 等级 Guaranteed/Burstable/BestEffort 驱逐顺序/内存不可压缩 CPU 可压缩/Guaranteed 条件所有容器 requests=limits/Burstable 弹性、节点亲和性与反亲和性 podAntiAffinity 跨节点/topologySpreadConstraints 跨可用区）、集群升级策略（滚动升级一次一个小版本不跳版本/升级顺序 etcd→控制平面→kubelet/控制平面逐个升级/kubelet drain 升级 uncordon/零停机但需 Pod 重新调度/大集群升级时间长低峰期、版本兼容性 kube-apiserver 最高/kubelet 最多低 3 个小版本/控制平面组件最多低 1 个/偏差过大风险、API 废弃检查 kubectl get --raw /apis/测试环境先验证、回滚方案 etcd 备份 etcdctl snapshot save/etcd 回滚是时间旅行/回滚局限性不能回滚组件版本、蓝绿集群升级新建集群逐步迁移/零停机快速回滚但成本高/流量切换平滑渐进/有状态应用数据迁移难点）。

**格式验证**：frontmatter 完整、1 个 Mermaid 图使用 Dracula 主题、16 个 code fence 成对闭合、2 个 wiki 链接目标均存在（00 专栏导览、17 集群可观测性）、6 个 Callout（warning/info/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 15 篇（CNI 网络模型与数据面对比）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/15 CNI 网络模型与数据面对比：Flannel Calico Cilium.md` 完全重写。原文章约 323 行 / 1986 中文字，重写后达 **594 行 / 12028 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：6 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：K8s 网络模型与 CNI 规范（三大基本要求 Pod 唯一 IP/Pod 间直接通信无需 NAT/节点访问所有 Pod、扁平网络设计哲学、IP-per-Pod 设计、Linux 网络基础网络命名空间/veth pair/网桥 cni0/路由表、CNI 插件规范 ADD/DEL/CHECK 命令、无状态二进制调用不能依赖上次调用内存状态、简单与可组合设计哲学、插件链 chained plugins 功能可组合、IP 分配 IPAM 插件、配置文件优先级、声明式配置可版本管理可审计）、Flannel 简单易用的 CNI（三种后端模式 VXLAN/Host-GW/UDP、VXLAN 封装 50 字节开销跨子网通用、VTEP 隧道端点与 FDB、封装开销性能考量、Host-GW 无封装高性能要求同二层网络且需动态路由维护、UDP 用户态封装不推荐、Pod CIDR 分配每节点一个子网、可观测性弱不支持网络策略、适用边界中小集群 flanneld 大规模性能不足）、Calico 企业级 CNI（iptables/eBPF 两种数据面功能差异与切换成本、BGP 路由模式节点间宣告 Pod 网段无封装高性能、BGP 要求物理网络支持或节点同二层、IPIP 封装模式跨子网兼容 20 字节开销、大规模路由表挑战与 Route Reflector 优化、NetworkPolicy 用 iptables mark 实现、网络隔离安全基础、默认允许白名单陷阱、命名空间隔离多租户基础、规则匹配开销、calico-node 组件、功能全面企业级事实标准）、Cilium eBPF 原生 CNI（eBPF 数据面 tc 钩子绕过 iptables/IPVS、Cilium Map 内核态数据结构、eBPF 程序验证器安全性、eBPF 程序原子更新、性能比 iptables 快 3-5 倍、内核级可观测性 Hubble、L7 NetworkPolicy HTTP/gRPC/Kafka、kube-proxy replacement eBPF 实现 Service 转发、身份认证基于 label 而非 IP、eBPF 替代 sidecar 代理 sidecarless Service Mesh、Hubble 流量可视化、eBPF 程序调试 cilium monitor、需要较新内核 4.10+、功能成熟度考量）、CNI 选择决策框架（是否需要 NetworkPolicy、集群规模、是否需要 L7 策略或可观测性、迁移成本、云厂商默认 CNI 与云网络集成、内核版本限制、是否需要 Service Mesh）、CNI 运维实践（网络故障排查 Pod 无法通信/跨节点不通/NetworkPolicy 不生效/DNS 解析失败、tcpdump 抓包、CNI 专有工具 calicoctl/cilium、连通性测试、性能调优 MTU 一致/数据面选择/NetworkPolicy 数量控制/Pod 网段规划/内核参数调优/CPU 与中断分配 RPS/RFS/XPS、BGP 大规模优化 Route Reflector 星型拓扑 O(n²) 到 O(n)/路由聚合/收敛时间/Route Reflector 高可用、CNI 可插拔设计避免厂商锁定与适应不同环境）。

**格式验证**：frontmatter 完整、5 个 Mermaid 图均使用 Dracula 主题、14 个 code fence 成对闭合、2 个 wiki 链接目标均存在（00 专栏导览、16 生产化集群管理）、7 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 14 篇（Service 与 kube-proxy）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/14 Service 与 kube-proxy：iptables IPVS eBPF 数据面演进.md` 完全重写。原文章约 365 行 / 2117 中文字，重写后达 **624 行 / 12008 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：8 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：Service 本质（虚拟 IP 与内核转发、为什么需要 Service、Pod IP 临时性、解耦客户端与后端、分布式负载均衡、Service 不是代理而是内核转发规则、控制平面与数据平面分离的可靠性与性能可预测优势、ClusterIP 虚拟 IP 来自 service CIDR 不路由）、kube-proxy 三种数据面模式（iptables 默认——statistic 模块随机概率、规则链两级结构 KUBE-SVC → KUBE-SEP、规则数随 Pod 数线性增长、O(n) 规则匹配、全量更新慢；IPVS——内核级负载均衡、哈希查找 O(1)、rr/wrr/lc/sh 调度算法、连接跟踪保证长连接稳定、增量更新快、需要内核 IPVS 模块、连接跟踪表大小限制需调高 nf_conntrack_max；eBPF——Cilium 绕过 iptables 性能最高、tc/xdp 钩子比 netfilter 更早、内核级可观测性通过 Hubble 可视化、需要较新内核 4.10+；三种模式对比与选择策略）、Service 四种类型（ClusterIP 集群内虚拟 IP、NodePort 节点端口 30000-32767 天然高可用但客户端需感知节点故障、LoadBalancer 云 LB 自动创建后端是节点而非 Pod 两跳转发配置与云厂商耦合需 annotation、ExternalName DNS CNAME 引用外部服务不创建 Endpoints 开销最小）、Endpoints 与 EndpointsSlice（Service → Pod IP 映射、只包含 ready 的 Pod、规则同步固有延迟、EndpointsSlice 分片解决更新冲突与大小限制每个 Slice 最多 100 Endpoint K8s 1.21+ 默认、Slice 分片策略按节点分片、与 Endpoints 兼容双写）、Headless Service（无 ClusterIP DNS 返回 Pod IP、StatefulSet 稳定网络身份基础、DNS 轮询局限与客户端选择不确定性、与普通 Service 选择依据）、会话亲和性与流量策略（sessionAffinity ClientIP 实现机制 iptables recent 模块或 IPVS sh 算法、超时机制、客户端 IP 不稳定陷阱；externalTrafficPolicy Local vs Cluster——Local 保留客户端 IP 但要求每节点有 Pod 负载不均匀、Cluster 负载均匀但 SNAT 丢失客户端 IP、Local 策略健康检查与 LB 自动移除无 Pod 节点）、Service DNS 解析（CoreDNS Watch Service 变化、TTL 默认 5 秒、NDots 与搜索域增加 DNS 查询次数、DNS 缓存导致 Service 变化不感知、CoreDNS 性能与 NodeLocal DNSCache 两级缓存）、生产实践（模式选择与切换注意事项、外部访问方案 NodePort/LoadBalancer/Ingress 主流——集中 TLS 终止与按域名路由、大规模 Service 优化 EndpointsSlice/IPVS/Topology Aware Routing 优化多可用区流量/监控 kube-proxy 规则数与同步延迟、故障排查——Pod 在 Endpoints 但流量不通/ClusterIP 不通/Headless Service DNS 返回空的排查步骤）。

**格式验证**：frontmatter 完整、2 个 Mermaid 图均使用 Dracula 主题、28 个 code fence 成对闭合、2 个 wiki 链接目标均存在、8 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 13 篇（kubelet 深度剖析）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/13 kubelet 深度剖析：Pod 生命周期与容器运行时接口.md` 完全重写。原文章约 380 行 / 2983 中文字，重写后达 **654 行 / 12000 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：10 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：kubelet 定位（控制平面与数据平面的桥梁、双重身份——控制平面客户端与数据平面管理者、故障排查影响）、kubelet 架构（PodManager/CRI/PLEG/StatusManager/ProbeManager/GC/VolumeManager/EvictionManager 协作模式、动态 Pod 与静态 Pod 区别、静态 Pod 用于控制平面组件自举、VolumeManager 挂载时机与挂载容器分离与 attach/detach 延迟）、SyncPod 流程（七步完整步骤、顺序依赖、先准备环境再启动应用、PostStart 与 PreStop 钩子执行时机与 timeoutSeconds、幂等性与并发控制 per-Pod 串行 + 跨 Pod 并行）、CRI 接口（RuntimeService 与 ImageService 方法、dockershim 移除历史与 containerd 崛起、CRI 解耦使运行时可替换、gRPC 调用开销与版本兼容）、PLEG 机制（定期轮询拉模型、最后观测状态问题、PLEG is not healthy 故障根因——容器运行时卡死与节点资源耗尽——排查方法）、健康检查探针（liveness/readiness/startup 三种探针职责分离、存活与就绪独立判断、httpGet/tcpSocket/exec/grpc 四种类型、readinessProbe 影响 Service 流量与零停机更新、startupProbe 解决慢启动问题、探针配置陷阱——同端点/timeoutSeconds 太短/failureThreshold 太小/检查外部依赖/忽略 initialDelaySeconds）、垃圾回收（容器 GC 策略、镜像 GC LRU 算法与误清理风险、GC 与拉取竞争、容器 GC 与镜像 GC 协作）、驱逐机制（软驱逐与硬驱逐、驱逐优先级 BestEffort→Burstable→Guaranteed、驱逐与 OOMKilled 区别——主动 vs 被动、有 grace period vs 无 grace period、驱逐信号与阈值独立配置、imagefs 分离）、kubelet 常见故障（ContainerCreating 卡住、节点 NotReady、PLEG not healthy 排查步骤、kubelet 心跳与节点状态——Lease 心跳与 Status 心跳分离）、kubelet 边界（只管理本节点 Pod、不保证应用可用性、不做应用级故障转移、依赖容器运行时、K8s 分层架构体现）。

**格式验证**：frontmatter 完整、4 个 Mermaid 图均使用 Dracula 主题、14 个 code fence 成对闭合、2 个 wiki 链接目标均存在、13 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 12 篇（CRD 与 Operator 模式）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/12 CRD 与 Operator 模式：自定义控制器与扩展 K8s.md` 完全重写。原文章约 484 行 / 2120 中文字，重写后达 **821 行 / 12008 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：7 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：Operator 起源（CoreOS 2016 年运维知识编码理念、传统运维方式局限、Operator 相比手动运维/脚本自动化/外部调度系统的根本优势、运维知识可复用可分发可演进）、CRD 定义（OpenAPI v3 Schema 验证、x-kubernetes-list-type 高级特性、Schema 文档化价值、关键字段、status 子资源分离并发控制、additionalPrinterColumns priority、conditions 细粒度状态）、controller-runtime 框架（Manager/Controller/Reconciler 三层架构、编写控制器完整流程、Requeue 与 RequeueAfter 区别、error 指数退避机制、For/Owns/Watches 事件源管理）、Operator 设计模式（Finalizer 管理外部资源、Finalizer 卡住监控、多 Finalizer 协作、OwnerReference 级联控制、UID 匹配、跨命名空间限制、状态机式协调、状态转换原子性、phase 与 conditions 结合、幂等性保证、外部操作幂等性、查询兜底模式）、Helm vs Operator（一次性模板渲染 vs 持续协调、是否有协调循环、复杂条件逻辑支持、选择依据、混合使用模式、资源所有权清晰避免冲突）、生产级最佳实践（RBAC 最小权限与子资源粒度、Webhook 验证与可用性依赖与超时、监控指标与业务指标与 Event 记录、多版本 CRD 转换与版本演进阶段与先废弃后删除、Leader Election 高可用与 Lease renewTime 原子更新、并发安全与共享缓存加锁与 API Server 压力）、Operator 边界与反例（不适合无状态应用与一次性部署与运维逻辑简单场景、复杂度代价与调试困难、Operator 与 Helm 分工、CNCF 成熟度模型 Level 1-5）。

**格式验证**：frontmatter 完整、3 个 Mermaid 图均使用 Dracula 主题、36 个 code fence 成对闭合、2 个 wiki 链接目标均存在、11 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 11 篇（Scheduler 调度算法）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/11 Scheduler 调度算法：预选、优选与扩展机制.md` 完全重写。原文章约 461 行 / 2865 中文字，重写后达 **750 行 / 12008 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：10 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：调度本质（从 Borg 集中式调度到 Omega 乐观并发再到 K8s 两阶段调度、Borg 调度经验对 K8s 的影响、调度器只做决策不做执行的解耦设计）、两阶段流程（Filter+Score+Bind、Filter 短路优化、Score 插件权重配置、NodeResourcesFit 的 LeastRequested 与 MostRequested 策略对比、负载均衡 vs 资源利用率权衡）、节点亲和性与反亲和性（NodeAffinity 的 required/preferred 区分、IgnoredDuringExecution 语义、PodAntiAffinity 的 topologyKey、PodAffinity 就近部署应用与性能代价）、Taint 与 Toleration（三种 Taint 效果、tolerationSeconds 故障容忍窗口、内置 Taint 自动标记、master 节点 NoSchedule）、PodTopologySpread（maxSkew 控制、与 PodAntiAffinity 对比、多维度分散实践）、Scheduler Framework（扩展点全生命周期、自定义插件、Extender 对比、从外部扩展走向进程内插件的趋势、Reserve 并发调度资源超卖、Unreserve）、优先级与抢占（PriorityClass、内置 system-node-critical 与 system-cluster-critical、抢占提名机制、PDB 保护、反亲和性保护）、性能优化（节点信息缓存、缓存一致性与 Watch 延迟、基于请求而非实际使用的边界、批量调度、优先级队列、并行 Score）、调度失败与 Pending（kubectl describe 排查、临时与永久 Pending 区分、退避重试机制、Pending 监控）、多调度器与边界（schedulerName 隔离、节点分片与乐观并发协调、调度器五个边界：最终一致、不做运行时调度、不保证公平、不感知实际负载、不处理跨集群调度）。

**格式验证**：frontmatter 完整、6 个 Mermaid 图均使用 Dracula 主题、36 个 code fence 成对闭合、2 个 wiki 链接目标均存在、12 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 10 篇（StatefulSet 深度解析）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/10 StatefulSet 深度解析：有序部署与持久化身份.md` 完全重写。原文章约 463 行 / 3279 中文字，重写后达 **712 行 / 12024 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：8 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：Deployment 无状态假设与有状态应用需求差异、PetSet 命名争议与 Pet vs Cattle 比喻的工程含义、稳定网络身份（Pod 命名规则、三层 DNS 解析、CoreDNS Pod DNS 记录实现、Headless Service 与普通 Service 对比、serviceName 强制要求）、有序部署（创建正序/删除逆序、OrderedReady 与 Parallel、readiness probe 配置陷阱）、持久化存储绑定（volumeClaimTemplates、PVC 与 Pod 解耦、PVC 生命周期、存储类与 accessModes 对比、存储类型选择权衡）、滚动更新（有序逆序更新、先删后建中断期、maxUnavailable、partition 灰度、OnDelete、暂停恢复）、典型应用（数据库主从、Kafka broker.id、Redis Cluster、ZooKeeper、Elasticsearch）、运维实践（Pod 删除与 PVC 保留、节点故障脑裂风险与缓解、扩缩容有序性、PDB 与 podAntiAffinity 配合）、边界与反例（StatefulSet 不解决应用层逻辑、StatefulSet 与 Operator 分工、不适合场景判断准则、复杂度代价与常见误用）。

**格式验证**：frontmatter 完整、3 个 Mermaid 图均使用 Dracula 主题、38 个 code fence 成对闭合、3 个 wiki 链接目标均存在、11 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 09 篇（控制器模式与协调循环）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/09 控制器模式与协调循环：从 Deployment 到 Operator.md` 完全重写。原文章约 642 行 / 3391 中文字，重写后达 **913 行 / 12184 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：10 个编号章节 + 摘要 + 总结 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：控制器模式起源（Borg 运维经验）、协调循环三步（Observe-Diff-Act）、三大铁律（幂等/无状态/基于当前状态）、Level-triggered 与 Edge-triggered 对比、EventHandler 事件到 key 的转换、Deployment→ReplicaSet→Pod 级联控制、滚动更新两个 ReplicaSet 扩缩容交替、回滚即更新、OwnerReference 与基于 UID 的垃圾回收、级联删除三模式（Foreground/Background/Orphan）、Finalizer 工作流程与陷阱、controller-runtime 三层架构（Manager/Controller/Reconciler）、For/Owns/Watches 语义、Requeue/RequeueAfter、状态机式协调、status.phase 与 condition 之争、Operator 起源（CoreOS 2016）、CRD 定义、Controller 实现、Operator 价值边界。

**格式验证**：frontmatter 完整、8 个 Mermaid 图均使用 Dracula 主题、36 个 code fence 成对闭合、7 个 wiki 链接目标均存在、13 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji、无散文感叹号。

### 重写：K8s 架构深度剖析 08 篇（ResourceVersion 与乐观并发控制）

按 skill `writing-technical-article` 与 AGENTS.md 交付硬指标，将 `content/云原生/Kubernetes/Kubernetes架构深度剖析/08 ResourceVersion 与乐观并发控制.md` 完全重写。原文章约 478 行 / 3840 中文字，重写后达 **779 行 / 15918 中文字**，满足 12000-16000 中文字 / 500+ 行的专栏交付标准。

**结构**：11 个编号章节 + 摘要 + 结语 + 延伸思考 + 参考资料 + 思考题 Callout。

**覆盖内容**：ResourceVersion 与 etcd ModRevision 映射、乐观并发与悲观锁对比、Read-Modify-Write 三步流程、409 Conflict、etcd CAS Txn 底层实现、generation/observedGeneration、List-Watch 中的 ResourceVersion、Bookmark 事件、ResourceVersion=0 语义、Server-Side Apply 字段所有权、retry.RetryOnConflict 冲突重试、指数退避与 WorkQueue 延迟重试、Endpoints/EndpointsSlice 分片、Status 子资源 spec/status 分离、乐观并发边界与反例（活锁、Leader Election、分布式事务）。

**格式验证**：frontmatter 完整、2 个 Mermaid 图均使用 Dracula 主题、30 个 code fence 成对闭合、3 个 wiki 链接目标均存在、11 个 Callout（info/warning/note）语法正确、无 ASCII 表格、无 emoji。

## 2026-09-08

### 重写：Netty 专栏全量重构（content/Java/Netty/ 11 篇）

按 skill `writing-technical-article`（周志明《凤凰架构》六层 DNA）与 AGENTS.md 交付硬指标，将 `content/Java/Netty/` 专栏全量重写（00 导览 + 01-10 正文共 11 篇）。串行一篇一篇主代理直写，严禁子代理。全专栏 10 篇正文全部达成 **单篇 12000-14557 CJK 中文字 / 500-1009 行** 的工业级交付标准。

**完成统计**：10 篇正文总规模达 **6608 行 / 126662 中文字**，篇均 12666 字。

| 篇号 | 标题 | 行数 | 中文字数 |
|:---|:---|:---:|:---:|
| 01 | Java NIO基础——Channel、Buffer、Selector三大组件 | 525 | 12065 |
| 02 | Netty全局架构——从BossGroup到ChannelPipeline | 530 | 12000 |
| 03 | EventLoop与线程模型——Reactor模式的落地实现 | 518 | 12019 |
| 04 | ByteBuf——引用计数、池化与零拷贝 | 599 | 12008 |
| 05 | ChannelPipeline与ChannelHandler——责任链模式的精妙设计 | 512 | 12005 |
| 06 | 编解码器——LengthFieldBasedFrameDecoder与自定义协议 | 1009 | 12026 |
| 07 | Netty内存管理——jemalloc算法在Java中的实现 | 704 | 12018 |
| 08 | Netty高性能之道——FastThreadLocal、HashedWheelTimer与无锁队列 | 787 | 14557 |
| 09 | 基于Netty的RPC框架设计——序列化、路由与连接管理 | 755 | 12805 |
| 10 | Netty在开源项目中的应用——Dubbo、RocketMQ、Elasticsearch | 678 | 12629 |
| 00 | Netty 网络编程 专栏导览 | 108 | 1730 |

**主要增强与重构内容**：
- **01 Java NIO基础**：BIO 演进与 C10K 瓶颈、Channel/Buffer/Selector 三大核心组件底层机制、TCP 粘包拆包物理成因、Linux epoll 空轮询 Bug 根因与 Netty 的自愈防御；
- **02 Netty全局架构**：Reactor 模式的演进脉络、BossGroup 与 WorkerGroup 线程拓扑、ServerBootstrap 引导机制、三层分层体系与 Channel 生命周期；
- **03 EventLoop与线程模型**：严格线程封闭（Thread Confinement）、inEventLoop 判断机制、MPSC 任务队列、ioRatio 动态时间分配、ChannelFuture/Promise 异步原语与阻塞业务隔离；
- **04 ByteBuf**：双指针解耦、五大分类体系、引用计数与显式内存管理、CompositeByteBuf 逻辑合并零拷贝、操作系统级零拷贝 FileRegion 与多级内存泄漏探测器；
- **05 ChannelPipeline与Handler**：双向链表拓扑、HeadContext 与 TailContext 哨兵职责、入站正向与出站反向传播流转、executionMask 位掩码优化、@Sharable 线程安全契约与动态 Pipeline 编排；
- **06 编解码器**：TCP 粘包拆包本质、ByteToMessageDecoder 累积缓冲区设计、LengthFieldBasedFrameDecoder 六大几何参数与丢弃模式、Titan-RPC 自定义二进制协议栈实现、ReplayingDecoder 局限与状态管理；
- **07 Netty内存管理**：堆外内存物理瓶颈、jemalloc 架构映射、PoolArena 竞技场隔离与六大使用率队列、PoolChunk 完全二叉树伙伴系统、PoolSubpage 64位位图切片、PoolThreadCache 无锁本地缓存与跨线程释放；
- **08 Netty高性能之道**：FastThreadLocal 数组直接物理寻址与 InternalThreadLocalMap 内存泄漏防御、HashedWheelTimer 时间轮算法与异步批处理取消、MpscQueue 128字节缓存行填充防伪共享与 lazySet 内存屏障、Recycler 对象池；
- **09 RPC框架设计**：LPC 到 RPC 的抽象泄漏法则、八大物理谬误、Titan-RPC 16字节协议帧设计、Protobuf/Hessian2/Kryo 序列化四维坐标系与 SPI、客户端 RequestId + CompletableFuture 全双工复用、连接治理与动态路由；
- **10 开源项目应用**：Apache Dubbo SPI 传输层与五大 Dispatcher 线程派发策略、RocketMQ RemotingCommand 四段式协议与 FileRegion 操作系统原生零拷贝、Elasticsearch 五大优先级专属物理连接通道与断路器内存防爆；
- **00 专栏导览**：架构全景图、篇幅指标表、三条定制化阅读路径与关联专栏互链。

**验证结果**：
- frontmatter：11 篇全量验证通过，title/date/tags/aliases 完整规范；
- 篇幅指标：10 篇正文全部达到 500+ 行 / 12000-14557 CJK 中文字，零死稿；
- 格式规范：全量排除 ASCII 表格，统一采用 Markdown 表格；
- 图表规范：Mermaid 图表全量统一采用 `%%{init: {'theme': 'dracula'}}%%` 主题；
- 链接检查：全专栏内部双向链接死链数为 0；
- 语法检查：全部 code fences 严格对称平衡，正文零感叹号。

## 2026-09-06

### 重写：Golang 专栏全量重写（content/Golang/ 三个专栏共 25 篇）

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 Golang 下三个专栏共 25 篇正文全量重写。三个 `00 专栏导览.md` 未修改。主代理直写，严禁子代理。

**完成统计**：25 篇全部完成结构重写，篇均 6800 字 / 470 行，合计约 17 万中文字。

**Go语言核心（10 篇）**：篇均 8410 字 / 445 行

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 设计哲学 | 383 | 13007 |
| 02 类型系统 | 554 | 8874 |
| 03 接口实现原理 | 489 | 9100 |
| 04 slice 底层结构 | 513 | 7659 |
| 05 map 实现原理 | 408 | 8327 |
| 06 string 与 rune | 456 | 8233 |
| 07 函数闭包 defer | 554 | 7886 |
| 08 内存分配器 | 371 | 6873 |
| 09 垃圾回收 | 287 | 7302 |
| 10 泛型 | 438 | 6828 |

**Go并发编程（8 篇）**：篇均 5958 字 / 510 行

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 GMP 调度器 | 352 | 6910 |
| 02 Channel 底层结构 | 485 | 6395 |
| 03 sync 包 | 489 | 6159 |
| 04 sync.Map sync.Pool | 435 | 6000 |
| 05 Context | 543 | 5795 |
| 06 并发模式 | 731 | 4991 |
| 07 并发陷阱与调试 | 651 | 5758 |
| 08 网络编程 netpoller | 398 | 5658 |

**Go工程实践（7 篇）**：篇均 5595 字 / 442 行

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 项目结构 | 437 | 5505 |
| 02 Go Module 依赖管理 | 292 | 5961 |
| 03 错误处理哲学 | 493 | 5179 |
| 04 测试体系 | 583 | 4885 |
| 05 性能剖析 | 447 | 5848 |
| 06 编译与链接 | 358 | 6318 |
| 07 代码规范与陷阱 | 486 | 5468 |

**主要增强**：每篇补齐"设计认知"总结章 + 参考资料规范化 + 思考题第 4 题；Go工程实践 02 深化 MVS 算法详解与主版本后缀；03 深化 errors.Is/As 源码级实现与错误链机制；04 深化表驱动测试与 gomock 期望验证；05 深化 pprof flat/cum 解读与 trace 调度级分析；06 深化编译流水线 SSA 与约束换速度哲学；07 深化七个陷阱根因分析与自动化防线。

**验证**：frontmatter 完整；Mermaid 统一 dracula 主题；wiki 链接死链 0（修复 3 个系列导航链接 + 9 个外部概念链接改纯文本）；code fence 全部平衡；三个 `00 专栏导览.md` 未修改。

**备注**：部分篇章字数尚未达到 12000 理想目标（篇均 5000-9000 字），结构完整但深度有进一步提升空间，后续如需可单独扩写。

---

## 2026-09-06

### 重写：系统性能工程实战专栏（content/Linux/系统性能工程实战/01-14）

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-14 共 14 篇重写至交付标准（12000-16000 字/500+ 行）。00 导览不动。允许全量重写，以内容质量为硬门槛，主代理直写，严禁子代理。

**完成统计**：14 篇全部达标，篇均 12774 字 / 839 行，合计约 17.9 万中文字。

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 性能工程的本质 | 600 | 12297 |
| 02 系统级性能观测 | 1000 | 13098 |
| 03 eBPF 与动态追踪 | 784 | 12008 |
| 04 JVM 层性能观测 | 845 | 12025 |
| 05 CPU | 705 | 12047 |
| 06 内存 | 671 | 12132 |
| 07 存储 IO | 963 | 12027 |
| 08 网络 | 868 | 12308 |
| 09 JIT 编译与稳态性能 | 668 | 12023 |
| 10 GC 工程化 | 1008 | 12217 |
| 11 锁竞争与并发性能 | 871 | 12150 |
| 12 基准测试方法论 | 904 | 12008 |
| 13 云环境与异构硬件 | 874 | 14146 |
| 14 全栈性能排查实战 | 972 | 15442 |

**主要增强**：每篇补齐"参考资料 + 思考题"骨架；01 篇新增 SLO 体系/百分位数/协调遗漏/容量规划；03 篇新增 BPF map/CO-RE/XDP/实战案例章；04 篇新增统一日志/safepoint/NMT 边界/OOM 案例；05 篇新增 CPU 频率/Topdown/伪共享/虚拟线程/案例章；06 篇新增 swappiness 语义/水位机制/glibc arena/NUMA 案例；09 篇新增内联专题/deopt 与 safepoint/Leyden/JIT 案例；10 篇新增 GC 案例章与调优优先级；11 篇新增锁案例章/虚拟线程 pinning/锁监控指标；12 篇新增假设验证链/压测工具陷阱/统计与工程显著/缓存选型案例。

**验证**：frontmatter 完整；Mermaid 统一 dracula 主题；wiki 链接有效；篇幅全部达标；参考资料+思考题全覆盖（00 导览除外）。

### 重写：Linux 性能优化专栏（content/Linux/性能优化/01-15）

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-15 共 15 篇从篇均约 6000 字/300 行重写至交付标准（12000-16000 字/500+ 行）。00 导览不动。主代理直写，严禁子代理。

**完成统计**：15 篇全部达标，篇均 12733 字 / 838 行。

| 篇号 | 行数 | 中文字数 |
|------|------|----------|
| 01 CPU 性能分析 | 704 | 12015 |
| 02 CPU 微架构优化 | 770 | 12021 |
| 03 CPU 调度延迟 | 701 | 12015 |
| 04 内存性能调优 | 671 | 12061 |
| 05 磁盘 I/O | 704 | 12005 |
| 06 应用级 I/O | 613 | 12072 |
| 07 网络性能 | 769 | 12033 |
| 08 系统调用与用户态优化 | 759 | 12001 |
| 09 全栈 BPF 诊断 | 798 | 12439 |
| 10 完整调优案例 | 662 | 12732 |
| 11 内存硬件全景 | 1311 | 12096 |
| 12 Row Buffer 与 Bank 冲突 | 1014 | 12817 |
| 13 DDR 频率与时序 | 991 | 14610 |
| 14 Linux 内存硬件观测 | 955 | 12973 |
| 15 内存调优策略 | 949 | 16835 |

**验证**：frontmatter 完整；Mermaid 统一 dracula 主题；wiki 链接有效；篇幅全部达标。

## 2026-09-04

### 新增：OpenStack 专栏（content/云原生/OpenStack/）

面向「OpenStack 运维开发工程师」视角的完整专栏：**15 篇正文 + 导览，合计约 19.5 万中文字**，全部达到交付标准（12000-16000 字/500+ 行）。

- **结构**（5 部分，通用生产实践基线）：
  - 全景与地基：01 全景 / 02 控制面三件套（MariaDB/RabbitMQ/Keystone）/ 03 虚拟化地基（KVM/QEMU/libvirt）
  - 计算与网络：04 Nova 架构与调度 / 05 实例生命周期与迁移 / 06 Neutron 架构 / 07 Neutron 进阶（VXLAN/DVR/安全组）
  - 存储与镜像：08 Cinder 与 Ceph RBD 后端 / 09 Glance / 10 Swift（含与 Ceph RGW 对比）
  - 部署与运维开发：11 Kolla-Ansible 部署 / 12 日常运维手册 / 13 监控告警 / 14 故障案例库 / 15 自动化与开发
- **风格**：全部按 writing-technical-article skill（凤凰架构 DNA）创作；论述五问贯穿；Heat/Ironic/Octavia 按老板决策在正文小节带过
- **质量**：Mermaid 统一 dracula；全库死链 0；版本号/参数默认值经 web 核实；案例库按五段式（现象→诊断→根因→处置→预防）可作 runbook
- **执行**：8 批次串行推进（每批 ≤2 个 subagent，批次间验证），因编辑器崩溃导致的 subagent 丢失由主 agent 手写补齐（04/13/14/15）

### 重构：Ceph 专栏深度重写（content/中间件/Ceph/）

面向「Ceph 运维开发工程师」视角（原理深到能排障、运维细到能上手）的整专栏重构，从 6 篇篇均 3358 字扩充为 **13 篇正文 + 导览，合计 16.76 万中文字**，全部达到交付标准（12000-16000 字/500+ 行）。

- **结构**（4 部分，按逻辑重排编号，外部反链仅指向导览无死链）：
  - 原理层：01 全局架构【增强】/ 02 CRUSH【增强】/ 03 Monitor 与集群地图【新增】
  - 数据与引擎层：04 BlueStore【增强】/ 05 PG 状态机【增强】/ 06 Scrub 与数据校验【新增】
  - 接口层：07 RBD【新增】/ 08 CephFS【增强】/ 09 RGW【新增】
  - 运维开发层：10 部署实战【自旧 06 拆分增强】/ 11 日常运维手册【自旧 06 拆分增强】/ 12 监控告警【新增】/ 13 故障案例库【新增】
- **删除**：旧《06 Ceph 运维——集群部署、PG 调优与故障处理》拆分并入 10/11 两篇后删除
- **风格**：全部按 writing-technical-article skill（凤凰架构 DNA）创作：历史溯源开场、比喻落地、设问推进、正反权衡、落点因地制宜；论述五问贯穿
- **质量**：篇均 12894 字/559 行；Mermaid 43 图统一 dracula；全库死链 0（含修复原稿 7 处裸链接与 4 处旧编号链接）；版本号/参数默认值/研究数据经 web 核实，不确定口径如实标注
- **执行**：分 4 批并行 subagent，遵循 AGENTS.md 批量整改流程

### 变更：《03 OpenTelemetry 统一标准》按凤凰架构风格重写（content/可观测/链路追踪/）

以周志明《凤凰架构》（icyfenix.cn）全站 43.4 万字蒸馏出的六层写作 DNA（L1 语言/L2 结构/L3 选题/L4 素材/L5 认知/L6 视觉）全文重写。保留全部技术资产（mermaid/yaml/protobuf/Java 代码、对比表格、参考资料、思考题、wiki 链接），注入句法层与认知层风格：历史叙事开场、比喻落地（度量衡铸钱币、物流分拨中心）、设问推进、争议正反权衡、落点「因地制宜/权衡取舍」。

### 新增：writing-technical-article skill（.devin/skills/）

技术文章写作 skill，沉淀上述六层风格规则与写前校准、写后自检流程（`SKILL.md` + `references/style-rules.md` + `references/checklist.md`）。已同步至 `~/.claude/skills/`、`~/.agents/skills/`、`~/.codeium/windsurf/skills/`，供各 agent 复用；writing-dna 原始仓库不保留。

### 新增：仓库工作规范 AGENTS.md + 交付硬指标

- 新建根目录 `AGENTS.md`（always-on）：专栏交付硬指标摘要、写作风格 skill 指引、CHANGELOG/TODO 记录惯例、批量执行验证流程
- skill 新增 `references/delivery-standard.md`：从 TODO.md 历史任务提炼的专栏交付硬指标（篇幅 12000-16000 字/500+ 行、论述五问、Mermaid dracula/Callout/双向链接核实/tags 全局映射、批量执行与验证流程、红线），与 style-rules.md 并列生效
- `checklist.md` 新增 H 组交付硬指标自检；skill 已重新同步至三个全局 agent 目录

## 2026-08-15

### 新增：Agent 沙箱技术专栏（content/LLM/Agent沙箱技术/）

基于 `work-management-1/30-知识库/技术学习/agent-sandbox` 的调研与实操素材（60+ 篇文档，覆盖威胁模型、隔离原语、虚拟化技术、OpenSandbox 架构/PoC/生产化、行业共识），分析 Agent 沙箱技术的框架体系与理论逻辑演进，整理/补充/扩写为符合本仓库交付标准（JVM 范文：篇均 13000 字/500+ 行）的完整专栏。

- **规模**：15 篇文章 + 1 篇导览，共 16 个文件，约 7700 行
- **结构**：根目录（00 导览、01 全景）+ 4 个子目录
  - `隔离原语/`（02-05）：Linux 隔离原语、四档隔离光谱、KVM 硬件虚拟化、VMM 家族解剖
  - `平台与协议/`（06-09）：六层模型与产品路线、OpenSandbox 架构/数据面/编排面三部曲
  - `工程实践/`（10-12）：部署实战（单机 PoC→测试集群）、三类 Agent 镜像化、性能工程
  - `生产化/`（13-15）：状态四本账、安全体系（三层防护/短期凭据/多租户）、十个盲区与行业共识
- **素材来源**：agent-sandbox 项目一手实操记录（PoC 47 步部署、三运行时基准、WarmPool 实测、源码走读）+ 2026 年公开资料（OpenSandbox 官方文档、InfoQ 分享、sigs agent-sandbox、行业 benchmark）

### 变更：旧专栏迁移

- 删除 `content/云原生/Agent沙箱与隔离技术/`（12 篇旧文章，篇均 6100 字，未达交付标准且缺 OpenSandbox 主线）
- 旧内容精华（namespaces/cgroups/seccomp/gVisor/Kata/Firecracker 等技术底稿）已并入新专栏 02-05 篇并深度扩写
- 更新 8 个外部引用文件（Coding-Agent运行范式 7 处、Hermes-Agent 2 处）的姊妹专栏链接指向

### 其他

- 根 TODO.md 追加并完成「Agent 沙箱技术专栏创作」任务章节
## 2026-09-05

### 扩写：Hermes-Agent 专栏全量扩写（content/LLM/Hermes-Agent/）

按 skill `writing-technical-article`（凤凰架构 DNA）与 AGENTS.md 交付标准，将 01-12 共 12 篇从篇均约 6000 字/300 行扩写至交付标准（12000-16000 字/500+ 行）。**合计约 16.3 万中文字（扩写前约 7.2 万），12 篇全部达标**。

- **各篇终态**（行/中文字）：01 全景 502/13530 · 02 模型谱系 501/15645 · 03 架构总览 543/12092 · 04 学习闭环 501/13273 · 05 技能系统 506/12003 · 06 持久记忆 501/13774 · 07 多平台网关 502/12079 · 08 终端后端 526/12061 · 09 工具系统 501/12627 · 10 Prompt 工程 501/15467 · 11 MLOps 501/15986 · 12 安全与未来 501/13275（00 导览不动）
- **扩写策略**：论述加深而非事实新增（扩写五问贯穿）；每大章至少 1 比喻；结论落权衡取舍；不虚构年份/版本/数字
- **结构修复**：03 篇补 2.4、2.6 重号改 2.7；ASCII 架构图/数据流图/分层图全部转 dracula Mermaid（03×4、07 五步流程、09 delegate 并行、11/12 各新增总纲图，全专栏 Mermaid 共 21 图）
- **新增小节**（节选）：01 品类溯源/选型决策/误区澄清；02 训练超参解读/格式碎片化/商业化版图；04 闭环全景图/触发条件表/Nudge 失效形态；05 description 写法/技能安全/Hub 选型框架；06 记忆全景图/审计能力矩阵；07 授权对照/并发模型/语音延迟预算；08 隔离谱系图/权衡矩阵；09 三层全景图/动态暴露/Fallback 边界；10 预算表/边缘情况优先级；11 数据配比/脱敏管线/负结果价值；12 四层防御表/互操作三阶段/时间复利
- **执行**：12 批一次一篇主代理直写（老板决策：禁用子代理）；每篇完成后跑篇幅统计验证；过程中 3 处误删段落即时恢复、1 处重复段落清除、07 篇文件名笔误产生的重复文件已清理（旧版删除，新版保留）
- **验证**：13 文件 frontmatter 全部 OK；Mermaid 全部 dracula 主题；篇幅统计见上；思考题/参考资料/双向链接全保留

