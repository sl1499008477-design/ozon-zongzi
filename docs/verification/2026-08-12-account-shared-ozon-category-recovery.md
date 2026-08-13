# Account-shared Ozon category recovery verification

Verified on 2026-08-13 (Asia/Shanghai).

## Tested implementation

- Implementation SHA: `7f5fa7167e3cc94efc13070d4978ad7c6d34128f`
- Supporting production-contract fixes: `c240040` and `48e4fca`
- Migration chain: `001` through `069`
- Production automatic category recovery: disabled; the V1 structured-error policy remains empty

## Passing evidence

- Task 10 production-composition E2E: 4 passed, 0 failed, 0 skipped.
- Adjacent real RFBS worker E2E: 1 passed, 0 failed, 0 skipped. This includes PRE_IMPORT warehouse absence/status/type/response-loss cases and PRE_STOCK/stock-failure cases with exact product-import and stock-call counts.
- Vite production build: 4,843 modules transformed, exit zero. The existing large-chunk warning remains.
- JavaScript syntax checks and changed-range whitespace checks: passed.

The Task 10 E2E used two disposable PostgreSQL 16 databases on loopback ports and a loopback-only fake Ozon transport. It proved the real collection/shared-category repository, auto-listing service and preparer, submission pipeline and worker, category recovery service, retry worker, migration-069 child results, stock continuation, replay idempotency, tenant isolation, destructive migration preflight rollback, and restore/read compatibility. Its only direct recovery seed is a clearly labelled historical terminal error-evidence fixture because the production V1 policy is deliberately empty.

The worker failure matrix used independent jobs. Authentication and throttling failures came from real `/v3/product/import` HTTP responses; brand and currency failures came from real `/v1/product/import/info` item results; stock failure came from a real `/v2/products/stocks` HTTP response after successful product import. All non-category cases created zero category-recovery attempts and zero category-error evidence. The adjacent RFBS suite exercised the production PRE_IMPORT and PRE_STOCK authorization paths. Unknown real Ozon error labels remain unclassified by design and therefore cannot activate category recovery.

## Read-only browser evidence

The real Vite application and real local API were started from the tested worktree on isolated loopback ports, backed by a disposable PostgreSQL schema and safe seeded records. Browser control used the bundled browser client through the Node REPL; external Playwright was not used. No create, save, confirm, retry, AI, product-import, inventory, or stock control was clicked.

Verified visible behavior:

- the auto-listing table showed exactly the latest row for the same source product/store;
- the persisted creation time was `2026-08-12 10:00:00`, not a current-time fallback;
- the store label was `粽子测试店铺`, not an internal identifier;
- the account-shared category column and edit detail used fixed safe Chinese copy with no raw platform text and no retired per-store matching wording;
- the real collection detail route loaded at `/ozon/products/collect/edit/?id=collect-browser-product`.

Local screenshot evidence:

- `.superpowers/sdd/2026-08-12-account-shared-ozon-category-recovery/evidence/task10-real-auto-listing-48e4fca.png`
- `.superpowers/sdd/2026-08-12-account-shared-ozon-category-recovery/evidence/task10-real-collect-detail-48e4fca.png`

## Not verified / environmental concern

No real Ozon, paid AI, object storage, production credential, production database, deployed service, production migration, or production restore was contacted. The repository-wide bounded verifier is not a passing gate: its earlier bounded run encountered missing extension parity configuration and unrelated existing dependency/browser/product delegation failures. Affected Task 10 suites were run independently and are reported above; no skipped or bounded result is counted as a pass.

## Rollback

Migration 063 is destructive and has no safe reverse SQL. Rollback requires stopping every writer, restoring the verified pre-upgrade backup, deploying the matching pre-upgrade application SHA, reconciling all potentially external Ozon product/import/stock outcomes, and only then resuming known-safe work. Preserve failed-upgrade evidence for investigation; never synthesize the deleted legacy target IDs.
