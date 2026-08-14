import crypto from "node:crypto";
import net from "node:net";
import { types as utilTypes } from "node:util";
import sharp from "sharp";

const FACTORY_KEYS = ["fetchImage", "objectStorage", "now", "maxDownloadBytes"];
const REQUEST_KEYS = [
  "accountId", "draftId", "sampleSetId", "sampleId", "correlationId", "sourceReferences",
];
const SOURCE_KEYS = ["imageId", "role", "ordinal", "sourceUrl", "sourceResponseHash"];
const STORAGE_KEYS = [
  "putObjectExpected", "readObjectExpected", "removeObjectExpected",
  "getManifestExpected", "claimManifestExpected", "finalizeManifestExpected",
  "putOwnedObjectExpected", "cleanupOwnedManifestExpected",
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const SAFE_DTO_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ALLOWED_SOURCE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_BY_FORMAT = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
const CREDENTIAL_MARKER = /(?:credential|password|passwd|secret|bearer|authorization|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token)/iu;
const ANALYSIS_MAX_EDGE = 2048;
const THUMBNAIL_EDGE = 256;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_INPUT_PIXELS = 60_000_000;
const MAX_NORMALIZED_BYTES = 16 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const MANIFEST_SCHEMA = "CATEGORY_STRATEGY_SAMPLE_IMAGES_V1";

function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function invalid() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID");
}

function closed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || utilTypes.isProxy(raw) || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const ownKeys = Reflect.ownKeys(raw);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID") throw error;
    throw invalid();
  }
}

function closedArray(raw) {
  try {
    if (utilTypes.isProxy(raw) || !Array.isArray(raw)) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== raw.length + 1 || descriptors.length?.value !== raw.length
      || descriptors.length?.enumerable !== false) throw invalid();
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
      return descriptor.value;
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_STORE_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value.includes("..") || CREDENTIAL_MARKER.test(value)) throw invalid();
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredHash(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw invalid();
  return value;
}

function timestamp(now) {
  let value;
  try { value = now(); } catch { throw invalid(); }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalid();
  return parsed.toISOString();
}

function canonicalTimestamp(value) {
  try { return typeof value === "string" && new Date(value).toISOString() === value; } catch { return false; }
}

function isBlockedIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b));
}

function isBlockedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal")) return true;
  const family = net.isIP(host);
  if (family === 4) return isBlockedIpv4(host);
  if (family === 6) {
    const compact = host.toLowerCase();
    return compact === "::" || compact === "::1" || compact.startsWith("fc") || compact.startsWith("fd")
      || /^fe[89ab]/u.test(compact) || compact.startsWith("ff")
      || (compact.startsWith("::ffff:") && isBlockedIpv4(compact.slice(7)));
  }
  return false;
}

function sourceUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8192) throw invalid();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_SSRF_BLOCKED");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (isBlockedHost(host) || !SAFE_DTO_HOST.test(host)) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_SSRF_BLOCKED");
  }
  return Object.freeze({ value: parsed.href, host });
}

function projectSourceReferences(raw) {
  const entries = closedArray(raw);
  if (entries.length < 1 || entries.length > 50) throw invalid();
  const projected = entries.map((entry, ordinal) => {
    const value = closed(entry, SOURCE_KEYS);
    const expectedRole = ordinal === 0 ? "MAIN" : "DETAIL";
    if (value.role !== expectedRole || value.ordinal !== ordinal) throw invalid();
    const source = sourceUrl(value.sourceUrl);
    return Object.freeze({
      imageId: identifier(value.imageId), role: expectedRole, ordinal,
      sourceUrl: source.value, sourceUrlHost: source.host,
      sourceResponseHash: requiredHash(value.sourceResponseHash),
    });
  });
  if (new Set(projected.map((entry) => entry.imageId)).size !== projected.length) throw invalid();
  return Object.freeze(projected.slice(0, 6));
}

