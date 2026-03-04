---
title: "设计模式在JDK源码中的应用全景"
date: 2026-03-04
tags: [Java, OOP, 设计模式, JDK, 源码, 集合框架, 并发, IO, 工厂方法, 装饰器, 迭代器, 组合, 享元, 模板方法, 策略, 观察者, 代理, 适配器]
aliases: []
---

# 设计模式在JDK源码中的应用全景

## 摘要

JDK 是 Java 开发者每天都在使用的标准库，其源码代表了 Java 语言创始团队对面向对象设计的最直接诠释。与 Spring 的"框架扩展点"视角不同，JDK 源码的设计模式更多体现在"语言级别的抽象"——集合框架（Collection Framework）的迭代器、装饰器、组合和享元；`java.io` 的装饰器体系；`java.util.concurrent` 的策略、模板方法和命令；`java.lang` 的单例与享元；反射与代理机制。本文以模式为线索，系统梳理 JDK 各核心模块中的设计模式应用，既是对本专栏前九篇知识的融会贯通，也是形成"在日常使用的 API 中识别设计模式"这一直觉能力的训练。每个案例不仅标注模式类型，还深入分析"为什么 JDK 在这里选择了这种模式，而不是其他方案"——这是理解设计权衡的关键。

---

## 第 1 章 集合框架（java.util）：模式的集中地

### 1.1 迭代器模式：Iterable + Iterator 的语言级支持

集合框架中最直接体现迭代器模式的是 `Iterable<T>` 和 `Iterator<T>` 这对接口。几乎所有的集合类（`List`、`Set`、`Queue`、`Map` 的键/值/条目集合）都实现了 `Iterable<T>`，从而支持 `for-each` 语法糖。

**为什么 `Iterable` 和 `Iterator` 要分成两个接口，而不是合并为一个？**

```java
// 如果将两者合并（反例）
public interface IterableCollection<T> {
    boolean hasNext();
    T next();
    // 集合本身同时充当迭代器，只能维护一个遍历状态
}

// 问题：无法同时进行两次独立的遍历
IterableCollection<String> list = ...;
// 以下会互相干扰，因为两个"迭代器"共享同一个迭代状态
for (String a : list) {         // 遍历 1
    for (String b : list) {     // 遍历 2（与遍历 1 共享状态，结果不可预期）
        ...
    }
}
```

分离的设计允许**每次调用 `iterator()` 返回一个新的、独立的迭代器对象**，每个迭代器维护自己的当前位置，多个迭代器可以独立遍历同一个集合，互不干扰。这是迭代器模式"将遍历状态与集合数据分离"的核心思想。

**`Spliterator`（Java 8）：为并行而生的增强迭代器**

`Spliterator`（Splittable Iterator）是 Java 8 为 Stream API 引入的增强迭代器，在 `Iterator` 的顺序遍历基础上增加了两个关键能力：

```java
public interface Spliterator<T> {
    boolean tryAdvance(Consumer<? super T> action);  // 处理一个元素，返回是否还有元素
    Spliterator<T> trySplit();                        // 尝试将自身分裂为两半（并行化的基础）
    long estimateSize();                              // 估计剩余元素数量（用于任务分配）
    int characteristics();                            // 描述数据特性（有序、唯一、不可变等）
}
```

`trySplit()` 是并行化的关键——`ForkJoinPool` 通过反复调用 `trySplit()` 将一个大的 `Spliterator` 分割成多个小的，分配给不同的工作线程并行处理。`ArrayList` 的 `Spliterator` 实现通过下标范围分割（`[lo, mid)` 和 `[mid, hi)`），而 `LinkedList` 的实现则必须遍历到中点再分割，效率较低——这解释了为什么 `LinkedList` 的 `parallelStream()` 性能往往不如 `ArrayList`。

### 1.2 组合模式：树形结构的统一处理

JDK 集合框架中，`Collection`、`List`、`Set`、`Queue` 的接口层次就是组合模式的体现，但最典型的组合模式应用是在文件系统相关 API（`java.nio.file`）中：

```java
// java.nio.file.Files 的树形遍历：目录（组合节点）和文件（叶节点）统一处理
Files.walkFileTree(Paths.get("/"), new SimpleFileVisitor<Path>() {
    @Override
    public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
        // 处理文件（叶节点）
        System.out.println("FILE: " + file);
        return FileVisitResult.CONTINUE;
    }
    
    @Override
    public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
        // 处理目录（组合节点）进入前
        System.out.println("DIR:  " + dir);
        return FileVisitResult.CONTINUE;
    }
});
```

