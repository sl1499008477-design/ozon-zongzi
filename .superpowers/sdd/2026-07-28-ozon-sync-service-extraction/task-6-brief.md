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

- [ ] **Step 1: 写 FBS/FBO 分页和时间窗口测试**

使用固定 `now()`，模拟一个 FBS 页面和一个 FBO 页面。断言：

```js
assert.equal(postingReport.fetchedCount, 2);
assert.equal(persisted.caches.postings.find((row) => row.id === "fbs_1").storeId, "store_a");
assert.equal(persisted.caches.postings.find((row) => row.id === "fbo_1").shipment_type, "FBO");
assert.equal(capturedFbsBody.filter.to, "2026-07-28T08:00:00.000Z");
```

再模拟 `PERIOD_IS_TOO_LONG`，验证拆短区间的第二次请求使用中间时间。

- [ ] **Step 2: 写 FBO 失败的原子性测试**

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

- [ ] **Step 3: 写仓库和促销替换测试**

断言目标店铺旧缓存被完整替换，其他店铺保留，且促销请求为 GET：

```js
assert.equal(warehouseReport.fetchedCount, 1);
assert.equal(promotionReport.fetchedCount, 1);
assert.equal(capturedPromotionMethod, "GET");
assert.equal(persisted.caches.warehouses.some((row) => row.storeId === "store_b"), true);
assert.equal(persisted.caches.promotions.some((row) => row.storeId === "store_b"), true);
```

- [ ] **Step 4: 运行测试并确认三种类型尚未完整实现**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，指出 `POSTINGS`、`WAREHOUSES` 或 `PROMOTIONS` 分支缺失。

- [ ] **Step 5: 迁移三个同步实现**

迁移 `syncPostings`、`syncWarehouses`、`syncPromotions`。必须做两处明确调整：

```js
const nowDate = now();
```

用于订单窗口，保证可测试；FBO 错误不再 catch 后忽略，必须向上抛出，由 `runLocalSync` 记录 FAILED。

- [ ] **Step 6: 运行同步服务测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: 四种同步类型、固定时间、GET 促销、FBO 失败保护全部通过。
