# Task 5 report — stable Russian rich-content contract

## Implementation result

Task 5 implementation and verification are complete and the commit is ready for independent review. This report records evidence; it does not self-declare Task 5 approved.

The new rich-content boundary emits only `AUTO_LISTING_RICH_CONTENT_V1` with 3–20 closed blocks: one leading `HERO_IMAGE`, plus `HEADING`, `TEXT`, and `IMAGE_TEXT`. The hero is the single accepted `MAIN` asset. All referenced assets are unique, exact account/job/item/plan-scoped immutable generation records. Every text block carries bounded unique frozen fact IDs. Numeric occurrences bind one-to-one to the cited fact field/value/unit, nonnumeric cited values must appear, and Russian body copy permits only fact-proven brand/model exceptions and closed technical tokens. URLs, contacts, reviews, certification, medical/effect, warranty, after-sales, and unsupported accessory claims fail deterministically.

Prompt and input identity are canonical and independent of JSON key or ID-keyed fact/asset collection order. The prompt includes only frozen plan/fact and accepted asset projections and is capped at 256 KiB before reservation; it excludes source URLs, raw evidence, secrets, mutable listing data, and prior rich content. The input hash covers complete account/job/item/plan, source/fact/asset/plan hashes, profile/version, selected model, template version, language, and prompt.

The high-cohesion repository reserves before the single text-gateway call. Every reserve/complete/reject/fail transition is fenced by exact account/job/item/plan/input/attempt/lease evidence. Active work is concurrency-idempotent, expired work is terminalized before a bounded retry, and every terminal row clears leases. Same-input accepted reuse performs zero gateway calls only after revalidating the complete frozen input, accepted object references, model/request evidence, deterministic checker output, output hash, and terminal audit. Corrupt replay fails closed.

Migration 031 is additive and does not rewrite historical terminal rows. New `GENERATING` and `ACCEPTED` rows require complete hash, request, source fact, accepted asset, and lease evidence. Source facts are bounded to 1–256 and accepted assets to 6–20. Request evidence is the exact nonempty `requestKey`/fixed-schema pair. Accepted model evidence is the exact requested/reported/present triple, both models equal the persisted model, and present is JSON boolean true. `checker_result.accepted` is JSON boolean true. Explicit key/type/nonempty predicates and `IS TRUE` comparisons prevent JSON null and SQL three-valued CHECK bypasses.

## Changed files and contracts

- `server/auto-listing-rich-content.mjs`: exports the closed JSON schema, deterministic prompt builder, pure validator, and reserve-first generator.
- `server/auto-listing-rich-content-repository.mjs`: memory reference adapter and PostgreSQL fenced-attempt adapter with stable safe repository errors.
- `server/db/migrations/031_auto_listing_rich_content_attempt_evidence.sql`: additive evidence, lease, terminal, and full-scope uniqueness constraints.
- `server/tests/auto-listing-rich-content*.mjs`: schema/policy, orchestration/reuse, repository, migration, and double-gated disposable-PostgreSQL coverage.
- `docs/superpowers/specs/2026-08-04-stable-russian-rich-content-design.md`: approved Task 5 boundary and recovery design.
- `docs/superpowers/plans/2026-08-04-auto-listing-ai-content-pipeline.md`: frozen Task 5 scope, contracts, and completed implementation steps.

No route, queue, worker, Ozon adapter, credential path, or feature enablement was added. The feature remains unwired and disabled.

## TDD evidence

- Initial four-group RED: 25 tests, 0 passed, 24 expected failures, 1 explicit PostgreSQL skip.
- First implementation reached the original orchestration/repository GREEN, then nine independently identified completeness findings were added as RED and closed: six assets/exactly one MAIN, exact frozen evidence, canonical equality, exact reservation echo, request/model evidence, reuse completeness, lease/frozen-input protection, multi-number binding, and fail-closed accessory language.
- Collection-order and canonical JSONB checks went RED 27/29 and then GREEN. Terminal audit, prompt-size, direct repository evidence, and safe PostgreSQL error checks expanded the focused set to 33/33.
- Migration-031 hardening then produced static RED 3/4 and GREEN 4/4 for evidence cardinality, closed request/model keys, boolean checker acceptance, and JSON-null/SQL-3VL protection.
- Final focused result: 38 tests, 37 passed, 0 failed, 1 explicit dedicated-PostgreSQL skip.

## Final verification

- Focused Task 5: 38 total; 37 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Auto-listing: 266 total; 264 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 29 total; 26 passed, 0 failed, 3 dedicated-database skips.
- Selected historical permission, persistence, formal-store, account-store, category/listing, and warehouse boundaries: 42 passed, 0 failed.
- Whole `node --test server/tests/*.test.mjs`: 982 total; 976 passed, 0 failed, 6 configured skips.
- Raw `node --test server/tests/*.mjs`: 997 total; 989 passed, 1 failed, 7 skipped. The sole failure is the pre-existing `account-scoped-collection-migration.integration.mjs`, confirmed separately to require `SONLI_MIGRATION_TEST_DATABASE_URL`; it is an explicit environment gate, not a product pass.
- Production Vite build passed for 4,833 transformed modules. The existing greater-than-500-kB chunk warning remains.
- Changed-module syntax checks, `git diff --check`, and final status/diff inspection passed.

## Unverified scope, regression risk, and rollback

No real AI gateway, Ozon operation, object-storage mutation, source download, production database, or production data was used. PostgreSQL execution and malicious-insert behavior remain unverified because the dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` and opt-in gate were not available; the fixture never falls back to ordinary database configuration.

Primary integration risk is the future queue/worker and Ozon adapter honoring the exact repository evidence and stable internal contract. Keeping the feature disabled/unwired contains that risk. Application rollback is reverting the Task 5 commit. If migration 031 has been applied, preserve audit rows and use a reviewed additive compensating migration; do not destructively edit production schema or data.

Status: implemented, verified within the available environment, and entering independent review; not self-declared approved.
