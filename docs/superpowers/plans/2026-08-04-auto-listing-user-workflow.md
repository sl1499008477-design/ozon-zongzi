# Auto Listing User Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver the ordinary-user “自动上架” page under “AI 工具”, with collect-box push, Excel SKU import, account preferences, clear batch progress, generated-content review, and no exposure of AI internals.

**Architecture:** The React page is a focused module outside App.jsx and consumes stable task/import DTOs. Account preferences are stored server-side and revalidated for every job. Excel files are uploaded as bounded base64 JSON, stored for traceability, parsed by a focused ExcelJS service, and processed row-by-row by a durable source-import worker that reuses the same SKU collection service as the existing collect-box route.

**Tech Stack:** React 19, Ant Design 6, current client transport, Node.js ESM, ExcelJS, PostgreSQL, pg-boss, current collection/enrichment pipeline, node:test, Vite.

## Global Constraints

- Complete plans 1 and 2 first. Do not invent a second source-snapshot, strategy, or generation implementation.
- Follow AGENTS.md: backend scope validation, raw import traceability, idempotent collection, row-level failures, stable contracts, recoverable jobs, and explicit verification.
- Ordinary users configure target store, active FBS warehouse, stock, signed price adjustment, and approved image parameters only. They do not see strategy style, prompts, model routes, gateway keys, or model credentials.
- The collect-box action does not immediately upload to Ozon. It opens the auto-listing page with selected source IDs, shows frozen configuration, and creates the generation task after one user confirmation.
- Excel rows use the current account-level collection flow. One invalid/failing SKU does not block valid rows.
- Keep the spreadsheet row cap configurable as an operational safety limit, not an Ozon business rule. Default AUTO_LISTING_EXCEL_MAX_ROWS=1000 and AUTO_LISTING_EXCEL_MAX_BYTES=2097152; show the configured limit in validation errors.
- Only backend-annotated listingEligibility.eligible=true warehouses for the selected store can be selected.
- App.jsx changes must stay limited to import, route title/type, menu item, route dispatch, and the collect-box action. Substantial page code lives in new modules.
- Preserve unrelated worktree changes.

## Dependency and Stable Output

This is plan 3 of 4. It depends on plans 1 and 2 and provides a complete review-mode user flow. Ozon submission buttons are connected in plan 4.

---

## Task 1: Add Account Preferences and Traceable Excel Imports

**Files:**
- Create: server/db/migrations/028_auto_listing_user_workflow.sql
- Create: server/tests/auto-listing-user-workflow-migration.test.mjs

**Interfaces:** auto_listing_preferences, auto_listing_import_files, auto_listing_import_rows, auto_listing_source_outbox.

- [ ] **Step 1: Write a failing migration-contract test**

Assert account-scoped preference uniqueness; imported file hash/object key/name/type/size; row number/raw SKU/normalized SKU/status/error/collect item/job references; source outbox dedupe/lease fields; indexes; additive SQL; and no workbook binary stored in PostgreSQL.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-user-workflow-migration.test.mjs
~~~

- [ ] **Step 3: Create migration 028**

auto_listing_preferences has account_id as primary key plus target_store_id, target_warehouse_id, stock, price_adjustment_kopecks, image_config JSONB, config_version, updated_by, and timestamps. This is a convenience default, not trusted task configuration; job creation revalidates it and freezes a copy.

auto_listing_import_files stores account, source file metadata, file hash, object-storage key, row totals, import status, config snapshot/hash, idempotency key, created_by, correlation ID, optional generated job ID, and timestamps. Unique(account_id, idempotency_key).

auto_listing_import_rows stores import/account, one-based worksheet row, raw/normalized SKU, status, attempt_count, collect_item_id, auto_listing_item_id, stable error fields, and timestamps. Unique(import_file_id, row_number) and unique(import_file_id, normalized_sku) after deduplication policy.

auto_listing_source_outbox stores one durable COLLECT_EXCEL_SKU event per normalized SKU with dedupe key, availability, lease, attempts, last error, and timestamps.

- [ ] **Step 4: Run contract/configured migration and commit**

