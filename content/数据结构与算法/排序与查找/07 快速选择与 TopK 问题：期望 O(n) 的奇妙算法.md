---
title: "快速选择与 TopK 问题：期望 O(n) 的奇妙算法"
date: 2026-04-27
tags: [算法, 排序, 快速选择, TopK, 优先队列, LeetCode, 面试]
aliases: [快速选择, QuickSelect, TopK问题, Kth Largest Element]
---

# 快速选择与 TopK 问题：期望 O(n) 的奇妙算法

## 摘要

"找第 K 大的元素"是面试中的超高频题目，表面上看只需排序后取第 K 个，时间 $O(n \log n)$，但面试官真正想看的是更优的 $O(n)$ 期望时间方案——**快速选择（QuickSelect）算法**。本文从快速排序的分区操作出发，推导出快速选择的核心思路，同时讲解最小堆维护 TopK 的 $O(n \log k)$ 方案，并对比两者的适用场景。本篇覆盖 Kth Largest Element in an Array（215）和 Top K Frequent Elements（347）两道经典题。

---

## 第 1 章 TopK 问题的多种解法

### 1.1 问题描述

"TopK 问题"的一般形式：给定 $n$ 个元素，找出其中最大（或最小）的 $k$ 个元素，或者找出第 $k$ 大（或第 $k$ 小）的元素。

这个问题有三种主流解法，复杂度递减：

| 解法 | 时间复杂度 | 空间复杂度 | 适用场景 |
|------|-----------|-----------|---------|
| 全量排序 | $O(n \log n)$ | $O(1)$ | 需要完整排序的场景 |
| 最小堆 | $O(n \log k)$ | $O(k)$ | 数据流场景，$k \ll n$ |
| 快速选择 | $O(n)$ 期望 | $O(\log n)$ | 静态数组，只要第 k 个 |

三种解法在面试中都可能被问到，但面试官通常期望看到最优的快速选择，或者在被问"还有没有更好的解法"时能给出快速选择。

### 1.2 全量排序：能用但不够优

```java
// 时间 O(nlogn)，空间 O(1)（原地排序）
public int findKthLargest(int[] nums, int k) {
    Arrays.sort(nums);
    return nums[nums.length - k];
}
```

这当然是对的，但面试中直接这样写会被追问"时间复杂度能不能更好"。

---

## 第 2 章 最小堆解法：维护大小为 K 的窗口

### 2.1 最小堆的 TopK 思路

维护一个大小为 $k$ 的**最小堆**（堆顶是堆内最小元素）：
- 遍历所有元素，将每个元素加入堆
- 当堆大小超过 $k$ 时，弹出堆顶（最小元素）
- 遍历结束后，堆内剩下的 $k$ 个元素就是最大的 $k$ 个，堆顶是第 $k$ 大

**为什么用最小堆而不是最大堆？** 

用最小堆是为了方便维护"当前最大的 k 个元素"这个集合：堆顶是这 $k$ 个元素中最小的，当新元素比堆顶大时，说明新元素应该取代堆顶（堆顶出局），加入这个集合；如果新元素比堆顶小，说明新元素不够大，不需要放入这个集合。

```java
public int findKthLargest(int[] nums, int k) {
    // Java 的 PriorityQueue 默认是最小堆
    PriorityQueue<Integer> minHeap = new PriorityQueue<>();

    for (int num : nums) {
        minHeap.offer(num);
        if (minHeap.size() > k) {
            minHeap.poll();  // 弹出当前最小值，保持堆大小为 k
        }
    }

    return minHeap.peek();  // 堆顶就是第 k 大的元素
}
```

**时间复杂度**：每次入堆/出堆 $O(\log k)$，$n$ 个元素，总计 $O(n \log k)$。
**空间复杂度**：$O(k)$（堆的大小）。

**最小堆的优势**：适用于**数据流**场景。数据不需要预先知道全集，可以一边接收数据一边维护堆。例如，监控系统实时接收大量日志，需要随时查询"响应时间最慢的 k 个请求"，就适合用最小堆。

---

## 第 3 章 快速选择：期望 O(n) 的精妙算法

