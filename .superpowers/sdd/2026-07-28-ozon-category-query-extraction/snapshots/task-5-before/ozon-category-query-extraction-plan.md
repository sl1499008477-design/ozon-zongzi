# Ozon Category Query Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把类目树、类目属性和字典值查询拆成独立边界，删除本地商品类目兜底，并在无法取得真实 Ozon 类目数据时阻止 AI 选类目、预检和上架。

**Architecture:** `ozon-category-service.mjs` 是唯一的类目数据、校验、分页和 6 小时内存缓存边界；`ozon-category-routes.mjs` 只负责认证、店铺选择和 HTTP contract。商品预检及最终上架校验直接消费 service，页面和插件只处理显式成功或显式失败，不再把失败当成空数据。

**Tech Stack:** Node.js ESM、原生 `fetch`（仅经 `ozon-client.mjs`）、`node:test` 风格断言脚本、React/Ant Design、Chrome 扩展脚本、现有 `scripts/verify.mjs` 门禁。

## Global Constraints

- 目标路径固定为 `/Users/songliang/Documents/sonli ozon3.0`；用户已明确允许继续在当前脏 `main` 工作区原地改造。
- 遵守 `/Users/songliang/.codex/AGENTS.md`：高内聚、低耦合、后端权限、账号/店铺隔离、稳定 contract、失败闭环、可测试和可回滚。
- 类目数据只能来自 Ozon 成功响应或最长 6 小时的未过期 Ozon 真数据内存缓存。
- 禁止从 `state.caches.products`、其他店铺、历史任务或采集数据推断类目树或 `description_category_id`。
- Ozon 获取失败时不得返回伪装成功的空列表，不得使用过期缓存。
- 类目数据未就绪时必须停止 AI 自动选类目、商品预检、上架快照和上架任务创建。
- 后端是最终门禁；前端按钮状态不能替代服务端校验。
- 不修改数据库、迁移、依赖、锁文件、环境变量、Docker 或部署配置。
- 不使用真实 Ozon 凭据，不调用真实店铺，不执行真实商品、库存、价格或上架写入。
- 沿用当前 `/v1/description-category/*` contract；本轮不猜测或升级 Ozon API 版本。
- 保留三个现有 HTTP 路径以及成功响应的 `data`、`items`、`total` 字段；只增加 `meta`。
- 不执行 `git add`、`git commit`、`git stash`、`git rebase`、`git push` 或破坏性 Git 命令。
- 每个任务使用前后文件快照和 scoped diff 复审，不依赖 commit。
- 设计依据：
  `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md`。

## File And Contract Map

### New focused modules

- `server/ozon-category-service.mjs`
  - 唯一职责：真实 Ozon 类目查询、响应校验、缓存、type 到 description category 解析、字典分页。
  - 不读取业务 state，不发送 HTTP 响应，不创建上架任务。
- `server/ozon-category-routes.mjs`
  - 唯一职责：匹配三个 HTTP 路径、后端认证、店铺归属校验、参数解析和响应映射。
  - 不实现缓存、分页或本地商品推断。
- `server/tests/ozon-category-service.test.mjs`
  - service contract、TTL、隔离、分页、原子性和脱敏。
- `server/tests/ozon-category-routes.test.mjs`
  - 路径、认证、店铺隔离、成功响应和明确失败 contract。
- `app/src/category-readiness.js`
  - 商品编辑页可执行的真实类目加载、就绪判断和动作门禁。
- `app/tests/category-readiness.test.mjs`
  - 直接执行页面使用的 readiness 行为。
- `extension/lib/category-readiness.js`
  - 1688 向导可执行的失败状态转换和动作门禁。
- `extension/tests/category-readiness.test.js`
  - 直接执行扩展向导使用的 readiness 行为。

### Modified files

- `server/index.mjs`
  - 创建 service/route handler。
  - 商品预检和上架校验改用 service。
  - 删除内联缓存、查询、本地商品推断和三个内联路由。
- `server/tests/module-boundaries.test.mjs`
  - 防止类目职责回流，并下调入口行数上限。
- `server/tests/cache-route-isolation.test.mjs`
  - 删除“本地商品类目兜底成功”的旧断言，改为确认 Ozon 失败不会暴露本地商品类目。
- `app/src/App.jsx`
  - 商品编辑页保存真实类目就绪/错误状态，显示重试错误并阻止相关操作。
- `extension/content/1688-ai-wizard.js`
  - 调用 readiness helper，确保失败不自动匹配、不生成空属性表单。
- `extension/manifest.json`
  - 在 1688 AI 向导前加载 readiness helper。
- `scripts/check-extension-source-parity.mjs`
  - 把新增 helper 登记为有意的本地扩展文件。
- `scripts/check-extension-diff-contract.mjs`
  - 更新 manifest 的精确差异 contract。
- `docs/architecture/module-boundaries.md`
  - 记录类目服务和路由边界。
- 本计划文件
  - 只更新 checkbox 和最终实际验证结果。

### Stable service contract

```js
const categoryService = createOzonCategoryService({
  callOzonSellerApi,
  now: () => Date.now(),
  cacheTtlMs: 6 * 60 * 60 * 1000,
});

await categoryService.getCategoryTree({
  accountId,
  store,
  language: "DEFAULT",
});

await categoryService.getCategoryAttributes({
  accountId,
  store,
  descriptionCategoryId,
  typeId,
  language: "DEFAULT",
});

await categoryService.getCategoryAttributeValues({
  accountId,
  store,
  descriptionCategoryId,
  typeId,
  attributeId,
  language: "DEFAULT",
  limit: 5000,
});

await categoryService.resolveDescriptionCategoryId({
  accountId,
  store,
  typeId,
  language: "DEFAULT",
});
```

每个成功查询返回：

```js
{
  items: [],
  meta: {
    source: "OZON_API", // cache hit 时为 OZON_CACHE
    fetchedAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-07-28T06:00:00.000Z",
  },
}
```

稳定错误使用普通 `Error`：

```js
{
  status: 502,
  code: "OZON_CATEGORY_TREE_UNAVAILABLE",
  message: "未能从 Ozon 获取真实类目数据，请重试",
  body: { operation: "TREE" },
  cause: null,
}
```

---

