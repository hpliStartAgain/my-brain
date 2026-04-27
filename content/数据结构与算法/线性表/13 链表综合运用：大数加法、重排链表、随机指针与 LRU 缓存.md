---
title: "链表综合运用：大数加法、重排链表、随机指针与 LRU 缓存"
date: 2026-04-27
tags: [数据结构, 算法, 链表, LRU缓存, 随机指针, 大数加法, LeetCode, 面试]
aliases: [LRU缓存, 随机指针链表, 重排链表, 大数加法链表]
---

# 链表综合运用：大数加法、重排链表、随机指针与 LRU 缓存

## 摘要

本篇是线性表专栏的收官篇。四道题综合运用了链表的所有基础技巧：LeetCode 2（两数相加）是进位模拟；LeetCode 143（重排链表）综合了快慢指针找中点 + 反转链表 + 合并有序思路；LeetCode 138（复制带随机指针的链表）考察深拷贝中的指针重建；LeetCode 146（LRU 缓存）是面试重点题，考察 `HashMap + 双向链表` 的工程实现，要求 `get` 和 `put` 操作均为 $O(1)$。

---

## 第 1 章 LeetCode 2：两数相加

### 1.1 题目

**LeetCode 2 - Add Two Numbers**（中等）

给你两个非空的链表，表示两个非负的整数。它们每位数字都是按照**逆序**方式存储的，并且每个节点只能存储一位数字。请你将两个数相加，并以相同形式返回一个表示和的链表。

```
输入: l1 = [2,4,3], l2 = [5,6,4]
输出: [7,0,8]（342 + 465 = 807）

输入: l1 = [9,9,9,9,9,9,9], l2 = [9,9,9,9]
输出: [8,9,9,9,0,0,0,1]（9999999 + 9999 = 10009998）
```

### 1.2 进位模拟

**关键**：链表已按逆序存储（个位在头），直接从头开始相加即是从低位到高位，模拟手工加法。

**处理三种情况**：
- `l1` 和 `l2` 长度不同
- 最高位相加后有进位（结果链表需要额外节点）

```java
public ListNode addTwoNumbers(ListNode l1, ListNode l2) {
    ListNode dummy = new ListNode(-1);
    ListNode curr = dummy;
    int carry = 0; // 进位
    
    while (l1 != null || l2 != null || carry != 0) {
        int a = (l1 != null) ? l1.val : 0;
        int b = (l2 != null) ? l2.val : 0;
        
        int sum = a + b + carry;
        carry = sum / 10;
        curr.next = new ListNode(sum % 10);
        curr = curr.next;
        
        if (l1 != null) l1 = l1.next;
        if (l2 != null) l2 = l2.next;
    }
    
    return dummy.next;
}
```

**关键细节**：循环条件是 `l1 != null || l2 != null || carry != 0`，三个条件任意一个满足就继续循环。`carry != 0` 确保最高位有进位时（如 `999 + 1 = 1000`）额外生成进位节点。

**手动验证**（`[9,9,9,9,9,9,9]` + `[9,9,9,9]`）：

```
位1: 9+9+0=18, carry=1, 节点8
位2: 9+9+1=19, carry=1, 节点9
位3: 9+9+1=19, carry=1, 节点9
位4: 9+9+1=19, carry=1, 节点9
位5: 9+0+1=10, carry=1, 节点0
位6: 9+0+1=10, carry=1, 节点0
位7: 9+0+1=10, carry=1, 节点0
carry=1: 节点1

结果: 8→9→9→9→0→0→0→1 ✓
```

**复杂度**：时间 $O(\max(m, n))$，空间 $O(\max(m, n))$（结果链表）。

---

## 第 2 章 LeetCode 143：重排链表

### 2.1 题目

**LeetCode 143 - Reorder List**（中等）

给定一个单链表 `L`：$L_0 \to L_1 \to \ldots \to L_{n-1} \to L_n$

请你将其重新排列为：$L_0 \to L_n \to L_1 \to L_{n-1} \to L_2 \to L_{n-2} \to \ldots$

不能只是单纯地改变节点内部的值，而是需要实际的进行节点交换。

```
输入: head = [1,2,3,4]   → 输出: [1,4,2,3]
输入: head = [1,2,3,4,5] → 输出: [1,5,2,4,3]
```

### 2.2 三步法

**观察**：重排后的链表，是原链表前半段和后半段（倒序）的交叉合并。

**策略**：
1. **找中点**：用快慢指针找到链表中点
2. **反转后半段**：将中点之后的节点反转
3. **合并**：将前半段和反转后的后半段交叉合并

