---
title: "最大子数组问题：Kadane 算法与分治视角"
date: 2026-04-28
tags: [算法, 分治法, 动态规划, Kadane, 最大子数组, LeetCode, 面试]
aliases: [最大子数组, Kadane算法, 53, 152, 918]
---

# 最大子数组问题：Kadane 算法与分治视角

## 摘要

最大子数组（Maximum Subarray）问题是算法面试中极高频的考点。它有两种完全不同的正确解法：$O(n \log n)$ 的分治解法和 $O(n)$ 的 Kadane 算法。理解两种解法不是为了让你记住两套代码，而是帮你透彻掌握**分治中"跨越中点"处理**与**线性扫描中的动态规划思想**这两个截然不同的思维框架。本文覆盖三道递进的题目：LeetCode 53（最大子数组和）、LeetCode 152（乘积最大子数组）和 LeetCode 918（环形子数组的最大和），每道题都揭示一种新的变形技法。

---

## 第 1 章 问题的本质

### 1.1 题目：LeetCode 53

**LeetCode 53 - Maximum Subarray**（中等）

给你一个整数数组 `nums`，请你找出一个具有最大和的连续子数组（子数组最少包含一个元素），返回其最大和。

```
输入: nums = [-2, 1, -3, 4, -1, 2, 1, -5, 4]
输出: 6
解释: 连续子数组 [4,-1,2,1] 的和最大，为 6

输入: nums = [1]
输出: 1

输入: nums = [5, 4, -1, 7, 8]
输出: 23
```

### 1.2 为什么暴力 $O(n^2)$ 不够

暴力做法：枚举所有子数组的起点 $i$ 和终点 $j$，计算 `sum(nums[i..j])`，取最大值。共 $O(n^2)$ 个子数组，每个子数组的和可以用前缀和 $O(1)$ 计算，总复杂度 $O(n^2)$。

对于 $n = 10^5$，$O(n^2) = 10^{10}$，超时。

**能不能做到 $O(n \log n)$？能。可以做到 $O(n)$ 吗？也可以。**

这道题是"有两种不同 $O$ 复杂度的正确解"的经典案例，面试中能说清楚两种解法的推导，远比只会一种更有价值。

---

## 第 2 章 分治解法：跨越中点的子数组

### 2.1 分治的直觉

对于数组 `nums[left..right]`，取中点 `mid = left + (right - left) / 2`，最大子数组要么：

1. **完全在左半部分** `nums[left..mid]`
2. **完全在右半部分** `nums[mid+1..right]`
3. **跨越中点**：以 `mid` 结尾的后缀 + 以 `mid+1` 开头的前缀

情形 1 和 2 递归求解。情形 3 是关键：**跨越中点的最大子数组**，必须同时包含 `nums[mid]` 和 `nums[mid+1]`，向两侧尽量延伸，直到延伸不再增加和为止。

```java
int crossMaxSum(int[] nums, int left, int mid, int right) {
    // 从 mid 向左扩展，找到最大的左侧后缀和
    int leftMax = Integer.MIN_VALUE;
    int sum = 0;
    for (int i = mid; i >= left; i--) {
        sum += nums[i];
        leftMax = Math.max(leftMax, sum);
    }

    // 从 mid+1 向右扩展，找到最大的右侧前缀和
    int rightMax = Integer.MIN_VALUE;
    sum = 0;
    for (int i = mid + 1; i <= right; i++) {
        sum += nums[i];
        rightMax = Math.max(rightMax, sum);
    }

    // 跨越中点的最大子数组和 = 最大左侧后缀 + 最大右侧前缀
    return leftMax + rightMax;
}
```

**为什么这是正确的？**

跨越中点的子数组必须包含 `nums[mid]` 和 `nums[mid+1]`（至少各包含一个，因为必须跨越中点）。左侧部分是从 `mid` 向左扩展的某个后缀，右侧部分是从 `mid+1` 向右扩展的某个前缀。由于这两部分是独立的（一个向左，一个向右），各取最大值即可。

### 2.2 完整分治实现

