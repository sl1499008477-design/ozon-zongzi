# Account-Level Ozon Category Auto-Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 商品进入账号级采集箱并完成 Seller 资料补全后，由 Web 后端自动把来源 `type_id` 匹配为 Ozon 当前有效的 `description_category_id + type_id`；同一账号和类目体系内切换店铺时复用已核验结果，不再依赖用户打开编辑页触发匹配。

**Architecture:** 新增独立的“采集商品类目解析”Policy、Repository、Service 和 Runtime。采集入口只冻结查询所用经营店铺并创建幂等任务，Seller 补全完成事件只唤醒任务；Service 通过 Ozon 类目 Service Port 读取树、计算语言无关指纹、按 `type_id` 唯一匹配，并把稳定摘要投影给采集箱。现有来源类目证据、手动类目和上架预检合同保持独立；插件合同不变。

**Tech Stack:** Node.js ESM、React、PostgreSQL/JSON 双持久化、`node:test`、现有 Ozon Seller API 类目服务。

## Global Constraints

- 仅修改 Web 前后端和数据库迁移；`extension/` 不改，插件不负责类目匹配，也不发送店铺 ID 或类目匹配指令。
- 每次读取、写入、认领任务必须显式带 `accountId`；`credentialStoreId` 必须由后端从当前账号的有效经营店铺中取得，不能信任客户端字段。
- 采集成功与类目匹配成功是两个独立状态；类目失败不得把已采集商品改成采集失败。
- 来源 `sourceCategory` 只增补证据，不能被目标类目覆盖。
- 自动结果不得覆盖仍有效的 `MANUAL` 结果；只有用户清除或验证为失效后才能重新匹配。
- 外部调用和状态写入必须幂等；任务主键以 `accountId + collectItemId + taxonomyScope` 唯一，执行键再包含 `sourceTypeId + taxonomyFingerprint`。
- 不保存 Cookie、Token、Client Secret 或完整上游敏感响应；失败详情必须是脱敏后的稳定错误码和安全说明。
- 数据库迁移只新增表、索引和外键，不删除或覆盖旧数据。
- 不用中文或俄文名称判断类目是否相同；名称只作为展示路径。
- 所有任务先写失败测试，再做最小实现，单项测试通过后再提交该任务涉及的文件。

---

### Task 1: 建立语言无关的类目解析领域规则

**Files:**

- Create: `server/collect-category-resolution-policy.mjs`
- Create: `server/tests/collect-category-resolution-policy.test.mjs`
- Reference: `app/src/category-readiness.js`
- Reference: `server/collect-enrichment-policy.mjs`

- [ ] **Step 1: 写出失败测试，固定状态机、树指纹和唯一匹配规则**

测试至少覆盖：

```js
test("fingerprint ignores translated labels but detects structural changes", () => {
  assert.equal(taxonomyFingerprint(zhTree), taxonomyFingerprint(ruTree));
  assert.notEqual(taxonomyFingerprint(zhTree), taxonomyFingerprint(treeWithMovedType));
});

test("exact type id returns the only enabled leaf", () => {
  assert.deepEqual(resolveExactType({ tree, sourceTypeId: 94405 }), {
    kind: "MATCHED",
    descriptionCategoryId: 17028702,
    typeId: 94405,
  });
});

test("missing or ambiguous type id needs review instead of guessing", () => {
  assert.equal(resolveExactType({ tree, sourceTypeId: 0 }).kind, "NEEDS_REVIEW");
  assert.equal(resolveExactType({ tree: ambiguousTree, sourceTypeId: 94405 }).kind, "NEEDS_REVIEW");
});

test("manual match cannot be overwritten by an automatic match", () => {
  assert.equal(nextResolution(manualMatched, { type: "AUTO_MATCHED" }).method, "MANUAL");
});
```

- [ ] **Step 2: 运行测试并确认因模块或导出不存在而失败**

Run: `node --test server/tests/collect-category-resolution-policy.test.mjs`

Expected: FAIL，错误指向 `collect-category-resolution-policy.mjs` 缺失或相应导出不存在。

