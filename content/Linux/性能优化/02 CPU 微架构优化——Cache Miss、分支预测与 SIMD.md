---
title: "CPU 微架构优化——Cache Miss、分支预测与 SIMD"
date: 2026-03-02
tags: [Linux, 性能优化, CPU微架构, Cache Miss, 分支预测, SIMD, TLB, PMU, 内存访问模式, 数据局部性]
aliases: ["CPU微架构优化", "Cache Miss优化", "分支预测优化", "SIMD向量化", "CPU Pipeline优化"]
---

**摘要：**

上一篇用 `perf` 定位到了热点函数，但有时你会发现：某个函数在火焰图中占据很大面积，代码逻辑也很简单（比如一个循环遍历数组），却莫名地慢。这类问题的根因不在算法复杂度，而在 **CPU 微架构层**——现代 CPU 为了掩盖内存访问延迟（DRAM ~70ns vs L1 Cache ~4 cycles）设计了极为复杂的流水线、多级缓存、分支预测、乱序执行等机制，当代码的访问模式与这些机制"对齐"时性能极高；一旦"对抗"这些机制，性能可以下降 10-100 倍。本文从 CPU 缓存层次结构出发，深入分析三类最常见的微架构性能问题：**Cache Miss**（数据不在缓存中，CPU 必须等待内存）、**分支预测失效**（CPU 执行了错误的指令路径，必须回滚 pipeline）、**SIMD 向量化未充分利用**（同样的循环，向量化版本可以快 4-16 倍）。每个问题都给出 `perf stat` 的硬件计数器诊断方法和具体的代码级优化手段。

---

## 第 1 章 CPU 缓存层次：为什么内存访问延迟差距如此悬殊

### 1.1 现代 CPU 的存储层次

理解缓存优化之前，必须对各级存储的延迟有直观感受。以 Intel Ice Lake（10nm）为例：

| 存储层级 | 容量（典型）| 访问延迟 | 带宽 |
|---------|-----------|---------|-----|
| L1 指令缓存 | 32 KB/核 | **~4 cycles（~1.2 ns）** | ~1 TB/s |
| L1 数据缓存 | 48 KB/核 | **~5 cycles（~1.5 ns）** | ~1 TB/s |
| L2 缓存 | 512 KB/核 | **~12 cycles（~4 ns）** | ~400 GB/s |
| L3 缓存（LLC）| 2-4 MB/核（共享）| **~40 cycles（~12 ns）** | ~200 GB/s |
| DRAM（本地 NUMA）| 64-512 GB | **~80 ns（~270 cycles）** | ~50 GB/s |
| DRAM（远端 NUMA）| — | **~150 ns（~500 cycles）** | ~25 GB/s |
| NVMe SSD | — | ~100 µs | ~7 GB/s |

**延迟差距的直观感受**：如果 L1 缓存访问是"从书桌上拿书"（1 秒），L3 缓存就是"从房间里的书架拿书"（10 秒），而 DRAM 就是"开车去图书馆借书"（4.5 分钟）。当你的代码每次循环都触发一次 DRAM 访问（cache miss），相当于每次循环都要开车去图书馆——无论逻辑多简单，都会极其缓慢。

### 1.2 Cache Line：缓存的基本操作单位

CPU 缓存不以字节为单位工作，而是以 **Cache Line**（通常 64 字节）为单位传输数据。当访问某个内存地址时，即使只需要读取 4 字节的 `int`，CPU 也会将包含这 4 字节的整个 64 字节 Cache Line 从 DRAM 或上级缓存加载到下级缓存。

这个设计有两个重要含义：

**含义 1：空间局部性（Spatial Locality）会被自动利用**。访问数组元素 `a[0]` 时，CPU 会将 `a[0]` 到 `a[15]`（共 16 个 `int`，恰好 64 字节）全部加载到缓存。因此顺序访问数组（`for i: a[i]`）只需要每 16 个元素触发一次 cache miss，随机访问则每次都触发 cache miss——这就是"顺序访问比随机访问快 10-100 倍"的根本原因。