### 3.1 从快速排序分区说起

回忆快速排序的分区（Partition）操作：选定 pivot，将数组分为"小于等于 pivot 的部分"在左、"大于 pivot 的部分"在右，返回 pivot 的最终位置 `pivotIndex`。

分区结束后，我们知道：
- `nums[pivotIndex]` 已经在它排好序后应该在的最终位置
- `pivotIndex` 左边的所有元素都小于等于 `nums[pivotIndex]`
- `pivotIndex` 右边的所有元素都大于 `nums[pivotIndex]`

**快速选择的核心洞察**：如果 `pivotIndex == n - k`（即 pivot 恰好在排好序后第 k 大的位置），那么 `nums[pivotIndex]` 就是答案，**不需要继续排序**。

如果 `pivotIndex < n - k`，说明第 k 大的元素在 `pivotIndex` 右边，只需在右边递归查找；如果 `pivotIndex > n - k`，只在左边递归查找。

每次递归只需处理一半（期望），而不是两半（快速排序），这就是从 $O(n \log n)$ 降为 $O(n)$ 的关键。

### 3.2 LeetCode 215：数组中第 K 个最大元素

**题目**：

**LeetCode 215 - Kth Largest Element in an Array**（中等）

给定整数数组 `nums` 和整数 `k`，请返回数组中第 $k$ 个最大的元素。

请注意，你需要找的是数组排序后的第 $k$ 个最大的元素，而不是第 $k$ 个不同的元素。

```
输入: [3,2,1,5,6,4], k = 2
输出: 5

输入: [3,2,3,1,2,4,5,5,6], k = 4
输出: 4
```

**快速选择实现**：

```java
public int findKthLargest(int[] nums, int k) {
    int n = nums.length;
    // 第 k 大元素，在排好序的数组中是下标 n-k 的元素（0-indexed）
    return quickSelect(nums, 0, n - 1, n - k);
}

private int quickSelect(int[] nums, int left, int right, int targetIdx) {
    if (left == right) return nums[left];

    // 随机化 pivot，避免最坏情况
    int randIdx = left + (int)(Math.random() * (right - left + 1));
    swap(nums, randIdx, right);

    int pivotIdx = partition(nums, left, right);

    if (pivotIdx == targetIdx) {
        return nums[pivotIdx];  // 找到！
    } else if (pivotIdx < targetIdx) {
        return quickSelect(nums, pivotIdx + 1, right, targetIdx);  // 去右边找
    } else {
        return quickSelect(nums, left, pivotIdx - 1, targetIdx);   // 去左边找
    }
}

private int partition(int[] nums, int left, int right) {
    int pivot = nums[right];
    int i = left - 1;
    for (int j = left; j < right; j++) {
        if (nums[j] <= pivot) {
            i++;
            swap(nums, i, j);
        }
    }
    swap(nums, i + 1, right);
    return i + 1;
}

private void swap(int[] nums, int i, int j) {
    int tmp = nums[i]; nums[i] = nums[j]; nums[j] = tmp;
}
```

### 3.3 复杂度分析：为什么期望是 O(n)

**期望时间分析**：

设随机 pivot 将数组分成了"左边 $m$ 个，右边 $n-m-1$ 个"的两部分（$m$ 是随机的）。我们只需递归处理其中一半，设较大的那一半为 $\max(m, n-m-1)$。

当 pivot 选择"好"（$1/4 \leq m/n \leq 3/4$，即分区较均匀）时，较大的那一半最多有 $3n/4$ 个元素。随机 pivot 有 $1/2$ 的概率选到一个"好" pivot（$m/n$ 在 $[1/4, 3/4]$ 范围内的概率是 $1/2$）。

期望情况下，每次问题规模缩小到 $3/4$，总计算量：

$$T(n) = n + T(3n/4) = n + \frac{3n}{4} + \frac{9n}{16} + \cdots = n \cdot \frac{1}{1 - 3/4} = 4n = O(n)$$

**最坏情况**：每次 pivot 都选到极值（最大或最小），每次只排除一个元素，$T(n) = n + (n-1) + \cdots = O(n^2)$。随机化 pivot 让这种情况的概率极低。

