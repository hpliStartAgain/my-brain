---
type: task
status: doing
priority: P0
deadline: 2026-03-28
domain: 计算治理
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-03-16
---

## 🎯 目标与验收标准

### 本周目标（3.16-3.20）
- [ ] 完成 GSS 评分流水线（PantherSparkEventJob 扩展）生产环境部署，无启动报错
- [ ] 验证 `dwd_panther_spark_sql_plan` 和 `dwd_panther_spark_job` 新增字段正确写入：`job_gss_score`、`gss_label`、`cpu_intensity` 等 ~15 个向量化字段不为 NULL
- [ ] 至少跑通近 2 天的 EventLog 历史数据回刷，确认 GSS 评分分布合理（≥70 分作业占比在预期区间）

### 整体验收标准
- [ ] GSS 评分流水线连续稳定运行 ≥ 7 天无异常（日志无 ERROR，数据无断档）
- [ ] bdwh 用户候选白名单作业识别完成（GSS ≥ 70 的作业清单可导出）
- [ ] Superset 看板上线：展示白名单作业列表（作业名、GSS 评分、预估 CPU 收益）、GSS 分层分布图

## ⚙️ 参考执行路径

### Step 1：生产部署（3.16-3.17）

1. 将 PantherSparkEventJob 新增的 3 类事件解析（`SQLExecutionStart/End`、`GlutenFallbackEvent`）和 14 个 GSS UDF 合并到生产代码分支
2. 在测试队列先以小批量 EventLog 验证（建议取近 1 天 bdwh 的 EventLog，约 100 个作业）
3. 确认无报错后提交生产调度，设置每日定时运行

### Step 2：数据验证（3.17-3.19）

```sql
-- 验证 sql_plan 新增字段
SELECT count(*),
       count(gss_base_score) as has_gss,
       count(input_format) as has_format
FROM dwd_panther_spark_sql_plan
WHERE dt = '${yesterday}';

-- 验证 job 表 GSS 字段
SELECT gss_label, count(*) as cnt
FROM dwd_panther_spark_job
WHERE dt = '${yesterday}'
GROUP BY gss_label
ORDER BY cnt DESC;
-- 期望：有 RECOMMEND/CAUTIOUS/NOT_RECOMMENDED 三类分布
```

### Step 3：白名单遴选查询（3.19-3.20）

```sql
-- 筛选 bdwh 用户 GSS ≥ 70 的高优先级候选作业
SELECT job_name, user, job_gss_score, cpu_intensity,
       avg_cpu_usage, avg_duration_sec
FROM dwd_panther_spark_job
WHERE user = 'bdwh'
  AND gss_label = 'RECOMMEND'
  AND dt >= date_sub(current_date, 7)
GROUP BY job_name, user, job_gss_score, cpu_intensity
ORDER BY job_gss_score DESC, avg_cpu_usage DESC
LIMIT 50;
```

将结果导出 CSV，整理为 Superset 数据集，确认数据质量后准备看板开发。

## 🐛 踩坑日志 (Troubleshooting)
-
