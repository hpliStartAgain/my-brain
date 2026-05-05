# 12: ConfigMap 和 Secret

大多数业务应用都由两个部分组成：

- 应用程序
- 配置

简单的例子包括 NGINX 和 httpd（Apache）这样的 Web 服务器。在添加配置之前，这两者都不太有用。

过去，我们常常将应用程序及其配置打包成一个易于部署的单元，并且在云原生微服务的早期阶段，我们将这种模式带到了云原生中。但这是一个反模式，你应该将现代应用程序与其配置解耦，因为这样做可以带来以下好处：

- **复用**
- **更简单的开发和测试**
- **更简单且干扰更少的变更**

我们会在本章中详细解释所有这些好处以及更多内容。

> [!NOTE] 注意
> **反模式** 是一种看似好主意但实际上却是糟糕做法的模式。

我将本章内容分为以下几部分：

- 大局观
- ConfigMap 理论
- ConfigMap 实操
- Secrets 实操

你在 ConfigMap 部分学到的所有内容在后续的 Secrets 部分同样适用。

## 大局观

如前所述，大多数应用由一个应用二进制文件和一个配置组成。Kubernetes 允许你将它们构建并存储为独立的对象，并在运行时将它们组合在一起。

快速看一个例子。

假设你在一家拥有三个环境的公司工作：

- 开发（Dev）
- 测试（Test）
- 生产（Prod）

你在开发环境中进行初步测试，在测试环境中进行更广泛的测试，应用最终进入生产环境。然而，每个环境都有自己的网络和安全策略，以及自己独特的凭据和证书。

目前，你将应用程序及其配置打包在同一个镜像中，这迫使你为每个应用程序执行以下所有操作：

- 构建三个镜像（一个带开发配置，一个带测试配置，一个带生产配置）
- 将镜像存储到三个不同的仓库（一个用于开发镜像，一个用于测试，一个用于生产）
- 在每个环境中运行不同配置的应用实例（开发环境运行开发版应用，测试环境运行测试版，生产环境运行生产版）

每次你修改应用，即使是很小的改动（比如修复一个拼写错误），你都必须构建、测试、存储和重新部署三次——一次用于开发，一次用于测试，一次用于生产。

当每次更新都同时包含应用代码和配置时，排查问题和解耦问题也会变得更加困难。

### 在解耦的世界中是什么样子

假设你在同一家公司工作，公司要求你构建一个新的 Web 应用。但现在公司决定将代码和配置解耦。

你决定以 NGINX 为基础构建新应用，并创建一个加固的 NGINX 基础镜像，供其他团队和应用使用各自配置重复利用。这意味着：

- 你只需构建一个镜像，该镜像将在三个环境中通用
- 你只需将这一个镜像存储并保护在单个仓库中
- 你可以在所有环境中运行同一版本的镜像

为了实现这一点，你构建一个仅包含加固后的 NGINX 的基础镜像，不嵌入任何配置。

然后，你为开发、测试和生产创建三个不同的配置，这些配置将在运行时应用。每个配置都为正确的环境配置加固的 NGINX 容器，包含应用配置、策略设置和凭据。其他团队和应用可以在其自己的 Web 应用中重复使用相同的加固 NGINX 镜像，只需应用它们自己的配置即可。

在这种模式下，你仅创建和测试一个版本的 NGINX，将其构建为单一镜像，并存储在单一仓库中。你可以授予所有开发者拉取该仓库的权限，因为它不包含敏感数据；你还可以独立地推送应用或其配置的变更。

例如，如果主页上有一个拼写错误，你可以直接在配置中修复，然后将其推送到所有三个环境中现有的容器。你再也不需要停止并替换所有三个环境中的每一个容器了。

现在让我们看看 Kubernetes 如何实现这一点。

## ConfigMap 理论

Kubernetes 有一个名为 **ConfigMap（CM）** 的 API 资源，它允许你将配置数据存储在 Pod 外部，并在运行时注入。

ConfigMap 是核心 API 组中的一等对象。其 API 版本为 `v1`。这告诉我们几件事：

1. 它很稳定（`v1`）
2. 它已经存在了一段时间（新事物绝不会进入核心 API 组）
3. 你可以在 YAML 文件中定义和部署它
4. 你可以用 `kubectl` 管理它

