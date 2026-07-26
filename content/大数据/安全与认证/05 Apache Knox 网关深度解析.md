---
title: "Apache Knox 网关深度解析：统一入口、Provider 链与 SSO 体系"
date: 2026-03-02
tags: [Kerberos, Knox, LDAP, Provider, SSO, Topology, 大数据, 安全, 网关]
aliases: ["Apache Knox", "Knox", "Knox网关", "Hadoop API Gateway"]
---

**摘要：**

Apache Knox 是 Hadoop 生态的 API 网关，它的核心使命是：**将复杂的 Hadoop 集群内部认证体系（Kerberos）对外部用户完全屏蔽，提供一个统一的 HTTPS 入口**。外部用户只需向 Knox 提交 LDAP 账号或 SSO Token，Knox 在内部完成 Kerberos 认证并代理转发请求到目标服务（WebHDFS、YARN REST API、Hive 等）。这种"外部简单认证、内部 Kerberos 透明转换"的设计，是企业级数据平台对外暴露服务的标准范式。本文从 Knox 的架构出发，深入剖析 Topology（拓扑）、Provider 链（Filter Chain）、Service Dispatch 三大核心概念，以及 LDAP 认证、Kerberos 模拟（Impersonation）、KnoxSSO 单点登录的完整实现机制，最后总结生产部署中的关键决策与常见陷阱。

---

## 第 1 章 Knox 存在的理由：Hadoop 对外暴露的安全困境

### 1.1 没有 Knox 的世界

设想一个没有 Knox 的 Hadoop 集群，一个外部 BI 工具（如 Tableau、PowerBI）想要通过 REST API 访问集群数据，它会面临以下障碍：

**障碍一：Kerberos 的客户端侧复杂性**。HDFS 的 WebHDFS 接口、YARN 的 REST API、HiveServer2 的 JDBC 接口，在安全模式下都要求客户端有 Kerberos 凭证（TGT 或 Keytab）。这意味着每一台 BI 服务器都需要安装 Kerberos 客户端库（`libkrb5`）、配置 `/etc/krb5.conf`、维护 keytab 文件，并定期 `kinit` 续期。对于企业中的几十上百个数据消费方，这是灾难级的运维负担。

**障碍二：集群内部服务直接暴露到网络**。NameNode、ResourceManager、HiveServer2 等服务都监听在特定端口，如果为了让外部工具访问而将这些端口开放给公司网络，集群的攻击面会急剧扩大。任何能连接到这些端口的机器理论上都能尝试认证，一旦有 keytab 泄露，后果不堪设想。

**障碍三：没有统一的访问日志**。各服务分散记录各自的访问日志，无法从一处看到"某个外部用户都访问了哪些服务、做了什么操作"的全景视图。这对于合规审计（如 SOX、GDPR）极为不利。

**障碍四：无法统一做限流、IP 白名单等网关级控制**。每个服务需要单独配置，且并非所有 Hadoop 服务都支持这些能力。

Knox 用一个优雅的架构解决了上述所有问题：**在集群边界部署一个代理网关，所有外部访问统一经过 Knox，Knox 对内完成 Kerberos 认证，对外接受更简单的认证方式（LDAP、JWT、OAuth2 等）**。

### 1.2 Knox 的核心定位与边界

明确 Knox 的定位，同样需要说清楚 Knox **不做什么**：

Knox 不是 Ranger。Ranger 做细粒度的资源授权（"alice 能读 finance 数据库的哪些表"），Knox 做的是服务级别的访问控制（"外部用户能不能访问 HDFS 这个服务"）。两者协同工作：请求先经过 Knox 的认证和服务级授权，进入集群后再由 Ranger 做资源级授权。

Knox 不替代 Kerberos。Knox 是 Kerberos 的代理，而不是替代品。集群内部服务之间的通信依然走 Kerberos，Knox 只是承担了"从外部认证到内部 Kerberos"的转换工作。

Knox 不做数据转换。Knox 是一个透明代理，它转发 HTTP 请求和响应，不解析 Parquet 文件、不修改 SQL 语义，不改变数据格式。

---

## 第 2 章 Knox 整体架构：三大核心概念