`SimpleFileVisitor` 的结构是访问者模式（Visitor）与组合模式（Composite）的结合——树形文件结构是组合模式，`FileVisitor` 是访问者。`FileVisitResult` 的返回值（`CONTINUE`、`SKIP_SUBTREE`、`TERMINATE`）是责任链模式中"是否继续传递"的控制机制在树遍历中的体现。

### 1.3 享元模式：Integer 缓存与 String 池

JDK 中最著名的享元模式实现有两处，每位 Java 开发者都曾遭遇过它们引起的"迷惑行为"：

**`Integer` 缓存（IntegerCache）**：

```java
// Integer.valueOf() 的内部实现（JDK 源码，已简化）
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high) {  // 默认 [-128, 127]
        return IntegerCache.cache[i + (-IntegerCache.low)]; // 返回缓存的共享对象
    }
    return new Integer(i);  // 超出缓存范围：创建新对象
}
```

这就是为什么 `Integer a = 127; Integer b = 127; a == b` 结果是 `true`（指向同一个缓存对象），而 `Integer a = 128; Integer b = 128; a == b` 结果是 `false`（分别是新创建的不同对象）。`[-128, 127]` 是最常用的整数范围，缓存这些值可以避免大量重复的装箱操作，节省堆内存。可以通过 JVM 参数 `-XX:AutoBoxCacheMax=<size>` 扩大缓存上限。

类似的缓存机制在 `Long`（`[-128, 127]`）、`Short`（`[-128, 127]`）、`Byte`（全范围，即所有 `[-128, 127]`）、`Character`（`[0, 127]`）中也有实现；`Boolean` 只有两个值，`TRUE` 和 `FALSE` 是静态常量，天然享元。

**`String` 常量池（String Pool）**：

```java
String s1 = "hello";              // 字面量：从 String 常量池获取（享元）
String s2 = "hello";              // 同一个字面量：复用池中的对象
String s3 = new String("hello");  // 显式 new：绕过池，堆中新建对象

System.out.println(s1 == s2);     // true：同一个常量池对象
System.out.println(s1 == s3);     // false：s3 是堆中的新对象
System.out.println(s1 == s3.intern()); // true：intern() 将 s3 放入池（或返回已有池对象）
```

String 常量池的享元设计依赖于 `String` 的**不可变性（Immutability）**——这是享元模式成立的必要条件：共享对象必须是不可变的，否则一个"使用者"修改了共享对象，所有其他使用者都会受到影响。`String` 的不可变性（`final char[]`，无任何修改 API）不只是为了线程安全，更是享元模式能够安全实施的保证。

### 1.4 装饰器模式：Collections 工具类的包装器

`java.util.Collections` 提供了一系列静态工厂方法，返回原集合的"增强包装版本"——这是装饰器模式的标准实现：

```java
// 只读包装（不可修改装饰器）
List<String> original = new ArrayList<>(Arrays.asList("a", "b", "c"));
List<String> readOnly = Collections.unmodifiableList(original);
readOnly.add("d");  // 抛出 UnsupportedOperationException

// 线程安全包装（同步装饰器）
List<String> syncList = Collections.synchronizedList(original);
// syncList 的所有方法都加了 synchronized 同步块

// 单元素包装（不可变单元素集合）
Set<String> singleton = Collections.singleton("only");

// 空集合包装（不可变空集合，类型安全的空集合）
List<String> empty = Collections.emptyList();
```

以 `Collections.unmodifiableList()` 返回的内部类 `UnmodifiableList` 为例，它是一个典型的装饰器：

```java
// Collections.UnmodifiableList（JDK 源码，已简化）
static class UnmodifiableList<E> extends UnmodifiableCollection<E> implements List<E> {
    final List<? extends E> list;  // 被装饰的原始列表
    
    UnmodifiableList(List<? extends E> list) {
        super(list);
        this.list = list;
    }
    
    // 读操作：委托给原始列表
    public E get(int index)          { return list.get(index); }
    public int indexOf(Object o)     { return list.indexOf(o); }
    public List<E> subList(int from, int to) {
        return new UnmodifiableList<>(list.subList(from, to));  // 子列表也是不可修改的
    }
    
    // 写操作：拒绝并抛出异常
    public void add(int index, E element)      { throw new UnsupportedOperationException(); }
    public E set(int index, E element)         { throw new UnsupportedOperationException(); }
    public E remove(int index)                 { throw new UnsupportedOperationException(); }
    public void sort(Comparator<? super E> c)  { throw new UnsupportedOperationException(); }
}
```

