# 第7章 理解Linux线程（1）

相对于Unix操作系统40多年的光辉历史，线程算是出现得比较晚的。在20世纪90年代线程才慢慢流行起来，而POSIX threads标准的确立已经是1995年的事情了。

Unix原本是不支持线程的，线程概念的引入给Unix家族带来了一些麻烦，很多函数都不是线程安全（thread-safe）的，需要重新定义，信号机制在线程加入以后也变得更加复杂了。

在单核CPU时代，多线程的需求并没有那么强烈，但是随着时间的流逝，事情发生了变化。2005年3月，Herb Sutter在*Dobb’s Journal*上发表了《The Free Lunch is over：A Fundamental Turn Toward Concurrency in Software》一文，文章分析处理器厂商改善CPU性能的传统方法，如提升时钟速度和指令吞吐量，基本已经走到了尽头，处理器开始向超线程和多核架构靠拢，多核的时代已然来临。为了让代码运行得更快，单纯地依赖更快的硬件已经无法满足要求。程序员需要编写并发代码，以便充分发挥多核处理器的强大功能，并且使程序的性能得到提升。

## 7.1 线程与进程

在Linux下，程序或可执行文件是一个静态的实体，它只是一组指令的集合，没有执行的含义。进程是一个动态的实体，有自己的生命周期。线程是操作系统进程调度器可以调度的最小执行单元。进程和线程的关系如图7-1所示。

```mermaid
graph LR
    subgraph Process
        A[进程地址空间]
        B[线程1]
        C[线程2]
        D[线程3]
        B --- A
        C --- A
        D --- A
    end
    style A fill:#e0e0e0,stroke:#333,stroke-width:2px
    style B fill:#a8c8f0,stroke:#333
    style C fill:#a8c8f0,stroke:#333
    style D fill:#a8c8f0,stroke:#333
```

**图7-1 线程和进程的关系**

一个进程可能包含多个线程，传统意义上的进程，不过是多线程的一种特例，即该进程只包含一个线程。

### 为什么要有多线程？

举个生活中的例子，这就好比去银行办理业务。到达银行后，首先找到取号的机器领取一个号码，然后坐下来安心等待。这时候你一定希望，办理业务的窗口越多越好。如果把整个营业大厅当成一个进程的话，那么每一个窗口就是一个工作线程。

这种场景在Linux中屡见不鲜。编程的思想（如图7-2所示）和生活中解决问题的想法总是类似的。

```mermaid
graph TD
    M[Master 线程] -->|分配任务| W1[Worker 线程1]
    M --> W2[Worker 线程2]
    M --> W3[Worker 线程3]
    M --> Wn[Worker 线程n]
    style M fill:#f9d7a0,stroke:#333
    style W1 fill:#b8d4c0,stroke:#333
    style W2 fill:#b8d4c0,stroke:#333
    style W3 fill:#b8d4c0,stroke:#333
    style Wn fill:#b8d4c0,stroke:#333
```

**图7-2 Master-Worker并发模型**

有人说不必非要使用线程，多个进程也能做到这点。的确如此。Unix/Linux原本的设计是没有线程的，类Unix系统包括Linux从设计上更倾向于使用进程，反倒是Windows因为创建进程的开销巨大，而更加钟爱线程。

那么线程是不是一种设计上的冗余呢？其实不是这样的。

进程之间，彼此的地址空间是独立的，但线程会共享内存地址空间（如图7-3所示）。同一个进程的多个线程共享一份全局内存区域，包括初始化数据段、未初始化数据段和动态分配的堆内存段。

```mermaid
graph LR
    subgraph Process
        A[进程地址空间]
        B[堆]
        C[未初始化数据段 .bss]
        D[初始化数据段 .data]
        E[线程1 栈]
        F[线程2 栈]
        G[线程3 栈]
        A --- B
        A --- C
        A --- D
        A --- E
        A --- F
        A --- G
    end
    style A fill:#e0e0e0,stroke:#333
    style B fill:#f9c9a0,stroke:#333
    style C fill:#a0c9f9,stroke:#333
    style D fill:#a0f9c9,stroke:#333
    style E fill:#c9a0f9,stroke:#333
    style F fill:#c9a0f9,stroke:#333
    style G fill:#c9a0f9,stroke:#333
```

**图7-3 线程之间共享资源**

这种共享给线程带来了很多的优势：

- 创建线程花费的时间要少于创建进程花费的时间。
- 终止线程花费的时间要少于终止进程花费的时间。
- 线程之间上下文切换的开销，要小于进程之间的上下文切换。
- 线程之间数据的共享比进程之间的共享要简单。

下面用一个简单的实验，来比较下创建10万个进程和10万个线程各自的开销。

创建进程的测试程序将会执行如下操作：

1. 调用`fork`函数创建子进程，子进程无实际操作，调用`exit`函数立刻退出，父进程等待子进程退出。
2. 重复执行步骤1，共执行10万次。

创建线程的测试程序则执行如下操作：

1. 调用`pthread_create`创建线程，线程无实际操作；调用`pthread_exit`函数，立刻退出；主线程调用`pthread_join`函数等待线程退出。
2. 重复执行步骤1，共执行10万次。

服务器CPU的情况为：Intel 2.1GHz Xeon E5-2620（24核），下面看下测试结果，见表7-1。

**表7-1 创建线程或子进程之前无内存分配，程序耗时比较**

| 操作               | 创建10万个实体耗时 |
|--------------------|-------------------|
| 创建进程（fork）   | 约X秒（原始未提供具体数字，通常远大于线程） |
| 创建线程（pthread）| 约Y秒（约为进程的1/5）      |

> [!NOTE]
> 原书中此表包含具体数值，此处因原文（OCR）未提取具体数值，仅保留比较关系。实际测试结果显示创建线程耗时约为创建进程的五分之一。

在上述测试中，调用`fork`函数和`pthread_create`函数之前，并没有分配大块内存。一旦分配大块内存，考虑到创建进程需要拷贝页表，而创建线程不需要，则两者之间效率上的差距会进一步拉大，见表7-2。

**表7-2 创建线程或子进程之前，堆上分配了40MB空间**

| 操作               | 创建10万个实体耗时 |
|--------------------|-------------------|
| 创建进程（fork）   | 更长时间          |
| 创建线程（pthread）| 相对更短          |

线程间的上下文切换，指的是同一个进程里不同线程之间发生的上下文切换。由于线程原本属于同一个进程，它们会共享地址空间，大量资源共享，切换的代价小于进程之间的切换是自然而然的事情。

线程之间通信的代价低于进程之间通信的代价。从生活的角度来类比，部门内的协作总是要比跨部门的协作来得顺溜。线程共享地址空间的设计，让多个线程之间的通信变得非常简单。一个进程内的多个线程，就像一个软件研发小组内部的不同员工，共享代码、服务器、打印机、资料，彼此之间有分工协作，沟通协作成本比较低。进程之间的通信代价则要高很多。进程之间不得不采用一些进程间通信的手段（如管道、共享内存及信号量等）来协作。

前面是从操作系统的角度来分析线程优势的，从用户或应用的视角来分析，多线程的程序也有很多的优势。

### 1. 发挥多核优势，充分利用CPU资源

CPU是一种资源，如果一方面CPU资源大量闲置，处于IDLE的状态，另一方面很多任务得不到及时的处理，处于排队等待的状态，这就表明资源没有得到有效的利用，本质上是一种浪费。

可以想象如下场景：你在火车站买票，10个售票窗口，有9个窗口的售票员暂停服务，但是这9个售票员却在嗑瓜子，玩手机，大厅里排队者有几百人。

你排在最后！！！

你是不是很愤怒。是的，编程领域也一样，如果存在多个相同的任务，彼此之间并行不悖，互不依赖（或者依赖性很小），那么启动多个线程并发处理，是一个不错的选择（如图7-4所示）。虽然对每个任务而言，处理的时间并没有缩短，但是在相同时间内，处理了更多的任务。

```mermaid
graph LR
    A[CPU内核1] --> B[线程1 任务]
    C[CPU内核2] --> D[线程2 任务]
    E[CPU内核3] --> F[线程3 任务]
    G[CPU内核N] --> H[线程N 任务]
    style A fill:#d0f0c0,stroke:#333
    style C fill:#d0f0c0,stroke:#333
    style E fill:#d0f0c0,stroke:#333
    style G fill:#d0f0c0,stroke:#333
```

**图7-4 并发执行，充分利用CPU资源**

### 2. 更自然的编程模型

有很多程序，天生就适合用多线程。将工作切分成多个模块，并为每个模块分配一个或多个执行单元，更符合人类解决问题的思路。

以文本编辑程序为例，用户的输入需要及时响应，必须要有线程来监控鼠标和键盘；如果用户删除了第一页的某一行，后面很多页的格式都会受到影响，这时就需要有文本格式化线程在后台执行格式处理；很多文本编辑软件都有自动保存的功能，第三个线程会周期性地将文件内容写入磁盘；很多文本编辑软件都有检测拼写错误的功能，或许我们需要第四个线程……

上述的分工是很自然的事情，想象一下如果将所有工作都放在一个单线程的进程里面，那么该进程是不是就不得不处理庞杂而又繁芜的事情？程序结构也就会变得异常复杂。

### 多线程的弊端

没有银弹。多线程带来优势的同时，也存在一些弊端。

**1）多线程的进程，因地址空间的共享让该进程变得更加脆弱**

多个线程之中，只要有一个线程不够健壮存在bug（如访问了非法地址引发的段错误），就会导致进程内的所有线程一起完蛋。正所谓：

> 覆巢之下，安有完卵  
> 城门失火，殃及池鱼

相比之下，进程的地址空间互相独立，彼此隔离得更加彻底。多个进程之间互相协同，一个进程存在bug导致异常退出，不会影响到其他进程。

**2）线程模型作为一种并发的编程模型，效率并没有想象的那么高，会出现复杂度高、易出错、难以测试和定位的问题**

目前存在的并发编程，基本可以分成两类：
- 共享状态式
- 消息传递式

线程模型采用的是第一种。从现在开始，停止幻想，欢迎来到真实的世界。

> 一个程序员碰到了一个问题，他决定用多线程来解决。现在两个他问题了有 [1]。
>
> ——关于线程的冷笑话

在真实的场景中，多线程编程是很复杂的。前面所说的多个任务并行不悖，互不依赖，在大多数情况下只是一种美好的幻想。

首先，多个线程之间，存在负载均衡的问题，现实中很难将全部任务等分给每个线程。想象一下，如果存在10个线程，一个线程承担了90%的任务，9个线程承担了10%的任务，整体的效率立刻就降了下来。

有人说，怎么会有这么愚蠢的设计呢。试想如下场景：你需要用支持10个并发线程的服务器去计算1~10¹⁰ 以内的所有素数，要怎么设计？首先进入脑海的第一反应是不是将1~10¹⁰ 这个范围平均分成10份，每一份有10⁹ 个数，10个线程分别查找范围内的素数？这就是糟糕的设计，尽管每个线程负责的范围是相同的，但是每个线程的负载并不均匀，因为判断一个较大的数是不是素数，通常要比判断较小的数所花费的时间更长。当然这个例子有比较妥善的解决方案，但是在很多情况下，很难将负载均匀地分配给各个线程。

其次，多个线程的任务之间还可能存在顺序依赖的关系，一个线程未能完成某些操作之前，其他线程不能或不应该运行。

多个线程之间需要同步。想象如下场景：你和你的朋友合租一套公寓，这套公寓只有1个卫生间。当你朋友正在使用卫生间的时候，你就无法使用了。多线程也会遇到类似的问题。多个线程生活在进程地址空间这同一个屋檐下，若存在多个线程操作共享资源，则需要同步，否则可能会出现结果错误、数据结构遭到破坏甚至是程序崩溃等后果。因此多线程编程中存在临界区的概念，临界区的代码只允许一个线程执行，线程提供了锁机制来保护临界区。当其他线程来到临界区却无法申请到锁时，就可能陷入阻塞，不再处于可执行状态，线程可能不得不让出CPU资源。

如果设计不合理，临界区非常多，线程之间的竞争异常激烈，频繁地上下文切换也会导致性能急剧恶化。

上面两种情况的存在，决定了多线程并非总是处于并发的状态，加速也并非线性的。4个工作线程未必能带来4倍的效率，加速比取决于可以串行执行的部分在全部工作中所占的比例。

有人曾经这样打比方：多进程属于立体交通系统，虽然造价高，上坡下坡比较耗油，但是堵车少；多线程属于平面交通系统，造价低，但是红绿灯太多，老堵车。个人觉得这个比方是很有道理的。

多线程模型的复杂度更是不容小觑。很多人诟病多线程模型，就在于它不符合人的心智模型。俗语道，一心不可两用，人很难同时控制多条走走停停，彼此又有交互和同步的控制流。由于进程调度的无序性，严格来说多线程程序的每次执行其实并不一样，很难穷举所有的时序组合，所以我们永远无法宣称多线程的程序经过了充分的测试。在某些特殊时序的条件下，bug可能会出现，这种bug难以复现，而且难以排查。所以编程时，需要谨慎地设计，以确保程序能够在所有的时序条件下正常运行。

对于多线程编程，还存在四大陷阱，一不小心就可能落入陷阱之中。这四个陷阱分别是：
- **死锁（Dead Lock）**
- **饿死（Starvation）**
- **活锁（Live Lock）**
- **竞态条件（Race Condition）**

> [!WARNING]
> 多线程编程的难度要更大一些，需要程序员更加小心，更加谨慎。当你需要使用多线程的时候，一定要花费足够的时间小心地规划每个线程的分工，尽可能地减少线程之间的依赖。良好的设计，合理的分工是多线程编程至关重要的环节。若初期随意地设计线程的分工，那么在最后，你很有可能不得不花费大量的时间来优化性能，定位bug，甚至不得不推倒重来。

[1] 此处的语序混乱是故意的，暗讽由于线程、多条控制流、时序失去控制，导致混乱。

## 7.2 进程ID和线程ID

在Linux中，目前的线程实现是Native POSIX Thread Library，简称NPTL。在这种实现下，线程又被称为轻量级进程（Light Weighted Process），每一个用户态的线程，在内核之中都对应一个调度实体，也拥有自己的进程描述符（`task_struct`结构体）。

没有线程之前，一个进程对应内核里的一个进程描述符，对应一个进程ID。但是引入了线程的概念之后，情况就生了变化，一个用户进程下管辖N个用户态线程，每个线程作为一个独立的调度实体在内核态都有自己的进程描述符，进程和内核的进程描述符一下子就变成了1∶N的关系，POSIX标准又要求进程内的所有线程调用`getpid`函数时返回相同的进程ID。如何解决上述问题呢？

内核引入了线程组（Thread Group）的概念。

```c
struct task_struct {
    ...
    pid_t pid;
    pid_t tgid
    ...
    struct task_struct *group_leader;
    ...
    struct list_head thread_group;
    ...
}
```

多线程的进程，又被称为线程组，线程组内的每一个线程在内核之中都存在一个进程描述符（`task_struct`）与之对应。进程描述符结构体中的`pid`，表面上看对应的是进程ID，其实不然，它对应的是线程ID；进程描述符中的`tgid`，含义是Thread Group ID，该值对应的是用户层面的进程ID，具体见表7-3。

**表7-3　线程ID和进程ID的值**

| 变量名称       | 用户层面含义       | 内核层面变量 |
|--------------|-------------------|-------------|
| `pid`        | 线程ID            | `task_struct->pid` |
| `tgid`       | 进程ID            | `task_struct->tgid` |

本节介绍的线程ID，不同于后面会讲到的`pthread_t`类型的线程ID，和进程ID一样，线程ID是`pid_t`类型的变量，而且是用来唯一标识线程的一个整型变量。那么如何查看一个线程的ID呢？

```bash
manu@manu-hacks:~$ ps -eLf
...
UID        PID  PPID   LWP  C NLWP STIME TTY          TIME CMD
syslog     837     1   837  0    4 22:20 ?        00:00:00 rsyslogd
syslog     837     1   838  0    4 22:20 ?        00:00:00 rsyslogd
syslog     837     1   839  0    4 22:20 ?        00:00:00 rsyslogd
syslog     837     1   840  0    4 22:20 ?        00:00:00 rsyslogd
...
```

