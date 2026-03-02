---
title: "日志体系与可观测性：access_log、error_log 与链路追踪"
date: 2026-02-28
tags: [Nginx, access_log, error_log, log_format, 可观测性, 链路追踪, request_id, 缓冲写日志, 变量体系]
aliases: []
---

# 09 日志体系与可观测性：access_log、error_log 与链路追踪

## 摘要

日志是系统可观测性的基础。Nginx 的日志体系看似简单——一个 `access_log`，一个 `error_log`——但其中隐藏着大量细节：`$request_time` 和 `$upstream_response_time` 的精确语义差异是故障定位的关键，两者混淆会导致对问题根因的误判；缓冲写日志（`buffer`/`flush`）的机制决定了高 QPS 场景下的磁盘 I/O 压力；`$request_id` 变量与后端服务协作可以实现贯穿全链路的请求追踪；而 `error_log` 的五个日志级别背后是 Nginx 内部的严重性分类体系。本文系统梳理 Nginx 日志体系的每个组成部分，重点讲解变量体系、缓冲机制与链路追踪的实现原理，帮助工程师在生产中构建高质量的可观测性基础设施。

---

## 第 1 章 access_log 的工作机制

### 1.1 access_log 的执行时机

在第 03 篇《HTTP 请求处理管道》中已经讲过，`access_log` 的写入发生在 **Phase 11（NGX_HTTP_LOG_PHASE）**，这是请求处理管道的最后一个阶段，在 HTTP 响应**已经发送给客户端之后**执行。

这个时机设计有深刻的含义：

**好处一：能记录完整的响应信息**

日志中需要记录 `$status`（响应状态码）、`$body_bytes_sent`（发送的响应体字节数）、`$upstream_response_time`（后端响应时间）等变量，这些变量只有在响应完全发送后才有确定的值。如果在请求处理过程中写日志，这些变量还是不完整的（`$body_bytes_sent` 为 0，`$upstream_response_time` 为空）。

**好处二：不影响响应延迟**

LOG_PHASE 在响应发送后执行，写日志的磁盘 I/O 不在请求处理的关键路径上，不会增加客户端感知到的响应延迟。

**一个容易混淆的问题**：如果客户端在响应完全接收之前断开连接（如用户点击停止或网络中断），Nginx 的响应发送可能只完成了一部分。此时的 `$body_bytes_sent` 记录的是**实际发送的字节数**（不是响应体的总大小），`$status` 仍然是 200（如果 HTTP 头已经发出），但实际上客户端没有收到完整响应。Nginx 不会因为客户端断开而改变 `$status`——这是 `$status` 与用户实际体验可能不一致的场景之一。

### 1.2 access_log 的基本配置

```nginx
http {
    # 定义日志格式（log_format 只能在 http 上下文中定义）
    log_format main '$remote_addr - $remote_user [$time_local] '
                    '"$request" $status $body_bytes_sent '
                    '"$http_referer" "$http_user_agent"';
    
    # 默认的 combined 格式（与 Apache 兼容，main 格式略有差异）
    log_format combined '$remote_addr - $remote_user [$time_local] '
                        '"$request" $status $body_bytes_sent '
                        '"$http_referer" "$http_user_agent"';
    
    # 使用 main 格式写到指定文件
    access_log /var/log/nginx/access.log main;
    
    # 关闭 access_log（用于提升性能，或对特定 location 关闭）
    access_log off;
}
```

**`access_log` 的多目标写入**：

Nginx 支持将同一请求的日志同时写到多个目标（不同的文件、不同的格式），适合同时需要原始日志和结构化日志的场景：

```nginx
server {
    # 同时写两个日志文件：一个详细格式，一个 JSON 格式
    access_log /var/log/nginx/access.log detailed;
    access_log /var/log/nginx/access_json.log json_format;
}
```

---

## 第 2 章 关键变量的精确语义

### 2.1 $request_time vs $upstream_response_time：最常被混淆的两个变量

