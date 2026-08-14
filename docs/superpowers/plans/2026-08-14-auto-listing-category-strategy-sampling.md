# 自动上架类目策略选样、生成与发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当自动上架遇到没有精确类目策略的商品时，安全停止建任务，引导管理员通过现有浏览器扩展选择同类商品，生成、编辑并发布账号级类目策略；发布后由用户再次确认创建任务。

**Architecture:** 以 `accountId + taxonomyScope + descriptionCategoryId + typeId` 作为唯一业务作用域。Web 管理页、扩展选样会话、样本图片证据、AI 分析草稿和不可变发布版本通过稳定 DTO 协作；普通采集、店铺凭据、自动上架任务与类目策略样本保持业务隔离。发布时把单类目草稿编译进新的账号级不可变策略版本，旧任务继续引用旧版本。

**Tech Stack:** Node.js ESM、PostgreSQL 16、React + Ant Design、Chrome Extension Manifest V3、MinIO/S3 compatible object storage、Sharp、Node test runner、Vite。

## Global Constraints

- 精确作用域仅为 `accountId + OZON:DEFAULT + descriptionCategoryId + typeId`；类目名称和页面路径只用于展示。
- 同账号多店铺共享策略；不同账号的样本、草稿、策略、会话和审计必须后端隔离。
- 缺少精确已发布策略时必须返回固定 `AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED`，且数据库中新增任务、任务项、outbox 和 AI 调用都为 0。
- 选样会话有效期固定为 2 小时；5～20 个唯一 SKU，推荐 6～12；每个 SKU 最多主图加前 5 张详情图。
- 普通采集与策略采集共享卡片解析能力，但不得共享业务写入、去重记录或采集箱状态。
- 原始大图只允许在下载和标准化期间临时存在；永久保存约 2048px 分析图和 UI 缩略图，并记录来源 URL、哈希、尺寸、角色和采集时间。
- 竞品图片只用于总结类目展示规律，绝不进入具体商品图片生成的参考图列表。
- 生成策略草稿是显式付费操作；保存样本不触发 AI；AI 草稿不自动发布。
- 只有具备 `AI_CONTENT_MANAGE` 后端权限的管理员能创建会话、保存样本、生成、编辑和发布；普通用户只读并可请求管理员处理。
- 发布版本不可修改；编辑和回滚都创建新版本。既有 v1 策略和既有自动上架任务必须保持可读、可重放。
- 类目策略只能约束各图片角色的构图、背景、文字密度、布局等，不得固定主图/卖点图等数量；数量继续来自本次任务页面配置。
- 新功能以账号级 feature flag 关闭为默认值；关闭时维持现有 `BALANCED_DEFAULT` 行为，开启后才执行缺策略门禁。
- 所有外部下载、对象存储、AI 调用和发布操作必须带幂等键、相关 ID、审计记录和稳定错误码。
- 数据库迁移从当前 `074` 之后新增 `075`，只做向前兼容的新增，不修改已发布迁移。

---

## Task 1: 建立类目策略闭合合同和纯状态机

**Files:**
- Create: `server/auto-listing-category-strategy-contract.mjs`
- Create: `server/tests/auto-listing-category-strategy-contract.test.mjs`

- [ ] **Step 1: 写精确作用域和状态 RED 测试**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectCategoryStrategyScope,
  projectCategoryStrategyDraft,
  validateCategoryStrategySamples,
} from '../auto-listing-category-strategy-contract.mjs';

test('scope requires the exact four-key account category identity', () => {
  assert.deepEqual(projectCategoryStrategyScope({
    accountId: 'account-a',
    taxonomyScope: 'OZON:DEFAULT',
    descriptionCategoryId: 17028922,
    typeId: 91542,
  }), {
    accountId: 'account-a',
    taxonomyScope: 'OZON:DEFAULT',
    descriptionCategoryId: 17028922,
    typeId: 91542,
  });
  assert.throws(() => projectCategoryStrategyScope({
    accountId: 'account-a', taxonomyScope: 'OZON:DEFAULT', descriptionCategoryId: 17028922,
  }), { code: 'AUTO_LISTING_CATEGORY_STRATEGY_CONTRACT_INVALID' });
});

test('sample set accepts 5 to 20 unique sku and at most six images each', () => {
  assert.throws(() => validateCategoryStrategySamples(makeSamples(4)), {
    code: 'AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_COUNT_INVALID',
  });
  assert.equal(validateCategoryStrategySamples(makeSamples(5)).length, 5);
});
```

- [ ] **Step 2: 运行测试确认因模块不存在而失败**

Run: `node --test server/tests/auto-listing-category-strategy-contract.test.mjs`

Expected: FAIL，提示找不到 `auto-listing-category-strategy-contract.mjs`。

- [ ] **Step 3: 实现 descriptor-safe 闭合合同**

实现并冻结以下稳定对象：

```js
export const CATEGORY_STRATEGY_DRAFT_STATES = Object.freeze([
  'COLLECTING', 'SAMPLES_READY', 'ANALYZING', 'DRAFT_READY', 'PUBLISHED', 'NEEDS_REVIEW',
]);

