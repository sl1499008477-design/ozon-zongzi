# 自动上架配置驱动固定骨架与规划诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为精确账号和采集商品的新任务冻结用户提交的 6～13 张图片配置，由系统生成确定骨架、AI 只填俄语文案，并为旧规划失败提供可追溯的逐项诊断和一次幂等文字复现。

**Architecture:** 在任务创建边界冻结 `LEGACY_FULL_PLAN_V3` 或 `FIXED_SKELETON_V1`，并将合同写入任务商品、规划尝试和最终计划。规划器拆成“系统骨架 + 动态填充 Schema + 统一详细校验”，AI 原始结构化响应和校验问题在最终校验前以不可变证据保存。管理员接口只读投影诊断证据，并提供不改变任务状态、不生成图片、不调用 Ozon 的一次性文字复现命令。

**Tech Stack:** Node.js ESM、PostgreSQL 16、`node:test`、React、Ant Design、现有 pg-boss AI outbox、现有 sub2API 文本和图片网关。

## Global Constraints

- 当前数据库最新迁移为 `073_store_currency_authority.sql`；本功能只新增向前兼容的 `074`，不得重写 001～073。
- 图片数量读取并冻结任务创建时的配置：主图 1、卖点图 2～5、细节图 1～2、场景图 1～2、尺寸图 0～1、信息图 1～2，总数 6～13。
- 固定的是任务内的数量、顺序、职责和结构字段，不是永久固定 8 张；当前 8 张只作为测试样例。
- 当前试验商品的冻结来源必须精确包含一个视觉组；固定骨架 V1 的最终图片总数等于页面配置总数，绝不按视觉组倍增。若新来源出现多个视觉组，必须在 AI 调用前以固定错误停止。
- 配置要求尺寸图但没有可靠商品尺寸证据时，在 AI 和图片调用前失败；不得静默减图、换职责或使用物流包装尺寸。
- `FIXED_SKELETON_V1` 只由后端精确账号 + `collectItemId` 门禁选择，前端不能提交或覆盖规划合同。
- 旧任务、其他账号、其他商品和 Excel 导入默认继续使用 `LEGACY_FULL_PLAN_V3`。
- 固定骨架试验商品无论账号上传策略如何变化，都必须停在 `READY_FOR_REVIEW`；审核前 Ozon 商品、库存和上传写调用为零。
- 本次不增加竞品搜索、竞品评分、类目策略配置页或生产 V1 类目失败规则。
- 诊断响应不保存密钥、完整内部提示词、模型推理或供应商原始错误；普通任务接口不暴露诊断详情。
- 自动化测试不得调用真实 AI、Ozon、对象存储或生产数据库；真实文字复现和完整图片试验分别在执行前再次确认费用。
- 所有新 DTO 均使用闭合字段、后端账号/任务/商品/快照边界、代理/访问器安全投影、大小上限和递归冻结。

---

## File Map

### New focused modules

- `server/auto-listing-planning-contract.mjs`：解析精确试验门禁并选择冻结规划合同。
- `server/auto-listing-content-plan-validator.mjs`：统一返回逐项问题并兼容原 `validateContentPlan` 抛错合同。
- `server/auto-listing-fixed-skeleton.mjs`：构建确定骨架、动态填充 Schema、合并 AI 填充。
- `server/auto-listing-content-plan-evidence-postgres.mjs`：保存/读取不可变响应和验证结果。
- `server/auto-listing-plan-diagnostic-context-postgres.mjs`：只读重建旧任务冻结规划上下文。
- `server/auto-listing-plan-diagnostic-service.mjs`：管理员详情和一次性文字复现用例。
- `server/auto-listing-plan-diagnostic-routes.mjs`：管理员诊断 HTTP 合同。
- `server/auto-listing-plan-diagnostic-runtime.mjs`：组合 PostgreSQL、网关、凭据和诊断服务。
- `app/src/auto-listing-plan-diagnostics.js`：前端诊断 DTO 安全投影和展示模型。

### Existing production modules changed in place

- `server/runtime-config.mjs`：读取默认关闭的精确试验门禁。
- `server/auto-listing-item-image-config.mjs`：禁止缺尺寸时静默删掉尺寸图。
- `server/auto-listing-service.mjs`：为每个新任务商品选择规划合同。
- `server/auto-listing-runtime.mjs`：注入合同选择器并暴露独立诊断运行时。
- `server/auto-listing-repository.mjs`：持久化规划合同并读取可感知进度。
- `server/auto-listing-ai-phase-context-postgres.mjs`：加载冻结规划合同和对应提示模板版本。
- `server/auto-listing-content-planner.mjs`：按冻结合同分派 legacy 或固定骨架，并在校验前保存响应。
- `server/auto-listing-content-plan-repository.mjs`：规划尝试和最终计划绑定合同、骨架哈希。
- `server/auto-listing-ai-runtime-composition.mjs`：组合固定骨架、证据仓储和两套提示模板。
- `server/auto-listing-ai-workflow-postgres.mjs`：固定骨架任务强制进入人工审核。
- `server/auto-listing-routes.mjs`：闭合投影规划合同和扩展后的持久进度。
- `server/auto-listing-web-runtime.mjs`、`server/index.mjs`：挂载独立管理员诊断路由。
- `app/src/auto-listing-view.js`、`app/src/AutoListingPage.jsx`：显示阶段、动态图片总数和管理员诊断抽屉。

### Database and verification artifacts

- `server/db/migrations/074_auto_listing_configurable_skeleton_diagnostics.sql`：冻结合同、骨架身份、诊断运行和不可变证据。
- `server/tests/auto-listing-configurable-skeleton-e2e.test.mjs`：fresh PostgreSQL + fake gateway/object/Ozon 的完整组合测试。
- `docs/superpowers/verification/2026-08-14-auto-listing-configurable-fixed-skeleton.md`：自动化证据、未验证范围、费用门禁、回滚和真实试验结果。

---

### Task 1: Freeze the pilot contract and reject silent image-count changes

**Files:**
- Create: `server/auto-listing-planning-contract.mjs`
- Modify: `server/runtime-config.mjs`
- Modify: `server/auto-listing-item-image-config.mjs`
- Test: `server/tests/auto-listing-planning-contract.test.mjs`
- Test: `server/tests/auto-listing-item-image-config.test.mjs`

**Interfaces:**
- Produces: `AUTO_LISTING_PLANNING_CONTRACTS`, `selectAutoListingPlanningContract(input)`.
- Produces from runtime config: `autoListingFixedSkeletonPilotScope(env)`.
- Produces: `deriveEffectiveAutoListingImageConfig(input)` that preserves the exact frozen role counts or fails before external calls.
- Consumes: existing `verifyAutoListingFrozenConfig` and `verifyAutoListingSourceSnapshot`.

- [ ] **Step 1: Write the contract-selection failing tests**

