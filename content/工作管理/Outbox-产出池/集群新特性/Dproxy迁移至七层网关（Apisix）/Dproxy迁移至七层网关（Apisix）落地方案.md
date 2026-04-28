---
type: solution
status: draft
author: 小温
date: 2026-04-16
domain: 集群新特性
tags: [Dproxy, APISIX, SCLB, Nginx, Knox, Timeline, Flink, Tez]
---

# Dproxy 迁移至七层网关（Apisix）落地方案（全量对照版）

> **版本**: v7.0  
> **日期**: 2026-04-16  
> **负责人**: 李浩鹏  
> **目标平台**: 当前 SCLB 七层网关实例  
> **网关 VIP**: `10.18.102.127`  
> **唯一外部入口模型**: `80/443 + 路径前缀`

---

## 1. 结论先行

要用七层 SCLB **完整替代原 nginx dproxy**，必须同时满足下面 3 条：

1. **端口语义改为路径前缀语义**
   - `8089` -> `/knox`
   - `8090` -> `/timeline`
   - 其他端口同理

2. **路径匹配必须用 APISIX wildcard**
   - 不能再写 `/knox,/knox/`
   - 要写成 `/knox` 和 `/knox/*`
   - 否则 `/knox/gateway/...` 根本不会命中

3. **前缀剥离必须写 `ctx.var.upstream_uri`**
   - 不能依赖平台表单里的路径改写
   - 也不能写 `ngx.req.set_uri()`
   - 否则 Knox 仍会收到 `/knox/gateway/...`，继续 302 到 `knoxsso`

---

## 2. 原 nginx 全量功能梳理

下面这张表，是把原 nginx `nginx -T` 中每个监听端口的行为完整抽象成：

**监听端口 -> 入口路径 -> 附加逻辑 -> 回源目标**

| 原端口     | 入口类型              | 原路径/规则                                        | 附加逻辑                                                                          | 回源目标                       |
| ------- | ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| `8089`  | 主 Knox 入口         | `/gateway/...`                                | Knox 基本认证头；部分路径 `403`；部分 tez timeline `limit=11` 拦截                           | `dsrv014022:8443`          |
| `8091`  | 简化版 Knox          | `/gateway/venus/tez/ws/v1/timeline/...` + `/` | Knox 基本认证头；`limit=11` 拦截；其余走 catch-all                                        | `dsrv014022:8443`          |
| `8090`  | 在线 Timeline       | `/` + `/ws/v1/timeline/...`                   | 自动补 `user.name=yarn`；响应体 `sub_filter`；timeline ws 上按 `limit=11 + Origin` 条件拦截 | `h3timeline:8188`          |
| `8990`  | 离线 Timeline 1     | `/`                                           | 自动补 `user.name=yarn`                                                          | `h3offline.timeline:8188`  |
| `18990` | 离线 Timeline 2     | `/`                                           | 自动补 `user.name=yarn`                                                          | `h3offline.timeline:18188` |
| `8092`  | Flink HS 离线       | `/jobs/overview` + `/`                        | `/jobs/overview` 返回 `403`                                                     | `dnn014013:9999`           |
| `8093`  | Flink HS 实时       | `/jobs/overview` + `/`                        | `/jobs/overview` 返回 `403`                                                     | `10.18.15.108:8083`        |
| `8094`  | Realtime Knox     | `/gateway/realtime/...`                       | Knox 基本认证头；部分 realtime sparkhistory/yarn 页面直接 `403`                           | `dsrv014022:8443`          |
| `8095`  | Realtime 日志白名单    | 若干 `gateway/realtime/...` 路径                  | 仅白名单路径放行；其余全 `403`；Knox 基本认证头                                                 | `dsrv014022:8443`          |
| `8823`  | Tez UI 静态 + `/ws` | `/`、`/ws`                                     | `/ws` 反代到 `8822` 并带 Knox 基本认证头                                                | `dnn014012:8822` / 本地静态目录  |
| `8824`  | 历史 `/tez-ui` 前缀适配 | `/tez-ui`                                     | 去掉 `/tez-ui` 前缀，静态托管；`/tez-ui/` 返回 `403`                                      | 本地静态目录                     |

---

## 3. 新入口映射总表

