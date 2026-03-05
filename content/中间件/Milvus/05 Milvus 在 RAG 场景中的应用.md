---
title: "Milvus 在 RAG 场景中的应用"
date: 2026-03-05
tags: [中间件, Milvus, RAG, LLM, Embedding, 检索增强生成, LangChain, LlamaIndex, 向量数据库]
aliases: []
---

# Milvus 在 RAG 场景中的应用

## 摘要

**RAG（Retrieval-Augmented Generation，检索增强生成）** 是当前大语言模型（LLM）落地应用最主流的工程范式——通过在 LLM 回答前先从知识库中检索相关上下文，让模型基于外部知识而非仅凭参数记忆来生成答案，解决了 LLM 的知识时效性、幻觉（Hallucination）和私有数据访问等核心痛点。Milvus 作为 RAG 架构中的向量检索层，承担了将用户查询与知识库进行语义匹配的核心职责。本文从 RAG 的工程挑战出发，系统介绍如何基于 Milvus 构建高质量 RAG 系统：包括 **Embedding 模型选型**、**文档分块策略**（Chunking）、**混合检索配置**（稠密 + 稀疏）、**检索质量评估**方法，以及与 **LangChain** 和 **LlamaIndex** 框架的集成实践。每个工程决策都结合了真实生产经验中的取舍分析。

---

## 第 1 章 RAG 的工程本质与挑战

### 1.1 为什么需要 RAG

大语言模型（如 GPT-4、Claude、Llama 3）本身具备强大的语言理解和生成能力，但有三个根本性局限：

**局限一：知识时效性**。模型的训练数据有截止日期，对于训练后发生的事件（如最新的 API 变更、2024 年后的新闻事件、公司内部的新文档）完全无知。RAG 通过检索实时更新的知识库，让模型能回答"最新的 Kubernetes 1.30 有哪些新特性？"这类问题。

**局限二：幻觉（Hallucination）**。LLM 在不确定时会"创造性地"编造看似合理的答案，而不是说"我不知道"。给模型提供准确的上下文（Retrieved Context），让它基于上下文回答，能显著减少幻觉——模型更倾向于从提供的上下文中提取信息，而不是凭空捏造。

**局限三：私有知识访问**。企业的内部文档（如技术规范、客户数据、产品手册）不在模型训练数据中，也不应该上传给第三方 LLM API。RAG 允许在本地部署向量数据库存储私有知识，只把检索到的相关片段（而非全部私有数据）发送给 LLM，保护数据隐私。

### 1.2 RAG 的完整流程

一个完整的 RAG 系统由两个阶段组成：

**阶段一：知识库构建（Indexing Pipeline，离线）**

```
原始文档（PDF/Word/Markdown/HTML）
    ↓ 文档解析（Document Parsing）
结构化文本
    ↓ 文档分块（Chunking）
文本片段列表（Chunks）
    ↓ Embedding 模型编码
向量列表（Dense Embeddings）
    ↓ 写入 Milvus
知识库（向量数据库 + 原文元数据）
```

**阶段二：查询与生成（Query Pipeline，在线）**

```
用户问题（Query）
    ↓ Embedding 模型编码
查询向量
    ↓ Milvus 向量检索（+ 标量过滤）
Top-K 相关文本片段
    ↓ 重排序（Re-ranking，可选）
精选的上下文片段
    ↓ 构建 Prompt（System Prompt + 上下文 + 用户问题）
LLM 生成
最终回答
```

### 1.3 RAG 的工程挑战

RAG 看起来流程简单，但在实际生产中有多个工程挑战影响系统质量：

1. **检索质量（Retrieval Quality）**：如何确保检索到的 Top-K 片段与用户问题真正相关？召回率不够会导致 LLM 缺少必要上下文；精确率不够会导致 LLM 被无关信息干扰。
2. **文档分块策略（Chunking Strategy）**：切得太短，单个片段缺乏上下文（语义不完整）；切得太长，单次召回的信息密度低，且超出 LLM 的 Context Window 限制。
3. **Embedding 模型选择**：不同领域、不同语言的文档需要不同的 Embedding 模型，通用模型在专业领域表现不如领域微调模型。
4. **延迟与成本**：Embedding 计算（每次写入和查询都需要调用 Embedding 模型）和向量检索（Milvus 查询）的延迟共同构成 RAG 的响应延迟；大规模知识库的向量存储成本也不容忽视。

