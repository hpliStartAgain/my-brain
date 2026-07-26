---
title: "进程的终结与善后——exit、wait 与僵尸进程"
date: 2026-03-02
tags: [do_exit, exit, Linux, SIGCHLD, wait, waitpid, 僵尸进程, 孤儿进程, 进程管理]
aliases: ["Linux进程退出", "僵尸进程原理", "孤儿进程收养", "exit内核实现"]
---

**摘要：**

进程的终结不是一个瞬间的事件，而是一个**有序的资源释放过程**，同时还涉及父进程的"善后"责任。`exit()` 系统调用触发后，内核会按特定顺序依次释放各类资源——但有一件事内核刻意不做：**不立即销毁 `task_struct`**。进程退出后，`task_struct` 会继续存在（处于僵尸状态），等待父进程通过 `wait()` 来收割（reap），获取子进程的退出状态。如果父进程从未调用 `wait()`，僵尸进程就永久积累；如果父进程先于子进程退出，子进程就成了孤儿，由 `init`/`systemd` 收养。本文深入解析 `do_exit()` 的内核路径、资源释放的顺序逻辑、僵尸进程的本质（为什么必须存在）以及生产中僵尸进程的排查与消除方法。

---

## 第 1 章 进程退出的两条路径

### 1.1 主动退出与被动退出

进程的终结有两种触发方式：

**主动退出（Voluntary Exit）**：
- `main()` 函数 `return`（C 运行库将返回值传递给 `exit()`）
- 程序显式调用 `exit(status)`、`_exit(status)` 或 `_Exit(status)`
- 多线程程序中最后一个线程退出

**被动退出（Involuntary Exit）**：
- 收到不可忽略的致命信号（如 `SIGKILL`、`SIGSEGV`、`SIGTERM` 未被处理）
- 内核检测到不可恢复的错误（如访问非法内存导致 `SIGSEGV`）

无论哪种方式，最终都汇聚到内核函数 `do_exit()`。

### 1.2 exit() 与 _exit() 的本质区别

很多开发者将 `exit()` 和 `_exit()` 混为一谈，但它们有关键区别：

```c
/* C 标准库函数 exit()（glibc 中的实现） */
void exit(int status) {
    /* 1. 按 LIFO 顺序调用所有通过 atexit() 注册的函数 */
    call_atexit_handlers();

    /* 2. 刷新所有打开的 stdio 缓冲区（fflush(NULL)）*/
    fflush(NULL);

    /* 3. 关闭所有打开的 stdio 流 */
    fclose_all_streams();

    /* 4. 调用 _exit() 进行真正的系统调用退出 */
    _exit(status);
}

/* _exit() 系统调用包装（直接进入内核，不做任何用户态清理）*/
void _exit(int status) {
    syscall(SYS_exit_group, status);   /* 或 SYS_exit 针对单线程 */
}
```

**为什么 `vfork()` 的子进程必须用 `_exit()` 而不是 `exit()`？**

`vfork()` 的子进程与父进程共享地址空间（`CLONE_VM`）。如果子进程调用 `exit()`，会刷新并关闭 stdio 缓冲区——这些 `FILE` 结构体是共享内存，操作完成后父进程的 stdio 状态就被破坏了（比如缓冲区被 free、`FILE` 结构体被标记为已关闭）。`_exit()` 直接进内核，跳过所有用户态清理，是唯一安全的选择（详见 [[03 进程的诞生——fork 的内核之旅]]）。

---

## 第 2 章 do_exit：内核视角的进程终结

### 2.1 do_exit 的执行路径

`_exit()` 系统调用进入内核后，执行 `do_exit()`。这是进程终结的核心内核函数：

```
_exit(status)
  ↓ 系统调用
sys_exit_group(status)    ← 终止整个线程组（所有线程）
  ↓
do_group_exit(status)
  ↓ 对每个线程发送信号，等待其调用 do_exit
do_exit(status)           ← 单个线程/进程的退出核心逻辑
```

