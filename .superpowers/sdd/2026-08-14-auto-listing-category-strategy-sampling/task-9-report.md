# Task 9 report — exact published-strategy creation gate

## Outcome

- `REQUIRE_EXACT_STRATEGY` now authorizes every current source against the same-account exact
  `OZON:DEFAULT + descriptionCategoryId + typeId` publication before store/warehouse reads,
  category lease acquisition, listing-base preparation, job graph creation or AI work.
- `EXACT_CATEGORY_TYPE_V2` is accepted only on the exact scope. Legacy `EXACT_CATEGORY` is accepted
  only when the persisted rule itself contains a matching `exactScope`; ancestor, product-style,
  default and category-only V1 rules cannot satisfy strict mode.
- `LEGACY_FALLBACK` preserves existing resolution and `BALANCED_DEFAULT` behavior.
- Missing strategy returns stable `AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED` / 409. The route projects
  only exact scope, closed status, `canManage`, and an exact same-account `draftId` for authorized
  administrators. Strategy races return a fixed safe 409 without internal evidence.
- Continue-create is a normal new-key submission: it reloads current sources/publication and the
  existing creation path revalidates store, warehouse, currency and frozen requested counts.
- The final PostgreSQL transaction rechecks account policy version, current published version,
  exact leased category scopes and selected rule IDs before any job/snapshot/base/outbox write.

## Files and contracts

Planned files:

- `server/auto-listing-service.mjs`
- `server/auto-listing-runtime.mjs`
- `server/auto-listing-routes.mjs`
- `server/tests/auto-listing-service.test.mjs`
- `server/tests/auto-listing-runtime-worker.test.mjs`
- `server/tests/auto-listing-routes.test.mjs`

Recorded minimal adjacent scope:

- `server/auto-listing-repository.mjs` — account policy/draft read, full V2/typed-V1 projection,
  and atomic create-graph revalidation.
- `server/tests/auto-listing-postgres.integration.mjs` — real PostgreSQL mode/publication/source
  drift and continuation proof; also repairs stale Task 7/8 integration fixtures so current
  planning-contract, currency-authority and dynamic-count gates are exercised.

No migration or public request authority field was added. The job graph internal command gained
the server-owned `categoryStrategyGate { mode, policyVersion, scopes[] }`; persisted job/event
evidence continues to freeze `strategyVersionId` and per-item `ruleId`.

## TDD and verification

- Meaningful RED: 8 focused new service/route cases, 0 pass / 8 fail before implementation.
- Final planned service/runtime/routes suite: 124 pass / 0 fail / 0 skip.
- Fixed skeleton, configured counts and Task 8 adjacent suite: 41 pass / 0 fail; its one database
  gate was then exercised separately on real PostgreSQL.
- Disposable loopback PostgreSQL 16, tmpfs/no volume, random port:
  - migrations 001–076 and configurable skeleton E2E: 6 pass / 0 fail / 0 skip;
  - auto-listing repository/create graph/races: 7 pass / 0 fail / 0 skip;
  - real Task 9 proof covers policy-version drift, retired publication, source-category drift,
    account-first concurrent publication/rollback with the production AI-stage path, and successful
    new-key continuation. Every losing drift asserts zero job, source snapshot, listing base and AI
    outbox writes. Success asserts current strategy/rule, exact store/warehouse, RUB currency and
    the original normalized 7-image role counts.
- Production module syntax checks, `git diff --check`, and focused regression checks passed.
- The disposable PostgreSQL container and all tmpfs data were removed after verification.

## External boundaries and recovery

- No real Ozon, paid AI, object storage, production database or product write was invoked.
- Rollback is a code revert of the Task 9 commit. No schema or immutable Task 1–8 evidence requires
  deletion; existing jobs keep their already frozen strategy and configuration evidence.

## Residual risk

- The real concurrency proof coordinates the same account-first database mutation boundary used by
  publication and rollback, rather than calling the full administrator service fixture. The full
  publishing service remains covered by Tasks 5–7; Task 9 proves the create-side lock ordering and
  zero-write result with two real PostgreSQL connections and AI staging enabled.
- Task 10 owns the Web configuration dialog and “return and continue” UI. Task 9 intentionally
  supplies only the backend error and resubmission contract.
