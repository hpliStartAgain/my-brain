---
title: "字符串模拟：Valid Number、整数与罗马互转"
date: 2026-04-27
tags: [数据结构, 算法, 字符串, 状态机, 贪心, 罗马数字, LeetCode, 面试]
aliases: [Valid Number, 整数转罗马, 罗马转整数, 有限状态机, LeetCode 65, LeetCode 12, LeetCode 13]
---

# 字符串模拟：Valid Number、整数与罗马互转

## 摘要

本篇覆盖三道字符串解析模拟题：LeetCode 65（Valid Number）、LeetCode 12（Integer to Roman）和 LeetCode 13（Roman to Integer）。Valid Number 是字符串解析题中公认最复杂的一道，需要处理整数、浮点数、科学计数法的所有合法与非法格式，有限状态机（FSM）是最优雅的解法；整数与罗马互转则属于规则明确的模拟题，贪心和哈希映射即可解决。三道题放在一起，恰好展示了字符串解析的两个极端：规则复杂的状态机解析，和规则简单的直接枚举。

---

## 第 1 章 LeetCode 65：Valid Number

### 1.1 题目

**LeetCode 65 - Valid Number**（困难）

有效数字（按顺序）可以分成以下几个部分：

1. 一个**小数**或者**整数**
2. （可选）一个 `e` 或 `E`，后面跟着一个**整数**

**小数**（按顺序）可以分成以下几个部分：
- （可选）符号（`+`/`-`）
- 以下格式之一：
  - 数字，后面跟着一个点 `.`
  - 数字，后面跟着一个点 `.`，再跟着数字
  - 一个点 `.`，后面跟着数字

**整数**（按顺序）可以分成以下几个部分：
- （可选）符号（`+`/`-`）
- 数字

```
有效: "2", ".1", "2.", "2.0", "+.8", "2e10", "2E+10", "-2.3e4"
无效: ".", "+", "e", "1e", "1e2e3", ".e1", "--6", "+-3", "1."（有争议，部分题解认为有效）
```

> [!warning] LeetCode 65 的测试用例极其严格
> 这道题的难点不在算法，而在于**把所有合法/非法格式枚举清楚**。题目描述本身就是规则，必须逐字阅读。

### 1.2 暴力判断法（旗标法）

用三个旗标追踪状态：是否出现过数字、是否出现过点、是否出现过 `e`：

```java
public boolean isNumber(String s) {
    s = s.trim();
    boolean numSeen = false;
    boolean dotSeen = false;
    boolean eSeen = false;
    boolean numAfterE = true; // e 后面必须有数字
    
    for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        
        if (Character.isDigit(c)) {
            numSeen = true;
            if (eSeen) numAfterE = true;
        } else if (c == '+' || c == '-') {
            // 符号只能在开头或 e/E 后面
            if (i != 0 && s.charAt(i - 1) != 'e' && s.charAt(i - 1) != 'E') {
                return false;
            }
        } else if (c == '.' ) {
            // 点不能出现在 e 之后，也不能出现两次
            if (dotSeen || eSeen) return false;
            dotSeen = true;
        } else if (c == 'e' || c == 'E') {
            // e 不能出现两次，且 e 前面必须有数字
            if (eSeen || !numSeen) return false;
            eSeen = true;
            numAfterE = false; // e 后面还没有数字
        } else {
            return false; // 非法字符
        }
    }
    
    return numSeen && numAfterE;
}
```

**验证关键边界**：

| 输入 | 结果 | 原因 |
|------|------|------|
| `"."` | false | `numSeen=false` |
| `"1."` | true | `numSeen=true`, `dotSeen=true`, `numAfterE=true` |
| `".1"` | true | 数字在点后面 |
| `"1e"` | false | `numAfterE=false` |
| `"1e+2"` | true | `+` 在 `e` 后面合法 |
| `"++1"` | false | 第二个 `+` 的前一个字符不是 `e` |

### 1.3 有限状态机（DFA）解法

旗标法虽然能工作，但当规则更复杂时（如解析 JSON、SQL 等）就难以维护。有限状态机（Deterministic Finite Automaton，DFA）是字符串解析的通用解法。

**状态定义**：

```
状态 0: 初始状态（未读入任何字符）
状态 1: 读入了符号（+/-）
状态 2: 读入了整数部分的数字
状态 3: 读入了小数点（之前有数字）
状态 4: 读入了小数点（之前无数字，即 ".digit" 格式）
状态 5: 读入了小数部分的数字
状态 6: 读入了 e/E
状态 7: 读入了 e/E 后面的符号
状态 8: 读入了 e/E 后面的数字（指数部分）
```

**接受状态**（合法终止）：状态 2、3、5、8

**转移表**（行是当前状态，列是输入字符类型）：

