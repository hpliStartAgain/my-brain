---
title: "OOM Killer：内存耗尽时内核如何做出生死抉择"
date: 2026-02-28
tags: [Linux, 内存管理, OOM Killer, oom_score, oom_score_adj, 内存保护]
aliases: [OOM Killer, Out of Memory, OOM分数]
---

# OOM Killer：内存耗尽时内核如何做出生死抉择

**摘要：**

当 [[Swap机制：磁盘充当内存的代价与边界|Swap]] 用尽、[[内存回收：kswapd、LRU与直接回收的博弈|内存回收]]已经无能为力，系统还有进程不断地申请内存分配——此时 Linux 内核面临一个哲学级别的问题：**是让整个系统停摆（Hang），还是牺牲某个进程来拯救其他进程？** Linux 选择了后者，这就是 **OOM Killer**（Out-Of-Memory Killer）的存在意义。本文深入分析 OOM Killer 的完整决策链路：从触发条件（哪些分配请求会激活 OOM Killer）、到受害者选择算法（`oom_badness()` 函数如何计算每个进程的"死亡评分"）、再到 `oom_score_adj` 的调整语义（-1000 到 1000 的完整含义）、以及 OOM Killer 的实际击杀过程。最后给出生产环境中保护关键进程的实战方案，以及为什么容器场景下的 OOM 行为与裸机有所不同。

---

## 第 1 章 OOM Killer 的存在哲学

### 1.1 面对内存耗尽的三种选择

当系统内存完全耗尽时，操作系统面临三种设计选择：

**选择一：拒绝内存分配，返回失败**
让 `malloc()` 返回 NULL，`mmap()` 返回 ENOMEM，由用户程序自行处理。理论上最"正确"，但实践上大多数程序没有健壮地处理内存分配失败，会直接崩溃或产生不可预期的行为（空指针解引用、资源泄漏等）。更严重的是，内核自己的某些内存分配路径也无法接受分配失败（如中断处理程序的 GFP_ATOMIC 分配），会直接导致内核 panic。

**选择二：让系统 Hang**
停止所有新的内存分配，等待某个进程主动退出释放内存。这在实践中几乎等同于系统死机——大多数进程在无法分配内存时就已经卡死了，系统陷入永久停滞。

**选择三：主动杀死一个进程**
选择一个"牺牲者"，强制终止它，回收其占用的内存，让其他进程得以继续运行。这是 Linux 的选择——两害相权取其轻，牺牲一个进程，换取整个系统的存活。

OOM Killer 是这个哲学选择的工程实现。它不是一个常驻进程或守护线程，而是内嵌在内存分配路径中的一个**紧急处理函数**，只在内存分配彻底失败时才被调用。

> [!note] 设计哲学
> OOM Killer 的存在本身反映了 Linux 的一个核心设计取向：**系统整体可用性优先于个别进程的生存**。一个进程被 OOM 杀死，对于这个进程是灾难，但对于整个系统和其他进程来说可能是救命稻草。这个设计在服务器场景下通常是正确的——让关键服务（数据库、Web 服务器）存活比保留某个"内存饕餮"进程更有价值。

### 1.2 OOM 的触发前奏：回收失败的完整路径

OOM Killer 不是内存不足时的第一响应，它是**所有回收手段都失败后的最后手段**。内存分配的完整慢速路径（简化版）：

```
alloc_pages() 快速路径失败（可用内存低于水位线）
    ↓
唤醒 kswapd，尝试轻量级内存回收
    ↓
重试快速分配路径
    ↓（仍然失败）
直接回收（shrink_node）：扫描 LRU，回收文件页、尝试换出匿名页
    ↓（仍然失败）
内存紧缩（Compaction）：迁移可移动页，尝试合并大块连续内存
    ↓（仍然失败，且 may_oom 标志允许）
out_of_memory()：触发 OOM Killer
    ↓
选择受害进程，发送 SIGKILL
    ↓
等待受害进程退出，释放内存
    ↓
重试内存分配
```

有几个条件会**阻止 OOM Killer 触发**，即使内存已经耗尽：
- `GFP_NORETRY` 标志：宁可返回失败也不触发 OOM
- 分配来自内核线程（某些情况下内核线程可以等待）
- 系统正在关机流程中

