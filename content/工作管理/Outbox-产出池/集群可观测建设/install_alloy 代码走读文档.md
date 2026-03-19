
> 面向 Salt 零基础读者，逐文件、逐代码片段解释每一行的含义与作用。

---

## 前置知识：理解这个模块需要知道的 4 个概念

### 概念 1：Salt 是什么？

Salt（SaltStack）是一个**批量运维工具**。你在一台"主控机"（Salt Master）上写好脚本，就可以同时下发到几十、几百台"受控机"（Salt Minion）上执行。

类比：如果你要在 100 台服务器上安装同一个软件，手动 SSH 过去一台台装太慢，Salt 让你写一个脚本，一条命令批量完成。

```
你的电脑
  └── Salt Master（主控机，写脚本的地方）
        ├── Minion: hadoop-nn-01（受控机，被执行的地方）
        ├── Minion: hadoop-dn-01
        └── Minion: clickhouse-01
```

### 概念 2：State（状态文件 `.sls`）是什么？

Salt 脚本叫 **State**，文件扩展名是 `.sls`（SaLt State）。

State 描述的不是"步骤"，而是"**期望状态**"：
- 不是说"运行 apt install nginx"
- 而是说"nginx 应该处于已安装状态"

Salt 会检查当前状态，只在需要时才执行操作。所以同一个 State 可以反复执行，不会出问题，这叫**幂等性**。

```yaml
# 示例：这段 State 的意思是"确保 /tmp/hello.txt 文件存在，内容是 hello"
my_file:              # ← 这是状态的 ID（名字），随便取，必须唯一
  file.managed:       # ← 调用 file 模块的 managed 函数
    - name: /tmp/hello.txt
    - contents: hello
```

### 概念 3：Pillar（配置数据）是什么？

Pillar 是 Salt 的**配置数据仓库**，用 YAML 格式存储变量。

类比：如果 State 是代码，Pillar 就是配置文件。把"哪台机器装什么、装到哪里、用什么参数"这些数据写在 Pillar 里，State 去读取它。

这样做的好处是：代码（State）不变，只改数据（Pillar），就能让不同机器有不同行为。

```yaml
# Pillar 示例
alloy:
  binary_path: /usr/local/bin/alloy
  loki_url: http://loki-server/loki/api/v1/push
```

State 读取 Pillar 的语法：
```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set binary_path = alloy.get('binary_path', '/usr/local/bin/alloy') %}
```

### 概念 4：Jinja 模板是什么？

Jinja 是 Salt 内置的**模板引擎**，让 `.sls` 文件支持变量、条件判断、循环。

语法规则：
- `{% ... %}` ：逻辑代码（赋值、if、for）
- `{{ ... }}` ：输出变量的值
- `{# ... #}` ：注释（不会输出到结果）

```jinja
{% set name = "world" %}    {# 赋值 #}
Hello, {{ name }}!          {# 输出：Hello, world! #}

{% if name == "world" %}    {# 条件 #}
  This is public.
{% endif %}
```

---

## 模块文件总览

```
src/install_alloy/
├── init.sls                              ← 模块入口（执行 state.apply install_alloy 时首先执行这个）
├── install_alloy.sls                     ← 核心安装逻辑（最重要的文件）
├── start_alloy.sls                       ← 启动服务
├── stop_alloy.sls                        ← 停止服务
├── status_alloy.sls                      ← 查看服务状态
├── files/
│   ├── config.alloy.jinja                ← Alloy 采集配置模板
│   └── alloy.service.jinja               ← systemd 服务单元模板
└── _pillar/
    ├── top.sls                           ← Pillar 分发规则（谁用哪个 Pillar）
    └── install_alloy/
        └── install_alloy.sls             ← 实际的配置数据（变量值）
```

执行流程一句话概括：

> 运维人员在 Salt Master 执行命令 → Salt 读取 Pillar 数据 → 渲染 Jinja 模板 → 在目标机器上创建文件、用户、目录、启动服务

---

## 第一部分：Pillar 配置数据

### 文件：`_pillar/top.sls`

```yaml
base:        # ← "base" 是 Salt 的默认环境名，固定写法
  "*":       # ← 目标匹配规则，"*" 表示匹配所有 Minion
    - install_alloy.install_alloy
    # ↑ 告诉 Salt：对所有机器，都加载 install_alloy/install_alloy.sls 这个 Pillar 文件
```

**作用**：这是 Pillar 的"路由表"，决定哪些机器能看到哪些配置数据。

`install_alloy.install_alloy` 是 Salt 模块路径写法，等价于文件路径 `install_alloy/install_alloy.sls`（用 `.` 代替 `/`）。

---

### 文件：`_pillar/install_alloy/install_alloy.sls`

这是整个模块最重要的配置文件，**你上线前需要修改的所有内容都在这里**。

#### 第一段：安装包配置

