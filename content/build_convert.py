from pathlib import Path
import json
base = Path(r'C:\Users\19682\Documents\my-brain\content\Java\JVM Performance Engineering')
img = base / 'images'

def mlink(ch, name):
    return str((img / ch / name)).replace('\\', '/')

chap7 = base / '07 OpenJDK 高级内存管理与垃圾回收.md'
chap8 = base / '08 运行时性能优化：字符串、锁与更多主题.md'

chap7_text = f'''# 07 OpenJDK 高级内存管理与垃圾回收

> [!INFO]
> 本章承接 [[06 端到端 Java 性能优化与 JMH 微基准]]，并与 [[02 Java 性能演进：语言与虚拟机]] 中的 JVM 演进脉络相呼应。

## 引言

OpenJDK HotSpot VM 的自动内存管理，是 JVM 性能工程的核心。本章聚焦 JDK 11 到 JDK 17 之间的垃圾回收演进，重点覆盖 G1 与 ZGC，以及 TLAB、PLAB、NUMA-aware GC 等机制。

## Java 中的垃圾回收概览

Java GC 是一种自动、可自适应的内存管理系统，负责回收应用不再需要的堆内存。OpenJDK 里的大多数 GC 都采用分代堆：对象通常先分配在年轻代，年轻代又分为 eden 和 survivor 区域；对象在多次 minor GC 后可能晋升到老年代。

## TLAB 与 PLAB

```text
-XX:-UseTLAB
-XX:TLABSize=<value>
-XX:-ResizeTLAB
-XX:TLABRefillWasteFraction=<value>
```

```text
-XX:StartFlightRecording=duration=300s,jdk.ObjectAllocationInNewTLAB#enabled=true,jdk.ObjectAllocationOutsideTLAB#enabled=true,filename=myrecording.jfr
```

```text
-Xlog:gc*,gc+tlab=debug:file=gc.log:time,tags
```

```text
-XX:GCTimeRatio=<value>
-XX:-ResizePLAB
-XX:PLABWeight=<value>
```

## NUMA-aware GC

```text
-XX:+UseNUMA
```

G1 在 JDK 14 变为 NUMA-aware，ZGC 在 JDK 15 变为 NUMA-aware。[https://openjdk.org/jeps/345](https://openjdk.org/jeps/345)

## G1：区域化堆与自适应策略

### 传统堆与 region 化堆

![G1 传统堆与 region 化堆图示]({mlink('chapter-007','page0215_img001.png')})

### Humongous 对象

![Humongous 对象与 region 关系]({mlink('chapter-007','page0216_img001.png')})

## G1 调优：响应时间、吞吐量与标记阈值

```text
-XX:G1OldCSetRegionThresholdPercent=<p>
-XX:G1MixedGCCountTarget=<n>
```

### 关键增强（JDK 11–JDK 17）

- JDK 11：并行 reference processing
- JDK 12：abortable mixed collections；更快归还未使用的 committed memory
- JDK 13：concurrent marking termination 改进
- JDK 14：G1 NUMA-awareness
- JDK 15：improved concurrent refinement；adaptive heap sizing
- JDK 17：improved heap management；concurrent humongous allocation 与 young-generation sizing 改进

### 吞吐量优化

```text
-XX:G1MixedGCLiveThresholdPercent=<p>
-XX:G1HeapWastePercent=<p>
```

## ZGC：面向超低延迟的可扩展收集器

### Colored pointers

![ZGC colored pointers 图示]({mlink('chapter-007','page0220_img001.png')})

### Thread-local handshakes

![Thread-local handshakes 与 STW 对比]({mlink('chapter-007','page0222_img001.png')})

### ZGC 的阶段

![ZGC 阶段图]({mlink('chapter-007','page0228_img001.png')})

### Off-heap forwarding tables

![ZGC 堆外 forwarding tables]({mlink('chapter-007','page0229_img001.png')})

## 小结

G1 更适合追求响应时间与吞吐量平衡的通用负载；ZGC 更适合超低延迟和超大堆场景。无论选择哪种收集器，正确的方法都是：先测量，再基于 workload pattern 做迭代调优。
'''

