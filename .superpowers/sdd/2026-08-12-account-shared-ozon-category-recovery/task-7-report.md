# Task 7 Report — Persist one category-recovery attempt and coordinate product absence

## Status and scope

- Status: complete.
- Base SHA: `f033165ec155f67b07e78473c396c8b5fae007f4`.
- Task SHA: `cfb7d204a9acf6a17f78715088638a64c8f91007` (`feat(listing): persist one category recovery attempt`).
- Fix round 1 SHA: `9b1c8a4` (`fix(listing): bind category recovery evidence`).
- Fix round 2 SHA: `87f3fd9` (`fix(listing): compose category recovery ports`).
- Fix round 3 SHA: `78fe62f` (`fix(listing): replay category recovery safely`).
- Fix round 4 SHA: `48329ad` (`fix(listing): preserve category recovery provenance`).
- Fix round 5 SHA: `073a66b` (`fix(listing): close recovery category identifiers`).
- Fix round 6: user-authorized exception after the five-round review cap (`fix(listing): preserve complex category attributes`).
- Fix round 7: the user authorized continuing later confirmed review defects without another per-round prompt (`fix(listing): bind complex attributes to refresh metadata`).
- Migration correction: the plan's 064 was already occupied and the repository latest was 067, so Task 7 adds only `068_auto_listing_category_recovery.sql`. Migrations 064–067 were not changed.
- Product scope is exactly the eight planned Task 7 paths with the corrected 068 number: migration, PostgreSQL repository, pure recovery service, exact offer reconciliation, and four focused tests.
- No Task 8 worker integration, classifier policy expansion, UI, dependency, lockfile or production configuration changed.

## Fix round 1/5 — database provenance and exact transition identity

- Review findings closed: C1 (direct-SQL evidence/attempt forgery), C2 (post-activation version fail-close) and I1 (incomplete state-port identity).
- Migration 068 remains unpublished and was corrected in place. Evidence INSERT now joins the exact current FAILED job, snapshot hash and byte-equivalent JSONB items, FAILED item with empty product ID and identical persisted safe error evidence, source evidence, and ACTIVE shared category/version. Any mismatch raises `23514`.
- Attempt INSERT now permits only the initial `CLAIMED` shape, with correction/replacement/retry/review/completion fields unset and every trigger evidence source/shared/version/task/hash identity exact. Direct terminal or forged attempt creation raises `23514`. The pre-claim review path now performs `CLAIMED` then the ordinary guarded `CLAIMED -> NEEDS_REVIEW` transition in one transaction.
- Every attempt state port now accepts a closed exact tuple containing account, job, snapshot, triggering evidence, source evidence, old shared category/version, original task, correlation and attempt identity. Both the transition write and idempotent replay check the complete tuple; a wrong field returns fixed conflict with zero state change.
- Recovery now validates and records the version returned by invalidation, supplies that exact version to activation, then records the actual activated version. A later failure marks that exact current version and the exact attempt for review. Failure of either fail-close write is no longer swallowed; the other write is still attempted and the service returns fixed `AUTO_LISTING_CATEGORY_RECOVERY_INCOMPLETE`.
- Round RED evidence: real PostgreSQL accepted forged `original_items` (first attack, 1/2 test failure); service used version 5 rather than activated version 6 and swallowed shared-review failure (2/11 failures). Round GREEN evidence: final focused/adjacent Task 7 and account-category run 45/45, including disposable PostgreSQL 001–068 and 0 skips; Task 4–6 adjacent preparer/source/rebuilder/import/reconciliation run 134/134. The PG suite includes evidence status/product/evidence/hash/items/version attacks, attempt source/shared/version/hash/terminal-insert attacks, correction-on-review injection, and all ten tuple-field mutations against every state port.

## Fix round 2/5 — production composition and closed state DTOs

