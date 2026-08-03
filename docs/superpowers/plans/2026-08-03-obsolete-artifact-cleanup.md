# Obsolete Artifact Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete extension releases, unreachable extension modules, unused Web components, and retired service-worker actions while preserving every current `0.13.46.2` capture and listing contract.

**Architecture:** Permanent negative contract tests define what must no longer ship. Cleanup is split into independently reversible commits: release artifacts, unreachable modules/components, then retired message actions. Generated dependency caches are removed only after code verification.

**Tech Stack:** Node.js test runner, React/Vite, Chrome Manifest V3, pnpm, Git.

## Global Constraints

- Preserve current `0.13.46.2` source, unpacked public distribution, and ZIP contracts.
- Preserve Collector authentication, public collection upload, Seller enrichment, follow-sell, listing, desktop collector, database, and Web routes.
- Do not delete the active `seller-assisted-async-enrichment` worktree, Git stash, `.env`, `server-data`, `.superpowers`, `source-evidence`, desktop runtime assets, or current main-branch document edits.
- Dynamic extension messages are public contracts; delete only the sixteen actions proven to have no current sender.
- Execute inline in this session; no subagents are used.

---

### Task 1: Remove the 0.13.46.1 release

**Files:**
- Modify: `server/tests/extension-release-contract.test.mjs`
- Delete: `app/public/sonli-extension-0.13.46.1/`
- Delete: `app/public/sonli-extension-0.13.46.1.zip`
- Delete: `app/dist/sonli-extension-0.13.46.1.zip`

**Interfaces:**
- Consumes: `EXTENSION_VERSION`, `/extension/latest`, the manifest version, and the root package version.
- Produces: one canonical `0.13.46.2` release with an explicit no-old-release contract.

- [ ] **Step 1: Add the failing release-boundary assertions**

Extend the existing test with `access()` checks that the current public directory and ZIP exist, then assert `ENOENT` for the three tracked `0.13.46.1` paths.

- [ ] **Step 2: Verify RED**

Run: `node --test server/tests/extension-release-contract.test.mjs`

Expected: FAIL because the `0.13.46.1` public directory and ZIP files still exist.

- [ ] **Step 3: Delete only the tracked 0.13.46.1 release paths**

Remove the three paths listed above. Do not alter `0.13.46.2`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test server/tests/extension-release-contract.test.mjs && node scripts/check-extension-zip.mjs && node scripts/check-extension-zip-smoke.mjs`

Expected: release test passes and both current ZIP copies match and start successfully.

- [ ] **Step 5: Commit**

Commit message: `chore(extension): remove obsolete 0.13.46.1 release`

---

### Task 2: Remove unreachable extension modules and Web components

**Files:**
- Modify: `extension/tests/sync-capability-removed.test.js`
- Modify: `app/tests/removed-selection-watermark-ui.test.mjs`
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/check-extension-diff-contract.mjs`
- Delete: `extension/background/agent/agent-runtime.js`
- Delete: `extension/background/agent/actions.js`
- Delete: `extension/background/agent/collect-actions.js`
- Delete: `extension/background/agent/listing-actions.js`
- Delete: `extension/background/__tests__/agent-actions.smoke.test.js`
- Modify: `app/src/App.jsx`

**Interfaces:**
- Consumes: manifest/service-worker runtime reachability, extension parity allowlists, and the current App route tree.
- Produces: a packaged extension without the unregistered browser-agent runtime and an App source without three unrendered component definitions.

- [ ] **Step 1: Add failing negative contracts**

In `sync-capability-removed.test.js`, assert that the five retired agent/runtime test files do not exist. In the App UI contract, assert that `SourceFilterDrawer`, `ProductStatusFilters`, and `SourcePager` are absent.

- [ ] **Step 2: Verify RED**

Run: `node --test extension/tests/sync-capability-removed.test.js app/tests/removed-selection-watermark-ui.test.mjs`

Expected: FAIL on the existing files and definitions.

- [ ] **Step 3: Delete the unreachable files and definitions**

Delete the agent folder and its self-referential smoke test. Remove the three complete function declarations from `App.jsx` without changing adjacent components.

- [ ] **Step 4: Update parity contracts**