| 状态 | 数字 | +/- | . | e/E |
|------|------|-----|---|-----|
| 0    | 2    | 1   | 4 | -1  |
| 1    | 2    | -1  | 4 | -1  |
| 2    | 2    | -1  | 3 | 6   |
| 3    | 5    | -1  | -1| 6   |
| 4    | 5    | -1  | -1| -1  |
| 5    | 5    | -1  | -1| 6   |
| 6    | 8    | 7   | -1| -1  |
| 7    | 8    | -1  | -1| -1  |
| 8    | 8    | -1  | -1| -1  |

（`-1` 表示非法转移）

```java
public boolean isNumber(String s) {
    // 转移表：transition[state][charType] = nextState
    // charType: 0=digit, 1=sign, 2=dot, 3=e/E
    int[][] transition = {
        { 2, 1, 4, -1}, // 状态 0
        { 2,-1, 4, -1}, // 状态 1
        { 2,-1, 3,  6}, // 状态 2
        { 5,-1,-1,  6}, // 状态 3
        { 5,-1,-1, -1}, // 状态 4
        { 5,-1,-1,  6}, // 状态 5
        { 8, 7,-1, -1}, // 状态 6
        { 8,-1,-1, -1}, // 状态 7
        { 8,-1,-1, -1}  // 状态 8
    };
    
    // 合法终止状态
    boolean[] accept = {false, false, true, true, false, true, false, false, true};
    
    int state = 0;
    for (char c : s.toCharArray()) {
        int type;
        if (Character.isDigit(c)) type = 0;
        else if (c == '+' || c == '-') type = 1;
        else if (c == '.') type = 2;
        else if (c == 'e' || c == 'E') type = 3;
        else return false; // 非法字符
        
        state = transition[state][type];
        if (state == -1) return false;
    }
    
    return accept[state];
}
```

**DFA 的优势**：即使规则变化（如支持 `i` 表示虚数），只需修改状态表，不需要重写逻辑。这是解析器工程化的重要范式，见于 [[Java 编译器词法分析]]、[[JSON 解析器]] 等场景。

---

## 第 2 章 LeetCode 12：整数转罗马数字

### 2.1 题目

**LeetCode 12 - Integer to Roman**（中等）

罗马数字包含以下七种字符（规则允许前一个字符是其后字符的 1/5 或 1/10 倍时使用减法）：

| 符号 | 值 |
|------|-----|
| I    | 1   |
| V    | 5   |
| X    | 10  |
| L    | 50  |
| C    | 100 |
| D    | 500 |
| M    | 1000 |

减法规则（共 6 种）：

| 符号 | 值 |
|------|-----|
| IV   | 4   |
| IX   | 9   |
| XL   | 40  |
| XC   | 90  |
| CD   | 400 |
| CM   | 900 |

给你一个整数，将其转为罗马数字。输入确保在 1 到 3999 之间。

```
输入: 3    → 输出: "III"
输入: 4    → 输出: "IV"
输入: 58   → 输出: "LVIII"（L=50, V=5, III=3）
输入: 1994 → 输出: "MCMXCIV"（M=1000, CM=900, XC=90, IV=4）
```

### 2.2 贪心解法

将所有面值（含减法组合）从大到小排列，每次尽量用最大面值：

```java
public String intToRoman(int num) {
    int[] values =   {1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1};
    String[] symbols = {"M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"};
    
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < values.length; i++) {
        while (num >= values[i]) {
            sb.append(symbols[i]);
            num -= values[i];
        }
    }
    return sb.toString();
}
```

**手动验证**（`num = 1994`）：

```
values 从大到小: 1000, 900, 500, 400, ...
num=1994 >= 1000: append "M", num=994
num=994 < 1000, 跳过
num=994 >= 900: append "CM", num=94
num=94 < 900, 500, 400, 100, 跳过
num=94 >= 90: append "XC", num=4
num=4 < 90, 50, 40, 10, 9, 5, 跳过
num=4 >= 4: append "IV", num=0
结果: "MCMXCIV" ✓
```

**复杂度**：时间 $O(1)$（因为输入上限是 3999，循环次数有界），空间 $O(1)$。

> [!note] 贪心正确性的直觉
> 贪心在这里成立，因为面值系统是"完备的"：无论从哪个大面值开始剩余的部分，都能用更小的面值精确表示，不存在"选了大面值导致后续无法凑整"的情况。这与硬币找零问题中美元系统的贪心类似。

---

## 第 3 章 LeetCode 13：罗马数字转整数

### 3.1 题目

**LeetCode 13 - Roman to Integer**（简单）

给定一个罗马数字，将其转换成整数。输入确保在 1 到 3999 之间。

```
输入: "III"     → 输出: 3
输入: "IV"      → 输出: 4
输入: "IX"      → 输出: 9
输入: "LVIII"   → 输出: 58
输入: "MCMXCIV" → 输出: 1994
```

### 3.2 核心规则

