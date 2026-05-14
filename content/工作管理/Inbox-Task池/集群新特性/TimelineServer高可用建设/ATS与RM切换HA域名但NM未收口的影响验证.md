---
type: task
status: todo
priority: P1
deadline: 2026-06-15
domain: 集群新特性
lifecycle: research
progress: "0"
completed_date:
started_date:
---

# ATS 与 RM 切换 HA 域名但 NM 未收口的影响验证

## 🎯 目标与验收标准

- [ ] 明确 RM / ATS 已切到 `h3timeline`、NM 仍使用物理机域名时的真实影响面
- [ ] 区分“会影响历史/指标展示”与“会影响作业启动/执行”的边界
- [ ] 输出是否需要全量推动 NM 收口、以及是否可以接受并行期风险的建议

## 🔎 当前判断

- RM 历史日志 500 的直接责任链路在 RM -> ATS RPC，不在 NM
- 未收口 NM 主要风险看起来集中在 ATS history / metrics / timeline 数据链路，而非 YARN 调度主链路
- 是否会影响 Tez 新 DAG 提交，需要结合 Tez 对 ATS 的依赖再判断

## 🧪 待验证场景

### 场景 A：仅修 RM，NM 不动

- 历史日志页面是否恢复
- 运行中作业是否受影响
- 新提交作业是否受影响

### 场景 B：ATS 切换主备 / VIP 漂移

- 旧 NM 仍指向 `dsrv014022` 时，ATS 上报是否丢失
- 旧 NM 是否完全失去 HA 收益

### 场景 C：离线 NM 后续陆续拉起

- 未更新配置直接启动时是否继续 principal mismatch
- 更新配置但未改 principal 显式值时，`_HOST` 是否可自然解析到 `h3timeline`

## 📌 关键配置核查

- RM / NM 生效的 `yarn.timeline-service.address`
- RM / NM 生效的 `yarn.timeline-service.principal`
- ATS 生效的 `yarn.timeline-service.principal`
- ATS 生效的 `yarn.timeline-service.keytab`

## 🧭 实验步骤清单

### Step 0：建立 canary 范围

本任务不要一上来碰大批量 NM，先选出：

- 2 台 RM（必测）
- 1 台已切新配置的参考 NM
- 1 台保留旧配置的 canary NM

同时保留 1 个低成本测试队列或业务低峰窗口。

### Step 1：先验证“只改 RM”的最小修复路径

#### 1.1 核两台 RM 生效配置

```bash
grep -E 'yarn\.timeline-service\.(address|principal|webapp\.address)' /etc/hadoop/conf/yarn-site.xml
```

预期：

- `yarn.timeline-service.address = h3timeline.venus.sohurdc.com:10200`
- `yarn.timeline-service.webapp.address = h3timeline.venus.sohurdc.com:8188`
- `yarn.timeline-service.principal = yarn/_HOST@...` 或显式 `yarn/h3timeline@...` 均可接受，但最终解析结果必须指向 `h3timeline`

#### 1.2 重启 RM 后验证历史日志

- 访问历史日志页面
- 选择一个已完成 app 验证是否仍报 500
- 记录 RM 日志是否仍出现 `Server has invalid Kerberos principal`

如果需要快速打点验证：

```bash
APP_ID=<已完成的 application_id>
curl -s -o /tmp/rm-proxy-${APP_ID}.html -w '%{http_code}\n' \
  "http://<rm-web-host>:8088/proxy/${APP_ID}/"
grep -nE 'HTTP ERROR 500|invalid Kerberos principal|IOException' /tmp/rm-proxy-${APP_ID}.html
```

### Step 2：保留 1 台旧配置 NM 做对照

#### 2.1 记录新旧 NM 配置差异

```bash
grep -E 'yarn\.timeline-service\.(address|principal|webapp\.address)' /etc/hadoop/conf/yarn-site.xml
```

重点确认：

- 参考 NM：是否已经指向 `h3timeline`
- canary NM：是否仍指向 `dsrv014022`

如需直接比对，可执行：

