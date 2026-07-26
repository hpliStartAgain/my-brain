---
title: "组合型回溯：Combination Sum 系列与去重艺术"
date: 2026-04-28
tags: [Combination Sum, LeetCode, 剪枝, 去重, 回溯, 算法, 组合, 面试]
aliases: [Combination Sum, 组合回溯, 去重剪枝, LeetCode 39, LeetCode 40]
---

# 组合型回溯：Combination Sum 系列与去重艺术

## 摘要

Combination Sum（组合总和）系列是回溯算法中"组合"类问题的标准教学案例。I 和 II 两道题看似只有"是否有重复元素"这一个区别，但去重逻辑的实现却是面试中最高频的出错点。本文从"排列和组合的本质区别"出发，推导出 `start` 指针的存在理由，再深入讲解 Combination Sum II 中 `i > start` 而非 `i > 0` 的去重条件，以及为什么排序是去重剪枝的前提。全程通过搜索树的可视化，直观展示不同实现选择对搜索空间的影响。

---

## 第 1 章 排列与组合：两类问题的本质区别

### 1.1 为什么需要区分排列和组合

**排列（Permutation）**：元素的**顺序**很重要，`[1,2]` 和 `[2,1]` 是不同的排列。

**组合（Combination）**：元素的**选择**很重要，顺序不重要，`[1,2]` 和 `[2,1]` 是同一个组合。

对于组合问题，如果不加限制，回溯会枚举出 `[1,2]` 和 `[2,1]` 两个，但只有一个是正确答案——这就是"重复"问题的来源。

**本质差异**：组合问题的搜索树，每个节点只能向"后面"的元素做选择，不能往前选——这就是 `start` 参数的作用。

### 1.2 通用组合框架 vs 通用排列框架

**排列框架**（无 `start`，`used` 数组防止重选）：

```java
void backtrack(int[] nums, boolean[] used, List<Integer> path, ...) {
    if (path.size() == nums.length) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = 0; i < nums.length; i++) {  // 从 0 开始
        if (used[i]) continue;
        used[i] = true;
        path.add(nums[i]);
        backtrack(nums, used, path, ...);
        path.remove(path.size() - 1);
        used[i] = false;
    }
}
```

**组合框架**（有 `start`，保证不重复选择）：

```java
void backtrack(int[] candidates, int start, int target, int sum, List<Integer> path, ...) {
    if (sum == target) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = start; i < candidates.length; i++) {  // 从 start 开始，不往回选
        if (candidates[i] > target - sum) break;  // 剪枝（排序后有效）
        path.add(candidates[i]);
        backtrack(candidates, i, target, sum + candidates[i], path, ...);  // i（可重复）或 i+1（不可重复）
        path.remove(path.size() - 1);
    }
}
```

`start` 参数保证了每次递归只从当前元素及之后的元素中选择，天然避免了顺序不同但元素相同的组合被重复计数。

---

## 第 2 章 LeetCode 39：Combination Sum（可重复选）

### 2.1 题目

**LeetCode 39 - Combination Sum**（中等）：

给你一个**无重复元素**的整数数组 `candidates` 和一个目标整数 `target`，找出 `candidates` 中可以使数字和为 `target` 的所有不同组合。`candidates` 中的数字可以**无限制重复**被选取。

```
输入：candidates = [2,3,6,7], target = 7
输出：[[2,2,3],[7]]

输入：candidates = [2,3,5], target = 8
输出：[[2,2,2,2],[2,3,3],[3,5]]
```

### 2.2 搜索树分析

以 `candidates = [2, 3, 6, 7]`, `target = 7` 为例，搜索树（局部）：

```
                   []
        /         /        \         \
      [2]        [3]       [6]       [7]
    / | \ \      /  \
  [2,2][2,3][2,6][2,7] [3,3][3,6]
  /|\ ...
[2,2,2][2,2,3]...
 /\
[2,2,2,2→8>7剪枝]
[2,2,3→7=7 收集!]
```

**关键设计**：`backtrack` 递归时传 `i`（而非 `i+1`），允许当前元素被再次选择（对应"无限制重复"）。

### 2.3 完整实现

