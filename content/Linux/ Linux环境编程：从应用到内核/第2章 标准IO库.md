# 第2章 标准I/O库

前面的章节介绍的是Linux的系统调用。本章将从[[标准I/O库]]开始讲解Linux环境编程中不可或缺的C库。在学习和分析标准I/O库的同时，与Linux的I/O系统调用进行比较，可以加深对两者的认识和理解。

## 2.1　stdin、stdout和stderr

当Linux新建一个进程时，会自动创建3个文件描述符0、1和2，分别对应标准输入、标准输出和错误输出。C库中与文件描述符对应的是文件指针，与文件描述符0、1和2类似，我们可以直接使用文件指针`stdin`、`stdout`和`stderr`。那么这是否意味着`stdin`、`stdout`和`stderr`是“自动打开”的文件指针呢？

查看C库头文件`stdio.h`中的源码：

```c
typedef struct _IO_FILE FILE;
/* Standard streams.  */
extern struct _IO_FILE *stdin;      /* Standard input stream.  */
extern struct _IO_FILE *stdout;     /* Standard output stream.  */
extern struct _IO_FILE *stderr;     /* Standard error output stream.  */
#ifdef __STDC__
/* C89/C99 say they're macros.  Make them happy.  */
#define stdin stdin
#define stdout stdout
#define stderr stderr
#endif
```

从上面的源码可以看出，`stdin`、`stdout`和`stderr`确实是文件指针。而C标准要求`stdin`、`stdout`和`stderr`是宏定义，所以在C库的代码中又定义了同名宏。

那么`stdin`、`stdout`和`stderr`又是如何定义的呢？定义代码如下：

```c
_IO_FILE *stdin = (FILE *) &_IO_2_1_stdin_;
_IO_FILE *stdout = (FILE *) &_IO_2_1_stdout_;
_IO_FILE *stderr = (FILE *) &_IO_2_1_stderr_;
```

继续查看`_IO_2_1_stdin_`等的定义，代码如下：

```c
DEF_STDFILE(_IO_2_1_stdin_, 0, 0, _IO_NO_WRITES);
DEF_STDFILE(_IO_2_1_stdout_, 1, &_IO_2_1_stdin_, _IO_NO_READS);
DEF_STDFILE(_IO_2_1_stderr_, 2, &_IO_2_1_stdout_, _IO_NO_READS+_IO_UNBUFFERED);
```

`DEF_STDFILE`是一个宏定义，用于初始化C库中的`FILE`结构。这里`_IO_2_1_stdin`、`_IO_2_1_stdout`和`_IO_2_1_stderr`这三个`FILE`结构分别用于文件描述符0、1和2的初始化，这样C库的文件指针就与系统的文件描述符互相关联起来了。大家注意最后的标志位，`stdin`是不可写的，`stdout`是不可读的，而`stderr`不仅不可读，且没有缓存。

通过上面的分析，可以得到一个结论：`stdin`、`stdout`和`stderr`都是`FILE`类型的文件指针，是由C库静态定义的，直接与文件描述符0、1和2相关联，所以应用程序可以直接使用它们。

## 2.2　I/O缓存引出的趣题

C库的I/O接口对文件I/O进行了封装，为了提高性能，其引入了缓存机制，共有三种缓存机制：[[全缓存]]、[[行缓存]]及[[无缓存]]。

- **全缓存**一般用于访问真正的磁盘文件。C库会为文件访问申请一块内存，只有当文件内容将缓存填满或执行冲刷函数`flush`时，C库才会将缓存内容写入内核中。
- **行缓存**一般用于访问终端。当遇到一个换行符时，就会引发真正的I/O操作。需要注意的是，C库的行缓存也是固定大小的。因此，当缓存已满，即使没有换行符时也会引发I/O操作。
- **无缓存**，顾名思义，C库没有进行任何的缓存。任何C库的I/O调用都会引发实际的I/O操作。

