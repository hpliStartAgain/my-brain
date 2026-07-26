---
title: "TCP 性能调优——拥塞控制、Nagle 与缓冲区优化"
date: 2026-03-02
tags: [BBR, BDP, CUBIC, Linux, Nagle, RTT, TCP, TCP_CORK, TCP_NODELAY, 拥塞控制, 缓冲区调优, 网络调优]
aliases: ["TCP拥塞控制", "BBR算法原理", "TCP缓冲区调优", "Nagle算法", "TCP性能优化"]
---

**摘要：**

TCP 是互联网的基石，但它的默认配置并不总是最优的。理解 TCP 性能调优，需要先理解 TCP 设计时面对的根本矛盾：**如何在不知道网络容量（带宽、延迟、缓冲区大小）的情况下，尽可能快地传输数据，同时不引发网络拥塞**。这个矛盾催生了 TCP 拥塞控制算法——从 1988 年的 Tahoe 到 Reno、NewReno、CUBIC，再到 2016 年 Google 提出的 BBR，每一代算法都在"探测网络容量"和"避免拥塞"之间寻找更优的平衡点。本文聚焦三个维度的调优：一，拥塞控制算法选择——CUBIC（Linux 默认）在高 BDP 网络上的瓶颈，以及 BBR 如何通过测量带宽和 RTT（而非丢包）来感知网络容量，在长距离高带宽链路上比 CUBIC 快 2-25 倍；二，小包优化——Nagle 算法为什么能减少网络包数，何时该关闭（`TCP_NODELAY`），以及 `TCP_CORK` 作为 Nagle 的补充如何与 `sendfile()` 配合；三，缓冲区调优——`net.ipv4.tcp_rmem`/`tcp_wmem` 的三元组语义，带宽延迟积（BDP）计算方法，以及什么是"缓冲区膨胀（Bufferbloat）"问题及其危害。

---

## 第 1 章 TCP 拥塞控制的本质问题

### 1.1 为什么需要拥塞控制

1986 年，互联网发生了第一次"拥塞崩溃（Congestion Collapse）"——网络 ARPANET 上的吞吐量从 32 Kbps 突然跌落到 40 bps，原因是路由器缓冲区被大量重传包填满，新数据包被丢弃，触发更多重传，形成恶性循环。

这个事件揭示了没有拥塞控制时 TCP 的本质缺陷：每个 TCP 连接都会尽可能快地发送数据，争抢网络资源，就像没有交通灯的路口——每辆车都全速冲过去，最终导致全部堵死。

**拥塞控制解决的核心问题**：在不事先知道网络容量的情况下，动态调整发送速率，使得总发送速率 ≤ 网络容量，同时每条连接尽可能多地利用可用带宽。

### 1.2 TCP 拥塞控制的四个阶段

TCP 拥塞控制由四个经典阶段组成（以 CUBIC 之前的 Reno 为基础理解）：

**阶段 1：慢启动（Slow Start）**

新连接建立后，TCP 不知道网络能承受多大的发送速率，从一个保守的起点（初始拥塞窗口 `initcwnd`，现代 Linux 默认 10×MSS ≈ 14KB）开始，每收到一个 ACK 就将 cwnd 加 1（即每个 RTT，cwnd 翻倍）——指数增长，快速探测网络容量：

```
RTT 1：cwnd = 10 segments（初始值）
RTT 2：cwnd = 20（每个 ACK +1，一个 RTT 内翻倍）
RTT 3：cwnd = 40
RTT 4：cwnd = 80
...
直到 cwnd 达到 ssthresh（慢启动阈值）或发生丢包
```

**阶段 2：拥塞避免（Congestion Avoidance）**

当 cwnd 达到 ssthresh 后，慢启动阶段结束，进入拥塞避免阶段——每个 RTT 只将 cwnd 加 1（线性增长，比慢启动保守），继续探测上限：

```
每收到一个 ACK：cwnd += 1/cwnd（效果：每个 RTT，cwnd += 1）
```

