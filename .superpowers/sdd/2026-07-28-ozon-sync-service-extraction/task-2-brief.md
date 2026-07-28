### Task 2: 抽出多账号、多店铺缓存作用域模块

**Files:**
- Create: `server/store-cache-scope.mjs`
- Create: `server/tests/store-cache-scope.test.mjs`
- Modify: `server/index.mjs:780-837`

**Interfaces:**
- Consumes: `store.id`、`store.clientId`、`store.ownerAccountId` 和缓存记录中的 `storeId`、`localStoreId`、`clientId`、`accountId`。
- Produces:
  - `cacheItemMatchesStore(item, store): boolean`
  - `cacheItemsForStore(items, store): Array<object>`
  - `cacheItemScope(store, accountId = ""): object`
  - `upsertCacheItemByStore(list, store, id, value, idFields = ["id"]): object`
  - `upsertProductByStore(list, store, id, value): object`

- [ ] **Step 1: 写跨店铺隔离失败测试**

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
upsertProductByStore(products, storeA, "same", { id: "same", title: "A" });
upsertProductByStore(products, storeB, "same", { id: "same", title: "B" });
assert.equal(products.length, 2);
assert.equal(cacheItemsForStore(products, storeA)[0].title, "A");

const postings = [];
upsertCacheItemByStore(postings, storeA, "posting", { posting_number: "posting" }, ["posting_number"]);
upsertCacheItemByStore(postings, storeA, "posting", { posting_number: "posting", status: "updated" }, ["posting_number"]);
assert.equal(postings.length, 1);
assert.equal(postings[0].status, "updated");

console.log("store cache scope tests passed");
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/store-cache-scope.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 创建纯缓存边界模块**

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

- [ ] **Step 4: 让入口改为导入共享模块**

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

- [ ] **Step 5: 运行新旧隔离测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/store-cache-scope.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/account-store-isolation.test.mjs
```

Expected: 两个脚本都输出 passed。