这是 Nginx 日志分析中最常见的理解误区，混淆这两个变量会导致将"客户端慢"误判为"后端慢"，或反之。

**`$request_time`（请求总时间）**：

从 Nginx **接收到客户端请求的第一个字节**开始，到 Nginx **将最后一个响应字节发送给客户端完成**为止的总时间（秒，精确到毫秒，如 `0.123`）。

包含了：
- 客户端发送请求头/体的时间（网络传输时间）
- Nginx 处理请求的 CPU 时间（rewrite、access 控制等）
- 等待后端响应的时间
- 向客户端发送响应的时间（包括客户端的接收速度）

**`$upstream_response_time`（后端响应时间）**：

从 Nginx **向后端发送请求**（建立连接后）到 Nginx **接收到后端最后一个字节响应**为止的时间（秒，精确到毫秒）。

只包含：
- Nginx → 后端的请求发送时间（通常极短）
- 后端处理请求的时间
- 后端 → Nginx 的响应接收时间

**不包含**：
- 客户端到 Nginx 的网络传输时间
- Nginx 向客户端发送响应的时间（客户端慢时可能很长）

```
时间轴可视化：

t=0    t=50ms   t=100ms   t=200ms   t=300ms    t=500ms
 |      |         |         |          |           |
 客户端                                            客户端
 发送   Nginx    Nginx     后端       Nginx       完全
 请求   接收     向后端    响应       接收        发送
 开始   完毕     发请求    完毕       完毕        响应

$request_time         = t=500ms - t=0    = 500ms
$upstream_response_time = t=300ms - t=100ms = 200ms

差值 300ms = 客户端发送请求（50ms）+ 客户端接收响应（200ms）+ Nginx 内部处理
```

**实际诊断场景**：

```
场景 A：$request_time=5s，$upstream_response_time=5s
  → 后端本身很慢（5秒才响应）
  → 应查后端服务：DB 慢查询？GC 停顿？线程阻塞？

场景 B：$request_time=5s，$upstream_response_time=0.1s
  → 后端只用了 0.1s，但客户端用了 5s 才接收完
  → 客户端网络差（如移动端弱网）或响应体很大
  → 不应该优化后端，应该考虑压缩（gzip）、减小响应体、使用 CDN

场景 C：$request_time=5s，$upstream_response_time=-
  → upstream_response_time 为 "-"（空）说明请求没有转发到后端
  → 可能命中了 Nginx 本地缓存，或被 limit_req/access deny 在 Phase 1-9 就终止了

场景 D：$request_time=5s，$upstream_response_time=5s, 0.1s
  → 多个值用逗号分隔，说明触发了 proxy_next_upstream 重试
  → 第一台后端超时（5s），重试到第二台成功（0.1s）
```

### 2.2 $upstream_addr：定位到具体后端实例

```nginx
log_format upstream_log '$remote_addr [$time_local] "$request" $status '
                         'upstream_addr=$upstream_addr '
                         'upstream_status=$upstream_status '
                         'upstream_response_time=$upstream_response_time '
                         'request_time=$request_time';
```

`$upstream_addr` 记录处理本次请求的后端服务器地址（IP:Port）。在负载均衡场景中，这是定位"哪台后端慢/出错"的关键变量：

```bash
# 统计各后端实例的平均响应时间
awk '{
    # 解析 upstream_addr 和 upstream_response_time
    match($0, /upstream_addr=([^ ]+)/, addr)
    match($0, /upstream_response_time=([^ ]+)/, rt)
    if (addr[1] && rt[1] != "-") {
        sum[addr[1]] += rt[1]
        count[addr[1]]++
    }
} END {
    for (a in sum) {
        printf "%s avg_rt=%.3fs requests=%d\n", a, sum[a]/count[a], count[a]
    }
}' /var/log/nginx/access.log | sort -t= -k2 -rn
```

如果发现某台后端的 `$upstream_response_time` 明显高于其他实例，就需要重点排查那台机器。

