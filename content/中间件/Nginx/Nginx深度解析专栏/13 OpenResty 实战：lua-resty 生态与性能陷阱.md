---
title: "OpenResty 实战：lua-resty 生态与性能陷阱"
date: 2026-02-28
tags: [OpenResty, lua-resty, LRU缓存, 性能陷阱, 全局变量, 阻塞调用, 正则编译, 插件开发, 实战]
aliases: []
---

# 13 OpenResty 实战：lua-resty 生态与性能陷阱

## 摘要

理解了 OpenResty 的架构原理（第 12 篇），接下来面对的是实战层面的挑战：`lua-resty-*` 生态有几十个库，如何选择和正确使用？共享内存 LRU 缓存的两级缓存模型（`lua-resty-lrucache` + `ngx.shared.DICT`）如何设计才能同时兼顾性能和正确性？为什么在 location 块中重复编译正则会导致严重的性能退化？全局变量在 OpenResty 中为何是反模式？本文从实际工程案例出发，系统梳理这些问题的根本原因和解决方案，同时覆盖一个完整的 OpenResty 插件开发规范模式，帮助工程师写出生产级质量的 OpenResty 代码。

---

## 第 1 章 lua-resty 生态全景

### 1.1 官方核心库

OpenResty 官方维护的 `lua-resty-*` 系列是生产中最可靠的选择，与 LuaJIT 的 JIT 编译深度协作：

| 库名 | 用途 | 特点 |
|-----|-----|-----|
| `lua-resty-core` | 重写 ngx_lua 核心 API（FFI 版本）| 必须加载，开启 JIT 优化 |
| `lua-resty-redis` | Redis 客户端 | cosocket 实现，连接池 |
| `lua-resty-mysql` | MySQL 客户端 | cosocket 实现，全协议支持 |
| `lua-resty-http` | HTTP 客户端 | cosocket 实现，支持 keepalive |
| `lua-resty-memcached` | Memcached 客户端 | cosocket 实现 |
| `lua-resty-lrucache` | 进程内 LRU 缓存 | 纯 Lua，零共享内存开销 |
| `lua-resty-string` | 字符串工具（base64/hex/SHA）| FFI 实现，性能极高 |
| `lua-resty-lock` | 基于共享内存的分布式锁 | 防缓存穿透 |
| `lua-resty-upstream-healthcheck` | 主动健康检查 | 定时探测后端 |

**`lua-resty-core` 为什么必须加载**：

原始的 `ngx_lua` 模块是纯 C 实现，其 Lua API（如 `ngx.re.match`、`ngx.encode_base64`）通过 Lua C API 调用，**不能被 LuaJIT 的 JIT 编译器优化**（JIT 无法内联 C 扩展调用）。

`lua-resty-core` 用 LuaJIT FFI 重写了这些 API，使其可以被 JIT 编译器内联优化，性能提升约 30-200%。在 OpenResty 1.13.6+ 中，`lua-resty-core` 默认自动加载；旧版本需要在 `init_by_lua` 中显式 `require "resty.core"`。

### 1.2 社区优质库

| 库名 | 用途 |
|-----|-----|
| `lua-resty-jwt` | JWT 生成与验证 |
| `lua-resty-hmac` | HMAC 签名 |
| `lua-resty-session` | Session 管理（支持 Redis/Cookie 存储）|
| `lua-resty-limit-traffic` | 更灵活的限流（基于 `ngx.shared.DICT`）|
| `lua-resty-balancer` | 一致性哈希、轮询等负载均衡算法 |
| `lua-resty-template` | 模板渲染引擎 |
| `lua-resty-kafka` | Kafka 客户端（cosocket 实现）|

---

## 第 2 章 两级缓存模型：从架构到实现

### 2.1 为什么需要两级缓存

OpenResty 常见的缓存需求：将后端数据（数据库查询结果、配置信息、外部 API 响应）缓存在 Nginx 层，避免每次请求都穿透到后端。

单独使用 `ngx.shared.DICT`（共享内存缓存）的问题：

