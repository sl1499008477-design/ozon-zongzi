### Task 7: 完成同步报告状态闭环、冲突重试和最终归属复核

**Files:**
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/index.mjs:2964-3145`

**Interfaces:**
- Consumes: `LOCAL_STATE_VERSION_CONFLICT`、最新状态中的店铺归属、同步类型和任务元数据。
- Produces: `RUNNING → SUCCESS` 或 `RUNNING → FAILED` 的报告、审计事件和原子缓存提交。

- [ ] **Step 1: 写状态冲突有限重试测试**

令 `saveState` 前两次抛：

```js
Object.assign(new Error("conflict"), { code: "LOCAL_STATE_VERSION_CONFLICT" })
```

第三次成功。断言最终 `SUCCESS` 且保存尝试次数为 3。再令连续四次冲突，断言失败并停止重试。

- [ ] **Step 2: 写同步期间店铺删除和转移测试**

Ozon 拉取完成前替换 `loadState()` 返回值：

```js
persisted.stores = persisted.stores.filter((store) => store.id !== "store_a");
```

以及：

```js
persisted.stores.find((store) => store.id === "store_a").ownerAccountId = "acct_b";
```

两种情况都断言 `error.status === 409`、旧缓存未变、最终报告为 FAILED。

- [ ] **Step 3: 写不支持类型和失败报告保存降级测试**

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

- [ ] **Step 4: 运行测试并确认闭环边界尚未全部通过**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: FAIL 于冲突重试、409 或 FAILED 报告断言之一。

- [ ] **Step 5: 迁移并收紧报告提交逻辑**

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

- [ ] **Step 6: 运行服务全部测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

Expected: 输出 `ozon sync service tests passed`。
