# Account-Scoped Collection and Backend-Only Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser extension a capture-only client authenticated by the existing Web login, move all Ozon store synchronization to the backend, remove the runtime “data collection store” concept, and keep every collection record isolated by sonli account until a target operating store is selected for listing.

**Architecture:** Add one-time collector tickets and scoped collector sessions behind focused server modules. The Web page requests a ticket with its normal login, the extension exchanges it for a short-lived collector token, and collector endpoints derive account ownership from that token. New collection data is account-scoped and store-neutral; listing freezes a validated target operating store in the existing submission snapshot/job. Web store sync uses one backend-only coordinator, while extension sync code, messages, permissions, and UI are removed. Historical data-store tables and columns remain as read-only evidence during this release.

**Tech Stack:** Node.js ESM/CommonJS, PostgreSQL migrations and `pg`, React 19, Ant Design, Chrome Manifest V3, Node test runner, Vite, existing extension packaging/parity scripts.

## Global Constraints

- Follow the confirmed design in `docs/superpowers/specs/2026-07-29-account-scoped-collection-backend-only-sync-design.md`.
- Derive `accountId`, `createdBy`, permissions, and session identity on the server. Never trust those fields from extension request bodies.
- Store only SHA-256 hashes of collector tickets and collector tokens. Never log or return their hashes.
- A collector ticket is one-use, expires after 60 seconds, and must be consumed atomically.
- A collector session expires after at most 8 hours and never later than its parent Web session.
- Collector permissions are exactly `collector.upload`, `collector.job.read`, and `collector.config.read`.
- Every collector request rechecks the account, parent Web session, collector session, and required permission.
- All new collection rows must have `account_id`; collection-stage store fields are nullable and are not written by new runtime code.
- Keep historical `data_collection_store_id` columns and tables for rollback and audit. Do not physically drop them in this plan.
- The extension must not call or trigger store synchronization and must not request `https://api-seller.ozon.ru/*`.
- The Web must call backend synchronization directly for `WAREHOUSES`, `PRODUCTS`, `POSTINGS`, and `PROMOTIONS`.
- Preserve user changes already present in the worktree. Before each task, run `git status --short` and inspect overlapping diffs.
- Use TDD: add the named failing test first, observe the expected failure, implement the minimum behavior, then rerun the focused test.
- After each task, run `git diff --check` and commit only that task's files.
- PostgreSQL integration tests may run only against a clearly dedicated test database. Never point them at development or production data.
- Generated extension copies under `app/public/sonli-extension-<version>/` and ZIP archives are updated only in the packaging task, after source behavior is stable.
- On this workstation, initialize each implementation terminal with the bundled runtime before using the commands below:

```bash
export PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
node --version
pnpm --version
```

  Expected baseline: Node `v24.14.0` and pnpm `11.9.0`. Do not run `pnpm exec node`; it may trigger an unnecessary dependency install when `node` is absent from the original PATH.

---

## Task 1: Add the additive database migration and fail-closed ownership checks

**Files:**

- Create: `server/db/migrations/019_account_scoped_collection_and_collector_sessions.sql`
- Create: `server/tests/account-scoped-collection-migration.integration.mjs`
- Modify: `scripts/test-manifest.mjs`
- Modify: `server/tests/collection-pipeline-v4.integration.mjs`
- Modify: `server/tests/collector-desktop.integration.mjs`

**Contract introduced:**

```sql
collector_auth_tickets(
  id,
  ticket_hash UNIQUE,
  account_id,
  parent_session_token,
  permissions,
  expires_at,
  consumed_at,
  created_at
)

collector_sessions(
  id,
  token_hash UNIQUE,
  account_id,
  parent_session_token,
  device_fingerprint,
  extension_version,
  permissions,
  expires_at,
  revoked_at,
  revoked_reason,
  last_seen_at,
  created_at
)
```

`parent_session_token` is an internal foreign key to the existing `sessions(token)` row. It is never returned to the extension or written to logs.

- [ ] **Step 1: Write the failing migration behavior test**

In `server/tests/account-scoped-collection-migration.integration.mjs`, require
`SONLI_MIGRATION_TEST_DATABASE_URL`, create a unique temporary schema, run migrations
001–018 inside that schema, insert controlled legacy fixtures, then execute migration
019 and inspect actual PostgreSQL behavior:

- ticket/session tables accept valid hashed records and enforce unique hashes;
- ticket consumption changes one row once;
- account IDs become non-nullable;
- collection-stage store/data-store columns accept `NULL`;
- account-scoped identity/idempotency indexes allow the same request identity in two
  accounts but reject a duplicate inside one account;
- historical data-store tables, columns, values, and foreign-key references remain;
- a second fixture with an ambiguous/unowned record makes migration 019 raise an
  exception containing the table and record ID.

Drop the temporary schema in `finally`. Add this test to
`historicalTestExclusions` because it may run only against a dedicated database.

- [ ] **Step 2: Run the test and confirm it fails because migration 019 does not exist**

Run:

```bash
SONLI_MIGRATION_TEST_DATABASE_URL="$DEDICATED_TEST_DATABASE_URL" node server/tests/account-scoped-collection-migration.integration.mjs
```

Expected: failure with `ENOENT` for migration 019 after the controlled pre-019 schema
and fixtures are ready. A missing dedicated database is a blocked environment, not a
passing test.

- [ ] **Step 3: Implement the migration**

The migration must:

1. Use `DO $$ ... RAISE EXCEPTION ... $$` checks before `SET NOT NULL`.
2. Backfill only from authoritative, unique relationships:
   - `collect_raw_payloads.account_id` from its `collect_items.account_id`;
   - `collect_requests.account_id` from its `collect_item_id`;
   - collector child rows from their task/run account.
3. Refuse migration when an affected row still has no unique account. Include table name and record ID in the exception.
4. Set `collect_items.account_id`, `collect_raw_payloads.account_id`, and `collect_requests.account_id` to `NOT NULL`.
5. Drop `NOT NULL` from collection-stage `store_id`, `operating_store_id`, and `data_collection_store_id` columns where present.
6. Replace store/data-store identity indexes with account-scoped indexes:

