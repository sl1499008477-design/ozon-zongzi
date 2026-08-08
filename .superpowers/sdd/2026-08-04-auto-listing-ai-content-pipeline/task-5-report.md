# Task 5 report — stable Russian rich-content contract

## Implementation result

Task 5 implementation and verification are complete and the commit is ready for independent review. This report records evidence; it does not self-declare Task 5 approved.

The new rich-content boundary emits only `AUTO_LISTING_RICH_CONTENT_V1` with 3–20 closed blocks: one leading `HERO_IMAGE`, plus `HEADING`, `TEXT`, and `IMAGE_TEXT`. The hero is the single accepted `MAIN` asset. All referenced assets are unique, exact account/job/item/plan-scoped immutable generation records. Every text block carries bounded unique frozen fact IDs. Numeric occurrences bind one-to-one to the cited fact field/value/unit, nonnumeric cited values must appear, and Russian body copy permits only fact-proven brand/model exceptions and closed technical tokens. URLs, contacts, reviews, certification, medical/effect, warranty, after-sales, and unsupported accessory claims fail deterministically.

Prompt and input identity are canonical and independent of JSON key or ID-keyed fact/asset collection order. The prompt includes only frozen plan/fact and accepted asset projections and is capped at 256 KiB before reservation; it excludes source URLs, raw evidence, secrets, mutable listing data, and prior rich content. The input hash covers complete account/job/item/plan, source/fact/asset/plan hashes, profile/version, selected model, template version, language, and prompt.

The high-cohesion repository reserves before the single text-gateway call. Every reserve/complete/reject/fail transition is fenced by exact account/job/item/plan/input/attempt/lease evidence. Active work is concurrency-idempotent, expired work is terminalized before a bounded retry, and every terminal row clears leases. Same-input accepted reuse performs zero gateway calls only after revalidating the complete frozen input, accepted object references, model/request evidence, deterministic checker output, output hash, and terminal audit. Corrupt replay fails closed.

Migration 031 is additive and does not rewrite historical terminal rows. New `GENERATING` and `ACCEPTED` rows require complete hash, request, source fact, accepted asset, and lease evidence. Source facts are bounded to 1–256 and accepted assets to 6–20. Request evidence is the exact nonempty `requestKey`/fixed-schema pair. Accepted model evidence is the exact requested/reported/present triple, both models equal the persisted model, and present is JSON boolean true. `checker_result.accepted` is JSON boolean true. Explicit key/type/nonempty predicates and `IS TRUE` comparisons prevent JSON null and SQL three-valued CHECK bypasses.

## Changed files and contracts

- `server/auto-listing-rich-content.mjs`: exports the closed JSON schema, deterministic prompt builder, pure validator, and reserve-first generator.
- `server/auto-listing-image-generator.mjs`: exports the pure Task 4 accepted-asset verifier and now recomputes its canonical attempt, input, and prompt identities during replay.
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

## Independent-review repair round 1

The first independent review reproduced five Important boundary defects and all five are now closed. Task 5 replays the complete Task 4 accepted-asset contract instead of trusting shallow accepted rows; every prompt-projected fact/asset identifier and value rejects URL, contact, and credential-shaped data before reservation; memory and PostgreSQL completion independently validate the closed rich-content document, canonical output hash, exact request/model/checker evidence, and full 36-key asset audit; migration 031 owns matching SQL-null/JSON-null-safe closed validators and exact V2/legacy object-key rules; and gateway/database failures expose only stable safe Task 5 errors.

The repair also mirrors valid Task 4 compatibility details: checker facts may be a group-specific subset of the frozen rich-content registry, upstream image-model evidence may explicitly report absence, and generation sizes require positive integer dimensions. Direct repository tests reject invented content, forged keys or versions, extra keys, unknown checker facts, wrong hashes, null evidence, and zero dimensions without mutating the generating attempt.

### Repair TDD and verification

