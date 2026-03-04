---
title: "SqlSession与Executor——命令执行的核心引擎"
date: 2026-03-04
tags: [Java, Mybatis, SqlSession, Executor, SimpleExecutor, ReuseExecutor, BatchExecutor, CachingExecutor, 一级缓存, 装饰器模式]
aliases: []
---

# SqlSession与Executor——命令执行的核心引擎

## 摘要

在 Mybatis 的执行链路中，`SqlSession` 是应用代码与框架之间的门面，而 `Executor` 才是真正驱动 SQL 执行的引擎。二者的设计体现了一种清晰的职责分层：`SqlSession` 负责 API 的统一入口、参数封装和结果转换，`Executor` 负责缓存控制、语句调度和连接管理。理解 `Executor` 的三种基础实现（`SimpleExecutor`/`ReuseExecutor`/`BatchExecutor`）及其各自适用场景，以及 `CachingExecutor` 作为装饰器对二级缓存的处理方式，是掌握 Mybatis 性能调优和问题排查的关键。本文将深入剖析这两个核心组件的源码设计，并重点讲解一级缓存的命中条件、失效场景，以及 `BatchExecutor` 的正确使用姿势。

---

## 第 1 章 SqlSession：应用层的统一门面

### 1.1 SqlSession 是什么

`SqlSession` 是 Mybatis 中**最核心的接口**之一，代表与数据库的一次"会话"。它不仅是执行 SQL 的入口，还持有以下资源：
- 一个数据库 **Connection**（或一个延迟获取连接的引用）；
- 一个 **Executor** 实例（真正执行 SQL 的引擎）；
- 一个一级缓存（`localCache`，`PerpetualCache` 实例，本质是 `HashMap`）。

`SqlSession` 的 API 设计非常简洁：

```java
public interface SqlSession extends Closeable {
    // 查询单个对象
    <T> T selectOne(String statement);
    <T> T selectOne(String statement, Object parameter);
    
    // 查询列表
    <E> List<E> selectList(String statement);
    <E> List<E> selectList(String statement, Object parameter);
    <E> List<E> selectList(String statement, Object parameter, RowBounds rowBounds);
    
    // 查询 Map（key 是某列的值）
    <K, V> Map<K, V> selectMap(String statement, String mapKey);
    
    // 带结果处理器的查询（流式处理大结果集）
    void select(String statement, Object parameter, ResultHandler handler);
    
    // 插入/更新/删除
    int insert(String statement);
    int insert(String statement, Object parameter);
    int update(String statement, Object parameter);
    int delete(String statement, Object parameter);
    
    // 事务控制
    void commit();
    void commit(boolean force);
    void rollback();
    void rollback(boolean force);
    
    // 获取 Mapper 代理对象
    <T> T getMapper(Class<T> type);
    
    // 获取底层连接
    Connection getConnection();
    
    // 清除一级缓存
    void clearCache();
    
    // 关闭（归还连接到连接池）
    void close();
}
```

### 1.2 SqlSession 的生命周期——最容易犯错的地方

`SqlSession` 是**非线程安全**的，原因很直接：它持有一个数据库连接，多个线程共享同一个 `SqlSession` 会导致连接竞争，事务状态混乱，一级缓存脏读。

> [!warning] SqlSession 的线程安全红线
> **绝对不能将 `SqlSession` 作为类的成员变量（单例）使用！** 每个方法（或每个 HTTP 请求）应该独立打开和关闭一个 `SqlSession`。
>
> 错误示例（Spring 项目中极少见但会出现在遗留代码）：
> ```java
> @Service
> public class UserService {
>     // ❌ 错误！SqlSession 作为单例成员变量
>     private final SqlSession sqlSession;
>     
>     public UserService(SqlSessionFactory factory) {
>         // SqlSession 在构造函数中创建一次，被所有线程共享
>         this.sqlSession = factory.openSession();
>     }
> }
> ```
>
> 在 Spring 集成中，Mybatis 通过 `SqlSessionTemplate`（线程安全的代理）解决了这个问题——它内部通过 `TransactionSynchronizationManager` 将 `SqlSession` 绑定到当前线程，保证每个线程看到的是自己的 `SqlSession`。

**正确的生命周期管理**：

```java
// 标准使用模式（非 Spring 环境）
try (SqlSession session = sqlSessionFactory.openSession()) {
    UserMapper mapper = session.getMapper(UserMapper.class);
    User user = mapper.selectById(1L);
    session.commit();  // 如果有写操作
}  // try-with-resources 自动调用 close()，归还连接到连接池
```