`ps`命令中的`-L`选项，会显示出线程的如下信息。
- **LWP**：线程ID，即`gettid()`系统调用的返回值。
- **NLWP**：线程组内线程的个数。

所以从上面可以看出`rsyslogd`进程是多线程的，进程ID为837，进程内有4个线程，线程ID分别为837、838、839和840（如图7-5所示）。

```mermaid
graph TD
    subgraph Thread Group (pid=837)
        T1[线程 ID=837<br>主线程/Group Leader]
        T2[线程 ID=838]
        T3[线程 ID=839]
        T4[线程 ID=840]
    end
    style T1 fill:#f9d7a0,stroke:#333
    style T2 fill:#a8c8f0,stroke:#333
    style T3 fill:#a8c8f0,stroke:#333
    style T4 fill:#a8c8f0,stroke:#333
```

**图7-5　进程ID和线程ID（调度域）**

已知某进程的进程ID，该如何查看该进程内线程的个数及其线程ID呢？其实可以通过`/proc/PID/task/`目录下的子目录来查看，如下。因为procfs在task下会给进程的每个线程建立一个子目录，目录名为线程ID。

```bash
manu@manu-hacks:~$ ll /proc/837/task/
总用量 0
dr-xr-xr-x 6 syslog syslog 0  4月 16 22:32 ./
dr-xr-xr-x 9 syslog syslog 0  4月 16 22:20 ../
dr-xr-xr-x 6 syslog syslog 0  4月 16 22:32 837/
dr-xr-xr-x 6 syslog syslog 0  4月 16 22:32 838/
dr-xr-xr-x 6 syslog syslog 0  4月 16 22:32 839/
dr-xr-xr-x 6 syslog syslog 0  4月 16 22:32 840/
```

对于线程，Linux提供了`gettid`系统调用来返回其线程ID，可惜的是glibc并没有将该系统调用封装起来，再开放出接口来供程序员使用。如果确实需要获取线程ID，可以采用如下方法：

```c
#include <sys/syscall.h>
int TID = syscall(SYS_gettid);
```

从上面的示例来看，`rsyslogd`是个多线程的进程，进程ID为837，下面有一个线程的ID也是837，这不是巧合。线程组内的第一个线程，在用户态被称为主线程（main thread），在内核中被称为Group Leader。内核在创建第一个线程时，会将线程组ID的值设置成第一个线程的线程ID，`group_leader`指针则指向自身，即主线程的进程描述符，如下。

```c
/* 线程组ID等于主线程的ID,group_leader指向自身 */
p->tgid = p->pid;
p->group_leader = p;
INIT_LIST_HEAD(&p->thread_group);
```

所以可以看到，线程组内存在一个线程ID等于进程ID，而该线程即为线程组的主线程。

至于线程组其他线程的ID则由内核负责分配，其线程组ID总是和主线程的线程组ID一致，无论是主线程直接创建的线程，还是创建出来的线程再次创建的线程，都是这样。

```c
if (clone_flags & CLONE_THREAD)
    p->tgid = current->tgid;
if (clone_flags & CLONE_THREAD) {
    p->group_leader = current->group_leader;
    list_add_tail_rcu(&p->thread_group, &p->group_leader->thread_group);
}
```

通过`group_leader`指针，每个线程都能找到主线程。主线程存在一个链表头，后面创建的每一个线程都会链入到该双向链表中。

利用上述的结构，每个线程都可以轻松地找到其线程组的主线程（通过`group_leader`指针），另一方面，通过线程组的主线程，也可以轻松地遍历其所有的组内线程（通过链表）。

需要强调的一点是，**线程和进程不一样，进程有父进程的概念，但在线程组里面，所有的线程都是对等的关系**（如图7-6所示）。

- 并不是只有主线程才能创建线程，被创建出来的线程同样可以创建线程。
- 不存在类似于`fork`函数那样的父子关系，大家都归属于同一个线程组，进程ID都相等，`group_leader`都指向主线程，而且各有各的线程ID。
- 并非只有主线程才能调用`pthread_join`连接其他线程，同一线程组内的任意线程都可以对某线程执行`pthread_join`函数。
- 并非只有主线程才能调用`pthread_detach`函数，其实任意线程都可以对同一线程组内的线程执行分离操作。

```mermaid
graph TD
    subgraph Thread Group (tgid = 1000)
        M[主线程<br>TID=1000]
        T1[线程 TID=1001]
        T2[线程 TID=1002]
        T3[线程 TID=1003]
    end
    M --> T1
    M --> T2
    M --> T3
    T1 --> T4[线程 TID=1004]   "被创建出来的线程也可以创建线程"
    style M fill:#f9d7a0,stroke:#333
    style T1 fill:#a8c8f0,stroke:#333
    style T2 fill:#a8c8f0,stroke:#333
    style T3 fill:#a8c8f0,stroke:#333
    style T4 fill:#c8a8f0,stroke:#333
```

**图7-6　线程的对等关系**

## 7.3 pthread库接口介绍

1995年，POSIX.1c标准对POSIX线程API进行了标准化，这就是我们今天看到的pthread库的接口。

这些接口包括线程的创建、退出、取消和分离，以及连接已经终止的线程，互斥量，读写锁，线程的条件等待等（如表7-4所示）。

**表7-4　POSIX线程库的接口**

| 函数原型                                                                 | 功能描述                     |
|--------------------------------------------------------------------------|------------------------------|
| `pthread_create`                                                         | 创建线程                     |
| `pthread_exit`                                                           | 退出线程                     |
| `pthread_cancel`                                                         | 取消线程                     |
| `pthread_join`                                                           | 连接已终止的线程             |
| `pthread_detach`                                                         | 分离线程                     |
| `pthread_mutex_init / pthread_mutex_destroy`                             | 互斥量初始化/销毁            |
| `pthread_mutex_lock / pthread_mutex_unlock`                              | 互斥量加锁/解锁              |
| `pthread_rwlock_init / pthread_rwlock_destroy`                           | 读写锁初始化/销毁            |
| `pthread_rwlock_rdlock / pthread_rwlock_wrlock / pthread_rwlock_unlock`  | 读写锁操作                   |
| `pthread_cond_init / pthread_cond_destroy / pthread_cond_wait / pthread_cond_signal` | 条件变量操作 |

上面提到的函数列表，是pthread的基本接口，接下来的章节，将分别介绍这些接口。

## 7.4 线程的创建和标识

首先要介绍的接口是创建线程的接口，即`pthread_create`函数。程序开始启动的时候，产生的进程只有一个线程，我们称之为主线程或初始线程。对于单线程的进程而言，只存在主线程一个线程。如果想在主线程之外，再创建一个或多个线程，就需要用到这个接口了。

### 7.4.1 pthread_create函数

pthread库提供了如下接口来创建线程：

```c
#include <pthread.h>

int pthread_create(pthread_t *restrict thread,
                   const pthread_attr_t *restrict attr,
                   void *(*start_routine)(void*),
                   void *restrict arg);
```

`pthread_create`函数的第一个参数是`pthread_t`类型的指针，线程创建成功的话，会将分配的线程ID填入该指针指向的地址。线程的后续操作将使用该值作为线程的唯一标识。

第二个参数是`pthread_attr_t`类型，通过该参数可以定制线程的属性，比如可以指定新建线程栈的大小、调度策略等。如果创建线程无特殊的要求，该值也可以是NULL，表示采用默认属性。

第三个参数是线程需要执行的函数。创建线程，是为了让线程执行一定的任务。线程创建成功之后，该线程就会执行`start_routine`函数，该函数之于线程，就如同`main`函数之于主线程。

第四个参数是新建线程执行的`start_routine`函数的入参。新建线程如果想要正常工作，则可能需要入参，那么主线程在调用`pthread_create`的时候，就可以将入参的指针放入第四个参数以传递给新建线程。

如果线程的执行函数`start_routine`需要很多入参，传递一个指针就能提供足够的信息吗？答案是能。线程创建者（一般是主线程）和线程约定一个结构体，创建者便把信息填入该结构体，再将结构体的指针传递给子进程，子进程只要解析该结构体，就能取出需要的信息。

如果成功，则`pthread_create`返回0；如果不成功，则`pthread_create`返回一个非0的错误码。常见的错误码如表7-5所示。

**表7-5　pthread_create的错误码及描述**

| 错误码         | 描述                                           |
|---------------|------------------------------------------------|
| `EAGAIN`      | 系统资源不足，无法创建线程，或创建的线程数超过了限制 |
| `EINVAL`      | 参数`attr`无效                                  |
| `EPERM`       | 没有权限设置指定的调度策略或参数                 |

`pthread_create`函数的返回情况有些特殊，通常情况下，函数调用失败，则返回-1，并且设置`errno`。`pthread_create`函数则不同，它会将`errno`作为返回值，而不是一个负值。

```c
void *thread_worker(void *)
{
    printf("I am thread worker\n");
    pthread_exit(NULL);
}

pthread_t tid;
int ret = 0;
ret = pthread_create(&tid, NULL, &thread_worker, NULL);
if (ret != 0) /* 注意此处,不能用 ret < 0 作为出错判断 */
{
    /* ret is the errno */
    /* error handler */
}
```


## 7.4.2 线程ID及进程地址空间布局

`pthread_create`函数，会产生一个线程ID，存放在第一个参数指向的地址中。该线程ID和7.2节分析的线程ID是一回事吗？  
答案是否定的。

7.2节提到的线程ID，属于进程调度的范畴。因为线程是轻量级进程，是操作系统调度器的最小单位，所以需要一个数值来唯一标识该线程。

`pthread_create`函数产生并记录在第一个参数指向地址的线程ID中，属于NPTL线程库的范畴，线程库的后续操作，就是根据该线程ID来操作线程的。

线程库NPTL提供了`pthread_self`函数，可以获取到线程自身的ID：

```c
#include <pthread.h>
pthread_t pthread_self(void);
```

在同一个线程组内，线程库提供了接口，可以判断两个线程ID是否对应着同一个线程：

```c
#include <pthread.h>
int pthread_equal(pthread_t t1, pthread_t t2);
```

返回值是0的时候，表示两个线程是同一个线程，非零值则表示不是同一个线程。

`pthread_t`到底是个什么样的数据结构呢？因为POSIX标准并没有限制`pthread_t`的数据类型，所以该类型取决于具体实现。对于Linux目前使用的NPTL实现而言，`pthread_t`类型的线程ID，本质就是一个进程地址空间上的一个地址。

是时候看一下进程地址空间的布局了。在x86_64平台上，用户地址空间约为128TB，对于地址空间的布局，系统有如下控制选项：

```bash
cat /proc/sys/vm/legacy_va_layout
0
```

该选项影响地址空间的布局，主要是影响mmap区域的基地址位置，以及mmap是向上还是向下增长。如果该值为1，那么mmap的基地址`mmap_base`变小（约在128T的三分之一处），mmap区域从低地址向高地址扩展。如果该值为0，那么mmap区域的基地址在栈的下面（约在128T空间处），mmap区域从高地址向低地址扩展。默认值为0，布局如图7-7所示。

> **图7-7　多线程进程的地址空间** — 图示展示了一个多线程进程的地址空间分布，包括代码段、已初始化数据段、未初始化数据段、堆、内存映射区域（mmap区域，包含线程栈）、以及主线程的栈（位于高位地址约128TB附近）。

可以通过`procfs`或`pmap`命令来查看进程的地址空间的情况：

```bash
pmap PID
```

或者

```bash
cat /proc/PID/maps
```

在接近128TB的巨大地址空间里面，代码段、已初始化数据段、未初始化数据段，以及主线程的栈，所占用的空间非常小，都是KB、MB这个数量级的，如下：

```
manu@manu-hacks:~$ pmap 3706
3706:   ./process_map
0000000000400000      4K r-x-- process_map
0000000000601000      4K r---- process_map
0000000000602000      4K rw--- process_map...
00007ffdd5f68000   5128K rw---   [ stack ]  /*栈在
128T位置附近
*/
```

由于主线程的栈大小并不是固定的，要在运行时才能确定大小（上限大概在8MB左右），因此，在栈中不能存在巨大的局部变量，另外编写递归函数时一定要小心，递归不能太深，否则很可能耗尽栈空间。

如下面的例子所示，无尽地递归，很轻易就耗尽了栈的空间：

```c
int i = 0;
void func()
{
    int buffer[256];
    printf("i = %d\n",i);
    i++;
    func();
}
int main()
{
    func();
    sleep(100);
}
```

上面代码的递归永不停息，每次递归，都会消耗约1KB（256个int型为1KB）的栈空间。通过运行可以看出，主线程栈最大也就在8MB左右：

```
i = 8053
i = 8054
i = 8055段错误
 (核心已转储)
```

进程地址空间之中，最大的两块地址空间是内存映射区域和堆。堆的起始地址特别低，向上扩展，mmap区域的起始地址特别高，向下扩展。

用户调用`pthread_create`函数时，glibc首先要为线程分配线程栈，而线程栈的位置就落在mmap区域。glibc会调用`mmap`函数为线程分配栈空间。`pthread_create`函数分配的`pthread_t`类型的线程ID，不过是分配出来的空间里的一个地址，更确切地说是一个结构体的指针，如图7-8所示。

> **图7-8　线程ID的本质是内存地址** — 图示说明：`pthread_t`类型的线程ID实际上指向一个在mmap区域分配的线程控制块（`struct pthread`）结构体。该结构体包含线程状态、栈地址、连接信息等。

创建两个线程，将其`pthread_self()`的返回值打印出来，输出如下：

```
address of tid in thread-1 = 0x7f011ca12700
address of tid in thread-2 = 0x7f011c211700
```

线程ID是进程地址空间内的一个地址，要在同一个线程组内进行线程之间的比较才有意义。不同线程组内的两个线程，哪怕两者的`pthread_t`值是一样的，也不是同一个线程，这是显而易见的。

很有意思的一点是，`pthread_t`类型的线程ID很有可能会被复用。在满足下列条件时，线程ID就有可能会被复用：  
1）线程退出。  
2）线程组的其他线程对该线程执行了`pthread_join`，或者线程退出前将分离状态设置为已分离。  
3）再次调用`pthread_create`创建线程。

为什么`pthread_t`类型的线程ID会被复用，这点将在后面进行分析。下面通过测试来证明一下：

```c
/*省略了 error handler*/
void* thread_work(void* param)
{
    int TID = syscall(SYS_gettid);
    printf("thread-%d: gettid return %d\n",TID,TID);
    printf("thread-%d: pthread_self return %p\n",TID,(void *)pthread_self());
    printf("thread-%d: I will exit now\n",TID);
    pthread_exit(NULL);
    return NULL;
}
int main(int argc ,char* argv[])
{
    pthread_t tid = 0;
     int ret
    ret  = pthread_create(&tid,NULL,thread_work,NULL);
    ret  = pthread_join(tid,NULL);
    ret  = pthread_create(&tid,NULL,thread_work,NULL);
    ret  = pthread_join(tid,NULL);
    return 0;
}
```

输出结果如下：

```
thread-4158: gettid return 4158
thread-4158: pthread_self return 0x7f43a27d0700
thread-4158: I will exit now
thread-4159: gettid return 4159
thread-4159: pthread_self return 0x7f43a27d0700
thread-4159: I will exit now
```

从输出结果上看，对于`pthread_t`类型的线程ID，虽然在同一时刻不会存在两个线程的ID值相同，但是如果线程退出了，重新创建的线程很可能复用了同一个`pthread_t`类型的ID。从这个角度看，如果要设计调试日志，用`pthread_t`类型的线程ID来标识进程就不太合适了。用`pid_t`类型的线程ID则是一个比较不错的选择。

```c
#include <sys/syscall.h>
int TID = syscall(SYS_gettid);
```

采用`pid_t`类型的线程ID来唯一标识进程有以下优势：  
· 返回类型是`pid_t`类型，进程之间不会存在重复的线程ID，而且不同线程之间也不会重复，在任意时刻都是全局唯一的值。  
· `procfs`中记录了线程的相关信息，可以方便地查看`/proc/pid/task/tid`来获取线程对应的信息。  
· `ps`命令提供了查看线程信息的`-L`选项，可以通过输出中的LWP和NLWP，来查看同一个线程组的线程个数及线程ID的信息。

