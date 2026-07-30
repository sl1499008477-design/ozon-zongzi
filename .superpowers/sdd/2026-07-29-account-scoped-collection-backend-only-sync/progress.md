# SDD ledger — plan: docs/superpowers/plans/2026-07-29-account-scoped-collection-backend-only-sync.md

Merge base: ccf9c7c
Branch: codex/account-scoped-collection
Worktree: /Users/songliang/Documents/sonli ozon3.0/.worktrees/account-scoped-collection
Preflight ruling: user approved replacing source-text/change-detector tests with behavior or integration tests; source scans remain supplemental only.
Baseline: app build passed; 188/189 active tests initially passed.
Baseline: installed declared desktop dependencies; the only failing active test (`desktop/tests/parse-modern-ozon.test.mjs`, missing cheerio) then passed 1/1.
Baseline environment blockers: QH_SOURCE_EXTENSION_DIR missing for three upstream parity gates; Docker compose variables such as MINIO_ACCESS_KEY missing.
Task 1 ruling: migration 019 must preserve the existing collect-request idempotency index because current runtime still targets it; add the new index now, switch runtime in Task 4, and defer compatibility-index removal to a separately reviewed later migration.
Task 1 review: deferred minor — four-column request index should be independently verified via PostgreSQL catalog rather than relying on duplicate rejection.
Task 1 review: deferred minor — add parent-session-leading indexes if final review confirms logout cleanup scale requires them.
Task 1 sequencing ruling: Task 1 proves nullable database scope; the real collection entry point is changed and tested in Task 4 with the account/idempotency contract, avoiding a partial out-of-scope runtime change.
Task 1: fix round 1/5 (4 addressed, 0 open — ownership consistency, composite parent session ownership, task sequencing, account deletion compatibility; commits 158c921..5ff3030)
Task 1: complete (commits 3d0f15e..5ff3030, review clean)
Task 2 review: deferred minor — repository/formal mirror should fail closed unless permissions are exactly the three collector permissions; final review must triage.
Task 2: fix round 1/5 (2 addressed, 1 new Important open — mandatory expiry fail-closed and parent bearer free-text redaction fixed; JSON auth time regression introduced; commits c1189e8..8cc5156)
Task 2: fix round 2/5 (1 addressed, 0 open — JSON session auth now binds caller time; commits 8cc5156..256d33a)
Task 2: complete (commits 68e9df9..256d33a, review clean; one deferred minor)
Task 3 review: deferred minor — audit entity IDs are currently derived from credential-hash prefixes; final review must require independent IDs or omission and assert no partial digest is serialized.
Task 3: fix round 1/5 implemented (2 addressed, re-review pending — shared JSON load/mutate/save transaction boundary and retryable PostgreSQL initialization; commit 6f3d39c).
Task 3: fix round 1/5 re-review (I2 closed; I1 remains open because legacy import polling and object-cleanup background writers bypass the shared JSON transaction boundary; 0 new Important).
Task 3: fix round 2/5 opened (1 Important — route every background JSON load/mutate/save cycle through the same boundary and add deterministic background-writer interleaving coverage).
Task 3: fix round 2/5 implemented (1 addressed, re-review pending — object cleanup and legacy import polling now share the JSON transaction boundary; commit 1291295).
Task 3: complete (commits 39efc1e..1291295; I1/I2 closed after two fix rounds; review clean; one deferred minor).
Task 4 review: fix round 1/5 opened (2 Important — reject forbidden scope fields on batch envelopes in JSON and PostgreSQL routes; project JSON historical store scope only through legacyScope for backend parity).
Task 4: fix round 1/5 implemented (2 addressed, re-review pending — batch envelope validation and shared public legacyScope projection; commit f2bea55).
Task 4: fix round 1/5 re-review (I1 closed; I2 remains open because JSON public projection still exposes createdBy and sellerCompanyId while PostgreSQL strips them; 1 new Important).
Task 4: fix round 2/5 opened (1 Important — remove createdBy/sellerCompanyId from every JSON public collection-item response and prove PostgreSQL parity).
Task 4: fix round 2/5 implemented (1 addressed, re-review pending — public projection hides createdBy/sellerCompanyId while persistence retains audit data; commit c89e75f).
Task 4: complete (commits 5b00399..c89e75f; batch-scope and JSON/PG public-shape gaps closed after two fix rounds; review clean).
Task 5 review: fix round 1/5 opened (4 Important — make Web readiness/warehouses target-store scoped; serialize before draft mirroring to avoid concurrent replay deadlock; replay existing frozen jobs before revalidating current store usability; retain a stable Web idempotency key across uncertain retries).
Task 5: fix round 1/5 implemented (4 addressed, re-review pending — target-scoped Web model/warehouse ownership, deadlock-free locked replay, replay-before-validation, stable Web intent keys; commit 9494981).
Task 5: fix round 1/5 re-review (I1/I2 closed; I3 remains open for HTTP replay after store unlink because local existence validation precedes DB replay; I4 remains open because HTTP 5xx is incorrectly treated as definitive and clears the Web key; 0 new Important).
Task 5: fix round 2/5 opened (2 Important — DB replay before local store existence checks, including unlinked stores; preserve Web key for 5xx/unknown server outcomes).
Task 5: fix round 2/5 implemented (2 addressed, re-review pending — unlinked-store HTTP replay before local checks and conservative uncertain-error key retention; commit f99207e).
Task 5: complete (commits 3772fc6..f99207e; four original and two remaining review findings closed after two fix rounds; review clean).
Task 6 review: deferred minor — collector desktop PostgreSQL integration is not hermetic on a truly empty database because pricing bootstrap skips the global default when any foreign version exists.
Task 6: fix round 1/5 opened (3 Important — recursive retired-scope sanitization across all desktop/server/selection/export/Excel/public boundaries; persist seller analytics by account+sourceIdentity; derive legacyScope server-side from trusted history columns with a consistent whitelist).
Task 6: fix round 1/5 implemented (3 addressed, re-review pending — shared recursive sanitizer, account+sourceIdentity analytics identity, trusted legacyScope projection; commit c0961ba).
Task 6: fix round 1/5 re-review (I2/I3 closed; I1 remains open for currentDataCollectionStoreId(s) key variants and Excel JSON-string parse order; 1 new Important — public collection projection deletes legitimate listingDraft.targetStore.clientId; deferred M1 unchanged).
Task 6: fix round 2/5 opened (2 Important — complete retired-scope key coverage and sanitize after Excel JSON parsing; scope collector-stage sanitization so listing target metadata clientId remains public).
Task 6: fix round 2/5 implemented (2 addressed, re-review pending — canonical current/plural key coverage, Excel parse-then-sanitize, path-sensitive public clientId preservation; commit c805004).
Task 6: fix round 2/5 re-review (I1 closed; I4 remains open only in updateCollectItemDraftV4 immediate response because raw listingDraft overwrites the sanitized projection; deferred M1 unchanged).
Task 6: fix round 3/5 opened (1 Important — return the sanitized persisted draft projection without reintroducing raw source clientId).
Task 6: fix round 3/5 implemented (1 addressed, re-review pending — immediate update response now uses the sanitized persisted draft projection; commit ccb0aff).
Task 6: complete (commits 42fb02f..ccb0aff; all Important findings closed after three fix rounds; review clean; pricing-bootstrap test hermeticity remains deferred Minor M1).
Task 7: implementation complete, review pending (backend-only Web sync coordinator, per-type retry/state, structured sanitized backend results; commit f2479e5).
Task 7: fix round 1/5 opened (3 Important — render per-type success counts/failure reasons; namespace server sync identities and make client IDs scoped idempotency keys; preserve full sanitized context when initial report persistence fails).
Task 7: fix round 1/5 implemented (3 addressed, re-review pending — rendered per-type details, server-authoritative scoped sync identity/replay, contextual persistence-failure contract; commit 73708ee).
Task 7: fix round 1/5 re-review (I1-I3 closed; 1 new Important — replay lookup and RUNNING persistence are not an atomic claim, so concurrent identical requests duplicate Ozon calls).
Task 7: fix round 2/5 opened (1 Important — serialize/atomically claim each scoped sync idempotency key and make concurrent callers await/replay the same terminal result).
Task 7: fix round 2/5 implemented (1 addressed for a single service process, re-review pending — in-process single-flight exact concurrent success/failure replay; commit f91ad7d; multi-process PostgreSQL claim explicitly unverified).
Task 7: complete (commits f2479e5..f91ad7d; all Important findings closed after two fix rounds; review clean under documented single-writer deployment; PostgreSQL claim required before horizontal API scaling).
Task 8: implementation complete, review pending (collector ticket exchange, session-only token storage, account-bound upload queue, popup Web-login-only flow; commit 729f0f4).
Task 8 review: deferred minor — remove dead reverse-Web-localStorage cleanup helper when the fix touches the same service-worker area or final cleanup confirms no caller.
Task 8: fix round 1/5 opened (6 Important — package collector-session dependencies; deep/canonical retired-scope sanitization at extension and server V4 ingress; account-qualified queue identity; serialized queue mutation; redact error codes; queue 408/429 retryable uploads).
Task 8: fix round 1/5 implemented (6 addressed and same-area dead helper removed, re-review pending — packaged collector dependencies, deep scope defense, account-scoped serialized queue, full redaction, retryable status handling; commit ba2ad66).
Task 8: fix round 1/5 re-review (I1-I6/M1 closed; 1 new Important — account-switch TOCTOU lets an A-started upload/flush use B's mutable current session token or queue ownership).
Task 8: fix round 2/5 opened (1 Important — bind upload/flush authorization and queue ownership to one immutable collector session snapshot and abort on session change).
Task 8: fix round 2/5 implemented (1 addressed, re-review pending — sealed immutable operation snapshots bind authorization and queue ownership across account/session races; commit 765c41c).
Task 8: fix round 2/5 re-review (main I7 races closed; 1 Important remains — session conditional clear uses non-atomic get/compare/remove and an old 401 can delete a successor B or refreshed-A session).
Task 8: fix round 3/5 opened (1 Important — serialize all collector session mutations and make clear/logout snapshot-aware so stale operations cannot remove successor sessions).
Task 8: fix round 3/5 implemented (1 addressed, re-review pending — recoverable session mutation chain and exact snapshot-aware expiry/401/403/logout clearing; commit 776c083).
Task 8: complete (commits 729f0f4..776c083; all Important findings closed after three fix rounds; packaged collector and session-race review clean).
Task 9: implementation complete, review pending (extension store-sync capability/modules/Seller API permission removed; retired server contracts return 410; commit de31b8b).
Task 9: fix round 1/5 opened (2 Important — replace arbitrary credentialed collector-client request/path APIs with fixed allowlisted actions; remove wildcard Ozon host pattern that still matches api-seller and test real Chrome match semantics).
Task 9: fix round 1/5 implemented (2 addressed, re-review pending — fixed collector upload-only API/path/source allowlist and narrow HTTPS Ozon page patterns excluding api-seller; commit e53d9fd).
Task 9: complete (commits de31b8b..e53d9fd; both Important findings closed after one fix round; packaged capability-removal review clean).
Task 10: implementation complete, review pending (runtime data-store APIs/state/UI/blocking rules removed; historical audit/migration storage retained; commit 2280d49).
Task 10 review: deferred minor — ensure the Task 10 implementation report exists at the standard SDD path and records exact verified/unverified scope.
Task 10: fix round 1/5 opened (2 Important — make popup runtime depend only on Collector session, not Web store/Seller cookie; migrate JSON legacy evidence into a read-only archive and route PostgreSQL history access/deletion through explicit account-scoped legacy audit/purge policies).
Task 10: fix round 1/5 implemented (2 addressed and standard sidecar report added, re-review pending — Collector-only popup runtime, JSON idempotent legacy archive, PostgreSQL audited account purge boundary; commit 1edc68f).
Task 10: fix round 1/5 re-review (original I1/I2 and report closed; 1 new Important — account deletion does not remove that account's legacy JSON audit archive, which remains in JSON/PG local_state).
Task 10: fix round 2/5 opened (1 Important — purge only the deleted account's legacy audit archive entries in removeAccountScope and persist/audit counts while preserving other accounts).
Task 10: fix round 2/5 implemented (1 addressed, re-review pending — deleted-account JSON/PG local_state archive purge with A/B preservation and malformed legacy migration hardening; commit 1b23597).
Task 10 review: deferred minor — malformed archive records with no owner and a no-colon/bad-percent archiveKey may be counted under a garbage account key; record stays private and does not retain confirmed-account evidence.
Task 10: complete (commits 2280d49..1b23597; all Important findings closed after two fix rounds; review GO with one deferred malformed-count Minor).
Task 11: implementation complete, independent task review pending (capture-only parity policies and regenerated tracked distribution artifacts; commit 43dcb39).
Task 11: fix round 1/5 opened (1 Important — standalone ZIP smoke/readiness must compare permissions and hosts against an immutable reviewed baseline, not manifest self-reference; 2 Minors — add standard report and package popup runtime/routing tests).
Task 11: fix round 1/5 implemented (1 Important + 2 Minors addressed, re-review pending — immutable reviewed permission/host baseline, adversarial standalone gates, packaged popup runtime/routing, standard sidecars; commit 269e849).
Task 11: complete (commits 43dcb39..269e849; package gates hardened and independently reviewed GO; source/public/dist ZIPs remain exact and capture-only).
Task 6: fix round 2/5 implemented (2 Important addressed, re-review pending — current/plural data-store variants covered across desktop/server/PG; Excel parse-then-sanitize closes JSON-string bypass; public collection uses a narrow listingDraft.targetStore.clientId exception while collector clientId remains removed; Task 5 audit metadata regression passed).
Task 6: fix round 1/5 implemented (3 Important addressed, re-review pending — shared deep sanitizer across desktop/server/JSONB/selection/Excel/public projection; account+sourceIdentity snapshot/category persistence and filtering; caller legacyScope ignored and trusted historical whitelist standardized; disposable PostgreSQL A/B isolation and parity passed; M1 remains deferred test-setup-only).
Task 4: implementation complete pending review (account-scoped store-neutral uploads, four-part idempotency, Collector permission routing, PostgreSQL/JSON parity; focused 6/6, PostgreSQL related 47/47, JSON regression 2/2).
Task 4 verification concern: complete active suite 231/233 assertions passed with 1 skip and 1 environment failure because macOS rejected the bundled Node `sharp` native module Team ID; App Rollup native module, upstream extension directory, and Compose secret gates were also environment-blocked.
Task 4: fix round 1/5 implemented (2 Important addressed, re-review pending — both JSON/PostgreSQL batch envelopes reject all six scope fields before iteration; JSON historical collection responses use the shared PostgreSQL-compatible `legacyScope` mapper).
Task 4: fix round 2/5 implemented (remaining Important addressed, re-review pending — JSON public collection projections now also remove `createdBy` and `sellerCompanyId`, with real local-state/list/create/update/draft coverage and PostgreSQL parity).
Task 12: delivery record complete, whole-branch final review pending (automated root gate passed with 317 total, 316 passed, 0 failed, and 1 general-suite PostgreSQL skip; dedicated disposable PostgreSQL verification passed; isolated zero-store Web collection/listing boundary passed; real-extension browser checks remain explicitly blocked because the target extension was absent from the controlled profile and browser policy blocked extension inspection; browser-discovered defects fixed in 405e519 and 293b8b8).
