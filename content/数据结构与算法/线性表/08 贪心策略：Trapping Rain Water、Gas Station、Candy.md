---
title: "贪心策略：Trapping Rain Water、Gas Station、Candy"
date: 2026-04-27
tags: [LeetCode, 单调栈, 数据结构, 数组, 算法, 贪心, 面试]
aliases: [贪心算法, 接雨水, 加油站, 分糖果]
---

# 贪心策略：Trapping Rain Water、Gas Station、Candy

## 摘要

本篇以三道经典题为载体，系统讲解线性表上的贪心算法思想。接雨水（LeetCode 42）是面试高频硬题，有单调栈和双指针两种 $O(n)$ 解法；加油站（LeetCode 134）的贪心正确性证明是理解贪心算法的绝佳案例；糖果分发（LeetCode 135）则展示了"两遍扫描"这一贪心技巧。三道题覆盖了贪心在数组场景中最典型的三种变体，理解它们，你就掌握了贪心的核心范式。

---

## 第 1 章 贪心算法的本质与适用条件

### 1.1 贪心是什么

贪心算法（Greedy Algorithm）的定义很简单：**在每一步决策中，选择当前看起来最优的选项，不回头，不修改已做的决策**。

直觉上，这好像是一种"短视"策略——只顾眼前，不考虑全局。为什么有时候它能得到全局最优解？

**关键在于问题是否具有"贪心选择性质"（Greedy Choice Property）**：局部最优选择能推导出全局最优解。不是所有问题都有这个性质，所以贪心算法的最大挑战不是"怎么贪"，而是"能不能贪"——即证明贪心选择不会导致全局次优。

### 1.2 贪心 vs 动态规划

贪心和动态规划都解决"最优化"问题，区别在于：

| 特性 | 贪心 | 动态规划 |
|------|------|---------|
| 决策方式 | 每步做最优决策，不回头 | 记录所有子问题的解，反复利用 |
| 子问题重叠 | 不需要 | 需要（DP 的核心价值） |
| 时间复杂度 | 通常 $O(n)$ 或 $O(n \log n)$ | 通常 $O(n^2)$ 或更高 |
| 难点 | 证明贪心选择性质 | 找状态转移方程 |
| 适用条件 | 问题有最优子结构 + 贪心选择性质 | 问题有最优子结构（不一定有贪心性质） |

---

## 第 2 章 LeetCode 42：接雨水

### 2.1 题目

**LeetCode 42 - Trapping Rain Water**（困难）

给定 `n` 个非负整数表示每个宽度为 1 的柱子的高度图，计算按此排列的柱子，下雨之后能接多少雨水。

```
输入: height = [0,1,0,2,1,0,1,3,2,1,2,1]
输出: 6

  ┌─┐         
  │█│   ┌─┐  ┌─┐  
  │█│ ┌─┤█├─ ┤█├──
┌─┤█├─┤█│█│ ┌┤█│█│
│ │█│ │█│█│ ││█│█│
0  1  0  2  1  0  1  3  2  1  2  1
```

柱子之间形成的凹槽可以储水，求总储水量。

### 2.2 方法一：动态规划预处理（$O(n)$ 时间，$O(n)$ 空间）

**核心观察**：位置 $i$ 能存储的水量 = $\min(\text{左侧最高柱子}, \text{右侧最高柱子}) - \text{height}[i]$（如果这个值为负，说明该位置不存水）。

用两个数组 `leftMax[i]`（位置 $i$ 左侧（含 $i$）的最高柱子）和 `rightMax[i]`（位置 $i$ 右侧（含 $i$）的最高柱子）：

```java
public int trap(int[] height) {
    int n = height.length;
    int[] leftMax = new int[n];
    int[] rightMax = new int[n];
    
    // 从左到右计算每个位置左侧的最高柱子
    leftMax[0] = height[0];
    for (int i = 1; i < n; i++) {
        leftMax[i] = Math.max(leftMax[i-1], height[i]);
    }
    
    // 从右到左计算每个位置右侧的最高柱子
    rightMax[n-1] = height[n-1];
    for (int i = n-2; i >= 0; i--) {
        rightMax[i] = Math.max(rightMax[i+1], height[i]);
    }
    
    // 计算每个位置的存水量
    int total = 0;
    for (int i = 0; i < n; i++) {
        total += Math.min(leftMax[i], rightMax[i]) - height[i];
    }
    return total;
}
```

### 2.3 方法二：双指针（$O(n)$ 时间，$O(1)$ 空间）

方法一用了额外的 $O(n)$ 空间。能否用双指针做到 $O(1)$？

**关键洞察**：

对于位置 $i$，其存水量取决于 $\min(\text{leftMax}[i], \text{rightMax}[i])$。