**含义 2：False Sharing（伪共享）陷阱**。如果两个线程分别修改位于**同一 Cache Line 内的不同变量**，即使它们操作的是不同变量，也会导致缓存一致性协议（MESI）反复使对方的缓存行失效（Invalidate），形成"cache line 乒乓"，产生大量 L1/L2 写失效：

```c
/* 伪共享的典型案例 */
struct Counter {
    int64_t count_a;  /* 线程 A 的计数器 */
    int64_t count_b;  /* 线程 B 的计数器 */
    /* count_a 和 count_b 在同一个 64 字节 Cache Line 中！*/
};

/* 线程 A 不断递增 count_a，线程 B 不断递增 count_b
   每次写操作都导致对方的 Cache Line 失效 → 性能严重下降 */
```

```c
/* 修复：填充到不同 Cache Line */
struct Counter {
    int64_t count_a;
    char pad_a[56];  /* 填充到 64 字节边界 */
    int64_t count_b;
    char pad_b[56];
};

/* 或用 C++17 的 hardware_destructive_interference_size */
struct alignas(std::hardware_destructive_interference_size) Counter {
    int64_t count_a;
};
```

---

## 第 2 章 Cache Miss 的诊断与优化

### 2.1 用 perf stat 量化 Cache Miss 程度

```bash
# 采集 LLC（最后一级缓存）miss 相关计数器
perf stat -e cycles,instructions,LLC-loads,LLC-load-misses,LLC-stores,LLC-store-misses \
    -p <pid> sleep 10

# 典型输出：
# Performance counter stats for process '<pid>':
#
#  85,234,567,890  cycles
#  42,617,283,945  instructions          #   0.50  insn per cycle  ← IPC 很低！
#   3,456,789,012  LLC-loads
#     987,654,321  LLC-load-misses       #  28.5% of all LLC loads ← ！！高 miss 率
#     456,789,012  LLC-stores
#      45,678,901  LLC-store-misses      #  10.0% of all LLC stores
#
# 解读：
# IPC = 0.50（理想值 2-4）：CPU 流水线经常空转
# LLC miss 率 = 28.5%：接近三成的内存读取需要去 DRAM 拿数据
# 这说明程序的内存访问模式很差，数据局部性不足

# 更细粒度：分 L1/L2/LLC 三层分析
perf stat -e \
    L1-dcache-loads,L1-dcache-load-misses,\
    L2-loads,L2-load-misses,\
    LLC-loads,LLC-load-misses \
    -p <pid> sleep 5

# 找出哪段代码导致 LLC miss（采样模式）
perf record -e LLC-load-misses -g -p <pid> -- sleep 30
perf report | head -20
# 直接告诉你"哪个函数/调用链导致了 LLC miss"
```

### 2.2 数据布局优化：AoS vs SoA

**AoS（Array of Structures，结构体数组）** vs **SoA（Structure of Arrays，数组的结构体）** 是缓存友好性中最经典的数据布局问题：

```c
/* AoS 布局（常见但缓存不友好）*/
struct Particle {
    float x, y, z;     /* 位置：12 字节 */
    float vx, vy, vz;  /* 速度：12 字节 */
    float mass;         /* 质量：4 字节 */
    float charge;       /* 电荷：4 字节 */
    /* 每个 Particle 32 字节，2 个粒子恰好一个 Cache Line */
};

struct Particle particles[1000000];

/* 场景：只更新位置（只需要 x, y, z, vx, vy, vz）*/
for (int i = 0; i < N; i++) {
    particles[i].x += particles[i].vx * dt;
    particles[i].y += particles[i].vy * dt;
    particles[i].z += particles[i].vz * dt;
}
/* 每个 Cache Line 加载 32 字节，但只使用 24 字节（x,y,z,vx,vy,vz）
   mass 和 charge 被白白加载，浪费了 25% 的缓存带宽
   100 万粒子 × 32 字节 = 32 MB，远超 L3 缓存 → 大量 LLC miss */
```