```yaml
alloy:                     # ← 顶层 key，所有配置都嵌套在 alloy 下
  binary_url: https://sohu-bd-devops.bjcnc.scs.sohucs.com/K8S/alloy/alloy-linux-amd64-v1.5.0
  # ↑ Alloy 二进制文件的下载地址。URL 中带了版本号 v1.5.0，
  #   好处：升级时改这里，旧版本 URL 保留可回滚，也能审计"现在装的哪个版本"

  binary_hash: sha256=<替换为实际二进制的sha256哈希值>
  # ↑ 二进制文件的 sha256 指纹（哈希值）
  #   Salt 下载完文件后会计算哈希，和这里的值对比
  #   如果不一致说明文件被篡改，安装会立即终止
  #   获取方式：在能下载到文件的机器上运行：sha256sum alloy-linux-amd64-v1.5.0

  binary_path: /usr/local/bin/alloy
  # ↑ 二进制安装到目标机器的路径

  config_dir: /etc/alloy
  # ↑ 配置文件目录（遵循 Linux FHS 规范，/etc 存放配置）

  config_file: /etc/alloy/config.alloy
  # ↑ 配置文件完整路径

  storage_path: /var/lib/alloy
  # ↑ Alloy 的数据目录（存放 WAL 预写日志，防止日志丢失）
  #   WAL = Write-Ahead Log，Alloy 先把日志写到磁盘，确认发送成功后再删除
  #   这样即使网络中断，重连后日志仍可补发
```

#### 第二段：服务配置

```yaml
  service_name: alloy
  # ↑ systemd 服务名，对应 systemctl start alloy / systemctl status alloy

  service_unit_path: /etc/systemd/system/alloy.service
  # ↑ systemd unit 文件的存放路径
  #   systemd 是 Linux 的进程管理器，通过 unit 文件知道如何启动/停止这个服务

  service_user: alloy
  service_group: alloy
  # ↑ Alloy 进程的运行用户和组
  #   使用专用低权限用户，不用 root，遵循最小权限原则
  #   alloy 用户没有 shell（/sbin/nologin），无法直接登录，更安全
```

#### 第三段：Loki 输出配置

```yaml
  loki_url: http://write.grafana-loki.sohucs.com/loki/api/v1/push
  # ↑ 日志要发送到哪里。Loki 是 Grafana 旗下的日志聚合系统
  #   /loki/api/v1/push 是 Loki 接收日志的 HTTP API 路径

  tenant_id: <替换为实际Loki租户ID>
  # ↑ Loki 多租户隔离的标识符
  #   一个 Loki 实例可以服务多个团队，通过 tenant_id 区分
  #   每个请求带上这个 ID，Loki 就知道这条日志属于哪个团队
```

#### 第四段：资源限制

```yaml
  cpu_quota: 50%
  # ↑ Alloy 最多使用 50% 的 CPU
  #   通过 Linux cgroup 强制执行，超过会被内核限速，不会饿死其他进程

  memory_limit: 512M
  # ↑ Alloy 最多使用 512MB 内存，超过会被内核 OOM Kill 后自动重启

  nofile_limit: 65536
  # ↑ Alloy 进程最多同时打开 65536 个文件描述符（file descriptor）
  #   Linux 默认只有 1024 个，但日志采集需要同时 tail 很多文件
  #   每个 tail 的文件都占一个 fd，所以需要调高这个限制
```

#### 第五段：日志采集任务

日志采集任务分为三层，每一层都是一个"任务列表"（YAML 数组）：

```yaml
  default_jobs:          # ← 所有机器都会生效的任务
    - name: system_logs  # ← 任务名（唯一标识）
      service_name: linux-system   # ← 写入 Loki 的服务名标签
      paths:
        - /var/log/messages        # ← 采集这个文件（支持 glob 通配符）
      labels:
        cluster: H3离线            # ← 自定义标签，会附加在每条日志上
        role: linux-base           # ← 标签用于在 Grafana 里过滤/搜索

  extra_jobs: []         # ← 所有机器统一追加的额外任务，当前为空

  host_jobs:             # ← 按主机名指定的差异化任务
    hadoop-nn-01:        # ← 只有 minion id 等于 hadoop-nn-01 的机器才会采集
      - name: hadoop_namenode
        service_name: hadoop-hdfs
        paths:
          - /var/log/hadoop/hdfs/hadoop-hdfs-namenode-*.log
          # ↑ * 是通配符，会匹配所有以 hadoop-hdfs-namenode- 开头的 .log 文件
          - /var/log/hadoop/hdfs/gc.log-*
          # ↑ gc.log-* 会匹配 gc.log-1, gc.log-2 这样的滚动日志文件
        labels:
          cluster: H3离线
          role: namenode
        multiline:
          firstline: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'
          # ↑ 多行日志合并配置。Java 程序的异常堆栈会跨多行，例如：
          #   2024-01-01 10:00:00 ERROR NullPointerException    ← 第 1 行（首行）
          #     at com.example.Foo.bar(Foo.java:42)             ← 第 2 行（属于上面的错误）
          #     at com.example.Main.main(Main.java:10)          ← 第 3 行（同上）
          #   这个正则匹配"以日期时间开头的行"作为一条新日志的开始
          #   \\d{4} 匹配 4 个数字（年份），\\d{2} 匹配 2 个数字（月/日/时/分/秒）
          max_wait_time: 3s
          # ↑ 等待多行合并的最大时间，超过 3 秒强制提交，避免日志卡住不上报
```

