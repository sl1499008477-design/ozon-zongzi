# Auto Listing Store Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make automatic listing use the selected store's native RUB or CNY currency without relabelling amounts, while preserving historical RUB contracts and external-write safety gates.

**Architecture:** Introduce one server currency contract, issue V2 price/listing-base evidence for new jobs, and retain read compatibility for V1/RUB evidence. A forward-only migration enforces V1/RUB versus V2/RUB-or-CNY invariants; the upload overlay and UI consume the frozen currency instead of hard-coding RUB.

**Tech Stack:** Node.js ESM, PostgreSQL, React 19, Ant Design 6, node:test, loopback fake Ozon.

## Global Constraints

- Supported currencies are exactly RUB and CNY; every other code fails closed.
- CNY uses native minor units (fen) and the approved 80 CNY threshold; no FX conversion is allowed.
- Existing *Kopecks field names remain for compatibility but mean integer minor units in V2.
- Explicit source currency must equal target-store currency. Missing source currency can use TARGET_STORE only with exact target-store category evidence.
- V1/RUB rows and hashes are never rewritten; CNY evidence uses V2.
- No real Ozon, paid AI, production database, or production inventory write is permitted during verification.
- Tenant, append-only, idempotency, RFBS, worker authorization, and safe-error boundaries must remain intact.

---

### Task 1: Native Currency and Source Evidence

**Files:**
- Create: server/auto-listing-currency.mjs
- Modify: server/auto-listing-pricing.mjs
- Modify: server/auto-listing-source-snapshot.mjs
- Modify: server/auto-listing-service.mjs
- Modify: server/auto-listing-view.mjs
- Modify: server/auto-listing-routes.mjs
- Test: server/tests/auto-listing-pricing.test.mjs
- Test: server/tests/auto-listing-source-snapshot.test.mjs
- Test: server/tests/auto-listing-service.test.mjs
- Test: server/tests/auto-listing-view.test.mjs
- Test: server/tests/auto-listing-routes.test.mjs

**Interfaces:**
- Produces AUTO_LISTING_SUPPORTED_CURRENCIES, normalizeAutoListingCurrency(value), and resolveAutoListingPriceCurrency(input).
- Produces calculateAutoListingPrice(input) for RUB or CNY.
- Produces V2 priceEvidence with currencySource SOURCE or TARGET_STORE.
- Preserves verification of historical V1/RUB source captures without currencySource.

- [ ] **Step 1: Write failing pricing and source tests**

Add literal CNY expectations:

~~~js
assert.deepEqual(calculateAutoListingPrice({
  blackKopecks: "10000",
  greenKopecks: "8000",
  adjustmentKopecks: "-500",
  currency: "CNY",
}), {
  currency: "CNY",
  branch: "BLACK_GTE_80",
  blackKopecks: "10000",
  greenKopecks: "8000",
  realPriceKopecks: "14500",
  adjustmentKopecks: "-500",
  finalPriceKopecks: "14000",
});
expectPriceError(
  { blackKopecks: "10000", greenKopecks: "8000", currency: "USD" },
  "PRICE_CURRENCY_UNSUPPORTED",
);
~~~

Add source cases for explicit CNY/SOURCE, missing currency/TARGET_STORE, explicit RUB against CNY mismatch, and missing currency without exact store evidence. Add service cases proving a CNY item becomes SOURCE_READY, mismatch becomes BLOCKED with zero AI work, unsupported store currency rejects before repository work, and safe DTOs return CNY.

- [ ] **Step 2: Run focused tests and verify RED**

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-pricing.test.mjs \
  server/tests/auto-listing-source-snapshot.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-view.test.mjs \
  server/tests/auto-listing-routes.test.mjs
~~~

Expected: only new native-currency cases fail because production rejects non-RUB and lacks currencySource.

- [ ] **Step 3: Implement the closed server currency contract**

Create the shared module with this behavior:

~~~js
export const AUTO_LISTING_SUPPORTED_CURRENCIES = Object.freeze(["RUB", "CNY"]);

export function normalizeAutoListingCurrency(value) {
  const currency = typeof value === "string" ? value.trim().toUpperCase() : "";
  return new Set(AUTO_LISTING_SUPPORTED_CURRENCIES).has(currency) ? currency : null;
}

