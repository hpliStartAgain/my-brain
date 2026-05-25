---
title: "Socket 内核深度解析——struct sock、接收缓冲区与发送缓冲区"
date: 2026-03-02
tags: [autotuning, Linux, SO_RCVBUF, SO_SNDBUF, socket, struct sock, 发送缓冲区, 接收缓冲区, 阻塞IO, 非阻塞IO]
aliases: ["struct sock解析", "socket缓冲区原理", "SO_SNDBUF", "SO_RCVBUF", "Linux socket内核实现"]
---

**摘要：**

`struct sock` 是 Linux 内核中每一条 TCP/UDP 连接的"大脑"——它存储了连接的完整状态：双方 IP 与端口、TCP 序号与确认号、发送缓冲区（`sk_write_queue`）、接收缓冲区（`sk_receive_queue`）、拥塞控制状态、重传定时器，以及与 epoll/select 协作的等待队列（`sk_wq`）。理解 `struct sock` 的内存布局和关键字段，是诊断"发送缓冲区满导致 `send()` 阻塞"、"接收缓冲区积压导致零窗口"、"socket 内存占用过高"等生产问题的基础。本文重点解析三个核心机制：一，`struct sock` 的关键字段与两个最重要的子结构（`struct tcp_sock` 对 TCP 的扩展，`struct inet_sock` 对 IP 层信息的管理）；二，发送缓冲区的工作原理——数据如何从 `tcp_sendmsg()` 进入 `sk_write_queue`，拥塞窗口与接收窗口如何共同限制发送速率，以及 `SO_SNDBUF` 配置背后的双倍实际效果；三，接收缓冲区的工作原理——网络数据包如何从 TCP 层进入 `sk_receive_queue`，`recv()` 如何取走数据，以及内核的接收缓冲区自动调整（autotuning）机制如何在不干预应用层的情况下最大化 TCP 吞吐量。

---

## 第 1 章 struct sock 的层次结构：嵌套继承的 C 实现

### 1.1 C 语言中的"继承"：嵌套结构体

Linux 内核用纯 C 实现了一套类似面向对象继承的机制——通过**在子结构体的第一个字段嵌入父结构体**，使得父结构体指针可以安全地转换为子结构体指针：

```c
/* 网络层的继承链（从顶层到底层）*/

struct sock {          /* 所有协议 socket 的公共基类 */
    struct sock_common __sk_common; /* 必须是第一个字段 */
    /* 收发缓冲区、等待队列、状态、错误码等公共字段 */
};

struct inet_sock {     /* IPv4/IPv6 socket 的扩展 */
    struct sock sk;    /* 必须是第一个字段（嵌入父类）*/
    /* 本地IP、远端IP、本地port、TTL、TOS 等 IP 层字段 */
};

struct tcp_sock {      /* TCP socket 的扩展 */
    struct inet_sock inet;  /* 必须是第一个字段 */
    /* TCP 序号、确认号、拥塞窗口、重传定时器等 TCP 专用字段 */
};

/* 类型转换（等价于子类向上转型）*/
struct tcp_sock *tp = tcp_sk(sk);  /* (struct tcp_sock *)sk，安全因为 tcp_sock 以 inet_sock 开头，inet_sock 以 sock 开头 */
struct inet_sock *inet = inet_sk(sk);
```

**为什么这样设计**：

内核代码中大量函数接受 `struct sock *` 参数——IP 层的 `ip_queue_xmit(sk)` 不需要知道 sk 是 TCP 还是 UDP；但 TCP 层的 `tcp_transmit_skb(sk)` 需要访问 `tcp_sock` 中的 TCP 专用字段。通过嵌套结构体 + 转型函数，既保持了公共接口的统一，又允许各协议访问自己的私有状态。

### 1.2 sock_common：连接四元组的存储

