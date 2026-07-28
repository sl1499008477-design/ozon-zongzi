# Task 8 报告：入口接线和模块边界

## Status

完成。将 `/local/sync/:type` 的入口调用直接接入既有 `ozonSyncService` 对象 contract，删除入口内残留的 `runLocalSync` wrapper，并将模块边界门禁收紧到同步函数不得定义在入口且入口不超过 5400 行。

## 范围与风险

- 目标路径：`/Users/songliang/Documents/sonli ozon3.0`
- 风险：R2（兼容的共享入口接线）；任务 brief 已明确批准。
- 修改：`server/index.mjs`、`server/tests/module-boundaries.test.mjs`。
- 报告：本文件。
- 未改：数据库、迁移、配置、依赖、锁文件、Ozon client、同步 service、前端或扩展。
- 外部副作用：无。未运行服务、未调用真实 Ozon、未访问数据库，也未提交、暂存、推送、stash 或切换分支。
- 工作区：`main` 在开始前已有大量无关 dirty changes；本任务未清理、覆盖或归并它们。

## RED / GREEN

### RED

先修改 `server/tests/module-boundaries.test.mjs`：

- 入口上限由 6200 收紧为 5400；
- 新增 9 个禁止保留在 `server/index.mjs` 的函数名：`ozonCall`、`ozonGet`、`syncStoreProfile`、`refreshStoreProfiles`、`syncProducts`、`syncPostings`、`syncWarehouses`、`syncPromotions`、`runLocalSync`。

执行：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/module-boundaries.test.mjs
```

预期 RED 实际出现：

```text
AssertionError: runLocalSync must remain outside server/index.mjs
```

说明新门禁准确捕获了仍在入口内的 wrapper，而非测试配置错误。

### GREEN

- 删除 `server/index.mjs` 中的 `runLocalSync(state, type, storeId, options)` wrapper。
- `/local/sync/:type` 在认证后直接调用 `ozonSyncService.runLocalSync(state, {...})`。
- 路由只传稳定白名单字段：`accountId`、`storeId`、`type`、`jobId`、`deviceId`、`source`、`postingsSinceDays`；没有向 service 透传 `...body`。
- 店铺绑定、切换、资料刷新与 PATCH 的既有 service profile 接线保持：3 处 `syncStoreProfile`、1 处 `refreshStoreProfiles`；本地同步为第 5 个 service 调用点。

## Contract 与模块边界

- `POST /local/sync/:type` 的已有响应保持 `{ ok: true, job, state }`。
- `accountId` 始终来自服务端 `requireAuth` 得到的 `account.id`，店铺仍以该账号的当前店铺为 fallback。
- `deviceId` 与 `source` 的扩展/网页判定保持原逻辑。
- 唯一 Ozon HTTP 基址仍在 `server/ozon-client.mjs`；九个同步函数定义只在 `server/ozon-sync-service.mjs`。
- 最终入口行数：**5380**，满足不高于 5400 的门禁。

## 验证

全部使用：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
```

结果均为退出码 `0`：

```text
server/tests/module-boundaries.test.mjs       module boundary guards passed
server/tests/account-store-isolation.test.mjs account store isolation smoke passed
server/tests/sync-lease-isolation.test.mjs   sync lease account/device isolation test passed
scripts/check-store-data-isolation.mjs       store data isolation contract ok
server/tests/ozon-sync-service.test.mjs      ozon sync service tests passed
--check server/index.mjs                      通过
--check server/tests/module-boundaries.test.mjs 通过
git diff --check -- server/index.mjs server/tests/module-boundaries.test.mjs 通过
```

额外静态检查确认：

- `rg` 未在 `server/index.mjs` 找到九个禁止函数定义；
- `OZON_API_BASE` 仅出现在 `server/ozon-client.mjs`；
- 服务调用点仍为 3 个资料同步、1 个资料刷新和 1 个直接本地同步路由调用；
- 路由处不存在 `...body` 透传。

## 自审、未验证范围与回滚

- 仅删除 wrapper 与替换单一路由调用，没有改变 service 的四种同步、报告状态机、审计、缓存或权限实现。
- 未运行完整仓库测试套件；未覆盖与该入口无直接依赖的前端、扩展、数据库/集成流程。现有定向服务、账号边界、租约和缓存隔离检查已覆盖本次接线的主要回归风险。
- 回滚为：只恢复 `server/index.mjs` 的 wrapper 与原 route 调用形态，并恢复 `server/tests/module-boundaries.test.mjs` 的旧门禁；在 dirty worktree 中应按这些精确 hunks 手工反向应用，不能使用整库 reset 或 checkout。