### 2.1 架构全景

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph TD
    classDef external fill:#8be9fd,stroke:#8be9fd,color:#282a36
    classDef knox fill:#6272a4,stroke:#bd93f9,color:#f8f8f2
    classDef provider fill:#50fa7b,stroke:#69ff47,color:#282a36
    classDef service fill:#ff5555,stroke:#ff79c6,color:#f8f8f2
    classDef hadoop fill:#ffb86c,stroke:#ffb86c,color:#282a36

    subgraph "外部访问方"
        A["BI 工具</br>(Tableau/PowerBI)"]:::external
        B["外部应用</br>(REST API 调用)"]:::external
        C["浏览器用户</br>(Web UI 访问)"]:::external
    end

    subgraph "Knox Gateway 进程"
        D["HTTPS 入口</br>端口 8443"]:::knox
        
        subgraph "Topology: cluster1"
            E["Provider Chain</br>Authentication Provider</br>Authorization Provider</br>Identity Assertion Provider"]:::provider
            F["Service: WEBHDFS</br>Service: YARN</br>Service: HIVE"]:::service
        end
        
        subgraph "Topology: knoxsso"
            G["SSO Provider Chain</br>LDAP Auth → JWT Token"]:::provider
        end
    end

    subgraph "Hadoop 集群内部（Kerberos 安全区）"
        H["WebHDFS</br>(NameNode:9870)"]:::hadoop
        I["YARN RM REST API</br>(RM:8088)"]:::hadoop
        J["HiveServer2</br>(HiveServer:10001)"]:::hadoop
        K["KDC"]:::hadoop
        L["LDAP/AD"]:::hadoop
    end

    A -->|"HTTPS + LDAP/JWT"| D
    B -->|"HTTPS + LDAP/JWT"| D
    C -->|"HTTPS + Cookie(JWT)"| D
    D --> E
    E -->|"验证通过，构造 Kerberos 身份</br>HTTP + Kerberos TGT"| F
    F -->|"代理转发 + Kerberos 认证"| H
    F -->|"代理转发"| I
    F -->|"代理转发"| J
    E -.->|"验证 LDAP 凭证"| L
    F -.->|"获取 Kerberos TGT"| K
```

### 2.2 核心概念一：Topology（拓扑）

Topology 是 Knox 中最基础的概念，是一个 XML 配置文件，描述了"一组服务的对外暴露方案"。每个 Topology 对应 Knox 上的一个 URL 路径前缀（context path）。

例如，`cluster1.xml` 这个 Topology 文件会在 Knox 上创建一个 `https://knox-host:8443/gateway/cluster1/` 的入口，所有以这个前缀开头的请求都由这个 Topology 处理。

Topology 文件的结构：

```xml
<!-- /var/lib/knox/data/deployments/cluster1.xml -->
<topology>
    <gateway>
        <!-- Provider 链：按顺序执行的处理器 -->
        
        <!-- 1. 认证 Provider：验证谁在访问 -->
        <provider>
            <role>authentication</role>
            <name>ShiroProvider</name>
            <enabled>true</enabled>
            <param>
                <name>main.ldapRealm</name>
                <value>org.apache.knox.gateway.shirorealm.KnoxLdapRealm</value>
            </param>
            <param>
                <name>main.ldapRealm.userDnTemplate</name>
                <value>uid={0},ou=people,dc=example,dc=com</value>
            </param>
            <param>
                <name>main.ldapRealm.contextFactory.url</name>
                <value>ldap://ldap.example.com:389</value>
            </param>
            <param>
                <name>main.sessionTimeout</name>
                <value>30</value>  <!-- Session 超时时间（分钟） -->
            </param>
        </provider>
        
        <!-- 2. 授权 Provider：控制谁能访问哪个服务 -->
        <provider>
            <role>authorization</role>
            <name>AclsAuthz</name>
            <enabled>true</enabled>
            <param>
                <!-- 只有 hadoop-admins 组成员才能访问 WEBHDFS 服务 -->
                <name>webhdfs.acl</name>
                <value>*;hadoop-admins;*</value>  <!-- users;groups;ipranges -->
            </param>
        </provider>
        
        <!-- 3. 身份断言 Provider：将外部用户身份转换为 Hadoop 内部身份 -->
        <provider>
            <role>identity-assertion</role>
            <name>Default</name>
            <enabled>true</enabled>
        </provider>
        
        <!-- 4. HA Provider：服务高可用支持 -->
        <provider>
            <role>ha</role>
            <name>HaProvider</name>
            <enabled>true</enabled>
            <param>
                <name>WEBHDFS</name>
                <value>maxFailoverAttempts=3;failoverSleep=1000;enabled=true</value>
            </param>
        </provider>
    </gateway>

    <!-- 暴露的服务列表 -->
    <service>
        <role>WEBHDFS</role>
        <url>http://namenode1.example.com:9870/webhdfs</url>
        <url>http://namenode2.example.com:9870/webhdfs</url>  <!-- HA 备节点 -->
    </service>
    
    <service>
        <role>YARN</role>
        <url>http://resourcemanager.example.com:8088/ws</url>
    </service>
    
    <service>
        <role>HIVE</role>
        <url>http://hiveserver2.example.com:10001</url>
    </service>
</topology>
```

**Topology 的热部署机制**：Knox 监听 `deployments` 目录，当检测到 `.xml` 文件新增或修改时，自动热加载对应的 Topology，无需重启 Knox 进程。这使得添加新服务或修改认证配置可以在线完成，不影响其他 Topology 的服务。

### 2.3 核心概念二：Provider 链（Filter Chain）

