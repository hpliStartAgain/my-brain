---
title: "JVM 性能工程"
date: 2026-05-12
tags: [Java, JVM, 垃圾回收, 性能工程, 索引]
aliases: [JVM Performance Engineering]
description: "《JVM Performance Engineering》by Monica Beckwith (2024, Pearson) 完整中文翻译版"
---

# JVM 性能工程

> [!info] 关于本书
> **原版**：*JVM Performance Engineering* by Monica Beckwith (2024, Pearson Education)
> **ISBN**：978-0-13-465987-9
> **翻译方式**：AI 辅助逐段完整翻译 + 专业仲裁校验，Mermaid 图表重绘

## 全书目录

| 章节 | 英文原标题 | 词数 | 仲裁 |
|------|-----------|------|------|
| [[Java/JVM-Performance-Engineering/00-前言]] | Preface | 5,434 | 100 ✅ |
| [[01-Java语言与虚拟机的性能演进]] | The Performance Evolution of Java | 14,440 | 90 ✅ |
| [[02-Java类型系统演进的性能影响]] | Performance Implications of Java's Type System Evolution | 8,272 | 95 ✅ |
| [[03-从单体到模块化Java：回顾与持续演进]] | From Monolithic to Modular Java | 7,935 | 100 ✅ |
| [[04-统一JVM日志接口]] | The Unified JVM Logging Interface | 5,658 | 100 ✅ |
| [[05-端到端Java性能优化：工程技术与JMH微基准测试]] | End-to-End Java Performance Optimization | 22,858 | 100 ✅ |
| [[06-OpenJDK高级内存管理与垃圾回收]] | Advanced Memory Management and GC | 14,907 | 95 ✅ |
| [[07-运行时性能优化：聚焦字符串锁及其他]] | Runtime Performance Optimizations | 14,218 | 90 ✅ |
| [[08-加速OpenJDK HotSpot VM稳态时间]] | Accelerating Time to Steady State | 10,319 | 100 ✅ |
| [[09-驾驭异构硬件：JVM性能工程的未来]] | Harnessing Exotic Hardware | 11,228 | 97 ✅ |

## 各章概要

### [[01-Java语言与虚拟机的性能演进]]
Java 生态的诞生 → HotSpot VM 编译器演进（解释器/JIT/分层编译/自适应优化/去优化）→ 分代 GC 基础 → Java 语言版本演进（1.1~17）

### [[02-Java类型系统演进的性能影响]]
基本类型/引用类型 → 枚举/注解/Lambda → VarHandle → Switch 表达式/密封类/记录类 → Project Valhalla（值类/基本类/泛型增强）→ JOL 内存布局分析

### [[03-从单体到模块化Java：回顾与持续演进]]
JPMS 模块系统 → 模块示例与编译运行 → 模块化 JDK 演进 → 模块化服务（SPI/ServiceLoader）→ JAR Hell 与 Jigsaw 层 → OSGi 对比 → Jdeps/Jlink/Jdeprscan/Jmod

### [[04-统一JVM日志接口]]
统一日志基础设施 → 标签（Tags）/级别（Levels）/装饰器（Decorators）/输出（Outputs）→ 实用示例与基准测试 → 异步日志 → JDK 11/17 增强

### [[05-端到端Java性能优化：工程技术与JMH微基准测试]]
软件工程层次与 QoS → 性能指标（足迹/响应性/吞吐量/可用性）→ 硬件-软件动态（NUMA/内存模型/并发）→ 方法论（自下而上/自上而下/SoW）→ JMH 微基准测试（Maven/注解/分析器/perfasm）

### [[06-OpenJDK高级内存管理与垃圾回收]]
TLAB/PLAB → NUMA-Aware GC → G1 GC 深度剖析（区域化堆/自适应/预测模型/调优）→ ZGC（染色指针/线程本地握手/ZPages）→ 未来趋势 → GC 评估实战

### [[07-运行时性能优化：聚焦字符串锁及其他]]
字符串优化（内联/去重/Indy 化/紧凑字符串）→ 监视器锁与锁类型 → 无争用/争用锁动态 → 锁优化（偏向锁/锁消除/锁粗化/自适应自旋）→ 自旋等待提示 → 虚拟线程（Project Loom）

### [[08-加速OpenJDK HotSpot VM稳态时间]]
JVM 启动阶段与生命周期 → CDS（类数据共享）→ AOT 编译 → Project Leyden → GraalVM → CRIU/Project CRaC → 无服务器/容器化优化 → Metaspace 演进

### [[09-驾驭异构硬件：JVM性能工程的未来]]
异构硬件与云计算 → LWJGL/Aparapi/Project Sumatra/TornadoVM → Project Panama（Vector API + FFM API）→ 未来展望

## 技术栈速览

- **JVM**：HotSpot VM、GraalVM
- **GC**：G1 GC、ZGC、Shenandoah、Serial/Parallel GC
- **编译**：JIT (C1/C2)、AOT、分层编译、OSR
- **工具**：JMH、JOL、JFR、JMC、NMT、async-profiler、perfasm、jdeps、jlink
- **关键项目**：Project Valhalla、Project Loom、Project Panama、Project Leyden、Project CRaC
- **并发**：虚拟线程、ForkJoinPool、CompletableFuture、ExecutorService
