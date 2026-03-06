---
title: "文件系统的安全边界——权限、ACL 与 Capabilities"
date: 2026-03-02
tags: [Linux, 文件权限, ACL, Capabilities, setuid, DAC, MAC, SELinux, 安全, inode, umask]
aliases: ["Linux文件权限", "POSIX ACL", "Linux Capabilities", "setuid安全", "DAC权限模型"]
---

**摘要：**

"权限"是文件系统安全的第一道防线。Linux 继承了 Unix 的 **DAC（Discretionary Access Control，自主访问控制）** 模型——每个文件有所有者（Owner）、所属组（Group）和其他人（Others）三类主体，每类主体有读（r）、写（w）、执行（x）三种权限，总共 9 个权限位。这套设计在 Unix 诞生之初（1969 年）足以应对多用户分时系统的需求，但随着 Linux 在企业生产环境中广泛应用，三元权限模型的局限性日益突出：无法为特定用户单独授权（不属于 Owner 也不属于 Group 的用户），无法用一个目录同时控制不同用户对不同文件的访问。**POSIX ACL** 是对 rwx 模型的精确补充，通过扩展 inode 属性实现任意用户/组的细粒度授权。但最根本的安全危机不是 ACL 能解决的——`setuid` 位允许普通用户以文件所有者的身份（通常是 root）运行程序，这是 Linux 历史上最大的攻击面之一。**Linux Capabilities** 将 root 的超级权限分解为 40+ 个独立能力（`CAP_NET_ADMIN`、`CAP_SYS_ADMIN` 等），使进程可以只获取其需要的那一小部分特权，而不需要完整的 root 权限——这是容器安全（Docker、Kubernetes）的权限控制基础。本文系统解析这三层权限体系的内核实现、相互关系与生产实践。

---

## 第 1 章 DAC：Unix 权限模型的设计与局限

### 1.1 rwx 权限位：9 位的语义

Linux 文件系统中，每个文件/目录的权限由存储在 inode 中的 `i_mode` 字段（16 位）描述：

```
i_mode 的位布局（16 位）：

位 15-12：文件类型（4 位）
  0100 = 普通文件（-）
  0040 = 目录（d）
  0120 = 符号链接（l）
  0060 = 块设备（b）
  0020 = 字符设备（c）
  0010 = 命名管道（p）
  0140 = Socket（s）

位 11-9：特殊权限位（3 位）
  位 11 = setuid  （s/S）
  位 10 = setgid   （s/S）
  位  9 = sticky   （t/T）

位 8-0：rwx 权限（9 位）
  位 8-6：Owner（文件所有者）的 rwx
  位 5-3：Group（文件所属组）的 rwx
  位 2-0：Others（其他人）的 rwx
```

**权限检查的逻辑（内核 `inode_permission()` 函数）**：

```c
/* 简化的权限检查逻辑 */
int inode_permission(struct user_namespace *mnt_userns,
                     struct inode *inode, int mask) {
    const struct cred *cred = current_cred();  /* 当前进程的凭证 */

    /* root 用户特殊处理 */
    if (uid_eq(cred->fsuid, GLOBAL_ROOT_UID)) {
        /* root 对任何文件都有读/写权限（无论 rwx 位）*/
        /* 但执行权限：只有文件有任意一个 x 位时 root 才能执行 */
        if (!(mask & MAY_EXEC) || (inode->i_mode & S_IXUGO))
            return 0;  /* 允许 */
    }

    /* 非 root：按 Owner → Group → Others 顺序匹配 */
    if (uid_eq(cred->fsuid, inode->i_uid)) {
        /* 进程的 UID 匹配文件 Owner：使用 Owner 权限位 */
        acl_mode = (inode->i_mode >> 6) & 7;  /* 取位 8-6 */
    } else if (in_group_p(inode->i_gid)) {
        /* 进程的 GID 或补充组匹配文件 Group：使用 Group 权限位 */
        acl_mode = (inode->i_mode >> 3) & 7;  /* 取位 5-3 */
    } else {
        /* 都不匹配：使用 Others 权限位 */
        acl_mode = inode->i_mode & 7;          /* 取位 2-0 */
    }

    if ((acl_mode & mask) == mask)
        return 0;   /* 权限满足，允许 */
    return -EACCES; /* 权限不足 */
}
```

