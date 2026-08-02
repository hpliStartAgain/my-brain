---
title: "OpenHands Runtime 与通用执行平台"
date: 2026-08-01
tags: [Agent Sandbox, Fly.io, GKE Agent Sandbox, Modal, OpenHands, Runtime, Docker Runtime, Remote Runtime, 通用执行平台]
aliases: [OpenHands Runtime, 通用执行平台, Modal Sandboxes, Fly.io Machines, GKE Agent Sandbox 生产实践]
---

# 09 OpenHands Runtime 与通用执行平台

> [!abstract] 摘要
> [[08 E2B、Daytona 与 Agent 专用云端沙箱|上一篇]]讨论了"Agent 原生"的云端沙箱平台。本文转向更广泛的沙箱生态——不是专为 Agent 设计但被广泛用于 Agent 代码执行的通用平台。文章深入 OpenHands 的四种 Runtime 实现（Docker/Remote/Modal/Local）和 Event Stream 架构如何与 Runtime 交互；剖析 Modal Sandboxes 的 gVisor 隔离 + 子秒级调度 + 10 万并发沙箱 + GPU 支持的 Serverless 模型；分析 Fly.io Machines 基于 Firecracker 的 suspend/resume 能力对 Agent 长时任务的价值；最后系统梳理 GKE Agent Sandbox 的生产实践——SandboxTemplate 机制、预热线池 300 沙箱/秒/集群、Pod Snapshots 检查点恢复、Default-Deny 网络策略、Agent Substrate 超大规模编排。核心认知：通用平台相比 Agent 专用平台的优势是"成熟的基础设施和更低的成本"——GKE Agent Sandbox 报告 75% 成本降低和 16 倍增长——劣势是"需要更多集成工作"，Agent 开发者需要自己构建 E2B/Daytona 提供的高级抽象。

---

## 第 1 章 OpenHands Runtime——开源 Agent 的沙箱选择

### 1.1 四种 Runtime 实现

[[LLM/Coding-Agent运行范式/09 OpenHands 与 Aider——开源 Coding Agent 的两种哲学|Coding Agent 专栏第 9 篇]]已经介绍了 OpenHands 的 Event Stream 架构和 Runtime 的基本概念。本文深入 Runtime 的四种实现及其在 Agent 沙箱场景中的差异。

| Runtime | 隔离机制 | 适用场景 | 特点 |
| :--- | :--- | :--- | :--- | :--- |
| **DockerRuntime** | Docker 容器 | 本地开发、单机部署 | 最简单，直接在本地 Docker 中运行 |
| **RemoteRuntime** | 自定义 HTTP API | 连接外部管理的沙箱 | 灵活，可对接任何外部沙箱服务 |
| **ModalRuntime** | Modal 平台（gVisor） | Serverless 执行 | 无需管理基础设施，按使用付费 |
| **LocalRuntime** | 无沙箱（直接本地） | 无 Docker 环境 | 无隔离，仅用于开发测试 |

### 1.2 DockerRuntime——最常用的本地沙箱

DockerRuntime 是 OpenHands 的默认 Runtime——在本地 Docker 容器中执行 Agent 的所有操作。

**工作流程**：
1. 用户提供自定义 base Docker image（如 `ubuntu:22.04` + 预装工具）
2. OpenHands 在此基础上构建 OH Runtime Image（添加 runtime client 代码）
3. 启动 Docker 容器
4. 容器内初始化 `ActionExecutor`——设置 bash shell、BrowserEnv、Jupyter IPython
5. OpenHands backend 通过 RESTful API 与容器内的 Action Execution Server 通信

**安全模型**：DockerRuntime 的隔离强度是"传统容器三重隔离"（namespace + cgroups + seccomp）——如[[01 Agent 沙箱全景——为什么代码执行 Agent 需要隔离|第 1 篇]]所述，这对"不可信代码"不够安全。但对于"自己团队的 Agent 代码"或"开发测试场景"，Docker 隔离通常足够。

**适用场景**：本地开发、CI/CD 中的 Agent 测试、单机部署的小规模 Agent 服务。不适合多租户生产环境——共享内核的隔离不够。

### 1.3 RemoteRuntime——对接外部沙箱

RemoteRuntime 是 OpenHands 最灵活的 Runtime——它不自己创建沙箱，而是通过自定义 HTTP API 连接到外部管理的沙箱服务。

