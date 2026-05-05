# 第10章　进程间通信：System V IPC

下面三种类型的进程间通信方法统称为System V IPC：
- System V消息队列
- System V信号量
- System V共享内存

这三种IPC机制的差别很大，之所以将它们放在一起讨论，一个重要的原因是这三种机制是一同被开发出来的。它们最早出现在20世纪70年代末，1983年三者出现在主流的System V Unix系统上，因此这三种机制被统称为System V IPC。

## 10.1　System V IPC概述

System V IPC相关的接口如表10-1所示。

**表10-1　System V IPC编程接口**

| 功能 | 消息队列 | 信号量 | 共享内存 |
|------|----------|--------|-----------|
| 创建或打开对象 | msgget | semget | shmget |
| 控制操作 | msgctl | semctl | shmctl |
| 通信操作 | msgsnd, msgrcv | semop | shmat, shmdt |

从作用上看，三种通信机制各不相同，但是从设计和实现的角度来看，还是有很多风格一致的地方。

System V IPC未遵循“一切都是文件”的Unix哲学，而是采用标识符ID和键值来标识一个System V IPC对象。每种System V IPC都有一个相关的get调用（表10-1中的“创建或打开对象”一行），该函数返回一个整型标识符ID，System V IPC后续的函数操作都要作用在该标识符ID上。

System V IPC对象的作用范围是整个操作系统，内核没有维护引用计数。调用各种get函数返回的ID是操作系统范围内的标识符，对于任何进程，无论是否存在亲缘关系，只要有相应的权限，都可以通过操作System V IPC对象来达到通信的目的。

System V IPC对象具有内核持久性。哪怕创建System V IPC对象的进程已经退出，哪怕有一段时间没有任何进程打开该IPC对象，只要不执行删除操作或系统重启，后面启动的进程依然可以使用之前创建的System V IPC对象来通信。

此外，我们也无法像操作文件一样来操作System V IPC对象。System V IPC对象在文件系统中没有实体文件与之关联。我们不能用文件相关的操作函数来访问它或修改它的属性。所以不得不提供专门的系统调用（如msgctl、semop等）来操作这些对象。在shell中无法用ls查看存在的IPC对象，无法用rm将其删除，也无法用chmod来修改它们的访问权限。幸好Linux提供了ipcs、ipcrm和ipcmk等命令来操作这些对象。

> [!WARNING] System V IPC对象不是文件描述符，所以无法使用基于文件描述符的多路转接I/O技术（select、poll和epoll等）。这个缺点会给编程带来一些不便之处。

### 10.1.1　标识符与IPC Key

System V IPC对象是靠标识符ID来识别和操作的。该标识符要具有系统唯一性。这和文件描述符不同，文件描述符是进程内有效的。一个进程的文件描述符4和另一个进程的文件描述符4可能毫不相干。但是IPC的标识符ID是操作系统的全局变量，只要知道该值（哪怕是猜测获得的）且有相应的权限，任何进程都可以通过标识符进行进程间通信。

三种IPC对象操作的起点都是调用相应的get函数来获取标识符ID，如消息队列的get函数为：

```c
int msgget(key_t key, int msgflg);
```

其中第一个参数是key_t类型，它其实是一个整型的变量。IPC的get函数将key转换成相应的IPC标识符。根据IPC get函数中的第二个参数oflag的不同，会有不同的控制逻辑，如表10-2所示。

**表10-2　创建或打开一个IPC对象的逻辑**

| oflag（msgflg） | 含义 |
|----------------|------|
| 0 | 仅打开已存在的对象，若不存在则返回错误 |
| IPC_CREAT | 若对象不存在则创建，若已存在则打开 |
| IPC_CREAT \| IPC_EXCL | 若对象不存在则创建，若已存在则返回错误（EEXIST） |

因为key可以产生IPC标识符，所以很容易产生一种误解，就是同一个key调用IPC的get函数总是返回同一个整型值。实际上并非如此。在IPC对象的生命周期中，key到标识符ID的映射是稳定不变的，即同一个key调用get函数，总是返回相同的标识符ID。但是一旦key对应的IPC对象被删除或系统重启后，则重新使用key创建的新的IPC对象被分配的标识符很可能是不同的。

不同进程可通过同一个key获取标识符ID，进而操作同一个System V IPC对象。那么现在问题就演变成了如何选择key。

对于key的选择，存在以下三种方法。

**第一种方法**：随机选择一个整数值作为key值（如图10-1所示）。作为key值的整数通常被放在一个头文件中，所有使用该IPC对象的程序都要包含该头文件。需要注意的是，要防止无意中选择了重复的key值，从而导致不需要通信的进程之间意外通信，以致引发程序混乱。一个技巧是将项目要用到的所有key放入同一个头文件中，这样就可以方便地检查是否有重复的key值。

> 图10-1　使用magic number作为key
> （图中描述：程序A和程序B各自包含头文件common.h，其中定义了#define IPC_KEY 12345，然后通过msgget(IPC_KEY, ...)获得相同消息队列）

**第二种方法**：使用IPC_PRIVATE，使用方法如下：

```c
id = msgget(IPC_PRIVATE, S_IRUSR | S_IWUSR);
```

这种方法无须指定IPC_CREATE和IPC_EXCL标志位，就能创建一个新的IPC对象。使用IPC_PRIVATE时总是会创建新的IPC对象，从这个角度看将其称之为IPC_NEW或许更合理。

不过，使用IPC_PRIVATE来得到IPC标识符会存在一个问题，即不相干的进程无法通过key值得到同一个IPC标识符。因为IPC_PRIVATE总是创建一个新的IPC对象，如图10-2所示。因此IPC_PRIVATE一般用于父子进程，父进程调用fork之前创建IPC对象，创建子进程后，子进程也就继承了IPC标识符，从而父子进程可以通信。当然无亲缘关系的进程也可以使用IPC_PRIVATE，只是稍微麻烦了一点，IPC对象的创建者必须想办法将IPC标识符共享出去，让其他进程有办法获取到，从而通过IPC标识符进行通信。

> 图10-2　IPC_PRIVATE总是创建新的IPC对象
> （图中描述：父进程使用IPC_PRIVATE创建消息队列，获得ID=100；子进程fork后继承ID=100，可以通信；另一个无关进程无法通过key获取该ID）

**第三种方法**：使用ftok函数，根据文件名生成一个key。ftok是file to key的意思，多个进程通过同一个路径名获得相同的key值，进而得到同一个IPC标识符。其使用方法如图10-3所示。

> 图10-3　根据文件获得key，进而获得IPC标识符
> （图中描述：进程A和进程B都调用ftok("/tmp/somefile", proj_id)得到相同的key，再通过msgget获得相同的消息队列ID）

ftok函数接口的定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>

key_t ftok(const char *pathname, int proj_id);
```

在Linux实现中，该接口把通过pathname获取的信息和传入的第二个参数的低8位糅合在一起，得到一个整型的IPC key值，如图10-4所示。

需要注意的是，pathname对应的文件必须是存在的。

这个函数在Linux上的实现是：按照给定的路径名，获取到文件的stat信息，从stat信息中取出st_dev和st_ino，然后结合给出的proj_id，按照图10-4所示的算法获取到32位的key值。

> 图10-4　ftok生成键值的算法
> （图中描述：key = (st_dev的低8位) << 24 | (proj_id的低8位) << 16 | (st_ino的低16位)）

可以用程序来验证，代码如下：

```c
#include <stdio.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/ipc.h>

