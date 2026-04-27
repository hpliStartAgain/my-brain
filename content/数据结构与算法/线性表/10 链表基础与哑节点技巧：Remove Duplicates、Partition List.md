---
title: "链表基础与哑节点技巧：Remove Duplicates、Partition List"
date: 2026-04-27
tags: [数据结构, 算法, 链表, 哑节点, 双指针, LeetCode, 面试]
aliases: [链表入门, 哑节点, 链表去重, 链表分区]
---

# 链表基础与哑节点技巧：Remove Duplicates、Partition List

## 摘要

本篇是链表专题的入门篇。链表题的核心挑战不是时间复杂度的优化，而是**指针操作的正确性**和**边界条件的处理**。本篇引入链表操作的两个基础工具：**哑节点（Dummy Node）** 和 **双指针追踪（prev + curr）**，通过三道典型题：LeetCode 83（有序链表删重，保留一次）、LeetCode 82（有序链表删重，全部删除）、LeetCode 86（链表分区），建立链表操作的标准范式，为后续快慢指针、反转链表等进阶内容打好基础。

---

## 第 1 章 链表的内存模型与操作要点

### 1.1 链表节点的定义

```java
// LeetCode 标准链表节点定义
public class ListNode {
    int val;
    ListNode next;
    ListNode(int val) { this.val = val; }
}
```

链表是由节点组成的**动态数据结构**，每个节点存储一个值和一个指向下一个节点的指针（引用）。

与数组相比：

| 特性 | 数组 | 链表 |
|------|------|------|
| 内存布局 | 连续 | 不连续（分散在堆上） |
| 随机访问 | $O(1)$ | $O(n)$ |
| 头部插入/删除 | $O(n)$（移动元素） | $O(1)$ |
| 中间插入/删除（已知前驱节点） | $O(n)$（移动元素） | $O(1)$ |
| 缓存友好性 | 好 | 差（指针跳跃） |

### 1.2 链表操作的三个核心注意点

**1. 操作顺序**：修改指针时，顺序至关重要。例如删除节点 B（链：A→B→C）：
```java
A.next = C; // 正确：先改指向，B 自然被"遗弃"
// 不需要 B.next = null（GC 会处理）
```

**2. 空指针检查**：每次访问 `node.next` 或 `node.val` 前，检查 `node != null`。链表题的 NullPointerException 80% 来自遗漏了这个检查。

**3. 头节点的特殊性**：很多链表操作（删除、分区等）可能修改头节点。处理头节点删除有两种方式：
- **方式 A**：单独处理头节点的 case（繁琐，容易出错）
- **方式 B**：引入哑节点（统一处理，推荐）

### 1.3 哑节点（Dummy Node）的作用

**哑节点**（Dummy Node，也叫哨兵节点）是一个人工创建的虚拟头节点，放在真实头节点之前：

```java
ListNode dummy = new ListNode(-1); // 值随意，一般用 -1 或 0
dummy.next = head;
```

**作用**：让所有节点（包括原始头节点）都有一个前驱节点。这样，"删除头节点"和"删除中间节点"的代码完全相同，无需特判。

**使用惯例**：
```java
ListNode dummy = new ListNode(-1);
dummy.next = head;
// ... 处理链表 ...
return dummy.next; // 返回真实头节点（可能已改变）
```

---

## 第 2 章 LeetCode 83：删除排序链表中的重复元素（保留一次）

### 2.1 题目

**LeetCode 83 - Remove Duplicates from Sorted List**（简单）

给定一个已排序的链表的头节点 `head`，删除所有重复的元素，使每个元素只出现一次。返回已排序的链表。

```
输入: head = [1,1,2]     → 输出: [1,2]
输入: head = [1,1,2,3,3] → 输出: [1,2,3]
```

### 2.2 分析

链表已排序，所有相同的值连续出现。

**策略**：用一个指针 `curr` 遍历链表。当 `curr.val == curr.next.val` 时，跳过 `curr.next`（令 `curr.next = curr.next.next`）；否则移动 `curr` 到下一个节点。

> [!note] 为什么这道题不需要哑节点？
> 因为我们保留每个值的第一次出现，头节点一定被保留（不会被删除），不需要哑节点。

```java
public ListNode deleteDuplicates(ListNode head) {
    ListNode curr = head;
    
    while (curr != null && curr.next != null) {
        if (curr.val == curr.next.val) {
            // 跳过重复节点
            curr.next = curr.next.next;
            // curr 不移动，继续检查新的 curr.next
        } else {
            curr = curr.next;
        }
    }
    
    return head;
}
```

**手动验证**（`[1,1,2,3,3]`）：

