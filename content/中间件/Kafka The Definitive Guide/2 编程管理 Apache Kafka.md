# 2 编程管理 Apache Kafka

> **Early Release 读者请注意**
>
> Early Release 电子书让你在书籍正式发布之前就能接触到作者原始、未经编辑的内容，以便你能尽早利用这些技术。本章将是最终版书籍的第 5 章。
>
> 如果你对如何改进本书内容和/或示例有意见，或者发现本章中有缺失的内容，请通过 cshapi+ktdg@gmail.com 联系作者。

有很多 CLI 和 GUI 工具可以用来管理 Kafka（我们将在第 9 章中讨论它们），但有时你也需要从客户端应用程序中执行一些管理命令。根据用户输入或数据动态创建新主题是一个特别常见的用例：IoT 应用程序经常从用户设备接收事件，并根据设备类型将事件写入不同的主题。如果制造商生产了一种新类型的设备，你要么需要通过某种流程记住手动创建主题，要么让应用程序在收到无法识别的设备类型事件时动态创建新主题。第二种方案有缺点，但在合适的场景下，避免依赖额外的流程来生成主题是一个有吸引力的特性。

Apache Kafka 在 0.11 版本中添加了 **AdminClient**，为以前通过命令行完成的**管理功能**提供了编程式 API：列出、创建和删除主题，描述集群，管理 ACL 以及修改配置。

举个例子：你的应用要向一个特定主题生产事件。这意味着在生产第一条事件之前，主题必须存在。在 Apache Kafka 添加 AdminClient 之前，选项很少，而且都不太友好：你可以从 `producer.send()` 方法中捕获 `UNKNOWN_TOPIC_OR_PARTITION` 异常，并让用户知道需要创建主题；或者寄希望于你正在写入的 Kafka 集群启用了自动主题创建；或者尝试依赖内部 API，并承担无兼容性保证的后果。现在 Apache Kafka 提供了 AdminClient，有了一个好得多的解决方案：使用 AdminClient **检查主题是否存在**，如果不存在，就当场创建它。

在本章中，我们将先对 AdminClient 进行概述，然后深入了解如何在应用程序中使用它的细节。我们将重点关注最常用的功能——**主题管理、消费者组管理和实体配置**。

## AdminClient 概述

当开始使用 Kafka 的 AdminClient 时，了解其核心设计原则会很有帮助。当你理解了 AdminClient 的设计方式以及应该如何使用它时，每个方法的具体细节就会直观得多。

### 异步和最终一致性 API

关于 Kafka AdminClient 需要理解的最重要的一点可能是：**它是异步的**。每个方法在向集群 Controller 交付请求后立即返回，每个方法返回一个或多个 **Future 对象**。Future 对象是异步操作的结果，它们提供检查异步操作状态、取消操作、等待完成以及在完成后执行函数的方法。Kafka 的 AdminClient 将 Future 对象包装成 **Result 对象**，提供了等待操作完成的方法和常见后续操作的辅助方法。例如，`KafkaAdminClient.createTopics` 返回 `CreateTopicsResult` 对象，它让你可以等待所有主题创建完成，单独检查每个主题的状态，还可以在创建后检索特定主题的配置。

由于 Kafka 将元数据从 Controller 传播到 Broker 的过程是异步的，AdminClient API 返回的 Future 被认为是**在 Controller 状态完全更新后完成**的。此时可能并非每个 Broker 都知道新状态，因此 `listTopics` 请求可能被一个尚未更新的 Broker 处理，因而可能不会包含刚刚创建的主题。这种属性也被称为**最终一致性**——最终每个 Broker 都会知道每个主题，但我们无法精确保证这何时发生。

### Options

AdminClient 中的每个方法都接受一个特定于该方法的 **Options 对象**作为参数。例如，`listTopics` 方法接受 `ListTopicsOptions` 对象作为参数，`describeCluster` 接受 `DescribeClusterOptions` 作为参数。这些对象包含请求如何被 Broker 处理的**不同设置**。所有 AdminClient 方法共有的一个设置是 `timeoutMs`——这控制客户端在抛出 `TimeoutException` 之前等待集群响应的时间。这限制了你应用程序可能被 AdminClient 操作阻塞的时间。其他选项包括 `listTopics` 是否也应返回内部主题，以及 `describeCluster` 是否也应返回客户端被授权在集群上执行的操作。

### 扁平化层级

Apache Kafka 协议支持的所有管理操作都直接在 `KafkaAdminClient` 中实现。没有对象层级结构或命名空间。这有点争议，因为接口可能相当大，也许有点让人不知所措，但主要好处是，如果你想知道如何以编程方式在 Kafka 上执行任何管理操作，你只有一个 JavaDoc 需要搜索，而且你 IDE 的自动完成会很方便。你不需要担心自己是不是错过了正确的查找位置。如果它不在 AdminClient 中，那就是**还没有实现**（但欢迎贡献！）。

> **提示**
>
> 如果你有兴趣为 Apache Kafka 做贡献，可以查看我们的《如何贡献指南》。从较小的、无争议的 bug 修复和改进开始，然后再处理架构或协议的更大变更。非代码贡献，如 bug 报告、文档改进、回答问题和博客文章也同样受到鼓励。

### 补充说明

- 所有修改集群状态的操作——`create`、`delete` 和 `alter`——都由 **Controller** 处理。
- 读取集群状态的操作——`list` 和 `describe`——可以由**任意 Broker** 处理，并定向到负载最低的 Broker（基于客户端所知道的信息）。
- 这不应该影响你作为 API 用户的使用体验，但了解这些是有好处的——以防你看到意外行为，注意到某些操作成功而其他操作失败，或者在试图弄清楚为什么某个操作耗时过长。
- 在撰写本章时（Apache Kafka 2.5 即将发布），大多数管理操作可以通过 AdminClient 执行，也可以直接通过修改 Zookeeper 中的集群元数据来执行。我们**强烈建议你永远不要直接使用 Zookeeper**，如果你绝对必须这样做，请将此报告为 Apache Kafka 的一个 bug。原因是，在不久的将来，Apache Kafka 社区将**移除 Zookeeper 依赖**，每个直接使用 Zookeeper 进行管理操作的应用程序都将不得不被修改。而 AdminClient API 将保持完全不变，只是在 Kafka 集群内部有不同的实现。