### Task 1: Record The Pre-Change Baseline And Recovery Boundary

**Files:**
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/baseline.md`
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/dirty-files-before.txt`
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/before/`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: current dirty `main`, commit `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`, last verified 97/97 baseline.
- Produces: exact recovery record and pre-change copies for every file this plan may modify.

- [x] **Step 1: Confirm branch, commit and dirty scope without changing Git**

Run:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

Expected:

- branch is `main`;
- commit is recorded, not assumed;
- existing unrelated changes are preserved;
- whitespace check exits 0.

- [x] **Step 2: Record the current category implementation locations**

Run:

```bash
rg -n "DESCRIPTION_CATEGORY_CACHE|getOzonDescriptionCategory|findDescriptionCategoryIdByTypeId|/ozon/categories/tree|categoryAttributesMatch|categoryAttributeValuesMatch" server/index.mjs
rg -n "getCategoryTree|getCategoryAttributes|getCategoryAttributeValues" server/ozon-import-normalizer.mjs app/src/App.jsx extension
wc -l server/index.mjs
```

Expected:

- all inline category functions and routes are inventoried;
- direct consumers are listed;
- current entry line count is recorded before lowering the guard.

- [x] **Step 3: Create ignored safety snapshots**

Create copies under:

```text
.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/before/
```

Copy exactly:

```text
server/index.mjs
server/tests/module-boundaries.test.mjs
server/tests/cache-route-isolation.test.mjs
app/src/App.jsx
extension/content/1688-ai-wizard.js
extension/manifest.json
scripts/check-extension-source-parity.mjs
scripts/check-extension-diff-contract.mjs
docs/architecture/module-boundaries.md
```

Also save `git status --short` as `dirty-files-before.txt`.

Expected: snapshots exist outside tracked deliverables and contain the exact pre-change bytes.

- [x] **Step 4: Run the narrow pre-change baseline**

Run:

```bash
node server/tests/ozon-client.test.mjs
node server/tests/cache-route-isolation.test.mjs
node server/tests/import-preview-route.test.mjs
node server/tests/collect-listing-submit-failure.test.mjs
node server/tests/external-write-safety.test.mjs
node server/tests/module-boundaries.test.mjs
node app/tests/prototype-style-contract.test.mjs
```

Expected: all pass. Record exact outputs and any pre-existing failure in `baseline.md`.

- [x] **Step 5: Record the full-gate baseline**

If the local `sonli-postgres` test container is stopped, start only that local container:

```bash
docker start sonli-postgres
node scripts/verify.mjs
docker stop sonli-postgres
```

Expected:

- 97 tests pass, 0 fail, and all 19 verification checks pass;
- PostgreSQL is restored to its original stopped state;
- no Ozon request is made.

If the exact counts differ before implementation, record the new baseline rather than claiming a regression.

- [x] **Step 6: Review checkpoint**

Compare the planned file boundary with `git status --short`.

Expected: no product code has changed during Task 1.

---

### Task 2: Build The Real-Ozon Category Service And Scoped TTL Cache

**Files:**
- Create: `server/ozon-category-service.mjs`
- Create: `server/tests/ozon-category-service.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: `callOzonSellerApi(store, apiPath, body, timeoutMs)` from `server/ozon-client.mjs`.
- Produces:
  - `createOzonCategoryService(options)`;
  - `getCategoryTree(input)`;
  - `getCategoryAttributes(input)`;
  - `resolveDescriptionCategoryId(input)`;
  - stable result `{ items, meta }`;
  - stable safe errors with `status`, `code`, `body`, `cause: null`.

- [x] **Step 1: Write failing service tests for tree, attributes and cache provenance**

Create a test fixture with deterministic time:

```js
let nowMs = Date.parse("2026-07-28T00:00:00.000Z");
const calls = [];
const callOzonSellerApi = async (store, apiPath, body) => {
  calls.push({ storeId: store.id, apiPath, body });
  if (apiPath.endsWith("/tree")) {
    return {
      result: [{
        description_category_id: 10,
        category_name: "Home",
        children: [{ type_id: 20, type_name: "Cup", children: [] }],
      }],
    };
  }
  return { result: [{ id: 30, name: "Brand", dictionary_id: 40, is_required: true }] };
};
```

Assert:

```js
const service = createOzonCategoryService({
  callOzonSellerApi,
  now: () => nowMs,
  cacheTtlMs: 6 * 60 * 60 * 1000,
});

const first = await service.getCategoryTree({
  accountId: "acct-a",
  store: { id: "store-a", ownerAccountId: "acct-a" },
  language: "ZH_HANS",
});
assert.equal(first.meta.source, "OZON_API");
assert.equal(first.items[0].description_category_id, 10);

const second = await service.getCategoryTree({
  accountId: "acct-a",
  store: { id: "store-a", ownerAccountId: "acct-a" },
  language: "ZH_HANS",
});
assert.equal(second.meta.source, "OZON_CACHE");
assert.equal(calls.length, 1);
```

Add separate assertions for:

- attributes result and cache hit;
- same store with different language does not share cache;
- different account or store does not share cache;
- cache keys do not contain API keys;
- `resolveDescriptionCategoryId` inherits parent category ID and resolves type `20` to `10`.

- [x] **Step 2: Run the service test and verify RED**

Run:

```bash
node server/tests/ozon-category-service.test.mjs
```

Expected: FAIL because `server/ozon-category-service.mjs` does not exist.

- [x] **Step 3: Implement the minimal service skeleton and scoped cache**

Implement:

