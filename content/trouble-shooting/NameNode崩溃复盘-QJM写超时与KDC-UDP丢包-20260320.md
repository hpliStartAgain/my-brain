---
title: "NameNode 崩溃复盘：HDFS QJM 写超时与 KDC UDP 丢包根因分析（2026-03-20）"
date: 2026-03-24
tags: [HDFS, Kerberos, NameNode, QJM, 故障复盘, SRE]
aliases: ["NN1崩溃", "QJM写超时", "KDC UDP丢包"]
---

## 摘要

2026-03-20 02:37，NN1（dnn130160）因 HDFS QJM（QuorumJournalManager）写超时触发 `ExitUtil.terminate(1)`，ZKFC 随即将 NN2（dnn130161）切换为 Active。

排查耗时约一周，先后排除了 JournalNode 异常、NameNode JVM GC STW 两个假设，最终通过 KDC 日志时序与 authtime 字段分析，将根因锁定为：

> **Active NN 每日执行一次 Kerberos `reloginFromKeytab()`（fresh kinit）。3月20日 02:36:43，NN1 的 AS_REQ UDP 包被 KDC recv buffer 丢弃——NN1 无法完成 TGT 获取，所有 JournalNode 的 SASL 握手全部阻塞，20 秒内无响应触发 QJM 超时，NN1 崩溃。根本背景是 KDC 主机 UDP 接收缓冲区长期仅 208KB（Linux 默认最小值），累计 5072 万次溢出丢包。**

---

## 1. 背景知识

### 1.1 HDFS QJM 写入机制

[[HDFS]] HA 模式下，Active NN 的每一条 edit log 都通过 [[QuorumJournalManager]] 同步写入三个 JournalNode（JN）。写入使用 QJM 的多数派（quorum）语义：至少 2/3 个 JN 返回 ACK 才算成功，否则等待直到 `dfs.qjournal.write-txns.timeout.ms`（默认 20000ms）超时。

```
Active NN
  └── IPCLoggerChannel (per JN)
        └── call() → sendEdits RPC
              └── SASL/GSS authenticated IPC connection
```

`IPCLoggerChannel.call()` 测量的是**端到端的挂钟时间**，包含了 IPC 连接建立、SASL 握手、实际 RPC 传输的所有时间。WARN 阈值为 1000ms。

### 1.2 Kerberos 认证流程：AS_REQ / TGS_REQ / SASL

```mermaid
sequenceDiagram
    participant SVC as "服务进程 (NameNode)"
    participant UGI as "Hadoop UGI"
    participant KDC as "KDC (AS + TGS)"
    participant JN  as "JournalNode"

    Note over UGI,KDC: 阶段一：获取 TGT（AS_REQ/AS_REP）
    UGI->>KDC: AS_REQ（keytab 签名）
    KDC-->>UGI: AS_REP（TGT，authtime = now）

    Note over SVC,JN: 阶段二：获取 service ticket（TGS_REQ/TGS_REP）
    SVC->>KDC: TGS_REQ（用 TGT 换 jn/ service ticket）
    KDC-->>SVC: TGS_REP（service ticket）

    Note over SVC,JN: 阶段三：SASL/GSS 握手建立认证连接
    SVC->>JN: SASL token exchange（GSS Initiate）
    JN-->>SVC: SASL token exchange（GSS Accept）
    SVC->>JN: sendEdits RPC（在认证连接上）
    JN-->>SVC: ACK
```

**KDC 日志中的关键字段 `authtime`**：记录的是签发本次 TGS_REQ 所用 TGT 的原始认证时间（即 AS_REQ 发生时刻）。

- `authtime ≈ TGS_REQ 时间` → TGT 刚刚新签发 → **fresh kinit**（`reloginFromKeytab`）
- `authtime` 远早于请求时间 → 在续期旧 TGT → TGT renewal（`kinit -R`）

### 1.3 Hadoop UGI 重新登录机制与 Active/Standby 行为差异

Hadoop UGI 的 `checkTGTAndReloginFromKeytab()` 在每次 IPC 调用前被动检查。根据代码路径不同，存在两种触发模型：

- **近期满检查**（新版本热路径）：TGT 剩余有效期 < `hadoop.kerberos.min.seconds.before.relogin`（默认 60s）时触发；对 24h TGT，即 T + 24h - 60s 后的第一次 IPC 时触发
- **80% 窗口检查**（后台刷新线程）：TGT 生命周期达到 `TICKET_RENEW_WINDOW = 0.80` 时触发；对 24h TGT，即 T + 0.80 × 86400s = T + **19h12m** 后触发

