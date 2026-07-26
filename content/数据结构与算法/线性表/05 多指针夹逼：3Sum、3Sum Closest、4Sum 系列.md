---
title: "多指针夹逼：3Sum、3Sum Closest、4Sum 系列"
date: 2026-04-27
tags: [LeetCode, 双指针, 排序, 数据结构, 数组, 算法, 面试]
aliases: [3Sum, 三数之和, kSum, 多数之和]
---

# 多指针夹逼：3Sum、3Sum Closest、4Sum 系列

## 摘要

Three Sum（LeetCode 15）是面试中最高频的中等题之一，也是很多候选人的"翻车现场"——不是因为思路难，而是因为**去重逻辑极易写错**。本文以 15（3Sum）、16（3Sum Closest）、18（4Sum）三道题为主线，深入讲解"排序 + 固定外层 + 内层双指针夹逼"的完整解题框架，尤其重点拆解去重的每一个细节，以及如何将这个框架泛化到任意 k 数之和问题。

---

## 第 1 章 问题本质：降维归约

### 1.1 从 Two Sum 到 k-Sum 的递推关系

[[04 哈希表与连续序列：Two Sum 与 Longest Consecutive Sequence|Two Sum]] 的核心是"在数组中找两个数之和等于目标值"。3Sum 是"找三个数之和等于 0"，4Sum 是"找四个数之和等于目标值"。

这类题有一个统一的**降维思路**：

$$\text{k-Sum}(n, \text{target}) = \text{枚举第一个数} \times (k-1)\text{-Sum}(n-1, \text{target} - \text{nums}[i])$$

即：固定最外层的一个数（通过 `for` 循环枚举），把问题规约为在剩余数组中求 $(k-1)$ 数之和。不断降维，直到 $k=2$，用[[双指针]]或哈希表解决。

| k | 最终算法 | 总时间复杂度 |
|---|----------|-------------|
| 2 | 双指针 $O(n)$ | $O(n)$ |
| 3 | 枚举 $\times$ 双指针 | $O(n^2)$ |
| 4 | 枚举 $\times$ 枚举 $\times$ 双指针 | $O(n^3)$ |
| k | 递归降维 | $O(n^{k-1})$ |

这是算法设计中非常典型的"问题分解"思路，值得深刻体会。

### 1.2 为什么要排序

这类题的前置步骤都是**排序**，原因有三：
1. **双指针夹逼需要有序性**：只有有序数组才能保证"当 sum < target 时，移动左指针可以让 sum 增大"这个单调性
2. **去重依赖有序性**：排序后相同的元素相邻，可以用简单的"跳过与前一个相同的元素"实现去重
3. **代价可接受**：排序 $O(n \log n)$，总体复杂度仍由双层或三层循环主导，排序不是瓶颈

---

## 第 2 章 LeetCode 15：三数之和

### 2.1 题目

**LeetCode 15 - 3Sum**（中等）

给你一个整数数组 `nums`，判断是否存在三元组 `[nums[i], nums[j], nums[k]]`，满足 `i != j != k` 且 `nums[i] + nums[j] + nums[k] == 0`。

**返回所有不重复的三元组**。

```
输入: nums = [-1,0,1,2,-1,-4]
输出: [[-1,-1,2],[-1,0,1]]

输入: nums = [0,1,1]
输出: []

输入: nums = [0,0,0]
输出: [[0,0,0]]
```

注意题目要求**不重复的三元组**，这是难点。

### 2.2 算法框架

**第一步：排序**

```
[-1, 0, 1, 2, -1, -4]  排序后  →  [-4, -1, -1, 0, 1, 2]
```

**第二步：固定第一个数，双指针夹逼**

外层 `for` 循环枚举 `nums[i]`（第一个数），然后在 `i+1` 到 `n-1` 的范围内，用左指针 `left = i+1` 和右指针 `right = n-1` 夹逼，寻找 `nums[left] + nums[right] == -nums[i]`（即三数之和为 0）。

```
nums = [-4, -1, -1, 0, 1, 2]

i=0, nums[i]=-4: 在 [-1,-1,0,1,2] 中找两数之和为 4
  left=1,right=5: -1+2=1 < 4, left++
  left=2,right=5: -1+2=1 < 4, left++
  left=3,right=5: 0+2=2 < 4, left++
  left=4,right=5: 1+2=3 < 4, left++
  left=right=5: 退出 → 无解

i=1, nums[i]=-1: 在 [-1,0,1,2] 中找两数之和为 1
  left=2,right=5: -1+2=1 == 1 → 找到 [-1,-1,2]，left++,right--
  left=3,right=4: 0+1=1 == 1 → 找到 [-1,0,1]，left++,right--
  left=right=4: 退出

i=2, nums[i]=-1: 与 nums[i=1]=-1 相同 → 跳过（去重）

i=3, nums[i]=0: 在 [1,2] 中找两数之和为 0
  left=4,right=5: 1+2=3 > 0, right--
  left=4,right=4: 退出 → 无解

i=4,5: 剩余元素不足3个（或 nums[i]>0 可以提前终止），跳过
```

