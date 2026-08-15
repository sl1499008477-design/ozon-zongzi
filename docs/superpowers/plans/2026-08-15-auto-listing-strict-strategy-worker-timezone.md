# Automatic Listing Strict Strategy, Worker, and China Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cancel the existing fallback-planned item without AI work, require an exact category strategy for future jobs, restore the automatic-listing AI Worker safely, and display automatic-listing timestamps in China time.

**Architecture:** Preserve UTC in PostgreSQL and API contracts, and make the single automatic-listing presentation formatter explicitly project into `Asia/Shanghai`. Perform cancellation and policy transition only through their authenticated, versioned, idempotent HTTP contracts. Treat Worker startup as a global side effect: start it only after the target item is cancelled and a cross-account queue preflight proves that no unrelated runnable item would be consumed.

**Tech Stack:** Node.js ESM, React, Ant Design, PostgreSQL, pg-boss, Node test runner, Vite, authenticated local HTTP APIs.

## Global Constraints

- Work in the existing branch and worktree; the user explicitly chose not to create a separate worktree.
- Source design: `docs/superpowers/specs/2026-08-15-auto-listing-strict-strategy-worker-timezone-design.md`.
- Target account: `acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d`.
- Target job: `auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65`.
- Target item: `auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65_item_000`.
- Target source: `collect_bce1e3bb59023e8d0ca6755e`.
- Do not mutate rows directly. Cancellation and category-policy changes must use the authenticated application APIs so permissions, optimistic locking, idempotency, and audit events remain intact.
- Do not create, publish, or guess an exact category strategy. The user will configure and publish it through “类目图片策略”.
- Do not create a replacement automatic-listing job during this plan. A create request is a write if a matching strategy appears concurrently.
- Do not start the Worker if any runnable outbox message belongs to an account, job, or item other than the cancelled target. Stop and request explicit authority instead.
- Do not start the Worker before cancellation and strict policy verification both succeed.
- Do not expose bearer tokens, database URLs, gateway credentials, or raw source evidence in logs or commits.
- No database migration, Ozon write, listing submission, inventory update, or object deletion is in scope.

---

## Task 1: Capture the live baseline and verify the completed formal cancellation

**Files:**

- Read: `app/src/AutoListingPage.jsx:230-275`
- Read: `app/src/AutoListingPage.jsx:515-538`
- Read: `server/auto-listing-item-routes.mjs:1-128`
- Read: `server/auto-listing-user-item-action-postgres.mjs:130-215`
- Verify: PostgreSQL tables `auto_listing_job_items`, `auto_listing_ai_outbox`, `ai_content_plans`, `auto_listing_events`, `auto_listing_user_commands`

- [ ] **Step 1: Confirm the API process is healthy before any write**

Run:

```bash
curl --fail --silent --show-error http://127.0.0.1:3001/api/health
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

Expected: both commands return a JSON health payload with an affirmative health result. If either fails, restore that process first; do not cancel by SQL.

- [ ] **Step 2: Re-read the target item through the authenticated list contract**

With the in-app browser on `http://127.0.0.1:3000/ozon/tools/auto-listing/`, use the browser runtime to evaluate this in the top document:

```js
const token = localStorage.getItem("token");
const response = await fetch("/api/auto-listing/jobs?limit=50", {
  headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
});
const payload = await response.json();
const job = payload.data.find((candidate) => candidate.id === "auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65");
const item = job?.items?.find((candidate) => candidate.itemId === "auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65_item_000");
({ status: response.status, ok: payload.ok, jobId: job?.id, item });
```

Expected from the 2026-08-15 plan self-review baseline: HTTP `200`, `ok: true`, item status `CANCELLED`, `statusVersion: 3`, and `actions.cancel: false`.

Stop condition: if the item is missing or has moved away from `CANCELLED` version `3`, do not attempt to recreate history. Report the new state and revise the plan from fresh evidence.