- The service now sends the recovery repository its exact three-field load command instead of leaking the request correlation field across the closed boundary. A real disposable-PG composition test wires the production recovery repository and production account-shared category repository through the service; it reaches durable `RETRY_PENDING` and invokes the injected retry scheduler once.
- Shared-category transitions consume the existing exact descriptor-safe twelve-field public DTO. Recovery continues to persist the shared-category database identity already captured in its private basis; no database row ID was added to the public account-shared contract. Invalidate, activate and review results must match account, source signature, evidence, category, version, state, source, fingerprint and validation time exactly.
- Attempt results are now exact per state: MATCHED returns the replacement identity/version and corrected hash; RETRY_ACCEPTED and SUCCEEDED return the immutable retry task. The service validates its currently invoked claim/MATCHED/RETRY_PENDING DTOs before scheduling. The exported acceptance/completion repository ports are closed and real-PG tested; Task 8 remains responsible for their worker orchestration.
- Migration 068 makes snapshot `items` and `snapshot_hash` immutable while preserving the existing separately mutable pricing snapshot. Every recovery load/claim also joins both canonical snapshot hash and JSONB items to the evidence copy.
- Database transition shape is state-exact. As superseded by round 4, pre-match `NEEDS_REVIEW` has null corrected/replacement/retry fields while post-match review permanently retains the already-persisted correction/replacement and optional accepted retry task. Retry task is first assigned only by `RETRY_PENDING -> RETRY_ACCEPTED`. `CLAIMED -> MATCHED` verifies an exact ACTIVE account/source replacement row and version, recomputes the canonical corrected-items SHA-256 in PostgreSQL, preserves variant order and every non-category/non-attribute item field, and requires the corrected category IDs to equal the replacement row.
- Exact `attemptId: null` review replay is idempotent only for the full same tuple and safe review code; conflicting replay stays 409. Shared-category failure codes sent to the repository are fixed allowlisted state codes, never classifier or raw upstream codes.
- Round RED evidence: the real composition first failed at the four-field/three-field load boundary, then returned `NEEDS_REVIEW` because activation has no public `id`; direct SQL independently accepted snapshot mutation, retry injection on review and forged MATCHED correction/version. Round GREEN evidence: focused/account-category/real-PG 55/55 with zero skips; adjacent Task 4–6 preparer/source/rebuilder/import/reconciliation 134/134.

## Fix round 3/5 — replay-first eligibility and complete port closure

- Existing attempts now follow a replay-first read branch: the repository verifies exact historical account/job/snapshot/evidence/source/shared/version/original-task/hash binding and returns the persisted correlation identity; the service validates that correlation before considering the mutable current shared-category version. A real production-repository composition test proves first `RETRY_PENDING`, exact pending replay, `RETRY_ACCEPTED` replay and `SUCCEEDED` replay with zero incremental store, Ozon, taxonomy, category-mutation or retry-scheduling calls.
- The absence-to-claim window no longer converts a stale claim into a new review attempt. Claim failure returns fixed `AUTO_LISTING_CATEGORY_RECOVERY_NOT_ELIGIBLE`. Both claim and the allowed pre-claim review path lock and revalidate the exact current job/shared basis plus every item status/product identity before inserting an attempt. A real-PG barrier mutates the product after absence and proves zero attempts and zero schedules.
- Every service port result used before scheduling is descriptor-safe and exact. Absence accepts only the four documented status/code combinations; refresh accepts only the five-field unique-match DTO with a bounded safe metadata projection; review accepts only `{attemptId,status: NEEDS_REVIEW}` with exact attempt identity when already claimed. Extras, accessors, transparent/revoked proxies and wrong codes/IDs/statuses fail closed without raw leakage or scheduling.
- MATCHED provenance now additionally requires replacement `source_description_category_id`, `source_type_id` and `taxonomy_scope` to equal the bound source evidence in both repository SQL and the migration trigger. A same-evidence ACTIVE row with a forged source triple is rejected `23514`.
- The migration trigger checks corrected-items JSON type/count/size before any array function. Object, scalar, JSON null, oversized, wrong hash, wrong category and wrong provenance direct-SQL variants all deterministically raise `23514`; canonical hash, ordered variant comparison and non-category field preservation remain enforced.
- Round RED evidence: malformed absence DTO reached `RETRY_PENDING`; the post-absence product barrier created a review attempt instead of rejecting; an object corrected payload surfaced native PostgreSQL `22023`. Round GREEN evidence: focused/account-shared/real PostgreSQL 56/56 with zero skips; Task 4–7 adjacent preparer/source/rebuilder/import/reconciliation 134/134. Syntax and diff checks passed.

## Fix round 4/5 — current claim eligibility and permanent post-match provenance

