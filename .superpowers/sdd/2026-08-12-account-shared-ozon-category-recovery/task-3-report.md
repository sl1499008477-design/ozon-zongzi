# Task 3 Report — Account-shared Ozon category recovery

Date: 2026-08-12

## Outcome

Task 3 replaces the active store-scoped category resolver with account-shared source evidence:

- Collection and linked Ozon enrichment now record immutable category evidence inside the caller-owned JSON/PostgreSQL transaction.
- Missing category IDs use exact read-only lookup in strict order: product ID, then exact offer/SKU; no list/search/fuzzy endpoint exists.
- Manual authority is available only through `POST /ozon/category-confirmations`, with backend administrator authorization, account/item/source-version checks, idempotency fencing, optimistic shared-state versioning, actor/time evidence, and atomic audit persistence.
- Public shared-category output is the closed eleven-field projection from the brief and is deeply frozen.
- PATCHing a collection draft no longer invokes a manual-category persistence hook.
- The old store resolver, wake notifier, timer, cursor, post-commit scheduler, and compatibility composition are no longer active.

## Contracts

### Collection evidence

`recordCollectionResult` accepts the authenticated account, canonical collect item, source version, product draft identity/version, capture time, and raw response hash/reference. It writes through the Task 2 account-shared repository. Replays of the same source record/version are idempotent; conflicting evidence fails closed; a new source version appends evidence.

Task 2 intentionally closes source kinds to `PRODUCT_DRAFT` and `ENRICHMENT_CACHE`. Therefore an exact Ozon read is attached to the canonical product-draft evidence with an `ozon-read:...` raw reference/hash rather than introducing an unreviewed third persistence source kind.

### Exact lookup

- `/v2/product/info` with exact `product_id`
- on absence only, `/v2/product/info` with exact `offer_id`
- `/v4/product/info/attributes` only when the exact returned product lacks category facts
- returned identity must equal the requested stable identity
- both category IDs must be positive
- input and response carriers reject proxies, accessors, cycles, dangerous keys, unknown shapes, and responses above 256 KiB
- auth, absence, mismatch, malformed data, network ambiguity, and oversize all return one frozen safe unresolved result and write nothing
- credentials are selected ephemerally from an account-owned current store and are never persisted in evidence/shared/public DTOs

### Manual confirmation

The request body is exact and closed:

`collectItemId, expectedSourceVersion, descriptionCategoryId, typeId, taxonomyScope, idempotencyKey, correlationId`.

JSON confirmation uses a cloned working state and commits category arrays only after state persistence succeeds. PostgreSQL confirmation uses one transaction for advisory idempotency fencing, current evidence/version reads, manual evidence/shared transition, and append-only `audit_events` insertion. Replays return the stored exact public result; mismatched replays, stale source versions, cross-account/missing items, ordinary users, and extra fields write nothing.

## TDD record

RED observations:

- Initial three Task 3 test files: 0 pass / 3 file-level failures because the new service/runtime/lookup modules did not exist.
- Collection enrichment atomic-evidence tests failed until completion carried evidence into the caller-owned transaction.
- Public projection test failed on the legacy category shape before the closed account-shared projection was wired.
- PostgreSQL confirmation test: 3/4 passed, expected failure was `OZON_CATEGORY_CONFIRMATION_UNAVAILABLE`.
- PostgreSQL idempotency-fence assertion failed before the advisory lock was added.
- Exact lookup descriptor-safety test: 3/4 passed before credential accessor/proxy rejection.
- JSON source and confirmation failure tests demonstrated partial mutation before cloned-working-state commits were added.

GREEN verification:

- Required Task 3 command: **78 passed, 0 failed, 0 skipped**.
- Account-shared repository/migration, seams, module boundaries, ingress, completeness, and deletion regression: **102 passed, 0 failed, 2 expected PostgreSQL skips**.
- Syntax checks passed for the server entry and all four new Task 3 modules.
- `git diff --check` and test inventory passed; inventory reports 362 active and 14 historical/manual tests.
- Baseline before Task 3: 94 passed, 0 failed, 1 expected PostgreSQL skip.

## Entry migration and deletions

New focused modules:

- `server/account-shared-ozon-category-service.mjs`
- `server/account-shared-ozon-category-runtime.mjs`
- `server/account-shared-ozon-category-composition.mjs`
- `server/ozon-source-category-lookup.mjs`

Migrated entry points:

- JSON account-scoped collection route
- PostgreSQL collection pipeline
- linked Ozon enrichment service/runtime
- server composition, batch public read, and confirmation route
- subprocess/seam and protected integration fixtures
- account deletion for all four account-shared category arrays
- module import boundary to the new repository/runtime pair

Deleted production modules:

- `collect-category-resolution-policy.mjs`
- `collect-category-resolution-repository.mjs`
- `collect-category-resolution-service.mjs`
- `collect-category-resolution-runtime.mjs`
- `collect-category-auto-resolution-composition.mjs`

Deleted the six tests that asserted only the retired contract. Legacy state-key mentions remain solely in Task 2 migration cleanup so an old JSON state is consumed and the retired keys are deleted; they do not provide an active resolver path.

## Unverified, risks, and rollback

- No real Ozon request, paid AI call, or Ozon product write was performed. Exact lookup tests use a controlled transport.
- Disposable PostgreSQL integration suites were not enabled because no dedicated test database was supplied; repository SQL behavior and the new confirmation transaction were verified with controlled executors.
- The complete 362-file active suite was not claimed: tests importing the full server entry cannot load the existing ad-hoc-signed Sharp binary under the bundled hardened Node because their Team IDs differ. This is an environment/dependency signing blocker; the focused and adjacent suites above do not use that binary.
- Missing-ID lookup may extend a collection transaction while the bounded seller read completes. It is restricted to exact read-only calls and successful evidence remains atomic; operational latency should be monitored.

Rollback is `git revert <final Task 3 commit SHA>`. This restores the retired runtime modules and entry wiring. No Task 3 schema migration was added; migration 063 and all canonical source evidence remain intact. The final commit SHA is reported in the handoff because a commit cannot embed its own final hash.

## Self-review

- Verified no active import/call remains for the retired composition, store snapshot, scheduler, wake notifier, timer, cursor, or `saveManualFromDraft`.
- Verified the account-shared repository carries no store identity, credentials, or network access.
- Verified public DTOs do not include account/store/raw/hash/attribute/credential/error-detail fields.
- Verified all external failures map to fixed safe codes/messages and no raw vendor/secret data is logged or returned.
- Verified candidate or draft data has no code path to the confirmation mutation.
- Verified unrelated Task 4+ UI and snapshot files were not modified.

---

## Fix round 1/5 — reviewed contract corrections

This section supersedes the earlier statements that lookup reused `PRODUCT_DRAFT`, manual confirmation appended evidence, and Task 3 added no migration.

### Corrected contracts

- `OZON_READ_LOOKUP` is now a formal third immutable source kind. Its exact request identity, exact matched identity, fixed lookup contract version, bounded response hash, account/item, and capture time are closed contract fields. No vendor body, credential, store identity, arbitrary reference, or raw error is retained or returned.
- Migration `064_account_shared_ozon_category_lookup_evidence.sql` is additive over 063. It creates an append-only lookup metadata table, a constrained source-evidence relationship, canonical current-source pointers, and a dedicated append-only administrator-confirmation ledger. Existing 063 product evidence receives only the new product-raw reference column and current-draft pointers; evidence values are not reinterpreted or rewritten.
- This migration consumes number 064. The later recovery migration previously planned as 064 must be renamed to 065 when Task 4+ executes it.
- Manual confirmation now keeps the original current evidence ID and original source signature. It changes only the account-shared row's current category IDs, source=`MANUAL`, taxonomy validation, and optimistic version. Actor, correlation, idempotency, request hash, selected IDs, source evidence, and confirmation time go to the separate append-only ledger and the existing audit stream. Reconfirmation with the same `expectedSourceVersion` is permitted only after locking and version-fencing the shared row.
- A second item with the same original source signature reads the manual selection immediately because no selected ID is promoted into source evidence or a new signature.
- Current source is no longer chosen by capture time. Product drafts must match `collect_items.current_draft_id` and draft version; successful exact lookups atomically advance the item pointer to their immutable lookup identity/version. Enrichment cache facts remain canonical by the constrained account/source/SKU/contract-version cache identity and do not become item pointers.
- Exact lookup requires every non-null requested identity to be present and equal in both the product response and, when used, attributes response. A missing or unequal product ID/offer ID is unresolved. Request values are never used to manufacture a response identity.
- Public shared-category projections retain the exact eleven keys and are recursively frozen.

