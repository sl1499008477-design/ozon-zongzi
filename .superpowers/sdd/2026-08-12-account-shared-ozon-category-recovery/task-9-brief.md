# Task 9 Brief — Account-shared category UI and latest ordinary task rows

## Goal

Replace store-category presentation with the account-shared category contract, expose only fixed safe recovery copy, submit administrator category choices through the dedicated confirmation route, and show one newest ordinary task row per `(source_record_id, target_store_id)` with its real job creation time.

## Allowed scope

The original scope is the 13 Task 9 plan files. The parent-approved plan amendment adds only the stale pure contract test `app/tests/collect-edit-layout.test.mjs`: that test imported and asserted store-bound helpers which Task 9 explicitly removes, so leaving it unchanged made the adjacent suite fail at module instantiation. This brief/report and progress ledger are delivery evidence and do not expand production scope. No migration, new server route, external Ozon/AI call, production database, or destructive history rewrite is allowed.

## Contracts

- Category resolution is taxonomy/account shared; UI must not describe matching as target-store specific.
- Manual selection is an administrator confirmation request with exact `collectItemId`, `expectedSourceVersion`, positive category/type IDs, `taxonomyScope`, `idempotencyKey`, and `correlationId`.
- Unknown server/vendor details never render; they map to fixed generic safe copy.
- `listJobs` ranks item rows inside the tenant by source record and target store before applying `limit`; `getJob` continues returning complete history.
- When a ranked job contains unselected sibling items, list-only item rows and item-scoped events are filtered to selected item IDs. Job-scoped events remain.
- UI rows add only the owning job ID and a canonical real job timestamp. Missing or invalid time renders `—`; no current-time fallback.
- Store labels come only from the current account's safe store data; raw row identifiers are not a display fallback.

## TDD gates

1. Add focused frontend and repository RED tests for every contract above.
2. Implement the minimum account-shared presenter, route wiring, row projection, and ranked SQL.
3. Run focused frontend/repository tests, real disposable PostgreSQL ranking with zero skips, adjacent regressions, syntax checks, and the frontend production build.

## Recovery and rollback

The change is presentation/list-read only except the already-existing administrator confirmation route. Rollback is the Task 9 commit; historical jobs, audit rows, source evidence, and recovery state remain untouched.
