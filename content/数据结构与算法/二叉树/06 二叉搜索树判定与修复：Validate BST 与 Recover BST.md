---
title: "二叉搜索树判定与修复：Validate BST 与 Recover BST"
date: 2026-04-27
tags: [数据结构, 算法, 二叉树, 二叉搜索树, 中序遍历, LeetCode]
aliases: [Validate BST, Recover BST, LC98, LC99]
---

# 二叉搜索树判定与修复：Validate BST 与 Recover BST

## 摘要

[[二叉搜索树]] 是二叉树专题里最重要的特殊结构，因为它提供了一个极强的约束：中序遍历结果必须严格递增。LeetCode 98 和 99 看似一个是合法性判断，一个是错误修复，底层依赖却完全相同。本文会重点讲清楚为什么“只比较父子大小”是错误的局部视角，为什么 Validate BST 需要全局上下界，为什么 Recover BST 可以通过中序中的逆序对定位错误节点。

---

## 第 1 章 LeetCode 98：为什么局部判断不够

### 1.1 常见错误思路

很多人会写：

```java
root.left.val < root.val < root.right.val
```

然后递归检查左右子树。这是不够的，因为 BST 约束不是“父子之间”而是“整个左子树都小于根，整个右子树都大于根”。

反例：

```text
    5
   / \
  1   6
     / \
    3   7
```

节点 `3 < 6` 没问题，但它位于根 `5` 的右子树里，因此必须大于 `5`，这棵树其实非法。

### 1.2 正确思路一：上下界递归

```java
public boolean isValidBST(TreeNode root) {
    return validate(root, Long.MIN_VALUE, Long.MAX_VALUE);
}

private boolean validate(TreeNode node, long lower, long upper) {
    if (node == null) {
        return true;
    }
    if (node.val <= lower || node.val >= upper) {
        return false;
    }
    return validate(node.left, lower, node.val)
        && validate(node.right, node.val, upper);
}
```

这里传递的不是当前父节点值，而是当前节点允许落入的合法区间。这个区间是由所有祖先共同约束出来的。

### 1.3 正确思路二：中序递增检查

因为 BST 中序严格递增，所以也可以在中序遍历中检查前一个节点值是否始终小于当前节点值。

```java
private Long prev = null;

public boolean isValidBST(TreeNode root) {
    if (root == null) {
        return true;
    }
    if (!isValidBST(root.left)) {
        return false;
    }
    if (prev != null && root.val <= prev) {
        return false;
    }
    prev = (long) root.val;
    return isValidBST(root.right);
}
```

这两种方法本质一致：一个显式传合法区间，一个隐式利用中序全局顺序。

---

## 第 2 章 LeetCode 99：Recover BST

### 2.1 题目本质

一棵 BST 有两个节点被错误交换，要求不改变结构，把它恢复回来。

如果把 BST 做中序遍历，原本应是严格递增序列。两个节点交换后，递增序列会出现逆序。

### 2.2 两种交换场景

假设原序列是：

```text
1, 2, 3, 4, 5
```

如果交换相邻元素 `2` 和 `3`：

```text
1, 3, 2, 4, 5
```

只会出现一次逆序。

如果交换不相邻元素 `2` 和 `5`：

```text
1, 5, 3, 4, 2
```

会出现两次逆序。

因此，在中序遍历过程中：

- 第一次看到 `prev.val > current.val` 时，记录 `first = prev`
- 每次看到逆序时，都更新 `second = current`

最后交换 `first` 和 `second` 即可。

### 2.3 代码实现

```java
private TreeNode first;
private TreeNode second;
private TreeNode prev;

public void recoverTree(TreeNode root) {
    inorder(root);
    int temp = first.val;
    first.val = second.val;
    second.val = temp;
}

private void inorder(TreeNode node) {
    if (node == null) {
        return;
    }
    inorder(node.left);

    if (prev != null && prev.val > node.val) {
        if (first == null) {
            first = prev;
        }
        second = node;
    }
    prev = node;

    inorder(node.right);
}
```

### 2.4 为什么第二个节点要持续更新

因为非相邻交换时会出现两次逆序：

- 第一次逆序里的较大值才是真正错位的前一个节点
- 第二次逆序里的较小值才是真正错位的后一个节点

所以 `first` 只在第一次设定，`second` 则需要每次逆序都更新。

---

## 第 3 章 中序有序性质到底强在哪里

中序有序把树问题降成了序列问题：

- Validate BST 变成“序列是否严格递增”
- Recover BST 变成“递增序列中找被交换的两个元素”

这说明搜索树题很多时候不需要硬想树形结构，而是先问：**能不能把它投影成一个有序序列问题。**

> [!note] BST 的价值不只是查找快
> 在算法题里，更重要的是它把树的结构约束转成了顺序约束，这让很多题一下子从结构题变成了序列题。

---

## 下一篇预告

[[07 二叉搜索树的数量与生成：Unique BST I/II]] 会继续留在 BST 专题，不过从“验证已有结构”切到“枚举所有可能结构”。这一篇会正式引入 Catalan 数与分治生成。