```c
struct sock_common {
    /* 连接四元组（哈希查找的关键）*/
    union {
        __addrpair skc_addrpair;   /* 源IP + 目标IP（合并成 64 位）*/
        struct {
            __be32 skc_daddr;      /* 目标 IP（远端 IP）*/
            __be32 skc_rcv_saddr;  /* 源 IP（本地 IP，绑定的或路由选择的）*/
        };
    };
    union {
        __portpair skc_portpair;   /* 源port + 目标port（合并成 32 位）*/
        struct {
            __be16 skc_dport;      /* 目标端口（远端端口）*/
            __u16  skc_num;        /* 源端口（本地端口，主机字节序）*/
        };
    };

    /* 引用计数（refcnt）*/
    refcount_t skc_refcnt;

    /* 状态（TCP_ESTABLISHED, TCP_LISTEN 等）*/
    volatile unsigned char skc_state;

    /* 哈希表链表节点（用于 tcp_hashinfo 的链表串联）*/
    struct hlist_node skc_node;
    struct hlist_nulls_node skc_nulls_node;

    /* 所属网络命名空间（支持容器网络隔离）*/
    struct net *skc_net;
};
```

`sock_common` 是连接查找的"身份证"——`tcp_hashinfo.ehash` 哈希表以 `{saddr, daddr, sport, dport}` 四元组为 key，value 就是通过 `skc_nulls_node` 串联的 `sock_common`（从而找到整个 `struct sock`）。

### 1.3 struct sock 的核心字段

```c
struct sock {
    struct sock_common __sk_common;   /* 公共基类（必须是第一个字段）*/

    /* ── 状态与标志 ───────────────────────────────── */
    socket_lock_t sk_lock;            /* socket 锁（保护 sk 的状态修改）*/
    atomic_t sk_drops;                /* 因缓冲区满被丢弃的包数（监控用）*/
    int sk_rcvlowat;                  /* recv() 的最小返回字节数（SO_RCVLOWAT）*/
    unsigned long sk_flags;           /* SOCK_DEAD / SOCK_DONE / SOCK_URGINLINE 等标志位 */
    unsigned char sk_shutdown;        /* RCV_SHUTDOWN / SEND_SHUTDOWN 标志 */

    /* ── 接收缓冲区 ───────────────────────────────── */
    int sk_rcvbuf;                    /* 接收缓冲区最大大小（字节，实际可用约 sk_rcvbuf/2）*/
    struct sk_buff_head sk_receive_queue;  /* 已完全接收、等待 recv() 取走的数据队列 */
    struct sk_buff_head sk_backlog;   /* 软中断快速路径的积压队列（处理锁竞争时暂存）*/
    atomic_t sk_rmem_alloc;           /* 接收缓冲区已使用的内存（字节）*/

    /* ── 发送缓冲区 ───────────────────────────────── */
    int sk_sndbuf;                    /* 发送缓冲区最大大小（字节）*/
    struct sk_buff_head sk_write_queue; /* 待发送的数据队列（已拷贝进内核，等待 TCP 发出）*/
    atomic_t sk_wmem_alloc;           /* 发送缓冲区已使用的内存（字节）*/
    int sk_wmem_queued;               /* 已排队等待发送的字节数 */

    /* ── 等待队列（与 epoll/select 协作）──────────── */
    struct socket_wq __rcu *sk_wq;    /* 等待队列头（进程在此等待数据可读/可写）*/

    /* ── 协议操作函数表 ───────────────────────────── */
    struct proto *sk_prot;            /* 协议操作函数：tcp_prot / udp_prot */
    struct proto *sk_prot_creator;    /* 创建时使用的协议（用于内存记账）*/

    /* ── 数据就绪回调（与 epoll 核心的接口）─────── */
    void (*sk_data_ready)(struct sock *sk);  /* 数据到达时调用（epoll 的通知机制入口）*/
    void (*sk_write_space)(struct sock *sk); /* 发送缓冲区有新空间时调用 */
    void (*sk_state_change)(struct sock *sk); /* 连接状态变化时调用 */
    void (*sk_error_report)(struct sock *sk); /* 发生错误时调用 */

    /* ── 内存管理 ─────────────────────────────────── */
    struct mem_cgroup *sk_memcg;      /* 内存 cgroup（用于容器内存限制）*/
    gfp_t sk_allocation;              /* sk_buff 分配的 GFP 标志 */
    int sk_forward_alloc;             /* 预先向内存压力系统申请的内存配额 */
};
```