**工作方式**：RemoteRuntime 通过 HTTP API 调用外部沙箱服务的"创建沙箱→执行命令→返回结果→销毁沙箱"接口。这意味着 OpenHands Agent 可以在 E2B、Daytona、GKE Agent Sandbox 或任何提供 HTTP API 的沙箱平台上运行。

**价值**：RemoteRuntime 让 OpenHands 不绑定特定的沙箱技术——用户可以根据安全需求和成本预算选择最适合的外部沙箱。这种"沙箱后端可插拔"的设计与 Kata Containers 的"VMM 可插拔"（Dragonball/QEMU/Cloud Hypervisor/Firecracker）理念一致——把隔离实现的选择权留给用户。

### 1.4 ModalRuntime——Serverless 沙箱

ModalRuntime 使用 Modal 平台执行 Agent 操作——Modal 是一个 Serverless 计算平台，基于 gVisor 隔离。

**Modal 的优势**：
- **子秒级调度**——不需要预分配服务器，按需启动
- **10 万+ 并发沙箱**——Modal 的基础设施可以支撑大规模并发
- **GPU 支持**——H100 和 A100 GPU 可用于 Agent 的 ML 工作负载
- **分布式存储**——`modal.Volume` 提供跨沙箱的持久化存储
- **按使用付费**——只支付实际计算时间，不支付空闲时间

**Modal 的隔离**：Modal 使用 gVisor 作为沙箱隔离——[[05 gVisor——用户空间内核的系统调用拦截|第 5 篇]]讨论的用户空间内核方案。这比 Docker 容器更强（系统调用不直达宿主内核），但比 Firecracker MicroVM 弱（需要逃逸 Sentry 而非 hypervisor）。

### 1.5 ActionExecutor——沙箱内的执行核心

OpenHands Runtime 中的 `ActionExecutor` 是沙箱内的核心组件——它接收来自 Event Stream 的 Action，在沙箱内执行，并生成 Observation 返回。理解 ActionExecutor 的能力边界对于评估 OpenHands 沙箱的安全模型至关重要。

**ActionExecutor 的能力集**：
- **Bash 执行**：在沙箱内执行任意 shell 命令——这是 Agent 的核心"行动能力"
- **文件操作**：读写文件、创建目录、列出文件——Agent 通过这些操作修改代码库
- **IPython 执行**：在 Jupyter IPython 环境中执行 Python 代码——支持交互式代码执行和状态保持
- **浏览器操作**：通过 BrowserEnv（基于 Playwright 的 Chromium）进行网页浏览——Agent 可以打开网页、点击、输入、截图

**安全边界**：ActionExecutor 的能力集定义了 Agent 在沙箱内"能做什么"——但它不限制"怎么做"。例如，Bash 执行允许任意命令——包括 `rm -rf` 或 `curl evil.com`。安全限制需要由沙箱的底层隔离机制（容器/gVisor/MicroVM）和网络策略（Egress 过滤）提供，而非由 ActionExecutor 自身。这是"能力"与"限制"的分离——ActionExecutor 提供"能力"（能执行什么类型的操作），底层沙箱提供"限制"（这些操作的副作用被限制在沙箱内）。

**预构建镜像的快速启动**：OpenHands 支持预构建的 Docker 镜像——`DockerWorkspace` 从预构建镜像启动，跳过运行时安装步骤，实现快速启动。这对于"每次请求创建新沙箱"的交互式场景很重要——如果每次启动都从 base image 开始安装依赖，启动时间可能长达数分钟；预构建镜像把安装步骤移到了构建时，运行时启动只需要秒级。

### 1.6 从 SSH 到 EventStream 的架构演进

OpenHands 早期版本使用 SSH 通信——backend 通过 SSH 连接到 Docker 容器内执行命令。这种方式的痛点在于：SSH 连接管理复杂（超时、重连、认证）、不支持任意 Docker image（需要预装 SSH server）、难以扩展到非 Docker Runtime。

后续版本迁移到 EventStream + REST API 架构——backend 通过 HTTP 调用容器内 Action Execution Server 的 `/execute_action` 端点。这消除了 SSH 依赖，支持任意 Docker image（runtime client `od-runtime-client` 自动安装到沙箱中），并使得 Remote Runtime 和 Modal Runtime 等非 Docker 实现成为可能。这个架构演进展示了"从紧耦合到松耦合"的典型工程进化——SSH 是"与特定通信协议绑定"的紧耦合，REST API 是"与协议无关"的松耦合。松耦合的架构让 OpenHands 可以灵活适配多种沙箱后端，而不被任何特定的通信协议或沙箱技术锁定——这是开源项目保持"技术中立"的关键设计原则。