```js
test("selects fixed skeleton only for the exact enabled account and collect item", () => {
  const pilotScope = autoListingFixedSkeletonPilotScope({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "true",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
    AUTO_LISTING_FIXED_SKELETON_PILOT_COLLECT_ITEM_ID: "collect-a",
  });
  assert.equal(selectAutoListingPlanningContract({
    pilotScope, accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-a",
  }), "FIXED_SKELETON_V1");
  for (const candidate of [
    { accountId: "account-b", sourceType: "COLLECT_BOX", collectItemId: "collect-a" },
    { accountId: "account-a", sourceType: "COLLECT_BOX", collectItemId: "collect-b" },
    { accountId: "account-a", sourceType: "EXCEL_SKU", collectItemId: "collect-a" },
  ]) assert.equal(selectAutoListingPlanningContract({ pilotScope, ...candidate }), "LEGACY_FULL_PLAN_V3");
});

test("disabled or incomplete pilot configuration fails closed to no scope", () => {
  assert.equal(autoListingFixedSkeletonPilotScope({}), null);
  assert.throws(() => autoListingFixedSkeletonPilotScope({
    AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED: "true",
    AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID: "account-a",
  }), { code: "AUTO_LISTING_FIXED_SKELETON_CONFIG_INVALID" });
});
```

- [ ] **Step 2: Run the selector test and confirm RED**

Run: `node --test server/tests/auto-listing-planning-contract.test.mjs`

Expected: FAIL because the planning-contract module, selector exports and runtime scope reader do not exist.

- [ ] **Step 3: Implement the closed selector**

```js
export const AUTO_LISTING_PLANNING_CONTRACTS = Object.freeze({
  LEGACY: "LEGACY_FULL_PLAN_V3",
  FIXED: "FIXED_SKELETON_V1",
});

export function autoListingFixedSkeletonPilotScope(env = process.env) {
  const enabled = ["1", "true"].includes(String(env.AUTO_LISTING_FIXED_SKELETON_PILOT_ENABLED || "").trim().toLowerCase());
  if (!enabled) return null;
  const accountId = safeId(env.AUTO_LISTING_FIXED_SKELETON_PILOT_ACCOUNT_ID);
  const collectItemId = safeId(env.AUTO_LISTING_FIXED_SKELETON_PILOT_COLLECT_ITEM_ID);
  if (!accountId || !collectItemId) throw contractError("AUTO_LISTING_FIXED_SKELETON_CONFIG_INVALID");
  return Object.freeze({ accountId, collectItemId });
}

export function selectAutoListingPlanningContract({ pilotScope, accountId, sourceType, collectItemId }) {
  return pilotScope && sourceType === "COLLECT_BOX"
    && pilotScope.accountId === accountId && pilotScope.collectItemId === collectItemId
    ? AUTO_LISTING_PLANNING_CONTRACTS.FIXED
    : AUTO_LISTING_PLANNING_CONTRACTS.LEGACY;
}
```

- [ ] **Step 4: Write the missing-dimensions RED test**

```js
test("a requested specification slot without trusted dimensions fails instead of reallocating", () => {
  const input = fixture({ roles: { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 }, productMeasurements: {} });
  assert.throws(() => deriveEffectiveAutoListingImageConfig(input), {
    code: "AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED",
  });
});
```

- [ ] **Step 5: Replace silent specification removal with exact preservation**

```js
if (config.image.roles.specification > 0 && !hasReliableProductDimensions(snapshot.productMeasurements)) {
  throw imageConfigError("AUTO_LISTING_PRODUCT_DIMENSIONS_REQUIRED");
}
return deepFreeze({
  ratio: config.image.ratio,
  resolution: config.image.resolution,
  quality: config.image.quality,
  language: config.image.language,
  roles: { ...config.image.roles },
  total: config.image.total,
  reasonCodes: [],
});
```

- [ ] **Step 6: Run focused tests**

Run: `node --test server/tests/auto-listing-planning-contract.test.mjs server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-contract.test.mjs`

Expected: all tests PASS; 6-, 8-, and 13-image frozen configurations preserve exact counts, and requested specification without trusted dimensions fails before any port call.

- [ ] **Step 7: Commit Task 1**

```bash
git add server/auto-listing-planning-contract.mjs server/runtime-config.mjs server/auto-listing-item-image-config.mjs server/tests/auto-listing-planning-contract.test.mjs server/tests/auto-listing-item-image-config.test.mjs
git commit -m "feat(auto-listing): freeze configurable planning contract"
```

---

### Task 2: Add migration 074 and persist the planning contract end to end

**Files:**
- Create: `server/db/migrations/074_auto_listing_configurable_skeleton_diagnostics.sql`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-ai-phase-context-postgres.mjs`
- Modify: `server/auto-listing-ai-workflow-postgres.mjs`
- Test: `server/tests/auto-listing-configurable-skeleton-migration.test.mjs`
- Test: `server/tests/auto-listing-service.test.mjs`
- Test: `server/tests/auto-listing-repository.test.mjs`
- Test: `server/tests/auto-listing-ai-phase-context-postgres.test.mjs`
- Test: `server/tests/auto-listing-ai-workflow-postgres.test.mjs`

**Interfaces:**
- Consumes: Task 1 `selectAutoListingPlanningContract`.
- Produces: `auto_listing_job_items.planning_contract`, `ai_content_plans.planning_contract`, `ai_content_plans.skeleton_hash`, and matching attempt identity.
- Produces: `loadPlanInput()` result field `planningContract`.
- Produces: durable review override: fixed skeleton completion always returns `CONTENT_READY_FOR_REVIEW` / `READY_FOR_REVIEW`.

- [ ] **Step 1: Write migration static RED tests**

```js
test("074 is additive and freezes planning contracts plus immutable diagnostics", async () => {
  const sql = await readMigration("074_auto_listing_configurable_skeleton_diagnostics.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3'/iu);
  assert.match(sql, /CHECK \(planning_contract IN \('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1'\)\)/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_diagnostic_runs/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_responses/iu);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS auto_listing_content_plan_validation_results/iu);
  assert.match(sql, /planner_stage/iu);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/iu);
});
```

- [ ] **Step 2: Run migration test and confirm RED**

Run: `node --test server/tests/auto-listing-configurable-skeleton-migration.test.mjs`

Expected: FAIL because migration 074 does not exist.

- [ ] **Step 3: Add the forward-only schema**

Implement these exact identities and checks in 074:

```sql
ALTER TABLE auto_listing_job_items
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3';
ALTER TABLE auto_listing_job_items
  ADD CONSTRAINT auto_listing_job_items_planning_contract_check
  CHECK (planning_contract IN ('LEGACY_FULL_PLAN_V3','FIXED_SKELETON_V1')) NOT VALID;

ALTER TABLE ai_content_plans
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3',
  ADD COLUMN IF NOT EXISTS skeleton_hash TEXT;

ALTER TABLE auto_listing_content_plan_attempts
  ADD COLUMN IF NOT EXISTS planning_contract TEXT NOT NULL DEFAULT 'LEGACY_FULL_PLAN_V3',
  ADD COLUMN IF NOT EXISTS skeleton_hash TEXT,
  ADD COLUMN IF NOT EXISTS planner_stage TEXT;
