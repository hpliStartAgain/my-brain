---
title: "网络性能诊断——从 ss 到 perf/eBPF 的全套工具链"
date: 2026-03-02
tags: [Linux, 网络诊断, ss, tcpdump, perf, eBPF, BCC, bpftrace, 性能分析, 网络调优, 工具链]
aliases: ["Linux网络诊断工具", "ss命令详解", "tcpdump使用", "eBPF网络追踪", "BCC工具集", "网络性能分析"]
---

**摘要：**

工具链是理论与实践之间的桥梁。前面九篇文章建立了 Linux 网络栈从内核到应用的完整知识体系，但在生产环境中，真正有价值的能力是：**遇到网络性能问题时，能快速定位根因**。这需要掌握一套分层的诊断工具链：第一层，`ss`/`netstat` 看连接状态全貌（TIME_WAIT 积压、CLOSE_WAIT 泄漏、接收队列溢出）；第二层，`ethtool`/`ifconfig`/`ip` 看网卡层面的丢包与错误计数；第三层，`tcpdump`/`Wireshark` 在数据包级别重放故障现场（TCP 重传、乱序、窗口探测）；第四层，`perf` 对内核网络函数进行 CPU profiling，找到热点函数（是 TCP ACK 处理慢还是 iptables 遍历慢？）；第五层，`BCC`/`bpftrace` 用 eBPF 实现实时的、零侵入的内核路径追踪，可以直接观察 `tcp_retransmit_skb`、`tcp_rcv_established` 等内核函数的调用情况，以及任意 socket 的 RTT、cwnd、重传次数变化。本文按照"从粗到细、从用户态到内核态"的诊断思路，系统梳理每一层工具的核心用法，以及每个工具最适合回答的问题。

---

## 第 1 章 诊断方法论：先问对问题

### 1.1 网络问题的四个维度

网络性能问题通常表现为以下症状之一：**高延迟**（请求慢）、**低吞吐**（带宽不足）、**高丢包**（数据丢失/重传）、**连接建立/关闭异常**（大量 TIME_WAIT/CLOSE_WAIT/SYN_RCVD）。诊断前，先明确症状属于哪个维度，选择对应的工具：

| 症状 | 优先检查的工具 | 典型根因 |
|-----|-------------|---------|
| 请求延迟高（P99 > P50 × 10）| `ss -ti`（查 RTT/重传）、`tcpdump`（抓包看时序）| 网络丢包导致重传、Nagle+延迟 ACK 死锁、连接队列满 |
| 吞吐量低（带宽远未打满）| `ss -ti`（查 cwnd/rwnd）、`sysctl tcp_rmem` | 接收缓冲区小（BDP 不足）、拥塞控制保守、中间设备限速 |
| 丢包（rx_dropped/tx_errors）| `ethtool -S`、`netstat -s`（看 drop 计数）| Ring Buffer 溢出、NIC 过载、软中断 CPU 不足 |
| 大量 TIME_WAIT | `ss -s`（连接统计）| 短连接频繁创建，需改用长连接或 `tcp_tw_reuse` |
| 大量 CLOSE_WAIT | `ss -s` + 进程级别排查 | 应用层连接泄漏，fd 未及时关闭 |
| SYN 请求被丢弃 | `netstat -s | grep SYN`、`ss -lnt`（看 Recv-Q）| accept 队列满、SYN 队列满（SYN Flood）|

### 1.2 诊断的分层模型

```
Layer 5（应用层）：应用日志、APM（Jaeger/Zipkin）追踪
Layer 4（连接层）：ss / netstat —— 连接状态、队列深度、RTT
Layer 3（网络层）：ping / traceroute —— 丢包位置、路径延迟
Layer 2（驱动层）：ethtool —— 网卡计数器、Ring Buffer 状态
Layer 1（系统调用层）：strace / ltrace —— 应用程序的系统调用序列
Layer 0（内核函数层）：perf / bpftrace —— 内核函数热点与路径追踪
```

从 Layer 4 开始向下逐层排查，避免一开始就用 `tcpdump` 全量抓包或 `perf` 全量 profiling 这类重型工具——在定位不到层次时，这些工具的输出量太大，反而干扰判断。