```sql
DROP INDEX IF EXISTS collect_items_identity_key_uq;
CREATE UNIQUE INDEX collect_items_account_identity_key_uq
  ON collect_items(account_id, identity_key)
  WHERE identity_key <> '';

DROP INDEX IF EXISTS collect_requests_account_idempotency_uq;
CREATE UNIQUE INDEX collect_requests_account_request_uq
  ON collect_requests(account_id, source, source_sku, idempotency_key);
```

7. Create ticket/session expiry and account lookup indexes.
8. Preserve the old store/data-store values and foreign keys as nullable historical evidence.

- [ ] **Step 4: Extend dedicated-database integration assertions**

Update the two excluded integration tests so that, when manually run against a dedicated database, they verify:

- collection without an operating store or data store succeeds;
- old rows keep their legacy data-store ID;
- a deliberately unowned legacy row makes the migration fail;
- ticket/session rows cascade when the account is deleted;
- ticket consumption can mark exactly one row consumed.

- [ ] **Step 5: Run focused verification**

Run:

```bash
SONLI_MIGRATION_TEST_DATABASE_URL="$DEDICATED_TEST_DATABASE_URL" node server/tests/account-scoped-collection-migration.integration.mjs
node --check server/db/migrate.mjs
git diff --check
```

If a dedicated PostgreSQL test URL is explicitly configured, also run:

```bash
node server/tests/collection-pipeline-v4.integration.mjs
node server/tests/collector-desktop.integration.mjs
```

Otherwise record both as unverified environment-dependent checks.

- [ ] **Step 6: Commit**

```bash
git add server/db/migrations/019_account_scoped_collection_and_collector_sessions.sql server/tests/account-scoped-collection-migration.integration.mjs scripts/test-manifest.mjs server/tests/collection-pipeline-v4.integration.mjs server/tests/collector-desktop.integration.mjs
git commit -m "db: add account-scoped collector sessions"
```

---

## Task 2: Implement collector ticket and scoped-session domain services

**Files:**

- Create: `server/collector-auth-service.mjs`
- Create: `server/collector-auth-repository.mjs`
- Create: `server/tests/collector-auth-service.test.mjs`
- Modify: `server/formal-persistence.mjs`

**Stable service interface:**

```js
createCollectorAuthService({
  repository,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  audit = async () => {},
}).issueTicket({ account, parentSessionToken })

.exchangeTicket({
  ticket,
  deviceFingerprint,
  extensionVersion,
})

.authenticate({
  collectorToken,
  requiredPermission,
})

.revoke({
  parentSessionToken,
  accountId,
  reason,
})
```

**Repository interface:**

```js
{
  createTicket(record),
  consumeTicketAtomically({ ticketHash, now }),
  createSession(record),
  findActiveSession({ tokenHash, now }),
  touchSession({ sessionId, now }),
  revokeSessions({ parentSessionToken, accountId, reason, now }),
}
```

- [ ] **Step 1: Write failing unit tests with an in-memory fake repository**

Cover:

- ticket plaintext is returned once, repository receives only a SHA-256 hash;
- ticket expires at 60 seconds;
- consuming the same ticket twice returns `COLLECTOR_TICKET_USED`;
- expired ticket returns `COLLECTOR_TICKET_EXPIRED`;
- session expiry is `min(now + 8h, parentSession.expiresAt)`;
- permissions are the exact three allowed permissions;
- wrong required permission returns 403;
- inactive account, revoked parent session, revoked collector session, and expired collector session are rejected;
- `touchSession` updates last use without exposing tokens;
- audits contain IDs and outcomes but no ticket/token plaintext.

- [ ] **Step 2: Run and observe the missing-module failure**

```bash
node --test server/tests/collector-auth-service.test.mjs
```

- [ ] **Step 3: Implement pure token helpers and service errors**

Use focused helpers:

```js
export const COLLECTOR_PERMISSIONS = Object.freeze([
  "collector.upload",
  "collector.job.read",
  "collector.config.read",
]);

export function hashCollectorSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function opaqueSecret(prefix, randomBytes) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
```

Define errors with stable `status` and `code`; do not include secret values in messages.

- [ ] **Step 4: Implement PostgreSQL and JSON-state repositories**

- PostgreSQL `consumeTicketAtomically` must use one statement equivalent to:

```sql
UPDATE collector_auth_tickets
SET consumed_at = NOW()
WHERE ticket_hash = $1
  AND consumed_at IS NULL
  AND expires_at > NOW()
RETURNING *;
```

- JSON-state fallback must serialize consume/write operations through a module-local promise queue so two same-process exchanges cannot both succeed.
- JSON state fields are `collectorAuthTickets` and `collectorSessions`; only hashes are stored.
- Extend `formal-persistence.mjs` so JSON state mirroring never puts plaintext collector secrets into relational rows.

- [ ] **Step 5: Run focused tests**

```bash
node --test server/tests/collector-auth-service.test.mjs
node --check server/collector-auth-service.mjs
node --check server/collector-auth-repository.mjs
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add server/collector-auth-service.mjs server/collector-auth-repository.mjs server/tests/collector-auth-service.test.mjs server/formal-persistence.mjs
git commit -m "feat: add scoped collector auth service"
```

---

## Task 3: Add collector-auth HTTP routes and revocation wiring

**Files:**

- Create: `server/collector-auth-routes.mjs`
- Create: `server/tests/collector-auth-routes.test.mjs`
- Modify: `server/index.mjs`
- Modify: `server/persistence.mjs`
- Modify: `server/tests/account-multi-session.test.mjs`
- Modify: `server/tests/audit-route-integration.test.mjs`

**HTTP contracts:**

```http
POST /extension/collector-auth/ticket
Authorization: Bearer <web-token>

200 {
  "ok": true,
  "ticket": "...",
  "expiresAt": "...",
  "requestId": "..."
}
```

