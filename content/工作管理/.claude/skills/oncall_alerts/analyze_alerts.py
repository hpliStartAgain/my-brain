#!/usr/bin/env python3
import json
import sys
from collections import defaultdict
from datetime import datetime

# 读取JSON数据
with open(sys.argv[1], 'r') as f:
    data = json.load(f)

alerts = data['alerts']

# 服务分类关键词
CATEGORIES = {
    '大数据': ['hadoop', 'hdfs', 'yarn', 'namenode', 'resourcemanager', 'datanode', 'nodemanager',
              'appspending', 'appsrunning', '队列', 'hive', 'spark', 'flink', 'mapreduce', 'presto',
              'trino', 'coordinator', 'hbase', 'dfs', 'block', '副本', 'reconstruct',
              'ecfailedreconstructiontasks', 'rss', 'uniffle'],
    '中间件': ['elasticsearch', 'es', 'elk', 'shard', 'index', '索引', '分片', 'qps', 'kafka',
              'topic', 'isr', 'broker', 'partition', '消费', '积压', 'doris', 'clickhouse',
              'sentry', 'zookeeper', 'zk', '集群', '节点'],
    '基础设施': ['node', 'vmstat', 'hostoomkilldetected', 'hostmemoryundermemorypressure', 'cpu',
                'load', 'iowait', 'disk', 'overloaded', '内存', 'mem', 'memory', 'oom', 'kswapd',
                'network', 'netstat', 'tcp', '网卡', '丢包', 'drop', 'connections', 'wait',
                'domeos', 'dmo', '容器', 'docker', 'cvm', 'instance', 'ceph', 'openstack',
                'cmdb', '部署', 'exporter', 'zabbix agent', 'categraf丢失心跳']
}

MANUAL_KEYWORDS = ['fan', '风扇', 'disk', '磁盘', '硬盘', '坏盘', 'failed_volumes', 'storage',
                   '内存条', 'power', '电源', 'ipmi', 'smart', 'physical drive', 'logical drive',
                   'controller', 'hardware', '硬件', 'battery', 'readonly', '只读', 'dead', 'down',
                   '进程', 'process', '挂掉', 'heartbeat', '心跳', 'unreachable', '丢失', 'lost',
                   'offline', 'namenode', 'datanode', 'regionserver', 'hiveserver', 'metastore',
                   'nodemanager', 'resourcemanager', 'corrupt', '损坏', 'data loss', '数据丢失',
                   'bad_local_dirs', 'port', '端口']

DISK_KEYWORDS = ['smart', 'failed_volumes', 'datanode_num_failed', 'physical drive', 'ata error',
                 'disk temperature', 'bad_local_dirs', 'unmounted_data_dir', 'failed storage', '坏盘']

TIDE_KEYWORDS = ['nodemanager_process_down', 'nodemanager_health', 'datanode_health', 'agent_heartbeat']

# 已知问题忽略列表（主机+告警标题）
KNOWN_ISSUES = [
    ('10.18.15.18', 'node_filesystem_readonly'),  # 专门设置为只读的文件系统
]

def should_ignore(alert):
    """检查是否为已知问题需要忽略"""
    host = alert.get('host', '')
    title = alert.get('title', '').lower()
    return any(host == known_host and known_title in title for known_host, known_title in KNOWN_ISSUES)

def categorize(title, service, host):
    text = f"{title} {service} {host}".lower()
    for cat, keywords in CATEGORIES.items():
        if any(kw in text for kw in keywords):
            return cat
    return '其他'

def needs_manual(title):
    return any(kw in title.lower() for kw in MANUAL_KEYWORDS)

def is_disk_issue(title):
    return any(kw in title.lower() for kw in DISK_KEYWORDS)

def is_tide_related(title):
    return any(kw in title.lower() for kw in TIDE_KEYWORDS)

def map_severity(alert):
    source = alert['source']
    if source == 'zabbix':
        sev = alert.get('severity', 0)
        if sev == 5: return ('🔴', 'Critical', 5)
        if sev == 4: return ('🟠', 'High', 4)
        if sev == 3: return ('🟡', 'Average', 3)
        if sev == 2: return ('🟡', 'Warning', 2)
        if sev == 1: return ('🔵', 'Info', 1)
        return ('⚪', 'Unknown', 0)
    elif source == 'foxeye':
        sev = alert.get('severity', 3)
        if sev == 1: return ('🔴', 'Critical', 5)
        if sev == 2: return ('🟠', 'High', 4)
        if sev == 3: return ('🟡', 'Average', 3)
        return ('🟡', 'Warning', 2)
    elif source == 'ambari':
        state = alert.get('state', 'WARNING')
        if state == 'CRITICAL': return ('🔴', 'Critical', 5)
        return ('🟡', 'Warning', 2)
    return ('⚪', 'Unknown', 0)

