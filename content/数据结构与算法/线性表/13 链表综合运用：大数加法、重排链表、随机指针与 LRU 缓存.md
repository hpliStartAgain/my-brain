---
title: "链表综合运用：大数加法、重排链表、随机指针与 LRU 缓存"
date: 2026-10-11
tags: [LeetCode, 2, 143, 138, 146, 大数加法, LRU缓存, 链表, 算法, 面试]
aliases: [LRU缓存, 随机指针链表, 重排链表, 大数加法链表]
---

# 链表综合运用：大数加法、重排链表、随机指针与 LRU 缓存

**摘要：**

本篇是线性表专栏的收官之作，四道题把前面学过的所有链表技巧做了一次综合检阅。LeetCode 2（两数相加）是进位模拟，复用第 09 篇 Plus One 的加法骨架；LeetCode 143（重排链表）把"快慢指针找中点 + 反转后半段 + 交叉合并"三步串成一条流水线，是第 11、12 篇技巧的合体；LeetCode 138（复制带随机指针的链表）考察深拷贝中的指针重建，其 $O(1)$ 空间的"交织法"极为精巧；LeetCode 146（LRU 缓存）则是大厂面试的常客，要求用 `哈希表 + 双向链表` 把 `get` 与 `put` 都做到 $O(1)$，是工程实现能力的试金石。本文用 Go 语言完整实现，并在末尾把整个专栏的数组与链表技巧体系梳理成两张速查表，作为备考收束。

---

## 第 1 章 LeetCode 2：两数相加

### 1.1 题目

**LeetCode 2 - Add Two Numbers**（中等）

给你两个非空链表，分别表示两个非负整数，每位数字按**逆序**存储，每个节点只存一位。请将两数相加，并以相同形式返回一个表示和的链表。

```text
输入: l1 = [2,4,3], l2 = [5,6,4]        →  输出: [7,0,8]（342 + 465 = 807）
输入: l1 = [9,9,9,9,9,9,9], l2 = [9,9,9,9]  →  输出: [8,9,9,9,0,0,0,1]
```

### 1.2 进位模拟

**关键**：链表已按逆序存储（个位在头），于是从头开始遍历，恰好就是从低位到高位，与手工加法完全一致。

需要处理两类情况：两个链表长度不同；最高位相加后仍有进位（结果需要多一个节点）。

```go
func addTwoNumbers(l1, l2 *ListNode) *ListNode {
    dummy := &ListNode{}
    curr := dummy
    carry := 0 // 进位

    for l1 != nil || l2 != nil || carry != 0 {
        a, b := 0, 0
        if l1 != nil {
            a = l1.Val
            l1 = l1.Next
        }
        if l2 != nil {
            b = l2.Val
            l2 = l2.Next
        }
        sum := a + b + carry
        carry = sum / 10
        curr.Next = &ListNode{Val: sum % 10}
        curr = curr.Next
    }
    return dummy.Next
}
```

**循环条件 `l1 != nil || l2 != nil || carry != 0` 是本题的灵魂**：前两项处理"两链表长度不同"，最后一项 `carry != 0` 处理"最高位仍有进位"。三个条件任意一个成立就继续，缺一不可——**尤其是 `carry != 0`，若漏掉它，像 `999 + 1 = 1000` 这样的情形就会丢掉最高位的 1。** 这与第 09 篇 Plus One 里"循环是否跑完"的判断是同一类边界，只是这里用显式的条件把它表达了出来。

**手动验证** `[9,9,9,9,9,9,9] + [9,9,9,9]`：

```text
位1: 9+9+0=18, carry=1, 节点 8
位2: 9+9+1=19, carry=1, 节点 9
位3: 9+9+1=19, carry=1, 节点 9
位4: 9+9+1=19, carry=1, 节点 9
位5: 9+0+1=10, carry=1, 节点 0
位6: 9+0+1=10, carry=1, 节点 0
位7: 9+0+1=10, carry=1, 节点 0
carry=1: 节点 1

结果: 8→9→9→9→0→0→0→1 ✓
```

**复杂度**：时间 $O(\max(m, n))$，空间 $O(\max(m, n))$（结果链表）。