```http
POST /extension/collector-auth/exchange
Content-Type: application/json

{
  "ticket": "...",
  "deviceFingerprint": "...",
  "extensionVersion": "..."
}

200 {
  "ok": true,
  "collectorToken": "...",
  "expiresAt": "...",
  "account": { "id": "...", "displayName": "..." },
  "permissions": ["collector.upload", "collector.job.read", "collector.config.read"]
}
```

```http
GET /extension/collector-auth/status
Authorization: Collector <collector-token>
```

- [ ] **Step 1: Write failing route tests**

Use the existing `Readable` request/response pattern from `server/tests/account-multi-session.test.mjs`. Verify:

- ticket route requires a valid Web bearer session;
- request body cannot override account ID or permissions;
- exchange is public only in the sense that it accepts a ticket; missing/invalid ticket is 401;
- status accepts only `Authorization: Collector ...`, not a Web bearer token;
- ticket and token never appear in audit metadata;
- CORS allows `Authorization` but no new broad origin is added.

- [ ] **Step 2: Run failing tests**

```bash
node --test server/tests/collector-auth-routes.test.mjs
```

- [ ] **Step 3: Implement the focused route handler**

Export:

```js
export function createCollectorAuthHttpHandler({
  requireWebAuth,
  findParentSession,
  authService,
  readJson,
  sendJson,
}) {
  return async function handleCollectorAuthRoute(req, res, url) {
    // Match only the three documented collector-auth routes, delegate to
    // authService, send the stable response, and return true. Return false
    // for every unrelated route.
  };
}
```

Return `false` for unrelated routes so `server/index.mjs` remains the central router without absorbing auth logic.

- [ ] **Step 4: Wire routes before general local routes**

In `server/index.mjs`:

- construct the repository and service once;
- pass `requireAuth(req, state)` and the actual bearer token only on the ticket route;
- save JSON-state fallback mutations;
- install `handleCollectorAuthHttpRoute` before collector upload routes;
- add audit actions `COLLECTOR_TICKET_ISSUED`, `COLLECTOR_TICKET_EXCHANGED`, `COLLECTOR_SESSION_REVOKED`, and `COLLECTOR_SESSION_REJECTED`.

- [ ] **Step 5: Revoke child sessions with their parent Web session**

Extend `revokePersistedSessions` and JSON-state logout/update/delete paths so:

```js
await revokeCollectorSessions({
  parentSessionToken: token,
  reason: "logout",
});
```

is executed on:

- Web logout;
- password change;
- account disabled or expired;
- account deletion.

Do not revoke other active Web sessions when only one session logs out.

- [ ] **Step 6: Run focused regression tests**

```bash
node --test server/tests/collector-auth-routes.test.mjs server/tests/account-multi-session.test.mjs server/tests/audit-route-integration.test.mjs
node --check server/index.mjs
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add server/collector-auth-routes.mjs server/tests/collector-auth-routes.test.mjs server/index.mjs server/persistence.mjs server/tests/account-multi-session.test.mjs server/tests/audit-route-integration.test.mjs
git commit -m "feat: expose collector auth exchange"
```

---

## Task 4: Make collection uploads account-scoped and collector-token authenticated

**Files:**

- Modify: `server/collection-pipeline.mjs`
- Modify: `server/listing-pipeline.mjs`
- Modify: `server/collector-routes.mjs`
- Modify: `server/index.mjs`
- Create: `server/tests/account-scoped-collection.test.mjs`
- Modify: `server/tests/collector-routes.test.mjs`
- Modify: `server/tests/collector-selection-service.test.mjs`
- Modify: `server/tests/collect-multivariant-ingest.test.mjs`
- Modify: `server/tests/collect-multivariant-payload.test.mjs`

**New collection input:**

```js
{
  source,
  sourceSku,
  sourceUrl,
  requestId,
  deviceFingerprint,
  capturedAt,
  payload
}
```

Client-provided `accountId`, `createdBy`, `storeId`, `operatingStoreId`, `dataCollectionStoreId`, and `sellerCompanyId` are rejected with `COLLECTOR_SCOPE_FIELD_FORBIDDEN`.

- [ ] **Step 1: Write failing account-boundary and idempotency tests**

Verify:

- an account with zero operating stores can upload;
- the stored item/raw payload/request have the authenticated account and null store fields;
- account A cannot read, update, delete, export, or prepare account B's item;
- same account + source + source SKU + request ID + same content returns the original result;
- same identity with different content returns 409 `COLLECT_REQUEST_CONFLICT`;
- different accounts may reuse the same request ID;
- request body scope fields are rejected, not silently honored.

- [ ] **Step 2: Run failing tests**

```bash
node --test server/tests/account-scoped-collection.test.mjs server/tests/collector-routes.test.mjs
```

- [ ] **Step 3: Replace collection identity construction**

In `server/collection-pipeline.mjs` use:

```js
const identity = {
  accountId: authenticatedAccount.id,
  source: clean(input.source),
  sourceSku: clean(input.sourceSku),
  requestId: clean(input.requestId),
};

const idempotencyKey = sha256([
  identity.accountId,
  identity.source,
  identity.sourceSku,
  identity.requestId,
].join("|"));
```

Require a stable source key (`sourceSku` or another normalized source identifier) and `requestId`. Keep `contentHash` separate so conflicting replays can be detected.

- [ ] **Step 4: Stop writing store/data-store scope in collection-stage persistence**

Update insert/update/select mapping so:

- `collect_items.account_id` and `collect_raw_payloads.account_id` are mandatory;
- `store_id` and `data_collection_store_id` are inserted as `NULL`;
- existing non-null historical values are returned only in a `legacyScope` object when needed for audit, not in the new write contract;
- item update/delete/list/export queries always include `account_id=$n`.

- [ ] **Step 5: Authenticate collector routes by permission**

Route permission map:

```js
const permissionByAction = {
  upload: "collector.upload",
  readJob: "collector.job.read",
  readConfig: "collector.config.read",
};
```

Normal Web bearer sessions may continue using Web-only collection/listing APIs. Extension upload/job/config routes must use the scoped collector token and must never gain store sync or listing-submit access.

- [ ] **Step 6: Run collection regression tests**