你通常会使用 ConfigMap 来存储非敏感的配置数据，例如：

- 环境变量
- 配置文件（如 Web 服务器配置、数据库配置）
- 主机名
- 服务名和服务端口
- 账户名

**不应** 使用 ConfigMap 来存储敏感数据，如证书和密码，因为 Kubernetes 不保护其内容。对于敏感数据，你应该使用 Kubernetes Secret 作为全面机密管理解决方案的一部分。

你将在本章后面部分学习使用 Secret。

### ConfigMap 如何工作

在高层面上，ConfigMap 是一个用于存储配置数据的对象，你可以轻松地在运行时将数据注入到容器中。你可以将其配置为与环境变量和卷配合使用，从而使其能够与应用程序无缝工作。

让我们更深入地看一下。

在底层，ConfigMap 是一个 Kubernetes 对象，包含一个键值对映射：

- **键**：是一个任意的名称，可以包含字母数字、短划线、点号和下划线
- **值**：可以存储任何内容，包括完整的配置文件（含多行和回车符）

ConfigMap 的大小限制为 1 MiB（1,048,576 字节）。

以下是一个包含三个条目的 ConfigMap 示例：

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: epl
data:
  Competition: Premier League    -----┐
  Season: 2024-2025                   | 3 个映射条目(键:值)
  Champions: Liverpool           -----┘
```

以下是一个值包含完整配置文件的示例：

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: cm2
data:                       
  test.conf: |                 <<---- 键
    env = plex-test            -----┐
    endpoint = 0.0.0.0:31001        |
    char = utf8                     | 值
    vault = PLEX/test               |
    log-size = 512M            -----┘
```

一旦你创建了 ConfigMap，就可以使用以下任何一种方法在运行时将其注入到容器中：

1. **环境变量**
2. **容器启动命令的参数**
3. **卷中的文件**

图 12.1 展示了各部分如何连接。ConfigMap 位于应用之外，其值映射到标准构造（如环境变量和卷）中，应用可以轻松访问这些构造。

> 图 12.1 —— ConfigMap 连接到 Pod/容器（示意图）

所有三种方法都不需要为现有应用添加 Kubernetes 知识即可工作。但卷选项最为灵活，因为它支持更新。你将逐一尝试这些方法，但首先，让我们快速提一下 Kubernetes 原生应用。

### ConfigMap 和 Kubernetes 原生应用

Kubernetes 原生应用知道自己运行在 Kubernetes 上，并且能够与 Kubernetes API 服务器通信。这有许多好处，包括能够直接通过 API 读取 ConfigMap，而无需将其挂载为卷或通过环境变量。这也意味着正在运行的容器可以看到 ConfigMap 的更新。然而，这类应用只能在 Kubernetes 上运行，并且会造成 Kubernetes 锁定，即你的应用只在 Kubernetes 上可用。

我们所有的示例都使用环境变量和卷，以便现有应用可以访问 ConfigMap 数据，而无需重写或锁定到 Kubernetes。

## ConfigMap 实操

你需要一个 Kubernetes 集群以及本书 GitHub 仓库中的实验文件（如果你想跟着操作的话）。

```bash
$ git clone https://github.com/nigelpoulton/TKB.git
Cloning into 'TKB'...
$ cd TKB
$ git fetch origin
$ git checkout -b 2025 origin/2025
$ cd configmaps
```

确保你位于 `2025` 分支，并且所有命令都在 `configmaps` 文件夹中运行。

与大多数 Kubernetes 资源一样，你可以通过 **命令式** 和 **声明式** 两种方式创建 ConfigMap。我们先看命令式方法。

### 命令式创建 ConfigMap

你可以使用 `kubectl create configmap` 命令命令式地创建 ConfigMap。不过，你可以将 `configmap` 简写为 `cm`，并且该命令接受两种数据来源：

- 命令行上的字面值（`--from-literal`）
- 来自文件（`--from-file`）

运行以下命令，创建一个名为 `testmap1` 的 ConfigMap，并通过命令行字面值填充两个条目。Windows 用户应将前两行末尾的反斜杠替换为反引号。

