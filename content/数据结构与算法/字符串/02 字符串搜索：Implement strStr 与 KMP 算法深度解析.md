---
title: "字符串搜索：Implement strStr 与 KMP 算法深度解析"
date: 2026-04-27
tags: [KMP, LeetCode, 字符串, 字符串匹配, 数据结构, 算法, 面试]
aliases: [KMP算法, 字符串搜索, strStr, next数组]
---

# 字符串搜索：Implement strStr 与 KMP 算法深度解析

## 摘要

LeetCode 28（Implement strStr）是字符串搜索的经典入门题：在文本串 `haystack` 中找到模式串 `needle` 第一次出现的位置。朴素算法时间复杂度 $O(mn)$，在最坏情况下（如 `haystack = "aaaaaaaa"`, `needle = "aaaab"`）性能极差。KMP 算法（Knuth-Morris-Pratt）通过预处理模式串的**最长相等前后缀（LPS）信息**，将失配时的回退量精确计算出来，使总时间复杂度降到 $O(m+n)$。理解 KMP 的 `next` 数组构建，是区分"刷过题"和"真正掌握算法"的分水岭，本篇将从原理到代码逐步推导。

---

## 第 1 章 朴素字符串匹配

### 1.1 题目

**LeetCode 28 - Find the Index of the First Occurrence in a String**（中等）

给你两个字符串 `haystack` 和 `needle`，请你在 `haystack` 字符串中找出 `needle` 字符串的第一个匹配项的下标（下标从 0 开始）。如果 `needle` 不是 `haystack` 的一部分，则返回 -1。

```
输入: haystack = "sadbutsad", needle = "sad"  → 输出: 0
输入: haystack = "leetcode", needle = "leeto" → 输出: -1
```

### 1.2 朴素匹配（Brute Force）

**思路**：对 `haystack` 中每个可能的起始位置 `i`，检查从 `i` 开始的子串是否等于 `needle`。

```java
public int strStr(String haystack, String needle) {
    int n = haystack.length(), m = needle.length();
    if (m == 0) return 0; // 空 needle 约定返回 0
    
    for (int i = 0; i <= n - m; i++) { // 注意上界是 n-m，不是 n
        int j = 0;
        while (j < m && haystack.charAt(i + j) == needle.charAt(j)) {
            j++;
        }
        if (j == m) return i; // 完全匹配
    }
    return -1;
}
```

**复杂度**：时间 $O(mn)$，空间 $O(1)$。

### 1.3 朴素匹配的缺陷

考虑这个场景：

```
haystack = "aaaaaaaaaaab"（11个a + 1个b）
needle   = "aaaab"（4个a + 1个b）
```

每次从位置 `i` 开始匹配，`needle` 前 4 个字符 `aaaa` 都能匹配，直到第 5 个字符 `b` 与 `a` 不匹配，然后 `i++`，重新从头开始匹配。每次都要比较 5 次，总计大约 $11 \times 5 = 55$ 次。

**浪费在哪里**：每次失配后，`i` 只移动一步，但我们已经知道 `needle[0..3]` 都是 `a`，而 `haystack[i+1..i+3]` 也是 `a`（我们已经比较过了），没必要重头再比。

KMP 的核心思想就是**利用已知的匹配信息，跳过不可能成功的对齐位置**。

---

## 第 2 章 KMP 算法：从直觉到原理

### 2.1 核心直觉：匹配失败时，不从头再来

当模式串在位置 `j` 发生失配时，朴素算法将文本指针回退、模式指针从 0 重新开始。KMP 的核心观察是：

**模式串的前缀中，已经匹配成功的部分包含了"自相似"信息**——如果已匹配的前缀 `needle[0..j-1]` 有一个既是前缀又是后缀的子串，那么我们可以直接利用这个重叠，把模式指针回退到这个重叠的末尾，而不是从 0 开始。

这听起来很抽象，来看一个具体例子：

```
needle = "ABCABD"

haystack: ... A B C A B E ...
needle:       A B C A B D
                        ↑
            在这里失配（'E' != 'D'）
```

失配时，我们已经匹配了 `needle[0..4] = "ABCAB"`。朴素算法会让模式串整体右移一位，重新匹配。但注意：`"ABCAB"` 的**前缀 `"AB"` 和后缀 `"AB"` 相同**（长度为 2 的最长相等前后缀）。

这意味着，当前 haystack 中已经匹配的末尾 `"AB"`，与 `needle` 的开头 `"AB"` 相同！我们不需要从头匹配，直接将模式指针跳到位置 2（`"AB"` 之后），继续匹配即可：

```
haystack: ... A B C A B E ...
needle:           A B C A B D
                    ↑
            从这里继续（j=2）
```

这就是 KMP 的精髓：**`next[j]` 存储的就是 `needle[0..j-1]` 的最长相等前后缀的长度**，失配时将 `j` 回退到 `next[j]` 而不是 0。

### 2.2 前缀函数（next 数组）的定义

**定义**：`next[j]` = `needle[0..j-1]` 的最长相等真前后缀的长度。

