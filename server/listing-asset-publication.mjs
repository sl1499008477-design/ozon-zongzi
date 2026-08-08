import crypto from "node:crypto";
import { isIP } from "node:net";

import {
  GENERATED_ASSET_OBJECT_KEY_VERSIONS,
  inspectSourceListingImage,
  verifyGeneratedAssetObjectKey,
} from "./auto-listing-asset-store.mjs";
import { assertPermission, PERMISSIONS } from "./permissions.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PUBLICATION_VERSION = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const ROLES = new Set(["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"]);
const CONTENT_TYPES = Object.freeze(new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]));

function publicationError(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.retryable = code === "LISTING_ASSET_PUBLICATION_FAILED";
  return error;
}

const CLEANUP_TERMINAL_OR_PENDING = new Set(["PENDING", "DELETING", "CLEANED", "REFERENCED"]);

function id(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(result)) throw publicationError("LISTING_ASSET_PUBLICATION_INVALID");
  return result;
}

function input(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 3
    || !["actor", "itemId", "assetId"].every((key) => Object.hasOwn(value, key))) {
    throw publicationError("LISTING_ASSET_PUBLICATION_INVALID");
  }
  return value;
}

function publicObjectKey(value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/u.test(result) || result.includes("..") || result.includes("//")) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  return result;
}

function safeHttpsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY"); }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || isIP(hostname) !== 0) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  return parsed;
}

function baseEvidence(row, scope) {
  if (!row || typeof row !== "object" || Array.isArray(row)
    || row.accountId !== scope.accountId || row.itemId !== scope.itemId || row.assetId !== scope.assetId
    || row.status !== "ACCEPTED" || !HASH.test(row.contentHash || "")
    || !CONTENT_TYPES.has(row.contentType) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 1
    || row.sizeBytes > MAX_IMAGE_BYTES || !Number.isSafeInteger(row.width) || row.width < 1
    || !Number.isSafeInteger(row.height) || row.height < 1 || !ROLES.has(row.role)) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  return {
    accountId: scope.accountId,
    jobId: id(row.jobId),
    itemId: scope.itemId,
    planId: id(row.planId),
    assetId: scope.assetId,
    visualGroupKey: id(row.visualGroupKey),
    slotKey: id(row.slotKey),
    role: row.role,
    status: "ACCEPTED",
    contentHash: row.contentHash,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
  };
}

function acceptedEvidence(row, scope) {
  const result = baseEvidence(row, scope);
  const keyEvidence = {
    ...result,
    objectKeyVersion: row?.objectKeyVersion,
    objectKey: row?.objectKey,
    attemptIdentityHash: row?.attemptIdentityHash,
    attemptNo: row?.attemptNo,
    inputHash: row?.inputHash,
  };
  if (keyEvidence.objectKeyVersion !== GENERATED_ASSET_OBJECT_KEY_VERSIONS.ATTEMPT_V2
    || !verifyGeneratedAssetObjectKey(keyEvidence)) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  return Object.freeze(keyEvidence);
}

function publicationEvidence(row, scope, config) {
  const result = baseEvidence(row, scope);
  const publicationVersion = String(row.publicationVersion || "");
  if (!PUBLICATION_VERSION.test(publicationVersion) || publicationVersion !== config.publicationVersion) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  if (row.publicBaseUrl !== config.baseUrl || row.publicPrefix !== config.prefix) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  const key = publicObjectKey(row.publicObjectKey);
  const extension = CONTENT_TYPES.get(result.contentType);
  const suffix = `${result.contentHash.slice(0, 2)}/${result.contentHash}.${extension}`;
  if (!key.endsWith(`/${suffix}`)) throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  const parsed = safeHttpsUrl(row.publishedUrl);
  if (!parsed.pathname.endsWith(`/${key}`)) throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  return Object.freeze({
    ...result,
    publishedUrl: parsed.toString(),
    publicObjectKey: key,
    publicationVersion,
  });
}

