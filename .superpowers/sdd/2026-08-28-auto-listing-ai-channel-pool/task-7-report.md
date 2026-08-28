# Task 7 report: exact leased phase routing and cost provenance

## Outcome

Task 7 is implemented in commit `2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4`
(`feat: route auto-listing phases through leased channels`) and review remediation
commit `b8867fc27a9a4480cf0501e6ea66c58016cefbb5`
(`fix: fence AI attempts by exact execution owner`), and producer-provenance
remediation commit `94363872782a9269d458680bf6944fffc69e2b7e`
(`fix: preserve paid producer provenance across channel reclaim`), and validated-evidence
remediation commit `b7b95c7fb5c260bcb2dfccb4ea2028b7e8ca1cd2`
(`fix: validate paid evidence before preserving producer`), and PostgreSQL
acceptance-fixture remediation commit `11e67d78dd1ecd57c53e2a0c845041bddfb431ae`
(`test: repair task 7 PostgreSQL acceptance fixtures`), and fifth-review
PostgreSQL routing-acceptance commit
`d56fb551e18fae99958ebca61b4e11a3af9a0f21`
(`test: cover task 7 PostgreSQL exact routing`). The original report was
recorded in commit `100aeef8f3cf119a8720f51231a0fdbe1a998d8d` and the fourth-review
report update in `f59e423d206efd9e64613ac2885cd66b4473d5de`.

Paid auto-listing phases now keep the job-frozen profile models and protocols while resolving only the exact adopted channel connection/version. No selector, arbitrary connection, current-profile, or default-connection fallback was added. Planner, image generator/checker, and rich-content attempts persist their leased connection provenance, and repository writes fence the account/item/status-version attempt owner and connection version.

No real AI, Sub2API, Ozon, deployment, or push side effect was performed.

The initial independent Task 7 review failed with 0 Critical, 2 Important, and
0 Minor findings. It found that rich-content reserve/terminal/release operations
did not yet lock and fence the current `GENERATING` item status/version/active
plan, and that the exported memory image-attempt repository did not enforce the
same exact gateway connection pair as PostgreSQL. Both findings are closed by
the remediation commit above.

The second fresh cumulative review failed with 0 Critical, 1 Important, and
0 Minor finding. It identified that channel reclaim still treated mutable
execution ownership as producer provenance: channel B overwrote channel A even
when B reused A's already-paid planner response or generated image. The second
remediation separates these meanings without adding columns: reservation and
recovery results return the immutable producer pair, while the Task 6 worker
lease remains the authority for the current execution. If the repository cannot
prove reusable paid evidence, the producer pair changes to B before B makes a
paid producer call.

The third fresh cumulative review failed with 0 Critical, 3 Important, and
0 Minor findings. It found that the A-preservation predicate was still weaker
than actual reuse: planner row existence could pin A before response and
semantic validation, image reclaim could pin A before full frozen-runtime and
stored-byte validation, and memory release omitted checker provenance. The
third remediation closes all three findings. Planner A is preserved only after
the loaded response passes hash/shape and current closed semantic validation;
image A is preserved only after frozen model/input evidence plus actual stored
bytes, hash, content type, dimensions, and size all pass. Invalid A evidence is
exact-fenced before B performs one paid call. Memory and PostgreSQL-capable
ports now retain the same producer/checker meanings.

The fourth fresh cumulative review failed with 0 Critical, 2 Important, and
0 Minor findings, both confined to real-PostgreSQL acceptance setup rather than
production behavior. The phase-context fixture omitted the required
deterministic `source_order`; the generation fixture inserted connection
versions directly as `ACTIVE`/`VALIDATED`, which migration 053 correctly
rejects because new versions must begin `PENDING`. The fixture remediation adds
the current required job-item fields and creates both connections as PENDING,
then transitions both through PENDING → VALIDATED with capability evidence and
A through VALIDATED → ACTIVE with exact status-version increments.