C库提供了接口，用于修改默认的缓存行为，相关代码如下：

```c
#include <stdio.h>
void setbuf(FILE *stream, char *buf);
void setbuffer(FILE *stream, char *buf, size_t size);
void setlinebuf(FILE *stream);
int setvbuf(FILE *stream, char *buf, int mode, size_t size);
```

下面看一个跟C库缓存相关的趣题。

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(void)
{
    printf("Hello ");
    if (0 == fork()) {
        printf("child\n");
        return 0;
    }
    printf("parent\n");
    return 0;
}
```

其输出结果是什么？正确的结果是：

```
Hello parent
Hello child
```

或者：

```
Hello child
Hello parent
```

之所以是这样的结果，就是因为背后的行缓存。执行`printf("Hello")`时，因为`printf`是向标准输出打印的，因此使用的是行缓存。字符串`Hello`没有换行符，所以并没有真正的I/O输出。当执行`fork`时，子进程会完全复制父进程的内存空间，因此字符串`Hello`也存在于子进程的行缓存中。故而最后的输出结果中，无论是父进程还是子进程都有`Hello`字符串。

## 2.3　fopen和open标志位对比

C库的`fopen`用于打开文件，其内部实现必然要使用`open`系统调用。那么`fopen`的各个标志位又对应`open`的哪些标志位呢？请看表2-1。

**表2-1　fopen标志位和open标志位对应表**

> [!NOTE] 表格说明
> 原书有表2-1展示常用标志位的对应关系，此处省略具体表格内容，保留文字描述。

表2-1是`fopen`常用的标志位，实际上`fopen`还有更多的标志位，这也是很多书籍没有涉及的，具体见表2-2。

**表2-2　更多的fopen和open标志位对应**

> [!NOTE] 表格说明
> 原书有表2-2展示更多标志位的对应关系，此处省略具体表格内容，保留文字描述。

下面进入glibc的源码，查看函数`_IO_new_file_fopen`来验证上面的结论。

```c
_IO_FILE *
_IO_new_file_fopen (fp, filename, mode, is32not64)
     _IO_FILE *fp;
     const char *filename;
     const char *mode;
     int is32not64;
{
  int oflags = 0, omode;
  int read_write;
  int oprot = 0666;
  int i;
  _IO_FILE *result;
#ifdef _LIBC
  const char *cs;
  const char *last_recognized;
#endif
  if (_IO_file_is_open (fp))
    return 0;
  switch (*mode)
    {
    case 'r':
      omode = O_RDONLY;
      read_write = _IO_NO_WRITES;
      break;
    case 'w':
      omode = O_WRONLY;
      oflags = O_CREAT|O_TRUNC;
      read_write = _IO_NO_READS;
      break;
    case 'a':
      omode = O_WRONLY;
      oflags = O_CREAT|O_APPEND;
      read_write = _IO_NO_READS|_IO_IS_APPENDING;
      break;
    default:
      __set_errno (EINVAL);
      return NULL;
    }
#ifdef _LIBC
  last_recognized = mode;
#endif
  for (i = 1; i < 7; ++i)
    {
      switch (*++mode)
    {
    case '\0':
      break;
    case '+':
      omode = O_RDWR;
      read_write &= _IO_IS_APPENDING;
#ifdef _LIBC
      last_recognized = mode;
#endif
      continue;
    case 'x':
      oflags |= O_EXCL;
#ifdef _LIBC
      last_recognized = mode;
#endif
      continue;
    case 'b':
#ifdef _LIBC
      last_recognized = mode;
#endif
      continue;
    case 'm':
      fp->_flags2 |= _IO_FLAGS2_MMAP;
      continue;
    case 'c':
      fp->_flags2 |= _IO_FLAGS2_NOTCANCEL;
      continue;
    case 'e':
#ifdef O_CLOEXEC
      oflags |= O_CLOEXEC;
#endif
      fp->_flags2 |= _IO_FLAGS2_CLOEXEC;
      continue;
    default:
      /* Ignore.  */
      continue;
    }
      break;
    }
  result = _IO_file_open (fp, filename, omode|oflags, oprot, read_write,
            is32not64);
}
```

上面的源代码非常简单，很容易理解。每个`mode`都是`switch`语句的一个`case`，`oflags`就是要传给`open`的标志位，这就验证了前文的结论。

## 2.4　fdopen与fileno

Linux提供了文件描述符，而C库又提供了文件流。在平时的工作中，有时候需要在两者之间进行切换，因此C库提供了两个API：

```c
#include <stdio.h>
FILE *fdopen(int fd, const char *mode);
int fileno(FILE *stream);
```

`fdopen`用于从文件描述符`fd`生成一个文件流`FILE`，而`fileno`则用于从文件流`FILE`得到对应的文件描述符。

查看`fdopen`的实现，其基本工作是创建一个新的文件流`FILE`，并建立文件流`FILE`与描述符的对应关系。我们以`fileno`的简单实现，来了解文件流`FILE`与文件描述符`fd`的关系。——因为该函数代码较长，在此就不罗列C库的代码了。代码如下：

```c
int fileno (_IO_FILE* fp)
{
    CHECK_FILE (fp, EOF);
    if (!(fp->_flags & _IO_IS_FILEBUF) || _IO_fileno (fp) < 0)
    {
         __set_errno (EBADF);
         return -1;
    }
    return _IO_fileno (fp);
}
#define _IO_fileno(FP) ((FP)->_fileno)
```

从`fileno`的实现基本上就可以得知文件流与文件描述符的对应关系。文件流`FILE`保存了文件描述符的值。当从文件流转换到文件描述符时，可以直接通过当前`FILE`保存的值`_fileno`得到`fd`。而从文件描述符转换到文件流时，C库返回的都是一个重新申请的文件流`FILE`，且这个`FILE`的`_fileno`保存了文件描述符。

因此无论是`fdopen`还是`fileno`，关闭文件时，都要使用`fclose`来关闭文件，而不是用`close`。因为只有采用此方式，`fclose`作为C库函数，才会释放文件流`FILE`占用的内存。

## 2.5　同时读写的痛苦

前面介绍过内核的文件描述符实现。在内核中，每一个文件描述符`fd`都对应了一个文件管理结构`struct file`——用于维护该文件描述符的信息，如偏移量等。在第1章对`read`和`write`的源码分析中，可以发现每一次系统调用的`read`和`write`成功返回后，文件的偏移量都会被更新。

因此，如果程序对同一个文件描述符进行读写操作的话，肯定会得到非期望的结果，示例代码如下：

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void)
{
    char buf[20];
    int ret;
    FILE *fp = fopen("./tmp.txt", "w+");
    if (!fp) {
        printf("Fail to open file\n");
        return -1;
    }
    ret = fwrite("123", sizeof("123"), 1, fp);
    printf("we write %d member\n", ret);
    memset(buf, 0, sizeof(buf));
    ret = fread(buf, 1, 1, fp);
    printf("We read %s, ret is %d\n", buf, ret);
    fwrite("456", sizeof("456"), 1, fp);
    fclose(fp);
    return 0;
}
```