如果我们用双指针从两端向中间靠拢：
- 左指针 `left` 从 0 出发，维护 `leftMaxSoFar`（到目前为止左指针左侧的最高柱子）
- 右指针 `right` 从 `n-1` 出发，维护 `rightMaxSoFar`（到目前为止右指针右侧的最高柱子）

**关键推理**：当 `leftMaxSoFar < rightMaxSoFar` 时，对于 `left` 位置，我们知道：
- 左侧最高柱子确切是 `leftMaxSoFar`（已经扫过了）
- 右侧最高柱子 ≥ `rightMaxSoFar`（右侧还没扫完，但至少有 `rightMaxSoFar` 这么高）

因此 $\min(\text{leftMax}, \text{rightMax}) = \text{leftMaxSoFar}$（因为左边更小），`left` 位置的存水量是确定的：`leftMaxSoFar - height[left]`。

此时可以安全地处理 `left` 位置并向右移动 `left`。反之，当 `rightMaxSoFar <= leftMaxSoFar` 时，处理 `right` 位置并向左移动 `right`。

```java
public int trap(int[] height) {
    int left = 0, right = height.length - 1;
    int leftMax = 0, rightMax = 0;
    int total = 0;
    
    while (left < right) {
        if (height[left] < height[right]) {
            // 左边更矮，左侧成为瓶颈
            if (height[left] >= leftMax) {
                leftMax = height[left]; // 更新左侧最大值
            } else {
                total += leftMax - height[left]; // 当前位置存水量
            }
            left++;
        } else {
            // 右边更矮（或相等），右侧成为瓶颈
            if (height[right] >= rightMax) {
                rightMax = height[right];
            } else {
                total += rightMax - height[right];
            }
            right--;
        }
    }
    
    return total;
}
```

**手动验证**（`[0,1,0,2,1,0,1,3,2,1,2,1]`，期望输出 6）：

```
left=0(h=0), right=11(h=1): h[left]<h[right], leftMax=max(0,0)=0, total+=0-0=0, left++
left=1(h=1), right=11(h=1): h[left]>=h[right], rightMax=max(0,1)=1, right--
left=1(h=1), right=10(h=2): h[left]<h[right], leftMax=max(0,1)=1, left++
left=2(h=0), right=10(h=2): h[left]<h[right], total+=1-0=1, left++
... （继续计算，最终 total=6）
```

### 2.4 方法三：单调栈（$O(n)$ 时间，$O(n)$ 空间）

单调栈解法按"横向层"计算存水，每次发现右侧柱子高于栈顶时，弹出栈顶并计算其能存的水量。

```java
public int trap(int[] height) {
    Deque<Integer> stack = new ArrayDeque<>(); // 存下标，栈内对应高度单调递减
    int total = 0;
    
    for (int i = 0; i < height.length; i++) {
        while (!stack.isEmpty() && height[i] > height[stack.peek()]) {
            int mid = stack.pop(); // 凹槽的底部
            if (!stack.isEmpty()) {
                int left = stack.peek();
                int width = i - left - 1;
                int h = Math.min(height[i], height[left]) - height[mid];
                total += width * h;
            }
        }
        stack.push(i);
    }
    
    return total;
}
```

单调栈解法的思路是：维护一个高度单调不增的栈（存下标），当遇到比栈顶更高的柱子时，说明找到了一个"槽"的右壁，可以计算这个槽的存水量。

> [!info] 三种方法比较
> - **动态规划**：最好理解，空间 $O(n)$
> - **双指针**：最优空间 $O(1)$，需要理解"哪侧是瓶颈"的推理
> - **单调栈**：按横向层计算，思路不同，对理解单调栈有帮助
> 
> 面试推荐先讲动态规划方案（展示思路清晰），再给出双指针优化（展示空间优化能力）。

---

## 第 3 章 LeetCode 134：加油站

### 3.1 题目

**LeetCode 134 - Gas Station**（中等）

在一条环路上有 `n` 个加油站，其中第 `i` 个加油站有汽油 `gas[i]` 升。

你有一辆油箱容量无限的汽车，从第 `i` 个加油站开往第 `i+1` 个加油站需要消耗汽油 `cost[i]` 升。你从其中的一个加油站出发，开始时油箱为空。

给定两个整数数组 `gas` 和 `cost`，如果你可以按顺序绕环路行驶一周，则返回出发加油站的编号，否则返回 -1。如果存在解，则**保证它是唯一的**。

```
输入: gas = [1,2,3,4,5], cost = [3,4,5,1,2]
输出: 3

输入: gas = [2,3,4], cost = [3,4,3]
输出: -1
```

### 3.2 贪心思路推导

**观察一：总量判断可行性**

