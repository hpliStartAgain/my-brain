其实老早就已经筹划做这个AIOps平台了，大概想法就是做一个运维版的Agent中台，提供各种运维MCP和Skills，提供API能力方便嵌入已有运维平台，提供工作流引擎、提供Agent引擎、提供RAG能力。

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkicvb6p4yqXtSc0nmlImC6aH6uY9QzYxbp3T1l7rh12amqemZRcYXZ8H8RvChjepbu4T3HicdFvYDDMtgyZ8UB49xhZCMdWqeu0I/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=0)

其实这些功能拿开源的东西去拼凑也行，但也是为了锻炼自己做项目的能力，才想着从头到尾搞一遍。

我自己并不是程序员出身，而且我也没打算手搓代码，毕竟现在AI编程工具能力这么强了，能用AI绝不自己动手。

我用的是OpenClaw+Codex来做这个项目，我把具体步骤记录了下来分享给你。今天是第一部分，后面会持续更新记录，建议大家收藏和关注，方便看后续部分。

第一先让它设计PRD。

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk90N7M2eIxIdy3pAzdTZvClbLVzr0eOvGKO3KiajzZ56SdWGdRfxmViblFtwG8Kh2guNiaRDluPUHvB9pwQBEcH4mchkUl9ZBVx3s/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=1)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk8uKKiclegqEWC3vKd25g5DiaOtSLI3LzqOIrtRzvVbZKz2U3ULlTj8K0SRmbLC7WbkDGTaWQKkyvU8QibErwnD1JbsBDRVUGiaKuA/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=2)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk879ZbDKbcocLSRa83WePggPwc5OSa6cc554Tb1GemQQqGdtsRoO0w0kxkbAQqsLeSgMmYib7XuQbbAfqm1tUdGp3GeiciaGC5Gto/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=3)

设计好PRD后，然后让它排计划：

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkibzibjuSnvq6GXCibyuWKYJtB7knrRw6OZLjtOLTBkUV4DoJicg5ZAA20TFVicUkjVudrG1kUyGaGMibI2Echic27K5mv36cgkUmHscw/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=4)

非常详细，这个计划弄好后，就从INFRA-001开始让它一步一步去做就行了，遇到卡点，先解决卡点，解决完后继续往下走

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkibXhKRfcx5ArPeaCaEMCRAj2zxOuCeIMI08dwlxrXVPIcSicadUNibp38AkCgYwWfZYt09VeEG7JuvMMN1ibdaTdM3XChPKVyriah0/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=5)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk81K5egcf2uqpic5TycmN1qPqXo0ncKTgZiaoYlR31NSXZg4KPBrgcS0XAicKb7dqLOA0zvDmqP2YfD5xSq2KZ0gZrsicujkfBopmQ/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=6)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkic3FXwj7qK8Q8DTp3mZuFmVayKUGuSzDOjicwDibuBZP3bLBicYDtzNBForp7SeqZwBpqZCRxRF9xrTQLnSyJxDAtYDZ8V2UGHBF4/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=7)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkicZJicxqRqoqpcQPagd1wLsYF4D5TWvnSLfoBHM0xI0U0OIagEC8GCV3RxEnG4WicXDLvy1QSX2mgv5fYGjmliaZgLrX9ZOmJfNAY/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=8)

这期间也会遇到各种各样的问题，OpenClaw也会给出解决方案

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk9XWqHia3PzVukHA414taf2oTQQ5PZDCicS8fxMvlsI0wwXibIFaumBhtxrx9BVnqvHVyWRS6ROVBicAZD4ybDnk7x1Ykl588cRInM/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=9)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk9QEq2hWictsruvY5raCvdyefG13IdKqHPic1Xj9kJVtzre4mIJBFSb6xM9xw4lj9Sf5ibhXHkJAxDpy60TNG3gS6Dkj3t3nxlIyk/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=10)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk8voabvs8agxbdmNK0HNfw34aFDjmHjoiaEWDBctiax4kyl96ia3pUSxEJgMfpvB35sGwbaxYsgOWnVEVVF3GcP5z9duYBa7ibQYyY/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=11)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk8Q6bqzmyx6kNuge7Gwu8SgBCib71yvTFDO6PZzMkdUMjh8YZmGyVenHsicHfXnbFjLOBmzUq5yTaib0v3XSPFU4UA7ib4eib01Vv38/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=12)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkicyibSpkVFWAFia7ZQBgWibAyPmtts51F2tAwb14UbXfeeaGnrxp9qiauRLXPzUHdbfzM6cjtZicxmIzR6rwHOZKsakuH0nKmRqBBNc/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=13)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk8ib62RDkcRjtnSxmOjaorPTzTPov5ibZYib2LwfU5fGWmpYleicIzXSTW7JMAGt00yZcOk4TQNpyR9oo3KsedYjMmk2H0ibibZkEluk/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=14)

