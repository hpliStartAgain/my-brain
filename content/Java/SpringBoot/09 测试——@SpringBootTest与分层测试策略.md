---
title: "测试——@SpringBootTest与分层测试策略"
date: 2026-03-04
tags: [Java, SpringBoot, 测试, SpringBootTest, WebMvcTest, DataJpaTest, Testcontainers, MockMvc, 分层测试]
aliases: []
---

# 测试——@SpringBootTest与分层测试策略

## 摘要

测试是软件工程质量的最后防线，但糟糕的测试策略往往让测试成为开发的负担而非助力。Spring Boot 的测试体系以"测试切片"（Test Slices）为核心设计，提供了从单元测试到全栈集成测试的完整工具链：`@SpringBootTest` 启动完整上下文做端到端验证；`@WebMvcTest` 只加载 Web 层做控制器测试；`@DataJpaTest` 只加载 JPA 层做数据访问测试；`@MockBean` 和 `@SpyBean` 与 Mockito 深度集成……这套"按需加载"的切片测试机制，既保证了测试的精确性，又大幅降低了每个测试的启动时间。本文系统剖析各类测试注解的底层机制、`ApplicationContext` 缓存策略、`Testcontainers` 的集成模式，以及如何构建一套从单元测试到集成测试的分层测试金字塔。

---

## 第 1 章 测试的代价与测试金字塔

### 1.1 测试的本质矛盾

测试的核心矛盾是**置信度**与**速度**之间的张力：
- 启动完整的 Spring Boot 应用进行测试，置信度最高（真实环境），但每次启动需要 10-30 秒，数百个测试跑一遍要几十分钟；
- 用 Mockito 纯单元测试，速度极快（毫秒级），但 Mock 过多会让测试与真实行为脱节，测试通过了线上却出 Bug。

**测试金字塔**是解决这个矛盾的经典模型：

```
          ▲  E2E / Integration Tests
         ▲▲▲  （少量，高置信度，慢）
        ▲▲▲▲▲  Service / Component Tests
       ▲▲▲▲▲▲▲  （适量，覆盖关键路径，中速）
      ▲▲▲▲▲▲▲▲▲  Unit Tests
     ▲▲▲▲▲▲▲▲▲▲▲  （大量，快速，细粒度）
```

Spring Boot 的测试切片机制正是为了填补金字塔中间层——既不像纯单元测试那样 Mock 一切，也不像完整集成测试那样启动所有组件，而是**按需加载与被测组件相关的 Spring Context 切片**。

### 1.2 Spring Boot 测试的核心依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
</dependency>
```

`spring-boot-starter-test` 聚合了以下核心测试库：
- **JUnit 5**（`junit-jupiter`）：测试框架；
- **Mockito**（`mockito-core`、`mockito-junit-jupiter`）：Mock 框架；
- **AssertJ**（`assertj-core`）：流式断言库；
- **Hamcrest**（`hamcrest`）：匹配器库（兼容旧项目）；
- **JSONAssert**（`json-path`、`jsonassert`）：JSON 响应断言；
- **Spring Test**（`spring-test`）：Spring 测试支持（`MockMvc`、`TestRestTemplate` 等）；
- **Spring Boot Test**（`spring-boot-test`、`spring-boot-test-autoconfigure`）：Spring Boot 测试注解和自动配置。

---

## 第 2 章 @SpringBootTest：完整上下文集成测试

### 2.1 @SpringBootTest 的工作原理

`@SpringBootTest` 会启动一个**完整的 Spring Boot ApplicationContext**，与生产环境的启动流程基本一致（包括自动配置、Bean 扫描、配置加载等）：

```java
@SpringBootTest
class OrderServiceIntegrationTest {
    
    @Autowired
    private OrderService orderService;  // 注入真实的 Bean
    
    @Autowired
    private OrderRepository orderRepository;  // 真实的数据库操作
    