```java
public void reorderList(ListNode head) {
    if (head == null || head.next == null) return;
    
    // 第一步：快慢指针找中点
    ListNode slow = head, fast = head;
    while (fast.next != null && fast.next.next != null) {
        slow = slow.next;
        fast = fast.next.next;
    }
    // slow 现在是前半段的最后一个节点
    
    // 第二步：反转后半段
    ListNode secondHalf = slow.next;
    slow.next = null; // 断开前后两段
    secondHalf = reverseList(secondHalf);
    
    // 第三步：交叉合并
    ListNode first = head, second = secondHalf;
    while (second != null) {
        ListNode firstNext = first.next;
        ListNode secondNext = second.next;
        
        first.next = second;
        second.next = firstNext;
        
        first = firstNext;
        second = secondNext;
    }
}

private ListNode reverseList(ListNode head) {
    ListNode prev = null, curr = head;
    while (curr != null) {
        ListNode next = curr.next;
        curr.next = prev;
        prev = curr;
        curr = next;
    }
    return prev;
}
```

**手动验证**（`[1,2,3,4,5]`）：

```
第一步：找中点
  slow=1, fast=1
  step1: slow=2, fast=3
  step2: slow=3, fast=5（fast.next.next==null，停止）
  slow=3，前半段 1→2→3

第二步：反转后半段
  secondHalf = 4→5
  3.next = null（断开）
  反转 4→5 → 5→4

第三步：合并
  first=1, second=5
  
  iter1: firstNext=2, secondNext=4
    1.next=5, 5.next=2
    first=2, second=4
  
  iter2: firstNext=3, secondNext=null
    2.next=4, 4.next=3
    first=3, second=null
  
  second==null，停止

结果: 1→5→2→4→3 ✓
```

**复杂度**：时间 $O(n)$，空间 $O(1)$。

---

## 第 3 章 LeetCode 138：复制带随机指针的链表

### 3.1 题目

**LeetCode 138 - Copy List with Random Pointer**（中等）

给你一个长度为 `n` 的链表，每个节点包含一个额外增加的随机指针 `random`，该指针可以指向链表中的任何节点或空节点。

构造这个链表的**深拷贝**。深拷贝应该由完全新的节点组成，新节点的 `val`、`next`、`random` 都与原链表中对应节点相同，但 `next` 和 `random` 指针不能指向原链表中的节点，而应指向新链表中的节点。

```java
class Node {
    int val;
    Node next;
    Node random; // 可以指向链表中任意节点或 null
}
```

### 3.2 方法一：哈希表（直观，$O(n)$ 空间）

**思路**：用哈希表建立"原节点 → 新节点"的映射，两遍扫描：
- 第一遍：创建所有新节点，建立映射
- 第二遍：根据映射设置 `next` 和 `random`

```java
public Node copyRandomList(Node head) {
    if (head == null) return null;
    
    Map<Node, Node> map = new HashMap<>();
    
    // 第一遍：创建所有新节点
    Node curr = head;
    while (curr != null) {
        map.put(curr, new Node(curr.val));
        curr = curr.next;
    }
    
    // 第二遍：设置 next 和 random
    curr = head;
    while (curr != null) {
        map.get(curr).next = map.get(curr.next);     // next 可以是 null
        map.get(curr).random = map.get(curr.random); // random 可以是 null
        curr = curr.next;
    }
    
    return map.get(head);
}
```

**复杂度**：时间 $O(n)$，空间 $O(n)$（哈希表）。

### 3.3 方法二：节点交织（$O(1)$ 空间）

**思路**：不用哈希表，而是将新节点"穿插"到原节点后面，利用相对位置关系来设置 `random`，最后分离两条链表。

**三步**：
1. **交织**：在每个原节点后面插入对应的新节点（`A → A' → B → B' → ...`）
2. **设置 random**：此时 `A.next` 就是 `A'`，`A.random.next` 就是 `A'.random`
3. **分离**：还原原链表，提取新链表

```java
public Node copyRandomList(Node head) {
    if (head == null) return null;
    
    // 第一步：交织插入新节点
    Node curr = head;
    while (curr != null) {
        Node copy = new Node(curr.val);
        copy.next = curr.next; // 新节点的 next 指向原节点的下一个
        curr.next = copy;       // 原节点的 next 指向新节点
        curr = copy.next;       // 移动到下一个原节点
    }
    // 现在: A→A'→B→B'→C→C'→null
    
    // 第二步：设置新节点的 random
    curr = head;
    while (curr != null) {
        if (curr.random != null) {
            curr.next.random = curr.random.next; // A'.random = A.random.next = B'
        }
        curr = curr.next.next; // 跳到下一个原节点
    }
    
    // 第三步：分离两条链表
    Node newHead = head.next;
    curr = head;
    while (curr != null) {
        Node copy = curr.next;
        curr.next = copy.next; // 还原原链表
        copy.next = (copy.next != null) ? copy.next.next : null; // 设置新链表的 next
        curr = curr.next;
    }
    
    return newHead;
}
```