Provider 是 Knox 中的处理单元，每个 Provider 在请求处理管道中承担特定职责。Topology 中定义的所有 Provider，会被组装成一个有序的 Filter Chain（类似 Java Servlet Filter 链）。

每个入站请求依次经过这个 Filter Chain，每个 Provider 可以：
- 验证请求（认证 Provider）
- 修改请求头（身份断言 Provider 可以注入 `X-Forwarded-User` 等头）
- 拒绝请求（授权 Provider）
- 继续传递给下一个 Provider（调用 `chain.doFilter(request, response)`）

**Knox 内置的 Provider 类型**：

| Provider Role | 职责 | 常用实现 |
|--------------|------|---------|
| `authentication` | 验证用户身份（谁在访问）| `ShiroProvider`（LDAP/Basic Auth）、`HadoopAuth`（SPNEGO/Kerberos）、`JWTProvider`（JWT Token）|
| `authorization` | 控制服务级访问权限 | `AclsAuthz`（ACL 规则）、`RangerPDPKnox`（Ranger 策略）|
| `identity-assertion` | 用户身份转换与映射 | `Default`（直接使用登录用户名）、`Concat`（拼接前后缀）、`UserTypeFederationProvider`（属性注入）|
| `federation` | 基于第三方 Token 联合认证 | `JWTProvider`（解析 JWT）、`HeaderPreAuth`（信任特定 Header）|
| `ha` | 后端服务高可用 | `HaProvider`（轮询、故障转移）|
| `hostmap` | 主机名映射（处理内外部主机名差异）| `Default`（配置映射规则）|

**为什么使用 Filter Chain 而不是单一处理器？** 这是经典的**责任链模式（Chain of Responsibility）**设计。它使得各个关注点（认证、授权、身份转换、高可用）完全解耦，每种能力可以独立开发、独立测试、独立替换，组合使用时无需修改其他 Provider 的代码。企业可以编写自己的 Provider 实现，插入到链中的任意位置，而不需要 fork Knox 代码。

### 2.4 核心概念三：Service Dispatch（服务分发）

Provider 链通过认证和授权后，请求最终到达 Service 层。Service 层负责：

1. **URL 重写（URL Rewriting）**：将 Knox 的外部 URL 映射到后端服务的内部 URL，并对响应中的内部 URL 做反向映射（防止内部 URL 泄露给外部）

2. **Kerberos 认证**：Knox 以自身的 Principal（`HTTP/knox-host@REALM`）向后端服务的 SPNEGO 端点认证，或者通过 Hadoop 的代理用户机制（`doAs`）以真实用户的身份代理访问

3. **HTTP 代理转发**：构造对后端服务的 HTTP 请求，附加认证头，并将响应返回给外部客户端

**URL 重写示例**：

外部请求：`GET https://knox:8443/gateway/cluster1/webhdfs/v1/user/alice?op=LISTSTATUS`

Knox 内部重写为：`GET http://namenode:9870/webhdfs/v1/user/alice?op=LISTSTATUS&user.name=alice`

响应中如果包含 DataNode 的内部地址（如重定向 URL 中的 `http://datanode001:9864/...`），Knox 会将其重写为外部可访问的 Knox 地址（`https://knox:8443/gateway/cluster1/webhdfs/data/...`），确保外部客户端的后续请求也经过 Knox，而不是直接绕过 Knox 去访问 DataNode。

---

## 第 3 章 认证机制深度解析

### 3.1 LDAP 认证（ShiroProvider）

这是 Knox 最常用的外部认证方式。用户通过 HTTP Basic Auth 提供 LDAP 账号密码，Knox 向企业的 LDAP/AD 服务器验证，成功后建立 Session。

**ShiroProvider 使用 Apache Shiro 框架实现 LDAP 认证**。Shiro 是一个轻量级的 Java 安全框架，Knox 对其进行了扩展，实现了 Kerberos Realm 的 `KnoxLdapRealm`。

**认证流程**：

```
1. 客户端发送请求：
   GET https://knox:8443/gateway/cluster1/webhdfs/v1/user/alice
   Authorization: Basic YWxpY2U6cGFzc3dvcmQ=   (Base64(alice:password))

2. ShiroProvider 解析 Basic Auth 头，提取用户名/密码

3. 向 LDAP 服务器执行 Bind 操作（相当于登录）：
   DN: uid=alice,ou=people,dc=example,dc=com
   Password: alice的密码
   → LDAP 服务器返回成功/失败

4. 如果成功，创建 Shiro Session（默认 30 分钟有效期），
   后续请求携带 Set-Cookie 中的 JSESSIONID 即可复用 Session，无需重复 LDAP 验证

5. 将认证通过的用户名（alice）传递给下一个 Provider
```

**LDAP 组成员关系查询**：Knox 可以配置在认证时顺便查询用户所属的 LDAP 组，用于后续的授权决策：