## AdminClient 生命周期：创建、配置和关闭

为了使用 Kafka 的 AdminClient，你需要做的第一件事是构造一个 AdminClient 类的实例。这非常简单：

```java
Properties props = new Properties();
props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
AdminClient admin = AdminClient.create(props);
// TODO: 用 AdminClient 做一些有用的事
admin.close(Duration.ofSeconds(30));
```

静态方法 `create` 接受一个包含配置的 `Properties` 对象作为参数。唯一**必需**的配置是集群的 URI——一个以逗号分隔的要连接的 Broker 列表。和往常一样，在生产环境中，你需要指定至少 3 个 Broker，以防其中一个当前不可用。我们将在 Kafka 安全章节中单独讨论如何配置安全和认证连接。

如果你启动了一个 AdminClient，最终需要关闭它。重要的是要记住，当你调用 `close` 时，可能还有一些 AdminClient 操作正在进行中。因此，`close` 方法接受一个**超时参数**。一旦你调用 `close`，你就不能再调用任何其他方法或发送任何更多请求，但客户端将等待响应直到超时过期。超时过期后，客户端将以超时异常中止所有正在进行的操作并释放所有资源。不带超时调用 `close` 意味着你将**等待任意长的时间**直到所有正在进行的操作完成。

### client.dns.lookup

你也许记得第 3 章和第 4 章中 `KafkaProducer` 和 `KafkaConsumer` 有相当多的重要配置参数。好消息是 AdminClient 简单得多，没有太多需要配置的。你可以在 Kafka 配置文档中阅读所有配置参数。我们认为重要的配置参数是：

此配置在 Apache Kafka 2.1.0 版本中引入。

默认情况下，Kafka 基于引导服务器配置中提供的主机名（以及后续 Broker 在 `advertised.listeners` 配置中指定的名称）来验证、解析和创建连接。这种简单模型在大多数情况下都有效，但无法覆盖两个重要的用例——**DNS 别名的使用**（特别是在引导配置中）和**使用映射到多个 IP 地址的单个 DNS**。这些听起来相似，但略有不同。让我们更详细地看看这两种互斥的场景。

#### DNS 别名使用

假设你有多个 Broker，采用以下命名约定：`broker1.hostname.com`、`broker2.hostname.com` 等。你可能不想在引导服务器配置中指定所有这些——这很容易变得难以维护——而是希望创建一个单一的 DNS 别名来映射到所有这些 Broker。你将使用 `all-brokers.hostname.com` 进行引导连接，因为你并不关心哪个 Broker 处理来自客户端的初始连接。这非常方便，**除非你使用 SASL 进行认证**。如果你使用 SASL，客户端将尝试认证 `all-brokers.hostname.com`，但服务器主体将是 `broker2.hostname.com`，如果名称不匹配，SASL 将拒绝认证（因为 Broker 证书可能是中间人攻击），连接将失败。

在这种情况下，你需要使用 `client.dns.lookup=resolve_canonical_bootstrap_servers_only`。使用此配置，客户端将"展开" DNS 别名，结果将与你将 DNS 别名连接的所有 Broker 名称作为原始引导列表中的 Broker 包含在内一样。

#### 多 IP 地址的 DNS 名称

在现代网络架构中，将所有 Broker 放在代理或负载均衡器后面是很常见的。如果你使用 Kubernetes，这一点尤其常见——负载均衡器是允许从 Kubernetes 集群外部进行连接所必需的。在这些情况下，你不希望负载均衡器成为单点故障。因此，让 `broker1.hostname.com` 指向一组 IP 列表是非常常见的做法——所有这些 IP 都解析到负载均衡器，所有负载均衡器都将流量路由到同一个 Broker。这些 IP 也可能随着时间推移而改变。默认情况下，KafkaClient 只会尝试连接主机名解析的第一个 IP。这意味着如果那个 IP 变得不可用，客户端将无法连接，即使 Broker 完全可用。因此，**强烈建议**使用 `client.dns.lookup=use_all_dns_ips` 来确保客户端不会错过高可用负载均衡层带来的好处。

### request.timeout.ms

此配置限制了你的应用程序花费在等待 AdminClient 响应上的时间。这包括在客户端收到可重试错误时花费在重试上的时间。默认值是 **120 秒**，这相当长——但一些 AdminClient 操作（特别是消费者组管理命令）可能需要一段时间才能响应。正如我们在概述部分提到的，每个 AdminClient 方法接受一个 Options 对象，其中可以包含一个专门适用于该调用的超时值。如果 AdminClient 操作在你的应用程序的关键路径上，你可能希望使用较低的超时值，并以不同的方式处理 Kafka 未及时响应的情况。一个常见的例子是：服务在首次启动时尝试验证特定主题的存在，但如果 Kafka 花费超过 30 秒才能响应，你可能希望继续启动服务器，稍后再验证主题的存在（或者完全跳过此验证）。

## 主题管理基础

现在我们已经创建并配置了 AdminClient，是时候看看我们可以用它做什么了。Kafka AdminClient 最常见的用例是主题管理。这包括列出主题、描述主题、创建主题和删除主题。

让我们从列出集群中的所有主题开始：

```java
ListTopicsResult topics = admin.listTopics();
topics.names().get().forEach(System.out::println);
```

注意，`admin.listTopics()` 返回 `ListTopicsResult` 对象，它是对一组 Future 的薄封装。`topics.names()` 返回一个 Future 名称集合。当我们在这个 Future 上调用 `get()` 时，执行线程将等待直到服务器响应主题名称集合，或者我们收到超时异常。一旦我们获得列表，我们就迭代它以打印所有主题名称。

