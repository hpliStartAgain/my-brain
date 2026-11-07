"""标签受控词表 —— 由 scripts/converge_tags.py 使用。

规则：
- MERGE：同义/大小写变体 → 规范名（遵循 AGENTS.md：Go→Golang、K8s→Kubernetes）
- DROP：信息量低的泛化标签，直接不作为标签（转入 keywords）
- 其余：合并后全站出现次数 >= MIN_COUNT 的进入词表；不在词表里的转入 keywords
"""

MIN_COUNT = 6

MERGE = {
    # 语言 / 平台
    "go": "Golang", "golang": "Golang", "k8s": "Kubernetes", "kubernetes": "Kubernetes",
    "springboot": "SpringBoot", "spring boot": "SpringBoot",
    # 性能
    "性能调优": "性能优化", "调优": "性能优化", "性能工程": "性能优化", "性能分析": "性能优化",
    "系统性能": "性能优化", "systemsperformance": "性能优化",
    # 架构
    "架构": "软件架构", "架构设计": "软件架构",
    "分布式": "分布式系统", "分布式架构": "分布式系统",
    # 可观测 / 运维
    "故障定位": "故障排查", "生产运维": "运维", "aiops": "AIOps",
    "grafana loki": "Loki", "loki": "Loki",
    # 存储 / 数据库
    "b+tree": "B+树", "b+树": "B+树", "acid": "事务", "bloomfilter": "布隆过滤器",
    "布隆过滤器": "布隆过滤器", "lsm-tree": "LSM-Tree", "lsm tree": "LSM-Tree",
    # 运行时
    "垃圾回收": "GC", "gc": "GC", "bpf": "eBPF", "ebpf": "eBPF", "内存": "内存管理",
    "并发": "并发编程", "cgroup": "cgroups",
    # 调度
    "调度器": "调度", "调度系统": "调度", "scheduler": "调度",
    # 算法
    "分治法": "分治", "贪心": "贪心算法", "dp": "动态规划",
    # 一致性
    "共识": "共识算法", "exactly once": "Exactly-once", "exactly-once": "Exactly-once",
    # Agent
    "controller": "控制器模式", "控制器": "控制器模式",
    "b+树索引": "B+树", "向量检索": "向量数据库",
    "hermes-agent": "Hermes Agent", "agent sandbox": "Agent Sandbox", "agent沙箱": "Agent Sandbox",
}

DROP = {
    "实战", "工程实践", "生产实践", "源码分析", "选型", "部署", "原理", "最佳实践",
    "入门", "总结", "笔记", "学习笔记", "教程", "概述", "基础", "生命周期",
}