```js
import { callOzonSellerApi as defaultCallOzonSellerApi } from "./ozon-client.mjs";

export const DEFAULT_CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function createOzonCategoryService({
  callOzonSellerApi = defaultCallOzonSellerApi,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CATEGORY_CACHE_TTL_MS,
} = {}) {
  const cache = new Map();

  function scopeOf({ accountId, store }) {
    const ownerAccountId = String(store?.ownerAccountId || store?.accountId || "");
    if (!accountId || !store?.id || ownerAccountId !== String(accountId)) {
      throw categoryError("SCOPE", 403, "OZON_CATEGORY_STORE_FORBIDDEN");
    }
    return `${accountId}:${store.id}`;
  }

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry || now() >= entry.expiresAtMs) {
      cache.delete(key);
      return null;
    }
    return {
      items: structuredClone(entry.items),
      meta: { ...entry.meta, source: "OZON_CACHE" },
    };
  }

  function writeCache(key, items) {
    const fetchedAtMs = now();
    const entry = {
      items: structuredClone(items),
      expiresAtMs: fetchedAtMs + cacheTtlMs,
      meta: {
        source: "OZON_API",
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        expiresAt: new Date(fetchedAtMs + cacheTtlMs).toISOString(),
      },
    };
    cache.set(key, entry);
    return { items: structuredClone(entry.items), meta: { ...entry.meta } };
  }

  return {
    getCategoryTree,
    getCategoryAttributes,
    getCategoryAttributeValues,
    resolveDescriptionCategoryId,
  };
}
```

Implement fixed-message `categoryError` so it never copies Ozon raw body, credentials or `cause`.

- [x] **Step 4: Implement tree and attribute validation**

Tree:

```js
const data = await callOzonSellerApi(
  store,
  "/v1/description-category/tree",
  { language: normalizedLanguage },
  120000,
);
if (!Array.isArray(data?.result) || data.result.length === 0) {
  throw categoryError("TREE", 502, "OZON_CATEGORY_DATA_INVALID");
}
```

Attributes:

```js
const data = await callOzonSellerApi(
  store,
  "/v1/description-category/attribute",
  {
    description_category_id: normalizedDescriptionCategoryId,
    type_id: normalizedTypeId,
    language: normalizedLanguage,
  },
  60000,
);
if (!Array.isArray(data?.result)) {
  throw categoryError("ATTRIBUTES", 502, "OZON_CATEGORY_DATA_INVALID");
}
```

An authentic Ozon `result: []` is allowed for attributes; only transport failure or invalid shape is an error.

- [x] **Step 5: Map Ozon failures without leaking source details**

Map:

```js
function unavailableError(operation, source) {
  const status = source?.code === "OZON_TIMEOUT"
    ? 504
    : source?.status === 429
      ? 503
      : 502;
  const code = {
    TREE: "OZON_CATEGORY_TREE_UNAVAILABLE",
    ATTRIBUTES: "OZON_CATEGORY_ATTRIBUTES_UNAVAILABLE",
    VALUES: "OZON_CATEGORY_VALUES_UNAVAILABLE",
  }[operation];
  return categoryError(operation, status, code);
}
```

The public message is fixed:

```text
未能从 Ozon 获取真实类目数据，请重试
```

Set `cause = null`; body contains only `{ operation }`.

- [x] **Step 6: Run tests and verify GREEN**

Run:

```bash
node --check server/ozon-category-service.mjs
node server/tests/ozon-category-service.test.mjs
node server/tests/ozon-client.test.mjs
```

Expected: all pass.

- [x] **Step 7: Review checkpoint**

Inspect:

```bash
rg -n "apiKey|Api-Key|Client-Id|state\\.caches\\.products|cacheItemsForStore" server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs
git diff --check -- server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs
```

Expected:

- no business-state or local-product dependency;
- credential strings appear only in safe fixtures/assertions, never error output;
- no whitespace errors.

---

### Task 3: Add Atomic Dictionary Pagination And Expiry Failure Tests

**Files:**
- Modify: `server/ozon-category-service.mjs`
- Modify: `server/tests/ozon-category-service.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: Task 2 `createOzonCategoryService` and scoped cache.
- Produces: complete `getCategoryAttributeValues(input)` with page normalization, deduplication, bounded limit, cursor protection and atomic cache write.

- [x] **Step 1: Write failing multi-page and response-shape tests**

Add a mock sequence:

```js
[
  {
    result: {
      values: [{ id: 1, value: "One" }, { dictionary_value_id: 2, name: "Two" }],
      has_next: true,
    },
  },
  {
    result: [{ id: 3, value: "Three" }],
    has_next: false,
  },
]
```

Assert:

```js
assert.deepEqual(result.items.map((item) => item.id), [1, 2, 3]);
assert.equal(secondCall.body.last_value_id, 2);
assert.equal(result.meta.source, "OZON_API");
```

Also assert:

- duplicate `{id,value}` entries appear once;
- `limit` is clamped to `1..5000`;
- each Ozon page limit is at most 1000;
- `result` array and `result.values` array are both accepted.

- [x] **Step 2: Write failing atomicity and repeated-cursor tests**

Cases:

1. Page 1 succeeds, page 2 throws: the next call must call Ozon again from page 1.
2. `has_next: true` repeats the same non-zero `last_value_id`: reject with
   `OZON_CATEGORY_DATA_INVALID`.
3. TTL expires, refresh fails: old items are not returned.
4. Invalid response shape: no cache entry is created.

Use:

```js
await assert.rejects(
  () => service.getCategoryAttributeValues(input),
  (error) => {
    assert.equal(error.code, "OZON_CATEGORY_DATA_INVALID");
    assert.equal(error.cause, null);
    return true;
  },
);
```

- [x] **Step 3: Run the service test and verify RED**

Run:

```bash
node server/tests/ozon-category-service.test.mjs
```

Expected: FAIL on the new pagination or atomicity assertions.

- [x] **Step 4: Implement local-page accumulation and terminal checks**

Use local variables only until all pages succeed:

```js
const values = [];
const seenValues = new Set();
const seenCursors = new Set();
let lastValueId = 0;

while (values.length < safeLimit) {
  const pageLimit = Math.min(1000, safeLimit - values.length);
  const data = await callOzonSellerApi(
    store,
    "/v1/description-category/attribute/values",
    {
      description_category_id: normalizedDescriptionCategoryId,
      type_id: normalizedTypeId,
      attribute_id: normalizedAttributeId,
      language: normalizedLanguage,
      limit: pageLimit,
      ...(lastValueId ? { last_value_id: lastValueId } : {}),
    },
    60000,
  );
  const page = Array.isArray(data?.result)
    ? data.result
    : Array.isArray(data?.result?.values)
      ? data.result.values
      : null;
  if (!page) throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
  if (page.length === 0) break;

  // Normalize and deduplicate into the local `values` array.

  const nextCursor = positiveIdOf(page.at(-1));
  const hasNext = Boolean(data?.has_next || data?.result?.has_next);
  if (!hasNext) break;
  if (!nextCursor || seenCursors.has(nextCursor)) {
    throw categoryError("VALUES", 502, "OZON_CATEGORY_DATA_INVALID");
  }
  seenCursors.add(nextCursor);
  lastValueId = nextCursor;
}