**关键设计细节**：

权限检查是**严格按 Owner → Group → Others 顺序匹配，找到第一个匹配的就停止**。这意味着：如果文件 Owner 是用户 A，且文件权限是 `---rwxrwx`（Owner 无权限，Group 和 Others 有权限），那么用户 A 访问这个文件时，内核会匹配 Owner 权限（`---`），**直接返回 EACCES**，不会继续看 Group 权限！

这个"反直觉"的行为是设计如此——文件所有者可以选择"把文件权限给其他人，但不给自己"。

### 1.2 目录权限的特殊语义

目录的 rwx 位与文件的语义完全不同：

| 权限 | 对文件的含义 | 对目录的含义 |
|-----|------------|------------|
| `r`（read）| 可以读取文件内容（cat file）| 可以列出目录内容（ls dir）|
| `w`（write）| 可以修改文件内容（echo >> file）| 可以在目录中创建/删除/重命名文件 |
| `x`（execute）| 可以执行文件（./script.sh）| 可以进入目录（cd dir）且可以访问目录中的文件 |

**目录 `x` 权限的重要性**：

如果一个目录没有 `x` 权限，即使有 `r` 权限，`ls` 可以列出文件名，但 `cat file` 会报错（`Permission denied`）——因为访问目录中的文件需要通过路径解析（`inode_permission` 的 `MAY_EXEC`），而路径解析需要目录的执行权限。

```bash
# 演示目录 x 权限的作用
mkdir testdir
chmod 644 testdir    # 有 r，无 x
ls testdir           # 可以列出文件名（r 权限允许）
cat testdir/file.txt # Permission denied（缺少 x，无法进入目录）

chmod 755 testdir    # 恢复 rwxr-xr-x
```

### 1.3 三元模型的局限：为什么需要 ACL

**场景**：假设你有一个 `/data/project` 目录：
- 用户 `alice` 是项目负责人，需要读写权限
- 用户 `bob` 是外部审计人员，只需要读权限
- 其他所有人没有权限

用 rwx 无法表达这个需求——要么把 bob 加入 alice 的组（bob 就获得了和 alice 相同的权限），要么创建一个新组（不够灵活，每次新增用户都要改组）。

**根本局限**：rwx 模型只有三个主体类别（Owner/Group/Others），无法表达"对某个特定用户/组的特殊授权"。

---

## 第 2 章 POSIX ACL：细粒度访问控制

### 2.1 ACL 是什么

**POSIX ACL（Access Control List，访问控制列表）** 是对 inode rwx 权限位的扩展——通过存储在文件的**扩展属性（Extended Attributes，xattr）** 中的 ACL 条目，为任意用户或组单独设置权限：

```bash
# 为 /data/project 设置 ACL
setfacl -m u:bob:r-x /data/project     # bob 用户：读+执行权限
setfacl -m g:auditors:r-x /data/project  # auditors 组：读+执行权限
setfacl -m u:carol:rwx /data/project   # carol 用户：完整权限

# 查看 ACL
getfacl /data/project
# file: data/project
# owner: alice
# group: devteam
# user::rwx           ← Owner（alice）的权限
# user:bob:r-x        ← bob 的特殊权限
# user:carol:rwx      ← carol 的特殊权限
# group::r-x          ← Group（devteam）的权限
# group:auditors:r-x  ← auditors 组的特殊权限
# mask::rwx           ← 有效权限掩码（限制 named user/group 的最大权限）
# other::---          ← Others 的权限
```

### 2.2 ACL 的内核存储：扩展属性（xattr）

ACL 条目存储在 inode 的**扩展属性**中，具体位置取决于文件系统：

- **ext4**：扩展属性存储在 inode 的内联区域（如果空间足够）或独立的 xattr 块（`i_file_acl` 指向）
- **XFS**：存储在 inode 的 attribute fork（与数据 fork 类似，可内联或使用 B+ 树）

