# Complete Ozon Collection Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Ozon collection writes an account-scoped collection-box record only after category, package weight, length, width, and height have been read, normalized, validated, and persisted.

**Architecture:** The backend owns an account-scoped enrichment cache, a narrow read-only job queue, validation, audit, and idempotency. A Collector-authenticated extension executor may run only the fixed `ozon.collect_variant` capture against the user's logged-in Seller browser context; it cannot run store sync or arbitrary server code. Both visible collection buttons call one extension coordinator that prefetches, waits for a complete result, and then invokes the existing Collector upload contract.

**Tech Stack:** Node.js ESM/CommonJS, PostgreSQL migrations and `pg`, JSON-state fallback, Chrome Manifest V3, Collector scoped sessions, Node test runner, Playwright browser fixtures, React/Vite build, existing extension packaging/parity scripts.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-31-complete-ozon-collection-enrichment-design.md` and the repository `AGENTS.md` rules.
- Do not restore extension username/password login, Web Bearer access, data-store binding, store sync, or store-sync commands.
- The extension may execute only the fixed read-only `ozon.collect_variant` enrichment task; the server must never send JavaScript or an arbitrary URL/action.
- Derive `accountId`, Collector session identity, permissions, cache scope, job scope, and audit actor on the server. Reject client account/store/company/data-store fields.
- Require `collector.ozon.read` on every enrichment, claim, result, and failure endpoint; retain `collector.upload` for collection-box writes.
- A complete result requires finite positive `descriptionCategoryId`, `weightG`, `lengthMm`, `widthMm`, and `heightMm`. `typeId` is optional.
- Normalize weight to grams and dimensions to millimetres. Do not guess when an upstream unit is unknown.
- Complete cache TTL is exactly 6 hours; negative cache TTL is at most 60 seconds; the end-to-end cold enrichment deadline is 20 seconds.
- Batch prefetch accepts at most 20 unique SKUs and executes at most 4 enrichment operations concurrently per account.
- Cache, lease, job, and audit keys include `accountId`; no result, executor, or credential may cross accounts.
- Prefetch is read-only and must never create a collection-box row. Only a successful Collector upload may display “采集成功”.
- The Ozon completeness gate applies only to normalized source `ozon`; it must not change other source contracts.
- Preserve existing user changes. Before every task run `git status --short` and inspect overlapping diffs.
- Use TDD: add the named failing test, observe the expected failure, implement the minimum behavior, then rerun the focused test.
- After every task run `git diff --check` and commit only that task's files.
- PostgreSQL integration tests may run only against an explicitly dedicated test database. Never point them at development or production data.
- Generated copies under `app/public/sonli-extension-0.13.46.1/` and ZIP files are updated only in Task 9.
- Initialize implementation shells with the bundled runtime:

```bash
export PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
node --version
pnpm --version
```

Expected baseline: Node `v24.14.0`, pnpm `11.9.0`.

---

### Task 1: Define the server enrichment and completeness contract

**Files:**

- Create: `server/collector-ozon-enrichment-contract.mjs`
- Create: `server/tests/collector-ozon-enrichment-contract.test.mjs`

**Interfaces:**

- Produces: `OZON_ENRICHMENT_CONTRACT_VERSION = "collector.ozon.enrichment.v1"`.
- Produces: `parseOzonEnrichmentRequest(body) -> { requestId, sku }`.
- Produces: `parseOzonBatchEnrichmentRequest(body) -> { requestId, skus }`.
- Produces: `normalizeOzonAgentResult({ sku, variantData, source, capturedAt }) -> CompleteEnrichment`.
- Produces: `missingOzonRequiredFields(value) -> string[]` using stable keys `descriptionCategoryId`, `weightG`, `lengthMm`, `widthMm`, `heightMm`.
- Produces: `assertCompleteOzonCollectPayload(source, payload)`; returns for non-Ozon sources and throws HTTP 422 `OZON_COLLECT_INCOMPLETE` for incomplete Ozon payloads.

- [ ] **Step 1: Write the failing contract tests**

Add table-driven tests that prove the reference extension fields normalize correctly:

```js
const normalized = normalizeOzonAgentResult({
  sku: "4862904234",
  source: "BACKEND_FLEET",
  capturedAt: "2026-07-31T00:00:00.000Z",
  variantData: {
    description_category_id: 123,
    type_id: 456,
    attributes: [
      { key: "4497", value: "500" },
      { key: "9454", value: "300" },
      { key: "9455", value: "200" },
      { key: "9456", value: "100" },
    ],
  },
});
assert.deepEqual(normalized.logistics, {
  weightG: 500,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 100,
});
assert.equal(normalized.descriptionCategoryId, 123);
```

Also cover the `4383` kilogram fallback, top-level bundle `weight/depth/width/height`, zero/negative/NaN rejection, optional `typeId`, more than 20 batch SKUs, duplicate SKUs, missing request IDs, and every retired scope-field spelling recognized by `findRetiredCollectorScopePath`.

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `node --test server/tests/collector-ozon-enrichment-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the minimal pure contract**

