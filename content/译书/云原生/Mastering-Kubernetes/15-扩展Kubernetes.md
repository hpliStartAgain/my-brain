---
title: 15 - 扩展Kubernetes
date: 2026-05-13
tags: [Kubernetes, Mastering-Kubernetes, 扩展]
aliases:
  - 扩展Kubernetes
  - Chapter 15 - Extending Kubernetes
---

# 扩展Kubernetes

在本章中，我们将深入挖掘Kubernetes的核心。我们将从Kubernetes API开始，学习如何通过直接API访问、controller-runtime Go库以及自动化kubectl来以编程方式使用Kubernetes。然后，我们将研究通过自定义资源扩展Kubernetes API。最后一部分全部关于Kubernetes支持的各种插件。Kubernetes的许多方面都是模块化的，并设计为可扩展。我们将研究API聚合层以及几种类型的插件，如自定义调度器、授权、准入控制、自定义指标和存储。最后，我们将研究扩展kubectl和添加你自己的命令。

涵盖的主题如下：

-   使用Kubernetes API
-   扩展Kubernetes API
-   编写Kubernetes和kubectl插件
-   编写Webhook

## 使用Kubernetes API

Kubernetes API非常全面，包含了Kubernetes的整个功能。正如你所料，它非常庞大。但它遵循最佳实践设计得非常好，并且是一致的。如果你理解了基本原理，你就可以发现你需要知道的一切。我们在第1章"理解Kubernetes架构"中介绍了Kubernetes API本身。如果需要复习，可以去看看。在本节中，我们将深入探讨，学习如何访问和使用Kubernetes API。但是，首先让我们看看OpenAPI，它是为整个Kubernetes API提供结构的正式基础。

### 理解OpenAPI

OpenAPI（以前称为Swagger）是一个开放标准，它定义了一种与语言和框架无关的方式来描述RESTful API。它提供了一种标准化的、机器可读的格式来描述API，包括它们的端点、参数、请求和响应体、认证以及其他元数据。

在Kubernetes的上下文中，OpenAPI用于定义和记录Kubernetes集群的API表面。Kubernetes使用OpenAPI提供了一种标准化的方式来记录和定义可用于配置和管理集群的API对象。Kubernetes API基于声明性模型，用户使用YAML或JSON清单定义其资源的期望状态。这些清单遵循OpenAPI模式，该模式定义了每个资源的结构和属性。Kubernetes使用OpenAPI模式来验证清单，在API客户端中提供自动完成和文档，并生成API参考文档。

在Kubernetes中使用OpenAPI的一个关键好处是它支持为客户端库生成代码。这使开发人员能够使用他们选择的编程语言和生成的客户端库与Kubernetes API交互，这些库提供了一种原生且类型安全的方式来与API交互。

此外，OpenAPI允许像kubectl这样的工具为Kubernetes资源提供自动完成和验证功能。

OpenAPI还能为Kubernetes API自动生成文档。借助OpenAPI模式，Kubernetes可以自动生成API参考文档，这成为理解Kubernetes API及其能力的全面且最新的资源。

自Kubernetes 1.27以来，Kubernetes已稳定支持OpenAPI v3。

更多详情请查看 https://www.openapis.org。

为了在本地使用Kubernetes API，我们需要设置一个代理。

### 设置代理

为简化访问，你可以使用kubectl设置一个代理：

```shell
$ k proxy --port 8080
```

现在，你可以在 http://localhost:8080 上访问API服务器，它将连接到与kubectl配置相同的Kubernetes API服务器。

### 直接探索Kubernetes API

Kubernetes API具有高度可发现性。你只需在浏览器中访问API服务器的URL http://localhost:8080，就能获得一个漂亮的JSON文档，描述 `paths` 键下的所有可用操作。

由于篇幅限制，这里只展示部分列表：

```json
{
  "paths": [
    "/api",
    "/api/v1",
    "/apis",
    "/apis/",
    "/apis/admissionregistration.k8s.io",
    "/apis/admissionregistration.k8s.io/v1",
    "/apis/apiextensions.k8s.io",
    "/livez/poststarthook/storage-object-count-tracker-hook",
    "/logs",
    "/metrics",
    "/openapi/v2",
    "/openapi/v3",
    "/openapi/v3/",
    "/openid/v1/jwks",
    "/readyz/shutdown",
    "/version"
  ]
}
```

你可以深入探索任何一个路径。例如，为了发现default命名空间的端点，我首先调用了 `/api` 端点，然后发现了 `/api/v1`，它告诉我存在 `/api/v1/namespaces`，这指向了 `/api/v1/namespaces/default`。以下是来自 `/api/v1/namespaces/default` 端点的响应：

```json
{
  "kind": "Namespace",
  "apiVersion": "v1",
  "metadata": {
    "name": "default",
    "uid": "7e39c279-949a-4fb6-ae47-796bb797082d",
    "resourceVersion": "192",
    "creationTimestamp": "2022-11-13T04:33:00Z",
    "labels": {
      "kubernetes.io/metadata.name": "default"
    },
    "managedFields": [
      {
        "manager": "kube-apiserver",
        "operation": "Update",
        "apiVersion": "v1",
        "time": "2022-11-13T04:33:00Z",
        "fieldsType": "FieldsV1",
        "fieldsV1": {
          "f:metadata": {
            "f:labels": {
              ".": {},
              "f:kubernetes.io/metadata.name": {}
            }
          }
        }
      }
    ]
  },
  "spec": {
    "finalizers": [
      "kubernetes"
    ]
  },
  "status": {
    "phase": "Active"
  }
}
```

你可以使用cURL甚至kubectl本身等工具从命令行探索Kubernetes API，但有时使用GUI应用程序更方便。

### 使用Postman探索Kubernetes API

Postman（https://www.getpostman.com）是一个非常精致的用于使用RESTful API的应用程序。如果你更倾向于GUI，你可能会发现它非常有用。

以下截图显示了batch v1 API组下的可用端点：

![batch v1 API组下的可用端点](images/ch15-fig01.png)

**图15.1：batch v1 API组下的可用端点**

Postman有很多选项，并以一种非常令人愉悦的方式组织信息。试试看。

### 使用HTTPie和jq过滤输出

API的输出有时可能过于冗长。通常，你只对JSON响应中庞大块中的某一个值感兴趣。例如，如果你想获取所有正在运行的服务的名称，你可以访问 `/api/v1/services` 端点。然而，响应中包含大量不相关的额外信息。以下是输出的一个非常小的一部分：

```shell
$ http http://localhost:8080/api/v1/services
{
  "kind": "ServiceList",
  "apiVersion": "v1",
  "metadata": {
    "resourceVersion": "3237"
  },
  "items": [
    ...
    {
      "metadata": {
        "name": "kube-dns",
        "namespace": "kube-system",
        ...
      },
      "spec": {
        ...
        "selector": {
          "k8s-app": "kube-dns"
        },
        "clusterIP": "10.96.0.10",
        "type": "ClusterIP",
        "sessionAffinity": "None",
      },
      "status": {
        "loadBalancer": {}
      }
    }
  ]
}
```

完整的输出有193行！让我们看看如何使用HTTPie和jq来完全控制输出，只显示服务的名称。我更喜欢使用HTTPie（https://httpie.org/）而不是cURL在命令行上与REST API交互。jq（https://stedolan.github.io/jq/）命令行JSON处理器非常适合对JSON进行切片和切块。

仔细查看完整输出，你可以看到服务名称位于items数组中每个项的metadata部分。将只选择名称的jq表达式如下：

```
.items[].metadata.name
```

以下是完整命令及其在全新kind集群上的输出：

```shell
$ http http://localhost:8080/api/v1/services | jq '.items[].metadata.name'
"kubernetes"
"kube-dns"
```

### 通过Python客户端访问Kubernetes API

使用HTTPie和jq交互式地探索API很棒，但API的真正威力在于你将其消费并与其他软件集成。Kubernetes Incubator项目提供了一个功能齐全且文档完善的Python客户端库。可在 https://github.com/kubernetes-incubator/client-python 获取。

首先，确保你已安装Python（https://wiki.python.org/moin/BeginnersGuide/Download）。然后安装Kubernetes包：

```shell
$ pip install kubernetes
```

要开始与Kubernetes集群通信，你需要连接到它。启动一个交互式Python会话：

```shell
$ python
Python 3.9.12 (main, Aug 25 2022, 11:03:34)
[Clang 13.1.6 (clang-1316.0.21.2.3)] on darwin
Type "help", "copyright", "credits" or "license" for more information.
>>>
```

Python客户端可以读取你的kubectl配置：

```python
>>> from kubernetes import client, config
>>> config.load_kube_config()
>>> v1 = client.CoreV1Api()
```

或者它可以直接连接到已经运行的代理：

```python
>>> from kubernetes import client, config
>>> client.Configuration().host = 'http://localhost:8080'
>>> v1 = client.CoreV1Api()
```

注意，client模块提供了访问不同组版本的方法，比如CoreV1Api。

### 剖析CoreV1Api组

让我们深入了解CoreV1Api组。Python对象有407个公共属性！

```python
>>> attributes = [x for x in dir(v1) if not x.startswith('__')]
>>> len(attributes)
407
```

我们忽略以双下划线开头的属性，因为那些是与Kubernetes无关的特殊类/实例方法。

让我们挑选十个随机方法，看看它们是什么样子：

```python
>>> import random
>>> from pprint import pprint as pp
>>> pp(random.sample(attributes, 10))
['replace_namespaced_persistent_volume_claim',
 'list_config_map_for_all_namespaces_with_http_info',
 'connect_get_namespaced_pod_attach_with_http_info',
 'create_namespaced_event',
 'connect_head_node_proxy_with_path',
 'create_namespaced_secret_with_http_info',
 'list_namespaced_service_account',
 'connect_post_namespaced_pod_portforward_with_http_info',
 'create_namespaced_service_account_token',
 'create_namespace_with_http_info']
```

