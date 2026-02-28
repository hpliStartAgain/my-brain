---
title: "反向代理与负载均衡：upstream 模块深度解析"
date: 2026-02-28
tags: [Nginx, upstream, 反向代理, 负载均衡, 连接池, round-robin, least_conn, 健康检查, keepalive]
aliases: []
---

# 04 反向代理与负载均衡：upstream 模块深度解析

## 摘要

Nginx 作为反向代理是其最广泛的使用场景。`proxy_pass` 背后的 `upstream` 模块，不仅负责将请求转发到后端服务，还管理着连接复用（keepalive 连接池）、负载均衡策略、被动健康检查等核心能力。本文深入讲解 `upstream` 模块的内部工作机制：连接池如何以"虚假空闲"换取实际吞吐的原理、五种内置负载均衡算法的数据结构与适用边界（round-robin 的平滑加权、least_conn 的最小连接计数、ip_hash 的一致性哈希局限）、被动健康检查如何通过失败计数器和恢复探测实现容错、以及 `proxy_buffer` 与 `proxy_cache` 协作时的缓冲模型。理解这些机制，是排查 502/504、连接池泄漏、负载不均等问题的关键。

---

## 第 1 章 反向代理的基本工作模型

### 1.1 正向代理与反向代理的本质差异

这两个概念经常被混淆，区分它们的核心在于**谁是代理服务的受益方**：

**正向代理（Forward Proxy）**：代理客户端，帮助客户端访问它无法直接访问的资源（如翻墙代理）。服务端看不到真实的客户端——代理的存在对服务端透明，对客户端可见（客户端知道自己在用代理）。

**反向代理（Reverse Proxy）**：代理服务端，帮助服务端接收和分发来自客户端的请求。客户端看不到真实的服务端——代理的存在对客户端透明，对服务端可见（服务端知道请求来自代理）。

```
正向代理：
  Client（知道有代理）→ Forward Proxy → Internet/Server

反向代理：
  Client（不知道有代理）→ Nginx Reverse Proxy → Backend Servers
```

Nginx 作为反向代理的核心价值：
- **统一入口**：所有流量先到 Nginx，再由 Nginx 分发，后端服务不暴露在公网
- **SSL 卸载**：TLS 握手和加解密由 Nginx 处理，后端服务只处理 HTTP 明文（降低后端负担）
- **负载均衡**：将请求分发到多个后端实例，提升整体吞吐
- **缓存**：缓存后端响应，降低后端压力（第 05 篇详述）

### 1.2 proxy_pass 的请求转发流程

一次完整的反向代理请求处理：

```
1. 客户端 → Nginx：建立 TCP 连接，发送 HTTP 请求

2. Nginx 解析请求（Phase 1-9）：
   - 解析请求行、请求头
   - 执行 rewrite、access 控制
   - 匹配 location

3. Nginx → 后端：获取（或建立）到后端的 TCP 连接
   - 检查 keepalive 连接池是否有可用的空闲连接
   - 有空闲连接 → 复用；无 → 新建 TCP 连接（三次握手）

4. Nginx 向后端发送代理请求：
   - 根据 proxy_set_header 重写请求头
   - 发送请求行、请求头、请求体

5. Nginx 接收后端响应：
   - 读取响应状态码和响应头
   - 根据 proxy_buffer 配置，缓冲响应体

6. Nginx → 客户端：发送 HTTP 响应
   - 转发状态码、响应头（经过 proxy_hide_header / add_header 处理）
   - 转发响应体

7. 连接处理：
   - Nginx ↔ 客户端：根据 keepalive_timeout 决定是否保持连接
   - Nginx ↔ 后端：根据 keepalive 指令决定是否归还到连接池
```

### 1.3 Nginx 作为代理时的双向 TCP 连接模型

很多人忽略一个关键点：**Nginx 反向代理时，维护着两个独立的 TCP 连接**——客户端→Nginx 的连接，和 Nginx→后端的连接。这两个连接是完全独立的，生命周期可以不同步：