    @Test
    void shouldCreateOrderAndPersistToDatabase() {
        // 这是真正的集成测试——调用真实服务，写真实数据库
        OrderRequest request = new OrderRequest(1001L, "PRODUCT-001", 2);
        Order created = orderService.createOrder(request);
        
        assertThat(created.getId()).isNotNull();
        assertThat(orderRepository.findById(created.getId())).isPresent();
    }
}
```

### 2.2 webEnvironment：Web 层的四种模式

`@SpringBootTest` 通过 `webEnvironment` 属性控制是否启动 Web 服务器：

```java
// MOCK（默认）：加载 WebApplicationContext，使用 Mock 的 Servlet 环境
// 不启动真实 HTTP 服务器，配合 MockMvc 使用
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)

// RANDOM_PORT：启动真实 HTTP 服务器，监听随机端口（避免端口冲突）
// 配合 @LocalServerPort 和 TestRestTemplate/WebTestClient 使用
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)

// DEFINED_PORT：启动真实 HTTP 服务器，使用 server.port 配置的端口（默认8080）
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT)

// NONE：不加载 WebApplicationContext，只加载普通 ApplicationContext
// 适合测试纯后端服务，无 Web 层
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE)
```

使用 `RANDOM_PORT` 的完整示例：

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class OrderApiIntegrationTest {
    
    // 注入随机端口（服务器启动后才能确定）
    @LocalServerPort
    private int port;
    
    // TestRestTemplate：专为测试设计的 RestTemplate，内置错误处理和相对 URL 支持
    @Autowired
    private TestRestTemplate restTemplate;
    
    @Test
    void shouldReturnOrderById() {
        ResponseEntity<Order> response = restTemplate.getForEntity(
            "/orders/{id}", Order.class, 1L);
        
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().getId()).isEqualTo(1L);
    }
    
    @Test
    void shouldReturn404ForNonExistentOrder() {
        ResponseEntity<String> response = restTemplate.getForEntity(
            "/orders/{id}", String.class, 999999L);
        
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
```

### 2.3 ApplicationContext 缓存：测试性能的关键

Spring Boot 测试框架会**缓存已创建的 ApplicationContext**，同一个 JVM 进程中，配置相同的测试类共享同一个 ApplicationContext。这意味着：

- 第一个测试类启动时，创建 ApplicationContext（耗时 5-30 秒）；
- 后续配置相同的测试类，**直接复用已缓存的 Context**，不重新启动（耗时几毫秒）；
- 如果修改了 Context 配置（添加 `@MockBean`、修改 `properties`、不同的 `@SpringBootTest` 配置），会创建新的 Context。

**Context 缓存键**由以下因素决定：
- `contextLoader` 的类型；
- `contextInitializerClasses`；
- `contextCustomizers`（包括 `@MockBean`、`@SpyBean` 的 Class 集合）；
- `contextConfigurationAttributes`（测试类上的 `@SpringBootTest` 属性）；
- `activeProfiles`；
- `propertySourceLocations`；
- `propertySourceProperties`（`@SpringBootTest(properties=...)` 中的属性）。

> [!warning] @MockBean 会破坏 Context 缓存
> 每个不同的 `@MockBean` 组合都会产生一个新的 Context 缓存条目。如果 50 个测试类各自 `@MockBean` 不同的组合，就会产生 50 个 ApplicationContext——完全失去缓存效果，测试套件会非常慢。
>
> **最佳实践**：将相同 Mock 组合的测试类抽取公共基类，让子类共享同一个 Context。或者将常用的 Mock 组合集中到一个 `@TestConfiguration` 中统一管理。

```java
// 反模式：每个测试类独立声明 @MockBean，导致 Context 缓存失效
@SpringBootTest
class OrderServiceTest {
    @MockBean PaymentService paymentService;  // ← 产生唯一缓存键
}

@SpringBootTest
class ShipmentServiceTest {
    @MockBean NotificationService notificationService;  // ← 又一个新的缓存键
}

// ✅ 推荐：抽取公共基类，统一 Mock 配置
@SpringBootTest
abstract class BaseIntegrationTest {
    @MockBean PaymentService paymentService;
    @MockBean NotificationService notificationService;
    // 所有继承自本类的测试，使用同一个 ApplicationContext
}

class OrderServiceTest extends BaseIntegrationTest {
    @Autowired OrderService orderService;
    // ...
}

class ShipmentServiceTest extends BaseIntegrationTest {
    @Autowired ShipmentService shipmentService;
    // ...
}
```

