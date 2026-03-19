Arthas 是 alibaba/arthas 开源的 Java 诊断工具。它能在不重启应用的前提下，动态查看线程/CPU、反编译类、追踪方法耗时、观察入参返回值、执行 OGNL、查看类加载器、线上取证定位问题——几乎是 Java 线上排障的“瑞士军刀”。

地址：https://github.com/alibaba/arthas

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1yxiaWpweHwB7V82LicgibQq8thM9vSf3UmfM0qicKwGEhSSI9ukVUic8NfpDYfNos8j4VqJbRSFWGA0UEV6nwhlSibPHGdK3msdcP0U/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=1)

但现实也很直白：Arthas 很强，门槛也很高。

- 你得知道该用哪个命令（thread/dashboard/trace/watch/tt/vmtool/ognl/jad…）；
    
- 你得知道参数怎么写、OGNL 怎么拼、如何限量，避免线上刷屏或增加开销；
    
- 你还得会“排障路径”：先拿证据，再收敛，再验证——而不是一通乱跑；
    

我们做的 Arthas Agent，就是把这件事反过来：让你用自然语言表达意图，让 Agent 负责把意图翻译成安全、可控、循证的 Arthas 操作，并把结果组织成一份“像 SRE 写的诊断报告”。

0. TL;DR（30 秒版）

- 没有 AI：你需要会 Arthas 的“语法”，更需要会“排障套路”；一件事往往要跑 5～15 条命令，并且每一步都要读懂输出才能继续收敛。
    
- 有 Arthas Agent：你只要描述“现象/目标”，它会
    

- 自动匹配内置 Skills（排障技能）
    
- 自动生成限量、安全的命令序列（每轮只推进 1～2 步，避免线上冲击）
    
- 在拿到证据后“像资深同学一样”继续收敛
    
- 最后输出结构化诊断报告（结论/证据/原因/建议）
    

一个例子 - 直接询问正在运行的Spring的版本号：

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1yycRC21X8QiaA98EyHnuHDhgO2sAUQzjMmAN7w9RYMWpXUxpDK9hFt4bNxBgXD9PGR6zkoXyojIsOSe4nygb1T3a3CRL8fA830/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=2)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1yjMpSthImibsKAwvMYA0K9Fl0G1wsR7hBRpGibboaEaJfXPTbBJRZRcjVialuM3ibIK4kQXUHNAbqxBJbmlX4txKRSlBH56EdCo1E/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=3)

整个过程不到30秒。

1. 没有 AI 的 Arthas：

你需要记住“命令”，而不是“问题”

传统方式里，你的大脑会被迫切换成“命令思维”：

- “CPU 高”要先 dashboard 还是 thread -n？
    
- “启动卡住”要看 main 线程，还是先扫 Spring Context？
    
- “我只想看某种参数类型的调用”——watch 条件怎么写？
    
- “我想拿 traceId 去查日志”——应该 watch 哪个点、怎么限量？
    

这些问题不难，但它们很耗时，而且常常发生在你最紧张的线上时刻。

更要命的是：真正耗时的不是“敲命令”，而是这些经验成本：

- 你要把问题先翻译成“下一条命令是什么”；
    
- 你要读懂输出，再翻译成“下一条命令是什么”；
    
- 你要持续约束风险（限量、避免宽泛匹配、避免刷屏）；
    
- 你要在脑子里维护上下文（关键证据、时间点、线程 ID、类名、配置项）；
    

于是排障变成了同时需要“会命令的人”，和“理解问题的人”。缺少一项都无法排查。

2. 有了 Arthas Agent：

你只需要说“现象/目标”，剩下交给它

Arthas Agent 的核心不是“把 Arthas 包装成 ChatBot”，而是把线上诊断变成一种工程化的、可复用的能力：

- Skill-first（技能优先）：内置一套“排障剧本”，先匹配最相关的技能，再按剧本推进；
    

- 例如：arthas-cpu-high（CPU 飙高）、arthas-springcontext-issues-resolve（Spring Context/Bean）、arthas-eagleeye-traceid（获取 traceId）；
    

- 安全优先（Safety First）：默认只做低风险、高信息量的动作；需要更深的操作会先做最少澄清或限量执行；
    

- 例如：每轮只推进 1–2 个低风险步骤；对 OGNL 强制单引号；禁止无锚点全量枚举类；内置权限隔离；
    

- 循证闭环（Evidence-based）：所有结论必须引用工具返回的真实证据，不凭空“猜”；
    

