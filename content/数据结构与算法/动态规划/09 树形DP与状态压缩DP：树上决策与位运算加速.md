---
title: "树形 DP 与状态压缩 DP：树上决策与位运算加速"
date: 2026-04-28
tags: [bitmask, LeetCode, 位运算, 动态规划, 树形DP, 状态压缩DP, 算法, 面试]
aliases: [树形DP, 状态压缩DP, Tree DP, Bitmask DP]
---

# 树形 DP 与状态压缩 DP：树上决策与位运算加速

## 摘要

本文介绍动态规划的两种高级形态：**树形 DP**（在树结构上做状态转移，由叶子向根合并）和**状态压缩 DP**（用二进制位表示集合状态，突破指数级枚举的瓶颈）。树形 DP 的核心是 DFS 后序遍历——先递归处理子树，再合并子节点的结果；状态压缩 DP 的核心是用 bitmask 枚举子集，将 $O(2^n \cdot n)$ 或 $O(3^n)$ 的算法变为可行。

---

## 第 1 章 树形 DP 基础：「选或不选」在树上的推广

### 1.1 树形 DP 的基本结构

树形 DP 本质上是**在 DAG（有向无环图）上的 DP**——树本身是一种特殊的 DAG，从叶子到根方向是天然的"拓扑序"，保证计算父节点时子节点已经计算完毕。

**基本模式**：

```
dp[node][状态] = 当前节点处于"状态"时，以 node 为根的子树的最优值
```

转移：遍历所有子节点 `child`，将 `dp[child][*]` 合并到 `dp[node][*]`。

遍历方式：**DFS 后序遍历**（先处理子节点，再处理父节点）。

### 1.2 最简单的树形 DP：树的最大独立集（House Robber III）

**LeetCode 337 - House Robber III**（中等）

在二叉树形式的房屋中偷盗，不能偷相邻（直接相连）的两个房屋。求能获得的最大金额。

**状态**：对每个节点 `node`，定义：
- `dp[node][0]`：不偷 `node` 时，以 `node` 为根的子树能获得的最大金额
- `dp[node][1]`：偷 `node` 时，以 `node` 为根的子树能获得的最大金额

**转移**：

- 偷 `node`（`dp[node][1]`）：`node` 的两个子节点都不能偷：
  $$dp[node][1] = node.val + dp[left][0] + dp[right][0]$$

- 不偷 `node`（`dp[node][0]`）：子节点可以偷也可以不偷，各取最优：
  $$dp[node][0] = \max(dp[left][0], dp[left][1]) + \max(dp[right][0], dp[right][1])$$

**答案**：`max(dp[root][0], dp[root][1])`

```java
public int rob(TreeNode root) {
    int[] result = dfs(root);
    return Math.max(result[0], result[1]);
}

// 返回 int[]{不偷当前节点的最大收益, 偷当前节点的最大收益}
private int[] dfs(TreeNode node) {
    if (node == null) return new int[]{0, 0};

    int[] left = dfs(node.left);   // 先处理左子树（后序：左 → 右 → 根）
    int[] right = dfs(node.right); // 再处理右子树

    // 不偷当前节点：子节点可以自由选择
    int notRob = Math.max(left[0], left[1]) + Math.max(right[0], right[1]);

    // 偷当前节点：子节点必须不偷
    int rob = node.val + left[0] + right[0];

    return new int[]{notRob, rob};
}
```

**时间复杂度**：$O(n)$（每个节点访问一次）。**空间复杂度**：$O(h)$，`h` 是树的高度（递归栈）。

> [!info] 与一维线性 DP（打家劫舍 I/II）的对比
> 打家劫舍 I（线性数组）的"选或不选"转移方程，在树上被推广为"当前节点选或不选"的两个状态。本质完全相同，只是数据结构从线性变为了树形，遍历从左到右变为了 DFS 后序。

---

## 第 2 章 树形 DP 进阶：监控问题

### 2.1 LeetCode 968：监控二叉树

**LeetCode 968 - Binary Tree Cameras**（困难）

给定二叉树，每个节点可以安装一个摄像头，摄像头可以监视其父节点、自身和子节点。求覆盖所有节点所需的最少摄像头数量。

