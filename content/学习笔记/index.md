# 欢迎来到汀的知识碎片


> [!quote] 保持敏锐，持续观测
> 这里是我的个人数字花园。我是一名为大数据集群基础设施护航的 SRE，热衷于探索系统底层的运转逻辑，也喜欢捕捉生活中的细腻碎片。

欢迎来到这片还在不断生长的赛博空间。这里的知识没有严格的线性顺序，你可以通过左侧的资源管理器自由探索，或者通过全局搜索直达目标。

### 🧭 核心领域路由 (Core Routing)

你可以把这里当作我的个人 Runbook 和思考沉淀池，目前主要分为以下几个可用区：

| 领域分类 | 关注重点 | 核心技术栈 |
| :--- | :--- | :--- |
| **[[数据基建与高可用]]** | 集群稳定性、冷热存储分离、计算引擎优化 | Hadoop, Spark, Flink, Kafka |
| **[[可观测性体系]]** | 从零构建监控、根因分析 (RCA) 引擎建设 | Prometheus, Grafana, Zabbix |
| **[[底层与并发探索]]** | 探究框架源码与系统级网络通信机制 | Go, Java (JVM/Netty), Linux C |
| **[[AI 智能体实验]]** | 探索将大模型引入自动化运维与 SQL 质量分析 | LLM, AI Agents, Prompt Engineering |

### 🗺️ 知识拓扑概览

如果按系统的生命周期来划分我的思考域，它大概呈现如下的拓扑结构：

```mermaid
graph TD
    subgraph 基础设施层
        A[Data Infra] --> B(Hadoop 核心组件);
        A --> C(实时计算/Kafka);
    end

    subgraph 稳定性保障
        D[SRE 观测塔] --> E{Prometheus 体系};
        E -->|Metrics| F[自动化告警与 RCA];
        E -->|Tracing| G[性能瓶颈定位];
    end

    subgraph 研发与基建
        H[技术栈深潜] --> I[Go 语言高并发];
        H --> J[Java/JVM 调优];
        H --> K[Linux C 网络编程];
    end

    A -.依赖.-> D
    H -.赋能.-> A