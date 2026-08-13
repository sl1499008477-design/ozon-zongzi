# Final review fix 2 brief — crash-safe stock continuation

Date: 2026-08-13

## Business objective

Prevent a worker restart from blindly sending the same Ozon stock write twice after a successful product import. Preserve the existing product-import, category-recovery, RFBS authorization and terminal-job contracts. A stock outcome that cannot be proven must stop automatic stock writes and require an explicit stock-only operational recovery; it must never cause another product import.

## Root cause and external authority decision

`listing-worker.mjs::finishSuccessfulImport` currently performs `POST /v2/products/stocks` before any durable stock-write fact exists. If Ozon accepts the request and the process exits before `transitionSubmissionJobV3`, a replay re-enters `finishSuccessfulImport` and calls the stock endpoint again.

The current Ozon client sends no stock business-idempotency key. The repository has broader stock-sync reads, but no reviewed API contract that can attribute a returned stock quantity to this exact job, import task and stock-write generation. A read showing the desired quantity would also be unable to prove whether this generation or another actor produced it. Therefore this fix does not claim exactly-once delivery after an uncertain network boundary and does not add a guessed readback rule. Every durable `IN_FLIGHT` row without `DONE` is treated as ambiguous and is never automatically resent.

## Data contract — migration 071

Add a generation-scoped stock-write ledger after migration 070. Each immutable intent closes over:

- account, submission job and snapshot;
- submission item and offer;
- store and exact platform warehouse;
- non-negative integer quantity;
- current import task ID;
- optional category-recovery attempt ID, present only for the exact successful retry generation;
- canonical complete request hash and correlation ID.

All rows for one request generation share one generation ID and request hash. Closed states are `PREPARED`, `IN_FLIGHT`, `DONE`, and `AMBIGUOUS`. Only repository transactions may create the complete `PREPARED` set, atomically move the exact complete set to `IN_FLIGHT`, mark it `DONE` after a confirmed response, or close an uncertain `IN_FLIGHT` set as `AMBIGUOUS`. Business rows are append-only apart from those monotonic state transitions. Events are append-only and tenant-scoped. The existing supported parent-cleanup sequence removes the child ledger before account cleanup; ordinary direct child deletion remains forbidden.

## Runtime flow

1. On a successful product import, the worker still performs the existing `PRE_STOCK` RFBS authorization. That gate is authorization, not deduplication.
2. The stock repository validates a descriptor-safe closed command against the frozen snapshot, submission item identities, current job task ID, optional exact migration-069 recovery identity, store, warehouse, quantities and request hash. It creates or replays the single `PREPARED` generation.
3. Immediately before transport, one transaction changes the complete generation from `PREPARED` to `IN_FLIGHT`.
4. A confirmed HTTP success is persisted as `DONE` before the job is made terminal. A replay of `DONE` performs no stock transport and only completes the job.
5. If the process restarts with `IN_FLIGHT` and no `DONE`, the generation becomes/remains `AMBIGUOUS`; the job closes as `PARTIAL_SUCCESS` with fixed safe copy and a stock-only manual action. It never resends stock or product import.
6. A failure proven before transport may leave/revert only a `PREPARED` generation for safe retry. Once transport is invoked, any response-loss or otherwise uncertain failure is `AMBIGUOUS`. A definite HTTP failure follows the existing partial-success semantics and is durably recorded without automatic product import or blind stock retry.

## Acceptance tests

All database tests apply migrations 001–071 on fresh disposable PostgreSQL 16 and use loopback fakes only.

- RED first proves the current production worker performs a second stock request when the terminal job update fails after the first 200 response and the check is replayed.
- Crash after `IN_FLIGHT` before transport: restart sends zero stock and closes safely as ambiguous/manual (the application cannot prove the request was not sent once `IN_FLIGHT` is durable).
- Stock 200 then crash before `DONE`: restart sends zero second stock and closes ambiguous/manual.
- `DONE` then crash before job terminal: restart sends zero stock and completes the job.
- Normal FBS and RFBS paths each send exactly one stock request.
- Cross-account or wrong job/snapshot/task/item/offer/warehouse/quantity/hash commands write no ledger/event rows and execute no descriptor getter/proxy trap.
- Duplicate queue messages and watchdog recovery do not grow stock calls or ledger generations.
- A migration-069 category-retry success uses its exact retry task/attempt identity and sends stock once while preserving the original failed item.
- Product import is never repeated by stock recovery.

## Scope and non-goals

Expected production scope is migration 071, one focused stock-ledger repository/contract module if separation is needed, `listing-pipeline.mjs` load/terminal integration, `listing-worker.mjs`, and focused/adjacent tests. Documentation is this brief/report plus final verification evidence. The production category-error policy remains empty. Manual category confirmation, source category matching, pricing, credentials and UI contracts do not change. No real Ozon, AI, object store, production database or production credential is contacted.

## Rollback

Revert the application commit to restore the prior worker behavior. Migration 071 is additive and should remain dormant with its ledger and events preserved for audit. Physical rollback requires maintenance mode, proof that no 071 rows exist, and an explicit forward remediation; do not delete stock-write facts to simulate rollback.
