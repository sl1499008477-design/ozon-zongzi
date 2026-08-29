import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { buildGeneratedAssetObjectKey, normalizeListingImage, sha256 } from "../auto-listing-asset-store.mjs";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";
import { buildImageGenerationInput, generateImageSlot } from "../auto-listing-image-generator.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "main", slotKey: "cover" });
const planHash = "a".repeat(64);
const categoryStyle = Object.freeze({
  overallStyle: "明亮的高级科技产品展示",
  prohibitedPatterns: ["避免竞品标志"],
  role: "MAIN",
  composition: "产品居中，信息层级清晰",
  background: "蓝紫渐变科技背景",
  textDensity: "LIGHT",
  layout: "标题位于上方，产品保持完整可见",
});
const reserved = (attemptNo = 1, generationSize = "768x1024") => ({ status: "RESERVED", attemptNo, leaseToken: "lease-a", generationSize });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};
async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#445566" } }).png().toBuffer(); }
async function setup({ loaderEvidence = "CONTENT_HASH", existing = null } = {}) {
  const bytes = await image(); const asset = { assetId: "asset-a", sourceRef: null, evidenceKind: "CONTENT_HASH", contentHash: sha256(bytes) };
  const fact = { factId: "f1", field: "identity.primaryName", kind: "IDENTITY_NAME", value: "Красный товар", numericValue: null, unit: null, sourcePath: "identity.primaryName" };
  const claim = { text: "Красный товар", sourceFactId: "f1", field: fact.field, value: fact.value, numericValue: null, unit: null };
  let gatewayCalls = 0; let loaderCalls = 0; let objectBytes = (await normalizeListingImage({ bytes, ratio: "3:4", resolution: "1K" })).bytes; const calls = []; const bindCalls = []; const reserveInputs = [];
  const input = {
    scope, plan: { id: scope.planId, jobId: scope.jobId, itemId: scope.itemId, sourceAccountId: scope.accountId, profileId: "profile-a", profileVersion: 3, plannerModel: "checker", promptTemplateVersion: "image-v1", planHash, sourceHash: "b".repeat(64), strategyHash: "c".repeat(64), configHash: "d".repeat(64), visualGroupsHash: "e".repeat(64), visualGroups: { groups: [{ visualGroupKey: "main", referenceImages: [asset] }] }, plan: { slots: [{ slotKey: "cover", visualGroupKey: "main", role: "MAIN", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: ["asset-a"] }] }, factRegistry: [{ ...fact, visualGroupKeys: ["main"] }] },
    slot: { slotKey: "cover", visualGroupKey: "main", role: "MAIN", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: ["asset-a"] }, categoryStyle: null, profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3, textModel: "checker", imageModel: "image-model" }, imageModel: "image-model", ratio: "3:4", resolution: "1K", size: "768x1024", quality: "high", templateVersion: "image-v1",
    sourceAssetLoader: { async loadSourceAsset(request) { loaderCalls += 1; assert.equal(request.sourceRef, asset.sourceRef); return { assetId: asset.assetId, sourceRef: asset.sourceRef, evidenceKind: loaderEvidence, bytes, contentType: "image/png", width: 768, height: 1024 }; } },
    repository: {
      async reserveGenerationAttempt(value) { reserveInputs.push(value); return existing ? { status: "EXISTING_ACCEPTED", record: existing } : reserved(); },
      async bindGenerationAttemptInput(value) { bindCalls.push(value); return { status: "BOUND", inputHash: value.inputHash }; },
      async findStoredGenerationAsset() { return null; }, async recordAssetCleanupRequired(value) { return value; },
      async revertStoredGenerationAsset() { return { disposition: "REVERTED" }; },
      async recordStoredGenerationAsset(value) { calls.push(["stored", value]); return value; }, async completeGenerationAttempt(value) { calls.push(["complete", value]); return { status: "ACCEPTED", accepted: true, ...value }; }, async rejectGenerationAttempt(value) { calls.push(["rejected", value]); },
      async failGenerationAttempt(value) { calls.push(["failed", value]); }, async releaseGenerationLease(value) { calls.push(["release", value]); },
      async blockItem() {}, async countAcceptedAssets() { return 0; },
    },
    storage: { async putObjectFromBuffer(value) { objectBytes = Buffer.from(value.buffer); return { key: value.key, sha256: sha256(value.buffer), contentType: value.contentType, size: value.buffer.length }; }, async getObjectBuffer() { return objectBytes; } },
    gateway: { async generateImage(request) { gatewayCalls += 1; assert.equal(Object.hasOwn(request, "timeoutMs"), false); assert.equal(request.idleTimeoutMs, 300_000); assert.doesNotMatch(request.prompt, /https:\/\//); assert.equal(request.sourceImages[0].bytes.equals(bytes), true); return { bytes, requestId: "generate-1", modelEvidence: { requestedImageModel: "image-model", gatewayReportedImageModel: "image-model", gatewayReportedImageModelPresent: true, orchestratorModel: "" } }; }, async inspectImage(request) { const styleIds = request.prompt.includes("categoryStyleReferenceEvidenceIds") ? fixtureStyleIds(request.prompt) : []; return { requestId: "check-1", modelEvidence: { requestedTextModel: "checker", gatewayReportedTextModel: "checker", gatewayReportedTextModelPresent: true }, value: { matchesProduct: true, matchesCategoryStyle: true, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: [], evidence: { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, categoryStyle: { matches: true, referenceEvidenceIds: styleIds }, claims: [claim], detectedTexts: ["товар"], language: "ru", qualityFlags: [], prohibitedFlags: [] } } }; } },
  };
  return { input, calls, bindCalls, reserveInputs, bytes, asset, fact, claim, gatewayCalls: () => gatewayCalls, loaderCalls: () => loaderCalls };
}

function checkerResponse(fixture, overrides = {}, evidenceOverrides = {}) {
  return {
    requestId: "check-1",
    modelEvidence: { requestedTextModel: "checker", gatewayReportedTextModel: "checker", gatewayReportedTextModelPresent: true },
    value: {
      matchesProduct: true,
      matchesCategoryStyle: true,
      claimsVerified: true,
      russianText: true,
      quality: "PASS",
      prohibitedContent: false,
      reasons: [],
      evidence: {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
        categoryStyle: { matches: true, referenceEvidenceIds: [] },
        claims: [fixture.claim],
        detectedTexts: ["товар"],
        language: "ru",
        qualityFlags: [],
        prohibitedFlags: [],
        ...evidenceOverrides,
      },
      ...overrides,
    },
  };
}

function fixtureStyleIds(prompt) {
  const line = prompt.split("\n").find((entry) => entry.startsWith("{") && entry.includes("categoryStyleReferenceEvidenceIds"));
  return line ? JSON.parse(line).categoryStyleReferenceEvidenceIds : [];
}

test("generates an accepted slot from server-loaded bytes and does not expose source URLs", async () => {
  const fixture = await setup();
  const previews = [];
  fixture.input.cacheReviewPreview = async (value) => { previews.push(value); };
  fixture.input.gatewayExecution = {
    channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9, idleTimeoutMs: 300_000,
  };
  const result = await generateImageSlot(fixture.input);
  assert.equal(result.accepted, true); assert.equal(fixture.gatewayCalls(), 1);
  assert.equal(result.objectKeyVersion, "ATTEMPT_V2");
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
  assert.equal(fixture.reserveInputs[0].gatewayConnectionId, "connection-b");
  assert.equal(fixture.reserveInputs[0].gatewayConnectionVersion, 9);
  assert.equal(fixture.calls[1][1].checkerConnectionId, "connection-b");
  assert.equal(fixture.calls[1][1].checkerConnectionVersion, 9);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].contentHash, result.contentHash);
  assert.equal(crypto.createHash("sha256").update(previews[0].bytes).digest("hex"), result.contentHash);
});

test("a local review-preview cache failure never changes an accepted generation result", async () => {
  const fixture = await setup();
  let attempts = 0;
  fixture.input.cacheReviewPreview = async () => { attempts += 1; throw new Error("local preview cache unavailable"); };

  const result = await generateImageSlot(fixture.input);

  assert.equal(result.accepted, true);
  assert.equal(attempts, 1);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
});

test("passes the frozen category style for the current image role to the final image prompt", async () => {
  const fixture = await setup();
  fixture.input.categoryStyle = categoryStyle;
  let promptPayload;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    const jsonLine = request.prompt.split("\n").find((line) => line.startsWith("{"));
    promptPayload = JSON.parse(jsonLine);
    return generate(request);
  };

  await generateImageSlot(fixture.input);

  assert.deepEqual(promptPayload.categoryStyle, categoryStyle);
  assert.equal(promptPayload.categoryStyle.role, fixture.input.slot.role);
  assert.equal(promptPayload.categoryStyle.textDensity, fixture.input.slot.textDensity);
  assert.equal(promptPayload.facts[0].value, fixture.fact.value);
});