```xml
<param>
    <name>main.ldapRealm.searchBase</name>
    <value>ou=groups,dc=example,dc=com</value>
</param>
<param>
    <name>main.ldapRealm.groupObjectClass</name>
    <value>groupOfNames</value>
</param>
<param>
    <name>main.ldapRealm.memberAttributeValueTemplate</name>
    <value>uid={0},ou=people,dc=example,dc=com</value>
</param>
```

> [!warning] 生产避坑：LDAP 连接池与超时配置
> 高并发场景下，如果 LDAP 连接池配置不当，每次认证都建立新的 TCP 连接到 LDAP 服务器，不仅增加认证延迟（LDAP Bind 通常需要 10-50ms），还可能耗尽 LDAP 服务器的连接数。建议：
> 1. 配置 `main.ldapRealm.contextFactory.poolingEnabled=true` 启用连接池
> 2. 配置合理的 `main.sessionTimeout`（如 60 分钟），减少 LDAP 重复认证
> 3. 如果 Knox 部署了多个实例，考虑使用 KnoxSSO（下文介绍）统一管理 Session，避免每个 Knox 实例各自维护 Session

### 3.2 Kerberos 认证（HadoopAuth Provider）

对于需要在 Knox 侧也启用 Kerberos 的场景（如集群内部服务互访经过 Knox），Knox 支持 SPNEGO 认证：

```xml
<provider>
    <role>authentication</role>
    <name>HadoopAuth</name>
    <enabled>true</enabled>
    <param>
        <name>config.prefix</name>
        <value>hadoop.auth.config</value>
    </param>
    <param>
        <name>hadoop.auth.config.signature.secret</name>
        <value>knox-secret-12345</value>
    </param>
    <param>
        <!-- Kerberos 或 Simple（Simple 仅信任客户端传来的用户名，不做验证） -->
        <name>hadoop.auth.config.type</name>
        <value>kerberos</value>
    </param>
    <param>
        <name>hadoop.auth.config.kerberos.principal</name>
        <value>HTTP/knox-host.example.com@EXAMPLE.COM</value>
    </param>
    <param>
        <name>hadoop.auth.config.kerberos.keytab</name>
        <value>/etc/security/keytabs/spnego.service.keytab</value>
    </param>
</provider>
```

启用 HadoopAuth（Kerberos 类型）后，客户端需要持有有效的 Kerberos TGT，并在 HTTP 请求中携带 SPNEGO Token（`Authorization: Negotiate <token>`）。这种配置适合集群内部工具或已部署 Kerberos 的环境。

### 3.3 JWT Federation Provider

对于已有企业 SSO 体系（如 Okta、Azure AD、自建 OAuth2 服务）的场景，Knox 可以接受 JWT Token 作为认证凭证：

```xml
<provider>
    <role>federation</role>
    <name>JWTProvider</name>
    <enabled>true</enabled>
    <param>
        <!-- JWT 签名验证公钥（与 KnoxSSO 配对使用） -->
        <name>knox.token.verification.pem</name>
        <value>MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...</value>
    </param>
    <param>
        <!-- JWT 有效期最大值，即使 Token 本身有更长的有效期，也不超过此值 -->
        <name>knox.token.ttl</name>
        <value>3600000</value>  <!-- 1 小时 -->
    </param>
    <param>
        <!-- 接受的 JWT Audience（令牌受众） -->
        <name>knox.token.audiences</name>
        <value>cluster1</value>
    </param>
</provider>
```

客户端先从 KnoxSSO（或企业 IdP）获取 JWT，之后每次请求携带 `Authorization: Bearer <jwt_token>`，Knox 用公钥验证 JWT 签名和有效期，提取其中的用户身份，无需每次都去 LDAP 认证。

---

## 第 4 章 Kerberos 代理用户（Impersonation）：Knox 与 Hadoop 的连接桥梁

### 4.1 Knox 对 Hadoop 服务的认证方式

Knox 自身持有一个 Kerberos keytab（`HTTP/knox-host@REALM`），在向后端 Hadoop 服务（WebHDFS、YARN 等）发起请求时，用这个 keytab 进行 SPNEGO 认证。

但这里有一个核心问题：HDFS 是基于用户身份做权限控制的（alice 只能访问 alice 的目录），如果所有外部用户的请求都以 Knox 的 Principal（`HTTP/knox-host`）转发，那 NameNode 会认为所有请求都来自 Knox 这个服务账号，无法区分真实的用户身份，权限控制就完全失效了。

**Hadoop 代理用户（Proxy User / Impersonation）机制**正是为解决这个问题设计的。

### 4.2 代理用户机制的工作原理

代理用户允许一个 Hadoop 服务账号（如 `knox`）代表其他用户发起请求，NameNode 在处理时以被代理的用户身份（如 `alice`）做权限检查。

**配置步骤**：

在 `core-site.xml` 中配置允许 knox 代理其他用户：