---

## 第 2 章 Modal Sandboxes——gVisor 的 Serverless 实践

### 2.1 Modal 的定位

Modal 不是"Agent 专用"的沙箱平台——它是一个通用的 Serverless 计算平台，但因为其"子秒级启动 + gVisor 隔离 + 大规模并发 + GPU 支持"的特性，被广泛用于 Agent 代码执行。

### 2.2 Modal Sandboxes 的特性

**gVisor 隔离**：每个 Modal Sandbox 在 gVisor 隔离中运行——系统调用由 Sentry 处理，不直达宿主内核。这让 Modal 适合运行"半可信"的代码——如 AI 生成的代码——虽然不如 Firecracker MicroVM 强，但比传统容器安全。

**子秒级调度**：Modal 的基础设施可以子秒级启动新沙箱——不需要像 Firecracker 那样等待 ~125ms 的 VM 启动。这对于"每次用户请求创建新沙箱"的交互式 Agent 场景很有价值。

**10 万+ 并发**：Modal 的架构设计支持在单租户上运行 10 万+ 并发沙箱——这远超传统容器编排系统（如 Kubernetes）的典型密度。对于"高并发 Agent 服务"（如面向大量用户的 AI 助手），Modal 的并发能力是一个关键优势。

**GPU 支持**：Modal 支持 H100 和 A100 GPU——Agent 可以在沙箱中运行 ML 推理（如本地 LLM 推理、图像生成）。这是 E2B（基于 Firecracker，不支持 GPU）不具备的能力。

**出站网络控制**：Modal 支持配置沙箱的出站网络——可以限制 Agent 代码能访问的外部服务。这是 [[10 Egress 网络过滤——防止 Agent 泄漏的出站控制|第 10 篇]]讨论的 Egress 过滤在 Modal 上的实现。

### 2.3 Modal 在 Agent 场景中的应用

**代码执行 Agent**：Agent 通过 Modal Sandbox 执行 AI 生成的代码——Modal 的 gVisor 隔离确保代码执行不影响宿主机，子秒级启动确保交互体验。

**ML 推理 Agent**：Agent 在 Modal GPU Sandbox 中运行 ML 模型——如生成图像、运行本地 LLM、做数据分析。GPU 沙箱让 Agent 不依赖外部 API 即可做 ML 推理。这对于"Agent 需要运行特定模型但不想暴露 API Key 给外部服务"的场景特别有价值——模型在沙箱内运行，数据和模型都不离开沙箱。

**数据处理 Agent**：Agent 在 Modal Sandbox 中处理大量数据——Modal 的分布式存储（`modal.Volume`）让数据可以跨沙箱共享，多个 Agent 沙箱可以并行处理不同部分的数据。这种"并行数据处理"模式适用于"Agent 需要分析大型数据集"的场景——每个沙箱处理一个分片，最后汇总结果。

**Modal Sandbox 的代码示例**：
```python
import modal

# 创建一个 Modal Sandbox
sandbox = modal.Sandbox.create(
    "python", "-c", "print('Hello from Modal Sandbox!')",
    cpu=1, memory_gb=2,
    timeout=60,
)
sandbox.wait()
print(sandbox.stdout())
```

这个简单的示例展示了 Modal Sandbox 的核心 API——`Sandbox.create()` 创建沙箱，指定 CPU/内存/超时，`sandbox.wait()` 等待完成，`sandbox.stdout()` 获取输出。API 设计极其简洁——与 E2B 的 `Sandbox.create()` + `run_code()` 在简洁性上相当，但 Modal 的定位更通用（不只是 Agent 代码执行），因此没有 E2B 的 Code Interpreter 等高级抽象。

### 2.4 Modal 的成本模型

Modal 采用"按使用付费"模型——按 CPU 秒、GPU 秒和内存 GB·秒计费。对于 Agent 沙箱场景，这意味着：
- Agent 活跃执行时按实际资源使用付费
- Agent 空闲时（如果沙箱还在运行）仍按资源占用付费——但可以通过 `modal.Sandbox.terminate()` 主动销毁空闲沙箱
- GPU 按秒计费——H100 约 $3.4/小时，A100 约 $1.5/小时——对于"偶尔需要 GPU"的 Agent 任务，按秒计费比"租一台 GPU 服务器"便宜得多