"真前后缀"意味着不包括字符串自身（即 `"ABCAB"` 的最长相等真前后缀是 `"AB"`，长度为 2，而不是 `"ABCAB"` 本身）。

来看几个例子：

| j | needle[0..j-1] | 所有相等前后缀 | next[j] |
|---|---------------|--------------|---------|
| 0 | "" | 无 | 0 |
| 1 | "A" | 无（空串不算） | 0 |
| 2 | "AB" | 无（"A"≠"B"） | 0 |
| 3 | "ABC" | 无 | 0 |
| 4 | "ABCA" | "A"（长度1）| 1 |
| 5 | "ABCAB" | "A"、"AB"（最长为"AB"，长度2）| 2 |
| 6 | "ABCABD" | 无（"ABD"≠"ABC"，"D"≠"A"） | 0 |

因此 `next = [0, 0, 0, 0, 1, 2, 0]`。

---

## 第 3 章 next 数组的构建

### 3.1 关键推导

构建 `next` 数组本身就是一个"模式串与自身匹配"的问题！

设已知 `next[j] = k`（即 `needle[0..j-1]` 的最长相等前后缀长度为 `k`），现在要求 `next[j+1]`：

**情况 1**：如果 `needle[j] == needle[k]`，则 `needle[0..j]` 的最长相等前后缀长度是 `k+1`，即 `next[j+1] = k + 1`。

**情况 2**：如果 `needle[j] != needle[k]`，需要缩短前后缀，看 `needle[0..k-1]` 的最长相等前后缀（即 `next[k]`），用 `k = next[k]` 继续尝试，直到 `k == 0` 或者找到匹配。

这个递推关系与 KMP 匹配过程的思路完全一致——构建 `next` 数组本身就是 KMP 的精华！

### 3.2 代码实现

```java
// 构建 next 数组（前缀函数）
private int[] buildNext(String needle) {
    int m = needle.length();
    int[] next = new int[m];
    next[0] = 0; // 单字符没有真前后缀
    
    int k = 0; // k 是当前已匹配的前缀长度
    for (int j = 1; j < m; j++) {
        // 失配时，利用已有的 next 信息回退
        while (k > 0 && needle.charAt(j) != needle.charAt(k)) {
            k = next[k - 1]; // 回退到上一个可能的前缀末尾
        }
        
        if (needle.charAt(j) == needle.charAt(k)) {
            k++; // 匹配成功，k 前进
        }
        
        next[j] = k; // 记录 next[j]
    }
    return next;
}
```

**逐步演示**（`needle = "ABCABD"`）：

```
j=0: next[0]=0（初始化）
j=1: k=0, needle[1]='B' != needle[0]='A', k=0; next[1]=0
j=2: k=0, needle[2]='C' != needle[0]='A', k=0; next[2]=0
j=3: k=0, needle[3]='A' == needle[0]='A', k=1; next[3]=1
j=4: k=1, needle[4]='B' == needle[1]='B', k=2; next[4]=2
j=5: k=2, needle[5]='D' != needle[2]='C'
       回退: k = next[1] = 0
       k=0, needle[5]='D' != needle[0]='A', k=0; next[5]=0

next = [0, 0, 0, 1, 2, 0] ✓
```

### 3.3 完整 KMP 匹配

有了 `next` 数组，KMP 匹配过程如下：

```java
public int strStr(String haystack, String needle) {
    int n = haystack.length(), m = needle.length();
    if (m == 0) return 0;
    
    int[] next = buildNext(needle);
    int j = 0; // 模式串已匹配的长度
    
    for (int i = 0; i < n; i++) {
        // 失配时，利用 next 数组回退
        while (j > 0 && haystack.charAt(i) != needle.charAt(j)) {
            j = next[j - 1];
        }
        
        if (haystack.charAt(i) == needle.charAt(j)) {
            j++;
        }
        
        if (j == m) {
            return i - m + 1; // 匹配成功，返回起始位置
        }
    }
    
    return -1;
}

private int[] buildNext(String needle) {
    int m = needle.length();
    int[] next = new int[m];
    int k = 0;
    for (int j = 1; j < m; j++) {
        while (k > 0 && needle.charAt(j) != needle.charAt(k)) {
            k = next[k - 1];
        }
        if (needle.charAt(j) == needle.charAt(k)) {
            k++;
        }
        next[j] = k;
    }
    return next;
}
```

**复杂度**：
- 预处理 `next` 数组：$O(m)$
- 匹配过程：$O(n)$
- **总计：$O(m + n)$**，空间 $O(m)$

---

## 第 4 章 KMP 的正确性与复杂度分析

### 4.1 为什么 KMP 是线性的

**关键观察**：`j` 的增加由 `i` 的推进驱动（`i` 每次 `+1`，`j` 最多 `+1`）；而 `j` 的减少（`j = next[j-1]`）每次至少减少 1，且总减少量不超过总增加量。

因此，`j` 的增加总量 $\leq n$，减少总量 $\leq n$，整个匹配过程比较次数 $\leq 2n = O(n)$。