- [ ] **Step 3: Capture the database-side no-AI baseline read-only**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env --input-type=module -e 'import {getPostgresPool,closePostgresPool} from "./server/db/connection.mjs"; const pool=await getPostgresPool(); const account="acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d"; const job="auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65"; const item="auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65_item_000"; const result=await pool.query(`SELECT i.status,i.status_version,(SELECT COUNT(*)::INTEGER FROM ai_content_plans p WHERE p.account_id=i.account_id AND p.job_id=i.job_id AND p.item_id=i.id) AS plan_count,(SELECT COUNT(*)::INTEGER FROM auto_listing_ai_outbox o WHERE o.account_id=i.account_id AND o.job_id=i.job_id AND o.item_id=i.id AND o.state=ANY($4::TEXT[])) AS live_outbox_count FROM auto_listing_job_items i WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3`,[account,job,item,["PENDING","PROCESSING"]]); console.log(JSON.stringify(result.rows,null,2)); await closePostgresPool();'
```

Expected: one row with `status: "CANCELLED"`, `status_version: 3`, `plan_count: 0`, and `live_outbox_count: 1`. The remaining row is the preserved pre-cancellation `PLAN_CONTENT` outbox message for expected status version `2`.

- [ ] **Step 4: Do not send another cancellation command**

The user-facing cancel action has already completed through the formal API. Its persisted evidence is:

- Action: `CANCEL`
- Expected status version: `2`
- Idempotency key: `cancel-eb472433-cea2-422a-bb99-3a7229bf04e7`
- Correlation ID: `action-879ca309-e986-4a2b-acd2-8ff4d792658c`
- Result: `CANCELLED`, version `3`
- Persisted at: `2026-08-15T11:44:02.564Z`

Do not replay even the same idempotency key merely for demonstration. Read the command and event evidence in Step 5 instead.

- [ ] **Step 5: Verify state, command, event, and absence of AI output**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env --input-type=module -e 'import {getPostgresPool,closePostgresPool} from "./server/db/connection.mjs"; const pool=await getPostgresPool(); const values=["acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d","auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65","auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65_item_000","CANCEL","CANCELLED",3,"PLANNING",2,"cancel-eb472433-cea2-422a-bb99-3a7229bf04e7","action-879ca309-e986-4a2b-acd2-8ff4d792658c"]; const result=await pool.query(`SELECT i.status,i.status_version,(SELECT COUNT(*)::INTEGER FROM ai_content_plans p WHERE p.account_id=i.account_id AND p.job_id=i.job_id AND p.item_id=i.id) AS plan_count,(SELECT COUNT(*)::INTEGER FROM auto_listing_user_commands c JOIN auto_listing_events e ON e.account_id=c.account_id AND e.job_id=c.job_id AND e.item_id=c.item_id AND e.correlation_id=c.correlation_id WHERE c.account_id=i.account_id AND c.job_id=i.job_id AND c.item_id=i.id AND c.action=$4 AND c.expected_status_version=$8 AND c.idempotency_key=$9 AND c.correlation_id=$10 AND c.result_status=$5 AND c.result_status_version=$6 AND e.event_type=$4 AND e.from_status=$7 AND e.to_status=$5 AND e.transition_version=$6) AS linked_audit_count FROM auto_listing_job_items i WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3`,values); console.log(JSON.stringify(result.rows,null,2)); await closePostgresPool();'
```

Expected: exactly one row with `CANCELLED`, version `3`, `plan_count: 0`, and `linked_audit_count: 1`.

No commit is created for this task because it changes only application state through audited contracts.

---

## Task 2: Transition the account to exact-category-only strategy mode

**Files:**

- Read: `server/auto-listing-category-strategy-routes.mjs:1-176`
- Read: `server/auto-listing-category-strategy-service.mjs:679-711`
- Read: `server/auto-listing-category-strategy-postgres.mjs:1490-1542`
- Verify: PostgreSQL tables `auto_listing_category_strategy_account_settings`, `auto_listing_category_strategy_events`

- [ ] **Step 1: Read the current setting through the authenticated admin contract**

Use the browser runtime to evaluate:

```js
const token = localStorage.getItem("token");
const response = await fetch("/api/admin/auto-listing/category-strategies/settings", {
  headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
});
({ status: response.status, payload: await response.json() });
```

Expected: HTTP `200`, `data.mode: "LEGACY_FALLBACK"`, `data.version: 1`.

Stop condition: if the mode or version differs, do not send a stale write. Re-read the audit history and decide whether the desired strict state is already satisfied.

- [ ] **Step 2: Apply strict mode with optimistic locking and stable command identity**

Use the browser runtime to evaluate:

```js
const token = localStorage.getItem("token");
const response = await fetch("/api/admin/auto-listing/category-strategies/settings", {
  method: "PATCH",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    expectedVersion: 1,
    mode: "REQUIRE_EXACT_STRATEGY",
    idempotencyKey: "codex-plan-b-strict-policy-20260815",
    correlationId: "codex-plan-b-strict-policy-correlation-20260815",
  }),
});
({ status: response.status, payload: await response.json() });
```