```bash
node --test \
  server/tests/account-scoped-collection.test.mjs \
  server/tests/collector-routes.test.mjs \
  server/tests/collector-selection-service.test.mjs \
  server/tests/collect-multivariant-ingest.test.mjs \
  server/tests/collect-multivariant-payload.test.mjs \
  server/tests/account-store-isolation.test.mjs
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add server/collection-pipeline.mjs server/listing-pipeline.mjs server/collector-routes.mjs server/index.mjs server/tests/account-scoped-collection.test.mjs server/tests/collector-routes.test.mjs server/tests/collector-selection-service.test.mjs server/tests/collect-multivariant-ingest.test.mjs server/tests/collect-multivariant-payload.test.mjs
git commit -m "feat: scope collection uploads by account"
```

---

## Task 5: Freeze the target operating store only when preparing a listing

**Files:**

- Modify: `server/listing-pipeline.mjs`
- Modify: `server/listing-worker.mjs`
- Modify: `server/listing-submission-policy.mjs`
- Modify: `server/tests/listing-submission-policy.test.mjs`
- Modify: `server/tests/collect-listing-submit-failure.test.mjs`
- Modify: `server/tests/listing-pipeline-v3.integration.mjs`
- Modify: `app/src/App.jsx`
- Create: `app/src/collect-box-target-store.js`
- Create: `app/tests/collect-box-target-store.test.mjs`

**Preparation contract:**

```js
prepareCollectItemForListing({
  accountId,       // server-derived
  collectItemId,
  targetStoreId,   // explicitly chosen by user
  idempotencyKey,
})
```

The existing `submission_snapshots.store_id` and `submission_jobs.store_id` become the immutable target store record. Do not use `currentStoreId` after preparation starts.

- [ ] **Step 1: Write failing target-store policy tests**

Verify:

- missing `targetStoreId` returns `TARGET_STORE_REQUIRED`;
- a store owned by another account returns 404/403 without revealing it;
- disabled store or missing credentials returns a stable validation error;
- switching the current Web store after snapshot creation does not change snapshot/job store ID;
- retrying the same idempotency key uses the same frozen target;
- changing target store with the same idempotency key returns conflict.

- [ ] **Step 2: Run failing tests**

```bash
node --test server/tests/listing-submission-policy.test.mjs server/tests/collect-listing-submit-failure.test.mjs app/tests/collect-box-target-store.test.mjs
```

- [ ] **Step 3: Implement server-side target validation and snapshot**

Before creating a submission snapshot:

```js
const target = await assertUsableOperatingStore({
  accountId,
  storeId: targetStoreId,
  requireCredentials: true,
});
```

Write `target.id` to snapshot and job once. Include non-secret target metadata in snapshot audit metadata (`label`, `clientId`, `currencyCode`, validation time), but never API credentials.

- [ ] **Step 4: Add a focused Web target-store selector helper**

`app/src/collect-box-target-store.js` should expose pure functions for testability:

```js
export function eligibleTargetStores(localData = {}) {
  return (Array.isArray(localData.stores) ? localData.stores : [])
    .filter((store) => store?.status !== "disabled" && store?.credentialsSaved === true);
}

export function buildPrepareListingBody({ collectItemId, targetStoreId, requestId }) {
  const itemId = String(collectItemId || "").trim();
  const storeId = String(targetStoreId || "").trim();
  if (!itemId) throw new Error("COLLECT_ITEM_REQUIRED");
  if (!storeId) throw new Error("TARGET_STORE_REQUIRED");
  return {
    collectItemId: itemId,
    targetStoreId: storeId,
    idempotencyKey: String(requestId || crypto.randomUUID()),
  };
}
```

In `App.jsx`, require a selection at “准备上架”; do not auto-fill from a stale collection record. It is acceptable to preselect the current eligible operating store for convenience, but the request must contain an explicit `targetStoreId`.

- [ ] **Step 5: Run focused and integration verification**

```bash
node --test \
  server/tests/listing-submission-policy.test.mjs \
  server/tests/collect-listing-submit-failure.test.mjs \
  app/tests/collect-box-target-store.test.mjs
```

If a dedicated database is available:

```bash
node server/tests/listing-pipeline-v3.integration.mjs
```

- [ ] **Step 6: Commit**

```bash
git add server/listing-pipeline.mjs server/listing-worker.mjs server/listing-submission-policy.mjs server/tests/listing-submission-policy.test.mjs server/tests/collect-listing-submit-failure.test.mjs server/tests/listing-pipeline-v3.integration.mjs app/src/App.jsx app/src/collect-box-target-store.js app/tests/collect-box-target-store.test.mjs
git commit -m "feat: freeze listing target store"
```

---

## Task 6: Convert desktop collector contracts to account scope

**Files:**

- Modify: `server/collector-desktop-service.mjs`
- Modify: `server/collector-selection-service.mjs`
- Modify: `server/collector-export-service.mjs`
- Modify: `server/collector-excel-service.mjs`
- Modify: `desktop/dist-electron/services/collector-contract.core.js`
- Modify: `desktop/dist-electron/services/collector-backend.services.js`
- Modify: `desktop/dist-electron/services/collection.services.js`
- Modify: `desktop/dist-electron/services/seller-analytics.core.js`
- Modify: `desktop/tests/collector-contract.test.mjs`
- Modify: `desktop/tests/backend-client-static.test.mjs`
- Modify: `desktop/tests/collection-runtime-wiring.test.mjs`
- Modify: `desktop/tests/seller-analytics.test.mjs`
- Modify: `server/tests/collector-export-service.test.mjs`
- Modify: `server/tests/collector-excel-service.test.mjs`

**New desktop task/run scope:**

```js
{
  accountId,              // authenticated server context
  operatingStoreId: null, // optional legacy context only
  source,
  configuration,
}
```

There is no runtime `dataCollectionStoreId` selector, filter, or required property.

- [ ] **Step 1: Update tests first**

Replace assertions requiring `dataCollectionStoreId` with:

