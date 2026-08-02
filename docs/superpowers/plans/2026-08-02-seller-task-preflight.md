# Seller Task Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent background Collector polling from opening a Seller helper tab when the authenticated account has no currently claimable Ozon enrichment job.

**Architecture:** Add a fixed, permission-protected boolean availability query across repository, service, and HTTP route boundaries. Pass the existing Collector operation into the extension agent's preflight callback and call the availability route before any Seller-context recovery; preserve the existing claim and Seller watermark flow once work is available.

**Tech Stack:** Node.js ESM, `node:test`, Chrome Extension Manifest V3, JSON state repository, PostgreSQL, React/Vite packaging scripts.

## Global Constraints

- An empty queue must not create, refresh, focus, or close any Seller tab.
- The availability response is exactly `{ ok: true, available: boolean }`; it exposes no count, SKU, job, store, Seller company, or cross-account data.
- The availability query is read-only and must not claim jobs, update Seller context, write cache, or trigger external platform calls.
- Account scope, Collector session validity, and `collector.ozon.read` permission remain server-enforced.
- A failed preflight fails closed for the current drain and waits for a later explicit kick.
- A positive preflight is advisory; a subsequent empty claim is a normal concurrent outcome.
- JSON and PostgreSQL adapters use the same claimability conditions and account concurrency limit.
- No database migration is required.

---

### Task 1: Repository and Service Availability Contract

**Files:**
- Modify: `server/collector-ozon-enrichment-repository.mjs`
- Modify: `server/collector-ozon-enrichment-service.mjs`
- Test: `server/tests/collector-ozon-enrichment-repository.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-service.test.mjs`

**Interfaces:**
- Produces repository port: `hasClaimableJob({ accountId, collectorSessionId, now }): Promise<boolean>`.
- Produces service port: `hasAvailableJob({ session }): Promise<boolean>`.
- The repository result is advisory and read-only; `claimNextJob` remains the only claiming operation.

- [ ] **Step 1: Write failing JSON repository tests**

Add literal fixtures asserting `false` for an empty account, future `nextAttemptAt`, expired `deadlineAt`, invalid/cross-account session, and four live processing claims; assert `true` for one due pending job, an expired processing claim, and preferred-session fallback after one second. Snapshot the state before and after every successful availability query and assert deep equality.

- [ ] **Step 2: Run the JSON repository tests and verify RED**

Run:

```bash
node --test --test-name-pattern='availability|claimable' server/tests/collector-ozon-enrichment-repository.test.mjs
```

Expected: FAIL because `repository.hasClaimableJob` is missing.

- [ ] **Step 3: Write failing PostgreSQL repository contract tests**

Use the existing fake pool/query harness to assert one account/session-scoped boolean query with the same due/deadline/preference conditions and active-processing limit. Assert that another account's row cannot make the result true and that no `INSERT`, `UPDATE`, `DELETE`, advisory lock, or Seller-context write is emitted.

- [ ] **Step 4: Run the PostgreSQL repository tests and verify RED**

Run the same command and expect failure because the PostgreSQL adapter does not expose `hasClaimableJob`.

- [ ] **Step 5: Implement the minimal repository method in both adapters**

For JSON, serialize the read, validate the scoped Collector session, return `false` when four unexpired processing jobs already occupy the account, then evaluate the existing `claimNextJob` eligibility predicate without mutation. For PostgreSQL, validate the session inside one read-only account-scoped query and return `Boolean(rows[0]?.available)` using `EXISTS` plus the active-processing limit.

- [ ] **Step 6: Write the failing service test**

Add `hasClaimableJob` to the service harness repository. Assert `service.hasAvailableJob({ session })` passes only `accountId`, `collectorSessionId`, and the service clock to the repository and returns a strict boolean. Assert repository errors become the existing sanitized public upstream failure.

- [ ] **Step 7: Run the service test and verify RED**

Run:

```bash
node --test --test-name-pattern='available job|availability' server/tests/collector-ozon-enrichment-service.test.mjs
```

Expected: FAIL because `service.hasAvailableJob` is missing.

- [ ] **Step 8: Implement the service method and verify GREEN**