```c
/* SoA 布局（缓存友好）*/
struct Particles {
    float *x, *y, *z;     /* 各自独立的数组 */
    float *vx, *vy, *vz;
    float *mass;
    float *charge;
    int count;
};

Particles p;
p.x = new float[1000000]; /* 只有 x, y, z, vx, vy, vz 的数据 */
/* ...分配其他数组... */

/* 只更新位置时，只访问 x, y, z, vx, vy, vz 数组
   这 6 个数组各自顺序访问，Cache Line 内全是有效数据
   内存访问量从 32 MB 降到 24 MB，且顺序访问 prefetch 效率极高 */
for (int i = 0; i < N; i++) {
    p.x[i] += p.vx[i] * dt;
    p.y[i] += p.vy[i] * dt;
    p.z[i] += p.vz[i] * dt;
}
```

**SoA 相对 AoS 的性能提升**：在上述粒子模拟场景中，典型提升 **2-4 倍**（取决于结构体中被忽略字段的比例和数组大小）。编译器也更容易对 SoA 布局的循环进行**自动向量化（Auto-Vectorization）**——因为数据紧密排列，SIMD 指令可以一次处理多个元素。

### 2.3 访问模式优化：矩阵乘法的经典案例

矩阵乘法是"缓存访问模式"教科书级的案例。朴素实现（ijk 顺序）对矩阵 B 的访问是列访问（步长 = 矩阵宽度），每次跳跃一整行，对缓存极不友好：

```c
/* 朴素 ijk 顺序：B 矩阵按列访问，缓存命中率极差 */
void matmul_naive(float A[][N], float B[][N], float C[][N]) {
    for (int i = 0; i < N; i++)
        for (int j = 0; j < N; j++)
            for (int k = 0; k < N; k++)
                C[i][j] += A[i][k] * B[k][j];
                /* B[k][j] 是按列访问：B[0][j], B[1][j], B[2][j]... */
                /* 相邻两次访问相差 N*4 字节（N 行），必然 cache miss */
}
/* N=1024 时：大约 10^9 次浮点运算，但缓存命中率极低，实测约 0.5 GFLOPS */

/* ikj 顺序：调换内两层循环，B 矩阵变为行访问 */
void matmul_ikj(float A[][N], float B[][N], float C[][N]) {
    for (int i = 0; i < N; i++)
        for (int k = 0; k < N; k++) {
            float a_ik = A[i][k];  /* 提升 A[i][k] 到寄存器 */
            for (int j = 0; j < N; j++)
                C[i][j] += a_ik * B[k][j];
                /* B[k][j] 按行访问：B[k][0], B[k][1], B[k][2]... */
                /* 顺序访问！Cache Line 利用率接近 100% */
        }
}
/* N=1024 时：同样 10^9 次运算，缓存命中率极高，实测约 4-8 GFLOPS，提升 8-16 倍 */
```

**更进一步：分块（Tiling/Blocking）**——将矩阵分成适合 L2 缓存大小的小块，确保子矩阵始终在缓存中：

```c
#define BLOCK_SIZE 64  /* 根据 L2 缓存大小选择，使 3 个 BLOCK×BLOCK 的矩阵块装入 L2 */

void matmul_blocked(float A[][N], float B[][N], float C[][N]) {
    for (int ii = 0; ii < N; ii += BLOCK_SIZE)
      for (int kk = 0; kk < N; kk += BLOCK_SIZE)
        for (int jj = 0; jj < N; jj += BLOCK_SIZE)
          /* 对每个块做朴素乘法——此时块尺寸适合缓存 */
          for (int i = ii; i < min(ii+BLOCK_SIZE, N); i++)
            for (int k = kk; k < min(kk+BLOCK_SIZE, N); k++) {
              float a_ik = A[i][k];
              for (int j = jj; j < min(jj+BLOCK_SIZE, N); j++)
                C[i][j] += a_ik * B[k][j];
            }
}
/* 实测约 20-40 GFLOPS（配合 SIMD），接近 BLAS 库的性能 */
```

### 2.4 预取（Prefetch）：主动告知 CPU 未来的访问

