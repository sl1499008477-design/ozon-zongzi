# Remove Selection and Watermark Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the selection and watermark business features from the Web app, extension, backend, and packaged artifacts while preserving normal selection controls, product metrics, capture, AI image generation, AI rewriting, and backend-only synchronization.

**Architecture:** Treat each retired feature as a vertical slice. First add negative contracts that prove the current feature still exists, then delete only the named routes, components, messages, state fields, files, and CSS selectors. Keep the extension-upstream parity model explicit by registering these removals as reviewed local retirements rather than weakening all parity checks.

**Tech Stack:** Node.js 24, React 19, Vite 6, Chrome Extension Manifest V3, Node test runner, PostgreSQL/JSON local state, existing extension packaging and verification scripts.

## Global Constraints

- Web, extension, and backend behavior must be removed together; no hidden routes, feature flags, or unreachable production code.
- Ordinary table-row selection, store selection, category selection, and product metrics are not part of the retired selection feature.
- AI image generation, AI product image sets, AI rewriting, capture, account-scoped collect box, and Web-owned synchronization must remain.
- Old Web paths resolve to the existing 404 page; removed backend endpoints use the existing `LOCAL_NOT_FOUND` 404 contract.
- Existing generic audit history remains; no keyword-based report or audit deletion is allowed.
- Current JSON and PostgreSQL state contain zero watermark templates, zero store watermark bindings, and zero selection reports.
- Source and packaged extension trees must both be free of the retired capabilities.
- Every production change starts with a failing test and ends with focused and full regression verification.
- Use `apply_patch` for source edits; packaging scripts may mechanically regenerate derived artifacts.
- Execute implementation in an isolated `codex/` worktree created with `superpowers:using-git-worktrees`.

---

## File Structure

### New test files

- `app/tests/removed-selection-watermark-ui.test.mjs` — Web route, menu, component, and CSS absence contract.
- `server/tests/removed-selection-watermark-routes.test.mjs` — backend 404 and legacy-state sanitization contract.
- `extension/tests/removed-selection-watermark-contract.test.js` — extension source, Manifest, message, and preserved-capability contract; also runs from packaged ZIPs.

### Web files

- `app/src/App.jsx` — remove route metadata, navigation entries, page dispatch, helpers, `CategoryPage`, `SelectionListPage`, and `WatermarkPage`; simplify AI menu label.
- `app/src/styles.css` — remove only `.selection-*`, `.watermark-*`, and the retired prototype groupings that reference those selectors.
- `app/src/local-runtime-state.js` — remove watermark summary/cache fields.

### Backend files

- `server/index.mjs` — remove watermark state/output fields, normalization, routes, and selection routes; strip legacy watermark fields during account-state normalization.
- `server/tests/cache-route-isolation.test.mjs` — remove the no-longer-valid watermark route/cache fixture while retaining all other isolation coverage.
- `server/tests/browser-agent-isolation.test.mjs` — remove obsolete empty watermark fixture key.
- `server/tests/external-write-safety.test.mjs` — remove obsolete empty watermark fixture key.

### Extension files

- Delete `extension/content/ozon-bestsellers-hook.js`.
- Delete `extension/lib/watermark-templates.js`.
- `extension/manifest.json` — remove both deleted file references and the Bestsellers-only content-script registration.
- `extension/content/ozon-seller-bridge.js` — remove only the Bestsellers category-mapping relay.
- `extension/content/ozon-product.js` — remove selection recommendations and all watermark controls/config/payload behavior.
- `extension/content/ozon-product.css` — remove recommendation and watermark selectors.
- `extension/content/ozon-search.js` and `extension/content/ozon-search.css` — remove stale selection-feature wording without removing capture/data-panel behavior.
- `extension/background/service-worker.js` — remove recommendation, Bestsellers, category-mapping, and watermark-template messages/requests/parameters.
- `extension/background/agent/listing-actions.js` — remove `watermarkTemplateId` command output.
- `extension/batch-upload/index.html` and `extension/batch-upload/index.js` — remove watermark UI, configuration, validation, loading, and payload fields; keep AI image/rewrite controls independent.
- `extension/lib/store-picker.js` — remove watermark-bound filters and chips; keep all ordinary store selection behavior.
- `extension/popup/popup.html` and `extension/popup/popup.js` — remove the watermark navigation cell and action path.
- `extension/popup/__tests__/popup-routing.smoke.test.js` — update the positive popup contract to exclude watermark.