### 2.3 去重逻辑详解

这是本题最容易出错的部分，需要在两个地方去重：

**去重点 1：外层循环跳过重复的 nums[i]**

```java
for (int i = 0; i < nums.length - 2; i++) {
    if (i > 0 && nums[i] == nums[i - 1]) continue; // 跳过重复的第一个数
    // ...
}
```

**为什么是 `i > 0`？** 如果写 `i >= 0`，那 `i=0` 也会被跳过（和 `nums[-1]` 比较，会越界或永远不满足），所以要从 `i=1` 开始才能去重。

**为什么和 `nums[i-1]` 而非 `nums[i+1]` 比较？** 我们要跳过"与前一个 i 重复的情况"。如果 `nums[i] == nums[i-1]`，那么以 `nums[i]` 为第一个数找到的所有三元组，以 `nums[i-1]` 为第一个数时已经全找过了，重复，跳过。

**去重点 2：找到解后跳过重复的 nums[left] 和 nums[right]**

```java
if (nums[left] + nums[right] == -nums[i]) {
    result.add(Arrays.asList(nums[i], nums[left], nums[right]));
    // 跳过相同的 left 值
    while (left < right && nums[left] == nums[left + 1]) left++;
    // 跳过相同的 right 值
    while (left < right && nums[right] == nums[right - 1]) right--;
    // 移动到下一个不重复的位置
    left++;
    right--;
}
```

**为什么要在收集答案后才去重，而不是之前？** 因为如果先跳过再判断，可能跳过了有效答案。必须先记录当前的 `(left, right)` 是一个解，然后再跳过后续重复的。

**示意图**：
```
nums = [−2, 0, 0, 2, 2]，i=0（nums[i]=-2，找两数之和为2）

left=1(0), right=4(2): 0+2=2 == 2，收集 [-2,0,2]
  跳过重复 left: nums[1]=nums[2]=0，left++ → left=2
  跳过重复 right: nums[3]=nums[4]=2，right-- → right=3
  left++, right-- → left=3, right=2, 退出
```

若没有去重，`left=2(0), right=3(2)` 也会匹配，产生重复的 `[-2,0,2]`。

### 2.4 完整代码

```java
public List<List<Integer>> threeSum(int[] nums) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums); // 关键前置步骤
    
    for (int i = 0; i < nums.length - 2; i++) {
        // 优化：nums[i] > 0 时，三数之和一定 > 0，提前终止
        if (nums[i] > 0) break;
        
        // 跳过重复的第一个数
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        
        int left = i + 1, right = nums.length - 1;
        
        while (left < right) {
            int sum = nums[i] + nums[left] + nums[right];
            
            if (sum == 0) {
                result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                // 跳过重复的 left 和 right
                while (left < right && nums[left] == nums[left + 1]) left++;
                while (left < right && nums[right] == nums[right - 1]) right--;
                left++;
                right--;
            } else if (sum < 0) {
                left++;  // sum 太小，左指针右移增大 sum
            } else {
                right--; // sum 太大，右指针左移减小 sum
            }
        }
    }
    
    return result;
}
```

**复杂度**：时间 $O(n^2)$（排序 $O(n \log n)$ + 双层循环 $O(n^2)$），空间 $O(1)$（不计结果）。

### 2.5 几个容易漏掉的优化

1. **`if (nums[i] > 0) break`**：排序后，如果当前最小的数已经大于 0，三数之和不可能为 0，提前终止。
2. **外层循环的上界是 `nums.length - 2`**：至少要留 2 个元素给 left 和 right，不然越界。
3. **`i > 0` 条件**：防止第一轮（`i=0`）做无意义的比较。

---

## 第 3 章 LeetCode 16：最接近的三数之和

### 3.1 题目

**LeetCode 16 - 3Sum Closest**（中等）

给你一个整数数组 `nums` 和一个目标值 `target`，找出 `nums` 中和最接近 `target` 的三个整数，返回这三个数的和。**假设每组输入只存在唯一答案**。

```
输入: nums = [-1,2,1,-4], target = 1
输出: 2（[-1,2,1] 的和是 2，是最接近 1 的）
```

### 3.2 思路

