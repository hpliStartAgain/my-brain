---
title: "最长回文子串：中心扩展与 Manacher 算法"
date: 2026-04-27
tags: [LeetCode, Manacher, 动态规划, 回文, 字符串, 数据结构, 算法, 面试]
aliases: [最长回文子串, 中心扩展法, Manacher算法, LeetCode 5]
---

# 最长回文子串：中心扩展与 Manacher 算法

## 摘要

LeetCode 5（Longest Palindromic Substring）是字符串算法中的经典高频题，考察回文子串的识别与搜索。本篇系统讲解三种解法的演进：暴力 $O(n^3)$ → 动态规划 $O(n^2)$ → 中心扩展 $O(n^2)$（空间 $O(1)$）→ Manacher $O(n)$。中心扩展是面试的标准答案，而 Manacher 算法通过"镜像利用"技巧将时间降到线性，是字符串领域最优雅的 $O(n)$ 优化案例，理解它能帮助你从根本上掌握回文的结构性质。

---

## 第 1 章 题目分析

### 1.1 题目

**LeetCode 5 - Longest Palindromic Substring**（中等）

给你一个字符串 `s`，找到 `s` 中最长的回文子串。

```
输入: s = "babad" → 输出: "bab"（"aba" 也是正确答案）
输入: s = "cbbd"  → 输出: "bb"
输入: s = "a"     → 输出: "a"
输入: s = "ac"    → 输出: "a"（或 "c"）
```

### 1.2 回文子串的结构分析

找最长回文子串的关键观察：**每个回文都有一个中心**（奇数长度回文的中心是一个字符，偶数长度回文的中心是两个字符之间的"缝隙"）。

```
"racecar"：中心是 'e'（奇数长度）
"abba"：中心在两个 'b' 之间（偶数长度）
```

一个长度为 $n$ 的字符串，共有 $2n - 1$ 个可能的中心（$n$ 个字符 + $n-1$ 个缝隙）。如果从每个中心向外扩展，检查最大回文半径，就能找到以该中心为中心的最长回文。

---

## 第 2 章 方法一：暴力 $O(n^3)$

枚举所有子串（共 $O(n^2)$ 个），逐一判断是否为回文（每次 $O(n)$）。

```java
public String longestPalindrome(String s) {
    int n = s.length();
    String best = s.substring(0, 1); // 单字符是回文
    
    for (int i = 0; i < n; i++) {
        for (int j = i + 1; j < n; j++) {
            if (j - i + 1 > best.length() && isPalindrome(s, i, j)) {
                best = s.substring(i, j + 1);
            }
        }
    }
    return best;
}

private boolean isPalindrome(String s, int left, int right) {
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) return false;
        left++;
        right--;
    }
    return true;
}
```

$O(n^3)$ 时间，$n = 1000$ 时约 $10^9$ 次操作，面试中会超时，仅作为推导出发点。

---

## 第 3 章 方法二：动态规划 $O(n^2)$

### 3.1 状态定义

`dp[i][j]` = 子串 `s[i..j]` 是否是回文。

### 3.2 状态转移方程

若 `s[i] == s[j]` 且 `dp[i+1][j-1]` 为真，则 `dp[i][j]` 为真。

边界条件：
- 单字符：`dp[i][i] = true`
- 双字符：`dp[i][i+1] = (s[i] == s[i+1])`

### 3.3 遍历顺序

由于 `dp[i][j]` 依赖于 `dp[i+1][j-1]`（内层子串），必须**按子串长度从小到大**遍历：

```java
public String longestPalindrome(String s) {
    int n = s.length();
    boolean[][] dp = new boolean[n][n];
    int start = 0, maxLen = 1;
    
    // 长度为 1 的子串
    for (int i = 0; i < n; i++) dp[i][i] = true;
    
    // 长度为 2 的子串
    for (int i = 0; i < n - 1; i++) {
        if (s.charAt(i) == s.charAt(i + 1)) {
            dp[i][i + 1] = true;
            start = i;
            maxLen = 2;
        }
    }
    
    // 长度 3 到 n
    for (int len = 3; len <= n; len++) {
        for (int i = 0; i <= n - len; i++) {
            int j = i + len - 1;
            if (s.charAt(i) == s.charAt(j) && dp[i + 1][j - 1]) {
                dp[i][j] = true;
                if (len > maxLen) {
                    start = i;
                    maxLen = len;
                }
            }
        }
    }
    
    return s.substring(start, start + maxLen);
}
```

