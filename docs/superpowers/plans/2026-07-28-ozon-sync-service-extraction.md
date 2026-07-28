# Ozon 同步服务拆分实施计划

> **历史文档：** 本文件保留当时的目标、路径和执行步骤，不据此推断当前完成状态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Ozon HTTP 访问和店铺资料、商品、订单、仓库、促销同步从 `server/index.mjs` 拆到稳定、可独立测试的模块，同时保持现有 API 与数据 contract。

**Architecture:** `server/ozon-client.mjs` 成为唯一 Ozon Seller API HTTP 客户端；`server/store-cache-scope.mjs` 统一多账号、多店铺缓存边界；`server/ozon-sync-service.mjs` 通过状态 Port 执行同步、原子提交和报告闭环。`server/index.mjs` 只做认证、参数读取、权限边界和 HTTP 响应。

**Tech Stack:** Node.js ESM、原生 `fetch`、`node:test` 风格断言脚本、现有 JSON/PostgreSQL 持久化 Port、现有 `scripts/verify.mjs` 门禁。

## Global Constraints

- 遵守用户提供的 `AGENTS.md` 的结构、业务、安全数据和工程交付规则。
- 不改前端页面、数据库结构、依赖、环境配置或部署配置。
- 不执行真实 Ozon 请求；测试必须替换 `globalThis.fetch`。
- 不执行商品创建、库存更新、价格更新或上下架等 Ozon 写操作。
- 保持 `/local/stores/refresh-profile`、`/local/sync/:type` 的路径、请求字段、响应结构和缓存 contract。
- 账号认证和店铺归属必须继续由后端校验；管理员也不能同步其他账号店铺。
- 任一必需分页读取失败时，不提交目标缓存的半批结果。
- 同步期间店铺被删除或转移时返回 409，不提交结果。
- 本轮不创建 Git 提交，不暂存文件，不推送，不使用破坏性 Git 命令。
- 在已有脏工作区中只修改本计划列出的文件，不回退其他用户改动。

## 文件结构

- Create: `server/store-cache-scope.mjs`
  只负责生成、匹配、筛选和更新带账号/店铺作用域的缓存记录。
- Create: `server/ozon-sync-service.mjs`
  只负责店铺资料以及商品、订单、仓库、促销同步和同步报告状态闭环。
- Create: `server/tests/store-cache-scope.test.mjs`
  覆盖同 ID 跨店铺隔离和缓存更新。
- Create: `server/tests/ozon-client.test.mjs`
  覆盖 GET/POST、凭据、超时、网络和 HTTP 错误 contract。
- Create: `server/tests/ozon-sync-service.test.mjs`
  使用内存状态 Port 和模拟 Ozon 响应验证同步行为。
- Modify: `server/ozon-client.mjs`
  抽取共享请求内核并增加 GET，不改变现有 POST 导出。
- Modify: `server/index.mjs`
  删除重复 HTTP 与同步实现，接入新模块，保留路由和非本轮 Ozon 业务。
- Modify: `server/tests/module-boundaries.test.mjs`
  禁止入口重新定义同步函数，并下调入口行数门禁。
- Modify: `scripts/check-store-data-isolation.mjs`
  保持原隔离规则，但从新的缓存作用域模块读取 helper 定义。
- Modify: `docs/superpowers/specs/2026-07-28-ozon-sync-service-extraction-design.md`
  仅在实施发现已确认设计与代码事实冲突时同步修正文档。

---

### Task 1: 固化改造前基线

**Files:**
- Read: `server/index.mjs`
- Read: `server/ozon-client.mjs`
- Read: `server/tests/module-boundaries.test.mjs`
- Read: `scripts/verify.mjs`

**Interfaces:**
- Consumes: 当前工作区和现有 68 个测试文件门禁。
- Produces: 可对比的测试数量、入口行数和工作区差异清单。

- [x] **Step 1: 记录目标文件的现状**

Run:

```bash
git status --short
wc -l server/index.mjs server/ozon-client.mjs server/tests/module-boundaries.test.mjs
```

Expected:

- `server/index.mjs` 当前约 6186 行。
- 输出可能包含用户已有修改；后续不得清理或回退。

- [x] **Step 2: 运行改造前完整门禁**

Run:

```bash
node scripts/verify.mjs
```

Expected: 全部测试、构建和扩展包一致性检查通过；若失败，先记录为基线失败，不把无关失败混入本轮修复。