当访问模式有规律但编译器无法自动预取时，可以手动插入预取指令（`__builtin_prefetch`），让 CPU 提前加载即将访问的数据，在等待 DRAM 的同时继续执行其他计算：

```c
void process_linked_list(Node *head) {
    Node *curr = head;
    while (curr != nullptr) {
        /* 预取下下个节点（2 步之后要访问的地址）*/
        /* 目的：在处理 curr 的同时，让 CPU 提前加载 curr->next->next */
        if (curr->next && curr->next->next)
            __builtin_prefetch(curr->next->next, 0, 1);
            /* 参数：(地址, rw=0读/1写, locality=0-3=时间局部性) */

        /* 处理当前节点（此时 curr->next 已在缓存中）*/
        process(curr->data);
        curr = curr->next;
    }
}
/* 链表的随机访问本质上无法避免 cache miss，但预取可以将"串行等待"变为"并行预加载"
   典型提升：20-40%（取决于 DRAM 延迟和处理逻辑的复杂度）*/
```

> [!warning] 生产避坑：过度预取适得其反
> 预取指令会占用内存总线带宽和 L1/L2 缓存空间。如果预取的数据实际上没有被访问（预测错误），或者预取距离设置不当（太近=没用，太远=被驱逐出缓存），预取不仅没有帮助，反而会驱逐其他有用的缓存行。原则：**先用 `perf stat -e cache-misses` 确认 miss 率高，再考虑预取**，不要在不必要的地方添加预取指令。

---

## 第 3 章 分支预测：流水线的隐形杀手

### 3.1 为什么分支预测如此重要

现代 CPU 流水线深度通常为 14-20 级（Intel Golden Cove：19 级）。当流水线遇到条件跳转指令（`if/else`、`switch`、循环退出条件）时，必须做出预测：**跳转还是不跳转？** 如果预测正确，流水线继续满速执行；如果预测错误，**已经进入流水线的错误路径指令必须被清除（Pipeline Flush）**，损失约 **15-25 个时钟周期**（相当于一次 L2 缓存 miss）。

**分支预测失效的代价计算**：

```
假设程序每 10 条指令有 1 次分支，分支预测失误率 10%：
每 100 条指令 = 10 次分支 × 10% 失误 × 20 cycles 惩罚
             = 20 cycles 因分支预测白白消耗

若程序平均 IPC = 2，100 条指令本来只需 50 cycles
分支预测失效让有效 CPI（Cycles Per Instruction）从 0.5 增加到 0.7，降低 28% 性能
```

### 3.2 诊断分支预测失效

```bash
# 量化分支预测失误率
perf stat -e branches,branch-misses -p <pid> sleep 10

# 典型输出：
#  12,345,678,901  branches
#     987,654,321  branch-misses          #   8.0% of all branches ← ！！高失误率

# 分支失误率的基准判断：
# < 1%：正常，分支预测工作良好
# 1-5%：可接受，但有优化空间
# > 5%：显著的预测失效，值得深入分析
# > 10%：严重问题，分支行为高度不可预测

# 定位哪段代码有高分支失误率
perf record -e branch-misses -g -p <pid> -- sleep 30
perf report | head -20
# 告诉你"哪个函数在分支失误上花了最多 CPU 时间"
```

### 3.3 数据相关的分支消除

最有效的分支优化是**彻底消除分支**，将条件判断转化为算术运算（无分支计算）：

```c
/* 有分支版本：绝对值函数 */
int abs_branch(int x) {
    if (x < 0) return -x;  /* 分支 */
    return x;
}

/* 无分支版本：利用算术运算 */
int abs_branchless(int x) {
    int mask = x >> 31;  /* 负数：全 1（0xFFFFFFFF），正数：全 0 */
    return (x + mask) ^ mask;
    /* 负数：(x + (-1)) XOR (-1) = (-x - 1) XOR (-1) = -x  ✓
       正数：(x + 0) XOR 0 = x                             ✓ */
}

/* 无分支版本 2：利用三元运算符（编译器通常能优化为无分支）*/
int abs_cmov(int x) {
    return x < 0 ? -x : x;  /* 编译器通常生成 cmov（条件移动）指令 */
}
```