Use a single positive-number helper and explicit attribute mapping:

```js
const REQUIRED_FIELDS = Object.freeze([
  "descriptionCategoryId",
  "weightG",
  "lengthMm",
  "widthMm",
  "heightMm",
]);

const ATTRIBUTE_IDS = Object.freeze({
  weightG: "4497",
  weightKg: "4383",
  lengthMm: "9454",
  widthMm: "9455",
  heightMm: "9456",
});
```

`parseOzonEnrichmentRequest` must accept only `requestId` and `sku`. The batch parser accepts only `requestId` and `skus`, preserves first-seen order, and rejects 21 or more unique values with `OZON_ENRICH_BATCH_LIMIT`. Cache refresh is a server-owned decision and cannot be requested by the extension.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-contract.test.mjs
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/collector-ozon-enrichment-contract.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
git commit -m "feat(server): define Ozon enrichment contract"
```

---

### Task 2: Add account-scoped cache and job repositories

**Files:**

- Create: `server/db/migrations/020_collector_ozon_enrichment.sql`
- Create: `server/collector-ozon-enrichment-repository.mjs`
- Create: `server/tests/collector-ozon-enrichment-repository.test.mjs`
- Create: `server/tests/collector-ozon-enrichment-migration.test.mjs`
- Modify: `server/account-deletion.mjs`
- Modify: `server/formal-persistence.mjs`
- Modify: `server/tests/account-deletion.test.mjs`
- Modify: `server/tests/account-deletion-relational.test.mjs`

**Interfaces:**

- Produces: `createJsonCollectorOzonEnrichmentRepository({ state, persist })`.
- Produces: `createPostgresCollectorOzonEnrichmentRepository({ pool })`.
- Uses `EnrichmentKey = { accountId, source: "ozon", sku, contractVersion }` for every cache and lease operation.
- Both repositories implement:

```js
{
  readCache({ key, now, includeExpired = false }),
  tryAcquireCacheLease({ key, leaseOwner, leaseExpiresAt, now }),
  releaseCacheLease({ key, leaseOwner }),
  writeCompleteCache({ key, result, responseHash, executorSessionId, capturedAt, expiresAt }),
  writeNegativeCache({ key, error, responseHash, capturedAt, expiresAt }),
  createOrGetJob({ id, accountId, requestId, sku, preferredSessionId, refreshBundle, deadlineAt, createdAt }),
  claimNextJob({ accountId, collectorSessionId, now, claimExpiresAt }),
  completeJob({ accountId, collectorSessionId, jobId, result, now }),
  failJob({ accountId, collectorSessionId, jobId, error, now }),
  readJob({ accountId, jobId }),
}
```

- [ ] **Step 1: Write failing JSON repository and SQL contract tests**

Test two accounts using the same SKU, a 6-hour hit, an expired hit, a 60-second negative hit, one successful lease owner, expired-lease takeover, stable `createOrGetJob`, one-session claim ownership, a hard maximum of four simultaneous `PROCESSING` jobs per account, wrong-session result rejection, terminal-state immutability, and account deletion.

The migration test must read migration 020 and assert both tables and keys exist:

```sql
PRIMARY KEY (account_id, source, sku, contract_version)
UNIQUE (account_id, request_id, sku)
FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
FOREIGN KEY (last_executor_session_id) REFERENCES collector_sessions(id) ON DELETE SET NULL
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-repository.test.mjs
node --test server/tests/collector-ozon-enrichment-migration.test.mjs
```

Expected: FAIL because the repository and migration do not exist.

- [ ] **Step 3: Add the forward-only migration**

Create `collector_ozon_enrichment_cache` with account/source/SKU/contract primary key, `status` (`COMPLETE` or `ERROR`), JSONB result/error, response hash, last successful executor session ID, captured/expiry times, lease owner/expiry, and updated time. Create `collector_ozon_enrichment_jobs` with account/request/SKU uniqueness, `PENDING|PROCESSING|SUCCESS|FAILED` status, server-owned `refresh_bundle`, preferred and claimed Collector session IDs, claim expiry, deadline, JSONB result/error, and timestamps. Add expiry, pending-job, and account lookup indexes. Do not alter existing collection/store tables.

- [ ] **Step 4: Implement JSON and PostgreSQL repositories**

JSON mode stores `state.collectorOzonEnrichmentCache` and `state.collectorOzonEnrichmentJobs` and serializes mutations. PostgreSQL lease acquisition must be atomic, using one `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE lease_expires_at <= $now OR lease_owner = $owner RETURNING *` statement. Job claiming must take an account-scoped transaction advisory lock, count unexpired `PROCESSING` jobs, reject the fifth claim, then use `FOR UPDATE SKIP LOCKED` and bind `claimed_session_id` from authenticated server context. This keeps the four-job limit valid across server instances.

The lease update predicate must be equivalent to:

```sql
ON CONFLICT (account_id, source, sku, contract_version) DO UPDATE
SET lease_owner = EXCLUDED.lease_owner,
    lease_expires_at = EXCLUDED.lease_expires_at,
    updated_at = EXCLUDED.updated_at
