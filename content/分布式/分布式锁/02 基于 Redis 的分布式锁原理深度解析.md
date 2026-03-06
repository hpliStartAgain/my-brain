---
title: "02 基于 Redis 的分布式锁原理深度解析"
date: 2026-03-03
tags: [分布式锁, Redis, SETNX, Lua脚本, 看门狗, Redisson]
aliases: []
---

# 02 基于 Redis 的分布式锁原理深度解析

**摘要：**

Redis 分布式锁是工业界最广泛使用的分布式锁实现，其演进历程本身就是一部分布式系统工程实践的教科书——从最朴素的 `SETNX + EXPIRE` 两步操作，到 `SET NX PX` 的单命令原子化，再到 Lua 脚本保证解锁原子性，最后到 Redisson 框架的看门狗续期和可重入支持，每一步演进都是为了修补上一步方案的安全漏洞。本文按照这条演进脉络，逐层深入分析每个阶段的设计动机、实现细节与残余缺陷，剖析 Redis 单线程模型在分布式锁中的作用，并完整解析 Redisson 的看门狗机制与可重入锁实现。

---

## 第 1 章 Redis 为什么适合做分布式锁

在深入研究 Redis 分布式锁的具体实现之前，有必要先思考一个基础问题：Redis 具备哪些特性，使得它成为分布式锁的主流选择？这不是一个显而易见的问题——很多存储系统（MySQL、MongoDB、Memcached）也可以用来实现分布式锁，Redis 的优势究竟在哪里？

### 1.1 Redis 的单线程命令处理模型

[[Redis]] 在 6.0 版本之前，命令的执行是严格单线程的：所有客户端发来的命令被放入一个队列，由单个主线程串行处理。6.0 版本之后，Redis 引入了多线程用于网络 I/O，但命令的**执行**仍然是单线程的。

这个"单线程执行"特性对于分布式锁来说非常重要，因为它提供了一个关键保证：**任意两条 Redis 命令的执行是串行的，不会相互交错**。这意味着，只要我们能将"检查锁是否存在 + 设置锁"封装成一条原子命令（或一个 Lua 脚本），就能保证这个组合操作的原子性。

对比 MySQL：MySQL 的并发处理依赖多线程 + 锁机制，虽然事务提供了原子性，但实现分布式锁需要依赖 `SELECT ... FOR UPDATE` 或唯一索引约束，这些操作涉及磁盘 I/O，性能远不及 Redis 的内存操作。

### 1.2 Redis 的高性能内存操作

Redis 的所有数据存储在内存中，读写操作的延迟在微秒级（通常 0.1~1ms）。对于分布式锁这种高频操作（加锁/解锁伴随着每次临界区操作），存储系统的延迟直接影响整体系统吞吐量。

如果用 MySQL 实现分布式锁，每次加锁/解锁涉及磁盘写入，延迟可能在 1~10ms，对于 QPS 高达万级的接口，锁操作本身就会成为明显的性能瓶颈。

### 1.3 原生的 TTL 支持

Redis 对每个 Key 原生支持过期时间（TTL），存储层面直接处理过期逻辑——过期后 Redis 内部会自动清除该 Key，不需要应用层实现定时清理任务。

这一特性天然契合分布式锁的"无死锁"要求：持锁客户端崩溃后，锁的 TTL 到期，Redis 自动释放，其他客户端可以重新竞争。相比之下，用 MySQL 实现无死锁需要在锁记录中存储 `expire_time` 字段，并在加锁时由应用代码检查是否超期，逻辑更复杂，也更容易出错。

### 1.4 Lua 脚本的原子执行

Redis 支持 Lua 脚本，且保证同一个 Lua 脚本在 Redis 侧的执行是原子的（不会被其他命令插入执行）。这为实现"组合操作原子化"提供了强大的工具——任何需要"先检查后执行"的逻辑都可以通过 Lua 脚本实现原子性，而不需要在应用层做额外的事务处理。

---

## 第 2 章 SETNX 方案的演进：从两步操作到单命令原子化

### 2.1 第一代方案：SETNX + EXPIRE（2010 年代初）

分布式锁最早的 Redis 实现，使用两条命令组合：

```redis
SETNX lock_key "client_value"   # 如果 key 不存在则设置，返回 1（成功）或 0（已存在）
EXPIRE lock_key 30              # 设置 30 秒过期
```