```bash
# 查看文件的扩展属性（包含 ACL）
getfattr -d /data/project
# system.posix_acl_access=0sAgAAAAEAAAACAAAA...  ← ACL 以二进制形式存储
# system.posix_acl_default=...                   ← 默认 ACL（应用于目录中新创建的文件）

# 检查文件系统是否支持 ACL
tune2fs -l /dev/sda1 | grep "Default mount options"
# Default mount options: user_xattr acl   ← acl 出现说明支持
```

### 2.3 ACL 权限检查的内核逻辑

当文件有 ACL 时，内核的权限检查流程扩展为：

```
1. 检查文件是否有 ACL（inode->i_acl != NULL）
   → 无 ACL：走传统 rwx 检查（见第 1 章）
   → 有 ACL：走 ACL 检查流程

2. ACL 检查流程（按以下顺序逐一检查，找到第一个匹配的条目）：

   a. ACL_USER_OBJ（Owner）条目：
      若进程 UID == 文件 Owner → 使用此条目的权限，**停止**

   b. ACL_USER 条目（所有 named user 条目）：
      若进程 UID == 某个 named user → 取该条目权限 & mask → 判断，**停止**

   c. ACL_GROUP_OBJ（Group）条目 + 所有 ACL_GROUP 条目：
      若进程 GID 或补充组匹配任一组条目 → 取各匹配条目权限的并集 & mask → 判断，**停止**

   d. ACL_OTHER（Others）条目：
      使用此条目的权限，**停止**

3. 若请求的权限被授予 → 允许；否则 → EACCES
```

**mask 的作用（常见误解）**：

`mask` 是 ACL 的"有效权限上限"——所有 named user、named group 和 Group 条目的实际权限 = 条目权限 & mask。但 **Owner 条目和 Others 条目不受 mask 限制**。

```bash
# mask 的实际效果
getfacl /data/file
# user::rwx           ← Owner：不受 mask 限制
# user:bob:rwx        ← bob：有 rwx，但 mask=r-x，实际权限 = rwx & r-x = r-x
# mask::r-x           ← mask
# other::---

# 修改 mask 会影响所有 named user 和 group 的有效权限
setfacl -m m::r-- /data/file   # 收紧 mask：只允许读
getfacl /data/file
# user::rwx
# user:bob:rwx           #effective: r--  ← bob 实际只有读权限
# mask::r--
```

### 2.4 默认 ACL：目录继承机制

**默认 ACL（Default ACL）** 是目录的一个特殊 ACL 属性——当在该目录中**新创建文件或子目录时，自动继承默认 ACL** 作为新建对象的 ACL：

```bash
# 为目录设置默认 ACL
setfacl -d -m u:bob:r-x /data/project   # -d：设置默认 ACL

# 之后在 /data/project 中创建的所有新文件都会自动获得 bob:r-x 的 ACL
touch /data/project/newfile.txt
getfacl /data/project/newfile.txt
# user::rw-
# user:bob:r--         ← 自动继承（文件没有 x，所以是 r-- 而不是 r-x）
# group::r--
# mask::r--
# other::---
```

**默认 ACL 与 umask 的关系**：

新创建文件的权限 = 请求权限 & ~umask & 默认 ACL mask。这三者共同决定最终权限。

---

## 第 3 章 特殊权限位：setuid、setgid 与 sticky

### 3.1 setuid：以文件所有者身份运行

**setuid（Set User ID）位** 是 Unix 最古老的权限机制之一，也是 Linux 安全攻击面最大的特性之一。

**是什么**：对可执行文件设置 setuid 后，普通用户运行这个程序时，进程的**有效 UID（eUID）变为文件所有者的 UID**（通常是 root），而不是运行者的 UID。

**为什么需要它**：某些操作必须以 root 身份执行（如绑定低端口、修改 `/etc/passwd`、访问原始套接字），但为了安全，不能给普通用户完整的 root shell。setuid 允许特定程序在受控范围内暂时获得 root 权限。

```bash
# 典型的 setuid 程序
ls -la /usr/bin/passwd
# -rwsr-xr-x 1 root root 59976 ... /usr/bin/passwd
# ↑ 's' 表示 setuid 位已设置（且有 x 位，显示为 s；无 x 位显示为 S）

ls -la /bin/ping
# -rwsr-xr-x 1 root root 44440 ... /bin/ping
# ping 需要 RAW socket（CAP_NET_RAW），setuid 使其以 root 身份运行

# 设置 setuid 位
chmod u+s /path/to/program   # 方式 1
chmod 4755 /path/to/program  # 方式 2（4 = setuid, 7 = rwx Owner, 5=r-x Group, 5=r-x Others）
```

