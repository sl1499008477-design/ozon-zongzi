import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { buildGeneratedAssetObjectKey, normalizeListingImage, sha256 } from "../auto-listing-asset-store.mjs";
import { createMemoryGenerationAttemptRepository } from "../auto-listing-generation-attempt-repository.mjs";
import { buildImageGenerationInput, generateImageSlot, summarizeGeneratedImageSlots } from "../auto-listing-image-generator.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "main", slotKey: "cover" });
const planHash = "a".repeat(64);
const reserved = (attemptNo = 1, generationSize = "768x1024") => ({ status: "RESERVED", attemptNo, leaseToken: "lease-a", generationSize });
async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#445566" } }).png().toBuffer(); }
async function setup({ loaderEvidence = "CONTENT_HASH", existing = null } = {}) {
  const bytes = await image(); const asset = { assetId: "asset-a", sourceRef: null, evidenceKind: "CONTENT_HASH", contentHash: sha256(bytes) };
  const fact = { factId: "f1", field: "identity.primaryName", kind: "IDENTITY_NAME", value: "Красный товар", numericValue: null, unit: null, sourcePath: "identity.primaryName" };
  const claim = { text: "Красный товар", sourceFactId: "f1", field: fact.field, value: fact.value, numericValue: null, unit: null };
  let gatewayCalls = 0; let loaderCalls = 0; let objectBytes = (await normalizeListingImage({ bytes, ratio: "3:4", resolution: "1K" })).bytes; const calls = []; const bindCalls = [];
  const input = {
    scope, plan: { id: scope.planId, jobId: scope.jobId, itemId: scope.itemId, sourceAccountId: scope.accountId, profileId: "profile-a", profileVersion: 3, plannerModel: "checker", promptTemplateVersion: "image-v1", planHash, sourceHash: "b".repeat(64), strategyHash: "c".repeat(64), configHash: "d".repeat(64), visualGroupsHash: "e".repeat(64), visualGroups: { groups: [{ visualGroupKey: "main", referenceImages: [asset] }] }, plan: { slots: [{ slotKey: "cover", visualGroupKey: "main", role: "MAIN", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: ["asset-a"] }] }, factRegistry: [{ ...fact, visualGroupKeys: ["main"] }] },
    slot: { slotKey: "cover", visualGroupKey: "main", role: "MAIN", textDensity: "LIGHT", preserve: ["shape"], referenceAssetIds: ["asset-a"] }, profile: { id: "profile-a", accountId: scope.accountId, configVersion: 3, textModel: "checker", imageModel: "image-model" }, imageModel: "image-model", ratio: "3:4", resolution: "1K", size: "768x1024", quality: "high", templateVersion: "image-v1",
    sourceAssetLoader: { async loadSourceAsset(request) { loaderCalls += 1; assert.equal(request.sourceRef, asset.sourceRef); return { assetId: asset.assetId, sourceRef: asset.sourceRef, evidenceKind: loaderEvidence, bytes, contentType: "image/png", width: 768, height: 1024 }; } },
    repository: {
      async reserveGenerationAttempt() { return existing ? { status: "EXISTING_ACCEPTED", record: existing } : reserved(); },
      async bindGenerationAttemptInput(value) { bindCalls.push(value); return { status: "BOUND", inputHash: value.inputHash }; },
      async findStoredGenerationAsset() { return null; }, async recordAssetCleanupRequired(value) { return value; },
      async recordStoredGenerationAsset(value) { calls.push(["stored", value]); return value; }, async completeGenerationAttempt(value) { calls.push(["complete", value]); return { status: "ACCEPTED", accepted: true, ...value }; }, async rejectGenerationAttempt(value) { calls.push(["rejected", value]); },
      async failGenerationAttempt(value) { calls.push(["failed", value]); }, async releaseGenerationLease(value) { calls.push(["release", value]); },
      async blockItem() {}, async countAcceptedAssets() { return 0; },
    },
    storage: { async putObjectFromBuffer(value) { objectBytes = Buffer.from(value.buffer); return { key: value.key, sha256: sha256(value.buffer), contentType: value.contentType, size: value.buffer.length }; }, async getObjectBuffer() { return objectBytes; } },
    gateway: { async generateImage(request) { gatewayCalls += 1; assert.doesNotMatch(request.prompt, /https:\/\//); assert.equal(request.sourceImages[0].bytes.equals(bytes), true); return { bytes, requestId: "generate-1", modelEvidence: { requestedImageModel: "image-model", gatewayReportedImageModel: "image-model", gatewayReportedImageModelPresent: true, orchestratorModel: "" } }; }, async inspectImage() { return { requestId: "check-1", modelEvidence: { requestedTextModel: "checker", gatewayReportedTextModel: "checker", gatewayReportedTextModelPresent: true }, value: { matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: [], evidence: { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [claim], detectedTexts: ["товар"], language: "ru", qualityFlags: [], prohibitedFlags: [] } } }; } },
  };
  return { input, calls, bindCalls, bytes, asset, fact, claim, gatewayCalls: () => gatewayCalls, loaderCalls: () => loaderCalls };
}

function checkerResponse(fixture, overrides = {}, evidenceOverrides = {}) {
  return {
    requestId: "check-1",
    modelEvidence: { requestedTextModel: "checker", gatewayReportedTextModel: "checker", gatewayReportedTextModelPresent: true },
    value: {
      matchesProduct: true,
      claimsVerified: true,
      russianText: true,
      quality: "PASS",
      prohibitedContent: false,
      reasons: [],
      evidence: {
        identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] },
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

test("generates an accepted slot from server-loaded bytes and does not expose source URLs", async () => {
  const fixture = await setup();
  const result = await generateImageSlot(fixture.input);
  assert.equal(result.accepted, true); assert.equal(fixture.gatewayCalls(), 1);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
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

test("direct accepted reuse binds persisted references to the immutable selected asset identity", async () => {
  const first = await setup();
  const accepted = structuredClone(await generateImageSlot(first.input));
  accepted.sourceAssetEvidence[0].assetId = "asset-z";
  accepted.checkerEvidence.sourceAssets[0].assetId = "asset-z";
  accepted.checkerEvidence.checkerResult.evidence.identity.sourceAssetIds = ["asset-z"];
  const rebuilt = buildImageGenerationInput({ ...first.input, references: accepted.sourceAssetEvidence });
  accepted.inputHash = rebuilt.inputHash;
  accepted.promptHash = rebuilt.promptHash;
  accepted.objectKey = buildGeneratedAssetObjectKey({ ...scope, inputHash: rebuilt.inputHash, contentHash: accepted.contentHash });
  const replay = await setup({ existing: accepted });
  await assert.rejects(generateImageSlot(replay.input), (error) => error?.code === "AUTO_LISTING_IMAGE_EXISTING_CORRUPT");
  assert.equal(replay.loaderCalls(), 0);
});

test("required bind port is fenced before reservation or source loading", async () => {
  for (const method of ["bindGenerationAttemptInput", "findStoredGenerationAsset", "recordStoredGenerationAsset", "recordAssetCleanupRequired", "completeGenerationAttempt", "rejectGenerationAttempt", "failGenerationAttempt", "blockItem", "countAcceptedAssets"]) {
    const fixture = await setup();
    delete fixture.input.repository[method];
    const effects = [];
    fixture.input.repository.reserveGenerationAttempt = async () => { effects.push("reserve"); return reserved(); };
    fixture.input.sourceAssetLoader.loadSourceAsset = async () => { effects.push("load"); throw new Error("must not load"); };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_INPUT_INVALID", method);
    assert.deepEqual(effects, [], method);
  }
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

test("source loading failure is terminalized through its lease and final exhaustion blocks MAIN", async () => {
  const fixture = await setup();
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  let blocks = 0; fixture.input.repository.blockItem = async () => { blocks += 1; };
  fixture.input.sourceAssetLoader.loadSourceAsset = async () => { throw new Error("network detail must not escape"); };
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_UNAVAILABLE" && error?.retryable === false && error?.itemOutcome === "BLOCKED");
  assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls.map(([name]) => name), ["failed"]); assert.equal(blocks, 1);
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
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-3", "asset-1"] } });
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

test("gateway size is the exact validated ratio-resolution contract and is frozen in accepted evidence", async () => {
  const fixture = await setup();
  const generate = fixture.input.gateway.generateImage;
  fixture.input.gateway.generateImage = async (request) => { assert.equal(request.size, "768x1024"); return generate(request); };
  const accepted = await generateImageSlot(fixture.input);
  assert.equal(accepted.generationSize, "768x1024");
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
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_IMAGE_RESERVATION_FAILED");
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

test("main image and minimum-six policy blocks only the item while valid sibling coverage remains ready", () => {
  const slots = ["main", "a", "b", "c", "d", "e", "f"].map((slotKey, index) => ({ slotKey, role: index === 0 ? "MAIN" : "DETAIL" }));
  assert.deepEqual(summarizeGeneratedImageSlots({ slots, results: slots.slice(1).map(({ slotKey }) => ({ slotKey, accepted: true })) }), { status: "BLOCKED", code: "MAIN_IMAGE_REQUIRED", acceptedSlotKeys: ["a", "b", "c", "d", "e", "f"] });
  assert.deepEqual(summarizeGeneratedImageSlots({ slots, results: slots.slice(0, 6).map(({ slotKey }) => ({ slotKey, accepted: true })) }), { status: "READY", acceptedSlotKeys: ["a", "b", "c", "d", "e", "main"] });
  assert.deepEqual(summarizeGeneratedImageSlots({ slots, results: slots.slice(0, 5).map(({ slotKey }) => ({ slotKey, accepted: true })) }), { status: "BLOCKED", code: "MINIMUM_IMAGE_COUNT_NOT_MET", acceptedSlotKeys: ["a", "b", "c", "d", "main"] });
  assert.throws(() => summarizeGeneratedImageSlots({ slots, results: [{ slotKey: "main", accepted: true }], minimumAccepted: 5 }), (error) => error?.code === "AUTO_LISTING_IMAGE_INPUT_INVALID");
  assert.deepEqual(summarizeGeneratedImageSlots({ slots: [{ slotKey: "main", role: "MAIN" }], results: [{ slotKey: "main", accepted: true }] }), { status: "BLOCKED", code: "MINIMUM_IMAGE_COUNT_NOT_MET", acceptedSlotKeys: ["main"] });
});

test("an occupied lease has no external call and gateway failure is terminalized through its own lease token", async () => {
  const occupied = await setup();
  occupied.input.repository.reserveGenerationAttempt = async () => ({ status: "IN_PROGRESS" });
  await assert.rejects(generateImageSlot(occupied.input), (error) => error?.code === "AUTO_LISTING_IMAGE_RESERVATION_FAILED" && error?.retryable === true);
  assert.equal(occupied.loaderCalls(), 0); assert.equal(occupied.gatewayCalls(), 0);

  const failing = await setup();
  failing.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; throw error; };
  await assert.rejects(generateImageSlot(failing.input), (error) => error?.code === "AI_GATEWAY_UNAVAILABLE");
  assert.deepEqual(failing.calls.map(([name]) => name), ["failed"]);
  assert.equal(failing.calls[0][1].leaseToken, "lease-a");
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
    ["DETAIL", "checker", 5, "ITEM_INCOMPLETE", "CHECKER_UNAVAILABLE"],
    ["MAIN", "exhausted", 0, "BLOCKED", "AUTO_LISTING_IMAGE_ATTEMPTS_EXHAUSTED"],
  ]) {
    const fixture = await setup();
    fixture.input.slot = { ...fixture.input.slot, role };
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    fixture.input.repository.reserveGenerationAttempt = async () => failureKind === "exhausted"
      ? { status: "ATTEMPTS_EXHAUSTED" }
      : reserved(3);
    let blocks = 0;
    fixture.input.repository.blockItem = async () => { blocks += 1; };
    fixture.input.repository.countAcceptedAssets = async () => acceptedCount;
    if (failureKind === "transport") fixture.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; throw error; };
    if (failureKind === "storage") fixture.input.storage.putObjectFromBuffer = async () => { const error = new Error("temporary"); error.code = "offline"; throw error; };
    if (failureKind === "checker") fixture.input.gateway.inspectImage = async () => { const error = new Error("temporary"); error.requestId = "checker-failed-1"; throw error; };
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === expectedCode && error?.itemOutcome === expectedOutcome);
    assert.equal(blocks, role === "MAIN" ? 1 : 0);
  }
});

test("checker policy rejection uses the reserved attempt and remains distinct from retryable transport failure", async () => {
  const fixture = await setup();
  fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] } });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error?.retryable === true);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "rejected"]);
  assert.equal(fixture.calls[1][1].leaseToken, "lease-a");
});

