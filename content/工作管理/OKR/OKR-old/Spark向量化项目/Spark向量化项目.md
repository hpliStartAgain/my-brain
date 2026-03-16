## 1. 项目背景与痛点分析 (Background & Pain Points)

随着 Spark 向量化引擎（Gluten + Velox/Clickhouse）的引入，虽然计算性能潜力巨大，但“盲目开启”带来了严重的稳定性问题。**痛点维度**：

- **盲目启用导致的性能回退**：部分作业含有不支持的算子（如复杂 UDF、特定 Window），导致执行计划中出现高频的 `Row-to-Columnar` 数据格式转换（俗称“三明治”结构），性能反而不如原生 Spark。
    
- **内存模型不匹配 (OOM)**：Vanilla Spark 强依赖 On-Heap 内存，而 Gluten 强依赖 Off-Heap。直接复用原参数会导致堆外内存不足，引发 Container OOM。
    
- **缺乏反馈闭环**：作业开启 Gluten 后是快了还是慢了，缺乏自动化的对比评估，SRE 无法量化收益，且手动维护白名单效率低下。
    

## 2. 核心目标 (Objectives)

构建 **GSS (Gluten Suitability Score)** 评分模型与自动化参数注入系统，实现“良币驱逐劣币”。

- **量化评估 (Scoring)**：基于历史 EventLog 画像，精准计算作业对向量化执行的契合度（GSS 分数）。
    
- **自动内存重配 (Auto-Rebalance)**：在注入 Gluten 配置时，自动拦截并重写内存参数（Heap 转 Off-Heap），消除内存模型差异。
    
- **稳定性保障 (Stability)**：建立“失败自动熔断”与“黑名单”机制，确保生产环境零事故。
    
- **降本增效 (Efficiency)**：覆盖集群 **30%** 核心作业，平均 CPU 消耗降低 **20%**，执行时长缩短 **15%**。
    

## 3. 技术亮点 (Technical Highlights)

- **GSS 评分模型 (Gluten Suitability Score)**：
    
    - **一票否决**：检测到 `Scan -> Row -> Join -> Col` 这种高危“三明治”结构，直接 -100 分。
        
    - **格式感知**：Parquet/ORC (+20分) vs Text/CSV (-20分)。
        
    - **UDF 识别**：识别 Hive UDF (-30分) 与 Pandas UDF (0分) 的差异。
        
- **智能内存投影 (Memory Projection)**：
    
    - 建立数学转换模型，保持 `Total Container Memory` 不变。
        
    - 自动执行：`Target_OffHeap = Total * 60%`，`Target_Heap = Total * 40%`（比例可配）。
        
- **T+1 画像与 T+0 决策结合**：
    
    - 离线工厂解析 Spark EventLog 提取 Metrics。
        
    - 在线 API Gateway 基于 Redis 缓存实现毫秒级参数下发。
        

## 4. 实施路径与排期 (Roadmap)

**Phase 1: 数据底座构建 (Weeks 1-4)**

- **[1.30] 基础设施就绪**：完成 Spark EventLog 解析器开发，提取 `SparkPlanInfo`（算子结构）与 `ExecutorMetrics`（峰值内存）。
    
- **[3.14] 画像表设计**：构建 `app_gluten_profile` 表，包含 InputFormat, FallbackCount, CPU密集度等字段。
    

**Phase 2: 决策 API 与算法 (Weeks 5-8)**

- **[3.28] GSS 算法实现**：完成评分逻辑开发（Redis 预热），产出 Top 100 适合 Gluten 的白名单作业。
    
- **[4.13] 动态内存重写**：在 API Gateway 实现内存参数转换逻辑（On-Heap -> Off-Heap）。
    

**Phase 3: 稳定性与闭环 (Weeks 9-12)**

- **[4.30] 自动化决策上线**：上线配置服务，对 GSS > 80 分的作业开启 Gluten。
    
- **[5.15] 熔断机制**：实现 Failure Monitor，监听 YARN OOM 事件，自动将失败作业加入黑名单 (TTL 7天)。
    

**Phase 4: 大规模推广 (Weeks 13+)**

- **[5.30] 全量推广与看板**：扩大灰度范围至 50%，上线 Grafana 收益看板（CPU 节省核数、覆盖率）。
    

---

## 5. 系统架构图

![[Pasted image 20260316155622.png]]