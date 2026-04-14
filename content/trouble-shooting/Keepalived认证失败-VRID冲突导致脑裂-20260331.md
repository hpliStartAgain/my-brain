---
date: 2026-03-31
tags: [keepalived, vrrp, 高可用, 故障排查]
category: 网络故障
severity: P1
---

# Keepalived 认证失败 - VRID 冲突导致脑裂

## 故障现象

测试环境 ATS HA 集群（ht100185/ht100040）Keepalived 日志持续刷屏 `(VI_ATS) received an invalid passwd!`，并出现短暂的 MASTER/BACKUP 状态抖动。

```log
Mar 31 14:07:26 ht100185 Keepalived_vrrp[1860191]: (VI_ATS) received an invalid passwd!
Mar 31 14:07:59 ht100185 Keepalived_vrrp[1860191]: (VI_ATS) Receive advertisement timeout
Mar 31 14:07:59 ht100185 Keepalived_vrrp[1860191]: (VI_ATS) Entering MASTER STATE
Mar 31 14:07:59 ht100185 Keepalived_vrrp[1860191]: (VI_ATS) Master received advert from 10.18.100.40 with higher priority 100, ours 70
Mar 31 14:07:59 ht100185 Keepalived_vrrp[1860191]: (VI_ATS) Entering BACKUP STATE
```

## 根因分析

### 直接原因

同网段内存在 **VRID 冲突**：`10.18.100.93` 与本集群使用了相同的 `virtual_router_id 51`，但认证密码不同。

**tcpdump 抓包证据**：

```bash
[@ht100185 ~]# tcpdump -i eth0 vrrp -nn
14:27:10.024840 IP 10.18.100.93 > 224.0.0.18: VRRPv2, Advertisement, vrid 51, prio 80, authtype simple, intvl 1s, length 20
14:27:10.738427 IP 10.18.100.40 > 10.18.100.185: VRRPv2, Advertisement, vrid 51, prio 100, authtype simple, intvl 1s, length 20
```

### 技术原理

**VRRP 工作机制**：
- Keepalived 默认使用 **组播** (224.0.0.18) 通信
- 同一 L2 网段内所有 VRRP 实例共享组播频道
- 通过 `virtual_router_id` (1-255) 区分不同集群
- 通过 `auth_pass` 验证报文合法性

**故障触发链路**：

```
10.18.100.93 发送 VRRP 报文 (vrid=51, 密码X)
    ↓
ht100185 收到报文，VRID 匹配
    ↓
使用本地密码 "atsHAuse" 校验 → 失败
    ↓
丢弃报文 + 日志报错 "invalid passwd"
    ↓
合法报文被干扰，触发心跳超时
    ↓
误判主节点故障 → 抢占 MASTER → 脑裂风险
```

### 为何配置未变却突然故障

环境变化：同网段其他团队近期上线了新的 Keepalived 服务（如 Nginx HA、Kube-vip），恰好使用了相同的 VRID。

## 解决方案

### 方案一：修改 VRID（临时）

```bash
# 修改 /etc/keepalived/keepalived.conf
virtual_router_id 185  # 改为网段内唯一值

systemctl restart keepalived
```

**缺点**：无法根治，未来仍可能冲突。

### 方案二：切换单播模式（推荐）

彻底避免组播干扰，改为点对点通信。

**ht100185 配置**：

```conf
vrrp_instance VI_ATS {
    state BACKUP
    interface eth0
    virtual_router_id 51
    priority 90

    # 单播配置
    unicast_src_ip 10.18.100.185
    unicast_peer {
        10.18.100.40
    }

    authentication {
        auth_type PASS
        auth_pass atsHAuse
    }
    # ... 其他配置
}
```

**ht100040 配置**：

```conf
vrrp_instance VI_ATS {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100

    # 单播配置（IP 对调）
    unicast_src_ip 10.18.100.40
    unicast_peer {
        10.18.100.185
    }

    authentication {
        auth_type PASS
        auth_pass atsHAuse
    }
    # ... 其他配置
}
```

**应用配置**：

```bash
# 两台机器分别执行
systemctl restart keepalived

# 验证状态
ip addr show eth0 | grep 10.18.100.80
journalctl -u keepalived -f
```

## 排查工具

### 1. 抓包定位冲突源

```bash
tcpdump -i eth0 vrrp -nn
# 观察是否有非预期 IP 发送 VRRP 报文
```

### 2. 检查配置一致性

```bash
# 检查隐藏字符
cat -A /etc/keepalived/keepalived.conf | grep auth_

# 对比两端配置
diff <(ssh ht100185 'grep -A 3 authentication /etc/keepalived/keepalived.conf') \
     <(ssh ht100040 'grep -A 3 authentication /etc/keepalived/keepalived.conf')
```

### 3. 监控状态切换

```bash
journalctl -u keepalived -f | grep -E 'MASTER|BACKUP|invalid'
```

## 预防措施

1. **VRID 分配规范**：建立 VRID ���配表，避免随意使用默认值（50/51）
2. **强制单播**：企业内网环境禁用组播，统一使用 unicast 模式
3. **监控告警**：对 Keepalived 状态切换（BACKUP→MASTER）配置告警
4. **网络隔离**：不同业务线使用独立 VLAN

## 相关知识

### VRRP 认证类型

| 类型 | 说明 | 推荐 |
|------|------|------|
| PASS | 明文密码（实际传输时做简单编码） | ✅ 推荐 |
| AH | IPSec 认证头 | ❌ 内核兼容性差 |

### 组播 vs 单播

| 模式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 组播 | 配置简单 | 易冲突、易被防火墙拦截 | 小型隔离环境 |
| 单播 | 隔离性好、无冲突 | 需明确指定对端 IP | 企业生产环境 |

## 参考资料

- [Keepalived 官方文档 - VRRP Configuration](https://keepalived.readthedocs.io/en/latest/configuration_synopsis.html)
- RFC 3768 - Virtual Router Redundancy Protocol (VRRP)

---

**解决时间**：2026-03-31
**影响范围**：测试环境 ATS HA 集群
**最终方案**：切换为单播模式