- [ ] **Step 3: 实现最小 Policy contract**

导出明确的纯函数，禁止在 Policy 内访问数据库、网络或当前店铺：

```js
export const TAXONOMY_SCOPE_OZON_DEFAULT = "OZON:DEFAULT";

export const CATEGORY_RESOLUTION_STATUS = Object.freeze({
  WAITING_ENRICHMENT: "WAITING_ENRICHMENT",
  WAITING_STORE: "WAITING_STORE",
  QUEUED: "QUEUED",
  MATCHING: "MATCHING",
  MATCHED: "MATCHED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  RETRYABLE_ERROR: "RETRYABLE_ERROR",
  INVALIDATED: "INVALIDATED",
});

export function taxonomyFingerprint(tree) {
  return createHash("sha256").update(JSON.stringify(normalizeTaxonomy(tree))).digest("hex");
}

export function resolveExactType({ tree, sourceTypeId }) {
  const candidates = enabledLeafCandidates(tree, Number(sourceTypeId));
  if (!Number(sourceTypeId)) return { kind: "NEEDS_REVIEW", reasonCode: "TYPE_MISSING" };
  if (candidates.length !== 1) {
    return {
      kind: "NEEDS_REVIEW",
      reasonCode: candidates.length ? "TYPE_AMBIGUOUS" : "TYPE_NOT_FOUND",
      candidates,
    };
  }
  return { kind: "MATCHED", ...candidates[0] };
}
```

指纹输入只允许包含排序后的 `description_category_id`、`type_id`、父子关系和启用状态。`resolveExactType` 返回稳定的 `MATCHED`、`TYPE_MISSING`、`TYPE_NOT_FOUND` 或 `TYPE_AMBIGUOUS` 结果，不返回“第一个看起来像”的节点。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/tests/collect-category-resolution-policy.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交本任务**

```bash
git add server/collect-category-resolution-policy.mjs server/tests/collect-category-resolution-policy.test.mjs
git commit -m "feat: define Ozon category resolution policy"
```

---

### Task 2: 新增可恢复、账号隔离的双持久化 Repository

**Files:**

- Create: `server/db/migrations/024_collect_category_resolution.sql`
- Create: `server/collect-category-resolution-repository.mjs`
- Create: `server/tests/collect-category-resolution-migration.test.mjs`
- Create: `server/tests/collect-category-resolution-repository.test.mjs`
- Modify: `server/formal-persistence.mjs`
- Modify: `server/tests/account-deletion-relational.test.mjs`
- Modify: `scripts/test-manifest.mjs`

- [ ] **Step 1: 写迁移与 Repository 的失败测试**

迁移测试必须断言：

```js
assert.match(sql, /CREATE TABLE collect_category_resolutions/);
assert.match(sql, /UNIQUE \(account_id, collect_item_id, taxonomy_scope\)/);
assert.match(sql, /REFERENCES accounts\(id\) ON DELETE CASCADE/);
assert.match(sql, /REFERENCES collect_items\(id\) ON DELETE CASCADE/);
assert.match(sql, /REFERENCES stores\(id\) ON DELETE SET NULL/);
assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE TABLE|DROP TABLE/);
```

