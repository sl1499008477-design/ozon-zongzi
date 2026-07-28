# Final Review Fix Report

## Status and scope

- State: 完成
- Target: `/Users/songliang/Documents/sonli ozon3.0`
- Branch / baseline commit: `main` / `d4ed427`
- Risk: R1/R2 本地可逆的安全边界和同步分页修复
- Production files changed:
  - `server/ozon-client.mjs`
  - `server/ozon-sync-service.mjs`
- Test files changed:
  - `server/tests/ozon-client.test.mjs`
  - `server/tests/ozon-sync-service.test.mjs`
  - `server/tests/store-cache-scope.test.mjs`
- Entry route、数据库、迁移、配置、依赖和 public route contract：未修改
- External effects: 无。所有 Ozon 行为使用 `globalThis.fetch` stub；没有真实网络或数据库/container 操作
- Git effects: 无 commit、stage、push、stash 或 branch 操作

## Fix 1 — non-2xx sanitization

### RED 1: raw HTTP response exposure

先修改 client 测试，使 text non-2xx 仅接受稳定 message 和 allowlisted body。

执行：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  server/tests/ozon-client.test.mjs
```

失败：

```text
Actual:   Ozon 429: rate limited
Expected: Ozon API 请求失败：/v1/post（HTTP 429，OZON_HTTP_429）
```

这证明 raw response text 仍进入 `Error.message`。

同一 RED 测试集加入 JSON non-2xx payload，内容包含：

- configured `clientId`
- configured `apiKey`
- email
- nested sensitive payload
- 一个合规 Ozon machine code

断言 error `message`、序列化 `body` 和 `cause` 均不含这些敏感值。

### GREEN 1: allowlisted HTTP error

non-2xx error 现在只保留：

| Field | Rule |
|---|---|
| `apiPath` | internal requested Seller API path |
| `status` | numeric HTTP status |
| `code` | stable `OZON_HTTP_<status>` internal code |
| `responseFormat` | exactly `json`, `text`, or `empty` |
| `ozonCode` | optional; maximum 80 characters and only `[A-Za-z0-9_.-]` |

明确不保留：

- raw response text
- arbitrary parsed response object
- nested payload fields
- platform message/detail
- email or other business payload

初轮修复的 message 固定为：

```text
Ozon API 请求失败：<apiPath>（HTTP <status>，<internal code>）
```

后续 regression round 为兼容既有 `/Ozon 404/` route contract，将安全格式调整为：

```text
Ozon <status>: <apiPath> (<internal code>)
```

两种格式都只依赖 API path、HTTP status 和 stable internal code；最终实现使用第二种。HTTP non-2xx `cause` 固定为 `null`。

测试覆盖：

- text format 429
- JSON format 403
- allowlisted machine code `ACCESS.DENIED-1`
- exact body keys
- credentials、email 和 nested payload 不出现在 message/body/cause

### RED 2: credential-shaped machine code

安全自审后新增一个更窄的 RED：Ozon JSON `code` 直接等于 configured test API key。

失败：

```text
actual error.body.ozonCode: "secret-1"
expected: ozonCode omitted
```

### GREEN 2: machine-code credential filtering

Machine code 在字符 allowlist 前先经过 configured `clientId` / `apiKey` redaction。命中 credential 后会包含 `[REDACTED]`，无法通过 machine-code 字符 allowlist，因此 `ozonCode` 被省略。

### Service persistence and audit

新增 service-level 403 测试：

- `/v2/warehouse/list` 返回包含 `client_a`、`key_a`、email 和 nested payload 的 JSON。
- 抛出的 error 使用稳定安全 message。
- `jobs[jobId].error` 只保存稳定 message。
- FAILED terminal audit metadata 同样只包含稳定 message。
- 序列化 job + audit 不包含任何敏感测试值。

不需要额外 service formatter，因为 client error contract 已在 transport 边界完成收敛。

## Fix 2 — cache helper coverage

### RED / characterization gate

该项是 final review 明确标记的“未覆盖既有行为”，不是已知生产 defect。测试先行加入后直接通过，因此没有人为制造失败，也没有修改生产 helper。

新增断言：

- client-ID fallback 匹配为 `true`
- store-name fallback 对大小写和两侧空白归一化
- item 有显式不匹配 `storeId` 时，即使 client ID 和 store name 匹配也返回 `false`
- `upsertCacheItemByStore`：
  - insert 返回 `true`
  - update 返回 `false`
- `upsertProductByStore`：
  - insert 返回 `true`
  - update 返回 `false`

### GREEN

执行结果：

```text
store cache scope tests passed
```

结论：现有 helper 行为符合 contract；`server/store-cache-scope.mjs` 未修改。

## Fix 3 — repeated FBO `last_id`

### RED

新增 POSTINGS 测试：

- FBS 返回空终页。
- FBO 第一页返回 row + `last_id: "repeated_token"`。
- FBO 第二页返回另一 row + 相同 non-empty `last_id`。
- 期望 `502 / OZON_PAGINATION_STALLED`。
- 期望只发送两次 FBO 请求。
- 期望 old target-store posting cache 保持不变。
- 期望 job 最终为 FAILED。

首次运行失败：

```text
AssertionError: Missing expected rejection.
```

旧实现继续读取重复 token，直到 50-page cap 后把任务当作成功。

### GREEN

每次 FBO response 到达后：

1. 先读取 `nextFboLastId`。
2. 在读取和应用该页 postings rows 之前，与本次 request 使用的 `fboLastId` 比较。
3. 若相同且 non-empty，立即抛：

```text
status: 502
code: OZON_PAGINATION_STALLED
message: Ozon FBO 分页游标未推进
```

验证：

- FBO request count: exactly 2
- stalled second-page row 未应用
- 第 1 页只存在 working copy；由于任务失败，没有提交
- old target-store posting cache 保持不变
- foreign-store cache 保持隔离
- job 关闭为 FAILED
- 现有 FBS range-split regression 继续通过

## Validation

最终执行：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  server/tests/ozon-client.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  server/tests/store-cache-scope.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  server/tests/ozon-sync-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --check server/ozon-client.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --check server/ozon-sync-service.mjs
git diff --check
```