**KDC 实测数据揭示的 Active/Standby 差异**（Mar 1~24 完整 AS_REQ 序列）：

| NN 角色 | 主机 | kinit 间隔 | 触发路径 |
|---|---|---|---|
| **Active**（Mar 1~20） | dnn130160 (NN1) | ~24h（+49s/天漂移） | 近期满检查，IPC 热路径驱动 |
| **Standby**（Mar 1~20） | dnn130161 (NN2) | **19h12m ± 30s**（23次，极其精确） | 80% 窗口，后台刷新线程驱动 |
| **Active**（Mar 20~24） | dnn130161 (NN2，接管后） | ~24h（从 01:41 基准续延） | 接管后切换为近期满检查 |
| **Standby**（Mar 20~24） | dnn130160 (NN1，重启后） | **19h12m**（重启后立即切回） | 退回 Standby 后切回 80% 路径 |

> [!note] 角色驱动路径切换
> Active NN 处理密集 IPC 写请求，`checkTGTAndReloginFromKeytab()` 被频繁调用，最终由"剩余 < 60s"触发，时间点随执行开销每日后移约 49s。Standby NN 的某个后台刷新线程（`DelegationTokenRenewer` 或 Spnego filter）使用 80% 逻辑，间隔精确固定为 19h12m00s。**角色切换后间隔模式立即跟随切换，与物理主机无关。**

> [!warning] 关键副作用
> `reloginFromKeytab()` 生成的是**全新凭证缓存**，旧的 service ticket（包括所有 JN 的 `jn/hostname@REALM`）全部失效。下一次 `sendEdits` 调用必须对每个 JN 重新走 TGS_REQ → SASL 握手全流程，而这个过程是**同步阻塞**在 `IPCLoggerChannel.call()` 的挂钟时间内的。

---

## 2. 故障时间线

| 时间                  | 事件                                                                |
| ------------------- | ----------------------------------------------------------------- |
| Mar 1 ~ Mar 19      | NN1 每日 02:20~02:36 出现 JN 写 WARN（1~5s），与 KDC AS_REQ 时间完全吻合        |
| Mar 20 01:41:27     | NN2（Standby）正常 AS_REQ，KDC ISSUE 成功，TGT 刷新                        |
| Mar 20 **02:36:43** | NN1 触发 `reloginFromKeytab()`，AS_REQ (UDP) 发出；**KDC recv buffer 满，包被内核丢弃，无 ISSUE 记录** |
| Mar 20 02:36:43~    | Java Kerberos 库 UDP timeout → TCP fallback → 同样超时；无 TGT，SASL 握手无法建立 |
| Mar 20 02:36:49     | `Waited 6001ms for sendEdits. No responses yet.`（首条 INFO）         |
| Mar 20 02:37:03     | `Timed out waiting 20000ms` → `flush failed for required journal` |
| Mar 20 02:37:03     | `ExitUtil.terminate(1)` → **NN1 进程退出**                            |
| Mar 20 **02:37:05** | NN2 ZKFC 检测到 NN1 宕机，切换 Active，**立即 fresh kinit（KDC ISSUE 成功，2s 内完成）** |
| Mar 20 02:37:10     | NN2 开始 `recoverUnfinalizedSegments`，接管 Active                     |
| Mar 20 02:51:45     | NN1 重启后 AS_REQ，KDC ISSUE 成功（KDC 已恢复响应）                           |

---

## 3. 排查过程：如何逐步排除两个错误假设

```mermaid
graph TD
    A["NN1 崩溃 02:37:03<br/>QJM write timeout 20000ms"] --> B{"假设一<br/>JN 节点异常"}
    A --> E{"假设二<br/>NN JVM GC STW"}
    A --> H{"假设三<br/>Kerberos 重认证"}

    B --> C["💡 反证：切换 Active NN 后<br/>故障时间从 02:3x 提前到 01:4x<br/>若 JN 有问题，时间应与哪台 NN 是 Active 无关"]
    C --> D["❌ 排除：根因在 Active NN 侧"]

    E --> F["💡 反证：STW 期间 JVM 冻结无法输出日志<br/>但 02:36:49~02:37:03 每秒均有<br/>client.QuorumJournalManager 日志打印"]
    F --> G["❌ 排除：JVM 全程存活"]

    H --> I["✅ KDC AS_REQ 时间与 NN WARN 逐日精确对齐"]
    I --> J["✅ authtime = AS_REQ 时间戳（数学验证误差 <2s）<br/>= TGT 刚刚签发 = fresh kinit"]
    J --> K["✅ Mar 20 KDC 无 AS_REQ ISSUE 记录<br/>= AS_REQ UDP 包被丢弃，TGT 获取失败<br/>KDC 累计 5072 万次 recv buffer overflow"]
    K --> L["🔴 根因确认"]

    style D fill:#ffcccc
    style G fill:#ffcccc
    style L fill:#ff6666,color:#fff
```

### 3.1 假设一：JournalNode 异常（已排除）

**初始怀疑**：JN 节点存在周期性问题（GC、磁盘 IO 抖动）。

**决定性反证**：

> 2026-03-20 NN1 崩溃后，NN2 接管为 Active。此后每日出现 JN 写 WARN 的时间**从 02:3x 提前到了 01:4x**。
>
> 如果根因在 JN 侧（JN 本身的周期性抖动），则故障时间应由 JN 决定，与哪台 NN 是 Active 无关。但实际上时间跟着 Active NN 变了——说明触发源在 NN 侧。

### 3.2 假设二：NN JVM GC Stop-The-World（已排除）

**初始怀疑**：Active NN 遭遇 Full GC，STW 导致无法处理 JN 的 ACK 包。

**决定性反证**：

NN1 崩溃期间（02:36:49 ~ 02:37:03）的日志逐秒打印，以下为节选：

```
02:36:49,844 INFO  client.QuorumJournalManager - Waited 6001 ms ...
02:36:50,845 INFO  client.QuorumJournalManager - Waited 7002 ms ...
02:36:51,846 INFO  client.QuorumJournalManager - Waited 8004 ms ...
...（每秒一条，连续 14 条）
02:37:03,843 WARN  client.QuorumJournalManager - Timed out waiting 20000ms
```

GC STW 会冻结整个 JVM，任何线程均无法执行，日志在 STW 期间必然断档。**而此处 JVM 每秒都在输出日志，说明进程完全正常——它只是在等一个永远不会到来的 KDC 响应。**

### 3.3 确认根因：Kerberos fresh kinit 触发 SASL 重认证

**AS_REQ 时间与 JN WARN 的逐日精确对齐（NN1 样本）**：

| 日期 | KDC AS_REQ ISSUE 时间（NN1） | NN1 JN WARN 时间 | WARN 最大延迟 |
|---|---|---|---|
| Mar 16 | 02:33:06 | 02:33:10 | 4098ms |
| Mar 17 | 02:34:33 | 02:34:35 | 1573ms |
| Mar 18 | 02:36:12 | 02:36:15 | 2983ms |
| Mar 19 | 02:36:21 | 02:36:23 | 4947ms |
| Mar 20 | **KDC 无 AS_REQ ISSUE 记录** | 02:36:49~02:37:03 | **>20000ms（崩溃）** |

**`authtime` 数学验证（Mar 1）**：

```
KDC 日志：Mar 01 02:20:32 CST，authtime = 1772302830

Jan 1, 2026 00:00:00 UTC = 1767225600
Feb 28, 2026 18:20:30 UTC = 1767225600 + 58×86400 + 66030 = 1772302830 ✓

即 authtime = Mar 1 02:20:30 CST，与日志时间相差 2s（网络 RTT）
→ TGT 在 AS_REQ 发出前 2 秒内刚刚签发 → fresh kinit
```

**正常日发生 WARN 时的完整调用链**：

```mermaid
sequenceDiagram
    participant NN as "NameNode (Active)"
    participant UGI as "Hadoop UGI"
    participant KDC as "KDC"
    participant JN1 as "JN1 (:8485)"
    participant JN2 as "JN2 (:8485)"
    participant JN3 as "JN3 (:8485)"

    rect rgb(255, 248, 220)
        Note over UGI,KDC: ① reloginFromKeytab() 触发（每日约此时刻）
        UGI->>KDC: AS_REQ（keytab 签名）
        KDC-->>UGI: AS_REP（新 TGT，authtime=now）
        Note over UGI: 旧 service ticket 全部失效
    end

    rect rgb(255, 220, 220)
        Note over NN,JN3: ② 下一次 sendEdits — SASL 重协商（同步阻塞）
        NN->>KDC: TGS_REQ for jn/JN1（UDP）
        KDC-->>NN: TGS_REP ✓
        NN->>JN1: SASL handshake + sendEdits
        JN1-->>NN: ACK (+1~2s)

        NN->>KDC: TGS_REQ for jn/JN2（UDP）
        KDC-->>NN: TGS_REP ✓
        NN->>JN2: SASL handshake + sendEdits
        JN2-->>NN: ACK (+2~4s)

        NN->>KDC: TGS_REQ for jn/JN3（UDP）
        KDC-->>NN: TGS_REP ✓
        NN->>JN3: SASL handshake + sendEdits
        JN3-->>NN: ACK (+3~5s)
    end
```

**Mar 20 崩溃序列（AS_REQ 本身被丢弃，失败在认证链最前端）**：

```mermaid
sequenceDiagram
    participant NN as "NN1 (dnn130160)"
    participant UGI as "Hadoop UGI"
    participant KDC as "KDC (dnn136021)"
    participant JNs as "3x JournalNode"

    Note over UGI,KDC: 02:36:43 reloginFromKeytab() 触发
    UGI->>KDC: AS_REQ（keytab，UDP port 88）
    Note over KDC: ❌ UDP recv buffer 溢出<br/>AS_REQ 被内核丢弃，无 ISSUE 记录
    Note over UGI: UDP timeout (~1s) → TCP fallback → 同样超时
    Note over UGI: Java Kerberos 库放弃，无 TGT 可用

    Note over NN: sendEdits 已发起（02:36:43），SASL 无法建立
    Note over NN: 02:36:49 Waited 6001ms...
    Note over NN: 02:36:57 Waited 14010ms...
    Note over NN: 02:37:03 Timed out 20000ms
    NN-xJNs: flush failed for required journal
    Note over NN: ExitUtil.terminate(1) 💀 CRASH
```

**Fresh kinit 多维验证汇总**

| 判据 | 观测值 | 结论 |
|---|---|---|
| `authtime` 字段 | = AS_REQ 时间戳（数学验证误差 <2s） | TGT 在 AS_REQ 发出前 2 秒内刚刚签发 = fresh kinit |
| authtime 逐日递增 | 每天 authtime 变化约 +86400s | TGT 是全新签发（续期不改变 authtime） |
| NN1 Active 期间漂移 | +49s/天（每日递迟） | 与 near-expiry 触发模型（60s 阈值）完全吻合 |
| NN2 Standby 间隔 | **精确 19h12m = 80% × 24h**，23 次连续测量 ±30s | Standby 后台刷新线程使用 TICKET_RENEW_WINDOW=0.80 |
| NN2 接管后间隔 | 立即切换为 ~24h | 角色切换驱动 relogin 路径切换，与主机无关 |
| krb5.conf `renew_lifetime` | 注释状态（`#renew_lifetime = 7d`） | Java kinit 不携带 RENEWABLE 标志，KDC 签发非续期 TGT |
| Mar 20 崩溃证据 | KDC 日志 02:36:43~02:37:03 无 nn/ AS_REQ ISSUE | AS_REQ 本身被丢弃，TGT 阶段就已失败 |
| NN2 02:37:05 对比 | NN1 崩溃后 2s，NN2 AS_REQ 立即成功 | KDC 在 02:37:03 后迅速恢复，瞬时不可用而非设备故障 |

---

## 4. KDC UDP 接收缓冲区溢出——系统级隐患

```
[@dnn136021 /var/log]# netstat -su | grep -iE "packet receive errors|receive buffer errors"
    50720417 packet receive errors
    50720417 receive buffer errors

[@dnn136021 /var/log]# sysctl net.core.rmem_max net.core.rmem_default
net.core.rmem_max = 212992      # 208 KB — Linux 内核默认最小值
net.core.rmem_default = 212992
```

> [!warning] 208 KB 的 UDP 缓冲区——KDC 长期丢包的根因
>
> KDC 进程自 2024-01-04 持续运行（约 800 天），累计 **5072 万次** UDP 接收缓冲区溢出，平均每天约 63,000 次。
> 212992 字节 ÷ ~1KB/KRB5包 ≈ **最多只能缓冲 ~200 个 UDP 请求包**。
> 大集群中多节点同时发起 kinit（如凌晨定时任务）时，这个缓冲区在毫秒级就会打满。

**为什么 UDP 丢包导致 Kerberos 超时？**

MIT Kerberos 默认使用 **UDP 端口 88** 通信。客户端先发 UDP 请求，若超时则 fallback 到 TCP。完整行为链如下：

```
客户端发出 AS_REQ (UDP)
  → KDC recv buffer 满，内核直接丢弃（无任何通知）
  → 客户端等待 ~1s timeout
  → fallback 尝试 TCP
  → TCP 如果也超时（KDC 繁忙）→ 整个 AS_REQ 阻塞 >>20s
  → reloginFromKeytab() 无法返回 → sendEdits 超时 → crash
```

**为何平时 WARN 只有 1~5s，3月20日却超过 20s？**

平时：AS_REQ 成功（或偶发 UDP 丢包后 TCP fallback 成功）→ 拿到 TGT → TGS_REQ 成功 → SASL + sendEdits 总耗时 1~5s，超过 1000ms 阈值但不致崩溃。

3月20日：KDC 在 02:36:43 时刻对 NN1 的 AS_REQ（UDP + TCP 均）无响应超过 20s。**KDC 日志在 02:36:43~02:37:03 期间，没有任何 NN1(130160) 的 AS_REQ ISSUE 记录**，而 NN2 在崩溃后 2s（02:37:05）的 AS_REQ 立即成功——说明是 02:36:43 特定时刻的瞬时不可用，而非持续故障。

**加剧因素：retry storm 维持 KDC 高压**

KDC 日志显示，从 130160 发出的 `ambari-server-ec@` AS_REQ 在 02:48~02:49 的 1 分钟内出现 30+ 条密集请求——这是 Kerberos 客户端 retry storm：KDC 无响应 → 快速重试 → 每次重试再占一个 UDP buffer slot → 加剧溢出 → 更多超时 → 更多重试。dnn130160 上运行多个服务进程（`hdfs@`、`HTTP/`、`jhs/`、`ambari-server-ec@`、`nn/` 等），各自维护独立 TGT，并发 kinit 风暴是 208KB 缓冲区长期处于临界状态的直接成因。

---

## 5. 改进措施

### 5.1 立即止血：扩大 QJM 超时（不需要重启）

修改 `hdfs-site.xml`，调大 QJM 写超时，使短暂的 KDC 响应延迟（<1 min）不触发 NN 崩溃：

```xml
<!-- 从默认 20000ms 提升到 60000ms -->
<property>
  <name>dfs.qjournal.write-txns.timeout.ms</name>
  <value>60000</value>
</property>
```

滚动重启 NN 生效。此措施仅扩大了容忍窗口，不解决根因。

### 5.2 根治 KDC UDP 丢包问题

**调大 KDC 主机的 UDP 接收缓冲区**（在 dnn136021 上执行）：

```bash
# 临时生效（立即）
sysctl -w net.core.rmem_max=16777216
sysctl -w net.core.rmem_default=4194304

# 永久生效
cat >> /etc/sysctl.conf << 'EOF'
net.core.rmem_max = 16777216
net.core.rmem_default = 4194304
EOF
sysctl -p
```

**增加 KDC worker 线程数**，处理并发认证请求：

```bash
# /etc/sysconfig/krb5kdc
KRB5KDC_ARGS=-w 4
# 然后 systemctl restart krb5kdc
```

**监控 UDP 丢包**，及时告警：

```bash
# 采集方式：每分钟取 delta
netstat -su | grep "receive buffer errors"
```

### 5.3 减少 kinit 对 JN 写路径的冲击

在 NN 的 `hadoop-env.sh` 或 `core-site.xml` 中，延长 minimum relogin 间隔（防止异常场景下频繁重试 kinit 加剧 KDC 压力）：

```xml
<property>
  <name>hadoop.kerberos.min.seconds.before.relogin</name>
  <value>120</value>
</property>
```

### 5.4 利用已有的 Slave KDC 基础设施实现 KDC HA（成本最低）

`kdc.conf` 中 `iprop_enable = true`、`iprop_slave_poll = 300s` 说明**集群已有 Slave KDC 在运行**，principal 数据库每 5 分钟同步一次。当前唯一缺少的只是把 Slave KDC 地址告诉客户端。

**Step 1**：确认 Slave KDC 地址：

```bash
# 在 KDC 主机上查看传播授权
cat /var/kerberos/krb5kdc/kpropd.acl
```

**Step 2**：通过 Ambari / Salt 批量更新集群所有节点的 `krb5.conf`（无需重启任何服务）：

```ini
[realms]
  VENUS.SOHURDC.COM = {
    kdc = dnn136021.venus.sohurdc.com    # Primary
    kdc = <slave-kdc-hostname>            # Slave（从 kpropd.acl 查得）
    admin_server = dnn136021.venus.sohurdc.com
  }
```

MIT Kerberos 客户端按顺序尝试列表中的 KDC，Primary 不可达时在 ~3s 内自动切换 Slave。

---

## 6. krb5kdc 日志管理

### 6.1 当前问题

`/var/log/krb5kdc.log` 体积已达 **14~40GB**，MIT Kerberos 原生不支持日志滚动，只能通过外部机制解决。

### 6.2 方案一：logrotate（推荐）

krb5kdc 支持 `SIGHUP` 信号重新打开日志文件（`systemd` 的 `ExecReload` 已配置 `kill -HUP $MAINPID`）。

创建 `/etc/logrotate.d/krb5kdc`：

```
/var/log/krb5kdc.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    dateext
    dateformat -%Y%m%d
    postrotate
        /bin/kill -HUP $(cat /var/run/krb5kdc.pid 2>/dev/null) 2>/dev/null || true
    endscript
}
```

手动测试：

```bash
logrotate -vf /etc/logrotate.d/krb5kdc
ls -lh /var/log/krb5kdc.log*
```

### 6.3 方案二：切换为 syslog/journald

修改 `krb5.conf` 的 `[logging]` 段，将 KDC 日志输出到 syslog：

```ini
[logging]
  kdc = SYSLOG:INFO:daemon
  admin_server = SYSLOG:INFO:daemon
```

重启 krb5kdc 后，日志由 rsyslog/journald 管理，可直接复用现有的日志轮转配置，并支持 `journalctl -u krb5kdc` 查询。

> [!note] 注意事项
> 切换 syslog 模式后，现有的 `grep` 提取方式需要改为 `journalctl -u krb5kdc --since "..." | grep ...` 或查询 `/var/log/daemon.log`（取决于 rsyslog 配置）。

---

## 7. 验证项汇总（均已闭环）

| 项目 | 观测值 | 结论 |
|---|---|---|
| TGT ticket lifetime | KDC 默认 24h，`kadmin getprinc` 未单独设置 | kinit 周期以 24h 为基准 |
| TGT 可续期性 | `Maximum renewable life: 7 days`（kdc.conf `renewable=true`）；krb5.conf `#renew_lifetime = 7d`（注释） | Java kinit 不携带 RENEWABLE 标志，KDC 签发非续期 TGT；authtime 逐日更新证实 fresh kinit |
| UDP 接收缓冲区 | `net.core.rmem_max = 212992`（208 KB，Linux 默认最小值） | ~200 个 KRB5 包即可打满，严重不足 |
| KDC 侧配置 | `iprop_enable=true`，`iprop_slave_poll=300s` | Slave KDC 已在运行，数据库每 5min 同步 |
| AS_REQ 时序验证 | NN1 Mar 2~19 每日一次 AS_REQ ISSUE（authtime 与时间戳差 <2s）；Mar 20 崩溃窗口 02:36:43~02:37:03 无 nn/ AS_REQ ISSUE | Fresh kinit 直接证据闭环；AS_REQ 本身被 KDC 丢弃，失败在认证链最前端（TGT 阶段） |
| Active/Standby 差异 | NN1 Active：~24h（+49s/天）；NN2 Standby：19h12m ± 30s（= 80% × 24h，23次测量） | kinit 路径由角色决定，接管后 NN2 切换为 24h，NN1 重启后切回 19h12m |

**AS_REQ 验证命令**（MIT Kerberos 日志格式：`AS_REQ` 在前，IP 在后）：

```bash
# 提取 NN1 的 nn/ principal AS_REQ 完整序列
ionice -c 3 nice -n 19 grep "AS_REQ" /var/log/krb5kdc.log \
  | grep "nn/dnn130160"

# 验证 Mar 20 崩溃窗口无 AS_REQ（关键证据）
ionice -c 3 nice -n 19 grep "AS_REQ" /var/log/krb5kdc.log \
  | grep "nn/dnn130160" \
  | grep "Mar 20"
# 预期：仅 02:51:45 和 02:52:46（崩溃后重启），无 02:36:xx 记录

# 对比 NN2 Standby 期间 19h12m 间隔规律
ionice -c 3 nice -n 19 grep "AS_REQ" /var/log/krb5kdc.log \
  | grep "nn/dnn130161" \
  | awk '{print $1,$2,$3}'
```

---

## 相关文档

- [[HiveServer2 Kerberos 认证故障深度分析报告]]
- [[HDFS HA 架构与 QJM 原理]]