JSON 与 PostgreSQL Repository 必须共享以下行为测试：同账号同商品重复 `enqueue` 只得到一条记录；不同账号不能读取、认领或更新彼此记录；过期 lease 可恢复；陈旧 lease token 不能完成任务；`MANUAL` 不被自动完成覆盖；删除账号时记录级联清理。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test server/tests/collect-category-resolution-migration.test.mjs
node --test server/tests/collect-category-resolution-repository.test.mjs
node --test server/tests/account-deletion-relational.test.mjs
```

Expected: FAIL，因为迁移、Repository 和账号删除清理尚不存在。

- [ ] **Step 3: 新增兼容迁移**

`collect_category_resolutions` 同时承担任务和当前结果，避免再造一张队列表：

```sql
CREATE TABLE collect_category_resolutions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  collect_item_id TEXT NOT NULL REFERENCES collect_items(id) ON DELETE CASCADE,
  taxonomy_scope TEXT NOT NULL,
  source_type_id BIGINT,
  target_description_category_id BIGINT,
  target_type_id BIGINT,
  method TEXT,
  status TEXT NOT NULL,
  taxonomy_fingerprint TEXT,
  credential_store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  display_path_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  failure_detail_safe TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  matched_at TIMESTAMPTZ,
  validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, collect_item_id, taxonomy_scope)
);
```

补充状态 CHECK、匹配字段一致性 CHECK，以及 `(status, next_attempt_at)` 和 `(account_id, collect_item_id)` 索引。不要迁移或删除旧 `product_drafts.data.categoryResolution`；旧记录的兼容读取在 Task 6 做。

- [ ] **Step 4: 实现 JSON/PostgreSQL 一致的 Repository Port**

```js
export function createJsonCollectCategoryResolutionRepository({ state, persist }) {}
export function createPostgresCollectCategoryResolutionRepository({ pool }) {}

// 两种实现均提供：
// enqueue, readForItem, claimNext, completeMatched,
// completeNeedsReview, deferRetry, invalidate, saveManual, releaseLease
```

JSON 数据放在 `state.collectCategoryResolutions`，不写入 `caches.collectBox` 作为任务真相源。PostgreSQL `claimNext` 使用事务和 `FOR UPDATE SKIP LOCKED`；所有更新同时校验 `account_id + id + lease_token`。

- [ ] **Step 5: 把新关系表加入账号删除闭环和测试清单**

在 `formal-persistence.mjs` 的账号删除事务中按 `account_id` 删除该表记录，并在关系删除测试中确认它在账号删除后为空。把新的 PostgreSQL 专项集成测试（若新增）按现有规则加入 `historicalTestExclusions`，说明只有显式配置专用测试库时运行；普通单元测试保持默认启用。

- [ ] **Step 6: 运行测试确认通过**

Run:

```bash
node --test server/tests/collect-category-resolution-migration.test.mjs
node --test server/tests/collect-category-resolution-repository.test.mjs
node --test server/tests/account-deletion-relational.test.mjs
```

Expected: PASS；PostgreSQL 专项在未配置时明确报告 SKIP，而不是静默成功。

- [ ] **Step 7: 提交本任务**

```bash
git add server/db/migrations/024_collect_category_resolution.sql server/collect-category-resolution-repository.mjs server/tests/collect-category-resolution-migration.test.mjs server/tests/collect-category-resolution-repository.test.mjs server/formal-persistence.mjs server/tests/account-deletion-relational.test.mjs scripts/test-manifest.mjs
git commit -m "feat: persist category resolution jobs"
```

---

### Task 3: 让 Ozon 类目服务返回可核验的类目快照

**Files:**

- Modify: `server/ozon-category-service.mjs`
- Modify: `server/tests/ozon-category-service.test.mjs`
- Reference: `server/ozon-category-routes.mjs`

- [ ] **Step 1: 写失败测试固定类目快照 contract**

覆盖以下行为：

```js
test("category snapshot exposes a language-independent fingerprint", async () => {
  const zh = await service.getCategorySnapshot(store, "ZH_HANS");
  const ru = await service.getCategorySnapshot(store, "RU");
  assert.equal(zh.taxonomyFingerprint, ru.taxonomyFingerprint);
});

test("empty refresh never replaces the last non-empty snapshot", async () => {
  await service.getCategorySnapshot(store, "ZH_HANS");
  upstream.replyWithEmptyTree();
  const snapshot = await service.getCategorySnapshot(store, "ZH_HANS");
  assert.equal(snapshot.stale, true);
  assert.ok(snapshot.items.length > 0);
});
```

再测试 `validateTarget({ descriptionCategoryId, typeId })` 只在目标节点启用、类型仍归属该节点且属性接口可读时返回有效。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/tests/ozon-category-service.test.mjs`

