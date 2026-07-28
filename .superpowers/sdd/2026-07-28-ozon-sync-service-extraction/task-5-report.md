# Task 5 报告：迁移商品同步并证明失败不覆盖旧缓存

## Status

`DONE_WITH_CONCERNS`

已在 dirty `main` 原地完成 PRODUCTS 同步迁移。旧 `/local/sync/PRODUCTS` route/data contract 保持不变；服务在账号所属店铺的独立工作副本中构建完整商品快照，成功时一次提交目标店铺缓存，任一必需 Ozon 分页请求失败时只持久化 FAILED report，不覆盖旧目标缓存或其他账号/店铺缓存。

未执行真实 Ozon 请求、数据库操作、配置或依赖变更，也未执行 commit、stage、push、stash 或分支切换。

## 变更文件与 Contract

- `server/ozon-sync-service.mjs`
  - 迁入 `pickArray`、库存标准化/合并 helper、FBO/FBS 库存分页和 `syncProducts`。
  - `runLocalSync` 支持 `PRODUCTS`，其他类型继续返回 `501 / OZON_SYNC_UNSUPPORTED`。
  - 新增最小 RUNNING/SUCCESS/FAILED jobs/reports 持久化。
  - SUCCESS/FAILED 继续写入幂等审计事件，保留旧 PRODUCTS 同步的可追溯性。
  - 使用 `structuredClone(state)` 构建工作副本；商品 helper 内不调用 `saveState`。
  - SUCCESS 提交只替换目标店铺商品行并保留其他店铺行。
  - FAILED 路径只更新 report，不提交工作副本缓存。
- `server/tests/ozon-sync-service.test.mjs`
  - 新增两页商品列表、详情、价格、FBO/FBS 库存合并测试。
  - 验证 `fetchedCount=2`、两页 cursor、价格映射、双仓库存和其他店铺缓存保留。
  - 新增第二页 `ENETDOWN` 测试，验证旧目标商品保留、部分商品不落库、其他店铺商品保留、RUNNING→FAILED 和终态审计。
- `server/index.mjs`
  - 删除入口中的 9 个商品/库存 helper 和 `syncProducts`。
  - 旧 `runLocalSync` 在创建旧 report 前将 `PRODUCTS` 委托给 `ozonSyncService.runLocalSync(...)`。
  - 透传 `accountId`、`storeId`、`type`、`jobId`、`deviceId`、`source` 和 `postingsSinceDays`。
  - POSTINGS、WAREHOUSES、PROMOTIONS 继续走旧实现。
- `scripts/check-store-data-isolation.mjs`
  - 经明确扩展授权，商品同步 upsert 静态断言改为读取 `server/ozon-sync-service.mjs`。
  - cache helper 定义、入口 route/import、持久化和前端隔离断言仍读取原目标文件。

## TDD RED / GREEN

### RED 1：PRODUCTS 尚未支持

先扩展 service 测试，再运行：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

退出码 `1`，在首个 PRODUCTS 成功场景按预期失败：

```text
Error: Ozon 本地同步尚未迁移到服务
status: 501
code: OZON_SYNC_UNSUPPORTED
```

实现商品同步、工作副本和终态持久化后，测试输出：

```text
ozon sync service tests passed
```

### RED 2：终态审计不可丢失

新增 SUCCESS/FAILED 审计断言后，当前实现退出码 `1`：

```text
AssertionError: false !== true
```

接入现有 `appendAuditEvent` 并恢复旧同步的终态审计后，测试再次通过。

### RED 3：静态隔离门禁目标过期

商品 helper 从入口迁出后，静态 verifier 按预期失败，因为仍要求 `upsertProductByStore(cache, store, id, ...)` 出现在 `server/index.mjs`。获得明确范围扩展后，只把该断言改查新 service；GREEN：

```text
store data isolation contract ok
```

## 分页队列与数据合并

PRODUCTS 读取队列保持原 endpoint、payload 和 timeout：

1. best-effort `/v1/seller/info` 资料刷新；
2. `/v2/analytics/stock_on_warehouses`，`limit=1000`、按 `offset` 分页，`120000ms`；
3. `/v3/product/list`，分别读取 `ALL` 与 `ARCHIVED`，沿 `last_id` 分页；
4. 每 1000 个 product ID 调用 `/v3/product/info/list`，`120000ms`；
5. 同一批次调用 `/v5/product/info/prices`，`120000ms`；
6. 每 500 个 offer ID 或 sku 调用 `/v2/product/info/stocks-by-warehouse/fbs`，沿 cursor 分页，`120000ms`；
7. 以 product/offer/sku 等稳定键合并 FBO 与 FBS 仓库行，并按 source、warehouse、sku、offer 去重。

