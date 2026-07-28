# Task 8 review package

- Commits: none; the user forbids commits.
- Before snapshots:
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-8-before-index.mjs`
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-8-before-module-boundaries.test.mjs`
- Current files:
  - `server/index.mjs`
  - `server/tests/module-boundaries.test.mjs`
- Review focus:
  - `/local/sync/:type` authenticates first and passes only the seven approved fields.
  - Account ID and extension/web source are server-derived.
  - Existing response contract stays `{ ok, job, state }`.
  - No wrapper or migrated function definition remains in the entry.
  - The 5400-line guard is effective and current entry is below it.
  - Profile/binding call sites still use the service.
  - No unrelated route or body-spread call was changed.
