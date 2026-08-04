import crypto from "node:crypto";
import sharp from "sharp";

const HASH = /^[a-f0-9]{64}$/;
const MIME_BY_FORMAT = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

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
  return Object.freeze({ bytes: output, contentHash: sha256(output), contentType: "image/png", width: normalized.width, height: normalized.height, format: "png" });
}

function text(value, max = 240) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\\/\u0000-\u001f]/u.test(value)) throw error("AUTO_LISTING_ASSET_SCOPE_INVALID");
  return value;
}

const keySegment = (value) => Buffer.from(text(value), "utf8").toString("base64url");

export function buildGeneratedAssetObjectKey({ accountId, jobId, itemId, planId, visualGroupKey, slotKey, inputHash, contentHash }) {
  for (const value of [accountId, jobId, itemId, planId, visualGroupKey, slotKey]) text(value);
  if (!HASH.test(inputHash) || !HASH.test(contentHash)) throw error("AUTO_LISTING_ASSET_SCOPE_INVALID");
  return `auto-listing/${keySegment(accountId)}/${keySegment(jobId)}/${keySegment(itemId)}/${keySegment(planId)}/${keySegment(visualGroupKey)}/${keySegment(slotKey)}/${inputHash}/${contentHash}.png`;
}

export async function storeGeneratedAsset(input = {}) {
  const { scope, normalized, storage, repository, logger = null } = input;
  if (!scope || !normalized || typeof storage?.putObjectFromBuffer !== "function") throw error("AUTO_LISTING_ASSET_INVALID");
  const key = buildGeneratedAssetObjectKey({ ...scope, inputHash: scope.inputHash, contentHash: normalized.contentHash });
  const stored = { objectKey: key, contentHash: normalized.contentHash, contentType: normalized.contentType, width: normalized.width, height: normalized.height, size: normalized.bytes.length };
  if (typeof repository?.findStoredGenerationAsset === "function") {
    let existing;
    try { existing = await repository.findStoredGenerationAsset({ ...scope, contentHash: normalized.contentHash }); } catch { throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "图片记录暂时无法读取", true); }
    if (existing != null) {
      if (["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "inputHash"].some((field) => existing[field] !== scope[field]) || existing.objectKey !== stored.objectKey || existing.contentHash !== stored.contentHash || existing.contentType !== stored.contentType || existing.width !== stored.width || existing.height !== stored.height || existing.size !== stored.size) throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "已保存图片记录不一致", true);
      return Object.freeze(stored);
    }
  }
  let put;
  try {
    put = await storage.putObjectFromBuffer({ key, name: `${scope.slotKey}.png`, contentType: normalized.contentType, buffer: normalized.bytes });
  } catch { throw error("AUTO_LISTING_ASSET_STORAGE_UNAVAILABLE", "图片存储暂时不可用", true); }
  if (!put || put.key !== key || put.sha256 !== normalized.contentHash || put.contentType !== normalized.contentType || put.size !== normalized.bytes.length) {
    if (typeof storage.removeObject === "function") await Promise.resolve(storage.removeObject(key)).catch(() => {});
    throw error("AUTO_LISTING_ASSET_STORAGE_UNVERIFIED", "图片存储返回无效", true);
  }
  if (typeof repository?.recordStoredGenerationAsset !== "function") return Object.freeze(stored);
  try { const recorded = await repository.recordStoredGenerationAsset({ ...scope, ...stored }); if (recorded != null && (["accountId", "jobId", "itemId", "planId", "visualGroupKey", "slotKey", "inputHash", "objectKey", "contentHash", "contentType", "width", "height", "size"].some((field) => recorded[field] !== ({ ...scope, ...stored })[field]))) throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED"); } catch (cause) {
    if (typeof storage.removeObject === "function") Promise.resolve(storage.removeObject(key)).catch(() => {});
    try { logger?.warn?.({ code: "AUTO_LISTING_ASSET_ORPHAN_CLEANUP" }); } catch {}
    throw error("AUTO_LISTING_ASSET_REPOSITORY_FAILED", "图片记录暂时无法保存", true);
  }
  return Object.freeze(stored);
}