```bash
$ kubectl create configmap testmap1 \
  --from-literal shortname=SAFC \
  --from-literal longname="Sunderland Association Football Club"
```

运行以下命令，查看 Kubernetes 如何存储映射条目：

```bash
$ kubectl describe cm testmap1
Name:         testmap1
Namespace:    default
Labels:       <none>
Annotations:  <none>
Data
====
shortname:
----
SAFC
longname:
----
Sunderland Association Football Club
BinaryData
====
Events:  <none>
```

可以看到，它只是一个键值对映射，以 Kubernetes 对象的形式呈现。

以下命令使用 `--from-file` 标志，从一个名为 `cmfile.txt` 的文件创建一个名为 `testmap2` 的 ConfigMap。该文件包含一行文本。你需要从 `configmaps` 文件夹中运行这条命令。

```bash
$ kubectl create cm testmap2 --from-file cmfile.txt
configmap/testmap2 created
```

我们将在下一节中检查这个 ConfigMap。

### 检查 ConfigMap

ConfigMap 是一等 API 对象，这意味着你可以像检查其他 API 对象一样检查并查询它们。

列出当前 Namespace 中的所有 ConfigMap：

```bash
$ kubectl get cm
```

# 12: ConfigMap 和 Secret

> [!NOTE] 继续部分
> 本部分继续讨论 ConfigMap 的创建与使用。

## 检查 ConfigMap

ConfigMap 是一等 API 对象，这意味着你可以像检查任何其他 API 对象一样检查并查询它们。

列出当前命名空间中的所有 ConfigMap。

```
$ kubectl get cm
AME       DATA   AGE
testmap1   2      11m
testmap2   1      2m23s
```

以下 `kubectl describe` 命令显示了从本地文件创建的 `testmap2` 的一些有趣信息：

- 操作创建了一个单一的 map 条目
- 键的名称与输入文件的名称匹配（`cmfile.txt`）
- 值存储了文件的内容

```
$ kubectl describe cm testmap2
Name:         testmap2
Namespace:    default
Labels:       <none>
Annotations:  <none>
Data
====
cmfile.txt:                   <<---- key
----
Kubernetes FTW!               <<---- value
BinaryData
====
Events:  <none>
```

你也可以运行带 `-o yaml` 标志的 `kubectl get` 命令来查看整个对象。

```
$ kubectl get cm testmap2 -o yaml
apiVersion: v1
data:
  cmfile.txt: |
    Kubernetes FTW!
kind: ConfigMap
metadata:
  creationTimestamp: "2025-02-04T14:19:21Z"
  name: testmap2
  namespace: default
  resourceVersion: "18128"
  uid: 146da79c-aa09-4b10-8992-4dffa087dbfb
```

如果仔细观察，你会注意到缺少 `spec` 和 `status` 子资源。这是因为 ConfigMap 没有“期望状态（desired state）”和“观测状态（observed state）”的概念。它们有一个 `data` 子资源。

接下来看看如何声明式地创建 ConfigMap。

## 声明式创建 ConfigMap

以下 YAML 来自本书 GitHub 仓库中的 `fullname.yml` 文件，定义了两个 map 条目：`firstname` 和 `lastname`。它创建了一个名为 `multimap` 的 ConfigMap，包含常见的 `kind`、`apiVersion` 和 `metadata` 字段。但它没有使用常规的 `spec`，而是使用 `data` 子资源。

```yaml
kind: ConfigMap 
apiVersion: v1 
metadata:
  name: multimap 
data:
  firstname: Nigel
  lastname: Poulton
```

使用以下命令部署它。

```
$ kubectl apply -f fullname.yml
configmap/multimap created
```

下一个 YAML 对象来自 `singlemap.yml` 文件，看起来比前一个复杂。但实际上它更简单，因为 `data` 块中只有一个条目。看起来更复杂是因为值条目包含了一个完整的配置文件。

```yaml
kind: ConfigMap 
apiVersion: v1 
metadata:
  name: test-config
data:
  test.conf: |           <<---- Key
    env = plex-test      -----┐
    endpoint = 0.0.0.0:31001  |
    char = utf8               | Value
    vault = PLEX/test         |
    log-size = 512M      -----┘
```