装饰器的特征完全吻合：持有被装饰对象的引用（`list`）、实现相同的接口（`List<E>`）、增强（这里是限制）被装饰对象的行为。调用方不需要知道得到的是原始列表还是包装列表——接口完全一致，只是部分行为被拦截。

> [!warning] Collections.unmodifiableList 不是深度不可变
> `unmodifiableList()` 只是防止通过包装器修改列表结构（增删），但如果列表元素本身是可变对象，仍然可以通过 `get()` 获取元素后修改它的内部状态。真正的深度不可变需要元素对象本身也是不可变的（如用 `record` 或 `@Value` 的 DTO），或使用 Java 9+ 的 `List.of()`（禁止 `null`，元素和列表都是不可变的）。

---

## 第 2 章 java.io / java.nio：装饰器的极致应用

### 2.1 InputStream 体系：装饰器链的经典范本

`java.io` 的 I/O 流体系是教科书级别的装饰器模式应用，每一个流对象都可以被包裹在另一个流对象中，形成功能叠加的装饰器链：

```
InputStream（抽象基类，Component）
├── FileInputStream（具体组件：从文件读取原始字节）
├── ByteArrayInputStream（具体组件：从字节数组读取）
├── PipedInputStream（具体组件：从管道读取）
└── FilterInputStream（抽象装饰器）
    ├── BufferedInputStream（装饰器：添加缓冲区，减少系统调用次数）
    ├── DataInputStream（装饰器：添加读取 int/long/double 等基本类型的能力）
    ├── PushbackInputStream（装饰器：添加"退回已读字节"的能力）
    └── CheckedInputStream（装饰器：添加校验和计算能力）
```

通过组合，可以叠加多种功能：

```java
// 组合多个装饰器：从文件读取，带缓冲，且能读取 Java 基本数据类型
DataInputStream dis = new DataInputStream(
    new BufferedInputStream(
        new FileInputStream("data.bin")
    )
);
int value = dis.readInt();    // 读取 4 字节并解析为 int
double d   = dis.readDouble(); // 读取 8 字节并解析为 double
```

**这里选择装饰器而不是继承的原因是什么？**

如果用继承来叠加功能，需要为每种组合单独创建子类：
- `BufferedFileInputStream`
- `DataBufferedFileInputStream`
- `CheckedBufferedFileInputStream`
- `DataCheckedBufferedFileInputStream`
- ...

M 种功能就需要 2^M 个子类——组合爆炸。装饰器模式通过运行时组合，只需 M 个装饰器类，就能表示 2^M 种功能组合。这是"组合优于继承"在 I/O 系统中的完美诠释。

### 2.2 Reader/Writer 体系：字符流装饰器

字符流（`Reader`/`Writer`）与字节流结构完全对称，同样是装饰器体系：

```java
// 从文件读取，自动检测编码，带缓冲
BufferedReader reader = new BufferedReader(
    new InputStreamReader(
        new FileInputStream("data.txt"), 
        StandardCharsets.UTF_8
    )
);

// InputStreamReader 是字节流到字符流的桥接（适配器模式！）
// 它将 InputStream（字节流）适配为 Reader（字符流）的接口
// BufferedReader 再装饰 Reader，添加 readLine() 等便利方法

String line;
while ((line = reader.readLine()) != null) {
    System.out.println(line);
}
```

这里 `InputStreamReader` 同时体现了两个模式：
- **适配器模式**：将 `InputStream`（字节接口）适配为 `Reader`（字符接口），两个接口不兼容，通过适配器转换；
- 它同时也是一个**组件**，可以被 `BufferedReader` 装饰。

一个类在不同的视角下，可以对应不同的设计模式——模式不是非此即彼的标签，而是从特定角度描述设计的视角。

---

## 第 3 章 java.util.concurrent：并发包中的设计模式

### 3.1 AbstractQueuedSynchronizer：模板方法模式的精髓

