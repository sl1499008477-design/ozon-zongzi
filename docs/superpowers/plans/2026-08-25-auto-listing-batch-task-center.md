# 自动上架批次任务中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一次推送的多件商品在同一批次内严格逐件处理，增加精确上架倍率，并用独立任务中心展示商品主图、进度、用时和失败分类。

**Architecture:** 继续使用现有 PostgreSQL 任务、状态机、AI Outbox、定价模块和 React 页面。数据库保存一基的 `source_order` 与百万分之一精度倍率；AI Outbox 领取 SQL 是批次顺序的唯一权威门禁；任务中心只投影现有状态和来源快照，不建立第二套状态机或数据副本。

**Tech Stack:** Node.js ESM、PostgreSQL、React 19、Ant Design 6、Node test runner、Playwright browser tests、Vite。

**Spec:** `docs/superpowers/specs/2026-08-25-auto-listing-batch-task-center-design.md`

## Global Constraints

- 一个批次内严格逐件处理；前一件进入 `SUCCEEDED`、`READY_FOR_REVIEW`、`RETRYABLE_ERROR`、`BLOCKED` 或 `CANCELLED` 后才释放下一件。
- `UPLOAD_QUEUED` 和 `UPLOADING` 不释放下一件；不同批次和不同账号仍可并行。
- 失败商品释放下一件；人工重试重新进入同一领取门禁，不中断已在执行的商品。
- 最终售价计算顺序固定为“现有售价规则结果 + 售价加减，再乘以上架倍率”。
- 倍率默认 `1`，必须大于 0，最多 6 位小数；金额和倍率全程使用整数或 `BigInt`，不得使用二进制浮点数。
- 历史冻结配置缺少倍率时按 `1` 计算，不改写历史 JSON 或配置哈希。
- 任务列表只返回当前账号范围内的安全来源投影，不暴露完整来源快照。
- 不新增队列、工作流引擎、状态机、依赖或与本需求无关的抽象。
- 保留权限、多租户、店铺、仓库、金额、库存、幂等和外部写操作保护。
- 当前分支已有大量未提交修改；不得重置、丢弃或覆盖。每次提交只选择本批新增的精确 hunk，并在提交前检查暂存区。
- 编写迁移和在一次性测试库执行迁移属于本计划；不得未经确认对生产数据库执行迁移，也不得在验收中触发付费 AI 或真实 Ozon 写入。

---

## File Structure

- `server/db/migrations/088_auto_listing_batch_order_multiplier.sql`：只负责历史顺序回填、顺序约束/索引和偏好倍率字段。
- `server/auto-listing-contract.mjs`：配置 contract，接受可选的 `priceMultiplierMicros` 并保持历史冻结配置原样。
- `server/auto-listing-pricing.mjs`：倍率的权威精确计算。
- `server/auto-listing-preferences-postgres.mjs`：保存和读取账号偏好倍率。
- `server/auto-listing-service.mjs`：创建一基来源顺序、向定价传倍率、投影失败阶段。
- `server/auto-listing-repository.mjs`：持久化顺序，并从不可变来源快照读取任务列表需要的最小商品信息。
- `server/auto-listing-ai-outbox-postgres.mjs`：批次内顺序领取的唯一权威门禁。
- `server/auto-listing-overlay.mjs`：上传覆盖层重算价格时使用相同倍率。
- `server/auto-listing-routes.mjs`、`server/auto-listing-view.mjs`：安全公开新任务字段和价格证据。
- `app/src/auto-listing-config.js`：十进制倍率与百万分之一整数互转、前端价格预览。
- `app/src/auto-listing-view.js`：采集商品列表、任务进度、用时和筛选的纯函数。
- `app/src/AutoListingPage.jsx`：创建任务/任务中心页签、倍率输入和任务表格。
- `app/src/auto-listing-page.css`：当前页面控件高度、商品缩略图、进度和响应式布局。
- 现有同名测试文件：覆盖各模块公开 contract；新增两个聚焦迁移/顺序的测试文件，不创建通用测试框架。

---

### Task 1: Additive database fields and deterministic backfill

**Files:**
- Create: `server/db/migrations/088_auto_listing_batch_order_multiplier.sql`
- Create: `server/tests/auto-listing-batch-order-multiplier-migration.test.mjs`
- Modify: `server/tests/auto-listing-category-strategy-analysis-migration.test.mjs:11-14`

**Interfaces:**
- Consumes: existing `auto_listing_job_items(account_id, job_id, created_at, id)` and `auto_listing_preferences`.
- Produces: `auto_listing_job_items.source_order INTEGER NOT NULL`; unique index `(account_id, job_id, source_order)`; `auto_listing_preferences.price_multiplier_micros BIGINT NOT NULL DEFAULT 1000000`.

