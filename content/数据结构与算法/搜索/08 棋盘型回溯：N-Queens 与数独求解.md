---
title: "棋盘型回溯：N-Queens 与数独求解的约束传播艺术"
date: 2026-04-28
tags: [LeetCode, N-Queens, 位运算, 回溯, 数独, 算法, 约束传播, 面试]
aliases: [N-Queens, Sudoku Solver, 棋盘回溯, 约束传播, LeetCode 51, LeetCode 37]
---

# 棋盘型回溯：N-Queens 与数独求解的约束传播艺术

## 摘要

棋盘型回溯是回溯算法中约束最复杂、剪枝最激进的题型。N-Queens（N 皇后）和 Sudoku Solver（数独求解）都要求在一个二维棋盘上放置元素，同时满足多个方向的约束。本文深入分析这两道题的约束体系，推导出 N-Queens 的对角线索引公式，以及用位运算实现 $O(1)$ 的约束检查。Sudoku 则引入"约束传播"的思想——不只是检查约束，而是在放置一个数字后主动推导其他格子的约束收窄，从而大幅缩小搜索空间。

---

## 第 1 章 棋盘型回溯的特征

### 1.1 棋盘约束的多维性

组合/字符串型回溯，约束是一维的（路径和、回文性、括号平衡）。棋盘型回溯的约束是**多维的**：N-Queens 需要同时检查行、列、两个对角线；数独需要同时检查行、列、3×3 宫格。

这种多维约束的处理方式，决定了算法的性能。

### 1.2 棋盘搜索的状态定义

**N-Queens 的搜索树**：每层对应棋盘的一行，每次选择在该行的哪一列放皇后。深度 = 行数 = $n$，每层分支数最多 $n$（每列一个选择）。

**Sudoku 的搜索树**：按顺序（行优先）枚举每个空格，对每个空格尝试 1-9。深度 = 空格数，每层分支数最多 9。

---

## 第 2 章 LeetCode 51：N-Queens

### 2.1 题目

**LeetCode 51 - N-Queens**（困难）：

按照国际象棋的规则，皇后可以攻击同一行、同一列或同一斜线上的棋子。将 `n` 个皇后放置在 $n \times n$ 的棋盘上，且使皇后彼此之间不能相互攻击。返回所有解法。

```
输入：n=4
输出：[[".Q..","...Q","Q...","..Q."],
       ["..Q.","Q...","...Q",".Q.."]]
```

### 2.2 约束分析

**约束一：同列不能有两个皇后**

记录哪些列已被占用：`boolean[] cols = new boolean[n]`

**约束二：主对角线（\方向）不能有两个皇后**

主对角线上的格子满足：`row - col = 常数`（范围 `[-(n-1), n-1]`）

用 `row - col + (n-1)` 做偏移变换，范围变为 `[0, 2n-2]`，用 `boolean[] diag1 = new boolean[2*n-1]`

**约束三：副对角线（/方向）不能有两个皇后**

副对角线上的格子满足：`row + col = 常数`（范围 `[0, 2n-2]`）

用 `boolean[] diag2 = new boolean[2*n-1]`

> [!info] 核心概念：对角线索引的推导
> 为什么主对角线用 `row - col + (n-1)` 作为索引？
>
> 在 $n=4$ 的棋盘上：
> - `(0,0)`, `(1,1)`, `(2,2)`, `(3,3)`：`row-col=0`
> - `(0,1)`, `(1,2)`, `(2,3)`：`row-col=-1`
> - `(1,0)`, `(2,1)`, `(3,2)`：`row-col=1`
>
> `row-col` 的范围是 `[-(n-1), n-1]`，加上偏移 `n-1` 后变为 `[0, 2n-2]`，可以直接用作数组索引。

**约束四：同行不能有两个皇后**

按行搜索（每层处理一行），天然保证每行最多一个皇后，不需要额外记录。

### 2.3 实现