---

## 第 2 章 ss：连接状态的全量快照

### 2.1 ss vs netstat：为什么推荐 ss

`netstat` 是老工具，通过读取 `/proc/net/tcp`（纯文本）获取连接信息。`ss`（socket statistics）直接通过 Netlink 套接字查询内核，速度快 10-100 倍，且输出信息更丰富（包含 TCP 内部状态如 cwnd、RTT 等）。

在有 100 万个连接的服务器上，`netstat -an` 可能需要几十秒甚至超时，而 `ss -an` 只需 1-2 秒。

### 2.2 ss 的核心用法

```bash
# 查看所有 TCP 连接的统计摘要（最快速的全局视图）
ss -s
# Total: 45234
# TCP:   44891 (estab 44500, closed 0, orphaned 0, timewait 391)
#
# Transport Total     IP        IPv6
# RAW       0         0         0
# UDP       12        12        0
# TCP       44891     44891     0
# INET      44903     44903     0
# FRAG      0         0         0

# 查看 LISTEN 状态的 socket（服务端视角）
ss -tlnp
# State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process
# LISTEN 0      128     0.0.0.0:80         0.0.0.0:*     users:(("nginx",pid=1234,fd=6))
# LISTEN 0      511     0.0.0.0:6379       0.0.0.0:*     users:(("redis-server",pid=5678,fd=7))
#        ↑       ↑
#    当前等待    backlog（accept 队列上限）
#    accept 的
#    连接数（若
#    接近 backlog
#    说明溢出！）

# 查看 TIME_WAIT 连接数（判断是否有大量短连接）
ss -ant | awk '{print $1}' | sort | uniq -c | sort -rn
# 12345 ESTAB
#   456 TIME-WAIT
#    23 CLOSE-WAIT   ← ！！若非零，排查连接泄漏
#     8 LISTEN

# 查看单条连接的详细 TCP 内部状态（最有价值的诊断命令）
ss -tiP dst 10.0.0.1
# ESTAB  0  0  192.168.1.100:80  10.0.0.1:54321
#     cubic wscale:7,7 rto:204 rtt:2.1/0.5 ato:40
#     mss:1448 pmtu:1500 rcvmss:1448 advmss:1448
#     cwnd:10 ssthresh:7 bytes_acked:102400 bytes_received:204800
#     segs_out:100 segs_in:200 data_segs_out:95 data_segs_in:195
#     send 55.1Mbps lastrcv:12 lastack:8 pacing_rate 66.1Mbps
#     delivery_rate 55.1Mbps delivered:95 app_limited:1
#     busy:450ms unacked:2 retrans:0/3 lost:0 sacked:0
#     reord_seen:0 rcv_rtt:2.3 rcv_space:65536 rcv_ssthresh:65536
#     minrtt:1.8
```

**`ss -ti` 输出的关键字段解读**：

| 字段 | 含义 | 异常判断 |
|-----|------|---------|
| `rtt` | 平均 RTT / RTT 方差（ms）| 方差大 → 网络不稳定 |
| `rto` | 重传超时（ms）| 过大 → RTT 估算偏差大 |
| `cwnd` | 当前拥塞窗口（MSS 数）| 长期 < 10 → 拥塞或丢包频繁 |
| `ssthresh` | 慢启动阈值 | 长期 = cwnd → 频繁丢包触发减半 |
| `retrans` | `已重传/总重传次数` | 非零 → 存在丢包 |
| `app_limited` | 应用层限速（1=是）| 1 → 瓶颈在应用，不在网络 |
| `delivery_rate` | 实际交付速率 | 远低于 `send` → 网络拥塞或丢包 |
| `unacked` | 已发送但未收到 ACK 的包数 | 持续高 → 对端接收慢或丢包 |

### 2.3 用 ss 快速定位连接队列问题