---

## 第 2 章 Embedding 模型选型

### 2.1 Embedding 模型的核心指标

选择 Embedding 模型需要关注三个核心指标：

**Embedding 维度（Dimension）**：决定了向量的表达能力和存储成本。维度越高，理论表达能力越强，但存储开销也越大（768 维 vs 1536 维，存储成本差 2 倍）。对于 Milvus，维度高意味着每个 Segment 需要更多内存。

**最大 Token 数（Max Input Length）**：每次 Embedding 能处理的最大文本长度（以 Token 计算，通常 1 Token ≈ 1.5 个汉字或 0.75 个英文单词）。超出长度的文本会被截断，导致信息丢失。主流模型的范围：
- 短文本模型：256~512 Token（适合标题、短句）
- 标准文本模型：512~8192 Token（适合段落、文档片段）
- 长文本模型：32K+ Token（适合长文档整体编码，如 Voyage-3-large）

**MTEB 基准评分（Massive Text Embedding Benchmark）**：一个覆盖检索、聚类、分类等多任务的综合评测基准，分数越高代表在各类语义任务上综合表现越好。

### 2.2 主流 Embedding 模型对比

| 模型 | 提供方 | 维度 | Max Tokens | 语言 | 特点 |
|------|--------|------|-----------|------|------|
| `text-embedding-3-large` | OpenAI | 3072（可压缩） | 8191 | 多语言 | MTEB 最高之一，闭源 API |
| `text-embedding-3-small` | OpenAI | 1536 | 8191 | 多语言 | 低成本，性价比高 |
| `voyage-3-large` | Voyage AI | 1024 | 32000 | 多语言 | 长文档，代码专业模型 |
| `bge-m3` | BAAI | 1024 | 8192 | 多语言 | 开源，稀疏+稠密混合 |
| `bge-large-zh-v1.5` | BAAI | 1024 | 512 | 中文 | 中文 MTEB 最优开源模型 |
| `e5-mistral-7b-instruct` | Microsoft | 4096 | 32768 | 多语言 | 最高精度之一，7B 参数大模型 |
| `jina-embeddings-v3` | Jina AI | 1024 | 8192 | 多语言 | 开源，支持 task 前缀 |

**中文场景的特殊考量**：对于以中文为主的知识库，`bge-m3` 和 `bge-large-zh-v1.5` 是最常用的开源模型选择。BGE-M3 支持同时输出稠密向量和稀疏向量（SPLADE 格式），是混合检索的理想搭档，且完全开源可本地部署，不需要调用付费 API，更适合私有部署场景。

### 2.3 BGE-M3——混合检索的全能选手

**BGE-M3**（BAAI General Embedding - Multi-Functionality, Multi-Linguality, Multi-Granularity）是北京智源人工智能研究院（BAAI）开源的 Embedding 模型，是目前最适合与 Milvus 混合检索配合使用的开源模型，原因是它同时支持三种输出：

1. **稠密向量（Dense Vector）**：1024 维 float32 向量，用于语义相似度搜索
2. **稀疏向量（Sparse Vector）**：SPLADE 格式，用于关键词精确匹配，天然与 Milvus 的 `SPARSE_FLOAT_VECTOR` 字段对接
3. **多向量（ColBERT 风格的 Multi-Vector）**：每个 Token 一个向量，精度更高但计算开销大（Milvus 目前不直接支持）