```xml
<!-- 允许 knox 账号代理任意主机来的请求 -->
<property>
    <name>hadoop.proxyuser.knox.hosts</name>
    <value>knox-host.example.com</value>  <!-- Knox 服务器的 FQDN，安全起见不建议用 * -->
</property>
<!-- 允许 knox 代理任意用户（生产中可限制为特定组） -->
<property>
    <name>hadoop.proxyuser.knox.users</name>
    <value>*</value>
</property>
<!-- 或者用 groups 替代 users，更安全 -->
<property>
    <name>hadoop.proxyuser.knox.groups</name>
    <value>hadoop-users,data-analysts</value>
</property>
```

**WebHDFS 代理用户请求的 URL 格式**：

Knox 向 NameNode 发起请求时，在 URL 中追加 `doAs=alice` 参数：

```
# Knox 发向 NameNode 的实际请求（内部）
GET http://namenode:9870/webhdfs/v1/user/alice?op=LISTSTATUS&doAs=alice
Authorization: Negotiate <knox自己的Kerberos SPNEGO Token>

# NameNode 处理逻辑：
# 1. SPNEGO 认证：确认请求来自 knox Principal（HTTP/knox-host@REALM）
# 2. 检查 doAs 参数：alice
# 3. 验证 knox 是否有权代理 alice（查 hadoop.proxyuser.knox.* 配置）
# 4. 如果允许，以 alice 的身份执行 LISTSTATUS 操作，应用 alice 的权限
```

**身份断言 Provider（Identity Assertion Provider）的作用**：

Knox 的 Identity Assertion Provider 负责将外部认证的用户名（LDAP 登录的 `alice`）映射到 Hadoop 内部需要的用户名，并设置 `doAs` 参数：

```xml
<provider>
    <role>identity-assertion</role>
    <name>Default</name>
    <enabled>true</enabled>
    <!-- 如果外部用户名与 Hadoop 内部用户名一致，Default 实现直接传递 -->
    <!-- 如果需要转换（如 alice@AD.EXAMPLE.COM → alice），可使用 Concat 或 UserTypeFederation 实现 -->
</provider>
```

对于跨域场景（AD 用户名包含 `@domain` 后缀），可以使用 `Concat` Provider 做截断：

```xml
<param>
    <name>principal.mapping</name>
    <value>alice@AD.EXAMPLE.COM=alice;bob@AD.EXAMPLE.COM=bob</value>
</param>
<!-- 或者使用正则规则截断 @domain 部分 -->
```

> [!info] 设计哲学：Knox 的身份转换是单向的
> Knox 的身份转换只在"外部身份 → Hadoop 内部身份"这个方向上工作。Knox 永远不会向外部客户端暴露 Hadoop 内部的 Principal 名称（如 `hdfs/namenode@REALM`）。响应中的内部信息（如用户名、主机名）要么被 URL 重写替换，要么不在响应体中出现。这种信息隐藏（Information Hiding）是 Knox 作为安全网关的基本职责。

---

## 第 5 章 KnoxSSO：统一单点登录

### 5.1 KnoxSSO 的定位

KnoxSSO 是 Knox 提供的一个特殊 Topology，专门用于单点登录（SSO）场景。它解决的问题是：**如何让用户只登录一次，就能无缝访问多个 Hadoop 服务的 Web UI（Ambari、Ranger Admin、HDFS NameNode UI 等）**。

没有 KnoxSSO 时，用户访问 Ambari 需要登录一次，访问 Ranger Admin 又要登录一次，访问 Knox 保护的其他服务还要登录。这种体验对于企业内部用户极不友好。

KnoxSSO 的工作模式：
1. 用户首次访问任何受保护的服务时，被重定向到 KnoxSSO 登录页
2. 用户在 KnoxSSO 提交 LDAP 凭证（或通过企业 IdP 认证）
3. KnoxSSO 颁发一个 **JWT Token**（`hadoop-jwt` Cookie），有效期通常为数小时
4. 后续访问其他服务时，浏览器自动携带这个 Cookie，各服务的 Knox Topology 验证 JWT 有效性，无需重复登录

### 5.2 KnoxSSO Topology 配置