---

## 第 3 章 测试切片：精准加载 Spring Context

### 3.1 @WebMvcTest：纯 Web 层测试

`@WebMvcTest` 只加载 Spring MVC 相关的组件（`@Controller`、`@ControllerAdvice`、`@JsonComponent`、`Filter`、`WebMvcConfigurer` 等），不加载 `@Service`、`@Repository` 等业务 Bean：

```java
@WebMvcTest(OrderController.class)  // 只加载 OrderController 及其依赖的 Web 组件
class OrderControllerTest {
    
    // MockMvc：模拟 HTTP 请求，不启动真实 HTTP 服务器
    @Autowired
    private MockMvc mockMvc;
    
    // @WebMvcTest 不加载 Service，需要 Mock
    @MockBean
    private OrderService orderService;
    
    @Autowired
    private ObjectMapper objectMapper;
    
    @Test
    void shouldReturnOrderWhenExists() throws Exception {
        // 准备 Mock 数据
        Order mockOrder = new Order(1L, "CONFIRMED", new BigDecimal("99.00"));
        given(orderService.findById(1L)).willReturn(Optional.of(mockOrder));
        
        // 执行 HTTP 请求并验证响应
        mockMvc.perform(get("/orders/{id}", 1L)
                .contentType(MediaType.APPLICATION_JSON))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(1))
            .andExpect(jsonPath("$.status").value("CONFIRMED"))
            .andExpect(jsonPath("$.amount").value(99.00))
            .andDo(print());  // 打印请求/响应详情（调试时有用）
    }
    
    @Test
    void shouldReturn404WhenOrderNotFound() throws Exception {
        given(orderService.findById(999L)).willReturn(Optional.empty());
        
        mockMvc.perform(get("/orders/{id}", 999L))
            .andExpect(status().isNotFound());
    }
    
    @Test
    void shouldCreateOrderWithValidRequest() throws Exception {
        OrderRequest request = new OrderRequest(1001L, "PRODUCT-001", 2);
        Order created = new Order(88L, "PENDING", new BigDecimal("198.00"));
        
        given(orderService.createOrder(any(OrderRequest.class))).willReturn(created);
        
        mockMvc.perform(post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(request)))
            .andExpect(status().isCreated())
            .andExpect(header().string("Location", containsString("/orders/88")));
    }
    
    @Test
    void shouldReturn400WhenRequestInvalid() throws Exception {
        // quantity 为 0，违反 @Min(1) 约束
        OrderRequest invalidRequest = new OrderRequest(1001L, "PRODUCT-001", 0);
        
        mockMvc.perform(post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(invalidRequest)))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.errors[0].field").value("quantity"));
    }
}
```

**`@WebMvcTest` 自动配置了什么**：
- `MockMvc`（可直接 `@Autowired` 注入）；
- Jackson `ObjectMapper`；
- Spring Security（如果类路径上有，会应用安全配置）；
- `@ControllerAdvice` 异常处理器；
- Spring MVC 转换器、拦截器、Validator 等。

**`@WebMvcTest` 没有配置什么**：
- `@Service`、`@Repository`、`@Component` 等非 Web 层 Bean（必须用 `@MockBean` 替代）；
- JPA、数据源、缓存等基础设施。

### 3.2 MockMvc 的进阶用法