**无分支的 clamp（截断到范围）**：

```c
/* 有分支版本 */
int clamp_branch(int x, int lo, int hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;  /* 2 次分支 */
}

/* 无分支版本（利用 min/max，编译器生成 cmov 指令）*/
int clamp_branchless(int x, int lo, int hi) {
    return std::max(lo, std::min(x, hi));
    /* 完全无跳转指令，只有比较和条件移动 */
}
```

### 3.4 让不可预测的分支变为可预测

有些分支无法消除，但可以通过**数据重排**让分支结果更规律，提升预测率：

```c
/* 场景：对数组中满足条件的元素做处理 */

/* 版本 1：随机数组，分支结果不可预测（预测失误率约 50%）*/
int data[100000];
// 随机填充 data，约一半大于阈值
for (int i = 0; i < N; i++) {
    if (data[i] > THRESHOLD) {  /* 随机跳转：预测器几乎不可能预测 */
        sum += data[i];
    }
}

/* 版本 2：排序后遍历（分支结果完全可预测）*/
std::sort(data, data + N);  /* 一次排序的代价 */
for (int i = 0; i < N; i++) {
    if (data[i] > THRESHOLD) {  /* 先全 false，后全 true，预测器完美预测 */
        sum += data[i];
    }
}
/* 排序后，分支预测失误率从 ~50% 降到 <1%
   即使排序本身有 O(N log N) 开销，对于多次遍历的场景仍然值得 */
```

**实测数据（Agner Fog 的经典测试）**：N=100000 随机 int 数组求和条件过滤：
- 未排序：约 6.5ns/元素（大量分支预测失效）
- 已排序：约 1.5ns/元素（分支预测完美）
- 提升：**4.3 倍**

### 3.5 likely/unlikely 宏：给编译器提示

当无法消除分支，但知道某个分支的概率时，可以用 `__builtin_expect` 提示编译器将"常见路径"的代码放在顺序执行路径上（避免跳转指令的 pipeline bubble）：

```c
#define likely(x)   __builtin_expect(!!(x), 1)  /* x 大概率为 true */
#define unlikely(x) __builtin_expect(!!(x), 0)  /* x 大概率为 false */

/* 使用场景：错误处理路径（极少触发，用 unlikely 标记）*/
int fd = open(path, O_RDONLY);
if (unlikely(fd < 0)) {          /* 正常情况不会失败 */
    perror("open failed");
    return -1;
}

/* 使用场景：热路径上的条件检查 */
for (size_t i = 0; i < size; i++) {
    if (likely(data[i] != 0)) {  /* 大多数元素非零 */
        sum += data[i];
    } else {
        handle_zero(i);          /* 极少调用，放在 unlikely 路径 */
    }
}
```

**原理**：编译器会将 `unlikely` 路径的代码放到函数末尾或跳转目标，使顺序执行路径（不跳转）始终是"常见路径"，减少 pipeline 的预测压力，并提高指令缓存（i-cache）的局部性。

---

## 第 4 章 SIMD 向量化：一次指令处理多个数据

### 4.1 SIMD 是什么，为什么重要

**SIMD（Single Instruction, Multiple Data，单指令多数据）** 是 CPU 提供的一组特殊指令，允许一条指令同时对多个数据元素执行相同的操作：

```
标量（普通）计算：
  指令 ADD   a[0] += b[0]    ← 1 次操作，1 条指令
  指令 ADD   a[1] += b[1]
  指令 ADD   a[2] += b[2]
  指令 ADD   a[3] += b[3]
  共 4 条指令，4 个时钟周期

AVX2 SIMD 计算（256 位寄存器，8 × float）：
  指令 VADDPS ymm0, ymm1, ymm2  ← 1 条指令，8 次操作！
  共 1 条指令，1 个时钟周期

理论加速比：8 倍（实际 4-7 倍，取决于内存带宽和其他因素）
```

**现代 CPU 的 SIMD 能力**：