```
每次读取操作：
  ngx.shared.DICT:get("key")
  →  获取共享内存的 slab_spinlock（自旋锁）
  →  在红黑树中查找 key（O(log n)）
  →  将值从共享内存复制到 Lua 栈（如果值是字符串，需要内存分配和拷贝）
  →  释放锁

问题：
  - 每次访问都需要加锁（多 Worker 竞争同一锁）
  - 字符串值每次都要从共享内存拷贝到 Lua 堆（内存分配）
  - 对于频繁读取的热点数据，锁竞争和内存分配开销显著
```

单独使用 `lua-resty-lrucache`（进程内缓存）的问题：

```
lua-resty-lrucache 是每个 Worker 进程独立的缓存
  Worker 1 有自己的 lrucache，Worker 2 有自己的 lrucache
  不同 Worker 的缓存互相隔离（不共享）

问题：
  缓存数据需要在每个 Worker 中独立维护
  某个 Worker 刷新了缓存（重新从 Redis 获取数据），其他 Worker 的缓存依然是旧数据
  4 个 Worker = 4 份独立缓存，内存占用是单级缓存的 4 倍
  且无法保证 Worker 间的缓存一致性
```

**两级缓存模型**：结合两者的优势：

```
Level 1（L1）：进程内 lua-resty-lrucache
  - 无锁、零拷贝（Lua 对象直接引用）
  - 极低延迟（纳秒级，只有 Lua table 查找）
  - 容量小（内存在 Worker 进程的 Lua 堆中）
  - Worker 间不共享（数据可能不一致）
  
Level 2（L2）：ngx.shared.DICT
  - 有锁，但 Worker 间共享
  - 容量大（独立的共享内存区）
  - 是 L1 缓存的数据来源（L1 miss → 查 L2）
```

**请求处理流程**：

```
请求到来：
  查 L1（进程内 lrucache）
  ├── L1 命中 → 直接使用（无锁，最快）
  └── L1 未命中 → 查 L2（ngx.shared.DICT）
      ├── L2 命中 → 将值写入 L1，使用
      └── L2 未命中 → 查后端（Redis/DB/API）
          └── 将结果写入 L2 和 L1，使用
```

### 2.2 完整实现：带防穿透的两级缓存

```lua
-- /etc/nginx/lua/two_level_cache.lua

local lrucache = require "resty.lrucache"
local lock = require "resty.lock"

-- L1：每个 Worker 独立的进程内 LRU 缓存
-- 创建在模块级别（只在 Worker 启动时创建一次，后续所有请求复用同一实例）
local L1_CACHE_SIZE = 1000  -- 最多缓存 1000 个 key
local l1_cache, err = lrucache.new(L1_CACHE_SIZE)
if not l1_cache then
    error("failed to create L1 cache: " .. (err or "unknown"))
end

local L1_TTL = 5      -- L1 缓存 5 秒（短 TTL，保证一定的新鲜度）
local L2_TTL = 60     -- L2 缓存 60 秒（长 TTL，避免频繁穿透）

local _M = {}

-- 从后端获取数据的函数（需要调用方提供）
-- loader 是一个 function(key) → value, err 的函数

function _M.get(key, loader)
    -- Step 1：查 L1
    local val = l1_cache:get(key)
    if val ~= nil then
        return val  -- L1 命中，直接返回（零锁、零拷贝）
    end

    -- Step 2：查 L2
    local shared_cache = ngx.shared.my_cache
    val = shared_cache:get(key)
    if val ~= nil then
        -- L2 命中：反序列化，写入 L1，返回
        local decoded = require("cjson").decode(val)
        l1_cache:set(key, decoded, L1_TTL)
        return decoded
    end

    -- Step 3：L1 L2 都未命中，需要从后端加载
    -- 使用分布式锁防止多个协程同时穿透后端（防击穿）
    local lock_obj = lock:new("lock_cache", {
        exptime = 10,   -- 锁最长持有 10 秒（防死锁）
        timeout = 5,    -- 等待锁的最长时间 5 秒
    })

    local elapsed, err = lock_obj:lock("loader:" .. key)
    if not elapsed then
        -- 获取锁失败（超时），降级：直接调用 loader 不加锁
        ngx.log(ngx.WARN, "failed to acquire cache lock: ", err)
        return loader(key)
    end

    -- 获得锁后，再次检查 L2（可能另一个协程刚刚写入）
    val = shared_cache:get(key)
    if val ~= nil then
        lock_obj:unlock()
        local decoded = require("cjson").decode(val)
        l1_cache:set(key, decoded, L1_TTL)
        return decoded
    end

    -- 真正需要从后端加载
    local data, load_err = loader(key)
    if not data then
        lock_obj:unlock()
        return nil, load_err
    end

    -- 写入 L2 和 L1
    local encoded = require("cjson").encode(data)
    local ok, err, forcible = shared_cache:set(key, encoded, L2_TTL)
    if not ok then
        ngx.log(ngx.WARN, "failed to write L2 cache: ", err)
    end
    l1_cache:set(key, data, L1_TTL)

    lock_obj:unlock()
    return data
end

return _M
```