`SETNX`（SET if Not eXists）是 Redis 提供的原子性条件写入命令：只有当 `lock_key` **不存在**时，才执行写入并返回 1；如果已存在，直接返回 0。这个原子性保证了"检查 + 写入"在 Redis 层面不会被并发请求打断。

**SETNX 返回 1**：说明在这个瞬间，没有其他客户端持有锁，当前客户端成功获取锁。

**SETNX 返回 0**：说明锁已被其他客户端持有，当前客户端获取锁失败，需要等待或重试。

这个方案看似合理，但存在一个**致命缺陷**：`SETNX` 和 `EXPIRE` 是两条独立的命令，它们之间没有原子性保证。考虑以下故障场景：

```
时间线：
T1: 客户端 A 执行 SETNX lock_key "client_A"，返回 1（加锁成功）
T2: 客户端 A 所在服务器宕机，进程崩溃
T3: EXPIRE 命令永远不会被执行
T4: lock_key 永久存在，没有 TTL
T5: 其他所有客户端尝试 SETNX，永远返回 0
T6: [系统进入死锁状态]
```

一行服务崩溃在 `SETNX` 成功之后、`EXPIRE` 执行之前，就足以让整个分布式锁系统陷入永久死锁。在生产环境中，这种"代码执行到一半崩溃"的场景并不罕见：进程 OOM 被系统 Kill、服务发版重启、物理机断电……任何一种情况都可能触发这个 Bug。

**一个历史性的"聪明"补丁**：

在 `SET NX PX` 命令出现之前，有人提出了一个"巧妙"的修复方案——将过期时间戳作为 value 存储，在 SETNX 失败时读取 value，判断锁是否已经过期，如果过期则用 `GETSET` 命令强制替换：

```python
def acquire_lock_with_timeout(lock_key, acquire_timeout, lock_expire):
    value = time.time() + lock_expire  # 锁的过期时间戳
    
    if redis.setnx(lock_key, value):
        return value  # 加锁成功
    
    # 加锁失败，检查当前锁是否已超期
    current_value = redis.get(lock_key)
    if current_value and float(current_value) < time.time():
        # 锁已超期，用 GETSET 替换
        old_value = redis.getset(lock_key, value)
        if old_value == current_value:
            return value  # 替换成功，加锁成功
    
    return None  # 加锁失败
```

这个方案虽然解决了死锁问题，但引入了新的问题：
1. **时钟依赖**：不同机器的时钟可能不同步，时间戳比较不可靠
2. **竞争窗口**：两个客户端可能同时检测到锁超期，都执行 GETSET，最终第二个 GETSET 的客户端会覆盖第一个，导致第一个客户端误认为加锁成功（GETSET 返回的 old_value 已不是 current_value，但两个客户端可能都通过了检查）
3. **代码复杂**：理解和维护成本高，容易出 Bug

这个"聪明"方案的存在，恰好说明了为什么需要一个真正原子的加锁命令。

### 2.2 第二代方案：SET NX PX（Redis 2.6.12，2012 年）

Redis 2.6.12 版本引入了对 `SET` 命令的扩展参数，允许在一条命令中同时完成"条件设置 + 过期时间设置"：

```redis
SET lock_key "client_A:token_uuid" NX PX 30000
```

参数说明：
- `NX`：Only set the key if it does **N**ot e**X**ist（与 SETNX 语义相同）
- `PX 30000`：设置 30000 毫秒（30 秒）后过期（也可用 `EX 30` 设置秒级过期）

这是一条原子命令——Redis 在单次命令处理中同时完成了"检查 key 是否存在 + 写入 key + 设置 TTL"，不存在中间被打断的可能。从此，第一代方案中 SETNX 和 EXPIRE 之间的"原子性窗口"彻底消失。

**关于 value 的设计**：

注意，value 不能是一个固定字符串（如 `"locked"`），而应该是一个能唯一标识当前持锁客户端的值。原因在于解锁的正确性——解锁时需要确认"当前锁是否确实由自己持有"，如果 value 固定，就无法区分"是我加的锁"和"别人加的锁"。