export function resolveAutoListingPriceCurrency(input = {}) {
  const target = normalizeAutoListingCurrency(input.targetStoreCurrency);
  if (!target) throw currencyError("AUTO_LISTING_TARGET_STORE_CURRENCY_UNSUPPORTED");
  const rawSource = typeof input.sourceCurrency === "string" ? input.sourceCurrency.trim() : "";
  if (rawSource) {
    const source = normalizeAutoListingCurrency(rawSource);
    if (!source) throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED");
    if (source !== target) throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_MISMATCH");
    return Object.freeze({ currency: source, currencySource: "SOURCE" });
  }
  if (input.sourceTargetStoreId !== input.targetStoreId) {
    throw currencyError("AUTO_LISTING_SOURCE_CURRENCY_UNSUPPORTED");
  }
  return Object.freeze({ currency: target, currencySource: "TARGET_STORE" });
}
~~~

Keep currencyError private and expose only stable codes.

- [ ] **Step 4: Generalize pricing and source capture**

Change pricing to require a supported currency and echo it without changing integer arithmetic or the 8,000-minor-unit threshold. Pass targetStore.currencyCode into source capture. New captures always record currencySource; historical RUB captures without it remain valid. Update blocked-code sets and safe service/view/route projections for exactly RUB/CNY.

- [ ] **Step 5: Run GREEN and commit**

Re-run Step 2, require all pass, then:

~~~bash
git diff --check
git add server/auto-listing-currency.mjs server/auto-listing-pricing.mjs server/auto-listing-source-snapshot.mjs server/auto-listing-service.mjs server/auto-listing-view.mjs server/auto-listing-routes.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-source-snapshot.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-view.test.mjs server/tests/auto-listing-routes.test.mjs
git commit -m "feat(auto-listing): support native store currency evidence"
~~~

---

### Task 2: Listing Base V2 and PostgreSQL Enforcement

**Files:**
- Create: server/db/migrations/062_auto_listing_store_currency.sql
- Modify: server/auto-listing-listing-base-preparer.mjs
- Modify: server/auto-listing-overlay.mjs
- Modify: server/auto-listing-repository.mjs
- Modify: server/auto-listing-upload-postgres.mjs
- Test: server/tests/auto-listing-listing-base-preparer.test.mjs
- Test: server/tests/auto-listing-overlay.test.mjs
- Test: server/tests/auto-listing-repository.test.mjs
- Test: server/tests/auto-listing-upload-postgres.integration.test.mjs
- Create: server/tests/auto-listing-store-currency-migration.integration.test.mjs

**Interfaces:**
- Produces AUTO_LISTING_LISTING_BASE_V2 with V2 pricing evidence.
- Preserves V1/RUB freeze, read, and overlay behavior.
- Requires storeAccess.currencyCode to equal frozen evidence and every variant currency_code.

- [ ] **Step 1: Write failing V2 and real-PG tests**

Use this hand-derived V2 evidence:

~~~js
const cnyEvidence = {
  currency: "CNY",
  currencySource: "TARGET_STORE",
  blackKopecks: "10000",
  greenKopecks: "8000",
  evidenceHash: digest({
    currency: "CNY",
    currencySource: "TARGET_STORE",
    blackKopecks: "10000",
    greenKopecks: "8000",
  }),
};
assert.equal(frozen.version, "AUTO_LISTING_LISTING_BASE_V2");
assert.equal(submission.items[0].currency_code, "CNY");
assert.equal(submission.items[0].price, "145.00");
~~~

Add negative V1/CNY, V2/USD, missing currencySource, target-store mismatch, and forged variant currency tests. Add a real migration test proving historical V1/RUB survives unchanged, V2/CNY succeeds, invalid combinations return SQLSTATE 23514, V2 is append-only, and tenant/store FKs still apply.

- [ ] **Step 2: Run tests and confirm RED**

Start a disposable PostgreSQL 16 container on a random loopback port with tmpfs and no named volume. Set AUTO_LISTING_POSTGRES_TESTS=1 and SONLI_MIGRATION_TEST_DATABASE_URL, then run:

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-listing-base-preparer.test.mjs \
  server/tests/auto-listing-overlay.test.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-upload-postgres.integration.test.mjs \
  server/tests/auto-listing-store-currency-migration.integration.test.mjs
