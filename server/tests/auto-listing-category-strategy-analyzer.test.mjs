import assert from "node:assert/strict";
import test from "node:test";

import { createCategoryStrategyAnalyzer } from "../auto-listing-category-strategy-analyzer.mjs";

const HASH = "a".repeat(64);
const ACCOUNT = "account-a";
const CONFIG = Object.freeze({
  analyzerVersion: "category-strategy-v1",
  promptVersion: "category-strategy-prompt-v2",
  profileId: "profile-a",
  profileVersion: 7,
  model: "vision-model-a",
});
const ROLES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);

function evidence({ count = 5, imageState = "READY", status = "SAMPLES_READY", draftVersion = 2 } = {}) {
  return {
    accountId: ACCOUNT,
    draftId: "draft-a",
    draftVersion,
    status,
    scope: { accountId: ACCOUNT, taxonomyScope: "OZON:DEFAULT", descriptionCategoryId: 17028922, typeId: 91542 },
    sampleSetId: "sample-set-a",
    sampleSetHash: HASH,
    samples: Array.from({ length: count }, (_, index) => ({
      sampleId: `sample-${index + 1}`,
      sku: `sku-${index + 1}`,
      productFacts: { sku: `sku-${index + 1}` },
      images: [{
        evidenceId: `image-${index + 1}`,
        state: imageState,
        role: "MAIN",
        ordinal: 0,
        analysisObjectKey: `category-strategy/${ACCOUNT}/draft-a/sample-set-a/sample-${index + 1}/analysis.webp`,
        analysisContentHash: HASH,
        contentType: "image/webp",
      }],
    })),
  };
}

function validOutput() {
  const roleGuidance = {};
  for (const role of ROLES) {
    roleGuidance[role] = {
      composition: { ru: `${role} товар по центру`, zh: `${role} 商品居中` },
      background: { ru: "чистый нейтральный фон", zh: "干净的中性背景" },
      textDensity: role === "MAIN" ? "NONE" : "LIGHT",
      layout: { ru: "ясная визуальная иерархия", zh: "清晰的视觉层级" },
      evidenceIds: ["image-1", "image-2"],
      confidence: 0.8,
    };
  }
  return {
    schemaVersion: 3,
    style: { ru: "чистый коммерческий каталог", zh: "干净的商业目录风格" },
    roleGuidance,
    commonPatterns: [{ pattern: { ru: "товар по центру", zh: "商品居中" },
      evidenceIds: ["image-1", "image-2"], confidence: 0.8 }],
    differences: [{ pattern: { ru: "вариант с одним реквизитом", zh: "单个道具变化" },
      evidenceIds: ["image-3"] }],
    cautions: [{ ru: "не копировать товарные знаки", zh: "不要复制品牌标识" }],
  };
}

function makeHarness({ loaded = evidence(), replay = null, reserve = null, aiOutput = validOutput() } = {}) {
  const calls = { replay: [], configure: [], ready: [], load: 0, read: [], reserve: [], analyze: [], recover: [], complete: [], edit: [] };
  const completed = new Map();
  const repository = {
    async getAnalysisReplay(input) { calls.replay.push(input); return replay; },
    async loadAnalysisEvidence() { calls.load += 1; return loaded; },
    async reserveAnalysisAttempt(input) {
      calls.reserve.push(input);
      if (reserve) return reserve(input);
      return { attemptId: "attempt-a", duplicate: false, result: null };
    },
    async completeAnalysisAttempt(input) {
      calls.complete.push(input);
      const result = {
        attemptId: input.attemptId,
        resultId: "result-a",
        status: input.outcome === "ACCEPTED" ? "DRAFT_READY" : "NEEDS_REVIEW",
        draftVersion: 4,
        duplicate: false,
        safeCode: input.safeCode,
        guidance: input.guidance,
        evidenceSummary: input.evidenceSummary,
        editedBy: null,
        editedAt: null,
        baseAnalysisAttemptId: null,
      };
      completed.set(input.attemptId, result);
      return result;
    },
    async appendManualAnalysisResult(input) {
      calls.edit.push(input);
      return {
        attemptId: input.baseAnalysisAttemptId,
        resultId: "manual-result-a",
        status: "DRAFT_READY",
        draftVersion: input.expectedDraftVersion + 1,
        duplicate: false,
        safeCode: null,
        guidance: input.guidance,
        evidenceSummary: null,
        editedBy: input.actorId,
        editedAt: "2026-08-15T02:00:00.000Z",
        baseAnalysisAttemptId: input.baseAnalysisAttemptId,
      };
    },
  };
  const objectStorage = {
    async readObjectExpected(input) { calls.read.push(input); return Buffer.from(`bytes:${input.key}`); },
  };
  const aiAdapter = {
    async assertReady(input) { calls.ready.push(input); },
    async analyze(input) { calls.analyze.push(input); return aiOutput; },
    async recover(input) { calls.recover.push(input); return aiOutput; },
  };
  const configurationResolver = {
    async resolve(input) { calls.configure.push(input); return CONFIG; },
  };
  const analyzer = createCategoryStrategyAnalyzer({ repository, objectStorage, aiAdapter, configurationResolver });
  return { analyzer, calls, repository, completed };
}

