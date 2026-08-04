import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";
import { generateImageSlot, summarizeGeneratedImageSlots } from "../auto-listing-image-generator.mjs";

const scope = Object.freeze({ accountId: "account-a", jobId: "job-a", itemId: "item-a", planId: "plan-a", visualGroupKey: "main", slotKey: "cover" });
const planHash = "a".repeat(64);
async function image() { return sharp({ create: { width: 768, height: 1024, channels: 4, background: "#445566" } }).png().toBuffer(); }
async function setup({ loaderEvidence = "SOURCE_URL", existing = null } = {}) {
  const bytes = await image(); const asset = { assetId: "asset-a", sourceRef: "https://private.example.test/source.png", evidenceKind: "SOURCE_URL" };
  let gatewayCalls = 0; const calls = [];
  const input = {
    scope, plan: { id: scope.planId, sourceAccountId: scope.accountId, planHash, sourceHash: "b".repeat(64), strategyHash: "c".repeat(64), configHash: "d".repeat(64), visualGroupsHash: "e".repeat(64), visualGroups: { groups: [{ visualGroupKey: "main", referenceImages: [asset] }] }, plan: { slots: [{ slotKey: "cover", visualGroupKey: "main", role: "MAIN", preserve: ["shape"] }] }, factRegistry: [{ factId: "f1", kind: "IDENTITY_NAME", visualGroupKeys: ["main"], value: "red product" }] },
    slot: { slotKey: "cover", visualGroupKey: "main", role: "MAIN", preserve: ["shape"] }, profile: { id: "profile-a", configVersion: 3, textModel: "checker" }, imageModel: "image-model", ratio: "3:4", resolution: "1K", quality: "high", templateVersion: "image-v1",
    sourceAssetLoader: { async loadSourceAsset(request) { assert.equal(request.sourceRef, asset.sourceRef); return { assetId: asset.assetId, sourceRef: asset.sourceRef, evidenceKind: loaderEvidence, bytes, contentType: "image/png", width: 768, height: 1024 }; } },
    repository: {
      async reserveGenerationAttempt() { return existing ? { status: "EXISTING_ACCEPTED", record: existing } : { status: "RESERVED", attemptNo: 1, leaseToken: "lease-a" }; },
      async recordStoredGenerationAsset(value) { calls.push(["stored", value]); }, async completeGenerationAttempt(value) { calls.push(["complete", value]); return { status: "ACCEPTED", accepted: true, ...value }; }, async rejectGenerationAttempt(value) { calls.push(["rejected", value]); },
      async failGenerationAttempt(value) { calls.push(["failed", value]); }, async releaseGenerationLease(value) { calls.push(["release", value]); },
    },
    storage: { async putObjectFromBuffer(value) { return { key: value.key, sha256: sha256(value.buffer), contentType: value.contentType, size: value.buffer.length }; } },
    gateway: { async generateImage(request) { gatewayCalls += 1; assert.doesNotMatch(request.prompt, /https:\/\//); assert.equal(request.sourceImages[0].bytes.equals(bytes), true); return { bytes, requestId: "generate-1" }; }, async inspectImage() { return { requestId: "check-1", value: { matchesProduct: true, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: [], evidence: { identity: { color: true, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [{ text: "red product", sourceFactIds: ["f1"] }], detectedTexts: ["товар"], language: "ru", qualityFlags: [], prohibitedFlags: [] } } }; } },
  };
  return { input, calls, gatewayCalls: () => gatewayCalls };
}

test("generates an accepted slot from server-loaded bytes and does not expose source URLs", async () => {
  const fixture = await setup();
  const result = await generateImageSlot(fixture.input);
  assert.equal(result.accepted, true); assert.equal(fixture.gatewayCalls(), 1);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "complete"]);
});

test("reuses a fully audited accepted attempt for the same slot and input without an image call", async () => {
  const first = await setup();
  const accepted = await generateImageSlot(first.input);
  const replay = await setup({ existing: { ...accepted, status: "ACCEPTED" } });
  const reused = await generateImageSlot(replay.input);
  assert.equal(reused.status, "ACCEPTED");
  assert.equal(replay.gatewayCalls(), 0);
});

test("rejects mismatched source evidence before reserving or calling an image gateway", async () => {
  const fixture = await setup({ loaderEvidence: "CONTENT_HASH" });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_INVALID");
  assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls, []);
});

test("source loading failure is safe, retryable, and happens before any lease or gateway side effect", async () => {
  const fixture = await setup();
  fixture.input.sourceAssetLoader.loadSourceAsset = async () => { throw new Error("network detail must not escape"); };
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "AUTO_LISTING_SOURCE_ASSET_UNAVAILABLE" && error?.retryable === true);
  assert.equal(fixture.gatewayCalls(), 0); assert.deepEqual(fixture.calls, []);
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
});