### 2.2 三状态建模

每个节点有三种状态：
- **状态 0**：未被监视（自己没有摄像头，且没有被子节点摄像头覆盖）
- **状态 1**：被监视，但没有安装摄像头（被子节点的摄像头覆盖）
- **状态 2**：安装了摄像头（自己主动监视自己、父节点和子节点）

`dp[node][s]` = 使节点 `node` 及其子树全部被覆盖，且 `node` 处于状态 `s` 时，所需的最少摄像头数。

> [!warning] 状态含义的精确性
> 这里"被监视"指的是节点本身已经被覆盖（不需要父节点再覆盖），而不是整个子树都被覆盖。DFS 后序确保了每个节点在处理时，其子树已经全部被覆盖。

**转移**：

**状态 2（当前节点安装摄像头）**：

当前节点安装了摄像头，子节点被覆盖（可以是状态 1 或状态 2），子节点自己不需要再被父节点覆盖：

$$dp[node][2] = 1 + \min(dp[left][0], dp[left][1], dp[left][2]) + \min(dp[right][0], dp[right][1], dp[right][2])$$

但等等——子节点如果是状态 0（未被监视），它的子树可能有未覆盖节点？不对，**状态 0 表示节点本身未被覆盖，但其子树已经全部被覆盖**。当前节点安装摄像头后，子节点被覆盖，所以子节点可以处于任意状态（因为子树已经靠子节点自己处理了）。

**状态 1（当前节点被覆盖，但没有摄像头）**：

当前节点被子节点的摄像头覆盖，所以至少一个子节点必须处于状态 2：

$$dp[node][1] = \min\begin{cases} dp[left][2] + \min(dp[right][1], dp[right][2]) \\ dp[right][2] + \min(dp[left][1], dp[left][2]) \end{cases}$$

**状态 0（当前节点未被覆盖）**：

当前节点依赖父节点的摄像头覆盖，子节点都必须处于被覆盖状态（状态 1 或 2）：

$$dp[node][0] = \min(dp[left][1], dp[left][2]) + \min(dp[right][1], dp[right][2])$$

**叶子节点的 base case**：

- 状态 0（未被覆盖）：0 个摄像头（依赖父节点）
- 状态 1（被覆盖但无摄像头）：$\infty$（叶子节点没有子节点，无法被子节点覆盖，此状态不可达）
- 状态 2（安装摄像头）：1 个摄像头

```java
public int minCameraCover(TreeNode root) {
    int[] result = dfs(root);
    // 根节点不能处于状态 0（没有父节点来覆盖它）
    return Math.min(result[1], result[2]);
}

// 返回 int[]{状态0的最少摄像头数, 状态1的最少摄像头数, 状态2的最少摄像头数}
private int[] dfs(TreeNode node) {
    if (node == null) {
        // null 节点：视为"被覆盖"（不需要覆盖），状态1代价为0，状态2不合法设为INF
        return new int[]{0, 0, Integer.MAX_VALUE / 2};
        // 这里状态0也设为0：null节点不需要被覆盖
    }

    int[] left = dfs(node.left);
    int[] right = dfs(node.right);

    // 状态2：当前节点安装摄像头
    int s2 = 1 + Math.min(left[0], Math.min(left[1], left[2]))
               + Math.min(right[0], Math.min(right[1], right[2]));

    // 状态1：当前节点被子节点覆盖（至少一个子节点有摄像头）
    // 两个子节点都有摄像头，或左有右没有，或左没有右有
    int s1 = Math.min(
        left[2] + Math.min(right[1], right[2]),   // 左子有摄像头
        right[2] + Math.min(left[1], left[2])       // 右子有摄像头
    );

    // 状态0：当前节点未被覆盖（子节点自己处理好了）
    int s0 = Math.min(left[1], left[2]) + Math.min(right[1], right[2]);

    return new int[]{s0, s1, s2};
}
```

**时间复杂度**：$O(n)$。

---

## 第 3 章 状态压缩 DP 基础

### 3.1 什么是状态压缩

当状态中包含一个**集合**（如"哪些元素被选中了"），直接枚举集合的话需要指数级时间。状态压缩 DP 用一个整数的二进制位来表示集合：第 `i` 位为 1 表示第 `i` 个元素在集合中，为 0 表示不在。