```java
// 自定义 MockMvc：关闭自动配置，完全控制
@WebMvcTest
class AdvancedMockMvcTest {
    
    @Autowired
    private WebApplicationContext webApplicationContext;
    
    private MockMvc mockMvc;
    
    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders
            .webAppContextSetup(webApplicationContext)
            .apply(springSecurity())  // 集成 Spring Security
            .alwaysDo(print())        // 每个请求都打印详情
            .build();
    }
    
    @Test
    @WithMockUser(roles = "ADMIN")  // 模拟已认证的 ADMIN 用户
    void adminCanDeleteOrder() throws Exception {
        mockMvc.perform(delete("/orders/{id}", 1L))
            .andExpect(status().isNoContent());
    }
    
    @Test
    @WithAnonymousUser  // 匿名用户访问受保护资源
    void anonymousCannotDeleteOrder() throws Exception {
        mockMvc.perform(delete("/orders/{id}", 1L))
            .andExpect(status().isUnauthorized());
    }
    
    // 验证 JSON 响应的复杂结构
    @Test
    void shouldReturnPaginatedOrders() throws Exception {
        mockMvc.perform(get("/orders?page=0&size=10"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.content").isArray())
            .andExpect(jsonPath("$.content.length()").value(10))
            .andExpect(jsonPath("$.totalElements").isNumber())
            .andExpect(jsonPath("$.content[0].id").exists())
            .andExpect(jsonPath("$.content[*].status", 
                everyItem(oneOf("PENDING", "CONFIRMED", "SHIPPED"))));
    }
}
```

### 3.3 @DataJpaTest：JPA 数据层测试

`@DataJpaTest` 只加载 JPA 相关组件（`@Entity`、`@Repository`、JPA 配置），默认使用**内嵌数据库**（H2），并在每个测试方法后**自动回滚事务**：

```java
@DataJpaTest
class OrderRepositoryTest {
    
    @Autowired
    private TestEntityManager entityManager;  // 用于准备测试数据
    
    @Autowired
    private OrderRepository orderRepository;
    
    @Test
    void shouldFindOrdersByUserId() {
        // 使用 TestEntityManager 准备测试数据（比直接调用 Repository 更低层）
        User user = entityManager.persist(new User(null, "test@example.com"));
        Order order1 = entityManager.persist(new Order(null, user, "CONFIRMED"));
        Order order2 = entityManager.persist(new Order(null, user, "PENDING"));
        entityManager.flush();  // 确保数据写入数据库（在同一事务内）
        
        List<Order> orders = orderRepository.findByUserId(user.getId());
        
        assertThat(orders).hasSize(2)
            .extracting(Order::getStatus)
            .containsExactlyInAnyOrder("CONFIRMED", "PENDING");
    }
    
    @Test
    void shouldFindActiveOrdersCreatedAfter() {
        LocalDateTime threshold = LocalDateTime.now().minusDays(7);
        
        List<Order> recentOrders = orderRepository
            .findByStatusAndCreatedAtAfter("ACTIVE", threshold);
        
        assertThat(recentOrders).allMatch(o -> 
            o.getStatus().equals("ACTIVE") && 
            o.getCreatedAt().isAfter(threshold));
    }
    
    @Test
    void shouldCalculateTotalAmountByUser() {
        // 测试聚合查询（@Query 注解的 JPQL 或原生 SQL）
        BigDecimal total = orderRepository.sumAmountByUserId(1001L);
        assertThat(total).isGreaterThanOrEqualTo(BigDecimal.ZERO);
    }
}
```

**@DataJpaTest 的关键行为**：
- 默认替换真实数据源为**内嵌 H2**（`@AutoConfigureTestDatabase`）；
- 每个 `@Test` 方法包裹在事务中，方法结束后**自动回滚**（`@Transactional`），保证测试隔离；
- 不加载 `@Service`、`@Controller` 等非 JPA Bean；
- 如果需要测试真实数据库（MySQL），需要 `@AutoConfigureTestDatabase(replace = Replace.NONE)`。

**使用真实数据库（配合 Testcontainers）**：

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers
class OrderRepositoryWithRealDbTest {
    