```
client_fd ←→ Nginx Worker ←→ upstream_fd

- client_fd：客户端与 Nginx 的 TCP 连接（由 Nginx accept）
- upstream_fd：Nginx 与后端的 TCP 连接（由 Nginx connect）
- 两者都由同一个 Worker 进程的 epoll 监听
- 客户端慢（发送数据慢）不影响 upstream_fd 的读取
- 后端慢（响应慢）不影响 client_fd 接收新请求（如果启用了 pipelining）
```

---

## 第 2 章 upstream 的连接池：keepalive 机制

### 2.1 为什么要复用到后端的 TCP 连接

没有连接复用时，每次请求到达 Nginx，都需要为这个请求新建一条到后端的 TCP 连接：

```
新建 TCP 连接的代价：
  1. TCP 三次握手：至少 1 RTT（往返时延）
     局域网内 RTT ≈ 0.1-1ms；跨机房 RTT ≈ 1-10ms
  
  2. 如果是 HTTPS：TLS 1.2 需要 2 RTT；TLS 1.3 需要 1 RTT
     但如果后端是 HTTP（大多数内网场景），只有 TCP 握手开销
  
  3. TCP 慢启动：新连接的发送窗口很小（初始 cwnd ≈ 10 MSS ≈ 14.6KB）
     短请求/响应不受影响，但对于需要多次 RTT 才能传完的大响应，
     新连接比老连接的吞吐要低得多

结论：对于 QPS 高的场景（如每秒 1000 次请求到同一后端），
      如果不复用连接，每秒需要建立/关闭 1000 条 TCP 连接，
      浪费大量 CPU（内核协议栈处理 SYN/SYN-ACK/ACK/FIN 等报文）
      和时延（每次请求额外增加 1ms 的建连延迟）
```

### 2.2 upstream keepalive 的配置与工作原理

```nginx
upstream backend {
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    
    # keepalive：每个 Worker 进程保持的最大空闲连接数
    # （注意：是每个 Worker 的连接池大小，不是全局上限）
    keepalive 32;
    
    # keepalive_requests：单条连接最多复用的请求次数（默认 1000，Nginx 1.19.10+）
    keepalive_requests 1000;
    
    # keepalive_time：连接最大存活时间（默认 1h，防止使用超长的"僵尸"连接）
    keepalive_time 1h;
    
    # keepalive_timeout：空闲连接的超时时间（默认 60s，超时后关闭空闲连接）
    keepalive_timeout 60s;
}

# 必须同时配置 proxy_http_version 和 proxy_set_header，才能使 keepalive 生效
# 原因：HTTP/1.0 默认短连接；HTTP/1.1 默认长连接
location /api/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;                      # 必须使用 HTTP/1.1
    proxy_set_header Connection "";              # 清除 Connection: close 头，允许复用
}
```

**keepalive 连接池的工作流程**：

```
初始状态：连接池为空

请求 1 到达：
  → 检查连接池：空池，没有可用连接
  → 建立新的 TCP 连接（三次握手）到 10.0.0.1:8080
  → 通过此连接发送请求 1，接收响应
  → 请求完成：将此连接放回连接池（标记为空闲）
  → 连接池：{10.0.0.1:8080 → [conn1(idle)]}

请求 2 到达（目标同样是 10.0.0.1:8080）：
  → 检查连接池：有 conn1 空闲！
  → 取出 conn1，发送请求 2
  → 连接池：{10.0.0.1:8080 → []}（conn1 在使用中）

请求 2 完成：
  → 将 conn1 放回连接池
  → 连接池：{10.0.0.1:8080 → [conn1(idle)]}
```

