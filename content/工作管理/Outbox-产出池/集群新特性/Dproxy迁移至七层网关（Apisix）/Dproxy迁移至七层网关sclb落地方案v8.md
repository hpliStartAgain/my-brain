---
type: solution
status: ready
author: 小克
date: 2026-04-20
domain: 集群新特性
tags: [Dproxy, SCLB, Nginx, Knox, Timeline, Flink, Tez, JHS]
---

# Dproxy 迁移至七层网关（SCLB）落地方案 v8

> **版本**: v8.1（补充插件绑定优先级 + 对齐实际创建的插件/路由命名）
> **日期**: 2026-04-21
> **负责人**: 李浩鹏
> **对外域名**: `dproxy.venus.sohurdc.com`（DNS 最终切到 SCLB VIP `10.18.102.127`）
> **Knox HA 地址**: `knox-ha.venus.sohurdc.com:8443`（已验证 HA 可用）
> **与 v7 的关键差异**：① 合并 yarnui/sparkhistory 两条 block 为一条 `r-knox-block`；② 补充 `plg-strip-ingress-prefix` 映射中的 `/jhs` 前缀；③ 新增 `r-jhs-pass` 代理 JHS（`yarn.log.server.url`）；④ 所有 Knox 回源地址统一为 Knox HA 域名
> **v8.1 修订说明**：① 补充同阶段多插件绑定优先级（rewrite 阶段 strip-prefix=110 > append-user=100）；② 对齐实际插件名（加 `-knox-` 前缀）；③ 记录已确认的路由/服务组命名差异

---

## 一、原 nginx 路由精简分析

### 1.1 可合并/简化项

| 原 nginx 写法 | 精简结论 | 理由 |
|---|---|---|
| `8089` 中 4 条显式 pass location（`sparkhistory/`、`containerlogs`、`jobhistory/joblogs`、`jobhistory/static`）| **全部合并进 catch-all** `r-knox-pass` | 行为完全一致：加 Authorization 头后回源 Knox，catch-all 已覆盖 |
| `8089` 中两条 block route（`r-knox-block-yarnui` + `r-knox-block-sparkhistory-api`）| **合并为 1 条** `r-knox-block` | 同为 403 + 同一服务组，路径列表合并即可 |
| `8089` 中 6 条 TEZ_DAG_ID/HIVE_QUERY_ID limit=11 拦截（venus / offline-ats1 / offline-ats2 各 2 条）| **合并为 1 条** `r-knox-timeline-guard`（6 个 path） | 逻辑完全一样，`plg-block-limit-11` 复用 |
| `8091` upstream `rm-knox1` 与 `rm-knox` | **共用同一** `sg-knox-ha` | 两者原本都指向 `dsrv014022:8443`，Knox HA 后统一用 `knox-ha` |
| `8094` 中 3 条显式 pass location（`sparkhistory/`、`yarn/`、`jobhistory/`）| **合并进 catch-all** `r-rt-knox-pass` | 同为回源 Knox + Auth，catch-all 覆盖；高优先级 block 先拦截危险路径 |

### 1.2 新增项

| 新需求 | 方案 |
|---|---|
| `yarn.log.server.url` 代理 JHS `dnn014018:19888` | 新增 `sg-jhs` + `r-jhs-pass`，前缀 `/jhs`，配置项改为 `http://dproxy.venus.sohurdc.com/jhs/jobhistory/logs` |

### 1.3 一个已知遗留问题（需上线后抓包确认）

原 nginx `timeline_tezui.conf` 的 Origin 拦截逻辑：
```
if limit=11 AND Origin == "http://dnn014012.venus.sohurdc.com:8823"  →  403
```
迁移后 TezUI 从 `dproxy.venus.sohurdc.com/tez-ui` 加载，浏览器 Origin 会变成 `http://dproxy.venus.sohurdc.com`。  
插件 `plg-timeline-origin-limit-11` 的字符串比对需要在流量切换后**抓包确认实际 Origin 值**，再修正 Lua 代码。此问题不影响 95% 场景，优先级低。

---

## 二、服务组清单（最终版）

