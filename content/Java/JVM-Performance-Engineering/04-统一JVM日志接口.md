---
title: "统一JVM日志接口"
date: 2026-05-12
tags: [Java, JVM, 性能工程, 日志]
aliases: [The Unified Java Virtual Machine Logging Interface]
---

# 第4章 统一JVM日志接口

GC 自适应性：`-XX:+PrintAdaptiveSizePolicy`

---

GC 特定选项（例如，针对 Garbage First [G1] GC）：`-XX:+G1PrintHeapRegions`

---

编译级别：`-XX:+PrintCompilation`

---

内联信息：`-XX:+PrintInlining`

---

汇编代码：`-XX:+PrintAssembly`（需要 `-XX:+UnlockDiagnosticVMOptions`）

---

类直方图：`-XX:+PrintClassHistogram`

---

关于 `java.util.concurrent` 锁的信息：`-XX:+PrintConcurrentLocks`

记住每个选项并判断信息属于 info、debug 还是 trace 级别颇具挑战性。因此，JDK 9 引入了 JDK 增强提案（JEP）158：统一 JVM 日志（Unified JVM Logging）[^1]。随后是 JEP 271：统一 GC 日志（Unified GC Logging）[^2]，它为 GC 活动提供了全面的日志框架。

## 统一化与基础设施

Java HotSpot VM 提供了一个统一的日志接口，为 JVM 的所有日志信息提供了统一的视觉风格和操作方法。所有日志消息都使用标签（tags）进行分类。这使得你可以根据需要请求适当详细程度的信息，从"错误"和"警告"日志到"信息"、"跟踪"和"调试"级别。

要启用 JVM 日志，你需要提供 `-Xlog` 选项。默认情况下（即未指定 `-Xlog` 时），仅警告和错误会记录到 stderr。因此，默认配置如下所示：

```
-Xlog:all=warning:stderr:uptime,level,tags
```

这里我们看到 `all`，它只是所有标签的别名。

统一日志系统是一个包罗万象的系统，为所有 JVM 日志提供了一致的接口。它围绕四个主要组件构建：

- **标签（Tags）**：用于对日志消息进行分类，每条消息被分配一个或多个标签。标签使得过滤和查找特定日志消息更加容易。一些预定义的标签包括 `gc`、`compiler` 和 `threads`。
- **级别（Levels）**：定义日志消息的严重性或重要程度。共有六个可用级别：`debug`、`error`、`info`、`off`、`trace` 和 `warning`。
- **装饰器（Decorators）**：为日志消息提供额外的上下文，例如时间戳、进程 ID 等。
- **输出（Outputs）**：日志消息写往的目的地，例如 stdout、stderr 或文件。

[^1]: https://openjdk.org/jeps/158
[^2]: https://openjdk.org/jeps/271

### 统一日志系统中的标签

**性能指标**

在 JVM 性能工程背景下，统一日志系统为各种性能指标提供了宝贵的洞察。这些指标包括 GC 活动、即时编译（JIT）事件以及系统资源使用情况等。通过监控这些指标，开发人员可以识别潜在的性能问题，并采取必要措施来优化其 Java 应用程序的性能。

### 统一日志系统中的标签

在统一日志系统中，标签对于区分和识别不同类型的日志消息至关重要。每个标签对应特定的系统区域或特定类型的操作。通过启用特定的标签，用户可以定制日志输出，专注于感兴趣的领域。

**日志标签**

统一日志系统提供了大量标签来捕获细粒度的信息。诸如用于垃圾收集的 `gc`、用于线程操作的 `thread`、用于类加载的 `class`、用于 CPU 相关事件的 `cpu`、用于操作系统交互的 `os` 等标签，以及如下列出的更多标签：