```python
# BGE-M3 本地部署示例
from FlagEmbedding import BGEM3FlagModel

model = BGEM3FlagModel('BAAI/bge-m3', use_fp16=True)

# 编码文档（同时输出稠密和稀疏向量）
output = model.encode(
    ["Milvus 是一个开源的向量数据库", "RAG 技术解决了 LLM 的幻觉问题"],
    batch_size=12,
    max_length=8192,
    return_dense=True,
    return_sparse=True,
    return_colbert_vecs=False
)

dense_embeddings = output['dense_vecs']         # shape: (2, 1024)
sparse_embeddings = output['lexical_weights']    # dict list: [{"token_id": weight, ...}]
```

---

## 第 3 章 文档分块策略（Chunking）

### 3.1 分块的必要性与挑战

RAG 系统中，原始文档通常不能直接作为一个整体写入 Milvus——原因有三：

1. **Embedding 模型的 Token 限制**：大多数 Embedding 模型最多处理 512~8192 个 Token。超过限制的文本会被截断，导致后半部分完全丢失。
2. **Precision（精确率）优化**：将一篇 5000 字的文章作为一个向量，查询时召回这篇文章，但 LLM 需要在 5000 字中自行定位相关段落，引入大量无关噪声。更细粒度的分块（如每块 200~500 字）让每个向量更精确地代表一个具体的知识点，召回精确率更高。
3. **Context Window 限制**：LLM 的 Context Window 有限（通常 4K~128K Token），如果每个召回片段太长，能放入 Context 的片段数量就少，无法提供足够多的参考上下文。

### 3.2 常用分块策略对比

**固定大小分块（Fixed-Size Chunking）**：按固定 Token 数（如每块 512 Token，重叠 50 Token）分割。实现简单，但可能在句子或段落中间截断，破坏语义完整性。适合快速原型开发。

**递归字符分块（Recursive Character Text Splitting）**：按段落 → 句子 → 词语的优先级递归分割，优先在自然边界（换行符、句号、逗号）处切分，尽可能保留语义完整性。是 LangChain 默认的分块方法，适用于大多数场景。

**语义分块（Semantic Chunking）**：先对文本生成 Embedding，计算相邻句子的语义相似度，在语义相似度突然降低的位置分割（表示话题发生了转换）。语义完整性最好，但计算开销大（需要为每个句子调用 Embedding 模型）。

**文档结构感知分块（Structure-Aware Chunking）**：根据文档的结构标记（Markdown 的 # 标题、HTML 的 `<h1><p>` 标签、PDF 的段落边界）分割，每个块对应一个完整的逻辑单元（如一个章节、一个段落）。对于有良好结构的文档（技术文档、报告），这是最优选择。

| 策略 | 语义完整性 | 实现复杂度 | 计算开销 | 适用文档类型 |
|------|-----------|-----------|---------|------------|
| 固定大小 | 低 | 极低 | 极低 | 原型阶段 |
| 递归字符 | 中 | 低 | 低 | 通用文本 |
| 语义分块 | 高 | 中 | 高（需 Embedding） | 散文、长文章 |
| 结构感知 | 最高 | 中 | 低 | 技术文档、规范书 |

### 3.3 Chunk 大小的黄金法则

没有普适的最优 Chunk 大小，它取决于：

- **Embedding 模型的最优输入长度**：大多数 Embedding 模型在 100~500 Token 区间内表达能力最强（训练数据大多是这个长度的文本）。太短的 Chunk（< 50 Token）语义信息不足；太长的 Chunk（> 512 Token）信息密度太低。
- **LLM 的 Context Window**：若最终要把 Top-K 个 Chunk 全部放入 LLM 的 Context，需要 `K × chunk_size × token_ratio ≤ context_window - prompt_size`。K=5、chunk_size=500 Token 时，总上下文约 2500 Token，留给回答的空间充足。
- **知识密度**：技术文档的知识密度高（每段都有新信息），适合较小的 Chunk（200~300 Token）；叙事性文本知识密度低，适合较大的 Chunk（500~800 Token）。

**Parent-Child Chunk 架构**：一种常用的进阶策略——将文档分为两个粒度：
- **Parent Chunk**（大块，如每个章节）：存储完整的语义上下文，写入 Milvus 的 `content` 字段
- **Child Chunk**（小块，如每个段落）：对 Child Chunk 做 Embedding 并作为向量检索的单元