### 1.3 DefaultSqlSession：SqlSession 的唯一实现

`DefaultSqlSession` 是 `SqlSession` 的唯一内置实现。它的结构非常简洁：

```java
public class DefaultSqlSession implements SqlSession {
    private final Configuration configuration;
    private final Executor executor;     // 真正执行 SQL 的引擎
    private final boolean autoCommit;    // 是否自动提交（openSession(true) 传入）
    private boolean dirty;              // 是否有未提交的写操作
    private List<Cursor<?>> cursorList;  // 持有的游标列表（关闭时需要关闭）
    
    // 所有 select/insert/update/delete 方法，最终都委托给 executor
    public <E> List<E> selectList(String statement, Object parameter, RowBounds rowBounds) {
        MappedStatement ms = configuration.getMappedStatement(statement);
        // wrapCollection：如果参数是 List 或数组，包装为 Map（key: "list" 或 "array"）
        // 这就是为什么 <foreach collection="list"> 能工作的原因
        return executor.query(ms, wrapCollection(parameter), rowBounds, Executor.NO_RESULT_HANDLER);
    }
    
    public int update(String statement, Object parameter) {
        MappedStatement ms = configuration.getMappedStatement(statement);
        dirty = !ms.isFlushCacheRequired();  // 写操作标记 dirty
        return executor.update(ms, wrapCollection(parameter));
    }
    
    public void commit(boolean force) {
        executor.commit(isCommitOrRollbackRequired(force));
        dirty = false;
    }
    
    public void close() {
        try {
            executor.close(isRollbackRequired());  // 关闭前判断是否需要回滚
            closeCursors();
        } finally {
            ErrorContext.instance().reset();
        }
    }
    
    // 判断是否需要提交/回滚（force=true 时强制执行）
    private boolean isCommitOrRollbackRequired(boolean force) {
        return (!autoCommit && dirty) || force;
    }
}
```

`DefaultSqlSession` 的核心价值是**参数封装**（`wrapCollection`）和**事务状态管理**（`dirty` 标记）。真正的执行逻辑全在 `Executor` 中。

---

## 第 2 章 Executor 体系：三种基础引擎

### 2.1 Executor 的接口设计

`Executor` 接口定义了 SQL 执行的标准契约：

```java
public interface Executor {
    ResultHandler NO_RESULT_HANDLER = null;
    
    // 写操作（INSERT/UPDATE/DELETE）
    int update(MappedStatement ms, Object parameter) throws SQLException;
    
    // 查询（带缓存 key）
    <E> List<E> query(MappedStatement ms, Object parameter, RowBounds rowBounds,
                      ResultHandler resultHandler, CacheKey key, BoundSql boundSql) throws SQLException;
    
    // 查询（由实现自动生成缓存 key）
    <E> List<E> query(MappedStatement ms, Object parameter, RowBounds rowBounds,
                      ResultHandler resultHandler) throws SQLException;
    
    // 游标查询（流式处理，不一次性加载到内存）
    <E> Cursor<E> queryCursor(MappedStatement ms, Object parameter, RowBounds rowBounds) throws SQLException;
    
    // 批量刷新（BatchExecutor 专用）
    List<BatchResult> flushStatements() throws SQLException;
    
    // 事务提交（force=true 时即使没有写操作也提交）
    void commit(boolean required) throws SQLException;
    
    // 事务回滚
    void rollback(boolean required) throws SQLException;
    
    // 创建缓存 key
    CacheKey createCacheKey(MappedStatement ms, Object parameterObject, 
                            RowBounds rowBounds, BoundSql boundSql);
    
    // 关闭 Executor
    void close(boolean forceRollback);
    
    // 是否延迟加载
    boolean isCached(MappedStatement ms, CacheKey key);
    
    // 清空一级缓存
    void clearLocalCache();
    
    // 延迟加载（嵌套查询用）
    void deferLoad(MappedStatement ms, MetaObject resultObject, String property, 
                   CacheKey key, Class<?> targetType);
    
    Transaction getTransaction();
    boolean isClosed();
}
```

### 2.2 BaseExecutor：模板方法模式的典范

`BaseExecutor` 是三种基础 Executor 的公共抽象父类，使用了[[模板方法模式]]：将一级缓存查询、延迟加载处理等**通用逻辑**放在 `BaseExecutor` 中，将真正与 JDBC 交互的**具体逻辑**抽象为 `doUpdate()`、`doQuery()` 等模板方法，由子类实现：