`add`, `age`, `alloc`, `annotation`, `arguments`, `attach`, `barrier`, `biasedlocking`, `blocks`, `bot`, `breakpoint`, `bytecode`, `cds`, `census`, `class`, `classhisto`, `cleanup`, `codecache`, `compaction`, `compilation`, `condy`, `constantpool`, `constraints`, `container`, `coops`, `cpu`, `cset`, `data`, `datacreation`, `dcmd`, `decoder`, `defaultmethods`, `director`, `dump`, `dynamic`, `ergo`, `event`, `exceptions`, `exit`, `fingerprint`, `free`, `freelist`, `gc`, `handshake`, `hashtables`, `heap`, `humongous`, `ihop`, `iklass`, `indy`, `init`, `inlining`, `install`, `interpreter`, `itables`, `jfr`, `jit`, `jni`, `jvmci`, `jvmti`, `lambda`, `library`, `liveness`, `load`, `loader`, `logging`, `malloc`, `map`, `mark`, `marking`, `membername`, `memops`, `metadata`, `metaspace`, `methodcomparator`, `methodhandles`, `mirror`, `mmu`, `module`, `monitorinflation`, `monitormismatch`, `nestmates`, `nmethod`, `nmt`, `normalize`, `numa`, `objecttagging`, `obsolete`, `oldobject`, `oom`, `oopmap`, `oops`, `oopstorage`, `os`, `owner`, `pagesize`, `parser`, `patch`, `path`, `perf`, `periodic`, `phases`, `plab`, `placeholders`, `preorder`, `preview`, `promotion`, `protectiondomain`, `ptrqueue`, `purge`, `record`, `redefine`, `ref`, `refine`, `region`, `reloc`, `remset`, `resolve`, `safepoint`, `sampling`, `scavenge`, `sealed`, `setting`, `smr`, `stackbarrier`, `stackmap`, `stacktrace`, `stackwalk`, `start`, `startup`, `startuptime`, `state`, `stats`, `streaming`, `stringdedup`, `stringtable`, `subclass`, `survivor`, `suspend`, `sweep`, `symboltable`, `system`, `table`, `task`, `thread`, `throttle`, `time`, `timer`, `tlab`, `tracking`, `unload`, `unshareable`, `update`, `valuebasedclasses`, `verification`, `verify`, `vmmutex`, `vmoperation`, `vmthread`, `vtables`, `vtablestubs`, `workgang`

指定 `all` 而不是某个标签组合，会匹配所有标签组合。

如果你希望运行应用程序时输出所有日志消息，可以使用 `-Xlog` 执行程序，这等同于 `-Xlog:all`。此选项会将所有消息记录到 stdout，级别设为 info，而警告和错误则输出到 stderr。

**特定标签**

默认情况下，使用 `-Xlog` 但不指定特定标签运行应用程序，会产生来自系统各个部分的大量日志消息。如果你希望专注于特定领域，可以通过指定标签来实现。

例如，如果你对与垃圾收集、堆和压缩 oops 相关的日志消息感兴趣，可以指定 `gc` 标签。在 JDK 17 中使用 `-Xlog:gc*` 选项运行应用程序，会输出与垃圾收集相关的日志消息：

```bash
$ java -Xlog:gc* LockLoops
[0.006s][info][gc] Using G1
[0.007s][info][gc,init] Version: 17.0.8+9-LTS-211 (release)
[0.007s][info][gc,init] CPUs: 16 total, 16 available
…
[0.057s][info][gc,metaspace] Compressed class space mapped at: 0x0000000132000000
-0x0000000172000000, reserved size: 1073741824
[0.057s][info][gc,metaspace] Narrow klass base: 0x0000000131000000, Narrow klass shift: 0, Narrow
klass range: 0x100000000
```

类似地，如果你的应用程序涉及大量多线程操作，你可能对 `thread` 标签感兴趣。使用 `-Xlog:thread*` 选项运行应用程序，会输出与线程操作相关的日志消息：

```bash
$ java -Xlog:thread* LockLoops
[0.019s][info][os,thread] Thread attached (tid: 7427, pthread id: 123145528827904).
[0.030s][info][os,thread] Thread "GC Thread#0" started (pthread id: 123145529888768, attributes:
stacksize: 1024k, guardsize: 4k, detached).
…
```

**识别缺失的信息**

在某些情况下，启用某个标签并不会产生预期的日志消息。例如，使用 `-Xlog:monitorinflation*` 运行应用程序可能只会产生很少的输出，如下所示：

```
…
[11.301s][info][monitorinflation] deflated 1 monitors in 0.0000023 secs
[11.301s][info][monitorinflation] end deflating: in_use_list stats: ceiling=11264, count=2, max=3
…
```

在这种情况下，你可能需要调整日志级别——这是我们在下一节将要探讨的主题。

## 深入理解级别、输出与装饰器

让我们更仔细地看看可用的日志级别，研究装饰器的使用，并讨论重定向输出的方法。

### 级别

JVM 的统一日志系统提供了多种日志级别，每种级别对应不同的详细程度。要了解这些级别，可以使用 `-Xlog:help` 命令，该命令提供了所有可用选项的信息：

