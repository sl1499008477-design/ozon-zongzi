### Task 5: 迁移商品同步并证明失败不覆盖旧缓存

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:2581-2807`

**Interfaces:**
- Consumes: `/v3/product/list`、`/v3/product/info/list`、`/v5/product/info/prices`、`/v2/analytics/stock_on_warehouses`、`/v2/product/info/stocks-by-warehouse/fbs`。
- Produces: 目标店铺完整商品快照及 `fetchedCount`；其他店铺缓存不变。

- [ ] **Step 1: 增加商品多页、库存价格合并测试**

给测试 harness 的 `fetch` 响应队列增加两个商品列表页、详情、价格、FBO/FBS 库存。断言：

```js
assert.equal(report.status, "SUCCESS");
assert.equal(report.fetchedCount, 2);
assert.equal(persisted.caches.products.filter((row) => row.storeId === "store_a").length, 2);
assert.equal(persisted.caches.products.find((row) => row.id === "product_1").price_info.price, "99.00");
assert.equal(persisted.caches.products.find((row) => row.id === "product_1").warehouse_stocks.length, 2);
assert.equal(persisted.caches.products.some((row) => row.storeId === "store_b" && row.id === "foreign"), true);
```

- [ ] **Step 2: 增加分页中途失败测试**

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

- [ ] **Step 3: 运行测试并确认商品类型尚不支持**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL，错误为不支持 `PRODUCTS` 或商品缓存未更新。

- [ ] **Step 4: 迁移商品和库存标准化函数**

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

- [ ] **Step 5: 运行商品同步和账号隔离测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/account-store-isolation.test.mjs
```

Expected: 商品分页、合并、失败保护和跨店铺隔离全部通过。