现在让我们尝试一些更有野心的事情：检查一个主题是否存在，如果不存在就创建它。检查特定主题是否存在的一种方法是获取所有主题的列表并检查你需要的主题是否在列表中。但在大型集群上，这可能效率低下。此外，有时你需要检查的不仅仅是主题是否存在——你需要确保主题具有正确数量的分区和副本。例如，Apache Kafka Connect 和 Confluent Schema Registry 使用 Kafka 主题来存储配置。当它们启动时，它们会检查配置主题是否存在，是否**只有一个分区**以保证配置更改严格按照顺序到达，是否**有三个副本**以保证可用性，以及主题是否**被配置为 compacted**，以便旧配置可以无限期保留。

```java
DescribeTopicsResult demoTopic = admin.describeTopics(TOPIC_LIST);

try {
    topicDescription = demoTopic.values().get(TOPIC_NAME).get();
    System.out.println("Description of demo topic:" + topicDescription);

    if (topicDescription.partitions().size() != NUM_PARTITIONS) {
        System.out.println("Topic has wrong number of partitions");
        System.exit(-1);
    }
} catch (ExecutionException e) {

    // 对几乎所有异常提前退出
    if (! (e.getCause() instanceof UnknownTopicOrPartitionException)) {
        e.printStackTrace();
        throw e;
    }

    // 如果执行到这里说明主题不存在
    System.out.println("Topic " + TOPIC_NAME +
        " does not exist. Going to create it now");
    // 注意分区数和副本数是可选的。如果未指定，将使用 Kafka Broker 上配置的默认值
    CreateTopicsResult newTopic = admin.createTopics(Collections.singletonList(
            new NewTopic(TOPIC_NAME, NUM_PARTITIONS, REP_FACTOR)));

    // 检查主题是否正确创建：
    if (newTopic.numPartitions(TOPIC_NAME).get() != NUM_PARTITIONS) {
        System.out.println("Topic has wrong number of partitions");
        System.exit(-1);
    }
}
```

为了检查主题是否存在且具有正确的配置，我们**调用 `describeTopics()`** 并传入我们想要验证的主题名称列表。这返回一个 `DescribeTopicResult` 对象，它包装了从主题名称到 Future 描述的映射。

我们已经看到，如果我们通过 `get()` 等待 Future 完成，我们可以获得我们想要的结果——在本例中是一个 `TopicDescription`。但也存在服务器无法正确完成请求的可能性——如果主题不存在，服务器就无法返回其描述。在这种情况下，服务器将返回一个错误，Future 将通过抛出 `ExecutionException` 来完成。服务器发送的实际错误将是异常的原因。由于我们想要处理主题不存在的情况，我们就处理这些异常。

如果主题确实存在，Future 通过返回一个 `TopicDescription` 来完成，其中包含主题所有分区的列表，以及每个分区哪个 Broker 是 Leader、副本列表以及 ISR（In-Sync Replica，同步副本）列表。注意，这**不包括主题的配置**。我们将在本章后面讨论配置。

注意，当 Kafka 返回错误时，所有 AdminClient Result 对象都会抛出 `ExecutionException`。这是因为 AdminClient Result 是包装的 Future 对象，而 Future 会包装异常。你总是需要检查 `ExecutionException` 的原因来获取 Kafka 返回的错误。

如果主题不存在，我们就创建一个新主题。创建主题时，你可以**只指定名称**并对其余所有详情使用默认值。你也可以指定分区数、副本数和配置。

最后，你需要等待主题创建返回，也许还要验证结果。在本例中，我们检查分区数。由于我们在创建主题时指定了分区数，我们可以相当确定它是正确的。如果你在创建主题时依赖 Broker 的默认值，检查结果会更加常见。注意，由于我们再次调用 `get()` 来检查 `CreateTopic` 的结果，此方法可能抛出异常。`TopicExistsException` 在这种场景中很常见，你需要处理它（也许是通过描述主题来检查配置是否正确）。

现在我们有了一个主题，让我们删除它：

```java
admin.deleteTopics(TOPIC_LIST).all().get();

// 检查它是否消失了。注意，由于 Kafka 的异步特性，
// 此时主题可能仍然存在
try {
    topicDescription = demoTopic.values().get(TOPIC_NAME).get();
    System.out.println("Topic " + TOPIC_NAME + " is still around");
} catch (ExecutionException e) {
    System.out.println("Topic " + TOPIC_NAME + " is gone");
}
```

此时这段代码应该很熟悉了。我们调用 `deleteTopics` 方法并传入要删除的主题名称列表，然后使用 `get()` 等待其完成。

> **警告**
>
> 虽然代码很简单，但请记住，在 Kafka 中，主题删除是**不可逆的**——没有"回收站"或"垃圾桶"来帮助你恢复已删除的主题，也没有任何检查来验证主题是否为空以及你是否真的想要删除它。删除错误的主题可能意味着**不可恢复的数据丢失**——因此请格外小心地处理此方法。

### 异步处理 AdminClient 请求

到目前为止，所有示例都使用了在不同 AdminClient 方法返回的 Future 上调用阻塞式 `get()`。大多数情况下，这就是你需要的一切——管理操作很少发生，通常等待直到操作成功或超时是可以接受的。有一个例外——如果你正在编写一个需要处理大量管理请求的服务器。在这种情况下，你不希望在等待 Kafka 响应时阻塞服务器线程。你希望继续接受来自用户的请求，将它们发送到 Kafka，当 Kafka 响应时，将响应发送给客户端。在这些场景中，`KafkaFuture` 的灵活性变得非常有用。这是一个简单的例子：