WHERE collector_ozon_enrichment_cache.lease_expires_at <= EXCLUDED.updated_at
   OR collector_ozon_enrichment_cache.lease_owner = EXCLUDED.lease_owner
RETURNING account_id, source, sku, contract_version, lease_owner, lease_expires_at
```

- [ ] **Step 5: Add privacy deletion**

`removeAccountScope` removes the two JSON collections by `accountId`. `deleteRemovedAccountScopes` explicitly deletes the two relational tables before the account row, even though the foreign key also cascades, so deletion counts remain auditable. Extend both account-deletion tests with fixtures for account A and account B and assert only account A disappears.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-repository.test.mjs
node --test server/tests/collector-ozon-enrichment-migration.test.mjs
node --test server/tests/account-deletion.test.mjs
node --test server/tests/account-deletion-relational.test.mjs
git diff --check
```

Expected: PASS. Record PostgreSQL runtime behavior as unverified until an explicit dedicated test database is available; static migration and repository query tests must still pass.

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations/020_collector_ozon_enrichment.sql server/collector-ozon-enrichment-repository.mjs server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/collector-ozon-enrichment-migration.test.mjs server/account-deletion.mjs server/formal-persistence.mjs server/tests/account-deletion.test.mjs server/tests/account-deletion-relational.test.mjs
git commit -m "feat(server): persist account Ozon enrichment"
```

---

### Task 3: Add the least-privilege Collector permission and full session authentication

**Files:**

- Modify: `server/collector-auth-service.mjs`
- Modify: `server/collector-auth-runtime.mjs`
- Modify: `server/tests/collector-auth-service.test.mjs`
- Modify: `server/tests/collector-auth-runtime.test.mjs`
- Modify: `server/tests/permissions.test.mjs`

**Interfaces:**

- Extends: `COLLECTOR_PERMISSIONS` with `collector.ozon.read`.
- Produces: `collectorAuthRuntime.authenticateSessionRequest(req, requiredPermission)` returning the safe full session:

```js
{
  collectorSessionId,
  accountId,
  deviceFingerprint,
  extensionVersion,
  permissions,
  expiresAt,
  account: { id, displayName }
}
```

- Preserves: `authenticateRequest(req, permission) -> { id, displayName }` for current callers.

- [ ] **Step 1: Add failing permission tests**

Assert new tickets/sessions contain the exact four permissions, old fixture sessions without `collector.ozon.read` receive 403 `COLLECTOR_PERMISSION_DENIED`, and `authenticateSessionRequest` returns session ID/fingerprint but never Collector token/hash or parent Web token.

- [ ] **Step 2: Verify the focused tests fail**

Run:

```bash
node --test server/tests/collector-auth-service.test.mjs
node --test server/tests/collector-auth-runtime.test.mjs
node --test server/tests/permissions.test.mjs
```

Expected: FAIL because the new permission and runtime method are absent.

- [ ] **Step 3: Implement permission and runtime method**

Keep `publicSession(record)` as the only session serializer. Implement `authenticateSessionRequest` by parsing the `Collector` authorization header and returning `httpService.authenticate(...)`; implement the existing `authenticateRequest` as a projection of that result so current upload callers retain their contract.

```js
async function authenticateRequest(req, requiredPermission) {
  const authenticated = await authenticateSessionRequest(req, requiredPermission);
  return authenticated.account || {
    id: authenticated.accountId,
    displayName: "",
  };
}
```

- [ ] **Step 4: Run focused tests**

Run the three commands from Step 2 plus `git diff --check`.

Expected: PASS and no secret value in snapshots or audit metadata.

- [ ] **Step 5: Commit**

```bash
git add server/collector-auth-service.mjs server/collector-auth-runtime.mjs server/tests/collector-auth-service.test.mjs server/tests/collector-auth-runtime.test.mjs server/tests/permissions.test.mjs
git commit -m "feat(auth): scope Ozon enrichment reads"
```

---

### Task 4: Implement backend enrichment orchestration and routes

**Files:**

- Create: `server/collector-ozon-enrichment-service.mjs`
- Create: `server/collector-ozon-enrichment-routes.mjs`
- Create: `server/collector-ozon-enrichment-runtime.mjs`
- Create: `server/tests/collector-ozon-enrichment-service.test.mjs`
- Create: `server/tests/collector-ozon-enrichment-routes.test.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`

**Interfaces:**

- Produces service:

```js
createCollectorOzonEnrichmentService({
  repository,
  now,
  randomUUID,
  sleep,
  audit,
}).enrichOne({ session, requestId, sku })
  .enrichBatch({ session, requestId, skus })
  .claimNext({ session })
  .completeClaim({ session, jobId, variantData })
  .failClaim({ session, jobId, code, message })
