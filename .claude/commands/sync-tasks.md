# sync-tasks

扫描 `Inbox-Task池/` 中所有 `status: doing` 的任务文件，读取每个文件的最新内容，然后更新 memory 文件。

## 执行步骤

1. 用 Grep 在 `content/工作管理/Inbox-Task池/` 下查找所有包含 `status: doing` 的文件
2. 用 Read 读取每个文件的 frontmatter 和关键内容（目标、实施记录、踩坑日志）
3. 更新 `/Users/lihaopeng/.claude/projects/-Users-lihaopeng-Documents-my-brain/memory/tasks-state.md`：
   - 按 priority 排序（P0 优先）
   - 每个任务记录：进度百分比、截止日期、已完成事项、待完成事项、卡点/踩坑、下一里程碑
4. 更新 `/Users/lihaopeng/.claude/projects/-Users-lihaopeng-Documents-my-brain/memory/MEMORY.md` 中的快照表格（进度 + 截止日期列）

## 输出

执行完成后告知用户：
- 共扫描了几个 doing 任务
- 哪些任务进度有变化（如果能判断的话）
- 提醒：下次任务里程碑后记得再次运行 `/sync-tasks`
