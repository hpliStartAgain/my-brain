---
type: test-report
status: done
author: 李浩鹏
date: 2026-04-22
domain: 集群新特性
tags: [Dproxy, SCLB, 验证测试, 迁移]
---

# SCLB 路由验证测试报告

> **关联方案**：[[Dproxy迁移至七层网关sclb落地方案v8]]（v8.1）
> **测试日期**：2026-04-22
> **测试人员**：李浩鹏
> **测试结论**：**69 项测试全部通过（PASS 69 / FAIL 0）**

---

## 一、测试背景

Dproxy（nginx 多端口网关）迁移至 SCLB（APISix 七层网关）。迁移完成后，在 DNS 切换前，通过直打 SCLB VIP 的方式，对所有路由的路径级行为进行全量验证，确保：
- **403 拦截路由**：所有应被拦截的路径确实返回 403
- **放行路由**：所有应放行的路径能成功转发至后端（返回 2xx / 3xx / 4xx，即非 403/5xx）

---

## 二、测试环境

| 项目 | 值 |
|---|---|
| SCLB VIP | `10.18.102.127` |
| 监听端口 | `80` |
| 测试 Host | `dproxy.venus.sohurdc.com` |
| 测试命令模板 | `curl -s -o /dev/null -w "%{http_code}" -H "Host: dproxy.venus.sohurdc.com" http://10.18.102.127/<path>` |
| 判定标准 | 403 路由：期望 403；放行路由：期望非 403 且非 5xx |

> [!NOTE] 测试时 DNS 尚未切换，通过 `-H Host` 头模拟真实域名访问。放行路由返回 200/404/401 均属正常（后端服务可能返回 404，Knox 可能返回 401 认证挑战）。

---

## 三、测试结果汇总

| 路由 | 方案章节 | 测试项数 | 通过 | 备注 |
|---|---|---|---|---|
| `r-8089-block` | Step 1-A | 9 | ✅ 9 | yarnui/yarn + sparkhistory 黑名单 |
| `r-knox-timeline-guard` | Step 1-B | 6 | ✅ 6 | TEZ/HIVE limit=11 单请求放行 |
| `r-knox-fallback` | Step 1-C | 5 | ✅ 5 | catch-all 放行 |
| `r-knox-lite-timeline-guard` | Step 2-A | 2 | ✅ 2 | venus TEZ/HIVE |
| `r-knox-lite-pass` | Step 2-B | 1 | ✅ 1 | catch-all |
| `r-timeline-ws-guard` | Step 3-A | 2 | ✅ 2 | 单请求放行 |
| `r-timeline-pass` | Step 3-B | 2 | ✅ 2 | 普通路径 |
| `r-offline-timeline-pass` | Step 4-A | 2 | ✅ 2 | |
| `r-offline-timeline2-pass` | Step 4-B | 2 | ✅ 2 | |
| `r-flink-hs-block-overview` | Step 5-A | 1 | ✅ 1 | |
| `r-flink-hs-pass` | Step 5-B | 2 | ✅ 2 | |
| `r-rt-flink-hs-block-overview` | Step 5-C | 1 | ✅ 1 | |
| `r-rt-flink-hs-pass` | Step 5-D | 2 | ✅ 2 | |
| `r-rt-knox-block` | Step 6-A | 16 | ✅ 16 | 16条URI全覆盖 |
| `r-rt-knox-pass` | Step 6-B | 2 | ✅ 2 | |
| `r-rt-logs-whitelist` | Step 7-A | 6 | ✅ 6 | 6条白名单全覆盖 |
| `r-rt-logs-deny` | Step 7-B | 2 | ✅ 2 | catch-all 403 |
| `r-tez-ui-ws` | Step 8-A | 2 | ✅ 2 | |
| `r-tez-ui-static` | Step 8-B | 2 | ✅ 2 | |
| `r-jhs-pass` | Step 9-A | 2 | ✅ 2 | |
| **合计** | | **69** | **✅ 69** | |

---