类似地，构建 `next` 数组时 `k` 的变化量总计 $\leq 2m = O(m)$。

KMP 总时间复杂度 $O(m + n)$，空间 $O(m)$。

### 4.2 与朴素算法的对比

| 场景 | 朴素算法 | KMP |
|------|---------|-----|
| 最好情况 | $O(n)$（每次第一个字符就失配） | $O(n+m)$ |
| 最坏情况 | $O(mn)$（大量重复字符） | $O(n+m)$ |
| 平均情况 | $O(n)$（实际很少退化） | $O(n+m)$ |

在实际工程中，朴素匹配由于缓存友好性和代码简单，性能往往不差；但对于大量重复字符的字符串（如 DNA 序列、二进制串），KMP 的优势明显。

### 4.3 Java 内置的 `indexOf` 用的是什么算法

Java 的 `String.indexOf()` 在 JDK 中使用的是**朴素算法**（配合一些优化，如 Boyer-Moore-Horspool 的启发式跳跃）。原因是：
1. 朴素算法在随机字符串上性能接近 $O(n)$（失配很快）
2. 代码简单，JIT 编译器能高度优化
3. KMP 的 $O(m)$ 额外空间在频繁调用时有开销

理解这一点，说明算法在工程中的应用不只看理论复杂度。

---

## 第 5 章 next 数组的另一种定义与变种

### 5.1 "失配跳转"定义与"前缀长度"定义的区别

网上有两种流行的 KMP `next` 数组定义，常导致混乱：

**定义 A（本文使用）**：`next[j]` = `needle[0..j-1]` 的最长相等真前后缀长度（从 0 开始）

```
needle = "ABCABD"
next   = [0, 0, 0, 1, 2, 0]
```

**定义 B（另一种）**：`next[j]` = 失配时应跳转到的下一个匹配位置（即 `next[j] = 前缀长度 - 1`，有时用 -1 表示跳到起始）

```
needle = "ABCABD"
next   = [-1, 0, 0, 0, 1, 2]（左移一位，起始为 -1）
```

两种定义本质相同，代码细节略有差异。理解了一种，换成另一种只需微调下标。

### 5.2 KMP 的变种：最短重复单元（LeetCode 459）

**LeetCode 459 - Repeated Substring Pattern**：判断字符串是否由某个子串重复多次构成。

巧妙利用 `next` 数组的性质：如果字符串 `s` 由长度为 `d` 的子串重复构成，则 `next[n-1]` 的值是 `n - d`，且 `n % d == 0`。

```java
public boolean repeatedSubstringPattern(String s) {
    int n = s.length();
    int[] next = buildNext(s);
    int longest = next[n - 1]; // 最长相等前后缀长度
    int d = n - longest;        // 最短重复单元长度
    return d < n && n % d == 0; // d < n 排除整体（不能是它自身），n % d == 0 确认能整除
}
```

---

## 第 6 章 面试应对策略

### 6.1 面试中 strStr 的标准回答路径

1. **给出朴素解法**（2分钟）：双层循环，说明时间 $O(mn)$
2. **分析缺陷**：举出"大量重复字符"的最坏场景
3. **引入 KMP**：说明 KMP 的核心思想（利用已匹配的前后缀信息避免回退）
4. **解释 next 数组**：能从头推导出构建逻辑
5. **给出完整代码**：分开 `buildNext` 和匹配函数
6. **分析复杂度**：$O(m+n)$ 时间，$O(m)$ 空间

### 6.2 面试官最常追问的问题

**Q：为什么 `while (j > 0 && ...) j = next[j-1]`，而不是 `if`？**

A：因为单次回退后，新的 `j` 对应的字符可能仍然不匹配，需要继续回退，所以用 `while` 循环直到找到匹配或 `j == 0`。

**Q：`next[j-1]` 为什么是 `j-1` 而不是 `j`？**

A：当前位置 `j` 失配，我们要利用已成功匹配的 `needle[0..j-1]` 的前后缀信息，即 `next[j-1]`（`needle[0..j-1]` 的最长相等前后缀长度），而不是 `next[j]`（`needle[0..j]` 的值，此时 `j` 还没更新）。

**Q：KMP 和 Rabin-Karp 有什么区别？**

A：KMP 基于字符比较，通过前缀函数跳过无效对齐；Rabin-Karp 基于哈希，将模式串和文本窗口的哈希值比较，哈希匹配时再验证。Rabin-Karp 对多模式串搜索更友好，KMP 对单模式串搜索更稳定（无哈希冲突风险）。

---

## 下一篇预告

[[03 字符串解析：atoi、Add Binary 与进位模拟]] 将进入字符串解析的领域。String to Integer（atoi）是考察状态机设计的经典题，需要处理前导空格、符号位、溢出等多个边界；Add Binary 是二进制加法的字符串模拟，与链表的两数相加有异曲同工之妙。两道题合在一起，构建了"从字符串到数值"和"数值计算在字符串上的模拟"这两个互补的解题模式。