```java
public abstract class BaseExecutor implements Executor {
    // 一级缓存（SqlSession 级，本质是 HashMap）
    protected PerpetualCache localCache;
    // 存储过程输出参数的缓存
    protected PerpetualCache localOutputParameterCache;
    protected Configuration configuration;
    protected Transaction transaction;
    
    // 模板方法：query 的公共流程
    public <E> List<E> query(MappedStatement ms, Object parameter, RowBounds rowBounds,
                              ResultHandler resultHandler, CacheKey key, BoundSql boundSql) {
        // 一级缓存查询
        List<E> list = resultHandler == null ? (List<E>) localCache.getObject(key) : null;
        if (list != null) {
            // 命中一级缓存：处理存储过程 OUT 参数
            handleLocallyCachedOutputParameters(ms, key, parameter, boundSql);
        } else {
            // 未命中：查询数据库
            list = queryFromDatabase(ms, parameter, rowBounds, resultHandler, key, boundSql);
        }
        return list;
    }
    
    private <E> List<E> queryFromDatabase(...) {
        // 先在缓存中放一个占位符（防止递归查询的无限循环）
        localCache.putObject(key, EXECUTION_PLACEHOLDER);
        try {
            // 调用子类的 doQuery() 真正执行 SQL
            list = doQuery(ms, parameter, rowBounds, resultHandler, boundSql);
        } finally {
            localCache.removeObject(key);  // 移除占位符
        }
        // 将结果写入一级缓存
        localCache.putObject(key, list);
        return list;
    }
    
    // 抽象模板方法：子类实现具体的 JDBC 操作
    protected abstract int doUpdate(MappedStatement ms, Object parameter) throws SQLException;
    protected abstract <E> List<E> doQuery(MappedStatement ms, Object parameter,
        RowBounds rowBounds, ResultHandler resultHandler, BoundSql boundSql) throws SQLException;
    protected abstract <E> Cursor<E> doQueryCursor(MappedStatement ms, Object parameter,
        RowBounds rowBounds, BoundSql boundSql) throws SQLException;
    protected abstract List<BatchResult> doFlushStatements(boolean isRollback) throws SQLException;
}
```

这种模板方法的设计让三个子类只需要关注"如何调用 JDBC"，不需要关心缓存管理、延迟加载等横切逻辑。

---

## 第 3 章 SimpleExecutor：最简单也最通用

### 3.1 SimpleExecutor 的工作机制

`SimpleExecutor` 是 Mybatis 的默认 `Executor`。它的核心特点是：**每次执行 SQL 都新建一个 `Statement`（或 `PreparedStatement`），执行完毕后立即关闭**。

```java
public class SimpleExecutor extends BaseExecutor {
    
    public int doUpdate(MappedStatement ms, Object parameter) throws SQLException {
        Statement stmt = null;
        try {
            Configuration configuration = ms.getConfiguration();
            // 创建 StatementHandler（根据 statementType 选择 PreparedStatementHandler 等）
            StatementHandler handler = configuration.newStatementHandler(
                this, ms, parameter, RowBounds.DEFAULT, null, null);
            // 从连接池获取连接，prepareStatement 编译 SQL
            stmt = prepareStatement(handler, ms.getStatementLog());
            // 执行 SQL
            return handler.update(stmt);
        } finally {
            // 立即关闭 Statement（注意：不是关闭连接）
            closeStatement(stmt);
        }
    }
    
    public <E> List<E> doQuery(MappedStatement ms, Object parameter, RowBounds rowBounds,
                                ResultHandler resultHandler, BoundSql boundSql) throws SQLException {
        Statement stmt = null;
        try {
            Configuration configuration = ms.getConfiguration();
            StatementHandler handler = configuration.newStatementHandler(
                wrapper, ms, parameter, rowBounds, resultHandler, boundSql);
            stmt = prepareStatement(handler, ms.getStatementLog());
            // 执行查询并返回映射后的结果
            return handler.query(stmt, resultHandler);
        } finally {
            closeStatement(stmt);  // 每次都关闭
        }
    }
}
```

**`SimpleExecutor` 的优势**：实现最简单，逻辑最清晰，无状态，适合绝大多数场景。

**`SimpleExecutor` 的代价**：对于同一个 `SqlSession` 内重复执行的相同 SQL，每次都会重新 `prepareStatement()`（向数据库发送 SQL 编译请求）。在批量查询场景（如循环查询）中，这会产生大量重复的 `prepare` 请求。

---