function projectRequest(raw) {
  const value = closed(raw, REQUEST_KEYS);
  const projected = {
    accountId: identifier(value.accountId),
    draftId: identifier(value.draftId),
    sampleSetId: identifier(value.sampleSetId),
    sampleId: identifier(value.sampleId),
    correlationId: identifier(value.correlationId),
    sourceReferences: projectSourceReferences(value.sourceReferences),
  };
  const longestKey = `category-strategy/${projected.accountId}/${projected.draftId}/${projected.sampleSetId}/${projected.sampleId}/${"0".repeat(64)}/${"0".repeat(64)}/thumbnail-${"0".repeat(64)}.webp`;
  if (Buffer.byteLength(longestKey, "utf8") > 1024) throw invalid();
  return Object.freeze(projected);
}

function requestInputHash(context) {
  const identity = {
    accountId: context.accountId,
    draftId: context.draftId,
    sampleSetId: context.sampleSetId,
    sampleId: context.sampleId,
    sources: context.sourceReferences.map((reference) => ({
      imageId: reference.imageId,
      role: reference.role,
      ordinal: reference.ordinal,
      sourceRefHash: sha256(reference.sourceUrl),
      sourceResponseHash: reference.sourceResponseHash,
    })),
  };
  return sha256(Buffer.from(JSON.stringify(identity), "utf8"));
}

function manifestObjectKey(context, inputHash) {
  return `category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${context.sampleId}/manifests/${inputHash}.json`;
}

function projectManifestEvidence(raw, context, inputHash) {
  const entries = closedArray(raw);
  if (entries.length !== context.sourceReferences.length) throw invalid();
  return Object.freeze(entries.map((rawEvidence, ordinal) => {
    const evidence = closed(rawEvidence, [
      "imageId", "role", "ordinal", "sourceUrlHost", "sourceRefHash", "sourceResponseHash",
      "sourceContentHash", "analysisObjectKey", "analysisContentHash", "thumbnailObjectKey",
      "thumbnailContentHash", "contentType", "width", "height", "capturedAt",
    ]);
    const source = context.sourceReferences[ordinal];
    const prefix = `category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${context.sampleId}/${inputHash}/`;
    if (evidence.imageId !== source.imageId || evidence.role !== source.role || evidence.ordinal !== source.ordinal
      || evidence.sourceUrlHost !== source.sourceUrlHost || evidence.sourceRefHash !== sha256(source.sourceUrl)
      || evidence.sourceResponseHash !== source.sourceResponseHash || !HASH.test(evidence.sourceContentHash || "")
      || !HASH.test(evidence.analysisContentHash || "") || !HASH.test(evidence.thumbnailContentHash || "")
      || ![evidence.analysisObjectKey, evidence.thumbnailObjectKey].every((key) => typeof key === "string"
        && key.length <= 1024 && key.startsWith(prefix) && !key.includes(".."))
      || evidence.contentType !== "image/webp" || !Number.isInteger(evidence.width) || evidence.width < 1
      || !Number.isInteger(evidence.height) || evidence.height < 1 || !canonicalTimestamp(evidence.capturedAt)) throw invalid();
    return Object.freeze({ ...evidence });
  }));
}