```bash
# 场景：用户反映服务超时，怀疑连接建立慢
# 检查 accept 队列溢出
ss -lnt | awk 'NR>1 && $2 > 0 {print "OVERFLOW:", $0}'
# OVERFLOW: LISTEN 128 128  0.0.0.0:80  0.0.0.0:*
#                   ↑   ↑
#           当前等待  backlog（满了！）

# 解决：增大 backlog 并调整 sysctl
# 代码层面：listen(fd, 65535)
# sysctl 层面：
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535

# 确认 SYN 队列（半连接队列）是否被 SYN Flood 打满
netstat -s | grep -i "syn\|overflow\|listen"
# 12345 SYNs to LISTEN sockets dropped  ← SYN 队列溢出的丢弃计数
# 6789 times the listen queue of a socket overflowed  ← accept 队列溢出计数
```

---

## 第 3 章 ethtool：网卡层面的计数器

### 3.1 网卡统计计数器

`ethtool -S` 输出网卡驱动维护的详细计数器，是诊断网卡层面丢包、错误的第一工具：

```bash
ethtool -S eth0 | grep -E "rx_missed|drop|error|over|fifo"
# rx_missed_errors: 0        ← 重要：Ring Buffer 溢出，硬件层丢包
# rx_fifo_errors: 0          ← RX FIFO 溢出
# tx_fifo_errors: 0          ← TX FIFO 溢出
# rx_dropped: 0              ← 驱动层丢包（Ring Buffer 满）
# tx_dropped: 0              ← 发送队列丢包
# rx_crc_errors: 0           ← 帧校验错误（物理层问题：线缆、SFP 模块）
# rx_frame_errors: 0         ← 帧对齐错误
# rx_long_length_errors: 0   ← 超大帧错误

# 若 rx_missed_errors 持续增加：
# → Ring Buffer 溢出，需增大或增加 CPU 处理能力
ethtool -G eth0 rx 4096   # 增大 RX Ring Buffer
```

**软件层的丢包统计**：

```bash
# 查看内核协议栈各层的丢包统计
netstat -s
# Ip:
#   12345678 total packets received
#   0 forwarded
#   0 incoming packets discarded   ← IP 层丢包（一般为 0）
#   12345678 incoming packets delivered
#
# Tcp:
#   1234567 active connection openings
#   234567 passive connection openings
#   12 failed connection attempts        ← connect() 超时/拒绝
#   456 connection resets received
#   123456 connections established
#   987654321 segments received
#   987654321 segments sent out
#   1234 segments retransmitted          ← ！！TCP 重传计数（持续增加=丢包）
#   0 bad segments received
#   789 resets sent
#
# 重点关注：
grep -E "retransmit|drop|overflow|prune|collapse" /proc/net/netstat
```

### 3.2 网卡速率与链路状态

```bash
# 查看网卡的协商速率和双工模式
ethtool eth0
# Settings for eth0:
#     Supported link modes:   1000baseT/Full 10000baseT/Full
#     Speed: 10000Mb/s   ← 当前速率
#     Duplex: Full        ← 全双工
#     Link detected: yes
#     Auto-negotiation: on

# 速率问题排查：
# 若 Speed: 100Mb/s（预期应是 1000Mb/s）→ 协商降速
# → 检查交换机端口配置、网线质量（Cat5e 以上才支持 GbE）
# → 强制指定速率：ethtool -s eth0 speed 1000 duplex full autoneg off

# 查看网卡队列数（多队列调优）
ethtool -l eth0
ethtool -L eth0 combined 8  # 设置 8 个收发队列
```

---

## 第 4 章 tcpdump：数据包级别的故障重放

### 4.1 tcpdump 的核心使用模式

`tcpdump` 是网络诊断的"终极武器"——在数据包级别记录网络行为，可以看到真实发生的握手、重传、窗口变化：

