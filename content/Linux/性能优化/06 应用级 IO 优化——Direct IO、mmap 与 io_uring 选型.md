---
title: "应用级 IO 优化——Direct IO、mmap 与 io_uring 选型"
date: 2026-03-02
tags: [bufferedIO, Direct I/O, io_uring, IO模式, Linux, mmap, Page Cache, 性能优化, 性能调优, 系统调用, 零拷贝, libaio, sendfile, SQPOLL]
aliases: ["IO模式选型", "DirectIO vs mmap", "io_uring性能", "应用IO优化", "Page Cache绕过", "零拷贝", "sendfile"]
---

# 06 应用级 IO 优化——Direct IO、mmap 与 io_uring 选型

**摘要：**
同一块 NVMe SSD，同样的数据读写量，不同的 IO 接口可以产生 3-10 倍的性能差距。这不是夸张——Linux 提供了四种截然不同的 IO 模式，每种模式在**内核路径长度、数据拷贝次数、系统调用开销、CPU 使用率**上都有根本性差异：**Buffered IO**（默认，经过 Page Cache，适合大多数场景）、**Direct IO**（绕过 Page Cache，适合自管理缓存的数据库）、**mmap**（内存映射，适合随机访问大文件）、**io_uring**（异步批量提交，适合高并发 IO 密集型服务）。本文不是工具介绍，而是**选型方法论**：每种模式的内核实现原理，以及"什么场景下用什么，为什么"的深度分析。包含横向性能对比数据和四个典型应用场景（数据库、消息队列、缓存服务、分析引擎）的最优 IO 模式推荐。

---

## 第 1 章 从同步 read/write 到异步 io_uring——IO 接口的演化

### 1.1 IO 接口演化的驱动力

理解四种 IO 模式之前，先回顾 Linux IO 接口的演化史。最早的 IO 接口是 **同步 `read()`/`write()`**——POSIX 标准定义，应用调用后阻塞等待完成。同步 IO 简单易用，但有一个根本问题——每个 IO 请求要"一次系统调用 + 一次阻塞等待"，高并发时系统调用开销和上下文切换成为瓶颈。为了支持高并发，Linux 引入了 **`epoll` + 非阻塞 IO**——一个线程可以管理多个 IO 连接，但磁盘 IO 仍主要是同步的（`epoll` 对文件 IO 支持有限）。

2000 年代，Linux 引入了 **libaio（异步 IO）**——`io_submit` 批量提交 IO 请求，`io_getevents` 异步等待完成。libaio 让"一个线程管理多个磁盘 IO"成为可能，但它有几个限制——只支持 `O_DIRECT`（buffered IO 会退化为同步），且每个 IO 仍需多次系统调用。2019 年，Linux 5.1 引入了 **io_uring**——基于共享内存环形队列的异步 IO 接口，支持批量提交、SQPOLL 零系统调用模式、多种 IO 类型（文件 + 网络）。io_uring 是 Linux IO 接口的"重新设计"——它解决了 libaio 的所有限制，成为高性能 IO 的未来方向。**同步 → epoll → libaio → io_uring 是 IO 接口的四级跳**——每一级都减少了系统调用开销，提高了并发能力。

IO 接口的演化有一个与"应用需求"相关的驱动力——每一代 IO 接口都是为了解决前一代的瓶颈。同步 IO 的瓶颈是"并发"（一个线程一个 IO），epoll 解决了"网络并发"但没解决"磁盘并发"，libaio 解决了"磁盘并发"但有"系统调用开销"和"仅 O_DIRECT"限制，io_uring 解决了"系统调用开销"和"IO 类型限制"。每一代都是"前一代的瓶颈催生下一代"——这是 IO 接口演化的"需求驱动"模式。**IO 接口演化是"瓶颈驱动"的**——每一代解决前一代的瓶颈，但也引入新的瓶颈（io_uring 的初始化开销、SQPOLL 的 CPU 占用），为下一代演化埋下种子。

IO 接口演化还有一个与"硬件协同"相关的维度——每一代 IO 接口都要配合存储硬件的演进。同步 IO 适合 HDD（IOPS 低，并发不重要），libaio 适合 SATA SSD（IOPS 中等，需要异步并发），io_uring 适合 NVMe SSD（IOPS 高，需要批量提交 + 零系统调用）。如果用同步 IO 配 NVMe SSD，系统调用开销占主导——100 万 IOPS 要 100 万次系统调用，CPU 全用在系统调用上。所以 IO 接口要与存储硬件匹配——HDD 用同步，SATA SSD 用 libaio，NVMe SSD 用 io_uring。**IO 接口与存储硬件"协同演化"**——这是 IO 接口选型的"硬件匹配"原则。

IO 接口演化还有一个与"网络 IO"相关的扩展——io_uring 不只支持文件 IO，还支持网络 IO（`IORING_OP_ACCEPT`/`IORING_OP_RECV`/`IORING_OP_SEND`）。这意味着 io_uring 能成为"文件 IO + 网络 IO"的统一异步接口——一个线程用 io_uring 同时处理磁盘读写和网络收发，无需 epoll + libaio 两套机制。这是 io_uring 的"统一异步 IO"愿景——未来 Linux 的高并发服务可能"全部用 io_uring"，不再需要 epoll。**io_uring 的"文件 + 网络统一"是异步 IO 的未来方向**——这是 io_uring 相比 epoll + libaio 的架构优势，可能重塑 Linux 高并发编程模型。

```mermaid
%%{init: {'theme': 'dracula'}}%%
graph LR
    Sync["同步 read/write<br/>1 IO = 1 syscall<br/>阻塞等待"]
    Epoll["epoll + 非阻塞<br/>多连接单线程<br/>磁盘 IO 仍同步"]
    Libaio["libaio<br/>批量提交<br/>仅 O_DIRECT"]
    IoUring["io_uring<br/>共享内存队列<br/>SQPOLL 零 syscall"]

    Sync ==>"|并发需求|" Epoll
    Epoll ==>"|磁盘异步|" Libaio
    Libaio ==>"|系统调用开销|" IoUring

    classDef slow fill:#44475a,stroke:#ff5555,color:#f8f8f2
    classDef mid fill:#282a36,stroke:#ffb86c,color:#f8f8f2
    classDef fast fill:#282a36,stroke:#50fa7b,color:#f8f8f2
    class Sync slow
    class Epoll mid
    class Libaio mid
    class IoUring fast
```

### 1.2 四种 IO 模式的内核路径差异

**Buffered IO（缓冲 IO）** 是 Linux 的默认 IO 模式。当应用调用 `read()`/`write()` 时，数据经过 **[[Page Cache]]** 中转：

```
写路径：
应用程序 → write() 系统调用 → 内核 Page Cache（脏页）→（定期）→ 磁盘
                                                        ↑ 脏页回写（pdflush/writeback）

读路径：
应用程序 → read() 系统调用 → 检查 Page Cache → 命中：直接返回（零磁盘 IO）
                                              → 未命中：从磁盘读取，填充 Page Cache，再返回
```

**Buffered IO 的核心价值**：

1. **读缓存**：重复读同一文件内容，第二次直接从内存（Page Cache）返回，无磁盘 IO，延迟从 100µs 降到 1µs
2. **写合并**：多次小写（如 `write(buf, 512)` × 100）被合并为一次大 IO 刷盘，提高磁盘写效率
3. **预读（Readahead）**：内核检测到顺序读模式后，自动预读后续数据到 Page Cache，掩盖磁盘延迟

**数据拷贝次数**（写路径）：用户缓冲区 → Page Cache（1 次 CPU 拷贝）→ DMA 传输到磁盘（硬件拷贝）。总计 1 次 CPU 拷贝。

**Buffered IO 的局限性**：

Page Cache 占用内核内存，且受 LRU 策略管理。对于**自管理缓存的应用**（MySQL InnoDB buffer pool、RocksDB block cache），Page Cache 是多余的——数据在应用层缓存了一份，又在 Page Cache 中缓存了一份，造成**双重缓存（Double Buffering）**，浪费内存且增加 CPU 拷贝次数。

Buffered IO 的 Page Cache 还有一个与"脏页回写"相关的延迟抖动源——Page Cache 的脏页由内核的 `writeback` 线程定期刷盘，刷盘时机由 `vm.dirty_ratio`/`vm.dirty_background_ratio` 控制。当脏页比例超过 `dirty_ratio`（默认 20%）时，应用的 `write()` 会**同步阻塞**刷盘——这个阻塞有几十毫秒，是 P99 毛刺的常见来源。对于延迟敏感的服务，要调低 `dirty_ratio`（譬如 5%），让脏页更早异步刷盘，避免同步阻塞。**Buffered IO 的脏页回写是"P99 毛刺源"**——这是 Buffered IO 在延迟敏感场景的隐患，Direct IO 无此问题（无脏页）。

