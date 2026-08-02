# Task 5 report — category-resolution Runtime and collection/enrichment ingress

## Outcome and acceptance

Task 5 wires the Task 4 category-resolution Service into both JSON and PostgreSQL collection paths without allowing the client to choose a credential store. A successful Ozon collection now schedules one account-scoped resolution after the collection commit. An incomplete item becomes `WAITING_ENRICHMENT`; a complete item with an active credentialed operating store becomes `QUEUED`; an item without one becomes `WAITING_STORE`. Seller enrichment completion wakes the same item only after its completed draft has committed.

Collection and enrichment success are never rolled back by category Port creation, execution, or logging failures. Store binding, current-store selection, and API-key restoration enqueue an asynchronous same-account wake. Restart reconciliation discovers missing records, completed enrichment waiters, usable-store waiters, and matched results that require validation after a store change or credential update.

## Runtime and contract changes

- Added `createCollectCategoryResolutionRuntime`, which owns JSON/PostgreSQL Repository selection, Service construction, account-scoped item/store adapters, post-restart reconciliation, a non-overlapping drain, and stoppable worker/store-wake timers.
- JSON audited mutations use the existing singleton `jsonStateTransaction`. Runtime adapts the prepared Service event to `appendAuditEvent(transactionState, event)` inside the Repository mutation and its single save.
- PostgreSQL audited mutations adapt the event to `insertPostgresAuditEvent(executor, event)` using the exact transaction executor supplied by the Repository.
- `scheduleForCollect({ accountId, collectItemId })` and `onEnrichmentComplete(...)` derive `credentialStoreId` from `currentCredentialStoreForAccount(accountId)` and ignore caller store scope.
- `scheduleCategoryResolutionAfterCollect(...)` is an additive post-commit helper shared by JSON and PostgreSQL ingress. It returns the original success value and logs only account/item IDs plus a stable code.
- `createCollectorOzonEnrichmentService` gained the narrow optional `categoryResolutionPort.onEnrichmentComplete(...)` callback and a safe error callback. The hook runs only after `collectItemPort.complete` returns successfully.
- The Service gained additive internal `operatingStoreContext({ accountId, storeId })`, returning only safe store identity/update metadata after applying its existing ownership, status, and credential policy.
- Store wakes query only `WAITING_STORE`/`MATCHED` records across all taxonomy scopes and run in coalesced asynchronous composite item/scope cursor pages of at most 16. As superseded by Fix Round 1, worker reconciliation now admits bounded incomplete waiters and delegates completeness to the Service; every attempt consumes the global budget and the durable cursor prevents an incomplete prefix from starving later work. Missing records use the default scope; existing records preserve their persisted scope. Both timer families are stopped on server close.
- No client request field, collection item, `collect_requests.store_id`, or plugin response gains credential-store scope, and no HTTP response contract changed. Fix Round 1 later added only the additive runtime-cursor migration `025`; the category/collection business schemas remain unchanged.

## Files changed

- Created `server/collect-category-resolution-runtime.mjs` and `server/tests/collect-category-resolution-runtime.test.mjs`.
- Modified `server/collection-pipeline.mjs` and `server/account-scoped-collection-routes.mjs` for post-commit scheduling.
- Modified `server/collector-ozon-enrichment-service.mjs` and `server/collector-ozon-enrichment-runtime.mjs` for the post-completion hook.
- Modified `server/collect-category-resolution-service.mjs` only for the additive safe operating-store context used by Runtime reconciliation.
- Modified `server/index.mjs` for composition, store events, worker start, and server-close stop.
- Modified focused ingress, completeness, enrichment Service/Runtime, and module-boundary tests. App and extension files were not changed.

## RED evidence

The initial Runtime test failed as expected with `ERR_MODULE_NOT_FOUND` for `server/collect-category-resolution-runtime.mjs` (0 passed, 1 failed). Separate hook tests then failed because collection scheduling, Seller-completion notification, and Runtime forwarding were absent (each 0 passed, 1 failed); the first helper import also failed before `scheduleCategoryResolutionAfterCollect` existed.

