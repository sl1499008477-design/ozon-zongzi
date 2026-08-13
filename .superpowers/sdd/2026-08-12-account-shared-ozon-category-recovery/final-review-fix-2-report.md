# Final review fix 2 report — crash-safe stock continuation

Date: 2026-08-13

Tested implementation commit: `42f696540066473397632f9c8c66709e11acec1b`.

## Outcome

The listing worker no longer treats `POST /v2/products/stocks` as an unrecorded side effect. Migration 071 and the production pipeline now create one tenant-bound, generation-scoped stock-write intent, persist `IN_FLIGHT` before transport, persist `DONE` before the submission job terminal, and refuse to resend any orphaned `IN_FLIGHT` generation. A confirmed `DONE` replay only completes the existing job. An unproven result becomes `AMBIGUOUS` and the existing job closes as `PARTIAL_SUCCESS` with fixed stock-only manual-review copy; product import is never repeated.

There is no reviewed Ozon business-idempotency key in the existing stock API transport and no existing authoritative read contract that can attribute current stock to this exact request generation. This implementation therefore does not claim exactly-once delivery across an Ozon-200/SIGKILL boundary. It deliberately prefers a possible manual stock reconciliation over a duplicate automatic stock write.

Production category-error policy V1 remains empty. Follow-up final-review fixes settle the 071 stock state before any RFBS credential, warehouse, or authorization read (`b4e6d9f`) and add migration 072's exact confirmation-audit provenance gate (`42f6965`).

## Changed contracts and files

- `server/db/migrations/071_submission_stock_write_ledger.sql`
  - adds tenant-bound stock intent and append-only event tables;
  - stores exact account/job/snapshot/store/submission-item/offer/platform-warehouse/quantity/import-task/optional-recovery-attempt/request-hash/correlation/actor identity;
  - enforces complete frozen-snapshot membership, current task/recovery identity, a closed status lattice and immutable audit basis in PostgreSQL;
  - permits cleanup only through the existing parent-cleanup sequence; the test removes the submission parent, observes intent/event cascade, then completes account cleanup.
- `server/listing-pipeline.mjs`
  - adds descriptor-safe command projection and a canonical complete request hash;
  - adds prepare, begin, complete and ambiguous ports with fixed non-disclosing conflicts;
  - projects exact submission-item identities needed to close stock rows.
- `server/listing-worker.mjs`
  - consumes the durable stock state before any RFBS credential, warehouse or authorization read;
  - performs fresh PRE_STOCK RFBS authorization only for `PREPARED`/new work that may reach transport;
  - persists `DONE` before terminal completion and converts unproven prior `IN_FLIGHT` to safe manual review without transport.
- Tests advance the fresh Task 10/RFBS migration chain to 071, cover the crash barriers and update the stock-specific terminal failure code. No browser or public DTO changed.

Migration 072 preserves historical audit rows as provenance version 1 but requires every new production row to be version 2 and to match the exact immutable manual observation, current source pointer, active shared state and transition event. Cross-item/source/observation/category/type/actor/correlation/hash/time/version direct inserts fail with SQLSTATE `23514`; runtime replay reuses the existing idempotent audit row.

## TDD evidence

The first fresh PostgreSQL RED used the real RFBS creation/upload/submission worker chain. A controlled database barrier rejected only the terminal job update after the loopback Ozon stock endpoint returned 200. Replaying the same `check` produced **two** `/v2/products/stocks` requests; the assertion required one. A separate focused RED failed because no stock command projector/ports existed.

GREEN fault barriers use database triggers and explicit durable states, never sleeps:

1. `IN_FLIGHT` persisted before the network boundary, then worker restart: zero stock transport; intent `AMBIGUOUS`, job `PARTIAL_SUCCESS`.
2. Loopback stock 200, then the `IN_FLIGHT -> DONE` write is rejected: the catch path durably closes `AMBIGUOUS`; replay sends zero second stock.
3. `DONE` persisted, then terminal job update rejected: replay sends zero stock and completes the job.
4. Normal RFBS and FBS/recovery paths send one exact stock body.
5. Wrong account/job/snapshot/task/item/offer/warehouse/quantity/hash commands all fail before any additional intent/event. Direct SQL mutation/delete/invalid initial DONE returns `23514`.
6. Duplicate queue checks and watchdog recovery do not grow import, stock, intent or event generations.
7. The production Task 8/069 category-retry continuation persists one `DONE` intent with the exact recovery attempt, retry task and original submission item while retaining the original failed item and child result.
8. RFBS retains PRE_STOCK evidence; FBS remains valid without an RFBS handoff.

## Verification

- Focused descriptor-safe contract: **2/2 passed, 0 failed, 0 skipped**.
- Adjacent unit/category/RFBS/reconciliation gate: **62/62 passed, 0 failed, 0 skipped**.
- Fresh disposable PostgreSQL 16 RFBS crash/attack matrix: **1/1 passed, 0 failed, 0 skipped**.
- Fresh disposable PostgreSQL 16 Task 10 central E2E, including migrations 001–072, production one-attempt recovery, 069 child, stock ledger, exact confirmation audit and destructive/restore checks: **4/4 passed, 0 failed, 0 skipped**.
- Fresh PostgreSQL Task 7 repository/service composition plus standard upload/stock partial behavior: **6/6 passed, 0 failed, 0 skipped**.
- Fresh PostgreSQL migration/manual-provenance gate: **14/14 passed, 0 failed, 0 skipped**.
- Syntax checks for changed JavaScript modules and tests passed; `git diff --check` passed.

All external traffic in these tests used a random loopback fake. No real Ozon, AI, object storage, production database, production credential, deployed service or browser write was used.

## Operational behavior and recovery

- `DONE`: safe automatic terminal replay, no stock call.
- `AMBIGUOUS`: fixed `PARTIAL_SUCCESS` result and a stock-only manual reconciliation action; no stock call and no product import.
- Explicit HTTP rejection after transport entry is also retained as a terminal ledger fact and follows the existing partial-success contract. It is not blindly retried because the external boundary has already been crossed.
- A future automatic reconciliation may be added only after a separately reviewed authoritative Ozon read contract can prove the exact generation rather than merely observe the same quantity.

## Rollback and residual risk

Revert the application implementation commits to return to the previous worker/runtime. Migrations 071–072 are additive and should remain installed; preserve intent/events/audits and do not delete them to imitate rollback. A physical schema rollback requires maintenance mode and proof that no new rows depend on them.

Residual risk is explicit: an Ozon-accepted write followed by failure before local `DONE` may require a human to reconcile stock. This is the chosen fail-safe behavior because duplicate automated stock writes are not provably preventable without platform idempotency or authoritative generation readback.
