---
title: "线程的真相——Linux 为什么没有真正的线程"
date: 2026-03-02
tags: [Linux, 进程管理, 线程, LWP, clone, NPTL, pthread, TGID, 轻量级进程, 线程组]
aliases: ["Linux线程模型", "轻量级进程LWP", "NPTL原理", "pthread实现原理", "Linux无真正线程"]
---

**摘要：**

"Linux 没有真正的线程"——这句话让很多人困惑：我们明明在用 `pthread_create()` 创建线程，程序运行得好好的，怎么叫"没有真正的线程"？这句话的意思是：**Linux 内核从未为"线程"这个概念设计专属的数据结构或调度单元**。在内核眼中，线程和进程都是 `task_struct`，都独立参与调度，区别只在于 `clone()` 时传入的 `flags` 决定了新任务与创建者共享哪些资源。线程是"共享了地址空间、文件描述符、信号处理函数等资源的轻量级进程（LWP）"。这个设计与 Windows、Solaris 等系统中"进程是资源容器，线程是调度单元"的二元模型截然不同，有其深刻的历史渊源和工程权衡。本文从 Linux 线程模型的历史演进出发，深入剖析 `clone()` 如何通过 flags 精确控制资源共享粒度、NPTL（Native POSIX Thread Library）如何在此基础上实现 POSIX 线程语义、线程组（thread group）与 TGID 的关系，以及这个设计带来的独特行为（如线程的信号处理、`/proc` 中的线程表示）。

---

## 第 1 章 两种线程模型：内核级 vs 用户级

### 1.1 线程的本质需求

在讨论 Linux 的具体实现之前，先明确线程要解决什么问题。

**进程**是操作系统的资源分配单位——每个进程有独立的虚拟地址空间、文件描述符表、信号处理配置……这种隔离性是安全和稳定的基础，但代价是进程间通信代价高昂（需要管道、socket、共享内存等 IPC 机制），进程切换开销也大（需要切换页表、刷新 TLB）。

**线程**的诞生是为了在同一程序内实现并发，同时避免进程切换的开销：线程之间共享地址空间，可以直接通过内存变量通信，切换时不需要切换页表。

这个需求有两种实现路径：

**路径 A：用户级线程（User-Level Threads）**

线程完全在用户空间实现，内核对线程一无所知——内核只看到一个进程（一个 `task_struct`），用户空间的线程库（如早期的 LinuxThreads 或 Go runtime 的 goroutine 调度器）负责在这个进程内调度多个线程。

优点：线程切换极快（不需要系统调用，只是用户态的函数调用）。

致命缺陷：当其中一个线程执行阻塞系统调用（如 `read()`），整个进程（所有线程）都会阻塞——因为内核只看到一个进程，让这个进程睡眠意味着所有线程都睡眠了。这在 IO 密集型并发场景下是灾难性的。

**路径 B：内核级线程（Kernel-Level Threads）**

每个线程在内核中都有对应的调度单元，内核能独立调度每个线程。当一个线程阻塞在 IO，内核可以调度同进程的其他线程继续执行。

这是现代操作系统的主流方案，但实现上分为两个流派：
- **二元模型（Two-Entity Model）**：进程是资源容器，线程是调度单元，两者是不同的内核对象（Windows NT、Solaris 采用此模型）
- **统一模型（Unified Model）**：线程和进程都是同一种内核对象（`task_struct`），通过资源共享标志区分——Linux 的选择

### 1.2 Linux 的选择：统一模型的历史背景

Linux 内核从一开始就没有区分"进程"和"线程"的内核原语。Linus Torvalds 在设计 Linux 时明确说过：

> "I want to make it clear that threads are NOT a separate concept from processes in Linux. Threads are just another process that happens to share the same memory."

这个选择有其历史原因：