使用示例：

```nginx
location /api/user {
    content_by_lua_block {
        local cache = require "two_level_cache"
        
        local user_id = ngx.var.arg_id
        local user, err = cache.get("user:" .. user_id, function(key)
            -- 从 Redis 加载用户数据
            local redis = require "resty.redis"
            local red = redis:new()
            red:connect("127.0.0.1", 6379)
            local data = red:hgetall("user:" .. user_id)
            red:set_keepalive(60000, 100)
            return data
        end)
        
        if not user then
            ngx.status = 404
            ngx.say('{"error":"user not found"}')
            return
        end
        
        ngx.header["Content-Type"] = "application/json"
        ngx.say(require("cjson").encode(user))
    }
}
```

> [!info] 核心概念：resty.lock 防缓存击穿
> 当 L2 缓存过期的瞬间，可能有大量并发请求同时发现缓存 miss，全部穿透到后端（缓存击穿）。`resty.lock` 基于 `ngx.shared.DICT` 的原子 `add` 操作实现**分布式锁**：第一个请求成功写入锁（`add` 成功），后续请求 `add` 失败（key 已存在），等待锁释放。锁持有者从后端加载数据后写入缓存，后续请求从缓存读取，避免了多次穿透。

---

## 第 3 章 五大性能陷阱深度解析

### 3.1 陷阱一：正则在 location 块中重复编译

这是 OpenResty 中**最常见、危害最大**的性能反模式：

```lua
-- 错误做法（每次请求都编译正则）
content_by_lua_block {
    local uri = ngx.var.request_uri
    
    -- 每次请求执行到这里时，ngx.re.match 会编译正则 "^/api/v([0-9]+)/"
    -- 编译正则需要 PCRE 库调用，约耗时 10-50 微秒
    -- 1000 QPS = 每秒 10-50ms 纯花在正则编译上
    local m, err = ngx.re.match(uri, "^/api/v([0-9]+)/")
    if m then
        local version = m[1]
        -- ...
    end
}
```

**原因分析**：`ngx.re.match` 的第三个参数 `options` 中包含 `"o"` 标志（compile once）可以缓存编译结果——**但前提是正则字面量是已知的（在编译期可以确定的）**。如果正则是动态生成的（含变量），或者忘记加 `"o"` 标志，每次调用都重新编译。

```lua
-- 正确做法一：使用 "o" 标志（推荐，利用 ngx.re 的编译缓存）
local m, err = ngx.re.match(uri, "^/api/v([0-9]+)/", "jo")
-- "j"：启用 JIT（如果 PCRE 支持）
-- "o"：编译一次（Cache the compiled regex，使用 PCRE study 缓存）

-- 正确做法二：在模块级别预编译（更推荐，完全避免重复编译）
-- 将此代码放在 location 块之外、模块的顶层
local api_version_re = ngx.re.compile("^/api/v([0-9]+)/", "jo")
-- api_version_re 是一个已编译的正则对象，模块加载时编译一次，永久缓存

-- 在请求处理中使用已编译的正则对象
content_by_lua_block {
    local re = require "my_module"  -- 包含预编译正则的模块
    local m, err = re.api_version_re:match(ngx.var.request_uri)
    -- 无编译开销！
}
```

**`ngx.re` 的编译缓存机制**：加了 `"o"` 标志后，`ngx.re` 模块会将编译结果缓存在当前进程的 Lua 注册表（`lua_State`）中，以正则字符串 + options 为 key。下次相同正则调用时，直接从注册表取编译结果，跳过 PCRE 编译步骤。