Expected: FAIL，因为快照指纹、陈旧保护或轻量验证 contract 尚不存在。

- [ ] **Step 3: 扩展 Service，而不改变现有路由响应**

保留 `getCategoryTree`、属性和字典接口，新增后端内部 Port：

```js
async function getCategorySnapshot(store, language = "ZH_HANS") {
  return {
    items,
    taxonomyScope: "OZON:DEFAULT",
    taxonomyFingerprint: taxonomyFingerprint(items),
    fetchedAt,
    stale,
  };
}

async function validateTarget(store, { descriptionCategoryId, typeId }) {
  return { valid, reasonCode, taxonomyFingerprint, validatedAt };
}
```

缓存仍可按店铺凭据隔离，但只有实际指纹相同才允许解析层共享结果。上游返回空树或临时失败时保留最近一次非空快照并标记 `stale`，不能用空数据覆盖有效缓存。

- [ ] **Step 4: 运行测试确认通过并回归现有类目路由**

Run:

```bash
node --test server/tests/ozon-category-service.test.mjs
node --test server/tests/ozon-category-routes.test.mjs
```

Expected: PASS，现有 `/ozon/categories/*` contract 不变。

- [ ] **Step 5: 提交本任务**

```bash
git add server/ozon-category-service.mjs server/tests/ozon-category-service.test.mjs
git commit -m "feat: expose verifiable Ozon taxonomy snapshots"
```

---

### Task 4: 实现自动匹配 Service 的状态闭环、重试和复用

**Files:**

- Create: `server/collect-category-resolution-service.mjs`
- Create: `server/tests/collect-category-resolution-service.test.mjs`
- Reference: `server/ozon-import-normalizer.mjs`

- [ ] **Step 1: 写失败测试覆盖完整业务流程**

使用内存 Repository 和伪造 Port，至少覆盖：

- 资料未完成进入 `WAITING_ENRICHMENT`，没有 Ozon 调用。
- 资料完成但没有有效店铺进入 `WAITING_STORE`，采集商品仍为成功。
- 来源 `17033604 / 94405` 唯一解析为目标 `17028702 / 94405`。
- 中文和俄文名称不同但结构 ID 相同，结果共享。
- 店铺 A 匹配后切换同 `taxonomyScope + fingerprint` 的店铺 B，只调用 `validateTarget`，不重新遍历匹配。
- 指纹变化或验证失败后先 `INVALIDATED` 再重新排队。
- 网络、429、5xx 进入带指数退避的 `RETRYABLE_ERROR`；类型缺失、不存在和多候选进入 `NEEDS_REVIEW`。
- 重复补全通知、重复执行和服务重启不产生第二条任务。
- 后台自动结果不覆盖 `MANUAL`。
- 凭据店铺不属于同账号或已停用时拒绝使用并进入 `WAITING_STORE`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/tests/collect-category-resolution-service.test.mjs`

Expected: FAIL，因为 Service 尚不存在。

- [ ] **Step 3: 实现依赖 Port 的单一用例 Service**

```js
export function createCollectCategoryResolutionService({
  repository,
  categoryPort,
  collectItemPort,
  storePort,
  auditPort,
  now,
  randomUUID,
} = {}) {
  return Object.freeze({
    scheduleForCollect,
    onEnrichmentComplete,
    onOperatingStoreAvailable,
    resolveNext,
    validateForStore,
    saveManual,
  });
}
```

`resolveNext` 的最小顺序固定为：按账号认领 → 读最新商品来源证据 → 校验资料状态 → 校验凭据店铺归属和可用性 → 获取非空类目快照 → 按 `type_id` 唯一匹配 → 原子保存结果和审计。错误分类只接受明确错误码，重试时间上限和 attempt 计数写入记录。

- [ ] **Step 4: 为审计和可观测性固定稳定事件**

至少写入：

```text
COLLECT_CATEGORY_RESOLUTION_QUEUED
COLLECT_CATEGORY_RESOLUTION_MATCHED
COLLECT_CATEGORY_RESOLUTION_NEEDS_REVIEW
COLLECT_CATEGORY_RESOLUTION_RETRY_DEFERRED
COLLECT_CATEGORY_RESOLUTION_INVALIDATED
COLLECT_CATEGORY_RESOLUTION_VALIDATED
```

事件只包含 `accountId`、`collectItemId`、`taxonomyScope`、`sourceTypeId`、目标 ID、`credentialStoreId`、指纹、attempt 和错误码；不得记录店铺密钥或完整 Ozon 响应。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/tests/collect-category-resolution-service.test.mjs`