### 2.3 其他重要的诊断变量

| 变量 | 含义 | 诊断价值 |
|-----|-----|---------|
| `$upstream_connect_time` | 与后端建立连接的时间 | 高值说明后端连接池耗尽或网络问题 |
| `$upstream_header_time` | 接收到后端第一个响应字节的时间 | TTFB（Time to First Byte）的后端部分 |
| `$upstream_cache_status` | 缓存命中状态（HIT/MISS等）| 监控缓存命中率 |
| `$pipe` | 请求是否是 HTTP Pipeline 中的（p或.）| 排查 pipeline 相关问题 |
| `$connection` | TCP 连接编号 | 关联同一 TCP 连接的多个请求 |
| `$connection_requests` | 当前 TCP 连接处理的请求数 | 分析 Keep-Alive 的复用效果 |
| `$msec` | 当前时间（Unix 毫秒时间戳）| 精确的请求时间戳（比 $time_local 精确）|

---

## 第 3 章 缓冲写日志的底层机制

### 3.1 为什么需要缓冲写日志

在高 QPS 场景（如每秒 10 万请求），如果每次请求完成后立即调用 `write()` 将日志写入磁盘，会产生大量的**系统调用开销**和**磁盘 I/O 碎片**：

```
无缓冲写日志（默认行为）：
  请求 1 完成 → write() → 磁盘写入 50 字节（1次系统调用）
  请求 2 完成 → write() → 磁盘写入 52 字节（1次系统调用）
  ...
  100,000 QPS → 每秒 100,000 次 write() 系统调用
                → 每秒 100,000 次磁盘随机写（5MB/s，但 IOPS 极高）

  系统调用是有代价的：每次 write() 需要用户态↔内核态切换（约 0.1-1μs）
  100,000 QPS × 1μs = 100ms/s 的 CPU 时间纯花在系统调用上（约 1 个核）
```

缓冲写日志的解决方案：**在用户态内存中积累多条日志，一次批量 write() 写入磁盘**，将 N 次系统调用合并为 1 次：

```nginx
access_log /var/log/nginx/access.log main buffer=64k flush=5s;
# buffer=64k：用户态内存缓冲区大小（积累到 64KB 后触发一次 write）
# flush=5s：即使缓冲区未满，最长 5 秒必须 flush 一次（防止日志积压太久）
```

### 3.2 缓冲写日志的三种触发条件

Nginx 的缓冲日志在以下三种情况之一触发实际的磁盘写入：

**条件一：缓冲区已满**（`buffer` 大小）

积累的日志字节数达到 `buffer` 大小时，立即触发 `write()`，将缓冲区内容全部写入磁盘，然后清空缓冲区。这是正常高 QPS 时最常触发的条件。

**条件二：定时刷新**（`flush` 间隔）

即使缓冲区未满，每隔 `flush` 指定的时间（如 5 秒），强制触发一次 `write()`。这保证了在低 QPS 时，日志不会在缓冲区中积压太久（最多延迟 `flush` 秒才写入磁盘）。

**条件三：Worker 进程退出或 reopen 信号**

当 Worker 进程收到关闭信号（SIGQUIT）或日志重新打开信号（SIGUSR1，用于日志切割）时，立即将缓冲区剩余内容全部刷盘，防止日志丢失。

> [!warning] 生产避坑：buffer 日志的丢失风险
> 缓冲写日志意味着：如果 Worker 进程**意外崩溃**（被 kill -9 或 OOM 杀死），缓冲区中未写盘的日志**永久丢失**。`flush=5s` 意味着最多丢失 5 秒的日志。
>
> 对于需要 100% 日志完整性的场景（如金融审计日志、安全日志），不应该使用 `buffer`（或设置极小的 `flush` 间隔，如 `flush=100ms`）。对于性能优先的业务日志，`buffer=64k flush=5s` 是合理的权衡。

### 3.3 gzip 压缩日志文件

