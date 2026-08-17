# Category Page Facts Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正确的 Ozon 类目列表在缺少 Seller 类目标识时仍进入人工选样，同时继续逐商品精确校验类目。

**Architecture:** 页面边界只验证严格 Ozon 类目会话 URL，并使用后端签发的会话范围生成页面事实。商品边界继续从商品响应提取精确范围并与会话范围比较。

**Tech Stack:** Chrome MV3、JavaScript、`node:test`、Playwright 回归测试。

## Global Constraints

- 不修改数据库结构、公开 Web API、扩展权限或上传流程。
- 不放宽 Ozon 域名、类目路径、会话参数或商品精确类目校验。
- 不选择、确认或上传真实样本。
- 只处理页面事实错误边界和版本发布。

---

### Task 1: 修正页面事实信任边界

**Files:**
- Modify: `extension/lib/category-strategy-handoff.js`
- Modify: `extension/lib/category-strategy-sampling.js`
- Modify: `extension/background/service-worker.js`
- Test: `extension/tests/category-strategy-handoff.test.js`
- Test: `extension/tests/category-strategy-sampling.test.js`

**Interfaces:**
- Produces: `projectSamplingPageUrl(rawPageUrl, sessionId): string`。
- Produces: `projectCapturedPageFactFromSession({ session, responseHash }): PageFact`。

- [ ] 先写 URL 会话一致性和“页面事实取后端会话范围”的失败测试。
- [ ] 运行聚焦测试，确认因新接口不存在而失败。
- [ ] 实现两个最小投影函数，并把页面捕获改为只哈希公开响应、从会话取得范围。
- [ ] 运行扩展聚焦测试，确认商品范围不匹配测试仍通过。

### Task 2: 发布并真实验证扩展

**Files:**
- Modify: existing extension/app version contract files selected by the repository release script.
- Generate: `app/public/sonli-extension-0.13.46.7/`
- Generate: `app/public/sonli-extension-0.13.46.7.zip`

**Interfaces:**
- Produces: extension version `0.13.46.7` with unchanged public browser bridge protocol.

- [ ] 把版本提升到 `0.13.46.7`，运行仓库现有发布构建生成一致产物。
- [ ] 运行相关扩展、服务、前端桥接测试和构建。
- [ ] 加载本地未打包扩展并新建选样会话。
- [ ] 验证精确类目页、商品列表、人工选样栏和商品选择按钮出现；停止在人工审核前。
