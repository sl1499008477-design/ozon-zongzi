# Supplemental Task 8 Report — Locked Listing Warehouse Evidence

## Scope

- `server/auto-listing-repository.mjs`
- focused repository/service fixtures and the dedicated PostgreSQL fixture

No migration, configuration, state-machine, route, UI, extension, AI, or Ozon code changed.

## TDD evidence

- RED: the new repository lock-contract tests reported **13 passed, 3 failed**. The prior transaction did not lock store/credential/product-stock evidence, accepted a disabled store or absent credential until later, and reloaded evidence per sibling.
- GREEN: focused repository/service/warehouse coverage reported **45 passed, 0 failed** after the smallest transaction-only lock/revalidation change.
- A follow-up RED made account scope an explicit parameter of credential, warehouse, and association queries; it failed with the credential query missing `account-a`. GREEN restored **45/45**.

## Transaction contract

`createJobGraph` retains the service precheck but makes the repository transaction authoritative. For the one frozen graph target it locks in this order:

1. scoped store row and ownership/status;
2. credential existence row only (`store_id`; no key, IV, tag, or ciphertext selected);
3. scoped warehouse row and platform/type/active/archive fields;
4. scoped product and product-stock association rows in `p.id, ps.source` order.

All are `FOR SHARE` row locks and all queries include the actor account plus the frozen store/warehouse scope. The locked rows are then checked with `validateTargetStoreRecord` and `assertListingStockSelectionEligible`. Invalid store, missing credentials, missing platform ID, disabled/non-FBS warehouse, and absent/archived association roll back before a job insert. Multiple sibling items share this one deterministic evidence lock/validation pass.

The gated two-connection fixture pauses A immediately after the product-stock lock. It proves a B warehouse disable and a B deletion of the last active association cannot complete before A commits; it then verifies that an invalidation which completes first prevents new job creation. Every barrier uses a five-second timeout and disposes/release/awaits both connections in `finally`.

## Verification

- Focused repository/service/warehouse: **45 passed, 0 failed**.
- Foundation gate: **112 passed, 0 failed**.
- Historical permissions/persistence/listing/store command: **43 passed, 0 failed** (the prior recorded 42-case gate now contains one existing additional permission case).
- `AUTO_LISTING_POSTGRES_TESTS=1` gate: **1 passed, 1 skipped** because `SONLI_MIGRATION_TEST_DATABASE_URL` is unset. The new two-connection test is deliberately unavailable without that dedicated URL and never falls back to `DATABASE_URL` or production.
- Syntax checks for changed production/test modules and `git diff --check` passed.

## Unverified range and rollback

The real two-connection PostgreSQL race is ready but not dynamically exercised in this workspace without the explicitly configured disposable migration database. Keep `AUTO_LISTING_ENABLED=0`; to roll back, revert this task commit. No database migration or persisted history is changed.

## Fix round 1 — contention proof and barrier cleanup

- RED: the new always-on barrier contract failed because the target-evidence barrier had no explicit abort path (`abort is not a function`). A second RED failed because the lock observer helper did not yet exist.
- GREEN: the helper gate now reports **3 passed, 1 dedicated-DB skip**. The barrier owns an independently rejectable `waitForLock`; abort, timeout, and dispose release a waiting participant and reject an unreached lock waiter, while an internal rejection handler prevents unhandled failures for zero-participant and early-failure paths. The unit test covers abort, timeout, dispose, and one participant reaching/releasing the evidence barrier.
- The PostgreSQL race no longer relies on an 80 ms promise race. B first records its `pg_backend_pid()` and sends a uniquely commented mutation. A separate observer connection polls only that PID for at most five seconds and requires both `wait_event_type = 'Lock'` and the exact marker in `query` before releasing A. The warehouse-disable and product-stock-delete mutations share this proof path. Cleanup aborts/releases the barrier, awaits/catches A and B, sends a harmless rollback to B, releases both auxiliary connections, and retains the schema/pool cleanup in the outer `finally`.