test("final policy failure blocks MAIN once, while non-main only reports bounded coverage and never touches siblings", async () => {
  for (const [role, attemptNo, count, outcome, blocked] of [["MAIN", 1, 0, undefined, 0], ["MAIN", 3, 0, "BLOCKED", 1], ["DETAIL", 3, 5, "ITEM_INCOMPLETE", 0], ["DETAIL", 3, 6, "CONTINUE_WITHOUT_SLOT", 0]]) {
    const fixture = await setup(); fixture.input.slot = { ...fixture.input.slot, role };
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    fixture.input.repository.reserveGenerationAttempt = async () => reserved(attemptNo);
    let blocks = 0; fixture.input.repository.blockItem = async () => { blocks += 1; }; fixture.input.repository.countAcceptedAssets = async () => count;
    fixture.input.gateway.inspectImage = async () => checkerResponse(fixture, {}, { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, detectedTexts: [] });
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error.itemOutcome === outcome && error.retryable === (attemptNo < 3));
    assert.equal(blocks, blocked); assert.equal(fixture.calls.filter(([name]) => name === "rejected").length, 1);
    assert.equal(fixture.calls.find(([name]) => name === "rejected")[1].retryable, attemptNo < 3);
  }
});

test("a max-attempt transport failure is persisted as non-retryable before item finalization", async () => {
  const fixture = await setup();
  fixture.input.repository.reserveGenerationAttempt = async () => reserved(3);
  fixture.input.repository.blockItem = async () => {};
  fixture.input.gateway.generateImage = async () => { const value = new Error("offline"); value.code = "AI_GATEWAY_UNAVAILABLE"; value.retryable = true; throw value; };
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.retryable === false);
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

test("every accepted audit column is fail-closed on a corrupt completion row", async () => {
  for (const field of ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "attemptIdentityHash", "inputHash", "role", "generationSize", "contentHash", "objectKey", "contentType", "width", "height", "size", "gatewayRequestId", "checkerRequestId", "modelEvidence", "profileId", "profileVersion", "modelName", "planHash", "sourceHash", "strategyHash", "configHash", "visualGroupsHash", "promptTemplateVersion", "promptHash", "checkerEvidence", "sourceAssetEvidence", "regeneration"]) {
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
    (row) => { row.promptHash = "0".repeat(64); },
    (row) => { row.sourceAssetEvidence = []; },
    (row) => { row.checkerEvidence = { ...row.checkerEvidence, generatedHash: "0".repeat(64) }; },
    (row) => { row.checkerEvidence.checkerResult.matchesProduct = false; },
    (row) => { row.checkerEvidence.checkerResult.claimsVerified = false; },
    (row) => { row.checkerEvidence.checkerResult.russianText = false; },
    (row) => { row.checkerEvidence.checkerResult.quality = "FAIL"; },
    (row) => { row.checkerEvidence.checkerResult.prohibitedContent = true; },
    (row) => { row.checkerEvidence.checkerResult.reasons = ["corrupt"]; },
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