test("sends cited category samples after product references without treating them as product facts", async () => {
  const fixture = await setup();
  fixture.input.categoryStyle = categoryStyle;
  const styleA = await sharp({ create: { width: 900, height: 1200, channels: 4, background: "#cc3366" } }).webp().toBuffer();
  const styleB = await sharp({ create: { width: 1200, height: 1200, channels: 4, background: "#3366cc" } }).webp().toBuffer();
  fixture.input.categoryStyleReferences = [
    { evidenceId: "sample-style-a", sku: "sample-sku-a", objectKey: "category-strategy/account-a/draft-a/set-a/sample-a/style-a.webp", contentHash: sha256(styleA), contentType: "image/webp", width: 900, height: 1200 },
    { evidenceId: "sample-style-b", sku: "sample-sku-b", objectKey: "category-strategy/account-a/draft-a/set-a/sample-b/style-b.webp", contentHash: sha256(styleB), contentType: "image/webp", width: 1200, height: 1200 },
  ];
  const readGenerated = fixture.input.storage.getObjectBuffer;
  fixture.input.storage.getObjectBuffer = async (key, options) => {
    if (key.endsWith("style-a.webp")) return styleA;
    if (key.endsWith("style-b.webp")) return styleB;
    return readGenerated(key, options);
  };
  let request;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (value) => {
    request = value;
    return generate(value);
  };

  await generateImageSlot(fixture.input);

  assert.equal(request.sourceImages.length, 3);
  assert.equal(request.sourceImages[0].bytes.equals(fixture.bytes), true);
  assert.equal(request.sourceImages[1].bytes.equals(styleA), true);
  assert.equal(request.sourceImages[2].bytes.equals(styleB), true);
  assert.match(request.prompt, /前 1 张图片是当前商品真实性参考/u);
  assert.match(request.prompt, /后 2 张图片是类目风格参考/u);
  assert.match(request.prompt, /sample-style-a/u);
  assert.match(request.prompt, /sample-style-b/u);
  assert.doesNotMatch(request.prompt, /category-strategy\//u);
});

test("V3 generation prompt separates contextual props from unsupported product claims", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{ text: "Красный товар", claimType: "IDENTITY_NAME", sourceFactIds: ["f1"] }];
  fixture.input.categoryStyle = {
    ...categoryStyle,
    composition: "商品旁边放手机、语音助手和 Wi-Fi 图标",
  };
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  let prompt;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    prompt = request.prompt;
    return generate(request);
  };

  await generateImageSlot(fixture.input);

  assert.match(prompt, /文案只能逐字使用 slot\.claims\[\]\.text/u);
  assert.match(prompt, /手机界面、礼盒、赠品和包装不能被复制成商品事实/u);
  assert.match(prompt, /允许使用能辅助展示商品功能的环境物品/u);
  assert.match(prompt, /不得把环境物品排成随附套装/u);
  assert.match(prompt, /四周至少保留 10% 的安全边距/u);
  assert.match(prompt, /商品主体和全部文案必须完整位于安全区内/u);
  assert.match(prompt, /不得通过文字或新道具暗示/u);
  assert.match(prompt, /类目风格.*不是当前商品事实/u);
  assert.match(prompt, /手机、语音助手、兼容性图标/u);
  assert.match(prompt, /允许出现的全部营销文案逐字白名单：\["Красный товар"\]/u);
  assert.match(prompt, /白名单之外的来源图文字.*必须删除/u);
  assert.match(prompt, /REFERENCE IMAGE IS PHYSICAL-PRODUCT EVIDENCE ONLY/u);
  assert.match(prompt, /Do not copy promotional text, warranty, discount, gift, phone UI or compatibility icons/u);
  assert.match(prompt, /FINAL HARD CONSTRAINT: render no editable marketing text except the exact whitelist/u);
  assert.equal(prompt.split("\n").at(-1).startsWith("FINAL HARD CONSTRAINT:"), true);
});

test("V5 detail generation receives a concrete close-up brief instead of only a role name", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V5";
  fixture.input.scope = { ...fixture.input.scope, slotKey: "main:detail:01" };
  fixture.input.slot = {
    ...fixture.input.slot,
    slotKey: "main:detail:01",
    role: "DETAIL",
    textDensity: "LIGHT",
    claims: [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }],
  };
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
  let generationPayload;
  let checkerPrompt;
  const generate = fixture.input.gateway.generateImage;
  const inspect = fixture.input.gateway.inspectImage;
  fixture.input.gateway.generateImage = async (request) => {
    generationPayload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };
  fixture.input.gateway.inspectImage = async (request) => {
    checkerPrompt = request.prompt;
    return inspect(request);
  };

  await generateImageSlot(fixture.input);

  assert.deepEqual(generationPayload.visualBrief, {
    role: "DETAIL",
    compositionVariant: "DETAIL_MACRO_01",
    productView: "局部微距特写，不使用完整商品主图式构图",
    subjectScale: "目标细节占画面 70% 至 90%",
    annotationMode: "CALLOUT_LINES",
    requiredClaimTexts: [fixture.fact.value],
  });
  assert.match(checkerPrompt, /DETAIL_MACRO_01/u);
  assert.match(checkerPrompt, /局部微距特写/u);
});

test("V6 prompt uses the universal product-led edge-label contract and configured output size", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{
    text: fixture.fact.value,
    claimType: fixture.fact.kind,
    sourceFactIds: [fixture.fact.factId],
  }];
  fixture.input.slot.sourceFactIds = [fixture.fact.factId];
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  fixture.input.size = "960x1280";
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(1, fixture.input.size);
  let payload;
  let prompt;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    prompt = request.prompt;
    payload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };

  await generateImageSlot(fixture.input);

  assert.equal(payload.visualBrief.layoutMode, "EDGE_GLASS_LABELS");
  assert.deepEqual(payload.visualBrief.subject.frameSharePercent, [55, 68]);
  assert.deepEqual(payload.visualBrief.labels, {
    anchor: "EDGE_SAFE_ZONE",
    maxCards: 4,
    opacityRange: [0.8, 0.94],
    avoidSubject: true,
    keepReadableAtThumbnail: true,
    presentation: "ICON_TEXT_CHIP",
    iconRule: "每条卖点使用与事实语义对应的简洁线性图标；图标不能暗示未验证功能",
  });
  assert.deepEqual(payload.visualBrief.output, {
    ratio: "3:4",
    resolution: "1K",
    targetSize: "960x1280",
  });
  assert.match(prompt, /同组图片.*构图、视角和信息任务必须不同/u);
  assert.match(prompt, /主图最多 4 个图标\+短文字卖点/u);
});

test("V6 image generation limits checker claim evidence to the slot's planned facts", async () => {
  const fixture = await setup();
  const equivalent = {
    factId: "f2", field: "attributes[0].values[0]", kind: "ATTRIBUTE:product-type",
    value: fixture.fact.value, numericValue: null, unit: null,
    sourcePath: "attributes[0].values[0]", visualGroupKeys: ["main"],
  };
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.slot.claims = [{
    text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId],
  }];
  fixture.input.slot.sourceFactIds = [fixture.fact.factId, equivalent.factId];
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.factRegistry.push(equivalent);
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  let checkerSchema;
  const inspect = fixture.input.gateway.inspectImage;
  fixture.input.gateway.inspectImage = async (request) => {
    checkerSchema = request.jsonSchema;
    return inspect(request);
  };

  await generateImageSlot(fixture.input);

  assert.deepEqual(
    checkerSchema.properties.evidence.properties.claims.items.properties.sourceFactId.enum,
    [fixture.fact.factId],
  );
});

test("V5 specification becomes a product documentary image with optional verified facts", async () => {
  const fixture = await setup();
  const fact = {
    factId: "fact.attribute.dimensions",
    field: "attributes[20].values[0]",
    kind: "ATTRIBUTE:dimensions",
    value: "Размер (ДхШхВ), см: 19×14×5",
    numericValue: null,
    unit: null,
    sourcePath: "attributes[20].values[0]",
  };
  const claim = {
    text: fact.value,
    sourceFactId: fact.factId,
    field: fact.field,
    value: fact.value,
    numericValue: null,
    unit: null,
  };
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V5";
  fixture.input.scope = { ...fixture.input.scope, slotKey: "main:specification:01" };
  fixture.input.slot = {
    ...fixture.input.slot,
    slotKey: "main:specification:01",
    role: "SPECIFICATION",
    textDensity: "MEDIUM",
    claims: [{ text: claim.text, claimType: fact.kind, sourceFactIds: [fact.factId] }],
  };
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.factRegistry = [{ ...fact, visualGroupKeys: ["main"] }];
  fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
  let generationPayload;
  let checkerPrompt;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    generationPayload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };
  fixture.input.gateway.inspectImage = async (request) => {
    checkerPrompt = request.prompt;
    return checkerResponse(fixture, {}, {
      claims: [claim],
      detectedTexts: [claim.text],
    });
  };

  await generateImageSlot(fixture.input);

  assert.equal(generationPayload.visualBrief.annotationMode, "PRODUCT_DOCUMENTARY_FACTS");
  assert.match(generationPayload.visualBrief.factPresentation, /可信尺寸或配件/u);
  assert.match(generationPayload.visualBrief.productView, /产品实拍/u);
  assert.deepEqual(generationPayload.visualBrief.requiredClaimTexts, [claim.text]);
  assert.match(checkerPrompt, /产品实拍图/u);
});

test("V6 product documentary with trusted dimensions requires endpoint dimension lines", async () => {
  const fixture = await setup();
  const fact = {
    factId: "fact.dimension.length",
    field: "productMeasurements.length",
    kind: "DIMENSION_LENGTH",
    value: "Длина, см: 104",
    numericValue: 104,
    unit: "см",
    sourcePath: "productMeasurements.length",
  };
  const claim = {
    text: fact.value,
    sourceFactId: fact.factId,
    field: fact.field,
    value: fact.value,
    numericValue: fact.numericValue,
    unit: fact.unit,
  };
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.scope = { ...fixture.input.scope, slotKey: "main:specification:01" };
  fixture.input.slot = {
    ...fixture.input.slot,
    slotKey: "main:specification:01",
    role: "SPECIFICATION",
    textDensity: "MEDIUM",
    claims: [{ text: claim.text, claimType: fact.kind, sourceFactIds: [fact.factId] }],
  };
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.factRegistry = [{ ...fact, visualGroupKeys: ["main"] }];
  fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
  let generationPayload;
  let checkerPrompt;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    generationPayload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };
  fixture.input.gateway.inspectImage = async (request) => {
    checkerPrompt = request.prompt;
    return checkerResponse(fixture, {}, { claims: [claim], detectedTexts: [claim.text] });
  };

  await generateImageSlot(fixture.input);

  assert.equal(generationPayload.visualBrief.annotationMode, "PRODUCT_DOCUMENTARY_DIMENSIONS");
  assert.equal(generationPayload.visualBrief.backgroundMode, "PURE_WHITE");
  assert.match(generationPayload.visualBrief.background, /#FFFFFF/u);
  assert.deepEqual(generationPayload.visualBrief.dimensionClaimTexts, [claim.text]);
  assert.match(generationPayload.visualBrief.factPresentation, /尺寸标线/u);
  assert.match(generationPayload.visualBrief.factPresentation, /端点/u);
  assert.match(checkerPrompt, /每项可信尺寸/u);
  assert.match(checkerPrompt, /DIMENSION_ANNOTATION_MISSING/u);
  assert.match(checkerPrompt, /纯白背景/u);
});

test("V6 product documentary does not require dimension lines for non-dimension facts", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.scope = { ...fixture.input.scope, slotKey: "main:specification:01" };
  fixture.input.slot = {
    ...fixture.input.slot,
    slotKey: "main:specification:01",
    role: "SPECIFICATION",
    textDensity: "LIGHT",
    claims: [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }],
  };
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
  let generationPayload;
  let checkerPrompt;
  const generate = fixture.input.gateway.generateImage;
  const inspect = fixture.input.gateway.inspectImage;
  fixture.input.gateway.generateImage = async (request) => {
    generationPayload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };
  fixture.input.gateway.inspectImage = async (request) => {
    checkerPrompt = request.prompt;
    return inspect(request);
  };

  await generateImageSlot(fixture.input);

  assert.equal(generationPayload.visualBrief.annotationMode, "PRODUCT_DOCUMENTARY_FACTS");
  assert.equal(Object.hasOwn(generationPayload.visualBrief, "dimensionClaimTexts"), false);
  assert.doesNotMatch(checkerPrompt, /每项可信尺寸/u);
});