如果 $\sum \text{gas}[i] < \sum \text{cost}[i]$，汽油总量不够消耗，无论从哪里出发都无法完成，返回 -1。

**观察二：如果总量够，一定能找到一个起点**

定义 `diff[i] = gas[i] - cost[i]`（在第 `i` 站净获得的油量）。如果总和 $\sum \text{diff}[i] \geq 0$，则必然存在合法的出发点。

**观察三：贪心选择起点**

从位置 0 开始模拟，维护当前油量 `tank`。如果某一时刻 `tank < 0`，说明从当前起点出发，到这里就"跑不动了"。

**关键贪心论断**：如果从起点 `start` 出发，走到位置 `i` 时油量变负，那么从 `start` 到 `i` 之间任意一个位置 $k$ 出发都不可行。

**证明**：从 `start` 出发，走到 $k$ 时有油量 $\geq 0$（否则更早就应该换起点），走到 $i$ 时油量 $< 0$。如果从 $k$ 出发，缺少了从 `start` 到 $k$ 段的净油量补充，油量只会比从 `start` 出发更少，到达 $i$ 时油量更负。所以 $k$ 也不行。

因此，当油量在 `i` 变负时，应该把起点更新为 `i+1`，继续模拟。

```java
public int canCompleteCircuit(int[] gas, int[] cost) {
    int totalGas = 0, tank = 0, start = 0;
    
    for (int i = 0; i < gas.length; i++) {
        int diff = gas[i] - cost[i];
        totalGas += diff;
        tank += diff;
        
        if (tank < 0) {
            // 从 start 出发无法到达 i+1，重置起点
            start = i + 1;
            tank = 0; // 重置当前油量
        }
    }
    
    // 如果总油量不足，无解；否则 start 就是答案
    return totalGas >= 0 ? start : -1;
}
```

### 3.3 为什么一遍扫描就够？

这是这道题最令人疑惑的地方：模拟时我们只走了一圈（不是真的绕环路走两圈），怎么能保证从 `start` 出发，走完 `start` 之前的那些站（下标 0 到 `start-1`）也没问题？

**证明**：

设找到的起点是 `start`，用 `S[i]` 表示从 `start` 出发，走到 `start+1, start+2, ..., i` 时的累计净油量。

- `start` 到 `n-1` 这一段（后半段）：模拟时我们从 `start` 走到 `n-1`，油量始终 `≥ 0`（否则会继续更新 `start`），所以后半段没有问题。

- `0` 到 `start-1` 这一段（前半段）：前半段的各个位置 $k$（$k < \text{start}$），在之前的模拟中作为"候选起点"时，油量在某处变负（否则不会更新 `start`）。这意味着从位置 $k$ 出发到某处的累计净油量 < 0。

    但从 `start` 出发，走完后半段 `[start, n-1]` 后，积累了正的油量（因为总量足够且后半段没有问题）。这些积累的油量，在进入前半段 `[0, start-1]` 时会形成"油量盈余"，弥补前半段可能的不足。

    更严格地，$\sum_{i=0}^{n-1} \text{diff}[i] \geq 0$（总量足够）且后半段不出现负，数学上可以证明绕完后，前半段也能撑过去。

### 3.4 贪心正确性的直觉

把整个环路想象成一条高低起伏的折线图：$y$ 轴是累计净油量，$x$ 轴是位置。从某点出发，若走完一圈能回到原点且过程中 $y$ 值始终 $\geq 0$，则出发点合法。

贪心选的 `start` 就是这条折线**全局最低点**的下一个位置。从最低点出发（或其后一步），油量从 0 开始，走完一圈必然不会出现负数（因为最低点就是整个折线最低的位置，从其之后出发往后走只会升高或维持）。

---

## 第 4 章 LeetCode 135：分发糖果

### 4.1 题目

**LeetCode 135 - Candy**（困难）

`n` 个孩子站成一排。给你一个整数数组 `ratings` 表示每个孩子的评分。

你需要按以下要求，给这些孩子分发糖果：
- 每个孩子至少分配到 1 块糖果
- 相邻两个孩子评分更高的孩子会获得更多的糖果

请你给每个孩子分发糖果，计算并返回需要准备的**最少糖果数目**。

```
输入: ratings = [1,0,2]
输出: 5（分配 [2,1,2] 块糖果）

输入: ratings = [1,2,2]
输出: 4（分配 [1,2,1] 块糖果）
```

### 4.2 两遍贪心扫描

这道题的约束来自**两个方向**：
- 左约束：如果 `ratings[i] > ratings[i-1]`，那么 `candy[i] > candy[i-1]`
- 右约束：如果 `ratings[i] > ratings[i+1]`，那么 `candy[i] > candy[i+1]`