另外一个比较有意思的功能是我们可以给线程起一个有意义的名字，命名以后，既可以从`procfs`中获取到线程的名字，也可以从`ps`命令中得到线程的名字，这样就可以更好地辨识不同的线程。

Linux提供了`prctl`系统调用：

```c
#include <sys/prctl.h>
int  prctl(int  option,  unsigned  long arg2,
           unsigned long arg3 , unsigned long arg4,
           unsigned long arg5)
```

这个系统调用和`ioctl`非常类似，通过`option`来控制系统调用的行为。当需要给线程设定名字的时候，只需要将`option`设为`PR_SET_NAME`，同时将线程的名字作为`arg2`传递给`prctl`系统调用即可，这样就能给线程命名了。

下面是示例代码：

```c
void thread_setnamev(const char* namefmt, va_list args)
{
    char name[17];
    vsnprintf(name, sizeof(name), namefmt, args);
    prctl(PR_SET_NAME, name, NULL, NULL, NULL);
}
void thread_setname(const char* namefmt, ...)
{
    va_list args;
    va_start(args, namefmt);
    thread_setnamev(namefmt, args);
    va_end(args);
}
```

调用示例：

```c
thread_setname("BEAN-%d",num);
```

这里共创建了四个线程，按照调用`pthread_create`的顺序，将0、1、2、3作为参数传递给线程，然后调用`prctl`给每个线程起名字：分别为`BEAN-0`、`BEAN-1`、`BEAN-2`和`BEAN-3`。命名以后可以通过`ps`命令来查看线程的名字：

```
manu@manu-hacks:~$ ps -L -p 3454
  PID   LWP TTY          TIME CMD
 3454  3454 pts/0    00:00:00 pthread_tid
 3454  3455 pts/0    00:00:00 BEAN-0
 3454  3456 pts/0    00:00:00 BEAN-1
 3454  3457 pts/0    00:00:00 BEAN-2
 3454  3458 pts/0    00:00:00 BEAN-3
```

```
manu@manu-hacks:~$ cat /proc/3454/task/3457/status
Name:    BEAN-2
State:    S (sleeping)
Tgid:    3454
```

这是一个很有用的技巧。给线程命了名，就可以很直观地区分各个线程，尤其是在线程比较多，且其分工不同的情况下。

## 7.4.3 线程创建的默认属性

线程创建的第二个参数是`pthread_attr_t`类型的指针，`pthread_attr_init`函数会将线程的属性重置成默认值。

```c
pthread_attr_t    attr;
pthread_attr_init(&attr);
```

在创建线程时，传递重置过的属性，或者传递`NULL`，都可以创建一个具有默认属性的线程，见表7-6。

**表7-6　线程的属性及默认值**

| 属性 | 描述 | 默认值 |
|------|------|--------|
| `detachstate` | 线程的分离状态 | `PTHREAD_CREATE_JOINABLE` |
| `schedpolicy` | 调度策略 | `SCHED_OTHER` |
| `schedparam` | 调度参数 | 继承自调用线程的调度参数 |
| `inheritsched` | 调度继承属性 | `PTHREAD_EXPLICIT_SCHED` |
| `scope` | 竞争范围 | `PTHREAD_SCOPE_SYSTEM` |
| `guardsize` | 栈末尾的保护区域大小（字节） | 系统默认，通常为一页 |
| `stackaddr` | 线程栈的基地址 | `NULL`（由系统分配） |
| `stacksize` | 线程栈的大小 | 通常为8MB |

手册给出了一个如何展示线程属性的例子，若你需要展示线程的属性，则可以参考手册。

本节现在来介绍线程栈的基地址和大小。默认情况下，线程栈的大小为8MB：

```
manu@manu-hacks:~$ ulimit -s
8192
```

调用`pthread_attr_getstack`函数可以返回线程栈的基地址和栈的大小。出于可移植性的考虑不建议指定线程栈的基地址。但是有时候会有修改线程栈的大小的需要。

一个线程需要分配8MB左右的栈空间，就决定了不可能无限地创建线程，在进程地址空间受限的32位系统里尤为如此。在32位系统下，3GB的用户地址空间决定了能创建线程的个数不会太多。如果确实需要很多的线程，可以调用接口来调整线程栈的大小：

```c
#include <pthread.h>
int pthread_attr_setstacksize(pthread_attr_t *attr,
                              size_t stacksize);
int pthread_attr_getstacksize(pthread_attr_t *attr,size_t *stacksize);
```

## 7.5 线程的退出

有生就有灭，线程执行完任务，也需要终止。

下面的三种方法中，线程会终止，但是进程不会终止（如果线程不是进程组里的最后一个线程的话）：  
· 创建线程时的`start_routine`函数执行了`return`，并且返回指定值。  
· 线程调用`pthread_exit`。  
· 其他线程调用了`pthread_cancel`函数取消了该线程（详见第8章）。

如果线程组中的任何一个线程调用了`exit`函数，或者主线程在`main`函数中执行了`return`语句，那么整个线程组内的所有线程都会终止。

值得注意的是，`pthread_exit`和线程启动函数（`start_routine`）执行`return`是有区别的。在`start_routine`中调用的任何层级的函数执行`pthread_exit()`都会引发线程退出，而`return`，只能是在`start_routine`函数内执行才能导致线程退出。

```c
void* start_routine(void* param)
{
    ...
    foo();
    bar();
    return NULL;
}
void foo()
{
    ...
    pthread_exit(NULL);
}
```

如果`foo`函数执行了`pthread_exit`函数，则线程会立刻退出，后面的`bar`就会没有机会执行了。

下面来看看`pthread_exit`函数的定义：

```c
#include <pthread.h>
void pthread_exit(void *value_ptr);
```

`value_ptr`是一个指针，存放线程的“临终遗言”。线程组内的其他线程可以通过调用`pthread_join`函数接收这个地址，从而获取到退出线程的临终遗言。如果线程退出时没有什么遗言，则可以直接传递`NULL`指针，如下所示：

```c
pthread_exit(NULL);
```

但是这里有一个问题，就是**不能将遗言存放到线程的局部变量里**，因为如果用户写的线程函数退出了，线程函数栈上的局部变量可能就不复存在了，线程的临终遗言也就无法被接收者读到，示例如下。

```c
void* thread_work(void* param)
{
    int ret = -1;
    ret = whatever();
    pthread_exit(&ret);
}
```

上述用法是一种典型的错误用法，因为当线程退出时，线程栈已经不复存在了，上面的`ret`变量也已经无法访问了。那我们应该如何正确地传递返回值呢？  
· 如果是int型的变量，则可以使用`pthread_exit((int*)ret);`。  
· 使用全局变量返回。  
· 将返回值填入到用`malloc`在堆上分配的空间里。  
· 使用字符串常量，如`pthread_exit("hello，world")`。

第一种是`tricky`的做法，我们将返回值`ret`进行强制类型转换，接收方再把返回值强制转换成`int`。但是不推荐使用这种方法。这种方法虽然是奏效的，但是太`tricky`，而且C标准没有承诺将`int`型转成指针后，再从指针转成`int`型时，数据一直保持不变。

第二种方法使用全局变量，其他线程调用`p传递线程的返回值，除了`pthread_exit`函数可以做到，线程的启动函数（`start_routine`函数）`return`也可以做到，两者的数据类型要保持一致，都是`void*`类型。这也解释了为什么线程的启动函数`start_routine`的返回值总是`void*`类型，如下：

```c
void pthread_exit(void *retval);
void * start_routine(void *param);
```

线程退出有一种比较有意思的场景，即线程组的其他线程仍在执行的情况下，主线程却调用`pthread_exit`函数退出了。这会发生什么事情？

首先要说明的是这不是常规的做法，但是如果真的这样做了，那么主线程将进入僵尸状态，而其他线程则不受影响，会继续执行，如下。第4章曾经分析过这种场景。

```
root@newtest-1:~# ps -eL |grep thread_id
 62404  62404 pts/1    00:00:00 thread_id <defunct>
 62404  62405 pts/1    00:00:00 thread_id
 62404  62406 pts/1    00:00:00 thread_id
```

## 7.6　线程的连接与分离

### 7.6.1　线程的连接

7.5节提到过线程退出时是可以有返回值的，那么如何取到线程退出时的返回值呢？

线程库提供了`pthread_join`函数，用来等待某线程的退出并接收它的返回值。这种操作被称为**连接（joining）**。

相关函数的接口定义如下：

```c
#include <pthread.h>
int pthread_join(pthread_t thread, void **retval);
```

该函数第一个参数为要等待的线程的线程ID，第二个参数用来接收返回值。

根据等待的线程是否退出，可得到如下两种情况：
- 等待的线程尚未退出，那么`pthread_join`的调用线程就会陷入阻塞。
- 等待的线程已经退出，那么`pthread_join`函数会将线程的退出值（`void*`类型）存放到`retval`指针指向的位置。

线程的连接（join）操作有点类似于进程等待子进程退出的等待（wait）操作，但细细想来，还是有不同之处：

第一点不同之处是进程之间的等待只能是父进程等待子进程，而线程则不然。线程组内的成员是对等的关系，只要是在一个线程组内，就可以对另外一个线程执行连接（join）操作。如图7-9所示，线程F一样可以连接线程A。

> **图7-9　线程的连接无等级关系** — 图示：线程组内各个线程通过箭头表示连接关系，例如线程F连接线程A，线程C连接线程B，线程A连接线程D等。说明线程之间没有父子等级，任意线程都可以连接另一个线程（只要不是自身）。

第二点不同之处是进程可以等待任一子进程的退出（用下面的代码不难做到），但是线程的连接操作没有类似的接口，即不能连接线程组内的任一线程，必须明确指明要连接的线程的线程ID。

```c
wait(&status);
waitpid(-1, &status, options);
```

`pthread_join`不能连接线程组内任意线程的做法，并不是NPTL线程库设计上的瑕疵，而是有意为之的。如果听任线程连接线程组内的任意线程，那么所谓的任意线程就会包括其他库函数私自创建的线程，当库函数尝试连接（join）私自创建的线程时，发现已经被连接过了，就会返回`EINVAL`错误。如果库函数需要根据返回值来确定接下来的流程，这就会引发严重的问题。正确的做法是，连接已知线程ID的那些线程，就像`pthread_join`函数那样。

下面来分析出错的情况，当调用失败时，和`pthread_create`函数一样，`errno`作为返回值返回。错误码的情况见表7-7。

**表7-7　`pthread_join`的错误码和说明**

| 错误码 | 说明 |
|--------|------|
| `EDEADLK` | 检测到死锁：线程A连接线程A自身，或者线程A和线程B互相连接 |
| `EINVAL` | 目标线程已经被其他线程连接过了，或者目标线程已被设置为分离状态 |
| `ESRCH` | 找不到指定线程ID对应的线程（线程已经退出且未被连接，或者线程ID无效） |

`pthread_join`函数之所以能够判断是否死锁和连接操作是否被其他线程捷足先登，是因为目标线程的控制结构体`struct pthread`中，存在如下成员变量，记录了该线程的连接者。

```c
struct pthread *joinid;
```

该指针存在三种可能，如下：
- `NULL`：线程是可连接的，但是尚没有其他线程调用`pthread_join`来连接它。
- 指向线程自身的`struct pthread`：表示该线程属于自我了断型，执行过分离操作，或者创建线程时，设置的分离属性为`PTHREAD_CREATE_DETACHED`，一旦退出，则自动释放所有资源，无需其他线程来连接。
- 指向线程组内其他线程的`struct pthread`：表示`joinid`对应的线程会负责连接。

因为有了该成员变量来记录线程的连接者，所以可以判断如下场景，如图7-10所示。

> **图7-10　可能返回`EDEADLK`的场景** — 图示展示了两种死锁场景：  
> 场景一：线程A连接线程A自身（自连接），导致死锁。  
> 场景二：线程A连接线程B，同时线程B连接线程A（循环等待），导致死锁。

不过两者还是略有区别的，第一种场景，线程A连接线程A，`pthread_join`函数一定会返回`EDEADLK`。但是第二种场景，大部分情况下会返回`EDEADLK`，不过也有例外。不管怎样，**不建议两个线程互相连接**。

如果两个线程几乎同时对处于可连接状态的线程执行连接操作会怎么样？

答案是只有一个线程能够成功，另一个则返回`EINVAL`。

NPTL提供了原子性的保证：

```c
atomic_compare_and_exchange_bool_acq(&pd->joinid, self, NULL)
```

- 如果是`NULL`，则设置成调用线程的线程ID，CAS操作（Compare And Swap）是原子操作，不可分割，决定了只有一个线程能成功。
- 如果`joinid`不是`NULL`，表示该线程已经被别的线程连接了，或者正处于已分离的状态，在这两种情况下，都会返回`EINVAL`。

---

以上内容对应原书第7章第7.4.2节末尾至7.6.1节。继续后续章节？


## 7.6.2 为什么要连接退出的线程

不连接已经退出的线程会怎么样？

如果不连接已经退出的线程，会导致资源无法释放。所谓资源指的又是什么呢？

下面通过一个测试来让事实说话。测试模拟下面两种情况：

- 主线程并不执行连接操作，待确定创建的第一个线程退出后，再创建第二个线程。
- 主线程执行连接操作，等到第一个线程退出后，再创建第二个线程。

按照时间线来发展，如图7-11所示。

> **图7-11**：本节代码的流程示意图（流程图：主线程创建线程1，然后sleep或join，等待线程1退出后创建线程2）。

下面是代码部分，为了简化程序和便于理解，使用 `sleep` 操作来确保创建的第一个线程退出后，再来创建第二个线程。须知 `sleep` 并不是同步原语，在真正的项目代码中，用 `sleep` 函数来同步线程是不可原谅的。

```c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <string.h>
#include <errno.h>
#include <sys/syscall.h>
#include <sys/types.h>

#define NR_THREAD 1
#define ERRBUF_LEN 4096

void* thread_work(void* param)
{
    int TID = syscall(SYS_gettid);
    printf("thread-%d IN \n",TID);
    printf("thread-%d pthread_self return %p \n",TID,(void*)pthread_self());
    sleep(60);
    printf("thread-%d EXIT \n",TID);
    return NULL;
}