**关键推导**：在交织阶段，原节点 `A` 和其拷贝 `A'` 相邻（`A.next = A'`）。设 `A.random = B`，则 `A'.random` 应该是 `B'`，而 `B' = B.next`（因为 `B.next = B'`）。所以 `A'.random = A.random.next`。

**复杂度**：时间 $O(n)$，空间 $O(1)$（不计输出）。

---

## 第 4 章 LeetCode 146：LRU 缓存

### 4.1 题目

**LeetCode 146 - LRU Cache**（中等）

实现 `LRUCache` 类：
- `LRUCache(int capacity)` 以正整数作为容量 `capacity` 初始化 LRU 缓存
- `int get(int key)` 如果关键字 `key` 存在于缓存中，则返回关键字的值，否则返回 -1
- `void put(int key, int value)` 如果关键字 `key` 已经存在，则变更其数据值 `value`；如果不存在，则向缓存中插入该组 `key-value`。如果插入操作导致关键字数量超过 `capacity`，则应该**逐出最久未使用的关键字**

`get` 和 `put` 必须以 $O(1)$ 的平均时间复杂度运行。

### 4.2 数据结构设计

**$O(1)$ `get`**：哈希表 `key → Node`，直接定位节点

**$O(1)$ `put` + LRU 淘汰**：需要记录"访问顺序"，且能 $O(1)$ 删除任意节点。

**解决方案**：双向链表（Doubly Linked List）

- 链表按访问顺序排列：**头部是最近使用的，尾部是最久未使用的**
- 每次访问（get 或 put）时，将对应节点移到链表头部
- 容量满时，删除链表尾部节点（最久未使用）

**为什么必须是双向链表？**

删除一个节点需要 $O(1)$ 时间，必须能快速找到其前驱节点。单向链表找前驱需要 $O(n)$，双向链表直接通过 `prev` 指针找到前驱，删除是 $O(1)$。

```
HashMap: key → DLinkedNode
双向链表: dummyHead ↔ [最近] ↔ ... ↔ [最久] ↔ dummyTail
```

### 4.3 代码实现

```java
class LRUCache {
    
    // 双向链表节点
    private static class DLinkedNode {
        int key, value;
        DLinkedNode prev, next;
        DLinkedNode(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }
    
    private Map<Integer, DLinkedNode> cache;
    private int capacity;
    private DLinkedNode head, tail; // 哑头和哑尾
    
    public LRUCache(int capacity) {
        this.capacity = capacity;
        cache = new HashMap<>();
        
        // 初始化哑节点
        head = new DLinkedNode(0, 0);
        tail = new DLinkedNode(0, 0);
        head.next = tail;
        tail.prev = head;
    }
    
    public int get(int key) {
        DLinkedNode node = cache.get(key);
        if (node == null) return -1;
        
        moveToHead(node); // 访问了，移到头部
        return node.value;
    }
    
    public void put(int key, int value) {
        DLinkedNode node = cache.get(key);
        
        if (node == null) {
            // 新节点
            DLinkedNode newNode = new DLinkedNode(key, value);
            cache.put(key, newNode);
            addToHead(newNode);
            
            if (cache.size() > capacity) {
                // 超出容量，删除最久未使用的节点（链表尾部）
                DLinkedNode removed = removeTail();
                cache.remove(removed.key); // 同时从哈希表删除
            }
        } else {
            // 更新值，移到头部
            node.value = value;
            moveToHead(node);
        }
    }
    
    // 将节点插入到链表头部（head 之后）
    private void addToHead(DLinkedNode node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }
    
    // 从链表中移除节点（双向链表直接操作）
    private void removeNode(DLinkedNode node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    
    // 将节点移到链表头部
    private void moveToHead(DLinkedNode node) {
        removeNode(node);
        addToHead(node);
    }
    
    // 删除链表尾部节点（tail 之前的节点，即最久未使用的）
    private DLinkedNode removeTail() {
        DLinkedNode tailNode = tail.prev;
        removeNode(tailNode);
        return tailNode;
    }
}
```

### 4.4 操作演示

**示例**：`capacity = 2`