- 多 Agent 协作：把“长文本/日志/堆栈分析”交给专门的 log_reader 子 Agent，形成上下文隔离；
    

- 你可以把它理解为：一个 Agent 负责“跑工具拿证据”，另一个 Agent 负责“读证据写结论”；
    

- 工具自发现：先从 MCP 侧拿到“当前可用工具清单”，再决定怎么做（更适配不同环境/权限）；
    

最终体验是：你用一句话描述问题，它按步骤推进，并且每一步都会告诉你：

- 为什么要跑这条命令
    
- 期待看到什么
    
- 如果结果 A/B/C，下一步分别怎么走
    

一个例子 -- 应用启动不成功怎么办？

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1yVcic8fstodibgnov0sYsyYtbG2DLWm0VPbQBegibWiaJgYv8BPblIlASP89tluAE4gX9IpzDTRCMoUv4yS046VdayiatqGJ9Vc6Q8/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=4)

**2.1 “AI 的方便”到底方便在哪：把长流程变成一句话**

我们最想强调的，不是“AI 会背命令”，而是它能把下面这种长流程自动跑通：

- 先做低风险的“体检”拿方向感
    
- 再抓关键证据（线程堆栈/调用链/配置生效值）
    
- 再按证据收敛到更精确的观察点（trace/watch/tt）
    
- 最后把证据整理成“能交付给团队”的报告
    

你只需要说“现象/目标”，它负责把“专家脑内流程”显式化，并且每一步都把为什么要这么做讲清楚。

3. 真实案例：一句话完成复杂诊断

下面的例子来自我们在日常环境下的历史记录（已隐藏工具调用），重点看“诊断路径”和“证据收敛”。

**3.1 一句话：诊断“应用启动卡住/无法正常启动”**

你说：诊断一下应用无法正常启动的原因。

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1xtEkjYA5JyUesHicr5c7QIIkKmcibEPiazv3qVuna3yTLEjNOoqOxCWQmv3zMiae21QoJE1UKefdiaex28FOMicBREZz5tlJTvXTPx0/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=5)

3.1.1 没有 AI 时，资深同学怎么跑这条长流程

作为有经验的人，通常不会直接上来就 trace 或 watch，因为那样要么太宽、要么风险不可控。一个更“稳”的套路是：

- 先确认问题类型：是“没启动/退出了”，还是“进程在但卡住了”？
    

- 这一步会决定你后续是去看日志/退出码，还是去看线程堆栈/锁/远程依赖
    

- 先跑低风险体检（高信息量、低扰动）：
    

- 看 JVM 基本信息、dashboard 的 CPU/线程/GC 概况，快速判断是否存在“资源异常/线程暴涨/GC 异常”
    

- 再抓关键线程证据：
    

- 若是“卡住”，优先看 main 线程堆栈（很多启动卡住的根因就藏在这里）
    
- 若是“忙”，则先找最忙线程，再从堆栈提取“可疑方法名”
    

- 把堆栈里的方法翻译成“系统组件”：
    

- Spring refresh？卡在 Spring 生命周期步骤了？RPC/服务发现？数据库连接池？类初始化？锁等待？
    

- 必要时进一步确认（但仍要控制风险）：
    

- 反编译关键类确认“它在初始化阶段做了什么”
    
- 查 Spring Context/配置生效值确认“是不是某个配置导致等待/超时过长”
    

- 最后产出可执行建议：
    

- 临时止血（依赖服务、网络、注册中心、超时）
    
- 长期治理（避免静态初始化块做远程依赖初始化、改为懒加载/异步、合理重试）
    

这条链路“每一步都不难”，难的是：你要在压力下把下一步想清楚，还要保证每一步都可控。

3.1.2 来看看 AI 能不能做到：它是如何自动跑通并写出报告的

Agent 的推进路径（摘要）：

- 先拿 JVM 基本面（JVM/线程/GC 概况、dashboard）；
    
- 再检查是否存在死锁/异常阻塞；
    
- 锚定 main 线程堆栈，发现卡在某个服务依赖初始化的等待点；
    
- 进一步定位到某业务类的静态初始化块：启动期创建 Spring Context 并触发远程依赖初始化；
    
