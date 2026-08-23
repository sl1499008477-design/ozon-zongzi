# 自动上架 V6 通用商品主导图片模板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不绑定具体品类的前提下，让自动上架按“商品主体优先、高密度电商表达、类目策略定风格、商品证据定内容”的规则生成各司其职的图片，并保留人工审核后再上传。

**Architecture:** 保持现有固定服务器骨架和单任务工作流。只扩展现有 JSON 计划与检查证据：规划阶段按可信事实分配角色和文案，生成阶段写入统一视觉契约及角色差异，检查阶段区分必须阻断的事实错误与可进入人工审核的表现问题，审核阶段展示替代角色和警告。旧计划只读兼容，新任务使用 V2 计划；不新增服务、框架、依赖或数据库表。

**Tech Stack:** Node.js ESM、内置 node:test、PostgreSQL JSONB、React、Ant Design、现有 Sub2API/OpenAI 兼容图片模型适配器。

**Spec:** docs/superpowers/specs/2026-08-23-universal-product-led-image-template-v6-design.md

## Global Constraints

- 使用已有代表性采集商品验证；不覆盖、丢弃或重置用户未提交修改。
- 保持后端账号、店铺、租户、金额、库存、幂等和人工审核边界。
- 类目策略决定视觉语言；自动上架不得另行强制“主图无文字”等冲突风格。
- 图片比例和目标尺寸只读取“图片生成配置”，不得写死 768×1024。
- 没有可信尺寸时不得伪造尺寸，也不得静默减少总图数；必须在付费调用前换成有证据的角色，无法分配则阻断。
- 新任务写 V2 计划；旧 V1 计划必须仍可校验、恢复、审核和上传。
- 本计划不含数据库迁移。若现有 JSONB 无法承载新增字段，暂停并单独申请批准。
- 每批先写失败测试，再做最小实现；通过相关测试后单独提交，便于回滚。

---

## Task 1：保留请求图数并兼容历史审计记录

**Files:**

- Modify: server/auto-listing-item-image-config.mjs
- Modify: server/auto-listing-repository.mjs
- Modify: server/auto-listing-upload-postgres.mjs
- Modify: server/tests/auto-listing-item-image-config.test.mjs
- Modify: server/tests/auto-listing-upload-postgres.test.mjs
- Modify: server/tests/auto-listing-service.test.mjs

- [ ] **Step 1: 写出缺少尺寸但总图数不减少的失败测试**

~~~js
test("missing dimensions preserves requested total for later substitution", () => {
  const frozen = frozenConfig();
  const result = deriveEffectiveAutoListingImageConfig({
    configSnapshot: frozen.config,
    configHash: frozen.configHash,
    sourceCapture: sourceCapture(),
  });
  assert.equal(result.roles.specification, 1);
  assert.equal(result.total, 8);
  assert.deepEqual(result.reasonCodes, ["PRODUCT_DIMENSIONS_UNAVAILABLE"]);
});
~~~

再增加两个兼容测试：历史记录 SPECIFICATION=0/total=7 可读取；新记录 SPECIFICATION=1/total=8 也可进入后续流程。

- [ ] **Step 2: 运行测试并确认失败来自旧的静默减图行为**

Run:

~~~bash
node --test server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-upload-postgres.test.mjs server/tests/auto-listing-service.test.mjs
~~~

Expected: 新测试显示实际值仍为 SPECIFICATION=0、total=7；权限、店铺和上传测试没有新失败。

- [ ] **Step 3: 最小修改有效图片配置**

~~~js
const roles = Object.freeze({ ...config.image.roles });
const missingDimensions = roles.specification > 0 && !hasReliableMeasurements(input);
return {
  roles,
  total: Object.values(roles).reduce((sum, count) => sum + count, 0),
  reasonCodes: missingDimensions ? ["PRODUCT_DIMENSIONS_UNAVAILABLE"] : [],
};
~~~

仓储和上传解析器同时接受历史减图形态和新保留总数形态；新写入只用后一种。不得放宽账号、店铺或任务归属校验。

- [ ] **Step 4: 重跑本任务测试并提交**

~~~bash
node --test server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-upload-postgres.test.mjs server/tests/auto-listing-service.test.mjs
git add server/auto-listing-item-image-config.mjs server/auto-listing-repository.mjs server/auto-listing-upload-postgres.mjs server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-upload-postgres.test.mjs server/tests/auto-listing-service.test.mjs
git commit -m "fix: preserve requested auto listing image count"
~~~