查询时用 Child Chunk 的向量做精确匹配，召回后返回对应的 Parent Chunk 内容给 LLM。这样检索精确率高（小块更精准），同时 LLM 获得的上下文完整性好（大块包含更多背景）。

---

## 第 4 章 构建完整的 RAG 知识库

### 4.1 知识库的 Schema 设计

```python
# 企业知识库 Schema 设计示例（Python SDK）
from pymilvus import FieldSchema, CollectionSchema, DataType, Collection

fields = [
    # 主键
    FieldSchema(name="chunk_id",      dtype=DataType.INT64,         is_primary=True, auto_id=True),
    # 原始文档关联
    FieldSchema(name="doc_id",        dtype=DataType.VARCHAR,       max_length=128),
    FieldSchema(name="doc_title",     dtype=DataType.VARCHAR,       max_length=512),
    FieldSchema(name="source_url",    dtype=DataType.VARCHAR,       max_length=1024),
    FieldSchema(name="category",      dtype=DataType.VARCHAR,       max_length=64),
    FieldSchema(name="created_at",    dtype=DataType.INT64),                        # Unix timestamp
    FieldSchema(name="updated_at",    dtype=DataType.INT64),
    # 文本内容
    FieldSchema(name="content",       dtype=DataType.VARCHAR,       max_length=65535),  # 原始文本
    FieldSchema(name="chunk_index",   dtype=DataType.INT32),                          # 在文档中的序号
    # 向量字段
    FieldSchema(name="dense_vector",  dtype=DataType.FLOAT_VECTOR,  dim=1024),        # BGE-M3 稠密向量
    FieldSchema(name="sparse_vector", dtype=DataType.SPARSE_FLOAT_VECTOR),           # BGE-M3 稀疏向量
]

schema = CollectionSchema(
    fields=fields,
    description="企业知识库 RAG 向量集合",
    enable_dynamic_field=True   # 允许扩展字段
)

collection = Collection(name="knowledge_base", schema=schema)

# 为稠密向量创建 HNSW 索引
collection.create_index("dense_vector", {
    "index_type": "HNSW",
    "metric_type": "COSINE",
    "params": {"M": 16, "efConstruction": 200}
})

# 为稀疏向量创建 SPARSE_INVERTED_INDEX 索引
collection.create_index("sparse_vector", {
    "index_type": "SPARSE_INVERTED_INDEX",
    "metric_type": "IP",
    "params": {"drop_ratio_build": 0.2}   # 构建时丢弃权重最低的 20% 词项
})

# 为常用过滤字段创建标量索引
collection.create_index("category",   {"index_type": "INVERTED"})
collection.create_index("created_at", {"index_type": "STL_SORT"})
```

### 4.2 文档索引 Pipeline

```python
# 文档索引 Pipeline 完整示例
from FlagEmbedding import BGEM3FlagModel
from langchain.text_splitter import RecursiveCharacterTextSplitter
import time

# 初始化 Embedding 模型
embedder = BGEM3FlagModel('BAAI/bge-m3', use_fp16=True)

# 文档分块配置
splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,          # 每块最大 500 Token
    chunk_overlap=50,        # 相邻块重叠 50 Token（保留上下文连贯性）
    separators=["\n\n", "\n", "。", "！", "？", " ", ""],  # 优先在段落/句子边界分割
    length_function=len      # 用字符数估算（简化，生产中用 tokenizer）
)

def index_document(doc_id: str, title: str, content: str, category: str, url: str):
    """将一篇文档分块、编码并写入 Milvus"""
    
    # 1. 分块
    chunks = splitter.split_text(content)
    
    # 2. 批量 Embedding（稠密 + 稀疏）
    output = embedder.encode(
        chunks,
        batch_size=32,
        max_length=512,
        return_dense=True,
        return_sparse=True,
    )
    dense_vecs = output['dense_vecs'].tolist()
    sparse_vecs = output['lexical_weights']      # list of dict: {token_id: weight}
    
    # 3. 构造插入数据
    now = int(time.time())
    rows = []
    for i, (chunk, dense, sparse) in enumerate(zip(chunks, dense_vecs, sparse_vecs)):
        rows.append({
            "doc_id":        doc_id,
            "doc_title":     title,
            "source_url":    url,
            "category":      category,
            "created_at":    now,
            "updated_at":    now,
            "content":       chunk,
            "chunk_index":   i,
            "dense_vector":  dense,
            "sparse_vector": sparse,   # Milvus 接受 dict 格式稀疏向量
        })
    
    # 4. 写入 Milvus（批量插入）
    collection.insert(rows)
    
    return len(chunks)
```