function command(overrides = {}) {
  return {
    accountId: ACCOUNT,
    actorId: ACCOUNT,
    draftId: "draft-a",
    costConfirmed: true,
    idempotencyKey: "analysis-a",
    correlationId: "correlation-a",
    ...overrides,
  };
}

test("strict cost confirmation prevents evidence reads, reservations, and paid AI", async () => {
  for (const costConfirmed of [false, null, 1, "true", undefined]) {
    const { analyzer, calls } = makeHarness();
    await assert.rejects(analyzer.analyze(command({ costConfirmed })), {
      code: "AUTO_LISTING_CATEGORY_STRATEGY_COST_CONFIRMATION_REQUIRED",
      status: 409,
    });
    assert.deepEqual({ replay: calls.replay.length, configure: calls.configure.length, ready: calls.ready.length,
      load: calls.load, reserve: calls.reserve.length, analyze: calls.analyze.length },
    { replay: 0, configure: 0, ready: 0, load: 0, reserve: 0, analyze: 0 });
  }
});

test("account-scoped configuration and adapter readiness are resolved before evidence or reservation", async () => {
  const { analyzer, calls } = makeHarness();
  await analyzer.analyze(command());
  assert.deepEqual(calls.configure, [{ accountId: ACCOUNT }]);
  assert.deepEqual(calls.ready, [{ accountId: ACCOUNT, configuration: CONFIG }]);
  assert.equal(calls.load, 1);
  assert.equal(calls.reserve.length, 1);
});

test("fewer than five unique samples or any non-ready image prevents reservation and AI", async () => {
  for (const loaded of [evidence({ count: 4 }), evidence({ imageState: "PENDING" })]) {
    const { analyzer, calls } = makeHarness({ loaded });
    await assert.rejects(analyzer.analyze(command()), {
      code: "AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_EVIDENCE_NOT_READY",
      status: 409,
    });
    assert.equal(calls.reserve.length, 0);
    assert.equal(calls.analyze.length, 0);
  }
});

