# Category Buyer List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让类目策略打开锚定商品真实的 Ozon 买家端末级类目列表，并兼容尚未保存该链接的历史采集记录。

**Architecture:** 在商品采集信任边界提取并保存真实买家类目 URL；类目策略服务只传递已保存 URL 或锚定商品 URL；历史商品由扩展商品页解析同一面包屑后跳转。所有跳转继续经过严格 URL 投影，不新增数据库结构或外部写操作。

**Tech Stack:** Node.js ESM/CommonJS tests, React/Vite app bridge, Chrome MV3 extension, PostgreSQL JSONB read model

## Global Constraints

- 不修改数据库结构，不调用真实外部写接口。
- 保留后端权限、多租户隔离、会话密钥和人工审核后再上传。
- 不用 Seller `descriptionCategoryId` 推导买家网页类目编号。
- 只做本故障链路的最小修改，不新增依赖或复杂架构。

---

### Task 1: 买家类目 URL 边界与采集

**Files:**
- Create: `extension/lib/ozon-buyer-category.js`
- Modify: `extension/manifest.json`
- Modify: `extension/content/ozon-product.js`
- Test: `extension/tests/ozon-buyer-category.test.js`
- Test: `extension/tests/ozon-product-complete-collection.test.js`

**Interfaces:**
- Produces: `JzOzonBuyerCategory.projectCategoryUrl(raw)` 和 `JzOzonBuyerCategory.findLeafCategoryUrl(document)`。
- Produces: 采集 payload 可选字段 `buyerCategoryUrl: string`。

- [ ] **Step 1: Write the failing tests**

测试真实 slug+编号类目被接受、品牌二级路径被忽略、最后一个单层类目链接被选择，并断言单/多变体采集上传 `buyerCategoryUrl`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test extension/tests/ozon-buyer-category.test.js extension/tests/ozon-product-complete-collection.test.js`
Expected: FAIL because helper/payload field is absent.

- [ ] **Step 3: Write minimal implementation**

实现纯函数 URL 投影，将 helper 在商品脚本前注入；单采和多变体采集共用 `findLeafCategoryUrl(document)` 写入 payload。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/tests/ozon-buyer-category.test.js extension/tests/ozon-product-complete-collection.test.js extension/tests/manifest-security-contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: capture Ozon buyer category URL`

### Task 2: 服务端使用真实 URL

**Files:**
- Modify: `server/auto-listing-category-strategy-runtime.mjs`
- Modify: `server/auto-listing-category-strategy-service.mjs`
- Test: `server/tests/auto-listing-category-strategy-service.test.mjs`
- Test: `server/tests/auto-listing-category-strategy-e2e.test.mjs`

**Interfaces:**
- Consumes: 草稿 `data.buyerCategoryUrl`，缺失时使用 `collect_items.source_url`。
- Produces: 带唯一选样会话参数的真实类目 URL 或锚定商品 URL。

- [ ] **Step 1: Write the failing tests**

断言已保存类目 URL原样进入 session，历史商品 URL作为回退，且 Seller 类目编号不再出现在路径中。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-category-strategy-e2e.test.mjs`
Expected: FAIL with current `/category/<descriptionCategoryId>/` behavior.

- [ ] **Step 3: Write minimal implementation**

读取模型用 `COALESCE(NULLIF(current_draft.data->>'buyerCategoryUrl',''), item.source_url)`；服务以严格投影后的 draft URL构造 session URL。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-category-strategy-e2e.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: use buyer category URL for strategy sampling`

### Task 3: Web/扩展交接与历史记录跳转

**Files:**
- Modify: `app/src/category-strategy-extension-bridge.js`
- Modify: `extension/lib/category-strategy-handoff.js`
- Modify: `extension/content/ozon-product.js`
- Test: `app/tests/category-strategy-extension-bridge.test.mjs`
- Test: `extension/tests/category-strategy-handoff.test.js`
- Test: `extension/tests/ozon-buyer-category.test.js`

**Interfaces:**
- Consumes: 服务端 category/product session URL。
- Produces: 扩展打开严格允许的 URL；商品 fallback 页面将 session 转移到真实末级类目 URL。

- [ ] **Step 1: Write the failing tests**

断言 Web/扩展接受真实类目 slug 与精确商品 URL，继续拒绝额外参数、非 www 域名和品牌二级路径；断言商品 fallback 生成正确 session 类目 URL。

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test app/tests/category-strategy-extension-bridge.test.mjs extension/tests/category-strategy-handoff.test.js extension/tests/ozon-buyer-category.test.js`
Expected: FAIL because current policy accepts only numeric category paths.

- [ ] **Step 3: Write minimal implementation**

更新两端 URL 投影；商品页加载时若有 session，用 helper 找末级类目 URL并 `location.replace`，解析失败不猜测。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test app/tests/category-strategy-extension-bridge.test.mjs extension/tests/category-strategy-handoff.test.js extension/tests/ozon-buyer-category.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: resolve legacy category sampling through product page`

### Task 4: 打包与端到端验证

**Files:**
- Modify: generated packaged extension under `app/public/sonli-extension-*` through the existing package script.

**Interfaces:**
- Consumes: all previous production files.
- Produces: downloadable extension containing identical repaired behavior.

- [ ] **Step 1: Run related regression tests**

Run the Task 1-3 test commands together.

- [ ] **Step 2: Package the extension**

Run: `npm run package-extension`

- [ ] **Step 3: Run full verification**

Run: `npm run verify`
Expected: all checks pass, with only explicitly skipped tests.

- [ ] **Step 4: Run representative end-to-end flow**

启动修复分支服务，使用当前账号和商品 `1941181573` 启动类目策略；确认最终路径为 `/category/nabory-skladnoy-mebeli-11504/`，能显示选样控件，并仍停在人工审核前。

- [ ] **Step 5: Commit**

Commit generated extension artifacts only when the packaging script changes them.

