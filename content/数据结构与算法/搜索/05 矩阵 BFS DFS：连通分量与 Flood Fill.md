---
title: "矩阵 BFS/DFS：连通分量、Flood Fill 与 Number of Islands"
date: 2026-04-28
tags: [BFS, DFS, Flood Fill, LeetCode, 矩阵搜索, 算法, 连通分量, 面试]
aliases: [矩阵DFS, Flood Fill算法, Number of Islands, 连通分量]
---

# 矩阵 BFS/DFS：连通分量、Flood Fill 与 Number of Islands

## 摘要

矩阵（二维网格）上的 BFS/DFS 是面试中出现最频繁的搜索场景之一，涵盖岛屿计数、区域染色、路径查找等多类问题。这类问题的共同核心是"连通分量"的识别与操作。本文以 Number of Islands（岛屿数量）为主线，深入分析 DFS/BFS 在矩阵上的四大技巧：方向数组、原地标记、边界检测、多源 BFS；并横向对比 Flood Fill、Surrounded Regions、Pacific Atlantic Water Flow 等变体，帮你建立举一反三的模式识别能力。

---

## 第 1 章 矩阵搜索的抽象模型

### 1.1 二维矩阵 = 隐式图

一个 $m \times n$ 的矩阵，可以看作一张隐式图：

- **节点**：每个格子 $(i, j)$
- **边**：四联通（上下左右）或八联通（包含对角线）的相邻格子之间连边
- **节点状态**：格子的值（'0'/'1'、障碍/通路、颜色值等）

"矩阵搜索"就是在这张隐式图上做 BFS 或 DFS。

**四联通 vs 八联通**：

| 连通方式 | 方向数 | 方向数组 | 适用场景 |
|---------|-------|---------|---------|
| 四联通 | 4 | `{{1,0},{-1,0},{0,1},{0,-1}}` | 岛屿、水流、迷宫（最常见） |
| 八联通 | 8 | 四联通 + 对角线 4 个方向 | 国际象棋、某些路径问题 |

大多数矩阵题使用四联通，除非明确说明对角线相邻。

### 1.2 矩阵搜索的四大要素

1. **起点选择**：从哪些格子开始搜索？（单源 vs 多源）
2. **访问判断**：什么条件下进入一个格子？（值等于 '1'，或值在某个范围内……）
3. **标记方式**：如何记录已访问？（原地修改值，或独立 visited 数组）
4. **收集信息**：搜索的目的是什么？（计数连通分量、标记区域、求最短路……）

---

## 第 2 章 LeetCode 200：Number of Islands 全解析

### 2.1 题目

**LeetCode 200 - Number of Islands**（中等）：

给你一个由 `'1'`（陆地）和 `'0'`（水）组成的二维网格，请计算网格中岛屿的数量。岛屿由水平方向或垂直方向上相邻的陆地连接而成，并且四周都是水域。

```
输入：
11110
11010
11000
00000
输出：1

输入：
11000
11000
00100
00011
输出：3
```

### 2.2 解法思路：Flood Fill

**Flood Fill** 是处理连通分量问题的标准算法，源自图像处理中的"油漆桶"操作：选一个格子，将其所在连通区域全部"染色"。

**算法步骤**：
1. 遍历矩阵，找到第一个 `'1'`
2. 从这个 `'1'` 出发，DFS/BFS 将整个连通分量标记为已访问（染色）
3. 计数 +1，继续遍历矩阵找下一个未访问的 `'1'`
4. 重复直到没有未访问的 `'1'`

**关键洞察**：每次 Flood Fill 恰好覆盖一个岛屿。DFS/BFS 后这个岛屿的所有格子都已标记，不会被重复计数。

### 2.3 DFS 实现