- [x] **Step 3: 记录本轮允许改动的文件**

Run:

```bash
git diff --name-only
```

Expected: 保存输出用于最终核对；本计划不得修改未列入“文件结构”的新文件。

### Task 2: 抽出多账号、多店铺缓存作用域模块

**Files:**
- Create: `server/store-cache-scope.mjs`
- Create: `server/tests/store-cache-scope.test.mjs`
- Modify: `server/index.mjs:780-837`
- Modify: `scripts/check-store-data-isolation.mjs`

**Interfaces:**
- Consumes: `store.id`、`store.clientId`、`store.ownerAccountId` 和缓存记录中的 `storeId`、`localStoreId`、`clientId`、`accountId`。
- Produces:
  - `cacheItemMatchesStore(item, store): boolean`
  - `cacheItemsForStore(items, store): Array<object>`
  - `cacheItemScope(store, accountId = ""): object`
  - `upsertCacheItemByStore(list, store, id, value, idFields = ["id"]): boolean`
  - `upsertProductByStore(list, store, id, value): boolean`

- [x] **Step 1: 写跨店铺隔离失败测试**

Create `server/tests/store-cache-scope.test.mjs` with:

```js
import assert from "node:assert/strict";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "../store-cache-scope.mjs";

const storeA = { id: "store_a", clientId: "client_a", ownerAccountId: "acct_a" };
const storeB = { id: "store_b", clientId: "client_b", ownerAccountId: "acct_b" };

assert.equal(cacheItemMatchesStore({ id: "p", storeId: "store_a" }, storeA), true);
assert.equal(cacheItemMatchesStore({ id: "p", storeId: "store_a" }, storeB), false);
assert.deepEqual(cacheItemScope(storeA, "acct_a"), {
  accountId: "acct_a",
  storeId: "store_a",
  storeName: "",
  clientId: "client_a",
});

const products = [];
upsertProductByStore(products, storeA, "same", {
  id: "same",
  title: "A",
  ...cacheItemScope(storeA, "acct_a"),
});
upsertProductByStore(products, storeB, "same", {
  id: "same",
  title: "B",
  ...cacheItemScope(storeB, "acct_b"),
});
assert.equal(products.length, 2);
assert.equal(cacheItemsForStore(products, storeA)[0].title, "A");

const postings = [];
upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]);
upsertCacheItemByStore(postings, storeA, "posting", {
  posting_number: "posting",
  status: "updated",
  ...cacheItemScope(storeA, "acct_a"),
}, ["posting_number"]);
assert.equal(postings.length, 1);
assert.equal(postings[0].status, "updated");

console.log("store cache scope tests passed");
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
node server/tests/store-cache-scope.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [x] **Step 3: 创建纯缓存边界模块**

Create `server/store-cache-scope.mjs` with the current matching priority intact. The module must not access the database, network, global state, or current-account context:

```js
function cacheItemStoreId(item = {}) {
  return String(
    item.storeId ||
    item.store_id ||
    item.ozonStoreId ||
    item.currentOzonStoreId ||
    item.localStoreId ||
    item.operatingStoreId ||
    "",
  );
}

export function cacheItemMatchesStore(item = {}, store = {}) {
  const expectedStoreId = String(store?.id || "");
  if (!expectedStoreId) return false;
  const itemStoreId = cacheItemStoreId(item);
  if (itemStoreId) return itemStoreId === expectedStoreId;

  const expectedClientId = String(store?.clientId || "");
  const itemClientId = String(item.clientId || item.client_id || item.ozonClientId || "");
  if (itemClientId) return Boolean(expectedClientId) && itemClientId === expectedClientId;

  const expectedNames = new Set(
    [store.label, store.companyName, store.storeName, store.name]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase()),
  );
  const itemStoreName = String(
    item.storeName || item.store_name || item.shopName || item.companyName || "",
  ).trim().toLowerCase();
  return Boolean(itemStoreName) && expectedNames.has(itemStoreName);
}

export function cacheItemsForStore(items, store) {
  return (Array.isArray(items) ? items : []).filter((item) => cacheItemMatchesStore(item, store));
}

export function cacheItemScope(store, accountId = "") {
  return {
    storeId: store.id,
    storeName: store.label || store.companyName || "",
    clientId: store.clientId,
    ...(accountId ? { accountId } : {}),
  };
}

