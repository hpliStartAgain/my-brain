---
title: "双向 BFS 与路径还原：Word Ladder II 深度解析"
date: 2026-04-28
tags: [算法, BFS, 双向BFS, 路径还原, LeetCode, Word Ladder II, 面试]
aliases: [双向BFS, Word Ladder II, 前驱图, LeetCode 126]
---

# 双向 BFS 与路径还原：Word Ladder II 深度解析

## 摘要

Word Ladder II 是 LeetCode 上公认难度最大的 BFS 题目之一。它在 Word Ladder 的基础上加了一个看似简单的要求——"返回所有最短路径"——却让复杂度和实现难度都大幅跃升。本文深入分析为什么单纯在 BFS 上加路径记录会出错，引入前驱图（Predecessor Graph）作为核心数据结构，再结合双向 BFS 进一步优化性能。全过程通过逐步推演，帮你透彻理解这道"最难 BFS 题"背后的每一个设计决策。

---

## 第 1 章 题目解析：Word Ladder II 比 I 难在哪里

### 1.1 LeetCode 126 - Word Ladder II

**题目**（困难）：

给你两个单词 `beginWord` 和 `endWord`，以及一个字典 `wordList`。找出并返回所有从 `beginWord` 到 `endWord` 的**最短转换序列**。如果不存在这样的转换序列，返回一个空列表。

```
输入：beginWord = "hit", endWord = "cog"
     wordList = ["hot","dot","dog","lot","log","cog"]

输出：[["hit","hot","dot","dog","cog"],
       ["hit","hot","lot","log","cog"]]

（两条最短路径，长度均为 5）
```

### 1.2 "所有最短路径"比"最短路径长度"难在哪里

Word Ladder I 只需要返回最短路径**长度**，BFS 一旦碰到 `endWord` 就能立即返回当前步数。

Word Ladder II 要求返回所有**完整路径**（不只是长度），这引入了三个新挑战：

**挑战一：不能在第一次碰到 endWord 时停止**

BFS 按层扩展，某一层可能有多条路径同时到达 `endWord`，必须把当前层处理完，才能收集到所有最短路径。

**挑战二：路径记录引发的"层内交叉"问题**

考虑这样一个场景：

```
BFS 搜索过程中，单词 A 在第 k 层，单词 B 在第 k 层，单词 C 在第 k+1 层
A 可以到 C，B 也可以到 C
```

如果我们在 BFS 中用 `Map<String, List<String>> prevMap`（前驱图）记录 C 的前驱，C 的前驱应该是 `{A, B}`。

但如果按照朴素的 visited 做法，处理 A 时把 C 加入 visited 并入队，处理 B 时发现 C 已在 visited 中跳过——这样就丢失了 `B → C` 这条路径。

**这是 Word Ladder II 的核心难点**。

**挑战三：路径还原需要额外数据结构**

单纯的 BFS 只能告诉我们"能否到达"，不记录路径。要还原路径，需要额外的数据结构。

---

## 第 2 章 解法一：BFS 构建前驱图 + DFS 还原路径

### 2.1 核心思路

解题分为两个阶段：

1. **BFS 阶段**：不记录完整路径，而是记录**前驱图**（每个单词的所有合法前驱）。前驱图捕获了所有属于最短路径的"边"。
2. **DFS 阶段**：从 `endWord` 出发，沿前驱图反向回溯，枚举所有从 `beginWord` 到 `endWord` 的完整路径。

### 2.2 为什么用前驱图而不是直接在 BFS 中记录路径

如果在 BFS 中直接记录路径（每个节点存储从 `beginWord` 到该节点的完整路径列表），内存开销会极大：路径数量可能指数级增长，每条路径长度为 $O(d)$，总内存为 $O(\text{路径数} \times d)$。

前驱图只存储"谁是我的前驱"，空间是 $O(nL)$（字典大小），然后在 DFS 阶段按需还原路径，只需要 $O(d)$ 的栈空间。**这是空间效率的本质优化。**

### 2.3 解决"层内交叉"问题的关键：分层 visited

BFS 按层处理时，同一层内的节点可以互相作为前驱。具体来说：

- **当前层**的节点不标记为 visited（对于前驱图的构建而言）
- 只有**整层处理完之后**，才把当前层所有节点加入 visited

