# 第11章 进程间通信：POSIX IPC

与System V IPC一样，POSIX IPC也包含三种类型：

- **POSIX消息队列**
- **POSIX信号量**（又分为命名信号量和无名信号量）
- **POSIX共享内存**

POSIX IPC的出现要比System V IPC晚，因此POSIX IPC的设计者可以从容地参照System V IPC，吸收其设计上的长处，规避其设计上的缺点。正是由于POSIX IPC拥有后发优势，所以总体来讲，POSIX IPC要优于System V IPC。

表11-1汇总了POSIX IPC的所有函数。

**表11-1　POSIX IPC函数列表**

| 操作类型 | 消息队列 | 信号量 | 共享内存 |
|----------|----------|--------|----------|
| 创建或打开 | mq_open | sem_open | shm_open |
| 关闭 | mq_close | sem_close | munmap |
| 删除 | mq_unlink | sem_unlink | shm_unlink |

## 11.1　POSIX IPC概述

在POSIX IPC的模型中，对 `open`、`close` 和 `unlink` 等类似函数（见表11-1创建或打开、关闭和删除三行）的使用与传统的Unix文件模型一致，相信理解和操作起来应该很容易。

与打开文件一样，POSIX IPC对象也有引用计数，内核会负责维护IPC对象上的打开引用计数。它所带来的影响是删除POSIX IPC对象的操作比较简单。删除操作仅仅是删除IPC对象的名字，等所有的进程都使用完毕，IPC对象的引用计数变成0之后才真正销毁IPC对象。

### 11.1.1　IPC对象的名字

多个进程之间操作同一个IPC对象，总要有个入口点或线索，以便根据线索找到共同的IPC对象。

对于System V IPC而言，键值就是其线索，只要拿着相同的键值就能找到同一个System V IPC对象（如图11-1所示）。

**图11-1　System V IPC顺藤摸瓜之藤**

对于POSIX IPC来说，可以像操作文件一样操作IPC对象。文件有路径名，同样，IPC对象也有IPC对象的名字。SUSv3标准规定，唯一一种用来标识POSIX IPC对象的可移植方法是使用以斜线打头后面跟着一个或多个非斜线字符的名字，如 `/myobject`。

下面三段代码分别负责创建POSIX消息队列、信号量和共享内存。

```c
/* 创建 POSIX 消息队列 */
mqd_t mqd = mq_open(argv[1], O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR, NULL);
if (mqd == -1)
{
    /* error handle */
}
```

```c
/* 创建 POSIX 信号量 */
sem_t *sem = sem_open(argv[1], O_CREAT | O_EXCL, S_IRUSR | S_IWUSR, 1);
if (sem == SEM_FAILED)
{
    /* error handle */
}
```

```c
/* 创建 POSIX 共享内存 */
int shm_fd = shm_open(argv[1], O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
if (shm_fd == -1)
{
    /* error handle */
}
```

Linux为IPC对象提供了文件系统的访问接口，即可以像操作普通文件一样操作IPC对象。

对于创建出来的共享内存和信号量，Linux将这些对象放到了挂载在 `/dev/shm` 目录处的 `tmpfs` 文件系统中，代码如下所示：

```bash
ll /dev/shm/
total 0
drwxrwxrwt  2 root root  40 Sep 12 05:08 ./
drwxr-xr-x 20 root root 780 Sep 12 04:22 ../
```

创建名为 `abc` 的POSIX共享内存之后：

```bash
./shm_open abc
ll /dev/shm/
total 0
drwxrwxrwt  2 root root  60 Sep 12 05:13 ./
drwxr-xr-x 20 root root 780 Sep 12 04:22 ../
-rw-------  1 manu manu   0 Sep 12 05:13 abc
```

创建名为 `abc` 的POSIX信号量之后：

```bash
./sem_open abc
ll /dev/shm/
total 4
drwxrwxrwt  2 root root  80 Sep 12 05:14 ./
drwxr-xr-x 20 root root 780 Sep 12 04:22 ../
-rw-------  1 manu manu   0 Sep 12 05:13 abc
-rw-------  1 manu manu  32 Sep 12 05:14 sem.abc
```

可以看到，创建一个名为 `name` 的共享内存后，在 `/dev/shm` 目录下就会有一个名为 `name` 的文件。如果创建一个名为 `name` 的信号量，那么在 `/dev/shm` 目录下就会有一个名为 `sem.name` 的文件。

消息队列也可以展现在文件系统中，不过要比共享内存和信号量稍微复杂一些。需要首先将消息队列挂载到文件系统中，方法如下：

```bash
mkdir /dev/mqueue
mount -t mqueue none /dev/mqueue
```

现在可以创建消息队列了。当然如果不将消息队列挂载到文件系统中，并不会影响消息队列的创建，仅仅是无法从文件系统查看消息队列的情况而已。

```bash
ll /dev/mqueue/
total 0
drwxrwxrwt  2 root root   40 Sep 12 05:29 ./
drwxr-xr-x 17 root root 4260 Sep 12 03:57 ../
```

创建一个名为 `/abc` 的POSIX消息队列：

```bash
./mq_open /abc
ll /dev/mqueue/
total 0
drwxrwxrwt  2 root root   60 Sep 12 05:41 ./
drwxr-xr-x 17 root root 4260 Sep 12 03:57 ../
-rw-------  1 manu manu   80 Sep 12 05:41 abc
```

**IPC对象的名字有哪些限制？** 通过测试不难得出以下结论：

- POSIX消息队列的名字必须以 `/` 打头，而且后续字符不允许出现 `/`，否则就返回 `EINVAL` 错误。
- POSIX消息队列的名字中打头的 `/` 字符不计入长度。
- POSIX消息队列名字的最大长度为 `NAME_MAX`（255个字符），若超过则返回 `ENAMETOOLONG` 错误。
- POSIX信号量和共享内存的名字可以以1个或多个 `/` 打头，也可以不以 `/` 打头。
- POSIX信号量和共享内存的名字中，打头的一个或多个 `/` 字符不计入长度。
- POSIX共享内存名字的最大长度为 `NAME_MAX`，POSIX信号量名字的最大长度为 `NAME_MAX - 4`（因为实现会在信号量的名字前面添加 `sem.` 这4个字符）。若超过则返回 `ENAMETOOLONG` 错误。

> [!NOTE]
> 这些结论是从glibc相关函数（`mq_open`、`sem_open` 和 `shm_open`）的角度来分析的，并不是从系统调用的角度来分析的。glibc调用系统调用之前会做一些动作，比如 `mq_open` 函数调用同名系统调用前会去除打头的 `/` 等。

### 11.1.2　创建或打开IPC对象

解决了IPC对象的名字问题，接下来就是创建POSIX IPC对象了。创建或打开，都是由 `open` 系列函数来完成的。后续的操作要作用在 `open` 函数返回的句柄上。

对于POSIX IPC的 `open` 系列函数而言，一般至少包含三个参数 `name`、`oflag` 和 `mode`（见表11-2）。

`name` 前面已经说过，就是POSIX IPC的名字。下面来分析第二个参数打开标志位。

**表11-2　POSIX IPC open中的标志位**

| 标志位 | 含义 |
|--------|------|
| `O_RDONLY` | 只读打开 |
| `O_WRONLY` | 只写打开 |
| `O_RDWR` | 读写打开 |
| `O_CREAT` | 如果对象不存在则创建 |
| `O_EXCL` | 与 `O_CREAT` 一起使用，若对象已存在则报错 |
| `O_NONBLOCK` | 非阻塞模式 |

如果 `oflag` 中指定了 `O_CREAT` 标志位，则需要第三个参数 `mode` 来指定权限，这个权限和文件的权限一样，不外乎 `S_IRUSR`、`S_IWUSR`、`S_IRGRP`、`S_IWGRP`、`S_IROTH` 及 `S_IWOTH` 这6种权限。并且和 `open` 函数一样，`mode` 中的权限会根据进程的 `umask` 取掩码。

打开还是创建，取决于 `oflag` 是否设置了 `O_CREAT` 及 `O_EXCL` 标志位。内在的控制逻辑和System V IPC一致，如表11-3所示。

**表11-3　POSIX IPC O_CREATE和O_EXCL标志位的影响**

| 对象存在 | O_CREAT | O_EXCL | 结果 |
|----------|---------|--------|------|
| 不存在 | 设置 | 忽略 | 创建对象 |
| 存在 | 未设置 | 忽略 | 打开现有对象 |
| 存在 | 设置 | 未设置 | 打开现有对象 |
| 存在 | 设置 | 设置 | 报错（EEXIST） |

### 11.1.3　关闭和删除IPC对象

POSIX IPC对象维护有引用计数，在用完IPC对象后，可以调用相关的 `close` 函数来释放与该对象关联的资源并使引用计数减1。对于消息队列，该函数是 `mq_close`；对于信号量该函数是 `sem_close`。共享内存和前两者略有不同，它通过 `munmap` 解除映射来解除和共享内存的关系。

当进程退出或执行 `exec` 系列函数时，IPC对象会自动关闭。

正是因为POSIX IPC对象有引用计数，所以删除的时候比较方便。对应的 `unlink` 操作会删除对象的名字，直到所有进程使用完毕，关闭了对象或解除了映射关系之后，才会真正销毁。

因为Linux提供了文件系统访问方式，因此完全可以在文件系统中执行 `ls` 或 `rm` 操作来查看或删除IPC对象。细心的读者可以看出存放IPC对象的目录都设置了粘滞位，这是用来保护目录下的文件的，即对于非特权进程只能删除它自己拥有的POSIX IPC对象。

```bash
ll /dev/shm/
total 0
drwxrwxrwt  2 root root  40 Sep 12 07:08 ./
ll /dev/mqueue/
total 0
drwxrwxrwt  2 root root   40 Sep 12 07:08 ./
```

### 11.1.4　其他

与System V IPC相比，POSIX有很多优势。后面介绍POSIX IPC的每一种通信手段的时候，都会与System V IPC对应的手段进行比较。但POSIX IPC也有明显的劣势——可移植性。因为System V出现得早，几乎所有的Unix平台都支持System V IPC。但是如果专注于Linux平台的话，这个问题就不存在了。

2.6.6之后的内核版本，三种POSIX IPC手段就已经齐备。而主流在用的Linux版本很少有低于2.6.6的。

编译使用POSIX IPC的程序时需要注意以下两点。

- 当使用消息队列和共享内存的时候，需要和实时库 `librt` 链接起来。`cc` 命令中需指定 `-lrt`。
- 当使用信号量的时候，需要和线程库 `libpthread` 链接起来。`cc` 命令中需指定 `-lpthread`。

示例代码如下所示：

```bash
gcc -o mq_open mq_open.c -lrt
gcc -o shm_open shm_open.c -lrt
gcc -o sem_open sem_open.c -lpthread
```

## 11.2　POSIX消息队列

POSIX消息队列与System V消息队列有一定的相似之处，信息交换的基本单位是消息，但也有显著的区别。

最大的区别当属在Linux实现里POSIX消息队列的句柄本质是文件描述符。这个性质给POSIX消息队列带来了巨大的优势。因为是文件描述符，所以可以使用I/O多路复用系统调用（`select`、`poll` 或 `epoll` 等）来监控这个文件描述符。

其次，POSIX消息队列提供了通知功能，当消息队列中有消息可用时，就会通知到进程。而System V消息队列没有通知功能，所以消息队列上何时有消息进程无从得知，只能阻塞（`msgrcv`）或轮询（带 `IPC_NOWAIT` 标志位的 `msgrcv`）。

最后，System V消息队列的消息提取要比POSIX消息队列灵活。POSIX消息队列本质是个优先级队列。而System V消息中存在类型字段，可以提取类型等于某值的消息，这点POSIX消息队列是做不到的。这个优势让System V消息队列在与POSIX消息队列的对决中，稍稍挽回一点颜面。

### 11.2.1　消息队列的创建、打开、关闭及删除

之所以在本节介绍三个接口，是因为POSIX消息队列的接口和操作文件的接口非常类似。

消息队列的 `mq_open` 函数如同操作文件的 `open` 函数，用于创建或打开一个消息队列，其接口定义如下：

```c
#include <fcntl.h>
#include <sys/stat.h>
#include <mqueue.h>

mqd_t mq_open(const char *name, int oflag);
mqd_t mq_open(const char *name, int oflag, mode_t mode,
              struct mq_attr *attr);
```

`oflag` 允许的标志位包括 `O_RDONLY`、`O_WRONLY`、`O_RDWR`、`O_CREAT`、`O_EXCL` 及 `O_NONBLOCK`。

除了 `O_NONBLOCK` 标志位，其他都是老朋友了，不必赘述，这里单提一下 `O_NONBLOCK`。如果打开消息队列时，没有设置 `O_NONBLOCK` 标志位，那么后续的 `mq_send` 调用和 `mq_receive` 调用就可能会陷入阻塞。反之，如果打开消息队列时设置了该标志位，发送消息或接受消息若不能立刻返回，则立刻返回失败，并置 `errno` 为 `EAGAIN`，而不会陷入阻塞。

第三个参数 `mode` 和第四个参数 `attr` 只有在创建消息队列的时候才有意义。如果仅仅是打开消息队列，则无需这两个参数。`mode` 设置的是访问权限，`attr` 设置的是消息队列的属性。在介绍 `mq_getattr` 函数和 `mq_setattr` 函数时会展开说明。默认情况下，第四个参数可以传递 `NULL`，表示创建默认属性的消息队列。

当 `mq_open` 调用成功时则返回一个 `mqd_t` 类型的消息队列描述符。对于Linux平台而言，这就是一个 `int` 型数字，其实这个数字和 `open` 函数返回的文件描述符本质上是一样的，从内核的 `ipc/mqueue.c` 中 `mq_open` 系统调用的实现就可以看出：

```c
SYSCALL_DEFINE4(mq_open, const char __user *, u_name, int, oflag, mode_t, mode, struct mq_attr __user *, u_attr)
{
    ...
    fd = get_unused_fd_flags(O_CLOEXEC);
    ...
    return fd;
}
```

在 `/proc/PID/fd` 目录下，也可以看到消息队列对应的文件描述符：

```bash
./mq_open /abc
ll /proc/2925/fd
...
lrwx------ 1 manu manu 64 Sep 13 09:04 3 -> /abc
```

一个进程允许打开多少个消息队列？标准并没有严格限定，这点是由具体的实现来决定的。SUSv3标准要求这个限制最小为 `_POSIX_MQ_OPEN_MAX`（8）。Linux没有定义这个限制。相反因为消息描述符被实现成了文件描述符，因此其必须遵循文件描述符的限制。

进程允许打开的消息队列个数是否仅仅受限于进程打开的最大文件个数？事实上并非如此。资源限制中有一项 `RLIMIT_MSGQUEUE`，用于限制用户在POSIX消息队列中可以分配的最大字节数。在下一节介绍POSIX消息队列的属性时，会重点介绍该限制对允许打开的消息队列个数的影响。

