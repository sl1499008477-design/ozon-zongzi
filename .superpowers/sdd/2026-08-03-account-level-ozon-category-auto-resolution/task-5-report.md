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
- Store wakes query only `WAITING_STORE`/`MATCHED` records across all taxonomy scopes and run in coalesced asynchronous composite item/scope cursor pages of at most 16. Worker reconciliation filters for actionability before its limit, so incomplete waiters cannot starve recoverable work. Missing records use the default scope; existing records preserve their persisted scope. Both timer families are stopped on server close.
- No client request field, collection item, `collect_requests.store_id`, or plugin response gains credential-store scope. No HTTP response contract or database schema changed.

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
- A committed collection or enrichment result survives category scheduling failure. Missing/waiting work is durable and restart-discoverable. Incomplete waiters are excluded before applying the bounded limit, while store wakes page until drained.
- Worker drains are non-overlapping and capped at 16 operations; store wake pages are capped at 16 and scheduled asynchronously. Initial, interval, and continuation timers are all stoppable.
- Module-boundary tests prohibit collection routes and enrichment Service from importing the category Repository or database directly.

## Unverified range, regression risk, and rollback

- No live PostgreSQL instance was configured, so real-engine SQL execution/locking and live migration compatibility were not exercised. PostgreSQL Repository transaction behavior, executor-bound audit wiring, actionable query contract, and adapter selection were verified with focused doubles; four existing database-required tests were skipped.
- No live Ozon API, production credential, production data, or external write was used. Category calls were exercised through deterministic fakes.
- Primary regression risk is operational load/fairness when an account has a very large backlog. Processing is deliberately bounded and cursor-paged; safe logs and durable statuses provide diagnosis/retry.
- Roll back by stopping the category worker and reverting the Task 5 commit. Retain existing category-resolution/audit records; there is no Task 5 schema migration or destructive data rewrite to reverse. Existing collection and enrichment data remain valid.