return writeCache(key, values);
```

Never call `writeCache` inside the loop.

- [x] **Step 5: Run service and client regression**

Run:

```bash
node --check server/ozon-category-service.mjs
node server/tests/ozon-category-service.test.mjs
node server/tests/ozon-client.test.mjs
```

Expected: all pass.

- [x] **Step 6: Review checkpoint**

Inspect the scoped diff for:

- no unbounded loop;
- repeated cursor fails immediately;
- no half-page cache write;
- no stale-on-error branch;
- no raw upstream error copied to public output.

---

### Task 4: Extract Authenticated Category HTTP Routes

**Files:**
- Create: `server/ozon-category-routes.mjs`
- Create: `server/tests/ozon-category-routes.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes:
  - Task 2/3 category service methods;
  - injected `requireAuth`, `storeIdForAccountRequest`, `activeStore`, `sendJson`, `sendError`.
- Produces:
  - `createOzonCategoryRouteHandler(dependencies)`;
  - async handler `({ req, res, url, state }) => boolean`.

- [x] **Step 1: Write failing route tests with pure stubs**

Build a handler with:

```js
const meta = {
  source: "OZON_API",
  fetchedAt: "2026-07-28T00:00:00.000Z",
  expiresAt: "2026-07-28T06:00:00.000Z",
};
const categoryService = {
  getCategoryTree: async (input) => ({
    items: [{ description_category_id: 10 }],
    meta,
  }),
  getCategoryAttributes: async () => ({ items: [{ id: 30 }], meta }),
  getCategoryAttributeValues: async () => ({ items: [{ id: 40, value: "No brand" }], meta }),
  resolveDescriptionCategoryId: async () => 10,
};
```

Assert:

- unrelated path returns `false` and sends nothing;
- each supported path returns `true`;
- tree keeps `data`, `items`, `total`, `language` and adds `meta`;
- attributes keeps `typeId`, `categoryId`;
- values keeps `typeId`, `categoryId`, `attributeId`;
- `account.id`, selected `store.id`, language and IDs reach the service.

- [x] **Step 2: Add failing auth and ownership tests**

Assert:

- missing session throws/rejects using existing `requireAuth`;
- requested store from another account is rejected before service invocation;
- missing active store returns a stable existing store error;
- no request body or query value can override `account.id`.

- [x] **Step 3: Add failing service-error mapping tests**

For:

```js
Object.assign(new Error("fixed"), {
  status: 502,
  code: "OZON_CATEGORY_TREE_UNAVAILABLE",
  body: { operation: "TREE" },
  cause: null,
})
```

Assert `sendError` receives:

```js
[
  502,
  "未能从 Ozon 获取真实类目数据，请重试",
  "OZON_CATEGORY_TREE_UNAVAILABLE",
]
```

No route may transform this into HTTP 200 or `items: []`.

- [x] **Step 4: Run route tests and verify RED**

Run:

```bash
node server/tests/ozon-category-routes.test.mjs
```

Expected: FAIL because `server/ozon-category-routes.mjs` does not exist.

- [x] **Step 5: Implement exact route matching and response mapping**

Implement:

```js
function requestContext(dependencies, req, state, url) {
  const account = dependencies.requireAuth(req, state);
  const storeId = dependencies.storeIdForAccountRequest(
    state,
    account,
    url.searchParams.get("storeId") || req.headers["x-ozon-store-id"] || "",
  );
  const store = dependencies.activeStore(state, storeId, account.id);
  if (!store) {
    const error = new Error("店铺不存在或不属于当前账号");
    error.status = 404;
    error.code = "STORE_NOT_FOUND";
    throw error;
  }
  return { account, store };
}

async function respondCategory(dependencies, res, operation) {
  try {
    await operation();
  } catch (error) {
    if (String(error?.code || "").startsWith("OZON_CATEGORY_")) {
      dependencies.sendError(
        res,
        Number(error.status || 502),
        error.message,
        error.code,
      );
      return;
    }
    throw error;
  }
}

export function createOzonCategoryRouteHandler(dependencies) {
  return async function handleOzonCategoryRoute({ req, res, url, state }) {
    if (req.method === "GET" && url.pathname === "/ozon/categories/tree") {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = requestContext(dependencies, req, state, url);
        const language = url.searchParams.get("language") || "DEFAULT";
        const result = await dependencies.categoryService.getCategoryTree({
          accountId: account.id,
          store,
          language,
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          language,
          meta: result.meta,
        });
      });
      return true;
    }

    const attributesMatch = url.pathname.match(
      /^\/ozon\/description-category\/([^/]+)\/attributes$/,
    );
    if (req.method === "GET" && attributesMatch) {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = requestContext(dependencies, req, state, url);
        const typeId = decodeURIComponent(attributesMatch[1]);
        const requestedCategoryId =
          url.searchParams.get("descriptionCategoryId")
          || url.searchParams.get("description_category_id")
          || "";
        const descriptionCategoryId = requestedCategoryId || (
          await dependencies.categoryService.resolveDescriptionCategoryId({
            accountId: account.id,
            store,
            typeId,
            language: "DEFAULT",
          })
        );
        const result = await dependencies.categoryService.getCategoryAttributes({
          accountId: account.id,
          store,
          descriptionCategoryId,
          typeId,
          language: "DEFAULT",
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          typeId,
          categoryId: descriptionCategoryId,
          meta: result.meta,
        });
      });
      return true;
    }

    const valuesMatch = url.pathname.match(
      /^\/ozon\/description-category\/([^/]+)\/attributes\/([^/]+)\/values$/,
    );
    if (req.method === "GET" && valuesMatch) {
      await respondCategory(dependencies, res, async () => {
        const { account, store } = requestContext(dependencies, req, state, url);
        const typeId = decodeURIComponent(valuesMatch[1]);
        const attributeId = decodeURIComponent(valuesMatch[2]);
        const requestedCategoryId =
          url.searchParams.get("descriptionCategoryId")
          || url.searchParams.get("description_category_id")
          || "";
        const descriptionCategoryId = requestedCategoryId || (
          await dependencies.categoryService.resolveDescriptionCategoryId({
            accountId: account.id,
            store,
            typeId,
            language: "DEFAULT",
          })
        );
        const result = await dependencies.categoryService.getCategoryAttributeValues({
          accountId: account.id,
          store,
          descriptionCategoryId,
          typeId,
          attributeId,
          language: "DEFAULT",
          limit: url.searchParams.get("limit") || 1000,
        });
        dependencies.sendJson(res, 200, {
          data: result.items,
          items: result.items,
          total: result.items.length,
          typeId,
          categoryId: descriptionCategoryId,
          attributeId,
          meta: result.meta,
        });
      });
      return true;
    }

    return false;
  };
}
```