这样，在处理第 $k+1$ 层的节点 C 时，第 $k$ 层的所有节点（A 和 B）都还不在 visited 中，因此 A 和 B 都能成为 C 的前驱。

```java
// 关键：分层处理 visited
Set<String> visited = new HashSet<>();
visited.add(beginWord);

while (!queue.isEmpty()) {
    int size = queue.size();
    Set<String> currentLayer = new HashSet<>();  // 当前层产生的新单词

    for (int i = 0; i < size; i++) {
        String cur = queue.poll();
        // ... 枚举邻居 next
        if (!visited.contains(next)) {
            if (!currentLayer.contains(next)) {
                // 第一次在本层发现 next，入队
                queue.offer(next);
                currentLayer.add(next);
            }
            // 不管是否第一次，只要 visited 中没有，就记录前驱关系
            prevMap.getOrDefault(next, new ArrayList<>()).add(cur);
        }
    }

    // 整层处理完后，才把本层加入 visited
    visited.addAll(currentLayer);
}
```

这里 `visited` 只在整层处理完后更新，而不是在发现 `next` 时立即更新。这保证了同层的多个前驱都能被记录。

### 2.4 完整 BFS 阶段代码

```java
public List<List<String>> findLadders(String beginWord, String endWord, List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    List<List<String>> result = new ArrayList<>();

    if (!wordSet.contains(endWord)) return result;

    // 前驱图：key = 单词，value = 所有可以一步到达 key 且在最短路径上的单词
    Map<String, List<String>> prevMap = new HashMap<>();

    // BFS：从 beginWord 出发，构建前驱图
    Queue<String> queue = new LinkedList<>();
    Set<String> visited = new HashSet<>();
    queue.offer(beginWord);
    visited.add(beginWord);
    boolean found = false;  // 是否已找到 endWord（找到后，当前层处理完就停止）

    while (!queue.isEmpty() && !found) {
        int size = queue.size();
        // currentLayer 存本轮发现的新单词（避免层内覆盖）
        Set<String> currentLayer = new HashSet<>();

        for (int i = 0; i < size; i++) {
            String cur = queue.poll();
            char[] chars = cur.toCharArray();

            for (int j = 0; j < chars.length; j++) {
                char orig = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == orig) continue;
                    chars[j] = c;
                    String next = new String(chars);

                    if (wordSet.contains(next) && !visited.contains(next)) {
                        // 记录 next 的前驱为 cur
                        prevMap.computeIfAbsent(next, k -> new ArrayList<>()).add(cur);

                        if (!currentLayer.contains(next)) {
                            // 本层第一次发现 next，入队
                            currentLayer.add(next);
                            queue.offer(next);
                        }

                        if (next.equals(endWord)) {
                            found = true;  // 标记找到，当前层处理完后停止
                        }
                    }
                }
                chars[j] = orig;
            }
        }

        // 整层处理完，才更新 visited（保证同层节点都能作为前驱）
        visited.addAll(currentLayer);
    }

    // BFS 阶段结束，prevMap 中存储了所有最短路径上的前驱关系
    if (!found) return result;

    // DFS 阶段：沿 prevMap 从 endWord 反向还原路径
    dfs(endWord, beginWord, prevMap, new LinkedList<>(), result);
    return result;
}
```

### 2.5 DFS 阶段：沿前驱图还原路径

```java
private void dfs(String cur, String beginWord,
                 Map<String, List<String>> prevMap,
                 LinkedList<String> path,
                 List<List<String>> result) {
    // 将当前节点加到路径头部（因为是反向还原）
    path.addFirst(cur);

    if (cur.equals(beginWord)) {
        // 到达起点，记录当前完整路径
        result.add(new ArrayList<>(path));
    } else {
        // 沿前驱图继续向前还原
        for (String prev : prevMap.getOrDefault(cur, Collections.emptyList())) {
            dfs(prev, beginWord, prevMap, path, result);
        }
    }

    // 回溯：移除当前节点（撤销选择）
    path.removeFirst();
}
```

**为什么 DFS 从 `endWord` 出发反向走？**

前驱图 `prevMap` 记录的是"谁是我的前驱"，所以自然地从 `endWord` 开始，沿前驱链走回到 `beginWord`，每条完整链就是一条最短路径。用 `addFirst` 而非 `add` 是因为我们反向遍历，最终路径需要是正向的。