## 四、详细测试记录

### Step 1-A：`r-8089-block`（替代原 nginx 8089 block 逻辑）

> 期望：全部 403

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC01 | `/knox/gateway/yarnui/yarn` | 403 | 403 | ✅ |
| TC02 | `/knox/gateway/yarnui/yarn/cluster/apps` | 403 | 403 | ✅ |
| TC03 | `/knox/gateway/yarnui/yarn/cluster/scheduler` | 403 | 403 | ✅ |
| TC04 | `/knox/gateway/yarnui/yarn/jmx` | 403 | 403 | ✅ |
| TC05 | `/knox/gateway/yarnui/yarn/logs` | 403 | 403 | ✅ |
| TC06 | `/knox/gateway/yarnui/yarn/conf` | 403 | 403 | ✅ |
| TC07 | `/knox/gateway/yarnui/yarn/stacks` | 403 | 403 | ✅ |
| TC08 | `/knox/gateway/venus/sparkhistory/api/v1/applications` | 403 | 403 | ✅ |
| TC09 | `/knox/gateway/venus/sparkhistory/history` | 403 | 403 | ✅ |

### Step 1-B：`r-knox-timeline-guard`（TEZ/HIVE limit=11 防刷，6条URI）

> 期望：单请求不触发 limit=11，流量正常转发至 Knox（200/302/401）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC10 | `/knox/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID` | 放行 | 200 | ✅ |
| TC11 | `/knox/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID` | 放行 | 200 | ✅ |
| TC12 | `/knox/gateway/offline-ats1/tez/ws/v1/timeline/TEZ_DAG_ID` | 放行 | 200 | ✅ |
| TC13 | `/knox/gateway/offline-ats1/tez/ws/v1/timeline/HIVE_QUERY_ID` | 放行 | 200 | ✅ |
| TC14 | `/knox/gateway/offline-ats2/tez/ws/v1/timeline/TEZ_DAG_ID` | 放行 | 200 | ✅ |
| TC15 | `/knox/gateway/offline-ats2/tez/ws/v1/timeline/HIVE_QUERY_ID` | 放行 | 200 | ✅ |

> [!NOTE] TC15 首次执行返回 504（偶发的 Knox 后端超时），重试 3 次均为 200，属正常波动，路由配置无误。

### Step 1-C：`r-knox-fallback`（catch-all 放行）

> 期望：流量转发至 Knox HA

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC16 | `/knox/` | 放行 | 404 | ✅ |
| TC17 | `/knox/gateway/venus/sparkhistory/` | 放行 | 200 | ✅ |
| TC18 | `/knox/gateway/venus/yarn/nodemanager/node/containerlogs` | 放行 | 404 | ✅ |
| TC19 | `/knox/gateway/venus/jobhistory/joblogs` | 放行 | 200 | ✅ |
| TC20 | `/knox/gateway/venus/jobhistory/static` | 放行 | 404 | ✅ |

### Step 2-A：`r-knox-lite-timeline-guard`（TEZ/HIVE limit=11，2条URI）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC21 | `/knox-lite/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID` | 放行 | 200 | ✅ |
| TC22 | `/knox-lite/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID` | 放行 | 200 | ✅ |

### Step 2-B：`r-knox-lite-pass`（catch-all）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC23 | `/knox-lite/gateway/venus/` | 放行 | 404 | ✅ |

### Step 3-A：`r-timeline-ws-guard`（在线 Timeline TEZ/HIVE 防刷）

> 期望：单请求不触发，转发至 sg-timeline-online（需 user.name 认证）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC24 | `/timeline/ws/v1/timeline/TEZ_DAG_ID` | 放行 | 401 | ✅ |
| TC25 | `/timeline/ws/v1/timeline/HIVE_QUERY_ID` | 放行 | 401 | ✅ |

### Step 3-B：`r-timeline-pass`（在线 Timeline 普通路径）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC26 | `/timeline/applicationhistory/app` | 放行 | 401 | ✅ |
| TC27 | `/timeline/` | 放行 | 401 | ✅ |