## 第 4 章 ReuseExecutor：Statement 复用

### 4.1 复用的代价与收益

数据库的 `PreparedStatement` 编译（parse + optimize + compile SQL）是有成本的，在同一个 `SqlSession` 内，如果反复执行相同的 SQL（参数不同，但 SQL 模板相同），重复编译是不必要的浪费。

`ReuseExecutor` 通过**在 `SqlSession` 范围内缓存已编译的 `Statement`** 来避免这种重复编译：

```java
public class ReuseExecutor extends BaseExecutor {
    // key: SQL 字符串（完整 SQL，含 ? 占位符）
    // value: 已编译的 PreparedStatement
    private final Map<String, Statement> statementMap = new HashMap<>();
    
    public int doUpdate(MappedStatement ms, Object parameter) throws SQLException {
        Configuration configuration = ms.getConfiguration();
        StatementHandler handler = configuration.newStatementHandler(
            this, ms, parameter, RowBounds.DEFAULT, null, null);
        Statement stmt = prepareStatement(handler, ms.getStatementLog());
        return handler.update(stmt);
        // 注意：这里没有 closeStatement(stmt)！Statement 被保留在 statementMap 中
    }
    
    // 重写 prepareStatement：优先从缓存中获取
    private Statement prepareStatement(StatementHandler handler, Log statementLog) throws SQLException {
        Statement stmt;
        BoundSql boundSql = handler.getBoundSql();
        String sql = boundSql.getSql();
        
        if (hasStatementFor(sql)) {
            // 缓存命中：复用已编译的 Statement
            stmt = getStatement(sql);
            applyTransactionTimeout(stmt);  // 设置事务超时
        } else {
            // 缓存未命中：创建新的 Statement 并缓存
            Connection connection = getConnection(statementLog);
            stmt = handler.prepare(connection, transaction.getTimeout());
            putStatement(sql, stmt);  // 放入缓存
        }
        // 每次都重新绑定参数（SQL 模板相同，但参数值可能不同）
        handler.parameterize(stmt);
        return stmt;
    }
    
    // SqlSession 关闭时，清理所有缓存的 Statement
    public List<BatchResult> doFlushStatements(boolean isRollback) {
        for (Statement stmt : statementMap.values()) {
            closeStatement(stmt);  // 逐一关闭
        }
        statementMap.clear();
        return Collections.emptyList();
    }
}
```

> [!info] ReuseExecutor 的适用场景
> `ReuseExecutor` 在以下场景有明显收益：
> - 同一个 `SqlSession` 内，相同 SQL 被多次执行（如循环中的单条查询）；
> - 数据库端 SQL 编译开销较高的场景（如 Oracle 的存储过程调用）。
>
> **注意**：Mybatis 与 Spring 整合时，默认每次数据库操作都在独立的 `SqlSession` 中执行（`SqlSessionTemplate` 的默认行为），此时 `ReuseExecutor` 的缓存在每次操作后即被销毁，几乎没有收益。只有在手动控制 `SqlSession` 生命周期的场景（如批量操作时手动 `openSession()`），`ReuseExecutor` 的复用效果才能体现。

---

## 第 5 章 BatchExecutor：批量操作的性能利器

### 5.1 批量操作的性能瓶颈

考虑一个场景：需要插入 10,000 条订单记录。最直觉的写法：

```java
// 反模式：循环单条插入
for (Order order : orders) {
    orderMapper.insert(order);  // 每次都是一次 JDBC roundtrip
}
```

这段代码的性能问题非常严重：
- **网络开销**：每次 `insert` 都需要一次客户端→数据库的网络往返（RTT）；即使内网 RTT 仅 1ms，10,000 次就是 10 秒；
- **事务日志**：每条 INSERT 都单独写 redo log、binlog，I/O 放大严重；
- **行锁竞争**：10,000 次独立的行锁获取/释放，在高并发下竞争激烈。

JDBC 的 `addBatch()`/`executeBatch()` 机制专门解决这个问题：将多条 SQL 放在一个批次中，一次网络往返发送给数据库，数据库批量执行：

```java
PreparedStatement ps = conn.prepareStatement("INSERT INTO orders VALUES (?, ?, ?)");
for (Order order : orders) {
    ps.setLong(1, order.getId());
    ps.setString(2, order.getStatus());
    ps.setTimestamp(3, ...);
    ps.addBatch();  // 添加到批次，不立即发送
}
ps.executeBatch();  // 一次性发送所有批次到数据库
```

### 5.2 BatchExecutor 的实现原理

