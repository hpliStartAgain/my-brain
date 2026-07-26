---
title: "DFS 与回溯核心框架：状态树的系统性遍历"
date: 2026-04-28
tags: [Backtracking, DFS, LeetCode, 回溯, 深度优先搜索, 算法, 面试]
aliases: [DFS回溯框架, 回溯算法模板, 状态树遍历, Backtracking]
---

# DFS 与回溯核心框架：状态树的系统性遍历

## 摘要

回溯（Backtracking）是面试中频率最高的算法专题之一，覆盖排列、组合、分割、棋盘等大类问题。但很多工程师背了大量例题却仍然在面试中写出 bug，原因在于没有建立一个**通用的思维框架**，遇到新题型不知道如何套用。本文从 DFS 的本质出发，推导出回溯算法的通用三要素，并以 Surrounded Regions（被围绕的区域）为具体例题，展示 DFS 在矩阵连通性问题上的应用。理解本文的框架，是攻克后续所有回溯专题文章的前提。

---

## 第 1 章 从 DFS 到回溯：一脉相承的思想

### 1.1 DFS 在树和图上的行为

对于一棵树，DFS 的行为是：从根节点出发，选一条边深入，到达叶节点后回到父节点，再选另一条边继续深入。这个"深入-回退"的过程，自然地遍历了树的所有节点。

```
        root
       /    \
      A      B
     / \      \
    C   D      E

DFS 顺序: root → A → C → (回退到A) → D → (回退到A) → (回退到root) → B → E
```

在图上，DFS 的行为类似，但需要 `visited` 集合防止重复访问形成环的情况。

### 1.2 回溯是 DFS 在"搜索树"上的专有名词

**回溯的核心**：搜索树不是预先给定的，而是由"可选的决策"动态构成的。每个节点代表"已做的一系列决策"，每条边代表"做了一个新的决策"，叶节点代表"所有决策已完成，形成一个完整方案"。

以求 `[1, 2, 3]` 的所有排列为例，搜索树如下：

```
                    []
           /        |        \
         [1]       [2]       [3]
        /   \     /   \     /   \
     [1,2] [1,3] [2,1] [2,3] [3,1] [3,2]
      |      |     |     |     |     |
  [1,2,3] [1,3,2][2,1,3][2,3,1][3,1,2][3,2,1]
```

叶节点（长度为 3 的路径）就是所有全排列。DFS 遍历这棵搜索树，就收集到了所有答案。

**"回溯"这个词的来源**：当一条路径探索完毕（到达叶节点），需要"回退"到上一个节点，再去探索另一个分支。"回退"时，要撤销刚才做的那个决策（把决策从路径中移除），这就是回溯（backtrack）。

---

## 第 2 章 回溯三要素：选择、路径、结束条件

### 2.1 通用框架

```python
result = []  # 存放所有答案

def backtrack(path, choices):
    """
    path:    已做的决策（当前路径）
    choices: 当前可以做的决策列表
    """
    # 1. 结束条件
    if 满足结束条件:
        result.append(path.copy())  # 记录答案（一定要 copy，不能存引用）
        return

    # 2. 枚举选择
    for choice in choices:
        # 3. 做选择（修改全局状态）
        path.append(choice)
        mark choice as used

        # 4. 递归（进入下一层搜索树）
        backtrack(path, new_choices)

        # 5. 撤销选择（恢复全局状态）
        path.pop()
        unmark choice
```

**三要素**：

1. **选择列表（Choices）**：每一步可以做哪些决策？不同题型的选择列表不同（从数组中选元素、从 26 个字母中选一个、在棋盘上放置棋子……）
2. **路径（Path）**：已经做了哪些决策？这是当前的"候选方案"。
3. **结束条件（Termination）**：什么时候停止递归，记录答案？（路径长度达到要求、找到了一个合法方案……）

**最关键的一点**：`path.copy()`。当满足结束条件时，必须对 `path` 做**深拷贝**再存入结果，不能存引用。因为后续回溯会修改 `path`，存引用会导致最终结果全部变成最后状态的 `path`。

> [!warning] 生产避坑：必须深拷贝
> `result.append(path)` 和 `result.append(path[:])` 的区别：前者存的是引用，后续回溯修改 `path` 时，之前存入 `result` 的"答案"也跟着改变；后者存的是独立副本，不受后续修改影响。Java 中对应 `new ArrayList<>(path)` 而不是直接 `path`。

### 2.2 为什么必须"撤销选择"

如果不撤销，比较以下两种情况：