- task/run/item/export creation succeeds with account scope only;
- list/export queries require account ID;
- legacy rows may expose `legacyScope.dataCollectionStoreId` read-only;
- payload builders omit data-store and seller-company fields;
- seller analytics rows are keyed by account + source identity.

- [ ] **Step 2: Run and observe failures**

```bash
node --test \
  desktop/tests/collector-contract.test.mjs \
  desktop/tests/backend-client-static.test.mjs \
  desktop/tests/collection-runtime-wiring.test.mjs \
  desktop/tests/seller-analytics.test.mjs \
  server/tests/collector-export-service.test.mjs \
  server/tests/collector-excel-service.test.mjs
```

- [ ] **Step 3: Remove runtime data-store requirements**

- Stop validating or selecting a data collection store.
- Remove data-store filters from task/run/snapshot/category mapping calls.
- Keep `account_id` in every SQL `WHERE`, insert, update, and export query.
- Set optional operating store fields to `NULL` until listing preparation.
- Preserve source page identity needed for analytics without treating Seller Company ID as authorization.

- [ ] **Step 4: Run focused tests and syntax checks**

```bash
node --test \
  desktop/tests/collector-contract.test.mjs \
  desktop/tests/backend-client-static.test.mjs \
  desktop/tests/collection-runtime-wiring.test.mjs \
  desktop/tests/seller-analytics.test.mjs \
  server/tests/collector-export-service.test.mjs \
  server/tests/collector-excel-service.test.mjs
node --check server/collector-desktop-service.mjs
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add server/collector-desktop-service.mjs server/collector-selection-service.mjs server/collector-export-service.mjs server/collector-excel-service.mjs desktop/dist-electron/services/collector-contract.core.js desktop/dist-electron/services/collector-backend.services.js desktop/dist-electron/services/collection.services.js desktop/dist-electron/services/seller-analytics.core.js desktop/tests/collector-contract.test.mjs desktop/tests/backend-client-static.test.mjs desktop/tests/collection-runtime-wiring.test.mjs desktop/tests/seller-analytics.test.mjs server/tests/collector-export-service.test.mjs server/tests/collector-excel-service.test.mjs
git commit -m "refactor: scope desktop collection by account"
```

---

## Task 7: Make Web store synchronization backend-only and independently retryable

**Files:**

- Create: `app/src/store-sync-coordinator.js`
- Create: `app/tests/store-sync-coordinator.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `server/ozon-sync-service.mjs`
- Modify: `server/tests/ozon-sync-service.test.mjs`
- Modify: `server/tests/account-store-isolation.test.mjs`

**Web coordinator contract:**

```js
export const STORE_SYNC_TYPES = [
  "WAREHOUSES",
  "PRODUCTS",
  "POSTINGS",
  "PROMOTIONS",
];

export async function runBackendStoreSync({
  storeId,
  types = STORE_SYNC_TYPES,
  request,
  onState,
}) {}
```

Per-type state:

```js
{
  type,
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED",
  taskId,
  result,
  error,
}
```

- [ ] **Step 1: Write failing pure coordinator tests**

Verify:

- calls only `/local/sync/<TYPE>` endpoints;
- never emits an extension message;
- executes each requested type exactly once;
- one failed type does not erase successful results;
- retry with `types: ["POSTINGS"]` calls only that type;
- state transitions are `PENDING -> RUNNING -> SUCCESS|FAILED`.

- [ ] **Step 2: Run failing test**

```bash
node --test app/tests/store-sync-coordinator.test.mjs
```

- [ ] **Step 3: Implement coordinator and replace App fallback logic**

Delete from `App.jsx`:

- `requestExtensionSync`;
- `waitForExtensionSyncJob`;
- plugin-first branches;
- “插件同步失败，正在按当前店铺从 Seller API 只读同步” messaging.

Call the coordinator directly from full-sync and single-type retry actions.

- [ ] **Step 4: Confirm backend range remains complete**

Extend `server/tests/ozon-sync-service.test.mjs` to assert the backend still covers:

- profile;
- products and archived product cleanup;
- price and marketing price;
- FBS/FBO stock;
- warehouses;
- FBS/FBO postings;
- promotions.

Each result/error must include account, store, type, timestamp, task/request ID, and sanitized details.

- [ ] **Step 5: Run focused tests**

```bash
node --test \
  app/tests/store-sync-coordinator.test.mjs \
  server/tests/ozon-sync-service.test.mjs \
  server/tests/account-store-isolation.test.mjs
pnpm --dir app build
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add app/src/store-sync-coordinator.js app/tests/store-sync-coordinator.test.mjs app/src/App.jsx server/ozon-sync-service.mjs server/tests/ozon-sync-service.test.mjs server/tests/account-store-isolation.test.mjs
git commit -m "refactor: use backend-only store sync"
```

---

## Task 8: Replace extension login/token copying with collector ticket exchange

**Files:**

- Create: `app/src/collector-auth-bridge.js`
- Create: `app/tests/collector-auth-bridge.test.mjs`
- Modify: `app/src/App.jsx`
- Create: `extension/lib/collector-session.js`
- Create: `extension/tests/collector-session.test.js`
- Modify: `extension/lib/web-bridge-policy.js`
- Modify: `extension/lib/portal-bridge-policy.js`
- Modify: `extension/content/sync-auth.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.css`
- Modify: `extension/popup/popup.js`
- Modify: `extension/tests/web-bridge-policy.test.js`
- Modify: `extension/tests/portal-bridge-policy.test.js`
- Modify: `extension/popup/__tests__/popup-routing.smoke.test.js`

**Bridge messages:**

```js
// extension -> trusted Web page
{
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.request",
  requestId
}