Catch only category service errors that the handler can map. Let unrelated programmer errors reach the existing top-level error handling.

- [x] **Step 6: Run route and service tests**

Run:

```bash
node --check server/ozon-category-routes.mjs
node server/tests/ozon-category-routes.test.mjs
node server/tests/ozon-category-service.test.mjs
```

Expected: all pass.

- [x] **Step 7: Review checkpoint**

Verify:

- no import of `server/index.mjs`;
- no access to `state.caches.products`;
- ownership checked before every service call;
- route success contract remains additive;
- errors remain non-2xx and safe.

---

### Task 5: Integrate The Service With Preview And Listing Fail-Closed Paths

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/import-preview-route.test.mjs`
- Modify: `server/tests/collect-listing-submit-failure.test.mjs`
- Modify: `server/tests/external-write-safety.test.mjs`
- Create: `server/tests/category-listing-readiness.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: category service methods from Tasks 2/3.
- Produces:
  - preview and queue normalizer callbacks backed only by category service;
  - no permissive unresolved-required-dictionary path;
  - failure before snapshot/job/external write.

- [ ] **Step 1: Write failing preview and listing readiness tests**

Use a local temporary state and mock `globalThis.fetch`.

For preview:

```js
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/v1/description-category/attribute")) {
    return new Response(JSON.stringify({ code: "UPSTREAM_FAILED" }), { status: 503 });
  }
  throw new Error(`unexpected URL ${url}`);
};
```

Assert:

```js
assert.notEqual(response.status, 200);
assert.equal(response.body.ok, false);
assert.match(response.body.code, /^OZON_CATEGORY_/);
```

For final submission, assert:

```js
assert.equal(snapshotCountAfter, snapshotCountBefore);
assert.equal(jobCountAfter, jobCountBefore);
assert.equal(externalWriteCalls, 0);
```

Add a `COLLECT_EDIT_AUTO_CATEGORY` case with an unresolved required dictionary value; it must fail instead of returning a successful preview with only warnings.

- [ ] **Step 2: Run the new readiness test and verify RED**

Run:

```bash
node server/tests/category-listing-readiness.test.mjs
```

Expected: FAIL because the entry still uses inline category functions and the auto-category preview still permits unresolved required dictionary values.

- [ ] **Step 3: Instantiate one shared category service**

Near the existing sync service:

```js
const ozonCategoryService = createOzonCategoryService();
```

Do not instantiate per request; otherwise the 6-hour cache cannot be reused.

- [ ] **Step 4: Replace preview normalizer callbacks**

Use:

```js
getCategoryTree: async () => (
  await ozonCategoryService.getCategoryTree({
    accountId: store.ownerAccountId,
    store,
    language: "DEFAULT",
  })
).items,
```

Apply the same pattern for attributes and values.

Remove:

```js
allowUnresolvedRequiredDictionaryValues:
  body.entry === "COLLECT_EDIT_AUTO_CATEGORY"
```

The normalizer itself remains a consumer and should not import the service.

- [ ] **Step 5: Replace final listing callbacks**

Wire the same service methods into `queueCollectSubmissionV3`.

Confirm the category service runs before:

- listing snapshot creation;
- job enqueue;
- audit success record;
- any external write.

- [ ] **Step 6: Run direct consumer regression**

Run:

```bash
node server/tests/category-listing-readiness.test.mjs
node server/tests/import-preview-route.test.mjs
node server/tests/import-currency-contract.test.mjs
node server/tests/collect-listing-submit-failure.test.mjs
node server/tests/external-write-safety.test.mjs
node server/tests/ozon-import-normalizer.test.mjs
```

Expected: all pass and external write count remains zero.

- [ ] **Step 7: Review checkpoint**

Inspect the diff between the Task 1 snapshot and current `server/index.mjs`.

Expected:

- only category wiring and the intentional strict preview flag changed in these functions;
- no listing task state machine or database path changed;
- no real Ozon call occurred during tests.

---

### Task 6: Replace Inline Category Routes And Delete Local Product Fallback

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/cache-route-isolation.test.mjs`
- Modify: `server/tests/ozon-category-routes.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: Task 4 route handler, Task 5 shared service instance.
- Produces: entry-level delegation and proof that local product caches are never category data sources.

- [ ] **Step 1: Add a failing real-entry route test**

In a temporary state, create:

```js
caches: {
  products: [{
    id: "local-product",
    accountId: "acct-a",
    storeId: "store-a",
    description_category_id: "local-category",
    type_id: "local-type",
    category: "Local inferred category",
  }],
}
```

Mock Ozon tree failure and call:

```text
GET /ozon/categories/tree
```

Assert:

```js
assert.notEqual(response.status, 200);
assert.equal(response.body.code, "OZON_CATEGORY_TREE_UNAVAILABLE");
assert.equal(JSON.stringify(response.body).includes("local-category"), false);
```

