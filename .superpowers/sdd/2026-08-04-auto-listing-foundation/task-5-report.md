# Task 5 Report — Safe Auto-listing Foundation Routes

## Scope

Changed the Task 5-owned files, plus the narrowly authorized shared PostgreSQL retry boundary and its focused test:

- `server/permissions.mjs`
- `server/runtime-config.mjs`
- `server/auto-listing-runtime.mjs`
- `server/auto-listing-routes.mjs`
- `server/index.mjs`
- `server/tests/auto-listing-routes.test.mjs`
- `server/tests/module-boundaries.test.mjs`
- `server/db/connection.mjs`
- `server/tests/db-connection-retry.test.mjs`

No Task 1–4 domain, snapshot, repository, service, migration, external gateway, or UI code changed.

## TDD evidence

- Initial RED: after adding the Task 5 route tests, the focused command failed with `ERR_MODULE_NOT_FOUND` for `server/auto-listing-runtime.mjs`, proving the new route/runtime behavior was absent. A prior test-file syntax typo was corrected before recording that meaningful RED failure.
- Additional REDs were recorded before their respective minimal fixes: disabled unsupported methods returned `503` rather than `405`; invalid POST input or encoded job IDs initialized the runtime; malformed JSON became a generic `500`; and `AUTO_LISTING_CONFIG_INVALID` was incorrectly mapped to a generic `500`.
- GREEN: `server/tests/auto-listing-routes.test.mjs` and `server/tests/module-boundaries.test.mjs` passed with **13 tests passed, 0 failed**.
- Foundation regression: the complete always-on Task 1–5 foundation command passed with **79 tests passed, 0 failed**.
- Task 2–4/store regression passed with **12 tests passed, 0 failed**; `listing-pipeline-v3.integration.mjs` completed its intentional PostgreSQL-not-configured skip path.
- `AUTO_LISTING_POSTGRES_TESTS=1` integration command passed its always-on barrier test and correctly skipped the dedicated database fixture because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent. No production database fallback was used.
- `git diff --check` passed.

## Contracts and safety evidence

- `AUTO_LISTING_ENABLED` is opt-in: only normalized `1` or `true` enable it; all other values, including absence, are disabled.
- Matching routes authenticate before revealing feature state. Disabled, authenticated requests return `503 AUTO_LISTING_DISABLED` and never initialize the runtime or PostgreSQL. Unsupported matching methods return `405` after authentication.
- Create input allows exactly `collectItemIds`, `idempotencyKey`, `config`, and `correlationId`; client account/actor/owner scope and recursively supplied sensitive fields are rejected. The route injects the server-authenticated actor only.
- List and detail pass actor scope directly to the Task 4 service. Route DTOs are allowlisted scalars only and discard account records, event history, raw payloads, credentials, keys, and other unknown persistence fields.
- Unknown failures become `500 AUTO_LISTING_INTERNAL_ERROR` with a fixed safe message. Known foundation/config failures retain only approved public codes and fixed safe messages.
- The runtime owns lazy PostgreSQL repository/service composition, shares one successful initialization among concurrent callers, and clears failed initialization for retry.
- `AI_CONTENT_MANAGE` is `ai-content.manage` and available to admins only. Ordinary job access remains governed by the service's `TENANT_OPERATE` check.
- `server/index.mjs` adds only imports, one composition, and one dispatch before the broad JSON state transaction. The runtime route module contains no SQL, repository, AI, or Ozon implementation imports.

## Unverified range, risk, rollback

- Live HTTP server authentication and route dispatch were not exercised against a running server or a dedicated PostgreSQL database. The dedicated PostgreSQL fixture remains skipped until `SONLI_MIGRATION_TEST_DATABASE_URL` is provided.
- This foundation has no AI/Ozon invocation and is disabled by default. The remaining operational risk is limited to enabling the feature before a disposable PostgreSQL integration run and production-auth smoke check.
- Rollback is configuration-first: set `AUTO_LISTING_ENABLED=0`; this prevents runtime initialization and preserves immutable migration/audit history. If code rollback is required, revert this Task 5 commit only; do not delete foundation tables or task history.

## Fix round 1 — review closure

### RED / GREEN

- RED: the expanded focused route/connection command had **19 tests, 7 failures**. It reproduced GET-create dispatching to detail, disabled POST body consumption, missing identifier/query bounds, dropped public domain errors/items, and rejected-pool retention. A final closed-error-item regression then failed because `<script>` status and newline failure codes survived the error DTO allowlist.
- GREEN: route, module-boundary, and connection retry tests passed with **21 tests passed, 0 failed**.
- Full foundation gate: **87 tests passed, 0 failed**. The historical **38/38** persistence/listing/store command was `persistence-atomicity`, `formal-persistence-legacy-store`, `listing-warehouse-eligibility`, `listing-submission-policy`, `listing-pipeline-warehouse-boundary`, `listing-pipeline-v3.integration`, and `account-store-isolation`. The independent review's expanded command recorded **35 passed, 0 failed, 1 skipped** because its account-scoped collection integration had no PostgreSQL configuration. The dedicated auto-listing PostgreSQL suite passed its local barrier test and skipped one dedicated-database fixture because `SONLI_MIGRATION_TEST_DATABASE_URL` remains unset; no production fallback was used.
- `node --check` passed for the route, runtime, and connection modules; `git diff --check` passed.

