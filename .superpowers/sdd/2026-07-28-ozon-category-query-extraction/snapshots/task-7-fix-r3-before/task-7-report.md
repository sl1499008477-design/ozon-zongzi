# Task 7 report — product editor category readiness

- Work item/state: Task 7 complete; no commit.
- Target: `/Users/songliang/Documents/sonli ozon3.0`, dirty `main`; recovery commit `d4ed427992e9e159d657197fd7bad07b4c2f6f8c`.
- Risk/approval: R2 compatible product-editor readiness behavior under the approved category-query plan/design and Task 7 brief.
- Scope: `app/src/App.jsx`, new `app/src/category-readiness.js`, new `app/tests/category-readiness.test.mjs`, Task 7 checkboxes only, Task 7 snapshots, this report, and the scoped review package.

## Outcome and contract

`category-readiness.js` owns the executable UI contract. `loadRealCategoryTrees({ readTree })` calls the unchanged tree path for `ZH_HANS` and `RU`, accepts only `items` or `data` arrays, clones accepted data, and rejects if either tree is absent or empty. It has no local fallback path. `categoryReadiness` requires a selected description category/type, a non-loading/non-error state, and a non-empty authentic tree; `requireCategoryReadiness` throws the stable `OZON_CATEGORY_UI_UNAVAILABLE` error with the fixed Chinese retry message.

The editor now has one retryable `loadCategoryTrees` callback. It records the store scope, invalidates both old trees at the beginning of every new load, preserves an existing visible retry error while loading, and uses the helper for both languages. Only a current dual-language success replaces both trees and clears the error; a current failure clears both trees and keeps the fixed error. No API path changed.

Automatic matching gates only on authentic tree availability (`categoryTreeReady`); it deliberately does not require existing category IDs, so it can create the initial match. Its request token is bound to the current store/item scope, and response, error, and finally state writes require that token to remain current. Store/item scope changes invalidate the old token during render, so a late response cannot write a stale match or change loading. Category options and paths consume only helper-cloned trees whose store scope still equals the current store. Preview and publish have runtime `requireCategoryReadiness` guards and their category-dependent controls are disabled while the complete readiness condition is false. Draft saving, navigation, image editing, and text editing are not disabled by this change.

## TDD and validation

- Snapshot: `snapshots/task-7-before/` contains the exact pre-change App and plan. `SHA256SUMS.txt` records their SHA-256 values.
- RED: fixed Node ran `app/tests/category-readiness.test.mjs` before the module existed and exited 1 with `ERR_MODULE_NOT_FOUND` for `app/src/category-readiness.js`.
- GREEN: the same fixed Node command passed 4/4 helper behaviors: dual-language success and deep clone isolation, `data` compatibility, no fallback on language failure/empty data, and complete readiness/action-gate cases.
- Regression: fixed Node ran `app/tests/prototype-style-contract.test.mjs` with 15/15 passing.
- Syntax: fixed Node `--check app/src/category-readiness.js` exited 0.
- Build: the task's fallback `pnpm --dir app build` first failed because its process could not resolve `node` on PATH; with the supplied fixed Node runtime prepended to PATH, the same fallback pnpm executed Vite successfully. Vite emitted only its existing bundle-size advisory and produced the production build.
- Scoped whitespace search and scoped `git diff --check` were clean. The snapshot comparison is captured in `task-7-review-package.diff`.

## Review fix r1

- Snapshot: `snapshots/task-7-fix-r1-before/` captured the App, helper, helper test, plan, prior report, and prior review package before this review fix; `SHA256SUMS.txt` records each file.
- RED: after adding real helper tests for stale request/scope rejection, scoped-tree cloning, and error transitions, fixed Node exited 1 because `categoryRequestIsCurrent` was not exported.
- GREEN: the helper now passes 7/7 tests. It supplies request scope/currentness checks, cloned scoped trees, and explicit load-start/success/failure transitions. `App.jsx` consumes those helpers rather than source-text assertions.
- Validation: the fixed Node style contract remains 15/15; helper syntax passes. The fallback pnpm build passed with `pnpm_config_offline=true`, so this review-fix validation made no network request; Vite produced only the pre-existing bundle-size advisory.
- `task-7-fix-r1-package.diff` records the exact reviewed boundary and behavior changes.

## Review fix r2

- Snapshot: `snapshots/task-7-fix-r2-before/` records the pre-fix App, helper, test, report, and r1 review package. Its SHA-256 values are in `SHA256SUMS.txt`.
- RED: fixed Node ran the new three-ID item-scope behavior test before production code changed. It exited 1 because `categoryItemScopeIsCurrent` was not exported.
- Scope proof: `categoryItemScopeIsCurrent({ currentStoreId, localStateStoreId, itemStoreId })` returns true only when all three explicit IDs are non-empty and identical. It rejects the B-current/A-local/A-item transition and any missing candidate item ID.
- App wiring: the current store ID is resolved before selecting a candidate. The candidate contributes only explicit `storeId`, `store_id`, `ozonStoreId`, `ozon_store_id`, `bindingId`, or `binding_id`; no store-name inference is used. If the triple cannot be proven, `item` is `null` and `previewItem` is not consumable for category IDs, labels, attribute rows, draft construction, automatic matching, preview, publishing, or draft PATCH.
- Runtime containment: saving rejects `当前商品店铺数据未就绪，暂不能写回草稿`; preview/publish rejects the same transition before an API call; automatic matching exits before making a request. A verified current-store item preserves normal edit behavior.
- GREEN and validation: helper tests pass 8/8, the existing prototype style contract passes 15/15, helper syntax passes, and `pnpm_config_offline=true` Vite build passes with only the existing chunk-size advisory. No network request was made during this fix-r2 validation.
- `task-7-fix-r2-package.diff` is the scoped review record for this correction.

## Safety, unverified scope, and recovery

- No Ozon or application external request, database/container/migration, dependency/config/deployment change, extension/server change, staging, commit, branch, stash, push, reset, or checkout occurred. The fallback pnpm binary made an automatic registry metadata update-check attempt during the local build; it failed with `ERR_PNPM_META_FETCH_FAIL` and did not install, write project configuration, or affect the successful Vite build.
- Existing dirty user work was preserved. Manual browser visual interaction and real-credential/store behavior were intentionally not run; the task forbids real Ozon calls. The direct consumer style contract and production build were run.
- Recovery: restore `App.jsx` and the plan from `snapshots/task-7-before/`, then remove the new readiness helper/test and Task 7 artifacts if abandoning this work. There is no persistent data or external side effect to recover.

## Next safe action

Proceed with the separately scoped Task 8 extension readiness work. Keep the backend's final category gate unchanged and do not add a local category fallback.