1. **实现简单性（KISS 原则）**：用一套代码（`task_struct` + `clone()`）覆盖所有场景，比维护两套数据结构简单得多
2. **调度公平性**：所有 `task_struct` 平等竞争 CPU，不需要复杂的两级调度
3. **灵活性**：`clone()` 的 flags 可以精确控制共享什么、隔离什么，覆盖从"完全共享（线程）"到"完全隔离（进程）"的所有中间状态——容器技术就是这个灵活性的极致利用

---

## 第 2 章 clone 的 flags：资源共享的精确控制

### 2.1 从 fork 到 thread 的连续谱

`clone()` 系统调用是 Linux 进程/线程创建的统一接口，通过 `flags` 参数控制子任务与父任务之间共享哪些资源：

```c
long clone(
    int (*fn)(void *),    /* 子任务的起始函数 */
    void *stack,          /* 子任务的栈（线程需要独立栈）*/
    int flags,            /* 资源共享控制标志 */
    void *arg,            /* 传给 fn 的参数 */
    /* ... pid_t *ptid, void *tls, pid_t *ctid */
);
```

从"完全隔离的进程"到"完全共享的线程"，是一个连续的控制谱：

| flags 配置 | 语义 | 等价操作 |
|-----------|------|---------|
| 不设任何 `CLONE_*` | 完全隔离：复制所有资源 | `fork()` |
| `CLONE_VM` | 共享虚拟地址空间 | 共享内存 |
| `CLONE_VM \| CLONE_FS` | 共享内存 + 文件系统信息 | |
| `CLONE_VM \| CLONE_FILES` | 共享内存 + 文件描述符表 | |
| `CLONE_VM \| CLONE_SIGHAND` | 共享内存 + 信号处理函数 | |
| `CLONE_VM \| CLONE_FS \| CLONE_FILES \| CLONE_SIGHAND \| CLONE_THREAD` | 完全共享（POSIX 线程）| `pthread_create()` |
| `CLONE_NEWPID \| CLONE_NEWNET \| CLONE_NEWNS \| ...` | 创建新 Namespace | 容器创建 |

**`CLONE_THREAD` 的特殊作用**：

`CLONE_THREAD` 是"成为真正线程"的关键标志——它让新任务加入父任务的**线程组**：

```c
/* copy_process() 中对 CLONE_THREAD 的处理 */
if (clone_flags & CLONE_THREAD) {
    p->tgid = current->tgid;           /* 新线程与父线程共享 TGID */
    p->group_leader = current->group_leader; /* 指向线程组主线程 */
    /* 将新线程加入线程组链表 */
    list_add_tail_rcu(&p->thread_node, &p->signal->thread_head);
} else {
    /* 不设 CLONE_THREAD：新进程，自己是新线程组的 leader */
    p->tgid = p->pid;                  /* tgid = 自己的 pid */
    p->group_leader = p;               /* 自己是线程组 leader */
}
```

### 2.2 CLONE_VM：共享地址空间的代价与价值

`CLONE_VM` 让两个 `task_struct` 的 `mm` 字段指向同一个 `mm_struct`：

```c
/* copy_mm() 处理 CLONE_VM */
static int copy_mm(unsigned long clone_flags, struct task_struct *tsk) {
    if (clone_flags & CLONE_VM) {
        /* 线程：直接共享父进程的 mm_struct，引用计数 +1 */
        atomic_inc(&oldmm->mm_users);
        tsk->mm = oldmm;
        tsk->active_mm = oldmm;
        return 0;
    }
    /* 进程：创建新 mm_struct，CoW 复制页表（fork 行为）*/
    return dup_mm(tsk, oldmm);
}
```

**共享 mm_struct 的直接结果**：
- **内存访问**：任何线程写入全局变量，其他线程立即可见（无需 IPC）
- **竞态条件**：同样因为共享，多线程访问共享数据需要同步原语（mutex、rwlock 等）
- **内存布局**：所有线程共享同一个 `mmap_base`、同一个 `brk`（堆顶）、同一套 VMA