| 原端口 | 原用途 | 新前缀 | 新入口示例 |
|---|---|---|---|
| `8089` | 主 Knox 入口 | `/knox` | `/knox/gateway/venus/jobhistory/joblogs` |
| `8091` | 简化版 Knox | `/knox-lite` | `/knox-lite/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID` |
| `8090` | 在线 Timeline | `/timeline` | `/timeline/applicationhistory/app/application_xxx?user.name=yarn` |
| `8990` | 离线 Timeline 1 | `/offline/timeline` | `/offline/timeline/applicationhistory/...` |
| `18990` | 离线 Timeline 2 | `/offline/timeline2` | `/offline/timeline2/applicationhistory/...` |
| `8092` | Flink HS 离线 | `/flink-hs` | `/flink-hs/jobs/overview` |
| `8093` | Flink HS 实时 | `/realtime/flink-hs` | `/realtime/flink-hs/jobs/overview` |
| `8094` | Realtime Knox | `/realtime/knox` | `/realtime/knox/gateway/realtime/jobhistory/` |
| `8095` | Realtime 日志白名单 | `/realtime/logs` | `/realtime/logs/gateway/realtime/jobhistory/...` |
| `8823` + `8824` | Tez UI | `/tez-ui` | `/tez-ui/`、`/tez-ui/ws/...` |

---

## 4. 这次迁移里最重要的 4 条实操规则

### 4.1 路径必须写 wildcard

当前 SCLB/APISIX 要匹配子路径，必须这样写：

| 错误写法 | 正确写法 |
|---|---|
| `/knox,/knox/` | `/knox`、`/knox/*` |
| `/timeline,/timeline/` | `/timeline`、`/timeline/*` |
| `/tez-ui/ws,/tez-ui/ws/` | `/tez-ui/ws`、`/tez-ui/ws/*` |

### 4.2 需要回源剥离前缀的路由，一律关闭表单“路径改写”

路径改写字段统一：

```text
路径改写：no
```

真正的前缀剥离交给 Lua。

### 4.3 Knox 类路由必须带固定 Authorization

所有回 Knox 的路由都要带：

```text
Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3
```

### 4.4 浏览器里的 `#/...` 不参与服务端匹配

例如：

```text
http://dproxy.venus.sohurdc.com:8089/gateway/venus/tez/#/app/application_xxx
```

服务端真正收到的是：

```text
/gateway/venus/tez/
```

所以迁移后只需要保证：

```text
/knox/gateway/venus/tez/
```

能命中并正确回源。

---

## 5. 服务组清单

| 服务组 | 后端 |
|---|---|
| `sg-knox-ha` | `10.31.73.169:8443` |
| `sg-timeline-online` | `h3timeline.venus.sohurdc.com:8188` |
| `sg-timeline-offline1` | `h3offline.timeline.venus.sohurdc.com:8188` |
| `sg-timeline-offline2` | `h3offline.timeline.venus.sohurdc.com:18188` |
| `sg-flink-hs-offline` | `dnn014013.venus.sohurdc.com:9999` |
| `sg-flink-hs-realtime` | `10.18.15.108:8083` |
| `sg-tez-ui-ws` | `dnn014012.venus.sohurdc.com:8822` |
| `sg-dproxy-8823-static` | `10.18.14.11:8823` |
| `sg-block-placeholder` | `10.31.73.169:8443` |

---

## 6. 插件清单

## 6.1 `plg-return-403`

执行阶段：`rewrite`

```lua
local _M = {}

function _M.rewrite(conf, ctx)
    return ngx.exit(403)
end

return _M
```

## 6.2 `plg-append-user-name-yarn`

执行阶段：`rewrite`

```lua
local _M = {}

function _M.rewrite(conf, ctx)
    local args = ngx.req.get_uri_args()
    if args["user.name"] == nil or args["user.name"] == "" then
        args["user.name"] = "yarn"
        ngx.req.set_uri_args(args)
    end
end

return _M
```

## 6.3 `plg-block-limit-11`

执行阶段：`access`

```lua
local _M = {}

function _M.access(conf, ctx)
    if ngx.var.arg_limit == "11" then
        return ngx.exit(403)
    end
end

return _M
```

## 6.4 `plg-timeline-origin-limit-11`

执行阶段：`access`

> 这一条只用于复刻旧 `8090 + timeline_tezui.conf` 的 `Origin + limit=11` 逻辑。  
> 如果新链路浏览器 `Origin` 已变化，后续再按抓包修正。

```lua
local _M = {}

function _M.access(conf, ctx)
    local limit = ngx.var.arg_limit
    local origin = ngx.var.http_origin

    if limit == "11" and origin ~= nil then
        if string.lower(origin) == "http://dnn014012.venus.sohurdc.com:8823" then
            return ngx.exit(403)
        end
    end
end

return _M
```

