---
title: "字符串解析：atoi、Add Binary 与进位模拟"
date: 2026-04-27
tags: [数据结构, 算法, 字符串, 状态机, 进位模拟, LeetCode, 面试]
aliases: [atoi, 字符串转整数, Add Binary, 二进制加法, 有限状态机]
---

# 字符串解析：atoi、Add Binary 与进位模拟

## 摘要

本篇讲解两道字符串解析题：LeetCode 8（String to Integer / atoi）和 LeetCode 67（Add Binary）。这两道题类型互补：atoi 是"从字符串解析出数值"的过程，难点在于处理前导空格、符号、溢出等边界状态，**有限状态机（DFA）**是应对这类字符逐字符处理问题的最优建模工具；Add Binary 是"数值计算结果写回字符串"的过程，核心是二进制加法的进位模拟，与链表版"两数相加"异曲同工。

---

## 第 1 章 LeetCode 8：字符串转整数（atoi）

### 1.1 题目

**LeetCode 8 - String to Integer (atoi)**（中等）

请你来实现一个 `myAtoi(string s)` 函数，使其能将字符串转换成一个 32 位有符号整数（类似 C/C++ 中的 `atoi` 函数）。

**算法步骤**：
1. 读入字符串，直到遇到**首个非空格字符**（或字符串结束）
2. 确定**符号**：下一个字符是 `+` 或 `-`（可选），缺省为正号
3. 读入**数字**：直到遇到非数字字符或字符串结束
4. 将读入的数字转换为整数，并处理整数溢出：
   - 如果结果超出 `[Integer.MIN_VALUE, Integer.MAX_VALUE]`，返回边界值

```
输入: s = "42"          → 输出: 42
输入: s = "   -42"      → 输出: -42（跳过前导空格，读取符号）
输入: s = "4193 with words" → 输出: 4193（遇到非数字字符停止）
输入: s = "words and 987"   → 输出: 0（首个非空格字符不是数字或符号，返回 0）
输入: s = "-91283472332"    → 输出: -2147483648（溢出，返回 MIN_VALUE）
```

### 1.2 为什么这道题难

**不是算法难，是细节难**。需要正确处理：
- 前导空格（可以有多个）
- 符号位（`+` 或 `-`，只能有一个，且必须在数字前）
- 数字读取（连续多位，直到非数字字符）
- 非法字符（第一个有效字符不是数字或符号 → 返回 0）
- 整数溢出（32 位有符号整数边界，注意在累积时判断，而不是累积后再比较）

如果用一堆 `if-else` 来处理，代码容易出错且难以验证覆盖了所有情况。**有限状态机（DFA）是更系统的方法**。

### 1.3 有限状态机建模

**有限状态机（Deterministic Finite Automaton，DFA）**由以下要素构成：
- **状态集合**：描述"当前处于哪个阶段"
- **输入字母表**：可能的输入字符类型
- **转移函数**：在状态 $s$ 读入字符 $c$ 后，转移到状态 $\delta(s, c)$
- **初始状态**和**终止状态**

**为 atoi 建模**：

**输入字符分类**（alphabet）：
- `space`：空格
- `sign`：`+` 或 `-`
- `digit`：`0-9`
- `other`：其他字符

**状态**：
- `START`：初始状态，还没读到有效字符
- `SIGNED`：已读到符号位（`+` 或 `-`）
- `IN_NUMBER`：正在读数字
- `END`：终止状态（不再接收更多输入）

**状态转移表**：

| 当前状态 | space | sign | digit | other |
|---------|-------|------|-------|-------|
| START | START | SIGNED | IN_NUMBER | END |
| SIGNED | END | END | IN_NUMBER | END |
| IN_NUMBER | END | END | IN_NUMBER | END |
| END | END | END | END | END |

```java
public int myAtoi(String s) {
    int state = 0; // 0=START, 1=SIGNED, 2=IN_NUMBER, 3=END
    int sign = 1;
    long result = 0;
    
    // 状态转移表：table[state][charType] = nextState
    // charType: 0=space, 1=sign, 2=digit, 3=other
    int[][] table = {
        {0, 1, 2, 3}, // START
        {3, 3, 2, 3}, // SIGNED
        {3, 3, 2, 3}, // IN_NUMBER
        {3, 3, 3, 3}  // END
    };
    
    for (char c : s.toCharArray()) {
        int charType = getCharType(c);
        state = table[state][charType];
        
        if (state == 1) { // SIGNED
            sign = (c == '-') ? -1 : 1;
        } else if (state == 2) { // IN_NUMBER
            result = result * 10 + (c - '0');
            // 提前截断，防止 long 也溢出
            if (result > Integer.MAX_VALUE) {
                return sign == 1 ? Integer.MAX_VALUE : Integer.MIN_VALUE;
            }
        }
    }
    
    return (int)(sign * result);
}

private int getCharType(char c) {
    if (c == ' ')  return 0; // space
    if (c == '+' || c == '-') return 1; // sign
    if (c >= '0' && c <= '9') return 2; // digit
    return 3; // other
}
```