### 2.2 do_exit 的关键步骤

```c
void __noreturn do_exit(long code) {
    struct task_struct *tsk = current;

    /* === 步骤 1：设置进程状态为 TASK_DEAD（不可中断）=== */
    /* 防止退出过程中被调度出去 */
    tsk->flags |= PF_EXITING;

    /* === 步骤 2：触发性能/审计相关钩子 === */
    perf_event_exit_task(tsk);

    /* === 步骤 3：释放用户态内存（mm_struct）=== */
    exit_mm();
    /* 调用 mmput(mm)，减少 mm 的引用计数 */
    /* 若引用计数归零（最后一个线程退出），释放所有 VMA、页表、物理内存 */
    /* 注意：这是最耗时的步骤，对大进程可能需要毫秒级时间 */

    /* === 步骤 4：释放信号相关资源 === */
    exit_sem(tsk);         /* 释放 POSIX 信号量等待 */
    exit_shm(tsk);         /* 释放共享内存 */

    /* === 步骤 5：关闭文件描述符 === */
    exit_files(tsk);
    /* 减少 files_struct 的引用计数，若归零则关闭所有 fd */
    /* 关闭 fd 时，内核会对每个 fd 调用 release() 操作 */
    /* 对于 socket：发送 FIN，通知对端连接关闭 */
    /* 对于文件：若引用计数归零，释放文件缓存、更新磁盘元数据 */

    /* === 步骤 6：释放文件系统信息 === */
    exit_fs(tsk);          /* 减少 fs_struct 引用计数（当前目录、根目录）*/

    /* === 步骤 7：设置退出代码 === */
    tsk->exit_code = code;

    /* === 步骤 8：通知父进程（发送 SIGCHLD）=== */
    exit_notify(tsk, group_dead);
    /* exit_notify 内部：
       1. 重新分配子进程给 init（孤儿进程处理）
       2. 向父进程发送 SIGCHLD 信号
       3. 唤醒正在 wait() 的父进程
    */

    /* === 步骤 9：转入僵尸状态 === */
    tsk->exit_state = EXIT_ZOMBIE;

    /* === 步骤 10：调度出去（永不返回）=== */
    /* 进程进入 TASK_DEAD 状态，调度器选择下一个进程运行 */
    /* task_struct 此时仍然存在，等待父进程 wait() */
    do_task_dead();
    /* NEVER REACHED */
}
```

### 2.3 资源释放的顺序设计

`do_exit()` 释放资源的顺序不是随意的，而是经过精心设计的：

**为什么先释放内存（`exit_mm`），再关闭文件（`exit_files`）？**

关闭文件可能触发 `write()` 操作（刷新文件系统缓存），`write()` 需要访问内存中的缓冲数据。如果先关闭文件，再释放内存，就可能访问已释放的内存——顺序颠倒会产生 use-after-free 问题。

**为什么 `exit_notify` 在最后？**

通知父进程（发 `SIGCHLD`）是进程对外的最后一个"动作"。在这之前，进程必须确保所有资源已经妥善处理（文件关闭、网络连接通知对端），否则父进程可能在子进程还没完全清理完就开始处理 `SIGCHLD`，导致竞态。

---

## 第 3 章 僵尸进程：为什么必须存在

### 3.1 僵尸进程的本质

进程调用 `do_exit()` 后，绝大多数资源（内存、文件、信号）都被释放了。但 **`task_struct` 本身没有被销毁**——进程进入 `EXIT_ZOMBIE` 状态，此时：

- 进程不再被调度运行（`task_struct` 不在任何运行队列中）
- 内存、文件、网络连接已全部释放（僵尸进程不消耗这些资源）
- `task_struct` 仍然保留，其中包含退出状态（`exit_code`）

这个处于 `EXIT_ZOMBIE` 状态的 `task_struct` 就是**僵尸进程（Zombie Process）**。

