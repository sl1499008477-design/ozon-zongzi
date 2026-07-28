# Task 8 report — 1688 AI wizard category failure gate

- Work item/state: Task 8 complete; no commit, stage, branch, external request, browser operation or Ozon action.
- Target: `/Users/songliang/Documents/sonli ozon3.0`, existing dirty `main`; recovery commit `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`.
- Risk/approval: R2 compatible extension/readiness contract under the approved category-query plan and design.
- Scope: only the Task 8 approved extension files, parity contracts, Task 8 plan checkboxes, package outputs and this SDD handoff material.

## Outcome and contract

`extension/lib/category-readiness.js` is a dependency-free IIFE loaded immediately before `content/1688-ai-wizard.js`. Its tested global contract is `window.SonliCategoryReadiness`:

- `failTree` clears the tree, loading/selection/path and every attribute state, records the fixed retryable Ozon message, and marks data unready.
- `failAttributes` preserves the selected category/path for retry but clears every attribute state, records the same fixed message, and marks data unready.
- `markReady` is the only success transition. The wizard calls it only after an authentic successful attribute-array response; a valid authentic empty array is therefore ready.
- `requireReady` requires a selected category and explicit `categoryDataReady`, not attribute-array length.

The wizard calls `failTree` for failed, thrown or empty tree responses and returns before automatic category selection. It calls `failAttributes` for non-success, malformed or thrown attribute responses and renders the fixed error rather than an empty attribute form. Pipeline, rewrite, fill-attribute and publish continuations call `requireReady` through a visible-error wrapper before they can continue. No raw failure response is displayed to the user.

The manifest order is exactly `content/alibaba-1688.js`, `lib/category-readiness.js`, then `content/1688-ai-wizard.js` for the detail.1688.com content-script list.

## Baseline, RED and review evidence