**但每个线程有自己的栈**：

这是一个关键细节。线程虽然共享地址空间，但每个线程需要独立的栈空间（函数调用层次彼此独立）。`pthread_create()` 会调用 `mmap()` 为新线程分配一段内存作为栈，然后将这个地址传给 `clone()` 的 `stack` 参数：

```
共享的虚拟地址空间中的线程栈布局：
┌────────────────────────────────────────────────┐  高地址
│   主线程栈（main thread stack）[stack]          │  ← kernel 在 execve 时建立
├────────────────────────────────────────────────┤
│   ...                                          │
├────────────────────────────────────────────────┤
│   线程 3 的栈（mmap 匿名映射）                   │
├────────────────────────────────────────────────┤  ← guard page（禁止访问，防止栈溢出）
│   线程 2 的栈（mmap 匿名映射）                   │
├────────────────────────────────────────────────┤  ← guard page
│   线程 1 的栈（mmap 匿名映射）                   │
├────────────────────────────────────────────────┤  ← guard page
│   堆（heap）[heap]                              │
│   ...                                          │
│   共享库、代码段、数据段（所有线程共享）          │
└────────────────────────────────────────────────┘  低地址
```

每个线程栈下面有一个**guard page**（`PROT_NONE` 的内存页，不可读写不可执行）——当线程栈溢出时，访问 guard page 触发 `SIGSEGV`，程序崩溃并报错，防止栈溢出无声地覆盖其他线程的数据。

### 2.3 CLONE_FILES 与 CLONE_SIGHAND：共享的代价

**`CLONE_FILES`（共享文件描述符表）**：

所有线程共享同一个 `files_struct`——任何线程 `open()` 的文件，其他线程都能用同一个 fd 访问；任何线程 `close()` 一个 fd，其他线程的该 fd 也同时失效。

这带来一个陷阱：多线程程序中，一个线程调用 `close(fd)`，另一个线程正好在用这个 fd 做 IO，就会遇到 `EBADF` 错误。这不是 bug 而是设计——线程共享 fd 表是 POSIX 要求的线程语义，编程时必须小心协调。

**`CLONE_SIGHAND`（共享信号处理函数表）**：

所有线程共享同一个 `sighand_struct`——一个线程通过 `sigaction()` 修改某信号的处理函数，对整个进程（所有线程）立即生效。这也是 POSIX 的要求：信号处理是进程级别的设置，不是线程级别的。

但**信号掩码（signal mask）是每个线程独立的**（存储在 `task_struct.blocked`）——每个线程可以独立决定阻塞哪些信号。这是 POSIX 多线程信号处理中常被忽视的细节。

---

## 第 3 章 线程组：内核如何把一堆 task_struct "捏成一个进程"

### 3.1 TGID 与 PID 的关系

如 [[02 进程描述符 task_struct 深度拆解]] 所述，内核用两个字段区分"进程（线程组）"和"任务（单个线程）"：

```c
struct task_struct {
    pid_t pid;    /* 内核任务 ID：每个线程唯一，对应 gettid() 的返回值 */
    pid_t tgid;   /* 线程组 ID：同一进程的所有线程共享，对应 getpid() 的返回值 */
    struct task_struct *group_leader;  /* 指向线程组的主线程（TGID 等于其 PID）*/
    struct list_head thread_node;      /* 连接同一线程组所有线程的链表节点 */
    /* ... */
};
```

对一个 4 线程的进程（主线程 + 3 个工作线程），内核中的结构：

```
内核 task_struct 链表（4 个独立节点）：

task: pid=1000, tgid=1000, group_leader=自己   ← 主线程（线程组 leader）
task: pid=1001, tgid=1000, group_leader→1000  ← 工作线程 1
task: pid=1002, tgid=1000, group_leader→1000  ← 工作线程 2
task: pid=1003, tgid=1000, group_leader→1000  ← 工作线程 3

用户空间调用 getpid()  → 4 个线程都返回 1000（tgid）
用户空间调用 gettid()  → 分别返回 1000/1001/1002/1003（pid）
```