非常有趣。属性以动词开头，如replace、list或create。其中许多具有命名空间的概念，许多带有 `with_http_info` 后缀。为了更好地理解这一点，让我们统计一下存在多少动词以及每个动词被多少属性使用（其中动词是下划线之前的第一个令牌）：

```python
>>> from collections import Counter
>>> verbs = [x.split('_')[0] for x in attributes]
>>> pp(dict(Counter(verbs)))
{'api': 1,
 'connect': 96,
 'create': 38,
 'delete': 58,
 'get': 2,
 'list': 56,
 'patch': 50,
 'read': 54,
 'replace': 52}
```

我们可以进一步深入，查看特定属性的交互式帮助：

```python
>>> help(v1.create_node)
Help on method create_node in module kubernetes.client.apis.core_v1_api:
create_node(body, **kwargs) method of kubernetes.client.api.core_v1_api.CoreV1Api instance
create_node
create a Node
# noqa: E501
This method makes a synchronous HTTP request by default. To make an
asynchronous HTTP request, please pass async_req=True
>>> thread = api.create_node(body, async_req=True)
>>> result = thread.get()
:param async_req bool: execute request asynchronously
:param V1Node body: (required)
:param str pretty: If 'true', then the output is pretty printed.
:param str dry_run: When present, indicates that modifications should not be persisted. An invalid or unrecognized dryRun directive will result in an error response and no further processing of the request. Valid values are: - All: all dry run stages will be processed
:param str field_manager: fieldManager is a name associated with the actor or entity that is making these changes. The value must be less than or 128 characters long, and only contain printable characters, as defined by https://golang.org/pkg/unicode/#IsPrint.
:param str field_validation: fieldValidation instructs the server on how to handle objects in the request (POST/PUT/PATCH) containing unknown or duplicate fields, provided that the `ServerSideFieldValidation` feature gate is also enabled. Valid values are: - Ignore: This will ignore any unknown fields that are silently dropped from the object, and will ignore all but the last duplicate field that the decoder encounters. This is the default behavior prior to v1.23 and is the default behavior when the `ServerSideFieldValidation` feature gate is disabled. - Warn: This will send a warning via the standard warning response header for each unknown field that is dropped from the object, and for each duplicate field that is encountered. The request will still succeed if there are no other errors, and will only persist the last of any duplicate fields. This is the default when the `ServerSideFieldValidation` feature gate is enabled. - Strict: This will fail the request with a BadRequest error if any unknown fields would be dropped from the object, or if any duplicate fields are present. The error returned from the server will contain all unknown and duplicate fields encountered.
:param _preload_content: if False, the urllib3.HTTPResponse object will be returned without reading/decoding response data. Default is True.
:param _request_timeout: timeout setting for this request. If one number provided, it will be total request timeout. It can also be a pair (tuple) of (connection, read) timeouts.
:return: V1Node
If the method is called returns the request thread.
```

我们看到API非常庞大，这很合理，因为它代表了整个Kubernetes API。我们还学会了如何发现相关方法组以及如何获取特定方法的详细信息。

你可以自己探索，了解更多API。让我们看看一些常见操作，如列出、创建和监视对象。

### 列出对象

你可以列出不同类型的对象。方法名以 `list_` 开头。以下是列出所有命名空间的示例：

```python
>>> for ns in v1.list_namespace().items:
...     print(ns.metadata.name)
...
default
kube-node-lease
kube-public
kube-system
local-path-storage
```

### 创建对象

要创建对象，你需要向create方法传递一个body参数。body必须是一个Python字典，相当于你会和kubectl一起使用的YAML配置清单。最简单的方法是实际使用一个YAML清单，然后使用Python YAML模块（不是标准库的一部分，必须单独安装）来读取YAML文件并将其加载到字典中。例如，要创建一个具有3个副本的nginx-deployment，我们可以使用这个YAML清单（nginx-deployment.yaml）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx
        ports:
        - containerPort: 80
```

要安装YAML Python模块，请键入以下命令：

```shell
$ pip install yaml
```

然后以下Python程序（create_nginx_deployment.py）将创建deployment：

```python
from os import path
import yaml
from kubernetes import client, config

def main():
    # Configs can be set in Configuration class directly or using helper utility.
    # If no argument provided, the config will be loaded from default location.
    config.load_kube_config()
    with open(path.join(path.dirname(__file__), 'nginx-deployment.yaml')) as f:
        dep = yaml.safe_load(f)
    k8s = client.AppsV1Api()
    dep = k8s.create_namespaced_deployment(body=dep, namespace="default")
    print(f"Deployment created. status='{dep.status}'")

if __name__ == '__main__':
    main()
```

让我们运行它并使用kubectl检查deployment是否确实已创建：

```shell
$ python create_nginx_deployment.py
Deployment created. status='{'available_replicas': None,
'collision_count': None,
'conditions': None,
'observed_generation': None,
'ready_replicas': None,
'replicas': None,
'unavailable_replicas': None,
'updated_replicas': None}'
$ k get deploy
NAME               READY   UP-TO-DATE   AVAILABLE   AGE
nginx-deployment   3/3     3            3           56s
```

### 监视对象

监视对象是一项高级能力。它是通过一个单独的watch模块实现的。以下是监视10个命名空间事件并将其打印到屏幕的示例（watch_demo.py）：

```python
from kubernetes import client, config, watch
# Configs can be set in Configuration class directly or using helper utility
config.load_kube_config()
v1 = client.CoreV1Api()
count = 10
w = watch.Watch()
for event in w.stream(v1.list_namespace, _request_timeout=60):
    print(f"Event: {event['type']} {event['object'].metadata.name}")
    count -= 1
    if count == 0:
        w.stop()
print('Done.')
```

以下是输出：

```shell
$ python watch_demo.py
Event: ADDED kube-node-lease
Event: ADDED default
Event: ADDED local-path-storage
Event: ADDED kube-system
Event: ADDED kube-public
```

注意，只打印了5个事件（每个命名空间一个），程序继续等待更多事件。

让我们在另一个终端窗口中创建和删除一些命名空间，这样程序可以结束：

```shell
$ k create ns ns-1
namespace/ns-1 created
$ k delete ns ns-1
namespace "ns-1" deleted
$ k create ns ns-2
namespace/ns-2 created
```

最终输出是：

```shell
$ python watch_demo.py
Event: ADDED default
Event: ADDED local-path-storage
Event: ADDED kube-system
Event: ADDED kube-public
Event: ADDED kube-node-lease
Event: ADDED ns-1
Event: MODIFIED ns-1
Event: MODIFIED ns-1
Event: DELETED ns-1
Event: ADDED ns-2
Done.
```

当然，你可以对事件做出反应，并在事件发生时执行有用的操作（例如，在每个新命名空间中自动部署工作负载）。

### 通过Kubernetes API创建Pod

API也可以用于创建、更新和删除资源。与使用kubectl不同，API需要使用JSON语法而不是YAML语法来指定清单（尽管每个JSON文档也都是有效的YAML）。以下是一个JSON Pod定义（nginx-pod.json）：

```json
{
  "kind": "Pod",
  "apiVersion": "v1",
  "metadata":{
    "name": "nginx",
    "namespace": "default",
    "labels": {
      "name": "nginx"
    }
  },
  "spec": {
    "containers": [{
      "name": "nginx",
      "image": "nginx",
      "ports": [{"containerPort": 80}]
    }]
  }
}
```

以下命令将通过API创建Pod：

```shell
$ http POST http://localhost:8080/api/v1/namespaces/default/pods @nginx-pod.json
```

要验证它是否有效，让我们提取当前Pod的名称和状态。端点是 `/api/v1/namespaces/default/pods`。

jq表达式是 `items[].metadata.name,.items[].status.phase`。

以下是完整命令和输出：

```shell
$ FILTER='.items[].metadata.name,.items[].status.phase'
$ http http://localhost:8080/api/v1/namespaces/default/pods | jq $FILTER
"nginx"
"Running"
```

### 使用Go和controller-runtime控制Kubernetes

Python很酷且易于使用，但对于生产级工具、控制器和operator，我更喜欢使用Go，特别是controller-runtime项目。controller-runtime是用于访问Kubernetes API的标准Go客户端。

#### 通过go-k8s使用controller-runtime

controller-runtime项目是一组Go库，可以以非常高效的方式（例如，高级缓存以避免使API服务器过载）全面查询和操作Kubernetes。

直接使用controller-runtime并不容易。有许多相互关联的部分和不同的实现方式。

请参见 https://pkg.go.dev/sigs.k8s.io/controller-runtime。

我创建了一个名为go-k8s的小型开源项目，它封装了一些复杂性，并帮助以更少的麻烦使用controller-runtime功能的一个子集。

请在此查看：https://github.com/the-gigi/go-k8s/tree/main/pkg/client。

注意，go-k8s项目还有其他库，但我们将专注于client库。

go-k8s client包支持两种类型的客户端：Clientset和DynamicClient。Clientset客户端支持处理已知类型，但需要明确指定API版本、类型和操作作为方法名。例如，使用Clientset列出所有Pod如下所示：

```go
podList, err := clientset.CoreV1().Pods("ns-1").List(context.Background(), metav1.ListOptions{})
```

它返回一个pod列表和一个错误。如果一切正常，error为nil。pod列表是结构体类型PodList，定义在此：https://github.com/kubernetes/kubernetes/blob/master/pkg/apis/core/types.go#L2514。

方便的是，你可以在同一个文件中找到所有Kubernetes API类型。API是高度嵌套的，例如，PodList正如你所料，是一个Pod对象的列表。每个Pod对象都有TypeMeta、ObjectMeta、PodSpec和PodStatus：

```go
type Pod struct {
    metav1.TypeMeta
    metav1.ObjectMeta
    Spec   PodSpec
    Status PodStatus
}
```

在实践中，这意味着当你通过Clientset进行调用时，你会得到一个强类型嵌套对象，非常容易使用。例如，如果我们想检查一个Pod是否有一个名为app的标签及其值，我们可以在一行中完成：

```go
app, ok := pods[0].ObjectMeta.Labels["app"]
```

如果标签不存在，`ok` 将为false。如果存在，则其值将在 `app` 变量中可用。

现在，让我们看看DynamicClient。在这里，你可以获得最大的灵活性，能够处理已知类型以及自定义类型。特别是，如果你想创建任意资源，动态客户端可以以通用方式操作任何Kubernetes类型。

然而，使用动态客户端时，你总是会得到一个类型为Unstructured的通用对象，定义在此：https://github.com/kubernetes/apimachinery/blob/master/pkg/apis/meta/v1/unstructured/unstructured.go#L41。

它实际上是对通用Golang类型 `map[string]interface{}` 的一个非常薄的包装器。它有一个名为Object的字段，类型为 `map[string]interface{}`。这意味着你得到的对象是一个字段名到任意其他对象（表示为 `interface{}`）的映射。要深入层次结构，我们必须进行类型转换，这意味着获取一个 `interface{}` 值并显式地将其转换为实际类型。以下是一个简单示例：

```go
var i interface{} = 5
x, ok := i.(int)
```

现在，`x` 是一个类型为int、值为5的变量，可以像整数一样使用。原始的 `i` 变量不能用作整数，因为它的类型是通用的 `interface{}`，即使它包含一个整数值。

对于从动态客户端返回的对象，我们必须不断将 `interface{}` 转换为 `map[string]interface{}`，直到到达我们感兴趣的字段。要获取Pod的app标签，我们需要遵循以下路径：

```go
pod := pods[0].Object
metadata := pod["metadata"].(map[string]interface{})
labels := metadata["labels"].(map[string]interface{})
app, ok := labels["app"].(string)
```

这非常繁琐且容易出错。幸运的是，有一种更好的方法。Kubernetes apimachinery/runtime包提供了一个转换函数，可以接受一个非结构化对象并将其转换为已知类型：

```go
pod := pods[0].Object
var p corev1.Pod
err = runtime.DefaultUnstructuredConverter.FromUnstructured(pod, &p)
if err != nil {
    return err
}
app, ok = p.ObjectMeta.Labels["app"]
```

controller-runtime非常强大，但处理所有类型可能会很繁琐。一种"作弊"的方法是使用kubectl，它实际上在底层使用了controller-runtime。使用Python及其动态类型尤其容易。

### 从Python和Go以编程方式调用kubectl

如果你不想直接使用REST API或客户端库，你有另一个选择。kubectl主要用作交互式命令行工具，但没有什么能阻止你自动化它并通过脚本和程序调用它。使用kubectl作为你的Kubernetes API客户端有一些好处：

-   易于找到任何用法的示例
-   易于在命令行上试验，找到正确的命令和参数组合
-   kubectl支持JSON或YAML输出，便于快速解析
-   通过kubectl配置内置了认证

#### 使用Python subprocess运行kubectl

让我们先使用Python，这样你可以将使用官方Python客户端与使用自己的客户端进行比较。Python有一个名为subprocess的模块，可以运行像kubectl这样的外部进程并捕获输出。

以下是一个Python 3示例，它自行运行kubectl并显示使用输出的开头部分：

```python
>>> import subprocess
>>> out = subprocess.check_output('kubectl').decode('utf-8')
>>> print(out[:276])
Kubectl controls the Kubernetes cluster manager.
Find more information at https://kubernetes.io/docs/reference/kubectl/overview/.
```

`check_output()` 函数将输出作为字节数组捕获，需要解码为utf-8才能正确显示。我们可以稍微泛化一下，在k.py文件中创建一个名为k()的便捷函数。它接受任意数量的参数传递给kubectl，然后解码输出并返回：

```python
from subprocess import check_output
def k(*args):
    out = check_output(['kubectl'] + list(args))
    return out.decode('utf-8')