| 指令集 | 寄存器宽度 | float 并行度 | double 并行度 | 代表 CPU |
|--------|----------|------------|-------------|---------|
| SSE2 | 128 位 | 4 个 | 2 个 | Pentium 4+ |
| AVX2 | 256 位 | 8 个 | 4 个 | Haswell（2013）+ |
| AVX-512 | 512 位 | 16 个 | 8 个 | Skylake-SP+、Ice Lake |

### 4.2 编译器自动向量化

现代编译器（GCC/Clang）在 `-O2` 或 `-O3` 时会尝试**自动向量化**简单的循环。但自动向量化有严格前提——必须能证明循环中不存在**数据依赖**（后一次迭代不依赖前一次迭代的结果）、**指针别名**（两个指针不能指向同一内存）：

```c
/* 可以自动向量化（无依赖，无别名）*/
void add_arrays(float *a, float *b, float *c, int n) {
    for (int i = 0; i < n; i++)
        c[i] = a[i] + b[i];  /* 每次迭代完全独立 */
}
/* 编译器生成 VADDPS 指令，每次处理 8 个 float */

/* 不能自动向量化（有循环携带依赖）*/
void prefix_sum(float *a, int n) {
    for (int i = 1; i < n; i++)
        a[i] += a[i-1];  /* a[i] 依赖 a[i-1] ← 无法并行 */
}

/* 不能自动向量化（指针别名，编译器无法证明 a 和 b 不重叠）*/
void copy_shift(float *a, float *b, int n) {
    for (int i = 0; i < n; i++)
        a[i] = b[i+1];  /* 若 a == b，a[0] 的写操作影响 b[0] 的读 */
}

/* 修复：用 __restrict__ 告知编译器指针不重叠 */
void copy_shift_restricted(float * __restrict__ a,
                            float * __restrict__ b, int n) {
    for (int i = 0; i < n; i++)
        a[i] = b[i+1];  /* 现在编译器可以安全地向量化 */
}
```

**确认编译器是否进行了自动向量化**：

```bash
# GCC：-fopt-info-vec 打印向量化报告
g++ -O3 -fopt-info-vec my_program.cpp -o my_program 2>&1 | grep "vectorized"
# my_program.cpp:15:5: optimized: loop vectorized using 32-byte vectors  ← 成功向量化
# my_program.cpp:30:5: missed: couldn't vectorize loop                    ← 失败原因

# Clang：-Rpass=loop-vectorize
clang++ -O3 -Rpass=loop-vectorize my_program.cpp 2>&1 | grep "vectorized"

# 汇编层面验证（看是否有 ymm/zmm 寄存器的指令）
objdump -d my_program | grep -E "vmovups|vaddps|vmulps|vfmadd" | head -10
```

### 4.3 手动 SIMD 内联函数

当编译器无法自动向量化，或需要更精细的控制时，可以使用 SIMD **内联函数（Intrinsics）** 手动编写向量化代码：

```c
#include <immintrin.h>  /* AVX2 内联函数头文件 */

/* 手动 AVX2 向量化：计算两个 float 数组的点积 */
float dot_product_avx2(float *a, float *b, int n) {
    __m256 sum_vec = _mm256_setzero_ps();  /* 初始化 8 个 float 的和为 0 */

    int i;
    for (i = 0; i <= n - 8; i += 8) {
        __m256 va = _mm256_loadu_ps(a + i);    /* 加载 8 个 float（未对齐）*/
        __m256 vb = _mm256_loadu_ps(b + i);    /* 加载 8 个 float */
        sum_vec = _mm256_fmadd_ps(va, vb, sum_vec);
        /* FMA：Fused Multiply-Add，sum_vec += va * vb（1 条指令完成乘加！）*/
    }

    /* 将 8 个 float 的和归约为 1 个 */
    float result[8];
    _mm256_storeu_ps(result, sum_vec);
    float sum = 0;
    for (int j = 0; j < 8; j++) sum += result[j];

    /* 处理尾部不足 8 个的元素 */
    for (; i < n; i++) sum += a[i] * b[i];

    return sum;
}
```