export function upsertCacheItemByStore(list, store, id, value, idFields = ["id"]) {
  const itemId = String(id || "");
  if (!itemId || !store?.id) return false;
  const idx = list.findIndex((item) => {
    const existingId = idFields
      .map((field) => item?.[field])
      .find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
    return String(existingId || "") === itemId && cacheItemMatchesStore(item, store);
  });
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}

export function upsertProductByStore(list, store, id, value) {
  const productId = String(id || "");
  const storeId = String(store?.id || "");
  if (!productId || !storeId) return false;
  const idx = list.findIndex((item) => {
    const itemId = String(item.id || item.product_id || item.offer_id || "");
    return itemId === productId && cacheItemMatchesStore(item, store);
  });
  if (idx >= 0) list[idx] = value;
  else list.push(value);
  return idx < 0;
}
```

- [x] **Step 4: 让入口改为导入共享模块**

Modify `server/index.mjs`:

```js
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "./store-cache-scope.mjs";
```

删除入口内五个函数定义；保留 `testExports` 中原有导出名称，使旧测试 contract 不变。

- [x] **Step 5: 运行新旧隔离测试**

Run:

```bash
node server/tests/store-cache-scope.test.mjs
node server/tests/account-store-isolation.test.mjs
node scripts/check-store-data-isolation.mjs
```

Expected: 三个脚本都输出 passed；静态门禁从 `server/store-cache-scope.mjs` 检查 helper 定义，同时继续从 `server/index.mjs` 检查路由是否使用店铺作用域。

### Task 3: 统一 Ozon GET/POST HTTP 客户端

**Files:**
- Create: `server/tests/ozon-client.test.mjs`
- Modify: `server/ozon-client.mjs`
- Modify: `server/index.mjs:135,1472-1595` 以及剩余 `ozonCall` 调用点

**Interfaces:**
- Consumes: `store.clientId`、`store.apiKey`、API path、可选 body 和 timeout。
- Produces:
  - 保持 `callOzonSellerApi(store, apiPath, body, timeoutMs = 60000)`
  - 新增 `getOzonSellerApi(store, apiPath, timeoutMs = 60000)`
  - 错误字段：`status`、`code`、`body`、`cause`

- [x] **Step 1: 写 HTTP contract 测试**

Create `server/tests/ozon-client.test.mjs`。测试保存并恢复原 `globalThis.fetch`，每个场景使用独立响应桩：

```js
import assert from "node:assert/strict";
import { callOzonSellerApi, getOzonSellerApi } from "../ozon-client.mjs";

const originalFetch = globalThis.fetch;
const store = { clientId: "client-1", apiKey: "secret-1" };

try {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{"result":{"ok":true}}' };
  };
  assert.deepEqual(await callOzonSellerApi(store, "/v1/post", { value: 1 }), { result: { ok: true } });
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Client-Id"], "client-1");
  assert.equal(captured.options.headers["Api-Key"], "secret-1");
  assert.equal(captured.options.body, '{"value":1}');

  await getOzonSellerApi(store, "/v1/get");
  assert.equal(captured.options.method, "GET");
  assert.equal("body" in captured.options, false);

  await assert.rejects(
    () => callOzonSellerApi({}, "/v1/post", {}),
    (error) => error.status === 400 && error.code === "OZON_CREDENTIALS_MISSING",
  );

  globalThis.fetch = async () => {
    throw Object.assign(new Error("offline"), { code: "ENETDOWN" });
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => error.status === 502 && error.code === "ENETDOWN" && error.body.network === true,
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  });
  await assert.rejects(
    () => callOzonSellerApi(store, "/v1/post", {}),
    (error) => error.status === 429 && error.code === "OZON_HTTP_429" && error.body.raw === "rate limited",
  );

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get", 5),
    (error) => error.status === 504 && error.code === "OZON_TIMEOUT",
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ozon client tests passed");
```

再增加“`response.text()` 抛错”断言，要求 `status === 502` 且 `body.phase === "读取响应"`。

- [x] **Step 2: 运行测试并确认 GET 导出缺失**

Run:

```bash
node server/tests/ozon-client.test.mjs
```

Expected: FAIL，指出 `getOzonSellerApi` 未导出。

- [x] **Step 3: 抽取一个私有请求内核**

Modify `server/ozon-client.mjs`:

```js
async function requestOzonSellerApi(store, apiPath, {
  method,
  body,
  timeoutMs = 60000,
}) {
  // 统一执行凭据校验、AbortController、fetch、响应读取、JSON 解析和错误标准化。
}