---

## 第 2 章 受害者选择算法：oom_badness()

### 2.1 评分的基本思路

OOM Killer 需要从众多进程中选出一个"最合适的牺牲者"。什么样的进程最合适？直觉上应该满足两个条件：
1. **内存占用大**：杀死它能回收尽可能多的内存，一次 OOM 就解决问题
2. **重要性低**：不应该杀死关键系统进程（init、内核线程、SSH 连接等）

内核通过 `oom_badness()` 函数计算每个进程的"死亡评分"（badness score），分数越高，越有可能被杀死。

### 2.2 oom_badness() 的计算公式

现代 Linux 内核（3.x 以后）的 `oom_badness()` 实现（位于 `mm/oom_kill.c`）：

```c
/**
 * oom_badness - 计算进程的 OOM 死亡评分
 * @p:      候选进程
 * @totalpages: 系统总内存（包含 Swap）
 * 返回值：评分，越高越容易被杀死；-1 表示永远不杀
 */
unsigned long oom_badness(struct task_struct *p, unsigned long totalpages)
{
    long points;
    long adj;

    /* 获取该进程的 oom_score_adj 调整值（-1000 ~ 1000）*/
    adj = (long)p->signal->oom_score_adj;
    
    /* adj == -1000：绝对豁免，永远不杀此进程 */
    if (adj == OOM_SCORE_ADJ_MIN)  /* -1000 */
        return ULONG_MAX;   /* 返回特殊值，表示"跳过" */
    
    /* 基础分 = 进程占用的内存页数（RSS + Swap 使用量）
     * mm->total_vm 是虚拟内存大小，但内核实际使用 RSS+swap 计算 */
    points = get_mm_rss(p->mm) +       /* 实际驻留物理内存页数 */
             get_mm_counter(p->mm, MM_SWAPENTS) +  /* 使用的 Swap 槽位数 */
             mm_pgtables_bytes(p->mm) / PAGE_SIZE;  /* 页表本身占用的内存 */
    
    /* 将 oom_score_adj 转换为对 points 的乘法因子：
     * adj 范围 [-1000, 1000] 映射到 [0, 2×totalpages]
     * 效果：adj > 0 增加评分（更容易被杀），adj < 0 减少评分（更难被杀）*/
    adj *= totalpages / 1000;
    points += adj;
    
    /* 返回最终评分（最低为 1，确保至少能被选中）*/
    return points > 0 ? points : 1;
}
```

简化来说，评分公式是：

```
oom_score ≈ (进程实际使用的内存页数 + Swap 页数 + 页表页数) + oom_score_adj × (总内存/1000)
```

**关键点**：评分的主要成分是**实际内存使用量（RSS）**，这意味着：
- 吃内存最多的进程评分最高，最先被杀
- `oom_score_adj` 是对这个基础分的加减权重，可以显著影响最终排名

### 2.3 /proc/pid/oom_score：实时查看当前评分

```bash
# 查看某个进程当前的 OOM 评分
$ cat /proc/$(pgrep java)/oom_score
456

# 批量查看所有进程的 OOM 评分（按从高到低排序）
$ for pid in /proc/[0-9]*; do
    score=$(cat $pid/oom_score 2>/dev/null)
    comm=$(cat $pid/comm 2>/dev/null)
    printf "%5d %s\n" "$score" "$comm"
  done | sort -rn | head -20

# 典型输出：
# 8234 java        ← JVM 进程，大内存，高分
# 5678 mysqld      ← MySQL，高内存占用
#  456 nginx       ← Nginx worker，相对较少内存
#  123 sshd        ← SSH 守护进程
#    1 systemd     ← init 进程，通常设置 oom_score_adj=-1000
```

---

## 第 3 章 oom_score_adj：精确控制生死命运

### 3.1 oom_score_adj 的含义与范围

`/proc/<pid>/oom_score_adj` 是管理员和应用程序可以调整的参数，范围 **-1000 到 1000**：

