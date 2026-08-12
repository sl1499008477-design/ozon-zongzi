# Auto Listing Source Snapshot Contract Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an unchanged collect/product draft to produce a new immutable CNY-aware source snapshot without overwriting or conflicting with its historical RUB snapshot.

**Architecture:** Add one stable source-snapshot contract suffix at the PostgreSQL source-loading boundary and use it identically for Collect Box and Excel sources. Preserve the existing source-snapshot uniqueness constraint and immutable rows; improve the server/client safe error message for any genuine future version conflict. Prove the upgrade with unit tests plus the existing real-service, real-PostgreSQL, loopback-fake-Ozon E2E.

**Tech Stack:** Node.js 24, native `node:test`, PostgreSQL 16, SQL migrations 001–062, React 19, Ant Design 6, Vite 6.

## Global Constraints

- Preserve every historical source snapshot, task, event, and failure record byte-for-byte.
- Do not relax `(account_id, source_type, source_record_id, source_version)` uniqueness or conflict checks.
- `AUTO_LISTING_SOURCE_SNAPSHOT_V2` is the exact contract token used by both Collect Box and Excel loaders.
- The new source version is deterministic for the same product draft version and raw payload identity.
- Do not add a database migration; old and new source versions coexist under the current schema.
- Do not call real Ozon writes, real/paid AI, or a production database during implementation or verification.
- Keep account, store, collect item, warehouse, idempotency, and correlation boundaries unchanged.

---

### Task 1: Version Collect Box and Excel Source Identities

**Files:**
- Modify: `server/auto-listing-repository.mjs:680-795`
- Test: `server/tests/auto-listing-repository.test.mjs`
- Test: `server/tests/auto-listing-postgres.integration.mjs`
- Test: `server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs`

**Interfaces:**
- Consumes: PostgreSQL source rows with `draft_id`, `draft_version`, `payload_hash`, and `raw_response_ref`.
- Produces: internal `sourceSnapshotVersion(row): string`, returning `draft:<version>:<payload-identity>:AUTO_LISTING_SOURCE_SNAPSHOT_V2` or `raw:<payload-identity>:AUTO_LISTING_SOURCE_SNAPSHOT_V2`.

- [ ] **Step 1: Write the failing repository tests**

Add an exact assertion to the existing Excel source test:

```js
assert.equal(
  result.sources[0].sourceVersion,
  "raw:hash-1:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
);
```

Add a Collect Box read-path test whose fake query returns one draft-backed row and one raw-backed row, then assert:

```js
assert.deepEqual(result.map(({ sourceVersion }) => sourceVersion), [
  "draft:7:payload-draft:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
  "raw:payload-raw:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
]);
```

In the real PostgreSQL test, strengthen the existing linked-source assertion:

```js
assert.equal(
  linked[0].sourceVersion,
  "draft:7:payload-one:AUTO_LISTING_SOURCE_SNAPSHOT_V2",
);
```

In the existing RFBS full E2E, import `buildAutoListingBlockedSourceEvidence`. Immediately before the existing `cny-success` task creation, seed an unsuffixed legacy snapshot:

```js
const cnyScenario = await seedScenario("cny-success", {
  currency: "CNY",
  sourceCurrency: null,
});
const [cnySource] = await creationRepository.loadCollectSources({
  accountId: cnyScenario.account,
  collectItemIds: [cnyScenario.collect],
});
const contractSuffix = ":AUTO_LISTING_SOURCE_SNAPSHOT_V2";
assert.equal(cnySource.sourceVersion.endsWith(contractSuffix), true);
const legacySourceVersion = cnySource.sourceVersion.slice(0, -contractSuffix.length);
const legacyEvidence = buildAutoListingBlockedSourceEvidence({
  accountId: cnyScenario.account,
  sourceType: "COLLECT_BOX",
  sourceRecordId: cnyScenario.collect,
  sourceVersion: legacySourceVersion,
  productDraft: cnySource.productDraft,
  rawResponseRef: cnySource.rawResponseRef,
  rawResponseHash: cnySource.rawResponseHash,
  rawCollectedAt: cnySource.rawCollectedAt,
  failureCode: "AUTO_LISTING_SOURCE_CURRENCY_NOT_RUB",
});
await pool.query(`INSERT INTO auto_listing_source_snapshots (
  id,account_id,source_type,source_record_id,source_version,snapshot,snapshot_hash,raw_response_ref
) VALUES ($1,$2,'COLLECT_BOX',$3,$4,$5::jsonb,$6,$7)`, [
  `legacy-currency-${suffix}`, cnyScenario.account, cnyScenario.collect,
  legacySourceVersion, JSON.stringify(legacyEvidence.blockedEvidence),
  legacyEvidence.snapshotHash, legacyEvidence.rawResponseRef,
]);
```

