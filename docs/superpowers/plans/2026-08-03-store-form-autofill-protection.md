# Store Form Autofill Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent saved Web login credentials from being auto-filled into the Ozon Client-Id and Api-Key fields without changing store data or save behavior.

**Architecture:** Keep the existing Ant Design form and API contract unchanged. Add standard HTML autocomplete metadata at the form and two credential-like inputs, and extend the existing real-browser regression so this browser contract is testable alongside add/edit initialization and the 15-second background refresh behavior.

**Tech Stack:** React 19, Ant Design 6, Vite 6, Node.js test runner, Playwright Core

## Global Constraints

- Client-Id, Api-Key and label are empty when the add-store modal opens; the API Key creation date defaults to the current local date.
- Edit-store behavior remains unchanged: Client-Id is shown, Api-Key is empty, and an empty Api-Key does not replace the stored secret.
- The 15-second local-state refresh never replaces values in an open add or edit form.
- The store API contract, database schema, authorization checks, tenant/store boundaries and Ozon calls do not change.
- Use standard browser autocomplete metadata only; do not add read-only/focus-unlock state in this change.

---

### Task 1: Protect store credential fields from login autofill

**Files:**
- Modify: `app/tests/store-binding-form-refresh.test.mjs:133-180`
- Modify: `app/src/App.jsx:1293-1317`

**Interfaces:**
- Consumes: the existing Ant Design `Form`, `Input` and `Input.Password` components and the existing add/edit store form behavior.
- Produces: DOM contract `form[autocomplete="off"]`, Client-Id `autocomplete="off"`, and Api-Key `autocomplete="new-password"`; no JavaScript API or backend contract changes.

- [ ] **Step 1: Write the failing browser-contract assertions**

Add the form locator and these assertions immediately after the existing Client-Id, Api-Key, label and date locators:

```js
const storeForm = page.locator('.ant-modal form');

assert.equal(await storeForm.getAttribute("autocomplete"), "off");
assert.equal(await clientId.getAttribute("autocomplete"), "off");
assert.equal(await apiKey.getAttribute("autocomplete"), "new-password");
```

Keep the existing assertions that all new-store fields are empty and that the 15-second refresh preserves user input.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/tests/store-binding-form-refresh.test.mjs
```

Expected: FAIL because the current form and inputs return `null` for the required `autocomplete` attributes.

- [ ] **Step 3: Add the minimal autocomplete metadata**

Update the existing form and two inputs without changing their Ant Design field names:

```jsx
<Form
  form={form}
  layout="vertical"
  autoComplete="off"
  onFinish={saveBinding}
  initialValues={{
    clientId: "",
    apiKey: "",
    label: "",
    apiKeyCreatedAt: todayDateOnly(),
  }}
>
```

```jsx
<Input
  prefix={<ApiOutlined />}
  placeholder="Ozon Client-Id"
  autoComplete="off"
  disabled={isEditingBindingStore}
/>
```

```jsx
<Input.Password
  prefix={<DatabaseOutlined className="bind-field-icon" />}
  placeholder="Ozon Api-Key"
  autoComplete="new-password"
/>
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test app/tests/store-binding-form-refresh.test.mjs
```

Expected: PASS with one test, zero failures, and no page errors. The existing test must still prove no binding submission occurs.

- [ ] **Step 5: Commit the focused fix**

```bash
git add app/src/App.jsx app/tests/store-binding-form-refresh.test.mjs
git commit -m "fix(app): prevent store credential autofill"
```

### Task 2: Build, regress and verify the running page

**Files:**
- Verify: `app/src/App.jsx`
- Verify: `app/tests/store-binding-form-refresh.test.mjs`
- No database, API, extension or server file changes.

**Interfaces:**
- Consumes: the DOM autocomplete contract from Task 1.
- Produces: verification evidence for build, project tests, the running page and rollback readiness.

- [ ] **Step 1: Build the frontend**

Run:

```bash
pnpm --dir app build
```

Expected: Vite build exits with code 0.

- [ ] **Step 2: Run the project verification gate**

Run:

```bash
pnpm verify
```

Expected: zero failed tests. PostgreSQL-only tests may be skipped only when the local PostgreSQL test configuration is absent, and the skip count must be reported.

- [ ] **Step 3: Restart only the frontend development service**

Stop the process listening on `127.0.0.1:3000`, start Vite from the current `main` working tree on the same address, and leave the backend on `127.0.0.1:3001` running. Confirm both ports are listening before browser verification.

- [ ] **Step 4: Verify the rendered DOM contract without submitting**

Open `http://127.0.0.1:3000/ozon/settings/stores/`, click “新增”, and inspect the actual inputs. Verify:

```text
form autocomplete = off
Client-Id autocomplete = off
Api-Key autocomplete = new-password
Client-Id value = empty
Api-Key value = empty
label value = empty
API Key creation date = current local date
```

Enter temporary Client-Id and label values, wait more than 15 seconds, confirm they remain unchanged, and close the modal without clicking “新增”.

- [ ] **Step 5: Confirm saved-login autofill no longer appears in the user browser**

Reload the existing local page that previously filled `admin` and the saved Web password, open “新增”, and confirm those credentials are no longer present. If a specific password manager ignores the standard metadata, stop and report that compatibility gap before considering the separately approved read-only/focus-unlock fallback.

- [ ] **Step 6: Record delivery and rollback information**

Report the exact changed files, DOM contract, focused test result, build result, full verification result, browser result, unverified scope and PostgreSQL skip count. Rollback is the single focused source/test commit from Task 1; no database recovery is required.