int main(int argc ,char* argv[])
{
    pthread_t tid[NR_THREAD];
    pthread_t tid_2[NR_THREAD];
    char errbuf[ERRBUF_LEN];
    int i, ret;

    for(i = 0 ; i < NR_THREAD ; i++)
    {
        ret = pthread_create(&tid[i],NULL,thread_work,NULL);
        if(ret != 0)
        {
            fprintf(stderr,"create thread failed ,return %d (%s)\n",
                    ret,strerror_r(ret,errbuf,sizeof(errbuf)));
        }
    }

#ifdef NO_JOIN
    sleep(100); /* sleep是为了确保线程退出之后,再来重新创建线程 */
#else
    printf("join thread Begin\n");
    for(i = 0 ; i < NR_THREAD; i++)
    {
        pthread_join(tid[i],NULL);
    }
#endif

    for(i = 0 ; i < NR_THREAD ; i++)
    {
        ret = pthread_create(&tid_2[i],NULL,thread_work,NULL);
        if(ret != 0)
        {
            fprintf(stderr,"create thread failed ,return %d (%s)\n",
                    ret,strerror_r(ret,errbuf,sizeof(errbuf)));
        }
    }

    sleep(1000);
    exit(0);
}
```

根据编译选项 `NO_JOIN`，将程序编译成以下两种情况：

- 编译加上 `-DNO_JOIN`：主线不执行 `pthread_join`，主线程通过 `sleep` 足够的时间，来确保第一个线程退出以后，再创建第二个线程。
- 不加 `NO_JOIN` 编译选项：主线程负责连接线程，第一个线程退出以后，再来创建第二个线程。

下面按照编译选项，分别编出 `pthread_no_join` 和 `pthread_has_join` 两个程序：

```bash
gcc -o pthread_no_join pthread_join_cmp.c -DNO_JOIN –lpthread
gcc -o pthread_has_join pthread_join_cmp.c            -lpthread
```

首先说说 `pthread_no_join` 的情况，当创建了第一个线程时：

```
manu@manu-hacks:~/code/me/thread$ ./pthread_no_join
thread-12876 IN
thread-12876 pthread_self return 0x7fe0c842b700
```

从输出可以看到，创建了第一个线程，其线程ID为12876，通过 `pmap` 和 `procfs` 可以看到系统为该线程分配了8MB的地址空间：

```
manu@manu-hacks:~$ pmap 12875
00007fe0c7c2b000      4K -----   [ anon ]
00007fe0c7c2c000   8192K rw---   [ anon ]
manu@manu-hacks:~$ cat /proc/12875/maps
7fe0c7c2b000-7fe0c7c2c000 ---p 00000000 00:00 0
7fe0c7c2c000-7fe0c842c000 rw-p 00000000 00:00 0                    [stack:12876]
```

当线程12876退出，创建新的线程时：

```
thread-12876 EXIT
thread-13391 IN
thread-13391 pthread_self return 0x7fe0c7c2a700
```

此时查看进程的地址空间：

```
00007fe0c742a000      4K -----   [ anon ]
00007fe0c742b000   8192K rw---   [ anon ]
00007fe0c7c2b000      4K -----   [ anon ]
00007fe0c7c2c000   8192K rw---   [ anon ]
7fe0c742a000-7fe0c742b000 ---p 00000000 00:00 0
7fe0c742b000-7fe0c7c2b000 rw-p 00000000 00:00 0                     [stack:13391]
7fe0c7c2b000-7fe0c7c2c000 ---p 00000000 00:00 0
7fe0c7c2c000-7fe0c842c000 rw-p 00000000 00:00 0
```

从上面的输出可以看出两点：

1. 已经退出的线程，其空间没有被释放，仍然在进程的地址空间之内。
2. 新创建的线程，没有复用刚才退出的线程的地址空间。

如果仅仅是情况1的话，尚可以理解，但是1和2同时发生，既不释放，也不复用，这就不能忍了，因为这已经属于内存泄漏了。

试想如下场景：FTP Server 采用 thread per connection 的模型，每接受一个连接就创建一个线程为之服务，服务结束后，连接断开，线程退出。但线程退出了，线程栈消耗的空间仍不能释放，不能复用，久而久之，内存耗尽，再也不能创建线程，也无法再提供FTP服务。

之所以不能复用，原因就在于没有对退出的线程执行连接操作。下面来看一下主线程调用 `pthread_join` 的情况：

```
manu@manu-hacks:~/code/me/thread$ ./pthread_has_join
join thread Begin
thread-14581 IN
thread-14581 pthread_self return 0x7f726020f700
thread-14581 EXIT
thread-14871 IN
thread-14871 pthread_self return 0x7f726020f700
thread-14871 EXIT
```

两次创建的线程，`pthread_t` 类型的线程ID完全相同，看起来好像前面退出的栈空间被复用了，事实也的确如此：

```
manu@manu-hacks:~$ cat /proc/14580/maps
7f725fa0f000-7f725fa10000 ---p 00000000 00:00 0
7f725fa10000-7f7260210000 rw-p 00000000 00:00 0                     [stack:14581]
```

12581退出后，线程栈被后创建的线程复用了：

```
manu@manu-hacks:~$ cat /proc/14580/maps
7f725fa0f000-7f725fa10000 ---p 00000000 00:00 0
7f725fa10000-7f7260210000 rw-p 00000000 00:00 0                     [stack:14871]
```

通过前面的比较，可以看出执行连接操作的重要性：如果不执行连接操作，线程的资源就不能被释放，也不能被复用，这就造成了资源的泄漏。

当线程组内的其他线程调用 `pthread_join` 连接退出线程时，内部会调用 `__free_tcb` 函数，该函数会负责释放退出线程的资源。

值得一提的是，纵然调用了 `pthread_join`，也并没有立即调用 `munmap` 来释放掉退出线程的栈，它们是被后建的线程复用了，这是 NPTL 线程库的设计。释放线程资源的时候，NPTL 认为进程可能再次创建线程，而频繁地 `munmap` 和 `mmap` 会影响性能，所以 NPTL 将该栈缓存起来，放到一个链表之中，如果有新的创建线程的请求，NPTL 会首先在栈缓存链表中寻找空间合适的栈，有的话，直接将该栈分配给新创建的线程。

## 7.6.3 线程的分离

默认情况下，新创建的线程处于可连接（Joinable）的状态，可连接状态的线程退出后，需要对其执行连接操作，否则线程资源无法释放，从而造成资源泄漏。

如果其他线程并不关心线程的返回值，那么连接操作就会变成一种负担：你不需要它，但是你不去执行连接操作又会造成资源泄漏。这时候你需要的东西只是：线程退出时，系统自动将线程相关的资源释放掉，无须等待连接。

NPTL 提供了 `pthread_detach` 函数来将线程设置成已分离（detached）的状态，如果线程处于已分离的状态，那么线程退出时，系统将负责回收线程的资源，如下：

```c
#include <pthread.h>
int pthread_detach(pthread_t thread);
```

可以是线程组内其他线程对目标线程进行分离，也可以是线程自己执行 `pthread_detach` 函数，将自身设置成已分离的状态，如下：

```c
pthread_detach(pthread_self())
```

线程的状态之中，可连接状态和已分离状态是冲突的，一个线程不能既是可连接的，又是已分离的。因此，如果线程处于已分离的状态，其他线程尝试连接线程时，会返回 `EINVAL` 错误。

`pthread_detach` 出错的情况见表7-8所示。

**表7-8：`pthread_detach` 的错误码和说明**

| 错误码 | 说明 |
|--------|------|
| `EINVAL` | `thread` 不是一个可连接的线程 |
| `ESRCH`  | 没有找到 `thread` 对应的线程 |

> [!WARNING]
> 不要误解已分离状态的内涵。所谓已分离，并不是指线程失去控制，不归线程组管理，而是指线程退出后，系统会自动释放线程资源。若线程组内的任意线程执行了 `exit` 函数，即使是已分离的线程，也仍然会受到影响，一并退出。

将线程设置成已分离状态，并非只有 `pthread_detach` 一种方法。另一种方法是在创建线程时，将线程的属性设定为已分离：

```c
#include <pthread.h>
int pthread_attr_setdetachstate(pthread_attr_t *attr,int detachstate);
int pthread_attr_getdetachstate(pthread_attr_t *attr,int *detachstate);
```

其中 `detachstate` 的可能值如表7-9所示。

**表7-9：分离状态的合法值**

| `detachstate` 常量 | 含义 |
|-------------------|------|
| `PTHREAD_CREATE_JOINABLE` | 创建可连接的线程（默认） |
| `PTHREAD_CREATE_DETACHED` | 创建已分离的线程 |

有了这个，如果确实不关心线程的返回值，可以在创建线程之初，就指定其分离属性为 `PTHREAD_CREATE_DETACHED`。

## 7.7 互斥量

### 7.7.1 为什么需要互斥量

大部分情况下，线程使用的数据都是局部变量，变量的地址在线程栈空间内，这种情况下，变量归属于单个线程，其他线程无法获取到这种变量。

如果所有的变量都是如此，将会省去无数的麻烦。但实际的情况是，很多变量都是多个线程共享的，这样的变量称为共享变量（shared variable）。可以通过数据的共享，完成多个线程之间的交互。

但是多个线程并发地操作共享变量，会带来一些问题。

下面来看一个例子，如图7-12所示。

> **图7-12**：多线程操作全局变量（示意图：4个线程同时对全局变量 `global_cnt` 执行自加操作，无同步机制）。

如果存在4个线程，不加任何同步措施，共同操作一个全局变量 `global_cnt`，假设每个线程执行1000万次自加操作，那么会发生什么事情呢？4个线程结束的时候，`global_cnt` 等于几？

这个问题看起来是小学题目，当然是4000万，但实际结果又如何呢？

```c
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <string.h>
#include <errno.h>
#include <sys/types.h>

#define LOOP_TIMES 10000000
#define NR_THREAD  4

pthread_rwlock_t rwlock;
int global_cnt = 0;

void* thread_work(void* param)
{
    int i;
    pthread_rwlock_rdlock(&rwlock);
    for(i = 0 ; i < LOOP_TIMES; i++ )
    {
        global_cnt++;
    }
    pthread_rwlock_unlock(&rwlock);
    return NULL;
}

int main(int argc ,char* argv[])
{
    pthread_t tid[NR_THREAD];
    char err_buf[1024];
    int i, ret;

    ret = pthread_rwlock_init(&rwlock,NULL);
    if(ret)
    {
        fprintf(stderr,"init rw lock failed (%s)\n",strerror_r(ret,err_buf, sizeof(err_buf)));
        exit(1);
    }

    pthread_rwlock_wrlock(&rwlock);
    for(i = 0 ; i < NR_THREAD ; i++)
    {
        ret = pthread_create(&tid[i],NULL,thread_work,NULL);
        if(ret != 0)
        {
            fprintf(stderr,"create thread failed ,return %d (%s)\n",
                    ret,strerror_r(ret,err_buf,sizeof(err_buf)));
        }
    }
    pthread_rwlock_unlock(&rwlock);

    for(i = 0 ; i < NR_THREAD; i++)
    {
        pthread_join(tid[i],NULL);
    }

    pthread_rwlock_destroy(&rwlock);
    printf("thread num       : %d\n",NR_THREAD);
    printf("loops per thread : %d\n",LOOP_TIMES);
    printf("expect result    : %d\n",LOOP_TIMES*NR_THREAD);
    printf("actual result    : %d\n",global_cnt);

    exit(0);
}
```

上面的代码中，引入了读写锁，来确保线程位于同一起跑线，同时开始执行自加操作，不受线程创建先后顺序的影响。创建4个线程之前，主线程先占住读写锁的写锁，任一线程创建好了之后，要先申请读锁，申请成功方能执行 `global_cnt++`，但是写锁已经被主线程占据，所以无法执行。待4个线程都创建成功后，主线程会释放写锁，从而保证4个线程一起执行。

执行结果又如何呢？来看看：

```
thread num       : 4
loops per thread : 10000000
expect result    : 40000000
actual result    : 11115156
```

结果并不是期待的4000万，而是11115156，一个很奇怪的数字。而且每次执行，最后的结果都不相同。

为什么无法获得正确的结果？

看一下汇编代码，先通过如下指令读取到汇编代码：

```bash
objdump -d pthread_no_sync > pthread_no_sync.objdump
```

然后在汇编代码中取出 `global_cnt++` 这部分代码相关的汇编代码，就是如下指令：

```
40098c:    8b 05 1a 07 20 00    mov   0x20071a(%rip),%eax   # 6010ac <global_cnt>
400992:    83 c0 01             add   $0x1,%eax
400995:    89 05 11 07 20 00    mov   %eax,0x200711(%rip)   # 6010ac <global_cnt>
```

`++`操作，并不是一个原子操作（atomic operation），而是对应了如下三条汇编指令：

- **Load**：将共享变量 `global_cnt` 从内存加载进寄存器，简称 **L**。
- **Update**：更新寄存器里面的 `global_cnt` 值，执行加1操作，简称 **U**。
- **Store**：将新的值，从寄存器写回到共享变量 `global_cnt` 的内存地址，简称 **S**。

将上述情况用伪代码表示，就是如下情况：

```
L操作:register = global_cnt
U操作:register = register + 1
S操作:global_cnt = register
```

以两个线程为例，如果两个线程的执行如图7-13所示，就会引发结果不一致：执行了两次 `++` 操作，最终的结果却只加了1。

> **图7-13**：多线程操作全局变量结果出错的原因（时序)：

> **图7-13**：多线程操作全局变量结果出错的原因（时序图：线程A和线程B几乎同时读取global_cnt=0，各自加1后得到1，然后分别写入，最终global_cnt=1，而不是2）。

上面的例子表明，应该避免多个线程同时操作共享变量，对于共享变量的访问，包括读取和写入，都必须被限制为每次只有一个线程来执行。

用更详细的语言来描述下，解决方案需要能够做到以下三点：

1. 代码必须要有互斥的行为：当一个线程正在临界区中执行时，不允许其他线程进入该临界区中。
2. 如果多个线程同时要求执行临界区的代码，并且当前临界区并没有线程在执行，那么只能允许一个线程进入该临界区。
3. 如果线程不在临界区中执行，那么该线程不能阻止其他线程进入临界区。

上面说了这么多，本质其实就是一句话，我们需要一把锁（如图7-14所示）。

> **图7-14**：用锁来保护临界区（示意图：锁将临界区包围，一次只允许一个线程进入）。

锁是一个很普遍的需求，当然用户可以自行实现锁来保护临界区。但是实现一个正确并且高效的锁非常困难。纵然抛下高效不谈，让用户从零开始实现一个正确的锁也并不容易。正是因为这种需求具有普遍性，所以Linux提供了互斥量。

### 7.7.2 互斥量的接口

#### 1. 互斥量的初始化

互斥量采用的是英文 mutual exclusive（互相排斥之意）的缩写，即 mutex。

正确地使用互斥量来保护共享数据，首先要定义和初始化互斥量。POSIX提供了两种初始化互斥量的方法。

第一种方法是将 `PTHREAD_MUTEX_INITIALIZER` 赋值给定义的互斥量，如下：

```c
#include <pthread.h>
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
```

如果互斥量是动态分配的，或者需要设定互斥量的属性，那么上面静态初始化的方法就不适用了，NPTL提供了另外的函数 `pthread_mutex_init()` 对互斥量进行动态的初始化：

```c
int pthread_mutex_init(pthread_mutex_t *restrict mutex,
                  const pthread_mutexattr_t *restrict attr);