After creating the CNY job through the existing real service chain, assert both immutable versions remain:

```js
const versionRows = (await pool.query(`SELECT source_version,snapshot_hash
  FROM auto_listing_source_snapshots
  WHERE account_id=$1 AND source_record_id=$2 ORDER BY source_version`,
[cnyScenario.account, cnyScenario.collect])).rows;
assert.equal(versionRows.length, 2);
assert.equal(versionRows.some(({ source_version }) => source_version === legacySourceVersion), true);
assert.equal(versionRows.some(({ source_version }) => source_version === cnySource.sourceVersion), true);
assert.equal(versionRows.find(({ source_version }) => source_version === legacySourceVersion).snapshot_hash,
  legacyEvidence.snapshotHash);
```

Retain the exact one-call CNY import and stock assertions.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-repository.test.mjs
```

Expected: the new exact source-version assertions fail because the current values are `raw:hash-1`, `draft:7:payload-draft`, and `raw:payload-raw` without the contract suffix.

- [ ] **Step 3: Start disposable PostgreSQL and verify the real E2E RED**

Run:

```bash
docker run -d --rm --name codex-source-version-pg \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid \
  postgres:16-alpine
docker inspect --format '{{json .Mounts}}' codex-source-version-pg
docker port codex-source-version-pg 5432/tcp
```

Set `SOURCE_VERSION_PG_PORT` to the reported random loopback port and run:

```bash
AUTO_LISTING_POSTGRES_TESTS=1 \
SONLI_MIGRATION_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${SOURCE_VERSION_PG_PORT}/postgres" \
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs
```

Expected: fail before task creation because `cnySource.sourceVersion.endsWith(contractSuffix)` is false. Confirm `Mounts=[]` and zero product/stock writes from the failing scenario.

- [ ] **Step 4: Implement one closed source-version helper**

Add beside the repository scalar helpers:

```js
const SOURCE_SNAPSHOT_CONTRACT_VERSION = "AUTO_LISTING_SOURCE_SNAPSHOT_V2";

function sourceSnapshotVersion(row = {}) {
  const payloadIdentity = row.payload_hash || row.raw_response_ref || "missing";
  const businessVersion = row.draft_id
    ? `draft:${row.draft_version}:${payloadIdentity}`
    : `raw:${payloadIdentity}`;
  return `${businessVersion}:${SOURCE_SNAPSHOT_CONTRACT_VERSION}`;
}
```

Replace both duplicated `sourceVersion` expressions in `loadCollectSources()` and `loadExcelImportSources()` with:

```js
sourceVersion: sourceSnapshotVersion(row),
```

- [ ] **Step 5: Run focused and real-PG tests and verify GREEN**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-repository.test.mjs
```

Then rerun the real E2E command from Step 3.

Expected: all repository tests pass and E2E is 1/1 pass with zero skip; the legacy hash remains unchanged, the new CNY source version coexists, and fake Ozon sees exactly one CNY import and one stock call.

- [ ] **Step 6: Commit Task 1**

```bash
git add server/auto-listing-repository.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-postgres.integration.mjs \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs
git commit -m "fix(auto-listing): version source snapshot contracts"
```

---

### Task 2: Expose a Safe Actionable Version-Conflict Message

**Files:**
- Modify: `server/auto-listing-routes.mjs:190-225`
- Modify: `app/src/auto-listing-config.js:242-265`
- Test: `server/tests/auto-listing-routes.test.mjs`
- Test: `app/tests/auto-listing-config.test.mjs`

**Interfaces:**
- Consumes: service error code `AUTO_LISTING_SOURCE_VERSION_CONFLICT`.
- Produces: HTTP 409 with fixed Chinese message `来源资料版本已变化，请刷新后重试`; frontend `autoListingTaskErrorMessage(error)` returns the same text without exposing raw error fields.

- [ ] **Step 1: Change tests first**

In both route error matrices, change only the expected message for `AUTO_LISTING_SOURCE_VERSION_CONFLICT`:

```js
{
  status: 409,
  payload: {
    ok: false,
    code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
    message: "来源资料版本已变化，请刷新后重试",
    correlationId: "corr_1",
  },
}
```

Add a frontend mapping test:

```js
assert.equal(
  autoListingTaskErrorMessage({
    code: "AUTO_LISTING_SOURCE_VERSION_CONFLICT",
    message: "untrusted raw backend text",
  }),
  "来源资料版本已变化，请刷新后重试",
);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-routes.test.mjs \
  app/tests/auto-listing-config.test.mjs
```

Expected: route tests still receive `自动上架请求处理失败`; the frontend test receives the untrusted fallback message.

- [ ] **Step 3: Add fixed server and client mappings**

In `messageFor(code)` add:

```js
if (code === "AUTO_LISTING_SOURCE_VERSION_CONFLICT") {
  return "来源资料版本已变化，请刷新后重试";
}
```

In `AUTO_LISTING_RFBS_ERROR_MESSAGES` add:

```js
AUTO_LISTING_SOURCE_VERSION_CONFLICT: "来源资料版本已变化，请刷新后重试",
```

Keep the existing 409 allowlist entry and safe envelope unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same two-file command from Step 2.

Expected: all route and frontend configuration tests pass; injected secret-like backend messages remain absent from responses.

- [ ] **Step 5: Commit Task 2**

```bash
git add server/auto-listing-routes.mjs server/tests/auto-listing-routes.test.mjs \
  app/src/auto-listing-config.js app/tests/auto-listing-config.test.mjs
git commit -m "fix(auto-listing): explain source version conflicts"
```

---

### Task 3: Final Regression, Local Acceptance, and Recovery Record

**Files:**
- Create: `docs/verification/2026-08-12-auto-listing-source-capture-versioning.md`

**Interfaces:**
- Consumes: real migrations 001–062, actual create service/repository, upload service, standard submission worker, and loopback fake Ozon.
- Produces: a tested implementation SHA, local acceptance evidence, and an explicit recovery record.

- [ ] **Step 1: Run complete focused and adjacent regressions**

Run non-PG tests:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-source-snapshot.test.mjs \
  server/tests/auto-listing-routes.test.mjs \
  app/tests/auto-listing-config.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
```

Run real-PG tests against the disposable port:

```bash
AUTO_LISTING_POSTGRES_TESTS=1 \
SONLI_MIGRATION_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:${SOURCE_VERSION_PG_PORT}/postgres" \
DATABASE_URL="postgresql://postgres@127.0.0.1:${SOURCE_VERSION_PG_PORT}/postgres" \
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-postgres.integration.mjs \
  server/tests/auto-listing-upload-postgres.integration.test.mjs \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs \
  server/tests/auto-listing-store-currency-migration.integration.test.mjs
```

Require zero failures and zero PostgreSQL skips.

- [ ] **Step 2: Build and run static gates**

```bash
export PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
node --check server/auto-listing-repository.mjs
node --check server/auto-listing-routes.mjs
node --check app/src/auto-listing-config.js
git diff --check
```

Expected: build and syntax checks pass; only the existing Vite large-chunk warning may remain.

- [ ] **Step 3: Write the verification record**

Write `docs/verification/2026-08-12-auto-listing-source-capture-versioning.md` with:

- exact tested implementation SHA;
- RED and GREEN counts;
- disposable PostgreSQL version, loopback port, `Mounts=[]`, and zero skips;
- historical and suffixed snapshot hashes proving coexistence;
- fake Ozon call counts;
- explicit statement that real Ozon writes, paid AI, and production data were not used;
- rollback rule: revert application code but preserve all new immutable source snapshots.

Then commit it separately:

```bash
git add docs/verification/2026-08-12-auto-listing-source-capture-versioning.md
git commit -m "docs(auto-listing): record source version recovery"
```

- [ ] **Step 4: Restart local services and perform browser acceptance**

Apply no database migration. Restart the existing `pnpm dev` process from `main`, reload:

```text
http://127.0.0.1:3000/ozon/tools/auto-listing/?source=collect&ids=collect_ccab18d873aa2c8074555143
```

Confirm the page still shows `粽子测试（人民币 CNY）`, `售价加减（人民币 ¥）`, and `CEL-测试`. Before clicking create, confirm the paid AI worker is not running. Submit once using the user's already-approved intent and capture the response:

```js
assert.equal(response.status, 200);
assert.equal(response.body.ok, true);
```

Then verify the task list shows a new item/job with store name `粽子测试`. Do not start the paid AI worker, upload worker, or any real Ozon product/stock write.

- [ ] **Step 5: Remove disposable resources and report recovery**

```bash
docker stop --timeout 0 codex-source-version-pg
docker ps -a --filter name=^/codex-source-version-pg$ --format '{{.Names}}'
git status --short
```

Expected: no matching container remains and the worktree is clean.