- [ ] **Step 1: Write the failing migration contract test**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/088_auto_listing_batch_order_multiplier.sql", import.meta.url);

test("088 backfills a one-based batch order and adds an exact positive multiplier", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_order INTEGER/i);
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY account_id,job_id ORDER BY created_at,id\)/i);
  assert.match(sql, /ALTER COLUMN source_order SET NOT NULL/i);
  assert.match(sql, /CHECK \(source_order > 0\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_batch_order_uq[\s\S]*?account_id,job_id,source_order/i);
  assert.match(sql, /price_multiplier_micros BIGINT NOT NULL DEFAULT 1000000/i);
  assert.match(sql, /CHECK \(price_multiplier_micros > 0\)/i);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
});
```

- [ ] **Step 2: Run the migration tests to verify they fail**

Run:

```bash
node --test server/tests/auto-listing-batch-order-multiplier-migration.test.mjs server/tests/auto-listing-category-strategy-analysis-migration.test.mjs
```

Expected: FAIL because migration `088` does not exist and the current latest-migration assertion still expects `087`.

- [ ] **Step 3: Add the minimal additive migration**

```sql
ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS source_order INTEGER;

WITH ranked AS (
  SELECT id,account_id,job_id,
         ROW_NUMBER() OVER (PARTITION BY account_id,job_id ORDER BY created_at,id)::INTEGER AS source_order
    FROM auto_listing_job_items
)
UPDATE auto_listing_job_items AS item
   SET source_order=ranked.source_order
  FROM ranked
 WHERE item.account_id=ranked.account_id AND item.job_id=ranked.job_id AND item.id=ranked.id
   AND item.source_order IS NULL;

ALTER TABLE auto_listing_job_items
  ALTER COLUMN source_order SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='auto_listing_job_items_source_order_check') THEN
    ALTER TABLE auto_listing_job_items
      ADD CONSTRAINT auto_listing_job_items_source_order_check CHECK (source_order > 0);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auto_listing_job_items_batch_order_uq
  ON auto_listing_job_items(account_id,job_id,source_order);

ALTER TABLE auto_listing_preferences
  ADD COLUMN IF NOT EXISTS price_multiplier_micros BIGINT NOT NULL DEFAULT 1000000
    CHECK (price_multiplier_micros > 0);
```

Update the migration-order assertion so `088_auto_listing_batch_order_multiplier.sql` is the last discovered migration.

- [ ] **Step 4: Run the migration tests**

Run:

```bash
node --test server/tests/auto-listing-batch-order-multiplier-migration.test.mjs server/tests/auto-listing-category-strategy-analysis-migration.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit only Task 1 hunks**

```bash
git add server/db/migrations/088_auto_listing_batch_order_multiplier.sql server/tests/auto-listing-batch-order-multiplier-migration.test.mjs
git add -p server/tests/auto-listing-category-strategy-analysis-migration.test.mjs
git diff --cached --check
git commit -m "feat: add auto-listing batch order and multiplier fields"
```

---

### Task 2: Exact multiplier contract, pricing, preferences, and upload parity

**Files:**
- Modify: `server/auto-listing-contract.mjs`
- Modify: `server/auto-listing-pricing.mjs`
- Modify: `server/auto-listing-preferences-postgres.mjs`
- Modify: `server/auto-listing-user-workflow-service.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-overlay.mjs`
- Modify: `server/auto-listing-routes.mjs`
- Modify: `server/auto-listing-view.mjs`
- Modify: `server/tests/auto-listing-contract.test.mjs`
- Modify: `server/tests/auto-listing-pricing.test.mjs`
- Modify: `server/tests/auto-listing-preferences-postgres.test.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-overlay.test.mjs`
- Modify: `server/tests/auto-listing-routes.test.mjs`
- Modify: `server/tests/auto-listing-view.test.mjs`

**Interfaces:**
- Consumes: optional config field `priceMultiplierMicros: string`; historical absence means `"1000000"` at calculation time only.
- Produces: `calculateAutoListingPrice({ ..., adjustmentKopecks, priceMultiplierMicros? })` returning `preMultiplierPriceKopecks`, `priceMultiplierMicros`, and final `finalPriceKopecks`.

- [ ] **Step 1: Write failing contract and pricing tests**

