---
title: "限流与熔断：leaky bucket 与 burst 参数的数学本质"
date: 2026-02-28
tags: [Nginx, 限流, 漏桶算法, 令牌桶, limit_req, limit_conn, burst, nodelay, 熔断, 共享内存]
aliases: []
---

# 08 限流与熔断：leaky bucket 与 burst 参数的数学本质

## 摘要

`limit_req` 和 `limit_conn` 是 Nginx 保护后端服务免受流量过载的两大武器。表面上看，配置它们只需要几行指令；但深入追问：`burst=20` 到底意味着什么？加了 `nodelay` 后行为为什么截然不同？`limit_req_zone` 共享内存中存储的是什么数据结构？两个 `limit_req` 指令叠加时如何互相影响？这些问题的答案藏在**漏桶算法（Leaky Bucket）**的数学模型里。本文从流量整形的经典算法（漏桶 vs 令牌桶）出发，推导 Nginx `limit_req` 的精确行为，分析 `burst` 与 `nodelay` 的四种组合语义，深入讲解共享内存 Zone 的红黑树数据结构，以及 `limit_conn` 的并发计数器实现，最后给出生产环境的限流策略设计方法。

---

## 第 1 章 为什么需要限流

### 1.1 无限流系统的崩溃模型

一个没有限流保护的后端服务，面对流量激增时的行为是可预测的：

```
正常状态：
  后端服务处理能力 = 1000 QPS
  实际流量 = 800 QPS
  系统健康，平均响应时间 50ms

流量激增（如热点事件、爬虫攻击）：
  实际流量 = 5000 QPS
  后端服务开始排队，响应时间从 50ms → 500ms → 5s
  内存队列积压，GC 压力增大
  响应时间超过超时阈值 → 大量请求失败（503 或 timeout）
  失败请求触发客户端重试 → 流量进一步增加（雪崩）
  最终：服务完全不可用
```

这个崩溃模式的本质是：**队列积压导致延迟指数级增长，而延迟增长又通过超时重试机制放大了流量**。防止这个循环的方法是在流量进入服务前**提前拒绝超出处理能力的部分**——这就是限流的价值。

**限流的目标不是不服务用户，而是在过载时选择性地拒绝一部分请求，保证剩余请求的服务质量**。宁可让 20% 的请求收到 429（Too Many Requests），也不让 100% 的请求都超时失败。

### 1.2 漏桶算法 vs 令牌桶算法

流量整形有两种经典算法，理解它们的差异是理解 Nginx 限流行为的前提：

**漏桶算法（Leaky Bucket）**：

想象一个底部有固定大小漏洞的桶。无论流入速度多快，流出速度始终固定（由漏洞大小决定）。桶满了（超出容量），新来的水直接溢出（请求被拒绝）。

```
特性：
- 输出速率严格恒定（rate = 固定值，如 10 req/s）
- 突发流量被"平滑"成恒定速率输出
- 不允许任何超过恒定速率的"突发"通过

适用场景：
- 对下游系统（如数据库）的保护——需要严格恒定的请求速率
- 发送方的流量整形——确保发出去的流量不超过某个恒定速率
```

**令牌桶算法（Token Bucket）**：

想象一个以恒定速率被放入令牌的桶（最多存 N 个令牌）。每个请求消耗一个令牌；如果桶中有令牌，请求立即通过；如果桶空了，请求等待或被拒绝。令牌可以积累——如果一段时间内没有请求，桶会积满令牌，之后允许一段时间内的突发请求（最多 N 个同时通过）。

```
特性：
- 平均速率受限（rate = 令牌生成速率）
- 允许短时间内的突发（最多消耗积累的 N 个令牌）
- 更符合真实业务的流量特征（平时低流量，偶尔有突发）

适用场景：
- API 速率限制——允许用户偶尔的突发请求
- 网络带宽整形——允许短暂超过平均带宽的突发
```

**Nginx `limit_req` 使用的是漏桶算法**，但通过 `burst` 参数模拟了一定程度的令牌桶行为（允许有限的突发）。理解这个细节是避免配置错误的关键。