```

让我们用它来列出default命名空间中所有正在运行的Pod：

```python
>>> from k import k
>>> print(k('get', 'po'))
NAME                              READY   STATUS    RESTARTS   AGE
nginx                             1/1     Running   0          4h48m
nginx-deployment-679f9c75b-c79mv  1/1     Running   0          132m
nginx-deployment-679f9c75b-cnmvk  1/1     Running   0          132m
nginx-deployment-679f9c75b-gzfgk  1/1     Running   0          132m
```

这很适合显示，但kubectl已经可以做到了。真正的威力来自于使用带 `-o` 标志的结构化输出选项。然后结果可以自动转换为Python对象。以下是k()函数的修改版本，它接受一个布尔型 `use_json` 关键字参数（默认为False），如果为True，则添加 `-o json`，然后将JSON输出解析为Python对象（字典）：

```python
from subprocess import check_output
import json

def k(*args, use_json=False):
    cmd = ['kubectl'] + list(args)
    if use_json:
        cmd += ['-o', 'json']
    out = check_output(cmd).decode('utf-8')
    if use_json:
        out = json.loads(out)
    return out
```

这返回一个完整的API对象，可以像直接访问REST API或使用官方Python客户端一样进行导航和深入探索：

```python
>>> result = k('get', 'po', use_json=True)
>>> for r in result['items']:
...     print(r['metadata']['name'])
...
nginx-deployment-679f9c75b-c79mv
nginx-deployment-679f9c75b-cnmvk
nginx-deployment-679f9c75b-gzfgk
```

让我们看看如何删除deployment并等待所有Pod消失。`kubectl delete` 命令不接受 `-o json` 选项（尽管它有 `-o name`），所以让我们不使用use_json：

```python
>>> k('delete', 'deployment', 'nginx-deployment')
>>> while len(k('get', 'po', use_json=True)['items']) > 0:
...     print('.')
...
.
.
.
Done.
```

Python很好，但如果你更喜欢用Go来自动化kubectl呢？别担心，我正好有你需要的包。kugo包提供了一个简单的Go API来自动化kubectl。你可以在以下地址找到代码：https://github.com/the-gigi/kugo。

它提供了3个函数：Run()、Get()和Exec()。

Run()函数是你的瑞士军刀。它可以按原样运行任何kubectl命令。以下是一个示例：

```go
cmd := fmt.Sprintf("create deployment test-deployment --image nginx --replicas 3 -n ns-1")
_, err := kugo.Run(cmd)
```

这非常方便，因为你可以交互式地组合你需要的准确命令和参数，然后一旦你搞清楚了一切，你可以直接将相同的命令传递给Go程序中的kugo.Run()。

Get()函数是kubectl get的一个智能包装器。它接受一个GetRequest参数，并提供几个便利功能：支持字段选择器、按标签获取以及不同的输出类型。以下是通过自定义kube配置文件和自定义kube上下文按名称获取所有命名空间的示例：

```go
output, err := kugo.Get(kugo.GetRequest{
    BaseRequest: kugo.BaseRequest{
        KubeConfigFile: c.kubeConfigFile,
        KubeContext:    c.GetKubeContext(),
    },
    Kind:   "ns",
    Output: "name",
})
```

最后，Exec()函数是kubectl exec的包装器，允许你在正在运行的Pod/容器上执行命令。它接受一个如下所示的ExecRequest：

```go
type GetRequest struct {
    BaseRequest
    Kind           string
    FieldSelectors []string
    Label          string
    Output         string
}
```

让我们看看Exec()函数的代码。它非常简单。它进行基本验证，确保提供了Command和Target等必填字段，然后以exec命令开头构建kubectl参数列表，最后调用Run()函数：

```go
// Exec executes a command in a pod
//
// The target pod can be specified by name or an arbitrary pod
// from a deployment or service.
//
// If the pod has multiple containers you can choose which
// container to run the command in
func Exec(r ExecRequest) (result string, err error) {
    if r.Command == "" {
        err = errors.New("Must specify Command field")
        return
    }
    if r.Target == "" {
        err = errors.New("Must specify Target field")
        return
    }
    args := []string{"exec", r.Target}
    if r.Container != "" {
        args = append(args, "-c", r.Container)
    }
    args = handleCommonArgs(args, r.BaseRequest)
    args = append(args, "--", r.Command)
    return Run(args...)
}
```

现在，我们已经通过其REST API、客户端库以及控制kubectl以编程方式访问了Kubernetes，是时候学习如何扩展Kubernetes了。

## 扩展Kubernetes API

Kubernetes是一个非常灵活的平台。它从一开始就被设计为可扩展，随着它的演进，Kubernetes的更多部分被开放出来，通过健壮的接口暴露，并可以被替代实现替换。我敢说，初创公司、大型企业、基础设施提供商和云提供商全面指数级采用Kubernetes的直接原因是：Kubernetes提供了大量开箱即用的能力，同时允许与其他参与者轻松集成。在本节中，我们将涵盖许多可用的扩展点，例如：

-   用户定义类型（自定义资源）
-   API访问扩展
-   基础设施扩展
-   Operator
-   调度器扩展

让我们了解扩展Kubernetes的各种方式。

### 理解Kubernetes扩展点和模式

Kubernetes由多个组件组成：API服务器、etcd状态存储、控制器管理器、kube-proxy、kubelet和容器运行时。你可以深入扩展和定制这些组件中的每一个，以及添加你自己的自定义组件来监视和响应事件、处理新的请求以及修改传入请求的一切。

下图显示了一些可用的扩展点以及它们如何连接到各种Kubernetes组件：

![可用扩展点](images/ch15-fig02.png)

**图15.2：可用扩展点**

让我们看看如何用插件扩展Kubernetes。

### 用插件扩展Kubernetes

Kubernetes定义了几个接口，允许它与来自基础设施提供商的各种插件进行交互。我们在前面的章节中已经详细讨论过其中一些接口和插件。为了完整性，我们在这里列出它们：

-   容器网络接口（CNI）——CNI支持大量用于连接节点和容器的网络解决方案
-   容器存储接口（CSI）——CSI支持大量Kubernete的存储选项
-   设备插件——允许节点发现除CPU和内存之外的新节点资源（例如，GPU）

### 使用云控制器管理器扩展Kubernetes

Kubernetes最终需要部署在某些节点上，并使用一些存储和网络资源。最初，Kubernetes只支持Google Cloud Platform和AWS。其他云提供商必须定制多个Kubernetes核心组件（Kubelet、Kubernetes控制器管理器和Kubernetes API服务器）才能与Kubernetes集成。Kubernetes开发者将其视为采用的问题，并创建了云控制器管理器（CCM）。CCM清晰地定义了Kubernetes与其所部署的基础设施层之间的交互。现在，云提供商只需提供针对其基础设施量身定制的CCM实现，就可以使用上游Kubernetes，而无需对Kubernetes代码进行昂贵且容易出错的手动修改。所有Kubernetes组件都通过预定义的接口与CCM交互，Kubernetes完全不知道它运行在哪个云（或没有云）上。

下图展示了Kubernetes和云提供商之间通过CCM的交互：

![通过CCM的Kubernetes与云提供商交互](images/ch15-fig03.png)

**图15.3：通过CCM的Kubernetes与云提供商交互**

如果你想了解更多关于CCM的信息，请查看我几年前写的这篇简洁文章：https://medium.com/@the.gigi/kubernetes-and-cloud-providers-b7a6227d3198。

### 使用Webhook扩展Kubernetes

插件在集群中运行，但在某些情况下，更好的扩展模式是将某些功能委托给集群外的服务。这在访问控制领域非常常见，公司或组织可能已经拥有了集中式身份和访问控制解决方案。在这些情况下，Webhook扩展模式很有用。其理念是，你可以用端点（Webhook）配置Kubernetes。Kubernetes将调用该端点，你可以在那里实现自己的自定义功能，Kubernetes将根据响应采取行动。我们在第4章"保护Kubernetes安全"中讨论认证、授权和动态准入控制时看到了这种模式。Kubernetes为每个Webhook定义了预期的有效载荷。Webhook实现必须遵循这些定义才能成功与Kubernetes交互。

### 使用控制器和Operator扩展Kubernetes

控制器模式是指你编写一个程序，可以在集群内部或外部运行，监视事件并做出响应。控制器的概念模型是将集群的当前状态（控制器感兴趣的部分）与期望状态进行协调。控制器的常见做法是读取对象的Spec，采取一些操作，并更新其Status。Kubernetes的许多核心逻辑由控制器管理器管理的大量控制器实现，但没有什么能阻止我们将自己的控制器部署到集群中或运行远程访问API服务器的控制器。

Operator模式是控制器模式的另一种变体。可以将operator视为一个控制器，它也有自己的一组自定义资源，代表其管理的应用程序。Operator的目标是管理部署在集群中或某些集群外基础设施中的应用程序的生命周期。请访问 https://operatorhub.io 查看现有operator的示例。

如果你计划构建自己的控制器，我建议从Kubebuilder（https://github.com/kubernetes-sigs/kubebuilder）开始。它是一个由Kubernetes API Machinery SIG维护的开放项目，支持使用CRD定义多个自定义API，并搭建出用于监视这些资源的控制器代码。你将用Go实现你的控制器。

然而，有其他多个框架用于编写控制器和operator，采用不同的方法并使用其他编程语言：

-   The Operator Framework
-   Kopf
-   kube-rs
-   KubeOps
-   KUDO
-   Metacontroller

在做出决定之前，请先了解一下它们。

### 扩展Kubernetes调度

用一句话来说，Kubernetes的主要工作是将Pod调度到节点上。调度是Kubernetes的核心功能，而且它做得非常好。Kubernetes调度器可以以非常高级的方式进行配置（daemon set、污点、容忍等）。但是，Kubernetes开发者认识到，可能存在需要控制核心调度算法的特殊情况。可以用你自己的调度器替换核心Kubernetes调度器，或者与内置调度器并行运行另一个调度器来控制一部分Pod的调度。我们将在本章后面看到如何做到这一点。

### 使用自定义容器运行时扩展Kubernetes

Kubernetes最初只支持Docker作为容器运行时。Docker支持被嵌入到核心Kubernetes代码库中。后来，又增加了对rkt的专门支持。Kubernetes开发者看到了曙光，引入了容器运行时接口（CRI），这是一个gRPC接口，使任何实现它的容器运行时都能与kubelet通信。最终，对Docker和rkt的硬编码支持被淘汰，现在kubelet只通过CRI与容器运行时通信：

![kubelet通过CRI与容器运行时通信](images/ch15-fig04.png)

**图15.4：kubelet通过CRI与容器运行时通信**

自CRI引入以来，与Kubernetes兼容的容器运行时数量激增。

我们已经介绍了扩展Kubernetes不同方面的多种方式。现在让我们把注意力转向自定义资源的主要概念，它允许你扩展Kubernetes API本身。

## 介绍自定义资源

扩展Kubernetes的主要方式之一是定义称为自定义资源的新资源类型。你可以用自定义资源做什么？很多。你可以通过Kubernetes API来管理存在于Kubernetes集群之外但你的Pod与之通信的资源。通过将这些外部资源添加为自定义资源，你可以获得系统的完整视图，并受益于许多Kubernetes API功能，例如：

-   自定义CRUD REST端点
-   版本控制
-   监视
-   自动集成通用Kubernetes工具

自定义资源的其他用例包括自定义控制器和自动化程序的元数据。

让我们深入了解自定义资源究竟是什么。

为了与Kubernetes API服务器良好配合，自定义资源必须符合一些基本要求。与内置API对象类似，它们必须具有以下字段：

-   `apiVersion`: `apiextensions.k8s.io/v1`
-   `metadata`: 标准Kubernetes对象元数据
-   `kind`: `CustomResourceDefinition`
-   `spec`: 描述资源在API和工具中的显示方式
-   `status`: 指示CRD的当前状态

spec有一个内部结构，包括group、names、scope、validation和version等字段。status包括acceptedNames和Conditions字段。在下一节中，我将向你展示一个示例，阐明这些字段的含义。

### 开发自定义资源定义

你使用自定义资源定义（简称CRD）来开发自定义资源。其意图是让CRD与Kubernetes、其API和工具平滑集成。这意味着你需要提供大量信息。以下是一个名为Candy的自定义资源示例：

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  # name must match the spec fields below, and be in the form: <plural>.<group>
  name: candies.awesome.corp.com
spec:
  # group name to use for REST API: /apis/<group>/<version>
  group: awesome.corp.com
  # version name to use for REST API: /apis/<group>/<version>
  versions:
  - name: v1
    # Each version can be enabled/disabled by Served flag.
    served: true
    # One and only one version must be marked as the storage version.
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              flavor:
                type: string
  # either Namespaced or Cluster
  scope: Namespaced
  names:
    # plural name to be used in the URL: /apis/<group>/<version>/<plural>
    plural: candies
    # singular name to be used as an alias on the CLI and for display
    singular: candy
    # kind is normally the CamelCased singular type. Your resource manifests use this.
    kind: Candy
    # shortNames allow shorter string to match your resource on the CLI
    shortNames:
    - cn
```