```bash
# 基础用法：抓取指定端口的流量（写入文件供 Wireshark 分析）
tcpdump -i eth0 -w /tmp/capture.pcap port 8080 -s 0

# 实时看 TCP 标志位（-S 显示绝对序号，-nn 不解析 DNS/端口名）
tcpdump -i eth0 -nnS port 8080
# 09:12:34.123456 IP 10.0.0.1.54321 > 10.0.0.2.8080: Flags [S]
#                                                              ↑ SYN
# 09:12:34.123789 IP 10.0.0.2.8080 > 10.0.0.1.54321: Flags [S.]
#                                                              ↑ SYN+ACK
# 09:12:34.124100 IP 10.0.0.1.54321 > 10.0.0.2.8080: Flags [.]
#                                                              ↑ ACK（握手完成）

# 抓包时过滤（减少不必要的噪音）
tcpdump -i eth0 -nnS 'tcp and host 10.0.0.1 and port 8080 and tcp[tcpflags] & tcp-syn != 0'
# ↑ 只抓 SYN 包（监控新连接建立速率）

# 抓取 RST 包（定位异常连接中断）
tcpdump -i eth0 -nn 'tcp[tcpflags] & (tcp-rst) != 0'

# 抓取重传包（通过 seq 重复判断）
tcpdump -i eth0 -nnS -r capture.pcap | awk '
    /Flags/ { seq=$7; if (seq in seen) print "RETRANS:", $0; seen[seq]=1 }'
```

### 4.2 用 tcpdump 诊断 Nagle + 延迟 ACK 问题

```bash
# 场景：用户反映 Redis 的响应延迟偶尔有 40ms 的毛刺
# 抓包分析时间序列
tcpdump -i lo -nnS port 6379 -w /tmp/redis.pcap

# 用 Wireshark 分析（或命令行）
tcpdump -r /tmp/redis.pcap -nn | head -30
# 09:00:00.000000 IP Client.12345 > Redis.6379: Flags [P.], seq 1:5, ack 1, ...
#                 ↑ 发送 4 字节命令（SET key value 的前半段）
# 09:00:00.000050 IP Client.12345 > Redis.6379: Flags [P.], seq 5:13, ack 1, ...
#                 ↑ 发送 8 字节命令（第二段）
#                 但 Nagle：第一个包还没有 ACK，第二段被缓存
# 09:00:00.040123 IP Redis.6379 > Client.12345: Flags [.], ack 5, ...
#                 ↑ 40ms 后！延迟 ACK 超时，ACK 第一段
# 09:00:00.040145 IP Client.12345 > Redis.6379: Flags [P.], seq 5:13, ...
#                 ↑ 收到 ACK 后，Nagle 释放第二段，才发出去
# 确认是 Nagle + 延迟 ACK 导致 40ms 延迟 → 解决：在 Redis 客户端设置 TCP_NODELAY
```

### 4.3 tcpdump 的性能开销

`tcpdump` 通过 **libpcap** 在内核中安装 BPF 过滤器，每个数据包都需要从内核拷贝到用户空间（通过 mmap 的 ring buffer 优化，但仍有开销）。在高流量（10Gbps）线速场景下，`tcpdump` 本身可能丢包，且会占用 1-5% 的 CPU。

**生产环境的正确使用姿势**：
- 使用 `-s 96`（只捕获头部 96 字节，不拷贝完整数据包，减少开销）
- 使用精确的 BPF 过滤表达式（尽量在内核中过滤，减少拷贝到用户空间的包数）
- 写入文件（`-w`）而非实时显示（避免终端 I/O 瓶颈）
- 限制捕获包数（`-c 10000`）

---

## 第 5 章 perf：内核网络函数的 CPU Profiling

### 5.1 perf 的适用场景

`tcpdump` 告诉你"发生了什么"（数据包级别的事实）；`perf` 告诉你"CPU 时间花在哪里"（哪个内核函数占用了最多 CPU）。当你确定有网络性能问题，但不知道具体是哪个内核函数造成的，`perf` 是首选。

```bash
# 对整个系统做 CPU profiling（30 秒，采样频率 999 Hz）
perf record -F 999 -a -g -- sleep 30
perf report --sort=dso,sym | head -30

# 典型的网络相关热点函数（高占比说明该函数是瓶颈）：
#  %CPU    Symbol
#  12.3%   ksoftirqd/0       ← 软中断处理线程（NAPI）：收包压力大
#   8.5%   tcp_rcv_established ← TCP 接收处理：高并发收包
#   6.2%   __netif_receive_skb ← 协议栈分发
#   5.8%   nf_hook_slow      ← ！！Netfilter 钩子（iptables 规则遍历）：规则太多
#   4.1%   tcp_ack           ← ACK 处理
#   3.7%   ip_output         ← IP 层发送

# 专注于网络相关的系统调用
perf stat -e 'net:*' -p <pid> sleep 10
# Performance counter stats for process '<pid>':
#
#       45,234  net:net_dev_xmit       ← 发包次数
#       44,891  net:netif_receive_skb  ← 收包次数
#          234  net:tcp_retransmit_skb ← ！！重传次数（监控核心指标）
```