function observeFailure({ logger, metrics }, { stage, code, scope }) {
  const event = Object.freeze({
    code,
    stage,
    accountId: scope.accountId,
    itemId: scope.itemId,
    assetId: scope.assetId,
    retryable: code === "LISTING_ASSET_PUBLICATION_FAILED",
  });
  try {
    const pending = logger?.warn?.(event);
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
  try {
    const pending = metrics?.increment?.("listing_asset_publication_failure", Object.freeze({ stage, code }));
    if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
  } catch {}
}

function toBuffer(value) {
  try {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
  } catch {}
  throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
}

async function verifyImageBytes(value, expected) {
  const buffer = toBuffer(value);
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (buffer.length !== expected.sizeBytes || actualHash !== expected.contentHash) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  let inspected;
  try {
    inspected = await inspectSourceListingImage({
      bytes: buffer,
      maxInputBytes: MAX_IMAGE_BYTES,
      maxInputPixels: MAX_IMAGE_PIXELS,
    });
  } catch {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  if (inspected.contentHash !== expected.contentHash || inspected.contentType !== expected.contentType
    || inspected.width !== expected.width || inspected.height !== expected.height) {
    throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
  }
  return buffer;
}

function putAcknowledged(result, expected) {
  return result && typeof result === "object"
    && result.key === expected.key
    && result.sha256 === expected.contentHash
    && result.contentType === expected.contentType
    && result.size === expected.sizeBytes;
}

export function createListingAssetPublicationService({
  repository,
  readPrivateObject,
  putPublicObject,
  readPublicObject,
  recordOrphanCleanup,
  config,
  logger = null,
  metrics = null,
} = {}) {
  if (typeof repository?.findPublication !== "function" || typeof repository?.loadAcceptedAsset !== "function"
    || typeof repository?.recordPublication !== "function" || typeof readPrivateObject !== "function"
    || typeof putPublicObject !== "function" || typeof readPublicObject !== "function"
    || typeof recordOrphanCleanup !== "function") {
    throw new TypeError("Listing asset publication dependencies are required");
  }

  return Object.freeze({
    async publishListingAsset(value = {}) {
      const { actor, itemId: rawItemId, assetId: rawAssetId } = input(value);
      assertPermission(actor, PERMISSIONS.TENANT_OPERATE);
      if (!config) throw publicationError("LISTING_ASSET_PUBLICATION_DISABLED", 503);
      if (!PUBLICATION_VERSION.test(config.publicationVersion || "")) {
        throw publicationError("LISTING_ASSET_PUBLICATION_DISABLED", 503);
      }
      const scope = { accountId: id(actor.id), itemId: id(rawItemId), assetId: id(rawAssetId) };
      const observer = { logger, metrics };

      let existing;
      try {
        existing = await repository.findPublication({ ...scope, publicationVersion: config.publicationVersion });
      } catch {
        observeFailure(observer, { stage: "find", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      if (existing) {
        try { return publicationEvidence(existing, scope, config); }
        catch {
          observeFailure(observer, { stage: "verify-existing", code: "LISTING_ASSET_PUBLICATION_BOUNDARY", scope });
          throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
        }
      }

      let acceptedRow;
      try { acceptedRow = await repository.loadAcceptedAsset(scope); }
      catch {
        observeFailure(observer, { stage: "load", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      let accepted;
      try { accepted = acceptedEvidence(acceptedRow, scope); }
      catch {
        observeFailure(observer, { stage: "verify-accepted", code: "LISTING_ASSET_PUBLICATION_BOUNDARY", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
      }
      let privateBytes;
      try {
        privateBytes = await readPrivateObject({ key: accepted.objectKey, maxBytes: MAX_IMAGE_BYTES });
      } catch {
        observeFailure(observer, { stage: "read-private", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      let buffer;
      try {
        buffer = await verifyImageBytes(privateBytes, accepted);
      } catch {
        observeFailure(observer, { stage: "verify-private", code: "LISTING_ASSET_PUBLICATION_BOUNDARY", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
      }

      const extension = CONTENT_TYPES.get(accepted.contentType);
      const key = `${config.prefix}/${accepted.contentHash.slice(0, 2)}/${accepted.contentHash}.${extension}`;
      const publishedUrl = new URL(key, config.baseUrl).toString();
      const expectedPut = {
        key,
        contentHash: accepted.contentHash,
        contentType: accepted.contentType,
        sizeBytes: accepted.sizeBytes,
      };
      const persistCleanup = async (reasonCode) => {
        const cleanupInput = {
          accountId: accepted.accountId,
          jobId: accepted.jobId,
          itemId: accepted.itemId,
          planId: accepted.planId,
          assetId: accepted.assetId,
          contentHash: accepted.contentHash,
          publicObjectKey: key,
          publicationVersion: config.publicationVersion,
          publicBaseUrl: config.baseUrl,
          publicPrefix: config.prefix,
          reasonCode,
        };
        let cleanup;
        try { cleanup = await recordOrphanCleanup(cleanupInput); }
        catch {
          observeFailure(observer, { stage: "cleanup-record", code: "LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED", scope });
          throw publicationError("LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED", 503);
        }
        if (!cleanup || !CLEANUP_TERMINAL_OR_PENDING.has(cleanup.status)
          || ["accountId", "jobId", "itemId", "planId", "assetId", "contentHash", "publicObjectKey",
            "publicationVersion", "publicBaseUrl", "publicPrefix"]
            .some((field) => cleanup[field] !== cleanupInput[field])) {
          observeFailure(observer, { stage: "cleanup-record", code: "LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED", scope });
          throw publicationError("LISTING_ASSET_PUBLICATION_CLEANUP_PERSIST_FAILED", 503);
        }
        return cleanup;
      };
      let put;
      try {
        put = await putPublicObject({
          key,
          name: `${accepted.contentHash}.${extension}`,
          contentType: accepted.contentType,
          buffer,
          maxBytes: MAX_IMAGE_BYTES,
        });
      } catch {
        observeFailure(observer, { stage: "put", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      if (!putAcknowledged(put, expectedPut)) {
        observeFailure(observer, { stage: "put-ack", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      try {
        const readback = await readPublicObject({ key, maxBytes: MAX_IMAGE_BYTES });
        await verifyImageBytes(readback, accepted);
      } catch {
        observeFailure(observer, { stage: "read-public", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }

      let persisted;
      try {
        persisted = await repository.recordPublication({
          accountId: accepted.accountId,
          jobId: accepted.jobId,
          itemId: accepted.itemId,
          planId: accepted.planId,
          assetId: accepted.assetId,
          publicObjectKey: key,
          publishedUrl,
          publicationVersion: config.publicationVersion,
          publicBaseUrl: config.baseUrl,
          publicPrefix: config.prefix,
          publishedByAccountId: scope.accountId,
        });
      } catch {
        observeFailure(observer, { stage: "record", code: "LISTING_ASSET_PUBLICATION_FAILED", scope });
        await persistCleanup("RECORD_UNCERTAIN");
        throw publicationError("LISTING_ASSET_PUBLICATION_FAILED", 503);
      }
      if (!persisted) {
        observeFailure(observer, { stage: "record", code: "LISTING_ASSET_PUBLICATION_BOUNDARY", scope });
        await persistCleanup("RECORD_REJECTED");
        throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
      }
      try { return publicationEvidence(persisted, scope, config); }
      catch {
        observeFailure(observer, { stage: "verify-record", code: "LISTING_ASSET_PUBLICATION_BOUNDARY", scope });
        await persistCleanup("RECORD_EVIDENCE_INVALID");
        throw publicationError("LISTING_ASSET_PUBLICATION_BOUNDARY");
      }
    },
  });
}