调用 `fork` 之后，子进程也获得了消息队列描述符的副本，这个副本会引用同样的打开的消息队列。调用 `exec` 之后，由于内核实现中消息队列的描述符自动带有 `O_CLOEXEC` 标志位，所以其打开的消息队列会被自动关闭。

当进程退出时，所有打开的消息队列都会被关闭。

`mq_close` 函数用于关闭消息队列描述符，这个函数和关闭文件的 `close` 函数十分类似：

```c
#include <mqueue.h>
int mq_close(mqd_t mqdes);
```

如果进程已经注册了消息通知，那么消息通知也会被删除。因为任一时刻，只能有一个进程向特定消息队列注册并接收消息通知，因此删除消息通知后，其他进程就能注册消息通知了。

POSIX消息队列也具有内核持久性，纵然打开该消息队列的所有进程都执行了 `mq_close`，消息队列的引用计数已变为0，但只要不显式地调用 `mq_unlink`，该队列及队列上的消息依然存在。要销毁消息队列，需要调用 `mq_unlink` 函数，代码如下：

```c
#include <mqueue.h>
int mq_unlink(const char *name);
```

下面通过两个测试程序来学习消息队列的创建。

**第一个小程序**是用来创建消息队列的，如果传入了 `-e` 选项，则表示创建时要加上 `O_EXCL` 标志位：

```c
#include <mqueue.h>
#include <stdio.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

int main(int argc, char *argv[])
{
    int c, flags;
    mqd_t mqd;
    flags = O_RDWR | O_CREAT;
    while ((c = getopt(argc, argv, "e")) != -1)
    {
        switch (c)
        {
        case 'e':
            flags |= O_EXCL;
            break;
        }
    }
    if (optind != argc - 1)
    {
        fprintf(stderr, "usage: mqcreate [-e] <name>\n");
        return -1;
    }
    mqd = mq_open(argv[optind], flags, S_IRUSR | S_IWUSR, NULL);
    if (mqd == -1)
    {
        fprintf(stderr, "mq_open failed (%s)\n",
                strerror(errno));
        return -2;
    }
    mq_close(mqd);
    return 0;
}
```

**第二个小程序**是用来删除POSIX消息队列的：

```c
#include <mqueue.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

int main(int argc, char *argv[])
{
    if (argc != 2)
    {
        fprintf(stderr, "usage mqunlink <name>\n");
        return -1;
    }
    int ret = mq_unlink(argv[1]);
    if (ret != 0)
    {
        fprintf(stderr, "mq_unlink failed (%s)\n",
                strerror(errno));
        return -2;
    }
    return 0;
}
```

Linux下POSIX提供了 `mqueue` 类型的虚拟文件系统，可以通过挂载，很方便地使用 `ls` 和 `rm` 来列出或删除POSIX消息队列。

可以通过如下命令将消息队列挂载到文件系统：

```bash
mount -t mqueue source target
```

其中 `source` 可以为 `none`，`target` 是挂载点。比如可以通过如下命令挂载消息队列：

```bash
mkdir /dev/mqueue
mount -t mqueue none /dev/queue
```

使用第一个程序编译出 `mqcreate` 二进制程序，使用第二个程序编译出 `mqunlink` 二进制程序，可以做如下试验：

```bash
./mqcreate /abcd
ll /dev/mqueue
总用量 0
-rw------- 1 manu manu 80  3月  9 22:26 abcd
cat /dev/mqueue/abcd
QSIZE:0          NOTIFY:0     SIGNO:0     NOTIFY_PID:0
```

可以看出，通过 `mqcreate` 创建出来的消息队列，可以通过 `ls /dev/mqueue` 来查看，甚至可以通过 `cat /dev/mqueue/queue_name` 来获取消息队列的信息。

## 11.2.2　消息队列的属性

介绍 `mq_open` 函数时曾提到，第四个参数是 `mq_attr` 类型的，表示消息队列的属性。创建时可以指定消息队列的属性，POSIX 消息队列也提供了 `mq_setattr` 函数来改变消息队列的属性。

在继续讨论之前，首先需要了解消息队列有哪些属性，`mq_attr` 结构体中定义了以下成员：

```c
struct mq_attr {
    long mq_flags;
    long mq_maxmsg;
    long mq_msgsize;
    long mq_curmsgs;
}
```

这个结构体定义在 `<mqueue.h>` 文件中：
- `mq_flags`：0 或设置了 `O_NONBLOCK`。
- `mq_maxmsg`：消息队列中的最大消息个数。
- `mq_msgsize`：单条消息允许的最大字节数。
- `mq_curmsgs`：消息队列当前的消息个数。

如果调用 `mq_open` 函数创建 POSIX 消息队列时，第四个参数为 `NULL`，那么将使用默认属性。可以使用如下代码来获取默认属性：

```c
int ret = mq_getattr(mqd, &attr);
if (ret != 0) {
    fprintf(stderr, "failed to get attr(%d: %s)\n", errno, strerror(errno));
    return 2;
}
fprintf(stdout, "the default mq_maxmsg = %ld\nthe default mq_msgsize = %ld\n",
        attr.mq_maxmsg, attr.mq_msgsize);
```

其输出如下：

```
the default mq_maxmsg = 10
the default mq_msgsize = 8192
```

从输出可以看出，默认情况下，消息队列的最大消息数为 10，单条消息的最大字节数为 8192 字节。

其中消息队列的最大消息数的默认值 10 记录在如下位置：

```
cat /proc/sys/fs/mqueue/msg_default
10
```

单条消息的最大字节数的默认值 8192 记录在如下位置：

```
cat /proc/sys/fs/mqueue/msgsize_default
8192
```

消息队列中只能存放 10 条消息，这明显太少了，此外单条消息的最大字节数 8192 可能也无法满足我们的需要。因此创建消息队列的时候需要定制属性，定制方法如下所示：

```c
attr.mq_maxmsg = atoi(argv[2]);
attr.mq_msgsize = atoi(argv[3]);
mqd_t mqd = mq_open(argv[1], O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR, &attr);
if (mqd == -1) {
    fprintf(stderr, "failed to get mqueue (%d: %s)\n", errno, strerror(errno));
    return 1;
}
```

但是消息队列的最大消息数和单条消息的最大字节数并不能被随意指定。它受限于多个控制选项。

对于普通用户（非特权用户）而言，内核提供了两个控制选项：

```
cat /proc/sys/fs/mqueue/msg_max
10
cat /proc/sys/fs/mqueue/msgsize_max
8192
```

这两个值分别是最大消息数的上限和单条消息最大字节数的上限。普通用户在定制消息队列属性的时候不能超越这个上限。这两条限制是针对普通用户而言的，对于特权用户而言可以忽视这两条限制。

很明显，这个上限值并不大，特权用户可以调整这两项的值：

```
sysctl -w fs.mqueue.msg_max=4096
fs.mqueue.msg_max = 4096
sysctl -w fs.mqueue.msgsize_max=65536
fs.mqueue.msgsize_max = 65536
```

但是不能随意设置上限值，对于 `/proc/sys/fs/mqueue/msg_max`，系统提供了硬上限 `HARD_MSGMAX`，见表 11-4。

> 表 11-4 消息队列最大消息数的硬上限（原文表格内容缺失，此处保留占位）

对于 `/proc/sys/fs/mqueue/msgsize_max`，系统也提供了硬上限，见表 11-5。

> 表 11-5 消息队列中单条消息最大字节数的硬上限（原文表格内容缺失，此处保留占位）

通过调整对应的控制选项，可以让消息队列容纳更多的消息，或者让每条消息可以容纳更多的内容。

可是事实上，除了上述控制选项外，还存在其他限制。如果调整 `msg_max` 控制选项到 4096，调整 `msgsize_max` 控制选项到 65536 字节，那么可以创建出能容纳 4096 条消息，每条消息的最大长度为 64 字节的消息队列；也可以创建出只容纳两条消息，每条消息最大长度为 65536 字节的消息队列。但是无法创建出既可以容纳 4096 条消息，每条消息的最大长度又为 65536 字节的消息队列。这表明除了上述两条控制外，还存在其他限制。

该限制就是介绍 `mq_open` 时提到的 `RLIMIT_MSGQUEUE`。`RLIMIT_MSGQUEUE` 属于资源限制的范畴。它限制了用户可以在 POSIX 消息队列中分配的最大字节数。注意不是单个消息队列的最大字节数，也不是一个进程能分配的最大字节数，而是该用户创建的所有的消息队列的最大字节数。如果新建消息队列会导致所有消息队列的字节数超出此限制，那么调用 `mq_open` 函数时会返回 `EMFILE` 错误。

> [!NOTE]
> Robert Love 大师在《Linux 系统编程》中提到的返回 `ENOMEM` 是错误的。

`RLIMIT_MSGQUEUE` 默认为 819200 字节，可以通过如下指令来查看：

```
ulimit -q
819200
```

我曾经遇到这样一个问题：当我在 Ubuntu 12.04 上创建第 10 个默认属性的 POSIX 消息队列时，会返回 `EMFILE` 错误，这说明默认情况下最多只能创建 9 个消息队列。下面来细细分析这个场景。

默认情况下，单个消息队列最多有 10 条消息，每条消息的最大字节数为 8192。这就意味着该消息队列满载的时候，会占用 81920 字节。

按照 `RLIMIT_MSGQUEUE` 的含义，应该可以创建 10 个消息队列，可是为什么却只能创建 9 个默认属性的消息队列呢？

原因是消息队列消耗的空间，不能仅仅计算消息体（payload），还要考虑额外的开销。可以从内核的 `mqueue_get_inode` 函数中找到答案。

```c
/* mq_msg_tblsz 是额外的开销 */
mq_msg_tblsz = info->attr.mq_maxmsg * sizeof(struct msg_msg *);
info->messages = kmalloc(mq_msg_tblsz, GFP_KERNEL);
if (!info->messages)
    goto out_inode;
/* mq_bytes 是消息队列真正消耗的空间 */
mq_bytes = (mq_msg_tblsz +
           (info->attr.mq_maxmsg * info->attr.mq_msgsize));
spin_lock(&mq_lock);
if (u->mq_bytes + mq_bytes < u->mq_bytes ||
    u->mq_bytes + mq_bytes > task_rlimit(p, RLIMIT_MSGQUEUE)) {
    spin_unlock(&mq_lock);
    /* mqueue_evict_inode() releases info->messages */
    ret = -EMFILE;
    goto out_inode;
}
```

从上面的代码不难看出，一个消息队列消耗的总空间为：

```
bytes = (attr.mq_msgsize + sizeof(struct msg_msg*)) * attr.mq_maxmsg
```

因此当 `RLIMIT_MSGQUEUE` 的值为 819200 字节时，单个用户是无法创建出 10 个默认属性的消息队列的。

> [!NOTE]
> 上述计算消息队列消耗空间的计算公式仅仅适用于某些内核版本，并不能当成绝对的公式。对于不同的内核版本，需要查看内核的 `mqueue_get_inode` 函数来确定。对这个话题感兴趣的可以参阅内核开发邮件列表中的 *Document POSIX MQ/proc/sys/fs/mqueue files* 话题。链接为：https://lkml.org/lkml/2014/9/29/116

要想让消息队列中容纳足够多的消息，每条消息也足够大，那就需要同时修改 `RLIMIT_MSGQUEUE` 的值。可以通过 `ulimit` 命令来修改，也可以通过 `setrlimit` 函数来修改。

消息队列创建以后可以通过调用 `mq_setattr` 来修改属性，相关接口定义如下：

```c
#include <mqueue.h>
int mq_getattr(mqd_t mqdes, struct mq_attr *attr);
int mq_setattr(mqd_t mqdes, struct mq_attr *newattr,
               struct mq_attr *oldattr);
```

对于 `mq_maxmsg` 和 `mq_msgsize` 这两个属性，在消息队列创建的时候，就已经确定下来了，虽然提供有 `mq_setattr` 函数，但是该函数并不能修改这两个属性。

该函数可以改变的属性只有第一个 `mq_flags`，即可以通过改变 `O_NONBLOCK` 标志位来确定是否置位。其他的属性均不可以修改。改变 `O_NONBLOCK` 属性的方法如下：

```c
mq_getattr(mqd, &attr);
attr.mq_flags |= O_NONBLOCK;  /* 设置 O_NONBLOCK 属性 */
// attr.mq_flags &= (~O_NONBLOCK); /* 取消 O_NONBLOCK 属性 */
mq_setattr(mqd, &attr, NULL);
```

## 11.2.3　消息的发送和接收

### 1. 发送消息

POSIX 消息队列发送消息和接收消息的接口都很容易理解，从易用性的角度来讲，它们要优于 System V 消息队列的对应接口。

发送消息的接口定义如下：

```c
#include <mqueue.h>
int mq_send(mqd_t mqdes, const char *msg_ptr,
            size_t msg_len, unsigned msg_prio);
```

第三个参数 `msg_len` 表示消息体的长度，长度为 0 也是合法的，最大不得超过 `mq_msgsize`。如果消息体太大，则会返回失败，并置 `errno` 为 `EMSGSIZE`。

第四个参数为消息的优先级，是一个非负的整数。那么问题就来了，容许优先级最大为多少？在 Linux 中，这个上限为 32768。

```c
#define MQ_PRIO_MAX     32768
```

如果消息队列已满，`mq_send` 函数可能会阻塞。如果设置了 `O_NONBLOCK` 标志位，这种情况下 `mq_send` 函数会返回失败，`errno` 被置为 `EAGAIN`。

### 2. 接收消息

接收消息的接口定义如下：

```c
ssize_t mq_receive(mqd_t mqdes, char *msg_ptr,
                   size_t msg_len, unsigned *msg_prio);
```

对于 POSIX 消息队列而言，总是取走优先级最高的消息中最先到达的那个。

第二个参数 `msg_ptr` 指针用于存放消息体的内存缓冲区的地址，第三个参数 `msg_len` 是该内存缓冲区的大小。因为消息体的长度是不确定的，所以该缓冲区的大小不得小于最大消息体的长度（`mq_msgsize`），否则一旦消息体长度超过缓冲区的大小，就会失败，并返回 `EMSGSIZE` 错误。如何获得消息队列的最大消息长度？通过 `mq_getattr` 函数！

如果第四个参数 `msg_prio` 不是 `NULL`，那么系统就将取到的消息体的优先级复制到 `msg_prio` 指向的整型变量。第四个参数如果为 `NULL`，则表示压根不在乎消息体的优先级。

如果调用 `mq_receive` 函数时，消息队列中并没有消息，则函数陷入阻塞。如果设置了 `O_NONBLOCK` 标志位，则立即返回失败，并设置 `errno` 为 `EAGAIN`。

POSIX 消息队列的本质就是个优先级队列。优先级高的消息总是被优先取出。从这个角度上看，System V 消息队列更灵活，它可以让各个进程选取自己感兴趣的消息。

## 11.2.4　消息的通知