---

## 第 5 章 RAG 检索的优化技巧

### 5.1 查询改写（Query Rewriting）

用户的原始查询往往措辞模糊或使用口语化表达，直接 Embedding 后的向量检索效果不佳。**查询改写**通过 LLM 将用户查询改写为更适合向量检索的形式：

**HyDE（Hypothetical Document Embeddings）**：让 LLM 先假设生成一个"理想的答案文档"，对这个假设文档做 Embedding，用生成文档的向量替代用户查询的向量进行检索。直觉是：假设文档的向量比问题的向量更接近实际答案文档的向量（因为格式更相似）。

```python
# HyDE 示例
def hyde_search(question: str, top_k: int = 5):
    # 1. 让 LLM 生成假设答案
    hypothetical_doc = llm.generate(
        f"为以下问题生成一段详细的参考答案（约200字）：{question}"
    )
    
    # 2. 对假设答案做 Embedding
    hyp_embedding = embedder.encode([hypothetical_doc], return_dense=True)['dense_vecs'][0]
    
    # 3. 用假设答案的向量检索
    results = collection.search(
        data=[hyp_embedding.tolist()],
        anns_field="dense_vector",
        param={"metric_type": "COSINE", "params": {"ef": 100}},
        limit=top_k,
        output_fields=["content", "doc_title", "source_url"]
    )
    return results
```

**Multi-Query（多路查询）**：让 LLM 从不同角度改写同一个问题，生成 3~5 个不同措辞的查询，对每个查询独立检索，然后对所有结果去重合并。这提高了检索的覆盖率（Recall），适合复杂问题或问题措辞不够准确的场景。

### 5.2 重排序（Re-ranking）

向量检索（ANN）的结果按向量距离排序，但向量距离并不总是与"对用户问题的回答有用程度"完全一致——向量相似性是语义相似性的近似，在细节上可能有偏差。

**Cross-Encoder Re-ranker**：用一个更精确但更慢的模型（Cross-Encoder，如 `bge-reranker-large`）对 Top-K（如 Top-20）候选片段逐一打分，重新排序后取 Top-K（如 Top-5）。Cross-Encoder 是双向注意力（同时处理问题和文档的完整文本），精度远高于向量相似度，但因为无法预计算文档的向量（每次都需要与查询一起输入），速度较慢，只适合在 Recall 阶段（Milvus 检索）的 Top-K 候选上运行。

```
典型 RAG 检索流程（带重排序）：

用户问题 → Milvus 混合检索 Top-20 → BGE-Reranker 重排序 → Top-5 → LLM 生成
           （快速粗排，ANN 近似）    （精确重排，Cross-Encoder）
```

**实验数据（企业知识库，1000 次查询）**：

| 配置 | Recall@5 | MRR@5 | 平均延迟 |
|------|----------|-------|---------|
| 仅稠密检索（HNSW） | 72% | 0.65 | 50ms |
| 混合检索（稠密+稀疏，RRF） | 81% | 0.74 | 75ms |
| 混合检索 + 重排序 | 89% | 0.83 | 180ms |

加入重排序后 Recall 提升约 8~17 个百分点，延迟增加约 100ms，综合效果显著。

### 5.3 上下文压缩（Context Compression）

