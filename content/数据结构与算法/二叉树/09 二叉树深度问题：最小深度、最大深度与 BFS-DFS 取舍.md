---
title: "二叉树深度问题：最小深度、最大深度与 BFS/DFS 取舍"
date: 2026-04-27
tags: [数据结构, 算法, 二叉树, 最小深度, 最大深度, BFS, DFS, LeetCode]
aliases: [LC111, LC104, 二叉树深度问题：最小深度、最大深度与 BFS/DFS 取舍]
---

# 二叉树深度问题：最小深度、最大深度与 BFS/DFS 取舍

## 摘要

二叉树深度题经常被误判为“最简单的一类树题”，因为代码看起来短。但 LeetCode 111 和 104 恰好说明，树题最危险的地方往往在定义细节。最大深度几乎是 DFS 入门题，最小深度却有一个非常经典的陷阱：当一边为空时，不能直接取 `min(left, right)`。本文会把最大深度、最小深度、BFS 提前返回和 DFS 递归定义放在一起，讲清楚“深度”这个概念到底在描述什么。

---

## 第 1 章 深度到底是什么意思

对一个节点来说：

- 深度：从根到该节点经历了多少条边或多少层
- 高度：从该节点到最远叶子节点的路径长度

在 LeetCode 104/111 里，我们通常说“树的最大深度”或“最小深度”，其实更接近“根节点这棵树的高度”，只是题目沿用了 depth 的说法。

### 1.1 最大深度为什么天然适合 DFS

因为“当前树的最大深度”可以直接定义为：

```text
maxDepth(root) = max(maxDepth(root.left), maxDepth(root.right)) + 1
```

这是标准的后序递归定义。

---

## 第 2 章 LeetCode 104：Maximum Depth of Binary Tree

```java
public int maxDepth(TreeNode root) {
    if (root == null) {
        return 0;
    }
    return Math.max(maxDepth(root.left), maxDepth(root.right)) + 1;
}
```

这道题几乎是树形递归最纯粹的形式：

- 空树深度为 0
- 非空树深度 = 左右子树最大深度较大者 + 当前层

它之所以简单，是因为“最大值”允许一边为空时自然被另一边覆盖，不会引入定义歧义。

---

## 第 3 章 LeetCode 111：Minimum Depth of Binary Tree

### 3.1 为什么不能直接套最小值模板

很多人会写：

```java
return Math.min(minDepth(root.left), minDepth(root.right)) + 1;
```

这是错的。考虑下面这棵树：

```text
    1
   /
  2
```

如果右子树为空，`minDepth(root.right) = 0`，那么上式会得到 `1`，但正确答案应是 `2`。原因在于：**最小深度定义的是从根到最近叶子节点的路径长度，空子树不是一条合法路径。**

### 3.2 正确 DFS 写法

```java
public int minDepth(TreeNode root) {
    if (root == null) {
        return 0;
    }
    if (root.left == null && root.right == null) {
        return 1;
    }
    if (root.left == null) {
        return minDepth(root.right) + 1;
    }
    if (root.right == null) {
        return minDepth(root.left) + 1;
    }
    return Math.min(minDepth(root.left), minDepth(root.right)) + 1;
}
```

这里要显式区分：

- 两边都存在，才能取 `min`
- 只有一边存在，就只能沿那一边继续走

### 3.3 BFS 为什么对最小深度更自然

因为最小深度问的是“最近叶子”，而 BFS 正是按层推进。第一次碰到叶子节点时，当前层数就是答案。

```java
public int minDepth(TreeNode root) {
    if (root == null) {
        return 0;
    }

    Queue<TreeNode> queue = new LinkedList<>();
    queue.offer(root);
    int depth = 1;

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            TreeNode node = queue.poll();
            if (node.left == null && node.right == null) {
                return depth;
            }
            if (node.left != null) queue.offer(node.left);
            if (node.right != null) queue.offer(node.right);
        }
        depth++;
    }
    return depth;
}
```

这就是 BFS 在“最近、最短、最先到达”类问题里的天然优势。

---

## 第 4 章 BFS 与 DFS 怎么选

| 问题 | 更自然的方法 | 原因 |
|------|--------------|------|
| 最大深度 | DFS | 递归定义直接成立 |
| 最小深度 | BFS 或 DFS | BFS 可首次遇叶即返回，DFS 需额外判空分支 |

### 4.1 不要把 BFS/DFS 之争理解成性能之争

对这两题来说，时间复杂度都能做到 $O(n)$。真正差别在于：

- 哪种方法更贴合题目定义
- 哪种方法更不容易写错边界

对最大深度，DFS 更简洁。对最小深度，BFS 更直观。

---

## 下一篇预告

[[10 根到叶路径专题：Path Sum、Path Sum II 与数字累积]] 会继续沿着“根到叶”这个方向推进，但重点从“路径长度”切到“路径状态”。你会看到，路径和、路径记录和路径数字累积，本质都是同一个 DFS 模板的不同输出。