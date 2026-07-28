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

- [ ] **Step 1: 写店铺资料和账号边界测试**

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

- [ ] **Step 2: 运行测试并确认服务模块不存在**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 创建工厂并迁移资料映射**

Create `server/ozon-sync-service.mjs`。导入：

```js
import crypto from "node:crypto";
import { activeStore, storesForAccount } from "./account-context.mjs";
import { appendAuditEvent } from "./audit-event.mjs";
import { callOzonSellerApi, getOzonSellerApi } from "./ozon-client.mjs";
import {
  cacheItemMatchesStore,
  cacheItemsForStore,
  cacheItemScope,
  upsertCacheItemByStore,
  upsertProductByStore,
} from "./store-cache-scope.mjs";
```

迁移 `truthyOzonFlag`、`firstCleanText`、`extractSellerInfoProfile`、`syncStoreProfile` 和 `refreshStoreProfiles`。所有时间改用：

```js
const nowIso = () => now().toISOString();
```

`refreshStoreProfiles` 只能从 `storesForAccount(state, accountId)` 选择目标；指定其他账号店铺时返回 404，不泄露店铺是否存在。

- [ ] **Step 4: 运行资料同步测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: 资料映射、固定时间和跨账号负向断言通过。