```
Available log levels:
off, trace, debug, info, warning, error
```

其中：

- **off**：禁用日志。
- **error**：JVM 内的关键问题。
- **warning**：可能需要注意的潜在问题。
- **info**：关于 JVM 操作的一般信息。
- **debug**：对调试有用的详细信息。此级别提供对 JVM 行为的深入洞察，通常用于排查特定问题时。
- **trace**：最冗长的级别，提供极其详细的日志。trace 级别通常用于获取最细粒度的 JVM 操作洞察，尤其是需要事件逐步详细记录时。

正如我们之前的示例所示，如果未为某个标签指定特定的日志级别，默认日志级别为 `info`。当我们运行测试时，发现使用默认的 `info` 日志级别时，`monitorinflation` 标签的信息非常少。我们可以将日志级别显式设置为 `trace` 来获取更多信息，如下所示：

```bash
$ java -Xlog:monitorinflation*=trace LockLoops
```

输出的日志现在包含关于各种锁的详细信息，如以下日志摘录所示：

```
…
[3.073s][trace][monitorinflation
] Checking in_use_list:
[3.073s][trace][monitorinflation
] count=3, max=3
[3.073s][trace][monitorinflation
] in_use_count=3 equals ck_in_use_count=3
[3.073s][trace][monitorinflation
] in_use_max=3 equals ck_in_use_max=3
[3.073s][trace][monitorinflation
] No errors found in in_use_list checks.
[3.073s][trace][monitorinflation
] In-use monitor info:
[3.073s][trace][monitorinflation
] (B -> is_busy, H -> has hash code, L -> lock status)
[3.073s][trace][monitorinflation
]
monitor
BHL object                          object type
[3.073s][trace][monitorinflation
] ================================= ====================== =================
[3.073s][trace][monitorinflation
] 0x00006000020ec680 100 0x000000070fe190e0 java.
lang.ref.ReferenceQueue$Lock (is_busy: waiters=1, contentions=0owner=0x0000000000000000,
cxq=0x0000000000000000, EntryList=0x0000000000000000)
…
```

在统一日志系统中，日志级别是分层的。因此，将日志级别设置为 `trace` 也会包含所有更低级别（`debug`、`info`、`warning`、`error`）的消息。这确保了全面的日志输出，捕获了广泛的详细信息，正如在日志后续部分所见：

```
…
[11.046s][trace][monitorinflation] deflate_monitor: object=0x000000070fe70a58,
mark=0x00006000020e00d2, type='java.lang.Object'
[11.046s][debug][monitorinflation] deflated 1 monitors in 0.0000157 secs
[11.046s][debug][monitorinflation] end deflating: in_use_list stats: ceiling=11264, count=2,
max=3
[11.046s][debug][monitorinflation] begin deflating: in_use_list stats: ceiling=11264,
count=2, max=3
[11.046s][debug][monitorinflation] deflated 0 monitors in 0.0000004 secs
…
```

这种分层日志是 JVM 日志系统的一个关键特性，允许根据你的需求进行灵活和详细的监控。

### 装饰器

装饰器是 JVM 日志的另一个关键方面。装饰器为日志消息提供额外的上下文，使其信息更加丰富。在命令行上指定 `-Xlog:help` 会显示以下装饰器：

```
…
Available log decorators:
time (t), utctime (utc), uptime (u), timemillis (tm), uptimemillis (um), timenanos (tn),
uptimenanos (un), hostname (hn), pid (p), tid (ti), level (l), tags (tg)
Decorators can also be specified as 'none' for no decoration.
…
```

这些装饰器为日志提供特定信息。默认选择了 `uptime`、`level` 和 `tags`，这就是为什么我们在之前的示例的日志输出中看到了这三个装饰器。然而，有时你可能希望使用不同的装饰器，例如：

- **pid (p)**：进程 ID。用于区分来自不同 JVM 实例的日志。
- **tid (ti)**：线程 ID。对于追踪特定线程的操作至关重要，有助于调试并发问题或特定线程的行为。
- **uptimemillis (um)**：以毫秒为单位的 JVM 运行时间。有助于将事件与应用程序运行的时间线关联起来，特别是在性能监控中。

以下是我们如何添加这些装饰器的方法：