export function callOzonSellerApi(store, apiPath, body, timeoutMs = 60000) {
  return requestOzonSellerApi(store, apiPath, { method: "POST", body: body || {}, timeoutMs });
}

export function getOzonSellerApi(store, apiPath, timeoutMs = 60000) {
  return requestOzonSellerApi(store, apiPath, { method: "GET", timeoutMs });
}
```

GET 不发送 body 和 `Content-Type`；POST 保持现有 JSON body。错误响应摘要最多保留 600 字符，不记录凭据。

- [x] **Step 4: 删除入口中的重复客户端**

Modify `server/index.mjs`:

```js
import { callOzonSellerApi } from "./ozon-client.mjs";
```

删除 `OZON_API_BASE`、`networkErrorDetail`、`ozonNetworkError`、`ozonCall` 和 `ozonGet`。将仍留在入口的类目、属性、导入状态查询调用从 `ozonCall(...)` 改成 `callOzonSellerApi(...)`。本轮同步逻辑迁移后，入口不应再需要 GET 客户端。

- [x] **Step 5: 运行客户端和上架工作进程相关测试**

Run:

```bash
node server/tests/ozon-client.test.mjs
node server/tests/external-write-safety.test.mjs
node server/tests/collect-listing-submit-failure.test.mjs
```

Expected: 全部通过；上架工作进程继续使用原 `callOzonSellerApi` contract。

### Task 4: 建立同步服务并迁移店铺资料

**Files:**
- Create: `server/ozon-sync-service.mjs`
- Create: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:1597-1680`

**Interfaces:**
- Consumes:
  - `loadState(): Promise<State>`
  - `saveState(state): Promise<void>`
  - `now(): Date`
  - `createJobId(): string`
  - `logger.warn/error(...)`
- Produces:

```js
createOzonSyncService({
  loadState,
  saveState,
  now = () => new Date(),
  createJobId = () => crypto.randomUUID(),
  logger = console,
})
```

返回：

```js
{
  syncStoreProfile(state, store),
  refreshStoreProfiles(state, { accountId, storeId = "" }),
  runLocalSync(state, {
    accountId,
    storeId,
    type,
    jobId,
    deviceId,
    source,
    postingsSinceDays,
  }),
}
```

- [x] **Step 1: 写店铺资料和账号边界测试**

Create an in-memory harness in `server/tests/ozon-sync-service.test.mjs`:

```js
import assert from "node:assert/strict";
import { createOzonSyncService } from "../ozon-sync-service.mjs";

const clone = (value) => structuredClone(value);
let persisted = {
  currentAccountId: "acct_a",
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", apiKey: "key_a" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", apiKey: "key_b" },
  ],
  caches: { products: [], postings: [], warehouses: [], promotions: [] },
  jobs: {},
  reports: [],
  auditEvents: [],
};
const service = createOzonSyncService({
  loadState: async () => clone(persisted),
  saveState: async (state) => { persisted = clone(state); },
  now: () => new Date("2026-07-28T08:00:00.000Z"),
  createJobId: () => "job_fixed",
  logger: { warn() {}, error() {} },
});
```

Mock `/v1/seller/info` and assert:

```js
const state = clone(persisted);
const result = await service.refreshStoreProfiles(state, { accountId: "acct_a", storeId: "store_a" });
assert.equal(result.syncedCount, 1);
assert.equal(persisted.stores[0].companyName, "Seller A");
assert.equal(persisted.stores[0].profileSyncedAt, "2026-07-28T08:00:00.000Z");
await assert.rejects(
  () => service.refreshStoreProfiles(clone(persisted), { accountId: "acct_a", storeId: "store_b" }),
  (error) => error.status === 404,
);
```

- [x] **Step 2: 运行测试并确认服务模块不存在**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [x] **Step 3: 创建工厂并迁移资料映射**

Create `server/ozon-sync-service.mjs`。导入：

```js
import crypto from "node:crypto";
import { storesForAccount } from "./account-context.mjs";
import { callOzonSellerApi } from "./ozon-client.mjs";
```

迁移 `truthyOzonFlag`、`firstCleanText`、`extractSellerInfoProfile`、`syncStoreProfile` 和 `refreshStoreProfiles`。所有时间改用：

```js
const nowIso = () => now().toISOString();
```