对于 System V 消息队列，当消息队列里面有消息到来时，消息队列却无法通知其他进程来取。对于消息队列中消息的消费者而言，只有两条路径：
- 调用 `msgrcv` 函数，阻塞于此，直到消息队列里面有消息。
- 调用 `msgrcv` 函数时设置 `IPC_NOWAIT` 标志位，周期性轮询。

从编程的角度看，期待有这样一种机制来解决上述困境：空的消息队列一收到消息，就给相应进程发出通知，被通知的进程收到通知后就可以及时地处理消息。这种机制称为异步通知机制。POSIX 消息队列就引入了这种机制。

POSIX 消息队列提供了两种异步通知的方法可供选择：
- 产生一个信号。
- 创建一个线程来执行一个事先指定的函数。

如果一个进程非常关心 POSIX 消息队列上出现的消息，那么该进程可以通过调用 `mq_notify` 函数来表示密切关注。

```c
#include <mqueue.h>
int mq_notify(mqd_t mqdes, const struct sigevent *sevp);
```

`mq_notify` 函数的含义是调用进程通过该接口注册到消息队列，当空消息队列中出现一条消息时，消息队列就会通知到注册进程，也可以通过该接口注销调用进程曾经的注册。手册中英文描述更加准确：

> `mq_notify()` allows the calling process to register or unregister for delivery of an asynchronous notification when a new message arrives on the empty message queue referred to by the descriptor mqdes.

关于消息通知，有以下几个注意事项：
- 只能有一个进程注册到特定的消息队列。如果一个消息队列上已经有注册进程了，那么后续调用 `mq_notify` 来注册的进程会返回 `EBUSY` 错误。
- 只有在消息进入空消息队列的情况下，才会向注册进程发送通知。如果注册时，消息队列非空，那么只有当消息队列被清空后，又有一条消息到达时，才会发出通知。
- 消息队列向注册进程发出通知后，会删除注册信息。之后任何进程都可以通过调用 `mq_notify` 函数来注册到消息队列，并接收通知了。
- 只有在当前不存在其他进程因在该队列上调用 `mq_receive()` 而陷入阻塞时，注册进程才会收到消息通知。否则阻塞在 `mq_receive()` 上的进程会“截胡”，读取该信息，而注册进程依然保持注册状态。
- 进程可以通过在调用 `mq_notify` 函数时传入一个值为 `NULL` 的 `sevp` 参数来撤销自己在消息队列上的注册信息。

前面讨论了消息通知的基本流程，但是当消息队列满足通知的条件时，又是如何通知到注册进程的？

`mq_notify` 函数的关键在第二个入参上，其结构体包含如下参数，若记不清成员变量，则可以通过 `man sigevent` 来查看手册。

```c
union sigval {
    int sigval_int;
    void *sigval_ptr;
};

struct sigevent {
    int sigev_notify;                    /* 决定采用哪种通知方法,信号还是线程 */
    int sigev_signo;                     /* 用于信号方式,决定发送哪个信号 */
    union sigval sigev_value;            /* 信号方式和线程方式都有其独特含义 */
    void  (*sigev_notify_function)(union sigval);
    void  *sigev_notify_attributes;
};
```

结构体 `sigevent` 的第一个成员 `sigev_notify` 用于选择采用哪种方式来通知注册进程，其有效值有以下三个：
- `SIGEV_NONE`：当消息到达空的消息队列时，不采取任何通知行动。
- `SIGEV_SIGNAL`：采用发送信号的方式通知进程。
- `SIGEV_THREAD`：通过调用 `sigev_notify_function` 中指定的函数来通知进程，就如同在一个新的线程中启动该函数一样。

下面将分别介绍后两种方法。

### 1. 信号通知

如果采用信号方式（`SIGEV_SIGNAL`），那么调用 `mq_notify` 的进程需要约定好希望收到哪种信号，其实现一般如下所示：

```c
struct sigevent sev;
sev.sigev_notify = SIGEV_SIGNAL;
sev.sigev_signo = SIGUSR1;
if (mq_notify(mqd, &sev) == -1) /* mqd 为消息队列描述符 */
{
    /* error handler */
}
```

调用 `mq_notify` 函数的进程需要考虑该如何处理随时可能到来的信号。

最容易想到的方法就是，在信号处理函数中，调用 `mq_receive` 函数，并进一步处理消息。很不幸的是，这种方法行不通。第 6 章讲信号时提到过，大多数函数都不是异步信号安全的，`mq_receive` 函数也不是异步信号安全函数。更何况，还要在信号处理函数中执行复杂的逻辑，这就如同行驶在暗礁丛生的水域，很容易触礁沉船，这种做法是不明智的。

等待信号来临不外乎有以下三种方法：
- `sigsuspend`
- `sigwait`
- `signalfd`

《Linux/Unix 系统编程手册》给出了使用 `sigsuspend` 函数来等待信号并处理消息的一个例子，而这里我们来介绍下第二种方法，使用 `sigwait` 函数来等待信号的来临并处理消息。

在第 6 章中提到过，`sigwait` 函数的引入，解决了信号的异步带来的很多问题。可以说这个函数提供了一种同步的方式来等待信号的降临。

```c
#include <signal.h>
int sigwait(const sigset```c
int sigwait(const sigset_t *set, int *sig);
```

将要等待的信号放置到 `set` 中,`sigwait` 函数调用就会被阻塞,直到 `set` 集合中的某个信号处于未决状态,`sigwait` 函数才会返回,信号的值记录在 `sig` 指针指向的整型变量中.需要注意的一点是,调用 `sigwait` 函数之前,`set` 中的所有信号都要被阻塞,否则结果是不可预知的.

以 `SIGUSR1` 为例,我们调用 `mq_notify` 函数,使消息降临空队列时,发送信号 `SIGUSR1`,主流程等待 `SIGUSR1`,收到信号时,去消息队列中取出该消息,整个流程如下:

```c
mqd_t mqd;
struct mq_attr attr;
sigset_t newmask;
struct sigevent sigev;

mqd = mq_open(mq_filename, O_RDONLY | O_NONBLOCK);
mq_getattr(mqd, &attr);
buffer = malloc(attr.mq_msgsize); /* 确保 buffer 足够大 */

sigemptyset(&newmask);
sigaddset(&newmask, SIGUSR1);
sigprocmask(SIG_BLOCK, &newmask, NULL); /* 阻塞等待的信号 */

sigev.sigev_notify = SIGEV_SIGNAL;
sigev.sigev_signo = SIGUSR1;
mq_notify(mqd, &sigev);

for (;;) {
    sigwait(&newmask, &signo); /* 等待 SIGUSR1 信号 */
    if (signo == SIGUSR1) {
        mq_notify(mqd, &sigev); /* 先重新注册 notify 函数 */
        while ((n = mq_receive(mqd, buffer, attr.mq_msgsize, NULL)) >= 0) {
            /* process the message in buffer */
        }
        if (errno != EAGAIN) {
            /* some error happened */
        }
    }
}
```

需要注意的是,`mq_notify` 函数注册之后,一旦发出信号完成使命,要想继续使用这种通知机制,需要再次调用 `mq_notify` 函数重新注册.

使用 `sigsuspend` 函数和 `sigwait` 函数虽然都可以等到信号的来临,但是也阻塞了当前进程,这并不是明智的做法.更合理的做法是使用 `signalfd` 机制,配合 `select`、`poll` 或 `epoll` 等多路复用的接口,实现真正的事件驱动编程.

### 2. 通过线程处理消息

POSIX 消息队列提供的另外一种方法就是创建线程,执行预先约定的函数.

在使用中,需要将 `sigev.sigev_notify` 设置成 `SIGEV_THREAD`,同时设置好线程应该执行的函数,即将 `sigev.sigev_notify_function` 设置成约定好的函数.如果线程函数需要入参,则可以将任何变量的地址填入 `sigev.sigev_value.sival_ptr` 中,达到传递参数的目的.

创建的线程具有默认的属性.如果对于线程有特殊的要求,则可以通过如下方法来设置:

```c
pthread_attr_t thread_attr;
pthread_attr_init(&thread_attr);
pthread_attr_setdetachstate(&thread_attr, PTHREAD_CREATE_DETACHED);
sigev.sigev_notify_attributes = &thread_attr;
```

整体代码流程如下(示意代码,不完整):

```c
static void notify_function(union sigval sv)
{
    struct mqd_t *mqdp = sv.sival_ptr;
    mq_getattr(*mqdp, &attr);
    buffer = malloc(attr.mq_msgsize); /* 确保 buffer 足够大 */
    notify_setup(mqdp); /* 再次注册 */
    while ((n = mq_receive(*mqdp, buffer, attr.mq_msgsize, NULL)) >= 0) {
        /* 处理 buffer 中的消息体 */
    }
    if (errno != EAGAIN) {
        /* 发生错误 */
    }
    free(buffer);
}

static void notify_setup(mqd_t *mqdp)
{
    struct sigevent sig_ev;
    sig_ev.sigev_notify = SIGEV_THREAD;
    sig_ev.sigev_notify_function = notify_function;
    sig_ev.sigev_notify_attributes = NULL;
    sig_ev.sigev_value.sival_ptr = mqdp;
    mq_notify(*mqdp, &sig_ev);
}

int main()
{
    mqd = mq_open(mqfilename, O_RDONLY | O_NONBLOCK);
    notify_setup(&mqd);
    for (;;) {
        pause();
    }
}
```

和信号通知机制一样,一旦创建线程执行完毕,通知机制就结束了,需要重新调用 `mq_notify` 函数来注册.

## 11.2.5 I/O 多路复用监控消息队列

POSIX 消息队列的通知功能或许在其他 Unix 平台上非常有用,但是在 Linux 平台下用处并不大,因为在 Linux 平台下有更友好、更强大的方法.

在 Linux 系统中,消息队列描述符被实现成了文件描述符,因此完全可以使用 I/O 多路复用系统调用来监控消息队列.这种方法非常自然.

《Unix 网络编程卷 2:进程间通信》的 5.6.6 节给出了一个例子,如何使用 `select` 来监控 POSIX 消息队列.由于在某些平台下,消息队列描述符并不是文件描述符,所以不能直接使用 `select`.Stevens 大师给出的方法就相当地绕,具体方法如下:

首先使用 `mq_notify` 函数来注册,确保当空的消息队列中出现消息时,进程会收到信号 `SIGUSR1`;其次进程打开了一个管道,进程调用 `select` 监听管道的读取端;在 `SIGUSR1` 的信号处理函数中负责往管道的写入端写入一个字符.这样当消息降临空消息队列时,整个的逻辑流程就如图 11-2 所示.

> ![图 11-2 APUE 中监听消息队列的流程](此处原图缺失,描述为:信号触发 -> 信号处理函数中写管道 -> select 检测到管道可读 -> 读取消息队列)

该方案如此拧巴绝非大师之过,在操作系统不支持的情况下,只能如此处理.因为 Linux 支持在消息队列上执行 `select`/`poll`/`epoll`,所以可以让这条路变得一马平川(如图 11-3 所示).

> ![图 11-3 Linux 下监听消息队列的流程](此处原图缺失,描述为:消息到达 -> select 检测到消息队列描述符可读 -> 直接读取消息队列)

代码形式如下所示:

```c
mqd = mq_open(argv[1], O_RDONLY | O_NONBLOCK);
if (mqd == -1) {
    fprintf(stderr, "failed to open mqueue (%d: %s)\n", errno, strerror(errno));
    return 1;
}
mq_getattr(mqd, &attr);
buffer = malloc(attr.mq_msgsize);

FD_ZERO(&rset);
for (;;) {
    FD_SET(mqd, &rset);
    nfds = select(mqd + 1, &rset, NULL, NULL, NULL);
    if (FD_ISSET(mqd, &rset)) {
        while ((n = mq_receive(mqd, buffer, attr.mq_msgsize, NULL)) >= 0) {
            /* 在此处处理本条消息 */
        }
        if (errno != EAGAIN) {
            /* 发生错误，进行错误处理 */
        }
    }
}
```

注意上面的例子比较简易,仅仅是监听了一个消息队列,根据实际情况,可以同时监听多个消息队列和多个文件.只需要在上面代码的基础上打开其他文件或消息队列,将这些文件描述符置于 `select` 的监控之下,如果有来自文件描述符的输入(`FD_ISSET` 来判断),添加相应的处理函数即可.

这条特性并不是标准规定的,标准并未规定将消息队列描述符实现为文件描述符,因此使用 I/O 多路复用系统调用监控消息队列并不具备可移植性.尽管如此,个人还是认为本条性质是 POSIX 消息队列最重要的性质,和 System V 消息队列相比,本条性质给 POSIX 消息队列带来了压倒性的优势.

# 第11章 进程间通信:POSIX IPC

## 11.3 POSIX信号量

POSIX信号量和System V信号量的作用是相同的,都是用于同步进程之间及线程之间的操作,以达到无冲突地访问共享资源的目的.

在前面介绍System V信号量的时候也曾介绍过,Edsger Dijkstra提出了PV操作.所谓P操作,代表荷兰语中的Proberen(意思是尝试),也被称为递减操作或上锁操作.在POSIX术语中为等待(wait).所谓V操作代表荷兰语单次Verhogen(意思是增加),也被称为递增操作、解锁操作和发信号(signal)操作.在POSIX术语中为挂出(post).

POSIX信号量的作用和System V信号量是一样的.但是两者在接口上有很大的区别:

- POSIX信号量将创建和初始化合二为一,这就解决了System V中可能出现竞争条件的问题.
- POSIX信号量的修改信号量值的接口(`sem_post`和`sem_wait`),一次只能修改一个信号量.与之对应的System V信号量其本质是信号量集,其下的`semop`函数一次可以修改多个信号量.
- POSIX信号量的修改信号量值的接口(`sem_post`和`sem_wait`),一次只能将信号量的值加1或减1.与之对应的System V信号量的`semop`函数,能够加上或减去一个大于1的值.
- POSIX信号量并没有提供一个等待信号量变为0的接口,而System V信号量中,`semop`函数则提供了这样的接口.
- POSIX信号量并没有提供UNDO操作,而System V信号量则提供了这样的操作.

从表面看,System V信号量的能力完胜POSIX信号量,事实上并非如此.System V信号量有过度设计之嫌,在大部分场景下,System V提供的第2、3和4条特性都没有什么用处,反而徒增接口的复杂程度.而POSIX信号量提供的接口异常清晰,易于理解和使用.

POSIX信号量真正比System V信号量优越的地方在于,POSIX信号量性能更好.对于System V信号量而言,每次操作信号量,必然会从用户态陷入内核态,可以想象当加锁和解锁操作比较频繁的时候,时间上的开销也是很可观的.POSIX信号量则不然.只要不存在真正的两个线程争夺一把锁的情况,那么修改信号量就只是用户态的操作,并不会牵扯到内核.在竞争并不激烈的情况下,POSIX的性能要远远高于System V信号量.

有得必有失.因为POSIX信号量不会每次操作都去求助内核,所以获得了性能上的提升,但却因此而失去了内核的强大后援.System V信号量支持UNDO操作,当用户进程异常消亡之后,内核会肩负起为进程还债的责任.但是POSIX信号量却没有这个特性.

POSIX提供了两类信号量:有名信号量和无名信号量.这两种信号量的本质都是一样的,从图11-4可以看出,最重要的`sem_wait`接口和`sem_post`接口也都是一样的.如此说来,两种信号量有何不同呢,各自应用在哪些场景呢?

> [!figure] 图11-4 有名信号量和无名信号的接口
> (原图描述了两类信号量的接口关系:`sem_open`、`sem_close`、`sem_unlink`、`sem_init`、`sem_destroy`分别通向`sem_wait`、`sem_trywait`、`sem_timedwait`、`sem_post`、`sem_getvalue`等公共操作接口.)

无名信号量,又称为基于内存的信号量,由于其没有名字,没法通过open操作直接找到对应的信号量,所以很难直接用于没有关联的两个进程之间.无名信号量多用于线程之间的同步.

有名信号量由于其有名字,多个不相干的进程可以通过名字来打开同一个信号量,从而完成同步操作,所以有名信号量的操作要方便一些,适用范围也比无名信号量更广.

下面将分别介绍这些接口.

### 11.3.1 创建、打开、关闭和删除有名信号量

创建或打开有名信号量,需要调用`sem_open`函数,其接口定义如下:

```c
#include <fcntl.h>
#include <sys/stat.h>
#include <semaphore.h>