**编译时指定目标架构**：

```bash
# 启用 AVX2 支持
g++ -O3 -mavx2 -mfma my_program.cpp -o my_program

# 在当前机器上启用所有可用指令集（最大化 SIMD 利用）
g++ -O3 -march=native my_program.cpp -o my_program
# 注意：-march=native 生成的二进制不可移植（只能在当前 CPU 上运行）
```

### 4.4 检测 SIMD 是否充分利用

```bash
# 统计 SIMD 指令利用率（通过 FP 操作计数器）
perf stat -e \
    fp_arith_inst_retired.128b_packed_single,\
    fp_arith_inst_retired.256b_packed_single,\
    fp_arith_inst_retired.scalar_single \
    -p <pid> sleep 10

# 理想状态（充分使用 AVX2）：
# 256b_packed_single 远大于 scalar_single

# 若 scalar_single 占主导：编译器未向量化，需要优化
# 若 128b_packed 为主而没有 256b：只用了 SSE，没有 AVX2
```

---

## 第 5 章 TLB Miss：地址翻译的开销

### 5.1 TLB 是什么

[[内存管理/01 虚拟内存：为什么每个进程都以为自己独占内存]] 中介绍了虚拟内存和页表，但有一个关键的性能细节需要在此深入：**TLB（Translation Lookaside Buffer，转换后备缓冲区）** 是 CPU 内部的一个小型哈希缓存，专门缓存虚拟地址到物理地址的映射（页表项）。

**为什么 TLB 对性能至关重要**：

每次内存访问，CPU 都需要将虚拟地址翻译为物理地址。如果没有 TLB，每次翻译需要 4 次内存访问（4 级页表 PGD→PUD→PMD→PTE），延迟会增加 4 倍。TLB 命中时，地址翻译只需 1 个周期；TLB miss 时，需要走页表（约 4 × 内存访问延迟 = 320ns）：

| TLB 状态 | 地址翻译延迟 |
|---------|------------|
| TLB 命中（L1 TLB）| ~1 cycle |
| TLB 命中（L2 TLB）| ~7 cycles |
| TLB Miss（Page Table Walk）| ~200-400 cycles（4 次内存访问）|

**TLB 的容量限制**：典型 CPU 的 L1 dTLB 只有 64 个条目，L2 TLB 约 1024-2048 个条目。以 4KB 页面大小为例，L2 TLB 覆盖 2048 × 4KB = 8MB 的地址空间。如果程序的**工作集**（Working Set，即频繁访问的内存范围）超过 8MB，TLB miss 将频繁发生。

### 5.2 诊断 TLB Miss

```bash
# 量化 TLB miss 程度
perf stat -e \
    dTLB-load-misses,dTLB-loads,\
    iTLB-load-misses,iTLB-loads \
    -p <pid> sleep 10

# 典型输出：
#   456,789,012  dTLB-load-misses      #   5.3% of all dTLB loads ← 较高
#  8,641,975,308  dTLB-loads
#       123,456  iTLB-load-misses      #   0.02% of all iTLB loads ← 正常

# dTLB miss 率 > 1% 时开始影响性能，> 5% 需要优化
# 解决方案：减少工作集（降低 TLB 覆盖范围），或使用大页（HugePage）
```

**大页（HugePage）是 TLB miss 的根本解法**：

2MB 大页比 4KB 普通页大 512 倍，同样 2048 个 TLB 条目可以覆盖 2048 × 2MB = 4GB 的地址空间——覆盖范围扩大 512 倍，TLB miss 率相应降低。详细内容见 [[04 内存性能调优——NUMA 拓扑、大页与内存带宽]]。

---

## 第 6 章 微架构诊断的综合工作流

### 6.1 从 IPC 开始的诊断树

**IPC（Instructions Per Cycle）** 是微架构健康度的综合指标：