`refreshStoreProfiles` 只能从 `storesForAccount(state, accountId)` 选择目标；指定其他账号店铺时返回 404，不泄露店铺是否存在。
后续同步任务需要的 `activeStore`、审计、GET 客户端和缓存 helper 到实际使用时再导入；本任务不得用
`void` no-op 预占未来依赖。

- [x] **Step 4: 运行资料同步测试**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: 资料映射、固定时间和跨账号负向断言通过。

### Task 5: 迁移商品同步并证明失败不覆盖旧缓存

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:2581-2807`
- Modify: `scripts/check-store-data-isolation.mjs`

**Interfaces:**
- Consumes: `/v3/product/list`、`/v3/product/info/list`、`/v5/product/info/prices`、`/v2/analytics/stock_on_warehouses`、`/v2/product/info/stocks-by-warehouse/fbs`。
- Produces: 目标店铺完整商品快照及 `fetchedCount`；其他店铺缓存不变。

- [x] **Step 1: 增加商品多页、库存价格合并测试**

给测试 harness 的 `fetch` 响应队列增加两个商品列表页、详情、价格、FBO/FBS 库存。断言：

```js
assert.equal(report.status, "SUCCESS");
assert.equal(report.fetchedCount, 2);
assert.equal(persisted.caches.products.filter((row) => row.storeId === "store_a").length, 2);
assert.equal(persisted.caches.products.find((row) => row.id === "product_1").price_info.price, "99.00");
assert.equal(persisted.caches.products.find((row) => row.id === "product_1").warehouse_stocks.length, 2);
assert.equal(persisted.caches.products.some((row) => row.storeId === "store_b" && row.id === "foreign"), true);
```

- [x] **Step 2: 增加分页中途失败测试**

初始状态放入 `store_a` 的 `old_product`；第一列表页成功、第二列表页抛 `ENETDOWN`。断言：

```js
await assert.rejects(() => service.runLocalSync(clone(persisted), {
  accountId: "acct_a",
  storeId: "store_a",
  type: "PRODUCTS",
  jobId: "job_products_failed",
}));
assert.equal(persisted.caches.products.some((row) => row.id === "old_product"), true);
assert.equal(persisted.caches.products.some((row) => row.id === "partial_product"), false);
assert.equal(persisted.jobs.job_products_failed.status, "FAILED");
```

- [x] **Step 3: 运行测试并确认商品类型尚不支持**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，错误为不支持 `PRODUCTS` 或商品缓存未更新。

- [x] **Step 4: 迁移商品和库存标准化函数**

把以下函数移到服务文件并使用 `callOzonSellerApi`：

```text
pickArray
stockCountFromOzon
normalizeWarehouseStockRows
addWarehouseStockLookup
warehouseStockRowsForProduct
dedupeWarehouseStockRows
fetchWarehouseStockLookup
fetchFbsWarehouseStockLookup
syncProducts
```

服务必须在传入的工作状态副本上构建结果。`syncProducts` 结束前不调用 `saveState`；目标缓存替换只发生在后续原子提交阶段。
本任务把 `runLocalSync` 从 501 stub 扩展为只支持 `PRODUCTS` 的最小可用闭环：保存 RUNNING，
成功时一次提交目标商品缓存和 SUCCESS，失败时保留旧缓存并保存 FAILED。版本冲突重试和最终店铺
归属复核仍由 Task 7 加固。

删除入口中的商品同步实现后，入口旧 `runLocalSync` 在创建旧报告前把 `PRODUCTS` 委托给：

```js
return ozonSyncService.runLocalSync(state, {
  accountId,
  storeId,
  type: upper,
  jobId: options.jobId,
  deviceId: options.deviceId,
  source: options.source,
  postingsSinceDays: options.postingsSinceDays,
});
```

其他三种同步类型暂时继续使用入口旧实现。商品列表、详情、价格、FBO 库存和 FBS 库存的任一
必需分页失败都必须向上抛出，不得吞掉后提交成功。

- [x] **Step 5: 运行商品同步和账号隔离测试**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
node server/tests/account-store-isolation.test.mjs
```

Expected: 商品分页、合并、失败保护和跨店铺隔离全部通过。
同时运行 `scripts/check-store-data-isolation.mjs`；商品同步调用断言应改查
`server/ozon-sync-service.mjs`，其他入口路由隔离断言继续查 `server/index.mjs`。