上面的代码中，利用`fopen`的读写模式打开了一个文件流，先写入一个字符串`"123"`，然后读取一个字节，再写入一个字符串`"456"`。

大家想想输出结果会是什么呢？`fread`读取的字符又会是什么呢？是否为`'1'`呢？请看下面的结果：

```
[fgao@ubuntu chapter2]#./a.out
we write 1 member
We read , ret is 0
```

为什么`fread`什么都没有读取到，返回值是0呢？这是因为上面的代码中，`fwrite`和`fread`操作的是同一个文件指针`fp`，也就是对应的是同一个文件描述符。第一次`fwrite`后，在`tmp.txt`中写入了字符串`"123"`，同时文件偏移为3，也就是到了文件尾。进行`fread`操作时，既然操作的是同一个文件描述符，自然会共享同一个文件偏移，那么，从文件尾自然读取不到任何数据。

## 2.6　ferror的返回值

`ferror`用于告诉用户C库的文件流`FILE`是否有错误发生。当有错误发生时，`ferror`返回非零值，反之则返回0。那么`ferror`是否会返回不同的错误呢？让我们来看看`ferror`的源码。

```c
weak_alias (_IO_ferror, ferror)
int _IO_ferror (fp)
     _IO_FILE* fp;
{
    int result;
    /* 检查文件流的有效性,失败则返回EOF */
    CHECK_FILE (fp, EOF);
    _IO_flockfile (fp);
    result = _IO_ferror_unlocked (fp);
    _IO_funlockfile (fp);
    return result;
}
```

