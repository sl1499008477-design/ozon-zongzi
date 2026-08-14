# Auto Listing AI Runtime Progress Implementation Plan

**Goal:** Make local AI planning executable and expose durable, safe progress instead of one opaque long-running label.

**Architecture:** Keep the dedicated AI worker and existing outbox workflow. Repair strict schemas at the planner boundary, include the worker in the local supervisor, and derive a closed public progress DTO from the latest account-scoped item outbox row. Do not add a migration or expose raw AI data.

**Tech Stack:** Node.js ESM, PostgreSQL 16, node:test, React/Ant Design, existing Sub2API gateway.

## Constraints

- No raw prompt, response, credential, gateway message, lease owner, or internal identifier reaches the UI.
- Progress is account/item scoped and selected deterministically from persisted rows.
- No historical bulk retry or destructive cleanup.
- The only live side effect is one authorized retry of item `auto_listing_job_115f0d2560b6419ca4cfce2f19517043_item_000` after all gates pass.

### Task 1: Close Strict AI Schemas

**Files:**
- Modify: `server/auto-listing-content-planner.mjs`
- Modify: `server/auto-listing-rich-content.mjs`
- Modify: focused schema tests.

- [ ] Add a recursive RED assertion that every `const`/`enum` leaf has an explicit compatible `type`.
- [ ] Add the minimal string/integer types to all affected schema leaves.
- [ ] Run planner, rich-content, gateway-client, orchestrator and worker tests.

### Task 2: Start the AI Worker in Local Development

**Files:**
- Modify: `scripts/dev.mjs`
- Modify: `scripts/check-local-dev-entrypoint.mjs`
- Modify: `app/tests/web-runtime-contract.test.mjs`

- [ ] Add RED assertions for exactly one `server/auto-listing-ai-worker.mjs` process.
- [ ] Add the worker to the local process supervisor.
- [ ] Verify the supervisor contract and graceful shutdown contract.

### Task 3: Publish Durable Item Progress

**Files:**
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: focused repository/service tests.

- [ ] Add RED repository tests for latest account/item outbox selection and six normalized states.
- [ ] Query only safe progress columns and attach a normalized internal progress record to each item.
- [ ] Add a closed public `workflowProgress` projection in the service.
- [ ] Verify cross-account and latest-row list/get behavior.

### Task 4: Show Concrete Progress in the UI

**Files:**
- Modify: `app/src/auto-listing-view.js`
- Modify: `app/src/AutoListingPage.jsx`
- Modify: focused view/page tests.

- [ ] Add RED tests for closed progress DTOs, hostile carriers and user labels.
- [ ] Project exact progress fields and render stage, attempt count, last update and retry time.
- [ ] Keep generic safe failure copy for unknown codes and add a specific safe planning failure label.
- [ ] Run focused frontend tests and Vite build.

### Task 5: Verify and Retry Only the Current Task

- [ ] Run related server/UI tests, syntax, diff check and relevant PostgreSQL integration.
- [ ] Restart the local supervisor so it owns exactly one AI worker.
- [ ] Invoke the existing retry route for only the approved item, once.
- [ ] Observe persisted outbox/attempt/item transitions until terminal or a bounded timeout.
- [ ] Report result, unverified areas, rollback commit and any external charge risk.