value 的推荐生成方式：
```python
import uuid
# 方式 1：纯随机 UUID（适合大多数场景）
lock_value = str(uuid.uuid4())

# 方式 2：客户端 ID + 线程 ID + 时间戳（可追溯，适合调试）
lock_value = f"{socket.gethostname()}:{os.getpid()}:{threading.current_thread().ident}:{time.time()}"
```

用 UUID 作为 value，每次加锁生成一个全局唯一的令牌，解锁时只删除 value 与当前令牌匹配的 key——这样即使锁因 TTL 超期被自动删除，再被其他客户端重新获取后，老客户端尝试用旧令牌解锁也不会成功（value 不匹配，解锁失败），从而避免了"解错他人的锁"的问题。

### 2.3 加锁命令正确了，但解锁还有问题

`SET NX PX` 解决了加锁的原子性问题，但解锁操作仍然存在隐患。

最朴素的解锁方式是直接 `DEL lock_key`：

```python
redis.delete(lock_key)
```

但这是不安全的，原因在第 01 篇已经分析过：如果持锁客户端的 TTL 到期后锁被自动释放，另一个客户端重新获取了锁，此时第一个客户端执行 `DEL` 会删掉第二个客户端的锁，造成互斥性破坏。

正确的解锁逻辑是：**先验证 value 是否匹配（确认是自己的锁），再删除**：

```python
current_value = redis.get(lock_key)
if current_value == my_lock_value:
    redis.delete(lock_key)
```

但这里有一个新的原子性问题：`GET` 和 `DEL` 是两条命令，两条命令之间有窗口期：

```
时间线（并发场景）：
T1: 客户端 A 执行 GET lock_key，返回 "client_A:token_001"
T2: [客户端 A 的 TTL 刚好在此时到期，锁被 Redis 自动删除]
T3: 客户端 B 执行 SET NX PX，加锁成功，value = "client_B:token_002"
T4: 客户端 A 执行 DEL lock_key（因为 T1 时 GET 返回的是自己的 value，判断通过了）
T5: 客户端 A 删除了客户端 B 的锁！
```

这个窗口期虽然概率极低，但在生产系统中这种"极低概率"事件终究会发生，特别是在高并发场景下。解决这个问题，需要将"GET 校验 + DEL 删除"变成一个原子操作——这正是 Lua 脚本的用武之地。

---

## 第 3 章 Lua 脚本：原子化解锁的标准方案

### 3.1 Redis Lua 脚本的原子性保证

Redis 执行 Lua 脚本时，整个脚本被视为一个原子操作——脚本执行期间，Redis 不会处理其他客户端的命令。这和 Redis 单条命令的原子性一样，都来源于 Redis 的单线程命令处理模型：脚本开始执行后，会一直运行到结束，期间没有其他命令能"插队"。

这意味着：**在 Lua 脚本中执行多条 Redis 命令，等价于在单个原子操作中执行这些命令**。"GET 校验 + DEL 删除"放进 Lua 脚本，就实现了原子性的解锁。

### 3.2 标准解锁 Lua 脚本

这是 Redis 分布式锁解锁操作的工业标准实现：

```lua
-- 解锁 Lua 脚本（Redis 官方推荐方案）
-- KEYS[1]: 锁的 key
-- ARGV[1]: 当前客户端的唯一 token（加锁时使用的 value）

if redis.call("GET", KEYS[1]) == ARGV[1] then
    -- value 匹配，确认是自己持有的锁，执行删除
    return redis.call("DEL", KEYS[1])
else
    -- value 不匹配，说明锁已被其他客户端持有（或锁已过期被删除）
    -- 不做任何操作，返回 0 表示解锁失败
    return 0
end
```

在 Java 中通过 Jedis 执行：

```java
private static final String UNLOCK_SCRIPT =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
    "    return redis.call('DEL', KEYS[1]) " +
    "else " +
    "    return 0 " +
    "end";

public boolean releaseLock(String lockKey, String lockValue) {
    // evalsha 或 eval 执行 Lua 脚本
    // KEYS 列表：[lockKey]
    // ARGV 列表：[lockValue]
    Object result = jedis.eval(
        UNLOCK_SCRIPT,
        Collections.singletonList(lockKey),      // KEYS
        Collections.singletonList(lockValue)      // ARGV
    );
    return Long.valueOf(1L).equals(result);
}
```

### 3.3 Lua 脚本的注意事项

**（1）脚本超时问题**