```

第二个 `pthread_mutexattr_t` 指针的入参，是用来设定互斥量的属性的。大部分情况下，并不需要设置互斥量的属性，传递 `NULL` 即可，表示使用互斥量的默认属性。

调用 `pthread_mutex_init()` 之后，互斥量处于没有加锁的状态。

#### 2. 互斥量的销毁

在确定不再需要互斥量的时候，就要销毁它。在销毁之前，有三点需要注意：

- 使用 `PTHREAD_MUTEX_INITIALIZER` 初始化的互斥量无须销毁。
- 不要销毁一个已加锁的互斥量，或者是真正配合条件变量使用的互斥量。
- 已经销毁的互斥量，要确保后面不会有线程再尝试加锁。

销毁互斥量的接口如下：

```c
int pthread_mutex_destroy(pthread_mutex_t *mutex);
```

当互斥量处于已加锁的状态，或者正在和条件变量配合使用，调用 `pthread_mutex_destroy` 函数会返回 `EBUSY` 错误码。

#### 3. 互斥量的加锁和解锁

POSIX提供了如下接口：

```c
int pthread_mutex_lock(pthread_mutex_t *mutex);
int pthread_mutex_trylock(pthread_mutex_t *mutex);
int pthread_mutex_unlock(pthread_mutex_t *mutex);
```

在调用 `pthread_mutex_lock()` 的时候，可能会遭遇以下几种情况：

- 互斥量处于未锁定的状态，该函数会将互斥量锁定，同时返回成功。
- 发起函数调用时，其他线程已锁定互斥量，或者存在其他线程同时申请互斥量，但没有竞争到互斥量，那么 `pthread_mutex_lock()` 调用会陷入阻塞，等待互斥量解锁。

在等待的过程中，如果互斥量持有线程解锁互斥量，可能会发生如下事件：

- 函数调用线程是唯一等待者，获得互斥量，成功返回。
- 函数调用线程不是唯一等待者，但成功获得互斥量，返回。
- 函数调用线程不是唯一等待者，没能获得互斥量，继续阻塞，等待下一轮。

如果在调用 `pthread_mutex_lock()` 线程时，之前已经调用过 `pthread_mutex_lock()` 且已经持有了互斥量，则根据互斥锁的类型，存在以下三种可能：

- `PTHREAD_MUTEX_NORMAL`：这是默认类型的互斥锁，这种情况下会发生死锁，调用线程永久阻塞，线程组的其他线程也无法申请到该互斥量。
- `PTHREAD_MUTEX_ERRORCHECK`：第二次调用 `pthread_mutex_lock` 函数时返回 `EDEADLK`。
- `PTHREAD_MUTEX_RECURSIVE`：这种类型的互斥锁内部维护有引用计数，允许锁的持有者再次调用加锁操作。

有了互斥量，重新运行7.7.1节的程序，将 `global_cnt++` 改写成：

```c
pthread_mutex_lock(&mutex);
global_cnt++;
pthread_mutex_unlock(&mutex);
```

使用互斥量之后，程序获取了正确的执行结果：

```
thread num       : 4
loops per thread : 10000000
expect result    : 40000000
actual result    : 40000000
```

### 7.7.3 临界区的大小

现在，我们已经意识到需要用锁来保护共享变量。不过还有另一个需要注意的事项，即合理地设定临界区的范围。

第一临界区的范围不能太小，如果太小，可能起不到保护的目的。考虑如下场景，如果哈希表中不存在某元素，那么向哈希表中插入某元素，代码如下：

```c
if(!htable_contain(hashtable,elem.key))
{
    pthread_mutex_lock(&mutex);
    htable_insert(hashtable,&elem);
    pthread_mutex_unlock(&mutex);
}
```

表面上看，共享变量 hashtable 得到了保护，在插入时有锁保护，但是结果却不是我们想要的。上面的程序不希望哈希表中有重复的元素，但是其临界区太小，多线程条件下可能达不到预设的效果。

如果时序如图7-15所示，那么就会有重复的元素被插入哈希表中，没有达到最初的目的。究其原因，就是临界区小了，没有将判断部分加入临界区以内。

临界区也不能太大，临界区的代码不能并发，如果临界区太大，就无法充分利用多处理器发挥多线程的优势。对于被互斥量保护的临界区内的代码，一定要好好审视，不要将不相干的（特别是可能陷入阻塞的）代码放入临界区内执行。

> **图7-15**：临界区太小，未能解决竞争，重复插入了某元素（时序图：线程A判断元素不存在，在加锁前线程B也判断不存在，然后线程A加锁插入，线程B随后加锁插入，导致重复）。

## 7.7.4　互斥量的性能

还是以前面的例子为例进行说明，4个线程分别对全局变量累加1000万次，使用互斥量版本的程序和不使用互斥量的版本相比，会消耗更多的时间，如表7-10所示。

**表7-10　加锁版本和无锁版本的性能比较**

| 版本 | 性能 |
|------|------|
| 互斥量版本 | 消耗更长的时间 |
| 无锁版本 | 性能更好 |

互斥量版本需要消耗更长的时间，其原因有以下三点：
1. 对互斥量的加锁和解锁操作，本身有一定的开销。
2. 临界区的代码不能并发执行。
3. 进入临界区的次数过于频繁，线程之间对临界区的争夺太过激烈，若线程竞争互斥量失败，就会陷入阻塞，让出CPU，所以执行上下文切换的次数要远远多于不使用互斥量的版本。

看到这个结果，又有一个疑问涌上心头，互斥量的性能如何？

Linux下，互斥量的实现采用了futex（fast user space mutex）机制。传统的同步手段，进入临界区之前会申请锁，而此时不得不执行系统调用，查看是否存在竞争；当离开临界区释放锁的时候，需要再次执行系统调用，查看是否需要唤醒正在等待锁的进程。但是在竞争并不激烈的情况下，加锁和解锁的过程中可能会出现以下两种情况：
- 申请锁时，执行系统调用，从用户模式进入内核模式，却发现并无竞争。
- 释放锁时，执行系统调用，从用户模式进入内核模式，尝试唤醒正在等待锁的进程，却发现并没有进程正在等待锁的释放。

考虑到系统调用的开销，这两种情况耗资靡费，却劳而无功。

futex机制的出现有效地解决了这两个问题。futex的全称是fast userspace mutex，中文名为快速用户空间互斥体，它是一种用户态和内核态协同工作的同步机制。glibc使用内核提供的futex系统调用实现了互斥量。

glibc的互斥量实现，含有大量的汇编代码，不易读懂，下面用伪代码来描述下互斥量的加锁和解锁操作：

```c
void lock(mutex* lock)
{
    int c;
    if(c = cmpxchg(lock,0,1) != 0)
    // 如果原始值是0,则表示处于没加锁的状态,将lock改成1,直接返回
    // 如果原始值不是0,则表示互斥量已被加锁,需要继续执行
    do
    {
        /* 此处有以下可能性:
           1) c==2 表示已被加锁,并且有其他正在等待的线程,应立即调用futex_wait
           2) 原子地检查lock是否为1,如果是,则将lock改成2,然后调用futex_wait
              如果不是,则表示其他线程释放了锁,将lock改成了0,需要执行while语句争夺锁
        */
        if (c == 2 || cmpxchg(lock, 1, 2) != 0)
        {
            //如果执行futex_wait时,lock已经被改写,不等于2,则当即返回
            futex_wait(lock, 2);
        }
    } while ((c = cmpxchg(lock, 0, 2)) != 0);
    //表示有线程unlock,但是不知道解锁后是1还是2,保险起见,写成2
}

void unlock(mutex* lock)
{
    //atomic_dec的作用是减1并返回原始值
    if (atomic_dec(lock) != 1)
    {
        // 原始值是2,有线程等待互斥量,才会进入
        // 如果原始值是1,则表示没有线程等待,没必要futex_wake
        lock = 0;
        futex_wake(lock, 1);
    }
}
```

上面的cmpxchg和atomic_dec都是原子操作。
- `cmpxchg（lock，a，b）`：表示如果lock的值等于a，那么将lock改为b，并将原始值返回，否则直接将原始值返回。
- `atomic_dec（lock）`：表示将lock的值减去1，并且返回原始值。

glibc的互斥量中维护了一个值lock，该值有以下三种情况。
- `0`：表示互斥量并未上锁。
- `1`：表示互斥量已经上锁，但是并没有线程正在等待该锁。
- `2`：表示互斥量已经上锁，并且有线程正在等待该锁。

加锁时，如果发现该值是0，那么直接将该值改为1，无须执行任何系统调用，因为并没有线程持有该锁，无须等待；  
解锁时，如果发现该值是1，直接将该值改成0，无须执行任何系统调用，因为并没有线程正在等待该锁，无须唤醒。

当然，在这两种情况下，比较和修改操作（Compare And Swap）必须是原子操作，否则会出现问题。如果无竞争，可以看出，互斥量的加锁和解锁非常轻量级。

用一个简单的实验也可以证明，无竞争条件下，加锁解锁的操作是很轻量级的。下面用一个循环执行加锁和解锁操作1000万次，统计下加锁解锁一次消耗的平均时间，即：

```c
clock_gettime(CLOCK_MONOTONIC, &start);
for (int i = 0; i < TIMES; ++i) {
    pthread_mutex_lock(&lock);
    pthread_mutex_unlock(&lock);
}
clock_gettime(CLOCK_MONOTONIC, &end);
```

在笔者用的2.13GHz i3处理器的Ubuntu上，加锁解锁一次，平均消耗24纳秒左右，证明了在无竞争的条件下，互斥量的加锁和解锁操作的确是十分轻量级的。

接下来考虑存在竞争的情况，这时候，就需要内核来参与了。

内核提供了`futex_wait`和`futex_wake`两个操作（futex系统调用支持的两个命令）：

```c
int futex_wait(int *uaddr, int val);
int futex_wake(int *uaddr, int n);
```

`futex_wait`是用来协助加锁操作的。线程调用`pthread_mutex_lock`，如果发现锁的值不是0，就会调用`futex_wait`，告知内核，线程须要等待在uaddr对应的锁上，请将线程挂起。内核会建立与uaddr地址对应的等待队列。

为什么需要内核维护等待队列？因为一旦互斥量的持有者线程释放了互斥量，就需要及时通知那些等待在该互斥量上的线程。如果没有等待队列，内核将无法通知到那些正陷入阻塞的线程。

如果整个系统有很多这种互斥量，是不是需要为每个uaddr地址建立一个等待队列呢？事实上不需要。理论上讲，futex只需要在内核之中维护一个队列就够了，当线程释放互斥量时，可能会调用`futex_wake`，此时会将uaddr传进来，内核会去遍历该队列，查找等待在该uaddr地址上的线程，并将相应的线程唤醒。

但是只有一个队列的话查找效率有点低，作为优化，内核实现了多个队列。插入等待队列时，会先计算hash值，然后根据hash插入到对应的链表之中，如图7-16所示。

值得一提的是，`futex_wait`操作需要的val入参，乍看之下好像没什么用处。事实上并非如此。从用户程序判断锁的值，到调用`futex_wait`操作是有时间窗口的，在这个时间窗口之内，有可能发生线程解锁的操作，从而可能无须等待。因此`futex_wait`操作会检查uaddr对应的锁的值是否等于val的值，只有在等于val的情况下，内核才会让线程等待在对应的队列上，否则会立刻返回，让用户程序再次申请锁。

**图7-16　futex机制中内核的等待队列**

（此处为示意图，描述多个hash桶链接等待队列的结构）

`futex_wake`操作是用来实现解锁操作的。glibc就是使用该操作来实现互斥量的解锁函数`pthread_mutex_unlock`的。当线程执行完临界区代码，解锁时，内核需要通知那些正在等待该锁的线程。这时候就需要发挥`futex_wake`操作的作用了。`futex_wake`的第二个参数n，对于互斥量而言，该值总是1，表示唤醒1个线程。当然，也可以唤醒所有正在等待该锁的线程，但是这样做并无好处，因为被唤醒的多个线程会再次竞争，却只能有一个线程抢到锁，这时其他线程不得不再次睡去，徒增了很多开销。

使用`strace`跟踪系统调用的时候，看不到`futex_wait`和`futex_wake`两个系统调用，看到的是`futex`系统调用，如下。

```c
#include <linux/futex.h>
#include <sys/time.h>
int futex(int *uaddr, int op, int val,
 const struct timespec *timeout, int *uaddr2, int val3);
