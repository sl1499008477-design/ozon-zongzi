# Store Form Refresh Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the 15-second local-state refresh from replacing values typed into the add/edit Ozon store form.

**Architecture:** Keep the existing background refresh unchanged. Make the store form initialize only from its opening mode and selected edit-store snapshot, and remove the live current-store binding from the form lifecycle. A real-browser regression test will exercise the rendered React form and manually run the captured 15-second interval.

**Tech Stack:** React 19, Ant Design Form, Vite 6, Node test runner, Playwright Core

## Global Constraints

- New-store Client-Id, Api-Key, and label start empty; API Key creation date starts at the local current date.
- Edit-store fields load once from the selected store; Api-Key remains empty.
- Background refresh remains enabled and must not mutate an open form.
- Existing save APIs, permissions, credential handling, data contracts, and 180-day calculation remain unchanged.
- No database migration or external Ozon request is introduced.

---

### Task 1: Browser regression for an open store form

**Files:**
- Create: `app/tests/store-binding-form-refresh.test.mjs`

**Interfaces:**
- Consumes: the real `/src/main.jsx` application and its `GET /api/local/state` contract.
- Produces: an active regression test proving defaults, user-input retention after background refresh, edit initialization, and reset on reopen.

- [ ] **Step 1: Write the failing real-browser test**

Create a Vite server on an ephemeral localhost port and route `/api/local/state` to a fixed authenticated account with current store `store-current`. Before navigation, replace `window.setInterval` with a test harness that retains registered callbacks and exposes:

```js
window.__runIntervalsForTest = async (delay) => {
  const callbacks = [...window.__testIntervals.values()]
    .filter((entry) => entry.delay === delay)
    .map((entry) => entry.callback());
  await Promise.all(callbacks);
};
```

Open `/ozon/settings/stores/`, click the exact `新增` button, and assert these literal behaviors:

```js
assert.equal(await clientId.inputValue(), "");
assert.equal(await apiKey.inputValue(), "");
assert.equal(await label.inputValue(), "");
assert.equal(await createdAt.inputValue(), localToday);

await clientId.fill("999999999");
await apiKey.fill("temporary-not-submitted-key");
await label.fill("临时复现-不提交");
await createdAt.fill("2026-08-01");
await page.evaluate(() => window.__runIntervalsForTest(15_000));

assert.equal(await clientId.inputValue(), "999999999");
assert.equal(await apiKey.inputValue(), "temporary-not-submitted-key");
assert.equal(await label.inputValue(), "临时复现-不提交");
assert.equal(await createdAt.inputValue(), "2026-08-01");
```

Cancel and reopen the new-store modal, then assert it restores the new-store defaults rather than the unsaved values. Open the existing store's `修改` modal, assert the selected store values load once, edit the label, run the 15-second callback, and assert the edited label remains.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
node --test --test-concurrency=1 app/tests/store-binding-form-refresh.test.mjs
```

Expected: FAIL because the new form inherits `2141679` and `当前店铺`, and a refresh replaces typed values and clears Api-Key.

- [ ] **Step 3: Commit the failing test only after recording the expected failure**

```bash
git add app/tests/store-binding-form-refresh.test.mjs
git commit -m "test(app): cover store form refresh isolation"
```

### Task 2: Initialize the form only from its opening mode

**Files:**
- Modify: `app/src/App.jsx:809-819`
- Modify: `app/src/App.jsx:929-937`
- Modify: `app/src/App.jsx:1289-1300`
- Test: `app/tests/store-binding-form-refresh.test.mjs`

**Interfaces:**
- Consumes: `editingBindingStore`, `bindOpen`, `dateInputValue`, `todayDateOnly`, and the existing Ant Design `form` instance.
- Produces: one initialization per modal opening without a dependency on the live `binding` object.

- [ ] **Step 1: Apply the minimal lifecycle change**

Keep `openBindModal` and `closeBindModal` as the modal state boundary. Change the initialization effect to derive fields only from `editingBindingStore`:

```jsx
useEffect(() => {
  if (!bindOpen) return;
  form.setFieldsValue({
    clientId: editingBindingStore?.clientId || "",
    apiKey: "",
    label: editingBindingStore?.label || editingBindingStore?.companyName || "",
    apiKeyCreatedAt: dateInputValue(editingBindingStore?.apiKeyCreatedAt)
      || (editingBindingStore ? "" : todayDateOnly()),
  });
}, [bindOpen, editingBindingStore, form]);
```

Make the Form's static initial values neutral for add mode:

```jsx
initialValues={{
  clientId: "",
  apiKey: "",
  label: "",
  apiKeyCreatedAt: todayDateOnly(),
}}
```

Do not change the 15-second interval, `applyLocalState`, `saveBinding`, request payloads, or backend code.

- [ ] **Step 2: Run the focused test and confirm GREEN**

Run:

```bash
node --test --test-concurrency=1 app/tests/store-binding-form-refresh.test.mjs
```

Expected: PASS with no submitted store request.

- [ ] **Step 3: Run app-level regressions and build**

Run:

```bash
node --test --test-concurrency=1 app/tests/*.test.mjs
pnpm --dir app build
```

Expected: all app tests pass and Vite exits with code 0.

- [ ] **Step 4: Commit the implementation**

```bash
git add app/src/App.jsx
git commit -m "fix(app): preserve store form input during refresh"
```

### Task 3: Full verification and live-page confirmation

**Files:**
- Verify only; no additional production files.

**Interfaces:**
- Consumes: the repository-wide verification gate and the local Web page.
- Produces: fresh evidence for the original symptom and regression scope.

- [ ] **Step 1: Run the complete repository gate**

Run:

```bash
QH_LOCAL_NO_DOTENV=1 QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 node scripts/verify.mjs
```

Expected: build, active tests, extension package checks, isolation contracts, and security scan all pass; PostgreSQL-only tests may remain configuration-skipped.

- [ ] **Step 2: Recheck the exact browser symptom**

Open the local stores page, open `新增`, enter non-production test values, wait through or trigger one 15-second refresh, and confirm all inputs remain unchanged. Cancel without submitting.

- [ ] **Step 3: Review the final diff and working-tree boundaries**

Run:

```bash
git diff --check main...HEAD
git status --short --branch
```

Confirm only the design, plan, browser test, and focused App change belong to this branch. Preserve the user's dirty main documents, other worktree, and stash.