> [!note] 设计哲学：快速选择 vs 堆
> 快速选择的期望时间是 $O(n)$，但：
> 1. 它会**修改原数组**（通过交换操作），如果不能修改原数组，需要先复制一份
> 2. 它是**非在线算法**，需要先知道全部数据
> 3. 最坏情况 $O(n^2)$（虽然随机化让这概率极低）
>
> 堆的时间是 $O(n \log k)$，但：
> 1. **不修改原数组**
> 2. **支持在线处理**（数据流）
> 3. **最坏情况也是 $O(n \log k)$，有保证**
>
> 面试中选哪个，取决于题目的约束。如果只需要"找第 k 大"，快速选择更优；如果需要"始终维护 TopK"或数据流，用堆。

### 3.4 迭代版快速选择（避免递归栈开销）

递归版本在最坏情况下栈深度 $O(n)$，可能栈溢出。迭代版本更安全：

```java
public int findKthLargest(int[] nums, int k) {
    int n = nums.length;
    int targetIdx = n - k;
    int left = 0, right = n - 1;

    while (left < right) {
        int pivotIdx = partition(nums, left, right);
        if (pivotIdx == targetIdx) break;
        else if (pivotIdx < targetIdx) left = pivotIdx + 1;
        else right = pivotIdx - 1;
    }

    return nums[targetIdx];
}
```

---

## 第 4 章 LeetCode 347：前 K 个高频元素

### 4.1 题目

**LeetCode 347 - Top K Frequent Elements**（中等）

给你一个整数数组 `nums` 和一个整数 `k`，请你返回其中出现频率前 `k` 高的元素。你可以按**任意顺序**返回答案。

```
输入: nums = [1,1,1,2,2,3], k = 2
输出: [1,2]

输入: nums = [1], k = 1
输出: [1]
```

### 4.2 问题拆分

这道题不是直接对元素值做 TopK，而是对元素的**出现频率**做 TopK。可以拆成两步：
1. **统计频率**：用哈希表统计每个元素出现的次数，$O(n)$
2. **TopK**：对这个"元素 → 频率"的映射，找出频率最高的 $k$ 个元素

第二步就是 TopK 问题，可以用最小堆或快速选择。

### 4.3 解法一：最小堆（按频率维护 TopK）

```java
public int[] topKFrequent(int[] nums, int k) {
    // 第一步：统计频率
    Map<Integer, Integer> freq = new HashMap<>();
    for (int num : nums) freq.merge(num, 1, Integer::sum);

    // 第二步：最小堆，堆内元素按频率排序
    // 堆内存 (频率, 元素值) 对，按频率做最小堆
    PriorityQueue<int[]> minHeap = new PriorityQueue<>((a, b) -> a[0] - b[0]);
    for (Map.Entry<Integer, Integer> entry : freq.entrySet()) {
        minHeap.offer(new int[]{entry.getValue(), entry.getKey()});
        if (minHeap.size() > k) minHeap.poll();
    }

    // 第三步：提取结果
    int[] result = new int[k];
    for (int i = k - 1; i >= 0; i--) result[i] = minHeap.poll()[1];
    return result;
}
```

**时间 $O(n \log k)$，空间 $O(n)$（哈希表）。**

### 4.4 解法二：桶排序（线性时间方案）

利用"频率的范围是 $[1, n]$"这个约束，可以用桶排序实现 $O(n)$ 的解法：

创建 $n+1$ 个桶（下标 0 到 $n$），下标 $i$ 的桶存放出现频率恰好为 $i$ 的所有元素。然后从高频桶到低频桶遍历，取前 $k$ 个元素。