    @Container
    static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0")
        .withDatabaseName("testdb")
        .withUsername("test")
        .withPassword("test");
    
    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", mysql::getJdbcUrl);
        registry.add("spring.datasource.username", mysql::getUsername);
        registry.add("spring.datasource.password", mysql::getPassword);
    }
    
    @Autowired
    private OrderRepository orderRepository;
    
    @Test
    void shouldPersistOrderToMysql() {
        // 这个测试真正写入 MySQL 容器
        Order order = orderRepository.save(new Order(null, 1001L, "PENDING"));
        assertThat(order.getId()).isNotNull();
    }
}
```

### 3.4 其他重要测试切片

| 注解 | 加载范围 | 典型用途 |
| --- | --- | --- |
| `@WebMvcTest` | Spring MVC 层 | Controller 单元测试 |
| `@WebFluxTest` | Spring WebFlux 层 | Reactive Controller 测试 |
| `@DataJpaTest` | JPA + 内嵌DB | Repository 测试 |
| `@DataMongoTest` | Spring Data MongoDB | MongoDB Repository 测试 |
| `@DataRedisTest` | Spring Data Redis | Redis Repository 测试 |
| `@DataJdbcTest` | Spring Data JDBC | JDBC Repository 测试 |
| `@RestClientTest` | RestTemplate/RestClient | HTTP 客户端测试 |
| `@JsonTest` | JSON 序列化/反序列化 | Jackson 配置测试 |

---

## 第 4 章 @MockBean 与 @SpyBean

### 4.1 @MockBean：替换 Bean 为 Mock 对象

`@MockBean` 将 Spring Context 中的指定类型 Bean 替换为 Mockito Mock 对象：

```java
@SpringBootTest
class PaymentServiceTest {
    
    @Autowired
    private PaymentService paymentService;  // 真实 Bean
    
    @MockBean
    private PaymentGateway paymentGateway;  // Mock 替换
    
    @Test
    void shouldProcessPaymentSuccessfully() {
        // 配置 Mock 行为
        given(paymentGateway.charge(any(ChargeRequest.class)))
            .willReturn(PaymentResult.success("TXN-001"));
        
        PaymentResult result = paymentService.processPayment(
            new PaymentRequest(100L, new BigDecimal("99.00"), "CNY"));
        
        assertThat(result.isSuccessful()).isTrue();
        assertThat(result.getTransactionId()).isEqualTo("TXN-001");
        
        // 验证 Mock 被正确调用
        then(paymentGateway).should(times(1))
            .charge(argThat(req -> req.getAmount().compareTo(new BigDecimal("99.00")) == 0));
    }
    
    @Test
    void shouldHandlePaymentGatewayFailure() {
        given(paymentGateway.charge(any(ChargeRequest.class)))
            .willThrow(new PaymentGatewayException("Network timeout"));
        
        assertThatThrownBy(() -> 
            paymentService.processPayment(new PaymentRequest(100L, new BigDecimal("50.00"), "CNY"))
        ).isInstanceOf(PaymentFailedException.class)
         .hasMessageContaining("Network timeout");
    }
}
```

### 4.2 @SpyBean：部分 Mock，保留真实实现

`@SpyBean` 将 Bean 包装为 Mockito Spy——默认调用真实方法，但可以对特定方法进行 Stub：

```java
@SpringBootTest
class EmailNotificationServiceTest {
    
    @SpyBean
    private EmailNotificationService emailService;  // 真实 Bean，但可 Spy
    
    @Test
    void shouldSendWelcomeEmailOnUserRegistration() {
        // 保留真实的 send 逻辑，但阻止真正发送邮件（避免测试发出真实邮件）
        doNothing().when(emailService).doSend(any(EmailMessage.class));
        
        userService.register(new UserRegistrationRequest("new@example.com", "password"));
        
        // 验证 emailService 被调用了，且携带了正确的内容
        verify(emailService).sendWelcomeEmail(argThat(user -> 
            user.getEmail().equals("new@example.com")));
    }
}
```

> [!info] @MockBean vs @SpyBean 的选择
> - 如果 Bean 的某个依赖**完全不应该**在测试中执行（如支付网关、短信发送、外部 HTTP 调用），用 `@MockBean` 完全替换；
> - 如果 Bean **大部分逻辑应该执行**，只需要拦截某个特定方法（如阻止真实邮件发送，但保留邮件模板渲染逻辑），用 `@SpyBean`。

---

## 第 5 章 Testcontainers：生产级集成测试的基础设施

### 5.1 Testcontainers 是什么，解决什么问题

内嵌数据库（H2）虽然方便，但与生产数据库（MySQL、PostgreSQL）在 SQL 语法、函数、事务行为上存在差异，可能导致"测试通过，生产出错"的问题。

[[Testcontainers]] 通过 Docker 在测试时启动真实的数据库容器，提供与生产环境完全一致的数据库行为，同时保持测试的隔离性（每次测试完毕自动清理容器）。

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>mysql</artifactId>
    <scope>test</scope>
</dependency>
```