```java
class Solution {
    public int maxSubArray(int[] nums) {
        return divideAndConquer(nums, 0, nums.length - 1);
    }

    private int divideAndConquer(int[] nums, int left, int right) {
        // 基础情形：只有一个元素
        if (left == right) return nums[left];

        int mid = left + (right - left) / 2;

        // 递归求左半部分和右半部分的最大子数组和
        int leftMax = divideAndConquer(nums, left, mid);
        int rightMax = divideAndConquer(nums, mid + 1, right);

        // 跨越中点的最大子数组和
        int crossMax = crossMaxSum(nums, left, mid, right);

        // 三者取最大
        return Math.max(Math.max(leftMax, rightMax), crossMax);
    }

    private int crossMaxSum(int[] nums, int left, int mid, int right) {
        // 从 mid 向左扫描，找最大后缀和（必须包含 nums[mid]）
        int leftSum = 0, leftMax = Integer.MIN_VALUE;
        for (int i = mid; i >= left; i--) {
            leftSum += nums[i];
            leftMax = Math.max(leftMax, leftSum);
        }

        // 从 mid+1 向右扫描，找最大前缀和（必须包含 nums[mid+1]）
        int rightSum = 0, rightMax = Integer.MIN_VALUE;
        for (int i = mid + 1; i <= right; i++) {
            rightSum += nums[i];
            rightMax = Math.max(rightMax, rightSum);
        }

        return leftMax + rightMax;
    }
}
```

**复杂度**：
- $T(n) = 2T(n/2) + O(n)$（`crossMaxSum` 需要 $O(n)$）
- 用主定理：$a=2, b=2, f(n)=O(n)$，$\log_2 2 = 1 = f(n)$ 的指数，情形二
- $T(n) = O(n \log n)$

---

## 第 3 章 Kadane 算法：动态规划的线性扫描

### 3.1 Kadane 算法的推导

**问题的子结构**：设 `dp[i]` 为"以 `nums[i]` 结尾的最大子数组和"。那么：

- `dp[i]` 要么是 `nums[i]` 本身（新开始一个子数组，不继承之前的）
- 要么是 `dp[i-1] + nums[i]`（将 `nums[i]` 追加到以 `nums[i-1]` 结尾的最大子数组后面）

**何时不继承**：当 `dp[i-1] < 0` 时，继承过来反而使和变小，不如从 `nums[i]` 重新开始。

因此：

$$dp[i] = \max(nums[i],\ dp[i-1] + nums[i]) = nums[i] + \max(0,\ dp[i-1])$$

最终答案是所有 `dp[i]` 中的最大值。

```java
// dp 版本
public int maxSubArray(int[] nums) {
    int n = nums.length;
    int[] dp = new int[n];
    dp[0] = nums[0];
    int maxSum = dp[0];

    for (int i = 1; i < n; i++) {
        // 要么不继承（从 nums[i] 重新开始），要么继承并延伸
        dp[i] = Math.max(nums[i], dp[i-1] + nums[i]);
        maxSum = Math.max(maxSum, dp[i]);
    }
    return maxSum;
}
```

由于 `dp[i]` 只依赖 `dp[i-1]`，可以将空间优化到 $O(1)$：

```java
// 空间优化版本：Kadane 算法的标准形式
public int maxSubArray(int[] nums) {
    int currentMax = nums[0];  // 以当前位置结尾的最大子数组和
    int globalMax = nums[0];   // 全局最大子数组和

    for (int i = 1; i < n; i++) {
        // 如果继承过来的 currentMax < 0，不如从 nums[i] 重新开始
        currentMax = Math.max(nums[i], currentMax + nums[i]);
        globalMax = Math.max(globalMax, currentMax);
    }
    return globalMax;
}
```

### 3.2 Kadane 与分治的深层联系

表面上，Kadane 是动态规划，分治是另一种范式，它们似乎没有关系。但从"子数组结构"的角度看，两者其实在处理同一件事：

**分治**：最大子数组要么在左，要么在右，要么跨越中点。跨越中点的处理是关键，需要 $O(n)$ 的扫描。

**Kadane**：`dp[i] = max(nums[i], dp[i-1] + nums[i])` 中的 `dp[i-1] < 0` 时重置，本质上就是在说"以 `i` 结尾的子数组，在 `i` 之前某个位置开始的那个'跨越点'"——当 `dp[i-1] < 0` 时，最优的左端点就是 `i` 本身（不延伸）。

**两者的本质区别**：分治用"中点分割"的视角，强制处理跨越问题；Kadane 用"以每个点结尾"的视角，通过局部最优累积全局最优。Kadane 更像是贪心：在每个位置做一个局部的最优选择（继承 or 重置），并且这个局部选择可以证明导向全局最优。

