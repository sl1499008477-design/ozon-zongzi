# Task 7 report: exact leased phase routing and cost provenance

## Outcome

Task 7 is implemented in commit `2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4`
(`feat: route auto-listing phases through leased channels`) and review remediation
commit `b8867fc27a9a4480cf0501e6ea66c58016cefbb5`
(`fix: fence AI attempts by exact execution owner`), and producer-provenance
remediation commit `94363872782a9269d458680bf6944fffc69e2b7e`
(`fix: preserve paid producer provenance across channel reclaim`), and validated-evidence
remediation commit `b7b95c7fb5c260bcb2dfccb4ea2028b7e8ca1cd2`
(`fix: validate paid evidence before preserving producer`). The original report was
recorded in commit `100aeef8f3cf119a8720f51231a0fdbe1a998d8d`.

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

- The real PostgreSQL integration tests were not executed because
  `AUTO_LISTING_POSTGRES_TESTS=1` and `SONLI_MIGRATION_TEST_DATABASE_URL` were
  both unavailable. Their fixtures were updated for the exact status version,
  `GENERATING` item, active plan, and current additive columns; unit tests prove
  the row-locking SQL shape, exact parameters, stale row-count rejection, and
  no attempt write before a failed reserve boundary. A gated PostgreSQL run
  remains the recommended next verification.
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
git revert b7b95c7fb5c260bcb2dfccb4ea2028b7e8ca1cd2
git revert 94363872782a9269d458680bf6944fffc69e2b7e
git revert b8867fc27a9a4480cf0501e6ea66c58016cefbb5
git revert 2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4
```

Migration 098 remains additive; rollback should not delete provenance columns or historical evidence.