```bash
$ java -Xlog:gc*::uptimemillis,pid,tid LockLoops
[0.006s][32262][8707] Using G1
[0.008s][32262][8707] Version: 17.0.8+9-LTS-211 (release)
[0.008s][32262][8707] CPUs: 16 total, 16 available [0.023s][32033][9987] Memory: 16384M
…
[0.057s][32262][8707] Compressed class space mapped at: 0x000000012a000000-0x000000016a000000,
reserved size: 1073741824
[0.057s][32262][8707] Narrow klass base: 0x0000000129000000, Narrow klass shift: 0, Narrow klass
range: 0x100000000
```

像 `pid` 和 `tid` 这样的装饰器在调试中尤其有价值。当多个 JVM 在运行时，`pid` 有助于识别哪个 JVM 实例生成了日志。`tid` 在多线程应用程序中对于跟踪单个线程的行为至关重要，这在诊断死锁或竞态条件等问题时非常重要。

使用 `uptime` 或 `uptimemillis` 作为事件的时间参考，能够建立清晰的操作时间线。`uptimemillis` 在性能分析中至关重要，用于了解特定事件相对于应用程序启动时间发生的时刻。类似地，`hostname` 在分布式系统中对于识别日志条目的来源机器非常有价值。

装饰器通过以下几种方式增强了日志的可读性和分析能力：

- **上下文清晰度**：通过提供时间戳、进程 ID 和线程 ID 等额外细节，装饰器使日志自包含且更易理解。
- **过滤与搜索**：借助相关装饰器，可以更有效地过滤日志数据，从而更快地隔离问题。
- **关联与因果分析**：装饰器允许将系统不同部分的事件关联起来，有助于根因分析和系统级的性能优化。

总之，统一日志系统中的装饰器在增强 JVM 日志的调试和性能监控能力方面发挥着关键作用。它们为日志数据添加了必要的上下文和清晰度，使其对开发人员更具可操作性和洞察力。

### 输出

在 JVM 日志中，输出决定了日志信息的流向。JVM 在控制日志输出方面提供了灵活性，允许用户将输出重定向到 stdout、stderr 或特定文件。默认行为是将所有警告和错误路由到 stderr，而所有 `info`、`debug` 和 `trace` 级别则定向到 stdout。但是，用户可以根据需要调整此行为。例如，用户可以指定一个特定文件来写入日志数据，这在以后需要分析日志或 stdout/stderr 不便于记录日志数据时非常有用。

可以将文件名作为参数传递给 `-Xlog` 命令，以将日志输出重定向到该文件。例如，假设你想记录垃圾收集（gc）活动，级别为 `info`，并希望将这些日志写入 `gclog.txt` 文件。以下是对 `gc*` 标签设置级别为 `info` 的示例：

```bash
$ java -Xlog:gc*=info:file=gclog.txt LockLoops
```

在此示例中，所有关于垃圾收集过程的 `info` 级别日志信息都将写入 `gclog.txt` 文件。同样的操作适用于任何标签或日志级别，为系统管理员和开发人员提供了极大的灵活性。

你甚至可以将不同的日志级别定向到不同的输出，如下例所示：

```bash
$ java -Xlog:monitorinflation*=trace:file=lockinflation.txt -Xlog:gc*=info:file=gclog.txt
LockLoops
```

在这种情况下，垃圾收集过程的 `info` 级别日志写入 `gclog.txt`，而 `monitorinflation` 的 `trace` 级别日志则定向到 `lockinflation.txt`。这提供了一种精细化的日志数据管理方法，允许根据日志的详细级别进行分类，这在故障排查时极为有用。

> **注意**：将日志定向到文件而不是 stdout/stderr 可能会对性能产生影响，尤其是在 I/O 密集型应用中。写入文件可能更慢，并可能影响应用程序性能。为减轻此风险，异步日志是一种有效的解决方案。我们在本章稍后会深入探讨异步日志。

理解并有效管理 JVM 日志的输出，可以帮助你充分利用日志系统的灵活性和强大功能。此外，由于 JVM 不会自动处理日志轮转，管理大型日志文件对于长时间运行的应用程序至关重要。如果没有适当的日志管理，日志文件可能会显著增长，消耗磁盘空间并可能影响系统性能。通过外部工具或自定义脚本实现日志轮转，有助于控制日志文件大小并防止潜在问题。有效的日志输出管理不仅使应用程序的调试和监控任务更加可控，还能确保日志实践与应用程序的性能和维护需求保持一致。