> [!note] 设计哲学：两种解法的面试价值
> 在面试中，如果面试官只要求 $O(n)$ 解法，写 Kadane 即可。如果面试官要求"不用 DP，用分治"，则写第二章的解法。更高阶的考察是：能不能解释为什么分治是 $O(n \log n)$，为什么 Kadane 是 $O(n)$，以及两者在思维上的联系。

---

## 第 4 章 LeetCode 152：乘积最大子数组

### 4.1 题目

**LeetCode 152 - Maximum Product Subarray**（中等）

给你一个整数数组 `nums`，请你找出数组中乘积最大的非空连续子数组（该子数组中至少包含一个数字），并返回该子数组所对应的乘积。

```
输入: nums = [2, 3, -2, 4]
输出: 6
解释: 子数组 [2,3] 有最大乘积 6

输入: nums = [-2, 0, -1]
输出: 0
解释: 结果不能为 2，因为 [-2,-1] 不是子数组（中间有 -1 不连续... 等等，这里 [-2,-1] 其实包含 0）
实际上，子数组 [0] 的乘积为 0 是最大的
```

### 4.2 为什么 Kadane 不能直接套用

Kadane 算法的核心是：`dp[i] = max(nums[i], dp[i-1] + nums[i])`，即"当前累积值为负时，直接重置"。

对于乘积问题，"重置"的时机更复杂：

**乘积的特殊性**：
1. **两个负数相乘得正**：一个很大的负数，乘以另一个负数，可能变成很大的正数。所以负数不应该简单地"丢弃"。
2. **乘以 0 强制重置**：`nums[i] = 0` 时，无论之前乘积多大，以 `i` 结尾的子数组乘积为 0，强制重置。

**关键洞察**：需要同时追踪"以 `i` 结尾的最大乘积"和"以 `i` 结尾的最小乘积"。

- 最小乘积可能是很大的负数。当 `nums[i+1]` 是负数时，最小乘积 × 负数 = 最大正乘积。
- 因此，最大乘积和最小乘积要同时维护，互相可能在下一步"翻转"。

### 4.3 同时追踪最大值和最小值

```java
public int maxProduct(int[] nums) {
    int maxProd = nums[0];   // 以当前位置结尾的最大乘积
    int minProd = nums[0];   // 以当前位置结尾的最小乘积
    int result = nums[0];    // 全局最大乘积

    for (int i = 1; i < nums.length; i++) {
        // 当 nums[i] 为负数时，max 和 min 会交换角色
        // 因此先保存 maxProd，防止更新 maxProd 后影响 minProd 的计算
        int tempMax = maxProd;

        // 三种选择：
        // 1. 从 nums[i] 重新开始（前面的乘积太小或为 0）
        // 2. 继承最大乘积并延伸（nums[i] > 0 时，正 × 正 = 正）
        // 3. 继承最小乘积并延伸（nums[i] < 0 时，负 × 负 = 正）
        maxProd = Math.max(nums[i], Math.max(tempMax * nums[i], minProd * nums[i]));
        minProd = Math.min(nums[i], Math.min(tempMax * nums[i], minProd * nums[i]));

        result = Math.max(result, maxProd);
    }

    return result;
}
```

**正确性关键**：`int tempMax = maxProd` 保存旧的最大值，避免更新 `maxProd` 后 `minProd` 的计算用到新值（因为 `minProd` 的计算也需要用到旧的 `maxProd`）。

### 4.4 用分治思维理解 152

乘积最大子数组同样可以用分治来理解——在"跨越中点"阶段，需要从中点向两侧扩展，计算最大的前缀乘积和后缀乘积。但与加法不同，乘积的最大化取决于**负数的数量**（偶数个负数乘积为正），因此跨越中点的处理需要维护最大正乘积和最小（绝对值最大）负乘积。

不过，对于这道题，Kadane 风格的 DP 解法在编码上更简洁，面试中更推荐。

---

## 第 5 章 LeetCode 918：环形子数组的最大和

### 5.1 题目

**LeetCode 918 - Maximum Sum Circular Subarray**（中等）

给定一个长度为 `n` 的**环形整数数组** `nums`，返回 `nums` 的非空**子数组**的最大可能和。