---

## 第 2 章 limit_req_zone 的工作原理

### 2.1 共享内存 Zone 的数据结构

`limit_req_zone` 在 Nginx 共享内存中维护一个**红黑树（red-black tree）**，每个节点对应一个限流 Key（如一个客户端 IP）：

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
```

**节点数据结构**（简化）：

```c
// 每个限流 Key 在共享内存中的存储结构
typedef struct {
    uint64_t excess;      // 当前"超额"请求数（漏桶中积压的水量），单位：毫请求（×1000）
    uint64_t last;        // 上次请求的时间戳（毫秒）
} ngx_http_limit_req_node_t;
```

**为什么 `excess` 的单位是"毫请求"（×1000）**：

Nginx 的漏桶算法使用整数运算。为了在不引入浮点数的情况下精确表示"请求速率"，Nginx 将所有值放大 1000 倍：

- `rate=10r/s` 在内部存储为 `10000`（毫请求/秒）
- `excess` 的最大值（`burst` 个请求）在内部是 `burst * 1000`
- 时间以毫秒为单位，`excess` 每毫秒减少 `rate/1000`（即 `rate=10r/s` 时，每毫秒减少 10 毫请求）

这样，所有计算都是整数运算，避免了浮点精度问题。

**共享内存 Zone 的大小**：

`zone=api_limit:10m` 分配 10MB 共享内存。每个节点约占 64-128 字节（含红黑树节点的颜色、左右子节点指针、父节点指针等）。10MB 可以存储约 8-16 万个 Key。

> [!info] 核心概念：`$binary_remote_addr` vs `$remote_addr`
> `$remote_addr` 是 IPv4 地址的文本表示（如 `"192.168.1.100"`），最长 15 字节；IPv6 可达 39 字节。
> `$binary_remote_addr` 是 IP 地址的二进制表示，IPv4 固定 4 字节，IPv6 固定 16 字节。
>
> 用 `$binary_remote_addr` 作为 Key 比 `$remote_addr` 节省 60-90% 的内存，且哈希/比较速度更快。在客户端 IP 量很大时（如面向公网的 API），这个差异很显著。**生产中应始终使用 `$binary_remote_addr` 而非 `$remote_addr` 作为限流 Key**。

### 2.2 漏桶算法的精确执行流程

每次请求到来时，Nginx 执行以下步骤（以 `rate=10r/s` 为例）：

```
1. 在红黑树中查找当前请求的 Key（如客户端 IP）
   - 找到节点：读取 excess 和 last
   - 未找到：创建新节点，excess=0，last=当前时间

2. 计算自上次请求以来的时间差（elapsed_ms）：
   elapsed_ms = 当前时间 - last

3. 计算"已排空"的量（drain）：
   drain = elapsed_ms × rate/1000
   （rate=10r/s → drain = elapsed_ms × 0.01 毫请求/毫秒）

4. 更新 excess（当前桶中积压的量）：
   excess = max(0, excess - drain) + 1000  // +1000 = 新来一个请求（×1000 单位）

5. 判断是否超限：
   if excess > (burst + 1) × 1000:
       # 桶满（超过 burst 容量）→ 拒绝请求（429 Too Many Requests）
   elif excess > 1000:
       # 桶中有积压，但未超 burst → 请求进入队列（延迟处理）
   else:
       # excess ≤ 1000 → 正常处理
   
   更新 last = 当前时间