就这样一直让它做完了INFRA-007，虽然期间有一些小问题，但很容易解决，做完这些用了大概半小时，这如果是手搓+测试不得用1-2周，不得不感概，AI就是高效！

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkicqQJUAakEyusPczfItar4via5ZZ8AZq8etkLBFgsVUuVCKPxrq7ibx0WoM6GclsGG5V0EFLFt98RmefmaxYLh5iaV0DaRTsCdPtQ/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=15)

然后就是下一个大阶段了，实现权限相关的功能

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk8hC7GIMAStE3gfrr3LCuib6ocJWGvcp2iarbOZ1dlNAFvrUPiabuoVGoYTf65b9iby73ia3syjFmnPBTjEK5uiboDwHAGyg4LAvwNtk/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=16)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk8INCQW4vMPf54EnlZkeicAuCTSqfZTIUDSqULDSjx0Vs9eUU9pZetgnWDAaWlv614VnuG97qEk7sUOJbSBMJS69xRdsA17kx6U/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=17)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk8cmWaKticAkG4GLy80QmF6oLb7XDicMbFrwcznISnCJBxRxicBBVtX1NT5WX5vtz7QgfL2gozpqpPmjJicCuIk47Nrt4mZqFuVYLU/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=18)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkicZSfXo9yYnR5YNQ5Hh7JyiagbTaL5Ey3Sz262SHDMZhbVdBAgRictOVkGphSic8wnjReVpEawTaO2vQfD7X6gg5yGepPpOOs1qicE/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=19)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkibk1oxjSk8R2VbOibic9NBQZJx0RyDf3EIem9UPicMSmxTn2PhcMPhxfzMmIaFFibsIGuiacVRpicggBVFlYdx4IWu1tXPrZbnOjD9Hg/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=20)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkicksbHp91hbn4mACGd17biaGd4vSyeTkoWubgibd2adCIFPve0icd8RbjicS0l09IRV8iaNzpP1iahfLr9iazUcxfWafKAOUXb6tTLLXE/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=21)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkibboPibxeAfRz0I6ACFhIFnpxLxxyPuT2m78tVaCx4vCXQPgcoiaSuA90wnptzLMdicNSibZSPDrTmugt173LzWQ2T7ok7xrzpC8QQ/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=22)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkicOibySiahASsiaicV8CAdaYdSXYrngXgzhpIpTicEJJDMSia27bIpOIWLQwXaMCAjRj9aPoKSa7aXZJriczZPFCucjFYldM4Ktaf9X3g/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=23)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk9n1vMkvUfUYglr8FuToenrV3dgfyXv7sjpar16UBKzHG0Ykm8hzx5lo6PC07Qwmqm35BqAollj7DGwdPiboAGqbe5MGE9TicNAA/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=24)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk8fPaZcVW5vqR0DxwjcpmsZvX5Y4NTHmzVic3fIT5plqVCCaSNZB15mLHShTvkQ4ibqKTLpCYDHL8ibLyNsZ37hHR08LVXwgC6Ksg/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=25)

每一步都按部就班，并且给出验证的方法，如果你需要比较懒，也可以让它自己去做验证。而我更喜欢亲自去做验收，这样我知道它做出来的东西到底有没有问题。

以上思路并不难，如果你有啥好的想法，也可以鼓捣起来，对于我们来说付出的仅仅是几十或几百块的Tokens费用。