export function projectCategoryStrategyScope(input) { /* exact four keys */ }
export function projectCategoryStrategyDraft(input) { /* exact public DTO */ }
export function projectCategoryStrategyGuidanceV2(input) { /* exact role guidance */ }
export function validateCategoryStrategySamples(input) { /* 5..20 unique SKU, max six images */ }
```

投影器必须在读取普通字段前拒绝 Proxy、accessor、custom prototype、symbol key、extra key、循环、超长字符串、超大数组和超深对象；异常只暴露固定 code，不附带原始值或 cause。

- [ ] **Step 4: 增加状态跳转、角色策略和 hostile carrier 测试**

覆盖：

- `COLLECTING -> SAMPLES_READY -> ANALYZING -> DRAFT_READY -> PUBLISHED`；
- 任一步可在安全边界进入 `NEEDS_REVIEW`，但不能从 `PUBLISHED` 原地修改；
- `MAIN/SELLING_POINT/DETAIL/SCENE/SPECIFICATION/INFOGRAPHIC` 的详细构图、背景、文字密度和布局合同；
- 角色策略中禁止出现图片数量字段；
- 透明/撤销 Proxy、getter、危险键、超限输入 getter/trap 均为 0。

- [ ] **Step 5: 运行纯合同测试**

Run: `node --test server/tests/auto-listing-category-strategy-contract.test.mjs`

Expected: PASS，0 skip。

- [ ] **Step 6: 提交合同层**

```bash
git add server/auto-listing-category-strategy-contract.mjs server/tests/auto-listing-category-strategy-contract.test.mjs
git commit -m "feat(auto-listing): define category strategy contracts"
```

---

## Task 2: 新增 075 数据库模型和不可变约束

**Files:**
- Create: `server/db/migrations/075_auto_listing_category_strategy_sampling.sql`
- Create: `server/tests/auto-listing-category-strategy-migration.test.mjs`
- Modify: `server/tests/auto-listing-configurable-skeleton-e2e.test.mjs`

- [ ] **Step 1: 写迁移静态 RED 测试**

测试要求 075 创建以下账号隔离实体：

- `auto_listing_category_strategy_drafts`
- `auto_listing_category_strategy_account_settings`
- `auto_listing_category_strategy_sampling_sessions`
- `auto_listing_category_strategy_sample_sets`
- `auto_listing_category_strategy_samples`
- `auto_listing_category_strategy_sample_images`
- `auto_listing_category_strategy_analysis_attempts`
- `auto_listing_category_strategy_analysis_results`
- `auto_listing_category_strategy_events`

并要求复合外键包含 `account_id` 和完整类目作用域，发布/样本集/分析结果只能追加，直接 UPDATE/DELETE 固定 SQLSTATE `23514`。

- [ ] **Step 2: 运行静态迁移测试确认失败**

Run: `node --test server/tests/auto-listing-category-strategy-migration.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs`

Expected: FAIL，缺少 075 和 latest migration 断言。

- [ ] **Step 3: 实现 075 向前迁移**

关键字段：

```sql
-- scope identity
account_id text NOT NULL,
taxonomy_scope text NOT NULL CHECK (taxonomy_scope = 'OZON:DEFAULT'),
description_category_id bigint NOT NULL CHECK (description_category_id > 0),
type_id bigint NOT NULL CHECK (type_id > 0),

-- optimistic concurrency and idempotency
draft_version bigint NOT NULL,
idempotency_key text NOT NULL,
correlation_id text NOT NULL,
request_hash text NOT NULL,

-- immutable evidence
sample_set_hash text,
analysis_input_hash text,
published_strategy_version_id text
```

数据库必须约束：

- 同账号同类目作用域最多一个未结束草稿；
- 每个账号只有一条带版本号的策略门禁设置，默认 `LEGACY_FALLBACK`，只有显式切换到 `REQUIRE_EXACT_STRATEGY` 才阻止缺策略任务；设置变更记录操作者、相关 ID 和审计事件；
- 会话只属于同账号、同草稿和同作用域，`expires_at` 使用数据库时间；
- 样本 SKU 在同一 sample set 内唯一；图片 `(sample_id, role, ordinal)` 唯一；
- 样本集、图片证据、AI 原始结果和已发布结果不可变；
- parent-only cleanup 允许账号/草稿整体清理测试数据，禁止绕过 append-only 审计；
- 每次分析 attempt 绑定 immutable sample set hash、模型配置快照、预计费用确认和 idempotency key；
- 发布事件绑定现有账号级 `ai_content_strategy_versions`，不复制店铺 ID。

- [ ] **Step 4: 用临时 PostgreSQL 16 跑真实迁移攻击矩阵**

Run:

```bash
AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 \
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<random-port>/auto_listing_test \
node --test server/tests/auto-listing-category-strategy-migration.test.mjs
```

Expected: PASS，0 skip；跨账号 FK、错误类目、过期会话、直接改样本/结果/事件均被拒绝。

- [ ] **Step 5: 提交迁移**

```bash
git add server/db/migrations/075_auto_listing_category_strategy_sampling.sql server/tests/auto-listing-category-strategy-migration.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
git commit -m "feat(auto-listing): persist category strategy evidence"
```

---

## Task 3: 实现 PostgreSQL repository 和账号级不可变发布

**Files:**
- Create: `server/auto-listing-category-strategy-postgres.mjs`
- Create: `server/tests/auto-listing-category-strategy-postgres.integration.test.mjs`
- Modify: `server/auto-listing-ai-admin-postgres.mjs`
- Modify: `server/auto-listing-ai-admin-service.mjs`
- Modify: `server/tests/auto-listing-ai-admin-postgres.integration.test.mjs`
- Modify: `server/tests/auto-listing-ai-admin-service.test.mjs`

- [ ] **Step 1: 写 repository RED 测试**

测试使用单对象 closed API：

```js
await repository.createDraft({
  accountId, actorId, scope, sourceCollectItemId,
  expectedSourceVersion, idempotencyKey, correlationId,
});
await repository.startSamplingSession({
  accountId, actorId, draftId, expectedDraftVersion,
  sessionId, sessionSecretHash, expiresAt, idempotencyKey, correlationId,
});
await repository.commitSampleSet({
  accountId, actorId, draftId, sessionId, expectedDraftVersion,
  samples, sampleSetHash, idempotencyKey, correlationId,
});
await repository.transitionAccountPolicy({
  accountId, actorId, expectedVersion, mode: 'REQUIRE_EXACT_STRATEGY',
  idempotencyKey, correlationId,
});
```

RED 场景包含：同一 idempotency exact replay 返回同一结果、错误 request hash 冲突、过期会话零写、跨账号零写、并发 sample-set 提交只成功一个。

- [ ] **Step 2: 运行真实 PG 测试确认缺模块**

Run: `AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 TEST_DATABASE_URL=... node --test server/tests/auto-listing-category-strategy-postgres.integration.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现事务 repository**

