# 类目策略选样页打开失败修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 即使采集草稿来源是 Ozon 商品详情页，也始终向扩展返回当前精确类目的标准选样页。

**Architecture:** 保留扩展现有的严格网址白名单，在服务器类目策略服务这一权威边界用草稿的 `descriptionCategoryId` 构造标准 Ozon 类目页。来源商品地址继续只作为内部来源事实，不再决定浏览器选样路径。

**Tech Stack:** Node.js ESM、`node:test`、现有类目策略服务与浏览器扩展 URL 白名单。

## Global Constraints

- 不修改数据库结构、公开 API、扩展权限、扩展产物、上传方式或人工审核流程。
- 不放宽 Ozon 域名、类目路径或会话查询参数白名单。
- 会话密钥不得进入浏览器 URL；只允许现有会话编号查询参数。
- 只修改本故障直接涉及的服务和测试，不增加依赖、抽象层或兼容层。

---

### Task 1: 用商品来源地址复现并修复选样 URL

**Files:**
- Modify: `server/tests/auto-listing-category-strategy-service.test.mjs`
- Modify: `server/auto-listing-category-strategy-service.mjs`

**Interfaces:**
- Consumes: `draft.scope.descriptionCategoryId: number` 与 `sessionId: string`。
- Produces: `samplingBrowserUrl(descriptionCategoryId, sessionId): string`，格式为 `https://www.ozon.ru/category/<descriptionCategoryId>/?zongziCategoryStrategySession=<sessionId>`。

- [ ] **Step 1: 把现有会话安全测试的来源改成代表性商品页**

在 `sampling session uses DB-authoritative repository expiry and never returns its secret` 测试中使用独立于期望类目地址的商品来源：

```js
const h = harness({ currentDraft: draft({
  browserUrl: "https://www.ozon.ru/product/mqouo-shkaf-skladnoy-turisticheskiy-1941181573/?at=tracking",
}) });
```

保留手工推导的期望值：返回地址的路径必须是 `/category/17028922/`，且唯一业务查询参数是当前会话编号。

- [ ] **Step 2: 运行测试并确认它因返回商品路径而失败**

Run:

```bash
node --test --test-name-pattern="sampling session uses DB-authoritative" server/tests/auto-listing-category-strategy-service.test.mjs
```

Expected: FAIL，实际路径是 `/product/mqouo-shkaf-skladnoy-turisticheskiy-1941181573/`，期望路径是 `/category/17028922/`。

- [ ] **Step 3: 用类目编号生成标准选样页**

将服务中的 URL 构造函数改为只接收已验证的类目编号：

```js
function samplingBrowserUrl(descriptionCategoryId, sessionId) {
  const url = new URL(`https://www.ozon.ru/category/${positive(descriptionCategoryId)}/`);
  url.searchParams.set("zongziCategoryStrategySession", identifier(sessionId));
  return url.href;
}
```

把详情读取、会话重放和首次会话返回处的调用统一改为：

```js
samplingBrowserUrl(draft.scope.descriptionCategoryId, row.sessionId)
```

详情读取使用已有 `item.sessionId`。不删除 `draft.browserUrl` 的内部读取字段，以避免把本次缺陷修复扩大成仓储契约重构。

- [ ] **Step 4: 运行聚焦测试并确认通过**

Run:

```bash
node --test --test-name-pattern="sampling session uses DB-authoritative" server/tests/auto-listing-category-strategy-service.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 运行直接相关的完整回归**

Run:

```bash
node --test server/tests/auto-listing-category-strategy-service.test.mjs
node --test app/tests/category-strategy-extension-bridge.test.mjs
node --test extension/tests/category-strategy-handoff.test.js
pnpm --dir app build
```

Expected: 所有测试 0 失败，前端构建退出码为 0。

- [ ] **Step 6: 提交单一修复批次**

```bash
git add server/tests/auto-listing-category-strategy-service.test.mjs server/auto-listing-category-strategy-service.mjs
git commit -m "fix: open category sampling page from draft scope"
```

提交前检查差异仅包含测试夹具和服务器 URL 生成，不包含扩展、数据库或无关模块。