- Initial rich-content/repository RED: 38 tests; 33 passed and 5 expected failures reproduced incomplete Task 4 evidence, unsafe prompt projection, invented direct completion, raw gateway failures, and raw connection failures.
- Additional repository compatibility RED: 12 tests; 9 passed and 3 expected failures reproduced group-specific fact-subset rejection, omitted upstream image-model rejection, and `0x0` generation-size acceptance. Final repository result: 12/12.
- Prompt identifier safety went RED in the existing 28-test suite and then GREEN after fact IDs, asset IDs, slot keys, and roles joined the shared projection predicate.
- Final focused image/rich/repository/migration set: 82 total; 81 passed, 0 failed, 1 dedicated-PostgreSQL skip.
- Auto-listing: 278 total; 276 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 33 total; 30 passed, 0 failed, 3 dedicated-database skips.
- Selected historical boundaries: 42 passed, 0 failed.
- Whole `server/tests/*.test.mjs`: 994 total; 988 passed, 0 failed, 6 configured skips.
- Raw `server/tests/*.mjs`: 1009 total; 1001 passed, 1 failed, 7 skipped. The sole failure remains the pre-existing explicit `account-scoped-collection-migration.integration.mjs` environment gate because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production Vite build passed for 4,833 transformed modules with only the existing greater-than-500-kB chunk warning. Changed-module/fixture syntax and Git diff checks passed.

The dedicated PostgreSQL behavior fixture remains unexecuted because both `AUTO_LISTING_POSTGRES_TESTS=1` and `SONLI_MIGRATION_TEST_DATABASE_URL` are absent. No real gateway, Ozon, storage, source-download, production database, or production-data operation ran. The feature remains disabled and unwired.

Repair commits are `b1be7e2` (pure Task 4 evidence verifier), `86257ac` (closed migration 031 evidence constraints), and `37b774f` (prompt/repository/error boundaries). Application rollback reverts those commits in reverse order while keeping the feature disabled. If migration 031 was applied, preserve immutable audit rows and use a reviewed forward compensating migration rather than destructive schema or data edits.

Status after repair: implemented and fully verified within the available environment; a fresh independent read-only review is in progress, so this report still does not self-declare approval.

## Independent-review repair round 2

The second independent review returned 0 Critical, 6 Important, and 1 Minor finding. The repair closes every reproduced boundary without wiring the feature. Task 4 accepted replay now recomputes `attemptIdentityHash`, `inputHash`, and `promptHash` from the closed canonical evidence instead of trusting internally consistent claimed hashes or object keys. Task 5 rebuilds its deterministic prompt and recomputes `factRegistryHash`, `assetHash`, `promptHash`, and `inputHash` at both memory and PostgreSQL reservation/completion boundaries. Forged but mutually consistent caller hashes therefore fail before persistence or gateway work.

Same-input `REJECTED` rows are terminally replayed before a new attempt is created, with zero gateway calls. Prompt projection now covers units, bare public-domain shapes, international phone numbers, and `Bearer` credentials without requiring a colon. Repository source evidence is aligned with the Task 4 PNG/JPEG/WebP contract, and connection, query, and synchronous or asynchronous release failures map to the fixed retryable repository error.

Migration 031 now mirrors the complete Task 4 compatibility boundary that SQL can reliably determine: exact PNG/JPEG/WebP MIME values; a closed nonempty checker-fact subset of the frozen registry; explicit reported-image-model presence with either an exact model or the Task 4 empty-string absence sentinel; closed, ordered, unique, UTF-8-bounded source-fact, claim, and detected-text arrays; and SQL/JSON-null-safe audit-field limits. Task 5 rich text retains its frozen-fact Russian word-form compatibility, while embedded Task 4 nonnumeric checker claims retain the stricter JavaScript exact-value containment semantics. The migration does not guess canonical hashes that require application-owned serialization.

### Round 2 TDD and final verification

- Task 4 identity replay RED: 34 tests; 33 passed and 1 expected failure. The adjacent Task 4 generation suite then reached 58/58.
- Rich-content/repository RED: 53 tests; 40 passed and 13 expected failures reproduced terminal rejection replay, JPEG/WebP compatibility, four canonical-hash forgeries, pre-query PostgreSQL validation, release-error mapping, and four prompt-projection gaps.
- Migration initial RED: 13 tests; 8 passed and 5 expected failures. A final semantic-difference test then went RED at 13/14 before the exact Task 4 nonnumeric-claim condition was restored. Static migration GREEN is 14/14.
- Final focused image/rich/repository/migration set: 103 passed, 0 failed, 0 skipped.
- Auto-listing: 299 total; 297 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 39 total; 36 passed, 0 failed, 3 dedicated-database skips.
- Selected historical permission, persistence, formal-store, account-store, category/listing, and warehouse boundaries: 42 passed, 0 failed.
- Whole `server/tests/*.test.mjs`: 1,015 total; 1,009 passed, 0 failed, 6 configured skips.
- Raw `server/tests/*.mjs`: 1,030 total; 1,022 passed, 1 failed, 7 skipped. The sole failure remains the pre-existing `account-scoped-collection-migration.integration.mjs` environment gate because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production Vite build passed for 4,833 transformed modules with only the existing greater-than-500-kB chunk warning. Changed JavaScript/module syntax checks and `git diff --check` passed.