```
curr=1: curr.val==curr.next.val(1), 跳过: 1→2→3→3
curr=1: curr.val!=curr.next.val(2), curr=2
curr=2: curr.val!=curr.next.val(3), curr=3
curr=3: curr.val==curr.next.val(3), 跳过: 1→2→3→null
curr=3: curr.next==null, 退出循环
返回: [1,2,3] ✓
```

**复杂度**：时间 $O(n)$，空间 $O(1)$。

---

## 第 3 章 LeetCode 82：删除排序链表中的重复元素 II（全部删除）

### 3.1 题目

**LeetCode 82 - Remove Duplicates from Sorted List II**（中等）

给定一个已排序的链表的头节点 `head`，删除原始链表中所有重复数字的节点，只留下不同的数字。返回已排序的链表。

```
输入: head = [1,2,3,3,4,4,5] → 输出: [1,2,5]
输入: head = [1,1,1,2,3]     → 输出: [2,3]
```

### 3.2 为什么这道题必须用哑节点

第二道题的关键区别：**重复的节点需要全部删除**。

如果重复节点在头部（如 `[1,1,1,2,3]`），头节点本身也需要被删除，返回的头节点不再是原来的 `head`。此时必须用哑节点统一处理。

### 3.3 双指针：prev + 检测重复

**思路**：用 `prev` 指向上一个**确认保留**的节点（初始为哑节点）。`curr` 向前探测：
- 如果 `curr` 和 `curr.next` 值相同，则进入内层循环，跳过所有值等于 `curr.val` 的节点
- 跳过后，令 `prev.next = curr.next`（将这段重复节点全部切除）
- 如果 `curr` 和 `curr.next` 值不同，说明 `curr` 是唯一值，将 `prev` 移动到 `curr`

```java
public ListNode deleteDuplicates(ListNode head) {
    ListNode dummy = new ListNode(-1);
    dummy.next = head;
    ListNode prev = dummy; // prev 指向上一个确认保留的节点
    
    ListNode curr = head;
    while (curr != null) {
        // 检测是否是重复节点（与下一个相同）
        if (curr.next != null && curr.val == curr.next.val) {
            int dupVal = curr.val;
            // 跳过所有值等于 dupVal 的节点
            while (curr != null && curr.val == dupVal) {
                curr = curr.next;
            }
            // prev.next 直接指向第一个非重复节点
            prev.next = curr;
        } else {
            // curr 是唯一节点，保留，prev 前进
            prev = curr;
            curr = curr.next;
        }
    }
    
    return dummy.next;
}
```

**手动验证**（`[1,1,1,2,3]`）：

```
初始: dummy(-1) → 1 → 1 → 1 → 2 → 3
prev=dummy, curr=1

curr=1: curr.next(1).val == curr.val(1)? YES, dupVal=1
  内层循环: curr=1→1→1→2(不等于1，停止)
  prev.next = curr(2): dummy → 2 → 3
curr=2

curr=2: curr.next(3).val != curr.val(2)? YES
  prev=2, curr=3

curr=3: curr.next==null, 不是重复节点
  prev=3, curr=null

退出，返回 dummy.next = 2 → 3 ✓
```

**手动验证**（`[1,2,3,3,4,4,5]`）：

```
初始: dummy → 1 → 2 → 3 → 3 → 4 → 4 → 5
prev=dummy, curr=1

curr=1: next.val(2)!=1, prev=1, curr=2
curr=2: next.val(3)!=2, prev=2, curr=3
curr=3: next.val(3)==3, dupVal=3
  跳过所有3: curr=3→3→4(停止)
  prev.next=4: dummy→1→2→4→4→5
curr=4: next.val(4)==4, dupVal=4
  跳过所有4: curr=4→4→5(停止)
  prev.next=5: dummy→1→2→5
curr=5: next==null, prev=5, curr=null

返回 dummy.next → 1→2→5 ✓
```

**复杂度**：时间 $O(n)$，空间 $O(1)$。

---

## 第 4 章 LeetCode 86：分隔链表

### 4.1 题目

**LeetCode 86 - Partition List**（中等）

给你一个链表的头节点 `head` 和一个特定值 `x`，请你对链表进行分隔，使得所有**小于** `x` 的节点都出现在**大于或等于** `x` 的节点之前。

你应当**保留**两个分区中每个节点的初始相对顺序。

```
输入: head = [1,4,3,2,5,2], x = 3
输出: [1,2,2,4,3,5]

输入: head = [2,1], x = 2
输出: [1,2]
```

### 4.2 双哑节点：分开维护两条链

**关键约束**：必须保留原始相对顺序，不能只是交换值。

