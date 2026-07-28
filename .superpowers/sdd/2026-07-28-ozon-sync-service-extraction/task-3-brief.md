### Task 3: 统一 Ozon GET/POST HTTP 客户端

**Files:**
- Create: `server/tests/ozon-client.test.mjs`
- Modify: `server/ozon-client.mjs`
- Modify: `server/index.mjs:135,1472-1595` 以及剩余 `ozonCall` 调用点

**Interfaces:**
- Consumes: `store.clientId`、`store.apiKey`、API path、可选 body 和 timeout。
- Produces:
  - 保持 `callOzonSellerApi(store, apiPath, body, timeoutMs = 60000)`
  - 新增 `getOzonSellerApi(store, apiPath, timeoutMs = 60000)`
  - 错误字段：`status`、`code`、`body`、`cause`

- [ ] **Step 1: 写 HTTP contract 测试**

Create `server/tests/ozon-client.test.mjs`。测试保存并恢复原 `globalThis.fetch`，每个场景使用独立响应桩：

```js
import assert from "node:assert/strict";
import { callOzonSellerApi, getOzonSellerApi } from "../ozon-client.mjs";

const originalFetch = globalThis.fetch;
const store = { clientId: "client-1", apiKey: "secret-1" };

try {
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{"result":{"ok":true}}' };
  };
  assert.deepEqual(await callOzonSellerApi(store, "/v1/post", { value: 1 }), { result: { ok: true } });
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["Client-Id"], "client-1");
  assert.equal(captured.options.headers["Api-Key"], "secret-1");
  assert.equal(captured.options.body, '{"value":1}');

  await getOzonSellerApi(store, "/v1/get");
  assert.equal(captured.options.method, "GET");
  assert.equal("body" in captured.options, false);

  await assert.rejects(
    () => callOzonSellerApi({}, "/v1/post", {}),
    (error) => error.status === 400 && error.code === "OZON_CREDENTIALS_MISSING",
  );

  globalThis.fetch = async () => {
    throw Object.assign(new Error("offline"), { code: "ENETDOWN" });
  };
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get"),
    (error) => error.status === 502 && error.code === "ENETDOWN" && error.body.network === true,
  );

  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  });
  await assert.rejects(
    () => callOzonSellerApi(store, "/v1/post", {}),
    (error) => error.status === 429 && error.code === "OZON_HTTP_429" && error.body.raw === "rate limited",
  );

  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    () => getOzonSellerApi(store, "/v1/get", 5),
    (error) => error.status === 504 && error.code === "OZON_TIMEOUT",
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ozon client tests passed");
```

再增加“`response.text()` 抛错”断言，要求 `status === 502` 且 `body.phase === "读取响应"`。

- [ ] **Step 2: 运行测试并确认 GET 导出缺失**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
```

Expected: FAIL，指出 `getOzonSellerApi` 未导出。

- [ ] **Step 3: 抽取一个私有请求内核**

Modify `server/ozon-client.mjs`:

```js
async function requestOzonSellerApi(store, apiPath, {
  method,
  body,
  timeoutMs = 60000,
}) {
  // 统一执行凭据校验、AbortController、fetch、响应读取、JSON 解析和错误标准化。
}

export function callOzonSellerApi(store, apiPath, body, timeoutMs = 60000) {
  return requestOzonSellerApi(store, apiPath, { method: "POST", body: body || {}, timeoutMs });
}

export function getOzonSellerApi(store, apiPath, timeoutMs = 60000) {
  return requestOzonSellerApi(store, apiPath, { method: "GET", timeoutMs });
}
```

GET 不发送 body 和 `Content-Type`；POST 保持现有 JSON body。错误响应摘要最多保留 600 字符，不记录凭据。

- [ ] **Step 4: 删除入口中的重复客户端**

Modify `server/index.mjs`:

```js
import { callOzonSellerApi } from "./ozon-client.mjs";
```

删除 `OZON_API_BASE`、`networkErrorDetail`、`ozonNetworkError`、`ozonCall` 和 `ozonGet`。将仍留在入口的类目、属性、导入状态查询调用从 `ozonCall(...)` 改成 `callOzonSellerApi(...)`。本轮同步逻辑迁移后，入口不应再需要 GET 客户端。

- [ ] **Step 5: 运行客户端和上架工作进程相关测试**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/external-write-safety.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/collect-listing-submit-failure.test.mjs
```

Expected: 全部通过；上架工作进程继续使用原 `callOzonSellerApi` contract。