```

- Produces public routes:
  - `POST /collector/ozon/enrich`
  - `POST /collector/ozon/enrich/batch`
- Produces internal fixed-task executor routes:
  - `GET /collector/ozon/enrichment-jobs/next`
  - `POST /collector/ozon/enrichment-jobs/{id}/result`
  - `POST /collector/ozon/enrichment-jobs/{id}/fail`

- [ ] **Step 1: Write failing service tests with fake repositories**

Cover cache hit without a job, cold miss creating exactly one job, concurrent same-key callers sharing one lease/job, the last successful executor receiving a one-second preferred-claim window, same-account fallback after that window, successful claim/result normalization, 20-second deadline, expired claim recovery, negative caching, a 6-hour-expired cache creating a fixed refresh job, wrong-account/session rejection, batch input order, one item failing without cancelling siblings, and maximum concurrency four.

Use a controllable clock and no real sleeps:

```js
const service = createCollectorOzonEnrichmentService({
  repository,
  now: () => new Date(clock),
  randomUUID: () => "job-1",
  sleep: async () => { clock += 250; },
  audit: async (event) => audits.push(event),
});
```

- [ ] **Step 2: Write failing route contract tests**

Assert all five routes require `collector.ozon.read`; strict request bodies reject `accountId`, `storeId`, `companyId`, and unknown fields; single success returns the v1 contract; batch responses preserve order and use `{code,message,missingFields,retryable}`; result accepts only `variantData`; nested token/Cookie/Authorization/retired scope fields are rejected before caching; and no route accepts an arbitrary action, URL, script, request header, or cookie.

- [ ] **Step 3: Verify both test files fail**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-service.test.mjs
node --test server/tests/collector-ozon-enrichment-routes.test.mjs
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Implement service state transitions**

Use `IDLE cache -> lease -> PENDING job -> PROCESSING claim -> COMPLETE cache/SUCCESS job` or `ERROR cache/FAILED job`. Read stale cache metadata with `includeExpired:true` only to choose the last successful executor; never return stale product data as a hit. A job exposes only `{id,requestId,sku,refreshBundle}`; `refreshBundle` is `true` for a cold/stale server cache and is never copied from client input. Prefer the last successful executor session stored with the cache; if it does not claim within one second, allow any eligible session from the same account. The public request waits by rereading repository state every 250 ms without holding a JSON transaction or database connection. At the 20-second deadline return 504 `OZON_ENRICH_UPSTREAM_FAILED`; a busy account returns 429 `OZON_ENRICH_BUSY`. Complete cache expiry is `capturedAt + 6h`; negative expiry is `capturedAt + min(60s, retryAfter)`.

Define internal `enrichmentError(status, code, message, details)` and `errorFromJob(job)` helpers in this service; both return errors with stable `status`, `code`, `missingFields`, and `retryable` properties and never include executor secrets.

The wait loop must release repository resources between polls:

```js
while (now().getTime() < deadlineAt.getTime()) {
  const current = await repository.readJob({ accountId: session.accountId, jobId });
  if (current?.status === "SUCCESS") return current.result;
  if (current?.status === "FAILED") throw errorFromJob(current);
  await sleep(250);
}
throw enrichmentError(504, "OZON_ENRICH_UPSTREAM_FAILED", "Ozon 商品资料读取超时");
```

- [ ] **Step 5: Implement runtime, routes, and audit wiring**

The runtime chooses JSON/PostgreSQL repositories using the existing persistence mode and creates one repository operation per transaction. Audit events include request ID, account, SKU, job/session ID, cache hit, duration, status, missing fields, and response SHA-256; redact all token/cookie/header material.

Register the new handler in `server/index.mjs` after Collector authentication routes and before `handleFastCollectionRoute` and the broad JSON-state transaction. This ordering prevents a 20-second wait from blocking the result endpoint.

- [ ] **Step 6: Run focused tests and syntax checks**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-service.test.mjs
node --test server/tests/collector-ozon-enrichment-routes.test.mjs
node --test server/tests/module-boundaries.test.mjs
node --check server/index.mjs
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/collector-ozon-enrichment-service.mjs server/collector-ozon-enrichment-routes.mjs server/collector-ozon-enrichment-runtime.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-routes.test.mjs server/index.mjs server/tests/module-boundaries.test.mjs
git commit -m "feat(server): orchestrate Ozon collection enrichment"
```

