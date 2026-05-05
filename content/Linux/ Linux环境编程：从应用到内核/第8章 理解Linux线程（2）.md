# 第8章 理解Linux线程（2）

第7章介绍了线程的基本接口，这些基本接口非常重要，掌握了这些基本接口，就能应对大多数的应用场景。本章将介绍一些线程相关的其他内容。

## 8.1 线程取消

线程可以通过调用 `pthread_cancel` 函数来请求取消同一进程中的其他线程。

> [!WARNING]  
> 从编程的角度来讲，不建议使用这个接口。笔者对该接口的评价不高，该接口实现了一个似是而非的功能，却引入了一堆问题。陈硕在《Linux多线程服务器编程》一书中也提到过，不建议使用取消接口来使线程退出，个人表示十分赞同。

### 8.1.1 函数取消接口

Linux 提供了如下函数来控制线程的取消：

```c
int pthread_cancel(pthread_t thread);
```

一个线程可以通过调用该函数向另一个线程发送取消请求。这不是个阻塞型接口，发出请求后，函数就立刻返回了，而不会等待目标线程退出之后才返回。如果成功，该函数返回0，否则将错误码返回。

对于 glibc 实现而言，调用 `pthread_cancel` 时，会向目标线程发送一个 `SIGCANCEL` 的信号，该信号就是 6.4 节“信号的分类”中提到的被 NPTL 征用的 32 号信号。

线程收到取消请求后，会采取什么行动呢？这取决于该线程的设定。NPTL 提供了函数来设置线程是否允许取消，以及在允许取消的情况下，如何取消。

`pthread_setcancelstate` 函数用来设置线程是否允许取消，函数定义如下：

```c
int pthread_setcancelstate(int state, int *oldstate);
```

`state` 参数有两种可能的值：

- `PTHREAD_CANCEL_ENABLE`
- `PTHREAD_CANCEL_DISABLE`

如果取消状态是 `PTHREAD_CANCEL_DISABLE`，则表示线程不理会取消请求，取消请求会被暂时挂起，不予处理。

线程的默认取消状态是 `PTHREAD_CANCEL_ENABLE`。如果 `state` 是 `PTHREAD_CANCEL_ENABLE`，那么收到取消请求后，会发生什么？这取决于线程的取消类型。

`pthread_setcanceltype` 函数用来设置线程的取消类型，其定义如下：

```c
int pthread_setcanceltype(int type, int *oldtype);
```

取消类型有两种值：

- `PTHREAD_CANCEL_DEFERRED`
- `PTHREAD_CANCEL_ASYNCHRONOUS`

`PTHREAD_CANCEL_ASYNCHRONOUS` 为异步取消，即线程可能在任何时间点（可能是立即取消，但也不一定）取消线程。这种取消方式的最大问题在于，你不知道取消时线程执行到了哪一步。所以，这种取消方式太粗暴，很容易造成后续的混乱。因此不建议使用该取消方式。

`PTHREAD_CANCEL_DEFERRED` 是延迟取消，线程会一直执行，直到遇到一个取消点，这种方式也是新建线程的默认取消类型。

**什么是取消点？** 就是对于某些函数，如果线程允许取消且取消类型是延迟取消，并且线程也收到了取消请求，那么当执行到这些函数的时候，线程就可以退出了。

标准规定了很多函数必须是取消点，由于太多（有好几十个之多），就不一一罗列了，通过 `man pthreads` 可以查询到这些取消点函数。

线程执行到取消点，会自动处理取消请求，但是如果线程没有用到任何取消点函数，那该怎么办，如何响应取消请求？

为了应对这种场景，系统引入了 `pthread_testcancel` 函数，该函数一定是取消点。所以编程者可以周期性地调用该函数，只要有取消请求，线程就能响应。该函数定义如下：

```c
void pthread_testcancel(void);
```