**阶段 3：拥塞检测——丢包信号**

拥塞的信号是**丢包**：
- **3 个重复 ACK（快速重传）**：轻微拥塞，cwnd 减半（`ssthresh = cwnd/2`，新 `cwnd = ssthresh`），进入拥塞避免继续线性增长
- **超时（RTO）**：严重拥塞，cwnd 重置为 1（重新进入慢启动）

**阶段 4：快速恢复（Fast Recovery）**

3 个重复 ACK 触发快速重传后，进入快速恢复——在等待重传确认期间，窗口不完全关闭，允许少量新数据继续发送，避免管道完全空载。

### 1.3 Reno/CUBIC 算法的"锯齿"特征

基于丢包的拥塞控制算法（Reno、CUBIC）有一个显著特征——**锯齿波形**：不断增大 cwnd 直到触发丢包，然后减半，再增大，再减半，周而复始：

```
cwnd 变化曲线（基于丢包的算法）：

cwnd
  |         /\        /\        /\
  |        /  \      /  \      /  \
  |       /    \    /    \    /    \
  |      /      \  /      \  /      \
  |     /        \/        \/        \
  |----/
  +----------------------------------------→ 时间
  
每次"倒V"形都是一次丢包触发的 cwnd 减半
```

**这个锯齿的代价**：每次丢包后都有一段时间 cwnd 偏低，网络管道没有被充分利用（"管道空洞"），总吞吐量不能达到理论最大值，尤其在高 BDP 网络（高带宽 × 高延迟）上更为明显。

---

## 第 2 章 CUBIC：Linux 默认的拥塞控制算法

### 2.1 CUBIC 解决了什么问题

CUBIC（Linux 2.6.19，2006 年成为默认）是针对高速长距离网络（High-BDP 网络）设计的拥塞控制算法，解决了 Reno 在高 BDP 网络上的两个问题：

**问题 1：Reno 增窗太慢**

Reno 在拥塞避免阶段每 RTT 只增加 1 个 MSS。在 10 Gbps × 100ms RTT 的网络（BDP = 125 MB）上，窗口从减半恢复到最大值需要 **数万个 RTT**（数秒），期间网络利用率极低。

**问题 2：RTT 公平性问题**

Reno 的线性增长速率与 RTT 成反比——短 RTT 的连接增窗快，长 RTT 的连接增窗慢，导致短 RTT 连接在共享瓶颈链路上占有更多带宽（不公平）。

**CUBIC 的解法**：用**三次函数（cubic function）**替代线性增窗：

```c
/* CUBIC 拥塞窗口的计算公式 */
W(t) = C × (t - K)³ + Wmax

/* 其中：
   Wmax：上次丢包时的窗口大小
   K：从 cwnd = 0 增长到 Wmax 需要的时间（预测值）
   C：缩放因子（约 0.4）
   t：距上次丢包的时间（秒，独立于 RTT！）
*/
```

**CUBIC 的三次函数曲线特征**：
- 在 Wmax 附近变化平缓（凹形），谨慎探测——已知此处网络容量即将饱和
- 远离 Wmax 时变化陡峭（凸形），快速恢复——网络容量有余量，大胆增窗

```
CUBIC cwnd 变化曲线：

cwnd
  |          .......  Wmax -------.......
  |       ...                        ...
  |     ..                              ..
  |   ..     凹（平缓）         凸（快速）  ..
  |  .                                    .
  +-----------------------------------------→ 时间（与 RTT 无关！）
```

**时间独立于 RTT** 是 CUBIC 相对于 Reno 的关键改进——相同时间内，所有 RTT 的连接增窗速率相同，解决了 RTT 公平性问题。

### 2.2 CUBIC 的局限：丢包信号的噪声问题

CUBIC 仍然基于**丢包**作为拥塞信号，而在现代网络中，丢包不再是纯粹的"拥塞信号"：