---

## 第 3 章 逐步模拟：追踪 BFS 前驱图的构建

用 `beginWord = "hit"`, `endWord = "cog"`, `wordList = ["hot","dot","dog","lot","log","cog"]` 模拟：

**初始**：`queue = ["hit"]`, `visited = {"hit"}`, `prevMap = {}`

**第 1 层**：处理 "hit"

发现：
- "hot"（新），`prevMap["hot"] = ["hit"]`，加入 currentLayer

currentLayer = {"hot"}，整层后 `visited = {"hit", "hot"}`

**第 2 层**：处理 "hot"

发现：
- "dot"（新），`prevMap["dot"] = ["hot"]`，加入 currentLayer
- "lot"（新），`prevMap["lot"] = ["hot"]`，加入 currentLayer

currentLayer = {"dot", "lot"}，整层后 `visited = {"hit", "hot", "dot", "lot"}`

**第 3 层**：处理 "dot" 和 "lot"

处理 "dot"：
- "dog"（新），`prevMap["dog"] = ["dot"]`，加入 currentLayer
- "lot"（已在 visited，跳过）

处理 "lot"：
- "dot"（已在 visited，跳过）
- "log"（新），`prevMap["log"] = ["lot"]`，加入 currentLayer
- "dog"（已在 currentLayer，不重复入队，但记录前驱）：`prevMap["dog"]` 追加 "lot"？

等等，"dog" 是从 "dot" 发现的，然后从 "lot" 也能到达（lo**g**? 不对，lot → l_g = log，不是 dog；dot → d_g = dog）。让我重新检查：

- lot 的变形：l**o**t，位置 0 变：aot,bot,...,dot(已访问)；位置 1 变：lat,lbt,...,lgt(不在字典)；位置 2 变：loa,lob,...,log(在字典!)

所以 "lot" 能到 "log"，"dot" 能到 "dog"，两者不交叉。

正确的 prevMap：
```
prevMap["dog"] = ["dot"]
prevMap["log"] = ["lot"]
```

currentLayer = {"dog", "log"}，整层后 `visited = {"hit", "hot", "dot", "lot", "dog", "log"}`

**第 4 层**：处理 "dog" 和 "log"

处理 "dog"：
- "cog"（新），`prevMap["cog"] = ["dog"]`，加入 currentLayer，`found = true`

处理 "log"：
- "cog"（已在 currentLayer，不重复入队），但 "log" 是 "cog" 的另一个前驱，追加：`prevMap["cog"].add("log")`

currentLayer = {"cog"}，整层处理完（found = true，停止）

**最终 prevMap**：
```
"hot" ← ["hit"]
"dot" ← ["hot"]
"lot" ← ["hot"]
"dog" ← ["dot"]
"log" ← ["lot"]
"cog" ← ["dog", "log"]
```

**DFS 从 "cog" 出发还原路径**：

```
dfs("cog", ...)
  path = ["cog"]
  prevs = ["dog", "log"]

  dfs("dog", ...)
    path = ["dog", "cog"]
    prevs = ["dot"]
    dfs("dot", ...)
      path = ["dot", "dog", "cog"]
      prevs = ["hot"]
      dfs("hot", ...)
        path = ["hot", "dot", "dog", "cog"]
        prevs = ["hit"]
        dfs("hit", ...)
          path = ["hit", "hot", "dot", "dog", "cog"]  ← 到达 beginWord！记录！

  dfs("log", ...)
    path = ["log", "cog"]
    prevs = ["lot"]
    dfs("lot", ...)
      path = ["lot", "log", "cog"]
      prevs = ["hot"]
      dfs("hot", ...)
        path = ["hot", "lot", "log", "cog"]
        prevs = ["hit"]
        dfs("hit", ...)
          path = ["hit", "hot", "lot", "log", "cog"]  ← 到达 beginWord！记录！
```

**结果**：
```
[["hit","hot","dot","dog","cog"],
 ["hit","hot","lot","log","cog"]]
```

---

## 第 4 章 解法二：双向 BFS 加速搜索

### 4.1 单向 BFS 的瓶颈

