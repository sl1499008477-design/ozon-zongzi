import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";

const H = (digit) => digit.repeat(64);
const pngAt = (width, height, color) => sharp({
  create: { width, height, channels: 3, background: color },
}).png().toBuffer();
const png = (color) => pngAt(40, 60, color);

function cleanupInput(originalContentHash) {
  return {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_V1",
    derivativeAttemptId: "source-cleanup-attempt-a-1", sourceAssetId: "asset-a",
    originalContentHash, attemptNo: 1,
    externalRegions: [{ x: 0.02, y: 0.02, width: 0.2, height: 0.08 }],
    protectedRegions: [{ x: 0.3, y: 0.3, width: 0.4, height: 0.3 }],
    previousReasonCodes: [],
  };
}

function scope() {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
    sourceAssetId: "asset-a", expectedStatusVersion: 7,
    derivativeAttemptId: "source-cleanup-attempt-a-1", inputHash: H("1"), attemptNo: 1,
  };
}

test("cleaner stores the original canvas and confines edits to the external-overlay neighborhood", async () => {
  const { cleanSourceImageOverlay } = await import("../auto-listing-source-image-cleaner.mjs");
  const originalBytes = await pngAt(56, 70, { r: 255, g: 255, b: 255 });
  const candidateBytes = await pngAt(1024, 1536, { r: 10, g: 20, b: 30 });
  let gatewayRequest;
  let storedInput;
  const result = await cleanSourceImageOverlay({
    scope: scope(), cleanupInput: cleanupInput(sha256(originalBytes)),
    original: { bytes: originalBytes, contentType: "image/png", contentHash: sha256(originalBytes), width: 56, height: 70 },
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, imageModel: "gpt-image-2" },
    gateway: { async generateImage(request) {
      gatewayRequest = request;
      return { bytes: new Uint8Array(candidateBytes), requestId: "edit-request-a", modelEvidence: {
        requestedImageModel: "gpt-image-2", gatewayReportedImageModel: "gpt-image-2",
        gatewayReportedImageModelPresent: true, orchestratorModel: "",
      } };
    } },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    repository: { async loadAttempt() { return { status: "RESERVED" }; } },
    storeDerivative: async (input) => { storedInput = input; return { status: "GENERATED" }; },
    assertLeaseActive() {},
  });

  assert.equal(result.status, "GENERATED");
  assert.equal(gatewayRequest.model, "gpt-image-2");
  assert.equal(gatewayRequest.sourceImages.length, 1);
  assert.deepEqual(
    await sharp(gatewayRequest.sourceImages[0].bytes).metadata().then(({ width, height }) => ({ width, height })),
    { width: 1024, height: 1536 },
  );
  assert.deepEqual(
    await sharp(gatewayRequest.editMask.bytes).metadata().then(({ width, height, hasAlpha }) => ({ width, height, hasAlpha })),
    { width: 1024, height: 1536, hasAlpha: true },
  );
  const editMask = await sharp(gatewayRequest.editMask.bytes).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => editMask.data[((y * editMask.info.width + x) * 4) + 3];
  assert.equal(alphaAt(40, 170), 0, "the external overlay is transparent so the API edits it");
  assert.equal(alphaAt(900, 1000), 255, "unmasked pixels remain opaque so the API preserves them");
  assert.deepEqual(
    { width: editMask.info.width, height: editMask.info.height },
    { width: 1024, height: 1536 },
  );
  assert.equal(gatewayRequest.size, "1024x1536");
  assert.equal(gatewayRequest.quality, "high");
  assert.equal(gatewayRequest.outputFormat, "png");
  assert.match(gatewayRequest.prompt, /externalRegions/iu);
  assert.match(gatewayRequest.prompt, /product-native Logo|product-native logo/iu);
  assert.match(gatewayRequest.prompt, /geometry/iu);
  assert.match(gatewayRequest.prompt, /camera angle/iu);
  assert.doesNotMatch(gatewayRequest.prompt, /sourceImages\[1\]/u);
  assert.doesNotMatch(gatewayRequest.prompt, /remove[^\n]+protectedRegions/iu);
  const stored = await sharp(storedInput.generated.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: stored.info.width, height: stored.info.height, channels: stored.info.channels },
    { width: 56, height: 70, channels: 3 });
  const pixel = (x, y) => [...stored.data.subarray((y * stored.info.width + x) * 3,
    (y * stored.info.width + x + 1) * 3)];
  assert.deepEqual(pixel(2, 2), [10, 20, 30], "declared external region receives the cleaned pixels");
  assert.deepEqual(pixel(30, 30), [255, 255, 255], "pixels outside the external region remain original");
  assert.deepEqual(pixel(32, 35), [255, 255, 255], "protected product-native region remains original");
});