不同服务的 `multiline.firstline` 正则有细微差异：

| 服务 | 日志格式示例 | 正则 |
|------|------------|------|
| Hadoop/Hive/YARN | `2024-01-01 10:00:00` | `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}` |
| Doris | `2024-01-01` | `^\d{4}-\d{2}-\d{2}` |
| ClickHouse | `2024.01.01` | `^\d{4}\.\d{2}\.\d{2}` |

---

## 第二部分：State 状态文件

### 文件：`init.sls`（模块入口）

```yaml
include:
  - install_alloy.install_alloy
  # ↑ 把另一个 State 文件的内容"包含"进来
  #   install_alloy.install_alloy 对应文件 install_alloy/install_alloy.sls
```

**作用**：当用户执行 `salt '目标' state.apply install_alloy` 时，Salt 首先加载的就是 `init.sls`。这个文件什么都不做，只是"转发"到真正干活的 `install_alloy.sls`。

这种设计让模块入口保持简洁，以后如果需要安装前做检查，只需在这里加 include，不改核心逻辑。

---

### 文件：`install_alloy.sls`（核心安装逻辑）

这是整个模块最复杂的文件，包含 9 个 State 块，按依赖顺序执行。

#### 第一段：读取 Pillar 数据，定义变量

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
```

- `salt['pillar.get']` ：调用 Salt 内置函数读取 Pillar 数据
- `'alloy'` ：读取 Pillar 中 key 为 `alloy` 的那一段数据
- `{}` ：默认值，如果 Pillar 里没有 `alloy` 这个 key，就返回空字典

执行后，`alloy` 变量就是整个 Pillar 配置字典。

```jinja
{% set binary_url = alloy.get('binary_url', 'https://...') %}
{% set binary_path = alloy.get('binary_path', '/usr/local/bin/alloy') %}
{% set binary_hash = alloy.get('binary_hash', '') %}
{% set config_dir = alloy.get('config_dir', '/etc/alloy') %}
{% set config_file = alloy.get('config_file', config_dir + '/config.alloy') %}
{% set storage_path = alloy.get('storage_path', '/var/lib/alloy') %}
{% set service_name = alloy.get('service_name', 'alloy') %}
```

每行都是同一个模式：`alloy.get('pillar中的key', '默认值')`

- 如果 Pillar 里配了这个值，就用 Pillar 里的
- 如果没配，就用默认值

注意 `config_file` 的默认值是 `config_dir + '/config.alloy'`，用了上面已经定义的 `config_dir` 变量，避免硬编码。

```jinja
{% set service_unit_name = service_name if '.' in service_name else service_name + '.service' %}
```

这是一个**内联条件表达式**（三元运算）：
- 如果 `service_name` 里已经包含 `.`（比如 `alloy.service`），就直接用
- 否则在后面加上 `.service`（比如 `alloy` → `alloy.service`）

目的：允许用户在 Pillar 里写 `alloy` 或 `alloy.service` 都可以正常工作。

```jinja
{% set service_user = alloy.get('service_user', 'alloy') %}
{% set service_group = alloy.get('service_group', 'alloy') %}
```

默认使用 `alloy` 低权限用户，而非 `root`。

---

#### 第二段：创建专用用户和组

```jinja
{% if service_user != 'root' %}
```

条件判断：**只有当运行用户不是 root 时**，才创建用户/组。

原因：如果用户在 Pillar 里配了 `service_user: root`，我们不能对 root 用户执行 `user.present`，因为会意外修改 root 的 shell 等属性。

```yaml
alloy_group:
  group.present:             # ← 调用 group 模块的 present 函数：确保组存在
    - name: {{ service_group }}
    - system: True           # ← 创建系统组（GID 在 1000 以下，不出现在登录用户列表）
```

`group.present` 是幂等的：如果组已存在，什么都不做；不存在才创建。

```yaml
alloy_user:
  user.present:              # ← 确保用户存在
    - name: {{ service_user }}
    - group: {{ service_group }}
    - system: True           # ← 系统用户（UID 在 1000 以下）
    - shell: /sbin/nologin   # ← 不能登录的 shell，防止有人用这个账号 SSH 进来
    - createhome: False      # ← 不创建家目录（/home/alloy），服务账号不需要
    - require:
      - group: alloy_group   # ← 依赖声明：必须先有组，才能创建用户
```

`require` 是 Salt 的**依赖关系声明**：告诉 Salt"在执行我之前，先确保 `alloy_group` 这个 State 成功执行"。

```jinja
{% endif %}
```

结束条件判断块。

---

#### 第三段：下载 Alloy 二进制文件

```yaml
alloy_binary:
  file.managed:              # ← file.managed：确保文件存在且内容正确
    - name: {{ binary_path }}        # ← 目标路径（目标机器上的路径）
    - source: {{ binary_url }}       # ← 来源（从哪下载）