Expected: HTTP `200`, `data.mode: "REQUIRE_EXACT_STRATEGY"`, `data.version: 2`.

- [ ] **Step 3: Verify policy and append-only audit evidence**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env --input-type=module -e 'import {getPostgresPool,closePostgresPool} from "./server/db/connection.mjs"; const pool=await getPostgresPool(); const result=await pool.query(`SELECT s.mode,s.version,s.idempotency_key,s.correlation_id,e.event_type,e.settings_version,e.event_payload FROM auto_listing_category_strategy_account_settings s JOIN auto_listing_category_strategy_events e ON e.account_id=s.account_id AND e.settings_version=s.version AND e.event_type=$2 WHERE s.account_id=$1`,["acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d","ACCOUNT_SETTINGS_CHANGED"]); console.log(JSON.stringify(result.rows,null,2)); await closePostgresPool();'
```

Expected: one current row with mode `REQUIRE_EXACT_STRATEGY`, version `2`, the two command IDs above, event type `ACCOUNT_SETTINGS_CHANGED`, settings version `2`, and event payload `{ "mode": "REQUIRE_EXACT_STRATEGY" }`.

- [ ] **Step 4: Verify the category-strategy entry exists without entering a write-capable resume flow**

Keep the in-app browser on the automatic-listing page and inspect the left navigation.

Expected: the admin sees the “类目图片策略” navigation entry. Do not navigate into it during this operational transition because an existing resume intent can legitimately create a versioned draft. The user will enter that flow later to configure the exact strategy. Do not start sampling, call AI analysis, publish, or create a replacement automatic-listing job.

No commit is created for this task because it changes only versioned application configuration through its audited API.

---

## Task 3: Add a failing China-time presentation test

**Files:**

- Modify: `app/tests/auto-listing-view.test.mjs:358-363`
- Read: `app/src/auto-listing-view.js:340-343`

- [ ] **Step 1: Change the existing test to the explicit `Asia/Shanghai` contract**

Use `apply_patch` to make the test body exactly cover a normal conversion, a UTC-to-next-day conversion, and the existing invalid inputs:

```js
test("formats persisted timestamps in China time and never substitutes the current time", () => {
  assert.equal(autoListingCreatedAtLabel("2026-08-15T11:13:23.454Z"), "2026-08-15 19:13:23");
  assert.equal(autoListingCreatedAtLabel("2026-08-15T17:30:00.000Z"), "2026-08-16 01:30:00");
  assert.equal(autoListingCreatedAtLabel("2026-08-15T16:00:00.000Z"), "2026-08-16 00:00:00");
  assert.equal(autoListingCreatedAtLabel("not-a-time"), "—");
  assert.equal(autoListingCreatedAtLabel(""), "—");
  assert.equal(autoListingCreatedAtLabel(undefined), "—");
});
```

Expected literals must remain hand-derived. Do not compute them through the production formatter or a second helper.

- [ ] **Step 2: Run the named test file and capture RED**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/auto-listing-view.test.mjs
```

Expected: the timestamp test fails because the current implementation returns raw UTC values such as `2026-08-15 11:13:23`; the unrelated tests in the file pass. If it passes before production code changes, the test does not prove the intended bug and must be corrected.

- [ ] **Step 3: Review the RED failure for specificity**

Confirm the failing assertion identifies the eight-hour/next-day projection error, not an import, syntax, locale-availability, or fixture failure.

Do not commit the failing state.

---

## Task 4: Implement the minimal stable China-time formatter

**Files:**

- Modify: `app/src/auto-listing-view.js:1-20`
- Modify: `app/src/auto-listing-view.js:340-343`
- Test: `app/tests/auto-listing-view.test.mjs`

- [ ] **Step 1: Add one module-level formatter with an explicit time zone**

Near the existing module constants, add:

```js
const AUTO_LISTING_CHINA_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
```

- [ ] **Step 2: Replace raw ISO slicing with stable `formatToParts` assembly**

Implement `autoListingCreatedAtLabel` so it:

1. Calls the existing `canonicalTimestamp(value)` first.
2. Returns `—` when canonicalization fails.
3. Calls `AUTO_LISTING_CHINA_TIME_FORMATTER.formatToParts(new Date(timestamp))`.
4. Reads only `year`, `month`, `day`, `hour`, `minute`, and `second` into a local map.
5. Returns exactly `${year}-${month}-${day} ${hour}:${minute}:${second}`.