### 5.2 Spring Boot 3.1+ 的 @ServiceConnection

Spring Boot 3.1 引入了 `@ServiceConnection`，大幅简化了 Testcontainers 的配置：

```java
@SpringBootTest
@Testcontainers
class OrderServiceIntegrationTest {
    
    // @ServiceConnection 自动将容器的连接信息注入 Spring 配置
    // 无需手动 @DynamicPropertySource
    @Container
    @ServiceConnection
    static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");
    
    @Container
    @ServiceConnection
    static RedisContainer redis = new RedisContainer("redis:7");
    
    @Autowired
    private OrderService orderService;
    
    @Test
    void shouldCreateOrderAndCacheResult() {
        // 真实 MySQL + 真实 Redis
        Order order = orderService.createOrder(new OrderRequest(1001L, "P001", 1));
        
        // 第一次查询：从 MySQL 读取
        Order fetched = orderService.findById(order.getId());
        // 第二次查询：从 Redis 缓存读取
        Order cachedFetch = orderService.findById(order.getId());
        
        assertThat(fetched).isEqualTo(cachedFetch);
    }
}
```

`@ServiceConnection` 的原理：它通过 `ConnectionDetailsFactory` SPI 识别容器类型（`MySQLContainer`、`RedisContainer` 等），自动生成对应的 `ConnectionDetails` Bean（如 `JdbcConnectionDetails`、`RedisConnectionDetails`），这些 Bean 会被自动配置（`DataSourceAutoConfiguration` 等）使用，覆盖 `application.yml` 中的连接配置。

### 5.3 共享容器：优化测试套件性能

每个测试类独立启动容器（`@Container` 在实例字段上）会产生大量容器启动时间。通过 `static` 字段 + `@Container` 共享容器可以优化：

```java
// 方案一：测试基类共享容器（所有子类共用同一个容器）
@Testcontainers
abstract class AbstractIntegrationTest {
    
    // static 字段：容器在整个测试类的生命周期内只启动一次
    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0")
        .withDatabaseName("testdb")
        .withReuse(true);  // withReuse(true)：跨测试运行复用容器（需要 .testcontainers.properties）
    
    @Container
    @ServiceConnection
    static final RedisContainer REDIS = new RedisContainer("redis:7");
}

// 子类直接继承，无需额外配置
@SpringBootTest
class OrderServiceTest extends AbstractIntegrationTest {
    @Autowired OrderService orderService;
    // ...
}

@SpringBootTest
class ShipmentServiceTest extends AbstractIntegrationTest {
    @Autowired ShipmentService shipmentService;
    // ...
}
```

```java
// 方案二：Spring Boot 3.1+ 的 @TestConfiguration + @Bean 方式（推荐）
@TestConfiguration(proxyBeanMethods = false)
class TestContainersConfig {
    
    @Bean
    @ServiceConnection
    MySQLContainer<?> mySQLContainer() {
        return new MySQLContainer<>("mysql:8.0").withDatabaseName("testdb");
    }
    
    @Bean
    @ServiceConnection
    RedisContainer redisContainer() {
        return new RedisContainer("redis:7");
    }
}

@SpringBootTest
@Import(TestContainersConfig.class)
class OrderServiceTest {
    // ...
}
```

---

## 第 6 章 单元测试：不依赖 Spring Context

### 6.1 纯 Mockito 单元测试

对于无状态的工具类、计算逻辑、或者依赖很少的服务，**不需要启动 Spring Context**，用纯 Mockito 即可：