test("V6 product documentary prompt allows clearly contextual demonstration objects", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.scope = { ...fixture.input.scope, slotKey: "main:specification:01" };
  fixture.input.slot = {
    ...fixture.input.slot,
    slotKey: "main:specification:01",
    role: "SPECIFICATION",
    textDensity: "NONE",
    claims: [],
  };
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
  let prompt;
  let payload;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => {
    prompt = request.prompt;
    payload = JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{")));
    return generate(request);
  };
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, {
    claims: [], detectedTexts: [],
  });

  await generateImageSlot(fixture.input);

  assert.equal(payload.visualBrief.annotationMode, "PRODUCT_DOCUMENTARY_PLAIN");
  assert.match(payload.visualBrief.productView, /单独、清晰地展示商品/u);
  assert.match(prompt, /允许使用能辅助展示商品功能的环境物品/u);
  assert.match(prompt, /不得把环境物品排成随附套装/u);
});

test("V5 repeated selling-point slots receive distinct shot assignments", async () => {
  const briefs = [];
  for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
    const fixture = await setup();
    const suffix = String(occurrence).padStart(2, "0");
    const slotKey = `main:selling-point:${suffix}`;
    fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V5";
    fixture.input.scope = { ...fixture.input.scope, slotKey };
    fixture.input.slot = {
      ...fixture.input.slot,
      slotKey,
      role: "SELLING_POINT",
      textDensity: "LIGHT",
      claims: [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }],
    };
    fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
    fixture.input.plan.plan.slots = [structuredClone(fixture.input.slot)];
    const generate = fixture.input.gateway.generateImage;
    fixture.input.gateway.generateImage = async (request) => {
      briefs.push(JSON.parse(request.prompt.split("\n").find((line) => line.startsWith("{"))).visualBrief);
      return generate(request);
    };
    await generateImageSlot(fixture.input);
  }

  assert.equal(new Set(briefs.map(({ compositionVariant }) => compositionVariant)).size, 3);
  assert.equal(new Set(briefs.map(({ productView }) => productView)).size, 3);
});

test("V3 does not require Russian text when the slot has no allowed copy", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V3";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot = { ...fixture.input.slot, textDensity: "LIGHT", claims: [] };
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  let reservationInput;
  fixture.input.repository.reserveGenerationAttempt = async (value) => {
    reservationInput = value;
    return reserved();
  };
  fixture.input.gateway.inspectImage = async () => ({
    requestId: "check-no-copy",
    modelEvidence: {
      requestedTextModel: "checker",
      gatewayReportedTextModel: "checker",
      gatewayReportedTextModelPresent: true,
    },
    value: {
      matchesProduct: true,
      matchesCategoryStyle: true,
      claimsVerified: true,
      russianText: false,
      quality: "PASS",
      prohibitedContent: false,
      reasons: [],
      evidence: {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
        categoryStyle: { matches: true, referenceEvidenceIds: [] },
        claims: [],
        detectedTexts: [],
        language: "other",
        qualityFlags: [],
        prohibitedFlags: [],
      },
    },
  });

  const result = await generateImageSlot(fixture.input);

  assert.equal(result.accepted, true);
  assert.equal(result.checkerEvidence.textRequired, false);
  assert.equal(result.checkerEvidence.textForbidden, true);
  assert.equal("legacyAttemptIdentityHash" in reservationInput, false);
});

test("rejects a pure SOURCE_URL before reservation, loading, gateway, or storage", async () => {
  const fixture = await setup();
  Object.assign(fixture.asset, { evidenceKind: "SOURCE_URL", sourceRef: "https://private.example.test/source.png" });
  delete fixture.asset.contentHash;
  const effects = [];
  fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); };
  fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); };
  fixture.input.gateway.generateImage = async () => { effects.push("gateway"); };
  fixture.input.storage.putObjectFromBuffer = async () => { effects.push("storage"); };
  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED" && error?.retryable === false,
  );
  assert.deepEqual(effects, []);
});

test("accepts only CONTENT_HASH source references before every repository, loader, gateway, or storage effect", async () => {
  for (const evidenceKind of ["SOURCE_REF_HASH", "UNKNOWN_EVIDENCE"]) {
    const fixture = await setup();
    Object.assign(fixture.asset, { evidenceKind, sourceRef: null, contentHash: sha256(fixture.bytes) });
    const effects = [];
    fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); };
    fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); };
    fixture.input.gateway.generateImage = async () => { effects.push("gateway"); };
    fixture.input.storage.putObjectFromBuffer = async () => { effects.push("storage"); };
    await assert.rejects(
      generateImageSlot(fixture.input),
      (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_NOT_MATERIALIZED" && error?.retryable === false,
      evidenceKind,
    );
    assert.deepEqual(effects, [], evidenceKind);
  }
});

test("reserves the exact validated generation size before loading immutable source bytes", async () => {
  const fixture = await setup();
  let reservationInput;
  fixture.input.repository.reserveGenerationAttempt = async (value) => {
    reservationInput = value;
    return reserved();
  };
  await generateImageSlot(fixture.input);
  assert.equal(reservationInput.generationSize, "768x1024");
});

test("rejects a reserved reply whose generation size is missing or changed before source loading", async () => {
  for (const returnedSize of [undefined, "900x1200"]) {
    const fixture = await setup();
    fixture.input.repository.reserveGenerationAttempt = async () => {
      const reply = reserved();
      if (returnedSize === undefined) delete reply.generationSize;
      else reply.generationSize = returnedSize;
      return reply;
    };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_RESERVATION_FAILED" && error?.retryable === true);
    assert.equal(fixture.loaderCalls(), 0);
    assert.equal(fixture.gatewayCalls(), 0);
    assert.deepEqual(fixture.calls, []);
  }
});

test("reuses a fully audited accepted attempt for the same slot and input without an image call", async () => {
  const first = await setup();
  const accepted = await generateImageSlot(first.input);
  const replay = await setup({ existing: { ...accepted, status: "ACCEPTED" } });
  const reused = await generateImageSlot(replay.input);
  assert.equal(reused.status, "ACCEPTED");
  assert.equal(replay.loaderCalls(), 0);
  assert.equal(replay.gatewayCalls(), 0);
});

test("pure accepted-asset evidence verification rejects every incomplete or cross-bound Task 4 audit", async () => {
  const { verifyAcceptedGeneratedAssetEvidence } = await import("../auto-listing-image-generator.mjs");
  assert.equal(typeof verifyAcceptedGeneratedAssetEvidence, "function");
  const fixture = await setup();
  const accepted = structuredClone(await generateImageSlot(fixture.input));
  const verification = {
    record: accepted,
    scope: fixture.input.scope,
    plan: fixture.input.plan,
    slot: fixture.input.slot,
    profile: fixture.input.profile,
    imageModel: fixture.input.imageModel,
    templateVersion: fixture.input.templateVersion,
  };
  assert.equal(verifyAcceptedGeneratedAssetEvidence(verification), true);

  const corruptions = [
    ({ plan }) => { plan.plan = { slots: [] }; },
    ({ record }) => { record.accountId = "account-b"; },
    ({ record }) => { record.visualGroupKey = "other-group"; },
    ({ record }) => { record.slotKey = "other-slot"; },
    ({ record }) => { record.role = "DETAIL"; },
    ({ record }) => { record.planHash = "0".repeat(64); },
    ({ record }) => { record.sourceHash = "0".repeat(64); },
    ({ record }) => { record.strategyHash = "0".repeat(64); },
    ({ record }) => { record.configHash = "0".repeat(64); },
    ({ record }) => { record.visualGroupsHash = "0".repeat(64); },
    ({ record }) => { record.profileId = "profile-b"; },
    ({ record }) => { record.profileVersion = 4; },
    ({ record }) => { record.modelName = "other-image-model"; },
    ({ record }) => { record.promptTemplateVersion = "other-template"; },
    ({ record }) => { record.objectKey = `${record.objectKey}.forged`; },
    ({ record }) => { record.objectKeyVersion = "UNKNOWN"; },
    ({ record }) => { record.sourceAssetEvidence[0].contentHash = "0".repeat(64); },
    ({ record }) => { record.checkerEvidence.sourceAssets[0].contentHash = "0".repeat(64); },
    ({ record }) => { record.checkerEvidence.checkerResult.evidence.identity.sourceAssetIds = ["other-source"]; },
    ({ record }) => { record.checkerEvidence.checkerResult.matchesProduct = false; },
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(verification);
    corrupt(candidate);
    assert.equal(verifyAcceptedGeneratedAssetEvidence(candidate), false);
  }

  const legacy = structuredClone(verification);
  legacy.record.objectKeyVersion = null;
  const segments = [legacy.record.accountId, legacy.record.jobId, legacy.record.itemId, legacy.record.planId, legacy.record.visualGroupKey, legacy.record.slotKey]
    .map((value) => Buffer.from(value).toString("base64url"));
  legacy.record.objectKey = `auto-listing/${segments.join("/")}/${legacy.record.inputHash}/${legacy.record.contentHash}.png`;
  assert.equal(verifyAcceptedGeneratedAssetEvidence(legacy), true);
  legacy.record.objectKey = `${legacy.record.objectKey}.forged`;
  assert.equal(verifyAcceptedGeneratedAssetEvidence(legacy), false);
});

test("V6 accepted replay canonicalizes only redundant checker claim projection", async () => {
  const { verifyAcceptedGeneratedAssetEvidence } = await import("../auto-listing-image-generator.mjs");
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{
    text: fixture.claim.text,
    claimType: fixture.fact.kind,
    sourceFactIds: [fixture.fact.factId],
  }];
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  const accepted = structuredClone(await generateImageSlot(fixture.input));
  const verification = {
    record: accepted,
    scope: fixture.input.scope,
    plan: fixture.input.plan,
    slot: fixture.input.slot,
    profile: fixture.input.profile,
    imageModel: fixture.input.imageModel,
    templateVersion: fixture.input.templateVersion,
  };

  verification.record.checkerEvidence.checkerResult.evidence.claims[0].field = "identity.primaryName#legacy-projection";
  assert.equal(verifyAcceptedGeneratedAssetEvidence(verification), true);

  verification.record.checkerEvidence.checkerResult.evidence.claims[0].text = "Синий товар";
  assert.equal(verifyAcceptedGeneratedAssetEvidence(verification), false);
});