1. **缓冲区膨胀（Bufferbloat）**：现代路由器/交换机有深度缓冲区（数百 MB），即使链路已经饱和，缓冲区也能暂时接收数据包——丢包被大大延迟，CUBIC 会将 cwnd 增大到远超链路容量的水平，导致缓冲区大量积压，延迟剧增（即使带宽没有问题，延迟可能从 5ms 增至 500ms）
2. **无线网络的随机丢包**：WiFi 等无线网络的丢包可能是信号衰减导致的，而非拥塞——CUBIC 会错误地将其识别为拥塞信号，无谓地降低 cwnd

---

## 第 3 章 BBR：测量带宽而非等待丢包

### 3.1 BBR 的设计哲学转变

**BBR（Bottleneck Bandwidth and Round-trip propagation time）**，2016 年由 Google 提出（Neal Cardwell、Yuchung Cheng 等人），是 TCP 拥塞控制算法的一次范式转变：**从"以丢包为信号被动反应"变为"主动测量网络容量（带宽 + RTT）然后主动控制"**。

BBR 的核心洞察：一条网络路径的传输能力可以用两个量完整描述：
- **BtlBw（瓶颈带宽，Bottleneck Bandwidth）**：路径上的最小链路带宽
- **RTprop（传播时延，Round-trip Propagation Time）**：数据包在网络中传播的最小延迟（不含排队延迟）

**最优工作点**：发送速率 = BtlBw，在途数据量 = BtlBw × RTprop（恰好填满"管道"，不多不少）

当发送速率超过 BtlBw 时，多余的数据包进入路由器缓冲区，RTT 开始增大（出现排队延迟）。BBR 通过**检测 RTT 是否开始增大**（而非等待丢包）来感知拥塞——这比等待丢包早得多，能在缓冲区被填满之前就降速。

### 3.2 BBR 的四个阶段

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph LR
    classDef startup fill:#ffb86c,stroke:#ff79c6,color:#282a36
    classDef drain fill:#ff5555,stroke:#ff5555,color:#f8f8f2
    classDef probe fill:#50fa7b,stroke:#69ff47,color:#282a36
    classDef probeRTT fill:#6272a4,stroke:#bd93f9,color:#f8f8f2

    S["STARTUP</br>指数增速，探测 BtlBw"]:::startup
    D["DRAIN</br>快速降速，清空积压"]:::drain
    PB["PROBE_BW</br>稳定发送，周期性探测带宽"]:::probe
    PR["PROBE_RTT</br>周期性降速，测量最小 RTT"]:::probeRTT

    S -->|"BtlBw 不再增长"| D
    D -->|"在途数据量 = BDP"| PB
    PB -->|"每 10 秒"| PR
    PR -->|"200ms 后"| PB
```

**STARTUP（慢启动阶段）**：指数增速（类似传统慢启动），直到检测到 BtlBw 不再增长（连续 3 轮 RTT BtlBw 没有提升），说明已探测到瓶颈带宽。

**DRAIN（排队清空阶段）**：STARTUP 阶段发送过快，路由器缓冲区积累了数据包。DRAIN 阶段将发送速率降低到 BtlBw 以下（pacing_gain < 1），等待在途数据量降至 BDP，清空积压。

**PROBE_BW（稳定工作阶段，约占 98% 时间）**：在 BtlBw × RTprop 的速率附近稳定发送。每 8 个 RTT 的周期中，有 1 个 RTT 以 1.25×BtlBw 探测（尝试发现带宽是否提升），有 1 个 RTT 以 0.75×BtlBw 排队清理，其余 6 个 RTT 以 1.0×BtlBw 稳定发送。

**PROBE_RTT（最小 RTT 探测）**：每隔 10 秒，将 cwnd 降到 4×MSS 约 200ms，测量最小 RTT（排除排队延迟，得到"纯传播延迟"），更新 RTprop 估计值。

### 3.3 BBR 在 Linux 上的启用与测试

```bash
# 查看当前拥塞控制算法
sysctl net.ipv4.tcp_congestion_control
# cubic（默认）

