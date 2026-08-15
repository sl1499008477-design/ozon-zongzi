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