function parseManifest(buffer, storageState, context, inputHash) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(buffer).toString("utf8")); } catch { throw invalid(); }
  const value = closed(parsed, [
    "schemaVersion", "state", "inputHash", "accountId", "draftId", "sampleSetId", "sampleId",
    "expectedObjects", "evidence",
  ]);
  if (value.schemaVersion !== MANIFEST_SCHEMA || value.state !== storageState || value.inputHash !== inputHash
    || value.accountId !== context.accountId || value.draftId !== context.draftId
    || value.sampleSetId !== context.sampleSetId || value.sampleId !== context.sampleId) throw invalid();
  const evidence = projectManifestEvidence(value.evidence, context, inputHash);
  const rawObjects = closedArray(value.expectedObjects);
  const expectedObjects = Object.freeze(rawObjects.map((rawObject) => {
    const object = closed(rawObject, ["key", "expectedSha256", "maxBytes"]);
    if (typeof object.key !== "string" || object.key.length > 1024 || object.key.includes("..")
      || !object.key.startsWith(`category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${context.sampleId}/${inputHash}/`)
      || !HASH.test(object.expectedSha256 || "") || object.maxBytes !== MAX_NORMALIZED_BYTES) throw invalid();
    return Object.freeze({ ...object });
  }));
  const evidenceObjects = new Map();
  for (const item of evidence) {
    evidenceObjects.set(item.analysisObjectKey, item.analysisContentHash);
    evidenceObjects.set(item.thumbnailObjectKey, item.thumbnailContentHash);
  }
  if (expectedObjects.length !== evidenceObjects.size
    || expectedObjects.some((object) => evidenceObjects.get(object.key) !== object.expectedSha256)) throw invalid();
  return Object.freeze({ state: storageState, evidence, expectedObjects });
}

function manifestBuffer(state, context, inputHash, expectedObjects, evidence) {
  return Buffer.from(JSON.stringify({
    schemaVersion: MANIFEST_SCHEMA,
    state,
    inputHash,
    accountId: context.accountId,
    draftId: context.draftId,
    sampleSetId: context.sampleSetId,
    sampleId: context.sampleId,
    expectedObjects,
    evidence,
  }), "utf8");
}

async function projectManifestReplay(record, context, inputHash, objectStorage) {
  if (record?.state !== "DONE" || !Buffer.isBuffer(record.buffer)) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
  }
  try {
    const manifest = parseManifest(record.buffer, "DONE", context, inputHash);
    await Promise.all(manifest.expectedObjects.map((object) => objectStorage.readObjectExpected({
      accountId: context.accountId,
      key: object.key,
      expectedSha256: object.expectedSha256,
      maxBytes: object.maxBytes,
    })));
    return manifest.evidence;
  } catch {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
  }
}

function projectFetchResult(raw) {
  const value = closed(raw, ["buffer", "contentType"]);
  if (!Buffer.isBuffer(value.buffer)) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_DOWNLOAD_FAILED", true);
  return value;
}

function mapFetchFailure(error) {
  if (String(error?.code || "").startsWith("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_")) return error;
  const code = String(error?.code || "").toUpperCase();
  if (code.includes("TIMEOUT") || code === "ABORT_ERR") return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TIMEOUT", true);
  if (code.includes("REDIRECT")) return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_REDIRECT_BLOCKED");
  if (code.includes("TOO_LARGE") || code.includes("SIZE")) return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE");
  if (code.includes("SSRF") || code.includes("PRIVATE") || code.includes("HOST_BLOCKED")) {
    return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_SSRF_BLOCKED");
  }
  if (code.includes("MIME") || code.includes("CONTENT_TYPE")) return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_MIME_BLOCKED");
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_DOWNLOAD_FAILED", true);
}