~~~bash
node --test server/tests/auto-listing-user-workflow-migration.test.mjs
AUTO_LISTING_POSTGRES_TESTS=1 node server/db/migrate.mjs
git add server/db/migrations/028_auto_listing_user_workflow.sql server/tests/auto-listing-user-workflow-migration.test.mjs
git commit -m "feat: add auto listing user workflow data"
~~~

---

## Task 2: Parse and Validate SKU Workbooks

**Files:**
- Create: server/auto-listing-excel-import.mjs
- Create: server/tests/auto-listing-excel-import.test.mjs
- Create: server/tests/fixtures/auto-listing-skus.xlsx

**Interfaces:** parseAutoListingSkuWorkbook({ buffer, name, contentType, maxRows }).

- [ ] **Step 1: Write failing parser tests**

Generate fixture workbooks in the test and cover:

- first visible worksheet;
- case/space-insensitive headers SKU, 商品 SKU, and Ozon SKU;
- numeric and text cells normalized without scientific notation;
- leading/trailing spaces removed;
- blank rows ignored;
- duplicate SKU keeps the first row and records later rows as DUPLICATE_IN_FILE;
- invalid SKU cell gets INVALID_SKU with row number;
- missing header, encrypted/corrupt workbook, empty workbook, oversized rows/file, formulas without cached value, and unsupported extension get stable codes;
- no cell formula or external link is executed.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-excel-import.test.mjs
~~~

- [ ] **Step 3: Implement a focused ExcelJS parser**

Do not extend collector-excel-service.mjs, which owns a different 63-column export use case. Return:

~~~js
{
  sheetName: "Sheet1",
  acceptedRows: [{ rowNumber: 2, rawSku: " 12345 ", sku: "12345" }],
  rejectedRows: [{ rowNumber: 4, rawSku: "", code: "INVALID_SKU" }],
  duplicateRows: [{ rowNumber: 6, sku: "12345", firstRowNumber: 2 }],
  totals: { rows: 5, accepted: 1, rejected: 3, duplicates: 1 },
}
~~~

Keep validation deterministic and independent of database/collection work.

- [ ] **Step 4: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-excel-import.test.mjs
git add server/auto-listing-excel-import.mjs server/tests/auto-listing-excel-import.test.mjs server/tests/fixtures/auto-listing-skus.xlsx
git commit -m "feat: parse auto listing SKU workbooks"
~~~

---

## Task 3: Reuse One SKU Collection Service for UI and Excel

**Files:**
- Create: server/ozon-sku-collection-service.mjs
- Create: server/auto-listing-import-service.mjs
- Create: server/auto-listing-import-queue.mjs
- Create: server/auto-listing-import-worker.mjs
- Modify: server/index.mjs
- Modify: package.json
- Create: server/tests/ozon-sku-collection-service.test.mjs
- Create: server/tests/auto-listing-import-service.test.mjs
- Create: server/tests/auto-listing-import-worker.test.mjs

**Interfaces:** collectOzonSkuForAccount, createExcelImport, processExcelImportRow, finalizeExcelImport.

- [ ] **Step 1: Write characterization tests for the existing scrape route behavior**

Capture success and scrape-failure behavior now implemented inline at POST /ozon/collect-box/scrape: account authentication, SKU validation, normalizeCollectItem, account-scoped persistence, public response shape, and enrichment scheduling. These tests must pass before extraction.

- [ ] **Step 2: Extract the behavior without changing the route contract**

Move the business operation into collectOzonSkuForAccount with injected scraper and persistence dependencies. Keep server/index.mjs as a thin HTTP adapter. Run the characterization tests and existing collection tests before adding Excel behavior.

- [ ] **Step 3: Write failing import-service/worker tests**

Prove:

- file bytes stored under account/import-scoped object keys and verified by SHA-256;
- same account/file hash/config hash returns the same import;
- other accounts do not collide;
- every accepted SKU gets a durable source outbox row;
- retries call the same scoped SKU collection service;
- collection success waits for the current enrichment/category readiness required by source snapshot creation;
- finalization creates one auto-listing job from ready collect IDs using the file/config idempotency key;
- invalid/failed rows remain visible and valid siblings continue;
- cancellation stops new collection calls;
- cross-account import/collect records are impossible.