### 3.2 setuid 的安全风险

setuid root 程序是攻击者的首要目标——一旦程序存在漏洞（缓冲区溢出、命令注入等），攻击者可以借此获得 root 权限：

**经典攻击路径**：
1. 普通用户运行一个 setuid root 程序
2. 该程序有格式化字符串漏洞（`printf(user_input)`）
3. 攻击者构造特殊输入，触发任意代码执行
4. 代码以 root 身份运行（eUID=0），写入 `/etc/sudoers` 或 `/etc/passwd`

```bash
# 查找系统中所有 setuid root 程序（安全审计必做）
find / -perm /4000 -user root -type f 2>/dev/null
# /usr/bin/passwd
# /usr/bin/sudo
# /usr/bin/pkexec      ← 2022 年 CVE-2021-4034 漏洞来源！
# /usr/bin/newgrp
# /bin/ping
# /bin/su
# ...

# 移除不必要的 setuid 位（谨慎操作，可能影响功能）
chmod u-s /usr/bin/ping   # 如果不需要普通用户 ping，移除 setuid
# 注意：ping 需要 CAP_NET_RAW，移除 setuid 后只有 root 可以 ping
```

> [!warning] 生产避坑：setuid 的最小化原则
> 每个 setuid root 程序都是一个潜在的提权入口。安全加固的基本原则是：定期审计系统中的 setuid 程序，删除或替换不需要的 setuid 二进制文件。Capabilities（下一章）是替代 setuid 的现代化方案——只给程序需要的特定权限，而不是完整的 root 权限。

### 3.3 setgid：组权限传递

**setgid 位** 对目录和可执行文件有不同含义：

**对可执行文件**：类似 setuid，进程的有效 GID 变为文件所属组的 GID。

**对目录（更常用）**：在该目录中新创建的文件，其所属组自动继承**目录的所属组**，而不是创建者的主组。

```bash
# setgid 目录的典型应用：共享项目目录
mkdir /data/project
chown alice:devteam /data/project
chmod g+s /data/project   # 设置 setgid
chmod 2775 /data/project  # 2 = setgid, 775 = rwxrwxr-x

# 此后，任何用户在 /data/project 中创建的文件，
# 所属组自动设为 devteam（而不是创建者的默认组）
# 这样 devteam 的所有成员都能访问彼此创建的文件

# 验证
su - bob  # 切换到 bob 用户（属于 devteam 组）
touch /data/project/bob_file.txt
ls -la /data/project/bob_file.txt
# -rw-rw-r-- 1 bob devteam 0 ... bob_file.txt
#                  ↑ 自动继承目录的组（devteam），而不是 bob 的默认组
```

### 3.4 sticky bit：目录保护

**sticky bit（粘滞位）** 对目录的作用：**只有文件的所有者（或 root）才能删除目录中的文件**，即使其他用户对该目录有写权限。

最典型的例子是 `/tmp`：

```bash
ls -ld /tmp
# drwxrwxrwt 1 root root 4096 ... /tmp
#         ↑ 't' = sticky bit（且有 x 位）；'T' = sticky（无 x 位）

# /tmp 权限为 777（所有人可读写执行），但有 sticky bit
# 因此：
# - 任何用户都可以在 /tmp 创建文件
# - 但只有文件的创建者或 root 才能删除该文件
# - 防止用户 A 删除用户 B 在 /tmp 中的临时文件

# 设置 sticky bit
chmod +t /shared/tmp
chmod 1777 /shared/tmp  # 1 = sticky, 777 = rwxrwxrwx
```

---

## 第 4 章 Linux Capabilities：精细化的权限分解

### 4.1 为什么需要 Capabilities

传统 Unix 的权限模型只有两个层次：**普通用户**（严格受权限限制）和 **root**（不受任何限制）。这导致了一个根本性的安全问题：任何需要一点特权操作的程序，要么使用 setuid root（获得完整 root 权限），要么完全无法执行。