> [!info] 核心概念：为什么僵尸进程必须存在？
> 僵尸进程的存在不是设计缺陷，而是 Unix 进程模型的必要组成部分。原因是：**父进程需要能够获取子进程的退出状态**（成功退出还是崩溃？退出码是什么？消耗了多少 CPU 时间？）。
>
> 如果进程退出后立即销毁 `task_struct`，父进程调用 `wait()` 时就找不到任何记录——无法知道子进程的退出状态。僵尸状态就是为了"暂存退出状态，等待父进程来取"而存在的中间状态。
>
> 这就像快递柜的设计：包裹送到后，快递员不直接扔掉，而是放在柜子里等你取。僵尸进程的 `task_struct` 就是那个柜子，父进程的 `wait()` 就是取包裹的动作。

**在 `top` 或 `ps` 中识别僵尸进程**：

```bash
# 查看系统中的僵尸进程数量
cat /proc/loadavg
# 输出：0.12 0.18 0.22 1/234 1234
#                            ↑ 分子是当前运行/可运行的进程数，分母是总进程数（不含僵尸）

# 用 ps 找出所有僵尸进程
ps aux | grep Z

# 或：
ps -eo pid,ppid,state,comm | awk '$3=="Z"'
# 输出：僵尸进程的 PID、其父进程 PPID、状态(Z)、进程名
```

### 3.2 僵尸进程的危害

僵尸进程本身不消耗内存（已释放）、不占用 CPU、不占用文件描述符。它唯一占用的资源是：
1. **一个 `task_struct` 结构体**（几 KB 内核内存）
2. **一个 PID**（系统 PID 有上限，通常 4194304）

少量僵尸进程无害。但如果一个程序持续产生子进程却从不 `wait()`，僵尸进程就会无限积累，最终耗尽系统的 PID 空间——此时新进程无法创建，系统功能受损。

```bash
# 查看系统 PID 上限
cat /proc/sys/kernel/pid_max
# 4194304（Linux 64 位系统默认值）

# 当前已使用的 PID 数
ps aux | wc -l
```

---

## 第 4 章 wait：父进程的善后责任

### 4.1 wait 系列函数

父进程通过 `wait()` 家族函数来"收割"（reap）已退出的子进程——读取其退出状态，并让内核销毁其 `task_struct`：

```c
/* 等待任意子进程退出 */
pid_t wait(int *status);

/* 等待特定子进程（pid > 0），或进程组（pid < 0），或任意（pid = -1）*/
pid_t waitpid(pid_t pid, int *status, int options);

/* 获取更详细的退出信息（资源使用量等）*/
int waitid(idtype_t idtype, id_t id, siginfo_t *infop, int options, struct rusage *usage);

/* 等待子进程并获取其资源使用统计 */
pid_t wait4(pid_t pid, int *status, int options, struct rusage *rusage);
```

**解析 `status` 的宏**：

```c
int status;
pid_t pid = waitpid(-1, &status, 0);   /* 等待任意子进程 */

if (WIFEXITED(status)) {
    /* 正常退出（调用了 exit() 或 main() 返回）*/
    int exit_code = WEXITSTATUS(status);   /* 获取退出码（0-255）*/
    printf("正常退出，退出码：%d\n", exit_code);
}

if (WIFSIGNALED(status)) {
    /* 被信号杀死 */
    int sig = WTERMSIG(status);   /* 获取导致终止的信号号 */
    printf("被信号 %d 杀死\n", sig);

    if (WCOREDUMP(status)) {
        printf("产生了 core dump 文件\n");
    }
}

if (WIFSTOPPED(status)) {
    /* 被信号暂停（如 SIGSTOP、SIGTSTP）*/
    int sig = WSTOPSIG(status);
    printf("被信号 %d 暂停\n", sig);
}
```

### 4.2 wait 的内核实现：如何找到退出的子进程

`wait()` 的内核实现 `do_wait()` 的核心逻辑：