### 3.2 /proc 中的线程表示

Linux 的 `/proc` 文件系统以进程（线程组）为单位组织目录，但也暴露了线程信息：

```bash
# /proc/<tgid>/ 代表整个进程（线程组）
ls /proc/1000/

# /proc/<tgid>/task/ 目录包含进程的所有线程
ls /proc/1000/task/
# 1000/   1001/   1002/   1003/

# 每个线程子目录下有完整的 /proc/[tid]/ 内容
cat /proc/1000/task/1001/status
# Pid:   1001     ← 内核层面的线程 ID（tid）
# Tgid:  1000     ← 线程组 ID（= 进程 PID）
```

```bash
# 实战：查看多线程进程的所有线程
# 先找到目标进程（如 mysqld）
PID=$(pgrep mysqld | head -1)

echo "进程 PID: $PID"
echo "线程数量: $(ls /proc/$PID/task/ | wc -l)"
echo "各线程的 TID:"
ls /proc/$PID/task/

# 查看每个线程的状态
for tid in $(ls /proc/$PID/task/); do
    state=$(cat /proc/$PID/task/$tid/status | grep "^State" | awk '{print $2,$3}')
    wchan=$(cat /proc/$PID/task/$tid/wchan)
    echo "  TID=$tid  State=$state  wchan=$wchan"
done
```

---

## 第 4 章 NPTL：在 Linux 上实现 POSIX 线程语义

### 4.1 LinuxThreads 的历史问题

在 NPTL（Native POSIX Thread Library）出现之前，Linux 上的 POSIX 线程由 **LinuxThreads** 库实现（glibc 2.4 之前）。LinuxThreads 基于 `clone()` 实现，但由于当时内核缺少某些支持，存在严重的兼容性问题：

**问题一：getpid() 在不同线程中返回不同的值**

LinuxThreads 时代，每个线程的 `task_struct` 没有 `tgid` 字段（`CLONE_THREAD` 也还没有），每个线程有独立的 PID。所以在主线程调用 `getpid()` 得到 1000，在工作线程调用 `getpid()` 得到 1001——这违反了 POSIX 标准（POSIX 要求同一进程的所有线程 `getpid()` 返回相同的值）。

**问题二：信号处理不符合 POSIX**

POSIX 要求发给进程（PID）的信号可以被任意线程处理。但在 LinuxThreads 中，每个线程是独立的 PID，`kill(pid, sig)` 只会发给主线程，其他线程无法响应。

**问题三：需要一个"管理线程"**

LinuxThreads 需要一个额外的"管理线程"来处理线程同步原语的实现，这个额外线程消耗资源，且在 `/proc` 中可见，让系统管理员困惑。

### 4.2 NPTL 的诞生：内核与用户态的协同进化

2003 年，Red Hat 的 Ulrich Drepper 和 Ingo Molnar 为 Linux 2.6 设计了 NPTL，同步进行了两项改造：

**内核层面（Linux 2.6 新增）**：
- 引入 `CLONE_THREAD` 标志和 `tgid` 字段，让多个 `task_struct` 共享同一个 TGID
- 引入线程组信号路由（发给 TGID 的信号可路由到任一线程）
- 引入 `CLONE_SETTLS` 支持线程本地存储（TLS）
- 引入 `CLONE_PARENT_SETTID` / `CLONE_CHILD_CLEARTID`（支持 futex 实现的线程等待）

**用户态层面（NPTL 库）**：
- `pthread_create()` 使用正确的 `clone()` flags 组合
- 基于 futex 实现高效的互斥锁和条件变量
- 正确实现 POSIX 信号语义

### 4.3 NPTL 中 pthread_create 的 clone 调用