## 统一日志系统的实用示例

为了展示统一日志系统的多功能性，让我们从理解如何配置它开始。全面掌握该系统对于 Java 开发人员至关重要，尤其是在高效的调试和性能优化方面。作为该系统的核心组件，`-Xlog` 选项提供了极大的灵活性，可以根据特定需求定制日志记录。让我们通过各种场景来探索其用法：

- **使用 `-Xlog` 选项配置日志系统**：`-Xlog` 选项是一个强大的工具，用于配置日志系统。其灵活的语法 `-Xlog:tags:output:decorators:level` 允许你自定义记录什么内容、记录到哪里以及如何呈现。

- **为特定标签启用日志**：如果你想为 `gc` 和 `compiler` 标签启用 `info` 级别的日志，可以使用以下命令：
  ```bash
  $ java -Xlog:gc,compiler:info MyApp
  ```

- **为不同标签指定不同的级别**：也可以为不同的标签指定不同的级别。例如，如果你希望 `gc` 日志为 `info` 级别，但 `compiler` 日志为 `warning` 级别，可以使用以下命令：
  ```bash
  $ java -Xlog:gc=info,compiler=warning MyApp
  ```

- **记录到不同的输出**：默认情况下，日志写入 stdout。但是，你可以指定不同的输出，例如文件。例如：
  ```bash
  $ java -Xlog:gc:file=gc.log MyApp
  ```
  这将把所有 `gc` 日志写入 `gc.log` 文件。

- **使用装饰器包含额外信息**：你可以使用装饰器在日志消息中包含更多上下文。例如，要为 `gc` 日志包含时间戳，可以使用以下命令：
  ```bash
  $ java -Xlog:gc*:file=gc.log:time MyApp
  ```
  这将把 `gc` 日志写入 `gc.log`，每条日志消息前都会加上时间戳。

- **启用所有日志**：为了进行全面日志记录，这对调试或详细分析特别有用，你可以使用以下命令启用所有级别的所有日志消息：
  ```bash
  $ java -Xlog:all=trace MyApp
  ```
  此命令确保从 JVM 捕获每一条可能的日志消息，从 `trace` 到 `error` 级别。虽然这提供了 JVM 操作的完整画面，但可能会产生大量的日志数据，因此应谨慎使用。

- **禁用日志**：如果你想关闭日志，可以使用以下命令：
  ```bash
  $ java -Xlog:off MyApp
  ```

### 基准测试与性能测试

统一日志系统在基准测试和性能测试场景中至关重要。通过全面分析日志，开发人员可以了解他们的应用程序在不同工作负载和配置下的表现。这些信息可用于微调应用程序以获得最佳性能。

例如，垃圾收集日志可以提供应用程序内存使用模式的洞察，这有助于指导调整堆大小和微调其他 GC 参数以提高效率的决策。此外，其他类型的日志，如 JIT 编译日志、线程活动日志或前面讨论过的 `monitorinflation` 日志，也能提供有价值的信息。JIT 编译日志可以帮助识别性能关键方法[^3]，而线程和 `monitorinflation` 日志可用于诊断并发问题或线程利用效率低下的情况。

除了在性能测试期间使用这些日志外，将它们集成到回归测试框架中也至关重要。这可以确保新的更改或更新不会对应用程序性能产生不利影响。通过这种方式，持续集成流水线可以显著简化在持续交付环境中识别和解决性能瓶颈的过程。

然而，需要注意的是，解读这些日志通常需要对 JVM 行为有细致入微的理解。例如，GC 日志可能很复杂，需要深入理解 Java 中的内存管理。同样，解读 JIT 编译日志需要了解 JVM 如何优化代码执行。将日志分析与其他性能测试方法相平衡，可以确保对应用程序性能进行全面评估。

[^3]: 我们在第 1 章"Java 的性能演进：语言与虚拟机"中讨论了性能关键方法。

### 工具与技术

分析 JVM 日志可能是一项复杂的任务，因为日志中可能涌入大量数据。然而，借助专门的工具和技术，这项任务的复杂性可以大大降低。日志分析工具擅长解析日志并将数据以更易管理和消化的格式呈现。这些工具可以过滤、搜索和聚合日志数据，使定位相关信息更加容易。同样，可视化工具可以帮助识别日志数据中的模式和趋势。它们可以将文本形式的日志数据转换为图形表示，从而更容易发现异常或性能瓶颈。