Buffered IO 的脏页回写还有一个与"调优"相关的参数组——`vm.dirty_background_ratio`（默认 10%）控制"后台异步刷盘阈值"，`vm.dirty_ratio`（默认 20%）控制"同步阻塞刷盘阈值"。当脏页比例超过 `dirty_background_ratio` 时，`pdflush` 线程开始异步刷盘（不阻塞应用）；超过 `dirty_ratio` 时，应用的 `write()` 同步阻塞刷盘（阻塞应用）。延迟敏感服务要调低这两个值——譬如 `dirty_background_ratio=1, dirty_ratio=5`——让脏页更早异步刷盘，减少同步阻塞概率。但调太低会让刷盘更频繁，增加磁盘 IO——要平衡。**`dirty_ratio` 调优是"刷盘频率 vs 阻塞概率"的权衡**——这是 Buffered IO 延迟调优的核心参数。

Buffered IO 的脏页回写还有一个与"fsync"相关的强制刷盘——`fsync()` 会强制把指定文件的脏页刷盘，绕过 `dirty_ratio` 阈值。所以即使 `dirty_ratio` 调得高，应用主动 `fsync` 也会立即刷盘——这是"应用控制刷盘时机"的机制。数据库的 WAL 写入后 `fsync`，就是用 `fsync` 强制刷盘保证持久化——不依赖 `dirty_ratio` 的异步刷盘。所以 Buffered IO 的延迟调优要配合"应用的 fsync 策略"——`dirty_ratio` 控制"非 fsync 的脏页"，fsync 控制"必须持久化的脏页"。**`fsync` 是"应用控制的强制刷盘"**——这是 Buffered IO + 持久化的标准模式。

### 1.3 Direct IO：绕过 Page Cache

**Direct IO（直接 IO）** 通过 `O_DIRECT` 标志打开文件，所有 IO 操作**跳过 Page Cache**，直接在用户缓冲区和磁盘之间传输数据：

```
写路径（O_DIRECT）：
应用程序 → write() 系统调用 → DMA 直接从用户缓冲区到磁盘（无 Page Cache 参与）

读路径（O_DIRECT）：
应用程序 → read() 系统调用 → DMA 直接从磁盘到用户缓冲区（无 Page Cache 参与）
```

**Direct IO 的严格对齐要求**：

`O_DIRECT` 要求 IO 操作满足三个对齐条件，否则返回 `EINVAL`：
1. **文件偏移量**必须是逻辑块大小的整数倍（通常 512 字节或 4096 字节）
2. **IO 大小**必须是逻辑块大小的整数倍
3. **用户缓冲区地址**必须对齐到逻辑块大小（通常用 `posix_memalign` 分配）

```c
/* Direct IO 的正确使用方式 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define BLOCK_SIZE 4096  /* 对齐单位：文件系统块大小 */

int fd = open("/data/mysql/ibdata1", O_RDWR | O_DIRECT);

/* 分配对齐的缓冲区（posix_memalign 保证内存对齐）*/
void *buf;
posix_memalign(&buf, BLOCK_SIZE, BLOCK_SIZE * 16);  /* 对齐到 4KB，分配 64KB */

/* IO 大小和偏移量都必须是 BLOCK_SIZE 的整数倍 */
ssize_t n = pread(fd, buf, BLOCK_SIZE * 16, 0);  /* 从偏移 0 读取 64KB */
```

**Direct IO 适合的场景**：
- 数据库引擎（MySQL InnoDB、PostgreSQL、RocksDB）：应用层已有自己的 buffer pool/block cache，Page Cache 只是额外开销
- 备份工具（将大文件顺序读取并压缩传输）：数据只读一次，不需要 Page Cache 缓存

**Direct IO 不适合的场景**：
- 频繁随机读小文件（无 Page Cache 缓存，每次都要磁盘 IO，延迟高）
- 写入后立即读取（Direct IO 写入后不进 Page Cache，紧接的读取也是磁盘 IO）

Direct IO 的对齐要求有一个与"硬件"相关的底层原因——Direct IO 直接 DMA 传输，DMA 控制器要求缓冲区物理地址对齐到块大小（否则 DMA 无法正确传输）。这是硬件约束，不是软件限制——所以 `O_DIRECT` 的对齐要求无法绕过。对于数据库（IO 大小固定为 page size，天然对齐），这个要求容易满足；对于通用应用（IO 大小任意），对齐要求是使用门槛。**Direct IO 的对齐要求是"DMA 硬件约束"**——这是 Direct IO 比 Buffered IO 多一个使用门槛的原因。

Direct IO 还有一个与"预读"相关的劣势——Direct IO 不经过 Page Cache，所以内核的"预读"机制对 Direct IO 无效。对于顺序读场景，Buffered IO 的预读能"掩盖磁盘延迟"（内核提前读下一批数据），Direct IO 每次都要等磁盘——延迟更高。所以 Direct IO 适合"随机访问"（预读无效的场景），不适合"顺序访问"（预读有效的场景）。如果要在 Direct IO 下获得预读效果，应用要"自己预读"——譬如数据库的"prefetch"机制，提前提交多个 IO 请求。**Direct IO 无内核预读，应用要自己预读**——这是 Direct IO 的"预读代价"。

Direct IO 还有一个与"写性能"相关的特性——Direct IO 的写是"同步写"（数据直接到磁盘控制器），没有 Page Cache 的"写合并"。对于"多次小写"的场景（譬如日志每次写一行），Direct IO 每次都要磁盘 IO——性能极差。Buffered IO 能把多次小写合并为一次大 IO 刷盘。所以 Direct IO 不适合"小写频繁"的场景——要用 Buffered IO 或应用层"攒够一页再写"（譬如日志框架的 buffer flush）。**Direct IO 不适合"小写频繁"，要应用层攒批**——这是 Direct IO 的"写粒度"要求。

Direct IO 的写粒度要求还有一个与"数据库 page size"相关的契合点——数据库的 IO 大小固定为 page size（MySQL InnoDB 默认 16KB，PostgreSQL 默认 8KB），天然满足 Direct IO 的对齐要求。所以数据库用 Direct IO 没有额外的"攒批"负担——数据库本身按 page 读写。但对于"流式写"的应用（譬如日志框架每次写一行），Direct IO 要应用层攒够一页（4KB）再写——这是 Direct IO 对"流式应用"的改造要求。**Direct IO 与"数据库 page IO"天然契合，与"流式写"需改造**——这是 Direct IO 的"应用适配"差异。

### 1.4 mmap：将文件映射为内存地址

**mmap（Memory-Mapped IO）** 通过 `mmap()` 系统调用将文件的一段映射为进程的虚拟地址空间，应用程序通过指针直接访问文件数据，不需要 `read()`/`write()` 系统调用：

```c
/* mmap 的基本用法 */
int fd = open("/data/large_file.bin", O_RDONLY);
struct stat st;
fstat(fd, &st);

/* 将整个文件映射到内存地址空间 */
void *addr = mmap(NULL, st.st_size, PROT_READ, MAP_SHARED | MAP_POPULATE, fd, 0);
/* MAP_POPULATE：映射时预读整个文件到 Page Cache（减少后续 page fault）*/

/* 现在可以直接通过指针访问文件内容，如同访问内存 */
uint64_t *data = (uint64_t *)addr;
uint64_t sum = 0;
for (size_t i = 0; i < st.st_size / 8; i++)
    sum += data[i];  /* 直接指针访问，无系统调用！ */

munmap(addr, st.st_size);
close(fd);
```

**mmap 的内核实现**：

`mmap()` 本身不读取任何数据，只是在进程的虚拟地址空间建立了一个映射（修改页表项）。当应用第一次访问映射地址时，触发**缺页异常（Page Fault）**，内核将对应的文件页加载到 Page Cache，并将页表项更新为 Page Cache 的物理地址。此后对该地址的访问直接命中 Page Cache，不再需要系统调用。

```
mmap 的零拷贝读取路径：

第一次访问（Page Fault）：
  → 缺页异常处理
  → 从磁盘读取对应页（DMA → Page Cache）
  → 更新进程页表（Page Cache 物理页 → 虚拟地址）
  → 返回用户态继续执行

后续访问：
  → 直接访问 Page Cache 物理页（零系统调用，零拷贝！）
```

**mmap 相比 Buffered IO 的优势**：
- **消除系统调用开销**：`read()`/`write()` 每次都需要陷入内核；mmap 映射后，只有第一次访问（Page Fault）需要内核参与，后续完全在用户态
- **真正的零拷贝读**：数据直接从 Page Cache 物理页映射到进程地址空间，没有用户缓冲区 → Page Cache 的 CPU 拷贝