Redis 对 Lua 脚本的执行有超时限制（默认 5 秒，`lua-time-limit` 配置项）。如果脚本执行超过这个时间，Redis 不会强制终止脚本（因为终止会破坏原子性），而是进入特殊的"脚本超时"模式：

- 此时 Redis 只接受 `SCRIPT KILL` 和 `SHUTDOWN NOSAVE` 命令
- `SCRIPT KILL` 会终止当前脚本，并向脚本发送错误；但如果脚本已经执行了写操作，`SCRIPT KILL` 无法终止（防止数据不一致），只能用 `SHUTDOWN NOSAVE` 终止 Redis 进程

对于分布式锁的解锁脚本，逻辑极简（只有一次 GET 和一次 DEL），正常情况下执行时间在微秒级，完全不会触发脚本超时。但这个机制值得了解，以便在排查 Redis "不响应"问题时有正确的方向。

**（2）KEYS 参数的传递规范**

Redis Lua 脚本中，访问的 key 应该通过 `KEYS[n]` 参数显式传入，而不是在脚本中硬编码字符串。这是因为 [[Redis Cluster]] 模式下，不同的 key 可能存储在不同的集群节点上，Redis Cluster 通过 key 来路由请求。如果脚本中涉及多个 key 且它们在不同节点上，脚本执行会失败。通过 `KEYS` 传入，Redis Cluster 可以提前分析 key 的分布，并（在同一节点的情况下）正确路由。

---

## 第 4 章 看门狗机制：解决 TTL 与业务执行时间的矛盾

### 4.1 TTL 设置困境

`SET NX PX + Lua 解锁`方案在正确性上已经相当可靠，但在实际工程中还面临一个难以回避的问题：**锁的 TTL 应该设置多长？**

这个问题的本质是：我们无法提前准确预知临界区业务逻辑的执行时间。

- 如果 TTL 设置为 5 秒，但数据库查询偶尔慢到 8 秒，锁就会提前过期
- 如果 TTL 设置为 30 秒，但客户端崩溃后其他等待者需要等 30 秒，系统可用性受损
- 如果业务涉及外部 API 调用，响应时间可能从 100ms 到 30 秒不等，TTL 根本无法覆盖所有情况

**一个常见的错误做法**：把 TTL 设置得足够大（比如 5 分钟），期望业务逻辑绝对在 5 分钟内完成。这虽然降低了锁提前过期的概率，但客户端崩溃后的恢复时间也变成了 5 分钟，严重影响可用性，而且在高并发场景下 5 分钟的锁持有时间会大幅降低系统吞吐量。

### 4.2 看门狗（Watchdog）：持续续期的守护线程

看门狗（Watchdog）机制的核心思想：**不是在加锁时预设一个"足够大"的 TTL，而是设置一个较短的初始 TTL（比如 30 秒），同时启动一个后台线程，定期检查业务是否还在执行，如果是则自动续期（延长 TTL）**。

```
看门狗工作原理：

[加锁成功] → 启动看门狗线程
    看门狗线程每隔 TTL/3（如 10 秒）检查一次：
    - 如果业务线程仍在临界区（持锁标记有效）：执行 PEXPIRE lock_key 30000（续期 30 秒）
    - 如果业务线程已离开临界区（已解锁）：看门狗线程结束
    - 如果业务线程崩溃（JVM 进程退出）：看门狗线程也随之消亡，TTL 自然到期，锁自动释放

[正常解锁] → 业务线程执行解锁 Lua 脚本，看门狗线程检测到锁不存在，停止续期
[异常崩溃] → 看门狗线程消亡，TTL 30 秒后到期，锁自动释放
```

这个设计优雅地解决了 TTL 与业务执行时间的矛盾：
- 初始 TTL 较短（30 秒），崩溃后恢复时间可控
- 正常执行时看门狗持续续期，无论业务多慢都不会锁提前过期
- 看门狗与业务进程同生共死，进程崩溃时看门狗自然停止，TTL 自然到期

