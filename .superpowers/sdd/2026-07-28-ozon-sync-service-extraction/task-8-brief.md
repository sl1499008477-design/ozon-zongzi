### Task 8: 接入入口路由并锁定模块边界

**Files:**
- Modify: `server/index.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`

**Interfaces:**
- Consumes: `createOzonSyncService` 三个公开方法。
- Produces: 现有两个 HTTP route contract 和店铺绑定/更新时的资料刷新行为。

- [ ] **Step 1: 先写边界门禁失败断言**

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

- [ ] **Step 2: 运行门禁并确认失败**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/module-boundaries.test.mjs
```

Expected: FAIL，指出入口仍定义同步函数或超过新行数上限。

- [ ] **Step 3: 在入口创建服务实例**

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

- [ ] **Step 4: 改造四类调用点**

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

- [ ] **Step 5: 运行边界与路由回归**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/module-boundaries.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/account-store-isolation.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/sync-lease-isolation.test.mjs
```

Expected: 三个脚本都通过，入口不再拥有同步实现，账号和设备租约边界不变。

- [ ] **Step 6: 检查重复 HTTP 和同步定义**

Run:

```bash
rg -n "OZON_API_BASE|function ozonCall|function ozonGet|function syncStoreProfile|function syncProducts|function syncPostings|function syncWarehouses|function syncPromotions|function runLocalSync" server
```

Expected:

- `OZON_API_BASE` 只在 `server/ozon-client.mjs`。
- 同步函数只在 `server/ozon-sync-service.mjs`。
- 测试文字和门禁正则可以出现函数名。
