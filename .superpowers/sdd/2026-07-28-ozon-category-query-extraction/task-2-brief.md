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

- [ ] **Step 1: Write failing service tests for tree, attributes and cache provenance**

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

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
node server/tests/ozon-category-service.test.mjs
```

Expected: FAIL because `server/ozon-category-service.mjs` does not exist.

- [ ] **Step 3: Implement the minimal service skeleton and scoped cache**

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

- [ ] **Step 4: Implement tree and attribute validation**

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

- [ ] **Step 5: Map Ozon failures without leaking source details**

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

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```bash
node --check server/ozon-category-service.mjs
node server/tests/ozon-category-service.test.mjs
node server/tests/ozon-client.test.mjs
```

Expected: all pass.

- [ ] **Step 7: Review checkpoint**

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