进入`_IO_ferror_unlocked`，代码如下：

```c
#define _IO_ferror_unlocked(__fp) (((__fp)->_flags & _IO_ERR_SEEN) != 0)
#define _IO_ERR_SEEN 0x20
```

从源码上可以看出`ferror`有两个返回值：

- 当文件流`FILE *fp`非法时，返回`EOF`（-1）。
- 当文件流`FILE *fp`前面的操作发生错误时，返回1。

并且由于文件流的错误只是使用一个标志位`_IO_ERR_SEEN`来表示的，因此`ferror`的返回值就不可能针对不同的错误返回不同的值了。

## 2.7　clearerr的用途

2.6节中的`ferror`用于检测文件流是否有错误发生，而`clearerr`用于清除文件流的文件结束位和错误位。

查看`clearerr`的实现，代码如下：

```c
#define clearerr_unlocked(x) clearerr (x)
void
clearerr_unlocked (fp)
     FILE *fp;
{
    CHECK_FILE (fp, /*nothing*/);
    _IO_clearerr (fp);
}
#define _IO_clearerr(FP) ((FP)->_flags &= ~(_IO_ERR_SEEN|_IO_EOF_SEEN))
```

可见，`clearerr`可以清除文件流中的文件结尾标志和错误标志。

但是清除错误标志又有什么用处呢？按照某些资料上的描述，当文件流读到文件尾时，文件流会被设置上`EOF`标志。如果不使用`clearerr`清除`EOF`标志，即使有新的数据，也无法读取成功。

让我们写个程序来验证一下：

```c
#include <stdlib.h>
#include <stdio.h>
int main(void)
{
    FILE *fp = fopen("./tmp.txt", "r");
    if (!fp) {
        printf("Fail to fopen\n");
        return -1;
    }
    while (1) {
        int c = getc(fp);
        if (feof(fp)) {
            printf("reach feof\n");
        }
    }
    return 0;
}
```

为了满足前面所说的测试情况，我们使用gdb来控制程序，代码如下：

```
31                      int c = getc(fp);
(gdb)
33                      if (feof(fp)) {
(gdb) n
34                      printf("reach feof\n");
```

现在，文件流`fp`已经读到了文件尾，被设置上了`EOF`标志。接下来向`tmp.txt`追加一个字母`'a'`。

```
[f我们可以发现虽然此时文件流`fp`仍然是被设置了`EOF`标志,但是依然能够成功读取数据.这与某些资料的描述不符,这就应对了那句老话“尽信书不如无书”,对于一些资料的结论,不要完全相信,而是要通过自己的实践来验证.

下面回到glibc的源码,查看`_IO_getc`,从代码中了解为什么是这样的结果.

```c
int
_IO_getc (fp)
     FILE *fp;
{
  int result;
  /* 检查fp */
  CHECK_FILE (fp, EOF);
  _IO_acquire_lock (fp);
  result = _IO_getc_unlocked (fp);
  _IO_release_lock (fp);
  return result;
}
/*只有定义了IO_DEBUG，CHECK_FILE才会检查_IO_file_flags标志，当其不为0时，则返回错误值。对于fgetc即为EOF */
#ifdef IO_DEBUG
# define CHECK_FILE(FILE, RET) \
    if ((FILE) == NULL) { MAYBE_SET_EINVAL; return RET; } \
    else { COERCE_FILE(FILE); \
          if (((FILE)->_IO_file_flags & _IO_MAGIC_MASK) != _IO_MAGIC) \
      { MAYBE_SET_EINVAL; return RET; }}