Add `hasClaimableJob` to the required repository methods, implement `hasAvailableJob({ session })` through `sessionScope` and `instant(now())`, sanitize repository failures with `publicServiceError`, and expose the method from the frozen service API.

Run:

```bash
node --test server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs
```

Expected: all assertions pass; PostgreSQL integration cases may explicitly skip only when their configured database URL is absent.

- [ ] **Step 9: Commit Task 1**

```bash
git add server/collector-ozon-enrichment-repository.mjs server/collector-ozon-enrichment-service.mjs server/tests/collector-ozon-enrichment-repository.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs
git commit -m "feat(server): expose enrichment work availability"
```

### Task 2: Fixed Collector Availability Route

**Files:**
- Modify: `server/collector-ozon-enrichment-routes.mjs`
- Test: `server/tests/collector-ozon-enrichment-routes.test.mjs`
- Test: `server/tests/collector-ozon-enrichment-contract.test.mjs`

**Interfaces:**
- Consumes: `service.hasAvailableJob({ session }): Promise<boolean>` from Task 1.
- Produces: `POST /collector/ozon/enrichment-jobs/available` with exact empty JSON body and exact response `{ ok: true, available: boolean }`.

- [ ] **Step 1: Write failing route tests**

Add the route to the existing harness and assert: `collector.ozon.read` authentication happens before service invocation; `{}` is the only accepted body; query parameters, Cookie control, account/store/company fields, unknown fields, and wrong methods are rejected; true and false responses expose only `ok` and `available`; a second account receives only its own service result.

- [ ] **Step 2: Run route tests and verify RED**

Run:

```bash
node --test --test-name-pattern='availability route|available' server/tests/collector-ozon-enrichment-routes.test.mjs
```

Expected: FAIL because the path is not registered and the service harness lacks the method.

- [ ] **Step 3: Implement the fixed route**

Add `AVAILABLE_PATH`, include it in namespace/method handling, require an empty object body with existing exact-key validation, call `service.hasAvailableJob({ session })`, and send the exact boolean envelope. Add `hasAvailableJob` to route dependency validation.

- [ ] **Step 4: Verify route and contract tests GREEN**

Run:

```bash
node --test server/tests/collector-ozon-enrichment-routes.test.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
```

Expected: all tests pass and no existing fixed route changes shape.

- [ ] **Step 5: Commit Task 2**

```bash
git add server/collector-ozon-enrichment-routes.mjs server/tests/collector-ozon-enrichment-routes.test.mjs server/tests/collector-ozon-enrichment-contract.test.mjs
git commit -m "feat(server): add enrichment availability route"
```

### Task 3: Extension Preflight Before Seller Recovery

**Files:**
- Modify: `extension/background/collector-ozon-enrichment-agent.js`
- Modify: `extension/background/service-worker.js`
- Test: `extension/tests/collector-ozon-enrichment-client.test.js`
- Test: `extension/tests/seller-company-context-contract.test.js`

**Interfaces:**
- Consumes: `POST /collector/ozon/enrichment-jobs/available` from Task 2.
- Changes agent dependency to `canCapture(collectorOperation): Promise<boolean>`.
- Preserves Seller recovery, claim, capture, terminal fencing, and lease release contracts after a positive preflight.

- [ ] **Step 1: Write the failing agent regression test**

Create a real agent harness for `drainAvailable` where `canCapture` returns `false`, Seller resolution increments a literal counter, and Collector claim would fail the test if called. Assert the drain completes, `canCapture` receives the existing operation, Seller resolution count is `0`, claim count is `0`, and no sleep loop occurs.

- [ ] **Step 2: Run the agent regression test and verify RED**

Run:

```bash
node --test --test-name-pattern='empty availability does not recover Seller|preflight' extension/tests/collector-ozon-enrichment-client.test.js
```

Expected: FAIL because `drainAvailable` currently bypasses `canCapture` before Seller recovery.

- [ ] **Step 3: Implement agent preflight ordering**

After the Collector operation is established and before entering Seller recovery, call `canCapture(collectorOperation)`. For a background `stopWhenEmpty` round, return the normal completed outcome when it is `false`; for a thrown/rejected preflight, return the existing failed outcome so a later kick can retry. Preserve cancellation checks before and after the await.

