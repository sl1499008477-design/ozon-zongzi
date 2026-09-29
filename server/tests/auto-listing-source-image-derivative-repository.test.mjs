import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const H = (digit) => digit.repeat(64);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

function reserveInput(overrides = {}) {
  return {
    accountId: "account-a",
    jobId: "job-a",
    itemId: "item-a",
    analysisRunId: "run-a",
    sourceAssetId: "asset-a",
    expectedStatusVersion: 7,
    derivativeAttemptId: "source-cleanup-attempt-a-1",
    inputHash: H("1"),
    attemptNo: 1,
    originalContentHash: H("2"),
    overlayDecisionHash: H("3"),
    promptVersion: "source-cleanup-prompt-v1",
    ...overrides,
  };
}

function scope(overrides = {}) {
  const reserved = reserveInput(overrides);
  return Object.fromEntries([
    "accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId",
    "expectedStatusVersion", "derivativeAttemptId",
  ].map((key) => [key, reserved[key]]));
}

function generatedEvidence(overrides = {}) {
  return {
    ...scope(overrides),
    generatedObjectKey: "auto-listing/source-derivative/v1/account-a/job-a/item-a/run-a/asset-a/attempt-1/candidate.png",
    generatedContentHash: H("4"),
    generatedContentType: "image/png",
    generatedWidth: 1024,
    generatedHeight: 1024,
    generatedSizeBytes: 4096,
    editGatewayRequestId: "edit-request-a",
    editModelEvidence: {
      requestedImageModel: "gpt-image-2",
      gatewayReportedImageModel: "gpt-image-2",
      gatewayReportedImageModelPresent: true,
      orchestratorModel: "",
    },
    editGatewayConnectionId: "connection-a",
    editGatewayConnectionVersion: 2,
    ...overrides,
  };
}

function cleanupCheck(overrides = {}) {
  return {
    contractVersion: "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1",
    derivativeAttemptId: "source-cleanup-attempt-a-1",
    sourceAssetId: "asset-a",
    originalContentHash: H("2"),
    candidateContentHash: H("4"),
    overlayRemoved: true,
    productIdentityPreserved: true,
    nativeMarksPreserved: true,
    geometryPreserved: true,
    noInventedContent: true,
    reasonCodes: [],
    ...overrides,
  };
}

function checkEvidence(overrides = {}) {
  const checkResult = overrides.checkResult ?? cleanupCheck(overrides.cleanupCheckOverrides);
  return {
    ...scope(overrides),
    checkResult,
    cleanupEvidenceHash: digest(checkResult),
    checkerGatewayRequestId: "check-request-a",
    checkerModelEvidence: {
      requestedTextModel: "gpt-5.4",
      gatewayReportedTextModel: "gpt-5.4",
      gatewayReportedTextModelPresent: true,
    },
    checkerGatewayConnectionId: "connection-a",
    checkerGatewayConnectionVersion: 2,
    ...overrides,
  };
}

async function moduleUnderTest() {
  return import(`../auto-listing-source-image-derivative-repository.mjs?test=${Date.now()}-${Math.random()}`);
}

async function repository() {
  const { createAutoListingSourceImageDerivativeRepository } = await moduleUnderTest();
  let nextId = 0;
  return createAutoListingSourceImageDerivativeRepository({
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    id: () => `source-image-derivative-row-${++nextId}`,
    leaseToken: () => `source-image-derivative-lease-${nextId}`,
  });
}

test("reserve is idempotent inside the exact account job item run source and attempt scope", async () => {
  const store = await repository();
  const first = await store.reserveAttempt(reserveInput());
  const replay = await store.reserveAttempt(reserveInput());

  assert.deepEqual(replay, first);
  assert.equal(first.status, "RESERVED");
  assert.equal(first.derivativeAttemptId, "source-cleanup-attempt-a-1");
  assert.equal(first.attemptNo, 1);
  assert.equal(first.originalContentHash, H("2"));
  assert.equal(await store.loadAttempt(scope({ accountId: "account-b" })), null);
});