Do not use `toLocaleString()` because punctuation and spacing vary by runtime locale. Do not change persisted data, API payloads, or `canonicalTimestamp`.

- [ ] **Step 3: Run GREEN for the focused presentation test**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/auto-listing-view.test.mjs
```

Expected: all tests in the file pass, including both explicit China-time examples and invalid-input behavior.

- [ ] **Step 4: Run direct frontend contract regression**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/auto-listing-view.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-config.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit only the timezone implementation and test**

Run:

```bash
git diff --check
git status --short
git add app/src/auto-listing-view.js app/tests/auto-listing-view.test.mjs
git commit -m "fix: display automatic-listing times in China"
```

Expected: one focused commit containing exactly those two files.

---

## Task 5: Preflight and start the global AI Worker without consuming unrelated work

**Files:**

- Read: `server/auto-listing-ai-worker.mjs:285-315`
- Read: `server/auto-listing-ai-worker.mjs:395-425`
- Read: `server/auto-listing-runtime.mjs:300-359`
- Read: `server/auto-listing-ai-outbox-postgres.mjs:190-240`
- Verify: PostgreSQL tables `auto_listing_ai_outbox`, `auto_listing_job_items`, `ai_content_plans`

- [ ] **Step 1: Confirm no Worker process is already running**

Run:

```bash
pgrep -af "server/auto-listing-ai-worker.mjs"
```

Expected before startup: no matching process. If one exists, do not launch a duplicate; inspect its start time and current queue effects first.

- [ ] **Step 2: Discover runnable accounts using the same repository contract as the relay**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env --input-type=module -e 'import {getPostgresPool,closePostgresPool} from "./server/db/connection.mjs"; import {createPostgresAiOutboxRepository} from "./server/auto-listing-ai-outbox-postgres.mjs"; const pool=await getPostgresPool(); const repository=createPostgresAiOutboxRepository({pool}); let afterAccountId=null; const accountIds=[]; for (let page=0;page<100;page+=1){const values=await repository.listRunnableAutoListingAiAccountIds({afterAccountId,limit:100}); for(const value of values) if(!accountIds.includes(value)) accountIds.push(value); if(values.length<100) break; afterAccountId=values.at(-1);} const parameters=[accountIds,"V1","PENDING","PROCESSING","DEAD","COMPLETED",["PLAN_CONTENT","MATERIALIZE_SOURCE_ASSET","FINALIZE_MATERIALIZED_PLAN"],["GENERATE_IMAGE_SLOT","GENERATE_RICH_CONTENT"],"PLANNING","GENERATING",["PENDING","PROCESSING"]]; const rows=accountIds.length?(await pool.query(`SELECT o.account_id,o.job_id,o.item_id,o.phase,o.state,o.attempts,o.expected_status_version,i.status AS item_status,i.status_version AS item_status_version FROM auto_listing_ai_outbox o JOIN auto_listing_job_items i ON i.account_id=o.account_id AND i.job_id=o.job_id AND i.id=o.item_id WHERE o.account_id=ANY($1::TEXT[]) AND o.contract_version=$2 AND ((o.state=$3 AND o.attempts<5 AND o.next_retry_at<=NOW()) OR (o.state=$4 AND o.lease_expires_at<=NOW()) OR (o.state=$5 AND i.status_version=o.expected_status_version AND ((o.phase=ANY($7::TEXT[]) AND i.status=$9) OR (o.phase=ANY($8::TEXT[]) AND i.status=$10))) OR (o.state=$6 AND o.published_at<=NOW()-$12::INTERVAL AND i.status_version=o.expected_status_version AND i.status=ANY($13::TEXT[]) AND i.updated_at<=NOW()-$12::INTERVAL AND NOT EXISTS (SELECT 1 FROM auto_listing_ai_outbox live WHERE live.account_id=o.account_id AND live.job_id=o.job_id AND live.item_id=o.item_id AND live.expected_status_version=o.expected_status_version AND live.state=ANY($11::TEXT[])))) ORDER BY o.account_id,o.created_at,o.id`,[...parameters,"3 hours",["PLANNING","GENERATING"]])).rows:[]; console.log(JSON.stringify({accountIds,rows},null,2)); await closePostgresPool();'
```

Allowed result: `accountIds` is empty, or contains only `acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d`; every returned runnable row must belong to the target job/item, and the joined item must be `CANCELLED` at version `3`.

Stop condition: if any other account, job, item, or non-cancelled runnable row appears, do not start the Worker. Report the exact safe identifiers and states without exposing payloads, and ask the user whether global processing is authorized.