如果线程被取消，并且其分离状态是可连接的，那么需要由其他线程对其进行连接。连接之后，`pthread_join` 函数的第二个参数会被置成 `PTHREAD_CANCELED`，通过该值可以知道线程并不是“寿终正寝”，而是被其他线程取消而导致的退出。

#### 线程取消的弊端

接口都介绍完了，是时候讨论下线程取消的弊端了。线程取消是一种在线程的外部强行终止线程的执行做法，由于无法预知目标线程内部的情况，尤其是第一种异步取消类型，因此可能会带来毁灭性的结果。

目标线程可能会持有互斥量、信号量或其他类型的锁，这时候如果收到取消请求，并且取消类型是异步取消，那么可能目标线程掌握的资源还没有来得及释放就被迫退出了，这可能会给其他线程带来不可恢复的后果，比如死锁（其他线程再也无法获得资源）。

即使执行异步取消也安然无恙的函数称为**异步取消安全函数**（async-cancel-safe function），手册里说只有下述三个函数是异步取消安全函数，所以对于其他函数，一律都不是异步取消安全函数：

- `pthread_cancel()`
- `pthread_setcancelstate()`
- `pthread_setcanceltype()`

所以对编程人员而言，应该遵循以下原则：

> [!IMPORTANT]
> - 第一，轻易不要调用 `pthread_cancel` 函数，在外部杀死线程是很糟糕的做法，毕竟如果想通知目标线程退出，还可以采取其他方法。
> - 第二，如果不得不允许线程取消，那么在某些非常关键不容有失的代码区域，暂时将线程设置成不可取消状态，退出关键区域之后，再恢复成可以取消的状态。
> - 第三，在非关键的区域，也要将线程设置成延迟取消，永远不要设置成异步取消。

### 8.1.2 线程清理函数

假设遇到取消请求，线程执行到了取消点，却没有来得及做清理动作（如动态申请的内存没有释放，申请的互斥量没有解锁等），可能会导致错误的产生，比如死锁，甚至是进程崩溃。

下面来看一个简单的例子：

```c
void* cancel_unsafe(void*) {
    static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
    pthread_mutex_lock(&mutex);              // 此处不是撤消点
    struct timespec ts = {3, 0};
    nanosleep(&ts, 0);                        // 是撤消点
    pthread_mutex_unlock(&mutex);          // 此处不是撤消点
    return 0;
}

int main(void) {
    pthread_t t;
    pthread_create(&t, 0, cancel_unsafe, 0);
    pthread_cancel(t);
    pthread_join(t, 0);
    cancel_unsafe(0); // 发生死锁!
    return 0;
}
```

在上面的例子中，`nanosleep` 是取消点，如果线程执行到此处时被其他线程取消，就会出现以下情况：互斥量还没有解锁，但持有锁的线程已不复存在。这种情况下其他线程再也无法申请到互斥量，很有可能在某处就会陷入死锁的境地。

为了避免这种情况，线程可以设置一个或多个**清理函数**，线程取消或退出时，会自动执行这些清理函数，以确保资源处于一致的状态。其相关接口定义如下：

```c
void pthread_cleanup_push(void (*routine)(void *), void *arg);
void pthread_cleanup_pop(int execute);
```

标准允许用宏（macro）来实现这两个接口，Linux 就是用宏来实现的。这意味着这两个函数必须同时出现，并且属于**同一个语法块**。

**何为同一个语法块？** 比较难解释，我尝试来解释一下它的反面。如果两个函数在不同的函数中出现，它们就不是处于同一个语法块。示例代码如下：

```c
void foo()
{
    .....
    pthread_cleanup_pop(0)
    .....
}

void *thread_work(void *arg)
{
    ......
    pthread_cleanup_push(clean, clean_arg);
    ......
    foo()
    ......
}
```

这个例子比较简单，因为 `pthread_cleanup_push` 在线程的主函数里面，而 `pthread_cleanup_pop` 在另外一个函数里面，这一对函数明显不在一个语法块里面。

上面这种错误是很好防范的，比较难防范的是下面这种：