> [!info] 同一骨架，两种场景
> 对比第 09 篇的 Plus One 与本题：两者的核心骨架完全一致——**从低位到高位逐位相加、用 `carry` 记录进位、循环条件把"最高位可能进位"纳入**。区别只在数据载体：一个用数组，一个用链表。**这说明"模拟手工加法"是一套与数据结构无关的通用范式**，一旦掌握，无论载体怎么变，都能照此推演。

---

## 第 2 章 LeetCode 143：重排链表

### 2.1 题目

**LeetCode 143 - Reorder List**（中等）

给定单链表 $L_0 \to L_1 \to \ldots \to L_{n-1} \to L_n$，将其重排为 $L_0 \to L_n \to L_1 \to L_{n-1} \to L_2 \to L_{n-2} \to \ldots$。不能只改节点内部的值，必须进行实际的节点交换。

```text
输入: head = [1,2,3,4]    →  输出: [1,4,2,3]
输入: head = [1,2,3,4,5]  →  输出: [1,5,2,4,3]
```

### 2.2 三步法：把难题拆成三个子问题

**核心观察**：重排后的链表，恰好是"原链表前半段"与"原链表后半段（倒序）"的交叉合并。于是问题可以拆成三步，每一步都是前面学过的现成技巧：

1. **找中点**：用快慢指针找到中点（第 11 篇）；
2. **反转后半段**：把中点之后的节点反转（第 12 篇）；
3. **交叉合并**：把前半段与反转后的后半段交叉编织（第 10 篇的合并思路）。

**这道题是整条链表技巧链的"合体技"**——它本身没有新技巧，难就难在要把三个子问题正确地串起来，并在衔接处处理好边界。

```go
func reorderList(head *ListNode) {
    if head == nil || head.Next == nil {
        return
    }
    // 第一步：快慢指针找中点（slow 停在前半段的最后一个节点）
    slow, fast := head, head
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    // 第二步：反转后半段
    secondHalf := slow.Next
    slow.Next = nil // 断开前后两段
    secondHalf = reverseList(secondHalf)

    // 第三步：交叉合并
    first, second := head, secondHalf
    for second != nil {
        firstNext := first.Next
        secondNext := second.Next

        first.Next = second
        second.Next = firstNext

        first = firstNext
        second = secondNext
    }
}

func reverseList(head *ListNode) *ListNode {
    var prev *ListNode
    for curr := head; curr != nil; {
        next := curr.Next
        curr.Next = prev
        prev, curr = curr, next
    }
    return prev
}
```

**手动验证** `[1,2,3,4,5]`：

```text
第一步：找中点
  slow=1, fast=1 → slow=2, fast=3 → slow=3, fast=5（fast.Next.Next==nil，停）
  slow=3，前半段 1→2→3

第二步：反转后半段
  secondHalf = 4→5；slow.Next=nil（断开）；反转得 5→4

第三步：交叉合并
  first=1, second=5
  iter1: 1.Next=5, 5.Next=2 → first=2, second=4
  iter2: 2.Next=4, 4.Next=3 → first=3, second=nil（停）

结果: 1→5→2→4→3 ✓
```

**复杂度**：时间 $O(n)$，空间 $O(1)$。

### 2.3 两个容易出错的地方

**其一，找中点时循环条件的选择。** 代码用的是 `fast.Next != nil && fast.Next.Next != nil`，它让 `slow` 停在**前半段的最后一个节点**（奇数长度时正好是中点，偶数长度时是左中点）。如果换成第 11 篇 `middleNode` 的写法（`fast != nil && fast.Next != nil`），`slow` 会落在靠右的中点，导致前后两段长度不匹配，交叉合并时会出错。**"中点"在偶数长度下并不唯一，用之前必须先想清楚这一题要的是哪一个。**

**其二，交叉合并的终止条件。** 合并循环用 `second != nil` 作为条件，是因为后半段（反转后）**不会比前半段长**——奇数长度时后半段更短，偶数长度时两者相等。以较短的一段为循环边界，就不会出现"后半段走完了、前半段还多出一个节点却无处可接"的越界问题。**用"较短的一段"作为循环上界，是交叉合并类题目的通用技巧。**

---

## 第 3 章 LeetCode 138：复制带随机指针的链表

### 3.1 题目

**LeetCode 138 - Copy List with Random Pointer**（中等）

