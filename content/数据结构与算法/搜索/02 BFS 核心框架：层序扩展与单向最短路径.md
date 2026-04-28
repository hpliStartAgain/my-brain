---
title: "BFS 核心框架：层序扩展与单向最短路径——Word Ladder 深度解析"
date: 2026-04-28
tags: [算法, BFS, 广度优先搜索, 最短路径, LeetCode, Word Ladder, 面试]
aliases: [Word Ladder BFS, BFS最短路径, 单词接龙, LeetCode 127]
---

# BFS 核心框架：层序扩展与单向最短路径——Word Ladder 深度解析

## 摘要

Word Ladder（单词接龙）是 BFS 的教科书级例题，也是面试中考察"能否将 BFS 模板运用于非显式图"的标准题目。本文以这道题为主线，深入剖析 BFS 的三个核心设计决策：为什么入队时就要标记 visited、如何构建隐式图、以及为什么单向 BFS 在某些情况下不够快——后者引出了下一篇文章的双向 BFS。全程通过详细的过程推演和逐步改进，帮助你真正理解 BFS 而不只是记住模板。

---

## 第 1 章 题目解析：Word Ladder 是什么

### 1.1 LeetCode 127 - Word Ladder

**题目**（中等，实际难度偏难）：

给你两个单词 `beginWord` 和 `endWord`，以及一个字典 `wordList`。如果两个单词**每次只改变一个字母**，且改变后的单词必须在字典里，那么从 `beginWord` 到 `endWord` 的最短转换序列的长度是多少？如果不能转换，返回 0。

```
输入：beginWord = "hit", endWord = "cog", wordList = ["hot","dot","dog","lot","log","cog"]
输出：5
解释："hit" → "hot" → "dot" → "dog" → "cog"，共 5 个单词

输入：beginWord = "hit", endWord = "cog", wordList = ["hot","dot","dog","lot","log"]
输出：0
解释：endWord "cog" 不在字典中，无法完成转换
```

### 1.2 问题的本质：最短路径

"每次改变一个字母"是从一个状态到另一个状态的转移规则；"改变后必须在字典里"是转移的合法性约束；"最短转换序列的长度"是最短路径。

将问题映射到图论模型：

- **节点**：每个单词（包括 `beginWord`）
- **边**：两个单词之间差一个字母，则连一条边（无权图，每条边代价为 1）
- **问题**：从 `beginWord` 到 `endWord` 的最短路径长度

这是一个**等权无向图上的单源最短路径**问题，BFS 是最优算法。

> [!info] 核心概念：隐式图
> 本题的图没有被显式给出，而是由"两词差一字母"这一规则隐式定义。面试中大量搜索题都是隐式图——图的节点和边需要在搜索过程中动态生成。BFS 完全适用于隐式图。

### 1.3 为什么不能用 DFS

如果用 DFS，从 `beginWord` 出发，一头扎入某条路径，可能走了很长才到 `endWord`，但这不是最短路径。DFS 需要探索所有路径后取最短，代价极高。

BFS 则按层扩展，**第一次到达 `endWord` 时的步数，就是最短路径长度**。

---

## 第 2 章 关键难点：如何高效构建邻居关系

### 2.1 朴素方法的问题

最直观的方法：对每个单词 $w$，遍历所有字典单词，检查是否差一个字母。

```java
// 朴素方法：O(n * L) 来找一个单词的所有邻居
// n = 字典大小，L = 单词长度
List<String> getNeighbors(String word, Set<String> wordSet) {
    List<String> neighbors = new ArrayList<>();
    for (String dictWord : wordSet) {
        if (differByOne(word, dictWord)) {
            neighbors.add(dictWord);
        }
    }
    return neighbors;
}

boolean differByOne(String a, String b) {
    int diff = 0;
    for (int i = 0; i < a.length(); i++) {
        if (a.charAt(i) != b.charAt(i)) diff++;
    }
    return diff == 1;
}
```

这样每次查找邻居需要 $O(n \cdot L)$。对于 $n$ 个单词的 BFS，总复杂度为 $O(n^2 L)$。

**LeetCode 题目约束**：`wordList.length <= 5000`，`beginWord.length <= 10`。$n^2 L \approx 5000^2 \times 10 = 2.5 \times 10^8$，接近超时边界。

### 2.2 高效方法：枚举变形

更好的方法：对当前单词的每个位置，枚举 26 个字母（'a' 到 'z'），检查变形后的单词是否在字典中。