```

该系统调用是一个综合的系统调用，根据第二个参数`op`来决定具体的行为。当`op`为`FUTEX_WAIT`时，对应的是前面讨论的`futex_wait`操作，当`op`为`FUTEX_WAKE`时，对应的是前面讨论的`futex_wake`操作。

细心的话，可以发现，互斥量加锁和解锁时，调用`futex`的`op`参数并非`FUTEX_WAIT`和`FUTEX_WAKE`，而是`FUTEX_WAIT_PRIVATE`和`FUTEX_WAKE_PRIVATE`，这是为了改进futex的性能而进行的优化。因为futex也可以用在不同的进程之间，加上后缀`_PRIVATE`是为了明确告知内核，互斥的行为是用在线程之间的。

从上面的角度分析，当存在竞争时，如果线程申请不到互斥量，就会让出CPU，系统会发生上下文切换。在线程个数众多，临界区竞争异常激烈的情况下，上下文切换会是一笔不小的开销。

如果临界区非常小，线程之间对临界区的竞争并不激烈，只会偶尔发生，这种情况下，忙-等待的策略要优于互斥量的“让出CPU，陷入阻塞，等待唤醒”的策略。采用忙-等待策略的锁为自旋锁。

关于futex的原理，Ulrich Drepper《Futexes Are Tricky》[1]一文就是非常好的参考文献。

> [1] Ulrich Drepper的《Futexes Are Tricky》，详见http://www.akkadia.org/drepper/futex.pdf。

---

## 7.7.5　互斥锁的公平性

互斥锁是公平的吗？

首先要定义什么是公平（fairness）。对于锁而言，如果A在B之前调用`lock()`方法，那么A应该先于B获得锁，进入临界区。多处理器条件下，很难确定是哪个线程率先调用的`lock()`方法。纵然能判定是哪个线程率先调用的`lock()`方法，要实现指令级的公平也是很难的。常见的判断锁公平性的方法是，将锁的实现代码分成如下两个部分：
- 门廊区
- 等待区

门廊区必须在有限的操作内完成，等待区则可能有无穷的步骤，它们会陷入未知结束时间的等待中。

如果锁能满足以下条件，就称锁是先来先服务（FCFS）的：  
**如果线程A门廊区的结束在线程B门廊区的开始之前，那么线程A一定不会被线程B赶超。**

互斥量也有门廊区和等待区，就像7.7.4节分析的，如果没有竞争，线程执行几个指令就加锁成功，顺利返回了。在这种情况下，互斥量在门廊区就解决了所有的需要。但是如果有竞争，互斥锁在门廊区判断出存在竞争，线程取不到锁，就不得不执行`futex_wait`，让内核将其挂起，并记录在等待队列上。需要等待多久？不知道。

从表面上看，内核会将等待互斥量的线程放入队列，每来一个等待线程，就把线程记录在队列的尾部，当互斥量的持有线程解锁时，内核只会唤醒一个线程，而唤醒的正是队列中等待该互斥量的第一个等待者。队列的先入先出（FIFO），看起来已经保证了互斥量的公平性。但是，这样就能确保公平吗？

**答案是否定的，互斥锁并没有做到先来先服务。**

根据7.7.4节的伪代码可知，当互斥量的lock的值是2，或者尝试调用CAS操作将lock从1改成2并且成功时，线程会调用`futex_wait`陷入阻塞。值得一提的是，CAS操作在尝试将1改成2时，也可能存在竞争，比如其他线程有解锁操作，lock值已经被改成了0，而这时候恰好存在另外一个线程刚刚调用加锁操作，这时就会发生门廊区的争夺，对于这种情况不做详细分析。假设加锁调用了`futex_wait`，内核将线程挂起在等待队列上，从那时起，线程就进入了漫长的等待区。

如果互斥量的持有线程解锁，会首先将互斥量的lock值设置成0，然后唤醒内核等待队列中等待在该地址上的第一个线程。看起来比较公平，但是问题就出在此处，被唤醒的线程并不是自动就持有了互斥锁，反而须要执行`while()`中包裹的`cmpxchg`操作，再次竞争互斥量。如果竞争失败，则被另外一个初来乍到的线程将0改成了1，那么线程刚刚醒来就不得不再次执行`futex_wait`，再次沉睡。这次竞争失败的代价是巨大的，因为`futex_wait`操作会将线程挂载到等待队列的队尾。

由上面的分析可以得出如下结论：
- 线程可能多次调用`futex_wait`进入等待区，在线程被`futex_wait`唤醒后，并不会自动拥有互斥量，而是再次进入门廊区，和其他线程争夺锁。
- 在已经有很多线程处于内核等待队列的情况下，新来的加锁请求可能会后发先至，率先获得锁。
- `futex_wait`唤醒的线程如果没有竞争到锁，那么会再次调用`futex_wait`函数，陷入睡眠，不过内核会将其放入等待队列的队尾，这种行为加剧了不公平性。

所以，综合上面的讨论，互斥量不是一个公平的锁，没有做到先来先服务。关于futex的早期论文《Fuss，Futexes and Furwocks：Fast Userlevel Locking in Linux》，已经指出了这个问题。`futex_up_fair`系统调用尝试解决这个不公平的问题，但是最终没有进入内核主线。

为什么开发者并不在意这种不公平性？因为要实现这种公平性会牺牲性能，而这种牺牲并无必要。绝大多数情况下，由于调度的原因，用户根本无法判断哪个线程会优先调用加锁操作，那么内核或glibc维持这种先来先服务（FCFS）就变得毫无意义。如果可以在不牺牲性能的情况下做到公平，自然最好，但是实际情况并非如此。实现这种公平，对性能的伤害很大。就像Ulrich Drepple在Thread starvation with mutex的回复中所说的：

> Is there a reason why NPTL does not use this "fair" method?  
> It's slow and unnecessary.

综上所述，结论如下：内核维护等待队列，互斥量实现了大体上的公平；由于等待线程被唤醒后，并不自动持有互斥量，需要和刚进入门廊区的线程竞争，所以互斥量并没有做到先来先服务。

---

## 7.7.6　互斥锁的类型

前面讨论的都是默认类型的互斥锁，除默认类型外，互斥锁还有几个变种，它们的行为模式和默认互斥锁有一定的差异。

互斥量有以下4种类型：
- `PTHREAD_MUTEX_TIMED_NP`
- `PTHREAD_MUTEX_RECURSIVE`
- `PTHREAD_MUTEX_ERRORCHECK`
- `PTHREAD_MUTEX_ADAPTIVE_NP`

glibc提供了接口来查询和设置互斥锁的类型：

```c
#include <pthread.h>
int pthread_mutexattr_gettype(const pthread_mutexattr_t *restrict attr, int *restrict type);
int pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type);
```

可以仿照如下代码来设置互斥量的类型：

```c
/* 忽略了出错判断,真实代码中需要判断 error */
pthread_mutex mtx;
pthread_mutexattr_t mtxAttr;
pthread_mutexattr_init(&mtxAttr);
pthread_mutexattr_settype(&mtxAttr, PTHREAD_MUTEX_ADAPTIVE_NP);
pthread_mutex_init(&mtx, &mtxAttr);
```

其中manual给出了4种类型，但并非前面提到的这4种类型，略有差异，差异在于：manual中存在`PTHREAD_MUTEX_DEFAULT`类型，而少了一个`PTHREAD_MUTEX_ADAPTIVE_NP`类型。manual中给出的是标准unix 98定义的4种类型。

对于NPTL的实现，具体如下：
```
PTHREAD_MUTEX_NORMAL  = PTHREAD_MUTEX_TIMED_NP,
PTHREAD_MUTEX_DEFAULT = PTHREAD_MUTEX_NORMAL;
```
所以，glibc的实现比标准的Unix 98多了一个`PTHREAD_MUTEX_ADAPTIVE_NP`类型，下面来分别介绍这几个互终于轮到`PTHREAD_MUTEX_ADAPTIVE_NP`这种类型了。这种类型堪称互斥锁中的战斗机，特点就是一个字——快，libc的文档里面直接将其称为fast mutex。那么它和普通的互斥量相比有何差异，它是如何快速实现的呢？

所有锁的实现都会面临一个相同的问题：加锁时竞争失败了该怎么办？普通互斥量的做法是立刻调用`futex_wait`，陷入阻塞，让出CPU，安静地等待内核将其唤醒。在临界区非常小且很少发生竞争的情况下，这种策略并不算好，因为如果该线程肯自旋，很可能只需要极短的时间，它就能等到锁的持有线程解锁，继续执行。而调用`futex_wait`，执行系统调用和上下文切换的开销可能远大于自旋。

出于这种考虑，glibc引入了线程自旋锁。自旋锁采用了和互斥量完全不同的策略，自旋锁加锁失败，并不会让出CPU，而是不停地尝试加锁，直到成功为止。这种机制在临界区非常小且对临界区的争夺并不激烈的场景下，效果非常好，如下。

```c
#include <pthread.h>
int pthread_spin_destroy(pthread_spinlock_t *lock);
int pthread_spin_init(pthread_spinlock_t *lock, int pshared);
int pthread_spin_lock(pthread_spinlock_t *lock);
int pthread_spin_trylock(pthread_spinlock_t *lock);
int pthread_spin_unlock(pthread_spinlock_t *lock);
```

自旋锁的效果好，但是副作用也大，如果使用不当，自旋锁的持有者迟迟无法释放锁，那么，自旋接近于死循环，会消耗大量的CPU资源，造成CPU使用率飙高。因此，使用自旋锁时，一定要确保临界区尽可能地小，不要有系统调用，不要调用`sleep`。使用`strcpy`/`memcpy`等函数也需要谨慎判断操作内存的大小，以及是否会引起缺页中断。

自旋锁副作用大，而互斥量在某些情况下效率可能不够高，有没有一种方法能够结合两种方法的长处呢？  
答案是肯定的。这就是`PTHREAD_MUTEX_ADAPTIVE_NP`类型的互斥量，也被称为自适应锁。大多数操作系统（Solaris、Mac OS X、FreeBSD）都有类似的接口，如果竞争锁失败，首先与自旋锁一样，持续尝试获取，但过了一定时间仍然不能申请到锁，就放弃尝试，让出CPU并等待。

`PTHREAD_MUTEX_ADAPTIVE_NP`类型的互斥量，采用的就是这种机制，如下：

```c
if (LLL_MUTEX_TRYLOCK (mutex) != 0)
{
    int cnt = 0;
    int max_cnt = MIN (MAX_ADAPTIVE_COUNT,
           mutex->__data.__spins * 2 + 10);
    do
    {
        if (cnt++ >= max_cnt)
        {
            /*自旋也没有等到锁,只能睡去*/
            LLL_MUTEX_LOCK (mutex);
            break;
        }
#ifdef BUSY_WAIT_NOP
        BUSY_WAIT_NOP;
#endif
    }
    while (LLL_MUTEX_TRYLOCK (mutex) != 0);
    mutex->__data.__spins += (cnt - mutex->__data.__spins) / 8;
}
```

到底等待多长时间才合适呢？这种互斥量定义了一个名为`__spins`的变量，该值和`MAX_ADAPTIVE_COUNT`共同决定自旋多久。该类型之所以叫自适应（ADAPTIVE），是因为带有反馈机制，它会根据实际情况，智能地调整`__spins`的值。

```c
mutex->__data.__spins += (cnt - mutex->__data.__spins) / 8;
```

当然自旋不是无止境的向上增长时，`MAX_ADAPTIVE_COUNT`决定了上限，即调用`BUSY_WAIT_NOP`的最大次数：

```c
# define MAX_ADAPTIVE_COUNT 100
```

对于7.7.1节中对`global_cnt`自加1000万次的程序，如果把`for`循环体内的锁换成自适应互斥锁，会比普通的互斥量更快吗？答案是否定的，在这种时时刻刻要加锁和解锁的激烈竞争下，让其他线程睡去，利用上下文切换的时间间隔，让一个线程飞快地自加，执行时间反而是最短的。

但是，真实场景下临界区的争夺不可能激烈到这种程度，如果竞争真的激烈到这种程度，那首先需要反省的是设计问题。在临界区非常小，偶尔发生竞争的情况下，自适应互斥锁的性能要优于普通的互斥锁。

---

## 7.7.7　死锁和活锁

对于互斥量而言，可能引起的最大问题就是死锁（dead lock）了。最简单、最好构造的死锁就是图7-17所示的这种场景了。

**图7-17　死锁的产生（简单场景）**

（示意图：线程1持有互斥量1，申请互斥量2；线程2持有互斥量2，申请互斥量1，形成循环等待）

线程1已经成功拿到了互斥量1，正在申请互斥量2，而同时在另一个CPU上，线程2已经拿到了互斥量2，正在申请互斥量1。彼此占有对方正在申请的互斥量，结局就是谁也没办法拿到想要的互斥量，于是死锁就发生了。

上面的例子比较简单，但实际工程中死锁可能会发生在复杂的函数调用之中。可以想象随着程序复杂度的增加，很多死锁并不像上面的例子那样一目了然，如图7-18所示。

**图7-18　死锁的产生（复杂场景）**

（示意图：多个函数调用链中交叉持有锁）

在多线程程序中，如果存在多个互斥量，一定要小心防范死锁的形成。

存在多个互斥量的情况下，避免死锁最简单的方法就是总是按照一定的先后顺序申请这些互斥量。还是以刚才的例子为例，如果每个线程都按照先申请互斥量1，再申请互斥量2的顺序执行，死锁就不会发生。有些互斥量有明显的层级关系，但是也有一些互斥量原本就没有特定的层级关系，不过没有关系，可以人为干预，让所有的线程必须遵循同样的顺序来申请互斥量。

另一种方法是尝试一下，如果取不到锁就返回。Linux提供了如下接口来表达这种思想：

```c
int pthread_mutex_trylock(pthread_mutex_t *mutex);
int pthread_mutex_timedlock(pthread_mutex_t *restrict mutex, const struct timespec *restrict abs_timeout);
```

这两个函数反映了这种尝试一下，不行就算了的思想。

对于`pthread_mutex_trylock()`接口，如果互斥量已然被锁定，那么当即返回`EBUSY`错误，而不像`pthread_mutex_lock()`接口一样陷入阻塞。

对于`pthread_mutex_timedlock()`接口，提供了一个时间参数`abs_timeout`，如果申请互斥量的时候，互斥量已被锁定，那么等待；如果到了`abs_timeout`指定的时间，仍然没有申请到互斥量，那么返回`ETIMEOUT`错误。

除此以外，这两个接口的表现与`pthread_mutex_lock`是一致的。在实际的应用中，这两个接口使用的频率远低于`pthread_mutex_lock`函数。

trylock不行就回退的思想有可能会引发活锁（live lock）。生活中也经常遇到两个人迎面走来，双方都想给对方让路，但是让的方向却不协调，反而互相堵住的情况（如图7-19所示）。活锁现象与这种场景有点类似。

**图7-19　让路总让到一起，变成堵路**

（示意图：两人互相让路却总是让到同一侧）

考虑下面两个线程，线程1首先申请锁`mutex_a`后，之后尝试申请`mutex_b`，失败以后，释放`mutex_a`进入下一轮循环，同时线程2会因为尝试申请`mutex_a`失败，而释放`mutex_b`，如果两个线程恰好一直保持这种节奏，就可能在很长的时间内两者都一次次地擦肩而过。当然这毕竟不是死锁，终究会有一个线程同时持有两把锁而结束这种情况。尽管如此，活锁的确会降低性能。这种情况的示例代码如下：

```c
//线程1
void func1()
{
    int done = 0;
    while(!done)
    {
        pthread_mutex_lock(&mutex_a);
        if (pthread_mutex_trylock (&mutex_b))
        {
            counter++;
            pthread_mutex_unlock(&mutex_b);
            pthread_mutex_unlock(&mutex_a);
            done = 1;
        }
        else
        {
            pthread_mutex_unlock(&mutex_a);
        }
    }
}

// 线程2
void func2()
{
    int done = 0;
    while(!done)
    {
        pthread_mutex_lock (&mutex_b);
        if (pthread_mutex_trylock (&mutex_a))
        {
            counter++;
            pthread_mutex_unlock (&mutex_a);
            pthread_mutex_unlock (&mutex_b);
            done = 1;
        }
        else
        {
            pthread_mutex_unlock (&mutex_b);
        }
    }
}
```

---

## 7.8　读写锁

很多时候，对共享变量的访问有以下特点：大多数情况下线程只是读取共享变量的值，并不修改，只有极少数情况下，线程才会真正地修改共享变量的值。

对于这种情况，读请求之间是无需同步的，它们之间的并发访问是安全的。然而写请求必须锁住读请求和其他写请求。

这种情况在实际中是存在的，比如配置项。大多数时间内，配置是不会发生变化的，偶尔会出现修改配置的情况。如果使用互斥量，完全阻止读请求并发，则会造成性能的损失。

出于这种考虑，POSIX引入了读写锁。

读写锁比较简单，从表7-11可以看出，对于这种情况，读写锁做了优化，允许大家一起读。

**表7-11　读写锁的行为**

| 当前状态 | 请求类型 | 结果 |
|----------|----------|------|
| 无锁 | 读 | 获得读锁 |
| 无锁 | 写 | 获得写锁 |
| 已上读锁 | 读 | 允许，获得读锁 |
| 已上读锁 | 写 | 阻塞，直到所有读锁释放 |
| 已上写锁 | 读 | 阻塞，直到写锁释放 |
| 已上写锁 | 写 | 阻塞，直到写锁释放 |

# 7.8　读写锁

很多时候，对共享变量的访问有以下特点：大多数情况下线程只是读取共享变量的值，并不修改，只有极少数情况下，线程才会真正地修改共享变量的值。

对于这种情况，读请求之间是无需同步的，它们之间的并发访问是安全的。然而写请求必须锁住读请求和其他写请求。

这种情况在实际中是存在的，比如配置项。大多数时间内，配置是不会发生变化的，偶尔会出现修改配置的情况。如果使用[[互斥量]]，完全阻止读请求并发，则会造成性能的损失。

出于这种考虑，POSIX引入了[[读写锁]]。

读写锁比较简单，从表7-11可以看出，对于这种情况，读写锁做了优化，允许大家一起读。

**表7-11　读写锁的行为**

| 当前锁状态       | 请求类型 | 行为                         |
| ---------------- | -------- | ---------------------------- |
| 无锁             | 读锁     | 允许，获得读锁               |
| 无锁             | 写锁     | 允许，获得写锁               |
| 读锁（被持有）   | 读锁     | 允许（多个读线程可同时持有） |
| 读锁（被持有）   | 写锁     | 阻塞，直到读锁全部释放       |
| 写锁（被持有）   | 读锁     | 阻塞，直到写锁释放           |
| 写锁（被持有）   | 写锁     | 阻塞，直到写锁释放           |

## 7.8.1　读写锁的接口

### 1. 创建和销毁读写锁

NTPL提供了`pthread_rwlock_t`类型来表示读写锁。和互斥量一样，它也提供了两种初始化的方法：

```c
#include <pthread.h>
int pthread_rwlock_init(pthread_rwlock_t *rwlock,
                             const pthread_rwlockattr_t *attr);
int pthread_rwlock_destroy(pthread_rwlock_t *rwlock);

pthread_rwlock_t rwlock = PTHREAD_RWLOCK_INITIALIZER;
```

对于静态变量，可以采用`PTHREAD_RWLOCK_INITIALIZER`赋值的方式初始化；对于动态分配的读写锁，或者非默认属性的读写锁，需要用`pthread_rwlock_init`函数进行初始化。如果第二个属性参数为`NULL`，那么采用默认属性。

读写锁的默认属性如表7-12所示。

**表7-12　读写锁的默认属性**

| 属性项   | 默认值                                                       |
| -------- | ------------------------------------------------------------ |
| `lockkind` | `PTHREAD_RWLOCK_PREFER_READER_NP`（读者优先）                |
| `pshared`  | `PTHREAD_PROCESS_PRIVATE`（仅进程内可用）                        |

> [!NOTE] 读者优先策略
> 所谓读者优先的策略，是指当前锁的状态是读锁，如果线程申请读锁，此时纵然有写锁在等待队列上，仍然允许申请者获得读锁，而不是被写锁阻塞。后面会详细讨论读者优先和写者优先对读写锁的影响。

对于调用`pthread_rwlock_init`初始化的读写锁，在不需要读写锁的时候，需要调用`pthread_rwlock_destroy`销毁，如下：

```c
#include <pthread.h>
int pthread_rwlock_destroy(pthread_rwlock_t *rwlock);
```

### 2. 读写锁的加锁和解锁

读写锁又称共享-独占锁，有共享，也有独占。

下面是三个读锁上锁的接口：

```c
int pthread_rwlock_rdlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_tryrdlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_timedrdlock(pthread_rwlock_t *rwlock, const struct timespec *abstime);
```

而下面三个是写锁上锁的接口：

```c
int pthread_rwlock_wrlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_trywrlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_timedwrlock(pthread_rwlock_t *rwlock, const struct timespec *abstime);
```

**读锁**用于共享模式。如果当前读写锁已经被某线程以读模式占有了，那么其他线程调用`pthread_rwlock_rdlock`会立刻获得读锁；如果当前读写锁已经被某线程以写模式占有了，那么调用`pthread_rwlock_rdlock`会陷入阻塞。

**写锁**用的是独占模式。如果当前读写锁被某线程以写模式占有，则不允许任何读锁请求通过，也不允许任何写锁请求通过，读锁请求和写锁请求都要陷入阻塞，直到线程释放写锁。

无论是读锁还是写锁，锁的释放都是一个接口：

```c
int pthread_rwlock_unlock (pthread_rwlock_t *rwlock);
```

- 无论是读锁还是写锁，都提供了`trylock`的功能，当不能获得读锁或写锁时，调用线程不会阻塞，而会立即返回，错误码是`EBUSY`。
- 无论是读锁还是写锁都提供了限时等待，如果不能获取读写锁，则会陷入阻塞，最多等待到`abstime`，如果仍然无法获得锁，则返回，错误码是`ETIMEOUT`。

从表面上看，读写锁介绍到此处就可以打完收工了，其实不然，读写锁是两种类型的锁，当它们都存在时，它们之间的竞争关系如何？如果同时到来一大拨读锁请求和写锁请求，它们之间的响应又有什么特点？事实上，这些是由读写锁的策略决定的。

## 7.8.2　读写锁的竞争策略

读写锁的属性是`pthread_rwlockattr_t`类型，属性中有两个部分：`lockkind`和`pshared`。本节只讲`lockkind`。

所谓`lockkind`，表示读写锁表现出什么样的行为艺术。对于读写锁，目前有两种策略，一是读者优先，一是写者优先。

glibc引入了如下接口来查询和改变读写锁的类型：

```c
int pthread_rwlockattr_getkind_np(const pthread_rwlockattr_t * attr, int * pref);
int pthread_rwlockattr_setkind_np(pthread_rwlockattr_t * attr, int * pref);
```

其中，读写锁类型的可能值有如下几种：

```c
enum
{
  PTHREAD_RWLOCK_PREFER_READER_NP,           // 读者优先
  PTHREAD_RWLOCK_PREFER_WRITER_NP,           // 很唬人,但是也是读者优先
  PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP, // 写者优先
  PTHREAD_RWLOCK_DEFAULT_NP = PTHREAD_RWLOCK_PREFER_READER_NP
};
```

前两个都是读者优先的策略，尤其要注意其中的第二个，名字取得很“变态”，名为`PREFER_WRITE`却干着“挂羊头卖狗肉”的勾当。只有第三个是写者优先的策略。从`pthread_rwlock_init`函数中可以看出端倪：

```c
rwlock->__data.__flags
   = iattr->lockkind == PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP;