```java
public List<List<String>> solveNQueens(int n) {
    List<List<String>> result = new ArrayList<>();
    boolean[] cols = new boolean[n];
    boolean[] diag1 = new boolean[2 * n - 1];  // 主对角线 row-col+n-1
    boolean[] diag2 = new boolean[2 * n - 1];  // 副对角线 row+col

    int[] queens = new int[n];  // queens[row] = col，记录每行皇后所在列
    Arrays.fill(queens, -1);

    backtrack(n, 0, cols, diag1, diag2, queens, result);
    return result;
}

private void backtrack(int n, int row,
                        boolean[] cols, boolean[] diag1, boolean[] diag2,
                        int[] queens, List<List<String>> result) {
    if (row == n) {
        // 所有行都放好了，生成棋盘
        result.add(buildBoard(queens, n));
        return;
    }

    for (int col = 0; col < n; col++) {
        int d1 = row - col + n - 1;  // 主对角线索引
        int d2 = row + col;           // 副对角线索引

        // 检查列、主对角线、副对角线是否被占用
        if (cols[col] || diag1[d1] || diag2[d2]) continue;

        // 做选择
        queens[row] = col;
        cols[col] = true;
        diag1[d1] = true;
        diag2[d2] = true;

        backtrack(n, row + 1, cols, diag1, diag2, queens, result);

        // 撤销选择
        queens[row] = -1;
        cols[col] = false;
        diag1[d1] = false;
        diag2[d2] = false;
    }
}

private List<String> buildBoard(int[] queens, int n) {
    List<String> board = new ArrayList<>();
    for (int row = 0; row < n; row++) {
        char[] rowChars = new char[n];
        Arrays.fill(rowChars, '.');
        if (queens[row] != -1) rowChars[queens[row]] = 'Q';
        board.add(new String(rowChars));
    }
    return board;
}
```

**时间复杂度**：$O(n!)$——第一行有 $n$ 个选择，第二行最多 $n-1$ 个（列约束），依此类推。实际因对角线约束更快。

### 2.4 LeetCode 52：N-Queens II（只求方案数）

**LeetCode 52 - N-Queens II**（困难）：只返回方案数量，不需要构建棋盘。

```java
public int totalNQueens(int n) {
    boolean[] cols = new boolean[n];
    boolean[] diag1 = new boolean[2 * n - 1];
    boolean[] diag2 = new boolean[2 * n - 1];
    return backtrack(n, 0, cols, diag1, diag2);
}

private int backtrack(int n, int row, boolean[] cols, boolean[] diag1, boolean[] diag2) {
    if (row == n) return 1;  // 找到一个解
    int count = 0;
    for (int col = 0; col < n; col++) {
        int d1 = row - col + n - 1, d2 = row + col;
        if (cols[col] || diag1[d1] || diag2[d2]) continue;
        cols[col] = diag1[d1] = diag2[d2] = true;
        count += backtrack(n, row + 1, cols, diag1, diag2);
        cols[col] = diag1[d1] = diag2[d2] = false;
    }
    return count;
}
```

### 2.5 位运算优化：O(1) 约束检查

对于较大的 $n$（如 $n=32$），可以用位运算将三个约束压缩到整数中，做 $O(1)$ 的批量检查：

```java
// cols, diag1, diag2 分别用整数的各个位表示
// 每列对应一个 bit
int cols = 0, diag1 = 0, diag2 = 0;

// 检查某列 col 是否可用
boolean canPlace = ((cols >> col) & 1) == 0 &&
                   ((diag1 >> d1) & 1) == 0 &&
                   ((diag2 >> d2) & 1) == 0;

// 标记占用
cols |= (1 << col);
diag1 |= (1 << d1);
diag2 |= (1 << d2);

// 撤销
cols ^= (1 << col);
diag1 ^= (1 << d1);
diag2 ^= (1 << d2);
```

**更进一步的位运算技巧**：可用 `available = ((1 << n) - 1) & ~(cols | (diag1 >> ...) | (diag2 >> ...))` 一次性计算所有可用列的位掩码，再通过 `available & (-available)` 取最低位（下一个可用列），实现高效枚举。这是竞赛选手的高级技巧，面试中不常考，了解即可。

---

## 第 3 章 LeetCode 37：Sudoku Solver

### 3.1 题目

**LeetCode 37 - Sudoku Solver**（困难）：

编写一个程序，通过填充空格来解决数独问题。数独的解法需**遵循如下规则**：
- 数字 1-9 在每一行只能出现一次
- 数字 1-9 在每一列只能出现一次
- 数字 1-9 在每一个以粗实线分隔的 3×3 宫内只能出现一次

