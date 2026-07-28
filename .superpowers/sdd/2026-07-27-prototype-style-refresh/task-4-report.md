# Task 4 report — dashboard and data-screen refresh

Status: DONE

## Scope and changes

- Added the Task 4 static contract for the scoped dashboard and data-screen selectors.
- Added `prototype-datascreen` to the existing `DataScreenPage` root only; no metric, label, data source, route, event handler, or interaction changed.
- Added scoped dashboard overrides for separated metric cards, panel hierarchy, work-queue rows, empty chart surfaces, quick actions, feature/onboarding cards, and weekly indicators.
- Added scoped light blue-and-white data-screen panel styling, including metrics, controls, status lists, chart bars, hourly distribution, and status chips.

Changed files:

- `app/src/App.jsx`
- `app/src/styles.css`
- `app/tests/prototype-style-contract.test.mjs`
- `.superpowers/sdd/2026-07-27-prototype-style-refresh/task-4-report.md`

## RED / GREEN

- RED: `node --test app/tests/prototype-style-contract.test.mjs` ran after adding the Task 4 contract. The prior 9 contracts passed and the new contract failed at the expected missing selector: `.prototype-shell .metric-grid`.
- GREEN: after the scoped CSS and root-class change, the same command passed all 10 contracts.

## Contracts

The new contract requires these selectors to remain present:

- `.prototype-shell .metric-grid`
- `.prototype-shell .metric-card`
- `.prototype-shell .dashboard-main-grid`
- `.prototype-shell .panel-card`
- `.prototype-shell .quick-actions`
- `.prototype-datascreen`

These selectors keep Task 4 visual changes isolated to the authenticated prototype shell or the data-screen root.

## Verification and regression checks

- PASS: `PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs` (10/10).
- PASS: `PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" pnpm --dir app build`.
- PASS: `git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs`.
- The Vite build emitted its existing large-chunk advisory only; it did not fail the build.

## Not verified

- No interactive browser visual comparison was run in this task; visual QA remains for the plan's dedicated final QA task.
- No live Ozon/API sync, write, publish, migration, permission, or production-data action was run.
- The worktree already contained unrelated dirty changes; they were not edited, staged, committed, pushed, or otherwise modified by Task 4.

## Risk and rollback

Risk is limited to scoped presentation overrides: narrow breakpoints and the data-screen's dense layout need final viewport QA. There are no data or side-effect changes. Roll back by removing the `prototype-datascreen` class, the Task 4 contract block, and the final `Prototype dashboard and data-screen overrides` stylesheet section; no data recovery is required.

## Fix round 1/5

Status: DONE — 2 addressed, 0 open.

- Important: removed the redundant compact-metric override that grouped `.prototype-shell .metric-card.compact` with `.prototype-shell .metric-card.compact strong`. The grouped declaration incorrectly gave the inline numeric `strong` a `min-height: 112px`; the general scoped metric-card and metric-card-strong rules already provide the intended card height and value font size.
- Minor: extended the Task 4 visual contract with an explicit `DataScreenPage` root-class assertion for `className="datascreen-page prototype-datascreen"`.
- Regression contract: added a failing-first assertion rejecting the combined compact-card/strong rule when it contains `min-height`.

Evidence:

- RED: the new contract failed only at `keeps compact metric values free of card sizing rules`, matching the offending combined selector.
- GREEN: `PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs` passed 11/11.
- PASS: the same Node-prefixed `pnpm --dir app build` completed successfully.
- PASS: `git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs .superpowers/sdd/2026-07-27-prototype-style-refresh/task-4-report.md` reported no whitespace errors.

## Fix round 2/5

Status: DONE — 1 addressed, 0 open.

- Replaced the order-sensitive compact-card regex with a CSS leaf-rule scanner. It traverses nested blocks, evaluates each selector in a selector list separately, and rejects `min-height` from every `.prototype-shell` selector whose `.metric-card… strong` path targets a metric value.
- The regression test checks the real stylesheet and proves failure for three dangerous fixtures: a standalone `.metric-card.compact strong` rule, a reverse-order combined selector list, and a nested `@media` metric-value rule.

Evidence:

- RED 1: the new regression test initially failed because the helper was intentionally undefined; the existing 11 contracts passed.
- RED 2: after the initial top-level-only parser implementation, the nested `@media` fixture did not throw, proving it would have escaped the contract.
- GREEN: the leaf-rule scanner detects all three fixtures while accepting the product CSS; `PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs` passed 11/11.
- PASS: the same Node-prefixed `pnpm --dir app build` completed successfully.
- PASS: `git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs .superpowers/sdd/2026-07-27-prototype-style-refresh/task-4-report.md` reported no whitespace errors.