```
IPC 诊断树：

IPC < 1 → CPU 流水线严重空转
    ├─ LLC miss 率 > 5% → 缓存友好性问题（数据布局优化、访问模式优化）
    ├─ branch-misses > 5% → 分支预测失效（数据排序、无分支算法）
    ├─ dTLB-miss 率 > 3% → TLB 压力（大页优化）
    └─ 都正常 → 可能是内存带宽饱和（见 perf stat -e mem-bandwidth）

IPC 1-2 → 有改进空间
    ├─ SIMD 未充分利用（scalar 指令为主）→ 编译器向量化标志、数据布局改进
    └─ 一般来说已经是中等水平，优先排查其他瓶颈

IPC > 3 → 接近 CPU 理论上限
    → 瓶颈不在 CPU 执行效率，考虑算法复杂度或 IO 等其他维度
```

### 6.2 使用 perf stat 的推荐命令组合

```bash
# 一次性采集所有关键微架构计数器
perf stat -e \
    cycles,instructions,\
    L1-dcache-load-misses,LLC-load-misses,\
    branch-misses,\
    dTLB-load-misses,\
    fp_arith_inst_retired.256b_packed_single,\
    fp_arith_inst_retired.scalar_single \
    -p <pid> -- sleep 30

# 计算并解读各比率：
# IPC = instructions / cycles
# L1 miss 率 = L1-dcache-load-misses / instructions
# LLC miss 率 = LLC-load-misses / LLC-loads（需单独添加 LLC-loads）
# 分支失误率 = branch-misses / branches
# SIMD 效率 = 256b_packed / (256b_packed + scalar)
```

---

## 小结

CPU 微架构优化的核心是**让 CPU 流水线不要等待**——不等待内存数据（缓存友好访问），不等待分支结果（减少不可预测分支），充分利用 SIMD 并行度（数据紧密排列 + 无循环依赖）：

**Cache Miss 优化三板斧**：
1. SoA 数据布局（只访问需要的字段）
2. 顺序访问取代随机访问（空间局部性）
3. Cache Line 对齐 + 避免 False Sharing（多线程场景）

**分支预测失效的三种解决思路**：
1. 消除分支（无分支算法：`cmov`、位运算）
2. 让分支可预测（数据排序、`likely`/`unlikely` 提示）
3. 间接分支替换为直接分支（虚函数去虚化、函数指针内联）

**SIMD 向量化的充分条件**：
1. 循环内无数据依赖（各迭代独立）
2. 指针无别名（`__restrict__`）
3. 内存对齐（至少 16 字节，最好 32 字节）
4. 编译器标志：`-O3 -mavx2 -march=native`

下一篇 [[03 CPU 调度延迟——实时性、亲和性与 cgroup CPU]] 将视角从单线程的执行效率转移到多线程/多进程的调度维度：P99 延迟毛刺有时不是因为代码慢，而是因为进程在等待 CPU 调度——OS 调度器的唤醒延迟、CPU 核心的竞争、cgroup CPU bandwidth throttling 都会引入毫秒级的调度延迟抖动，这是低延迟系统（交易系统、实时流处理）最难排查的性能问题之一。

---

> [!note] 思考题
> 1. L1 Cache 与主存的延迟差距是 100 倍。按行遍历和按列遍历 100MB 数组的性能差异可达 10 倍以上。Cache Line（64字节）预取机制是根因——`__builtin_prefetch` 的三个参数（地址、读写意图、时间局部性级别）分别如何影响预取行为？软件预取在什么场景下反而降低性能？
> 2. 分支预测失败的代价是 15-20 个时钟周期的流水线冲刷。随机数据上 `if (array[i] > 128)` 的预测准确率约 50%。无分支编程（branchless）使用 `CMOV` 或位运算消除分支——在什么场景下编译器会自动生成 `CMOV`？`-O2` 和 `-O3` 优化级别在分支消除方面的差异是什么？
> 3. AVX-512 一次处理 64 字节但在某些 Intel CPU 上导致核心降频。降频的原因是 AVX-512 单元的功耗极高——CPU 为了不超过 TDP 限制而降低频率。在混合了 AVX-512 和标量代码的应用中，频繁的升降频切换会导致什么额外开销？JVM 的 C2 编译器能自动向量化为 AVX-512 吗？