---

### Task 5: Fail closed before persisting incomplete Ozon collection data

**Files:**

- Modify: `server/collection-pipeline.mjs`
- Modify: `server/account-scoped-collection-routes.mjs`
- Modify: `server/tests/account-scoped-collection.test.mjs`
- Create: `server/tests/ozon-collection-completeness-gate.test.mjs`

**Interfaces:**

- Consumes: `assertCompleteOzonCollectPayload(source, payload)` from Task 1.
- Preserves: non-Ozon `/sources/{source}/collect` behavior.
- Produces: HTTP 422 `OZON_COLLECT_INCOMPLETE` with ordered `missingFields` before any collection row or succeeded request is written.

- [ ] **Step 1: Write failing JSON and PostgreSQL-path gate tests**

For each of the five required fields, remove only that field from an otherwise valid Ozon payload and assert no `collectBox` row, `collect_items` write, or `SUCCEEDED` request occurs. Test a complete Ozon payload, a repeated complete request, a conflicting request, and an incomplete `1688` payload that remains governed by its existing rules.

- [ ] **Step 2: Verify the gate tests fail**

Run:

```bash
node --test server/tests/ozon-collection-completeness-gate.test.mjs
node --test server/tests/account-scoped-collection.test.mjs
```

Expected: FAIL because current routes still persist incomplete Ozon payloads.

- [ ] **Step 3: Add one shared pre-persistence gate**

Call the Task 1 assertion immediately after `prepareCollectRequestV4` and before any request/collection insert. In the JSON route, assert `prepared.identity.source` against the original payload before `normalizeItem` and state mutation. In the PostgreSQL pipeline, assert `identity.source` against `normalizedItem` before opening the transaction, so the failed request cannot create a partial success row.

```js
const prepared = prepareCollectRequestV4({ authenticatedAccount, input });
assertCompleteOzonCollectPayload(
  prepared.identity.source,
  prepared.normalizedItem,
);
```

- [ ] **Step 4: Run focused regression**

Run:

```bash
node --test server/tests/ozon-collection-completeness-gate.test.mjs
node --test server/tests/account-scoped-collection.test.mjs
node --test server/tests/collector-scope-ingress.test.mjs
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/collection-pipeline.mjs server/account-scoped-collection-routes.mjs server/tests/account-scoped-collection.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs
git commit -m "fix(server): reject incomplete Ozon collection"
```

---

### Task 6: Add the Collector-authenticated extension enrichment client and executor

**Files:**

