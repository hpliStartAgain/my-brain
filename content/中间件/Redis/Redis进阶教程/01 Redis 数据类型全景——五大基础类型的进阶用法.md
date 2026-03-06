---
title: "01 Redis 数据类型全景——五大基础类型的进阶用法"
date: 2026-03-03
tags: [中间件, Redis, 数据类型, String, List, Hash, Set, ZSet, 进阶用法]
aliases: []
---

# 01 Redis 数据类型全景——五大基础类型的进阶用法

**摘要：**

大多数开发者对 Redis 五大数据类型的认知停留在"String 存值、Hash 存对象、List 存列表、Set 存集合、ZSet 存排行榜"的初级阶段。这种认知让 Redis 沦为一个"带过期时间的 HashMap"——远远没有发挥它的真实能力。实际上，String 可以用 INCR/DECR 实现分布式原子计数器、用 SETRANGE/GETRANGE 实现定长记录存储；List 可以用 BRPOP 实现阻塞消息队列、用 LPOS 实现精确元素定位；Hash 可以用 HSCAN 实现大字段渐进遍历、用 HINCRBY 实现多字段原子更新；Set 的交并差集运算可以在毫秒级完成好友推荐和标签筛选；ZSet 的 score 机制可以实现延迟队列、滑动窗口限流和时间线排序。本文逐一深入每种类型的进阶操作、底层编码选择对性能的影响，以及在生产中的典型应用模式。

---

## 第 1 章 String——远不止 Key-Value

### 1.1 String 的本质

Redis 的 String 并不是"字符串"——它是一个**二进制安全的字节序列**，最大长度 512MB。"二进制安全"意味着 String 可以存储任意二进制数据——JSON 文本、序列化对象、图片字节流、甚至一个 protobuf 编码的消息。

在底层，Redis 对 String 使用三种不同的编码方式，取决于存储的值：

| 编码 | 触发条件 | 内存布局 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **int** | 值是 64 位有符号整数 | 直接在 RedisObject 的 ptr 字段存储整数值 | 计数器、ID |
| **embstr** | 字符串长度 ≤ 44 字节 | RedisObject 和 [[02 SDS 与 Redis 对象系统\|SDS]] 在一块连续内存中分配 | 短字符串 |
| **raw** | 字符串长度 > 44 字节 | RedisObject 和 SDS 分别分配内存 | 长字符串 |

这种编码选择对性能有直接影响——int 编码的 INCR 操作是纯内存整数运算，不需要任何字符串解析；embstr 编码的短字符串只需一次内存分配（对 CPU 缓存友好）；raw 编码需要两次内存分配和一次指针跳转。

> [!info] 为什么 embstr 的阈值是 44 字节？
> [[02 SDS 与 Redis 对象系统|RedisObject]] 占 16 字节，SDS 的 sdshdr8 头占 3 字节，加上字符串末尾的 `\0` 占 1 字节，总计 20 字节的"开销"。[[06 内存管理与过期淘汰策略|jemalloc]] 分配器的最小分配单元是 64 字节——64 - 20 = 44 字节。当字符串内容 ≤ 44 字节时，整个 RedisObject + SDS 可以刚好放进一个 64 字节的 jemalloc 内存块中。

### 1.2 原子计数器

String 的 int 编码配合 `INCR`/`DECR`/`INCRBY`/`DECRBY` 命令，天然构成一个**分布式原子计数器**——无需加锁，Redis 的单线程模型保证了操作的原子性。

```bash
# 页面浏览量计数
INCR page:view:article:1001          # 每次访问 +1
GET page:view:article:1001            # 读取当前值

# 库存预扣减（原子操作，不会超卖）
DECRBY inventory:sku:2001 1          # 扣减 1
# 返回值 < 0 说明库存不足，需要回滚：INCRBY inventory:sku:2001 1

# 分布式 ID 生成
INCRBY id:generator:order 1          # 全局自增 ID
```

**为什么不用数据库的自增列做计数？** 数据库的自增操作需要行锁 → 写 redo log → 写 binlog，单次操作延迟在毫秒级。Redis 的 INCR 是纯内存操作，延迟在微秒级——在高并发场景（如秒杀库存扣减）下性能差距可达两个数量级。

**边界问题**：INCR 操作的值范围是 64 位有符号整数（-2^63 到 2^63-1）。如果值不是整数（如 `SET key "hello"` 后执行 `INCR key`），Redis 返回错误 `ERR value is not an integer or out of range`。