```

### 2.3 rate 参数的最小粒度

`rate` 参数支持两种单位：`r/s`（每秒请求数）和 `r/m`（每分钟请求数）：

```nginx
limit_req_zone $binary_remote_addr zone=zone1:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=zone2:10m rate=60r/m;
# rate=10r/s 和 rate=60r/m 的效果相同，都是"每秒 1 个"（平均）
# 但 10r/s 内部表示为 10ms 一个请求的间隔
# 60r/m 内部表示为 1000ms 一个请求的间隔
```

漏桶算法的"恒定速率"意味着：`rate=10r/s` 不是"每秒可以来 10 个"，而是"**每 100ms 最多来 1 个**"。如果两个请求的间隔小于 100ms（即 10ms 之内到来两个），第二个请求就算"超速"了。

---

## 第 3 章 burst 与 nodelay 的四种组合

### 3.1 基础配置（无 burst）

```nginx
limit_req zone=api_limit;
# 等价于 burst=0
```

行为：严格的漏桶——只要请求速率超过 `rate`（哪怕是超了 1ms 的间隔），立即返回 503。

对于 `rate=10r/s`：第一个请求正常处理；第二个请求必须等待第一个请求结束后 100ms 才能到来，否则 503。这对于真实用户来说过于严苛——浏览器加载页面时可能在极短时间内发多个并发请求（JS/CSS/图片），都会被 503。

### 3.2 有 burst，无 nodelay（队列模式）

```nginx
limit_req zone=api_limit burst=20;
# burst=20：允许桶中最多积压 20 个额外请求，这 20 个请求进入队列等待处理
```

行为：超过 `rate` 速率的请求**不立即拒绝，而是排队等待**，等到漏桶"排空"到能处理的时候再处理。队列容量是 `burst` 个请求；队列满了的请求才被拒绝（503）。

**数学推导**：

```
rate=10r/s，burst=20

场景：在第 0 毫秒，同时到来 25 个请求

- 第 1 个请求：excess = 0 + 1000 = 1000 ≤ 1000 → 立即处理
- 第 2-21 个请求：excess = 2000, 3000, ..., 21000
  excess 在 (1000, 21000] 范围（即 burst+1 以内）→ 排队
- 第 22-25 个请求：excess = 22000, 23000, 24000, 25000
  excess > (20+1) × 1000 = 21000 → 拒绝（503）

队列中的 20 个请求何时处理？
- 每 100ms（rate=10r/s 的间隔），漏桶排空 1 个请求
- 所以：第 2 个请求等待 100ms 后处理，第 3 个等 200ms，...，第 21 个等 2000ms
- 第 21 个请求要等 2 秒才能被处理！

结论：queue 模式下，burst 越大，排队请求的等待时间越长。
     burst=20, rate=10r/s 时，最大等待时间 = burst/rate = 20/10 = 2 秒
```

**问题**：排队等待 2 秒对用户来说几乎等同于超时（大多数前端 AJAX 超时设为 1-5 秒）。所以 `burst` 不是"允许突发 20 个请求"，而是"最多让 20 个请求排队等待（最长 burst/rate 秒）"——这个语义经常被误解。

### 3.3 有 burst，有 nodelay（突发允许模式）

```nginx
limit_req zone=api_limit burst=20 nodelay;
# nodelay：桶内排队的请求不等待，立即处理（不受速率限制地快速排空队列）
```

行为：超过 `rate` 速率的请求，只要在 `burst` 容量以内，**立即处理**（不排队等待）。但会消耗 `excess`（桶中的积压量），后续请求需要等待 `excess` 降低。

**数学推导**：

```
rate=10r/s，burst=20，nodelay

场景：第 0ms 来了 15 个请求，第 500ms 来了 10 个请求

第 0ms，15 个请求同时到达：
- 第 1-15 个：excess = 1000, 2000, ..., 15000，全部 ≤ 21000（burst+1）
- nodelay：全部立即处理（不等待）
- 处理完后 excess = 15000，last = 0ms

第 500ms，10 个请求到达：
- 先更新 excess：elapsed=500ms，drain = 500 × 10 = 5000 毫请求
  excess = max(0, 15000 - 5000) = 10000
- 第 16-25 个（新来的 10 个）：excess = 11000, 12000, ..., 20000, 21000
  都 ≤ 21000（burst+1），全部立即处理
- 第 26 个（新来的第 11 个）：excess = 22000 > 21000 → 拒绝

第 2500ms（距 0ms 共 2500ms），新请求到达：
- elapsed=2500ms，drain = 2500 × 10 = 25000 毫请求
  excess = max(0, 21000 - 25000) = 0