```c
/* NPTL pthread_create 内部（大幅简化）*/
int pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                   void *(*start_routine)(void *), void *arg) {

    /* 1. 为新线程分配栈空间（mmap 匿名映射）*/
    void *stack = mmap(NULL, stack_size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);

    /* 在栈顶设置 guard page（防止栈溢出覆盖其他内存）*/
    mprotect(stack, PTHREAD_STACK_MIN, PROT_NONE);

    /* 2. 准备线程本地存储（TLS）区域 */
    /* TLS 包含：pthread_t 描述符、errno 变量、locale 等线程私有数据 */
    void *tls = allocate_tls(stack);

    /* 3. 调用 clone()，设置完整的线程 flags */
    int flags = CLONE_VM        /* 共享地址空间 */
              | CLONE_FS        /* 共享文件系统信息（当前目录等）*/
              | CLONE_FILES     /* 共享文件描述符表 */
              | CLONE_SIGHAND   /* 共享信号处理函数 */
              | CLONE_THREAD    /* 加入父线程的线程组（共享 TGID）*/
              | CLONE_SYSVSEM   /* 共享 System V 信号量撤销操作 */
              | CLONE_SETTLS    /* 设置线程本地存储寄存器（fs/gs）*/
              | CLONE_PARENT_SETTID  /* 将新线程 TID 写入 ptid（pthread_t 使用）*/
              | CLONE_CHILD_CLEARTID /* 线程退出时清零 ctid（futex wait 唤醒 pthread_join）*/
              | SIGCHLD;        /* 线程退出时发 SIGCHLD 给父进程 */

    pid_t tid = clone(thread_start_fn, stack + stack_size,
                      flags, arg,
                      &thread->tid,   /* ptid：新线程 TID 写入此处 */
                      tls,            /* TLS 指针（设置到 fs 寄存器）*/
                      &thread->tid);  /* ctid：线程退出时清零，用于 pthread_join */

    *thread = (pthread_t)tls;   /* pthread_t 实际上是指向 TLS 区域的指针 */
    return 0;
}
```

### 4.4 CLONE_SETTLS：线程本地存储的底层机制

**TLS（Thread Local Storage，线程本地存储）** 是每个线程独有的数据区——即使多个线程访问同名的 TLS 变量，各自读写的是完全不同的内存位置。

典型用例：
- `errno`：每个线程有自己的 `errno`，线程 A 的系统调用失败不影响线程 B 的 `errno`
- `pthread_self()` 的返回值（线程标识符）
- 用 `__thread` 关键字声明的变量：`__thread int my_counter = 0;`

**底层实现**：

`CLONE_SETTLS` 让内核将 TLS 地址写入专用的段寄存器（x86-64 的 `fs` 寄存器 / ARM64 的 `tpidr_el0` 寄存器）。TLS 变量访问被编译器翻译为相对于这个寄存器基地址的偏移访问：

```c
/* 编译器将 __thread int errno 的访问翻译为（x86-64 伪汇编）*/
/* 读取 errno 的值 */
movq %fs:0,  %rax       /* 读取 fs 寄存器指向的 TLS 基地址 */
movl errno_offset(%rax), %eax   /* 读取 errno 在 TLS 中的偏移处的值 */

/* 每个线程的 fs 寄存器指向不同的 TLS 区域 */
/* 所以同样的指令在不同线程中读取到不同的物理内存位置 */
```

CPU 切换线程时，内核会更新 `fs` 寄存器（通过 `WRFSBASE` 指令或 `arch_prctl(ARCH_SET_FS, ...)`），使得 TLS 访问自动"重定向"到新线程的 TLS 区域。

---

## 第 5 章 线程同步原语的内核基础：futex

### 5.1 futex 是什么：从自旋锁到混合锁

NPTL 的 `pthread_mutex_lock()` 等同步原语底层依赖 **futex**（Fast Userspace muTEX）。理解 futex，是理解为什么 Linux 线程同步如此高效的关键。