给定一个链表，每个节点除了 `Next` 还额外含一个随机指针 `Random`，它可以指向链表中任意节点或空。请构造这个链表的**深拷贝**——新节点的 `Val`、`Next`、`Random` 都应与原链表对应节点一致，但 `Next` 与 `Random` 不能指向原链表的节点，而应指向新链表的节点。

```go
type Node struct {
    Val    int
    Next   *Node
    Random *Node
}
```

### 3.2 方法一：哈希表映射（直观，$O(n)$ 空间）

**思路**：用哈希表建立"原节点 → 新节点"的映射，两遍扫描。第一遍创建所有新节点并建立映射，第二遍根据映射设置 `Next` 与 `Random`。

```go
func copyRandomList(head *Node) *Node {
    if head == nil {
        return nil
    }
    m := make(map[*Node]*Node)
    // 第一遍：创建所有新节点，建立"原 → 新"映射
    for curr := head; curr != nil; curr = curr.Next {
        m[curr] = &Node{Val: curr.Val}
    }
    // 第二遍：设置 Next 与 Random
    for curr := head; curr != nil; curr = curr.Next {
        m[curr].Next = m[curr.Next]     // curr.Next 为 nil 时，m[nil] 取零值 nil，天然正确
        m[curr].Random = m[curr.Random] // 同理
    }
    return m[head]
}
```

**一个巧妙之处**：`m[curr.Next]` 在 `curr.Next == nil` 时，从 `map` 取一个不存在的键会返回零值 `nil`——这恰好就是我们想要的"新节点的 `Next` 也是 `nil`"。**利用 map 的零值语义，省去了对 nil 的特判**（Go 的 map 对不存在的键返回零值，不像某些语言会抛异常）。时间 $O(n)$，空间 $O(n)$。

### 3.3 方法二：节点交织（$O(1)$ 空间）

**思路**：不用哈希表，而是把新节点"穿插"到原节点后面，利用**相对位置关系**来定位 `Random` 的目标，最后再把两条链表分离。

三步走：

1. **交织**：在每个原节点后面插入它的拷贝，形成 `A → A' → B → B' → ...`；
2. **设置 `Random`**：此时 `A.Next` 就是 `A'`，而 `A.Random.Next` 就是 `A.Random` 的拷贝——于是 `A'.Random = A.Random.Next`；
3. **分离**：把交织在一起的两条链表拆开，还原原链表、提取新链表。

```go
func copyRandomListO1(head *Node) *Node {
    if head == nil {
        return nil
    }
    // 第一步：交织插入拷贝节点
    for curr := head; curr != nil; {
        next := curr.Next
        curr.Next = &Node{Val: curr.Val, Next: next}
        curr = next
    }
    // 第二步：设置拷贝节点的 Random
    for curr := head; curr != nil; curr = curr.Next.Next {
        if curr.Random != nil {
            curr.Next.Random = curr.Random.Next // A'.Random = A.Random.Next
        }
    }
    // 第三步：分离两条链表
    newHead := head.Next
    for curr := head; curr != nil; {
        copy := curr.Next
        curr.Next = copy.Next // 还原原链表的 Next
        if copy.Next != nil {
            copy.Next = copy.Next.Next // 新链表接上下一个拷贝节点
        }
        curr = curr.Next
    }
    return newHead
}
```

**关键推导**：交织之后，原节点 `A` 与其拷贝 `A'` 相邻（`A.Next = A'`）。设 `A.Random = B`，则 `A'.Random` 应当指向 `B` 的拷贝 `B'`。而 `B' = B.Next`（因为 `B.Next = B'`），所以 **`A'.Random = A.Random.Next`**——只需一次 `Next` 跳转，就借道原链表找到了拷贝节点。**这正是"利用相对位置关系"的妙处：把哈希表要存的"原→新映射"，变成了两个节点在物理上的"相邻关系"。**

**复杂度**：时间 $O(n)$，空间 $O(1)$（不计输出）。

> [!note] 交织法的取舍
> 交织法把空间从 $O(n)$ 压到 $O(1)$，代价是代码更绕、且**它会临时修改原链表的结构**（插入拷贝节点），若原链表不允许被改动，这个方法就不适用。面试中，哈希表法更易写、更安全，交织法则适合作为"能否 $O(1)$ 空间"的加分展示。**权衡的依据永远是具体约束——原链表能不能被临时改动，决定了交织法是否可用。**

