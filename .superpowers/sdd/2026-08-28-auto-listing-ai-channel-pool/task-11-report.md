# Task 11 report — final capacity, recovery, and regression acceptance

## Outcome and scope

Task 11 adds only acceptance tests, controlled browser fixtures, screenshots, and verification records. It does not change production behavior. After first-review remediation, the named adapter/worker journey and disposable PostgreSQL integration cover all ten plan cases; the combined targeted suite passes 25/25 with no skip. The exact planned non-target regression passes 72/72 with no skip when its controlled Chrome fixture is run outside the desktop sandbox.

Changed acceptance boundaries:

- `server/tests/auto-listing-ai-channel-pool-journey.test.mjs`: real adapter idle watchdog and real worker v2/v3 queue compatibility. The review-weak hand-built switch and `acceptedSlots` proof was removed.
- `server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs`: nine real PostgreSQL tests covering durable capacity, competing same-item claims, real workflow requeue/allocator switching, production accepted-asset reuse, cooldown expiry, uncertainty, takeover fencing, upload ordering, and v2/v3 isolation.
- Strengthened runtime composition, workflow message secrecy, and browser request-control assertions.
- Updated stale latest-migration assertions to `098_auto_listing_ai_channel_pool.sql` only after explicit scope rulings.
- Refreshed the guarded configurable-skeleton E2E fixture to current exact category/gateway/outcome contracts and current copy-free/multi-group behavior, also only after explicit rulings. No production/category behavior changed.

## TDD evidence

- Initial RED: the exact two-file Task 11 command exited 1 because both named test files were absent.
- Journey GREEN: 2/2 for real adapter idle semantics and worker v2/v3 routing. Durable switching and serialization are intentionally not claimed from this in-memory driver.
- PostgreSQL GREEN: with the Task 11 PostgreSQL 16 container it ran 9/9, 0 skip. Without its explicit gate it has 9 skips, never reported as passes.
- Durable requeue mutation RED: retaining channel A's assignment after `NOT_SENT` left no B claim. Restored production assignment clearing produced a fresh allocator-owned generation-2 B envelope.
- Accepted-reuse mutation RED: bypassing the production generator's `EXISTING_ACCEPTED` branch made B replay fail `AUTO_LISTING_IMAGE_RESERVATION_FAILED`. Restored production code returned A's accepted record with producer/checker A and B generate/checker counts both zero.
- Same-item competition mutation RED: removing allocator assignment/live-sibling guards and temporarily weakening migration 098's assignment unique index let both concurrent repository claims succeed (`2 !== 1`). Restored code and schema admit one owner and leave the sibling `PENDING/attempts=0`.
- Cooldown mutation RED: ignoring both allocator cooldown predicates claimed work during cooldown. Restored predicates return no work without consuming attempts; a normal poll after database-time expiry claims it without manually clearing cooldown.
- Generation-fence mutation RED: removing the workflow `dispatch_generation=$4` equality let a generation-only stale outcome pass the ownership lock and reach a version conflict. Restored code rejects authentic generation-1 renew/outcome/requeue and the generation-only stale outcome without changing the generation-2 snapshot.
- Mutation proof: changing the production uncertain-result threshold from `>=2` to `>=3` made case 6 fail with `REQUEUED` and count 2 instead of the required `RETRYABLE_ERROR`; restoring the original production rule made it pass. The temporary mutation left no diff.
- Journey tightening RED/GREEN: splitting image generation and checker into distinct paid stages exposed the old three-request expectation; the updated exact four-request sequence then passed.
- Guarded configurable-skeleton RED/GREEN: env-enabled PostgreSQL first exposed stale exact-key, ACK, policy, dimension and multi-group fixtures. Each root was traced to a current executable public contract, scoped separately, and corrected test-only. Final result is 6/6, 0 skip.
- Runtime/category composition RED/GREEN: the isolated 38-test pair reproduced two non-environment failures. The runtime fixture lacked the mandatory execution repository and v3 queue lifecycle expectation; the category fixture lacked the mandatory archive publication port. After separately authorized test-only updates, the pair passed 38/38 with no skip.

## Database and representative evidence

Container `sonli-task11-review-pg-20260828` used `postgres:16-alpine`, loopback-only host port, no volume, and `max_locks_per_transaction=512`. `pnpm run db:migrate` exited 0; `schema_migrations` contained 98 rows and latest version `098_auto_listing_ai_channel_pool`. Tests created and dropped isolated schemas and used synthetic account/job/item/channel IDs only.

The real repository/workflow evidence proves waiting attempts remain zero, channel lease capacity is bounded, simultaneous sibling claims cannot cross the item mutex, first uncertainty requeues and second escalates, cooldown-only capacity resumes on normal polling after expiry, expired ownership and persistence are fenced by generation, upload claims remain source-ordered, and connected v3 work is isolated from the bounded legacy v2 drain. The production generator/repository reuse boundary proves no B paid call for A's already accepted asset. No real Sub2API or Ozon endpoint was available to these tests.

## Browser evidence

ego-browser ran in isolated task space 18 against the local Vite app with a pre-navigation closed fetch mock. Test IDs were `EGO-TASK11-TASK-CENTER-001` and `EGO-TASK11-AI-SETTINGS-002`. The rendered page showed the safe channel names and calling/waiting/switching states, then enabled the test channel through one controlled local POST. Both runs recorded `externalRequests=[]` and `secretsVisible=false`.

Screenshots are tracked under `docs/superpowers/verification/assets/`. The ego task space and Vite server were closed after capture.

## Verification

- Task 11 combined: 25/25 pass, 0 skip.
- Durable allocator/workflow retry/generation/upload PostgreSQL regressions: 31/31 pass, 0 skip.
- Worker/outbox/workflow/asset/image/generation/upload-worker regressions: 267 total, 266 pass, 1 explicit PostgreSQL-gate skip, 0 fail.
- Exact planned non-target regression: 72/72 pass, 0 skip, outside the desktop sandbox because sandboxed Chrome exited `SIGABRT` before assertions.
- Configurable-skeleton disposable-PG regression: 6/6 pass, 0 skip.
- Category strategy real composition disposable-PG E2E: pass without production externals.
- Production build: pass, 4851 modules, only existing large-chunk advisory.
- Disposable migration: pass through 098.
- Node syntax and `git diff --check`: pass.
- Standard `pnpm run verify`: fresh 2026-08-29 run is not green on this machine. The activity count is 3854 total, 3747 pass, 21 fail, 86 explicit skip (the review removed one hand-driven PASS and added three guarded PostgreSQL cases). All 21 failures are environment gates: 19 Chrome launch failures inside the desktop sandbox, one missing installed `cheerio`, and one missing `QH_SOURCE_EXTENSION_DIR` UI parity gate. The verifier also returns three top-level upstream parity environment blocks and a compose interpolation block (first missing variable `WEB_PORT`). These are recorded as gates/failures, not skipped passes.

## Safety, recovery, and cleanup

No paid capability button, real AI request, real Ozon write, production migration, push, deploy, merge, stash, reset, or original-checkout edit occurred. Business outbox secrecy assertions reject execution material and credential-shaped fields. The disposable container, local Vite process, and ego-browser task space are removed during final cleanup.

Operational rollback is to disable additional channels first, retaining single-channel capacity and all durable evidence. Code may be rolled back, but migration 098 and audit/lease rows remain; any schema correction must be forward-only.

## Known external boundary

This acceptance proves two independent fake gateway handlers, not two real upstream credentials. A real dual-Key statement requires separately authorized paid testing. The project-level verifier remains nonzero for the documented environment gates, so this report does not claim a fully green global verifier.