```js
test("historical frozen config remains byte-shape compatible while new multiplier is normalized", () => {
  const historical = baseConfig();
  const frozen = normalizeAndHashAutoListingConfig(historical);
  assert.equal(Object.hasOwn(frozen.config, "priceMultiplierMicros"), false);
  assert.deepEqual(verifyAutoListingFrozenConfig(frozen.config, frozen.configHash).config, frozen.config);
  assert.equal(normalizeAutoListingConfig({ ...historical, priceMultiplierMicros: "+1250000" }).priceMultiplierMicros, "1250000");
  for (const value of ["0", "-1", "1.5", 1000000]) {
    assert.throws(() => normalizeAutoListingConfig({ ...historical, priceMultiplierMicros: value }), { code: "AUTO_LISTING_CONFIG_INVALID" });
  }
});

test("price adjustment is applied before an exact six-decimal multiplier", () => {
  assert.deepEqual(calculateAutoListingPrice({
    currency: "RUB", blackKopecks: "10000", greenKopecks: "8000",
    adjustmentKopecks: "100", priceMultiplierMicros: "1250000",
  }), {
    currency: "RUB", branch: "BLACK_GTE_80", blackKopecks: "10000", greenKopecks: "8000",
    realPriceKopecks: "14500", adjustmentKopecks: "100",
    preMultiplierPriceKopecks: "14600", priceMultiplierMicros: "1250000",
    finalPriceKopecks: "18250",
  });
});
```

Also add cases for absent multiplier, `"1"` micros rounding, a value near the PostgreSQL `BIGINT` boundary, and non-positive pre-multiplier price.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
node --test server/tests/auto-listing-contract.test.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-preferences-postgres.test.mjs
```

Expected: FAIL because the contract rejects the new key, pricing omits multiplier evidence, and preferences do not read/write the new column.

- [ ] **Step 3: Extend the frozen config without rewriting historical shapes**

In `server/auto-listing-contract.mjs`, add `priceMultiplierMicros` to `CONFIG_KEYS` and normalize only when the property exists:

```js
const positiveIntegerString = (value) => {
  if (typeof value !== "string" || !/^\+?\d{1,19}$/.test(value.trim())) {
    throw contractError("AUTO_LISTING_CONFIG_INVALID");
  }
  const parsed = BigInt(value.trim());
  if (parsed <= 0n || parsed > POSTGRES_BIGINT_MAX) throw contractError("AUTO_LISTING_CONFIG_INVALID");
  return String(parsed);
};

if (rawConfig.priceMultiplierMicros !== undefined) {
  config.priceMultiplierMicros = positiveIntegerString(rawConfig.priceMultiplierMicros);
}
```

Do not insert a default into `normalizeAutoListingConfig`; that would change historical frozen JSON and hashes.

- [ ] **Step 4: Implement exact multiplier pricing**

In `server/auto-listing-pricing.mjs`:

```js
const MULTIPLIER_SCALE = 1_000_000n;
const priceMultiplierMicros = parseIntegerKopecks(
  input.priceMultiplierMicros ?? String(MULTIPLIER_SCALE),
  { required: true, positive: true },
);
const preMultiplierPriceKopecks = realPriceKopecks + adjustmentKopecks;
if (preMultiplierPriceKopecks <= 0n) throw priceError(PRICE_FINAL_NOT_POSITIVE);
const finalPriceKopecks = roundHalfUp(
  preMultiplierPriceKopecks * priceMultiplierMicros,
  MULTIPLIER_SCALE,
);
if (finalPriceKopecks <= 0n) throw priceError(PRICE_FINAL_NOT_POSITIVE);
if (finalPriceKopecks > POSTGRES_BIGINT_MAX) throw priceError(PRICE_INPUT_INVALID);
```

Return both new evidence fields as strings. Pass `config.priceMultiplierMicros` through `priceInput`, both repository recalculation sites, and `auto-listing-overlay.mjs` so creation, replay verification, review and upload compute the same price.

- [ ] **Step 5: Persist multiplier preferences and expose safe price evidence**

Update `fromRow`, `UPDATE`, and `INSERT` in `server/auto-listing-preferences-postgres.mjs`:

```js
priceMultiplierMicros: String(row.price_multiplier_micros ?? 1_000_000),
```

Store `input.config.priceMultiplierMicros ?? "1000000"` in the new column. Return it through `auto-listing-user-workflow-service.mjs`. Add `preMultiplierPriceKopecks` and `priceMultiplierMicros` to the exact safe-price key sets in routes and review view.

- [ ] **Step 6: Run all price-boundary tests**

Run:

```bash
node --test server/tests/auto-listing-contract.test.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-view.test.mjs
```

Expected: PASS, including unchanged historical configurations.

- [ ] **Step 7: Commit only Task 2 hunks**

```bash
git add -p server/auto-listing-contract.mjs server/auto-listing-pricing.mjs server/auto-listing-preferences-postgres.mjs server/auto-listing-user-workflow-service.mjs server/auto-listing-service.mjs server/auto-listing-repository.mjs server/auto-listing-overlay.mjs server/auto-listing-routes.mjs server/auto-listing-view.mjs server/tests/auto-listing-contract.test.mjs server/tests/auto-listing-pricing.test.mjs server/tests/auto-listing-preferences-postgres.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-overlay.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-view.test.mjs
git diff --cached --check
git commit -m "feat: apply exact auto-listing price multiplier"
```

---

### Task 3: Persist one-based source order and project task-center fields

**Files:**
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-routes.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/tests/auto-listing-repository.test.mjs`
- Modify: `server/tests/auto-listing-routes.test.mjs`

