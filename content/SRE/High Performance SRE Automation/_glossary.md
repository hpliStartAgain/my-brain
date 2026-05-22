| 英文                                 | 中文       | 说明                                      |
| ---------------------------------- | -------- | --------------------------------------- |
| Site Reliability Engineering (SRE) | 站点可靠性工程  | 通过软件工程方法解决运维问题的实践                       |
| Service Level Objective (SLO)      | 服务级别目标   | 服务可靠性目标值，如 99.9% 可用性                    |
| Service Level Indicator (SLI)      | 服务级别指标   | 衡量服务质量的量化指标                             |
| Service Level Agreement (SLA)      | 服务级别协议   | 与服务消费者签订的正式可靠性承诺                        |
| Error Budget                       | 错误预算     | SLO 未达标所允许的容错空间                         |
| Incident Management                | 事件管理     | 识别、响应和解决服务中断的流程                         |
| Root Cause Analysis (RCA)          | 根因分析     | 识别问题根本原因的系统性方法                          |
| Post-mortem                        | 事后复盘     | 事件发生后的事后审查与分析                           |
| Chaos Engineering                  | 混沌工程     | 通过主动注入故障验证系统弹性的实践                       |
| Capacity Planning                  | 容量规划     | 预测和规划系统资源需求的流程                          |
| On-call                            | 值班       | SRE 轮班待命响应事件的制度                         |
| Observability                      | 可观测性     | 通过外部输出理解系统内部状态的能力                       |
| Monitoring                         | 监控       | 系统化观察和测量系统性能的实践                         |
| DevOps                             | DevOps   | 融合开发与运维的理念与实践                           |
| Reliability                        | 可靠性      | 系统在预期条件下正确运行的能力                         |
| Availability                       | 可用性      | 系统能正常服务的时间百分比                           |
| Latency                            | 延迟       | 系统响应请求所需的时间                             |
| Throughput                         | 吞吐量      | 系统单位时间内处理的请求量                           |
| MTTR                               | 平均修复时间   | Mean Time To Repair，修复故障的平均耗时           |
| MTTD                               | 平均发现时间   | Mean Time To Detect，发现故障的平均耗时           |
| MTBF                               | 平均故障间隔   | Mean Time Between Failures，故障间的平均正常运行时间 |
| Runbook                            | 运维手册     | 标准操作流程的文档化指南                            |
| Blameless Culture                  | 无责备文化    | 事后分析聚焦系统而非个人的文化                         |
| Playbook                           | 行动手册     | 针对特定场景的标准响应流程                           |
| Automation                         | 自动化      | 通过工具和脚本减少人工操作                           |
| IaC                                | 基础设施即代码  | Infrastructure as Code，用代码管理基础设施        |
| RPA                                | 机器人流程自动化 | Robotic Process Automation              |
| Game Day                           | 演习日      | 模拟故障场景进行演练的活动                           |
| Blast Radius                       | 爆炸半径     | 故障可能影响的范围                               |
| Incident Commander                 | 事件指挥官    | 事件响应中的总负责人                              |
| First Response                     | 一线响应      | 值班工程师对事件的初步评估和处理                        |
| Escalation                         | 升级         | 将事件传递给更高级别或更专业人员处理的机制                  |
| Alert Fatigue                      | 告警疲劳      | 过多告警导致响应者忽视或错过关键告警的现象                  |
| Five Whys                          | 五问法        | 通过反复追问"为什么"找到问题根本原因的 RCA 技术            |
| Fishbone Diagram                   | 鱼骨图        | 也称石川图，按类别分析问题潜在原因的可视化 RCA 工具           |
| Fault Tree Analysis (FTA)          | 故障树分析     | 使用布尔逻辑映射故障事件链的 RCA 方法                   |
| Failure Injection                  | 故障注入      | 有意向系统引入故障以测试其韧性的方法                      |
| Steady State                       | 稳态         | 系统在正常操作条件下的基准行为                         |
| Chaos Experiment                   | 混沌实验      | 在受控条件下向系统注入故障以验证假设的实验                  |
| Simian Army                        | 猿军         | Netflix 开发的混沌工程工具套件                       |
| Anomaly Detection                  | 异常检测      | 识别偏离预期行为的数据模式或离群值的技术                    |
| Predictive Maintenance             | 预测性维护     | 利用 AI 预测系统故障并在发生前进行维护的方法                |
| Intelligent Debugging              | 智能调试      | 使用 AI 辅助识别和修复软件缺陷的方法                    |
| Natural Language Processing (NLP)  | 自然语言处理    | AI 分支，使计算机能够理解、解释和生成人类语言               |
| Sentiment Analysis                 | 情感分析      | 利用 NLP 分析用户反馈以理解用户情绪的技术                 |
| Canary Deployment                  | 金丝雀部署     | 向小部分用户逐步发布更新的部署策略                       |
| Full-cycle Developer               | 全周期开发者    | 负责服务从编码到运维全生命周期的开发人员                    |
| Golden Signals                     | 黄金信号      | 监控系统健康的四个关键指标：延迟、流量、错误、饱和度             |
| Self-healing                       | 自愈         | 系统自动检测并从故障中恢复的能力                        |
| Who Builds It Runs It              | 谁构建谁运维    | 构建服务的团队同时负责其运维的文化原则                     |
| Auto-remediation                   | 自动修复      | 系统自动执行预定义的恢复操作以解决常见问题的能力                |