Expected: 新任务保持 8 张，历史 7 图任务仍能读取。

---

## Task 2：付费调用前完成证据驱动角色替代并生成 V2 计划

**Files:**

- Modify: server/auto-listing-content-planner.mjs
- Modify: server/auto-listing-fixed-skeleton.mjs
- Modify: server/auto-listing-content-plan-validator.mjs
- Modify: server/auto-listing-materialized-plan.mjs
- Modify: server/tests/auto-listing-content-planner.test.mjs
- Modify: server/tests/auto-listing-fixed-skeleton.test.mjs
- Modify: server/tests/auto-listing-content-plan-validator.test.mjs
- Modify: server/tests/auto-listing-materialized-plan.test.mjs

- [ ] **Step 1: 写角色替代、无证据阻断和 V1 兼容失败测试**

~~~js
test("replaces unsupported specification without changing total", () => {
  const built = planner({
    sourceCapture: sourceCapture({ reliableDimensions: false, attributes: [] }),
  });
  const input = built.plannerInput;
  assert.equal(input.imagesPerVisualGroup, 8);
  assert.equal(sumCounts(input.requestedRoleCounts), 8);
  assert.equal(input.requestedRoleCounts.SPECIFICATION, 0);
  assert.deepEqual(input.roleSubstitutions, [{
    requestedRole: "SPECIFICATION",
    actualRole: "DETAIL",
    count: 1,
    reasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
  }]);
});

test("blocks before gateway when no evidence-backed role has capacity", async () => {
  await assert.rejects(
    () => planWithGateway(contextWithoutAnySubstitutionEvidence),
    { code: "AUTO_LISTING_IMAGE_ROLE_SUBSTITUTION_UNAVAILABLE" },
  );
  assert.equal(gateway.calls.length, 0);
});

test("accepts historical V1 and new V2 plans", () => {
  assert.doesNotThrow(() => validateContentPlan(v1Fixture, plannerInput));
  assert.doesNotThrow(() => validateContentPlan(v2Fixture, plannerInput));
});
~~~

- [ ] **Step 2: 运行测试，确认旧逻辑会少一张或在骨架处失败**

~~~bash
node --test server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-materialized-plan.test.mjs
~~~

- [ ] **Step 3: 实现窄范围的替代函数**

~~~js
const SUBSTITUTION_ORDER = ["DETAIL", "SELLING_POINT", "SCENE", "INFOGRAPHIC"];

function substituteUnsupportedRoles({ requestedRoleCounts, factsByGroup }) {
  const counts = { ...requestedRoleCounts };
  const substitutions = [];
  if (counts.SPECIFICATION > 0 && !everyGroupHasSpecificationEvidence(factsByGroup)) {
    const count = counts.SPECIFICATION;
    counts.SPECIFICATION = 0;
    const actualRole = SUBSTITUTION_ORDER.find((role) =>
      counts[role] + count <= ROLE_LIMITS[role]
      && everyGroupHasRoleEvidence(factsByGroup, role));
    if (!actualRole) throw roleSubstitutionUnavailable();
    counts[actualRole] += count;
    substitutions.push({
      requestedRole: "SPECIFICATION",
      actualRole,
      count,
      reasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
    });
  }
  return { counts, substitutions };
}
~~~

只处理当前有证据的尺寸缺口，不建立通用策略框架。

- [ ] **Step 4: 扩展 V2 槽位但保留 V1 读取**

~~~js
{
  version: 2,
  language: "ru",
  slots: [{
    slotKey: "visual-group-1:DETAIL:2",
    visualGroupKey: "visual-group-1",
    role: "DETAIL",
    requestedRole: "SPECIFICATION",
    substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
    order: 6,
    textDensity: "MEDIUM",
    claims: ["Корпус из алюминиевого сплава"],
    sourceFactIds: ["ATTRIBUTE:material"],
    referenceAssetIds: ["source-asset-front"],
    preserve: ["product shape", "product color", "control layout"],
    prohibitedClaims: ["unverified dimensions", "unverified performance"],
  }],
}
~~~

V1 在内存中归一化为 requestedRole=role、substitutionReasonCode=null，不回写历史记录。校验替代原因枚举、角色计数、总槽位数和顺序。

- [ ] **Step 5: 运行规划、恢复、物化测试并提交**

