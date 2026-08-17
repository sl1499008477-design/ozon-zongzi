# Category Sampling Confirm Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate category-sample confirmations and complete valid 5～20 sample image processing within the extension's bounded request lifecycle.

**Architecture:** Keep the existing synchronous, idempotent confirmation contract. Add UI/controller single-flight ownership, parallelize only the 1～6 image operations inside one sample, and assign the existing action a dedicated 150-second service-worker budget while preserving the 600-second content wrapper ceiling.

**Tech Stack:** JavaScript, Node.js test runner, Chrome Manifest V3 extension, Sharp.

## Global Constraints

- Do not change database schemas, public API bodies, permissions, account isolation, idempotency keys, or image security checks.
- Keep samples sequential and preserve exact image order.
- Do not add dependencies, queues, polling, or generic concurrency frameworks.
- Use TDD and commit each independently verifiable batch.

---

### Task 1: Single-flight confirmation UI

**Files:**
- Modify: `extension/lib/category-strategy-sampling.js`
- Modify: `extension/content/ozon-search.js`
- Test: `extension/tests/category-strategy-sampling.test.js`
- Test: `extension/tests/ozon-search-complete-collection.test.js`

**Interfaces:**
- Consumes: existing `controller.confirm()` and `snapshot().canConfirm`.
- Produces: concurrent `confirm()` calls share one underlying `confirmSamples` call; `canConfirm` is false while pending.

- [ ] Add a deferred `confirmSamples` test that calls `confirm()` twice, asserts one port call and `canConfirm=false`, then resolves and asserts both calls finish.
- [ ] Run the focused tests and confirm the new test fails because the port is called twice or the button remains enabled.
- [ ] Add one controller-owned pending Promise and render immediately after starting confirm so the existing button follows `canConfirm`.
- [ ] Run controller and browser UI tests until green.
- [ ] Commit the isolated batch.

### Task 2: Parallelize images within one sample

**Files:**
- Modify: `server/auto-listing-category-strategy-sample-store.mjs`
- Test: `server/tests/auto-listing-category-strategy-sample-store.test.mjs`

**Interfaces:**
- Consumes: `context.sourceReferences` containing 1～6 ordered references.
- Produces: the same ordered immutable evidence array and object manifest contract.

- [ ] Add a gate-based test proving all source downloads start before any is released and output order remains input order.
- [ ] Run the sample-store test and confirm it fails because only the first download starts.
- [ ] Replace the per-reference serial loop with `Promise.all` preparation, then assemble assets/evidence in input order after all preparations succeed.
- [ ] Verify failure still occurs before manifest claim/object writes and run sample-store plus service tests.
- [ ] Commit the isolated batch.

### Task 3: Align the action timeout and package the extension

**Files:**
- Modify: `extension/content/shared-utils.js`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`
- Modify: `package.json`
- Modify: `app/src/extension-page-contract.mjs`
- Modify: `server/auto-listing-category-strategy-runtime.mjs`
- Modify: `server/index.mjs`
- Modify: version assertions in `scripts/check-extension-source-parity.test.mjs`, `extension/tests/jizhangerp-bridge-follow-sell.test.js`, `app/tests/category-strategy-extension-bridge.test.mjs`, `server/tests/extension-release-contract.test.mjs`, and `server/tests/auto-listing-category-strategy-e2e.test.mjs`
- Create through `scripts/package-extension.mjs`: `app/public/sonli-extension-0.13.46.14/` and `app/public/sonli-extension-0.13.46.14.zip`
- Test: `extension/tests/category-strategy-service-worker-routing.test.js`
- Test: focused shared-utils/message timeout contract test or an exact source contract assertion.

**Interfaces:**
- Consumes: `CATEGORY_STRATEGY_SAMPLES_CONFIRM` runtime action.
- Produces: 150-second service-worker timeout and existing 600-second content timeout.

- [ ] Add failing source/behavior assertions for both timeout layers and keep-alive coverage.
- [ ] Add the action to the existing content long-action list and a category-strategy service-worker timeout set; do not change other actions.
- [ ] Bump the extension patch version, synchronize public copies, and rebuild the ZIP with the existing packaging script.
- [ ] Run extension parity, package smoke, focused server tests, real read-only image download, and browser regression tests.
- [ ] Request code review, fix Critical/Important findings, commit, fast-forward merge, restart local services, and leave the Ozon tab for user handoff.
