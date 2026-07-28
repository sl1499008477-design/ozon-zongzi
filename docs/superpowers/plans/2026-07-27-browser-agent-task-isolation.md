# Browser Agent Task Isolation Implementation Plan

> **历史文档：** 本文件保留当时的目标、路径和执行步骤，不据此推断当前完成状态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Browser Agent jobs can only be created, claimed, read, and updated by their owning account and claimed device, with safe timeout handling and closed status transitions.

**Architecture:** Keep HTTP routing in the existing server entry point, but move ownership, claim, timeout, and transition rules into a small pure policy module. Exercise the real `handle` HTTP boundary against a temporary JSON state file, then use direct policy tests for deterministic timeout behavior.

**Tech Stack:** Node.js ESM, built-in `node:assert`, built-in streams/filesystem, existing JSON persistence, Chrome extension JavaScript.

## Global Constraints

- The user-provided `AGENTS.md` is the mandatory structure, business, security/data, and delivery standard.
- Target path is `<repo>`; the user explicitly authorized modifying this previously read-only legacy directory.
- Do not connect to or call Ozon, bind a shop, publish a product, write inventory, change prices, or execute a real sync.
- Do not add dependencies, database migrations, Docker changes, or production configuration.
- Do not delete or rewrite unrelated dirty-worktree changes.
- Do not stage, commit, push, or create a branch unless the user separately requests it.
- Every changed behavior follows RED → GREEN → REFACTOR and is verified against real route behavior.
- Cross-account object access returns 404; invalid same-account state transitions return 409.
- Request bodies never control `accountId`, `createdBy`, `claimedByDeviceId`, `claimExpiresAt`, or server status.
- Claim TTL is exactly 300,000 milliseconds.
- Read-only/prepare jobs may be reclaimed after timeout; `listing.publish_draft` enters `RECONCILING` and is never blindly retried.

---

### Task 1: Capture the Current HTTP Authorization Failures

**Files:**
- Create: `server/tests/browser-agent-isolation.test.mjs`
- Read: `server/tests/account-multi-session.test.mjs`
- Read: `server/tests/account-store-isolation.test.mjs`

**Interfaces:**
- Consumes: exported `handle(req, res)` from `server/index.mjs`.
- Produces: an HTTP regression fixture with two accounts, two stores, two sessions, and JSON persistence.

- [ ] **Step 1: Add a real HTTP request helper**

Create a temporary JSON state, disable dotenv/PostgreSQL/listening before importing the server, and send requests through the real handler:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "sonli-browser-agent-isolation-"));
process.env.QH_LOCAL_DATA_DIR = dataDir;
process.env.QH_LOCAL_NO_LISTEN = "1";
process.env.QH_LOCAL_NO_DOTENV = "1";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_HOST;

async function requestJson(handle, method, pathname, body, token, storeId = "") {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = pathname;
  req.headers = { "content-type": "application/json" };
  if (token) req.headers.authorization = `Bearer ${token}`;
  if (storeId) req.headers["x-ozon-store-id"] = storeId;
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(text = "") {
      this.body = String(text || "");
    },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}
```

- [ ] **Step 2: Write the fixture with explicit ownership**

The production break caught here is “jobs or devices can exist without a server-owned account/store scope.”

```js
const fixture = {
  token: "",
  currentAccountId: "",
  sessionIssuedAt: "",
  sessions: {
    token_a: { token: "token_a", accountId: "acct_a", issuedAt: "2026-07-27T00:00:00.000Z" },
    token_b: { token: "token_b", accountId: "acct_b", issuedAt: "2026-07-27T00:00:00.000Z" },
  },
  accounts: [
    { id: "acct_a", username: "a", displayName: "A", role: "admin", status: "active" },
    { id: "acct_b", username: "b", displayName: "B", role: "user", status: "active" },
  ],
  currentStoreId: "",
  currentStoreIdsByAccount: { acct_a: "store_a", acct_b: "store_b" },
  stores: [
    { id: "store_a", ownerAccountId: "acct_a", clientId: "client_a", label: "A store" },
    { id: "store_b", ownerAccountId: "acct_b", clientId: "client_b", label: "B store" },
  ],
  currentDataCollectionStoreId: "",
  currentDataCollectionStoreIdsByAccount: {},
  dataCollectionStores: [],
  caches: {
    products: [], postings: [], warehouses: [], collectBox: [], favorites: [],
    promotions: [], returns: [], refunds: [], announcements: [],
    messageTemplates: [], messageHistory: [], productTemplates: [],
    watermarkTemplates: [], files: [],
  },
  hashes: {},
  leases: {},
  browserAgents: {},
  jobs: {},
  reports: [],
  updatedAt: "2026-07-27T00:00:00.000Z",
};