Candy CRD有几个有趣的部分。metadata有一个完全限定的名称，由于CRD是集群范围的，它应该是唯一的。spec有一个versions部分，可以包含多个版本，每个版本都有一个指定自定义资源字段的模式。该模式遵循OpenAPI v3规范（https://github.com/OAI/OpenAPI-Specification/blob/master/versions/3.0.0.md#schemaObject）。scope字段可以是Namespaced或Cluster。如果作用域是Namespaced，那么你从CRD创建的自定义资源将只存在于它们被创建的命名空间中，而集群范围的自定义资源则可以在任何命名空间中使用。最后，names部分指的是自定义资源的名称（不是metadata部分的CRD名称）。names部分有plural、singular、kind和shortNames选项。

让我们创建CRD：

```shell
$ k create -f candy-crd.yaml
customresourcedefinition.apiextensions.k8s.io/candies.awesome.corp.com created
```

注意，返回的是metadata名称。通常使用复数名称。现在，让我们验证我们可以访问它：

```shell
$ k get crd
NAME                          CREATED AT
candies.awesome.corp.com      2022-11-24T22:56:27Z
```

还有一个管理此新资源的API端点：

```
/apis/awesome.corp.com/v1/namespaces/<namespace>/candies/
```

### 集成自定义资源

一旦CustomResourceDefinition对象被创建，你就可以创建该资源类型的自定义资源——在这里是Candy（candy变成驼峰式Candy）。自定义资源必须遵守CRD的模式。在以下示例中，flavor字段被设置到名为chocolate的Candy对象上。`apiVersion` 字段来源于CRD spec的group和versions字段：

```yaml
apiVersion: awesome.corp.com/v1
kind: Candy
metadata:
  name: chocolate
spec:
  flavor: sweeeeeeet
```

让我们创建它：

```shell
$ k create -f chocolate.yaml
candy.awesome.corp.com/chocolate created
```

注意，spec必须包含模式中的flavor字段。

此时，kubectl可以像操作内置对象一样操作Candy对象。使用kubectl时资源名称不区分大小写：

```shell
$ k get candies
NAME       AGE
chocolate  34s
```

我们也可以使用标准的 `-o json` 标志查看原始JSON数据。这次让我们使用短名称cn：

```shell
$ k get cn -o json
{
    "apiVersion": "v1",
    "items": [
        {
            "apiVersion": "awesome.corp.com/v1",
            "kind": "Candy",
            "metadata": {
                "creationTimestamp": "2022-11-24T23:11:01Z",
                "generation": 1,
                "name": "chocolate",
                "namespace": "default",
                "resourceVersion": "750357",
                "uid": "49f68d80-e9c0-4c20-a87d-0597a60c4ed8"
            },
            "spec": {
                "flavor": "sweeeeeeet"
            }
        }
    ],
    "kind": "List",
    "metadata": {
        "resourceVersion": ""
    }
}
```

### 处理未知字段

spec中的模式是在CRD的 `apiextensions.k8s.io/v1` 版本中引入的，该版本在Kubernetes 1.17中稳定。使用 `apiextensions.k8s.io/v1beta` 时，模式不是必需的，因此任意字段是可行的方法。如果你只是尝试将CRD的版本从v1beta更改为v1，你会大吃一惊。Kubernetes会让你更新CRD，但当你稍后尝试创建带有未知字段的自定义资源时，它会失败。