**mmap 的陷阱**：
- **Page Fault 延迟不可控**：每次 Page Fault 需要 1-10µs，在高并发场景会成为 P99 毛刺
- **内存管理复杂**：`madvise(MADV_DONTNEED)` 后的再次访问重新触发 Page Fault
- **大文件映射的地址空间压力**：64 位系统地址空间足够，但大量 mmap 会消耗内核 VMA（Virtual Memory Area）数量上限
- **不适合 Direct IO**：`mmap` + `O_DIRECT` 组合在 Linux 上不支持（语义冲突）

mmap 的 Page Fault 有一个与"首次访问"相关的延迟特征——mmap 本身不读数据，第一次访问触发 Page Fault 才读。这意味着 mmap 的"第一次访问"比 `read()` 慢——Page Fault 要"陷入内核 + 读磁盘 + 更新页表"，而 `read()` 只"陷入内核 + 读磁盘 + 拷贝"。mmap 的优势在"后续访问"——直接命中 Page Cache，无系统调用。所以 mmap 适合"同一区域反复访问"的场景（譬如 Lucene 的索引文件），不适合"只访问一次"的场景（譬如备份工具读大文件）。**mmap 的收益在"后续访问"，"首次访问"反而慢**——这是 mmap 的"延迟前置"特征。

mmap 还有一个与"TLB"相关的性能优势——mmap 映射的内存是"页对齐"的，CPU 的 TLB 能高效缓存映射关系。而 `read()` 的目标缓冲区可能是任意地址（malloc 分配），TLB 命中率低。对于大文件扫描（譬如 Lucene 索引），mmap 的 TLB 优势让"指针遍历"比"read 循环"更快——不只是省了系统调用，还省了 TLB Miss。**mmap 的"页对齐 + TLB 友好"是额外优势**——这是 mmap 在"大文件随机访问"场景比 `read()` 快的深层原因。

mmap 还有一个与"madvise"相关的精细化控制——`madvise` 系统调用能"建议"内核如何管理 mmap 映射的页。`MADV_RANDOM` 告诉内核"这是随机访问，不要预读"（避免预读浪费 IO），`MADV_SEQUENTIAL` 告诉内核"这是顺序访问，大胆预读"，`MADV_DONTNEED` 告诉内核"这些页不再用，可回收"（释放内存），`MADV_WILLNEED` 告诉内核"这些页即将用，请预读"。用 `madvise` 能让 mmap 的行为更贴合应用访问模式——譬如 Lucene 对索引文件用 `MADV_RANDOM`（避免预读浪费），对扫描文件用 `MADV_SEQUENTIAL`（大胆预读）。**`madvise` 是 mmap 的"访问模式提示"**——这是 mmap 精细化调优的接口。

mmap 的 `madvise` 还有一个与"内存回收"相关的实践——`MADV_DONTNEED` 能"主动释放"映射页的物理内存，让内核回收。这在"映射大文件但只访问部分"的场景有用——譬如 mmap 了 100GB 文件，只访问了前 10GB，后 90GB 的页用 `MADV_DONTNEED` 释放，腾出内存给其他应用。如果不释放，这 90GB 的页可能留在 Page Cache（虽然内核会按 LRU 回收，但主动释放更可控）。**`MADV_DONTNEED` 是 mmap 的"主动释放内存"**——这是 mmap 在"大映射 + 部分访问"场景的内存管理实践。

### 1.5 io_uring：异步批量提交，最小化系统调用

**io_uring**（Linux 5.1）是 Linux 最新的异步 IO 接口，通过两个**共享内存环形队列**（SQ = Submission Queue 提交队列，CQ = Completion Queue 完成队列）在用户态和内核态之间零拷贝地传递 IO 请求，并支持**批量提交**（一次系统调用提交多个 IO）：

```c
/* io_uring 的典型使用模式（使用 liburing 简化 API）*/
#include <liburing.h>

struct io_uring ring;
io_uring_queue_init(128, &ring, 0);  /* 初始化，队列深度 128 */

/* 批量提交 8 个 IO 请求 */
for (int i = 0; i < 8; i++) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, bufs[i], 4096, offsets[i]);
    io_uring_sqe_set_data(sqe, (void *)(long)i);  /* 标记请求 ID */
}

/* 一次系统调用提交所有 8 个 IO（io_uring_enter），并等待至少 4 个完成 */
io_uring_submit_and_wait(&ring, 4);

/* 收割完成事件 */
struct io_uring_cqe *cqe;
unsigned head;
int completed = 0;
io_uring_for_each_cqe(&ring, head, cqe) {
    int idx = (int)(long)io_uring_cqe_get_data(cqe);
    if (cqe->res < 0) fprintf(stderr, "IO error: %d\n", cqe->res);
    completed++;
}
io_uring_cq_advance(&ring, completed);  /* 推进 CQ 指针 */
```

**io_uring 相比 libaio 的优势**：

| 特性 | libaio | io_uring |
|-----|--------|---------|
| 系统调用次数 | `io_submit` + `io_getevents` | `io_uring_enter`（一次提交+等待）|
| 批量提交 | 支持，但每个 IO 仍需单独系统调用 | 真正的批量：一次 `io_uring_enter` |
| SQPOLL 模式 | 不支持 | 支持（内核轮询线程，**零系统调用**）|
| 支持的 IO 类型 | 只有文件 IO | 文件 IO + 网络 IO + splice + sendmsg |
| 固定缓冲区 | 不支持 | 支持（减少 DMA 映射开销）|

**SQPOLL 模式（零系统调用）**：

```c
/* SQPOLL 模式：内核创建一个专用轮询线程，不断检查 SQ 队列
   应用程序直接写 SQ，无需调用 io_uring_enter */
struct io_uring_params params = {0};
params.flags |= IORING_SETUP_SQPOLL;
params.sq_thread_idle = 2000;  /* 2 秒无 IO 后轮询线程睡眠 */
io_uring_queue_init_params(128, &ring, &params);

/* 在 SQPOLL 模式下，提交 IO 只需写 SQ，无系统调用！ */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, 4096, 0);
io_uring_sqe_set_flags(sqe, IOSQE_FIXED_FILE);  /* 使用预注册的 fd */
io_uring_submit(&ring);  /* SQPOLL 模式下这个调用不产生系统调用 */
```

io_uring 的设计有一个与"共享内存"相关的核心创新——SQ 和 CQ 是用户态和内核态共享的内存区域，应用写 SQ 不需要系统调用（直接写共享内存），内核读 SQ 也不需要拷贝（直接读共享内存）。这消除了"传递 IO 请求"的系统调用开销——传统 libaio 的 `io_submit` 要把请求从用户态拷贝到内核态，io_uring 的共享内存让这个拷贝消失。**共享内存队列是 io_uring "零系统调用"的基础**——这是 io_uring 相比 libaio 的根本架构优势。

io_uring 的共享内存队列还有一个与"内存屏障"相关的实现细节——应用写 SQ 后要"内存屏障"确保内核看到写入，内核写 CQ 后也要"内存屏障"确保应用看到完成。这些屏障是 `smp_store_release`/`smp_load_acquire`（ARM）或 `__atomic_store_n`/`__atomic_load_n`（x86）。如果应用忘记屏障，可能出现"应用写了 SQ 但内核没看到"或"内核写了 CQ 但应用没看到"——IO 丢失或完成丢失。liburing 库封装了屏障，建议用 liburing 而非直接操作共享内存。**io_uring 的共享内存要"内存屏障"保证可见性**——这是 io_uring 编程的"并发陷阱"，liburing 屏蔽了它。

io_uring 还有一个与"Fixed Buffer"相关的优化——`io_uring_register` 能预注册"固定缓冲区"和"固定文件描述符"。预注册后，内核提前建立 DMA 映射（固定缓冲区）和文件引用（固定 fd），后续 IO 无需重复建立——减少每次 IO 的"映射建立"开销。对于高 IOPS 场景（100 万+），Fixed Buffer 能减少 5-10% 的内核开销。但 Fixed Buffer 的数量有限（默认 256 个），要"复用"而非"每 IO 注册"。**Fixed Buffer 是"io_uring 的预注册优化"**——这是 io_uring 在极高 IOPS 场景的进阶优化。

io_uring 的 Fixed Buffer 还有一个与"DMA 安全"相关的细节——Fixed Buffer 的内存要"钉住"（pin），不能被内核换出或迁移——因为 DMA 直接操作物理地址，如果内存被换出，DMA 会写到错误地址。所以 Fixed Buffer 的内存是"mlock"状态——内核不能回收。这意味着 Fixed Buffer 的内存占用是"固定"的——注册 256 个 4KB Buffer 就固定占 1MB 物理内存，不能被回收。对于内存紧张的场景，Fixed Buffer 要谨慎使用——注册太多会浪费内存。**Fixed Buffer 的内存"钉住不可回收"**——这是 Fixed Buffer 的"内存代价"，要在"性能 vs 内存"间权衡。