### Task 6: 迁移订单、仓库和促销同步

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:2809-2962`

**Interfaces:**
- Consumes:
  - FBS `/v4/posting/fbs/list`
  - FBO `/v2/posting/fbo/list`
  - 仓库 `/v2/warehouse/list`
  - 促销 GET `/v1/actions`
- Produces: `POSTINGS`、`WAREHOUSES`、`PROMOTIONS` 三种同步报告和目标店铺缓存。

- [x] **Step 1: 写 FBS/FBO 分页和时间窗口测试**

使用固定 `now()`，模拟一个 FBS 页面和一个 FBO 页面。断言：

```js
assert.equal(postingReport.fetchedCount, 2);
assert.equal(persisted.caches.postings.find((row) => row.id === "fbs_1").storeId, "store_a");
assert.equal(persisted.caches.postings.find((row) => row.id === "fbo_1").shipment_type, "FBO");
assert.equal(capturedFbsBody.filter.to, "2026-07-28T08:00:00.000Z");
```

再模拟 `PERIOD_IS_TOO_LONG`，验证原区间被拆成 `[since, midpoint]` 和
`[midpoint, to]` 两段，两段都完成读取；每段后续 cursor 页必须继续使用该段固定的 since/to，
不能切回原完整区间。

- [x] **Step 2: 写 FBO 失败的原子性测试**

让 FBS 成功而 FBO 抛错，断言：

```js
await assert.rejects(() => service.runLocalSync(clone(persisted), {
  accountId: "acct_a",
  storeId: "store_a",
  type: "POSTINGS",
  jobId: "job_postings_failed",
}));
assert.deepEqual(
  persisted.caches.postings.filter((row) => row.storeId === "store_a").map((row) => row.id),
  ["old_posting"],
);
assert.equal(persisted.jobs.job_postings_failed.status, "FAILED");
```

该断言明确替代旧的“忽略 FBO 错误并返回成功”行为。

- [x] **Step 3: 写仓库和促销替换测试**

断言目标店铺旧缓存被完整替换，其他店铺保留，且促销请求为 GET：

```js
assert.equal(warehouseReport.fetchedCount, 1);
assert.equal(promotionReport.fetchedCount, 1);
assert.equal(capturedPromotionMethod, "GET");
assert.equal(persisted.caches.warehouses.some((row) => row.storeId === "store_b"), true);
assert.equal(persisted.caches.promotions.some((row) => row.storeId === "store_b"), true);
```

- [x] **Step 4: 运行测试并确认三种类型尚未完整实现**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，指出 `POSTINGS`、`WAREHOUSES` 或 `PROMOTIONS` 分支缺失。

- [x] **Step 5: 迁移三个同步实现**

迁移 `syncPostings`、`syncWarehouses`、`syncPromotions`。必须做两处明确调整：

```js
const nowDate = now();
```

用于订单窗口，保证可测试；FBO 错误不再 catch 后忽略，必须向上抛出，由 `runLocalSync` 记录 FAILED。
把最小 `runLocalSync` 扩展为四种已支持类型的统一 dispatch 和按类型缓存提交。入口旧
`runLocalSync` 此时只保留参数适配，所有类型都立即委托给 service；删除已迁移的三个同步函数，
不能保留指向已删除函数的死分支。Task 7 再把 service 的持久化加固为冲突重试和最终归属复核。

- [x] **Step 6: 运行同步服务测试**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: 四种同步类型、固定时间、GET 促销、FBO 失败保护全部通过。

### Task 7: 完成同步报告状态闭环、冲突重试和最终归属复核

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:2964-3145`

**Interfaces:**
- Consumes: `LOCAL_STATE_VERSION_CONFLICT`、最新状态中的店铺归属、同步类型和任务元数据。
- Produces: `RUNNING → SUCCESS` 或 `RUNNING → FAILED` 的报告、审计事件和原子缓存提交。

- [x] **Step 1: 写状态冲突有限重试测试**

令 `saveState` 前两次抛：

```js
Object.assign(new Error("conflict"), { code: "LOCAL_STATE_VERSION_CONFLICT" })
```

第三次成功。断言最终 `SUCCESS` 且保存尝试次数为 3。再令连续四次冲突，断言失败并停止重试。

- [x] **Step 2: 写同步期间店铺删除和转移测试**

Ozon 拉取完成前替换 `loadState()` 返回值：

```js
persisted.stores = persisted.stores.filter((store) => store.id !== "store_a");
```

以及：

