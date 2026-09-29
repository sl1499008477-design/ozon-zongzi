import { inspectSourceListingImage, sha256 } from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_EXTENSION = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
});
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const SCOPE_KEYS = [
  "accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId",
  "expectedStatusVersion", "derivativeAttemptId", "inputHash", "attemptNo",
];

function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240 && !/[\u0000-\u001f\u007f/]/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|secret|bearer|authorization|cookie/iu.test(value);
}

function validScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope)
    && ["accountId", "jobId", "itemId", "analysisRunId", "sourceAssetId", "derivativeAttemptId"]
      .every((key) => safeId(scope[key]))
    && HASH.test(scope.inputHash || "")
    && Number.isInteger(scope.attemptNo) && scope.attemptNo >= 1 && scope.attemptNo <= 3
    && Number.isInteger(scope.expectedStatusVersion) && scope.expectedStatusVersion >= 1;
}

const segment = (value) => Buffer.from(value, "utf8").toString("base64url");

export function buildSourceImageDerivativeObjectKey(input = {}) {
  if (!validScope(input) || !HASH.test(input.contentHash || "") || !CONTENT_EXTENSION[input.contentType]) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORE_INPUT_INVALID");
  }
  return [
    "auto-listing", "source-derivative", "v1",
    segment(input.accountId), segment(input.jobId), segment(input.itemId),
    segment(input.analysisRunId), segment(input.sourceAssetId), input.inputHash,
    `attempt-${input.attemptNo}`, `${input.contentHash}.${CONTENT_EXTENSION[input.contentType]}`,
  ].join("/");
}

function validGenerated(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Buffer.isBuffer(value.bytes) && value.bytes.length > 0 && value.bytes.length <= MAX_BYTES
    && safeId(value.requestId) && value.modelEvidence && typeof value.modelEvidence === "object"
    && !Array.isArray(value.modelEvidence)
    && safeId(value.modelEvidence.requestedImageModel)
    && typeof value.modelEvidence.gatewayReportedImageModel === "string"
    && typeof value.modelEvidence.gatewayReportedImageModelPresent === "boolean"
    && (value.modelEvidence.gatewayReportedImageModelPresent
      ? safeId(value.modelEvidence.gatewayReportedImageModel)
      : value.modelEvidence.gatewayReportedImageModel === "")
    && typeof value.modelEvidence.orchestratorModel === "string"
    && ((value.gatewayConnectionId === null && value.gatewayConnectionVersion === null)
      || (safeId(value.gatewayConnectionId) && Number.isInteger(value.gatewayConnectionVersion)
        && value.gatewayConnectionVersion >= 1));
}

