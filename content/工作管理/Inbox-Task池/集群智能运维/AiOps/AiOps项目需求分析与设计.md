---
type: task
status: done
priority: P0
deadline: 2026-04-30
domain: 集群智能运维
lifecycle: engineering
progress: "100"
completed_date: 2026-04-17
started_date: 2026-04-03
---

## 🎯 目标与验收标准
- [x] 设计实现AiOps项目。 ✅ 2026-04-21

## ⚙️ 架构设计图 & 关键配置
(在这里用 Mermaid 画架构图，或者粘贴核心配置文件)

## 🐛 踩坑日志 (Troubleshooting)

# SRE-Copilot 重构设计方案

## Context

用户希望将 zabbix-foxeye-transfer 从"告警迁移专用平台"重新定位为**全面的 SRE-Copilot**，告警迁移作为其中一个子功能。新增两个核心能力：
1. **SSH 对话排障**：集成 ai-mcp-bastion 的安全 SSH 执行引擎（但不用 MCP 协议，直接作为 eino Tool 接入）
2. **eino Skill 系统**：利用 eino v0.7.36 的 `adk/middlewares/skill` 模块，支持加载/管理/使用运维排障技能文档

同时迁移数据库从 MySQL → Doris（用于查询性能提升），Doris 实例：`doris-fe.venus.sohurdc.com:9030`，schema：`alert_shadow`。

---

## 功能模块划分（迭代顺序）

### 迭代一：SSH 排障工具集成
### 迭代二：eino Skill 系统
### 迭代三：MySQL → Doris 迁移
### 迭代四：前端重构（品牌 + 导航扩展）

---

## 迭代一：SSH 排障工具集成

### 设计思路
复用 ai-mcp-bastion 的核心设计（规则引擎 + SSH 连接池），但不引入 MCP，直接作为 eino `tool.BaseTool` 注册到 Master Agent。

### 新增文件
```
backend/internal/ssh/
  pool.go          # SSH 连接池（直接从 ai-mcp-bastion 移植，golang.org/x/crypto/ssh）
  executor.go      # ExecuteCommand + timeout + ExecResult 结构

backend/internal/rule/
  engine.go        # 黑白名单规则引擎（正则 + 会话临时白名单）

backend/internal/model/
  ssh_models.go    # SSHHost, AuditLog, PendingApproval, SessionWhitelist（Doris 兼容，不用 JSON 列）

backend/internal/tools/
  ssh_tools.go     # 3 个 eino Tool:
                   #   exec_cmd    - 执行短生命周期命令（带规则校验）
                   #   list_hosts  - 列出可用主机
                   #   check_approval_status - 查询待审批命令状态
```

### 核心数据模型（Doris 兼容，不使用 JSON 列）
```go
// SSH 主机清单（静态配置，可通过 yaml 注入）
type SSHHost struct {
    ID          uint   `gorm:"primaryKey"`
    Hostname    string // e.g. "dnn130160"
    IP          string
    Port        int    `gorm:"default:22"`
    Group       string // e.g. "hadoop", "kafka"
    Description string
}

// 审计日志
type AuditLog struct {
    ID            uint   `gorm:"primaryKey"`
    SessionID     string
    TargetHost    string
    Command       string `gorm:"type:text"`
    ActionTaken   string // ALLOWED / REJECTED / PENDING
    Stdout        string `gorm:"type:text"`
    Stderr        string `gorm:"type:text"`
    ExitCode      int
    ExecuteTimeMs int
    CreatedAt     time.Time `gorm:"index"`
}

// 待审批命令
type PendingApproval struct {
    ID         uint   `gorm:"primaryKey"`
    SessionID  string
    TargetHost string
    Command    string `gorm:"type:text"`
    Status     string `gorm:"default:pending"` // pending/approved/rejected
    CreatedAt  time.Time
}
```

### 规则引擎行为
- **黑名单**（直接拒绝）：`rm -rf`, `mkfs.*`, `kill -9 1`, `dd if=.*of=.*`, `shutdown`, `reboot`
- **白名单**（直接放行）：`uptime`, `free -m`, `df -h`, `ps aux`, `top -bn1`, `jps`, `cat /proc/.*`, `vmstat`, `netstat`, `ss -`开头, `ip addr`, `iostat`, `sar`
- **灰色地带**（返回 PENDING，需 SRE 通过 Web UI 审批）

### exec_cmd Tool 行为
1. 查规则引擎 → REJECT 返回错误 / PENDING 创建 PendingApproval 返回 pending_id
2. 通过 → SSHPool.ExecuteCommand(host, cmd, 30s timeout)
3. 写 AuditLog
4. 返回 stdout/stderr/exit_code