`BatchExecutor` 就是在 Mybatis 层封装了 JDBC 的 `addBatch()`/`executeBatch()` 机制：

```java
public class BatchExecutor extends BaseExecutor {
    public static final int BATCH_UPDATE_RETURN_VALUE = Integer.MIN_VALUE + 1002;
    
    // 当前所有待执行的批量 Statement（每个不同 SQL 对应一个）
    private final List<Statement> statementList = new ArrayList<>();
    // 每个 Statement 对应的批量执行结果（executeBatch 返回 int[]）
    private final List<BatchResult> batchResultList = new ArrayList<>();
    // 上一次执行的 SQL（用于判断是否可以复用当前 Statement）
    private String currentSql;
    // 上一次使用的 MappedStatement
    private MappedStatement currentStatement;
    
    public int doUpdate(MappedStatement ms, Object parameter) throws SQLException {
        final Configuration configuration = ms.getConfiguration();
        final StatementHandler handler = configuration.newStatementHandler(
            this, ms, parameter, RowBounds.DEFAULT, null, null);
        final BoundSql boundSql = handler.getBoundSql();
        final String sql = boundSql.getSql();
        Statement stmt;
        
        // 判断是否可以复用上一个 Statement
        if (sql.equals(currentSql) && ms.equals(currentStatement)) {
            // 同一 SQL + 同一 MappedStatement：复用已有 Statement
            int last = statementList.size() - 1;
            stmt = statementList.get(last);
            applyTransactionTimeout(stmt);
            handler.parameterize(stmt);  // 绑定新的参数值
            BatchResult batchResult = batchResultList.get(last);
            batchResult.addParameterObject(parameter);  // 记录本次参数（用于 flushStatements 后的返回值）
        } else {
            // 不同 SQL：创建新的 Statement
            Connection connection = getConnection(ms.getStatementLog());
            stmt = handler.prepare(connection, transaction.getTimeout());
            handler.parameterize(stmt);
            currentSql = sql;
            currentStatement = ms;
            statementList.add(stmt);
            batchResultList.add(new BatchResult(ms, sql, parameter));
        }
        // 关键：addBatch() 而非 execute()！SQL 被暂存在 Statement 的批次队列中
        handler.batch(stmt);
        // 返回特殊值 BATCH_UPDATE_RETURN_VALUE，表示"批量模式，结果尚不可知"
        return BATCH_UPDATE_RETURN_VALUE;
    }
    
    // 真正执行批次——调用 executeBatch()
    public List<BatchResult> doFlushStatements(boolean isRollback) throws SQLException {
        try {
            List<BatchResult> results = new ArrayList<>();
            if (isRollback) {
                return Collections.emptyList();
            }
            for (int i = 0; i < statementList.size(); i++) {
                Statement stmt = statementList.get(i);
                BatchResult batchResult = batchResultList.get(i);
                try {
                    // 批量执行，返回每条 SQL 的影响行数
                    batchResult.setUpdateCounts(stmt.executeBatch());
                    // ... 处理自动生成的主键
                } catch (BatchUpdateException e) {
                    // BatchUpdateException 包含已执行部分的影响行数（getUpdateCounts()）
                    throw new BatchExecutorException("...", e, results, batchResult);
                }
                results.add(batchResult);
            }
            return results;
        } finally {
            // 清理所有 Statement
            for (Statement stmt : statementList) {
                closeStatement(stmt);
            }
            currentSql = null;
            statementList.clear();
            batchResultList.clear();
        }
    }
}
```

### 5.3 BatchExecutor 的正确使用姿势

```java
// 正确用法：显式指定 ExecutorType.BATCH
try (SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH)) {
    OrderMapper mapper = session.getMapper(OrderMapper.class);
    
    for (int i = 0; i < 10000; i++) {
        mapper.insert(new Order(i, "PENDING", BigDecimal.TEN));
        
        // 每 500 条刷新一次（避免内存中积累太多 Statement 参数）
        if (i % 500 == 0) {
            session.flushStatements();  // 触发 executeBatch()，发送到数据库
            session.clearCache();       // 清理一级缓存，释放内存
        }
    }
    
    session.flushStatements();  // 刷新剩余批次
    session.commit();
}
```