所有状态端口在事务内：

1. 按账号、草稿、作用域和版本 `FOR UPDATE`；
2. 重新核验 source category 仍为 current exact evidence；
3. 校验 session 未过期且 secret hash 匹配；
4. 校验 sample set hash 和全部 SKU/category identity；
5. 先写不可变 evidence，再 CAS 草稿状态；
6. 写固定安全事件，不写 URL query token、credential 或 AI raw 文本。

- [ ] **Step 4: 实现单类目发布为新的账号级策略版本**

扩展现有 admin repository/service：发布某个草稿时读取当前账号已发布 bundle，复制未变规则，将同作用域旧规则替换为一个 `EXACT_CATEGORY_TYPE_V2` 规则，再创建新的不可变账号级版本并原子发布。

```js
const published = await publishCategoryStrategyDraft({
  accountId,
  actorId,
  draftId,
  expectedDraftVersion,
  expectedPublishedStrategyVersionId,
  idempotencyKey,
  correlationId,
});
```

同账号两个管理员并发发布时，只允许基于 current version 的一方成功；另一方返回稳定版本冲突，不覆盖已发布策略。

- [ ] **Step 5: 加发布/回滚/replay PG 测试**

覆盖：

- 发布 A 类目不删除 B 类目规则；
- 同作用域新发布产生新 rule/version，旧 version 仍可按 ID 读取；
- 回滚是复制旧规则生成新 version，而不是修改旧 version；
- 同账号两店读取相同规则；不同账号看不到对方；
- response loss 后按 idempotency exact replay；
- wrong actor/account/scope/version 全部零写。
- account policy 的版本冲突和 replay 受同一 closed tenant/idempotency 合同约束。

- [ ] **Step 6: 运行 repository/admin 测试**

Run:

```bash
AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 TEST_DATABASE_URL=... \
node --test \
  server/tests/auto-listing-category-strategy-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-admin-postgres.integration.test.mjs \
  server/tests/auto-listing-ai-admin-service.test.mjs
```

Expected: PASS，0 skip。

- [ ] **Step 7: 提交 repository 与发布编译器**

```bash
git add server/auto-listing-category-strategy-postgres.mjs server/auto-listing-ai-admin-postgres.mjs server/auto-listing-ai-admin-service.mjs server/tests/auto-listing-category-strategy-postgres.integration.test.mjs server/tests/auto-listing-ai-admin-postgres.integration.test.mjs server/tests/auto-listing-ai-admin-service.test.mjs
git commit -m "feat(auto-listing): publish account category strategies"
```

---

## Task 4: 建立样本图片证据流水线

**Files:**
- Create: `server/auto-listing-category-strategy-sample-store.mjs`
- Create: `server/tests/auto-listing-category-strategy-sample-store.test.mjs`
- Modify: `server/object-storage.mjs`
- Modify: `server/tests/object-storage.test.mjs`

- [ ] **Step 1: 写图片标准化 RED 测试**

用本地 fixture server 提供正常图片、超大图片、HTML 伪图片、重定向循环、超时和重复图片。断言：

- 每个 SKU 只接受 1 张主图和前 5 张详情图；
- 生成最长边约 2048px 的分析图和固定小缩略图；
- 保存 SHA-256、MIME、宽高、role、ordinal、source URL host 和 capturedAt；
- 原始大图 buffer 在完成后不进入永久 object key；
- SSRF 地址、非图片、超大小、解码失败返回固定安全码；
- 相同 source/hash replay 不重复写对象。

- [ ] **Step 2: 运行测试确认模块缺失**