### Step 4-A：`r-offline-timeline-pass`（离线 Timeline1，替代原 8990）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC28 | `/offline/timeline/` | 放行 | 401 | ✅ |
| TC29 | `/offline/timeline/applicationhistory/app` | 放行 | 401 | ✅ |

### Step 4-B：`r-offline-timeline2-pass`（离线 Timeline2，替代原 18990）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC30 | `/offline/timeline2/` | 放行 | 401 | ✅ |
| TC31 | `/offline/timeline2/applicationhistory/app` | 放行 | 401 | ✅ |

### Step 5-A：`r-flink-hs-block-overview`（离线 Flink HS jobs/overview 拦截）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC32 | `/flink-hs/jobs/overview` | 403 | 403 | ✅ |

### Step 5-B：`r-flink-hs-pass`（离线 Flink HS 放行）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC33 | `/flink-hs/jobs`（非 overview） | 放行 | 404 | ✅ |
| TC34 | `/flink-hs/` | 放行 | 200 | ✅ |

### Step 5-C：`r-rt-flink-hs-block-overview`（实时 Flink HS jobs/overview 拦截）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC35 | `/realtime/flink-hs/jobs/overview` | 403 | 403 | ✅ |

### Step 5-D：`r-rt-flink-hs-pass`（实时 Flink HS 放行）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC36 | `/realtime/flink-hs/jobs`（非 overview） | 放行 | 404 | ✅ |
| TC37 | `/realtime/flink-hs/` | 放行 | 200 | ✅ |

### Step 6-A：`r-rt-knox-block`（替代原 8094 block，16条URI全覆盖）

> 期望：全部 403

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC38 | `/realtime/knox/gateway/realtime/sparkhistory` | 403 | 403 | ✅ |
| TC39 | `/realtime/knox/gateway/realtime/sparkhistory/history` | 403 | 403 | ✅ |
| TC40 | `/realtime/knox/gateway/realtime/sparkhistory/api/v1/applications` | 403 | 403 | ✅ |
| TC41 | `/realtime/knox/gateway/realtime/yarn/cluster` | 403 | 403 | ✅ |
| TC42 | `/realtime/knox/gateway/realtime/yarn/conf` | 403 | 403 | ✅ |
| TC43 | `/realtime/knox/gateway/realtime/yarn/logs` | 403 | 403 | ✅ |
| TC44 | `/realtime/knox/gateway/realtime/yarn/stacks` | 403 | 403 | ✅ |
| TC45 | `/realtime/knox/gateway/realtime/yarn/jmx` | 403 | 403 | ✅ |
| TC46 | `/realtime/knox/gateway/realtime/yarn/cluster/apps`（wildcard） | 403 | 403 | ✅ |
| TC47 | `/realtime/knox/gateway/realtime/yarn/cluster/scheduler`（wildcard） | 403 | 403 | ✅ |
| TC48 | `/realtime/knox/gateway/realtime/yarn/cluster/cluster`（wildcard） | 403 | 403 | ✅ |
| TC49 | `/realtime/knox/gateway/realtime/yarn/cluster/nodes`（wildcard） | 403 | 403 | ✅ |
| TC50 | `/realtime/knox/gateway/realtime/yarn/cluster/nodelabels`（wildcard） | 403 | 403 | ✅ |
| TC51 | `/realtime/knox/gateway/realtime/yarn/nodemanager/node/node`（wildcard） | 403 | 403 | ✅ |
| TC52 | `/realtime/knox/gateway/realtime/yarn/nodemanager/node/allApplications` | 403 | 403 | ✅ |
| TC53 | `/realtime/knox/gateway/realtime/yarn/nodemanager/node/allContainers` | 403 | 403 | ✅ |

### Step 6-B：`r-rt-knox-pass`（实时 Knox 放行）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC54 | `/realtime/knox/gateway/realtime/sparkhistory/`（带斜线，不被精确 block） | 放行 | 200 | ✅ |
| TC55 | `/realtime/knox/gateway/realtime/yarn/`（子路径） | 放行 | 200 | ✅ |