但注意：Lua 注册表是**进程级别**的，`ngx.re.match` 第一次在 Worker 1 中编译，Worker 2 的注册表中没有这个编译结果，Worker 2 仍需编译一次（但只需一次）。

### 3.2 陷阱二：全局变量的双重危害

Lua 的全局变量存储在全局表 `_G` 中，访问需要：
1. 在 `_G` 中查找（哈希表查找）
2. 可能触发 `__index` metamethod（如果 `_G` 设置了 metatable）

相比之下，局部变量直接存在 Lua 栈上，访问是 O(1) 的数组索引，比全局变量快约 3-5 倍。

**更大的危害**：全局变量可以在请求之间**污染状态**：

```lua
-- 危险代码：全局变量在 Worker 进程的所有请求间共享
counter = 0  -- 全局变量（没有 local 关键字）

content_by_lua_block {
    counter = counter + 1  -- 并发请求都在修改同一个全局变量！
    -- 在单线程 Worker 中，这不会有数据竞争（Lua 是单线程的）
    -- 但不同请求看到的 counter 值是累积的，不是隔离的
    -- 如果这里的意图是"请求级别的计数"，就是 bug
    ngx.say("request count: " .. counter)  -- 输出的是 Worker 启动以来的总数
}
```

```lua
-- 更危险：在请求处理中修改模块级别的状态
-- /etc/nginx/lua/auth_module.lua
local auth_module = {}
auth_module.last_user = nil  -- 模块级变量（Worker 进程内共享！）

function auth_module.process(user)
    auth_module.last_user = user  -- 在请求 A 中设置
    -- 如果这里有协程切换（cosocket 调用）...
    -- 请求 B 进来，auth_module.last_user 被改成 B 的用户
    -- 请求 A 恢复执行，读取 auth_module.last_user → 错误！读到了 B 的数据
    ngx.say("processed: " .. auth_module.last_user)  -- 输出 B 的用户！
end
```

**正确做法**：

```lua
-- 将请求级别的数据存储在 ngx.ctx（请求隔离）
content_by_lua_block {
    local counter = ngx.ctx.counter or 0
    ngx.ctx.counter = counter + 1
    ngx.say("request local count: " .. ngx.ctx.counter)
}

-- 或使用局部变量（最简单）
content_by_lua_block {
    local counter = 0  -- local 变量，在此 chunk 结束后释放
    counter = counter + 1
    -- ...
}

-- 模块中不应有可变的请求级别状态
-- 只有"配置"和"无状态函数"才放在模块级别
local _M = {
    _VERSION = "1.0",
    config = { ... }  -- 只读配置，可以模块级
}

function _M.process(user)  -- 函数是无状态的，只依赖参数
    local result = ...  -- 使用 local 变量存储请求级状态
    return result
end
```

### 3.3 陷阱三：阻塞调用污染事件循环

cosocket 实现了非阻塞的网络 I/O，但 OpenResty 的代码中仍然可能意外引入阻塞调用：

**阻塞场景一：使用标准 Lua I/O 库**

```lua
-- 危险：Lua 标准 io.open 是阻塞的文件系统调用
content_by_lua_block {
    local f = io.open("/etc/config/settings.json")  -- 阻塞！
    local content = f:read("*a")  -- 阻塞！
    f:close()
    -- 文件 I/O 阻塞期间，整个 Worker 无法处理任何请求
}

-- 正确：对于配置文件，在 init_by_lua 中一次性读取，存入全局变量
init_by_lua_block {
    local f = io.open("/etc/config/settings.json")
    if f then
        _G.settings = require("cjson").decode(f:read("*a"))
        f:close()
    end
}
-- 在请求处理中直接读取 _G.settings（内存访问，无阻塞）
```

**阻塞场景二：luasocket（标准 Lua socket 库）**

```lua
-- 危险：luasocket 是阻塞的 socket API
local socket = require "socket"  -- 标准 Lua socket，不是 ngx.socket
local conn = socket.connect("redis.host", 6379)  -- 阻塞连接！

-- 正确：始终使用 ngx.socket（cosocket）
local tcp = ngx.socket.tcp()
local ok, err = tcp:connect("redis.host", 6379)  -- 非阻塞
```

**阻塞场景三：CPU 密集型计算**

