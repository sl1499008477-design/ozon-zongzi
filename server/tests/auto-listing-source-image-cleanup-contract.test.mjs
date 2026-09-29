import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const H = (digit) => digit.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

function cleanupInput(overrides = {}) {
  return {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_V1",
    derivativeAttemptId: "source-cleanup-attempt-1",
    sourceAssetId: "source-asset-1",
    originalContentHash: H("a"),
    attemptNo: 1,
    externalRegions: [{ x: 0.02, y: 0.02, width: 0.2, height: 0.08 }],
    protectedRegions: [{ x: 0.3, y: 0.3, width: 0.4, height: 0.3 }],
    previousReasonCodes: [],
    ...overrides,
  };
}

function cleanupCheck(overrides = {}) {
  return {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1",
    derivativeAttemptId: "source-cleanup-attempt-1",
    sourceAssetId: "source-asset-1",
    originalContentHash: H("a"),
    candidateContentHash: H("b"),
    overlayRemoved: true,
    productIdentityPreserved: true,
    nativeMarksPreserved: true,
    geometryPreserved: true,
    noInventedContent: true,
    reasonCodes: [],
    ...overrides,
  };
}

function assessment(overrides = {}) {
  const value = {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
    sourceAssetId: "source-asset-1", sourceOrdinal: 0, objectKey: "source/a.png",
    contentHash: H("a"), parentSourceAssetId: null, terminalStatus: "ANALYZED",
    contentKinds: ["PRODUCT_VIEW"],
    viewpoints: [{ kind: "FRONT", confidence: "CONFIRMED", reasonCodes: [] }],
    subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    quality: { confidence: "CONFIRMED", usable: true, reasonCodes: [] },
    ocrRegions: [], semanticTextRegions: [],
    markings: [
      { kind: "EXTERNAL_OVERLAY", region: { x: 0.02, y: 0.02, width: 0.2, height: 0.08 }, confidence: "CONFIRMED", reasonCodes: ["FIXED_CANVAS_POSITION"] },
      { kind: "PRODUCT_MARKING", region: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 }, confidence: "CONFIRMED", reasonCodes: ["SURFACE_PERSPECTIVE"] },
    ],
    perceptualDuplicateGroup: null, duplicateOfSourceAssetId: null,
    eligibleUses: ["IDENTITY_ANCHOR", "TARGET_VIEW"], reasonCodes: [],
    ...overrides,
  };
  return { ...value, assessmentHash: digest(value) };
}

test("cleanup input requires external regions that do not materially overlap protected native markings", async () => {
  const {
    sourceImageCleanupInputHash,
    verifySourceImageCleanupInput,
  } = await import("../auto-listing-source-image-cleanup-contract.mjs");
  const verified = verifySourceImageCleanupInput(cleanupInput());

  assert.equal(Object.isFrozen(verified), true);
  assert.equal(sourceImageCleanupInputHash(verified), digest(verified));
  assert.throws(() => verifySourceImageCleanupInput(cleanupInput({ externalRegions: [] })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_INPUT_INVALID",
  });
  assert.throws(() => verifySourceImageCleanupInput(cleanupInput({
    externalRegions: [{ x: 0.35, y: 0.35, width: 0.2, height: 0.15 }],
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_PROTECTED_REGION_OVERLAP" });
});

test("cleanup check is hashable and accepted only when every preservation boolean is true", async () => {
  const {
    sourceImageCleanupCheckAccepted,
    sourceImageCleanupEvidenceHash,
    verifySourceImageCleanupCheck,
  } = await import("../auto-listing-source-image-cleanup-contract.mjs");
  const accepted = verifySourceImageCleanupCheck(cleanupCheck());
  assert.equal(sourceImageCleanupCheckAccepted(accepted), true);
  assert.equal(sourceImageCleanupEvidenceHash(accepted), digest(accepted));

  const rejected = verifySourceImageCleanupCheck(cleanupCheck({
    nativeMarksPreserved: false,
    reasonCodes: ["SOURCE_IMAGE_CLEANUP_NATIVE_MARK_CHANGED"],
  }));
  assert.equal(sourceImageCleanupCheckAccepted(rejected), false);
  assert.throws(() => verifySourceImageCleanupCheck(cleanupCheck({
    nativeMarksPreserved: false,
    reasonCodes: [],
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_INVALID" });
});

test("derives one deterministic cleanup attempt only for useful V2 appearance evidence with confirmed overlays", async () => {
  const {
    deriveSourceImageCleanupAttempt,
    sourceImageCleanupCandidate,
  } = await import("../auto-listing-source-image-cleanup-contract.mjs");
  const source = assessment();
  const candidate = sourceImageCleanupCandidate(source);
  assert.deepEqual(candidate, {
    sourceAssetId: "source-asset-1",
    originalContentHash: H("a"),
    externalRegions: [{ x: 0.02, y: 0.02, width: 0.2, height: 0.08 }],
    protectedRegions: [{ x: 0.3, y: 0.3, width: 0.4, height: 0.3 }],
  });

  const scope = {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
    expectedStatusVersion: 7, assessment: source, attemptNo: 1, previousReasonCodes: [],
  };
  const first = deriveSourceImageCleanupAttempt(scope);
  assert.deepEqual(deriveSourceImageCleanupAttempt(structuredClone(scope)), first);
  assert.match(first.derivativeAttemptId, /^source-image-derivative-[a-f0-9]{32}$/u);
  assert.equal(first.cleanupInput.derivativeAttemptId, first.derivativeAttemptId);
  assert.equal(first.inputHash, digest(first.cleanupInput));
  assert.equal(first.attemptNo, 1);

  const retry = deriveSourceImageCleanupAttempt({
    ...scope, attemptNo: 2, previousReasonCodes: ["OVERLAY_REMAINS"],
  });
  assert.notEqual(retry.derivativeAttemptId, first.derivativeAttemptId);
  assert.notEqual(retry.inputHash, first.inputHash);
  assert.deepEqual(retry.cleanupInput.previousReasonCodes, ["OVERLAY_REMAINS"]);

  assert.equal(sourceImageCleanupCandidate(assessment({
    contentKinds: ["TEXT_ONLY"], viewpoints: [], subjectBounds: null,
    eligibleUses: ["TEXT_FACT"], markings: [],
  })), null);
});