### 配置扩展（backend/configs/config.yaml）
```yaml
ssh:
  key_path: "/root/.ssh/id_rsa"   # SSH 私钥认证，公钥需提前分发到目标主机 authorized_keys
  default_user: "root"
  hosts:
    - hostname: "dnn130160"
      ip: "10.2.130.160"
      group: "hadoop"
    - hostname: "dnn130161"
      ip: "10.2.130.161"
      group: "hadoop"
  auto_load_default_rules: true
```

### master_agent.go 修改
在 `NewMasterAgent` 中追加 `exec_cmd`、`list_hosts`、`check_approval_status` 三个 tools。

---

## 迭代二：eino Skill 系统

### 关键发现
eino **v0.7.36** 的 `github.com/cloudwego/eino/adk/middlewares/skill` 包已内置完整实现：
- `skill.New(ctx, config)` → 返回 `adk.AgentMiddleware`（含 `AdditionalInstruction` + `AdditionalTools`）
- `skill.NewLocalBackend(config)` → 本地文件系统 backend，扫描 `baseDir/<name>/SKILL.md`
- 当前项目用 eino v0.7.22，**需升级到 v0.7.36**（skill 包存在）

**问题**：当前 master_agent.go 使用的是 `flow/agent/react` 的 `react.Agent`，而 skill 中间件要求 `adk.AgentMiddleware` 注入到 `adk` 层的 Agent。

**方案**：`adk.AgentMiddleware` 包含两个字段 `AdditionalInstruction string` 和 `AdditionalTools []tool.BaseTool`，可以手动将其展开注入到现有的 react.Agent 构建流程：
1. 调用 `skill.New()` 获取 `AgentMiddleware`
2. 将 `middleware.AdditionalInstruction` 追加到 system prompt
3. 将 `middleware.AdditionalTools` 追加到工具列表

这样不需要重构为 deep.Agent，保持现有架构。

### 新增文件/修改
```
backend/skills/                  # Skill 存储目录
  cpu-diagnosis/SKILL.md         # 从 anolisa/output 移植
  memory-diagnosis/SKILL.md
  network-diagnosis/SKILL.md
  disk-diagnosis/SKILL.md
  linux-admin/SKILL.md
  zabbix-migration/SKILL.md      # 新建：告警迁移操作手册

backend/internal/agent/
  skill_manager.go               # 封装 skill.NewLocalBackend + skill.New，
                                 # 提供 GetMiddleware() 方法供 master_agent.go 使用

backend/internal/handler/
  skill_handler.go               # REST API:
                                 #   GET /api/v1/skills        - 列出所有 skill
                                 #   GET /api/v1/skills/:name  - 获取 skill 内容

backend/configs/config.yaml 新增：
  skill:
    dir: "./skills"
    use_chinese: true
```

### master_agent.go 修改
```go
// 初始化 skill middleware（若目录存在则启用）
if cfg.Skill.Dir != "" {
    skillMiddleware, err := NewSkillMiddleware(ctx, cfg.Skill)
    if err == nil {
        // 手动展开：追加 instruction 到 system prompt
        systemPrompt += "\n\n" + skillMiddleware.AdditionalInstruction
        // 追加 skill tool 到 myTools
        myTools = append(myTools, skillMiddleware.AdditionalTools...)
    }
}
```

### eino 升级
`go.mod` 中 `github.com/cloudwego/eino` 从 `v0.7.22` 升级到 `v0.7.36`。需同步更新 `eino-ext` 版本兼容性。

---

## 迭代三：MySQL → Doris 迁移

### 可行性分析
Doris 2.1.11 高度兼容 MySQL 协议，**可直接使用 `gorm.io/driver/mysql`**（通过 MySQL 驱动连接 Doris，只需修改 DSN）。

**限制**：
- Doris 不支持 GORM 的 `AutoMigrate`（建表语法差异大：需要 `ENGINE=OLAP`, `DISTRIBUTED BY`, `PROPERTIES`）
- Doris 不支持 `DELETE` + JOIN（MySQL 的 `DELETE m1 FROM ... INNER JOIN` 语法）
- JSON 列支持有限（Doris 2.1 支持 JSON 类型，但功能受限）

### 迁移策略

**方案 A（推荐）：双写过渡 + 查询切 Doris**
- 保留 MySQL 作为写库（GORM AutoMigrate 和事务依赖 MySQL）
- Doris 作为**分析查询库**：历史 alert_events、audit_logs、rule_mappings 同步到 Doris
- 查询密集的接口（events、stats、dual-run）走 Doris
- 写入和事务性操作仍走 MySQL

**方案 B：完全迁移**
- 手动在 Doris 上用 `CREATE TABLE` 建表（无 AutoMigrate）
- 修改 `store.go` 切换 DSN 到 Doris
- 删除所有 JSON 列改为 text/varchar
- 删除所有 `DELETE ... JOIN` 改为子查询形式

**用户选择方案 B：完全迁移**