罗马数字是加法系统，但有 6 个减法例外（`IV, IX, XL, XC, CD, CM`）。识别减法的规则：**如果当前字符的值小于下一个字符的值，则减去当前字符的值**（而不是加）。

```
"IV": I(1) < V(5), 所以 -1+5 = 4
"IX": I(1) < X(10), 所以 -1+10 = 9
"XC": X(10) < C(100), 所以 -10+100 = 90
```

### 3.3 代码实现

```java
public int romanToInt(String s) {
    Map<Character, Integer> map = new HashMap<>();
    map.put('I', 1);
    map.put('V', 5);
    map.put('X', 10);
    map.put('L', 50);
    map.put('C', 100);
    map.put('D', 500);
    map.put('M', 1000);
    
    int result = 0;
    int n = s.length();
    
    for (int i = 0; i < n; i++) {
        int curr = map.get(s.charAt(i));
        int next = (i + 1 < n) ? map.get(s.charAt(i + 1)) : 0;
        
        if (curr < next) {
            result -= curr; // 减法情况
        } else {
            result += curr; // 加法情况
        }
    }
    
    return result;
}
```

**手动验证**（`s = "MCMXCIV"`）：

```
i=0: 'M'=1000, next='C'=100, 1000>100, result+=1000 → 1000
i=1: 'C'=100, next='M'=1000, 100<1000, result-=100 → 900
i=2: 'M'=1000, next='X'=10, 1000>10, result+=1000 → 1900
i=3: 'X'=10, next='C'=100, 10<100, result-=10 → 1890
i=4: 'C'=100, next='I'=1, 100>1, result+=100 → 1990
i=5: 'I'=1, next='V'=5, 1<5, result-=1 → 1989
i=6: 'V'=5, next=0, 5>0, result+=5 → 1994 ✓
```

**复杂度**：时间 $O(n)$，空间 $O(1)$（map 只有 7 个固定条目）。

### 3.4 优化：用数组代替 HashMap

由于只有 7 种字符，可以用 `switch` 或数组替代 HashMap，减少哈希计算开销：

```java
public int romanToInt(String s) {
    int result = 0;
    int prev = 0;
    
    for (int i = s.length() - 1; i >= 0; i--) {
        int curr = valueOf(s.charAt(i));
        if (curr < prev) {
            result -= curr; // 当前字符小于右边字符，减去
        } else {
            result += curr;
        }
        prev = curr;
    }
    return result;
}

private int valueOf(char c) {
    switch (c) {
        case 'I': return 1;
        case 'V': return 5;
        case 'X': return 10;
        case 'L': return 50;
        case 'C': return 100;
        case 'D': return 500;
        case 'M': return 1000;
        default: return 0;
    }
}
```

从右往左扫描：如果当前值小于右边的值，说明这是减法（如 `IV` 中的 `I`），减去；否则加上。逻辑与从左往右一样，但代码稍显简洁（不需要取 `next`）。

---

## 第 4 章 三道题对比与面试要点

### 4.1 难度梯度

| 题目 | 难度 | 核心技术 | 面试频率 |
|------|------|---------|---------|
| LeetCode 13（罗马→整数） | 简单 | 哈希映射 + 减法判断 | 高 |
| LeetCode 12（整数→罗马） | 中等 | 贪心 + 面值枚举 | 高 |
| LeetCode 65（有效数字） | 困难 | 旗标法 / DFA | 中 |

### 4.2 Valid Number 的面试策略

LeetCode 65 在面试中较少考原题，但相关的"字符串合法性验证"思路非常常见（如验证 IP 地址、邮箱格式等）。面试时：

1. **先问清楚规则**：完整描述你对"合法数字"的理解，与面试官对齐（`"1."` 到底算不算合法？）
2. **旗标法作为第一版**：先写出可工作的版本
3. **DFA 作为进阶**：说明"如果规则更复杂，我会用状态机来维护，可扩展性更强"

### 4.3 罗马数字题的常见错误

```java
// 错误：没有处理最后一个字符（i+1 越界）
for (int i = 0; i < n - 1; i++) { // 少处理了 s[n-1]
    ...
}

// 正确：在循环内用三元表达式处理越界
int next = (i + 1 < n) ? map.get(s.charAt(i + 1)) : 0;
```

> [!warning] 面试中的陷阱
> 罗马数字题看起来简单，但面试官常会要求你不看 map，只用 if-else 或 switch 实现，考察你是否真的记住了 7 个字符的映射关系。建议面试前背熟：`I=1, V=5, X=10, L=50, C=100, D=500, M=1000`。

---

## 下一篇预告

[[08 路径规范化与边界处理：Simplify Path 与 Length of Last Word]] 是字符串专栏的最后一篇，收录两道路径与单词处理题：LeetCode 71（Simplify Path）用栈处理 `/`、`.`、`..` 三类路径分量，是工程实践中文件系统路径规范化的精简版；LeetCode 58（Length of Last Word）考察从右往左扫描的细节，边界处理是关键。