```c
pthread_cleanup_push(clean_func, clean_arg);
......
if(cond)
{
    pthread_cleanup_pop(0);
}
```

在日常编码中很容易犯上面这种错误。因为 `pthread_cleanup_push` 和 `pthread_cleanup_pop` 的实现中包含了 `{` 和 `}`，所以将 pop 放入 `if{}` 的代码块中，会导致括号匹配错乱，最终会引发编译错误。

**第二个需要注意的是**，可以注册多个清理函数，如下所示：

```c
pthread_cleanup_push(clean_func_1, clean_arg_1)
pthread_cleanup_push(clean_func_2, clean_arg_2)
...
pthread_cleanup_pop(execute_2);
pthread_cleanup_pop(execute_1);
```

从 push 和 pop 的名字可以看出，这是栈的风格，后入先出，就是后注册的清理函数会先执行。

其中 `pthread_cleanup_pop` 的用处是，删除注册的清理函数。如果参数是非0值，那么执行一次，再删除清理函数。否则的话，就直接删除清理函数。

**第三个问题最关键**，何时会触发注册的清理函数：

- 当线程的主函数是调用 `pthread_exit` 返回的，清理函数总是会被执行。
- 当线程是被其他线程调用 `pthread_cancel` 取消的，清理函数总是会被执行。
- 当线程的主函数是通过 `return` 返回的，并且 `pthread_cleanup_pop` 的唯一参数 `execute` 是 0 时，清理函数不会被执行。
- 当线程的主函数是通过 `return` 返回的，并且 `pthread_cleanup_pop` 的唯一参数 `execute` 是非零值时，清理函数会执行一次。

下面看下示例代码：

```c
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <string.h>

void clean(void* arg)
{
    printf("CLEAN_UP:%s\n", (char*)arg);
}

void *thread(void *param)
{
    int input = (int)param;
    printf("thread start\n");
    pthread_cleanup_push(clean, "first cleanup handler");
    pthread_cleanup_push(clean, "second cleanup handler");
    /*work logic here*/
    if(input != 0){
        /* pthread_exit退出,清理函数总会被执行 */
        pthread_exit((void*)1);
    }
    pthread_cleanup_pop(0);
    pthread_cleanup_pop(0);
    /* return 返回,如果上面pop函数的参数是0,则不会执行清理函数 */
    return ((void *)0);
}

int main()
{
    pthread_t tid;
    void *res;
    int ret;

    ret = pthread_create(&tid, NULL, thread, (void*)0);
    if(ret != 0)
    {
        /*error handle here*/
        return -1;
    }
    pthread_join(tid, &res);
    printf("first thread exit, return code is %d\n", (int)res);

    ret = pthread_create(&tid, NULL, thread, (void*)1);
    if(ret != 0)
    {
         /*error handle here*/
         return -1;
    }
    pthread_join(tid, &res);
    printf("second thread exit, return code is %d\n", (int)res);
    return 0;
}
```

当线程用 `return` 退出，并且 `pthread_cleanup_pop` 的参数是 0 时，那么注册的清理函数不被执行：

```
thread start
first thread exit, return code is 0
thread start
CLEAN_UP:second cleanup handler
CLEAN_UP:first cleanup handler
second thread exit, return code is 1
```

如果将上面示例代码中的 `pthread_cleanup_pop` 的参数改成1，就会发现，无论是调用 `pthread_exit` 函数返回，还是在线程的主函数中调用 `return` 返回，都会调用清理函数：

```
thread start
CLEAN_UP:second cleanup handler
CLEAN_UP:first cleanup handler
first thread exit, return code is 0
thread start
CLEAN_UP:second cleanup handler
CLEAN_UP:first cleanup handler
second thread exit, return code is 1
```

有了清理函数，本节开头处提到的例子就可以改进为如下形式了：