Run: `node --test server/tests/auto-listing-category-strategy-sample-store.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 bounded download + Sharp 标准化**

```js
export function createCategoryStrategySampleStore({
  fetchImage,
  objectStorage,
  now,
  maxDownloadBytes,
}) {
  return Object.freeze({ persistSampleImages });
}
```

对象 key 必须包含账号、草稿、sample set、sample 和 hash，且不含商品标题或凭据。标准图和缩略图分别写入；任一步失败时清理本次未引用对象，数据库 evidence 不提交。

- [ ] **Step 4: 扩展对象存储 closed API**

为 `object-storage.mjs` 增加按 expected hash 写入和有界读取接口，保持现有 API 兼容；测试 response loss、重复 put、错误 account prefix 和 cleanup。

- [ ] **Step 5: 运行图片与对象存储测试**

Run: `node --test server/tests/auto-listing-category-strategy-sample-store.test.mjs server/tests/object-storage.test.mjs`

Expected: PASS，0 skip。

- [ ] **Step 6: 提交样本证据层**

```bash
git add server/auto-listing-category-strategy-sample-store.mjs server/object-storage.mjs server/tests/auto-listing-category-strategy-sample-store.test.mjs server/tests/object-storage.test.mjs
git commit -m "feat(auto-listing): store bounded strategy samples"
```

---

## Task 5: 实现管理员服务、HTTP API 和浏览器会话

**Files:**
- Create: `server/auto-listing-category-strategy-service.mjs`
- Create: `server/auto-listing-category-strategy-routes.mjs`
- Create: `server/auto-listing-category-strategy-runtime.mjs`
- Create: `server/tests/auto-listing-category-strategy-service.test.mjs`
- Create: `server/tests/auto-listing-category-strategy-routes.test.mjs`
- Modify: `server/auto-listing-web-runtime.mjs`
- Modify: `server/index.mjs`
- Modify: `server/tests/auto-listing-web-runtime.test.mjs`

- [ ] **Step 1: 写管理员 API RED 测试**

固定路由：

```text
GET    /admin/auto-listing/category-strategies
GET    /admin/auto-listing/category-strategies/settings
PATCH  /admin/auto-listing/category-strategies/settings
GET    /admin/auto-listing/category-strategies/:draftId
POST   /admin/auto-listing/category-strategies/drafts
POST   /admin/auto-listing/category-strategies/:draftId/sampling-sessions
POST   /admin/auto-listing/category-strategies/:draftId/sample-sets
DELETE /admin/auto-listing/category-strategies/:draftId/samples/:sampleId
POST   /admin/auto-listing/category-strategies/:draftId/analysis-attempts
PATCH  /admin/auto-listing/category-strategies/:draftId
POST   /admin/auto-listing/category-strategies/:draftId/publish
POST   /admin/auto-listing/category-strategies/:draftId/rollback
```

测试普通用户 403、跨账号 404、未知字段 400、重复 idempotency exact replay、过期 sampling session 409、错误类目/商品类型 409。

- [ ] **Step 2: 运行服务/路由测试确认失败**

Run: `node --test server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-category-strategy-routes.test.mjs`

Expected: FAIL，模块和 route handler 不存在。

- [ ] **Step 3: 实现权限和 exact source category revalidation**

所有写操作先在后端要求 `AI_CONTENT_MANAGE`，再读取当前账号共享类目证据并逐项比较 scope。settings 写接口只接受 `expectedVersion/mode/idempotencyKey/correlationId`，用于账号级灰度且不接受店铺 ID。创建会话返回：

```js
{
  sessionId,
  expiresAt,
  browserUrl,
  extensionMode: 'CATEGORY_STRATEGY_SAMPLING',
  scope: { taxonomyScope, descriptionCategoryId, typeId },
}
```

session secret 不放 URL，不返回 Web 页面；只通过已认证的扩展 session channel 写入 `chrome.storage.session`。

- [ ] **Step 4: 实现确认样本业务顺序**

1. 验证会话、管理员、账号、草稿和作用域；
2. 对每个 SKU 用 Ozon exact card/product facts 重新核验 category/type；
3. 5～20 个唯一 SKU；
4. 调用 Task 4 保存标准图；
5. 计算 canonical sample set hash；
6. 调 repository 原子提交；
7. 返回安全摘要，绝不写普通 collect tables。

- [ ] **Step 5: 把 runtime 接入现有 Web server**

在 `auto-listing-web-runtime.mjs` 暴露独立 `handleCategoryStrategyAdminRoute`，在 `server/index.mjs` 路由到该 handler；不要把接口塞进现有 AI 模型配置 DTO。

- [ ] **Step 6: 增加服务 hostile/side-effect 测试**

覆盖 getter/proxy/extra、错误 session secret、类目页与商品卡身份不一致、重复 SKU、对象存储失败、repository 冲突。断言失败时 AI 调用 0、普通 collect 写入 0、发布 0。

- [ ] **Step 7: 运行服务、路由、runtime 测试**

Run:

```bash
node --test \
  server/tests/auto-listing-category-strategy-service.test.mjs \
  server/tests/auto-listing-category-strategy-routes.test.mjs \
  server/tests/auto-listing-web-runtime.test.mjs