```java
// 没有 @SpringBootTest，没有 Spring Context
@ExtendWith(MockitoExtension.class)
class OrderPricingServiceTest {
    
    @Mock
    private ProductRepository productRepository;
    
    @Mock
    private DiscountService discountService;
    
    @InjectMocks  // 自动注入 @Mock 字段到被测对象
    private OrderPricingService pricingService;
    
    @Test
    void shouldApplyDiscountWhenUserIsVip() {
        // Arrange
        Product product = new Product("P001", new BigDecimal("100.00"));
        given(productRepository.findById("P001")).willReturn(Optional.of(product));
        given(discountService.getDiscount(1001L)).willReturn(new Discount(0.1));  // 10% 折扣
        
        // Act
        BigDecimal price = pricingService.calculatePrice(1001L, "P001", 3);
        
        // Assert：3 * 100 * 0.9 = 270
        assertThat(price).isEqualByComparingTo(new BigDecimal("270.00"));
    }
    
    @Test
    void shouldThrowExceptionWhenProductNotFound() {
        given(productRepository.findById("INVALID")).willReturn(Optional.empty());
        
        assertThatThrownBy(() -> pricingService.calculatePrice(1001L, "INVALID", 1))
            .isInstanceOf(ProductNotFoundException.class)
            .hasMessageContaining("INVALID");
    }
}
```

纯单元测试的优势：
- **极快**：毫秒级，整个测试套件秒级完成；
- **精准**：每个测试只覆盖一个逻辑单元，失败时立即定位问题；
- **无副作用**：不依赖外部资源（数据库、网络），任何环境都可以运行。

### 6.2 @SpringBootTest 与纯单元测试的选择策略

| 场景 | 推荐方式 |
| --- | --- |
| 纯业务逻辑（计算、转换、规则判断） | 纯 Mockito 单元测试 |
| Controller 层（HTTP 映射、参数绑定、响应格式） | `@WebMvcTest` |
| Repository 层（SQL 查询、JPA 映射） | `@DataJpaTest` + Testcontainers |
| Service 层（跨组件集成） | `@SpringBootTest(NONE)` + `@MockBean` 外部依赖 |
| 完整链路（API → Service → DB） | `@SpringBootTest(RANDOM_PORT)` + Testcontainers |
| 自动配置测试（Starter 开发） | `ApplicationContextRunner` |

---

## 第 7 章 测试数据管理

### 7.1 @Sql：基于 SQL 脚本准备测试数据

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = Replace.NONE)
@Testcontainers
class OrderRepositoryComplexQueryTest {
    
    @Container
    @ServiceConnection
    static MySQLContainer<?> mysql = new MySQLContainer<>("mysql:8.0");
    
    @Autowired
    private OrderRepository orderRepository;
    
    @Test
    @Sql("/test-data/orders-for-statistics.sql")     // 执行 SQL 脚本插入测试数据
    @Sql(scripts = "/test-data/cleanup.sql",         // 测试后清理
         executionPhase = Sql.ExecutionPhase.AFTER_TEST_METHOD)
    void shouldCalculateMonthlyStatistics() {
        OrderStatistics stats = orderRepository.getMonthlyStatistics(2026, 3);
        
        assertThat(stats.getTotalOrders()).isEqualTo(10);
        assertThat(stats.getTotalAmount()).isEqualByComparingTo(new BigDecimal("9850.00"));
    }
}
```

### 7.2 @DirtiesContext：强制刷新 Context

当测试修改了 Spring Context 的状态（如修改了静态变量、破坏了单例 Bean 的内部状态），需要强制下一个测试使用新的 Context：

```java
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class StatefulServiceTest {
    // 每个测试方法后都强制创建新的 ApplicationContext
    // 注意：这会大幅降低测试性能，尽量避免使用
}
```

> [!warning] @DirtiesContext 应作为最后手段
> `@DirtiesContext` 会使 Context 缓存失效，每次都重新创建 ApplicationContext，测试速度会显著下降。绝大多数需要用到 `@DirtiesContext` 的场景，都可以通过更好的测试设计来避免：使用 `@Transactional` 自动回滚；使用 `@BeforeEach` 重置共享状态；使用 Testcontainers 隔离数据库状态等。

---

## 第 8 章 测试覆盖率与质量度量

### 8.1 JaCoCo：代码覆盖率度量

```xml
<!-- pom.xml -->
<plugin>
    <groupId>org.jacoco</groupId>
    <artifactId>jacoco-maven-plugin</artifactId>
    <executions>
        <execution>
            <id>prepare-agent</id>
            <goals><goal>prepare-agent</goal></goals>
        </execution>
        <execution>
            <id>report</id>
            <phase>test</phase>
            <goals><goal>report</goal></goals>
        </execution>
        <!-- 覆盖率低于阈值时构建失败 -->
        <execution>
            <id>check</id>
            <goals><goal>check</goal></goals>
            <configuration>
                <rules>
                    <rule>
                        <element>BUNDLE</element>
                        <limits>
                            <limit>
                                <counter>LINE</counter>
                                <value>COVEREDRATIO</value>
                                <minimum>0.80</minimum>  <!-- 行覆盖率最低 80% -->
                            </limit>
                            <limit>
                                <counter>BRANCH</counter>
                                <value>COVEREDRATIO</value>
                                <minimum>0.70</minimum>  <!-- 分支覆盖率最低 70% -->
                            </limit>
                        </limits>
                    </rule>
                </rules>
            </configuration>
        </execution>
    </executions>