> [!warning] 生产避坑：keepalive 数量的选择
> `keepalive 32` 的含义是每个 Worker 进程最多保持 32 条**空闲**连接。假设有 4 个 Worker，总空闲连接数上限是 128。**这不是并发连接上限**——活跃连接（正在处理请求的连接）数量不受 `keepalive` 限制。
>
> 设置过小：高并发时连接池频繁为空，每次都要新建连接，失去复用效果
> 设置过大：空闲连接占用后端资源（每条 TCP 连接在后端也占用 fd 和内存）
>
> **经验公式**：`keepalive ≈ (每秒请求数 / Worker进程数) × 后端平均响应时间(秒)`
> 例如：QPS=10000，Worker=4，响应时间=10ms
> `keepalive ≈ (10000/4) × 0.01 = 25`，设置为 32 合理

### 2.3 连接池与后端服务器的关系

`keepalive` 连接池以**后端服务器地址**为 key，每个 Worker 对每个后端地址维护独立的空闲连接列表。在多后端的 upstream 场景中，连接池按后端地址分组：

```
upstream backend {
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
    keepalive 30;
}

Worker 1 的连接池（最多 30 条空闲连接，分布在三个后端上）：
  10.0.0.1:8080 → [conn1, conn2, conn3, ...]
  10.0.0.2:8080 → [conn4, conn5, ...]
  10.0.0.3:8080 → [conn6, ...]
  合计 ≤ 30 条空闲连接
```

---

## 第 3 章 五种负载均衡算法

### 3.1 Round-Robin（加权轮询）——默认算法

**Round-Robin** 按顺序将请求依次分配给每个后端服务器。Nginx 的实现是**平滑加权轮询（Smooth Weighted Round-Robin）**，比简单轮询更均匀。

**普通加权轮询的问题**：

```
服务器：A（权重3）、B（权重1）、C（权重1）
普通加权轮询的分配序列：A A A B C A A A B C ...
结果：A 连续收到 3 个请求，然后 B 和 C 各收到 1 个
问题：短时间内 A 的负载是 B/C 的 3 倍，造成瞬间不均衡
```

**平滑加权轮询的分配序列**：A B A C A（依然是 3:1:1 的比例，但分布更均匀）

平滑加权轮询的算法：
1. 每次选择请求时，**将每个服务器的当前权重增加其配置权重**（`current_weight += weight`）
2. 选择当前权重最大的服务器处理请求
3. **将被选中服务器的当前权重减去所有服务器权重之和**（`selected.current_weight -= total_weight`）

```
服务器：A(weight=5), B(weight=1), C(weight=1)，total_weight=7

初始状态：A.cw=0, B.cw=0, C.cw=0

第1次请求：
  加权后：A.cw=5, B.cw=1, C.cw=1
  选择 A（最大=5），A.cw -= 7 → A.cw=-2
  分配给 A，状态：A.cw=-2, B.cw=1, C.cw=1

第2次请求：
  加权后：A.cw=3, B.cw=2, C.cw=2
  选择 A（最大=3），A.cw -= 7 → A.cw=-4
  分配给 A，状态：A.cw=-4, B.cw=2, C.cw=2

第3次请求：
  加权后：A.cw=1, B.cw=3, C.cw=3
  B和C并列最大，选择先出现的 B，B.cw -= 7 → B.cw=-4
  分配给 B，状态：A.cw=1, B.cw=-4, C.cw=3
  
结果序列：A A B A C A A ...（比 A A A A A B C 更均匀）
```

```nginx
upstream backend {
    server 10.0.0.1:8080 weight=5;
    server 10.0.0.2:8080 weight=1;
    server 10.0.0.3:8080 weight=1;
    # 默认就是加权轮询，不需要显式指定
}
```

**适用场景**：后端服务器**无状态**（每次请求不依赖前一次的 Session），性能差异不大（或用权重反映差异）的场景。静态资源服务、无状态的 REST API 后端。

**不适用场景**：有状态的 Session（需要 sticky session）；后端响应时间差异极大（某些请求耗时 100ms，某些耗时 10s，Round-Robin 会导致慢请求积压）。