注意事项：
- **不用 AutoMigrate**：在 Doris 上手动建表（`backend/migrations/doris_init.sql`），GORM 仅用于 CRUD
- **删除 JSON 列**：Doris 支持 JSON 类型但有限，改用 `TEXT`/`VARCHAR`（model 结构 tag 中 `type:json` → `type:text`）
- **删除 DELETE...JOIN 语法**：`store.go` 里 `DELETE m1 FROM ... INNER JOIN m2 ON ...` 改为 `DELETE FROM metric_definitions WHERE id NOT IN (SELECT MAX(id) FROM ... GROUP BY metric_name)` 形式
- **DSN 格式**：Doris 完全兼容 MySQL 协议，`gorm.io/driver/mysql` 不变，只修改 DSN 指向 `doris-fe.venus.sohurdc.com:9030`
- **Database**：`alert_shadow`（原 `alert_migration`）

### 实现步骤（方案 B）
1. 编写 `backend/migrations/doris_init.sql`：所有表的 Doris CREATE TABLE（含 ENGINE=OLAP, DISTRIBUTED BY, PROPERTIES）
2. 修改所有 model JSON 列为 TEXT
3. 修改 `store.go` 中 DELETE...JOIN 语句为 Doris 兼容语法
4. 修改 `backend/configs/config.yaml` DSN 指向 Doris
5. 数据从 MySQL 导出（mysqldump 或 SELECT INTO OUTFILE），通过 Doris Stream Load 导入

### Doris 建表示例
```sql
CREATE TABLE alert_shadow.alert_events (
    id          BIGINT NOT NULL,
    source      VARCHAR(20),
    trigger_id  VARCHAR(64),
    rule_id     BIGINT,
    event_time  DATETIME,
    status      VARCHAR(20),
    value_str   VARCHAR(255),
    component   VARCHAR(64),
    created_at  DATETIME
)
ENGINE=OLAP
DUPLICATE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 4
PROPERTIES("replication_num"="1");
```

---

## 迭代四：前端重构

### 品牌重命名
- 应用名称：`Alert Migration Platform` → `SRE Copilot`
- 修改 `frontend/index.html`、`App.vue`、sidebar 标题

### 新增页面/路由
```
/ssh-hosts      # 主机列表管理（查看/添加 SSH 主机清单）
/ssh-audit      # SSH 审计日志（命令执行历史）
/ssh-approvals  # 待审批命令列表（SRE 手动审批灰色命令）
/skills         # Skill 列表（查看已加载的排障技能）
```

### 现有功能归类（侧边栏分组）
```
▼ 告警迁移
    规则管理 /rules
    指标元数据 /metrics
    告警事件 /events
    双跑统计 /stats
▼ SRE 排障
    对话助手 /chat
    SSH 主机 /ssh-hosts
    命令审计 /ssh-audit
    待审批 /ssh-approvals
▼ 运维技能
    技能库 /skills
▼ 数据分析
    PromQL 查询 /query
```

---

## 关键文件路径

修改现有文件：
- `backend/internal/agent/master_agent.go` — 注入 SSH tools + skill middleware
- `backend/internal/store/store.go` — 添加 Doris Store 初始化
- `backend/go.mod` — 升级 eino v0.7.22 → v0.7.36
- `backend/configs/config.yaml` — 新增 ssh/skill/doris 配置节
- `backend/cmd/server/main.go` — 注册新 handler、初始化 SSHPool + RuleEngine

新增文件：
- `backend/internal/ssh/pool.go` + `executor.go`
- `backend/internal/rule/engine.go`
- `backend/internal/tools/ssh_tools.go`
- `backend/internal/handler/ssh_handler.go` + `skill_handler.go`
- `backend/internal/agent/skill_manager.go`
- `backend/skills/<name>/SKILL.md`（5-6 个运维技能）
- `backend/migrations/doris_init.sql`

---

## 验证方案

### 迭代一验证
1. 启动 server，在 `/chat` 问："帮我查看 dnn130160 的 CPU 使用情况"
2. 预期：Master Agent 调用 `exec_cmd(target_host="dnn130160", command="top -bn1 | head -20")`
3. 验证审计日志写入 `audit_logs` 表
4. 尝试执行黑名单命令如 `rm -rf /`，验证被 REJECTED

### 迭代二验证
1. `GET /api/v1/skills` 返回已加载的 skill 列表
2. 在 `/chat` 问："使用 cpu-diagnosis 技能分析 dnn130160 的 CPU 问题"
3. 预期：Agent 调用 skill tool 加载 cpu-diagnosis SKILL.md，再结合 exec_cmd 执行诊断命令

### 迭代三验证
1. 执行 `doris_init.sql` 建表
2. 后台 DorisSync Job 启动后，`alert_events` 数据同步到 Doris
3. `/api/v1/events` 接口查询结果与 MySQL 一致，检查响应时间（Doris 应更快）

### 迭代四验证
1. 前端页面标题显示 "SRE Copilot"
2. 侧边栏分组正确显示
3. `/ssh-audit` 页面可查看命令执行历史