Adapter and worker REDs exposed the missing PostgreSQL store-status merge, transaction-executor audit binding, bounded list contract, and queued-prefix starvation (each focused case 0 passed, 1 failed).

Independent review found two recovery gaps. The following command captured literal failures before the fix:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap --test-name-pattern='incomplete waiting|store wake pages' server/tests/collect-category-resolution-runtime.test.mjs
```

Result: **2 tests; 0 passed, 2 failed** (`scheduled` was `0` instead of `1`; later store-wait rows remained unwoken). A separate restart validation RED was **0 passed, 1 failed** (`processed` was `0` instead of `1`). These tests drove actionable-before-limit selection, status-filtered paging, and matched-result restart validation.

A final failure-isolation RED used a throwing `scheduleForCollect` property getter. It was **0 passed, 1 failed** because Port initialization escaped the post-commit helper. Moving Port acquisition inside the protected boundary made both initialization and invocation failures non-corrupting.

Final re-review found that the first candidate queries hard-coded `OZON:DEFAULT`. The JSON/PG non-default store-wake command was **2 tests; 0 passed, 2 failed**: JSON left `OZON:RU` in `WAITING_STORE`, and the PostgreSQL SQL still contained `resolution.taxonomy_scope=$2`. Querying all scopes, carrying scope through every Repository/Service call, and using a composite item/scope cursor made both tests green; separate JSON restart and PostgreSQL actionable-query checks cover non-default reconciliation.

## GREEN and regression evidence

Runtime plus category Service:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/collect-category-resolution-runtime.test.mjs server/tests/collect-category-resolution-service.test.mjs
# 65 passed, 0 failed, 0 skipped
```

Required Task 5 integration set, including enrichment Runtime coverage:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/collect-category-resolution-runtime.test.mjs server/tests/collector-scope-ingress.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/module-boundaries.test.mjs
# 102 tests; 101 passed, 1 PostgreSQL-configuration skip, 0 failed
```

Fresh complete server regression after all review fixes:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/*.test.mjs
# 566 tests; 562 passed, 4 configuration-based skips, 0 failed
```

`node --check` passed for all seven changed production modules. `git diff --check` passed. Test inventory passed with **165 active, 14 historical/manual** files.

## Safety, recovery, and observability review

- Every lookup/mutation carries explicit `accountId`; store reads require exact ownership and active credential availability. Wake paging selects records only from the supplied account and never changes collection ownership.
- Stable Repository identity plus existing leases/CAS makes repeated collection, enrichment, wake, and restart notifications idempotent. Store-wake flights are coalesced by account/store.
- Audit payloads are allowlisted and transaction-bound; runtime logs contain no credential value, raw upstream response, or raw exception message.
- A committed collection or enrichment result survives category scheduling failure. Missing/waiting work is durable and restart-discoverable. Fix Round 1 superseded the initial exclusion rule: incomplete waiters may be selected inside the bounded page, are judged only by the Service, and advance the durable fairness cursor after the attempt; store wakes still page until drained.
- Worker drains are non-overlapping and capped at 16 operations; store wake pages are capped at 16 and scheduled asynchronously. Initial, interval, and continuation timers are all stoppable.
- Module-boundary tests prohibit literal static and literal dynamic ESM imports of the category Repository or database from collection routes and enrichment Service.

## Unverified range, regression risk, and rollback

- No live PostgreSQL instance was configured, so real-engine SQL execution/locking and live migration compatibility were not exercised. PostgreSQL Repository transaction behavior, executor-bound audit wiring, actionable query contract, and adapter selection were verified with focused doubles; four existing database-required tests were skipped.
- No live Ozon API, production credential, production data, or external write was used. Category calls were exercised through deterministic fakes.
- Primary regression risk is operational load/fairness when an account has a very large backlog. Processing is deliberately bounded and cursor-paged; safe logs and durable statuses provide diagnosis/retry.
- Roll back by stopping the category worker and reverting the Task 5 and Fix Round 1 application commits. Fix Round 1 added migration `025_collect_category_resolution_runtime_cursor.sql`; its cursor-only table is additive and may safely remain unused during rollback. Do not destructively drop it as part of an application rollback. Existing category-resolution, collection, enrichment, and audit records remain valid.