#else
# define CHECK_FILE(FILE, RET) COERCE_FILE (FILE)
#endif
```

从glibc的源码中可以发现,文件流`FILE`的错误标志位只有在打开`IO_DEBUG`的情况下才会对后面的I/O调用产生影响:在有错误标志位的时候,后面的I/O调用都会直接返回`EOF`.而一般情况下,`IO_DEBUG`这个宏是没有定义的.

## 2.8 小心fgetc和getc

`fgetc`和`getc`是两个定义得很不友好的函数,其函数名中的`getc`很容易让使用者误以为其返回值是`char`字符.实际上两个函数的接口定义如下:

```c
#include <stdio.h>
int fgetc(FILE *stream);
int getc(FILE *stream);
```

两者的返回值都是`int`类型.为什么要用`int`类型作为返回值呢?因为当文件流读到文件尾时,需要返回`EOF`值.C99标准中规定了`EOF`为一个`int`类型的负数常量,并没有规定具体的值.在glibc中,`EOF`被定义为-1且`char`为有符号数.但是不能排除某些实现将`EOF`定义为其他负值,甚至可能因为不遵守C99标准,`EOF`的值有可能超过`char`的表示范围.因此,为了代码的健壮性和可移植性,在使用`fgetc`和`getc`时,应使用`int`类型的变量保存其返回值.

## 2.9 注意fread和fwrite的返回值

`fread`和`fwrite`的声明代码如下:

```c
#include <stdio.h>
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
```

这两个函数原型很容易让人产生误解.当看到返回值类型为`size_t`时,人们很有可能理解为`fread`和`fwrite`会返回成功读取或写入的字节数,然而实际上其返回的是成功读取或写入的个数,即有多少个`size`大小的对象被成功读取或写入了.而参数`nmemb`则用于指示`fread`或`fwrite`要执行的对象个数.

看看下面的示例代码:

```c
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
int main(void)
{
    const char str[] = "123456789";
    FILE *fp = fopen("tmp.txt", "w");
    size_t size = fwrite(str, strlen(str), 1, fp);
    printf("size is %d\n", size);
    fclose(fp);
    return 0;
}
```

这段代码的输出为:

```
size is 1
```

结果并不是写入的字符串长度9,而是返回写入的对象个数1.其原因是参数`ptr`指示的是要写入对象的地址,`size`为每个对象的字节数,`nmemb`为有多少个要写入的对象.

将上面的代码稍微变换一下,将`fwrite`的语句改为:

```c
size_t size = fwrite(str, 1, strlen(str), fp);
```

这时程序的输出就变为:

```
size is 9
```

其原因在于,参数`size`表示每个对象的字节数是1字节,`nmemb`表示要写入9个对象,因此返回值就变为9了.

## 2.10 创建临时文件

在项目中经常会需要生成临时文件,用于保存临时数据,创建管道文件、Unix域socket等.为了不与已有的文件同名,或者避免与其他临时文件相冲突,有些朋友可能会选择利用进程id、时间戳等来生成临时文件名.其实,C库已经提供了生成临时文件的接口.下面对生成临时文件的各种方法进行分析对比.

先来看看`tmpnam`方式,代码如下:
```c
#include <stdio.h>
char *tmpnam(char *s);
```
`tmpnam`会返回一个目前系统不存在的临时文件名.当`s`为NULL时,返回的文件名保存在一个静态的缓存中,因此再次调用`tmpnam`时,新生成的文件名会覆盖上一次的结果.当`s`不为NULL时,生成的临时文件名会保存在`s`中,因此要求`s`至少要有C库规定的`L_tmpnam`大小.C库同时还规定`tmpnam`产生的临时文件的路径以`P_tmpdir`开头——glibc中`P_tmpdir`定义为`/tmp`.

从上面的描述中可以清楚地发现`tmpnam`的缺点:
- 当`s`为NULL时,`tmpnam`不是线程安全的.
- `tmpnam`生成的临时文件名,必须位于固定的路径下(`/tmp`).
- 使用`tmpnam`创建临时文件不是一个原子行为,需要先生成临时文件名,然后调用其他I/O函数创建文件.这有可能会导致在创建文件时,该文件已经存在.

再来看看`tmpfile`方式:
```c
#include <stdio.h>
FILE *tmpfile(void);
```
`tmpfile`返回一个以读写模式打开的、唯一的临时文件流指针.当文件指针关闭或程序正常结束时,该临时文件会被自动删除.

`tmpfile`直接返回临时的文件流指针——这个自然避免了`tmpnam`中潜在的线程安全问题,同时还避免了将生成文件名和创建文件分为两个步骤来执行的行为.那么`tmpfile`是否真的实现了原子地创建临时文件?让我们看一下`tmpfile`的实现,代码如下:
```c
FILE *
tmpfile (void)
{
  char buf[FILENAME_MAX];
  int fd;
  FILE *f;
  if (__path_search (buf, FILENAME_MAX, NULL, "tmpf", 0))
    return NULL;
  int flags = 0;
#ifdef FLAGS
  flags = FLAGS;
#endif
  fd = __gen_tempname (buf, 0, flags, __GT_FILE);
  if (fd < 0)
    return NULL;
  /* Note that this relies on the UNIX semantics that
     a file is not really removed until it is closed.  */
  (void) __unlink (buf);
  if ((f = __fdopen (fd, "w+b")) == NULL)
    __close (fd);
  return f;
}
```
乍一看,`tmpfile`是通过`__path_search`先产生临时文件名,然后再创建该文件,最后通过文件句柄生成文件流指针.这样的过程看上去好像并不是原子的.下面,让我们深入到`__gen_tempname`中一探究竟.
```c
    case __GT_FILE:
      fd = __open (tmpl,
               (flags & ~O_ACCMODE)
               | O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
      break;
```
在创建临时文件时,C库使用了`open`函数的`O_CREAT`和`O_EXCL`标志组合,这点保证了文件的原子性创建,从而使`tmpfile`创建临时文件的行为是原子的.但`tmpfile`也有一个缺点,与`tmpnam`相同,这个临时文件只能生成在固定的路径下(`/tmp`),并且其有可能因为文件名称冲突而失败返回NULL.

那么,有没有可以给临时文件指定目录的方法呢?下面请看`mkstemp`,代码如下:
```c
#include <stdlib.h>
int mkstemp(char *template);
```
`mkstemp`会根据`template`创建并打开一个独一无二的临时文件.`template`的最后6个字符必须是“XXXXXX”.glibc库会生成一个独一无二的后缀来替换“XXXXXX”,因此要求`template`必须是可修改的.

`mkstemp`执行成功后会返回创建的临时文件的文件描述符,失败时则返回-1.下面看一下`mkstemp`的实现.
```c
int #mkstemp (template)
     char *template;
{
  return __gen_tempname (template, 0, 0, __GT_FILE);
}
```
进入`__gen_tempname`后:
```c
int #__gen_tempname (char *tmpl, int suffixlen, int flags, int kind)
{
    int len;
    char *XXXXXX;
    static uint64_t value;
    uint64_t random_time_bits;
    unsigned int count;
    int fd = -1;
    int save_errno = errno;
    struct_stat64 st;
#define ATTEMPTS_MIN (62 * 62 * 62)
    /* The number of times to attempt to generate a temporary file.  To
     conform to POSIX, this must be no smaller than TMP_MAX.  */
#if ATTEMPTS_MIN < TMP_MAX
    unsigned int attempts = TMP_MAX;
#else
    unsigned int attempts = ATTEMPTS_MIN;
#endif
  /* 检查template的合法性，检查长度及结尾的XXXXXX字符 */
    len = strlen (tmpl);
    if (len < 6 + suffixlen || memcmp (&tmpl[len - 6 - suffixlen], "XXXXXX", 6))
    {
        __set_errno (EINVAL);
        return -1;
    }
    /* 得到结尾XXXXXX起始位置 */
    XXXXXX = &tmpl[len - 6 - suffixlen];
    /* 得到“随机”数据 */
#ifdef RANDOM_BITS
    RANDOM_BITS (random_time_bits);
#else
#if HAVE_GETTIMEOFDAY || _LIBC
    {
        struct timeval tv;
        __gettimeofday (&tv, NULL);
        random_time_bits = ((uint64_t) tv.tv_usec << 16) ^
            tv.tv_sec;
    }
#else
    random_time_bits = time (NULL);
#endif
#endif
    /* 根据上面的伪随机数和进程pid生成value */
    value += random_time_bits ^ __getpid ();
    /*
    根据value得到唯一的临时文件名，如有重复则加上7777继续。
    最多重复attempts次。
    */
    for (count = 0; count < attempts; value += 7777, ++count)
    {
        uint64_t v = value;
        /*
        letters是26个英文大小写加上10个阿拉伯数字，为62个大小的字符数组。因此使用62作为除数，
        以得到随机字符。
        */
        XXXXXX[0] = letters[v % 62];
        v /= 62;
        XXXXXX[1] = letters[v % 62];
        v /= 62;
        XXXXXX[2] = letters[v % 62];
        v /= 62;
        XXXXXX[3] = letters[v % 62];
        v /= 62;
        XXXXXX[4] = letters[v % 62];
        v /= 62;
        XXXXXX[5] = letters[v % 62];
        switch (kind)
        {    case __GT_FILE:
             /* 这是mkstemp的情况，利用O_CREAT|O_EXCL创建唯一文件 */
             fd = __open (tmpl,
               (flags & ~O_ACCMODE)
               | O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR);
             break;
        }
        if (fd >= 0)
        {
            /* 成功创建了文件，恢复原来的errno，并返回创建的文件描述符fd */
            __set_errno (save_errno);
            return fd;
        }
        else if (errno != EEXIST) {
        /* 如失败的原因不是因为文件已经存在的时候，则直接返回。 */
            return -1;
        }
    /* 如果是其他原因，则会重新生成新的文件名，并再次尝试重建 */
    }
    /* 将errno设置为EEXIST，即文件已经存在 */
    __set_errno (EEXIST);
    return -1;
}
```
综上所述，在需要使用临时文件时，不推荐使用`tmpnam`，而要用`tmpfile`和`mkstemp`。前者的局限在于不能指定路径，并且在文件名称冲突时会返回失败。后者可以由调用者来指定路径，并且在文件名称冲突时，会自动重新生成并重试。

除了上面介绍的几种方法，Linux环境还提供了这些接口的一些变种：`tempnam`、`mkostemp`、`mkstemps`等，分别对其原始形态进行了扩展，详细区别可以直接查看Linux手册。

> [!INFO] 临时文件生成总结
> - `tmpnam`：不推荐，存在线程安全问题且非原子操作。
> - `tmpfile`：自动删除，原子创建，但路径固定为`/tmp`。
> - `mkstemp`：可指定路径（通过`template`参数），自动重试，推荐用于需要自定义目录的场景。
> - 其他变种如`mkostemp`、`mkstemps`等可参考手册。