测试中的 `ALL` 队列明确经过 `last_id=""` 和 `last_id="page_2"` 两页；`product_1` 最终得到 `price_info.price="99.00"` 和两条不同来源仓库库存。

## Atomicity

- `runLocalSync` 在任何 Ozon 商品读取前持久化 RUNNING report。
- 传入 state 立即克隆为工作副本；profile 和商品结果只写工作副本。
- FBO stock、product list、details、price、FBS stock 的 `callOzonSellerApi` 均不在 helper 内吞错。
- `syncProducts` 结束前不调用 `saveState`。
- 全部可见性、分页和批次完成后，SUCCESS 路径重新加载最新 state，一次替换目标店铺商品快照并写 SUCCESS report。
- 第二页商品列表抛 `ENETDOWN` 时，工作副本中的 `partial_product` 未提交；持久化 state 仍包含 `old_product` 和另一店铺的 `foreign`，只新增 FAILED report/audit。

## Index Delegation

`server/index.mjs` 的旧 `runLocalSync` 先计算 account/type/job ID，随后在构建旧 RUNNING report 之前处理：

```js
if (upper === "PRODUCTS") {
  return ozonSyncService.runLocalSync(state, {
    accountId,
    storeId,
    type: upper,
    jobId,
    deviceId: options.deviceId || "",
    source: options.source || "",
    postingsSinceDays: options.postingsSinceDays,
  });
}
```

因此 PRODUCTS 不会创建重复旧 report；其他三种同步仍执行原入口状态机和提交逻辑。

## 验证结果

最终窄范围验证全部退出码 `0`：

```text
ozon sync service tests passed
account store isolation smoke passed
module boundary guards passed（1/1）
store data isolation contract ok
test inventory ok: 71 active, 9 historical/manual
node --check server/ozon-sync-service.mjs 通过
node --check server/tests/ozon-sync-service.test.mjs 通过
node --check server/index.mjs 通过
node --check scripts/check-store-data-isolation.mjs 通过
git diff --check -- server/index.mjs 通过
```

完整 active suite：

```text
tests 97
pass 91
fail 6
cancelled 0
skipped 0
todo 0
```

6 项失败仍全部是本机 PostgreSQL `127.0.0.1:5432` 不可连接导致的基线 `ECONNREFUSED`：

1. `server/tests/account-deletion-postgres.integration.mjs`
2. `server/tests/collection-pipeline-v4.integration.mjs`
3. `server/tests/collector-desktop.integration.mjs`
4. `server/tests/listing-pipeline-v3.integration.mjs`
5. `server/tests/pricing-config.integration.mjs`
6. `server/tests/pricing-fx.integration.mjs`

没有新增失败；Task 3 和 Task 4 已分别增加 active test 文件，因此当前总数高于 Task 2 的 `95/89/6`，失败集合和数量不变。

## 自审

- scoped before/current diff 显示入口只删除商品 helper、删除旧 PRODUCTS 分支并在旧 report 创建前增加服务委托。
- service 只引入当前 PRODUCTS 实际使用的账号边界、审计、HTTP client 和缓存作用域依赖。
- 成功提交按 `cacheItemMatchesStore` 删除/替换目标店铺行，其他店铺行来自最新持久化 state，不来自过期工作副本。
- 测试凭据均为显式假值；代码、错误、日志和报告未包含真实 client ID/API key。
- 所有 Ozon 请求均由 `globalThis.fetch` stub 截获并在 `finally` 恢复。
- 未迁移非 PRODUCTS 同步，也未改变路由响应字段。

## Concerns 与回滚

1. 按边界决议，本 Task 只做一次 load/save 的最小原子提交；`LOCAL_STATE_VERSION_CONFLICT` 重试和提交前最终店铺归属复核留 Task 7。当前发生持久化冲突时会进入 FAILED report 路径，不会自动重试商品提交。
2. 商品、FBO、FBS 分页仍保留原有安全上限（商品每种 visibility 20 页、FBS 每批 50 页、FBO offset 上限 100000）；本 Task 未改变这些既有业务限制。
3. 完整套件仍有 6 个 PostgreSQL `ECONNREFUSED` 基线失败，未启动或修改数据库。
4. 未执行真实 Ozon 或生产数据验证；所有外部读取都是受控 fetch stub。
5. 回滚应恢复 Task 5 的三个 before snapshots，并将静态 verifier 的商品同步断言恢复为原目标；dirty worktree 下必须按窄范围手工回滚，不能使用整库 reset 或 checkout。