`AbstractQueuedSynchronizer`（AQS）是 Java 并发包最重要的基础类，`ReentrantLock`、`CountDownLatch`、`Semaphore`、`ReentrantReadWriteLock` 都基于它构建。AQS 的设计是模板方法模式在并发编程中最深刻的应用。

AQS 将同步器的通用逻辑（FIFO 等待队列管理、线程的 park/unpark、自旋重试）固化在父类中，将"什么叫做获取同步器成功"和"什么叫做释放同步器"定义为子类需要覆写的方法：

```java
// AQS 中定义的"可变步骤"（子类按需覆写）
public abstract class AbstractQueuedSynchronizer {
    
    // 独占模式：尝试获取（子类覆写，定义"什么情况下算获取成功"）
    protected boolean tryAcquire(int arg) {
        throw new UnsupportedOperationException();
    }
    
    // 独占模式：尝试释放
    protected boolean tryRelease(int arg) {
        throw new UnsupportedOperationException();
    }
    
    // 共享模式：尝试获取（≥0 表示成功）
    protected int tryAcquireShared(int arg) {
        throw new UnsupportedOperationException();
    }
    
    // 共享模式：尝试释放
    protected boolean tryReleaseShared(int arg) {
        throw new UnsupportedOperationException();
    }
    
    // AQS 的"固化骨架"：acquire 的完整流程（子类不需要也不应该覆写这部分）
    public final void acquire(int arg) {
        // 1. 先尝试直接获取（调用子类覆写的 tryAcquire）
        // 2. 如果失败，将当前线程封装为 Node 加入 CLH 等待队列
        // 3. 在队列中自旋或 park 等待
        // 4. 等被唤醒后，再次尝试 tryAcquire
        if (!tryAcquire(arg) && acquireQueued(addWaiter(Node.EXCLUSIVE), arg)) {
            selfInterrupt();
        }
    }
}
```

`ReentrantLock` 的公平锁和非公平锁，对 `tryAcquire()` 的实现有本质差异：

```java
// ReentrantLock.FairSync：公平锁的 tryAcquire
protected final boolean tryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        // 关键区别：hasQueuedPredecessors() 检查等待队列中是否有其他线程
        // 如果有，即使当前没有线程持有锁，也不抢占（尊重等待顺序）
        if (!hasQueuedPredecessors() && compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    } else if (current == getExclusiveOwnerThread()) {
        // 重入：持有锁的线程再次获取，只增加计数
        setState(c + acquires);
        return true;
    }
    return false;
}

// ReentrantLock.NonfairSync：非公平锁的 tryAcquire
protected final boolean tryAcquire(int acquires) {
    return nonfairTryAcquire(acquires);
}

final boolean nonfairTryAcquire(int acquires) {
    final Thread current = Thread.currentThread();
    int c = getState();
    if (c == 0) {
        // 非公平：不检查等待队列，直接 CAS 抢锁（可能插队）
        if (compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(current);
            return true;
        }
    }
    // 重入逻辑同上...
    return false;
}
```

两种实现仅在 `tryAcquire()` 上有差异，AQS 的等待队列管理、线程 park/unpark 完全复用——这正是模板方法模式的力量：**变化的部分（竞争策略）下放到子类，不变的部分（队列管理）由父类统一实现**。

### 3.2 Callable 与 FutureTask：命令模式的异步版本

`Callable<V>` 是 `Runnable` 的有返回值版本，两者都是命令接口——将一段操作封装为对象，提交给执行器（`ExecutorService`）异步执行：

```java
// Callable：有返回值的命令接口
public interface Callable<V> {
    V call() throws Exception;
}

// Runnable：无返回值的命令接口
public interface Runnable {
    void run();
}

// ExecutorService：命令的执行者（Invoker）
ExecutorService executor = Executors.newFixedThreadPool(4);

// 提交命令：返回 Future（凭证，用于获取异步结果）
Future<Integer> future = executor.submit(() -> {
    Thread.sleep(1000);
    return 42;  // 异步计算结果
});

// 主线程做其他事...

// 需要结果时，通过 Future 阻塞获取
Integer result = future.get();  // 等待异步完成，获取 42
```

`FutureTask<V>` 同时实现了 `Runnable` 和 `Future<V>`——它既可以被提交给 `ExecutorService` 执行（作为 `Runnable`），又可以被其他线程查询结果（作为 `Future`）。这是命令模式（封装操作）与状态模式（RUNNING / COMPLETING / NORMAL / EXCEPTIONAL / CANCELLED）的结合。