---

## 第 4 章 LeetCode 146：LRU 缓存

### 4.1 题目

**LeetCode 146 - LRU Cache**（中等）

实现 `LRUCache` 类：以正整数 `capacity` 初始化；`get(key)` 若存在则返回其值、否则返回 -1；`put(key, value)` 若键已存在则更新值，否则插入；若插入导致数量超过 `capacity`，则**逐出最久未使用的键**。要求 `get` 与 `put` 均为 $O(1)$ 平均时间复杂度。

### 4.2 数据结构设计

这道题是"为什么需要某种数据结构"的最佳教学案例，值得一步步推导：

**$O(1)$ 的 `get`**：需要"按 key 直接定位节点"，这是哈希表的强项——`key → Node` 的映射。

**$O(1)$ 的 `put` 与 LRU 淘汰**：还需要维护"访问顺序"，并且能在 $O(1)$ 时间内**删除任意一个节点**。数组做不到（中间删除是 $O(n)$），单链表也做不到——因为删除一个节点必须先拿到它的前驱，而单链表找前驱是 $O(n)$。

**于是答案指向双向链表**：它的节点带着 `Prev` 指针，删除任意已知节点只需改动两个引用，是 $O(1)$。把双向链表按访问顺序排列，**头部放最近使用的、尾部放最久未使用的**，每次访问就把节点移到头部，容量满时删除尾部即可。

```text
哈希表:    key → DLinkedNode
双向链表:  dummyHead ↔ [最近] ↔ ... ↔ [最久] ↔ dummyTail
```

**哑节点在这里又出现了**：`dummyHead` 与 `dummyTail` 两个哨兵，让"在头部插入""在尾部删除"都不必特判"链表为空"的情况——这是第 10 篇哑节点思想的又一次应用。

### 4.3 Go 实现

```go
type dNode struct {
    key, val   int
    prev, next *dNode
}

type LRUCache struct {
    cache    map[int]*dNode
    capacity int
    head     *dNode // 哑头
    tail     *dNode // 哑尾
}

func Constructor(capacity int) LRUCache {
    head, tail := &dNode{}, &dNode{}
    head.next = tail
    tail.prev = head
    return LRUCache{
        cache:    make(map[int]*dNode),
        capacity: capacity,
        head:     head,
        tail:     tail,
    }
}

func (c *LRUCache) Get(key int) int {
    node, ok := c.cache[key]
    if !ok {
        return -1
    }
    c.moveToHead(node) // 访问过，移到头部（标记为最近使用）
    return node.val
}

func (c *LRUCache) Put(key, value int) {
    if node, ok := c.cache[key]; ok {
        node.val = value
        c.moveToHead(node)
        return
    }
    node := &dNode{key: key, val: value}
    c.cache[key] = node
    c.addToHead(node)
    if len(c.cache) > c.capacity {
        removed := c.removeTail() // 逐出最久未使用
        delete(c.cache, removed.key)
    }
}

func (c *LRUCache) addToHead(node *dNode) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

func (c *LRUCache) removeNode(node *dNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (c *LRUCache) moveToHead(node *dNode) {
    c.removeNode(node)
    c.addToHead(node)
}

func (c *LRUCache) removeTail() *dNode {
    node := c.tail.prev // 哑尾之前的那一个，即最久未使用的
    c.removeNode(node)
    return node
}
```

### 4.4 操作演示

以 `capacity = 2` 为例：

```text
Put(1,1): cache={1:1},        链表: H↔[1,1]↔T
Put(2,2): cache={1:1,2:2},    链表: H↔[2,2]↔[1,1]↔T
Get(1):   命中，移到头部，返回 1
          链表: H↔[1,1]↔[2,2]↔T
Put(3,3): 容量满，逐出尾部 [2,2]，插入 [3,3]
          cache={1:1,3:3},    链表: H↔[3,3]↔[1,1]↔T
Get(2):   未命中，返回 -1
Put(4,4): 容量满，逐出尾部 [1,1]，插入 [4,4]
          cache={3:3,4:4},    链表: H↔[4,4]↔[3,3]↔T
Get(1):   返回 -1
Get(3):   命中，移到头部，返回 3 → 链表: H↔[3,3]↔[4,4]↔T
Get(4):   命中，移到头部，返回 4 → 链表: H↔[4,4]↔[3,3]↔T
```