此外，基于历史数据的机器学习技术可以预测未来的性能趋势。这种预测分析在主动式的系统维护和优化中至关重要。然而，有效使用这些技术需要大量的历史数据以及对数据科学原理的基本理解。

这些工具不仅在问题识别方面至关重要，还在操作响应方面发挥作用，例如根据日志分析结果触发告警或自动执行操作。我们将在第 5 章"端到端 Java 性能优化：工程技术及 JMH 微基准测试"中学习性能技术。

## 优化与管理统一日志系统

尽管统一日志系统是诊断和监控不可或缺的工具，但使用它需要仔细权衡，尤其是在应用程序性能方面。过多的日志记录可能导致性能下降，因为系统需要消耗额外资源写入日志文件。此外，大量的日志记录会消耗大量磁盘空间，这在存储受限的环境中可能是一个问题。为帮助管理磁盘空间使用，日志文件可以根据需要进行压缩、轮转或迁移到辅助存储。

因此，在详细日志信息的需求与潜在的性能影响之间取得平衡至关重要。一种方法是在生产环境中调整日志级别，使其仅包含最重要的消息。例如，在高流量场景中，将某些消息记录在 `error` 和 `warning` 级别可能比将所有消息记录在 `info`、`debug` 或 `trace` 级别更为合适。

另一个考虑因素是日志消息的输出目的地。在应用程序的开发阶段，建议将日志消息直接输出到 stdout——这也是日志系统默认采用的方式。然而，在生产环境中，将日志消息写入文件可能更合适，这样这些消息可以在需要时存档和后续分析。

统一日志系统的一项高级功能是能够在运行时动态调整日志级别。这一能力对于排查正在运行的应用程序中的问题尤其有益。例如，你可能通常会以标准日志级别运行应用程序以最大化性能。然而，在流量激增或观察到特定模式增加时，你可以临时更改日志标签级别以收集更多相关信息。一旦问题解决，恢复正常后，你可以在不重启应用程序的情况下恢复到原始日志级别。

这种动态日志功能由 `jcmd` 工具实现，它允许你向正在运行的 JVM 发送命令。例如，要将 `gc*` 标签的日志级别提升到 `trace`，并添加一些有用的装饰器，可以使用以下命令：

```bash
$ jcmd <pid> VM.log what=gc*=trace decorators=uptimemillis,tid,hostname
```

这里 `<pid>` 是正在运行的 JVM 的进程 ID。执行此命令后，JVM 将开始以 `trace` 级别记录所有垃圾收集活动，包括以毫秒为单位的运行时间、线程 ID 和主机名装饰器。这为我们提供了全面的诊断信息。

要探索全部可配置选项，可以使用以下命令：

```bash
$ jcmd <pid> help VM.log
```

虽然统一日志系统提供了丰富的信息，但明智地使用它至关重要。通过调整日志级别、选择合适的输出以及利用动态日志功能，你可以有效地管理日志详细程度与系统性能之间的权衡。

## 异步日志与统一日志系统

Java 统一日志系统的发展带来了另一个值得注意的高级（可选）特性：异步日志。与传统同步日志不同（在某些条件下可能成为应用程序性能的瓶颈），异步日志将日志写入任务委托给单独的线程。日志条目在传输到最终输出之前被放置在一个暂存缓冲区中。这种方法最大限度地减少了日志记录对主应用程序线程的影响——这一考虑对于现代大规模、延迟敏感的应用程序至关重要。

### 异步日志的优势

- **降低延迟**：通过将日志活动卸载到后台线程，异步日志显著降低了应用程序处理中的延迟，确保关键操作不会因日志写入而延迟。
- **提高吞吐量**：在 I/O 密集型环境中，异步日志通过并行处理日志活动来提高应用程序吞吐量，使主应用程序能够处理更多请求。
- **负载下的一致性**：异步日志最重要的优势之一是其即使在大量应用程序负载下也能保持一致的性能。它有效降低了日志引起的瓶颈风险，确保性能保持稳定和可预测。

### 在 Java 中实现异步日志

**使用现有库和框架**

Java 提供了几个具备异步功能的强大日志框架，例如 Log4j2 和 Logback：

