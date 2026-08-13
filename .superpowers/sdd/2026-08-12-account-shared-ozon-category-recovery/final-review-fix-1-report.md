# Final review fix 1 report

Status: COMPLETE

Implementation commit: `6ae1562552d0596e7bed8eb1a28928cec46e687e`

## Outcome

The final-review Important finding was reproduced and fixed. An exact Ozon lookup may legitimately return `UNRESOLVED` and write no lookup/category evidence. Administrator confirmation no longer requires a source-evidence row that cannot exist in that state. It now validates the item's exact current draft/version, appends a distinct `MANUAL_CONFIRMATION` source observation, CASes the current-source pointer, creates or activates an account-shared `MANUAL` selection, and appends category-event, confirmation-ledger and general-audit history in one JSON commit or PostgreSQL transaction.

The public confirmation request and response did not change. `MANUAL_CONFIRMATION` is private provenance only; the existing public source remains `MANUAL`, so Task 9's closed UI DTO/source allowlist required no change. The production category-error policy V1 remains empty and disabled.

## Contract and schema

- The contract module adds a closed descriptor-safe manual observation identity. It hashes the exact account/item/current-draft identity, selected category/type, scope, actor, capture time, correlation, idempotency and request hash into `manual-confirmation:v1:<sha256>`. It rejects proxies, accessors, custom prototypes, extra fields and non-canonical values before persistence.
- Migration `070_account_shared_ozon_category_manual_confirmation_evidence.sql` is additive after 069. Published migrations 063/064 were not edited. It extends private source/current-pointer kinds, creates the tenant/item/draft/version/evidence-bound append-only observation table, binds new confirmation-audit rows to it while preserving nullable historical rows, and preserves exact parent cleanup. Direct observation update/delete returns SQLSTATE `23514`.
- PostgreSQL confirmation locks the exact account/item current draft, verifies `expectedSourceVersion=draft:<current version>`, verifies any existing pointer still derives from that draft, inserts observation/evidence, updates or creates the shared MANUAL state, and CASes the pointer. JSON performs the same checks against its private canonical pointer.
- Response-loss replay is fenced by account/idempotency/request hash and returns the existing exact result without new evidence/event/audit rows. Stale and cross-account requests leave all provenance/audit counts unchanged.
- Existing source evidence is never updated. Historical confirmation rows without the new observation link remain readable; all newly written confirmations require and reference the new evidence.

## TDD evidence

RED was first captured in the real JSON collection route: missing source IDs → exact lookup `UNRESOLVED` → zero evidence/shared rows → one private canonical draft pointer → administrator confirmation. The focused result was **0 passed, 1 failed, 0 skipped**, failing with `OZON_CATEGORY_CONFIRMATION_SOURCE_VERSION_CONFLICT` because `readCurrentEvidence` returned no row. The closed contract RED separately failed module loading because `manualConfirmationObservationIdentity` did not exist.

GREEN evidence from the disposable PostgreSQL 16 instance on loopback port `60390`:

- complete account-shared category focused/adjacent batch: **61 passed, 0 failed, 0 skipped**;
- final migration + repository batch after the draft-version composite FK: **34 passed, 0 failed, 0 skipped**;
- contract/runtime focused batch: **19 passed, 0 failed, 0 skipped**;
- existing UI/public projection batch: **41 passed, 0 failed, 0 skipped**, using the main workspace's same-lockfile dependency tree through a temporary symlink; the symlink was removed immediately after the run.

The real PostgreSQL chain applies migrations 001–070, exercises unresolved lookup, exact administrator confirmation, exact replay, second-item/account-shared reuse, stale and cross-account zero writes, append-only mutation rejection, and formal source/shared reads. No real Ozon, paid AI, object store, production database or deployment was contacted.

Syntax checks for all three production modules and `git diff --check` passed.

## File boundary

Production: account-shared category contract, repository, runtime, and additive migration 070. Tests: existing focused contract, runtime, repository and migration tests only. The brief/report and ledger record the approved review fix. Task 10 E2E/operations/verification documents intentionally remain on migration 069/tested SHA until the separately assigned stock fix is complete, as directed.

## Risk and rollback

The remaining review item about stock continuation is intentionally out of scope and remains for its separate fix.

Rollback before production migration is the single implementation commit. After migration 070 is applied, do not attempt reverse SQL: stop writes, restore the verified pre-070 database backup and deploy the pre-fix application SHA together. Because manual observations are append-only business evidence, partial table/row deletion is not a supported rollback.