---

## 第 2 章 四种模式的性能横向对比

### 2.1 测试方法论

以下数据基于 Samsung 980 Pro NVMe SSD，4KB 随机读，队列深度 1（同步场景）和 32（并发场景），64 个并发线程：

| IO 模式 | 系统调用/IO | 延迟（QD=1）| 延迟（QD=32）| IOPS（QD=32）|
|--------|-----------|-----------|------------|------------|
| Buffered IO（命中 Page Cache）| 1 | ~1 µs | ~1 µs | **极高（内存速度）** |
| Buffered IO（未命中 Page Cache）| 1 | ~120 µs | ~130 µs | ~240,000 |
| Direct IO（libaio）| 2（提交+等待）| ~95 µs | ~110 µs | ~280,000 |
| Direct IO（io_uring）| 1（批量）| ~90 µs | ~100 µs | ~310,000 |
| Direct IO（io_uring SQPOLL）| 0 | ~85 µs | ~95 µs | **340,000** |
| mmap（Page Fault 后）| 0 | ~1 µs | ~1 µs | **极高** |
| mmap（Page Fault 时）| ~1（缺页异常）| ~120 µs | ~130 µs | 与 Buffered 相近 |

**关键发现**：
1. Buffered IO 命中 Page Cache 时速度最快（接近内存速度）——适合热数据反复访问
2. 对于冷数据（无缓存），Direct IO + io_uring SQPOLL 比 libaio 快约 20%，P99 延迟更低
3. mmap 在 Page Fault 时与 Buffered IO 几乎相同，Page Fault 后（缓存热）与内存速度相同

### 2.2 为什么 io_uring 在高并发下有显著优势

系统调用开销是高并发 IO 的主要瓶颈之一。以每个 IO 需要 2 次系统调用（提交 + 等待）的 libaio 为例：

```
libaio 的系统调用开销：
每次 IO = io_submit(1 次) + io_getevents(1 次) = 2 次系统调用
每次系统调用 = ~1 µs（包含用户态→内核态切换、安全检查、栈切换）

100 万 IOPS × 2 次系统调用 = 200 万次/秒系统调用
200 万次/秒 × 1 µs/次 = 2 秒的 CPU 时间消耗在系统调用上！

io_uring 批量提交（一次提交 64 个 IO）：
100 万 IOPS / 64 = 约 1.56 万次 io_uring_enter
1.56 万次 × 1 µs = 0.016 秒 CPU 时间
系统调用开销降低 125 倍！
```

io_uring 的系统调用开销减少有一个与"CPU 占用"相关的间接收益——系统调用开销降低后，CPU 可以更多用于业务逻辑（而非 IO 提交）。在 100 万 IOPS 场景下，libaio 要消耗 2 秒 CPU 在系统调用上，io_uring 只消耗 0.016 秒——节省的 1.984 秒 CPU 可以用于业务计算。这意味着"同样的 IO 吞吐，io_uring 需要的 CPU 更少"——或者说"同样的 CPU，io_uring 能支撑更高的 IO 吞吐"。**io_uring 的"低系统调用开销"转化为"高 IO 效率"**——这是 io_uring 在高并发场景的核心优势。

io_uring 的系统调用开销减少还有一个与"CPU 核数"相关的扩展性优势——系统调用要"全局锁"（内核的 `system_call` 路径有全局锁），多核同时系统调用时锁争用严重。io_uring 的 SQPOLL 模式让每个核有自己的 SQ（无锁），内核轮询线程独立处理——无全局锁争用。所以 io_uring 在"多核 + 高 IOPS"场景的扩展性比 libaio 好——核数越多，io_uring 的优势越大。**io_uring 的"无锁队列"让多核扩展性更好**——这是 io_uring 在 32 核/64 核服务器上比 libaio 快更多的原因。

io_uring 的多核扩展性还有一个与"NUMA"相关的注意——io_uring 的共享内存队列在"初始化时的 NUMA 节点"分配，后续 IO 提交线程如果在其他 NUMA 节点，访问共享内存是远端——有延迟。所以 io_uring 初始化要在"IO 提交线程所在 NUMA 节点"做——用 `numactl --cpunodebind` 绑定后初始化。对于多线程应用，每个 NUMA 节点可以有自己的 io_uring 实例（避免跨节点共享内存访问）。**io_uring 的共享内存有"NUMA 亲和性"**——这是 io_uring 在 NUMA 服务器的调优细节。

io_uring 的 NUMA 亲和性还有一个与"队列深度"相关的调优——io_uring 的队列深度（`sq_entries`）默认 128，最大可设 32768。队列深度要匹配"IO 并发度"——并发 1000 IO 要队列深度至少 1024。但队列深度越大，共享内存占用越多（每个 SQE 约 64 字节，32768 个 SQE 占 2MB）。对于极高并发（10 万 IO），要调大队列深度——但要权衡内存占用。**io_uring 的队列深度要匹配"IO 并发度"**——这是 io_uring 的"容量调优"，要在"并发 vs 内存"间平衡。

---

## 第 3 章 典型应用场景的 IO 模式选型

### 3.1 数据库引擎（MySQL、PostgreSQL、RocksDB）

**推荐模式：Direct IO**

**原因**：数据库引擎都有自己的 Buffer Pool（MySQL InnoDB）或 Block Cache（RocksDB）。如果使用 Buffered IO，一份数据同时存在于应用层 Buffer Pool 和内核 Page Cache 中：
- 浪费内存：一份数据占用两倍内存
- 增加 CPU 拷贝：write() 系统调用需要从用户缓冲区拷贝到 Page Cache
- 干扰 OS 内存管理：大量脏页在 Page Cache 中积累，可能触发后台 writeback，引起 IO 抖动

```bash
# MySQL InnoDB 默认使用 O_DIRECT
# my.cnf
innodb_flush_method = O_DIRECT  # 或 O_DIRECT_NO_FSYNC（更激进）

# PostgreSQL
# postgresql.conf
#  effective_io_concurrency = 200  # 对 NVMe 可以更高
#  wal_sync_method = fdatasync      # WAL 使用 fdatasync（而非 fsync，减少不必要的元数据 sync）

# RocksDB 默认使用 Direct IO 读（compaction 时）
options.use_direct_reads = true;
options.use_direct_io_for_flush_and_compaction = true;
```

**例外**：PostgreSQL 历史上不原生支持 Direct IO（16 版本开始实验性支持），通常通过文件系统层缓存来工作——这是 PostgreSQL 调优的一个特殊之处（`shared_buffers` 只设物理内存的 25%，留大量内存给 Page Cache 作为二级缓存）。

数据库用 Direct IO 还有一个与"内存控制权"相关的深层原因——数据库要精确控制"哪些数据在内存"（Buffer Pool 的 LRU 策略），而 Page Cache 的 LRU 策略是内核控制的，应用无法干预。如果用 Buffered IO，数据库的 Buffer Pool 和内核的 Page Cache 各自用 LRU 管理，可能"数据库想保留的热数据被 Page Cache 淘汰"或"Page Cache 保留的冷数据浪费内存"——两个 LRU 冲突。Direct IO 让"内存控制权"完全归数据库——只有 Buffer Pool 一个 LRU，无冲突。**Direct IO 让"缓存控制权"归应用**——这是数据库选 Direct IO 的"控制权"考量，不只是"避免双重缓存"。

数据库用 Direct IO 还有一个与"fsync 语义"相关的细节——Direct IO 的 `write()` 完成只意味着"数据到了磁盘控制器"，不意味着"数据落盘"（磁盘控制器有写缓存）。要保证持久化，仍需 `fsync()` 或 `fdatasync()`——Direct IO 不免除 fsync 需求。但 Direct IO + fsync 比 Buffered IO + fsync 快——Direct IO 的数据已在磁盘控制器，fsync 只等"控制器缓存落盘"；Buffered IO 的数据还在 Page Cache，fsync 要"Page Cache → 磁盘控制器 → 落盘"——路径更长。**Direct IO + fsync 比 Buffered IO + fsync 路径短**——这是 Direct IO 在"持久化"场景的额外优势。

数据库的 Direct IO 实践还有一个与"innodb_flush_method"相关的 MySQL 细节——MySQL 的 `innodb_flush_method` 有几个值：`fdatasync`（默认，Buffered IO + fdatasync）、`O_DIRECT`（Direct IO + fsync）、`O_DIRECT_NO_FSYNC`（Direct IO，不 fsync 元数据）、`O_DSYNC`（Direct IO + O_DSYNC）。推荐 `O_DIRECT`——绕过 Page Cache 但保留 fsync 保证持久化。`O_DIRECT_NO_FSYNC` 更激进（少一次 fsync），但可能丢失文件大小元数据——适合"文件大小不变"的场景（譬如固定大小的表空间）。**`innodb_flush_method = O_DIRECT` 是 MySQL 的推荐配置**——这是 MySQL IO 模式的生产实践。