## Fix Round 1 — controller findings

### Outcome and contract changes

- Worker discovery and execution now share one global candidate budget. A candidate is a literal `{ kind, accountId, collectItemId, taxonomyScope, cursorKey }`; at most `limit` candidates are attempted, and the result exposes `attempted` separately from state-changing `scheduled`/`processed` counts.
- Due work is claimed with its persisted taxonomy scope. In particular, `OZON:RU` is passed to `service.resolveNext({ accountId, taxonomyScope })` and reaches `MATCHED` through the same fingerprint-fenced Service flow as the default scope.
- Fairness is durable across Runtime recreation. JSON stores the last attempted cursor in shared server state under `collectCategoryResolutionRuntimeCursors`; PostgreSQL migration `025_collect_category_resolution_runtime_cursor.sql` adds `collect_category_resolution_runtime_cursors(worker_key, cursor_key, updated_at)`. Worker/candidate cursor keys are deterministic hashes rather than persisted account/item identifiers. The cursor advances after each attempted candidate, including safe poison-item failure, and never before the attempt.
- Runtime no longer decides enrichment completeness. It may page a bounded `WAITING_ENRICHMENT` candidate, but always calls the Service; explicit `enrichmentComplete:false` therefore remains `WAITING_ENRICHMENT` even if a legacy status field says `COMPLETE`.
- Repeated collection scheduling reads the current resolution and retains its taxonomy fingerprint only when the current source type is unchanged. Valid automatic `MATCHED` and `MANUAL` results remain unchanged and unaudited on replay; a changed source type clears the old target and explicitly requeues.
- Collection acceptance freezes the server-owned operating-store context before collection persistence. Runtime issues an empty frozen opaque object backed by a private `WeakMap`; only the exact issued object and account binding are trusted. JSON and fast PostgreSQL routes capture it after authentication and before reading/transaction work, pass it only to post-commit scheduling, and Service revalidates the captured store. A captured no-store state remains `WAITING_STORE`; forged objects fall back to current backend context.
- Capture and scheduling Port getters, calls, and logger failures remain isolated from the already accepted/committed collection. The opaque snapshot is never serialized into collection items, request rows, responses, or audit data.
- Fix Round 1 introduced raw-text guards for conventional literal `from` imports of `collect-category-resolution-repository.mjs` and generic `db/*` modules. Fix Rounds 2 and 3 supersede that initial syntax coverage. App and extension files remain unchanged.

### RED evidence

- Duplicate scheduling: focused JSON/PG hook run produced **2 tests, 0 passed, 2 failed**. JSON returned `QUEUED` instead of `MATCHED`; the PostgreSQL-facing enqueue received `taxonomyFingerprint=null` instead of `taxonomy-runtime-v1`.
- Accepted-store snapshot: focused run produced **2 tests, 0 passed, 2 failed**. Runtime had no capture API, and the JSON route scheduled without first capturing an opaque snapshot.
- Exact scope, global budget, durable fairness, and migration: focused run produced **4 tests, 0 passed, 4 failed**. `OZON:RU` was not processed, `limit=1` performed two operations across five accounts, recreated Runtime did not retain a cursor, and migration `025` did not exist.
- The boundary addition was a guard-only change: its initial raw-text assertions passed against the current modules and caught conventional direct `from` imports, while later rounds expanded and lexically corrected the guard.

### GREEN and regression evidence