- 给出“根因 + 证据 + 解决建议”：例如把启动期强依赖改成懒加载/异步，或缩短超时、检查注册中心/网络等；
    

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1xMsPczRtt02woXSosy2ByV7s3qznm9DcUyNL1SBXqT0pdEM1lwxYUKagBWibzqb2jjseJQcNtibibicKBicauwKoYuVn8ulUmTz5J0/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=6)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1zG83rM8lVP74r2ibC19BYAkibClxfZr6ia5ric4QOsW22yp1lI2xgU7Mjia69W81SQkhy4tCiadicxkzgR2Diau0T5iciaksxcOUabwtm2Q/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=7)

为什么这类问题适合 Agent：

启动卡住往往是“线程堆栈 + 配置 + 初始化时序”的组合题。Agent 的价值在于能把“你脑中隐含的排障套路”显式化，并用最短路径把证据补齐。

**3.2 一句话：获取 JVM 信息并做健康摘要**

你说：现在可以获取 jvm 信息不

Agent 输出（摘要化展示）：

- 运行时环境：JDK 版本、启动时间、CPU 核数与负载；
    
- 内存：-Xms/-Xmx、堆/非堆使用、Metaspace 指标；
    
- GC：G1GC 的 Young/Concurrent/Old 次数与耗时、GC 日志路径；
    
- 线程：线程数、守护线程、死锁检查结论；
    

没有 AI 时你可能也能跑出 jvm，但“读懂它、总结成可行动结论”往往要再花 10 分钟。Agent 把这 10 分钟省掉，并告诉你下一步应该把火力用在哪个方向。

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1wKGMaoALD21ibpmgUIEuqhdhLgebIJuz4K1qYxuDdIqkpPXib4fE9ZghfyevmYZKypnj8KSR3NeO09vffjk3ia2A4iasekDpuJrjg/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=8)

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1wia8ovPj4jkWibL9W7Bl1ArQyic6Hdl8v3j2xaX7BBBzoCk9jj5u8BuDanQRUP7ZTJ9t2MAsbCyfkqrpqpYVPhVXq2VCOSVfUKyQ/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=9)

**3.3 一句话：在线读取 Spring 配置 server.port**

**（不改代码、不重启）**

你说：获取 spring 配置 server.port 值

3.3.1 没有 AI 时，你很容易绕路

这件事看起来简单，但经常会踩坑：

- 你去翻配置文件：application.yml/application.properties，但线上可能来自配置中心/环境变量/启动参数覆盖；
    
- 你去看启动参数：-Dserver.port=...，但容器/启动脚本可能又做了二次注入；
    
- 你去看监听端口：netstat/ss，但应用可能有多个 connector，或者端口被 sidecar/代理转发；
    

换句话说：你想要的不是“文件里写了什么”，而是运行时 Spring Environment 里最终生效的值。

3.3.2 来看看 AI 能不能做到：Skill-first 的标准剧本

在真实历史记录里，Agent 的推进是：

- 识别这是 Spring 上下文配置排查；
    
- 匹配到内置 Skill（排障剧本），并先读取 skill 文档再行动（保证安全与正确性）；
    
- 使用 vmtool 获取 ApplicationContext，调用 getEnvironment().getProperty("server.port") 拿到最终生效值；
    
- 解释“这个值可能来自哪些配置源”；如果你要追溯来源，它会给出下一步（查来源）的命令建议；
    

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1ymdZfsyCJxDib3DaoUl7WOjFlftomtNyo0xJxTrk7F5X84BRb0ws4sPibJBN8eJupQLdZkNxkNiax9b5jRdm1Hehesb6wnWouEZ8/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=10)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1zXViagD4XUPicC17TfQEzUlGicWiaxsgjbReqdUMg23fjJ07ia0DmUyngh3wFPnhicTRzauAQ3WowwPFA79WWrJh4Tm0kRD5ibEicvog8/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=11)

**3.4 一句话：**

**getstatic 读取“静态字段/嵌套字段”，并做对比分析**

你说：getstatic com.example.ConfigRepo configuration 'defaultRatio'（示例）

Agent 的处理要点：

- 识别这是“明确指令型（模式 A）”，可以直接执行
    
- 当你访问嵌套字段时，自动提醒/采用 OGNL 方式读取
    
- 同一配置重复查询时，会提醒“结果发生变化”，提示可能存在动态刷新/热更新，并给出下一步建议（比如追踪是谁改的）
    