与 GKE Agent Sandbox 的"warm/cold pool + suspend/resume"策略相比，Modal 的成本模型更简单（纯按使用付费）但不具备"suspend 不计 CPU"的优势——Modal 没有 suspend/resume，只有"运行中"和"已终止"两种状态。对于"Agent 需要长时间保留状态但中间有空闲期"的场景，Fly.io 的 suspend/resume 或 GKE 的 Pod Snapshots 更有成本优势。

---

## 第 3 章 Fly.io Machines——Firecracker + Suspend/Resume

### 3.1 Fly.io 的 Firecracker 实践

Fly.io 是一个"从边缘到中心"的云计算平台——它的 Machines 底层使用 Firecracker MicroVM。Fly.io 的独特价值在于对 Firecracker 的"suspend/resume"增强——让 MicroVM 可以像进程一样挂起和恢复。

### 3.2 Suspend/Resume 对 Agent 的价值

**问题**：Agent 的工作模式通常是"bursty"的——短时间内活跃处理请求，然后长时间等待用户输入或外部触发。如果沙箱在等待期间持续运行，它消耗 CPU 和内存资源但不做有用的工作——浪费成本。

**Fly.io 的解决方案**：Machines 支持 suspend（挂起）和 resume（恢复）——挂起的 Machine 不对 CPU 和 RAM 计费，只对 root filesystem 计费。这意味着一个"每天活跃 1 小时、等待 23 小时"的 Agent，只需要支付 1 小时的 CPU/RAM 费用 + 23 小时的存储费用——远低于"24 小时持续运行"的费用。

**GKE Agent Sandbox 的类似策略**：GKE Agent Sandbox 也有类似的概念——"standby capacity buffers"（挂起的 VM 组成的冷池）。挂起的沙箱可以快速恢复到就绪状态——比从零启动新沙箱快。这种"冷池 + 热池"的两级策略让 GKE Agent Sandbox 在"亚秒级分配"和"最小化空闲成本"之间取得平衡。

### 3.3 Fly.io 的全球边缘部署

Fly.io 的独特定位是"边缘计算"——它的数据中心分布在全球多个地区，Agent 沙箱可以部署在离用户最近的边缘节点。这对于"延迟敏感"的 Agent 场景有独特价值——如果 Agent 需要与用户实时交互（如 Coding Agent 在 IDE 中工作），把沙箱部署在离用户最近的边缘节点可以减少网络延迟。

**与 GKE 的对比**：GKE 的节点通常在少数几个区域（如 us-central1、europe-west1），用户可能距离节点很远。Fly.io 的边缘节点遍布全球——包括很多 GKE 没有覆盖的小城市。但 GKE 的优势是"与 Kubernetes 生态的深度集成"——而 Fly.io 有自己的 API 和工具链，不与 K8s 原生集成。

### 3.4 Fly.io 的私有网络

Fly.io Machines 可以通过 Fly.io 的私有网络互联——同一个 Fly.io 应用内的 Machines 可以通过私有 IPv6 网络通信，不经过公网。这对于"多个 Agent 沙箱需要协作"的场景很有价值——Agent A 的沙箱和 Agent B 的沙箱可以通过私有网络交换数据，不需要暴露到公网。

这种"沙箱间私有通信"能力在 E2B 和 Daytona 中不直接提供——E2B 的沙箱之间默认隔离，需要通过外部服务（如消息队列）协作。Fly.io 的私有网络让"多 Agent 系统"的沙箱编排更自然——每个 Agent 在自己的 Machine 中隔离运行，但通过私有网络可以高效通信。

### 3.5 Fly.io 的 GPU 支持

Fly.io 也支持 GPU——L40S GPU 可用于 Agent 的 ML 工作负载。与 Modal 的 H100/A100 不同，Fly.io 用的是 L40S——这是 NVIDIA 的"推理优化"GPU，适合推理而非训练。对于"Agent 做本地 LLM 推理"的场景，L40S 的性价比可能高于 H100。

---

## 第 4 章 GKE Agent Sandbox——生产级 Agent 沙箱标杆

### 4.1 产品架构