- [ ] **Step 3: Reconfirm strict policy and cancelled target immediately before startup**

Repeat Task 1 Step 5 and Task 2 Step 3 read-only checks.

Expected: target remains `CANCELLED` version `3`, content-plan count remains `0`, and account mode remains `REQUIRE_EXACT_STRATEGY` version `2`.

- [ ] **Step 4: Start the dedicated Worker in a persistent execution session**

Run from the repository root:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env server/auto-listing-ai-worker.mjs
```

Use a short initial yield so the process remains attached to a persistent execution session.

Expected log: a JSON-safe event containing code `AUTO_LISTING_AI_WORKER_STARTED`. Record the session ID and PID. If startup fails, keep the task cancelled and strict policy enabled; diagnose without starting a second copy.

- [ ] **Step 5: Verify the cancelled message caused no content plan or AI progression**

After the relay has had at least two five-second polling intervals, run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env --input-type=module -e 'import {getPostgresPool,closePostgresPool} from "./server/db/connection.mjs"; const pool=await getPostgresPool(); const values=["acct_8b9c69df-cd06-47a1-9d03-27fb92433e3d","auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65","auto_listing_job_8df06a6a5bc44dbc88adaa94fed2ea65_item_000"]; const item=(await pool.query(`SELECT i.status,i.status_version,(SELECT COUNT(*)::INTEGER FROM ai_content_plans p WHERE p.account_id=i.account_id AND p.job_id=i.job_id AND p.item_id=i.id) AS plan_count FROM auto_listing_job_items i WHERE i.account_id=$1 AND i.job_id=$2 AND i.id=$3`,values)).rows; const outbox=(await pool.query(`SELECT phase,state,attempts,published_at,expected_status_version FROM auto_listing_ai_outbox WHERE account_id=$1 AND job_id=$2 AND item_id=$3 ORDER BY created_at,id`,values)).rows; console.log(JSON.stringify({item,outbox},null,2)); await closePostgresPool();'
```

Expected: item remains `CANCELLED` version `3`; `plan_count` remains `0`; the old `PLAN_CONTENT` outbox evidence is retained and may be `COMPLETED` after publication. There must be no new planning/generation outbox phase for status version `3`.

- [ ] **Step 6: Verify only one Worker process is running**

Run:

```bash
pgrep -af "server/auto-listing-ai-worker.mjs"
```

Expected: exactly one Worker process, the PID launched in Step 4.

No commit is created for this task because it changes only local runtime state. Operational rollback is a graceful `SIGTERM` to the recorded Worker PID; do not kill the backend or frontend processes.

---

## Task 6: Run focused regression, build, and browser acceptance

**Files:**

- Test: `app/tests/auto-listing-view.test.mjs`
- Test: `app/tests/auto-listing-page-contract.test.mjs`
- Test: `app/tests/auto-listing-config.test.mjs`
- Test: `server/tests/auto-listing-item-routes.test.mjs`
- Test: `server/tests/auto-listing-item-service.test.mjs`
- Test: `server/tests/auto-listing-user-item-action-postgres.test.mjs`
- Test: `server/tests/auto-listing-state-machine.test.mjs`
- Test: `server/tests/auto-listing-category-strategy-routes.test.mjs`
- Test: `server/tests/auto-listing-category-strategy-service.test.mjs`
- Test: `server/tests/auto-listing-ai-worker.test.mjs`
- Test: `server/tests/auto-listing-ai-runtime-composition.test.mjs`
- Build: `app/`

- [ ] **Step 1: Run the complete focused regression set**

Run:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test app/tests/auto-listing-view.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-config.test.mjs server/tests/auto-listing-item-routes.test.mjs server/tests/auto-listing-item-service.test.mjs server/tests/auto-listing-user-item-action-postgres.test.mjs server/tests/auto-listing-state-machine.test.mjs server/tests/auto-listing-category-strategy-routes.test.mjs server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-ai-worker.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
```

Expected: zero failures and zero cancellations.

- [ ] **Step 2: Build the frontend production bundle**

Run from `app/`:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vite/bin/vite.js build
```

Expected: Vite build succeeds. Generated build output must not be staged unless already tracked and intentionally changed.

- [ ] **Step 3: Run syntax and diff hygiene checks**

Run from the repository root:

```bash
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check app/src/auto-listing-view.js
/Users/songliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check app/tests/auto-listing-view.test.mjs
git diff --check HEAD~1 HEAD
git status --short --branch
```