你必须为所有CRD定义模式。如果你必须处理可能具有其他未知字段的自定义资源，你可以关闭验证，但额外的字段将被剥离。

以下是一个Candy资源，它有一个额外的字段texture，未在模式中指定：

```yaml
apiVersion: awesome.corp.com/v1
kind: Candy
metadata:
  name: gummy-bear
spec:
  flavor: delicious
  texture: rubbery
```

如果我们尝试在启用验证的情况下创建它，它会失败：

```shell
$ k create -f gummy-bear.yaml
Error from server (BadRequest): error when creating "gummy-bear.yaml": Candy in version "v1" cannot be handled as a Candy: strict decoding error: unknown field "spec.texture"
```

但是，如果我们关闭验证，那么一切正常，只是只有flavor字段会存在，而texture字段不会：

```shell
$ k create -f gummy-bear.yaml --validate=false
candy.awesome.corp.com/gummy-bear created
$ k get cn gummy-bear -o yaml
apiVersion: awesome.corp.com/v1
kind: Candy
metadata:
  creationTimestamp: "2022-11-24T23:13:33Z"
  generation: 1
  name: gummy-bear
  namespace: default
  resourceVersion: "750534"
  uid: d77d9bdc-5a53-4f8e-8468-c29e2d46f919
spec:
  flavor: delicious
```

有时，保留未知字段可能很有用。CRD可以通过在模式中添加一个特殊字段来支持未知字段。

让我们删除当前的Candy CRD，并替换为支持未知字段的CRD：

```shell
$ k delete -f candy-crd.yaml
customresourcedefinition.apiextensions.k8s.io "candies.awesome.corp.com" deleted
$ k create -f candy-with-unknown-fields-crd.yaml
customresourcedefinition.apiextensions.k8s.io/candies.awesome.corp.com created
```

新的CRD在spec属性中设置了 `x-kubernetes-preserve-unknown-fields` 字段为true：

```yaml
schema:
  openAPIV3Schema:
    type: object
    properties:
      spec:
        type: object
        x-kubernetes-preserve-unknown-fields: true
        properties:
          flavor:
            type: string
```

让我们再次创建gummy bear，这次**启用**验证，并检查未知的texture字段是否存在：

```shell
$ k create -f gummy-bear.yaml
candy.awesome.corp.com/gummy-bear created
$ k get cn gummy-bear -o yaml
apiVersion: awesome.corp.com/v1
kind: Candy
metadata:
  creationTimestamp: "2022-11-24T23:38:01Z"
  generation: 1
  name: gummy-bear
  namespace: default
  resourceVersion: "752234"
  uid: 6863f767-5dc0-43f7-91f3-1c734931b979
spec:
  flavor: delicious
  texture: rubbery
```

### 终结自定义资源

自定义资源像标准API对象一样支持finalizer。Finalizer是一种机制，对象不会被立即删除，而是必须等待在后台运行并监视删除请求的特殊控制器。控制器可以执行任何必要的清理选项，然后从目标对象中移除其finalizer。一个对象上可能有多个finalizer。Kubernetes将等待所有finalizer被移除，然后才删除对象。metadata中的finalizer只是它们对应的控制器可以识别的任意字符串。Kubernetes不知道它们是什么意思。它只是耐心等待所有finalizer在删除对象之前被移除。

以下是一个具有两个finalizer：`eat-me` 和 `drink-me` 的Candy对象示例：

```yaml
apiVersion: awesome.corp.com/v1
kind: Candy
metadata:
  name: chocolate
  finalizers:
  - eat-me
  - drink-me
spec:
  flavor: sweeeeeeet
```

### 添加自定义打印机列

默认情况下，当你用kubectl列出自定义资源时，你只能得到资源的名称和年龄：

```shell
$ k get cn
NAME         AGE
chocolate    11h
gummy-bear   16m
```

但是CRD模式允许你添加自己的列。让我们为Candy对象添加flavor和age作为可打印列：

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: candies.awesome.corp.com
spec:
  group: awesome.corp.com
  versions:
  - name: v1
    ...
    additionalPrinterColumns:
    - name: Flavor
      type: string
      description: The flavor of the candy
      jsonPath: .spec.flavor
    - name: Age
      type: date
      jsonPath: .metadata.creationTimestamp
    ...
```

然后我们可以应用它，再次添加我们的糖果，并列出它们：

```shell
$ k apply -f candy-with-flavor-crd.yaml
customresourcedefinition.apiextensions.k8s.io/candies.awesome.corp.com configured
$ k get cn
NAME         FLAVOR       AGE
chocolate    sweeeeeeet   13m
gummy-bear   delicious    18m
```

### 理解API服务器聚合

当你只需要对你的类型进行一些CRUD操作时，CRD就很好。你可以直接使用Kubernetes API服务器，它会存储你的对象，并提供API支持以及与kubectl等工具的集成。如果你需要更多功能，你可以运行控制器来监视你的自定义资源，并在它们被创建、更新或删除时执行某些操作。Kubebuilder（https://github.com/kubernetes-sigs/kubebuilder）项目是一个很好的框架，用于在CRD之上构建带有自己控制器的Kubernetes API。

但CRD有局限性。如果你需要更高级的功能和定制，你可以使用API服务器聚合，编写你自己的API服务器，Kubernetes API服务器将委托给它。你的API服务器将使用与Kubernetes API服务器相同的API机制。一些高级功能仅通过聚合层才可用：

-   使你的API服务器采用不同于etcd的存储API
-   为你自己的资源扩展长期运行的子资源/端点，如WebSocket
-   将你的API服务器与任何其他外部系统集成
-   控制对象的存储（自定义资源始终存储在etcd中）
-   超越CRUD的自定义操作（例如，exec或scale）
-   使用协议缓冲区有效载荷

编写扩展API服务器是一项不小的工程。如果你决定需要所有这些能力，有几个很好的起点。你可以查看示例API服务器以获得灵感（https://github.com/kubernetes/sample-apiserver）。你可能还想查看apiserver-builder-alpha项目（https://github.com/kubernetes-sigs/apiserver-builder-alpha）。它处理了大量必要的样板代码。API构建器提供了以下功能：

-   引导完整的类型定义、控制器、测试以及文档
-   一个扩展控制平面，你可以在本地集群或实际远程集群上运行
-   你生成的控制器将能够监视和更新API对象
-   添加资源（包括子资源）
-   默认值，如果需要可以覆盖

这里还有一个演练：https://kubernetes.io/docs/tasks/extend-kubernetes/setup-extension-api-server/。

### 构建类Kubernetes控制平面

如果你想使用Kubernetes模型来管理其他东西而不仅仅是Pod呢？事实证明，这是一种非常受欢迎的能力。有一个势头强劲的项目提供了这一点：https://github.com/kcp-dev/kcp。

kcp也涉足多集群管理。

kcp带来了什么？

-   它是多个概念集群（称为工作区workspaces）的控制平面
-   它使外部API服务提供商能够使用多租户operator与中央控制平面集成
-   用户可以在其工作区中轻松使用API
-   灵活地将工作负载调度到物理集群
-   在兼容的物理集群之间透明地移动工作负载
-   用户可以在利用地理复制和跨云复制等能力的同时部署其工作负载

我们已经介绍了通过添加控制器和聚合API服务器来扩展Kubernetes的不同方式。让我们看看另一种扩展Kubernetes的模式——编写插件。

## 编写Kubernetes插件

在本节中，我们将深入Kubernetes的核心，学习如何利用其著名的灵活性和可扩展性。我们将了解可以通过插件定制的不同方面，以及如何实现此类插件并将其与Kubernetes集成。

### 编写自定义调度器

Kubernetes的核心是编排容器化工作负载。最基本的职责是将Pod调度到集群节点上运行。在编写自己的调度器之前，我们需要了解Kubernetes中的调度是如何工作的。

#### 理解Kubernetes调度器的设计

Kubernetes调度器的角色非常简单——当需要创建新的Pod时，将其分配给目标节点。仅此而已。目标节点上的Kubelet将从那里接手，并指示节点上的容器运行时运行Pod的容器。

Kubernetes调度器实现了控制器模式：

-   监视待调度的Pod
-   为Pod选择适当的节点
-   通过设置nodeName字段更新节点的spec

唯一复杂的部分是选择目标节点。这个过程涉及多个步骤，分为两个周期：

1.  调度周期
2.  绑定周期

调度周期是顺序执行的，而绑定周期可以并行执行。如果目标Pod被认为不可调度或发生内部错误，该周期将终止，Pod将被放回队列，稍后重试。

调度器是使用可扩展的调度器框架实现的。该框架定义了多个扩展点，你可以插入这些扩展点以影响调度过程。下图显示了整个过程和扩展点：

![Kubernetes调度器的工作流程](images/ch15-fig05.png)

**图15.5：Kubernetes调度器的工作流程**

调度器考虑了大量的信息和配置。过滤从候选列表中移除不满足某个硬约束的节点。排序节点为每个剩余节点分配分数，并选择最佳节点。

以下是调度器在过滤节点时评估的因素：

-   验证Pod请求的端口在节点上是否可用，确保所需的网络连接。
-   确保Pod被调度到主机名与指定节点偏好匹配的节点上。
-   验证节点上请求的资源（CPU和内存）的可用性，以满足Pod的需求。
-   将节点的标签与Pod的节点选择器或节点亲和性匹配，以确保正确调度。
-   确认节点支持请求的卷类型，考虑存储的故障域限制。
-   评估节点容纳Pod卷请求的能力，考虑现有的挂载卷。
-   通过检查内存压力或PID压力等指标，确保节点的健康状况。
-   评估Pod的容忍度，确定与节点污点的兼容性，从而启用或限制相应的调度。

一旦节点被过滤，调度器将根据以下策略对节点进行评分（你可以配置这些策略）：

-   跨主机分布Pod，同时考虑属于同一Service、StatefulSet或ReplicaSet的Pod。
-   优先考虑Pod间亲和性，这意味着偏爱具有在同节点上运行偏好或亲和性的Pod。
-   应用"最少请求"优先级，偏好请求资源较少的节点。此策略旨在将Pod分布到集群中的所有节点。
-   应用"最多请求"优先级，偏好请求资源最多的节点。此策略倾向于将Pod打包到较少的节点中。
-   使用"请求容量比"优先级，根据请求资源与节点容量的比率计算优先级。它使用默认的资源评分函数形状。
-   优先考虑资源分配均衡的节点，偏好资源使用均衡的节点。
-   利用"节点偏好避免Pod"优先级，根据节点注解 `scheduler.alpha.kubernetes.io/preferAvoidPods` 对节点进行优先级排序。此注解用于指示两个不同的Pod不应在同一节点上运行。
-   应用节点亲和性优先级，根据 `PreferredDuringSchedulingIgnoredDuringExecution` 中指定的节点亲和性调度偏好给予节点偏好。
-   考虑污点容忍度优先级，根据每个节点上不可容忍的污点数量为所有节点准备优先级列表。此策略调整节点的排名，考虑污点因素。
-   使用"镜像局部性"优先级，给予已经具有Pod所需容器镜像的节点更高优先级。
-   使用"服务分布"优先级，优先将支持一个服务的Pod分布到不同节点上。
-   应用Pod反亲和性，这意味着避免在已经具有类似Pod的节点上运行Pod，基于反亲和性规则。
-   使用"等优先级映射"，其中所有节点具有相同的权重，没有偏好或偏见。

更多详情请参阅 https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/。

如你所见，默认调度器非常复杂，可以以非常细粒度进行配置以满足你的大多数需求。但是，在某些情况下，它可能不是最佳选择。

特别是在具有许多节点（数百或数千个）的大型集群中，每次调度Pod时，所有节点都需要经过这种严格且重量级的过滤和评分过程。现在，考虑需要一次调度大量Pod的情况（例如，训练机器学习模型）。这可能会给集群带来很大压力并导致性能问题。Kubernetes可以通过允许你只过滤和评分部分Pod来使过滤和评分过程更轻量化，但你仍然可能想要更好的控制。

幸运的是，Kubernetes允许你以多种方式影响调度过程。这些方式包括：

-   直接将Pod调度到节点
-   用自己的调度器替换默认调度器
-   用额外的过滤器扩展调度器
-   添加另一个与默认调度器并行的调度器

让我们回顾一下你可以用来影响Pod调度的各种方法。

#### 手动调度Pod

你猜怎么着？我们可以在创建Pod时直接告诉Kubernetes将Pod放在哪里。只需要在Pod的spec中指定一个节点名称，调度器就会忽略它。如果你考虑控制器模式的松散耦合特性，这一切都说得通。调度器正在监视尚未分配节点名称的待调度Pod。如果你自己传递节点名称，目标节点上的Kubelet（它监视确实具有节点名称的待调度Pod）就会继续创建新的Pod。

让我们查看我们k3d集群的节点：

```shell
$ k get no
NAME                         STATUS   ROLES                  AGE    VERSION
k3d-k3s-default-agent-1      Ready    <none>                 155d   v1.23.6+k3s1
k3d-k3s-default-server-0     Ready    control-plane,master   155d   v1.23.6+k3s1
k3d-k3s-default-agent-0      Ready    <none>                 155d   v1.23.6+k3s1
```

以下是一个具有预定义节点名称 `k3d-k3s-default-agent-1` 的Pod：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod-manual-scheduling
spec:
  containers:
  - name: some-container
    image: registry.k8s.io/pause:3.8
  nodeName: k3d-k3s-default-agent-1
  schedulerName: no-such-scheduler
```