```xml
<!-- /var/lib/knox/data/deployments/knoxsso.xml -->
<topology>
    <gateway>
        <!-- SSO Provider：完成用户认证，颁发 JWT -->
        <provider>
            <role>webappsec</role>
            <name>WebAppSec</name>
            <enabled>true</enabled>
            <param>
                <name>xframe.options.enabled</name>
                <value>true</value>
            </param>
        </provider>
        
        <provider>
            <role>authentication</role>
            <name>ShiroProvider</name>
            <enabled>true</enabled>
            <param>
                <!-- 使用 Knox 提供的登录表单页（而非 Basic Auth 弹窗） -->
                <name>sessionTimeout</name>
                <value>30</value>
            </param>
            <param>
                <name>main.ldapRealm</name>
                <value>org.apache.knox.gateway.shirorealm.KnoxLdapRealm</value>
            </param>
            <param>
                <name>main.ldapRealm.contextFactory.url</name>
                <value>ldap://ldap.example.com:389</value>
            </param>
            <param>
                <name>main.ldapRealm.userDnTemplate</name>
                <value>uid={0},ou=people,dc=example,dc=com</value>
            </param>
        </provider>

        <!-- 身份断言 Provider -->
        <provider>
            <role>identity-assertion</role>
            <name>Default</name>
            <enabled>true</enabled>
        </provider>
    </gateway>

    <!-- KnoxSSO 的特殊服务：颁发 JWT Token -->
    <service>
        <role>KNOXSSO</role>
        <param>
            <!-- JWT Token 有效期（毫秒） -->
            <name>knoxsso.token.ttl</name>
            <value>86400000</value>  <!-- 24 小时 -->
        </param>
        <param>
            <!-- 允许重定向到的 URL 白名单（防止开放重定向攻击） -->
            <name>knoxsso.redirect.whitelist.regex</name>
            <value>^https?://.*\.example\.com:.*$</value>
        </param>
        <param>
            <!-- JWT 签名算法 -->
            <name>knoxsso.signingAlgorithm</name>
            <value>RS256</value>
        </param>
    </service>
</topology>
```

### 5.3 JWT Token 的结构与验证

KnoxSSO 颁发的 JWT Token 遵循标准的 JWT 格式（RFC 7519）：

```
Header.Payload.Signature
（Base64URL 编码，用 . 分隔）

Header:
{
  "alg": "RS256",   // 签名算法：RSA + SHA256
  "typ": "JWT"
}

Payload:
{
  "sub": "alice",                         // 用户名（Subject）
  "iss": "KNOXSSO",                       // 颁发方
  "aud": ["cluster1", "ranger-ui"],       // 受众（允许使用此 Token 的服务）
  "exp": 1705366800,                      // 过期时间（Unix 时间戳）
  "iat": 1705280400,                      // 颁发时间
  "nbf": 1705280400,                      // 生效时间
  "knox.groups": "finance-analysts,hive-users"  // 用户所属组（自定义声明）
}

Signature:
RSA-SHA256(Base64URL(Header) + "." + Base64URL(Payload), Knox的RSA私钥)
```

Knox 在服务 Topology 中配置 KnoxSSO 的公钥进行验证：

```xml
<!-- cluster1.xml 中的 JWT Federation Provider -->
<provider>
    <role>federation</role>
    <name>JWTProvider</name>
    <enabled>true</enabled>
    <param>
        <name>knox.token.verification.pem</name>
        <!-- Knox master 公钥，从 /var/lib/knox/data/security/keystores/gateway.jks 导出 -->
        <value>MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC...</value>
    </param>
</provider>
```

**JWT 验证流程**：
1. 从请求的 Cookie（`hadoop-jwt`）或 `Authorization: Bearer` 头中提取 JWT
2. Base64URL 解码 Header 和 Payload，验证签名（用公钥验证 Signature）
3. 检查 `exp`（是否过期）、`aud`（是否包含当前服务）、`nbf`（是否已生效）
4. 提取 `sub`（用户名）传递给下一个 Provider

> [!note] 设计哲学：为什么用 RSA（非对称加密）而不是 HMAC
> 使用 RSA 签名（私钥签名，公钥验证）而不是 HMAC（共享密钥），是因为：
> 在 Knox 多实例或多组件场景中，需要验证 JWT 的方（cluster1 Topology、Ranger、Ambari）不需要持有签名密钥，只需要公钥即可。如果用 HMAC，所有验证方都需要安全保存相同的密钥，密钥一旦泄露所有服务都受影响。RSA 方案中，私钥只在 KnoxSSO 实例上保存，公钥可以任意分发。

---

## 第 6 章 Knox HA：网关层的高可用设计

### 6.1 Knox 自身的 HA

Knox 是无状态的（Session 存储在 Shiro 的本地内存中，或者配置外部 Session 存储），可以水平扩展多个实例。生产中通常在 Knox 前面部署负载均衡器（Nginx、HAProxy、F5）：

```
外部用户
    ↓
负载均衡器（LB）  ← VIP: knox.example.com:443
   ├─ Knox Instance 1: knox01:8443
   └─ Knox Instance 2: knox02:8443
         ↓
   Hadoop 集群
```

**Session 一致性问题**：如果用 Shiro 的内存 Session（默认），当 LB 将同一用户的请求路由到不同的 Knox 实例时，会导致重复认证。解决方案：
1. **LB Sticky Session**（IP Hash 或 Cookie 绑定）：将同一用户的请求始终路由到同一个 Knox 实例，简单但有单点风险
2. **KnoxSSO JWT 模式**：完全无 Session，每次请求用 JWT 验证，天然支持多实例（推荐）
3. **外部 Session 存储**（如 Hazelcast 分布式缓存）：Knox 企业版支持，开源版本不原生提供