| 值范围 | 效果 |
|--------|------|
| **-1000** | **绝对豁免**：无论内存多紧张，绝对不会被 OOM Killer 选中。Init 进程（PID 1）默认是 -1000。 |
| **-999 ~ -1** | **降低评分**：减少被杀概率，但不是绝对保护。数值越小（绝对值越大），保护越强。 |
| **0**（默认）| 不调整，按实际内存使用量排名 |
| **1 ~ 999** | **提高评分**：增加被杀概率。在容器场景中，超出内存限制的进程通常被设为 1000。 |
| **1000** | **极度危险**：无论内存多充足，始终是 OOM Killer 的首选目标 |

`oom_score_adj` 的效果是**乘法性质的**，不是简单的加减：调整值乘以系统总内存再除以 1000，才加到基础分上。对于一台 256GB 内存的服务器，`oom_score_adj = 100` 意味着在基础分上额外加上约 `100 × (256GB/4KB) / 1000 ≈ 6.5百万` 页的权重——这可能使一个原本低内存的进程突然变成 OOM 的首选目标。

### 3.2 设置 oom_score_adj

```bash
# 方式一：直接写 /proc
echo -500 > /proc/$(pgrep mysqld)/oom_score_adj

# 方式二：通过 systemd 服务配置（推荐，持久生效）
# 在 /etc/systemd/system/mysql.service.d/oom.conf 中：
[Service]
OOMScoreAdjust=-500

# 方式三：在程序启动代码中自己设置
# （在 Go/Java 启动脚本或进程初始化阶段）
echo -300 > /proc/self/oom_score_adj

# 查看当前值
cat /proc/$(pgrep mysqld)/oom_score_adj
```

> [!warning] 生产避坑
> `oom_score_adj` 值会被子进程继承。如果在 Shell 脚本中设置 `echo -1000 > /proc/self/oom_score_adj`，然后通过该脚本 `fork()` + `exec()` 启动其他进程，所有子进程都会继承 -1000（绝对豁免）。这可能导致真正需要保护的进程没有保护，而一些不重要的辅助进程却获得了豁免。正确做法：**在服务的主进程（而非父进程）中设置 oom_score_adj**，或使用 systemd 的 `OOMScoreAdjust` 指令精确控制。

### 3.3 不同进程的推荐 oom_score_adj 值

| 进程类型 | 推荐值 | 理由 |
|---------|--------|------|
| **init/systemd（PID 1）** | -1000（内核默认）| 系统核心，绝对不能杀 |
| **内核线程** | -1000（内核默认）| 内核基础设施，不可终止 |
| **SSH daemon（sshd）** | -999 ~ -500 | 运维入口，被杀则无法登录修复 |
| **主要数据库（MySQL/PostgreSQL）** | -500 ~ -800 | 核心业务数据，被杀代价极高 |
| **内存数据库（Redis）** | -300 ~ -500 | 重要但可以快速恢复 |
| **应用服务器（Tomcat/Spring Boot）** | -100 ~ 0 | 可以重启，优先级中等 |
| **批处理任务/离线计算** | 100 ~ 500 | 可以被杀后重试，牺牲代价低 |
| **测试/开发进程** | 500 ~ 1000 | 最优先被牺牲 |

---

## 第 4 章 OOM Killer 的实际执行过程

### 4.1 out_of_memory() 函数：决策中心

`out_of_memory()` 是 OOM Killer 的核心入口函数（`mm/oom_kill.c`）：

```c
bool out_of_memory(struct oom_control *oc)
{
    unsigned long freed = 0;
    
    /* 1. 检查是否有进程正在退出（等一等，可能很快就有内存释放）*/
    if (oom_killer_disabled)
        return false;
    
    /* 2. 检查是否是因为内存限制（cgroup 级别的 OOM，容器场景）*/
    if (!is_memcg_oom(oc)) {
        /* 系统级 OOM：调用各子系统的 notifier，给最后机会释放内存 */
        blocking_notifier_call_chain(&oom_notify_list, 0, &freed);
        if (freed > 0 && !is_sysrq_oom(oc))
            return true;  /* 有内存释放了，不需要杀进程 */
    }
    
    /* 3. 选择受害者：遍历所有进程，找到 oom_badness 最高的 */
    select_bad_process(oc);
    
    if (!oc->chosen) {
        /* 没找到合适的受害者（所有进程都豁免了？）
           这是非常罕见的情况，内核只能 panic */
        dump_header(oc, NULL);
        panic("System is deadlocked on memory\n");
    }
    
    /* 4. 击杀选中的进程 */
    oom_kill_process(oc, "Out of memory");
    return true;
}
```