</plugin>
```

---

## 总结

Spring Boot 的测试体系以"测试切片"为核心，构建了覆盖不同粒度的测试工具链：

- **测试金字塔**：大量快速单元测试 + 适量切片测试 + 少量完整集成测试，平衡置信度与速度；
- **@SpringBootTest**：完整 Context，四种 `webEnvironment` 模式；Context 缓存是性能关键，`@MockBean` 相同组合的测试类应抽取公共基类共享缓存；
- **测试切片**：`@WebMvcTest`（Web 层）、`@DataJpaTest`（JPA 层）、`@RestClientTest`（HTTP 客户端）等，按需加载，启动快、测试精准；
- **MockMvc**：无需真实 HTTP 服务器，支持 `@WithMockUser` 安全测试、JSONPath 断言；
- **@MockBean / @SpyBean**：`@MockBean` 完全替换、`@SpyBean` 部分拦截，与 Mockito BDD 风格 API 深度集成；
- **Testcontainers**：Docker 启动真实数据库容器，配合 Spring Boot 3.1 的 `@ServiceConnection` 零配置集成，解决内嵌数据库与生产数据库的行为差异问题；
- **纯单元测试**：`@ExtendWith(MockitoExtension.class)` 无 Spring Context，毫秒级执行，是高频业务逻辑的首选测试方式。

下一篇，我们探讨 Spring Boot 3.x 的两大前沿特性：GraalVM Native Image 的编译与运行原理，以及 Project Loom 虚拟线程在 Spring Boot 中的集成：[[10 3.x新特性——GraalVM Native Image与虚拟线程]]。

---

> [!note] 参考资料
> - [Spring Boot 官方文档 - Testing](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.testing)
> - [Testcontainers 官方文档](https://java.testcontainers.org/)
> - [Spring Boot Test Slices](https://docs.spring.io/spring-boot/docs/current/reference/html/test-auto-configuration.html)

---

> [!note] 思考题
> 1. Spring Security 的 Filter 链包含 15+ 个 Filter（如 `UsernamePasswordAuthenticationFilter`、`BasicAuthenticationFilter`、`ExceptionTranslationFilter`）。当引入 Spring Security 依赖后，所有端点默认需要认证。如果你只想保护部分端点（如 `/api/**`），其他端点（如 `/public/**`）免认证，`SecurityFilterChain` 应该如何配置？多个 `SecurityFilterChain` Bean 之间的匹配顺序由什么决定？
> 2. JWT 无状态认证不需要服务端存储 Session，但 JWT 一旦签发就无法撤销（除非使用黑名单）。如果用户修改密码后，之前签发的 JWT 仍然有效——这是一个安全漏洞。你如何在不引入 Session 的前提下实现 JWT 的'即时失效'？Redis 黑名单和短过期时间 + 刷新令牌各有什么取舍？
> 3. CORS（跨域资源共享）和 Spring Security 的关系经常导致困惑——`@CrossOrigin` 注解、`CorsFilter` 和 Spring Security 的 CORS 配置可能互相覆盖。在 Spring Security 开启后，CORS 的 preflight 请求（OPTIONS）会被 Security Filter 拦截导致 403。你如何正确配置 CORS 使其与 Spring Security 协作？