test("pure accepted-asset evidence verification recomputes both frozen generation identities", async () => {
  const { verifyAcceptedGeneratedAssetEvidence } = await import("../auto-listing-image-generator.mjs");
  const fixture = await setup();
  const accepted = structuredClone(await generateImageSlot(fixture.input));
  const verification = {
    record: accepted,
    scope: fixture.input.scope,
    plan: fixture.input.plan,
    slot: fixture.input.slot,
    profile: fixture.input.profile,
    imageModel: fixture.input.imageModel,
    templateVersion: fixture.input.templateVersion,
  };

  for (const corrupt of [
    (record) => { record.inputHash = "1".repeat(64); },
    (record) => { record.attemptIdentityHash = "2".repeat(64); },
    (record) => { record.inputHash = "3".repeat(64); record.attemptIdentityHash = "4".repeat(64); },
  ]) {
    const forged = structuredClone(verification);
    corrupt(forged.record);
    forged.record.objectKey = buildGeneratedAssetObjectKey(forged.record);
    assert.equal(verifyAcceptedGeneratedAssetEvidence(forged), false);
  }

  const forgedLegacy = structuredClone(verification);
  forgedLegacy.record.inputHash = "5".repeat(64);
  forgedLegacy.record.attemptIdentityHash = "6".repeat(64);
  forgedLegacy.record.objectKeyVersion = null;
  const segments = [forgedLegacy.record.accountId, forgedLegacy.record.jobId, forgedLegacy.record.itemId,
    forgedLegacy.record.planId, forgedLegacy.record.visualGroupKey, forgedLegacy.record.slotKey]
    .map((value) => Buffer.from(value).toString("base64url"));
  forgedLegacy.record.objectKey = `auto-listing/${segments.join("/")}/${forgedLegacy.record.inputHash}/${forgedLegacy.record.contentHash}.png`;
  assert.equal(verifyAcceptedGeneratedAssetEvidence(forgedLegacy), false);
});

test("replays an immutable pre-030 accepted object with null version only through the exact legacy key", async () => {
  const first = await setup();
  const accepted = structuredClone(await generateImageSlot(first.input));
  accepted.status = "ACCEPTED";
  accepted.objectKeyVersion = null;
  const segments = [accepted.accountId, accepted.jobId, accepted.itemId, accepted.planId, accepted.visualGroupKey, accepted.slotKey]
    .map((value) => Buffer.from(value).toString("base64url"));
  accepted.objectKey = `auto-listing/${segments.join("/")}/${accepted.inputHash}/${accepted.contentHash}.png`;
  const replay = await setup({ existing: accepted });
  const reused = await generateImageSlot(replay.input);
  assert.equal(reused.objectKey, accepted.objectKey);
  assert.equal(reused.objectKeyVersion, null);
  assert.equal(replay.loaderCalls(), 0);
  assert.equal(replay.gatewayCalls(), 0);

  const corrupt = await setup({ existing: { ...accepted, objectKey: `${accepted.objectKey}.wrong` } });
  await assert.rejects(generateImageSlot(corrupt.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(corrupt.loaderCalls(), 0);
  assert.equal(corrupt.gatewayCalls(), 0);
});

test("pure verification accepts the exact pre-category-style generation hashes", async () => {
  const { verifyAcceptedGeneratedAssetEvidence } = await import("../auto-listing-image-generator.mjs");
  const fixture = await setup();
  const accepted = structuredClone(await generateImageSlot(fixture.input));
  const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
  const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  const sourceAssets = accepted.sourceAssetEvidence.map(({ assetId, contentHash }) => ({ assetId, contentHash }));
  accepted.attemptIdentityHash = hash({
    scope: fixture.input.scope,
    planHash: fixture.input.plan.planHash,
    sourceHash: fixture.input.plan.sourceHash,
    strategyHash: fixture.input.plan.strategyHash,
    configHash: fixture.input.plan.configHash,
    visualGroupsHash: fixture.input.plan.visualGroupsHash,
    slot: fixture.input.slot,
    preliminaryEvidence: [{ assetId: fixture.asset.assetId, evidenceKind: "CONTENT_HASH", evidenceRefHash: fixture.asset.contentHash }],
    profileId: fixture.input.profile.id,
    profileVersion: fixture.input.profile.configVersion,
    imageModel: fixture.input.imageModel,
    ratio: fixture.input.ratio,
    resolution: fixture.input.resolution,
    size: fixture.input.size,
    quality: fixture.input.quality,
    templateVersion: fixture.input.templateVersion,
    regeneration: null,
  });
  accepted.inputHash = hash({
    planHash: fixture.input.plan.planHash,
    slot: fixture.input.slot,
    sourceAssets,
    sourceHash: fixture.input.plan.sourceHash,
    strategyHash: fixture.input.plan.strategyHash,
    configHash: fixture.input.plan.configHash,
    visualGroupsHash: fixture.input.plan.visualGroupsHash,
    templateVersion: fixture.input.templateVersion,
    profileId: fixture.input.profile.id,
    profileVersion: fixture.input.profile.configVersion,
    imageModel: fixture.input.imageModel,
    ratio: fixture.input.ratio,
    resolution: fixture.input.resolution,
    size: fixture.input.size,
    quality: fixture.input.quality,
    regeneration: null,
  });
  accepted.promptHash = hash({
    templateVersion: fixture.input.templateVersion,
    planHash: fixture.input.plan.planHash,
    slot: fixture.input.slot,
    sourceAssets,
  });
  accepted.objectKey = buildGeneratedAssetObjectKey({ ...accepted, contentHash: accepted.contentHash });

  assert.equal(verifyAcceptedGeneratedAssetEvidence({
    record: accepted,
    scope: fixture.input.scope,
    plan: fixture.input.plan,
    slot: fixture.input.slot,
    profile: fixture.input.profile,
    imageModel: fixture.input.imageModel,
    templateVersion: fixture.input.templateVersion,
  }), true);

  let reservationInput;
  const replay = await setup();
  replay.input.repository.reserveGenerationAttempt = async (value) => {
    reservationInput = value;
    return value.legacyAttemptIdentityHash === accepted.attemptIdentityHash
      ? { status: "EXISTING_ACCEPTED", record: accepted }
      : reserved();
  };
  const reused = await generateImageSlot(replay.input);
  assert.equal(reservationInput.legacyAttemptIdentityHash, accepted.attemptIdentityHash);
  assert.equal(reused.inputHash, accepted.inputHash);
  assert.equal(replay.loaderCalls(), 0);
  assert.equal(replay.gatewayCalls(), 0);
});

test("direct accepted reuse binds persisted references to the immutable selected asset identity", async () => {
  const first = await setup();
  const accepted = structuredClone(await generateImageSlot(first.input));
  accepted.sourceAssetEvidence[0].assetId = "asset-z";
  accepted.checkerEvidence.sourceAssets[0].assetId = "asset-z";
  accepted.checkerEvidence.checkerResult.evidence.identity.sourceAssetIds = ["asset-z"];
  const rebuilt = buildImageGenerationInput({ ...first.input, references: accepted.sourceAssetEvidence });
  accepted.inputHash = rebuilt.inputHash;
  accepted.promptHash = rebuilt.promptHash;
  accepted.objectKey = buildGeneratedAssetObjectKey({ ...accepted, inputHash: rebuilt.inputHash, contentHash: accepted.contentHash });
  const replay = await setup({ existing: accepted });
  await assert.rejects(generateImageSlot(replay.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(replay.loaderCalls(), 0);
});

test("required bind port is fenced before reservation or source loading", async () => {
  for (const method of ["bindGenerationAttemptInput", "findStoredGenerationAsset", "recordStoredGenerationAsset", "revertStoredGenerationAsset", "recordAssetCleanupRequired", "completeGenerationAttempt", "rejectGenerationAttempt", "failGenerationAttempt", "releaseGenerationLease"]) {
    const fixture = await setup();
    delete fixture.input.repository[method];
    const effects = [];
    fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); return reserved(); };
    fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); throw new Error("must not load"); };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_INPUT_INVALID", method);
    assert.deepEqual(effects, [], method);
  }
});

test("image generation leaves item-state transitions to the workflow repository", async () => {
  const fixture = await setup();
  delete fixture.input.repository.blockItem;
  assert.equal((await generateImageSlot(fixture.input)).status, "ACCEPTED");
});

test("quality is canonicalized once for attempt identity, final input, gateway, and accepted reuse", async () => {
  const first = await setup();
  first.input.quality = "High";
  const generate = first.input.gateway.generateImage;
  first.input.gateway.generateImage = async (request) => { assert.equal(request.quality, "high"); return generate(request); };
  const accepted = await generateImageSlot(first.input);
  const replay = await setup({ existing: structuredClone(accepted) });
  replay.input.quality = "high";
  const reused = await generateImageSlot(replay.input);
  assert.equal(reused.inputHash, accepted.inputHash);
  assert.equal(replay.loaderCalls(), 0);
});

test("mismatched source evidence consumes its reserved lease without calling an image gateway", async () => {
  const fixture = await setup({ loaderEvidence: "SOURCE_URL" });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_INVALID");
  assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls.map(([name]) => name), ["failed"]);
});

test("source loading failure is terminalized through its lease and reports MAIN blocked to the workflow", async () => {
  const fixture = await setup();
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  fixture.input.sourceAssetLoader.loadSourceAsset = async () => { throw new Error("network detail must not escape"); };
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_UNAVAILABLE" && error?.retryable === false && error?.itemOutcome === "BLOCKED");
  assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls.map(([name]) => name), ["failed"]);
});