空白格用 `'.'` 表示，有唯一解。

### 3.2 约束体系设计

数独有三类约束，需要维护三个集合：

```java
boolean[][] rowUsed = new boolean[9][10];   // rowUsed[i][num] = num 是否在第 i 行
boolean[][] colUsed = new boolean[9][10];   // colUsed[j][num] = num 是否在第 j 列
boolean[][] boxUsed = new boolean[9][10];   // boxUsed[b][num] = num 是否在第 b 宫

// 宫格索引：(i/3)*3 + j/3
// (0,0)-(2,2) 是宫 0，(0,3)-(2,5) 是宫 1，...，(6,6)-(8,8) 是宫 8
```

初始化时，读取已有数字填入三个集合。

### 3.3 搜索顺序的重要性

朴素实现：按行优先顺序（逐行逐列）遍历空格，依次尝试。

**更优化的选择：优先处理约束最多的空格**（可用数字最少的格子）。如果某个格子只有 1 个可用数字，优先处理它，几乎不增加搜索树的宽度；如果某个格子有 9 个可用数字，推迟处理，否则搜索树会迅速展开。

这种策略在人工解数独时非常自然，在算法中称为 **MRV（Minimum Remaining Values）启发式**。

### 3.4 基础实现（按顺序搜索）

```java
public void solveSudoku(char[][] board) {
    boolean[][] rowUsed = new boolean[9][10];
    boolean[][] colUsed = new boolean[9][10];
    boolean[][] boxUsed = new boolean[9][10];

    // 初始化：读取已有数字
    for (int i = 0; i < 9; i++) {
        for (int j = 0; j < 9; j++) {
            if (board[i][j] != '.') {
                int num = board[i][j] - '0';
                int box = (i / 3) * 3 + (j / 3);
                rowUsed[i][num] = true;
                colUsed[j][num] = true;
                boxUsed[box][num] = true;
            }
        }
    }

    backtrack(board, rowUsed, colUsed, boxUsed, 0, 0);
}

private boolean backtrack(char[][] board,
                            boolean[][] rowUsed, boolean[][] colUsed, boolean[][] boxUsed,
                            int row, int col) {
    // 找下一个空格
    while (row < 9 && board[row][col] != '.') {
        col++;
        if (col == 9) { col = 0; row++; }
    }

    // 所有格子都填完了
    if (row == 9) return true;

    int box = (row / 3) * 3 + (col / 3);

    for (int num = 1; num <= 9; num++) {
        // 检查三类约束
        if (rowUsed[row][num] || colUsed[col][num] || boxUsed[box][num]) continue;

        // 做选择
        board[row][col] = (char) ('0' + num);
        rowUsed[row][num] = true;
        colUsed[col][num] = true;
        boxUsed[box][num] = true;

        // 递归（找下一个空格）
        if (backtrack(board, rowUsed, colUsed, boxUsed, row, col + 1 == 9 ? row + 1 : row,
                      col + 1 == 9 ? 0 : col + 1)) {
            return true;  // 找到解，直接返回（无需收集所有解）
        }

        // 撤销选择
        board[row][col] = '.';
        rowUsed[row][num] = false;
        colUsed[col][num] = false;
        boxUsed[box][num] = false;
    }

    return false;  // 当前格子所有数字都试过，无解，回溯
}
```

> [!note] 设计哲学：返回 boolean 而非 void
> Sudoku Solver 只需找到一个解（题目保证唯一解），一旦找到就应立即停止，而不是继续搜索。因此 `backtrack` 返回 `boolean`：找到解返回 `true`，外层递归看到 `true` 立即向上传递。这是"找一个解"类问题的标准实现方式。

### 3.5 进阶：约束传播（Constraint Propagation）

纯粹的回溯在遇到难度极高的数独时仍然可能很慢。真正的数独解题器（如 Peter Norvig 的著名实现）会结合**约束传播**：

**基本思想**：放置一个数字后，不只是标记这个格子，还"传播"约束——这个数字对同行/同列/同宫的其他空格可用数字的影响。如果某个格子因此只剩 1 个可用数字，立即"强制"填入（Naked Single），不需要枚举。