```js
persisted.stores.find((store) => store.id === "store_a").ownerAccountId = "acct_b";
```

两种情况都断言 `error.status === 409`、旧缓存未变、最终报告为 FAILED。

- [x] **Step 3: 写不支持类型和失败报告保存降级测试**

断言：

```js
await assert.rejects(() => service.runLocalSync(clone(persisted), {
  accountId: "acct_a",
  storeId: "store_a",
  type: "UNKNOWN",
  jobId: "job_unknown",
}));
assert.equal(persisted.jobs.job_unknown.status, "FAILED");
```

再让 FAILED 报告保存本身失败，验证 `logger.warn` 收到脱敏消息，原始 Ozon 错误仍是最终抛出的错误。

- [x] **Step 4: 运行测试并确认闭环边界尚未全部通过**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL 于冲突重试、409 或 FAILED 报告断言之一。

- [x] **Step 5: 迁移并收紧报告提交逻辑**

在服务内实现：

```text
appendSyncReport
persistSyncReport
commitLocalSyncResult
runLocalSync
```

要求：

- 首次保存 RUNNING 报告。
- 只对 `LOCAL_STATE_VERSION_CONFLICT` 最多重试 4 次。
- 每次提交前重新 `loadState()`。
- 使用 `activeStore(latest, store.id, accountId)` 复核归属。
- SUCCESS 报告与目标缓存放在同一次 `saveState` 中提交。
- 失败时尽力保存 FAILED 报告，保存失败只写脱敏警告。
- 每个终态报告通过 `appendAuditEvent` 写审计事件。
- `runLocalSync` 使用对象参数，不依赖 `state.currentAccountId` 推断请求账号。

- [x] **Step 6: 运行服务全部测试**

Run:

```bash
node server/tests/ozon-sync-service.test.mjs
```

Expected: 输出 `ozon sync service tests passed`。

