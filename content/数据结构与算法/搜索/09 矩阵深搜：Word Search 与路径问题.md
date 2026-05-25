---
title: "矩阵深搜：Word Search、路径问题与 Trie 优化"
date: 2026-04-28
tags: [DFS, LeetCode, Trie, Word Search, 矩阵搜索, 算法, 路径问题, 面试]
aliases: [Word Search, Word Search II, Trie剪枝, 矩阵路径DFS, LeetCode 79, LeetCode 212]
---

# 矩阵深搜：Word Search、路径问题与 Trie 优化

## 摘要

Word Search 是矩阵 DFS 与回溯思想的完美结合——不只是"标记区域"，而是"在矩阵上沿路径匹配字符串"。本文从 Word Search I（LeetCode 79）的基础实现出发，深入分析与"Flood Fill 型 DFS"的关键差异（visited 不能原地修改，必须支持撤销），再进入 Word Search II（LeetCode 212），展示如何用 Trie 树将多词搜索从暴力的 $O(mn \cdot k \cdot 4^L)$ 优化到 $O(mn \cdot 4^L)$（其中 $k$ 为单词数，$L$ 为单词长度）。最后结合 Unique Paths 展示搜索与动态规划的对比与互换。

---

## 第 1 章 Word Search vs Flood Fill：两类矩阵 DFS 的差异

### 1.1 Flood Fill：标记，不需要撤销

在 Number of Islands 中，DFS 将整个连通分量的格子都标记为 `'0'`（沉入水中），搜索完成后不需要"恢复"——因为目的就是永久标记。

```java
void dfs(char[][] grid, int i, int j) {
    if (...条件...) return;
    grid[i][j] = '0';  // 永久修改
    dfs(grid, i+1, j);
    dfs(grid, i-1, j);
    ...
    // 没有 grid[i][j] = '1' 的恢复！
}
```

### 1.2 Word Search：路径匹配，必须撤销

在 Word Search 中，DFS 沿路径匹配单词字母：格子 `(i,j)` 在当前匹配路径中被"借用"，匹配完当前路径后，这个格子需要还给其他路径使用。

```java
void dfs(char[][] board, int i, int j, String word, int k) {
    if (...条件...) return;
    char temp = board[i][j];
    board[i][j] = '#';  // 临时标记（当前路径占用）
    dfs(board, i+1, j, word, k+1);
    dfs(board, i-1, j, word, k+1);
    ...
    board[i][j] = temp;  // 必须恢复！允许其他路径使用
}
```

**这是 Word Search 与 Flood Fill 的本质区别**：Flood Fill 是永久染色，Word Search 是临时借用 + 撤销（回溯）。

---

## 第 2 章 LeetCode 79：Word Search

### 2.1 题目

**LeetCode 79 - Word Search**（中等）：

给定一个 $m \times n$ 二维字符网格 `board` 和一个字符串 `word`。如果 `word` 存在于网格中，返回 `true`；否则，返回 `false`。单词必须按照字母顺序，通过相邻的单元格内的字母构成，其中"相邻"单元格是那些水平相邻或垂直相邻的单元格。同一个单元格内的字母不允许被重复使用。

```
输入：board = [["A","B","C","E"],["S","F","C","S"],["A","D","E","E"]], word = "ABCCED"
输出：true

输入：board = [["A","B","C","E"],["S","F","C","S"],["A","D","E","E"]], word = "SEE"
输出：true

输入：board = [["A","B","C","E"],["S","F","C","S"],["A","D","E","E"]], word = "ABCB"
输出：false（B 不能被重复使用）
```

### 2.2 完整实现