# 查看所有可用的算法
sysctl net.ipv4.tcp_available_congestion_control
# reno cubic bbr  ← bbr 可用（内核 4.9+）

# 全局切换到 BBR（需 root）
sysctl -w net.ipv4.tcp_congestion_control=bbr

# 永久生效（写入 /etc/sysctl.conf）
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
echo "net.core.default_qdisc=fq"  >> /etc/sysctl.conf  # BBR 需要 Fair Queue 调度器
sysctl -p

# 验证单条连接使用的算法
ss -tni dst 192.168.1.100 | grep -i "congestion\|bbr\|cubic"
# cubic         ← 老连接仍用 cubic
# bbr           ← 新连接使用 bbr
```

**BBR 需要配合 `fq`（Fair Queue）流量调度器**：BBR 的 pacing（速率整形）需要内核的 `fq` 队列调度器按照 BBR 计算的速率精确控制发包间隔（而非"一次性塞满缓冲区"）。没有 `fq` 的 BBR 效果会大打折扣。

### 3.4 BBR vs CUBIC：在哪些场景下 BBR 更优

| 场景 | CUBIC | BBR | 原因 |
|-----|-------|-----|-----|
| 局域网（低 RTT，低丢包）| 差不多 | 差不多 | BDP 小，两者都能快速填满管道 |
| 跨洲际（高 RTT，低丢包）| 慢（恢复窗口需要很多 RTT）| **快 2-25×** | BBR 直接按 BtlBw 发送，不浪费时间在"锯齿"上 |
| 有随机丢包的网络（WiFi、卫星）| 慢（随机丢包误判为拥塞）| **快** | BBR 不依赖丢包作为信号，随机丢包不触发降速 |
| 深缓冲区（Bufferbloat）| 会填满缓冲区，高延迟 | **延迟低** | BBR 在缓冲区填满前就降速 |
| 共享瓶颈（BBR + CUBIC 混合）| CUBIC 可能被挤压 | 公平性问题 | BBR 更激进，可能占用更多带宽（Google 承认的问题）|

> [!warning] 生产避坑：BBR 的公平性问题
> 当网络中同时存在 BBR 和 CUBIC 的 TCP 流时，BBR 流可能抢占大部分带宽，对 CUBIC 流不公平。这在共享互联网出口（如 IDC 多租户环境）是潜在风险。建议：**所有服务都切换到 BBR**（全局一致），而非混合使用。

---

## 第 4 章 小包优化：Nagle、TCP_NODELAY 与 TCP_CORK

### 4.1 Nagle 算法：为什么小包是问题

1984 年，John Nagle 在 RFC 896 中描述了互联网的"小包问题（Small Packet Problem）"：一个 Telnet 连接（当时典型的交互式应用）的每次按键会产生一个仅含 1 字节数据的 TCP 包——加上 40 字节的 TCP + IP 头，每个包的头部开销是数据的 40 倍，严重浪费带宽，且在慢速网络上产生大量微小包，可能导致拥塞。

**Nagle 算法的规则**（非常简单）：

```
如果发送缓冲区中的数据 >= MSS：
    立即发送（满包，发送合理）
否则（小包）：
    如果当前没有"在途"的未确认数据（即上一个包的 ACK 已返回）：
        立即发送（管道空，无需等待）
    否则（有在途数据）：
        等待，直到数据积累到 >= MSS，或收到对方的 ACK
```

**Nagle 算法解决了什么**：连续的小写入（如 `write(sock, "a", 1)` 被多次调用）会被合并成一个大包发送，减少了包数，提升了带宽利用率。

**Nagle 算法与延迟 ACK（Delayed ACK）的死锁**：

延迟 ACK（Linux 默认开启）的规则是：收到数据后不立即 ACK，等 40ms 或等下一个包到来时再 ACK（期望通过携带数据的 ACK 减少 ACK 包数）。

但当 Nagle 和延迟 ACK 同时开启时，会产生死锁：

```
发送方                    接收方
发送 小包1（有在途数据）
                          收到 小包1，等待 40ms 再 ACK（延迟 ACK）