### 3.2 Least-Connections（最小连接数）

**问题背景**：Round-Robin 假设每次请求的处理时间相同，但现实中不同请求的耗时可能相差几个数量级（如文件下载请求耗时 30 秒，而 API 查询只需 10ms）。如果用 Round-Robin，某个后端可能积压了大量慢请求，而 Round-Robin 仍然向它分发新请求。

**Least-Connections** 解决这个问题：**总是将新请求分配给当前活跃连接数最少的后端**。活跃连接数反映了当前的实际负载——连接数多说明该后端正在处理的请求多（或者响应慢），连接数少说明该后端相对空闲。

```nginx
upstream backend {
    least_conn;
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
}
```

**Least-Connections 的权重支持**：

`least_conn` 同样支持 `weight`，选择逻辑变为：选择 `active_connections / weight` 值最小的服务器，即在考虑权重的情况下选择相对最空闲的服务器。

**适用场景**：后端请求处理时间**差异较大**（如包含文件上传、长时间查询的混合流量）；后端服务器性能不均匀。

**不适用场景**：所有请求耗时接近（此时 `least_conn` 和 Round-Robin 效果几乎相同，但 `least_conn` 多了计数开销）。

### 3.3 IP Hash（IP 一致性哈希）

**问题背景**：某些应用将用户状态存储在单台服务器的内存中（如 PHP Session、Java HttpSession），同一用户的请求必须路由到同一台后端服务器——即**会话粘性（Session Sticky）**。

**IP Hash** 根据客户端 IP 计算哈希值，固定映射到某一台后端服务器：

```nginx
upstream backend {
    ip_hash;
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
}
```

Nginx 的 `ip_hash` 使用 IPv4 地址的前三个字节（`a.b.c.x`中的`a.b.c`）计算哈希，这意味着同一 `/24` 网段内的所有 IP 会哈希到同一个值（映射到同一台后端）。

> [!warning] 生产避坑：ip_hash 的局限性
> **问题一：大型 NAT 网络下的负载不均**
> 企业内网或运营商大 NAT 环境下，数千用户可能共享同一个出口 IP。`ip_hash` 会将这些用户全部路由到同一台后端，造成严重的负载不均衡。
>
> **问题二：添加/删除后端服务器导致大量重哈希**
> `ip_hash` 使用模运算（`hash % server_count`），当 server_count 变化时（新增或删除一台服务器），几乎所有 IP 的映射关系都会改变——等同于所有用户的 Session 失效。这对于"灰度发布"或"缩容"等场景非常不友好。
>
> **更好的替代方案**：使用 Redis 存储分布式 Session（让后端无状态，Session 不依赖特定服务器）；或使用 Nginx Plus 的 `sticky cookie` 指令（在 Cookie 中记录后端服务器 ID）。

### 3.4 Hash（通用哈希）

`hash` 指令比 `ip_hash` 更灵活，允许以**任意变量或变量组合**作为哈希 Key：

```nginx
upstream backend {
    hash $request_uri consistent;  # 基于 URI 的一致性哈希
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
}
```

**`consistent` 关键字：一致性哈希（Ketama 算法）**

普通哈希（`hash $key`，不加 `consistent`）使用取模：`server_index = hash(key) % server_count`，添加/删除服务器时几乎所有 key 的映射都改变。

**一致性哈希（`consistent`）** 使用环形哈希空间，每台服务器对应哈希环上的多个虚拟节点。添加一台新服务器时，只有新服务器在哈希环上"附近"的 key 会重新映射，其余 key 不受影响——**只有约 `1/n` 的 key 需要重新映射**（n 是服务器数量）。