```java
public List<List<Integer>> combinationSum(int[] candidates, int target) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(candidates);  // 排序，启用剪枝
    backtrack(candidates, 0, target, 0, new LinkedList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int start, int target, int sum,
                        LinkedList<Integer> path, List<List<Integer>> result) {
    if (sum == target) {
        result.add(new ArrayList<>(path));  // 深拷贝！
        return;
    }
    for (int i = start; i < candidates.length; i++) {
        // 剪枝：candidates 已排序，当前元素超目标，后续更大，直接 break
        if (sum + candidates[i] > target) break;

        path.addLast(candidates[i]);
        // 传 i 而非 i+1：允许重复选当前元素
        backtrack(candidates, i, target, sum + candidates[i], path, result);
        path.removeLast();  // 回溯
    }
}
```

### 2.4 逐步追踪

`candidates = [2,3,6,7]`, `target = 7`：

```
backtrack(start=0, sum=0, path=[])
  i=0: path=[2], backtrack(start=0, sum=2, ...)
    i=0: path=[2,2], backtrack(start=0, sum=4, ...)
      i=0: path=[2,2,2], backtrack(start=0, sum=6, ...)
        i=0: path=[2,2,2,2], sum=8>7, break
        i=1: path=[2,2,2,3], sum=9>7, break
      i=1: path=[2,2,3], sum=7==target → 收集 [2,2,3]！
      i=2: 6>7-4=3, break
    i=1: path=[2,3], backtrack(start=1, sum=5, ...)
      i=1: path=[2,3,3], sum=8>7, break
      i=2: 6>7-5=2, break
    i=2: 6>7-2=5, break
  i=1: path=[3], backtrack(start=1, sum=3, ...)
    i=1: path=[3,3], sum=6
      i=1: path=[3,3,3], sum=9>7, break
      i=2: 6>7-6=1, break
    i=2: path=[3,6], sum=9>7, break
  i=2: 6>7-0=7? No, sum=6
    ...（最终没有凑出7）
  i=3: path=[7], sum=7==target → 收集 [7]！

最终结果：[[2,2,3],[7]]
```

---

## 第 3 章 LeetCode 40：Combination Sum II（有重复元素，每个只用一次）

### 3.1 题目

**LeetCode 40 - Combination Sum II**（中等）：

给定候选数组 `candidates` 和目标数 `target`，找出 `candidates` 中所有可以使数字和为 `target` 的组合。`candidates` 中的每个数字在每个组合中**只能使用一次**，且数组中**可能有重复元素**，结果中不能有重复组合。

```
输入：candidates = [10,1,2,7,6,1,5], target = 8
输出：[[1,1,6],[1,2,5],[1,7],[2,6]]

输入：candidates = [2,5,2,1,2], target = 5
输出：[[1,2,2],[5]]
```

### 3.2 与 Combination Sum I 的两个区别

| 维度 | Combination Sum I | Combination Sum II |
|------|------------------|--------------------|
| 候选数组是否有重复 | 无重复 | 有重复 |
| 每个元素可否多次使用 | 可以 | 只能用一次 |
| 递归时 start 传值 | 传 `i`（允许重选当前） | 传 `i+1`（每个只用一次） |
| 去重逻辑 | 不需要（无重复元素） | 需要（相同元素只选一次） |

### 3.3 去重的核心难点：为什么是 `i > start` 而非 `i > 0`

先排序，使相同元素相邻：`candidates = [1, 1, 2, 5, 6, 7, 10]`，`target = 8`

搜索树（关注重复的 `1`）：

```
                        []
             /          |           \    ...
           [1]         [1]          [2]  ...
       （第1个1）   （第2个1）
```

两个 `1` 选一个作为路径第一步，产生了重复。去重逻辑的目标：**在同一层（同一个 `start`）中，相同的值只允许第一次出现时进入搜索，后续相同值跳过**。

```java
for (int i = start; i < candidates.length; i++) {
    // 去重：在同一层递归中，跳过相同的值（除了第一个）
    if (i > start && candidates[i] == candidates[i - 1]) continue;
    // ...
}
```

**为什么是 `i > start` 而非 `i > 0`？**

考虑路径 `[1, ...]`，当我们在第一个 `1` 之后递归，进入 `backtrack(start=1, ...)`，此时 `start=1`，可以选第二个 `1`（`candidates[1] = 1`）：

```
i=1（第二个1），i > start(=1) 是 false，不跳过 → 允许选第二个1，得到 [1,1,...]
```

这是正确的——`[1, 1, ...]` 是合法组合（两个不同的 `1`），不是重复。

而如果用 `i > 0`：