Nginx 支持将日志直接以 gzip 压缩格式写入，节省磁盘空间（日志文本压缩率通常 80-90%）：

```nginx
access_log /var/log/nginx/access.log.gz main gzip=6 buffer=64k flush=5s;
# gzip=6：压缩级别（1=最快，9=最小，默认1）
# 注意：gzip 压缩在 CPU 上有开销，高 QPS 时慎用高压缩级别
```

---

## 第 4 章 $request_id 与全链路追踪

### 4.1 链路追踪的工程必要性

在微服务架构中，一次用户请求可能经过：浏览器 → CDN → Nginx → API Gateway → Service A → Service B → Database，链路上有 5-7 个服务。当这次请求出现问题（报错、超时），需要在 5-7 个服务的日志中找到与这次请求相关的所有日志条目，才能重建完整的调用链，定位问题。

没有链路追踪时，工程师需要靠时间戳和 IP 地址手工拼凑，当并发请求量很大时（几十万 QPS），这几乎是不可能的。

**链路追踪的核心思想**：给每个请求分配一个**唯一的 Request ID**，在整条链路的每个节点上：
1. 记录 Request ID 到本节点的日志
2. 通过请求头将 Request ID 传递给下游服务

这样，通过 Request ID 就能在所有服务的日志中找出所有相关记录，重建完整调用链。

### 4.2 $request_id 的生成机制

Nginx 1.11.0 引入了内置的 `$request_id` 变量，在每个请求到达时**自动生成一个 32 字符的随机十六进制字符串**（128 位随机数）：

```
$request_id 示例：a3b7c9d1e5f28304a6b9c2d7e1f4a803
```

**生成方式**：Nginx 使用[[伪随机数生成器（PRNG）]]（通常是基于 OS 提供的 `/dev/urandom`），生成 16 字节随机数，转换为 32 字符十六进制字符串。在极高 QPS（> 100万/秒）时，理论上存在碰撞概率，但 128 位随机数的碰撞概率极低（约 10^-38），实践中可以忽略。

### 4.3 从 Nginx 到后端服务的 Request ID 传递

```nginx
server {
    # 将 $request_id 写入访问日志
    log_format with_trace '$remote_addr [$time_local] '
                           '"$request" $status $body_bytes_sent '
                           'req_id=$request_id '
                           'upstream_rt=$upstream_response_time '
                           'total_rt=$request_time';
    
    access_log /var/log/nginx/access.log with_trace;
    
    location /api/ {
        # 将 $request_id 通过请求头传递给后端服务
        proxy_set_header X-Request-Id $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_pass http://backend;
    }
    
    # 同时在响应头中返回 Request ID（便于前端开发者和用户反馈）
    add_header X-Request-Id $request_id always;
}
```

**后端服务的接入**（以 Java Spring Boot 为例）：

```java
// Spring Boot 拦截器：读取 X-Request-Id 并放入 MDC（日志上下文）
@Component
public class RequestIdInterceptor implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest request, ...) {
        String requestId = request.getHeader("X-Request-Id");
        if (requestId != null) {
            MDC.put("requestId", requestId);  // 放入 SLF4J MDC
        }
        return true;
    }
    
    @Override
    public void afterCompletion(HttpServletRequest request, ...) {
        MDC.remove("requestId");  // 清理，防止线程池复用时携带旧值
    }
}
```

```xml
<!-- logback.xml：在每条日志中输出 requestId -->
<pattern>%d{ISO8601} [%X{requestId}] %-5level %logger{36} - %msg%n</pattern>
```

之后，后端的每条日志都会带上 `requestId`，通过它可以在 Nginx 日志和后端日志之间精确关联。

### 4.4 处理客户端传入的 Request ID

某些场景下，上游（如 API Gateway、CDN）会在请求中附带自己生成的 Request ID。Nginx 需要在"使用上游的 ID"和"生成新 ID"之间做选择：