### 6.2 后端服务 HA（HaProvider）

Knox 内置了对后端 Hadoop 服务 HA 的支持。以 NameNode HA 为例，Knox 的 Topology 中配置两个 NameNode URL，HaProvider 负责在主 NN 故障时自动切换到备 NN：

```xml
<provider>
    <role>ha</role>
    <name>HaProvider</name>
    <enabled>true</enabled>
    <param>
        <name>WEBHDFS</name>
        <value>
            maxFailoverAttempts=3;       <!-- 最多切换 3 次 -->
            failoverSleep=1000;          <!-- 切换间隔 1 秒 -->
            maxRetryAttempts=3;          <!-- 单个节点最多重试 3 次 -->
            retrySleep=1000;             <!-- 重试间隔 1 秒 -->
            enabled=true
        </value>
    </param>
</provider>

<service>
    <role>WEBHDFS</role>
    <url>http://namenode1.example.com:9870/webhdfs</url>
    <url>http://namenode2.example.com:9870/webhdfs</url>
</service>
```

HaProvider 使用**轮询 + 故障检测**策略：正常情况下按配置顺序使用第一个 URL，当请求失败时（超时或 5xx 响应），标记该节点暂时不可用，自动切换到下一个 URL，经过 `failoverSleep` 后重新检测原节点。

---

## 第 7 章 Knox 授权：服务级 ACL 与 Ranger 集成

### 7.1 AclsAuthz：简单的服务级 ACL

Knox 内置的 `AclsAuthz` Provider 提供基于用户、组、IP 的服务访问控制：

```xml
<provider>
    <role>authorization</role>
    <name>AclsAuthz</name>
    <enabled>true</enabled>
    <param>
        <!-- 格式：users;groups;ipranges（* 表示所有） -->
        
        <!-- WEBHDFS 服务：只允许 hadoop-admins 组成员访问 -->
        <name>webhdfs.acl</name>
        <value>*;hadoop-admins;*</value>
        
        <!-- YARN 服务：允许所有用户访问，但只允许来自 10.0.0.0/8 的 IP -->
        <name>yarn.acl</name>
        <value>*;*;10.0.0.0/8</value>
        
        <!-- HIVE 服务：只允许 alice、bob，以及 data-scientists 组 -->
        <name>hive.acl</name>
        <value>alice,bob;data-scientists;*</value>
    </param>
</provider>
```

### 7.2 Ranger 与 Knox 的集成（RangerPDPKnox）

对于需要更细粒度授权的场景（如"finance 组只能访问 WebHDFS，不能访问 HiveServer"），可以将 Knox 授权决策委托给 Ranger：

```xml
<provider>
    <role>authorization</role>
    <name>XASecurePDPKnox</name>  <!-- Ranger Knox Plugin -->
    <enabled>true</enabled>
</provider>
```

Ranger 在 Knox 服务的策略中，资源类型是 `topology`（Knox 拓扑名）和 `service`（服务角色），可以细粒度控制哪些用户/组能通过哪个 Topology 访问哪个服务。

---

## 第 8 章 生产部署关键决策与常见陷阱

### 8.1 Knox 的部署位置选择

Knox 通常部署在集群边界节点（Edge Node），该节点的特殊性在于：
- 可以访问集群内部网络（能到达 NameNode、ResourceManager 等）
- 对外开放 HTTPS 端口（8443）
- 部署了 Kerberos keytab（knox 服务账号的 keytab）
- **不运行任何 Hadoop 数据节点服务**（保持最小攻击面）

> [!warning] 生产避坑：Knox Edge Node 的安全加固
> Knox 节点是整个集群安全链路中最暴露的节点，必须重点加固：
> 1. 只开放 443（重定向到 8443）和 8443 端口，其他所有入站端口关闭
> 2. 定期轮换 Knox 的 keytab 和 RSA 密钥对
> 3. Knox 进程使用专用低权限账号运行（不使用 root）
> 4. 开启 Knox 自身的访问日志，并接入 SIEM 系统实时监控异常访问
> 5. Knox 节点本身不存储任何业务数据，不运行 DataNode

### 8.2 URL 重写的 301/302 重定向问题

WebHDFS 的许多操作（如文件写入）涉及多次 HTTP 重定向：
1. 客户端向 NameNode 发 `CREATE` 请求
2. NameNode 返回 302，重定向到具体的 DataNode URL（内部地址）
3. 客户端向 DataNode 上传数据

这在 Knox 代理场景下需要特殊处理：Knox 必须将第二步的 DataNode 内部 URL（`http://datanode001:9864/webhdfs/v1/...`）重写为 Knox 的外部 URL，否则外部客户端无法访问这个内部地址。

Knox 的 URL 重写引擎（`rewrite.xml`）内置了 WebHDFS 的重写规则。但如果后端服务自定义了 URL 模式，或者集群的主机名与 Knox 配置不符，重写可能失败，导致客户端收到无法访问的内部 URL。