```c
/* do_wait 的核心逻辑（简化）*/
static int do_wait(struct wait_opts *wo) {
    struct task_struct *tsk = current;
    int retval;

repeat:
    /* 遍历当前进程的所有子进程 */
    list_for_each_entry(p, &tsk->children, sibling) {
        /* 检查这个子进程是否符合等待条件（pid 匹配、状态匹配）*/
        retval = wait_consider_task(wo, 0, p);
        if (retval)
            return retval;
    }

    /* 还要检查被 ptrace 追踪的进程（ptraced 子进程）*/
    list_for_each_entry(p, &tsk->ptraced, ptrace_entry) {
        retval = wait_consider_task(wo, 1, p);
        if (retval)
            return retval;
    }

    /* 没有找到符合条件的子进程 */
    if (wo->wo_flags & WNOHANG) {
        return 0;   /* WNOHANG：不阻塞，立即返回 */
    }

    /* 将当前进程加入等待队列，让出 CPU（阻塞，等待 SIGCHLD 唤醒）*/
    schedule();
    goto repeat;
}
```

**`wait_consider_task()` 的核心判断**：

```c
static int wait_consider_task(struct wait_opts *wo, int ptrace, struct task_struct *p) {
    /* 检查进程状态 */
    switch (p->exit_state) {
    case EXIT_ZOMBIE:
        /* 子进程已退出（僵尸状态）：读取退出状态，销毁 task_struct */
        return wait_task_zombie(wo, p);

    case EXIT_DEAD:
        /* 已经被收割（不应该遍历到，保险处理）*/
        return 0;
    }

    /* 进程还在运行或停止：检查是否需要通知（WUNTRACED/WCONTINUED 标志）*/
    /* ... */
    return 0;
}
```

**`wait_task_zombie()` 的关键操作**：

```c
static int wait_task_zombie(struct wait_opts *wo, struct task_struct *p) {
    /* 1. 从父进程的 children 链表中移除子进程 */
    list_del_init(&p->sibling);

    /* 2. 将退出状态复制到用户态的 status 指针 */
    wo->wo_stat = (p->exit_code << 8) | 0;  /* 正常退出的状态编码 */

    /* 3. 累加子进程的资源使用量到父进程 */
    current->signal->cutime += p->utime;    /* 用户态 CPU 时间 */
    current->signal->cstime += p->stime;    /* 内核态 CPU 时间 */

    /* 4. 将进程状态改为 EXIT_DEAD（不再是僵尸）*/
    p->exit_state = EXIT_DEAD;

    /* 5. 释放 task_struct（真正的销毁）*/
    release_task(p);
    /* release_task 内部：
       - 从 PID hash 表中移除
       - 调用 put_task_struct()，减少引用计数，归零时释放 task_struct 内存
    */

    return p->pid;  /* 返回收割的子进程 PID */
}
```

### 4.3 SIGCHLD：内核对父进程的异步通知

父进程可以用两种方式感知子进程退出：

**方式一：同步等待（阻塞式 wait）**

```c
pid_t pid = fork();
if (pid > 0) {
    int status;
    waitpid(pid, &status, 0);   /* 阻塞，直到子进程退出 */
    /* 处理退出状态 */
}
```

**方式二：异步通知（SIGCHLD 信号处理）**

内核在子进程退出时，会自动向父进程发送 `SIGCHLD` 信号。父进程可以注册信号处理函数，在信号处理函数中调用 `wait()` 来非阻塞地收割子进程：

```c
/* 信号处理函数（在 signal handler 中正确收割子进程）*/
void sigchld_handler(int signo) {
    int status;
    pid_t pid;

    /* 关键：必须用 while 循环，不能只调用一次 wait() */
    /* 原因：多个子进程可能同时退出，信号可能被合并为一次（信号不排队）*/
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        /* WNOHANG：不阻塞，只收割已退出的子进程 */
        if (WIFEXITED(status)) {
            printf("子进程 %d 以退出码 %d 退出\n", pid, WEXITSTATUS(status));
        }
    }
}

int main() {
    struct sigaction sa = {
        .sa_handler = sigchld_handler,
        .sa_flags = SA_RESTART | SA_NOCLDSTOP,  /* SA_NOCLDSTOP：只在子进程退出时通知，不在暂停时通知 */
    };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGCHLD, &sa, NULL);

    /* 创建子进程... */
}
```