这类需求在排查“开关/灰度/采样比例/动态配置”时非常常见：你只要说出类与字段，Agent 帮你把结果读出来并解释它意味着什么。

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1znf9CcNuCsqgVDsnavY6ib60HQxvewFsctiaWlkkx95DBYCe0U8G0tniaWOkkia6fGHEpYB7MDMSyx3ms2Xdb5v6e0OnTVuTQE2Tc/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=12)

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1yTF1QaWvxOgoCFhMuHPqlbntRQCE7j5u7DvIic8kjsJ2ial33mUzb8b4r9kydUzeFOxibBAdDaDLWkUb1ly9nQzAicLNNYE9wVCJc/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=13)

**3.5 一句话：watch 只观察“特定类型/特定场景”的调用（OGNL 条件过滤）**

你说：watch 方法怎么限制只针对特定类型使用？

Agent 给出：

- 核心机制：-c/--condition 写 OGNL 条件，只输出满足条件的调用
    
- 典型写法：按参数类型、接口/父类、返回值类型过滤
    
- 强提醒：OGNL 必须使用英文单引号包裹 '...'
    

示例：

```
# 只看第一个参数是某个类型的调用
```

你不再需要记住 OGNL 语法细节，告诉它你想“过滤什么”，它给你一条能直接复制执行的命令。

**3.6 长流程示例：CPU 飙高排查**

**（从“哪个线程”到“哪段代码”）**

> 我们构造了一个由于正则表达式递归导致的CPU增高场景。看看Arthas能不能找到原因。

你说：现在 CPU 使用率很高，帮我查查是哪个线程导致的？

3.6.1 没有 AI 时，资深同学会怎么推进（典型 10～20 分钟链路）

CPU 高的排查，真正难的不是“找到 CPU 高”，而是从“现象”收敛到“能改的代码点”。常见的专家流程是：

- Step 0：先确认是不是误报/外因
    

- 系统负载、容器限额、是否有压测/流量激增、是否是 GC 频繁导致 CPU 被 GC 吃掉；
    

- Step 1：看整体面（低风险）
    

- dashboard：CPU/线程/GC 概况，先判断是“忙”还是“堵”；
    

- Step 2：定位最忙线程（关键）
    

- thread -n 3 或 thread -n 5：拿到最忙线程的堆栈；
    

- Step 3：读堆栈，把方法归类
    

- 如果堆栈在序列化/正则/日志格式化 → 计算型热点；
    
- 如果堆栈大量 BLOCKED → 锁竞争/排队型热点；
    
- 如果堆栈看起来“很正常但 CPU 仍高” → 可能是热点在 native/或采样点没踩中，需要更精确观察；
    

- Step 4：收敛到目标方法（按需）
    

- 选一个堆栈里最像业务关键路径的方法，进一步用 trace 验证调用链与耗时分布；
    

- 如果需要看入参/返回值，再用 watch/tt，但必须限量，避免线上刷屏；
    

- Step 5：产出结论
    

- 证据：dashboard 摘要 + top 线程堆栈关键片段 + trace 的慢点；
    
- 建议：缓存/限流/降级/修算法/减少日志/拆锁/优化序列化等；
    

3.6.2 来看看 AI 能不能做到：一条问题触发 arthas-cpu-high 剧本

Arthas Agent 会把这类问题自动匹配到内置 Skill：arthas-cpu-high，并按Skill内容推进：

- 先 dashboard 拿整体面
    
- 再 thread 找 topN 热点线程并抓堆栈
    
- 再把堆栈里的方法提炼成“下一步最值得 trace/watch 的候选点”
    
- 最终输出结构化报告（并且在每一步提醒限量与风险）
    

先读取了技能。

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1xXTSNrAib5LeSAzN0dsMicrLJUfkSnQNNuBibibZ6r8Nb5x5eEr8XKB5WEoKLklcXE8UFaibEovFDJDjjfE003UCVZksEwecD4e1uE/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=14)