### 3.3 Comparator：策略模式的函数式演进

`Comparator<T>` 是集合排序中的策略接口，定义了"两个对象如何比较大小"这一可变算法：

```java
// Comparator 是一个函数式接口（策略接口）
@FunctionalInterface
public interface Comparator<T> {
    int compare(T o1, T o2);
    // 还有大量 default 方法用于组合策略...
}

// 策略的使用：不同排序策略，不需要修改 sort 调用代码
List<Employee> employees = getEmployees();

// 策略一：按薪资降序
employees.sort(Comparator.comparingDouble(Employee::getSalary).reversed());

// 策略二：按部门升序，相同部门按姓名升序（策略组合）
employees.sort(Comparator.comparing(Employee::getDepartment)
                         .thenComparing(Employee::getName));

// 策略三：自定义多级排序（Lambda 即策略）
employees.sort((e1, e2) -> {
    int deptCompare = e1.getDepartment().compareTo(e2.getDepartment());
    if (deptCompare != 0) return deptCompare;
    return Double.compare(e2.getSalary(), e1.getSalary());  // 同部门按薪资降序
});
```

Java 8 为 `Comparator` 增加了大量 `default` 方法（`reversed()`、`thenComparing()`、`comparing()`），使得策略对象可以被**函数式组合**——一个排序策略可以在原有基础上派生出新策略，而不需要创建新的实现类。这是函数式编程思想与策略模式的深度融合。

---

## 第 4 章 java.lang 与反射：代理与工厂

### 4.1 java.lang.reflect.Proxy：JDK 动态代理

`java.lang.reflect.Proxy` 是 JDK 动态代理的实现，在前面章节（OOP 04）已有详细分析，这里从 JDK 源码角度补充其内部机制：

```java
// Proxy.newProxyInstance() 的核心逻辑（JDK 11+ 简化版）
public static Object newProxyInstance(ClassLoader loader,
                                       Class<?>[] interfaces,
                                       InvocationHandler h) {
    // 1. 根据接口列表在缓存中查找（或生成）代理类
    //    代理类继承 Proxy，实现所有指定接口，每个方法的实现都委托给 h.invoke()
    Class<?> cl = getProxyClass0(loader, interfaces);
    
    // 2. 获取代理类的构造器（接受 InvocationHandler 参数）
    final Constructor<?> cons = cl.getConstructor(constructorParams);
    
    // 3. 通过构造器创建代理实例，传入 InvocationHandler
    return cons.newInstance(new Object[]{h});
}
```

生成的代理类字节码（通过 `javap` 反编译）大致如下：

```java
// 代理类（JVM 运行时动态生成，名如 $Proxy0）
public final class $Proxy0 extends Proxy implements UserService {
    private static final Method m1;  // equals
    private static final Method m2;  // toString
    private static final Method m3;  // getUserById（业务方法）
    
    static {
        m3 = Class.forName("UserService").getMethod("getUserById", Long.class);
        // ... 其他方法的 Method 对象初始化
    }
    
    public User getUserById(Long id) {
        try {
            // 将调用委托给 InvocationHandler.invoke()
            return (User) super.h.invoke(this, m3, new Object[]{id});
        } catch (RuntimeException | Error e) {
            throw e;
        } catch (Throwable e) {
            throw new UndeclaredThrowableException(e);
        }
    }
}
```

`InvocationHandler` 接口是整个动态代理机制的策略接口——它定义了"当代理方法被调用时做什么"，不同的 `InvocationHandler` 实现可以实现不同的横切逻辑（日志、缓存、事务……）。

### 4.2 Runtime.getRuntime()：单例的系统级应用

`java.lang.Runtime` 是 JDK 中最原始的单例模式实现之一：

```java
// Runtime 的单例实现（JDK 源码）
public class Runtime {
    private static final Runtime currentRuntime = new Runtime();  // 饿汉式单例
    
    private Runtime() {}  // 私有构造器：禁止外部创建
    
    public static Runtime getRuntime() {
        return currentRuntime;
    }
    
    // 实例方法：获取可用 CPU 核心数、执行外部命令、添加 JVM 关闭钩子等
    public int availableProcessors() { return Runtime.availableProcessors0(); }
    public void addShutdownHook(Thread hook) { ... }
}
```

