**背景**: 排查 Hive on Tez 作业因 `AbstractMethodError: GenericUDF.initializeAndFoldConstants` 失败时，用于对比不同分区查询计划、判断常量折叠是否为触发路径的操作手册。

---

## 第一步：准备 SQL 文件

**不要在 beeline 交互模式下直接粘贴多行 SQL**——beeline 的 readline Tab 补全会在 `and`/`or` 等关键字处触发 "Display all N possibilities?" 提示，用户的回车/字符会混入 SQL 导致 ParseException。

在服务器上创建两个文件：

```bash
# 失败的查询（20260319 分区）
cat > /tmp/explain_fail.sql << 'EOF'
set hive.optimize.constant.propagation=true;

EXPLAIN EXTENDED
insert overwrite table msns.mvp_dwd_event_base_all partition(dt)
select
        session_id, create_time, x.user_id, x.passport_id, x.phone_no,
        channel_id,
        nvl(x.sub_channel_id,y.sub_channel_id) sub_channel_id,
        if(x.sub_channel_id is null and y.sub_channel_id is not null,'1','0') sub_channel_id_fix_flag,
        device_id, os, app_version, ip, event, action, circle_id, feed_flow,
        content1, android_id, oaid, source_page, source_click, activity_id, content, dynamic_page, dt
from msns.mvp_dwd_event_base_all x
left join (
        select de_phone_no, sub_channel_id
        from (
                select  a.de_phone_no, b.sub_channel_id,
                        row_number()over(partition by a.de_phone_no order by b.create_time desc) rn
                from (
                        select msns.custom_decrypt(phone_no) de_phone_no, min(create_time) create_time
                        from msns.mvp_dwd_event_base_all
                        where dt = '20260319'
                        and phone_no is not null and phone_no <> '' and user_id is not null
                        and action not in('P_ACTIVITY_H5','P_ACTIVITY_PULLNEW','P_DOWNLOAD',
                                          'C_ACTIVITY_DOWNLOAD','C_ACTIVITY_PULLNEW_DOWNLOAD','C_DOWNLOAD_BUTTON')
                        group by msns.custom_decrypt(phone_no)
                ) a
                join (
                        select  msns.parse_phone_no(content1) phone_no, sub_channel_id, create_time
                        from msns.mvp_dwd_event_click
                        where dt >= '20260318' and dt <= '20260319'
                        and position = 'C_ACTIVITY_DOWNLOAD'
                        and content1 is not null and sub_channel_id is not null
                ) b on a.de_phone_no = b.phone_no
                where a.create_time >= b.create_time
        ) t where rn = 1
) y on nvl(msns.custom_decrypt(x.phone_no),concat('rand',rand()*1000)) = y.de_phone_no
where x.dt = '20260319'
;
EOF

# 成功的查询（20260318 分区）
cat > /tmp/explain_ok.sql << 'EOF'
set hive.optimize.constant.propagation=true;

EXPLAIN EXTENDED
insert overwrite table msns.mvp_dwd_event_base_all partition(dt)
select
        session_id, create_time, x.user_id, x.passport_id, x.phone_no,
        channel_id,
        nvl(x.sub_channel_id,y.sub_channel_id) sub_channel_id,
        if(x.sub_channel_id is null and y.sub_channel_id is not null,'1','0') sub_channel_id_fix_flag,
        device_id, os, app_version, ip, event, action, circle_id, feed_flow,
        content1, android_id, oaid, source_page, source_click, activity_id, content, dynamic_page, dt
from msns.mvp_dwd_event_base_all x
left join (
        select de_phone_no, sub_channel_id
        from (
                select  a.de_phone_no, b.sub_channel_id,
                        row_number()over(partition by a.de_phone_no order by b.create_time desc) rn
                from (
                        select msns.custom_decrypt(phone_no) de_phone_no, min(create_time) create_time
                        from msns.mvp_dwd_event_base_all
                        where dt = '20260318'
                        and phone_no is not null and phone_no <> '' and user_id is not null
                        and action not in('P_ACTIVITY_H5','P_ACTIVITY_PULLNEW','P_DOWNLOAD',
                                          'C_ACTIVITY_DOWNLOAD','C_ACTIVITY_PULLNEW_DOWNLOAD','C_DOWNLOAD_BUTTON')
                        group by msns.custom_decrypt(phone_no)
                ) a
                join (
                        select  msns.parse_phone_no(content1) phone_no, sub_channel_id, create_time
                        from msns.mvp_dwd_event_click
                        where dt >= '20260317' and dt <= '20260318'
                        and position = 'C_ACTIVITY_DOWNLOAD'
                        and content1 is not null and sub_channel_id is not null
                ) b on a.de_phone_no = b.phone_no
                where a.create_time >= b.create_time
        ) t where rn = 1
) y on nvl(msns.custom_decrypt(x.phone_no),concat('rand',rand()*1000)) = y.de_phone_no
where x.dt = '20260318'
;
EOF
```