```java
public boolean exist(char[][] board, String word) {
    int m = board.length, n = board[0].length;

    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            // 从每个格子出发，尝试匹配 word[0]
            if (board[i][j] == word.charAt(0) && dfs(board, i, j, word, 0)) {
                return true;
            }
        }
    }
    return false;
}

private boolean dfs(char[][] board, int i, int j, String word, int k) {
    // 结束条件：所有字母匹配完成
    if (k == word.length()) return true;

    // 边界检查
    int m = board.length, n = board[0].length;
    if (i < 0 || i >= m || j < 0 || j >= n) return false;

    // 当前格子不匹配，或已被占用
    if (board[i][j] != word.charAt(k)) return false;

    // 临时标记（借用）
    char temp = board[i][j];
    board[i][j] = '#';

    // 向四个方向递归
    boolean found = dfs(board, i+1, j, word, k+1)
                 || dfs(board, i-1, j, word, k+1)
                 || dfs(board, i, j+1, word, k+1)
                 || dfs(board, i, j-1, word, k+1);

    // 恢复（撤销标记）
    board[i][j] = temp;

    return found;
}
```

**短路求值优化**：`||` 的短路特性——一旦找到 `true`，立即停止，不继续探索其他方向。这使得在找到答案时，不会做多余的计算。

### 2.3 时间复杂度

- 外层循环：$O(mn)$ 个起点
- 每个起点的 DFS：最多展开 $4^L$ 个路径（$L$ = 单词长度），但因为格子不能重用，实际路径数远小于 $4^L$，更接近 $3^L$（每步除了来路，最多 3 个方向）
- **总时间复杂度**：$O(mn \cdot 3^L)$

**空间复杂度**：$O(L)$（递归栈深度），不需要额外的 visited 数组（原地标记）。

### 2.4 几个常见错误

**错误一：先修改格子值，再检查边界**

```java
// 错误！边界检查必须在修改格子之前
board[i][j] = '#';
if (i < 0 || ...) return false;  // 太晚了，board 已经被修改
```

正确顺序：先边界检查，再比较字符，再标记。

**错误二：忘记撤销 `board[i][j] = '#'`**

```java
board[i][j] = '#';
boolean found = dfs(...);
// 忘记 board[i][j] = temp;
return found;
```

不撤销会导致同一个格子在后续搜索中被视为已占用，产生 `false negative`（实际存在但返回 `false`）。

**错误三：`k == word.length()` 的检查时机**

```java
// 方式一：函数开头检查（推荐）
if (k == word.length()) return true;

// 方式二：在比较字符时检查 k == word.length()-1
if (board[i][j] == word.charAt(k)) {
    if (k == word.length() - 1) return true;  // 最后一个字符匹配
    ...
}
```

两种方式都正确，但方式一更简洁，且避免了 `charAt(k)` 越界（当 `k == word.length()` 时，方式二不做这个检查）。

---

## 第 3 章 LeetCode 212：Word Search II（Trie 优化）

### 3.1 题目

**LeetCode 212 - Word Search II**（困难）：

给定一个 $m \times n$ 二维字符网格 `board` 和一个单词（字符串）列表 `words`，返回所有同时在二维网格和字典中出现的单词。

```
输入：board = [["o","a","a","n"],["e","t","a","e"],["i","h","k","r"],["i","f","l","v"]]
     words = ["oath","pea","eat","rain"]
输出：["eat","oath"]
```

### 3.2 暴力方法的问题

**朴素方法**：对每个单词 `w` 调用 Word Search I 的解法，判断是否存在。

时间复杂度：$O(k \cdot mn \cdot 3^L)$，其中 $k$ = 单词数，$L$ = 最长单词长度。

当 $k = 10000$，$m = n = 12$，$L = 10$ 时：$10000 \times 144 \times 3^{10} \approx 8.5 \times 10^9$——明显超时。

**瓶颈在哪里？** 每次搜索一个单词，都要遍历整个矩阵并从每个格子出发 DFS。如果两个单词有相同前缀（如 "eat" 和 "eating"），在搜索 "eating" 时，搜索 "eat" 的前三步会重复做一遍。

### 3.3 Trie 的核心作用：共享前缀