GKE Agent Sandbox 是 2025 年 11 月 GA 的 Kubernetes 原生 Agent 沙箱——基于 gVisor（也支持 Kata Containers），提供 Kubernetes 原生的沙箱管理 API。[[01 Agent 沙箱全景——为什么代码执行 Agent 需要隔离|第 1 篇]]已经介绍了它的基本数据（16 倍增长、75% 成本降低），本文深入其架构和生产实践。

**核心组件**：

**SandboxTemplate**：定义沙箱的"模板"——指定隔离后端（gVisor/Kata）、资源限制（CPU/内存）、网络策略、预安装的包等。管理员创建不同的 SandboxTemplate 适用于不同类型的 Agent 任务——如"低风险 Python 执行"模板用 gVisor + 1 核 512MB，"高风险不可信代码"模板用 Kata + 2 核 2GB + 严格网络策略。

**Sandbox API**：Kubernetes 自定义 API——创建、列表、删除沙箱。与 Kubernetes 的其他 API 一样，支持 RBAC、审计日志、admission webhook。

**Warm Pool（预热线池）**：预配置好的沙箱池——新请求来时从池中分配，而非从零创建。GKE Agent Sandbox 的预热线池支持 300 个沙箱/秒/集群的分配速率，90% 的分配在 200ms 内完成——这是"亚秒级沙箱配置"的关键。

**Cold Pool（冷池）**：由 suspended VM 组成的"冷"池——比 warm pool 更节省资源（不对 CPU/RAM 计费），但恢复比 warm pool 慢。当 warm pool 不足时，从 cold pool 恢复补充。

**Pod Snapshots**：GKE 独有功能——对运行中的 Pod 做完整检查点，后续从检查点恢复。这让 Agent 沙箱可以"暂停→保存状态→稍后恢复"——对于长时 Agent 任务的跨会话状态持久化至关重要。

### 4.2 Default-Deny 网络策略

GKE Agent Sandbox 默认采用 **Default-Deny** 网络策略——沙箱默认不能访问任何外部网络。需要网络访问的沙箱必须在 SandboxTemplate 中显式配置允许的网络目标。

**Template-Level Shared Network Policy**：一个 NetworkPolicy 应用于所有从同一个 SandboxTemplate 创建的沙箱——管理员在模板中定义"允许访问哪些外部服务"，所有该模板的沙箱共享这个策略。这简化了网络策略管理——不需要为每个沙箱单独配置。

**与 Egress 过滤的关系**：Default-Deny + 显式白名单是 [[10 Egress 网络过滤——防止 Agent 泄漏的出站控制|第 10 篇]]讨论的 Egress 过滤在 GKE Agent Sandbox 中的实现方式。这种"默认拒绝 + 按需允许"的策略是 Agent 沙箱安全的核心——防止被 Prompt Injection 诱导的 Agent 连接攻击者服务器。

**SandboxTemplate 网络策略配置示例**：
```yaml
apiVersion: agent-sandbox.gke.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: agent-python-sandbox
spec:
  runtime: gvisor  # 使用 gVisor 隔离
  resources:
    cpu: "1"
    memory: "512Mi"
  network:
    defaultDeny: true  # 默认拒绝所有出站
    allowedEgress:
      - to: "api.openai.com"  # 允许访问 OpenAI API
        ports: [443]
      - to: "pypi.org"  # 允许安装 Python 包
        ports: [443]
      - to: "10.0.0.0/8"  # 允许内网访问
        ports: [443, 5432]
```

这个示例展示了 GKE Agent Sandbox 的网络策略配置——默认拒绝所有出站，只允许访问 OpenAI API、pypi.org 和内网。这种"FQDN 白名单 + IP CIDR"的混合策略让管理员可以精确控制 Agent 沙箱能访问哪些外部服务——既满足 Agent 的工作需求（需要调 LLM API、安装包），又防止数据外泄（不允许访问任意外部服务器）。

### 4.3 Agent Substrate——超大规模编排

2025 年 11 月，Google 还宣布了 Agent Substrate——GKE Agent Sandbox 之上的编排层，解决"超大规模 Agent"的密度需求。

**核心能力**：实时将 Agent 移入/移出就绪计算容量——当 Agent 需要执行时，快速分配计算资源；当 Agent 空闲时，释放资源给其他 Agent 使用。这种"按需分配 + 即时释放"的编排模式让数千甚至数万个 Agent 可以在有限的基础设施上高效运行。