> [!warning] 生产避坑：SIGCHLD 可能被合并
> Linux 的实时信号（`SIGRTMIN` 及以上）是排队的（不丢失），但普通信号（包括 `SIGCHLD`）是**不排队**的：如果在处理一个 `SIGCHLD` 时，又有多个子进程退出，后续的 `SIGCHLD` 信号可能只被记录一次（而不是多次）。这就是为什么 `SIGCHLD` 处理函数中必须用 `while` 循环调用 `waitpid(-1, ..., WNOHANG)`——一次 `SIGCHLD` 可能对应多个已退出的子进程。

---

## 第 5 章 孤儿进程与 init 的收养机制

### 5.1 问题场景：父进程先于子进程退出

正常情况下，父进程先 `fork()` 子进程，子进程先退出（父进程调用 `wait()` 收割）。但如果父进程意外崩溃或主动退出，而子进程还在运行，就出现了**孤儿进程（Orphan Process）**。

孤儿进程面临的问题：子进程将来退出时，向谁发 `SIGCHLD`？谁来 `wait()` 收割它？如果没有进程收割，子进程退出后就永远是僵尸状态。

**Linux 的解决方案：init 收养**

当一个进程退出时（`exit_notify()` 阶段），内核会检查其所有子进程，将它们重新挂到一个"养父"进程下：

```c
/* exit_notify 中的孤儿进程处理（简化）*/
static void forget_original_parent(struct task_struct *father, struct list_head *dead) {
    struct task_struct *p, *n, *reaper;

    /* 找到合适的"养父"进程 */
    /* 优先使用同一线程组的其他线程 */
    /* 其次使用 subreaper（通过 prctl(PR_SET_CHILD_SUBREAPER) 设置的祖先进程）*/
    /* 最后使用 PID 1（init/systemd）*/
    reaper = find_child_reaper(father, dead);

    /* 将所有子进程挂到 reaper 的 children 链表下 */
    list_for_each_entry_safe(p, n, &father->children, sibling) {
        /* 修改子进程的 parent 和 real_parent 字段 */
        p->real_parent = reaper;
        if (p->parent == father)
            p->parent = reaper;
        /* 将子进程从 father->children 移到 reaper->children */
        add_parent(p, reaper);
    }
}
```

### 5.2 subreaper：更精细的孤儿收养控制

`init`（PID=1）是兜底的孤儿收养者，但在某些场景下，我们希望由特定的进程而不是全局的 init 来收养孤儿进程。Linux 3.4 引入了 `PR_SET_CHILD_SUBREAPER`：

```c
/* 将当前进程标记为 subreaper（子收割者）*/
prctl(PR_SET_CHILD_SUBREAPER, 1);
/* 标记后：当前进程的后代进程成为孤儿时，
   优先被当前进程收养（而不是 init/PID=1）*/
```

**典型应用场景**：

- **Docker/容器运行时**：容器内的 `tini` 或 Kubernetes 的 `pause` 进程设置为 subreaper，负责收割容器内的孤儿进程，防止容器内产生僵尸进程
- **进程管理器**（如 `s6`、`runit`）：supervise 进程设置为 subreaper，统一管理其下所有服务进程的生命周期
- **Shell**：Shell 本身就是其命令进程的 "父进程"，但 bash 并不需要设置 subreaper，因为它一直活着等待子进程退出

```bash
# systemd 是现代 Linux 的 PID 1，同时也是 subreaper
# 它持续运行 wait() 循环，处理所有孤儿进程
cat /proc/1/status | grep Name
# Name: systemd
```

---

## 第 6 章 僵尸进程的生产排查与消除

### 6.1 定位僵尸进程及其父进程