**最重要的四组字段**：

1. `sk_rcvbuf` + `sk_receive_queue` + `sk_rmem_alloc`：接收缓冲区三件套
2. `sk_sndbuf` + `sk_write_queue` + `sk_wmem_alloc`：发送缓冲区三件套
3. `sk_wq` + `sk_data_ready` + `sk_write_space`：与 epoll 协作的通知机制
4. `sk_prot`：协议函数表，连接 `struct sock` 与具体协议（TCP/UDP）实现

---

## 第 2 章 发送缓冲区：数据如何从 send() 到网卡

### 2.1 tcp_sendmsg() 的核心逻辑

当应用调用 `send(fd, buf, len, flags)`，内核最终执行 `tcp_sendmsg()`。这个函数是 TCP 发送路径上最重要的入口，其核心逻辑可以简化为：

```c
int tcp_sendmsg(struct sock *sk, struct msghdr *msg, size_t size) {
    lock_sock(sk);  /* 获取 socket 锁，防止并发访问 */

    /* 循环处理用户数据（可能跨越多个 sk_buff）*/
    while (msg_data_left(msg)) {

        /* 1. 检查发送缓冲区是否有足够空间 */
        while (!sk_stream_memory_free(sk)) {
            /* sk_wmem_queued >= sk_sndbuf → 缓冲区满 */
            if (sk->sk_err || (sk->sk_shutdown & SEND_SHUTDOWN))
                goto do_error;

            if (!timeo)
                goto do_nonblock;  /* 非阻塞：返回 EAGAIN */

            /* 阻塞：释放 socket 锁，睡眠等待 write_space 回调 */
            sk_stream_wait_memory(sk, &timeo);
        }

        /* 2. 分配 sk_buff（或复用已有的未满 sk_buff）*/
        if (!skb || !skb_can_coalesce(skb, ...)) {
            skb = sk_stream_alloc_skb(sk, ...);
        }

        /* 3. 将用户数据拷贝进 sk_buff（唯一一次 CPU 数据拷贝）*/
        copy = min_t(int, skb_tailroom(skb), size_goal);
        err = skb_add_data_nocache(sk, skb, &msg->msg_iter, copy);

        /* 4. 将 sk_buff 加入发送队列 */
        tcp_push(sk, flags, mss_now, tp->nonagle, size_goal);
    }

    release_sock(sk);
    return copied;
}
```

**`sk_stream_memory_free()` 的判断逻辑**：

```c
static inline bool sk_stream_memory_free(const struct sock *sk) {
    /* 发送缓冲区已用量 < 上限的 2/3，认为"有空间" */
    return sk->sk_wmem_queued < sk->sk_sndbuf;
    /* 注意：sk_wmem_queued 包含：
       1. sk_write_queue 中等待发送的 sk_buff
       2. 已发送但还未收到 ACK 的 sk_buff（在重传队列中）
       因此 sk_wmem_queued 往往大于"等待发送"的数据量 */
}
```

### 2.2 SO_SNDBUF 的双倍效应

通过 `setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &val, sizeof(val))` 设置发送缓冲区大小时，内核实际分配的是 **val 的 2 倍**：

```c
/* net/core/sock.c: sock_setsockopt() */
case SO_SNDBUF:
    /* Silently cap to system limits */
    val = min_t(u32, val, sysctl_wmem_max);

    /* 内核将用户设置值翻倍！ */
    sk->sk_sndbuf = max_t(int, val * 2, SOCK_MIN_SNDBUF);
    break;
```