### 4.2 select_bad_process：遍历所有进程评分

```c
static void select_bad_process(struct oom_control *oc)
{
    struct task_struct *p;
    
    oc->chosen_points = 0;
    oc->chosen = NULL;
    
    /* 遍历系统所有进程（线程组） */
    for_each_process(p) {
        unsigned long points;
        
        /* 跳过内核线程（没有 mm_struct）*/
        if (!p->mm)
            continue;
        
        /* 跳过正在退出的进程 */
        if (task_will_free_mem(p)) {
            oc->chosen = p;
            oc->chosen_points = ULONG_MAX;  /* 最高优先级：等它退出 */
            break;
        }
        
        /* 计算该进程的 OOM badness 评分 */
        points = oom_badness(p, oc->totalpages);
        if (points == ULONG_MAX)  /* adj == -1000，豁免 */
            continue;
        
        /* 记录评分最高的进程 */
        if (points > oc->chosen_points) {
            oc->chosen_points = points;
            oc->chosen = p;
        }
    }
}
```

注意：`select_bad_process` 评分的是**线程组（进程）级别**，不是单个线程。一个进程的所有线程共享同一个 `mm_struct`，内存使用量是整个进程的。

### 4.3 oom_kill_process：执行击杀

选定受害者后，`oom_kill_process()` 执行实际的击杀：

1. **打印 OOM 日志**（会出现在 `dmesg` 中）：
   ```
   [12345.678] Out of memory: Kill process 1234 (java) score 8234 or sacrifice child
   [12345.679] Killed process 1234 (java) total-vm:16777216kB, anon-rss:8388608kB, file-rss:1048576kB
   ```

2. **发送 SIGKILL** 到受害进程（以及其所有线程）：注意是 SIGKILL，不可捕获、不可忽略、不可阻塞。进程必须退出。

3. **设置 TIF_MEMDIE 标志**：被 OOM 击杀的进程在退出前，会被赋予特殊权限（忽略内存水位线），确保它能顺利完成退出（比如保存核心转储）而不因为内存不足再次 block。

4. **等待内存释放**：OOM Killer 不会立即重试内存分配，而是等待受害进程真正退出并释放内存（通过 `oom_wait_for_victim()`），然后内存分配路径重试。

### 4.4 OOM 日志解读

当 OOM 发生时，内核会向 `dmesg` 输出大量信息，解读这些日志是诊断 OOM 事故的核心手段：

```
# 触发 OOM 的进程信息
Out of memory: Kill process 28672 (java) score 765 or sacrifice child

# 内存统计快照
MemTotal:       131072000 kB   # 总物理内存 128GB
MemFree:            12345 kB   # 剩余极少
MemAvailable:       45678 kB
Buffers:             1234 kB
Cached:            567890 kB
# ... 完整 /proc/meminfo 快照 ...

# 进程内存使用详情（top 进程）
[ pid ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name
[28672] 1000 28672 4194304  2097152    4096000  1048576           0 java
[28673]    0 28673   65536    32768      65536        0        -500 mysqld
# ... 所有进程列表 ...

# 被击杀的进程
Killed process 28672 (java) total-vm:16777216kB, anon-rss:8388608kB, file-rss:1048576kB, shmem-rss:0kB
```

解读要点：
- **`score`**：被杀进程的 OOM badness 评分，越高说明越被内核认为"该死"
- **`total_vm`**：虚拟内存总量（VSZ），这只是已声明的，不代表实际使用
- **`anon-rss`**：匿名页实际驻留量——这才是真正消耗物理内存的主体
- **`file-rss`**：文件页实际驻留量（Page Cache 映射）
- 进程列表中的 `oom_score_adj`：负数表示受保护的进程

---

## 第 5 章 容器场景下的 OOM：cgroup 级别的杀手

### 5.1 容器 OOM vs 系统 OOM 的区别

在容器（Docker/Kubernetes）场景下，OOM 行为有重要区别：

**系统级 OOM**：整个物理机的内存耗尽，触发全局 OOM Killer，从所有进程中选受害者。