让我们创建Pod，并确认它确实按请求调度到了k3d-k3s-default-agent-1节点：

```shell
$ k create -f some-pod-manual-scheduling.yaml
pod/some-pod-manual-scheduling created
$ k get po some-pod-manual-scheduling -o wide
NAME                        READY   STATUS    RESTARTS   AGE   IP            NODE
some-pod-manual-scheduling  1/1     Running   0          26s   10.42.2.213   k3d-k3s-default-agent-1
```

直接调度在故障排除时也很有用，当你希望将临时Pod调度到带污点的节点上而无需处理添加容忍度时。

现在让我们创建自己的自定义调度器。

#### 准备我们自己的调度器

我们的调度器将非常简单。它只将所有请求由 `custom-scheduler` 调度的待调度Pod调度到 `k3d-k3s-default-agent-0` 节点。以下是使用kubernetes客户端包的Python实现：

```python
from kubernetes import client, config, watch

def schedule_pod(cli, name):
    target = client.V1ObjectReference()
    target.kind = 'Node'
    target.apiVersion = 'v1'
    target.name = 'k3d-k3s-default-agent-0'
    meta = client.V1ObjectMeta()
    meta.name = name
    body = client.V1Binding(metadata=meta, target=target)
    return cli.create_namespaced_binding('default', body)

def main():
    config.load_kube_config()
    cli = client.CoreV1Api()
    w = watch.Watch()
    for event in w.stream(cli.list_namespaced_pod, 'default'):
        o = event['object']
        if o.status.phase != 'Pending' or o.spec.scheduler_name != 'custom-scheduler':
            continue
        schedule_pod(cli, o.metadata.name)

if __name__ == '__main__':
    main()
```

如果你想长期运行自定义调度器，那么你应该像部署其他任何工作负载一样，将其作为deployment部署到集群中。但是，如果你只是想试用它，或者仍在开发自定义调度器逻辑，你可以在本地运行它，只要它具有正确的凭据来访问集群，并具有监视待调度Pod和更新其节点名称的权限。

注意，我强烈建议在调度框架之上构建生产级自定义调度器（https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/）。

#### 将Pod分配给自定义调度器

好了。我们有一个自定义调度器，可以与默认调度器一起运行。但是，当存在多个调度器时，Kubernetes如何选择使用哪个调度器来调度Pod？

答案是Kubernetes不在乎。Pod可以指定它希望由哪个调度器来调度它。默认调度器将调度任何未指定调度器或明确指定 `default-scheduler` 的Pod。其他自定义调度器应该负责任，只调度请求它们的Pod。如果多个调度器尝试调度同一个Pod，我们可能会遇到多个副本或命名冲突。

例如，我们的简单自定义调度器正在寻找指定调度器名称为 `custom-scheduler` 的待调度Pod。所有其他Pod将被它忽略：

```python
if o.status.phase != 'Pending' or o.spec.scheduler_name != 'custom-scheduler':
    continue
```

以下是一个指定了 `custom-scheduler` 的Pod规格：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: some-pod-with-custom-scheduler
spec:
  containers:
  - name: some-container
    image: registry.k8s.io/pause:3.8
  schedulerName: custom-scheduler
```

如果我们的自定义调度器没有运行，而我们尝试创建这个Pod，会发生什么？

```shell
$ k create -f some-pod-with-custom-scheduler.yaml
pod/some-pod-with-custom-scheduler created
$ k get po
NAME                            READY   STATUS    RESTARTS   AGE
some-pod-manual-scheduling      1/1     Running   0          9m33s
some-pod-with-custom-scheduler  0/1     Pending   0          14s
```

Pod成功创建了（意味着Kubernetes API服务器将其存储在etcd中），但它处于Pending状态，这意味着它尚未被调度。由于它指定了明确的调度器，默认调度器忽略了它。

但是，如果我们运行我们的调度器……它将立即被调度：

```shell
$ python custom_scheduler.py
Waiting for pending pods...
Scheduling pod: some-pod-with-custom-scheduler
```

现在，我们可以看到Pod被分配到了一个节点，并且处于运行状态：

```shell
$ k get po -o wide
NAME                            READY   STATUS    RESTARTS   AGE   IP            NODE
some-pod-manual-scheduling      1/1     Running   0          4h5m  10.42.2.213   k3d-k3s-default-agent-1
some-pod-with-custom-scheduler  1/1     Running   0          87s   10.42.0.125   k3d-k3s-default-agent-0
```

这是对调度和自定义调度器的深入探讨。让我们看看kubectl插件。

### 编写kubectl插件

Kubectl是有抱负的Kubernetes开发人员和管理员的主力工具。现在有非常好的可视化工具体，如k9s（https://github.com/derailed/k9s）、octant（https://github.com/vmware-tanzu/octant）和Lens Desktop（https://k8slens.dev）。但是，对于许多工程师来说，kubectl是与集群交互式工作以及参与自动化工作流的最完整方式。

Kubectl拥有令人印象深刻的能力列表，但你通常需要将多个命令或一长串参数组合起来才能完成某些任务。你可能还想运行集群中安装的一些额外工具。

你可以将此类功能打包为脚本或容器，或任何其他方式，但随后你会遇到将它们放在哪里、如何发现它们以及如何管理它们的问题。Kubectl插件为这些扩展能力提供了一个一站式解决方案。例如，最近我需要定期列出一个运行在Kubernetes集群上的容器化应用程序管理的SFTP服务器上的文件并移动它们。我快速编写了几个kubectl插件，利用我的KUBECONFIG凭据来访问集群中包含访问SFTP服务器凭据的Secret，然后实现了大量用于访问和管理这些SFTP目录和文件的应用程序特定逻辑。

#### 理解kubectl插件

在Kubernetes 1.12之前，kubectl插件需要一个专用的YAML文件，在其中指定各种元数据和其他实现功能的文件。在Kubernetes 1.12中，kubectl开始使用Git扩展模型，其中PATH上任何以 `kubectl-` 为前缀的可执行文件都被视为插件。

Kubectl提供了 `kubectl plugins list` 命令来列出所有当前的插件。这个模型在Git上非常成功，现在添加你自己的kubectl插件极其简单。

如果你添加一个名为 `kubectl-foo` 的可执行文件，那么你可以通过 `kubectl foo` 运行它。你也可以有嵌套命令。将 `kubectl-foo-bar` 添加到你的PATH，然后通过 `kubectl foo bar` 运行它。如果你想在命令中使用短横线，那么在可执行文件中使用下划线。例如，可执行文件 `kubectl-do_stuff` 可以使用 `kubectl do-stuff` 运行。

可执行文件本身可以用任何语言实现，拥有自己的命令行参数和标志，并显示自己的使用和帮助信息。

#### 使用Krew管理kubectl插件

轻量级的插件模型非常适合编写你自己的插件，但如果你想与社区共享你的插件呢？Krew（https://github.com/kubernetes-sigs/krew）是一个kubectl插件包管理器，让你可以发现、安装和管理精选插件。

你可以在Mac上通过Brew安装Krew，或按照其他平台的安装说明进行安装。Krew本身是一个kubectl插件，因为它的可执行文件是 `kubectl-krew`。这意味着你可以直接使用 `kubectl-krew` 运行它，或者通过 `kubectl krew` 运行。如果你为kubectl设置了k别名，你可能更喜欢后一种方式：

```shell
$ k krew
krew is the kubectl plugin manager.
You can invoke krew through kubectl: "kubectl krew [command]..."
Usage:
  kubectl krew [command]