- Review findings closed: I1 (corrected items without a closed own `attributes` array), I2 (review erased MATCHED/retry provenance), and I3 (direct CLAIMED insertion trusted stale evidence without rechecking current eligibility).
- `validCorrection()` now requires every projected corrected item to own an `attributes` array. Missing, null, object, accessor, transparent proxy and revoked proxy values fail with the existing fixed correction-review path before match persistence or retry scheduling; the descriptor-safe carrier projector executes no hostile getter.
- Migration 068 uses `IS DISTINCT FROM 'array'` for corrected-item attributes, so absent and JSON null values cannot pass through SQL three-valued logic. Direct object/scalar/missing/null corrections deterministically raise `23514` before persistence.
- Attempt INSERT now locks and revalidates the exact evidence/job/snapshot/source/shared basis, the job's current FAILED/original-task identity, the ACTIVE old shared version and source triple, and every submission item's FAILED/empty-product state. It also requires live item count to equal both the job and frozen snapshot counts. Product, item status, job status/task, and shared status/version drift all reject direct CLAIMED insertion with `23514`.
- Pre-match `NEEDS_REVIEW` retains the original null correction/replacement/retry shape. After MATCHED, review preserves corrected items/hash and replacement category/version byte-for-byte; after RETRY_ACCEPTED it additionally preserves the first retry task. The repository no longer clears these fields, and the transition trigger rejects any later clear or substitution with `23514`.
- Round RED evidence: service 15/16 because missing attributes incorrectly reached `RETRY_PENDING`; fresh PG failed on the first evidence-after-product-drift direct INSERT because it was accepted. Round GREEN evidence: Task7 focused 26/26 with disposable PG migrations 001–068 and 0 skips; non-PG Task4–7 adjacent 164 passed with one expected PG gate rerun separately; PG 063/067/repository/upload adjacent 12/12 with 0 skips. The known pre-existing `sharp` Team-ID mismatch prevented the separately attempted Listing Pipeline V3 file from loading; no ad-hoc signing or dependency mutation was used.

## Fix round 5/5 — canonical corrected-item category identifiers

- Review finding closed: the MATCHED trigger's ordinary `<> 'number'` checks evaluated to SQL unknown for absent snake-case category IDs, while camel-case IDs were removed from the immutable comparison and therefore could coexist or conflict without rejection.
- Task 5's production rebuilder and its input normalizer both emit only canonical `description_category_id` and `type_id`; they do not emit camel-case category IDs. Migration 068 therefore rejects any `descriptionCategoryId` or `typeId` key instead of supporting a second representation.
- Both canonical IDs now pass a NULL-safe JSON number check, canonical positive-integer decimal form, a 16-digit conversion bound, the JavaScript safe-integer maximum, and exact equality with the activated replacement category. The guarded CASE structure never casts missing, null, string, fractional, signed or oversized values.
- The fresh PostgreSQL attack matrix covers each missing snake ID; null, string, zero, negative, fractional and over-safe values for each snake ID; and matching or conflicting presence of each camel ID. Every attack raises `23514`; the unchanged production rebuilder shape still persists and advances through MATCHED.
- RED: the fresh-PG suite stopped at the first missing `description_category_id` with `Missing expected rejection`. GREEN: Task 7 focused 26/26 with migrations 001–068 and 0 skips; Task4–7 adjacent non-PG 164 passed with its one explicit PG gate rerun in the dedicated suite; adjacent real-PG 12/12 with 0 skips. Syntax and diff checks passed.

## User-authorized exceptional fix round 6 — production complex category attributes