- Create: `extension/lib/ozon-enrichment-contract.js`
- Create: `extension/background/collector-ozon-enrichment-client.js`
- Create: `extension/background/collector-ozon-enrichment-agent.js`
- Create: `extension/tests/ozon-enrichment-contract.test.js`
- Create: `extension/tests/collector-ozon-enrichment-client.test.js`
- Modify: `extension/lib/collector-session.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`
- Modify: `extension/tests/collector-session.test.js`
- Modify: `extension/tests/sync-capability-removed.test.js`
- Modify: `scripts/extension-capture-only-policy.mjs`
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/package-extension.mjs`

**Interfaces:**

- Produces `globalThis.JzOzonEnrichmentContract` with `normalizeResult`, `normalizeVariantData`, `missingFields`, `assertComplete`, and `toCollectFields`.
- Produces `globalThis.JzCollectorOzonAgent.create({ sessionManager, captureVariant, canCapture, sleep })` with `drainUntil({ requestId, deadlineAt })` and `stop(requestId)`.
- Produces `globalThis.JzCollectorOzonClient.create({ sessionManager, agent, getBackendUrl })` with `enrich({ requestId, sku })` and `enrichBatch({ requestId, skus })`.
- Adds runtime messages `{ action: "enrichOzonCollect", requestId, sku }` and `{ action: "enrichOzonCollectBatch", requestId, skus }`.

- [ ] **Step 1: Write failing pure contract tests**

Assert the browser contract accepts the exact server v1 response, can normalize a local merged `variantData` through `normalizeVariantData({sku,variantData,source,capturedAt})`, and maps either complete result to existing collection fields:

```js
{
  description_category_id: 123,
  type_id: 456,
  weight: 500,
  depth: 300,
  width: 200,
  height: 100,
  weight_unit: "g",
  dimension_unit: "mm",
  variantData,
}
```

and rejects an incomplete or version-mismatched result.

- [ ] **Step 2: Write failing client/executor tests**

Use fake `collectorFetch`, `canCapture`, and `captureVariant`. Assert the client requires `collector.ozon.read`, starts the public enrichment request and executor drain concurrently, does not claim while Seller context is unavailable, claims only the fixed job shape `{id,requestId,sku,refreshBundle}`, invokes `searchVariants` with `{sku,noProxy:true,forceRefresh:refreshBundle}`, posts only `variantData`, safely reports failure, preserves batch order with at most 20 unique SKUs, and cannot call `/ozon/sync`, submit store IDs, or execute arbitrary task data.

- [ ] **Step 3: Verify tests fail**

Run:

```bash
node extension/tests/ozon-enrichment-contract.test.js
node extension/tests/collector-ozon-enrichment-client.test.js
```

Expected: FAIL because the files do not exist.

- [ ] **Step 4: Implement the client and narrow executor**

Add `collector.ozon.read` to the safe session permission allowlist. Import the three new scripts synchronously before the service-worker listener. The executor first verifies the existing trusted Seller context, loops at 250 ms only while a prefetch/enrichment request is active, calls its injected fixed capture function, and stops at the 20-second deadline. It never uses Web Bearer, store ID, company ID, or retired browser-agent sync modules.

Start the held enrichment request and job drain without serializing them:

```js
const responsePromise = sessionManager.collectorFetch("/collector/ozon/enrich", {
  collectorOperation,
  permission: "collector.ozon.read",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ requestId, sku }),
});
const drainPromise = agent.drainUntil({ requestId, deadlineAt });
try {
  return await responsePromise;
} finally {
  agent.stop(requestId);
  await drainPromise;
}
```

Wire `captureVariant` through `chrome.runtime.sendMessage({action:"searchVariants", sku, noProxy:true, forceRefresh:job.refreshBundle===true})`; pass the resulting exact matched `variantData` to the result endpoint. `refreshBundle` is generated only by the backend when its six-hour cache is stale. The service worker `enrichOzonCollect` case must return stable code/status/missing fields through the existing message envelope.

- [ ] **Step 5: Update capture-only and packaging manifests**

Add the new runtime files to `REQUIRED_CAPTURE_ONLY_FILES`, `allowedLocalOnly`, and `collectorRuntimeFiles`. Add the shared contract before `ozon-product.js` and `ozon-data-panel.js`; do not add Chrome permissions or new host permissions.

- [ ] **Step 6: Run focused security tests**

Run:

```bash
node extension/tests/ozon-enrichment-contract.test.js
node extension/tests/collector-ozon-enrichment-client.test.js
node extension/tests/collector-session.test.js
node extension/tests/sync-capability-removed.test.js
node extension/tests/manifest-security-contract.test.js
git diff --check
```

Expected: PASS; the sync-removal test must still prove the extension has no store-sync capability.

- [ ] **Step 7: Commit**

```bash
git add extension/lib/ozon-enrichment-contract.js extension/background/collector-ozon-enrichment-client.js extension/background/collector-ozon-enrichment-agent.js extension/tests/ozon-enrichment-contract.test.js extension/tests/collector-ozon-enrichment-client.test.js extension/lib/collector-session.js extension/background/service-worker.js extension/manifest.json extension/tests/collector-session.test.js extension/tests/sync-capability-removed.test.js scripts/extension-capture-only-policy.mjs scripts/check-extension-source-parity.mjs scripts/package-extension.mjs
git commit -m "feat(extension): read complete Ozon enrichment"
```

---

### Task 7: Implement the shared collection coordinator and data-panel flow

**Files:**

- Create: `extension/lib/ozon-collect-coordinator.js`
- Create: `extension/tests/ozon-collect-coordinator.test.js`
- Modify: `extension/manifest.json`
- Modify: `extension/content/ozon-data-panel.js`
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/tests/data-panel-visual-browser.test.js`
- Modify: `extension/tests/fixtures/data-panel-visual-browser.fixture.html`
- Create: `extension/tests/ozon-search-complete-collection.test.js`
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/package-extension.mjs`

**Interfaces:**

- Produces `globalThis.JzOzonCollectCoordinator.create({ sendMessage, now, timeoutMs })`.
- Coordinator methods:

```js
prefetch({ sku }) -> Promise<CompleteEnrichment>
prefetchBatch({ skus }) -> Promise<Array<CompleteEnrichment | { sku, status: "ERROR", error }>>
collect({ sku, raw, localFallback }) -> Promise<{ dedupeHit, result }>
getState(sku) -> { status, requestId, error? }
```

- States are exactly `IDLE`, `PREFETCHING`, `READY`, `SAVING`, `SUCCESS`, `BLOCKED_AUTH`, `ERROR`.

- [ ] **Step 1: Write failing state-machine tests**

Cover one prefetch per SKU, prefetch with no upload, concurrent clicks sharing one promise, `READY -> SAVING -> SUCCESS`, auth failure to `BLOCKED_AUTH`, incomplete/backend failure to `ERROR`, local complete fallback, local incomplete rejection, stable request ID reuse after network retry, and a hard prohibition on `PREFETCHING/ERROR -> SUCCESS` without upload success.

Also cover `prefetchBatch`: first-seen SKU ordering, splitting 21 values into batches of 20 and 1, reusing already-ready entries, and storing per-SKU errors without cancelling successful siblings.

- [ ] **Step 2: Verify coordinator test fails**

Run: `node extension/tests/ozon-collect-coordinator.test.js`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the coordinator**

Keep a `Map<sku, entry>` containing the stable request ID, promise, complete result, and state. `collect` first awaits/refreshes enrichment, then applies `JzOzonEnrichmentContract.assertComplete`, merges `toCollectFields(result)` into the page payload, and finally sends:

```js
sendMessage("pushSourceCollect", {
  sourceId: "ozon",
  requestId: entry.requestId,
  raw: completePayload,
});
```

Map stable server codes to the approved Chinese messages. Do not persist complete payloads in local storage; the backend cache is authoritative.

- [ ] **Step 4: Replace data-panel collection logic**

Start `prefetch({sku})` when the panel begins loading the card. Keep current visual field loading, but make `handleCollectOne` call the coordinator. The local fallback may reuse cached/current `searchVariants` and must return the same v1 normalized result. Remove the panel-local decision to upload after its own source check; the shared coordinator is the only collection decision point.

On search/category pages, collect visible card SKUs and call `prefetchBatch` in chunks of at most 20. Route both `handleCollectOne` and the collection step inside `handleEditList` through the same coordinator; opening the Web edit page occurs only after the complete upload succeeds. Preserve search-card statistics, title/image preference, hashtags, and marketing-price fields.

- [ ] **Step 5: Add browser fixture cases**

Assert page load sends enrichment but not upload; cache hit saves immediately; cold result shows “正在补全商品资料”; missing category/each dimension produces the exact missing list and zero uploads; Web auth renders login action; repeated clicks produce one upload; backend and local failures do not show success.

In `ozon-search-complete-collection.test.js`, assert 21 visible SKUs produce batch sizes 20 and 1, neither batch writes to the collection box, and both search-page collection paths delegate their final write to the coordinator.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node extension/tests/ozon-collect-coordinator.test.js
node extension/tests/data-panel-visual-browser.test.js
node extension/tests/data-panel-logistics.test.js
node extension/tests/ozon-search-complete-collection.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/lib/ozon-collect-coordinator.js extension/tests/ozon-collect-coordinator.test.js extension/manifest.json extension/content/ozon-data-panel.js extension/content/ozon-search.js extension/tests/data-panel-visual-browser.test.js extension/tests/fixtures/data-panel-visual-browser.fixture.html extension/tests/ozon-search-complete-collection.test.js scripts/check-extension-source-parity.mjs scripts/package-extension.mjs
git commit -m "feat(extension): coordinate complete data-panel collection"
```