```python
# 错误：不撤销
def backtrack(path, choices):
    if 结束条件:
        result.append(path.copy())
        return
    for choice in choices:
        path.append(choice)
        backtrack(path, new_choices)
        # 没有 path.pop()！

# 模拟：[1,2,3] 全排列
# 第一次到叶节点时 path = [1,2,3]，记录
# 回退到 path = [1,2,3]（没有弹出！）
# 接下来探索 [1,3]...时，path = [1,2,3,1,3,...]  ← 污染！
```

不撤销选择，相当于把之前的决策"遗留"在了路径里，后续路径会越来越长，结果全部错误。

### 2.3 全局状态 vs 局部状态

在某些实现中，"做选择"和"撤销选择"操作的是**全局状态**（如 `visited` 数组、棋盘）；在另一些实现中，路径通过参数传递（每层递归有自己的副本，天然隔离）。

**两种方式的选择时机**：

- 如果状态修改代价小（如简单的 boolean 数组），用全局状态 + 手动撤销
- 如果状态是字符串、列表等不可变类型，可以用局部状态传递（但可能有额外的复制开销）

```java
// 方式一：全局状态 + 撤销（推荐，内存效率高）
void backtrack(int[] nums, boolean[] used, List<Integer> path, List<List<Integer>> result) {
    if (path.size() == nums.length) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = 0; i < nums.length; i++) {
        if (used[i]) continue;  // 跳过已使用的
        used[i] = true;          // 做选择
        path.add(nums[i]);
        backtrack(nums, used, path, result);
        path.remove(path.size() - 1);  // 撤销选择
        used[i] = false;
    }
}

// 方式二：局部状态传递（代码简洁，但每次递归都创建新集合）
void backtrack(int[] nums, Set<Integer> remaining, List<Integer> path, List<List<Integer>> result) {
    if (remaining.isEmpty()) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int num : new ArrayList<>(remaining)) {
        Set<Integer> newRemaining = new HashSet<>(remaining);
        newRemaining.remove(num);
        path.add(num);
        backtrack(nums, newRemaining, path, result);
        path.remove(path.size() - 1);
    }
}
```

---

## 第 3 章 剪枝：回溯的核心优化

### 3.1 没有剪枝的回溯是暴力枚举

纯粹的回溯会枚举搜索树上的所有节点（包括注定无解的子树），这等同于暴力枚举。剪枝是回溯和暴力枚举的本质区别。

**剪枝的定义**：在搜索树的某个节点，通过**提前判断**当前路径不可能得到有效解，直接跳过整棵子树的探索。

### 3.2 可行性剪枝：违反约束时立即返回

最常见的剪枝方式。当当前路径已经违反了问题的约束，不需要继续深入：

```java
void backtrack(int[] candidates, int target, int start, int sum, List<Integer> path, ...) {
    if (sum > target) return;  // 剪枝：当前和已超目标，继续只会更大
    if (sum == target) {
        result.add(new ArrayList<>(path));
        return;
    }
    for (int i = start; i < candidates.length; i++) {
        path.add(candidates[i]);
        backtrack(candidates, target, i, sum + candidates[i], path, ...);
        path.remove(path.size() - 1);
    }
}
```

### 3.3 排序辅助剪枝：将约束变为可预测的

对于"和不超过 target"的组合问题，如果先对 `candidates` 排序，那么一旦 `candidates[i] > target - sum`，后续所有元素都更大，整个 `for` 循环可以提前终止：

```java
// 排序后，可以在 for 循环中提前 break
Arrays.sort(candidates);
for (int i = start; i < candidates.length; i++) {
    if (candidates[i] > target - sum) break;  // 不是 continue，是 break！
    // ...
}
```

注意 `break` 而不是 `continue`：因为数组已排序，后面的元素只会更大，`continue` 只跳过当前元素，`break` 直接跳出整个循环。

### 3.4 重复元素去重剪枝

当输入数组有重复元素时，避免生成重复的方案：

```java
// 对于 candidates = [1, 1, 2]，组合 [1,2] 只应出现一次
Arrays.sort(candidates);  // 先排序，相同元素相邻
for (int i = start; i < candidates.length; i++) {
    // 跳过同一层中已经使用过的相同值
    if (i > start && candidates[i] == candidates[i-1]) continue;
    // ...
}
```

**为什么是 `i > start` 而不是 `i > 0`？**

- `i > 0` 会跳过所有重复元素，包括不同层（不同位置）的相同值，导致漏解
- `i > start` 只跳过**同一层**中的重复值（`start` 是本层的起始索引），不同层可以选相同值

这个细节是 Combination Sum II 的核心难点，详见第 06 篇文章。

---