test("the complete plan, profile, group, and slot scope fence runs before every side effect", async () => {
  const mutations = [
    (fixture) => { fixture.input.plan.id = "other-plan"; },
    (fixture) => { fixture.input.plan.sourceAccountId = "other-account"; },
    (fixture) => { fixture.input.plan.jobId = "other-job"; },
    (fixture) => { fixture.input.plan.itemId = "other-item"; },
    (fixture) => { fixture.input.profile.accountId = "other-account"; },
    (fixture) => { fixture.input.plan.profileId = "other-profile"; },
    (fixture) => { fixture.input.plan.profileVersion = 99; },
    (fixture) => { fixture.input.plan.plannerModel = "other-model"; },
    (fixture) => { fixture.input.plan.promptTemplateVersion = "other-template"; },
    (fixture) => { fixture.input.profile.imageModel = "other-image"; },
    (fixture) => { fixture.input.profile.id = ""; },
    (fixture) => { fixture.input.profile.configVersion = 0; },
    (fixture) => { fixture.input.profile.textModel = ""; },
    (fixture) => { fixture.input.imageModel = ""; },
    (fixture) => { fixture.input.templateVersion = ""; },
    (fixture) => { fixture.input.ratio = "5:7"; },
    (fixture) => { fixture.input.resolution = "8K"; },
    (fixture) => { fixture.input.quality = "extreme"; },
    (fixture) => { fixture.input.scope = { ...fixture.input.scope, accountId: " account-a" }; },
    (fixture) => { fixture.input.scope = { ...fixture.input.scope, jobId: "job-a\u0007" }; },
    (fixture) => { fixture.input.scope = { ...fixture.input.scope, itemId: "x".repeat(241) }; },
    (fixture) => { fixture.input.plan.id = "plan-a "; },
    (fixture) => { fixture.input.profile.id = "profile-a\u007f"; },
    (fixture) => { fixture.input.slot = { ...fixture.input.slot, slotKey: " cover" }; },
    (fixture) => { fixture.input.scope = { ...fixture.input.scope, slotKey: "other-slot" }; },
    (fixture) => { fixture.input.slot = { ...fixture.input.slot, visualGroupKey: "other-group" }; },
  ];
  for (const mutate of mutations) {
    const fixture = await setup();
    const effects = [];
    fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); throw new Error("must not load"); };
    fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); throw new Error("must not reserve"); };
    fixture.input.gateway.generateImage = async () => { effects.push("gateway"); throw new Error("must not call"); };
    fixture.input.storage.putObjectFromBuffer = async () => { effects.push("storage"); throw new Error("must not store"); };
    mutate(fixture);
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_INPUT_INVALID");
    assert.deepEqual(effects, []);
  }
});

test("loads only the slot's ordered unique 1..7 references even when its visual group has more images", async () => {
  const fixture = await setup();
  const assets = Array.from({ length: 9 }, (_, index) => ({ assetId: `asset-${index}`, sourceRef: null, contentHash: sha256(fixture.bytes), evidenceKind: "CONTENT_HASH" }));
  fixture.input.plan.visualGroups.groups[0].referenceImages = assets;
  fixture.input.slot.referenceAssetIds = ["asset-3", "asset-1"];
  fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
  const loaded = [];
  fixture.input.sourceAssetLoader.loadSourceAsset = async (request) => {
    loaded.push(request.assetId);
    return { assetId: request.assetId, sourceRef: request.sourceRef, evidenceKind: request.evidenceKind, bytes: fixture.bytes, contentType: "image/png", width: 768, height: 1024 };
  };
  fixture.input.gateway.generateImage = async (request) => {
    assert.equal(request.sourceImages.length, 2);
    return { bytes: fixture.bytes, requestId: "generate-1", modelEvidence: { requestedImageModel: "image-model", gatewayReportedImageModel: "image-model", gatewayReportedImageModelPresent: true, orchestratorModel: "" } };
  };
  fixture.input.gateway.inspectImage = async (request) => {
    assert.equal(request.sourceImages.length, 1);
    assert.equal(request.sourceImages.every(({ bytes }) => bytes.equals(fixture.bytes)), true);
    return checkerResponse(fixture, {}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-3"] } });
  };
  await generateImageSlot(fixture.input);
  assert.deepEqual(loaded, ["asset-3", "asset-1"]);
});

test("invalid slot reference lists fail before loader, reservation, gateway, or storage", async () => {
  for (const referenceAssetIds of [[], ["asset-a", "asset-a"], ["missing"], Array.from({ length: 8 }, (_, index) => `asset-${index}`)]) {
    const fixture = await setup();
    fixture.input.slot.referenceAssetIds = referenceAssetIds;
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    const effects = [];
    fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); };
    fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); };
    fixture.input.gateway.generateImage = async () => { effects.push("gateway"); };
    fixture.input.storage.putObjectFromBuffer = async () => { effects.push("storage"); };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_INVALID");
    assert.deepEqual(effects, []);
  }
});

