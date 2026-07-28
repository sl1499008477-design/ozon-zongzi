# Task 6 报告：迁移订单、仓库和促销同步

## Status

`DONE_WITH_CONCERNS`

已在 dirty `main` 原地完成 POSTINGS、WAREHOUSES、PROMOTIONS 同步迁移。`runLocalSync` 现由服务统一支持四种类型，旧 `/local/sync/:type` 路由和响应 contract 保持不变。未执行真实 Ozon 请求、数据库操作、配置或依赖变更，也未执行 commit、stage、push、stash 或分支切换。

## 文件与 Contract

- `server/ozon-sync-service.mjs`
  - 迁入 `syncPostings`、`syncWarehouses` 和 `syncPromotions`。
  - POSTINGS 使用注入的 `now()` 建立固定窗口，保留 28 天批次、FBS cursor 和 FBO last_id 分页。
- `PERIOD_IS_TOO_LONG` 时丢弃当前区间的局部分页结果，递归读取前后两个半区间；每个子区间的 cursor 始终与自己的 `since/to` 绑定。
  - FBO 错误不再吞掉或只写日志，而是进入统一 FAILED 路径。
  - 仓库继续 POST `/v2/warehouse/list`；促销继续 GET `/v1/actions`。
  - 四种类型由统一 dispatch 执行，并由 `commitLocalSyncResult` 只提交目标 cache 类型和目标店铺行。
- `server/tests/ozon-sync-service.test.mjs`
  - 新增固定订单窗口、FBS/FBO 合并、超长周期缩短、FBO 失败原子性、仓库 POST、促销 GET 和跨店铺缓存保护测试。
  - 仓库场景让 profile 请求失败，验证资料刷新仍为 best-effort，目标仓库同步继续成功。
- `server/index.mjs`
  - 删除旧 `syncPostings`、`syncWarehouses`、`syncPromotions`。
  - 删除随旧状态机失去消费者的 `appendSyncReport`、`persistSyncReport` 和旧 `commitLocalSyncResult`。
  - 移除入口不再需要的 `getOzonSellerApi` import。
  - 旧 `runLocalSync` 只规范化参数并立即委托 `ozonSyncService.runLocalSync`，没有引用已删除 helper 的死分支。

## RED / GREEN

RED：先扩展 fetch-stub 测试，再运行：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

退出码 `1`，首个 POSTINGS 场景按预期失败：

```text
Error: Ozon 本地同步尚未迁移到服务
status: 501
code: OZON_SYNC_UNSUPPORTED
```

迁移三种实现、统一 dispatch/commit 并完成入口委托后，GREEN：

```text
ozon sync service tests passed
```

所有 Ozon 请求均被 `globalThis.fetch` stub 截获，并在测试的 `finally` 中恢复；没有真实外部请求。

## Atomicity

- `runLocalSync` 先持久化 RUNNING report，再在 `structuredClone(state)` 工作副本中执行 profile 和目标类型同步。
- profile 失败只在工作副本记录 `profileSyncError`，不阻止目标类型同步。
- FBS、FBO、仓库或促销的必需请求错误不会被吞；只有 `PERIOD_IS_TOO_LONG` 按明确规则拆为前后两个子区间。
- 单个 FBS 区间的所有 cursor 页先进入局部数组，整个区间完成后才合并进工作副本；若分页中途触发拆分，先前局部页会被丢弃，避免重复计数和半范围提交。
- SUCCESS 路径重新加载最新 state，只替换目标 cache 类型中的目标店铺片段，并保留其他店铺行。
- POSTINGS 工作副本保留原目标店铺历史行并合并本轮窗口结果；仓库和促销先在工作副本完整替换目标店铺旧行。
- FBS 成功写入工作副本而 FBO 抛出 `EFBO` 时，不调用 success commit；持久化 postings 仍只有 `old_posting`，不会出现 `partial_fbs`，job 终态为 FAILED。

## Index Delegation

入口适配器只保留现有调用 contract：

```js
async function runLocalSync(state, type, storeId, options = {}) {
  const accountId = options.accountId || state.currentAccountId;
  const upper = String(type || "").toUpperCase();
  return ozonSyncService.runLocalSync(state, {
    accountId,
    storeId,
    type: upper,
    jobId: options.jobId || crypto.randomUUID(),
    deviceId: options.deviceId || "",
    source: options.source || "",
    postingsSinceDays: options.postingsSinceDays,
  });
}
```

入口中已无 `syncPostings`、`syncWarehouses`、`syncPromotions`、`appendSyncReport`、`persistSyncReport`、旧 `commitLocalSyncResult` 或 `getOzonSellerApi`。