> [!warning] BatchExecutor 的三大陷阱
>
> **陷阱一：flushStatements 时机**
> `doUpdate()` 返回的是 `BATCH_UPDATE_RETURN_VALUE`（一个特殊的负数），不是真实的影响行数。必须调用 `session.flushStatements()` 触发 `executeBatch()` 之后，才能获得真实的执行结果。如果只 `insert` 不 `flushStatements`，直接 `commit`，Mybatis 会在 `commit` 时自动调用 `flushStatements`，但如果中间有查询操作需要看到刚插入的数据，就必须手动 `flushStatements`。
>
> **陷阱二：批次边界**
> `BatchExecutor` 对相邻的相同 SQL 进行批次复用。如果插入 A 表和 B 表交替进行（A、B、A、B…），每次都会创建新的 Statement，批次优化完全失效。应该先批量插入 A 表，再批量插入 B 表。
>
> **陷阱三：与 Spring 的整合**
> 在 Spring 环境中，使用 `@Autowired` 注入的 `SqlSessionTemplate` 默认使用 `ExecutorType.SIMPLE`。若要使用批量 Executor，需要创建专用的 `SqlSessionTemplate`：
> ```java
> @Bean
> public SqlSessionTemplate batchSqlSessionTemplate(SqlSessionFactory factory) {
>     return new SqlSessionTemplate(factory, ExecutorType.BATCH);
> }
> ```

---

## 第 6 章 CachingExecutor：装饰器与二级缓存

### 6.1 装饰器模式的教科书实现

当 `cacheEnabled=true`（Mybatis 默认值），`SqlSessionFactory` 在创建 `Executor` 时会用 `CachingExecutor` 包装基础 Executor：

```java
// Configuration.newExecutor() 的核心逻辑
public Executor newExecutor(Transaction transaction, ExecutorType executorType) {
    executorType = executorType == null ? defaultExecutorType : executorType;
    Executor executor;
    if (ExecutorType.BATCH == executorType) {
        executor = new BatchExecutor(this, transaction);
    } else if (ExecutorType.REUSE == executorType) {
        executor = new ReuseExecutor(this, transaction);
    } else {
        executor = new SimpleExecutor(this, transaction);
    }
    // 如果启用了缓存，用 CachingExecutor 装饰
    if (cacheEnabled) {
        executor = new CachingExecutor(executor);
    }
    // 应用所有插件（同样是装饰器链）
    executor = (Executor) interceptorChain.pluginAll(executor);
    return executor;
}
```

`CachingExecutor` 持有被装饰的基础 Executor（`delegate`），在查询时先检查二级缓存，未命中时再委托给 `delegate` 执行：

```java
public class CachingExecutor implements Executor {
    private final Executor delegate;              // 被装饰的基础 Executor
    private final TransactionalCacheManager tcm; // 事务性缓存管理器
    
    public <E> List<E> query(MappedStatement ms, Object parameterObject,
                              RowBounds rowBounds, ResultHandler resultHandler,
                              CacheKey key, BoundSql boundSql) throws SQLException {
        Cache cache = ms.getCache();  // 该 Mapper namespace 配置的二级缓存
        
        if (cache != null) {
            // 如果是写操作语句配置了 flushCache=true，先清缓存
            flushCacheIfRequired(ms);
            
            if (ms.isUseCache() && resultHandler == null) {
                ensureNoOutParams(ms, boundSql);  // 存储过程 OUT 参数不支持缓存
                
                // 从 TransactionalCache 读取（事务提交前，写入的是暂存区）
                List<E> list = (List<E>) tcm.getObject(cache, key);
                if (list == null) {
                    // 二级缓存未命中：委托给基础 Executor（会查一级缓存或数据库）
                    list = delegate.query(ms, parameterObject, rowBounds, resultHandler, key, boundSql);
                    // 写入 TransactionalCache 的暂存区（事务提交时才真正写入）
                    tcm.putObject(cache, key, list);
                }
                return list;
            }
        }
        // 没有配置二级缓存
        return delegate.query(ms, parameterObject, rowBounds, resultHandler, key, boundSql);
    }
    
    public void commit(boolean required) throws SQLException {
        delegate.commit(required);
        // 事务提交时，将 TransactionalCache 暂存区的数据真正写入二级缓存
        tcm.commit();
    }
    
    public void rollback(boolean required) throws SQLException {
        try {
            delegate.rollback(required);
        } finally {
            if (required) {
                // 事务回滚时，丢弃暂存区的数据（不写入二级缓存）
                tcm.rollback();
            }
        }
    }
}
```

### 6.2 TransactionalCache：为什么二级缓存需要事务性

一个看似奇怪的问题：既然查询结果已经从数据库取出了，为什么不直接写入二级缓存，而要先放到暂存区等待事务提交？