**为什么翻倍？** 发送缓冲区里的 sk_buff 分为两类：
1. **等待发送的数据**（真正的"发送缓冲"）
2. **已发送但未确认的数据**（等待可能的重传，放在重传队列中）

两类数据都计入 `sk_wmem_queued`。如果缓冲区大小 = 1× 用户期望，那么一半空间被重传队列占用，实际可用于新数据的空间只有一半。翻倍是为了保证用户期望的"可写缓冲"容量。

```bash
# 实际效果验证
python3 -c "
import socket
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65536)
print('SO_SNDBUF:', s.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF))
# 输出：131072 = 65536 × 2
"

# 系统全局默认值和上限
sysctl net.core.wmem_default   # 默认发送缓冲区大小
# 212992（208 KB）
sysctl net.core.wmem_max       # 最大发送缓冲区大小（SO_SNDBUF 上限）
# 212992（可以调大）
```

### 2.3 发送缓冲区的 tcp_push() 与拥塞控制

数据加入 `sk_write_queue` 后，`tcp_push()` → `tcp_write_xmit()` 尝试立即发送。但发送不是无限制的，受到两个窗口的约束：

```
实际可发送数据量 = min(拥塞窗口 cwnd, 接收窗口 rwnd) - 已发送未确认的字节数

拥塞窗口（cwnd）：由 TCP 拥塞控制算法管理，表示网络当前能容纳的在途数据量
接收窗口（rwnd）：由接收方在 ACK 中通告，表示接收方缓冲区的剩余空间

如果 cwnd 或 rwnd 不足，tcp_write_xmit() 会停止发送：
  数据在 sk_write_queue 中等待
  等待下一个 ACK（ACK 会更新 rwnd 并推进 cwnd）
  ACK 到来后触发 tcp_write_xmit() 继续发送
```

**Nagle 算法**（防止"小包"问题）：

在低延迟高吞吐要求下，Nagle 算法默认开启——它阻止发送小于 MSS 的数据包，除非发送缓冲区中没有其他未确认的数据：

```c
/* Nagle 算法的判断（tcp_nagle_test()）*/
static int tcp_nagle_test(const struct tcp_sock *tp, const struct sk_buff *skb,
                          unsigned int cur_mss, int nonagle) {
    /* 以下任一条件满足，允许发送小包：*/
    /* 1. 关闭了 Nagle（TCP_NODELAY）*/
    /* 2. 数据包大小 >= MSS（满包，直接发）*/
    /* 3. 发送队列中没有其他未确认的数据（即上一个包已经被 ACK）*/
    /* 4. FIN 包（连接关闭，必须立即发）*/
    return 1 条件满足 ? 允许发送 : 等待;
}
```

```bash
# 关闭 Nagle 算法（适合交互型应用，如 SSH、实时游戏、Redis）
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

# 查看连接是否开启了 TCP_NODELAY
ss -tioan | grep -A1 "8080"
# ... nodelay ...  ← 出现 nodelay 表示已关闭 Nagle
```

---

## 第 3 章 接收缓冲区：从网卡 DMA 到 recv()

### 3.1 数据的接收路径：三个队列

TCP 接收路径上，数据经历**三个队列**的流转，每个队列都有其存在的理由：

**队列 1：网卡 RX Ring Buffer**（硬件层）

网卡通过 DMA 将以太网帧写入这个环形缓冲区。Ring Buffer 的大小有限（通常 256-4096 个描述符），如果软件来不及消费（NAPI poll 太慢），新帧会覆盖旧帧——这就是"网卡丢包"（`rx_dropped` 计数增加）的原因。

**队列 2：`sk->sk_receive_queue`**（TCP 层有序数据队列）

数据包经过 TCP 协议处理（校验、去重、排序）后，按序放入 `sk_receive_queue`。`recv()` 系统调用从这里取走数据。

**队列 3：`sk->out_of_order_queue`**（乱序暂存队列）