test("a generated row is replayed for checking without reserving or generating again", async () => {
  const store = await repository();
  await store.reserveAttempt(reserveInput());
  const generated = await store.recordGeneratedCandidate(generatedEvidence());

  assert.equal(generated.status, "GENERATED");
  assert.deepEqual(await store.recordGeneratedCandidate(generatedEvidence()), generated);
  assert.deepEqual(await store.loadAttempt(scope()), generated);
  assert.equal(generated.generatedContentHash, H("4"));
  assert.equal(generated.editGatewayRequestId, "edit-request-a");
});

test("accepted cleanup is terminal immutable and becomes the only appearance binding", async () => {
  const store = await repository();
  await store.reserveAttempt(reserveInput());
  await store.recordGeneratedCandidate(generatedEvidence());
  const accepted = await store.recordCheckResult(checkEvidence());

  assert.equal(accepted.status, "ACCEPTED");
  assert.deepEqual(await store.recordCheckResult(checkEvidence()), accepted);
  assert.deepEqual(await store.listAcceptedBindings({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
  }), [{
    sourceAssetId: "asset-a",
    mode: "CLEANED",
    effectiveContentHash: H("4"),
    derivativeAttemptId: "source-cleanup-attempt-a-1",
    cleanupEvidenceHash: digest(cleanupCheck()),
  }]);

  await assert.rejects(store.recordGeneratedCandidate(generatedEvidence({ generatedContentHash: H("5") })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_TERMINAL",
  });
});

test("a failed business check is a rejected immutable attempt", async () => {
  const store = await repository();
  await store.reserveAttempt(reserveInput());
  await store.recordGeneratedCandidate(generatedEvidence());
  const rejectedResult = cleanupCheck({
    overlayRemoved: false,
    reasonCodes: ["SOURCE_IMAGE_CLEANUP_OVERLAY_REMAINS"],
  });
  const rejected = await store.recordCheckResult(checkEvidence({
    checkResult: rejectedResult,
    cleanupEvidenceHash: digest(rejectedResult),
  }));

  assert.equal(rejected.status, "REJECTED");
  assert.deepEqual(await store.listAcceptedBindings({
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
  }), []);
});

test("attempt four cross-account mutation and a second accepted derivative are rejected", async () => {
  const store = await repository();
  await assert.rejects(store.reserveAttempt(reserveInput({
    attemptNo: 4,
    derivativeAttemptId: "source-cleanup-attempt-a-4",
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_INPUT_INVALID" });

  await store.reserveAttempt(reserveInput());
  await assert.rejects(store.recordGeneratedCandidate(generatedEvidence({ accountId: "account-b" })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_NOT_FOUND",
  });
  await store.recordGeneratedCandidate(generatedEvidence());
  await store.recordCheckResult(checkEvidence());

  await store.reserveAttempt(reserveInput({
    attemptNo: 2,
    derivativeAttemptId: "source-cleanup-attempt-a-2",
    inputHash: H("5"),
  }));
  await store.recordGeneratedCandidate(generatedEvidence({
    derivativeAttemptId: "source-cleanup-attempt-a-2",
    generatedContentHash: H("6"),
  }));
  const secondCheck = cleanupCheck({
    derivativeAttemptId: "source-cleanup-attempt-a-2",
    candidateContentHash: H("6"),
  });
  await assert.rejects(store.recordCheckResult(checkEvidence({
    derivativeAttemptId: "source-cleanup-attempt-a-2",
    checkResult: secondCheck,
    cleanupEvidenceHash: digest(secondCheck),
  })), { code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_ACCEPTED_CONFLICT" });
});

test("same attempt identity cannot be reserved with different immutable input", async () => {
  const store = await repository();
  await store.reserveAttempt(reserveInput());

  await assert.rejects(store.reserveAttempt(reserveInput({ overlayDecisionHash: H("9") })), {
    code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CONFLICT",
  });
});