## 6.5 `plg-sub-filter-timeline-header`

执行阶段：`header_filter`

```lua
local _M = {}

function _M.header_filter(conf, ctx)
    ngx.header["Content-Length"] = nil
end

return _M
```

## 6.6 `plg-sub-filter-timeline-body`

执行阶段：`body_filter`

```lua
local _M = {}

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
        body = string.gsub(body, "h3timeline%.venus%.sohurdc%.com:8188", "dproxy.venus.sohurdc.com/timeline")
        ngx.arg[1] = body
    end
end

return _M
```

## 6.7 `plg-strip-ingress-prefix`

执行阶段：`rewrite`

> **关键点：必须改 `ctx.var.upstream_uri`**

```lua
local _M = {}

local mappings = {
    { prefix = "/offline/timeline2", target = "" },
    { prefix = "/offline/timeline", target = "" },
    { prefix = "/realtime/flink-hs", target = "" },
    { prefix = "/realtime/knox", target = "" },
    { prefix = "/realtime/logs", target = "" },
    { prefix = "/knox-lite", target = "" },
    { prefix = "/flink-hs", target = "" },
    { prefix = "/timeline", target = "" },
    { prefix = "/tez-ui/ws", target = "/ws" },
    { prefix = "/tez-ui", target = "" },
    { prefix = "/knox", target = "" },
}

local function normalize(target, suffix)
    local new_uri = target .. suffix
    if new_uri == "" then
        return "/"
    end
    if string.sub(new_uri, 1, 1) ~= "/" then
        return "/" .. new_uri
    end
    return new_uri
end

function _M.rewrite(conf, ctx)
    local uri = ngx.var.uri

    for _, item in ipairs(mappings) do
        local prefix = item.prefix
        local target = item.target

        if uri == prefix then
            ctx.var.upstream_uri = normalize(target, "")
            return
        end

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

## 7. 最终 SCLB 路由矩阵

下面这部分就是**完整替代原 nginx 行为**时，建议在 SCLB 上创建的路由集合。

### 7.1 主 Knox（替代 `8089`）

#### `r-knox-block-yarnui`

| 项   | 值                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 优先级 | `1000`                                                                                                                                                                                                                                                                                     |
| 路径  | `/knox/gateway/yarnui/yarn`、`/knox/gateway/yarnui/yarn/`、`/knox/gateway/yarnui/yarn/cluster/apps*`、`/knox/gateway/yarnui/yarn/cluster/scheduler*`、`/knox/gateway/yarnui/yarn/jmx*`、`/knox/gateway/yarnui/yarn/logs*`、`/knox/gateway/yarnui/yarn/conf*`、`/knox/gateway/yarnui/yarn/stacks*` |
| 服务组 | `sg-block-placeholder`                                                                                                                                                                                                                                                                     |
| 插件  | `plg-return-403`                                                                                                                                                                                                                                                                           |

#### `r-knox-block-sparkhistory-api`

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/knox/gateway/venus/sparkhistory/api/v1/applications`、`/knox/gateway/venus/sparkhistory/history` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### `r-knox-timeline-guard`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/knox/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID`、`/knox/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID`、`/knox/gateway/offline-ats1/tez/ws/v1/timeline/TEZ_DAG_ID`、`/knox/gateway/offline-ats1/tez/ws/v1/timeline/HIVE_QUERY_ID`、`/knox/gateway/offline-ats2/tez/ws/v1/timeline/TEZ_DAG_ID`、`/knox/gateway/offline-ats2/tez/ws/v1/timeline/HIVE_QUERY_ID` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix`、`plg-block-limit-11` |

#### `r-knox-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/knox`、`/knox/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |

> 这一条直接替代原 nginx `8089` 的 `location /` catch-all。  
> 之前 `/knox,/knox/` 不生效，就是因为少了 `*`。

### 7.2 简化版 Knox（替代 `8091`）

#### `r-knox-lite-timeline-guard`

| 项     | 值                                                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| 优先级   | `900`                                                                                                                |
| 路径    | `/knox-lite/gateway/venus/tez/ws/v1/timeline/TEZ_DAG_ID`、`/knox-lite/gateway/venus/tez/ws/v1/timeline/HIVE_QUERY_ID` |
| 服务组   | `sg-knox-ha`                                                                                                         |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3`                                                                  |
| 插件    | `plg-strip-ingress-prefix`、`plg-block-limit-11`                                                                      |

#### `r-knox-lite-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/knox-lite`、`/knox-lite/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |

### 7.3 在线 Timeline（替代 `8090`）

#### `r-timeline-ws-guard`

| 项     | 值                                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 优先级   | `900`                                                                                                                                                 |
| 路径    | `/timeline/ws/v1/timeline/TEZ_DAG_ID`、`/timeline/ws/v1/timeline/HIVE_QUERY_ID`                                                                        |
| 服务组   | `sg-timeline-online`                                                                                                                                  |
| 请求头改写 | `Accept-Encoding: identity`                                                                                                                           |
| 插件    | `plg-strip-ingress-prefix`、`plg-append-user-name-yarn`、`plg-timeline-origin-limit-11`、`plg-sub-filter-timeline-header`、`plg-sub-filter-timeline-body` |

#### `r-timeline-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/timeline`、`/timeline/*` |
| 服务组 | `sg-timeline-online` |
| 请求头改写 | `Accept-Encoding: identity` |
| 插件 | `plg-strip-ingress-prefix`、`plg-append-user-name-yarn`、`plg-sub-filter-timeline-header`、`plg-sub-filter-timeline-body` |

### 7.4 离线 Timeline（替代 `8990` / `18990`）

#### `r-offline-timeline-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/offline/timeline`、`/offline/timeline/*` |
| 服务组 | `sg-timeline-offline1` |
| 插件 | `plg-strip-ingress-prefix`、`plg-append-user-name-yarn` |

#### `r-offline-timeline2-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/offline/timeline2`、`/offline/timeline2/*` |
| 服务组 | `sg-timeline-offline2` |
| 插件 | `plg-strip-ingress-prefix`、`plg-append-user-name-yarn` |

### 7.5 Flink HistoryServer（替代 `8092` / `8093`）