- [ ] **Step 4: Confirm RED for new import behavior**

~~~bash
node --test server/tests/auto-listing-import-service.test.mjs server/tests/auto-listing-import-worker.test.mjs
~~~

- [ ] **Step 5: Implement durable import processing**

Use queue auto-listing-source-v1. Worker payload is accountId, importId, rowId, expected attempt/status version, and correlationId. Reload row/import/config under account scope. Call collectOzonSkuForAccount, then current enrichment/category services; persist collect_item_id and readiness outcome.

When all rows are terminal, call createAutoListingJob with SOURCE_READY collect IDs. If none are ready, mark the import BLOCKED and do not create an empty job.

- [ ] **Step 6: Add the worker script and run tests**

Add:

~~~json
"auto-listing-import-worker": "node server/auto-listing-import-worker.mjs"
~~~

~~~bash
node --test server/tests/ozon-sku-collection-service.test.mjs server/tests/auto-listing-import-service.test.mjs server/tests/auto-listing-import-worker.test.mjs
~~~

- [ ] **Step 7: Commit**

~~~bash
git add server/ozon-sku-collection-service.mjs server/auto-listing-import-service.mjs server/auto-listing-import-queue.mjs server/auto-listing-import-worker.mjs server/index.mjs package.json server/tests/ozon-sku-collection-service.test.mjs server/tests/auto-listing-import-service.test.mjs server/tests/auto-listing-import-worker.test.mjs
git commit -m "feat: collect Excel SKUs for auto listing"
~~~

---

## Task 4: Expose Preferences, Excel Import, Task Actions, and Review DTOs

**Files:**
- Modify: server/auto-listing-routes.mjs
- Modify: server/auto-listing-runtime.mjs
- Create: server/auto-listing-view.mjs
- Create: server/tests/auto-listing-user-routes.test.mjs
- Create: server/tests/auto-listing-view.test.mjs

**Interfaces:** preferences, base64 workbook upload, import status, retry/regenerate/cancel, review detail.

- [ ] **Step 1: Write failing route/view tests**

Assert account scope, active-FBS revalidation, image/config validation, upload file size before base64 decode, safe Excel errors, import idempotency, row-level status, safe task review details, retryable-action rules, and absence of prompts, keys, raw payloads, internal object keys, or foreign account data.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test server/tests/auto-listing-user-routes.test.mjs server/tests/auto-listing-view.test.mjs
~~~

- [ ] **Step 3: Add stable user routes**

~~~text
GET  /auto-listing/preferences
PUT  /auto-listing/preferences
POST /auto-listing/imports/excel
GET  /auto-listing/imports/:importId
POST /auto-listing/imports/:importId/retry
POST /auto-listing/items/:itemId/regenerate
POST /auto-listing/items/:itemId/retry
POST /auto-listing/items/:itemId/cancel
GET  /auto-listing/items/:itemId/review
~~~

Excel request:

~~~json
{
  "name": "skus.xlsx",
  "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "dataBase64": "...",
  "config": {}
}
~~~

Reject estimated/decoded bytes above AUTO_LISTING_EXCEL_MAX_BYTES before ExcelJS parsing. The import stores the original workbook in object storage and returns row summaries, not file bytes.

- [ ] **Step 4: Define review DTO**

Expose source title/SKU/thumbnail, visual groups, generated accepted-image signed/read URLs, per-image role/check status, rich-content preview, calculation detail, target store/warehouse/stock, strategy display summary, item status/error/action availability, and event timeline. Do not expose prompts or raw checker reasoning.

- [ ] **Step 5: Confirm GREEN and commit**

~~~bash
node --test server/tests/auto-listing-user-routes.test.mjs server/tests/auto-listing-view.test.mjs
git add server/auto-listing-routes.mjs server/auto-listing-runtime.mjs server/auto-listing-view.mjs server/tests/auto-listing-user-routes.test.mjs server/tests/auto-listing-view.test.mjs
git commit -m "feat: expose auto listing user workflow"
~~~

---

## Task 5: Build Pure Frontend Models and Client Upload Support