```

Constrain `planner_stage` to `BUILDING_SKELETON|FILLING_COPY|VALIDATING_COPY|COMPLETED|FAILED`. Legacy attempts start at `FILLING_COPY`; fixed attempts start at `BUILDING_SKELETON`. Only an active attempt may advance, and terminal stages are immutable.

Add `auto_listing_content_plan_diagnostic_runs` with exact account/job/item/snapshot/status-version/profile/input/idempotency/request-hash/correlation/actor identity, status `RUNNING|ACCEPTED|REJECTED|FAILED`, `cost_confirmed = TRUE`, and account-scoped composite FKs. Add `auto_listing_content_plan_responses` with exactly one owner (`attempt_id` XOR `diagnostic_run_id`), planning contract, input/skeleton hashes, model evidence, bounded response JSON and response hash. Add `auto_listing_content_plan_validation_results` with response identity, validator version, `ACCEPTED|REJECTED`, bounded issues array and one-result-per-response uniqueness.

Use append-only triggers that reject direct update/delete with SQLSTATE `23514`, while allowing account-parent cleanup only when the owning parent row no longer exists. Add exact indexes for `(account_id,job_id,item_id,created_at,id)` and `(account_id,idempotency_key)`.

- [ ] **Step 4: Write service/repository RED tests for frozen selection**

```js
test("job creation assigns each item contract on the server and ignores client attempts", async () => {
  const result = await service.createAutoListingJob(requestFor(["collect-fixed", "collect-legacy"]));
  assert.deepEqual(repository.lastGraph.items.map((item) => item.planningContract), [
    "FIXED_SKELETON_V1", "LEGACY_FULL_PLAN_V3",
  ]);
  assert.equal(Object.hasOwn(repository.lastGraph.configSnapshot, "planningContract"), false);
});
```

- [ ] **Step 5: Thread the contract through creation and persistence**

Inject `selectPlanningContract` into `createAutoListingService`, defaulting to legacy for existing tests. In `buildJobItems`, set:

```js
planningContract: selectPlanningContract({ accountId, sourceType, collectItemId }),
```

In `createJobGraph`, validate the two allowed values, insert `planning_contract`, include it in event details, and return it from `readJobWithClient`. In the runtime, construct the selector from `autoListingFixedSkeletonPilotScope(env)`; never accept the contract from request JSON.

- [ ] **Step 6: Load the contract into every PLAN_CONTENT context**

Add `i.planning_contract` to the phase-context query and return:

```js
planningContract: normalizePlanningContract(bundle.planning_contract),
```

Reject null, extra values, or a mismatch between item, planning attempt, and saved plan with `AUTO_LISTING_AI_EVIDENCE_INVALID` before the gateway call.

- [ ] **Step 7: Force fixed skeleton completion to review**

In the rich-content completion transaction, read `i.planning_contract`. Use the frozen upload policy for legacy tasks, but apply this exact branch for fixed tasks:

```js
const completion = item.planning_contract === "FIXED_SKELETON_V1"
  ? { event: "CONTENT_READY_FOR_REVIEW", status: "READY_FOR_REVIEW", invokeUpload: false }
  : decideAutoListingContentCompletion({ frozenPolicy, directUploadAllowed });
```

Add assertions that no upload outbox row is created even when the account's latest policy is `DIRECT`.

- [ ] **Step 8: Run migration and persistence tests**

Run: `node --test server/tests/auto-listing-configurable-skeleton-migration.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-workflow-postgres.test.mjs`

Expected: PASS; legacy rows read as legacy, fixed tasks persist exact contracts, wrong contracts fail closed, and fixed completion queues zero uploads.

- [ ] **Step 9: Commit Task 2**

```bash
git add server/db/migrations/074_auto_listing_configurable_skeleton_diagnostics.sql server/auto-listing-service.mjs server/auto-listing-runtime.mjs server/auto-listing-repository.mjs server/auto-listing-ai-phase-context-postgres.mjs server/auto-listing-ai-workflow-postgres.mjs server/tests/auto-listing-configurable-skeleton-migration.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-workflow-postgres.test.mjs
git commit -m "feat(auto-listing): persist planning contracts"
```

---

### Task 3: Replace generic validation with a closed detailed issue contract

**Files:**
- Create: `server/auto-listing-content-plan-validator.mjs`
- Modify: `server/auto-listing-content-planner.mjs`
- Create: `server/tests/auto-listing-content-plan-validator.test.mjs`
- Modify: `server/tests/auto-listing-content-planner.test.mjs`

**Interfaces:**
- Produces: `diagnoseContentPlan({ plan, plannerContext }) -> { status, validatorVersion, issues, plan }`.
- Produces: `validateContentPlan(input)` re-exported from the existing planner for backward compatibility.
- Issue shape: `{ code, slotKey, claimIndex, field, expected, actual }`, with nullable location fields and bounded safe summaries.

- [ ] **Step 1: Write one RED table test per business rule family**

```js
const cases = [
  ["slot count", mutate((p) => p.slots.pop()), "SLOT_COUNT_MISMATCH", null, "slots"],
  ["slot order", mutate((p) => { p.slots[1].order = 99; }), "SLOT_ORDER_MISMATCH", "group-a:selling-point:01", "order"],
  ["role count", mutate((p) => { p.slots[1].role = "DETAIL"; }), "ROLE_COUNT_MISMATCH", "group-a:selling-point:01", "role"],
  ["reference", mutate((p) => { p.slots[1].referenceAssetIds = ["foreign"]; }), "REFERENCE_ASSET_OUT_OF_SCOPE", "group-a:selling-point:01", "referenceAssetIds"],
  ["fact", mutate((p) => { p.slots[1].claims[0].sourceFactIds = ["missing"]; }), "SOURCE_FACT_NOT_FOUND", "group-a:selling-point:01", "claims[0].sourceFactIds"],
  ["number", mutate((p) => { p.slots.at(-2).claims[0].text = "Высота 999 см"; }), "NUMERIC_EVIDENCE_MISMATCH", null, "claims[0].text"],
  ["prohibited", mutate((p) => { p.slots[1].claims[0].text = "Гарантия 10 лет"; }), "PROHIBITED_CLAIM", null, "claims[0].text"],
];
for (const [, plan, code, slotKey, field] of cases) {
  const result = diagnoseContentPlan({ plan, plannerContext });
  assert.equal(result.status, "REJECTED");
  assert.ok(result.issues.some((issue) => issue.code === code
    && (slotKey === null || issue.slotKey === slotKey) && issue.field === field));
}
```

- [ ] **Step 2: Run validator tests and confirm RED**

Run: `node --test server/tests/auto-listing-content-plan-validator.test.mjs`

Expected: FAIL because the detailed validator is missing and the existing validator only throws `AUTO_LISTING_CONTENT_PLAN_INVALID`.

- [ ] **Step 3: Implement bounded issue collection**

```js
const VALIDATOR_VERSION = "AUTO_LISTING_CONTENT_PLAN_VALIDATOR_V1";
const MAX_ISSUES = 100;