```bash
# 方法一：ps 命令
ps -eo pid,ppid,state,comm | awk '$3=="Z" {print "僵尸:", $0}'

# 方法二：/proc 文件系统
grep -l "Z" /proc/*/status 2>/dev/null | while read f; do
    pid=$(echo $f | cut -d/ -f3)
    ppid=$(grep PPid /proc/$pid/status | awk '{print $2}')
    name=$(grep Name /proc/$pid/status | awk '{print $2}')
    pname=$(grep Name /proc/$ppid/status 2>/dev/null | awk '{print $2}')
    echo "僵尸: PID=$pid ($name) 父进程: PPID=$ppid ($pname)"
done

# 输出示例：
# 僵尸: PID=12345 (worker.py) 父进程: PPID=12000 (python3)
```

### 6.2 消除僵尸进程的方法

**方法一：让父进程调用 wait()（根本解决）**

```bash
# 如果父进程是自己编写的程序，修复代码，正确处理 SIGCHLD
# 或在进程池模型中，周期性地调用 waitpid(-1, ..., WNOHANG)
```

**方法二：向父进程发送 SIGCHLD（触发其 SIGCHLD 处理函数）**

```bash
# 如果父进程有 SIGCHLD 处理函数，发送信号让它 wait()
kill -SIGCHLD <父进程PID>
```

**方法三：杀死父进程（孤儿化子僵尸，让 init 收养并收割）**

```bash
# 僵尸进程本身无法被 kill（已经死亡，SIGKILL 对僵尸无效）
# 但杀死父进程后，僵尸进程成为孤儿，被 init 收养
# init 持续运行 wait() 循环，会立即收割僵尸
kill -9 <父进程PID>
# 注意：这会影响父进程的所有子进程，需要评估影响
```

**方法四：重启产生僵尸进程的服务（临时方案）**

```bash
# 对于无法直接修复的第三方服务
systemctl restart <service-name>
# 服务重启会重新创建父进程，老的僵尸进程被 init 收割
```

> [!warning] 生产避坑：僵尸进程无法被 kill -9
> `SIGKILL` 是发给进程的信号，而僵尸进程已经退出——没有运行的代码来处理信号。内核对僵尸进程的 `kill` 操作直接返回，信号被丢弃。消除僵尸进程的唯一方法是**让父进程调用 `wait()`**，而不是 kill 僵尸本身。

### 6.3 生产中的真实案例

**案例：Python 多进程程序产生大量僵尸进程**

```python
# 错误写法：fork 了子进程但从不 wait()
import os

def worker():
    # 子进程工作逻辑
    time.sleep(10)
    os._exit(0)

while True:
    pid = os.fork()
    if pid == 0:
        worker()
    # 错误：父进程没有调用 wait()，子进程退出后变成僵尸
    # 随着时间积累，僵尸进程数量持续增长
```

```python
# 正确写法：用 SIGCHLD 处理器或非阻塞 wait 定期收割
import os, signal

def sigchld_handler(signo, frame):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:  # 没有更多退出的子进程了
                break
        except ChildProcessError:
            break

signal.signal(signal.SIGCHLD, sigchld_handler)
```

**更好的做法：使用 Python 的 multiprocessing 模块**

`multiprocessing.Process` 已经正确处理了 `wait()` 逻辑——`p.join()` 或调用 `p.wait()` 都会在内部调用系统的 `waitpid()`，不会留下僵尸进程。

---

## 第 7 章 exit 对各类资源的影响

### 7.1 文件描述符的关闭与网络连接

当 `exit_files()` 关闭所有文件描述符时，对不同类型的 fd 有不同影响：

**TCP Socket**：关闭 fd → `struct file` 引用计数减 1 → 若归零，内核开始 TCP 四次挥手（发送 FIN 数据包），通知对端连接关闭

**重要细节**：`close(sockfd)` 不等于 TCP 连接立即关闭——如果同一个 socket 有多个 fd（通过 `dup()` 或 `fork()` 共享），必须所有 fd 都关闭，`struct file` 的引用计数才能归零，TCP 才真正发 FIN。