The fifth fresh cumulative review failed with 0 Critical, 2 Important, and
0 Minor findings, both acceptance gaps rather than production defects. The
planner PostgreSQL test supplied no mandatory gateway pair, so it failed closed
before exercising its SQL. The passing phase-context integration covered only
legacy `execution: null`, so it did not prove the real connection-backed v3
route or its no-fallback mismatch behavior. The fifth fixture-only commit
closes both gaps using legal PENDING → VALIDATED → ACTIVE connection setup.

## TDD evidence

### RED

Tests were added before implementation for these missing contracts:

- phase context receives `{ message, execution }`, projects frozen model configuration plus the exact leased connection/base URL, and rejects an evidence mismatch instead of falling back;
- the v3 worker passes the currently adopted execution to context loading, while the v2 drain passes `execution: null`;
- the orchestrator forwards the same frozen `gatewayExecution` to planner, image, and rich-content callers;
- planner reservation/reclaim SQL persists `gateway_connection_id/version`;
- caller/repository tests require leased idle timeout, generator/checker provenance, and exact SQL connection fences.

The first focused RED run failed at the intended boundaries: the context loader still accepted a raw message and used profile routing, the worker passed only the message, the orchestrator rejected `gatewayExecution`, and planner-attempt reservation rejected/omitted the new provenance fields. A later focused run had 4 stale-contract failures (phase input/value assertions and two worker fixtures); those were updated only after the production contracts existed.

Review remediation also followed RED/GREEN in two passes:

- the first four-file run had 6 intended failures: rich caller/orchestrator did
  not propagate `expectedStatusVersion`; PostgreSQL rich reserve did not fence
  `GENERATING`/status version/active plan; rich terminal/release SQL did not
  include the current item; and memory generation allowed connection B to
  terminalize or reclaim connection A;
- after the basic live-item `UPDATE ... FROM` fence was green, an additional
  race test intentionally failed until terminal and release statements acquired
  the current item row with `FOR UPDATE` before changing an attempt. This closes
  the status-transition race rather than merely checking a statement snapshot.

The second review remediation began with 6 intended focused failures across
planner/image memory and PostgreSQL-capable repositories and callers. The RED
cases proved that reclaim returned B instead of A for reusable evidence, callers
loaded or terminalized A's evidence through B, and the no-evidence path did not
consistently return B. After those became green, a further repository audit
added a corrupt stored-image RED: the old SQL considered non-null columns
reusable and passed connection version `9` where the full validator had to return
`false`. The production fix then reused the same object/runtime evidence
validator for the reclaim decision.

The third review remediation also followed strict RED/GREEN:

- the planner focused RED failed 2/2 because the caller threw on invalid A
  evidence and the repository had no atomic replacement operation;
- the image/memory/PostgreSQL focused RED failed 3/3 because corrupt A evidence
  threw `AUTO_LISTING_IMAGE_EXISTING_CORRUPT`, PostgreSQL had no exact evidence
  replacement operation, and memory release returned no checker pair;
- persisted `REJECTED` planner evidence then had a dedicated RED (`1 !== 0`)
  proving stale validation was replayed before replacement; GREEN replaces A
  before any A validation write;
- malformed planner evidence had a dedicated RED that surfaced
  `AUTO_LISTING_CONTENT_PLAN_REPOSITORY_FAILED`; GREEN treats the closed
  evidence repository's INVALID/CONFLICT results as unusable A evidence and
  exact-fenced replaces it before one B paid call;
- race tests prove a stale replacement makes no B gateway/storage/evidence
  call and no partial repository mutation.

Fourth-review RED was reproduced against a disposable PostgreSQL 16 container:

- phase-context integration failed with PostgreSQL `23502`, null
  `auto_listing_job_items.source_order`;
- generation integration failed with trigger `23514`, "AI gateway connection
  versions must be inserted as PENDING";