```java
// 高效方法：O(26 * L) 来找一个单词的所有邻居
List<String> getNeighbors(String word, Set<String> wordSet) {
    List<String> neighbors = new ArrayList<>();
    char[] chars = word.toCharArray();

    for (int i = 0; i < chars.length; i++) {
        char original = chars[i];
        for (char c = 'a'; c <= 'z'; c++) {
            if (c == original) continue;  // 不改变（不是有效转移）
            chars[i] = c;
            String newWord = new String(chars);
            if (wordSet.contains(newWord)) {
                neighbors.add(newWord);
            }
        }
        chars[i] = original;  // 恢复，准备修改下一个位置
    }
    return neighbors;
}
```

每次查找邻居的复杂度降为 $O(26L)$，总复杂度 $O(26nL)$，远快于朴素方法。

**为什么这样更快？** 哈希集合的 `contains` 操作是 $O(L)$（计算字符串哈希的代价），所以枚举 $26 \times L$ 个变形，每次 $O(L)$ 检查，总计 $O(26L^2)$。比起朴素方法对每个字典单词 $O(L)$ 比较，这种方式不需要遍历整个字典。

---

## 第 3 章 BFS 实现：完整代码与逐行解析

### 3.1 完整实现

```java
public int ladderLength(String beginWord, String endWord, List<String> wordList) {
    // 1. 将字典转为 HashSet，支持 O(L) 的查找
    Set<String> wordSet = new HashSet<>(wordList);

    // 2. endWord 不在字典中，直接返回 0
    if (!wordSet.contains(endWord)) return 0;

    // 3. BFS 初始化
    Queue<String> queue = new LinkedList<>();
    Set<String> visited = new HashSet<>();
    queue.offer(beginWord);
    visited.add(beginWord);  // 入队时立即标记

    int steps = 1;  // 起点本身算 1 个单词（题目要求返回序列长度，不是边数）

    // 4. BFS 主循环
    while (!queue.isEmpty()) {
        int size = queue.size();  // 当前层的单词数量

        for (int i = 0; i < size; i++) {
            String cur = queue.poll();

            // 5. 对当前单词的每个位置，枚举 26 个字母
            char[] chars = cur.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char original = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == original) continue;
                    chars[j] = c;
                    String next = new String(chars);

                    // 6. 找到终点，返回步数
                    if (next.equals(endWord)) return steps + 1;

                    // 7. 有效且未访问的邻居，加入下一层
                    if (wordSet.contains(next) && !visited.contains(next)) {
                        queue.offer(next);
                        visited.add(next);  // 入队时标记，防止重复入队
                    }
                }
                chars[j] = original;  // 恢复
            }
        }
        steps++;  // 当前层处理完，步数 +1
    }

    return 0;  // 无法到达 endWord
}
```

### 3.2 关键设计决策逐一解释

**决策一：为什么 `steps` 初始化为 1？**

题目要求返回的是转换序列的**长度**（单词数量），而不是转换的**次数**（边的数量）。`beginWord` 本身算序列中的一个单词，所以 `steps` 从 1 开始。当找到 `endWord` 时，返回 `steps + 1`（加上 `endWord` 本身）。

另一种理解：`steps` 始终表示"当前正在处理的这一层，距离 `beginWord` 的边数"。第 0 层（`beginWord` 本身）不在循环中处理，所以进入循环时 `steps = 1` 表示第 1 层。找到 `endWord` 时，`steps + 1` 是总单词数。

**决策二：为什么 `visited.add(next)` 要在入队时做，而不是出队时？**

考虑一个场景：如果 `next` 在 `visited` 中的时间点是出队后：

```
状态：cur=A，邻居有 B 和 C
     cur=D，邻居也有 B

处理 A 时：B 入队（未标记）
处理 D 时：B 再次入队（因为还没出队，还没标记）
队列：[B, C, B]  ← B 出现了两次！
```

如果 B 入队时立即标记：

```
处理 A 时：B 入队，标记 B
处理 D 时：B 已被标记，跳过
队列：[B, C]  ← 正确
```

入队时标记，确保每个节点**最多入队一次**，避免了重复处理，时间复杂度正确。

**决策三：`wordSet.contains(next)` 和 `!visited.contains(next)` 的检查顺序**

习惯上先检查 `wordSet`（是否是合法单词），再检查 `visited`（是否已访问）。两个条件都必须满足才能入队。注意 `beginWord` 可能不在 `wordSet` 中，但它是起点，不需要在字典里。

**决策四：为什么 `endWord` 的检查放在邻居生成时，而不是出队时？**

放在出队时：

```java
String cur = queue.poll();
if (cur.equals(endWord)) return steps;  // 出队时检查
```

放在入队时（即邻居生成时，如本文代码）：

```java
if (next.equals(endWord)) return steps + 1;  // 入队时检查
```

两种写法都正确，但效果略有不同：
- 出队时检查：`endWord` 被入队后还要等到被处理才返回，多耗一点时间（可忽略）
- 入队时检查（本文代码）：发现 `endWord` 立即返回，逻辑更清晰