这样，大小为 `n` 的集合的所有子集可以用 `0` 到 `2^n - 1` 的整数表示，共 $2^n$ 个状态。对于 $n \leq 20$（最多 $2^{20} = 10^6$ 个状态），状态压缩 DP 是可行的。

**常用位运算**：

```java
// 检查第 i 位是否为 1
(mask >> i) & 1 == 1

// 将第 i 位设为 1
mask | (1 << i)

// 将第 i 位设为 0
mask & ~(1 << i)

// 枚举 mask 的所有非空子集
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
    // 处理子集 sub
}
// 时间复杂度：O(3^n)（所有掩码的子集总数是 3^n）
```

### 3.2 经典引入：旅行商问题（TSP）的状压 DP

**问题**：给定 `n` 个城市和城市间的距离矩阵，求从城市 0 出发、访问所有城市各一次并返回原点的最短路径（汉密顿回路）。

暴力枚举所有排列：$O(n!)$。状态压缩 DP：$O(2^n \cdot n^2)$，对 $n \leq 20$ 可接受。

**状态**：`dp[mask][i]` = 已访问城市集合为 `mask`（二进制表示），当前在城市 `i` 的最短路径长度。

**转移**：从城市 `j` 出发，走到城市 `i`（`i` 不在 `mask` 中）：

$$dp[\text{mask} | (1 << i)][i] = \min(dp[\text{mask} | (1 << i)][i],\ dp[\text{mask}][j] + \text{dist}[j][i])$$

**Base Case**：`dp[1][0] = 0`（只访问了城市 0，在城市 0，代价为 0）。

**答案**：$\min_i \left( dp[(1<<n)-1][i] + \text{dist}[i][0] \right)$（访问所有城市后返回原点）。

```java
public int tsp(int[][] dist) {
    int n = dist.length;
    int[][] dp = new int[1 << n][n];
    for (int[] row : dp) Arrays.fill(row, Integer.MAX_VALUE / 2);
    dp[1][0] = 0;  // 从城市 0 出发，初始状态只访问了城市 0

    for (int mask = 1; mask < (1 << n); mask++) {
        for (int j = 0; j < n; j++) {
            if ((mask >> j & 1) == 0) continue;  // 城市 j 不在已访问集合中
            if (dp[mask][j] == Integer.MAX_VALUE / 2) continue;

            // 从城市 j 出发，走到未访问的城市 i
            for (int i = 0; i < n; i++) {
                if ((mask >> i & 1) == 1) continue;  // 城市 i 已访问，跳过
                int newMask = mask | (1 << i);
                dp[newMask][i] = Math.min(dp[newMask][i], dp[mask][j] + dist[j][i]);
            }
        }
    }

    // 所有城市都访问后，返回城市 0
    int ans = Integer.MAX_VALUE;
    for (int i = 1; i < n; i++) {
        ans = Math.min(ans, dp[(1 << n) - 1][i] + dist[i][0]);
    }
    return ans;
}
```

---

## 第 4 章 状态压缩 DP 的面试题

### 4.1 LeetCode 847：访问所有节点的最短路径

**LeetCode 847 - Shortest Path Visiting All Nodes**（困难）

给定 `n` 个节点的无向连通图，求访问所有节点的最短路径长度（可以重复访问节点）。

与 TSP 的区别：
1. 无方向权重（边权为 1）
2. 可以重复访问节点
3. 起点可以任意选择（题目要求是从任意起点出发）

**解法**：BFS + 状态压缩

**状态**：`(node, visited)` = 当前在 `node` 节点，已访问节点集合为 `visited`（bitmask）

初始状态：从每个节点出发，`(i, 1<<i)`，距离为 0。