function generatedEvidenceValue(recorded, key) {
  if (Object.hasOwn(recorded, key)) return recorded[key];
  if (key === "editGatewayConnectionId") return recorded.editGatewayConnection?.id ?? null;
  if (key === "editGatewayConnectionVersion") return recorded.editGatewayConnection?.version ?? null;
  return undefined;
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

function sameEvidence(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function inspect(bytes) {
  try {
    const value = await inspectSourceListingImage({
      bytes, maxInputBytes: MAX_BYTES, maxInputPixels: MAX_PIXELS,
    });
    if (value.bytes.length > MAX_BYTES || value.width * value.height > MAX_PIXELS) throw new Error("oversized");
    return value;
  } catch {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_DECODE_FAILED");
  }
}

async function cleanupOrRecord({ storage, cleanupRecorder, scope, stored, originalErrorCode }) {
  try {
    if (typeof storage?.removeObject !== "function") throw new Error("missing remove port");
    await storage.removeObject(stored.generatedObjectKey, { accountId: scope.accountId });
    return;
  } catch {}
  const expected = {
    ...Object.fromEntries(SCOPE_KEYS.map((key) => [key, scope[key]])),
    objectKey: stored.generatedObjectKey,
    contentHash: stored.generatedContentHash,
    contentType: stored.generatedContentType,
    width: stored.generatedWidth,
    height: stored.generatedHeight,
    sizeBytes: stored.generatedSizeBytes,
    reasonCode: "SOURCE_IMAGE_DERIVATIVE_UNREFERENCED",
    originalErrorCode,
  };
  let recorded;
  try {
    if (typeof cleanupRecorder?.recordDerivativeCleanupRequired !== "function") throw new Error("missing cleanup port");
    recorded = await cleanupRecorder.recordDerivativeCleanupRequired(expected);
  } catch {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CLEANUP_PERSIST_FAILED", true);
  }
  if (!recorded || recorded.status !== "PENDING"
    || Object.keys(expected).some((key) => JSON.stringify(recorded[key]) !== JSON.stringify(expected[key]))) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_CLEANUP_PERSIST_FAILED", true);
  }
}

export async function storeSourceImageDerivative({
  scope, originalContentHash, generated, storage, repository, cleanupRecorder = null, assertLeaseActive = () => {},
} = {}) {
  if (!validScope(scope) || !HASH.test(originalContentHash || "") || !validGenerated(generated)
    || typeof storage?.putObjectFromBuffer !== "function" || typeof storage?.getObjectBuffer !== "function"
    || typeof repository?.recordGeneratedCandidate !== "function" || typeof assertLeaseActive !== "function") {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORE_INPUT_INVALID");
  }
  assertLeaseActive();
  const inspected = await inspect(generated.bytes);
  const stored = {
    generatedObjectKey: buildSourceImageDerivativeObjectKey({ ...scope, ...inspected }),
    generatedContentHash: inspected.contentHash,
    generatedContentType: inspected.contentType,
    generatedWidth: inspected.width,
    generatedHeight: inspected.height,
    generatedSizeBytes: inspected.bytes.length,
  };
  let putAttempted = false;
  try {
    putAttempted = true;
    const put = await storage.putObjectFromBuffer({
      key: stored.generatedObjectKey,
      name: `${scope.sourceAssetId}-cleaned.${CONTENT_EXTENSION[inspected.contentType]}`,
      contentType: inspected.contentType,
      buffer: inspected.bytes,
      maxBytes: MAX_BYTES,
    });
    assertLeaseActive();
    if (!put || put.key !== stored.generatedObjectKey || put.sha256 !== stored.generatedContentHash
      || put.contentType !== stored.generatedContentType || put.size !== stored.generatedSizeBytes) {
      throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNVERIFIED", true);
    }
    const readback = await storage.getObjectBuffer(stored.generatedObjectKey, { maxBytes: MAX_BYTES });
    assertLeaseActive();
    const readbackInspection = await inspect(readback);
    if (!Buffer.isBuffer(readback) || sha256(readback) !== stored.generatedContentHash
      || readback.length !== stored.generatedSizeBytes || readbackInspection.contentHash !== stored.generatedContentHash
      || readbackInspection.contentType !== stored.generatedContentType
      || readbackInspection.width !== stored.generatedWidth || readbackInspection.height !== stored.generatedHeight) {
      throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNVERIFIED", true);
    }
  } catch (caught) {
    const error = caught?.code ? caught
      : failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNAVAILABLE", true);
    if (putAttempted) await cleanupOrRecord({
      storage, cleanupRecorder, scope, stored, originalErrorCode: error.code,
    });
    throw error;
  }

  const evidence = {
    ...Object.fromEntries(SCOPE_KEYS.slice(0, 7).map((key) => [key, scope[key]])),
    ...stored,
    editGatewayRequestId: generated.requestId,
    editModelEvidence: structuredClone(generated.modelEvidence),
    editGatewayConnectionId: generated.gatewayConnectionId,
    editGatewayConnectionVersion: generated.gatewayConnectionVersion,
  };
  let recorded;
  try {
    assertLeaseActive();
    recorded = await repository.recordGeneratedCandidate(evidence);
    assertLeaseActive();
  } catch {
    await cleanupOrRecord({
      storage, cleanupRecorder, scope, stored,
      originalErrorCode: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED",
    });
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED", true);
  }
  if (!recorded || recorded.status !== "GENERATED"
    || Object.keys(evidence).some((key) =>
      !sameEvidence(generatedEvidenceValue(recorded, key), evidence[key]))) {
    await cleanupOrRecord({
      storage, cleanupRecorder, scope, stored,
      originalErrorCode: "AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED",
    });
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_REPOSITORY_FAILED", true);
  }
  return Object.freeze(structuredClone(recorded));
}

export async function loadStoredSourceImageDerivative({ attempt, storage } = {}) {
  if (!attempt || attempt.status !== "GENERATED" && attempt.status !== "ACCEPTED" && attempt.status !== "REJECTED"
    || typeof attempt.generatedObjectKey !== "string" || !HASH.test(attempt.generatedContentHash || "")
    || !CONTENT_EXTENSION[attempt.generatedContentType] || typeof storage?.getObjectBuffer !== "function") {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORE_INPUT_INVALID");
  }
  let bytes;
  try { bytes = await storage.getObjectBuffer(attempt.generatedObjectKey, { maxBytes: MAX_BYTES }); }
  catch { throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNAVAILABLE", true); }
  const inspected = await inspect(bytes);
  if (inspected.contentHash !== attempt.generatedContentHash
    || inspected.contentType !== attempt.generatedContentType
    || inspected.width !== attempt.generatedWidth || inspected.height !== attempt.generatedHeight
    || inspected.bytes.length !== attempt.generatedSizeBytes) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_DERIVATIVE_STORAGE_UNVERIFIED", true);
  }
  return Object.freeze({
    bytes: Buffer.from(inspected.bytes), contentHash: inspected.contentHash,
    contentType: inspected.contentType, width: inspected.width, height: inspected.height,
  });
}