## 验证

窄范围和直接消费者验证均退出码 `0`：

```text
ozon sync service tests passed
account store isolation smoke passed
module boundary guards passed
ozon client tests passed
store cache scope tests passed
external write safety test passed
store data isolation contract ok
test inventory ok: 71 active, 9 historical/manual
node --check server/ozon-sync-service.mjs 通过
node --check server/tests/ozon-sync-service.test.mjs 通过
node --check server/index.mjs 通过
git diff --check -- server/index.mjs 无输出
```

## 自审

- 固定 `now()` 产生 `2026-07-28T08:00:00.000Z` 的订单 `filter.to`；28 天区间的重试中点为 `2026-07-14T08:00:00.000Z`。
- FBS 和 FBO 各自保留原 endpoint、payload 和最多 50 页边界；FBO 行明确标记 `shipment_type: "FBO"`。
- 仓库测试断言 POST，促销测试断言 GET；共享 Ozon client 继续负责凭据、超时和错误规范化。
- 成功报告的 `fetchedCount` 分别覆盖 FBS+FBO 总数、仓库数和促销数；FAILED 报告可追溯且不覆盖旧缓存。
- before/current 快照显示 service 只新增 Task 6 同步与通用按类型提交，测试只新增 Task 6 场景，入口只删除迁移代码/死 helper 并收窄为参数委托。
- 测试凭据均为显式假值；代码、输出和报告未包含真实 client ID、API key 或订单数据。
- 没有使用子代理；当前任务由本执行者完成并独立核对快照与验证输出。

## Concerns 与回滚

1. 按最新计划，`LOCAL_STATE_VERSION_CONFLICT` 重试及 success commit 前最终账号/店铺归属复核留给 Task 7；本 Task 保持 Task 5 的一次 load/save 最小提交。
2. FBS 区间拆分最多 8 层，区间短至 1 小时后不再拆分；仍返回 `PERIOD_IS_TOO_LONG` 时会抛出原错误并进入 FAILED，避免无限递归或伪成功。
3. 初次审查的 FBO Minor 本轮按范围决议未处理：重复的非空 `last_id` 不会立即终止，最坏会重复请求到 50 页上限并使 `fetchedCount` 失真；已登记到 ledger，等待最终 review triage。
4. 未运行可能触及本地数据库的完整 `scripts/verify.mjs`；运行了本任务和直接消费者回归。Task 5 已记录的完整套件基线仍为 97 tests / 91 pass / 6 个 PostgreSQL `ECONNREFUSED`。
5. 未执行真实 Ozon 或生产数据验证；所有外部读取都是受控 fetch stub。
6. 回滚应恢复三份 Task 6 before snapshots。dirty worktree 下必须按窄范围手工回滚，不能使用整库 reset 或 checkout。

## Fix Round 1：完整拆分 PERIOD 区间

初次审查发现 Important：完整 FBS 区间遇到 `PERIOD_IS_TOO_LONG` 后只读取前半区间，后半静默遗漏；前半返回 cursor 后，下一页又把该 cursor 与原完整区间配对。

RED：先把测试改为完整范围首次失败，前半返回两页、后半返回一页。旧实现退出码 `1`，错误明确显示 `front_page_2` 被错误配到原完整范围：

```text
unexpected FBS range/cursor:
{"cursor":"front_page_2","filter":{"since":"2026-06-30T08:00:00.000Z","to":"2026-07-28T08:00:00.000Z"}}
```

GREEN：新增固定范围分页 helper。每个范围使用不可变 `since/to` 完成自己的 cursor 队列；范围中任一页报 PERIOD 时丢弃该范围的局部数组，并依次读取 `[since, mid]` 与 `[mid, to]`。测试验证请求顺序为：

```text
[06-30, 07-28] cursor=""
[06-30, 07-14] cursor=""
[06-30, 07-14] cursor="front_page_2"
[07-14, 07-28] cursor=""
```

最终 `fetchedCount=3`，缓存同时包含 `front_half_1`、`front_half_2`、`back_half_1`。服务测试输出：

```text
ozon sync service tests passed
```

为防止 Ozon 持续返回 PERIOD 导致死循环，helper 设定最大拆分深度 8 和最小区间 1 小时；达到任一边界时抛回原错误。初审的 FBO 重复 `last_id` Minor 没有纳入本 fix round。

Fix round 验证：

```text
ozon sync service tests passed
node --check server/ozon-sync-service.mjs 通过
node --check server/tests/ozon-sync-service.test.mjs 通过
node --check server/index.mjs 通过
git diff --check -- server/index.mjs 无输出
两份 before/current --no-index whitespace check 无输出
```