```
放置 board[0][0] = 5
↓
第 0 行：所有空格不能再选 5
第 0 列：所有空格不能再选 5
宫 0：所有空格不能再选 5
↓
如果 board[0][3] 因此只剩数字 7 可选 → 强制填入 7
↓
继续传播：填入 7 后，同行/列/宫继续收窄...
```

约束传播可以在不增加搜索树宽度的前提下，提前确定大量格子的值，从而大幅减少实际需要搜索的格子数量。面试中了解这个思想即可，完整实现复杂度较高。

### 3.6 逐步模拟（简化版）

以一个简单数独片段为例：

```
初始：. 3 . | . . . | . . .
     . . . | 1 9 5 | . . .
     . . 8 | . . . | . 6 .
     ------+-------+------
     ...
```

从 `(0,0)` 开始：

```
(0,0) 可用数字 = {1-9} - row[0]:{3} - col[0]:{...} - box[0]:{3,8,...}
     假设可用 = {1,2,4,5,6,7,9}

尝试 1：
  放 board[0][0] = 1
  递归找 (0,2)（(0,1) 已有 3）
  ...
  如果某步发现无解，回溯，尝试 2
  ...
```

---

## 第 4 章 N-Queens vs Sudoku：约束复杂度对比

| 维度 | N-Queens | Sudoku |
|------|---------|--------|
| 棋盘大小 | $n \times n$ | $9 \times 9$（固定） |
| 约束维度 | 列 + 2 个对角线 | 行 + 列 + 宫格 |
| 每层选择数 | 最多 $n$ | 最多 9 |
| 搜索树规模 | $O(n!)$（近似） | $O(9^{空格数})$（近似） |
| 是否有多解 | 有多解，需收集 | 唯一解，找到即停 |
| 关键优化 | 对角线索引公式 | MRV 启发式 + 约束传播 |

两类问题的核心区别：N-Queens 问的是"所有方案"（需完整搜索），Sudoku 问的是"一个解"（找到即停）。这决定了实现时是否需要继续搜索找到解后立即返回。

---

## 第 5 章 面试高频追问

### 5.1 "N-Queens 的复杂度是多少？能否精确估算？"

N-Queens 的精确解数量（即搜索树叶节点数）随 $n$ 的变化：

| n | 解数量 |
|---|--------|
| 1 | 1 |
| 4 | 2 |
| 5 | 10 |
| 6 | 4 |
| 8 | 92 |
| 12 | 14200 |

没有封闭解析式，渐近上界约为 $O(n!)$，但实际因对角线约束远小于 $n!$。常见的答法：$O(n!)$ 作为时间复杂度的上界，实际运行时间远小于此。

### 5.2 "如何优化 N-Queens 到位运算版本？"

将三个 boolean 数组压缩为三个整数，每个 bit 对应一个位置：

```java
int totalNQueens(int n) {
    return solve(n, 0, 0, 0, 0);
}

int solve(int n, int row, int cols, int diag1, int diag2) {
    if (row == n) return 1;
    int available = ((1 << n) - 1) & ~(cols | diag1 | diag2);
    int count = 0;
    while (available != 0) {
        int pos = available & (-available);  // 取最低位（最右边的 1）
        available &= available - 1;          // 清除最低位
        count += solve(n, row + 1,
                       cols | pos,
                       (diag1 | pos) << 1,  // 主对角线向下一行移位
                       (diag2 | pos) >> 1); // 副对角线向下一行移位
    }
    return count;
}
```

这个实现中，`diag1` 和 `diag2` 的移位操作模拟了对角线向下传播的效果，非常精妙。对于 $n \leq 32$，完全可以用这个实现。

### 5.3 "Sudoku 的时间复杂度是多少？"

数独有 81 个格子，最多 81 个空格，每格尝试 1-9 → 理论上界 $O(9^{81})$。但因为约束（每行/列/宫最多 9 个数字各只能出现一次），实际可用选择远少于 9，搜索树被极度剪枝。

实际上，当前存在 $O(1)$ 解数独的算法（对于有唯一解的标准数独），通过 Dancing Links（精确覆盖问题的高效解法）实现。面试中不需要知道这个，提到"约束传播大幅减少实际搜索量"即可。