```

`file.managed` 的工作逻辑：
1. 检查目标路径文件是否存在
2. 如果不存在，或内容与来源不同，则下载/覆盖
3. 如果已存在且内容相同，跳过（幂等）

```jinja
{% if binary_hash %}
    - source_hash: {{ binary_hash }}
{% else %}
    - skip_verify: True
{% endif %}
```

条件选择校验方式：
- **配了哈希**：使用 `source_hash` 校验，Salt 下载后会计算文件 sha256，与 Pillar 中的值对比，不一致则报错停止安装
- **没配哈希**：`skip_verify: True`，跳过校验（降级但不报错，保证向后兼容）

```yaml
    - user: root             # ← 文件属主是 root（二进制文件由 root 持有更安全）
    - group: root
    - mode: 755              # ← 权限 755 = rwxr-xr-x（所有人可执行，只有 root 可写）
    - makedirs: True         # ← 如果目标目录不存在，自动创建父目录
```

```jinja
{% if service_user != 'root' %}
    - require:
      - user: alloy_user     # ← 先确保 alloy 用户存在，再下载二进制
{% endif %}
```

这个 require 确保：如果用了自定义用户，必须先把用户创建好（后续目录要指定归属用户）。

---

#### 第四段：创建配置目录和数据目录

```yaml
alloy_config_directory:
  file.directory:            # ← file.directory：确保目录存在
    - name: {{ config_dir }}
    - user: {{ service_user }}     # ← 目录归属 alloy 用户（Alloy 进程需要写配置）
    - group: {{ service_group }}
    - mode: 750              # ← 750 = rwxr-x---（owner可读写执行，group可读执行，其他人无权限）
    - makedirs: True
```

注意 `mode: 750` 而非之前的 `755`：配置目录里可能有敏感信息（如 tenant_id），不让其他用户读取。

```yaml
alloy_storage_directory:
  file.directory:
    - name: {{ storage_path }}     # ← /var/lib/alloy，WAL 数据目录
    - user: {{ service_user }}
    - group: {{ service_group }}
    - mode: 750
    - makedirs: True
```

WAL（Write-Ahead Log）目录：Alloy 在把日志发给 Loki 前，先写入这个目录作为缓冲，确保网络抖动时日志不丢失。

---

#### 第五段：渲染并下发配置文件

```yaml
alloy_config_file:
  file.managed:
    - name: {{ config_file }}                           # ← /etc/alloy/config.alloy（目标路径）
    - source: salt://install_alloy/files/config.alloy.jinja  # ← 来源（Salt Master 上的模板）
    - template: jinja                                   # ← 告诉 Salt：这是 Jinja 模板，需要渲染
    - user: {{ service_user }}
    - group: {{ service_group }}
    - mode: 640              # ← 640 = rw-r-----（owner可读写，group只读，其他人无权限）
    - makedirs: True
    - require:
      - file: alloy_config_directory    # ← 先有目录，再创建文件
```

`salt://` 是 Salt 的特殊协议前缀，表示"从 Salt Master 的文件服务器上获取"。
这里的流程是：
1. Salt Master 读取 `config.alloy.jinja` 模板文件
2. 结合当前 Minion 的 Pillar 数据，渲染出最终配置内容
3. 把渲染结果传输到 Minion 的 `/etc/alloy/config.alloy`

---

#### 第六段：渲染并下发 systemd unit 文件

```yaml
alloy_systemd_unit:
  file.managed:
    - name: {{ service_unit_path }}                       # ← /etc/systemd/system/alloy.service
    - source: salt://install_alloy/files/alloy.service.jinja
    - template: jinja
    - user: root             # ← systemd unit 文件属于 root（系统层面的文件）
    - group: root
    - mode: 644              # ← 644 = rw-r--r--（所有人可读，只有 root 可写）
    - makedirs: True
    - require:
      - file: alloy_binary   # ← 先确保二进制存在，再写 unit（因为 unit 里引用了二进制路径）
```

---

#### 第七段：重新加载 systemd

```yaml
alloy_systemd_reload:
  cmd.run:                   # ← cmd.run：执行一个 shell 命令
    - name: systemctl daemon-reload
    # ↑ 告诉 systemd 重新读取所有 unit 文件
    #   每次修改 /etc/systemd/system/*.service 后都必须执行这一步
    #   否则 systemd 还在用内存里的旧版本 unit 定义
    - onchanges:
      - file: alloy_systemd_unit
    # ↑ onchanges：只在 alloy_systemd_unit 发生了变化时才执行
    #   如果 unit 文件没变（内容相同），这一步跳过，提高效率
    - require:
      - file: alloy_systemd_unit    # ← 必须先有 unit 文件，才能 reload
```