async function boundedFetch(fetchImage, reference, context, maxDownloadBytes) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TIMEOUT", true));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    const fetched = await Promise.race([
      Promise.resolve().then(() => fetchImage({
        sourceUrl: reference.sourceUrl,
        signal: controller.signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: maxDownloadBytes,
        maxRedirects: MAX_REDIRECTS,
        forbidPrivateNetworks: true,
        forbidHttpsDowngrade: true,
        correlationId: context.correlationId,
      })),
      timeout,
    ]);
    const result = projectFetchResult(fetched);
    if (result.buffer.length < 1 || result.buffer.length > maxDownloadBytes) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE");
    }
    const contentType = typeof result.contentType === "string"
      ? result.contentType.split(";", 1)[0].trim().toLowerCase() : "";
    if (!ALLOWED_SOURCE_MIME.has(contentType)) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_MIME_BLOCKED");
    }
    return { buffer: result.buffer, contentType };
  } catch (error) {
    throw mapFetchFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

async function normalizeImage(downloaded) {
  let metadata;
  try {
    metadata = await sharp(downloaded.buffer, {
      failOn: "error", limitInputPixels: false, animated: false,
    }).metadata();
    if (!metadata.width || !metadata.height || metadata.pages > 1
      || MIME_BY_FORMAT[metadata.format] !== downloaded.contentType) throw new Error("unsupported image");
    if (!Number.isSafeInteger(metadata.width * metadata.height)
      || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE");
    }
    await sharp(downloaded.buffer, {
      failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false,
    }).stats();
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE") throw error;
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_DECODE_FAILED");
  }

  try {
    const analysisResult = await sharp(downloaded.buffer, {
      failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false,
    }).rotate().resize({
      width: ANALYSIS_MAX_EDGE,
      height: ANALYSIS_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    }).webp({ quality: 90, effort: 4 }).toBuffer({ resolveWithObject: true });
    const thumbnailResult = await sharp(analysisResult.data, {
      failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, animated: false,
    }).resize({
      width: THUMBNAIL_EDGE,
      height: THUMBNAIL_EDGE,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      withoutEnlargement: false,
    }).webp({ quality: 78, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (analysisResult.data.length > MAX_NORMALIZED_BYTES || thumbnailResult.data.length > MAX_NORMALIZED_BYTES) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE");
    }
    return Object.freeze({
      analysis: Object.freeze({
        bytes: analysisResult.data,
        contentHash: sha256(analysisResult.data),
        width: analysisResult.info.width,
        height: analysisResult.info.height,
      }),
      thumbnail: Object.freeze({
        bytes: thumbnailResult.data,
        contentHash: sha256(thumbnailResult.data),
      }),
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_TOO_LARGE") throw error;
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_DECODE_FAILED");
  }
}

function objectKeys(context, inputHash, sourceContentHash, normalized) {
  const prefix = `category-strategy/${context.accountId}/${context.draftId}/${context.sampleSetId}/${context.sampleId}`;
  return Object.freeze({
    analysis: `${prefix}/${inputHash}/${sourceContentHash}/analysis-${normalized.analysis.contentHash}.webp`,
    thumbnail: `${prefix}/${inputHash}/${sourceContentHash}/thumbnail-${normalized.thumbnail.contentHash}.webp`,
  });
}

export function createCategoryStrategySampleStore(raw = {}) {
  const factory = closed(raw, FACTORY_KEYS);
  if (typeof factory.fetchImage !== "function" || typeof factory.now !== "function"
    || !Number.isInteger(factory.maxDownloadBytes) || factory.maxDownloadBytes < 1
    || factory.maxDownloadBytes > 64 * 1024 * 1024) throw invalid();
  const objectStorage = closed(factory.objectStorage, STORAGE_KEYS);
  if (!STORAGE_KEYS.every((key) => typeof objectStorage[key] === "function")) throw invalid();

  async function persistSampleImages(rawRequest = {}) {
    const context = projectRequest(rawRequest);
    const inputHash = requestInputHash(context);
    const manifestKey = manifestObjectKey(context, inputHash);
    let existing;
    try {
      existing = await objectStorage.getManifestExpected({
        accountId: context.accountId, key: manifestKey, maxBytes: MANIFEST_MAX_BYTES,
      });
    } catch {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
    }
    if (existing?.state === "DONE") return projectManifestReplay(existing, context, inputHash, objectStorage);
    if (existing?.state === "PREPARING") throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_IN_PROGRESS", true);

    const capturedAt = timestamp(factory.now);
    const evidence = [];
    const assets = new Map();
    for (const reference of context.sourceReferences) {
      const downloaded = await boundedFetch(factory.fetchImage, reference, context, factory.maxDownloadBytes);
      const sourceContentHash = sha256(downloaded.buffer);
      const normalized = await normalizeImage(downloaded);
      const keys = objectKeys(context, inputHash, sourceContentHash, normalized);
      for (const asset of [
        { key: keys.analysis, normalized: normalized.analysis },
        { key: keys.thumbnail, normalized: normalized.thumbnail },
      ]) {
        assets.set(asset.key, Object.freeze({
          key: asset.key,
          contentType: "image/webp",
          buffer: asset.normalized.bytes,
          expectedSha256: asset.normalized.contentHash,
          maxBytes: MAX_NORMALIZED_BYTES,
        }));
      }
      evidence.push(Object.freeze({
        imageId: reference.imageId,
        role: reference.role,
        ordinal: reference.ordinal,
        sourceUrlHost: reference.sourceUrlHost,
        sourceRefHash: sha256(reference.sourceUrl),
        sourceResponseHash: reference.sourceResponseHash,
        sourceContentHash,
        analysisObjectKey: keys.analysis,
        analysisContentHash: normalized.analysis.contentHash,
        thumbnailObjectKey: keys.thumbnail,
        thumbnailContentHash: normalized.thumbnail.contentHash,
        contentType: "image/webp",
        width: normalized.analysis.width,
        height: normalized.analysis.height,
        capturedAt,
      }));
    }
    const expectedObjects = Object.freeze([...assets.values()].map((asset) => Object.freeze({
      key: asset.key, expectedSha256: asset.expectedSha256, maxBytes: asset.maxBytes,
    })));
    const preparing = manifestBuffer("PREPARING", context, inputHash, expectedObjects, evidence);
    const ownerToken = crypto.randomUUID();
    let claim;
    try {
      claim = await objectStorage.claimManifestExpected({
        accountId: context.accountId, key: manifestKey, ownerToken, buffer: preparing,
        expectedSha256: sha256(preparing), maxBytes: MANIFEST_MAX_BYTES,
      });
      if (claim?.status === "DONE") return projectManifestReplay(claim, context, inputHash, objectStorage);
      if (claim?.status !== "OWNED" || claim.ownerToken !== ownerToken || typeof claim.etag !== "string") {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_IN_PROGRESS", true);
      }
      for (const asset of assets.values()) {
        const stored = await objectStorage.putOwnedObjectExpected({
          accountId: context.accountId,
          key: asset.key,
          contentType: asset.contentType,
          buffer: asset.buffer,
          expectedSha256: asset.expectedSha256,
          maxBytes: asset.maxBytes,
          manifestKey,
          ownerToken,
        });
        if (!stored || stored.key !== asset.key || stored.sha256 !== asset.expectedSha256
          || stored.contentType !== asset.contentType || stored.size !== asset.buffer.length
          || stored.created !== true) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
      }
      const done = manifestBuffer("DONE", context, inputHash, expectedObjects, evidence);
      const finalized = await objectStorage.finalizeManifestExpected({
        accountId: context.accountId, key: manifestKey, ownerToken, expectedEtag: claim.etag,
        buffer: done, expectedSha256: sha256(done), maxBytes: MANIFEST_MAX_BYTES,
      });
      if (finalized?.status !== "DONE") throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
      return projectManifestReplay({ state: "DONE", buffer: finalized.buffer }, context, inputHash, objectStorage);
    } catch (error) {
      if (claim?.status === "OWNED") {
        try {
          const cleaned = await objectStorage.cleanupOwnedManifestExpected({
            accountId: context.accountId, key: manifestKey, ownerToken,
            expectedEtag: claim.etag, objects: expectedObjects,
          });
          if (!cleaned || !["CLEANED", "DONE"].includes(cleaned.status)) throw new Error("cleanup unverified");
        } catch {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_CLEANUP_FAILED", true);
        }
      }
      if (String(error?.code || "").startsWith("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_")) throw error;
      if (error?.code === "EXPECTED_HASH_OBJECT_STORAGE_IN_PROGRESS") {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_IN_PROGRESS", true);
      }
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IMAGE_STORAGE_FAILED", true);
    }
  }

  return Object.freeze({ persistSampleImages });
}
