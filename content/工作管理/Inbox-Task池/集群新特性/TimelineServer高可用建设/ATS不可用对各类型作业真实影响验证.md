---
type: task
status: todo
priority: P1
deadline: 2026-04-30
domain: 集群新特性
lifecycle: research
progress: "0"
completed_date:
started_date:
---

# ATS 不可用对各类型作业真实影响验证

## 🎯 目标与验收标准

- [ ] 明确 ATS v1.5 不可用时，MR / Tez / Spark / Flink 新提交作业是否会失败
- [ ] 区分“作业已运行后 ATS 不可用”和“ATS 已不可用后再提交新作业”两类场景
- [ ] 输出可用于判断 ATS HA 是否值得推进的结论

## 🔎 当前判断

- MR / Spark / Flink 初步判断不依赖 ATS 执行主链路，更偏向历史、指标与 UI 能力受损
- Tez 需要单独验证，重点关注新 DAG 提交时是否因 ATS History Logging 初始化失败而影响 DAGAppMaster 启动

## 🧪 待验证场景

### 场景 A：ATS 运行中途不可用

- MR 作业运行中
- Hive on Tez / 纯 Tez DAG 运行中
- Spark on YARN 运行中
- Flink on YARN 运行中

### 场景 B：ATS 已不可用，再新提交作业

- MR 新提交
- Hive on Tez / 纯 Tez 新提交
- Spark on YARN 新提交
- Flink on YARN 新提交

## 📌 关键配置核查

- `tez.history.logging.service.class`
- `yarn.timeline-service.enabled`
- `yarn.timeline-service.version`
- Spark event log / Spark History Server 是否独立可用
- Flink 历史查看链路是否依赖 YARN ATS

## 🧭 实验步骤清单

### Step 0：统一前置采样

在实验开始前，先固定 1 个低峰时段、1 个小资源测试窗口，并记录以下信息：

```bash
# ATS / YARN 关键配置
grep -E 'yarn\.timeline-service\.(enabled|version|address|principal|webapp\.address)' /etc/hadoop/conf/yarn-site.xml

# Tez 历史服务配置（在 HS2 / Tez 客户端所在节点执行）
grep -E 'tez\.history\.logging\.service\.class|tez\.am\.' /etc/tez/conf/tez-site.xml

# Spark event log / SHS 关键配置（如有 spark-defaults.conf）
grep -E '^spark\.eventLog\.(enabled|dir)|^spark\.history\.' /etc/spark/conf/spark-defaults.conf
```

同时准备 4 类小作业样本：

- MR：`hadoop-mapreduce-examples` 中的轻量样例
- Hive on Tez / 纯 Tez：1 条小表聚合或 1 个轻量 DAG
- Spark on YARN：`SparkPi` 或等价小作业
- Flink on YARN：`WordCount` / 示例流作业

### Step 0.1：各引擎命令草案

> 以下命令是“实验草案模板”，路径、队列、库表名按现网替换。

#### MR 样例

```bash
MR_EXAMPLE_JAR=$(ls /usr/lib/hadoop-mapreduce/hadoop-mapreduce-examples*.jar 2>/dev/null | head -1)
yarn jar "$MR_EXAMPLE_JAR" pi -Dmapreduce.job.queuename=<queue> 5 100000
```

#### Hive on Tez 样例

```bash
beeline -u 'jdbc:hive2://<hs2-vip>:10000/default;principal=hive/_HOST@VENUS.SOHURDC.COM' \
  -e "set hive.execution.engine=tez; select count(*) from <small_table>;"
```

#### 纯 Tez 样例（如集群保留 tez examples）

```bash
TEZ_EXAMPLE_JAR=$(ls /usr/lib/tez/tez-examples*.jar 2>/dev/null | head -1)
hadoop jar "$TEZ_EXAMPLE_JAR" orderedwordcount /tmp/tez-input /tmp/tez-output
```

#### Spark on YARN 样例

```bash
SPARK_EXAMPLE_JAR=$(ls $SPARK_HOME/examples/jars/spark-examples_*.jar 2>/dev/null | head -1)
spark-submit \
  --master yarn \
  --deploy-mode client \
  --queue <queue> \
  --class org.apache.spark.examples.SparkPi \
  "$SPARK_EXAMPLE_JAR" 100
```

#### Flink on YARN 样例

```bash
$FLINK_HOME/bin/flink run \
  -t yarn-application \
  -Dyarn.application.name=flink-ats-canary \
  $FLINK_HOME/examples/streaming/TopSpeedWindowing.jar
```

### Step 1：场景 A —— 作业已运行后 ATS 中途不可用

#### 1.1 先启动每类小作业