```nginx
# 策略 1：优先使用上游传入的 ID，没有则自动生成
map $http_x_request_id $trace_id {
    default  $http_x_request_id;  # 有 X-Request-Id 头 → 使用它
    ""       $request_id;         # 没有 → 使用 Nginx 自动生成的
}

server {
    location /api/ {
        proxy_set_header X-Request-Id $trace_id;  # 传递给后端
    }
    
    add_header X-Request-Id $trace_id always;
    
    access_log /var/log/nginx/access.log with_trace;
    # log_format 中使用 $trace_id 而非 $request_id
}
```

> [!warning] 生产避坑：外部 Request ID 的安全风险
> 直接使用客户端传入的 `X-Request-Id` 有安全风险：攻击者可以伪造任意 ID（如与另一个合法请求相同的 ID），造成日志污染或混淆。
>
> **建议**：只信任来自已知受信上游（如内网 API Gateway）的 Request ID；来自公网的请求，忽略客户端传入的 `X-Request-Id`，强制使用 Nginx 生成的 `$request_id`。
>
> 如何区分公网和内网来源：
> ```nginx
> geo $trusted_upstream {
>     default 0;
>     10.0.0.0/8 1;
>     172.16.0.0/12 1;
> }
>
> map $trusted_upstream $trace_id {
>     1 $http_x_request_id;  # 内网：使用传入的 ID
>     0 $request_id;         # 公网：使用 Nginx 生成的 ID
> }
> ```

---

## 第 5 章 error_log 的级别体系

### 5.1 八个日志级别的含义

`error_log` 支持八个严重性级别（从高到低）：

```nginx
error_log /var/log/nginx/error.log warn;
# 只记录 warn 级别及以上（warn, error, crit, alert, emerg）的日志
```

| 级别 | 含义 | 典型场景 |
|-----|-----|---------|
| `debug` | 调试信息（极详细，生产禁用）| 每次 epoll 事件、每个请求的 Phase 执行 |
| `info` | 一般信息 | 服务器启动、连接建立/关闭 |
| `notice` | 值得注意的事件 | 配置重载完成、Worker 进程启动/停止 |
| `warn` | 警告（不影响功能，但需关注）| 连接超时、`limit_req` 触发（默认 error 级别）|
| `error` | 错误（影响单个请求）| 后端连接失败、文件找不到（404）|
| `crit` | 严重错误（影响多个请求）| 磁盘空间不足、共享内存分配失败 |
| `alert` | 需要立即处理的严重问题 | 进程通信管道错误 |
| `emerg` | 紧急（系统无法提供服务）| Master 进程无法绑定端口、配置错误 |

**生产建议**：

- **正常运行期间**：`error_log /var/log/nginx/error.log warn;`——只记录 warn 及以上，避免 info 级别的大量连接日志淹没真正的问题
- **故障诊断期间**：临时切换为 `info` 或 `debug`（注意：`debug` 会产生巨量日志，可能导致磁盘满），诊断完成后恢复 `warn`
- **绝不在生产长期开启 `debug`**：每个请求产生数百条调试日志，百万 QPS 的系统会在秒级写满磁盘

### 5.2 特定连接的 debug 日志

Nginx 支持只对特定 IP 的连接开启 debug 日志，而不影响其他连接的日志级别：

```nginx
# 全局 error_log 级别设为 warn
error_log /var/log/nginx/error.log warn;

# 只对特定 IP 开启 debug 日志（需要 Nginx 编译时包含 --with-debug）
events {
    debug_connection 192.168.1.100;   # 只对这个 IP 的连接开启 debug
    debug_connection 10.0.0.0/8;     # 或整个网段
}
```

这是在生产环境中安全排查特定用户问题的方法：只对测试机器开启 debug，不影响生产流量的日志性能。

### 5.3 error_log 的上下文继承

与大多数 Nginx 指令不同，`error_log` 在 `http`、`server`、`location` 上下文中**可以独立配置**（不是覆盖继承，而是层叠）：

