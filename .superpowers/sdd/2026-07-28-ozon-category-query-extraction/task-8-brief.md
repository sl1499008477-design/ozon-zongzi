# Task 8 brief — 1688 AI wizard category failure gate

## Source of truth

- Plan Task 8 and approved category-query design.
- Rules: `/Users/songliang/.codex/AGENTS.md`.
- Ledger: `.superpowers/sdd/2026-07-28-ozon-category-query-extraction/progress.md`.

## Business goal and acceptance

The 1688 AI wizard must stop whenever authentic Ozon category tree or attribute data is unavailable. It must retain a visible failure state, never auto-select from failed/empty data, never generate a fake empty attribute form, and never continue preview/publish until authentic category data succeeds.

Acceptance:

- tested dependency-free global helper implements Task 8 transitions literally;
- tree failure clears tree, selection, path and all attribute state;
- attribute failure keeps selected category for retry but clears all attribute state;
- readiness is explicit through `categoryDataReady`, not inferred from attribute-array length;
- successful authentic attributes call `markReady`;
- preview/publish/action continuation calls `requireReady` and visibly stops on failure;
- helper loads before wizard;
- no new AI logic, prompt change, fallback data, or unrelated extension behavior;
- source parity, exact diff contracts and distributed ZIP parity remain valid.

## Approved files

- Create `extension/lib/category-readiness.js`
- Modify `extension/content/1688-ai-wizard.js`
- Modify `extension/manifest.json`
- Modify `scripts/check-extension-source-parity.mjs`
- Modify `scripts/check-extension-diff-contract.mjs`
- Create `extension/tests/category-readiness.test.js`
- Modify Task 8 checkboxes only in the plan
- Packaging outputs changed only by the existing `package-extension` script when source changes
- Operational snapshots/report/scoped diff under this SDD directory

No server/app/database/config/dependency/AI prompt or unrelated extension feature changes.

## TDD and implementation

1. Snapshot every existing approved source/contract/manifest/package artifact before modification, with SHA-256.
2. Write Node `vm` behavior tests before helper creation and record genuine missing-file RED.
3. Implement the literal dependency-free IIFE helper from Task 8.
4. Load helper immediately before `content/1688-ai-wizard.js` in the matching manifest content-script list.
5. Wire tree/attribute success/failure and preview/publish continuation:
   - `failTree` on real tree failure;
   - `failAttributes` on real attribute failure;
   - `markReady` only after successful authentic attribute response, even when the valid authentic schema is empty;
   - `requireReady` before category-dependent continuation;
   - visible fixed error and no continuation on failure.
6. Update parity/diff contract scripts exactly as planned.
7. Package only through the existing script; do not hand-edit generated ZIPs.

## Verification

Use fixed Node for all Node commands:

```bash
node extension/tests/category-readiness.test.js
node extension/background/__tests__/agent-actions.smoke.test.js
node extension/tests/collector-removed.test.js
node extension/tests/jizhangerp-bridge-follow-sell.test.js
node --check extension/content/1688-ai-wizard.js
```

Then run with the fixed runtime on PATH and `pnpm_config_offline=true`:

```bash
pnpm package-extension
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
```

Also run:

```bash
node scripts/check-extension-source-parity.mjs
node scripts/check-extension-diff-contract.mjs
node --check extension/lib/category-readiness.js
```

Run scoped whitespace/diff checks and compare with Task 8 snapshots.

Mandatory review:

- every failure branch renders error and returns before selection/form/submission;
- `markReady` cannot run after a failed response;
- valid authentic empty attribute arrays may still be ready;
- no direct secret/raw response is displayed;
- manifest order is exact;
- allowed local-only and exact distribution diff are intentional and minimal;
- packaged ZIPs contain the helper in the correct order and source parity passes;
- no real browser/Ozon/network request in tests.

## Safety

- No real Ozon, browser automation, publish, or external write.
- No DB/container, dependency installation, config/deployment, app/server change.
- Packaging is local and reproducible through the existing script only.
- No commit/stage/branch/worktree/stash/push/reset/checkout.
- Preserve dirty `main`.

## Handoff

Write `task-8-report.md` and `task-8-review-package.diff`, including generated-artifact list, RED/GREEN, regression/package checks, unverified browser range, rollback and concerns. Report without committing.