等待 ACK（Nagle）
                          40ms 后发送 ACK（超时）
收到 ACK，发送 小包2
```

**每次发送都要等 40ms**（延迟 ACK 的超时），吞吐量大幅下降，延迟增加。这是 Nagle 算法最著名的陷阱，在 Redis、MySQL 等高频小包应用中尤为明显。

### 4.2 TCP_NODELAY：关闭 Nagle 的正确场景

```c
int opt = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt));
```

**应该关闭 Nagle（开启 TCP_NODELAY）的场景**：
- **延迟敏感的交互式应用**：Redis（命令-响应模式）、gRPC、SSH、在线游戏、实时通话
- **小请求-大响应模式**：HTTP 请求通常很小（几十字节），如果请求包因为 Nagle 被延迟，整个响应延迟都会增加

**应该保留 Nagle 的场景**：
- **大文件传输**：数据总是 >= MSS，Nagle 不会触发等待
- **流式数据传输**：写入速率快，缓冲区很快积累到 MSS
- **已有其他批量化机制**（如 `TCP_CORK`）

```bash
# 检查连接是否启用了 TCP_NODELAY
ss -tni | grep -i nodelay
# ... nodelay ...  ← 出现表示已关闭 Nagle

# Redis 的默认配置
grep tcp-nodelay /etc/redis/redis.conf
# tcp-nodelay yes  ← Redis 默认关闭 Nagle
```

### 4.3 TCP_CORK：Nagle 的"大锤"版本

`TCP_CORK`（Linux 专有，类似 `TCP_NOPUSH`）是更极端的批量化工具：开启后，TCP 会**完全停止发送**小包，直到：
- 数据积累到 >= MSS
- `TCP_CORK` 被关闭
- 超时（200ms）

```c
/* TCP_CORK 的典型用法：发送 HTTP 响应头 + 文件内容 */
int cork = 1;
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &cork, sizeof(cork));
/* 开启 cork，后续写入都暂存在发送缓冲区 */

/* 写入 HTTP 响应头（通常几百字节，< MSS）*/
write(fd, http_header, header_len);

/* 调用 sendfile 写入文件内容（可能是很多个 MSS 的数据）*/
sendfile(fd, file_fd, &offset, file_size);

/* 关闭 cork，立即将缓冲区中的所有数据发出 */
cork = 0;
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &cork, sizeof(cork));
```

**Nginx 的 `sendfile on + tcp_nopush on + tcp_nodelay on` 组合**：

这三者同时开启时，工作方式如下：
1. 发送 HTTP 响应头时，`tcp_nopush`（`TCP_CORK`）激活，头部暂存
2. `sendfile()` 将文件内容加入发送队列（也受 `TCP_CORK` 暂存）
3. 文件发送完毕，`TCP_CORK` 关闭，所有数据一次性发出（最大化包大小）
4. 若剩余最后一小块数据，`tcp_nodelay` 确保立即发出（不再等待）

这个组合在发送大文件时能将 TCP 包数减少到最少，同时保证最后一个小包不被 Nagle 延迟。

---

## 第 5 章 TCP 缓冲区调优的方法论

### 5.1 带宽延迟积（BDP）：调优的核心参数

**BDP（Bandwidth Delay Product）** 是理解 TCP 缓冲区调优的基础概念：

```
BDP = 带宽（bit/s）× RTT（s）