`Runtime` 代表 JVM 进程本身——进程是单一的，`Runtime` 自然也应该是单例。这里用饿汉式初始化（类加载时立即创建），不需要懒加载，因为 JVM 启动后 `Runtime` 必然会被使用。

### 4.3 Enum：设计模式界的"天选之子"

Java `enum` 类型在语言层面提供了对多种设计模式的原生支持：

**单例模式**：每个枚举常量在 JVM 中有且仅有一个实例，由 JVM 保证（`readObject()` 也无法打破），是实现单例的最佳方式：

```java
// 枚举单例：线程安全、防反射攻击、防序列化破坏
public enum DatabaseConnectionPool {
    INSTANCE;
    
    private final DataSource dataSource;
    
    DatabaseConnectionPool() {
        this.dataSource = createDataSource();
    }
    
    public Connection getConnection() throws SQLException {
        return dataSource.getConnection();
    }
}
```

**策略模式**：枚举可以为每个常量定义不同的抽象方法实现，天然是一个策略注册表：

```java
// 枚举策略：每个枚举常量实现不同的算法
public enum DiscountType {
    NONE {
        @Override public double apply(double price) { return price; }
    },
    VIP {
        @Override public double apply(double price) { return price * 0.9; }
    },
    SUPER_VIP {
        @Override public double apply(double price) { return price * 0.8; }
    },
    FLASH_SALE {
        @Override public double apply(double price) { return price * 0.5; }
    };
    
    public abstract double apply(double price);
}

// 使用：直接通过枚举值选择策略，不需要 if-else
double finalPrice = DiscountType.VIP.apply(originalPrice);
```

**状态模式**：如果状态之间的迁移逻辑较简单（只是不同状态下的不同行为，没有复杂的迁移条件），可以用枚举替代完整的状态类体系：

```java
public enum TrafficLight {
    RED {
        @Override public TrafficLight next() { return GREEN; }
        @Override public int duration() { return 60; }
    },
    GREEN {
        @Override public TrafficLight next() { return YELLOW; }
        @Override public int duration() { return 45; }
    },
    YELLOW {
        @Override public TrafficLight next() { return RED; }
        @Override public int duration() { return 5; }
    };
    
    public abstract TrafficLight next();   // 状态迁移
    public abstract int duration();        // 当前状态持续时间（秒）
}
```

---

## 第 5 章 工厂方法遍布 JDK

### 5.1 静态工厂方法：Java 惯用法

JDK 中"静态工厂方法"（Static Factory Method，Effective Java 第 1 条）是比构造器更优秀的对象创建方式，大量存在于 JDK API 中：

```java
// 集合的静态工厂（Java 9+）
List<String> list  = List.of("a", "b", "c");         // 不可变列表
Set<String>  set   = Set.of("x", "y", "z");           // 不可变集合
Map<String, Integer> map = Map.of("one", 1, "two", 2); // 不可变映射

// 时间 API 的静态工厂（java.time，Java 8+）
LocalDate  today    = LocalDate.now();
LocalDate  birthday = LocalDate.of(1990, 3, 15);
LocalDate  fromStr  = LocalDate.parse("2026-03-04");
Instant    now      = Instant.now();
Duration   twoHours = Duration.ofHours(2);

// NIO 的静态工厂
Path  path    = Path.of("/tmp/data.txt");              // Java 11+
Path  path2   = Paths.get("/tmp", "data.txt");

// Optional 的静态工厂
Optional<String> present = Optional.of("value");
Optional<String> empty   = Optional.empty();
Optional<String> nullable = Optional.ofNullable(null);  // 可能为 null 时用这个
```

静态工厂方法相比 `new` 的优势：
1. **有意义的名字**：`LocalDate.of(1990, 3, 15)` 比 `new LocalDate(1990, 3, 15)` 表意更清晰；
2. **不必每次创建新对象**：可以缓存（享元）、复用实例（如 `Boolean.valueOf(true)` 返回 `Boolean.TRUE` 常量）；
3. **可以返回子类型**：返回类型是接口，具体实现对调用方透明（如 `List.of()` 返回的具体类不是 `ArrayList`，而是专门优化的不可变列表实现）。

### 5.2 DriverManager.getConnection()：工厂方法选择实现类