在 Word Ladder I 中提到，单向 BFS 的节点数随层数指数增长。对于分支因子 $b$（每个单词平均有 $b$ 个合法邻居），搜索深度为 $d$，BFS 需要扩展约 $b^d$ 个节点。

**具体数字**：若 $b = 10$，$d = 10$，则 BFS 需要扩展 $10^{10}$ 个节点——明显不可行。

### 4.2 双向 BFS 的核心思想

双向 BFS 从 `beginWord` 和 `endWord` 同时出发，各自向中间扩展，直到两端"相遇"。

```
单向 BFS：
beginWord ——→ ——→ ——→ endWord    需要扩展 b^d 个节点

双向 BFS：
beginWord ——→ ——→        d/2 层
                ←—— ←—— endWord  d/2 层
共扩展约 2 * b^(d/2) 个节点
```

当 $b = 10$，$d = 10$ 时：
- 单向：$10^{10}$ 个节点
- 双向：$2 \times 10^5$ 个节点（**减少 5 个数量级！**）

### 4.3 双向 BFS 的实现细节

双向 BFS 的关键：**每次扩展较小的那一端**（而不是交替扩展）。这样可以尽量保持两端扩展出的集合大小相近，最大化加速效果。

```java
public List<List<String>> findLaddersBidirectional(String beginWord, String endWord,
                                                    List<String> wordList) {
    Set<String> wordSet = new HashSet<>(wordList);
    List<List<String>> result = new ArrayList<>();
    if (!wordSet.contains(endWord)) return result;

    // 两个 frontier（前沿集合），替代队列
    Set<String> beginSet = new HashSet<>(), endSet = new HashSet<>();
    beginSet.add(beginWord);
    endSet.add(endWord);

    // 前驱图：两个方向各一份
    Map<String, List<String>> prevMap = new HashMap<>();

    Set<String> visitedBegin = new HashSet<>(beginSet);
    Set<String> visitedEnd = new HashSet<>(endSet);
    boolean found = false;
    boolean forward = true;  // 标记当前扩展方向

    while (!beginSet.isEmpty() && !endSet.isEmpty() && !found) {
        // 始终扩展较小的集合
        if (beginSet.size() > endSet.size()) {
            // 交换，改为从 end 端扩展
            Set<String> temp = beginSet;
            beginSet = endSet;
            endSet = temp;
            Set<String> tempV = visitedBegin;
            visitedBegin = visitedEnd;
            visitedEnd = tempV;
            forward = !forward;
        }

        // 扩展 beginSet 一层
        Set<String> nextLayer = new HashSet<>();
        for (String cur : beginSet) {
            char[] chars = cur.toCharArray();
            for (int j = 0; j < chars.length; j++) {
                char orig = chars[j];
                for (char c = 'a'; c <= 'z'; c++) {
                    if (c == orig) continue;
                    chars[j] = c;
                    String next = new String(chars);

                    if (wordSet.contains(next) && !visitedBegin.contains(next)) {
                        // 记录前驱（注意方向）
                        if (forward) {
                            prevMap.computeIfAbsent(next, k -> new ArrayList<>()).add(cur);
                        } else {
                            prevMap.computeIfAbsent(cur, k -> new ArrayList<>()).add(next);
                        }

                        if (endSet.contains(next)) {
                            found = true;  // 两端相遇！
                        }
                        nextLayer.add(next);
                    }
                }
                chars[j] = orig;
            }
        }

        visitedBegin.addAll(nextLayer);
        beginSet = nextLayer;
    }

    if (!found) return result;
    dfs(endWord, beginWord, prevMap, new LinkedList<>(), result);
    return result;
}
```

> [!warning] 生产避坑：双向 BFS 的方向跟踪
> 当交换 `beginSet` 和 `endSet` 时，记录前驱的方向也要调整。`forward` 标志跟踪当前是"正向扩展"还是"反向扩展"，决定了 `prevMap` 中边的方向。如果方向搞反，DFS 阶段还原路径时会走向错误的方向。

---

## 第 5 章 复杂度对比与适用场景

### 5.1 单向 BFS vs 双向 BFS

| 指标 | 单向 BFS | 双向 BFS |
|------|---------|---------|
| 时间复杂度 | $O(b^d \cdot L^2)$ | $O(b^{d/2} \cdot L^2)$ |
| 空间复杂度 | $O(b^d \cdot L)$ | $O(b^{d/2} \cdot L)$ |
| 实现复杂度 | 低 | 较高（需处理方向和集合交换） |
| 适用场景 | 分支因子小或 d 较小 | 分支因子大且 d 较大 |