### Task 8: 接入入口路由并锁定模块边界

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`

**Interfaces:**
- Consumes: `createOzonSyncService` 三个公开方法。
- Produces: 现有两个 HTTP route contract 和店铺绑定/更新时的资料刷新行为。

- [x] **Step 1: 先写边界门禁失败断言**

Modify `server/tests/module-boundaries.test.mjs`:

```js
for (const functionName of [
  "ozonCall",
  "ozonGet",
  "syncStoreProfile",
  "refreshStoreProfiles",
  "syncProducts",
  "syncPostings",
  "syncWarehouses",
  "syncPromotions",
  "runLocalSync",
]) {
  assert.doesNotMatch(
    serverEntry,
    new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`),
    `${functionName} must remain outside server/index.mjs`,
  );
}
```

把入口行数上限从 `6200` 调整为 `5400`；实施后若实际迁移结果更低，可取不高于实际行数加 20 的值，但绝不能高于 5400。

- [x] **Step 2: 运行门禁并确认失败**

Run:

```bash
node server/tests/module-boundaries.test.mjs
```

Expected: FAIL，指出入口仍定义同步函数或超过新行数上限。

- [x] **Step 3: 在入口创建服务实例**

Modify `server/index.mjs` imports and initialization:

```js
import { createOzonSyncService } from "./ozon-sync-service.mjs";

const ozonSyncService = createOzonSyncService({
  loadState,
  saveState,
  logger: console,
});
```

删除入口内已迁移的同步函数和产品库存辅助函数；保留 `mutateLatestStateWithRetry`，因为采集扩展导入路由仍使用它。

- [x] **Step 4: 改造四类调用点**

店铺绑定和 PATCH 更新：

```js
await ozonSyncService.syncStoreProfile(state, store);
```

资料刷新路由：

```js
const result = await ozonSyncService.refreshStoreProfiles(state, {
  accountId: account.id,
  storeId,
});
```

本地同步路由：

```js
const report = await ozonSyncService.runLocalSync(state, {
  accountId: account.id,
  storeId: body.storeId || currentStoreIdForAccount(state, account.id),
  type: localSyncMatch[1],
  jobId: body.jobId,
  deviceId: String(req.headers["x-device-fingerprint"] || body.deviceId || "").trim(),
  source: req.headers["x-device-fingerprint"] ? "extension" : "web",
  postingsSinceDays: body.postingsSinceDays,
});
```

不得把整个 `body` 继续透传给 service；只传稳定 contract 中列出的字段。

- [x] **Step 5: 运行边界与路由回归**

Run:

```bash
node server/tests/module-boundaries.test.mjs
node server/tests/account-store-isolation.test.mjs
node server/tests/sync-lease-isolation.test.mjs
```

Expected: 三个脚本都通过，入口不再拥有同步实现，账号和设备租约边界不变。

- [x] **Step 6: 检查重复 HTTP 和同步定义**

Run:

```bash
rg -n "OZON_API_BASE|function ozonCall|function ozonGet|function syncStoreProfile|function syncProducts|function syncPostings|function syncWarehouses|function syncPromotions|function runLocalSync" server
```

Expected:

- `OZON_API_BASE` 只在 `server/ozon-client.mjs`。
- 同步函数只在 `server/ozon-sync-service.mjs`。
- 测试文字和门禁正则可以出现函数名。

### Task 9: 完整验证、AGENTS.md 复查和交付记录

**Files:**
- Verify: all changed files
- Modify: `docs/superpowers/plans/2026-07-28-ozon-sync-service-extraction.md` checkbox state only

**Interfaces:**
- Consumes: 完成后的客户端、同步服务、入口和测试。
- Produces: 可复现的验证结果、未验证范围、风险和回滚说明。

- [x] **Step 1: 运行语法和定向测试**

Run:

```bash
node --check server/ozon-client.mjs
node --check server/store-cache-scope.mjs
node --check server/ozon-sync-service.mjs
node server/tests/ozon-client.test.mjs
node server/tests/store-cache-scope.test.mjs
node server/tests/ozon-sync-service.test.mjs
node server/tests/module-boundaries.test.mjs
```

Expected: 全部通过。

- [x] **Step 2: 运行完整门禁**

Run:

```bash
node scripts/verify.mjs
```

Expected: 自动测试、前端构建、扩展包一致性和数据库集成检查全部通过。

Actual（2026-07-28）:

- 临时启动本地测试 PostgreSQL 后重新运行完整门禁，随后恢复为停止状态。
- 97 个测试全部通过，0 失败。
- 前端构建、71 项活跃测试清单、92 个扩展源码文件一致性检查均通过。
- `scripts/verify.mjs` 的 19 项检查全部通过。
- 最终兼容性复审补充了 `Ozon 404` 稳定消息/code 和凭据不泄露回归测试，复审结论为 `Ready: Yes`。
- 未调用真实 Ozon，也未修改数据库结构、依赖、环境配置或部署配置。

- [x] **Step 3: 对照 AGENTS.md 做结构和安全复查**

Run:

```bash
wc -l server/index.mjs server/ozon-client.mjs server/store-cache-scope.mjs server/ozon-sync-service.mjs
rg -n "apiKey|Client-Id|Api-Key" server/ozon-client.mjs server/ozon-sync-service.mjs server/tests/ozon-client.test.mjs
rg -n "fetch\\(" server/index.mjs server/ozon-client.mjs server/ozon-sync-service.mjs
rg -n "activeStore\\(|storesForAccount\\(" server/ozon-sync-service.mjs
git diff --check
```

Expected:

- `server/index.mjs` 不超过 5400 行。
- 凭据只用于请求头和测试桩，不进入日志、错误摘要或报告。
- Ozon Seller API fetch 只存在于 `server/ozon-client.mjs`。
- service 在选择和最终提交时都执行账号/店铺边界校验。
- 无空白和冲突标记错误。

- [x] **Step 4: 核对改动范围**

Run:

```bash
git status --short
git diff --name-only
git diff --stat
```

Expected: 新增/修改只涉及本计划文件以及进入本轮前已存在的用户改动；不得暂存或提交。

- [x] **Step 5: 形成交付说明**

最终说明必须包含：

```text
改了什么：
- 单一 Ozon HTTP 客户端
- 独立缓存作用域模块
- 独立同步服务
- 入口只保留路由编排

contract：
- 现有两个同步相关路由 contract 未变
- 新增内部 getOzonSellerApi 和 createOzonSyncService contract

验证：
- 列出定向测试与 scripts/verify.mjs 的实际结果和测试数量

回归：
- 账号/店铺隔离、同步租约、上架外部写保护、前端构建、扩展包一致性

未验证：
- 未连接真实 Ozon；原因是本轮禁止真实外部调用

回滚：
- 仅反向恢复本轮新模块、入口导入/调用和测试门禁
- 不使用 git reset --hard，不影响用户其他改动
```
