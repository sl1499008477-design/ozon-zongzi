# SDD ledger — plan: docs/superpowers/plans/2026-07-28-ozon-category-query-extraction.md

Execution mode: in-place dirty `main`, explicitly approved by user; no branch, commit, staging, push, stash, or destructive Git.
Review mode: pre/post task file snapshots and scoped unified diffs because commits are forbidden.
Baseline commit: d4ed427992e9e159d657197fd7bad07b4c2f6f8c
Risk: R2 shared category-query contract; exact design and implementation approval recorded on 2026-07-28.
External effects forbidden: no real Ozon calls, no production writes, no migrations, no dependency/config/deployment changes.
Pre-flight plan ruling: user selected real behavior tests. App and extension readiness use executable helper modules, not source-text-only tests.

Task 1: fix round 1/5 (2 addressed, 0 open — added 3 omitted recovery snapshots; corrected Node runtime wording; no commits)
Task 1: complete (no commits; review clean)
- Baseline: 180 dirty entries, `server/index.mjs` 5380 lines.
- Narrow baseline: 7/7 commands passed.
- Full baseline: 97 tests passed, 0 failed; all 19 verification checks passed.
- Recovery: 9 existing target files have byte-identical ignored snapshots with SHA-256/cmp evidence.
- Environment: local `sonli-postgres` restored to stopped; no real Ozon call.

Task 2: fix round 1/5 (4 addressed, 0 open — TTL cap, collision-proof scope key, stale-on-error test, nested clone test; no commits)
Task 2: complete (no commits; review clean)
- Delivered: real-Ozon tree/attribute service, scoped six-hour TTL cache, provenance metadata and type-to-category resolution.
- Safety: fixed-message errors, `cause: null`, no raw response/credential/local-product dependency.
- Validation: service syntax, category service tests and Ozon client tests passed.
- Deferred by plan: dictionary values remain explicitly fail-closed until Task 3.

Task 3: fix round 1/5 (1 addressed, 0 open — validate positive/non-repeated continuation cursor before a safe-limit stop; no commits)
Task 3: complete (no commits; review clean)
- Delivered: atomic dictionary pagination, mixed response-shape normalization, stable deduplication and scoped caching.
- Safety: total limit clamped to 1..5000, page limit capped at 1000, malformed/repeated cursors fail closed, no partial/stale cache on failure.
- Validation: service syntax, category service tests, Ozon client tests and whitespace checks passed; cap-boundary cursor regressions independently rechecked.
- Deferred by plan: authenticated HTTP route wiring remains Task 4.

Task 4: fix round 1/5 (2 addressed, 0 open — safe error allowlist/status/message; post-resolution auth/store revalidation; no commits)
Task 4: fix round 2/5 (1 addressed, 0 open — explicit session-revocation coverage for attributes and values; no commits)
Task 4: complete (no commits; final review clean)
- Delivered: isolated authenticated route handler for tree, attributes and dictionary values with additive provenance metadata.
- Safety: exact route matching, backend auth and store ownership checks, post-await revalidation, fixed non-2xx safe error mapping.
- Validation: route syntax, route tests, category service regression and whitespace checks passed; final independent review found no Critical/Important issue.
- Deferred by plan: `server/index.mjs` wiring and preview/listing fail-closed integration remain later tasks.

Task 5: fix round 1/5 (2 addressed, 0 open — preserve stable dictionary/category errors; prove final submission boundary remains untouched; no commits)
Task 5: complete (no commits; final review clean)
- Delivered: one shared category service wired into preview/final normalization, strict required-dictionary failure and safe category error propagation.
- Compatibility: restored existing `!!body.strictTypeMatch`; unrelated non-category failures keep their prior warning behavior.
- Safety: final preparation tests prove category failures occur while `createSubmissionV3`, local jobs and external writes remain at zero.
- Validation: readiness, preview, currency, listing-failure, external-write, normalizer regressions, syntax and whitespace checks passed.
- Deferred by plan: replacement of the still-inline category HTTP routes and local-product fallback remains Task 6.

Task 6: complete (no commits; independent review approved)
- Delivered: one entry-level Task 4 handler using the Task 5 shared service; removed the entire legacy inline category boundary.
- Safety: local synced products can no longer supply tree/category IDs; Ozon failure is a stable non-2xx result for tree, attributes and values.
- Validation: syntax, route, real-entry cache isolation, account/store isolation, store isolation and boundary searches passed.
- Scope: 11 index additions and 256 legacy-category deletions only; no collection, AI, preview, listing, DB, audit, job or permission change.
- Deferred by plan: app and extension fail-closed interaction states remain Tasks 7 and 8.

Task 7: fix round 1/5 (3 addressed, 0 open — late auto-match token guard, store-scoped trees, retry error retention; no commits)
Task 7: fix round 2/5 (1 addressed, 0 open — strict current/local/item store-ID scope for all item fallbacks/actions; no commits)
Task 7: fix round 3/5 (1 addressed, 0 open — extract category-tree React hook and restore the existing App line guard; no commits)
Task 7: complete (no commits; final review clean)
- Delivered: executable app readiness helper, dual-language real-tree loader, visible retryable error and category action gates.
- Safety: stale requests, trees, preview data and item fallbacks cannot cross store/item scope; draft/preview/publish/auto-match fail before API in transition.
- Structure: focused `use-category-tree-readiness.js`; `App.jsx` is 9849 physical lines / 9850 split lines and passes the unchanged guard.
- Validation: hook 1/1, helper 8/8, prototype style contract 15/15, syntax, offline Vite build, module boundary and snapshot/whitespace checks passed.
- Unverified by scope: manual browser interaction and real Ozon credentials.
- Deferred by plan: extension wizard fail-closed behavior remains Task 8.