```java
vertx.createHttpServer().requestHandler(request -> {

    String topic = request.getParam("topic");

    String timeout = request.getParam("timeout");
    int timeoutMs = NumberUtils.toInt(timeout, 1000);

    DescribeTopicsResult demoTopic = admin.describeTopics(
            Collections.singletonList(topic),
            new DescribeTopicsOptions().timeoutMs(timeoutMs));

    demoTopic.values().get(topic).whenComplete(

            new KafkaFuture.BiConsumer<TopicDescription, Throwable>() {
                @Override
                public void accept(final TopicDescription topicDescription,
                                   final Throwable throwable) {
                    if (throwable != null) {
                        request.response().end("Error trying to describe topic "
                                + topic + " due to " + throwable.getMessage());
                    } else {
                        request.response().end(topicDescription.toString());
                    }
                }
            });
}).listen(8080);
```

我们使用 Vert.X 来创建一个简单的 HTTP 服务器。
每当此服务器收到请求时，它就会调用我们在此处定义的 `requestHandler`。
请求包含主题名称作为参数，我们将用该主题的描述来响应。
我们照常调用 `AdminClient.describeTopics()` 并获得一个包装的 Future 作为响应。
但我们没有使用阻塞式 `get()` 调用，而是构造了一个函数，该函数将在 Future 完成时被调用。
如果 Future 以异常完成，我们向 HTTP 客户端发送错误。
如果 Future 成功完成，我们向客户端响应主题描述。

这里的关键是，我们**不是在等待** Kafka 的响应。当来自 Kafka 的响应到达时，`DescribeTopicResult` 将把响应发送给 HTTP 客户端。与此同时，HTTP 服务器可以继续处理其他请求。你可以通过使用 `SIGSTOP` 来暂停 Kafka（不要在生产环境中尝试！）并向 Vert.X 发送两个 HTTP 请求——一个带有长的超时值，一个带有短的超时值——来检查此行为。即使你在第一个请求之后发送了第二个请求，由于较短的超时值，第二个请求也会更早响应，而不会被阻塞在第一个请求后面。

## 配置管理

配置管理通过描述和更新 **ConfigResource** 的集合来完成。Config 资源可以是 Broker、Broker 日志器和主题。检查和修改 Broker 及 Broker 日志配置通常通过 `kafka-config.sh` 或其他 Kafka 管理工具来完成，但从使用它们的应用程序中检查和更新主题配置是相当常见的做法。

例如，许多应用程序依赖 compacted 主题来保证其正确运行。这些应用程序应定期（比默认保留期更频繁，只是为了安全起见）检查主题是否确实被配置为 compacted，并在情况不符时采取行动纠正主题配置。

以下是一个如何做到这一点的示例：

```java
ConfigResource configResource =
        new ConfigResource(ConfigResource.Type.TOPIC, TOPIC_NAME);
DescribeConfigsResult configsResult =
        admin.describeConfigs(Collections.singleton(configResource));
Config configs = configsResult.all().get().get(configResource);

// 打印非默认配置
configs.entries().stream().filter(
        entry -> !entry.isDefault()).forEach(System.out::println);

// 检查主题是否被 compacted
ConfigEntry compaction = new ConfigEntry(TopicConfig.CLEANUP_POLICY_CONFIG,
        TopicConfig.CLEANUP_POLICY_COMPACT);
if (! configs.entries().contains(compaction)) {
    // 如果主题不是 compacted，将其设置为 compacted
    Collection<AlterConfigOp> configOp = new ArrayList<AlterConfigOp>();
    configOp.add(new AlterConfigOp(compaction, AlterConfigOp.OpType.SET));
    Map<ConfigResource, Collection<AlterConfigOp>> alterConf = new HashMap<>();
    alterConf.put(configResource, configOp);
    admin.incrementalAlterConfigs(alterConf).all().get();
} else {
    System.out.println("Topic " + TOPIC_NAME + " is compacted");
}
```

如上所述，有**多种类型的 ConfigResource**，这里我们正在检查特定主题的配置。你可以在同一个请求中指定多个不同类型的不同资源。

`describeConfigs` 的结果是从每个 ConfigResource 到配置集合的映射。每个配置条目都有 `isDefault()` 方法，让我们知道哪些配置被修改过。如果用户将主题配置为非默认值，或者 Broker 级别的配置被修改并且创建的主题从 Broker 继承了此非默认值，则主题配置被视为非默认。

为了修改配置，你需要指定一个要修改的 ConfigResource 的映射和一组操作。每个配置修改操作由配置条目（即配置名称和值，本例中 `cleanup.policy` 是配置名称，`compacted` 是值）和**操作类型**组成。Kafka 中有**四种类型**的修改配置操作：`SET`——设置配置值；`DELETE`——移除值并重置为默认值；`APPEND` 和 `SUBTRACT`——仅适用于 List 类型的配置，允许在无需每次向 Kafka 发送整个列表的情况下向列表添加和移除值。

描述配置在紧急情况下可以出人意料地**有用**。我记得有一次在升级过程中，Broker 的配置文件被意外替换成了损坏的副本。这是在重启第一个 Broker 并发现其无法启动后发现的。团队没有办法恢复原始配置，我们做好了在尝试重建正确配置并进行大量试错的准备。一位 SRE（站点可靠性工程师）通过连接到其中一台仍然存活的 Broker 并使用 AdminClient **导出了其配置**，从而挽救了局面。

## 消费者组管理

我们之前提到过，与大多数消息队列不同，Kafka 允许你以与之前消费和处理完全相同的顺序**重新处理数据**。在第 4 章中，当我们讨论消费者组时，我们解释了如何使用 Consumer API 返回并重新读取主题中的旧消息。但是，使用这些 API 意味着你**提前将重新处理数据的能力编程到了你的应用程序中**。你的应用程序本身必须暴露"重新处理"的功能。

在一些场景中，即使这种能力没有事先内置到应用程序中，你也会希望让应用程序重新处理消息。在事故中对故障应用程序进行故障排查就是这样的场景之一。另一种场景是在灾难恢复故障切换场景中，准备让应用程序开始在新集群上运行（我们将在第 9 章中讨论灾难恢复技术时更详细地讨论这一点）。

在本节中，我们将介绍如何使用 AdminClient **以编程方式探索和修改消费者组**以及这些组提交的偏移量。在第 10 章中，我们将介绍可用的外部工具来执行相同的操作。

