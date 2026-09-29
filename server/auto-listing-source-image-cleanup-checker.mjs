import { sha256 } from "./auto-listing-asset-store.mjs";
import { isCompatibleAiModelIdentity } from "./auto-listing-ai-model-identity.mjs";
import {
  SOURCE_IMAGE_CLEANUP_CHECK_CONTRACT_VERSION,
  sourceImageCleanupCheckAccepted,
  sourceImageCleanupEvidenceHash,
  verifySourceImageCleanupCheck,
} from "./auto-listing-source-image-cleanup-contract.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,119}$/u;
const VALUE_KEYS = new Set([
  "overlayRemoved", "productIdentityPreserved", "nativeMarksPreserved",
  "geometryPreserved", "noInventedContent", "reasonCodes",
]);

function failure(code = "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_INPUT_INVALID", retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, keys) {
  try {
    return plain(value) && Reflect.ownKeys(value).length === keys.size
      && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
  } catch { return false; }
}

function validScope(scope) {
  return plain(scope) && [scope.accountId, scope.jobId, scope.itemId, scope.analysisRunId,
    scope.sourceAssetId, scope.derivativeAttemptId].every(safeId)
    && Number.isInteger(scope.expectedStatusVersion) && scope.expectedStatusVersion >= 1;
}

function validImage(image) {
  return plain(image) && Buffer.isBuffer(image.bytes) && image.bytes.length > 0
    && image.bytes.length <= 8 * 1024 * 1024
    && ["image/png", "image/jpeg", "image/webp"].includes(image.contentType)
    && HASH.test(image.contentHash || "") && image.contentHash === sha256(image.bytes)
    && Number.isInteger(image.width) && image.width > 0
    && Number.isInteger(image.height) && image.height > 0;
}

function validProfile(profile, accountId) {
  return plain(profile) && profile.accountId === accountId && safeId(profile.id)
    && Number.isInteger(profile.configVersion) && profile.configVersion >= 1 && safeId(profile.textModel);
}

function validExecution(value) {
  return value === null || (plain(value) && safeId(value.connectionId)
    && Number.isInteger(value.connectionVersion) && value.connectionVersion >= 1
    && value.idleTimeoutMs === 300_000);
}

function validModelEvidence(value, expectedModel) {
  return plain(value) && value.requestedTextModel === expectedModel
    && typeof value.gatewayReportedTextModel === "string"
    && typeof value.gatewayReportedTextModelPresent === "boolean"
    && (value.gatewayReportedTextModelPresent
      ? isCompatibleAiModelIdentity(expectedModel, value.gatewayReportedTextModel)
      : value.gatewayReportedTextModel === "");
}

function normalizeGatewayValue(value) {
  if (!exact(value, VALUE_KEYS)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_GATEWAY_INVALID", true);
  }
  const checks = [value.overlayRemoved, value.productIdentityPreserved, value.nativeMarksPreserved,
    value.geometryPreserved, value.noInventedContent];
  if (!checks.every((entry) => typeof entry === "boolean")
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 20
    || new Set(value.reasonCodes).size !== value.reasonCodes.length
    || !value.reasonCodes.every((reason) => REASON.test(reason))
    || (checks.every(Boolean) ? value.reasonCodes.length !== 0 : value.reasonCodes.length === 0)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_GATEWAY_INVALID", true);
  }
  return structuredClone(value);
}

function checkerSchema() {
  const reasonCodes = {
    type: "array", maxItems: 20,
    items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,119}$" },
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...VALUE_KEYS],
    properties: Object.freeze({
      overlayRemoved: { type: "boolean" },
      productIdentityPreserved: { type: "boolean" },
      nativeMarksPreserved: { type: "boolean" },
      geometryPreserved: { type: "boolean" },
      noInventedContent: { type: "boolean" },
      reasonCodes,
    }),
  });
}