sem_t *sem_open(const char *name, int oflag);
sem_t *sem_open(const char *name, int oflag,
                mode_t mode, unsigned int value);
```

第二个参数`oflag`标志位支持的标志包括`O_CREAT`和`O_EXCL`标志位.如果带了`O_CREAT`标志位,则表示要创建信号量.

`mode`表示创建的新信号量的访问权限,标志位和`open`函数一样,`mode`参数的值也会根据进程的`umask`来取掩码.

`value`是新建信号量的初始值.创建和赋初值都是由一个接口来完成的,这样就不会出现System V信号量可能出现的初始化竞争的问题了.`value`的值在最小值0和最大值`SEM_VALUE_MAX`之间.SUSv3要求最大值至少等于32767,对于Linux而言,这个限制为`INT_MAX`(在Linux/x86平台上,该值是2147483647).

当`sem_open`函数失败时,返回`SEM_FAILED`,并且设置`errno`.

> [!warning] 警告:不要创建`sem_t`结构体的副本
> 下面这段代码的做法是错误的:
> ```c
> sem_t *sem_p, sem_dup;
> sem_p = sem_open(…);
> sem_dup = *sem_p; /* 非法操作 */
> sem_wait(&sem_dup);
> ```
> 上面定义了`sem_p`的副本`sem_dup`,但在副本上执行sem的相关操作,行为是不可预知的,不要这样使用.切记,后面所有的调用都要用通过`sem_open`返回的`sem_t`类型的指针来进行操作,而不能使用结构体的副本.

当一个进程打开有名信号量时,系统会记录进程与信号的关联关系.调用`sem_close`时,会终止这种关联关系,同时信号量的进程数的引用计数减1.关闭信号量的接口定义如下:

```c
#include <semaphore.h>
int sem_close(sem_t *sem);
```

进程终止时,进程打开的有名信号量会自动关闭.当进程执行exec系列函数时,进程打开的有名信号量会自动关闭.

但是关闭不等同于删除,如果要删除信号量则需要调用`sem_unlink`函数,其接口定义如下:

```c
#include <semaphore.h>
int sem_unlink(const char *name);
```

将有名信号量的名字作为参数,传递给`sem_unlink`,该函数会负责将该有名信号量删除.由于系统为信号量维护了引用计数,所以只有当打开信号量的所有进程都关闭了之后,才会真正地删除.

### 11.3.2 信号量的使用

信号量的使用,总是和某种可用资源联系在一起的.创建信号量时的`value`值,其实指定了对应资源的初始个数.当申请该资源时,需要先调用`sem_wait`函数;当发布该资源或使用完毕释放该资源时,则调用`sem_post`函数.

#### 1. 等待信号量

`sem_wait`函数用于等待信号量,它会将信号量的值减1,其接口定义如下:

```c
#include <semaphore.h>
int sem_wait(sem_t *sem);
```

如果调用`sem_wait`函数时,信号量的当前值大于0,那么`sem_wait`函数立刻返回.否则`sem_wait`函数陷入阻塞,待信号量的值大于0之后,再执行减1操作,然后成功返回.

如果陷入阻塞的`sem_wait`函数被信号中断,则返回-1,并且置`errno`为`EINTR`.使用`sigaction`注册信号处理函数时,无论是否使用了`SA_RESTART`标志位,都不会自动重启系统调用.

如果仅仅是尝试等待信号量,而不想陷入阻塞,则可以调用`sem_trywait`函数,其接口定义如下:

```c
int sem_trywait(sem_t *sem);
```

`sem_trywait`会尝试将信号量的值减1,如果信号量的值大于0,那么该函数将信号量的值减1之后会立刻返回.如果信号量的当前值为0,那么`sem_trywait`也不会陷入阻塞,而是立刻返回失败,并置`errno`为`EAGAIN`.

若资源当前不可得,那么`sem_wait`调用就可能会陷入无限期阻塞,而`sem_trywait`调用则选择立刻返回失败,绝不阻塞.除了这两种选择,系统还提供了第三种选择:有限期等待,即`sem_timedwait`函数.

`sem_timedwait`函数的接口定义如下:

```c
int sem_timedwait(sem_t *sem, const struct timespec *abs_timeout);
```

第二个参数为一个绝对时间.可以使用`gettimeofday`函数获取到`struct timeval`类型的当前时间,然后将`timeval`转换成`timespec`类型的结构体,最后在该值上加上想等待的时间.或者调用`clock_gettime`函数,直接获得`timespec`结构体类型的变量表示当前时刻,然后在结构体上加上想等待的时间,作为第二个参数传给`sem_timedwait`函数.

如果超过了等待时间,信号量的值仍然为0,那么返回-1,并置`errno`为`ETIMEOUT`.

#### 2. 发布信号量

`sem_post`函数用于发布信号量,表示资源已经使用完毕,可以归还资源了.该函数会使信号量的值加1.

`sem_post`接口定义如下:

```c
#include <semaphore.h>
int sem_post(sem_t *sem);
```

如果发布信号量之前,信号量的值是0,并且已经有进程或线程正等待在信号量上,此时会有一个进程被唤醒,被唤醒的进程会继续`sem_wait`函数的减1操作.如果有多个进程正等待在信号量上,那么将无法确认哪个进程会被唤醒.

当函数调用成功时,返回0;失败时,返回-1,并置`errno`.当参数`sem`并不指向合法的信号量时,置`errno`为`EINVAL`;当信号量的值超过上限(即超过`INT_MAX`)时,置`errno`为`EOVERFLOW`.

#### 3. 获取信号量的值

`sem_getvalue`函数会返回当前信号量的值,并将值写入`sval`指向的变量,代码如下:

```c
#include <semaphore.h>
int sem_getvalue(sem_t *sem, int *sval);
```

如果信号量的值大于0,含义自不必说;但是如果信号量的值等于0,同时又有很多进程或线程阻塞在信号上,那么应该返回0还是返回一个负值——其绝对值等于等待进程的个数?看起来后者更有意义,因为从该值可以获知到竞争的激烈程度,但是Linux还是选择返回0.

当`sem_getvalue`返回时,其返回的值可能已经过时了.从这个意义上讲,该接口的意义并不大.

### 11.3.3 无名信号量的创建和销毁

无名信号量,由于其没有名字,所以适用范围要小于有名信号量.只有将无名信号量放在多个进程或线程都共同可见的内存区域时才有意义,否则协作的进程无法操作信号量,达不到同步或互斥的目的.所以一般而言,无名信号量多用于线程之间.因为线程会共享地址空间,所以访问共同的无名信号量是很容易办到的事情.或者将信号量创建在共享内存内,多个进程通过操作共享内存的信号量达到同步或互斥的目的.

#### 1. 初始化无名信号量

无名信号量的初始化是通过`sem_init`函数来完成的.

```c
#include <semaphore.h>
int sem_init(sem_t *sem, int pshared, unsigned int value);
```

其中,第二个`pshared`参数用于声明信号量是在线程间共享还是在进程间共享.0表示在线程间共享,非零值则表示信号量将在进程间共享.要想在进程间共享,信号量必须位于共享内存区域内.

无名信号量的生命周期是有限的,对于线程间共享的信号量,线程组退出了,无名信号量也就不复存在了.对于进程间共享的信号量,信号量的持久性与所在的共享内存的持久性一样.

无名信号量初始化以后,就可以像操作有名信号量一样操作无名信号量了.

#### 2. 销毁无名信号量

销毁无名信号量的接口定义如下所示:

```c
#include <semaphore.h>
int sem_destroy(sem_t *sem);
```

`sem_destroy`用于销毁`sem_init`函数初始化的无名信号量.只有在所有进程都不会再等待一个信号量时,它才能被安全销毁.对Linux实现而言,省略`sem_destroy`函数,也不会带来异常.但是为了安全性和可移植性,还是应该在合适的时机正常销毁信号量.

### 11.3.4 信号量与futex

> [!info] 链接库说明
> 使用POSIX信号量,链接的时候需要加上`-lpthread`,而不是`-lrt`.由此可以看出POSIX信号量与NPTL线程库渊源甚深.

第7章讲线程时曾提到过,互斥量是建立在快速用户空间互斥体(英文全名为fast userspace mutex,简称futex)基础上的.POSIX信号量也是架构在futex基础之上的.

快速用户空间互斥体,是一种用户态和内核态协同工作的同步机制.同步的进程需要一段共享内存,futex变量就位于这段内存之中.当进程尝试进入或退出互斥区时,首先会检查共享内存中的futex变量,如果没有竞争发生,则原子地修改futex变量,无须执行系统调用.如果通过访问futex变量的值发现有竞争发生,则执行相应的系统调用去完成相应的处理.

对于线程间同步,因为同一个进程下的多个线程共享该进程的地址空间,所以同时操作某个futex变量并不是特别难以做到的事情.如果是用于进程间的同步,则首先需要一块内存空间,而且要让多个进程都可以操作该内存空间,这就牵扯到共享内存了.事实上调用`sem_open`函数来创建POSIX信号量时,使用了后面会介绍到的`mmap`,并在多个进程之间共享文件的内容.

下面的代码摘自glibc的`sem_open`函数:

```c
/* Create the initial file content.  */
union
{
    sem_t initsem;
    struct new_sem newsem;
} sem;
/*信号量的初始值为value，后面会写入文件*/
sem.newsem.value = value;
sem.newsem.private = 0;
sem.newsem.nwaiters = 0;
memset ((char *) &sem.initsem + sizeof (struct new_sem), '\0',
        sizeof (sem_t) - sizeof (struct new_sem));
...
/*将sem相关的值写入文件，并通过mmap映射到进程的内存中*/
if (TEMP_FAILURE_RETRY (__libc_write (fd, &sem.initsem, sizeof (sem_t)))
        == sizeof (sem_t)
        /* Map the sem_t structure from the file.  */
        && (result = (sem_t *) mmap (NULL, sizeof (sem_t),
               PROT_READ | PROT_WRITE, MAP_SHARED,
               fd, 0)) != MAP_FAILED)
```

每创建一个名为`name`的信号量,在`/dev/shm`下就会多出一个名为`sem.name`的文件.该文件的内容是`sem_t`结构体:

```c
#if __WORDSIZE == 64
# define __SIZEOF_SEM_T 32
#else
# define __SIZEOF_SEM_T 16
#endif

typedef union
{
  char __size[__SIZEOF_SEM_T];
  long int __align;
} sem_t;
```

在x86架构下,32位系统里,该结构体的大小是16字节,在x86_64架构下,该结构体的大小是32字节.事实上,真实存放的内容是`new_sem`结构体:

```c
union
{
    sem_t initsem;
    struct new_sem newsem;
} sem;

/*new_sem是真正使用的结构体*/
struct new_sem
{
  unsigned int value;  /*当前信号量的值*/
  int private;
  unsigned long int nwaiters;
};
```

下面创建一个名为`res_88`的信号量,创建该信号量时,将信号量的值初始化为88.代码如下所示:

```c
sem_t* sem = sem_open(argv[1], O_RDWR|O_CREAT|O_EXCL, S_IRUSR|S_IWUSR, 88);
```

我们可以通过查看`/dev/shm/sem.res_88`来查看该信号量的情况:

```bash
manu@manu-rush:~$ od -x /dev/shm/sem.res_88
0000000 0058 0000
 0000 0000 0000 0000 0000 0000
0000020 0000 0000 0000 0000 0000 0000 0000 0000
0000040
```

其文件内容的含义如图11-5所示.

> [!figure] 图11-5 `/dev/shm/sem.name`文件的内容
> (图示说明:文件内容依次为信号量的当前值(4字节)、private字段(4字节)、nwaiters字段(8字节)以及填充字节.)

从输出中的`0058 0000`(0x58等于88)可知,当前信号量的值是88.

当将信号量的值减少到零,并且有两个进程在等待信号量时:

```bash
manu@manu-rush:~$ od -x /dev/shm/sem.res_88
0000000 0000 0000 0000 0000 0002 0000 0000 0000
0000020 0000 0000 0000 0000 0000 0000 0000 0000
```

输出中的`0002 0000 0000 0000`(0x02)表示当前有两个进程等待在该信号量上.

对于POSIX信号量而言,需要同步的进程通过`mmap`将文件内容映射进了进程的地址空间.对这段内核提供了futex系统调用,其接口定义如下:

```c
#include <linux/futex.h>
#include <sys/time.h>

int futex(int *uaddr, int op, int val, const struct timespec *timeout,
          int *uaddr2, int val3);
```

第一个参数`uaddr`是用户空间的一个地址,里面存放的是整型变量.

第二个参数`op`用于存放操作命令,最基本的两个操作命令`FUTEX_WAIT`和`FUTEX_WAKE`.

- 当`op`是`FUTEX_WAIT`时,会原子地检查`uaddr`地址存放的int值是否等于`val`,如果是,那么内核会使进程陷入休眠,同时把进程挂到`uaddr`对应的等待队列上.
- 当`op`是`FUTEX_WAKE`时,最多唤醒`val`个等待在`uaddr`上的进程.

在没有竞争的条件下,可以通过实验来比较下System V信号量和POSIX信号量的效率,见表11-6.同样是初始化一个信号量的值为1,然后交替执行wait和post操作各100万次,可以看出,System V信号量花费的时间是POSIX信号量的40多倍.

**表11-6 POSIX信号量和System V信号量在无竞争情况下的性能比较**

| 信号量类型 | 执行时间(秒) | 系统调用次数 |
|-----------|---------------|-------------|
| POSIX信号量 | 0.3           | 2次futex     |
| System V信号量 | 14.3          | 2,000,000次semop |

用`strace`统计系统调用次数,可以看到System V信号量共执行了200万次`semop`系统调用,而POSIX信号量只有两次`futex`,事实上,这仅有的两次`futex`系统调用,也与`sem_post`和`sem_wait`调用无关.

```
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
  0.86    0.000012           6         2         1 futex