| 服务组名 | 后端地址 | 用途 |
|---|---|---|
| `sg-knox-ha` | `knox-ha.venus.sohurdc.com:8443` | 所有 Knox 回源（含 8089/8091/8094/8095） |
| `sg-timeline-online` | `h3timeline.venus.sohurdc.com:8188` | 在线 Timeline（替代 8090） |
| `sg-timeline-offline1` | `h3offline.timeline.venus.sohurdc.com:8188` | 离线 Timeline1（替代 8990） |
| `sg-timeline-offline2` | `h3offline.timeline.venus.sohurdc.com:18188` | 离线 Timeline2（替代 18990） |
| `sg-flink-hs-offline` | `dnn014013.venus.sohurdc.com:9999` | 离线 Flink HistoryServer（替代 8092） |
| `sg-flink-hs-realtime` | `10.18.15.108:8083` | 实时 Flink HistoryServer（替代 8093） |
| `sg-tez-ui-ws` | `dnn014012.venus.sohurdc.com:8822` | TezUI WebSocket 回源 |
| `sg-dproxy-8823-static` | `10.18.14.11:8823` | TezUI 静态文件（仍由原 nginx 8823 服务，切流前不动） |
| `sg-jhs` | `dnn014018.venus.sohurdc.com:19888` | **新增**：Job History Server（`yarn.log.server.url`） |
| `sg-block-placeholder` | `knox-ha.venus.sohurdc.com:8443` | 专供 plg-return-403 使用的占位服务组（流量不会真正到达） |

---

## 三、插件清单（最终版，含完整 Lua 代码）

### 3.1 `plg-return-403`

执行阶段：`rewrite`

```lua
local _M = {}

function _M.rewrite(conf, ctx)
    return ngx.exit(403)
end

return _M
```

### 3.2 `plg-append-user-name-yarn`

执行阶段：`rewrite`

> 所有 Timeline 回源路由都挂此插件，确保 ATS 不拒绝无身份请求

> [!WARNING] **v8.2 修复**：`ngx.req.set_uri_args()` 的修改在 SCLB proxy_pass 用 `$upstream_uri` 代理时不会自动拼接。
> 须在本插件（优先级 100）内手动将 query string 追加到 `ctx.var.upstream_uri`（由 strip-prefix 于优先级 110 写入，仅含路径）。

```lua
local _M = {}

function _M.rewrite(conf, ctx)
    -- 步骤1：确保 args 中有 user.name=yarn（兼容不走 upstream_uri 的场景）
    local args = ngx.req.get_uri_args()
    if args["user.name"] == nil or args["user.name"] == "" then
        args["user.name"] = "yarn"
        ngx.req.set_uri_args(args)
    end

    -- 步骤2：将完整 query string 追加到 upstream_uri
    -- SCLB 的 proxy_pass 使用 $upstream_uri，不自动拼接 $args
    -- strip-prefix（优先级 110）已先于本插件（100）写入 upstream_uri（纯路径，无 query）
    local upstream_uri = ctx.var.upstream_uri
    if upstream_uri and upstream_uri ~= "" then
        -- 用 get_uri_args() 而非 ngx.var.args，确保读到 set_uri_args() 的最新修改
        local new_args = ngx.encode_args(ngx.req.get_uri_args())
        if new_args and new_args ~= "" then
            ctx.var.upstream_uri = upstream_uri .. "?" .. new_args
        end
    end
end

return _M
```

### 3.3 `plg-block-limit-11`

执行阶段：`access`

> 防止一次拉取过多 TEZ 历史数据压垮 ATS

```lua
local _M = {}

function _M.access(conf, ctx)
    if ngx.var.arg_limit == "11" then
        return ngx.exit(403)
    end
end

return _M
```

### 3.4 `plg-timeline-origin-limit-11`

执行阶段：`access`

> ⚠️ 仅用于 `r-timeline-ws-guard`。Origin 值待上线后抓包核实，如有变化需同步更新此处字符串

```lua
local _M = {}

function _M.access(conf, ctx)
    local limit = ngx.var.arg_limit
    local origin = ngx.var.http_origin

    if limit == "11" and origin ~= nil then
        -- 上线后如果 TezUI 已从 SCLB 访问，origin 会变成 http://dproxy.venus.sohurdc.com
        -- 届时把下行字符串改为对应新 origin
        if string.lower(origin) == "http://dnn014012.venus.sohurdc.com:8823" then
            return ngx.exit(403)
        end
    end
end

return _M
```

### 3.5 `plg-sub-filter-timeline-header`

执行阶段：`header_filter`

> 清除 Content-Length，为响应体替换做准备

```lua
local _M = {}

function _M.header_filter(conf, ctx)
    ngx.header["Content-Length"] = nil
end

return _M
```

