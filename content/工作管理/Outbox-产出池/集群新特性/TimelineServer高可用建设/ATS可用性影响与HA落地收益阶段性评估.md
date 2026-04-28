---
type: solution
status: draft
author: 小温
date: 2026-04-20
domain: 集群新特性
tags: [ATS, TimelineServer, YARN, MapReduce, Tez, Spark, Flink, 高可用, 影响评估]
---

# ATS 可用性影响与 HA 落地收益阶段性评估

## 1. 结论先行

当前阶段可以先下 3 条结论：

1. **RM 历史日志 500 的直接根因在 RM -> ATS RPC 链路，优先修 RM，不必把 NM 作为第一落点。**
2. **MR / Spark / Flink 暂时更像“ATS 可观测与历史链路依赖”，不能轻易上升为“ATS 挂了作业就会失败”。**
3. **Tez 不能直接套用上面的结论，必须单独验证。** 如果 Tez 在本集群中仍使用 `ATSHistoryLoggingService` / `ATSV15HistoryLoggingService` 作为 DAG 历史后端，则 ATS 不可用或初始化异常有可能影响新 DAG 启动，而不是仅仅损失观测数据。

## 2. 当前已核实的事实

### 2.1 ATS 服务端身份已经切到 HA 域名

在 ATS 所在主机 `dsrv014022` 的生效 `yarn-site.xml` 中，下面几项已经明确切到 `h3timeline.venus.sohurdc.com`：

- `yarn.timeline-service.address = h3timeline.venus.sohurdc.com:10200`
- `yarn.timeline-service.principal = yarn/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM`
- `yarn.timeline-service.keytab = /etc/security/keytabs/timeline.ha.keytab`
- `yarn.timeline-service.http-authentication.kerberos.principal = HTTP/h3timeline.venus.sohurdc.com@VENUS.SOHURDC.COM`
- `yarn.timeline-service.http-authentication.kerberos.keytab = /etc/security/keytabs/timeline.spnego.keytab`

### 2.2 RM 500 属于 ATS RPC principal mismatch

当前线上报错链路为：

`RM WebProxyServlet -> AppReportFetcher -> ApplicationHistoryProtocolPBClientImpl -> ATS RPC(10200)`

典型异常为：

- destination：`dsrv014022:10200`
- expecting：`yarn/dsrv014022...`
- actual：`yarn/h3timeline...`

这说明问题发生在 **客户端仍按旧物理机地址访问 ATS**，而不是 ATS 本机缺少 keytab。

### 2.3 combined keytab 不是并行期兜底方案

Hadoop `SaslRpcClient` 的校验逻辑会根据 **客户端配置 + 目标地址** 推导 `confPrincipal`，然后与服务端实际 principal 做精确比较。  
这意味着只要客户端仍连接 `dsrv014022`，它就会期待 `yarn/dsrv014022...`；即便 ATS keytab 中混入了 `yarn/dsrv014022...`，只要 ATS 进程实际对外身份仍是 `yarn/h3timeline...`，principal mismatch 依然存在。

## 3. 按计算引擎拆分的当前判断

| 引擎 | 当前判断 | 当前结论强度 |
|---|---|---|
| MR | ATS 更偏通用历史与展示，作业执行主链路不依赖 ATS | 高 |
| Spark on YARN | Spark History Server / eventLog 独立于 ATS，ATS 更偏 YARN 侧历史与指标 | 高 |
| Flink on YARN | Flink 运行依赖 YARN RM/NM 与 Flink 自身组件，不依赖 ATS | 高 |
| Tez | 需要单独验证，可能存在“新 DAG 启动时初始化 ATS history logging 失败”的风险 | 中 |

## 4. 为什么 Tez 是唯一需要单独核实的变量

### 4.1 官方文档侧

Tez 官方 History/UI 文档明确说明：

- `ATSHistoryLoggingService` / `ATSV15HistoryLoggingService` 会把 Tez 历史写入 YARN Timeline
- `SimpleHistoryLoggingService` 只会把历史写成文件
- **Tez UI 只支持基于 YARN Timeline 的历史存储**

### 4.2 JIRA / 故障模式侧

`TEZ-4191`、`AMBARI-15041` 一类问题显示，当 Tez 的 ATS history logging 初始化失败时，可能直接在 `DAGAppMaster` 初始化阶段报错退出。  
因此，对 Tez 而言必须区分：

1. **运行中的 DAG 遇到 ATS 中途不可用**
2. **ATS 已不可用，再新提交一个 Tez DAG**

这两种场景的结果可能不同。

## 5. 对 ATS HA 是否值得继续推进的阶段性建议

### 5.1 不能仅凭“ATS 是单点”就推进高风险收口

如果后续验证表明：

- MR / Spark / Flink 均只损失历史与可观测
- Tez 也只是 UI / history 受损，而不影响 DAG 成功率

那么 ATS HA 的收益将主要集中在：

- 历史页面连续性
- 观测数据完整性
- 运维排障效率

而它需要付出的成本却包括：

- RM 重启
- 大量 NM 分批收口
- Ambari 配置组覆盖与误配风险
- 高扰动变更对更关键组件（RM / NM）的连带风险

在这种情况下，**优先建设 ATS 告警、自动拉起、快速恢复 Runbook，可能比立刻做全链路 HA 收口更划算。**

### 5.2 但如果 Tez 新 DAG 提交会因 ATS 不可用而失败，HA 价值会立刻上升

一旦确认 Tez 新 DAG 提交存在 ATS 初始化硬依赖，那么 ATS HA 就不再只是“锦上添花”的可观测建设，而是会直接关联 Hive on Tez 的作业成功率。

## 6. 当前推荐的后续动作

1. **先修 RM 历史日志 500**  
   只核两台 RM 的生效 `yarn.timeline-service.address / principal`，优先恢复历史页面。

2. **单独验证 Tez 是否硬依赖 ATS**  
   重点区分：
   - ATS 运行中途不可用
   - ATS 已不可用后再新提交 Hive / Tez 作业

3. **在 Tez 结论未坐实前，不建议立刻推动大规模 NM 收口**

## 7. 待进一步验证的问题

### 7.1 任务 1：ATS 不可用对各类型作业真实影响验证

- MR / Tez / Spark / Flink 新提交作业是否受影响
- 运行中作业是否受影响
- Tez 是否存在“新 DAG 启动失败”模式

### 7.2 任务 2：ATS 与 RM 已切 HA，NM 未收口的影响验证

- 旧 NM 是否只损失 ATS 数据链路
- 旧 NM 是否会对运行中作业成功率造成实质影响
- 是否可以接受一段时间的“历史/指标不完整但作业继续执行”

## 8. 推荐实验顺序

为控制风险，建议按下面顺序推进，而不是大范围同时验证：

1. **先验证 RM 最小修复路径**  
   只修两台 RM，确认历史日志 500 是否消失。
2. **再验证 ATS 不可用对 4 类引擎的真实影响**  
   重点区分“运行中中断”和“ATS 停止后新提交”两类场景。
3. **最后验证 old NM 并行期风险**  
   只保留 1 台旧配置 canary NM 做对照，不直接大规模动 300+ 台 NM。

## 9. 关联任务

- [[ATS不可用对各类型作业真实影响验证]]
- [[ATS与RM切换HA域名但NM未收口的影响验证]]
- [[TimelineServer配置变更对不同组件影响性分析]]
- [[TimelineServer Keytab合并]]