MySQL 的 Direct IO 实践还有一个与"double write buffer"相关的细节——InnoDB 的 double write buffer 是"先写一份到共享表空间的 double write 区，再写到数据文件"——防 partial write（页写一半崩溃）。double write 区用 Buffered IO（顺序写，Page Cache 合并高效），数据文件用 Direct IO（随机写，绕过 Page Cache）。所以 MySQL 的 IO 模式是"混合"——double write 用 Buffered IO，数据文件用 Direct IO。这是 MySQL 针对"partial write 风险"的精心设计，不是简单的"全 Direct IO"。**MySQL 的"double write Buffered + 数据文件 Direct"是混合 IO 模式**——这是 MySQL 持久化安全的精细设计。

### 3.2 消息队列（Kafka）

**推荐模式：Buffered IO（Page Cache）+ 顺序写 + sendfile 零拷贝读**

**原因**：Kafka 的 Broker 本身不维护内存缓存，完全依赖 OS Page Cache：
- 生产者写入：追加写到 Partition 文件（顺序写，Buffered IO，Page Cache 缓存热数据）
- 消费者读取：如果消费进度接近生产进度（"追尾消费"），数据还在 Page Cache 中，**完全不需要磁盘 IO**；使用 `sendfile` 零拷贝直接从 Page Cache 传输到 Socket

```bash
# Kafka 的 Page Cache 依赖：
# 1. 不要给 JVM Heap 分配太多内存，留足内存给 Page Cache
# JVM Heap：6-8 GB 足够，剩余内存全给 Page Cache
# 24 GB 内存的服务器：-Xmx6g，剩余 18 GB 给 Page Cache

# 2. 确保 Kafka 数据目录的文件系统挂载参数优化
# /etc/fstab：
/dev/nvme0n1p1 /data/kafka xfs defaults,noatime,nodiratime 0 0
# noatime：不更新访问时间（减少写放大）

# 3. Kafka 使用 sendfile（零拷贝）传输数据
# 内核实现：FileChannel.transferTo() → sendfile() 系统调用
# 数据路径：Page Cache → Socket Buffer（DMA），无 CPU 拷贝
```

Kafka 的 Page Cache 依赖有一个与"追尾消费"相关的性能特征——Kafka 的典型消费模式是"消费者紧跟生产者"（譬如实时流处理），生产者刚写入的数据还在 Page Cache（未刷盘），消费者直接从 Page Cache 读——全程无磁盘 IO。这种"Page Cache 作为生产者-消费者共享缓冲"的模式让 Kafka 的追尾消费吞吐量接近内存速度。但如果消费进度落后（譬如消费者重启后从头消费旧数据），数据已刷盘，要从磁盘读——速度降为磁盘速度。**Kafka 的"追尾消费"靠 Page Cache 达到内存速度**——这是 Kafka 选 Buffered IO 的核心收益。

Kafka 的 Page Cache 依赖还有一个与"内存分配"相关的调优实践——Kafka 的 JVM Heap 要小（6-8GB），把大部分内存留给 Page Cache。这是因为 Kafka 的数据缓存靠 Page Cache（而非 JVM Heap），JVM Heap 只存"元数据 + 消息处理缓冲"。如果 JVM Heap 太大（譬如 20GB），Page Cache 只有 4GB，热数据放不下——追尾消费要从磁盘读。所以 Kafka 的内存分配是"JVM Heap 小，Page Cache 大"——与数据库（Buffer Pool 大，Page Cache 无）相反。**Kafka "JVM Heap 小 + Page Cache 大"是"依赖 Page Cache"的内存策略**——这是 Kafka 与数据库的内存分配差异。

Kafka 的 sendfile 零拷贝还有一个与"数据路径"相关的细节——传统读文件 + 发网络的路径是"磁盘 → Page Cache → 用户缓冲区 → Socket 缓冲区 → 网卡"，4 次拷贝（2 次 CPU + 2 次 DMA）。sendfile 的路径是"磁盘 → Page Cache → Socket 缓冲区 → 网卡"，2 次拷贝（0 次 CPU + 2 次 DMA）——省了"Page Cache → 用户缓冲区"和"用户缓冲区 → Socket 缓冲区"两次 CPU 拷贝。所以 sendfile 不只是"少一次系统调用"，更是"少两次 CPU 拷贝"——这是零拷贝的本质。**sendfile 省"2 次 CPU 拷贝"是零拷贝的本质**——这是 Kafka 消费吞吐高的底层原因。

Kafka 的 sendfile 还有一个与"TLS"相关的局限——sendfile 直接从 Page Cache 到 Socket，无法在中间做 TLS 加密（TLS 要 CPU 操作数据，而 sendfile 的数据不经过 CPU）。所以 Kafka 启用 TLS 后，sendfile 失效——退化为"read + encrypt + write"，性能下降。这是 Kafka "TLS 与性能"的权衡——TLS 安全牺牲 sendfile 零拷贝。解法是"TLS 卸载到网卡"（如果网卡支持 TLS 加密），让 sendfile + TLS offload 共存。**TLS 让 sendfile 失效，要用 TLS offload 补救**——这是 Kafka 在"安全 vs 性能"的 IO 模式权衡。

### 3.3 高性能 Key-Value 缓存（Redis）

**推荐模式：内存直接操作（所有数据在内存），持久化使用 Direct IO**

Redis 的工作数据完全在内存中，IO 只涉及持久化（RDB 快照 + AOF 日志）：

```bash
# Redis AOF 的 fsync 策略（三选一）
# appendfsync always   # 每次写命令后 fsync → 最安全，最慢（约 1000 ops/s）
# appendfsync everysec # 每秒 fsync → 默认，平衡（约 10 万 ops/s，最多丢 1 秒数据）
# appendfsync no       # 依赖 OS flush → 最快（约 100 万 ops/s，重启可能丢数据）

# RDB 持久化（BGSAVE）：fork 子进程，顺序写全量数据
# 建议：将 RDB 文件写入 tmpfs（如果内存够），然后异步复制到持久存储
# 或者，在副本节点做 RDB，主节点不做 RDB 持久化（降低主节点 IO 压力）

# Redis 的 IO 密集场景：大量客户端同时请求 → 单线程模型下的 IO 复用
# Redis 6.0+ 引入了 I/O 多线程：io-threads 4
# 用多线程处理网络 IO（读请求/写响应），命令执行仍单线程
```

Redis 的 IO 模式有一个与"内存 vs 磁盘"相关的特殊性——Redis 的工作数据全在内存，IO 只在持久化时发生。所以 Redis 的"IO 性能"主要是"持久化 IO 的延迟影响"——AOF 的 `fsync` 要等磁盘确认，这个等待会阻塞 Redis 主线程。`appendfsync always` 每次写都 fsync，延迟最高（每次 fsync ~1ms）；`everysec` 每秒 fsync 一次，延迟影响小（最多 1 秒阻塞一次）；`no` 不 fsync，无延迟影响但可能丢数据。**Redis 的 IO 调优是"持久化延迟 vs 数据安全"的权衡**——这是 Redis 独特的 IO 模式，与数据库（Direct IO + 自管理缓存）和消息队列（Buffered IO + Page Cache）都不同。

Redis 的 IO 模式还有一个与"主从复制"相关的实践——Redis 的主从复制用"全量同步（RDB）+ 增量同步（AOF）"。全量同步时主节点 `BGSAVE` 生成 RDB 发给从节点，这个 `BGSAVE` 的 IO 会影响主节点延迟。解法是"在从节点做 RDB"——从节点定期 `BGSAVE` 备份，主节点不做持久化——主节点无 IO 影响，延迟最优。这种"主节点纯内存，从节点做持久化"的架构是 Redis 生产环境的常见部署。**Redis "主节点纯内存 + 从节点持久化"是延迟最优部署**——这是 Redis IO 调优的架构级决策。

Redis 的 IO 模式还有一个与"Redis 6.0 多线程 IO"相关的演进——Redis 6.0 之前是"单线程处理所有客户端 IO + 命令"，6.0 引入"IO 多线程"——网络读写用多线程，命令执行仍单线程。这解决了"单线程网络 IO"的瓶颈——高并发客户端时，单线程读写 Socket 成为瓶颈。但磁盘 IO（持久化）仍单线程（BGSAVE 的 fork 子进程除外）。所以 Redis 6.0 的多线程优化的是"网络 IO"而非"磁盘 IO"——这是 Redis IO 模型的演进方向。**Redis 6.0 "网络 IO 多线程 + 命令单线程"是 IO 模型演进**——这是 Redis 并发优化的新方向。