---

## 第 6 章 完整代码汇总

### 6.1 N-Queens 完整实现

```java
class Solution {
    public List<List<String>> solveNQueens(int n) {
        List<List<String>> result = new ArrayList<>();
        boolean[] cols = new boolean[n];
        boolean[] diag1 = new boolean[2 * n - 1];
        boolean[] diag2 = new boolean[2 * n - 1];
        int[] queens = new int[n];
        Arrays.fill(queens, -1);
        backtrack(n, 0, cols, diag1, diag2, queens, result);
        return result;
    }

    private void backtrack(int n, int row, boolean[] cols, boolean[] diag1, boolean[] diag2,
                            int[] queens, List<List<String>> result) {
        if (row == n) { result.add(buildBoard(queens, n)); return; }
        for (int col = 0; col < n; col++) {
            int d1 = row - col + n - 1, d2 = row + col;
            if (cols[col] || diag1[d1] || diag2[d2]) continue;
            queens[row] = col;
            cols[col] = diag1[d1] = diag2[d2] = true;
            backtrack(n, row + 1, cols, diag1, diag2, queens, result);
            queens[row] = -1;
            cols[col] = diag1[d1] = diag2[d2] = false;
        }
    }

    private List<String> buildBoard(int[] queens, int n) {
        List<String> board = new ArrayList<>();
        for (int row = 0; row < n; row++) {
            char[] r = new char[n];
            Arrays.fill(r, '.');
            if (queens[row] != -1) r[queens[row]] = 'Q';
            board.add(new String(r));
        }
        return board;
    }
}
```

### 6.2 Sudoku Solver 完整实现

```java
class Solution {
    public void solveSudoku(char[][] board) {
        boolean[][] rowUsed = new boolean[9][10];
        boolean[][] colUsed = new boolean[9][10];
        boolean[][] boxUsed = new boolean[9][10];

        for (int i = 0; i < 9; i++) {
            for (int j = 0; j < 9; j++) {
                if (board[i][j] != '.') {
                    int num = board[i][j] - '0';
                    rowUsed[i][num] = colUsed[j][num] = boxUsed[(i/3)*3+j/3][num] = true;
                }
            }
        }
        backtrack(board, rowUsed, colUsed, boxUsed, 0, 0);
    }

    private boolean backtrack(char[][] board, boolean[][] rowUsed, boolean[][] colUsed,
                               boolean[][] boxUsed, int i, int j) {
        // 找下一个空格
        while (i < 9) {
            if (board[i][j] == '.') break;
            j++;
            if (j == 9) { j = 0; i++; }
        }
        if (i == 9) return true;  // 全部填完

        int box = (i / 3) * 3 + (j / 3);
        int nextJ = j + 1 == 9 ? 0 : j + 1;
        int nextI = j + 1 == 9 ? i + 1 : i;

        for (int num = 1; num <= 9; num++) {
            if (rowUsed[i][num] || colUsed[j][num] || boxUsed[box][num]) continue;
            board[i][j] = (char)('0' + num);
            rowUsed[i][num] = colUsed[j][num] = boxUsed[box][num] = true;
            if (backtrack(board, rowUsed, colUsed, boxUsed, nextI, nextJ)) return true;
            board[i][j] = '.';
            rowUsed[i][num] = colUsed[j][num] = boxUsed[box][num] = false;
        }
        return false;
    }
}
```

---

## 本章小结

棋盘型回溯的两道题，各自展示了约束的不同处理方式：

- **N-Queens**：约束可以被编码为简单的布尔数组（列、对角线），用数学公式（`row±col`）确定索引，约束检查 $O(1)$；位运算版本进一步将三个数组压缩为三个整数
- **Sudoku**：约束来自三个维度（行列宫），用三个布尔数组维护；约束传播思想（MRV + Naked Single）可以在搜索前"推断"出部分答案，大幅缩小搜索空间

下一篇文章进入矩阵路径搜索——Word Search，展示 DFS 在矩阵上"找路径"（而非"标记区域"）时的实现技巧和 Trie 树优化。

---

*关联文章：[[字符串型回溯：分割、括号生成与 IP 地址恢复]] | [[矩阵深搜：Word Search 与路径问题]]*