test("source reference aggregate is capped at 32 MiB before reservation or gateway", async () => {
  const fixture = await setup();
  const raw = crypto.randomBytes(1700 * 2268 * 3);
  const large = await sharp(raw, { raw: { width: 1700, height: 2268, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(large.length > 10 * 1024 * 1024);
  const assets = Array.from({ length: 4 }, (_, index) => ({ assetId: `asset-${index}`, sourceRef: null, contentHash: sha256(large), evidenceKind: "CONTENT_HASH" }));
  fixture.input.plan.visualGroups.groups[0].referenceImages = assets;
  fixture.input.slot.referenceAssetIds = assets.map(({ assetId }) => assetId);
  fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
  fixture.input.sourceAssetLoader.loadSourceAsset = async (request) => ({ assetId: request.assetId, sourceRef: request.sourceRef, evidenceKind: request.evidenceKind, bytes: large, contentType: "image/png", width: 1700, height: 2268 });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_INVALID");
  assert.equal(fixture.gatewayCalls(), 0);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["failed"]);
});

test("combined product and category-style references are capped before a paid image call", async () => {
  const fixture = await setup();
  const raw = crypto.randomBytes(1700 * 2268 * 3);
  const large = await sharp(raw, { raw: { width: 1700, height: 2268, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(large.length > 10 * 1024 * 1024 && large.length < 16 * 1024 * 1024);
  const product = { assetId: "asset-a", sourceRef: null, contentHash: sha256(large), evidenceKind: "CONTENT_HASH" };
  fixture.input.plan.visualGroups.groups[0].referenceImages = [product];
  fixture.input.sourceAssetLoader.loadSourceAsset = async () => ({
    ...product, bytes: large, contentType: "image/png", width: 1700, height: 2268,
  });
  fixture.input.categoryStyle = categoryStyle;
  fixture.input.categoryStyleReferences = ["a", "b"].map((suffix) => ({
    evidenceId: `style-large-${suffix}`, sku: `sample-large-${suffix}`,
    objectKey: `category-strategy/account-a/draft-a/set-a/sample-${suffix}/style-large-${suffix}.png`,
    contentHash: sha256(large), contentType: "image/png", width: 1700, height: 2268,
  }));
  fixture.input.storage.getObjectBuffer = async (key) => key.includes("style-large-") ? large : fixture.bytes;
  let gatewayCalls = 0;
  fixture.input.gateway.generateImage = async () => { gatewayCalls += 1; return null; };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_ASSET_TOO_LARGE");

  assert.equal(gatewayCalls, 0);
});

test("gpt-image-2 derives its request size from each image-generation configuration", async () => {
  for (const configured of [
    { ratio: "3:4", resolution: "1K", size: "768x1024", gatewaySize: "768x1024" },
    { ratio: "4:3", resolution: "2K", size: "2048x1536", gatewaySize: "2048x1536" },
    { ratio: "2:3", resolution: "1K", size: "683x1024", gatewaySize: "672x1008" },
    { ratio: "3:4", resolution: "4K", size: "3072x4096", gatewaySize: "2448x3264" },
  ]) {
    const fixture = await setup();
    Object.assign(fixture.input, {
      ratio: configured.ratio,
      resolution: configured.resolution,
      size: configured.size,
      imageModel: "gpt-image-2",
      profile: { ...fixture.input.profile, imageModel: "gpt-image-2" },
    });
    fixture.input.repository.reserveGenerationAttempt = async () => reserved(1, configured.size);
    const generate = fixture.input.gateway.generateImage;
    fixture.input.gateway.generateImage = async (request) => {
      assert.equal(request.size, configured.gatewaySize);
      const result = await generate(request);
      return {
        ...result,
        modelEvidence: {
          ...result.modelEvidence,
          requestedImageModel: "gpt-image-2",
          gatewayReportedImageModel: "gpt-image-2",
        },
      };
    };
    const accepted = await generateImageSlot(fixture.input);
    assert.equal(accepted.generationSize, configured.size);
  }
  for (const size of ["1024x1024", " 768x1024", "768x1024 ", "768X1024", "1x1"]) {
    const invalid = await setup(); invalid.input.size = size;
    await assert.rejects(generateImageSlot(invalid.input), (error) => error?.code === "AUTO_LISTING_IMAGE_INPUT_INVALID");
    assert.equal(invalid.loaderCalls(), 0); assert.equal(invalid.gatewayCalls(), 0); assert.deepEqual(invalid.calls, []);
  }
});

test("an occupied preliminary lease prevents a concurrent duplicate source download", async () => {
  const fixture = await setup();
  const attemptRepository = createMemoryGenerationAttemptRepository({ token: () => "lease-concurrent" });
  fixture.input.repository = { ...attemptRepository, async recordAssetCleanupRequired(value) { return value; }, async blockItem() {}, async countAcceptedAssets() { return 0; } };
  let loads = 0; let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const originalLoader = fixture.input.sourceAssetLoader.loadSourceAsset;
  fixture.input.sourceAssetLoader.loadSourceAsset = async (request) => { loads += 1; if (loads === 1) await firstGate; return originalLoader(request); };
  const first = generateImageSlot(fixture.input);
  while (loads === 0) await new Promise((resolve) => setImmediate(resolve));
  try {
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_IN_PROGRESS");
    assert.equal(loads, 1);
  } finally {
    releaseFirst();
    await first.catch(() => {});
  }
});

test("a final input version conflict ends the lease before gateway or storage", async () => {
  const fixture = await setup();
  fixture.input.repository.bindGenerationAttemptInput = async () => ({ status: "VERSION_CONFLICT" });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_VERSION_CONFLICT" && error?.retryable === true);
  assert.equal(fixture.loaderCalls(), 1); assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls, []);
});

test("the same immutable content identity safely reuses accepted bytes without source loading", async () => {
  const attempts = createMemoryGenerationAttemptRepository({ token: () => crypto.randomUUID() });
  const repository = { ...attempts, async recordAssetCleanupRequired(value) { return { ...value, status: "PENDING" }; }, async blockItem() {}, async countAcceptedAssets() { return 0; } };
  const first = await setup(); first.input.repository = repository;
  const accepted = await generateImageSlot(first.input);

  const second = await setup(); second.input.repository = repository;
  second.input.gateway.generateImage = async () => { throw new Error("must reuse accepted final bytes"); };
  second.input.storage.putObjectFromBuffer = async () => { throw new Error("must not store duplicate final bytes"); };
  const reused = await generateImageSlot(second.input);
  assert.equal(reused.inputHash, accepted.inputHash);
  assert.equal(reused.attemptIdentityHash, accepted.attemptIdentityHash);
  assert.equal(second.loaderCalls(), 0);
  assert.equal(second.gatewayCalls(), 0);
  assert.deepEqual(second.calls, []);
  assert.equal(attempts.snapshot().filter((row) => row.status === "ACCEPTED").length, 1);
});

test("accepted reuse rejects a changed validated generation size", async () => {
  const first = await setup(); const accepted = await generateImageSlot(first.input);
  const replay = await setup({ existing: structuredClone(accepted) }); replay.input.size = "900x1200";
  await assert.rejects(generateImageSlot(replay.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(replay.gatewayCalls(), 0);
});

test("does not reuse a corrupt accepted record", async () => {
  const fixture = await setup({ existing: { status: "ACCEPTED", accountId: "other-account", contentHash: "x" } });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(fixture.gatewayCalls(), 0);
});

test("an occupied lease has no external call and gateway failure is terminalized through its own lease token", async () => {
  const occupied = await setup();
  occupied.input.repository.reserveGenerationAttempt = async () => ({ status: "IN_PROGRESS" });
  await assert.rejects(generateImageSlot(occupied.input), (error) => error?.code === "AUTO_LISTING_IMAGE_IN_PROGRESS" && error?.retryable === true);
  assert.equal(occupied.loaderCalls(), 0); assert.equal(occupied.gatewayCalls(), 0);

  const failing = await setup();
  failing.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; throw error; };
  await assert.rejects(generateImageSlot(failing.input), (error) => error?.code === "AI_GATEWAY_UNAVAILABLE");
  assert.deepEqual(failing.calls.map(([name]) => name), ["failed"]);
  assert.equal(failing.calls[0][1].leaseToken, "lease-a");
});

test("a malformed gateway response keeps its channel code for worker requeue classification", async () => {
  const fixture = await setup();
  const gatewayError = new Error("malformed provider response");
  gatewayError.code = "INVALID_GATEWAY_RESPONSE";
  gatewayError.retryable = false;
  fixture.input.gateway.generateImage = async () => {
    throw gatewayError;
  };
  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error === gatewayError,
  );
  assert.equal(fixture.calls.find(([name]) => name === "release")[1].errorCode, "AUTO_LISTING_IMAGE_CHANNEL_RELEASED");
  assert.equal(fixture.calls.some(([name]) => name === "failed"), false);
});

test("four NOT_SENT image channel failures release and reuse attempt one without exhaustion", async () => {
  const fixture = await setup();
  let leaseNo = 0;
  let released = true;
  fixture.input.repository.reserveGenerationAttempt = async () => {
    assert.equal(released, true, "the previous channel lease must be released before requeue");
    released = false;
    return { status: "RESERVED", attemptNo: 1, leaseToken: `channel-lease-${++leaseNo}`, generationSize: fixture.input.size };
  };
  fixture.input.repository.releaseGenerationLease = async (value) => {
    assert.equal(value.attemptNo, 1);
    assert.equal(value.leaseToken, `channel-lease-${leaseNo}`);
    assert.equal(value.errorCode, "AUTO_LISTING_IMAGE_CHANNEL_RELEASED");
    released = true;
    fixture.calls.push(["release", value]);
    return { ...value, status: "GENERATING", leaseToken: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED" };
  };
  fixture.input.repository.failGenerationAttempt = async () => { throw new Error("channel failure consumed business attempt"); };
  const gatewayError = Object.assign(new Error("rate limited"), {
    code: "AI_GATEWAY_RATE_LIMITED", status: 429, retryable: true,
  });
  fixture.input.gateway.generateImage = async () => { throw gatewayError; };

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(generateImageSlot(fixture.input), (error) => error === gatewayError);
  }
  assert.equal(leaseNo, 4);
  assert.equal(fixture.calls.filter(([name]) => name === "release").length, 4);
  assert.equal(fixture.calls.some(([name]) => name === "failed"), false);
});

test("checker channel failure releases attempt one and reuses its stored image without another image call", async () => {
  const fixture = await setup();
  let leaseNo = 0;
  let storedRecord = null;
  let releasedRecord = null;
  let imageCalls = 0;
  let checkerCalls = 0;
  let objectPuts = 0;
  const inspect = fixture.input.gateway.inspectImage;
  const generate = fixture.input.gateway.generateImage;
  fixture.input.repository.reserveGenerationAttempt = async () => ({
    status: "RESERVED", attemptNo: 1,
    leaseToken: `checker-channel-${++leaseNo}`, generationSize: fixture.input.size,
  });
  fixture.input.repository.bindGenerationAttemptInput = async (value) => ({
    status: "BOUND", inputHash: value.inputHash,
    ...(releasedRecord ? { recoveryRecord: {
      ...releasedRecord, status: "GENERATING", errorCode: null, errorRetryable: null,
      leaseToken: value.leaseToken,
    } } : {}),
  });
  fixture.input.repository.recordStoredGenerationAsset = async (value) => {
    storedRecord = { ...value };
    fixture.calls.push(["stored", value]);
    return value;
  };
  fixture.input.repository.findStoredGenerationAsset = async () => storedRecord;
  fixture.input.repository.releaseGenerationLease = async (value) => {
    releasedRecord = {
      ...storedRecord, ...value, status: "GENERATING", errorRetryable: null,
      errorCode: null,
      finalInputBoundAt: "2026-08-28T00:00:00.000Z", role: "MAIN",
      profileId: "profile-a", profileVersion: 3, modelName: "image-model",
      leaseToken: "AUTO_LISTING_IMAGE_CHANNEL_RELEASED", leaseExpiresAt: "2026-08-28T00:00:00.000Z",
    };
    fixture.calls.push(["release", value]);
    return releasedRecord;
  };
  fixture.input.repository.failGenerationAttempt = async () => { throw new Error("checker channel failure consumed business attempt"); };
  fixture.input.gateway.generateImage = async (request) => { imageCalls += 1; return generate(request); };
  fixture.input.gateway.inspectImage = async (request) => {
    checkerCalls += 1;
    if (checkerCalls === 1) {
      throw Object.assign(new Error("checker auth rejected"), {
        code: "NON_RETRYABLE_AUTH", status: 401, retryable: false,
      });
    }
    return inspect(request);
  };
  const put = fixture.input.storage.putObjectFromBuffer;
  fixture.input.storage.putObjectFromBuffer = async (value) => { objectPuts += 1; return put(value); };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "NON_RETRYABLE_AUTH");
  const accepted = await generateImageSlot(fixture.input);

  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(imageCalls, 1);
  assert.equal(checkerCalls, 2);
  assert.equal(objectPuts, 1);
  assert.equal(fixture.calls.filter(([name]) => name === "release").length, 1);
  assert.equal(fixture.calls.some(([name]) => name === "failed"), false);
});

test("image lease loss after provider return persists no generated result and starts no checker call", async () => {
  const fixture = await setup();
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  let active = true;
  let checkerCalls = 0;
  fixture.input.assertLeaseActive = () => { if (!active) throw stale; };
  fixture.input.gateway.generateImage = async () => {
    active = false;
    return {
      bytes: fixture.bytes, requestId: "generate-stale",
      modelEvidence: {
        requestedImageModel: "image-model", gatewayReportedImageModel: "image-model",
        gatewayReportedImageModelPresent: true, orchestratorModel: "",
      },
    };
  };
  fixture.input.gateway.inspectImage = async () => { checkerCalls += 1; };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error === stale);
  assert.equal(checkerCalls, 0);
  assert.deepEqual(fixture.calls, []);
});

test("image provider rejection rechecks the lease before recording any failure", async () => {
  const fixture = await setup();
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  const providerFailure = Object.assign(new Error("provider rejected"), {
    code: "NON_RETRYABLE_AUTH", status: 401, retryable: false,
  });
  let active = true;
  fixture.input.assertLeaseActive = () => { if (!active) throw stale; };
  fixture.input.gateway.generateImage = async () => {
    active = false;
    throw providerFailure;
  };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error === stale);
  assert.deepEqual(fixture.calls, []);
});

test("image terminal repository boundaries prefer lease loss after deferred resolve or reject", async (t) => {
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  for (const target of ["rejectGenerationAttempt", "completeGenerationAttempt", "failGenerationAttempt"]) {
    for (const settlement of ["resolve", "reject"]) {
      await t.test(`${target}:${settlement}`, async () => {
        const fixture = await setup();
        let active = true;
        let entered;
        const enteredPromise = new Promise((resolve) => { entered = resolve; });
        const pending = deferred();
        const terminalWrites = [];
        fixture.input.assertLeaseActive = () => { if (!active) throw stale; };
        for (const method of ["rejectGenerationAttempt", "completeGenerationAttempt", "failGenerationAttempt", "releaseGenerationLease"]) {
          fixture.input.repository[method] = async (value) => {
            terminalWrites.push(method);
            if (method === target) {
              entered();
              await pending.promise;
            }
            if (method === "completeGenerationAttempt") return { status: "ACCEPTED", accepted: true, ...value };
            return value;
          };
        }
        if (target === "rejectGenerationAttempt") {
          fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, {
            identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
          });
        } else if (target === "failGenerationAttempt") {
          fixture.input.sourceAssetLoader.loadSourceAsset = async () => { throw new Error("source unavailable"); };
        }

        const work = generateImageSlot(fixture.input);
        await enteredPromise;
        active = false;
        if (settlement === "resolve") pending.resolve();
        else pending.reject(new Error(`deferred ${target} rejection`));

        await assert.rejects(work, (error) => error === stale);
        assert.deepEqual(terminalWrites, [target]);
      });
    }
  }
});

test("image lease loss after asset persistence starts no checker and writes no later attempt result", async () => {
  const fixture = await setup();
  const stale = Object.assign(new Error("stale execution"), {
    code: "AUTO_LISTING_AI_EXECUTION_LEASE_LOST", retryable: false,
  });
  let active = true;
  let checkerCalls = 0;
  fixture.input.assertLeaseActive = () => { if (!active) throw stale; };
  const recordStored = fixture.input.repository.recordStoredGenerationAsset;
  fixture.input.repository.recordStoredGenerationAsset = async (input) => {
    const result = await recordStored(input);
    active = false;
    return result;
  };
  fixture.input.gateway.inspectImage = async () => { checkerCalls += 1; };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error === stale);
  assert.equal(checkerCalls, 0);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored"]);
});

test("malformed reserved attempt numbers fail closed before gateway, storage, or terminal mutation", async () => {
  for (const attemptNo of [0, 4]) {
    const fixture = await setup();
    fixture.input.repository.reserveGenerationAttempt = async () => reserved(attemptNo);
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_RESERVATION_FAILED");
    assert.equal(fixture.gatewayCalls(), 0);
    assert.deepEqual(fixture.calls, []);
  }
});