~~~bash
node --test server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-materialized-plan.test.mjs server/tests/auto-listing-content-plan-repository.test.mjs
git add server/auto-listing-content-planner.mjs server/auto-listing-fixed-skeleton.mjs server/auto-listing-content-plan-validator.mjs server/auto-listing-materialized-plan.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-materialized-plan.test.mjs server/tests/auto-listing-content-plan-repository.test.mjs
git commit -m "feat: substitute unsupported image roles from product evidence"
~~~

Expected: 保持 8 张、无尺寸伪造、无付费前置调用，V1/V2 均可恢复和物化。

---

## Task 3：让每张图有独立信息任务并应用商品主导的边缘半透明标签

**Files:**

- Modify: server/auto-listing-fixed-skeleton.mjs
- Modify: server/auto-listing-image-generator.mjs
- Modify: server/tests/auto-listing-fixed-skeleton.test.mjs
- Modify: server/tests/auto-listing-image-generator.test.mjs
- Modify: server/tests/auto-listing-configurable-skeleton-e2e.test.mjs

- [ ] **Step 1: 写不重复事实、无文案回退和配置尺寸失败测试**

~~~js
test("does not repeat facts across repeated selling slots", () => {
  const plan = buildFixedSkeleton({ plannerContext: richProductContext });
  const slots = plan.slots.filter((slot) => slot.role === "SELLING_POINT");
  const ids = slots.flatMap((slot) => slot.sourceFactIds);
  assert.equal(new Set(ids).size, ids.length);
});

test("uses copy-free fallback instead of inventing claims", () => {
  const plan = buildFixedSkeleton({ plannerContext: sparseProductContext });
  const slot = plan.slots.find((entry) => entry.claims.length === 0);
  assert.equal(slot.textDensity, "NONE");
  assert.ok(slot.referenceAssetIds.length > 0);
});

test("prompt uses edge glass labels and configured output", async () => {
  await generator.generate(itemWithThreeByFourConfig);
  const prompt = gateway.imageCalls[0].prompt;
  assert.match(prompt, /EDGE_GLASS_LABELS/);
  assert.match(prompt, /0\.80.*0\.94/);
  assert.match(prompt, /maximum 3 label cards/i);
  assert.match(prompt, /configured ratio: 3:4/i);
  assert.doesNotMatch(prompt, /768.?1024/);
});
~~~

- [ ] **Step 2: 运行测试确认重复文案和通用构图仍存在**

~~~bash
node --test server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
~~~

- [ ] **Step 3: 同组事实一次性分配**

~~~js
const freshFacts = roleCandidates.filter((fact) => !usedFactIds.has(fact.factId));
const selectedFacts = takeClaimsForDensity(freshFacts, density);
selectedFacts.forEach((fact) => usedFactIds.add(fact.factId));
const effectiveDensity = selectedFacts.length ? density : "NONE";
const claims = selectedFacts.map((fact) => fact.claimText);
~~~

身份事实可用于商品一致性检查，但不得因此在每张图重复显示商品名。

- [ ] **Step 4: 写入统一视觉契约和角色差异**

~~~js
{
  layoutMode: "EDGE_GLASS_LABELS",
  subject: {
    priority: "DOMINANT",
    frameSharePercent: role === "INFOGRAPHIC" ? [55, 68] : [62, 70],
    preserveShapeColorControls: true,
  },
  labels: {
    anchor: "EDGE_SAFE_ZONE",
    maxCards: 3,
    opacityRange: [0.80, 0.94],
    avoidSubject: true,
    keepReadableAtThumbnail: true,
  },
  composition: roleComposition(slot.role, slot.order),
}
~~~

角色差异必须明确：主图一眼识别商品；卖点图每张讲不同卖点；细节图是真实局部并有指示线；场景图展示真实使用关系；尺寸图只画可信尺寸线；信息图可承载多事实但商品仍主导。所有角色共享类目策略的色彩、字体、光影和标签语言，但不得共享同一构图模板。

- [ ] **Step 5: 验证事实边界、可配置尺寸并提交**

提示词必须说明：只允许 claims/sourceFactIds，不从样本图抄产品事实，不生成未证实尺寸，标签不遮挡商品，同组图片视觉系统一致但构图、角度、信息任务不同。

~~~bash
node --test server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
git add server/auto-listing-fixed-skeleton.mjs server/auto-listing-image-generator.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
git commit -m "feat: apply product-led image composition contract"
~~~

Expected: 3:4、1:1 等测试均使用各自冻结配置，业务代码不含固定 768×1024 假设。

---

## Task 4：区分事实硬失败与表现软问题

**Files:**