Task 8: fix round 1/5 (2 addressed, 0 open — immutable action scope and real-data draft revalidation; no commits)
Task 8: fix round 2/5 (1 addressed, 0 open — store/tree/request-scoped automatic matching and empty-store invalidation; no commits)
Task 8: complete (no commits; final review clean)
- Delivered: dependency-free extension readiness owner, explicit tree/attribute failure states and all category-dependent action gates.
- Safety: stale pipeline, restored draft, tree, attribute and AI suggestion responses cannot cross store/category/tree/request scope or reach `followSell`.
- Validation: helper/extension regressions, source parity, exact diff contract, offline packaging, two 94-file ZIP byte-parity checks and packaged smoke passed.
- Unverified by scope: real browser interaction and real Ozon credentials.
- Deferred by plan: permanent module-boundary guards and architecture records remain Task 9.

Task 9: complete (no commits; independent review approved)
- Delivered: permanent legacy-category declaration/inference guards and current architecture ownership records.
- Guardrails: server entry 5183 physical lines / 5184 split lines under 5200; App guard unchanged at 9850 with current split count 9850.
- Documentation: design status is “已实施，待完整验证”; no premature Task 10 completion claim.
- Validation: module-boundary test, service/route/entry syntax, no-match legacy scan and whitespace checks passed.
- Deferred by plan: complete regression, AGENTS.md review, recovery handoff and final independent release decision remain Task 10.

Task 10: validation and handoff complete; final independent review pending (no commits)
- Targeted regression: all 14 changed-module commands passed; app readiness 8/8 and prototype style contract 15/15.
- Protected behavior: sync service, sync leases, account/store ownership, external-write safety and operating-store isolation passed.
- Full gate: fresh `scripts/verify.mjs` run passed all 19 checks with 110 tests passed / 0 failed after tightening the collect-edit source contract for the new store and category readiness gates.
- Scope: 10 newly visible status entries versus the recorded 180-entry dirty baseline, exactly one modified wizard plus nine new category modules/tests; no staged files and no attributable dependency, migration, database, config or deployment drift.
- External effects: no real Ozon or production/data write; local `sonli-postgres` restored to stopped.
- Persistent handoff: design status and Task 10 results updated; `final-report.md` records validation, unverified scope and recovery.

Task 10: final review fix round 1/5 opened (0 addressed, 3 open; no commits)
- Important: preserve numeric category ID success-contract compatibility.
- Important: reject invalid IDs before Ozon and return stable 422 when a real tree has no requested type.
- Important: app dictionary failures must be visible, retryable, request-scoped and included in preview/listing readiness.
- Design status and final handoff were returned to an in-progress state until focused regression, full verification and scoped re-review pass.

Task 10: fix round 1/5 scoped re-review (2 addressed, 1 open; no commits)
- ADDRESSED: numeric category ID success-contract compatibility.
- ADDRESSED: invalid IDs fail before Ozon and missing real-tree type returns stable 422.
- NOT ADDRESSED: dictionary failure/loading/retry and stale scope now gate app
  actions, but the App response adapter still converted malformed 2xx
  responses with neither `items` nor `data` arrays into an authentic empty
  result. Fix round 2 must distinguish explicit empty arrays from malformed
  success responses with an executable adapter test.

Task 10: fix round 2/5 (1 addressed, 0 open; no commits)
- ADDRESSED: the tested dictionary response adapter accepts only explicit
  `items`/`data` arrays; malformed 2xx and non-array controller results now
  fail closed while authentic empty arrays remain ready.
- Validation: dictionary 5/5, category readiness 9/9, tree hook 1/1,
  prototype style 15/15, collect-edit contract, module boundary, offline
  build and scoped diff checks passed.
- Final scoped independent review: `Ready: Yes`, `Critical: 0`, `Important: 0`.

Task 10: complete (no commits; final review approved)
- Delivered: real-Ozon-only category service/routes, numeric compatible IDs,
  safe 400/422/5xx errors, no local-product fallback and complete backend/app/
  extension fail-closed readiness.
- Full gate: fresh post-review `scripts/verify.mjs` passed all 19 checks with
  78 active test files and 116 tests passed / 0 failed / 0 skipped.
- Guardrails: server entry 5183; service 296; routes 164; App 9838 physical /
  9839 split; dictionary hook 224; all module guards passed.
- Scope: 191 dirty entries versus the recorded 180-entry baseline; 11 newly
  visible status entries exactly one modified wizard plus ten new category
  implementation/test modules; Git index empty and no attributable dependency,
  migration, database, config or deployment drift.
- External effects: no real Ozon, production or business-data write; local
  `sonli-postgres` restored to `Exited (0)`.
- Persistent handoff: design is `已实施并通过完整验证`; plan Step 7, final
  results, AGENTS.md review, unverified scope and rollback are current.
