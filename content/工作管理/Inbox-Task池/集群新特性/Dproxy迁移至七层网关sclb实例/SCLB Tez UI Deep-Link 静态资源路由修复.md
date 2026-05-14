---
type: task
status: todo
priority: P0
deadline: 2026-05-16
domain: 集群新特性
lifecycle: engineering
progress: "0"
completed_date:
started_date: 2026-05-11
tags: [Dproxy, SCLB, TezUI, 路由修复]
parent: Dproxy迁移至七层网关sclb实例
---

# SCLB Tez UI Deep-Link 静态资源路由修复

## 背景

Dproxy → SCLB 七层网关迁移的浏览器业务级验证清单（33 项）中，A05/H01/H02/H03 共 4 项仍未通过，根因已收敛为 **SCLB 平台对 Tez deep-link 静态资源路由存在生效异常**。

详见：[[浏览器业务级验证清单]]

## 问题根因

Tez UI 的 deep-link 页面（`/tez-ui/app/<appId>` 或 `/knox/gateway/venus/tez/app/<appId>`）依赖的静态资源 `assets/vendor.js`、`assets/tez-ui.js`、`config/configs.js` 落在 `/app/assets/*`、`/app/config/*` 子路径下。这些子路径当前返回 HTML 而非 JS/CSS，导致前端在 `vendor.js` 加载阶段白屏。

已尝试的修复手段未彻底生效：

| 修复尝试 | 状态 |
|---|---|
| `tez-ui.js` 中 `hosts.timeline`/`hosts.rm` 改写为公网地址 | ✅ 已生效 |
| 新增 `r-tez-ui-deeplink-assets`（承接 `/app/assets/*`、`/app/config/*`）| ❌ 长期"发布中"，未生效 |
| 新增 `r-tez-ui-deeplink-pages`（承接 `/app/*`、`/dag/*`）| ❌ 长期"发布中"，未生效 |
| `r-tez-ui-static` 切换 `serverless-pre-function` 做 URI 重写 | ❌ 保存成功但运行面未生效 |

**核心阻塞**：SCLB 控制面路由发布链路存在平台级异常，新路由/新配置无法稳定推送到数据面。

## 解决方案

1. [ ] 联系 SCLB 平台侧排查 `r-tez-ui-deeplink-assets` / `r-tez-ui-deeplink-pages` 发布卡死原因
2. [ ] 验证 `serverless-pre-function` 在 `r-tez-ui-static` 上的实际生效状态
3. [ ] 浏览器终验 A05/H01/H02/H03（访问 deep-link 页面，确认 DAG 图渲染正常，无白屏）
4. [ ] 更新 [[浏览器业务级验证清单]] 验证结果

## 验收标准

- 浏览器访问 `http://10.18.102.127/tez-ui/app/<appId>` → DAG 图正常渲染
- 浏览器访问 `http://10.18.102.127/knox/gateway/venus/tez/app/<appId>` → DAG 图正常渲染
- DevTools Network 中静态资源（vendor.js/tez-ui.js/configs.js）均返回 200 且 content-type 正确
- DevTools Network 中 WebSocket 连接状态 101