本文选用入队时检查，并注意步数要 `+1`（因为此时 `steps` 还未递增）。

---

## 第 4 章 逐步模拟：追踪 BFS 的执行过程

用 `beginWord = "hit"`, `endWord = "cog"`, `wordList = ["hot","dot","dog","lot","log","cog"]` 模拟：

**初始化**：
```
queue = ["hit"]
visited = {"hit"}
steps = 1
```

**第 1 层（steps=1）**：处理 "hit"

枚举变形：
- h→a,b,...,z 位置 0：无字典单词
- i→a,b,...,z 位置 1：`hot`（h**o**t）在字典中，入队
- t→a,b,...,z 位置 2：无字典单词

```
queue = ["hot"]
visited = {"hit", "hot"}
steps = 2
```

**第 2 层（steps=2）**：处理 "hot"

枚举变形：
- 位置 0 (h)：`dot`(d**o**t)、`lot`(l**o**t) 在字典中，入队
- 位置 1 (o)：无
- 位置 2 (t)：无

```
queue = ["dot", "lot"]
visited = {"hit", "hot", "dot", "lot"}
steps = 3
```

**第 3 层（steps=3）**：处理 "dot" 和 "lot"

处理 "dot"：
- 位置 0 (d)：`lot`（已访问）
- 位置 1 (o)：无
- 位置 2 (t)：`dog`(do**g**) 在字典中，入队

处理 "lot"：
- 位置 0 (l)：`dot`（已访问）
- 位置 2 (t)：`log`(lo**g**) 在字典中，入队

```
queue = ["dog", "log"]
visited = {"hit", "hot", "dot", "lot", "dog", "log"}
steps = 4
```

**第 4 层（steps=4）**：处理 "dog" 和 "log"

处理 "dog"：
- 位置 2 (g)：`cog`(co**g**) 在字典中
- `cog` 等于 `endWord`！返回 `steps + 1 = 4 + 1 = 5` ✅

**最终答案**：5，对应路径 `hit → hot → dot → dog → cog`

---

## 第 5 章 复杂度分析与优化空间

### 5.1 时间复杂度

设：
- $n$ = 字典大小
- $L$ = 单词长度
- $d$ = 最短路径长度（层数）

每一层，我们处理若干单词，每个单词枚举 $26 \times L$ 个变形，每次 HashSet 查找 $O(L)$：

- 每个单词的处理代价：$O(26 \times L \times L) = O(26L^2)$
- 最多处理 $n$ 个单词（每个单词最多入队一次）
- **总时间复杂度**：$O(26 \times n \times L^2)$

### 5.2 空间复杂度

- `wordSet`：$O(nL)$
- `visited`：$O(nL)$
- `queue`：$O(nL)$（最坏情况下所有单词同时在队列中）
- **总空间复杂度**：$O(nL)$

### 5.3 BFS 的内在局限：搜索的不对称性

单向 BFS 从 `beginWord` 出发，一层一层向外扩散，直到碰到 `endWord`。想象一下，如果状态空间很大（如分支因子 $b$ 很大），第 $k$ 层就有 $b^k$ 个节点，BFS 需要处理的节点数随层数**指数增长**。

如果目标节点在第 $d$ 层，BFS 需要处理 $O(b^d)$ 个节点。

**一个关键问题**：能不能更快？——从两端同时搜，各搜 $d/2$ 层：

$$O(b^{d/2}) + O(b^{d/2}) = 2 \times O(b^{d/2}) \ll O(b^d)$$

这就是**双向 BFS**的核心思想，也是下一篇文章 Word Ladder II 引入的技术。

---

## 第 6 章 变体题目与举一反三

### 6.1 变体一：返回所有最短路径

这正是 Word Ladder II（LeetCode 126）的要求，难度大幅提升，需要在 BFS 中构建"前驱图"，再用 DFS 枚举所有路径。详见下一篇文章。

### 6.2 变体二：最少跳跃步数（Jump Game II）

**LeetCode 45 - Jump Game II**：数组中每个元素表示在该位置可以跳跃的最大步数，求从 `nums[0]` 到达最后一个位置的最少跳跃次数。

这也是一个"最少步数"问题，可以用 BFS 解（把位置看作节点，可达的位置连边）：

