| English | 中文 | Notes |
|---|---|---|
| system design interview | 系统设计面试 | 讨论分布式系统、容量规划、权衡与沟通能力的工程面试环节 |
| tradeoff | 权衡 | 系统设计不是追求唯一正确答案，而是在约束下做取舍 |
| scalability | 可扩展性 | 指服务能够低成本、低摩擦地随负载变化调整资源 |
| stateless service | 无状态服务 | 便于水平扩缩容，状态通常外置到数据库或缓存 |
| GeoDNS | 地理 DNS 调度 | 按用户地理位置把流量导向更近的数据中心 |
| cache | 缓存 | 以空间换时间，降低后端与数据库压力 |
| content delivery network | 内容分发网络 | 在多个边缘节点缓存静态资源，就近服务用户 |
| continuous integration | 持续集成 | 频繁合并代码并自动执行测试与构建 |
| continuous deployment | 持续部署 | 将变更以自动化方式推送到生产环境 |
| Infrastructure as Code | 基础设施即代码 | 用声明式配置管理机器、网络、数据库和权限等基础设施 |
| feature toggle | 特性开关 | 按用户、流量或环境控制功能显隐 |
| functional partitioning | 功能分区 | 按职责把系统拆分到不同服务或集群 |
| API gateway | API 网关 | 统一承载认证、限流、审计、路由等横切能力 |
| service mesh | 服务网格 | 用 sidecar 或等价机制统一治理服务间通信 |
| sidecar pattern | Sidecar 模式 | 与主服务同机部署代理或辅助进程，承接治理逻辑 |
| CQRS | 命令查询职责分离 | 把写路径与读路径拆开，分别优化 |
| extract transform load | 提取-转换-加载 | 从源系统抽取数据，清洗转换后加载到目标系统 |
| streaming ETL | 流式 ETL | 持续处理事件流，追求秒级或分钟级响应 |
| bare metal | 裸金属 | 自建并自管物理机与数据中心 |
| vendor lock-in | 供应商锁定 | 系统深度依赖某家云厂商，迁移成本变高 |
| serverless | 无服务器 | 以事件触发、按调用计费的函数或托管执行模式 |
| Function as a Service | 函数即服务 | 一类典型 Serverless 形态，如 AWS Lambda |
| cold start | 冷启动 | 函数首次调用时创建运行时与容器所产生的额外时延 |