`onchanges` vs `require` 的区别：
- `require`：依赖关系，"执行我前先执行那个"
- `onchanges`：触发关系，"只在那个发生变化时才执行我"

---

#### 第八段：启动并管理服务

```yaml
alloy_service_running:
  service.running:           # ← service.running：确保服务处于运行状态
    - name: {{ service_name }}
    - enable: True           # ← 同时设置开机自启（等价于 systemctl enable alloy）
    - require:
      - file: alloy_binary
      - file: alloy_config_directory
      - file: alloy_storage_directory
      - file: alloy_config_file
      - file: alloy_systemd_unit
      - cmd: alloy_systemd_reload
    # ↑ require 列表：启动服务前，以上所有 State 都必须成功
    #   这确保了"先装好再启动"的顺序
    - watch:
      - file: alloy_binary
      - file: alloy_config_file
      - file: alloy_systemd_unit
      - cmd: alloy_systemd_reload
    # ↑ watch：监控这些 State，一旦它们中有任何一个发生了变化，
    #   就自动重启服务（restart），让新配置生效
```

`watch` 是 Salt 的核心机制之一：
- 当 `alloy_config_file` 的内容有变化（Pillar 改了）→ 自动重启 Alloy
- 当 `alloy_binary` 有变化（升级了）→ 自动重启 Alloy
- 当 `alloy_systemd_unit` 有变化（资源限制改了）→ 自动重启 Alloy

这意味着：运维人员只需要修改 Pillar、重新执行 `state.apply`，Alloy 就会用新配置重启，**无需手动 SSH 到机器上操作**。

---

### 文件：`start_alloy.sls`（启动服务）

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set service_name = alloy.get('service_name', 'alloy') %}
```

读取 Pillar，获取服务名（同 `install_alloy.sls` 开头）。

```yaml
alloy_service_start:
  service.running:
    - name: {{ service_name }}
    - enable: True           # ← 启动服务，并设置开机自启
```

**注意**：这个文件只有一个 State，不包含安装逻辑。
适用场景：服务已经安装过，但因为某种原因停掉了，需要重新拉起。
如果是全新机器，应先执行 `state.apply install_alloy`。

---

### 文件：`stop_alloy.sls`（停止服务）

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set service_name = alloy.get('service_name', 'alloy') %}
```

```yaml
alloy_service_stop:
  service.dead:              # ← service.dead：确保服务处于停止状态
    - name: {{ service_name }}
    # ↑ 注意：这里没有 enable: False
    #   停止服务 ≠ 禁用开机自启
    #   服务停了，下次重启机器 Alloy 仍会自动启动
    #   如果要永久禁用：需要手动执行 systemctl disable alloy
```

---

### 文件：`status_alloy.sls`（查看状态）

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set service_name = alloy.get('service_name', 'alloy') %}
{% set service_unit_name = service_name if '.' in service_name else service_name + '.service' %}
```

和 `install_alloy.sls` 里相同的处理：确保 `service_unit_name` 始终带 `.service` 后缀。

```yaml
alloy_service_status:
  cmd.run:
    - name: |
        systemctl --no-pager --full status {{ service_unit_name }} || true
        # ↑ 显示完整 systemd 服务状态
        #   --no-pager：不分页，直接输出所有内容
        #   --full：不截断长行
        #   || true：即使命令返回非零退出码（服务未运行时），Salt 也不报错
        systemctl is-enabled {{ service_unit_name }} || true
        # ↑ 输出：enabled / disabled / static
        systemctl is-active {{ service_unit_name }} || true
        # ↑ 输出：active / inactive / failed
```

`| ` 后面跟多行文本是 YAML 的**块标量语法**，允许写多行 shell 命令。
`cmd.run` 没有 `onchanges`，所以每次执行 State 都会运行，适合做状态检查。

---

## 第三部分：Jinja 模板文件

### 文件：`files/alloy.service.jinja`（systemd 服务单元模板）

这个文件渲染后会生成标准的 systemd unit 文件。

#### 变量声明段

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set binary_path = alloy.get('binary_path', '/usr/local/bin/alloy') %}
{% set config_dir = alloy.get('config_dir', '/etc/alloy') %}
{% set config_file = alloy.get('config_file', config_dir + '/config.alloy') %}
{% set storage_path = alloy.get('storage_path', '/var/lib/alloy') %}
{% set service_user = alloy.get('service_user', 'alloy') %}
{% set service_group = alloy.get('service_group', 'alloy') %}
{% set cpu_quota = alloy.get('cpu_quota', '50%') %}
{% set memory_limit = alloy.get('memory_limit', '512M') %}
{% set nofile_limit = alloy.get('nofile_limit', '65536') %}
```

从 Pillar 读取所有需要的变量。所有变量都有默认值，所以即使 Pillar 里某个字段忘了写，模板也能正常渲染。

#### `[Unit]` 段

```ini
[Unit]
Description=Grafana Alloy Telemetry Collector
Documentation=https://grafana.com/docs/alloy/
Wants=network-online.target
After=network-online.target
```