### 1.3 SETNX 与条件写入

`SET key value NX EX seconds` 是 Redis 最重要的原子操作之一——**仅当 key 不存在时才设置值，同时设置过期时间**。这是实现[[06 Redis 分布式锁——从 SETNX 到 Redlock 的争议|分布式锁]]的基础。

```bash
# 原子操作：设置值 + 仅当不存在 + 过期时间
SET lock:order:1001 "owner:uuid" NX EX 30

# 返回 OK：获取锁成功
# 返回 nil：锁已被其他客户端持有
```

**为什么必须用 `SET ... NX EX` 而不是 `SETNX` + `EXPIRE` 两条命令？** 因为两条命令不是原子的——如果 SETNX 成功后、EXPIRE 执行前客户端崩溃，这把锁就永远不会过期（死锁）。`SET ... NX EX` 在一条命令中完成两个操作，利用 Redis 单线程的原子性保证了不会出现中间状态。

### 1.4 MGET/MSET 批量操作

单条 GET/SET 命令的网络往返时间（RTT）通常在 0.1-1ms。如果需要读取 100 个 key，逐个 GET 需要 100 次 RTT——总延迟可能达到 100ms。`MGET`/`MSET` 将多个操作合并为一次网络请求：

```bash
# 批量设置
MSET user:1001:name "Alice" user:1001:age "30" user:1001:city "Beijing"

# 批量获取
MGET user:1001:name user:1001:age user:1001:city
# 1) "Alice"
# 2) "30"
# 3) "Beijing"
```

**注意**：MGET/MSET 在 [[10 Redis Cluster 分布式架构|Redis Cluster]] 中有限制——所有 key 必须位于同一个哈希槽（slot），否则返回 CROSSSLOT 错误。解决方案是使用 **Hash Tag**：`{user:1001}:name`、`{user:1001}:age`——花括号内的部分用于计算哈希槽，确保同一用户的 key 落在同一个槽。

### 1.5 GETSET 与 GETDEL

`GETSET key value`（6.2+ 推荐使用 `SET key value GET`）：**原子地设置新值并返回旧值**。

经典应用——原子地重置计数器并获取计数值：

```bash
# 每分钟统计一次 API 调用量
INCR api:calls:current           # 每次 API 调用 +1
# ...
SET api:calls:current 0 GET      # 原子重置为 0 并返回上一分钟的调用量
```

`GETDEL key`（6.2+）：获取值并删除 key——适合一次性凭证（如验证码）。

---

## 第 2 章 List——有序队列与阻塞操作

### 2.1 List 的底层编码

Redis 的 List 在底层使用 **QuickList**——一个由多个 [[04 跳跃表 压缩列表与 Listpack|ziplist/listpack]] 节点组成的双向链表。这种设计兼顾了链表的高效头尾操作和紧凑内存布局：

```
QuickList:
  [ziplist-node-1] <-> [ziplist-node-2] <-> [ziplist-node-3]
  每个 ziplist 节点内部是连续内存的数组
```

**list-max-ziplist-size** 参数控制每个 ziplist 节点的最大元素数（正数）或最大字节数（负数，默认 -2 即 8KB）。小的 ziplist 节点对 CPU 缓存友好、插入删除快，但节点数多导致链表遍历开销增加——需要根据场景权衡。

### 2.2 阻塞弹出——BRPOP/BLPOP

普通的 RPOP/LPOP 在 List 为空时返回 nil——客户端需要轮询（polling），浪费 CPU 和网络。`BRPOP`/`BLPOP` 是阻塞版本——如果 List 为空，客户端会**阻塞等待**直到有新元素或超时：

```bash
# 消费者阻塞等待，最多等 30 秒
BRPOP task:queue 30
# 如果队列有数据：返回 ["task:queue", "task-data-123"]
# 如果 30 秒内无数据：返回 nil

# 生产者推送任务
LPUSH task:queue "task-data-456"
# 此时阻塞的消费者立即收到数据
```

**BRPOP 实现了一个简单的消息队列**——生产者 LPUSH、消费者 BRPOP。相比轮询方案，BRPOP 零延迟（数据到达立即通知）且零空转（没有无效的网络请求）。