```
i=1（第二个1），i > 0 是 true，且 candidates[1] == candidates[0]，跳过 → [1,1,...] 被丢弃！
```

这就**漏掉**了包含两个 `1` 的合法组合。

**关键直觉**：`i > start` 的含义是"在当前这一层（从 `start` 开始），跳过重复值"，而不是"全局跳过重复值"。不同层（不同的 `start`）对重复元素的处理是独立的。

### 3.4 完整实现

```java
public List<List<Integer>> combinationSum2(int[] candidates, int target) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(candidates);  // 排序是去重的前提
    backtrack(candidates, 0, target, 0, new LinkedList<>(), result);
    return result;
}

private void backtrack(int[] candidates, int start, int target, int sum,
                        LinkedList<Integer> path, List<List<Integer>> result) {
    if (sum == target) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = start; i < candidates.length; i++) {
        if (sum + candidates[i] > target) break;  // 剪枝（排序保证有效）

        // 去重：同层内跳过重复值
        if (i > start && candidates[i] == candidates[i - 1]) continue;

        path.addLast(candidates[i]);
        backtrack(candidates, i + 1, target, sum + candidates[i], path, result);  // i+1，每个只用一次
        path.removeLast();
    }
}
```

### 3.5 搜索树对比：去重前 vs 去重后

`candidates = [1, 1, 2, 5, 6, 7, 10]`, `target = 8`

**去重前（错误，会有重复结果）**：

```
layer0:
  选第1个1 → [1, ...]
  选第2个1 → [1, ...]  ← 重复！两条路径产生的结果集合相同
  选2 → [2, ...]
  ...
```

**去重后（`i > start && candidates[i] == candidates[i-1]`）**：

```
layer0 (start=0):
  i=0: 选第1个1（candidates[0]=1）→ [1, ...]
  i=1: i>start(0), candidates[1]==candidates[0]，skip 第2个1 → 跳过
  i=2: 选2 → [2, ...]
  ...

layer1 (start=1, 已选了第1个1):
  i=1: 选第2个1（candidates[1]=1）→ [1,1, ...]  ← 正确！这是第二层选第2个1
  i=2: 选2 → [1,2, ...]
  ...
```

结果：`[[1,1,6],[1,2,5],[1,7],[2,6]]`，无重复。

---

## 第 4 章 Combination Sum III（进阶变体）

### 4.1 题目

**LeetCode 216 - Combination Sum III**（中等）：

找出所有相加之和为 `n` 的 `k` 个数的组合，且满足：只使用数字 `1-9`，每个数字最多使用一次，返回所有可能的有效组合的列表。

```
输入：k=3, n=7
输出：[[1,2,4]]

输入：k=3, n=9
输出：[[1,2,6],[1,3,5],[2,3,4]]
```

### 4.2 实现

```java
public List<List<Integer>> combinationSum3(int k, int n) {
    List<List<Integer>> result = new ArrayList<>();
    backtrack(1, k, n, 0, new LinkedList<>(), result);
    return result;
}

private void backtrack(int start, int k, int target, int sum,
                        LinkedList<Integer> path, List<List<Integer>> result) {
    // 剪枝：已选 k 个或和已达目标，检查是否同时满足
    if (path.size() == k) {
        if (sum == target) result.add(new ArrayList<>(path));
        return;
    }
    // 剪枝：剩余需要的数字数量不够填满
    int remaining = k - path.size();
    for (int i = start; i <= 9; i++) {
        if (sum + i > target) break;  // 超目标
        if (9 - i + 1 < remaining) break;  // 剩余数字不够选（比如 start=8，还需选2个，但只剩8,9两个）
        path.addLast(i);
        backtrack(i + 1, k, target, sum + i, path, result);
        path.removeLast();
    }
}
```

**额外剪枝**：`9 - i + 1 < remaining`——从 `i` 到 `9` 的数字数量（`9 - i + 1`）小于还需选的数量（`remaining`），当前分支不可能凑够 `k` 个数，提前剪枝。

---

## 第 5 章 面试常见追问与思维扩展

### 5.1 如何判断一道题是 Combination Sum 的变体

Combination Sum 的变体题通常有以下特征：

1. **选出若干数，使和等于目标值** → 组合求和
2. **每个数可重复使用 vs 只能使用一次** → 递归传 `i` vs 传 `i+1`
3. **输入有无重复元素** → 是否需要 `i > start` 去重
4. **选几个数有限制（如 k 个）** → 增加 `path.size() == k` 的终止条件