Add attributes and values cases without explicit `descriptionCategoryId`; Ozon tree failure must not fall back to `local-product`.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node server/tests/ozon-category-routes.test.mjs
node server/tests/cache-route-isolation.test.mjs
```

Expected: the old tree fallback test or new strict assertion fails before entry replacement.

- [ ] **Step 3: Create and wire one route handler**

After `sendJson` and `sendError` are available, create:

```js
const handleOzonCategoryRoute = createOzonCategoryRouteHandler({
  categoryService: ozonCategoryService,
  requireAuth,
  storeIdForAccountRequest,
  activeStore,
  sendJson,
  sendError,
});
```

At the exact location of the removed inline
`GET /ozon/categories/tree` block, before the following `/ozon/collect-box`
route:

```js
if (await handleOzonCategoryRoute({ req, res, url, state })) return;
```

- [ ] **Step 4: Delete the complete inline category boundary**

Remove from `server/index.mjs`:

```text
DESCRIPTION_CATEGORY_CACHE_TTL_MS
descriptionCategoryTreeCache
descriptionCategoryAttributesCache
descriptionCategoryAttributeValuesCache
cacheKeyForStore
getOzonDescriptionCategoryTree
findDescriptionCategoryIdByTypeId
getOzonDescriptionCategoryAttributes
getOzonDescriptionCategoryAttributeValues
the three inline GET route blocks
the state.caches.products category fallback
the product type_id -> description_category_id fallback
```

Do not delete unrelated collection, AI, import or listing code.

- [ ] **Step 5: Update the old isolation test to the new rule**

Replace the old assertion:

```text
category fallback data must only use products from the selected store
```

with:

```text
category queries must never expose or use local product categories when Ozon is unavailable
```

The test must assert a non-2xx category error and absence of both account A and account B local category IDs.

- [ ] **Step 6: Run route, isolation and syntax regression**

Run:

```bash
node --check server/index.mjs
node server/tests/ozon-category-routes.test.mjs
node server/tests/cache-route-isolation.test.mjs
node server/tests/account-store-isolation.test.mjs
node scripts/check-store-data-isolation.mjs
```

Expected: all pass.

- [ ] **Step 7: Review checkpoint**

Run:

```bash
rg -n "DESCRIPTION_CATEGORY_CACHE|getOzonDescriptionCategory|findDescriptionCategoryIdByTypeId|inferred: true" server/index.mjs
rg -n "state\\.caches\\.products|cacheItemsForStore" server/ozon-category-service.mjs server/ozon-category-routes.mjs
```

Expected: both commands return no category-boundary matches.

---

### Task 7: Make The Product Editor Explicitly Fail Closed

**Files:**
- Create: `app/src/category-readiness.js`
- Modify: `app/src/App.jsx`
- Create: `app/tests/category-readiness.test.mjs`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: unchanged three HTTP paths and new non-2xx category errors.
- Produces:
  - `loadRealCategoryTrees({ readTree })`;
  - `categoryReadiness(input)`;
  - `requireCategoryReadiness(input)`;
  - explicit `categoryDataError`;
  - explicit readiness state;
  - retry action;
  - blocked AI/preview/publish actions while category data is unavailable.

- [ ] **Step 1: Write failing behavior tests against the real readiness module**

Import the not-yet-created module and test literal behavior:

```js
const validTree = [{
  description_category_id: 10,
  children: [{ type_id: 20, children: [] }],
}];

const loaded = await loadRealCategoryTrees({
  readTree: async (language) => ({
    items: structuredClone(validTree),
    meta: { source: "OZON_API", language },
  }),
});
assert.equal(loaded.zhTree[0].description_category_id, 10);
assert.equal(loaded.ruTree[0].children[0].type_id, 20);

await assert.rejects(
  () => loadRealCategoryTrees({
    readTree: async (language) => {
      if (language === "RU") throw new Error("offline");
      return { items: structuredClone(validTree) };
    },
  }),
  (error) => error.code === "OZON_CATEGORY_UI_UNAVAILABLE",
);
```

Test the action gate:

```js
assert.deepEqual(categoryReadiness({
  descriptionCategoryId: 10,
  typeId: 20,
  loading: false,
  error: "",
  treeCount: 1,
}), { ready: true, message: "" });

assert.throws(
  () => requireCategoryReadiness({
    descriptionCategoryId: 10,
    typeId: 20,
    loading: false,
    error: "offline",
    treeCount: 0,
  }),
  (error) => (
    error.code === "OZON_CATEGORY_UI_UNAVAILABLE"
    && error.message === "未能从 Ozon 获取真实类目数据，请重试"
  ),
);
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node app/tests/category-readiness.test.mjs
```

Expected: FAIL because `app/src/category-readiness.js` does not exist.

- [ ] **Step 3: Implement the minimal executable readiness module**

Implement:

```js
export const CATEGORY_DATA_ERROR_MESSAGE =
  "未能从 Ozon 获取真实类目数据，请重试";

export async function loadRealCategoryTrees({ readTree }) {
  try {
    const [zhResponse, ruResponse] = await Promise.all([
      readTree("ZH_HANS"),
      readTree("RU"),
    ]);
    const zhTree = itemsOf(zhResponse);
    const ruTree = itemsOf(ruResponse);
    if (!zhTree.length || !ruTree.length) throw new Error("empty category tree");
    return { zhTree, ruTree };
  } catch {
    const error = new Error(CATEGORY_DATA_ERROR_MESSAGE);
    error.code = "OZON_CATEGORY_UI_UNAVAILABLE";
    throw error;
  }
}

export function categoryReadiness(input = {}) {
  const ready = Boolean(
    input.descriptionCategoryId
    && input.typeId
    && !input.loading
    && !input.error
    && Number(input.treeCount) > 0
  );
  return { ready, message: ready ? "" : CATEGORY_DATA_ERROR_MESSAGE };
}

export function requireCategoryReadiness(input) {
  const result = categoryReadiness(input);
  if (!result.ready) {
    const error = new Error(result.message);
    error.code = "OZON_CATEGORY_UI_UNAVAILABLE";
    throw error;
  }
  return true;
}
```

`itemsOf` accepts only `response.items` or `response.data` arrays and returns
a cloned array. It does not accept local fallback input.

- [ ] **Step 4: Use the tested loader in the existing page component**

Import the three helper exports. Implement a retryable callback that:

1. clears the previous error;
2. calls `loadRealCategoryTrees({ readTree })`;
3. stores the returned true Ozon trees;
5. on failure clears category tree state and sets the fixed visible error;
6. always clears the loading state.

Do not add a new global utility or dependency.

- [ ] **Step 5: Render the explicit error and retry**

Use the existing Ant Design components:

```jsx
<Alert
  type="error"
  showIcon
  message="未能从 Ozon 获取真实类目数据"
  description="请检查店铺凭据或网络后重试。获取成功前不能预检或上架。"
  action={<Button onClick={loadCategoryTrees}>重试</Button>}