- after those blockers were removed, the same live tests exposed three additional
  stale fixture inputs before their intended assertions: the phase factory's
  required real reference projector, the generation job item's `source_order`,
  and the memory release producer pair. These were corrected only in the two
  authorized test fixtures; no production file changed.

Fifth-review RED/acceptance-gap reproduction used a fresh disposable
PostgreSQL 16 container. The planner repository test failed 0/1 with
`AUTO_LISTING_CONTENT_PLAN_REPOSITORY_INVALID` before any SQL because its
request omitted the now-mandatory gateway connection id/version. The existing
phase-context integration remained green, but direct inspection confirmed it
passed only `execution: null`; therefore it could not exercise or reject any
connection-backed v3 route. The fixture was first repaired to reach PostgreSQL,
then the A→B provenance, stale-write, real-v3, and mismatch assertions were
added. They exposed no production failure.

### GREEN

Final focused routing/provenance regression:

```text
node --test <15 Task 7 and direct regression files>
tests 432
pass 431
fail 0
skipped 1
```

The one skip is `auto-listing-ai-phase-context-postgres.integration.test.mjs`; it requires both `AUTO_LISTING_POSTGRES_TESTS=1` and `SONLI_MIGRATION_TEST_DATABASE_URL`. Those nonproduction database gates were not enabled.

Final image/checker/rich-content regression after the last provenance-validation changes:

```text
tests 251
pass 251
fail 0
skipped 0
```

Final review-remediation focused caller/repository/orchestrator run:

```text
tests 202
pass 202
fail 0
skipped 0
```

Final prior-Task-7 plus Task-6 memory-parity regression:

```text
tests 500
pass 499
fail 0
skipped 1
```

Final Task-8 adapter/caller plus Task-6 worker/memory regression:

```text
tests 356
pass 356
fail 0
skipped 0
```

Final second-review focused planner/image repository and caller regression:

```text
tests 234
pass 234
fail 0
skipped 0
```

Final cumulative Task 7 regression after producer-provenance remediation:

```text
tests 505
pass 504
fail 0
skipped 1
```

Final exact Task 8 adapter/orchestrator/worker regression:

```text
tests 207
pass 207
fail 0
skipped 0
```

Final Task 6 worker/workflow/memory parity regression:

```text
tests 138
pass 137
fail 0
skipped 1
```

Final third-review expanded direct regression:

```text
tests 414
pass 412
fail 0
skipped 2
```

Final third-review Task 7 planned routing suite:

```text
tests 68
pass 67
fail 0
skipped 1
```

Final third-review Task 6 memory parity regression:

```text
tests 139
pass 138
fail 0
skipped 1
```

Final third-review Task 8 idle/delivery regression:

```text
tests 207
pass 207
fail 0
skipped 0
```

Final fourth-review PostgreSQL 16 acceptance run with both gates enabled:

```text
tests 70
pass 70
fail 0
skipped 0
```

This single run included the exact six-file Task 7 routing suite,
`auto-listing-generation-attempt-postgres.integration.test.mjs`, and
`auto-listing-ai-workflow-postgres.integration.test.mjs`. An initial combined
run reached 69/70 but PostgreSQL's default lock budget failed one concurrent
migration-heavy schema with `53200`; the disposable container was recreated
with `max_locks_per_transaction=512`, after which the unchanged suite passed
70/70. The container was stopped, its `--rm` removal was verified with
`docker ps -a`, and no Task 7 container remains.

Normal fourth-review regressions after the fixture changes remained:

```text
Task 7 expanded direct: 414 tests, 412 pass, 0 fail, 2 gated skips
Task 6 memory parity:    139 tests, 138 pass, 0 fail, 1 gated skip
Task 8 idle/delivery:    207 tests, 207 pass, 0 fail, 0 skips
```

Final fifth-review PostgreSQL 16 acceptance run with both gates enabled:

```text
tests 71
pass 71
fail 0
skipped 0
```

