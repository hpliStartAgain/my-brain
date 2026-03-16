- [1. 需求背景](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-1.%E9%9C%80%E6%B1%82%E8%83%8C%E6%99%AF)
- [2. 数据源](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-2.%E6%95%B0%E6%8D%AE%E6%BA%90)
    - [2.1 Doris 表: bdwh.ads_panther_elastic_label](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-2.1Doris%E8%A1%A8:bdwh.ads_panther_elastic_label)
    - [2.2 VictoriaMetrics 指标](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-2.2VictoriaMetrics%E6%8C%87%E6%A0%87)
        - [2.2.1 弹性资源余量](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-2.2.1%E5%BC%B9%E6%80%A7%E8%B5%84%E6%BA%90%E4%BD%99%E9%87%8F)
        - [2.2.2 RSS 集群资源](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-2.2.2RSS%E9%9B%86%E7%BE%A4%E8%B5%84%E6%BA%90)
- [3. API 规格](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-3.API%E8%A7%84%E6%A0%BC)
    - [3.1 基本信息](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-3.1%E5%9F%BA%E6%9C%AC%E4%BF%A1%E6%81%AF)
    - [3.2 请求参数](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-3.2%E8%AF%B7%E6%B1%82%E5%8F%82%E6%95%B0)
    - [3.3 请求示例](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-3.3%E8%AF%B7%E6%B1%82%E7%A4%BA%E4%BE%8B)
- [4. 资源余量监测设计](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.%E8%B5%84%E6%BA%90%E4%BD%99%E9%87%8F%E7%9B%91%E6%B5%8B%E8%AE%BE%E8%AE%A1)
    - [4.1 弹性资源余量判断](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.1%E5%BC%B9%E6%80%A7%E8%B5%84%E6%BA%90%E4%BD%99%E9%87%8F%E5%88%A4%E6%96%AD)
        - [4.1.1 判断逻辑](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.1.1%E5%88%A4%E6%96%AD%E9%80%BB%E8%BE%91)
        - [4.1.2 获取弹性资源余量](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.1.2%E8%8E%B7%E5%8F%96%E5%BC%B9%E6%80%A7%E8%B5%84%E6%BA%90%E4%BD%99%E9%87%8F)
        - [4.1.3 判断算法](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.1.3%E5%88%A4%E6%96%AD%E7%AE%97%E6%B3%95)
    - [4.2 RSS 资源余量判断](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2RSS%E8%B5%84%E6%BA%90%E4%BD%99%E9%87%8F%E5%88%A4%E6%96%AD)
        - [4.2.1 RSS 判定的复杂性](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2.1RSS%E5%88%A4%E5%AE%9A%E7%9A%84%E5%A4%8D%E6%9D%82%E6%80%A7)
        - [4.2.2 推荐算法：水位线 + 单作业阈值](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2.2%E6%8E%A8%E8%8D%90%E7%AE%97%E6%B3%95%EF%BC%9A%E6%B0%B4%E4%BD%8D%E7%BA%BF+%E5%8D%95%E4%BD%9C%E4%B8%9A%E9%98%88%E5%80%BC)
        - [4.2.3 获取 RSS 集群使用率](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2.3%E8%8E%B7%E5%8F%96RSS%E9%9B%86%E7%BE%A4%E4%BD%BF%E7%94%A8%E7%8E%87)
        - [4.2.4 判断算法](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2.4%E5%88%A4%E6%96%AD%E7%AE%97%E6%B3%95)
        - [4.2.5 进阶算法（可选）](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-4.2.5%E8%BF%9B%E9%98%B6%E7%AE%97%E6%B3%95%EF%BC%88%E5%8F%AF%E9%80%89%EF%BC%89)