# 去重并分类
fingerprints = {}
for alert in alerts:
    fp = f"{alert['host']}|{alert['title']}|{alert['source']}"
    if fp not in fingerprints or alert.get('trigger_time_unix', 0) > fingerprints[fp].get('trigger_time_unix', 0):
        fingerprints[fp] = alert

unique_alerts = [a for a in fingerprints.values() if not should_ignore(a)]

# 统计
total = len(unique_alerts)
high_priority = sum(1 for a in unique_alerts if map_severity(a)[2] >= 4)
mid_priority = sum(1 for a in unique_alerts if 2 <= map_severity(a)[2] < 4)
low_priority = sum(1 for a in unique_alerts if map_severity(a)[2] < 2)

print(f"## 📊 告警概览\n")
print(f"- **总计**: {total}")
print(f"- **高优先级** (Critical+High): {high_priority}")
print(f"- **中优先级** (Average+Warning): {mid_priority}")
print(f"- **低优先级** (Info): {low_priority}\n")

# 分组
manual_alerts = []
disk_alerts = []
tide_alerts = []
ambari_alerts = []
auto_heal = []

for alert in unique_alerts:
    title = alert['title']
    source = alert['source']

    if source == 'ambari':
        ambari_alerts.append(alert)
    elif is_disk_issue(title) or is_tide_related(title):
        if is_disk_issue(title):
            disk_alerts.append(alert)
        else:
            tide_alerts.append(alert)
    elif needs_manual(title):
        manual_alerts.append(alert)
    else:
        auto_heal.append(alert)

# 聚合函数
def aggregate_alerts(alert_list):
    groups = defaultdict(lambda: {'hosts': set(), 'latest_time': '', 'severity': 0, 'category': '', 'source': ''})
    for alert in alert_list:
        key = alert['title']
        groups[key]['hosts'].add(alert['host'])
        groups[key]['source'] = alert['source']
        groups[key]['category'] = categorize(alert['title'], alert.get('service', ''), alert['host'])
        sev_info = map_severity(alert)
        groups[key]['severity'] = max(groups[key]['severity'], sev_info[2])
        groups[key]['emoji'] = sev_info[0]
        groups[key]['sev_name'] = sev_info[1]
        time_str = alert.get('trigger_time', '')
        if time_str > groups[key]['latest_time']:
            groups[key]['latest_time'] = time_str

    result = []
    for title, info in groups.items():
        result.append({
            'title': title,
            'hosts': list(info['hosts']),
            'host_count': len(info['hosts']),
            'latest_time': info['latest_time'],
            'severity': info['severity'],
            'emoji': info['emoji'],
            'sev_name': info['sev_name'],
            'category': info['category'],
            'source': info['source']
        })
    return sorted(result, key=lambda x: (-x['severity'], -x['host_count']))

print(f"## 🔧 需重点关注 ({len(manual_alerts)}条)\n")
if manual_alerts:
    agg = aggregate_alerts(manual_alerts)
    print("| 级别 | 告警源 | 类别 | 告警名称 | 影响主机数 | 示例主机 | 最新时间 |")
    print("|------|--------|------|----------|-----------|---------|---------|")
    for item in agg[:30]:  # 只显示前30条
        hosts_preview = item['hosts'][0] if item['hosts'] else ''
        print(f"| {item['emoji']} {item['sev_name']} | {item['source']} | {item['category']} | {item['title'][:50]} | {item['host_count']} | {hosts_preview[:30]} | {item['latest_time']} |")
    if len(agg) > 30:
        print(f"\n*（还有 {len(agg)-30} 条告警未显示）*\n")
else:
    print("*无*\n")

print(f"\n## ⏸️ 暂时无法处理 ({len(disk_alerts) + len(tide_alerts)}条)\n")
if disk_alerts or tide_alerts:
    combined = disk_alerts + tide_alerts
    agg = aggregate_alerts(combined)
    print("| 级别 | 告警源 | 类别 | 告警名称 | 影响主机数 | 原因 |")
    print("|------|--------|------|----------|-----------|------|")
    for item in agg[:20]:
        reason = "坏盘无备件" if any(kw in item['title'].lower() for kw in DISK_KEYWORDS) else "潮汐弹性"
        print(f"| {item['emoji']} {item['sev_name']} | {item['source']} | {item['category']} | {item['title'][:50]} | {item['host_count']} | {reason} |")
else:
    print("*无*\n")

print(f"\n## 🏔️ Ambari 告警 ({len(ambari_alerts)}条)\n")
print("*多为潮汐弹性导致，按需关注*\n")

print(f"\n## ⏳ 抖动告警 ({len(auto_heal)}条)\n")
if auto_heal:
    agg = aggregate_alerts(auto_heal)
    print("| 级别 | 告警源 | 类别 | 告警名称 | 影响主机数 |")
    print("|------|--------|------|----------|-----------|")
    for item in agg[:20]:
        print(f"| {item['emoji']} {item['sev_name']} | {item['source']} | {item['category']} | {item['title'][:50]} | {item['host_count']} |")
else:
    print("*无*\n")