与 3Sum 框架完全相同，区别在于：
- 不再寻找 `sum == 0`，而是寻找 `|sum - target|` 最小的 sum
- 不需要去重（返回的是一个数值，不是三元组列表）

```java
public int threeSumClosest(int[] nums, int target) {
    Arrays.sort(nums);
    int closest = nums[0] + nums[1] + nums[2]; // 初始化为前三个数之和
    
    for (int i = 0; i < nums.length - 2; i++) {
        int left = i + 1, right = nums.length - 1;
        
        while (left < right) {
            int sum = nums[i] + nums[left] + nums[right];
            
            // 更新最近的和
            if (Math.abs(sum - target) < Math.abs(closest - target)) {
                closest = sum;
            }
            
            if (sum == target) {
                return sum; // 完全相等，无需继续
            } else if (sum < target) {
                left++;
            } else {
                right--;
            }
        }
    }
    
    return closest;
}
```

**复杂度**：时间 $O(n^2)$，空间 $O(1)$。

这道题逻辑比 3Sum 简单，但面试时常被当作变体考察。关键点是**初始化 `closest`**：必须初始化为一个合法的三数之和（如前三个数的和），不能初始化为 `Integer.MAX_VALUE`，因为后面的 `sum - target` 可能溢出。

---

## 第 4 章 LeetCode 18：四数之和

### 4.1 题目

**LeetCode 18 - 4Sum**（中等）

给你一个整数数组 `nums` 和一个目标值 `target`，请你返回所有满足以下条件的不重复四元组 `[nums[a], nums[b], nums[c], nums[d]]`：
- `a, b, c, d` 各不相同
- `nums[a] + nums[b] + nums[c] + nums[d] == target`

```
输入: nums = [1,0,-1,0,-2,2], target = 0
输出: [[-2,-1,1,2],[-2,0,0,2],[-1,0,0,1]]

输入: nums = [2,2,2,2,2], target = 8
输出: [[2,2,2,2]]
```

### 4.2 在 3Sum 的基础上再套一层

4Sum = 外层固定一个数 + 3Sum 框架（内层固定一个数 + 双指针）。

```java
public List<List<Integer>> fourSum(int[] nums, int target) {
    List<List<Integer>> result = new ArrayList<>();
    Arrays.sort(nums);
    int n = nums.length;
    
    for (int i = 0; i < n - 3; i++) {
        // 剪枝：最小四数之和 > target，后面只会更大
        if ((long)nums[i] + nums[i+1] + nums[i+2] + nums[i+3] > target) break;
        // 剪枝：当前 nums[i] 加最大三数之和 < target，nums[i] 太小，跳过
        if ((long)nums[i] + nums[n-1] + nums[n-2] + nums[n-3] < target) continue;
        
        // 外层去重
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        
        for (int j = i + 1; j < n - 2; j++) {
            // 内层剪枝
            if ((long)nums[i] + nums[j] + nums[j+1] + nums[j+2] > target) break;
            if ((long)nums[i] + nums[j] + nums[n-1] + nums[n-2] < target) continue;
            
            // 内层去重
            if (j > i + 1 && nums[j] == nums[j - 1]) continue;
            
            int left = j + 1, right = n - 1;
            
            while (left < right) {
                long sum = (long)nums[i] + nums[j] + nums[left] + nums[right];
                
                if (sum == target) {
                    result.add(Arrays.asList(nums[i], nums[j], nums[left], nums[right]));
                    while (left < right && nums[left] == nums[left + 1]) left++;
                    while (left < right && nums[right] == nums[right - 1]) right--;
                    left++;
                    right--;
                } else if (sum < target) {
                    left++;
                } else {
                    right--;
                }
            }
        }
    }
    
    return result;
}
```

**注意：使用 `long` 防止溢出**。`target` 可以是 `Integer.MIN_VALUE` 或 `Integer.MAX_VALUE`，四个 `int` 相加可能溢出，需要用 `long`。

### 4.3 内层去重的条件

内层循环中，`j` 的去重条件是 `j > i + 1`（而不是 `j > 0`），因为 `j` 的起点是 `i+1`，`j` 最小合法值是 `i+1`，要保证 `j` 至少从第二个值开始才去重（第一次出现的值不应该被跳过）。

类比外层 `i > 0` 的逻辑：`j` 相对于其起点 `i+1` 的"首次出现"不应被跳过，只有 `j > i+1` 时才需要和前一个 `j` 比较是否重复。

---

## 第 5 章 k-Sum 通用递归框架

### 5.1 代码实现

如果面试官让你实现任意 k 数之和，可以用递归框架：