```lua
-- 危险：在请求处理中做大量计算（如复杂的加密运算、大文件哈希）
content_by_lua_block {
    local data = ngx.req.get_body_data()
    -- SHA-256 大文件哈希是 CPU 密集的，可能占用几十毫秒
    local hash = compute_sha256(data)  -- 阻塞事件循环！
}
```

对于 CPU 密集型任务，应使用 `ngx.thread.spawn` 启动轻量级线程，或将计算 offload 到后端服务。

**阻塞场景四：sleep**

```lua
-- 危险：os.time() 不阻塞，但 luasocket.sleep() 是阻塞的
require("socket").sleep(1)  -- 阻塞 Worker 1 秒！

-- 正确：使用 ngx.sleep（非阻塞，协程 yield）
ngx.sleep(1)  -- 协程挂起 1 秒，其他请求正常处理
```

### 3.4 陷阱四：table 频繁创建导致 GC 压力

Lua 的垃圾回收（GC）是增量式的，但在高 QPS 场景下，如果每次请求都创建大量临时 table，GC 开销会积累成明显的延迟毛刺（GC pause）：

```lua
-- 低效：每次请求创建临时 table
content_by_lua_block {
    local headers = {}  -- 创建临时 table
    headers["Content-Type"] = "application/json"
    headers["X-Request-Id"] = ngx.var.request_id
    -- 使用 headers
    -- 请求结束时，headers 成为垃圾，等待 GC 回收
}

-- 在 10000 QPS 时，每秒创建 10000 个临时 table，GC 压力显著
```

优化方式：

```lua
-- 优化一：复用预分配的 table（通过对象池）
-- 优化二：使用 table.clear() 清空 table 而非创建新的（Lua 5.2+ 或 LuaJIT）
-- 优化三：直接设置响应头，避免中间 table
content_by_lua_block {
    ngx.header["Content-Type"] = "application/json"
    ngx.header["X-Request-Id"] = ngx.var.request_id
    -- 直接操作 ngx.header，无中间 table
}
```

### 3.5 陷阱五：cjson 对 null 的处理

```lua
-- 陷阱：JSON null 被解码为 cjson.null（userdata），不是 nil
local cjson = require "cjson"
local data = cjson.decode('{"name": null}')

if data.name == nil then  -- 错误！data.name 是 cjson.null，不等于 nil
    print("name is missing")  -- 不会执行！
end

if data.name == cjson.null then  -- 正确
    print("name is explicitly null")
end

-- 或使用 cjson.safe（失败时返回 nil 而非抛出错误）
local cjson_safe = require "cjson.safe"
local ok, data = pcall(cjson.decode, json_str)
-- 或
local data, err = cjson_safe.decode(json_str)
```

---

## 第 4 章 插件开发规范模式

### 4.1 OpenResty 插件的标准结构

一个设计良好的 OpenResty 插件（可复用的 Lua 模块）应该遵循以下结构：

```lua
-- /etc/nginx/lua/plugins/jwt_auth.lua

-- 1. 模块元数据
local _M = {
    _VERSION = "1.0.0",
    _NAME = "jwt_auth",
}

-- 2. 依赖库（在模块顶层 require，利用 Lua 的模块缓存）
local jwt = require "resty.jwt"
local cjson = require "cjson.safe"

-- 3. 模块级常量和不可变配置（在 Worker 启动时确定，请求间共享只读数据）
local JWT_ALGORITHM = "HS256"
local PUBLIC_PATHS = {
    ["/health"] = true,
    ["/metrics"] = true,
}

-- 4. 预编译正则（模块加载时执行一次）
local BEARER_RE = ngx.re.compile("^Bearer (.+)$", "jo")

-- 5. 私有工具函数（local function，模块外不可访问）
local function extract_token(auth_header)
    if not auth_header then
        return nil, "missing Authorization header"
    end
    local m, err = BEARER_RE:match(auth_header)
    if not m then
        return nil, "invalid Authorization format"
    end
    return m[1]
end

local function verify_jwt(token, secret)
    local obj = jwt:verify(secret, token)
    if not obj.verified then
        return nil, obj.reason
    end
    return obj.payload
end

-- 6. 公共 API（插件的对外接口）
function _M.run(config)
    -- config 由外部传入（从 nginx.conf 读取的配置）
    local uri = ngx.var.uri
    
    -- 白名单检查
    if PUBLIC_PATHS[uri] then
        return  -- 放行
    end
    
    -- 提取 Token
    local auth_header = ngx.req.get_headers()["Authorization"]
    local token, err = extract_token(auth_header)
    if not token then
        ngx.status = 401
        ngx.header["Content-Type"] = "application/json"
        ngx.say(cjson.encode({ error = err }))
        ngx.exit(401)
        return
    end
    
    -- 验证 Token
    local payload, err = verify_jwt(token, config.jwt_secret)
    if not payload then
        ngx.status = 401
        ngx.header["Content-Type"] = "application/json"
        ngx.say(cjson.encode({ error = "invalid token: " .. err }))
        ngx.exit(401)
        return
    end
    
    -- 将用户信息写入请求上下文（供后续 Phase 使用）
    ngx.ctx.user_id = payload.sub
    ngx.ctx.user_role = payload.role
    ngx.req.set_header("X-User-Id", payload.sub)
end

return _M
```