- **Log4j2**[^4]：Log4j2 的异步日志记录器利用 LMAX Disruptor（一个高性能的线程间消息传递库）来提供低延迟和高吞吐量的日志记录。其配置涉及在配置文件中指定 `AsyncLogger`，然后将日志事件定向到环形缓冲区（ring buffer），从而减少日志记录的开销。
- **Logback**[^5]：在 Logback 中，可以通过 `AsyncAppender` 包装器启用异步日志，它会缓冲日志事件并将其分派到指定的 appender。配置涉及用 `AsyncAppender` 包装现有的 appender，并调整缓冲区大小和其他参数以平衡性能和资源使用。

在这两个框架中，配置异步日志记录器通常涉及 XML 或 JSON 配置文件，可以在其中定义缓冲区大小、阻塞行为和底层 appender 等各种参数。

[^4]: https://logging.apache.org/log4j/2.x/manual/async.html
[^5]: https://logback.qos.ch/manual/appenders.html#AsyncAppender

**自定义异步日志解决方案**

在某些场景下，标准框架可能无法满足应用程序的独特需求。在这种情况下，开发自定义的异步日志解决方案可能是合适的。自定义实现的关键考虑因素包括：

- **线程安全性**：确保日志操作是线程安全的，以避免数据损坏或不一致。
- **内存管理**：在日志过程中高效管理内存，特别是在管理日志消息缓冲区时，以防止内存泄漏或高内存消耗。
- **实现示例**：一个基本的自定义异步日志记录器可能涉及生产者-消费者模式，其中主应用程序线程（生产者）将日志消息入队到共享缓冲区，而一个单独的日志线程（消费者）出队并处理这些消息。

**与统一 JVM 日志的集成**

- **挑战与解决方案**：对于 JDK 17 之前的 JVM 版本或在复杂的日志场景中，将外部异步日志框架与统一 JVM 日志系统集成需要仔细配置以确保兼容性和性能。这可能涉及设置 JVM 标志和参数以正确地将日志消息路由到异步日志系统。
- **JDK 17 及更高版本的原生支持**：从 JDK 17 开始，统一日志系统原生支持异步日志。可以使用 `-Xlog:async` 选项启用它，使得 JVM 的内部日志能够异步处理，而不影响 JVM 自身的性能。

### 最佳实践与注意事项

**管理日志背压**

- **挑战**：在异步日志中，当日志消息生成速率超过处理和写入这些消息的能力时，就会产生背压。这可能导致性能下降或日志数据丢失。
- **有界队列**：在日志系统中实现有界队列可以帮助管理日志消息的累积。通过限制未处理消息的数量，这些队列可以防止内存过度使用。
- **丢弃策略**：当队列达到容量时，建立丢弃日志消息的策略可以防止系统过载。这可能涉及丢弃不太重要的日志消息或汇总消息内容。
- **实际案例**：一个高流量的 Web 应用程序可能会实现一种丢弃策略，即在峰值负载期间优先处理错误日志而非信息日志，以维护系统稳定性。

**确保日志可靠性**

- **关键性**：日志系统的可靠性至关重要，尤其是在应用程序崩溃或突然关闭时。在这种情况下丢失日志数据可能会妨碍故障排查并影响合规性。
- **预写日志**：实现预写日志（write-ahead logging）可确保即使应用程序发生故障，日志数据也能得到保留。此技术涉及在实际日志操作完成之前将日志数据写入持久存储位置。
- **优雅关闭流程**：设计日志系统以优雅地处理关闭，确保在应用程序完全停止之前，所有缓冲的日志数据都被写出。
- **不利条件下的策略**：在日志基础设施中包含冗余，以便即使在主要日志机制发生故障时也能捕获日志数据。这在分布式系统中尤其重要，因为多个组件都可能生成日志。

**异步日志系统的性能调优**

- **优化性能的调优**
  - **缓冲区容量**：如果你的应用程序经历日志生成的周期性峰值，增加缓冲区大小可以帮助吸收这些峰值。
  - **处理间隔**：日志从缓冲区刷新到输出的频率会影响性能和日志的及时性。调整此间隔有助于平衡 CPU 使用与日志写入的即时性。

- **JDK 17 中的异步日志注意事项**
  - **线程池大小**：调整专用于异步日志的线程数量至关重要。更多线程可以处理更高的日志量，但过多的线程可能会导致严重的 CPU 开销。
  - **缓冲区大小调优**：`AsyncLogBufferSize` 参数对于管理系统在刷新前可以处理的日志消息量至关重要。更大的缓冲区可以容纳更多日志消息，这在日志生成的峰值期间非常有益。然而，更大的缓冲区也需要更多内存。
  - **监控 JDK 17 的异步日志**：随着新的异步日志功能的引入，监控工具和技术可能需要更新，以跟踪新缓冲区的利用率和日志系统的性能。