### 探索消费者组

如果你想探索和修改消费者组，第一步是列出它们：

```java
admin.listConsumerGroups().valid().get().forEach(System.out::println);
```

注意，通过使用 `valid()` 方法，`get()` 将返回的集合仅包含集群返回时**没有任何错误**的消费者组。任何错误都将被完全忽略，而不是作为异常抛出。`errors()` 方法可以用来获取所有异常。如果你像在其他示例中那样使用 `all()`，只有集群返回的**第一个错误**会被作为异常抛出。此类错误的可能原因是授权——当你没有权限查看该组的时候——或者某些消费者组的 Coordinator 不可用。

如果我们想要关于某些组的更多信息，我们可以描述它们：

```java
ConsumerGroupDescription groupDescription = admin
        .describeConsumerGroups(CONSUMER_GRP_LIST)
        .describedGroups().get(CONSUMER_GROUP).get();
System.out.println("Description of group " + CONSUMER_GROUP
        + ":" + groupDescription);
```

描述包含了关于组的**丰富信息**。这包括组成员及其标识符和主机、分配给它们的分区、用于分配的算法以及组 Coordinator 的主机。此描述在排查消费者组问题时非常有价值。然而，此描述中缺少了关于消费者组最重要的一条信息——不可避免地，我们想要知道该组在它正在消费的每个分区上最后提交的偏移量是多少，以及它与日志中最新的消息相差多少（即滞后量）。

在过去，获取此信息的唯一方法是解析消费者组写入内部 Kafka 主题的提交消息。虽然这种方法达成了其目的，但 Kafka 不保证内部消息格式的兼容性，因此不推荐使用旧方法。我们将看看 Kafka 的 AdminClient 如何让我们检索此信息：

```java
Map<TopicPartition, OffsetAndMetadata> offsets =
        admin.listConsumerGroupOffsets(CONSUMER_GROUP)
                .partitionsToOffsetAndMetadata().get();

Map<TopicPartition, OffsetSpec> requestLatestOffsets = new HashMap<>();

for(TopicPartition tp: offsets.keySet()) {
    requestLatestOffsets.put(tp, OffsetSpec.latest());
}

Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> latestOffsets =
        admin.listOffsets(requestLatestOffsets).all().get();

for (Map.Entry<TopicPartition, OffsetAndMetadata> e: offsets.entrySet()) {
    String topic = e.getKey().topic();
    int partition =  e.getKey().partition();
    long committedOffset = e.getValue().offset();
    long latestOffset = latestOffsets.get(e.getKey()).offset();

    System.out.println("Consumer group " + CONSUMER_GROUP
            + " has committed offset " + committedOffset
            + " to topic " + topic + " partition " + partition
            + ". The latest offset in the partition is "
            +  latestOffset + " so consumer group is "
            + (latestOffset - committedOffset) + " records behind");
}
```

我们检索消费者组处理的所有主题和分区的映射，以及每个分区的**最新提交偏移量**。注意，与 `describeConsumerGroups` 不同，`listConsumerGroupOffsets` 只接受**单个**消费者组，而不是集合。

对于结果中的每个主题和分区，我们想要获取分区中最后一条消息的偏移量。`OffsetSpec` 有三个非常方便的实现——`earliest()`、`latest()` 和 `forTimestamp()`——这些允许我们获取分区中最早和最新的偏移量，以及在指定时间或之后立即写入的记录的偏移量。

最后，我们迭代所有分区，对于每个分区打印最后提交的偏移量、分区中的最新偏移量以及它们之间的**滞后量**。

### 修改消费者组

到目前为止，我们只是探索了可用的信息。AdminClient 也有修改消费者组的方法——删除组、移除成员、删除已提交的偏移量以及修改偏移量。这些通常被 SRE 用于构建临时的工具来从紧急情况中恢复。

在所有方法中，**修改偏移量**是最有用的。删除偏移量可能看起来是让消费者"从头开始"的简单方法，但这实际上取决于消费者的配置——如果消费者启动时没有找到偏移量，它会从开头开始吗？还是跳到最新的消息？除非我们有消费者的代码，否则我们无法知道。**显式地将已提交的偏移量修改为最早可用的偏移量**将强制消费者从主题的开头开始处理，本质上就是让消费者"重置"。

这对无状态消费者非常有用，但请记住，如果消费者应用程序维护状态（而大多数流处理应用程序确实维护状态），重置偏移量并让消费者组从主题开头开始处理可能会对存储的状态产生奇怪的影响。例如，假设你有一个流应用程序，持续计算你商店中售出的鞋子数量，并假设在早上 8:00 你发现输入中有错误，你想要从凌晨 3:00 开始完全重新计算计数。如果你在没有适当修改存储聚合的情况下将偏移量重置为凌晨 3:00，你将对今天售出的每双鞋**计数两次**（你还会处理凌晨 3:00 到早上 8:00 之间的所有数据，但我们假设这是纠正错误所必需的）。你需要注意相应地更新存储的状态。在开发环境中，我们通常在将偏移重置到输入主题开头之前**完全删除状态存储**。

还要记住，当偏移量在偏移量主题中发生变化时，消费者组**不会收到更新**。它们只在消费者被分配新分区时或启动时读取偏移量。为了防止你对消费者不会知道的偏移量进行更改（因此会覆盖），Kafka 将阻止你在**消费者组活跃时**修改偏移量。

考虑到所有这些警告，让我们看一个例子：

```java
Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> earliestOffsets =
    // 需要先获取最早的偏移量

Map<TopicPartition, OffsetAndMetadata> resetOffsets = new HashMap<>();
for (Map.Entry<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo>
        e : earliestOffsets.entrySet()) {
    resetOffsets.put(e.getKey(), new OffsetAndMetadata(e.getValue().offset()));
}

try {
    admin.alterConsumerGroupOffsets(CONSUMER_GROUP, resetOffsets).all().get();
} catch (ExecutionException e) {
    System.out.println("Failed to update the offsets committed by group "
            + CONSUMER_GROUP + " with error " + e.getMessage());
    if (e.getCause() instanceof UnknownMemberIdException)
        System.out.println("Check if consumer group is still active.");
}
```

