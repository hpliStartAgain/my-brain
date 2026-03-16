## 事故描述

在对 ATS（Application Timeline Server）高可用方案的 Keepalived 实例进行独立化迁移操作时，由于操作顺序错误，导致两个 Keepalived 进程同时管理同一个 VRRP 实例（virtual_router_id 54），引发 VRRP 选举冲突。冲突期间 `notify_handler.sh` 被反复触发，通过 Ambari REST API 多次异步执行 ATS 停止操作，造成 ATS 服务反复重启约 5 分钟。

更严重的是，Ambari 在重启 ATS 过程中重新生成了 ATS 所在主机的 `yarn-site.xml` 配置文件，将 Ambari 中 `h3 timeline` 配置组中遗留的错误 ResourceManager 地址（`rtrm*.venus.sohurdc.com`）覆盖到磁盘上。此后，该主机上的 HiveServer2 创建新 Tez Session 时读取了错误的 RM 地址，导致所有通过该 HS2 提交的 Tez 作业因无法正确注册到 ResourceManager 而全部失败。

## 事故处理过程

|时间|操作|
|---|---|
|2026-02-09 18:44|在主节点 dsrv014022 执行 Keepalived 迁移操作，**错误地**先启动了新的 `keepalived-ats` 进程，再从旧 `keepalived` 进程中移除 VI_2 配置|
|2026-02-09 18:44:56|两个 Keepalived 进程同时声明 `virtual_router_id 54`，VRRP 选举开始翻转，`notify_handler.sh` 被反复触发，多次通过 Ambari 发送异步 STOP ATS 请求|
|2026-02-09 18:45:01|`ats-ha-manager` 水平触发机制检测到 ATS 未运行，尝试通过 Ambari 启动 ATS。但之前的异步 STOP 请求陆续到达，ATS 进入反复 stop/start 循环|
|2026-02-09 18:46:21|从旧 Keepalived 配置中移除 VI_2 并 reload，VRRP 冲突解除|
|2026-02-09 ~18:50|`ats-ha-manager` 水平触发机制自动恢复 ATS 服务，ATS 本身恢复正常|
|2026-02-09 ~18:50|开始接到大面积 Tez 作业失败报告，错误为 `InvalidToken: appattempt_xxx not found in AMRMTokenSecretManager`|
|2026-02-09 ~19:05|排查发现 Tez AM 连接的 RM 地址为 `rtrm2.venus.sohurdc.com`（错误），而非正确的 `drm` 系列地址|
|2026-02-09 ~19:15|定位到 Ambari 中 `h3 timeline` 配置组存在 2024 年遗留的错误 RM 地址覆盖，Ambari 重启 ATS 时将该错误配置刷入了主机的 `yarn-site.xml`|
|2026-02-09 ______|在 Ambari 中修正 `h3 timeline` 配置组的 RM 地址，重新部署配置，恢复服务（请补充实际时间）|

## 具体原因

本次事故由**两个独立问题叠加**导致：

### 直接原因 1：Keepalived 迁移操作顺序错误

在主节点执行 Keepalived 独立实例迁移时，采用了"先启动新进程，再摘除旧配置"的错误顺序：

```
错误顺序:
  ① systemctl start keepalived-ats    ← 新进程启动，声明 virtual_router_id 54
  ② 此时旧进程仍管理 virtual_router_id 54  ← 两个进程冲突！
  ③ 从旧配置移除 VI_2，reload         ← 冲突解除，但 STONITH 已触发多次

正确顺序（事后确认）:
  ① systemctl stop ats-ha-manager     ← 防止自愈干扰
  ② 从旧配置移除 VI_2，reload         ← 旧进程释放 virtual_router_id 54
  ③ systemctl start keepalived-ats    ← 新进程独占 virtual_router_id 54
  ④ systemctl start ats-ha-manager    ← 恢复自愈
```

两个 Keepalived 进程在同一台主机上同时声明同一个 `virtual_router_id`，导致 VRRP 选举来回翻转。每次状态变化都触发 `notify_handler.sh`，其中 STONITH 逻辑通过 Ambari REST API 异步发送 ATS STOP 请求。由于 Ambari API 是异步的，多个 STOP 请求在队列中排队，即使 ATS 被 `ats-ha-manager` 重新拉起后，之前的 STOP 请求仍会陆续执行，导致 ATS 反复被杀停。

### 直接原因 2：Ambari 配置组中遗留的错误 RM 地址

