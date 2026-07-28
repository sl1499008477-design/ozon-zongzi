# Task 1 report — Establish the pre-change baseline and global design tokens

## Status

DONE. The required RED→GREEN workflow, production-token implementation, and stated verification checks are complete. The initial Node.js runtime absence is retained below as a resolved environment event in the baseline and RED evidence.

## Scope and safety

- Worktree: `/Users/songliang/Documents/sonli ozon3.0` on `main`.
- Risk: R1 local and reversible visual-token configuration only.
- Allowed module boundary: `app/src/App.jsx`, `app/src/styles.css`, and `app/tests/prototype-style-contract.test.mjs`.
- No API, table, permission, dependency, configuration, migration, external Ozon, staging, commit, push, or other external side effect was performed.
- The worktree was already dirty. Existing user changes, including extensive changes in `app/src/App.jsx` and `app/src/styles.css`, were preserved.

## Baseline evidence (Step 1)

Commands run:

```bash
git status --short --branch
git diff -- app/src/App.jsx app/src/styles.css
pnpm --dir app build
```

Results:

- `git status --short --branch` reported `## main` and a large set of existing tracked and untracked changes. Relevant existing changes include `M app/src/App.jsx` and `M app/src/styles.css`; no changes were reverted or staged.
- `git diff -- app/src/App.jsx app/src/styles.css` confirmed both target files contain extensive pre-existing user edits. The task token block and approved Ant Design palette were absent at the inspected locations.
- `pnpm --dir app build` failed before any Task 1 production change. `vite build` exited with `/app/node_modules/.bin/vite: line 41: exec: node: not found` (pnpm reported `ELIFECYCLE Command failed`). This is the pre-change build baseline and was not repaired.

## RED evidence (Steps 2–3)

Created the exact required contract file:

- `app/tests/prototype-style-contract.test.mjs`

The planned production mutations the test catches are omission or alteration of an approved CSS custom-property value, or omission/alteration of the four mandated Ant Design token values.

Command run:

```bash
node --test app/tests/prototype-style-contract.test.mjs
```

Actual output:

```text
zsh:1: command not found: node
```

This is an environment-command failure, not the required assertion failure caused by absent tokens. Additional read-only checks confirmed the blocker:

```bash
command -v node || true
which -a node || true
pnpm --dir app exec node --version
ls -la app/node_modules/.bin/node 2>/dev/null || true
```

`command -v node` returned no executable, `which -a node` reported `node not found`, and pnpm reported `Command "node" not found`.

## GREEN evidence (Steps 4–6)

After the active shell was provided the approved Node runtime path, the RED command was rerun with:

```bash
PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  node --test app/tests/prototype-style-contract.test.mjs
```

It failed as intended: 0/2 tests passed. The CSS test failed on missing `--prototype-page-bg`; the Ant Design test failed on missing `colorPrimary: "#005af8"`. This is the required feature-missing RED failure.

Implemented the approved minimum:

- Added all 16 required `--prototype-*` CSS custom properties, including the two-line `--prototype-shadow`, to the existing `:root` block.
- Replaced the root font stack with the approved Inter/PingFang/Microsoft YaHei/Noto Sans CJK SC/system stack.
- Mapped `themeConfig.token` to the approved primary, text, border, layout/container-background, radius, and shadow values.
- Changed the existing Card component token to 18px large-card rounding; the global 12px token preserves 12px control rounding.

Fresh GREEN commands run:

```bash
PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  node --test app/tests/prototype-style-contract.test.mjs
PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" \
  pnpm --dir app build
git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
git diff --stat -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs
```

Results:

- Token contract: PASS — 2 tests, 2 passed, 0 failed.
- Build: PASS — Vite 6.4.2 transformed 4803 modules and completed in 3.88s. This improves on the pre-change baseline, which could not find Node. Vite emitted its non-fatal existing chunk-size warning for the 1,569.32 kB JavaScript bundle.
- Whitespace check: PASS — `git diff --check` produced no output.
- `git diff --stat` showed the existing dirty-file aggregate (`app/src/App.jsx` 3958 lines and `app/src/styles.css` 355 lines) because it compares the full user-modified files against `HEAD`; the new untracked test file is intentionally not included by ordinary `git diff --stat`.

## File list

- Created: `app/tests/prototype-style-contract.test.mjs`
- Created: `.superpowers/sdd/2026-07-27-prototype-style-refresh/task-1-report.md`
- Modified: `app/src/App.jsx` (Task 1 change confined to `themeConfig` at the task-specified location)
- Modified: `app/src/styles.css` (Task 1 change confined to the initial `:root` block)

## Self-review

- The contract content exactly matches the task brief and was observed failing for absent production values before implementation.
- Every required CSS variable and every specified Ant Design token is present at the requested value; the contract provides ongoing coverage of the mandated palette subset.
- The targeted build passes under the supplied Node runtime, and the whitespace check is clean.
- No unrelated worktree changes were modified, staged, committed, pushed, or discarded. Existing target-file changes make aggregate Git statistics larger than this task's local edit.
- No real Ozon operation was invoked.

## Residual notes and rollback

The prior Node-runtime blocker is resolved only for commands that prepend the supplied runtime directory to `PATH`. Keep that prefix for future Node/pnpm validation in this shell. The only remaining validation limitation is visual/browser review; this task's stated acceptance checks are source-contract, build, and diff checks, all of which have fresh results above. Rollback is limited to removing this task's root-token block, `themeConfig` token values, and contract test; no data or external side effect requires recovery.