- [ ] **Step 4: Write failing service-worker bridge tests**

Assert the bridge's `canCapture(collectorOperation)` performs exactly one fixed Collector POST with permission `collector.ozon.read`, empty JSON body, and no Seller context fields. Assert `{ ok: true, available: false }` returns false, true returns true, malformed/non-OK responses fail closed, and no runtime Seller acquisition happens during the check.

- [ ] **Step 5: Run bridge tests and verify RED**

Run:

```bash
node --test --test-name-pattern='availability preflight|empty queue' extension/tests/seller-company-context-contract.test.js
```

Expected: FAIL because bridge `canCapture` currently returns `true` without a server request.

- [ ] **Step 6: Implement the service-worker preflight**

Use the supplied `collectorOperation` with `collectorSessionManager.collectorFetch` to POST `{}` to the fixed availability route. Return only a strict boolean from the exact success envelope; throw a stable safe error for missing permission, non-OK response, or malformed response. Do not start another Collector operation and do not call Seller runtime methods.

- [ ] **Step 7: Verify extension GREEN and regression behavior**

Run:

```bash
node --test extension/tests/collector-ozon-enrichment-client.test.js extension/tests/seller-company-context-contract.test.js
```

Expected: all tests pass, including existing cancellation, helper ownership, Seller switch, and terminal fence cases.

- [ ] **Step 8: Commit Task 3**

```bash
git add extension/background/collector-ozon-enrichment-agent.js extension/background/service-worker.js extension/tests/collector-ozon-enrichment-client.test.js extension/tests/seller-company-context-contract.test.js
git commit -m "fix(extension): preflight work before Seller recovery"
```

### Task 4: Integration Verification and Extension Release

**Files:**
- Regenerate: `app/public/sonli-extension-0.13.46.2/`
- Regenerate: `app/public/sonli-extension-0.13.46.2.zip`
- Regenerate: `app/dist/sonli-extension-0.13.46.2.zip`
- Update when tracked by the release script: copied extension source files under `app/public/sonli-extension-0.13.46.2/`

**Interfaces:**
- Consumes all earlier task contracts.
- Produces byte-consistent unpacked and ZIP release artifacts for extension version `0.13.46.2`.

- [ ] **Step 1: Run focused cross-layer regression tests**

Run the repository, service, route, agent, Seller-context, linked-runtime, completeness, and contract test files. Expected: zero failures; PostgreSQL integration may skip only when `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.

- [ ] **Step 2: Run the active test manifest**

Use the repository's active-test manifest command with the bundled Node runtime. Expected: zero code failures; record the exact passed and environment-skipped counts. Keep the known same-version `QH_SOURCE_EXTENSION_DIR` comparison gate separate when its required source directory is absent.

- [ ] **Step 3: Build the Web application**

Run:

```bash
pnpm --dir app build
```

Expected: production build exits zero; only the pre-existing large-chunk warning is allowed.

- [ ] **Step 4: Regenerate extension artifacts**

Run the existing extension packaging script for `0.13.46.2`. Verify the extension source tree, public unpacked directory, public ZIP, and dist ZIP contain the same files and bytes.

- [ ] **Step 5: Run ZIP parity and startup smoke tests**

Expected: both ZIPs contain the full tracked extension file set, pass startup smoke, and have identical SHA-256 hashes.

- [ ] **Step 6: Review security and delivery gates**

Run `git diff --check`, the credential/personal-data scan, Collector readiness gates, and confirm the availability response never exposes counts or identifiers. Record unverified real PostgreSQL, Seller, and Ozon environments without claiming them as passed.

- [ ] **Step 7: Commit regenerated release artifacts**

```bash
git add app/public/sonli-extension-0.13.46.2 app/public/sonli-extension-0.13.46.2.zip app/dist/sonli-extension-0.13.46.2.zip
git commit -m "chore(extension): package Seller preflight fix"
```

- [ ] **Step 8: Independent review**

Provide the reviewer the design, plan, complete commit range, focused test output, active-suite counts, build result, ZIP hashes, and explicit environment skips. Ready requires zero Critical or Important findings and a clean worktree.