### 5.2 火焰图：快速定位 CPU 热点

`perf` 的 `report` 输出复杂，**火焰图（Flame Graph）** 将 CPU 调用栈可视化，更直观：

```bash
# 1. 采集数据（带调用栈）
perf record -F 999 -a -g -- sleep 30

# 2. 生成火焰图
perf script > out.perf
# 下载 FlameGraph 工具（Brendan Gregg）
git clone https://github.com/brendangregg/FlameGraph
./FlameGraph/stackcollapse-perf.pl out.perf | ./FlameGraph/flamegraph.pl > net_flame.svg

# 打开 SVG 文件，在浏览器中查看
# 火焰图的宽度 = 函数占用 CPU 的比例
# 火焰图中宽且在高处的函数 = 最需要关注的瓶颈
```

**火焰图中典型的网络问题特征**：
- `nf_hook_slow` 宽（iptables 规则多）→ 减少规则或迁移到 eBPF
- `ksoftirqd` 宽（软中断积压）→ 增大 `netdev_budget` 或开启多队列
- `tcp_sendmsg` 宽（发送路径慢）→ 检查发送缓冲区或拥塞控制
- `sk_alloc`/`kfree_skb` 宽（频繁分配/释放 skb）→ 对象池或批量化

---

## 第 6 章 BCC 工具集：eBPF 驱动的实时网络追踪

### 6.1 BCC 是什么

**BCC（BPF Compiler Collection）** 是一套基于 eBPF 的 Linux 性能分析工具集，包含数十个专用工具，其中涉及网络的工具能够以**微秒级粒度、零侵入地**追踪内核网络路径——不需要重启服务、不需要修改代码、不产生任何业务数据的拷贝。

```bash
# 安装 BCC（Ubuntu）
apt-get install bpfcc-tools linux-headers-$(uname -r)

# 安装 BCC（CentOS/RHEL）
yum install bcc-tools
```

### 6.2 tcplife：TCP 连接生命周期追踪

`tcplife` 追踪每条 TCP 连接的完整生命周期（建立→关闭），记录持续时间、传输字节数、本地/远端地址：

```bash
# 追踪所有 TCP 连接的生命周期（实时输出）
/usr/share/bcc/tools/tcplife
# PID   COMM       LADDR           LPORT  RADDR           RPORT TX_KB  RX_KB  MS
# 1234  nginx      0.0.0.0         80     10.0.0.1        54321  0.3    1.2    23.5
# 1234  nginx      0.0.0.0         80     10.0.0.2        54322  0.3    1.1    19.8
# 5678  redis-ser  127.0.0.1       6379   127.0.0.1       12345  0.0    0.0    0.2
#
# 解读：
# MS 列 = 连接持续时间（毫秒）
# 如果大量连接 MS < 1ms → 可能是健康检查、短连接滥用
# TX_KB 和 RX_KB 极小但 MS 很大 → 可能是连接泄漏（CLOSE_WAIT）

# 只追踪特定端口
/usr/share/bcc/tools/tcplife -p 6379  # 只追踪 Redis
```

### 6.3 tcpretrans：实时重传事件追踪

```bash
# 实时追踪 TCP 重传事件（精确到具体连接）
/usr/share/bcc/tools/tcpretrans
# TIME     PID    IP LADDR:LPORT          T> RADDR:RPORT          STATE
# 09:12:34 1234   4  10.0.0.1:80    R>    10.0.0.2:54321         ESTABLISHED
#                                    ↑ R=重传, L=丢失探针

# tcpretrans 直接挂载到内核的 tcp_retransmit_skb 函数
# 每次 TCP 重传都会实时打印，包含：
#   - 哪条连接（LADDR:LPORT → RADDR:RPORT）
#   - 重传时的 TCP 状态（ESTABLISHED / FIN_WAIT1 / ...）
#   - PID（是哪个进程的连接在重传）

# 对比 netstat -s（只有全局计数，无法确定是哪条连接在重传）
# tcpretrans 直接定位到具体连接，诊断效率高 10 倍
```