Category Runtime, Service, Repository, and migration:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collect-category-resolution-runtime.test.mjs server/tests/collect-category-resolution-service.test.mjs server/tests/collect-category-resolution-repository.test.mjs server/tests/collect-category-resolution-migration.test.mjs
# 120 passed, 0 failed, 0 skipped
```

Required Task 5 integration set:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/collect-category-resolution-runtime.test.mjs server/tests/collector-scope-ingress.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/module-boundaries.test.mjs
# 111 tests; 110 passed, 1 PostgreSQL-configuration skip, 0 failed
```

Fresh complete server regression:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/*.test.mjs
# 578 tests; 574 passed, 4 configuration-based skips, 0 failed
```

All five changed production modules pass `node --check`; `git diff --check` passes. Test inventory remains **165 active, 14 historical/manual** files.

### Unverified range, risks, and rollback

- No PostgreSQL instance was configured. The additive migration contract, global candidate SQL shape, durable cursor read/upsert, transaction-bound Repository audits, and PostgreSQL-facing schedule hook were verified with deterministic tests/doubles, but real-engine migration, SQL execution plans, multi-process contention, and locking remain unverified. Four database-required full-suite cases were skipped.
- No live Ozon API, credential, production data, or external write was used. Exact-scope category calls and store switches use deterministic fakes.
- Remaining operational risk is scanning a very large JSON state to construct the bounded page, and PostgreSQL query-plan cost over a very large backlog. External store/category/claim work is strictly candidate-bounded, cursor progress is durable, and every failure is reported with stable identifiers/codes.
- Rollback by stopping the worker and reverting the Fix Round 1 commit. The migration is additive and contains cursor metadata only; it may safely remain unused during rollback. Do not destructively drop the cursor table during an application rollback. Existing resolution, collection, and audit records remain valid.

## Fix Round 2 — concurrency, snapshot failure, and boundary guard

### Outcome and contract changes

- Repository enqueue is now the final atomic stale-write fence. An existing automatic `MATCHED` row with the same source type survives a stale enqueue even when that enqueue carries an older or empty taxonomy fingerprint. A changed source type still explicitly requeues and clears the obsolete target; `MANUAL` remains protected.
- Runtime snapshot capture converts a backend current-store read failure into a trusted, conservative empty snapshot. Post-commit scheduling therefore resolves the accepted item to `WAITING_STORE` and never rereads a newer current store for that accepted request.
- If the capture Port getter, capture function, or call is unavailable, ingress returns a private skip token and omits only the immediate category schedule. Collection success remains intact and normal restart recovery owns the missed work; no post-commit store-context read occurs.
- The reusable Round 2 guard intended to reject named, default, side-effect, and literal dynamic imports of the category Repository or any `db/*` module, but still scanned raw text. Fix Round 3 supersedes that implementation with comment/string-aware extraction. Current account collection and enrichment modules remain compliant.
- The earlier Task 5 worker and rollback paragraphs were corrected to reflect Fix Round 1's bounded incomplete-waiter attempts, durable fairness cursor, and additive migration `025`.

### RED evidence

- The stale duplicate-enqueue barrier ran against both JSON and PostgreSQL-facing adapters: **2 tests, 0 passed, 2 failed**. In both cases a stale enqueue replaced a concurrently committed `MATCHED` record with `QUEUED`.
- Runtime plus JSON/PostgreSQL-facing capture-failure regressions were **3 tests, 0 passed, 3 failed**. Runtime propagated the backend read failure, while both ingress cases performed an unintended second current-store read after acceptance.
- The first reusable boundary guard failed module loading before implementation. A from-only implementation then failed the side-effect Repository fixture, and its initial `db` matcher failed the nested literal dynamic `db/internal/pool.mjs` fixture. These failures drove all four import forms and recursive `db/*` coverage.

### GREEN and regression evidence

Category Runtime, Service, Repository, and migration:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test server/tests/collect-category-resolution-runtime.test.mjs server/tests/collect-category-resolution-service.test.mjs server/tests/collect-category-resolution-repository.test.mjs server/tests/collect-category-resolution-migration.test.mjs
# 123 passed, 0 failed, 0 skipped
```

Required Task 5 integration set:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/collect-category-resolution-runtime.test.mjs server/tests/collector-scope-ingress.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/module-boundaries.test.mjs
# 113 tests; 112 passed, 1 PostgreSQL-configuration skip, 0 failed
```

Fresh complete server regression:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/*.test.mjs
# 582 tests; 578 passed, 4 configuration-based skips, 0 failed
```

All four changed production modules pass `node --check`; `git diff --check` passes. Test inventory remains **165 active, 14 historical/manual** files.

### Unverified range, risks, and rollback

- No PostgreSQL instance was configured. The PostgreSQL-facing barrier test deterministically interleaves stale enqueue and worker completion through the Repository contract, but real-engine locking and `ON CONFLICT` contention remain unverified. Four database-required full-suite cases were skipped.
- No live Ozon API, credential, production data, or external write was used. Store switches and capture failures use deterministic fakes.
- The Round 2 raw-text guard did not evaluate computed dynamic-import expressions and was not comment/string aware. Fix Round 3 supersedes the raw regular expressions; computed dynamic specifiers remain intentionally outside the literal-import contract.
- Roll back by reverting only the Fix Round 2 commit. It adds no schema migration. Migration `025` belongs to Fix Round 1 and may safely remain unused; do not destructively drop its cursor table during an application rollback.

## Fix Round 3 — comment/string-aware import extraction

### Outcome and contract changes

- Replaced raw-source import regular expressions with a small lexical scanner. It skips line and block comments, single- and double-quoted strings, and template raw text; `${...}` template expressions are recursively scanned as executable code.
- Static side-effect and `from` imports accept comments at token boundaries. Literal dynamic imports accept comments between `import`, `(`, and the first argument. Valid hexadecimal and Unicode string escapes are decoded before applying the existing Repository and recursive `db/*` path policy.
- Property methods named `import`, such as `loader.import(...)`, are not treated as ESM imports. Named, default, side-effect, and literal dynamic imports of the category Repository and recursive `db/*` paths remain rejected with the stable `CATEGORY_RESOLUTION_MODULE_BOUNDARY` contract.
- Current account collection and enrichment modules remain compliant. No collection, category-resolution, database, API, App, or extension contract changed.

### RED evidence

- The first focused unit run produced **3 tests, 0 passed, 3 failed**: comment-separated static and dynamic imports were missed, while import-shaped text inside comments and strings was rejected.
- After the initial lexical fix, the property-method regression produced **3 tests, 2 passed, 1 failed** because `loader /* property */ . /* call */ import("./db/connection.mjs")` was still mistaken for a dynamic ESM import.

### GREEN and regression evidence

Focused unit and current-module boundary checks:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/module-import-boundary.test.mjs server/tests/module-boundaries.test.mjs
# 4 passed, 0 failed, 0 skipped
```

Task 5 integration set with the focused boundary unit tests:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/collect-category-resolution-runtime.test.mjs server/tests/collector-scope-ingress.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/collector-ozon-enrichment-runtime.test.mjs server/tests/module-import-boundary.test.mjs server/tests/module-boundaries.test.mjs
# 116 tests; 115 passed, 1 PostgreSQL-configuration skip, 0 failed
```

Fresh complete server regression:

```sh
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-reporter=tap server/tests/*.test.mjs
# 585 tests; 581 passed, 4 configuration-based skips, 0 failed
```

The production guard and focused test file pass `node --check`; `git diff --check` passes. Test inventory is **166 active, 14 historical/manual** files.

### Unverified range, risks, and rollback

- The scanner intentionally extracts literal ESM specifiers rather than evaluating computed dynamic-import expressions. The guarded production modules contain no computed dynamic imports.
- No live PostgreSQL, Ozon API, credential, production data, or external write was involved. Existing four database-required full-suite cases remain configuration-skipped.
- Roll back by reverting only the Fix Round 3 commit. It adds no schema migration or data rewrite; the earlier category-resolution records and runtime cursor remain valid.