为了重置消费者组使其从最早的偏移量开始处理，我们需要先获取最早的偏移量。
`alterConsumerGroupOffsets` 接受一个带有 `OffsetAndMetadata` 值的映射作为参数。但 `listOffsets` 返回的是 `ListOffsetsResultInfo`，我们需要对第一个方法的结果进行一些处理，以便用作参数。
我们等待 Future 完成，以便查看它是否成功完成。
`alterConsumerGroupOffsets` 失败的最常见原因之一是**我们没有先停止消费者组**。如果组仍然活跃，我们修改偏移量的尝试在消费者 Coordinator 看来就如同一个不是组成员中的客户端正在为该组提交偏移量。在这种情况下，我们将收到 `UnknownMemberIdException`。

## 集群元数据

应用程序很少需要显式地发现它所连接的集群的任何信息。你可以在不知道有多少 Broker 存在以及哪个是 Controller 的情况下生产和消费消息。Kafka 客户端抽象掉了这些信息——客户端只需要关心主题和分区。

但万一你感到好奇，这段小代码片段会满足你的好奇心：

```java
DescribeClusterResult cluster = admin.describeCluster();

System.out.println("Connected to cluster " + cluster.clusterId().get());
System.out.println("The brokers in the cluster are:");
cluster.nodes().get().forEach(node -> System.out.println(" - " + node));
System.out.println("The controller is: " + cluster.controller().get());
```

集群标识符是一个 GUID，因此**不是人类可读的**。但它仍然在检查你的客户端是否连接到了正确的集群时很有用。

## 高级管理操作

在本小节中，我们将讨论一些很少使用、可能有些风险……但在需要时非常**有用**的方法。这些主要对事故期间的 SRE 很重要——但不要等到遇到事故时才学习如何使用它们。提前阅读和练习，以免为时已晚。注意，这里的方法之间几乎没有关联，只是它们都属于这个类别。

### 向主题添加分区

通常，主题中的分区数在创建主题时设置。由于每个分区可以有非常高的吞吐量，达到主题容量上限的情况很少见。此外，如果主题中的消息带有键，则消费者可以假设所有具有相同键的消息将始终进入同一分区，并由同一消费者按相同顺序处理。

出于这些原因，向主题添加分区很少需要，而且可能是有风险的——你需要检查此操作不会破坏从该主题消费的任何应用程序。然而，有时你确实遇到了现有分区所能处理的吞吐量上限，别无选择，只能添加一些分区。

你可以使用 `createPartitions` 方法向一组主题添加分区。注意，如果你尝试同时扩展多个主题，有可能某些主题成功扩展而其他主题失败。

```java
Map<String, NewPartitions> newPartitions = new HashMap<>();
newPartitions.put(TOPIC_NAME, NewPartitions.increaseTo(NUM_PARTITIONS_NEW));
admin.createPartitions(newPartitions).all().get();
```

扩展主题时，你需要指定添加分区后主题将具有的**分区总数**，而不是新增的分区数。

> **提示**
>
> 由于 `createPartition` 方法以添加新分区后主题中的分区总数作为参数，你可能需要先描述主题，找出在扩展之前有多少个分区。

### 从主题中删除记录

当前的隐私法律要求对数据实施特定的保留策略。不幸的是，虽然 Kafka 有主题的保留策略，但它们的实现方式并不能保证合规性。保留策略为 30 天的主题如果所有数据都适合放入每个分区的单个段（segment）中，则可能存在更旧的数据。

`deleteRecords` 方法将**删除所有偏移量早于调用该方法时指定偏移量的记录**。记住，`listOffsets` 方法可用于获取在特定时间或之后写入的记录的偏移量。这两种方法一起使用，可以**删除早于任何特定时间点的记录**：

```java
Map<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo> olderOffsets =
    // 通过时间戳获取偏移量
Map<TopicPartition, RecordsToDelete> recordsToDelete = new HashMap<>();
for (Map.Entry<TopicPartition, ListOffsetsResult.ListOffsetsResultInfo>
        e : olderOffsets.entrySet())
    recordsToDelete.put(e.getKey(), RecordsToDelete.beforeOffset(e.getValue().offset()));
admin.deleteRecords(recordsToDelete).all().get();
```

### Leader 选举

此方法允许你触发两种不同类型的 Leader 选举：

- **Preferred Leader（首选 Leader）选举**：每个分区都有一个被指定为"首选 Leader"的副本。它之所以是"首选"的，是因为如果所有分区都使用其首选 Leader 副本作为 Leader，则每个 Broker 上的 Leader 数量应该是平衡的。默认情况下，Kafka 将每 5 分钟检查一次首选 Leader 副本是否确实是 Leader，如果不是但它有资格成为 Leader，它就会选举首选 Leader 副本作为 Leader。如果此选项被关闭，或者你希望更快地完成这一过程，`electLeader()` 方法可以触发此过程。
- **Unclean Leader（不干净 Leader）选举**：如果一个分区的 Leader 副本变得不可用，而其他副本没有资格成为 Leader（通常是因为它们缺少数据），该分区将没有 Leader，因此不可用。解决此问题的一种方法是触发 "unclean" Leader 选举——这意味着将一个本来没有资格成为 Leader 的副本选举为 Leader。这将导致**数据丢失**——所有写入旧 Leader 但未复制到新 Leader 的事件都将丢失。`electLeader()` 方法也可以用于触发 unclean Leader 选举。

```java
Set<TopicPartition> electableTopics = new HashSet<>();
electableTopics.add(new TopicPartition(TOPIC_NAME, 0));
try {
    admin.electLeaders(ElectionType.PREFERRED, electableTopics).all().get();
} catch (ExecutionException e) {
    if (e.getCause() instanceof ElectionNotNeededException) {
        System.out.println("All leaders are preferred already");
    }
}
```

