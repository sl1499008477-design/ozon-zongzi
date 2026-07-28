# Task 7 review package

- Commits: none; the user forbids commits.
- Before snapshots:
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-7-before-index.mjs`
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-7-before-sync-service.mjs`
  - `.superpowers/sdd/2026-07-28-ozon-sync-service-extraction/task-7-before-sync-test.mjs`
- Current files:
  - `server/ozon-sync-service.mjs`
  - `server/tests/ozon-sync-service.test.mjs`
- Review focus:
  - Exactly four total attempts for version conflicts, no retry for other errors, and reload before every attempt.
  - Final owner revalidation occurs inside each success-commit attempt and returns 409 without cache mutation.
  - FAILED persistence does not mask the original business error or leak secrets.
  - SUCCESS report, cache, profile fields, and terminal audit share one save.
  - POSTINGS merge preserves latest concurrent rows and updates.
  - Unsupported types close RUNNING to FAILED without calling Ozon.
  - Explicit account ID is mandatory and no legacy current-account fallback remains.
  - No Task 6 pagination behavior or entry route contract is changed.