> [!warning] 看门狗的边界条件：GC 停顿
> 看门狗线程虽然解决了大多数 TTL 问题，但无法完全规避第 01 篇提到的 GC 停顿场景：如果 JVM 发生长时间 Full GC（假设 60 秒），看门狗线程同样被暂停，无法续期，30 秒 TTL 到期后锁被释放，其他客户端获取锁，GC 结束后可能出现两个客户端同时在临界区的情况。
> 缓解措施：使用低延迟 GC（ZGC/Shenandoah）将 GC 停顿控制在 50ms 以内，远低于 TTL 初始值（30 秒），使得这个场景的概率极低。

### 4.3 Redisson 的看门狗实现

[[Redisson]] 是 Java 生态中最完善的 Redis 客户端框架，提供了生产级的分布式锁实现。Redisson 的看门狗机制是业界标准实现，值得深入分析。

**Redisson 加锁的核心 Lua 脚本**：

```lua
-- Redisson 加锁脚本（支持可重入）
-- KEYS[1]: 锁的 key
-- ARGV[1]: 锁超时时间（毫秒），默认 30000
-- ARGV[2]: 锁的唯一标识，格式：UUID:threadId（如 "a1b2c3d4:1"）

if (redis.call('exists', KEYS[1]) == 0) then
    -- 锁不存在，直接加锁
    redis.call('hincrby', KEYS[1], ARGV[2], 1);  -- Hash 结构，存储持锁线程 + 重入次数
    redis.call('pexpire', KEYS[1], ARGV[1]);       -- 设置 TTL
    return nil;  -- 返回 nil 表示加锁成功
end;

if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    -- 锁存在，且是当前线程持有的（可重入）
    redis.call('hincrby', KEYS[1], ARGV[2], 1);  -- 重入次数 +1
    redis.call('pexpire', KEYS[1], ARGV[1]);       -- 续期
    return nil;  -- 返回 nil 表示加锁成功（可重入）
end;

-- 锁存在，且不是当前线程持有，返回锁的剩余 TTL（单位毫秒）
return redis.call('pttl', KEYS[1]);
```

注意 Redisson 使用 Redis 的 **Hash（哈希）数据结构**来存储锁，而不是简单的 String。Hash 的 field 是"UUID:threadId"，value 是重入次数。这个设计同时支持了**唯一性标识**（UUID 标识客户端实例，threadId 标识线程）和**可重入计数**（重入次数）。

**看门狗的实现原理（源码层面分析）**：

Redisson 在加锁成功后，通过 `netty` 的时间轮（HashedWheelTimer）调度一个延迟任务来实现看门狗：

```java
// Redisson 源码的看门狗续期逻辑（简化）
private void renewExpiration() {
    // 调度在 lockWatchdogTimeout / 3 后执行续期任务
    // 默认 lockWatchdogTimeout = 30 秒，所以每 10 秒续期一次
    Timeout task = commandExecutor.getConnectionManager().newTimeout(
        new TimerTask() {
            @Override
            public void run(Timeout timeout) {
                // 执行续期 Lua 脚本：将 TTL 重置为 lockWatchdogTimeout
                // 续期成功后，再次调度下一次续期任务（形成递归调度）
                RFuture<Boolean> future = renewExpirationAsync(threadId);
                future.onComplete((res, e) -> {
                    if (e != null) {
                        // 续期失败（Redis 连接断开等），停止看门狗
                        return;
                    }
                    if (res) {
                        // 续期成功，递归调度下一次续期
                        renewExpiration();
                    }
                    // res = false 说明锁已不存在（正常解锁后），停止看门狗
                });
            }
        },
        lockWatchdogTimeout / 3,  // 延迟执行时间（10 秒）
        TimeUnit.MILLISECONDS
    );
    
    // 将任务句柄存储起来，解锁时可以取消
    expirationRenewalMap.put(getEntryName(), new ExpirationEntry(threadId, task));
}
```

续期使用的 Lua 脚本：

```lua
-- Redisson 续期脚本
-- KEYS[1]: 锁的 key
-- ARGV[1]: 新的 TTL（毫秒）
-- ARGV[2]: 持锁线程标识（UUID:threadId）

if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('pexpire', KEYS[1], ARGV[1]);  -- 重置 TTL
    return 1;
end;
return 0;  -- 锁已不存在（或不是当前线程的锁），续期失败
```

**看门狗的生命周期管理**：

- **加锁成功**时：调用 `renewExpiration()` 启动看门狗
- **解锁时**：从 `expirationRenewalMap` 中取出任务句柄，调用 `cancel()` 取消看门狗任务
- **指定了 leaseTime（自定义 TTL）时**：Redisson 不启动看门狗，TTL 固定为传入的值，到期后锁自动释放

