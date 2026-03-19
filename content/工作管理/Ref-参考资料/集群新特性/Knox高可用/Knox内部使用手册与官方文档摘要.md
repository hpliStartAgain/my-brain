# Knox 官方文档与内部使用手册

> 来源：内部文档整理（2026-03）
> 用途：Knox 高可用改造参考材料

## 内容目录

- Knox 基本原理与文件目录解析（conf/、data/）
- gateway-site.xml 关键参数说明
- Topology 服务配置语法（venus.xml 样例）
- HA 支持说明（WEBHDFS HA、YARNUI HA）
- 用户密码管理（users.ldif / LDAP）
- 访问地址一览（正式环境 venus 集群）
- 常见报错处理（Kerberos impersonate、admin UI 白名单、SSL、hdfs UI 401）

## 关键结论（供快速回顾）

- Knox 无状态，水平扩展只需同步 `data/security/master` 和 `data/security/keystores/gateway.jks`
- `data/deployments/` 自动热生成，不需要同步
- Topology 变更后须删除 `data/deployments/{cluster_name}*` 并重启生效
- `gateway.dispatch.whitelist` 置 DEFAULT 会导致 admin UI 不可访问（域名访问需清空或调整）
- ssl.enabled=false 适用于内网场景，避免 PKIX path building failed 报错

## 原始文档

（完整文档已粘贴在 2026-03-19 对话记录中，以下为关键配置片段存档）

### 正式环境 knox 部署节点
- 节点：`dsrv014022.venus.sohurdc.com`
- 路径：`/opt/work/knox-2.0.0`（hdfs 用户）
- 代码库：`https://code.sohuno.com/bigdata-system-research/knox`，线上分支 `2.0.0-dev`

### 已验证访问地址
```
Knox Admin UI:    http://dsrv014022.venus.sohurdc.com:8443/gateway/manager/admin-ui
YARN UI:          http://dsrv014022.venus.sohurdc.com:8443/gateway/venus/yarn
JobHistory:       http://dsrv014022.venus.sohurdc.com:8443/gateway/venus/jobhistory
WebHDFS:          http://dsrv014022.venus.sohurdc.com:8443/gateway/venus/webhdfs/v1/?op=LISTSTATUS
```

### SCLB 平台说明
- 四层实例（IP 类型），TCP 协议
- 调度算法：加权轮询；健康检查：TCP 5s 间隔，连续 2 次失败摘除
- 规格选标准型（4C8G，6w 并发，5w QPS）