function issue(list, value) {
  if (list.length >= MAX_ISSUES) return;
  list.push(Object.freeze({
    code: safeCode(value.code),
    slotKey: safeNullableText(value.slotKey, 500),
    claimIndex: Number.isSafeInteger(value.claimIndex) ? value.claimIndex : null,
    field: safeNullableText(value.field, 240),
    expected: safeSummary(value.expected),
    actual: safeSummary(value.actual),
  }));
}
```

Move the current structural, fact, Russian text, number/unit and prohibited-claim checks into `diagnoseContentPlan`. Collect independent issues without reading untrusted accessors; stop only when the carrier itself cannot be safely projected. If no issues, return a recursively frozen normalized plan. Implement `validateContentPlan` as:

```js
export function validateContentPlan(input) {
  const result = diagnoseContentPlan(input);
  if (result.status !== "ACCEPTED") throw contentPlanError();
  return result.plan;
}
```

- [ ] **Step 4: Preserve the old public export and error behavior**

Re-export `validateContentPlan` and `diagnoseContentPlan` from `auto-listing-content-planner.mjs`. Existing callers must still receive only `AUTO_LISTING_CONTENT_PLAN_INVALID`; detailed issues are written to evidence and shown only through the admin path.

- [ ] **Step 5: Add hostile carrier tests**

Cover active/revoked proxies, getters, custom prototypes, cycles, dangerous keys, strings over 2,000,000 characters, more than 1,000 slots, and more than 100 issues. Assert getter/trap count zero and that `expected`/`actual` never contain raw credential-like fixture strings.

- [ ] **Step 6: Run focused legacy regression**

Run: `node --test server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-content-planner.test.mjs`

Expected: PASS; existing accepted plans remain accepted and all existing invalid fixtures still throw the same public error code.

- [ ] **Step 7: Commit Task 3**

```bash
git add server/auto-listing-content-plan-validator.mjs server/auto-listing-content-planner.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-content-planner.test.mjs
git commit -m "feat(auto-listing): diagnose content plan rules"
```

---

### Task 4: Persist the structured response before business validation

**Files:**
- Create: `server/auto-listing-content-plan-evidence-postgres.mjs`
- Modify: `server/auto-listing-content-plan-repository.mjs`
- Modify: `server/auto-listing-content-planner.mjs`
- Modify: `server/auto-listing-ai-runtime-composition.mjs`
- Create: `server/tests/auto-listing-content-plan-evidence-postgres.test.mjs`
- Modify: `server/tests/auto-listing-content-plan-repository.test.mjs`
- Modify: `server/tests/auto-listing-content-planner.test.mjs`

**Interfaces:**
- Produces repository methods `recordResponse(command)`, `recordValidation(command)`, `loadOutcome(scope)`.
- Changes `reserveContentPlan()` success to include `attemptId`, `planningContract`, and `skeletonHash`.
- Consumes Task 3 `diagnoseContentPlan`.

- [ ] **Step 1: Write repository RED tests for order and idempotency**

```js
test("records a bounded response before validation and replays exact evidence", async () => {
  const first = await evidence.recordResponse(responseCommand());
  const replay = await evidence.recordResponse(responseCommand());
  assert.deepEqual(replay, first);
  await assert.rejects(evidence.recordResponse(responseCommand({ responseHash: "f".repeat(64) })),
    (error) => error.code === "AUTO_LISTING_CONTENT_PLAN_EVIDENCE_CONFLICT");
});
```

Add a planner spy asserting call order `gateway -> recordResponse -> diagnose -> recordValidation -> saveContentPlan`. For an invalid plan, assert `saveContentPlan` and every image port are zero.

- [ ] **Step 2: Run evidence tests and confirm RED**

Run: `node --test server/tests/auto-listing-content-plan-evidence-postgres.test.mjs server/tests/auto-listing-content-planner.test.mjs`

Expected: FAIL because no evidence repository exists and the planner validates before persistence.

- [ ] **Step 3: Implement descriptor-safe response projection**

Accept only the planning output contract root, maximum depth 64, maximum 200,000 nodes, maximum 1,000 slots, maximum string length 2,000,000 and maximum serialized size 4 MiB. Compute the canonical SHA-256 in application code; do not persist `cause`, prompt, API key, connection secret or arbitrary provider metadata.

- [ ] **Step 4: Implement exact PostgreSQL writes**

`recordResponse` must lock and verify the owning attempt or diagnostic run, account/job/item/snapshot/profile/contract/input/skeleton identity, insert once, and return the existing row only when every immutable field and hash matches. `recordValidation` must verify the response identity, accept only Task 3's issue shape, insert once, and reject a different replay.

- [ ] **Step 5: Change planner execution order**

Before the text gateway call, persist the attempt stage as `FILLING_COPY`. After the immutable response is recorded and before business validation, advance it to `VALIDATING_COPY`; finish as `COMPLETED` or `FAILED`. For fixed tasks, Task 5 must first persist `BUILDING_SKELETON` before constructing the deterministic skeleton. A replay resumes from the durable stage and evidence instead of guessing from elapsed time.

```js
const gatewayResult = await gateway.createTextResponse(request);
const response = await evidenceRepository.recordResponse({
  owner: { kind: "ATTEMPT", id: reservation.attemptId },
  ...scope,
  planningContract: plannerContext.planningContract,
  inputHash: plannerContext.inputHash,
  skeletonHash: plannerContext.skeletonHash,
  gatewayRequestId: optionalGatewayRequestId(gatewayResult.requestId),
  response: gatewayResult.value,
});
const diagnosis = diagnoseContentPlan({ plan: response.response, plannerContext });
await evidenceRepository.recordValidation({ responseId: response.id, ...scope, ...diagnosis });
if (diagnosis.status === "REJECTED") throw contentPlanError();
```

On response-loss replay, use the same stable request key; if an exact recorded response already exists for the attempt/input, skip the gateway and continue from stored evidence. Never infer the latest response by timestamp.

- [ ] **Step 6: Wire the evidence repository into production composition**

Add `createContentPlanEvidenceRepository` to the exact port set and to phase context. Reject missing or extra ports during runtime initialization.

- [ ] **Step 7: Run focused tests**

Run: `node --test server/tests/auto-listing-content-plan-evidence-postgres.test.mjs server/tests/auto-listing-content-plan-repository.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs`

Expected: PASS; invalid business output has one response + one rejected validation, zero plan rows and zero image calls; valid output has accepted evidence plus one active plan.

- [ ] **Step 8: Commit Task 4**

```bash
git add server/auto-listing-content-plan-evidence-postgres.mjs server/auto-listing-content-plan-repository.mjs server/auto-listing-content-planner.mjs server/auto-listing-ai-runtime-composition.mjs server/tests/auto-listing-content-plan-evidence-postgres.test.mjs server/tests/auto-listing-content-plan-repository.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
git commit -m "feat(auto-listing): preserve plan validation evidence"
```

---

### Task 5: Build the configurable fixed skeleton and AI fill contract

**Files:**
- Create: `server/auto-listing-fixed-skeleton.mjs`
- Modify: `server/auto-listing-content-planner.mjs`
- Modify: `server/auto-listing-content-plan-repository.mjs`
- Modify: `server/auto-listing-ai-phase-context-postgres.mjs`
- Modify: `server/auto-listing-ai-runtime-composition.mjs`
- Create: `server/tests/auto-listing-fixed-skeleton.test.mjs`
- Modify: `server/tests/auto-listing-content-planner.test.mjs`

**Interfaces:**
- Produces: `buildFixedSkeleton({ plannerContext }) -> { plan, skeletonHash, allowedClaimsBySlot }`.
- Produces: `buildContentPlanFillSchema({ skeleton, allowedClaimsBySlot })`.
- Produces: `mergeContentPlanFill({ skeleton, fill, plannerContext }) -> ContentPlan`.
- Fixed gateway output: `{ version: 1, language: "ru", fills: { [slotKey]: { claims } } }`.

- [ ] **Step 1: Write deterministic 6/8/13 RED tests**

```js
for (const [name, roles, total] of [
  ["six", { main: 1, sellingPoint: 2, detail: 1, scene: 1, specification: 0, infographic: 1 }, 6],
  ["eight", { main: 1, sellingPoint: 3, detail: 1, scene: 1, specification: 1, infographic: 1 }, 8],
  ["thirteen", { main: 1, sellingPoint: 5, detail: 2, scene: 2, specification: 1, infographic: 2 }, 13],
]) test(`${name} config creates exact ordered skeleton`, () => {
  const first = buildFixedSkeleton({ plannerContext: context({ roles }) });
  const second = buildFixedSkeleton({ plannerContext: context({ roles }) });
  assert.equal(first.plan.slots.length, total);
  assert.equal(first.skeletonHash, second.skeletonHash);
  assert.deepEqual(first, second);
});