**局限**：BRPOP 的消息是"弹出即消费"——如果消费者在处理消息的过程中崩溃，消息就丢失了（没有 ACK 机制）。需要可靠消息语义的场景应使用 [[07 Redis 消息队列——从 PubSub 到 Stream|Redis Stream]] 或专业消息队列。

### 2.3 LPOS——精确元素定位

Redis 6.0.6 引入的 `LPOS` 命令可以在 List 中查找元素的位置（索引），支持查找第 N 次出现和指定搜索范围：

```bash
RPUSH mylist "a" "b" "c" "b" "d" "b"

LPOS mylist "b"                   # 返回 1（第一次出现的索引）
LPOS mylist "b" RANK 2            # 返回 3（第二次出现的索引）
LPOS mylist "b" COUNT 0           # 返回 [1, 3, 5]（所有出现的索引）
LPOS mylist "b" MAXLEN 3          # 只搜索前 3 个元素
```

### 2.4 LMPOP——多 List 弹出

Redis 7.0 引入的 `LMPOP` 可以从多个 List 中弹出元素——第一个非空的 List 被选中：

```bash
LMPOP 2 queue:high queue:low LEFT COUNT 1
# 优先从 queue:high 弹出；如果 queue:high 为空，则从 queue:low 弹出
```

这实现了**优先级队列**——高优先级队列优先消费。

### 2.5 List 的典型应用模式

| 模式 | 命令组合 | 说明 |
| :--- | :--- | :--- |
| **FIFO 队列** | LPUSH + RPOP / BRPOP | 先进先出——任务队列 |
| **LIFO 栈** | LPUSH + LPOP | 后进先出——撤销操作栈 |
| **有界队列** | LPUSH + LTRIM | 保留最近 N 条记录（如最近 100 条日志）|
| **优先级队列** | LMPOP 多 List | 多级队列优先消费 |
| **消息可靠传递** | RPOPLPUSH / LMOVE | 弹出并原子推入备份 List——处理完成后删除备份 |

`RPOPLPUSH source destination`（6.2+ 推荐 `LMOVE`）是 Redis 实现"可靠消息传递"的经典技巧——从 source 弹出元素并原子地推入 destination（备份列表）。消费者处理完成后从 destination 删除；如果消费者崩溃，备份列表中的元素可以被重新处理。

---

## 第 3 章 Hash——结构化数据的高效存储

### 3.1 Hash vs 多个 String Key

存储一个用户对象，有两种方案：

**方案 A**：多个 String key

```bash
SET user:1001:name "Alice"
SET user:1001:age "30"
SET user:1001:city "Beijing"
```

**方案 B**：一个 Hash

```bash
HSET user:1001 name "Alice" age 30 city "Beijing"
```

两种方案的对比：

| 维度 | 多个 String | 一个 Hash |
| :--- | :--- | :--- |
| **内存占用** | 每个 key 都有 RedisObject + dictEntry 开销（约 70 字节/key） | 字段数少时使用 ziplist/listpack 编码，极度紧凑 |
| **部分读取** | 需要 MGET 多个 key | HGET/HMGET 读取指定字段 |
| **部分更新** | SET 单个 key | HSET 单个字段 |
| **原子性** | MSET 是原子的 | HSET 多字段是原子的 |
| **过期控制** | 每个 key 可独立设置 TTL | Hash 整体设置 TTL（7.4+ 支持字段级 TTL） |
| **Cluster 分片** | 分散在不同 slot（需 Hash Tag 聚合）| 一个 Hash 在同一个 slot |

**结论**：字段数不多（< 100）且需要部分读写的结构化数据，优先使用 Hash——内存节省显著（ziplist 编码下可节省 50%-80%），操作更方便。

### 3.2 Hash 的编码升级

Hash 在字段数和字段值较小时使用 **ziplist/listpack** 编码——所有字段和值紧凑地存储在一块连续内存中，遍历查找是 O(N) 但因为数据量小且内存连续，实际性能极好。

当 Hash 超过阈值时，编码自动升级为 **hashtable**——标准哈希表，O(1) 查找但内存开销更大。

| 参数 | 默认值 | 含义 |
| :--- | :--- | :--- |
| **hash-max-ziplist-entries** | 128 | 字段数超过此值时升级为 hashtable |
| **hash-max-ziplist-value** | 64 | 任一字段值长度超过此字节数时升级为 hashtable |