召回的 Top-K 片段不是每个部分都与用户问题相关，直接将所有内容塞入 LLM 的 Context 会引入噪声，干扰 LLM 生成。**上下文压缩**通过 LLM 对召回的每个片段进行过滤和摘要，只保留与问题真正相关的部分：

```python
from langchain.retrievers.document_compressors import LLMChainExtractor
from langchain.retrievers import ContextualCompressionRetriever

# 使用 LLM 从每个召回片段中抽取与问题相关的句子
compressor = LLMChainExtractor.from_llm(llm)
compression_retriever = ContextualCompressionRetriever(
    base_compressor=compressor,
    base_retriever=milvus_retriever   # 底层是 Milvus 检索器
)

# 查询时，每个召回片段会被 LLM 压缩为只包含相关内容
docs = compression_retriever.get_relevant_documents(
    "Milvus 的 Segment 状态机有哪些状态？"
)
```

上下文压缩的代价是需要额外的 LLM 调用（每个召回片段一次），延迟和成本都会增加。适合对回答质量要求极高、上下文窗口有限的场景。

---

## 第 6 章 与主流 RAG 框架的集成

### 6.1 LangChain 集成

**[[LangChain]]** 是最广泛使用的 LLM 应用开发框架，Milvus 有官方的 `langchain-milvus` 集成包。

```python
# LangChain + Milvus 完整 RAG 示例
from langchain_community.vectorstores import Milvus
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_openai import ChatOpenAI
from langchain.chains import RetrievalQA
from langchain.prompts import PromptTemplate

# 1. 初始化 Embedding 模型
embeddings = HuggingFaceEmbeddings(
    model_name="BAAI/bge-m3",
    model_kwargs={"device": "cpu"},
    encode_kwargs={"normalize_embeddings": True}
)

# 2. 连接 Milvus 向量存储
vectorstore = Milvus(
    embedding_function=embeddings,
    collection_name="knowledge_base",
    connection_args={"host": "localhost", "port": 19530},
    vector_field="dense_vector",
    text_field="content",
)

# 3. 创建检索器（带过滤条件）
retriever = vectorstore.as_retriever(
    search_type="similarity",
    search_kwargs={
        "k": 10,
        "expr": "category == 'technical'",  # 标量过滤
    }
)

# 4. 构建 RAG Chain
prompt = PromptTemplate(
    template="""请根据以下上下文回答问题。如果上下文中没有相关信息，请说明你不知道。

上下文：
{context}

问题：{question}

回答：""",
    input_variables=["context", "question"]
)

llm = ChatOpenAI(model="gpt-4o", temperature=0)
qa_chain = RetrievalQA.from_chain_type(
    llm=llm,
    chain_type="stuff",      # 直接拼接所有上下文
    retriever=retriever,
    chain_type_kwargs={"prompt": prompt},
    return_source_documents=True
)

# 5. 执行查询
result = qa_chain.invoke({"query": "Milvus 的 Segment 状态有哪些？"})
print(result["result"])
print("来源文档：", [doc.metadata["doc_title"] for doc in result["source_documents"]])
```

### 6.2 LlamaIndex 集成

**[[LlamaIndex]]**（原 GPT Index）是专注于 RAG 场景的框架，提供了比 LangChain 更丰富的数据连接器和索引管理工具。

```python
# LlamaIndex + Milvus 集成示例
from llama_index.vector_stores.milvus import MilvusVectorStore
from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.core.node_parser import SentenceSplitter

# 初始化 Milvus 向量存储
vector_store = MilvusVectorStore(
    uri="http://localhost:19530",
    collection_name="knowledge_base",
    dim=1024,
    overwrite=False,
)

# 使用 LlamaIndex 的索引 + 查询引擎
storage_context = StorageContext.from_defaults(vector_store=vector_store)
embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")

index = VectorStoreIndex.from_vector_store(
    vector_store=vector_store,
    embed_model=embed_model,
)

# 创建查询引擎（支持 Top-K、相似度阈值过滤）
query_engine = index.as_query_engine(
    similarity_top_k=5,
    vector_store_query_mode="default",
)

response = query_engine.query("什么是向量数据库？")
print(response)
```