**复杂度**：时间 $O(n^2)$，空间 $O(n^2)$（`dp` 数组）。

---

## 第 4 章 方法三：中心扩展 $O(n^2)$，空间 $O(1)$

### 4.1 核心思路

对 $2n - 1$ 个中心，分别向外扩展，记录最长的回文：

```java
public String longestPalindrome(String s) {
    int n = s.length();
    int start = 0, maxLen = 1;
    
    for (int center = 0; center < 2 * n - 1; center++) {
        // 把 2n-1 个中心映射到左右位置：
        // center 为偶数 → 单字符中心，left = right = center/2
        // center 为奇数 → 缝隙中心，left = center/2, right = center/2 + 1
        int left = center / 2;
        int right = left + (center % 2);
        
        // 从中心向外扩展
        while (left >= 0 && right < n && s.charAt(left) == s.charAt(right)) {
            left--;
            right++;
        }
        // 扩展结束后，left+1 和 right-1 是当前最长回文的边界
        
        int len = right - left - 1; // 回文长度
        if (len > maxLen) {
            maxLen = len;
            start = left + 1;
        }
    }
    
    return s.substring(start, start + maxLen);
}
```

**手动验证**（`s = "cbbd"`）：

```
center=0（'c'）: left=0, right=0; 扩展: 'b'!='c'停; len=1
center=1（缝隙cb）: left=0, right=1; 'c'!='b'停; len=1
center=2（'b'）: left=1, right=1; 扩展→left=0('c'), right=2('b'), 'c'!='b'停; len=1... 

等等，'b'[1]扩展：
  left=1, right=1: s[1]='b'==s[1]='b', left=0, right=2
  left=0, right=2: s[0]='c'!=s[2]='b', 停止
  len = 2-0-1 = 1? 不对...

让我重算：
  while循环开始时 left=right=1（'b'）
  循环条件成立（1>=0, 1<4, 'b'=='b'），left--, right++ → left=0, right=2
  继续：s[0]='c', s[2]='b', 不等，退出
  扩展后 left=0, right=2
  len = right - left - 1 = 2 - 0 - 1 = 1

center=3（缝隙bb）: left=1, right=2; s[1]='b'==s[2]='b', left=0, right=3
  s[0]='c'!=s[3]='d', 停止
  len = 3-0-1 = 2 → maxLen=2, start=1

center=4（'b'）: left=2, right=2; 'b'扩展→left=1, right=3; 'b'!='d', 停
  len = 3-1-1=1

center=5（缝隙bd）: left=2, right=3; 'b'!='d', 停; len=1
center=6（'d'）: left=3, right=3; 扩展→左越界; len=1

结果：start=1, maxLen=2 → s.substring(1,3) = "bb" ✓
```

**复杂度**：时间 $O(n^2)$，空间 $O(1)$。这是面试中的标准答案，要能流畅写出。

---

## 第 5 章 方法四：Manacher 算法 $O(n)$

### 5.1 为什么还能更快

中心扩展法对每个中心独立扩展，没有复用之前的计算结果。Manacher 的核心思想是：**利用已经找到的最长回文的"镜像对称性"，直接初始化新中心的回文半径，跳过不必要的扩展**。

### 5.2 预处理：统一奇偶

为了统一处理奇偶长度的回文，Manacher 在每个字符之间（以及首尾）插入特殊字符 `#`：

```
原串: "cbbd"
新串: "#c#b#b#d#"（长度 2n+1 = 9）
```

插入 `#` 后，所有回文都变成**奇数长度**（`#bb#` 在新串中是 `#b#b#`，仍然奇数）。

**注意**：在这个变换下，原串每个字符对应新串下标 `2i+1`（从 0 开始），原串缝隙对应新串下标 `2i`。

### 5.3 Manacher 的核心：利用右边界

维护两个变量：
- `center`：当前已知的、向右延伸最远的回文的中心位置
- `right`：对应回文的右边界（`right = center + radius[center]`）

对于新位置 `i`（`i < right`），利用镜像位置 `mirror = 2 * center - i` 的半径来初始化 `radius[i]`：
- 如果 `mirror` 的回文完全在 `[center - radius[center], right]` 内，则 `radius[i] = radius[mirror]`
- 如果 `mirror` 的回文超出了左边界，则 `radius[i] = right - i`（边界限制）
- 之后尝试继续扩展 `i`