```bash
# 验证：进程退出时，其所有 socket 会发送 FIN
# 用 ss 命令观察连接状态
ss -tnp | grep <PID>
# 杀死进程
kill <PID>
# 再次观察，连接从 ESTABLISHED 变为 FIN_WAIT_1，然后消失
```

**打开的文件（普通文件）**：关闭 fd 不一定立即将数据写入磁盘（内核仍有 [[Page Cache]]），但会将 dirty 页面标记为可写回，内核的 pdflush/kworker 线程会在后台将其写到磁盘。

### 7.2 内存映射（mmap）的清理

`exit_mm()` 调用 `mmput()`，减少 `mm_struct` 的 `mm_users` 引用计数：
- 若 `mm_users > 0`（还有其他线程共享这个 mm，如同进程的其他线程）：不清理内存，只减少计数
- 若 `mm_users == 0`（最后一个线程退出）：调用 `exit_mmap()`，逐一取消所有 VMA 的映射，释放物理内存（对于匿名页）或解除文件映射（对于 file-backed 页）

**mmap 文件映射的 dirty 页处理**：如果进程通过 `mmap` 修改了文件（`MAP_SHARED`），进程退出时 dirty 页不会立即写回磁盘，而是由内核的写回机制（[[Page Cache]] writeback）在后台完成。若需要确保数据持久化，进程退出前应调用 `msync()` 或 `munmap()`。

---

## 小结

进程的终结是一个**多步骤的有序过程**，而非瞬间消失：

**`exit()` 的两个阶段**：
1. **用户态清理**（`exit()`）：调用 `atexit` 回调、刷新 stdio 缓冲区
2. **内核态清理**（`do_exit()`）：释放内存 → 关闭文件 → 通知父进程 → 转入僵尸状态

**僵尸进程的本质**：进程退出后，`task_struct` 刻意保留（存储退出状态），等待父进程 `wait()` 来读取并销毁。僵尸状态是 Unix 进程模型的必要组成部分，不是 bug。

**孤儿进程的收养链**：父进程退出 → 子进程成孤儿 → 内核寻找 subreaper（若有）或 init（PID=1）作为养父 → 子进程退出后由养父 `wait()` 收割

**生产中的僵尸进程消除**：
- 根本解决：修复父进程代码，正确调用 `waitpid()` 或处理 `SIGCHLD`
- 临时方案：杀死父进程（让 init 接管收割），或重启服务
- `SIGKILL` 对僵尸无效——僵尸进程已经死亡，无法处理任何信号

下一篇 [[06 进程状态机——TASK_RUNNING 到 TASK_DEAD 的完整生命周期]] 将系统梳理 Linux 内核进程状态（R/S/D/T/Z/X）的精确含义、转换条件，以及生产中最令人困惑的 D 状态（不可中断睡眠）的本质与诊断。

---

> [!note] 思考题
> 1. 管道（pipe）是最简单的 IPC 机制——匿名管道只能在父子进程间使用（通过 fork 继承 fd）。管道的缓冲区大小默认 64KB（Linux）——如果写入速度超过读取速度，writer 会阻塞。在高吞吐的生产者-消费者场景中，管道的 64KB 缓冲区是否太小？`fcntl(F_SETPIPE_SZ)` 可以调大到 1MB——有上限吗？
> 2. POSIX 共享内存（`shm_open` + `mmap`）允许多个进程映射同一块物理内存——零拷贝通信。但共享内存需要进程自己处理同步（如使用信号量或 futex）。在什么场景下共享内存是唯一合理的 IPC 选择（如大数据量、低延迟要求）？Memcached 的 `-s` 选项使用 Unix Domain Socket 而非共享内存——为什么？
> 3. System V 消息队列（`msgget/msgsnd/msgrcv`）和 POSIX 消息队列（`mq_open/mq_send/mq_receive`）都是内核维护的消息队列。它们与用户态消息队列（如 ZeroMQ、Disruptor）相比性能差距有多大？内核消息队列的优势是什么（如可靠性、持久性）？