**cgroup 级 OOM（容器 OOM）**：某个容器（cgroup）的内存使用超过了 `memory.limit_in_bytes`（v1）或 `memory.max`（v2）设定的上限。此时 OOM Killer 只在这个 cgroup 范围内选受害者——即使整个系统还有大量空闲内存，这个容器内的进程也会被杀死。

这是容器场景下最常见的 OOM 来源：**应用程序使用的内存超过了 Kubernetes Pod 的 `resources.limits.memory` 设定值**。

### 5.2 Kubernetes 的 OOM 场景分析

Kubernetes 基于 cgroup 实现内存资源限制，OOM 触发逻辑：

```yaml
# Pod 资源配置示例
resources:
  requests:
    memory: "1Gi"    # 调度依据：保证至少有 1GB
  limits:
    memory: "2Gi"    # 硬上限：超过 2GB 触发容器级 OOM
```

当容器内进程的 RSS + Page Cache 超过 `limits.memory` 时：
1. 内核先尝试回收容器自己的 Page Cache（容器内的文件缓存）
2. 如果回收后仍然超限，触发 cgroup 级别的 OOM Killer
3. 杀死该容器（cgroup）内 `oom_score_adj` 最高的进程
4. 容器进程被杀 → 容器退出 → Kubernetes 根据 `restartPolicy` 决定是否重启

> [!info] 核心概念：容器的 OOM 评分调整
> 在容器内运行的进程，Kubernetes 会根据 QoS 类别自动设置 `oom_score_adj`：
> - **Guaranteed QoS**（requests == limits）：`oom_score_adj = -998`（几乎不被杀）
> - **Burstable QoS**（requests < limits）：`oom_score_adj = min(max(2, 1000 - (limits.memory/node_capacity)*1000), 999)`
> - **BestEffort QoS**（未设置 requests 和 limits）：`oom_score_adj = 1000`（最优先被杀）
> 
> 这套机制确保在节点内存不足时，BestEffort Pod 最先被杀，Guaranteed Pod 最后被杀，符合资源保证的语义。

### 5.3 容器 OOM 的监控与诊断

```bash
# 方法一：查看内核日志（dmesg）
$ dmesg | grep -E "OOM|Killed process|oom_kill"
[987654.321] Memory cgroup out of memory: Kill process 45678 (java) ...
[987654.322] Killed process 45678 (java) total-vm:4194304kB, anon-rss:2097152kB

# 方法二：查看容器的 OOM 计数
$ cat /sys/fs/cgroup/memory/kubepods/pod<pod-id>/<container-id>/memory.oom_control
oom_kill_disable 0
under_oom 0
oom_kill 3   ← 该容器已发生 3 次 OOM

# 方法三：通过 Kubernetes 事件
$ kubectl describe pod <pod-name>
# 查找 OOMKilled 事件和容器状态
$ kubectl get pod <pod-name> -o jsonpath='{.status.containerStatuses[0].lastState}'
# 输出类似：
# {"terminated":{"exitCode":137,"reason":"OOMKilled",...}}
# exitCode=137 = 128 + 9（SIGKILL），是容器 OOM 的标准退出码

# 方法四：cAdvisor/Prometheus 监控
# container_oom_events_total 指标
```

> [!warning] 生产避坑
> 容器 OOM 后 exit code 为 137（128+SIGKILL），但 **`exit code 137 不一定是 OOM**——`docker stop`（发送 SIGTERM 后等待超时，再发 SIGKILL）也会产生 exit code 137。区分方法：查看 `kubectl describe pod` 中容器状态的 `reason` 字段，OOM 会明确显示 `OOMKilled`；或者看 `dmesg` 中是否有对应的 OOM 日志。

---

## 第 6 章 防止 OOM 的工程实践

### 6.1 正确设置 oom_score_adj 保护关键进程

生产环境保护关键进程的标准做法：

```bash
# 方法一：直接写 /proc（临时，重启失效）
echo -800 > /proc/$(pgrep mysqld)/oom_score_adj

# 方法二：systemd 服务配置（推荐）
# 创建 /etc/systemd/system/mysql.service.d/oom-protect.conf
[Service]
OOMScoreAdjust=-800