### 4.2 在 nginx.conf 中使用插件

```nginx
http {
    # 配置：通过 Lua 变量或 nginx.conf 变量传入
    lua_shared_dict jwt_blacklist 1m;
    
    server {
        set $jwt_secret "my-secret-key-from-env";  # 实际生产中从环境变量读取
        
        location / {
            access_by_lua_block {
                local jwt_auth = require "plugins.jwt_auth"
                jwt_auth.run({
                    jwt_secret = ngx.var.jwt_secret,
                })
            }
            proxy_pass http://backend;
        }
    }
}
```

### 4.3 插件的错误处理规范

OpenResty 插件中的错误处理有两种机制：

**机制一：返回值错误（Lua 惯用法）**

```lua
-- Lua 惯用法：返回 nil + error_string
local function do_something()
    local ok, err = some_operation()
    if not ok then
        return nil, "operation failed: " .. err
    end
    return result
end

-- 调用方处理
local val, err = do_something()
if not val then
    ngx.log(ngx.ERR, "error: ", err)
    return ngx.exit(500)
end
```

**机制二：pcall 保护异常**

```lua
-- 对于可能 panic 的操作（如解码畸形 JSON），使用 pcall 保护
local ok, result = pcall(cjson.decode, json_str)
if not ok then
    ngx.log(ngx.ERR, "JSON decode error: ", result)
    ngx.exit(400)
    return
end
```

> [!warning] 生产避坑：ngx.exit() 不会停止后续代码执行
> `ngx.exit(status)` 只是**设置终止标志**，不会立即终止 Lua 代码的执行（不像 PHP 的 `die()` 或 `exit()`）。调用 `ngx.exit()` 后必须显式 `return`：
>
> ```lua
> -- 错误：ngx.exit 后没有 return，后续代码仍然执行！
> if not authed then
>     ngx.exit(401)
>     -- 这里的代码仍然执行！
>     proxy_pass_to_backend()  -- 越权访问！
> end
>
> -- 正确：ngx.exit 后立即 return
> if not authed then
>     ngx.exit(401)
>     return  -- 终止当前函数
> end
> ```

---

## 第 5 章 实战案例：动态路由网关

### 5.1 基于请求内容的动态 upstream 选择

```nginx
# nginx.conf
upstream api_v1 { server 10.0.0.1:8080; }
upstream api_v2 { server 10.0.0.2:8080; }
upstream api_canary { server 10.0.0.3:8080; }

server {
    location / {
        # 1. access 阶段：从 Redis 读取路由规则（带两级缓存）
        # 2. 设置 ngx.ctx.upstream_name
        # 3. content/proxy 阶段：使用动态 upstream
        
        access_by_lua_block {
            local router = require "dynamic_router"
            router.route()  -- 在 ngx.ctx 中设置 upstream_name
        }
        
        proxy_pass http://$upstream_name;
        # $upstream_name 由 Lua 代码通过 ngx.var.upstream_name 设置
    }
}
```