物理含义：在一个 RTT 内，网络管道能容纳的数据量
要充分利用网络带宽，TCP 接收缓冲区必须 >= BDP
```

**典型场景的 BDP 计算**：

| 场景 | 带宽 | RTT | BDP |
|-----|-----|-----|-----|
| 同机房内 | 10 Gbps | 0.1 ms | 125 KB |
| 同城 IDC | 1 Gbps | 1 ms | 125 KB |
| 跨城（北京→上海）| 1 Gbps | 20 ms | 2.5 MB |
| 跨洲（中国→美国）| 1 Gbps | 150 ms | 18.75 MB |
| 跨洲（10 Gbps 专线）| 10 Gbps | 150 ms | 187.5 MB |

**结论**：对于跨洲际的高带宽传输，默认的 TCP 接收缓冲区（约 128 KB–6 MB）远远不够，必须手动调大或依赖 Autotuning 的上限调整。

### 5.2 tcp_rmem 和 tcp_wmem：三元组的语义

```bash
# 查看接收缓冲区配置
sysctl net.ipv4.tcp_rmem
# 4096   131072   6291456
#  ↑       ↑          ↑
# 最小值  默认值    Autotuning 上限

# 查看发送缓冲区配置
sysctl net.ipv4.tcp_wmem
# 4096   16384    4194304
#  ↑       ↑          ↑
# 最小值  默认值    最大值
```

**三个值的精确含义**：

- **最小值（min）**：内存紧张时 socket 最小保留的缓冲区大小，确保 socket 始终可用
- **默认值（default）**：新建连接的初始缓冲区大小（若未调用 `setsockopt(SO_RCVBUF)`）
- **最大值（max）**：Autotuning 可以自动扩展到的上限（接收缓冲区）；或 `setsockopt(SO_SNDBUF)` 可设置的上限（发送缓冲区）

**跨洲际高吞吐场景的推荐配置**：

```bash
# 针对高 BDP 网络（>18 MB BDP）的优化配置
# 接收缓冲区：上限 64 MB，支持 10 Gbps × 150ms 的 BDP
sysctl -w net.ipv4.tcp_rmem="4096 131072 67108864"

# 发送缓冲区：上限 16 MB（发送通常不需要像接收那么大）
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216"

# 全局 socket 缓冲区上限（影响所有协议的 socket，不只是 TCP）
sysctl -w net.core.rmem_max=67108864
sysctl -w net.core.wmem_max=16777216

# 确保 Autotuning 开启
sysctl -w net.ipv4.tcp_moderate_rcvbuf=1
```

### 5.3 缓冲区膨胀（Bufferbloat）：调大缓冲区的代价

**Bufferbloat 是什么**：当网络链路上的中间设备（路由器、交换机）有非常大的缓冲区时，即使链路已经接近满载，数据包也不会被丢弃，而是排队等候——队列延迟急剧增加，从几毫秒到几百毫秒：

```
网络链路的实际延迟 = 传播延迟（固定）+ 排队延迟（取决于缓冲区填充程度）

正常情况（缓冲区空）：  延迟 = 5ms（纯传播）
缓冲区满载（Bufferbloat）：延迟 = 5ms + 500ms（排队）= 505ms！
```

**Bufferbloat 的危害**：
- 视频通话、在线游戏卡顿（延迟突增）
- 使用下载时 ping 值飙升（下载占满缓冲区，其他流量排队）
- TCP 的 RTT 测量失真（测到的是排队延迟，而非网络本身的延迟）

**BBR 对 Bufferbloat 的缓解**：BBR 基于测量 RTT（而非等待丢包）来感知拥塞，在缓冲区填满之前就降速，显著减少了排队积压。

**Linux 内核的解法：FQ-CoDel（Fair Queue Controlled Delay）**：

```bash
# 查看当前流量调度器
tc qdisc show dev eth0
# qdisc mq 0: root refcnt 5  ← 多队列（不含 AQM）

# 切换到 fq_codel（主动队列管理，缓解 Bufferbloat）
tc qdisc replace dev eth0 root fq_codel