Expected: both syntax checks pass, committed diff is clean, and no unintended files are modified.

- [ ] **Step 4: Refresh the automatic-listing page and verify the user-visible results**

Reload `http://127.0.0.1:3000/ozon/tools/auto-listing/` in the in-app browser.

Expected:

- The target row is labelled cancelled and no longer says “正在规划图片内容”.
- Its creation time is `2026-08-15 19:13:23`.
- There is no new replacement task.
- The page remains functional and the “类目图片策略” navigation entry is present.

- [ ] **Step 5: Re-read the strict settings contract for final acceptance**

Repeat Task 2 Step 1.

Expected: `REQUIRE_EXACT_STRATEGY`, version `2`.

- [ ] **Step 6: Record known unverified scope without overstating completion**

Do not claim the repository-wide `scripts/verify.mjs` suite is green unless it is rerun successfully. The latest known full verification was blocked by unrelated browser-fixture hangs and missing `QH_SOURCE_EXTENSION_DIR` parity input. Report focused suite and build evidence separately.

Do not test a new create POST. The existing service tests prove `AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED`; live creation remains deliberately unverified to avoid a write if an exact strategy is concurrently published.

---

## Task 7: Final audit, rollback notes, and branch handoff

**Files:**

- Review: `docs/superpowers/specs/2026-08-15-auto-listing-strict-strategy-worker-timezone-design.md`
- Review: `docs/superpowers/plans/2026-08-15-auto-listing-strict-strategy-worker-timezone.md`
- Review: committed timezone diff

- [ ] **Step 1: Confirm every acceptance criterion has evidence**

Create a concise handoff table covering:

- Cancelled item and audit command/event.
- Strict policy mode and settings event.
- Worker PID/session and single-process check.
- Zero content plans for the cancelled item.
- China-time unit examples and browser display.
- Focused test and build results.

- [ ] **Step 2: Report unchanged contracts and data boundaries**

State explicitly:

- PostgreSQL and API timestamps remain UTC ISO.
- No API shape or database schema changed.
- No exact strategy was fabricated.
- No Ozon, inventory, upload, or object-storage side effect occurred.
- The Worker is global, but its preflight admitted only the cancelled target message.

- [ ] **Step 3: Document rollback and recovery**

- Code: revert the timezone commit produced in Task 4.
- Worker: send graceful `SIGTERM` only to the recorded Worker PID.
- Policy: use `PATCH /api/admin/auto-listing/category-strategies/settings` with the then-current `expectedVersion` and a new idempotency/correlation pair; never edit the table directly.
- Cancelled task: do not rewrite history or resurrect it. After the user publishes an exact strategy, create a new task from the automatic-listing page.

- [ ] **Step 4: Use `superpowers:verification-before-completion` before any final success claim**

Re-run the most relevant checks whose output could have gone stale: focused timestamp test, final item/policy database reads, Worker process count, and `git status --short --branch`.

- [ ] **Step 5: Use `superpowers:finishing-a-development-branch` for the integration decision**

Present branch integration options only after all required evidence is current. Do not merge, push, or open a pull request without the user's explicit choice.

---

## Plan Self-Review Gate

- [ ] **Specification coverage:** Compare every business goal, ordering constraint, testing rule, and rollback statement in the design document against Tasks 1-7. The plan must cover cancellation before Worker startup, strict policy, no guessed strategy, no AI output for the cancelled item, Worker health, and `Asia/Shanghai` display.
- [ ] **Placeholder scan:** Run `rg -n "TO[D]O|TB[D]|FIXM[E]|PLACEHOLDE[R]|<accoun[t]|<jo[b]|<ite[m]|you[r]-" docs/superpowers/plans/2026-08-15-auto-listing-strict-strategy-worker-timezone.md`. Expected: no unresolved implementation placeholder.
- [ ] **Path validation:** Run `test -f` for every source and test path listed in this plan. Expected: all paths exist.
- [ ] **Contract/type consistency:** Reconfirm exact enum and field names against source: `PLANNING`, `CANCELLED`, `REQUIRE_EXACT_STRATEGY`, `statusVersion`, `expectedStatusVersion`, `ACCOUNT_SETTINGS_CHANGED`, `PLAN_CONTENT`, `Asia/Shanghai`.
- [ ] **Safety review:** Confirm the only application mutations are the formal cancel POST and formal settings PATCH, and Worker startup is fenced by the cross-account runnable-queue check.
