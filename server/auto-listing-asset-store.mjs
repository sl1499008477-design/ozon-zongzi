import crypto from "node:crypto";
import sharp from "sharp";

const HASH = /^[a-f0-9]{64}$/;
const MIME_BY_FORMAT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const MAX_NORMALIZED_BYTES = 16 * 1024 * 1024;
const MAX_STORAGE_INPUT_BYTES = 32 * 1024 * 1024;
export const GENERATED_ASSET_OBJECT_KEY_VERSIONS = Object.freeze({
  ATTEMPT_V2: "ATTEMPT_V2",
  LEGACY_V1: "LEGACY_V1",
});

function error(code, message = "自动上架图片资源无效", retryable = false) {
  const value = new Error(message);
  value.code = code;
  value.retryable = retryable;
  return value;
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const sha256 = (value) => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex");

async function decodedMetadata(bytes, { maxInputBytes, maxInputPixels }) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!input.length || input.length > maxInputBytes) throw error("AUTO_LISTING_ASSET_DECODE_FAILED");
  try {
    const metadata = await sharp(input, { failOn: "error", limitInputPixels: maxInputPixels, animated: false }).metadata();
    if (!MIME_BY_FORMAT[metadata.format] || !metadata.width || !metadata.height || metadata.pages > 1) throw new Error("unsupported image");
    await sharp(input, { failOn: "error", limitInputPixels: maxInputPixels, animated: false }).stats();
    return { input, metadata };
  } catch { throw error("AUTO_LISTING_ASSET_DECODE_FAILED"); }
}

export async function inspectSourceListingImage({ bytes, maxInputBytes = 32 * 1024 * 1024, maxInputPixels = 100_000_000 } = {}) {
  const { input, metadata } = await decodedMetadata(bytes, { maxInputBytes, maxInputPixels });
  return Object.freeze({ bytes: input, contentHash: sha256(input), contentType: MIME_BY_FORMAT[metadata.format], width: metadata.width, height: metadata.height, format: metadata.format });
}

function ratioValue(ratio) {
  const match = typeof ratio === "string" && ratio.match(/^(\d+):(\d+)$/);
  if (!match || !Number(match[1]) || !Number(match[2])) throw error("AUTO_LISTING_ASSET_INVALID");
  return Number(match[1]) / Number(match[2]);
}

function resolutionBounds(resolution) {
  const bounds = { "1K": [512, 2048], "2K": [1024, 4096], "4K": [2048, 8192] }[resolution];
  if (!bounds) throw error("AUTO_LISTING_ASSET_INVALID");
  return bounds;
}

export async function normalizeListingImage({ bytes, ratio, resolution, maxInputBytes = 32 * 1024 * 1024, maxInputPixels = 100_000_000 } = {}) {
  const { input } = await decodedMetadata(bytes, { maxInputBytes, maxInputPixels });
  const output = await sharp(input, { failOn: "error", limitInputPixels: maxInputPixels, animated: false })
    .rotate().png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  const normalized = await sharp(output, { failOn: "error", limitInputPixels: maxInputPixels }).metadata();
  const [minimum, maximum] = resolutionBounds(resolution);
  const actualRatio = normalized.width / normalized.height;
  if (normalized.width < minimum || normalized.height < minimum || normalized.width > maximum || normalized.height > maximum
    || Math.abs(actualRatio - ratioValue(ratio)) > 0.02) throw error("AUTO_LISTING_ASSET_DIMENSIONS_INVALID");
  if (output.length > MAX_NORMALIZED_BYTES) throw error("AUTO_LISTING_ASSET_TOO_LARGE");
  return Object.freeze({ bytes: output, contentHash: sha256(output), contentType: "image/png", width: normalized.width, height: normalized.height, format: "png" });
}

function text(value, max = 240) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\\/\u0000-\u001f]/u.test(value)) throw error("AUTO_LISTING_ASSET_SCOPE_INVALID");
  return value;
}

const keySegment = (value) => Buffer.from(text(value), "utf8").toString("base64url");