环形数组意味着数组的末端将会与开端相连呈环状。形式上，`nums[i]` 的下一个元素是 `nums[(i + 1) % n]`，`nums[i]` 的前一个元素是 `nums[(i - 1 + n) % n]`。

```
输入: nums = [1, -2, 3, -2]
输出: 3
解释: 从子数组 [3] 得到最大和 3

输入: nums = [5, -3, 5]
输出: 10
解释: 从子数组 [5, 5]（环形，跨越头尾）得到最大和 10

输入: nums = [-3, -2, -3]
输出: -2
解释: 从子数组 [-2] 得到最大和 -2
```

### 5.2 关键观察：环形子数组只有两种情形

这道题的难点在于"环形"——子数组可能跨越数组的头尾。但换个角度想：

**情形 1：最大子数组不跨越边界**

就是普通的最大子数组问题，用 Kadane 算法求解，设结果为 `maxKadane`。

**情形 2：最大子数组跨越边界**

跨越边界的子数组 = 数组总和 - 不跨越边界的**最小**子数组。

举例：`nums = [5, -3, 5]`，总和 = 7。不跨越边界的最小子数组是 `[-3]`，和为 -3。跨越边界的最大和 = 7 - (-3) = 10，对应 `[5, 5]`（头尾各取一个 5）。

**为什么这个转化是正确的？**

设最大跨越子数组是 `nums[i..n-1] + nums[0..j]`（即从 `i` 到末尾，再从开头到 `j`）。它的补集是 `nums[j+1..i-1]`，和为 `total - S(i, j)`。要最大化 `S(i, j)`，等价于最小化补集 `S(j+1, i-1)`——而补集是一个不跨越边界的普通子数组，其最小值可以用"最小 Kadane"求得。

> [!warning] 特殊情形：全为负数
> 如果数组所有元素都是负数，`minKadane` 等于整个数组（全部取完），此时 `total - minKadane = 0`，对应空子数组——但题目要求非空子数组。
>
> 处理方式：当 `total == minKadane` 时（说明最小子数组就是整个数组，即全为负数），跨越情形不适用，答案只能是 `maxKadane`。

### 5.3 完整实现

```java
class Solution {
    public int maxSubarraySumCircular(int[] nums) {
        int total = 0;       // 数组总和
        int maxKadane = nums[0];  // 情形 1：最大不跨越子数组
        int minKadane = nums[0];  // 用于计算情形 2
        int currentMax = nums[0];
        int currentMin = nums[0];

        for (int i = 1; i < nums.length; i++) {
            total += nums[i];

            // 情形 1：最大不跨越子数组（标准 Kadane）
            currentMax = Math.max(nums[i], currentMax + nums[i]);
            maxKadane = Math.max(maxKadane, currentMax);

            // 最小不跨越子数组（"最小 Kadane"）
            currentMin = Math.min(nums[i], currentMin + nums[i]);
            minKadane = Math.min(minKadane, currentMin);
        }

        // 别忘了 total 要加上 nums[0]（上面的循环从 i=1 开始）
        total += nums[0];

        // 情形 2：最大跨越子数组 = total - minKadane
        // 特殊情形：若 total == minKadane，说明全为负数，跨越情形不适用
        int maxCircular = (total == minKadane) ? Integer.MIN_VALUE : total - minKadane;

        return Math.max(maxKadane, maxCircular);
    }
}
```

等等，上面的 total 计算有误，让我重写：

```java
class Solution {
    public int maxSubarraySumCircular(int[] nums) {
        int n = nums.length;
        int total = 0;
        int maxKadane = Integer.MIN_VALUE;
        int minKadane = Integer.MAX_VALUE;
        int currentMax = 0;
        int currentMin = 0;

        for (int num : nums) {
            total += num;

            // 情形 1：标准 Kadane（最大不跨越子数组）
            currentMax = Math.max(num, currentMax + num);
            maxKadane = Math.max(maxKadane, currentMax);

            // 情形 2 的辅助：最小 Kadane（最小不跨越子数组）
            currentMin = Math.min(num, currentMin + num);
            minKadane = Math.min(minKadane, currentMin);
        }

        // 若 total == minKadane，说明全为负数（最小子数组 = 整个数组），跨越不适用
        if (total == minKadane) {
            return maxKadane;
        }

        // 取情形 1 和情形 2 的最大值
        return Math.max(maxKadane, total - minKadane);
    }
}
```