![图片](https://mmbiz.qpic.cn/sz_mmbiz_png/j7RlD5l5q1yNaS96oQY2OypUCr4rESPNFicpmtLhibQbfr91wEkSO3HOAcs5U40JCBhNFIBbYYB9iaibvD8s5Zwjlo6sXZmUjiaSkvd4Fbh9WB8Q/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=15)

4. 我们为什么说：这是“最懂 Java”的诊断 Agent

不是因为它会背命令，而是因为它把 Java 线上诊断里的关键难点做成了“产品能力”。

- 懂排障节奏：先低风险取证（dashboard/thread/jvm），再逐步收敛到 trace/watch/tt
    
- 懂工程边界：默认限量、避免刷屏；高影响命令必须明确授权
    
- 懂 Spring 体系：优先只读验证（contains/beanNames/type/environment），避免 getBean() 触发副作用
    
- 懂链路定位：把“拿 traceId + 看慢点在哪”合并成一条可执行路径（Skill 剧本）
    
- 懂上下文管理：用 log_reader 子 Agent 专门做“长日志/堆栈”分析，避免主对话被噪声淹没
    

再补一句“工程同学最关心的”：它不会上来就乱跑。

信息不足时它会先问清楚；需要高影响操作时会先解释风险并要求明确授权；默认每轮只推进 1～2 个低风险步骤，避免线上被“刷屏式诊断”二次伤害。

5. 使用帮助

那么这么好用的AI Agent在哪里可以用到呢？

打开Arthas在线诊断网页，再选择IP，Attach 之后就可以直接提问。

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1zibyCwEGjG1AJUPaiamkru4n1dEG5ZHKVO5x8bUnJjcamUaTdnrzIFNGGhsXo3gc4hYR3DBznib2ric4XkSDQiceAcibyyJ0jUibwFII/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=16)

![图片](https://mmbiz.qpic.cn/mmbiz_png/j7RlD5l5q1wQia6GC7Uuul0wk3ibtiaBQ3S60ebibYmKibYOM9zgctlcnF9XTDBk128RMM2xXSQJ2bjEK2oIZXAjViaSaPcvQdweEiaE6uib2UUBE2g/640?wx_fmt=png&from=appmsg&tp=webp&wxfrom=5&wx_lazy=1#imgIndex=17)

**5.1 怎么开始**

一般推荐两段式：

- 第 1 段：先 Attach / 确认目标 JVM（可由启动/Attach Agent 协助完成，输出 PID 与摘要）
    
- 第 2 段：把具体问题交给 Arthas Agent 诊断
    

**5.2 如何提问（Prompt 指南）**

你可以像与同事交谈一样与 Copilot 对话。以下是几种典型的提问模式：

A. 明确指令型

当你清楚知道要做什么，但记不住具体命令参数时：

- “反编译 com.example.UserController 类。”
    
- “帮我查看 com.service.OrderService 的 createOrder 方法的入参和返回值。”
    
- “检测一下现在的 JVM 线程情况。”
    

B. 现象咨询型（推荐）

当你遇到线上问题，需要排查思路时：

- CPU 问题：“现在 CPU 使用率很高，帮我查查是哪个线程导致的？”
    
- 性能问题：“queryUserInfo 这个接口偶尔特别慢，怎么排查是卡在哪里了？”
    
- 死锁问题：“服务好像卡住了，没反应，是不是死锁了？”
    
- 逻辑问题：“代码里的 if (user.vip) 分支好像一直没进去，帮我看看运行时的变量值。”
    

C. 模糊查询型

当你不知道具体的类全名时：

- “帮我找一下类似 OrderController 的类有哪些？”
    
- “我想看下 redis 相关的配置类。”
    

（注：Agent 会先尝试通过安全的方式探测类名，然后引导你进一步操作）

**5.3 交互流程**

- 提出需求：在输入框描述你的问题。
    
- 方案生成：Agent 会分析意图，给出一组推荐的 Arthas 命令，并解释每一步的用途。
    
- 执行与反馈：
    

- Agent 可能会询问：“是否授权我执行？”
    
- 或建议你：“请执行以下命令，并将结果贴给我。”
    

- 多轮诊断：对于复杂问题（如性能优化），Agent 会根据第一步的输出结果（如线程栈），动态调整下一步的命令（如 trace 具体方法），逐步收敛直到找到根因。
    

6. 小建议：让 Agent 更快更准的 4 条信息

如果你愿意多给一点点上下文，排障速度会明显提升：

- 目标范围：应用主包名（例如 com.mycompany）、模块名、接口名；
    
- 现象时间：大概从什么时候开始、是否持续、是否能复现；
    
- 影响面：影响的接口/用户比例、是否伴随错误码/异常栈；
    
- 你最关心的结论：要根因、临时止血方案、还是长期治理建议；
    

7. 结语：把“会用 Arthas”变成“每个人都能用好 Arthas”

Arthas 让我们能在生产环境里“看见运行中的 Java”。

Arthas Agent 则让这种能力从“少数专家的手艺”变成“每个工程师都能复用的流程”：

- 你说现象，它给路径
    
- 你给线索，它补证据
    
- 你要结论，它写报告
    

如果你愿意，把你最常见的排障场景告诉我们：我们会把它们沉淀成新的 Skills，让下一次“一句话排障”覆盖更多问题。