收到乱序数据包时（序号不连续），数据包先放入 `out_of_order_queue`，等前面缺失的包到达后，再按序移入 `sk_receive_queue`。这就是 TCP 的"重排序（Reordering）"。

### 3.2 tcp_v4_rcv() 的处理逻辑

```c
int tcp_v4_rcv(struct sk_buff *skb) {
    /* 1. 校验 TCP 头 */
    /* 2. 用四元组查找 struct sock（tcp_hashinfo.ehash）*/
    sk = __inet_lookup_skb(&tcp_hashinfo, skb, ...);

    /* 3. 如果 socket 正在被进程持有（锁住）→ 放入 sk_backlog */
    if (!sock_owned_by_user(sk)) {
        /* 快速路径：直接处理 */
        tcp_rcv_established(sk, skb);  /* ESTABLISHED 状态的正常数据接收 */
    } else {
        /* 慢速路径：socket 被其他 CPU/线程锁住，暂存到 backlog */
        sk_add_backlog(sk, skb, sk->sk_rcvbuf);
        /* backlog 数据在 release_sock() 时批量处理 */
    }
}
```

**sk_backlog 的存在意义**：TCP 接收处理运行在软中断（softirq）上下文，而应用程序的 `recv()` 调用也会操作 `sk_receive_queue`。为了避免竞争，`struct sock` 用 `sk_lock` 保护。当软中断发现锁已被应用持有时，将 skb 放入 `sk_backlog` 暂存，等应用释放锁后（`release_sock()`），统一处理 backlog 中的包。

### 3.3 tcp_rcv_established()：ESTABLISHED 状态的接收处理

```c
void tcp_rcv_established(struct sock *sk, struct sk_buff *skb) {
    struct tcp_sock *tp = tcp_sk(sk);

    /* 快速路径（数据按序到达，最常见情况）*/
    if (TCP_SKB_CB(skb)->seq == tp->rcv_nxt) {
        /* 将数据放入 sk_receive_queue */
        __skb_queue_tail(&sk->sk_receive_queue, skb);
        tp->rcv_nxt += skb->len;  /* 更新期望的下一个序号 */

        /* 发送 ACK（延迟 ACK 或立即 ACK）*/
        __tcp_ack_snd_check(sk, 0);

        /* 唤醒等待数据的进程（或触发 epoll 通知）*/
        sk->sk_data_ready(sk);  /* 默认是 sock_def_readable() */
        return;
    }

    /* 慢速路径（乱序、重传等异常情况）*/
    tcp_data_queue(sk, skb);
}
```

**`sk->sk_data_ready(sk)` 是 epoll 机制的关键入口**：这个回调函数的默认实现 `sock_def_readable()` 会遍历 `sk_wq`（等待队列），唤醒所有在等待该 socket 可读的进程（包括 `epoll_wait()` 中睡眠的进程）。这是 epoll 与 TCP 接收路径之间的"数据就绪通知"接口，下一篇 [[04 epoll 深度解析——事件驱动 IO 的内核实现]] 将深入展开。

### 3.4 recv() 从接收缓冲区取走数据

```c
/* 应用程序调用 recv(fd, buf, len, 0) */
/* 内核执行 tcp_recvmsg() */

int tcp_recvmsg(struct sock *sk, struct msghdr *msg, size_t len, ...) {
    lock_sock(sk);

    /* 处理 sk_backlog（此时持有锁，可以安全处理积压的包）*/

    while (1) {
        /* 从 sk_receive_queue 取出 sk_buff */
        skb = skb_peek(&sk->sk_receive_queue);

        if (skb) {
            /* 将 skb 数据拷贝到用户缓冲区（唯一一次 CPU 拷贝）*/
            used = skb_copy_datagram_msg(skb, offset, msg, len);
            copied += used;

            /* 如果 skb 已被完全读取，从队列移除并释放 */
            if (used + offset >= skb->len) {
                __skb_unlink(skb, &sk->sk_receive_queue);
                sk_eat_skb(sk, skb);
                sk_mem_reclaim(sk);  /* 释放内存，可能增大接收窗口 */
            }

            if (copied >= len) break;  /* 已读够请求的字节数 */
        } else {
            /* 队列为空：根据阻塞/非阻塞决定等待还是返回 */
            if (copied || !timeo) break;  /* 非阻塞：返回 EAGAIN */
            sk_wait_data(sk, &timeo, last);  /* 阻塞：睡眠等待数据 */
        }
    }

    release_sock(sk);
    return copied;
}
```

