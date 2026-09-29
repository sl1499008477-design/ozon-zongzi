import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { sha256 } from "../auto-listing-asset-store.mjs";

const png = (color) => sharp({
  create: { width: 32, height: 32, channels: 3, background: color },
}).png().toBuffer();
const imageRecord = (bytes, width = 32, height = 32) => ({
  bytes, contentType: "image/png", contentHash: sha256(bytes), width, height,
});

function scope() {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
    sourceAssetId: "asset-a", expectedStatusVersion: 7,
    derivativeAttemptId: "source-cleanup-attempt-a-1",
  };
}

function gatewayValue(overrides = {}) {
  return {
    overlayRemoved: true, productIdentityPreserved: true, nativeMarksPreserved: true,
    geometryPreserved: true, noInventedContent: true, reasonCodes: [], ...overrides,
  };
}

test("checker compares original and candidate together and accepts only an all-true result", async () => {
  const { checkSourceImageCleanup } = await import("../auto-listing-source-image-cleanup-checker.mjs");
  const originalBytes = await png({ r: 255, g: 255, b: 255 });
  const candidateBytes = await png({ r: 250, g: 250, b: 250 });
  let gatewayRequest;
  let recorded;
  const result = await checkSourceImageCleanup({
    scope: scope(),
    attempt: { ...scope(), status: "GENERATED", originalContentHash: sha256(originalBytes), generatedContentHash: sha256(candidateBytes) },
    original: imageRecord(originalBytes),
    candidate: imageRecord(candidateBytes),
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, textModel: "gpt-5.4" },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    gateway: { async createTextResponse(request) {
      gatewayRequest = request;
      return { requestId: "check-request-a", modelEvidence: {
        requestedTextModel: "gpt-5.4", gatewayReportedTextModel: "gpt-5.4-2026-03-05",
        gatewayReportedTextModelPresent: true,
      }, value: gatewayValue() };
    } },
    repository: { async recordCheckResult(value) { recorded = value; return { ...value, status: "ACCEPTED" }; } },
    assertLeaseActive() {},
  });

  assert.equal(result.status, "ACCEPTED");
  assert.equal(gatewayRequest.sourceImages.length, 2);
  assert.equal(gatewayRequest.sourceImages[0].bytes.equals(originalBytes), true);
  assert.equal(gatewayRequest.sourceImages[1].bytes.equals(candidateBytes), true);
  assert.equal(recorded.checkResult.contractVersion, "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1");
  assert.equal(recorded.checkResult.candidateContentHash, sha256(candidateBytes));
  assert.equal(recorded.cleanupEvidenceHash.length, 64);
});

test("a false checker boolean is an auditable rejection while transport errors remain retryable", async () => {
  const { checkSourceImageCleanup } = await import("../auto-listing-source-image-cleanup-checker.mjs");
  const originalBytes = await png({ r: 255, g: 255, b: 255 });
  const candidateBytes = await png({ r: 250, g: 250, b: 250 });
  const base = {
    scope: scope(),
    attempt: { ...scope(), status: "GENERATED", originalContentHash: sha256(originalBytes), generatedContentHash: sha256(candidateBytes) },
    original: imageRecord(originalBytes),
    candidate: imageRecord(candidateBytes),
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, textModel: "gpt-5.4" },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    assertLeaseActive() {},
  };
  let persistedStatus;
  const rejected = await checkSourceImageCleanup({ ...base,
    gateway: { async createTextResponse() { return {
      requestId: "check-request-a", modelEvidence: {
        requestedTextModel: "gpt-5.4", gatewayReportedTextModel: "gpt-5.4",
        gatewayReportedTextModelPresent: true,
      }, value: gatewayValue({ overlayRemoved: false, reasonCodes: ["SOURCE_IMAGE_CLEANUP_OVERLAY_REMAINS"] }),
    }; } },
    repository: { async recordCheckResult(value) {
      persistedStatus = value.checkResult.overlayRemoved ? "ACCEPTED" : "REJECTED";
      return { ...value, status: persistedStatus };
    } },
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(persistedStatus, "REJECTED");

  const transient = Object.assign(new Error("gateway down"), { code: "AI_GATEWAY_UNAVAILABLE", retryable: true });
  await assert.rejects(checkSourceImageCleanup({ ...base,
    gateway: { async createTextResponse() { throw transient; } },
    repository: { async recordCheckResult() { throw new Error("must not persist"); } },
  }), { code: "AI_GATEWAY_UNAVAILABLE", retryable: true });
});

test("checker rejects a changed canvas size even when the vision response says all checks passed", async () => {
  const { checkSourceImageCleanup } = await import("../auto-listing-source-image-cleanup-checker.mjs");
  const originalBytes = await png({ r: 255, g: 255, b: 255 });
  const candidateBytes = await sharp({
    create: { width: 32, height: 48, channels: 3, background: { r: 250, g: 250, b: 250 } },
  }).png().toBuffer();
  let recorded;
  const result = await checkSourceImageCleanup({
    scope: scope(),
    attempt: { ...scope(), status: "GENERATED", originalContentHash: sha256(originalBytes), generatedContentHash: sha256(candidateBytes) },
    original: imageRecord(originalBytes),
    candidate: imageRecord(candidateBytes, 32, 48),
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, textModel: "gpt-5.4" },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    gateway: { async createTextResponse() { return {
      requestId: "check-request-size", modelEvidence: {
        requestedTextModel: "gpt-5.4", gatewayReportedTextModel: "gpt-5.4-2026-03-05",
        gatewayReportedTextModelPresent: true,
      }, value: gatewayValue(),
    }; } },
    repository: { async recordCheckResult(value) {
      recorded = value;
      return { ...value, status: value.checkResult.geometryPreserved ? "ACCEPTED" : "REJECTED" };
    } },
    assertLeaseActive() {},
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(recorded.checkResult.geometryPreserved, false);
  assert.deepEqual(recorded.checkResult.reasonCodes, ["CANVAS_DIMENSIONS_CHANGED"]);
});

test("contradictory all-true cleanup evidence is a retryable gateway result", async () => {
  const { checkSourceImageCleanup } = await import("../auto-listing-source-image-cleanup-checker.mjs");
  const originalBytes = await png({ r: 255, g: 255, b: 255 });
  const candidateBytes = await png({ r: 250, g: 250, b: 250 });
  await assert.rejects(checkSourceImageCleanup({
    scope: scope(),
    attempt: { ...scope(), status: "GENERATED", originalContentHash: sha256(originalBytes), generatedContentHash: sha256(candidateBytes) },
    original: imageRecord(originalBytes),
    candidate: imageRecord(candidateBytes),
    profile: { id: "profile-a", accountId: "account-a", configVersion: 2, textModel: "gpt-5.4" },
    gatewayExecution: { connectionId: "connection-a", connectionVersion: 2, idleTimeoutMs: 300_000 },
    gateway: { async createTextResponse() { return {
      requestId: "check-request-a", modelEvidence: {
        requestedTextModel: "gpt-5.4", gatewayReportedTextModel: "gpt-5.4-2026-03-05",
        gatewayReportedTextModelPresent: true,
      }, value: gatewayValue({ reasonCodes: ["PROMO_TEXT_REMOVED"] }),
    }; } },
    repository: { async recordCheckResult() { throw new Error("must not persist"); } },
    assertLeaseActive() {},
  }), {
    code: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_GATEWAY_INVALID",
    retryable: true,
  });
});