// trusted Web page -> extension
{
  protocol: "SONLI_COLLECTOR_AUTH",
  action: "collector.auth.response",
  requestId,
  ticket,
  expiresAt
}
```

No message may contain the Web token or a store ID.

- [ ] **Step 1: Write failing session and bridge-policy tests**

Verify:

- `syncAuthFromWeb` and `tryWebSync` are rejected;
- only trusted protocol/host/port and matching request ID are accepted;
- the Web bridge requests a ticket only while the Web account is logged in;
- the Web response echoes the exact request ID and contains a ticket, never the Web token;
- collector token is stored only through `chrome.storage.session`;
- `chrome.storage.local` and `chrome.storage.sync` never receive it;
- 401/403 clears the collector session;
- ticket exchange is retried once on expiry, then stops;
- pending uploads remain queued by the account/session identity;
- account mismatch prevents upload;
- secrets are redacted from errors/log arguments.

- [ ] **Step 2: Run failing tests**

```bash
node --test \
  app/tests/collector-auth-bridge.test.mjs \
  extension/tests/collector-session.test.js \
  extension/tests/web-bridge-policy.test.js \
  extension/tests/portal-bridge-policy.test.js \
  extension/popup/__tests__/popup-routing.smoke.test.js
```

- [ ] **Step 3: Implement the Web-side ticket responder**

Create `app/src/collector-auth-bridge.js` as a focused adapter:

```js
export function installCollectorAuthBridge({
  isLoggedIn,
  requestTicket,
  postResponse = (payload) => window.postMessage(payload, window.location.origin),
}) {
  const onMessage = async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = normalizeCollectorAuthRequest(event.data);
    if (!message || !isLoggedIn()) return;
    const result = await requestTicket();
    postResponse({
      protocol: "SONLI_COLLECTOR_AUTH",
      action: "collector.auth.response",
      requestId: message.requestId,
      ticket: result.ticket,
      expiresAt: result.expiresAt,
    });
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
```

`App.jsx` installs it only after authenticated state is loaded. `requestTicket` calls `POST /extension/collector-auth/ticket` through the existing Web `apiRequest`, so the normal Web bearer token never enters the bridge payload.

- [ ] **Step 4: Implement `collector-session.js` as the only extension token owner**

Expose:

```js
const STORAGE_KEY = "sonliCollectorSession";

async function getCollectorSession() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const session = stored?.[STORAGE_KEY] || null;
  if (!session || Date.parse(session.expiresAt || "") <= Date.now()) {
    await chrome.storage.session.remove(STORAGE_KEY);
    return null;
  }
  return session;
}

async function setCollectorSession(session) {
  const safe = {
    collectorToken: String(session.collectorToken || ""),
    expiresAt: String(session.expiresAt || ""),
    account: session.account || null,
    permissions: Array.isArray(session.permissions) ? session.permissions : [],
  };
  await chrome.storage.session.set({ [STORAGE_KEY]: safe });
  return safe;
}

async function clearCollectorSession() {
  await chrome.storage.session.remove(STORAGE_KEY);
}

async function exchangeCollectorTicket({ ticket, deviceFingerprint, extensionVersion }) {
  const response = await fetch(`${BACKEND_URL}/extension/collector-auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, deviceFingerprint, extensionVersion }),
  });
  if (!response.ok) throw await collectorHttpError(response);
  return setCollectorSession(await response.json());
}

async function collectorFetch(path, { permission, ...options } = {}) {
  const session = await getCollectorSession();
  if (!session?.permissions?.includes(permission)) throw collectorError("COLLECTOR_PERMISSION_DENIED", 403);
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Collector ${session.collectorToken}` },
  });
  if (response.status === 401 || response.status === 403) await clearCollectorSession();
  return response;
}
```

`collectorFetch` adds `Authorization: Collector <token>` and never accepts an arbitrary authorization header from callers.

- [ ] **Step 5: Replace the extension side of the bridge**

- `content/sync-auth.js` requests a one-time ticket from a trusted, already logged-in Web page.
- `service-worker.js` exchanges the ticket, stores only the collector session, and reports a status object to popup/content scripts.
- Remove all paths that copy `state.token`/Web bearer token into extension storage.

- [ ] **Step 6: Replace popup login UI**

When there is no valid collector session, show only:

- “请先登录 Web 管理后台，再使用采集功能”;
- “前往登录” button opening `http://127.0.0.1:3000/login` in the same browser profile;
- “重新检查” button.

Delete SMS/password inputs and their handlers. Do not imply that login in the Codex in-app browser is shared with the installed extension.

- [ ] **Step 7: Run focused tests and syntax checks**

```bash
node --test \
  app/tests/collector-auth-bridge.test.mjs \
  extension/tests/collector-session.test.js \
  extension/tests/web-bridge-policy.test.js \
  extension/tests/portal-bridge-policy.test.js \
  extension/popup/__tests__/popup-routing.smoke.test.js
node --check extension/background/service-worker.js
node --check extension/content/sync-auth.js
node --check extension/popup/popup.js
git diff --check
```

- [ ] **Step 8: Commit**

```bash
git add app/src/collector-auth-bridge.js app/tests/collector-auth-bridge.test.mjs app/src/App.jsx extension/lib/collector-session.js extension/tests/collector-session.test.js extension/lib/web-bridge-policy.js extension/lib/portal-bridge-policy.js extension/content/sync-auth.js extension/background/service-worker.js extension/popup/popup.html extension/popup/popup.css extension/popup/popup.js extension/tests/web-bridge-policy.test.js extension/tests/portal-bridge-policy.test.js extension/popup/__tests__/popup-routing.smoke.test.js
git commit -m "feat: authenticate extension with collector tickets"
```

---

## Task 9: Delete extension synchronization capability and block old clients

**Files:**

- Delete: `extension/background/sync/sync-engine.js`
- Delete: `extension/background/sync/opi-client.js`
- Delete: `extension/background/sync/lease-client.js`
- Delete: `extension/background/sync/sync-state.js`
- Delete: `extension/background/sync/diff-index.js` if no collection caller remains
- Modify or split: `extension/background/sync/backend-client.js`
- Create: `extension/background/collector-client.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`
- Create: `extension/tests/sync-capability-removed.test.js`
- Delete or replace: `extension/tests/sync-state-watermark.test.js`
- Delete or replace: `extension/tests/postings-manual-sync-window.test.js`
- Modify: `extension/tests/manifest-security-contract.test.js`
- Modify: `server/index.mjs`
- Create: `server/tests/extension-sync-removed.test.mjs`