### 6.4 tcpconnect + tcpaccept：连接建立追踪

```bash
# 追踪主动发起的 TCP 连接（connect）
/usr/share/bcc/tools/tcpconnect
# PID    COMM         IP SADDR            DADDR            DPORT
# 1234   curl          4  10.0.0.1         93.184.216.34    443
# 5678   java          4  10.0.0.1         10.0.0.2         3306

# 追踪被动接受的连接（accept）
/usr/share/bcc/tools/tcpaccept
# PID    COMM         IP RADDR            RPORT  LADDR            LPORT
# 1234   nginx         4  10.0.0.1         54321  0.0.0.0          80
#        ↑ nginx 的 accept 事件，一次一行

# 实用场景：监控哪些进程在建立外部连接（安全审计）
/usr/share/bcc/tools/tcpconnect -d  # -d 包含 DNS 名称解析
```

### 6.5 sockstat：socket 内存使用追踪

```bash
# 追踪 socket 分配和释放（检测内存泄漏）
/usr/share/bcc/tools/sockstat
# SOCKTYPE  FREE    ALLOC   MEM(KB)  PAGES   KMEM(KB)
# TCP       100     1234    4567     1234    4567
# UDP       20      45      89       23      89
# RAW       0       2       4        2       4

# 检查 socket 内存压力
cat /proc/net/sockstat
# sockets: used 45234
# TCP: inuse 44891 orphan 12 tw 391 alloc 44903 mem 1234
#                         ↑ orphan：孤儿 socket（进程已死但连接未关闭，占用内存）
# UDP: inuse 12 mem 4

# orphan 过多 → 应用程序崩溃但未关闭 socket → 需要调整 tcp_max_orphans
sysctl net.ipv4.tcp_max_orphans   # 默认 65536，超过则强制 RST
```

---

## 第 7 章 bpftrace：一次性的内核网络追踪脚本

### 7.1 bpftrace vs BCC 的定位差异

**BCC** 提供预制的工具（`tcpretrans`、`tcplife` 等），适合高频使用的标准化诊断任务。

**bpftrace** 是一个脚本语言，允许用极简的语法编写一次性的自定义追踪逻辑，适合追踪特定问题——类似"给内核写一行 AWK"：

```bash
# 追踪所有 TCP 连接的 RTT 分布（以直方图形式输出）
bpftrace -e '
kprobe:tcp_rcv_established {
    @rtt = hist(((struct tcp_sock *)arg0)->srtt_us >> 3);
}
interval:s:10 {
    print(@rtt); clear(@rtt);
}'

# 输出（每 10 秒打印一次 RTT 直方图）：
# @rtt:
# [0, 1)            5 |
# [1, 2)          123 |####
# [2, 4)         4567 |################
# [4, 8)         1234 |####
# [8, 16)          89 |
# [16, 32)          3 |
# ↑ 大部分连接 RTT 在 2-4µs（这是本地连接），
#   少数在 8-16µs（跨物理机），无异常高 RTT
```

### 7.2 bpftrace 追踪 TCP 重传的详细原因

```bash
# 追踪 tcp_retransmit_skb，打印重传的连接和序号
bpftrace -e '
kprobe:tcp_retransmit_skb {
    $sk = (struct sock *)arg0;
    $skb = (struct sk_buff *)arg1;
    $saddr = ntop($sk->__sk_common.skc_rcv_saddr);
    $daddr = ntop($sk->__sk_common.skc_daddr);
    $sport = $sk->__sk_common.skc_num;
    $dport = bswap16($sk->__sk_common.skc_dport);
    printf("RETRANS: %s:%d → %s:%d (state=%d)\n",
           $saddr, $sport, $daddr, $dport,
           $sk->__sk_common.skc_state);
    @count[strcat(strcat($saddr, ":"), str($sport))]++;
}
interval:s:5 {
    printf("=== Top Retransmitting Connections ===\n");
    print(@count, 10);
    clear(@count);
}'

# 输出示例：
# RETRANS: 10.0.0.1:80 → 10.0.0.2:54321 (state=1)
# === Top Retransmitting Connections ===
# @count[10.0.0.1:80]: 45
# @count[10.0.0.1:8080]: 12
# ↑ 10.0.0.1:80 在 5 秒内重传了 45 次，问题严重！
```