### Parity and packaging files

- `scripts/check-extension-source-parity.mjs` — classify deleted upstream files as intentionally retired and new tests as local-only; register reviewed changed files.
- `scripts/check-extension-diff-contract.mjs` — register only the shared files changed by this removal.
- `scripts/check-extension-ui-parity.mjs` — replace exact equality for deliberately changed UI files with focused preservation/removal assertions; retain exact equality for untouched UI files.
- `scripts/check-extension-zip-smoke.mjs` — execute the new retired-feature contract inside each ZIP.
- Regenerate `app/public/sonli-extension-0.13.46.1/`.
- Regenerate `app/public/sonli-extension-0.13.46.1.zip`.
- Regenerate `app/dist/sonli-extension-0.13.46.1.zip`.

---

### Task 1: Remove Web Routes, Pages, Entries, and the AI Tag

**Files:**
- Create: `app/tests/removed-selection-watermark-ui.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `app/src/styles.css`
- Modify: `app/src/local-runtime-state.js`

**Interfaces:**
- Consumes: existing `App.jsx` route/menu definitions and existing `/404` fallback.
- Produces: no selection/watermark Web routes or entries; preserved AI, profit-trend, product, capture, and store-selection routes.

- [ ] **Step 1: Write the failing Web removal contract**

Create `app/tests/removed-selection-watermark-ui.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const runtimeState = await readFile(new URL("../src/local-runtime-state.js", import.meta.url), "utf8");

test("Web source contains no retired selection or watermark surface", () => {
  for (const pattern of [
    /\/ozon\/selection\//,
    /\/ozon\/tools\/watermark/,
    /function CategoryPage\b/,
    /function SelectionListPage\b/,
    /function WatermarkPage\b/,
    /label:\s*"选品"/,
    /label:\s*"类目分析"/,
    /label:\s*"榜单选品"/,
    /label:\s*"水印管理"/,
  ]) {
    assert.doesNotMatch(app, pattern);
  }
  assert.doesNotMatch(styles, /\.(?:selection|watermark)-[a-z0-9-]+/);
  assert.doesNotMatch(runtimeState, /watermarkTemplates/);
});

