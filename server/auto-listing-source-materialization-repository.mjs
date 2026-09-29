import crypto from "node:crypto";
import {
  SOURCE_ANALYSIS_ASSET_OBJECT_KEY_VERSION,
  SOURCE_ASSET_OBJECT_KEY_VERSION,
  buildSourceAssetObjectKey,
  verifySourceAssetObjectKey,
} from "./auto-listing-source-asset-store.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,119}$/u;
const CONTENT_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const SAFE_ANALYSIS_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE",
  "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED",
]);
export const SOURCE_MATERIALIZATION_OBJECT_KEY_VERSION = SOURCE_ASSET_OBJECT_KEY_VERSION;

const PLAN_BASE_KEYS = Object.freeze([
  "accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId",
  "sourceRefHash", "inputHash", "expectedStatusVersion",
]);
const ANALYSIS_BASE_KEYS = Object.freeze([
  "accountId", "jobId", "itemId", "owner", "sourceAssetId",
  "sourceRefHash", "inputHash", "expectedStatusVersion",
]);
const INTERNAL_BASE_KEYS = Object.freeze([
  "accountId", "jobId", "itemId", "owner", "sourceAssetId",
  "sourceRefHash", "inputHash", "expectedStatusVersion",
]);
const OWNER_TAIL_KEYS = Object.freeze(["attemptId", "attemptNo", "leaseToken"]);
const EVIDENCE_KEYS = Object.freeze([
  "objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "sizeBytes",
]);
const LIST_KEYS = new Set(["accountId", "jobId", "itemId", "parentPlanId", "expectedStatusVersion"]);
const IMMUTABLE_LIST_KEYS = new Set(["accountId", "jobId", "itemId", "parentPlanId"]);
const IMMUTABLE_ANALYSIS_LIST_KEYS = new Set([
  "accountId", "jobId", "itemId", "parentPlanId", "sourceImageAnalysisRunId",
]);
const IMMUTABLE_REUSED_ANALYSIS_LIST_KEYS = new Set([
  ...IMMUTABLE_ANALYSIS_LIST_KEYS, "sourceMaterializationAnalysisRunId",
]);
const FACTORY_KEYS = new Set(["now", "leaseMs", "token", "id", "readItemState", "maxRows", "leaseOwner"]);
const POSTGRES_FACTORY_KEYS = new Set(["pool", "leaseMs", "token", "id", "maxRows", "leaseOwner"]);
const CLEANUP_TAIL_KEYS = Object.freeze([
  "materializationAttemptId",
  "sourceRefHash", "inputHash", "expectedStatusVersion", "attemptNo", "leaseToken",
  "objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height", "sizeBytes",
  "reasonCode", "originalErrorCode",
]);

function failure(code) {
  const messages = {
    AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID: "源图片物化记录无效",
    AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED: "源图片物化租约已失效",
    AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT: "源图片物化记录不一致",
    AUTO_LISTING_SOURCE_MATERIALIZATION_BATCH_EXCEEDED: "源图片物化记录数量超出限制",
    AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED: "源图片物化记录暂时不可用",
  };
  const error = new Error(messages[code] || messages.AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID);
  error.code = code;
  error.retryable = code === "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"
    || code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED";
  return error;
}

const clone = (value) => structuredClone(value);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactObject(value, keys) {
  try {
    return plainObject(value) && Object.keys(value).length === keys.size
      && Object.keys(value).every((key) => keys.has(key));
  } catch {
    return false;
  }
}
function safeIdentifier(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 240 && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(value);
}
function milliseconds(value) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  return timestamp;
}
const same = (left, right, keys) => keys.every((key) => left?.[key] === right?.[key]);
const sameOwned = (left, right, keys) => left?.owner?.kind === right?.owner?.kind
  && left?.owner?.id === right?.owner?.id && same(left, right, keys.filter((key) => key !== "owner"));
const scopeKey = (value) => [value.accountId, value.jobId, value.itemId, value.owner.kind, value.owner.id,
  value.sourceAssetId, value.sourceRefHash, value.inputHash, value.expectedStatusVersion].join("\u0001");
export const buildSourceMaterializationObjectKey = buildSourceAssetObjectKey;

export function verifySourceMaterializationObjectKey(input = {}) {
  try {
    const version = input.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
      ? SOURCE_ANALYSIS_ASSET_OBJECT_KEY_VERSION
      : SOURCE_MATERIALIZATION_OBJECT_KEY_VERSION;
    return input.objectKeyVersion === version
      && verifySourceAssetObjectKey(input)
      && Buffer.byteLength(input.objectKey, "utf8") <= 2048 && !/(?:https?|ftp|file|data):|\?|#/iu.test(input.objectKey);
  } catch {
    return false;
  }
}