```
场景：3 台服务器的缓存代理，基于 URI 哈希（相同 URI 总路由到同一台服务器，提高缓存命中率）

普通 hash：添加第 4 台服务器 → 3/4 ≈ 75% 的 URI 映射改变 → 大量缓存 miss → 后端压力激增

一致性 hash：添加第 4 台服务器 → 约 1/4 = 25% 的 URI 映射改变 → 其余 75% 缓存继续命中
```

**适用场景**：Nginx 作为缓存层（基于 URI 一致性哈希，提高缓存命中率）；需要基于特定 Header（如用户 ID）路由到特定后端分片的场景。

### 3.5 Random（随机）

```nginx
upstream backend {
    random two;   # 随机选两台，再从中选 least_conn 的那台
    server 10.0.0.1:8080;
    server 10.0.0.2:8080;
    server 10.0.0.3:8080;
    server 10.0.0.4:8080;
}
```

`random two` 是一种近似最优的策略：完全随机选择的平均质量不如 `least_conn`，但完整的 `least_conn` 需要扫描所有服务器找最小值（O(n)）；`random two` 随机抽两台再取较小者，性能接近 `least_conn` 但计算开销更低。在服务器数量较多（> 10 台）时，`random two` 是 `least_conn` 的良好近似替代。

### 3.6 五种算法横向对比

| 算法 | 均衡维度 | Session 粘性 | 扩缩容影响 | 适用场景 |
|-----|---------|------------|----------|---------|
| round-robin | 请求数 | 无 | 无影响 | 无状态服务，响应时间均匀 |
| least_conn | 活跃连接数 | 无 | 无影响 | 响应时间差异大的混合流量 |
| ip_hash | 客户端 IP | 按 IP 粘性 | 重哈希严重 | 有状态 Session（不推荐） |
| hash consistent | 指定 Key | 按 Key 粘性 | 影响约 1/n | 缓存代理、分片路由 |
| random two | 随机+连接数 | 无 | 无影响 | 大量后端服务器 |

---

## 第 4 章 被动健康检查

### 4.1 什么是被动健康检查

Nginx 开源版本（非 Nginx Plus）只支持**被动健康检查**——不主动发送探测请求，而是通过**监控真实请求的失败情况**来判断后端健康状态。

当向某台后端服务器发送请求失败时（TCP 连接失败、读取响应超时等），Nginx 会记录这次失败，累积失败次数达到阈值后，将该服务器标记为**不可用（down）**，在一段时间内不再向其发送请求。经过冷却期后，Nginx 会**尝试一次试探性请求**，如果成功，该服务器重新标记为可用。

### 4.2 核心配置参数

```nginx
upstream backend {
    server 10.0.0.1:8080 max_fails=3 fail_timeout=30s;
    # max_fails：在 fail_timeout 时间窗口内，失败次数达到此值 → 标记不可用
    # fail_timeout：两个含义：
    #   1. 统计失败次数的时间窗口（30秒内失败 3 次 → 不可用）
    #   2. 被标记为不可用后，不分配请求的持续时间（30秒后重试）
    
    server 10.0.0.2:8080 max_fails=3 fail_timeout=30s;
    server 10.0.0.3:8080 backup;  # backup：正常情况下不使用，仅在主服务器全部不可用时使用
}
```

**健康检查状态机**：

```
初始状态：Server = AVAILABLE

状态转换：
  AVAILABLE：
    请求成功 → 保持 AVAILABLE，重置失败计数
    请求失败 → 失败计数 +1
    失败计数 >= max_fails（且在 fail_timeout 窗口内）→ 进入 UNAVAILABLE

  UNAVAILABLE（不再分配请求，开始计时）：
    等待 fail_timeout 秒后 → 进入 TESTING
    
  TESTING（允许分配一次探测请求）：
    下一个请求分配到此服务器：
      请求成功 → 回到 AVAILABLE，重置失败计数
      请求失败 → 回到 UNAVAILABLE，重新开始 fail_timeout 计时
```

### 4.3 被动健康检查的局限与绕过

**局限一：有损检查（用真实请求做探测）**