### 5.2 什么时候选双向 BFS

双向 BFS 在**以下条件同时满足**时有显著优势：

1. **已知起点和终点**（单向 BFS 只需已知起点）
2. **图的分支因子较大**（否则加速效果不明显）
3. **状态空间关于起终点对称**（两端扩展速度相近时效果最好）

Word Ladder 满足所有条件：`beginWord` 和 `endWord` 都已知，且每个单词有多个邻居。

### 5.3 Word Ladder II 的整体复杂度

BFS 阶段：$O(26 \times n \times L^2)$（同 Word Ladder I，枚举所有邻居）

DFS 阶段：$O(\text{路径数} \times d)$，其中路径数最坏情况为 $n!$（极端情况），但实际因题目约束远小于此。

---

## 第 6 章 代码 Bug 的常见根源与调试指南

Word Ladder II 是面试中极易出 bug 的题目。以下列出最常见的错误：

### 6.1 Bug 一：层内未去重导致重复入队

**症状**：同一条路径出现多次，或 TLE（超时）。

**原因**：同层内发现同一个新单词时，没有通过 `currentLayer` 去重，多次入队。

**修复**：使用 `currentLayer` 集合记录本层已入队的单词，在入队前检查。

### 6.2 Bug 二：visited 在层内更新导致路径丢失

**症状**：输出路径不全，漏掉了某些最短路径。

**原因**：在处理当前层时，把发现的新单词立即加入全局 `visited`，导致同层的其他单词无法将同一节点作为目标。

**修复**：`visited.addAll(currentLayer)` 必须在**整层处理完之后**执行。

### 6.3 Bug 三：DFS 中忘记回溯

**症状**：路径包含重复元素，或路径长度不对。

**原因**：DFS 做了 `path.addFirst(cur)`，但没有对应的 `path.removeFirst()`（回溯）。

**修复**：确保每一次 `addFirst` 对应一次 `removeFirst`，无论是正常返回还是递归结束。

### 6.4 Bug 四：prevMap 中前驱方向弄反

**症状**：DFS 阶段无法从 `endWord` 走回 `beginWord`，或走出无限循环。

**原因**：`prevMap` 存储的应该是"每个词的前驱"（反向边），但被写成了"每个词的后继"（正向边）。

**修复**：明确 `prevMap[next] = cur` 的含义是"next 的一个前驱是 cur"，DFS 从 `endWord` 出发，沿前驱链走回 `beginWord`。

---

## 第 7 章 面试答题示范

Word Ladder II 在面试中通常作为"追加题"出现，考察能否在 Word Ladder I 基础上快速扩展。

**推荐答题步骤**：

1. 明确两个阶段：BFS 构建前驱图 + DFS 还原路径
2. 解释"分层 visited"的必要性（避免层内交叉丢失路径）
3. 先实现 BFS 阶段，再实现 DFS 阶段（分治降低复杂度）
4. 如果面试官追问性能，提出双向 BFS 优化

**一个常见的面试陷阱**："直接在 BFS 中存完整路径"——这会导致指数级内存占用，面试官会追问空间复杂度，到时候就被动了。主动用前驱图方案，体现了对内存效率的思考。

---

## 本章小结

Word Ladder II 把一道 BFS 题升华成了一道涉及**前驱图**、**分层 visited**、**双向 BFS** 三个技术点的综合难题。核心洞察是：

1. 记录所有最短路径时，**路径还原**和**最短路径搜索**是两个独立的子问题——分开解决，各自清晰
2. 同层节点对后续节点都可能是合法前驱，**visited 必须在整层结束后更新**
3. 双向 BFS 将指数级复杂度压缩为平方根级，对大规模数据至关重要

下一篇文章将转换视角，从 BFS 转入 DFS 的核心框架，以及回溯算法的通用模板，并以 Surrounded Regions 为例展示 DFS 在矩阵问题上的应用。

---

*关联文章：[[BFS 核心框架：层序扩展与单向最短路径]] | [[DFS 与回溯核心框架：状态树的系统性遍历]]*