该方法是**异步的**，这意味着即使它成功返回后，也需要一段时间所有 Broker 才能意识到新状态，而对 `describeTopics()` 的调用可能会返回不一致的结果。如果你为多个分区触发 Leader 选举，有可能某些分区操作成功而其他分区失败。

我们正在对特定主题的**单个分区**选举首选 Leader。我们可以指定任意数量的分区和主题。如果你以 `null` 而不是分区集合来调用该命令，它将为你选择的选举类型触发所有分区的选举。
如果集群处于健康状态，该命令将**什么都不做**——只有当非首选 Leader 的副本是当前 Leader 时，首选 Leader 选举和 unclean Leader 选举才会生效。

### 重分配副本

有时，你不喜欢某些副本当前的所在位置。也许某个 Broker 过载了，你想把一些副本移走。也许你想添加更多副本。也许你想把所有副本从一个 Broker 移走以便移除该机器。或者，也许有几个主题过于"嘈杂"，你需要将它们与其余工作负载隔离开来。在所有这些场景中，`alterPartitionReassignments` 让你能够对分区的**每个副本的放置**进行细粒度控制。请记住，当你将副本从一个 Broker 重新分配到另一个 Broker 时，可能涉及在 Broker 之间**复制大量数据**。要注意可用的网络带宽，并在需要时使用配额（quotas）来限流复制：配额是 Broker 配置，因此你可以通过 AdminClient 描述和更新它们。

对于这个例子，假设我们有一个 ID 为 0 的单个 Broker。我们的主题有几个分区，所有分区都在这个 Broker 上有一个副本。在添加了一个新 Broker 后，我们想要用它来存储主题的一些副本。因此，我们将以稍微不同的方式分配主题中的每个分区：

```java
Map<TopicPartition, Optional<NewPartitionReassignment>> reassignment = new HashMap<>();
reassignment.put(new TopicPartition(TOPIC_NAME, 0),
        Optional.of(new NewPartitionReassignment(Arrays.asList(0, 1))));
reassignment.put(new TopicPartition(TOPIC_NAME, 1),
        Optional.of(new NewPartitionReassignment(Arrays.asList(1))));
reassignment.put(new TopicPartition(TOPIC_NAME, 2),
        Optional.of(new NewPartitionReassignment(Arrays.asList(1, 0))));
reassignment.put(new TopicPartition(TOPIC_NAME, 3), Optional.empty());

try {
    admin.alterPartitionReassignments(reassignment).all().get();
} catch (ExecutionException e) {
    if (e.getCause() instanceof NoReassignmentInProgressException) {
        System.out.println("Cancelling a reassignment that didn't exist.");
    }
}
System.out.println("currently reassigning: " +
        admin.listPartitionReassignments().reassignments().get());
demoTopic = admin.describeTopics(TOPIC_LIST);
topicDescription = demoTopic.values().get(TOPIC_NAME).get();
System.out.println("Description of demo topic:" + topicDescription);
```

- **Partition 0**：我们为分区 0 添加了另一个副本，将新副本放置在新 Broker 上，但将 Leader 留在现有 Broker 上
- **Partition 1**：我们没有为分区 1 添加任何副本，只是将现有的一个副本移到了新 Broker。由于我只有一个副本，它也是 Leader
- **Partition 2**：我们为分区 2 添加了另一个副本并将其设为首选 Leader。下一次首选 Leader 选举将把领导权切换到新 Broker 上的新副本。现有副本将成为 Follower
- **Partition 3**：分区 3 没有正在进行的重分配，但如果有的话，这将取消它并返回到重分配操作开始前的状态
- 我们可以列出正在进行的重分配
- 我们也可以尝试打印新状态，但要记住需要一段时间才能显示一致的结果

## 测试

Apache Kafka 提供了一个测试类 **MockAdminClient**，你可以用它初始化任意数量的 Broker，并用于测试你的应用程序在没有实际运行 Kafka 集群、也没有实际在上面执行管理操作的情况下是否能正确行为。一些方法有非常全面的模拟——你可以用 MockAdminClient 创建主题，后续的 `listTopics()` 调用将列出你"创建"的主题。

然而，并非所有方法都被模拟了——如果你在 2.5 或更早版本中使用 AdminClient 并调用 MockAdminClient 的 `incrementalAlterConfigs()`，你将收到一个 `UnsupportedOperationException`，但你可以通过**注入你自己的实现**来处理这种情况。

为了演示如何使用 MockAdminClient 进行测试，让我们首先实现一个类，该类使用一个 AdminClient 实例化，并用它来创建主题：

```java
public class TopicCreator {
    private AdminClient admin;

    public TopicCreator(AdminClient admin) {
        this.admin = admin;
    }

    // 示例方法：如果主题名称以 "test" 开头就创建该主题
    public void maybeCreateTopic(String topicName)
            throws ExecutionException, InterruptedException {
        Collection<NewTopic> topics = new ArrayList<>();
        topics.add(new NewTopic(topicName, 1, (short) 1));
        if (topicName.toLowerCase().startsWith("test")) {
            admin.createTopics(topics);

            // 修改配置只是为了演示一个要点
            ConfigResource configResource =
                      new ConfigResource(ConfigResource.Type.TOPIC, topicName);
            ConfigEntry compaction =
                      new ConfigEntry(TopicConfig.CLEANUP_POLICY_CONFIG,
                              TopicConfig.CLEANUP_POLICY_COMPACT);
            Collection<AlterConfigOp> configOp = new ArrayList<>();
            configOp.add(new AlterConfigOp(compaction, AlterConfigOp.OpType.SET));
            Map<ConfigResource, Collection<AlterConfigOp>> alterConf = new HashMap<>();
            alterConf.put(configResource, configOp);
            admin.incrementalAlterConfigs(alterConf).all().get();
        }
    }
}
```

这里的逻辑并不复杂：如果主题名称以 "test" 开头，`maybeCreateTopic` 就会创建主题。我们还修改了主题配置，这样我们就可以展示如何处理我们使用的方法在模拟客户端中未实现的情况。