**解法**：创建两个独立的链表：
- `smallList`：收集所有 `< x` 的节点（用 `smallDummy` 做头）
- `largeList`：收集所有 `>= x` 的节点（用 `largeDummy` 做头）

遍历完原始链表后，将 `smallList` 的尾部与 `largeList` 的头部拼接，同时将 `largeList` 的尾部的 `next` 置为 `null`（断开可能存在的多余连接）。

```java
public ListNode partition(ListNode head, int x) {
    // 两个哑节点，分别作为小链表和大链表的虚拟头
    ListNode smallDummy = new ListNode(-1);
    ListNode largeDummy = new ListNode(-1);
    
    ListNode small = smallDummy; // small 链表的当前尾部
    ListNode large = largeDummy; // large 链表的当前尾部
    
    ListNode curr = head;
    while (curr != null) {
        if (curr.val < x) {
            small.next = curr;
            small = small.next;
        } else {
            large.next = curr;
            large = large.next;
        }
        curr = curr.next;
    }
    
    // 拼接：小链表尾部连接大链表头部
    large.next = null;     // 大链表末尾置 null（重要！防止环）
    small.next = largeDummy.next; // 小链表连接大链表
    
    return smallDummy.next;
}
```

**手动验证**（`[1,4,3,2,5,2], x=3`）：

```
初始: curr = 1 → 4 → 3 → 2 → 5 → 2

curr=1(<3): small链: dummy→1, small=1
curr=4(>=3): large链: dummy→4, large=4
curr=3(>=3): large链: dummy→4→3, large=3
curr=2(<3): small链: dummy→1→2, small=2
curr=5(>=3): large链: dummy→4→3→5, large=5
curr=2(<3): small链: dummy→1→2→2, small=2(第二个)

拼接:
  large.next = null → 4→3→5→null
  small.next = largeDummy.next(4) → 1→2→2→4→3→5

返回 smallDummy.next → 1→2→2→4→3→5 ✓
```

### 4.3 为什么必须 `large.next = null`

这是一个容易遗漏的细节。原始链表中，节点 5 的 `next` 指向 2（最后一个 2）。分区后，2 被放入了 `small` 链表。如果不把 `large.next`（即 5 的 `next`）置为 `null`，`large` 链表的末尾仍然指向 `small` 链表中的一个节点，导致链表出现环或错误的结构！

```java
large.next = null; // 断开 large 链表末尾的旧 next 指向
```

这一行在面试中经常被遗漏，务必牢记。

---

## 第 5 章 链表操作的通用思维框架

### 5.1 画图优先

链表操作在脑子里抽象推导极易出错，**动手画图是第一步**。用方框表示节点，箭头表示 `next`，在图上标注每一步操作后指针的变化。

面试时告诉面试官"我先画个图梳理一下"，这不是浪费时间，而是展示你扎实的工程习惯。

### 5.2 哑节点的使用准则

**何时必须用哑节点**：
- 可能删除头节点（LeetCode 82、19、203 等）
- 需要返回的头节点可能改变（LeetCode 21 合并链表、LeetCode 86 等）
- 维护多条链表并最后拼接（LeetCode 86、143 等）

**何时不需要哑节点**：
- 头节点一定被保留（LeetCode 83 保留每个值一次）
- 只是遍历，不删除（链表遍历、求长度等）

### 5.3 常见边界条件清单

每写完一道链表题，检查这些情况：

| 边界条件 | 说明 |
|---------|------|
| `head == null` | 空链表 |
| 链表只有一个节点 | `head.next == null` |
| 需要操作的是头节点 | 是否用哑节点统一处理 |
| 链表末尾节点 | `curr.next == null` 时别访问 `curr.next.val` |
| 操作后末尾节点的 `next` | 是否需要置 `null`（防止意外连接） |

### 5.4 三道题的模式对比

| 题目 | 需要哑节点 | 核心操作 | 难点 |
|------|-----------|---------|------|
| LeetCode 83（保留一次） | 不需要 | `curr.next = curr.next.next` | 无 |
| LeetCode 82（全部删除） | **必须** | `prev.next = curr`（跳过整段重复） | 循环结束条件 |
| LeetCode 86（分区） | **两个哑节点** | 分拆再合并 | `large.next = null` |

---

## 下一篇预告

[[11 链表快慢指针：环检测、倒数节点与链表旋转]] 将引入链表题最经典的技巧——**快慢指针**（Floyd 判圈算法）。两个速度不同的指针在链表上"赛跑"，能解决环路检测（LeetCode 141）、找环入口（LeetCode 142）、删除倒数第 N 个节点（LeetCode 19）和旋转链表（LeetCode 61）等一系列问题。这种双指针的思维方式既优雅又高效，是链表面试必备技能。
