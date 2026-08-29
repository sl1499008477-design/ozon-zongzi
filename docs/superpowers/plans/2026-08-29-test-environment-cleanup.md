# Test Environment Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a truthful full-project verification run by preparing each existing workspace dependency, running browser checks outside the macOS GUI sandbox, supplying the reviewed extension baseline and Compose environment, repairing stale contract fixtures, and fixing any production defect proven by the gated PostgreSQL flows.

**Architecture:** Treat `desktop` as its existing independent pnpm workspace, pass external verification inputs only to the verification command, and update fixtures to satisfy already-published contracts. The gated category-refresh flow proved that source snapshot identity omitted the shared category version, so the minimal production change advances that identity contract from V2 to V3. Do not weaken production validation; remove only test scenarios that database constraints make impossible and that existing focused tests already cover.

**Tech Stack:** Node.js 24, pnpm 11, node:test, Playwright Core with local Chrome, Vite, Docker Compose, PostgreSQL 16.

**Spec:** `docs/superpowers/verification/2026-08-28-auto-listing-ai-channel-pool.md`

## Global Constraints

- Follow the repository `AGENTS.md`: KISS/YAGNI, root-cause fixes, trust-boundary validation, and representative end-to-end verification.
- Never commit `.env`, credentials, absolute personal paths, generated `node_modules`, or external extension sources.
- Browser tests must run outside the macOS GUI sandbox; do not replace them with source-text assertions.
- Extension parity must use the reviewed upstream `0.13.46.1` tree; do not compare the extension against itself.
- Docker Compose interpolation must consume the existing local environment without printing resolved secrets.

---

### Task 1: Prepare the independent desktop workspace

**Files:**
- Modify: none (ignored `desktop/node_modules` only)
- Test: `desktop/tests/parse-modern-ozon.test.mjs`

**Interfaces:**
- Consumes: `desktop/package.json`, `desktop/pnpm-lock.yaml`, local pnpm content-addressed store.
- Produces: a locally resolvable `desktop/node_modules/cheerio` dependency for the existing parser runtime.

- [x] **Step 1: Reproduce the missing dependency from a clean desktop workspace**

Run the parser test before installing the desktop workspace dependencies.

Expected: `ERR_MODULE_NOT_FOUND` for the declared `cheerio` package.

- [x] **Step 2: Install exactly the locked desktop dependencies**

Run: `pnpm --dir desktop install --offline --frozen-lockfile`

Expected: no lockfile change and `desktop/node_modules/cheerio` resolves to the locked `1.2.0` package.

- [x] **Step 3: Verify the real parser**

Run: `pnpm --dir desktop exec node --test tests/parse-modern-ozon.test.mjs`

Expected: 1 pass, 0 fail.

### Task 2: Repair the stale category-strategy resume fixture

**Files:**
- Modify: `app/tests/category-strategy-list-navigation.browser.test.mjs:81`
- Test: `app/tests/category-strategy-list-navigation.browser.test.mjs`

**Interfaces:**
- Consumes: `projectStrategyResumeDraft()` contract requiring `required.sourceCollectItemId` to match one `sourceVersions[].collectItemId`.
- Produces: a valid resume fixture whose storage-removal failure branch can observe retained state.

- [x] **Step 1: Preserve the existing failing browser test as RED**

Run outside the macOS GUI sandbox:

`node --test --test-concurrency=1 app/tests/category-strategy-list-navigation.browser.test.mjs`

Expected: FAIL at the retained resume-key assertion because the malformed fixture is removed during initial projection.

- [x] **Step 2: Add the missing contract field to the fixture**

Change the `required` fixture to:

```js
required: {
  scope: SCOPE,
  sourceCollectItemId: "collect-category-navigation",
  status: "COLLECTING",
  canManage: true,
  draftId: DRAFT_ID,
},
```

- [x] **Step 3: Verify GREEN against the real browser page**

Run the same browser test outside the macOS GUI sandbox.

Expected: 1 pass, 0 fail, including the storage-failure branch.

### Task 3: Supply the existing extension, Docker, and Chrome prerequisites

**Files:**
- Modify: none
- Test: extension parity scripts, `extension/tests/ui-parity-exception-gate.test.js`, six focused browser tests, Docker Compose interpolation.

**Interfaces:**
- Consumes: reviewed upstream extension directory from `QH_SOURCE_EXTENSION_DIR`, the existing main-repository `.env`, `/usr/local/bin/docker`, and local Chrome.
- Produces: truthful parity, browser, and Compose verification results without repository changes.

- [x] **Step 1: Verify all extension parity gates**