~~~

Expected: V2 cases fail and the migration test reports missing 062.

- [ ] **Step 3: Implement forward-only migration 062**

Replace only the RUB-only listing-base price check with a conditional V1/V2 check:

~~~sql
CHECK (
  (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V1'
    AND pricing_evidence->>'currency' = 'RUB'
    AND NOT (pricing_evidence ? 'currencySource'))
  OR
  (listing_base_version = 'AUTO_LISTING_LISTING_BASE_V2'
    AND pricing_evidence->>'currency' IN ('RUB','CNY')
    AND pricing_evidence->>'currencySource' IN ('SOURCE','TARGET_STORE'))
)
~~~

Reinstall the insert guard so it joins stores by owner_account_id/id, checks stores.currency_code, and checks every ozon_ready_variants item currency_code. Use SQLSTATE 23514 for mismatches. Do not update old rows or alter append-only/privacy/tenant triggers.

- [ ] **Step 4: Implement V2 freeze, preparer, and overlay**

The preparer must require storeAccess.currencyCode and build raw items with that currency instead of RUB. Freeze V2 when currencySource exists; keep V1 only for legacy RUB. V2 canonical/evidence hashes include currencySource. Overlay formats the final minor units as a two-decimal number and sets item.currency_code from frozen evidence after exact verification. Repository preflight and upload mapping preserve all V2 fields.

- [ ] **Step 5: Run GREEN and commit**

Run Step 2 with zero PG skips. Stop/remove the disposable database and verify no matching container remains. Then:

~~~bash
git diff --check
git add server/db/migrations/062_auto_listing_store_currency.sql server/auto-listing-listing-base-preparer.mjs server/auto-listing-overlay.mjs server/auto-listing-repository.mjs server/auto-listing-upload-postgres.mjs server/tests/auto-listing-listing-base-preparer.test.mjs server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-upload-postgres.integration.test.mjs server/tests/auto-listing-store-currency-migration.integration.test.mjs
git commit -m "feat(auto-listing): persist native currency listing bases"
~~~

---

### Task 3: Currency-Aware Admin Page

**Files:**
- Modify: app/src/auto-listing-config.js
- Modify: app/src/AutoListingPage.jsx
- Test: app/tests/auto-listing-config.test.mjs
- Test: app/tests/auto-listing-page-contract.test.mjs

**Interfaces:**
- Produces autoListingCurrencyPresentation(currency).
- Produces shouldResetAutoListingAdjustment(previousCurrency, nextCurrency).
- Preserves the API request field priceAdjustmentKopecks.

- [ ] **Step 1: Write failing pure UI contract tests**

~~~js
assert.deepEqual(autoListingCurrencyPresentation("CNY"), {
  currency: "CNY", name: "人民币", symbol: "¥",
});
assert.deepEqual(autoListingCurrencyPresentation("RUB"), {
  currency: "RUB", name: "卢布", symbol: "₽",
});
assert.throws(
  () => autoListingCurrencyPresentation("USD"),
  { code: "PRICE_CURRENCY_UNSUPPORTED" },
);
assert.equal(shouldResetAutoListingAdjustment("RUB", "CNY"), true);
assert.equal(shouldResetAutoListingAdjustment("CNY", "CNY"), false);
~~~

Add preview assertions for ¥145.00 and 145.00 ₽. Add page contract assertions for a dynamic label and removal of the hard-coded RUB-only field.

- [ ] **Step 2: Run tests and confirm RED**

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  app/tests/auto-listing-config.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
~~~

- [ ] **Step 3: Implement dynamic presentation and reset**

Derive selected currency from store.currencyCode, store.currency, or store.companyCurrency. Reject unsupported/missing currency. Rename only the form field to priceAdjustmentAmount and map it to the unchanged API minor-unit field. Display 人民币/¥ or 卢布/₽. Track prior supported currency in a ref; crossing CNY/RUB resets adjustment to 0 and shows a fixed notice, while same-currency switching preserves it. Keep existing account/load generation fences.

- [ ] **Step 4: Run GREEN, build, and commit**

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  app/tests/auto-listing-config.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
git diff --check
git add app/src/auto-listing-config.js app/src/AutoListingPage.jsx app/tests/auto-listing-config.test.mjs app/tests/auto-listing-page-contract.test.mjs
git commit -m "feat(auto-listing): show target store currency"
~~~

