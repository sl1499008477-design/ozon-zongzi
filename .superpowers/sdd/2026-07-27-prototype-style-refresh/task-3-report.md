# Task 3 Report — Shared components and overlays

Status: DONE

## Scope and changes

- Added the approved shared-component contract for scoped buttons, inputs, selects, cards, source tables, table headers, overlays, and the login card, plus scoped Dropdown, Popover, Tooltip, and required overlay-root contracts.
- Added `rootClassName="prototype-overlay"` to the binding `Modal`, plugin `Drawer`, and each application `Tooltip`; appended the same class to the existing Dropdown and Popover overlay-class values. Their open, close, trigger, placement, form, footer, and submit props are unchanged.
- Added scoped prototype overrides for shared Ant Design controls, cards, source tables, table headers, Dropdown, Popover, Tooltip, overlay panels, focus rings, and readable error, warning, disabled, success, and empty states.
- Restyled the standalone login page, card, brand, controls, validation text, and checking state with the approved prototype tokens. The login selectors remain under `.sonli-login-page` because the unauthenticated login view does not render inside `.prototype-shell`.

## TDD evidence

RED command:

```text
PATH="/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node --test app/tests/prototype-style-contract.test.mjs
```

RED result: 5 passing, 1 failing. The new `styles shared controls and data surfaces inside the prototype scope` contract failed as expected on the missing `.prototype-shell .ant-btn` selector.

GREEN command: same command after the minimal implementation.

GREEN result: 9 passing, 0 failing. Review-driven follow-up cycles added popup-surface selectors, explicit binding Modal/plugin Drawer coverage, and portal-root coverage for the existing Dropdown, Popover, and all Tooltip instances. The final RED result was 7 passing, 2 failing; the expected missing items were prototype-overlay popup CSS and popup root-class markers.

## Build and static checks

- `pnpm --dir app build`: passed (Vite production build completed). It emitted the pre-existing Rollup advisory that the main JavaScript chunk exceeds 500 kB after minification; no build error occurred.
- `git diff --check -- app/src/App.jsx app/src/styles.css app/tests/prototype-style-contract.test.mjs`: passed with no whitespace errors.

## Files and contracts

- `app/src/App.jsx`: overlay root-class contract for the binding Modal, plugin Drawer, Dropdown, Popover, and Tooltip portals only; no behavior contract changed.
- `app/src/styles.css`: scoped visual contract for shared controls/data surfaces and `.prototype-overlay`; standalone login styling is scoped beneath `.sonli-login-page`.
- `app/tests/prototype-style-contract.test.mjs`: shared-component selector contract.
- No API, database, permission, route, dependency, configuration, or external-service contract changed. No real Ozon operation was invoked.

## Regression and review

- Re-ran the complete prototype style contract test file after implementation: 9/9 passing.
- Ran the production build to check the changed React/CSS bundle.
- Performed a scoped diff check; the worktree already contains unrelated user modifications, which were not altered or reverted.
- Independent read-only review found and then re-verified the portal-scope and Drawer-contract issues; final review reported no Critical, Important, or Minor findings.
- A browser visual pass was not run here; the plan assigns cross-route visual QA to Task 7.

## Risk and rollback

- Main residual risk: broad Ant Design minimum-height rules can alter dense controls; visual confirmation on representative operational pages remains for Task 7.
- Rollback is local and reversible: remove the two `rootClassName` props, the appended shared/login override block, and the appended test from the three task files. No data recovery or external rollback is required.