---

## 第 5 章 可重入锁：同一线程多次加同一把锁

### 5.1 什么是可重入，为什么需要它

**可重入锁（Reentrant Lock）**是指：同一个线程/客户端可以多次加同一把锁而不发生死锁。加锁次数记录在锁的状态中，每次加锁计数 +1，每次解锁计数 -1，只有计数归零时锁才真正被释放。

Java 的 `ReentrantLock` 和 `synchronized` 都是可重入的——同一个线程进入 `synchronized(lock)` 方法后，可以再次调用同样锁定在 `lock` 上的方法，不会死锁。

**为什么分布式场景也需要可重入锁？**

考虑以下代码结构：

```java
@GlobalLocked(key = "order_lock")
public void processOrder(String orderId) {
    // 持有 order_lock 的情况下，调用了另一个也需要 order_lock 的方法
    validateOrder(orderId);
    ...
}

@GlobalLocked(key = "order_lock")
public void validateOrder(String orderId) {
    // 此方法也尝试获取 order_lock
    // 如果分布式锁不支持可重入，这里会死锁
    ...
}
```

如果分布式锁不支持可重入，`processOrder` 已经持有 `order_lock`，调用 `validateOrder` 时再次尝试加 `order_lock` 会永远等待（因为锁已被同一个请求持有），造成死锁。

### 5.2 Redisson 可重入锁的实现原理

如第 4.3 节的 Lua 脚本所示，Redisson 使用 Redis Hash 来存储锁信息：

```
Hash 结构：
Key: "order_lock"
Field: "a1b2c3d4-xxxx:1"  (UUID:threadId)
Value: 2  (重入次数)
TTL: 30000ms
```

**加锁逻辑**：
1. 检查 `order_lock` 是否存在：不存在则直接加锁，`hincrby field 1` 写入重入次数 = 1
2. 存在且 field 匹配当前线程：`hincrby field 1`，重入次数 +1（此次加锁成功，不会阻塞）
3. 存在但 field 不匹配：锁被其他线程持有，返回剩余 TTL，客户端等待

**解锁逻辑**（同样是 Lua 脚本保证原子性）：

```lua
-- Redisson 解锁脚本
-- KEYS[1]: 锁的 key
-- KEYS[2]: 解锁成功时发布通知的 channel（用于唤醒等待者）
-- ARGV[1]: 解锁通知消息
-- ARGV[2]: 锁的 TTL（毫秒）
-- ARGV[3]: 持锁线程标识（UUID:threadId）

if (redis.call('hexists', KEYS[1], ARGV[3]) == 0) then
    return nil;  -- 不是当前线程的锁，无权解锁
end;

-- 重入计数 -1
local counter = redis.call('hincrby', KEYS[1], ARGV[3], -1);

if (counter > 0) then
    -- 还有重入层级，不真正释放锁，仅续期
    redis.call('pexpire', KEYS[1], ARGV[2]);
    return 0;
else
    -- 重入计数归零，真正释放锁
    redis.call('del', KEYS[1]);
    -- 发布解锁通知，唤醒正在等待的客户端（通过 Redis Pub/Sub）
    redis.call('publish', KEYS[2], ARGV[1]);
    return 1;
end;

return nil;
```

### 5.3 等待加锁：Pub/Sub 替代轮询

在客户端加锁失败后，有两种等待策略：

**方式一：轮询（Spin Lock）**

```python
while True:
    result = redis.set(lock_key, value, nx=True, px=30000)
    if result:
        break  # 加锁成功
    time.sleep(0.1)  # 等待 100ms 后重试
```

这种方式简单，但存在两个问题：
1. **CPU 空转**：大量的轮询请求对 Redis 形成无效负载
2. **延迟不可控**：等待时间取决于轮询间隔，无法精确响应锁释放事件

**方式二：Pub/Sub 订阅（Redisson 使用此方式）**

Redisson 利用 Redis 的发布/订阅（Pub/Sub）机制来实现"锁释放时精确唤醒等待者"：