### Review finding closure

- **I1:** route classification now reserves `/from-collect-box` and `/jobs` before matching detail IDs, so GET-create and POST-detail return authenticated `405` without calling the service.
- **I2:** the envelope uses a closed code-to-status map for target-store, warehouse eligibility, source-version conflict, configuration, and foundation errors. Authentication-originated `403` becomes fixed `AUTO_LISTING_FORBIDDEN`; raw error messages are never forwarded.
- **I3:** order is namespace → authentication → exact method → feature flag → query/body parsing → runtime. Disabled authenticated POSTs return `503` without body reads, parsing, service calls, or pool initialization.
- **I4:** known public failures can include at most 100 item summaries. Each summary only allows a bounded identifier, one closed item status, and a bounded uppercase failure code; raw/secret/stack/unknown fields are discarded.
- **I5:** route parsing requires nonempty `targetStoreId` and `targetWarehouseId` at most 240 characters, but leaves Task 2 configuration normalization and all store/FBS ownership decisions in the service/repository. Repeated `collectItemIds` remain intact for Task 4's idempotent de-duplication logic.
- **I6:** the authorized `db/connection.mjs` change clears only the matching rejected initialization promise. Successful concurrent callers still share one pool; close safely ignores failed initialization and clears only the captured pool promise before ending it, so a replacement pool cannot be closed by an old shutdown.
- **M1:** list accepts only one optional `limit`; create/detail accept no query fields. Account/actor/owner aliases and all unknown query fields fail safely before runtime initialization.
- **M2:** the module guard uses an import allowlist for the route and executable negative fixtures for AI/Ozon imports and SQL verbs/query calls.

### Remaining verification / rollback

- Live listener/auth composition and disposable PostgreSQL integration remain unverified. Keep the feature disabled until the dedicated database and production-auth smoke path are available.
- Runtime rollback remains `AUTO_LISTING_ENABLED=0`. The connection retry change can be reverted independently only if it causes unrelated pool lifecycle regression; it preserves all existing configuration semantics and public interfaces.

## Fix round 2 — review closure

### RED / GREEN

- RED: the expanded focused command had **24 tests, 2 failures**. It proved service-owned `401` could override the closed target-store map and two simultaneous close calls invoked one pool's `end()` twice. The Acorn dynamic-import fixtures are executable boundary checks and the current route passed them.
- GREEN: routes, connection retry, and module boundaries passed **24/24**. The full foundation gate passed **90/90**.
- Regression: **42/42** passed for `permissions`, `external-write-safety`, `persistence-atomicity`, `formal-persistence-legacy-store`, `listing-warehouse-eligibility`, `listing-submission-policy`, `listing-pipeline-warehouse-boundary`, `listing-pipeline-v3.integration`, and `account-store-isolation`. The pipeline integration reports its intentional no-PostgreSQL internal skip/no-op while its test file completes successfully.
- Gated auto-listing PostgreSQL coverage: **1 passed, 1 skipped** without `SONLI_MIGRATION_TEST_DATABASE_URL`; no production fallback was used. Route and connection syntax checks plus `git diff --check` passed.

### Review finding closure

- **R1-I1:** authentication has its own catch and fixed envelope. Only failures thrown by `authenticate` may produce public 401/403 auth responses; all later failures select their fixed status solely from `PUBLIC_ERRORS`, and unknown service errors remain a safe 500 even if they carry 401/403.
- **R1-M1:** the route-boundary test now parses with Acorn. It permits only literal `./runtime-config.mjs` imports, rejects every other static or dynamic import, rejects computed dynamic imports, and independently rejects executable `.query()` syntax without treating comments or strings as imports.
- **R1-M2:** shared connection cleanup is keyed by the captured initialization promise. Concurrent close calls share one shutdown promise, rejected initialization closes safely, end failures preserve replacement pools, and a subsequent replacement can be closed normally.
- **R1-M3:** the round-1 evidence above now records the correct 21-test focused count, the committed `fb61f4e` state, and the named historical 38/38 versus review 35+skip regression scopes.

### Remaining verification / rollback

- A live HTTP listener/authentication smoke test and real disposable PostgreSQL transaction coverage remain unavailable. Keep `AUTO_LISTING_ENABLED=0` until those environments are supplied.
- Roll back route exposure with `AUTO_LISTING_ENABLED=0`. Reverting this commit restores previous error/close behavior; preserve migration 026 and all immutable job, snapshot, and audit history.
