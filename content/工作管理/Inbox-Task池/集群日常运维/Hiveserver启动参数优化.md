---
type: task
status: done
priority: P1
deadline: 2026-03-11
domain: 集群日常运维
lifecycle: routine
progress: "100"
completed_date: 2026-03-10
started_date: 2026-03-10
---

## 🎯 目标与验收标准
- [x] 修复Hiveserver GC日志无时间戳的问题。
- [x] 修复Hiveserver重启后原来的GC日志小时的问题。

## 📝 实施记录

原Hiveserver启动参数：
```bash
/usr/local/java/jdk1.8.0_351/bin/java -Dproc_jar -Djava.net.preferIPv4Stack=true -Djute.maxbuffer=10485760 -Xloggc:/var/log/hive/hiveserver2-gc.log -XX:+UseG1GC -XX:+PrintGCDetails -XX:+PrintGCTimeStamps -XX:+PrintGCCause -XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=256M -XX:+HeapDumpOnOutOfMemoryError -XX:OnOutOfMemoryError=/etc/killparent.sh -XX:ErrorFile=/var/log/hive/hs_err_%p.log -XX:HeapDumpPath=/tmp/hs2_heapdump_pid%p.hprof -Dhive.log.dir=/var/log/hive -Dhive.log.file=hiveserver2.log -Djute.maxbuffer=104857600 -Dzookeeper.sasl.client.username=zookeeper -Xmx4096m -Dproc_hiveserver2 -Dlog4j2.formatMsgNoLookups=true -Xmx40960m -Dlog4j.configurationFile=hive-log4j2.properties -Djava.util.logging.config.file=/etc/hive/conf/parquet-logging.properties -Dyarn.log.dir=/var/log/hadoop/hive -Dyarn.log.file=hadoop.log -Dyarn.home.dir=/usr/bigtop/3.2.0/usr/lib/hadoop-yarn -Dyarn.root.logger=INFO,console -Djava.library.path=:/usr/bigtop/3.2.0/usr/lib/hadoop/lib/native -Dhadoop.log.dir=/var/log/hadoop/hive -Dhadoop.log.file=hadoop.log -Dhadoop.home.dir=/usr/bigtop/3.2.0/usr/lib/hadoop -Dhadoop.id.str=hive -Dhadoop.root.logger=INFO,console -Dhadoop.policy.file=hadoop-policy.xml -Dhadoop.security.logger=INFO,NullAppender org.apache.hadoop.util.RunJar /usr/bigtop/current/hive-client/lib/hive-service-3.1.3.jar org.apache.hive.service.server.HiveServer2 --hiveconf hive.aux.jars.path=file:///usr/bigtop/current/hive-webhcat/share/hcatalog/hive-hcatalog-core-3.1.3.jar,file:///usr/bigtop/current/hive-client/auxlib/hudi-hadoop-mr-bundle-0.14.0.jar,file:///usr/bigtop/current/hive-client/auxlib/hudi-hive-sync-bundle-0.14.0.jar,file:///usr/bigtop/current/hive-client/auxlib/paimon-hive-connector-3.1-1.3.1.jar
```
对应Ambari启动脚本：
```bash

# The heap size of the jvm, and jvm args stared by hive shell script can be controlled via:
if [ "$SERVICE" = "metastore" ]; then

  export HADOOP_HEAPSIZE={{hive_metastore_heapsize}} # Setting for HiveMetastore
  export HADOOP_OPTS="$HADOOP_OPTS -Dcom.sun.management.jmxremote -Dcom.sun.management.jmxremote.port=9093 -Dcom.sun.management.jmxremote.ssl=false -Dcom.sun.management.jmxremote.authenticate=false -Xloggc:{{hive_log_dir}}/hivemetastore-gc-%t.log -XX:+UseG1GC -XX:+PrintGCDetails -XX:+PrintGCTimeStamps -XX:+PrintGCCause -XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=256M -XX:+HeapDumpOnOutOfMemoryError -XX:OnOutOfMemoryError=/etc/killparent.sh -XX:ErrorFile=/var/log/hive/hmeta_err_%p.log -XX:HeapDumpPath=/tmp/hms_heapdump_pid%p.hprof -Dhive.log.dir={{hive_log_dir}} -Dhive.log.file=hivemetastore.log -Djute.maxbuffer=104857600"

fi

if [ "$SERVICE" = "hiveserver2" ]; then

  export HADOOP_HEAPSIZE={{hive_heapsize}} # Setting for HiveServer2 and Client
  export HADOOP_OPTS="$HADOOP_OPTS -Xloggc:{{hive_log_dir}}/hiveserver2-gc.log -XX:+UseG1GC -XX:+PrintGCDetails -XX:+PrintGCTimeStamps -XX:+PrintGCCause -XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=256M -XX:+HeapDumpOnOutOfMemoryError -XX:OnOutOfMemoryError=/etc/killparent.sh -XX:ErrorFile=/var/log/hive/hs_err_%p.log -XX:HeapDumpPath=/tmp/hs2_heapdump_pid%p.hprof -Dhive.log.dir={{hive_log_dir}} -Dhive.log.file=hiveserver2.log -Djute.maxbuffer=104857600"

fi

{% if security_enabled %}
export HADOOP_OPTS="$HADOOP_OPTS -Dzookeeper.sasl.client.username={{zk_principal_user}}"
{% endif %}

export HADOOP_CLIENT_OPTS="$HADOOP_CLIENT_OPTS  -Xmx${HADOOP_HEAPSIZE}m"
export HADOOP_CLIENT_OPTS="$HADOOP_CLIENT_OPTS{{heap_dump_opts}}"

# Larger heap size may be required when running queries over large number of files or partitions.
# By default hive shell scripts use a heap size of 256 (MB).  Larger heap size would also be
# appropriate for hive server (hwi etc).


# Set HADOOP_HOME to point to a specific hadoop install directory
HADOOP_HOME=${HADOOP_HOME:-{{hadoop_home}}}

export HIVE_HOME=${HIVE_HOME:-{{hive_home}}}

# Hive Configuration Directory can be controlled by:
export HIVE_CONF_DIR=${HIVE_CONF_DIR:-{{hive_conf_dir}}}

# Folder containing extra libraries required for hive compilation/execution can be controlled by:
if [ "${HIVE_AUX_JARS_PATH}" != "" ]; then
  export HIVE_AUX_JARS_PATH=${HIVE_AUX_JARS_PATH}
elif [ -d "{{hive_hcatalog_home}}" ]; then
  export HIVE_AUX_JARS_PATH={{hive_hcatalog_home}}/share/hcatalog/hive-hcatalog-core-*.jar
else
  export HIVE_AUX_JARS_PATH={{hive_hcatalog_home}}/share/hcatalog/hcatalog-core.jar
fi
export METASTORE_PORT={{hive_metastore_port}}

{% if sqla_db_used or lib_dir_available %}
export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:{{jdbc_libs_dir}}"
export JAVA_LIBRARY_PATH="$JAVA_LIBRARY_PATH:{{jdbc_libs_dir}}"
{% endif %}
```

