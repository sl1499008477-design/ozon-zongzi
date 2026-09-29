import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

const H = (digit) => digit.repeat(64);
const png = (color) => sharp({
  create: { width: 32, height: 24, channels: 3, background: color },
}).png().toBuffer();

function scope(overrides = {}) {
  return {
    accountId: "account-a", jobId: "job-a", itemId: "item-a", analysisRunId: "run-a",
    sourceAssetId: "asset-a", expectedStatusVersion: 7,
    derivativeAttemptId: "source-cleanup-attempt-a-1", inputHash: H("1"), attemptNo: 1,
    ...overrides,
  };
}

function editEvidence(bytes, overrides = {}) {
  return {
    bytes,
    requestId: "edit-request-a",
    modelEvidence: {
      requestedImageModel: "gpt-image-2", gatewayReportedImageModel: "gpt-image-2",
      gatewayReportedImageModelPresent: true, orchestratorModel: "",
    },
    gatewayConnectionId: "connection-a", gatewayConnectionVersion: 2,
    ...overrides,
  };
}

test("derivative store writes a versioned immutable object then reads and hash-verifies it", async () => {
  const {
    buildSourceImageDerivativeObjectKey,
    storeSourceImageDerivative,
  } = await import("../auto-listing-source-image-derivative-store.mjs");
  const bytes = await png({ r: 240, g: 10, b: 10 });
  const objects = new Map();
  const recorded = [];
  const removals = [];
  const storage = {
    async putObjectFromBuffer({ key, buffer, contentType }) {
      objects.set(key, Buffer.from(buffer));
      return { key, sha256: (await import("../auto-listing-asset-store.mjs")).sha256(buffer), contentType, size: buffer.length };
    },
    async getObjectBuffer(key) { return Buffer.from(objects.get(key)); },
    async removeObject(key) { removals.push(key); objects.delete(key); },
  };
  const repository = {
    async recordGeneratedCandidate(value) {
      recorded.push(value);
      const { editGatewayConnectionId, editGatewayConnectionVersion, ...projection } = value;
      return {
        ...projection,
        editModelEvidence: {
          orchestratorModel: value.editModelEvidence.orchestratorModel,
          gatewayReportedImageModelPresent: value.editModelEvidence.gatewayReportedImageModelPresent,
          gatewayReportedImageModel: value.editModelEvidence.gatewayReportedImageModel,
          requestedImageModel: value.editModelEvidence.requestedImageModel,
        },
        status: "GENERATED",
        editGatewayConnection: editGatewayConnectionId == null ? null : {
          id: editGatewayConnectionId,
          version: editGatewayConnectionVersion,
        },
      };
    },
  };

  const stored = await storeSourceImageDerivative({
    scope: scope(), originalContentHash: H("2"), generated: editEvidence(bytes), storage, repository,
  });

  assert.equal(stored.status, "GENERATED");
  assert.equal(stored.generatedObjectKey, buildSourceImageDerivativeObjectKey({
    ...scope(), contentHash: stored.generatedContentHash, contentType: "image/png",
  }));
  assert.equal(objects.get(stored.generatedObjectKey).equals(bytes), true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].generatedWidth, 32);
  assert.equal(recorded[0].generatedHeight, 24);
  assert.deepEqual(removals, []);
});

test("a repository failure after object write removes the object or records a cleanup obligation", async () => {
  const { storeSourceImageDerivative } = await import("../auto-listing-source-image-derivative-store.mjs");
  const bytes = await png({ r: 10, g: 20, b: 240 });
  const cleanup = [];
  const storage = {
    async putObjectFromBuffer({ key, buffer, contentType }) {
      return { key, sha256: (await import("../auto-listing-asset-store.mjs")).sha256(buffer), contentType, size: buffer.length };
    },
    async getObjectBuffer() { return Buffer.from(bytes); },
    async removeObject() { throw new Error("storage delete unavailable"); },
  };
  await assert.rejects(storeSourceImageDerivative({
    scope: scope(), originalContentHash: H("2"), generated: editEvidence(bytes), storage,
    repository: { async recordGeneratedCandidate() { throw new Error("database unavailable"); } },
    cleanupRecorder: {
      async recordDerivativeCleanupRequired(value) { cleanup.push(value); return { ...value, status: "PENDING" }; },
    },
  }), { code: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED", retryable: true });
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].reasonCode, "SOURCE_IMAGE_DERIVATIVE_UNREFERENCED");
});