function buildLegacyGeneratedAssetObjectKey({ accountId, jobId, itemId, planId, visualGroupKey, slotKey, inputHash, contentHash }) {
  for (const value of [accountId, jobId, itemId, planId, visualGroupKey, slotKey]) text(value);
  if (!HASH.test(inputHash) || !HASH.test(contentHash)) throw error("AUTO_LISTING_ASSET_SCOPE_INVALID");
  return `auto-listing/${keySegment(accountId)}/${keySegment(jobId)}/${keySegment(itemId)}/${keySegment(planId)}/${keySegment(visualGroupKey)}/${keySegment(slotKey)}/${inputHash}/${contentHash}.png`;
}

export function buildGeneratedAssetObjectKey({ accountId, jobId, itemId, planId, visualGroupKey, slotKey, attemptIdentityHash, attemptNo, inputHash, contentHash }) {
  for (const value of [accountId, jobId, itemId, planId, visualGroupKey, slotKey]) text(value);
  if (!HASH.test(attemptIdentityHash || "") || !Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > 3
    || !HASH.test(inputHash || "") || !HASH.test(contentHash || "")) throw error("AUTO_LISTING_ASSET_SCOPE_INVALID");
  return `auto-listing/v2/${keySegment(accountId)}/${keySegment(jobId)}/${keySegment(itemId)}/${keySegment(planId)}/${keySegment(visualGroupKey)}/${keySegment(slotKey)}/${attemptIdentityHash}/attempt-${attemptNo}/${inputHash}/${contentHash}.png`;
}

export function verifyGeneratedAssetObjectKey(input = {}) {
  try {
    if (typeof input.objectKey !== "string") return false;
    if (input.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2) {
      return input.objectKey === buildGeneratedAssetObjectKey(input);
    }
    if (input.objectKeyVersion === GENERATED_ASSET_OBJECT_KEY_VERSIONS.LEGACY_V1) {
      return input.objectKey === buildLegacyGeneratedAssetObjectKey(input);
    }
    return false;
  } catch {
    return false;
  }
}

export function verifyPersistedAcceptedGeneratedAssetObjectKey(input = {}) {
  if (input?.status !== "ACCEPTED") return false;
  if (verifyGeneratedAssetObjectKey(input)) return true;
  if (input.objectKeyVersion != null || typeof input.objectKey !== "string") return false;
  try {
    return input.objectKey === buildLegacyGeneratedAssetObjectKey(input);
  } catch {
    return false;
  }
}

function safeLog(logger, event) {
  try {
    const pending = logger?.warn?.(event);
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
}

function verifyReadback(bytes, normalized) {
  return Buffer.isBuffer(bytes) && bytes.length === normalized.bytes.length
    && bytes.length <= MAX_NORMALIZED_BYTES && sha256(bytes) === normalized.contentHash
    && bytes.equals(normalized.bytes);
}

const sameFields = (actual, expected, fields) => actual && typeof actual === "object"
  && fields.every((field) => actual[field] === expected[field]);

async function readObject(storage, key, normalized) {
  if (typeof storage?.getObjectBuffer !== "function") throw error("AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE", "图片存储暂时无法校验", true);
  let bytes;
  try {
    bytes = await storage.getObjectBuffer(key, { maxBytes: MAX_NORMALIZED_BYTES });
  } catch {
    throw error("AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE", "图片存储暂时无法校验", true);
  }
  if (!verifyReadback(bytes, normalized)) throw error("AUTO_LISTING_ASSET_STORAGE_UNVERIFIED", "图片存储内容无效", true);
}

async function cleanupOrRecord({ storage, repository, scope, stored, reason, originalErrorCode, logger }) {
  try {
    if (typeof storage?.removeObject !== "function") throw new Error("cleanup unavailable");
    await storage.removeObject(stored.objectKey, { accountId: scope.accountId });
    return;
  } catch {
    try {
      const expected = { ...scope, ...stored, reason, originalErrorCode };
      const recorded = await repository.recordAssetCleanupRequired(expected);
      if (!sameFields(recorded, expected, ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "attemptIdentityHash", "inputHash", "attemptNo", "objectKeyVersion", "objectKey", "contentHash", "reason", "originalErrorCode"])
        || recorded.status !== "PENDING") throw new Error("cleanup persistence unverified");
    } catch {
      safeLog(logger, { code: "AUTO_LISTING_ASSET_ORPHAN_CLEANUP", objectKey: stored.objectKey });
      throw error("AUTO_LISTING_ASSET_CLEANUP_PERSIST_FAILED", "图片清理义务暂时无法保存", true);
    }
    safeLog(logger, { code: "AUTO_LISTING_ASSET_ORPHAN_CLEANUP", objectKey: stored.objectKey });
  }
}

