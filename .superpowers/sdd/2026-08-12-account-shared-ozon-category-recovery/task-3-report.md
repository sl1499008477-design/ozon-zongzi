# Task 3 Report — Account-shared Ozon category recovery

Date: 2026-08-12

## Outcome

Task 3 replaces the active store-scoped category resolver with account-shared source evidence:

- Collection and linked Ozon enrichment now record immutable category evidence inside the caller-owned JSON/PostgreSQL transaction.
- Missing category IDs use exact read-only lookup in strict order: product ID, then exact offer/SKU; no list/search/fuzzy endpoint exists.
- Manual authority is available only through `POST /ozon/category-confirmations`, with backend administrator authorization, account/item/source-version checks, idempotency fencing, optimistic shared-state versioning, actor/time evidence, and atomic audit persistence.
- Public shared-category output is the closed eleven-field projection from the brief and is deeply frozen.
- PATCHing a collection draft no longer invokes a manual-category persistence hook.
- The old store resolver, wake notifier, timer, cursor, post-commit scheduler, and compatibility composition are no longer active.

## Contracts

### Collection evidence

`recordCollectionResult` accepts the authenticated account, canonical collect item, source version, product draft identity/version, capture time, and raw response hash/reference. It writes through the Task 2 account-shared repository. Replays of the same source record/version are idempotent; conflicting evidence fails closed; a new source version appends evidence.

Task 2 intentionally closes source kinds to `PRODUCT_DRAFT` and `ENRICHMENT_CACHE`. Therefore an exact Ozon read is attached to the canonical product-draft evidence with an `ozon-read:...` raw reference/hash rather than introducing an unreviewed third persistence source kind.

### Exact lookup

- `/v2/product/info` with exact `product_id`
- on absence only, `/v2/product/info` with exact `offer_id`
- `/v4/product/info/attributes` only when the exact returned product lacks category facts
- returned identity must equal the requested stable identity
- both category IDs must be positive
- input and response carriers reject proxies, accessors, cycles, dangerous keys, unknown shapes, and responses above 256 KiB
- auth, absence, mismatch, malformed data, network ambiguity, and oversize all return one frozen safe unresolved result and write nothing
- credentials are selected ephemerally from an account-owned current store and are never persisted in evidence/shared/public DTOs

### Manual confirmation

The request body is exact and closed:

`collectItemId, expectedSourceVersion, descriptionCategoryId, typeId, taxonomyScope, idempotencyKey, correlationId`.

JSON confirmation uses a cloned working state and commits category arrays only after state persistence succeeds. PostgreSQL confirmation uses one transaction for advisory idempotency fencing, current evidence/version reads, manual evidence/shared transition, and append-only `audit_events` insertion. Replays return the stored exact public result; mismatched replays, stale source versions, cross-account/missing items, ordinary users, and extra fields write nothing.

## TDD record

RED observations:

- Initial three Task 3 test files: 0 pass / 3 file-level failures because the new service/runtime/lookup modules did not exist.
- Collection enrichment atomic-evidence tests failed until completion carried evidence into the caller-owned transaction.
- Public projection test failed on the legacy category shape before the closed account-shared projection was wired.
- PostgreSQL confirmation test: 3/4 passed, expected failure was `OZON_CATEGORY_CONFIRMATION_UNAVAILABLE`.
- PostgreSQL idempotency-fence assertion failed before the advisory lock was added.
- Exact lookup descriptor-safety test: 3/4 passed before credential accessor/proxy rejection.
- JSON source and confirmation failure tests demonstrated partial mutation before cloned-working-state commits were added.

GREEN verification:

- Required Task 3 command: **78 passed, 0 failed, 0 skipped**.
- Account-shared repository/migration, seams, module boundaries, ingress, completeness, and deletion regression: **102 passed, 0 failed, 2 expected PostgreSQL skips**.
- Syntax checks passed for the server entry and all four new Task 3 modules.
- `git diff --check` and test inventory passed; inventory reports 362 active and 14 historical/manual tests.
- Baseline before Task 3: 94 passed, 0 failed, 1 expected PostgreSQL skip.

## Entry migration and deletions

New focused modules:

- `server/account-shared-ozon-category-service.mjs`
- `server/account-shared-ozon-category-runtime.mjs`
- `server/account-shared-ozon-category-composition.mjs`
- `server/ozon-source-category-lookup.mjs`

Migrated entry points:

- JSON account-scoped collection route
- PostgreSQL collection pipeline
- linked Ozon enrichment service/runtime
- server composition, batch public read, and confirmation route
- subprocess/seam and protected integration fixtures
- account deletion for all four account-shared category arrays
- module import boundary to the new repository/runtime pair

Deleted production modules:

- `collect-category-resolution-policy.mjs`
- `collect-category-resolution-repository.mjs`
- `collect-category-resolution-service.mjs`
- `collect-category-resolution-runtime.mjs`
- `collect-category-auto-resolution-composition.mjs`

Deleted the six tests that asserted only the retired contract. Legacy state-key mentions remain solely in Task 2 migration cleanup so an old JSON state is consumed and the retired keys are deleted; they do not provide an active resolver path.

## Unverified, risks, and rollback

- No real Ozon request, paid AI call, or Ozon product write was performed. Exact lookup tests use a controlled transport.
- Disposable PostgreSQL integration suites were not enabled because no dedicated test database was supplied; repository SQL behavior and the new confirmation transaction were verified with controlled executors.
- The complete 362-file active suite was not claimed: tests importing the full server entry cannot load the existing ad-hoc-signed Sharp binary under the bundled hardened Node because their Team IDs differ. This is an environment/dependency signing blocker; the focused and adjacent suites above do not use that binary.
- Missing-ID lookup may extend a collection transaction while the bounded seller read completes. It is restricted to exact read-only calls and successful evidence remains atomic; operational latency should be monitored.

Rollback is `git revert <final Task 3 commit SHA>`. This restores the retired runtime modules and entry wiring. No Task 3 schema migration was added; migration 063 and all canonical source evidence remain intact. The final commit SHA is reported in the handoff because a commit cannot embed its own final hash.

## Self-review

- Verified no active import/call remains for the retired composition, store snapshot, scheduler, wake notifier, timer, cursor, or `saveManualFromDraft`.
- Verified the account-shared repository carries no store identity, credentials, or network access.
- Verified public DTOs do not include account/store/raw/hash/attribute/credential/error-detail fields.
- Verified all external failures map to fixed safe codes/messages and no raw vendor/secret data is logged or returned.
- Verified candidate or draft data has no code path to the confirmation mutation.
- Verified unrelated Task 4+ UI and snapshot files were not modified.