- 新请求可以正常处理，burst 容量完全恢复
```

**`nodelay` 的真正语义**：不是"取消速率限制"，而是"**用 burst 容量作为突发令牌桶**"——`burst` 个令牌可以积累，每个请求消耗一个令牌，令牌以 `rate` 速率补充。这使 `limit_req burst=N nodelay` 的行为非常接近**令牌桶算法**。

### 3.4 无 burst，有 delay 参数（精细控制）

Nginx 1.15.7 引入了 `delay` 参数，提供介于"无 nodelay（全部排队）"和"有 nodelay（全部立即）"之间的精细控制：

```nginx
limit_req zone=api_limit burst=20 delay=8;
# 前 delay 个请求（8个）立即处理（nodelay 语义）
# 第 9-20 个请求（burst - delay）进入队列等待
# 第 21+ 个请求拒绝（503）
```

```
burst=20, delay=8，rate=10r/s

第 0ms 同时来 25 个请求：
- 第 1-8 个：excess ≤ 8000 ≤ delay×1000，nodelay 处理（立即）
- 第 9-20 个：excess > 8000，进入队列（类似无 nodelay 的行为）
- 第 21-25 个：excess > 21000，拒绝

等待时间：
- 第 9 个等 100ms，第 10 个等 200ms，...，第 20 个等 1200ms
  （比无 delay 的 2000ms 最大等待要短，因为前 8 个已立即处理）