### 3.6 `plg-sub-filter-8090-body`

执行阶段：`body_filter`

> 修复 ATS 响应 HTML 中两类路径问题，防止浏览器跳转到无法访问的内网地址：
> 1. **根相对路径**：`src="/"` / `href="/"` → 补全 `/timeline/` 前缀
> 2. **dproxy:8090 绝对 URL**：容器日志链接中含旧端口号，重写为不带端口的新路径

> **注意**：SCLB 平台不支持 Lua 插件代码中的非 ASCII 字符（含中文注释），否则会报「插件加载超时」。所有注释必须使用 ASCII 英文。

```lua
function _M.body_filter(conf, ctx)
    local chunk = ngx.arg[1]
    local eof = ngx.arg[2]

    ctx.resp_buffer = ctx.resp_buffer or ""

    if chunk ~= nil and chunk ~= "" then
        ctx.resp_buffer = ctx.resp_buffer .. chunk
        ngx.arg[1] = nil
    end

    if eof then
        local body = ctx.resp_buffer
        -- fix root-relative src/href paths
        body = body:gsub('(src=")/', '%1/timeline/')
        body = body:gsub('(href=")/', '%1/timeline/')
        -- fix dproxy:8090 absolute URLs
        body = body:gsub(
            'dproxy%.venus%.sohurdc%.com:8090/applicationhistory/',
            'dproxy.venus.sohurdc.com/timeline/applicationhistory/'
        )
        ngx.arg[1] = body
    end
end

return _M
```

### 3.7 `plg-strip-ingress-prefix`

执行阶段：`rewrite`

> **最关键插件**：剥离入口前缀后写入 `ctx.var.upstream_uri`，确保 Knox 收到正确路径
>
> 必须用 `ctx.var.upstream_uri`，**不能**用 `ngx.req.set_uri()`

```lua
local _M = {}

-- 顺序重要：长前缀必须先于其前缀子串
local mappings = {
    { prefix = "/offline/timeline2", target = "" },
    { prefix = "/offline/timeline",  target = "" },
    { prefix = "/realtime/flink-hs", target = "" },
    { prefix = "/realtime/knox",     target = "" },
    { prefix = "/realtime/logs",     target = "" },
    { prefix = "/knox-lite",         target = "" },
    { prefix = "/flink-hs",          target = "" },
    { prefix = "/jhs",               target = "" },   -- 新增：JHS 代理
    { prefix = "/timeline",          target = "" },
    { prefix = "/tez-ui/ws",         target = "/ws" }, -- ws 子路径特殊映射
    { prefix = "/tez-ui",            target = "" },
    { prefix = "/knox",              target = "" },
}

local function normalize(target, suffix)
    local new_uri = target .. suffix
    if new_uri == "" then return "/" end
    if string.sub(new_uri, 1, 1) ~= "/" then return "/" .. new_uri end
    return new_uri
end

function _M.rewrite(conf, ctx)
    local uri = ngx.var.uri

    for _, item in ipairs(mappings) do
        local prefix = item.prefix
        local target = item.target

        -- 精确匹配（无尾部斜杠）
        if uri == prefix then
            ctx.var.upstream_uri = normalize(target, "")
            return
        end

        -- 前缀匹配（带尾部斜杠及后续路径）
        local full = prefix .. "/"
        if string.sub(uri, 1, #full) == full then
            local suffix = string.sub(uri, #prefix + 1)
            ctx.var.upstream_uri = normalize(target, suffix)
            return
        end
    end
end

return _M
```

---

## 四、路由矩阵与创建步骤

> **路径规则**：每条需要匹配子路径的路由必须同时写两个 path：
> - `/xxx`（精确，处理无尾部斜杠的访问）
> - `/xxx/*`（通配，处理子路径）
>
> **路由优先级**：数字越大越优先。block/guard 路由用 `1000` 或 `900`，pass 路由用 `100`。

> [!WARNING] 插件绑定优先级（同阶段多插件必须区分）
> SCLB 要求**同一阶段内的插件绑定优先级不得重复**，且数字越大越先执行。
>
> **rewrite 阶段有两个插件时**（仅适用于 Timeline 类路由）：
> 
> | 插件 | 绑定优先级 | 原因 |
> |------|-----------|------|
> | `plg-knox-strip-ingress-prefix` | **110** | 先剥离路径前缀，写入 `ctx.var.upstream_uri` |
> | `plg-append-user-name-yarn` | **100** | 后追加 `user.name` 查询参数，依赖 URI 已修正 |
>
> 其余路由 rewrite 阶段仅有单个插件，使用默认 `100` 即可。

