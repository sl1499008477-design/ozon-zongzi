# Task 6 review package

- Commits: none; the user forbids commits.
- Before snapshots:
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-6-before-index.mjs`
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-6-before-sync-service.mjs`
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-6-before-sync-test.mjs`
- Current files:
  - `server/index.mjs`
  - `server/ozon-sync-service.mjs`
  - `server/tests/ozon-sync-service.test.mjs`
- Review focus:
  - FBS/FBO pagination, date windows, cursor/last-id terminal conditions, and fetched counts.
  - `PERIOD_IS_TOO_LONG` handling must not silently omit part of the requested range or change the range on later cursor pages.
  - FBO failure must fail the whole job and preserve old postings.
  - Warehouse POST and promotion GET replace only the target-store cache.
  - The entry is now only a parameter adapter and contains no migrated sync dead branches.
  - Report/audit behavior remains coherent across all four types.
  - Task 7 remains responsible for conflict retries and final ownership revalidation.
