昨天开始[从零做AIOps平台](https://mp.weixin.qq.com/s?__biz=MjM5MTk1ODE0MA==&mid=2648442854&idx=1&sn=3c5daaddeb1366cd4f26e72cfa0c3e1a&scene=21#wechat_redirect)，每天记录，今天第二天。

昨天已完成了P0任务，看了总耗费Tokens，大概是$12.4，我用的是GPT-5.3-codex模型，一家中转站，包月59块钱，日限额$60，月限额$720,性价比还算不错。我平时OpenClaw+codex使用频率不算重度，完全够用甚至还有不少富余。

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkicUVCAoKsiaicQSzBbSZQoBnI11MPZfsP9JsORVpVmpEZeGg1FsPun1EHxUU6YefCex3yjd9GAJIoaqdF5sooKzQcZbYXWWktwHg/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=0)

截止到目前，P0任务已经开发完成，P1任务正在推进中：

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk9r9iaZCiavQugDWtpRMx09M9yGqjJfTRRIbEk0jo2aSTLlmRtKO2SE3Q1jsRrVO78exZXarBUuzvDXiay5U1SIL6hxvmznJVobQ0/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=1)

```
## 2. P0 任务明细（给 Codex 的可执行清单）
```

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHk8hnDIWvjvW0PhibgEMkRlylGw5FnSYHhcFibSIsOWmDIAhGRhjvNNFKamLp7hcXnXehwHZSk3ib8G8XLn0dP0IE6NfRdW0ibloNia4/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=2)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHk9DOZaa4GsdQJzC32R1IicuAciaTUOAh2b6MKJKfg2EJAVB8EVyrGoWIFTIp26QRPMDzVMkTyMRgg8JPFxvbdGfBR7qqg4DhwaV8/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=3)

![图片](https://mmbiz.qpic.cn/mmbiz_png/hkrJA6aNHkicKTW9vpDM6UQfRxicVWaWkIHqEiawsWgrnNdV1v9ldqiaSS8IDu2r9zmxcQdviayBWfjTayx1pRzBnVS9O7ia2ClWFFHJGVRNiaX4HY/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=4)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkibJf6tlWBxgT6wKdOc6eNkL6dpsic3EnPzfv9A6UjfZicVJ4M6Kx719jwrxvqfTNTF0icrGoQyBUrCT4ib491Mcfx5R4pibYH8zCJEo/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=5)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/hkrJA6aNHkibtTzgva5ek1VsdImQRlficwDbcmTibLu6upAAcHgcmw9yAW59PJiaK0bSZg2tjxFTBSoiaoJHzD3P8rc6DfgztCichXgQDXpJxicayk/640?wx_fmt=png&from=appmsg&tp=wxpic&wxfrom=5&wx_lazy=1#imgIndex=6)

说下注意事项吧：

1）OpenClaw如果中途重启过，那么可能会导致任务不连贯

比如刚刚开发了INFRA-006，想让它继续开发INFRA-007，那么它就不晓得是什么。为了避免这个情况，要是不是提醒一下OpenClaw做长期记忆。

2）这个项目开发，我一开始的准备工作并没有做充分

比如它只给了P0任务列表，而没有给P1-p3剩余三个任务，所以当开发完P0后，我让它继续往后开发时，结果它又跑到P0里去找任务了。

3）规划是让OpenClaw把开发任务交给codex去做，中途个别任务脱轨了

一开始确实是让codex在开发任务，后来中途进行到一半时结果OpenClaw自己去做了，这样很有可能导致代码写的前后有差距。所以，需要一开始就跟他约定好

```
本次任务开发交给Codex cli去做，同时我们做个约定，后续所有任务开发都用Codex cli。
```

我非常喜欢这种Vibe Coding的模式做项目，不仅有参与做项目的体感，而且还能监督每一个任务的完成过程，并亲自做验收。