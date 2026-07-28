# Obsolete Collector Code Cleanup Implementation Plan

> **历史文档：** 本文件保留当时的目标、路径和执行步骤，不据此推断当前完成状态；当前实现与验证结果以已提交代码、可复现测试和最终保护性基线报告为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unreachable legacy collector code and obsolete artifacts without changing the active Ozon data-panel or one-click collection behavior.

**Architecture:** Preserve the current product-card data-panel pipeline and the supported one-click collection path. Remove the retired IndexedDB bucket, floating collector panel, keyword pilot, auto-scroll, and anti-ban paths from the two page scripts, while retaining active source-parity and collector-removal guards.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript content scripts, Node.js built-in test runner, Vite.

## Global Constraints

- Do not change APIs, database schemas, permissions, configuration, dependencies, or real Ozon behavior.
- Do not call real Ozon accounts or write business data.
- Preserve all unrelated dirty-worktree changes.
- Keep `.superpowers`, `source-evidence`, the downloadable extension ZIP, and active collector-removal guards.
- Do not commit, stage, push, deploy, or migrate data.

---

### Task 1: Remove obsolete files and test exclusions

**Files:**
- Delete: `extension/tests/keyword-pilot-ownership.test.js`
- Delete: `extension/tests/fleet-collect-attrs-merge.test.js`
- Modify: `scripts/test-manifest.mjs`
- Delete: `design-reference-option-3.png`
- Delete: repository `.DS_Store` files

**Interfaces:**
- Consumes: `historicalTestExclusions` keyed by existing test paths.
- Produces: a test inventory with 78 active tests and 7 intentional Playwright exclusions.

- [x] **Step 1: Run the existing inventory before deletion**

Run:

```bash
node scripts/check-test-inventory.mjs
```

Expected: PASS with `78 active, 9 historical/manual`.

- [x] **Step 2: Delete the two obsolete tests and their exclusion entries**

Remove only the two entries whose dependencies have already been removed. Keep the seven Playwright exclusions because they still describe valuable regression scenarios.

- [x] **Step 3: Run the inventory after deletion**

Run:

```bash
node scripts/check-test-inventory.mjs
```

Expected: PASS with `78 active, 7 historical/manual`.

### Task 2: Remove the unreachable search-page collector path

**Files:**
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/tests/collector-removed.test.js`

**Interfaces:**
- Consumes: the active data-panel helpers and `pushSourceCollect` one-click product collection path.
- Produces: search/category data panels that no longer depend on `JZCollectorDB`, `JZCollectorPanel`, `JZKeywordPilot`, `JZAutoScroller`, or `JZAntiBanGuard`.

- [x] **Step 1: Extend the collector-removal behavior guard**

Execute the search content script in a controlled DOM/Chrome harness with retired collector globals implemented as throwing sentinels. Assert that initialization completes, the active panel storage key is read, and no retired collector global is used.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node extension/tests/collector-removed.test.js
```

Expected: FAIL because current search initialization still constructs or retains the retired collector path under the harness.

- [x] **Step 3: Remove the minimal unreachable implementation**

Remove the legacy bucket-write state, sale-record builder, keyword-pilot fallback, push-bucket function, floating collector panel, auto-scroll, anti-ban, and their unreachable helper functions. Keep data fetching, data-panel rendering, selection mode, and active one-click collection unchanged.

- [x] **Step 4: Run the guard and syntax validation**

Run:

```bash
node extension/tests/collector-removed.test.js
node --check extension/content/ozon-search.js
```

Expected: PASS.

### Task 3: Remove the unreachable generic-page collector path

**Files:**
- Modify: `extension/content/ozon-data-panel.js`
- Modify: `extension/tests/collector-removed.test.js`

**Interfaces:**
- Consumes: active panel enablement, rendering, authentication, and DOM observation.
- Produces: generic Ozon page data panels with no retired collector globals or bucket writes.

- [x] **Step 1: Add the generic-page harness case**

Execute the generic data-panel script with throwing retired collector globals. Assert that authenticated initialization reads only the active panel setting and attaches the normal page observer without calling retired collector code.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node extension/tests/collector-removed.test.js
```

Expected: FAIL on the retired collector dependency that remains in the current script.

- [x] **Step 3: Remove the minimal unreachable implementation**

Remove the old collector state, IndexedDB sale-record path, floating panel, auto-scroll, anti-ban, push-bucket logic, and collector-only readiness helpers. Preserve active panel fetching and rendering.

- [x] **Step 4: Run the guard and syntax validation**

Run:

```bash
node extension/tests/collector-removed.test.js
node --check extension/content/ozon-data-panel.js
```

Expected: PASS.

### Task 4: Remove regeneratable local artifacts

**Files:**
- Delete: `app/dist`
- Delete: `desktop/release`
- Delete: `desktop/sonli-collector-desktop-1.0.20.tgz`
- Delete: root, app, and desktop `node_modules` only after all verification is complete
- Keep: `desktop/dist`
- Keep: `desktop/dist-electron`

**Interfaces:**
- Consumes: build and packaging commands already declared by each project.
- Produces: a smaller workspace containing only reinstallable dependencies and rebuildable output deletions.
- Preserves: desktop renderer and Electron runtime files because the current desktop package has no source build command and directly executes/tests these directories.

- [x] **Step 1: Verify artifacts are generated or reinstallable**

Confirm each deletion target is not a source input and that package manifests/lockfiles remain. Although their names resemble build output, `desktop/dist` and `desktop/dist-electron` are runtime inputs in this repository and must not be deleted.

- [x] **Step 2: Delete build/release outputs**

Delete only `app/dist`, `desktop/release`, and `desktop/sonli-collector-desktop-1.0.20.tgz`. Keep `desktop/dist`, `desktop/dist-electron`, `app/public/sonli-extension-0.13.46.1.zip`, `.superpowers`, and `source-evidence`.

- [x] **Step 3: Delete dependency caches last**

Delete `node_modules` directories only after all tests and builds have finished, because they are required to run verification.

### Task 5: Full verification and rule review

**Files:**
- Review: all files changed by Tasks 1–4

**Interfaces:**
- Consumes: project-wide `scripts/verify.mjs`, package/build contracts, and the user-provided `AGENTS.md`.
- Produces: a recorded result covering changed behavior, regressions, unverified scope, and rollback.

- [x] **Step 1: Run targeted checks**

Run the inventory, collector guard, syntax checks, source parity, UI parity, diff contract, and extension package smoke checks.

- [x] **Step 2: Run full verification with local PostgreSQL**

Start the project-local PostgreSQL service, run `node scripts/verify.mjs`, record the result, and stop the service.

- [x] **Step 3: Inspect the final diff**

Confirm no API, database, permission, dependency, configuration, or external-service behavior changed and no sensitive data was introduced.

- [x] **Step 4: Review against AGENTS.md**

Confirm the cleanup improves cohesion and removes dead coupling, keeps stable contracts, retains tests, creates no external side effects, and has a clear rollback path through the existing dirty worktree diff.