- The final Task 7 review found that Task 5's real `rebuildOzonItemsForCategory()` legitimately adds, replaces, or removes `complex_attributes`, while the recovery service and migration 068 still treated that field as immutable. The user explicitly authorized one exceptional sixth Task 7 correction round.
- Recovery now excludes only canonical category fields, simple category attributes, and `complex_attributes` from the otherwise byte-equivalent item projection. Price/currency, offer/SKU, content/media, dimensions, stock, warehouse and every other field remain immutable.
- When `complex_attributes` is present, the service requires the exact Task 5 production carrier: a bounded non-empty array of exact `{attributes}` groups, bounded non-empty exact `{complex_id,id,values}` attributes with positive safe IDs, and bounded non-empty exact `{value,dictionary_value_id?}` values. Transparent/revoked proxies and malformed/open carriers fail before match persistence or retry scheduling. Absence remains valid because Task 5 deletes the field when no replacement complex attribute survives.
- Migration 068 applies the same closed JSON contract in a NULL-safe validator before `MATCHED`. Null/object/empty arrays, malformed groups/attributes/values, nonpositive IDs and extra keys all raise `23514`; canonical Task 5 output persists. The existing canonical snake category-ID, replacement provenance, corrected hash/order and non-category preservation checks remain unchanged.
- The real PostgreSQL composition test now calls the production Task 5 rebuilder. One frozen item replaces complex attribute 300, adds 400 and removes obsolete 999; the exact corrected result persists and reaches durable `RETRY_PENDING`.
- TDD RED evidence: the real production chain first returned `NEEDS_REVIEW/CORRECTION_INVALID`; after the service projection was opened minimally it still returned `NEEDS_REVIEW/INCOMPLETE` because PostgreSQL rejected the valid correction. The malformed service carrier test then incorrectly reached `RETRY_PENDING`, and the direct-SQL matrix accepted malformed nested complex JSON before the closed validators were added.
- GREEN: fresh tmpfs PostgreSQL 16 Task 7 focused 27/27, 0 failed, 0 skipped. Adjacent account-shared/category/preparer/empty-policy tests passed 158/158, 0 skipped. The known ChatGPT-bundled Node Team-ID mismatch initially blocked Sharp-dependent adjacent files; the already-created ad-hoc temporary Node copy reran those exact files 22/22, 0 skipped, and Listing Pipeline V3 passed. Repository dependencies and the application bundle were not modified.
- The Task 7 PostgreSQL fixture now seeds its shared-row clock to a fixed instant before its fixed transition instants; this removes a date-dependent test failure after 2026-08-13 without changing production behavior.

## User-authorized automatic exceptional fix round 7 — exact Task 5 complex metadata contract

- The round-6 structural validator did not prove several invariants already guaranteed by the real Task 5 rebuilder: one `complex_id` per group, global `(complex_id,id)` uniqueness, the 1,000-attribute total bound, membership in the exact refreshed metadata, or dictionary ID/text canonicality. It also used PostgreSQL's ASCII-oriented `BTRIM` rather than JavaScript `trim` semantics for all whitespace.
- Recovery now accepts only a descriptor-safe, closed Task 5 refresh metadata projection with exact category identity, exact normalized five-field attributes, unique `(complexId,id)` keys, and exact bounded dictionary entries. Each corrected complex group has one complex ID, every key is globally unique and present in that projection, and the sum across all groups is at most 1,000. Dictionary-backed attributes require an exact allowed dictionary-value ID paired with its canonical text.
- The MATCHED attempt now persists `replacement_category_metadata` as immutable audit/provenance evidence. Repository replay requires exact metadata equality. Migration 068 independently validates the closed metadata and corrected complex structure, replacement category identity, group consistency, global uniqueness, total count, metadata membership and dictionary pair before allowing MATCHED. Post-match review retains this evidence permanently alongside corrected items/hash and replacement identity.
- JavaScript and PostgreSQL now agree on blank/outer-whitespace rejection. The SQL validators use the explicit ECMAScript trim character set (ASCII whitespace, NBSP, U+1680, U+2000–U+200A, line/paragraph separators, narrow no-break space, medium mathematical space, ideographic space and BOM), avoiding locale-dependent inference.
- The real Task 5 rebuilder → service → fresh PostgreSQL composition still replaces attribute 300, adds 400, removes obsolete 999 and reaches durable `RETRY_PENDING`; the dictionary-backed 300 source value is additionally canonicalized to the refresh metadata text before persistence.
- TDD RED evidence: service was 17/18 because the first mixed/metadata-invalid complex result reached `RETRY_PENDING`; migration was 1/2 because no metadata evidence/validator existed; fresh PostgreSQL was 2/3 because direct SQL could not store or validate the refresh metadata and surfaced the missing column rather than fixed `23514`. GREEN: focused 28/28, adjacent Task 4–7/Task 5 account/category/preparer/materialization/empty-policy/rebuilder 180/180, Task 4 lease/upload PostgreSQL 11/11, and Listing Pipeline V3 passed, all with zero skips.
- No live Ozon seller API, product import, paid AI, object storage, production credential/account/database or production write was used. Tests used injected ports and one loopback-only tmpfs PostgreSQL 16 container.

## Closed contracts delivered

### Persistence and tenant boundary