test("a paid call is made only after durable reservation with a frozen redacted multimodal request", async () => {
  let reserved = false;
  const { analyzer, calls } = makeHarness({
    reserve: () => { reserved = true; return { attemptId: "attempt-a", duplicate: false, result: null }; },
  });
  const result = await analyzer.analyze(command());
  assert.equal(result.status, "DRAFT_READY");
  assert.equal(calls.analyze.length, 1);
  assert.equal(reserved, true);
  const request = calls.analyze[0];
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(Object.keys(request).sort(), [
    "attemptId", "contract", "execution", "images", "productFacts", "requestKey", "scope",
  ]);
  assert.deepEqual(request.execution, { accountId: ACCOUNT, ...CONFIG });
  assert.deepEqual(Object.keys(request.scope).sort(), ["descriptionCategoryId", "taxonomyScope", "typeId"]);
  assert.equal(request.images.length, 5);
  assert.equal(request.images.every((image) => typeof image.bytesBase64 === "string"
    && !Object.hasOwn(image, "url") && !Object.hasOwn(image, "objectKey")), true);
  assert.deepEqual(request.productFacts[0], { sampleId: "sample-1", sku: "sku-1" });
  const serialized = JSON.stringify(request, (_key, value) => Buffer.isBuffer(value) ? "<bytes>" : value);
  for (const forbidden of ["credential", "signedUrl", "analysisObjectKey", "collectEdit", "autoListingTask", "generationReference"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(calls.complete[0].outcome, "ACCEPTED");
  assert.equal(request.contract.schemaVersion, 3);
  assert.equal(calls.complete[0].guidance.overallStyle, "чистый коммерческий каталог");
  assert.equal(calls.complete[0].guidance.roles.MAIN.composition, "MAIN товар по центру");
  assert.equal(calls.complete[0].evidenceSummary.managementZh.guidance.overallStyle,
    "干净的商业目录风格");
  assert.equal(calls.complete[0].evidenceSummary.managementZh.guidance.roles.MAIN.composition,
    "MAIN 商品居中");
  assert.equal(calls.complete[0].evidenceSummary.managementZh.commonPatterns[0], "商品居中");
});

test("a standardized object hash/read failure records NEEDS_REVIEW without AI or a stuck attempt", async () => {
  const { calls } = makeHarness();
  const failingAnalyzer = createCategoryStrategyAnalyzer({
    repository: {
      async getAnalysisReplay() { return null; },
      async loadAnalysisEvidence() { return evidence(); },
      async reserveAnalysisAttempt() { return { attemptId: "attempt-a", duplicate: false, result: null }; },
      async completeAnalysisAttempt(input) {
        calls.complete.push(input);
        return {
          attemptId: input.attemptId, resultId: "result-a", status: "NEEDS_REVIEW", draftVersion: 4,
          duplicate: false, safeCode: input.safeCode, guidance: input.guidance,
          evidenceSummary: null, editedBy: null, editedAt: null, baseAnalysisAttemptId: null,
        };
      },
      async appendManualAnalysisResult() { throw new Error("not used"); },
    },
    objectStorage: { async readObjectExpected() { throw new Error("hash mismatch"); } },
    aiAdapter: {
      async analyze() { calls.analyze.push(1); throw new Error("must not call AI"); },
      async recover() { throw new Error("must not recover"); },
    },
    configurationResolver: { async resolve() { return CONFIG; } },
  });
  const result = await failingAnalyzer.analyze(command());
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_NOT_READY");
  assert.equal(calls.analyze.length, 0);
  assert.equal(calls.complete[0].outcome, "REJECTED");
});

test("a known AI failure is finalized for manual review while only response-unknown stays pending", async () => {
  const { calls } = makeHarness();
  const knownFailure = createCategoryStrategyAnalyzer({
    repository: {
      async getAnalysisReplay() { return null; },
      async loadAnalysisEvidence() { return evidence(); },
      async reserveAnalysisAttempt() { return { attemptId: "attempt-a", duplicate: false, result: null }; },
      async completeAnalysisAttempt(input) {
        calls.complete.push(input);
        return { attemptId: input.attemptId, resultId: "result-a", status: "NEEDS_REVIEW",
          draftVersion: 4, duplicate: false, safeCode: input.safeCode, guidance: input.guidance,
          evidenceSummary: null, editedBy: null, editedAt: null, baseAnalysisAttemptId: null };
      },
      async appendManualAnalysisResult() {},
    },
    objectStorage: { async readObjectExpected() { return Buffer.from("image"); } },
    aiAdapter: {
      async analyze() { throw Object.assign(new Error("definite rejection"), { code: "AI_REQUEST_REJECTED" }); },
      async recover() { throw new Error("not used"); },
    },
    configurationResolver: { async resolve() { return CONFIG; } },
  });
  const result = await knownFailure.analyze(command());
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_CALL_FAILED");
  assert.equal(calls.complete[0].outcome, "REJECTED");
});

test("the multimodal request enforces one aggregate byte budget before AI", async () => {
  const { calls } = makeHarness();
  const large = Buffer.alloc(16 * 1024 * 1024);
  let reads = 0;
  const bounded = createCategoryStrategyAnalyzer({
    repository: {
      async getAnalysisReplay() { return null; },
      async loadAnalysisEvidence() { return evidence(); },
      async reserveAnalysisAttempt() { return { attemptId: "attempt-a", duplicate: false, result: null }; },
      async completeAnalysisAttempt(input) {
        calls.complete.push(input);
        return { attemptId: input.attemptId, resultId: "result-a", status: "NEEDS_REVIEW",
          draftVersion: 4, duplicate: false, safeCode: input.safeCode, guidance: input.guidance,
          evidenceSummary: null, editedBy: null, editedAt: null, baseAnalysisAttemptId: null };
      },
      async appendManualAnalysisResult() {},
    },
    objectStorage: { async readObjectExpected() { reads += 1; return reads < 5 ? large : Buffer.from("x"); } },
    aiAdapter: {
      async analyze() { calls.analyze.push(1); throw new Error("must not call"); },
      async recover() { throw new Error("not used"); },
    },
    configurationResolver: { async resolve() { return CONFIG; } },
  });
  assert.equal((await bounded.analyze(command())).safeCode,
    "AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_NOT_READY");
  assert.equal(calls.analyze.length, 0);
});

test("recommendations and common patterns require evidence from two distinct SKUs", async () => {
  const output = validOutput();
  output.roleGuidance.MAIN.evidenceIds = ["image-1"];
  output.commonPatterns[0].evidenceIds = ["image-2"];
  const { analyzer, calls } = makeHarness({ aiOutput: output });
  const result = await analyzer.analyze(command());
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_INSUFFICIENT");
  assert.equal(calls.complete[0].outcome, "REJECTED");
  assert.equal(calls.complete[0].safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_EVIDENCE_INSUFFICIENT");
  assert.equal(calls.complete[0].guidance.overallStyle, "NEEDS_REVIEW");
});

test("a single-SKU observation is accepted only in differences", async () => {
  const { analyzer, calls } = makeHarness();
  const result = await analyzer.analyze(command());
  assert.equal(result.status, "DRAFT_READY");
  assert.equal(calls.complete[0].evidenceSummary.differences[0].evidenceIds.length, 1);
});

test("swapped AI languages and non-Russian manual execution rules never become publishable guidance", async () => {
  const swapped = validOutput();
  swapped.style = { ru: "中文整体风格", zh: "Русский общий стиль" };
  const rejected = makeHarness({ aiOutput: swapped });
  const result = await rejected.analyzer.analyze(command());
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(result.safeCode, "AUTO_LISTING_CATEGORY_STRATEGY_AI_OUTPUT_INVALID");

  const manual = makeHarness();
  const invalidGuidance = {
    overallStyle: "中文整体风格",
    prohibitedPatterns: ["不要复制品牌标识"],
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      composition: "中文构图", background: "中文背景",
      textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: "中文布局",
    }])),
  };
  await assert.rejects(manual.analyzer.editGuidance({
    accountId: ACCOUNT, actorId: ACCOUNT, draftId: "draft-a", expectedDraftVersion: 4,
    baseAnalysisAttemptId: "attempt-a", guidance: invalidGuidance,
    idempotencyKey: "edit-language-a", correlationId: "correlation-edit-language-a",
  }), { code: "AUTO_LISTING_CATEGORY_STRATEGY_ANALYZER_INVALID" });
  assert.equal(manual.calls.edit.length, 0);
});