```java
// BFS 解法（非最优，但展示了 BFS 的泛化能力）
public int jump(int[] nums) {
    int n = nums.length;
    Queue<Integer> queue = new LinkedList<>();
    Set<Integer> visited = new HashSet<>();
    queue.offer(0);
    visited.add(0);
    int steps = 0;

    while (!queue.isEmpty()) {
        int size = queue.size();
        for (int i = 0; i < size; i++) {
            int cur = queue.poll();
            if (cur == n - 1) return steps;
            for (int j = 1; j <= nums[cur]; j++) {
                int next = cur + j;
                if (next < n && !visited.contains(next)) {
                    queue.offer(next);
                    visited.add(next);
                }
            }
        }
        steps++;
    }
    return -1;
}
```

（注：Jump Game II 实际上有 $O(n)$ 的贪心解，BFS 是 $O(n^2)$，但理解 BFS 的通用性更重要。）

### 6.3 变体三：最短路径变形——最小基因变化

**LeetCode 433 - Minimum Genetic Mutation**：和 Word Ladder 几乎相同，区别是字符集从 26 个字母变成了 `{'A', 'C', 'G', 'T'}` 4 个字符。直接套用 Word Ladder 的模板，修改枚举字符集即可。这说明 BFS 模板的核心是框架，字符集/转移规则是参数。

### 6.4 识别"BFS 最短路径"题型的特征

| 特征 | 说明 |
|------|------|
| 要求"最少步数/最短路径/最小操作次数" | BFS 的经典信号 |
| 每次操作代价相同（无权图） | BFS 适用；代价不同则用 Dijkstra |
| 有明确的"合法性"约束（如必须在字典里） | 对应 BFS 中的 `wordSet.contains` 检查 |
| 状态可以用哈希表表示 | 说明 visited 集合可以高效实现 |
| 状态空间有限（否则 BFS 会无限扩展） | 确保 BFS 能终止 |

---

## 第 7 章 完整代码汇总与面试注意事项

### 7.1 面试可直接使用的代码

```java
class Solution {
    public int ladderLength(String beginWord, String endWord, List<String> wordList) {
        Set<String> wordSet = new HashSet<>(wordList);
        if (!wordSet.contains(endWord)) return 0;

        Queue<String> queue = new LinkedList<>();
        Set<String> visited = new HashSet<>();
        queue.offer(beginWord);
        visited.add(beginWord);
        int steps = 1;

        while (!queue.isEmpty()) {
            int size = queue.size();
            for (int i = 0; i < size; i++) {
                String cur = queue.poll();
                char[] chars = cur.toCharArray();
                for (int j = 0; j < chars.length; j++) {
                    char orig = chars[j];
                    for (char c = 'a'; c <= 'z'; c++) {
                        if (c == orig) continue;
                        chars[j] = c;
                        String next = new String(chars);
                        if (next.equals(endWord)) return steps + 1;
                        if (wordSet.contains(next) && !visited.contains(next)) {
                            queue.offer(next);
                            visited.add(next);
                        }
                        chars[j] = orig;  // 注意：这行应在内循环中！
                    }
                    chars[j] = orig;  // 恢复当前位置的字符
                }
            }
            steps++;
        }
        return 0;
    }
}
```

> [!warning] 生产避坑：chars[j] 的恢复时机
> `chars[j] = orig` 的恢复必须放在对 `j` 这个位置的 26 个字母枚举**全部完成后**，而不是在内层 `for c` 循环里。如果写在内层循环里（如某些错误实现），每次修改后立即恢复，下次循环又会从 `orig` 开始修改，逻辑正确。但如果写在内层循环外又没有写，则 `chars[j]` 的值会是 'z'（最后一次枚举的字符），导致下一个位置 `j+1` 的枚举基于错误的字符数组。**正确位置是外层 `for j` 循环的末尾**。

### 7.2 面试中的常见错误

1. **`steps` 的初值和返回值搞错**：题目要的是序列长度（单词数），不是边数。`beginWord` 算 1，找到 `endWord` 时加 1。
2. **visited 标记在出队时做**：导致同一单词多次入队，BFS 速度变慢。
3. **没有检查 `endWord` 是否在字典中**：`endWord` 若不在字典中，永远无法到达，直接返回 0。
4. **使用 List 而非 Set 存字典**：`List.contains` 是 $O(n)$，而 `Set.contains` 是 $O(L)$（哈希），差距巨大。

---

## 本章小结

Word Ladder 是一道把 BFS 的所有核心要素都体现出来的题目：隐式图的构建、visited 的设计、层序感知、以及与"最短路径"的联系。掌握了这道题，就掌握了 BFS 的框架。

下一篇文章 Word Ladder II 在此基础上加了"返回所有最短路径"的要求，这将引出两个关键技术：前驱图构建（在 BFS 阶段记录路径来源）和双向 BFS（从两端同时搜索以减少复杂度）。

---

*关联文章：[[BFS 与 DFS 全景导览：搜索算法的本质与适用边界]] | [[双向 BFS 与路径还原：Word Ladder II 深度解析]]*