# 或者使用 cake（更现代的 AQM，Cobalt 算法）
tc qdisc replace dev eth0 root cake bandwidth 1gbit
```

CoDel（Controlled Delay）的核心思想：**监控数据包在队列中的停留时间**（sojourn time），若超过 5ms 就主动丢弃包（触发 TCP 降速），防止缓冲区无限积压。这是从根本上解决 Bufferbloat 的内核机制。

---

## 第 6 章 TCP 性能调优的完整检查清单

### 6.1 诊断 TCP 性能问题的工具链

```bash
# 1. 查看单条 TCP 连接的详细状态（ss -ti 信息最全）
ss -tiP dst 192.168.1.100
# 输出包含：
#  cwnd（当前拥塞窗口）
#  ssthresh（慢启动阈值）
#  rtt（平均 RTT 和 RTT 方差）
#  send/recv queue（收发队列积压）
#  retrans（重传次数）
#  bytes_acked, bytes_received
#  congestion algorithm（使用的拥塞控制算法）

# 典型输出示例：
# ESTAB 0 0 10.0.0.1:80 10.0.0.2:54321 users:(("nginx",pid=1234,fd=5))
#     cubic wscale:7,7 rto:200 rtt:1.5/0.3 ato:40 mss:1448 pmtu:1500
#     rcvmss:536 advmss:1448 cwnd:10 ssthresh:7 bytes_acked:12340
#     segs_out:100 segs_in:50 send 77Mbps lastsnd:10 lastrcv:20 lastack:15
#     pacing_rate 92.2Mbps delivery_rate 77Mbps delivered:90 app_limited:1
#     busy:10ms unacked:2 retrans:0/0 dsack_dups:0 reord_seen:0 rcv_rtt:1.5
```

**`app_limited:1` 的含义**：应用层限制（application limited）——说明 cwnd 有余量，但应用程序 `send()` 速度不够快（读磁盘太慢、处理逻辑阻塞等）。这时 TCP 不是瓶颈，应用层才是。

**`delivery_rate` vs `send` 速率**：`delivery_rate` 是 TCP 实际确认交付的速率，`send` 是 TCP 层计算的最大发送速率。两者相差悬殊时，说明有严重的包丢失或延迟。

### 6.2 综合调优配置（生产环境推荐）

```bash
# /etc/sysctl.conf 调优配置（适合高并发 Web 服务器）

# ── 拥塞控制 ─────────────────────────────
net.ipv4.tcp_congestion_control = bbr     # 使用 BBR（内核 4.9+）
net.core.default_qdisc = fq               # BBR 配套调度器

# ── TCP 缓冲区 ───────────────────────────
net.ipv4.tcp_rmem = 4096 131072 67108864  # 接收缓冲区 [min, default, max=64MB]
net.ipv4.tcp_wmem = 4096 65536 16777216   # 发送缓冲区 [min, default, max=16MB]
net.core.rmem_max = 67108864              # socket 接收缓冲区系统上限
net.core.wmem_max = 16777216              # socket 发送缓冲区系统上限
net.ipv4.tcp_moderate_rcvbuf = 1          # 开启接收缓冲区 Autotuning

# ── 连接队列 ─────────────────────────────
net.core.somaxconn = 4096                 # accept 队列上限
net.ipv4.tcp_max_syn_backlog = 8192       # SYN 队列（半连接队列）上限

# ── TIME_WAIT 优化 ────────────────────────
net.ipv4.tcp_tw_reuse = 1                 # 允许客户端复用 TIME_WAIT 连接
net.ipv4.tcp_fin_timeout = 30             # FIN_WAIT_2 超时（默认 60s）

# ── 连接保活 ─────────────────────────────
net.ipv4.tcp_keepalive_time = 300         # 开始保活探测的空闲时间（默认 7200s=2小时，太长）
net.ipv4.tcp_keepalive_intvl = 15         # 保活探测间隔（默认 75s）
net.ipv4.tcp_keepalive_probes = 5         # 保活探测次数（默认 9 次）