**Capabilities（POSIX 1003.1e）** 的思想是**将 root 的全能权力分解为粒度细的独立能力**，每个进程可以只持有其需要的那一部分能力，不需要完整的 root 权限。

这是"最小权限原则（Principle of Least Privilege）"在内核级别的实现。

### 4.2 常用 Capabilities 列表

Linux 5.x 定义了 40 个 Capability，以下是最重要的：

| Capability | 含义 | 典型使用者 |
|-----------|------|----------|
| `CAP_NET_BIND_SERVICE` | 绑定 1024 以下的特权端口 | nginx、httpd（绑定 80/443）|
| `CAP_NET_ADMIN` | 配置网络接口、防火墙、路由 | ip、iptables |
| `CAP_NET_RAW` | 使用原始套接字（ICMP ping）| ping、tcpdump |
| `CAP_SYS_ADMIN` | 超级管理（mount、设置主机名等，极其宽泛）| 容器运行时 |
| `CAP_SYS_PTRACE` | 跟踪任意进程（strace、gdb）| 调试工具 |
| `CAP_DAC_OVERRIDE` | 绕过文件 DAC 权限检查（读写任意文件）| 备份工具 |
| `CAP_DAC_READ_SEARCH` | 绕过文件 DAC 读权限和目录搜索权限 | 备份工具 |
| `CAP_SETUID` | 任意修改进程 UID（sudo 等）| sudo、su |
| `CAP_KILL` | 向任意进程发送信号 | kill 命令 |
| `CAP_SYS_CHROOT` | 使用 chroot() | 容器、沙箱 |
| `CAP_AUDIT_WRITE` | 向内核审计日志写入 | 审计守护进程 |
| `CAP_MKNOD` | 创建特殊文件（设备文件）| 容器初始化 |

> [!note] CAP_SYS_ADMIN 的危险性
> `CAP_SYS_ADMIN` 是最危险的 Capability——它覆盖了 "system administration" 的大部分操作，包括挂载文件系统、修改内核参数、操作 namespace 等。持有 `CAP_SYS_ADMIN` 的进程几乎与 root 等价。Docker 容器默认**不授予** `CAP_SYS_ADMIN`，如果需要，必须显式用 `--cap-add SYS_ADMIN` 启动——这是高风险操作，必须谨慎。

### 4.3 Capability 的三个集合

每个进程有三个 Capability 集合，内核凭证结构 `struct cred` 中存储：

```c
struct cred {
    /* ... */
    kernel_cap_t    cap_inheritable; /* 可被子进程继承的能力集 */
    kernel_cap_t    cap_permitted;   /* 进程允许持有的最大能力集 */
    kernel_cap_t    cap_effective;   /* 进程当前实际有效的能力集（内核检查这个！）*/
    kernel_cap_t    cap_bset;        /* 能力边界集（不可超过此集合）*/
    kernel_cap_t    cap_ambient;     /* 环境能力集（Linux 4.3+，可继承的环境 cap）*/
    /* ... */
};
```

**三个集合的关系**：

```
cap_permitted：进程被允许持有的能力（上限）
cap_effective：进程当前实际使用的能力（内核检查的集合）
cap_inheritable：exec 时可以传递给子进程的能力

关系约束：
  cap_effective ⊆ cap_permitted（有效集不能超过允许集）
  cap_permitted 在 exec 后的变化由文件的 capability 属性决定

内核检查特权操作时：
  if (capable(CAP_NET_BIND_SERVICE)) → 检查当前进程的 cap_effective 中是否有此 cap
```

### 4.4 文件 Capabilities：替代 setuid 的现代方案

与 setuid 类似，文件也可以附加 Capabilities 属性（存储在 xattr `security.capability` 中）。当程序被执行时，进程的有效 Capability 集会根据文件的 Capability 属性进行调整：