```java
public int shortestPathLength(int[][] graph) {
    int n = graph.length;
    int full = (1 << n) - 1;

    // BFS 队列：{当前节点, 已访问集合}
    Queue<int[]> queue = new LinkedList<>();
    boolean[][] visited = new boolean[n][1 << n];

    // 从所有节点出发
    for (int i = 0; i < n; i++) {
        queue.offer(new int[]{i, 1 << i, 0});  // {节点, 已访问掩码, 步数}
        visited[i][1 << i] = true;
    }

    while (!queue.isEmpty()) {
        int[] curr = queue.poll();
        int node = curr[0], mask = curr[1], dist = curr[2];

        if (mask == full) return dist;  // 所有节点都已访问

        for (int next : graph[node]) {
            int newMask = mask | (1 << next);
            if (!visited[next][newMask]) {
                visited[next][newMask] = true;
                queue.offer(new int[]{next, newMask, dist + 1});
            }
        }
    }
    return -1;
}
```

**时间复杂度**：$O(2^n \cdot n^2)$。**空间复杂度**：$O(2^n \cdot n)$。

### 4.2 LeetCode 1125：最小的必要团队

**LeetCode 1125 - Smallest Sufficient Team**（困难）

给定 `n` 种技能要求（`req_skills`）和 `m` 个候选人（每人掌握若干技能），选出最少人数的团队，使团队掌握所有必要技能。

**建模**：

1. 将每个技能映射到二进制位的第 `i` 位，`n <= 16`
2. 每个候选人的技能集合表示为一个 bitmask
3. `dp[mask]` = 覆盖技能集合 `mask` 所需的最少人数（以及具体是哪些人）

**转移**：对每个候选人 `i`（技能集 `skill[i]`），遍历所有状态 `mask`：

$$dp[\text{mask} | \text{skill}[i]] = \min(dp[\text{mask} | \text{skill}[i]],\ dp[\text{mask}] + 1)$$

```java
public int[] smallestSufficientTeam(String[] req_skills, List<List<String>> people) {
    int n = req_skills.length;
    Map<String, Integer> skillIndex = new HashMap<>();
    for (int i = 0; i < n; i++) skillIndex.put(req_skills[i], i);

    // 每个人的技能集合
    int[] peopleMask = new int[people.size()];
    for (int i = 0; i < people.size(); i++) {
        for (String skill : people.get(i)) {
            peopleMask[i] |= (1 << skillIndex.get(skill));
        }
    }

    int full = (1 << n) - 1;
    // dp[mask] = 覆盖技能 mask 的最少人数
    int[] dp = new int[full + 1];
    long[] team = new long[full + 1];  // 用 long 作为 bitmask 记录选了哪些人（最多 60 人）
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;

    for (int mask = 0; mask <= full; mask++) {
        if (dp[mask] == Integer.MAX_VALUE) continue;
        for (int i = 0; i < people.size(); i++) {
            int newMask = mask | peopleMask[i];
            if (dp[newMask] > dp[mask] + 1) {
                dp[newMask] = dp[mask] + 1;
                team[newMask] = team[mask] | (1L << i);  // 记录选了人 i
            }
        }
    }

    // 还原结果
    long selectedTeam = team[full];
    List<Integer> result = new ArrayList<>();
    for (int i = 0; i < people.size(); i++) {
        if ((selectedTeam >> i & 1) == 1) result.add(i);
    }
    return result.stream().mapToInt(Integer::intValue).toArray();
}
```

### 4.3 LeetCode 691：贴纸拼词

**LeetCode 691 - Stickers to Spell Word**（困难）

给若干种贴纸，每种贴纸可以无限使用（上面有若干字母），求用最少贴纸拼出目标单词 `target`（每个字母必须覆盖）。

**建模**：

`target` 的字符覆盖情况用 bitmask 表示，第 `i` 位表示 `target[i]` 是否已被覆盖。

`dp[mask]` = 覆盖 `target` 中 `mask` 指定字符所需的最少贴纸数。

```java
public int minStickers(String[] stickers, String target) {
    int n = target.length();
    int[] dp = new int[1 << n];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;

    for (int mask = 0; mask < (1 << n); mask++) {
        if (dp[mask] == Integer.MAX_VALUE) continue;

        for (String sticker : stickers) {
            int newMask = mask;
            // 用这张贴纸，尝试覆盖更多目标字符
            int[] freq = new int[26];
            for (char c : sticker.toCharArray()) freq[c - 'a']++;

            for (int i = 0; i < n; i++) {
                if ((newMask >> i & 1) == 1) continue;  // 已覆盖，跳过
                char c = target.charAt(i);
                if (freq[c - 'a'] > 0) {
                    newMask |= (1 << i);     // 覆盖第 i 个字符
                    freq[c - 'a']--;          // 消耗一个字符
                }
            }

            if (dp[newMask] > dp[mask] + 1) {
                dp[newMask] = dp[mask] + 1;
            }
        }
    }

    return dp[(1 << n) - 1] == Integer.MAX_VALUE ? -1 : dp[(1 << n) - 1];
}
```