`[Unit]` 是 systemd unit 的元数据段：
- `Description`：服务描述，在 `systemctl status` 里显示
- `Documentation`：文档链接，供运维参考
- `Wants=network-online.target`：声明"我希望网络在线"（软依赖，网络没起来也会启动）
- `After=network-online.target`：声明"网络服务启动后再启动我"（顺序要求）

Alloy 需要网络是因为它要把日志发送到 Loki，没网络的话发送会失败，但先启动等网络就绪后自动重试也是可以的。

#### `[Service]` 段

```ini
[Service]
Type=simple
```

`Type=simple`：最常见的服务类型，意思是"启动命令本身就是服务主进程，前台运行"。不会 fork，不需要 PID 文件。

```ini
User={{ service_user }}    {# 渲染后：User=alloy #}
Group={{ service_group }}  {# 渲染后：Group=alloy #}
```

让 Alloy 以 `alloy` 用户身份运行，不是 root。

```ini
ExecStart={{ binary_path }} run {{ config_file }} --storage.path={{ storage_path }}
```

渲染后类似：
```
ExecStart=/usr/local/bin/alloy run /etc/alloy/config.alloy --storage.path=/var/lib/alloy
```

- `/usr/local/bin/alloy`：可执行文件路径
- `run`：Alloy 的子命令，表示"运行采集器"
- `/etc/alloy/config.alloy`：指定配置文件
- `--storage.path=/var/lib/alloy`：指定 WAL 数据目录

```ini
Restart=always
RestartSec=5
```

- `Restart=always`：无论什么原因退出（正常退出、崩溃、被 kill），systemd 都会重启
- `RestartSec=5`：重启前等待 5 秒，避免出错后疯狂重启消耗资源

```ini
LimitNOFILE={{ nofile_limit }}    {# 渲染后：LimitNOFILE=65536 #}
```

覆盖 Linux 默认的 1024 文件描述符限制。
为什么日志采集需要更多 fd：每个被 tail 的文件占用 1 个 fd，同时采集 50 个日志文件就需要至少 50 个 fd，加上内部管道、网络连接等，生产环境很容易超过 1024。

```ini
StandardOutput=journal
StandardError=journal
```

把 Alloy 自身的标准输出和错误输出写入 systemd journal（系统日志）。
这样当 Alloy 启动失败或运行异常时，可以用 `journalctl -u alloy -n 100` 查看原因。
不配这个的话，Alloy 的输出会被丢弃，无法排查问题。

```ini
CPUAccounting=true
CPUQuota={{ cpu_quota }}         {# 渲染后：CPUQuota=50% #}
MemoryAccounting=true
MemoryLimit={{ memory_limit }}   {# 渲染后：MemoryLimit=512M #}
```

- `CPUAccounting=true`：开启 CPU 用量统计（必须先开启才能限制）
- `CPUQuota=50%`：CPU 使用上限 50%，通过 Linux cgroup 强制执行
- `MemoryAccounting=true`：开启内存用量统计
- `MemoryLimit=512M`：内存上限 512MB，超过会被 OOM Kill，然后被 `Restart=always` 重启

#### `[Install]` 段

```ini
[Install]
WantedBy=multi-user.target
```

`[Install]` 段定义 `systemctl enable` 时的行为：
`WantedBy=multi-user.target` 表示"在多用户模式下（正常 Linux 运行级别）自动启动我"。
执行 `systemctl enable alloy` 后，会在 `/etc/systemd/system/multi-user.target.wants/` 目录下创建一个符号链接，机器启动进入多用户模式时自动启动 Alloy。

---

### 文件：`files/config.alloy.jinja`（Alloy 采集配置模板）

这个文件渲染后会生成 Grafana Alloy 的采集配置，是整个日志流的核心配置。

#### 变量声明段

```jinja
{% set alloy = salt['pillar.get']('alloy', {}) %}
{% set loki_url = alloy.get('loki_url', 'https://...') %}
{% set tenant_id = alloy.get('tenant_id', '') %}
{% set default_jobs = alloy.get('default_jobs', [{'name': 'system_logs', ...}]) %}
{% set extra_jobs = alloy.get('extra_jobs', []) %}
{% set host_jobs = alloy.get('host_jobs', {}).get(grains['id'], []) %}
```

关键行解释：

```jinja
{% set host_jobs = alloy.get('host_jobs', {}).get(grains['id'], []) %}
```

- `alloy.get('host_jobs', {})`：获取 Pillar 中的 `host_jobs` 字典（如不存在返回空字典）
- `.get(grains['id'], [])`：在这个字典里，用**当前机器的 minion id**（`grains['id']`）作为 key 查找
- 找不到就返回空列表 `[]`

**Grains** 是 Salt 自动采集的机器信息（主机名、IP、OS 版本等），`grains['id']` 就是这台机器的 minion id（通常是主机名）。