- **监控与指标**
  - **缓冲区利用率**：你可以使用日志框架的内部指标或自定义监控脚本来跟踪缓冲区使用情况。如果缓冲区的利用率持续超过 80%，这表明你应该增加其大小。
  - **队列长度**：可以使用监控工具或日志框架的 API 来跟踪日志队列的长度。持续过长的队列需要更多的日志线程或更大的缓冲区。
  - **写入延迟**：测量日志消息创建与其最终写入操作之间的时间差可以发现写入延迟。如果这些延迟持续偏高，优化文件 I/O 操作或将日志分布到多个文件或磁盘上可能会有所帮助。
  - **JVM 工具与指标**：像 JVisualVM[^6] 和 Java Mission Control（JMC）[^7] 这样的工具可以提供对 JVM 性能的洞察，包括可能影响日志的方面，如线程活动或内存使用。

[^6]: https://visualvm.github.io/
[^7]: https://jdk.java.net/jmc/8/

## 理解 JDK 11 和 JDK 17 中的增强

统一日志系统最初在 JDK 9 中引入，并在随后的 JDK 版本中经历了细化和增强。本节讨论 JDK 11 和 JDK 17 中与统一日志相关的重要改进。

### JDK 11

在 JDK 11 中，统一日志框架的一个显著改进是增加了在运行时动态配置日志的能力。这一增强由 `jcmd` 工具实现，该工具允许开发人员向正在运行的 JVM 发送命令，包括调整日志级别的命令。这一创新使开发人员能够根据诊断需求增加或减少日志记录，而无需重启 JVM，从而极大地受益。

JDK 11 还改进了 `java.util.logging`，为 `Logger` 和 `LogManager` 引入了新方法。这些新增内容进一步增强了日志控制和能力，为开发人员在处理 Java 日志时提供了更细粒度和更高的灵活性。

### JDK 17

JDK 17 在 JVM 的统一日志系统中引入了原生支持异步日志的改进。此外，JDK 17 还为日志系统的整体性能、安全性和稳定性带来了更广泛的间接改进。这些改进有助于提升统一日志的有效性，因为更稳定和更安全的系统始终有利于准确和可靠的日志记录。

## 结论

在本章中，我们探讨了统一日志系统，展示了其实际用法，并概述了在后续 JDK 版本中引入的增强。JVM 中的统一日志系统为所有日志消息提供了单一、一致的接口。这种在整个 JVM 中的和谐统一增强了可读性和可解析性，有效地消除了日志交错或混杂的问题。保留将日志重定向到文件的能力——这一功能甚至在 JDK 9 之前就已存在——是保持早期日志机制有用性的重要部分。日志继续保持人类可读性，而时间戳默认反映运行时间。

统一日志系统还提供了显著的增值特性。JDK 11 中引入的动态日志功能允许开发人员在运行时对日志命令进行调整。结合统一日志系统提供的对应用程序流程的增强可见性和控制，开发人员现在可以通过命令行输入指定所需的日志信息深度，从而提高了调试和性能测试的效率。

从统一日志系统获取的信息可用于调优 JVM 参数以获得最佳性能。例如，笔者有自己的 GC 解析和绘图工具包，现在更加整合和精简，能够提供关于内存使用模式、暂停事件、堆利用率、暂停细节以及与收集器类型相关的各种其他模式的洞察。这些信息可用于调整堆大小、选择合适的垃圾收集器以及调优其他垃圾收集参数。

Java 的新特性，如 Project Loom 和 Z 垃圾收集器（ZGC），对 JVM 性能有重要影响。这些特性可以通过统一日志系统进行监控，以了解它们对应用程序性能的影响。例如，ZGC 日志可以提供关于 GC 暂停时间和回收内存效率的洞察。我们将在后续章节中了解更多关于这些特性的内容。

总之，JVM 中的统一日志系统是开发人员的一个强大工具。通过理解和利用这一系统，开发人员可以简化故障排查工作，获得对 Java 应用程序行为和性能的更深入洞察。不同 JDK 版本的持续增强使统一日志系统变得更加健壮和多功能，巩固了其作为 Java 开发人员工具包中基本工具的地位。