## 第 4 章 DFS 在矩阵连通性问题上的应用——Surrounded Regions

### 4.1 LeetCode 130 - Surrounded Regions

**题目**（中等）：

给你一个 $m \times n$ 的矩阵 `board`，由字符 `'X'` 和 `'O'` 组成。**捕获**所有被 `'X'` 围绕的区域：
- 找到所有被 `'X'` 围绕的 `'O'` 区域
- 将这些区域内的所有 `'O'` 替换为 `'X'`

```
输入：
X X X X
X O O X
X X O X
X O X X

输出：
X X X X
X X X X
X X X X
X O X X

解释：第 4 行第 2 列的 O 不被捕获，因为它在边界上（与边界相连）
     中间的 O 区域被 X 包围，被替换为 X
```

### 4.2 逆向思维：找不被捕获的 O

直接找"所有被围绕的 O"比较困难——一个 O 是否被围绕，取决于它所在连通分量是否与边界相连，而这需要整个连通分量的信息。

**逆向思维**：先找出**不会被捕获的 O**（与边界相连的 O），然后：

1. 从矩阵四条边上的每个 O 出发，用 DFS/BFS 标记所有与边界相连的 O（它们不会被捕获）
2. 遍历整个矩阵：原来的 O 中，被标记的保留为 O，未被标记的翻转为 X

**为什么逆向更简单？** 正向判断"O 是否被围绕"需要对每个 O 连通分量做连通性检测（代价 $O(mn)$ 每个分量），而逆向从边界出发，一次 DFS/BFS 就能标记所有与边界相连的 O，总代价 $O(mn)$。

### 4.3 DFS 实现

```java
public void solve(char[][] board) {
    if (board == null || board.length == 0) return;
    int m = board.length, n = board[0].length;

    // 步骤 1：从四条边的 O 出发，DFS 标记所有与边界相连的 O
    for (int i = 0; i < m; i++) {
        dfs(board, i, 0);        // 左边界
        dfs(board, i, n - 1);    // 右边界
    }
    for (int j = 0; j < n; j++) {
        dfs(board, 0, j);        // 上边界
        dfs(board, m - 1, j);    // 下边界
    }

    // 步骤 2：扫描矩阵，翻转状态
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (board[i][j] == 'O') {
                board[i][j] = 'X';  // 未被标记的 O → X（被捕获）
            } else if (board[i][j] == '#') {
                board[i][j] = 'O';  // 被标记的 # → O（还原，不被捕获）
            }
        }
    }
}

// DFS：从 (i, j) 出发，将所有四连通的 O 标记为 '#'
private void dfs(char[][] board, int i, int j) {
    int m = board.length, n = board[0].length;
    // 越界或不是 'O'，停止
    if (i < 0 || i >= m || j < 0 || j >= n || board[i][j] != 'O') return;

    board[i][j] = '#';  // 原地标记，不需要额外 visited 数组

    dfs(board, i + 1, j);  // 向下
    dfs(board, i - 1, j);  // 向上
    dfs(board, i, j + 1);  // 向右
    dfs(board, i, j - 1);  // 向左
}
```

**原地标记的优势**：用 `'#'` 临时标记，避免了额外的 `boolean[][] visited` 数组，节省内存。最后一次扫描时恢复，不影响结果的正确性。

### 4.4 逐步模拟

```
初始矩阵：
X X X X
X O O X
X X O X
X O X X

从边界 O 出发（只有第 4 行第 2 列是边界 O）：
dfs(3, 1)：board[3][1] = '#'
  向上：board[2][1] = X，停止
  向下：越界，停止
  向右：board[3][2] = X，停止
  向左：board[3][0] = X，停止

标记后：
X X X X
X O O X
X X O X
X # X X

步骤 2：
O → X（被捕获）：(1,1), (1,2), (2,2) 都变为 X
# → O（保留）：(3,1) 变为 O

最终：
X X X X
X X X X
X X X X
X O X X  ✅
```

### 4.5 BFS 实现（对比）

同样的问题可以用 BFS 解，逻辑与 DFS 相同，只是将递归换成队列：

```java
private void bfs(char[][] board, int startI, int startJ) {
    if (board[startI][startJ] != 'O') return;

    int m = board.length, n = board[0].length;
    Queue<int[]> queue = new LinkedList<>();
    queue.offer(new int[]{startI, startJ});
    board[startI][startJ] = '#';

    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};
    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        for (int[] dir : dirs) {
            int ni = cur[0] + dir[0], nj = cur[1] + dir[1];
            if (ni >= 0 && ni < m && nj >= 0 && nj < n && board[ni][nj] == 'O') {
                board[ni][nj] = '#';
                queue.offer(new int[]{ni, nj});
            }
        }
    }
}
```