```java
public int numIslands(char[][] grid) {
    if (grid == null || grid.length == 0) return 0;
    int m = grid.length, n = grid[0].length;
    int count = 0;

    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == '1') {
                // 发现新岛屿，DFS 将整个岛屿标记，计数 +1
                dfs(grid, i, j);
                count++;
            }
        }
    }
    return count;
}

private void dfs(char[][] grid, int i, int j) {
    int m = grid.length, n = grid[0].length;
    // 边界检查 + 合法性检查
    if (i < 0 || i >= m || j < 0 || j >= n || grid[i][j] != '1') return;

    grid[i][j] = '0';  // 原地标记：将陆地沉入水中

    dfs(grid, i + 1, j);  // 下
    dfs(grid, i - 1, j);  // 上
    dfs(grid, i, j + 1);  // 右
    dfs(grid, i, j - 1);  // 左
}
```

**复杂度**：时间 $O(mn)$（每个格子最多被访问一次），空间 $O(mn)$（递归栈深度，最坏情况整个矩阵全是陆地）。

### 2.4 BFS 实现（对比）

```java
public int numIslandsBFS(char[][] grid) {
    int m = grid.length, n = grid[0].length;
    int count = 0;
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};

    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (grid[i][j] == '1') {
                count++;
                // BFS 标记整个连通分量
                Queue<int[]> queue = new LinkedList<>();
                queue.offer(new int[]{i, j});
                grid[i][j] = '0';  // 入队时立即标记

                while (!queue.isEmpty()) {
                    int[] cur = queue.poll();
                    for (int[] dir : dirs) {
                        int ni = cur[0] + dir[0], nj = cur[1] + dir[1];
                        if (ni >= 0 && ni < m && nj >= 0 && nj < n && grid[ni][nj] == '1') {
                            grid[ni][nj] = '0';  // 入队时标记
                            queue.offer(new int[]{ni, nj});
                        }
                    }
                }
            }
        }
    }
    return count;
}
```

**DFS vs BFS 在矩阵连通分量问题的选择**：

- 代码简洁度：DFS 递归版更简洁
- 栈溢出风险：DFS 在大矩阵全连通时可能栈溢出，BFS 无此问题
- 面试推荐：DFS 代码更直观，先写 DFS；若面试官追问大数据情况，改为 BFS

---

## 第 3 章 Flood Fill 算法（LeetCode 733）

### 3.1 题目

**LeetCode 733 - Flood Fill**（简单）：

有一幅以整数数组 `image` 表示的图画，其中 `image[i][j]` 是某个像素值（0-65535）。给你三个参数 `sr`, `sc`, `color`，请从坐标 `(sr, sc)` 开始，将原来颜色相同的且四联通的区域全部染为 `color`。

```
输入：image = [[1,1,1],[1,1,0],[1,0,1]], sr=1, sc=1, color=2
输出：[[2,2,2],[2,2,0],[2,0,1]]
```

### 3.2 实现

```java
public int[][] floodFill(int[][] image, int sr, int sc, int color) {
    int origColor = image[sr][sc];
    if (origColor == color) return image;  // 颜色相同，无需操作
    dfs(image, sr, sc, origColor, color);
    return image;
}

private void dfs(int[][] image, int i, int j, int origColor, int newColor) {
    int m = image.length, n = image[0].length;
    if (i < 0 || i >= m || j < 0 || j >= n) return;
    if (image[i][j] != origColor) return;  // 不是原色，停止

    image[i][j] = newColor;  // 染色
    dfs(image, i+1, j, origColor, newColor);
    dfs(image, i-1, j, origColor, newColor);
    dfs(image, i, j+1, origColor, newColor);
    dfs(image, i, j-1, origColor, newColor);
}
```

**一个容易踩的坑**：如果 `origColor == color`，不做任何检查直接 DFS 会陷入无限递归——因为 `image[i][j]` 被染成 `color` 后，仍然等于 `origColor`，递归永远不会终止。所以必须在开头检查颜色是否相同，相同则直接返回。

---

## 第 4 章 多源 BFS：Pacific Atlantic Water Flow

### 4.1 题目

**LeetCode 417 - Pacific Atlantic Water Flow**（中等）：

给你一个 $m \times n$ 的矩阵 `heights`，表示岛屿的高度。雨水可以向四个方向（上下左右）流动，但只能从高处流向低处（或等高处）。

- 太平洋（Pacific）在矩阵的上边和左边
- 大西洋（Atlantic）在矩阵的下边和右边