test("fixed skeleton rejects multiple visual groups before AI", async () => {
  await assert.rejects(planner.createContentPlan(context({ visualGroupCount: 2 })), {
    code: "AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED",
  });
  assert.equal(gateway.calls.length, 0);
});
```

- [ ] **Step 2: Run skeleton tests and confirm RED**

Run: `node --test server/tests/auto-listing-fixed-skeleton.test.mjs`

Expected: FAIL because the skeleton module does not exist.

- [ ] **Step 3: Implement stable slot construction**

Require exactly one frozen visual group for `FIXED_SKELETON_V1`, then iterate roles in:

```js
const ROLE_ORDER = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
```

Generate `slotKey` as `${visualGroupKey}:${kebabRole}:${occurrence.padStart(2,"0")}`. Copy `visualGroupKey`, role, global stable order, strategy density, group reference IDs, required preserve list and prohibited claims from frozen server evidence. Set each slot's `sourceFactIds` to the role-appropriate, group-scoped allowlist. A requested specification slot must have at least one trusted `DIMENSION_*` fact.

Never duplicate configured counts per visual group and never silently switch an already-frozen fixed task to legacy. A fixed task with zero or multiple visual groups fails before the text gateway with `AUTO_LISTING_FIXED_SKELETON_VISUAL_GROUP_UNSUPPORTED`.

- [ ] **Step 4: Implement a dynamic exact fill Schema**

Use `fills` object properties, not a free array:

```js
{
  type: "object",
  additionalProperties: false,
  required: ["version", "language", "fills"],
  properties: {
    version: { const: 1 },
    language: { const: "ru" },
    fills: {
      type: "object",
      additionalProperties: false,
      required: skeleton.plan.slots.map((slot) => slot.slotKey),
      properties: Object.fromEntries(skeleton.plan.slots.map((slot) => [slot.slotKey, fillSchemaFor(slot)])),
    },
  },
}
```

Each claim schema uses only the slot's allowed `claimType` and `sourceFactIds` enums. Do not use `oneOf`, `anyOf`, `uniqueItems`, `$ref`, `patternProperties` or gateway-unsupported keywords. `MAIN` requires `claims: []`.

- [ ] **Step 5: Implement closed merge and final validation**

Reject missing/extra/duplicate slots and every attempt to return structural fields. Copy the skeleton, insert only projected claims, and call Task 3's detailed validator. Freeze the output without freezing or mutating caller inputs.

- [ ] **Step 6: Dispatch planner by frozen contract**

```js
if (plannerContext.planningContract === "FIXED_SKELETON_V1") {
  await attempts.advanceStage(reservation.attemptId, "BUILDING_SKELETON");
  const skeleton = buildFixedSkeleton({ plannerContext });
  const gatewayResult = await gateway.createTextResponse({
    ...commonRequest,
    jsonSchema: buildContentPlanFillSchema(skeleton),
    prompt: fixedFillPrompt(plannerContext, skeleton),
  });
  candidatePlan = mergeContentPlanFill({ skeleton, fill: gatewayResult.value, plannerContext });
} else {
  candidatePlan = gatewayResult.value;
}
```

Use prompt template `AUTO_LISTING_CONTENT_PLAN_FILL_V1` for fixed and retain `AUTO_LISTING_CONTENT_PLAN_V3` for legacy. Persist `planning_contract` and `skeleton_hash`; legacy requires null skeleton hash, fixed requires a 64-character hash.

- [ ] **Step 7: Add anti-tampering tests**

Test AI attempts to remove a configured slot, add a ninth slot to an eight-slot config, change roles/order/reference/preserve/prohibited fields, use a fact from another visual group, use a wrong dimension value, add an unsupported claim type, or return a getter/proxy. Assert response evidence exists, validation is rejected, and image gateway calls remain zero.

- [ ] **Step 8: Run fixed and legacy suites**

Run: `node --test server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs`

Expected: PASS; legacy behavior remains stable, fixed 6/8/13 plans are deterministic, and the AI controls only claims.

- [ ] **Step 9: Commit Task 5**

```bash
git add server/auto-listing-fixed-skeleton.mjs server/auto-listing-content-planner.mjs server/auto-listing-content-plan-repository.mjs server/auto-listing-ai-phase-context-postgres.mjs server/auto-listing-ai-runtime-composition.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
git commit -m "feat(auto-listing): fill configurable fixed skeletons"
```

---

### Task 6: Expose safe administrator diagnostics and a real UI entry

**Files:**
- Create: `server/auto-listing-plan-diagnostic-service.mjs`
- Create: `server/auto-listing-plan-diagnostic-routes.mjs`
- Create: `server/auto-listing-plan-diagnostic-runtime.mjs`
- Modify: `server/auto-listing-web-runtime.mjs`
- Modify: `server/index.mjs`
- Create: `app/src/auto-listing-plan-diagnostics.js`
- Modify: `app/src/AutoListingPage.jsx`
- Test: `server/tests/auto-listing-plan-diagnostic-service.test.mjs`
- Test: `server/tests/auto-listing-plan-diagnostic-routes.test.mjs`
- Create: `app/tests/auto-listing-plan-diagnostics.test.mjs`
- Modify: `app/tests/auto-listing-page.test.mjs`

**Interfaces:**
- GET: `/admin/auto-listing/plan-diagnostics/items/:itemId/latest?jobId=:jobId`.
- Response: exact safe `PlanDiagnosticDetailV1` including structured response and detailed validation, excluding prompts and secrets.
- Permission: backend `AI_CONTENT_MANAGE` plus exact actor account scope.

- [ ] **Step 1: Write service and route RED tests**

```js
test("admin reads only the exact account job and item diagnostic", async () => {
  const detail = await service.getLatest({ actor: adminA, jobId: "job-a", itemId: "item-a" });
  assert.deepEqual(Object.keys(detail), [
    "responseId", "attemptId", "diagnosticRunId", "planningContract", "model",
    "promptTemplateVersion", "gatewayRequestId", "receivedAt", "response", "validation",
  ]);
  await assert.rejects(service.getLatest({ actor: adminB, jobId: "job-a", itemId: "item-a" }),
    (error) => error.code === "AUTO_LISTING_PLAN_DIAGNOSTIC_NOT_FOUND");
});
```

Test user role 403, missing/extra query fields 400, wrong tenant 404, hostile repository DTO fixed 500, and safe response with no `apiKey`, `prompt`, `cause`, `rawError` or credential fixture.

- [ ] **Step 2: Run route tests and confirm RED**

Run: `node --test server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs`

Expected: FAIL because the service and route are absent.

- [ ] **Step 3: Implement the read-only administrator use case**

Require `AI_CONTENT_MANAGE`, derive `accountId` from the actor, validate job/item IDs, and query by exact `(account_id,job_id,item_id)`. Return latest by explicit response relation and deterministic `(received_at,id)` ordering; never join another tenant or infer a response from the latest global row.

- [ ] **Step 4: Mount a separate diagnostic runtime**

Mount the route before the legacy AI admin handler in `auto-listing-web-runtime.mjs`. Keep its repository/service lifecycle separate from gateway profile and strategy administration. Add index wiring tests proving the route is reachable only through authenticated web runtime composition.

- [ ] **Step 5: Write frontend projector RED tests**

Cover exact accepted and rejected DTOs, 100 bounded issues, accessor/proxy/revoked/custom-prototype carriers, nested hostile response values, overlong fields and raw secret names. Assert traps/getters remain zero and invalid DTO returns null.

- [ ] **Step 6: Add the diagnostic drawer**

For an administrator viewing an item whose `failureCode` starts with `AUTO_LISTING_CONTENT_PLAN_`, render “查看规划问题”. Fetch the GET endpoint and show:

- model, template, contract and received time;
- issue code, slot, claim index, field, expected and actual safe summaries;
- a collapsed read-only structured response section;
- no retry button in this drawer.

Non-admin users keep the existing fixed safe failure copy and never receive diagnostic data.

- [ ] **Step 7: Run frontend and backend focused tests**

Run: `node --test server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs app/tests/auto-listing-plan-diagnostics.test.mjs app/tests/auto-listing-page.test.mjs`

Expected: PASS; administrator sees the exact failed slot/rule, ordinary user sees only the safe generic message.

- [ ] **Step 8: Commit Task 6**

```bash
git add server/auto-listing-plan-diagnostic-service.mjs server/auto-listing-plan-diagnostic-routes.mjs server/auto-listing-plan-diagnostic-runtime.mjs server/auto-listing-web-runtime.mjs server/index.mjs app/src/auto-listing-plan-diagnostics.js app/src/AutoListingPage.jsx server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs app/tests/auto-listing-plan-diagnostics.test.mjs app/tests/auto-listing-page.test.mjs
git commit -m "feat(auto-listing): show planning diagnostics to admins"
```

---

### Task 7: Add the idempotent text-only diagnostic replay command

**Files:**
- Create: `server/auto-listing-plan-diagnostic-context-postgres.mjs`
- Modify: `server/auto-listing-plan-diagnostic-service.mjs`
- Modify: `server/auto-listing-plan-diagnostic-routes.mjs`
- Modify: `server/auto-listing-plan-diagnostic-runtime.mjs`
- Modify: `server/auto-listing-ai-runtime-composition.mjs`
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/auto-listing-web-runtime.mjs`
- Test: `server/tests/auto-listing-plan-diagnostic-context-postgres.test.mjs`
- Modify: `server/tests/auto-listing-plan-diagnostic-service.test.mjs`
- Modify: `server/tests/auto-listing-plan-diagnostic-routes.test.mjs`