## ✅ 解决方案与优化建议

### 1. 修复 GC 日志时间戳
**修改点**：在 `HADOOP_OPTS` 中添加 `-XX:+PrintGCDateStamps`。
**原理**：
- `-XX:+PrintGCTimeStamps` 打印的是 JVM 启动后的相对秒数。
- `-XX:+PrintGCDateStamps` 会打印 ISO8601 格式的绝对日期时间戳。

### 2. 防止重启后日志覆盖
**修改点**：将 `-Xloggc:{{hive_log_dir}}/hiveserver2-gc.log` 修改为 `-Xloggc:{{hive_log_dir}}/hiveserver2-gc-%t.log`。
**原理**：
- `%t` 占位符会在启动时将当前时间戳注入文件名，确保每次重启生成的日志文件名唯一，不会覆盖旧日志。

### 优化后的 Ambari 脚本片段
```bash
if [ "$SERVICE" = "hiveserver2" ]; then

  export HADOOP_HEAPSIZE={{hive_heapsize}} 
  # 优化后的参数：引入 %t 和 PrintGCDateStamps
  export HADOOP_OPTS="$HADOOP_OPTS -Xloggc:{{hive_log_dir}}/hiveserver2-gc-%t.log -XX:+UseG1GC -XX:+PrintGCDetails -XX:+PrintGCDateStamps -XX:+PrintGCTimeStamps -XX:+PrintGCCause -XX:+UseGCLogFileRotation -XX:NumberOfGCLogFiles=10 -XX:GCLogFileSize=256M -XX:+HeapDumpOnOutOfMemoryError -XX:OnOutOfMemoryError=/etc/killparent.sh -XX:ErrorFile=/var/log/hive/hs_err_%p.log -XX:HeapDumpPath=/tmp/hs2_heapdump_pid%p.hprof -Dhive.log.dir={{hive_log_dir}} -Dhive.log.file=hiveserver2.log -Djute.maxbuffer=104857600"

fi
```