**Trie（字典树/前缀树）** 将所有单词构建成一棵前缀共享树：

```
words = ["eat", "oath"]

Trie 结构：
root
├─ 'e' → TrieNode
│   └─ 'a' → TrieNode
│       └─ 't' → TrieNode (word = "eat")
└─ 'o' → TrieNode
    └─ 'a' → TrieNode
        └─ 't' → TrieNode
            └─ 'h' → TrieNode (word = "oath")
```

在矩阵上做一次 DFS 时，沿路径同时在 Trie 中移动。如果当前格子的字符在 Trie 中的当前节点没有对应子节点，说明以当前路径开头的单词都不存在，立即剪枝——不需要继续匹配任何单词。

**效果**：所有共享前缀的单词，在矩阵上只需要搜索一次对应的路径，而不是重复搜索 $k$ 次。

### 3.4 Trie 节点定义

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    String word = null;  // 不为 null 时，表示从根到这里构成一个完整单词
}
```

`word` 直接存储完整单词（而非只存布尔标记），这样找到单词时可以直接加入结果，不需要重新构建单词字符串。

### 3.5 完整实现

```java
class TrieNode {
    TrieNode[] children = new TrieNode[26];
    String word = null;
}

public List<String> findWords(char[][] board, String[] words) {
    // 构建 Trie
    TrieNode root = new TrieNode();
    for (String w : words) {
        TrieNode node = root;
        for (char c : w.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) {
                node.children[idx] = new TrieNode();
            }
            node = node.children[idx];
        }
        node.word = w;
    }

    int m = board.length, n = board[0].length;
    List<String> result = new ArrayList<>();

    // 从每个格子出发，同时遍历矩阵和 Trie
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            dfs(board, i, j, root, result);
        }
    }
    return result;
}

private void dfs(char[][] board, int i, int j, TrieNode node, List<String> result) {
    int m = board.length, n = board[0].length;
    if (i < 0 || i >= m || j < 0 || j >= n) return;
    char c = board[i][j];
    if (c == '#') return;  // 已被当前路径占用

    // Trie 剪枝：当前字符在 Trie 中无对应子节点
    int idx = c - 'a';
    TrieNode next = node.children[idx];
    if (next == null) return;  // 不存在以当前路径为前缀的单词，剪枝！

    // 找到单词
    if (next.word != null) {
        result.add(next.word);
        next.word = null;  // 避免重复加入（同一个单词可能从不同路径找到）
    }

    // 临时标记
    board[i][j] = '#';

    // 四方向递归
    dfs(board, i+1, j, next, result);
    dfs(board, i-1, j, next, result);
    dfs(board, i, j+1, next, result);
    dfs(board, i, j-1, next, result);

    // 恢复
    board[i][j] = c;
}
```

### 3.6 进一步优化：找到单词后删除 Trie 节点

当一个单词被找到并加入结果后，对应的 Trie 节点不需要再被匹配。可以将其从 Trie 中"剪掉"，减少后续搜索的无效分支：

```java
// 回溯时，如果某个节点的所有子节点都为空且没有 word，可以删除
private boolean dfs(...) {
    ...
    // 回溯阶段：检查是否可以删除当前节点
    if (isLeaf(next)) {
        node.children[idx] = null;  // 删除叶节点
    }
    ...
}

private boolean isLeaf(TrieNode node) {
    if (node.word != null) return false;
    for (TrieNode child : node.children) {
        if (child != null) return false;
    }
    return true;
}
```

这个优化在大量单词被找到后，能显著减少 Trie 的节点数，从而加速后续搜索。

### 3.7 时间复杂度对比

| 方法 | 时间复杂度 |
|------|-----------|
| 暴力（每词独立搜索） | $O(k \cdot mn \cdot 3^L)$ |
| Trie 优化 | $O(mn \cdot 3^L + \sum len(w))$（Trie 构建 + 一次 DFS） |

当 $k$ 很大时，Trie 方法将复杂度从线性于 $k$ 降为与 $k$ 无关（只多了 Trie 构建的 $O(\sum len(w))$）。

---

## 第 4 章 Unique Paths：搜索与动态规划的桥梁

### 4.1 LeetCode 62 - Unique Paths

**题目**（中等）：一个机器人位于一个 $m \times n$ 网格的左上角。机器人每次只能向下或向右移动一步。机器人试图到达网格的右下角。问总共有多少条不同的路径？

```
输入：m=3, n=7
输出：28