test("AI and non-selection business routes remain without the recommendation tag", () => {
  assert.match(app, /\/ozon\/tools\/ai-poster-records/);
  assert.match(app, /\/ozon\/ai-image/);
  assert.match(app, /\/ozon\/postings\/profit-trend/);
  assert.match(app, /label:\s*"AI 工具"/);
  assert.doesNotMatch(app, /AI 工具\s*<Tag[^>]*>\s*推荐\s*<\/Tag>/);
  assert.match(app, /\/ozon\/products\/collect/);
  assert.match(app, /\/ozon\/settings\/stores/);
});
```

- [ ] **Step 2: Run the Web contract and verify RED**

Run:

```bash
node --test app/tests/removed-selection-watermark-ui.test.mjs
```

Expected: FAIL because `App.jsx`, `styles.css`, and `local-runtime-state.js` still contain the retired routes, pages, menu entries, CSS, and runtime fields.

- [ ] **Step 3: Remove the Web production surface**

In `app/src/App.jsx`, delete:

- all `/ozon/selection/*` and `/ozon/tools/watermark` entries from `pageTitles`;
- the three selection aliases, including `/ozon/selection/profit`;
- the whole `menuItems` object with `key: "selection"`;
- only the `<Tag color="blue">推荐</Tag>` wrapper by changing the AI menu item to `label: "AI 工具"`;
- selection/watermark entries in `routeParent` and `featureLinks`;
- selection/watermark dispatch branches from `GenericPage`;
- `productSelectionSearchText`, `firstNumericValue`, `selectionProductId`, `selectionStrategySort`, and `selectionProductRows` if no non-retired caller remains;
- `CategoryPage`, `SelectionListPage`, `watermarkTypeOptions`, `watermarkFontOptions`, `watermarkPositionOptions`, `watermarkTypeLabel`, `watermarkFontFamily`, and `WatermarkPage`.

In `app/src/styles.css`, delete complete selector blocks rooted at:

```css
.selection-source-toolbar
.selection-control-group
.selection-strategy
.selection-extra-state
.selection-strategy-tags
.selection-china-note
.selection-market-filter
.selection-filter-label
.selection-filter-summary
.selection-bulk-row
.watermark-editor-modal
.watermark-editor-modal-wrap
.watermark-template-form
.watermark-steps
.watermark-page
.watermark-head-row
.watermark-flow
.watermark-flow-step
.watermark-stack
.watermark-template-card
.watermark-template-list
.watermark-template-actions
.watermark-preview-card
.watermark-preview-layout
.watermark-upload-column
.watermark-preview-canvas
.watermark-image-frame
.watermark-border-preview
.watermark-text-preview
```

Remove those selectors from combined responsive/prototype rules without deleting the remaining selectors in the same rule.

In `app/src/local-runtime-state.js`, remove `watermarkTemplates` from both `emptySummary()` and `emptyCaches()`.

- [ ] **Step 4: Verify GREEN and build**

Run:

```bash
node --test app/tests/removed-selection-watermark-ui.test.mjs
pnpm --dir app build
```

Expected: both commands PASS; Vite reports no unresolved identifiers.

- [ ] **Step 5: Commit the Web slice**

```bash
git add app/tests/removed-selection-watermark-ui.test.mjs app/src/App.jsx app/src/styles.css app/src/local-runtime-state.js
git commit -m "feat: remove selection and watermark web surfaces"
```

---

### Task 2: Remove Backend APIs and Active Watermark State

**Files:**
- Create: `server/tests/removed-selection-watermark-routes.test.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/cache-route-isolation.test.mjs`
- Modify: `server/tests/browser-agent-isolation.test.mjs`
- Modify: `server/tests/external-write-safety.test.mjs`

**Interfaces:**
- Consumes: `handle`, `testExports.ensureAccountState`, `/local/state`, and the existing `LOCAL_NOT_FOUND` response.
- Produces: 404 for retired APIs and no watermark fields in active or public runtime state.

- [ ] **Step 1: Write the failing backend behavior test**

Create a hermetic JSON fixture in `server/tests/removed-selection-watermark-routes.test.mjs` using the same `Readable` request helper pattern as `server/tests/extension-sync-removed.test.mjs`. The fixture must include:

```js
caches: {
  products: [],
  postings: [],
  warehouses: [],
  collectBox: [],
  watermarkTemplates: [{
    id: "watermark-a",
    accountId: "account-a",
    storeId: "store-a",
    name: "retired watermark",
  }],
},
stores: [{
  id: "store-a",
  ownerAccountId: "account-a",
  clientId: "client-a",
  apiKey: "secret-a",
  watermarkTemplateId: "watermark-a",
}],
```

Test these contracts:

```js
const removedRoutes = [
  ["GET", "/ozon/watermark-settings"],
  ["POST", "/ozon/watermark-settings"],
  ["PUT", "/ozon/watermark-settings/watermark-a"],
  ["DELETE", "/ozon/watermark-settings/watermark-a"],
  ["POST", "/ozon/selection/bestsellers/snapshot"],
  ["POST", "/ozon/selection/category-mapping"],
];

test("retired selection and watermark APIs use the generic 404 contract", async () => {
  for (const [method, pathname] of removedRoutes) {
    const response = await requestJson(method, pathname, {});
    assert.equal(response.status, 404, `${method} ${pathname}`);
    assert.equal(response.body.code, "LOCAL_NOT_FOUND", `${method} ${pathname}`);
  }
});

test("legacy watermark fields are stripped from active and public state", async () => {
  const normalized = testExports.ensureAccountState(structuredClone(fixture));
  assert.equal(Object.hasOwn(normalized.caches, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(normalized.stores[0], "watermarkTemplateId"), false);

  const state = await requestJson("GET", "/local/state", undefined);
  assert.equal(state.status, 200);
  assert.equal(Object.hasOwn(state.body.caches, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(state.body.summary, "watermarkTemplates"), false);
  assert.equal(Object.hasOwn(state.body.stores[0], "watermarkTemplateId"), false);
});
```

The test must set `QH_LOCAL_NO_LISTEN=1`, `QH_LOCAL_NO_DOTENV=1`, remove PostgreSQL environment variables, and clean its temporary directory in `test.after`.

- [ ] **Step 2: Run the backend test and verify RED**

Run:

```bash
node --test server/tests/removed-selection-watermark-routes.test.mjs
```

Expected: FAIL because the retired routes return 200 and watermark fields remain in runtime state.

- [ ] **Step 3: Remove backend behavior**

In `server/index.mjs`:

- remove `watermarkTemplates` from `defaultState().caches`;
- in `ensureAccountState`, delete `state.caches.watermarkTemplates` and strip `watermarkTemplateId` while mapping each store;
- remove `watermarkTemplateId` from `publicStore`;
- remove the watermark count from `summarize`;
- remove watermark cache exposure from `localStatePayload`;
- delete `normalizeWatermarkTemplate`;
- delete all four watermark-settings route handlers;
- delete both selection route handlers.

Use an explicit legacy strip in the existing store map:

```js
state.caches = state.caches && typeof state.caches === "object" ? state.caches : {};
delete state.caches.watermarkTemplates;
state.stores = state.stores.map((store) => {
  const { watermarkTemplateId: _retiredWatermarkTemplateId, ...activeStoreFields } = store;
  return {
    ...activeStoreFields,
    ownerAccountId: resolveLegacyStoreOwner(activeStoreFields, state.accounts),
  };
});
```

Do not delete reports or audit events by text or type.

Remove only obsolete watermark fixture keys and route expectations from the three existing server tests; retain their other account-isolation and external-write assertions.

- [ ] **Step 4: Verify GREEN and server regression**

Run:

```bash
node --test server/tests/removed-selection-watermark-routes.test.mjs
node --test server/tests/cache-route-isolation.test.mjs server/tests/browser-agent-isolation.test.mjs server/tests/external-write-safety.test.mjs
node --check server/index.mjs
```

Expected: all tests and syntax checks PASS.

- [ ] **Step 5: Commit the backend slice**

```bash
git add server/index.mjs server/tests/removed-selection-watermark-routes.test.mjs server/tests/cache-route-isolation.test.mjs server/tests/browser-agent-isolation.test.mjs server/tests/external-write-safety.test.mjs
git commit -m "feat: retire selection and watermark backend contracts"
```

---

### Task 3: Remove Extension Selection Capability

**Files:**
- Create: `extension/tests/removed-selection-watermark-contract.test.js`
- Delete: `extension/content/ozon-bestsellers-hook.js`
- Modify: `extension/manifest.json`
- Modify: `extension/content/ozon-seller-bridge.js`
- Modify: `extension/content/ozon-product.js`
- Modify: `extension/content/ozon-product.css`
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/content/ozon-search.css`
- Modify: `extension/background/service-worker.js`

**Interfaces:**
- Consumes: existing action bar, seller bridge, service-worker message switch, and Manifest content-script registrations.
- Produces: no recommendation UI, Bestsellers hook, category-mapping relay, or selection-specific background messages; preserved capture and product metrics.

- [ ] **Step 1: Write the failing extension selection contract**

Create the CommonJS test file and load sources with `fs.readFileSync`. Add:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const product = read("content/ozon-product.js");
const productCss = read("content/ozon-product.css");
const search = read("content/ozon-search.js");
const serviceWorker = read("background/service-worker.js");
const sellerBridge = read("content/ozon-seller-bridge.js");

assert(!fs.existsSync(path.join(root, "content/ozon-bestsellers-hook.js")));
assert(!manifest.content_scripts.some((entry) =>
  entry.js?.includes("content/ozon-bestsellers-hook.js")
  || entry.matches?.some((match) => match.includes("ozon-bestsellers"))
));
for (const source of [product, productCss, serviceWorker, sellerBridge]) {
  assert(!/选品推荐|recommendation-panel|getRecommendations|fetchBestsellers|reportCategoryMapping|JZC_BESTSELLERS_REPORT/.test(source));
}
assert(!/选品模式/.test(search));

assert(product.includes("一键采集"));
assert(product.includes("利润"));
assert(product.includes("OZON以图搜图"));
assert(serviceWorker.includes("getCollectCount"));
assert(serviceWorker.includes("getProductStatusCounts"));
assert(sellerBridge.includes("JZC_PREMIUM_QUERY"));
```

Watermark assertions are added to this same file in Task 4; during Task 3 the file covers selection only.

- [ ] **Step 2: Run the extension contract and verify RED**

Run:

```bash
node extension/tests/removed-selection-watermark-contract.test.js
```

Expected: FAIL because the hook file, Manifest registration, recommendation UI, and messages still exist.

- [ ] **Step 3: Remove selection code**

- delete `extension/content/ozon-bestsellers-hook.js`;
- remove its Bestsellers-only `content_scripts` entry from `manifest.json`;
- remove the `JZC_BESTSELLERS_REPORT` branch and Bestsellers comments from `ozon-seller-bridge.js`, preserving every Premium branch;
- remove recommendation button creation, `_recBtn` state, panel cleanup selector, panel functions, `openRecommendations` listener, and recommendation CSS from `ozon-product.js`/`.css`;
- remove `fetchBestsellers`, `reportCategoryMapping`, and `getRecommendations` cases from `service-worker.js`;
- remove stale “选品模式” wording from `ozon-search.js`/`.css` without changing runtime search capture or data-panel code.

- [ ] **Step 4: Verify GREEN and preserved extension syntax**

Run:

```bash
node extension/tests/removed-selection-watermark-contract.test.js
node --check extension/background/service-worker.js
node --check extension/content/ozon-product.js
node --check extension/content/ozon-seller-bridge.js
node --check extension/content/ozon-search.js
```

Expected: contract and all syntax checks PASS.

- [ ] **Step 5: Commit the extension selection slice**

```bash
git add extension/manifest.json extension/content/ozon-seller-bridge.js extension/content/ozon-product.js extension/content/ozon-product.css extension/content/ozon-search.js extension/content/ozon-search.css extension/background/service-worker.js extension/tests/removed-selection-watermark-contract.test.js
git add -u extension/content/ozon-bestsellers-hook.js
git commit -m "feat: remove extension selection capability"
```

---

### Task 4: Remove Extension Watermark Capability

**Files:**
- Delete: `extension/lib/watermark-templates.js`
- Modify: `extension/tests/removed-selection-watermark-contract.test.js`
- Modify: `extension/manifest.json`
- Modify: `extension/popup/popup.html`
- Modify: `extension/popup/popup.js`
- Modify: `extension/popup/__tests__/popup-routing.smoke.test.js`
- Modify: `extension/batch-upload/index.html`
- Modify: `extension/batch-upload/index.js`
- Modify: `extension/content/ozon-product.js`
- Modify: `extension/content/ozon-product.css`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/background/agent/listing-actions.js`
- Modify: `extension/lib/store-picker.js`

**Interfaces:**
- Consumes: listing configuration, batch upload, store picker, popup routing, and service-worker requests.
- Produces: listing contracts with AI image/rewrite but no watermark fields or UI.

- [ ] **Step 1: Extend the contract and verify RED**

Add these assertions to `extension/tests/removed-selection-watermark-contract.test.js`:

```js
const popupHtml = read("popup/popup.html");
const popupJs = read("popup/popup.js");
const batchHtml = read("batch-upload/index.html");
const batchJs = read("batch-upload/index.js");
const listingActions = read("background/agent/listing-actions.js");
const storePicker = read("lib/store-picker.js");

assert(!fs.existsSync(path.join(root, "lib/watermark-templates.js")));
assert(!manifest.content_scripts.some((entry) =>
  entry.js?.includes("lib/watermark-templates.js")
));
for (const source of [
  popupHtml,
  popupJs,
  batchHtml,
  batchJs,
  product,
  productCss,
  serviceWorker,
  listingActions,
  storePicker,
]) {
  assert(!/watermark|水印|边框模板|未绑水印|已绑水印/i.test(source));
}
assert(batchHtml.includes("AI 大模型改图"));
assert(batchHtml.includes("SEO"));
assert(batchJs.includes("cfg-ai-poster"));
assert(batchJs.includes("cfg-ai-rewrite"));
assert(product.includes("apply-poster"));
assert(product.includes("apply-ai-rewrite"));
```

Run:

```bash
node extension/tests/removed-selection-watermark-contract.test.js
```

Expected: FAIL because watermark files, controls, fields, and messages still exist.

- [ ] **Step 2: Remove the popup and Manifest surface**

- delete `extension/lib/watermark-templates.js`;
- remove it from the Manifest script list;
- remove the watermark navigation button from `popup.html`;
- remove its `ACTION_PATHS` entry from `popup.js`;
- remove the positive watermark action/route assertions from `popup-routing.smoke.test.js`.

- [ ] **Step 3: Remove watermark from batch upload**

In `batch-upload/index.html`, remove the complete “水印/边框” AI row and the script tag for `watermark-templates.js`; rewrite the help sentence to mention only AI image generation and SEO rewrite.

In `batch-upload/index.js`, remove:

- `storeWatermarkTemplateIds`;
- `cfg-watermark` and `cfg-watermark-template` reads/restores;
- store watermark binding reads;
- missing-template validation;
- `applyWatermark` and `watermarkTemplateId` request/config fields;
- template loading;
- watermark contribution to enabled-feature counts;
- watermark checkbox listeners.

Keep `cfg-ai-poster` and `cfg-ai-rewrite` as the complete AI-enhancement set.

- [ ] **Step 4: Remove watermark from single-product listing and shared extension runtime**

In `content/ozon-product.js` and `.css`, remove:

- watermark saved config;
- watermark selector/toggle markup;
- template loading and selection restore;
- store binding validation;
- watermark payload fields;
- watermark-only CSS.

Update any AI-panel “any enabled” arrays from:

```js
["apply-watermark", "apply-poster", "apply-ai-rewrite"]
```

to:

```js
["apply-poster", "apply-ai-rewrite"]
```

In `background/service-worker.js`, remove the watermark-settings fetch, watermark logging, and `watermarkTemplateId` forwarding. In `background/agent/listing-actions.js`, remove the watermark parameter output. In `lib/store-picker.js`, remove `bound`, “未绑水印”, “已绑水印”, and their filter/chip counts while retaining “全部”, “已选”, “最近”, and “Premium”.

- [ ] **Step 5: Verify GREEN and focused preserved behavior**

Run:

```bash
node extension/tests/removed-selection-watermark-contract.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
node --check extension/background/service-worker.js
node --check extension/background/agent/listing-actions.js
node --check extension/batch-upload/index.js
node --check extension/content/ozon-product.js
node --check extension/lib/store-picker.js
```

Expected: all commands PASS and AI image/rewrite preservation assertions remain green.

- [ ] **Step 6: Commit the extension watermark slice**

```bash
git add extension/manifest.json extension/popup/popup.html extension/popup/popup.js extension/popup/__tests__/popup-routing.smoke.test.js extension/batch-upload/index.html extension/batch-upload/index.js extension/content/ozon-product.js extension/content/ozon-product.css extension/background/service-worker.js extension/background/agent/listing-actions.js extension/lib/store-picker.js extension/tests/removed-selection-watermark-contract.test.js
git add -u extension/lib/watermark-templates.js
git commit -m "feat: remove extension watermark capability"
```

---

### Task 5: Preserve Strict Parity While Registering Reviewed Retirements

**Files:**
- Modify: `scripts/check-extension-source-parity.mjs`
- Modify: `scripts/check-extension-diff-contract.mjs`
- Modify: `scripts/check-extension-ui-parity.mjs`
- Modify: `scripts/check-extension-zip-smoke.mjs`

**Interfaces:**
- Consumes: upstream extension path and local/package parity contracts.
- Produces: strict parity for untouched files plus explicit allowlisting and negative assertions for the retired files/capabilities.

- [ ] **Step 1: Run parity gates and verify RED**

Run with the verified upstream path:

```bash
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" QH_DISTRIBUTED_EXTENSION_DIR="extension" node scripts/check-extension-source-parity.mjs
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/check-extension-ui-parity.mjs
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/check-extension-diff-contract.mjs
```

Expected: FAIL on the newly deleted upstream files, new local-only contract test, and deliberately changed UI files.

- [ ] **Step 2: Register exact reviewed changes**

In `check-extension-source-parity.mjs`:

- add `content/ozon-bestsellers-hook.js` and `lib/watermark-templates.js` to `intentionallyRetiredFiles`;
- add `tests/removed-selection-watermark-contract.test.js` to `allowedLocalOnly`;
- add these changed shared files to `allowedDiffs`:

```text
background/agent/listing-actions.js
content/ozon-product.css
content/ozon-search.css
content/ozon-seller-bridge.js
lib/store-picker.js
```

The complete reviewed changed-file set is:

```text
background/agent/listing-actions.js
background/service-worker.js
batch-upload/index.html
batch-upload/index.js
content/1688-ai-wizard.js
content/alibaba-1688.js
content/jizhangerp-bridge.js
content/jzc-calc.js
content/ozon-data-panel.js
content/ozon-premium-hook.js
content/ozon-product.css
content/ozon-product.js
content/ozon-search.css
content/ozon-search.js
content/ozon-seller-bridge.js
content/shared-utils.js
content/sync-auth.js
icons/icon128.png
icons/icon16.png
icons/icon48.png
lib/cn-source-panel.js
lib/store-picker.js
manifest.json
popup/popup.css
popup/popup.html
popup/popup.js
tests/fleet-collect-attrs-merge.test.js
```

Keep this set literal; do not replace it with directory-wide matching.

In `check-extension-diff-contract.mjs`, add the same changed shared files to `reviewedChangedFiles`; do not add directory-wide globs.

In `check-extension-ui-parity.mjs`:

- remove `content/ozon-product.css` and `content/ozon-search.css` from `exactUiFiles`;
- stop brand-only exact comparison for `batch-upload/index.html` and `batch-upload/index.js`;
- add focused assertions that local files contain no retired selection/watermark tokens and still contain the required AI/capture tokens;
- retain exact equality for `batch-upload/index.css`, `content/jzc-calc.css`, and `lib/store-picker.css`.

In `check-extension-zip-smoke.mjs`, add:

```js
["retired selection/watermark contract", path.join(tmpDir, "tests", "removed-selection-watermark-contract.test.js")]
```

to the packaged smoke test list.

- [ ] **Step 3: Verify parity gates GREEN**

Run the three commands from Step 1 again.

Expected: all PASS; any unlisted changed file still fails closed.

- [ ] **Step 4: Commit parity contracts**

```bash
git add scripts/check-extension-source-parity.mjs scripts/check-extension-diff-contract.mjs scripts/check-extension-ui-parity.mjs scripts/check-extension-zip-smoke.mjs
git commit -m "test: gate retired selection and watermark capabilities"
```

---

### Task 6: Regenerate Distribution Artifacts and Validate Packages

**Files:**
- Regenerate: `app/public/sonli-extension-0.13.46.1/`
- Regenerate: `app/public/sonli-extension-0.13.46.1.zip`
- Regenerate locally for ZIP verification: `app/dist/sonli-extension-0.13.46.1.zip` (ignored by Git)

**Interfaces:**
- Consumes: the cleaned `extension/` tree.
- Produces: exact unpacked and ZIP copies without the retired files or capabilities.

- [ ] **Step 1: Confirm current distributions are stale**

Run:

```bash
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/check-extension-source-parity.mjs
node scripts/check-extension-zip.mjs
```

Expected before regeneration: FAIL because the distribution still contains deleted files or stale changed content.

- [ ] **Step 2: Regenerate artifacts**

Run:

```bash
node scripts/package-extension.mjs
```

Expected: the unpacked public directory and both ZIP paths are packaged successfully from `extension/`.

- [ ] **Step 3: Validate source/distribution/ZIP parity and packaged behavior**

Run:

```bash
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" node scripts/check-extension-source-parity.mjs
node scripts/check-extension-zip.mjs
node scripts/check-extension-zip-smoke.mjs
node scripts/check-plugin-readiness-gate.mjs
```

Expected: all PASS; both ZIPs execute the retired-feature negative contract.

- [ ] **Step 4: Commit generated artifacts**

```bash
git add app/public/sonli-extension-0.13.46.1 app/public/sonli-extension-0.13.46.1.zip
git commit -m "build: package extension without retired features"
```

---

### Task 7: Full Verification, Browser Regression, and Delivery Record

**Files:**
- Create: `docs/superpowers/verification/2026-07-30-remove-selection-watermark.md`

**Interfaces:**
- Consumes: all earlier task outputs.
- Produces: evidence-backed completion record, running local service, and rollback information.

- [ ] **Step 1: Run focused removal and preservation tests**

Run:

```bash
node --test app/tests/removed-selection-watermark-ui.test.mjs
node --test server/tests/removed-selection-watermark-routes.test.mjs
node extension/tests/removed-selection-watermark-contract.test.js
node extension/popup/__tests__/popup-routing.smoke.test.js
```

Expected: all PASS.

- [ ] **Step 2: Run the complete project verification**

Run with the same hermetic environment used by the last successful main-branch verification:

```bash
QH_LOCAL_NO_DOTENV=1 \
QH_SOURCE_EXTENSION_DIR="/Users/songliang/Desktop/0.13.46.1" \
POSTGRES_PASSWORD="vfy-Pg-20260730-Alpha9" \
POSTGRES_PORT=35432 \
MINIO_ACCESS_KEY="vfy-minio-user" \
MINIO_SECRET_KEY="vfy-Minio-20260730-Beta9" \
MINIO_PORT=39000 \
MINIO_CONSOLE_PORT=39001 \
APP_ENCRYPTION_KEY="vfy-Encryption-Key-20260730-Gamma-123456789" \
SONLI_ADMIN_PASSWORD="vfy-Admin-20260730-Delta9" \
WEB_PORT=3200 \
node scripts/verify.mjs
```

Expected: all verification gates PASS; the generic PostgreSQL integration skip remains explicitly reported if the dedicated database URL is not supplied.

- [ ] **Step 3: Restart and test the local application**

Start the API, worker, frontend compatibility proxy, and Vite frontend from the completed branch. Verify:

```text
GET http://127.0.0.1:3000/                                      -> 200
GET http://127.0.0.1:3000/ozon/selection/category               -> Web 404 page
GET http://127.0.0.1:3000/ozon/selection/top-list               -> Web 404 page
GET http://127.0.0.1:3000/ozon/selection/china                  -> Web 404 page
GET http://127.0.0.1:3000/ozon/tools/watermark                  -> Web 404 page
POST http://127.0.0.1:3001/ozon/selection/category-mapping      -> 404 LOCAL_NOT_FOUND
GET http://127.0.0.1:3001/ozon/watermark-settings               -> 404 LOCAL_NOT_FOUND
GET http://127.0.0.1:3001/health                                -> 200
```

Use browser snapshots to confirm:

- no “选品” menu;
- no “类目分析”, “榜单选品”, “中国专区”, or “水印管理” dashboard/menu entry;
- AI menu text is exactly “AI 工具” with no “推荐” tag;
- AI pages, collect box, product list, and store selection still open.

- [ ] **Step 4: Write the verification record**

Create `docs/superpowers/verification/2026-07-30-remove-selection-watermark.md` with:

- commit list and changed contracts;
- focused test commands and exact pass/fail counts;
- full verification result;
- browser and HTTP results;
- old-extension compatibility note;
- unverified scope and reason;
- rollback using Git revert and extension repackaging.

- [ ] **Step 5: Final clean-tree and residual scans**

Run:

```bash
git diff --check
git status --short
rg -n "/ozon/selection/|/ozon/tools/watermark|选品推荐|watermark-settings|watermarkTemplateId|applyWatermark|ozon-bestsellers-hook" app/src server extension app/public/sonli-extension-0.13.46.1 --glob '!**/removed-selection-watermark-contract.test.js'
```

Expected: no production/runtime match. Matches in design, plan, verification, and negative tests are allowed and must be reviewed explicitly.

- [ ] **Step 6: Commit verification evidence**

```bash
git add docs/superpowers/verification/2026-07-30-remove-selection-watermark.md
git commit -m "docs: verify selection and watermark removal"
```

- [ ] **Step 7: Finish the branch**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`, then `superpowers:finishing-a-development-branch`. Present the verified merge/PR/keep/discard options without claiming completion before the final verification exits successfully.
