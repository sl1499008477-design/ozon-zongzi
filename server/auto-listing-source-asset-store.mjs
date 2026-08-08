import { inspectSourceListingImage, sha256 } from "./auto-listing-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const MIME_EXTENSION = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const SCOPE_FIELDS = Object.freeze([
  "accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "sourceRefHash", "inputHash",
  "expectedStatusVersion", "attemptId", "attemptNo", "leaseToken", "leaseExpiresAt",
]);
const OWNER_REQUEST_FIELDS = Object.freeze(SCOPE_FIELDS.filter((field) => field !== "leaseExpiresAt"));

export const SOURCE_ASSET_OBJECT_KEY_VERSION = "SOURCE_V1";

function sourceAssetError(code, retryable = false) {
  const value = new Error("自动上架来源图片暂时无法保存");
  value.code = code;
  value.retryable = retryable;
  return value;
}

export function isSafeSourceScopeIdentifier(value, maxBytes = 240) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(value);
}

const identifier = isSafeSourceScopeIdentifier;

function validTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope)
    && ["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "attemptId", "leaseToken"].every((key) => identifier(scope[key]))
    && HASH.test(scope.sourceRefHash || "") && HASH.test(scope.inputHash || "")
    && Number.isInteger(scope.expectedStatusVersion) && scope.expectedStatusVersion >= 1
    && Number.isInteger(scope.attemptNo) && scope.attemptNo >= 1 && scope.attemptNo <= 3
    && validTimestamp(scope.leaseExpiresAt);
}

function validKeyScope(scope) {
  return scope && typeof scope === "object" && !Array.isArray(scope)
    && ["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId"].every((key) => identifier(scope[key]))
    && HASH.test(scope.sourceRefHash || "") && HASH.test(scope.inputHash || "")
    && Number.isInteger(scope.attemptNo) && scope.attemptNo >= 1 && scope.attemptNo <= 3;
}

const segment = (value) => Buffer.from(value, "utf8").toString("base64url");

export function buildSourceAssetObjectKey(input = {}) {
  if (!validKeyScope(input) || !HASH.test(input.contentHash || "") || !MIME_EXTENSION[input.contentType]
    || (input.objectKeyVersion != null && input.objectKeyVersion !== SOURCE_ASSET_OBJECT_KEY_VERSION)) {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_SCOPE_INVALID");
  }
  return [
    "auto-listing", "source", "v1",
    segment(input.accountId), segment(input.jobId), segment(input.itemId), segment(input.parentPlanId), segment(input.sourceAssetId),
    input.sourceRefHash, `attempt-${input.attemptNo}`, input.inputHash, `${input.contentHash}.${MIME_EXTENSION[input.contentType]}`,
  ].join("/");
}

export function verifySourceAssetObjectKey(input = {}) {
  try {
    return input.objectKeyVersion === SOURCE_ASSET_OBJECT_KEY_VERSION
      && typeof input.objectKey === "string"
      && Buffer.byteLength(input.objectKey, "utf8") <= 2048
      && input.objectKey === buildSourceAssetObjectKey(input);
  } catch {
    return false;
  }
}

function sameFields(actual, expected, fields) {
  return actual && typeof actual === "object" && !Array.isArray(actual)
    && fields.every((field) => actual[field] === expected[field]);
}

function safeLog(logger, event) {
  try {
    const pending = logger?.warn?.(event);
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
}

async function inspectExact(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== expected.sizeBytes || bytes.length > MAX_SOURCE_BYTES
    || sha256(bytes) !== expected.contentHash || !bytes.equals(expected.bytes)) return false;
  try {
    const inspected = await inspectSourceListingImage({ bytes, maxInputBytes: MAX_SOURCE_BYTES, maxInputPixels: MAX_SOURCE_PIXELS });
    return inspected.contentType === expected.contentType && inspected.width === expected.width && inspected.height === expected.height;
  } catch {
    return false;
  }
}

export async function verifyStoredSourceAsset({ stored, storage } = {}) {
  if (!stored || !verifySourceAssetObjectKey(stored)
    || !HASH.test(stored.contentHash || "") || !MIME_EXTENSION[stored.contentType]
    || !Number.isInteger(stored.width) || stored.width < 1
    || !Number.isInteger(stored.height) || stored.height < 1
    || stored.width * stored.height > MAX_SOURCE_PIXELS
    || !Number.isInteger(stored.sizeBytes) || stored.sizeBytes < 1 || stored.sizeBytes > MAX_SOURCE_BYTES
    || typeof storage?.getObjectBuffer !== "function") {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_INVALID");
  }
  let bytes;
  try {
    bytes = await storage.getObjectBuffer(stored.objectKey, { maxBytes: MAX_SOURCE_BYTES });
  } catch {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE", true);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length !== stored.sizeBytes || sha256(bytes) !== stored.contentHash) {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", true);
  }
  let inspected;
  try {
    inspected = await inspectSourceListingImage({ bytes, maxInputBytes: MAX_SOURCE_BYTES, maxInputPixels: MAX_SOURCE_PIXELS });
  } catch {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", true);
  }
  if (inspected.contentHash !== stored.contentHash || inspected.contentType !== stored.contentType
    || inspected.width !== stored.width || inspected.height !== stored.height) {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", true);
  }
  return Object.freeze({
    objectKeyVersion: stored.objectKeyVersion,
    objectKey: stored.objectKey,
    contentHash: stored.contentHash,
    contentType: stored.contentType,
    width: stored.width,
    height: stored.height,
    sizeBytes: stored.sizeBytes,
  });
}