### Step 7-A：`r-rt-logs-whitelist`（替代原 8095 白名单，6条URI全覆盖）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC56 | `/realtime/logs/gateway/realtime/yarn/proxy/application_12345_0001` | 放行 | 404 | ✅ |
| TC57 | `/realtime/logs/gateway/realtime/yarn/cluster/app/application_12345_0001` | 放行 | 200 | ✅ |
| TC58 | `/realtime/logs/gateway/realtime/yarn/nodemanager/node/containerlogs/container_abc` | 放行 | 404 | ✅ |
| TC59 | `/realtime/logs/gateway/realtime/yarn/static/main.css` | 放行 | 404 | ✅ |
| TC60 | `/realtime/logs/gateway/realtime/jobhistory/logs/job_123` | 放行 | 404 | ✅ |
| TC61 | `/realtime/logs/gateway/realtime/yarn/cluster/appattempt/attempt_123` | 放行 | 200 | ✅ |

### Step 7-B：`r-rt-logs-deny`（8095 默认拒绝）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC62 | `/realtime/logs/`（根路径，不在白名单） | 403 | 403 | ✅ |
| TC63 | `/realtime/logs/other-path`（非白名单路径） | 403 | 403 | ✅ |

### Step 8-A：`r-tez-ui-ws`（TezUI WebSocket）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC64 | `/tez-ui/ws` | 放行 | 404 | ✅ |
| TC65 | `/tez-ui/ws/v1/info` | 放行 | 404 | ✅ |

### Step 8-B：`r-tez-ui-static`（TezUI 静态文件）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC66 | `/tez-ui/` | 放行 | 200 | ✅ |
| TC67 | `/tez-ui/index.html` | 放行 | 200 | ✅ |

### Step 9-A：`r-jhs-pass`（JHS 代理）

| TC | 路径 | 期望 | 实际 | 结果 |
|---|---|---|---|---|
| TC68 | `/jhs/` | 放行 | 404 | ✅ |
| TC69 | `/jhs/jobhistory/logs` | 放行 | 404 | ✅ |

> [!NOTE] JHS 返回 404 属正常：JHS 服务（dnn014018:19888）根路径无内容，`/jobhistory/logs` 需要带参数（appId）才能查到日志，无参数 404 是预期行为。

---

## 五、待观测项（DNS 切换后）

以下问题在 DNS 切换前无法完全验证，需切换后抓包确认：

| 编号 | 问题 | 路由 | 说明 |
|---|---|---|---|
| O1 | `r-timeline-ws-guard` 的 Origin 拦截是否生效 | Step 3-A | TezUI 从 `dproxy.venus.sohurdc.com` 加载后，浏览器 Origin 值变为 `http://dproxy.venus.sohurdc.com`，需确认 `plg-block-limit-11-origin` 的 Lua 条件是否已更新 |
| O2 | sg-timeline-online / sg-tez-ui-ws 的 host 字段 `\t` 问题 | Step 3-A/8-A | 平台显示有制表符但功能正常；切流后若出现回源错误需复查 |

---

## 六、DNS 切流前置条件确认

> [!WARNING] 以下所有条件满足后，方可执行 DNS 切换

- [x] 20条路由全部创建并发布
- [x] 10个服务组全部创建
- [x] 7个插件全部创建
- [x] r-8089-block priority 已修复（1000）
- [x] r-knox-timeline-guard `plg-knox-strip-ingress-prefix` 已补充
- [x] 路由验证测试 69/69 全部通过
- [ ] 在测试机 `/etc/hosts` 中将 `dproxy.venus.sohurdc.com → 10.18.102.127`，执行业务级冒烟测试
- [ ] 确认 `r-knox-allow` 保留/删除决策
- [ ] Ambari 中 `yarn.log.server.url` 改为 `http://dproxy.venus.sohurdc.com/jhs/jobhistory/logs`
