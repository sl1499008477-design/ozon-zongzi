# Capture-only Extension Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Web extension page preview the packaged capture-only popup and permanently remove its stale login/sync surface.

**Architecture:** A small application contract module owns the extension version,
download URL, canonical unpacked popup URL and capability labels. `PluginPanel`
renders that contract; a behavior test validates the contract against real public
artifacts, while plugin readiness provides a supplemental wiring/literal gate.

**Tech Stack:** React 19, Vite 6, Node.js built-in test runner.

## Global Constraints

- Do not modify the Task 12 verification document or SDD progress ledger.
- Do not hand-edit the generated `sonli-extension-0.13.46.1` directory or ZIP.
- Delete the unowned `app/public/plugin/` surface only after all references move.
- Preserve the current extension ZIP bytes because extension source is unchanged.

---

### Task 1: Canonical capture-only preview contract

**Files:**
- Create: `app/src/extension-page-contract.mjs`
- Create: `app/tests/extension-page-capture-only.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `scripts/check-plugin-readiness-gate.mjs`
- Delete: `app/public/plugin/popup.html`
- Delete: `app/public/plugin/popup.css`
- Delete: `app/public/plugin/popup.js`

**Interfaces:**
- Produces: `EXTENSION_VERSION: string`, `EXTENSION_DOWNLOAD_PATH: string`,
  `EXTENSION_POPUP_PREVIEW_PATH: string`, and frozen
  `EXTENSION_CAPABILITIES: readonly [string, string][]`.
- Consumes: the tracked unpacked extension directory under `app/public`.

- [ ] **Step 1: Write the failing behavior test**

Import the four contract exports, resolve the preview URL inside `app/public`, and
assert that the target contains `请先登录 Web 管理后台，再使用采集功能`, contains
neither SMS nor password inputs, no `app/public/plugin` directory exists, and the
capability labels contain neither `同步` nor `Cookie`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/tests/extension-page-capture-only.test.mjs
```

Expected: failure because the contract module does not exist and the stale plugin
directory/route still exists.

- [ ] **Step 3: Implement the minimal contract and page migration**

Create the frozen contract values, import them into `App.jsx`, replace the
hard-coded download/preview/version/capability values, delete `app/public/plugin`,
and extend plugin readiness to reject `/plugin/popup.html`, retired labels and a
PluginPanel that does not consume the shared contract.

- [ ] **Step 4: Run focused and relevant regression gates**

Run:

```bash
node --test app/tests/extension-page-capture-only.test.mjs
node scripts/check-plugin-readiness-gate.mjs
pnpm --dir app build
QH_SOURCE_EXTENSION_DIR=/Users/songliang/Desktop/0.13.46.1 node scripts/check-extension-source-parity.mjs
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
git diff --check
```

Expected: all commands exit zero; both extension ZIP hashes stay unchanged.

- [ ] **Step 5: Commit**

Stage only the new contract/test, `App.jsx`, plugin readiness, stale plugin
deletions and these approved design/plan documents. Commit with:

```bash
git commit -m "fix: use capture-only extension preview"
```