# ── 其他优化 ─────────────────────────────
net.ipv4.tcp_slow_start_after_idle = 0    # 禁止空闲后重置 cwnd（长连接优化）
net.ipv4.tcp_fastopen = 3                 # 开启 TCP Fast Open（客户端+服务端）
net.ipv4.tcp_window_scaling = 1           # 开启窗口缩放（默认已开启）
net.ipv4.tcp_sack = 1                     # 开启 SACK（默认已开启）
net.ipv4.tcp_timestamps = 1               # 开启 TCP 时间戳（RTT 测量更准确）
```

> [!info] 核心概念：tcp_slow_start_after_idle
> `net.ipv4.tcp_slow_start_after_idle = 1`（默认）意味着：如果一条 TCP 连接空闲超过 1 个 RTO，重新发送数据时 cwnd 会被重置为初始值（10×MSS），重新进入慢启动。这对于使用连接池的应用（数据库连接池、HTTP/2 多路复用）非常有害——连接空闲一段时间后，第一个请求会经历一段慢启动的低速期。设置为 0 禁用此行为，让 cwnd 在连接空闲后保持不变。

---

## 小结

TCP 性能调优的三条主线：

**拥塞控制算法**：BBR 通过主动测量带宽+RTT（而非被动等待丢包）来感知网络容量，在高 BDP 和有随机丢包的网络上大幅优于 CUBIC；生产环境配合 `fq` 调度器使用；注意 BBR+CUBIC 混合部署时的公平性问题。

**小包优化**：Nagle 算法 + 延迟 ACK 的组合在交互式场景会产生 40ms 的死锁延迟，Redis/gRPC 等应用应开启 `TCP_NODELAY`；`TCP_CORK` 是 Nginx 静态文件服务的批量化武器，与 `sendfile()` 搭配效果最佳。

**缓冲区调优**：缓冲区大小需要 >= BDP 才能充分利用带宽；让 Autotuning 自动管理（只调整上限，不手动设置 `SO_RCVBUF`）；注意缓冲区过大会导致 Bufferbloat（高延迟），使用 `fq_codel` 或 `cake` 主动队列管理解决。

下一篇 [[07 Linux 网络包的完整收发路径——软中断、NAPI 与 XDP]] 将深入到网络栈的最底层：从网卡触发硬中断开始，分析 Linux 的 NAPI（New API）如何用软中断轮询替代高频硬中断，降低 CPU 上下文切换开销，以及 XDP（eXpress Data Path）如何在网卡驱动层面直接处理数据包，绕过整个内核网络栈，实现每秒千万级的包处理能力。

---

> [!note] 思考题
> 1. 同步/异步描述的是'谁主动获取结果'——同步是调用者轮询/等待，异步是内核回调通知。阻塞/非阻塞描述的是'调用是否立即返回'。很多开发者混淆'非阻塞 IO'和'异步 IO'——非阻塞 IO 的 `read` 在数据未就绪时返回 EAGAIN（同步非阻塞），真正的异步 IO（如 AIO、io_uring）在数据就绪后由内核回调通知。在实际的高性能服务器中，使用最多的是哪种 IO 模型？为什么真正的异步 IO（POSIX AIO）在 Linux 上很少被使用？
> 2. Reactor 模式（epoll + 非阻塞 IO）是 Nginx、Redis、Netty 的核心模型。Proactor 模式（异步 IO + 完成回调）是 Windows IOCP 和 io_uring 的模型。Reactor 在 IO 就绪时通知应用'可以读了'，应用再调用 read；Proactor 直接由内核完成 read 操作后通知应用'已经读完了'。Proactor 在什么场景下性能优于 Reactor？
> 3. Node.js 使用 libuv 的 Event Loop 模型——看似单线程但底层使用线程池处理文件 IO（因为 Linux 的文件 IO 没有真正的异步支持，epoll 不支持普通文件）。io_uring 改变了这个局面——它支持文件的真正异步 IO。如果 Node.js 底层从线程池切换到 io_uring，会有什么性能提升？