```java
public List<List<Integer>> kSum(int[] nums, int target, int k) {
    Arrays.sort(nums);
    return kSumHelper(nums, target, k, 0);
}

private List<List<Integer>> kSumHelper(int[] nums, long target, int k, int start) {
    List<List<Integer>> result = new ArrayList<>();
    
    // 基础情况：k=2，用双指针
    if (k == 2) {
        int left = start, right = nums.length - 1;
        while (left < right) {
            long sum = nums[left] + nums[right];
            if (sum == target) {
                result.add(new ArrayList<>(Arrays.asList(nums[left], nums[right])));
                while (left < right && nums[left] == nums[left+1]) left++;
                while (left < right && nums[right] == nums[right-1]) right--;
                left++; right--;
            } else if (sum < target) {
                left++;
            } else {
                right--;
            }
        }
        return result;
    }
    
    // 递归：枚举第一个数，递归求 (k-1)-Sum
    for (int i = start; i <= nums.length - k; i++) {
        if (i > start && nums[i] == nums[i-1]) continue; // 去重
        
        List<List<Integer>> subResult = kSumHelper(nums, target - nums[i], k - 1, i + 1);
        for (List<Integer> sub : subResult) {
            List<Integer> combined = new ArrayList<>();
            combined.add(nums[i]);
            combined.addAll(sub);
            result.add(combined);
        }
    }
    
    return result;
}
```

**复杂度**：时间 $O(n^{k-1})$（k 层循环，最内层双指针 $O(n)$），空间 $O(k)$（递归栈深度）。

### 5.2 剪枝的作用

上面 4Sum 代码里的剪枝（提前 `break` 或 `continue`）在实际面试中不是必须的，但能显著提升性能：

- **`break`（当最小可能和 > target）**：数组有序，当前 `nums[i]` 加上接下来最小的几个数之和已经超过 `target`，后续只会更大，直接终止当前层循环。
- **`continue`（当最大可能和 < target）**：当前 `nums[i]` 加上接下来最大的几个数之和还不够 `target`，当前 `nums[i]` 太小，跳过当前 `i`，尝试下一个。

这两个剪枝对于重复元素多的情况效果显著（可以跳过大量无效搜索），对于 LeetCode 这类有严格时间限制的场景，有时是通过测试的关键。

---

## 第 6 章 去重逻辑的全面梳理

本篇最核心的难点是去重，最后做一个系统性总结：

### 6.1 去重的位置和逻辑

对于 3Sum 中的三个指针 `i`、`left`、`right`：

| 指针 | 去重时机 | 代码 | 解释 |
|------|----------|------|------|
| `i` | 循环开始时 | `if (i > 0 && nums[i] == nums[i-1]) continue;` | 跳过与前一个 i 相同的情况，避免找到重复的三元组 |
| `left` | 找到答案后，在 left++ 之前 | `while (left < right && nums[left] == nums[left+1]) left++;` | 跳过与当前 left 相同的值，避免同一组解被重复收集 |
| `right` | 找到答案后，在 right-- 之前 | `while (left < right && nums[right] == nums[right-1]) right--;` | 同上，针对 right |

### 6.2 一个常见的错误写法

```java
// 错误！在外层去重时多写了 i == 0 的情况
if (nums[i] == nums[i - 1]) continue; // 当 i=0 时，nums[-1] 越界！

// 正确写法
if (i > 0 && nums[i] == nums[i - 1]) continue;
```

```java
// 错误！去重时比较的方向搞反了
if (i > 0 && nums[i] == nums[i + 1]) continue; // 这是在跳过"后面的 i"，而不是"当前这个 i 是重复的"
// 这会导致：如果数组是 [-1, -1, 0]，i=0 时 nums[0]==-1==nums[1]==-1，会跳过 i=0
// 但 i=0 是第一次遇到 -1，应该处理，不应该跳过！

// 正确：跳过的是"当前 i 与前一个 i 相同"的情况（即当前 i 是重复的）
if (i > 0 && nums[i] == nums[i - 1]) continue;
```

这个方向错误是最常见的面试 bug，务必牢记：**去重时，比较的是当前元素和前一个元素（`nums[i]` vs `nums[i-1]`），跳过的是"重复出现的后者"**。

---

## 下一篇预告

[[06 全排列与字典序：Next Permutation、Permutation Sequence、Gray Code]] 将进入一个完全不同的数组专题：排列与序列生成。这类题考察的不是搜索或求和，而是**对字典序和数学规律的理解**。Next Permutation 是很多排列问题的基础操作，Permutation Sequence 引入了阶乘数系（Factoradic Number System），Gray Code 则涉及二进制的优雅变换。
