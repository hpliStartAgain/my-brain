# Confluence 告警迁移页面 HTML 源文件

> 本目录存放所有已推送到 Confluence 的告警迁移分析页面 HTML 源文件。
> 更新流程：修改此处 HTML → `opencli confluence update --id {pageId} --content "$(cat xxx.html)" --title "XXX 告警规则迁移明细"`

## 文件 → Confluence pageId 映射

| 文件名 | Confluence pageId | 标题 | 最后推送版本 |
|---|---|---|---|
| `progress_summary.html` | 107717201 | 迁移进度概要 | v3 |
| `hdfs.html` | 107718652 | HDFS 告警规则迁移明细 | v3 |
| `yarn.html` | 107718655 | YARN 告警规则迁移明细 | v2 |
| `infra_basic.html` | 107718658 | infra_basic 告警规则迁移明细 | v5 |
| `elasticsearch.html` | 107718659 | Elasticsearch 告警规则迁移明细 | v2 |
| `hbase.html` | 107718660 | HBase 告警规则迁移明细 | v2 |
| `hive.html` | 107718661 | Hive 告警规则迁移明细 | v2+ |
| `kafka.html` | 107718662 | Kafka 告警规则迁移明细 | v2 |
| `zookeeper.html` | 107718663 | ZooKeeper 告警规则迁移明细 | v2 |
| `druid.html` | 107718664 | Druid 告警规则迁移明细 | v2 |
| `misc.html` | 107718665 | misc 告警规则迁移明细 | v2 |
| `java_jvm.html` | 107718666 | java_jvm 告警规则迁移明细 | v3 |
| `ambari.html` | 107718667 | Ambari 告警规则迁移明细 | v3 |
| `kyuubi.html` | 107718668 | Kyuubi 告警规则迁移明细 | v2 |
| `ranger.html` | 107718669 | Ranger 告警规则迁移明细 | v2 |
| `trino.html` | 107718670 | Trino 告警规则迁移明细 | v2 |
| `flume.html` | 107718671 | Flume 告警规则迁移明细 | v3+ |

## 快速更新命令示例

```bash
# 更新 Kafka 页面
opencli confluence update --id 107718662 \
  --title "Kafka 告警规则迁移明细" \
  --content "$(cat kafka.html)"

# 更新进度概要
opencli confluence update --id 107717201 \
  --title "迁移进度概要" \
  --content "$(cat progress_summary.html)"
```

## 父页面
- spaceKey: `research`
- 父页面 pageId: `107715652`
- URL: https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=107715652