await writeFile(path.join(dataDir, "local-state.json"), JSON.stringify(fixture), "utf8");
const { handle } = await import("../index.mjs");
```

- [ ] **Step 3: Write failing account/store ownership assertions**

The production changes that must make these tests fail are: trusting body ownership, returning another account’s job, searching the global queue, and creating an unknown result job.

```js
const created = await requestJson(
  handle,
  "POST",
  "/browser-agents/collection-jobs",
  { sku: "10001", storeId: "store_a", accountId: "acct_b", status: "SUCCESS" },
  "token_a",
  "store_a",
);
assert.equal(created.status, 200);
assert.equal(created.body.accountId, "acct_a");
assert.equal(created.body.createdBy, "acct_a");
assert.equal(created.body.storeId, "store_a");
assert.equal(created.body.status, "PENDING");

const crossRead = await requestJson(
  handle,
  "GET",
  `/browser-agents/collection-jobs/${created.body.id}`,
  undefined,
  "token_b",
  "store_b",
);
assert.equal(crossRead.status, 404);

const unknownResult = await requestJson(
  handle,
  "POST",
  "/browser-agents/jobs/unknown-job/result",
  { deviceId: "device_a", result: { ok: true } },
  "token_a",
);
assert.equal(unknownResult.status, 404);
```

- [ ] **Step 4: Run the new test and verify RED**

Run:

```bash
node server/tests/browser-agent-isolation.test.mjs
```

Expected: non-zero exit because current job creation trusts global state/body fields, cross-account read returns the global job, or unknown result creates a job. Record the first behavior failure; a syntax/setup error does not count as RED.

- [ ] **Step 5: Confirm no external side effect occurred**

Run:

```bash
docker compose ps --all
git diff --check -- server/tests/browser-agent-isolation.test.mjs
```

Expected: PostgreSQL remains stopped, no Ozon request was made, and the test file has no whitespace errors.

---

### Task 2: Enforce Server-Owned Job and Device Scope

**Files:**
- Modify: `server/index.mjs:4684-4843`
- Modify: `server/tests/browser-agent-isolation.test.mjs`

**Interfaces:**
- Consumes: `requireAuth`, `storeIdForAccountRequest`, `activeStore`, and JSON state persistence.
- Produces: every Browser Agent/device/job record carries server-owned `accountId`; every created job also carries validated `storeId` and `createdBy`.

- [ ] **Step 1: Extend the failing test for device ownership**

The production break caught here is “a second account can register or heartbeat an existing device ID.”

```js
const registerA = await requestJson(
  handle,
  "POST",
  "/browser-agents/register",
  { deviceKey: "shared-key", deviceName: "A device" },
  "token_a",
);
assert.equal(registerA.status, 200);
assert.equal(registerA.body.accountId, "acct_a");

const takeover = await requestJson(
  handle,
  "POST",
  "/browser-agents/heartbeat",
  { deviceId: registerA.body.id },
  "token_b",
);
assert.equal(takeover.status, 404);
```

- [ ] **Step 2: Run the test and verify the new assertion is RED**

Run:

```bash
node server/tests/browser-agent-isolation.test.mjs
```

Expected: the takeover assertion fails because the current heartbeat route overwrites the global device record.

- [ ] **Step 3: Add minimal route ownership enforcement**

In `server/index.mjs`:

- Capture `const account = requireAuth(req, state)` on register/heartbeat/job routes.
- Write `accountId: account.id` after spreading request-controlled data.
- Reject a pre-existing device owned by another account with a 404 error.
- Resolve job store scope with:

```js
const storeId = storeIdForAccountRequest(
  state,
  account,
  body.storeId || req.headers["x-ozon-store-id"] || "",
);
```

- Build jobs with server fields after body-derived fields:

```js
const job = {
  id: jobId,
  type,
  kind,
  params: { ...body, sku, accountId: undefined, createdBy: undefined },
  sku,
  accountId: account.id,
  createdBy: account.id,
  storeId,
  status: "PENDING",
  claimedByDeviceId: "",
  claimExpiresAt: "",
  claimAttempt: 0,
  result: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  local: true,
};
```

- Query routes return a job only when `job.accountId === account.id` and its store belongs to the account.
- Unknown jobs return 404 instead of a fabricated `PENDING` object.

- [ ] **Step 4: Run the HTTP test and existing account regressions**

Run:

```bash
node server/tests/browser-agent-isolation.test.mjs
node server/tests/account-store-isolation.test.mjs
node server/tests/account-multi-session.test.mjs
```

Expected: all three commands exit 0.

- [ ] **Step 5: Review the diff boundary**

Run:

```bash
git diff --check -- server/index.mjs server/tests/browser-agent-isolation.test.mjs
git diff --stat -- server/index.mjs server/tests/browser-agent-isolation.test.mjs
```

Expected: only Browser Agent route code and its test changed; no migration, dependency, Docker, app, or Ozon client files changed.

---

### Task 3: Add Device Claims and Closed Status Transitions

**Files:**
- Create: `server/browser-agent-policy.mjs`
- Modify: `server/index.mjs:4728-4794`
- Modify: `server/tests/browser-agent-isolation.test.mjs`

**Interfaces:**
- Produces:
  - `CLAIM_TTL_MS = 300000`
  - `claimNextBrowserAgentJob(state, { accountId, deviceId, nowMs })`
  - `transitionBrowserAgentJob(state, { accountId, deviceId, jobId, action, patch, nowMs })`
  - `ownedBrowserAgentJob(state, { accountId, jobId })`
- Errors carry `{ status, code }` for route-level handling.

- [ ] **Step 1: Write failing same-account/two-device assertions**

The production break caught here is “two devices under the same account can execute or finish the same job.”

```js
const registerA2 = await requestJson(
  handle,
  "POST",
  "/browser-agents/register",
  { deviceKey: "device-a2" },
  "token_a",
);
assert.equal(registerA2.status, 200);

