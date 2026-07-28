# Task 7 brief — product editor category readiness

## Source of truth

- Plan Task 7 and approved design in `docs/superpowers/`.
- Rules: `/Users/songliang/.codex/AGENTS.md`.
- Ledger: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`.

## Business goal and acceptance

The product editor must distinguish authentic Ozon category data from unavailable data. If either Chinese or Russian real category tree fails or is empty, clear both trees, show a fixed visible error with retry, and block category-dependent AI matching, preview, and publish. Unrelated navigation, draft editing, and image editing remain usable.

Acceptance:

- executable helper behavior matches Task 7 literally;
- loader accepts only response `items`/`data` arrays and returns clones;
- loader never accepts or synthesizes local fallback data;
- category readiness requires selected description category/type, no loading/error, and a real tree count;
- page uses one retryable loader for both languages;
- failure clears stale tree state and stays visible until a successful retry;
- preview/publish use `requireCategoryReadiness`;
- automatic category matching cannot run while authentic tree data is loading/unavailable, but do not create an impossible circular gate that requires an already-matched category before the matching action itself;
- only category-dependent controls are disabled.

## Approved files

- Create `app/src/category-readiness.js`
- Modify `app/src/App.jsx`
- Create `app/tests/category-readiness.test.mjs`
- Boundary-fix scope: create one focused React hook module for category-tree loading/request scope when required to keep `App.jsx` within its existing 9850-line architecture guard.
- Modify Task 7 checkboxes only in the plan
- Operational snapshots/report/scoped diff under this SDD directory

No global style churn, API path change, server/extension change, dependency/config/deployment change, or unrelated page refactor.

## TDD and implementation

1. Snapshot existing App/plan with SHA-256 under `snapshots/task-7-before/`.
2. Write the literal behavior tests from Task 7 before creating the module. Record genuine missing-module RED.
3. Implement only the minimal readiness module and fixed code/message contract.
4. Integrate into the existing product editor:
   - explicit `categoryDataError`;
   - one stable retry callback;
   - stale trees cleared on failure;
   - fixed Ant Design `Alert` scoped to category area;
   - retry action;
   - gate preview/publish with the helper;
   - gate automatic matching on authentic tree availability without requiring a preexisting matched ID;
   - disable only category-dependent buttons.
5. Keep existing three API paths unchanged.

## Verification

Use fixed Node:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node app/tests/category-readiness.test.mjs
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node app/tests/prototype-style-contract.test.mjs
```

Build with:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --dir app build
```

Also run `node --check app/src/category-readiness.js`, scoped whitespace checks, and inspect the Task 7 before/App diff.

Mandatory review:

- no unrelated component/global CSS churn;
- error cannot be hidden by stale trees;
- retry success clears error and restores readiness;
- action handlers have runtime guards, not only disabled buttons;
- no local fallback/API path change;
- helper outputs are cloned and cannot mutate source data;
- no real network call in tests.

## Safety

- No real Ozon or external side effect.
- No DB/container, dependency/config/deployment, extension/server, or data changes.
- No commit/stage/branch/worktree/stash/push/reset/checkout.
- Preserve dirty `main`.

## Handoff

Write `task-7-report.md` and `task-7-review-package.diff` with RED/GREEN, files/contracts/build, regressions, unverified visual/manual range, rollback and concerns. Report without committing.