#### `r-flink-hs-block-overview`

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/flink-hs/jobs/overview` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### `r-flink-hs-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/flink-hs`、`/flink-hs/*` |
| 服务组 | `sg-flink-hs-offline` |
| 插件 | `plg-strip-ingress-prefix` |

#### `r-rt-flink-hs-block-overview`

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/realtime/flink-hs/jobs/overview` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### `r-rt-flink-hs-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/flink-hs`、`/realtime/flink-hs/*` |
| 服务组 | `sg-flink-hs-realtime` |
| 插件 | `plg-strip-ingress-prefix` |

### 7.6 Realtime Knox（替代 `8094`）

#### `r-rt-knox-block`

| 项 | 值 |
|---|---|
| 优先级 | `1000` |
| 路径 | `/realtime/knox/gateway/realtime/sparkhistory/history`、`/realtime/knox/gateway/realtime/sparkhistory`、`/realtime/knox/gateway/realtime/sparkhistory/api/v1/applications`、`/realtime/knox/gateway/realtime/yarn/cluster`、`/realtime/knox/gateway/realtime/yarn/conf`、`/realtime/knox/gateway/realtime/yarn/logs`、`/realtime/knox/gateway/realtime/yarn/stacks`、`/realtime/knox/gateway/realtime/yarn/jmx`、`/realtime/knox/gateway/realtime/yarn/cluster/apps*`、`/realtime/knox/gateway/realtime/yarn/cluster/scheduler*`、`/realtime/knox/gateway/realtime/yarn/cluster/cluster*`、`/realtime/knox/gateway/realtime/yarn/cluster/nodes*`、`/realtime/knox/gateway/realtime/yarn/cluster/nodelabels*`、`/realtime/knox/gateway/realtime/yarn/nodemanager/node/node*`、`/realtime/knox/gateway/realtime/yarn/nodemanager/node/allApplications*`、`/realtime/knox/gateway/realtime/yarn/nodemanager/node/allContainers*` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

#### `r-rt-knox-pass`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/knox`、`/realtime/knox/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |

### 7.7 Realtime 日志白名单（替代 `8095`）

#### `r-rt-logs-whitelist`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/realtime/logs/gateway/realtime/yarn/proxy/application_*`、`/realtime/logs/gateway/realtime/yarn/cluster/app/application_*`、`/realtime/logs/gateway/realtime/yarn/nodemanager/node/containerlogs/*`、`/realtime/logs/gateway/realtime/yarn/static/*`、`/realtime/logs/gateway/realtime/jobhistory/*`、`/realtime/logs/gateway/realtime/yarn/cluster/appattempt/*` |
| 服务组 | `sg-knox-ha` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |

#### `r-rt-logs-deny`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/realtime/logs`、`/realtime/logs/*` |
| 服务组 | `sg-block-placeholder` |
| 插件 | `plg-return-403` |

### 7.8 Tez UI（替代 `8823` + `8824`）

#### `r-tez-ui-ws`

| 项 | 值 |
|---|---|
| 优先级 | `900` |
| 路径 | `/tez-ui/ws`、`/tez-ui/ws/*` |
| 服务组 | `sg-tez-ui-ws` |
| 请求头改写 | `Authorization: Basic YWRtaW46YWRtaW5Lbm94VDlROEM3` |
| 插件 | `plg-strip-ingress-prefix` |

#### `r-tez-ui-static`

| 项 | 值 |
|---|---|
| 优先级 | `100` |
| 路径 | `/tez-ui`、`/tez-ui/*` |
| 服务组 | `sg-dproxy-8823-static` |
| 插件 | `plg-strip-ingress-prefix` |

> 新方案统一使用 `/tez-ui` 对外入口，不再刻意保留旧 `8824` 上“`/tez-ui/` 返回 403”的历史行为。

---

## 8. 你当前最关心的 URL，迁移后怎么访问

| 旧 URL | 新 URL | 命中路由 |
|---|---|---|
| `http://dproxy.venus.sohurdc.com:8089/gateway/venus/tez/#/app/application_1761215995979_19024040` | `http://10.18.102.127/knox/gateway/venus/tez/#/app/application_1761215995979_19024040` | `r-knox-pass` |
| `http://dproxy.venus.sohurdc.com:8090/applicationhistory/app/application_1761215995979_19024038?user.name=yarn` | `http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024038?user.name=yarn` | `r-timeline-pass` |
| `http://dproxy.venus.sohurdc.com:8090/applicationhistory/app/application_1761215995979_19024023?user.name=yarn` | `http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024023?user.name=yarn` | `r-timeline-pass` |
| `http://dproxy.venus.sohurdc.com:8090/applicationhistory/app/application_1761215995979_19024019?user.name=yarn` | `http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024019?user.name=yarn` | `r-timeline-pass` |

---

## 9. 实施顺序

1. 创建全部服务组
2. 创建全部 Lua 插件
3. 先创建 `r-knox-pass`
4. 再创建 `r-timeline-pass`
5. 再创建 `r-tez-ui-static`
6. 再创建 `r-tez-ui-ws`
7. 再补所有 block / guard 路由
8. 最后补 realtime 与 flink 路由

---

## 10. 验证命令

所有验证统一带：

```bash
-H 'Host: dproxy.venus.sohurdc.com'
```

### 10.1 你当前这 4 个 URL 的最小验收

```bash
curl -I -H 'Host: dproxy.venus.sohurdc.com' \
'http://10.18.102.127/knox/gateway/venus/tez/'

curl -I -H 'Host: dproxy.venus.sohurdc.com' \
'http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024038?user.name=yarn'

curl -I -H 'Host: dproxy.venus.sohurdc.com' \
'http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024023?user.name=yarn'

curl -I -H 'Host: dproxy.venus.sohurdc.com' \
'http://10.18.102.127/timeline/applicationhistory/app/application_1761215995979_19024019?user.name=yarn'
```

### 10.2 关键异常判定

| 现象 | 含义 |
|---|---|
| `404 Not Found` from `APISIX/3.13.0` | 路由没有命中；优先检查路径是否写成了 `/xxx/*` |
| `302` 到 `.../gateway/homepage/knox/gateway/...` | `/knox` 前缀没剥掉；优先检查 `ctx.var.upstream_uri` 版本插件 |
| `403` from APISIX on block/guard | 说明拦截逻辑生效 |

---

## 11. 最终落地口径

**这份方案已经把原 nginx 的转发功能按监听端口全部梳理完了，并给出了对应的 SCLB 路由、服务组、插件与新入口路径。**

后续现场执行时，最容易踩坑的只有两个：

1. 把路径写成 `/knox,/knox/`，而不是 `/knox,/knox/*`
2. `plg-strip-ingress-prefix` 还在用错误的 `ngx.req.set_uri()`

只要把这两点修正，七层 SCLB 替代原 nginx 的路径前缀方案就是可落地的。