我们将从实例化我们的模拟客户端开始测试：

```java
@Before
public void setUp() {
    Node broker = new Node(0, "localhost", 9092);
    this.admin = spy(new MockAdminClient(Collections.singletonList(broker), broker));

    // 没有这个，测试将抛出
    // `java.lang.UnsupportedOperationException: Not implemented yet`
    AlterConfigsResult emptyResult = mock(AlterConfigsResult.class);
    doReturn(KafkaFuture.completedFuture(null)).when(emptyResult).all();
    doReturn(emptyResult).when(admin).incrementalAlterConfigs(any());
}
```

> **注意**
>
> 我们正在使用 **Mockito** 测试框架来验证 MockAdminClient 方法是否按预期被调用，并填充未实现的方法。Mockito 是一个相当简单的模拟框架，具有很好的 API，这使得它非常适合用于单元测试的小示例。

MockAdminClient 使用一个 Broker 列表（这里我只使用一个）和一个将作为我们 Controller 的 Broker 来实例化。Broker 只有 Broker ID、主机名和端口——当然，全是假的。在运行这些测试时不会有任何 Broker 运行。我们将使用 Mockito 的 spy 注入，这样我们稍后可以检查 TopicCreator 是否正确执行了。
我们在这里使用 Mockito 的 `doReturn` 方法，以确保模拟的 AdminClient 不会抛出异常。由于我们正在测试的方法期望在调用 `all()` 方法时返回 `AlterConfigResult`，而 `AlterConfigResult` 返回一个 `KafkaFuture`，我们确保假的 `incrementalAlterConfigs` 返回的正是那个东西。

现在我们有了一个正确的假的 AdminClient，我们可以用它来测试 `maybeCreateTopic()` 方法是否正常工作：

```java
@Test
public void testCreateTestTopic()
        throws ExecutionException, InterruptedException {
    TopicCreator tc = new TopicCreator(admin);
    tc.maybeCreateTopic("test.is.a.test.topic");
    verify(admin, times(1)).createTopics(any());
}

@Test
public void testNotTopic() throws ExecutionException, InterruptedException {
    TopicCreator tc = new TopicCreator(admin);
    tc.maybeCreateTopic("not.a.test");
    verify(admin, never()).createTopics(any());
}
```

- 主题名称以 "test" 开头，因此我们期望 `maybeCreateTopic()` 创建一个主题。我们正在检查 `createTopics()` 被调用了一次
- 当主题名称不以 "test" 开头时，我们验证 `createTopics()` **根本没有被调用**

最后一点说明：Apache Kafka 在 **test jar** 中发布了 MockAdminClient，所以请确保你的 `pom.xml` 包含测试依赖：

```xml
<dependency>
    <groupId>org.apache.kafka</groupId>
    <artifactId>kafka-clients</artifactId>
    <version>2.5.0</version>
    <classifier>test</classifier>
    <scope>test</scope>
</dependency>
```

## 本章小结

AdminClient 是你 Kafka 开发工具箱中的一个**有用工具**。对于想要动态创建主题并验证他们使用的主题是否为其应用程序正确配置的应用程序开发者来说，它非常有用。对于想要围绕 Kafka 创建工具和自动化或需要从事故中恢复的运维人员和 SRE 来说，它也很有用。AdminClient 有如此多有用的方法，SRE 可以将其视为 Kafka 运维的"瑞士军刀"。

在本章中，我们涵盖了使用 Kafka AdminClient 的所有基础知识——主题管理、配置管理和消费者组管理。再加上一些其他有用的方法，最好把它们装在你的"后口袋"里——你永远不知道什么时候会需要它们。

---

## 本章选择题

1. **AdminClient 的 API 特性是什么？**
   - A. 同步阻塞式
   - B. 异步最终一致性
   - C. 同步强一致性
   - D. 纯事件驱动

2. **在 AdminClient 中，`createPartitions` 方法的参数是以下哪个？**
   - A. 新增的分区数
   - B. 扩展后的分区总数
   - C. 要删除的分区数
   - D. 每个 Broker 上的分区数

3. **`alterConsumerGroupOffsets` 操作失败的最常见原因是什么？**
   - A. 网络超时
   - B. Topic 不存在
   - C. 消费者组仍然活跃
   - D. Broker 磁盘空间不足

4. **Kafka 中"Unclean Leader 选举"指的是什么？**
   - A. 选举数据最完整的副本作为 Leader
   - B. 选举一个原本无资格成为 Leader 的副本作为 Leader（可能导致数据丢失）
   - C. 重启失败的 Broker
   - D. 删除所有副本后重新创建

5. **关于 AdminClient 配置中的 `client.dns.lookup`，以下哪个说法是正确的？**
   - A. 默认值 `use_all_dns_ips` 适合大多数场景
   - B. `resolve_canonical_bootstrap_servers_only` 适用于使用 SASL 认证 + DNS 别名的场景
   - C. 此配置在任何版本中都不存在
   - D. 只有在使用 MirrorMaker 时才需要此配置

<details>
<summary>查看答案</summary>

1. **B. 异步最终一致性** — AdminClient 每个方法返回 Future/Result 对象，Controller 状态更新后 Future 完成，但所有 Broker 知晓新状态需要时间。
2. **B. 扩展后的分区总数** — `createPartitions` 接受 `NewPartitions.increaseTo(totalCount)`，指定添加后的总分区数，而非新增数。
3. **C. 消费者组仍然活跃** — 活跃的消费者组会阻止偏移量修改，Kafka 会抛出 `UnknownMemberIdException`。
4. **B. 选举一个原本无资格成为 Leader 的副本作为 Leader（可能导致数据丢失）** — Unclean Leader 选举会丢失未复制到新 Leader 的数据。
5. **B. `resolve_canonical_bootstrap_servers_only` 适用于使用 SASL 认证 + DNS 别名的场景** — 此配置会展开 DNS 别名，使 SASL 认证时主机名匹配。

</details>