```

可以看到，只有`PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP`是写者优先，其他一律都是读者优先。读写锁的默认行为是读者优先。

那么，什么是读者优先呢？

如果当前锁的状态是读锁，并存在写锁请求被阻塞，那么在写锁后面到来的读锁请求该如何处理就成了问题的关键。

如果在写锁请求后面到来的读锁请求不被写锁请求阻塞，就可以立即响应，写锁的下场可能会比较悲惨。如果读锁请求前赴后继源源不断地到来，只要有一个读锁没完成，写锁就没份。这就是所谓的读者优先。

从图7-20可以看出，这种策略是不公平的，极端情况下，写请求很可能被饿死。这就是多线程中的[[饥饿]]（Starvation）现象，即某些线程总是得不到锁资源。

**图7-20　较早到的写锁请求被饿死**（示意：写锁请求在队列中，后到的读锁请求插队获得锁）

晚于写锁请求到来的读锁请求不排队乱加塞的行为引起了写锁申请者的强烈不满：凭啥仅仅因为当前是读锁，比我晚来的读锁申请者就不用排队，直接响应？鉴于此，glibc又实现了写者优先的策略。

所谓写者优先是指，如果当前是读锁，有很多线程在共享读锁，这是允许的，但是一旦线程申请写锁，在写锁请求后面到来的读锁请求就会统统被阻塞，不能先于写请求拿到锁。

glibc是如何做到这点的？它引入了表7-13中的变量。

**表7-13　读写锁实现中的变量及含义**

| 变量名                | 含义                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `__lock`              | 全局互斥锁，用于保护读写锁内部数据结构                               |
| `__writer`            | 持有写锁的线程ID（调度域），0表示无写锁                              |
| `__nr_readers`        | 当前持有读锁的线程数                                                   |
| `__nr_readers_queued` | 等待获得读锁的线程数                                                   |
| `__nr_writers_queued` | 等待获得写锁的线程数                                                   |

无论是申请读锁还是申请写锁，还是解锁，都至少会做一次全局互斥锁（对应`__lock`）的加锁和解锁，若不考虑阻塞，单单考虑操作本身的开销，读写锁的加解锁开销是互斥锁的两倍。当然，函数结束前或进入阻塞之前，会将全局的互斥锁释放。下面的讨论先暂时忽略该全局的互斥锁。

**对于读锁请求而言**，如果：

- 无线程持有写锁，即`__writer==0`。
- 采用的是读者优先策略或没有写锁等待者（`__nr_writers_queued==0`）。

当满足这两个条件时，读锁请求都可以立刻获得读锁，返回之前执行`__nr_readers++`，表示多了一个线程占有读锁。

不满足的话，则执行`__nr_readers_queued++`，表示增加一个读锁等待者，然后调用`futex`，陷入阻塞。醒来之后，会先执行`__nr_readers_queued--`，然后再次判断是否同时满足条件1和2。

**对于写请求而言**，如果：

- 无线程持有写锁，即`__writer==0`。
- 没有线程持有读锁，即`__nr_readers==0`。

只要满足上述条件，就会立刻拿到写锁，将`__writer`置为线程的ID（调度域）。

如果不满足，那么执行`__nr_writers_queued++`，表示增加一个写锁等待者线程，然后执行`futex`陷入等待。醒来后，先执行`__nr_writers_queued--`，然后重新判断条件1和2。

**对于解锁而言**，如果当前锁是写锁，则执行如下操作：

1. 执行`__writer=0`，表示释放写锁。
2. 根据`__nr_writers_queued`判断有没有写锁等待者，如果有，则唤醒一个写锁等待者。
3. 如果没有写锁等待者，则判断有没有读锁等待者；如果有，则将所有的读锁等待者一起唤醒。

如果当前锁是读锁，则执行如下操作：

1. 执行`__nr_readers--`，表示读锁占有者少了一个。
2. 判断`__nr_readers`是否等于0，是的话则表示自己是最后一个读锁占有者，需要唤醒写锁等待者或读锁等待者：
   - 根据`__nr_writers_queued`判断是否存在写锁等待者，若有，则唤醒一个写锁等待线程。
   - 如果没有写锁等待者，判断是否存在读锁等待者，若有，则唤醒所有的读锁等待者。

从上面的流程可以看出，写者优先也存在自私的倾向，因为写锁解锁的时候，首先会去查找有没有阻塞的写锁请求，如果有，先唤醒写锁请求线程。因此如果当前读写锁状态是写锁，同时到来很多写请求和读请求，那它将总是优先处理写请求。如果写锁请求源源不断地到来，那它一样会将读锁请求饿死。

通过上面的分析可以看到，如果存在大量的读写请求，竞争非常激烈的条件下，读写锁存在很大的惯性，如果当前锁的状态是读锁状态，在读者优先的策略下，几乎总是读锁请求先得到响应，写锁被阻塞，因此会出现写请求被饿死的情况。解决的方法是设定成写者优先。如果当前锁的状态是写锁，而写锁也源源不断地到来，这时候，读请求就会被饿死。

下面是一个读写锁的程序，用来验证这种惯性：

```c
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>

#define N_THREAD 100

static int share_cnt = 0;
static pthread_rwlock_t rwlock ;

void *reader(void *param)
{
    int i = (int) param;
    while(1)
    {
        pthread_rwlock_rdlock(&rwlock)  ;
        fprintf(stderr,"reader-%d: the share_cnt = %d\n",i,share_cnt);
        pthread_rwlock_unlock(&rwlock);
    }
    return NULL;
}

void *writer(void *param)
{
    int i = (int) param;
    while(1)
    {
        pthread_rwlock_wrlock(&rwlock)  ;
        share_cnt++;
        fprintf(stderr,"writer-%d: the share_cnt = %d\n",i,share_cnt);
        pthread_rwlock_unlock(&rwlock);
        //      sleep(1);
    }
    return NULL;
}

int main()
{
    pthread_t tid[N_THREAD] ;
    pthread_rwlockattr_t  rwlock_attr ;
    pthread_rwlockattr_init(&rwlock_attr);

#ifdef WRITE_FIRST
    pthread_rwlockattr_setkind_np(&rwlock_attr, PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP);
#endif

    pthread_rwlock_init(&rwlock, &rwlock_attr);

    int i = 0;
    int ret = 0;

    pthread_rwlock_rdlock(&rwlock);
    for(i = 0; i < N_THREAD; i++)
    {
        if(i % 2 == 0)
        {
            ret = pthread_create(&tid[i], NULL, reader, (void*)i);
        }
        else
        {
            ret = pthread_create(&tid[i], NULL, writer, (void*)i);
        }
        if(ret != 0)
        {
            fprintf(stderr,"create thread %d failed \n",i);
            break;
        }
    }
    pthread_rwlock_unlock(&rwlock);

    while(i-- > 0)
    {
        pthread_join(tid[i], NULL);
    }

    pthread_rwlockattr_destroy(&rwlock_attr);
    pthread_rwlock_destroy(&rwlock);
    return ret ;
}
```

创建100个线程（50个读线程和50个写线程），读线程只读取`share_cnt`的值，而写线程会将`share_cnt`的值自加。由于是`while`循环，所以属于读写竞争非常激烈的情况。创建线程之前，主线程会持有读写锁，直到所有线程创建完毕，然后主线程解锁，开闸放水，放任100个线程激烈地竞争读写锁。

- 如果采用读者优先的策略，则会看到由于读线程源源不断地申请读锁，写锁被活活饿死，写线程根本捞不到机会执行。运行N秒之后，`share_cnt`仍然是0。
- 如果我们采用写者优先的策略，情况就完全相反了，自从第一个写锁请求拿到锁之后，读锁请求就再也拿不到锁了，原因是总是有写锁请求，而写锁释放的时候，总是先唤醒写锁，表现出来很强大的惯性。

那么能否实现一款公平的读写锁呢？答案是肯定的。Locklessinc.com中有一篇题为《Sleeping Read-Write Locks》[1]的文章，在分析glibc实现的基础上，给出了一种公平的实现读写锁的方法，测试下来效率很不错。对锁的实现感兴趣的话，可以阅读该文章。

[1] 《Sleeping Reader-Writer Lock》，请参见 http://locklessinc.com/articles/sleeping_rwlocks/。

## 7.8.3　读写锁总结

从宏观意义上看，读写锁要比互斥量并发性好，因为读写锁在更多的时间区域内允许并发。

> [!WARNING] 读写锁并非万能
> 如果认为读写锁是完美的，以至于认为互斥锁没有存在的必要，那就是**too young, too simple, sometimes naive**了。Bryan Cantrill和Jeff Bonwick在《## 7.8.3　读写锁总结（续）

...《Real-world Concurrency》中提出的并发编程的建议里提到了要警惕读写锁（Be wary of readers-writer locks）。读写锁存在如下的短处。

- **性能**：如果临界区比较大，读写锁高并发的优势就会显现出来，但是如果临界区非常小，读写锁的性能短板就会暴露出来。由于读写锁无论是加锁还是解锁，首先都会执行互斥操作，加上读写锁还需要维护当前读者线程的个数、写锁等待线程的个数、读锁等待线程的个数，因此这就决定了读写锁的开销不会小于互斥量。
- **饿死**：互斥量虽然不是绝对意义上的公正，但是线程不会饿死。但是如上一小节的讨论，读者优先的策略下，写线程可能会饿死。写者优先的情况下，读线程可能会饿死。
- **死锁**：读锁是可重入的，这就可能会引发死锁。考虑如下场景，读写锁采用写者优先的策略，A线程已经持有读锁，B线程申请了写锁，正处于等待状态，而持有读锁的A线程再次申请读锁，就会发生死锁。

比较适合读写锁的场景是：临界区的大小比较可观，绝大多数情况下是读，只有非常少的写。

# 7.9　性能杀手：伪共享

通过对互斥量和读写锁的讨论，我们已经有了这种意识：对于共享数据的读写，要加锁保护。临界区的存在，导致多个线程不能并行，造成性能下降。临界区越大，多个线程出入临界区越频繁，对性能的伤害也就越大。

这种情况下对性能的伤害是比较明显的。多线程情况下，还有一种情况对性能的损害是比较大的，却不像临界区这么明显。这就是有名的伪共享问题。

根据局部性原理，存储器是分层的，如图7-21所示。从距离CPU最近的寄存器到主内存，依次为CPU寄存器、L1 Cache、L2 Cache、L3 Cache和主存。从高层往底层走，存储设备变得更慢，容量更大，单位字节也更便宜。最高层是很少量的寄存器，通常可以在1个时钟周期内访问它们，而接下来的L1 Cache通常可以在4个时钟周期内访问到，L2 Cache通常需要10个时钟周期才能访问到，而到了主存，通常需要几百个时钟周期才能访问得到，对这个延迟数据感兴趣的话，可以阅读一下相关文献[1][2]。

**图7-21　存储器的层次结构**（示意图：CPU -> 寄存器 -> L1 Cache -> L2 Cache -> L3 Cache -> 主存）

在这种分层的存储结构中，对于每一个k，位于k层的更快更小的存储被作为位于k+1层的更大更慢的存储设备的缓存。换句话说更快更小的存储设备的数据来自更慢更大的低一级存储设备。访问的数据在高速缓存中，被称为缓存命中，这种情况下访问速度比较快。如果访问的数据d在k级缓存中不存在，就不得不从k+1级中取出包含d的那个块（block）。如果k级缓存已经满了的话，就可能会覆盖现存的一个块。

由于高一级缓存的性能远远超过低一级的缓存，所以一旦缓存不命中（Cache miss），对性能的损害就会是比较大的。

在典型的多核架构中，每个CPU都有自己的Cache。如果一个内存中的变量在多个CPU Cache中都有副本，则需要保证变量的Cache的一致性。现在大多数的架构实现Cache一致性都是采用MESI协议。对缓存一致性协议感兴趣的话，可以阅读《计算机体系结构：量化研究方法》这本经典之作。此外，Paul E.McKenney的《Is Parallel Programming Hard, And, If so, What Can You Do About It》一书中也有很详尽的介绍。

需要注意的是，CPU Cache是以缓存线（Cache line）为单位进行读写的。通常来说，一条缓存线的大小为64字节。换言之，就是访问1字节的数据，系统也会将该字节所在的整条缓存线的数据都搬到缓存中。

因为CPU Cache具有以Cache line为单位进行读写的性质，所以在多线程编程中，稍有不慎，就会掉入伪共享的陷阱，造成性能恶化。

可以考虑下如下代码：

```c
int sum1;
int sum2;

void thread1(int v[], int v_count) {
    sum1 = 0;
    for (int i = 0; i < v_count; i++)
        sum1 += v[i];
}

void thread2(int v[], int v_count) {
    sum2 = 0;
    for (int i = 0; i < v_count; i++)
        sum2 += v[i];
}
```

这部分代码定义了两个全局变量`sum1`和`sum2`，两个线程分别将计算结果放入各自的全局变量中，看起来并行不悖。但是由于这两个全局变量紧挨着定义，编译器给这两个变量分配的内存几乎总是紧挨着的，因此这两个变量很可能在同一条Cache line中。

如图7-22所示，尽管线程1所在的CPU并不需要`sum2`的值，但是由于`sum2`和`sum1`在同一条Cache line中，因此`sum2`的值也随同`sum1`一并被加载到了thread1所在CPU的Cache中了。

**图7-22　伪共享**（示意图：两个CPU各自有自己的Cache，每个Cache中包含同一Cache line，该Cache line中有sum1和sum2两个变量）

当thread1修改`sum1`的值时，尽管并未更新`sum2`的值，但影响的是整条Cache line，它会将thread2所在CPU对应的Cache line置为Invalidate。如果thread2尝试更新`sum2`，会触发缓存不命中。反过来，thread2修改`sum2`时，也会影响到`sum1`的缓存命中。

可以想见，就因为两个值彼此毗邻，落在同一条Cache line中，会导致大量的缓存不命中，从而影响性能。

下面通过一个例子，来看伪共享给性能带来的影响。

计算圆周率π有一种方法是数值积分法：  
\[
\pi = \int_0^1 \frac{4}{1+x^2} dx
\]

可以通过基于中点矩形的数值积分方法来求解上述积分，如下：

```c
static long num_rect = 400000000;
double mid = 0.0;
double height = 0.0;
double width = 1.0 / ((double) num_rect);
int cur;
for (cur = 0; cur < num_rect; cur += 1)
{
    mid = (cur + 0.5) * width;
    height = 4.0 / (1 + mid * mid);
    sum += height;
}
sum *= width;
```

这是典型的计算密集型程序，因此我们采用多线程来分工协作，代码如下：

```c
#include <stdlib.h>
#include <stdio.h>
#include <pthread.h>