Expected: PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add server/collect-category-resolution-service.mjs server/tests/collect-category-resolution-service.test.mjs
git commit -m "feat: resolve collected item categories asynchronously"
```

---

### Task 5: 接入 JSON/PostgreSQL Runtime、采集入口和 Seller 补全完成事件

**Files:**

- Create: `server/collect-category-resolution-runtime.mjs`
- Create: `server/tests/collect-category-resolution-runtime.test.mjs`
- Modify: `server/account-scoped-collection-routes.mjs`
- Modify: `server/collection-pipeline.mjs`
- Modify: `server/collector-ozon-enrichment-service.mjs`
- Modify: `server/collector-ozon-enrichment-runtime.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/collector-scope-ingress.test.mjs`
- Modify: `server/tests/ozon-collection-completeness-gate.test.mjs`
- Modify: `server/tests/collector-ozon-enrichment-service.test.mjs`
- Modify: `server/tests/module-boundaries.test.mjs`

- [ ] **Step 1: 写失败测试，先固定入口边界**

测试必须证明：

1. 插件上传体仍禁止 `storeId`、`operatingStoreId`、`dataCollectionStoreId` 等范围字段。
2. JSON 与 PostgreSQL 两条采集入口都从服务端当前账号上下文取得 `credentialStoreId`，并调用同一个 `scheduleForCollect` Port。
3. 第一次资料不完整时只创建 `WAITING_ENRICHMENT`；`mergeLinkedCollectItem` 成功提交完整草稿后调用 `onEnrichmentComplete`。
4. 重复采集与重复完成通知仍只有一条解析记录。
5. 类目任务创建或执行失败不会回滚已成功的采集或 Seller 补全事务；失败转为可恢复状态并记录日志。
6. 模块边界测试禁止采集路由直接 import 类目 Repository，也禁止补全 Service 直接访问数据库。

- [ ] **Step 2: 运行针对性测试确认失败**

Run:

```bash
node --test server/tests/collect-category-resolution-runtime.test.mjs
node --test server/tests/collector-scope-ingress.test.mjs
node --test server/tests/ozon-collection-completeness-gate.test.mjs
node --test server/tests/collector-ozon-enrichment-service.test.mjs
node --test server/tests/module-boundaries.test.mjs
```

Expected: FAIL，指出 Runtime hook 或新 Port 缺失。

- [ ] **Step 3: 实现 Runtime 组合层**

Runtime 负责根据 `persistenceMode()` 选择 Repository，并向 Service 提供 Port：

```js
export function createCollectCategoryResolutionRuntime({
  loadState,
  saveState,
  stateTransaction,
  persistenceMode,
  categoryService,
  currentCredentialStoreForAccount,
  readCollectItem,
  appendAudit,
  logger,
} = {}) {
  return {
    scheduleForCollect,
    onEnrichmentComplete,
    onOperatingStoreAvailable,
    resolveDue,
    readForItem,
  };
}
```

JSON 路径所有读写置于现有 `stateTransaction`；PostgreSQL 路径使用迁移表和事务。后台执行采用短间隔、有上限的 `resolveDue()` drain；关闭服务器时停止计时器，单次最多处理固定数量，防止阻塞请求。

- [ ] **Step 4: 在两条采集入口冻结凭据店铺并排队**

`credentialStoreId` 由 `server/index.mjs` 注入的 `currentCredentialStoreForAccount(accountId)` 取得，并由 Runtime 再验证账号归属、启用状态和凭据可用性。不要把它写到采集商品、插件响应或 `collect_requests.store_id`。

资料已经完整时创建 `QUEUED`；不完整时创建 `WAITING_ENRICHMENT`；没有店铺时创建 `WAITING_STORE`。调度失败记录安全错误，但采集响应仍返回原成功结果。

- [ ] **Step 5: 在 Seller 补全成功提交后唤醒解析任务**

给 `createCollectorOzonEnrichmentService` 增加窄 Port：

```js
categoryResolutionPort: {
  onEnrichmentComplete({ accountId, collectItemId, completedAt })
}
```

调用点必须在 `collectItemPort.complete` 已成功返回之后。Port 失败不能撤销已保存的重量、尺寸、来源类目；Runtime 将其记录为待恢复任务。

- [ ] **Step 6: 店铺新增、切换或凭据恢复时唤醒等待任务**

在现有经营店铺成功保存/启用的后端路径调用 `onOperatingStoreAvailable({ accountId, storeId })`。该方法只唤醒同账号 `WAITING_STORE` 或需要验证的记录，不修改采集商品归属。

- [ ] **Step 7: 运行测试确认通过**

Run:

```bash
node --test server/tests/collect-category-resolution-runtime.test.mjs
node --test server/tests/collector-scope-ingress.test.mjs
node --test server/tests/ozon-collection-completeness-gate.test.mjs
node --test server/tests/collector-ozon-enrichment-service.test.mjs
node --test server/tests/module-boundaries.test.mjs
```

Expected: PASS。

- [ ] **Step 8: 提交本任务**

```bash
git add server/collect-category-resolution-runtime.mjs server/tests/collect-category-resolution-runtime.test.mjs server/account-scoped-collection-routes.mjs server/collection-pipeline.mjs server/collector-ozon-enrichment-service.mjs server/collector-ozon-enrichment-runtime.mjs server/index.mjs server/tests/collector-scope-ingress.test.mjs server/tests/ozon-collection-completeness-gate.test.mjs server/tests/collector-ozon-enrichment-service.test.mjs server/tests/module-boundaries.test.mjs
git commit -m "feat: schedule category matching after collection"
```

---

### Task 6: 提供稳定的采集箱类目摘要并兼容旧草稿

**Files:**

- Modify: `server/collection-public-shape.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/collection-public-shape.test.mjs`
- Create: `server/tests/collect-category-resolution-contract.test.mjs`
- Modify: `app/src/category-readiness.js`
- Modify: `app/tests/category-readiness.test.mjs`

- [ ] **Step 1: 写失败测试固定服务端和前端读取 contract**

采集箱每条商品新增的是稳定摘要，不是数据库行：

```js
{
  categoryResolution: {
    status: "MATCHED",
    taxonomyScope: "OZON:DEFAULT",
    targetDescriptionCategoryId: 17028702,
    targetTypeId: 94405,
    displayPath: { zh: ["运动与休闲", "捞鱼网"], ru: ["Спорт и отдых", "Подсачек"] },
    method: "TYPE_ID_EXACT",
    matchedAt: "2026-08-03T10:00:00.000Z",
    validatedAt: "2026-08-03T10:00:00.000Z",
    action: "NONE",
    message: "类目已匹配",
  },
}
```

测试还必须覆盖：不暴露 `credentialStoreId`、lease、attempt、失败原始详情或数据库列名；账号 A 看不到账号 B 结果；`sourceCategory` 原样保留；旧 `listingDraft.categoryResolution.target.storeId` 仍可读；新共享结果在同 taxonomy 的店铺 B 下有效。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test server/tests/collection-public-shape.test.mjs
node --test server/tests/collect-category-resolution-contract.test.mjs
node --test app/tests/category-readiness.test.mjs
```