当服务器处于 TESTING 状态时，探测请求是真实的用户请求。如果后端服务器在这次探测时还没完全恢复（如慢启动期间），探测失败会导致真实用户请求失败，影响用户体验。

**局限二：只检测"连接级别"的失败**

默认的失败条件包括：TCP 连接失败、超时、返回某些 HTTP 状态码（可配置）。**不会检测 HTTP 5xx 错误**（除非显式配置）：

```nginx
# 将 HTTP 5xx 错误也纳入失败统计
proxy_next_upstream error timeout http_500 http_502 http_503 http_504;
```

**`proxy_next_upstream`**：当向当前后端的请求失败时，是否尝试下一台后端。这是与被动健康检查密切配合的"重试"机制：

```nginx
location /api/ {
    proxy_pass http://backend;
    
    # 遇到这些错误时，重试其他后端服务器（保证幂等性的请求才能重试）
    proxy_next_upstream error timeout http_502 http_503 http_504;
    
    # 最多重试 2 次（避免过多后端受到影响）
    proxy_next_upstream_tries 2;
    
    # 重试的时间预算（总时间超过此值则停止重试）
    proxy_next_upstream_timeout 10s;
}
```

> [!warning] 生产避坑：proxy_next_upstream 与幂等性
> `proxy_next_upstream` 重试会将同一请求发送到另一台后端。**对于非幂等的请求（如 POST 创建订单），重试可能导致数据重复**。应谨慎使用，或只对幂等的方法（GET、HEAD）开启重试，对 POST/PUT/DELETE 不重试：
> ```nginx
> proxy_next_upstream error timeout non_idempotent;
> # non_idempotent：允许对非幂等请求（POST 等）也重试（危险，谨慎使用）
> # 默认：POST/LOCK/PATCH 请求不在重试范围内
> ```

---

## 第 5 章 proxy_buffer 与代理响应缓冲

### 5.1 缓冲模型：为什么需要缓冲

没有缓冲时（`proxy_buffering off`），Nginx 从后端读一个字节就立即发一个字节给客户端。这在网络状况良好时没问题，但当**客户端慢（网络差、弱网）而后端快**时：

```
没有缓冲的问题：
  后端以 100MB/s 速度发送响应
  客户端只能以 1MB/s 速度接收
  
  Nginx 无法快速发给客户端 → Nginx 的发送缓冲区满
  → Nginx 向后端的读缓冲区也满
  → Nginx 暂停从后端读取
  → 后端被迫等待（后端的连接处于 CLOSE_WAIT 或 BLOCKED 状态）
  
  后果：后端的连接被长时间占用（等待慢客户端读完数据）
        后端的并发连接数因此居高不下，影响整体吞吐
```

**有缓冲时**：Nginx 先将后端的完整响应读入本地缓冲区（内存或临时文件），读完后立即**释放后端连接**（归还到连接池），然后慢慢把缓冲区中的数据发给慢客户端。后端连接占用时间大幅缩短。

### 5.2 proxy_buffer 核心配置

```nginx
location /api/ {
    proxy_pass http://backend;
    
    # proxy_buffering：是否启用响应缓冲（默认 on）
    proxy_buffering on;
    
    # proxy_buffers：缓冲区数量和大小
    # 8 个 16KB 缓冲区 = 128KB 总缓冲（用于存储响应头和响应体的前半部分）
    proxy_buffers 8 16k;
    
    # proxy_buffer_size：第一个缓冲区的大小（专门存储响应头）
    # 建议设为 4k 或 8k（大多数响应头都在这个范围内）
    proxy_buffer_size 4k;
    
    # proxy_busy_buffers_size：正在向客户端发送的缓冲区总大小上限
    # 超过此值时，暂停从后端读取（等待缓冲区有空间）
    proxy_busy_buffers_size 32k;
    
    # proxy_temp_file_write_size：缓冲区不够用时，溢出部分写入临时文件
    # 每次写入临时文件的大小
    proxy_temp_file_write_size 64k;
    
    # proxy_max_temp_file_size：临时文件最大大小
    # 设为 0 禁止使用临时文件（响应必须完全放入内存缓冲区）
    proxy_max_temp_file_size 1024m;
}
```

