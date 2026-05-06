# FLClash TUN 模式下正确访问公司内网配置教程

> 适用场景：长期使用 TUN 虚拟网卡模式，同时需要正常访问公司内网域名（如 `*.sohu-inc.com`、`*.sohuno.com`、`*.sohurdc.com`）

---

## 🔍 问题根因

FLClash TUN 模式下有两层问题叠加：

1. **fake-ip 模式**：所有域名查询返回假 IP（198.18.x.x），DIRECT 路由时需要重新真实解析
2. **split-horizon DNS**：公司内网 DNS（10.2.166.x）只对来自内网真实 IP 的查询返回内网记录。TUN 开启后，DNS 查询也被 TUN 接口拦截，源 IP 变成虚拟网卡 IP（198.18.0.1），DNS 服务器不认识此 IP，返回 NXDOMAIN

**关键证据**：
- `dig @10.2.166.106 myfamily.sohu-inc.com`（TUN 开启）→ NXDOMAIN
- `dig @10.2.166.106 myfamily.sohu-inc.com`（关掉代理后）→ 10.2.176.19, 10.2.176.177 ✅

---

## ✅ 一、附加规则页面

**路径**：工具 → 附加规则

确认以下规则已存在（如没有则添加）。**顺序很重要，IP-CIDR 规则必须在最前面**：

| 规则                                    | 说明                                |
| ------------------------------------- | --------------------------------- |
| `IP-CIDR,10.0.0.0/8,DIRECT`          | ⚠️ **新增（放最顶部）**：所有内网 10.x.x.x 直连，确保 DNS 查询走物理网卡 |
| `IP-CIDR,172.16.0.0/12,DIRECT`       | ⚠️ **新增**：172.16-31.x.x 私网直连 |
| `IP-CIDR,192.168.0.0/16,DIRECT`      | ⚠️ **新增**：192.168.x.x 私网直连 |
| `DOMAIN,myfamily.sohu-inc.com,DIRECT` | 具体域名 DIRECT                       |
| `DOMAIN,code.sohuno.com,DIRECT`       | 具体域名 DIRECT                       |
| `DOMAIN-SUFFIX,sohuno.com,DIRECT`     | sohuno.com 所有子域 DIRECT            |
| `DOMAIN-SUFFIX,sohu-inc.com,DIRECT`   | sohu-inc.com 所有子域 DIRECT          |
| `DOMAIN-SUFFIX,sohurdc.com,DIRECT`    | ⚠️ **新增**：sohurdc.com 所有子域 DIRECT |

> IP-CIDR 规则放最前面，精确域名规则放在 SUFFIX 规则之前

---

## ✅ 二、DNS 页面配置

**路径**：工具 → DNS

### 2.1 开关设置

| 选项 | 操作 | 说明 |
|------|------|------|
| 覆写DNS | ✅ 保持开启 | 覆盖订阅配置中的 DNS |
| 状态 | ✅ 保持开启 | Clash 接管 DNS |
| 使用Hosts | ✅ 保持开启 | |
| 使用系统Hosts | ✅ 保持开启 | |
| **遵守规则** | ✅ **开启**（原来是关的） | DNS 解析跟随路由规则，DIRECT 域名用本地/内网 DNS |

### 2.2 Fakeip过滤

点击「Fakeip过滤」字段，添加以下条目（每行一条）：

```
+.sohuno.com
+.sohu-inc.com
+.sohurdc.com
```

> 作用：这些域名不分配假 IP，由系统/内网 DNS 直接解析真实 IP，避免 DIRECT 路由时找不到真实 IP

### 2.3 默认域名服务器

点击「默认域名服务器」，添加：

```
114.114.114.114
223.5.5.5
```

### 2.4 域名服务器策略（关键！）

点击「域名服务器策略」，添加以下映射（将公司内网域名强制走内网 DNS）：

| 域名匹配             | DNS 服务器                                     |
| ---------------- | ------------------------------------------- |
| `+.sohu-inc.com` | `10.2.166.106`, `10.2.166.105`, `10.18.2.1` |
| `+.sohuno.com`   | `10.2.166.106`, `10.2.166.105`, `10.18.2.1` |
| `+.sohurdc.com`  | `10.2.166.106`, `10.2.166.105`, `10.18.2.1` |

> 公共 DNS 无法解析内网域名，必须走内网 DNS 才能得到正确 IP

---

## ✅ 三、网络页面配置

**路径**：工具 → 网络

| 选项 | 操作 | 说明 |
|------|------|------|
| 虚拟网卡 (TUN) | ✅ 保持开启 | 全局流量接管 |
| 自动设置系统DNS | ✅ 保持开启 | 自动将系统 DNS 指向 Clash |
| **系统代理** | 🔘 可关闭（推荐） | TUN 已全局接管，关掉避免双重代理 |
| 栈模式 | `mixed`（保持）| mixed 兼容性最好 |

---

## ❓ 关于关闭系统代理后 git/IDEA 代理是否失效

**不需要修改 git 或 IDEA 的代理配置。**

- 「系统代理」关闭只是取消 macOS 系统层的代理设置
- FLClash 本地混合端口（默认 `7897`）**始终在监听**，只要 FLClash 进程在运行
- git 中配置的 `http.proxy=127.0.0.1:7897` 是**直接连接 Clash 进程**，与系统代理开关无关
- IDEA 中手动配置的代理同理

> 只有依赖「系统代理自动感知」的软件（未手动设置代理的浏览器等）才会受影响，而 TUN 模式已覆盖这类流量

---

## 📋 配置变更汇总

| 页面 | 修改项 | 变更 |
|------|--------|------|
| 附加规则 | 新增 `DOMAIN-SUFFIX,sohurdc.com,DIRECT` | 新增 |
| DNS | 遵守规则 | 关 → **开** |
| DNS | Fakeip过滤 | 空 → 加3条内网域名 |
| DNS | 默认域名服务器 | 空 → 114.114.114.114 / 223.5.5.5 |
| DNS | 域名服务器策略 | 空 → 加3条内网域名→内网DNS映射 |
| 网络 | 系统代理 | 开 → 关（可选） |

---

## 🔄 修改后验证

修改完成后重启 FLClash，然后测试：

```bash
# 测试内网域名能否正确解析
curl -I https://code.sohuno.com
curl -I https://myfamily.sohu-inc.com
curl -I https://panther.sohurdc.com

# 验证 panther.sohurdc.com 是否走 DIRECT（在 FLClash 连接日志中查看）
```

---

*最后更新：2026-04-30*