function exactOwner(owner) {
  return plainObject(owner) && Reflect.ownKeys(owner).length === 2
    && owner.kind === "SOURCE_IMAGE_ANALYSIS" && safeIdentifier(owner.id);
}
function normalizeOwnedInput(rawInput, tailKeys) {
  const planKeys = new Set([...PLAN_BASE_KEYS, ...tailKeys]);
  const analysisKeys = new Set([...ANALYSIS_BASE_KEYS, ...tailKeys]);
  let input;
  if (exactObject(rawInput, planKeys)) {
    input = { ...rawInput, owner: { kind: "CONTENT_PLAN", id: rawInput.parentPlanId } };
    delete input.parentPlanId;
  } else if (exactObject(rawInput, analysisKeys) && exactOwner(rawInput.owner)) {
    input = { ...rawInput, owner: { ...rawInput.owner } };
  } else {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  if (!["accountId", "jobId", "itemId", "sourceAssetId"].every((key) => safeIdentifier(input[key]))
    || !safeIdentifier(input.owner.id)
    || !HASH.test(input.sourceRefHash || "") || !HASH.test(input.inputHash || "")
    || !Number.isInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
    || input.expectedStatusVersion > 2_147_483_647) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  return input;
}
function validateReserve(rawInput) {
  const input = normalizeOwnedInput(rawInput, ["maxAttempts"]);
  if (input.maxAttempts !== 3) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  return input;
}
function validateOwner(rawInput, tailKeys) {
  const input = normalizeOwnedInput(rawInput, [...OWNER_TAIL_KEYS, ...tailKeys]);
  if (!safeIdentifier(input.attemptId) || !safeIdentifier(input.leaseToken)
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return input;
}
function validateEvidence(rawInput) {
  const input = validateOwner(rawInput, EVIDENCE_KEYS);
  if (!verifySourceMaterializationObjectKey(input) || !HASH.test(input.contentHash || "")
    || !Object.hasOwn(CONTENT_TYPES, input.contentType)
    || !Number.isInteger(input.width) || input.width < 1 || input.width > 100_000
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 100_000
    || input.width * input.height > MAX_SOURCE_PIXELS
    || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 8 * 1024 * 1024) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return input;
}
function validateFailure(rawInput) {
  const input = validateOwner(rawInput, ["errorCode", "errorRetryable"]);
  if (!ERROR_CODE.test(input.errorCode || "") || typeof input.errorRetryable !== "boolean") {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return input;
}
function validateList(input) {
  if (!exactObject(input, LIST_KEYS) || !["accountId", "jobId", "itemId", "parentPlanId"].every((key) => safeIdentifier(input[key]))
    || !Number.isInteger(input.expectedStatusVersion) || input.expectedStatusVersion < 1
    || input.expectedStatusVersion > 2_147_483_647) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return input;
}
function validateImmutableList(input) {
  const planOwned = exactObject(input, IMMUTABLE_LIST_KEYS);
  const analysisOwned = exactObject(input, IMMUTABLE_ANALYSIS_LIST_KEYS);
  const reusedAnalysisOwned = exactObject(input, IMMUTABLE_REUSED_ANALYSIS_LIST_KEYS);
  if ((!planOwned && !analysisOwned && !reusedAnalysisOwned)
    || !["accountId", "jobId", "itemId", "parentPlanId"].every((key) => safeIdentifier(input[key]))
    || ((analysisOwned || reusedAnalysisOwned) && !safeIdentifier(input.sourceImageAnalysisRunId))
    || (reusedAnalysisOwned && !safeIdentifier(input.sourceMaterializationAnalysisRunId))) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return {
    ...input,
    ownerKind: analysisOwned || reusedAnalysisOwned ? "SOURCE_IMAGE_ANALYSIS" : "CONTENT_PLAN",
    materializationAnalysisRunId: reusedAnalysisOwned
      ? input.sourceMaterializationAnalysisRunId : input.sourceImageAnalysisRunId,
  };
}
function validateCleanup(rawInput) {
  const input = normalizeOwnedInput(rawInput, CLEANUP_TAIL_KEYS);
  if (!["materializationAttemptId", "leaseToken"].every((key) => safeIdentifier(input[key]))
    || !Number.isInteger(input.attemptNo) || input.attemptNo < 1 || input.attemptNo > 3
    || typeof input.objectKey !== "string" || Buffer.byteLength(input.objectKey, "utf8") > 2048
    || !HASH.test(input.contentHash || "") || !Object.hasOwn(CONTENT_TYPES, input.contentType)
    || !Number.isInteger(input.width) || input.width < 1 || input.width > 100_000
    || !Number.isInteger(input.height) || input.height < 1 || input.height > 100_000
    || input.width * input.height > MAX_SOURCE_PIXELS
    || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_SOURCE_BYTES
    || !ERROR_CODE.test(input.reasonCode || "")
    || !ERROR_CODE.test(input.originalErrorCode || "")) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  return input;
}

function validStoredRecord(row) {
  return row && ["STORED", "ACCEPTED"].includes(row.status) && verifySourceMaterializationObjectKey(row)
    && Number.isInteger(row.width) && row.width > 0 && Number.isInteger(row.height) && row.height > 0
    && row.width * row.height <= MAX_SOURCE_PIXELS
    && Number.isInteger(row.sizeBytes) && row.sizeBytes > 0 && row.sizeBytes <= 8 * 1024 * 1024;
}
function acceptedRecord(row) {
  return validStoredRecord(row) && row.status === "ACCEPTED" && row.leaseOwner === null
    && row.leaseToken === null && row.leaseExpiresAt === null && row.errorCode === null
    && row.errorRetryable === null && row.acceptedAt !== null;
}
function exhaustedSafeFailureRecord(row, input) {
  return input.owner.kind === "SOURCE_IMAGE_ANALYSIS"
    && row?.status === "FAILED"
    && sameOwned(row, input, INTERNAL_BASE_KEYS)
    && row.attemptNo === input.maxAttempts
    && row.leaseOwner === null && row.leaseToken === null && row.leaseExpiresAt === null
    && row.objectKeyVersion === null && row.objectKey === null
    && row.contentHash === null && row.contentType === null
    && row.width === null && row.height === null && row.sizeBytes === null
    && row.acceptedAt === null
    && SAFE_ANALYSIS_FAILURE_CODES.has(row.errorCode)
    && typeof row.errorRetryable === "boolean";
}
function publicRecord(row) {
  const value = clone(row);
  value.attemptId = value.id ?? value.attemptId;
  delete value.id;
  if (value.owner?.kind === "CONTENT_PLAN") {
    value.parentPlanId = value.owner.id;
    delete value.owner;
  } else if (value.owner?.kind === "SOURCE_IMAGE_ANALYSIS") {
    value.owner = Object.freeze({ ...value.owner });
  }
  for (const key of ["leaseExpiresAt", "acceptedAt", "createdAt", "updatedAt"]) {
    if (value[key] != null) value[key] = new Date(milliseconds(value[key])).toISOString();
  }
  return value;
}
function publicCleanupRecord(row) {
  const value = clone(row);
  if (value.owner?.kind === "CONTENT_PLAN") {
    value.parentPlanId = value.owner.id;
    delete value.owner;
  } else if (value.owner?.kind === "SOURCE_IMAGE_ANALYSIS") {
    value.owner = Object.freeze({ ...value.owner });
  }
  return value;
}
function snapshotRecord(row) {
  const value = clone(row);
  if (value.owner?.kind === "CONTENT_PLAN") {
    value.parentPlanId = value.owner.id;
    delete value.owner;
  }
  return value;
}
function reservedResponse(row, status = "RESERVED") {
  if (status === "RESERVED_STORED") return { status, record: publicRecord(row) };
  const response = {
    status,
    attemptId: row.id ?? row.attemptId,
    attemptNo: row.attemptNo,
    leaseToken: row.leaseToken,
    leaseExpiresAt: new Date(milliseconds(row.leaseExpiresAt)).toISOString(),
    ...Object.fromEntries(INTERNAL_BASE_KEYS.filter((key) => key !== "owner").map((key) => [key, row[key]])),
    ...(row.owner.kind === "CONTENT_PLAN" ? { parentPlanId: row.owner.id } : { owner: Object.freeze({ ...row.owner }) }),
  };
  return response;
}
function normalizeFactoryOptions(options, keys) {
  if (!plainObject(options) || Object.keys(options).some((key) => !keys.has(key))) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  return options;
}

export function createMemorySourceMaterializationRepository(options = {}) {
  const config = normalizeFactoryOptions(options, FACTORY_KEYS);
  const now = config.now ?? (() => Date.now());
  const leaseMs = config.leaseMs ?? 60_000;
  const token = config.token ?? (() => crypto.randomUUID());
  const id = config.id ?? (() => `source-materialization-${crypto.randomUUID()}`);
  const readItemState = config.readItemState ?? (async (input) => ({ status: "PLANNING", statusVersion: input.expectedStatusVersion }));
  const maxRows = config.maxRows ?? 100;
  const leaseOwner = config.leaseOwner ?? "source-materializer";
  if (typeof now !== "function" || typeof token !== "function" || typeof id !== "function" || typeof readItemState !== "function"
    || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1000
    || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100 || !safeIdentifier(leaseOwner)) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  const rows = [];
  const cleanupRows = [];
  async function stateDisposition(input) {
    let state;
    try {
      state = await readItemState(Object.freeze({
        accountId: input.accountId, jobId: input.jobId, itemId: input.itemId,
        ...(input.owner.kind === "CONTENT_PLAN" ? { parentPlanId: input.owner.id } : { owner: Object.freeze({ ...input.owner }) }),
        expectedStatusVersion: input.expectedStatusVersion,
      }));
    }
    catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
    if (!plainObject(state) || typeof state.status !== "string" || !Number.isInteger(state.statusVersion)) {
      throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
    }
    if (state.status === "CANCELLED") return "CANCELLED";
    if (state.statusVersion !== input.expectedStatusVersion) return "STALE";
    return "CURRENT";
  }
  function owned(input, allowedStatuses) {
    const row = rows.find((candidate) => candidate.id === input.attemptId && candidate.attemptNo === input.attemptNo
      && scopeKey(candidate) === scopeKey(input));
    const timestamp = milliseconds(now());
    if (!row || !allowedStatuses.includes(row.status) || row.leaseToken !== input.leaseToken
      || row.leaseExpiresAt <= timestamp) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
    return { row, timestamp };
  }
  return Object.freeze({
    async reserveSourceMaterialization(rawInput) {
      const input = validateReserve(rawInput);
      const disposition = await stateDisposition(input);
      if (disposition !== "CURRENT") return { status: disposition };
      const matching = rows.filter((row) => scopeKey(row) === scopeKey(input));
      const accepted = matching.find((row) => row.status === "ACCEPTED");
      if (accepted) {
        if (!acceptedRecord(accepted)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
        return { status: "EXISTING_ACCEPTED", record: publicRecord(accepted) };
      }
      const timestamp = milliseconds(now());
      const active = matching.find((row) => ["MATERIALIZING", "STORED"].includes(row.status) && row.leaseExpiresAt > timestamp);
      if (active) return { status: "IN_PROGRESS" };
      const stored = matching.find((row) => row.status === "STORED" && row.leaseExpiresAt <= timestamp);
      if (stored) {
        if (!validStoredRecord(stored)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
        let value;
        try { value = token(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
        value = safeIdentifier(value) ? value : "";
        if (!value) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
        stored.leaseOwner = leaseOwner; stored.leaseToken = `${value}:${stored.attemptNo}`;
        stored.leaseExpiresAt = timestamp + leaseMs; stored.updatedAt = timestamp;
        return reservedResponse(stored, "RESERVED_STORED");
      }
      for (const row of matching) {
        if (row.status === "MATERIALIZING" && row.leaseExpiresAt <= timestamp) {
          Object.assign(row, { status: "FAILED", leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
            errorCode: "AUTO_LISTING_SOURCE_LEASE_EXPIRED", errorRetryable: true, updatedAt: timestamp });
        }
      }
      const attemptNo = matching.reduce((maximum, row) => Math.max(maximum, row.attemptNo), 0) + 1;
      if (attemptNo > input.maxAttempts) {
        const last = matching.find((row) => row.attemptNo === input.maxAttempts);
        return exhaustedSafeFailureRecord(last, input)
          ? { status: "EXHAUSTED_SAFE_FAILURE", record: publicRecord(last) }
          : { status: "ATTEMPTS_EXHAUSTED" };
      }
      let nonce; let attemptId;
      try { nonce = token(); attemptId = id(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
      if (!safeIdentifier(nonce) || !safeIdentifier(attemptId)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
      const row = {
        id: attemptId, ...Object.fromEntries(INTERNAL_BASE_KEYS.map((key) => [key, input[key]])), attemptNo,
        status: "MATERIALIZING", leaseOwner, leaseToken: `${nonce}:${attemptNo}`, leaseExpiresAt: timestamp + leaseMs,
        objectKeyVersion: null, objectKey: null, contentHash: null, contentType: null,
        width: null, height: null, sizeBytes: null, acceptedAt: null, errorCode: null, errorRetryable: null,
        createdAt: timestamp, updatedAt: timestamp,
      };
      rows.push(row);
      return reservedResponse(row);
    },
    async recordStoredSourceMaterialization(rawInput) {
      const input = validateEvidence(rawInput);
      if (await stateDisposition(input) !== "CURRENT") throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
      const { row, timestamp } = owned(input, ["MATERIALIZING", "STORED"]);
      if (row.status === "STORED" && !same(row, input, EVIDENCE_KEYS)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
      Object.assign(row, Object.fromEntries(EVIDENCE_KEYS.map((key) => [key, input[key]])), { status: "STORED", updatedAt: timestamp });
      return publicRecord(row);
    },
    async completeSourceMaterialization(rawInput) {
      const input = validateEvidence(rawInput);
      if (await stateDisposition(input) !== "CURRENT") throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
      const { row, timestamp } = owned(input, ["STORED"]);
      if (!same(row, input, EVIDENCE_KEYS) || !validStoredRecord(row)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
      Object.assign(row, { status: "ACCEPTED", leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
        acceptedAt: timestamp, updatedAt: timestamp });
      return publicRecord(row);
    },
    async failSourceMaterialization(rawInput) {
      const input = validateFailure(rawInput);
      if (await stateDisposition(input) !== "CURRENT") throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
      const { row, timestamp } = owned(input, ["MATERIALIZING", "STORED"]);
      Object.assign(row, { status: "FAILED", leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
        errorCode: input.errorCode, errorRetryable: input.errorRetryable, updatedAt: timestamp });
      return publicRecord(row);
    },
    async listAcceptedSourceMaterializations(rawInput) {
      const input = validateList(rawInput);
      const found = rows.filter((row) => row.accountId === input.accountId && row.jobId === input.jobId
        && row.itemId === input.itemId && row.owner.kind === "CONTENT_PLAN" && row.owner.id === input.parentPlanId
        && row.expectedStatusVersion === input.expectedStatusVersion && row.status === "ACCEPTED")
        .sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId) || left.attemptNo - right.attemptNo);
      if (found.length > maxRows || found.some((row) => !acceptedRecord(row))) {
        throw failure(found.length > maxRows ? "AUTO_LISTING_SOURCE_MATERIALIZATION_BATCH_EXCEEDED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      return found.map(publicRecord);
    },
    async listAcceptedSourceMaterializationsForPlan(rawInput) {
      const input = validateImmutableList(rawInput);
      const found = rows.filter((row) => row.accountId === input.accountId && row.jobId === input.jobId
        && row.itemId === input.itemId && row.owner.kind === input.ownerKind
        && row.owner.id === (input.ownerKind === "SOURCE_IMAGE_ANALYSIS"
          ? input.materializationAnalysisRunId : input.parentPlanId)
        && row.status === "ACCEPTED")
        .sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId) || left.attemptNo - right.attemptNo);
      if (found.length > maxRows || found.some((row) => !acceptedRecord(row))) {
        throw failure(found.length > maxRows ? "AUTO_LISTING_SOURCE_MATERIALIZATION_BATCH_EXCEEDED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      return found.map(publicRecord);
    },
    async recordSourceObjectCleanupRequired(rawInput) {
      const input = validateCleanup(rawInput);
      const existing = cleanupRows.find((row) => row.accountId === input.accountId && row.objectKey === input.objectKey);
      if (existing) {
        if (!sameOwned(existing, input, [...INTERNAL_BASE_KEYS, ...CLEANUP_TAIL_KEYS])) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
        return publicCleanupRecord(existing);
      }
      const materialization = rows.find((row) => row.id === input.materializationAttemptId
        && row.accountId === input.accountId && row.jobId === input.jobId && row.itemId === input.itemId
        && row.owner.kind === input.owner.kind && row.owner.id === input.owner.id && row.sourceAssetId === input.sourceAssetId
        && row.sourceRefHash === input.sourceRefHash && row.inputHash === input.inputHash
        && row.expectedStatusVersion === input.expectedStatusVersion && row.attemptNo === input.attemptNo
        && row.leaseToken === input.leaseToken && row.leaseExpiresAt > milliseconds(now())
        && ["MATERIALIZING", "STORED"].includes(row.status));
      if (!materialization || !verifySourceMaterializationObjectKey(input)) {
        throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      let cleanupId;
      try { cleanupId = id(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
      if (!safeIdentifier(cleanupId)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
      const timestamp = milliseconds(now());
      const record = { id: `cleanup-${cleanupId}`, ...clone(input), status: "PENDING", attemptCount: 0,
        claimOwner: null, claimToken: null, claimExpiresAt: null, nextRetryAt: timestamp,
        lastErrorCode: null, createdAt: timestamp, updatedAt: timestamp };
      cleanupRows.push(record);
      return publicCleanupRecord(record);
    },
    snapshot() { return rows.map(snapshotRecord); },
  });
}

function fromRow(row) {
  if (!row) return null;
  return {
    attemptId: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    owner: row.parent_plan_id !== null && row.parent_plan_id !== undefined
      ? { kind: "CONTENT_PLAN", id: row.parent_plan_id }
      : { kind: "SOURCE_IMAGE_ANALYSIS", id: row.source_analysis_run_id },
    sourceAssetId: row.source_asset_id,
    sourceRefHash: row.source_ref_hash, inputHash: row.input_hash,
    expectedStatusVersion: row.expected_status_version, attemptNo: row.attempt_no, status: row.status,
    leaseOwner: row.lease_owner, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at,
    objectKeyVersion: row.object_key_version, objectKey: row.object_key, contentHash: row.content_hash,
    contentType: row.content_type, width: row.width, height: row.height, sizeBytes: row.size_bytes,
    acceptedAt: row.accepted_at, errorCode: row.error_code, errorRetryable: row.error_retryable,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function fromCleanupRow(row) {
  if (!row) return null;
  return {
    id: row.id, accountId: row.account_id, jobId: row.job_id, itemId: row.item_id,
    owner: row.parent_plan_id !== null && row.parent_plan_id !== undefined
      ? { kind: "CONTENT_PLAN", id: row.parent_plan_id }
      : { kind: "SOURCE_IMAGE_ANALYSIS", id: row.source_analysis_run_id },
    sourceAssetId: row.source_asset_id,
    materializationAttemptId: row.materialization_attempt_id,
    sourceRefHash: row.source_ref_hash, inputHash: row.input_hash,
    expectedStatusVersion: row.expected_status_version, attemptNo: row.attempt_no,
    leaseToken: row.lease_token, objectKeyVersion: row.object_key_version,
    objectKey: row.object_key, contentHash: row.content_hash, contentType: row.content_type,
    width: row.width, height: row.height, sizeBytes: row.size_bytes, reasonCode: row.reason_code,
    originalErrorCode: row.original_error_code, status: row.status, attemptCount: row.attempt_count,
    claimOwner: row.claim_owner, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
    nextRetryAt: row.next_retry_at, lastErrorCode: row.last_error_code,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createPostgresSourceMaterializationRepository(options = {}) {
  const config = normalizeFactoryOptions(options, POSTGRES_FACTORY_KEYS);
  const { pool } = config;
  const leaseMs = config.leaseMs ?? 60_000;
  const token = config.token ?? (() => crypto.randomUUID());
  const id = config.id ?? (() => `source-materialization-${crypto.randomUUID()}`);
  const maxRows = config.maxRows ?? 100;
  const leaseOwner = config.leaseOwner ?? "source-materializer";
  if ((typeof pool?.connect !== "function" && typeof pool?.query !== "function") || typeof token !== "function" || typeof id !== "function"
    || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 24 * 60 * 60 * 1000
    || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100 || !safeIdentifier(leaseOwner)) {
    throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
  }
  const query = async (text, parameters) => {
    try { return await pool.query(text, parameters); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
  };
  async function transaction(work) {
    let client;
    try {
      client = typeof pool.connect === "function" ? await pool.connect() : pool;
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (cause) {
      if (client) { try { await client.query("ROLLBACK"); } catch {} }
      if (cause?.code?.startsWith?.("AUTO_LISTING_SOURCE_MATERIALIZATION_")) throw cause;
      throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
    } finally {
      if (client && client !== pool) { try { await client.release(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); } }
    }
  }
  const baseValues = (input) => [input.accountId, input.jobId, input.itemId, input.owner.id,
    input.sourceAssetId, input.sourceRefHash, input.inputHash, input.expectedStatusVersion];
  const ownerColumn = (input) => input.owner.kind === "CONTENT_PLAN" ? "parent_plan_id" : "source_analysis_run_id";
  async function reserveSourceMaterialization(rawInput) {
    const input = validateReserve(rawInput);
    let nonce; let attemptId;
    try { nonce = token(); attemptId = id(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
    if (!safeIdentifier(nonce) || !safeIdentifier(attemptId)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
    return transaction(async (client) => {
      const item = await client.query(input.owner.kind === "CONTENT_PLAN"
        ? `SELECT item.status,item.status_version
           FROM auto_listing_job_items AS item
           JOIN ai_content_plans AS plan
             ON plan.account_id=item.account_id AND plan.job_id=item.job_id
            AND plan.item_id=item.id AND plan.id=$4
           WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
           FOR UPDATE OF item`
        : `SELECT item.status,item.status_version
           FROM auto_listing_job_items AS item
           JOIN auto_listing_source_image_analysis_runs AS analysis
             ON analysis.account_id=item.account_id AND analysis.job_id=item.job_id
            AND analysis.item_id=item.id AND analysis.id=$4
            AND analysis.expected_status_version=item.status_version
           WHERE item.account_id=$1 AND item.job_id=$2 AND item.id=$3
             AND item.current_source_image_analysis_run_id=analysis.id
           FOR UPDATE OF item`,
        [input.accountId, input.jobId, input.itemId, input.owner.id]);
      if (item.rowCount !== 1) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_INVALID");
      if (item.rows[0].status === "CANCELLED") return { status: "CANCELLED" };
      if (item.rows[0].status_version !== input.expectedStatusVersion) return { status: "STALE" };
      const parameters = baseValues(input);
      const acceptedResult = await client.query(
        `SELECT * FROM auto_listing_source_materialization_attempts
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND ${ownerColumn(input)}=$4 AND source_asset_id=$5
           AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8 AND status='ACCEPTED'
         FOR UPDATE`, parameters,
      );
      if (acceptedResult.rowCount) {
        const record = fromRow(acceptedResult.rows[0]);
        if (acceptedResult.rowCount !== 1 || !acceptedRecord(record)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
        return { status: "EXISTING_ACCEPTED", record: publicRecord(record) };
      }
      const active = await client.query(
        `SELECT * FROM auto_listing_source_materialization_attempts
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND ${ownerColumn(input)}=$4 AND source_asset_id=$5
           AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8
           AND status IN ('MATERIALIZING','STORED') AND lease_expires_at > NOW()
         FOR UPDATE`, parameters,
      );
      if (active.rowCount) return { status: "IN_PROGRESS" };
      const storedResult = await client.query(
        `UPDATE auto_listing_source_materialization_attempts
         SET lease_owner=$9,lease_token=$10::TEXT || ':' || attempt_no::text,
             lease_expires_at=NOW()+($11::INTEGER * INTERVAL '1 millisecond'),updated_at=NOW()
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND ${ownerColumn(input)}=$4 AND source_asset_id=$5
           AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8
           AND status='STORED' AND lease_expires_at <= NOW()
         RETURNING *`, [...parameters, leaseOwner, nonce, leaseMs],
      );
      if (storedResult.rowCount) {
        const record = fromRow(storedResult.rows[0]);
        if (storedResult.rowCount !== 1 || !validStoredRecord(record)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
        return reservedResponse(record, "RESERVED_STORED");
      }
      await client.query(
        `UPDATE auto_listing_source_materialization_attempts
         SET status='FAILED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
             error_code='AUTO_LISTING_SOURCE_LEASE_EXPIRED',error_retryable=TRUE,updated_at=NOW()
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND ${ownerColumn(input)}=$4 AND source_asset_id=$5
           AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8
           AND status='MATERIALIZING' AND lease_expires_at <= NOW()`, parameters,
      );
      const attempts = await client.query(
        `SELECT COALESCE(MAX(attempt_no),0)::INTEGER AS attempt_no
         FROM auto_listing_source_materialization_attempts
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND ${ownerColumn(input)}=$4 AND source_asset_id=$5
           AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8`, parameters,
      );
      const attemptNo = Number(attempts.rows?.[0]?.attempt_no || 0) + 1;
      if (attemptNo > input.maxAttempts) {
        if (input.owner.kind === "SOURCE_IMAGE_ANALYSIS") {
          const lastFailure = await client.query(
            `SELECT * FROM auto_listing_source_materialization_attempts
             WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND source_analysis_run_id=$4 AND source_asset_id=$5
               AND source_ref_hash=$6 AND input_hash=$7 AND expected_status_version=$8
               AND attempt_no=$9 AND status='FAILED'
             FOR UPDATE`, [...parameters, input.maxAttempts],
          );
          const record = fromRow(lastFailure.rows?.[0]);
          if (lastFailure.rowCount === 1 && exhaustedSafeFailureRecord(record, input)) {
            return { status: "EXHAUSTED_SAFE_FAILURE", record: publicRecord(record) };
          }
        }
        return { status: "ATTEMPTS_EXHAUSTED" };
      }
      const inserted = await client.query(
        `INSERT INTO auto_listing_source_materialization_attempts (
           id,account_id,job_id,item_id,${ownerColumn(input)},source_asset_id,source_ref_hash,input_hash,
           expected_status_version,attempt_no,status,lease_owner,lease_token,lease_expires_at
         ) VALUES ($9,$1,$2,$3,$4,$5,$6,$7,$8,$10::INTEGER,'MATERIALIZING',$11,$12::TEXT || ':' || $10::INTEGER::TEXT,
           NOW()+($13::INTEGER * INTERVAL '1 millisecond'))
         RETURNING *`, [...parameters, attemptId, attemptNo, leaseOwner, nonce, leaseMs],
      );
      const record = fromRow(inserted.rows?.[0]);
      if (inserted.rowCount !== 1 || !record || record.status !== "MATERIALIZING") {
        throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
      }
      return reservedResponse(record);
    });
  }
  async function transition(rawInput, kind) {
    const input = kind === "FAIL" ? validateFailure(rawInput) : validateEvidence(rawInput);
    const base = baseValues(input);
    const owner = [input.attemptId, input.attemptNo, input.leaseToken];
    let statement; let parameters;
    if (kind === "STORE") {
      statement = `UPDATE auto_listing_source_materialization_attempts AS attempt
        SET status='STORED',object_key_version=$12,object_key=$13,content_hash=$14,content_type=$15,
            width=$16,height=$17,size_bytes=$18,updated_at=NOW()
        FROM auto_listing_job_items AS item
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.${ownerColumn(input)}=$4
          AND attempt.source_asset_id=$5 AND attempt.source_ref_hash=$6 AND attempt.input_hash=$7
          AND attempt.expected_status_version=$8 AND attempt.id=$9 AND attempt.attempt_no=$10 AND attempt.lease_token=$11
          AND attempt.status IN ('MATERIALIZING','STORED') AND attempt.lease_expires_at > NOW()
          AND (attempt.status='MATERIALIZING' OR (attempt.object_key_version=$12 AND attempt.object_key=$13
            AND attempt.content_hash=$14 AND attempt.content_type=$15 AND attempt.width=$16
            AND attempt.height=$17 AND attempt.size_bytes=$18))
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status <> 'CANCELLED' AND item.status_version=attempt.expected_status_version
        RETURNING attempt.*`;
      parameters = [...base, ...owner, ...EVIDENCE_KEYS.map((key) => input[key])];
    } else if (kind === "COMPLETE") {
      statement = `UPDATE auto_listing_source_materialization_attempts AS attempt
        SET status='ACCEPTED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,accepted_at=NOW(),updated_at=NOW()
        FROM auto_listing_job_items AS item
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.${ownerColumn(input)}=$4
          AND attempt.source_asset_id=$5 AND attempt.source_ref_hash=$6 AND attempt.input_hash=$7
          AND attempt.expected_status_version=$8 AND attempt.id=$9 AND attempt.attempt_no=$10 AND attempt.lease_token=$11
          AND attempt.status='STORED' AND attempt.lease_expires_at > NOW()
          AND attempt.object_key_version=$12 AND attempt.object_key=$13 AND attempt.content_hash=$14
          AND attempt.content_type=$15 AND attempt.width=$16 AND attempt.height=$17 AND attempt.size_bytes=$18
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status <> 'CANCELLED' AND item.status_version=attempt.expected_status_version
        RETURNING attempt.*`;
      parameters = [...base, ...owner, ...EVIDENCE_KEYS.map((key) => input[key])];
    } else {
      statement = `UPDATE auto_listing_source_materialization_attempts AS attempt
        SET status='FAILED',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            error_code=$12,error_retryable=$13,updated_at=NOW()
        FROM auto_listing_job_items AS item
        WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3 AND attempt.${ownerColumn(input)}=$4
          AND attempt.source_asset_id=$5 AND attempt.source_ref_hash=$6 AND attempt.input_hash=$7
          AND attempt.expected_status_version=$8 AND attempt.id=$9 AND attempt.attempt_no=$10 AND attempt.lease_token=$11
          AND attempt.status IN ('MATERIALIZING','STORED') AND attempt.lease_expires_at > NOW()
          AND item.account_id=attempt.account_id AND item.job_id=attempt.job_id AND item.id=attempt.item_id
          AND item.status <> 'CANCELLED' AND item.status_version=attempt.expected_status_version
        RETURNING attempt.*`;
      parameters = [...base, ...owner, input.errorCode, input.errorRetryable];
    }
    let result;
    try { result = await query(statement, parameters); } catch (cause) { throw cause; }
    const record = fromRow(result.rows?.[0]);
    if (result.rowCount !== 1 || !record) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
    if (kind === "STORE" && (!validStoredRecord(record) || !sameOwned(record, input, [...INTERNAL_BASE_KEYS, ...EVIDENCE_KEYS]))) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
    if (kind === "COMPLETE" && (!acceptedRecord(record) || !sameOwned(record, input, [...INTERNAL_BASE_KEYS, ...EVIDENCE_KEYS]))) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
    if (kind === "FAIL" && (record.status !== "FAILED" || record.errorCode !== input.errorCode || record.errorRetryable !== input.errorRetryable)) {
      throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
    }
    return publicRecord(record);
  }
  return Object.freeze({
    reserveSourceMaterialization,
    recordStoredSourceMaterialization: (input) => transition(input, "STORE"),
    completeSourceMaterialization: (input) => transition(input, "COMPLETE"),
    failSourceMaterialization: (input) => transition(input, "FAIL"),
    async listAcceptedSourceMaterializations(rawInput) {
      const input = validateList(rawInput);
      const result = await query(
        `SELECT * FROM auto_listing_source_materialization_attempts
         WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND parent_plan_id=$4
           AND expected_status_version=$5 AND status='ACCEPTED'
         ORDER BY source_asset_id,attempt_no LIMIT $6`,
        [input.accountId, input.jobId, input.itemId, input.parentPlanId, input.expectedStatusVersion, maxRows + 1],
      );
      const rows = (result.rows || []).map(fromRow);
      if (rows.length > maxRows || rows.some((row) => !acceptedRecord(row))) {
        throw failure(rows.length > maxRows ? "AUTO_LISTING_SOURCE_MATERIALIZATION_BATCH_EXCEEDED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      return rows.map(publicRecord);
    },
    async listAcceptedSourceMaterializationsForPlan(rawInput) {
      const input = validateImmutableList(rawInput);
      const result = input.ownerKind === "SOURCE_IMAGE_ANALYSIS"
        && input.materializationAnalysisRunId !== input.sourceImageAnalysisRunId
        ? await query(
          `SELECT attempt.* FROM auto_listing_source_materialization_attempts AS attempt
           JOIN ai_content_plans AS parent
             ON parent.account_id=attempt.account_id AND parent.job_id=attempt.job_id
            AND parent.item_id=attempt.item_id AND parent.id=$4
            AND parent.source_image_analysis_run_id=$5
           WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3
             AND attempt.source_analysis_run_id=$6 AND attempt.status='ACCEPTED'
           ORDER BY attempt.source_asset_id,attempt.attempt_no LIMIT $7`,
          [input.accountId, input.jobId, input.itemId, input.parentPlanId,
            input.sourceImageAnalysisRunId, input.materializationAnalysisRunId, maxRows + 1],
        )
        : input.ownerKind === "SOURCE_IMAGE_ANALYSIS"
        ? await query(
          `SELECT attempt.* FROM auto_listing_source_materialization_attempts AS attempt
           JOIN ai_content_plans AS parent
             ON parent.account_id=attempt.account_id AND parent.job_id=attempt.job_id
            AND parent.item_id=attempt.item_id AND parent.id=$4
            AND parent.source_image_analysis_run_id=$5
           WHERE attempt.account_id=$1 AND attempt.job_id=$2 AND attempt.item_id=$3
             AND attempt.source_analysis_run_id=$5 AND attempt.status='ACCEPTED'
           ORDER BY attempt.source_asset_id,attempt.attempt_no LIMIT $6`,
          [input.accountId, input.jobId, input.itemId, input.parentPlanId,
            input.sourceImageAnalysisRunId, maxRows + 1],
        )
        : await query(
          `SELECT * FROM auto_listing_source_materialization_attempts
           WHERE account_id=$1 AND job_id=$2 AND item_id=$3 AND parent_plan_id=$4
             AND status='ACCEPTED'
           ORDER BY source_asset_id,attempt_no LIMIT $5`,
          [input.accountId, input.jobId, input.itemId, input.parentPlanId, maxRows + 1],
        );
      const rows = (result.rows || []).map(fromRow);
      if (rows.length > maxRows || rows.some((row) => !acceptedRecord(row))) {
        throw failure(rows.length > maxRows ? "AUTO_LISTING_SOURCE_MATERIALIZATION_BATCH_EXCEEDED" : "AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      return rows.map(publicRecord);
    },
    async recordSourceObjectCleanupRequired(rawInput) {
      const input = validateCleanup(rawInput);
      if (!verifySourceMaterializationObjectKey(input)) {
        throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      let cleanupId;
      try { cleanupId = id(); } catch { throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED"); }
      if (!safeIdentifier(cleanupId)) throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED");
      const values = [cleanupId, input.accountId, input.jobId, input.itemId, input.owner.id,
        input.sourceAssetId, input.materializationAttemptId, input.sourceRefHash, input.inputHash,
        input.expectedStatusVersion, input.attemptNo, input.leaseToken, input.objectKeyVersion,
        input.objectKey, input.contentHash, input.contentType, input.width, input.height, input.sizeBytes,
        input.reasonCode, input.originalErrorCode];
      const inserted = await query(
        `INSERT INTO auto_listing_source_object_cleanup_obligations (
           id,account_id,job_id,item_id,${ownerColumn(input)},source_asset_id,materialization_attempt_id,
           source_ref_hash,input_hash,expected_status_version,attempt_no,lease_token,
           object_key_version,object_key,content_hash,content_type,width,height,size_bytes,
           reason_code,original_error_code
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
         FROM auto_listing_source_materialization_attempts AS attempt
         WHERE attempt.account_id=$2 AND attempt.job_id=$3 AND attempt.item_id=$4
           AND attempt.${ownerColumn(input)}=$5 AND attempt.source_asset_id=$6 AND attempt.id=$7
           AND attempt.source_ref_hash=$8 AND attempt.input_hash=$9
           AND attempt.expected_status_version=$10 AND attempt.attempt_no=$11 AND attempt.lease_token=$12
           AND attempt.status IN ('MATERIALIZING','STORED') AND attempt.lease_expires_at > NOW()
         ON CONFLICT (account_id,object_key) DO NOTHING
         RETURNING *`, values,
      );
      let record = fromCleanupRow(inserted.rows?.[0]);
      if (!record) {
        const found = await query(
          `SELECT * FROM auto_listing_source_object_cleanup_obligations
           WHERE account_id=$1 AND object_key=$2`, [input.accountId, input.objectKey],
        );
        record = fromCleanupRow(found.rows?.[0]);
      }
      if (!record || record.status !== "PENDING" || !sameOwned(record, input, [...INTERNAL_BASE_KEYS, ...CLEANUP_TAIL_KEYS])) {
        throw failure("AUTO_LISTING_SOURCE_MATERIALIZATION_CONFLICT");
      }
      return publicCleanupRecord(record);
    },
  });
}
