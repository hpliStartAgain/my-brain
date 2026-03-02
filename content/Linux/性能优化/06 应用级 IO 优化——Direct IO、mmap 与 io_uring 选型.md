---
title: "应用级 IO 优化——Direct IO、mmap 与 io_uring 选型"
date: 2026-03-02
tags: [Linux, 性能优化, DirectIO, mmap, io_uring, bufferedIO, Page Cache, 零拷贝, IO模式, 系统调用]
aliases: ["IO模式选型", "DirectIO vs mmap", "io_uring性能", "应用IO优化", "Page Cache绕过"]
---

**摘要：**

同一块 NVMe SSD，同样的数据读写量，不同的 IO 接口可以产生 3-10 倍的性能差距。这不是夸张——Linux 提供了四种截然不同的 IO 模式，每种模式在**内核路径长度、数据拷贝次数、系统调用开销、CPU 使用率**上都有根本性差异：**Buffered IO**（默认，经过 Page Cache，适合大多数场景）、**Direct IO**（绕过 Page Cache，适合自管理缓存的数据库）、**mmap**（内存映射，适合随机访问大文件）、**io_uring**（异步批量提交，适合高并发 IO 密集型服务）。本文不是工具介绍，而是**选型方法论**：每种模式的内核实现原理，以及"什么场景下用什么，为什么"的深度分析。包含横向性能对比数据和四个典型应用场景（数据库、消息队列、缓存服务、分析引擎）的最优 IO 模式推荐。

---

## 第 1 章 四种 IO 模式的内核路径差异

### 1.1 Buffered IO：默认路径

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

### 1.2 Direct IO：绕过 Page Cache

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

### 1.3 mmap：将文件映射为内存地址

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

### 1.4 io_uring：异步批量提交，最小化系统调用

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

---

## 小结

四种 IO 模式没有绝对的优劣，关键是**匹配应用的 IO 特征**：

- **Buffered IO**：最简单，适合大多数场景。Page Cache 自动缓存热数据，顺序访问有预读加速
- **Direct IO**：适合有自管理缓存的应用，消除双重缓存，减少内存浪费
- **mmap**：适合随机访问大文件，消除系统调用开销，直接指针访问 Page Cache
- **io_uring**：适合高并发异步 IO，通过批量提交大幅减少系统调用次数，是未来高性能 IO 的方向

**错误匹配的代价**：将 Kafka 改为 Direct IO（绕过 Page Cache），会让"追尾消费"（消费最新数据）从内存速度退化为磁盘速度，吞吐量下降 10-100 倍。将 MySQL 改为 Buffered IO，会导致 Buffer Pool 和 Page Cache 的双重缓存，内存利用率减半，且写入时有额外的 CPU 拷贝开销。

下一篇 [[07 网络性能调优——全栈参数配置与基准测试]] 将对前面网络协议栈专栏中散落各篇的调优内容进行**系统性整合**，给出从 NIC 驱动到应用层的完整 sysctl 调优参数清单，以及如何用 `iperf3`/`netperf` 科学地进行网络基准测试，验证调优效果。