test("missing, extra, count, unknown role, unknown evidence, and hostile outputs become fixed NEEDS_REVIEW", async () => {
  const hostile = {};
  let reads = 0;
  Object.defineProperty(hostile, "schemaVersion", { enumerable: true, get() { reads += 1; return 3; } });
  const cases = [
    { ...validOutput(), imageCount: 8 },
    (() => { const value = validOutput(); delete value.roleGuidance.INFOGRAPHIC; return value; })(),
    (() => { const value = validOutput(); value.roleGuidance.UNKNOWN = value.roleGuidance.MAIN; return value; })(),
    (() => { const value = validOutput(); value.roleGuidance.MAIN.evidenceIds = ["image-1", "missing-image"]; return value; })(),
    (() => { const value = validOutput(); value.commonPatterns = Array.from({ length: 11 },
      () => value.commonPatterns[0]); return value; })(),
    hostile,
    new Proxy(validOutput(), { ownKeys() { reads += 1; return []; } }),
  ];
  for (const aiOutput of cases) {
    const { analyzer, calls } = makeHarness({ aiOutput });
    const result = await analyzer.analyze(command());
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.match(result.safeCode, /^AUTO_LISTING_CATEGORY_STRATEGY_AI_/u);
    assert.equal(calls.complete[0].rawResponse.validationStatus, "REJECTED");
    assert.equal(JSON.stringify(calls.complete[0].rawResponse).includes("missing-image"),
      aiOutput === cases[3]);
  }
  assert.equal(reads, 0);
});