```c
void cleanup(void* mutex) {
    pthread_mutex_unlock((pthread_mutex_t*)mutex);
}

void* cancel_unsafe(void*) {
    static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
    pthread_cleanup_push(cleanup, &mutex);
    pthread_mutex_lock(&mutex);
    struct timespec ts = {3, 0};
    nanosleep(&ts, 0);
    pthread_mutex_unlock(&mutex);
    pthread_cleanup_pop(0);
    return 0;
}
```

在这种情况下，如果线程被取消，清理函数则会负责解锁操作。

## 8.2 线程局部存储

[[errno]] 变量是线程局部存储的典型案例。我们可以通过该案例来理解引入线程局部存储的意义。

在多线程引入之前，由于进程只有一条控制流（暂不考虑信号处理函数），因此当函数调用出错时，可以通过设置全局的 `errno` 来提示遇到的错误类型。代码如下所示：

```c
int f = open (...);
if (f < 0)
    printf ("error %d encountered\n", errno);
```

但是自从引入多线程之后，情况就发生了变化。如果 `errno` 仍然是进程内的全局变量，就会引起混乱。考虑如下两个线程分别执行如下代码：

| 线程 1 | 线程 2 |
|--------|--------|
| `int f = open (...);` | `int s = socket (...);` |
| `if (f < 0)` | `if (s < 0)` |
| `printf ("error %d encountered\n", errno);` | `printf ("error %d encountered\n", errno);` |

当两个线程同时执行这两部分代码并且几乎同时出错的话，后一个出错时设置的 `errno` 的值会覆盖前一个出错时设置的 `errno`。因此至少有一个输出的 `errno` 是不对的。

对于这个问题，一种解决的方法是这样的：

```c
int local_errno
int f = open(..., &local_errno)
if (f < 0)
    printf ("error %d encountered\n", local_errno);
```

这种方法固然可以做到对多线程的支持，但是在现实中不具备可操作性。大量的函数接口已经存在很久，改变接口意味着不兼容历史代码。对 `errno` 而言，比较好的方案是既要能应对多线程，又不需要改变既有的接口。

这时候，**线程局部存储**（Thread Local Storage）就横空出世了。使用线程局部存储技术就能满足上述的需求。该技术为每一个线程都分别维护一个变量的副本，尽管名字相同却分别存储，并行不悖。

在 Linux 下有两种方法可以实现线程局部存储：

- 使用 NPTL 提供的函数。
- 使用编译器扩展的 `__thread` 关键字。

### 8.2.1 使用 NPTL 库函数实现线程局部存储

NPTL 提供了一个函数接口来实现线程局部存储的功能：

```c
int pthread_key_create(pthread_key_t *key, void (*destructor)(void*));
int pthread_key_delete(pthread_key_t key);
int pthread_setspecific(pthread_key_t key, const void *value);
void *pthread_getspecific(pthread_key_t key);
```

其中，`pthread_key_create` 函数会为线程局部存储创建一个新键，并通过给 `key` 赋值，返回给用户使用。

因为进程中的所有线程都可以使用返回的键，所以参数 `key` 应该指向一个全局变量。

参数 `destructor` 指向一个自定义的函数：

```c
void * destructor(void *value)
{
    /* 多是为了释放 value 指针指向的资源 */
}
```

线程终止时，如果 `key` 关联的值不是 `NULL`，那么 NPTL 会自动执行定义的 `destructor` 函数。如果无须解构，可以将 `destructor` 设置为 `NULL`。

这几个接口比较晦涩，很难从接口上想到如何使用线程局部存储。下面通过一个例子来说明如何使用这些接口。在下面的例子里，程序希望每一个线程将自己的 log 输出到各自独立的文件。

```c
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

/* 用于为每个线程保存文件指针的 TSD 键值,根据键值可以找到线程各自的 Data. */
static pthread_key_t thread_log_key;

void write_to_thread_log(const```c
void write_to_thread_log(const char *message)
{
    FILE* thread_log = (FILE*)pthread_getspecific(thread_log_key);
    fprintf(thread_log, "%s\n", message);
}