返回所有能同时流向太平洋和大西洋的格子坐标。

```
输入：heights = [[1,2,2,3,5],[3,2,3,4,4],[2,4,5,3,1],[6,7,1,4,5],[5,1,1,2,4]]
输出：[[0,4],[1,3],[1,4],[2,2],[3,0],[3,1],[4,0]]
```

### 4.2 逆向多源 BFS

同 Surrounded Regions 的逆向思路：不从每个格子模拟水流（正向），而是从海洋反向溯源：

- 雨水从高流向低 → 逆向：从海洋边界出发，沿**低流向高**（反向溯源）
- 能到达太平洋的格子：从太平洋边界出发，逆向 BFS 标记所有可达格子
- 能到达大西洋的格子：类似
- 答案：同时被两个 BFS 标记的格子

```java
public List<List<Integer>> pacificAtlantic(int[][] heights) {
    int m = heights.length, n = heights[0].length;
    boolean[][] pacific = new boolean[m][n];
    boolean[][] atlantic = new boolean[m][n];

    // 太平洋：上边 + 左边
    Queue<int[]> pacQueue = new LinkedList<>();
    // 大西洋：下边 + 右边
    Queue<int[]> atlQueue = new LinkedList<>();

    for (int i = 0; i < m; i++) {
        pacQueue.offer(new int[]{i, 0});   pacific[i][0] = true;
        atlQueue.offer(new int[]{i, n-1}); atlantic[i][n-1] = true;
    }
    for (int j = 0; j < n; j++) {
        pacQueue.offer(new int[]{0, j});   pacific[0][j] = true;
        atlQueue.offer(new int[]{m-1, j}); atlantic[m-1][j] = true;
    }

    bfs(heights, pacQueue, pacific);
    bfs(heights, atlQueue, atlantic);

    List<List<Integer>> result = new ArrayList<>();
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (pacific[i][j] && atlantic[i][j]) {
                result.add(Arrays.asList(i, j));
            }
        }
    }
    return result;
}

private void bfs(int[][] heights, Queue<int[]> queue, boolean[][] visited) {
    int m = heights.length, n = heights[0].length;
    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};

    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        for (int[] dir : dirs) {
            int ni = cur[0] + dir[0], nj = cur[1] + dir[1];
            if (ni >= 0 && ni < m && nj >= 0 && nj < n
                && !visited[ni][nj]
                && heights[ni][nj] >= heights[cur[0]][cur[1]]) {  // 逆向：只流向更高或等高
                visited[ni][nj] = true;
                queue.offer(new int[]{ni, nj});
            }
        }
    }
}
```

**多源 BFS 的核心思想**：将所有"源头"（边界格子）同时入队，BFS 从多个起点同时扩散。相比从每个内部格子单独 BFS，多源 BFS 的总时间复杂度仍是 $O(mn)$，而单独 BFS 的总代价可能高达 $O(m^2 n^2)$。

---

## 第 5 章 矩阵最短路径：BFS 在加权场景的扩展

### 5.1 LeetCode 542 - 01 Matrix

**题目**（中等）：给你一个 $m \times n$ 的 01 矩阵 `mat`，返回每个格子到**最近的 0** 的距离（上下左右移动代价为 1）。

**解法**：多源 BFS，从所有 `0` 格子同时出发：

```java
public int[][] updateMatrix(int[][] mat) {
    int m = mat.length, n = mat[0].length;
    int[][] dist = new int[m][n];
    Queue<int[]> queue = new LinkedList<>();

    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            if (mat[i][j] == 0) {
                dist[i][j] = 0;
                queue.offer(new int[]{i, j});  // 所有 0 格子作为起点
            } else {
                dist[i][j] = Integer.MAX_VALUE;  // 初始化为无穷大
            }
        }
    }

    int[][] dirs = {{1,0},{-1,0},{0,1},{0,-1}};
    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        for (int[] dir : dirs) {
            int ni = cur[0] + dir[0], nj = cur[1] + dir[1];
            if (ni >= 0 && ni < m && nj >= 0 && nj < n
                && dist[ni][nj] > dist[cur[0]][cur[1]] + 1) {
                dist[ni][nj] = dist[cur[0]][cur[1]] + 1;  // 更新距离
                queue.offer(new int[]{ni, nj});
            }
        }
    }
    return dist;
}
```