### 7.3 bpftrace 追踪 epoll_wait 的延迟分布

```bash
# 追踪 epoll_wait 的等待时间（检测事件循环是否有延迟）
bpftrace -e '
tracepoint:syscalls:sys_enter_epoll_wait {
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_epoll_wait
/@start[tid]/ {
    $lat = (nsecs - @start[tid]) / 1000;  /* 转换为微秒 */
    @wait_us = hist($lat);
    delete(@start[tid]);
}
interval:s:10 {
    print(@wait_us);
    clear(@wait_us);
}'

# 输出：epoll_wait 延迟直方图
# @wait_us:
# [0, 1)          234 |
# [1, 2)         4567 |##########
# [2, 4)        12345 |############################
# [4, 8)         3456 |#######
# [8, 16)          89 |
# [1000, 2000)      2 |  ← ！！极少数 epoll_wait 延迟超过 1ms，可能是 GC 或锁争用
```

---

## 第 8 章 综合诊断案例

### 8.1 案例：服务响应 P99 延迟从 2ms 突增到 40ms

**现象**：一个 HTTP API 服务，P99 延迟突然从 2ms 增加到 40ms，但 P50 延迟正常（3ms）。

**诊断步骤**：

```bash
# 步骤 1：ss 快速看连接状态
ss -ti dst <服务IP> | grep -i "retrans\|rtt\|cwnd"
# rtt:2.1/0.5  retrans:0/0  cwnd:10   ← RTT 和重传都正常

# 步骤 2：看 netstat -s（全局重传计数是否在增加）
watch -n 1 "netstat -s | grep retransmit"
# 1234 segments retransmitted
# 1234 segments retransmitted  ← 5 秒内计数没变，不是重传问题

# 步骤 3：tcpretrans 确认无重传（验证步骤 2）
/usr/share/bcc/tools/tcpretrans  # 5 分钟内无输出 → 确认无重传

# 步骤 4：tcpdump 抓包，找 40ms 的时间点
tcpdump -i eth0 -nnS -w /tmp/api.pcap port 8080 -c 100000
# 用 Wireshark 过滤高延迟响应
# 发现：
# Client → Server: [P.] seq=1:101 ack=1          ← 请求前半段（100字节）
# （40.002ms 后）
# Client → Server: [P.] seq=101:201 ack=1        ← 请求后半段（也是 100字节）
# Server → Client: [P.] ack=201 ...              ← 响应
#
# ！！发现请求被分两段发送，且第二段延迟了 40ms
# 这正是 Nagle 算法 + 延迟 ACK 的死锁特征！

# 步骤 5：确认客户端是否设置了 TCP_NODELAY
# 抓包中查看连接握手的 TCP 选项（Wireshark）
# 或者检查客户端代码/配置

# 修复：在客户端 HTTP 连接中设置 TCP_NODELAY
# Java: socket.setTcpNoDelay(true);
# Go: conn.(*net.TCPConn).SetNoDelay(true);
# Python: socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
```

### 8.2 案例：服务接收大量连接重置（RST）

**现象**：客户端日志出现大量 `Connection reset by peer`，监控显示 RST 包激增。

**诊断步骤**：