```java
public String longestPalindrome(String s) {
    // 预处理：在字符间插入 #
    StringBuilder sb = new StringBuilder("^"); // 前哨，防越界
    for (char c : s.toCharArray()) {
        sb.append('#').append(c);
    }
    sb.append("#$"); // 后哨
    String t = sb.toString(); // "^#c#b#b#d#$"
    
    int n = t.length();
    int[] p = new int[n]; // p[i] = 以 i 为中心的回文半径（不含中心本身）
    int center = 0, right = 0;
    int maxLen = 0, maxCenter = 0;
    
    for (int i = 1; i < n - 1; i++) {
        // 利用镜像初始化
        if (i < right) {
            int mirror = 2 * center - i;
            p[i] = Math.min(right - i, p[mirror]);
        }
        
        // 尝试扩展
        while (t.charAt(i + p[i] + 1) == t.charAt(i - p[i] - 1)) {
            p[i]++;
        }
        
        // 更新最右边界
        if (i + p[i] > right) {
            center = i;
            right = i + p[i];
        }
        
        // 记录最大回文
        if (p[i] > maxLen) {
            maxLen = p[i];
            maxCenter = i;
        }
    }
    
    // 从变换后的坐标还原到原串坐标
    int start = (maxCenter - maxLen) / 2;
    return s.substring(start, start + maxLen);
}
```

**前哨字符的作用**：在头部加 `^`，尾部加 `$`，保证扩展时不会越界（`^` 和 `$` 不与任何字符相等，所以扩展会自动停止），省去了边界检查。

**复杂度**：时间 $O(n)$（每个字符最多被访问常数次），空间 $O(n)$（`p` 数组和变换后的字符串）。

### 5.4 Manacher 的直觉理解

用一个比喻：想象你从左到右扫描墙壁，记录自己能"看到"的最远位置（`right`）。

- 当你到达位置 `i`（在你的视野内，`i < right`）时，你的左边有一面"镜子"（对称中心 `center`）。通过镜像，你已经知道 `i` 的对面（`mirror`）有一个大小为 `p[mirror]` 的回文。
- **如果镜像回文完全在你的视野内**，那 `i` 的回文大小至少是 `p[mirror]`（镜像对称保证了）。
- **如果镜像回文超出了左边界**，那你只能确认到 `right - i`（视野边界），需要继续扩展验证。
- 每次扩展成功，`right` 可能向右延伸，视野越来越宽。

这个"视野不断向右扩展，从不退缩"的特性，保证了每个字符最多被扩展一次（摊还分析），总时间 $O(n)$。

---

## 第 6 章 四种方法对比与面试建议

| 方法 | 时间 | 空间 | 推荐度 |
|------|------|------|--------|
| 暴力 | $O(n^3)$ | $O(1)$ | 推导出发点，不要在面试中直接给 |
| 动态规划 | $O(n^2)$ | $O(n^2)$ | 思路清晰，但空间大 |
| 中心扩展 | $O(n^2)$ | $O(1)$ | 面试标准答案，必须能流畅写出 |
| Manacher | $O(n)$ | $O(n)$ | 进阶加分，能解释原理最佳 |

**面试策略**：

1. 先说"暴力是 $O(n^3)$，可以优化"
2. 简述 DP 思路（`dp[i][j]` 依赖 `dp[i+1][j-1]`），说明空间 $O(n^2)$
3. 给出中心扩展（**必须能手写正确**），说明空间降到 $O(1)$
4. 若面试官追问"有没有更优的算法"，介绍 Manacher 的核心思想（镜像利用），不要求手写完整代码

> [!note] 中心扩展的代码细节最容易出错
> 最常见的错误：奇偶中心的边界计算，`right - left - 1` 和 `left + 1` 的偏移。建议在纸上验证 `"aba"`（奇）和 `"abba"`（偶）两个最小用例，确保代码正确。

---

## 下一篇预告

[[05 动态规划字符串匹配：正则表达式与通配符]] 将进入字符串动态规划的深水区：LeetCode 10（Regular Expression Matching，正则表达式匹配）和 LeetCode 44（Wildcard Matching，通配符匹配）。这两道题都被标为困难，核心都是二维 DP，但`.*` 和 `?*` 的语义差异导致状态转移方程大相径庭。彻底理解这两道题，等于掌握了字符串 DP 最难的范式。
