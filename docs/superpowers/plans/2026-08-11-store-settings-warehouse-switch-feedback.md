# Store Settings Warehouse Counts and Switch Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show warehouse counts per store and provide single-flight, persistent feedback while switching the current store.

**Architecture:** Extend the pure store-settings projection with tenant-local per-store warehouse counts. Add a small in-memory switch gate and let `App.jsx` own request execution, messages, and React state while `StoresSettingsPage.jsx` renders the server operation state.

**Tech Stack:** React 19, Ant Design 6, Node.js test runner, Vite.

## Global Constraints

- Do not change database schema or backend route contracts.
- Do not perform a real store switch during verification.
- Preserve unrelated user changes in the main working tree.
- Every production behavior must first be demonstrated by a failing test.

---

### Task 1: Per-store warehouse projection

**Files:**
- Modify: `app/src/stores-settings-model.js`
- Modify: `app/src/StoresSettingsPage.jsx`
- Test: `app/tests/data-collection-store-runtime.test.mjs`

**Interfaces:**
- Consumes: `localData.stores`, `localData.caches.warehouses`, and `binding.id`.
- Produces: `warehouseCountsByStoreId`, `currentWarehouseCount`, and row counts derived from exact store IDs.

- [ ] **Step 1: Write the failing test**

Add a fixture with `store-a` owning 33 warehouses and `store-b` owning one warehouse. Assert literal counts `{ "store-a": 33, "store-b": 1 }` and current count `33`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/tests/data-collection-store-runtime.test.mjs`

Expected: FAIL because the projection has no per-store count fields.

- [ ] **Step 3: Write minimal implementation**

Normalize only explicit warehouse store identifiers (`storeId`, `store_id`, `localStoreId`, `operatingStoreId`), increment an object keyed by exact store ID, and expose the current store count. Render each table row and current summary from those values, using `0` when no warehouses belong to a store.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/tests/data-collection-store-runtime.test.mjs`

Expected: PASS.

### Task 2: Single-flight switch state and feedback

**Files:**
- Create: `app/src/store-switch-gate.js`
- Modify: `app/src/App.jsx`
- Modify: `app/src/StoresSettingsPage.jsx`
- Create: `app/tests/store-switch-gate.test.mjs`

**Interfaces:**
- Produces: `createStoreSwitchGate()` with `begin(storeId)`, `finish(storeId)`, and `activeStoreId()`.
- `StoresSettingsPage` consumes `switchingStoreId` and renders the matching action as loading/“切换中…”, disabling every other switch action.

- [ ] **Step 1: Write the failing gate test**

Assert that `begin("store-b")` succeeds, a second `begin("store-c")` fails, the active ID remains `store-b`, a mismatched finish cannot release it, and the matching finish restores an empty active ID.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/tests/store-switch-gate.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement and wire the gate**

Create the minimal gate. In `App.jsx`, keep the gate in a ref, publish `switchingStoreId` to React state, show a duration-zero keyed loading message before the request, replace it with keyed success/error, and release the gate in `finally`. Pass the state through `GenericPage` to `StoresSettingsPage` and set button loading/disabled/text from it.

- [ ] **Step 4: Run focused tests**

Run: `node --test app/tests/store-switch-gate.test.mjs app/tests/data-collection-store-runtime.test.mjs`

Expected: PASS.

### Task 3: Regression verification and delivery

**Files:**
- Verify all files changed in Tasks 1-2.

- [ ] **Step 1: Run adjacent tests**

Run the store settings, runtime state, deletion, date, transport, and module-boundary tests discovered with `rg`.

- [ ] **Step 2: Build the Web application**

Run: `pnpm --dir app build`

Expected: production build succeeds.

- [ ] **Step 3: Run repository verification**

Run: `pnpm verify` with the repository's existing local verification environment.

Expected: all configured checks pass; any explicitly gated external PostgreSQL tests are reported separately.

- [ ] **Step 4: Commit and integrate**

Commit only the design, plan, tests, and implementation files. Merge the isolated branch into local `main` without touching the user's unrelated modified documents, rerun focused verification, restart the existing local service, and perform a read-only browser check.