### 4.5 一个容易遗漏的细节：节点为什么必须存 key

淘汰节点时，代码需要执行 `delete(c.cache, removed.key)`——**从哈希表中删掉被逐出节点的键**。如果节点里只存了 `val`，那么淘汰时你手里只有这个节点，却不知道它在哈希表里的 key 是什么，也就无从删除。**因此节点必须同时保存 `key` 与 `val`。** 这是实现中最容易遗漏、又最致命的一处细节：漏了它，哈希表会残留悬空条目，缓存大小计算随之失真。

> [!info] LRU 的工程身影
> LRU 缓存在工程中无处不在：Redis 的内存淘汰策略之一便是 LRU；CPU 的各级缓存采用类似策略；浏览器的页面缓存、数据库的 Buffer Pool 也都带着 LRU 的影子。**理解 LRU 的实现，本质上是在理解"如何在常数时间内同时维护一张映射表和一份访问顺序"**——这是一个远超面试范畴、在真实系统中反复出现的工程命题。

---

## 第 5 章 全专栏总结

### 5.1 数组题的解题框架

数组题的难点，通常在于**时间与空间的优化**。把前面各篇的技巧体系汇总成一张表：

| 技巧 | 解决的问题 | 代表题 |
|------|-----------|--------|
| 双指针（同向） | 原地修改、去重 | LeetCode 26、80、27 |
| 双指针（对向） | 有序数组查找、两数之和 | LeetCode 15、16、18 |
| 二分搜索 | 有序数组查找、旋转数组、中位数 | LeetCode 33、81、4 |
| 哈希表辅助 | $O(1)$ 查找、连续序列 | LeetCode 1、128 |
| 贪心 | 局部最优 → 全局最优 | LeetCode 42、134、135 |
| 位运算 | 不用额外空间的计数与判重 | LeetCode 136、137 |
| 动态规划 | 最优子结构问题 | LeetCode 70 |
| 数学构造 | 排列、字典序、格雷码 | LeetCode 31、60、89 |

### 5.2 链表题的解题框架

链表题的难点，通常在于**指针操作的正确性与边界处理**。同样汇总成一张表：

| 技巧 | 解决的问题 | 代表题 |
|------|-----------|--------|
| 哑节点 | 统一处理头节点删除 | LeetCode 82、19、86 |
| 快慢指针 | 环检测、找中点、倒数节点 | LeetCode 141、142、19 |
| 反转链表 | 各类翻转变体 | LeetCode 92、25、24 |
| 多链表合并 | 分拆后合并 | LeetCode 86、143 |
| 哈希表辅助 | 节点映射、随机指针深拷贝 | LeetCode 138 |
| 哈希表 + 双向链表 | $O(1)$ 的有序缓存 | LeetCode 146 |

### 5.3 两条贯穿全专栏的主线

回看整个专栏，数组与链表看似是两套平行的技巧，实则共享两条更深的主线。

**主线一，一切优化都是在"约束"下做出的权衡。** 数组题反复追问"能否 $O(1)$ 空间"，于是逼出了双指针、位运算、就地借用；链表题反复追问"能否一遍扫描、能否 $O(1)$ 空间"，于是逼出了快慢指针、交织法。**约束不是障碍，而是解题方向的指南针**——这一点从第 01 篇讲到收官篇，始终未变。

**主线二，所有解法最终都落在"不变量"上。** 双指针的不变量是"已处理区域是什么"，二分的不变量是"答案在哪个区间"，快慢指针的不变量是"两指针的相对位置意味着什么"，LRU 的不变量是"链表头部最近、尾部最久"。**把不变量想清楚，边界条件便不再是靠直觉猜，而是靠逻辑推。** 这是本专栏最想留给读者的一件事。

### 5.4 面试备考建议

经过 13 篇的系统学习，线性表的面试考点已经覆盖全面。最后阶段，几点建议：

1. **刷题顺序**：按本专栏顺序，每篇配 LeetCode 实做，理解之后再做变体；
2. **重点模板**：双指针、二分、反转链表这三个最高频，务必练到不假思索；
3. **边界意识**：每做完一题，主动检查空链表、单节点、头尾边界；
4. **复杂度习惯**：给出答案前先分析时空复杂度，这是稳定的加分项；
5. **代码干净**：变量命名清晰（`prev/curr/next`、`left/right`、`slow/fast`），减少面试官的阅读负担。