原因在于**事务可见性**。考虑以下场景：

```
事务 A：
  1. 插入一条 User(id=100, name="Alice")
  2. 查询 User(id=100) → 从数据库取出，写入二级缓存暂存区
  3. ← 此处事务 A 还未提交

事务 B：
  4. 查询 User(id=100)
     如果步骤 2 已写入二级缓存：B 会读到"提交前的数据"
     但事务 A 随时可能回滚！这就是缓存脏读。
```

`TransactionalCache` 通过"提交前只写暂存区"的设计，保证了：**只有事务提交后，数据才进入二级缓存供其他 `SqlSession` 读取**。这与数据库的"读已提交"（Read Committed）隔离级别在语义上一致。

---

## 第 7 章 一级缓存的深层机制

### 7.1 一级缓存的命中条件

一级缓存（`localCache`）是 `PerpetualCache`，本质是 `HashMap<CacheKey, Object>`。两次查询能命中同一缓存条目，需要生成相同的 `CacheKey`。

`CacheKey` 由以下因素决定（通过 `BaseExecutor.createCacheKey()` 计算）：

```java
public CacheKey createCacheKey(MappedStatement ms, Object parameterObject,
                                RowBounds rowBounds, BoundSql boundSql) {
    CacheKey cacheKey = new CacheKey();
    // 1. MappedStatement 的 ID（如 com.example.UserMapper.selectById）
    cacheKey.update(ms.getId());
    // 2. RowBounds 的 offset（分页偏移，默认 0）
    cacheKey.update(rowBounds.getOffset());
    // 3. RowBounds 的 limit（分页大小，默认 Integer.MAX_VALUE）
    cacheKey.update(rowBounds.getLimit());
    // 4. 最终 SQL 字符串（含 ? 占位符）
    cacheKey.update(boundSql.getSql());
    // 5. 所有参数值（依次放入）
    for (ParameterMapping parameterMapping : boundSql.getParameterMappings()) {
        // 提取每个参数的值并放入 CacheKey
        ...
        cacheKey.update(value);
    }
    // 6. 数据库 URL（区分多数据源场景）
    if (configuration.getEnvironment() != null) {
        cacheKey.update(configuration.getEnvironment().getId());
    }
    return cacheKey;
}
```

**命中条件归纳**：同一 `SqlSession` 内，**statementId + SQL + 参数值 + 分页参数 + 环境 ID** 完全相同，才能命中一级缓存。其中任何一个因素不同，就是不同的缓存条目。

### 7.2 一级缓存的四种失效场景

一级缓存会在以下情况被清除：

**场景一：执行 INSERT/UPDATE/DELETE**

任何写操作都会调用 `BaseExecutor.update()`，其中有一行：
```java
clearLocalCache();  // 清空整个一级缓存
```
这是一个重要的设计决策——**任何写操作都会使整个一级缓存失效**，而不只是失效与被修改数据相关的缓存条目。原因：Mybatis 没有足够的信息判断一次写操作影响了哪些查询的结果，保守清空是最安全的做法。

**场景二：手动调用 `session.clearCache()`**

直接清空 `localCache`，场景：在批量插入中间需要清理内存时。

**场景三：`SqlSession` 关闭**

`SqlSession.close()` → `Executor.close()` → `localCache` 被销毁。一级缓存是 `SqlSession` 级的，`SqlSession` 结束后缓存不复存在。

**场景四：MappedStatement 配置了 `flushCache=true`**

对于查询语句（SELECT），如果在 XML 中配置了 `flushCache="true"`，每次执行都会先清空一级缓存再查询：
```xml
<select id="selectById" flushCache="true" resultType="User">
    SELECT * FROM users WHERE id = #{id}
</select>
```

### 7.3 一级缓存在 Spring 中的"消失之谜"

很多 Spring + Mybatis 的开发者发现：**一级缓存似乎不起作用**——同一个方法内连续两次调用相同的查询，第二次仍然走数据库。

原因：在 Spring 的声明式事务中，Mybatis 的 `SqlSession` 生命周期与 Spring 事务绑定：

- 在 **有事务** 的方法中（`@Transactional`），整个方法共享同一个 `SqlSession`，一级缓存正常工作；
- 在 **无事务** 的方法中，`SqlSessionTemplate` 的 `SqlSessionInterceptor` 会在**每次 Mapper 方法调用后**关闭 `SqlSession`，下一次调用重新创建新的 `SqlSession`——一级缓存随 `SqlSession` 一起被销毁，表现为每次都查数据库。