**Interfaces:**
- POST: `/admin/auto-listing/plan-diagnostics/replays`.
- Exact body: `{ jobId, itemId, sourceSnapshotId, expectedStatusVersion, costConfirmed, idempotencyKey, correlationId }`.
- Produces one `auto_listing_content_plan_diagnostic_runs` row and at most one text gateway request for an idempotency key.
- Produces `createAutoListingPlanDiagnosticProductionPorts({ env, resolvePool }) -> { pool, gateway, evidenceRepository }`, reusing the same closed AI configuration, credential resolver/cipher and gateway policy as normal PLAN_CONTENT.
- Never produces `ai_content_plans`, `ai_generation_assets`, image outbox, rich content, upload, Ozon product or stock writes.

- [ ] **Step 1: Write the command RED tests**

```js
test("text-only replay saves rejection without changing the failed task", async () => {
  const before = await snapshotTaskAndSideEffects(db, scope);
  const result = await service.replay({
    actor: adminA, ...scope, expectedStatusVersion: 9,
    costConfirmed: true, idempotencyKey: "diag-1", correlationId: "corr-1",
  });
  assert.equal(result.validation.status, "REJECTED");
  assert.deepEqual(await snapshotTaskAndSideEffects(db, scope), before);
  assert.equal(gateway.calls.length, 1);
  assert.equal(imageGateway.calls.length, 0);
});
```

Add replay with the same key returning the same diagnostic ID and gateway call count 1; different body with same key conflicts; `costConfirmed !== true`, wrong snapshot/version/account/item/profile, non-planning failure, running task, or extra body key performs zero gateway/DB writes.

- [ ] **Step 2: Run replay tests and confirm RED**

Run: `node --test server/tests/auto-listing-plan-diagnostic-context-postgres.test.mjs server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs`

Expected: FAIL because the POST command and frozen-context loader do not exist.

- [ ] **Step 3: Implement exact frozen-context loading**

Join the specified item to its job, snapshot, frozen config, strategy version/rules and exact frozen profile version. Require the item still has the submitted snapshot and status version and failed with a content-plan failure. Rebuild source/strategy/config/visual captures using the same projectors as PLAN_CONTENT. Do not use current preferences, latest profile, latest strategy, current product draft or current source record.

- [ ] **Step 4: Implement run reservation before the paid call**

In one transaction, lock the exact item, insert or load `(account_id,idempotency_key)`, verify the request hash, and commit `RUNNING` before calling the gateway. The gateway request key is:

```js
`auto-listing-plan-diagnostic-${sha256({ accountId, jobId, itemId, sourceSnapshotId, idempotencyKey })}`
```

Do not automatically re-call the gateway after an ambiguous transport failure. Persist a fixed failed result; a different idempotency key requires a new explicit `costConfirmed: true` request.

- [ ] **Step 5: Reuse response evidence and detailed validation**

Use owner `{ kind: "DIAGNOSTIC_RUN", id: run.id }`, save the response before Task 3 validation, save accepted/rejected issues, and terminalize the run. Do not call `saveContentPlan`, workflow transition, image, rich-content or upload ports.

- [ ] **Step 6: Implement the exact route**

Require `AI_CONTENT_MANAGE`, exact seven-key body and 256 KiB body limit. Return 200 for replay and 201 for the first completed run, with the same safe detail projector as Task 6.

Compose the diagnostic runtime through `createAutoListingPlanDiagnosticProductionPorts`. Do not duplicate environment parsing, secret decoding or provider construction, and never expose the resolved credential in the route, diagnostic DTO, evidence row or logs.

- [ ] **Step 7: Run replay and zero-side-effect tests**

Run: `node --test server/tests/auto-listing-plan-diagnostic-context-postgres.test.mjs server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs`

Expected: PASS; one text request, one immutable response, one validation result, exact replay, unchanged task/item/status, and zero downstream calls.

- [ ] **Step 8: Commit Task 7**

```bash
git add server/auto-listing-plan-diagnostic-context-postgres.mjs server/auto-listing-plan-diagnostic-service.mjs server/auto-listing-plan-diagnostic-routes.mjs server/auto-listing-plan-diagnostic-runtime.mjs server/auto-listing-ai-runtime-composition.mjs server/auto-listing-runtime.mjs server/auto-listing-web-runtime.mjs server/tests/auto-listing-plan-diagnostic-context-postgres.test.mjs server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
git commit -m "feat(auto-listing): replay failed planning safely"
```

---

### Task 8: Show durable stage and dynamic image-count progress