结果：

```text
ozon client tests passed
store cache scope tests passed
ozon sync service tests passed
```

- 两项 syntax checks exit 0。
- `git diff --check` exit 0。
- 五个目标文件当前为 untracked，因此另逐个执行：

```bash
git diff --no-index --check /dev/null <target-file>
```

每项只有表示“文件有差异”的预期 exit 1，output 为空，即没有 whitespace error。

## Self-review

- Important 的 raw non-2xx payload persistence path 已关闭。
- 两个 Minor 均完成：cache helper contract 有直接覆盖；FBO repeated token fail-fast。
- HTTP error body 不引用 raw response text 或 parsed object。
- Optional `ozonCode` 有长度、字符集和 configured credential 三重边界。
- Service report 和 terminal audit 使用同一稳定 safe error message。
- Stalled FBO page 在任何 row/context/cache mutation 前被拒绝。
- POSTINGS 失败仍通过 working-copy + terminal FAILED 闭环保持原子性。
- FBS split、冲突重试、final ownership recheck、same-identity concurrent merge 等既有 service tests 全部通过。
- `server/store-cache-scope.mjs`、`server/index.mjs`、数据库、配置、依赖均未修改。
- 未发现本次 scope 内的新增 secret、日志泄露或真实外部副作用。

## Concerns and unverified

- 未运行完整 `scripts/verify.mjs`；final fix brief 只要求三项定向测试与两项 syntax check。
- PostgreSQL success paths 仍受已知 DB-offline 基线限制，本次没有连接或改变数据库。
- 未连接真实 Ozon；这是明确安全约束。
- Network/timeout error contract 保持原行为，本次收紧仅针对 HTTP non-2xx。
- Vite build 和 extension parity 未在本 fix 中重跑；Task 9 已记录此前结果。

## Rollback

- 只反向恢复上述两个 production hunks和三份测试 hunks。
- 不使用 `git reset --hard`，不删除整个 untracked module，也不影响用户其他 dirty changes。
- 无数据库、配置、依赖或外部状态需要恢复。

## Regression round: import-status stable message

### RED

最终验证发现既有：

```text
server/tests/import-status-route.test.mjs:201
```

依赖稳定错误摘要匹配：

```regex
/task not found|Ozon 404/
```

直接运行未修改的现有测试：

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  server/tests/import-status-route.test.mjs
```

失败：

```text
Expected regex: /task not found|Ozon 404/
Actual: Ozon API 请求失败：/v1/product/import/info（HTTP 404，OZON_HTTP_404）
```

根因是初轮安全格式没有连续的 `Ozon 404`，不是 allowlisted body 或脱敏失效。

### GREEN

最小兼容修复把 non-2xx stable message 改为：

```text
Ozon <status>: <apiPath> (<code>)
```

404 示例：

```text
Ozon 404: /v1/product/import/info (OZON_HTTP_404)
```

该格式：

- 恢复既有 `/Ozon 404/` contract。
- 只包含 HTTP status、内部 API path 和 stable internal code。
- 不包含 raw response text、Ozon message、nested payload、email 或 credentials。
- 不改变 sanitized `error.body` allowlist、`cause: null` 或 service job/audit 脱敏。

同步更新 client 和 service 的精确 message 断言，没有修改既有 import-status test。

按要求顺序验证：

```text
import status route smoke passed
ozon client tests passed
ozon sync service tests passed
```

另外：

- `node --check server/ozon-client.mjs`: passed
- `node --check server/tests/ozon-client.test.mjs`: passed
- `node --check server/tests/ozon-sync-service.test.mjs`: passed
- 本 regression round 只修改 client 和两份精确 message 测试；报告之外没有其他文件变更
