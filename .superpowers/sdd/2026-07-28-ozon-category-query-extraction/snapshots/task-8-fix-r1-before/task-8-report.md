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