/>
```

Keep it scoped to the product edit/category area.

- [ ] **Step 6: Block category-dependent actions**

Before preview or publish:

```js
try {
  requireCategoryReadiness(categoryReadinessInput);
} catch (error) {
  message.error(error.message);
  return;
}
```

Disable only category-dependent actions. Do not disable unrelated navigation, draft editing or image editing.

- [ ] **Step 7: Run behavior tests and build**

Run:

```bash
node app/tests/category-readiness.test.mjs
node app/tests/prototype-style-contract.test.mjs
pnpm --dir app build
```

Expected:

- tests pass;
- build succeeds;
- no new accessibility or style contract failure.

- [ ] **Step 8: Review checkpoint**

Compare with the Task 1 App snapshot.

Expected:

- only the product editor category readiness flow changed;
- no unrelated page or global style churn;
- existing API paths unchanged.

---

### Task 8: Make The 1688 AI Wizard Stop On Category Failure

**Files:**
- Create: `extension/lib/category-readiness.js`
- Modify: `extension/content/1688-ai-wizard.js`
- Modify: `extension/manifest.json`
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/check-extension-diff-contract.mjs`
- Create: `extension/tests/category-readiness.test.js`
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: existing background actions `getCategoryTree` and `getCategoryAttributes`.
- Produces:
  - `window.SonliCategoryReadiness.failTree(state, error)`;
  - `window.SonliCategoryReadiness.failAttributes(state, error)`;
  - `window.SonliCategoryReadiness.markReady(state)`;
  - `window.SonliCategoryReadiness.requireReady(state)`;
  - explicit extension failure state with no automatic selection, no fake empty attribute schema and no publish continuation.

- [ ] **Step 1: Write failing behavior tests against the real extension helper**

Load `extension/lib/category-readiness.js` in a Node `vm` context and call
the exported global API.

Assert literal state transitions:

```js
const state = {
  catTree: { children: [{ type_id: 20 }] },
  catTreeLoading: true,
  catTreeError: "",
  category: { typeId: 20 },
  catPath: [{ type_id: 20 }],
  attrsSchema: [{ id: 30 }],
  reqAttrs: [{ id: 30 }],
  ratingAttrs: [{ id: 31 }],
  categoryDataError: "",
  categoryDataReady: true,
};

api.failTree(state, new Error("offline"));
assert.equal(state.catTree, null);
assert.equal(state.category, null);
assert.deepEqual(state.attrsSchema, []);
assert.match(state.categoryDataError, /Ozon/);
assert.throws(() => api.requireReady(state), /Ozon/);
```

Reset state and assert `failAttributes` clears only attribute data while
retaining the selected category for user retry.

- [ ] **Step 2: Run and observe current behavior**

Run:

```bash
node extension/tests/category-readiness.test.js
```

Expected: FAIL because `extension/lib/category-readiness.js` does not exist.

- [ ] **Step 3: Implement the helper and load it before the wizard**

Create an IIFE with no DOM or Chrome dependency:

```js
(() => {
  const MESSAGE = "未能从 Ozon 获取真实类目数据，请重试";
  function failTree(state) {
    state.catTree = null;
    state.catTreeLoading = false;
    state.catTreeError = MESSAGE;
    state.categoryDataError = MESSAGE;
    state.categoryDataReady = false;
    state.catPath = [];
    state.category = null;
    state.attrsSchema = [];
    state.reqAttrs = [];
    state.ratingAttrs = [];
  }
  function failAttributes(state) {
    state.categoryDataError = MESSAGE;
    state.categoryDataReady = false;
    state.attrsSchema = [];
    state.reqAttrs = [];
    state.ratingAttrs = [];
  }
  function markReady(state) {
    state.categoryDataError = "";
    state.categoryDataReady = true;
  }
  function requireReady(state) {
    if (state.categoryDataError || !state.categoryDataReady || !state.category) {
      throw new Error(MESSAGE);
    }
    return true;
  }
  globalThis.SonliCategoryReadiness = {
    failTree,
    failAttributes,
    markReady,
    requireReady,
  };
})();
```

Add `lib/category-readiness.js` immediately before
`content/1688-ai-wizard.js` in the matching manifest content-script array.

- [ ] **Step 4: Make the wizard consume the tested helper**

Tree failure:

```js
window.SonliCategoryReadiness.failTree(W, error);
```

Attribute failure:

```js
if (!resp.ok) {
  window.SonliCategoryReadiness.failAttributes(W, resp.error);
  renderBody();
  return;
}
```

After a successful authentic attribute response, call
`window.SonliCategoryReadiness.markReady(W)`. Ensure submission/preview
calls `requireReady(W)` and stops with its visible error on failure.

- [ ] **Step 5: Update extension parity contracts**

Add:

```text
lib/category-readiness.js
```

to `allowedLocalOnly` in `scripts/check-extension-source-parity.mjs`.
Update the exact manifest diff shape in
`scripts/check-extension-diff-contract.mjs` and require the helper path.

- [ ] **Step 6: Run extension regression**

Run:

```bash
node extension/tests/category-readiness.test.js
node extension/background/__tests__/agent-actions.smoke.test.js
node extension/tests/collector-removed.test.js
node extension/tests/jizhangerp-bridge-follow-sell.test.js
node --check extension/content/1688-ai-wizard.js
```

Expected: all pass.

- [ ] **Step 7: Repackage through the existing packaging script**

```bash
pnpm package-extension
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
```

Expected: source tree and both distributed ZIPs remain identical.

- [ ] **Step 8: Review checkpoint**

Expected:

- no new AI logic or prompt changes;
- no fallback category data;
- only failure-state behavior changed;
- generated artifacts change only when the source changed.

---

### Task 9: Lock Module Boundaries And Update Architecture Records

**Files:**
- Modify: `server/tests/module-boundaries.test.mjs`
- Modify: `docs/architecture/module-boundaries.md`
- Modify: `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md` status only after implementation
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox state only

**Interfaces:**
- Consumes: final service, route and entry structure.
- Produces: regression guards that prevent category logic or local fallback from returning to `server/index.mjs`.