**Compatibility response:**

```http
HTTP/1.1 410 Gone
Content-Type: application/json

{
  "ok": false,
  "code": "EXTENSION_SYNC_REMOVED",
  "message": "插件同步已移除，请更新插件并在 Web 端执行同步"
}
```

- [ ] **Step 1: Write failing capability behavior tests**

Build a controlled Chrome/fetch harness around the actual background service worker and
packaged manifest. Verify:

- the installed manifest grants no request access to `api-seller.ozon.ru`;
- startup registers no product/order/warehouse synchronization alarm;
- sending retired manual-sync and sync-request messages produces no synchronization
  action and no Seller API/backend sync fetch;
- capture upload still reaches the collector client;
- the packaged extension can start without any retired sync module.

The test must observe registered alarms, message responses, and fetch calls. It must
not pass merely because a source string or filename is absent.

- [ ] **Step 2: Write failing server compatibility tests**

Enumerate every old extension-only sync, lease, heartbeat, client-report, and import-with-hash path found by `rg`. Each must return 410 without calling Ozon or mutating state.

- [ ] **Step 3: Run failing tests**

```bash
node --test extension/tests/sync-capability-removed.test.js extension/tests/manifest-security-contract.test.js server/tests/extension-sync-removed.test.mjs
```

- [ ] **Step 4: Split the backend client**

Move only collection upload/job/config methods into `extension/background/collector-client.js`. Keep separately named browser-task/AI clients only if still used. Delete:

- Seller API sync requests;
- lease acquire/heartbeat/release;
- import-with-hash;
- sync status/reporting;
- product/order/warehouse alarms and intervals;
- manual sync handlers and popup status.

Use `rg` before removing the `alarms` manifest permission. Remove it only if no non-sync alarm remains.

- [ ] **Step 5: Remove Seller API host permission**

Delete only `https://api-seller.ozon.ru/*`. Keep `seller.ozon.ru` page permissions needed for visible-page capture.

- [ ] **Step 6: Add 410 handlers**

Place an explicit allowlist of retired paths before general `/local/sync/<TYPE>` Web routes. Web backend sync routes must continue to work; only extension-specific contracts are retired.

- [ ] **Step 7: Run focused tests and repository scan**

```bash
node --test extension/tests/sync-capability-removed.test.js extension/tests/manifest-security-contract.test.js server/tests/extension-sync-removed.test.mjs
rg -n "api-seller\\.ozon\\.ru|jzManualSync|sync\\.request|sync\\.response|tryWebSync|sync-engine|opi-client|lease-client" extension
git diff --check
```

The `rg` result is a supplemental safety inventory only. Pass/fail is determined by
the capability behavior test, server 410 test, and packaged-extension smoke test.

- [ ] **Step 8: Commit**

```bash
git add -A extension/background extension/manifest.json extension/tests server/index.mjs server/tests/extension-sync-removed.test.mjs
git commit -m "refactor: remove extension store sync"
```

---

## Task 10: Remove runtime data-store APIs, state, UI, and blocking rules

**Files:**

- Modify: `server/account-context.mjs`
- Modify: `server/collection-pipeline.mjs`
- Modify: `server/index.mjs`
- Create: `server/tests/data-collection-store-removed.test.mjs`
- Modify: `server/tests/formal-persistence-legacy-store.test.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `app/src/StoresSettingsPage.jsx`
- Create: `app/tests/data-collection-store-runtime.test.mjs`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/popup/popup.js`
- Modify: `extension/tests/collector-removed.test.js`

**Runtime fields removed:**

```text
dataCollectionStoreId
currentDataCollectionStoreId
currentDataCollectionStoreIdsByAccount
dataCollectionStore
dataCollectionStores
sellerCompanyId as an authorization boundary
```

- [ ] **Step 1: Write failing API/state/UI removal tests**

Verify:

- `/local/data-collection-stores`, `/local/current-data-collection-store`, and `/local/data-collection-stores/verify` return 410 `DATA_COLLECTION_STORE_REMOVED`;
- no local-state payload exposes data-store/current-data-store fields;
- the Stores Settings runtime model contains only operating store management;
- collection task/filter/form payload builders work without a data store;
- no extension code calls the verify endpoint;
- `data_collection_stores` and membership rows remain readable by migration/audit code only.

- [ ] **Step 2: Run failing tests**

```bash
node --test \
  server/tests/data-collection-store-removed.test.mjs \
  server/tests/formal-persistence-legacy-store.test.mjs \
  app/tests/data-collection-store-runtime.test.mjs \
  extension/tests/collector-removed.test.js
```

- [ ] **Step 3: Remove state helpers and public payload fields**

Delete active calls to:

- `activeDataCollectionStore`;
- `dataCollectionStoresForAccount`;
- `setCurrentDataCollectionStoreForAccount`;
- collection-store upsert/switch/verify/delete.

Do not delete historical SQL tables or migration helpers needed to read old state during migration/rollback. Put those exports in a clearly named legacy-only module if retaining them in `collection-pipeline.mjs` would violate module boundaries.

- [ ] **Step 4: Remove Web and extension UI**

- Delete data-store cards/forms/current-store banners from `StoresSettingsPage.jsx`.
- Delete local data-store fields from `App.jsx` empty state, hydration, login restore, account switch, and logout flows.
- Delete seller-company/data-store verification from extension capture.
- Keep operating store binding/switching and seller page data capture intact.

- [ ] **Step 5: Run focused regression**

```bash
node --test \
  server/tests/data-collection-store-removed.test.mjs \
  server/tests/formal-persistence-legacy-store.test.mjs \
  server/tests/module-boundaries.test.mjs \
  app/tests/data-collection-store-runtime.test.mjs \
  extension/tests/collector-removed.test.js \
  server/tests/account-store-isolation.test.mjs
pnpm --dir app build
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add server/account-context.mjs server/collection-pipeline.mjs server/index.mjs server/tests/data-collection-store-removed.test.mjs server/tests/formal-persistence-legacy-store.test.mjs server/tests/module-boundaries.test.mjs app/src/App.jsx app/src/StoresSettingsPage.jsx app/tests/data-collection-store-runtime.test.mjs extension/background/service-worker.js extension/popup/popup.js extension/tests/collector-removed.test.js
git commit -m "refactor: remove runtime data collection stores"
```