```

**四种组合的行为总结**：

| 配置 | burst 容量内的行为 | burst 容量外 | 最大等待时间 |
|-----|-----------------|------------|------------|
| 无 burst | 任何超速立即拒绝 | 拒绝 | 0 |
| burst=N | 排队等待（最多 burst/rate 秒）| 拒绝（503）| burst/rate 秒 |
| burst=N nodelay | 立即处理（消耗令牌）| 拒绝（503）| 0（但会限制后续突发）|
| burst=N delay=D | 前 D 个立即，后(N-D)个排队 | 拒绝（503）| (N-D)/rate 秒 |

---

## 第 4 章 limit_conn：并发连接数限制

### 4.1 limit_conn 的工作机制

`limit_conn` 限制的是**同时建立的并发连接数**，而不是请求速率。它适合防止单个 IP 建立大量长连接（如 WebSocket 连接、文件下载长连接）：

```nginx
http {
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;
    
    server {
        location /download/ {
            limit_conn conn_limit 5;  # 每个 IP 最多 5 个并发连接
            limit_conn_status 429;    # 超限时返回 429（默认 503）
            limit_conn_log_level warn; # 超限时的日志级别
        }
    }
}
```

**共享内存数据结构**：`limit_conn_zone` 同样使用红黑树，每个节点存储：

```c
typedef struct {
    uint32_t conn;   // 当前并发连接数计数器
} ngx_http_limit_conn_node_t;
```

每次连接建立时，对应 Key 的 `conn++`；连接关闭时，`conn--`。如果 `conn` 即将超过限制值（如 5），新连接被拒绝。

**`limit_conn` 与 `limit_req` 的关键区别**：

- `limit_req`：控制**请求速率**（单位时间内的请求数），适合 HTTP 短连接场景
- `limit_conn`：控制**并发连接数**（同时存在的连接数），适合长连接场景

对于典型的 HTTP/1.1 短请求（请求完成后连接关闭或进入 Keep-Alive 空闲）：
- `limit_conn` 限制同时并发的"活跃"连接数
- Keep-Alive 空闲连接也**计入**连接数（连接未关闭）

> [!warning] 生产避坑：Keep-Alive 与 limit_conn
> HTTP Keep-Alive 会保持 TCP 连接在请求完成后继续存在（等待下一个请求）。如果客户端的浏览器同时开了多个 Keep-Alive 连接（现代浏览器通常对同一域名保持 6 个并发连接），`limit_conn 3` 可能意外地拒绝合法用户的后续请求——因为他已经用了 6 个 Keep-Alive 连接，但只有 3 个的并发限额。
>
> 对于面向最终用户的 Web 服务，`limit_conn` 的值应该设置得足够大（如 20-50），避免误伤正常用户；较小的值（如 3-5）更适合**下载接口**（防止单个 IP 占满带宽）或 **API 接口**（配合 `limit_req` 使用）。

### 4.2 多个限流规则的叠加

同一个 `location` 可以同时应用多个 `limit_req` 和 `limit_conn` 规则：

```nginx
http {
    limit_req_zone $binary_remote_addr zone=per_ip:10m rate=10r/s;
    limit_req_zone $server_name zone=per_server:10m rate=1000r/s;
    limit_conn_zone $binary_remote_addr zone=conn_per_ip:10m;
    
    server {
        location /api/ {
            # 每个 IP 限速 10r/s，burst=5
            limit_req zone=per_ip burst=5 nodelay;
            
            # 整个 server 限速 1000r/s（全局保护）
            limit_req zone=per_server burst=100 nodelay;
            
            # 每个 IP 最多 10 个并发连接
            limit_conn conn_per_ip 10;
        }
    }
}
```

**多规则叠加的执行语义**：所有规则**并行检查**，任何一个规则触发限流，请求就被拒绝（返回对应的 `limit_req_status` 或 `limit_conn_status`）。不是"先过第一关再过第二关"的串行模型——是最严格规则优先生效。

---

## 第 5 章 限流的高级配置与生产策略

### 5.1 不同 URI 使用不同限流策略

```nginx
http {
    # 登录接口：严格限流（防暴力破解）
    limit_req_zone $binary_remote_addr zone=login_limit:10m rate=1r/m;
    
    # 普通 API：适度限流
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;
    
    # 搜索接口：限流（搜索比普通 API 更耗 CPU）
    limit_req_zone $binary_remote_addr zone=search_limit:10m rate=5r/s;
    
    server {
        location = /auth/login {
            limit_req zone=login_limit burst=3 nodelay;
            limit_req_status 429;
        }
        
        location /api/search {
            limit_req zone=search_limit burst=2 nodelay;
            proxy_pass http://backend;
        }
        
        location /api/ {
            limit_req zone=api_limit burst=20 nodelay;
            proxy_pass http://backend;
        }
    }
}
```

### 5.2 白名单机制：对特定 IP 不限流

```nginx
http {
    # 定义白名单变量（map 延迟求值）
    geo $limit {
        default 1;             # 默认：参与限流
        127.0.0.1 0;           # 本地：不限流
        10.0.0.0/8 0;          # 内网：不限流
        192.168.0.0/16 0;      # 内网：不限流
    }
    
    # 根据 $limit 变量决定 limit_req_key：
    # $limit=0（白名单）时，key="" → 不计入任何限流 zone
    # $limit=1 时，key=$binary_remote_addr → 正常限流
    map $limit $limit_key {
        0 "";
        1 $binary_remote_addr;
    }
    
    limit_req_zone $limit_key zone=api_limit:10m rate=10r/s;
    
    server {
        location /api/ {
            limit_req zone=api_limit burst=20 nodelay;
            proxy_pass http://backend;
        }
    }
}
```

**`geo` 模块的工作原理**：`geo` 根据 `$remote_addr`（默认）或指定变量，在内部维护一个 CIDR 前缀树（Patricia Trie），将 IP 映射到配置的值。`geo` 的查找是 O(log n) 的，比 `map` + `~` 正则匹配更高效。

### 5.3 基于用户身份而非 IP 的限流

IP 限流有一个著名问题：在 NAT 或代理之后，多个用户共享同一出口 IP，IP 限流会误伤合法用户。更好的方案是基于**用户身份标识**（如 JWT 中的 user_id、API Key）限流：

```nginx
# 从 Authorization 头中提取 Bearer Token（或 API Key）
map $http_authorization $api_client_id {
    "~^Bearer (.+)$" $1;  # 提取 Bearer Token 作为限流 Key
    default $binary_remote_addr;  # 没有 Token 时降级到 IP 限流
}

limit_req_zone $api_client_id zone=client_limit:10m rate=100r/s;