**`sk_mem_reclaim()` 对接收窗口的影响**：

应用层每次 `recv()` 取走数据，`sk_rmem_alloc` 减小，`sk_mem_reclaim()` 可能释放内存并更新接收窗口（rwnd）——在下一个 ACK 中通知发送方"我有更多空间了，可以继续发"。这就是 TCP 流量控制的"窗口更新"机制。

**如果应用层 `recv()` 不及时**：

1. `sk_receive_queue` 中积压大量 skb
2. `sk_rmem_alloc` 接近 `sk_rcvbuf` 上限
3. 接收窗口 rwnd 缩小，在 ACK 中通告给发送方
4. 发送方减少发送量（或停止发送，等待窗口更新）
5. 最终效果：发送方被"背压"（back-pressure），自然适配接收方的处理速度

---

## 第 4 章 接收缓冲区自动调整（Autotuning）

### 4.1 为什么需要 Autotuning

TCP 的最大吞吐量受限于"带宽延迟积（BDP，Bandwidth Delay Product）"：

```
最大吞吐量 = min(接收缓冲区大小, cwnd × MSS) / RTT
BDP = 带宽 × RTT

例：10 Gbps 链路，RTT = 50ms
BDP = 10 × 10^9 / 8 × 0.05 = 62.5 MB

如果接收缓冲区 < 62.5 MB，TCP 无法填满 10 Gbps 链路！
```

Linux 默认的接收缓冲区（`net.core.rmem_default` = 212 KB）对于高带宽长延迟（高 BDP）网络严重不足。但简单地将所有连接的缓冲区都设为 64 MB，在有大量连接时会耗尽内存。

**Autotuning** 是 Linux 内核根据每条连接的实际 BDP 动态调整接收缓冲区大小的机制——低 BDP 连接用小缓冲，高 BDP 连接自动扩大，在内存效率和吞吐量之间取得平衡。

### 4.2 Autotuning 的工作原理

```c
/* tcp_rcv_space_adjust()：在每次收到数据时被调用，调整接收缓冲区 */
void tcp_rcv_space_adjust(struct sock *sk) {
    struct tcp_sock *tp = tcp_sk(sk);

    /* 测量当前的数据消费速率：
       space = 在一个 RTT 内，应用层 recv() 取走了多少字节 */
    long space = (tp->rcv_nxt - tp->rcvq_space.seq) << 1;

    if (space > tp->rcvq_space.space) {
        /* 数据消费速率在增长 → 扩大接收缓冲区 */
        if (sock_net(sk)->ipv4.sysctl_tcp_moderate_rcvbuf) {
            int new_clamp = space;
            int new_rcvbuf = min(new_clamp,
                                 sock_net(sk)->ipv4.sysctl_tcp_rmem[2]);
            /* sysctl_tcp_rmem[2] 是自动调整的上限（默认 6 MB）*/

            if (new_rcvbuf > sk->sk_rcvbuf) {
                sk->sk_rcvbuf = new_rcvbuf;
                /* 接收缓冲区扩大后，接收窗口可以随之增大 */
            }
        }
        tp->rcvq_space.space = space;
    }
}
```

**控制 Autotuning 的三个 sysctl 参数**：