**排查方法**：在 Knox 日志中搜索 `REWRITE`，查看实际的重写规则匹配情况：

```bash
# 开启 Knox URL 重写的 DEBUG 日志
# 在 /var/lib/knox/conf/gateway-log4j2.properties 中：
logger.rewrite.name=org.apache.knox.gateway.filter.rewrite
logger.rewrite.level=DEBUG
```

### 8.3 常见错误速查

| 错误现象 | 可能原因 | 排查方向 |
|---------|---------|---------|
| HTTP 401 (Unauthorized) | 认证失败 | 检查 LDAP 连接配置、用户 DN 模板是否正确 |
| HTTP 403 (Forbidden) | 授权失败 | 检查 AclsAuthz/Ranger 策略，查看用户所属组 |
| HTTP 503 (Service Unavailable) | 后端服务不可达 | 检查 Topology 中的 service URL 是否可访问，检查防火墙 |
| `GSSException: No valid credentials` | Knox 的 Kerberos 凭证失效 | 检查 knox 的 keytab，确认 Principal 是否正确，检查 TGT 状态 |
| URL 重写失败（内部地址泄露）| 重写规则未匹配 | 开启 REWRITE DEBUG 日志，检查 hostmap 配置 |
| Session 频繁失效 | SessionTimeout 配置过短，或多实例 Session 不共享 | 增大 sessionTimeout，或切换到 JWT 模式 |
| JWT 验证失败 | 公钥不匹配，或 Token 过期 | 检查 Topology 中配置的公钥是否与 KnoxSSO 的私钥对应，检查服务器时钟 |

---

## 小结

本文系统解析了 Apache Knox 的完整架构与核心机制：

- **Knox 的存在价值**：屏蔽 Kerberos 复杂性，为外部用户提供统一的 HTTPS 入口，集中审计所有外部访问
- **三大核心概念**：Topology（配置单元）+ Provider Chain（Filter Chain，各关注点解耦）+ Service Dispatch（URL 重写 + Kerberos 代理转发）
- **认证三模式**：LDAP（ShiroProvider，最常用）、SPNEGO（HadoopAuth，面向内部工具）、JWT（JWTProvider，面向 SSO）
- **代理用户机制**：Knox 以自身 Principal 向 Hadoop 认证，通过 `doAs` 参数传递真实用户身份，`hadoop.proxyuser.knox.*` 配置控制代理权限
- **KnoxSSO**：基于 RSA-JWT 实现跨服务单点登录，天然支持多 Knox 实例
- **HA 设计**：Knox 自身无状态可水平扩展，HaProvider 处理后端服务 HA 故障转移

Kerberos（认证基础）+ Ranger（细粒度授权）+ Knox（统一入口），三者共同构成了 Hadoop 安全体系的核心骨架。下一篇 [[06 DProxy 透明代理原理与生产实践]] 将介绍另一种代理模式——DProxy 作为集群内部的透明 HTTP 代理，解决 Knox 无法覆盖的场景。


> [!note] 思考题
> 1. Knox 作为 Hadoop 集群的 API 网关，将所有外部访问统一收口到单一入口，避免直接暴露集群内部服务（NameNode、ResourceManager 等）的端口。Knox 通过 Topology 文件定义每个服务的路由规则，将外部请求代理到内部服务。Knox 在代理 Kerberos 认证的服务时，需要以自己的 Service Principal 向内部服务发起请求（作为代理用户）。这要求 Knox 的 Service Principal 在 HDFS/Hive 等服务中被配置为允许的代理用户（`hadoop.proxyuser.knox.*`）。如果 Knox 的 Principal 被错误配置为可以代理任意用户（`*`），会带来什么安全风险？
> 2. Knox 支持多种认证方式：Basic Auth（用户名密码）、Kerberos SPNEGO、OAuth2、SAML。在企业环境中，通常需要将 Knox 与 LDAP（如 Active Directory）集成，通过 LDAP 验证用户名密码。Knox 的 ShiroProvider 负责 LDAP 认证。如果 LDAP 服务不可用（如 AD 故障），Knox 的所有基于 LDAP 认证的请求都会失败。如何在 Knox 层面实现 LDAP 的高可用，避免单一 LDAP 服务器成为整个集群访问的单点故障？
> 3. Knox 的 HA（高可用）通过多个 Knox 实例 + 负载均衡器（如 HAProxy）实现。Knox 本身是无状态的（会话状态可以通过 Token 携带），理论上可以水平扩展。但 Knox 的 Token 服务（用于将 Basic Auth 换取短期 Token，避免每次请求都查询 LDAP）需要在多个 Knox 实例间共享 Token 状态。Knox 是如何实现这个共享状态的？如果使用共享 ZooKeeper 存储 Token，ZooKeeper 宕机会对 Knox 的 Token 服务产生什么影响？