输入：m=3, n=2
输出：3
```

### 4.2 记忆化 DFS（搜索的视角）

从 $(0,0)$ 出发，每步选择向右或向下，统计到达 $(m-1, n-1)$ 的路径数。

```java
// 朴素 DFS（指数复杂度，会超时）
int dfs(int i, int j, int m, int n) {
    if (i == m-1 && j == n-1) return 1;
    if (i >= m || j >= n) return 0;
    return dfs(i+1, j, m, n) + dfs(i, j+1, m, n);
}
```

这个朴素 DFS 有大量重复计算——`dfs(i, j)` 会被调用多次。加入记忆化：

```java
int uniquePaths(int m, int n) {
    int[][] memo = new int[m][n];
    return dfs(0, 0, m, n, memo);
}

int dfs(int i, int j, int m, int n, int[][] memo) {
    if (i == m-1 && j == n-1) return 1;
    if (i >= m || j >= n) return 0;
    if (memo[i][j] != 0) return memo[i][j];  // 已计算过
    memo[i][j] = dfs(i+1, j, m, n, memo) + dfs(i, j+1, m, n, memo);
    return memo[i][j];
}
```

**时间复杂度**：$O(mn)$（每个格子只计算一次）。

### 4.3 等价的动态规划

记忆化 DFS 和 DP 在本题是**完全等价的**：

```java
// DP 版本（bottom-up）
int uniquePathsDP(int m, int n) {
    int[][] dp = new int[m][n];
    // 边界初始化
    for (int i = 0; i < m; i++) dp[i][0] = 1;
    for (int j = 0; j < n; j++) dp[0][j] = 1;
    // 状态转移
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            dp[i][j] = dp[i-1][j] + dp[i][j-1];
        }
    }
    return dp[m-1][n-1];
}
```

`dp[i][j]` 的含义与 `dfs(i, j, ...)` 的返回值完全相同：到达 $(i, j)$ 的路径数。区别只是计算顺序（自顶向下 vs 自底向上）。

> [!note] 设计哲学：记忆化 DFS = 带缓存的 DFS = DP
> 任何有重叠子问题的 DFS（递归），都可以通过"记忆化"转化为 DP，性能相同。选择哪种写法取决于个人习惯和面试官要求：有些面试官更欣赏 DP，因为它消除了递归栈的开销；有些面试官觉得记忆化 DFS 的逻辑更直观。两者都应该掌握。

### 4.4 Unique Paths II（有障碍物）

**LeetCode 63 - Unique Paths II**：同 Unique Paths，但障碍物格子 `obstacleGrid[i][j] = 1`，不能通过。

```java
int uniquePathsWithObstacles(int[][] obstacleGrid) {
    int m = obstacleGrid.length, n = obstacleGrid[0].length;
    if (obstacleGrid[0][0] == 1 || obstacleGrid[m-1][n-1] == 1) return 0;

    int[][] dp = new int[m][n];
    dp[0][0] = 1;
    // 第一列：遇到障碍后，后面的格子全为 0
    for (int i = 1; i < m; i++) dp[i][0] = obstacleGrid[i][0] == 1 ? 0 : dp[i-1][0];
    // 第一行
    for (int j = 1; j < n; j++) dp[0][j] = obstacleGrid[0][j] == 1 ? 0 : dp[0][j-1];
    // 状态转移
    for (int i = 1; i < m; i++) {
        for (int j = 1; j < n; j++) {
            if (obstacleGrid[i][j] == 1) dp[i][j] = 0;
            else dp[i][j] = dp[i-1][j] + dp[i][j-1];
        }
    }
    return dp[m-1][n-1];
}
```

---

## 第 5 章 矩阵路径问题模式总结

### 5.1 "找一条路径是否存在" vs "找所有路径" vs "计数路径"

| 问题类型 | 典型算法 | 典型题目 |
|---------|---------|---------|
| 路径是否存在（是/否） | DFS + 回溯 | Word Search (79) |
| 找所有路径（枚举） | DFS + 回溯（不剪找到即停） | — |
| 路径数量计数 | 记忆化 DFS / DP | Unique Paths (62/63) |
| 最短路径（无权） | BFS | 迷宫最短路 |
| 最短路径（有权） | Dijkstra | — |

### 5.2 Word Search 的扩展变体

**"不只找单个词，而是找多个词"** → Word Search II，使用 Trie 剪枝

**"单词可以任意拼接"** → 需要额外记录已使用格子集合，不能简单原地标记

**"允许重复使用格子"** → 去掉临时标记 `#` 的逻辑（但需要防止无限循环，通常用路径长度或其他条件终止）