例如：在 `hadoop-nn-01` 上执行时，`grains['id']` = `"hadoop-nn-01"`，所以会取出 Pillar 中 `host_jobs.hadoop-nn-01` 下的任务列表。

```jinja
{% set jobs = default_jobs + extra_jobs + host_jobs %}
```

把三层任务合并成一个列表，后续只需遍历这个合并后的列表。

#### Loki 输出端点配置

```
loki.write "local_loki" {
    endpoint {
        url = "{{ loki_url }}"
        tenant_id = "{{ tenant_id }}"
    }
}
```

渲染后类似：
```
loki.write "local_loki" {
    endpoint {
        url = "http://write.grafana-loki.sohucs.com/loki/api/v1/push"
        tenant_id = "abc123"
    }
}
```

这是 Alloy 的配置语法（River 语言），定义了一个名为 `local_loki` 的输出组件。
`local_loki` 这个名字是任意的，后面的处理管道会引用它。

#### 循环生成每个 Job 的采集配置

```jinja
{% for job in jobs %}
{% set job_name = job.get('name', 'job_' ~ loop.index) %}
```

`loop.index` 是 Jinja for 循环的内置变量，表示当前是第几次循环（从 1 开始）。
如果 job 没有 `name` 字段（理论上不应该），就用 `job_1`、`job_2` 这样的名字。

```jinja
{% set token = job_name | replace('-', '_') | replace('.', '_') | replace(' ', '_') %}
```

`| ` 是 Jinja 的**过滤器（filter）**语法，类似管道。这行把 job_name 里的 `-`、`.`、空格都替换成 `_`。

为什么要替换？Alloy 的组件名不能包含这些特殊字符。
例如：`hadoop-namenode` → `hadoop_namenode`

#### 三个组件形成数据管道

每个 Job 会生成三个 Alloy 组件，形成一条数据流：

```
文件系统 → file_match（匹配文件）→ source.file（读取文件）→ process（处理/打标签）→ loki.write（发送）
```

**组件 1：文件匹配**

```
local.file_match "{{ token }}_match" {
    path_targets = [
{% for path in job.get('paths', []) %}
        {"__path__" = "{{ path }}"},
{% endfor %}
    ]
}
```

渲染后（以 hadoop_namenode 为例）：
```
local.file_match "hadoop_namenode_match" {
    path_targets = [
        {"__path__" = "/var/log/hadoop/hdfs/hadoop-hdfs-namenode-*.log"},
        {"__path__" = "/var/log/hadoop/hdfs/gc.log-*"},
    ]
}
```

`local.file_match` 组件的作用：扫描文件系统，找到匹配 glob 规则的文件，把它们的路径收集成一个列表（targets）。

**组件 2：日志读取**

```
loki.source.file "{{ token }}_src" {
    targets    = local.file_match.{{ token }}_match.targets
    forward_to = [loki.process.{{ token }}_proc.receiver]
}
```

渲染后：
```
loki.source.file "hadoop_namenode_src" {
    targets    = local.file_match.hadoop_namenode_match.targets
    forward_to = [loki.process.hadoop_namenode_proc.receiver]
}
```

- `targets`：引用上面 `file_match` 找到的文件列表
- `forward_to`：把读取到的日志行转发给下一个组件（process）

`loki.source.file` 持续 tail 这些文件，新产生的日志行会自动被捕获。

**组件 3：日志处理（打标签 + 多行合并）**

```
loki.process "{{ token }}_proc" {
    stage.static_labels {
        values = {
            instance = "{{ job.get('instance', grains['id']) }}",
            service_name = "{{ job.get('service_name', job_name) }}"
            {%- for label_name, label_value in job.get('labels', {}).items() %},
            {{ label_name }} = "{{ label_value }}"
            {%- endfor %}
        }
    }
```

`stage.static_labels` 给每条日志附加固定的标签（键值对）：
- `instance`：通常是主机名（`grains['id']`），标识日志来自哪台机器
- `service_name`：服务名，来自 Pillar 的 `job.service_name`
- 其余自定义标签：来自 Pillar 的 `job.labels`，如 `cluster`、`role`

这些标签会随日志一起存入 Loki，在 Grafana 里可以用来过滤查询。

```jinja
{% if job.get('multiline', {}).get('firstline') %}
    stage.multiline {
        firstline     = "{{ job.get('multiline', {}).get('firstline') }}"
        max_wait_time = "{{ job.get('multiline', {}).get('max_wait_time', '3s') }}"
    }
{% endif %}
```

条件块：只有当 Job 的 Pillar 里配了 `multiline.firstline` 时，才生成 `stage.multiline` 配置。

`stage.multiline` 的工作原理：
1. 读到一行日志，检查是否匹配 `firstline` 正则
2. 如果匹配：认为这是一条新日志的开始，把之前积累的多行合并提交
3. 如果不匹配：认为这行是上一条日志的继续，追加到缓冲区
4. `max_wait_time`：超过 3 秒还没等到下一条日志的开头行，强制提交当前缓冲区

```
    forward_to = [loki.write.local_loki.receiver]
}
```