```bash
# 给 ping 添加 CAP_NET_RAW（替代 setuid root）
# 先移除 setuid 位
chmod u-s /bin/ping

# 添加文件 Capability
setcap cap_net_raw+ep /bin/ping
# +ep：将 CAP_NET_RAW 加入 Effective（e）和 Permitted（p）集合

# 验证
getcap /bin/ping
# /bin/ping cap_net_raw=ep

# 普通用户现在可以 ping（不需要 root，也不需要 setuid）
ping 8.8.8.8   # 成功！

# 更多示例
# Nginx 绑定 80 端口而不需要 root
setcap cap_net_bind_service+ep /usr/sbin/nginx

# 给 Python 脚本添加 Capability（实际上加在 Python 解释器上，影响所有脚本，不推荐）
# 更好的做法：用 ambient capabilities（环境能力集）
```

### 4.5 容器中的 Capabilities

Docker 和 Kubernetes 通过 Capabilities 机制实现容器的权限隔离：

```bash
# Docker 默认允许的 Capabilities（非 root 容器）
# Docker 默认给容器的 cap 集合（通过 docker inspect 查看）：
# CAP_AUDIT_WRITE, CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_FOWNER,
# CAP_FSETID, CAP_KILL, CAP_MKNOD, CAP_NET_BIND_SERVICE,
# CAP_NET_RAW, CAP_SETFCAP, CAP_SETGID, CAP_SETPCAP, CAP_SETUID,
# CAP_SYS_CHROOT

# 注意：CAP_NET_RAW 在 Docker 默认开启，允许容器发送原始包（ARP欺骗等）
# 安全加固：移除不需要的 cap
docker run --cap-drop=ALL --cap-add=NET_BIND_SERVICE nginx:latest
# 只保留绑定端口的能力，其他全部移除

# Kubernetes Pod 安全上下文
# pod.spec.containers[].securityContext:
#   capabilities:
#     drop: ["ALL"]
#     add: ["NET_BIND_SERVICE"]
```

```yaml
# Kubernetes 安全配置示例
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: nginx
    image: nginx:latest
    securityContext:
      runAsNonRoot: true          # 禁止以 root 运行
      runAsUser: 1000             # 以 UID 1000 运行
      allowPrivilegeEscalation: false  # 禁止提权（setuid 等）
      capabilities:
        drop: ["ALL"]             # 移除所有默认 cap
        add: ["NET_BIND_SERVICE"] # 只添加绑定端口的能力
      readOnlyRootFilesystem: true  # 根文件系统只读
```

---

## 第 5 章 MAC：超越 DAC 的强制访问控制

### 5.1 DAC 的根本局限：所有者决定权限

DAC（Discretionary Access Control，自主访问控制）的"自主"含义：**文件所有者可以自主设置权限**——owner 可以给任何人访问自己的文件，也可以禁止所有人访问。

这是 DAC 的根本弱点：如果 root 用户（或被攻陷的 root 权限进程）恶意或被利用，它可以读取系统中任意文件（因为 root 绕过 DAC 检查）。

**MAC（Mandatory Access Control，强制访问控制）** 在 DAC 之上增加了由系统管理员强制定义的策略——即使是 root，也不能绕过 MAC 策略访问被禁止的资源。

### 5.2 SELinux：Linux 中最成熟的 MAC 实现

**SELinux（Security-Enhanced Linux）** 是 NSA 开发、RHEL/CentOS 默认启用的 MAC 实现。其核心概念是**类型强制（Type Enforcement）**：

```bash
# 查看文件的 SELinux 上下文
ls -Z /etc/passwd
# -rw-r--r-- root root system_u:object_r:passwd_file_t:s0 /etc/passwd
#                       ↑         ↑            ↑          ↑
#                     用户    角色（role）    类型(type)  级别

# SELinux 策略规则示例：允许 httpd 进程读取 httpd_sys_content_t 类型的文件
# allow httpd_t httpd_sys_content_t:file { read getattr };
# 这意味着：即使 httpd 进程以 root 身份运行，
# 它也只能读取 httpd_sys_content_t 类型的文件，
# 无法访问 /etc/shadow（shadow_t 类型）等敏感文件

# 常见 SELinux 操作
getenforce          # 查看 SELinux 状态（Enforcing/Permissive/Disabled）
setenforce 0        # 临时切换到 Permissive（不强制，只记录）
setenforce 1        # 切换到 Enforcing（强制模式）

# 修复 SELinux 上下文（文件标签错误时）
restorecon -Rv /var/www/html   # 递归恢复 /var/www/html 的 SELinux 上下文

# 查看 SELinux 拒绝日志
ausearch -m avc -ts today      # 搜索今天的 AVC 拒绝事件
```