> [!note] 算法题的本质
> 算法面试考察的从来不只是"能否得到正确答案"，更是你的**思维过程**：能否清晰分析问题、能否识别合适的数据结构与模式、能否主动发现并处理边界、能否在提示下快速调整方向。**把这些习惯训练出来，远比记住一百道题的解法更有价值**——因为题目会变，而思维方式可以迁移。

---

## 第 6 章 延伸：链表综合题的更多面孔

收官之前，再补三道把前面技巧"熔于一炉"的题。它们分别在"合并""排序""缓存"三个方向上，把本专栏的工具又推进了一步。

### 6.1 合并 K 个升序链表（LeetCode 23）：分治合并

**题目**：给你一个链表数组，每个链表都已升序排列，将它们合并为一个升序链表。

第 10 篇的 LeetCode 21 解决的是"合并两条链表"，这道题把它推广到 $K$ 条。最直接的做法是"依次合并"——把第 1、2 条合并成一条，再与第 3 条合并……但这样做，越早合并进去的链表会被重复遍历越多次，总代价是 $O(K^2 n)$。

更优的做法是**分治合并**：像归并排序一样，把 $K$ 条链表两两配对合并，反复进行直到只剩一条。每一轮链表数量减半，共 $\log K$ 轮，每轮总遍历量 $O(Kn)$，于是总时间降到 $O(Kn \log K)$。

```go
func mergeKLists(lists []*ListNode) *ListNode {
    if len(lists) == 0 {
        return nil
    }
    // 分治：两两合并，直到只剩一条
    for len(lists) > 1 {
        var merged []*ListNode
        for i := 0; i < len(lists); i += 2 {
            if i+1 < len(lists) {
                merged = append(merged, mergeTwo(lists[i], lists[i+1]))
            } else {
                merged = append(merged, lists[i]) // 落单的直接留下
            }
        }
        lists = merged
    }
    return lists[0]
}

// mergeTwo 即第 10 篇的 LeetCode 21 解法
func mergeTwo(a, b *ListNode) *ListNode {
    dummy := &ListNode{}
    curr := dummy
    for a != nil && b != nil {
        if a.Val <= b.Val {
            curr.Next, a = a, a.Next
        } else {
            curr.Next, b = b, b.Next
        }
        curr = curr.Next
    }
    if a != nil {
        curr.Next = a
    } else {
        curr.Next = b
    }
    return dummy.Next
}
```

**"依次合并"与"分治合并"的差别，是树形结构带来的效率差**：依次合并会让链表形成一条"长链"（第 1 条被合并多次），而分治合并让所有链表对称地参与（每条都只被合并 $\log K$ 次）。**"把线性操作变成树形操作"，是很多优化题的共同套路**——它把重复劳动压成了对数级。

### 6.2 排序链表（LeetCode 148）：归并排序的链表版

**题目**：给你链表的头节点，请将其按升序排列并返回，要求时间 $O(n \log n)$。

第 10 篇第 7 章曾提过：**链表排序几乎都选归并排序**，因为它的合并操作不需要额外空间。而链表版的归并排序，恰好把前面学过的三样工具全用上了：**快慢指针找中点、递归分治、合并两条有序链。**

```go
func sortList(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return head
    }
    // 第一步：快慢指针找中点并断开
    slow, fast := head, head.Next
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    mid := slow.Next
    slow.Next = nil // 断成两段
    // 第二步：递归排序两段
    left := sortList(head)
    right := sortList(mid)
    // 第三步：合并两条有序链
    return mergeTwo(left, right)
}
```

**这道题是"分治 + 合并"在链表上的完整体现**：找中点（第 11 篇）、递归分治（第 12 篇的递归视角）、合并（第 10 篇）。它同时也解释了为什么链表排序偏爱归并——**数组归并需要 $O(n)$ 的临时数组，而链表归并只需改指针，天然 $O(1)$ 额外空间。** 这是"数据结构决定了最优算法"的一个漂亮例证。

### 6.3 LFU 缓存（LeetCode 460）：从 LRU 到 LFU