```
put(1, 1): cache={1:1}, 链表: H↔[1,1]↔T
put(2, 2): cache={1:1,2:2}, 链表: H↔[2,2]↔[1,1]↔T
get(1):    访问key=1，移到头部，返回1
           cache={1:1,2:2}, 链表: H↔[1,1]↔[2,2]↔T
put(3, 3): 容量满，删除尾部[2,2]，插入[3,3]
           cache={1:1,3:3}, 链表: H↔[3,3]↔[1,1]↔T
get(2):    key=2不存在，返回-1
put(4, 4): 容量满，删除尾部[1,1]，插入[4,4]
           cache={3:3,4:4}, 链表: H↔[4,4]↔[3,3]↔T
get(1):    -1
get(3):    返回3，移到头部，链表: H↔[3,3]↔[4,4]↔T
get(4):    返回4，移到头部，链表: H↔[4,4]↔[3,3]↔T
```

### 4.5 复杂度与工程意义

**复杂度**：`get` 和 `put` 均为 $O(1)$（哈希表 $O(1)$ 定位 + 双向链表 $O(1)$ 插删）。

**为什么在 DLinkedNode 中存储 key？**

淘汰节点时，需要从哈希表中删除对应的键（`cache.remove(removed.key)`）。如果节点中只存 value，就无法找到对应的 key，因此节点必须存储 `key`。这是实现中容易遗漏的细节。

> [!info] LRU 的工程应用
> LRU 缓存在工程中极为常见：Redis 的内存淘汰策略之一就是 LRU；CPU 的 L1/L2/L3 缓存也使用类似策略；浏览器的页面缓存、数据库的 Buffer Pool 都有 LRU 的影子。理解 LRU 的实现，帮助你理解各类缓存系统的设计决策。

---

## 第 5 章 全专栏总结

### 5.1 数组题的解题框架

数组题的难点通常在于**时间和空间的优化**，核心技巧体系：

| 技巧 | 解决的问题 | 代表题 |
|------|-----------|--------|
| 双指针（同向） | 原地修改，去重 | LeetCode 26、80、27 |
| 双指针（对向） | 排序数组查找，两数之和 | LeetCode 15、16、18 |
| 二分搜索 | 有序数组查找，旋转数组 | LeetCode 33、81、4 |
| 哈希表辅助 | $O(1)$ 查找，连续子序列 | LeetCode 1、128 |
| 贪心 | 局部最优→全局最优 | LeetCode 42、134、135 |
| 位运算 | 不用额外空间的计数/判重 | LeetCode 136、137 |
| 动态规划 | 最优子结构问题 | LeetCode 70 |

### 5.2 链表题的解题框架

链表题的难点通常在于**指针操作的正确性和边界处理**，核心技巧体系：

| 技巧 | 解决的问题 | 代表题 |
|------|-----------|--------|
| 哑节点 | 统一处理头节点删除 | LeetCode 82、19、86 |
| 快慢指针 | 环检测、找中点、倒数节点 | LeetCode 141、142、19 |
| 反转链表 | 链表翻转变体 | LeetCode 92、25、24 |
| 多链表合并 | 分拆后合并 | LeetCode 86、143 |
| 哈希表辅助 | 节点映射/随机指针深拷贝 | LeetCode 138 |
| HashMap + 双向链表 | $O(1)$ 的有序缓存 | LeetCode 146 |

### 5.3 面试备考建议

经过 13 篇的系统学习，线性表（数组+链表）的面试题已经覆盖全面。备考的最后阶段，建议：

1. **刷题顺序**：先按本专栏的顺序，每篇配合 LeetCode 做题，理解之后再做变体
2. **重点记忆**：每种技巧的模板代码，尤其是双指针、二分、反转链表这三个最高频
3. **边界意识**：每做完一道题，主动检查空链表、单节点、头尾边界等 case
4. **复杂度习惯**：说出答案前先分析时间和空间复杂度，这是面试中的加分项
5. **代码干净**：变量命名清晰（`prev/curr/next`，`left/right`，`slow/fast`），缩进规范，减少面试官的阅读负担

> [!note] 算法题的本质
> 算法题面试考察的不仅是能否得到正确答案，更是你的**思维过程**：能否清晰地分析问题、能否识别合适的数据结构和算法模式、能否主动发现并处理边界 case、能否在面试官提示下快速调整方向。把这些习惯训练出来，比记住 100 道题的解法更有价值。

---

*至此，《线性表面试专栏》全 13 篇完结。从数组的内存模型到链表的 LRU 缓存，从双指针的原地修改到位运算的状态机，你已经系统掌握了线性表这一数据结构在面试中的所有核心考点。祝面试顺利。*
