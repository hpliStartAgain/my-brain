---
title: "最大子数组问题：Kadane 算法与分治视角"
date: 2026-04-28
tags: [LeetCode, 分治, 动态规划, 算法, 面试]
keywords: [Kadane, 最大子数组]
aliases: [最大子数组, Kadane算法, 53, 152, 918]
---

# 最大子数组问题：Kadane 算法与分治视角

**摘要：**

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

```go
// crossMaxSum 跨越中点的最大子数组和 = 最大左侧后缀和 + 最大右侧前缀和
func crossMaxSum(nums []int, left, mid, right int) int {
	// 从 mid 向左扩展，找最大的左侧后缀和（必须包含 nums[mid]）
	leftMax, sum := math.MinInt32/2, 0
	for i := mid; i >= left; i-- {
		sum += nums[i]
		leftMax = max(leftMax, sum)
	}
	// 从 mid+1 向右扩展，找最大的右侧前缀和（必须包含 nums[mid+1]）
	rightMax := math.MinInt32 / 2
	sum = 0
	for i := mid + 1; i <= right; i++ {
		sum += nums[i]
		rightMax = max(rightMax, sum)
	}
	return leftMax + rightMax
}
```

**为什么这是正确的？**

跨越中点的子数组必须包含 `nums[mid]` 和 `nums[mid+1]`（至少各包含一个，因为必须跨越中点）。左侧部分是从 `mid` 向左扩展的某个后缀，右侧部分是从 `mid+1` 向右扩展的某个前缀。由于这两部分是独立的（一个向左，一个向右），各取最大值即可。

### 2.2 完整分治实现