```nginx
# 全局 error_log（记录所有模块的错误）
error_log /var/log/nginx/error.log warn;

http {
    # HTTP 模块的 error_log（覆盖全局，或指向不同文件）
    error_log /var/log/nginx/http_error.log warn;
    
    server {
        # 特定 server 的 error_log（调试某个虚拟主机）
        error_log /var/log/nginx/site_error.log debug;
    }
}
```

---

## 第 6 章 构建生产级可观测性日志方案

### 6.1 推荐的 JSON 格式日志

结构化日志（JSON 格式）便于机器解析和 ELK/Loki 等日志系统的接入：

```nginx
log_format json_format escape=json
    '{'
    '"timestamp":"$time_iso8601",'
    '"remote_addr":"$remote_addr",'
    '"request_id":"$request_id",'
    '"method":"$request_method",'
    '"uri":"$uri",'
    '"query":"$args",'
    '"status":$status,'
    '"bytes_sent":$body_bytes_sent,'
    '"request_time":$request_time,'
    '"upstream_addr":"$upstream_addr",'
    '"upstream_status":"$upstream_status",'
    '"upstream_response_time":"$upstream_response_time",'
    '"upstream_connect_time":"$upstream_connect_time",'
    '"cache_status":"$upstream_cache_status",'
    '"http_referer":"$http_referer",'
    '"http_user_agent":"$http_user_agent",'
    '"http_x_forwarded_for":"$http_x_forwarded_for",'
    '"ssl_protocol":"$ssl_protocol",'
    '"ssl_cipher":"$ssl_cipher"'
    '}';

# escape=json：自动转义日志值中的特殊 JSON 字符（\n, ", \, 等）
# 避免 User-Agent 中的特殊字符破坏 JSON 格式

access_log /var/log/nginx/access.json json_format buffer=64k flush=5s;
```

**`escape=json` 参数（Nginx 1.11.8+）**：自动将字段值中的 `\n`、`\r`、`"`、`\` 等 JSON 特殊字符进行转义，确保生成的是合法 JSON。没有这个参数，User-Agent 或 Referer 中偶尔出现的双引号会破坏 JSON 格式，导致日志解析失败。

### 6.2 条件日志：降低无用日志量

不是所有请求都值得记录详细日志。健康检查（`/healthz`）、静态资源、监控探针的日志通常没有诊断价值，但会占用大量磁盘空间：

```nginx
# 对特定 URI 关闭 access_log
location = /healthz {
    access_log off;
    return 200 "OK";
}

# 对静态资源关闭 access_log（或写到单独的低优先级文件）
location ~* \.(jpg|png|gif|ico|css|js|woff2)$ {
    access_log off;
    # 或：
    # access_log /var/log/nginx/static.log main buffer=128k flush=60s;
    expires 7d;
}

# 对 200 状态的健康检查不记录（基于变量的条件日志）
map $status $loggable {
    ~^[23]  0;   # 2xx 和 3xx：值为 0（不记录）— 慎用，会丢失成功请求日志
    default 1;   # 其他：值为 1（记录）
}

# 更实用的场景：只对特定 URI 的成功响应不记录
map "$request_uri$status" $loggable {
    "~^/healthz2\d\d$"  0;  # /healthz 的 2xx 响应不记录
    default             1;
}

access_log /var/log/nginx/access.log json_format if=$loggable;
# if=$loggable：只在 $loggable = 非空字符串（非0非空）时记录
```

### 6.3 慢请求日志：专项监控高延迟请求

```nginx
# 定义慢请求日志格式（更详细的诊断信息）
log_format slow_log '$remote_addr [$time_local] '
                    '"$request" $status '
                    'request_time=$request_time '
                    'upstream_times=$upstream_response_time '
                    'upstream_connect=$upstream_connect_time '
                    'upstream_header=$upstream_header_time '
                    'request_id=$request_id '
                    'upstream=$upstream_addr';