- [5. 后端处理流程](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-5.%E5%90%8E%E7%AB%AF%E5%A4%84%E7%90%86%E6%B5%81%E7%A8%8B)
- [6. 响应格式](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-6.%E5%93%8D%E5%BA%94%E6%A0%BC%E5%BC%8F)
    - [6.1 成功响应（资源充足）](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-6.1%E6%88%90%E5%8A%9F%E5%93%8D%E5%BA%94%EF%BC%88%E8%B5%84%E6%BA%90%E5%85%85%E8%B6%B3%EF%BC%89)
    - [6.2 成功响应（资源不足，降级）](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-6.2%E6%88%90%E5%8A%9F%E5%93%8D%E5%BA%94%EF%BC%88%E8%B5%84%E6%BA%90%E4%B8%8D%E8%B6%B3%EF%BC%8C%E9%99%8D%E7%BA%A7%EF%BC%89)
- [7. 配置模板](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.%E9%85%8D%E7%BD%AE%E6%A8%A1%E6%9D%BF)
    - [7.1 elastic_label = 1 (弹性调度)](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.1elastic_label=1\(%E5%BC%B9%E6%80%A7%E8%B0%83%E5%BA%A6\))
    - [7.2 rss_label = 1 (Remote Shuffle Service)](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.2rss_label=1\(RemoteShuffleService\))
    - [7.3 vector_label = 1 (Velox)](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.3vector_label=1\(Velox\))
    - [7.4 tez_label = 1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.4tez_label=1) 
    - [7.5 mr_combine_label = 1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-7.5mr_combine_label=1) 
- [8. 配置参数](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-8.%E9%85%8D%E7%BD%AE%E5%8F%82%E6%95%B0)
    - [8.1 弹性资源配置](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-8.1%E5%BC%B9%E6%80%A7%E8%B5%84%E6%BA%90%E9%85%8D%E7%BD%AE)
    - [8.2 RSS 资源配置](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-8.2RSS%E8%B5%84%E6%BA%90%E9%85%8D%E7%BD%AE)
- [9. 后端实现参考](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-9.%E5%90%8E%E7%AB%AF%E5%AE%9E%E7%8E%B0%E5%8F%82%E8%80%83)
    - [9.1 VictoriaMetrics 查询封装](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-9.1VictoriaMetrics%E6%9F%A5%E8%AF%A2%E5%B0%81%E8%A3%85)
    - [9.2 资源检查服务](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-9.2%E8%B5%84%E6%BA%90%E6%A3%80%E6%9F%A5%E6%9C%8D%E5%8A%A1)