Redis 的 IO 模型演进还有一个与"Redis 7.0 多线程 AOF"相关的进展——Redis 7.0 引入"多线程 AOF"——AOF 的 fsync 在子线程做，不阻塞主线程。这解决了 `appendfsync always` 的"每次 fsync 阻塞主线程"问题——主线程把 AOF 写入交给子线程，子线程 fsync，主线程继续处理命令。所以 Redis 7.0 的 `appendfsync always` 不再阻塞——这是 Redis 持久化 IO 的重大改进。**Redis 7.0 "多线程 AOF"解除了 fsync 阻塞**——这是 Redis 持久化 IO 的演进，让"always + 低延迟"共存。

### 3.4 分析引擎（ClickHouse、Parquet 扫描）

**推荐模式：Direct IO + io_uring（最大化 NVMe 带宽）**

列式分析引擎的 IO 特征：大块顺序读（1MB+），无重复访问，数据不需要 Page Cache 缓存（查询后不会再访问），需要最大化 NVMe 顺序读带宽：

```cpp
// ClickHouse 的 io_uring 支持（从 22.x 版本）
// config.xml
<io_uring_reader>
    <enable>true</enable>
    <queue_depth>128</queue_depth>
    <use_direct_io>true</use_direct_io>
</io_uring_reader>

// 原理：ClickHouse 的 MergeTree 引擎读取列文件时，
// 使用 io_uring 批量提交多列的 IO 请求（每列一个文件），
// 并行等待所有列的数据就绪，然后进行向量化计算
// 这比串行读取每一列快了列数倍
```

分析引擎用 Direct IO + io_uring 有一个与"Page Cache 污染"相关的考量——分析查询通常扫描大量数据（GB 级），如果用 Buffered IO，这些数据会填满 Page Cache，把其他应用的热数据挤出——这叫"Page Cache 污染"。Direct IO 跳过 Page Cache，不污染缓存，让其他应用的热数据保留在 Page Cache。所以分析引擎用 Direct IO 不只是"避免双重缓存"，更是"避免污染别人的缓存"——在多应用共享服务器时尤其重要。**Direct IO 避免"Page Cache 污染"**——这是分析引擎选 Direct IO 的"邻里友好"考量。

分析引擎用 io_uring 还有一个与"列式存储"相关的协同优势——列式存储的每个列是独立文件，一次查询要读多个列文件。用 `read()` 要串行读每个列（或开多线程），用 io_uring 能批量提交所有列的 IO 请求，并行等待——"列数倍"的加速。譬如一个表有 20 列，io_uring 一次提交 20 个读请求，NVMe 并行处理——比串行读 20 次快 20 倍。**io_uring + 列式存储是"天然协同"**——这是 ClickHouse 选 io_uring 的"列式适配"考量。

分析引擎的 IO 模式还有一个与"内存带宽"相关的下游瓶颈——分析引擎从 NVMe 读数据后，要做"解压 + 解码 + 聚合"计算，这些计算是"内存带宽密集"的。如果 NVMe 读带宽（7GB/s）超过了内存带宽（200GB/s 的 3.5%），看起来不是瓶颈——但解压后的数据膨胀（压缩比 5:1，7GB/s 压缩数据 → 35GB/s 解压数据），35GB/s 已接近内存带宽上限。所以分析引擎的"读带宽"受"内存带宽"限制——NVMe 再快，内存带宽跟不上也白搭。**分析引擎的"读带宽"受"内存带宽"限制**——这是 IO 优化与内存带宽的下游关系，[[04 内存性能调优]] 中已详细讲过内存带宽。

分析引擎的 IO 模式还有一个与"压缩"相关的协同——列式存储通常压缩（压缩比 5:1 到 10:1），Direct IO 读的是压缩数据，解压在 CPU 做。压缩让"磁盘 IO 量"减少 5-10 倍——同样的 NVMe 带宽，压缩数据能读更多逻辑数据。但解压消耗 CPU——所以分析引擎的"读性能"是"NVMe 带宽 + CPU 解压 + 内存带宽"的复合瓶颈。压缩是"用 CPU 换 IO"——在 IO 受限时划算，在 CPU 受限时不划算。**列式压缩是"用 CPU 换 IO"**——这是分析引擎 IO 优化的"压缩协同"，要根据瓶颈在 IO 还是 CPU 决定压缩级别。

---

## 第 4 章 IO 模式的边界条件与反例

### 4.1 mmap 的隐藏陷阱：SIGBUS 和 文件截断

```c
/* 危险！映射后修改文件大小会导致 SIGBUS */
void *addr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
ftruncate(fd, 0);  /* 将文件截断为 0 字节 */
*((int *)addr) = 42;  /* 访问已不存在的文件区域 → SIGBUS！程序崩溃 */

/* 解决：先 munmap，再修改文件大小 */
munmap(addr, 4096);
ftruncate(fd, 0);
```

mmap 的 SIGBUS 有一个与"多进程"相关的恶化场景——如果进程 A mmap 了文件，进程 B `ftruncate` 了同一文件，进程 A 访问已截断的区域会 SIGBUS 崩溃。这种"跨进程的 mmap 陷阱"很难排查——进程 A 不知道文件被 B 截断了，访问时突然崩溃。解法是"mmap 后用文件锁保护"——`flock` 或 `fcntl` 锁定文件，防止其他进程修改大小。**mmap 的 SIGBUS 是"跨进程陷阱"**——这是 mmap 在多进程场景的安全隐患，单进程场景只要"先 munmap 再 truncate"就能避免。

mmap 还有一个与"大文件"相关的地址空间问题——32 位系统地址空间只有 3GB（用户态），mmap 一个 4GB 文件无法映射（地址空间不够）。64 位系统地址空间 128TB，mmap 大文件无压力——但要注意"VMA 数量上限"——每个 mmap 调用创建一个 VMA，内核默认 VMA 上限 65530（`vm.max_map_count`）。如果一个进程 mmap 10 万个小文件，VMA 超限报错。解法是"合并映射"（用 `mmap` 映射一个大区域而非多个小区域）或调高 `vm.max_map_count`。**mmap 的 VMA 上限是"大量小文件映射"的瓶颈**——这是 mmap 在"多文件"场景的约束。

mmap 还有一个与"写性能"相关的局限——mmap 的写（`MAP_SHARED + PROT_WRITE`）要先 Page Fault 读入页，再修改，最后由内核回写。这个"先读后写"的流程对"覆盖写"不友好——譬如要覆盖写一个 4KB 区域，mmap 要先 Page Fault 读入原数据（磁盘 IO），再覆盖——多了一次无意义的读。而 `write()` 直接覆盖（不读原数据）。所以 mmap 适合"读多写少"或"追加写"，不适合"覆盖写"。**mmap 的"覆盖写"有"先读后写"开销**——这是 mmap 在写场景的局限。

### 4.2 Direct IO 的对齐陷阱

```c
/* 错误：写入大小不是 512 字节的整数倍 */
int fd = open("file", O_WRONLY | O_DIRECT);
char *buf = malloc(1000);  /* 1000 字节，不是 512 的整数倍 */
write(fd, buf, 1000);      /* 返回 -1，errno = EINVAL */

/* 错误：缓冲区地址不对齐 */
char *buf = malloc(4096 + 1);  /* 偏移 1 字节 */
buf++;                          /* buf 地址不对齐 */
write(fd, buf, 4096);           /* EINVAL */

/* 正确：使用 posix_memalign 分配对齐内存 */
void *buf;
posix_memalign(&buf, 512, 4096);  /* 512 字节对齐，4096 字节大小 */
write(fd, buf, 4096);             /* OK */
```

Direct IO 的对齐陷阱有一个与"语言"相关的实践——C/C++ 可以用 `posix_memalign` 分配对齐内存，但 Java/Python 等高级语言的 `malloc` 不保证对齐。Java 用 Direct ByteBuffer（`ByteBuffer.allocateDirect`）能保证对齐（JVM 内部用 `posix_memalign`），Python 要用 `mmap` 模块或 `ctypes` 分配对齐内存。所以 Direct IO 在 C/C++ 中容易用，在高级语言中要用语言特定的对齐分配 API。**Direct IO 的对齐要求"语言相关"**——C/C++ 容易，高级语言要用特定 API，这是 Direct IO 的"语言门槛"。