int main(int argc , const char* argv[])
{
    struct stat stat_buf ;
    if(argc != 2)
    {
        fprintf(stderr,"Usage : ftok  <pathname>");
        return 1;
    }
    stat(argv[1],&stat_buf);
    key_t  key = ftok(argv[1],0x1234);
    printf("st_dev : %lx, st_inode : %lx , key : %x \n",
            stat_buf.st_dev,stat_buf.st_ino,key);
    return 0;
}
```

执行情况如下：

```
./ftok_test.c
st_dev : 801, st_inode : 240cb4 , key : 34010cb4
```

观察上面的加粗部分，可以看出key确实是按照图10-4所示的数据来源糅合而得到的。即使是ftok函数的第二个参数相同，也很难出现两个文件映射出同一个key值的情况。这里说的是很难，而不是绝对不会，因为这种情况是有可能发生的。这种冲突的出现需要同时满足下面三个条件：

- 两个文件所属文件系统所在磁盘的次设备号的低8位相同。
- 两个文件在各自的文件系统上的inode的最低16位也相同。
- 两个进程分别选择同一个proj_id来调用ftok（）来获取key值。

> [!NOTE] 虽然理论上是存在key值冲突的可能，但是实际上，不同的文件通过ftok函数产生出冲突的key值的可能性太低，除非刻意构造这种冲突，否则很难出现。因此使用ftok函数来获取key值是编程中常用的方法。

### 10.1.2　IPC的公共数据结构

三种System V IPC对象有很多共性，从代码层面上看也有很多公共的部分。权限结构就是其中一个。IPC的权限结构至少包括如下成员：

```c
struct ipc_perm{
    key_t key;
    uid_t uid;
    gid_t gid;
    uid_t cuid;
    gid_t cgid;
    mode_t mode;
    ulong_t seq ;
};
```

消息队列控制相关的结构体：

```c
struct msqid_ds {
     struct ipc_perm msg_perm;
     ...
}
```

信号量控制相关的结构体：

```c
struct semid_ds {
     struct ipc_perm sem_perm;
     ...
}
```

共享内存控制相关的结构体：

```c
struct shmid_ds {
     struct ipc_perm shm_perm;
     ...
}
```

uid和gid字段用于指定IPC对象的所有权。cuid和cgid字段保存着创建该IPC对象的进程的有效用户ID和有效组ID。初始情况下，用户ID（uid）和创建者ID（cuid）的值是相同的。它们都是调用进程的有效ID。但是创建者ID（cuid）是不可以改变的，而所有者ID则可以通过IPC_SET来改写。下面的代码演示了如何修改共享内存的uid字段：

```c
struct shmid_ds shm_ds;
if(shmctl(id,IPC_STAT,&shm_ds)) == -1
{
    /*error handler*/
}
shm_ds.shm_perm.uid = newuid;
if(shmctl(id,IPC_SET,&shm_ds) == -1)
{
    /*error handle*/
}
```

mode是用来控制读写权限的。所有的System V IPC对象都不具备执行权限，只有读写权限。其中对于信号量而言，写权限意味着修改权限。

IPC对象的权限控制见表10-3。

**表10-3　IPC对象的权限控制**

| 类别 | 位 | 含义 |
|------|----|------|
| owner | 读写 | 所有者读写权限 |
| group | 读写 | 同组读写权限 |
| other | 读写 | 其他用户读写权限 |

和文件的权限有点类似，IPC对象的权限被分成了三类：owner、group和other。创建对象时可以为各个类别设定不同的访问权限，代码如下所示：

```c
msg_id = msgget(key, IPC_CREAT | S_IRUSR | S_IWUSR | S_IRGRP);
msg_id = msgget(key, IPC_CREAT | 0640);
```

当一个进程尝试对IPC对象执行某种操作的时候，首先会检查权限。检查的逻辑如下：

- 如果进程是特权进程，那么进程拥有对IPC对象的所有权限。
- 如果进程的有效用户ID与IPC对象的所有者或创建者ID匹配，那么会将对象的owner的权限赋给进程。
- 如果进程的有效用户ID或任意一个辅助组ID与IPC对象的所有者组ID或创建者组ID匹配，那么会将IPC对象的group的权限赋予进程。
- 否则，将IPC对象的other权限赋予进程。

数据结构ipc_perm中的key和seq也很有意思。key比较简单，就是调用get函数创建IPC对象时传递进去的key值。如果key的值是IPC_PRIVATE，则实际的key值是0。

和key相比，成员变量seq就不那么好理解了。进程分配文件描述符时采用的是最小可用算法。比如文件描述符5曾经被分配给文件A，但是很快进程关闭了文件A。如果进程尝试打开另外一个文件，此时如果5是最小可用的槽位，那么新打开文件的文件描述符就是5。但是IPC对象的标识符ID分配不能采用这个算法。因为多个进程要通过标识符ID来通信，而标识符ID是整个系统内有效的。如果采用最小可用的算法，一般来说，IPC对象的个数不会太多，那么这个数字很容易就被猜到了。举例来说，如果存在一个恶意程序要攻击消息队列，它只需尝试很小范围内的数字，就可以猜到IPC对象的标识符ID，进而偷偷取走消息队列里面的信息。

内核针为每一种System V IPC维护了一个ipc_ids类型的结构体。该结构体的组成如图10-5所示。

> 图10-5　System V IPC的ipc_ids数据结构
> （图中描述：ipc_ids结构体包含：struct idr ipcs_idr（idr树），int in_use（当前在用对象数），unsigned short seq（流水号），unsigned short seq_max（最大流水号，等于IPCMNI-1），以及可能的其他成员如rwsem等）

上述结构体中in_use字段记录的是系统当前在用的IPC个数。因此创建IPC对象时，该值会加1；销毁IPC对象时，该值会减去1。

结构体中seq字段记录了开机以来创建该IPC对象的流水号。创建时seq的值自加，但是销毁的时候seq的值并不会自减。seq的值随着该种IPC对象的创建而单调地递增，直到递增到上限（max_seq），再溢出回绕，重新从0开始。

当需要创建新的IPC对象时，三种IPC对象的创建都会走到ipc_addid函数处，如图10-6所示。

> 图10-6　为新的IPC对象生成标识符ID
> （图中描述：ipc_addid从idr树中获得空闲槽位id，然后设置seq和构建最终id = SEQ_MULTIPLIER * seq + id）

ipc_addid函数会初始化IPC对象的很多成员变量，比如权限相关的uid、gid、cuid和cgid，也会维护该IPC对象的seq值。

```c
int ipc_addid(struct ipc_ids* ids, struct kern_ipc_perm* new, int size)
{
    uid_t euid;
    gid_t egid;
    int id, err;
    /*用户设置的IPC对象的上限,不能超过系统硬上限IPCMNI,即32768*/
    if (size > IPCMNI)
        size = IPCMNI;
    /*如果系统中已经存在的IPC对象超过了个数上限,则返回失败*/
    if (ids->in_use >= size)
        return -ENOSPC;
    spin_lock_init(&new->lock);
    new->deleted = 0;
    rcu_read_lock();
    spin_lock(&new->lock);
    /*通过idr管理,调用idr_get_new获得一个空闲的槽位*/
    err = idr_get_new(&ids->ipcs_idr, new, &id);
    if (err) {
        spin_unlock(&new->lock);
        rcu_read_unlock();
        return err;
    }
    /*系统当前在用的IPC对象加1*/
    ids->in_use++;
    /*设置创建者ID和owner ID*/
    current_euid_egid(&euid, &egid);
    new->cuid = new->uid = euid;
    new->gid = new->cgid = egid;
    /*seq的值自加,如果大于seq_max,则溢出回绕至0*/
    new->seq = ids->seq++;
    if(ids->seq > ids->seq_max,则溢出回绕至0*/
    new->seq = ids->seq++;
    if(ids->seq > ids->seq_max)
        ids->seq = 0;
    new->id = ipc_buildid(id, new->seq);
    return id;
}
```

前面提到，内核分配IPC对象标识符的时候，使用的并不是最小可用算法，其使用的算法如下：

```c
#define IPCMNI 32768
#define SEQ_MULTIPLIER (IPCMIN)
static inline int ipc_buildid(int id, int seq)
{
    return SEQ_MULTIPLIER * seq + id;
}
```

上面公式中的id就是最小可用的槽位，而seq是开机以来内核创建IPC对象的流水号。因此，返回的ID是一个比较大的值。仍然以消息队列为例，如果开机后，消息队列为空，创建的第一个消息队列的标识符必然为0，而创建的第二个消息队列和第三个消息队列的值则为：

```
32768 * 1 +  1 = 32769
32768 * 2 +  2 = 65538
```

根据上面的讨论可知，IPC对象的标识符ID虽然是通过get函数来获得的，但是和key值并不存在永久的对应关系，即不存在公式可以通过key值来计算出标识符ID。内核仅仅是关联了两者。重启系统之后，或者删除IPC对象之后，根据相同的key值再次创建，得到的标识符ID很可能并不相同。

内核面临着如何根据IPC对象的标识符ID，快速地找到内核中的IPC对象的难题，根据前面的计算公式，不难做到：

```
slot_index = 标识符ID % SEQ_MULTIPLIER
```

这个公式透漏出了一个问题：整个系统内，每一种IPC对象的槽位有限，最多有IPCMIN个槽位。在ipc_addid函数中也证实了这一点，系统的硬上限为IPCMNI，即32768。这个限制就决定了不能无限制地创建IPC对象。

## 10.2　System V消息队列

第9章介绍的管道和FIFO都是字节流的模型，这种模型不存在记录边界。如果从管道里面读出100个字节，你无法确认这100个字节是单次写入的100字节，还是分10次每次10字节写入的，你也无法知晓这100个字节是几个消息。管道或FIFO里的数据如何解读，完全取决于写入进程和读取进程之间的约定。

从这个角度上讲，System V消息队列和POSIX消息队列都是优于管道和FIFO的。原因是消息队列机制中，双方是通过消息来通信的，无需花费精力从字节流中解析出完整的消息。

System V消息队列比管道或FIFO优越的第二个地方在于每条消息都有type字段，消息的读取进程可以通过type字段来选择自己感兴趣的消息，也可以根据type字段来实现按消息的优先级进行读取，而不一定要按照消息生成的顺序来依次读取。

内核为每一个System V消息队列分配了一个msg_queue类型的结构体，其成员变量和各自的含义如下所示：

```c
struct msg_queue {
    struct kern_ipc_perm q_perm;
    time_t q_stime;        /* 上一次msgsnd的时间 */
    time_t q_rtime;        /* 上一次msgrcv的时间 */
    time_t q_ctime;        /* 属性变化时间 */
    unsigned long q_cbytes;    /* 队列当前字节总数 */
    unsigned long q_qnum;      /* 队列当前消息总数 */
    unsigned long q_qbytes;    /* 一个消息队列允许的最大字节数 */
    pid_t q_lspid;            /* 上一个调用msgsnd的进程ID */
    pid_t q_lrpid;            /* 上一个调用msgrcv的进程ID */
    struct list_head q_messages;
    struct list_head q_receivers;
    struct list_head q_senders;
};
```

大部分字段的含义都是比较好理解的，后面遇到相关内容的时候会详细讲述这些字段。

### 10.2.1　创建或打开一个消息队列

消息队列的创建或打开是由msgget函数来完成的，成功后，获得消息队列的标识符ID，函数接口定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/msg.h>

int msgget(key_t key, int msgflg);
```

msgget函数中两个参数的含义前面已经讲述过了，在此就不再赘述。当调用成功时，返回消息队列的标识符，后续的msgsnd、msgrcv和msgctl函数都通过该标识符来操作消息队列。当函数调用失败时，返回-1，并且设置相应的errno。常见的errno如表10-4所示。

**表10-4　msgget出错情况说明**

| errno | 含义 |
|-------|------|
| EACCES | 无访问权限 |
| EEXIST | 指定了IPC_CREAT\|IPC_EXCL但对象已存在 |
| ENOENT | 未指定IPC_CREAT且对象不存在 |
| ENOMEM | 内存不足 |
| ENOSPC | 消息队列数量已达到系统上限 |

关于创建消息队列，一个很容易想到的问题是：操作系统到底允许创建多少个消息队列？

表10-4中提到，当errno等于ENOSPC时，表示创建的消息队列超过了上限值MSGMNI。有三种方法可以查看系统消息队列个数的上限，如下所示。

**方法一**：通过procfs查看。

```
cat /proc/sys/kernel/msgmni
3969
```

**方法二**：通过sysctl查看。

```
sysctl kernel.msgmni
kernel.msgmni = 3969
```

**方法三**：通过ipcs命令查看。

```
ipcs -q -l

------ Messages Limits --------
max queues system wide = 3969
max size of message (bytes) = 8192
default max size of queue (bytes) = 16384
```

操作系统会根据系统的硬件情况（主要是内存大小），计算出一个合理的上限值，因此不同的硬件环境下，该值是不同的。当然无论该值设置为多少，内核都存在硬上限IPCMNI（32768）。

可以通过如下的手段，修改msgmni的值，从而允许创建更多的消息队列。

**方法一**：通过procfs来修改。

```
echo 20000 > /proc/sys/kernel/msgmni
cat  /proc/sys/kernel/msgmni
20000
```

**方法二**：通过sysctl -w来修改。

```
sysctl -w kernel.msgmni=20000
```

上述两种方法都是立即生效，但是一旦系统重启，设置就失去了。要想确保重启后依然有效，需要将配置写入/etc/sysctl.conf。

```
kernel.msgmni=20000
```

注意写入/etc/sysctl.conf并不会立即生效，需要执行sysctl -p重新加载，改变方能生效。


## 10.2.2　发送消息

获取到消息队列的标识符之后，可以通过调用 `msgsnd` 函数向队列中插入消息。内核会负责将消息维护在消息队列中，等待另外的进程来取走消息，从而完成通信的全过程。

`msgsnd` 函数的定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/msg.h>

int msgsnd(int msqid, const void *msgp, size_t msgsz, int msgflg);
```

其中 `msqid` 是由 `msgget` 返回的标识符 ID。

参数 `msgp` 指向用户定义的缓冲区。它的第一个成员必须是一个指定消息类型的 `long` 型，后面跟着消息文本的内容。通常其定义如下：

```c
struct msgbuf {
    long mtype;       /* 消息类型,必须大于 0 */
    char mtext[1];    /* 消息体,不一定是字符数组,可以是任意结构 */
};
```

每条消息只能存放一个字符？并非如此。事实上可以是任意结构，`mtext` 是由程序员定义的结构，其长度和内容都是由程序员控制的，只要发送方和接收方约定好即可。比如可以将结构体定义如下：

```c
struct private_buf {
    long mtype;
    struct pirate_info {
        /* 定义你需要的成员变量 */
    } info;
};
```

第三个参数 `msgsz` 指定了 `mtext` 字段中包含的字节数。消息队列单条消息的大小是有上限的，上限值为 `MSGMAX`，记录在 `/proc/sys/kernel/msgmax` 中：

```bash
cat /proc/sys/kernel/msgmax
8192

sysctl kernel.msgmax
kernel.msgmax = 8192
```

如果消息的长度超过了 `MSGMAX`，那么 `msgsnd` 函数返回 `-1`，并置 `errno` 为 `EINVAL`。

下面以发送字符串消息为例，介绍 `msgsnd` 函数所需的步骤：

1. 因为 glibc 并未定义 `msgbuf` 结构体，因此首先要定义 `msgbuf` 结构体。
2. 分配一个类型为 `msgbuf`，长度足以容纳字符串的缓冲区 `mbuf`。
3. 将 message 的内容拷贝到 `mbuf->mtext` 中去。
4. 在 `mbuf->mtype` 中设置消息类型。
5. 调用 `msgsnd` 发送消息。
6. 释放 `mbuf`。

注意两点，即要对 `msgsnd` 进行错误检测和及时释放 `mbuf`，以防止内存泄漏。

最后一个参数 `msgflg` 是一组标志位的位掩码，用于控制 `msgsnd` 的行为。目前只定义了 `IPC_NOWAIT` 一个标志位。

`IPC_NOWAIT` 表示执行一个无阻塞的发送操作。当没有设置 `IPC_NOWAIT` 标志位时，如果消息队列满了，那么 `msgsnd` 函数就会陷入阻塞，直到队列有足够的空间来存放这条消息为止。但是如果设置了 `IPC_NOWAIT` 标志位，那么 `msgsnd` 函数就不会陷入阻塞了，而是立刻返回失败，并置 `errno` 为 `EAGAIN`。

等一下，这里好像提到了消息队列满。什么情况下，消息队列才能被称为是满的？

任何一个消息队列，容纳的字节数是有上限的。这个上限值为 `MSGMNB`，该值被记录在 `/proc/sys/kernel/msgmnb` 中：

```bash
cat /proc/sys/kernel/msgmnb
16384

sysctl kernel.msgmnb
kernel.msgmnb = 16384
```

内核中消息队列对应的数据结构 `msg_queue` 中维护有当前字节数、当前消息数及允许的最大字节数等信息：

```c
struct msg_queue {
    ...
    time_t q_stime;            /* 最后调用 msgsnd 的时间 */
    unsigned long q_cbytes;    /* 消息队列当前字节的总数 */
    unsigned long q_qnum;      /* 消息队列当前消息的个数 */
    unsigned long q_qbytes;    /* 消息队列允许的消息最大字节数 */
    pid_t q_lspid;             /* 最后调用 msgsnd 的进程 ID */
    ...
};
```

检查消息队列是否满的逻辑非常简单，内核判断能否立刻发送消息的逻辑如下：

```c
if (msgsz + msq->q_cbytes <= msq->q_qbytes &&
       1 + msq->q_qnum <= msq->q_qbytes) {
    break;
}
```

如果同时满足以下两个条件，则可以立即发送消息，无须阻塞：
- 当前消息的字节数（`msgsz`）加上消息队列当前字节的总数（`msq->q_cbytes`）不大于消息队列允许的最大字节数（`msq->q_qbytes`）。
- 消息队列当前消息的个数加上 1 不大于消息队列容许的最大字节数（`msq->q_qbytes`）。

> [!NOTE] 第二个条件看起来很奇怪的，其实这个条件是用来防范空消息的：发送的消息只有 `mtype` 字段，消息体正文 `mtext` 都是空的。

不满足上述两个条件的话，`msgsnd` 函数会根据是否设置了 `IPC_NOWAIT` 标志位来决定是陷入阻塞还是立刻返回失败。

如果因消息队列满而陷入阻塞，`msgsnd` 系统调用则可能会被信号中断，当这种情况发生时，`msgsnd` 总是返回 `EINTR` 错误。注意，无论在建立信号处理函数的时候，是否设置了 `SA_RESTART` 标志位，`msgsnd` 系统调用都不会自动重启。

无论是否经过阻塞，只要没有出错返回，调用 `msgsnd` 都需要执行下面的操作：

```c
/* 将最后调用 msgsnd 的进程 ID 更新到消息队列的 q_lspid 成员变量中 */
msq->q_lspid = task_tgid_vnr(current);

/* 将最后调用 msgsnd 的时间更新到消息队列的 q_stime 成员变量中 */
msq->q_stime = get_seconds();

/* 如果有进程正在等待该消息,则就地消化,无须进入消息队列 */
if (!pipelined_send(msq, msg)) {
    /* 将消息链入消息队列的链表中 */
    list_add_tail(&msg->m_list, &msq->q_messages);
    /* 更新消息队列当前消息的字节数 */
    msq->q_cbytes += msgsz;
    /* 更新消息队列当前消息的总数 */
    msq->q_qnum++;
    /* 更新命名空间内,所有消息队列的总字节数和消息总个数 */
    atomic_add(msgsz, &ns->msg_bytes);
    atomic_inc(&ns->msg_hdrs);
}
```

`pipelined_send` 函数用于检测是否有进程正在等待该消息，如果有的话，消息无须进入消息队列，而是“就地消化”，皆大欢喜。如果没有等待该消息的进程，则消息就不得不进入消息队列，等待“有缘人”来提取。

至此，`msgsnd` 函数的使用和流程基本介绍完毕，如果执行成功，则 `msgsnd` 返回 0，如果失败，`msgsnd` 则返回 -1，并置 `errno`。

下面分析一下函数的返回值和常见错误。`msgsnd` 函数不同于文件的 `write` 函数，`write` 函数操作的是字节流，存在部分成功的概念，所以成功时，返回的是写入的字节个数；但是 `msgsnd` 函数操作的是封装好的消息，不成功则成仁，不存在部分成功的情况。所以其成功时，`msgsnd` 函数返回 0，失败时，`msgsnd` 函数返回 -1，并且设置 `errno`。常见的出错情况如表 10-5 所示。

**表 10-5　msgsnd 出错情况说明**

| 错误 | 含义 | 说明 |
|------|------|------|
| EAGAIN | 队列满且设置了 `IPC_NOWAIT` | 非阻塞发送失败 |
| EINVAL | 消息长度超过 `MSGMAX` 或 msqid 无效 | 参数错误 |
| EIDRM | 消息队列已被删除 | 并发删除问题 |
| EINTR | 阻塞时被信号中断 | 不会自动重启 |
| ENOMEM | 内核内存不足 | 分配消息结构失败 |

几乎所有的出错情况前面都已经介绍过了，除了 `EIDRM`。这是消息队列和信号量的共同缺陷。当一个进程操作消息队列时，另外一个进程可能已经删除该消息队列了。对于 IPC 对象（共享内存除外），内核并没有维护引用计数，删除行为是说删就删，于是 `msgsnd` 调用就会收到 `EIDRM` 的错误。

删除消息队列是一个编程难点，难就难在确定删除的时机。多个进程需要从逻辑上确定谁是最后一个访问消息队列的进程，然后由它来负责删除消息队列。

## 10.2.3　接收消息

有发送就要有接收，没有接收者的消息是没有意义的。System V 消息队列用 `msgrcv` 函数来接收消息。

```c
ssize_t msgrcv(int msqid, void *msgp, size_t msgsz,
               long msgtyp, int msgflg);
```

其中前三个参数与 `msgsnd` 的含义是一致的。`msgrcv` 调用进程也需要定义结构体，而结构体的定义要和发送端的定义一致，并且第一个字段必须是 `long` 类型，代码如下所示：

```c
struct private_buf {
    long mtype;
    struct pirate_info {
        /* 定义你需要的成员变量 */
    } info;
};
```

对于具有固定长度的消息体来讲，只要发送方和接收方的结构体达成一致，就不会存在风险。但是如果消息体是变长的，情况就复杂了点。因为不能预先得知收到消息体的长度，因此接收端的缓冲区要足够大，防止消息队列中的消息长度大于缓冲区的大小。

`msgrcv` 函数的第 4 个参数 `msgtyp` 是消息队列的精华，提取消息时，可以选择进程感兴趣的消息类型。正是基于这个参数，读取消息的顺序才无须和发送顺序一致，进而可以演化出很多用法。`msgtyp` 与提取消息的行为关系如表 10-6 所示。

**表 10-6　msgtyp 与提取消息的行为**

| msgtyp 的值 | 行为 |
|------------|------|
| 等于 0 | 先入先出模式。最先进入消息队列的消息被取出。 |
| 小于 0 | 优先级消息队列。`mtype` 的值越低，其优先级越高，越早被取出。 |
| 大于 0 | 将消息队列中第一条 `mtype` 值等于 `msgtyp` 的消息取出。通过指定不同的 `msgtyp`，多个进程可以在同一个消息队列中挑选各自感兴趣的消息。一种常见的场景是各个进程提取和自己进程 ID 匹配的消息。 |

第 5 个参数是可选标志位。`msgrcv` 函数有 3 个可选标志位：
- `IPC_NOWAIT`：如果消息队列中不存在满足 `msgtyp` 要求的消息，默认情况是阻塞等待，但是一旦设置了 `IPC_NOWAIT` 标志位，则立即返回失败，并且设置 `errno` 为 `ENOMSG`。
- `MSG_EXCEPT`：这个标志位是 Linux 特有的，只有当 `msgtyp` 大于 0 时才有意义，含义是选择 `mtype != msgtyp` 的第一条消息。
- `MSG_NOERROR`：前面也提到过，在消息体变长的情况下，可能事前并不知道消息体的大小，尽管要求 `maxmsgsz` 应尽可能地大，但是仍然存在 `maxmsgsz` 小于消息体大小的可能。如果发生这种情况，默认情况是返回错误 `E2BIG`，但是如果设置了 `MSG_NOERROR` 标志位，情况就不同了，此时会将消息体截断并返回。

`msgrcv` 函数调用成功时，返回消息体的大小；失败时返回 -1，并且设置 `errno`。大部分出错情况和 `msgsnd` 函数类似，比较特殊的错误码是 `E2BIG` 和 `ENOMSG`，刚才都已经讨论过了，这里不再赘述。另外 `msgrcv` 函数和 `msgsnd` 函数一样，如果被信号中断，则不会重启系统调用，哪怕安装信号时设置了 `SA_RESTART` 标志位。

System V 消息队列存在一个问题，即当消息队列中有消息到来时，无法通知到某进程。消息队列的读取者进程，要么以阻塞的方式调用 `msgrcv` 函数，阻塞在消息队列上直到消息出现；要么以非阻塞（`IPC_NOWAIT`）的方式调用 `msgrcv` 函数，失败返回，过段时间再重试，除此以外并无好办法。阻塞或轮询，这就意味着一个进程或线程不得不无所事事，盯在该消息队列上，这给编程带来了不便。

如果 System V 消息队列是文件，能支持 `select`、`poll` 和 `epoll` 等 I/O 多路转接函数，一个进程就能同时监控多个文件（或者多个消息队列），提供更灵活的编程模式。可惜的是，System V 消息队列并非文件，不支持 I/O 多路转接函数。第 11 章中可以看到 POSIX 消息队列在这个方面所做的改进。

## 10.2.4　控制消息队列

`msgctl` 函数可以控制消息队列的属性，其接口定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/msg.h>

int msgctl(int msqid, int cmd, struct msqid_ds *buf);
```

该函数提供的功能取决 `cmd` 字段，`msgctl` 支持的操作如表 10-7 所示。

**表 10-7　msgctl 支持的命令**

| 命令 | 描述 |
|------|------|
| `IPC_STAT` | 获取消息队列的属性信息，存入 `buf` 指向的 `msqid_ds` 结构体 |
| `IPC_SET` | 设置消息队列的属性（仅限 `msg_perm.uid`、`msg_perm.gid`、`msg_perm.mode`、`msg_qbytes`） |
| `IPC_RMID` | 删除消息队列 |

### 1. IPC_STAT

为了获取消息队列的属性信息或设置属性，必须要有一个用户态的数据结构来描述消息队列的属性信息，这个数据结构就是 `msqid_ds` 结构体，其大部分字段和内核的 `msg_queue` 结构体相对应。注意，`msqid_ds` 结构体中包含下面的成员变量。在编程中，只要包含了对应的头文件，就可以直接使用该结构体。

```c
#include <sys/msg.h>

struct msqid_ds {
   struct ipc_perm msg_perm;      /* Ownership and permissions */
   time_t          msg_stime;     /* 最后一次调用 msgsnd 的时间 */
   time_t          msg_rtime;     /* 最后一次调用 msgrcv 的时间 */
   time_t          msg_ctime;     /* 属性发生变化的时间 */
   unsigned long  __msg_cbytes;   /* 消息队列当前的字节总数 */
   msgqnum_t       msg_qnum;      /* 消息队列当前消息的个数 */
   msglen_t        msg_qbytes;    /* 消息队列允许的最大字节数 */
   pid_t           msg_lspid;     /* 最后一次调用 msgsnd 的进程 ID */
   pid_t           msg_lrpid;     /* 最后一次调用 msgrcv 的进程 ID */
};
```

几乎全部的字段都和内核的 `msg_queue` 相对应，而其对应的字段的含义在前面都已经介绍过了，此处不再赘述。在使用时，我们可以通过下面的简单代码来获取到消息队列的属性：

```c
struct msqid_ds buf;        /* 注意包含头文件 */
msgctl(mid, IPC_STAT, &buf); /* 省略 error handle */
printf("current # of messages in queue is %d\n", buf.msg_qnum);
```

### 2. IPC_SET

消息队列开放出了 4 个可以设置的属性：
- `msg_perm.uid`
- `msg_msg_perm.gid
- `msg_perm.mode`
- `msg_qbytes`

设置方法一般首先调用 `IPC_STAT` 获取到当前的设置，然后修改 4 个属性中的某个或某几个属性，最后调用 `IPC_SET`，代码如下所示：

```c
struct msqid_ds buf;        /* 注意包含头文件 */
msgctl(mid, IPC_STAT, &buf); /* 省略 error handle */
buf.msg_qbytes = NEW_VALUE;
msgctl(mid, IPC_SET, &buf);
```

### 3. IPC_RMID

`IPC_RMID` 命令用于删除与标识符对应的消息队列。由于 IPC 对象并无引用计数的机制，因此只要有权限，可以说删就删，而且是立刻就删。消息队列中的所有消息都会被清除，相关的数据结构被释放，所有阻塞的 `msgsnd` 函数和 `msgrcv` 函数会被唤醒，并返回 `EIDRM` 错误。

## 10.3　System V 信号量

### 10.3.1　信号量概述

System V 信号量又被称为 System V 信号量集，事实上信号量集的叫法更符合实际情况。信号量的作用和消息队列不太一样，消息队列的作用是进程之间传递消息。而信号量的作用是为了同步多个进程的操作。

信号量是由 E.W.Dijkstra 为互斥和同步的高级管理提出的概念。它支持两种原子操作，`wait` 和 `signal`。`wait` 还可以称为 `down`、`P` 或 `lock`，`signal` 还可以称为 `up`、`V`、`unlock` 或 `post`。其作用分别是原子地增加和减少信号量的值。

一般来说，信号量是和某种预先定义的资源相关联的。信号量元素的值，表示与之关联的资源的个数。内核会负责维护信号量的值，并确保其值不小于 0。

信号量上支持的操作有：
- 将信号量的值设置成一个绝对值。
- 在信号量当前值的基础上加上一个数量。
- 在信号量当前值的基础上减去一个数量。
- 等待信号量的值等于 0。

在上述操作中，后两个可能会陷入阻塞。在第三种情况中，当信号量的当前值小于要减去的值时，操作会陷入阻塞。当信号量的值不小于要减去的值时，内核会唤醒阻塞进程。在第四种情况中，如果当前信号量的值不为 0，该操作会陷入阻塞，直到信号量的值变为 0 为止。

这些操作看似没有什么意义，但是一旦将信号量和某种资源关联起来，就起到了同步使用某种资源的功效，请看表 10-8。

**表 10-8　信号量与资源管理**

| 操作 | 资源管理含义 |
|------|-------------|
| 将信号量设置成绝对值 | 初始化资源数量 |
| 增加信号量的值 | 释放资源 |
| 减少信号量的值 | 申请资源（可能阻塞） |
| 等待信号量为 0 | 等待所有资源被释放 |

使用最广泛的信号量是二值信号量（binary semaphore）。对于这种信号量而言，它只有两种合法值：0 和 1，对应一个可用的资源。若当前有资源可用，则与之对应的二值信号量的值为 1；若资源已被占用，则与之对应的二值信号量的值为 0。当进程申请资源时，如果当前信号量的值为 0，那么进程会陷入阻塞，直到有其他进程释放资源，将信号量的值加 1 才能被唤醒。

从这个角度看，二值信号量和互斥量所起的作用非常类似。那信号量和互斥量有何不同之处呢？

互斥量（mutex）是用来保护临界区的，所谓临界区，是指同一时间只能容许一个进程进入。而信号量（semaphore）是用来管理资源的，资源的个数不一定是 1，可能同时存在多个一模一样的资源，因此容许多个进程同时使用资源。

有个很有意思的卫生间理论可以用来阐述互斥量和信号量的区别。互斥量好比是一把卫生间的钥匙，卫生间只有一个，钥匙也只有一把。需要使用卫生间时，首先要去钥匙存放处取走钥匙，当使用完卫生间时，要将钥匙归还到钥匙存放处。如果某人需要使用卫生间，发现钥匙存放处没有钥匙，那么他就需要等待，直到卫生间的当前使用者将钥匙归还。

假设后来买了一套豪宅，家里有 8 个一模一样的卫生间和 8 把通用的钥匙。这时信号量就横空出世了。信号量的值的含义是当前可用的钥匙数，最初有 8 把钥匙放在钥匙存放处。当同时使用卫生间的人数小于或等于 8 时，大家都可以拿到一把钥匙，各自使用各自的卫生间。但是到第 9 个人和第 10 个人要使用卫生间时，发现已经没有钥匙了，所以他们就不得不等待了。

从上面的讨论看，信号量是互斥量的一个扩展，由于资源数目增多，增强了并行度。但是这仅仅是一个方面。更重要的区别是，互斥量和信号量解决的问题是不同的。

互斥量的关键在于互斥、排它，同一时间只允许一个线程访问临界区。这种严格的互斥，决定了解铃还须系铃人，即加锁进程必然也是解锁进程，代码如下所示：

```c
进程 1                               进程 2
pthread_mutex_lock();                pthread_mutex_lock();
/* 安全地访问临界区 */
pthread_mutex_unlock();
                                     /* 安全地访问临界区 */
                                     pthread_mutex_unlock();
```

而信号量的关键在于资源的多少和有无。申请资源的进程不一定要释放资源，信号量同样可以用于生产者-消费者的场景。在这种场景下，生产者进程只负责增加信号量的值，而消费者进程只负责减少信号量的值。彼此之间通过信号量的值来同步。

```
生产者进程                         消费者
post                                wait
```

和二值信号量相比，System V 信号量在两个维度上都做了扩展。
第一，资源的数目可以是多个。资源个数超过 1 个的信号量称为计数信号量（counting semaphore）。
第二，允许同时管理多种资源，由多个计数信号量组成的一个集合称为计数信号量集，每个计数信号量管理一种资源。比如第一种资源的总数是 5，第二种资源的总数是 10。在使用过程中可选择申请哪种资源或哪几种资源。

坦率来讲，System V 信号量有点设计过度，第二种扩展并无必要，同时操作集合中的多个信号量的能力是多余的，而这种扩展导致了编程接口过于复杂，使用不便。

### 10.3.2　创建或打开信号量

创建或打开信号量的函数为 `semget`，其接口定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>

int semget(key_t key, int nsems, int semflg);
```

这个接口比较简单，第二个参数 `nsems` 表示信号量集中信号量的个数。换句话说，就是要控制几种资源。大部分情况下只控制一种。如果并非创建信号量，仅仅是访问已经存在的信号量集，可以将 `nsems` 指定为 0。

`semflg` 支持多种标志位。目前支持 `IPC_CREAT` 和 `IPC_EXCL` 标志位，其含义不再赘述。

在创建信号量时，需要考虑的问题是系统限制。系统的限制可以分成三个层面。
- 系统容许的信号量集的上限：`SEMMNI`
- 单个信号量集中信号量的上限：`SEMMSL`
- 系统容许的信号量的上限：`SEMMNS`

首先介绍下对于每种限制，系统提供的硬上限，如表 10-9 所示。

**表 10-9　信号量的系统硬上限**

| 参数 | 硬上限 | 说明 |
|------|--------|------|
| `SEMMNI` | `IPCMNI` (32768) | 最大信号量集个数 |
| `SEMMSL` | 65536 | 单个集合最大信号量个数（受 `sembuf.sem_num` 类型限制） |
| `SEMMNS` | `INT_MAX` | 系统总信号量个数上限（内核用 `int` 存储） |

其中 `SEMMSL` 的硬上限是 65536，原因是 `semop` 函数中定义了 `sembuf` 结构体来操作信号量集中的信号量，代码如下所示：

```c
struct sembuf {
    unsigned short sem_num;
};
```

`sembuf` 结构体中的成员变量 `sem_num` 用来指定修改集合中的哪个信号量。其数据类型是无符号短整型（`unsigned short`）。我们固然可以一意孤行地将 `SEMMSL` 的值设置为大于 65536 的数值，但是后续将无法通过 `semop` 来操作它，因此它也就失去了存在的意义。因此集合中信号量个数的硬上限值为 65536。

之所以 `SEMMNS` 的上限值为 `INT_MAX`，原因是内核使用了 `int` 型来存储该值，代码如下所示：

```c
struct ipc_namespace {
    ...
    int sem_ctls[4];
    ...
};

#define sc_semmsl   sem_ctls[0]
#define sc_semmns   sem_ctls[1]
#define sc_semopm   sem_ctls[2]
#define sc_semmni   sem_ctls[3]
```

在硬上限范围内，可以通过 `sysctl` 来设置软上限。

```bash
cat /proc/sys/kernel/sem
32000    1024000000    500    32000

sysctl kernel.sem
kernel.sem = 32000    1024000000    500    32000
```

其中 4 个值的含义如图 10-7 所示。

> **图 10-7 信号量相关的控制选项的含义**
> 从左到右依次为：`SEMMSL`（每个信号量集的最大信号量数）、`SEMMNS`（系统最大信号量总数）、`SEMOPM`（每次 `semop` 操作的最大操作数）、`SEMMNI`（系统最大信号量集数）。

第三个值（`SEMOPM`）的含义将放到后面再介绍。可以通过 `sysctl -w` 或修改 `/etc/sysctl.conf` 来设置控制参数。注意不要超过硬上限。

如果超过系统限制时，返回的错误码见表 10-10。

**表 10-10　信号量超过系统限制相关的错误码**

| 错误码 | 原因 |
|--------|------|
| `ENOSPC` | 超过 `SEMMNS` 或 `SEMMNI` 限制 |
| `EINVAL` | `nsems` 超过 `SEMMSL` 或小于 0 |

在 System V 信号量的接口设计中，存在一个致命的缺陷，即创建信号量集和初始化集合中的信号量是两个独立的操作，而非一个原子操作，标准并未要求创建信号量集时，将信号量的值初始化为 0。当然，在 Linux 系统上，`semget` 函数返回的信号量实际上会被初始化为 0。

但是很多情况下，信号量的初始值并不希望为 0，因此需要额外调用一次 `semctl` 的 `SETVAL` 命令来设置初始值。由于创建和初始化之间存在一个时间窗口，因此可能会出现竞态条件（race condition），见表 10-11。

**表 10-11　创建和初始化分开，产生竞态条件的一种情况**

| 时间 | 进程 1 | 进程 2 |
|------|--------|--------|
| T1 | `semget(key, 1, IPC_CREAT)` 创建信号量（值为 0） | |
| T2 | | `semget(key, 1, 0)` 获取同一信号量 |
| T3 | | `semop` 操作信号量（减小值或等待） |
| T4 | `semctl(semid, 0, SETVAL, 1)` 设置初始值为 1 | |

在表 10-11 这种时序条件下，信号量的值尚未初始化就被进程 2 通过 `semop` 函数修改了。而后面进程 1 的初始化命令又会覆盖进程 2 所做的更改。

W.Richard Stevens 在名著《Unix 网络编程卷 2：进程间通信》中给出了如下思路来解决这个困境。

内核与信号量集相关的数据结构 `sem_array` 中有一个成员变量 `sem_otime`，如下所示：

```c
struct sem_array {
    ...
    time_t sem_otime;  /* 上次执行 semop 的时间 */
    ...
};
```

信号量集被创建的时候，`sem_otime` 被初始化成 0，在后续执行 `semop` 操作的时候，才会对 `sem_otime` 的值进行修改。因此可以利用这个属性来消除竞争。即第二个进程要等到创建信号量的进程执行过一次修改信号量值的 `semop` 操作后（通过判断 `sem_otime` 的值是否为 0），才开始正常的流程。

《Linux/Unix 系统编程手册（下册）》中也采用了这个思路解决了竞争问题，并给出了示例代码。但其示例代码适用范围比较狭窄，只适用于将信号量初始化为 0 这种场景。稍加改造，就可以适用于将信号量初始化为任意值的场景。具体做法如图 10-8 所示。

> **图 10-8 解决创建与初始化竞态条件的通用方法**
> 1. 进程 1 创建信号量集（`semget` 返回后 `sem_otime=0`）。
> 2. 进程 1 进行第一次 `semop` 操作（修改信号量值），此时 `sem_otime` 非 0。
> 3. 其他进程循环检查 `semctl` 的 `IPC_STAT` 获取 `sem_otime`，直到其非 0 才可继续操作。

POSIX 信号量作为后来者，注意到了 System V 信号量的这个弊端，于是将创建和初始化由一个接口来完成。详情可阅读第 11 章。


### 10.3.3 操作信号量

`semop` 函数负责修改集合中一个或多个信号量的值，其定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>
int semop(int semid, struct sembuf *sops, unsigned nsops);
```

> [!figure] 图10-8 信号量的创建和初始化流程图
> 该流程图描述了解决信号量创建和初始化竞争问题的方法：第二个进程通过检查 `sem_otime` 是否为0来等待第一个进程执行 `semop` 操作后才开始正常流程。

函数的第一个参数是通过 `semget` 获取到的信号量的标识符 ID。第二个参数是 `sembuf` 类型的指针。`sembuf` 结构体定义在 `sys/sem.h` 头文件中。一般来说，该结构体至少包含以下三个成员变量：

```c
struct sembuf {
    unsigned short int sem_num ;
    short sem_op ;
    short sem_flg;
}
```

成员变量 `sem_num` 解决的是操作哪个信号量的问题。因为信号量集中可能存在多个信号量，需要用这个参数来告知 `semop` 函数要操作的是哪个信号量，0 表示第一个信号量，1 表示第二个信号量，依此类推，最大为 `nsems-1`，即不得超过集合中信号量的个数。如果 `sem_num` 的值小于 0，或者大于等于集合中信号量的个数，`semop` 调用则会返回失败，并置 `errno` 为 `EFBIG`。

一般来讲，不建议采用如下方法来初始化 `sembuf`：
```c
struct sembuf  myopsbuf = {1,-1,0}
```
因为考虑到可移植性，我们并没有十足的把握可以确定 `sembuf` 结构体中成员变量的顺序和上面定义中给出的顺序是严格一致的。（不过 Linux 的定义就是上面给出的定义，若不考虑可移植性，可以放心采用上面的方法。）

`semop` 函数的典型用法如下所示：

```c
struct sembuf myopsbuf[3] ;
myopsbuf[0].sem_num = 0;   /*操作信号量集中的第0个信号量*/
myopsbuf[0].sem_op = -1;   /*信号量0的值减去1,即申请1个资源*/
myopsbuf[0].sem_flg = 0 ;
myopsbuf[1].sem_num = 1;   /*操作信号量集中的第1个信号量*/
myopsbuf[1].sem_op = 2 ;   /*信号量1的值加上2*/
myopsbuf[1].sem_flg = 0;
myopsbuf[2].sem_num = 2;   /*操作信号量集中的第2个信号量*/
myopsbuf[2].sem_op = 0;    /*等待第2个信号量的值变为0*/
myopsbuf[2].sem_flg = 0;
if(semop(semid,myopsbuf,3) == -1)
{
    /*error handler here*/
}
```

`semop` 函数每次会操作一组信号量，每个信号量由一个 `sembuf` 来表示，修改一个信号量最好也将其定义成 `struct sembuf ops[1]` 这样的数组，`semop` 函数的第三个参数表示要操作的信号量的个数。

如果调用 `semop` 函数同时操作多个信号量，要被原子地执行，要么内核完成所有操作，要么内核什么也不做。

尽管信号量集支持同时操作多个信号量，但事实上这种场景是非常罕见的。大多数情况下，只会操作集合中的一个信号量。更常见的是使用如下方式。

```c
struct sembuf myopsbuf[1] ;
myopsbuf[0].sem_num = 0;
myopsbuf[0].sem_op = -1;  /*信号量0的值减去1*/
myopsbuf[0].sem_flg = 0 ;
if(semop(semid,myopsbuf,1) == -1)
```

`sembuf` 中的 `sem_op` 可以是正值，也可以是负值，还可以是 0。介绍其含义之前，首先来介绍几个相关的变量。

- `semval`：信号量的当前值，表示当前可用的资源个数，永远非负。
- `semzcnt`：正在等待信号量的值变成0的进程个数。
- `semncnt`：正在等待信号量的值大于当前值的进程个数。

根据 `sem_op` 的值和 `sem_flg` 值，`semop` 函数的行为模式如表10-12所示。

> [!table] 表10-12 semop的含义
> | sem_op 值 | sem_flg 标志         | 行为                                                                                                                                  |
> |-----------|----------------------|---------------------------------------------------------------------------------------------------------------------------------------|
> | 正数      | 无特殊标志           | 将 `semval` 加上 `sem_op`，表示释放资源。如果设置了 `SEM_UNDO`，则同时调整 `semadj`。                                                  |
> | 负数      | 无特殊标志           | 尝试将 `semval` 减去 `|sem_op|`，如果 `semval >= |sem_op|`，则执行减法并成功；否则阻塞，直到 `semval` 满足条件。                      |
> | 0         | 无特殊标志           | 等待 `semval` 变为0。如果当前 `semval` 为0，则立即返回；否则阻塞，直到 `semval` 变为0。                                               |
> | 任何值    | IPC_NOWAIT           | 不阻塞。如果操作不能立即完成（如资源不足或等待值为0），则立即返回错误 `EAGAIN`。                                                      |
> | 负值      | SEM_UNDO             | 除了基本的减法操作外，还会在进程退出时自动撤销该操作（调整 `semadj`）。                                                                |
> | 正值      | SEM_UNDO             | 除了基本的加法操作外，还会在进程退出时自动撤销该操作（调整 `semadj`）。                                                                |
> | 0         | SEM_UNDO             | 等待 `semval` 变为0，同时记录 undo 信息（但调整值为0，无实际影响）。                                                                  |

对于 `semop` 操作，也存在如下系统限制：

- 单次 `semop` 调用能够操作的信号量的最大值：`SEMOPM`
- 信号量值的上限：`SEMVMX`

单次 `semop` 调用能够操作的信号量的最大个数记录在 `procfs` 中：
```shell
sysctl kernel.sem
kernel.sem = 32000    1024000000    500    32000
```
如果 `nsops` 的值超过了 `SEMOPM`，则 `semop` 函数返回 -1，并置 `errno` 为 `E2BIG`。

除此之外，信号量的值也是有上限的，最大值为 32767。若 `semop` 的增加操作导致信号量的值超过了其上限 `SEMVMX`，那么 `semop` 函数返回 -1，并置 `errno` 为 `ERANGE`。

通过上面的讨论，不难看出 `semop` 接口复杂难用。成熟的项目都会将 `semop` 函数封装起来，提供更好用、语义更简单的接口。对于编程者而言，不外乎申请资源（`wait`）和释放资源（`post`），可将接口进行如下封装：

```c
int semaphore_wait (int semid, int index)
{
    struct sembuf operations[1];
    operations[0].sem_num = index;
    operations[0].sem_op = -1;
    operations[0].sem_flg = SEM_UNDO;
    return semop (semid, operations, 1);
}

int semaphore_post (int semid, int index)
{
    struct sembuf operations[1];
    operations[0].sem_num = index;
    operations[0].sem_op = 1;
    operations[0].sem_flg = SEM_UNDO;
    return semop (semid, operations, 1);
}
```

正常使用时，如果需要等待资源，就调用 `semaphore_wait` 函数：
```c
semaphore_wait(semid,0)
```
释放资源的时候，就调用 `semaphore_post` 函数：
```c
semaphore_post(semid,0)
```

> [!warning] 注意
> 上面的封装仅仅是做一个简单的示意，很多问题并未考虑（比如未考虑系统调用被信号中断，收到 `EINTR` 错误码的场景），这些封装在项目中一般作为底层基础库，真正封装的时候要小心谨慎，考虑各种场景。

封装示例中使用了 `SEM_UNDO` 标志位，其含义见10.3.4节。

### 10.3.4 信号量撤销值

使用信号量存在这样一种风险，即进程申请了资源，修改了信号量的值，却没来得及释放资源就异常退出了。异常退出的进程把资源带进了坟墓，而其他进程却在苦苦等待其释放资源。这就意味着资源泄漏，即该进程申请的资源再也无法给其他进程使用了。对于二值信号量来说，资源泄漏的危害尤其大。

为了避免因这个问题而陷入不可收拾的境地，内核提供了一种解决方案，即内核会负责记住进程对信号量施加的影响，当进程退出的时候，内核负责撤销该进程对信号量施加的影响。

调用 `semop` 函数时，可以通过如下方法设置 `SEM_UNDO` 标志位。

```c
struct sembuf  myopsbuf[1];
myopsbuf[0].sem_num = 0;
myopsbuf[0].sem_op = -1;  /*信号量0的值减去1*/
myopsbuf[0].sem_flg |= SEM_UNDO ;
semop(semid,myopsbuf,1);
```

内核并不会为所有带 `SEM_UNDO` 标志位的 `semop` 操作都保存一笔记录，内核维护了一个名为 [[semadj]] 的变量，该变量记录了一个进程在信号量上使用 `SEM_UNDO` 操作所做的调整总和。

带 `SEM_UNDO` 标志位的 `semop` 对 `semadj` 的影响如表10-13所示。

> [!table] 表10-13 semadj与sem_op的关系
> | sem_op 值 | 对 semadj 的影响                             |
> |-----------|----------------------------------------------|
> | 正数      | semadj 减去 sem_op 的绝对值（因为释放资源）。 |
> | 负数      | semadj 加上 sem_op 的绝对值（因为申请资源）。 |
> | 0         | semadj 不变。                                |

当进程退出时，会将信号量的当前值加上这个 `semadj`，来撤销进程对信号量的影响。

申请资源和释放资源时，`SEM_UNDO` 标志位要成对地出现。切不可只在申请资源的时候使用 `SEM_UNDO`，或者只在释放资源的时候使用 `SEM_UNDO`，这都会造成 `semadj` 失准，不能正确地反映进程对信号量施加的影响。

当使用 `semctl` 的 `SETVAL` 或 `SETALL` 命令重新设置信号量的值时，所有使用这个信号量的进程中的 `semadj` 值都会被重置为0。因为 `SETVAL` 或 `SETALL` 相当于开启了上帝模式，强行将信号量的值设定为某个值了。

`SEM_UNDO` 也不是包治百病的良药。信号量是用来管理资源的，本身并无实际含义，如果进程异常退出，而资源并没有进入一个合理且稳定的状态，单单调整信号量的值并不一定能使应用恢复到一个稳定一致的状态。

除此以外，在某些情况下，进程终止时，也无法严格地按照进程的 `semadj` 来调整信号量的值，考虑如下情景：

1. 信号量的初始值是0。
2. A进程将信号量增加2，并且设置了 `SEM_UNDO` 标志位。
3. B进程将信号量减去1，此时信号量的值变为1。
4. A进程退出。

按照逻辑，应该将当前信号量的值减去2。但是由于当前信号量的值是1，不可能减去2，那该怎么办呢。对于此困境，Linux 采用的办法是尽可能地减小信号量的值。对于本例，就是将信号量的值减少为0。

上面的情况是向下溢出，与之对应的情况是向上溢出。即如果加上撤销量，信号量的值超过了上限 `SEMVMX`，内核会将信号量的值调整为 `SEMVMX`。这部分逻辑体现在 `ipc/sem.c` 中的 `exit_sem` 函数：

```c
for (i = 0; i < sma->sem_nsems; i++) {
    struct sem * semaphore = &sma->sem_base[i];
    if (un->semadj[i]) {
        /*信号量的值加上退出进程的对应的撤销值*/
        semaphore->semval += un->semadj[i];
        /*向下溢出,则置为0*/
        if (semaphore->semval < 0)
            semaphore->semval = 0;
        /*向上溢出,则置为SEMVMX*/
        if (semaphore->semval > SEMVMX)
            semaphore->semval = SEMVMX;
        semaphore->sempid = task_tgid_vnr(current);
    }
}
```

一般来讲，`SEM_UNDO` 标志位多用于二值信号量。

### 10.3.5 控制信号量

控制信号量的函数为 `semctl` 函数，其定义如下：

```c
#include <sys/types.h>
#include <sys/ipc.h>
#include <sys/sem.h>
int semctl(int semid, int semnum, int cmd, /* union semun arg */);
```

某些特定的操作需要第四个参数，第四个参数是联合体，很不幸的是这个联合体需要程序员自己定义，代码如下所示：

```c
union semun {
   int              val;
   struct semid_ds *buf;
   unsigned short  *array;
   struct seminfo  *__buf;  /*Linux特有的*/
};
```

根据第三个参数 `cmd` 值的不同，`semctl` 支持以下命令：

1. **IPC_RMID**
   `semctl` 函数的第二个参数被忽略。和消息队列的删除一样，内核不会维护信号量集的引用计数，说删就删，而且是立即删除信号量集。所有阻塞在 `semop` 函数上的进程将被唤醒，返回错误并置 `errno` 为 `ERMID`。
   删除信号量的示例代码如下：
   ```c
   int semaphore_destroy(int semid)
   {
       union semun ignored_argument;
       semctl(semid, 0, IPC_RMID, ignored_argument);
   }
   ```

2. **IPC_STAT**
   用于获取信号量集的信息，并存放在 `union semun` 中 `buf` 指向的结构体。
   每个信号量集都有一个与之关联的 `semid_ds` 结构体（该结构体无须自己定义），它至少包含以下成员：
   ```c
   struct ipc_perm sem_perm;
   time_t sem_otime;
   time_t sem_ctime;
   unsigned long sem_nsems;
   ```
   可以使用如下的简单代码来获取上述信息（省略错误处理）：
   ```c
   struct semid_ds ds ;
   union semun arg;   /*须确保semun联合体已经定义*/
   arg.buf = &ds ;
   semctl(semid,0,IPC_STAT,arg);
   printf(“last op time is %s\n”, ctime(&(ds.sem_otime)));
   ```

3. **IPC_SET**
   `union semun arg` 的成员变量 `buf`，可用来设置 `sem_perm.uid`、`sem_perm.gid` 和 `sem_perm.mode`。

4. **GETVAL**
   返回集合中第 `semnum` 个信号量的值，无需第四个参数，示例代码如下：
   ```c
   int semaphore_getval(int semid,int index)
   {
       union semun ignored_argument;
       return semctl(semid, index, GETVAL, ignored_argument);
   }
   ```

5. **SETVAL**
   将信号量集中的第 `semnum` 个信号的值设置为 `arg.val`，示例代码如下：
   ```c
   int semaphore_setval(int semid, int index, int value)
   {
       union semun arg;
       arg.val = value;
       return semctl(semid, index, SETVAL, arg);
   }
   ```

6. **GETALL**
   将信号量集中所有信号的值存放在第四个参数 `arg` 的成员变量 `array` 中。确保有足够的空间可以存放 `array` 数组。这个6. **GETALL**
   将信号量集中所有信号的值存放在第四个参数 `arg` 的成员变量 `array` 中。确保有足够的空间可以存放 `array` 数组。这个操作将忽略第二个参数 `semnum`。

7. **SETALL**
   用第四个参数 `arg` 的成员变量 `array` 数组中的值初始化信号量集中的所有信号量。一般来说这个操作用于信号量的初始化，正常使用期间很少会调用 `SETALL`。
   需要注意的是如果调用了 `SETVAL` 或 `SETALL`，使用信号量的所有进程的 `semadj` 都会被清零。

8. **GETPID**
   返回上一个对第 `semnum` 个信号量执行 `semop` 的进程的进程ID，如果不存在，则返回0。

9. **GETNCNT**
   返回等待第 `semnum` 个信号量值增大的进程的个数。

10. **GETZCNT**
    返回等待第 `semnum` 个信号量值变成0的进程的个数。

## 10.4 System V共享内存

### 10.4.1 共享内存概述

共享内存是所有IPC手段中最快的一种。它之所以快是因为共享内存一旦映射到进程的地址空间，进程之间数据的传递就不需要涉及内核了。

回顾一下前面已经讨论过的管道、FIFO和消息队列，任意两个进程之间想要交换信息，都必须通过内核，内核在其中发挥了中转站的作用：

- 发送信息的一方，通过系统调用（`write` 或 `msgsnd`）将信息从用户层拷贝到内核层，由内核暂存这部分信息。
- 提取信息的一方，通过系统调用（`read` 或 `msgrcv`）将信息从内核层提取到应用层。

上述情景如图10-9所示。

> [!figure] 图10-9 管道、FIFO和消息队列应用层与内核的交互
> 示意图显示：进程A（用户层）→ 系统调用 → 内核（缓冲区）→ 系统调用 → 进程B（用户层）

> [!figure] 图10-10 共享内存的思想
> 示意图显示：内核创建一片共享内存区域，进程A和进程B分别将其映射到各自的虚拟地址空间，之后两个进程直接读写该内存区域，无需内核参与。

一个通信周期内，上述过程至少牵扯到两次内存拷贝（从用户拷贝到内核空间和从内核空间拷贝到用户空间）和两次系统调用，这其中的开销不容小觑。用户层的体验固然不佳，内核层想必也是不堪其扰，双方的内心都是崩溃的。

于是，不堪其扰的内核提出了一个新的思路：共享内存，这种思路可以通俗地概括为**内核搭台，进程唱戏**。简单地说，内核负责构建出一片内存区域，两个或多个进程可以将这块内存区域映射到自己的虚拟地址空间，从此之后内核不再参与双方通信。正所谓：

> 事了拂衣去，深藏身与名。
> ——李白《侠客行》

进程之间使用共享内存通信的方式如图10-10所示。

> [!info] 注意
> 建立共享内存之后，内核完全不参与进程间的通信，这种说法严格来讲并不正确。因为当进程使用共享内存时，可能会发生缺页，引发缺页中断，这种情况下，内核还是会参与进来的。

进程从此就像操作普通进程的地址空间一样操作这块共享内存，一个进程可以将信息写入这片内存区域，而另一个进程也可以看到共享内存里面的信息，从而达到通信的目的。

允许多个进程同时操作共享内存，就不得不防范竞争条件的出现，比如有两个进程同时执行更新操作，或者一个进程在执行读取操作时，另外一个进程正在执行更新操作。因此，共享内存这种进程间通信的手段通常不会单独出现，总是和信号量、文件锁等同步的手段配合使用。

### 10.4.2 创建或打开共享内存

`shmget` 函数负责创建或打开共享内存段，其接口定义如下：

```c
#include <sys/ipc.h>
#include <sys/shm.h>
int shmget(key_t key, size_t size, int shmflg);
```

其中第二个参数 `size` 必须是正整数，表示要创建的共享内存的大小。内核以页面大小的整数倍来分配共享内存，因此，实际 `size` 会被向上取整为页面大小的整数倍。

第三个参数支持 `IPC_CREAT` 和 `IPC_EXCL` 标志位。如果没有设置 `IPC_CREAT` 标志位，那么第二个参数 `size` 对共享内存段并无实际意义，但是必须小于或等于共享内存的大小，否则会有 `EINVAL` 错误。

和消息队列及信号量一样，对于创建共享内存，系统也存在一些限制。

- `SHMMNI`：系统所能够创建的共享内存的最大个数。
- `SHMMIN`：一个共享内存段的最小字节数。
- `SHMMAX`：一个共享内存段的最大字节数。
- `SHMALL`：系统中共享内存的分页总数。
- `SHMSEG`：一个进程允许 `attach` 的共享内存段的最大个数。

系统允许创建的共享内存的最大个数 `SHMMNI` 的硬上限为 `IPCMNI`（32768），软上限记录在 proc 文件系统的如下位置。

```shell
cat /proc/sys/kernel/shmmni
4096
```

单个共享内存段的最小字节数 `SHMMIN` 是1，内核并没有提供控制选项来修改这个值。实际上共享内存会向上取整到页面大小，即共享内存占用的内存总是页面大小的整数倍，因此，实际的限制为4096字节。

单个共享内存段的最大字节数为 `SHMMAX`。这个值默认是32MB，可以从 `procfs` 中读出该限制。但是内核并没有设置硬上限。

```shell
cat /proc/sys/kernel/shmmax
33554432
```

很明显，32MB对某些大型的应用来说是不够用的。最典型的就是 PostgreSQL 数据库。PostgreSQL 数据库会征用大量的共享内存作为其内部使用的 `shared_buffer`。因此需要修改该参数，方法为修改 `/etc/sysctl.conf`，新增如下内容，并执行 `sysctl -p` 来重新加载。

```ini
kernel.shmmax = 2147483648
```

`SHMALL` 是一个系统级别的限制，单位是页面。内核也没有提供硬上限，一般默认值为2097152，2MB个页面即2MB×4096＝8GB。该限制记录在 `procfs` 的如下位置。

```shell
cat /proc/sys/kernel/shmall
2097152
```

`SHMSEG` 是一个进程级别的限制，限制一个进程最多可以 `attach` 多少个共享内存段。内核事实上并没有特别的限制，因此该限制实际上和 `SHMMNI` 的值一样。

### 10.4.3 使用共享内存

`shmget` 函数，不过是在茫茫内存中创建了或找到了一块共享内存区域，但是这块内存和进程尚没有任何关系。要想使用该共享内存，必须先把共享内存引入进程的地址空间，这就是 `attach` 操作。

`attach` 操作的接口定义如下：

```c
#include <sys/types.h>
#include <sys/shm.h>
void *shmat(int shmid, const void *shmaddr, int shmflg);
```

其中，第二个参数是用来指定将共享内存放到虚拟地址空间的什么位置的。大部分的普通青年都会将第二个参数设置为 `NULL`，表示用户并不在意，一切交由内核做主。

当 `shmaddr` 的地址不是 `NULL` 的时候，表示进程希望将共享内存 attach 到该地址。但是该地址必须是系统分页的整数倍，否则会返回 `EINVAL` 错误。内核提供了一个 `shmflg` 为 `SHM_RND`，表示该地址不是系统分页的整数倍也没关系，系统会在用户给出的地址附近，就近找一个系统分页整数倍的地址。

如果指定的 `shmaddr` 落在已经在用的地址范围内，就会导致 `EINVAL` 错误。但是 Linux 提供了一个非标准的扩展 `SHM_REMAP`。这个标志位表示替换位于 `shmaddr` 处且长度为共享内存段的长度的任何内存映射。很明显，设置了 `SHM_REMAP` 标志位，`shmaddr` 参数就不能再为 `NULL` 了。

如果进程仅仅是读取共享内存段的内容，并不修改，则可以指定 `SHM_RDONLY` 标志位。

`shmat` 如果调用成功，则返回进程虚拟地址空间内的一个地址。如果失败，就会返回 `(void*)-1`，并且设置 `errno`。

如何通过 `shmat` 返回的地址来使用共享内存？答案是像使用 `malloc` 分配的空间一样使用共享内存。我们都使用过 `malloc`，调用 `malloc` 时，会指定分配空间的大小，`malloc` 成功后，可以正常地使用返回的地址（只要不超过分配的空间）。`shmat` 也是一样，程序员可以自如地使用 `shmat` 返回的地址。

使用共享内存和使用 `malloc` 分配的空间还是有区别的。共享内存段用于多个进程间的通信，因此，写入共享内存的内容要事先约定好，读取进程才可以正常地解析写入进程写入的内容。`malloc` 分配的内存区域完全归调用进程所有，其他进程不可见，但共享内存则不然，其他进程也可能会同时操作该共享内存，因此使用者要有进程间同步的觉悟。

下面给出一个将共享内存 attach 到进程地址空间的例子：

```c
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/shm.h>
#include <errno.h>
#include <string.h>

#define MYKEY 0x3333

int main()
{
    int shmid;
    void *ptr = NULL;

    shmid = shmget(MYKEY, 4096, IPC_CREAT | IPC_EXCL | 0640);
    if(shmid == -1 )
    {
        if(errno != EEXIST)
        {
            fprintf(stderr,"shmget returned %d (%d: %s)\n",
                    shmid, errno,strerror(errno));
            return 1;
        }
        else
        {
            shmid = shmget(MYKEY,4096,0);
            if(shmid == -1)
            {
                fprintf(stderr,"shmget returned %d (%d: %s)\n",
                        shmid, errno, strerror(errno));
                return 2;
            }
        }
    }

    fprintf(stdout,"shmid = %d\n",shmid);

    ptr = shmat(shmid, NULL, SHM_RND);
    if(ptr == (void*)-1)
    {
        fprintf(stderr,"shmat return NULL, errno (%d: %s)\n",
                errno,strerror(errno));
        return 2;
    }

    fprintf(stdout,"shmat returned %p\n", ptr);

    sleep(1000);
    shmdt(ptr) ;

    return 0;
}
```

当执行上述程序时，可以看到如下输出：

```shell
./shm
shmid = 131075
shmat returned 0x7f555dc5c000
```

可以看到返回的标识符 ID 为 131075，该共享内存 attach 到进程的地址空间后，在进程内的地址为 `0x7f555dc5c000`。

通过查看进程的地址空间，也可以看出共享内存所在的位置，代码如下：

```shell
cat /proc/9058/maps
...
7f34c6de8000-7f34c6de9000 rw-s 00000000 00:04 131075    /SYSV00003333 (deleted)
...
```

上述输出中，字段的含义如图10-11所示。

> [!figure] 图10-11 /proc/PID/maps中的共享内存段
> 图中标注了各字段含义：起始地址-结束地址，权限（rw-s表示可读写、共享、私有？），偏移量，主设备号:次设备号，inode，路径名（/SYSV00003333 (deleted)表示使用key生成的共享内存名称）。

共享内存和 System V 消息队列及 System V 信号量有不同之处，共享内存维护了 attach 该共享内存的进程的个数，见下面输出的 `nattach` 列：

```shell
ipcs -m

------ Shared Memory Segments --------
key        shmid      owner      perms      bytes      nattch     status
0x07021999 196608     root       644        1712       2
...
```

存在引用计数，就不难猜出共享内存的删除和消息队列及信号量的删除是不同的。它并不遵循说删就删的准则，删除时会判断 attach 该共享内存的进程个数。如果尚有进程在使用该共享内存，就不会真正地删除，而是让内核负责标记一下就返回了。

正是因为 attach 操作会影响删除的行为，因此，使用共享内存的进程如果确认不再使用了，应该及时地将共享内存分离，使其离开进程的地址空间，这就是分离操作。分离会使共享内存的引用计数减1。

通过 `fork` 函数创建的子进程，会继承父进程 attach 的共享内存。因此在 `fork` 之前创建共享内存，后面父子进程就可以使用这块共享内存进行通信了。

### 10.4.4 分离共享内存

分离操作的接口定义如下：

```c
#include <sys/types.h>
#include <sys/shm.h>
int shmdt(const void *shmaddr);
```

`shmdt` 函数仅仅是使进程和共享内存脱离关系，并未删除共享内存。`shmdt` 函数的作用是将共享内存的引用计数减1。如前所述，只有共享内存的引用计数为0时，调用 `shmctl` 函数的 `IPC_RMID` 命令才会真正地删除共享内存。

进程执行 `exec` 之后，所有 attach 的共享内存都会被分离。当进程终止之后，共享内存也会自动被分离。

## 10.4.5 控制共享内存

`shmctl` 函数用来控制共享内存，函数接口定义如下：

```c
#include <sys/ipc.h>
#include <sys/shm.h>
int shmctl(int shmid, int cmd, struct shmid_ds *buf);
```

当 `cmd` 为 `IPC_STAT` 和 `IPC_SET` 时，需要用到第三个参数。其中 `shmid_ds` 结构体的定义如下：

```c
struct shmid_ds {
    struct ipc_perm shm_perm;
    size_t          shm_segsz;
    time_t          shm_atime;
    time_t          shm_dtime;
    time_t          shm_ctime;
    pid_t           shm_cpid;
    pid_t           shm_lpid;
    shmatt_t       shm_nattch;
    ...
};
```

### 1. `IPC_STAT`

用于获取 `shmid` 对应的共享内存的信息。所谓信息，就是上面结构体的内容。

`shm_perm` 中的 `mode` 字段有两个比较特殊的标志位，即 `SHM_DEST` 和 `SHM_LOCKED`。

> [!NOTE]
> **删除共享内存的延迟机制**：删除共享内存时，可能由于 attach 它的进程个数不为 0，因此只能打上一个标记，表示标记删除，待到所有 attach 该共享内存的进程都执行过分离（detach）操作，共享内存的引用计数变成 0 之后，才执行真正的删除操作。所谓的标记指的就是 `SHM_DEST` 标志位。

对于已经标记删除的共享内存，可以通过 `ipcs -m` 命令的 `status` 栏来查看，其 `dest` 含义是已经标记删除的意思。

```
key        shmid      owner      perms      bytes      nattch     status
0x00000000 32768      root       666        4096       1          dest
```

可以通过 `shmctl` 的 `SHM_LOCK` 操作将一个共享内存段锁入内存，这样它就不会被置换出去。这样做的好处是访问共享内存的时候，不会产生缺页中断（page fault）。

通过 `ipcs -m` 的输出可以查看共享内存是否被锁入内存，注意下面状态中的 `locked` 字段，该字段表明对应的共享内存已被锁入内存。

```
ipcs -m
------ Shared Memory Segments --------
key        shmid      owner      perms      bytes      nattch     status
0x00003333 32768      manu       640        4096       1          locked
```

除此以外，其他字段就顾名思义了。

- `shm_segsz`：共享内存的字节数。
- `shm_atime`：创建共享内存时设置成 0，当进程通过 `shmat` 函数 attach 共享内存时，将时间更新为当前时间。
- `shm_dtime`：创建共享内存时设置成 0，当进程调用 `shmdt` 分离共享内存时，将时间更新成当前时间。
- `shm_ctime`：当创建共享内存时，设置该值为当前时间；当调用 `IPC_SET` 操作时，更新该值为当前时间。
- `shm_nattch`：attach 该共享内存到其地址空间的进程的个数。

### 2. `IPC_SET`

`IPC_SET` 也只能修改 `shm_perm` 中的 `uid`、`gid` 及 `mode`。

### 3. `IPC_RMID`

可以通过如下方式删除共享内存段：

```c
ret = shmctl(shmid, IPC_RMID, (struct shmid_ds *) NULL);
```

如果共享内存的引用计数 `shm_nattch` 等于 0，则可以立即删除共享内存。但是如果仍然存在进程 attach 该共享内存，则并不执行真正的删除操作，而仅仅是设置 `SHM_DEST` 标记。待所有进程都执行过分离操作之后，再执行真正的删除操作。

> [!TIP]
> 值得一提的是，共享内存处于 `SHM_DEST` 状态的情况下，依然允许新的进程调用 `shmat` 函数来 attach 该共享内存。

### 4. `SHM_LOCK`

可以通过如下方式将共享内存锁定在内存之中：

```c
ret = shmctl(shmid, SHM_LOCK, (struct shmid_ds *) NULL);
```

上面的代码会将共享内存锁定在 RAM 中，而不被置换出去。这种做法可以提升共享内存的访问性能。因为进程在访问共享内存所在的分页时，不会因缺页中断而导致性能下降。

> [!WARNING]
> 注意调用 `SHM_LOCK` 并不能保证在 `shmctl` 函数结束时，所有的共享内存页已经位于 RAM 中了，当没有驻留在 RAM 中的页面因为访问需要，由缺页中断而被引入 RAM 后，该页面就会被锁定，而不会被交换出去。除非调用了下面提到的 `SHM_UNLOCK`，否则页面会一直驻留在内存中。

`SHM_LOCK` 设置的是共享内存的属性，而不是进程的属性，所以哪怕所有 attach 共享内存的进程都已终止，共享内存的页面仍被锁定在 RAM 中。故而为了防止发生资源泄漏，要及时解锁已锁定的共享内存。解锁操作可通过 `shmctl` 函数的 `SHM_UNLOCK` 来完成。

### 5. `SHM_UNLOCK`

`SHM_UNLOCK` 操作和 `SHM_LOCK` 操作相反，是解锁操作，即允许共享内存的页面被交换出去。可以通过如下方式解锁共享内存：

```c
ret = shmctl(shmid, SHM_UNLOCK, (struct shmid_ds *) NULL);
```