```go
// maxSubArrayDC LeetCode 53 分治解法：T(n) = 2T(n/2) + O(n) = O(n log n)
func maxSubArrayDC(nums []int) int {
	var divideAndConquer func(nums []int, left, right int) int
	divideAndConquer = func(nums []int, left, right int) int {
		if left == right {
			return nums[left] // 基础情形：只有一个元素
		}
		mid := left + (right-left)/2

		// 递归求左半部分和右半部分的最大子数组和
		leftMax := divideAndConquer(nums, left, mid)
		rightMax := divideAndConquer(nums, mid+1, right)

		// 跨越中点的最大子数组和，三者取最大
		crossMax := crossMaxSum(nums, left, mid, right)
		return max(leftMax, max(rightMax, crossMax))
	}
	return divideAndConquer(nums, 0, len(nums)-1)
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

```go
// maxSubArrayDP LeetCode 53 动态规划解法：dp[i] 为以 nums[i] 结尾的最大子数组和
// 时间复杂度：O(n)，空间复杂度：O(n)（可压缩为 O(1)）
func maxSubArrayDP(nums []int) int {
	n := len(nums)
	dp := make([]int, n)
	dp[0] = nums[0]
	maxSum := dp[0]

	for i := 1; i < n; i++ {
		// 要么不继承（从 nums[i] 重新开始），要么继承并延伸
		dp[i] = max(nums[i], dp[i-1]+nums[i])
		maxSum = max(maxSum, dp[i])
	}
	return maxSum
}
```

由于 `dp[i]` 只依赖 `dp[i-1]`，可以将空间优化到 $O(1)$：

```go
// maxSubArray LeetCode 53：Kadane 算法标准形式，时间 O(n)，空间 O(1)
func maxSubArray(nums []int) int {
	currentMax, globalMax := nums[0], nums[0]

	for i := 1; i < len(nums); i++ {
		// 如果继承过来的 currentMax < 0，不如从 nums[i] 重新开始
		currentMax = max(nums[i], currentMax+nums[i])
		globalMax = max(globalMax, currentMax)
	}
	return globalMax
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

```go
// maxProduct LeetCode 152：同时维护以当前位置结尾的最大/最小乘积（负负得正）
// 时间复杂度：O(n)，空间复杂度：O(1)
func maxProduct(nums []int) int {
	maxProd, minProd, result := nums[0], nums[0], nums[0]

	for i := 1; i < len(nums); i++ {
		v := nums[i]
		// 先保存 maxProd，防止更新 maxProd 后影响 minProd 的计算
		tempMax := maxProd
		// 三种选择：从 v 重新开始 / 继承最大乘积延伸 / 继承最小乘积延伸（负负得正）
		maxProd = max(v, max(tempMax*v, minProd*v))
		minProd = min(v, min(tempMax*v, minProd*v))
		result = max(result, maxProd)
	}
	return result
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

```go
// maxSubarraySumCircular LeetCode 918：环形子数组的最大和（正难则反：total - 最小子数组和）
// 时间复杂度：O(n)，空间复杂度：O(1)
func maxSubarraySumCircular(nums []int) int {
	total := nums[0]
	maxKadane, minKadane := nums[0], nums[0]
	currentMax, currentMin := nums[0], nums[0]

	for i := 1; i < len(nums); i++ {
		v := nums[i]
		total += v

		// 情形 1：最大不跨越子数组（标准 Kadane）
		currentMax = max(v, currentMax+v)
		maxKadane = max(maxKadane, currentMax)

		// 情形 2 辅助：最小不跨越子数组（"最小 Kadane"）
		currentMin = min(v, currentMin+v)
		minKadane = min(minKadane, currentMin)
	}

	// 若 total == minKadane，说明全为负数（最小子数组 = 整个数组），跨越情形不适用
	if total == minKadane {
		return maxKadane
	}
	return max(maxKadane, total-minKadane)
}
```

等等，上面的 total 计算有误，让我重写：

```go
// maxSubarraySumCircularV2 LeetCode 918 精简版：单循环同时维护最大/最小 Kadane
func maxSubarraySumCircularV2(nums []int) int {
	total := 0
	maxKadane, minKadane := math.MinInt32/2, math.MaxInt32/2
	currentMax, currentMin := 0, 0

	for _, num := range nums {
		total += num

		// 情形 1：标准 Kadane（最大不跨越子数组）
		currentMax = max(num, currentMax+num)
		maxKadane = max(maxKadane, currentMax)

		// 情形 2 的辅助：最小 Kadane（最小不跨越子数组）
		currentMin = min(num, currentMin+num)
		minKadane = min(minKadane, currentMin)
	}

	// 若 total == minKadane，说明全为负数（最小子数组 = 整个数组），跨越不适用
	if total == minKadane {
		return maxKadane
	}
	return max(maxKadane, total-minKadane)
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


---

## 第 8 章 分治的进阶变体：CDQ 分治与线段树分治入门

### 8.1 CDQ 分治：把"离线二维偏序"压进归并的骨架

在第 2 章与第 7 章中，我们用归并分治与树状数组分别解决了**一维偏序（逆序对）**统计。当约束升级为**二维偏序**——譬如统计满足 $i < j$ 且 $a_i < a_j$ 且 $b_i < b_j$ 的三元组个数（**三维偏序问题，经典题为洛谷 P3810【陌上花开】**）——就需要 **CDQ 分治（陈丹琦分治）**登场：
1. 把所有元素按第一维 $a$ 排序；
2. 分治切分：递归处理左半区与右半区内部的贡献；
3. **跨区贡献**：左半区与右半区之间，第一维 $a$ 天然满足"左半区任意元素 $<$ 右半区任意元素"，于是跨区统计退化为一个**二维偏序问题**（按第二维 $b$ 归并排序，同时用树状数组统计第三维 $c$）；
4. 每层跨区统计耗时 $O(m \log m)$，总时间 $O(n \log^2 n)$。

CDQ 分治的精髓在于：**把"多维偏序"逐维剥离——第一维交给排序，第二维交给归并，第三维交给树状数组**，每一层分治只消化一个维度。

### 8.2 线段树分治：把"时间区间存在性"离线化

当问题涉及**"每条边只在一段时间区间内存在"**的动态图连通性查询（如**离线动态图连通性，经典题为洛谷 P5787 二分图 / 飞行员配对**）时，**线段树分治（Segment Tree on Time）**是标准解法：
1. 把每条边的存活时间区间 $[l, r]$ 按线段树的标准方式拆解为 $O(\log T)$ 个节点，挂载到对应节点上；
2. **DFS 遍历时间线段树**：进入节点时用**可撤销并查集（按秩合并，不路径压缩）**把挂载在该节点的边全部加入；离开节点时按逆序撤销；
3. 在叶子节点处回答该时刻的查询。

```go
package main

// DSUWithRollback 可撤销并查集（按秩合并，记录撤销日志）
type DSUWithRollback struct {
	parent []int
	rank   []int
	stack  []int // 撤销日志：记录每次合并前的秩变化点
}

func NewDSU(n int) *DSUWithRollback {
	p := make([]int, n)
	for i := range p {
		p[i] = i
	}
	return &DSUWithRollback{parent: p, rank: make([]int, n)}
}

func (d *DSUWithRollback) find(x int) int {
	for d.parent[x] != x {
		x = d.parent[x]
	}
	return x
}

func (d *DSUWithRollback) union(a, b int) bool {
	ra, rb := d.find(a), d.find(b)
	if ra == rb {
		return false
	}
	if d.rank[ra] < d.rank[rb] {
		ra, rb = rb, ra
	}
	d.stack = append(d.stack, rb) // 记录被挂到 ra 下的旧根 rb
	d.parent[rb] = ra
	if d.rank[ra] == d.rank[rb] {
		d.rank[ra]++
		d.stack = append(d.stack, -1) // -1 表示秩也发生了变化
	}
	return true
}

func (d *DSUWithRollback) rollback(steps int) {
	for steps > 0 {
		v := d.stack[len(d.stack)-1]
		d.stack = d.stack[:len(d.stack)-1]
		if v == -1 {
			// 撤销秩增加：略（完整实现需同时记录秩旧值）
			steps--
			continue
		}
		d.parent[v] = v
		steps--
	}
}
```

### 8.3 两大变体的适用边界

| 变体 | 解决的问题类型 | 核心机制 | 复杂度 |
|------|----------------|----------|--------|
| CDQ 分治 | 多维偏序统计（离线） | 排序剥离第一维 + 归并剥离第二维 + 树状数组剥离第三维 | $O(n \log^2 n)$ |
| 线段树分治 | 时间区间存在性（离线动态图） | 边挂载到时间线段树节点 + 可撤销并查集 DFS | $O(m \log T \cdot lpha(n))$ |

两者的共同哲学是：**当在线数据结构（平衡树、LCT）过于复杂时，把问题离线化，用分治把时间或维度轴切分，让每一层的贡献统计退化为一个已知的简单问题**。这也是"分治"作为算法范式最深层的生产力——它不仅能降复杂度，还能**降问题难度等级**。

### 8.4 延伸实战：最大子数组和的分治线段树节点（LC 53 的区间查询版）

如果把第 3 章的 Kadane 问题升级为**"支持单点修改、随时查询任意区间 `[l, r]` 的最大子数组和"**（即 **LeetCode 53 的动态版，对应线段树维护区间合并信息**），每个线段树节点需要维护四个量：
- `total`：区间总和；
- `prefix`：区间内以左端点开头的最大前缀和；
- `suffix`：区间内以右端点结尾的最大后缀和；
- `best`：区间内最大子数组和。

合并左右子节点时：
- `total = L.total + R.total`
- `prefix = max(L.prefix, L.total + R.prefix)`
- `suffix = max(R.suffix, R.total + L.suffix)`
- `best = max(L.best, R.best, L.suffix + R.prefix)`

单点修改 $O(\log n)$，区间查询 $O(\log n)$——这正是分治思想在**可维护数据结构**上的终极形态。


### 8.5 延伸实战：线段树节点四元组的完整实现（LC 53 动态版）

在第 8.4 节我们给出了线段树节点四元组 `(total, prefix, suffix, best)` 的合并公式。下面给出完整实现，支持单点修改与任意区间查询：

```go
package main

type segNode struct {
	total, prefix, suffix, best int
}

type segTree struct {
	nodes []segNode
	n     int
}

func newSegTree(nums []int) *segTree {
	n := len(nums)
	t := &segTree{nodes: make([]segNode, 4*n), n: n}
	t.build(1, 0, n-1, nums)
	return t
}

func mergeSeg(l, r segNode) segNode {
	return segNode{
		total:  l.total + r.total,
		prefix: max(l.prefix, l.total+r.prefix),
		suffix: max(r.suffix, r.total+l.suffix),
		best:   max(max(l.best, r.best), l.suffix+r.prefix),
	}
}

func (t *segTree) build(node, lo, hi int, nums []int) {
	if lo == hi {
		v := nums[lo]
		t.nodes[node] = segNode{v, v, v, v}
		return
	}
	mid := (lo + hi) / 2
	t.build(2*node, lo, mid, nums)
	t.build(2*node+1, mid+1, hi, nums)
	t.nodes[node] = mergeSeg(t.nodes[2*node], t.nodes[2*node+1])
}

func (t *segTree) update(node, lo, hi, pos, val int) {
	if lo == hi {
		t.nodes[node] = segNode{val, val, val, val}
		return
	}
	mid := (lo + hi) / 2
	if pos <= mid {
		t.update(2*node, lo, mid, pos, val)
	} else {
		t.update(2*node+1, mid+1, hi, pos, val)
	}
	t.nodes[node] = mergeSeg(t.nodes[2*node], t.nodes[2*node+1])
}

func (t *segTree) query(node, lo, hi, l, r int) segNode {
	if l <= lo && hi <= r {
		return t.nodes[node]
	}
	mid := (lo + hi) / 2
	if r <= mid {
		return t.query(2*node, lo, mid, l, r)
	}
	if l > mid {
		return t.query(2*node+1, mid+1, hi, l, r)
	}
	return mergeSeg(t.query(2*node, lo, mid, l, r), t.query(2*node+1, mid+1, hi, l, r))
}
```

### 8.6 分治进阶变体的适用边界总表

| 变体 | 解决的问题类型 | 核心机制 | 复杂度 |
|------|----------------|----------|--------|
| Kadane DP（第 3 章） | 静态数组最大子数组和 | 线性扫描 + 前缀斩断 | $O(n)$ / $O(1)$ |
| 分治跨中点（第 2 章） | 静态数组最大子数组和 | 左右递归 + 跨中点合并 | $O(n \log n)$ / $O(\log n)$ |
| 线段树四元组 | **动态**数组区间最大子数组和 | 单点修改 + 区间合并 | $O(\log n)$ 每次操作 |
| CDQ 分治 | 多维偏序统计（离线） | 排序剥离一维 + 归并剥离一维 + 树状数组 | $O(n \log^2 n)$ |
| 线段树分治 | 时间区间存在性（离线动态图） | 边挂载 + 可撤销并查集 DFS | $O(m \log T)$ |


### 8.7 延伸实战：线段树四元组的完整实现（LC 53 动态版）

在第 8.4 节我们给出了线段树节点四元组 `(total, prefix, suffix, best)` 的合并公式。下面补齐完整实现，支持单点修改与任意区间查询：

```go
package main

type segNode struct {
	total, prefix, suffix, best int
}

type segTree struct {
	nodes []segNode
	n     int
}

func mergeSeg(l, r segNode) segNode {
	return segNode{
		total:  l.total + r.total,
		prefix: max(l.prefix, l.total+r.prefix),
		suffix: max(r.suffix, r.total+l.suffix),
		best:   max(max(l.best, r.best), l.suffix+r.prefix),
	}
}

func (t *segTree) build(node, lo, hi int, nums []int) {
	if lo == hi {
		v := nums[lo]
		t.nodes[node] = segNode{v, v, v, v}
		return
	}
	mid := (lo + hi) / 2
	t.build(2*node, lo, mid, nums)
	t.build(2*node+1, mid+1, hi, nums)
	t.nodes[node] = mergeSeg(t.nodes[2*node], t.nodes[2*node+1])
}

func (t *segTree) update(node, lo, hi, pos, val int) {
	if lo == hi {
		t.nodes[node] = segNode{val, val, val, val}
		return
	}
	mid := (lo + hi) / 2
	if pos <= mid {
		t.update(2*node, lo, mid, pos, val)
	} else {
		t.update(2*node+1, mid+1, hi, pos, val)
	}
	t.nodes[node] = mergeSeg(t.nodes[2*node], t.nodes[2*node+1])
}

func (t *segTree) query(node, lo, hi, l, r int) segNode {
	if l <= lo && hi <= r {
		return t.nodes[node]
	}
	mid := (lo + hi) / 2
	if r <= mid {
		return t.query(2*node, lo, mid, l, r)
	}
	if l > mid {
		return t.query(2*node+1, mid+1, hi, l, r)
	}
	return mergeSeg(t.query(2*node, lo, mid, l, r), t.query(2*node+1, mid+1, hi, l, r))
}
```

这套四元组线段树是**分治思想在可维护数据结构上的终极形态**：每一次区间查询，本质上就是在分治树上做一次"自顶向下的跨中点合并"——与本章第 2 章的静态分治解法共享同一套合并语义，只是把"一次性遍历"升级成了"可反复查询的持久化结构"。在金融行情的实时最大回撤监控、游戏服务器的区间血量统计中，它都是生产级首选。

### 8.8 三道题的算法选型终表

| 场景 | 首选算法 | 复杂度 | 升级信号 |
|------|----------|--------|----------|
| 静态数组求一次最大子数组和 | Kadane DP | $O(n)$ / $O(1)$ | 无 |
| 需要输出具体子数组区间 | Kadane DP + 起点记录 | $O(n)$ / $O(1)$ | 记录 `bestStart/bestEnd` |
| 支持单点修改 + 区间查询 | 线段树四元组 | $O(\log n)$ 每次操作 | 题目出现"更新/查询"混合操作 |
| 多维偏序统计（离线） | CDQ 分治 | $O(n \log^2 n)$ | 约束维度 $\ge 2$ 且可离线 |


### 8.9 最大子数组和的算法选型终表与工程映射

把本章三道题的选型浓缩为一张终表：静态数组求一次最大子数组和，首选 Kadane DP（$O(n)$ 时间 $O(1)$ 空间）；需要输出具体子数组区间，用 Kadane DP 配合起点记录；支持单点修改与区间查询，切换线段树四元组（$O(\log n)$ 每次操作）；多维偏序统计且可离线，上 CDQ 分治（$O(n \log^2 n)$）。在工程系统中，Kadane 的"前缀斩断"思想直接对应滑动窗口限流器的窗口重置逻辑，而线段树四元组则是金融行情实时最大回撤监控与游戏服务器区间血量统计的生产级引擎——分治与 DP 在这道题上的对照，恰好是"一次性求解"与"可维护结构"两种工程需求的分水岭。

### 8.10 Kadane 与分治的深层联系终检

Kadane 算法与分治解法并非两条孤立路线，它们在**前缀和视角**下完全统一：Kadane 的 `dp[i] = nums[i] + max(0, dp[i-1])` 等价于"维护以 i 结尾的最大后缀和"，而分治的 `crossMaxSum` 等价于"跨中点的最大后缀和 + 最大前缀和"。当题目升级为支持单点修改与区间查询时，分治骨架自然升维为线段树四元组 `(total, prefix, suffix, best)`——每一次区间查询本质上就是分治树上的一次自顶向下跨中点合并。这一"静态线性扫描、动态树形维护"的对照，正是本章希望留给读者的核心工程判据。

### 8.11 最大子数组和的变体扩展终检

把本章的变体扩展浓缩为终检：其一，输出具体区间——Kadane DP 配合起点记录，在 `currentMax` 刷新全局纪录时同时记录 `bestStart/bestEnd`；其二，环形数组——同步运行最大与最小 Kadane，`total == minKadane` 时全为负数需返回 `maxKadane`；其三，乘积版本——同时维护最大与最小乘积（负负得正），且 `0` 会斩断乘积链需从当前元素重新开始；其四，动态版本——线段树四元组支持单点修改与区间查询；其五，带长度限制——前缀和 + 单调双端队列（详见《滑动窗口》专栏第 07 篇 LC 862/918）。五个变体恰好覆盖了从静态到动态、从线性到环形、从求和到求积的完整谱系。

### 8.12 Kadane 的在线算法本质与终检

Kadane 算法是一种**在线算法（Online Algorithm）**：它逐元素扫描，每读入一个新元素只需 $O(1)$ 时间更新状态，无需预知后续内容——这一性质使它天然适配流式场景（如行情推送的实时最大浮盈监控）。分治解法则必须一次性拿到全数组才能切分，属于离线算法。两者的终检对照：在线性扫描、流式增量场景选 Kadane（$O(n)$ 时间 $O(1)$ 空间）；在需要反复区间查询、单点修改的动态场景选线段树四元组（$O(\log n)$ 每次操作）；在需要多维偏序统计的离线场景选 CDQ 分治。三种选择的分水岭，正是"数据何时到达、查询何时发生"这一工程时序问题。

### 8.13 最大子数组和的面试表达终检

在面试中阐述最大子数组和时，推荐的四段式表达是：第一段定性（"这是最大子数组和问题，暴力 $O(n^2)$，我有两条优化路线：Kadane DP $O(n)$ 与分治 $O(n \log n)$"）；第二段给出 Kadane 的状态定义与转移（"`dp[i]` 为以 `nums[i]` 结尾的最大子数组和，转移为 `max(nums[i], dp[i-1] + nums[i])`，即前缀斩断"）；第三段主动给出正确性论证（"若 `dp[i-1] < 0`，继承只会拖累当前元素，不如重新开始；归纳可得 `dp[i]` 恰为以 `i` 结尾的最优值，全局取 max 即答案"）；第四段主动点出升级信号（"若题目升级为支持单点修改与区间查询，需切换线段树四元组 `(total, prefix, suffix, best)`"）。这一"先稳拿满分、再展示边界意识"的节奏，是面试评价体系的最高分档位。

### 8.14 最大子数组和的终检口诀

把本章三道题的终检浓缩为三条口诀：口诀一，**静态求值用 Kadane（$O(n)$ 时间 $O(1)$ 空间），动态区间查询用线段树四元组（$O(\log n)$ 每次操作）**——分水岭是数据是否需要更新；口诀二，**乘积版本必须双轨（max 与 min 同步维护），负负得正靠 min 轨翻转**——单轨在负数输入下必然漏解；口诀三，**环形版本正难则反（total - 最小子数组和），但 total == minKadane 时全为负数需退回 maxKadane**——跨越情形在全负数组上会把"空数组"误判为合法子数组。三条口诀与第 8.8 节的选型终表共同构成了最大子数组和家族的完整作战地图。

### 8.15 最大子数组和的工程身影终检

把本章三道题的工程身影终检浓缩为一张表：Kadane 的"前缀斩断"直接对应滑动窗口限流器的窗口重置逻辑（累计值变负即重置窗口）；线段树四元组是金融行情实时最大回撤监控与游戏服务器区间血量统计的生产级引擎；分治跨中点合并则是并行计算中"分段统计再归并"的原型（如 Spark 的 mapPartitions + reduce 分两阶段统计最大子数组和）。三者的选型分水岭始终是"数据何时到达、查询何时发生"这一工程时序问题——静态一次性用 Kadane，动态反复查询用线段树，分布式分段统计用分治归并。
## 小结

1. **Kadane 的本质是局部状态的最优选择**：`dp[i] = max(nums[i], dp[i-1] + nums[i])` 中，当 `dp[i-1] < 0` 时重置，这是一个"贪心"决策——每次选择局部最优（继承 vs 重置），并且可以证明这导向全局最优。

2. **分治解法的价值在于理解"跨越中点"模式**：`crossMaxSum` 的思想——从中点向两侧独立扩展——是分治在数组问题上的标准手法，也是后续理解"分治在二叉树上"的桥梁。

3. **乘积变形的关键：维护最大和最小两个状态**：负数乘负得正，因此不能简单丢弃历史最小值。"同时维护最大和最小"是处理乘积型动态规划的通用技巧。

4. **环形变形的关键：对偶技巧**：最大跨越子数组 = 总和 - 最小不跨越子数组，将"困难的跨越情形"转化为"简单的不跨越情形"，是降维思考的典型应用。

5. **面试策略**：先写 Kadane（$O(n)$，简洁），若面试官追问"分治如何解"，再解释跨越中点的处理。能在两种视角间自由切换，展示对问题的深刻理解。

---

## 参考资料

1. Cormen, T. H., et al. *Introduction to Algorithms* (4th ed.). MIT Press, 2022.
2. Bentley, J. (1984). *Programming pearls: algorithm design techniques*. Communications of the ACM, 27(9), 865–873.

---

> [!note] 思考题
> 1. 在分治解法中，crossMaxSum 为什么必须同时包含 nums[mid] 与 nums[mid+1]？如果允许空段会导致什么错误？
> 2. 在 LC 152（乘积最大子数组）中，为什么必须同时维护最大与最小乘积？请构造一个反例说明只维护最大值会漏解。
> 3. 在 LC 918（环形子数组的最大和）中，当 total == minKadane 时为什么必须返回 maxKadane？请构造全负数数组验证。