Available Commands:
  completion    generate the autocompletion script for the specified shell
  help          Help about any command
  index         Manage custom plugin indexes
  info          Show information about an available plugin
  install       Install kubectl plugins
  list          List installed kubectl plugins
  search        Discover kubectl plugins
  uninstall     Uninstall plugins
  update        Update the local copy of the plugin index
  upgrade       Upgrade installed plugins to newer versions
  version       Show krew version and diagnostics

Flags:
  -h, --help      help for krew
  -v, --v Level   number for the log level verbosity

Use "kubectl krew [command] --help" for more information about a command.
```

注意，`krew list` 命令只显示Krew管理的插件，而不是所有kubectl插件。它甚至不显示自己。

我建议你查看可用的插件。其中一些非常有用，它们可能会激发你编写自己的插件。让我们看看编写自己的插件有多容易。

#### 创建你自己的kubectl插件

Kubectl插件的范围可以从超级简单到非常复杂。我最近大量使用通过Cluster API和CAPZ（Azure的Cluster API提供商）创建的AKS节点池。我经常对查看特定云提供商上的所有节点池感兴趣。所有节点池都定义在一个名为 `cluster-registry` 的命名空间中的自定义资源中。以下kubectl命令列出所有节点池：

```shell
$ k get -n cluster-registry azuremanagedmachinepools.infrastructure.cluster.x-k8s.io
aks-centralus-cluster-001-nodepool001    116d
aks-centralus-cluster-001-nodepool002    116d
aks-centralus-cluster-002-nodepool001    139d
aks-centralus-cluster-002-nodepool002    139d
aks-centralus-cluster-002-nodepool003    139d
...
```

这不是很多信息。我感兴趣的信息如每个节点池的SKU（VM类型和大小）、其Kubernetes版本以及每个节点池中的节点数。以下kubectl命令可以提供这些信息：

```shell
$ k get -n cluster-registry azuremanagedmachinepools.infrastructure.cluster.x-k8s.io -o custom-columns=NAME:.metadata.name,SKU:.spec.sku,VERSION:.status.version,NODES:.status.replicas
NAME                                          SKU               VERSION   NODES
aks-centralus-cluster-001-nodepool001         Standard_D4s_v4   1.23.8    10
aks-centralus-cluster-001-nodepool002         Standard_D8s_v4   1.23.8    20
aks-centralus-cluster-002-nodepool001         Standard_D16s_v4  1.23.8    30
aks-centralus-cluster-002-nodepool002         Standard_D8ads_v5 1.23.8    40
aks-centralus-cluster-002-nodepool003         Standard_D8ads_v5 1.23.8    50
```

然而，这需要输入很多内容。我只是将这个命令放在一个名为 `kubectl-npa-get` 的文件中，并将其存储在 `/usr/local/bin` 中。现在，我只需调用 `k npa get` 就可以调用它。我可以定义一个小的别名或shell函数，但kubectl插件更合适，因为它是所有与kubectl相关的增强功能的集中位置。它强制执行统一的约定，并且可以通过 `kubectl list plugins` 发现。

这是一个几乎微不足道的kubectl插件示例。让我们看一个更复杂的例子——删除命名空间。事实表明，在Kubernetes中可靠地删除命名空间远非易事。在某些条件下，命名空间在你尝试删除后可能会永远卡在终止状态。我创建了一个小的Go程序来可靠地删除命名空间。你可以在这里查看：https://github.com/the-gigi/k8s-namespace-deleter。

这是kubectl插件的完美用例。README中的说明建议构建可执行文件，然后将其保存为PATH中的 `kubectl-ns-delete`。现在，当你想要删除一个命名空间时，你可以直接使用 `k ns delete <namespace>` 来调用k8s-namespace-deleter，并可靠地删除你的命名空间。

如果你想开发插件并在Krew上分享，那里有更严格的流程。我强烈建议使用Go开发插件，并利用像cli-runtime（https://github.com/kubernetes/cli-runtime/）和krew-plugin-template（https://github.com/replicatedhq/krew-plugin-template）这样的项目。

Kubectl插件很棒，但你应该注意一些问题。我在使用kubectl插件时遇到了一些问题。

#### 不要忘记你的Shebang！

如果你没有为基于shell的可执行文件指定shebang，你会得到一个模糊的错误消息：

```shell
$ k npa get
Error: exec format error
```

#### 命名你的插件

为插件选择名称并不容易。幸运的是，有一些好的指导原则：https://krew.sigs.k8s.io/docs/developer-guide/develop/naming-guide。

这些命名指南不仅适用于Krew插件，对任何kubectl插件都有意义。

#### 覆盖现有的kubectl命令

我最初将插件命名为 `kubectl-get-npa`。理论上，kubectl应该尝试匹配最长的插件名称来解决歧义。但是，显然它对像 `kubectl get` 这样的内置命令不起作用。这是我得到的错误：

```shell
$ k get npa
error: the server doesn't have a resource type "npa"
```

将插件重命名为 `kubectl-npa-get` 解决了问题。

#### Krew插件的扁平命名空间

kubectl插件的空间是扁平的。如果你选择一个通用的插件名称，如 `kubectl-login`，你会有很多问题。即使你用类似 `kubectl-gcp-login` 的东西限定它，你也可能与其他插件冲突。这是一个可扩展性问题。我认为解决方案应该涉及类似DNS的插件强命名方案，以及为方便起见定义短名称和别名的能力。

我们已经介绍了kubectl插件、如何编写它们以及如何使用它们。让我们看看使用Webhook扩展访问控制。

### 使用访问控制Webhook

Kubernetes提供了几种自定义访问控制的方式。在Kubernetes中，访问控制可以用三个A表示：认证（Authentication）、授权（Authorization）和准入控制（Admission control）。在早期版本中，访问控制是通过需要Go编程、安装到集群、注册以及其他侵入性流程的插件实现的。现在，Kubernetes允许你通过Webhook自定义认证、授权和准入控制。以下是访问控制工作流程：

![访问控制工作流程](ch15-fig06.png)

**图15.6：访问控制工作流程**

#### 使用认证Webhook

Kubernetes允许你通过为承载令牌注入Webhook来扩展认证过程。它需要两条信息：如何访问远程认证服务以及认证决策的持续时间（默认为两分钟）。

要提供这些信息并启用认证Webhook，请使用以下命令行参数启动API服务器：

```
--authentication-token-webhook-config-file=<authentication config file>
--authentication-token-webhook-cache-ttl (how long to cache auth decisions, default to 2 minutes)
```

配置文件使用kubeconfig文件格式。以下是一个示例：

```yaml
# Kubernetes API version
apiVersion: v1
# kind of the API object
kind: Config
# clusters refers to the remote service.
clusters:
- name: name-of-remote-authn-service
  cluster:
    certificate-authority: /path/to/ca.pem  # CA for verifying the remote service.
    server: https://authn.example.com/authenticate  # URL of remote service to query. Must use 'https'.
# users refers to the API server's webhook configuration.
users:
- name: name-of-api-server
  user:
    client-certificate: /path/to/cert.pem  # cert for the webhook plugin to use
    client-key: /path/to/key.pem  # key matching the cert
# kubeconfig files require a context. Provide one for the API server.
current-context: webhook
contexts:
- context:
    cluster: name-of-remote-authn-service
    user: name-of-api-sever
  name: webhook