### 5.4 手工验证

以 `nums = [5, -3, 5]` 为例：

**Kadane 过程**：
- `num=5`: `currentMax=5`, `maxKadane=5`; `currentMin=5`, `minKadane=5`; `total=5`
- `num=-3`: `currentMax=max(-3, 5-3)=2`, `maxKadane=5`; `currentMin=min(-3, 5-3)=-3`（错误，应是 `min(-3, 5+(-3))=min(-3,2)=-3`，即 `currentMin=-3`）`minKadane=-3`; `total=2`
- `num=5`: `currentMax=max(5, 2+5)=7`, `maxKadane=7`; `currentMin=min(5, -3+5)=min(5,2)=2`, `minKadane=-3`; `total=7`

**结果**：
- `total == minKadane`？$7 \neq -3$，不是全负数
- `maxKadane = 7`（情形 1，子数组 `[5,-3,5]`）
- `total - minKadane = 7 - (-3) = 10`（情形 2，跨越子数组 `[5,5]`）
- 答案：`max(7, 10) = 10`，正确。

---

## 第 6 章 三道题横向对比

### 6.1 核心技法总结

| 题目 | 核心技法 | Kadane 的"扩展" |
|------|---------|----------------|
| LeetCode 53（最大子数组和） | 标准 Kadane：继承 or 重置（当 < 0 时） | 无，基础形式 |
| LeetCode 152（乘积最大子数组） | 同时维护 `maxProd` 和 `minProd`（负负得正） | 一维状态扩展为二维 |
| LeetCode 918（环形最大和） | 最大不跨越（Kadane）+ 总和 - 最小不跨越 | 对偶技巧：最大跨越 = 总和 - 最小不跨越 |

### 6.2 分治解法在这三道题中的地位

| 题目 | 分治解法是否可行 | 分治 vs Kadane |
|------|--------------|--------------|
| LeetCode 53 | 可行，$O(n \log n)$ | Kadane 更优（$O(n)$） |
| LeetCode 152 | 可行，但合并阶段需处理负数乘积的翻转，复杂 | Kadane 风格 DP 更简洁 |
| LeetCode 918 | 可行，但环形结构处理麻烦 | Kadane + 对偶技巧更清晰 |

**结论**：对于最大子数组系列问题，Kadane（及其变体）是面试的首选答案。分治解法的价值在于"理解问题的另一个视角"，以及当题目明确要求分治时（如某些变体要求记录子数组的起始和终止位置时，分治更容易追踪）。

### 6.3 一个进阶视角：Kadane 是"在线"算法

Kadane 算法有一个重要特性：它是**在线（online）算法**——处理每个元素时，只需要已处理部分的 $O(1)$ 状态（`currentMax` 和 `maxKadane`），无需向前或向后看任何数量的元素。

这使得 Kadane 可以用于流式场景：数据流不断产生新元素，随时能查询"迄今为止的最大子数组和"。

相比之下，分治解法是**离线（offline）**的——需要知道整个数组才能从中点切分，不适合流式场景。

---

## 第 7 章 本文核心结论

1. **Kadane 的本质是局部状态的最优选择**：`dp[i] = max(nums[i], dp[i-1] + nums[i])` 中，当 `dp[i-1] < 0` 时重置，这是一个"贪心"决策——每次选择局部最优（继承 vs 重置），并且可以证明这导向全局最优。

2. **分治解法的价值在于理解"跨越中点"模式**：`crossMaxSum` 的思想——从中点向两侧独立扩展——是分治在数组问题上的标准手法，也是后续理解"分治在二叉树上"的桥梁。

3. **乘积变形的关键：维护最大和最小两个状态**：负数乘负得正，因此不能简单丢弃历史最小值。"同时维护最大和最小"是处理乘积型动态规划的通用技巧。

4. **环形变形的关键：对偶技巧**：最大跨越子数组 = 总和 - 最小不跨越子数组，将"困难的跨越情形"转化为"简单的不跨越情形"，是降维思考的典型应用。

5. **面试策略**：先写 Kadane（$O(n)$，简洁），若面试官追问"分治如何解"，再解释跨越中点的处理。能在两种视角间自由切换，展示对问题的深刻理解。