**Files:**
- Modify: `server/auto-listing-repository.mjs`
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/auto-listing-routes.mjs`
- Modify: `app/src/auto-listing-view.js`
- Modify: `app/src/AutoListingPage.jsx`
- Test: `server/tests/auto-listing-repository.test.mjs`
- Test: `server/tests/auto-listing-service.test.mjs`
- Test: `server/tests/auto-listing-routes.test.mjs`
- Modify: `server/tests/auto-listing-view.test.mjs`
- Modify: `app/tests/auto-listing-page.test.mjs`

**Interfaces:**
- Extends exact `workflowProgress` to `{ phase, state, attemptCount, updatedAt, nextRetryAt, planningStage, completedUnits, currentUnit, totalUnits }`.
- `planningStage` is one of `BUILDING_SKELETON|FILLING_COPY|VALIDATING_COPY|COMPLETED|FAILED` only for `PLAN_CONTENT`, and null for every other phase.
- Counts are null outside `GENERATE_IMAGE_SLOT`; generation values come only from active-plan slots and durable generation attempts/assets.
- Public item may expose `planningContract` as one of the two safe values; no pilot account/item identifiers are exposed.

- [ ] **Step 1: Write progress RED tests**

```js
test("fixed eight-image task reports durable current and total units", async () => {
  const job = await repository.getJob({ accountId: "account-a", jobId: "job-a" });
  assert.deepEqual(job.items[0].workflowProgress, {
    phase: "GENERATE_IMAGE_SLOT", state: "RUNNING", attemptCount: 1,
    updatedAt: "2026-08-14T01:00:00.000Z", nextRetryAt: null,
    planningStage: null,
    completedUnits: 3, currentUnit: 4, totalUnits: 8,
  });
});
```

Add 6- and 13-image cases, fixed multi-group rejection, completed/rejected slot counting, retry-wait, each durable planning stage, no active plan, malformed row, cross-account plan and stale previous-plan assets.

- [ ] **Step 2: Run progress tests and confirm RED**

Run: `node --test server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-view.test.mjs`

Expected: FAIL because workflow progress has only five fields and no dynamic total.

- [ ] **Step 3: Derive progress from durable evidence**

Extend the lateral query to bind `i.active_content_plan_id`, enumerate `plan.plan->'slots'` with ordinality, and count terminal current-plan slot outcomes. Never count rows from another account/item/plan. Derive:

```js
completedUnits = acceptedOrTerminalCurrentPlanSlots;
totalUnits = currentPlanSlotCount;
currentUnit = state === "COMPLETED" ? totalUnits : Math.min(completedUnits + 1, totalUnits);
```

For `PLAN_CONTENT`, read `planningStage` only from the exact current planning attempt bound to the account/job/item/snapshot and expose the closed enum. If phase is not image generation, all three numeric values are null. If evidence is incomplete or contradictory, omit progress rather than display guessed numbers.

- [ ] **Step 4: Close backend and frontend DTOs**

Update both service and route projectors to require all nine progress keys as enumerable own data properties. Update the frontend descriptor-safe projector with the same exact shape. Reject proxies/accessors/custom prototypes, invalid planning stages, stages outside `PLAN_CONTENT`, and inconsistent counts (`completed > total`, `current < 1`, or counts present outside image generation).

- [ ] **Step 5: Render actionable labels**

Use these labels:

- fixed `PLAN_CONTENT / BUILDING_SKELETON`: “正在建立固定图片结构”;
- fixed `PLAN_CONTENT / FILLING_COPY`: “AI 正在填写俄语内容”;
- fixed `PLAN_CONTENT / VALIDATING_COPY`: “正在检查图片文案”;
- legacy `PLAN_CONTENT`: retain “正在规划图片内容”;
- `GENERATE_IMAGE_SLOT`: `正在生成第 ${currentUnit}／${totalUnits} 张图片`;
- `GENERATE_RICH_CONTENT`: “正在生成俄语富文本”;
- terminal fixed task: “等待人工审核”.

Retain attempt and last-updated labels. Do not show a fabricated percentage.

- [ ] **Step 6: Run backend/frontend progress suites**

Run: `node --test server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-page.test.mjs`

Expected: PASS; UI shows 6/8/13 totals from persisted plans, and refresh/restart does not reset progress to a generic planning label.

- [ ] **Step 7: Commit Task 8**

```bash
git add server/auto-listing-repository.mjs server/auto-listing-service.mjs server/auto-listing-routes.mjs app/src/auto-listing-view.js app/src/AutoListingPage.jsx server/tests/auto-listing-repository.test.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-routes.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-page.test.mjs
git commit -m "feat(auto-listing): show durable image progress"
```

---

### Task 9: Prove the complete path on fresh PostgreSQL and prepare controlled execution

**Files:**
- Create: `server/tests/auto-listing-configurable-skeleton-e2e.test.mjs`
- Modify: `package.json`
- Create: `docs/superpowers/verification/2026-08-14-auto-listing-configurable-fixed-skeleton.md`

**Interfaces:**
- Adds script: `test:auto-listing-configurable-skeleton-e2e`.
- Produces a verification record with tested SHA, exact migration range 001–074, counts, skipped/blocked tests, no-real-call statement and rollback commands.

- [ ] **Step 1: Write the fresh-PostgreSQL E2E RED test**

The test must apply 001–074 and exercise real production composition with fake bounded external ports:

```js
test("legacy failure diagnostics and configurable fixed skeleton remain isolated", async () => {
  const legacy = await createLegacyJobAndReturnBusinessInvalidPlan();
  assert.equal(await count("auto_listing_content_plan_responses", legacy.scope), 1);
  assert.equal(await count("auto_listing_content_plan_validation_results", legacy.scope), 1);
  assert.equal(await count("ai_generation_assets", legacy.scope), 0);

  const fixed = await createPilotJob({ roles: THIRTEEN_IMAGE_CONFIG });
  await drainAiOutboxAcrossWorkerRestart();
  assert.equal(fixed.item.planningContract, "FIXED_SKELETON_V1");
  assert.equal(fixed.visualGroupCount, 1);
  assert.equal(await acceptedAssetCount(fixed.scope), 13);
  assert.equal(await ozonWriteCount(), 0);
  assert.equal((await reloadItem(fixed.scope)).status, "READY_FOR_REVIEW");
});
```

Include 6, current 8 and 13 counts; invalid counts; fixed multi-group rejection before AI; missing required dimensions; one invalid fill with zero images; exact message replay; old failed task unchanged; other account/item legacy; direct account policy overridden to review only for fixed; admin/ordinary-user diagnostic boundaries; worker restart; duplicate outbox; response loss; and zero Ozon writes.

- [ ] **Step 2: Run the E2E and confirm RED before final wiring**

Run: `AUTO_LISTING_CONFIGURABLE_SKELETON_PG_TESTS=1 node --test --test-concurrency=1 server/tests/auto-listing-configurable-skeleton-e2e.test.mjs`

Expected: FAIL at the first not-yet-wired contract or evidence assertion; do not weaken the assertion to make it green.

- [ ] **Step 3: Add the package command and finish only wiring defects**

```json
"test:auto-listing-configurable-skeleton-e2e": "node --test --test-concurrency=1 server/tests/auto-listing-configurable-skeleton-e2e.test.mjs"
```

Only fix composition/wiring defects exposed by this E2E. If a new business rule is required, stop and update the approved design before implementation.

- [ ] **Step 4: Run focused and adjacent regression gates**

Run:

```bash
node --test server/tests/auto-listing-planning-contract.test.mjs server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-configurable-skeleton-migration.test.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-content-plan-evidence-postgres.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-plan-diagnostic-context-postgres.test.mjs server/tests/auto-listing-plan-diagnostic-service.test.mjs server/tests/auto-listing-plan-diagnostic-routes.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-content-plan-repository.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs server/tests/auto-listing-ai-orchestrator.test.mjs server/tests/auto-listing-ai-workflow-postgres.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-plan-diagnostics.test.mjs app/tests/auto-listing-page.test.mjs
```

Then run the E2E on a disposable PostgreSQL 16 instance and run `pnpm --dir app build`. Record any environment-blocked suite as not verified; do not count a skip as a pass.

- [ ] **Step 5: Verify scope, syntax and secrets**

Run:

```bash
git diff --check
node --check server/auto-listing-planning-contract.mjs
node --check server/auto-listing-content-plan-validator.mjs
node --check server/auto-listing-fixed-skeleton.mjs
node --check server/auto-listing-content-plan-evidence-postgres.mjs
node --check server/auto-listing-plan-diagnostic-service.mjs
node --check server/auto-listing-plan-diagnostic-routes.mjs
rg -n "api[_-]?key|authorization|bearer|secret" server/auto-listing-content-plan-* server/auto-listing-plan-diagnostic-* docs/superpowers/verification/2026-08-14-auto-listing-configurable-fixed-skeleton.md
```

Inspect every match and confirm no real secret, raw credential or full prompt was added.

- [ ] **Step 6: Write the verification record**

Document:

- implementation SHA and exact files/contracts changed;
- fresh PostgreSQL migration range and test counts with zero-skip evidence;
- frontend build result;
- real AI/Ozon/object-storage calls not performed during automation;
- remaining fee-gated actions;
- rollback: disable the pilot env gate first, revert application commits, retain migration 074 and immutable evidence;
- recovery: old tasks remain legacy; existing fixed tasks continue from their frozen contract or can be cancelled before review.

- [ ] **Step 7: Commit automated verification**

```bash
git add server/tests/auto-listing-configurable-skeleton-e2e.test.mjs package.json docs/superpowers/verification/2026-08-14-auto-listing-configurable-fixed-skeleton.md
git commit -m "test(auto-listing): verify configurable skeleton diagnostics"
```

- [ ] **Step 8: Pause for the first fee confirmation**

Show the user the tested SHA and automated results. Request confirmation for exactly one text-only diagnostic replay of the old failed task. After confirmation, call the POST command once, verify one response/one validation/zero plans/zero assets/unchanged task, and append the exact safe issue report to the verification document.

- [ ] **Step 9: Pause for the second fee confirmation**

Request confirmation for one new current-product fixed-skeleton trial using the image counts submitted by the user at creation time. After confirmation, verify the frozen contract and role counts before any image call, let the task generate the configured total, and stop at `READY_FOR_REVIEW`. Record text/image call counts, generated slot identities, zero Ozon writes and manual-review state. Do not auto-approve or upload.

- [ ] **Step 10: Commit real controlled evidence separately**

```bash
git add docs/superpowers/verification/2026-08-14-auto-listing-configurable-fixed-skeleton.md
git commit -m "docs(auto-listing): record controlled skeleton trial"
```

---

## Final Acceptance Checklist

- [ ] Old failed task remains unchanged and gains an immutable, administrator-readable response plus exact rule locations.
- [ ] Text-only replay is one-call, fee-confirmed, idempotent and produces zero active plans, images, rich content and Ozon writes.
- [ ] New pilot task freezes the submitted 6～13 role counts and `FIXED_SKELETON_V1`; other tasks freeze legacy.
- [ ] AI cannot add/remove/reorder slots or alter roles, references, preserve fields or prohibited claims.
- [ ] Missing trusted dimensions with requested specification fails before AI; no silent reallocation remains.
- [ ] Invalid fills save diagnostic evidence and make zero image calls.
- [ ] Valid fills generate exactly the frozen configured total for the one supported visual group, never multiply that total, survive restart/replay and end at `READY_FOR_REVIEW`.
- [ ] Fixed tasks never create upload/Ozon product/stock writes before human approval, even under a direct account policy.
- [ ] UI displays meaningful durable stages and dynamic `N／总数`, not hard-coded `N／8`.
- [ ] Administrator sees closed diagnostic detail; ordinary users see only fixed safe copy.
- [ ] Fresh PostgreSQL 16, focused tests, adjacent regressions, syntax, diff, build, secret scan, rollback and unverified scope are recorded.