- Modify: server/auto-listing-result-checker.mjs
- Modify: server/auto-listing-image-generator.mjs
- Modify: server/auto-listing-review-evidence.mjs
- Modify: server/tests/auto-listing-result-checker.test.mjs
- Modify: server/tests/auto-listing-image-generator.test.mjs
- Modify: server/tests/auto-listing-generation-attempt-repository.test.mjs
- Modify: server/tests/auto-listing-review-service.test.mjs

- [ ] **Step 1: 写软硬边界失败测试**

~~~js
test("hard fact failure never enters review", () => {
  const result = evaluateCheckerResult(unverifiedClaimResult);
  assert.equal(result.accepted, false);
  assert.equal(result.severity, "HARD");
  assert.equal(result.code, "UNVERIFIED_CLAIM");
});

test("third soft failure enters manual review with warning", async () => {
  gateway.queueCheckerResults(styleMismatch, styleMismatch, styleMismatch);
  const asset = await generator.generate(singleSlotContext);
  assert.equal(asset.accepted, true);
  assert.equal(asset.acceptedWithWarnings, true);
  assert.deepEqual(asset.manualReviewWarnings, ["CATEGORY_STYLE_MISMATCH"]);
  assert.equal(gateway.imageCalls.length, 3);
});
~~~

- [ ] **Step 2: 运行测试确认当前检查器只有统一失败**

~~~bash
node --test server/tests/auto-listing-result-checker.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-review-service.test.mjs
~~~

- [ ] **Step 3: 实现窄而明确的严重性映射**

~~~js
const HARD_FAILURES = new Set([
  "PRODUCT_IDENTITY_MISMATCH",
  "UNVERIFIED_CLAIM",
  "LANGUAGE_MISMATCH",
  "PROHIBITED_CONTENT",
  "DIMENSION_ANNOTATION_MISSING",
  "BLUR",
  "CROP",
  "OBSTRUCTION",
  "TEXT_DISTORTION",
]);

const SOFT_FAILURES = new Set([
  "CATEGORY_STYLE_MISMATCH",
  "ROLE_MISMATCH",
  "DETAIL_NOT_CLOSEUP",
  "SUBJECT_NOT_DOMINANT",
  "LABEL_OVERLAP",
  "LABEL_READABILITY_LOW",
]);
~~~

未知失败默认 HARD。第一次、第二次软失败重试；第三次保留图片并写 manualReviewWarnings。硬失败继续按现有主图阻断/非主图跳过规则处理，不能伪装为通过。

- [ ] **Step 4: 加固恢复证据并运行测试**

只有 attemptNo=3、警告属于软失败集合、原始检查证据与警告一致时，恢复逻辑才承认 acceptedWithWarnings，避免伪造通过状态和重复付费调用。

~~~bash
node --test server/tests/auto-listing-result-checker.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-generation-attempt-repository.test.mjs server/tests/auto-listing-review-service.test.mjs
git add server/auto-listing-result-checker.mjs server/auto-listing-image-generator.mjs server/auto-listing-review-evidence.mjs server/tests/auto-listing-result-checker.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-generation-attempt-repository.test.mjs server/tests/auto-listing-review-service.test.mjs
git commit -m "feat: separate hard image failures from review warnings"
~~~

Expected: 硬失败始终阻断；软问题最多生成三次后进入人工审核；任务恢复不重复计费。

---

## Task 5：审核页解释角色替代和警告，并完成代表性流程验证

**Files:**

- Modify: server/auto-listing-review-postgres.mjs
- Modify: server/auto-listing-view.mjs
- Modify: app/src/auto-listing-view.js
- Modify: app/src/AutoListingPage.jsx
- Modify: app/src/auto-listing-page.css
- Modify: server/tests/auto-listing-review-postgres.test.mjs
- Modify: server/tests/auto-listing-view.test.mjs
- Modify: app/tests/auto-listing-view.test.mjs
- Modify: app/tests/auto-listing-review-images.browser.test.mjs

- [ ] **Step 1: 写审核展示失败测试**

~~~js
test("review DTO explains substitutions and warnings", () => {
  const image = reviewDto.images[0];
  assert.equal(image.role, "DETAIL");
  assert.equal(image.requestedRole, "SPECIFICATION");
  assert.equal(image.substitutionReasonCode, "PRODUCT_DIMENSIONS_UNAVAILABLE");
  assert.deepEqual(image.manualReviewWarnings, ["CATEGORY_STYLE_MISMATCH"]);
});
~~~

