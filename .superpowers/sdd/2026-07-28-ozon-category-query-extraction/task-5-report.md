# Task 5 report — preview/listing fail-closed integration

- Work item/state: Task 5 complete; scope stayed within the approved file boundary.
- Target: `/Users/songliang/Documents/sonli ozon3.0` dirty `main`, baseline `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`.
- Risk/approval: R2 compatible shared category-query consumer change; the ledger records exact approval. No new side effect was requested or performed.

## Outcome

`server/index.mjs` now creates exactly one module-scope `createOzonCategoryService()` next to the sync service. Preview and `queueCollectSubmissionV3` both pass callbacks that call only that service with `store.ownerAccountId`, the selected `store`, IDs and `language: "DEFAULT"`; normalizer consumers receive only `items`.

The preview entry no longer enables `allowUnresolvedRequiredDictionaryValues`, and it now rejects every incomplete normalization, including `COLLECT_EDIT_AUTO_CATEGORY`. Preview and final preparation force strict normalization so a category-service failure cannot be downgraded to a warning; safe service error codes are preserved in the existing preview, product-import and SKU-import failure responses.

## Files and contracts

- Modified: `server/index.mjs` (service wiring and safe failure response code only).
- Created: `server/tests/category-listing-readiness.test.mjs` (local temporary state and mocked fetch).
- Modified: Task 5 checkboxes only in `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`.
- Created operational evidence: `snapshots/task-5-before/`, `task-5-review-package.diff`, this report.
- No DB schema, API route replacement, normalizer contract, listing state machine, dependencies, config, deployment, UI, or external service configuration changed.

## TDD evidence

- Snapshot hashes were recorded in `snapshots/task-5-before/SHA256SUMS.txt`; every copied input hash matches its source hash.
- RED command: fixed Node running `server/tests/category-listing-readiness.test.mjs` failed before production changes with `assert.match` receiving `undefined` for the expected `OZON_CATEGORY_*` code. A second RED run without `strictTypeMatch` exposed that the normalizer would downgrade the category failure to a warning and lose the stable code.
- GREEN command: the same fixed-Node command passed after the minimal wiring and strict preview change.

## Validation and regressions

All passed with `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`:

1. `server/tests/category-listing-readiness.test.mjs`
2. `server/tests/import-preview-route.test.mjs`
3. `server/tests/import-currency-contract.test.mjs`
4. `server/tests/collect-listing-submit-failure.test.mjs`
5. `server/tests/external-write-safety.test.mjs`
6. `server/tests/ozon-import-normalizer.test.mjs`
7. `--check server/index.mjs`

Scoped `git diff --check -- server/index.mjs server/tests/category-listing-readiness.test.mjs docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` also passed.

The new test proves an attribute 503 produces non-200 `{ ok: false, code: /^OZON_CATEGORY_/ }`; it also proves unresolved required dictionary data in `COLLECT_EDIT_AUTO_CATEGORY` fails, keeps local jobs empty and makes zero external writes. Existing final-submit/external-write safety tests still pass with zero writes.

## Review findings

- The Task 1 snapshot diff for `server/index.mjs` contains only the service import, one module-scope instance, preview/final callback replacement, auto-category strictness and safe error-code propagation.
- The final callback normalizes through the service before `createSubmissionV3`; therefore category failure returns before snapshot/job creation. There is no success audit or external write before that call in this function.
- No product-cache fallback was added. Existing legacy inline category code and HTTP routes remain intentionally untouched for Task 6.
- All test fetches are local stubs. Fixture strings such as `local-key` are non-secret placeholders; no credentials are present.

## Unverified and rollback

- No PostgreSQL-backed queue was started: this task intentionally did not run DB/container work. The code ordering and local mock regression establish the fail-before-submission boundary; durable queue creation was not exercised.
- No real Ozon request or write occurred.
- Rollback is byte-level restoration of `server/index.mjs` from `snapshots/task-5-before/server-index.mjs`, removal of the new readiness test, and reverting Task 5 checkbox state. No data recovery is required.

## Next safe action

Proceed with Task 6 only: replace the still-present inline category HTTP routes and local-product fallback with the approved route handler. Do not broaden this Task 5 diff.

## Review-fix r1 — reviewer findings addressed

### Finding 1: category errors were downgraded or lost

Resolved. `server/ozon-import-normalizer.mjs` now has an explicit allowlist of the five approved `OZON_CATEGORY_*` codes. A listed safe error is rethrown unchanged from dictionary-value resolution and from the outer normalizer catch even when `strictTypeMatch` is false. This preserves its safe `status`, `code`, `body`, and `cause: null` without copying an upstream response or credentials.

An unresolved required dictionary value now produces the fixed, safe contract: status `422`, code `OZON_CATEGORY_DATA_INVALID`, message `必填字典属性未匹配到 Ozon 字典值，请检查后重试`, body `{ operation: "REQUIRED_DICTIONARY_VALUE" }`, and `cause: null`. The legacy permissive normalizer option is retained only for direct legacy consumers; Task 5 does not pass it.

Tests cover `OZON_CATEGORY_VALUES_UNAVAILABLE` at exact status `503` and `504`, exact code/body/cause preservation, the unresolved-required fixed contract, and a `strictTypeMatch: false` non-category failure still becoming one warning rather than a hard failure.

### Finding 2: final preparation had no direct no-DB proof

Resolved. `queueCollectSubmissionV3` now accepts an optional final `dependencies` argument. Production defaults remain the module-scope category service and `createSubmissionV3`; `testExports` exposes only this existing preparation function. The readiness test injects a category service failure and a `createSubmissionV3` spy, then directly invokes formal preparation. Both an attributes-unavailable error and an unresolved required dictionary error reject with stable contracts while the spy remains at zero. Since `createSubmissionV3` is the snapshot/job creation boundary, this proves failure occurs first without starting PostgreSQL.

The same readiness test covers preview, final category failure, final unresolved dictionary failure, and `COLLECT_EDIT_AUTO_CATEGORY`; its local jobs remain empty and external write count remains zero.

### Strict semantics correction

The prior forced `strictTypeMatch: true` change has been removed. Preview and formal preparation restore `!!body.strictTypeMatch`, preserving existing successful and non-category matching behavior. Fail-closed behavior for category failures is instead supplied by the allowlisted category-error rethrow; this meets the category boundary without broadening normal type matching.

### r1 evidence

- Snapshot: `snapshots/task-5-fix-r1-before/`; hashes are in its `SHA256SUMS.txt` and match every copied source.
- RED: `server/tests/ozon-import-normalizer.test.mjs` first failed with `Missing expected rejection`, proving the old normalizer swallowed a safe `OZON_CATEGORY_VALUES_UNAVAILABLE`; readiness initially failed until the seam and stable unresolved contract existed.
- GREEN: normalizer and readiness tests passed, followed by the complete Task 5 fixed-Node regression set, `node --check server/index.mjs`, and scoped `git diff --check`.
- Review package: `task-5-fix-r1-package.diff`.