```lua
-- /etc/nginx/lua/dynamic_router.lua
local cache = require "two_level_cache"
local cjson = require "cjson.safe"

local _M = {}

function _M.route()
    local user_id = ngx.ctx.user_id  -- 由 jwt_auth 插件设置
    local uri = ngx.var.uri
    
    -- 从缓存获取路由规则
    local rules, err = cache.get("routing_rules", function(key)
        local redis = require "resty.redis"
        local red = redis:new()
        red:connect("127.0.0.1", 6379)
        local data = red:get("routing_rules")
        red:set_keepalive(60000, 100)
        if data and data ~= ngx.null then
            return cjson.decode(data)
        end
        return {}
    end)
    
    if not rules then
        ngx.var.upstream_name = "api_v1"  -- 降级到 v1
        return
    end
    
    -- 灰度逻辑：按用户 ID 哈希选择 canary
    if rules.canary_enabled then
        local user_hash = ngx.crc32_short(user_id or "anonymous") % 100
        if user_hash < (rules.canary_percentage or 5) then
            ngx.var.upstream_name = "api_canary"
            ngx.log(ngx.INFO, "user ", user_id, " routed to canary")
            return
        end
    end
    
    -- 按 API 版本路由
    local m = ngx.re.match(uri, "^/api/v([12])/", "jo")
    if m then
        ngx.var.upstream_name = "api_v" .. m[1]
    else
        ngx.var.upstream_name = "api_v1"
    end
end

return _M
```

---

## 小结

OpenResty 实战的关键是避开常见陷阱，并遵循正确的编程模式：

**两级缓存模型**：
- L1（`lrucache`，进程内）：无锁、零拷贝，TTL 短（5-30s），容量小
- L2（`ngx.shared.DICT`，共享内存）：有锁但跨 Worker 共享，TTL 长（60-600s），容量大
- `resty.lock` 防击穿：单次穿透后端，结果广播给所有等待的协程

**五大性能陷阱**：
1. **正则重复编译**：始终加 `"o"` 标志或在模块级预编译，避免每次请求重新 PCRE 编译
2. **全局变量**：请求级状态存 `ngx.ctx`，Worker 级不可变配置才用模块级变量
3. **阻塞调用**：禁用 `io.open`（请求中）、`luasocket`、`os.sleep`，统一使用 cosocket 和 `ngx.sleep`
4. **table 频繁创建**：直接操作 `ngx.header` 而非中间 table，高频路径避免不必要的内存分配
5. **cjson.null 陷阱**：JSON null ≠ Lua nil，用 `== cjson.null` 判断，用 `cjson.safe` 处理解析错误

**插件规范**：
- 依赖库在模块顶层 `require`（利用 Lua 模块缓存）
- 正则在模块顶层预编译
- 公共 API 接受 `config` 参数（避免硬编码）
- `ngx.exit()` 后必须 `return`（exit 不会停止代码执行）

第 14 篇深入 APISIX 架构：etcd 作为配置中心的事件推送机制（watch-and-sync 模型），插件执行的优先级体系，路由匹配引擎（radixtree），以及与 OpenResty 的职责分工。

---

## 参考资料

- [lua-resty-lrucache GitHub](https://github.com/openresty/lua-resty-lrucache)
- [lua-resty-lock GitHub](https://github.com/openresty/lua-resty-lock)
- [OpenResty 编程规范（官方博客）](https://openresty.org/en/coding-style-guide.html)
- [lua-nginx-module 最佳实践](https://github.com/openresty/lua-nginx-module#lua-coroutine-yielding-resuming)


---

> **下一篇**：[[14 APISIX 架构：etcd 配置中心与插件体系]]

---

> [!note] 思考题
> 1. Envoy 的 xDS 动态配置 vs Nginx 的文件 + reload：在配置每分钟变更数次的场景中，Envoy 无需 reload 的优势有多大？Nginx 的 reload 在什么频率下开始产生可感知的性能影响（如连接断开、内存峰值）？
> 2. Envoy 原生支持分布式追踪（自动注入 trace ID）、Prometheus 指标和结构化访问日志。Nginx 需要第三方模块。在一个需要全链路可观测性的微服务架构中，Envoy 的原生支持减少了多少集成工作量？
> 3. 基准测试中 Nginx 的原始吞吐量通常略高于 Envoy。但 Envoy 的 Filter Chain 提供了更灵活的请求处理管道。在'极致性能'和'功能丰富度'之间如何选择？在 99% 的场景中，两者的性能差异是否可以忽略？