const claimA1 = await requestJson(
  handle,
  "GET",
  `/browser-agents/jobs/next?deviceId=${encodeURIComponent(registerA.body.id)}`,
  undefined,
  "token_a",
);
assert.equal(claimA1.status, 200);
assert.equal(claimA1.body.job.id, created.body.id);
assert.equal(claimA1.body.job.claimedByDeviceId, registerA.body.id);
assert.equal(claimA1.body.job.status, "PROCESSING");

const wrongDeviceResult = await requestJson(
  handle,
  "POST",
  `/browser-agents/jobs/${created.body.id}/result`,
  { deviceId: registerA2.body.id, result: { ok: true } },
  "token_a",
);
assert.equal(wrongDeviceResult.status, 409);
```

- [ ] **Step 2: Write failing transition assertions**

The production break caught here is “a result endpoint can skip or overwrite terminal states.”

```js
const progress = await requestJson(
  handle,
  "POST",
  `/browser-agents/jobs/${created.body.id}/progress`,
  { deviceId: registerA.body.id, stage: "running", percent: 10 },
  "token_a",
);
assert.equal(progress.status, 200);
assert.equal(progress.body.job.status, "RUNNING");

const success = await requestJson(
  handle,
  "POST",
  `/browser-agents/jobs/${created.body.id}/result`,
  { deviceId: registerA.body.id, result: { ok: true } },
  "token_a",
);
assert.equal(success.status, 200);
assert.equal(success.body.job.status, "SUCCESS");

const overwriteTerminal = await requestJson(
  handle,
  "POST",
  `/browser-agents/jobs/${created.body.id}/fail`,
  { deviceId: registerA.body.id, message: "late failure" },
  "token_a",
);
assert.equal(overwriteTerminal.status, 409);
```

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
node server/tests/browser-agent-isolation.test.mjs
```

Expected: wrong-device or terminal-overwrite assertion fails against current route behavior.

- [ ] **Step 4: Implement the minimal policy module**

Implement literal allowed transitions:

```js
export const CLAIM_TTL_MS = 300_000;

const ACTION_STATUS = {
  progress: "RUNNING",
  result: "SUCCESS",
  fail: "FAILED",
};

const ALLOWED_FROM = {
  progress: new Set(["PROCESSING", "RUNNING"]),
  result: new Set(["RUNNING"]),
  fail: new Set(["PROCESSING", "RUNNING"]),
};
```

`claimNextBrowserAgentJob` must:

- require an agent with the same `accountId`;
- search only matching `job.accountId`;
- require the job’s `storeId` to be present;
- set `PROCESSING`, `claimedByDeviceId`, `claimExpiresAt`, and increment `claimAttempt`.

`transitionBrowserAgentJob` must:

- return 404 for missing/cross-account jobs;
- return 409 when device lock or current status is invalid;
- sanitize `patch` so it cannot replace scope/lock/status fields;
- renew the claim on progress;
- preserve an audit report with `accountId`, `storeId`, `jobId`, `deviceId`, from/to status, and timestamp.

- [ ] **Step 5: Replace route-local global access with the policy**