---

## 第 5 章 枚举子集的技巧（$O(3^n)$ DP）

### 5.1 子集枚举的遍历技巧

对于某些状态压缩 DP，需要枚举一个集合的所有子集（如分组 DP）：

```java
// 枚举 mask 的所有非空子集
for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
    // 处理子集 sub
}

// 枚举 mask 的所有子集（包括空集）
for (int sub = mask; ; sub = (sub - 1) & mask) {
    // 处理子集 sub
    if (sub == 0) break;
}
```

**正确性**：`(sub - 1) & mask` 得到的是 `mask` 的下一个（按数值递减）子集。最终当 `sub = 0` 时，`(0 - 1) & mask = mask`（回到最大子集），形成循环，所以需要 `break`。

**时间复杂度**：枚举所有掩码的所有子集，总时间为 $\sum_{k=0}^{n} C_n^k \cdot 2^k = 3^n$（二项式定理）。

### 5.2 LeetCode 1986：完成任务的最少工作时间段

**LeetCode 1986 - Minimum Number of Work Sessions to Finish the Tasks**（中等）

给定任务列表，每个任务有各自的耗时，每个工作阶段最多工作 `sessionTime`，同一个任务必须在同一阶段完成（不能跨阶段）。求完成所有任务的最少工作阶段数。

**状态**：`dp[mask]` = 完成任务集合 `mask` 的最少工作阶段数。

**转移**：枚举 `mask` 的所有子集 `sub` 作为最后一个工作阶段处理的任务，若 `sum(sub) <= sessionTime`（一个阶段能完成），则：

$$dp[\text{mask}] = \min_{\text{sub} \subseteq \text{mask},\ \text{sum(sub)} \leq \text{sessionTime}} dp[\text{mask} \oplus \text{sub}] + 1$$

```java
public int minSessions(int[] tasks, int sessionTime) {
    int n = tasks.length;
    int full = (1 << n) - 1;

    // 预计算每个子集的总耗时
    int[] totalTime = new int[full + 1];
    for (int mask = 1; mask <= full; mask++) {
        int lastBit = mask & (-mask);  // 最低位
        int taskIdx = Integer.numberOfTrailingZeros(lastBit);
        totalTime[mask] = totalTime[mask ^ lastBit] + tasks[taskIdx];
    }

    int[] dp = new int[full + 1];
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;

    for (int mask = 1; mask <= full; mask++) {
        // 枚举 mask 的所有非空子集，作为最后一个阶段的任务集合
        for (int sub = mask; sub > 0; sub = (sub - 1) & mask) {
            if (totalTime[sub] <= sessionTime && dp[mask ^ sub] != Integer.MAX_VALUE) {
                dp[mask] = Math.min(dp[mask], dp[mask ^ sub] + 1);
            }
        }
    }
    return dp[full];
}
```

**时间复杂度**：$O(3^n)$（枚举所有掩码的所有子集）。对 $n \leq 14$ 可接受。

---

## 第 6 章 树形 DP 与状态压缩 DP 的对比与选择

### 6.1 题目特征判断

| 特征 | 推荐方法 |
|------|---------|
| 数据结构是树，状态需要从子节点传递到父节点 | 树形 DP |
| 状态是集合（哪些元素已选择/已访问） | 状态压缩 DP |
| 元素个数 $n \leq 20$，枚举子集 | 状态压缩 DP（$O(2^n \cdot n)$） |
| 需要枚举所有子集划分 | 子集枚举（$O(3^n)$） |
| 树上的分组/颜色选择 | 树形 DP |

### 6.2 树形 DP 的常见变体