```

```
% time     seconds  usecs/call     calls    errors syscall
------ ----------- ----------- --------- --------- ----------------
 99.99   14.265818           7   2000000           semop
```

> [!info] 注意
> 网上有些文章认为`sem_post`无论是否存在竞争都会执行futex系统调用,很明显这种观点是错误的,通过简单的实验不难验证这点.因为信号量的数据结构中记录了等待者的数量,因此不难判断是否需要执行系统调用,来唤醒等待者.

至于存在竞争的情况,在互斥量相关的章节中已经介绍过,这里就不再赘述.

## 11.4 内存映射mmap

消息队列和信号量都已经介绍过了,按照正常的逻辑,本节应该介绍POSIX共享内存,为什么这里却要介绍内存映射`mmap`呢?

这是因为内存映射`mmap`是POSIX共享内存的基础,内存映射完成了大量的基础性工作,临门一脚交给了共享内存.事实上POSIX共享内存也要和`mmap`配合使用.不理解`mmap`就不能很好地理解POSIX共享内存.

更重要的是,纵然不提共享内存,`mmap`这个系统调用也是非常重要的,其重要程度远远超过POSIX共享内存.只要你在Linux平台上工作,每天就一定会执行无数次的`mmap`系统调用,不管是直接地还是间接地.

当你执行哪怕是最简单的`ls`命令时,`mmap`系统调用在背后都会默默地帮你加载动态链接库,当你调用`malloc`函数分配大于`MMAP_THRESHOLD`大小(默认是128KB)的内存时,`mmap`系统调用会躲在`malloc`背后支撑;当你调用`pthread_create`创建线程时,`mmap`系统调用会帮你分配好线程栈;当你创建POSIX信号量时,`mmap`会默默帮你开辟一段空间存放futex变量......

可能迄今为止你从未在代码中直接使用`mmap`,但它就静静地躺在那里,对你的帮助不增也不减.

### 11.4.1 内存映射概述

`mmap`系统调用的作用是在调用进程的虚拟地址空间中创建一个新的内存映射.根据内存背后有无实体文件与之关联,映射可以分成以下两种:

- **文件映射**:内存映射区域有实体文件与之关联.`mmap`系统调用将普通文件的一部分内容直接映射到调用进程的虚拟地址空间.一旦完成映射,就可以通过在相应的内存区域中操作字节来访问文件内容.这种映射也被称为基于文件的映射.
- **匿名映射**:匿名映射没有对应的文件.这种映射的内存区域会被初始化成0.

一个进程映射的内存可以与其他进程中的映射共享物理内存.所谓共享是指各个进程的页表条目指向RAM中的相同分页.如图11-6所示.

> [!figure] 图11-6 进程内存共享映射
> (图示说明:进程A和进程B的虚拟地址空间分别映射到不同的虚拟地址,但页表条目指向相同的物理内存页(RAM中的同一分页).)

这种内存映射的共享,会在以下两种情况下发生:

- 通过`fork`,子进程继承了父进程通过`mmap`映射的副本.
- 多个进程通过`mmap`映射了同一个文件的同一个区域.

无论映射背后有无实体文件与之关联,这个进程之间共享映射的特性都是非常有用的.我们知道,进程的虚拟地址空间是彼此隔离的,一个进程不能直接操作另一个进程虚拟地址空间中的内存.但是`mmap`系统调用给出了两个办法,让多个进程可以共享一片内存区域.

看到第一种方式,即通过`fork`子进程继承父进程通过`mmap`映射的副本,大家的心中可能会隐隐有种不安.第4章曾提到过,虽然子进程拷贝了父进程的内存,但是父子进程的页表并不是始终都指向同一物理内存的,一旦父子进程中有一个尝试修改内存的内容时,内核就不得不发起写时复制,分配新的物理内存.从此父子进程分道扬镳,彼此再也看不到对方对内存的改动.

对于进程`malloc`出来的内存,栈上的变量的确如此,`fork`之后父子进程并不是共享同一块映射.但是通过`mmap`系统调用创建的内存映射却可以做到进程之间共享同一个内存映射.当然进程之间要不要共享映射也是可以选择的,这取决于该映射是私有映射还是共享映射.

- **私有映射(`MAP_PRIVATE`)**:在映射内容上发生的变更对其他进程不可见.对于文件映射而言,变更不会同步到底层文件中.对映射内容所做的变更是进程私有的.事实上,内核使用了写时复制技术来完成这个任务.未对映射内容进行修改操作时,页面仍然是共享的.一旦有进程试图修改其中一个分页的内容时,内核首先会为该进程创建一个新的分页,并将需要修改的分页中的内容拷贝到新分页中.
- **共享映射(`MAP_SHARED`)**:在映射内容上发生的所有变更,对所有共享同一个映射的其他进程都可见.对于文件映射而言,变更会同步到底层的文件中.很明显,共享映射是用于进程间通信的.

内存映射根据有无文件关联,分成文件与匿名;根据映射是否在进程间共享,分成私有和共享.这两个维度两两组合,内存映射共分成4种类型,其各自的用途如表11-7所示.

**表11-7 内存映射的分类及用途**

| 类型 | 描述 | 用途 |
|------|------|------|
| 私有文件映射 | 映射文件内容,修改不写回文件,写时复制 | 加载动态库、可执行文件,每个进程私有副本 |
| 私有匿名映射 | 无文件,初始化为0,写时复制 | 分配大块内存(`malloc`内部使用),生成子进程时继承 |
| 共享文件映射 | 映射文件内容,修改写回文件,所有映射进程可见 | 进程间通信(IPC),文件映射I/O |
| 共享匿名映射 | 无文件,初始化为0,所有映射进程共享 | 进程间通信(IPC),通常通过`fork`或`mmap`的`MAP_ANONYMOUS`标志创建 |

下面,我们开始介绍如何利用`mmap`接口,实现这四种不同的内存映射.

# 第11章 进程间通信:POSIX IPC

## 11.4.2 内存映射的相关接口

`mmap` 函数的接口定义如下:

```c
#include <sys/mman.h>

void *mmap(void *addr, size_t length, int prot, int flags,
           int fd, off_t offset);
```

这个函数的参数比较多.其中 `fd`、`offset` 和 `length` 这三个参数指定了内存映射的源,即将 `fd` 对应的文件,从 `offset` 位置起,将长度为 `length` 的内容映射到进程的地址空间.

> [!NOTE] 文件映射的前提
> 对于文件映射,调用 `mmap` 之前需要调用 `open` 取到对应文件的文件描述符.

第一个参数 `addr` 用于指定将文件对应的内容映射到进程地址空间的起始地址.一般来讲为了可移植性,该参数总是指定为 `NULL`,表示交给内核去选择合适的位置.

第三个参数 `prot` 用于设置对内存映射区域的保护,它的合法值及其含义如表11-8所示.

**表11-8 `mmap` 调用中 `prot` 的合法值及其含义**

| prot 值       | 含义               |
|---------------|--------------------|
| `PROT_READ`   | 可读取映射区域      |
| `PROT_WRITE`  | 可写入映射区域      |
| `PROT_EXEC`   | 可执行映射区域      |
| `PROT_NONE`   | 无法访问映射区域    |

`flags` 参数用于指定内存映射是共享映射还是私有映射,也用于指定内存映射是文件映射还是匿名映射.`flags` 可选的标志位及含义如表11-9所示.

**表11-9 `mmap` 调用中 `flags` 可选的标志位及含义**

| flags 值          | 含义                                                       |
|-------------------|------------------------------------------------------------|
| `MAP_SHARED`      | 共享映射:对映射内容的修改对所有共享同一映射的进程可见,文件映射还会同步到底层文件 |
| `MAP_PRIVATE`     | 私有映射:对映射内容的修改仅对调用进程可见,不会影响底层文件(写时复制) |
| `MAP_ANONYMOUS`   | 匿名映射:映射不关联文件,`fd` 参数被忽略,`offset` 应为 0             |
| `MAP_FIXED`       | 严格映射:必须将内容映射到 `addr` 指定的地址,若无法映射则失败         |

> [!WARNING] 关键标志位选择
> 调用 `mmap` 函数时,`MAP_SHARED` 和 `MAP_PRIVATE` 标志位,两者**必须指定一个**.

> [!CAUTION] `MAP_FIXED` 的使用建议
> 如果指定了 `MAP_FIXED`,那么表示函数调用者铁了心地要把内容映射到对应的地址上.这种情况下,`addr` 一般要求按页对齐.如果内核无法映射文件到该指定位置,则调用失败.如果地址和长度指定的内存区域和已有映射有重叠部分,那么重叠区的原始内容将被丢弃,然后填入新的内容.**使用该选项需要非常了解进程的地址空间,否则不建议使用.**

> [!INFO] 页对齐要求
> 需要注意的是 `mmap` 系统调用的操作单元是**页**.参数 `addr` 和 `offset` 都必须按页对齐,即必须是页面大小的整数倍.在 Linux 下,页面大小是 4096 字节,该值可以通过 `getconf` 命令来获取到:

```bash
getconf PAGESIZE
# 输出：4096
```

对于编程接口,Linux 提供了 `sysconf` 函数来获取到相关配置项的值:

```c
#include <unistd.h>

long sysconf(int name);
```

对于获取页面大小而言,可以通过如下代码获取到页面的大小:

```c
long pagesize = sysconf(_SC_PAGESIZE);
```

> [!NOTE] 映射区域总是页面整数倍
> 在进程的地址空间里,映射区域总是页面的整数倍.但是有些时候,`mmap` 传递的 `length` 值并非页面的整数倍,比如文件映射时,文件的大小或要映射进内存的区域并非页面的整数倍,这时候,`mmap` 会按照页面的大小向上取整,多出来的内存区域(最后一个有效字节到映射区域边界)会填充 0.

当 `mmap` 调用成功时,则返回映射区域的起始地址,如果失败,则返回 `MAP_FAILED`,并置 `errno`.

如果不再需要对应的内存映射了,可以调用 `munmap` 函数,解除该内存映射:

```c
#include <sys/mman.h>

int munmap(void *addr, size_t length);
```

其中 `addr` 是 `mmap` 返回的内存映射的起始地址,`length` 是内存映射区域的大小.执行过 `munmap` 后,如果继续访问内存映射范围内的地址,那么进程会收到 `SIGSEGV` 信号,引发段错误.

> [!WARNING] 文件描述符关闭不等于解除映射
> 需要注意的是,关闭对应文件的文件描述符并不会引发 `munmap`.

> [!TIP] 私有映射的丢弃行为
> 如果创建内存映射时 `flags` 中带上了 `MAP_PRIVATE` 标志位,那么解除该内存映射时,调用进程对内存映射的所有改动都会被丢弃.

介绍完基本接口,下面将分别介绍4种不同的映射,以及它们的应用场景.

### 11.4.3 共享文件映射

#### 1. 共享文件映射的建立和使用

创建共享文件映射的步骤如下:

1. 打开文件,获取文件描述符 `fd`,这一步是通过 `open` 来完成的.
2. 将文件描述符作为 `fd` 参数,传给 `mmap` 函数.

整个步骤像下面的伪代码所示:

```c
fd = open(...);
addr = mmap(..., MAP_SHARED, fd, ...);
close(fd);   /* 可选，可以关闭，也可以不关闭 */
```

第1)步打开文件时设置的权限必须要和 `mmap` 系统调用需要的权限相匹配.具体来讲就是:

- 打开时,必须允许读取,即 `O_RDONLY` 和 `O_RDWR` 至少要指定一个.
- `mmap` 调用时,如果 `prot` 参数中指定了 `PROT_WRITE`,并且 `flags` 中指定了 `MAP_SHARED`,那么打开时,必须带有 `O_RDWR` 标志位.

`open` 时需要注意,并非所有的文件都支持 `mmap` 操作,比如管道文件就不支持 `mmap` 操作.

`mmap` 完成之后关闭文件描述符并不会导致内存映射被解除,因此,在没有其他需要的情况下,可以调用 `close` 关闭文件.

但在某些场景下,后续操作还会用到文件描述符,因此不宜关闭文件.比如进程需要将对内存映射所做的修改立刻同步到底层的磁盘文件中,这可能需要对文件描述符 `fd` 调用 `fsync` 或 `fdatasync`;再比如多个进程间共享内存映射,它们都要修改内存映射的部分内容,这种情况可以通过文件的记录锁(`fcntl` 函数的 `F_SETLKW` 命令)来同步进程的操作.因此,建立共享文件映射之后是否关闭文件描述符,需要根据实际情况来做决定.

`mmap` 这个接口容易产生的一个误解是,调用 `mmap` 时,真的已经把文件对应区域的内容读取到了内存的对应位置.事实上并非如此,`mmap` 仅仅是建立了两者之间的关联.当第一次读取映射区的内容或修改映射区的内容时,会引发缺页中断(page fault),这时候才会真正地将文件的内容加载到内存的对应位置.

当 `mmap` 调用成功之后,共享映射在进程地址空间中的位置,以及和对应文件的关系如图 11-7 所示.

**图 11-7** 进程地址空间中映射区域和文件的关系

文件是有长度的,所以正常情况下 `offset` 和 `length` 参数应该遵循一定的限制:`offset` 应小于文件的长度,并且 `offset + length` 也应小于文件的长度.很有意思的是,`mmap` 函数并不检查 `offset` 和 `size` 定义的区域是否在文件的范围之内.示例代码如下:

```c
#define MB (1024 * 1024)
ret = fstat(fd, &stat_buf);
if (ret < 0) {
    // 错误处理
}
off_t filesize = stat_buf.st_size;
off_t offset = (filesize % PAGESIZE == 0) ? \
               filesize : (filesize / PAGESIZE + 1) * PAGESIZE;