export async function checkSourceImageCleanup({
  scope, attempt, original, candidate, profile, gateway, gatewayExecution = null,
  repository, assertLeaseActive = () => {},
} = {}) {
  if (!validScope(scope) || !plain(attempt) || attempt.status !== "GENERATED"
    || attempt.derivativeAttemptId !== scope.derivativeAttemptId || attempt.sourceAssetId !== scope.sourceAssetId
    || attempt.accountId !== scope.accountId || attempt.jobId !== scope.jobId || attempt.itemId !== scope.itemId
    || attempt.analysisRunId !== scope.analysisRunId || attempt.expectedStatusVersion !== scope.expectedStatusVersion
    || !HASH.test(attempt.originalContentHash || "") || !HASH.test(attempt.generatedContentHash || "")
    || !validImage(original) || !validImage(candidate)
    || original.contentHash !== attempt.originalContentHash
    || candidate.contentHash !== attempt.generatedContentHash
    || !validProfile(profile, scope.accountId) || !validExecution(gatewayExecution)
    || !gateway || typeof gateway.createTextResponse !== "function"
    || !repository || typeof repository.recordCheckResult !== "function"
    || typeof assertLeaseActive !== "function") {
    throw failure();
  }
  assertLeaseActive();
  let response;
  try {
    response = await gateway.createTextResponse({
      profile,
      model: profile.textModel,
      correlationId: `auto-listing-source-cleanup-check:${scope.derivativeAttemptId}`,
      requestKey: `source-cleanup-check-${candidate.contentHash}`,
      idleTimeoutMs: gatewayExecution?.idleTimeoutMs ?? 300_000,
      prompt: [
        "Compare exactly two images: sourceImages[0] is the immutable original and sourceImages[1] is the cleaned candidate.",
        "Return overlayRemoved=true only when all external canvas watermarks, seller logos, URLs, contacts, and promotional overlays are gone.",
        "Return productIdentityPreserved, nativeMarksPreserved, and geometryPreserved independently.",
        "Product-native Logo, model text, nameplate, surface printing, shape, material, color, quantity, cable, ports, accessories, crop, pose, and camera angle must remain unchanged.",
        "Return noInventedContent=false if the candidate adds any part, text, feature, prop, package, or hidden structure.",
        "Every false boolean requires at least one concise uppercase reason code; an all-true result requires an empty reasonCodes array.",
      ].join("\n"),
      sourceImages: Object.freeze([
        { bytes: Buffer.from(original.bytes), contentType: original.contentType },
        { bytes: Buffer.from(candidate.bytes), contentType: candidate.contentType },
      ]),
      jsonSchema: checkerSchema(),
    });
  } catch (caught) {
    assertLeaseActive();
    throw caught;
  }
  assertLeaseActive();
  if (!safeId(response?.requestId) || !validModelEvidence(response?.modelEvidence, profile.textModel)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_GATEWAY_INVALID", true);
  }
  let value = normalizeGatewayValue(response.value);
  if (original.width !== candidate.width || original.height !== candidate.height) {
    value = {
      ...value,
      geometryPreserved: false,
      reasonCodes: [
        ...value.reasonCodes.filter((reason) => reason !== "CANVAS_DIMENSIONS_CHANGED").slice(0, 19),
        "CANVAS_DIMENSIONS_CHANGED",
      ],
    };
  }
  const checkResult = verifySourceImageCleanupCheck({
    contractVersion: SOURCE_IMAGE_CLEANUP_CHECK_CONTRACT_VERSION,
    derivativeAttemptId: scope.derivativeAttemptId,
    sourceAssetId: scope.sourceAssetId,
    originalContentHash: original.contentHash,
    candidateContentHash: candidate.contentHash,
    ...value,
  });
  const expectedStatus = sourceImageCleanupCheckAccepted(checkResult) ? "ACCEPTED" : "REJECTED";
  const evidence = {
    ...scope,
    checkResult,
    cleanupEvidenceHash: sourceImageCleanupEvidenceHash(checkResult),
    checkerGatewayRequestId: response.requestId,
    checkerModelEvidence: structuredClone(response.modelEvidence),
    checkerGatewayConnectionId: gatewayExecution?.connectionId ?? null,
    checkerGatewayConnectionVersion: gatewayExecution?.connectionVersion ?? null,
  };
  assertLeaseActive();
  let stored;
  try { stored = await repository.recordCheckResult(evidence); }
  catch (caught) { assertLeaseActive(); throw caught; }
  assertLeaseActive();
  if (!stored || stored.status !== expectedStatus
    || stored.cleanupEvidenceHash !== evidence.cleanupEvidenceHash) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_REPOSITORY_FAILED", true);
  }
  return Object.freeze(structuredClone(stored));
}