**DFS vs BFS 在此题的权衡**：

- DFS 代码更简洁，但递归深度取决于连通分量大小，极端情况（整个矩阵全是 O）下递归深度为 $O(mn)$，可能栈溢出
- BFS 代码稍长，但无递归栈溢出风险，适用于大矩阵
- 面试中如果不特别要求，DFS 代码可读性更好

---

## 第 5 章 DFS 在矩阵上的通用模式

### 5.1 四方向遍历的标准写法

```java
int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};  // 下、上、右、左

void dfs(char[][] grid, int i, int j, boolean[][] visited) {
    if (i < 0 || i >= grid.length || j < 0 || j >= grid[0].length) return;
    if (visited[i][j]) return;
    if (grid[i][j] == 'X') return;  // 具体条件因题而异

    visited[i][j] = true;

    for (int[] dir : dirs) {
        dfs(grid, i + dir[0], j + dir[1], visited);
    }
}
```

**方向数组 `dirs` 的好处**：将四个方向的遍历统一为一个 `for` 循环，避免四行重复代码，减少出错概率。

### 5.2 原地标记 vs 独立 visited 数组

| 方式 | 优点 | 缺点 | 适用场景 |
|------|------|------|---------|
| 原地标记（修改 grid 值） | 无需额外空间 | 会修改输入，需最后恢复 | 允许修改输入的题目 |
| 独立 visited 数组 | 不修改输入 | 额外 $O(mn)$ 空间 | 不允许修改输入，或需要多次搜索 |

对于 Surrounded Regions，原地标记更优雅，且题目允许修改（`board` 是 in-place 修改的）。

### 5.3 连通分量计数（举一反三）

**LeetCode 200 - Number of Islands**：统计矩阵中 `'1'` 的连通分量数量。

```java
public int numIslands(char[][] grid) {
    int count = 0;
    for (int i = 0; i < grid.length; i++) {
        for (int j = 0; j < grid[0].length; j++) {
            if (grid[i][j] == '1') {
                dfs(grid, i, j);  // 将整个连通分量标记为 '0'
                count++;
            }
        }
    }
    return count;
}

void dfs(char[][] grid, int i, int j) {
    if (i < 0 || i >= grid.length || j < 0 || j >= grid[0].length) return;
    if (grid[i][j] != '1') return;
    grid[i][j] = '0';  // 标记已访问
    dfs(grid, i+1, j); dfs(grid, i-1, j);
    dfs(grid, i, j+1); dfs(grid, i, j-1);
}
```

同样的 DFS 模式，只需改变"启动条件"和"标记值"。

---

## 第 6 章 回溯框架的适用范围总结

回溯的通用框架适用于以下问题类型：

| 问题类型 | 搜索树结构 | 结束条件 | 典型例题 |
|---------|-----------|---------|---------|
| 全排列 | 每层选一个未选元素 | path 长度 = n | Permutations (LeetCode 46) |
| 组合 | 每层从剩余元素中选一个 | path 长度 = k | Combinations (LeetCode 77) |
| 子集 | 每个元素选或不选 | 每个节点都是答案 | Subsets (LeetCode 78) |
| 组合求和 | 每层选一个元素（可重复） | 和 = target | Combination Sum (LeetCode 39) |
| 字符串分割 | 每层选一个分割点 | 处理完整字符串 | Palindrome Partitioning (131) |
| 棋盘放置 | 每行选一列放棋子 | 放完所有行 | N-Queens (LeetCode 51) |

在每一类问题中，框架的三要素（选择列表、路径、结束条件）的具体含义不同，但结构完全相同。

---

## 本章小结

本文从 DFS 的本质出发，推导出回溯的通用三要素框架：**选择列表**（每步可做什么）、**路径**（已做什么）、**结束条件**（何时记录答案）。剪枝是回溯的核心优化，包括可行性剪枝和重复元素去重。最后以 Surrounded Regions 为例，展示了 DFS 在矩阵连通性问题上的应用，并介绍了原地标记、方向数组等实用技巧。

后续文章将在本文框架的基础上，深入各类回溯问题的具体变体。下一篇进入矩阵连通性的进阶讨论，之后是组合型、字符串型、棋盘型回溯的专项讲解。

---

*关联文章：[[双向 BFS 与路径还原：Word Ladder II 深度解析]] | [[矩阵 BFS/DFS：连通分量与 Flood Fill]] | [[组合型回溯：Combination Sum 系列]]*