### TDD correction record

RED was recorded before implementation:

- migration static test failed with missing 064;
- JSON/controlled PostgreSQL current-source parity selected capture-clock winners rather than a canonical pointer;
- manual repository confirmation rejected the corrected `evidenceId` contract and still appended a forged evidence row;
- resolved lookup evidence persisted as `PRODUCT_DRAFT`;
- exact identity tests resolved responses missing or disagreeing with requested product/offer identity;
- disposable PostgreSQL integration reproduced the old manual contract with zero skips.

GREEN after the minimal fixes:

- final contract/runtime/service/lookup/migration/repository suite, including real PostgreSQL 16: 50 passed, 0 failed, 0 skipped;
- adjacent account deletion, persistence, collection seams/completeness, contract, lookup, runtime, repository, and 063→064 suite: 85 tests, 84 passed, 0 failed, one unrelated collection PostgreSQL branch skipped because that test keys off `DATABASE_URL` rather than the disposable migration URL;
- `git diff --check` and syntax validation passed.

The real PostgreSQL suite covers 063→064 compatibility, canonical current-draft backfill, manual sharing across two items, same-source reconfirmation, append-only confirmation audit, lookup success, forced evidence failure rollback of lookup provenance, cross-account lookup isolation, immutable evidence/events, and migration rollback checks. Controlled transports remain the only Ozon lookup mechanism used by tests.

### Files and entry migration

Contract/repository/runtime/service/lookup modules and their focused tests were corrected in place. New schema is limited to:

- `server/db/migrations/064_account_shared_ozon_category_lookup_evidence.sql`

The migration integration and static tests were extended for the third source kind. JSON account deletion now removes lookup metadata and current-source pointers for the deleted account. No Task 4+ snapshot or UI file changed. The retired store resolver/wakeup/timer/cursor/notifier/compatibility modules remain deleted; a follow-up dependency scan found no restored production import or call.

### Remaining risks and rollback

- No real Ozon API, paid AI, product mutation, or production data was used. Lookup response parsing is verified only with controlled bounded transports.
- The full server-entry suite remains blocked under the bundled hardened Node by the pre-existing Sharp native-binary Team-ID signature mismatch. Focused and adjacent suites that do not load Sharp pass as reported above.
- Lookup identity metadata is intentionally append-only and may grow; account deletion cascades it, but operational retention/partitioning is outside Task 3.

Rollback this correction with `git revert <fix-round-1-commit-sha>`. Migration 064 is additive, so production rollback should normally revert application reads first and retain the new evidence/audit tables; destructive down-migration is intentionally not provided. The original Task 3 implementation can separately be reverted with `git revert 9d6cc75570709ef7fa0def5e6458899bf69c1079` if the entire feature must be removed.

### Fix-round self-review

- Confirmed manual confirmation inserts zero source-evidence rows and both JSON/PostgreSQL adapters transition by the original evidence ID.
- Confirmed lookup provenance has DB foreign keys and closed DTO invariants, and the public projection contains neither lookup/raw identifiers nor hashes.
- Confirmed item reads use only canonical pointers and no `captured_at DESC` selection remains.
- Confirmed all account/item/evidence/lookup/confirmation queries include account scope.
- Confirmed failure responses remain fixed safe codes and messages without raw vendor, secret, SQL, or transport detail.
- Confirmed no later recovery snapshot, UI, paid AI, or product-write path was modified.

---

## Fix round 2/5 — stale lookup fencing, cleanup cascades, and final DTO freezing

### Contract and schema corrections