void fn_close_thread_log(void *thread_log)
{
    fclose((FILE *)thread_log);
}

void *thread_function(void *args)
{
    char thread_log_filename[128];
    FILE *thread_log;
    sprintf(thread_log_filename, "thread%ld.log",
            (unsigned long)pthread_self());
    thread_log = fopen(thread_log_filename, "w");
    /* 将文件指针保存在 thread_log_key 标识的 TSD 中。 */
    pthread_setspecific(thread_log_key, thread_log);
    write_to_thread_log("Thread starting.");
    return NULL;
}

int main()
{
    int i;
    pthread_t threads[5];
    /* 创建一个键值，用于将线程日志文件指针保存在 TSD 中。
     * 调用 close_thread_log 以关闭这些文件指针。
     */
    pthread_key_create(&thread_log_key, fn_close_thread_log);
    for(i = 0; i < 5; ++i)
        pthread_create(&(threads[i]), NULL, thread_function, NULL);
    for(i = 0; i < 5; ++i)
        pthread_join(threads[i], NULL);
    return 0;
}
```

上面的程序首先调用 `pthread_key_create` 函数来申请一个槽位.在 NPTL 实现下,`pthread_key_t` 是无符号整型,`pthread_key_create` 调用成功时会将一个小于 1024 的值填入第一个入参指向的 `pthread_key_t` 类型的变量中.

为什么键值总是要小于 1024?那是因为 NPTL 实现一共提供了 1024 个槽位.

如图 8-1 所示,记录槽位分配情况的数据结构 `pthread_keys` 是进程唯一的.对于上面的示例代码而言,第一次调用 `pthread_key_create` 毫无疑问会领到 slot 0.即 `thread_log_key` 的值为 0,表示占用了 0 号槽位,如图 8-1 所示.

> **图 8-1(文字描述)**:`pthread_keys` 是一个进程全局的数组(或类似结构),记录了各个槽位的分配状态.初始时所有槽位都空闲.调用 `pthread_key_create` 后,在数组中找到一个空闲槽位(如 slot 0),并将该槽位标记为已使用,同时将槽位号(0)返回给调用者.此后,每个线程都可以通过该 key 访问自己私有的数据.

目前,各个线程还没有数据和该 key 相关联.接下来线程函数通过调用 `pthread_setspecific` 函数,将 key 分别与各自的线程数据关联起来.

```c
pthread_setspecific(thread_log_key, thread_log);
```

每个线程在槽位号 0 各自指向了线程自己的数据.从此处开始分家,key 是同一个 key,但每个线程指向的数据各不相同(如图 8-2 所示).

> **图 8-2(文字描述)**:同一个 key(例如 slot 0)在不同的线程中指向不同的数据块.线程 1 的 slot 0 指向线程 1 的文件指针,线程 2 的 slot 0 指向线程 2 的文件指针,...... 每个线程都有自己独立的副本.

线程如果想要使用各自的值怎么办?拿这个 key,去找到与 key 关联的数据结构,这是 `pthread_getspecific` 函数的职责所在.

```c
FILE* thread_log = (FILE *)pthread_getspecific(thread_log_key);
```

因为线程知道 key 关联的数据结构是什么类型,所以可以从 key 直接获取到 key 指向的 value.取到线程的特有数据之后,就可以操作了.

由于 key 属于全局变量,因此取到的线程特有数据 value 就变成了线程内部的“全局变量”.

1024 个 key,对于普通的应用来说足够了.如果一个多线程应用确实需要很多的线程特有数据,那么可以将其封装在一个数据结构之内.

这种方法,允许的键值个数有限并不是问题的关键,**问题的关键是它的接口太难用了**,接口设计得有点反人类.

### 8.2.2 使用 `__thread` 关键字实现线程局部存储

由于 8.2.1 节提供的接口太难用,有人想到了在编译器中增加新功能,支持特定的关键字 `__thread`,隐式地构造线程局部变量.

它的使用方法非常简单:

```c
__thread int val = 0;
```

凡是带有 `__thread` 关键字的变量,每个线程都会有该变量的一个拷贝,并行不悖,互不干扰.该局部变量一直都在,直到线程退出为止.

**使用线程局部变量需要注意以下几点:**

- 如果变量声明中使用了关键字 `static` 或 `extern`,那么关键字 `__thread` 应该紧随其后.
- 声明时,可以正常初始化.
- 可以通过取地址操作符(`&`)获取到线程局部变量的地址.

同样的例子,用 `__thread` 关键字来实现就自然多了,代码如下:

```c
#include <malloc.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