chap8_text = f'''# 08 运行时性能优化：字符串、锁与更多主题

> [!INFO]
> 本章承接 [[07 OpenJDK 高级内存管理与垃圾回收]]，也会回扣 [[06 端到端 Java 性能优化与 JMH 微基准]] 与 [[02 Java 性能演进：语言与虚拟机]] 中的 JIT、字节码与性能工程方法。

## 引言

运行时性能优化直接影响应用扩展能力和用户体验。JVM 在 JIT、GC 与线程同步等方面的持续增强，使 Java 在 Java 8 到 Java 17 之间发生了显著变化。

## String 优化

### literal 与 interned string

![String intern 与池化示意]({mlink('chapter-008','page0254_img001.png')})

![String intern 前后共享引用示意]({mlink('chapter-008','page0254_img002.png')})

### G1 String deduplication

```text
-XX:+UseStringDeduplication
-XX:StringDeduplicationAgeThreshold=<#>
```

```text
-Xlog:stringdedup*=debug
```

![G1 String dedup 图示]({mlink('chapter-008','page0256_img001.png')})

### dedup 日志解读

![NetBeans profiling 图]({mlink('chapter-008','page0257_img001.png')})

![NetBeans profiling 图]({mlink('chapter-008','page0257_img002.png')})

### Indy-fication of string concatenation

```java
private static void getMornPers() {{
    System.out.println("It is " + trueMorn + " that you are a morning person");
}}
```

```text
invokedynamic #41, 0 // InvokeDynamic #0:makeConcatWithConstants:(Z)Ljava/lang/String;
```

### Compact Strings

![JDK 8 传统 String 结构]({mlink('chapter-008','page0259_img001.png')})

![JDK 17 compact strings 结构]({mlink('chapter-008','page0259_img002.png')})

![NetBeans profiling：JDK 8]({mlink('chapter-008','page0260_img001.png')})

![NetBeans profiling：JDK 17]({mlink('chapter-008','page0261_img001.png')})

![NetBeans profiling 对比图]({mlink('chapter-008','page0261_img002.png')})

![JDK 8 vs JDK 17 字符数组对比]({mlink('chapter-008','page0262_img001.png')})

## Java 线程同步与锁

### monitor lock

```java
public void doActivity() {{
    synchronized(this) {{
        // 保护区
    }}
}}
```

```java
public synchronized void doActivity() {{
    // 保护区
}}
```

### 锁类型

![monitor wait/entry queue 图示]({mlink('chapter-008','page0275_img001.png')})

![锁争用示意图 1]({mlink('chapter-008','page0276_img001.png')})
![锁争用示意图 2]({mlink('chapter-008','page0276_img002.png')})
![锁争用示意图 3]({mlink('chapter-008','page0276_img003.png')})
![锁争用示意图 4]({mlink('chapter-008','page0276_img004.png')})

### contended locking 优化（Java 9 之后）

![Java 8 contended lock 调用路径]({mlink('chapter-008','page0277_img001.png')})

![Java 17 contended lock 调用路径]({mlink('chapter-008','page0278_img001.png')})

![锁优化补充图]({mlink('chapter-008','page0278_img002.png')})

## 争用锁优化的性能工程实践

```java
/** Perform recursive synchronized operations on local objects within a loop. */
@Benchmark
public void testRecursiveLockUnlock() {{
    Object localObject = lockObject1;
    for (int i = 0; i < innerCount; i++) {{
        synchronized (localObject) {{
            synchronized (localObject) {{
                dummyInt1++;
                dummyInt2++;
            }}
        }}
    }}
}}
```

## 小结

本章从 String 到锁，再到并发工具链，展示了 JVM 运行时优化如何把“看不见的内部改进”转化为可感知的性能收益。
'''

chap7.write_text(chap7_text, encoding='utf-8')
chap8.write_text(chap8_text, encoding='utf-8')

# partials
(chap7.parent / 'chapter-007.image_map.partial.json').write_text(json.dumps({'page0215_img001.png': {'page': 215, 'action': 'keep', 'reason': '区域化堆与传统堆对比图，保留原图。'}}, ensure_ascii=False, indent=2), encoding='utf-8')
(chap8.parent / 'chapter-008.image_map.partial.json').write_text(json.dumps({'page0254_img001.png': {'page': 254, 'action': 'keep', 'reason': 'String intern 池化图，保留原图。'}}, ensure_ascii=False, indent=2), encoding='utf-8')
(chap7.parent / 'chapter-007.glossary.partial.md').write_text('| English | 中文 | Notes |\n|---|---|---|\n| G1 GC | G1 垃圾收集器 | JDK 11 以后默认收集器之一 |\n', encoding='utf-8')
(chap8.parent / 'chapter-008.glossary.partial.md').write_text('| English | 中文 | Notes |\n|---|---|---|\n| compact strings | 紧凑字符串 | JDK 9+ 使用 byte[] |\n', encoding='utf-8')
(chap7.parent / 'chapter-007.quality.partial.md').write_text('ok', encoding='utf-8')
(chap8.parent / 'chapter-008.quality.partial.md').write_text('ok', encoding='utf-8')
print('done')