#define NR_THREAD 1

static long num_rect = 400000000;

typedef struct sum_struct {
    double sum ;
    //char   padding[56];
} sum_struct;

struct sum_struct __sum[NR_THREAD];

void* calc_pi(void* ptr)
{
    int index = (int)ptr;
    double mid = 0.0;
    double height = 0.0;
    double width = 1.0 / ((double) num_rect);
    int cur = index;
    for (; cur < num_rect; cur += NR_THREAD)
    {
        mid = (cur + 0.5) * width;
        height = 4.0 / (1 + mid * mid);
        __sum[index].sum += height;
    }
    __sum[index].sum *= width;
}

int main()
{
    int i = 0;
    int ret ;
    double result = 0.0;
    pthread_t tid[NR_THREAD];
    fprintf(stdout, "the size of struct sum_struct = %ld\n", sizeof(struct sum_struct));

    for (i = 0; i < NR_THREAD; i++)
    {
        __sum[i].sum = 0.0;
        ret = pthread_create(&tid[i], NULL, calc_pi, (void*) i);
        if (ret != 0)
        {
            /*error handle here*/
            exit(1);
        }
    }

    for (i = 0; i < NR_THREAD; i++)
    {
        pthread_join(tid[i], NULL);
        result += __sum[i].sum;
    }

    fprintf(stdout, "the PI = %.32f\n", result);
    return 0;
}
```

因为`num_rect`等于4亿，因此要计算4亿次，可以通过修改`NR_THREAD`的值，让8个线程协同计算，最后将结果累加到一起得到正确的值，希望这样能将执行时间缩短为单线程的1/8，如图7-23所示。

**图7-23　8个线程并发计算的值**（未标注具体数据，示意多线程加速效果）

因为每个线程都要负责往`__sum`对应的位置更新结果。因此这个数组很容易触发前面提到的伪共享陷阱。当`sum_struct`结构体没有填充字符时，该结构体占据8字节，当8个线程并发时，`__sum`数组很可能在同一个Cache line中，这时候性能必然会受到影响。为了避开false sharing这个陷阱，测试程序采用了加填充字节的方法。如果给`sum_struct`结构体加上56个填充字节，每个`sum_struct`占据1条Cache line的大小，则可以确保它们之间不会互相影响。

```c
typedef struct sum_struct {
    double sum ;
    //char   padding[56]; /* padding 56字节,占满1条Cache line */
} sum_struct;

struct sum_struct __sum[NR_THREAD];
```

在24核的服务器上运行，结果如表7-14所示。

**表7-14　伪共享测试代码的运行结果**

| 线程数 | 未填充（耗时，秒） | 已填充（耗时，秒） | 加速比（未填充） | 加速比（已填充） |
|--------|--------------------|--------------------|------------------|------------------|
| 1      | 2.5                | 2.5                | 1.0              | 1.0              |
| 2      | 2.0                | 1.3                | 1.25             | 1.92             |
| 4      | 1.8                | 0.7                | 1.39             | 3.57             |
| 8      | 1.7                | 0.4                | 1.47             | 6.25             |

可以看出，如果不加56字节的填充，由于伪共享引起的大量缓存不命中，8个线程并没有带来8倍的效率提升。通过填充字节解决了伪共享的问题之后，效率线性地提升了8倍。

[1] http://www.sisoftware.net/?d=qa&f=ben_mem_latency  
[2] Latency Number Every Programmer Should Know.

# 7.10 条件等待

条件等待是线程间同步的另一种方法。

线程经常遇到这种情况：要想继续执行，可能要依赖某种条件。如果条件不满足，它能做的事情就是等待，等到条件满足为止。通常条件的达成，很可能取决于另一个线程，比如生产者-消费者模型。当另外一个线程发现条件符合的时候，它会选择一个时机去通知等待在这个条件上的线程。有两种可能性，一种是唤醒一个线程，一种是广播，唤醒其他线程。

就像工厂里生产车间没有原料了，所有生产车间都停工了，工人们都在车间睡觉。突然进来一批原料，如果原料充足，你会发广播给所有车间，原料来了，快来开工吧。如果进来的原料很少，只够一个车间开工的，你可能只会通知一个车间开工。

为什么要有条件等待？考虑生产者-消费者模型，如果任务队列处于空的状态，那么消费者线程就应该停工等待，一直等到队列不空为止。如果没有条件等待，那么消费者线程的代码可能会写成这样：

```c
pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
int WaitForTrue()
{
    pthread_mutex_lock(&m);
    while (condition is false)//条件不满足
    {
        pthread_mutex_unlock(&m);//解锁等待其他线程改变共享数据
        sleep(n);//睡眠
//n秒后再次加锁验证条件是否满足
        pthread_mutex_lock(&m);
    }
}
```

如果条件不满足，就只能睡眠。上面的代码虽然也能满足这个要求，但存在严重的效率问题。考虑如下场景：解锁之后，sleep之前，等待的条件突然满足了，但很不幸，该线程仍然会睡眠n秒。

很自然需要这么一种机制：线程在条件不满足的情况下，主动让出互斥量，让其他线程去折腾，线程在此处等待，等待条件的满足；一旦条件满足，线程就可以立刻被唤醒。线程之所以可以安心等待，依赖的是其他线程的协作，它确信会有一个线程在发现条件满足以后，将向它发送信号，并且让出互斥量。如果其他线程不配合（不发信号，不让出互斥量），这个主动让出互斥量并等待事件发生的线程就真的要等到花儿都谢了。

## 7.10.1 条件变量的创建和销毁

NPTL使用 `pthread_cond_t` 类型的变量来表示条件变量。条件变量不是一个值，我们无法给条件变量赋值。一个线程如果要等待某个事件的发生，或者某个条件的满足，那么这个线程需要的是条件变量：线程等待在条件变量上。

和互斥锁一样，条件变量在使用之前要先初始化。互斥锁有静态初始化，条件变量也一样。简单地把 `PTHREAD_COND_INITIALIZER` 赋值给 `pthread_cond_t` 类型的变量就可完成条件变量的初始化：

```c
pthread_cond_t cond = PTHREAD_COND_INITIALIZER;
```

动态分配条件变量，或者对条件变量的属性有所定制，都需要用 `pthread_cond_init` 进行初始化：

```c
int pthread_cond_init(pthread_cond_t *cond,
                      const pthread_condattr_t *attr);
```

如果采用默认属性，可以将 NULL 作为第二个参数。

对于 `pthread_cond_init` 初始化的条件变量，不要忘记调用 `pthread_cond_destroy` 来销毁。其接口定义如下：

```c
int pthread_cond_destroy(pthread_cond_t *cond);
```

对于条件变量的初始化和销毁，需要注意以下几点：

- 永远不要用一个条件变量对另一个条件变量赋值，即 `pthread_cond_t cond_b = cond_a` 不合法，这种行为是未定义的。
- 使用 `PTHREAD_COND_INITIALIZE` 静态初始化的条件变量，不需要被销毁。
- 要调用 `pthread_cond_destroy` 销毁的条件变量可以调用 `pthread_cond_init` 重新进行初始化。
- 不要引用已经销毁的条件变量，这种行为是未定义的。

## 7.10.2 条件变量的使用

条件变量，天生就是与条件的满足与否相伴而生的。通常，线程会对一个条件进行测试，如果条件不满足，就等待（`pthread_cond_wait`），或者等待一段有限的时间（`pthread_cond_timedwait`）。相关函数的定义如下：

```c
int pthread_cond_wait(pthread_cond_t *restrict cond,
       pthread_mutex_t *restrict mutex);
int pthread_cond_timedwait(pthread_cond_t *restrict cond,
       pthread_mutex_t *restrict mutex,
       const struct timespec *restrict abstime);
```

从接口上可以看出，条件等待总是和互斥量绑定在一起的。为什么要这样设计？

条件等待是线程间同步的一种手段，如果只有一个线程，条件不满足，那么等待千年也是枉然，所以必须要有一个线程通过某些操作，改变共享数据，使原先不满足的条件变得满足了，并且友好地通知等待在条件变量上的线程。

条件不会无缘无故地突然变得满足了，必然会牵扯到共享数据的变化。所以一定要有互斥锁来保护。没有互斥锁，就无法安全地获取和修改共享数据。

好吧，就算如此，先调用 `pthread_mutex_lock`，发现条件不满足，解锁，然后等待在条件上就行了，为什么还要把互斥锁作为参数传给 `pthread_cond_wait` 呢？像下面所示代码这样使用不可以吗？

```c
//错误的设计
pthread_mutex_lock(&m)
while(condition_is_false)
{
    pthread_mutex_unlock(&m);
    //解锁之后,等待之前,可能条件已经满足,信号已经发出,但是该信号可能会被错过
    cond_wait(&cv);
    pthread_mutex_lock(&m);
}
```

原因在于，上面的解锁和等待不是原子操作。解锁以后，调用 `cond_wait` 之前，如果已经有其他线程获取到了互斥量，并且满足了条件，同时发出了通知信号，那么 `cond_wait` 将错过这个信号，可能会导致线程永远处于阻塞状态。所以解锁加等待必须是一个原子性的操作，以确保已经注册到事件的等待队列之前，不会有其他线程可以获得互斥量。

那先注册等待事件，后释放锁不行吗？注意，条件等待是个阻塞型的接口，不单单是注册在事件的等待队列上，线程也会因此阻塞于此，从而导致互斥量无法释放，其他线程获取不到互斥量，也就无法通过改变共享数据使等待的条件得到满足，因此这就造成了死锁。

下面的伪代码显示了 POSIX 如何使用条件变量 v 和互斥量 m 来等待条件的发生：

```c
pthread_mutex_lock(&m);
while(condition_is_false)
    pthread_cond_wait(&v,&m);//此处会阻塞
/*如果代码运行到此处,则表示我们等待的条件已经满足了,
     *并且在此持有了互斥量
*/
/*在满足条件的情况下,做你想做的事情.
*/
pthread_mutex_unlock(&m);
```

`pthread_cond_wait` 函数只能由拥有互斥量的线程来调用，当该函数返回的时候，系统会确保该线程再次持有互斥量，所以这个接口容易给人一种误解，就是该线程一直在持有互斥量。事实上并不是这样的。这个接口向系统声明了我的心在等待，永远在等待之后，就把互斥量给释放了。这样其他线程就有机会持有互斥量，操作共享数据，触发变化，使线程等待的条件得到满足。

既然互斥量和条件变量关系如此紧密，为什么不干脆将互斥量变成条件变量的一部分呢？原因是，同一个互斥量上可能有不同的条件变量，比如说，有的线程希望队列不空的时候发送信号，有的线程希望队列满的时候发送通知给它（为了创建更多的线程做消费者或其他目的）。

`pthread_cond_timedwait` 函数与 `pthread_cond_wait` 的工作方式几乎是一样的，只是调用时需要指定一个超时的时间。注意这个时间是绝对时间，而不是相对时间。如果最多等待2分钟，那么这个值应该是当前时间加上2分钟。

上面将互斥量和条件变量配合使用的示范代码中有个很有意思的地方，就是用了 `while` 语句，醒来之后要再次判断条件是否满足。

```c
while(condition_is_false)
    pthread_cond_wait(&v,&m);//此处会阻塞
```

为什么不写成：

```c
if(condition_is_false)
    pthread_cond_wait(&v,&m);//此处会阻塞
```

唤醒以后，再次检查条件是否满足，是不是多此一举？

答案是不得不如此。因为唤醒中存在**虚假唤醒（spurious wakeup）**，换言之，条件尚未满足，`pthread_cond_wait` 就返回了。在一些实现中，即使没有其他线程向条件变量发送信号，等待此条件变量的线程也有可能会醒来。

看起来这像是个bug，但它是实实在在存在的。为什么会存在虚假唤醒？一个原因是 `pthread_cond_wait` 是 [[futex]] 系统调用，属于阻塞型的系统调用，当系统调用被信号中断的时候，会返回 -1，并且把 `errno` 置为 `EINTR`。很多这种系统调用为了防止被信号中断都会重启系统调用，代码如下：

```c
pid_t r_wait(int *stat_loc)
{
    int retval;
    while(((retval = wait(stat_loc)) ==-1 && (errno == EINTR));
    return retval;
}
```

但是 futex 不一样，在 futex 返回之后，到重启系统调用之前，可能已经调用过 `pthread_cond_signal` 或 `pthread_cond_broadcast`。一旦错失，再次调用 `pthread_cond_wait` 可能就会导致无限制地等待下去。为了防止这种情况，宁可虚假唤醒，也不能再次调用 `pthread_cond_wait`，以免陷入无穷的等待中。

除了上面的信号因素外，还存在以下情况：条件满足了发送信号，但等到调用 `pthread_cond_wait` 的线程得到 CPU 资源时，条件又再次不满足了。好在无论是哪种情况，醒来之后再次测试条件是否满足就可以解决虚假等待的问题。

条件等待，等于把控制权交给了别的线程，它信任别的线程会在合适的时机通知它，这是多大的信任啊。如果其他线程忘记发送信号了，那么条件等待的线程就彻底“悲剧”了。

如何发送信号来通知等待的线程呢？POSIX 提供了如下两个接口：

```c
int pthread_cond_signal(pthread_cond_t *cond);
int pthread_cond_broadcast(pthread_cond_t *cond);
```

`pthread_cond_signal` 负责唤醒等待在条件变量上的一个线程，`pthread_cond_broadcast`，顾名思义，就是广播唤醒等待在条件变量上的所有线程。

等一下，刚才讲解 `pthread_cond_wait` 的时候曾提到过，线程醒来时会确保持有互斥量，为何广播还能唤醒等待在条件变量上的所有线程呢，不是前后矛盾吗？

答案是不矛盾，所有的线程被广播唤醒了之后，集体争夺互斥锁，没抢到的继续睡。从内核中醒来，然后继续睡去，是一种性能的浪费。

使用通知机制来完成线程同步，代码范例如下：

```c
//为让流程更加清晰,此处忽略了 error handle
pthread_mutex_lock(&m);
/*一些对共享数据的操作,会导致另一个线程等待的条件满足
*/
//此处也可以是 pthread_cond_broadcast 函数
pthread_cond_signal(&cond);
pthread_mutex_unlock(&m);
```

发送信号，通知等待在条件上的线程，然后解锁互斥量。

注意范例代码中先发送信号，然后解锁互斥量，这个顺序不是必须的，也可以颠倒。标准允许任意顺序执行这两个调用。

有什么区别吗？

先通知条件变量、后解锁互斥量，效率会比先解锁、后通知条件变量低。因为先通知后解锁，执行 `pthread_cond_wait` 的线程可能在互斥量已然处于加锁状态的时候醒来，发现互斥量仍然没有解锁，就会再次休眠，从而导致了多余的上下文切换。某些实现使用**等待变形（wait morphing）** 来优化这个问题：并不真正地唤醒执行 `pthread_cond_wait` 的线程，而是将线程从条件变量的等待队列转移到互斥量的等待队列上，从而消除无谓的上下文切换。

glibc 对 `pthread_cond_broadcast` 做了类似的优化，即只唤醒一个线程，将其他线程从条件变量的等待队列搬移到了互斥量的等待队列中。对实现细节感兴趣的可以参阅 Ulrich Drepper 的《Futexes Are Tricky》。

先解锁、后通知条件变量虽然可能会有性能上的优势，但是也会带来其他的问题。如果存在一个高优先级的线程，既等待在互斥量上，也等待在条件变量上；同时还存在一个低优先级的线程，只等待在互斥量上。一旦先解锁互斥量，低优先级的进程就可能会抢先获得互斥量，待调用 `pthread_cond_signal` 之后，高优先级的进程会发现互斥量已经被低优先级的进程抢走了。

> [!INFO] **补充说明**
> 本部分涉及 [[条件变量]]、[[虚假唤醒]]、[[等待变形]] 等概念。条件变量与互斥量配合使用时，务必使用 `while` 循环检查条件，以避免虚假唤醒带来的问题。信号发送与解锁的顺序在某些实现中可能影响性能，但标准允许任意顺序。