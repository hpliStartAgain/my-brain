---
title: "二叉搜索树的数量与生成：Unique BST I/II"
date: 2026-04-27
tags: [LeetCode, 二叉搜索树, 分治, 动态规划, 数据结构, 算法]
aliases: [Unique BST, 不同的二叉搜索树, LC96, LC95, 二叉搜索树的数量与生成：Unique BST I/II]
---

# 二叉搜索树的数量与生成：Unique BST I/II

## 摘要

LeetCode 96 和 95 是一组非常经典的配套题：前者问有多少种不同的 BST，后者进一步要求把所有 BST 真正生成出来。它们表面一个是 DP，一个是分治，底层却共享同一套选择根节点的思维方式。本文会讲清楚为什么每个值都能被视为根、为什么左右子树方案数可以相乘，以及为什么“计数”和“生成”其实只是同一个递归框架的两种输出模式。

---

## 第 1 章 LeetCode 96：不同 BST 的数量

### 1.1 选根是第一原则

对区间 `1..n`，如果选择 `i` 作为根：

- 左子树只能用 `1..i-1`
- 右子树只能用 `i+1..n`

左右子树彼此独立，因此：

```text
以 i 为根的 BST 数量 = 左子树方案数 × 右子树方案数
```

总方案数就是对所有根求和。

### 1.2 动态规划写法

设 `dp[len]` 表示由 `len` 个连续有序节点构成的 BST 数量。

```java
public int numTrees(int n) {
    int[] dp = new int[n + 1];
    dp[0] = 1;
    dp[1] = 1;

    for (int len = 2; len <= n; len++) {
        for (int root = 1; root <= len; root++) {
            int leftSize = root - 1;
            int rightSize = len - root;
            dp[len] += dp[leftSize] * dp[rightSize];
        }
    }
    return dp[n];
}
```

`dp[0] = 1` 很关键，它表示空树也算一种合法结构，否则乘法组合会失真。

### 1.3 Catalan 数视角

这道题本质上是 Catalan 数：

$$
G(n) = \sum_{i=1}^{n} G(i-1) \cdot G(n-i)
$$

在算法题里，知道它是 Catalan 数有帮助，但更重要的是能从“选根 + 左右独立”推导出这个递推式。

---

## 第 2 章 LeetCode 95：生成所有 BST

### 2.1 从计数切到生成

既然每个根都可以枚举，那生成题就自然是：

1. 枚举根值 `i`
2. 递归生成所有左子树列表
3. 递归生成所有右子树列表
4. 两两组合，挂到根节点上

### 2.2 代码实现

```java
public List<TreeNode> generateTrees(int n) {
    if (n == 0) {
        return new ArrayList<>();
    }
    return build(1, n);
}

private List<TreeNode> build(int start, int end) {
    List<TreeNode> result = new ArrayList<>();
    if (start > end) {
        result.add(null);
        return result;
    }

    for (int rootVal = start; rootVal <= end; rootVal++) {
        List<TreeNode> leftTrees = build(start, rootVal - 1);
        List<TreeNode> rightTrees = build(rootVal + 1, end);

        for (TreeNode left : leftTrees) {
            for (TreeNode right : rightTrees) {
                TreeNode root = new TreeNode(rootVal);
                root.left = left;
                root.right = right;
                result.add(root);
            }
        }
    }
    return result;
}
```

### 2.3 为什么空树也要放进列表

如果 `start > end` 时返回空列表，父层在做双重循环组合时就会完全失去一侧为空的结构。正确做法是返回一个只含 `null` 的列表，代表“这一边没有子树，但这是一种有效选择”。

---

## 第 3 章 两道题的统一框架

| 题目 | 根的选择 | 左右子问题 | 输出 |
|------|----------|------------|------|
| LC96 | 枚举每个根 | 只关心左右子树数量 | 一个整数 |
| LC95 | 枚举每个根 | 需要拿到左右子树具体结构 | 一组树 |

这说明“计数”和“生成”只是递归输出形式不同，核心拆分逻辑并没有变。

### 3.1 为什么这是一类很好的面试题

因为它不仅考 BST，还考：

- 你是否能识别子问题独立性
- 你是否会把“总数”拆成“分类求和”
- 你是否理解空结构在组合问题里的合法性

---

## 下一篇预告

[[08 有序序列转平衡搜索树：数组与链表两种输入]] 会继续留在构造专题，不过这次输入不是遍历数组，而是一个有序序列。重点会转到“如何保证平衡”以及“链表不支持随机访问时怎么办”。