Expected: FAIL，因为新摘要和共享读取规则尚不存在。

- [ ] **Step 3: 在服务端合并独立结果并投影公开摘要**

采集箱读取路径由 Runtime 按 `accountId + collectItemId` 批量读取解析记录，再调用 `publicCategoryResolutionSummary` 合并。禁止逐行 N+1 查询。`publicCollectionItem` 继续清理采集范围字段，并显式白名单化类目摘要。

- [ ] **Step 4: 更新前端兼容读取函数**

保留旧函数名称供现有调用点过渡，但新判定优先使用 taxonomy：

```js
export function categoryResolutionForTarget(
  resolution,
  { targetStoreId, taxonomyScope = "OZON:DEFAULT" } = {},
) {
  if (resolution?.taxonomyScope) {
    return resolution.taxonomyScope === taxonomyScope ? structuredClone(resolution) : null;
  }
  return categoryResolutionForStore(resolution, targetStoreId); // legacy only
}
```

上架字段只从 `MATCHED` 且目标 ID 均为正数的结果取得。`WAITING_*`、`RETRYABLE_ERROR`、`NEEDS_REVIEW`、`INVALIDATED` 不得被误判成已就绪。

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
node --test server/tests/collection-public-shape.test.mjs
node --test server/tests/collect-category-resolution-contract.test.mjs
node --test app/tests/category-readiness.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交本任务**