Direct IO 的对齐还有一个与"文件系统"相关的细节——不同文件系统的对齐要求不同。XFS 和 ext4 要求 4096 字节对齐（页大小），而某些网络文件系统（NFS）可能不支持 `O_DIRECT` 或对齐要求不同。所以 Direct IO 的可移植性受文件系统影响——在 XFS/ext4 上可靠，在 NFS/overlayfs 上可能有问题。生产环境用 Direct IO 要确认文件系统支持——`man 2 open` 的 `O_DIRECT` 部分有各文件系统的支持情况。**Direct IO 的对齐要求"文件系统相关"**——这是 Direct IO 的可移植性约束。

Direct IO 还有一个与"网络文件系统"相关的特殊问题——NFS 的 `O_DIRECT` 支持不一致——某些 NFS 服务器支持，某些不支持，某些支持但性能更差（NFS 的 Direct IO 要跨网络同步，延迟高）。对于 NFS 上的数据库，用 Direct IO 要先测试——如果 NFS 的 Direct IO 性能不如 Buffered IO，用 Buffered IO + `fsync` 更可靠。生产环境数据库不建议放 NFS 上——本地 NVMe + Direct IO 是最可靠的高性能组合。**NFS 上的 Direct IO 不可靠**——这是 Direct IO 在网络文件系统的局限，生产数据库要用本地存储。

### 4.3 io_uring 的权限和内核版本要求

```bash
# io_uring SQPOLL 需要 root 权限（或 CAP_SYS_ADMIN）
# 在容器中使用 io_uring 需要确保：
# 1. 内核版本 >= 5.1（基本功能），>= 5.10（稳定性较好），>= 5.19（Fixed Buffer 改进）
uname -r
# 5.15.0-91-generic  ← 满足要求

# 2. Kubernetes seccomp 配置需要允许 io_uring 相关的系统调用
# seccomp profile 中需要允许：io_uring_setup, io_uring_enter, io_uring_register

# 3. 检查 io_uring 是否被内核禁用
cat /proc/sys/kernel/io_uring_disabled
# 0 = 允许, 1 = 禁止非 root 使用, 2 = 完全禁止
```

io_uring 的权限要求有一个与"安全"相关的争议——io_uring 的共享内存队列和 SQPOLL 内核线程引入了新的攻击面，某些安全团队建议禁用 io_uring（`io_uring_disabled=2`）。Google 的 gVisor 沙箱和某些容器平台默认禁用 io_uring。所以 io_uring 在"高性能"和"安全"之间有权衡——高性能场景启用，高安全场景禁用。**io_uring 有"安全争议"**——这是 io_uring 在生产环境的采用障碍，要根据安全要求决定是否启用。

io_uring 的安全争议还有一个与"容器"相关的实践——Docker 默认的 seccomp profile 不允许 `io_uring_setup`/`io_uring_enter`/`io_uring_register` 系统调用，容器内用 io_uring 会 `EPERM`。要在容器内用 io_uring，要自定义 seccomp profile 允许这三个系统调用，或用 `--security-opt seccomp=unconfined`（不推荐，降低安全性）。Kubernetes 的 seccomp profile 同理。所以容器化应用的 io_uring 采用受"安全策略"限制——不是"内核支持就能用"，还要"安全策略允许"。**容器内 io_uring 要"seccomp 放行"**——这是 io_uring 在容器环境的采用门槛。

io_uring 在容器环境还有一个与"内核版本"相关的约束——容器共享宿主机内核，如果宿主机内核 < 5.1，容器内也无法用 io_uring（即使容器内的应用支持）。所以 io_uring 的采用受"宿主机内核版本"限制——这在 K8s 环境尤其明显——K8s 集群的内核版本升级是"集群级"操作，不是单个 Pod 能控制的。如果集群内核 < 5.1，所有 Pod 都用不了 io_uring。**io_uring 的采用受"宿主机内核版本"限制**——这是 io_uring 在 K8s 集群的"基础设施依赖"。

---

## 第 5 章 IO 模式选型决策矩阵

```
选型决策树：

Q1：应用是否有自己的内存缓存（Buffer Pool / Block Cache）？
  ├─ 是 → 使用 Direct IO（避免双重缓存）
  │         Q2：IO 并发度高吗？
  │           ├─ 高（>= 32 并发）→ Direct IO + io_uring
  │           └─ 低（< 16 并发）→ Direct IO + libaio 或 sync
  │
  └─ 否 → 使用 Buffered IO 或 mmap（依赖 Page Cache）
           Q3：访问模式是随机还是顺序？
             ├─ 随机访问大文件 → mmap（消除系统调用，直接指针访问）
             ├─ 顺序写（日志/消息队列）→ Buffered IO + O_APPEND
             ├─ 读写混合，热数据重复访问 → Buffered IO（Page Cache 自动缓存热数据）
             └─ 大块顺序扫描（分析型）→ Direct IO + io_uring（跳过 Page Cache 减少污染）
```

| 应用类型 | 推荐 IO 模式 | 理由 |
|---------|------------|------|
| 数据库（MySQL/PG/RocksDB）| Direct IO | 自有 buffer pool，Page Cache 是多余 |
| 消息队列（Kafka）| Buffered IO | 依赖 Page Cache 作为缓存层 |
| KV 存储（Redis）| 内存（工作数据）+ Direct IO（持久化）| 工作数据全在内存 |
| 分析引擎（ClickHouse）| Direct IO + io_uring | 大块顺序扫描，最大化 NVMe 带宽 |
| 文件服务器（Nginx 静态文件）| sendfile（Buffered IO + 零拷贝）| Page Cache 热文件，sendfile 减少拷贝 |
| 搜索引擎（Elasticsearch）| mmap（Lucene 索引文件）| 随机访问大索引文件，mmap 减少系统调用 |

选型决策树有一个与"混合模式"相关的进阶——复杂应用可能"不同数据用不同 IO 模式"。譬如 Elasticsearch 的 Lucene 用 mmap 读索引（随机访问），但用 Buffered IO 写 segment（顺序写）。RocksDB 的 memtable 用内存（无 IO），SSTable 用 Direct IO 读（自管理缓存），WAL 用 Buffered IO + fsync（顺序写 + 持久化）。所以 IO 模式选型不是"一个应用选一个模式"，而是"不同数据路径选不同模式"。**复杂应用"按数据路径选 IO 模式"**——这是 IO 选型的精细化实践。

IO 模式选型还有一个与"演进"相关的动态性——应用的 IO 模式不是一成不变的，随业务变化而变化。譬如一个应用初期是"读写混合"（用 Buffered IO），后来变成"以读为主 + 自管理缓存"（要改 Direct IO）。IO 模式选型要随业务演进重新评估——不能"一次选型永久用"。定期用 `iostat` 和 `bpftrace` 监控 IO 模式变化，当模式变化时重新选型。**IO 模式选型是"动态的"，随业务演进重新评估**——这是 IO 选型的时间维度。

IO 模式选型还有一个与"团队能力"相关的实践考量——io_uring 的编程复杂度高于 libaio/sync，团队要有"异步编程"能力（回调、状态机、错误处理）。如果团队没有异步编程经验，用 io_uring 可能引入 bug（回调时序错误、资源泄漏）——不如用 libaio 稳妥。所以 IO 模式选型不只看"性能"，还要看"团队能力"——性能再好，团队 hold 不住也白搭。**IO 模式选型要考虑"团队能力"**——这是技术选型的"人因因素"，不能只看技术指标。

---

## 第 6 章 IO 模式选型的边界与盲区

### 6.1 IO 模式无法解决数据访问模式低效

IO 模式优化能减少"IO 的内核路径开销"，但不能减少"IO 的次数"。如果一个应用因为算法低效（譬如全表扫描代替索引查找）发了 100 倍的 IO，再好的 IO 模式也救不了——100 倍 IO 量让设备饱和。**IO 模式优化"每次 IO 的开销"，算法优化减少"IO 的次数"**——后者收益更大，要先做算法优化（索引、缓存、批量），再做 IO 模式选型。

IO 模式优化与算法优化的优先级有一个与"投入产出比"相关的考量——算法优化（加索引、加缓存）需要开发投入（改代码），但收益大（10-100 倍）；IO 模式选型（换 Direct IO、换 io_uring）需要架构投入（改 IO 路径），收益中等（2-5 倍）。所以"投入产出比"上，算法优化更划算——但前提是"算法有优化空间"。如果算法已优化到极限，IO 模式选型是"下一层优化"。**"算法优化到极限后，IO 模式选型才有意义"**——这是两层优化的时序关系。

IO 模式选型与算法优化的协同还有一个与"监控"相关的闭环——IO 模式选型后，要监控"IO 性能是否达到预期"。用 `iostat` 看 IOPS/延迟，用 `bpftrace` 看系统调用次数，对比选型前后的指标。如果选型后性能没提升，说明"IO 模式不是瓶颈"——要重新诊断。**"选型 → 监控 → 验证"是 IO 模式选型的闭环**——不能"选了就完"，要验证效果。

