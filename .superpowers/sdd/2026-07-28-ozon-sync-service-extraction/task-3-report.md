# Task 3 报告：统一 Ozon GET/POST HTTP 客户端

## Status

`DONE_WITH_CONCERNS`

在 dirty `main` 原地完成 R2 兼容共享客户端提取。未执行真实 Ozon 请求或写入，未修改依赖、配置、数据库或 Task 2 已抽出的 `server/store-cache-scope.mjs`，也未执行 commit、stage、push、stash 或分支切换。

## 文件与 Contract

- 新增 `server/tests/ozon-client.test.mjs`：覆盖 POST、GET、缺失凭据、网络错误、429、超时与响应读取失败；通过 `try/finally` 恢复 `globalThis.fetch`。
- 修改 `server/ozon-client.mjs`：保留 `callOzonSellerApi(store, apiPath, body, timeoutMs = 60000)`；新增 `getOzonSellerApi(store, apiPath, timeoutMs = 60000)`；以私有 `requestOzonSellerApi` 统一凭据校验、AbortController、fetch、读取/解析与 `status`、`code`、`body`、`cause` 错误字段。
- 修改 `server/index.mjs`：导入共享 POST/GET client，删除入口中重复的 `OZON_API_BASE`、`networkErrorDetail`、`ozonNetworkError`、`ozonCall` 与 `ozonGet`；所有原 `ozonCall` 调用（包括类目、属性、导入状态及同步读取）均机械替换为 `callOzonSellerApi`，原 payload 和 timeout 保持不变；`/v1/actions` 保持 GET，改为 `getOzonSellerApi`。

## RED / GREEN 证据

RED：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
```

退出码 `1`，错误符合预期：`../ozon-client.mjs does not provide an export named 'getOzonSellerApi'`。

GREEN：

```text
ozon client tests passed
```

客户端测试验证 GET 没有 `body` 或 `Content-Type`，POST 保留 JSON body 与 `Client-Id`/`Api-Key` headers；网络、HTTP、超时和读取响应错误均为受控 stub，不会发起外部请求。

## 消费者回归与自审

```text
external write safety test passed
collect listing fail-closed smoke passed
node --check server/ozon-client.mjs 通过
node --check server/index.mjs 通过
node --check server/tests/ozon-client.test.mjs 通过
git diff --check -- server/index.mjs 无输出
```

- `server/listing-worker.mjs` 未修改，继续以原 POST 签名消费 `callOzonSellerApi`；两项指定上架安全回归通过。
- 入口中已无 `ozonCall`、`ozonGet`、`OZON_API_BASE`、`networkErrorDetail` 或 `ozonNetworkError`。
- Task 3 before/current 快照比较显示 `server/index.mjs` 仅删除重复 client、加入 import 并机械替换调用；未改变调用 payload 或 timeout。
- 仅触碰 brief 列出的三处业务/测试文件；本报告为任务 handoff artifact。

## Concerns 与回滚

1. 未运行完整 `scripts/verify.mjs`；本 Task 按 brief 运行客户端和两个直接消费者测试。Task 1/2 已记录的 PostgreSQL `ECONNREFUSED` 基线仍需在完整回归时单独比较。
2. `server/index.mjs` 仍保留 `/v1/actions` 的 promotion GET 调用，因此当前入口合理地导入 `getOzonSellerApi`；后续同步服务抽取完成后，入口才不再需要 GET client。
3. 回滚仅恢复 Task 3 before 快照中的 `server/index.mjs` 与 `server/ozon-client.mjs`，并移除新增测试；由于 worktree 已 dirty，必须按此任务的窄范围手工回滚，不能使用整库 reset 或 checkout。

## Fix Round 1：超时规范化与网络错误脱敏

RED：扩展 `server/tests/ozon-client.test.mjs` 后，以真实 `new DOMException("aborted", "AbortError")` 作为 fetch 失败桩。客户端测试退出码 `1`，实际错误 `status=504` 但 `code="20"`，符合本轮发现：Node 的 AbortError 数字 code 覆盖了预期的 `OZON_TIMEOUT`。

GREEN：`networkError` 现先判定 `AbortError`，固定返回 `OZON_TIMEOUT`；网络错误的 detail 和 code 按当前 store 的 `clientId`、`apiKey` 定向替换；`cause` 改为仅保留安全 `name`、`code` 与已脱敏 message 的新 Error，不再保存原始异常。新增测试桩让 error 与 cause message 都包含 `client-1`、`secret-1`，并断言 error message、序列化 body 与 cause message 均不包含原值。

Fix round 验证：

```text
ozon client tests passed
external write safety test passed
collect listing fail-closed smoke passed
node --check server/ozon-client.mjs 通过
node --check server/tests/ozon-client.test.mjs 通过
git diff --check -- server/index.mjs 无输出
```