```bash
# 步骤 1：统计 RST 来源（哪个连接/IP 在发 RST）
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-rst != 0' -c 1000 |
    awk '{print $3}' | sort | uniq -c | sort -rn | head -10
# 456 10.0.0.1.54321  ← 同一个源 IP 发大量 RST，可能是负载均衡健康检查超时

# 步骤 2：查看 accept 队列（是否满了导致内核主动 RST）
ss -lnt | grep ':8080'
# LISTEN 512 512  0.0.0.0:8080  ← Recv-Q = Send-Q = 512 → accept 队列满了！
# 当 accept 队列满时，内核对新连接发送 RST（或静默丢弃 SYN，取决于配置）

# 步骤 3：确认 sysctl 配置
sysctl net.ipv4.tcp_abort_on_overflow
# 0  ← 0 表示静默丢弃（不发 RST），1 表示发送 RST

# 实际上 Recv-Q=512 确认 accept 队列已满
# 修复：增大 listen backlog + 优化应用层的 accept 速度
```

---

## 小结：工具选择的决策树

```
网络问题发生
    ↓
ss -s（连接状态概览）→ 有异常连接状态？
    ├─ 大量 TIME_WAIT → tcp_tw_reuse 或改用长连接
    ├─ CLOSE_WAIT > 0 → 排查应用层连接泄漏
    ├─ LISTEN Recv-Q 满 → 增大 backlog，优化 accept 速度
    └─ 正常 → 继续往下
    ↓
ethtool -S + netstat -s（丢包/重传计数）→ 有增长？
    ├─ rx_missed_errors 增 → 增大 Ring Buffer 或多队列 NIC
    ├─ tcp retransmitted 增 → tcpretrans 定位具体连接
    └─ 正常 → 继续往下
    ↓
ss -ti（单条连接详情）→ RTT/cwnd/retrans 异常？
    ├─ RTT 高 → 网络路径问题（ping/traceroute 验证）
    ├─ cwnd 低 → 拥塞控制（考虑 BBR）
    ├─ app_limited=1 → 应用层瓶颈，非网络问题
    └─ 正常 → 继续往下
    ↓
tcpdump（数据包级别重放）→ 发现 40ms 延迟/奇怪的时序？
    ├─ 40ms 间隔 → Nagle + 延迟 ACK → TCP_NODELAY
    ├─ 重传大量 → 丢包位置（MTR 定位）
    └─ 正常 → 继续往下
    ↓
perf（CPU 热点）→ 内核哪个函数占 CPU 最多？
    ├─ nf_hook_slow → iptables 规则太多 → 迁移 Cilium/eBPF
    ├─ ksoftirqd → NAPI 处理慢 → 增大 budget 或多队列
    └─ 需要更细粒度 → bpftrace 自定义追踪
    ↓
bpftrace/BCC（内核函数级追踪）→ 精确定位根因
```

至此，Linux 网络协议栈与 IO 专栏的全部十篇文章已完成。从 `socket()` 系统调用到网卡 DMA，从 TCP 拥塞控制到 eBPF 内核追踪，从 epoll 事件驱动到 io_uring 异步批处理，从容器 veth pair 到 Cilium O(1) 策略匹配——这套知识体系覆盖了 Linux 网络栈的完整纵深。真正的掌握，发生在你下次遇到网络问题时，能从这份地图中找到正确的诊断路径，直达根因。

---

> [!note] 思考题
> 1. 网络丢包可能发生在多个层级：网卡（ring buffer 满）、内核协议栈（SYN 队列满、Socket 缓冲区满）、应用层（来不及 recv）。`ethtool -S eth0` 显示网卡级别的丢包统计，`netstat -s` 显示协议栈级别。如何系统地从底层到上层逐级排查丢包位置？`dropwatch` 和 `perf trace --event skb:kfree_skb` 各有什么优势？
> 2. 网络延迟抖动（jitter）可能由多种原因导致：软中断处理延迟（`softirq` 被其他任务抢占）、TCP 重传、GC 暂停。`ss -ti` 可以显示 TCP 连接的详细信息（RTT、retrans、cwnd）。如果 `ss` 显示 RTT 正常但应用层感知到的延迟很高，说明延迟来自哪一层？
> 3. 在容器网络中（如 Calico、Flannel），数据包经过 veth pair、Linux bridge（或 eBPF 转发）、可能的 VXLAN 封装。每一层都可能增加延迟。你如何测量容器网络的每一跳延迟？`traceroute` 在容器网络中是否有效？eBPF 的 `tcp_retransmit_skb` 跟踪点如何帮助定位容器间的网络问题？