**题目**：设计并实现最不经常使用（LFU）缓存，`get` 与 `put` 都要求 $O(1)$。当缓存满时，淘汰**使用频率最低**的键；若频率相同，则淘汰**最久未使用**的那个。

这道题是 LRU 的升级版，也是数据结构设计的经典难题。相比 LRU（只需一条双向链表维护顺序），LFU 需要额外维护"频率"这一维度。一个优雅的设计是：**用"频率到双向链表"的映射，把相同频率的节点串在同一条链表里**——`freqMap[freq]` 指向频率为 `freq` 的所有节点组成的链表，再额外维护一个 `minFreq` 记录当前最小频率。

```text
freqMap[1] ↔ [节点A] ↔ [节点B]   （频率为 1 的节点）
freqMap[2] ↔ [节点C]             （频率为 2 的节点）
minFreq = 1                      （淘汰时从 freqMap[minFreq] 的尾部取）
```

**LFU 的设计思想，是"把一维的顺序结构，扩展成二维的（频率 × 顺序）结构"。** LRU 只需要回答"谁最久没用"，一维就够；LFU 要同时回答"谁用得最少"和"同样少的情况下谁最久没用"，于是需要两个维度。**这正是"需求增加一个维度，数据结构就要相应扩展"的典型**——复杂度不会凭空消失，它只会随着需求一起增长，并被转移进更复杂的数据结构里。

> [!note] LRU 与 LFU 的取舍
> LRU 实现简单、对"近期热点"敏感，但容易被"一次性扫描"冲垮（扫描过的数据把真正的热点挤出去）；LFU 对"长期热点"更友好，但需要维护频率、实现复杂，且对新数据不友好（新键频率低，容易被立刻淘汰）。**两者没有绝对优劣，选型取决于访问模式**——Redis 就同时提供多种淘汰策略供选择。**"缓存策略"这道题，最终又落回了那句老话：没有银弹，因地制宜。**

---

## 第 7 章 常见误区与自测方法

### 7.1 四个高频误区

**误区一：LeetCode 2 忘记 `carry != 0` 这一循环条件。** 漏掉它，最高位的进位就会丢失。

**误区二：重排链表找中点时用了"靠右"的中点。** 会导致前后两段长度不匹配，合并出错（详见第 2 章）。

**误区三：LeetCode 138 交织法忘了处理 `Random` 为 `nil` 的情况。** `curr.Random != nil` 的判断不能省，否则会访问 `nil.Next`。

**误区四：LRU 的节点不存 `key`。** 淘汰时无法从哈希表中删除对应条目，缓存大小会失真（详见第 4.5 节）。

### 7.2 一套自测用例

| 用例 | 检验什么 |
|------|---------|
| `l1=[0], l2=[0]`、`l1=[9], l2=[1]` | 大数加法的进位边界 |
| 长度 1、2、3 的重排 | 重排链表的奇偶中点 |
| `Random` 全为 `nil` 的链表 | 深拷贝的 `nil` 分支 |
| `capacity=1` 的 LRU | 缓存的退化边界 |

**LRU 的 `capacity = 1` 尤其值得一测**：它把"插入 → 立即淘汰"这一最短循环走了一遍，几乎所有关于"哑节点、链表空判断、哈希表同步"的 bug 都会在这一用例下现形。

---

## 第 8 章 设计题的方法论：从 LRU 说起

LeetCode 146 是本专栏唯一的"设计题"。它值得单独总结一套方法论——因为**设计题与算法题的解题路径并不相同**。

### 8.1 设计题的四步推导

算法题的思路是"从约束出发推导解法"，设计题则通常按下面四步走：

1. **拆解需求，列出每个操作的目标复杂度**。LRU 要求 `get`、`put` 都是 $O(1)$，这就是全部约束。
2. **为每个操作匹配数据结构**。`get` 要"按 key 定位" → 哈希表；`put` 要"按访问顺序淘汰" → 需要维护顺序的结构。
3. **验证结构能否支撑所有操作**。哈希表能定位，但"淘汰最久未用"需要顺序；单链表能维护顺序，但删任意节点是 $O(n)$——于是**双向链表**成为唯一同时满足两者的选择。
4. **处理边界**：容量为 0？key 已存在？淘汰时如何同步哈希表？