test("oversized AI output retains only a bounded fixed backend rejection envelope", async () => {
  const output = validOutput();
  output.cautions = [{ ru: "я".repeat(300_000), zh: "中" }];
  const { analyzer, calls } = makeHarness({ aiOutput: output });
  const result = await analyzer.analyze(command());
  assert.equal(result.status, "NEEDS_REVIEW");
  assert.equal(Buffer.byteLength(JSON.stringify(calls.complete[0].rawResponse)) <= 512, true);
  assert.equal(JSON.stringify(calls.complete[0].rawResponse).includes("xxx"), false);
});

test("the largest accepted bilingual response remains inside both durable 256 KiB boundaries", async () => {
  const loaded = evidence({ count: 20 });
  const evidenceIds = loaded.samples.map((sample, index) => {
    const evidenceId = `image-${index}-${"x".repeat(220)}`;
    sample.images[0].evidenceId = evidenceId;
    return evidenceId;
  });
  const pair = { ru: "я".repeat(500), zh: "中".repeat(500) };
  const output = {
    schemaVersion: 3,
    style: pair,
    roleGuidance: Object.fromEntries(ROLES.map((role) => [role, {
      composition: pair, background: pair, textDensity: role === "MAIN" ? "NONE" : "LIGHT",
      layout: pair, evidenceIds, confidence: 0.8,
    }])),
    commonPatterns: Array.from({ length: 10 }, () => ({ pattern: pair, evidenceIds, confidence: 0.8 })),
    differences: Array.from({ length: 10 }, () => ({ pattern: pair, evidenceIds })),
    cautions: Array.from({ length: 10 }, () => pair),
  };
  const { analyzer, calls } = makeHarness({ loaded, aiOutput: output });
  assert.equal((await analyzer.analyze(command())).status, "DRAFT_READY");
  assert.equal(Buffer.byteLength(JSON.stringify(calls.complete[0].rawResponse)) <= 256 * 1024, true);
  assert.equal(Buffer.byteLength(JSON.stringify(calls.complete[0].evidenceSummary)) <= 256 * 1024, true);
});

test("exact replay returns the durable result without analyze or recover", async () => {
  const durable = {
    attemptId: "attempt-a", resultId: "result-a", status: "DRAFT_READY", draftVersion: 4,
    duplicate: true, safeCode: null,
    guidance: {
      overallStyle: "clean commercial catalogue", prohibitedPatterns: ["avoid copying brand marks"],
      roles: Object.fromEntries(ROLES.map((role) => [role, {
        composition: `${role} centered product`, background: "clean neutral background",
        textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: "clear visual hierarchy",
      }])),
    },
    evidenceSummary: { commonPatterns: [], differences: [], cautions: [] },
    editedBy: null, editedAt: null, baseAnalysisAttemptId: null,
  };
  const { analyzer, calls } = makeHarness({ reserve: () => ({ attemptId: "attempt-a", duplicate: true, result: durable }) });
  assert.deepEqual(await analyzer.analyze(command()), durable);
  assert.equal(calls.analyze.length, 0);
  assert.equal(calls.recover.length, 0);
  assert.equal(calls.complete.length, 0);
});

test("durable result replay does not depend on object storage still being available", async () => {
  const durable = {
    attemptId: "attempt-a", resultId: "result-a", status: "DRAFT_READY", draftVersion: 4,
    duplicate: true, safeCode: null,
    guidance: {
      overallStyle: "clean commercial catalogue", prohibitedPatterns: ["avoid copying brand marks"],
      roles: Object.fromEntries(ROLES.map((role) => [role, {
        composition: `${role} centered product`, background: "clean neutral background",
        textDensity: role === "MAIN" ? "NONE" : "LIGHT", layout: "clear visual hierarchy",
      }])),
    },
    evidenceSummary: { commonPatterns: [], differences: [], cautions: [] },
    editedBy: null, editedAt: null, baseAnalysisAttemptId: null,
  };
  let reads = 0;
  const analyzer = createCategoryStrategyAnalyzer({
    repository: {
      async getAnalysisReplay() { return {
        attemptId: "attempt-a", analysisInputHash: HASH, modelConfigSnapshot: CONFIG,
        sampleSetId: "sample-set-a", sampleSetHash: HASH, result: durable,
      }; },
      async loadAnalysisEvidence() { return evidence(); },
      async reserveAnalysisAttempt() { throw new Error("must not reserve"); },
      async completeAnalysisAttempt() { throw new Error("must not complete"); },
      async appendManualAnalysisResult() { throw new Error("must not edit"); },
    },
    objectStorage: { async readObjectExpected() { reads += 1; throw new Error("storage down"); } },
    aiAdapter: {
      async assertReady() { throw new Error("adapter down"); },
      async analyze() { throw new Error("must not charge"); },
      async recover() { throw new Error("must not recover"); },
    },
    configurationResolver: { async resolve() { throw new Error("profile disabled"); } },
  });
  assert.equal((await analyzer.analyze(command())).resultId, "result-a");
  assert.equal(reads, 0);
});