```java
// SqlSessionInterceptor 的关键逻辑（SqlSessionTemplate 的内部类）
private class SqlSessionInterceptor implements InvocationHandler {
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        SqlSession sqlSession = getSqlSession(SqlSessionTemplate.this.sqlSessionFactory,
            SqlSessionTemplate.this.executorType, SqlSessionTemplate.this.exceptionTranslator);
        try {
            Object result = method.invoke(sqlSession, args);
            // 如果当前不在 Spring 事务中（不在 TransactionSynchronizationManager 管理的 SqlSession 里）
            if (!isSqlSessionTransactional(sqlSession, SqlSessionTemplate.this.sqlSessionFactory)) {
                sqlSession.commit(true);  // 强制提交（非事务模式）
            }
            return result;
        } finally {
            if (sqlSession != null) {
                // 关闭 SqlSession（非事务模式下每次方法调用都关闭！）
                closeSqlSession(sqlSession, SqlSessionTemplate.this.sqlSessionFactory);
            }
        }
    }
}
```

这就是为什么在 Spring 环境中，如果要让一级缓存生效，必须在 `@Transactional` 事务方法内：

```java
@Service
public class UserService {
    
    // 没有 @Transactional：每次查询都是新 SqlSession，一级缓存无效
    public void noTransactionDemo() {
        User u1 = userMapper.selectById(1L);  // 查数据库
        User u2 = userMapper.selectById(1L);  // 再查数据库（新 SqlSession）
    }
    
    // 有 @Transactional：共享 SqlSession，一级缓存生效
    @Transactional
    public void withTransactionDemo() {
        User u1 = userMapper.selectById(1L);  // 查数据库，写入一级缓存
        User u2 = userMapper.selectById(1L);  // 命中一级缓存，不查数据库
        // u1 == u2（同一个对象引用）
    }
}
```

---

## 第 8 章 Executor 的选择策略

在实际项目中，如何选择合适的 Executor？

| 场景 | 推荐 Executor | 理由 |
| --- | --- | --- |
| 常规 CRUD（Spring 环境） | `SIMPLE`（默认） | Spring 每次请求独立 SqlSession，复用没有意义；SIMPLE 最简单可靠 |
| 批量插入/更新（万级数据） | `BATCH` | 减少 JDBC roundtrip，性能提升 10-100 倍 |
| 同一 SqlSession 内大量重复相同 SQL | `REUSE` | 避免重复编译 SQL，节省数据库 parse 开销 |
| 需要严格禁用二级缓存 | 任意 + `cacheEnabled=false` | 全局关闭二级缓存（二级缓存有脏读风险，有些场景需要禁用） |

---

## 总结

`SqlSession` 和 `Executor` 构成了 Mybatis 执行层的两个核心抽象：

- **`SqlSession`** 是应用代码的统一入口（门面模式），封装了参数处理和事务状态，但本身不执行 SQL——所有操作委托给 `Executor`；
- **三种基础 Executor**：`SimpleExecutor`（每次新建 Statement，默认）、`ReuseExecutor`（同一 SqlSession 内复用 Statement）、`BatchExecutor`（JDBC `addBatch`/`executeBatch`，批量场景的性能利器）；
- **`CachingExecutor`** 是装饰器，包装基础 Executor 实现二级缓存；通过 `TransactionalCache` 的暂存区机制，保证事务提交前的数据不污染缓存（避免脏读）；
- **一级缓存**（`PerpetualCache`）的命中条件是 statementId + SQL + 参数 + 分页 + 环境 ID 全部相同；在 Spring 环境中，无事务方法每次请求后 SqlSession 被关闭，一级缓存随之失效——这是很多开发者踩到的经典陷阱；
- **`BatchExecutor` 的正确姿势**：分批调用 `flushStatements()`，同类 SQL 集中执行（避免批次边界切换），Spring 环境需创建专用 `SqlSessionTemplate`。

下一篇，我们深入动态 SQL 的核心——OGNL 表达式引擎与 `SqlNode` 解析树，揭开 `<if>`/`<foreach>`/`<choose>` 背后的工作原理：[[03 动态SQL——OGNL表达式与SqlNode解析树]]。

---

> [!note] 参考资料
> - `org.apache.ibatis.executor.BaseExecutor` 源码
> - `org.apache.ibatis.executor.BatchExecutor` 源码
> - `org.apache.ibatis.executor.CachingExecutor` 源码
> - `org.apache.ibatis.cache.TransactionalCacheManager` 源码