**与 Warm/Cold Pool 的关系**：Agent Substrate 管理的是"Agent 级别的编排"——决定哪个 Agent 何时运行、在哪个节点上运行。Warm/Cold Pool 是"沙箱级别的资源管理"——管理预配置的沙箱池。两者是"上层编排 + 下层资源"的关系。

### 4.4 生产数据深度

**16 倍增长**：从 2025 年 11 月预览到 2026 年 4 月 GA，5 个月内沙箱数量增长 16 倍——这个增长速度反映了生产环境对 Agent 沙箱的强烈需求。

**75% 成本降低**：Google 报告"与替代方案相比，GKE Agent Sandbox 可以将每个 Agent 的成本降低 75%"。这个成本降低来自多个因素：gVisor 的高密度（不需要 Guest OS）、warm pool 减少冷启动开销、cold pool 减少空闲成本、Pod Snapshots 减少初始化时间。

**40%+ 密度提升**：从 MicroVM 迁移到 gVisor，同样硬件上可以部署 40%+ 更多 Agent——gVisor 不需要为每个沙箱运行一个 Guest OS 内核，内存开销远低于 MicroVM。

**300 沙箱/秒/集群**：warm pool 的分配速率——每秒可以分配 300 个沙箱，90% 在 200ms 内完成。这个分配速率确保了"流量高峰期快速扩容"的能力。

> [!info] 核心概念：GKE Agent Sandbox 是"K8s 原生 + 生产验证"的 Agent 沙箱
> GKE Agent Sandbox 的核心价值不是"发明了新技术"——gVisor、Kata、网络策略都是已有技术。它的核心价值是"把这些技术组合成一个 K8s 原生的、生产验证的 Agent 沙箱解决方案"——让企业不需要自己从 gVisor/Kata/网络策略/Snapshot 等组件拼凑一个沙箱平台，而是直接在 GKE 上启用 Agent Sandbox。这种"集成解决方案"的价值在于"降低了采用门槛"——与 E2B/Daytona 的"Agent 原生 API"不同，GKE Agent Sandbox 的价值主张是"K8s 原生集成 + Google 的生产验证"。

---

## 第 5 章 通用平台 vs Agent 专用平台

Pod Snapshots 是 GKE Agent Sandbox 最独特的能力——对运行中的 Pod 做完整检查点。理解其技术实现对于评估其适用场景很重要。

**检查点的内容**：Pod Snapshot 包含 Pod 的完整状态——进程内存、文件系统状态、网络连接状态、打开的文件描述符等。恢复时，Pod 从快照点继续运行，就像"时间停止后恢复"一样。

**与 CRIU 的关系**：CRIU（Checkpoint/Restore In Userspace）是 Linux 上的容器检查点/恢复工具——[[05 gVisor——用户空间内核的系统调用拦截|第 5 篇]]提到 gVisor 不支持 CRIU。但 GKE Agent Sandbox 的 Pod Snapshots 不依赖 CRIU——它使用的是 GKE 独有的检查点机制，可能在更底层（如 KVM 层面或 GKE 的节点级机制）实现。这也是为什么 Pod Snapshots 能在 gVisor 沙箱上工作——它不依赖 gVisor 内部的 CRIU 支持。

**对 Agent 沙箱的价值**：
- **预热沙箱**：预先配置好开发环境的沙箱做 snapshot——新请求来时从 snapshot 启动，秒级而非分钟级。这比"warm pool"更进一步——warm pool 中的沙箱仍在运行（消耗资源），snapshot 中的沙箱不在运行（不消耗 CPU/RAM），但可以快速恢复
- **跨会话状态持久化**：Agent 工作到一半时做 snapshot，下次会话从 snapshot 恢复——不丢失工作进度。这对于"多日任务"的 Agent 至关重要
- **故障恢复**：沙箱崩溃后从最近的 snapshot 恢复——减少故障造成的工作损失

**限制**：Pod Snapshots 目前是 GKE 独有功能——不支持非 GKE 的 Kubernetes 集群。这意味着使用 Pod Snapshots 需要 vendor lock-in 到 GKE。对于需要"跨云可移植"的 Agent 沙箱，需要使用替代方案（如 E2B 的 pause/resume 或 Fly.io 的 suspend/resume）。

### 5.1 两种路线的对比