如果仔细观察，你会看到键属性名称后面的竖线字符（`|`）。这告诉 Kubernetes 将竖线后面的所有内容视为单个值。如果部署它，你将得到一个名为 `test-config` 的 ConfigMap，其表格如下所示，包含一个复杂的 map 条目：

| 对象名 | 键 | 值 |
|--------|-----|-----|
| test-config | test.conf | `env = plex-test` |
| | | `endpoint = 0.0.0.0:31001` |
| | | `char = utf8` |
| | | `vault = PLEX/test` |
| | | `log-size = 512M` |

使用以下命令部署它。

```
$ kubectl apply -f singlemap.yml 
configmap/test-config created
```

运行以下命令检查它。

```
$ kubectl describe cm test-config
Name:         test-config
Namespace:    default
Labels:       <none>
Annotations:  <none>
Data
====
test.conf:
----
env = plex-test
endpoint = 0.0.0.0:31001
char = utf8
vault = PLEX/test
log-size = 512M
BinaryData
====
Events:  <none>
```

## 将 ConfigMap 数据注入 Pod 和容器

有三种方式将 ConfigMap 数据注入容器：

1. 作为环境变量
2. 作为容器启动命令的参数
3. 作为卷中的文件

前两种方式会在创建容器时注入数据，并且无法更新运行中容器的值。卷方式也在创建时注入数据，但会自动将更新推送到运行中的容器。

让我们来看看两者。

### ConfigMap 与环境变量

图 12.2 展示了使用环境变量将 ConfigMap 数据注入容器的过程。你创建 ConfigMap，然后将其条目映射到 Pod 模板的 `containers` 部分中的环境变量。最后，当 Kubernetes 启动容器时，环境变量作为标准的 Linux 或 Windows 环境变量出现，这意味着应用程序可以消费它们而无需了解 ConfigMap。

> **图 12.2 — 将 ConfigMap 条目映射到环境变量**
> *（示意图：ConfigMap 中的数据通过 `valueFrom.configMapKeyRef` 映射到容器的环境变量中，然后容器应用直接使用这些环境变量。）*

你已经部署了一个名为 `multimap` 的 ConfigMap，包含以下两个条目：

```
firstname=Nigel
lastname=Poulton
```

以下 Pod 清单部署了一个单容器，其中两个环境变量映射到 ConfigMap 中的值。它来自你即将部署的 `podenv.yml` 文件。

- `FIRSTNAME`：映射到 ConfigMap 中的 `firstname` 条目
- `LASTNAME`：映射到 ConfigMap 中的 `lastname` 条目

```yaml
apiVersion: v1
kind: Pod
<Snip>
spec:
  containers:
    - name: ctr1
      env:
        - name: FIRSTNAME       <<---- 环境变量名
          valueFrom:            <<---- 基于
            configMapKeyRef:    <<---- 一个 ConfigMap
              name: multimap    <<---- 名为 "multimap"
              key: firstname    <<---- 由值填充
        - name: LASTNAME        <<---- 环境变量名
          valueFrom:            <<---- 基于
            configMapKeyRef:    <<---- 一个 ConfigMap
              name: multimap    <<---- 名为 "multimap"
              key: lastname     <<---- 由值填充
<Snip>
```

我给了环境变量大写名称，以便你能将它们与 ConfigMap 中的对应条目区分开。实际上，你可以任意命名它们。

当 Kubernetes 调度 Pod 并启动容器时，它会创建 `FIRSTNAME` 和 `LASTNAME` 作为标准的 Linux 环境变量，因此应用程序可以在不了解 ConfigMap 的情况下使用它们。

运行以下命令从 `podenv.yml` 部署一个 Pod。

```
$ kubectl apply -f podenv.yml
pod/envpod created
```

运行以下 exec 命令列出容器中名称包含“NAME”字符串的环境变量。你会看到 `FIRSTNAME` 和 `LASTNAME` 变量及其来自 ConfigMap 的值。

确保 Pod 在运行后再执行命令。Windows 用户需要将 `grep NAME` 参数替换为 `Select-String -Pattern 'NAME'`。