- `OZON_READ_LOOKUP` provenance now binds the exact canonical product draft that triggered the read with closed `triggerProductDraftId` and positive `triggerProductDraftVersion` fields. Migration 064 stores the pair and constrains it to the same collect item through a composite product-draft foreign key. Raw lookup bodies remain outside both persistence and public DTOs.
- Lookup pointer promotion is expected-current/CAS rather than last-writer-wins. A new lookup may replace only the exact triggering `PRODUCT_DRAFT` pointer; creating a pointer requires the collect item's current draft ID and version to match. Exact evidence replay is a pure idempotent return, and a late result from an older draft cannot replace a newer draft or lookup pointer. JSON and PostgreSQL implement the same rule.
- The append-only confirmation ledger still rejects direct UPDATE/DELETE with SQLSTATE `23514`. Its delete trigger now permits only FK cleanup after the exact parent account, account/item, or account/source-evidence row is no longer visible. The source-evidence guard has the matching collect-item cleanup exception so the formal account-erasure transaction can complete; direct evidence deletion while its parents exist remains forbidden.
- Final public collection summary, item, and persisted-item projections are recursively frozen, including nested arrays and listing-target objects. Projection-owned `Date` instances are cloned before freezing so caller input is not mutated.

Migration 064 remains unpublished and was amended in place; no new migration number was consumed. The later recovery migration remains reserved as 065. No Task 4+ snapshot or UI contract changed.

### TDD correction record

RED was recorded separately before each minimal implementation:

- JSON replay/stale-completion fixtures demonstrated an old lookup could restore a superseded pointer; a missing-canonical-draft fixture demonstrated an unbound lookup could create one.
- Real PostgreSQL reproduced direct confirmation-ledger deletion as `23514` and initially showed that an unconditional append-only trigger also blocked the intended FK cascade during formal account cleanup.
- Public-shape assertions demonstrated that final summary/item/persisted containers and their nested values remained mutable.

GREEN verification with the bundled absolute Node runtime:

- combined focused contract, migration, runtime, service, exact-lookup, repository, public-shape, account-deletion, and real PostgreSQL integration suites: 64 passed, 0 failed, 0 skipped;
- real PostgreSQL migration and repository subset: 24 passed, 0 failed, 0 skipped;
- `git diff --check` passed.

The PostgreSQL fixtures cover 063→064 migration, trigger-draft persistence, exact old-evidence replay, late stale lookup completion, CAS promotion to a newer lookup, provenance rollback when evidence insertion fails, cross-account isolation, direct-ledger-delete rejection, collect-item cascade, and the production formal account-erasure entry point inside a transaction. All Ozon reads still use controlled transports; no real platform call occurred.

### Files, entry paths, and rollback

This correction changes only the existing Task 3 contract, repository, service, public projection, unpublished migration 064, and their focused tests. It adds no resolver, scheduler, wakeup, timer, cursor, notifier, store identity, compatibility entry, paid AI path, product write, later snapshot, or UI dependency. Formal cleanup coverage calls the existing `deleteRemovedAccountScopes` entry inside its required outer transaction.

Rollback this round with `git revert <fix-round-2-commit-sha>`. Because migration 064 remains additive and unpublished, deployment rollback should revert application reads first and retain evidence/audit tables if it has nevertheless been applied; no destructive down-migration is supplied. Fix round 1 can separately be reverted with `git revert 2f87e4e68796840966df4cf0e1aafc15e6f3df86`.

### Remaining risks and self-review

- No real Ozon API, production database, paid AI, or product mutation was exercised. Controlled lookup transport and disposable PostgreSQL 16 are the verified boundary.
- The lookup CAS deliberately leaves immutable evidence recorded when its trigger draft is already stale; it does not expose or promote that evidence as current. Operational retention/partitioning remains outside Task 3.
- Confirmed lookup trigger fields are closed, immutable, tenant/item constrained, excluded from public DTOs, and never derived from a response clock.
- Confirmed replay returns without any pointer write and both adapters reject pointer creation when the canonical trigger draft is absent.
- Confirmed direct audit/evidence mutation still fails while exact parents exist, while formal parent cleanup cascades in one transaction.
- Confirmed recursive freezing applies at the final public boundary and does not freeze caller-owned nested containers.
- Confirmed no production import or call to the retired store resolver/wakeup/timer/cursor/notifier/compatibility paths was restored.