```

Expected: PASS，0 skip。

- [ ] **Step 8: 提交后端 API**

```bash
git add server/auto-listing-category-strategy-service.mjs server/auto-listing-category-strategy-routes.mjs server/auto-listing-category-strategy-runtime.mjs server/auto-listing-web-runtime.mjs server/index.mjs server/tests/auto-listing-category-strategy-service.test.mjs server/tests/auto-listing-category-strategy-routes.test.mjs server/tests/auto-listing-web-runtime.test.mjs
git commit -m "feat(auto-listing): expose category strategy workflow"
```

---

## Task 6: 在扩展端实现独立的类目策略选样模式

**Files:**
- Create: `extension/lib/category-strategy-sampling.js`
- Create: `extension/tests/category-strategy-sampling.test.js`
- Modify: `extension/content/ozon-search.js`
- Modify: `extension/content/ozon-search.css`
- Modify: `extension/background/service-worker.js`
- Modify: `extension/manifest.json`
- Modify: `extension/tests/removed-selection-watermark-contract.test.js`

- [ ] **Step 1: 写扩展 closed session RED 测试**

```js
test('strategy sampling is separate from ordinary collection', async () => {
  const result = await beginCategoryStrategySampling({
    sessionId: 'session-a',
    sessionSecret: 'secret-a',
    scope: exactScope,
    expiresAt,
  });
  assert.equal(normalCollectWrites, 0);
  assert.equal(result.mode, 'CATEGORY_STRATEGY_SAMPLING');
});
```

覆盖：无 session 不显示多选框；expired session 清理 UI；5～20 计数；重复 SKU 去重；页面类目不匹配时整页阻断；卡片身份不匹配不能选中；确认只调用专用 API。

- [ ] **Step 2: 运行扩展测试确认失败**

Run: `node --test extension/tests/category-strategy-sampling.test.js extension/tests/removed-selection-watermark-contract.test.js`

Expected: FAIL，专用模块不存在；旧通用“选品模式”仍保持删除合同。

- [ ] **Step 3: 实现 session channel 和独立状态机**

`service-worker.js` 新增明确消息：

```text
CATEGORY_STRATEGY_SESSION_START
CATEGORY_STRATEGY_SESSION_GET
CATEGORY_STRATEGY_SESSION_CANCEL
CATEGORY_STRATEGY_SAMPLES_CONFIRM
```

session secret 只放 `chrome.storage.session`；URL 只携无权威的页面导航信息。所有消息需要当前已登录账号和 session account 一致。

- [ ] **Step 4: 在商品卡渲染专用多选框和底栏**

复用现有 Ozon card parser 的只读结果，增加独立 DOM namespace，例如 `data-zongzi-category-strategy-sampling`。底栏显示已选数量、目标类目、安全提示、取消和确认。不得恢复旧的通用“选品模式”、水印或普通批量采集写入。

- [ ] **Step 5: 实现 exact page/card category validation**

页面初始化和每张卡片提交前都比较 `taxonomyScope/descriptionCategoryId/typeId`；缺任一字段时不能猜测，只提示“无法确认类目，请打开准确类目页”。后端仍执行最终校验。

- [ ] **Step 6: 运行扩展测试和打包检查**

Run:

```bash
node --test extension/tests/category-strategy-sampling.test.js extension/tests/removed-selection-watermark-contract.test.js
npm run package-extension
```

Expected: 测试 PASS，0 skip；扩展构建成功；manifest 权限没有新增不必要的广域权限。

- [ ] **Step 7: 提交扩展选样模式**

```bash
git add extension/lib/category-strategy-sampling.js extension/content/ozon-search.js extension/content/ozon-search.css extension/background/service-worker.js extension/manifest.json extension/tests/category-strategy-sampling.test.js extension/tests/removed-selection-watermark-contract.test.js
git commit -m "feat(extension): collect category strategy samples"
```

---

## Task 7: 实现付费 AI 类目策略分析器

**Files:**
- Create: `server/auto-listing-category-strategy-analyzer.mjs`
- Create: `server/tests/auto-listing-category-strategy-analyzer.test.mjs`
- Modify: `server/auto-listing-category-strategy-service.mjs`
- Modify: `server/tests/auto-listing-category-strategy-service.test.mjs`

- [ ] **Step 1: 写显式费用确认和证据 RED 测试**

测试要求：

- 未传 `costConfirmed: true` 时 AI 调用 0；
- 少于 5 个样本或样本图未 READY 时 AI 调用 0；
- 输出结论引用的每个共性至少来自 2 个不同 SKU；
- 单样本现象只能进入 `differences`，不能成为推荐；
- AI 输出不完整、slot 数量、未知 role、图片数量字段、无法对应 evidence ID 时进入 `NEEDS_REVIEW`；
- 相同 sample set/model/prompt/profile/idempotency 重放不重复收费。

- [ ] **Step 2: 运行 analyzer 测试确认失败**

Run: `node --test server/tests/auto-listing-category-strategy-analyzer.test.mjs`

Expected: FAIL，analyzer 模块不存在。

- [ ] **Step 3: 实现 frozen multimodal request**

输入只能包含标准分析图、脱敏商品事实、exact scope 和固定输出 schema。请求不得包含店铺 credential、普通采集编辑记录或具体自动上架任务图片。

输出合同：

```js
{
  schemaVersion: 2,
  style,
  roleGuidance: {
    MAIN: { composition, background, textDensity, layout, evidenceIds, confidence },
    SELLING_POINT: { composition, background, textDensity, layout, evidenceIds, confidence },
    DETAIL: { composition, background, textDensity, layout, evidenceIds, confidence },
    SCENE: { composition, background, textDensity, layout, evidenceIds, confidence },
    SPECIFICATION: { composition, background, textDensity, layout, evidenceIds, confidence },
    INFOGRAPHIC: { composition, background, textDensity, layout, evidenceIds, confidence },
  },
  commonPatterns,
  differences,
  cautions,
}
```

- [ ] **Step 4: 持久化每次 attempt 和 raw/normalized 分层证据**

调用前 reserve attempt；调用成功后先写 bounded backend raw，再写经过 Task 1 projector 的 normalized result；失败写固定错误码和重试性，不把 vendor 原文暴露给 Web。

- [ ] **Step 5: 增加 response-loss、模型错误和人工覆盖测试**

人工编辑可覆盖 AI 建议，但必须保存 `editedBy/editedAt/baseAnalysisAttemptId` 并在 UI 标记。保存编辑不再次调用 AI；重新分析明确产生新 attempt。

- [ ] **Step 6: 运行 analyzer/service 测试**

Run: `node --test server/tests/auto-listing-category-strategy-analyzer.test.mjs server/tests/auto-listing-category-strategy-service.test.mjs`

Expected: PASS，0 skip。

- [ ] **Step 7: 提交 AI 分析器**

```bash
git add server/auto-listing-category-strategy-analyzer.mjs server/auto-listing-category-strategy-service.mjs server/tests/auto-listing-category-strategy-analyzer.test.mjs server/tests/auto-listing-category-strategy-service.test.mjs
git commit -m "feat(auto-listing): analyze category strategy samples"
```

---

## Task 8: 让发布策略进入内容规划，但不改变图片数量

**Files:**
- Modify: `server/ai-content-strategy.mjs`
- Modify: `server/auto-listing-content-planner.mjs`
- Modify: `server/auto-listing-ai-phase-context-postgres.mjs`
- Modify: `server/auto-listing-ai-runtime-composition.mjs`
- Modify: `server/tests/ai-content-strategy.test.mjs`
- Modify: `server/tests/auto-listing-content-planner.test.mjs`
- Modify: `server/tests/auto-listing-ai-phase-context-postgres.test.mjs`
- Modify: `server/tests/auto-listing-ai-runtime-composition.test.mjs`

- [ ] **Step 1: 写 V2 exact rule RED 测试**

```js
test('exact category type V2 guidance wins and task counts remain authoritative', () => {
  const strategy = resolveAiContentStrategy({
    strategyVersion: publishedV2,
    category: { descriptionCategoryId: 17028922, typeId: 91542 },
  });
  const plan = buildAutoListingContentPlan({
    strategy,
    requestedCounts: { MAIN: 1, SELLING_POINT: 3, DETAIL: 1, SCENE: 1, SPECIFICATION: 1, INFOGRAPHIC: 1 },
  });
  assert.equal(plan.slots.length, 8);
  assert.equal(plan.slots.filter((slot) => slot.role === 'MAIN').length, 1);
  assert.equal(plan.strategyRule.matchType, 'EXACT_CATEGORY_TYPE_V2');
});
```

RED 还要证明旧 V1 版本仍按原逻辑解析。

- [ ] **Step 2: 运行 planner 测试确认 V2 未被识别**

Run: `node --test server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs`

Expected: FAIL，V2 guidance 未进入 frozen planner context。

- [ ] **Step 3: 扩展 resolver 的优先级和冻结结果**

优先级：

```text
EXACT_CATEGORY_TYPE_V2
> 既有 EXACT_CATEGORY
> 既有 ANCESTOR_CATEGORY
> PRODUCT_STYLE
> BALANCED_DEFAULT
```

V2 结果包含 immutable `strategyVersionId/ruleId/scope/roleGuidance/sampleSetHash/analysisAttemptId`；这些字段只用于策略追溯和 prompt 约束。

- [ ] **Step 4: 让 planner 按 requestedCounts 生成 slot**

每个 slot 取相应 role guidance，但 slot 数量和 role 数量只读 `requestedCounts`。如果策略要求不存在的 role，忽略该 guidance；如果任务请求某 role 而 V2 未提供，使用固定安全 fallback 并记录诊断，不追加或减少图片。

- [ ] **Step 5: 确保竞品图不进入生成参考图**

AI phase 的参考图 projector 只能接收当前 source 商品/已批准资产；category sample object keys 出现在输入时固定拒绝并进入人工审核，不调用图片模型。

- [ ] **Step 6: 运行策略/planner/AI phase 回归**

Run: `node --test server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs`

Expected: PASS，0 skip；旧 V1、fixed skeleton、动态图片数量全部回归。

- [ ] **Step 7: 提交内容规划集成**

```bash
git add server/ai-content-strategy.mjs server/auto-listing-content-planner.mjs server/auto-listing-ai-phase-context-postgres.mjs server/auto-listing-ai-runtime-composition.mjs server/tests/ai-content-strategy.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-ai-phase-context-postgres.test.mjs server/tests/auto-listing-ai-runtime-composition.test.mjs
git commit -m "feat(auto-listing): plan from published category strategy"
```

---

## Task 9: 在创建任务前增加缺策略门禁和继续创建

**Files:**
- Modify: `server/auto-listing-service.mjs`
- Modify: `server/auto-listing-runtime.mjs`
- Modify: `server/auto-listing-routes.mjs`
- Modify: `server/tests/auto-listing-service.test.mjs`
- Modify: `server/tests/auto-listing-runtime-worker.test.mjs`
- Modify: `server/tests/auto-listing-routes.test.mjs`

- [ ] **Step 1: 写零副作用 RED 测试**

在账号 feature flag 开启、精确策略缺失时：

```js
await assert.rejects(() => service.createJob(request), {
  code: 'AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED',
  statusCode: 409,
});
assert.deepEqual(calls, {
  createJobGraph: 0,
  categoryPrepare: 0,
  paidAi: 0,
  objectStorage: 0,
  outbox: 0,
});
```

错误 public details 只包含 scope、安全状态、现有 draft ID（若同账号可见）和 `canManage`；不返回 account ID、sample URL 或管理员资料。

- [ ] **Step 2: 运行 service/runtime/routes 测试确认失败**

Run: `node --test server/tests/auto-listing-service.test.mjs server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-routes.test.mjs`

Expected: FAIL，当前仍落入 `BALANCED_DEFAULT` 并创建任务。

- [ ] **Step 3: 在任何 preparer/AI/job write 前查询 published exact rule**

流程：source category exact read → source version authorization → feature flag → exact published strategy lookup。缺失立即返回；存在时把 `strategyVersionId/ruleId` 放入后续 create graph command，保持 Task 4 lease/fence 逻辑。

- [ ] **Step 4: 实现 continue-create 的重新核验**

Web 再次提交原配置和新的 idempotency key；后端不信任旧弹窗状态，重新读取 source version、published strategy current version、store/warehouse/currency 和 requestedCounts。只有全部仍有效才创建任务并冻结当前 strategy version。

- [ ] **Step 5: 增加 flag/V1/并发发布测试**

覆盖：

- flag off 保持现有 fallback；
- flag on + V1 exact rule 可继续创建；
- flag on + only ancestor/default 仍提示缺精确策略；
- 发布后继续创建冻结发布版本；
- 发布与 source category 变化竞态返回 source/version conflict，零任务；
- 两店共用策略但各自冻结正确 store/warehouse/currency；
- 相同 create idempotency replay 只创建一个 job。

- [ ] **Step 6: 运行创建任务回归**

Run: `node --test server/tests/auto-listing-service.test.mjs server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-routes.test.mjs`

Expected: PASS，0 skip。

- [ ] **Step 7: 提交创建任务门禁**

```bash
git add server/auto-listing-service.mjs server/auto-listing-runtime.mjs server/auto-listing-routes.mjs server/tests/auto-listing-service.test.mjs server/tests/auto-listing-runtime-worker.test.mjs server/tests/auto-listing-routes.test.mjs
git commit -m "feat(auto-listing): require published category strategy"
```

---

## Task 10: 实现 Web 查看、选样、编辑、发布和返回继续创建

**Files:**
- Create: `app/src/CategoryStrategyPage.jsx`
- Create: `app/src/category-strategy.css`
- Create: `app/src/category-strategy-client.js`
- Create: `app/src/category-strategy-model.js`
- Create: `app/tests/category-strategy-page.test.mjs`
- Create: `app/tests/category-strategy-model.test.mjs`
- Modify: `app/src/App.jsx`
- Modify: `app/src/AutoListingPage.jsx`
- Modify: `app/tests/auto-listing-page-contract.test.mjs`

- [ ] **Step 1: 写纯 UI model 和页面 RED 测试**

model 必须 closed-project：列表、详情、sampling session、sample cards、analysis draft、published version 和 `STRATEGY_REQUIRED` 错误。测试 accessor/proxy/raw vendor message 不进入 UI。

页面测试要求：

- 缺策略弹窗显示目标类目、当前状态和“开始配置”；
- 普通用户只显示“请求管理员处理”；
- 管理员可进入查看/编辑/发布；
- 保存 5～20 个样本后才启用“生成类目策略草稿”；
- 生成前展示预计费用并要求明确确认；
- AI 草稿逐角色展示证据、置信度、差异和警告；
- 发布影响预览显示同账号复用，不展示或泄露其他账号；
- 发布成功后按钮是“返回并继续创建”，不会自动创建任务。

- [ ] **Step 2: 运行 UI 测试确认模块缺失**

Run: `node --test app/tests/category-strategy-model.test.mjs app/tests/category-strategy-page.test.mjs app/tests/auto-listing-page-contract.test.mjs`

Expected: FAIL，新模块和路由不存在。

- [ ] **Step 3: 实现 API client 和安全 model**

client 只传 stable DTO、idempotency key、correlation ID 和 expected versions。对 409 source/strategy conflict、403、404、429、AI unavailable 分别映射固定中文文案，不把服务端 raw message 直接显示。

- [ ] **Step 4: 实现类目策略管理页**

页面区域：

1. 类目身份与发布状态；
2. 样本库及标准图缩略图；
3. “开始配置/继续选样”及 2 小时会话倒计时；
4. 显式付费 AI 生成；
5. 按图片角色编辑详细规则；
6. 证据/置信度/差异；
7. 影响预览、发布、历史版本和创建回滚版本。

不展示原始大图 URL、object key、credential、actor 内部 ID 或 AI raw response。

- [ ] **Step 5: 接入自动上架页**

捕获 `AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED` 后保存当前表单草稿和 exact source version，打开弹窗。管理员完成发布后返回原页，表单配置仍在；用户点击“继续创建任务”产生新的 idempotency key，数量配置保持原值。

- [ ] **Step 6: 浏览器交互和可访问性测试**

使用本地真实 App/API：键盘可操作弹窗、样本 checkbox 有 label、倒计时和错误不只靠颜色、发布确认可取消、窄屏不遮挡主要操作。保存截图到设计 evidence 目录，不复用静态假页。

- [ ] **Step 7: 运行前端测试和生产构建**

Run:

```bash
node --test app/tests/category-strategy-model.test.mjs app/tests/category-strategy-page.test.mjs app/tests/auto-listing-page-contract.test.mjs
npm --prefix app run build
```

Expected: tests PASS，0 skip；Vite production build exit 0。

- [ ] **Step 8: 提交 Web 管理页**

```bash
git add app/src/CategoryStrategyPage.jsx app/src/category-strategy.css app/src/category-strategy-client.js app/src/category-strategy-model.js app/src/App.jsx app/src/AutoListingPage.jsx app/tests/category-strategy-page.test.mjs app/tests/category-strategy-model.test.mjs app/tests/auto-listing-page-contract.test.mjs
git commit -m "feat(ui): manage auto-listing category strategies"
```

---

## Task 11: 完成真实组合 E2E、可观测性和灰度门禁

**Files:**
- Create: `server/tests/auto-listing-category-strategy-e2e.test.mjs`
- Create: `docs/runbooks/auto-listing-category-strategy-rollout.md`
- Modify: `package.json`
- Modify: `server/auto-listing-category-strategy-service.mjs`
- Modify: `server/auto-listing-category-strategy-runtime.mjs`
- Modify: `server/tests/auto-listing-category-strategy-service.test.mjs`

- [ ] **Step 1: 写真实组合 E2E RED**

E2E 必须在 fresh PostgreSQL 16 应用 `001–075`，使用 loopback fake Ozon、fake AI、fake object storage，穿过 production runtime/routes/service/repository，而不是直接 SQL 推进状态。

主链：

```text
真实采集/类目证据
→ 自动上架 create 返回 STRATEGY_REQUIRED，job/AI=0
→ 管理员建草稿和 session
→ 扩展专用 API 保存 6 个 exact sample SKU
→ 显式确认费用并生成 AI 草稿
→ 管理员编辑并发布 immutable account version
→ 原页面 continue-create
→ 任务冻结 published version/rule
→ planner 按页面 requestedCounts 生成 slots
```

- [ ] **Step 2: 增加失败和恢复矩阵**

必须覆盖：

- 页/卡/后端任一 category/type 不一致，零 sample set；
- session 过期、response loss、重复确认、对象写失败、AI 超时、AI malformed；
- 4/5/20/21 个样本边界；
- 跨账号读写、同账号两店复用；
- 并发 publish conflict；
- 发布后 source category 变化，continue-create 零任务；
- 普通 collect tables 在整个策略选样中保持完全不变；
- sample image object keys 不进入 image-generation reference request；
- V1 旧策略和旧 job replay；
- feature flag off 回归；
- 删除/停用草稿只清未发布临时对象，不删除已发布 evidence。

- [ ] **Step 3: 增加可观测性**

固定 metric/event：

```text
category_strategy_required_total
category_strategy_sampling_started_total
category_strategy_sample_set_committed_total
category_strategy_analysis_attempt_total{outcome}
category_strategy_publish_total{outcome}
category_strategy_continue_create_total{outcome}
```

日志只含 account-safe hash、draft/session/attempt/strategy IDs、scope、correlation ID、outcome 和耗时；不含图片 URL query、credential、AI raw response 或商品私密资料。

- [ ] **Step 4: 添加 package script 并跑 E2E**

在 `package.json` 添加：

```json
"test:auto-listing-category-strategy-e2e": "node --test server/tests/auto-listing-category-strategy-e2e.test.mjs"
```

Run:

```bash
AUTO_LISTING_CATEGORY_STRATEGY_POSTGRES_TESTS=1 \
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<random-port>/auto_listing_test \
npm run test:auto-listing-category-strategy-e2e
```

Expected: PASS，0 skip。

- [ ] **Step 5: 跑完整聚焦回归**

Run:

```bash
node --test \
  server/tests/auto-listing-category-strategy-*.test.mjs \
  server/tests/ai-content-strategy.test.mjs \
  server/tests/auto-listing-content-planner.test.mjs \
  server/tests/auto-listing-service.test.mjs \
  extension/tests/category-strategy-sampling.test.js \
  app/tests/category-strategy-*.test.mjs \
  app/tests/auto-listing-page-contract.test.mjs