**问题起点**：实现互斥锁需要"原子地检查锁是否可用，若可用则获取"。最简单的实现是**自旋锁（spinlock）**——CPU 一直忙等，不断检查锁的状态：

```c
/* 自旋锁（伪代码）*/
void spin_lock(volatile int *lock) {
    while (__sync_lock_test_and_set(lock, 1) == 1) {
        /* 锁被占用：一直循环等待（占用 CPU）*/
    }
}
```

自旋锁的问题：如果锁被持有很长时间（如等待 IO），等待者一直占用 CPU 做无用的自旋，造成 CPU 资源浪费。

**Sleeping Lock（睡眠锁）**：等待时让进程睡眠（系统调用 `futex_wait`），锁释放时由内核唤醒等待者。但每次锁操作都需要系统调用，开销约 100 纳秒——对于竞争少的情况（锁大多数时候是可用的），这个开销是不必要的。

**futex 的精妙之处**：只在真正需要等待时才进行系统调用，非竞争路径完全在用户态完成：

```c
/* futex 实现的 mutex（简化逻辑）*/

/* 锁的状态用一个 int 表示：0=未锁定，1=锁定（无等待者），2=锁定（有等待者）*/
volatile int mutex_state = 0;

void mutex_lock(volatile int *state) {
    int old;

    /* 快速路径：原子地将 0→1，若成功，说明锁未被持有，直接获取（纯用户态，无系统调用）*/
    old = __sync_val_compare_and_swap(state, 0, 1);
    if (old == 0) return;   /* 成功获取锁，直接返回 */

    /* 慢速路径：锁已被持有，需要等待 */
    /* 将状态改为 2（表示有等待者），然后进入内核睡眠 */
    do {
        if (old == 2 || __sync_val_compare_and_swap(state, 1, 2) != 0) {
            /* 进入内核：futex_wait(state, 2) */
            /* 只有当 *state == 2 时才真正睡眠（避免锁刚释放就睡眠的竞态）*/
            syscall(SYS_futex, state, FUTEX_WAIT, 2, NULL, NULL, 0);
        }
        old = __sync_val_compare_and_swap(state, 0, 2);
    } while (old != 0);
}

void mutex_unlock(volatile int *state) {
    /* 快速路径：原子地将 1→0，若之前是 1（无等待者），直接返回（纯用户态）*/
    if (__sync_fetch_and_sub(state, 1) == 1) return;

    /* 慢速路径：有等待者（state 曾经是 2）*/
    *state = 0;
    /* 进入内核唤醒一个等待者 */
    syscall(SYS_futex, state, FUTEX_WAKE, 1, NULL, NULL, 0);
}
```

**futex 的核心洞察**：在**无竞争**（最常见）的情况下，`mutex_lock()` 只需一条原子 CAS 指令，不需要任何系统调用——这使得线程同步的常规路径代价极低（约 5 纳秒）。只有在真正发生竞争时，才会进入内核睡眠等待，付出系统调用的代价（约 100 纳秒）。

### 5.2 条件变量（Condition Variable）与 futex

`pthread_cond_wait()` 同样基于 futex，其语义是"原子地释放互斥锁并等待条件变量"：

```c
/* pthread_cond_wait 的 futex 实现（伪代码）*/
int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
    /* 关键：必须原子地"释放锁 + 进入等待"，不能分两步操作 */
    /* 否则：释放锁后、进入等待前，其他线程可能已经发出通知，导致通知丢失 */

    /* futex 的 FUTEX_WAIT 语义：
       只有当 cond->futex_val 等于预期值时才真正睡眠
       这个"先检查后等待"的原子性由内核保证，正是 futex 设计的精华 */
    int val = cond->futex_val;
    mutex_unlock(mutex);                           /* 释放锁 */
    syscall(SYS_futex, &cond->futex_val,           /* 等待条件变量 */
            FUTEX_WAIT, val, timeout, NULL, 0);    /* 若 futex_val 仍为 val，睡眠 */
    mutex_lock(mutex);                             /* 重新获取锁 */
    return 0;
}

int pthread_cond_signal(pthread_cond_t *cond) {
    cond->futex_val++;  /* 改变值，让等待者知道条件可能已变化 */
    syscall(SYS_futex, &cond->futex_val,
            FUTEX_WAKE, 1, NULL, NULL, 0);   /* 唤醒 1 个等待者 */
    return 0;
}
```