test("response-loss replay recovers the exact reserved attempt and never blindly recharges", async () => {
  const { analyzer, calls } = makeHarness({
    loaded: evidence({ status: "ANALYZING", draftVersion: 3 }),
    replay: { attemptId: "attempt-a", analysisInputHash: HASH, modelConfigSnapshot: CONFIG,
      sampleSetId: "sample-set-a", sampleSetHash: HASH, result: null },
  });
  const result = await analyzer.analyze(command());
  assert.equal(result.status, "DRAFT_READY");
  assert.equal(calls.analyze.length, 0);
  assert.equal(calls.recover.length, 1);
  assert.deepEqual(calls.recover[0], { attemptId: "attempt-a", requestKey: HASH,
    execution: { accountId: ACCOUNT, ...CONFIG } });
  assert.equal(calls.complete[0].expectedDraftVersion, 3);
});

test("an unknown recovered response keeps the attempt pending and does not write a guessed result", async () => {
  const { calls } = makeHarness({ reserve: () => ({ attemptId: "attempt-a", duplicate: true, result: null }) });
  calls.recover.length = 0;
  const custom = createCategoryStrategyAnalyzer({
    repository: {
      async getAnalysisReplay() { return { attemptId: "attempt-a", analysisInputHash: HASH,
        modelConfigSnapshot: CONFIG, sampleSetId: "sample-set-a", sampleSetHash: HASH, result: null }; },
      async loadAnalysisEvidence() { return evidence(); },
      async reserveAnalysisAttempt() { return { attemptId: "attempt-a", duplicate: true, result: null }; },
      async completeAnalysisAttempt(input) { calls.complete.push(input); },
      async appendManualAnalysisResult() {},
    },
    objectStorage: { async readObjectExpected() { return Buffer.from("image"); } },
    aiAdapter: {
      async analyze() { calls.analyze.push(1); },
      async recover() { throw Object.assign(new Error("unknown"), { code: "AI_RESPONSE_UNKNOWN", retryable: true }); },
    },
    configurationResolver: { async resolve() { return CONFIG; } },
  });
  await assert.rejects(custom.analyze(command()), {
    code: "AUTO_LISTING_CATEGORY_STRATEGY_AI_RESPONSE_UNKNOWN", retryable: true,
  });
  assert.equal(calls.analyze.length, 0);
  assert.equal(calls.complete.length, 0);
});

test("manual edit appends provenance without reading images or calling AI", async () => {
  const { analyzer, calls } = makeHarness();
  const output = validOutput();
  const guidance = {
    overallStyle: output.style.ru,
    prohibitedPatterns: output.cautions.map((entry) => entry.ru),
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      composition: output.roleGuidance[role].composition.ru,
      background: output.roleGuidance[role].background.ru,
      textDensity: output.roleGuidance[role].textDensity,
      layout: output.roleGuidance[role].layout.ru,
    }])),
  };
  const result = await analyzer.editGuidance({
    accountId: ACCOUNT, actorId: ACCOUNT, draftId: "draft-a", expectedDraftVersion: 4,
    baseAnalysisAttemptId: "attempt-a", guidance,
    idempotencyKey: "edit-a", correlationId: "correlation-edit-a",
  });
  assert.equal(result.resultId, "manual-result-a");
  assert.equal(result.editedBy, ACCOUNT);
  assert.equal(result.baseAnalysisAttemptId, "attempt-a");
  assert.deepEqual({ reads: calls.read.length, analyze: calls.analyze.length, recover: calls.recover.length },
    { reads: 0, analyze: 0, recover: 0 });
  assert.equal(calls.edit[0].baseAnalysisAttemptId, "attempt-a");
});