**Interfaces:**
- Consumes: migration field `auto_listing_job_items.source_order`.
- Produces task item fields: `sourceOrder: number`, `sourceThumbnailUrl: string`, `sourceTitle: string`, `sourceSku: string`, `jobCreatedAt: ISO string`, `failureStage: "PREPARATION" | "GENERATION" | "UPLOAD" | null`.

- [ ] **Step 1: Write failing service/repository tests**

Add a two-source creation assertion:

```js
assert.deepEqual(graph.items.map((item) => item.sourceOrder), [1, 2]);
```

Add repository SQL and DTO assertions:

```js
assert.match(insertItem.sql, /source_order/iu);
assert.equal(insertItem.params.includes(1), true);
assert.equal(job.items[0].sourceOrder, 1);
assert.equal(job.items[0].sourceThumbnailUrl, "https://source.example.test/one.jpg");
assert.equal(job.items[0].sourceTitle, "商品一");
assert.equal(job.items[0].sourceSku, "SKU-1");
```

Add route cases showing an upload failure maps to `UPLOAD`, a planner retry maps to `PREPARATION`, and a generated-image failure maps to `GENERATION` without inspecting Chinese text.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
node --test server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-routes.test.mjs
```

Expected: FAIL because source order is zero-based and the task projection fields are absent.

- [ ] **Step 3: Make source order one-based at creation**

In `buildJobItems` use the array index only to read the source and persist `sourceOrder: sourceIndex + 1`:

```js
return sources.map((source, sourceIndex) => {
  const sourceOrder = sourceIndex + 1;
  // existing capture logic
  return { ...base, sourceOrder };
});
```

Where listing-base preparation currently reads `sources[item.sourceOrder]`, change it to `sources[item.sourceOrder - 1]`. Tighten `assertGraph` to require `sourceOrder >= 1` and unique contiguous order for the submitted batch.

- [ ] **Step 4: Persist and read order plus safe source projection**

Add `source_order` to the item `INSERT`. In `readJobWithClient`, select:

```sql
i.source_order,
CASE WHEN jsonb_typeof(s.snapshot#>'{media,images,0}')='string'
     THEN s.snapshot#>>'{media,images,0}' ELSE '' END AS source_thumbnail_url,
COALESCE(s.snapshot#>>'{identity,primaryName}','') AS source_title,
COALESCE(s.snapshot#>>'{identity,primarySku}','') AS source_sku
```

Order items by `i.source_order, i.id`, not ID alone. Map only these strings and the integer order into the repository DTO.

- [ ] **Step 5: Derive a stable failure stage in the backend service**

Use recovery point first, then explicit machine-readable upload error families:

```js
function failureStageFor(source) {
  if (!["RETRYABLE_ERROR", "BLOCKED", "CANCELLED"].includes(source.status)) return null;
  if (source.recoveryPoint === "UPLOAD") return "UPLOAD";
  if (source.recoveryPoint === "GENERATION") return "GENERATION";
  if (source.recoveryPoint === "PLANNING") return "PREPARATION";
  const code = safeString(source.failureCode) || safeString(source.failure_code) || "";
  if (/^(?:AUTO_LISTING_(?:UPLOAD|DIRECT|PUBLICATION|RECONCILE)_|OZON_(?:SUBMISSION|RICH_CONTENT)_)/u.test(code)) return "UPLOAD";
  if (safeString(source.activeContentPlanId) || safeString(source.active_content_plan_id)) return "GENERATION";
  return "PREPARATION";
}
```

Pass `failureStage` and the source projection through the service and route safe DTO. Attach the parent job creation timestamp as `jobCreatedAt` to each returned item.

- [ ] **Step 6: Run task projection tests**

Run:

```bash
node --test server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-routes.test.mjs
```

Expected: PASS with account-scoped SQL assertions and no complete snapshot in the response.

- [ ] **Step 7: Commit only Task 3 hunks**

```bash
git add -p server/auto-listing-service.mjs server/auto-listing-repository.mjs server/auto-listing-routes.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-routes.test.mjs
git diff --cached --check
git commit -m "feat: expose ordered auto-listing task evidence"
```

---

### Task 4: Enforce one active item per batch at the AI Outbox claim boundary

**Files:**
- Modify: `server/auto-listing-ai-outbox-postgres.mjs`
- Modify: `server/tests/auto-listing-ai-outbox-postgres.test.mjs`
- Create: `server/tests/auto-listing-batch-order-postgres.integration.test.mjs`

**Interfaces:**
- Consumes: `auto_listing_job_items.source_order` and existing Outbox states.
- Produces: unchanged `claimAutoListingAiMessages({ accountId, workerId, limit, leaseMs })` contract with stricter candidate selection.

- [ ] **Step 1: Write a failing SQL-boundary unit test**

```js
test("claim permits only the earliest non-stable item and one live outbox per batch", async () => {
  const pool = scriptedPool([{ rows: [] }]);
  const repository = createPostgresAiOutboxRepository({ pool, token: () => "batch-order" });
  await repository.claimAutoListingAiMessages({
    accountId: "account-a", workerId: "worker-a", limit: 10, leaseMs: 60_000,
  });
  const sql = pool.calls[0].sql;
  assert.match(sql, /JOIN auto_listing_job_items AS item/iu);
  assert.match(sql, /predecessor\.source_order < item\.source_order/iu);
  assert.match(sql, /predecessor\.status NOT IN \('SUCCEEDED','READY_FOR_REVIEW','RETRYABLE_ERROR','BLOCKED','CANCELLED'\)/iu);
  assert.match(sql, /live\.state='PROCESSING'[\s\S]*?live\.lease_expires_at > NOW\(\)/iu);
  assert.match(sql, /FOR UPDATE OF outbox SKIP LOCKED/iu);
});
```

- [ ] **Step 2: Write the disposable-PostgreSQL integration test**

Create a test guarded by `AUTO_LISTING_POSTGRES_TESTS=1` and `SONLI_MIGRATION_TEST_DATABASE_URL`. In an isolated schema, apply migrations, insert two jobs with two items each and four valid Outbox messages, then assert:

```js
assert.deepEqual(firstClaims.map((row) => row.itemId).sort(), [jobAItem1, jobBItem1].sort());
assert.equal(firstClaims.some((row) => row.itemId === jobAItem2), false);
await completeAndSetStable(jobAItem1, "BLOCKED");
assert.equal((await claimOne()).itemId, jobAItem2);
```

Add a retry case: while item 2 has an unexpired `PROCESSING` lease, move item 1 back to `PLANNING` and enqueue its retry; assert no second record in that job is claimed until item 2 becomes stable, then item 1 is claimed before any later item.

- [ ] **Step 3: Run tests to verify the unit test fails and integration is opt-in**

Run:

```bash
node --test server/tests/auto-listing-ai-outbox-postgres.test.mjs server/tests/auto-listing-batch-order-postgres.integration.test.mjs
```

Expected: unit FAIL on missing SQL gates; integration SKIP unless the disposable DB flags are present.

- [ ] **Step 4: Add the single authoritative candidate gate**

Replace the candidate selection with an account-scoped join:

```sql
SELECT outbox.id
  FROM auto_listing_ai_outbox AS outbox
  JOIN auto_listing_job_items AS item
    ON item.account_id=outbox.account_id AND item.job_id=outbox.job_id AND item.id=outbox.item_id
 WHERE outbox.account_id=$1 AND outbox.contract_version='V1' AND outbox.attempts < $6
   AND ((outbox.state='PENDING' AND outbox.next_retry_at <= NOW())
     OR (outbox.state='PROCESSING' AND outbox.lease_expires_at <= NOW()))
   AND NOT EXISTS (
     SELECT 1 FROM auto_listing_job_items AS predecessor
      WHERE predecessor.account_id=item.account_id AND predecessor.job_id=item.job_id
        AND predecessor.source_order < item.source_order
        AND predecessor.status NOT IN ('SUCCEEDED','READY_FOR_REVIEW','RETRYABLE_ERROR','BLOCKED','CANCELLED')
   )
   AND NOT EXISTS (
     SELECT 1 FROM auto_listing_ai_outbox AS live
      WHERE live.account_id=outbox.account_id AND live.job_id=outbox.job_id
        AND live.id<>outbox.id AND live.contract_version='V1'
        AND live.state='PROCESSING' AND live.lease_expires_at > NOW()
   )
 ORDER BY outbox.created_at,outbox.id
 LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
```

Do not duplicate this predicate in the service or Worker. Account discovery remains a cheap hint; claim is the only state-changing authority.

- [ ] **Step 5: Run unit and disposable integration tests**

Run unit test:

```bash
node --test server/tests/auto-listing-ai-outbox-postgres.test.mjs
```

Run integration only against the explicitly disposable database:

```bash
AUTO_LISTING_POSTGRES_TESTS=1 SONLI_MIGRATION_TEST_DATABASE_URL="$SONLI_MIGRATION_TEST_DATABASE_URL" node --test --test-concurrency=1 server/tests/auto-listing-batch-order-postgres.integration.test.mjs
```

Expected: PASS; never substitute the normal application database for `SONLI_MIGRATION_TEST_DATABASE_URL`.

- [ ] **Step 6: Commit only Task 4 hunks**

```bash
git add -p server/auto-listing-ai-outbox-postgres.mjs server/tests/auto-listing-ai-outbox-postgres.test.mjs
git add server/tests/auto-listing-batch-order-postgres.integration.test.mjs
git diff --cached --check
git commit -m "feat: process auto-listing batches sequentially"
```

---

### Task 5: Frontend multiplier, selection, progress, duration, and filter pure functions

**Files:**
- Modify: `app/src/auto-listing-config.js`
- Modify: `app/src/auto-listing-view.js`
- Modify: `app/tests/auto-listing-config.test.mjs`
- Modify: `app/tests/auto-listing-view.test.mjs`

**Interfaces:**
- Produces: `multiplierToMicros(text): string`, `microsToMultiplier(value): string`, `autoListingCollectSelectionRows(localData, collectIds)`, `autoListingTaskProgress(row)`, `autoListingTaskDuration(row, nowMs)`, `autoListingTaskMatchesFilter(row, filter)`.
- Consumes: backend `failureStage`, source projection, job/item timestamps, status and workflow progress.

- [ ] **Step 1: Write failing multiplier helper tests**

```js
assert.equal(multiplierToMicros("1"), "1000000");
assert.equal(multiplierToMicros("1.25"), "1250000");
assert.equal(multiplierToMicros("0.000001"), "1");
assert.equal(microsToMultiplier("1250000"), "1.25");
for (const value of ["0", "-1", "1.0000001", "1e2", ""]) {
  assert.throws(() => multiplierToMicros(value), { code: "AUTO_LISTING_PRICE_MULTIPLIER_INVALID" });
}
```

Update `deriveAutoListingConfig` and `previewAutoListingPrice` expectations so the normalized config contains `priceMultiplierMicros` and the preview matches backend order/rounding.

- [ ] **Step 2: Write failing task-center pure-function tests**

```js
assert.deepEqual(autoListingCollectSelectionRows(localData, ["collect-b", "collect-a"]).map((row) => row.id), ["collect-b", "collect-a"]);
assert.equal(autoListingTaskProgress({ status: "UPLOADING" }).percent, 95);
assert.deepEqual(autoListingTaskDuration({
  status: "SUCCEEDED", jobCreatedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:02:03.000Z",
}, Date.parse("2026-08-25T01:00:00.000Z")), { milliseconds: 123000, terminal: true, prefix: "总用时" });
assert.equal(autoListingTaskMatchesFilter({ status: "BLOCKED", failureStage: "UPLOAD" }, "upload-failed"), true);
assert.equal(autoListingTaskMatchesFilter({ status: "RETRYABLE_ERROR", failureStage: "GENERATION" }, "generation-failed"), true);
```

Also test placeholder thumbnails, active duration using `nowMs`, failed duration prefix `未上架 · 已用时`, all seven filters, and a failed item never reporting 100%.

- [ ] **Step 3: Run frontend pure-function tests to verify they fail**

Run:

```bash
node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs
```

Expected: FAIL because the new helpers and fields do not exist.

- [ ] **Step 4: Implement exact frontend multiplier conversion**

```js
export function multiplierToMicros(value) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(String(value ?? "").trim());
  if (!match) throw configError("AUTO_LISTING_PRICE_MULTIPLIER_INVALID");
  const micros = (BigInt(match[1]) * 1_000_000n) + BigInt((match[2] || "").padEnd(6, "0") || "0");
  if (micros <= 0n || micros > 9_223_372_036_854_775_807n) throw configError("AUTO_LISTING_PRICE_MULTIPLIER_INVALID");
  return String(micros);
}
```

Implement the inverse without `Number`. Add `priceMultiplierMicros` to `deriveAutoListingConfig` and apply it after adjustment in `previewAutoListingPrice` using the same half-up integer formula as the server.

- [ ] **Step 5: Implement task-center projections as pure functions**

Use these status percentages:

```js
const STATUS_PERCENT = Object.freeze({
  CREATED: 5, SOURCE_READY: 15, PLANNING: 30, GENERATING: 60,
  READY_FOR_REVIEW: 80, UPLOAD_QUEUED: 85, UPLOADING: 95, SUCCEEDED: 100,
});
```

For terminal failure statuses derive the last reached range from `workflowProgress.phase` and `failureStage`, capped below 100. Implement filter keys exactly as `all`, `processing`, `review`, `generation-failed`, `upload-failed`, `succeeded`, `cancelled`.

`autoListingCollectSelectionRows` must preserve `collectIds` order and safely pick `image || primaryImage || images[0]`, `name || title || productUrl`, and `sku || id`; invalid/missing values become empty strings or the source ID, not blockers.

- [ ] **Step 6: Run frontend pure-function tests**

Run:

```bash
node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit only Task 5 hunks**

```bash
git add -p app/src/auto-listing-config.js app/src/auto-listing-view.js app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs
git diff --cached --check
git commit -m "feat: add auto-listing task center projections"
```

---

### Task 6: Build the creation and task-center tabs

**Files:**
- Modify: `app/src/AutoListingPage.jsx`
- Modify: `app/src/auto-listing-page.css`
- Modify: `app/tests/auto-listing-page-contract.test.mjs`
- Create: `app/tests/auto-listing-task-center.browser.test.mjs`

**Interfaces:**
- Consumes: Task 5 pure functions and the expanded jobs DTO.
- Produces: two top-level tabs, ordered source list, multiplier input, task filters, thumbnail/progress/duration columns.

- [ ] **Step 1: Write a failing page contract test**

```js
assert.match(page, /创建任务/);
assert.match(page, /任务中心/);
assert.match(page, /name="priceMultiplier"|name=\{"priceMultiplier"\}/);
assert.match(page, /上架倍率/);
assert.match(page, /任务用时/);
assert.match(page, /<Progress/);
assert.match(page, /sourceThumbnailUrl/);
assert.doesNotMatch(page, /title=\{`已选择 \$\{collectIds\.length\} 个采集箱商品`\}/);
```

- [ ] **Step 2: Write the browser test with mocked APIs**

The browser test must render two selected collect items in URL order, switch to task center, and assert filters and table cells:

```js
await expect(page.getByText("1. 商品 B")).toBeVisible();
await expect(page.getByText("2. 商品 A")).toBeVisible();
await page.getByRole("tab", { name: "任务中心" }).click();
await expect(page.getByRole("columnheader", { name: "任务用时" })).toBeVisible();
await page.getByRole("tab", { name: "上架失败" }).click();
await expect(page.getByText("上传失败商品")).toBeVisible();
await expect(page.getByText("生成失败商品")).not.toBeVisible();
```

Mock preferences with `priceMultiplierMicros: "1000000"`, mock task rows for all filter groups, and capture the create request to assert `collectItemIds` order plus `priceMultiplierMicros`.

- [ ] **Step 3: Run page tests to verify they fail**

Run:

```bash
node --test app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-task-center.browser.test.mjs
```

Expected: FAIL because the current page has one continuous layout and no multiplier/task-center controls.

- [ ] **Step 4: Add form state and request wiring**

Add `priceMultiplier: "1"` to `DEFAULT_FORM`. Hydrate it with `microsToMultiplier(preference.priceMultiplierMicros || "1000000")`, and submit:

```js
priceMultiplierMicros: multiplierToMicros(values.priceMultiplier),
```

On successful task creation set the top-level active tab to `tasks`. Keep the existing idempotency fingerprint based on normalized config so a changed multiplier creates a new intent.

- [ ] **Step 5: Render the ordered collect selection list and unified controls**

Use `autoListingCollectSelectionRows(localData, collectIds)` and render each item with order, thumbnail or placeholder, title and SKU/source ID. Do not add client-side blocking validation for missing optional title or image.

Place “上架倍率” directly below “售价加减” in the same configuration grid. Update the price explanation to end with “最后加减上面的金额，再乘以上架倍率”。

- [ ] **Step 6: Split the page into top-level tabs and build the task table**

Keep the source and form cards under `create`; move imports and the task table under `tasks`. Add filter tabs with keys from Task 5. The task columns must render:

```jsx
<img className="auto-listing-task-thumbnail" src={row.sourceThumbnailUrl} alt={row.sourceTitle || "来源商品"} />
<Progress percent={progress.percent} status={progress.status} size="small" />
```

Show the short source ID below the image, duration from `autoListingTaskDuration`, and retain all existing action buttons. Use existing three-second job polling; add a one-second display clock only while the task center is visible and contains a nonterminal task.

- [ ] **Step 7: Add page-scoped responsive CSS**

```css
.auto-listing-page .ant-select-selector,
.auto-listing-page .ant-input,
.auto-listing-page .ant-input-number {
  min-height: 40px;
}

.auto-listing-task-thumbnail {
  width: 64px;
  height: 64px;
  object-fit: contain;
  border-radius: 8px;
  background: #f8fafc;
}

.auto-listing-source-list {
  display: grid;
  gap: 10px;
}
```

Add a narrow-screen rule that keeps the source list single-column and allows the task table to scroll horizontally. Do not modify global Ant Design styles.

- [ ] **Step 8: Run page tests and build**

Run:

```bash
node --test app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-task-center.browser.test.mjs
pnpm --dir app build
```

Expected: tests PASS and Vite build succeeds.

- [ ] **Step 9: Commit only Task 6 hunks**

```bash
git add -p app/src/AutoListingPage.jsx app/src/auto-listing-page.css app/tests/auto-listing-page-contract.test.mjs
git add app/tests/auto-listing-task-center.browser.test.mjs
git diff --cached --check
git commit -m "feat: add auto-listing task center UI"
```

---

### Task 7: Cross-module regression and representative verification

**Files:**
- Create: `docs/superpowers/verification/2026-08-25-auto-listing-batch-task-center.md`

This task does not introduce business-code changes. A discovered regression returns to the owning task and reruns that task's test cycle before verification resumes.

**Interfaces:**
- Consumes: all prior task contracts.
- Produces: evidence of unit, disposable-database, build, browser and representative read-only verification.

- [ ] **Step 1: Run the focused backend regression suite**

```bash
node --test \
  server/tests/auto-listing-batch-order-multiplier-migration.test.mjs \
  server/tests/auto-listing-contract.test.mjs \
  server/tests/auto-listing-pricing.test.mjs \
  server/tests/auto-listing-preferences-postgres.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  server/tests/auto-listing-repository.test.mjs \
  server/tests/auto-listing-ai-outbox-postgres.test.mjs \
  server/tests/auto-listing-routes.test.mjs \
  server/tests/auto-listing-view.test.mjs \
  server/tests/auto-listing-overlay.test.mjs
```

Expected: PASS with no test silently skipped except tests explicitly requiring disposable PostgreSQL.

- [ ] **Step 2: Run disposable PostgreSQL sequencing verification**

First verify the URL is explicitly marked for disposable migration tests. Then run:

```bash
AUTO_LISTING_POSTGRES_TESTS=1 SONLI_MIGRATION_TEST_DATABASE_URL="$SONLI_MIGRATION_TEST_DATABASE_URL" node --test --test-concurrency=1 server/tests/auto-listing-batch-order-postgres.integration.test.mjs
```

Expected: PASS for same-batch serialization, failure release, retry gating and cross-batch parallelism. If no disposable URL is available, record this exact scope as unverified and do not substitute the normal database.

- [ ] **Step 3: Run frontend tests and production build**

```bash
node --test app/tests/auto-listing-config.test.mjs app/tests/auto-listing-view.test.mjs app/tests/auto-listing-page-contract.test.mjs app/tests/auto-listing-task-center.browser.test.mjs
pnpm --dir app build
```

Expected: PASS.

- [ ] **Step 4: Perform representative read-only data verification**

Against the existing application database, use read-only SQL only:

```sql
BEGIN READ ONLY;
SELECT i.account_id,i.job_id,i.id,i.source_order,i.status,i.created_at,i.updated_at,
       s.source_record_id,s.snapshot#>>'{identity,primaryName}' AS title,
       s.snapshot#>>'{identity,primarySku}' AS sku,
       CASE WHEN jsonb_typeof(s.snapshot#>'{media,images,0}')='string'
            THEN s.snapshot#>>'{media,images,0}' ELSE '' END AS thumbnail
  FROM auto_listing_job_items i
  JOIN auto_listing_source_snapshots s ON s.account_id=i.account_id AND s.id=i.snapshot_id
 ORDER BY i.created_at DESC,i.job_id,i.source_order
 LIMIT 20;
ROLLBACK;
```

Confirm at least one successful, one generation failure, one upload failure and one waiting-review task project safely. Do not clean, rewrite or reclassify historical records.

- [ ] **Step 5: Run browser E2E without paid or Ozon side effects**

Open the local automatic-listing URL with two representative collect IDs. Verify ordered selection, multiplier default 1, control heights, task-center switch, image fallbacks, progress, duration and filters. Use mocked create APIs or keep Workers stopped so this verification cannot trigger paid AI or Ozon writes.

Expected: the page is usable at desktop and narrow viewport; no actual Ozon submission occurs.

- [ ] **Step 6: Write the verification record**

The verification document must state:

```markdown
# 自动上架批次任务中心验证

- 修改批次与提交：列出 Tasks 1–6 的提交。
- 数据库：迁移只新增顺序、倍率、约束和索引；是否在一次性测试库实际执行。
- 核心结果：同批次逐件处理、失败放行、倍率精确计算、任务中心展示。
- 测试与执行时间：逐条记录命令、结果和大致耗时。
- 代表性数据：记录只读验证覆盖的状态类型，不复制敏感业务内容。
- 未验证：生产迁移、付费 AI、真实 Ozon 上传如未执行必须明确列出。
- 回滚：按批次回滚代码；数据库附加字段保留，不做破坏性降级。
```

- [ ] **Step 7: Commit verification evidence only**

```bash
git add docs/superpowers/verification/2026-08-25-auto-listing-batch-task-center.md
git diff --cached --check
git commit -m "docs: verify auto-listing batch task center"
```