```bash
# tcp_rmem：[min, default, max]
sysctl net.ipv4.tcp_rmem
# 4096   131072   6291456
#  ↑       ↑          ↑
# 最小值  默认值    自动调整的上限（6 MB）

# 对于高带宽长延迟场景（跨机房、跨洲际），需要增大上限
sysctl -w net.ipv4.tcp_rmem="4096 131072 67108864"  # 上限 64 MB

# tcp_moderate_rcvbuf：是否开启 Autotuning（默认开启）
sysctl net.ipv4.tcp_moderate_rcvbuf
# 1  ← 1 = 开启（推荐保持开启）
```

> [!warning] 生产避坑：SO_RCVBUF 会禁用 Autotuning
> 通过 `setsockopt(SO_RCVBUF)` 手动设置接收缓冲区大小后，**内核会禁用该 socket 的 Autotuning**——认为"用户已经手动管理缓冲区了，不需要自动调整"。在大多数情况下，这会导致性能下降：如果手动设置的值 < BDP，吞吐量就会受限。除非你有非常明确的理由（如内存极度紧张的嵌入式系统），否则**不要设置 SO_RCVBUF**，让内核自动调整。
> 正确做法：只调整 `net.ipv4.tcp_rmem` 的最大值上限，让 Autotuning 在这个上限内自由工作。

---

## 第 5 章 阻塞 IO 与非阻塞 IO 的内核实现差异

### 5.1 阻塞模式：进程在哪里睡眠

阻塞 socket（默认模式）下，当数据不可读时，`recv()` 会阻塞。进程睡眠在 `sk_wq`（socket 等待队列）上：

```c
/* sk_wait_data()：阻塞等待数据到来 */
int sk_wait_data(struct sock *sk, long *timeo, const struct sk_buff *skb) {
    /* 构造等待项，加入 sk_wq 等待队列 */
    DEFINE_WAIT_FUNC(wait, woken_wake_function);
    add_wait_queue(sk_sleep(sk), &wait);

    sk_set_bit(SOCKWQ_ASYNC_WAITDATA, sk);

    /* 释放 socket 锁，让出 CPU，进程进入 TASK_INTERRUPTIBLE 状态 */
    rc = sk_wait_event(sk, timeo,
                       skb_peek_tail(&sk->sk_receive_queue) != skb,
                       &wait);
    /* 被唤醒后（sk_data_ready 调用了 wake_up_interruptible），
       重新持有 socket 锁，继续执行 */
    remove_wait_queue(sk_sleep(sk), &wait);
    return rc;
}
```

**唤醒链路**：

```
网卡收到数据 → NAPI poll → tcp_rcv_established() 
  → sk->sk_data_ready(sk)  [即 sock_def_readable()]
  → wake_up_interruptible_all(&sk->sk_wq->wait)
  → 唤醒在 sk_wq 上等待的进程
  → 进程从 sk_wait_data() 返回
  → recv() 从 sk_receive_queue 取走数据
```

### 5.2 非阻塞模式：EAGAIN 的语义

非阻塞 socket（`fcntl(fd, F_SETFL, O_NONBLOCK)` 或 `socket(..., SOCK_NONBLOCK)`）下，`recv()` 遇到无数据可读时立即返回 `-1`，`errno = EAGAIN`（或 `EWOULDBLOCK`，两者相同）：

```c
/* tcp_recvmsg() 中的非阻塞处理 */
if (!timeo) {
    /* timeo = 0 表示非阻塞（阻塞时 timeo > 0）*/
    copied = -EAGAIN;  /* 返回 EAGAIN，告诉用户"暂时没有数据，稍后再试" */
    goto out;
}
```

**EAGAIN 的正确处理方式**：

非阻塞 IO 通常配合 `epoll` 使用。`epoll_wait()` 等待事件，事件到来后调用 `recv()`。但即使 epoll 通知了可读，`recv()` 仍然可能返回 `EAGAIN`——这在以下情况下发生（ET 模式，边缘触发）：