test("cleaner covers the full overlay edge without crossing a protected product marking", async () => {
  const { cleanSourceImageOverlay } = await import("../auto-listing-source-image-cleaner.mjs");
  const originalBytes = await pngAt(100, 100, { r: 255, g: 255, b: 255 });
  const candidateBytes = await pngAt(1024, 1024, { r: 0, g: 0, b: 0 });
  let storedInput;
  const input = {
    ...cleanupInput(sha256(originalBytes)),
    externalRegions: [{ x: 0.4, y: 0.4, width: 0.1, height: 0.1 }],
    protectedRegions: [{ x: 0.38, y: 0.44, width: 0.02, height: 0.02 }],
  };

  await cleanSourceImageOverlay({
    scope: scope(), cleanupInput: input,
    original: { bytes: originalBytes, contentType: "image/png", contentHash: sha256(originalBytes), width: 100, height: 100 },
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, imageModel: "gpt-image-2" },
    gateway: { async generateImage() {
      return { bytes: new Uint8Array(candidateBytes), requestId: "edit-request-a", modelEvidence: {
        requestedImageModel: "gpt-image-2", gatewayReportedImageModel: "gpt-image-2",
        gatewayReportedImageModelPresent: true, orchestratorModel: "",
      } };
    } },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    repository: { async loadAttempt() { return { status: "RESERVED" }; } },
    storeDerivative: async (stored) => { storedInput = stored; return { status: "GENERATED" }; },
    assertLeaseActive() {},
  });

  const stored = await sharp(storedInput.generated.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...stored.data.subarray((y * stored.info.width + x) * 3,
    (y * stored.info.width + x + 1) * 3)];
  assert.notDeepEqual(pixel(39, 49), [255, 255, 255],
    "a tight OCR box receives a bounded safety margin that removes the visible badge edge");
  assert.deepEqual(pixel(38, 45), [255, 255, 255],
    "the product-native protected marking wins even inside the expanded cleanup margin");
  assert.deepEqual(pixel(35, 45), [255, 255, 255],
    "pixels outside the bounded cleanup margin remain byte-for-byte original");
});

test("cleaner resumes an already generated candidate without another paid image call", async () => {
  const { cleanSourceImageOverlay } = await import("../auto-listing-source-image-cleaner.mjs");
  const originalBytes = await png({ r: 255, g: 255, b: 255 });
  let calls = 0;
  const existing = { status: "GENERATED", generatedContentHash: H("4") };
  const result = await cleanSourceImageOverlay({
    scope: scope(), cleanupInput: cleanupInput(sha256(originalBytes)),
    original: { bytes: originalBytes, contentType: "image/png", contentHash: sha256(originalBytes), width: 40, height: 60 },
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, imageModel: "gpt-image-2" },
    gateway: { async generateImage() { calls += 1; } },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    repository: { async loadAttempt() { return existing; } },
    storeDerivative: async () => { throw new Error("must not store twice"); },
    assertLeaseActive() {},
  });
  assert.deepEqual(result, existing);
  assert.equal(calls, 0);
});