mmap_base = mmap(NULL, stat_buf.st_size + MB, PROT_READ, MAP_SHARED, fd, offset);
if (mmap_base == MAP_FAILED) {
    fprintf(stderr, "failed to mmap (%s)\n", strerror(errno));
    ret = 3;
    goto out;
}
```

上面的代码中,将文件结尾之后的 1M 字节映射到进程的地址空间,映射的区域和文件完全没有交集.在这种情况下,`mmap` 也不会因 `offset` 和 `length` 参数而返回 `MAP_FAILED`,而是正常地返回.

> [!NOTE] 注意
> 此处说的是不检查 `offset` 和 `length` 定义的范围是否在文件长度范围之内,并不是说不检查 `offset` 和 `size` 的值.`mmap` 调用要求 `offset` 必须为系统分页的整数倍,这个限制始终存在.如若 `offset` 的值不是系统分页的整数倍,`mmap` 会返回 `MAP_FAILED`,并置 `errno` 为 `EINVAL`.

尽管 `mmap` 不检查对应区域是否落在文件的长度范围之内,但是这并不意味着随意建立的映射也能正常使用.使用共享文件映射需要谨慎,否则很容易触发错误.

最容易想到的一种错误就是没有映射某区域却强行访问,而且无论该区域是否落在文件的长度范围以内(如图 11-8 所示).这种访问会引发段错误,产生 `SIGSEGV` 信号.该信号的默认动作是进程终止并产生核心转储文件.

**图 11-8** 访问内存映射的常见错误(1)

这种错误是一目了然的.但是如果调用 `mmap` 时 `length` 不是系统分页大小(4KB)的整数倍时,情况就会稍稍有些复杂,如图 11-9 所示.文件的长度为 10KB,但是调用 `mmap` 时,将文件的前 5KB 映射到了进程的地址空间.这种情况下,真正映射的大小会被向上舍入成系统分页的整数倍,对于这个例子而言,虽然 `mmap` 调用指定了 5KB,但是真实映射了 8KB 的大小.用户访问 `mmap` 返回基地址偏移 8KB 之内的内存地址,都不会触发 `SIGSEGV` 信号.访问基地址偏移 8KB 之后的地址,才会触发 `SIGSEGV` 信号.

另外一种错误是访问的映射地址虽然在 `mmap` 映射的内存区域之内,但并不在文件长度的范围以内(如图 11-10 所示),这种情况会导致 `SIGBUS` 信号的产生,该信号的默认动作也是进程终止并产生核心转储文件.这种错误之所以会出现是因为 `mmap` 并不会检查 `offset` 和 `size` 定义的区域是否落在文件长度范围以内.既然建立映射的时候不检查,那么真正访问对应内存地址的时候,就可能触发错误.

**图 11-9** 访问内存映射的常见错误(2)

**图 11-10** 访问内存映射的常见错误(3)

这种错误也是很明显的.但是当文件的大小不是系统分页整数倍时,也会带来一定的特殊情况,如图 11-11 所示.

**图 11-11** 访问内存映射的常见错误(4)

尽管文件的长度是 3KB,但是 `mmap` 映射了一个长度为 8KB 的内存区域.4KB~8KB 这个范围自不必说,超出了文件的范围,访问时一定会触发 `SIGBUS` 信号.但是比较挠头的是 3KB~4KB 这个范围的内存.因为这个范围已经不在文件的长度范围之内了,却又和文件的有效映射同处一个页面.这种情况下允许访问,而且不会触发 `SIGBUS` 信号.至于要访问 8KB 之后的内存,那已经是尝试访问映射范围之外的内存了,会触发上一种错误,即产生 `SIGSEGV` 信号.

第一种情况即访问映射范围之外的内存属于典型的作死小能手的行为.但是很有意思是,有时候访问本映射范围之外的内存却不一定会触发 `SIGSEGV`.原因是 `mmap` 区域可能存在多个内存映射,虽然超出了本想访问的映射的范围,却歪打正着访问到了相邻的内存映射.注意,这种情况并不值得窃喜,而是更糟糕,因为程序已经不是按照预设的逻辑在运行了,继续运行很可能会在某个不可预知的地方崩溃,这就增大了排查问题的难度.

第二种错误更需要程序员小心.表面看只要调用 `mmap` 时小心谨慎,不主动出幺蛾子(即映射超出文件长度范围的内存区域),`SIGBUS` 信号就不会出现.其实则不然.如果内存映射在使用过程中,调用 `truncate` 或 `ftruncate` 将文件截断,那么访问文件真实长度之外的区域,就会触发 `SIGBUS` 信号(如图 11-12 所示).因为共享文件映射始终和文件相关联,因此这种情况要小心防范.

**图 11-12** `truncate` 文件引起 `SIGBUS` 信号的产生

#### 2. 共享文件映射的用途

共享文件映射主要用于两个方面:操作文件和进程间通信.

Linux 提供了 `read`、`write`、`lseek` 等操作文件的系统调用,通过这些接口可以操作文件.共享文件映射给出了另外一种操作文件的方法.

共享文件映射将文件的内容映射到了进程的地址空间.对应区域中的内容来源于文件,对映射内容所做的修改,都会自动反应到文件上,内核会负责将修改最终同步到底层的块设备.因此共享文件映射区域的内存,就等同于对文件的读写.

访问过的文件页面,很可能还会继续访问.不同进程很可能会访问同一文件页面.如果每次访问文件的内容,都要操作底层块设备,那性能就会很差.因此现代的操作系统都提供了文件缓存,Linux 也不例外.Linux 提供了页高速缓存(Page Cache,也称页缓存)用以减少对磁盘的访问.

在大部分情况下,应用程序都会通过页高速缓存来读写文件.当读取文件的某一部分内容时,内核首先会从页高速缓存中查找所读取的数据是否存在对应的页面,如果请求的页面不在页高速缓存之中,那么内核就会负责分配页面并添加到页高速缓存中,然后从磁盘上读取对应的数据来填充它.如果物理内存足够大,空闲页面足够多,那么该页将长期保留在页高速缓存中,使得其他进程访问该页数据时不需要再访问磁盘.当应用程序向文件写入时,会直接修改页高速缓存中的数据,但是并不会立刻写入磁盘,而是将该页标记成脏页,由内核负责在合适的时机将脏页回写到磁盘中.

调用 `read` 也好,调用 `write` 也罢,事先都要准备用户空间缓冲区 `buffer`,如图 11-13 所示.读取时,将读到的内容复制到该 `buffer` 中;写入时,再将 `buffer` 中的内容写入文件中.

**图 11-13** `read` 和 `write` 都需要用户空间缓冲区

对于 `read` 和 `write` 接口而言,姑且不论磁盘与页高速缓存之间如何交互,页高速缓存和用户空间缓冲区之间的数据传输是不可避免的.但是如果使用 `mmap` 来操作文件,则不需要这次复制.`mmap` 对共享文件映射的操作,直接作用在页高速缓存上,节省了一次数据传输.

这是不是意味使用 `mmap` 来操作文件要比使用 `read`/`write` 的性能更好呢?大家很容易产生这种想法,但这种想法有些想当然.随着硬件的发展,内存拷贝消耗的时间已经极大地降低了,可是 `mmap` 访问文件内容,会引起缺页中断(page fault).相对于内存拷贝而言,缺页中断的开销更大,加上创建内存映射、解除内存映射及更新硬件内存管理单元的翻译后备缓冲器(TLB)的开销,大部分情况下(不考虑刻意构造的场景),`mmap` 的性能反而要低于 `read` 和 `write`.

共享文件映射的第二个用途是进程间通信.进程的地址空间是彼此隔离的,一个进程一般不能直接访问另一个进程的地址空间.通过共享文件映射,两个进程的映射区域指向了同一个物理内存(即前面提到的页高速缓存),这就给进程间通信提供了可能,如图 11-14 所示.如果两个进程的共享文件映射都源自同一个文件的同一个区域,那么一个进程对映射区域的修改,对于另外那个进程是立刻可见的,同时内核会负责在合适的时机将修改同步到底层文件.之所以能够做到这点,是因为两个映射区域的对应分页都指向了同一个页高速缓存(Page Cache),下一小节将会介绍内核的相关实现.

**图 11-14** 进程通过共享文件映射共享物理内存

所有的共享内存都会遇到的问题是同步.无论是 [[System V 信号量]] 还是 [[POSIX 信号量]],都可以用于同步对共享内存的操作.除此以外,记录锁也比较适用于操作共享文件映射.

`fcntl` 函数提供了记录锁的功能,和 `flock` 函数提供的文件锁功能相比,`fcntl` 提供的记录锁可以提供更细粒度的控制.`flock` 函数提供的锁是粗放型锁,锁定的是整个文件,无法锁定文件的某个区域.`fcntl` 提供的锁可以锁定文件的某个区域,如图 11-15 所示,这样就减少了因竞争而陷入阻塞的概率,从而提高了性能.

**图 11-15** 记录锁可对文件的特定区域上锁

`fcntl` 函数接口的定义如下所示:

```c
#include <unistd.h>
#include <fcntl.h>
int fcntl(int fd, int cmd, ... /* arg */);
```

其中与记录锁相关的 `cmd` 为:

- `F_SETLKW`:尝试锁定文件的对应区域.如果该区域已经被锁定,则陷入阻塞.
- `F_SETLK`:尝试锁定文件的对应区域.如果该区域已经被锁定,则立刻返回 -1.
- `F_GETLK`:仅仅是查询锁的信息,并不会真正地对某区域加锁.

当执行加锁相关操作时,需要用到 `flock` 结构体,代码如下:

```c
struct flock {
    ...
    short l_type;
    short l_whence;
    off_t l_start;
    off_t l_len;
    pid_t l_pid;
```c
    ...
};
```

其中 `l_type` 用于指定锁的类型，以及指定解锁操作，其合法值及其含义如下：

- `F_RDLCK`：读锁
- `F_WRLCK`：写锁
- `F_UNLCK`：解锁

`l_whence` 的含义和 `lseek` 函数的第三个参数 `whence` 的含义一样，表示如何解释偏移量，有效值有 `SEEK_SET`、`SEEK_CUR` 和 `SEEK_END`。`l_whence` 参数结合 `l_start` 和 `l_len` 参数，定义了文件的某个区域。

使用 `fcntl` 对文件的某个区域加锁解锁的方法如下示例代码所示：

```c
struct flock fl;
int ret;
fl.l_type = F_WRLCK;
fl.l_whence = SEEK_SET;
fl.l_start = 0;
fl.l_len = 100;
/* 对文件对应区域加锁 */
ret = fcntl(fd, F_SETLKW, &fl);
/* 访问或修改 [0, 99] 范围内的文件内容 */
/* 对文件对应区域解锁 */
fl.l_type = F_UNLCK;
ret = fcntl(fd, F_SETLK, &fl);
```

通过上面的讨论可以看出，`fcntl` 提供的记录锁非常适用于同步共享文件映射的操作。可以轻易地做到读写请求分开，以及更细粒度、更灵活的控制。

> [!NOTE] 注意
> `flock` 和 `fcntl` 都属于劝告式锁（Advisory Lock），如果同步的进程遵循游戏规则，操作之前先申请锁，就能起到同步的作用；但是如果进程无视劝告式锁的存在，不遵循游戏规则，不申请锁直接操作文件或文件的某个区域，内核也不会阻止这种操作。

#### 3. 共享文件映射的内核实现

对于共享文件映射而言，最大的谜团是：进程地址空间彼此独立，互不干扰，可是多个进程通过 `mmap` 映射同一文件的同一区域时，却指向了同一物理页面，修改彼此可见。内核是如何做到的？

前面已经提到过，答案是通过页高速缓存。在追踪 `mmap` 内核实现之前，首先来简单介绍下页高速缓存。

引入页高速缓存的目的是为了性能。现在访问的文件的某个页面，将来可能还会再访问。如果不将页面缓存进内存，那么每次读取文件，就都不得不操作慢速的块设备，这会极大地影响性能。

页高速缓存该如何组织多个页面，以便在需要时可以快速定位到这些缓存页面呢？对于单个文件来说，有些文件系统支持 TB 级别的文件（比如 ext4 文件系统就已经支持 16TB 的单个文件了），4KB 一个页面的情况下，页面的数目是巨大的。如果不能高效地组织页面，那么花费在查找页面上的时间就可能会很长，届时纵然页面已经在缓存中，也会因查找缓存页面太慢而导致性能的急剧恶化。内核使用了基数树（radix tree）来解决这个难题，如图 11-16 所示。

**图 11-16**　通过基数树加速页面查找

只要找到文件对应的基数树的根，就可以快速定位到与文件对应的页面（如果它在页高速缓存中的话）上。现在问题就转变成了：当进程操作文件时，如何快速找到与文件对应的基数树。

对于这个话题，毛德操老爷子在《Linux 内核情景分析》一书的 5.6 节中有高屋建瓴的分析。内核文件层有三个核心的数据结构：`file`、`dentry` 和 `inode`。虽然三种数据结构都可以通过各种指针来跳转，找到与文件对应的页高速缓存，但是 `inode` 是和页高速缓存关系最密切的数据结构。`struct file` 数据结构是进程层面的概念，提供的是目标文件的一个上下文信息。对于同一个文件，不同进程可以在该文件上建立不同的上下文，甚至同一个进程也可能因多次打开文件而建立起多个上下文。换句话说，数据结构 `struct file` 和实体文件并不是一对一的关系，而是多对一的关系。`dentry` 结构体虽不是进程层面的概念，但是 `dentry` 和实体文件也不是一对一的关系，通过文件连接，可以为已存在的文件建立别名。只有 `inode` 结构最适合和文件的页缓存关联，因为 `inode` 和实体文件是一对一的关系。

图 11-17 给出了内核中文件与页缓存相关的数据结构。从图 11-17 不难看出，当进程通过文件系统接口（`read`/`write` 等），不难找到与文件对应的 `inode`。Linux 内核引入了地址空间 `address_space` 这个数据结构来管理页高速缓存。`inode` 中的 `i_mapping` 成员变量指向对应的 `address_space` 结构体。不论多少个进程通过文件系统 API 来操作文件，也不论多少个进程通过 `mmap` 建立共享文件映射来操作文件，同一个文件只对应一个 `address_space` 结构体。通过该数据结构就能找到与页高速缓存对应的基数树，进而找到对应的缓存页（如果存在的话）。

通过图 11-17 可以很清晰地看出，当通过文件系统接口进行读写时，如何找到与文件对应的缓存页面。但是 `mmap` 内存映射区域和页高速缓存如何建立联系却并不明晰。下面我们跟踪 `mmap` 系统调用的实现来一探究竟。

调用 `mmap` 函数，进入内核之后首先会执行到 `arch/x86/kernel/sys_x86_64.c` 中的如下函数：

```c
SYSCALL_DEFINE6(mmap, unsigned long, addr, unsigned long, len,
        unsigned long, prot, unsigned long, flags,
        unsigned long, fd, unsigned long, off)
```

该函数非常简单，把绝大部分工作都委托给了内核的 `sys_mmap_pgoff` 函数。该函数定义在 `mm/mmap.c` 中，其原型声明如下：

```c
SYSCALL_DEFINE6(mmap_pgoff, unsigned long, addr, unsigned long, len,
       unsigned long, prot, unsigned long, flags,
       unsigned long, fd, unsigned long, pgoff)
```

这个函数是分析 `mmap` 实现的起点。而该函数将大部分工作都委托给了 `do_mmap_pgoff`。该函数的总体流程如图 11-18 所示。

**图 11-18**　内核 `do_mmap_pgoff` 调用关系

内核为了管理进程的地址空间，引入了虚拟内存区域（virtual memory area，VMA）的数据结构。`vm_area_struct` 结构体描述了进程地址空间内一个独立的内存范围，如图 11-19 所示。当通过 `mmap` 函数创建一个共享文件映射（当然不仅仅是共享文件映射）的时候，内核就会为进程分配一个新的 `vm_area_struct` 结构体。每一个 `vm_area_struct` 都对应进程地址空间中的唯一一个内存区间。其中成员变量 `vm_start` 指向区间的开始地址（`vm_start` 本身属于对应内存区间），`vm_end` 指向内存区间的结束地址（`vm_end` 本身不属于对应内存区间），`vm_end` 减去 `vm_start` 的值即为内存区间的长度。对于共享文件映射而言，该长度为调用 `mmap` 时指定的 `length` 向上取整为页面大小的整数倍。`vm_area_struct` 结构体中的 `vm_flags` 成员变量记录的是该内存区域的 VMA 标志位。该标志位记录了对应内存区域的一些属性。比如 `VM_READ` 标志位表示对应的页面可读取；`VM_WRITE` 标志位表示对应的页面可写；`VM_EXEC` 标志位表示对应的页面可执行；`VM_LOCKED` 表示对应的页面被锁定，等等。

**图 11-19**　进程地址空间与 VMA

如果虚拟内存区域和文件相关联，那么 `vm_area_struct` 结构体中的 `vm_file` 成员变量就指向与文件对应的 `struct file` 结构。通过该指针，虚拟内存区域就可以和文件发生关联。

另外一个很重要的成员变量是 `vm_ops`。该成员是一个指针，指向与内存区域相关的操作函数。

```c
struct vm_operations_struct {
    ...
    int (*fault)(struct vm_area_struct *vma, struct vm_fault *vmf);
    int (*page_mkwrite)(struct vm_area_struct *vma, struct vm_fault *vmf);
    ...
}
```

因为 `vm_area_struct` 是一个通用的数据结构，可以代表任意类型的内存区域，因此不同的 VMA 就有不同的操作函数，`vm_ops` 也就指向了不同的操作函数集合。

VMA 操作函数集合中的 `fault` 函数用于应对这种场景：访问的页面并没有出现在物理内存中；而 `page_mkwrite` 用于应对页面为只读，应用程序却尝试写入的情况。这两个函数都会被缺页中断处理程序调用，以处理不同的情景。

下面以主流的 ext4 文件系统为例，追踪一下整个流程。ext4 文件系统中 `inode` 的 `i_fop` 注册成 `ext4_file_operations`。`ext4_file_operation` 的定义位于 `fs/ext4/file.c` 中，其中与 `mmap` 相关的操作函数定义如下：

```c
const struct file_operations ext4_file_operations = {
    .mmap       = ext4_file_mmap,
}
```

当 `mmap` 系统调用在 `mmap_region` 中执行 `file->f_op->mmap(file, vma)` 时，执行的就是 `ext4_file_mmap` 函数。因此对于 ext4 文件系统而言，文件映射的调用路径就变成了如图 11-20 所示的路径。

**图 11-20**　内核 `do_mmap_pgoff` 的调用关系（2）

该函数异常简单，简单到我不介意将全函数都贴在这里：

```c
static int ext4_file_mmap(struct file *file, struct vm_area_struct *vma)
{
    struct address_space *mapping = file->f_mapping;
    if (!mapping->a_ops->readpage)
        return -ENOEXEC;
    file_accessed(file);
    vma->vm_ops = &ext4_file_vm_ops;
    vma->vm_flags |= VM_CAN_NONLINEAR;
    return 0;
}
```

这个 `ext4_file_mmap` 函数仅仅安装了一个内存区操作函数，即把 `vma` 的 `vm_ops` 指针指向了 `ext4_file_vm_ops`。

```c
static const struct vm_operations_struct ext4_file_vm_ops = {
    .fault      = filemap_fault,
    .page_mkwrite   = ext4_page_mkwrite,
};
```

注意整个 `mmap` 调用的过程中并没有对文件的大小做过判断。换言之，哪怕文件的大小只有 100 个字节，`mmap` 仍然可以将文件映射到 1MB 的内存空间。下面的示例代码中，尽管映射了比文件的大小还要多 1MB 的空间，但是 `mmap` 调用依然会成功。

```c
/* 省略了 error handler */
#define MB_1 (1024 * 1024)
fd = open(argv[1], O_RDONLY);
ret = fstat(fd, &stat_buf);
mmap_base = mmap(NULL, stat_buf.st_size + MB_1, PROT_READ, MAP_SHARED, fd, 0);
if (mmap_base == MAP_FAILED) {
    // 错误处理
}
```

`mmap` 之后，尽管进程的虚拟地址空间内已经有一块内存区域和文件相对应，但内核并没有将文件的内容加载到内存区域。将虚拟内存区域 `vma` 的 `vm_ops` 指向 `ext4_file_vm_ops` 实例，其实是埋下了伏笔。一旦将来需要访问映射区域的页面，尽管物理内存中没有，但依然可以依靠 VMA 操作函数集里的对应函数来处理这个危机。

知乎上有一个提问是“有哪些老鸟程序员知道而新手不知道的小技巧”，该提问下有一个很有意思很有良心的回复：

> 把觉得不靠谱的需求放到最后做。很可能到时候需求就变了。
> ——知乎用户 mu mu

这个技巧在计算机科学上也被广泛地使用着。写时复制采用的是这种思想，接下来要介绍的请求调页也是如此。在操作系统领域，未雨绸缪从来不是一个褒义词，因为这往往意味着会做大量的无用功。

请求调页是一种动态内存分配技术，该技术把页面的分配推迟到不能再推迟为止。也就是说，一直推迟到进程要访问的地址不在物理内存为止。这项技术的核心思想是，进程开始运行时并不会访问其地址空间的所有地址，事实上，有些地址进程可能永远都不会访问。

一旦用户访问映射的内存区域，就会触发缺页中断。以 `arch/x86/mm/fault.c` 中的 `do_page_fault` 为起点，其调用路径如图 11-21 所示。

**图 11-21**　缺页中断的函数调用关系

在 `handle_pte_fault` 中有如下代码：

```c
entry = *pte;
if (!pte_present(entry)) {
    /* pte_none 表示没有对应页表项,内核需要从头开始加载该页 */
    if (pte_none(entry)) {
        /* 若是基于文件的映射,则请求调页 */
        if (vma->vm_ops) {
            if (likely(vma->vm_ops->fault))
                return do_linear_fault(mm, vma, address,
                    pte, pmd, flags, entry);
        }
        /* 若是匿名映射,则按需分配 */
        return do_anonymous_page(mm, vma, address,
                     pte, pmd, flags);
    }
    /* 如果该页标记不存在,但是页表中保存了相关的信息,则表示该页已被换出 */
    /* 非线性映射换出部分,不能像普通页那样换入,必须恢复非线性关联 */
    if (pte_file(entry))
        return do_nonlinear_fault(mm, vma, address,
               pte, pmd, flags, entry);
    return do_swap_page(mm, vma, address,
              pte, pmd, flags, entry);
}
```

`pte_present(entry)` 用于判断页面是否在物理内存中。如果页面并不在物理内存中，那么处理流程如图 11-22 所示。

**图 11-22**　页面不在物理内存时的处理流程

`pte_none` 用于判断是否存在对应的页表项。如果 `pte_none` 为 true，那么内核必须从头开始加载该页。这种情况下，根据 `vma` 的 `vm_ops` 是否注册了 `vm_operation_struct` 而分成两类：如果 `vm_ops` 不是 NULL，则表示是基于文件的映射，就会调用 `do_linear_fault`；如果 `vm_ops` 等于 NULL，则表示是匿名映射，内核就会调用 `do_anonymous_page` 来返回一个匿名页。

如果 `pte_none` 返回 false，则表示页表中保存了相关的信息，这就意味着该页已经被换出，这种情况下应该调用 `do_swap_page` 从系统的某个交换区换入该页。

但是有一种特殊情况，即 `pte_file` 函数返回 true 的情况。`pte_file` 函数用于检测页表项是否属于非线性映射，如果该函数返回 true，则表示页表项属于非线性映射。所谓非线性映射是指在 `mmap` 的基础上分离的映射页。尽管映射的内容仍然是文件的内容，但是与映射区域对应的并不是文件的连续区间，实际情况是每一个内存页都映射的是文件数据的不同部分。

# 第11章 进程间通信：POSIX IPC

## 缺页中断与文件映射实现

随机页。对于应用程序而言，要想建立非线性映射，首先需要调用 `mmap` 创建常规的、连续的内存映射，然后调用 `remap_file_pages` 来重新映射某些页面。对于非线性映射而言，已经换出的部分不能像普通页一样被换入，首先必须正确地恢复非线性关联。这种特殊情况，是由 `do_nonlinear_fault` 函数负责处理的。

对于共享文件映射，调用的是 `do_linear_fault` 函数。在该函数中会执行 `vma->vm_ops->fault` 函数。如果对应的文件属于 `ext4` 文件系统，那么 `mmap` 系统调用中已经将 `vma` 的 `vm_ops` 指定成了 `ext4_file_vm_ops`，因此，`vma->vm_ops->fault` 指向的就是 `filemap_fault` 函数。

`filemap_fault` 函数是非常重要的，不仅仅是 `ext4` 文件系统，还有很多文件系统都使用 `filemap_fault` 来处理缺页。该函数不仅可以读入所需的数据，还实现了预读的功能。接下来，我们来分析下 `filemap_fault` 函数。

```c
int filemap_fault(struct vm_area_struct *vma, struct vm_fault *vmf)
{
    int error;
    struct file *file = vma->vm_file;
    struct address_space *mapping = file->f_mapping;
    struct file_ra_state *ra = &file->f_ra;
    struct inode *inode = mapping->host;
    pgoff_t offset = vmf->pgoff;
    struct page *page;
    pgoff_t size;
    int ret = 0;
    size = (i_size_read(inode) + PAGE_CACHE_SIZE - 1) >> PAGE_CACHE_SHIFT;
    if (offset >= size)
       return VM_FAULT_SIGBUS;
    page = find_get_page(mapping, offset);
```

当多个进程 `mmap` 同一文件的某个区域时，当操作映射区域时，更多的情况是该页面已经在页缓存之中了。因此 `filemap_fault` 首先会调用 `find_get_page` 来检查请求页面是否已经在页缓存之中了。

如果页缓存中确实不存在请求的页面，则需要调用 `page_cache_read` 将内容从底层块设备中读取上来，其函数定义如下：

```c
static int page_cache_read(struct file *file, pgoff_t offset)
{
    struct address_space *mapping = file->f_mapping;
    struct page *page;
    int ret;
    do {
        page = page_cache_alloc_cold(mapping);
        if (!page)
            return -ENOMEM;
        ret = add_to_page_cache_lru(page, mapping, offset, GFP_KERNEL);
        if (ret == 0)
            ret = mapping->a_ops->readpage(file, page);
        else if (ret == -EEXIST)
            ret = 0; /* losing race to add is OK */
        page_cache_release(page);
    } while (ret == AOP_TRUNCATED_PAGE);
    return ret;
}
```

`mapping->a_ops` 是什么？创建 `ext4 inode` 的 `ext4_create` 函数中有如下一句代码：

```c
ext4_set_aops(inode);
```

在这个函数中我们通过上述语句设置了 `mapping` 的 `aops`。对于 `readpage` 函数而言，最终是通过 `ext4_readpage` 调用了通用函数 `mpage_readpage`。如图11-23所示。

> **图11-23**　缺页中断当 page cache 中不存在请求页面时的调用路径

正是因为**页缓存**的存在，才真正做到了当多个进程 `mmap` 同一个文件的某个区域时，其指向的物理内存是同一个分页。

> [!INFO] 系统文件共享的统一路线
> 事实上，系统文件的所有共享都是基于同一条路线的，不论你是 `read`、`write` 还是 `mmap`，都要遵循这条路线：系统唯一的文件路径 → 系统唯一的 inode → 相同的 `address_space` → 相同的页面。

我们跟踪了文件映射的内核实现，得到的结论是**页缓存**是联系内存管理系统和文件系统的一条纽带。应用层无论是使用 `read`/`write` 系统调用还是 `mmap` 将文件映射到内存，都是基于页缓存的，殊途同归。因此通过映射获取的文件视图和通过 I/O 系统调用（`read`、`write`）获得的文件视图是一致的。

理解了这个，我们就可以讨论如下这类的话题了：如果 mmap 引入的共享文件映射，修改了映射区的内存后，进程却意外死亡，那么进程对内存的修改能否同步到底层文件？**答案是肯定的**，页高速缓存到底层文件的冲刷（flush）是由内核来负责的。事实上，我们不难验证这一点。对这个话题感兴趣的话，可以阅读 stackoverflow 上的相关文章[^1]。

[^1]: http://stackoverflow.com/questions/5902629/mmap-msync-and-linux-process-termination

关于共享文件映射，另外一个很有意思的现象是：修改映射区的内存，哪怕是几个字节，也可能需要花费很长的时间（比如几百毫秒）[^2]。很多人都遇到了这个问题 [^3]，原因是内核回写线程会负责将脏页回写，它会将正在回写的页设置成写保护。此时如果有用户进程对该页面执行写操作，就会因为碰到了写保护的页面而走到 `do_page_fault`。这种情况下，最终会执行到 `handle_pte_fault` 中的如下语句：

```c
    if (flags & FAULT_FLAG_WRITE) {
        if (!pte_write(entry))
            return do_wp_page(mm, vma, address,
                    pte, pmd, ptl, entry);
        entry = pte_mkdirty(entry);
    }
```

在 `do_wp_page` 函数中会调用 `page_mkwrite` 方法，在这里会等待回写线程写完之后才可以完成对页面的写操作。参考文献已经介绍得非常详细了，限于篇幅此处就不展开了。

[^2]: 写 mmap 内存变慢的原因：http://oldblog.donghao.org/2012/02/mmapauaeaayaooo.html
[^3]: mmap internals：http://blog.chinaunix.net/uid-20662820-id-3873318.html

### 11.4.4　私有文件映射

当调用 `mmap` 时，如果将 `flags` 设置成 `MAP_PRIVATE` 标志位，那么映射就是私有文件映射。最常见的情况就是前面提到的加载动态共享库，多个进程共享相同的文本段。

从下面执行 `ls` 时执行的系统调用中可以看出：

```bash
open("/lib/x86_64-linux-gnu/libc.so.6", O_RDONLY|O_CLOEXEC) = 3
read(3, "\177ELF\2\1\1\0\0\0\0\0\0\0\0\0\3\0>\0\1\0\0\0\200\30\2\0\0\0\0\0"..., 832) = 832
fstat(3, {st_mode=S_IFREG|0755, st_size=1807032, ...}) = 0
mmap(NULL, 3921080, PROT_READ|PROT_EXEC, MAP_PRIVATE|MAP_DENYWRITE, 3, 0) = 0x7fe89a1a1000
```

一般来讲文本段通常被保护成 `PROT_READ|PROT_EXEC`。为了防止恶意程序篡改内存上的保护信息之后再篡改程序或共享库的文本，通常会直接使用私有文件映射而不是共享文件映射。

相对于出现得更早的静态库，动态库有很多的优点：可执行文件变得更小，节省磁盘空间；内存中只需要一份共享库的实例，不同进程都可以使用因而节省了内存。

### 11.4.5　共享匿名映射

和文件映射相对应的是匿名映射。这种映射并没有文件与之对应。一般来讲创建匿名映射有两种方法：

- 调用 `mmap` 时，在参数 `flags` 中指定 `MAP_ANONYMOUS` 标志位，并且将参数 `fd` 指定为 `-1`。
- 打开 `/dev/zero` 设备文件，并将得到的文件描述符 `fd` 传递给 `mmap`。

不论采用哪种方式，得到的内存映射中的字节都会被初始化成 `0`。

本节介绍共享匿名映射，下一节将介绍私有匿名映射。调用 `mmap` 创建匿名映射时，如果 `flags` 设置了 `MAP_SHARED` 标志位，那么创建出来就是共享匿名映射。共享匿名映射的作用是让相关进程共享一块内存区域。

比如父进程创建一个共享匿名映射，然后 `fork` 创建子进程，这种情况下，父子进程就可以通过这块内存区域来通信。这个过程的代码如下所示。

```c
addr = mmap(NULL,length,PROT_READ|PROT_WRITE,
            MAP_SHARED|MAP_ANONYMOUS,-1,0);
if(addr == MAP_FAILED)
{
    /* error handle */
}
child_pid = fork()
```

### 11.4.6　私有匿名映射

当创建匿名映射时，如果 `flags` 中设置了 `MAP_PRIVATE` 标志位，那么创建出来的内存映射就是私有匿名映射。

这种映射最典型的用途是分配进程所需的内存。映射出来的内存并没有文件与之关联，对内存的操作也是私有的，不会影响到其他进程。该用途比较典型的例子就是 `glibc` 中的 `malloc` 实现。当要分配的内存大于 `MMAP_THRESHOLD` 字节时，`glibc` 的 `malloc` 是使用 `mmap` 来实现的。一般来讲该阈值是 `128KB`，可以通过 `mallopt` 函数来调整该参数。

当代码中有如下内容时：

```c
char *p = malloc(128*1024);
```

通过 `strace` 来跟踪程序的执行，我们可以清楚地看到程序调用了 `mmap` 系统调用：

```bash
mmap(NULL, 135168, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7f2a29f0c000
```

> [!TIP] 对于 `malloc` 的 `glibc` 实现感兴趣的话，Justin N. Ferguson 的《Understanding the heap by break it》是一篇非常好的参考文献。

### 11.5　POSIX 共享内存

前面曾经讲述过，`mmap` 系统调用做了大量的工作，POSIX 共享内存和前面的共享文件映射相比，并没有什么特殊之处。如果非要说有差别，那么差别就是，获取文件描述符的方式不同。

| 普通文件映射获取 `fd` 的方式                         | POSIX 共享内存获取 `fd` 的方式                     |
|----------------------------------------------|----------------------------------------------|
| `fd = open(filename,...);`                   | `fd = shm_open(name,...);`                   |
| 使用 `mmap` 映射到进程地址空间                      | 使用 `mmap` 映射到进程地址空间                      |
| `addr = mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);` | `addr = mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);` |

POSIX 共享内存可以在无关的进程之间共享一个内存区域。和 System V 信号相比，POSIX 使用了文件系统来标识共享内存，并且调用操作文件的接口来操作共享内存。每创建一个 POSIX 共享内存，挂载在 `/dev/shm` 下的 `tmpfs` 文件系统中就会新增一个文件。

和 System V 共享内存相比，POSIX 共享内存的大小可以动态调整，因为 POSIX 共享内存是基于文件的，所以可以很方便地通过 `ftruncate` 函数来调整共享内存的大小。共享内存的使用者可以通过 `munmap` 和 `mmap` 重建映射。System V 共享内存的大小在创建时就已经确定，无法再做调整。

总体来讲，POSIX 共享内存要优于 System V 共享内存，建议使用 POSIX 共享内存。

#### 11.5.1　共享内存的创建、使用和删除

共享内存的创建本质上是两个接口，首先是调用 `shm_open` 返回文件描述符，然后是通过 `mmap` 将共享内存映射到进程的地址空间。两个函数的搭配很像 System V 的 `shmget` 函数和 `shmat` 函数。

`shm_open` 函数的接口定义如下：

```c
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
int shm_open(const char *name, int oflag, mode_t mode);
```

这里的 `oflag` 标志要包含 `O_RDONLY` 或 `O_RDWR` 标志位，除此以外，可以选择的标志位还有 `O_CREAT`（表示创建）、`O_EXCL`（配合 `O_CREAT` 表示排他创建）。另外一个标志位是 `O_TRUNC`，表示将共享内存的 size 截断成 0。

`mode` 参数可配合 `O_CREAT` 标志位使用，用于设定共享内存的访问权限。如果仅仅是打开共享内存，则可以传递 0。`shm_open` 总是需要 `mode` 参数。

`shm_open` 函数调用成功时，会返回一个文件描述符。内核会自动设置 `FD_CLOEXEC` 标志位，即如果进程执行了 `exec` 函数，则该文件描述符会被自动关闭。

因为共享内存是文件，所以可以调用文件相关的函数，如 `fstat` 函数、`fchmod` 函数和 `fchown` 函数。其中最常用且重要的函数要属 `ftruncate` 函数。因为新创建的共享内存，默认大小总是 0。所以在调用 `mmap` 之前，需要先调用 `ftruncate` 函数，以调整文件的大小。

```c
#include <unistd.h>
int ftruncate(int fd, off_t length);
```

调整了 size 之后，就可以调用 `mmap` 函数将共享内存映射到进程的地址空间了。对于其他参与通信的进程，可能需要调用 `fstat` 接口来获取共享内存区的大小。

```c
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
int fstat(int fd, struct stat *buf);
```

通过该接口可以获取到共享内存的大小。

在 `mmap` 将共享内存映射到进程的地址空间之后，就可以通过操作内存来通信了。对这块内存的所有修改，其他进程都可以看到。

结束通信任务后，可以通过调用 `munmap` 函数解除映射。如果彻底不需要共享内存了，可以通过 `shm_unlink` 函数来删除。该函数的接口定义如下：

```c
int shm_unlink(const char *name);
```

删除一个共享内存对象，并不会影响既有的映射。内核维护有引用计数，当所有的进程都通过 `munmap` 解除映射之后，共享内存对象才会真正被删除。

如果不执行 `shm_unlink`，共享内存对象中的数据则具有内核持久性。哪怕所有的进程都通过 `munmap` 解除了映射，只要不调用 `shm_unlink`，其中的数据就不会丢失。当然，如果系统重启，那么其中的共享内存对象也就不复存在了。

#### 11.5.2　共享内存与 tmpfs

POSIX 共享内存是建立在 `tmpfs` 基础之上的。事实上，System V 共享内存也是建立在 `tmpfs` 基础上的。

从 `glibc` 的角度来看，`shm_open` 的实现是非常简单的：

```c
#define SHMDIR    (_PATH_DEV "shm/")
int
shm_open (const char *name, int oflag, mode_t mode)
{
    size_t namelen;
    char *fname;
    int fd;

    /* 滤除用户给出的名字中的一个或多个 '/' 字符 */
    while (name[0] == '/')
       ++name;
    if (name[0] == '\0')
    {
        /* The name "/" is not supported.  */
        __set_errno (EINVAL);
        return -1;
    }

    /* 这一部分是生成完整的路径名 */
    namelen = strlen (name);
    fname = (char *) __alloca (sizeof SHMDIR - 1 + namelen + 1);
    __mempcpy (__mempcpy (fname, SHMDIR, sizeof SHMDIR - 1),
           name, namelen + 1);

    fd = open (name, oflag, mode);
    if (fd != -1)
    {
        /* 给文件描述符设置 FD_CLOEXEC 标志位 */
        int flags = fcntl (fd, F_GETFD, 0);
        if (__builtin_expect (flags, 0) != -1)
        {
            flags |= FD_CLOEXEC;
            flags = fcntl (fd, F_SETFD, flags);
        }
        if (flags == -1)
        {
            /* Something went wrong.  We cannot return the descriptor.  */
            int save_errno = errno;
            close (fd);
            fd = -1;
            __set_errno (save_errno);
        }
    }
    return fd;
}
```

该函数就做了三件事：

1. 生成真正的文件名：当用户调用 `shm_open` 传递的文件名为 `name` 时，文件的全路径是 `/dev/shm/name`。
2. 创建或打开 `/dev/shm/name` 文件。
3. 给打开的文件设置 `FD_CLOEXEC` 标志位。

前文曾不断提及，`mmap` 才是关键，无论是通过 `open` 获取到 `fd` 还是根据 `shm_open` 获取到 `fd`，并没有什么本质的区别。看到 `glibc` 的 `shm_open` 实现后，我们更能够理解这个观点，的确没有本质区别，`shm_open`，不过就是 `open` 披了一个马夹。

接下来可以讲讲 `tmpfs` 相关的内容了。在 `shm_open` 的实现中选择 `/dev/shm` 这个路径并不是随意而为之的。`glibc` 为了实现 POSIX 共享内存，需要将一个 `tmpfs` 挂载到 `/dev/shm` 这个路径下。

`tmpfs` 是一个内存文件系统，该文件系统可将所有的文件内容保持在内存之中，而不会写入到磁盘等持久化的设备中。一旦 `umount` 或系统重启，`tmpfs` 里的内容就会全部丢失。

内核的文档中 `Documentation/filesystems/tmpfs.txt` 中介绍了 `tmpfs` 的作用：

- 总是存在内核的内部挂载（internal mount），这个内部挂载并不依赖于 `CONFIG_TMPFS`，哪怕 `CONFIG_TMPFS` 编译选项没有打开，也不会影响到该内部机制的存在。它的存在是为共享匿名映射和 System V 共享内存服务的。
- `glibc` 自 2.2 版本以来，为了实现 POSIX 共享内存的功能，需要一个挂载点为 `/dev/shm` 的 `tmpfs`。

从文档中可以看出，无论是 POSIX 信号量、System V 信号量还是共享匿名映射都是建立在 `tmpfs` 的基础上的，其统一的视图如图 11-24 所示。

> [!INFO] **图 11-24　共享内存与 tmpfs**  
> （原图说明：统一的视图展示共享内存与 tmpfs 的关系）

对于 System V 共享内存而言，其核心是 `tmpfs`，外面封装了一层用来管理 IPC 的键值。当调用 `shmget` 创建 System V 共享内存时，会调用 `ipc/shm.c` 中的 `newseg` 函数。该函数会调用位于 `mm/shmem.c` 文件中的 `shmem_file_setup` 函数来创建一个与共享内存对应的 `struct file`。代码如下所示：

```c
    sprintf (name, "SYSV%08x", key);
    if (shmflg & SHM_HUGETLB) {
        /* hugetlb_file_setup applies strict accounting */
        if (shmflg & SHM_NORESERVE)
            acctflag = VM_NORESERVE;
        file = hugetlb_file_setup(name, size, acctflag,
                    &shp->mlock_user, HUGETLB_SHMFS_INODE);
    } else {
        if  ((shmflg & SHM_NORESERVE) &&
                sysctl_overcommit_memory != OVERCOMMIT_NEVER)
            acctflag = VM_NORESERVE;
        file = shmem_file_setup(name, size, acctflag);
    }
```

当调用 `shmat` 函数将 System V 共享内存 attach 到进程的地址空间时，内核会通过 `do_mmap` 函数，创建出基于该文件的共享映射，提供给用户使用。毫不意外，当用户调用 `shmdt` 函数解除映射时，内核会调用 `do_munmap`。

在 Linux 实现中，传统的 System V 共享内存虽然没有显式地调用 `open-mmap-munmap` 这套流程，但是内在的核心逻辑是一致的。`shmget` 获得了一个 `tmpfs` 的文件实例，`shmat` 函数内部对应 `mmap`，而 `shmdt` 函数内部对应 `munmap`。

接下来分析共享匿名映射。创建共享匿名映射有两条路，其中一条就是打开 `/dev/zero` 文件，将获得的文件描述符 `fd` 传递给 `mmap` 函数。`/dev/zero` 是一个特殊的文件，在 `drivers/char/mem.c` 中有如下内容：

```c
static const struct memdev {
    const char *name;
    mode_t mode;
    const struct file_operations *fops;
    struct backing_dev_info *dev_info;
} devlist[] = {
    ...
    [5] = { "zero", 0666, &zero_fops, &zero_bdi },
    ...
}

static const struct file_operations zero_fops = {
    .llseek     = zero_lseek,
    .read       = read_zero,
    .write      = write_zero,
    .mmap       = mmap_zero,
};
```

如果打开 `/dev/zero` 文件，并将获得的文件描述符 `fd` 传给 `mmap` 系统调用，那么内核中 `mmap_region` 函数中调用的 `file->f_op->mmap` 函数，实质上调用的是 `mmap_zero` 函数，而 `mmap_zero` 函数，不过是 `shmem_zero_setup` 函数的简单封装。

```c
static int mmap_zero(struct file *file, struct vm_area_struct *vma)
{
#ifndef CONFIG_MMU
    return -ENOSYS;
#endif
    if (vma->vm_flags & VM_SHARED)
        return shmem_zero_setup(vma);
    return 0;
}
```

创建共享匿名映射的另外一条路是调用 `mmap`，传递 `-1` 作为 `fd` 的值。这种情况下也会走到 `shmem_zero_setup` 函数。请看 `mmap_region` 函数中的如下代码：

```c
    if(file){
        ...
    }else if (vm_flags & VM_SHARED) { /* 共享匿名映射处理逻辑 */
        error = shmem_zero_setup(vma);
        if (error)
            goto free_vma;
    }
```

殊途同归，无论采用哪种方式创建共享匿名映射，最终都会调用到 `shmem_zero_setup` 函数。而该函数仅仅是 `shmem_file_setup` 的简单封装。

POSIX 共享内存前面已经分析过了，通过挂载到 `/dev/shm` 路径下的 `tmpfs` 来实现内存的共享。`glibc` 的 `shm_open` 用于创建一个文件，并且通过 `mmap` 映射到进程的地址空间。

从上面的讨论也可以看出，`mmap` 和 `tmpfs` 是隐藏在共享内存背后的终极 boss。无论是 System V 共享内存，还是 POSIX 共享内存，都摆脱不了 `tmpfs` 和 `mmap`。区别仅仅是 POSIX 共享内存很直接，就是直接在 `tmpfs` 下创建文件，直接通过 `mmap` 来使用内存区域，而 System V 共享内存穿了马甲，将 `tmpfs` 和 `mmap` 的相关操作隐藏到了内核中。

对 `tmpfs` 和共享内存感兴趣的话，《浅析Linux共享内存和tmpfs》[1] 是一篇不错的参考文档。

[1] http://hustcat.github.io/shared-memory-tmpfs/