---

## 第 6 章 umask：新文件权限的默认值

### 6.1 umask 是什么

**umask（用户文件创建掩码）** 控制新创建文件和目录的默认权限。umask 是一个"屏蔽码"——新建文件的权限 = 请求权限 & ~umask：

```bash
# 查看当前 umask
umask
# 0022  ← 八进制表示

# 效果：
# 新建文件：系统请求 0666（rw-rw-rw-），实际权限 = 0666 & ~0022 = 0644（rw-r--r--）
# 新建目录：系统请求 0777（rwxrwxrwx），实际权限 = 0777 & ~0022 = 0755（rwxr-xr-x）

# 验证
touch testfile && ls -la testfile
# -rw-r--r-- 1 alice alice 0 ... testfile （权限 644）

mkdir testdir && ls -lad testdir
# drwxr-xr-x 2 alice alice 4096 ... testdir （权限 755）
```

### 6.2 umask 的典型值

| umask | 新建文件权限 | 新建目录权限 | 适用场景 |
|-------|------------|------------|---------|
| 022 | 644（rw-r--r--）| 755（rwxr-xr-x）| 默认（大多数 Linux 系统）|
| 027 | 640（rw-r-----）| 750（rwxr-x---）| 安全服务器（其他人无权限）|
| 077 | 600（rw-------）| 700（rwx------）| 极安全（只有所有者可访问）|
| 002 | 664（rw-rw-r--）| 775（rwxrwxr-x）| 协作开发（组内可写）|

---

## 小结

Linux 文件系统的安全边界由多层机制协同构成：

**三层权限体系的覆盖范围**：
- **DAC（rwx + ACL）**：决定"哪个用户/组可以对这个文件做什么"——灵活但以所有者为中心，root 可绕过
- **Capabilities**：决定"进程可以做哪些特权操作"——替代 setuid 的现代方案，最小权限原则的内核实现
- **MAC（SELinux）**：决定"哪类进程可以访问哪类资源"——强制执行，root 也不能绕过

**安全加固的优先级**：
1. **最小化 setuid 程序**：审计所有 setuid root 文件，用文件 Capabilities 替代不必要的 setuid
2. **容器权限最小化**：`--cap-drop=ALL` + 只添加必要的 cap，禁止 `allowPrivilegeEscalation`
3. **ACL 精细授权**：对共享目录使用 ACL 替代宽泛的 777 权限
4. **启用并配置 SELinux**：生产 RHEL/CentOS 系统保持 Enforcing 模式，不轻易 `setenforce 0`

下一篇 [[10 现代存储技术——NVMe、io_uring 与用户态存储]] 将探索 Linux 存储栈的前沿发展：NVMe 协议为什么能达到百万 IOPS？io_uring 如何用 ring buffer 几乎消除系统调用开销？SPDK（Storage Performance Development Kit）如何完全绕过内核，在用户态直接操作 NVMe 设备？

---

> [!note] 思考题
> 1. POSIX ACL 扩展了传统 rwx 权限模型。`setfacl -m u:alice:rx /data` 为特定用户设置权限。ACL 增加了管理复杂度——在什么规模的团队中引入 ACL 是值得的？ACL 与 LDAP/AD 集成后如何简化管理？
> 2. SELinux 的强制访问控制即使 root 也受策略限制。但 SELinux 策略配置极其复杂。在容器环境中 SELinux 与 seccomp、capabilities 的分工是什么？如果三者都启用，安全检查的执行顺序是怎样的？它们分别防御哪类攻击？
> 3. Linux capabilities 将 root 的特权分为 40+ 种细粒度能力。`CAP_NET_BIND_SERVICE` 允许绑定低端口而不需要 root。但 `CAP_SYS_ADMIN` 几乎等于 root——它包含了哪些危险操作？在容器安全中，为什么 Kubernetes 默认不授予 `CAP_SYS_ADMIN`？