- MR：启动一个可持续几十秒到几分钟的样例作业
- Tez：启动一个可稳定运行并产生 DAG 历史的查询
- Spark：提交 1 个小型 Spark on YARN 作业
- Flink：启动 1 个短生命周期或可控停止的 YARN 作业

建议每类作业启动后立刻记录应用 ID：

```bash
yarn application -list -appStates RUNNING,ACCEPTED
```

#### 1.2 在作业运行中停 ATS

用你们当前最可控的方式停 ATS（Ambari / 服务管理），并记录时间点。

可配套执行：

```bash
date '+%F %T ATS stop test begin'
curl -s -o /dev/null -w '%{http_code}\n' http://h3timeline.venus.sohurdc.com:8188/ws/v1/timeline/about
```

#### 1.3 观察 4 个维度

1. 作业本身是否失败
2. RM 页面是否还能展示基础状态
3. ATS / Tez UI / 历史页是否丢数据
4. 客户端 / AM / NM 日志里是否出现与 ATS 相关的异常

建议重点 grep：

```bash
grep -Ei 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' /var/log/hadoop-yarn/yarn/*.log
grep -Ei 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' /var/log/hive/*.log
grep -Ei 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' /var/log/spark/*.log
grep -Ei 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' /var/log/flink/*.log
```

建议把日志输出统一重定向到临时文件后再 grep：

```bash
grep -Ei 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' \
  /var/log/hadoop-yarn/yarn/*.log >/tmp/ats-impact-yarn.log 2>&1
grep -nE 'timeline|ats|history|principal|kerberos|IOException|ServiceStateException' \
  /tmp/ats-impact-yarn.log | tail -50
```

### Step 2：场景 B —— ATS 已不可用，再新提交作业

#### 2.1 保持 ATS 停止

确认 ATS 仍处于不可用状态后，再重新提交 4 类小作业。

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://h3timeline.venus.sohurdc.com:8188/ws/v1/timeline/about
# 预期：非 200
```

#### 2.2 分别记录 3 个结论

1. **能否启动**
2. **能否成功结束**
3. **历史 / 指标 / UI 是否缺失**

> 这里对 **Tez** 要额外关注 DAGAppMaster 初始化阶段是否失败。

提交后建议立即抓应用状态：

```bash
yarn application -list -appStates NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING,FINISHED,FAILED,KILLED
```

### Step 3：针对 Tez 的单独深挖

如果 Hive on Tez / 纯 Tez 在场景 B 中出现失败，立即补充记录：

- `tez.history.logging.service.class` 的实际值
- 失败时 DAGAppMaster / HS2 日志
- 是否出现 `ATSHistoryLoggingService` / `ATSV15HistoryLoggingService` / `TimelineClient` 相关报错

建议直接抓关键字：

```bash
grep -Ei 'ATSHistoryLoggingService|ATSV15HistoryLoggingService|TimelineClient|DAGAppMaster|ServiceStateException' \
  /var/log/hive/* /var/log/hadoop-yarn/yarn/* 2>/dev/null | tail -100
```

如果 Tez 在 ATS 停止时仍然能提交成功，也要记录：

- 是否只是 Tez UI / DAG 历史丢失
- 是否存在明显的降级行为而非启动失败

## ✅ 判定口径

### 可判定为“只伤观测，不伤执行”

- 作业提交成功
- 作业执行成功
- 仅 ATS / Tez UI / 历史链路受损

### 可判定为“ATS 对该引擎存在执行级影响”

- 作业在 ATS 停止状态下无法提交
- DAG / AM 初始化直接失败
- 日志明确指向 ATS / Timeline 初始化异常导致退出

## 📝 实施记录模板

| 引擎 | 场景 A（运行中 ATS 中断） | 场景 B（ATS 停止后新提交） | 是否影响执行 | 关键日志 |
|---|---|---|---|---|
| MR | 待补充 | 待补充 | 待补充 | 待补充 |
| Tez | 待补充 | 待补充 | 待补充 | 待补充 |
| Spark | 待补充 | 待补充 | 待补充 | 待补充 |
| Flink | 待补充 | 待补充 | 待补充 | 待补充 |

## 📎 结果回填建议

- 将每类引擎的 `application_<id>` 一并记录
- 将“是否仅损失历史/UI”与“是否阻断执行”分成两个字段记录
- Tez 如失败，优先贴出 DAGAppMaster 关键报错片段

## ⚠️ 风险与边界

- 不同引擎需要区分“作业成功率”与“可观测/历史完整性”两类影响
- Tez 结论不能直接套用 MR / Spark / Flink 的经验

## 🔗 关联文档

- [[ATS可用性影响与HA落地收益阶段性评估]]
- [[TimelineServer配置变更对不同组件影响性分析]]
- [[TimelineServer Keytab合并]]