```
等待流程：
1. 客户端 B 尝试加锁，失败
2. 客户端 B 订阅 Channel "redisson_lock_channel:{lock_key}"
3. 客户端 B 阻塞等待（通过 Java Semaphore 阻塞当前线程，不占用 CPU）
4. 客户端 A 解锁时，解锁 Lua 脚本 PUBLISH "redisson_lock_channel:{lock_key}" "0"
5. 客户端 B 收到消息，唤醒，再次尝试加锁
6. 如果此时锁已被其他等待者抢走，客户端 B 重新订阅等待
```

这种方式相比轮询，减少了无效的 Redis 请求，且响应锁释放的延迟极低（Pub/Sub 的消息投递延迟通常在 1ms 以内）。

---

## 第 6 章 完整的 Redis 分布式锁实现

### 6.1 手写一个生产可用的 Redis 锁（无框架依赖）

对于不使用 Redisson 的场景（如 Python、Go 项目），需要手工实现一个可靠的 Redis 锁：

```python
import redis
import uuid
import time

class RedisDistributedLock:
    """
    生产可用的 Redis 分布式锁实现
    支持：原子加锁、Lua 原子解锁、超时控制
    不支持（需额外实现）：看门狗续期、可重入
    """
    
    # 解锁 Lua 脚本（原子性 GET + DEL）
    UNLOCK_SCRIPT = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        else
            return 0
        end
    """
    
    def __init__(self, redis_client: redis.Redis, lock_key: str, ttl_ms: int = 30000):
        self.redis = redis_client
        self.lock_key = lock_key
        self.ttl_ms = ttl_ms
        self.lock_value = None
    
    def acquire(self, timeout_ms: int = 5000) -> bool:
        """
        尝试在 timeout_ms 内获取锁
        返回 True 表示加锁成功，False 表示超时失败
        """
        self.lock_value = str(uuid.uuid4())  # 生成唯一 token
        deadline = time.time() + timeout_ms / 1000
        
        while time.time() < deadline:
            # SET NX PX 原子加锁
            result = self.redis.set(
                self.lock_key,
                self.lock_value,
                nx=True,           # 仅在 key 不存在时设置
                px=self.ttl_ms     # 毫秒级 TTL
            )
            if result:
                return True  # 加锁成功
            
            # 加锁失败，短暂等待后重试（简单轮询，生产可替换为 Pub/Sub）
            time.sleep(0.05)  # 50ms 轮询间隔
        
        return False  # 超时
    
    def release(self) -> bool:
        """
        释放锁（Lua 脚本保证原子性）
        """
        if self.lock_value is None:
            return False
        
        result = self.redis.eval(
            self.UNLOCK_SCRIPT,
            1,                 # key 的数量
            self.lock_key,     # KEYS[1]
            self.lock_value    # ARGV[1]
        )
        return result == 1
    
    def __enter__(self):
        if not self.acquire():
            raise TimeoutError(f"无法在超时时间内获取锁: {self.lock_key}")
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()
        return False  # 不吞掉异常


# 使用示例
r = redis.Redis(host='localhost', port=6379)

with RedisDistributedLock(r, "order_process_lock", ttl_ms=30000) as lock:
    # 临界区：安全地执行业务逻辑
    process_order(order_id)
```

### 6.2 使用 Redisson 的最佳实践（Java）

对于 Java 项目，推荐直接使用 Redisson，它处理了所有边界情况：

```java
@Service
public class OrderService {
    
    @Autowired
    private RedissonClient redissonClient;
    
    public void processOrder(String orderId) throws InterruptedException {
        // 获取锁对象（此时尚未加锁）
        RLock lock = redissonClient.getLock("order_process_lock:" + orderId);
        
        // 方式 1：不设置 leaseTime，启用看门狗自动续期
        lock.lock();
        try {
            doProcessOrder(orderId);
        } finally {
            lock.unlock();  // 必须在 finally 中解锁，防止异常导致锁泄漏
        }
        
        // 方式 2：设置 leaseTime，不启用看门狗（业务执行时间可预知的场景）
        lock.lock(10, TimeUnit.SECONDS);  // 最多持锁 10 秒
        try {
            doProcessOrder(orderId);
        } finally {
            lock.unlock();
        }
        
        // 方式 3：尝试加锁，带超时（推荐用于大多数业务场景）
        boolean acquired = lock.tryLock(
            5, TimeUnit.SECONDS,   // 等待获取锁的最长时间
            30, TimeUnit.SECONDS   // 锁的持有时间（leaseTime，不启用看门狗）
        );
        if (!acquired) {
            throw new BusinessException("系统繁忙，请稍后重试");
        }
        try {
            doProcessOrder(orderId);
        } finally {
            lock.unlock();
        }
    }
}
```