test("attempt number scopes generation/checker idempotency keys and every terminal record keeps request IDs", async () => {
  const accepted = await setup();
  accepted.input.repository.reserveGenerationAttempt = async () => reserved(2);
  const keys = [];
  const generate = accepted.input.gateway.generateImage;
  const inspect = accepted.input.gateway.inspectImage;
  accepted.input.gateway.generateImage = async (request) => { keys.push(request.requestKey); return generate(request); };
  accepted.input.gateway.inspectImage = async (request) => { keys.push(request.requestKey); return inspect(request); };
  const result = await generateImageSlot(accepted.input);
  assert.match(keys[0], /attempt-2$/);
  assert.match(keys[1], /attempt-2$/);
  assert.equal(result.gatewayRequestId, "generate-1");
  assert.equal(result.checkerRequestId, "check-1");

  const rejected = await setup();
  rejected.input.gateway.inspectImage = async () => checkerResponse(rejected, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] } });
  await assert.rejects(generateImageSlot(rejected.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH");
  const rejectedRow = rejected.calls.find(([name]) => name === "rejected")[1];
  assert.equal(rejectedRow.gatewayRequestId, "generate-1");
  assert.equal(rejectedRow.checkerRequestId, "check-1");

  const failed = await setup();
  failed.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; error.requestId = "generate-failed-1"; throw error; };
  await assert.rejects(generateImageSlot(failed.input), (error) => error?.code === "AI_GATEWAY_UNAVAILABLE");
  const failedRow = failed.calls.find(([name]) => name === "failed")[1];
  assert.equal(failedRow.gatewayRequestId, "generate-failed-1");
  assert.equal(failedRow.checkerRequestId, null);
});

test("transport, storage, checker, policy, and exhausted reservations share one bounded finalization policy", async () => {
  for (const [role, failureKind, acceptedCount, expectedOutcome, expectedCode] of [
    ["MAIN", "transport", 0, "BLOCKED", "AI_GATEWAY_UNAVAILABLE"],
    ["DETAIL", "storage", 6, "CONTINUE_WITHOUT_SLOT", "AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE"],
    ["DETAIL", "checker", 5, "CONTINUE_WITHOUT_SLOT", "CHECKER_UNAVAILABLE"],
    ["MAIN", "exhausted", 0, "BLOCKED", "AUTO_LISTING_IMAGE_ATTEMPTS_EXHAUSTED"],
  ]) {
    const fixture = await setup();
    fixture.input.slot = { ...fixture.input.slot, role };
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    fixture.input.repository.reserveGenerationAttempt = async () => failureKind === "exhausted"
      ? { status: "ATTEMPTS_EXHAUSTED" }
      : reserved(3);
    fixture.input.repository.countAcceptedAssets = async () => acceptedCount;
    if (failureKind === "transport") fixture.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; throw error; };
    if (failureKind === "storage") fixture.input.storage.putObjectFromBuffer = async () => { const error = new Error("temporary"); error.code = "offline"; throw error; };
    if (failureKind === "checker") fixture.input.gateway.inspectImage = async () => { const error = new Error("temporary"); error.requestId = "checker-failed-1"; throw error; };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === expectedCode && error?.itemOutcome === expectedOutcome);
  }
});

test("checker policy rejection uses the reserved attempt and remains distinct from retryable transport failure", async () => {
  const fixture = await setup();
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] } });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error?.retryable === true);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "rejected"]);
  assert.equal(fixture.calls[1][1].leaseToken, "lease-a");
});

test("V6 accepts a soft presentation warning immediately without another paid generation", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }];
  fixture.input.slot.sourceFactIds = [fixture.fact.factId];
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(2);
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, { quality: "FAIL" }, {
    qualityFlags: ["SUBJECT_NOT_DOMINANT"],
  });

  const result = await generateImageSlot(fixture.input);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.acceptedWithWarnings, true);
  assert.deepEqual(result.manualReviewWarnings, ["SUBJECT_NOT_DOMINANT"]);
  assert.equal(fixture.gatewayCalls(), 1);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
});

test("V6 sends a third soft presentation failure to manual review with tamper-evident warning evidence", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }];
  fixture.input.slot.sourceFactIds = [fixture.fact.factId];
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, { quality: "FAIL" }, {
    qualityFlags: ["SUBJECT_NOT_DOMINANT"],
  });

  const result = await generateImageSlot(fixture.input);

  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.acceptedWithWarnings, true);
  assert.deepEqual(result.manualReviewWarnings, ["SUBJECT_NOT_DOMINANT"]);
  assert.equal(result.checkerEvidence.checkerResult.quality, "PASS");
  assert.deepEqual(result.checkerEvidence.checkerResult.evidence.qualityFlags, []);
  assert.ok(result.checkerEvidence.checkerResult.reasons.includes("AUTO_LISTING_MANUAL_REVIEW_WARNING:SUBJECT_NOT_DOMINANT"));
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
});

test("V6 never converts a final hard checker failure into a manual-review warning", async () => {
  const fixture = await setup();
  fixture.input.templateVersion = "AUTO_LISTING_CONTENT_PLAN_FILL_V6";
  fixture.input.plan.promptTemplateVersion = fixture.input.templateVersion;
  fixture.input.slot.claims = [{ text: fixture.fact.value, claimType: fixture.fact.kind, sourceFactIds: [fixture.fact.factId] }];
  fixture.input.slot.sourceFactIds = [fixture.fact.factId];
  fixture.input.plan.plan.slots[0] = structuredClone(fixture.input.slot);
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, {
    identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
  });

  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error?.retryable === false,
  );
  assert.equal(fixture.calls.some(([name, value]) => name === "complete"
    && value.checkerEvidence?.checkerResult?.reasons?.some((reason) => reason.startsWith("AUTO_LISTING_MANUAL_REVIEW_WARNING:"))), false);
});

test("final policy failure reports MAIN blocked, while non-main reports bounded coverage", async () => {
  for (const [role, attemptNo, count, outcome] of [["MAIN", 1, 0, undefined], ["MAIN", 3, 0, "BLOCKED"], ["DETAIL", 3, 5, "CONTINUE_WITHOUT_SLOT"], ["DETAIL", 3, 6, "CONTINUE_WITHOUT_SLOT"]]) {
    const fixture = await setup(); fixture.input.slot = { ...fixture.input.slot, role };
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    fixture.input.repository.reserveGenerationAttempt = async () => reserved(attemptNo);
    fixture.input.repository.countAcceptedAssets = async () => count;
    fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, detectedTexts: [] });
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error.itemOutcome === outcome && error.retryable === (attemptNo < 3));
    assert.equal(fixture.calls.filter(([name]) => name === "rejected").length, 1);
    assert.equal(fixture.calls.find(([name]) => name === "rejected")[1].retryable, attemptNo < 3);
  }
});

test("a final non-main rejection is skipped until the workflow evaluates the complete group", async () => {
  const fixture = await setup();
  fixture.input.slot = { ...fixture.input.slot, role: "DETAIL" };
  fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  delete fixture.input.repository.countAcceptedAssets;
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, {
    identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
  });
  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH"
      && error?.retryable === false && error?.itemOutcome === "CONTINUE_WITHOUT_SLOT",
  );
});

test("a max-attempt transport failure is persisted as non-retryable before item finalization", async () => {
  const fixture = await setup();
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  fixture.input.repository.blockItem = async () => {};
  fixture.input.gateway.generateImage = async () => { const value = new Error("offline"); value.code = "AI_GATEWAY_UNAVAILABLE"; value.retryable = true; throw value; };
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.retryable === false);
  assert.equal(fixture.calls.find(([name]) => name === "failed")[1].retryable, false);
});

test("a non-retryable gateway failure skips a non-main slot instead of blocking the item", async () => {
  const fixture = await setup();
  fixture.input.slot = { ...fixture.input.slot, role: "INFOGRAPHIC" };
  fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(2);
  fixture.input.gateway.generateImage = async () => {
    const error = new Error("provider rejected this image request");
    error.code = "NON_RETRYABLE_GATEWAY";
    error.retryable = false;
    throw error;
  };

  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error?.code === "NON_RETRYABLE_GATEWAY"
      && error?.retryable === false && error?.itemOutcome === "CONTINUE_WITHOUT_SLOT",
  );
  assert.equal(fixture.calls.find(([name]) => name === "failed")[1].retryable, false);
});