Move the four upstream agent modules plus the upstream smoke test into the explicit retired-file set. Remove `background/agent/listing-actions.js` from reviewed-difference allowlists.

- [ ] **Step 5: Verify GREEN**

Run the two focused tests, `pnpm --dir app build`, `node scripts/check-plugin-readiness-gate.mjs`, and the extension parity checks with `QH_SOURCE_EXTENSION_DIR=/Users/songliang/Downloads/0.13.88.1`.

- [ ] **Step 6: Commit**

Commit message: `refactor: remove unreachable extension and web code`

---

### Task 3: Remove retired service-worker actions

**Files:**
- Create: `extension/tests/obsolete-runtime-boundary.test.js`
- Modify: `extension/background/service-worker.js`

**Interfaces:**
- Consumes: the current message senders in popup, content scripts, Web bridge, tests, and application bridge.
- Produces: a service-worker dispatch table without handlers that have no current sender.

- [ ] **Step 1: Write the failing action-boundary test**

Read the real service worker and assert it has no `case` for exactly:

`addFavorite`, `aiListingDraftConfirm`, `aiListingDraftCreate`, `aiListingDraftPublish`, `aiOptimize`, `checkSellerCookies`, `checkUpdate`, `collectBatch`, `collectProduct`, `fetchOzonPublicProduct`, `focusSellerRecoveryTab`, `getFavCount`, `importStock`, `pushToCollectBox`, `refreshBackend`, `savePricingSnapshot`.

Also scan the current production extension, App, server and script sources excluding the service worker, generated distributions, tests, historical evidence, and comments; fail if a sender for one of these retired actions is introduced later.

- [ ] **Step 2: Verify RED**

Run: `node --test extension/tests/obsolete-runtime-boundary.test.js`

Expected: FAIL because all sixteen handlers still exist.

- [ ] **Step 3: Delete the sixteen switch branches**

Remove only their complete `case` blocks. Do not remove similarly named server functions such as `savePricingSnapshot`, and do not remove current actions such as `aiOptimizeForRating`, `getUpdateInfo`, `pushSourceCollect`, `enrichOzonCollect`, or `followSell`.

- [ ] **Step 4: Remove newly orphaned private helpers only when reference count becomes zero**

Use exact identifier searches after the branch deletion. A helper is removed only if its definition is the sole remaining production reference and focused tests do not import it.

- [ ] **Step 5: Verify GREEN**

Run the new test, service-worker syntax check, sync-capability test, popup runtime test, plugin readiness gate, package the extension, and run both ZIP checks.

- [ ] **Step 6: Commit**

Commit message: `refactor(extension): remove retired message handlers`

---

### Task 4: Full verification and regenerable local cleanup

**Files:**
- Modify: generated `app/public/sonli-extension-0.13.46.2/` and current ZIP files only through `scripts/package-extension.mjs`
- Delete locally after tests: ignored `app/dist` build assets and unpacked extension directories, `.DS_Store` files, root/app/desktop `node_modules`, and `.pnpm-store`

**Interfaces:**
- Consumes: all preceding committed cleanup batches.
- Produces: verified code, regenerated current extension packages, and reduced local disk usage.

- [ ] **Step 1: Regenerate current extension distributions**

Run: `node scripts/package-extension.mjs`

- [ ] **Step 2: Run the complete available gate**

Set `QH_SOURCE_EXTENSION_DIR=/Users/songliang/Downloads/0.13.88.1` and run `node scripts/verify.mjs`. Record the pre-existing visual-browser failures separately if they remain. Run `git diff --check` and inspect `git status --short`.

- [ ] **Step 3: Commit regenerated current artifacts if their bytes changed**

Commit message: `chore(extension): refresh cleaned 0.13.46.2 package`

- [ ] **Step 4: Remove only regenerable ignored local artifacts**

Delete the ignored dependency/cache directories and stale generated App output after all verification. Preserve every excluded data, configuration, worktree, stash, runtime and history path from the global constraints.

- [ ] **Step 5: Report disk recovery and rollback**

Measure reclaimed space. Report tests, pre-existing blockers, retained worktree/stash, and the independent commits that can be reverted.