> [!INFO] 实际创建的插件/路由命名与方案差异说明（2026-04-21 核对）
> 平台创建时均加了 `-knox-` 前缀，功能完全等价：
> 
> | 方案名 | 实际名 |
> |--------|--------|
> | `plg-strip-ingress-prefix` | `plg-knox-strip-ingress-prefix` |
> | `plg-block-limit-11` | `plg-knox-block-limit-11` |
> | `plg-return-403` | `plg-knox-return-403` |
> | `plg-timeline-origin-limit-11` | `plg-block-limit-11-origin` |
> | `plg-sub-filter-timeline-header` | `plg-sub-filter-8090-header` |
> | `plg-sub-filter-timeline-body` | `plg-sub-filter-8090-body` |
>
> 已创建路由命名差异（功能一致）：
> 
> | 方案名 | 实际名 |
> |--------|--------|
> | `r-knox-block` | `r-8089-block` |
> | `r-knox-pass` | `r-knox-fallback` |

---

### Step 1：主 Knox 入口（替代原 8089）

#### 1-A `r-knox-block`

> 合并 v7 中的 `r-knox-block-yarnui` + `r-knox-block-sparkhistory-api`，减少 1 条路由

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/knox/gateway/yarnui/yarn`<br>`/knox/gateway/yarnui/yarn/`<br>`/knox/gateway/yarnui/yarn/cluster/apps*`<br>`/knox/gateway/yarnui/yarn/cluster/scheduler*`<br>`/knox/gateway/yarnui/yarn/jmx*`<br>`/knox/gateway/yarnui/yarn/logs*`<br>`/knox/gateway/yarnui/yarn/conf*`<br>`/knox/gateway/yarnui/yarn/stacks*`<br>`/knox/gateway/venus/sparkhistory/api/v1/applications`<br>`/knox/gateway/venus/sparkhistory/history` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |
| 关闭路径改写 | 是 |

#### 1-B `r-knox-timeline-guard`

> 原 nginx `8089` 中 6 条 TEZ/HIVE limit=11 拦截，合并为 1 条

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/knox/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID`<br>`/knox/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID`<br>`/knox/gateway/offline-ats1/tez/ws/v1/timeline/TEZ_DAG_ID`<br>`/knox/gateway/offline-ats1/tez/ws/v1/timeline/HIVE_QUERY_ID`<br>`/knox/gateway/offline-ats2/tez/ws/v1/timeline/TEZ_DAG_ID`<br>`/knox/gateway/offline-ats2/tez/ws/v1/timeline/HIVE_QUERY_ID` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix`、`plg-block-limit-11` |
| 关闭路径改写 | 是 |

> 注意：limit=11 不满足时，请求正常回源 Knox。limit=11 时直接 403，不到达 Knox。

#### 1-C `r-knox-pass`

> catch-all，兜底所有未被 block/guard 拦截的 Knox 请求

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/knox`<br>`/knox/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

---

### Step 2：Knox Lite（替代原 8091）

> 与 8089 相比，8091 只有 2 条 TEZ guard（仅 venus 拓扑，无 offline-ats）+ catch-all，无 yarnui/sparkhistory 黑名单

#### 2-A `r-knox-lite-timeline-guard`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/knox-lite/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID`<br>`/knox-lite/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix`、`plg-block-limit-11` |
| 关闭路径改写 | 是 |

#### 2-B `r-knox-lite-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/knox-lite`<br>`/knox-lite/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

---

### Step 3：在线 Timeline（替代原 8090）

> 原 `8090` 有两层逻辑：  
> ① `timeline_tezui.conf`（Origin+limit=11 联合拦截）优先级更高  
> ② 普通 `/`（sub_filter + user.name 补全）

#### 3-A `r-timeline-ws-guard`