This run covered the prior eight-file PostgreSQL routing/workflow suite plus
`auto-listing-content-plan-repository-postgres.test.mjs`. It executed real SQL
for planner A→B accepted-evidence reuse (producer remains A), invalid-evidence
replacement (new producer B), no-evidence reclaim (producer B), and stale
connection/status/token/lease no-partial-write fences. It also executed a real
v3 profile/channel/connection-version/outbox/item-assignment route and rejected
account, profile, channel, connection, version, lease-owner, lease-token,
lease-expiry, status-version, and assignment mismatches without fallback.

Normal fifth-review regressions after the final fixture edits remained:

```text
Task 7 expanded direct: 415 tests, 412 pass, 0 fail, 3 gated skips
Task 6 memory parity:    139 tests, 138 pass, 0 fail, 1 gated skip
Task 8 idle/delivery:    207 tests, 207 pass, 0 fail, 0 skips
```

Both fifth-review files passed `node --check`; `git diff --check` passed. The
disposable `codex-task7-pg16-fifth` container was stopped, its `--rm` cleanup
was verified with `docker ps -a`, and no container with that name remains.

The final skips are PostgreSQL integration gates requiring explicit
nonproduction environment configuration. All ten files changed by the second
remediation passed `node --check`; `git diff --check` also passed.

All 13 `.mjs` files changed by the third remediation passed `node --check`, and
`git diff --check` passed after the final code change.

All changed `.mjs` files passed `node --check`. `git diff --check` passed. The exact credential-resolver regression passed unchanged, confirming it still decrypts only `{ accountId, connectionId, connectionVersion }` and provides no connection selector.

## Public contracts

- Worker context loading is now `loadContext({ message, execution })`:
  - adopted v3 work receives the latest execution returned by Task 6 heartbeat renewal;
  - legacy v2 work receives `execution: null`.
- Paid phase inputs include:

  ```js
  gatewayExecution: Object.freeze({
    channelId,
    connectionId,
    connectionVersion,
    idleTimeoutMs: 300_000,
  })
  ```

- The phase context SQL joins the exact frozen profile channel and exact connection-version row, including assigned job/item/status version plus execution lease owner/token/expiry. A missing or mismatched row is a safe context evidence error; it does not fall back.
- Legacy v2 execution is allowed only for a legacy environment-backed profile with null connection provenance.
- Planner repository/evidence commands carry `gatewayConnectionId/gatewayConnectionVersion`.
- Planner reclaim checks for its persisted response evidence. Reclaim by B keeps
  producer A only when that paid response is hash-valid, structurally readable,
  and accepted by the current closed semantic validator. A hash conflict,
  malformed/partial response, persisted rejection, or newly diagnosed semantic
  rejection atomically fails the exact leased A attempt and inserts attempt
  N+1 for B before B performs one paid call. This uses the existing attempt
  retry budget and respects `maxAttempts`; the transaction rolls back both
  writes if replacement cannot complete. The planner uses the actual producer
  pair for evidence load, validation, save, failure, and channel release, while
  its provider call remains fenced by the current Task 6 execution lease.
- Image attempt commands carry generator connection provenance and terminal checker connection provenance. Reserve, bind, storage, terminal, release, compensation, and lookup writes are fenced by the exact attempt connection pair.
- Image reclaim keeps A only when the full stored-object and frozen-runtime
  evidence validator proves that A's paid bytes are reusable. Missing, partial,
  or corrupt evidence assigns B before a new producer call. A recovered image
  remains attributed to A while a checker executed by B records checker
  provenance B.
- If full image reuse validation fails after reclaim, the repository atomically
  clears unusable request/object/model/checker evidence and switches the exact
  same leased attempt from producer A to B. PostgreSQL fences account/job/item,
  current `GENERATING` status/version, active plan, immutable input identity,
  attempt number, lease token/expiry, final binding, and old A pair in one
  statement. A stale handoff cannot call B or partially clear A.