```c
/* 正确的 epoll ET 模式下的 recv() 写法 */
while (1) {
    ssize_t n = recv(fd, buf, sizeof(buf), 0);
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            /* 数据已全部读完，等待下次 epoll 通知 */
            break;
        }
        /* 真正的错误 */
        handle_error();
        break;
    }
    if (n == 0) {
        /* 对端关闭连接（EOF）*/
        close(fd);
        break;
    }
    process_data(buf, n);
}
```

### 5.3 阻塞 vs 非阻塞的选型

| 特性 | 阻塞 IO | 非阻塞 IO + epoll |
|-----|--------|-----------------|
| 编程模型 | 简单（一个连接一个线程）| 复杂（回调/状态机）|
| 并发能力 | 受限于线程数（C10K 问题）| 单线程处理百万连接 |
| CPU 效率 | 有数据时高效，无数据时线程睡眠（零 CPU 消耗）| 有数据时高效，无数据时 epoll_wait() 睡眠（零 CPU 消耗）|
| 延迟 | 较低（数据到来立即被线程处理）| 略高（受 epoll 事件循环调度）|
| 适用场景 | 连接数少（< 数千），简单服务 | 连接数多（C10K+），高并发服务器 |

---

## 小结

`struct sock` 是 TCP 连接在内核中的完整状态快照，通过嵌套继承结构（`sock` → `inet_sock` → `tcp_sock`）实现了"协议无关的公共接口 + 协议专用的私有扩展"。

**发送缓冲区的三个关键认知**：
1. `SO_SNDBUF` 设置的值会被内核翻倍，实际 `sk_sndbuf = 2 × 用户值`
2. 发送受双重限制：本地 `sk_sndbuf`（内存限制）+ TCP 窗口 `min(cwnd, rwnd)`（网络限制）
3. Nagle 算法防止小包泛滥，交互型应用（Redis、SSH）应关闭 `TCP_NODELAY`

**接收缓冲区的三个关键认知**：
1. 数据流经三个队列：RX Ring（网卡）→ `sk_receive_queue`（TCP 有序数据）→ 用户缓冲区
2. Autotuning 根据实际消费速率动态调整 `sk_rcvbuf`，`SO_RCVBUF` 会禁用它
3. `sk->sk_data_ready()` 是 TCP 接收与 epoll 之间的桥梁——数据到来时唤醒等待的进程

下一篇 [[04 epoll 深度解析——事件驱动 IO 的内核实现]] 将从这个 `sk_data_ready()` 入口出发，完整追踪 epoll 的内核实现：`epoll_create()` 创建的 eventpoll 结构、`epoll_ctl()` 注册 fd 时在 socket 等待队列上安装的"哨兵"、`epoll_wait()` 的睡眠与唤醒机制，以及 LT（水平触发）与 ET（边缘触发）在内核层面的实现差异。

---

> [!note] 思考题
> 1. TCP 滑动窗口的接收窗口（rwnd）由接收方通告，拥塞窗口（cwnd）由发送方维护。实际发送窗口 = min(rwnd, cwnd)。在一个接收方处理能力很强（rwnd 很大）但网络拥塞严重（cwnd 很小）的场景中，增大接收缓冲区能否提升吞吐量？为什么？
> 2. 快速重传（Fast Retransmit）在收到 3 个重复 ACK 后立即重传丢失的报文，而不等待超时。但 3 个重复 ACK 的前提是后续报文已到达——如果连续丢失多个报文，可能收不到 3 个重复 ACK，只能等待 RTO 超时。SACK（Selective ACK）如何解决这个问题？SACK 对接收端的实现复杂度有什么影响？
> 3. BBR 拥塞控制不依赖丢包反馈——它通过测量带宽（delivery rate）和 RTT 来估算最优发送速率。BBR 的 Probe BW 和 Probe RTT 两个阶段分别做什么？在高丢包率网络（如 2% 随机丢包）中，BBR 的吞吐量比 CUBIC 高多少？BBR 是否在所有网络环境中都优于 CUBIC？