浏览器测试断言显示“原尺寸图 → 细节图”“缺少可信尺寸，已改用细节图”和橙色“需人工关注”；普通通过图片仍显示绿色“已通过检查”。

- [ ] **Step 2: 运行测试确认审核页缺少解释信息**

~~~bash
node --test server/tests/auto-listing-review-postgres.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-view.test.mjs app/tests/auto-listing-review-images.browser.test.mjs
~~~

- [ ] **Step 3: 从现有 JSONB 读取和展示，不改表结构**

审核查询从 plan.plan->slots 读取 requestedRole/substitutionReasonCode，从 checker_result 读取 manualReviewWarnings。服务端只返回白名单字段：

~~~js
{
  role: "DETAIL",
  roleLabel: "细节图",
  requestedRole: "SPECIFICATION",
  requestedRoleLabel: "尺寸图",
  substitutionReasonCode: "PRODUCT_DIMENSIONS_UNAVAILABLE",
  substitutionReasonLabel: "缺少可信尺寸，已改用细节图",
  manualReviewWarnings: ["CATEGORY_STYLE_MISMATCH"],
}
~~~

前端只显示，不重新判断业务规则。旧 V1 记录缺少新字段时维持原展示。

- [ ] **Step 4: 运行页面与跨模块回归**

~~~bash
node --test server/tests/auto-listing-review-postgres.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-view.test.mjs app/tests/auto-listing-review-images.browser.test.mjs app/tests/auto-listing-task-polling.browser.test.mjs
node --test --test-concurrency=1 server/tests/auto-listing-item-image-config.test.mjs server/tests/auto-listing-content-planner.test.mjs server/tests/auto-listing-fixed-skeleton.test.mjs server/tests/auto-listing-content-plan-validator.test.mjs server/tests/auto-listing-materialized-plan.test.mjs server/tests/auto-listing-image-generator.test.mjs server/tests/auto-listing-result-checker.test.mjs server/tests/auto-listing-review-postgres.test.mjs server/tests/auto-listing-review-service.test.mjs server/tests/auto-listing-view.test.mjs server/tests/auto-listing-configurable-skeleton-e2e.test.mjs
~~~

Expected: 全部通过；审核、重新生成、取消和上传权限边界不变；无新增依赖、数据库迁移或真实 Ozon 写入。

- [ ] **Step 5: 使用代表性商品真实验证到人工审核**

在明确允许本次付费模型调用后，使用 collect_a36df980acc5dd6014663382：

1. 记录点击“创建生成任务”的时间和冻结配置；
2. 确认类目策略、商品事实、角色替代和每张图提示词输入；
3. 跟踪规划、逐图生成、逐图检查，直到“等待审核”；
4. 确认总图数与配置一致，商品主体明显，边缘标签最多 3 个；
5. 确认各角色构图、视角和事实不同，尺寸线只来自可信尺寸；
6. 记录总耗时、模型调用数、重试数和审核警告；
7. 停在人工审核，不点击上传 Ozon。

未到“等待审核”不得宣称完成；保留失败证据，只修复对应批次。

- [ ] **Step 6: 提交本批次**

~~~bash
git add server/auto-listing-review-postgres.mjs server/auto-listing-view.mjs app/src/auto-listing-view.js app/src/AutoListingPage.jsx app/src/auto-listing-page.css server/tests/auto-listing-review-postgres.test.mjs server/tests/auto-listing-view.test.mjs app/tests/auto-listing-view.test.mjs app/tests/auto-listing-review-images.browser.test.mjs
git commit -m "feat: explain image substitutions during manual review"
~~~

---

## Completion Gate

- [ ] 缺少尺寸时保持配置图数，在付费调用前换成有证据的角色。
- [ ] 旧 V1 任务仍能恢复、审核和上传；新 V2 任务携带替代原因。
- [ ] 同组图片共享视觉语言，但角色、构图、视角和事实分工明显不同。
- [ ] 商品主体默认占 62%～70%；标签位于边缘、半透明、不遮挡商品、最多 3 个。
- [ ] 细节图是真实局部特写；尺寸图只有可信尺寸时才带真实标线。
- [ ] 硬失败不能进入审核；连续三次软问题可带警告进入人工审核。
- [ ] 比例和目标尺寸完全来自图片生成配置。
- [ ] 代表性商品真实走到“等待审核”，并记录耗时与调用次数。
- [ ] 未经人工审核不得上传 Ozon。