```java
public int[] topKFrequent(int[] nums, int k) {
    // 第一步：统计频率
    Map<Integer, Integer> freq = new HashMap<>();
    for (int num : nums) freq.merge(num, 1, Integer::sum);

    // 第二步：桶排序（下标 i 的桶存放频率为 i 的元素）
    List<Integer>[] buckets = new List[nums.length + 1];
    for (int i = 0; i <= nums.length; i++) buckets[i] = new ArrayList<>();
    for (Map.Entry<Integer, Integer> entry : freq.entrySet()) {
        buckets[entry.getValue()].add(entry.getKey());
    }

    // 第三步：从高频到低频收集前 k 个
    int[] result = new int[k];
    int idx = 0;
    for (int i = nums.length; i >= 1 && idx < k; i--) {
        for (int num : buckets[i]) {
            result[idx++] = num;
            if (idx == k) return result;
        }
    }
    return result;
}
```

**时间 $O(n)$，空间 $O(n)$。**

### 4.5 三种解法对比

| 解法 | 时间 | 空间 | 特点 |
|------|------|------|------|
| 全排序 | $O(n \log n)$ | $O(n)$ | 最简单 |
| 最小堆 | $O(n \log k)$ | $O(n)$ | 支持数据流 |
| 桶排序 | $O(n)$ | $O(n)$ | 最优，利用频率范围约束 |

面试建议：先给出最小堆方案（$O(n \log k)$），然后提出"如果要进一步优化，可以利用频率范围在 $[1, n]$ 的特点，用桶排序降为 $O(n)$"，展示你对多种方案的掌握。

---

## 第 5 章 快速选择的高频变体

### 5.1 最接近原点的 K 个点（LeetCode 973）

**题目**：给定一组点，找距离原点最近的 $k$ 个。

**解题**：这就是对"距离平方"做 TopK 小的问题（找最小的 $k$ 个），将快速选择的方向反过来，或用最大堆（维护大小为 $k$ 的最大堆，堆顶是当前 $k$ 个中最远的，新点如果比堆顶近就替换）。

```java
public int[][] kClosest(int[][] points, int k) {
    // 最大堆：按距离降序，堆顶是当前 k 个中最远的
    PriorityQueue<int[]> maxHeap = new PriorityQueue<>(
        (a, b) -> dist(b) - dist(a)
    );
    for (int[] p : points) {
        maxHeap.offer(p);
        if (maxHeap.size() > k) maxHeap.poll();
    }
    int[][] result = new int[k][];
    for (int i = 0; i < k; i++) result[i] = maxHeap.poll();
    return result;
}

private int dist(int[] p) { return p[0] * p[0] + p[1] * p[1]; }
```

### 5.2 数据流中的第 K 大元素（LeetCode 703）

**题目**：设计一个类，在数据流中找第 $k$ 大的元素。

**解题**：维护大小为 $k$ 的最小堆，堆顶始终是当前第 $k$ 大的元素。每次新元素加入，如果大于堆顶就替换。

```java
class KthLargest {
    private PriorityQueue<Integer> minHeap;
    private int k;

    public KthLargest(int k, int[] nums) {
        this.k = k;
        minHeap = new PriorityQueue<>();
        for (int num : nums) add(num);
    }

    public int add(int val) {
        minHeap.offer(val);
        if (minHeap.size() > k) minHeap.poll();
        return minHeap.peek();
    }
}
```

这道题是最小堆维护 TopK 的教科书式应用，面试中出现频率很高。

---

## 小结

本文系统讲解了 TopK 问题的三种解法：

1. **全量排序**：$O(n \log n)$，简单但不够优，面试中仅作为基准
2. **最小堆**：$O(n \log k)$，适用于数据流、需要动态维护 TopK 的场景，`PriorityQueue` 实现简洁
3. **快速选择**：期望 $O(n)$，只需知道"第 k 大是什么"而不需要完整排序，修改原数组，适用于静态数组

**快速选择的核心**：复用快速排序的分区操作，但每次只递归"目标所在的那一半"，期望情况下问题规模每次缩小 $3/4$，总时间 $O(n)$。

**LeetCode 347（Top K Frequent）**的最优解是桶排序（$O(n)$），利用"频率范围 $[1, n]$"的约束突破了比较排序的下界。

---

**上一篇**：[[06 二分查找的变体：旋转有序数组与有序矩阵]]
**下一篇**：[[08 排序在非排序题中的妙用：区间合并与贪心]]