- `submission_category_error_evidence` is append-only and binds the exact account/job/snapshot/item/offer/original Ozon task, immutable snapshot hash/items, source evidence, old shared category/version, versioned safe classifier evidence and capture time.
- The database admits only the exact nine-field `OZON_CATEGORY_IMPORT_ERROR_EVIDENCE_V1`, exact FAILED/EXPLICIT state, null product identity, exact offer and bounded structured fields. Raw provider messages/responses and credentials are absent.
- `submission_category_recovery_attempts` permits at most one `(account_id, submission_job_id)` row and binds the exact triggering evidence, immutable original snapshot/items/source/shared version, corrected canonical hash/items, replacement shared version, original task and optional first-set retry task.
- Statuses are exactly `CLAIMED | MATCHED | RETRY_PENDING | RETRY_ACCEPTED | SUCCEEDED | NEEDS_REVIEW`. SQL enforces the forward lattice, replacement version progression, MATCHED correction immutability, first-set retry task immutability and terminal completion shape. Ordinary illegal UPDATE/DELETE raises `23514`.
- Exact parent account/job/source/shared cleanup can cascade append-only child records only after the parent disappears; ordinary direct deletion remains forbidden. Repository reads/writes require explicit account identity and composite job/snapshot/evidence/category identity.
- The original task is validated at evidence insertion and first claim. It remains immutable historical evidence while the mutable job may later advance to the retry task; the attempt separately stores the first retry task.

### Empty production policy gate

- Task 6 production V1 has no authoritative category-failure allowlist. `recordCategoryErrorEvidence()` invokes the fixed production evidence projection and currently rejects `AUTO_LISTING_CATEGORY_RECOVERY_POLICY_DISABLED` before opening PostgreSQL. No test rule constructor or classifier injection was added.
- The real-PG integration inserts one controlled migration/backfill fixture directly through SQL only after 068 is applied, so every database constraint and original-terminal-task trigger still executes. This fixture is not a production write API or manual recovery bypass.
- Automatic production recovery therefore remains unreachable until a later reviewed official fixture creates a new production policy version. Manual recovery was not implemented by impersonating EXPLICIT evidence.

### Exact offer absence

- `confirmOfferAbsent()` accepts only a closed descriptor-safe carrier containing frozen exact offer/SKU pairs and an operating-store credential projection. Caller data is neither mutated nor frozen; the result is frozen and contains only `ABSENT | PRESENT | UNKNOWN` plus a fixed safe code.
- It performs exactly one bounded `/v3/product/list` read with exact `filter.offer_id`, a bounded limit and fixed path. No caller URL/base is accepted.
- Only an exact complete empty response with `total=0` and no cursor proves `ABSENT`. Matching offer or SKU proves `PRESENT`. Other returned items, totals/cursors, identity mismatch, malformed/oversized/hostile response, auth/throttle/5xx/network/response loss all return `UNKNOWN`, never `ABSENT`.
- Input and response accessors, transparent/revoked proxies, custom prototypes, sparse/extra arrays, cycles and oversized strings fail closed without raw message or credential leakage.

### One-shot recovery orchestration

- Strict order is persisted basis → store credential → exact absence → sole claim → old version invalidation → unique taxonomy refresh → required attribute rebuild → replacement activation → atomic corrected-item/hash persistence → `RETRY_PENDING` → one retry scheduling request.
- Initial claim rechecks under transaction that the original job is still exact terminal FAILED, current task still equals the original task, every item remains FAILED and every product ID remains empty. A stale/present product after the external absence read produces zero attempt rows.
- Persisted attempts replay before store/Ozon/category work. Exact response-loss replays for claim, match, retry-pending, retry-task acceptance and success are idempotent; a changed task, corrected hash or immutable identity conflicts.
- Present/unknown product state, ambiguity, missing required attributes, stale shared version, cross-account data, malformed correction and other pre-retry failure become safe `NEEDS_REVIEW` with zero product import. After invalidation, both the shared category and attempt are moved toward `NEEDS_REVIEW` fail-closed.
- Corrected items are committed before scheduling. Retry scheduling response loss leaves durable `RETRY_PENDING`; it does not rebuild or schedule a second attempt.
- Correction validation permits only category IDs and current replacement attributes to change. Offer/SKU, content, media, price/currency, VAT, dimensions/weight, barcode, store, warehouse, stock and all other fields remain byte-equivalent in the closed projection.

## TDD evidence

- Initial RED: 3/3 failed — two missing 068 migration reads and one missing offer-reconciliation module.
- Repository/orchestrator RED: the two new production modules were absent; the combined run had two file-level module-load failures while migration/reconciliation tests were already GREEN.
- Each hostile, one-attempt, response-loss and stale-state regression was added before or alongside its minimal contract implementation and rerun focused until green.