---

### Task 8: Route product-page one-click collection through the same coordinator

**Files:**

- Modify: `extension/content/ozon-product.js`
- Create: `extension/tests/ozon-product-complete-collection.test.js`
- Modify: `extension/tests/collector-removed.test.js`
- Modify: `extension/tests/fleet-collect-attrs-merge.test.js`

**Interfaces:**

- Consumes the Task 7 coordinator without introducing a second completeness implementation.
- Preserves title, images, prices, videos, rich content, hashtags, seller information, and multivariant payload fields.
- Changes only the point at which Ozon enrichment fields are merged and the upload is allowed.

- [ ] **Step 1: Write failing product-page contract tests**

Load `ozon-product.js` with a coordinator spy. Assert page initialization prefetches the current SKU, `performProductCollect` delegates the final upload to `coordinator.collect`, no direct `pushSourceCollect` occurs in that function, all existing rich payload fields reach the coordinator, and enrichment failure produces no success result.

- [ ] **Step 2: Verify the test fails**

Run: `node extension/tests/ozon-product-complete-collection.test.js`

Expected: FAIL because `performProductCollect` directly uploads after swallowing `searchVariants` failure.

- [ ] **Step 3: Integrate the product page**

Retain existing DOM extraction and rich-content/video work. Start enrichment as soon as a stable SKU is available. Remove only the final direct-upload decision and call:

```js
const response = await coordinator.collect({
  sku: product.sku,
  raw: collectPayload,
  localFallback: () => window.JzOzonEnrichmentContract.normalizeVariantData({
    sku: product.sku,
    variantData: variantMatch,
    source: "LOCAL_SELLER",
    capturedAt: new Date().toISOString(),
  }),
});
```

`localFallback` returns `JzOzonEnrichmentContract.normalizeVariantData(...)` or throws. The one-click button must show the same auth, waiting, missing-field, network, and success copy as the data panel. Multivariant collection must validate every uploaded Ozon row through the same server gate; do not silently preserve an incomplete anchor row.

- [ ] **Step 4: Run product and regression tests**

Run:

```bash
node extension/tests/ozon-product-complete-collection.test.js
node extension/tests/collector-removed.test.js
node extension/tests/fleet-collect-attrs-merge.test.js
node extension/tests/ozon-rich-content-page-json.test.js
node extension/tests/ozon-video-extract.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/content/ozon-product.js extension/tests/ozon-product-complete-collection.test.js extension/tests/collector-removed.test.js extension/tests/fleet-collect-attrs-merge.test.js
git commit -m "fix(extension): unify product collection completeness"
```

---

### Task 9: Package, verify, and perform the real-product acceptance check

**Files:**

- Regenerate: `app/public/sonli-extension-0.13.46.1/`
- Regenerate: `app/public/sonli-extension-0.13.46.1.zip`
- Regenerate when present: `app/dist/sonli-extension-0.13.46.1.zip`
- Create: `docs/superpowers/verification/2026-07-31-complete-ozon-collection-enrichment.md`

**Interfaces:**

- Source extension, public unpacked extension, and ZIP must be byte-consistent.
- Verification report must list changed contracts, focused/full tests, old-feature regression, skipped/unverified checks, external Ozon result, risk, and rollback commit.

- [ ] **Step 1: Run all focused tests together**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-contract.test.mjs server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/collector-ozon-enrichment-migration.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-routes.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs
node extension/tests/ozon-enrichment-contract.test.js
node extension/tests/collector-ozon-enrichment-client.test.js
node extension/tests/ozon-collect-coordinator.test.js
node extension/tests/data-panel-visual-browser.test.js
node extension/tests/ozon-product-complete-collection.test.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Package the extension**

Run: `node scripts/package-extension.mjs`

Expected: regenerated public directory and ZIP with the new runtime files included.

- [ ] **Step 3: Run the complete repository verification gate**

Run:

```bash
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/verify.mjs
```

Expected: App build, server syntax, all active tests, Docker interpolation, extension source/UI/diff/ZIP parity, security scans, collection contracts, and store-isolation checks pass. If the configured upstream directory is unavailable, record source parity as blocked rather than silently passing it.

- [ ] **Step 4: Run dedicated PostgreSQL validation only when explicitly configured**

Against a dedicated disposable database, run migrations through 020, repository lease concurrency, two-account isolation, and account deletion. Without an explicit dedicated URL, record PostgreSQL runtime validation as not run; do not reinterpret a configuration skip as a passed integration test.

- [ ] **Step 5: Reload the unpacked extension and test one real Ozon product**

Prerequisites: Web logged in, new Collector session issued with `collector.ozon.read`, and `seller.ozon.ru` logged in. Verify:

1. Opening the product starts prefetch but does not add a collection-box row.
2. Both visible collection buttons save exactly one row.
3. The Web collection edit page displays category, package weight, length, width, and height.
4. Repeating the click does not create a duplicate.
5. Logging out of Web changes the button to the Web-login prompt.

Do not claim real Ozon success unless all five observations are recorded with SKU, request ID, timestamps, and redacted diagnostics.

- [ ] **Step 6: Write the verification and rollback report**

Record:

- exact commits and files;
- API/permission/database contracts changed;
- focused and full verification outputs;
- sync, listing, account isolation, and non-Ozon source regressions checked;
- PostgreSQL or real-platform checks not run and why;
- rollback order: extension coordinator/client, server routes/service, permission, then runtime code; keep migration 020 tables in place because they are additive and harmless;
- recovery: restore service, reissue Collector session, and retry the same request ID.

- [ ] **Step 7: Commit generated artifacts and verification evidence**

```bash
git add app/public/sonli-extension-0.13.46.1 app/public/sonli-extension-0.13.46.1.zip app/dist/sonli-extension-0.13.46.1.zip docs/superpowers/verification/2026-07-31-complete-ozon-collection-enrichment.md
git commit -m "test: verify complete Ozon collection enrichment"
```

If `app/dist/sonli-extension-0.13.46.1.zip` is absent because the app build was not requested to retain it, omit only that path and state this in the verification report.