```bash
git add server/collection-public-shape.mjs server/index.mjs server/tests/collection-public-shape.test.mjs server/tests/collect-category-resolution-contract.test.mjs app/src/category-readiness.js app/tests/category-readiness.test.mjs
git commit -m "feat: expose shared category resolution status"
```

---

### Task 7: 更新采集箱与编辑页，移除“打开页面才自动匹配”

**Files:**

- Create: `app/src/collect-category-resolution-view.js`
- Create: `app/tests/collect-category-resolution-view.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `app/tests/collect-edit-layout.test.mjs`
- Modify: `scripts/check-collect-edit-listing-contract.mjs`

- [ ] **Step 1: 写失败测试固定页面表现和禁止重复调用**

状态文案映射：

```js
assert.deepEqual(categoryResolutionView({ status: "MATCHING" }), {
  tone: "processing",
  label: "类目匹配中",
  action: "NONE",
});
assert.equal(categoryResolutionView({ status: "WAITING_STORE" }).label, "等待选择经营店铺");
assert.equal(categoryResolutionView({ status: "NEEDS_REVIEW" }).action, "SELECT_MANUALLY");
```

布局/合同测试必须断言：

- 采集箱列表显示六种业务状态。
- 已匹配商品直接把目标 ID 带入编辑和上架预检。
- 编辑页不再在 `useEffect` 中静默执行 `runCollectPreview({ silent: true })`。
- “查看”只导航，不再承担匹配触发职责。
- `NEEDS_REVIEW` 和 `INVALIDATED` 保留手动类目选择；保存后方法为 `MANUAL`。
- 类目仍在处理中时不显示“采集失败”，也不阻止查看已采集的其他资料。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
node --test app/tests/collect-category-resolution-view.test.mjs
node --test app/tests/collect-edit-layout.test.mjs
node scripts/check-collect-edit-listing-contract.mjs
```

Expected: FAIL，指出状态适配器缺失或编辑页仍存在静默自动预览。

- [ ] **Step 3: 实现纯 UI 适配器和列表状态**

`collect-category-resolution-view.js` 只负责把稳定服务端状态转换为标签、颜色、提示和操作，不发请求。`App.jsx` 的采集箱行读取该适配器；轮询沿用现有账号数据刷新机制，不新增插件轮询。

- [ ] **Step 4: 编辑页读取已保存结果并保留人工兜底**

把现有 `categoryResolutionForStore` 调用逐步替换为 `categoryResolutionForTarget`。删除约 `App.jsx:6033-6046` 的自动 `runCollectPreview({ silent: true })` effect；用户主动点击内容体检/手动匹配时仍可调用现有预览接口，但它不再是自动匹配的唯一入口。

- [ ] **Step 5: 运行 UI 和构建验证**

Run:

```bash
node --test app/tests/collect-category-resolution-view.test.mjs
node --test app/tests/category-readiness.test.mjs
node --test app/tests/collect-edit-layout.test.mjs
node scripts/check-collect-edit-listing-contract.mjs
pnpm --dir app build
```