Ambari 中 `h3 timeline` 主机级配置组（应用于 ATS 所在主机 dsrv014022/dsrv014020）的 `yarn-site` 配置中，ResourceManager 相关地址在 **2024 年**被错误修改为 `rtrm*.venus.sohurdc.com`（旧集群/测试集群地址），而正确地址应为 `drm*.venus.sohurdc.com`。

此前 ATS 未被重启过，主机磁盘上的 `yarn-site.xml` 仍保留着正确的配置，因此该错误配置一直未生效。

### 因果链

```
Keepalived 迁移操作顺序错误
  → 两个 Keepalived 进程 VRRP 选举冲突 (virtual_router_id 54)
  → notify_handler.sh 被反复触发，多次通过 Ambari 异步 STOP ATS
  → Ambari 反复重启 ATS
  → Ambari 重启 ATS 时重新生成 yarn-site.xml
  → h3 timeline 配置组中 2024 年遗留的错误 RM 地址被刷入磁盘
  → HiveServer2 新建 Tez Session 时读取了错误的 yarn-site.xml
  → Tez AM 连接到 rtrm（错误 RM）而非 drm（正确 RM）
  → RM 不认识该 AM 的 Token → InvalidToken 报错
  → 大面积 Tez 作业失败
```

## 影响范围

|影响项|详情|
|---|---|
|**ATS 服务中断**|约 5 分钟（18:44 ~ 18:50），ATS 被反复 stop/start|
|**Tez 作业大面积失败**|从 18:45 开始至修复完成，所有通过受影响 HS2 提交的 Tez 作业均失败|
|**受影响 HS2**|运行在 dsrv014022（或 dsrv014020）上的 HiveServer2 实例|
|**影响用户**|所有通过该 HS2 VIP（10.18.14.253）提交 Hive 查询的业务方|
|**未受影响**|其他 HS2 实例、直接提交到 YARN 的 Spark/MR 作业、RM 本身|

## 事故复盘

### 1. 操作前未充分评估风险

- 迁移指引中"先启新进程再摘旧配置"的方案未经验证
- 未考虑同一 `virtual_router_id` 在同一主机上被两个进程同时管理的后果
- 未评估 `notify_handler.sh` 中 STONITH 通过 Ambari 异步 API 执行带来的延迟副作用

### 2. 迁移前未停止 ats-ha-manager

- `ats-ha-manager` 的自愈机制在迁移期间持续运行
- 自愈机制与 STONITH 的异步 STOP 操作形成交叉干扰，放大了故障影响

### 3. Ambari 配置组中存在长期遗留的错误配置

- 2024 年修改的 `h3 timeline` 配置组中错误的 RM 地址（`rtrm` → 应为 `drm`）一直未被发现
- 由于 ATS 长期未重启，磁盘配置与 Ambari 配置不一致的问题被隐藏
- 缺乏 Ambari 配置组的定期审计机制

### 4. 缺少操作前的配置一致性检查

- 未在迁移前检查 Ambari 中 ATS 相关主机的配置组是否与实际一致
- 未检查 Ambari 重启服务是否会覆盖磁盘上的配置文件

## 后续措施

### 立即修复

|措施|负责人|截止时间|
|---|---|---|
|修正 Ambari 中 `h3 timeline` 配置组的 RM 地址为 `drm*`|（请填写）|立即|
|重新部署正确配置到 ATS 主机|（请填写）|立即|
|验证 HS2 提交的 Tez 作业恢复正常|（请填写）|立即|

### 短期改进

|措施|负责人|截止时间|
|---|---|---|
|更新 Keepalived 迁移指引，修正操作顺序为"先摘旧再启新"，新增血泪教训章节|（请填写）|已完成|
|审计所有 Ambari 主机级配置组，确认是否有其他遗留的错误覆盖配置|（请填写）|1 周内|
|为 ATS 主机的 `yarn-site.xml` 添加配置一致性巡检（比对磁盘配置与 Ambari 配置）|（请填写）|2 周内|

### 长期改进

| 措施                                                            | 负责人   | 截止时间  |
| ------------------------------------------------------------- | ----- | ----- |
| Keepalived 迁移操作纳入变更管理流程，需提前在测试环境验证                            | （请填写） | 1 个月内 |
| 为 `notify_handler.sh` 的 STONITH 操作增加防抖机制（debounce），避免短时间内重复触发 | （请填写） | 2 周内  |
| 考虑将 ATS 的 Ambari 管理改为 systemd 直接管理，避免 Ambari 重启时覆盖配置          | （请填写） | 评估中   |
| 建立 Ambari 配置组变更审计日志，记录谁在何时修改了什么配置                             | （请填写） | 1 个月内 |