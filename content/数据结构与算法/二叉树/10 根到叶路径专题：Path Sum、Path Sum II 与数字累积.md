---
title: "根到叶路径专题：Path Sum、Path Sum II 与数字累积"
date: 2026-04-27
tags: [数据结构, 算法, 二叉树, 路径总和, DFS, 回溯, LeetCode]
aliases: [LC112, LC113, LC129, 根到叶路径专题：Path Sum、Path Sum II 与数字累积]
---

# 根到叶路径专题：Path Sum、Path Sum II 与数字累积

## 摘要

从根走到叶是二叉树里最常见的一类路径模型。LeetCode 112、113、129 看起来分别在问“是否存在一条路径”“找出所有路径”“把路径数字拼起来求和”，本质上都是同一个 DFS 框架：沿路径向下携带状态，在叶子节点做结算。真正的区别不在遍历，而在于状态携带什么、叶子处如何判定、回溯时是否需要撤销现场。本文会把三道题放在一个统一模板下讲透。

---

## 第 1 章 根到叶路径题的统一模型

每走到一个节点，你都要回答三件事：

1. 当前路径累计状态是什么
2. 什么时候算到达一条完整路径
3. 到达叶子后如何把结果写入答案

因此这类题天然适合前序 DFS：先处理当前节点，把新状态带给孩子，再在回溯时恢复现场。

---

## 第 2 章 LeetCode 112：Path Sum

### 2.1 题目本质

判断是否存在一条从根到叶的路径，使路径和等于目标值。关键在于两点：

- 必须到叶子节点才算完整路径
- 中间节点部分和相等不算答案

### 2.2 代码实现

```java
public boolean hasPathSum(TreeNode root, int targetSum) {
    if (root == null) {
        return false;
    }
    if (root.left == null && root.right == null) {
        return targetSum == root.val;
    }
    int remain = targetSum - root.val;
    return hasPathSum(root.left, remain) || hasPathSum(root.right, remain);
}
```

这个写法很漂亮，因为把“累计和”换成了“剩余目标值”。当前节点消耗掉自己的值，问题自然缩小到子树。

---

## 第 3 章 LeetCode 113：Path Sum II

### 3.1 从判断存在到收集所有路径

当题目要求返回所有合法路径时，DFS 模板不变，但要额外维护：

- 当前路径 `path`
- 最终答案 `result`

### 3.2 回溯写法

```java
public List<List<Integer>> pathSum(TreeNode root, int targetSum) {
    List<List<Integer>> result = new ArrayList<>();
    List<Integer> path = new ArrayList<>();
    dfs(root, targetSum, path, result);
    return result;
}

private void dfs(TreeNode node, int remain,
                 List<Integer> path, List<List<Integer>> result) {
    if (node == null) {
        return;
    }

    path.add(node.val);
    remain -= node.val;

    if (node.left == null && node.right == null && remain == 0) {
        result.add(new ArrayList<>(path));
    } else {
        dfs(node.left, remain, path, result);
        dfs(node.right, remain, path, result);
    }

    path.remove(path.size() - 1);
}
```

### 3.3 为什么必须复制路径

`path` 是一个会继续变化的共享列表。如果直接把它放进 `result`，后续回溯会把已经保存的答案也一并改掉。必须在命中答案时 `new ArrayList<>(path)` 做快照。

---

## 第 4 章 LeetCode 129：Sum Root to Leaf Numbers

### 4.1 状态从“求和”变成“数字拼接”

路径 `1 -> 2 -> 3` 不再表示和为 `6`，而是数字 `123`。这意味着状态转移不再是简单加法，而是十进制扩展：

```text
current = previous * 10 + node.val
```

### 4.2 代码实现

```java
public int sumNumbers(TreeNode root) {
    return dfs(root, 0);
}

private int dfs(TreeNode node, int current) {
    if (node == null) {
        return 0;
    }

    current = current * 10 + node.val;
    if (node.left == null && node.right == null) {
        return current;
    }

    return dfs(node.left, current) + dfs(node.right, current);
}
```

这里甚至不需要显式回溯，因为 `current` 是值传递参数，每层递归都有自己的副本。

---

## 第 5 章 三道题的统一模板

| 题目 | 沿途状态 | 叶子处动作 | 是否需要回溯 |
|------|----------|------------|--------------|
| LC112 | 剩余目标值 | 判断是否为 0 | 不需要显式路径 |
| LC113 | 剩余目标值 + 路径列表 | 保存一条路径 | 需要 |
| LC129 | 当前拼接数字 | 返回当前数字 | 参数值传递即可 |

可以看到，遍历结构几乎不变，变的是“状态对象”和“叶子结算逻辑”。

> [!info] 路径题的统一口述方式
> 面试时可以先说：这是一道根到叶 DFS 题，我会沿递归参数向下携带当前路径状态，在叶子节点判断是否命中条件，再根据题目要求选择返回布尔值、收集路径或累加数字。

---

## 下一篇预告

[[11 树形 DP 进阶：二叉树中的最大路径和]] 是本专栏的收束篇。它会把树题推进到更高抽象层：区分“对父节点的最大贡献”和“当前节点处闭合路径的全局最优”。