```bash
grep -E 'yarn\.timeline-service\.(address|principal|webapp\.address)' /etc/hadoop/conf/yarn-site.xml \
  >/tmp/nm-timeline-current.conf
cat /tmp/nm-timeline-current.conf
```

#### 2.2 在 canary NM 上抓日志

```bash
grep -Ei 'timeline|ats|principal|kerberos|IOException|Failed on local exception' /var/log/hadoop-yarn/yarn/yarn-yarn-nodemanager-*.log
```

如果要持续观察：

```bash
tail -f /var/log/hadoop-yarn/yarn/yarn-yarn-nodemanager-$(hostname -f).log | \
  grep -Ei 'timeline|ats|principal|kerberos|IOException|Failed on local exception'
```

### Step 3：观察旧 NM 是否只伤 ATS 链路

在 canary NM 保持旧配置的前提下，执行轻量作业并重点观察：

1. 作业本身是否失败
2. RM 调度 / container launch 是否正常
3. NM 日志里是否出现 ATS principal mismatch
4. ATS / 历史页面 / container history 是否缺失

建议搭配 1 个轻量 MR 或 Spark 作业做 canary：

```bash
MR_EXAMPLE_JAR=$(ls /usr/lib/hadoop-mapreduce/hadoop-mapreduce-examples*.jar 2>/dev/null | head -1)
yarn jar "$MR_EXAMPLE_JAR" pi -Dmapreduce.job.queuename=<queue> 2 10000
```

或：

```bash
SPARK_EXAMPLE_JAR=$(ls $SPARK_HOME/examples/jars/spark-examples_*.jar 2>/dev/null | head -1)
spark-submit \
  --master yarn \
  --deploy-mode client \
  --queue <queue> \
  --class org.apache.spark.examples.SparkPi \
  "$SPARK_EXAMPLE_JAR" 20
```

### Step 4：验证 ATS 主备切换后旧 NM 的表现

在低风险窗口内做一次受控 ATS 主备切换或等价验证，观察：

1. canary NM 是否仍尝试访问旧物理机地址
2. canary NM 是否完全丧失 HA 收益
3. 旧 NM 上的作业是否只是丢 history / metrics，还是出现执行失败

切换前后都建议执行：

```bash
grep -E 'yarn\.timeline-service\.(address|principal|webapp\.address)' /etc/hadoop/conf/yarn-site.xml
grep -Ei 'timeline|ats|principal|kerberos|IOException|Failed on local exception' \
  /var/log/hadoop-yarn/yarn/yarn-yarn-nodemanager-*.log | tail -100
```

## ✅ 判定口径

### 可判定为“仅影响 ATS 数据链路”

- 作业提交与执行正常
- 仅 NM -> ATS 上报失败
- RM / container 调度链路无异常
- 历史 / metrics / timeline 展示不完整

### 可判定为“影响执行链路”

- container launch 失败
- 任务在 canary NM 上反复失败且根因直接指向 ATS / principal mismatch
- 作业成功率明显受 NM 是否收口影响

## 📝 实施记录模板

| 维度 | 参考 NM（新配置） | canary NM（旧配置） | 结论 |
|---|---|---|---|
| 作业提交 | 待补充 | 待补充 | 待补充 |
| 作业执行 | 待补充 | 待补充 | 待补充 |
| ATS 上报 | 待补充 | 待补充 | 待补充 |
| 历史 / UI | 待补充 | 待补充 | 待补充 |
| 主备切换收益 | 待补充 | 待补充 | 待补充 |

## 📎 结果回填建议

- RM 历史页恢复情况单独记录
- canary NM 日志中的 principal mismatch 原文单独摘录
- 将“作业成功率”和“ATS 数据完整性”拆开记录，避免混淆

## ⚠️ 风险与边界

- 需要把“只改 RM 的最小修复路径”和“全量 ATS HA 收口方案”分开评估
- 不能假设 combined keytab 能兜住旧 NM 与新 ATS 的 principal mismatch

## 🔗 关联文档

- [[ATS可用性影响与HA落地收益阶段性评估]]
- [[TimelineServer配置变更对不同组件影响性分析]]
- [[TimelineServer Keytab合并]]