JDBC 的 `DriverManager.getConnection()` 是工厂方法模式的经典案例——调用方只需提供数据库 URL，工厂方法根据 URL 的协议前缀（`jdbc:mysql://`、`jdbc:postgresql://`）自动选择对应的 Driver 实现：

```java
// 调用方完全不需要知道使用哪个 Driver 实现类
Connection conn = DriverManager.getConnection(
    "jdbc:mysql://localhost:3306/mydb",
    "root",
    "password"
);
```

`DriverManager` 维护了一个 `Driver` 注册表（`CopyOnWriteArrayList<DriverInfo>`），各个数据库驱动在加载时通过 `DriverManager.registerDriver(new com.mysql.cj.jdbc.Driver())` 将自己注册进来（Java 6+ 通过 `ServiceLoader` 自动注册，驱动 JAR 中的 `META-INF/services/java.sql.Driver` 文件声明驱动类名）。

`DriverManager.getConnection()` 遍历注册表，依次尝试每个 `Driver.connect(url, info)`，第一个返回非 `null` 连接的 Driver 胜出。这是**工厂方法模式 + 服务定位器（Service Locator）模式**的组合。

---

## 第 6 章 JDK 模式全景总结

### 6.1 JDK 中的 23 种 GoF 模式索引

| GoF 模式 | JDK 中的典型应用 | 涉及的 JDK 类/接口 |
| --- | --- | --- |
| **单例** | Runtime、Desktop | `Runtime.getRuntime()` |
| **工厂方法** | Collection 工厂、JDBC DriverManager | `List.of()`、`DriverManager.getConnection()` |
| **抽象工厂** | XML 解析工厂 | `DocumentBuilderFactory`、`SAXParserFactory` |
| **建造者** | StringBuilder、Stream.Builder | `StringBuilder`、`Stream.Builder<T>` |
| **原型** | 所有实现 Cloneable 的类 | `Object.clone()` |
| **适配器** | Arrays.asList、InputStreamReader | `Arrays.asList()`（数组→List）、`InputStreamReader` |
| **装饰器** | I/O 流体系、Collections 工具类 | `BufferedInputStream`、`Collections.unmodifiableList()` |
| **代理** | JDK 动态代理 | `java.lang.reflect.Proxy` |
| **外观** | javax.faces（JSF）、类库 API 层 | `javax.xml.parsers.DocumentBuilder` |
| **桥接** | JDBC 接口与驱动实现分离 | `java.sql.Connection`、具体驱动实现 |
| **组合** | Swing 组件树、NIO 文件树 | `java.awt.Container`、`Files.walkFileTree()` |
| **享元** | Integer/Long/Short/Byte/Char/Bool 缓存、String 池 | `Integer.valueOf()`、`String.intern()` |
| **模板方法** | AQS、AbstractList | `AbstractQueuedSynchronizer`、`AbstractList.sort()` |
| **策略** | Comparator、ThreadPoolExecutor 的拒绝策略 | `Comparator`、`RejectedExecutionHandler` |
| **观察者** | Swing 事件监听、java.util.Observable | `EventListener`、`java.util.Observer` |
| **迭代器** | 所有集合的 Iterator、Spliterator | `Iterator<T>`、`Spliterator<T>` |
| **责任链** | ClassLoader 双亲委派 | `ClassLoader.loadClass()` |
| **命令** | Runnable、Callable、FutureTask | `java.lang.Runnable`、`java.util.concurrent.Callable` |
| **状态** | Thread 状态机 | `Thread.State` 枚举 |
| **中介者** | ExecutorService（调度线程和任务）| `java.util.concurrent.ExecutorService` |
| **备忘录** | Serialization（对象状态序列化/反序列化）| `java.io.Serializable` |
| **访问者** | Files.walkFileTree 的 FileVisitor | `java.nio.file.FileVisitor` |
| **解释器** | java.util.regex（正则表达式引擎）| `Pattern`、`Matcher` |

### 6.2 ClassLoader 双亲委派：责任链的特殊变体

`ClassLoader` 的双亲委派机制（Parent Delegation Model）是责任链模式在类加载领域的特殊应用，值得单独分析：

