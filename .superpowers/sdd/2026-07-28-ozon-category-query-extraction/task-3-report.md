# Task 3 report — atomic dictionary pagination and expiry failures

## Scope and safety

- Work item: Task 3, `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md`.
- Target path: `/Users/songliang/Documents/sonli ozon3.0`.
- Risk: R2 compatible shared category-query contract, covered by the recorded work-package approval.
- Boundary: only the category service, its focused test, the Task 3 plan checkboxes, and this required handoff report changed.
- External effects: none. Every Ozon response is a local injected fake; no real account, credential, product state, business state, network request, write, migration, dependency, configuration, or deployment action occurred.
- Git: dirty `main` at `d4ed427992e9e159d657197fd7bad07b4c2f6f8c` was preserved. No staging, commit, stash, rebase, worktree, push, or destructive Git action occurred.

## RED evidence

After adding the pagination, response-shape, deduplication, boundary, atomicity, repeated-cursor, expiry-refresh, and malformed-response tests, I ran:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

Result: exit 1 at `getCategoryAttributeValues`, with the expected pre-feature `OZON_CATEGORY_VALUES_UNAVAILABLE` error. The first new multi-page call could not succeed because Task 2 intentionally left dictionary values fail-closed.

## Implementation

- Implemented `getCategoryAttributeValues(input)` through the injected/default Ozon client only.
- Accepts both `result` arrays and `result.values` arrays, normalizes legacy dictionary aliases (`dictionary_value_id`, `name`) to `{ id, value, info, picture }`, and removes duplicate `{id,value}` values.
- Clamps total limits to 1 through 5000 (default 1000), limits individual Ozon pages to 1000, and scopes the cache by account, store, language, category, type, attribute, and total limit.
- Accumulates pages only in local variables. Cache write occurs once, after every requested page has succeeded and passed response/cursor validation.
- Fails with the fixed, sanitized `OZON_CATEGORY_DATA_INVALID` error for malformed response shapes, invalid cursors, and repeated non-zero cursors. Upstream page failures are converted to the safe `OZON_CATEGORY_VALUES_UNAVAILABLE` mapping.
- Expired entries are removed by the existing cache read path; a refresh failure returns an error and never stale items.

## GREEN and review evidence

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-service.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
git diff --check -- server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md
```

Results:

```text
ozon category service tests passed
ozon client tests passed
```

The syntax check and standard scoped `git diff --check` exited 0 with no output. Because the focused service/test files are currently untracked in the pre-existing dirty worktree, I also ran `git diff --no-index --check /dev/null` for each: both comparisons emitted no whitespace diagnostics (their exit 1 only denotes a new-file diff). Focused review also searched for credential/business-state dependencies. The only `apiKey` occurrence is the pre-existing test-only getter that intentionally fails if cache code reads a secret; the service contains no `state.caches.products`, `cacheItemsForStore`, `Api-Key`, or `Client-Id` access.

## Changed files

- `server/ozon-category-service.mjs`
- `server/tests/ozon-category-service.test.mjs`
- `docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md` (Task 3 checkboxes only)
- `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-3-report.md`
- `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/task-3-fix-r1-package.diff` (P1 fix review package)

## Self-check, regression, and recovery

- Tests prove mixed response shapes, the required `last_value_id: 2` continuation, deduplication, 1/5000 bounds, 1000-page cap, partial-page atomicity, repeated-cursor rejection, expired-cache refresh failure, and malformed-response non-caching.
- Direct category-service and Ozon-client regression passed. Routes, normalizer, UI, extension, database, and full gate were intentionally not run because this work package changed neither their code nor their contract wiring.
- No external data exists to recover. Rollback is limited to restoring the service and focused test changes and reopening the six Task 3 checkboxes; no cache survives process restart.

## Concerns

- This task implements only the service boundary. Route wiring and downstream readiness gates remain later plan tasks, so no HTTP/UI consumer was exercised here.
- Pagination intentionally fails closed on a malformed page or repeated/non-positive cursor. No retries/backoff were added because this read-only, injected service contract did not include a retry policy; upstream failures remain safely surfaced to its caller.

## Fix round 1 — validate `has_next` cursors before safe-limit exit

### Snapshot and scope

- Reviewer finding: a `has_next: true` page that filled `safeLimit` exited before validating its next cursor, allowing an invalid or repeated cursor page to enter cache.
- Before-edit snapshots: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/snapshots/task-3-fix-r1-before/` contains byte copies of the service, focused test, Task 3 plan, and this report. Their SHA-256 values were recorded at snapshot time.
- This fix changed only `server/ozon-category-service.mjs`, `server/tests/ozon-category-service.test.mjs`, this report, and the required scoped diff package. It made no real Ozon request or external/data/config/Git mutation.

### RED

After adding both boundary tests, the fixed runtime command was:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
```

It exited 1 with `AssertionError [ERR_ASSERTION]: Missing expected rejection` at the first new `limit: 1` test. Before the fix, `{ id: 0, value: "invalid-cursor" }` plus `has_next: true` filled the limit and was cached instead of rejecting. The second new test is present alongside it and covers a two-page sequence whose second page fills `limit: 2` while repeating cursor `1`; both tests also assert their post-failure retry starts with no `last_value_id`.

### Minimal change and GREEN

- `has_next` now unconditionally checks that `nextCursor` is positive and unseen before the safe-limit terminal branch.
- Only after that validation does the method stop fetching because it reached `safeLimit`; invalid/repeated cursor failures occur before `writeCache`.
- The two new tests verify `OZON_CATEGORY_DATA_INVALID`, `cause: null`, no half-result cache, and a next invocation that starts again from page 1.

Validation commands:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check server/ozon-category-service.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-category-service.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/tests/ozon-client.test.mjs
git diff --check -- server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md
git diff --no-index --check <fix-before-service> server/ozon-category-service.mjs
git diff --no-index --check <fix-before-test> server/tests/ozon-category-service.test.mjs
```

Results: syntax exit 0; category service output `ozon category service tests passed`; Ozon client output `ozon client tests passed`; standard scoped whitespace check had no output. The two `--no-index --check` commands had no diagnostics; their nonzero exit status only represents a content difference from the safety snapshot.

### Residual risk and recovery

- The service deliberately validates a continuation cursor even when the requested item count is already satisfied, which may surface an upstream malformed continuation marker that earlier code silently accepted. This is the required fail-closed behavior.
- No retries, network calls, or consumer wiring were added. Recovery is restoring the two source files from `snapshots/task-3-fix-r1-before/`; no data or external cache recovery is required.