```
$ kubectl exec envpod -- env | grep NAME
HOSTNAME=envpod
FIRSTNAME=Nigel    
LASTNAME=Poulton
```

但请记住，环境变量是静态的。这意味着你可以更新 map 中的值，但 `envpod` 不会获得更新。

### ConfigMap 与容器启动命令

使用 ConfigMap 与容器启动命令的概念很简单。你在 Pod 模板中指定容器的启动命令，并将环境变量作为参数传递。

以下示例来自 `podstartup.yml` 文件。它描述了一个名为 `args1` 的单个容器，基于 busybox 镜像。然后它定义并填充了两个来自 `multimap` ConfigMap 的环境变量，并在容器的启动命令中引用它们。

与之前配置的主要区别在于 `spec.containers.command` 行引用了环境变量。

```yaml
spec:
  containers:
    - name: args1
      image: busybox
      env:                         
        - name: FIRSTNAME          
          valueFrom:               
            configMapKeyRef:       
              name: multimap       
              key: firstname       
        - name: LASTNAME           
          valueFrom:               
            configMapKeyRef:       
              name: multimap       
              key: lastname        
      command: [ "/bin/sh", "-c", "echo First name $(FIRSTNAME) last name $(LASTNAME)" ]
```

图 12.3 总结了 ConfigMap 条目如何填充到环境变量，然后在启动命令中被引用。

> **图 12.3 — 将 ConfigMap 条目映射到启动命令**
> *（示意图：ConfigMap 条目通过环境变量传递给容器启动命令的命令行参数。）*

从 `podstartup.yml` 文件启动一个新的 Pod。Pod 将启动，打印 `First name Nigel last name Poulton` 到容器日志，然后退出（成功）。Pod 启动并执行可能需要几秒钟。

```
$ kubectl apply -f podstartup.yml
pod/startup-pod created
```

运行以下命令检查容器日志，验证它打印了 `First name Nigel last name Poulton`。

```
$ kubectl logs startup-pod -c args1
First name Nigel last name Poulton
```

描述 Pod 将显示关于环境变量的以下数据。

```
$ kubectl describe pod startup-pod
<Snip>
Environment:
  FIRSTNAME:  <set to the key 'firstname' of config map 'multimap'>
  LASTNAME:  <set to the key 'lastname' of config map 'multimap'> 
<Snip>
```

如你所见，使用 ConfigMap 与容器启动命令仍然使用环境变量。因此，它面临同样的限制——对 ConfigMap 的更新不会推送到现有的变量。

如果你运行了 `startup-pod`，它应该处于 `Completed` 状态，因为它完成了任务然后终止了。删除它。

```
$ kubectl delete pod startup-pod
pod "startup-pod" deleted
```

### ConfigMap 与卷

使用 ConfigMap 与卷是最灵活的选项。它们可以引用整个配置文件，并且可以获得更新。不过，更新出现在容器中可能需要一两分钟。

通过卷将 ConfigMap 数据注入容器的高级过程如下：

1. 创建 ConfigMap
2. 在 Pod 模板中定义一个 ConfigMap 卷
3. 将 ConfigMap 卷挂载到容器中
4. ConfigMap 的条目将作为文件出现在容器内部

图 12.4 展示了这一过程。

> **图 12.4 — 通过卷映射 ConfigMap 条目**
> *（示意图：ConfigMap 被定义为 Pod 中的卷，然后挂载到容器的文件系统路径下，ConfigMap 的每个键在挂载点成为一个文件，其值为文件内容。）*

你已经部署了 `multimap` ConfigMap，它包含以下值：

```
firstname=Nigel
lastname=Poulton
```

以下 YAML 来自 `podvol.yml` 文件，定义了一个名为 `cmvol` 的 Pod，配置如下：

- `spec.volumes` 创建了一个名为 `volmap` 的卷，基于 `multimap` ConfigMap
- `spec.containers.volumeMounts` 将 `volmap` 卷挂载到容器的 `/etc/name` 路径

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cmvol
spec:                             
  volumes:                        
    - name: volmap                <<---- 创建一个名为 "volmap" 的卷
      configMap:                  <<---- 基于 ConfigMap
        name: multimap            <<---- 名为 "multimap"
  containers:
    - name: ctr
      image: nginx
      volumeMounts:               <<---- 这些行将 "volmap" 卷挂载到容器中
        - name: volmap            <<---- 
          mountPath: /etc/name    <<---- 挂载到 "/etc/name"