---

## 第 6 章 多线程信号处理：POSIX 语义与 Linux 实现

### 6.1 POSIX 线程信号模型

POSIX 对多线程进程的信号处理规定如下：

1. **发给进程的信号**（`kill(pid, sig)`）：可以被进程中任意一个未阻塞该信号的线程处理
2. **发给特定线程的信号**（`tgkill(pid, tid, sig)`）：必须由指定线程处理
3. **信号处理函数**：进程级共享（所有线程共享同一份信号处理配置）
4. **信号掩码**：线程级独立（每个线程可以屏蔽不同的信号）

**关键推论**：如果你希望只有特定线程处理 `SIGUSR1`，其他线程都屏蔽它：

```c
/* 主线程：屏蔽 SIGUSR1，防止主线程意外处理 */
sigset_t mask;
sigemptyset(&mask);
sigaddset(&mask, SIGUSR1);
pthread_sigmask(SIG_BLOCK, &mask, NULL);

/* 创建工作线程时，子线程会继承父线程的信号掩码 */
/* 因此新创建的线程也会继承屏蔽 SIGUSR1 的掩码 */

/* 专门的信号处理线程：解除 SIGUSR1 的屏蔽，等待信号 */
void *signal_handler_thread(void *arg) {
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGUSR1);
    pthread_sigmask(SIG_UNBLOCK, &mask, NULL);  /* 解除屏蔽 */

    int signum;
    while (sigwait(&mask, &signum) == 0) {      /* 等待并处理信号 */
        /* 处理 SIGUSR1 */
    }
    return NULL;
}
```

这是多线程程序中处理信号的推荐模式：**用一个专门的线程来处理信号，其他线程全部屏蔽该信号**，避免信号在随机线程中触发导致的竞态问题。

### 6.2 Linux 的信号路由机制

当 `kill(tgid, sig)` 发给整个线程组时，内核如何选择哪个线程来处理？

```c
/* kernel/signal.c：发给线程组的信号路由（简化）*/
static int __send_signal_locked(int sig, ..., struct task_struct *t) {
    /* 将信号添加到线程组的共享信号队列 */
    q = __sigqueue_alloc(...);
    list_add_tail(&q->list, &t->signal->shared_pending.list);

    /* 通知线程组：选择一个合适的线程来处理这个信号 */
    complete_signal(sig, t, group);
}

static void complete_signal(int sig, struct task_struct *p, enum pid_type type) {
    struct signal_struct *signal = p->signal;
    struct task_struct *t;

    /* 优先选择当前正在运行的线程（减少唤醒开销）*/
    /* 如果当前线程阻塞了该信号，遍历线程组找一个未阻塞的线程 */
    t = signal->curr_target;   /* 上次被路由到的线程（轮询策略）*/
    while (!wants_signal(sig, t)) {
        t = next_thread(t);    /* 换下一个线程 */
        if (t == signal->curr_target)
            return;   /* 所有线程都屏蔽了该信号，信号暂时挂起 */
    }
    signal->curr_target = t;

    /* 唤醒选中的线程（若在睡眠），使其从系统调用返回并处理信号 */
    signal_wake_up(t, sig == SIGKILL);
}
```

---

## 第 7 章 Linux 线程模型的独特行为

### 7.1 线程退出：exit vs pthread_exit

