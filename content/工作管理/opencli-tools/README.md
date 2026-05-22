---
type: index
domain: opencli
---

# opencli 工具列表

基于 opencli 框架制作的自定义 CLI 工具，覆盖大数据集群 SRE 日常运维全场景。

## 站点总览

| 站点 | 目录 | 适配器数 | 用途 | 鉴权 |
|---|---|---|---|---|
| [sclb](#sclb---panther-网关平台) | `~/.opencli/clis/sclb/` | 11 | Panther 网关平台管理 | COOKIE |
| [zabbix](#zabbix---zabbix-监控系统) | `~/.opencli/clis/zabbix/` | 6 | 集群告警/主机/事件查询 | COOKIE |
| [foxeye](#foxeye---可观测平台) | `~/.opencli/clis/foxeye/` | 3 | 可观测平台概览/业务组/数据源 | COOKIE |
| [confluence](#confluence---rdc-confluence-知识库) | `~/.opencli/clis/confluence/` | 6 | 知识库搜索/页面管理 | COOKIE |
| [mail](#mail---exchange-owa-邮箱) | -- | 0 | 邮箱层次重组（仅浏览器自动化） | -- |

---

## sclb — Panther 网关平台

**站点**: `https://panther.sohurdc.com` | **API**: REST over HTTPS | **站点记忆**: `~/.opencli/sites/sclb/`

网关实例、服务项目、路由规则、后端组、自定义插件的全量管理。

### 适配器清单

| 命令 | 功能 | 核心参数 |
|---|---|---|
| `sclb list-instances` | 网关实例列表，含规格/VIP/集群/带宽 | `--limit` |
| `sclb get-instance` | 单实例详情，含可用区 VIP 和后端 IP | `--id` |
| `sclb list-projects` | 服务项目列表，含路由数/网关数/部门 | `--limit` |
| `sclb get-project` | 单项目详情 | `--id` |
| `sclb list-routes` | 项目下路由列表，含 URI/优先级/插件 | `--project` |
| `sclb list-instance-routes` | 实例绑定的路由，按项目展示 | `--id` |
| `sclb list-bg` | 后端组（服务组）列表 | `--limit` |
| `sclb list-plugins` | 自定义 Lua 插件，含执行阶段/参数 | `--limit` |
| `sclb list-specs` | 网关实例可用规格和 QPS 上限 | -- |
| `sclb probe-bg` | 查看服务组完整原始字段 | `--id` |
| `sclb probe-write` | 探测写入 API | -- |

### 典型用法

```bash
opencli sclb list-instances --limit 20        # 查看网关实例
opencli sclb get-instance --id <insId>        # 实例详情含可用区 IP
opencli sclb list-routes --project <projId>   # 项目路由规则
opencli sclb list-plugins --limit 30          # 查看自定义插件
```

---

## zabbix — Zabbix 监控系统

**站点**: `http://zabbix.sohurdc.com:8080` | **API**: JSON-RPC (`/api_jsonrpc.php`) | **站点记忆**: `~/.opencli/sites/zabbix/`

Zabbix 7.2.3，管理 2164 台主机、350K+ 触发器、647K+ 监控项。

### 适配器清单

| 命令 | 功能 | 核心参数 |
|---|---|---|
| `zabbix problems` | 活跃告警查询 | `--severity` `--group` `--limit` `--all` |
| `zabbix hosts` | 主机列表/搜索 | `--group` `--search` `--limit` |
| `zabbix events` | 历史事件查询 | `--hours` `--severity` `--host` `--value` `--limit` |
| `zabbix triggers` | 触发器查询 | `--host` `--group` `--severity` `--search` `--limit` |
| `zabbix items` | 监控项+最新值 | `--host` `--search` `--key` `--limit` |
| `zabbix actions` | 告警动作管理 | `--status` `--source` `--search` `--limit` |

### 典型用法

```bash
opencli zabbix problems --severity 5 --limit 10       # 灾难级告警
opencli zabbix hosts --group panther --search hadoop   # 按组+关键字查主机
opencli zabbix events --host wallnut --hours 48        # 某主机 48h 事件
opencli zabbix triggers --host drm014 --severity 5     # 灾难级触发器
opencli zabbix items --host dnn130161 --search Heap    # 某主机 JVM 指标
opencli zabbix actions --status enabled --source trigger  # 启用的触发器动作
```

### 站点特征

- domain 必须含 `:8080` 端口，opencli pre-navigation 才正确
- Zabbix 7.x 用 `selectHostGroups`（非 `selectGroups`），返回 key 为 `hostgroups`
- `problem.get` 不带主机信息，用 `event.get` + `value: 1` + `selectHosts` 替代

---

## foxeye — 可观测平台

**站点**: `https://panther.sohurdc.com/foxeye/overview` | **API**: `https://foxeye-prod.panther.sohurdc.com` | **站点记忆**: `~/.opencli/sites/foxeye/`

基于 Nightingale (n9e) 构建的可观测平台。管理 96 个业务组、10,805 条告警规则、49 个数据源。

### 适配器清单

| 命令 | 功能 | 核心参数 |
|---|---|---|
| `foxeye overview` | 概览统计（规则/告警/看板/业务组） | `--bg` |
| `foxeye busi-groups` | 业务组列表/搜索 | `--search` `--limit` |
| `foxeye datasources` | 数据源列表（Prometheus/Loki） | `--search` `--limit` |

### 典型用法

```bash
opencli foxeye overview                           # 全平台概览
opencli foxeye busi-groups --search hadoop        # 搜索业务组
opencli foxeye datasources --search loki          # 搜索数据源
```

### 站点特征

- API 在 `foxeye-prod.panther.sohurdc.com`，但登录在 `panther.sohurdc.com`
- `*.panther.sohurdc.com` 共享 Cookie，opencli domain 用 `panther.sohurdc.com`
- 另有 `foxeye-server.panther.sohurdc.com` 使用 `X-User-Token` header 鉴权（告警事件/规则 API）

---

## confluence — RDC-Confluence 知识库

**站点**: `https://bd-docs.panther.sohurdc.com` | **API**: REST (`/rest/api/`) | **站点记忆**: `~/.opencli/sites/confluence/`

Confluence 6.0，9 个空间，支持 CQL 全文搜索和页面 CRUD。

### 适配器清单

| 命令 | 类型 | 功能 | 核心参数 |
|---|---|---|---|
| `confluence spaces` | 读 | 列出所有空间 | -- |
| `confluence search` | 读 | 全文搜索页面 | `--query` `--space` `--limit` |
| `confluence recent` | 读 | 最近更新页面 | `--space` `--days` `--limit` |
| `confluence page` | 读 | 页面元数据 | `--id` |
| `confluence create` | **写** | 创建新页面 | `--title` `--content` `--space` `--parent` |
| `confluence update` | **写** | 更新页面内容 | `--id` `--content` `--title` |

### 典型用法

```bash
opencli confluence search --query "HDFS Router" --space clusterop  # 搜索
opencli confluence recent --space research --days 30               # 最近更新
opencli confluence page --id 82828103                              # 页面详情
opencli confluence create --title "新页面" --content "<p>内容</p>" --parent 71920383
opencli confluence update --id 107715254 --content "<p>新内容</p>"
```

### 站点特征

- CQL `now()` 不支持，时间过滤用实际日期字符串 `lastmodified>="2026-04-15"`
- expand 参数必传（`space,version,history.lastUpdated`），否则字段只返回 link
- `ancestors.id` 必须传数字类型，字符串会导致 400

### 内容写入注意事项

| # | 问题 | 原因 | 处理 |
|---|---|---|---|
| 1 | HTTP 500 `Hibernate flush` | emoji（🔴🟡🟢 = non-BMP Unicode）无法存入数据库 | `sanitizeContent()` 自动过滤 |
| 2 | HTTP 400 `XHTML parse error` | PromQL 中 `<`（如 `< 1300`）被当标签解析 | `<code>` 内必须 `&lt;` 转义 |
| 3 | opencli eval 长 JS 异常 | 超过 ~15K 字符时 async fetch 响应丢失 | base64 + sessionStorage 分块 |
| 4 | `atob()` 中文乱码 | `atob()` 只处理 Latin-1 | `Uint8Array` + `TextDecoder("utf-8")` |

---

## mail — Exchange OWA 邮箱

**站点**: `https://mail.sohu-inc.com/owa/` | **API**: 不可用（canary token 反 CSRF）

Exchange 2016 本地部署。OWA 内部 API (`/owa/service.svc`) 使用动态 canary token，无法制作 opencli API 适配器。可通过浏览器自动化（eval/click/screenshot）辅助分析文件夹结构和规则。

### 当前状态

- 46 个文件夹，收件箱 1,404 封未读，紧急故障 2,103 封未读
- 已删除邮件 11,036 封从未清空
- 大量监控报警自动归档但未读堆积

---

## 开发约定

## Codex 原生复用

Codex 会话中可以直接把 `opencli` 当作外部查询和浏览器自动化工具使用。优先复用已有 adapter，而不是重新手写浏览器抓取逻辑。

### 适用场景

| 场景 | Codex 动作 |
|---|---|
| 查询已有平台数据 | 先跑 `opencli list -f yaml`，确认站点和命令是否存在 |
| 查看命令签名 | 跑 `opencli <site> --help -f yaml` 或 `opencli <site> <command> --help -f yaml` |
| SRE 日常查询 | 优先用 `zabbix`、`foxeye`、`sclb`、`confluence` 等本地 adapter |
| 新站点接入 | 使用 `opencli browser open/network/eval/verify` 形成 adapter |
| 搜索/研究 | 触发 `smart-search` skill，让它路由到合适的 opencli 站点 |

### Codex 注意事项

- `opencli` 已内置 `codex` app adapter，但它面向 Codex 桌面 App；当前主机只有 `codex` CLI 时，`opencli codex status` 会提示找不到 Codex App。
- 在 Codex CLI 会话里复用 opencli 的正确方式，是直接执行 `opencli ...` 命令或触发 `smart-search` / `opencli-adapter-author` / `opencli-autofix` skill。
- 读取帮助和 registry 不算一次实际搜索；真正执行 `opencli <site> <command>` 后，应在回答中说明使用了哪个站点、查询词和调用次数。

### 适配器文件结构

```
~/.opencli/clis/<site>/
  _helper.js       # 共享 fetch 封装 + 站点特定工具函数
  <command>.js     # 一个适配器一个文件
```

### 站点记忆结构

```
~/.opencli/sites/<site>/
  notes.md          # 站点笔记（API 端点/坑/适配器列表）
  endpoints.json    # 已验证的 API 端点目录
  field-map.json    # 字段代号 → 含义映射
  fixtures/         # 响应样本（回归对比用）
```

### 新站点接入流程

1. `opencli browser open <url>` — 打开站点
2. `opencli browser network` — 捕获 API 请求，识别端点
3. `opencli browser eval` — 验证 API 响应结构
4. 写 `_helper.js` → 写适配器 → `opencli browser verify`
5. 回写站点记忆 → 更新本文档