```

运行以下命令从上述 YAML 部署 `cmvol` Pod。

```
$ kubectl apply -f podvol.yml
pod/cmvol created
```

等待 Pod 进入 `Running` 阶段，然后运行以下命令列出容器中 `/etc/name/` 目录下的文件。

```
$ kubectl exec cmvol -- ls /etc/name
firstname
lastname
```

你可以看到容器中有两个文件，与 ConfigMap 的条目对应。可以随意运行额外的 `kubectl exec` 命令来 `cat` 文件的内容，确保它们与 ConfigMap 中的值匹配。

现在，让我们证明你对 map 所做的更改会出现在运行中的 `cmvol` 容器中。

使用 `kubectl edit` 编辑 ConfigMap 并更改 `data` 块中的任何值。该命令会在你默认的编辑器中打开 YAML 对象，在 Linux 和 Mac 上通常是 `vi`，在 Windows 上通常是 `notepad.exe`。如果你对 `vi` 不熟悉，可以手动在其他编辑器中编辑 YAML 文件，然后使用 `kubectl apply` 重新提交给 API 服务器。

我已注释了代码块，标明了需要更改的行。

```
$ kubectl edit cm multimap
# Please edit the object below. Lines beginning with a '#' will be ignored,
# and an empty file will abort the edit. If an error occurs while saving, ...
```

> [!TIP] 更新 ConfigMap 后，卷挂载的文件会自动更新，但可能有一两分钟的延迟。

# 12: ConfigMap 和 Secret

在另一个编辑器中编辑，并使用 `kubectl apply` 重新将其发布到 API 服务器。

我已对代码块进行了注释，以显示需要更改的行。

```bash
$ kubectl edit cm multimap
# 请编辑下面的对象.以 '#' 开头的行将被忽略,
# 空文件将中止编辑.如果在此过程中发生错误,
# 该文件将重新打开并显示相关失败信息.
#
apiVersion: v1
data:
  City: Macclesfield       <<---- 已更改
  Country: UK              <<---- 已更改
