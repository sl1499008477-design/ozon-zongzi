# 类目策略扩展桥接超时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许已连接扩展在 Chrome MV3 冷启动后返回有效就绪回执，避免 1.5 秒误判。

**Architecture:** 保持管理页 → 扩展 → 服务端的现有安全顺序，只调整管理页消息桥的有界等待契约。错误码、公开 API、数据库和扩展采集逻辑不变。

**Tech Stack:** React 前端、浏览器 `window.postMessage`、Node.js 内置测试运行器。

## Global Constraints

- 默认等待上限为 15 秒，可配置上限为 30 秒。
- 不增加重试、依赖或新抽象。
- 保留鉴权、权限、账号隔离、精确类目、人工确认与上传保护。
- 不选择样品、不确认、不上传、不变更数据库。

---

### Task 1: 修正桥接等待契约

**Files:**
- Modify: `app/tests/category-strategy-extension-bridge.test.mjs`
- Modify: `app/src/category-strategy-extension-bridge.js`

**Interfaces:**
- Consumes: `createCategoryStrategyExtensionBridge({ windowObject, timeoutMs })`
- Produces: 同一公开函数和错误码；默认等待 15 秒。

- [ ] **Step 1: 写失败测试**

新增使用默认超时创建桥接器的测试，在 1.8 秒后发送闭合、同源、同请求 ID 的有效就绪回执，并断言 `ready()` 成功且监听器被清理。

- [ ] **Step 2: 验证测试因旧 1.5 秒上限失败**

Run: `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/category-strategy-extension-bridge.test.mjs`

Expected: 新测试以 `AUTO_LISTING_CATEGORY_STRATEGY_SESSION_HANDOFF_NOT_READY` 失败；原有测试通过。

- [ ] **Step 3: 最小修改生产代码**

将 `createCategoryStrategyExtensionBridge` 的 `timeoutMs` 默认值改为 `15_000`，并将构造参数允许的最大值改为 `30_000`；其他逻辑不变。

- [ ] **Step 4: 验证相关测试**

Run: `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/category-strategy-extension-bridge.test.mjs app/tests/category-strategy-bootstrap.test.mjs`

Expected: 全部通过，0 失败。

- [ ] **Step 5: 构建并真实验证**

运行项目现有扩展构建与相关校验，更新本地加载目录，然后在 Chrome 中验证正确类目页、商品列表和选样控件；不得点击选样、确认、取消或上传。

