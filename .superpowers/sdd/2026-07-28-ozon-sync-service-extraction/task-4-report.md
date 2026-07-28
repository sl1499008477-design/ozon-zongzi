# Task 4 报告：建立同步服务并迁移店铺资料

## Status

`DONE_WITH_CONCERNS`

已在 dirty `main` 原地完成 R2 兼容的店铺资料同步服务提取。现有 HTTP 路由 contract 保持不变；账号/店铺目标由服务通过 `storesForAccount(state, accountId)` 限定，指定其他账号的店铺统一返回 404。未执行真实 Ozon 请求、数据库写入、依赖或配置变更，也未执行 commit、stage、push、stash 或分支切换。

## 文件与 Contract

- 新增 `server/ozon-sync-service.mjs`
  - 导出 `createOzonSyncService({ loadState, saveState, now, createJobId, logger })`。
  - 返回 `syncStoreProfile`、`refreshStoreProfiles` 和显式未支持的 `runLocalSync`。
  - 迁移卖家资料解析与映射；资料同步时间统一使用注入的 `now()`。
  - `refreshStoreProfiles` 只从账号所属店铺中选取目标，并在处理完成后调用注入的 `saveState`。
  - `runLocalSync` 当前返回 `501 / OZON_SYNC_UNSUPPORTED`，避免在 Task 4 提前迁移商品、订单、仓库和促销同步。
- 新增 `server/tests/ozon-sync-service.test.mjs`
  - 使用内存 state、固定时间和 fetch stub。
  - 覆盖 POST `/v1/seller/info`、公司/法定名称/INN/Premium 映射、固定同步时间、持久化、跨账号负向路径和未支持同步边界。
- 修改 `server/index.mjs`
  - 创建共享服务实例。
  - 删除入口中的资料解析、`syncStoreProfile` 和 `refreshStoreProfiles` 本地实现。
  - 将现有 5 个资料同步调用点接到服务；`/local/stores/refresh-profile` 的外部响应结构保持不变。
  - 原 `runLocalSync` 仍留在入口中，未提前迁移产品、订单、仓库或促销同步。

## RED / GREEN 证据

RED：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-sync-service.test.mjs
```

退出码 `1`，错误符合预期：`ERR_MODULE_NOT_FOUND`，目标模块 `server/ozon-sync-service.mjs` 尚不存在。

GREEN：

```text
ozon sync service tests passed
```

测试中的 Ozon 调用完全由 `globalThis.fetch` stub 截获，并通过 `try/finally` 恢复；没有真实外部请求。

## 边界验证

完成前重新运行以下验证，均退出码 `0`：

```text
ozon sync service tests passed
account store isolation smoke passed
module boundary guards passed
store data isolation contract ok
node --check server/ozon-sync-service.mjs 通过
node --check server/tests/ozon-sync-service.test.mjs 通过
node --check server/index.mjs 通过
git diff --check -- server/index.mjs 无输出
```

## 自审

- `refreshStoreProfiles` 不先全局查找店铺，而是先建立账号所属店铺集合，因此跨账号请求的 404 不泄露目标是否真实存在。
- 跨账号负向测试同时断言没有新增 Ozon 请求，避免越权请求产生外部读副作用。
- 注入的固定 `now()` 同时控制 `profileSyncedAt` 和 `updatedAt`，核心映射可重复验证。
- seller info 的请求方法、路径、headers 和 payload 继续由 Task 3 的共享 Ozon client contract 提供。
- Task 4 before/current 快照比较显示 `server/index.mjs` 只有工厂导入/实例化、旧资料同步代码删除和 5 处消费者接线；没有吸收工作区既有修改。
- 业务代码只触碰 brief 允许的 `server/ozon-sync-service.mjs`、`server/tests/ozon-sync-service.test.mjs`、`server/index.mjs`；本文件仅为要求的 handoff artifact。

## Concerns 与回滚

1. `runLocalSync` 按 Task 4 范围仍是显式 501 stub；入口继续使用旧 `runLocalSync`，完整同步迁移需由后续任务完成。
2. 工厂签名中的 `loadState`、`createJobId` 和 `logger` 按稳定 contract 保留，当前资料同步阶段尚未使用；没有为这些参数添加 no-op 引用。
3. 未运行完整 `scripts/verify.mjs`；本轮按 brief 运行资料同步测试及账号、模块、店铺数据边界直接回归。完整套件的 PostgreSQL `ECONNREFUSED` 既有基线未在本 Task 重跑。
4. 回滚时只应恢复 Task 4 before 快照中的 `server/index.mjs` 窄范围差异，并移除新增服务与测试。由于工作区已有大量用户改动，不能使用整库 reset 或 checkout。

## Fix Round 1：移除未来依赖与 no-op

独立审查指出，初版按原 brief 预导入了尚未用于店铺资料同步的服务协作者，并以 11 个 `void` no-op 消除未使用提示，违反 KISS/YAGNI。按修正后的计划，仅保留当前实际需要的 `crypto`、`storesForAccount` 和 `callOzonSellerApi` imports，移除 `activeStore`、`appendAuditEvent`、`getOzonSellerApi`、五个 cache helper imports 以及全部 `void ...`。工厂参数 contract 保持不变，运行行为没有改变。

Fix round 验证全部退出码 `0`：

```text
ozon sync service tests passed
node --check server/ozon-sync-service.mjs 通过
node --check server/index.mjs 通过
git diff --check -- server/ozon-sync-service.mjs server/index.mjs 无输出
```