**Files:**
- Create: app/src/auto-listing-config.js
- Create: app/src/auto-listing-view.js
- Modify: app/src/client-transport.js
- Create: app/tests/auto-listing-config.test.mjs
- Create: app/tests/auto-listing-view.test.mjs
- Modify: app/tests/client-transport.test.mjs

**Interfaces:** deriveAutoListingConfig, autoListingWarehouseOptions, readExcelFileAsBase64, task/import presentation.

- [ ] **Step 1: Write failing pure-model tests**

Cover exact defaults and ranges; derived total; dimension downgrade; signed price adjustment; user-facing price preview; target-store switch clearing an invalid warehouse; active-FBS-only options; state labels/actions; row/item error copy; progress counts; and ordinary-user omission of AI strategy/model controls.

- [ ] **Step 2: Write failing client-transport tests**

Add an option for pre-encoded JSON file upload without forcing a second JSON stringify or logging file contents. Verify auth, abort/timeout, invalid JSON response handling, and existing apiRequest behavior remains unchanged.

- [ ] **Step 3: Confirm RED**

~~~bash
node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs app/tests/client-transport.test.mjs
~~~

- [ ] **Step 4: Implement focused pure modules**

auto-listing-config.js owns only form defaults, options, client-side convenience validation, derived total, and price preview. The backend remains authoritative.

auto-listing-view.js maps stable status/error/action codes to Chinese labels and progress. Never derive business eligibility from warehouse names/type heuristics.

- [ ] **Step 5: Implement bounded file reading**

Read the selected xlsx file as ArrayBuffer, reject above the server-advertised/configured byte cap, convert to base64, and send name/contentType. Do not persist workbook bytes in localStorage or page state after upload completes.

- [ ] **Step 6: Confirm GREEN and commit**

~~~bash
node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs app/tests/client-transport.test.mjs
git add app/src/auto-listing-config.js app/src/auto-listing-view.js app/src/client-transport.js app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs app/tests/client-transport.test.mjs
git commit -m "feat: model auto listing user controls"
~~~

---

## Task 6: Add the “自动上架” Page and Navigation

**Files:**
- Create: app/src/AutoListingPage.jsx
- Create: app/src/auto-listing-page.css
- Modify: app/src/App.jsx
- Create: app/tests/auto-listing-page-contract.test.mjs
- Modify: app/tests/prototype-style-contract.test.mjs
- Modify: server/tests/module-boundaries.test.mjs

**Interfaces:** route /ozon/tools/auto-listing under AI 工具.

- [ ] **Step 1: Write a failing page contract test**

Require route title, AI menu child, focused page import/dispatch, source tabs, collect-box selected-item summary, Excel upload, pricing formula/result, target store/active FBS warehouse/stock fields, image ratio/role/language/resolution/quality controls, task list, review drawer/modal, retry/regenerate/cancel actions, loading/empty/error states, and no user-facing style/model/key/prompt controls.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test app/tests/auto-listing-page-contract.test.mjs
~~~

- [ ] **Step 3: Implement the focused page**

Page layout:

1. Source: 采集箱推送 / Excel SKU.
2. Listing configuration: target store, active FBS warehouse, stock, signed price adjustment, read-only calculated-price explanation.
3. Image configuration: ratio, exact role counts and derived total, Russian language, resolution, quality.
4. Create-task action with a complete summary.
5. Imports/tasks table with item-isolated progress.
6. Review panel with source vs generated media/rich content, price calculation, destination, checks, and event timeline.

When opened with query source=collect and ids, load only those account-owned collect items. If IDs are missing/foreign/deleted, show the backend result and retain valid selections.

- [ ] **Step 4: Wire navigation minimally**

In App.jsx:

- import AutoListingPage;
- add title and page type for /ozon/tools/auto-listing;
- add { key: "/ozon/tools/auto-listing", label: "自动上架" } under AI 工具;
- dispatch the route with current account/store/local data and refresh dependencies.

Do not add page implementation to App.jsx.

- [ ] **Step 5: Add styles and responsive states**

Match the current product visual system. Keep configuration labels in plain Chinese, visible units, keyboard labels, focus states, and readable error/progress text. On narrow screens, cards stack; generated images remain inspectable without horizontal page overflow.