export async function storeGeneratedAsset(input = {}) {
  const { scope, normalized, storage, repository, logger = null } = input;
  if (!scope || !normalized || !Buffer.isBuffer(normalized.bytes) || !normalized.bytes.length
    || normalized.bytes.length > MAX_NORMALIZED_BYTES || normalized.contentHash !== sha256(normalized.bytes)
    || normalized.contentType !== "image/png" || !Number.isInteger(normalized.width) || normalized.width < 1
    || !Number.isInteger(normalized.height) || normalized.height < 1) {
    throw error(normalized?.bytes?.length > MAX_NORMALIZED_BYTES ? "AUTO_LISTING_ASSET_TOO_LARGE" : "AUTO_LISTING_ASSET_INVALID");
  }
  if (!HASH.test(scope.attemptIdentityHash || "") || !HASH.test(scope.inputHash || "")
    || !Number.isInteger(scope.attemptNo) || scope.attemptNo < 1 || scope.attemptNo > 3
    || typeof storage?.putObjectFromBuffer !== "function" || typeof storage?.getObjectBuffer !== "function"
    || typeof repository?.findStoredGenerationAsset !== "function"
    || typeof repository?.recordStoredGenerationAsset !== "function"
    || typeof repository?.recordAssetCleanupRequired !== "function") throw error("AUTO_LISTING_ASSET_INVALID");
  const key = buildGeneratedAssetObjectKey({ ...scope, inputHash: scope.inputHash, contentHash: normalized.contentHash });
  const stored = { objectKeyVersion: GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2, objectKey: key, contentHash: normalized.contentHash, contentType: normalized.contentType, width: normalized.width, height: normalized.height, size: normalized.bytes.length };
  {
    let existing;
    try { existing = await repository.findStoredGenerationAsset({ ...scope, contentHash: normalized.contentHash }); } catch { throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "图片记录暂时无法读取", true); }
    if (existing != null) {
      if (["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "attemptIdentityHash", "attemptNo", "inputHash"].some((field) => existing[field] !== scope[field]) || existing.objectKeyVersion !== stored.objectKeyVersion || existing.objectKey !== stored.objectKey || existing.contentHash !== stored.contentHash || existing.contentType !== stored.contentType || existing.width !== stored.width || existing.height !== stored.height || existing.size !== stored.size) throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "已保存图片记录不一致", true);
      await readObject(storage, stored.objectKey, normalized);
      return Object.freeze(stored);
    }
  }
  let put;
  try {
    put = await storage.putObjectFromBuffer({ key, name: `${scope.slotKey}.png`, contentType: normalized.contentType, buffer: normalized.bytes, maxBytes: MAX_STORAGE_INPUT_BYTES });
  } catch { throw error("AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE", "图片存储暂时不可用", true); }
  if (!put || put.key !== key || put.sha256 !== normalized.contentHash || put.contentType !== normalized.contentType || put.size !== normalized.bytes.length) {
    await cleanupOrRecord({ storage, repository, scope, stored, reason: "PUT_REPLY_UNVERIFIED", originalErrorCode: "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED", logger });
    throw error("AUTO_LISTING_ASSET_STORAGE_UNVERIFIED", "图片存储返回无效", true);
  }
  try {
    await readObject(storage, key, normalized);
  } catch (cause) {
    await cleanupOrRecord({ storage, repository, scope, stored, reason: "READBACK_FAILED", originalErrorCode: cause.code || "AUTO_LISTING_ASSET_STORAGE_UNVERIFIED", logger });
    throw cause;
  }
  try {
    const expected = { ...scope, ...stored };
    const recorded = await repository.recordStoredGenerationAsset(expected);
    if (!sameFields(recorded, expected, ["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "attemptIdentityHash", "inputHash", "attemptNo", "objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "size"])) throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED");
  } catch (cause) {
    await cleanupOrRecord({ storage, repository, scope, stored, reason: "RECORD_STORED_FAILED", originalErrorCode: "AUTO_LISTING_ASSET_REPOSITORY_FAILED", logger });
    throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "图片记录暂时无法保存", true);
  }
  return Object.freeze(stored);
}