### 6.2 io_uring 不是银弹

io_uring 在高并发异步 IO 场景有显著优势，但在低并发同步 IO 场景可能不如 `read()`——io_uring 的初始化（`io_uring_queue_init`）有开销（分配共享内存、创建队列），如果只做少量 IO 就退出，初始化开销摊不薄。所以 io_uring 适合"长生命周期 + 高并发"的服务（譬如数据库、消息队列），不适合"短生命周期 + 低并发"的脚本（譬如一次性备份工具）。**io_uring 有"初始化开销"，适合长服务不适合短脚本**——这是 io_uring 的适用边界。

io_uring 还有一个与"调试"相关的劣势——io_uring 的异步模式让"IO 完成时序"不可预测，调试困难。同步 IO 的 `read()` 返回时数据就绪，调用栈清晰；io_uring 的 `io_uring_submit` 后 IO 异步执行，完成时通过 CQ 通知——完成时的调用栈与提交时的调用栈无关。如果 IO 出错，要在 CQ 的完成回调里处理，而非提交时的调用栈——调试逻辑复杂。所以 io_uring 的"异步"提高了性能但降低了"可调试性"——这是性能与可维护性的权衡。**io_uring 的异步让"调试复杂"**——这是 io_uring 的"可维护性代价"。

io_uring 的调试劣势还有一个与"性能分析"相关的挑战——传统的 `strace` 能追踪系统调用，但 io_uring 的 SQPOLL 模式无系统调用——`strace` 看不到 IO 提交。要追踪 io_uring 的 IO，要用 `bpftrace` 追踪 `io_uring_setup`/`io_uring_enter` tracepoint 或用 `perf trace`。所以 io_uring 的"可观测性"比传统 IO 差——传统 IO 用 `strace` 就能看，io_uring 要用 BPF 工具。**io_uring 的"可观测性"比传统 IO 差**——这是 io_uring 的"运维代价"，要有 BPF 工具链支持。

### 6.3 mmap 的 Page Fault 抖动

mmap 的 Page Fault 有一个与"P99 延迟"相关的盲区——Page Fault 的延迟是"不可预测"的，取决于"磁盘当前负载"。如果磁盘空闲，Page Fault 100µs；如果磁盘繁忙，Page Fault 可能 10ms——这种"延迟不可预测"让 mmap 的 P99 难以控制。对延迟敏感的服务（Redis、交易系统），mmap 的 Page Fault 抖动是不可接受的——要用 `MAP_POPULATE` 预读整个文件（消除 Page Fault）或用 `pread` 替代（延迟可控）。**mmap 的 Page Fault 让"P99 不可预测"**——这是 mmap 在延迟敏感场景的盲区。

mmap 的 Page Fault 抖动还有一个与"内存压力"相关的恶化场景——当系统内存紧张时，内核的 `kswapd` 会回收 Page Cache 页（包括 mmap 映射的页）。被回收的页下次访问重新触发 Page Fault——磁盘繁忙 + 内存紧张时，Page Fault 频繁且延迟高。所以 mmap 在"内存充足"时性能好，在"内存紧张"时性能急剧下降——这是 mmap 的"内存敏感性"。用 `mlock()` 锁定关键页（防止回收）能缓解，但 `mlock` 要 root 权限且消耗内存。**mmap 的性能"内存敏感"，内存紧张时急剧下降**——这是 mmap 的"内存依赖"盲区。

mmap 的内存敏感性还有一个与"大文件"相关的恶化场景——如果 mmap 的文件大于物理内存（譬如 100GB 文件在 64GB 内存机器上），Page Cache 只能缓存部分页——频繁的"换入换出"让 Page Fault 极频繁，性能急剧下降。这种"mmap 大于内存"的场景是 mmap 的"灾难区"——要用 `read()` 分块读替代（每次只读需要的部分，不污染 Page Cache）。**"mmap 大于内存"是 mmap 的灾难区**——这是 mmap 的"容量约束"，大文件要用 `read()` 分块。

---

## 第 7 章 小结

四种 IO 模式没有绝对的优劣，关键是**匹配应用的 IO 特征**：

- **Buffered IO**：最简单，适合大多数场景。Page Cache 自动缓存热数据，顺序访问有预读加速
- **Direct IO**：适合有自管理缓存的应用，消除双重缓存，减少内存浪费
- **mmap**：适合随机访问大文件，消除系统调用开销，直接指针访问 Page Cache
- **io_uring**：适合高并发异步 IO，通过批量提交大幅减少系统调用次数，是未来高性能 IO 的方向

**错误匹配的代价**：将 Kafka 改为 Direct IO（绕过 Page Cache），会让"追尾消费"（消费最新数据）从内存速度退化为磁盘速度，吞吐量下降 10-100 倍。将 MySQL 改为 Buffered IO，会导致 Buffer Pool 和 Page Cache 的双重缓存，内存利用率减半，且写入时有额外的 CPU 拷贝开销。

IO 模式选型的核心认知是"IO 路径不是统一的"——同一块 NVMe SSD，经过 Page Cache（Buffered IO）、绕过 Page Cache（Direct IO）、映射为内存（mmap）、异步批量提交（io_uring）的路径不同，性能特征截然不同。**"IO 性能"不是"设备性能"的函数，而是"设备 × IO 模式"的复合函数**——理解这个复合函数，才能为应用选对 IO 模式。下一篇进入网络性能调优——网络协议栈的调优有类似的"多层路径"复杂性。

IO 模式选型的认知框架可以总结为一个核心命题——**"IO 路径决定 IO 性能"**。同一个 IO 请求，经过 Page Cache（Buffered IO）、绕过 Page Cache（Direct IO）、映射为内存（mmap）、异步批量提交（io_uring）的路径不同，性能截然不同。选型的本质是"为应用的 IO 特征选最短路径"——有自管理缓存的选 Direct IO（绕过 Page Cache），追尾消费的选 Buffered IO（利用 Page Cache），随机访问大文件的选 mmap（消除系统调用），高并发异步的选 io_uring（批量提交）。**"选对路径"比"换更快设备"收益更大**——这是 IO 模式选型的核心价值，也是为什么"同一块 SSD 不同应用性能差 10 倍"。

下一篇 [[07 网络性能调优——全栈参数配置与基准测试]] 将对前面网络协议栈专栏中散落各篇的调优内容进行**系统性整合**，给出从 NIC 驱动到应用层的完整 sysctl 调优参数清单，以及如何用 `iperf3`/`netperf` 科学地进行网络基准测试，验证调优效果。

---

## 参考资料

1. Jens Axboe, "io_uring: Linux 的异步 IO 接口" documentation. https://kernel.dk/io_uring.pdf
2. Linux kernel documentation, "io_uring". https://www.kernel.org/doc/html/latest/io_uring/
3. Linux man pages, "open(2) - O_DIRECT", "mmap(2)", "sendfile(2)".
4. Brendan Gregg, "Linux IO Stack Performance Analysis"（IO 路径与性能分析）.
5. MySQL documentation, "InnoDB Disk I/O and Page Cache". https://dev.mysql.com/doc/refman/8.0/en/innodb-performance-io.html
6. Apache Kafka documentation, "Kafka Design: Page Cache and Sendfile". https://kafka.apache.org/documentation/#design
7. ClickHouse documentation, "io_uring Reader". https://clickhouse.com/docs/en/operations/configuration-files/
8. Jens Axboe, "Linux Block IO: Present & Future"（io_uring 与 blk-mq 的协同设计）.

---

> [!note] 思考题
> 1. `mmap` 的 Page Fault 开销在高频小 IO 场景下可能成为瓶颈。在顺序读大文件时 mmap 比 read() 更快（少一次用户态/内核态数据拷贝）。但在随机读小块数据时，mmap 的 Page Fault 开销可能抵消拷贝节省。RocksDB 在什么层使用 mmap？为什么 RocksDB 提供了 mmap 和 pread 两种读取模式？
> 2. `io_uring` 的 `IORING_SETUP_SQPOLL` 模式让内核线程持续轮询提交队列。在高 IOPS 场景（>500K IOPS）下，轮询避免了每次提交的系统调用开销。但空闲时 CPU 仍在消耗——`sq_thread_idle` 参数如何在响应性和 CPU 开销之间取得平衡？在什么 IOPS 水平下 SQPOLL 模式开始有收益？
> 3. `io_uring` 支持 linked SQEs（链式提交）。'先 read 再 write'可作为原子序列提交。如果链中第一个操作失败，后续操作是否被取消？`IOSQE_IO_HARDLINK` 和 `IOSQE_IO_LINK` 在失败处理上有什么区别？