- [ ] **Step 6: Run page/build/boundary checks and commit**

~~~bash
node --test app/tests/auto-listing-page-contract.test.mjs app/tests/prototype-style-contract.test.mjs server/tests/module-boundaries.test.mjs
pnpm --dir app build
git add app/src/AutoListingPage.jsx app/src/auto-listing-page.css app/src/App.jsx app/tests/auto-listing-page-contract.test.mjs app/tests/prototype-style-contract.test.mjs server/tests/module-boundaries.test.mjs
git commit -m "feat: add automatic listing workspace"
~~~

---

## Task 7: Add Collect-Box Manual Push Without Duplicating Task Logic

**Files:**
- Create: app/src/auto-listing-collect-push.js
- Create: app/tests/auto-listing-collect-push.test.mjs
- Modify: app/src/App.jsx
- Modify: app/tests/collect-box-target-store.test.mjs

**Interfaces:** selected collect IDs to auto-listing query/navigation.

- [ ] **Step 1: Write failing push-selection tests**

Assert no selection warns; selected IDs are deduplicated/encoded; selection may contain only visible account-owned rows; navigation target is /ozon/tools/auto-listing?source=collect&ids=...; and the action never calls an Ozon write or AI route directly.

- [ ] **Step 2: Confirm RED**

~~~bash
node --test app/tests/auto-listing-collect-push.test.mjs
~~~

- [ ] **Step 3: Implement the pure navigation builder and one collect-page button**

Add “推送到自动上架” beside batch delete. It opens the auto-listing page with selected IDs and leaves selection/config confirmation to that page. Row action may push one item through the same helper. Do not create a second form or task-creation implementation inside CollectPage.

- [ ] **Step 4: Confirm GREEN and commit**

~~~bash
node --test app/tests/auto-listing-collect-push.test.mjs app/tests/collect-box-target-store.test.mjs
git add app/src/auto-listing-collect-push.js app/tests/auto-listing-collect-push.test.mjs app/src/App.jsx app/tests/collect-box-target-store.test.mjs
git commit -m "feat: push collected products to auto listing"
~~~

---

## Task 8: Complete Review-Mode Workflow Verification

**Files:**
- Create: scripts/check-auto-listing-review-workflow.mjs
- Modify: scripts/verify.mjs
- Create: docs/superpowers/verification/2026-08-04-auto-listing-review-mode.md

- [ ] **Step 1: Add a static workflow guard**

Require the new route/page/modules, collect push, Excel routes, source queue worker, active-FBS contract use, no raw API key input, and review-mode state. Reject direct callOzonSellerApi usage from auto-listing UI/import/AI modules.

- [ ] **Step 2: Add it to verify and run focused verification**

~~~bash
node scripts/check-auto-listing-review-workflow.mjs
node --test app/tests/auto-listing-*.test.mjs server/tests/auto-listing-*.test.mjs
pnpm --dir app build
~~~

- [ ] **Step 3: Manually verify local review mode**

Use nonproduction data to verify: collect-box selection, preference persistence, Excel with valid/duplicate/invalid SKUs, one-row collection failure, category/dimension downgrade, multi-variant grouping, task reload after service restart, generated review display, retry/regenerate/cancel, and no upload action before plan 4.

Record screenshots/results, unverified real gateway/Ozon scope, rollback flags, and worker-stop instructions in the verification document.

- [ ] **Step 4: Commit**

~~~bash
git add scripts/check-auto-listing-review-workflow.mjs scripts/verify.mjs docs/superpowers/verification/2026-08-04-auto-listing-review-mode.md
git commit -m "test: verify auto listing review workflow"
~~~

---

## Plan 3 Verification Gate

- [ ] Run all plan 3 unit and contract tests, then pnpm verify.
- [ ] Run configured PostgreSQL/import-worker tests using only the dedicated test database.
- [ ] Confirm existing collect-box add/delete/view, extension collection, category resolution, active-FBS filtering, store switching, and app navigation still work.
- [ ] Rollback: set AUTO_LISTING_ENABLED=0, stop auto-listing-import-worker and auto-listing-worker, and remove the menu entry through the feature flag. Keep imports/source snapshots/assets/events for traceability.