这两个约束互相独立，无法同时满足（考虑 `[1,2,1]`：`candy[1]` 必须比左右两侧都大）。

**两遍贪心**：分别处理两个方向的约束，然后取每个位置两次结果的最大值：

**第一遍：从左到右扫描（满足左约束）**

初始化 `candy[i] = 1`（每人至少 1 块）。从左到右，如果 `ratings[i] > ratings[i-1]`，令 `candy[i] = candy[i-1] + 1`（比左邻多 1）。否则保持 1。

```
ratings: [1, 0, 2]
第一遍:  [1, 1, 2]（只满足左约束）
```

**第二遍：从右到左扫描（满足右约束）**

从右到左，如果 `ratings[i] > ratings[i+1]`，令 `candy[i] = max(candy[i], candy[i+1] + 1)`（取 max 是因为第一遍的结果可能已经满足右约束了，取较大值保证两个约束都满足）。

```
ratings: [1, 0, 2]
第一遍:  [1, 1, 2]
第二遍:  从右到左:
  i=1: ratings[1]=0 < ratings[2]=2, 不更新
  i=0: ratings[0]=1 > ratings[1]=0, candy[0] = max(1, candy[1]+1) = max(1,2) = 2
结果:  [2, 1, 2], 总和=5 ✓
```

### 4.3 代码实现

```java
public int candy(int[] ratings) {
    int n = ratings.length;
    int[] candy = new int[n];
    Arrays.fill(candy, 1); // 每人至少 1 块
    
    // 第一遍：从左到右，满足左约束
    for (int i = 1; i < n; i++) {
        if (ratings[i] > ratings[i - 1]) {
            candy[i] = candy[i - 1] + 1;
        }
    }
    
    // 第二遍：从右到左，满足右约束（取 max 保持左约束也满足）
    for (int i = n - 2; i >= 0; i--) {
        if (ratings[i] > ratings[i + 1]) {
            candy[i] = Math.max(candy[i], candy[i + 1] + 1);
        }
    }
    
    int total = 0;
    for (int c : candy) total += c;
    return total;
}
```

**为什么第二遍用 `max` 而不是直接赋值？**

如果直接赋值 `candy[i] = candy[i+1] + 1`，会覆盖第一遍建立的左约束结果。例如 `ratings = [1,2,3,2,1]`：
- 第一遍后：`[1,2,3,1,1]`（中间山峰位置 candy[2]=3 满足左约束）
- 如果第二遍直接赋值：`i=2: candy[2] = candy[3]+1 = 2`，覆盖了 3，变成 `[1,2,2,2,1]`
  - `ratings[2]=3 > ratings[1]=2`，但 `candy[2]=2 == candy[1]=2`，不满足左约束！

用 `max` 则：`candy[2] = max(3, 2) = 3`，保留左约束的结果，同时满足右约束。

**复杂度**：时间 $O(n)$（两次线性扫描），空间 $O(n)$（存储 candy 数组）。

### 4.4 贪心正确性证明

两遍贪心的正确性来自于：

- **第一遍正确**：按左约束，`candy[i]` 是满足所有左邻约束所需的最小值。如果 `ratings[i] > ratings[i-1]`，`candy[i]` 至少要比 `candy[i-1]` 大 1；否则，`candy[i] = 1` 已经是最小值。
- **第二遍正确**：按右约束，对每个位置取 `max`，保证同时满足两个方向的约束，且每次都是最小可能的值（不多给）。
- **全局最优**：两遍下来，每个位置的值都是在满足所有约束前提下的最小值，因此总和是最小可能的总糖果数。

---

## 第 5 章 三道贪心题的横向对比

| 题目 | 贪心策略 | 正确性依据 | 时间 | 空间 |
|------|---------|------------|------|------|
| 接雨水（双指针） | 处理"瓶颈"更小的那侧 | 瓶颈侧的存水量已确定 | $O(n)$ | $O(1)$ |
| 加油站 | 油量负时将起点移到下一站 | 从当前起点到失败点之间任意点都不可行 | $O(n)$ | $O(1)$ |
| 分糖果 | 两遍扫描分别满足左右约束 | 两个独立约束分开处理，取 max 保证同时满足 | $O(n)$ | $O(n)$ |

三道题的共同特点：**一次或两次线性扫描，每步做出确定性的最优决策，不需要回溯**。这是贪心算法在数组问题中的典型表现。

---

## 下一篇预告

[[09 动态规划与位运算：Climbing Stairs、Plus One、Single Number I/II]] 将进入动态规划和位运算的交叉地带。爬楼梯是 DP 入门经典，但你真的理解"状态"的含义吗？Plus One 是大数加法的模拟，细节是关键；Single Number 系列把位运算的特性用到了极致。