location /api/ {
    limit_req zone=client_limit burst=50 nodelay;
    proxy_pass http://backend;
}
```

### 5.4 与 upstream 超时熔断的协同

`limit_req` 解决的是"请求速率过高"的问题；upstream 的超时机制解决的是"后端响应过慢"的问题。两者配合，形成完整的流量防护体系：

```nginx
upstream backend {
    server 10.0.0.1:8080 max_fails=3 fail_timeout=30s;
    server 10.0.0.2:8080 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

location /api/ {
    # 前置：速率限流（防过载）
    limit_req zone=api_limit burst=20 nodelay;
    limit_req_status 429;
    
    proxy_pass http://backend;
    
    # 后置：超时控制（防后端慢响应积压）
    proxy_connect_timeout 3s;
    proxy_send_timeout 10s;
    proxy_read_timeout 30s;
    
    # 失败重试（排除 429 自身的重试，避免双重限流）
    proxy_next_upstream error timeout http_502 http_503;
    proxy_next_upstream_tries 2;
}
```

**完整的保护层次**：

```
客户端请求
    ↓
limit_conn（并发连接数上限）
    ↓
limit_req（速率限流，过快 → 429）
    ↓
proxy_pass（转发到 upstream）
    ↓
proxy_connect_timeout（建连超时 → 下一台后端）
proxy_read_timeout（读取超时 → 返回 504）
    ↓
max_fails（失败次数 → 标记后端不可用）
```

---

## 第 6 章 限流的可观测性

### 6.1 监控限流触发率

```nginx
# 在 log_format 中记录限流相关信息
log_format main '$remote_addr [$time_local] '
                '"$request" $status '
                'req_id=$request_id';

# 通过 access_log 统计 429/503 比率（限流触发频率）
# grep 出所有 429/503 响应，计算占比
```

```bash
# 统计最近1小时的限流触发率
awk '$9 == "429" || $9 == "503" {limited++} {total++} END {
    printf "限流触发: %d/%d (%.2f%%)\n", limited, total, limited/total*100
}' /var/log/nginx/access.log
```

### 6.2 limit_req_log_level：控制超限日志级别

```nginx
limit_req_log_level warn;   # 超限时以 warn 级别记录（默认 error）
limit_conn_log_level warn;

# 生产建议：设为 warn，避免限流触发时产生大量 error 日志，
# 影响对真正错误（如 upstream 故障）的告警信噪比
```

---

## 小结

Nginx 的限流机制以**漏桶算法**为基础，通过共享内存红黑树实现跨 Worker 进程的精确计数：

- **漏桶的本质**：不是"每秒允许 N 个"，而是"相邻请求间隔不得短于 1/N 秒"——`rate=10r/s` 意味着 100ms 一个的恒定间隔
- **`burst` 的真实语义**：不是"允许突发 N 个"，而是"允许最多 N 个请求排队等待（最大等待 burst/rate 秒）"
- **`nodelay` 的改变**：将 burst 容量从"排队缓冲"变为"即时令牌桶"——超速请求立即处理但消耗令牌，令牌以 rate 速率恢复
- **`delay=D`**：精细控制前 D 个立即处理，剩余 burst-D 个排队——在吞吐和延迟之间平衡
- **`limit_conn`**：基于并发连接计数，适合长连接防护；注意 Keep-Alive 连接也计入计数
- **多规则叠加**：并行检查，任意一条触发即限流；通过 `geo` + `map` + 空 Key 实现白名单豁免
- **`$binary_remote_addr`**：IPv4 只占 4 字节，比文本 IP 节省 75% 内存，生产必用

第 09 篇深入日志体系与可观测性：`log_format` 的变量体系（`$request_time` vs `$upstream_response_time` 的精确含义差异）、缓冲写日志的底层机制、以及通过 `$request_id` 实现全链路追踪。

---

## 参考资料

- [Nginx 官方文档：ngx_http_limit_req_module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [Nginx 官方文档：ngx_http_limit_conn_module](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html)
- [漏桶算法与令牌桶算法对比（RFC 2697）](https://datatracker.ietf.org/doc/html/rfc2697)


---

> **下一篇**：[[09 日志体系与可观测性：access_log、error_log 与链路追踪]]