> [!warning] 编码升级不可逆
> 一旦 Hash 从 ziplist 升级为 hashtable，即使后续删除字段使得字段数低于阈值，编码也**不会降级回 ziplist**。因此在设计阶段就应评估 Hash 的字段数——如果经常超过阈值，不如直接按 hashtable 的开销来规划内存。

### 3.3 HSCAN——渐进式字段遍历

`HGETALL` 会一次性返回 Hash 的所有字段和值——如果 Hash 有数万个字段，这条命令会阻塞 Redis 数百毫秒（单线程模型下意味着所有其他客户端也被阻塞）。

`HSCAN` 是渐进式的遍历——每次返回一部分字段，通过游标（cursor）分多次完成遍历：

```bash
HSCAN user:1001 0 COUNT 10
# 返回：["cursor值", ["field1", "value1", "field2", "value2", ...]]

# 用返回的 cursor 继续遍历
HSCAN user:1001 <cursor> COUNT 10
# cursor 为 0 时遍历结束
```

**生产规则**：对于可能包含大量字段的 Hash，永远不要用 `HGETALL`，改用 `HSCAN`——这与全局的 `KEYS *` vs `SCAN` 是同一个道理。

### 3.4 HINCRBY/HINCRBYFLOAT——字段级原子计数

```bash
# 用户积分系统：多维度积分在一个 Hash 中
HSET user:1001:points login 0 purchase 0 share 0

HINCRBY user:1001:points login 10      # 登录 +10 积分
HINCRBY user:1001:points purchase 50   # 购买 +50 积分
HGET user:1001:points login            # 读取登录积分
```

每个 HINCRBY 都是原子的——多个客户端并发更新不同字段不会产生竞争。这比多个 String key 的方案更紧凑（一个 Hash 而非三个 key），且所有积分字段天然聚合在一起。

---

## 第 4 章 Set——集合运算的威力

### 4.1 Set 的底层编码

| 编码 | 触发条件 | 特点 |
| :--- | :--- | :--- |
| **intset** | 所有元素都是整数且元素数 ≤ 512 | 有序整数数组，内存极度紧凑，二分查找 O(log N) |
| **hashtable** | 有非整数元素或元素数 > 512 | 标准哈希表，O(1) 查找 |

`set-max-intset-entries`（默认 512）控制 intset 的最大元素数。如果你的 Set 存储的是用户 ID（整数），且元素数不超过 512，intset 编码的内存效率远优于 hashtable。

### 4.2 交并差集运算

Set 最强大的能力是集合运算——`SINTER`（交集）、`SUNION`（并集）、`SDIFF`（差集）：

**好友推荐——共同好友**：

```bash
# 用户 A 的好友集合
SADD friends:A "B" "C" "D" "E"
# 用户 F 的好友集合
SADD friends:F "C" "D" "G" "H"

# A 和 F 的共同好友
SINTER friends:A friends:F
# {"C", "D"}

# 推荐给 A 的好友（F 的好友中 A 还不认识的人）
SDIFF friends:F friends:A
# {"G", "H"}
```

**标签筛选——多标签求交集**：

```bash
# 给文章打标签
SADD tag:python "article:1" "article:3" "article:5"
SADD tag:redis "article:2" "article:3" "article:7"
SADD tag:backend "article:1" "article:3" "article:7"

# 同时包含 python 和 backend 标签的文章
SINTER tag:python tag:backend
# {"article:1", "article:3"}
```

**性能考量**：SINTER/SUNION/SDIFF 的时间复杂度是 O(N*M)，其中 N 是最小集合的元素数，M 是集合数量。对于大集合（百万级元素），这些操作可能很慢。可以使用 `SINTERSTORE`/`SUNIONSTORE`/`SDIFFSTORE` 将结果存入新 Set（避免大量数据传输到客户端），或在从节点上执行以避免阻塞主节点。

### 4.3 SRANDMEMBER 与 SPOP

`SRANDMEMBER key count`：随机返回 count 个元素（不删除）。
`SPOP key count`：随机弹出 count 个元素（删除）。

```bash
# 抽奖——随机抽取 3 名中奖者（弹出，不可重复中奖）
SPOP lottery:pool 3

# 随机推荐——随机展示 5 个商品（不删除，可重复推荐）
SRANDMEMBER product:pool 5

# count 为负数时允许重复
SRANDMEMBER product:pool -5    # 可能返回重复元素
```

### 4.4 SMEMBERS 的替代——SSCAN