**为什么多源 BFS 能解决这个问题？**

将所有 `0` 同时作为 BFS 的起点，BFS 第一次到达某个 `1` 格时的步数，就是该格到最近 `0` 的距离——因为 BFS 按距离扩展，第一次到达保证最短。

这和 Word Ladder 中"第一次到达 endWord"的原理完全相同，只不过是多源而非单源。

### 5.2 矩阵搜索题型对比

| 题目 | 搜索类型 | 起点 | 标记方式 | 核心技巧 |
|------|---------|------|---------|---------|
| Number of Islands | DFS/BFS | 每个未访问的 '1' | 原地染色 '0' | Flood Fill |
| Flood Fill (733) | DFS | 给定格子 | 原地染色 | 检查原色避免死循环 |
| Surrounded Regions (130) | DFS | 边界上的 'O' | 原地标记 '#' | 逆向思维 |
| Pacific Atlantic (417) | 多源 BFS | 两个边界 | 独立 visited | 逆向 + 多源 |
| 01 Matrix (542) | 多源 BFS | 所有 '0' | dist 数组 | 多源最短距离 |

---

## 第 6 章 复杂度分析与常见陷阱

### 6.1 为什么矩阵 DFS/BFS 的时间复杂度是 O(mn)

每个格子最多被访问一次（通过 visited 或原地标记保证），每次访问检查 4 个方向，每次检查 $O(1)$。总操作数 = 格子数 $\times$ 每格操作 = $mn \times 4 = O(mn)$。

### 6.2 递归 DFS 的栈溢出风险

DFS 的递归深度等于当前连通分量的大小。最坏情况下，整个矩阵是一个连通分量，递归深度达到 $mn$。对于 $1000 \times 1000$ 的矩阵，$mn = 10^6$，Java 默认栈大小约为 512KB，每层栈帧约几十字节，可能栈溢出。

**应对策略**：
1. 对可能很大的矩阵，优先使用 BFS（显式队列，不依赖调用栈）
2. 面试中若矩阵规模较小（如 $300 \times 300$），DFS 通常安全

### 6.3 常见错误：忘记在入队时标记

BFS 实现中，忘记在入队时标记 `visited`，而是等到出队时标记，会导致同一个格子多次入队，TLE 或结果错误。

```java
// 错误写法：出队时标记
while (!queue.isEmpty()) {
    int[] cur = queue.poll();
    visited[cur[0]][cur[1]] = true;  // 太晚了！可能已经多次入队
    for (int[] dir : dirs) {
        int ni = ..., nj = ...;
        if (inBounds && !visited[ni][nj]) {
            queue.offer(new int[]{ni, nj});  // 可能重复入队
        }
    }
}

// 正确写法：入队时标记
while (!queue.isEmpty()) {
    int[] cur = queue.poll();
    for (int[] dir : dirs) {
        int ni = ..., nj = ...;
        if (inBounds && !visited[ni][nj]) {
            visited[ni][nj] = true;  // 入队前立即标记
            queue.offer(new int[]{ni, nj});
        }
    }
}
```

---

## 本章小结

矩阵 BFS/DFS 的本质是隐式图上的遍历，核心模式是 Flood Fill——通过一次 DFS/BFS 标记整个连通分量。

关键技巧总结：
- **方向数组** `int[][] dirs` 统一处理四联通
- **原地标记** 节省独立 visited 数组的空间
- **逆向思维**：从结果反推起点（Surrounded Regions、Pacific Atlantic）
- **多源 BFS**：从多个起点同时出发，求最短距离或标记可达区域
- **入队时标记**：BFS 中节点入队时立即标记，避免重复处理

下一篇文章进入回溯专题的第一类：组合型回溯（Combination Sum），深入讲解"去重"这一回溯中最容易出错的细节。

---

*关联文章：[[DFS 与回溯核心框架：状态树的系统性遍历]] | [[组合型回溯：Combination Sum 系列]]*