The rich-content PostgreSQL behavior fixture remains unexecuted because both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` are absent. No real gateway, Ozon, storage, source-download, production-database, or production-data operation ran. The feature remains disabled and unwired.

These round-2 changes are intentionally not committed in this report-writing step. Application rollback is to revert the eventual scoped repair commit while keeping the feature disabled. If migration 031 has been applied, preserve immutable audit rows and replace its functions/constraints through a reviewed forward migration; do not destructively roll back production schema or data.

Status after round 2: implemented and verified within the available environment; a new independent read-only review is running, so Task 5 is not self-declared approved.

## Independent-review repair round 3

The third independent review formally returned NOT PASS with 0 Critical, 4 Important, and 1 Minor finding. It found that migration 031 represented an absent Task 4 gateway-reported image model as JSON null while both JavaScript validators require the empty string; that SQL checked rich-content fact/asset references as sets instead of the validator's first-reference order; that SQL did not yet mirror the fixed Russian-language and policy rules used during JavaScript replay; that the prompt's finite top-level-domain enumeration missed valid DNS suffixes; and that the pure Task 5 identity helper could clone/sort oversized collections before enforcing their cardinality.

The repaired migration requires `gatewayReportedImageModelPresent=false` together with the exact empty string and rejects JSON null. It derives checker `sourceFactIds` by block and in-block ordinality with first-occurrence deduplication, derives `assetIds` by block order, and exact-compares both arrays. High-cohesion immutable SQL helpers now mirror the fixed eight policy families plus the Russian token rule, including cited BRAND/MODEL Latin exceptions and the closed technical-token allowlist. English-only and prohibited-policy terminal documents therefore fail the same durable boundary that JavaScript later replays.

Prompt projection now uses a general Unicode DNS-label detector rather than a finite suffix list, covering country-code, generic, IDN, and punycode domains in every projected field while preserving only the closed internal fact/path identifier grammar. The canonical identity helper enforces 1–256 closed fact rows, 6–20 closed asset rows, top-level audit shape, and UTF-8 byte ceilings before any clone, sort, prompt serialization, or hash. Repository validation applies the complete fact/asset contract before calling the identity helper, and all repository string ceilings now use UTF-8 bytes consistently with PostgreSQL `OCTET_LENGTH`. Chinese and emoji boundary cases cover both memory and PostgreSQL pre-query paths.

### Round 3 TDD and final verification

- Absent-image-model SQL alignment went RED at 13/14 and then GREEN at 14/14; the combined static-plus-fixture entry set was 15/15.
- SQL order/language/policy RED: 16 tests; 14 passed and 2 expected failures. Static migration GREEN is 16/16.
- JavaScript prompt/preflight/UTF-8 RED: 59 tests; 54 passed and 5 expected failures. The identical rich-content/repository set reached 59/59, and adjacent image/rich/repository reached 93/93.
- Final focused image/rich/repository/migration set: 110 passed, 0 failed, 0 skipped.
- Auto-listing: 306 total; 304 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 41 total; 38 passed, 0 failed, 3 dedicated-database skips.
- Selected historical permission, persistence, formal-store, account-store, category/listing, and warehouse boundaries: 42 passed, 0 failed.
- Whole `server/tests/*.test.mjs`: 1,022 total; 1,016 passed, 0 failed, 6 configured skips.
- Raw `server/tests/*.mjs`: 1,037 total; 1,029 passed, 1 failed, 7 skipped. The sole failure remains the pre-existing `account-scoped-collection-migration.integration.mjs` environment gate because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production Vite build passed for 4,833 transformed modules with only the existing greater-than-500-kB chunk warning. All eight changed JavaScript/module syntax checks and `git diff --check` passed.

The rich-content PostgreSQL behavior fixture remains unexecuted because both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` are absent. Its added cases cover ordered references, reversed facts/assets, English-only text, prohibited warranty text, the empty-string absence sentinel, and JSON-null rejection, but they are not reported as executed. No real gateway, Ozon, storage, source-download, production-database, or production-data operation ran. The feature remains disabled and unwired.

Round-3 changes remain uncommitted pending the coordinating agent's final scope review. Application rollback is to revert the eventual scoped repair commit while keeping the feature disabled. If migration 031 has been applied, preserve immutable audit rows and replace functions/constraints through a reviewed forward migration; do not destructively roll back schema or data.

Status after round 3: implemented and verified within the available environment; a fourth independent read-only review is running, so Task 5 is not self-declared approved.

## Independent-review repair round 4

The fourth independent review formally returned NOT PASS with 0 Critical and 2 Important findings. First, the fixed contact/certification policy recognized direct contact details and several certification forms but did not reject seller-contact headings or instructions such as `Контакты продавца`, `Телефон продавца`, `Обратитесь к продавцу`, or the noun `Сертификация`. Second, the migration-owned Task 4 checker validator expanded several JSON arrays without first enforcing the JavaScript cardinality contracts, allowing oversized checker evidence at the durable boundary.

The JavaScript and immutable SQL policy rules now share the same Unicode-aware contact stems for contact, telephone, and contacting the seller, plus the certification noun stem; the prior link, messenger, review, medical, warranty, after-sales, and accessory rules remain intact. Focused regression proves the four reported phrases fail while the fact-proven `SONLI` brand and closed `USB-C`/`Bluetooth` technical tokens remain valid.

Before any element expansion, the SQL Task 4 checker validator now requires closed arrays and the JavaScript limits: reasons at most 32, identity source assets 1–7, claims at most 256, detected texts at most 64, quality flags at most 4, and prohibited flags at most 8. Guarded `CASE` expressions prevent `jsonb_array_length` from running against non-array JSON, retaining fail-closed SQL/JSON-null behavior.

### Round 4 TDD and final verification

- JavaScript policy RED: 37 tests; 33 passed and the four reported phrases failed. The identical suite reached 37/37, and adjacent image/rich/repository reached 98/98.
- SQL policy RED: 17 tests; 16 passed and 1 expected failure. After adding the checker-cardinality contract, combined SQL RED was 18 tests with 16 passed and 2 expected failures. Static migration GREEN is 18/18.
- The Task 4 checker-focused set reached 15/15; the repair integration subset reached 113/113.
- Final focused image/rich/repository/migration set, including the gated-fixture entry file: 117 passed, 0 failed, 0 skipped.
- Auto-listing: 315 total; 313 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 43 total; 40 passed, 0 failed, 3 dedicated-database skips.
- Selected historical permission, persistence, formal-store, account-store, category/listing, and warehouse boundaries: 42 passed, 0 failed.
- Whole `server/tests/*.test.mjs`: 1,031 total; 1,025 passed, 0 failed, 6 configured skips.
- Raw `server/tests/*.mjs`: 1,046 total; 1,038 passed, 1 failed, 7 skipped. The sole failure remains the pre-existing `account-scoped-collection-migration.integration.mjs` environment gate because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production Vite build passed for 4,833 transformed modules with only the existing greater-than-500-kB chunk warning. All ten changed JavaScript/module syntax checks and `git diff --check` passed.

The PostgreSQL behavior fixture remains unexecuted because both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` are absent. Its fourth-round cases cover all four seller-contact/certification phrases and the checker array limits, but they are not reported as executed. No real gateway, Ozon, storage, source-download, production-database, or production-data operation ran. The feature remains disabled and unwired.

Round-4 changes remain uncommitted pending the coordinating agent's final scope review. Application rollback is to revert the eventual scoped repair commit while keeping the feature disabled. If migration 031 has been applied, preserve immutable audit rows and replace functions/constraints through a reviewed forward migration; do not destructively roll back schema or data.

Status after round 4: implemented and verified within the available environment; a fifth independent read-only review is running, so Task 5 is not self-declared approved.

## Independent-review repair round 5

The fifth independent review identified three Important boundary defects. The new contact stem matched from inside a longer legitimate Russian word, causing `бесконтактный` to be rejected. Separately, the outer `checkGeneratedAsset` path normalized, decoded, and hashed the generated image before checking the already-frozen 1–7 reference and 1–256 fact cardinalities, so an oversized request with invalid image bytes surfaced an asset-decode error instead of the stable retryable checker error. A follow-up review then reproduced the same missing-left-boundary class in the older review, regulated, and bundle word branches: legal compounds such as `Теплообменник`, `безотзывный`, and `немедицинский` were falsely rejected.

All four word-oriented policy branches—contact applications/stems, review requests, regulated/after-sales stems, and bundle/gift claims—now share one Unicode left-boundary constructor: start of text or a preceding non-letter/non-number. URL, `www`, email, and phone patterns remain separate and unchanged. JavaScript and PostgreSQL use equivalent native regex syntax, so prohibited contact/review/certification/warranty/bundle phrases still reject while `Бесконтактный термометр`, `Теплообменник`, `безотзывный механизм`, and `немедицинский прибор` remain valid.

`checkGeneratedAsset` now performs an O(1) outer preflight before any image normalization, decoding, or hashing. It requires a plain input/generated/profile/scope shape, 1–7 references, 1–256 facts, valid profile identity/version, model, template, correlation/request keys, `textRequired`, and the checker-gateway port. Oversized evidence returns retryable `CHECKER_UNAVAILABLE`; the pure evaluator retains its independent closed-contract validation as defense in depth.

### Round 5 TDD and final verification

- Combined JavaScript RED: 54 tests; 52 passed and 2 expected failures reproduced the legitimate contact-word false positive and decode-before-cardinality behavior. The identical rich-content/result-checker set reached 54/54.
- Adjacent image/result-checker/rich/repository reached 115/115.
- Systematic word-policy RED: 41 tests; 38 passed and the three legal compound cases failed. The identical rich-content suite reached 41/41, and adjacent image/result-checker/rich/repository reached 118/118.
- Initial SQL contact-boundary RED was 18/19; systematic four-branch SQL RED was 19/20. Static migration GREEN is 20/20; the migration-focused entry set was 20 passed with 1 explicit PostgreSQL skip.
- Final focused image/result-checker/rich/repository/migration set, including the gated-fixture entry file: 139 passed, 0 failed, 0 skipped.
- Auto-listing: 322 total; 320 passed, 0 failed, 2 dedicated-database skips.
- AI: 65 total; 64 passed, 0 failed, 1 dedicated-database skip.
- Migration contracts: 45 total; 42 passed, 0 failed, 3 dedicated-database skips.
- Selected historical permission, persistence, formal-store, account-store, category/listing, and warehouse boundaries: 42 passed, 0 failed.
- Whole `server/tests/*.test.mjs`: 1,038 total; 1,032 passed, 0 failed, 6 configured skips.
- Raw `server/tests/*.mjs`: 1,053 total; 1,045 passed, 1 failed, 7 skipped. The sole failure remains the pre-existing `account-scoped-collection-migration.integration.mjs` environment gate because `SONLI_MIGRATION_TEST_DATABASE_URL` is absent.
- Production Vite build passed for 4,833 transformed modules with only the existing greater-than-500-kB chunk warning. All ten changed JavaScript/module syntax checks and `git diff --check` passed.

The PostgreSQL behavior fixture remains unexecuted because both `AUTO_LISTING_POSTGRES_TESTS=1` and a dedicated `SONLI_MIGRATION_TEST_DATABASE_URL` are absent. Its fifth-round cases cover the four legitimate compound words alongside all retained prohibited policy phrases, but they are not reported as executed. No real gateway, Ozon, storage, source-download, production-database, or production-data operation ran. The feature remains disabled and unwired.

Round-5 changes remain uncommitted. Application rollback is to revert the eventual scoped repair commit while keeping the feature disabled. If migration 031 has been applied, preserve immutable audit rows and replace functions/constraints through a reviewed forward migration; do not destructively roll back schema or data.

### Independent review result

The fifth independent read-only reviewer returned **PASS** with 0 Critical, 0 Important, and 0 Minor findings. Its independent focused set passed 138/138 and additionally confirmed four legal compound words, 29 prohibited policy samples, equivalent JavaScript/PostgreSQL word-boundary structure, unchanged URL/email/phone rules, and pre-decode rejection of 8 references or 257 facts. The reviewer made no file changes.

This PASS covers the available code, tests, and static migration contract. It does not convert the unavailable PostgreSQL behavior fixture into executed evidence: the explicit opt-in and dedicated disposable database URL remain absent.

Status after round 5: independently reviewed PASS within the available environment. Task 5 remains disabled/unwired, and PostgreSQL behavior execution remains an explicitly documented deployment gate.