与 HGETALL 类似，`SMEMBERS` 会一次性返回 Set 的所有元素——大集合下会阻塞 Redis。生产环境应使用 `SSCAN` 渐进遍历。

---

## 第 5 章 ZSet——有序集合的高级应用

### 5.1 ZSet 的底层结构

ZSet（Sorted Set）是 Redis 最精妙的数据类型——每个元素关联一个 **score**（double 类型的浮点数），元素按 score 从小到大排序。

底层编码：

| 编码 | 触发条件 | 数据结构 |
| :--- | :--- | :--- |
| **ziplist/listpack** | 元素数 ≤ 128 且所有元素值长度 ≤ 64 字节 | 紧凑连续内存 |
| **skiplist + dict** | 超过阈值 | [[04 跳跃表 压缩列表与 Listpack\|跳跃表]]（按 score 排序）+ 字典（按 member 查找 score）|

skiplist + dict 的双索引设计使得 ZSet 同时支持：
- **按 score 范围查询**（ZRANGEBYSCORE）：O(log N + M)，走跳跃表
- **按 member 查找 score**（ZSCORE）：O(1)，走字典
- **按排名查询**（ZRANGE/ZREVRANGE）：O(log N + M)，走跳跃表

### 5.2 排行榜

这是 ZSet 最经典的应用——score 存储分数、member 存储用户 ID：

```bash
# 更新用户分数
ZADD leaderboard 1500 "user:A"
ZADD leaderboard 2300 "user:B"
ZADD leaderboard 1800 "user:C"
ZINCRBY leaderboard 200 "user:A"    # 用户 A 加 200 分

# Top 10 排行榜（从高到低）
ZREVRANGE leaderboard 0 9 WITHSCORES

# 查询用户排名（从高到低，0-based）
ZREVRANK leaderboard "user:A"       # 返回排名

# 查询分数在 1000-2000 之间的用户
ZRANGEBYSCORE leaderboard 1000 2000 WITHSCORES
```

**实时排行榜的工程价值**：如果用数据库实现排行榜，需要 `SELECT * FROM scores ORDER BY score DESC LIMIT 10`——全表排序的 I/O 和 CPU 开销极大。ZSet 的跳跃表天然有序，ZREVRANGE 只需 O(log N + 10) 即可返回 Top 10——在百万级数据量下延迟仍在亚毫秒级。

### 5.3 延迟队列

利用 score 存储**消息的执行时间戳**，member 存储消息内容——消费者定期用 `ZRANGEBYSCORE` 取出所有到期的消息：

```bash
# 生产者：30 秒后执行的任务
ZADD delay:queue <当前时间戳+30> "task:cancel-order:1001"

# 消费者：取出所有到期任务
ZRANGEBYSCORE delay:queue 0 <当前时间戳> LIMIT 0 10

# 取出后删除（需要 Lua 脚本保证原子性）
# EVAL "local tasks = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, 10)
#        for i, task in ipairs(tasks) do
#            redis.call('ZREM', KEYS[1], task)
#        end
#        return tasks" 1 delay:queue <当前时间戳>
```

**与定时任务的对比**：传统定时任务（如 Quartz/XXL-Job）需要独立的调度服务和数据库存储。Redis 延迟队列实现极其轻量——一个 ZSet 加几行 Lua 脚本。适合轻量级场景（订单超时取消、延迟通知），但不适合需要高可靠性和复杂调度策略的场景。

### 5.4 滑动窗口限流

利用 ZSet 的 score 存储请求时间戳，member 存储请求唯一标识——通过 `ZREMRANGEBYSCORE` 移除窗口外的旧请求，用 `ZCARD` 计算窗口内的请求数：

```bash
# 限流：每个用户 60 秒内最多 100 次请求
# key: rate:limit:user:1001
# score: 请求时间戳（毫秒）
# member: 请求唯一 ID（如 UUID，防止 score 相同被覆盖）

# Lua 脚本实现原子限流
EVAL "
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])      -- 窗口大小（毫秒）
  local limit = tonumber(ARGV[3])       -- 最大请求数
  local member = ARGV[4]                -- 唯一请求 ID

  -- 移除窗口外的旧请求
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  -- 计算当前窗口内的请求数
  local count = redis.call('ZCARD', key)
  if count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    return 1   -- 允许
  else
    return 0   -- 拒绝
  end
" 1 rate:limit:user:1001 <当前时间戳ms> 60000 100 <UUID>
```