**手动验证**（`s = "   -42"`）：

```
c=' ': charType=0, state=table[0][0]=0（START→START），无操作
c=' ': charType=0, state=table[0][0]=0（START→START），无操作
c=' ': charType=0, state=table[0][0]=0（START→START），无操作
c='-': charType=1, state=table[0][1]=1（START→SIGNED），sign=-1
c='4': charType=2, state=table[1][2]=2（SIGNED→IN_NUMBER），result=4
c='2': charType=2, state=table[2][2]=2（IN_NUMBER→IN_NUMBER），result=42

返回 -1 * 42 = -42 ✓
```

**手动验证**（`s = "words and 987"`）：

```
c='w': charType=3, state=table[0][3]=3（START→END），无操作
c='o': charType=3, state=table[3][3]=3（END→END），无操作
...（一直是 END）

返回 1 * 0 = 0 ✓
```

### 1.4 溢出处理的细节

**错误做法**：先不管溢出，累积完成后再截断。

```java
// 危险：result 可能在 long 范围内合法，但转成 int 后溢出
result = result * 10 + digit;
return (int) Math.min(sign * result, Integer.MAX_VALUE);
```

如果 `s = "99999999999999999999999999999999"`（32个9），`result` 本身在 `long` 范围内也会溢出（`long` 最大约 $9.2 \times 10^{18}$，而 32 个 9 约 $10^{32}$）！

**正确做法**：在每次累积后，如果超过 `Integer.MAX_VALUE` 就提前截断返回：

```java
result = result * 10 + (c - '0');
if (result > Integer.MAX_VALUE) {
    return sign == 1 ? Integer.MAX_VALUE : Integer.MIN_VALUE;
}
```

这里利用了 `result` 是 `long` 类型，`Integer.MAX_VALUE = 2147483647`，只要累积后超过这个值就截断，不会出现 `long` 溢出（因为我们逐步判断，单步最大变化是 $9 \times 2147483647 + 9 \approx 1.93 \times 10^{10}$，远未超过 `long` 上界）。

> [!warning] 溢出是 atoi 中最高频的 bug
> 面试时如果面试官让你扩展代码，第一个问题一定是"你的溢出处理是否正确"。确保在累积过程中提前截断，而不是等到最后。

---

## 第 2 章 LeetCode 67：二进制求和

### 2.1 题目

**LeetCode 67 - Add Binary**（简单）

给你两个二进制字符串 `a` 和 `b`，以二进制字符串的形式返回它们的和。

```
输入: a = "11", b = "1"     → 输出: "100"（3 + 1 = 4 = 100）
输入: a = "1010", b = "1011" → 输出: "10101"（10 + 11 = 21 = 10101）
```

### 2.2 解法：从低位到高位模拟

二进制加法规则：
- 0 + 0 = 0，进位 0
- 0 + 1 = 1，进位 0
- 1 + 1 = 0，进位 1
- 1 + 1 + 1（进位）= 1，进位 1

```java
public String addBinary(String a, String b) {
    int i = a.length() - 1, j = b.length() - 1;
    int carry = 0;
    StringBuilder sb = new StringBuilder();
    
    while (i >= 0 || j >= 0 || carry > 0) {
        int bitA = (i >= 0) ? (a.charAt(i--) - '0') : 0;
        int bitB = (j >= 0) ? (b.charAt(j--) - '0') : 0;
        
        int sum = bitA + bitB + carry;
        sb.append(sum % 2); // 当前位的值
        carry = sum / 2;    // 进位
    }
    
    return sb.reverse().toString(); // 从高位反转输出
}
```

**手动验证**（`a = "1010", b = "1011"`）：

```
i=3, j=3, carry=0:
  bitA='0'=0, bitB='1'=1, sum=1, 写入'1', carry=0
  i=2, j=2

i=2, j=2:
  bitA='1'=1, bitB='1'=1, sum=2, 写入'0', carry=1
  i=1, j=1

i=1, j=1:
  bitA='0'=0, bitB='0'=0, sum=0+carry=1, 写入'1', carry=0
  i=0, j=0

i=0, j=0:
  bitA='1'=1, bitB='1'=1, sum=2, 写入'0', carry=1
  i=-1, j=-1

i=-1, j=-1, carry=1:
  bitA=0, bitB=0, sum=1, 写入'1', carry=0

sb = "10101", reverse → "10101" ✓（21的二进制）
```

**复杂度**：时间 $O(\max(m, n))$，空间 $O(\max(m, n))$（结果字符串）。