Expected: PASS，构建无错误。

- [ ] **Step 6: 提交本任务**

```bash
git add app/src/collect-category-resolution-view.js app/tests/collect-category-resolution-view.test.mjs app/src/App.jsx app/tests/collect-edit-layout.test.mjs scripts/check-collect-edit-listing-contract.mjs
git commit -m "feat: show automatic category matching status"
```

---

### Task 8: 端到端验收、回归和可回滚交付

**Files:**

- Create: `server/tests/collect-category-auto-resolution.integration.mjs`
- Modify: `scripts/test-manifest.mjs`
- Modify: `docs/superpowers/specs/2026-08-03-account-level-ozon-category-auto-resolution-design.md` only if implementation reveals a confirmed contract correction

- [ ] **Step 1: 写端到端失败测试覆盖真实业务样例**

使用受控 Ozon 类目 Port，不调用真实平台写接口：

1. 账号选择店铺 A 后上传来源 `17033604 / 94405` 商品。
2. 商品先进入采集箱；Seller 补全完成事件携带重量、尺寸和来源类目证据。
3. 后台任务自动得到 `17028702 / 94405`，全程不打开编辑页。
4. 列表和编辑读取相同的已保存结果，来源 `17033604 / 94405` 仍在。
5. 切换同指纹店铺 B，只验证并复用。
6. 改变树结构指纹后旧结果失效并重新匹配。
7. Ozon 429 后采集仍成功，任务按计划重试。
8. 同时重复上传和重复补全不会生成重复记录。

- [ ] **Step 2: 运行端到端测试并完成最小修正**

Run: `node --test server/tests/collect-category-auto-resolution.integration.mjs`

Expected: 首次 FAIL；只修复被该测试证明的跨模块接线问题，随后 PASS。

- [ ] **Step 3: 运行完整自动验证**

Run:

```bash
pnpm verify
pnpm --dir app build
node scripts/check-collect-edit-listing-contract.mjs
```

Expected: 全部 PASS；只有清单中明确依赖专用 PostgreSQL/浏览器环境的测试显示配置化 SKIP。

- [ ] **Step 4: 在专用 PostgreSQL 测试库执行迁移专项验证**

仅在明确的测试数据库配置存在时运行：

```bash
node --test server/tests/collect-category-resolution-postgres.integration.mjs
```

Expected: PASS；验证迁移、账号隔离、lease 恢复、唯一键和账号删除级联。若本地没有专用数据库，交付说明中明确列为“未验证范围”，不能声称已通过。

- [ ] **Step 5: 做人工只读验收，不触发真实上架**

- 重新采集一个有 `type_id` 的 Ozon 商品。
- 不点击“查看”，等待采集箱显示“类目已匹配”。
- 打开后确认目标为当前类目，来源类目证据仍可追溯。
- 切换同一 Ozon 类目体系店铺，确认结果复用且页面不再次执行完整匹配。
- 模拟无店铺、凭据失效和暂时网络失败，确认采集不变成失败。
- 不点击“上架到 Ozon”，避免真实平台副作用。

- [ ] **Step 6: 记录回滚方法并提交验收测试**

回滚顺序：停止类目 Runtime 定时 drain → 关闭自动调度 hook → 恢复编辑页按需预览。保留迁移表和已保存结果，不删除来源证据或历史审计；数据库新增表可暂时闲置。然后提交：

```bash
git add server/tests/collect-category-auto-resolution.integration.mjs scripts/test-manifest.mjs docs/superpowers/specs/2026-08-03-account-level-ozon-category-auto-resolution-design.md
git commit -m "test: verify automatic Ozon category resolution"
```

- [ ] **Step 7: 按 AGENTS.md 输出最终交付说明**

最终说明必须逐项列出：改了什么、涉及文件和 contract、运行过的测试、回归过的旧功能、未验证范围及原因、风险、回滚/恢复方式。不得用“应该可以”代替验证结果。