test("checker transport and reject-record failure remain recoverable and never trigger final item policy", async () => {
  const transport = await setup(); transport.input.repository.blockItem = async () => { throw new Error("must not block"); };
  transport.input.gateway.inspectImage = async () => { throw new Error("temporary"); };
  await assert.rejects(generateImageSlot(transport.input), (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
  const rejectFailure = await setup(); rejectFailure.input.repository.reserveGenerationAttempt = async () => reserved(3);
  rejectFailure.input.repository.rejectGenerationAttempt = async () => { throw new Error("db unavailable"); };
  rejectFailure.input.repository.blockItem = async () => { throw new Error("must not block"); };
  rejectFailure.input.gateway.inspectImage = async () => checkerResponse(rejectFailure, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, detectedTexts: [] });
  await assert.rejects(generateImageSlot(rejectFailure.input), (error) => error?.code === "AUTO_LISTING_IMAGE_REPOSITORY_FAILED" && !String(error.message).includes("db unavailable"));
});

test("one transient checker failure defers to the worker retry and preserves the generated image", async () => {
  const fixture = await setup();
  const inspect = fixture.input.gateway.inspectImage;
  const checkerKeys = [];
  fixture.input.gateway.inspectImage = async (request) => {
    checkerKeys.push(request.requestKey);
    if (checkerKeys.length === 1) throw new Error("temporary checker failure");
    return inspect(request);
  };

  await assert.rejects(generateImageSlot(fixture.input),
    (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
  assert.equal(fixture.gatewayCalls(), 1);
  assert.equal(checkerKeys.length, 1);
  assert.match(checkerKeys[0], /attempt-1$/u);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "failed"]);
});

test("terminal checker retry preserves the first known external request id", async () => {
  const fixture = await setup();
  let checkerCalls = 0;
  fixture.input.gateway.inspectImage = async () => {
    checkerCalls += 1;
    const error = new Error("temporary checker failure");
    if (checkerCalls === 1) error.requestId = "checker-failed-1";
    throw error;
  };

  await assert.rejects(
    generateImageSlot(fixture.input),
    (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true,
  );

  assert.equal(fixture.gatewayCalls(), 1);
  assert.equal(checkerCalls, 1);
  const failed = fixture.calls.find(([name]) => name === "failed")[1];
  assert.equal(failed.checkerRequestId, "checker-failed-1");
  assert.equal(failed.objectKeyVersion, "ATTEMPT_V2");
  assert.equal(failed.contentType, "image/png");
  assert.equal(failed.modelEvidence.requestedImageModel, "image-model");
});

test("structured checker gateway failure keeps the generated image and channel error unchanged", async () => {
  const fixture = await setup();
  let checkerCalls = 0;
  const gatewayError = Object.assign(new Error("private malformed response"), {
    code: "INVALID_GATEWAY_RESPONSE",
    requestId: "checker-invalid-1",
    failureField: "/evidence/claims/0/unit",
  });
  fixture.input.gateway.inspectImage = async () => {
    checkerCalls += 1;
    throw gatewayError;
  };

  await assert.rejects(generateImageSlot(fixture.input), (error) => error === gatewayError);

  assert.equal(fixture.gatewayCalls(), 1);
  assert.equal(checkerCalls, 1);
  const released = fixture.calls.find(([name]) => name === "release")[1];
  assert.equal(released.errorCode, "AUTO_LISTING_IMAGE_CHANNEL_RELEASED");
  assert.equal(released.checkerRequestId, "checker-invalid-1");
  assert.equal(released.gatewayRequestId, "generate-1");
  assert.equal(released.modelEvidence.requestedImageModel, "image-model");
  assert.equal(fixture.calls.some(([name]) => name === "failed"), false);
});

test("a later task attempt reuses an image stored before checker outage without another paid generation", async () => {
  const first = await setup();
  first.input.gateway.inspectImage = async () => { throw new Error("temporary checker failure"); };
  await assert.rejects(
    generateImageSlot(first.input),
    (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true,
  );
  const failed = first.calls.find(([name]) => name === "failed")[1];

  const retry = await setup();
  retry.input.gatewayExecution = {
    channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9, idleTimeoutMs: 300_000,
  };
  retry.input.repository.bindGenerationAttemptInput = async (value) => ({
    status: "BOUND",
    inputHash: value.inputHash,
    gatewayConnectionId: "connection-a",
    gatewayConnectionVersion: 4,
    recoveryRecord: {
      ...failed,
      ...failed.storedAsset,
      status: "FAILED",
      errorCode: "CHECKER_UNAVAILABLE",
      errorRetryable: true,
      finalInputBoundAt: "2026-08-24T10:00:00.000Z",
      profileId: retry.input.profile.id,
      profileVersion: retry.input.profile.configVersion,
      modelName: retry.input.imageModel,
      gatewayConnectionId: "connection-a",
      gatewayConnectionVersion: 4,
    },
  });
  retry.input.gateway.generateImage = async () => { throw new Error("paid image generation must not run"); };

  const result = await generateImageSlot(retry.input);

  assert.equal(result.accepted, true);
  assert.equal(retry.gatewayCalls(), 0);
  assert.equal(retry.calls.filter(([name]) => name === "stored").length, 1);
  assert.equal(retry.calls.filter(([name]) => name === "complete").length, 1);
  const completed = retry.calls.find(([name]) => name === "complete")[1];
  assert.equal(completed.gatewayRequestId, "generate-1");
  assert.equal(completed.gatewayConnectionId, "connection-a");
  assert.equal(completed.gatewayConnectionVersion, 4);
  assert.equal(completed.checkerConnectionId, "connection-b");
  assert.equal(completed.checkerConnectionVersion, 9);
});

test("connection B replaces unreadable recovery evidence from A before one new paid generation", async () => {
  const first = await setup();
  first.input.gateway.inspectImage = async () => { throw new Error("temporary checker failure"); };
  await assert.rejects(generateImageSlot(first.input));
  const failed = first.calls.find(([name]) => name === "failed")[1];

  const retry = await setup();
  retry.input.gatewayExecution = {
    channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9, idleTimeoutMs: 300_000,
  };
  retry.input.repository.bindGenerationAttemptInput = async (value) => ({
    status: "BOUND", inputHash: value.inputHash,
    gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4,
    recoveryRecord: {
      ...failed, ...failed.storedAsset, status: "FAILED", errorCode: "CHECKER_UNAVAILABLE",
      errorRetryable: true, finalInputBoundAt: "2026-08-24T10:00:00.000Z",
      profileId: retry.input.profile.id, profileVersion: retry.input.profile.configVersion,
      modelName: retry.input.imageModel,
      gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4,
    },
  });
  const replacements = [];
  retry.input.repository.replaceUnusableGenerationEvidence = async (value) => {
    replacements.push(value);
    return { gatewayConnectionId: "connection-b", gatewayConnectionVersion: 9 };
  };
  const readStored = retry.input.storage.getObjectBuffer;
  let reads = 0;
  retry.input.storage.getObjectBuffer = async (...args) => {
    reads += 1;
    return reads === 1 ? Buffer.from("corrupt") : readStored(...args);
  };

  const result = await generateImageSlot(retry.input);

  assert.equal(result.accepted, true);
  assert.equal(retry.gatewayCalls(), 1);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].gatewayConnectionId, "connection-a");
  assert.equal(replacements[0].replacementGatewayConnectionId, "connection-b");
  const completed = retry.calls.find(([name]) => name === "complete")[1];
  assert.equal(completed.gatewayConnectionId, "connection-b");
  assert.equal(completed.gatewayConnectionVersion, 9);
  assert.equal(completed.checkerConnectionId, "connection-b");
  assert.equal(completed.checkerConnectionVersion, 9);
});

test("stale image producer handoff makes no paid B call and stores no B bytes", async () => {
  const first = await setup();
  first.input.gateway.inspectImage = async () => { throw new Error("temporary checker failure"); };
  await assert.rejects(generateImageSlot(first.input));
  const failed = first.calls.find(([name]) => name === "failed")[1];
  const retry = await setup();
  retry.input.gatewayExecution = {
    channelId: "channel-b", connectionId: "connection-b", connectionVersion: 9, idleTimeoutMs: 300_000,
  };
  retry.input.repository.bindGenerationAttemptInput = async (value) => ({
    status: "BOUND", inputHash: value.inputHash,
    gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4,
    recoveryRecord: {
      ...failed, ...failed.storedAsset, status: "FAILED", errorCode: "CHECKER_UNAVAILABLE",
      errorRetryable: true, finalInputBoundAt: "2026-08-24T10:00:00.000Z",
      profileId: retry.input.profile.id, profileVersion: retry.input.profile.configVersion,
      modelName: retry.input.imageModel,
      gatewayConnectionId: "connection-a", gatewayConnectionVersion: 4,
    },
  });
  retry.input.repository.replaceUnusableGenerationEvidence = async () => {
    const error = new Error("stale lease"); error.code = "AUTO_LISTING_IMAGE_ATTEMPT_CLAIM_REJECTED"; throw error;
  };
  retry.input.storage.getObjectBuffer = async () => Buffer.from("corrupt");

  await assert.rejects(generateImageSlot(retry.input), { code: "AUTO_LISTING_IMAGE_REPOSITORY_FAILED" });

  assert.equal(retry.gatewayCalls(), 0);
  assert.equal(retry.calls.some(([name]) => ["stored", "complete"].includes(name)), false);
});

test("every accepted audit column is fail-closed on a corrupt completion row", async () => {
  for (const field of ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "attemptIdentityHash", "inputHash", "role", "generationSize", "contentHash", "objectKey", "objectKeyVersion", "contentType", "width", "height", "size", "gatewayRequestId", "checkerRequestId", "modelEvidence", "profileId", "profileVersion", "modelName", "planHash", "sourceHash", "strategyHash", "configHash", "visualGroupsHash", "promptTemplateVersion", "promptHash", "checkerEvidence", "sourceAssetEvidence", "regeneration"]) {
    const fixture = await setup(); const original = fixture.input.repository.completeGenerationAttempt;
    fixture.input.repository.completeGenerationAttempt = async (value) => { const row = await original(value); row[field] = ["width", "height", "size"].includes(field) ? 0 : field === "checkerEvidence" ? { ...row.checkerEvidence, generatedHash: "0".repeat(64) } : field === "sourceAssetEvidence" ? [] : field === "modelEvidence" ? { ...row.modelEvidence, requestedImageModel: "corrupt" } : field === "regeneration" ? { requestId: "corrupt", reason: "QUALITY_RETRY" } : ["gatewayRequestId", "checkerRequestId"].includes(field) ? " corrupt " : "corrupt"; return row; };
    await assert.rejects(generateImageSlot(fixture.input), (error) => { assert.equal(error?.code, "AUTO_LISTING_IMAGE_REPOSITORY_FAILED", field); return true; }, field);
  }
});

test("existing accepted reuse revalidates the full evidence matrix and actual stored object", async () => {
  const first = await setup();
  const accepted = await generateImageSlot(first.input);
  const corruptions = [
    (row) => { row.role = "DETAIL"; },
    (row) => { row.size = 1; },
    (row) => { row.gatewayRequestId = " invalid "; },
    (row) => { row.checkerRequestId = "other"; },
    (row) => { row.modelEvidence = { ...row.modelEvidence, requestedImageModel: "other" }; },
    (row) => { row.objectKey = `${row.objectKey}.other`; },
    (row) => { row.objectKeyVersion = "LEGACY_V1"; },
    (row) => { row.promptHash = "0".repeat(64); },
    (row) => { row.sourceAssetEvidence = []; },
    (row) => { row.checkerEvidence = { ...row.checkerEvidence, generatedHash: "0".repeat(64) }; },
    (row) => { row.checkerEvidence.checkerResult.matchesProduct = false; },
    (row) => { row.checkerEvidence.checkerResult.claimsVerified = false; },
    (row) => { row.checkerEvidence.checkerResult.russianText = false; },
    (row) => { row.checkerEvidence.checkerResult.quality = "FAIL"; },
    (row) => { row.checkerEvidence.checkerResult.prohibitedContent = true; },
    (row) => { row.checkerEvidence.checkerResult.evidence.detectedTexts = ["Best choice"]; },
    (row) => { row.checkerEvidence.textRequired = false; },
    (row) => { row.generationSize = "900x1200"; },
  ];
  for (const corrupt of corruptions) {
    const row = structuredClone(accepted); corrupt(row);
    const replay = await setup({ existing: row });
    await assert.rejects(generateImageSlot(replay.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
    assert.equal(replay.gatewayCalls(), 0);
  }
  const missingObject = await setup({ existing: structuredClone(accepted) });
  missingObject.input.storage.getObjectBuffer = async () => Buffer.from("corrupt object");
  await assert.rejects(generateImageSlot(missingObject.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(missingObject.gatewayCalls(), 0);
});
