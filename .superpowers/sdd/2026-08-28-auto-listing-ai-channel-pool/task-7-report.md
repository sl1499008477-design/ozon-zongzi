# Task 7 report: exact leased phase routing and cost provenance

## Outcome

Task 7 is implemented in commit `2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4`
(`feat: route auto-listing phases through leased channels`).

Paid auto-listing phases now keep the job-frozen profile models and protocols while resolving only the exact adopted channel connection/version. No selector, arbitrary connection, current-profile, or default-connection fallback was added. Planner, image generator/checker, and rich-content attempts persist their leased connection provenance, and repository writes fence the account/item/status-version attempt owner and connection version.

No real AI, Sub2API, Ozon, deployment, or push side effect was performed.

## TDD evidence

### RED

Tests were added before implementation for these missing contracts:

- phase context receives `{ message, execution }`, projects frozen model configuration plus the exact leased connection/base URL, and rejects an evidence mismatch instead of falling back;
- the v3 worker passes the currently adopted execution to context loading, while the v2 drain passes `execution: null`;
- the orchestrator forwards the same frozen `gatewayExecution` to planner, image, and rich-content callers;
- planner reservation/reclaim SQL persists `gateway_connection_id/version`;
- caller/repository tests require leased idle timeout, generator/checker provenance, and exact SQL connection fences.

The first focused RED run failed at the intended boundaries: the context loader still accepted a raw message and used profile routing, the worker passed only the message, the orchestrator rejected `gatewayExecution`, and planner-attempt reservation rejected/omitted the new provenance fields. A later focused run had 4 stale-contract failures (phase input/value assertions and two worker fixtures); those were updated only after the production contracts existed.

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

All 11 changed production `.mjs` files passed `node --check`. `git diff --check` passed. The exact credential-resolver regression passed unchanged, confirming it still decrypts only `{ accountId, connectionId, connectionVersion }` and provides no connection selector.

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
- Image attempt commands carry generator connection provenance and terminal checker connection provenance. Reserve, bind, storage, terminal, release, compensation, and lookup writes are fenced by the exact attempt connection pair.
- Rich-content reserve/reclaim/terminal/release commands carry and fence `gatewayConnectionId/gatewayConnectionVersion`.
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
- `server/tests/auto-listing-rich-content.test.mjs`
- `server/tests/auto-listing-rich-content-repository.test.mjs`

`server/auto-listing-ai-credential-resolver.mjs` did not require a production change: its existing exact-version resolver already met Task 7 and its direct regression remained green.

## Task 6 and Task 8 compatibility

- Task 6 execution heartbeat/fencing remains authoritative. Context loading uses `execution.current()`, and lease-loss guards still surround provider and repository boundaries.
- Task 6 channel failure behavior still releases and reclaims the same planner/image/rich attempt without consuming a business-attempt budget.
- Task 8 provider-delivery classification and no-inline-paid-retry behavior are unchanged.
- The 300-second idle timeout is now sourced from the closed leased-execution contract; no outer application deadline was reintroduced.

## Risks, unverified scope, and rollback

- The real PostgreSQL integration test was not executed because the explicit nonproduction database environment was unavailable. Unit tests assert SQL shape and parameters, but a gated PostgreSQL run remains the recommended next verification.
- No real independent second key was configured, so real dual-channel paid concurrency is not claimed.
- No real gateway or Ozon call was made, by design.
- The legacy v2 path intentionally supports only null connection provenance; connection-backed work must use adopted v3 execution evidence.

Rollback the implementation with:

```bash
git revert 2b7ae449ed84ef226fa09c38b8e5d5d47d5a5af4
```

Migration 098 remains additive; rollback should not delete provenance columns or historical evidence.