1. **有依赖的背包**：在树上做背包 DP（每个节点选或不选，但选父节点是选子节点的前提）
2. **树的直径**：`dp[node]` = 以 `node` 为根的子树中，从 `node` 出发的最长路径；更新全局最大值时合并两个子树的最长路径
3. **树的重心**：最大子树节点数最小的节点，可用 DFS + DP 求解
4. **树上路径 DP**：统计满足条件的路径数量（如路径和等于 target）

### 6.3 状态压缩 DP 的复杂度速查

| 状态数 | 每个状态的转移 | 总复杂度 | 适用 n |
|-------|-------------|---------|-------|
| $O(2^n)$ | $O(n)$ | $O(2^n \cdot n)$ | $n \leq 20$ |
| $O(2^n \cdot n)$ | $O(n)$ | $O(2^n \cdot n^2)$ | $n \leq 15$ |
| 子集枚举 | $O(2^n)$ 子集 | $O(3^n)$ | $n \leq 14$ |

---

## 第 7 章 面试中的树形 DP 注意事项

### 7.1 DFS 返回值的设计

树形 DP 通常在 DFS 递归时返回一个数组（表示多个状态）或直接更新全局变量。两种方式各有优劣：

```java
// 方式一：DFS 返回状态数组（更清晰，推荐）
int[] dfs(TreeNode node) {
    // 返回 [状态0的最优值, 状态1的最优值, ...]
}

// 方式二：DFS 更新全局变量（适合"查询全局最大/最小"的场景）
int globalAns = 0;
int dfs(TreeNode node) {
    // 计算局部值，同时更新 globalAns
    globalAns = Math.max(globalAns, ...);
    return 局部值;
}
```

### 7.2 处理空节点的 base case

树形 DP 中，空节点（`null`）的状态值需要仔细设计：
- 对于最小值问题：空节点通常初始化为"无穷大"或"不可达"
- 对于计数问题：空节点通常初始化为 0
- 对于"是否可达"的状态：空节点通常是"不存在"的特殊情况

见 LeetCode 968 的 `return new int[]{0, 0, Integer.MAX_VALUE / 2}`——空节点的状态 2（安装摄像头）设为无穷大，因为不存在的节点无法安装摄像头，这个状态不合法。

### 7.3 避免状态机建模的遗漏

在多状态树形 DP（如 LeetCode 968）中，需要确保：
1. **所有状态都有明确的语义**
2. **每种状态的转移都覆盖了所有合法的子状态组合**
3. **不可达状态设为无穷大（而非 0）**，否则会干扰 `min` 操作

---

## 小结

本文介绍了两种高级 DP 形态：

**树形 DP**：
- 状态定义在树节点上，通常是 `dp[node][状态]`
- 遍历方式：DFS 后序（先处理子树，再合并到父节点）
- 核心题型：树上选/不选（House Robber III），多状态监控（Binary Tree Cameras）
- 时间复杂度通常为 $O(n)$（每个节点访问一次）

**状态压缩 DP**：
- 用整数的二进制位表示集合状态
- 核心操作：按位或（添加元素）、按位与（检查元素）、枚举子集（`sub = (sub-1) & mask`）
- 典型时间复杂度：$O(2^n \cdot n)$ 或 $O(3^n)$
- 适用 $n \leq 20$（$2^n \cdot n$ 级别）或 $n \leq 14$（$3^n$ 级别）

| 题目 | 方法 | 核心技巧 |
|------|------|---------|
| LeetCode 337 House Robber III | 树形DP | 后序DFS，二状态合并 |
| LeetCode 968 Binary Tree Cameras | 树形DP | 三状态建模 |
| TSP（旅行商） | 状压DP | `dp[mask][i]`，路径状态 |
| LeetCode 847 访问所有节点 | BFS + 状压 | 多起点BFS |
| LeetCode 1125 最小团队 | 状压DP | 枚举每个人的贡献 |
| LeetCode 691 贴纸拼词 | 状压DP | 字符位覆盖 |

下一篇[[动态规划综合通关：高频模式识别与面试决策树]]将对全系列进行总结，梳理六大 DP 模式的识别方法，介绍买卖股票系列（状态机 DP），并给出面试中快速定位 DP 类型的决策树。