kind: ConfigMap
metadata:
<截断>
```

保存更改，并检查更新是否出现在容器中。更改可能需一分钟左右才会显现。

```bash
$ kubectl exec cmvol -- ls /etc/name
City
Country
$ kubectl exec cmvol -- cat /etc/name/Country
UK
```

恭喜！你已经将 `multimap` ConfigMap 的内容通过 ConfigMap 卷导出到容器的文件系统中，并验证了该卷已收到你的更新。

## Secrets 动手实践

Secrets 的工作方式与 ConfigMaps 相同——它们保存配置数据，Kubernetes 在运行时将这些数据注入容器。然而，Secrets 被设计为更全面的机密管理解决方案的一部分，用于存储敏感数据，如密码、证书和 OAuth 令牌。

### Kubernetes Secrets 安全吗？

这个问题的快速回答是：不。但这里有一个稍长一点的答案……

一个安全的机密管理系统涉及的内容远不止 Kubernetes Secrets。你必须考虑以下所有方面甚至更多：

-   在集群存储中静态加密 Secrets
-   在网络传输中加密 Secrets
-   在节点/Pod/容器中暴露时保护 Secrets
-   通过最小权限 RBAC 控制对 Secrets 的 API 访问
-   控制对 etcd 节点（集群存储）的访问
-   防止特权容器访问 Secrets
-   防止通过像 GitHub 这样的源代码仓库泄露
-   在不再使用时安全删除 Secrets

大多数新的 Kubernetes 集群不会执行上述任何操作——它们将 Secrets 以未加密形式存储在集群存储中，通过网络以明文发送，并以明文形式挂载到容器中！然而，你可以配置 `EncryptionConfiguration` 对象来在集群存储中静态加密 Secrets，部署服务网格来加密所有网络流量，以及配置强 RBAC 来保护 Secrets 的 API 访问。你甚至可以限制对控制平面节点和 etcd 节点的访问，在使用后安全删除 Secrets，等等。

在现实世界中，许多生产集群实现了服务网格来保护网络流量，并将 Secrets 存储在 Kubernetes 外部的第三方保险库中，例如 HashiCorp Vault 或类似的云服务。Kubernetes 甚至有一个原生的 Secrets Store CSI 驱动，用于与外部保险库集成。

可以想象，保险库和机密管理系统有很多，它们都有自己复杂的配置。考虑到这一点，我们将专注于大多数 Kubernetes 安装开箱即用提供的功能，并将特定平台的复杂细节留给你。

一个仅使用 Kubernetes Secrets 的典型机密工作流程如下：

1.  你创建 Secret，Kubernetes 将其以未加密对象的形式持久化到集群存储中
2.  你调度一个 Pod，其中包含使用该 Secret 的容器
3.  Kubernetes 通过网络将未加密的 Secret 传输到运行该 Pod 的节点
4.  节点上的 kubelet 启动 Pod 及其容器
5.  容器运行时通过基于内存的 tmpfs 文件系统将 Secret 挂载到容器中，并将其从 base64 解码为明文
6.  应用程序使用它
7.  当你删除 Pod 时，Kubernetes 删除节点上 Secret 的副本（但保留集群存储中的副本）

Secrets 的一个明显用例是 TLS 终止代理。图 12.5 展示了一个为三个不同环境配置了三个不同 Secrets 的单一镜像。每个 Secret 可以包含特定环境的 TLS 证书，Kubernetes 在运行时将适当的 Secret 加载到每个容器中。

> [!info] 图 12.5 - 在运行时注入 Secrets
> （图片第 363 页 — 描述：三个 Pod，每个 Pod 内有一个容器，分别注入不同的 Secret（如 `cert-dev`、`cert-stage`、`cert-prod`），每个 Secret 包含特定环境的 TLS 证书。）

### 创建 Secrets

请记住，大多数 Kubernetes 安装不会在集群存储中或网络上传输时对 Secrets 进行加密。即使你实现了这些，Secrets 在容器中始终以明文形式暴露，以便应用程序轻松使用它们。

与所有 API 资源一样，你可以通过命令式和声明式方式创建 Secrets。

运行以下命令创建一个名为 `creds` 的新 Secret。如果你使用的是 Windows，请记得将反斜杠替换为反引号。

```bash
$ kubectl create secret generic creds \
  --from-literal user=nigelpoulton \
  --from-literal pwd=Password123
```

你之前了解到，Kubernetes 通过将 Secrets 编码为 base64 值来掩盖它们。使用以下命令检查这一点。

```bash
$ kubectl get secret creds -o yaml
apiVersion: v1
kind: Secret
data:
  pwd: UGFzc3dvcmQxMjM=
  user: bmlnZWxwb3VsdG9u
<截断>
```

用户名和密码值都是 base64 编码的。运行以下命令解码它们。你的系统需要安装 `base64` 工具才能使命令生效。如果没有，可以使用在线解码器。

```bash
$ echo UGFzc3dvcmQxMjM= | base64 -d
Password123
```

解码成功完成，无需密钥，这证明 base64 编码并不安全。因此，你绝对不应将 Secrets 存储在像 GitHub 这样的平台上，因为任何有访问权限的人都可以读取它们。

以下 YAML 对象来自 `configmaps` 文件夹中的 `tkb-secret.yml` 文件。它描述了一个名为 `tkb-secret` 的 Secret，包含两个 base64 编码的条目。你可以通过将 `data` 块改为 `stringData` 来添加明文条目，但你绝不应在任何地方（如 GitHub）存储这两种类型，因为任何有访问权限的人都能读取它们。

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: tkb-secret
  labels:
    chapter: configmaps
type: Opaque
data:                          <<---- 改为 "stringData" 可输入明文
  username: bmlnZWxwb3VsdG9u
  password: UGFzc3dvcmQxMjM=
```

将其部署到你的集群。请确保从 `configmaps` 文件夹运行命令。

```bash
$ kubectl apply -f tkb-secret.yml 
secret/tkb-secret created
```

运行 `kubectl get` 和 `kubectl describe` 命令来检查它。

### 在 Pod 中使用 Secrets