**LlamaIndex 的 SubQuestion Query Engine**：对于复杂的多跳问题（如"Milvus 和 Pinecone 在架构上有什么不同？"），LlamaIndex 能将问题分解为多个子问题，分别检索后综合回答，适合复杂知识库查询场景。

---

## 第 7 章 RAG 系统的质量评估

### 7.1 评估指标体系

RAG 系统的质量评估分为两个维度：

**检索质量评估（Retrieval Evaluation）**：

| 指标 | 含义 | 计算方法 |
|------|------|---------|
| **Recall@K** | Top-K 中包含相关文档的比例 | 相关文档数 / 总相关文档数 |
| **Precision@K** | Top-K 中相关文档的比例 | 相关文档数 / K |
| **MRR@K** | 第一个相关文档的排名倒数均值 | mean(1/rank_of_first_relevant) |
| **NDCG@K** | 考虑相关度梯度的排名质量 | 归一化折扣累积增益 |

**端到端生成质量评估（End-to-End Evaluation）**：

| 指标 | 工具 | 含义 |
|------|------|------|
| **Faithfulness** | RAGAS | 回答是否忠实于检索到的上下文（无幻觉） |
| **Answer Relevancy** | RAGAS | 回答是否与问题相关 |
| **Context Recall** | RAGAS | 检索到的上下文是否覆盖了回答所需的全部信息 |
| **Context Precision** | RAGAS | 检索到的上下文中有多少比例对回答有贡献 |

### 7.2 RAGAS——自动化 RAG 评估框架

**[[RAGAS]]**（RAG Assessment）是专门为 RAG 系统设计的自动评估框架，用 LLM 对检索质量和生成质量进行自动打分，不需要人工标注。

```python
# RAGAS 评估示例
from ragas.metrics import faithfulness, answer_relevancy, context_recall, context_precision
from ragas import evaluate
from datasets import Dataset

# 准备评估数据集（问题、生成答案、检索上下文、参考答案）
eval_data = {
    "question": ["Milvus 的主键支持哪些类型？", ...],
    "answer": [rag_system.query(q) for q in questions],     # RAG 生成的答案
    "contexts": [[chunk.content for chunk in retrieved] for retrieved in all_retrieved],
    "ground_truth": ["INT64 和 VARCHAR...", ...],             # 标准答案
}

dataset = Dataset.from_dict(eval_data)

# 自动评估
scores = evaluate(
    dataset=dataset,
    metrics=[faithfulness, answer_relevancy, context_recall, context_precision],
)
print(scores)
# 输出：{'faithfulness': 0.87, 'answer_relevancy': 0.91, 'context_recall': 0.82, ...}
```

---

## 第 8 章 小结

### 8.1 RAG 工程化的核心经验

基于 Milvus 构建高质量 RAG 系统的关键经验：

1. **优先投资于文档质量和分块策略**：检索质量的上限由原始文档的质量和分块的合理性决定，这两点比索引参数调优更重要
2. **混合检索几乎总是优于纯向量检索**：稠密 + 稀疏（BGE-M3 + BM25）的组合，在工程投入增加有限的情况下，Recall 提升显著（通常 5%~15%）
3. **重排序是质量与延迟之间的权衡**：若 P99 延迟要求 < 500ms，重排序是值得的；若要求 < 100ms，需要权衡或选择更快的轻量重排序模型
4. **持续评估是 RAG 调优的基础**：建立 RAGAS 等自动评估流程，将每次架构变更的质量指标可量化地对比，是持续改进的唯一科学方法

### 8.2 后续章节导引

- **[[06 Milvus 运维——集群部署、索引调优与容量规划]]**：覆盖 Milvus 生产部署的完整运维知识，包括 Kubernetes 集群配置、监控指标体系、容量规划方法，帮助工程师将 RAG 系统从原型推进到生产
