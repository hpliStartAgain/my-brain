---
title: Clash TUN redir-host 缓存导致 IP 请求被重路由根因分析
date: 2026-05-06
tags:
  - 网络
  - Clash
  - TUN
  - 故障分析
---

## 问题现象

在 MacBook 上通过 FlClash（TUN 模式）访问内网 IP `10.18.102.127`（SCLB 新网关 VIP）时，实际请求被路由到了 `10.18.14.11`（旧 dproxy nginx），导致返回 RHEL 默认 nginx 404 页面，而非 APISIX 的响应。

其他环境（Linux 服务器、手机）访问同一 IP 均正常返回 APISIX 响应。

---

## 根因分析

### 1. Clash TUN redir-host 工作原理

Clash TUN 模式在 L3（网络层）劫持所有出站 TCP 流量。为了识别连接对应的域名（以便匹配基于域名的规则），Clash 使用 **redir-host** 机制：

```
TCP 连接进入 TUN 接口
    │
    ├─ Clash 从 HTTP 请求的 Host 头 / TLS ClientHello SNI 中提取域名
    │  ↓
    ├─ 在内存缓存中记录: IP → 域名  （e.g. 10.18.102.127 → dproxy.venus.sohurdc.com）
    │  ↓
    └─ 后续该 IP 的请求: 先查缓存找到域名 → 重新 DNS 解析 → 连接到新解析结果
```

### 2. 缓存是如何被污染的

**触发时机**：用户此前在 `/etc/hosts` 中加入了条目：
```
10.18.102.127   dproxy.venus.sohurdc.com
```

访问 `http://dproxy.venus.sohurdc.com/...` 时：
- OS DNS（含 /etc/hosts）解析 `dproxy.venus.sohurdc.com` → `10.18.102.127`
- TCP 连接建立到 `10.18.102.127:80`
- HTTP 请求带有 `Host: dproxy.venus.sohurdc.com`
- Clash TUN 读取 Host 头，**在内存中记录缓存**：`10.18.102.127 → dproxy.venus.sohurdc.com`

### 3. /etc/hosts 条目删除后触发问题

删掉 `/etc/hosts` 条目后：
- **真实 DNS** 解析 `dproxy.venus.sohurdc.com` → `10.18.14.11`（旧 dproxy）
- **FlClash 内存缓存仍然存在**：`10.18.102.127 → dproxy.venus.sohurdc.com`

此后访问 `http://10.18.102.127/...` 的完整流程：

```
curl/浏览器 发起 TCP 连接到 10.18.102.127:80
    │
    ▼
Clash TUN 拦截
    │
    ├─ 查缓存：10.18.102.127 → dproxy.venus.sohurdc.com  ← 缓存命中（已过时！）
    │
    ├─ 重新 DNS 解析：dproxy.venus.sohurdc.com → 10.18.14.11（真实 DNS 结果）
    │
    └─ DIRECT 直连 10.18.14.11:80 → RHEL nginx 默认页 ← 请求被路由到错误主机
```

> [!WARNING]
> IP-CIDR 规则（含 `no-resolve`）和 DOMAIN-SUFFIX 规则**均无法阻止**这一行为。
> 因为 redir-host 的 IP→域名映射发生在规则匹配**之前**，规则评估时目标已经是 `dproxy.venus.sohurdc.com`，最终 DIRECT 到重新解析后的 `10.18.14.11`。

---

## 解决方案

### 根治（推荐）：重启 FlClash 清空缓存

完全退出 FlClash（而非最小化），重新启动，内存中的 redir-host 映射缓存随进程一起清空。

此后访问 `10.18.102.127` 时，Clash 无法在缓存中找到对应域名，直接以 IP 匹配 `IP-CIDR,10.18.0.0/16,DIRECT,no-resolve` 规则，正确路由到 SCLB。

### 预防：避免 /etc/hosts 与 Clash TUN 混用

在 Clash TUN redir-host 模式下修改 `/etc/hosts` 后，**必须重启 Clash** 才能使旧映射缓存失效，否则旧 IP→域名 映射会持续生效直到进程退出。

若需临时绕过，可使用：

```bash
# 强制走物理网卡 en0，绕过 TUN 接口
curl --interface en0 http://10.18.102.127/...
```

---

## 关键结论

| 方面 | 结论 |
|---|---|
| SCLB 状态 | 完全正常，APISIX 3.13.0 运行中，21 条路由全部发布 |
| 问题类型 | 纯本地网络配置问题，与 SCLB 无关 |
| 根因 | Clash TUN redir-host 进程内存缓存 IP→域名 映射过期 |
| 触发条件 | 修改 /etc/hosts 后删除条目，但未重启 Clash |
| 修复方法 | 重启 FlClash 清空内存缓存 |
| 复现条件 | Clash TUN redir-host 模式 + 手动修改 /etc/hosts 涉及同一域名 |