在本节中，你将部署一个使用你在上一节中创建的 `tkb-secret` 的 Pod。

Secrets 的工作方式与 ConfigMaps 类似，意味着你可以将它们作为环境变量、命令行参数或卷注入容器。与 ConfigMaps 一样，最灵活的选择是卷。

以下 YAML 来自 `secretpod.yml` 文件，描述了一个单容器的 Pod，其中包含一个名为 `secret-vol` 的 Secret 卷，基于你在上一步中创建的 `tkb-secret`。它将 `secret-vol` 挂载到容器的 `/etc/tkb` 路径下。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secret-pod
  labels:
    topic: secrets
spec:
  volumes:
  - name: secret-vol             <<---- 卷名称
    secret:                      <<---- 卷类型
      secretName: tkb-secret     <<---- 用此 Secret 填充卷
  containers:
  - name: secret-ctr
    image: nginx
    volumeMounts:
    - name: secret-vol           <<---- 挂载上面定义的卷
      mountPath: "/etc/tkb"      <<---- 到该路径
```

Secret 卷是 Kubernetes API 中的资源，Kubernetes 会自动以只读方式挂载它们，以防止容器和应用程序意外修改其内容。

使用以下命令部署 Pod。这将导致 Kubernetes 将未加密的 Secret 通过网络传输到运行该 Pod 的节点上的 kubelet。然后，容器运行时使用 tmpfs 挂载将其挂载到容器中。

```bash
$ kubectl apply -f secretpod.yml
pod/secret-pod created
```

运行以下命令，查看 Secret 在容器中以两个文件的形式挂载到 `/etc/tkb` ——Secret 中的每个条目对应一个文件。

```bash
$ kubectl exec secret-pod -- ls /etc/tkb                  
password
username
```

如果你检查任一文件的内容，你会看到它们以明文形式挂载，以便应用程序轻松使用。

```bash
$ kubectl exec secret-pod -- cat /etc/tkb/password
Password123
```

做得好！你已经创建了一个 Secret，并通过 Secret 卷将其挂载到 Pod 中。由于你选择了卷选项，你可以更新 Secret，应用程序会看到更新。

> [!warning] 记住
> 一个完整的机密管理解决方案远不止将敏感数据存储在 Kubernetes Secrets 中。你需要对其进行静态加密、传输中加密、控制 API 访问、限制 etcd 节点访问、处理特权容器、防止 Secret 清单文件托管在公共源代码仓库等。大多数现实世界的解决方案将秘密数据存储在 Kubernetes 外部的第三方保险库中。

## 清理

使用 `kubectl get` 列出你已部署的 Pod、ConfigMap 和 Secret。

```bash
$ kubectl get pods
NAME           READY    STATUS       RESTARTS    AGE
cmvol          1/1      Running      0           27m
envpod         1/1      Running      0           22m
secret-pod     1/1      Running      0           16m
$ kubectl get cm
NAME                DATA    AGE
kube-root-ca.crt    1       71m    <<---- 不要删除这个
multimap            2       19m
test-config         1       17m
testmap1            2       24m
testmap2            1       22m
$ kubectl get secrets
NAME          TYPE      DATA    AGE
creds         Opaque    2       4m55s
tkb-secret    Opaque    2       3m35s
```

现在删除它们。Pods 删除可能需要几秒钟。

```bash
$ kubectl delete pods cmvol envpod secret-pod
$ kubectl delete cm multimap test-config testmap1 testmap2
$ kubectl delete secrets creds tkb-secret
```

## 章节总结

-   ConfigMaps 和 Secrets 是让你将应用程序与其配置数据解耦的方式。
-   两者都是 Kubernetes API 中的一等对象，意味着你可以通过命令式和声明式方式创建它们，并使用 `kubectl` 检查它们。
-   ConfigMaps 专为应用程序配置参数甚至整个配置文件而设计，而 Secrets 则适用于敏感数据，并旨在作为更广泛的机密管理解决方案的一部分使用。
-   你可以通过环境变量、容器启动命令和卷在运行时将两者注入容器。卷是首选方法，因为它们会将更改传播到正在运行的容器。
-   Kubernetes 不会自动加密集群存储中或网络传输中的 Secrets。