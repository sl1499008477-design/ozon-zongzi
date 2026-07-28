### Spec Compliance

- ❌ Issues found: 统一 GET/POST 内核、GET 无 body/`Content-Type`、POST 签名兼容、入口重复实现删除、调用点 payload/timeout 保持等主体要求已落实，但真实 Node `DOMException` 超时会返回错误的 `code`，且网络错误未对已知店铺凭据做脱敏，未满足稳定错误 contract 和“不记录凭据”要求（`server/ozon-client.mjs:7-25`）。
- ✅ 可从 scoped diff 验证：`callOzonSellerApi` 保持原四参数签名，`getOzonSellerApi` 已新增，二者共用私有 request 内核（`server/ozon-client.mjs:38-96`）。
- ✅ 可从 scoped diff 验证：GET 只发送认证 headers，不携带 body 或 `Content-Type`；POST 保持 JSON body 和 `Content-Type`（`server/ozon-client.mjs:51-60`）。
- ✅ 可从 scoped diff 验证：入口所有原 `ozonCall`/`ozonGet` 调用仅替换函数名，payload 与 timeout 未变化；promotion 的 `/v1/actions` 仍为 GET（`server/index.mjs:1449-1592`、`server/index.mjs:1888-1890`、`server/index.mjs:2495-2761`、`server/index.mjs:5830-5832`）。
- ✅ 可从 scoped diff 验证：入口内 `OZON_API_BASE`、`networkErrorDetail`、`ozonNetworkError`、`ozonCall`、`ozonGet` 的重复实现已删除；入口只导入共享客户端（`server/index.mjs:9`）。
- ✅ 可从 focused consumer check 验证：`listing-worker.mjs` 仍按原 POST contract 传递 `{ items } / 120000`、`{ stocks } / 60000` 和 import-info payload / `60000`（`server/listing-worker.mjs:98`、`server/listing-worker.mjs:145`、`server/listing-worker.mjs:193-195`）。

### Strengths

- 私有 `requestOzonSellerApi` 集中处理凭据校验、定时取消、fetch、响应读取/解析和错误标准化，职责边界清晰，没有把入口业务状态带入客户端（`server/ozon-client.mjs:38-89`）。
- 非 JSON 响应和 HTTP 错误消息使用 600 字符上限，避免无界文本进入摘要；定时器在 `finally` 中可靠清理（`server/ozon-client.mjs:71-88`）。
- 新测试直接替换并恢复真实全局 `fetch`，覆盖 POST、GET、缺凭据、网络、HTTP、超时和响应读取阶段；GET 的无 body/无 `Content-Type` 断言明确（`server/tests/ozon-client.test.mjs:4-70`）。
- before/current index 比较显示消费者变更为机械替换，没有混入 route、payload、timeout 或同步业务逻辑变化。

### Issues

#### Critical (Must Fix)

- 无。

#### Important (Should Fix)

1. `server/ozon-client.mjs:8-17` — 真实 Node `AbortController.abort()` 产生的 `DOMException` 名称是 `AbortError`，同时自带数值 `code === 20`。当前代码先读取 `error.code`，再用它覆盖超时 fallback，因此实际结果是 `status=504` 但 `code="20"`、`body.code="20"`，违反要求的稳定 `OZON_TIMEOUT` contract。现有测试用的是手工构造、没有 DOMException 数值 code 的普通 `Error`，所以掩盖了该缺陷（`server/tests/ozon-client.test.mjs:47-53`）。应在 `aborted` 为真时无条件令标准化 code 为 `OZON_TIMEOUT`，并补一个使用 `signal.reason` 或 `new DOMException(..., "AbortError")` 的回归测试。

2. `server/ozon-client.mjs:9-25` — 网络错误标准化把原始 `error.message` 原样写进新错误消息和 `body.detail`，并把原错误作为 `cause` 暴露，完全没有使用 `store.clientId`/`store.apiKey` 做脱敏。focused check 让 fetch 抛出包含测试凭据的消息后，`message`、`body.detail`、`cause.message` 均保留了 `client-1` 和 `secret-1`；这些字段会被上层错误处理、日志或任务状态持久化消费，违反“不记录凭据”。应对所有向外暴露的文本和 cause 做已知凭据替换/最小化，仅保留安全的错误 name/code；并新增断言确保 client ID/API key 不出现在 error message、body 或 cause 中。

#### Minor (Nice to Have)

- 无。

### Focused Checks

- ✅ 未重复实现者套件；仅针对代码审读发现的真实 DOMException 风险运行无网络聚焦桩。实际输出：`sourceName="AbortError"`、`sourceCode=20`、`status=504`、`code="20"`、`bodyCode="20"`。
- ❌ 同一无网络聚焦桩确认凭据脱敏缺失：包装后的 `message`、`body.detail` 和 `cause.message` 均含测试 client ID/API key。
- ✅ `rg` 聚焦检查只在 `server/index.mjs` 发现共享客户端导入/调用，没有遗留重复 helper；`server/listing-worker.mjs` 的三个原 contract 调用仍在。

### Assessment

**Task quality:** Needs fixes

**Reasoning:** 主体拆分和消费者兼容处理干净，但真实 Node 超时错误 code 不稳定，且错误路径可把店铺凭据透传到消息、body 和 cause；这两项均属于必须修复后才能信任的错误处理与安全 contract 缺陷。