__thread FILE* thread_log = NULL;

void write_to_thread_log(const char *message)
{
    fprintf(thread_log, "%s\n", message);
}

void *thread_function(void *args)
{
    char thread_log_filename[128];
    sprintf(thread_log_filename, "thread%ld.log",
            (unsigned long)pthread_self());
    thread_log = fopen(thread_log_filename, "w");
    write_to_thread_log("Thread starting.");
    fclose(thread_log);
    return NULL;
}

int main()
{
    int i;
    pthread_t threads[5];
    for(i = 0; i < 5; ++i)
        pthread_create(&(threads[i]), NULL, thread_function, NULL);
    for(i = 0; i < 5; ++i)
        pthread_join(threads[i], NULL);
    return 0;
}
```

线程局部存储需要内核、Pthreads 实现和 C 编译器提供支持.对线程局部存储(Thread Local Storage)的实现感兴趣的话,Ulrich Drepper 著有 “ELF Handling For Thread-Local Storage” 一文,是非常好的参考资料.

## 8.3 线程与信号

信号出现地要比线程早,所以设计信号时,尚没有线程.在引入线程之后,如何设计信号成了一个难点.既要保证传统的语义不变,又要设计出适用于多线程环境的信号模型,确实难度不小.

在第 6 章“信号”一章中,已基本讲清楚了多线程和信号的关系,以及内核如何实现.在此,仅仅总结一下:

- 信号处理函数是进程层面的概念,或者说是线程组层面的概念,线程组内所有线程共享对信号的处理函数.
- 对于发送给进程的信号,内核会任选一个线程来执行信号处理函数,执行完后,会将其从挂起信号队列中去除,其他线程不会对一个信号重复响应.
- 可以针对进程中的某个线程发送信号,那么只有该线程能响应,执行相应的信号处理函数.
- 信号掩码是线程层面的概念,信号处理函数在线程组内是统一的,但是信号掩码是各自独立可配置的,各个线程独立配置自己要阻止或放行的信号集合.
- 挂起信号(内核已经收到,但尚未递送给线程处理的信号)既是针对进程的,又是针对线程的.内核维护两个挂起信号队列,一个是进程共享的挂起信号队列,一个是线程特有的挂起信号队列.调用函数 `sigpending` 返回的是两者的并集.对于线程而言,优先递送发给线程自身的信号.

上面这些内容,基本概括了多线程条件下信号的模型.内核如何做到这些模型,在第 6 章中基本都有介绍,在此处就不再赘述了.


## 8.3.1 设置线程的信号掩码

前面已提到过,信号掩码是针对线程的,每个线程都可以自行设置自己的信号掩码.如果自己不设置,就会继承创建者的信号掩码.

NPTL实现了如下接口来设置线程的信号掩码:

```c
#include <signal.h>
int pthread_sigmask(int how, const sigset_t *new, sigset_t *old);
```

`how`的值用来指定如何更改信号组:
- `SIG_BLOCK`:向当前信号掩码中添加`new`,其中`new`表示要阻塞的信号组.
- `SIG_UNBLOCK`:从当前信号掩码中删除`new`,其中`new`表示要取消阻塞的信号组.
- `SIG_SETMASK`:将当前信号掩码替换为`new`,其中`new`表示新的信号掩码.

该接口的使用方式和`sigprocmask`一模一样,在Linux上,两个函数的实现是相同的.

> [!NOTE]
> `SIGCANCEL`和`SIGSETXID`信号被用于NPTL实现,因此用户不能也不应该改变这两个信号的行为方式.好在用户不用操心这两个信号,`sigprocmask`函数和`pthread_sigmask`函数对这两者都做了特殊处理.

## 8.3.2 向线程发送信号

第6章提到过向线程发送信号的系统调用`tkill/`tgkill,无奈glibc并未将它们封装成可以直接调用的函数.不过,幸好提供了另外一个函数:

```c
int pthread_kill(pthread_t thread, int sig);
```

由于`pthread_t`类型的线程ID只在线程组内是唯一的,其他进程完全可能存在线程ID相同的线程,所以`pthread_kill`只能向同一个进程的线程发送信号.

除了这个接口外,Linux还提供了特有的函数将`pthread_kill`和`sigqueue`功能累加在一起:

```c
#define _GNU_SOURCE
#include <pthread.h>
int pthread_sigqueue(pthread_t thread, int sig,
               const union sigval value);