test("an occupied lease has no external call and gateway failure is terminalized through its own lease token", async () => {
  const occupied = await setup();
  occupied.input.repository.reserveGenerationAttempt = async () => ({ status: "IN_PROGRESS" });
  await assert.rejects(generateImageSlot(occupied.input), (error) => error?.code === "AUTO_LISTING_IMAGE_RESERVATION_FAILED" && error?.retryable === true);
  assert.equal(occupied.gatewayCalls(), 0);

  const failing = await setup();
  failing.input.gateway.generateImage = async () => { const error = new Error("temporary"); error.code = "AI_GATEWAY_UNAVAILABLE"; error.retryable = true; throw error; };
  await assert.rejects(generateImageSlot(failing.input), (error) => error?.code === "AI_GATEWAY_UNAVAILABLE");
  assert.deepEqual(failing.calls.map(([name]) => name), ["failed", "release"]);
  assert.equal(failing.calls[0][1].leaseToken, "lease-a");
});

test("checker policy rejection uses the reserved attempt and remains distinct from retryable transport failure", async () => {
  const fixture = await setup();
  fixture.input.gateway.inspectImage = async () => ({ value: { matchesProduct: false, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: ["identity"], evidence: { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [{ text: "red product", sourceFactIds: ["f1"] }], detectedTexts: ["товар"], language: "ru", qualityFlags: [], prohibitedFlags: [] } } });
  await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error?.retryable === false);
  assert.deepEqual(fixture.calls.map(([name]) => name), ["stored", "rejected", "release"]);
  assert.equal(fixture.calls[1][1].leaseToken, "lease-a");
});

test("final policy failure blocks MAIN once, while non-main only reports bounded coverage and never touches siblings", async () => {
  for (const [role, attemptNo, count, outcome, blocked] of [["MAIN", 1, 0, undefined, 0], ["MAIN", 3, 0, "BLOCKED", 1], ["DETAIL", 3, 5, "ITEM_INCOMPLETE", 0], ["DETAIL", 3, 6, "CONTINUE_WITHOUT_SLOT", 0]]) {
    const fixture = await setup(); fixture.input.slot = { ...fixture.input.slot, role };
    fixture.input.plan.plan.slots = [{ ...fixture.input.slot }];
    fixture.input.repository.reserveGenerationAttempt = async () => ({ status: "RESERVED", attemptNo, leaseToken: "lease-a" });
    let blocks = 0; fixture.input.repository.blockItem = async () => { blocks += 1; }; fixture.input.repository.countAcceptedAssets = async () => count;
    fixture.input.gateway.inspectImage = async () => ({ value: { matchesProduct: false, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: ["identity"], evidence: { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [{ text: "red product", sourceFactIds: ["f1"] }], detectedTexts: [], language: "ru", qualityFlags: [], prohibitedFlags: [] } } });
    await assert.rejects(generateImageSlot(fixture.input), (error) => error?.code === "PRODUCT_IDENTITY_MISMATCH" && error.itemOutcome === outcome);
    assert.equal(blocks, blocked); assert.equal(fixture.calls.filter(([name]) => name === "rejected").length, 1);
  }
});

test("checker transport and reject-record failure remain recoverable and never trigger final item policy", async () => {
  const transport = await setup(); transport.input.repository.blockItem = async () => { throw new Error("must not block"); };
  transport.input.gateway.inspectImage = async () => { throw new Error("temporary"); };
  await assert.rejects(generateImageSlot(transport.input), (error) => error?.code === "CHECKER_UNAVAILABLE" && error?.retryable === true);
  const rejectFailure = await setup(); rejectFailure.input.repository.reserveGenerationAttempt = async () => ({ status: "RESERVED", attemptNo: 3, leaseToken: "lease-a" });
  rejectFailure.input.repository.rejectGenerationAttempt = async () => { throw new Error("db unavailable"); };
  rejectFailure.input.repository.blockItem = async () => { throw new Error("must not block"); };
  rejectFailure.input.gateway.inspectImage = async () => ({ value: { matchesProduct: false, claimsVerified: true, russianText: true, quality: "PASS", prohibitedContent: false, reasons: [], evidence: { identity: { color: false, shape: true, accessoryCount: true, sourceAssetIds: ["asset-a"] }, claims: [{ text: "red product", sourceFactIds: ["f1"] }], detectedTexts: [], language: "ru", qualityFlags: [], prohibitedFlags: [] } } });
  await assert.rejects(generateImageSlot(rejectFailure.input), /db unavailable/);
});

test("every accepted audit column is fail-closed on a corrupt completion row", async () => {
  for (const field of ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "inputHash", "contentHash", "objectKey", "contentType", "width", "height", "profileId", "profileVersion", "modelName", "planHash", "sourceHash", "strategyHash", "configHash", "visualGroupsHash", "promptTemplateVersion", "checkerEvidence", "sourceAssetEvidence"]) {
    const fixture = await setup(); const original = fixture.input.repository.completeGenerationAttempt;
    fixture.input.repository.completeGenerationAttempt = async (value) => { const row = await original(value); row[field] = field === "width" ? 0 : field === "checkerEvidence" ? null : field === "sourceAssetEvidence" ? [] : "corrupt"; return row; };
    await assert.rejects(generateImageSlot(fixture.input), (error) => { assert.equal(error?.code, "AUTO_LISTING_IMAGE_REPOSITORY_FAILED", field); return true; }, field);
  }
});