Run the source, UI, and diff parity scripts plus the UI mutation test with `QH_SOURCE_EXTENSION_DIR` pointing to the reviewed `0.13.46.1` directory.

Expected: all four commands exit 0.

- [x] **Step 2: Verify Docker Compose interpolation with the existing environment**

Load the main-repository `.env` into the Node verification process, include `/usr/local/bin` in `PATH`, and run `docker compose config --quiet` without printing the resolved configuration.

Expected: exit 0.

- [x] **Step 3: Verify browser tests outside the GUI sandbox**

Run the five app browser tests and `extension/tests/category-strategy-product-fallback.test.js` with test concurrency 1 outside the macOS GUI sandbox.

Expected after Task 2: 6 pass, 0 fail.

### Task 4: Verify gated PostgreSQL strategy contracts

**Files:**
- Modify: `server/auto-listing-repository.mjs` and the stale PostgreSQL/browser fixtures proven by the gated tests.
- Test: the exact category-strategy and configurable-skeleton PostgreSQL gates discovered during diagnosis.

**Interfaces:**
- Consumes: a disposable PostgreSQL schema and current migration sequence through 101.
- Produces: evidence that strict-strategy HTTP status and Excel planning-selector expectations match the current published contracts.

- [x] **Step 1: Reproduce each gated failure independently**

Run each gate against a disposable schema with its explicit opt-in environment variable.

Expected: capture the exact assertion, route/selector input, and actual output; do not edit code yet.

- [x] **Step 2: Compare with current public contracts and recent changes**

Classify each failure as production regression or stale expectation using the route/selector contract tests and migration history.

- [x] **Step 3: Apply a test-first minimal correction only when required**

Keep the failing gate as RED, make one minimal code or fixture change, and rerun it to GREEN. The category-refresh gate proved a source-version collision with unchanged draft/raw bytes; the V3 identity now binds shared category ID and version. Stale strict-strategy, Excel-selector, and dense-order expectations were aligned with the current public contracts.

- [x] **Step 4: Run the previously hidden latest-migration and RFBS gates**

Advance stale migration sentinels through 101, seed the immutable product-draft revision required by the current schema, and align the RFBS fixture with the published strategy, store-currency, health, and publication-policy contracts. Remove the impossible verified-USD fixture; that boundary remains covered by the database constraint and focused currency tests.

### Task 5: Isolate local-state tests from an inherited production database environment

**Files:**
- Modify: the five local JSON/auth/import/pricing test files exposed by the full verifier.
- Test: those same files under the existing main-repository `.env`.

**Interfaces:**
- Consumes: inherited shell variables plus each test's temporary JSON state directory.
- Produces: deterministic local-mode tests that cannot silently switch to the configured PostgreSQL database.

- [x] **Step 1: Reproduce clean-versus-configured behavior**

All five tests passed without the main `.env` and failed with it; `POSTGRES_HOST` selected PostgreSQL before the temporary JSON fixture was read.

- [x] **Step 2: Isolate the database selector before importing or calling the tested runtime**

Delete `DATABASE_URL` and `POSTGRES_HOST` inside the local-mode test process, matching the repository's existing local-state test convention. Do not change production authentication or persistence precedence.

- [x] **Step 3: Verify the configured environment no longer changes the test backend**

Run all five files with the main `.env`: expected 5 pass, 0 fail, with no writes to the configured PostgreSQL database.

### Task 6: Run the full verifier and deliver

**Files:**
- Modify: none beyond the source, fixtures, local-test isolation, plan, and verification documentation proven necessary above.
- Test: `scripts/verify.mjs`

**Interfaces:**
- Consumes: prepared desktop dependencies and explicit environment from Tasks 1 and 3.
- Produces: one complete verification result, reviewable Git diff, and a pushed commit only after review.

- [x] **Step 1: Run the full verifier outside the GUI sandbox**

Run `scripts/verify.mjs` with the main `.env`, `/usr/local/bin` on `PATH`, and the reviewed `QH_SOURCE_EXTENSION_DIR`.

Expected: every verification check passes; any remaining failure must be root-caused before continuing.

- [x] **Step 2: Inspect the exact diff and scan for secrets**

Run: `git diff --check`, `git status --short`, and the repository personal-data/credential scan.

Expected: only intentional source/test/plan changes, no `.env`, credentials, generated dependencies, or external extension files.

- [x] **Step 3: Request an independent read-only code review**

Expected: no unresolved Critical or Important findings.

- [x] **Step 4: Commit and push the verified branch**

Stage only the reviewed files, commit with a scoped fix message, push `codex/integrate-channel-pool-v6`, and confirm local HEAD equals its upstream ref.