# 重载配置
systemctl daemon-reload
systemctl restart mysql

# 方法三：启动脚本中设置（适合自定义服务）
#!/bin/bash
# 设置自己的 oom_score_adj
echo -500 > /proc/self/oom_score_adj
# 然后启动实际服务
exec java -jar app.jar

# 验证设置是否生效
cat /proc/$(pgrep mysqld)/oom_score_adj
# 应输出 -800
```

### 6.2 vm.overcommit_memory：控制内存超额分配

Linux 的内存超额分配策略由 `vm.overcommit_memory` 控制：

| 值 | 含义 |
|----|------|
| **0**（默认）| 启发式超额分配：内核根据当前可用内存判断是否允许分配，通常允许适度超额 |
| **1** | 无限超额分配：始终允许 `malloc()` 成功（除非真的没有虚拟地址空间），依赖 OOM 作为兜底 |
| **2** | 禁止超额分配：总可提交内存 = Swap + `vm.overcommit_ratio%` × 物理内存，超过上限的 `malloc()` 直接返回 NULL |

**金融/高可靠性系统**常用 `overcommit_memory=2`：宁可让 `malloc()` 明确失败（应用程序可以处理），也不要神秘的 OOM 杀死进程。代价是无法使用 Overcommit 带来的内存效率优势，需要根据实际内存使用量来精确配置系统容量。

```bash
# 查看当前超额分配策略
$ cat /proc/sys/vm/overcommit_memory
0

# 查看当前已提交内存与上限（overcommit_memory=2 时有意义）
$ cat /proc/meminfo | grep -E "CommitLimit|Committed_AS"
CommitLimit:    140000000 kB   # 最大可提交内存上限
Committed_AS:    89567890 kB   # 当前所有进程已承诺使用的内存总量
```

### 6.3 vm.panic_on_oom：OOM 时 Panic 还是 Kill

某些场景下，进程被 OOM 杀死后，系统状态已经无法恢复正常（比如数据库主进程被杀，从进程无法工作）。这种情况下，让系统直接 panic（触发 kdump 或自动重启）可能比继续带病运行更好：

```bash
# 0（默认）：OOM 时启动 OOM Killer 杀进程
$ cat /proc/sys/vm/panic_on_oom
0

# 1：OOM 时，如果没有进程可以被杀，则 panic
# 2：OOM 时，直接 panic（不尝试杀进程）
```

对于**高可用集群**中的非主节点，有时会配置 `panic_on_oom=2`，配合 `kernel.panic=5`（5秒后自动重启），实现"OOM 时自动重启节点"的自愈机制，比带病运行的节点破坏集群一致性更好。

### 6.4 mlock 锁定关键内存：从根源防止换出和 OOM

`mlock` 不仅防止内存被换出到 Swap，还确保被锁定的内存不会被 OOM Killer 作为回收对象（锁定的内存不参与 LRU 回收）：

```c
// 在程序启动时锁定所有当前和未来的内存
mlockall(MCL_CURRENT | MCL_FUTURE);

// 或者只锁定特定关键数据结构
mlock(critical_buffer, buffer_size);
```

常见使用场景：
- Redis：可以在配置文件中设置 `activerehashing yes` 并通过 `ulimit -l unlimited` + 代码层面的 `mlockall`，防止 Redis 的内存被换出
- 实时进程：高频交易、音频处理等对延迟极度敏感的进程
- 数据库：PostgreSQL 可以通过 `shared_buffers` 参数结合 `mlock` 锁定 shared buffer

---

## 第 7 章 OOM 事故的事后分析

### 7.1 从 dmesg 日志重建事故现场

OOM 发生时，内核日志提供了丰富的诊断信息。一个完整的分析流程：

```bash
# 步骤一：确认 OOM 发生
$ dmesg -T | grep -E "Out of memory|Killed process|OOM"
[2026-02-28 03:14:15] Out of memory: Kill process 12345 (java) score 7823 or sacrifice child

# 步骤二：查看完整的内存快照（OOM 发生时刻的 /proc/meminfo）
$ dmesg | grep -A 50 "Out of memory"
# 重点关注：MemTotal, MemFree, Cached, SwapTotal, SwapFree