| 维度 | Agent 专用平台（E2B/Daytona） | 通用平台（GKE Agent Sandbox/Modal/Fly.io） |
| :--- | :--- | :--- |
| **API 抽象层级** | 高（`Sandbox.create()` / `run_code()`） | 低到中（K8s API / 平台 API） |
| **Agent 友好性** | 高（Code Interpreter / Manifest / Computer Use） | 低（需要自行构建高级抽象） |
| **K8s 集成** | 无或间接 | 原生（GKE）或独立（Modal/Fly.io） |
| **生产规模验证** | 中等 | 高（GKE 16 倍增长 / Modal 10 万并发 / Fly.io 全球边缘） |
| **成本** | 按使用付费（托管）或自托管 | GKE 75% 成本降低 / Modal 按使用付费 / Fly.io suspend 不计 CPU |
| **自托管** | 支持 | GKE 需要 GKE 集群 / Modal 不支持 / Fly.io 不支持 |
| **GPU 支持** | E2B ❌ / Daytona ✅ | Modal ✅ / Fly.io ✅ / GKE 取决于节点 |

### 5.2 什么时候选什么

**选 Agent 专用平台（E2B/Daytona）的场景**：
- Agent 开发团队小，不想投入基础设施工程——E2B/Daytona 的高级 API 让小团队也能快速构建 Agent 沙箱
- 需要 Code Interpreter 功能——E2B 的 Jupyter 风格代码执行是 Modal/Fly.io 不提供的
- 使用 OpenAI Agents SDK——Daytona 的原生集成让集成成本最低

**选通用平台（GKE/Modal/Fly.io）的场景**：
- 已有 K8s 基础设施——GKE Agent Sandbox 是最自然的扩展，不需要学习新的 API 和工具链
- 需要大规模生产验证——GKE 的 16 倍增长和 75% 成本降低是硬数据，Modal 的 10 万并发和 Fly.io 的全球边缘都是生产级验证
- 需要 GPU + Serverless——Modal 的 H100/A100 + 子秒级调度组合独特，适合"偶尔需要 GPU"的 Agent 任务
- 需要 suspend/resume 节省成本——Fly.io 的 suspend 不计 CPU/RAM，对于"bursty"工作模式的 Agent 极具成本优势
- 需要全球低延迟——Fly.io 的边缘节点让 Agent 沙箱可以部署在离用户最近的位置，减少交互延迟

**混合策略的可能性**：生产环境中不必"二选一"——可以根据 Agent 任务的特性使用不同的平台。例如：交互式 Agent（需要低延迟）用 Fly.io 边缘部署；批量处理 Agent（需要高密度）用 GKE Agent Sandbox；ML 推理 Agent（需要 GPU）用 Modal；代码解释 Agent（需要 Code Interpreter）用 E2B。这种"按任务特性选择平台"的混合策略需要一个统一的编排层来管理跨平台的沙箱——目前这需要自研，但未来可能出现"跨平台 Agent 沙箱编排器"（类似于 Kubernetes 跨云集群管理）。

> [!warning] 生产避坑：不要在"Agent 专用"和"通用"之间过度纠结
> Agent 专用平台和通用平台的界限正在模糊——GKE Agent Sandbox 的 SandboxTemplate 越来越像 E2B 的模板系统，Daytona 也支持 K8s 集成。选型的关键不是"这个平台是不是 Agent 专用的"，而是"这个平台的 API/SDK/集成方式是否匹配我的团队和基础设施"。如果你的团队深度使用 K8s，GKE Agent Sandbox 的 K8s 原生体验比 E2B 的独立 API 更自然。如果你的团队是"两三个开发者快速构建 AI 产品"，E2B 的 `Sandbox.create()` 比管理 K8s 集群更高效。

---

## 第 6 章 总结与下一篇导读

### 6.1 本文核心要点