# 慢请求变量（request_time > 1 秒时记录）
map $request_time $is_slow {
    ~^\d{1,}\.   1;  # 整数部分 >= 1（秒）→ 是慢请求
    default      "";
}

# 注意：这里的条件日志是"额外记录"，不是"替代"
server {
    access_log /var/log/nginx/access.log json_format buffer=64k flush=5s;
    access_log /var/log/nginx/slow.log slow_log if=$is_slow;
    # 慢请求同时写入两个日志（access.log + slow.log）
}
```

### 6.4 日志切割与 logrotate 集成

Nginx 不内置自动日志切割，需要配合系统的 `logrotate` 工具：

```ini
# /etc/logrotate.d/nginx
/var/log/nginx/*.log {
    daily               # 每天切割
    missingok           # 日志文件不存在不报错
    rotate 30           # 保留 30 天
    compress            # 旧日志 gzip 压缩
    delaycompress       # 延迟压缩（最新的旧日志不压缩，便于实时查看）
    notifempty          # 空文件不切割
    create 0640 nginx adm  # 新日志文件权限
    sharedscripts
    postrotate
        # 发送 SIGUSR1 信号，让 Nginx 重新打开日志文件
        # （Nginx 仍然指向旧文件描述符，发信号后切换到新文件）
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 $(cat /var/run/nginx.pid)
        fi
    endscript
}
```

**`kill -USR1` 的工作原理**：`logrotate` 先将 `access.log` 重命名为 `access.log.1`（mv 操作），然后创建新的空 `access.log`，最后向 Nginx Master 进程发送 `SIGUSR1` 信号。Master 收到信号后，所有 Worker 重新打开日志文件（`open("access.log")`），获得新文件的文件描述符，后续日志写入新文件。在 `SIGUSR1` 发出之前，所有日志仍写入旧文件（`access.log.1`），确保日志不丢失。

---

## 小结

Nginx 的日志体系是可观测性的基础，本文涵盖以下核心知识点：

- **`$request_time` vs `$upstream_response_time`**：前者是客户端感知的全程时延，后者是后端处理时延；差值反映了网络传输和客户端接收速度——两者混淆是误判问题根因的高频陷阱
- **`$upstream_addr`**：多后端场景下定位具体慢/错后端实例的关键变量；多值（逗号分隔）表示发生了 `proxy_next_upstream` 重试
- **缓冲写日志**：`buffer=64k flush=5s` 将 N 次磁盘写合并为 1 次，大幅降低系统调用开销；代价是 Worker 崩溃时最多丢失 `flush` 时间内的日志
- **`$request_id`**：Nginx 自动生成的 128 位随机 ID，通过 `proxy_set_header X-Request-Id $request_id` 传递给后端，配合 MDC 实现全链路追踪；从公网传入的 Request ID 需要安全过滤
- **`escape=json`**：JSON 格式日志的必配参数，防止特殊字符破坏 JSON 结构
- **条件日志**（`if=$var`）：对健康检查、静态资源等不记录日志，降低 I/O 压力；慢请求双写到专项日志文件便于专项分析
- **日志切割**：依赖 `logrotate` + `SIGUSR1` 信号，无损切割（不丢任何日志）

第 10 篇深入 Nginx 性能调优全攻略：`worker_processes`/`worker_connections`/`worker_cpu_affinity` 的最优配置推导、`sendfile`/`tcp_nopush`/`tcp_nodelay` 的协议层工作原理、`open_file_cache` 的 stat() 调用减少机制，以及系统级 `ulimit` 与 `net.core.somaxconn` 的配置关系。

---

## 参考资料

- [Nginx 官方文档：ngx_http_log_module](https://nginx.org/en/docs/http/ngx_http_log_module.html)
- [Nginx 变量完整列表](https://nginx.org/en/docs/varindex.html)
- [W3C Trace Context 标准（Request ID 规范）](https://www.w3.org/TR/trace-context/)


---

> **下一篇**：[[10 性能调优全攻略：worker 进程、连接数与内核参数]]