```

这个接口和`sigqueue`一样,可以发送携带数据的信号.当然,只能发给同一个进程内的线程.

## 8.3.3 多线程程序对信号的处理

单线程的程序,对信号的处理已经比较复杂了.因为信号打断了进程的控制流,所以信号处理函数只能调用异步信号安全的函数.而异步信号安全是个很苛刻的条件.

多线程的引入,加剧了这种复杂度.因为信号可以发送给进程,也可以发送给进程内的某一线程.不同线程还可以设置自己的掩码来实现对信号的屏蔽.而且,没有一个线程相关的函数是异步信号安全的,信号处理函数不能调用任何pthread函数,也不能通过条件变量来通知其他线程.

正如陈硕在《Linux多线程服务器编程》中提到的,在多线程程序中,使用信号的第一原则就是不要使用信号.

- 不要主动使用信号作为进程间通信的手段,收益和引入的风险完全不成比例.
- 不主动改变异常处理信号的信号处理函数.用于管道和socket的`SIGPIPE`可能是例外,默认语义是终止进程,很多情况下,需要忽略该信号.
- 如果无法避免,必须要处理信号,那么就采用`sigwaitinfo`或`signalfd`的方式同步处理信号,减少异步处理带来的风险和引入bug的可能.

在第6章中,曾经分析了如何使用`sigwaitinfo`函数和`signalfd`同步地处理信号,此处就不再赘述了.

## 8.4 多线程与fork()

多线程和`fork`函数的协作性非常差.对于多线程和`fork`,最重要的建议就是永远不要在多线程程序里面调用`fork`.

> [!WARNING]
> 请跟我再念一遍:永远不要在多线程程序里面调用`fork`.

Linux的`fork`函数,会复制一个进程,对于多线程程序而言,`fork`函数复制的是调用`fork`的那个线程,而并不复制其他的线程.fork之后其他线程都不见了.Linux不存在`forkall`语义的系统调用,无法做到将多线程全部复制.

多线程程序在`fork`之前,其他线程可能正持有互斥量处理临界区的代码.fork之后,其他线程都不见了,那么互斥量的值可能处于不可用的状态,也不会有其他线程来将互斥量解锁.

下面用一个例子来描述这种场景:

```c
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/wait.h>

static void* worker(void* arg)
{
    pthread_detach(pthread_self());
    for (;;)
    {
        setenv("foo", "bar", 1);
        usleep(100);
    }
    return NULL;
}

static void sigalrm(int sig)
{
    char a = 'a';
    write(fileno(stderr), &a, 1);
}

