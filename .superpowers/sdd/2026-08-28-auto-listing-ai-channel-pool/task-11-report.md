# Task 11 report — final capacity, recovery, and regression acceptance

## Outcome and scope

Task 11 adds only acceptance tests, controlled browser fixtures, screenshots, and verification records. It does not change production behavior. The named fake-gateway journey and disposable PostgreSQL integration cover all ten plan cases; the combined targeted suite passes 23/23 with no skip. The exact planned non-target regression passes 72/72 with no skip when its controlled Chrome fixture is run outside the desktop sandbox.

Changed acceptance boundaries:

- New `server/tests/auto-listing-ai-channel-pool-journey.test.mjs`: two independent controlled channel handlers, shared per-item paid-call tracker, real worker queue handlers, real adapter idle watchdog, and v2/v3 queue compatibility.
- New `server/tests/auto-listing-ai-channel-pool-postgres.integration.test.mjs`: six real PostgreSQL tests mapping cases 1, 2, 5, 6, 8, 9, and 10.
- Strengthened runtime composition, workflow message secrecy, and browser request-control assertions.
- Updated stale latest-migration assertions to `098_auto_listing_ai_channel_pool.sql` only after explicit scope rulings.
- Refreshed the guarded configurable-skeleton E2E fixture to current exact category/gateway/outcome contracts and current copy-free/multi-group behavior, also only after explicit rulings. No production/category behavior changed.

## TDD evidence

- Initial RED: the exact two-file Task 11 command exited 1 because both named test files were absent.
- Fake journey GREEN: 3/3. It observes simultaneous A/B handler START events, maximum 1 active call per handler, maximum 1 paid call for the same item across channels, independent image generator/checker releases, deterministic A `NOT_SENT`, B retry, and zero B calls for an accepted main-image replay.
- PostgreSQL RED/GREEN: the new guarded file first explicitly skipped without a disposable URL; with the Task 11 PostgreSQL 16 container it ran 6/6, 0 skip. A skip was never reported as a pass.
- Mutation proof: changing the production uncertain-result threshold from `>=2` to `>=3` made case 6 fail with `REQUEUED` and count 2 instead of the required `RETRYABLE_ERROR`; restoring the original production rule made it pass. The temporary mutation left no diff.
- Journey tightening RED/GREEN: splitting image generation and checker into distinct paid stages exposed the old three-request expectation; the updated exact four-request sequence then passed.
- Guarded configurable-skeleton RED/GREEN: env-enabled PostgreSQL first exposed stale exact-key, ACK, policy, dimension and multi-group fixtures. Each root was traced to a current executable public contract, scoped separately, and corrected test-only. Final result is 6/6, 0 skip.
- Runtime/category composition RED/GREEN: the isolated 38-test pair reproduced two non-environment failures. The runtime fixture lacked the mandatory execution repository and v3 queue lifecycle expectation; the category fixture lacked the mandatory archive publication port. After separately authorized test-only updates, the pair passed 38/38 with no skip.

## Database and representative evidence

Container `sonli-task11-pg-20260828` used `postgres:16-alpine`, loopback-only random host port, no volume, and `max_locks_per_transaction=512`. `pnpm run db:migrate` exited 0; `schema_migrations` contained 98 rows and latest version `098_auto_listing_ai_channel_pool`. Tests created and dropped isolated schemas and used fixed account/job/item/channel IDs only.

The real repository/workflow evidence proves waiting attempts remain zero, channel lease capacity is bounded, first uncertainty requeues and second escalates, expired ownership is fenced by generation, upload claims remain source-ordered, and connected v3 work is isolated from the bounded legacy v2 drain. No real Sub2API or Ozon endpoint was available to these tests.

## Browser evidence

ego-browser ran in isolated task space 18 against the local Vite app with a pre-navigation closed fetch mock. Test IDs were `EGO-TASK11-TASK-CENTER-001` and `EGO-TASK11-AI-SETTINGS-002`. The rendered page showed the safe channel names and calling/waiting/switching states, then enabled the test channel through one controlled local POST. Both runs recorded `externalRequests=[]` and `secretsVisible=false`.

Screenshots are tracked under `docs/superpowers/verification/assets/`. The ego task space and Vite server were closed after capture.

## Verification

- Task 11 combined: 23/23 pass, 0 skip.
- Exact planned non-target regression: 72/72 pass, 0 skip, outside the desktop sandbox because sandboxed Chrome exited `SIGABRT` before assertions.
- Configurable-skeleton disposable-PG regression: 6/6 pass, 0 skip.
- Category strategy real composition disposable-PG E2E: pass without production externals.
- Production build: pass, 4851 modules, only existing large-chunk advisory.
- Disposable migration: pass through 098.
- Node syntax and `git diff --check`: pass.
- Standard `pnpm run verify`: not green on this machine. Final activity count is 3852 total, 3748 pass, 21 fail, 83 explicit skip. All 21 failures are environment gates: 19 Chrome launch failures inside the desktop sandbox, one missing installed `cheerio`, and one missing `QH_SOURCE_EXTENSION_DIR` UI parity gate. The verifier also returns three top-level upstream parity environment blocks and a compose interpolation block (first missing variable `MINIO_ACCESS_KEY`). These are recorded as gates/failures, not skipped passes.

## Safety, recovery, and cleanup

No paid capability button, real AI request, real Ozon write, production migration, push, deploy, merge, stash, reset, or original-checkout edit occurred. Business outbox secrecy assertions reject execution material and credential-shaped fields. The disposable container, local Vite process, and ego-browser task space are removed during final cleanup.

Operational rollback is to disable additional channels first, retaining single-channel capacity and all durable evidence. Code may be rolled back, but migration 098 and audit/lease rows remain; any schema correction must be forward-only.

## Known external boundary

This acceptance proves two independent fake gateway handlers, not two real upstream credentials. A real dual-Key statement requires separately authorized paid testing. The project-level verifier remains nonzero for the documented environment gates, so this report does not claim a fully green global verifier.