处理完成后，把日志转发给最开始定义的 `local_loki` 输出组件，发送到 Loki。

```jinja
{% endfor %}
```

结束循环，`jobs` 列表里有多少个任务，就生成多少套这三个组件。

---

## 第四部分：执行流程全景

### 一次完整的 `state.apply install_alloy` 执行过程

```
运维人员执行：
salt 'hadoop-nn-01' state.apply install_alloy
        │
        ▼
Salt Master 处理：
1. 加载 init.sls → include install_alloy.sls
2. 读取 Pillar（install_alloy/install_alloy.sls）
3. 渲染 Jinja 模板（用 Pillar 数据填充变量）
4. 把 State 指令发送到 hadoop-nn-01
        │
        ▼
Salt Minion（hadoop-nn-01）按依赖顺序执行：

  [1] alloy_group         → 创建 alloy 组（已存在则跳过）
  [2] alloy_user          → 创建 alloy 用户（已存在则跳过）
  [3] alloy_binary        → 下载二进制，校验哈希（文件相同则跳过）
  [4] alloy_config_dir    → 创建 /etc/alloy（已存在则跳过）
  [5] alloy_storage_dir   → 创建 /var/lib/alloy（已存在则跳过）
  [6] alloy_config_file   → 渲染配置文件（内容相同则跳过，不同则覆盖）
  [7] alloy_systemd_unit  → 渲染 unit 文件（内容相同则跳过，不同则覆盖）
  [8] alloy_systemd_reload→ systemctl daemon-reload（unit 文件有变化才执行）
  [9] alloy_service_running→ 启动/保持服务运行，若[3][6][7][8]任一有变化则重启
        │
        ▼
Salt Master 汇总结果，输出每个 State 的执行结果（成功/跳过/失败）
```

### 数据流：日志从产生到入库

```
hadoop-nn-01 上的日志文件
/var/log/hadoop/hdfs/hadoop-hdfs-namenode-hadoop-nn-01.log
        │ 新写入一行日志（被 Alloy tail 捕获）
        ▼
Alloy: loki.source.file（读取）
        │ 原始日志行
        ▼
Alloy: loki.process（处理）
        │ 附加标签：instance=hadoop-nn-01, service_name=hadoop-hdfs, cluster=H3离线, role=namenode
        │ 多行合并：如果是 Java 堆栈，等待并合并多行为一条日志
        ▼
Alloy: loki.write（发送）
        │ HTTP POST /loki/api/v1/push，附带 tenant_id 请求头
        ▼
Grafana Loki（存储）
        │ 按标签索引存储
        ▼
Grafana（查询）
        用 LogQL 查询：{cluster="H3离线", role="namenode"} |= "ERROR"
```

---

## 第五部分：常见疑问

### Q1：为什么 Pillar 里改了 `host_jobs`，重新 apply 后配置就生效了？

因为 `alloy_config_file` 使用 Jinja 模板渲染，模板每次执行都会重新读取 Pillar。如果 Pillar 变了，渲染出的 `config.alloy` 内容就会不同，`file.managed` 检测到内容变化，就会覆盖文件。`alloy_service_running` 的 `watch` 检测到文件变化，就会重启 Alloy 加载新配置。

### Q2：`require` 和 `watch` 有什么区别？

```
require（依赖）：我执行前，你必须先成功执行
watch（监控）：你执行且内容发生变化时，重新执行我（对 service 来说是 restart）
```

### Q3：为什么 `onchanges` 和 `require` 同时写在 `alloy_systemd_reload` 上？

```yaml
alloy_systemd_reload:
  cmd.run:
    - onchanges:          # ← 只在 unit 文件内容变化时才执行
      - file: alloy_systemd_unit
    - require:            # ← 执行前必须保证 unit 文件已存在
      - file: alloy_systemd_unit
```

- `require` 保证"先有 unit 文件"（顺序保证）
- `onchanges` 保证"只在 unit 有变化时才 reload"（效率优化）

这两个条件都满足时才执行：unit 文件存在 **且** 内容有变化。

### Q4：为什么 `stop_alloy.sls` 里没有 `enable: False`？

停止服务（`service.dead`）和禁用开机自启（`enable: False`）是两件事：

- 临时维护：停止服务，但重启机器后希望服务自动恢复 → 只用 `service.dead`
- 永久下线：停止服务，且不希望它再自动启动 → 需要另外执行 `systemctl disable alloy`

之前的版本 `stop` 时会 `enable: False`，导致误操作重启机器后服务丢失。现在修正为只停止不禁用。

### Q5：`grains['id']` 是什么？怎么查看一台机器的 minion id？

```bash
# 在 Salt Master 上查看所有 minion 的 id
salt '*' grains.get id

# 在 Minion 上直接查看
salt-call grains.get id
```

minion id 通常就是机器的主机名，配置在 `/etc/salt/minion` 文件的 `id:` 字段，或自动使用主机名。`host_jobs` 里的 key **必须和这个值完全一致**。