> 对应 `timeline_tezui.conf` 的 TEZ_DAG_ID / HIVE_QUERY_ID 拦截

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/timeline/ws/v1/timeline/TEZ_DAG_ID`<br>`/timeline/ws/v1/timeline/HIVE_QUERY_ID` |
| 服务组 | `sg-timeline-online` |
| 请求头改写 | `Accept-Encoding: identity` |
| 插件（含绑定优先级） | `plg-knox-strip-ingress-prefix`（rewrite/110）<br>`plg-append-user-name-yarn`（rewrite/100）<br>`plg-block-limit-11-origin`（access/110）<br>`plg-sub-filter-8090-header`（header_filter/100）<br>`plg-sub-filter-8090-body`（body_filter/100） |
| 关闭路径改写 | 是 |

> ✅ **已修复（部署核查结果）**：`r-timeline-ws-guard` 的 `plg-knox-strip-ingress-prefix` 实际绑定优先级已为 **110**，无需再次修改。

> ⚠️ **v8.2 待修复**：`plg-append-user-name-yarn` 插件代码需更新（见 §3.2）——当前实现通过 `ngx.req.set_uri_args()` 修改 args，但 SCLB proxy_pass 以 `$upstream_uri` 代理时不自动拼接 `$args`，导致 ATS 收不到 `user.name=yarn` 而返回 401。更新插件后所有 Timeline 路由（online + offline）一次性修复。

#### 3-B `r-timeline-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/timeline`<br>`/timeline/*` |
| 服务组 | `sg-timeline-online` |
| 请求头改写 | `Accept-Encoding: identity` |
| 插件（含绑定优先级） | `plg-knox-strip-ingress-prefix`（rewrite/110）<br>`plg-append-user-name-yarn`（rewrite/100）<br>`plg-sub-filter-8090-header`（header_filter/100）<br>`plg-sub-filter-8090-body`（body_filter/100） |
| 关闭路径改写 | 是 |

> `Accept-Encoding: identity` 必填，否则 gzip 压缩的响应体无法被 body_filter 插件做字符串替换。

---

### Step 4：离线 Timeline（替代原 8990 / 18990）

> 两台离线 ATS，仅需 user.name 补全，无 sub_filter，无 Origin 拦截

#### 4-A `r-offline-timeline-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/offline/timeline`<br>`/offline/timeline/*` |
| 服务组 | `sg-timeline-offline1` |
| 插件（含绑定优先级） | `plg-knox-strip-ingress-prefix`（rewrite/110）<br>`plg-append-user-name-yarn`（rewrite/100） |
| 关闭路径改写 | 是 |

#### 4-B `r-offline-timeline2-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/offline/timeline2`<br>`/offline/timeline2/*` |
| 服务组 | `sg-timeline-offline2` |
| 插件（含绑定优先级） | `plg-knox-strip-ingress-prefix`（rewrite/110）<br>`plg-append-user-name-yarn`（rewrite/100） |
| 关闭路径改写 | 是 |

---

### Step 5：Flink HistoryServer（替代原 8092 / 8093）

#### 5-A `r-flink-hs-block-overview`（离线）

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/flink-hs/jobs/overview` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### 5-B `r-flink-hs-pass`（离线）

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/flink-hs`<br>`/flink-hs/*` |
| 服务组 | `sg-flink-hs-offline` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

#### 5-C `r-rt-flink-hs-block-overview`（实时）

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/realtime/flink-hs/jobs/overview` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### 5-D `r-rt-flink-hs-pass`（实时）

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/flink-hs`<br>`/realtime/flink-hs/*` |
| 服务组 | `sg-flink-hs-realtime` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

---

### Step 6：Realtime Knox（替代原 8094）

> 原 nginx 枚举了大量 block 路径 + 少量 pass 路径（sparkhistory/、yarn/、jobhistory/）。
> SCLB 侧：高优先级 block 先拦，catch-all 兜底放行，等效原行为。

#### 6-A `r-rt-knox-block`

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/realtime/knox/gateway/realtime/sparkhistory`<br>`/realtime/knox/gateway/realtime/sparkhistory/history`<br>`/realtime/knox/gateway/realtime/sparkhistory/api/v1/applications`<br>`/realtime/knox/gateway/realtime/yarn/cluster`<br>`/realtime/knox/gateway/realtime/yarn/conf`<br>`/realtime/knox/gateway/realtime/yarn/logs`<br>`/realtime/knox/gateway/realtime/yarn/stacks`<br>`/realtime/knox/gateway/realtime/yarn/jmx`<br>`/realtime/knox/gateway/realtime/yarn/cluster/apps*`<br>`/realtime/knox/gateway/realtime/yarn/cluster/scheduler*`<br>`/realtime/knox/gateway/realtime/yarn/cluster/cluster*`<br>`/realtime/knox/gateway/realtime/yarn/cluster/nodes*`<br>`/realtime/knox/gateway/realtime/yarn/cluster/nodelabels*`<br>`/realtime/knox/gateway/realtime/yarn/nodemanager/node/node*`<br>`/realtime/knox/gateway/realtime/yarn/nodemanager/node/allApplications*`<br>`/realtime/knox/gateway/realtime/yarn/nodemanager/node/allContainers*` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### 6-B `r-rt-knox-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/knox`<br>`/realtime/knox/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

---

### Step 7：Realtime 日志白名单（替代原 8095）

> 原 8095 是**默认拒绝 + 白名单放行**，逻辑与其他 Knox 路由相反。
> SCLB 侧：高优先级白名单先放行，低优先级 deny 兜底 403。

#### 7-A `r-rt-logs-whitelist`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/realtime/logs/gateway/realtime/yarn/proxy/application_*`<br>`/realtime/logs/gateway/realtime/yarn/cluster/app/application_*`<br>`/realtime/logs/gateway/realtime/yarn/nodemanager/node/containerlogs/*`<br>`/realtime/logs/gateway/realtime/yarn/static/*`<br>`/realtime/logs/gateway/realtime/jobhistory/*`<br>`/realtime/logs/gateway/realtime/yarn/cluster/appattempt/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

#### 7-B `r-rt-logs-deny`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/logs`<br>`/realtime/logs/*` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

---

### Step 8：Tez UI（替代原 8823 + 8824）

> 静态文件仍由原 nginx 8823 提供（`sg-dproxy-8823-static` 指回原机 8823）。
> WebSocket (`/ws`) 路由到 `dnn014012:8822` + Knox Auth。
> 不再保留 `/tez-ui/` 返回 403 的历史行为（8824 的遗留逻辑，已无意义）。

#### 8-A `r-tez-ui-ws`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/tez-ui/ws`<br>`/tez-ui/ws/*` |
| 服务组 | `sg-tez-ui-ws` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

#### 8-B `r-tez-ui-static`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/tez-ui`<br>`/tez-ui/*` |
| 服务组 | `sg-dproxy-8823-static` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

---

### Step 9：JHS 代理（新增，替代 yarn.log.server.url 直连）

> **背景**：`yarn.log.server.url = http://dnn014018.venus.sohurdc.com:19888/jobhistory/logs`
> 目标：用户访问日志页面时不直接暴露内网 IP/端口，统一走 SCLB。
>
> **配置变更**：Ambari 中将 `yarn.log.server.url` 修改为：
> ```
> http://dproxy.venus.sohurdc.com/jhs/jobhistory/logs
> ```

#### 9-A `r-jhs-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/jhs`<br>`/jhs/*` |
| 服务组 | `sg-jhs` |
| 插件 | `plg-strip-ingress-prefix` |
| 关闭路径改写 | 是 |

> JHS 是普通 HTTP 服务，无需 Knox Auth 头。直接透传即可。

---

## 五、路由汇总（21 条，按创建顺序）

| 序号 | 路由名 | 优先级 | 替代原端口 | 核心插件 |
|---|---|---|---|---|
| 1 | `r-knox-block` | 1000 | 8089 | plg-return-403 |
| 2 | `r-knox-timeline-guard` | 900 | 8089 | plg-strip + plg-block-limit-11 |
| 3 | `r-knox-pass` | 100 | 8089 | plg-strip |
| 4 | `r-knox-lite-timeline-guard` | 900 | 8091 | plg-strip + plg-block-limit-11 |
| 5 | `r-knox-lite-pass` | 100 | 8091 | plg-strip |
| 6 | `r-timeline-ws-guard` | 900 | 8090 | plg-strip + plg-append + plg-origin-limit-11 + plg-sub-filter |
| 7 | `r-timeline-pass` | 100 | 8090 | plg-strip + plg-append + plg-sub-filter |
| 8 | `r-offline-timeline-pass` | 100 | 8990 | plg-strip + plg-append |
| 9 | `r-offline-timeline2-pass` | 100 | 18990 | plg-strip + plg-append |
| 10 | `r-flink-hs-block-overview` | 1000 | 8092 | plg-return-403 |
| 11 | `r-flink-hs-pass` | 100 | 8092 | plg-strip |
| 12 | `r-rt-flink-hs-block-overview` | 1000 | 8093 | plg-return-403 |
| 13 | `r-rt-flink-hs-pass` | 100 | 8093 | plg-strip |
| 14 | `r-rt-knox-block` | 1000 | 8094 | plg-return-403 |
| 15 | `r-rt-knox-pass` | 100 | 8094 | plg-strip |
| 16 | `r-rt-logs-whitelist` | 900 | 8095 | plg-strip |
| 17 | `r-rt-logs-deny` | 100 | 8095 | plg-return-403 |
| 18 | `r-tez-ui-ws` | 900 | 8823 | plg-strip |
| 19 | `r-tez-ui-static` | 100 | 8823/8824 | plg-strip |
| 20 | `r-jhs-pass` | 100 | 新增 | plg-strip |

> 合计 20 条（v7 有 20 条 + 需额外新增 1 条 JHS = 21 条；本方案通过合并 2 条 block 为 1 条，抵消了 JHS 新增，净路由数等于 v7）

---

## 六、入口 URL 对照表

| 原访问方式（端口语义）| 迁移后访问方式（路径语义）| 命中路由 |
|---|---|---|
| `http://dproxy:8089/gateway/venus/tez/#/app/xxx` | `http://dproxy/knox/gateway/venus/tez/#/app/xxx` | r-knox-pass |
| `http://dproxy:8089/gateway/venus/sparkhistory/` | `http://dproxy/knox/gateway/venus/sparkhistory/` | r-knox-pass |
| `http://dproxy:8089/gateway/venus/jobhistory/joblogs` | `http://dproxy/knox/gateway/venus/jobhistory/joblogs` | r-knox-pass |
| `http://dproxy:8089/gateway/venus/yarn/nodemanager/node/containerlogs` | `http://dproxy/knox/gateway/venus/yarn/nodemanager/node/containerlogs` | r-knox-pass |
| `http://dproxy:8090/applicationhistory/app/application_xxx?user.name=yarn` | `http://dproxy/timeline/applicationhistory/app/application_xxx?user.name=yarn` | r-timeline-pass |
| `http://dproxy:8090/ws/v1/timeline/TEZ_DAG_ID?...` | `http://dproxy/timeline/ws/v1/timeline/TEZ_DAG_ID?...` | r-timeline-ws-guard |
| `http://dproxy:8990/...` | `http://dproxy/offline/timeline/...` | r-offline-timeline-pass |
| `http://dproxy:18990/...` | `http://dproxy/offline/timeline2/...` | r-offline-timeline2-pass |
| `http://dproxy:8092/...` | `http://dproxy/flink-hs/...` | r-flink-hs-pass |
| `http://dproxy:8093/...` | `http://dproxy/realtime/flink-hs/...` | r-rt-flink-hs-pass |
| `http://dproxy:8094/gateway/realtime/...` | `http://dproxy/realtime/knox/gateway/realtime/...` | r-rt-knox-pass |
| `http://dproxy:8095/gateway/realtime/jobhistory/...` | `http://dproxy/realtime/logs/gateway/realtime/jobhistory/...` | r-rt-logs-whitelist |
| `http://dproxy:8823/` (TezUI) | `http://dproxy/tez-ui/` | r-tez-ui-static |
| `http://dproxy:8823/ws/...` | `http://dproxy/tez-ui/ws/...` | r-tez-ui-ws |
| `http://dnn014018:19888/jobhistory/logs`（直连，待替换）| `http://dproxy/jhs/jobhistory/logs` | r-jhs-pass |

---

## 七、DNS 切换步骤

> **前提**：所有路由、服务组、插件均已在 SCLB 上创建并验证（带 `curl -H 'Host: dproxy.venus.sohurdc.com'` 测试通过）

1. **在测试机修改 `/etc/hosts`**，将 `dproxy.venus.sohurdc.com` 指向 `10.18.102.127`
2. 执行第八章验证命令，所有返回均正常
3. 通知相关业务方（智能平台、大数据监控等）准备切流
4. **将 DNS A 记录从** `10.18.14.11`（原 nginx 物理机）**切为** `10.18.102.127`（SCLB VIP）
5. 同步修改 Ambari 配置项：`yarn.log.server.url = http://dproxy.venus.sohurdc.com/jhs/jobhistory/logs`，重启 YARN ResourceManager 生效
6. 观察 SCLB 访问日志 30 分钟，确认无异常 4xx/5xx 告警
7. 原 nginx（dproxy 物理机）**保留运行 7 天**作为回退选项，确认稳定后再停止

---

## 八、验证命令

所有 curl 测试统一加 `-H 'Host: dproxy.venus.sohurdc.com'`，直接打 SCLB VIP（切 DNS 前可用于验证）。

### 8.1 Knox 主入口

```bash
# r-knox-pass：应返回 Knox 200 或 302（Knox 认证重定向）
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/venus/tez/'

# r-knox-block：yarnui 应返回 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/yarnui/yarn'
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/yarnui/yarn/cluster/apps'

# r-knox-block：sparkhistory block 应返回 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/venus/sparkhistory/api/v1/applications'

# r-knox-timeline-guard：limit=11 应返回 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID?limit=11'

# r-knox-timeline-guard：无 limit=11 应正常回源
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/knox/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID?limit=10'
```

### 8.2 Timeline

```bash
# r-timeline-pass：应正常回源，响应中 src/href 应含 /timeline/ 前缀
curl -sS -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/timeline/applicationhistory/apps' | \
  grep -c 'src="/timeline/' 
# 期望：> 0（body_filter 已替换 src="/ 为 src="/timeline/）

# user.name 补全验证（不带 user.name 参数，ATS 应正常返回 200）
curl -sSo /dev/null -w "%{http_code}" -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/timeline/applicationhistory/apps'
# 期望：200
```

### 8.3 JHS（新增验证）

```bash
# r-jhs-pass：应返回 JHS 200，且不再暴露 dnn014018 地址
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/jhs/jobhistory/logs'

# 验证前缀正确剥离（JHS 收到的是 /jobhistory/logs 而非 /jhs/jobhistory/logs）
# 若返回 404 页面含 "jobhistory/logs" 说明路径剥离正确；若含 "/jhs/" 则 plg-strip 未生效
```

### 8.4 Flink HS

```bash
# block overview 应 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/flink-hs/jobs/overview'
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/flink-hs/jobs/overview'

# 其他路径应正常代理
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/flink-hs/overview'
```

### 8.5 Realtime Knox + 日志白名单

```bash
# r-rt-knox-block 应 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/knox/gateway/realtime/sparkhistory'
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/knox/gateway/realtime/yarn/cluster/apps'

# r-rt-knox-pass 应正常回源
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/knox/gateway/realtime/jobhistory/'

# r-rt-logs-whitelist 应正常回源
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/logs/gateway/realtime/jobhistory/some-log'

# r-rt-logs-deny 默认应 403
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/realtime/logs/gateway/realtime/hdfs/'
```

### 8.6 Tez UI

```bash
# 静态资源应返回 HTML
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/tez-ui/'

# ws 路由应返回 Knox 响应（带 Auth 头）
curl -sSI -H 'Host: dproxy.venus.sohurdc.com' \
  'http://10.18.102.127/tez-ui/ws/v1/timeline/TEZ_DAG_ID'
```

---

## 九、常见问题排查速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `404 Not Found` from `APISIX/3.13.0` | 路由未命中；路径只写了 `/xxx` 没写 `/xxx/*` | 补充通配路径 `/xxx/*` |
| `302` 跳到 `...gateway/homepage/knox/gateway/...` | `/knox` 前缀没剥掉，Knox 收到了 `/knox/gateway/...` | 检查 `plg-strip-ingress-prefix` 是否挂载，且 Lua 用的是 `ctx.var.upstream_uri` |
| Timeline 响应中 src/href 仍是根相对路径（`/static/...`） | `plg-sub-filter-8090-body` 插件代码包含中文注释，APISIX 加载超时 | 确保插件代码只用 ASCII 英文注释，重新 update-plugin → resave-route |
| 修改插件代码后 APISIX 行为不变 | SCLB `update-plugin`（publish）只更新 SCLB DB，不自动推到 APISIX | 插件更新后必须执行 `PUT /api/sclb/v1/gateway/route/edit`（resave-route），才会触发 APISIX 同步 |
| `user.name` 参数丢失，ATS 返回 401/403 | `plg-append-user-name-yarn` 未挂载或执行阶段错误 | 确认阶段为 `rewrite`（在 proxy 前执行） |
| `/jhs/...` 返回 JHS 404，URL 含 `/jhs/` 字样 | `plg-strip-ingress-prefix` 映射中 `/jhs` 未添加，或插件未挂载 | 更新 Lua mappings，重新部署插件 |
| Knox block 路由未生效，返回 200 | 路由优先级设置有误，或 block 路由优先级低于 pass 路由 | 将 block 路由优先级调为 1000，pass 路由调为 100 |