---

### Task 4: CNY End-to-End Safety and Final Acceptance

**Files:**
- Create: server/tests/auto-listing-cny-store-e2e.test.mjs
- Modify: server/tests/auto-listing-postgres.integration.mjs
- Modify: server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs
- Create: docs/verification/2026-08-11-auto-listing-store-currency.md
- Modify only previously named production files if the E2E proves a missing composition wire.

**Interfaces:**
- Consumes real migrations 001–062, create service, repositories, upload service, standard pipeline, and worker.
- Produces real-PG/loopback evidence for CNY import and zero-write failure cases.

- [ ] **Step 1: Write the failing full CNY E2E**

Seed a CNY tenant store, exact active warehouse, and collect item with missing source currency plus exact target-store category evidence. Use approved local AI/publication fixtures only. Run the real create/upload/worker chain and assert:

~~~js
assert.equal(importCall.path, "/v3/product/import");
assert.equal(importCall.body.items[0].currency_code, "CNY");
assert.equal(importCall.body.items[0].price, "145.00");
~~~

Add failure cases for explicit RUB source against CNY store, unsupported target currency, and forged base/variant mismatch. Assert zero AI outbox, product import, and stock calls.

- [ ] **Step 2: Confirm E2E RED**

On a fresh disposable PostgreSQL database:

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-cny-store-e2e.test.mjs
~~~

Expected: failure at the first remaining RUB-only production boundary, not fixture setup.

- [ ] **Step 3: Close only proven integration gaps**

Trace each failure to its exact boundary before editing. Keep immutable fake-Ozon call history and assert exact call order, CNY payload, and zero duplicate writes. If an unnamed production file is required, amend this plan with the reason before editing it.

- [ ] **Step 4: Run final regressions**

Run all Task 1–3 tests, then real PG:

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-postgres.integration.mjs \
  server/tests/auto-listing-upload-postgres.integration.test.mjs \
  server/tests/auto-listing-rfbs-first-listing-e2e.test.mjs \
  server/tests/auto-listing-cny-store-e2e.test.mjs
~~~

Require zero failure and zero PG skip. Run the exact adjacent matrix:

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  server/tests/auto-listing-pricing.test.mjs \
  server/tests/auto-listing-source-snapshot.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-routes.test.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-listing-base-preparer.test.mjs \
  server/tests/auto-listing-overlay.test.mjs \
  server/tests/auto-listing-upload-service.test.mjs \
  server/tests/auto-listing-upload-runtime.test.mjs \
  server/tests/auto-listing-submission-reconciliation-postgres.integration.test.mjs \
  server/tests/auto-listing-upload-task-postgres.integration.test.mjs \
  server/tests/listing-pipeline-v3.integration.mjs \
  server/tests/account-store-isolation.test.mjs \
  app/tests/auto-listing-config.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
~~~

Then run:

~~~bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
git diff --check
~~~

- [ ] **Step 5: Independent review and verification record**

Review currency authority, missing-currency fallback, V1/V2 compatibility, database enforcement, precision, tenant scope, idempotency, external-write order, and UI reset. Every Critical/Important finding gets a failing test before a fix.

Write docs/verification/2026-08-11-auto-listing-store-currency.md with tested implementation SHA, exact counts, disposable-DB details, fake external boundaries, unverified real-Ozon scope, forward-only migration rollback, and recovery.

- [ ] **Step 6: Local browser acceptance and final commits**

Start/restart the existing local service and open:

http://127.0.0.1:3000/ozon/tools/auto-listing/?source=collect&ids=collect_ccab18d873aa2c8074555143

Verify “粽子测试” displays 售价加减（人民币）, the current item can create a CNY task, and its safe DTO shows CNY. Do not authorize a real Ozon write.

Stop/remove disposable containers. Commit implementation tests and the verification record in separate commits so the record names the exact tested implementation SHA.

Rollback:

- Revert application commits and disable new CNY job creation.
- Keep migration 062 and all V2 evidence; never delete or rewrite V2 rows.
- Restore by re-enabling code and using existing idempotent task/upload retry controls.