**第 3 步是设计题的核心——它要求你把"每个操作的需求"与"每种结构的能力"做一次交叉匹配**，而不是一上来就写代码。**LRU 之所以经典，正是因为它逼你把"哈希表擅长什么、链表擅长什么"想得明明白白。**

### 8.2 三类常见追问

**追问一："为什么不用数组维护顺序？"** 答：数组删除中间元素是 $O(n)$，无法满足 $O(1)$ 淘汰。

**追问二："为什么不用单链表？"** 答：单链表删除任意节点需先找前驱（$O(n)$），双向链表靠 `prev` 直接拿到，$O(1)$。

**追问三："哈希表和链表的更新如何保持一致？"** 答：淘汰时先从链表摘除节点、再从哈希表 `delete`；插入时反向操作。**两者必须成对更新，任何一处遗漏都会导致状态不一致——这正是"节点必须存 key"这一细节存在的理由。**

### 8.3 设计题的通用心法

把 LRU 的推导抽象出来，可以得到一条设计题的通用心法：**先列出每个操作需要什么能力，再为这些能力寻找（或组合）能同时满足的数据结构。** 单一结构往往不够（哈希表缺顺序、链表缺定位），**设计题的答案通常是一个"组合体"**——哈希表 + 双向链表、堆 + 哈希表、Trie + 哈希表，皆是如此。

**这与本专栏开头讲的"数组 vs 链表是两种契约的权衡"首尾呼应**：算法题在**选择**一种结构，设计题在**组合**多种结构；但两者的底层，都是对"每种结构擅长什么、代价是什么"的清醒认知。**能把结构的脾气摸透，你既解得开算法题，也设计得出数据结构。**

---

## 小结

本篇以四道综合题收束整个专栏。LeetCode 2 复用 Plus One 的加法骨架，把进位模拟搬到链表上，其循环条件里那个 `carry != 0` 是必须留意的边界；LeetCode 143 把"找中点 + 反转 + 合并"三步串成流水线，是前面技巧的合体，其中"用较短一段作为合并边界"与"中点靠左还是靠右"两处细节最考验功夫；LeetCode 138 给出了哈希表与"节点交织"两种深拷贝方案，后者用物理相邻关系替代了哈希映射，把空间压到 $O(1)$；LeetCode 146 则把"哈希表 + 双向链表"这一组合推到台前，并用"节点必须存 key"这一细节提醒我们，工程实现的成败往往系于一处不起眼的疏漏。

从数组的内存模型到链表的 LRU 缓存，从双指针的原地修改到位运算的状态机，这条学习路径上真正被反复锤炼的，其实是两样东西：**读约束的能力，与说不变量的能力**。前者决定了你能想到哪条路，后者决定了你走那条路时不会迷路。**数据结构与算法的训练，最终沉淀下来的不是一堆模板，而是一种"面对陌生问题时仍能有序思考"的底气**——这大概就是它在面试与工程中都备受重视的原因。

---

## 参考资料

1. LeetCode 2. Add Two Numbers. https://leetcode.cn/problems/add-two-numbers/
2. LeetCode 143. Reorder List. https://leetcode.cn/problems/reorder-list/
3. LeetCode 138. Copy List with Random Pointer. https://leetcode.cn/problems/copy-list-with-random-pointer/
4. LeetCode 146. LRU Cache. https://leetcode.cn/problems/lru-cache/
5. Go 官方博客. *Go maps in action*. https://go.dev/blog/maps
6. Sedgewick, R., & Wayne, K. *Algorithms* (4th ed.). Addison-Wesley, 2011. 第 1.3 节"链表"与第 3.5 节"符号表"。

---

> [!note] 思考题
> 1. LeetCode 2 的两个链表若按"正序"存储（最高位在头），加法该如何处理？是否需要先反转？
> 2. LeetCode 143 的"找中点 + 反转 + 合并"三步，若改成"把后半段放入栈再逐个弹出"，空间会变成多少？值不值得？
> 3. LeetCode 138 的交织法会临时修改原链表。若题目要求原链表保持不变，交织法还能用吗？需要如何调整？
> 4. LeetCode 146 若把容量淘汰策略从 LRU 改成 LFU（最不经常使用），数据结构需要做哪些改动？
> 5. 请用"约束 → 权衡"这条主线，重新梳理一遍整个专栏中最令你印象深刻的三个解法，并说明它们各自在什么约束下做出了什么取舍。