> [!warning] 最常见的 Redisson 使用错误
> 在 `tryLock` 时指定了 `leaseTime`，导致看门狗不启动，但业务逻辑执行时间超过了 `leaseTime`：
> ```java
> // 错误：leaseTime=5s，但业务可能需要 10s
> lock.tryLock(1, 5, TimeUnit.SECONDS);
> // 结果：5s 后锁自动过期，其他线程进入临界区，数据不一致
> ```
> 建议：如果业务执行时间不确定，使用 `lock.lock()` 不指定 `leaseTime`，让看门狗自动续期。

---

## 第 7 章 Redis 分布式锁的正确性边界

### 7.1 单节点 Redis 锁的失效场景梳理

经过上述所有优化，单节点 Redis 分布式锁在以下场景仍然可能失效：

| 场景 | 失效原因 | 发生概率 | 影响 |
| :--- | :--- | :--- | :--- |
| Redis 主从切换 | 锁数据在 Slave 提升时可能未同步 | 极低（主宕机才触发）| 短暂双写 |
| 长时间 GC 停顿 | 看门狗被暂停，TTL 可能到期 | 极低（ZGC 下几乎不发生）| 短暂双写 |
| 时钟漂移 | TTL 计算偏差 | 极低（NTP 正常工作时可忽略）| TTL 略微不准 |
| 客户端与 Redis 网络分区 | 加锁超时但 Redis 侧可能已成功 | 低 | 幻象失败（可用性损失，非安全问题）|

对于绝大多数互联网业务场景，这些失效概率可以接受，配合业务层的幂等性设计可以做到最终正确。

### 7.2 何时需要更强的保证：Redlock 或 ZooKeeper

如果业务对分布式锁的正确性有极高要求（金融结算、库存精确控制），且无法接受上述任何一种失效场景，则需要考虑：

- **Redlock 算法**：通过多数派加锁降低单节点故障的影响（但 Redlock 自身也有争议，详见第 03 篇）
- **ZooKeeper 分布式锁**：基于 ZAB 强一致性协议，主从切换不会丢失数据（详见第 04 篇）

---

## 参考资料

1. Redis SET 命令官方文档. https://redis.io/commands/set/
2. Redis Lua 脚本官方文档. https://redis.io/docs/manual/programmability/lua-api/
3. Redisson 官方文档：分布式锁实现原理. https://redisson.org/docs/data-and-services/locks-and-synchronizers/
4. Antirez. (2016). Distributed locks with Redis (Redlock). https://redis.io/docs/manual/patterns/distributed-locks/
5. Junqueira, F., & Reed, B. (2013). *ZooKeeper: Distributed Process Coordination*. O'Reilly Media.
6. Redisson GitHub 源码. https://github.com/redisson/redisson/blob/master/redisson/src/main/java/org/redisson/RedissonLock.java

---

> [!note] 思考题
> 1. Redis 分布式锁的基本形式 `SET key value NX EX 30` 有一个根本问题——如果业务执行时间超过 30 秒，锁自动过期后被其他客户端获取，原客户端仍在执行——违反了互斥性。Redisson 的 Watchdog（默认每 10 秒续期）如何解决？如果 Watchdog 线程因 STW GC 暂停超过 30 秒——锁仍会过期。你如何降低这个风险？
> 2. Redis 锁的'释放安全'——只有锁的持有者才能释放锁。`SET key <unique_value> NX EX 30` 中的 `unique_value` 用于标识持有者。释放时需要原子地'检查值并删除'——通过 Lua 脚本 `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]) end`。为什么不能用 `GET + DEL` 两条命令？
> 3. Redis 主从架构下的锁丢失风险——客户端在主节点获取锁后，主节点崩溃，从节点提升为主——但锁数据可能未复制到从节点。Redlock 通过在多个独立 Redis 实例上获取锁来缓解——但 Martin Kleppmann 的批评认为 Redlock 仍然不安全。你在生产中如何应对这个风险？