- Memory channel release validates and persists
  `checkerConnectionId/checkerConnectionVersion`; reclaim clears the stale
  checker pair, matching PostgreSQL behavior.
- Rich-content reserve/reclaim/terminal/release commands carry and fence `gatewayConnectionId/gatewayConnectionVersion`.
- Rich-content commands also carry the orchestration message's exact
  `expectedStatusVersion`. Reservation locks only the account/job/item row in
  `GENERATING` at that version and with the exact active plan before any attempt
  mutation. Complete/reject/fail/release acquire the same item row with
  `FOR UPDATE` in the atomic statement and retain every Task 6 attempt, evidence,
  token, expiry, and connection predicate.
- The exported memory image-attempt repository now validates, stores, and owns
  the exact gateway connection id/version on reserve and reclaim. All owner
  operations reject a different pair without mutation; an omitted or explicit
  all-null pair remains compatible with legacy v2 attempts.
- All paid gateway calls use the `idleTimeoutMs` supplied by the leased execution; legacy calls retain the existing 300-second value.

## Files changed

Production routing/coordination:

- `server/auto-listing-ai-worker.mjs`
- `server/auto-listing-ai-phase-context-postgres.mjs`
- `server/auto-listing-ai-orchestrator.mjs`

Paid callers and evidence owners:

- `server/auto-listing-content-planner.mjs`
- `server/auto-listing-content-plan-repository.mjs`
- `server/auto-listing-content-plan-evidence-postgres.mjs`
- `server/auto-listing-image-generator.mjs`
- `server/auto-listing-result-checker.mjs`
- `server/auto-listing-generation-attempt-postgres.mjs`
- `server/auto-listing-generation-attempt-repository.mjs`
- `server/auto-listing-rich-content.mjs`
- `server/auto-listing-rich-content-repository.mjs`

Tests:

- `server/tests/auto-listing-ai-worker.test.mjs`
- `server/tests/auto-listing-ai-phase-context-postgres.test.mjs`
- `server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs`
- `server/tests/auto-listing-ai-orchestrator.test.mjs`
- `server/tests/auto-listing-content-planner.test.mjs`
- `server/tests/auto-listing-content-plan-repository.test.mjs`
- `server/tests/auto-listing-content-plan-evidence-postgres.test.mjs`
- `server/tests/auto-listing-image-generator.test.mjs`
- `server/tests/auto-listing-result-checker.test.mjs`
- `server/tests/auto-listing-generation-attempt-postgres.test.mjs`
- `server/tests/auto-listing-generation-attempt-repository.test.mjs`
- `server/tests/auto-listing-rich-content.test.mjs`
- `server/tests/auto-listing-rich-content-repository.test.mjs`
- `server/tests/auto-listing-rich-content-postgres-fixture.mjs`
- `server/tests/auto-listing-ai-workflow-postgres.integration.test.mjs`

The second review remediation changed only the already approved planner/image
production files and their direct tests:

- `server/auto-listing-content-plan-repository.mjs`
- `server/auto-listing-content-planner.mjs`
- `server/auto-listing-generation-attempt-repository.mjs`
- `server/auto-listing-generation-attempt-postgres.mjs`
- `server/auto-listing-image-generator.mjs`
- `server/tests/auto-listing-content-plan-repository.test.mjs`
- `server/tests/auto-listing-content-planner.test.mjs`
- `server/tests/auto-listing-generation-attempt-repository.test.mjs`
- `server/tests/auto-listing-generation-attempt-postgres.test.mjs`
- `server/tests/auto-listing-image-generator.test.mjs`

The third review remediation changed the same approved planner/image production
scope and these direct or gated fixture tests:

- `server/auto-listing-content-plan-repository.mjs`
- `server/auto-listing-content-planner.mjs`
- `server/auto-listing-generation-attempt-postgres.mjs`
- `server/auto-listing-generation-attempt-repository.mjs`
- `server/auto-listing-image-generator.mjs`
- `server/tests/auto-listing-content-plan-evidence-postgres.test.mjs`
- `server/tests/auto-listing-content-plan-repository.test.mjs`
- `server/tests/auto-listing-content-planner.test.mjs`
- `server/tests/auto-listing-generation-attempt-postgres-fixture.mjs`
- `server/tests/auto-listing-generation-attempt-postgres.integration.test.mjs`
- `server/tests/auto-listing-generation-attempt-postgres.test.mjs`
- `server/tests/auto-listing-generation-attempt-repository.test.mjs`
- `server/tests/auto-listing-image-generator.test.mjs`

The fourth review remediation changed test fixtures only:

- `server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs`
- `server/tests/auto-listing-generation-attempt-postgres-fixture.mjs`

The fifth review remediation also changed tests only:

- `server/tests/auto-listing-ai-phase-context-postgres.integration.test.mjs`
- `server/tests/auto-listing-content-plan-repository-postgres.test.mjs`

The planner fixture now creates both connection versions through the legal
lifecycle and supplies the exact producer pair to every covered command. The
phase-context fixture retains the legacy case and adds a connection-backed v3
profile/channel/outbox assignment plus the complete mismatch matrix. Existing
fields were sufficient; no migration, schema, or production file changed.

`server/auto-listing-ai-credential-resolver.mjs` did not require a production change: its existing exact-version resolver already met Task 7 and its direct regression remained green.

## Task 6 and Task 8 compatibility

- Task 6 execution heartbeat/fencing remains authoritative. Context loading uses `execution.current()`, and lease-loss guards still surround provider and repository boundaries.
- Reclaim does not replace or weaken the Task 6 worker/channel lease. The
  returned producer pair is cost/source evidence; current checker execution is
  still the adopted worker execution and is persisted separately.
- Task 6 channel failure behavior still releases and reclaims the same planner/image/rich attempt without consuming a business-attempt budget.
- Task 8 provider-delivery classification and no-inline-paid-retry behavior are unchanged.
- The 300-second idle timeout is now sourced from the closed leased-execution contract; no outer application deadline was reintroduced.

## Risks, unverified scope, and rollback

- The exact gated Task 7 routing, generation provenance, reclaim/clear-switch,
  checker provenance, and workflow integration assertions were executed on a
  disposable local PostgreSQL 16 container and passed 71/71 with zero skips.
  This was not a production database and the container was removed afterward.
- No real independent second key was configured, so real dual-channel paid concurrency is not claimed.
- No real gateway or Ozon call was made, by design.
- The legacy v2 path intentionally supports only null connection provenance; connection-backed work must use adopted v3 execution evidence.
- Existing columns were sufficient. No migration or schema expansion was made;
  the risk is confined to the reclaim/resume contracts that now return producer
  provenance. Legacy test/memory ports that omit the returned pair retain the
  previous current-execution fallback, while explicit all-null v2 provenance
  remains all-null.
- Planner evidence tables are append-only and allow one response per attempt,
  so safely replacing invalid paid evidence requires attempt N+1 rather than
  overwriting history. That replacement consumes the normal business retry
  budget. Image repair uses the same attempt because its mutable in-progress
  evidence columns can be exact-fenced and cleared atomically.

Rollback the implementation with:

```bash
git revert d56fb551e18fae99958ebca61b4e11a3af9a0f21
git revert 11e67d78dd1ecd57c53e2a0c845041bddfb431ae
git revert b7b95c7fb5c260bcb2dfccb4ea2028b7e8ca1cd2
git revert 94363872782a9269d458680bf6944fffc69e2b7e
git revert b8867fc27a9a4480cf0501e6ea66c58016cefbb5
git revert 2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4
```

Migration 098 remains additive; rollback should not delete provenance columns or historical evidence.