```

注意，必须向Kubernetes提供客户端证书和密钥，以便与远程认证服务进行双向认证。

缓存TTL很有用，因为用户通常会对Kubernetes进行多个连续请求。缓存认证决策可以节省到远程认证服务的大量往返。

当API HTTP请求进入时，Kubernetes从其标头中提取承载令牌，并通过Webhook向远程认证服务发布一个TokenReview JSON请求：

```json
{
  "apiVersion": "authentication.k8s.io/v1",
  "kind": "TokenReview",
  "spec": {
    "token": "<bearer token from original request headers>"
  }
}
```

远程认证服务将返回一个决策。`status.authentication` 将为true或false。以下是成功认证的示例：

```json
{
  "apiVersion": "authentication.k8s.io/v1",
  "kind": "TokenReview",
  "status": {
    "authenticated": true,
    "user": {
      "username": "gigi@gg.com",
      "uid": "42",
      "groups": [
        "developers"
      ],
      "extra": {
        "extrafield1": [
          "extravalue1",
          "extravalue2"
        ]
      }
    }
  }
}
```

被拒绝的响应要简洁得多：

```json
{
  "apiVersion": "authentication.k8s.io/v1",
  "kind": "TokenReview",
  "status": {
    "authenticated": false
  }
}
```

#### 使用授权Webhook

授权Webhook与认证Webhook非常相似。它只需要一个配置文件，格式与认证Webhook配置文件相同。没有授权缓存，因为与认证不同，同一用户可能会向具有不同参数的不同API端点发出大量请求，并且授权决策可能不同，因此缓存不是可行的选择。

你通过向API服务器传递以下命令行参数来配置Webhook：

```
--authorization-webhook-config-file=<configuration filename>
```

当请求通过认证后，Kubernetes将向远程授权服务发送一个SubjectAccessReview JSON对象。它将包含请求用户（以及其所属的任何用户组）和其他属性，如请求的API组、命名空间、资源和动词：

```json
{
  "apiVersion": "authorization.k8s.io/v1",
  "kind": "SubjectAccessReview",
  "spec": {
    "resourceAttributes": {
      "namespace": "awesome-namespace",
      "verb": "get",
      "group": "awesome.example.org",
      "resource": "pods"
    },
    "user": "gigi@gg.com",
    "group": [
      "group1",
      "group2"
    ]
  }
}
```

请求要么被允许：

```json
{
  "apiVersion": "authorization.k8s.io/v1",
  "kind": "SubjectAccessReview",
  "status": {
    "allowed": true
  }
}
```

要么被拒绝并附带原因：

```json
{
  "apiVersion": "authorization.k8s.io/v1beta1",
  "kind": "SubjectAccessReview",
  "status": {
    "allowed": false,
    "reason": "user does not have read access to the namespace"
  }
}
```

用户可能被授权访问某种资源，但无法访问某些非资源属性，比如 `/api`、`/apis`、`/metrics`、`/resetMetrics`、`/logs`、`/debug`、`/healthz`、`/swagger-ui/`、`/swaggerapi/`、`/ui` 和 `/version`。

以下是请求访问日志的方式：

```json
{
  "apiVersion": "authorization.k8s.io/v1",
  "kind": "SubjectAccessReview",
  "spec": {
    "nonResourceAttributes": {
      "path": "/logs",
      "verb": "get"
    },
    "user": "gigi@gg.com",
    "group": [
      "group1",
      "group2"
    ]
  }
}
```

我们可以使用kubectl的 `can-i` 命令来检查我们是否被授权执行某个操作。例如，让我们看看我们是否可以创建deployment：

```shell
$ k auth can-i create deployments
yes
```

我们也可以检查其他用户或服务账户是否被授权做某事。默认的服务账户不允许创建deployment：

```shell
$ k auth can-i create deployments --as default
no
```

#### 使用准入控制Webhook

动态准入控制也支持Webhook。自Kubernetes 1.16以来，它已经普遍可用。根据你的Kubernetes版本，你可能需要使用 `--enable-admission-plugins=Mutating,ValidatingAdmissionWebhook` 标志为kube-apiserver启用MutatingAdmissionWebhook和ValidatingAdmissionWebhook准入控制器。

Kubernetes开发者推荐运行几个其他准入控制器（顺序很重要）：

```
--admission-control=NamespaceLifecycle,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,ResourceQuota
```

在Kubernetes 1.25中，这些插件默认启用。

#### 动态配置Webhook准入控制器

认证和授权Webhook必须在启动API服务器时配置。准入控制Webhook可以通过创建MutatingWebhookConfiguration或ValidatingWebhookConfiguration API对象来动态配置。以下是一个示例：

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
...
webhooks:
- name: admission-webhook.example.com
  rules:
  - operations: ["CREATE", "UPDATE"]
    apiGroups: ["apps"]
    apiVersions: ["v1", "v1beta1"]
    resources: ["deployments", "replicasets"]
    scope: "Namespaced"
  ...
```

准入服务器访问如下所示的AdmissionReview请求：

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-6393-11e8-b7cc-42010a800002",
    "kind": {"group":"autoscaling","version":"v1","kind":"Scale"},
    "resource": {"group":"apps","version":"v1","resource":"deployments"},
    "subResource": "scale",
    "requestKind": {"group":"autoscaling","version":"v1","kind":"Scale"},
    "requestResource": {"group":"apps","version":"v1","resource":"deployments"},
    "requestSubResource": "scale",
    "name": "cool-deployment",
    "namespace": "cool-namespace",
    "operation": "UPDATE",
    "userInfo": {
      "username": "admin",
      "uid": "014fbff9a07c",
      "groups": ["system:authenticated","my-admin-group"],
      "extra": {
        "some-key":["some-value1", "some-value2"]
      }
    },
    "object": {"apiVersion":"autoscaling/v1","kind":"Scale",...},
    "oldObject": {"apiVersion":"autoscaling/v1","kind":"Scale",...},
    "options": {"apiVersion":"meta.k8s.io/v1","kind":"UpdateOptions",...},
    "dryRun": false
  }
}
```

如果请求被准入，响应将是：

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "response": {
    "uid": "<value from request.uid>",
    "allowed": true
  }
}
```

如果请求未被准入，则allowed将为False。准入服务器也可以提供一个status部分，包含HTTP状态码和消息：

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "response": {
    "uid": "<value from request.uid>",
    "allowed": false,
    "status": {
      "code": 403,
      "message": "You cannot do this because I say so!!!!"
    }
  }
}
```

这对我们关于动态准入控制的讨论做出了总结。让我们看看更多的扩展点。

## 额外的扩展点

还有一些额外的扩展点不属于我们到目前为止讨论的类别。

### 为水平Pod自动扩缩提供自定义指标

在Kubernetes 1.6之前，自定义指标是通过Heapster模型实现的。在Kubernetes 1.6中，新的自定义指标API出现并逐渐成熟。从Kubernetes 1.9开始，它们默认启用。你可能还记得，Keda（https://keda.sh）是一个专注于自动扩缩的自定义指标的项目。但是，如果由于某种原因Keda不能满足你的需求，你可以实现自己的自定义指标。自定义指标依赖于API聚合。推荐的路径是从自定义指标API服务器样板开始，可在此处获取：https://github.com/kubernetes-sigs/custom-metrics-apiserver。

然后，你可以实现CustomMetricsProvider接口：

```go
type CustomMetricsProvider interface {
    // GetRootScopedMetricByName fetches a particular metric for a particular root-scoped object.
    GetRootScopedMetricByName(groupResource schema.GroupResource, name string, metricName string) (*custom_metrics.MetricValue, error)
    // GetRootScopedMetricByName fetches a particular metric for a set of root-scoped objects
    // matching the given label selector.
    GetRootScopedMetricBySelector(groupResource schema.GroupResource, selector labels.Selector, metricName string) (*custom_metrics.MetricValueList, error)
    // GetNamespacedMetricByName fetches a particular metric for a particular namespaced object.
    GetNamespacedMetricByName(groupResource schema.GroupResource, namespace string, name string, metricName string) (*custom_metrics.MetricValue, error)
    // GetNamespacedMetricByName fetches a particular metric for a set of namespaced objects
    // matching the given label selector.
    GetNamespacedMetricBySelector(groupResource schema.GroupResource, namespace string, selector labels.Selector, metricName string) (*custom_metrics.MetricValueList, error)
    // ListAllMetrics provides a list of all available metrics at
    // the current time. Note that this is not allowed to return
    // an error, so it is recommended that implementors cache and
    // periodically update this list, instead of querying every time.
    ListAllMetrics() []CustomMetricInfo
}
```

### 使用自定义存储扩展Kubernetes

卷插件是另一种类型的插件。在Kubernetes 1.8之前，你必须编写一个kubelet插件，这需要向Kubernetes注册并与kubelet链接。Kubernetes 1.8引入了FlexVolume，它更加通用。Kubernetes 1.9通过CSI将这一提升到了新的水平，我们在第6章"管理存储"中已经介绍过。此时，如果你需要编写存储插件，CSI是可行的方法。由于CSI使用gRPC协议，CSI插件必须实现以下gRPC接口：

```protobuf
service Controller {
    rpc CreateVolume (CreateVolumeRequest)
        returns (CreateVolumeResponse) {}
    rpc DeleteVolume (DeleteVolumeRequest)
        returns (DeleteVolumeResponse) {}
    rpc ControllerPublishVolume (ControllerPublishVolumeRequest)
        returns (ControllerPublishVolumeResponse) {}
    rpc ControllerUnpublishVolume (ControllerUnpublishVolumeRequest)
        returns (ControllerUnpublishVolumeResponse) {}
    rpc ValidateVolumeCapabilities (ValidateVolumeCapabilitiesRequest)
        returns (ValidateVolumeCapabilitiesResponse) {}
    rpc ListVolumes (ListVolumesRequest)
        returns (ListVolumesResponse) {}
    rpc GetCapacity (GetCapacityRequest)
        returns (GetCapacityResponse) {}
    rpc ControllerGetCapabilities (ControllerGetCapabilitiesRequest)
        returns (ControllerGetCapabilitiesResponse) {}
}
```

这不是一项简单的工程，通常只有存储解决方案提供商才应该实现CSI插件。

自定义指标和自定义存储解决方案的额外扩展点展示了Kubernetes致力于真正可扩展，并允许其用户自定义其操作的几乎所有方面的承诺。

## 总结

在本章中，我们涵盖了三个主要主题：使用Kubernetes API、扩展Kubernetes API以及编写Kubernetes插件。Kubernetes API支持OpenAPI规范，是遵循所有当前最佳实践的REST API设计的绝佳示例。它非常一致、组织良好且文档完善。然而，它是一个庞大的API，不容易理解。你可以通过HTTP上的REST直接访问API，使用包括官方Python客户端在内的客户端库，甚至通过以编程方式调用kubectl。

扩展Kubernetes API可能涉及定义你自己的自定义资源、编写控制器/operator，以及可选地通过API聚合扩展API服务器本身。

插件和Webhook是Kubernetes设计的基础。Kubernetes一直旨在被用户扩展以适应任何需求。我们研究了各种插件，如自定义调度器、kubectl插件和访问控制Webhook。Kubernetes为编写、注册和集成所有这些插件提供了如此无缝的体验，这非常酷。

我们还研究了自定义指标，甚至如何通过自定义存储选项扩展Kubernetes。

至此，你应该清楚地了解所有主要的扩展、定制和控制Kubernetes的机制——通过API访问、自定义资源、控制器、operator和自定义插件。你将处于绝佳位置，可以利用这些能力来增强Kubernetes的现有功能，并根据你的需求和系统进行调整。

在下一章中，我们将研究通过策略引擎来治理Kubernetes。这将延续扩展Kubernetes的主题，因为策略引擎就是加强版的动态准入控制器。我们将涵盖治理的所有内容，回顾现有的策略引擎，并深入探讨Kyverno，我认为它是Kubernetes的最佳策略引擎。