---

## Task 11: Update extension parity policies and regenerate distributed artifacts

**Files:**

- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/check-extension-diff-contract.mjs`
- Modify: `scripts/check-extension-ui-parity.mjs` if popup expectations change
- Modify: `scripts/check-extension-zip-smoke.mjs`
- Modify: `scripts/check-plugin-readiness-gate.mjs`
- Regenerate: `app/public/sonli-extension-<version>/`
- Regenerate: `app/public/sonli-extension-<version>.zip`
- Regenerate locally (ignored build output): `app/dist/sonli-extension-<version>.zip`

- [ ] **Step 1: Update parity tests before packaging**

- Mark retired upstream sync files as intentionally removed, not unexpectedly missing.
- Add new collector session/client files to local-only or allowed-diff sets as appropriate.
- Remove exact diff hunk counts/patterns for deleted sync files.
- Replace the current whole-array permission equality check with explicit invariants: local permissions may omit retired sync-only permissions, but may not add an unreviewed permission; the Seller API host must be absent.
- Change popup contract from “账号登录” to Web-login guidance.
- Add ZIP smoke assertions that no sync module or Seller API host permission is distributed.

- [ ] **Step 2: Run source-side checks and observe stale distribution failure**

```bash
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-ui-parity.mjs
node scripts/check-extension-diff-contract.mjs
```

Expected before regeneration: distribution parity may fail because `app/public` is stale.

- [ ] **Step 3: Regenerate through the existing packaging command**

```bash
pnpm package-extension
```

Do not hand-edit generated copies or ZIP files.

- [ ] **Step 4: Run all extension packaging gates**

```bash
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-ui-parity.mjs
node scripts/check-extension-diff-contract.mjs
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/check-plugin-readiness-gate.mjs
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-extension-source-parity.mjs scripts/check-extension-diff-contract.mjs scripts/check-extension-ui-parity.mjs scripts/check-extension-zip-smoke.mjs scripts/check-plugin-readiness-gate.mjs app/public
git commit -m "build: package capture-only extension"
```

---

## Task 12: Run complete regression, perform browser smoke checks, and document handoff

**Files:**

- Create: `docs/superpowers/verification/2026-07-29-account-scoped-collection-backend-only-sync.md`
- Modify only if a verified defect is found: files owned by Tasks 1–11

- [ ] **Step 1: Run the complete automated gate**

```bash
pnpm verify
```

Capture the exact passing/failing check names in the verification document. Do not describe blocked checks as passed.

- [ ] **Step 2: Run explicit security/source scans**

```bash
rg -n "api-seller\\.ozon\\.ru|jzManualSync|sync\\.request|sync\\.response|tryWebSync|syncAuthFromWeb|dataCollectionStoreId|currentDataCollectionStoreId" extension app/src server desktop
node scripts/check-personal-data.mjs
```

Classify every remaining match as one of:

- required historical migration/audit evidence;
- test asserting removal;
- defect to fix.

Runtime matches are not acceptable.

- [ ] **Step 3: Run local browser smoke tests**

Start the existing local stack with:

```bash
pnpm dev
```

In the browser profile containing the extension, verify:

1. logged-out popup shows only Web-login guidance;
2. “前往登录” opens `http://127.0.0.1:3000/login`;
3. Web login allows ticket exchange without plugin password entry;
4. closing the Web page does not end a still-valid collector session;
5. Ozon and 1688 capture uploads into the current account's collect box without a data store;
6. account switch prevents old-account queued data from uploading;
7. collect box requires a target operating store only at listing preparation;
8. Web full sync calls backend routes only and supports single-type retry;
9. plugin UI has no sync button/status/error;
10. browser restart clears the collector session.

If browser-profile extension testing is unavailable, mark these exact checks unverified and explain why.

- [ ] **Step 4: Run dedicated PostgreSQL checks when available**

Only with an explicit disposable test database:

```bash
pnpm db:migrate
node server/tests/collection-pipeline-v4.integration.mjs
node server/tests/collector-desktop.integration.mjs
node server/tests/listing-pipeline-v3.integration.mjs
```

Record row counts before/after migration, ownership validation, and rollback evidence. Otherwise list this as the main unverified production-risk area.

- [ ] **Step 5: Write the delivery record required by AGENTS.md**

Document:

- what changed;
- changed files/modules and stable contracts;
- automated and manual tests run, with results;
- old features regression-checked;
- unverified scope and reason;
- known regression risks;
- rollback procedure:
  - revert application/extension commits;
  - keep migration 019 because it is additive;
  - restore the previous packaged extension together with compatible backend endpoints only if deliberately approved;
  - never drop historical data-store tables during rollback.

- [ ] **Step 6: Final diff and history review**

```bash
git status --short
git diff --check
git log --oneline --decorate -15
```

Confirm no unrelated file, plaintext credential, token, personal path, or temporary artifact is included.

- [ ] **Step 7: Commit verification record**

```bash
git add docs/superpowers/verification/2026-07-29-account-scoped-collection-backend-only-sync.md
git commit -m "docs: record collection sync verification"
```

---

## Completion Criteria

Implementation is complete only when all of the following are true:

- the extension has no independent login and holds only a scoped, session-storage collector token;
- Web logout/account security changes revoke the related collector sessions;
- a ticket is one-use and 60-second limited;
- collection succeeds without an operating store or data store;
- all new collection writes have account ownership and account-scoped idempotency;
- listing freezes a validated target operating store;
- Web store sync never waits for or calls the extension;
- extension code/manifest/distribution contain no Seller API sync capability;
- runtime APIs, state, UI, and filters contain no data collection store concept;
- historical data-store evidence remains intact;
- complete active tests and builds pass, with environment-dependent gaps explicitly recorded;
- rollback steps are documented and do not require destructive database actions.