### 5.3 不同 visited 机制的适用场景

| 机制 | 适用场景 | 示例 |
|------|---------|------|
| 原地标记（永久） | Flood Fill，不需要回溯 | Number of Islands |
| 原地标记（临时，带撤销） | 路径搜索，需要回溯 | Word Search |
| 独立 visited 数组 | 不能修改输入，或需要多次搜索 | 某些图搜索 |
| 无 visited | 特殊情况（如只向下/右移动，无环） | Unique Paths DFS |

---

## 第 6 章 面试代码汇总

### 6.1 Word Search I

```java
class Solution {
    public boolean exist(char[][] board, String word) {
        int m = board.length, n = board[0].length;
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++)
                if (dfs(board, i, j, word, 0)) return true;
        return false;
    }

    private boolean dfs(char[][] board, int i, int j, String word, int k) {
        if (k == word.length()) return true;
        int m = board.length, n = board[0].length;
        if (i < 0 || i >= m || j < 0 || j >= n || board[i][j] != word.charAt(k)) return false;
        char tmp = board[i][j]; board[i][j] = '#';
        boolean res = dfs(board, i+1, j, word, k+1) || dfs(board, i-1, j, word, k+1)
                   || dfs(board, i, j+1, word, k+1) || dfs(board, i, j-1, word, k+1);
        board[i][j] = tmp;
        return res;
    }
}
```

### 6.2 Word Search II 核心代码（见第 3 章，此处汇总关键点）

```
关键点：
1. 所有 words 构建一棵 Trie
2. 从每个格子出发，同时在矩阵和 Trie 上 DFS
3. Trie 节点为 null → 剪枝
4. Trie 节点有 word → 加入结果，将 word 置 null（去重）
5. 矩阵格子临时标记 '#'，回溯时恢复
```

---

## 本章小结

矩阵路径搜索的两道 Word Search 题，展示了 DFS 从"区域标记"（Flood Fill，不撤销）到"路径匹配"（回溯，必须撤销）的演进。Trie 的引入则是一个更大的优化思路：**当多个搜索目标共享前缀时，将目标预处理为前缀树，在搜索过程中同时推进，实现一次搜索覆盖所有目标**。

Unique Paths 补充了"路径计数"这类问题的解法，并展示了记忆化 DFS 与 DP 的等价性。

最后一篇文章将对整个搜索专栏做总结，梳理 BFS/DFS 的选型决策树、常见错误盘点，以及记忆化搜索与 DP 的关系。

---

*关联文章：[[棋盘型回溯：N-Queens 与数独求解]] | [[搜索算法面试通关：模式识别与优化策略总结]]*