# 步骤三：找出内存最大的进程（从 dmesg 进程列表）
# dmesg 中会打印所有进程的 [pid, uid, tgid, total_vm, rss, ...] 列表
# 按 rss 排序，找出嫌疑人

# 步骤四：看被杀进程的内存成分
# anon-rss：堆内存（代码数据）
# file-rss：文件映射（包括 jar、so 库等）
# 异常情况：anon-rss 极高 → 可能内存泄漏
#            file-rss 极高 → 可能大量 mmap 文件

# 步骤五：回溯时间线
# 用 Prometheus/Grafana 查看 OOM 前几小时的内存增长趋势
# container_memory_working_set_bytes（容器内存使用）是否在异常增长？
```

### 7.2 区分内存泄漏与合法内存增长

OOM 的根因通常是以下之一：

**内存泄漏（Memory Leak）**：进程内存持续单调增长，不释放。诊断方法：观察 `/proc/<pid>/status` 的 `VmRSS` 随时间是否持续增长，或使用 `valgrind --leak-check=full`（C/C++）、`jmap -heap`（Java）、`memory_profiler`（Python）进行内存分析。

**内存需求估算错误**：业务增长或数据量增大，导致实际内存使用超过了当初的资源规划。诊断方法：查看内存使用随业务量的相关性，评估是否需要扩容。

**Page Cache 挤占**：系统有大量文件 I/O，Page Cache 占满内存，导致可用内存不足。诊断方法：看 `Cached` 和 `MemAvailable` 的关系，如果 `MemAvailable` 持续较高但 OOM 仍然发生，说明有大量不可回收内存（匿名页）才是主要原因。

**内存碎片**：无法分配大块连续内存（order > 0 的分配失败）。诊断方法：看 `/proc/buddyinfo`，检查高 order 空闲块是否耗尽，`dmesg` 中是否有"page allocation failure"而非"Out of memory"。

---

## 第 8 章 总结

OOM Killer 是 Linux 内存管理的最后一道防线，本文的核心认知：

**1. OOM Killer 的本质是两害取其轻**：让整个系统停摆比牺牲一个进程更糟糕。OOM Killer 是在所有回收手段（kswapd、直接回收、Swap）都失败后的最后手段。

**2. oom_badness() 的核心逻辑**：评分 ≈ 进程 RSS + Swap 使用量，并在此基础上叠加 `oom_score_adj` 的权重偏移。杀内存最大且调整权重最高的进程。

**3. oom_score_adj 是生产保护的关键工具**：-1000 绝对豁免，-999 ~ -1 降低被杀概率，0 默认，正值主动增加被杀概率。关键服务必须设置负值保护，通过 systemd `OOMScoreAdjust` 持久生效。

**4. 容器 OOM 是 cgroup 级别的事件**：超出 `limits.memory` 即触发，与系统整体内存无关。Kubernetes 根据 QoS 类别自动设置 `oom_score_adj`，Guaranteed Pod 最受保护。exit code 137 是容器 OOM 的标志（但不是唯一含义）。

**5. 预防远胜于亡羊补牢**：通过合理的内存限制规划、正确设置 `oom_score_adj`、配置 `overcommit_memory`、以及持续的内存使用监控，可以将 OOM 事故的发生概率降到最低。

至此，我们已经覆盖了 Linux 内存管理的核心运行机制。接下来进入"高级特性层"，探讨[[大页内存 HugePage：TLB Miss的终极解法|大页内存（HugePage）]]——一个在特定场景下能带来显著性能提升的高级优化机制。

---

## 参考资料

- Linux Kernel Source: `mm/oom_kill.c`（`out_of_memory`, `oom_badness`, `oom_kill_process`）
- Linux Kernel Documentation: [OOM Killer](https://www.kernel.org/doc/html/latest/admin-guide/mm/concepts.html)
- Brendan Gregg, *Systems Performance, 2nd Ed.*, Chapter 7: Memory（OOM section）
- [Linux OOM Killer - Wesley Aptekar-Cassels Blog](https://blog.wesleyac.com/posts/linux-kernel-oom-killer)
- [Understanding Memory Overcommitment and OOM - Baeldung](https://www.baeldung.com/linux/memory-overcommitment-oom-killer)
- Kubernetes Documentation: [Managing Resources for Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