Import the policy functions in `server/index.mjs`. Route handlers should call the policy and then persist once; remove the fallback `previous = state.jobs[jobId] || {}` behavior.

- [ ] **Step 6: Run changed-module and direct-consumer tests**

Run:

```bash
node server/tests/browser-agent-isolation.test.mjs
node --check server/browser-agent-policy.mjs
node --check server/index.mjs
node extension/popup/__tests__/browser-agent-popup.smoke.test.js
```

Expected: all commands exit 0.

---

### Task 4: Handle Expired Claims Without Blind External Retries

**Files:**
- Create: `server/tests/browser-agent-policy.test.mjs`
- Modify: `server/browser-agent-policy.mjs`
- Modify: `server/tests/browser-agent-isolation.test.mjs`

**Interfaces:**
- Consumes: pure policy functions from Task 3.
- Produces: deterministic timeout behavior using explicit `nowMs`.

- [ ] **Step 1: Write a failing pure test for reclaimable work**

The production break caught here is “an abandoned read-only task stays stuck forever or is reclaimed before its TTL.”

```js
import assert from "node:assert/strict";
import {
  CLAIM_TTL_MS,
  claimNextBrowserAgentJob,
} from "../browser-agent-policy.mjs";

const now = Date.parse("2026-07-27T12:00:00.000Z");
const state = {
  browserAgents: {
    device_new: { id: "device_new", accountId: "acct_a" },
  },
  jobs: {
    safe_job: {
      id: "safe_job",
      accountId: "acct_a",
      storeId: "store_a",
      type: "ozon.collect_variant",
      status: "RUNNING",
      claimedByDeviceId: "device_old",
      claimExpiresAt: new Date(now - 1).toISOString(),
      claimAttempt: 1,
    },
  },
};

const claimed = claimNextBrowserAgentJob(state, {
  accountId: "acct_a",
  deviceId: "device_new",
  nowMs: now,
});
assert.equal(claimed.id, "safe_job");
assert.equal(claimed.status, "PROCESSING");
assert.equal(claimed.claimedByDeviceId, "device_new");
assert.equal(claimed.claimAttempt, 2);
assert.equal(claimed.claimExpiresAt, new Date(now + CLAIM_TTL_MS).toISOString());
```

- [ ] **Step 2: Write a failing pure test for uncertain external writes**

The production break caught here is “a timed-out publish can be automatically executed twice.”

```js
const publishState = {
  browserAgents: {
    device_new: { id: "device_new", accountId: "acct_a" },
  },
  jobs: {
    publish_job: {
      id: "publish_job",
      accountId: "acct_a",
      storeId: "store_a",
      type: "listing.publish_draft",
      status: "RUNNING",
      claimedByDeviceId: "device_old",
      claimExpiresAt: new Date(now - 1).toISOString(),
      claimAttempt: 1,
    },
  },
};

const none = claimNextBrowserAgentJob(publishState, {
  accountId: "acct_a",
  deviceId: "device_new",
  nowMs: now,
});
assert.equal(none, null);
assert.equal(publishState.jobs.publish_job.status, "RECONCILING");
assert.equal(publishState.jobs.publish_job.claimedByDeviceId, "");
assert.equal(publishState.jobs.publish_job.claimExpiresAt, "");
```

- [ ] **Step 3: Run the pure policy test and verify RED**

Run:

```bash
node server/tests/browser-agent-policy.test.mjs
```

Expected: non-zero exit because expired-claim handling is absent or incorrect.

- [ ] **Step 4: Implement expiration before selecting PENDING work**

Use an explicit safe retry set:

```js
const RETRYABLE_AFTER_TIMEOUT = new Set([
  "collect.hot_products",
  "collect.product_detail",
  "ozon.collect_variant",
  "ozon.market_data",
  "listing.create_draft",
]);
```

For expired `PROCESSING/RUNNING` jobs owned by the account:

- retryable type → clear claim, set `PENDING`, record `lastClaimExpiredAt`;
- any other type → clear claim, set `RECONCILING`, record `reconciliationReason`.

Then select the first matching `PENDING` job and claim it.

- [ ] **Step 5: Run policy, HTTP, and status regression tests**

Run:

```bash
node server/tests/browser-agent-policy.test.mjs
node server/tests/browser-agent-isolation.test.mjs
node server/tests/import-status-route.test.mjs
node server/tests/ozon-import-status-v3.test.mjs
```

Expected: all commands exit 0.

- [ ] **Step 6: Perform the mutation check**

Temporarily change `listing.publish_draft` expiration to `PENDING`, run:

```bash
node server/tests/browser-agent-policy.test.mjs
```

