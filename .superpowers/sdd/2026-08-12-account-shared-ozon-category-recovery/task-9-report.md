# Task 9 Report — Account-shared category UI and latest ordinary task rows

Date: 2026-08-13

## Outcome

Task 9 is complete within the 13 planned files plus one parent-approved stale-test amendment. The collection/editor UI now consumes only the account-shared category summary, uses fixed safe recovery copy, removes target-store category language, and sends administrator choices through the existing dedicated confirmation route with source version, idempotency, and correlation identity. The ordinary automatic-listing table shows only the newest row for a `(source_record_id, target_store_id)` pair, uses the owning job's persisted creation time, and displays only safe current-account store labels.

No migration, new server route, destructive history rewrite, real external call, credential change, or production database access was introduced.

## Contracts changed

- Frontend category projection accepts only a descriptor-safe account-shared `ACTIVE`, `INVALIDATED`, or `NEEDS_REVIEW` summary for `OZON:DEFAULT`; getters and revoked proxies fail closed without execution. Listing IDs come only from an `ACTIVE` shared resolution.
- Category state and failure presentation uses fixed Chinese copy. Backend/vendor messages and unknown states are not rendered.
- Administrator confirmation sends the exact seven-field closed request to `/ozon/category-confirmations`: collect item, expected draft version, positive category/type IDs, taxonomy scope, idempotency key, and correlation ID. A response must return the same item and exact active manual category. An ambiguous retry reuses the same identity; a post-confirmation refresh failure cannot turn a committed confirmation into a false failure.
- `listJobs` ranks within the requested account by `source_record_id + target_store_id`, then applies the limit. List-only siblings and item events are filtered to the ranked items, while job events remain. `getJob` still returns the full historical graph and no rows are deleted.
- Table rows receive only their owning job ID and canonical persisted creation timestamp. Invalid/missing time renders `—`; no `Date.now()` fallback exists. Store names are bounded, control-free account data; identifiers are not displayed as names.

## Approved test-plan amendment

The pre-existing `app/tests/collect-edit-layout.test.mjs` statically imported `manualCategoryResolution` and asserted two store-bound preview/session helpers which Task 9 explicitly removes. Its preserved RED was a module `SyntaxError`. The approved amendment updates only that pure test to the account-shared `ACTIVE`/administrator-confirmation contract. No extra production file was added.

## TDD and verification evidence

- Initial focused RED: 71 total, 64 passed, 7 failed, 0 skipped. Six were intended contract gaps; one was the host's signed-Node Rollup Team-ID mismatch, not an application assertion.
- Stale adjacent test RED: 1 failed at module instantiation because the removed store-bound export was still imported.
- Final focused gate: **102 passed, 0 failed, 0 skipped**.
- Adjacent Task 3/7/8 category, worker, collection-public-shape, and auto-listing service contracts: **109 passed, 0 failed, 0 skipped**.
- Complete frontend unit/contract run: **307 passed, 0 skipped**; the only failure was an unrelated Playwright Chrome process abort before page startup. The same browser test failed identically in isolation and touched no Task 9 path, so it is not counted as a product pass.
- Fresh disposable PostgreSQL 16: **7 passed, 0 failed, 0 skipped**. The ranking test proves the newest row is selected before `limit`, old/new job history remains stored, and `getJob` can still read the old job.
- Production Vite build: **4843 modules transformed, success**. The existing bundle-size warning remains.
- Syntax checks for the changed plain JavaScript/server modules and `git diff --check` passed.

The normal signed Node executable could not load the installed Rollup native module because its macOS Team ID differs from the dependency signature. Verification therefore reused the already-existing, previously validated unsigned Node 24.14.0 at `/private/tmp/sonli-task6-review-node.gupk0W/node`. Task 9 neither created nor deleted that shared runtime. Its temporary dependency symlink was verified as a symlink and removed before commit.

No real Ozon seller/product/stock API, AI provider, object storage, production credential, production database, or deployed service was contacted.

## Residual risk and rollback

- The unrelated Playwright browser-launch test remains environment-blocked (`Chrome` exits with `SIGABRT` before a page is created). It does not exercise Task 9 code, but a browser-capable CI runner should rerun the complete frontend suite.
- PostgreSQL ranking is deterministic by `created_at DESC, job.id DESC, item.id ASC`. This preserves history but intentionally changes only the ordinary list projection; audit/history endpoints remain the recovery source of truth.
- Roll back the Task 9 commit to restore the prior UI/list behavior. No schema or data rollback is required and historical task/audit rows must not be deleted.
