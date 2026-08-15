# SDD ledger — plan: docs/superpowers/plans/2026-08-14-auto-listing-category-strategy-sampling.md

Workspace: /Users/songliang/Documents/sonli ozon3.0/.worktrees/auto-listing-configurable-skeleton
Branch: codex/auto-listing-configurable-skeleton
Plan commit: c019325

Pre-flight amendment: d3d3f2a (account-scoped rollout settings contract and exact existing strategy table name)
Baseline: 116/116 focused tests pass, 0 skip
Plan conflict scan: clean after amendment
Task 1: review found Important — sample image DTO lacks MAIN/DETAIL role and stable ordinal contract
Task 1: minor (deferred): add a real oversized-array regression case
Task 1: minor (deferred): directly assert caller remains unfrozen/unaliased and each dangerous own key is rejected
Task 1: fix round 1/5 (1 addressed, 0 open — image role/order contract; commit bb977e1..b947f54)
Task 1: complete (commits d3d3f2a..b947f54, review clean)
Task 2: review found C1 sample-set aggregate remains appendable after hash/analysis/publication
Task 2: review found C2 direct draft delete cascades immutable published evidence/audit
Task 2: review found I1-I6 session lifetime, sample cardinality/shape, publication lineage, settings idempotency, actor tenant, and provenance schema gaps
Task 2: minor (deferred): expand static/PG tests from representative rows into complete table-driven invariant matrix
Task 2: fix round 1/5 (8 addressed, 1 open — new N1 sample-set hash omits provenance/content hashes; commits 7907300..640dee2)
Task 2: fix round 2/5 (0 addressed, 1 open — N1 canonical capturedAt omits BC/AD era and remains ambiguous; commits 640dee2..5374a40)
Task 2: fix round 3/5 (1 addressed, 0 open — era-safe canonical capturedAt; commits 5374a40..97f5d7b)
Task 2: complete (commits b947f54..97f5d7b, review clean)
Task 3: scope amendment — include server/tests/auto-listing-ai-admin-postgres.test.mjs because its exact repository-method contract is directly changed by planned publish/rollback methods; production scope unchanged
Task 3: brief amendment — commitSampleSet requires sessionSecretHash because Step 3 mandates stored-session-secret verification; illustrative API list omitted it; raw secret remains forbidden
Task 3: review found I1 publish/rollback and category commands do not share account-wide idempotency namespace
Task 3: review found I2 admin publish/rollback canonicalize before descriptor-safe exact-key validation
Task 3: review found I3 cancelled session changes historical start-session replay result
Task 3: fix round 1/5 (3 addressed, 0 open — account-wide idempotency, descriptor-safe admin DTOs, immutable session replay; commits 009de79..9649f9d)
Task 3: complete (commits 97f5d7b..9649f9d, review clean)
Task 4: brief amendment — add deterministic object ownership manifest protocol within planned sample-store/object-storage files; only DONE manifests are reusable, failed PREPARING owners clean only creator-tagged objects
Task 4: review found C1 cleanup/finalize/late-PUT race can delete DONE references or leave owner-created orphans
Task 4: review found I1 storage boundary accepts keys above the binding 1024-character limit
Task 4: review found I2 expected-hash and owned cleanup use verify-then-unconditional-delete TOCTOU
Task 4: minor (deferred unless naturally closed in fix): timeout fixture does not exercise the real timer/AbortSignal path
Task 4: fix round 1/5 (4 addressed, 0 open — permanent ABORTED owner/generation fencing, exact 1024-byte boundary, immutable-version conditional cleanup including null-version fail-closed retention, real timer/AbortSignal; commits 7963b55..262a20a)
Task 4: complete (commits 9649f9d..262a20a, final scoped re-review C0/I0/M0, review clean)
Task 5: scope amendment — add Task 3 repository `commitSampleSetCanonical` plus focused PG integration/contract test; it computes the canonical sample-set hash inside the existing atomic BUILDING→SEALED transaction while preserving legacy `commitSampleSet` input behavior
Task 6: scope amendment from Task 5 dependency decision — extension transport/runtime wiring must supply the closed authoritative Ozon page+card facts channel and the minimal server/runtime tests/wiring; Task 5 must not invent an Ozon API or trust arbitrary client card facts and returns exact-facts NOT_READY with zero sample side effects while the port is absent
Task 5: TDD GREEN before formal review — service/routes/runtime/Task3/4 focused 54/54; category PG + adjacent AI admin 57/57; all 0 fail/0 skip
Task 5: recovery hardening — pre-commit sample retry now reuses deterministic sample-set/sample identities; failed extension handoff exact retry reuses the original session/secret identity and clears the explicit raw-secret reference after successful handoff
Task 5: compatibility correction — restored the legacy commitSampleSet concurrent PG case unchanged and added a separate commitSampleSetCanonical DB-hash/replay/conflict proof instead of replacing old coverage
Task 5: authorized race fix — Task 3 draft/session/legacy+canonical sample and AI-admin publish/rollback now serialize account lock → exact replay → locked REQUIRE_EXACT_STRATEGY gate → mutation; service early read only avoids external work and never substitutes for the atomic gate
Task 5: retained-object boundary — if rollout disables after Task 4 DONE but before Task 3 commit, zero new DB evidence/ordinary collect/AI/publish is guaranteed while deterministic DONE evidence is retained for exact replay or authoritative reconciliation/GC rather than unsafe deletion
Task 5: review round 1/5 found C0/I2/M2 (session-before-side-effects and durable replay/rollout races; publication DTO and replay cache); all Important findings and publication DTO fixed with fresh PG concurrency coverage
Task 5: review round 2/5 found C0/I0/M1 and Ready Yes; sole Minor unbounded successful replay cache fixed by a shared 30-minute settled-entry TTL with RED/GREEN durable replay proof
Task 5: review round 3/5 found C0/I1/M0 (failed session handoff retry retained settled state/old TTL); RED/GREEN reset every retry to in-flight and anchor TTL at settlement, including retry-held-across-TTL single-flight proof
Task 5: final review C0/I0/M0, Ready Yes
Task 5: final verification — pure focused 96/96; disposable PostgreSQL category+AI-admin 7/7; syntax and diff checks clean; no external calls or production side effects
Task 5: complete (commit ef1e738, final scoped re-review C0/I0/M0, review clean)
Task 5: owner rejected the prior review and required a fresh full review of 262a20a..ef1e738
Task 5: fresh review found C1/I3/M0 — real AI-admin publication DTO commits then projects 500; default session handoff falsely succeeds without a consumer; canonical first-sample scope reads hostile carrier; durable replay pre-reads sampleSetId accessor
Task 5: fix round 1/5 RED/GREEN — safe real publication DTO adapter + real AI-admin/PG first/replay proof; pre-DB session handoff readiness/default route NOT_READY; descriptor-first canonical sample scope; durable replay projector owns sampleSetId validation
Task 5: fix-round verification — pure 100 pass (1 explicit DB opt-in skip subsequently exercised); disposable PostgreSQL 8/8; syntax/diff clean; awaiting fresh re-review and additive commit
Task 5: fresh fix-round re-review C0/I0/M0, Spec PASS, Quality PASS, Ready Yes; reviewer independent pure 118 pass + 1 expected PG skip and disposable PostgreSQL 8/8
Task 5: final complete (commits ef1e738 + 75e439c, fresh scoped re-review C0/I0/M0, worktree clean)
Task 6: scope amendment — add only the Task 5 server/runtime/route wiring needed for an authenticated closed extension session/facts channel; captured Ozon facts are independently reprojected and cross-checked, not treated as a cryptographic Ozon signature
Task 6: release amendment — minimum and published extension version is 0.13.46.3; 0.13.46.2 is rejected before readiness/session writes and its old artifact remains preserved
Task 6: multi-session amendment — server state keys exact accountId+sessionId, page facts key exact tabId+sessionId, extension session storage keys exact accountId+sessionId; URL carries opaque sessionId only and never sessionSecret
Task 6: first formal review found C2/I5/M1 — completed-session resurrection; new page START selection loss; admin downgrade; reused card and SPA lifecycle; page fact restart/tab isolation; account-only overwrite; concurrent selection loss; hidden feedback; stale release artifact
Task 6: fix round 1/5 — all nine findings received RED/GREEN fixes; old-version confirm/cancel and actionable SPA/card error propagation received additional RED/GREEN coverage; latest focused suite 66/66, final package regenerated, second fresh read-only review pending
Task 6: fresh review round 2/5 — C0/I0/M2, Spec PASS, Quality PASS, Ready Yes for single-process/sticky deployment; documented non-distributed process-local channel and non-cryptographic captured-facts trust boundary
Task 6: complete — commit 5ad83bf; final focused 66/66, syntax/diff/source/unpacked/ZIP/release parity clean; 0.13.46.2 artifact preserved
Task 7: authorized schema amendment — preserve 075 and add forward-only 076 AI/MANUAL immutable result provenance, exact scope/base-attempt FKs, one-AI partial uniqueness and parent-only cleanup semantics
Task 7: TDD GREEN before review — analyzer/runtime/service adjacent non-PG 91 total, 90 pass, 0 fail, 1 expected PG gate skip; disposable PostgreSQL migration/repository/publication/fresh-upgrade 17/17
Task 7: formal review round 1 found C1/I4 — frozen adapter execution identity, deterministic AI failure recovery, durable replay before current external config, exact final result publication and aggregate image budget
Task 7: fix round 1/5 — all findings RED/GREEN; 64 MiB request budget, only response-unknown pending, durable result replay independent of current profile/adapter/storage, event-bound draftVersion+resultId publication
Task 7: final fresh read-only review C0/I0, APPROVED; reviewer independent 89 tests, 85 pass, 0 fail, 4 expected PG gate skips; syntax/diff clean
Task 7: complete — commit e067f20; final non-PG 90 pass + 1 expected gate skip, disposable PostgreSQL 17/17, worktree clean, temporary PostgreSQL stopped
Task 8: scoped brief complete — exact planned 4 production + 4 test files; no migration, UI/API, Task 1–7 contract or adjacent production amendment
Task 8: meaningful RED — initial focused 62 total/53 pass/9 fail; hardening 53 total/51 pass/2 fail; V1 compatibility 14 total/13 pass/1 fail
Task 8: implementer GREEN — final focused 78/78 and fixed-skeleton/dynamic-count/Task7 publication adjacent 108/108; all 0 fail/0 skip; syntax and diff checks clean; no real AI/Ozon/object storage/production DB
Task 8: implementation ready for formal read-only review — V2 frozen guidance enters both planner modes; current task counts remain authoritative; category sample references fail closed before image-model work
Task 8: formal review round 1 found C0/I2/M0 — global V2 bounds narrowed legacy V1 success domain; safe reference projection was discarded and did not close final slot/claim prompt carriers
Task 8: fix round 1/5 RED/GREEN — V1 large/deep finite JSON restored while V2 remains bounded; closed generation projection now replaces downstream plan/slot and rejects category sample keys in all model-side carriers with zero model call
Task 8: fix-round verification — focused 80/80; fixed-skeleton/dynamic-count/Task7 publication adjacent 124/124; all 0 fail/0 skip; syntax/diff clean; awaiting scoped re-review
Task 8: scoped re-review round 1 found C0/I1/M0 — original I1/I2 closed; new global 13-slot cap blocked legal multi-visual-group legacy plans
Task 8: fix round 2/5 RED/GREEN — projector preserves per-group 6–13 and aggregate 1,000; 2 groups × 8 slots accepted, 1,001 and hostile carriers remain fail-closed
Task 8: round-2 verification — focused 80/80 and adjacent 124/124, all 0 fail/0 skip; exact 8-file scope, syntax and diff clean; awaiting scoped re-review
Task 8: final scoped re-review — C0/I0/M0, Spec PASS, Quality PASS, Ready Yes; targeted 2x8/1000/1001/per-group/tenant/cross-group/benign/hostile checks all pass
Task 8: complete — commit 55724d4; final focused 80/80, adjacent 124/124, exact 8-file scope, worktree clean
Task 9: scoped brief complete — planned 6 files plus recorded minimal repository and real-PostgreSQL proof amendments; no migration, external call or Web UI change
Task 9: meaningful RED — exact-strategy service/routes 8 total, 0 pass/8 fail before implementation
Task 9: implementer GREEN — planned service/runtime/routes 121/121; disposable PostgreSQL repository/create/race 7/7 and configurable skeleton E2E 6/6, all 0 fail/0 skip; temporary PostgreSQL removed
Task 9: implementation ready for formal read-only review — strict exact V2/typed-V1 gate precedes side effects, safe 409 is closed, continue-create revalidates with new key, and final transaction freezes/rechecks policy/version/rule/scope/store/warehouse/currency/counts
Task 9: formal review round 1 found C0/I2 — raw source carriers crossed the safe boundary and create/publication used an inverted account/strategy lock order
Task 9: fix round 1/5 RED/GREEN — exact closed source/category projection with zero trap execution; account-first create lock order; real two-connection publish/rollback proof with AI staging
Task 9: fix-round verification — planned 122/122; disposable PostgreSQL repository/create/races 7/7 and configurable skeleton E2E 6/6, all 0 fail/0 skip; temporary PostgreSQL removed; awaiting scoped re-review
Task 9: re-review follow-up found source descriptor-proxy, source-path inference and nested strategy-version carrier gaps; each received a focused RED/GREEN closed projection fix
Task 9: latest planned verification 124/124, 0 fail/0 skip; awaiting final re-review verdict
Task 9: final fix-round review C0/I0/M0, Spec PASS, Quality PASS, Ready Yes; reviewer independently verified focused 124/124 and clean syntax/diff
Task 10: scoped brief complete, then amended with minimum adjacent Task 5 durable detail + hash-verified thumbnail read required for reload/deep-link correctness; no schema or external-call expansion
Task 10: meaningful UI RED 27 total/20 pass/7 fail; backend durable-read RED proved summary-only detail and missing thumbnail command
Task 10: implementer GREEN — focused Task 10/Task 5/Task 9 66/66; full relevant 452 total/449 pass/1 environment-only Chrome SIGABRT/2 explicit PG gate skips; Vite production build and syntax/diff checks pass
Task 10: real ego-browser acceptance against Vite + loopback fake API — initial and reload show 5 persisted sample cards, MANUAL analysis and v2 history, zero visible internal-field leak and no horizontal overflow; screenshot CDP timed out and is recorded honestly
Task 10: formal review round 1 found C2/I2 — protected image requests lacked Bearer transport; paid/write response loss minted new identities; same-route query selection did not reload; resume had no expiry/current-source-version gate
Task 10: fix round 1/5 RED/GREEN — authenticated bounded WebP blob/revoke transport; durable account-scoped logical command intents; observed locationSearch; 24-hour resume plus exact current collect draftVersion fail-closed cleanup
Task 10: disposable tmpfs PostgreSQL 16 applied migrations 001–076 and production read/service integration passed 1/1, 0 skip; real run found/fixed UTC exact-ISO session/edit timestamps; cross-account detail/thumbnail and object hash identity verified
Task 10: latest focused 117/117; full relevant 458 total/454 pass/1 existing Chrome SIGABRT/3 explicit PG gates; Vite 4,848-module production build pass
Task 10: Browser plugin acceptance after reload — 5 sample cards and 5 authenticated blob thumbnails loaded, MANUAL/history visible, zero raw-key leak; two screenshot files saved after ego CDP screenshot timeout
Task 10: formal review round 2 verified all round-1 fixes and found two state-closure issues: immutable PUBLISHED draft had no successor action, and durable detail could pair current samples with stale analysis
Task 10: fix round 2/5 RED/GREEN — published detail creates a same-scope successor with source/version authority and durable identity; read analysis binds latest sealed sample set and UI publish requires exact DRAFT_READY/current draft version
Task 10: latest focused 119/119; full relevant 460 total/456 pass/1 existing Chrome SIGABRT/3 explicit PG gates; fresh tmpfs PostgreSQL 16 read path 1/1, 0 skip; Vite 4,848-module build pass
Task 10: formal review round 3 verified round-2 state fixes and found created-draft response was incorrectly passed through the new source-bearing detail projector after the backend write
Task 10: fix round 3/5 RED/GREEN — executable client create-response test plus dedicated closed five-field projection; latest focused 120/120, full relevant 461 total/457 pass/1 existing Chrome SIGABRT/3 PG gates, Vite build pass
Task 10: formal review round 4 verified created-draft fix and found browser Back/menu to the list URL retained the old detail bundle
Task 10: fix round 4/5 RED/GREEN — empty authoritative draft clears detail state/form and request generation prevents stale async loads restoring it; focused 121/121 and Vite build pass
Task 10: final full relevant verification after round-4 fix — 462 total/458 pass/1 existing Chrome SIGABRT/3 explicit PG gates
Task 10: round-5 checkpoint hardened fail-closed navigation — clear before failed list reads, generation-guard successor follow-up, and account-switch render gate/cleanup; focused remains 121/121
Task 10: round-5 complete action hardening — sampling/create/analysis/edit/publish/rollback settle confirmed intents but suppress every stale UI/open/load/navigation/error follow-up after route/account change; focused 122/122
Task 10: final formal review round 5 READY with C0/I0; reviewer independently verified 116 pass/0 fail/1 explicit PG gate skip and clean diff
Task 11: plan amendment — current latest migration is forward-only 076 (001–076), not outdated 075; minimum/published extension is 0.13.46.3; production account mode remains default LEGACY_FALLBACK and only explicit REQUIRE_EXACT_STRATEGY enables the strict gate
Task 11: scoped brief complete — real loopback composition must traverse production runtime/routes/service/repositories with fake Ozon/facts, paid AI and object storage, preserve the Task 6 single-process/sticky channel constraint, and never use direct SQL to advance the main workflow after authoritative fixture setup
Task 11: scope amendment — add a focused closed observability module/test and narrowly wire both category-strategy and auto-listing service/runtime boundaries, because required/continue metrics occur in the Task 9 create path and cannot be truthfully emitted by the category administration service alone
Task 11: meaningful RED/GREEN — observability missing-module RED then 3/3; service observations RED then adjacent 94/94; runtime injection RED then 35/35; E2E delivery script RED then fresh disposable PostgreSQL 16.14 001–076 real composition 2/2 with 0 skip
Task 11: complete pre-review verification — full Task 1–11 focused category/AI/planner/auto-listing/extension/App set 254/254, runtime/worker/observability 35/35, all 0 fail/0 skip; Vite 4,848-module production build, extension 0.13.46.3 package, syntax and diff checks pass
Task 11: formal review round 1 found C1/I3/M1 — fake create composition, missing direct recovery matrix, skipped canonical env, incomplete Excel/replay observations, unknown-response runbook mismatch, and metric name-only assertions
Task 11: fix round 1/5 RED/GREEN — production HTTP/runtime/service/repository/PG strict+continue composition, complete direct matrix, exact Excel/replay observations, corrected unknown-response recovery, and exact metrics/log assertions
Task 11: concurrent publish RED/GREEN — category service translated AI-admin current-version conflict from generic 503 to stable `AUTO_LISTING_CATEGORY_STRATEGY_PUBLISHED_VERSION_CONFLICT` 409; real two-draft race is one 201/one 409 and one current publication
Task 11: adjacent stale-fixture RED/GREEN — visual-groups helper received required authoritative category/store/currency facts only; production source validation unchanged; 9/9 restored
Task 11: post-fix verification — fresh PG16.14 migrations 001–076 and all related composition/repository suites 27/27, 0 skip; non-PG Task1–11 focused 396/396, 0 skip; Vite 4,848 build; extension 0.13.46.3 parity/package; syntax/diff clean; awaiting scoped re-review
Task 11: scoped re-review follow-up found I2 — refreshed strict success observed the pre-refresh strategy, and hostile replay audit carriers could alter collect/Excel replay before safe DTO projection
Task 11: fix round 2/5 RED/GREEN — refreshed success now observes the exact second gate frozen in the graph; collect/Excel observer on/off use zero-trap optional replay audit projection; focused 4/4; duplicate-SKU coverage attribution corrected
Task 11: re-review operational Minor — runbook now requires a rotated >=16-character observability hash secret plus verified approved metric/log sinks before enablement; secret value must never be printed or recorded
Task 11: final scoped re-review — C0/I0/M0, Spec PASS, Quality PASS, Ready YES; reviewer independently verified 157/157 focused, diff clean, and all original/new findings closed
Task 11: final pre-commit verification — fresh PG16.14 migrations 001–076 related suites 27/27, 0 skip; non-PG focused 398/398, 0 skip; prior fresh Vite 4,848 build and extension 0.13.46.3 parity/package remain valid
Task 11: full-branch review final-fix RED/GREEN — immutable sample revision now validates remove intent then confirms a complete 5–20 replacement into a new SEALED set/hash while retaining the prior set; extension cancel persists ACTIVE→CANCELLED before local cleanup and a fresh repository/service replay cannot resurrect it; Web maps the actual AI-unknown and publication-conflict codes; six fixed observation names now carry bounded revision/cancel/evidence-rejection/rollback outcomes without new metric families
Task 11: final-fix verification — fresh tmpfs PG16 migrations 001–076 successor/cancel repository 3/3 and production composition 2/2; full combined category/AI/planner/auto-listing/extension/App set 393/393, 0 fail/0 skip; Vite 4,848 build, extension 0.13.46.3 source/unpacked parity and package, syntax/diff checks pass
Task 11: final full-branch review from b947f54 — C0/I0, Spec PASS, Quality PASS, Ready YES; the sole Minor test-gap was closed by pinning durable `category-sample-revision` and remove→start→settle order, page contract 10/10; final all-gates fresh-PG combined suite 394/394, 0 fail/0 skip