---

## 第二步：执行 EXPLAIN 并保存输出

```bash
HS2="jdbc:hive2://hs1.venus.sohurdc.com:10015/default"
USER="your_username"

beeline -u "$HS2" -n "$USER" -f /tmp/explain_fail.sql 2>/dev/null \
  | grep -v "^Connecting\|^Connected\|^SLF4J\|^log4j\|rows affected" \
  > /tmp/plan_fail.txt

beeline -u "$HS2" -n "$USER" -f /tmp/explain_ok.sql 2>/dev/null \
  | grep -v "^Connecting\|^Connected\|^SLF4J\|^log4j\|rows affected" \
  > /tmp/plan_ok.txt

echo "失败计划行数: $(wc -l < /tmp/plan_fail.txt)"
echo "成功计划行数: $(wc -l < /tmp/plan_ok.txt)"
```

---

## 第三步：定位 parse_phone_no 所在的 Map 算子

```bash
# 在两个计划中分别找 parse_phone_no 出现的上下文
echo "=== 失败计划中 parse_phone_no 的表达式 ==="
grep -n -A 5 -B 5 "parse_phone_no" /tmp/plan_fail.txt

echo ""
echo "=== 成功计划中 parse_phone_no 的表达式 ==="
grep -n -A 5 -B 5 "parse_phone_no" /tmp/plan_ok.txt
```

---

## 第四步：识别关键差异

在 EXPLAIN EXTENDED 输出里，重点关注 `parse_phone_no` 所在的 Select Operator 的 `expressions` 字段。

**看参数是列引用还是常量字面量：**

| 输出内容 | 含义 |
|---------|------|
| `parse_phone_no(content1:string)` | 参数是列引用，**无常量折叠** |
| `parse_phone_no('某固定字符串':string)` | 参数被替换为常量，**触发了常量传播** |

**看两个计划的 Map 数量是否一致：**

```bash
grep -c "Map Operator Tree" /tmp/plan_fail.txt
grep -c "Map Operator Tree" /tmp/plan_ok.txt
```

Map 数量不同说明执行计划结构已经产生分叉，需要逐段对比。

**整体 diff：**

```bash
diff /tmp/plan_fail.txt /tmp/plan_ok.txt | head -80
```

---

## 第五步：验证常量折叠是否为根因

用开关对照实验直接确认——这比 EXPLAIN 更权威：

```bash
cat > /tmp/test_no_cp.sql << 'EOF'
-- 关闭常量传播，跑失败版本
set hive.optimize.constant.propagation=false;

insert overwrite table msns.mvp_dwd_event_base_all partition(dt)
-- ... 粘贴 20260319 版本的完整 SQL ...
;
EOF

beeline -u "$HS2" -n "$USER" -f /tmp/test_no_cp.sql
```

| 结果 | 结论 |
|------|------|
| 成功执行 | **确认**：常量折叠触发了 `initializeAndFoldConstants` 调用路径，是根因 |
| 仍然失败，报同一错误 | 常量折叠不是根因，问题在其他地方（如 Tez 容器 hive-exec 版本不一致） |
| 失败，报不同错误 | 存在其他独立问题，需单独排查 |

---

## 第六步：对比两个分区的统计信息（辅助）

常量传播优化器有时会根据列统计信息（null count、distinct count）决定是否尝试折叠。如果 20260319 分区某列统计信息异常（如 null count = 总行数），优化器可能判断该列为常量。

```sql
-- 查两个分区的列统计
ANALYZE TABLE msns.mvp_dwd_event_click PARTITION(dt='20260319')
  COMPUTE STATISTICS FOR COLUMNS content1, sub_channel_id;

ANALYZE TABLE msns.mvp_dwd_event_click PARTITION(dt='20260318')
  COMPUTE STATISTICS FOR COLUMNS content1, sub_channel_id;

DESCRIBE FORMATTED msns.mvp_dwd_event_click PARTITION(dt='20260319');
DESCRIBE FORMATTED msns.mvp_dwd_event_click PARTITION(dt='20260318');
```

重点对比 `content1` 列的 `numNulls` 和 `numDistinctValues`：
- 若 20260319 分区 `content1` 全为 null 或 distinct=1 → 优化器可能将其视为常量并触发折叠

---

## 总结：判断流程

```
开关对照（constant.propagation=false）
    ├── 成功 → 常量折叠是根因 → 永久修复：UDF 迁移到 GenericUDF
    └── 仍失败 → 与分区无关
              └── 检查 Tez 容器实际加载的 hive-exec 版本
                  └── javap GenericUDF → 是否 abstract
```