## Final verification

- User-authorized automatic round 7 focused command: **28/28 passed, 0 failed, 0 skipped** on fresh tmpfs PostgreSQL 16. Adjacent Task 4–7/Task 5 account/category/preparer/materialization/empty-policy/rebuilder tests passed **180/180**, Task 4 lease/upload PostgreSQL passed **11/11**, and Listing Pipeline V3 passed; all had zero skips.
- User-authorized exceptional round 6 focused command: **27/27 passed, 0 failed, 0 skipped** on fresh tmpfs PostgreSQL 16, including the real Task 5 rebuilder → recovery service → migrations 001–068 path and the malformed service/direct-SQL matrices.
- Round 6 adjacent category/account/preparer/empty-production-policy command: **158/158 passed, 0 failed, 0 skipped**. The two Sharp-dependent adjacent files passed **22/22, 0 skipped** under the pre-existing ad-hoc temporary Node copy, and Listing Pipeline V3 passed against the same disposable PostgreSQL database.
- Fix round 5 latest focused command: **26/26 passed, 0 failed, 0 skipped** on a fresh tmpfs PostgreSQL 16 database, including both real-PG Task 7 paths and migrations 001–068.
- Fix round 5 adjacent non-PG command: **164 passed, 0 failed**; its one explicit PG gate was covered by the dedicated run.
- Fix round 5 dedicated adjacent PostgreSQL command: **12/12 passed, 0 failed, 0 skipped**.
- Fix round 4 latest focused command: **26/26 passed, 0 failed, 0 skipped**, including both real PostgreSQL tests and migrations 001–068.
- Fix round 4 adjacent non-PG command: **164 passed, 0 failed**; its one PostgreSQL gate was subsequently covered by the dedicated run.
- Fix round 4 dedicated adjacent PostgreSQL command: **12/12 passed, 0 failed, 0 skipped** for account-shared 063, auto-listing 067 graph/lease/repository and upload task paths.

- Required focused command with disposable PostgreSQL enabled: **18/18 passed, 0 failed, 0 skipped**.
- Real PostgreSQL Task 7 subset: migrations **001–068** applied in order; repository/transition suite **2/2 passed, 0 skipped**.
- Broad Task 4–6/category/module adjacent suite: **273 passed, 0 failed**; one account-shared PG branch was environment-gated in that local command and was run separately below.
- Account-shared 063 rollback/migration suite on a second fresh disposable database: **3/3 passed, 0 skipped**.
- Auto-listing 067 upgrade/repository/lease/upload worker adjacent PostgreSQL run produced ten passing tests. Two 063 rollback cases failed only because the combined invocation had already created identically named tables in the same database's public schema; the isolated fresh-database rerun above passed all three without code changes.
- Listing pipeline V3 integration passed using a `/private/tmp` copy of the same bundled Node v24.14.0 executable with an ad-hoc signature. The system ChatGPT application binary and repository dependency were not modified. The ordinary bundled runtime still cannot load the pre-existing `sharp` binary because of the documented Team-ID mismatch.
- Production syntax checks for all three new modules and `git diff --check` passed.

## Disposable PostgreSQL and external effects

- Image: official `postgres:16`; loopback-only random bind `127.0.0.1:50446`.
- Data: tmpfs at `/var/lib/postgresql/data`, 512 MiB; no Docker mount or named volume.
- Tests used fake/injected Ozon ports only. No live Ozon seller API, product import, paid AI, object storage, production credential/account/service/database or production data was contacted.
- The container and temporary Node copy are removed after final verification; their tmpfs/private-temp data is not retained.

## Risks, unverified scope and rollback

- Automatic production recovery remains intentionally disabled by the empty Task 6 policy; no real current Ozon category-invalid schema/fixture was available or inferred.
- Task 8 must bind the retry task to the original job and read `corrected_items` from the immutable attempt. Task 7 does not itself submit a product import or advance worker state.
- The complete repository-wide suite was not run. Focused, broad adjacent, pipeline, migration and real-PG boundaries listed above were run; the known native Sharp signature issue remains an environment limitation for the ordinary bundled runtime.
- Roll back application behavior by reverting the Task 7 commit. Migration 068 is forward-only and append-only and may remain dormant; do not delete audit/history rows to simulate rollback. Physical removal requires first disabling recovery/worker writes and removing triggers, tables and new indexes in reverse dependency order under an authorized maintenance plan.