- [附录 A: 配置项速查表](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-%E9%99%84%E5%BD%95A:%E9%85%8D%E7%BD%AE%E9%A1%B9%E9%80%9F%E6%9F%A5%E8%A1%A8)
    - [A.1 elastic_label=1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-A.1elastic_label=1)
    - [A.2 rss_label=1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-A.2rss_label=1)
    - [A.3 vector_label=1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-A.3vector_label=1)
    - [A.4 tez_label=1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-A.4tez_label=1)
    - [A.5 mr_combine_label=1](https://bd-docs.panther.sohurdc.com/pages/viewpage.action?pageId=103691163#Spark%E5%8A%A8%E6%80%81%E9%85%8D%E7%BD%AE%E6%9C%8D%E5%8A%A1-%E5%90%8E%E7%AB%AFAPI%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3-A.5mr_combine_label=1)

## 1. 需求背景

为实现 Spark 作业的动态配置注入（如弹性调度标签、RSS 配置、Velox 向量化引擎等），需要后端提供一个配置查询 API。客户端在提交 Spark 作业前调用此 API，获取需要注入的配置列表。

**v2.0 新增功能**: 资源余量监测，确保弹性资源和 RSS 集群有足够资源承接作业。

---

## 2. 数据源

### 2.1 Doris 表: `bdwh.ads_panther_elastic_label`

|   |   |   |
|---|---|---|
|**字段名**|**类型**|**说明**|
|`event_time`|date|表分区字段，按天分区|
|`uniq_name_md5`|String|作业唯一命名 MD5|
|`job_type`|int|作业类型：1=MR, 2=Tez, 3=Spark|
|user|String|用户名|
|`uniq_name_type`|int|作业唯一命名类型：1=sql, 2=jobname, 3=classname, 4=appid|
|`job_detail_type`|int|详细类型：4=普通Spark, 5=Spark-SQL, 6=Spark-Streaming|
|`job_time`|Long|作业7天内平均运行时长（秒）|
|`shuffle_bytes`|Long|作业7天内平均 Shuffle 数据大小（字节）|
|`cnt`|Long|作业7天内总调用次数|
|`elastic_label`|int|弹性标签：0=不可弹, 1=可弹|
|`rss_label`|int|RSS 标签：0=不可, 1=可|
|`vector_label`|int|Velox 标签：0=不可, 1=可|
|tez_label|int|tez参数标签：0=不可, 1=可|
|mr_mem_label|int|mr动态内存标签：0=不可, 1=可|
|mr_combine_label|int|mr小文件合并标签：0=不可, 1=可|

### 2.2 VictoriaMetrics 指标

#### 2.2.1 弹性资源余量

~~`hadoop_yarn_resourcemanager_partition_memory_in_mb{ partition="elastic-ec-exclusive", queue="root.datacenter", status="Available" }`~~

~~**注意**: ResourceManager 是 HA 模式，查询会返回两个值：~~

- ~~**Active RM**: 返回真实的可用内存值~~
    
- ~~**Standby RM**: 返回 0~~
    

~~需要取 `max()` 获取有效值。~~

根据用户不同判断队列名不同，比如bdwh的是：  
hadoop_yarn_resourcemanager_partition_memory_in_mb{ha_status='active',status='Available',partition="elastic-ec-exclusive",queue='**root.datacenter'**}  
  
msnscrd的是：  
hadoop_yarn_resourcemanager_partition_memory_in_mb{ha_status='active',status='Available',partition="elastic-ec-exclusive",queue='**root.huyou**'}

  

#### 2.2.2 RSS 集群资源

```
# RSS 集群已使用堆内存 (6台机器求和)
sum(rss_uniffle_metrics_server_jvm_memory_bytes_used{area="heap"})

# RSS 集群最大堆内存 (6台机器求和)
sum(rss_uniffle_metrics_server_jvm_memory_bytes_max{area="heap"})
```

---

## 3. API 规格

### 3.1 基本信息

|   |   |
|---|---|
|**项目**|**内容**|
|**接口路径**|`/api/spark/dynamic-config`|
|**请求方式**|GET|
|**Content-Type**|application/json|
|**超时要求**|响应时间 < 500ms (P99)，客户端超时设置为 3s|

### 3.2 请求参数

|   |   |   |   |
|---|---|---|---|
|**参数名**|**类型**|**必填**|**说明**|
|`job_name`|string|条件必填|作业名称，已由客户端去除时间戳后缀|
|`class_name`|string|条件必填|**全路径类名**，如 `com.example.MyJob`|
|`queue`|string|否|YARN 队列名称|
|`user`|string|必填|提交作业的用户名|
|`required_memory_mb`|int|否|**作业所需内存 (MB)**，用于弹性资源余量判断|
|job_type|int|必填|作业类型：1=MR, 2=Tez, 3=Spark|
|time_type|int|否|默认为0，如果为1，弹性不考虑时间因素|

**参数规则**:

- `job_name` 和 `class_name` 至少传一个
- 客户端有 `job_name` 时只传 `job_name`，否则传 `class_name`
- `className全路径获取不到数据时考虑使用className$作为作业名，比如com.example.MyJob 取不到数，需要.截取到最后的字符串 MyJob$ 取数`
- `user和job_type必填，放入数据表bdwh.ads_panther_elastic_label的过滤条件中，防止不同用户和不同作业类型的作业名相同的情况`
- `required_memory_mb` = executor数量 × executor内存，由客户端计算
- time_type默认不传，弹性必须判断当前时间是否在23:00-8:00，23:00-8:00进行下一步，在23:00-8:00之外直接返回空，当传入time_type=1，弹性不考虑时间因素直接进入下一步判断

### 3.3 请求示例

```
GET /api/spark/dynamic-config?job_name=MySparkJob&queue=default&user=hadoop&required_memory_mb=102400 HTTP/1.1
Host: panther.sohurdc.com
Accept: application/json
```

---

## 4. 资源余量监测设计

### 4.1 弹性资源余量判断

#### 4.1.1 判断逻辑

```
elastic_available = (elastic_label == 1) 
                    AND (required_memory_mb <= available_elastic_memory_mb * ELASTIC_SAFETY_RATIO)
```

#### 4.1.2 获取弹性资源余量

```
/**
 * 从 VictoriaMetrics 查询弹性分区可用内存
 * 
 * PromQL: max(hadoop_yarn_resourcemanager_partition_memory_in_mb{
 *           partition="elastic-ec-exclusive", 
 *           queue="root.datacenter",
 *           status="Available"
 *         })
 * 
 * 使用 max() 是因为 RM HA 模式下 Standby 返回 0
 */
public long getElasticAvailableMemoryMb() {
    String query = "max(hadoop_yarn_resourcemanager_partition_memory_in_mb{" +
                   "partition=\"elastic-ec-exclusive\"," +
                   "queue=\"root.datacenter\"," +
                   "status=\"Available\"})";
    
    // 调用 VictoriaMetrics API
    // GET http://vm-server:8428/api/v1/query?query=<promql>
    return queryVictoriaMetrics(query);
}
```

#### 4.1.3 判断算法

```
// 安全系数，预留 20% 资源缓冲
private static final double ELASTIC_SAFETY_RATIO = 0.8;

public boolean isElasticResourceAvailable(long requiredMemoryMb, int elasticLabel) {
    if (elasticLabel != 1) {
        return false;
    }
    
    // 如果客户端没传资源需求，默认允许
    if (requiredMemoryMb <= 0) {
        return true;
    }
    
    long availableMemoryMb = getElasticAvailableMemoryMb();
    long safeAvailableMemoryMb = (long) (availableMemoryMb * ELASTIC_SAFETY_RATIO);
    
    boolean available = requiredMemoryMb <= safeAvailableMemoryMb;
    
    log.info("Elastic resource check: required={}MB, available={}MB (safe={}MB), result={}",
             requiredMemoryMb, availableMemoryMb, safeAvailableMemoryMb, available);
    
    return available;
}
```

### 4.2 RSS 资源余量判断

#### 4.2.1 RSS 判定的复杂性

RSS (Remote Shuffle Service) 的资源判断比弹性资源更复杂：

1. **Shuffle 是流式过程**: 数据 写入 → 缓存 → 读取 → 释放，不会一直占用内存
2. **RSS 会 Spill 到磁盘**: 内存压力大时会溢写到磁盘
3. **多作业并发共享**: 多个作业同时使用 RSS 集群
4. **shuffle_bytes 是总量**: Doris 中存储的是作业整个生命周期的 shuffle 数据量，不是峰值内存占用

#### 4.2.2 推荐算法：水位线 + 单作业阈值

```
rss_available = (rss_label == 1) 
                AND (rss_current_usage_ratio < RSS_HIGH_WATERMARK)
                AND (shuffle_bytes < RSS_MAX_SHUFFLE_BYTES)
```

**算法说明**:

- **rss_label == 1**: Doris 表中标记为适合 RSS 的作业
- **水位线判断**: 当前 RSS 集群内存使用率低于高水位线
- **单作业阈值**: 单个作业的 shuffle 数据量不超过阈值，避免超大作业拖垮 RSS

#### 4.2.3 获取 RSS 集群使用率

```
/**
 * 查询 RSS 集群当前内存使用率
 */
public double getRssMemoryUsageRatio() {
    // 已使用内存
    String usedQuery = "sum(rss_uniffle_metrics_server_jvm_memory_bytes_used{area=\"heap\"})";
    long usedBytes = queryVictoriaMetrics(usedQuery);
    
    // 最大内存
    String maxQuery = "sum(rss_uniffle_metrics_server_jvm_memory_bytes_max{area=\"heap\"})";
    long maxBytes = queryVictoriaMetrics(maxQuery);
    
    if (maxBytes <= 0) {
        log.warn("RSS max memory is 0, assuming unavailable");
        return 1.0;  // 返回 100%，表示不可用
    }
    
    return (double) usedBytes / maxBytes;
}
```

#### 4.2.4 判断算法

```
// RSS 高水位线: 使用率超过 70% 不再调度新作业
private static final double RSS_HIGH_WATERMARK = 0.7;

// 单作业最大 shuffle 量: 500GB
private static final long RSS_MAX_SHUFFLE_BYTES = 500L * 1024 * 1024 * 1024;

public boolean isRssResourceAvailable(int rssLabel, long shuffleBytes) {
    if (rssLabel != 1) {
        return false;
    }
    
    // 检查单作业 shuffle 量阈值
    if (shuffleBytes > RSS_MAX_SHUFFLE_BYTES) {
        log.info("RSS check: shuffle_bytes={}GB exceeds threshold={}GB, rejected",
                 shuffleBytes / (1024*1024*1024), RSS_MAX_SHUFFLE_BYTES / (1024*1024*1024));
        return false;
    }
    
    // 检查集群使用率
    double usageRatio = getRssMemoryUsageRatio();
    boolean available = usageRatio < RSS_HIGH_WATERMARK;
    
    log.info("RSS resource check: shuffle_bytes={}GB, cluster_usage={:.1f}%, watermark={:.1f}%, result={}",
             shuffleBytes / (1024*1024*1024), usageRatio * 100, RSS_HIGH_WATERMARK * 100, available);
    
    return available;
}
```

#### 4.2.5 进阶算法（可选）

如果简单的水位线方案效果不佳，可以考虑以下进阶方案：

**方案 A: 基于速率的预测**

```
// 估算作业对 RSS 的峰值内存压力
// shuffle_rate = shuffle_bytes / job_time (每秒 shuffle 速率)
// peak_memory_estimate = shuffle_rate × PEAK_WINDOW_SECONDS
long shuffleRate = shuffleBytes / Math.max(jobTime, 1);
long peakMemoryEstimate = shuffleRate * 60;  // 假设 60 秒峰值窗口
```

**方案 B: 基于历史成功率的动态调整**

```
// 根据历史 RSS 作业成功率动态调整水位线
// 成功率高 → 放宽水位线
// 成功率低 → 收紧水位线
double successRate = getRssJobSuccessRate(7);  // 最近7天
double dynamicWatermark = 0.5 + successRate * 0.3;  // 范围 [0.5, 0.8]
```

---

## 5. 后端处理流程

  
![[Pasted image 20260316155840.png]]
---

## 6. 响应格式

### 6.1 成功响应（资源充足）

```
{
    "code": 0,
    "message": "success",
    "data": {
        "configs": [
            {"key": "spark.yarn.executor.nodeLabelExpression", "value": "elastic-ec-exclusive"},
            {"key": "spark.shuffle.manager", "value": "org.apache.spark.shuffle.RssShuffleManager"},
            {"key": "spark.rss.coordinator.quorum", "value": "10.31.73.53:19999"}
        ],
        "matched_labels": {
            "elastic_label": 1,
            "rss_label": 1,
            "vector_label": 0
        },
        "resource_check": {
            "elastic": {
                "available": true,
                "required_mb": 102400,
                "cluster_available_mb": 512000,
                "safe_available_mb": 409600
            },
            "rss": {
                "available": true,
                "shuffle_bytes": 107374182400,
                "cluster_usage_ratio": 0.45,
                "watermark": 0.7
            }
        }
    },
    "timestamp": 1733385600000
}
```

### 6.2 成功响应（资源不足，降级）

```
{
    "code": 0,
    "message": "success",
    "data": {
        "configs": [],
        "matched_labels": {
            "elastic_label": 1,
            "rss_label": 1,
            "vector_label": 0
        },
        "resource_check": {
            "elastic": {
                "available": false,
                "required_mb": 512000,
                "cluster_available_mb": 200000,
                "safe_available_mb": 160000,
                "reason": "required_memory exceeds safe_available"
            },
            "rss": {
                "available": false,
                "cluster_usage_ratio": 0.85,
                "watermark": 0.7,
                "reason": "cluster_usage exceeds watermark"
            }
        }
    },
    "timestamp": 1733385600000
}
```

---

## 7. 配置模板

### 7.1 elastic_label = 1 (弹性调度)

|   |   |
|---|---|
|**Key**|**Value**|
|`spark.yarn.executor.nodeLabelExpression`|`elastic-ec-exclusive`|

### 7.2 rss_label = 1 (Remote Shuffle Service)

|   |   |
|---|---|
|**Key**|**Value**|
|`spark.rss.remote.storage.path`|`[hdfs://router/user/rss/public/shuffle_data](hdfs://router/user/rss/public/shuffle_data)`|
|`spark.shuffle.manager`|`org.apache.spark.shuffle.RssShuffleManager`|
|`spark.rss.coordinator.quorum`|`10.31.73.53:19999`|
|`spark.shuffle.service.enabled`|`false`|
|`spark.dynamicAllocation.enabled`|`true`|
|`spark.rss.client.retry.interval.max`|`5000`|
|`spark.rss.client.send.size.limit`|`32m`|
|`spark.rss.writer.buffer.spill.size`|`512m`|

### 7.3 vector_label = 1 (Velox)

|   |   |
|---|---|
|**Key**|**Value**|
|`spark.plugins`|`org.apache.gluten.GlutenPlugin`|
|`spark.memory.offHeap.enabled`|`true`|
|`spark.gluten.sql.columnar.forceShuffledHashJoin`|`true`|
|`spark.shuffle.manager`|`org.apache.spark.shuffle.sort.ColumnarShuffleManager`|
|~~`spark.executor.memoryOverhead`~~|~~`2048`~~|
|spark.memory.offHeap.size|1m|
|spark.gluten.memory.dynamic.offHeap.sizing.enabled|true|
|spark.gluten.memory.isolated|true|
|spark.gluten.sql.columnar.backend.lib|velox|
|spark.gluten.memory.overAcquiredMemoryRatio|0.1|
|spark.gluten.sql.columnar.backend.velox.spillEnabled|true|
|spark.gluten.sql.columnar.backend.velox.aggregationSpillEnabled|true|
|spark.gluten.sql.columnar.backend.velox.joinSpillEnabled|true|
|spark.gluten.sql.columnar.backend.velox.aggregationSpillMemoryThreshold|2684354560|
|spark.gluten.sql.columnar.backend.velox.joinSpillMemoryThreshold|2684354560|
|spark.gluten.sql.columnar.batchSize|4096|
|spark.gluten.sql.columnar.backend.velox.vectorBatchSize|4096|
|spark.gluten.sql.columnar.forceShuffledHashJoin|true|
|spark.gluten.sql.columnar.backend.velox.memoryManager|true|
|spark.executorEnv.LD_LIBRARY_PATH|/usr/bigtop/3.2.0/usr/lib64|

  

### 7.4 tez_label = 1 

|   |   |
|---|---|
|**Key**|**Value**|
|tez.grouping.min-size|1073741824|
|tez.grouping.max-size|2147483648|

  

### 7.5 mr_combine_label = 1 

过滤条件job_type=1

|   |   |
|---|---|
|**Key**|**Value**|
|mapreduce.job.maps|500|
|mapreduce.input.fileinputformat.split.maxsize|268435456|
|mapreduce.job.max.split.locations|2000|
|inputformat|org.apache.hadoop.mapred.lib.CombineTextInputFormat|

  

---

## 8. 配置参数

### 8.1 弹性资源配置

|   |   |   |
|---|---|---|
|**参数**|**默认值**|**说明**|
|`elastic.safety.ratio`|0.8|安全系数，预留 20% 资源缓冲|
|`elastic.vm.endpoint`|-|VictoriaMetrics 地址|
|`[elastic.partition.name](http://elastic.partition.name/)`|`elastic-ec-exclusive`|YARN 分区名称|
|`[elastic.queue.name](http://elastic.queue.name/)`|`root.datacenter`|YARN 队列名称|

### 8.2 RSS 资源配置

|   |   |   |
|---|---|---|
|**参数**|**默认值**|**说明**|
|`rss.high.watermark`|0.7|高水位线，超过则不调度|
|`rss.max.shuffle.bytes`|500GB|单作业最大 shuffle 量|
|`rss.vm.endpoint`|-|VictoriaMetrics 地址|

---

## 9. 后端实现参考

### 9.1 VictoriaMetrics 查询封装

```java
@Service
public class VictoriaMetricsClient {
    
    @Value("${vm.endpoint}")
    private String vmEndpoint;
    
    private final RestTemplate restTemplate;
    
    /**
     * 执行 PromQL 查询
     */
    public double query(String promql) {
        String url = vmEndpoint + "/api/v1/query?query=" + URLEncoder.encode(promql, UTF_8);
        
        try {
            VmResponse response = restTemplate.getForObject(url, VmResponse.class);
            if (response != null && "success".equals(response.getStatus())) {
                List<VmResult> results = response.getData().getResult();
                if (!results.isEmpty()) {
                    return Double.parseDouble(results.get(0).getValue().get(1));
                }
            }
        } catch (Exception e) {
            log.error("VM query failed: {}", promql, e);
        }
        
        return 0;
    }
}
```

### 9.2 资源检查服务

```
@Service
public class ResourceCheckService {
    
    private final VictoriaMetricsClient vmClient;
    
    @Value("${elastic.safety.ratio:0.8}")
    private double elasticSafetyRatio;
    
    @Value("${rss.high.watermark:0.7}")
    private double rssHighWatermark;
    
    @Value("${rss.max.shuffle.bytes:536870912000}")  // 500GB
    private long rssMaxShuffleBytes;
    
    /**
     * 检查弹性资源是否可用
     */
    public ResourceCheckResult checkElasticResource(long requiredMemoryMb, int elasticLabel) {
        ResourceCheckResult result = new ResourceCheckResult();
        result.setRequiredMb(requiredMemoryMb);
        
        if (elasticLabel != 1) {
            result.setAvailable(false);
            result.setReason("elastic_label is not 1");
            return result;
        }
        
        if (requiredMemoryMb <= 0) {
            result.setAvailable(true);
            result.setReason("no resource requirement specified");
            return result;
        }
        
        // 查询弹性分区可用内存
        String query = "max(hadoop_yarn_resourcemanager_partition_memory_in_mb{" +
                       "partition=\"elastic-ec-exclusive\"," +
                       "queue=\"root.datacenter\"," +
                       "status=\"Available\"})";
        long availableMb = (long) vmClient.query(query);
        long safeAvailableMb = (long) (availableMb * elasticSafetyRatio);
        
        result.setClusterAvailableMb(availableMb);
        result.setSafeAvailableMb(safeAvailableMb);
        
        if (requiredMemoryMb <= safeAvailableMb) {
            result.setAvailable(true);
        } else {
            result.setAvailable(false);
            result.setReason("required_memory exceeds safe_available");
        }
        
        return result;
    }
    
    /**
     * 检查 RSS 资源是否可用
     */
    public RssCheckResult checkRssResource(int rssLabel, long shuffleBytes) {
        RssCheckResult result = new RssCheckResult();
        result.setShuffleBytes(shuffleBytes);
        result.setWatermark(rssHighWatermark);
        
        if (rssLabel != 1) {
            result.setAvailable(false);
            result.setReason("rss_label is not 1");
            return result;
        }
        
        // 检查单作业 shuffle 量
        if (shuffleBytes > rssMaxShuffleBytes) {
            result.setAvailable(false);
            result.setReason("shuffle_bytes exceeds max threshold");
            return result;
        }
        
        // 查询 RSS 集群使用率
        String usedQuery = "sum(rss_uniffle_metrics_server_jvm_memory_bytes_used{area=\"heap\"})";
        String maxQuery = "sum(rss_uniffle_metrics_server_jvm_memory_bytes_max{area=\"heap\"})";
        
        long usedBytes = (long) vmClient.query(usedQuery);
        long maxBytes = (long) vmClient.query(maxQuery);
        
        double usageRatio = maxBytes > 0 ? (double) usedBytes / maxBytes : 1.0;
        result.setClusterUsageRatio(usageRatio);
        
        if (usageRatio < rssHighWatermark) {
            result.setAvailable(true);
        } else {
            result.setAvailable(false);
            result.setReason("cluster_usage exceeds watermark");
        }
        
        return result;
    }
}
```

## 附录 A: 配置项速查表

### **A.1 elastic_label=1**

```
--conf spark.yarn.executor.nodeLabelExpression=elastic-ec-exclusive
```

### **A.2 rss_label=1**

```
--conf spark.rss.remote.storage.path=hdfs://router/user/rss/public/shuffle_data \
--conf spark.shuffle.manager=org.apache.spark.shuffle.RssShuffleManager \
--conf spark.rss.coordinator.quorum=10.31.73.53:19999 \
--conf spark.shuffle.service.enabled=false \
--conf spark.dynamicAllocation.enabled=true \
--conf spark.rss.client.retry.interval.max=5000 \
--conf spark.rss.client.send.size.limit=32m \
--conf spark.rss.writer.buffer.spill.size=512m
```

### **A.3 vector_label=1**

```
--conf spark.plugins=org.apache.gluten.GlutenPlugin \
--conf spark.memory.offHeap.enabled=true \
--conf spark.gluten.sql.columnar.forceShuffledHashJoin=true \
--conf spark.shuffle.manager=org.apache.spark.shuffle.sort.ColumnarShuffleManager 
```

--conf spark.gluten.memory.dynamic.offHeap.sizing.enabled=true \

```
--conf spark.memory.offHeap.size=1m \
```

--conf spark.gluten.memory.overAcquiredMemoryRatio=0.1 \

--conf spark.gluten.memory.isolated=true \

--conf spark.gluten.sql.columnar.backend.velox.spillEnabled=true \

--conf spark.gluten.sql.columnar.backend.velox.aggregationSpillEnabled=true \

--conf spark.gluten.sql.columnar.backend.velox.joinSpillEnabled=true \

--conf spark.gluten.sql.columnar.backend.velox.aggregationSpillMemoryThreshold=2684354560 \

--conf spark.gluten.sql.columnar.backend.velox.joinSpillMemoryThreshold=2684354560 \

--conf spark.gluten.sql.columnar.batchSize=4096 \

--conf spark.gluten.sql.columnar.backend.velox.vectorBatchSize=4096 \

--conf spark.gluten.sql.columnar.forceShuffledHashJoin=true \

--conf spark.gluten.sql.columnar.backend.velox.memoryManager=true \

--conf spark.executorEnv.LD_LIBRARY_PATH=/usr/bigtop/3.2.0/usr/lib64

  

  

### A.4 tez_label=1

--hiveconf tez.grouping.min-size=1073741824 \  
--hiveconf tez.grouping.max-size=2147483648

  

### A.5 mr_combine_label=1

-D mapreduce.job.maps=500  
-D mapreduce.input.fileinputformat.split.maxsize=268435456  
-D mapreduce.job.max.split.locations=2000  
-inputformat org.apache.hadoop.mapred.lib.CombineTextInputFormat