### 2.3 与链表两数相加的对比

Add Binary 和 LeetCode 2（[[13 链表综合运用：大数加法、重排链表、随机指针与 LRU 缓存|链表两数相加]]）是同一类问题的两种形式：

| 特性 | LeetCode 67（字符串） | LeetCode 2（链表） |
|------|---------------------|-----------------|
| 数字存储 | 字符串（高位在前） | 链表（低位在头） |
| 遍历方向 | 从右到左（`i--`） | 从头到尾（已经是低位优先） |
| 进制 | 二进制 | 十进制 |
| 结果写入 | StringBuilder + reverse | 新链表节点 |

**通用模板**（大数加法，任意进制）：

```
从低位开始逐位相加（字符串需要从右往左）
sum = a[i] + b[j] + carry
当前位 = sum % base
进位    = sum / base
循环直到两个数和进位都处理完
```

这个模板适用于：
- 二进制加法（base=2，LeetCode 67）
- 十进制加法（base=10，LeetCode 415 字符串数字相加）
- 十六进制加法
- 链表两数相加（LeetCode 2、445）

---

## 第 3 章 有限状态机（DFA）的通用价值

### 3.1 什么时候用 DFA 建模

DFA 特别适合处理"按字符逐个处理，有明确的阶段转换"的字符串问题：

| 问题 | 状态示例 |
|------|---------|
| atoi（LeetCode 8） | 前导空格 → 符号 → 数字 → 终止 |
| Valid Number（LeetCode 65） | 整数部分 → 小数点 → 小数部分 → 指数部分 |
| URL 解析 | 协议 → 主机 → 路径 → 参数 |
| 词法分析 | 关键字识别、注释跳过 |

**DFA 的优势**：
1. **穷举所有状态**，不会遗漏边界 case
2. **代码结构清晰**，状态转移表是文档
3. **易于扩展**，添加新规则只需修改表格

### 3.2 DFA 的通用代码框架

```java
// 通用 DFA 框架
int state = INITIAL_STATE;
for (char c : s.toCharArray()) {
    int charType = classify(c); // 将字符分类为输入类型
    state = transition[state][charType]; // 查表转移
    
    // 根据当前状态执行操作（副作用）
    if (state == SOME_STATE) {
        // ...
    }
    
    // 如果进入了终止/错误状态，可以提前 break
    if (state == DEAD_STATE) break;
}
return isAcceptState(state); // 判断最终状态是否是合法终态
```

这个框架在 Valid Number（LeetCode 65）中也会用到，届时状态更多，但逻辑完全一致。

---

## 第 4 章 字符解析的工程实践

### 4.1 面试中常见的字符解析陷阱

**陷阱 1：前导/尾随空格**

大多数解析题都需要处理前导空格，`trim()` 是一个简便方法，但注意 `trim()` 只去掉 ASCII 空白字符（包括 `\t`、`\n` 等），而题目有时只处理空格 `' '`。

**陷阱 2：多余的符号**

`"++1"`、`"+-1"`、`"1+2"` 等情况，需要明确状态机只在 `START` 状态接受符号。

**陷阱 3：整数溢出**

永远在累积过程中检测，不要等到最后再转换。优先用 `long` 存中间值，或者在加法前检测：

```java
// 在加当前位之前，检测加了之后会不会溢出
if (result > (Integer.MAX_VALUE - digit) / 10) {
    return sign == 1 ? Integer.MAX_VALUE : Integer.MIN_VALUE;
}
result = result * 10 + digit;
```

**陷阱 4：`"0032"` 前导零**

atoi 不需要特殊处理前导零（`0032` → `32` 自然处理），但某些题目（如 LeetCode 8 的特定约束）需要注意。

### 4.2 `charAt(i) - '0'` 的字符到数字转换

这是字符串数字解析中最常用的技巧：

```java
char c = '7';
int digit = c - '0'; // 55 - 48 = 7
```

`'0'` 的 ASCII 码是 48，`'9'` 是 57。利用 ASCII 连续性，`c - '0'` 可以直接得到字符对应的数字值，无需 `Character.getNumericValue(c)`。

类似地：
- `c - 'a'`：小写字母转 0-25 的下标
- `c - 'A'`：大写字母转 0-25 的下标

这些技巧在哈希计数、Trie 树等场景中大量使用。

---

## 下一篇预告

[[04 最长回文子串：中心扩展与 Manacher 算法]] 将深入回文子串的搜索问题。LeetCode 5（Longest Palindromic Substring）是一道频率极高的中等题，中心扩展法时间 $O(n^2)$、空间 $O(1)$，足以通过；而 Manacher 算法通过一个精妙的"镜像利用"技巧，将时间降到 $O(n)$，是字符串算法中最经典的 $O(n)$ 优化案例之一。