**缓冲策略选择**：
- **小而快的 API 响应**（< 100KB）：默认配置即可，全部在内存缓冲
- **大文件下载**（几十 MB 到几 GB）：考虑 `proxy_buffering off`，直接流式传输，避免占满磁盘（临时文件）
- **流式响应（Server-Sent Events / WebSocket）**：必须 `proxy_buffering off`，否则内容会被缓冲在 Nginx 内，客户端无法实时收到

---

## 第 6 章 upstream 生产配置最佳实践

### 6.1 完整的 upstream 配置模板

```nginx
upstream api_backend {
    # 负载均衡算法（选一种）
    least_conn;
    
    # 后端服务器列表
    server 10.0.0.1:8080 weight=2 max_fails=3 fail_timeout=30s;
    server 10.0.0.2:8080 weight=2 max_fails=3 fail_timeout=30s;
    server 10.0.0.3:8080 weight=1 max_fails=3 fail_timeout=30s;  # 较弱的机器，权重低
    server 10.0.0.4:8080 backup;  # 备用，仅在前三台全挂时启用
    
    # keepalive 连接池
    keepalive 64;           # 每个 Worker 保持 64 条空闲连接
    keepalive_requests 500; # 每条连接最多复用 500 次请求
    keepalive_timeout 60s;  # 空闲连接 60 秒后关闭
}

server {
    location /api/ {
        proxy_pass http://api_backend;
        
        # HTTP/1.1 + 清除 Connection 头（启用 keepalive 必须）
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        
        # 传递真实客户端信息
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 超时配置
        proxy_connect_timeout 5s;    # 建立连接超时
        proxy_send_timeout 60s;      # 发送请求超时
        proxy_read_timeout 60s;      # 等待后端响应超时
        
        # 失败重试（仅限幂等操作）
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_next_upstream_tries 2;
        proxy_next_upstream_timeout 10s;
    }
}
```

---

## 小结

`upstream` 模块是 Nginx 反向代理能力的核心引擎：

- **双 TCP 连接模型**：客户端→Nginx 和 Nginx→后端是两条独立连接，Nginx 在两者之间充当数据中继
- **keepalive 连接池**：每个 Worker 对每个后端地址维护空闲连接列表，`keepalive N` 是每 Worker 的上限，必须配合 `proxy_http_version 1.1` 和 `proxy_set_header Connection ""` 才生效
- **五种负载均衡算法**：round-robin（默认，加权平滑）、least_conn（响应时间差异大时更均衡）、ip_hash/hash（粘性路由，扩缩容有代价）、random two（大集群近似 least_conn）
- **被动健康检查**：通过失败计数器（`max_fails`/`fail_timeout`）标记不可用，冷却后探测恢复；`proxy_next_upstream` 提供请求级别的重试（注意幂等性）
- **缓冲策略**：开启 `proxy_buffering`（默认）可以快速释放后端连接（对慢客户端友好）；流式响应需要关闭缓冲

第 05 篇深入 `proxy_cache` 的物理结构：缓存 Key 的哈希映射到文件系统目录的两级布局，内存索引 Zone 与磁盘文件的协作模型，以及 `inactive`、`max_size`、`proxy_cache_valid` 的失效机制。

---

## 参考资料

- [Nginx 官方文档：ngx_http_upstream_module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
- [Nginx 官方文档：ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [平滑加权轮询算法（Nginx 官方博客）](https://www.nginx.com/blog/inside-nginx-how-we-designed-for-performance-scale/)


---

> **下一篇**：[[05 缓存机制：proxy_cache 的物理结构与失效策略]]