**滑动窗口 vs 固定窗口**：固定窗口（如"每分钟 100 次"）在窗口切换的瞬间可能出现突刺（第 59 秒 100 次 + 第 60 秒 100 次 = 2 秒内 200 次）。滑动窗口始终只看最近 60 秒——更平滑、更精确。代价是每个请求都需要写入一个 ZSet 元素——高并发下内存增长较快，需要设置合理的过期时间。

### 5.5 ZRANGESTORE 与多条件排序

Redis 6.2 引入的 `ZRANGESTORE` 可以将 ZRANGE 的结果直接存入另一个 ZSet——无需客户端中转：

```bash
# 将排行榜 Top 100 存入缓存 ZSet
ZRANGESTORE leaderboard:top100 leaderboard 0 99 REV
```

**多条件排序技巧**：ZSet 的 score 是一个 double（53 位有效精度）。如果需要按"分数 + 时间"双维度排序（分数相同时按时间排序），可以将两个维度编码到一个 score 中：

```
score = 分数 * 10000000000 + (MAX_TIMESTAMP - 时间戳)
```

高位存储分数（主排序），低位存储时间的倒序（副排序——时间越早排名越前）。

### 5.6 集合运算——ZUNIONSTORE/ZINTERSTORE

ZSet 也支持交集和并集运算，并且可以指定**聚合函数**（SUM/MIN/MAX）：

```bash
# 综合排行榜 = 周榜 × 0.3 + 月榜 × 0.7
ZUNIONSTORE leaderboard:combined 2 leaderboard:weekly leaderboard:monthly WEIGHTS 0.3 0.7 AGGREGATE SUM
```

---

## 第 6 章 通用进阶操作

### 6.1 SCAN 家族——安全遍历

| 命令 | 作用域 | 适用场景 |
| :--- | :--- | :--- |
| **SCAN** | 全局 key 空间 | 遍历所有 key |
| **HSCAN** | 单个 Hash | 遍历 Hash 的所有字段 |
| **SSCAN** | 单个 Set | 遍历 Set 的所有元素 |
| **ZSCAN** | 单个 ZSet | 遍历 ZSet 的所有元素 |

所有 SCAN 命令都支持 `MATCH pattern`（通配符过滤）和 `COUNT hint`（每次返回的近似数量）。SCAN 的关键特性是**增量式遍历**——不会像 `KEYS *` 或 `SMEMBERS` 那样一次性阻塞 Redis。

> [!warning] SCAN 的一致性语义
> SCAN 不保证遍历过程中的一致性——如果遍历期间有 key 被新增或删除，可能出现：(1) 新增的 key 可能被遍历到也可能不被遍历到；(2) 已遍历到的 key 如果被删除，不影响已返回的结果；(3) 极端情况下同一个 key 可能被返回两次。调用方需要做好去重和幂等处理。

### 6.2 OBJECT 命令——检查编码

```bash
OBJECT ENCODING mykey         # 查看底层编码（int/embstr/raw/ziplist/hashtable/skiplist...）
OBJECT REFCOUNT mykey         # 引用计数
OBJECT IDLETIME mykey         # 空闲时间（秒，受 maxmemory-policy 影响）
OBJECT FREQ mykey             # LFU 访问频率（需 maxmemory-policy 为 lfu）
OBJECT HELP                   # 查看所有子命令
```

**生产价值**：通过 `OBJECT ENCODING` 可以验证 Hash/Set/ZSet 是否使用了预期的紧凑编码。如果发现某个 Hash 的编码是 hashtable 而非 ziplist，可能是某个字段值超过了 `hash-max-ziplist-value` 的阈值——需要检查数据设计。

### 6.3 MEMORY USAGE——精确内存分析

```bash
MEMORY USAGE mykey            # 返回 key 占用的精确字节数（包括所有内部开销）
MEMORY USAGE mykey SAMPLES 5  # 对复合类型（Hash/List/Set/ZSet）采样 5 个元素估算
```

`MEMORY USAGE` 是诊断[[05 热 Key 大 Key 治理与容量规划|大 Key]]问题的核心工具——它返回的是 key 在内存中的**真实占用**，包括 RedisObject 头、SDS 头、字典/跳跃表的节点开销等。

### 6.4 TYPE 与 DUMP/RESTORE

```bash
TYPE mykey                    # 返回 key 的数据类型（string/list/set/zset/hash/stream）
DUMP mykey                    # 序列化 key 的值为 RDB 格式的字节串
RESTORE newkey 0 <dump-data>  # 反序列化——可跨 Redis 实例迁移数据
```

