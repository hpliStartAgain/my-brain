---
title: "回文检测：Valid Palindrome 与双指针范式"
date: 2026-04-27
tags: [数据结构, 算法, 字符串, 回文, 双指针, LeetCode, 面试]
aliases: [回文字符串, Valid Palindrome, 字符串双指针]
---

# 回文检测：Valid Palindrome 与双指针范式

## 摘要

回文（Palindrome）是字符串题中最基础的概念之一：一个字符串正读反读相同。LeetCode 125（Valid Palindrome）看似是道简单题，但其中隐藏的字符过滤、大小写转换、边界处理是面试中真实考察的"工程细节"。本篇以 Valid Palindrome 为切入点，系统讲解字符串双指针的核心范式，并延伸到回文判断的各种变体（忽略大小写、忽略非字母数字、只考虑字母）。掌握这道题，等于掌握了所有双指针字符串题的基础框架。

---

## 第 1 章 回文的定义与判断思路

### 1.1 什么是回文

**回文**（Palindrome）：一个字符串 $s$，如果满足 $s[i] == s[n-1-i]$（对所有合法下标 $i$），则称 $s$ 为回文。

直觉上，回文就是"从中间折叠后左右对称"的字符串：`"racecar"`、`"abcba"`、`"a"`（单字符）、`""`（空字符串）都是回文。

### 1.2 朴素判断方法

最直观的方法：将字符串反转，与原字符串比较。

```java
// 反转法——正确但创建了额外空间
public boolean isPalindrome(String s) {
    String reversed = new StringBuilder(s).reverse().toString();
    return s.equals(reversed);
}
```

这需要 $O(n)$ 额外空间（新字符串），且创建 StringBuilder 有额外开销。

### 1.3 双指针：$O(1)$ 空间的优雅方案

**思路**：从字符串两端各放一个指针，向中间靠拢，每步比较左右字符。如果某步发现不相等，立即返回 `false`；如果两指针相遇或交叉，说明是回文。

```java
public boolean isPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) return false;
        left++;
        right--;
    }
    return true;
}
```

时间 $O(n)$，空间 $O(1)$。这是字符串回文检测的基础模板。

---

## 第 2 章 LeetCode 125：Valid Palindrome

### 2.1 题目

**LeetCode 125 - Valid Palindrome**（简单）

如果在将所有大写字符转换为小写字符、并移除所有非字母数字字符之后，短语正着读和反着读都一样，则可以认为该短语是一个回文串。

字母和数字都属于字母数字字符。

给你一个字符串 `s`，如果它是**回文串**，返回 `true`；否则，返回 `false`。

```
输入: s = "A man, a plan, a canal: Panama"
输出: true（去掉标点和空格，统一小写后："amanaplanacanalpanama"）

输入: s = "race a car"
输出: false（"raceacar" 不是回文）

输入: s = " "
输出: true（只有空格，去掉非字母数字字符后是空字符串，空串是回文）
```

### 2.2 题目的真实考察点

这道题被标为简单，但实际上在细节上有很多坑：

**坑 1：如何判断字符是"字母数字字符"**

直觉上用 `Character.isLetterOrDigit(c)` 是正确的，但有些候选人会自己写判断逻辑导致遗漏或多算字符。

**坑 2：空字符串的处理**

题目说"字母和数字都属于字母数字字符"，过滤后如果字符串为空，空字符串是回文（因为满足对称条件，没有任何字符不满足对称）。

**坑 3：大小写统一**

`'A'` 和 `'a'` 应该视为相同，需要统一转换后再比较。

**坑 4：直接在原字符串上操作，还是先预处理？**

可以预处理出一个干净的字符串再做双指针，也可以在双指针过程中跳过非法字符。两种方式都可以，但后者空间更优（$O(1)$）。

### 2.3 解法一：预处理 + 双指针

先把字符串清洗成只含小写字母数字的干净字符串，再做标准双指针：

```java
public boolean isPalindrome(String s) {
    // 预处理：保留字母数字，统一转小写
    StringBuilder sb = new StringBuilder();
    for (char c : s.toCharArray()) {
        if (Character.isLetterOrDigit(c)) {
            sb.append(Character.toLowerCase(c));
        }
    }
    String cleaned = sb.toString();
    
    // 标准双指针回文检测
    int left = 0, right = cleaned.length() - 1;
    while (left < right) {
        if (cleaned.charAt(left) != cleaned.charAt(right)) return false;
        left++;
        right--;
    }
    return true;
}
```

**复杂度**：时间 $O(n)$，空间 $O(n)$（StringBuilder）。代码清晰，推荐在面试中首先给出这个版本。

### 2.4 解法二：原地双指针（$O(1)$ 空间）

在双指针过程中，遇到非字母数字字符就跳过，不额外创建字符串：

```java
public boolean isPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    
    while (left < right) {
        // 左指针跳过非字母数字字符
        while (left < right && !Character.isLetterOrDigit(s.charAt(left))) {
            left++;
        }
        // 右指针跳过非字母数字字符
        while (left < right && !Character.isLetterOrDigit(s.charAt(right))) {
            right--;
        }
        
        // 比较（忽略大小写）
        if (Character.toLowerCase(s.charAt(left)) != Character.toLowerCase(s.charAt(right))) {
            return false;
        }
        left++;
        right--;
    }
    
    return true;
}
```

**复杂度**：时间 $O(n)$，空间 $O(1)$。

**关键细节**：内层 `while` 的条件必须加 `left < right`，否则当字符串全是非字母数字字符时（如 `" "`），左指针会越过右指针，导致访问越界。