int main()
{
    pthread_t setenv_thread;
    pthread_create(&setenv_thread, NULL, worker, 0);
    for (;;)
    {
        pid_t pid = fork();
        if (pid == 0)
        {
            signal(SIGALRM, sigalrm);
            alarm(1);
            unsetenv("bar");
            exit(0);
        }
        wait3(NULL, WNOHANG, NULL);
        usleep(2500);
    }
    return 0;
}
```

上面的代码比较简单,创建了一个线程周期性地执行`setenv`函数,修改环境变量.主线程会`fork`子进程,子进程负责执行`unsetenv`函数,同时调用了`alarm`,一秒钟后会收到`SIGALRM`信号.子进程通过执行`signal`函数,注册了`SIGALRM`信号的处理函数,即向标准错误打印字母‘`a`’.

`fork`创建的子进程在调用`alarm`注册的闹钟之后,只执行`unsetenv`函数,然后就会调用`exit`退出.因此,在正常情况下子进程很快就会退出,`alarm`约定的1秒钟时间还未到就退出了.也就是说,信号处理函数不应该被执行,自然也就不应该打印出字母‘`a`’.

可是实际情况是:

```
./thread_fork
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^C
```

原因何在?在某些情况下,子进程为什么不能及时退出,以至于过了1秒之后,子进程还没有退出?

选择一个阻塞的线程,用gdb调试下,看看到底阻塞在何处.

```
(gdb) bt
#0  __lll_lock_wait_private () at ../nptl/sysdeps/unix/sysv/linux/x86_64/lowlevellock.S:95
#1  0x00007fd5c50270f6 in _L_lock_740 () from /lib/x86_64-linux-gnu/libc.so.6
#2  0x00007fd5c5026f2a in __unsetenv (name=0x400b24 "bar") at setenv.c:325
#3  0x0000000000400a6d in main () at fork.c:41
```

可以看出调用`unsetenv`的时候,子进程就被卡住了.

为什么?

现在的库函数,为了做到可重入,其内部维护的变量通常会使用互斥量来保护.这些锁对用户一般是透明的,用户也不关心.`setenv`和`unsetenv`就是这样.尽管上述代码并没有显式地定义,但是进程内部已经维护了一个互斥量.

互斥量中维护了一个锁的值:0表示未上锁,1表示已上锁但是没有等待线程,2表示已上锁,并且有线程等待该锁.对于我们的例子而言,由于线程每100微秒就执行一次`setenv`,很有可能在主线程调用`fork`创建子进程的瞬间,互斥量的值是1.而这个值1被拷贝到了子进程.

对于父进程而言互斥量的值是1自然没有关系,因为父进程中有线程worker不停地加锁、解锁.但是子进程的情况就不同了,子进程中没有worker.子进程自创建成功开始,`setenv`相关的互斥量的值就一直是1.子进程调用`unsetenv`函数时,“地雷”被引爆了.`unsetenv`无法获得互斥量,反而是通过调用`futex`系统调用陷入休眠,内核将其挂入对应的等待队列.

父进程的worker线程的解锁操作会唤醒子进程吗?

下面是内核`get_futex_key`函数中的部分代码:

```c
if (!fshared) {
    if (unlikely(!access_ok(VERIFY_WRITE, uaddr, sizeof(u32))))
       return -EFAULT;
    key->private.mm = mm;
    key->private.address = address;
    get_futex_key_refs(key);
    return 0;
}
```

新建立的futex使用`mm`结构指针和地址`address`作为futex的键值，由于父子进程之间并不共享`mm_struct`，也就是说子进程的futex和父进程futex并不共享等待队列。换句话说，父进程通过`setenv`解锁时，根本就不会唤醒子进程。因此，子进程永远都不可能被唤醒了。

这仅仅是`setenv`/`unsetenv`函数，库函数中类似这种的函数并不少见：

- `malloc`函数的内部实现一定会有锁。
- `printf`系列的函数，其他线程可能持有stdout/stderr的锁。
- `syslog`函数内部实现也会用到锁。

综合上面的讨论，唯一安全的做法是，`fork`之后子进程立即调用`exec`执行另外的程序，彻底断绝子进程与父进程之间的关系，注意是立即，不要在调用`exec`之前执行任何语句，哪怕是不起眼的`printf`。