- [ ] **Step 1: Write failing module-boundary assertions before deleting the old code**

Add:

```js
for (const functionName of [
  "cacheKeyForStore",
  "getOzonDescriptionCategoryTree",
  "findDescriptionCategoryIdByTypeId",
  "getOzonDescriptionCategoryAttributes",
  "getOzonDescriptionCategoryAttributeValues",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
    `${functionName} belongs in ozon-category-service.mjs`,
  );
}
```

Also assert:

```js
assert.doesNotMatch(
  serverEntry,
  /inferred:\\s*true/,
  "category routes must never return locally inferred category data",
);
```

- [ ] **Step 2: Lower the entry line guard**

Calculate:

```bash
wc -l server/index.mjs
```

Set the guard to the final line count rounded up by at most 20 lines. Never keep or raise the old 5400 limit.

- [ ] **Step 3: Update architecture documentation**

Record:

- category service owns Ozon query, validation, TTL cache, pagination and type resolution;
- category routes own authentication and HTTP mapping;
- local product caches are forbidden as a category source;
- preview and listing depend on the stable service contract;
- the entry line guard was lowered.

- [ ] **Step 4: Run boundary and structure checks**

Run:

```bash
node server/tests/module-boundaries.test.mjs
node --check server/index.mjs
node --check server/ozon-category-service.mjs
node --check server/ozon-category-routes.mjs
rg -n "DESCRIPTION_CATEGORY_CACHE|getOzonDescriptionCategory|findDescriptionCategoryIdByTypeId|inferred: true" server/index.mjs
```

Expected:

- tests and syntax pass;
- final `rg` has no matches.

- [ ] **Step 5: Review checkpoint**

Compare all Task 9 files to their Task 1 snapshots.

Expected: only documented category boundaries and the lower entry guard changed.

---

### Task 10: Full AGENTS.md Review, Regression And Recovery Handoff

**Files:**
- Verify: all files changed by Tasks 1-9
- Modify: `docs/superpowers/specs/2026-07-28-ozon-category-query-extraction-design.md` status
- Modify: `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` checkbox and actual-result sections only
- Create: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/final-report.md`

**Interfaces:**
- Consumes: completed category service, routes, entry integration, UI/plugin guards and tests.
- Produces: reproducible verification evidence, final readiness result and scoped rollback instructions.

- [ ] **Step 1: Run all changed-module tests**

Run:

```bash
node server/tests/ozon-client.test.mjs
node server/tests/ozon-category-service.test.mjs
node server/tests/ozon-category-routes.test.mjs
node server/tests/category-listing-readiness.test.mjs
node server/tests/cache-route-isolation.test.mjs
node server/tests/import-preview-route.test.mjs
node server/tests/import-currency-contract.test.mjs
node server/tests/collect-listing-submit-failure.test.mjs
node server/tests/external-write-safety.test.mjs
node server/tests/account-store-isolation.test.mjs
node server/tests/module-boundaries.test.mjs
node app/tests/category-readiness.test.mjs
node app/tests/prototype-style-contract.test.mjs
node extension/tests/category-readiness.test.js
```

Expected: all pass.

- [ ] **Step 2: Run AGENTS.md structural and security review**

Run:

```bash
wc -l server/index.mjs server/ozon-category-service.mjs server/ozon-category-routes.mjs
rg -n "fetch\\(" server/index.mjs server/ozon-category-service.mjs server/ozon-category-routes.mjs server/ozon-client.mjs
rg -n "apiKey|Api-Key|Client-Id" server/ozon-category-service.mjs server/ozon-category-routes.mjs server/tests/ozon-category-*.test.mjs
rg -n "state\\.caches\\.products|cacheItemsForStore|inferred:\\s*true" server/ozon-category-service.mjs server/ozon-category-routes.mjs server/index.mjs
git diff --check
```

Expected:

- Ozon `fetch` remains only in `ozon-client.mjs`;
- class/category modules do not read local products;
- credentials appear only in request-client code or safe test fixtures and never in error output;
- no whitespace/conflict errors;
- each module has one clear responsibility.

- [ ] **Step 3: Verify protected completed functions**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
node server/tests/sync-lease-isolation.test.mjs
node server/tests/account-store-isolation.test.mjs
node server/tests/external-write-safety.test.mjs
node scripts/check-store-data-isolation.mjs
```

Expected: sync extraction, leases, ownership and external write protection remain green.

- [ ] **Step 4: Run the complete engineering gate**

Start only the local test PostgreSQL if required:

```bash
docker start sonli-postgres
node scripts/verify.mjs
docker stop sonli-postgres
```

Expected:

- all active tests pass;
- all 19 verification checks pass;
- app build and extension parity pass;
- PostgreSQL is restored to the stopped state;
- no real Ozon request occurs.

- [ ] **Step 5: Inspect final scope**

Run:

```bash
git status --short
git diff --name-only
git diff --stat
git diff --check
```

Compare against `dirty-files-before.txt` and the Task 1 snapshots.

Expected:

- only declared category files plus pre-existing user changes differ;
- no lockfile, migration, database, config or deployment drift;
- no files are staged or committed.

- [ ] **Step 6: Update persistent completion records**

Set the design status to:

```text
已实施并通过完整验证
```

Record in the plan and `final-report.md`:

```text
Outcome:
- real-Ozon-only category service and routes
- no local-product category fallback
- strict preview/listing/UI/plugin failure behavior

Contracts:
- three existing success paths preserved
- additive meta provenance
- explicit non-2xx category errors

Validation:
- exact targeted test results
- complete active test count
- scripts/verify.mjs check count

External effects:
- no real Ozon calls
- no production/data writes
- local PostgreSQL restored to stopped

Unverified:
- real Ozon endpoint version and production permissions

Rollback:
- restore only files listed in this plan from Task 1 snapshots
- do not use git reset --hard
- no data rollback required
```

- [ ] **Step 7: Final independent review**

Review the scoped diff against:

- the confirmed design;
- `/Users/songliang/.codex/AGENTS.md`;
- this plan’s interfaces and acceptance criteria.

Release only when the reviewer reports:

```text
Ready: Yes
Critical: 0
Important: 0
```

Any finding must receive a focused fix, targeted regression and one final scoped re-review.