Expected: the uncertain-write test fails. Restore the correct `RECONCILING` behavior immediately and rerun the test to exit 0.

---

### Task 5: Add the Security Regression to the Unified Gate

**Files:**
- Modify: `scripts/verify.mjs`
- Read: `extension/background/agent/agent-runtime.js:178-294`
- Read: `extension/background/sync/backend-client.js:175-223`

**Interfaces:**
- Consumes: Task 1 and Task 4 tests.
- Produces: a unified verification entry for Browser Agent account/device isolation.

- [ ] **Step 1: Confirm the extension already sends the claimed device**

Run the existing Browser Agent popup smoke and inspect runtime behavior:

```bash
node extension/popup/__tests__/browser-agent-popup.smoke.test.js
```

Expected: exit 0. The existing runtime passes `deviceId` in progress, result, and fail payloads, so no extension production change is required.

- [ ] **Step 2: Add the new tests to `scripts/verify.mjs`**

Add one check immediately after account/store ownership regression:

```js
[
  "Browser Agent account/device isolation",
  "node",
  [
    "--test",
    "server/tests/browser-agent-policy.test.mjs",
    "server/tests/browser-agent-isolation.test.mjs",
  ],
],
```

- [ ] **Step 3: Run the narrow gate**

Run:

```bash
node server/tests/browser-agent-policy.test.mjs
node server/tests/browser-agent-isolation.test.mjs
node server/tests/account-store-isolation.test.mjs
node server/tests/account-multi-session.test.mjs
node extension/popup/__tests__/browser-agent-popup.smoke.test.js
```

Expected: all commands exit 0.

- [ ] **Step 4: Review secrets, contracts, and unexpected files**

Run:

```bash
git diff --check -- server/browser-agent-policy.mjs server/index.mjs server/tests/browser-agent-policy.test.mjs server/tests/browser-agent-isolation.test.mjs scripts/verify.mjs
git diff --stat -- server/browser-agent-policy.mjs server/index.mjs server/tests/browser-agent-policy.test.mjs server/tests/browser-agent-isolation.test.mjs scripts/verify.mjs
rg -n -i "(api[-_ ]?key|authorization|bearer).{0,80}[0-9a-z_-]{16,}" server/browser-agent-policy.mjs server/tests/browser-agent-policy.test.mjs server/tests/browser-agent-isolation.test.mjs
```

Expected: no whitespace errors, only declared files changed for this package, and no real credential literal is found.

---

### Task 6: Full Verification and AGENTS.md Re-Audit

**Files:**
- Modify only if a regression caused by this package is proven.
- Read: user-provided `AGENTS.md`
- Read: `docs/superpowers/specs/2026-07-27-browser-agent-task-isolation-design.md`

**Interfaces:**
- Consumes: completed implementation and all repository verification commands.
- Produces: evidence-based completion or an explicit list of remaining failures.

- [ ] **Step 1: Run the full project verification**

Run:

```bash
pnpm verify
```

Expected: exit 0. If PostgreSQL-only pricing checks fail because the local database is intentionally stopped, record those as environment failures, start only the local test PostgreSQL if needed, rerun the affected integration checks, then stop it again.

- [ ] **Step 2: Run the frontend build**

Run:

```bash
pnpm --dir app build
```

Expected: exit 0. A size warning is not a failed build but must be recorded as remaining structural debt.

- [ ] **Step 3: Re-audit the first repair package against AGENTS.md**

Confirm with code and tests:

- backend ownership is enforced for create/read/claim/update;
- cross-account and wrong-device negative tests exist;
- status transitions are closed and terminal states are immutable;
- uncertain external writes are not blindly retried;
- actor/account/store/device/from-status/to-status are recorded;
- no secret, migration, dependency, production config, or Ozon side effect was introduced;
- the new policy module has one responsibility and routes depend on its stable functions.

- [ ] **Step 4: Compare final diff to the approved boundary**

Run:

```bash
git status --short
git diff --check
git diff -- server/browser-agent-policy.mjs server/index.mjs server/tests/browser-agent-policy.test.mjs server/tests/browser-agent-isolation.test.mjs scripts/verify.mjs
```

Expected: no unexpected files from this work package and no unrelated user changes overwritten.

- [ ] **Step 5: Record handoff**

Update the design document status from `待书面确认` to `已实现` only if all acceptance criteria pass. Report:

- exact files/contracts changed;
- exact test commands and results;
- baseline failures still present;
- unverified areas and why;
- no external Ozon action;
- rollback by reverting only the declared package files;
- next repair package: global cache account/store isolation.