- `snapshots/task-8-before/` contains pre-change wizard, manifest, two contract scripts, distributed manifest and ZIP; `SHA256SUMS.txt` records their pre-change hashes. The initial source artifact hashes are retained by the snapshot.
- The plain shell has no `node`, as documented in the project baseline. All actual Node work used `/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
- RED: the fixed Node runtime ran `extension/tests/category-readiness.test.js` before the helper existed and exited 1 with `ENOENT` for `extension/lib/category-readiness.js`.
- GREEN: the same test passes the literal tree-failure reset, attribute-failure retention/reset, explicit ready with authentic empty attributes, and `requireReady` rejection transitions.
- Review package: `task-8-review-package.diff` records the scoped source/contract boundary. Snapshot comparison reports 19 wizard hunks, 63 additions and 15 removals. The external-source exact contract independently reports those same counts and the manifest contract now reports 15 hunks, 11 additions and 19 removals.

## Validation

All commands below exited 0 with the fixed runtime, using only local fixtures and static extension files:

```text
extension/tests/category-readiness.test.js
extension/background/__tests__/agent-actions.smoke.test.js
extension/tests/collector-removed.test.js
extension/tests/jizhangerp-bridge-follow-sell.test.js
node --check extension/content/1688-ai-wizard.js
node --check extension/lib/category-readiness.js
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-diff-contract.mjs
pnpm_config_offline=true pnpm package-extension
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
git diff --check -- [Task 8 approved source/contract/plan paths]
```

`package-extension` was the only generator used. It rebuilt `app/public/sonli-extension-0.13.46.1/`, `app/public/sonli-extension-0.13.46.1.zip` and `app/dist/sonli-extension-0.13.46.1.zip`. ZIP parity passed for both 94-file archives. Packaged smoke passed for the bridge and dry-run follow-sell guard. The packaged manifest was inspected and contains the helper immediately before the wizard; both helper and helper test are inside the archive.

## Safety, regression scope and recovery

- No browser automation, Ozon request, publish, database/container operation, dependency installation, configuration/deployment change, staging, commit, branch, stash, reset or checkout occurred.
- Existing dirty user work was preserved. Source parity and exact distribution-diff contracts passed against `/Users/songliang/Desktop/0.13.46.1`.
- Direct regressions cover the new helper, agent registry, collector removal, bridge follow-sell behavior, static syntax, source/diff parity and both packaged archives. Manual browser interaction and real Ozon credentials remain intentionally unverified because this task forbids them.
- Rollback: restore the four source/contract files from `snapshots/task-8-before/`, remove the new helper/test and Task 8 operational artifacts, then rerun the existing package script to regenerate matching distribution artifacts. Do not use broad Git recovery commands in this dirty worktree. There is no persistent data or external side effect to compensate.

## Next safe action

Proceed only with the separately scoped Task 9 module-boundary/documentation work. Keep this extension helper as the single readiness-state owner; do not add category fallback or change AI prompts.

## Review fix r1 — immutable scope and draft revalidation

Snapshot: `snapshots/task-8-fix-r1-before/` captures the helper, test, wizard, manifest, parity contracts, prior Task 8 handoff and pre-r1 ZIP. `SHA256SUMS.txt` records the recovery bytes.

### Critical: mid-flight category scope changes

RED: the fixed Node runtime ran the expanded VM helper test before the new API existed. It exited 1 with `TypeError: api.captureReadyScope is not a function`.

GREEN: `captureReadyScope(state)` now first requires ready data, then freezes the current non-empty store ID, exact category object and category IDs. `requireReadyScope(state, scope)` repeats the normal readiness test and rejects changed store, changed error/readiness, changed category identity or changed IDs with the fixed Ozon error. VM behavior coverage proves unchanged scope succeeds while attribute failure, a store change and a replacement category object with the same ID all reject.

Wizard wiring captures this scope at the entry to pipeline, rewrite, publish and attribute-fill actions. Every relevant async result is scope-checked before category-dependent state writes or continuation. In particular, pipeline checks after collect/rewrite awaits, after `aiFillAttrs`, before payload construction and immediately before `followSell`; post-publish and non-direct update continuations are checked too. A failed in-pipeline check throws the fixed error into the existing catch, so it cannot reach `followSell` or report a false success. The visible wrapper renders the fixed error before stopping.

### Important: trusted restored drafts

Drafts no longer persist category tree, readiness flags, category-data error or attribute schema/value rows. Restore retains selection and ordinary user fields only, then `invalidateRestored` clears local category data, sets fixed visible failure and keeps category/path for retry. `open()` immediately calls `revalidateRestoredCategory()` when there is a saved store/category selection.

Revalidation issues a fresh real tree request scoped by sequence, store ID, category object and captured IDs. Only a non-empty tree containing that restored type/category can reconstruct the path; it then loads authentic attributes. The existing attribute loader also binds its response to the captured store/category. Thus only the current tree plus current attributes can call `markReady`; empty/non-success/missing-category responses call the existing fail-closed helpers, and a late response after a store/category change is ignored. There is no local tree fallback and no automatic rematch during restoration.

### r1 validation and recovery

The fixed Node runtime passed the helper VM test, agent-actions smoke, collector-removal guard, bridge follow-sell smoke, both syntax checks, source parity and exact diff contract. With fixed Node on PATH and `pnpm_config_offline=true`, the existing package script rebuilt the unpacked extension and both ZIPs. ZIP parity confirms each 94-file archive is byte-identical to the extension tree; both packaged bridge/dry-run smoke suites pass. Scoped `git diff --check` passes.

No browser, Ozon request, real publish, database/container action, dependency install, config/deployment change, Git write or external side effect occurred. Manual browser and real-credential behavior remain intentionally unverified. `task-8-fix-r1-package.diff` is the scoped review artifact. Rollback is to restore Task 8 r1 snapshots, remove the r1 helper/test/wizard/contract deltas as appropriate, then rerun the existing package script; no data recovery is needed.