1. **OpenHands 四种 Runtime**：Docker（本地默认）/ Remote（外部沙箱对接）/ Modal（Serverless gVisor）/ Local（无隔离开发）——"沙箱后端可插拔"的设计让 OpenHands 不绑定特定隔离技术
2. **Modal Sandboxes**：gVisor 隔离 + 子秒级调度 + 10 万并发 + GPU（H100/A100）——通用的 Serverless 平台被广泛用于 Agent 代码执行
3. **Fly.io Machines**：Firecracker + suspend/resume——挂起的 Machine 不计 CPU/RAM 费用，对 Agent 的"bursty"工作模式极具成本优势
4. **GKE Agent Sandbox 生产实践**：SandboxTemplate 机制 + Warm Pool 300/秒 + Cold Pool 挂起池 + Pod Snapshots 检查点恢复 + Default-Deny 网络 + Agent Substrate 超大规模编排——16 倍增长、75% 成本降低、40% 密度提升
5. **通用平台 vs Agent 专用平台**：通用平台优势是"成熟基础设施 + 生产验证 + 低成本"，劣势是"需要更多集成工作"；Agent 专用平台优势是"高级 API + 开箱即用"，劣势是"规模和成本不如通用平台"
6. **选型不在于"是否 Agent 专用"而在于"是否匹配团队和基础设施"**：K8s 深度用户→GKE，小团队快速构建→E2B，需要 GPU + Serverless→Modal，需要 suspend/resume→Fly.io

### 6.2 下一篇导读

本文完成了"Agent 沙箱平台"主题的讨论。接下来第 10-12 篇将转向"安全控制"主题——第 10 篇 [[10 Egress 网络过滤——防止 Agent 泄漏的出站控制]] 深入 Egress 网络过滤的实现（iptables/nftables/eBPF/NetworkPolicy/FQDN 白名单），讨论为什么 Agent 沙箱必须做出站控制以及如何防止 Agent 泄漏 API Key 和敏感数据。

> [!info] 专栏导航
> 本文是 [[00 专栏导览|Agent 沙箱与隔离技术专栏]] 的第 9 篇。前 9 篇完成了"底层隔离技术 + Agent 沙箱平台"的完整讨论；接下来第 10-12 篇将完成"安全控制"主题。

---

## 参考文献

1. OpenHands. "Runtime Architecture." https://docs.openhands.dev/openhands/usage/architecture/runtime
2. OpenHands Runtime README. https://github.com/OpenHands/OpenHands/blob/main/openhands/runtime/README.md
3. Modal. "Sandboxes." https://modal.com/products/sandboxes
4. Fly.io. "Machines Documentation." https://fly.io/docs/machines/
5. Google. "Reduce your agent's costs by 75% with GKE Agent Sandbox." https://cloud.google.com/blog/products/containers-kubernetes/reduce-your-agents-costs-with-gke-agent-sandbox
6. Google. "Bringing you Agent Sandbox on GKE and Agent Substrate." https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate
7. Google. "About GKE Agent Sandbox." https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox
8. Google. "Agentic AI on Kubernetes and GKE." https://cloud.google.com/blog/products/containers-kubernetes/agentic-ai-on-kubernetes-and-gke

---

## 思考题

1. **OpenHands 的 RemoteRuntime 可以对接任何提供 HTTP API 的沙箱服务。如果要把 OpenHands 对接到 E2B，需要实现哪些接口？这个对接的工程量有多大？** 提示：考虑 OpenHands 的 Action 类型——`CmdRunAction`（执行命令）、`FileWriteAction`（写文件）、`BrowseURLAction`（浏览 URL）等——每种 Action 都需要翻译成 E2B SDK 的等价操作。对接的工程量取决于两种 API 的语义匹配度——如果 E2B 的 `run_code` 和 `commands.run` 能覆盖 OpenHands 的 Action 类型，对接相对简单。

2. **GKE Agent Sandbox 报告"75% 成本降低"——但这个对比的基准是什么？如果基准是"传统 VM 上运行 Agent"，75% 降低可信；如果基准是"Firecracker MicroVM"，可能没有这么大的差距。如何评估这个数字的可靠性？** 提示：考虑"成本对比的基准选择"——Google 的博客中提到"从 MicroVM 迁移到 GKE Agent Sandbox"获得 40% 密度提升，75% 的成本降低可能是与"静态 VM 分配"（每个 Agent 一个 VM，空闲时不释放）对比。了解对比基准是评估营销数字可靠性的关键。

3. **Modal 支持 10 万+ 并发沙箱——但 10 万个 gVisor 沙箱的内存开销总量是多少？是否真的可以在单租户上运行？** 提示：考虑 gVisor 的内存开销——每个 Sentry 进程需要内存（中等开销，取决于工作负载）。10 万个 Sentry 进程的内存总量可能达到数百 GB——需要大型服务器或分布式集群。Modal 的"10 万并发"可能是"分布式跨多台服务器"的总和，而非"单台服务器上 10 万"。