npm --prefix app run build
npm run package-extension
git diff --check
```

Expected: all pass，0 unexpected skip；build exit 0；diff clean。

- [ ] **Step 6: 写灰度、回滚和人工恢复 runbook**

runbook 必须说明：

- 默认关闭，按账号开启；
- 开启前检查对象存储、AI 模型配置、管理员权限和 075 migration；
- 监控 required→sampling→analysis→publish→continue 漏斗；
- 关闭 flag 立即恢复旧 fallback，但不删除任何 evidence/version；
- AI/对象存储异常时停在 `NEEDS_REVIEW`，不自动发布；
- 取消未发布草稿时如何清理无引用对象；
- 发布错误时通过新版本回滚，不修改历史版本；
- 扩展回滚只关闭 strategy sampling mode，不影响普通采集。

- [ ] **Step 7: 提交 E2E 和运维材料**

```bash
git add server/tests/auto-listing-category-strategy-e2e.test.mjs server/auto-listing-category-strategy-service.mjs server/auto-listing-category-strategy-runtime.mjs server/tests/auto-listing-category-strategy-service.test.mjs docs/runbooks/auto-listing-category-strategy-rollout.md package.json
git commit -m "test(auto-listing): verify category strategy workflow"
```

---

## Final Verification Checklist

- [ ] Fresh PostgreSQL 16 从 `001` 应用到 `075`，所有目标 PG suite 0 skip。
- [ ] 缺策略时任务、任务项、outbox、AI、对象存储写入全部为 0。
- [ ] 普通采集表在策略选样全流程 before/after 完全相等。
- [ ] 5～20 SKU、每 SKU 最多 6 图、2 小时 session 和 exact category/type 三层校验已真实覆盖。
- [ ] AI 只在明确费用确认后调用，response loss 不重复收费。
- [ ] 发布生成新账号级不可变版本；同账号多店共享，不同账号隔离。
- [ ] 自动上架任务冻结具体 strategy version/rule，后续发布不改变旧任务。
- [ ] planner 图片数量逐项等于页面 requestedCounts，策略没有数量覆盖权。
- [ ] 竞品样本 object keys 没有进入具体商品图片生成请求。
- [ ] Web 查看、编辑、发布、版本历史、回滚和返回继续创建均通过真实 App/API 验收。
- [ ] 扩展专用选样不恢复旧通用“选品模式”，不污染采集箱。
- [ ] 权限、跨账号、并发、幂等、hostile DTO、过期、外部失败和恢复矩阵全绿。
- [ ] V1 策略、旧任务、固定骨架、动态图片数量、普通采集、店铺币种、仓库和库存回归通过。
- [ ] App 和 extension 构建成功，syntax 和 `git diff --check` clean。
- [ ] 报告列明验证结果、未验证范围、生产 V1/feature flag 状态、风险和回滚方式。