---

## 第 7 章 数据类型选型速查

| 场景 | 推荐类型 | 关键命令 |
| :--- | :--- | :--- |
| **缓存 JSON 对象** | String (序列化) 或 Hash (结构化) | GET/SET 或 HGETALL/HSET |
| **分布式计数器** | String (int 编码) | INCR/INCRBY |
| **分布式锁** | String | SET NX EX |
| **消息队列（简单）** | List | LPUSH/BRPOP |
| **消息队列（可靠）** | Stream | XADD/XREADGROUP |
| **排行榜** | ZSet | ZADD/ZREVRANGE |
| **延迟队列** | ZSet | ZADD/ZRANGEBYSCORE |
| **滑动窗口限流** | ZSet | ZADD/ZREMRANGEBYSCORE/ZCARD |
| **好友关系/标签** | Set | SADD/SINTER/SDIFF |
| **抽奖/随机推荐** | Set | SPOP/SRANDMEMBER |
| **用户信息/配置** | Hash | HSET/HGET/HINCRBY |
| **时间线/Feed 流** | ZSet (score=时间戳) | ZADD/ZREVRANGEBYSCORE |
| **UV 统计** | HyperLogLog | PFADD/PFCOUNT |
| **签到/在线状态** | Bitmap（String） | SETBIT/GETBIT/BITCOUNT |
| **附近的人** | Geo（ZSet） | GEOADD/GEORADIUS |

---

## 第 8 章 总结

本文系统梳理了 Redis 五大基础类型的进阶用法和工程实践：

- **String**：不只是 key-value——原子计数器（INCR）、条件写入（SET NX EX）、批量操作（MGET/MSET），以及 int/embstr/raw 三种编码对性能的影响
- **List**：不只是数组——阻塞队列（BRPOP）、可靠传递（LMOVE）、优先级队列（LMPOP），QuickList 的 ziplist 链表设计
- **Hash**：不只是 Map——比多个 String key 节省 50%-80% 内存（ziplist 编码）、字段级原子计数（HINCRBY）、渐进遍历（HSCAN），编码升级不可逆
- **Set**：不只是去重——毫秒级集合运算（SINTER/SDIFF）实现好友推荐和标签筛选、随机抽奖（SPOP），intset 编码的紧凑整数存储
- **ZSet**：Redis 最强大的数据类型——排行榜、延迟队列、滑动窗口限流、时间线排序，skiplist + dict 双索引的查询性能保证

下一篇 [[02 高级数据类型——HyperLogLog Bitmap Geo Stream]] 将介绍 Redis 的四种高级数据类型——它们在特定场景下提供了五大基础类型无法替代的能力。

---

## 参考资料

1. Redis Documentation - Data Types：https://redis.io/docs/data-types/
2. Redis Documentation - Commands：https://redis.io/commands/
3. Antirez - Redis Data Types and Abstractions：https://redis.io/docs/data-types/tutorial/
4. Redis Source Code - t_string.c / t_list.c / t_hash.c / t_set.c / t_zset.c：https://github.com/redis/redis/tree/unstable/src

---

> [!note] 思考题
> 1. 缓存穿透防护——布隆过滤器 vs 缓存空值。布隆过滤器在 Key 空间极大（如 UUID）时内存占用可控，但有误判。缓存空值在恶意随机 Key 攻击下会缓存大量无效数据。在'Key 空间有限且已知'和'Key 空间无限且随机'两种场景下，你分别如何选择？能否组合使用两种方案？
> 2. 缓存击穿的互斥锁方案——`SET lock NX EX 5` 获取锁后回源数据库。获取锁失败的请求应该'自旋等待'还是'返回旧缓存'？在 QPS 极高（10 万/秒）的热点 Key 场景中，自旋等待可能导致大量线程阻塞。'永不过期 + 异步更新'方案是否更适合这种场景？
> 3. '先更新数据库再删缓存'（Cache Aside Pattern）在并发下仍可能不一致——删缓存后、另一个读请求重新写入旧缓存之前的时间窗口。延迟双删的'延迟时间'取决于读请求的执行时间——通常设为'主从复制延迟 + 业务读取时间'。如果你无法准确估计这个时间——基于 Canal 监听 Binlog 异步删缓存是否是更可靠的方案？