**`exit()`（整个进程退出）**：
- 调用 `do_group_exit()`，向线程组所有线程发送退出信号
- 所有线程依次调用 `do_exit()`，最终整个进程消亡

**`pthread_exit()`（单个线程退出）**：
- 只调用 `do_exit()`，终止当前这一个线程
- 如果是非最后一个线程，其他线程继续运行
- 如果是最后一个线程，整个进程退出

**当主线程调用 `pthread_exit()` 时**：
主线程退出，但只要还有其他线程在运行，进程就不会退出。主线程的 `task_struct` 变为僵尸状态，但整个进程（其他线程）继续运行。这是一个常见的混淆点。

### 7.2 线程与 /proc 的关系

```bash
# ps 的不同选项对线程的显示不同
ps aux          # 默认显示进程（TGID），不显示线程
ps -eLf         # 显示所有线程（-L 标志）
# LWP 列：Light Weight Process ID（= 内核层面的 tid = task_struct.pid）

# top 的线程视图
top -H          # -H 选项：显示所有线程而非进程
# top 中按 H 键：切换进程/线程视图

# 用 ps 验证线程与进程的关系
ps -eLf | awk '{print $2,$3,$4}' | head  # PID LWP PPID
# 同一进程的所有线程：PID 相同（TGID），LWP 不同（内核 tid），PPID 相同
```

---

## 小结

Linux 的线程模型体现了"统一、简洁、灵活"的设计哲学：

**核心结论**：
- Linux 内核没有专门的"线程"对象，线程和进程都是 `task_struct`，通过 `clone()` 的 `flags` 控制资源共享粒度
- `pthread_create()` 本质是携带 `CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD` 等标志的 `clone()` 调用
- `CLONE_THREAD` 让新任务加入父任务的线程组（共享 TGID），这是 `getpid()` 在所有线程中返回相同值的内核基础
- 每个线程有独立的栈（`mmap` 分配）、独立的信号掩码（`task_struct.blocked`）、独立的 TLS（`fs` 寄存器）

**NPTL 的贡献**：内核（Linux 2.6）提供 `tgid` + `CLONE_THREAD` + futex 原语，NPTL 在此基础上实现符合 POSIX 标准的 `pthread` 接口，彻底解决了 LinuxThreads 时代的兼容性问题。

**性能关键**：futex 让线程同步在**无竞争路径**上完全在用户态完成，避免系统调用，是 Linux 线程同步高性能的核心秘密。

下一篇 [[08 CFS 完全公平调度器——从 O(1) 到红黑树的演进]] 将深入调度器的核心：CFS 如何用"虚拟运行时间"实现公平调度、红黑树为什么是理想的数据结构、time slice 如何动态计算，以及 nice 值与权重的精确映射关系。

---

> [!note] 思考题
> 1. Linux 提供了 8 种命名空间：PID、Mount、Network、UTS、IPC、User、Cgroup、Time。每种命名空间隔离了一类系统资源。Docker 容器默认使用哪些命名空间？User Namespace 是最后加入的——它允许容器内 root 映射为宿主机的非特权用户。这对容器安全性有什么影响？为什么 Docker 默认不启用 User Namespace？
> 2. Network Namespace 为每个容器创建独立的网络栈——包括独立的接口、路由表、iptables 规则。容器之间通过 veth pair + bridge 通信。在 Pod 内多个容器共享同一个 Network Namespace——这意味着它们通过 localhost 通信。Kubernetes 的 pause 容器唯一的作用是'持有'这个 Network Namespace——如果 pause 容器被杀死会发生什么？
> 3. PID Namespace 中，容器内的 PID 1 进程是容器的 init。如果 PID 1 退出，整个 PID Namespace 中的所有进程都会被杀死（收到 SIGKILL）。这就是为什么容器的入口进程非常重要。如果你在容器中运行一个 shell 脚本作为 PID 1，shell 不会转发信号给子进程——`docker stop` 会等待超时后 SIGKILL。如何正确处理这个问题？