async function persistCleanup({ scope, stored, repository, originalErrorCode, logger }) {
  const expected = {
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    parentPlanId: scope.parentPlanId,
    sourceAssetId: scope.sourceAssetId,
    materializationAttemptId: scope.attemptId,
    sourceRefHash: scope.sourceRefHash,
    inputHash: scope.inputHash,
    expectedStatusVersion: scope.expectedStatusVersion,
    attemptNo: scope.attemptNo,
    leaseToken: scope.leaseToken,
    objectKeyVersion: stored.objectKeyVersion,
    objectKey: stored.objectKey,
    contentHash: stored.contentHash,
    contentType: stored.contentType,
    width: stored.width,
    height: stored.height,
    sizeBytes: stored.sizeBytes,
    reasonCode: "AUTO_LISTING_SOURCE_OBJECT_UNREFERENCED",
    originalErrorCode,
  };
  let recorded;
  try {
    if (typeof repository?.recordSourceObjectCleanupRequired !== "function") throw new Error("missing cleanup port");
    recorded = await repository.recordSourceObjectCleanupRequired(expected);
  } catch {
    safeLog(logger, { code: "AUTO_LISTING_SOURCE_OBJECT_CLEANUP_PERSIST_FAILED", accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceAssetId: scope.sourceAssetId });
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED", true);
  }
  if (!sameFields(recorded, expected, Object.keys(expected)) || recorded.status !== "PENDING") {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED", true);
  }
  safeLog(logger, { code: "AUTO_LISTING_SOURCE_OBJECT_CLEANUP_REQUIRED", accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, sourceAssetId: scope.sourceAssetId });
}

export async function cleanupStoredSourceAsset({ scope, stored, storage, repository, originalErrorCode, logger = null } = {}) {
  if (!validScope(scope) || !verifySourceAssetObjectKey({ ...scope, ...stored }) || !identifier(originalErrorCode, 120)) {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_INVALID");
  }
  try {
    if (typeof storage?.removeObject !== "function") throw new Error("missing remove port");
    await storage.removeObject(stored.objectKey, { accountId: scope.accountId });
  } catch {
    await persistCleanup({ scope, stored, repository, originalErrorCode, logger });
  }
}

function normalizeRepositoryFailure(value) {
  if (value?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
    return sourceAssetError("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
  }
  return sourceAssetError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
}

export async function storeMaterializedSourceAsset({ scope, downloaded, storage, repository, logger = null } = {}) {
  if (!validScope(scope) || !downloaded || !Buffer.isBuffer(downloaded.bytes) || !downloaded.bytes.length
    || downloaded.bytes.length > MAX_SOURCE_BYTES || downloaded.sizeBytes !== downloaded.bytes.length
    || downloaded.contentHash !== sha256(downloaded.bytes) || !MIME_EXTENSION[downloaded.contentType]
    || !Number.isInteger(downloaded.width) || downloaded.width < 1
    || !Number.isInteger(downloaded.height) || downloaded.height < 1
    || typeof storage?.putObjectFromBuffer !== "function" || typeof storage?.getObjectBuffer !== "function"
    || typeof repository?.recordStoredSourceMaterialization !== "function") {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_INVALID");
  }
  const inspected = await inspectSourceListingImage({ bytes: downloaded.bytes, maxInputBytes: MAX_SOURCE_BYTES, maxInputPixels: MAX_SOURCE_PIXELS })
    .catch(() => null);
  if (!inspected || inspected.contentHash !== downloaded.contentHash || inspected.contentType !== downloaded.contentType
    || inspected.width !== downloaded.width || inspected.height !== downloaded.height) {
    throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_INVALID");
  }
  const stored = {
    objectKeyVersion: SOURCE_ASSET_OBJECT_KEY_VERSION,
    objectKey: "",
    contentHash: downloaded.contentHash,
    contentType: downloaded.contentType,
    width: downloaded.width,
    height: downloaded.height,
    sizeBytes: downloaded.sizeBytes,
  };
  stored.objectKey = buildSourceAssetObjectKey({ ...scope, ...stored });
  let putAttempted = false;
  try {
    putAttempted = true;
    const put = await storage.putObjectFromBuffer({
      key: stored.objectKey,
      name: `${scope.sourceAssetId}.${MIME_EXTENSION[stored.contentType]}`,
      contentType: stored.contentType,
      buffer: downloaded.bytes,
      maxBytes: MAX_SOURCE_BYTES,
    });
    if (!put || put.key !== stored.objectKey || put.sha256 !== stored.contentHash
      || put.contentType !== stored.contentType || put.size !== stored.sizeBytes) {
      throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", true);
    }
    const readback = await storage.getObjectBuffer(stored.objectKey, { maxBytes: MAX_SOURCE_BYTES });
    if (!await inspectExact(readback, { ...stored, bytes: downloaded.bytes })) {
      throw sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED", true);
    }
  } catch (caught) {
    const failure = caught?.code === "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED"
      ? caught : sourceAssetError("AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE", true);
    if (putAttempted) await cleanupStoredSourceAsset({ scope, stored, storage, repository, originalErrorCode: failure.code, logger });
    throw failure;
  }

  const request = { ...Object.fromEntries(OWNER_REQUEST_FIELDS.map((field) => [field, scope[field]])), ...stored };
  const expected = { ...scope, ...stored };
  let recorded;
  try {
    recorded = await repository.recordStoredSourceMaterialization(request);
    if (!sameFields(recorded, expected, [...SCOPE_FIELDS, ...Object.keys(stored)]) || recorded.status !== "STORED") {
      throw sourceAssetError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
    }
  } catch (caught) {
    const failure = normalizeRepositoryFailure(caught);
    await cleanupStoredSourceAsset({ scope, stored, storage, repository, originalErrorCode: failure.code, logger });
    throw failure;
  }
  return Object.freeze({ ...recorded });
}