```java
// ClassLoader.loadClass() 的双亲委派逻辑（JDK 源码，已简化）
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    // 1. 先检查是否已经加载过（缓存）
    Class<?> c = findLoadedClass(name);
    if (c == null) {
        try {
            if (parent != null) {
                // 2. 委托给父类加载器（责任链向上传递）
                c = parent.loadClass(name, false);
            } else {
                // 3. 父加载器为 null，使用 Bootstrap ClassLoader
                c = findBootstrapClassOrNull(name);
            }
        } catch (ClassNotFoundException e) {
            // 4. 父加载器找不到：不是错误，由当前加载器尝试
        }
        
        if (c == null) {
            // 5. 父加载器无法加载：当前加载器自己查找
            c = findClass(name);
        }
    }
    return c;
}
```

双亲委派的方向与普通责任链相反：**普通责任链是从链头向链尾传递**，而双亲委派是**从子向父向上委托**，只有父加载器无法处理时，才回退到子加载器自己处理。这种"反向责任链"保证了 Java 核心类（如 `java.lang.String`）始终由 Bootstrap ClassLoader 加载，防止用户自定义的同名类"污染"标准类库——这是 Java 安全模型的基础之一。

---

## 第 7 章 从 JDK 看模式应用的三个层次

### 7.1 语言机制层：模式被固化为语法

某些模式已经被 Java 语言本身内化，不需要手动实现：

- **迭代器**：`for-each` 语法是语言级别的迭代器支持；
- **单例**：`enum` 常量是语言保证的单例；
- **命令**：Lambda 表达式是语言级别的匿名命令对象；
- **观察者**：Java 的事件监听机制（`EventListener` 体系）是语言惯用法。

### 7.2 标准库层：模式被固化为 API

某些模式以标准 API 的形式提供，开发者直接使用，无需了解背后的模式：

- **享元**：`Integer.valueOf()`、`String.intern()`；
- **装饰器**：整个 `java.io` 流体系；
- **模板方法**：AQS、`AbstractList` 等 Abstract 类；
- **策略**：`Comparator`、`ExecutorService` 的拒绝策略。

### 7.3 框架层：模式被固化为扩展点

框架（如 Spring）在标准库的基础上，将更复杂的模式固化为扩展点，供应用开发者按需覆写：

- **模板方法**：`JdbcTemplate` 的各种回调接口；
- **观察者**：`BeanPostProcessor`、`ApplicationListener`；
- **策略**：`HandlerMapping`、`ViewResolver`。

---

## 总结：专栏回顾与设计哲学

至此，整个 OOP 设计模式专栏全部完成。从 SOLID 原则到 23 种 GoF 模式，再到 Spring 和 JDK 的工业级应用全景，有几个贯穿始终的核心洞察值得铭记：

**第一，模式是解决问题的手段，不是目的**。每种模式都针对特定的"坏味道"：`if-else` 泥潭（策略）、继承爆炸（装饰器/桥接）、紧耦合（观察者/中介者）、状态散落（状态机）……认识到问题，才能选择正确的模式，而不是"为了用模式而用模式"。

**第二，"组合优于继承"是现代 Java 设计的主基调**。策略模式、装饰器模式、组合模式都体现了这一原则——通过在运行时组合对象，比编译期的继承体系更灵活、更可测试。Java 8 的函数式接口让"策略对象"可以用 Lambda 直接表达，进一步降低了组合的成本。

**第三，设计模式是一种共同语言**。当你说"这里用了责任链"，团队中理解设计模式的每个人都能立刻理解架构意图；当你 review 代码时，识别出"这里其实是状态模式但用 if-else 实现的"，就能提出有价值的重构建议。模式是工程师之间高效沟通设计意图的词汇。

**第四，理解模式在 JDK 和 Spring 中的应用，是提升代码阅读能力的捷径**。`AQS` 不再是神秘的并发黑箱，而是模板方法模式的精妙应用；`JdbcTemplate` 不再只是"简化 JDBC 的工具类"，而是模板方法 + 策略的有机结合；`DispatcherServlet` 的请求处理流程不再难以理解，因为它遵循中介者 + 责任链 + 适配器的清晰脉络。

---

> [!note] 参考资料
> - GoF,《Design Patterns: Elements of Reusable Object-Oriented Software》, 1994
> - Joshua Bloch,《Effective Java》3rd ed.（静态工厂方法、枚举、Builder 等多个模式的 Java 最佳实践）
> - OpenJDK 源码（GitHub: openjdk/jdk）
> - Java SE 21 API Documentation（Oracle Docs）
> - Doug Lea,《Java Concurrency in Practice》（AQS 的设计哲学）