### 5.2 Subset（子集）问题的关系

子集是组合的超集——对于 `[1,2,3]`，子集包括所有长度（0、1、2、3）的组合。

```java
void backtrack(int[] nums, int start, List<Integer> path, ...) {
    result.add(new ArrayList<>(path));  // 每个节点都是答案（不只是叶节点）
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        backtrack(nums, i + 1, path, ...);
        path.remove(path.size() - 1);
    }
}
```

Subsets II（有重复元素）同样需要排序 + `i > start` 去重，与 Combination Sum II 的去重逻辑完全相同。

### 5.3 复杂度分析：组合与子集

| 问题 | 答案数量 | 时间复杂度 |
|------|---------|-----------|
| Combination Sum I（无限重复） | 最坏 $O(n^{T/M})$（$T$=target，$M$=最小元素） | 难以精确，见分析 |
| Combination Sum II | $O(2^n)$ 子集数 | $O(k \cdot 2^n)$ |
| Subsets（无重复） | $2^n$ | $O(n \cdot 2^n)$ |

对于 Combination Sum I，准确的复杂度分析需要用搜索树的高度 $T/M$（最多选 $T/M$ 个最小元素）和每层的分支数（最多 $n$ 个）来估算：约 $O(n^{T/M})$。

---

## 第 6 章 完整代码汇总与面试注意事项

### 6.1 Combination Sum I（可重复）

```java
class Solution {
    public List<List<Integer>> combinationSum(int[] candidates, int target) {
        List<List<Integer>> res = new ArrayList<>();
        Arrays.sort(candidates);
        backtrack(candidates, 0, target, 0, new LinkedList<>(), res);
        return res;
    }

    private void backtrack(int[] c, int start, int target, int sum,
                            LinkedList<Integer> path, List<List<Integer>> res) {
        if (sum == target) { res.add(new ArrayList<>(path)); return; }
        for (int i = start; i < c.length; i++) {
            if (sum + c[i] > target) break;
            path.addLast(c[i]);
            backtrack(c, i, target, sum + c[i], path, res);  // i，可重复
            path.removeLast();
        }
    }
}
```

### 6.2 Combination Sum II（每个只用一次，有重复）

```java
class Solution {
    public List<List<Integer>> combinationSum2(int[] candidates, int target) {
        List<List<Integer>> res = new ArrayList<>();
        Arrays.sort(candidates);
        backtrack(candidates, 0, target, 0, new LinkedList<>(), res);
        return res;
    }

    private void backtrack(int[] c, int start, int target, int sum,
                            LinkedList<Integer> path, List<List<Integer>> res) {
        if (sum == target) { res.add(new ArrayList<>(path)); return; }
        for (int i = start; i < c.length; i++) {
            if (sum + c[i] > target) break;
            if (i > start && c[i] == c[i - 1]) continue;  // 去重：同层跳过重复
            path.addLast(c[i]);
            backtrack(c, i + 1, target, sum + c[i], path, res);  // i+1，每个只用一次
            path.removeLast();
        }
    }
}
```

> [!warning] 生产避坑：排序 + i > start 缺一不可
> 如果忘记 `Arrays.sort(candidates)`，`candidates[i] == candidates[i-1]` 这个判断无法正确工作——相同元素可能不相邻，去重会漏掉或过度剪枝。排序是去重逻辑的**前提条件**，不是可选的优化。

---

## 本章小结

Combination Sum 系列的三个关键设计决策：

1. **`start` 参数**：决定"组合"语义，防止 `[1,2]` 和 `[2,1]` 被重复计数
2. **`i` vs `i+1`**：决定元素是否可重复使用
3. **`i > start` 去重**：在有重复元素的候选数组中，跳过同层内已经探索过的相同值

这三个决策完全独立，可以任意组合，覆盖了所有"组合求和"类变体。面试中只要看清楚这三个维度，代码几乎可以直接写出来。

下一篇进入字符串型回溯，包括 Palindrome Partitioning（回文分割）、Generate Parentheses（括号生成）和 Restore IP Addresses（恢复 IP 地址）。

---

*关联文章：[[DFS 与回溯核心框架：状态树的系统性遍历]] | [[字符串型回溯：分割、括号与 IP 地址]]*