**手动验证**（`s = "A man, a plan, a canal: Panama"`）：

```
left=0('A'), right=29('a')
  跳过左侧非法: 'A' 是合法的，不跳
  跳过右侧非法: 'a' 是合法的，不跳
  比较: toLower('A')='a' == toLower('a')='a' ✓
  left=1, right=28

left=1(' '), right=28('m')
  跳过左侧: ' ' 非法，left=2('m')
  跳过右侧: 'm' 合法
  比较: 'm' == 'm' ✓
  left=3, right=27

...（以此类推）
```

### 2.5 两种解法的权衡

| 维度 | 解法一（预处理） | 解法二（原地） |
|------|----------------|--------------|
| 时间复杂度 | $O(n)$ | $O(n)$ |
| 空间复杂度 | $O(n)$ | $O(1)$ |
| 代码清晰度 | 高（逻辑分离） | 中（双层 while 嵌套） |
| 面试推荐 | 首选展示 | 追问空间优化时给出 |

在面试中，先给出解法一（清晰），面试官追问"能否不用额外空间"时给出解法二，这样展示了你的解题层次感。

---

## 第 3 章 字符辨别工具的底层逻辑

### 3.1 为什么用 `Character.isLetterOrDigit`

Java 中 `Character` 类提供了一系列静态方法：

| 方法 | 功能 |
|------|------|
| `isLetter(c)` | 是否是字母（含 Unicode 字母） |
| `isDigit(c)` | 是否是数字（含 Unicode 数字） |
| `isLetterOrDigit(c)` | 是否是字母或数字 |
| `isAlphabetic(c)` | 是否是字母（与 `isLetter` 类似但更严格） |
| `isLowerCase(c)` | 是否是小写字母 |
| `isUpperCase(c)` | 是否是大写字母 |
| `toLowerCase(c)` | 转小写 |
| `toUpperCase(c)` | 转大写 |

**自己实现的简洁版本**（只考虑 ASCII，面试中常用）：

```java
private boolean isAlphanumeric(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

private char toLower(char c) {
    return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
}
```

`'a' - 'A' = 97 - 65 = 32`，所以大写转小写只需加 32（在 ASCII 范围内有效）。

### 3.2 字符比较的三种方式

```java
// 方式 1：直接比较 char
if (s.charAt(i) == s.charAt(j)) { ... }

// 方式 2：忽略大小写
if (Character.toLowerCase(s.charAt(i)) == Character.toLowerCase(s.charAt(j))) { ... }

// 方式 3：转成 String 比较（不推荐，创建临时对象）
if (String.valueOf(s.charAt(i)).equalsIgnoreCase(String.valueOf(s.charAt(j)))) { ... }
```

面试中优先用方式 2，明确表达"忽略大小写"的意图。

---

## 第 4 章 回文变体题一览

掌握了 Valid Palindrome，以下变体题应当能快速解决：

### 4.1 LeetCode 680：Valid Palindrome II

允许最多删除一个字符，判断是否能成为回文。

**思路**：双指针夹逼，遇到不匹配时，尝试跳过左字符或跳过右字符，看两种情况哪个能形成回文（即子字符串 `s[left+1..right]` 或 `s[left..right-1]` 是回文）。

```java
public boolean validPalindrome(String s) {
    int left = 0, right = s.length() - 1;
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) {
            // 尝试删左或删右
            return isPalindromeRange(s, left+1, right) || isPalindromeRange(s, left, right-1);
        }
        left++;
        right--;
    }
    return true;
}

private boolean isPalindromeRange(String s, int left, int right) {
    while (left < right) {
        if (s.charAt(left) != s.charAt(right)) return false;
        left++;
        right--;
    }
    return true;
}
```

### 4.2 回文数（LeetCode 9）

不将数字转换为字符串，判断整数是否是回文。

**思路**：将数字后半段反转，与前半段比较（注意奇数位数和偶数位数的处理差异）。

```java
public boolean isPalindrome(int x) {
    if (x < 0 || (x % 10 == 0 && x != 0)) return false;
    int reversed = 0;
    while (x > reversed) {
        reversed = reversed * 10 + x % 10;
        x /= 10;
    }
    return x == reversed || x == reversed / 10; // 奇数位: 中间位在 reversed 中
}
```

---

## 第 5 章 双指针字符串范式总结

Valid Palindrome 是字符串双指针的最简单例子，这个模式在字符串题中极为通用：

**双指针对向夹逼**适用于：
- 回文检测（125、680、9）
- 反转字符串（344）
- 三数之和（15）
- 接雨水（42）

**核心框架**：

```java
int left = 0, right = s.length() - 1;
while (left < right) {
    // （可选）跳过不需要的字符
    while (left < right && skip(s.charAt(left))) left++;
    while (left < right && skip(s.charAt(right))) right--;
    
    // 处理当前 left 和 right 位置
    if (!match(s.charAt(left), s.charAt(right))) return false;
    
    left++;
    right--;
}
return true;
```

这个框架几乎可以直接套用到所有双指针字符串问题，理解它比记住具体代码更有价值。

---

## 下一篇预告

[[02 字符串搜索：Implement strStr 与 KMP 算法]] 将深入字符串搜索的经典算法——KMP（Knuth-Morris-Pratt）。Implement strStr（LeetCode 28）的暴力解法是 $O(mn)$，而 KMP 通过预处理模式串的"最长相等前后缀"信息，将时间复杂度降到 $O(m+n)$。理解 `next` 数组的构建原理，是搞懂 KMP 的关键，也是面试中区分"背了答案"和"真正理解"的分水岭。
