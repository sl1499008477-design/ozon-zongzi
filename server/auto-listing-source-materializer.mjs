import crypto from "node:crypto";
import { sha256 } from "./auto-listing-asset-store.mjs";
import {
  cleanupStoredSourceAsset,
  isSafeSourceScopeIdentifier,
  storeMaterializedSourceAsset,
  verifyStoredSourceAsset,
  verifySourceAssetObjectKey,
} from "./auto-listing-source-asset-store.mjs";
import { AUTO_LISTING_SOURCE_DOWNLOAD_POLICY } from "./auto-listing-source-downloader.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
import { verifyVisualGroupsCapture } from "./auto-listing-visual-groups.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const hashSourceRef = (value) => crypto.createHash("sha256").update(value).digest("hex");
const SCOPE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "expectedStatusVersion"]);
const LEASE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "sourceRefHash", "inputHash", "expectedStatusVersion"]);
const FROZEN_SOURCE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "sourceSnapshotId", "sourceCapture"]);
const POLICY_KEYS = new Set(["policyVersion", "timeoutMs", "maxBytes", "maxPixels", "maxRedirects", "maxAttempts", "forbidHttpsDowngrade"]);
const CLOSED_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE",
  "AUTO_LISTING_SOURCE_ASSET_INVALID",
  "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNAVAILABLE",
  "AUTO_LISTING_SOURCE_ASSET_STORAGE_UNVERIFIED",
  "AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED",
  "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED",
  "AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED",
]);

function materializationError(code, retryable = false) {
  const value = new Error("自动上架来源图片处理失败");
  value.code = code;
  value.retryable = retryable;
  return value;
}

const identifier = isSafeSourceScopeIdentifier;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function sameFields(actual, expected, fields) {
  return actual && typeof actual === "object" && !Array.isArray(actual)
    && fields.every((field) => actual[field] === expected[field]);
}

function validTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateScope(scope) {
  if (!exactKeys(scope, SCOPE_KEYS)
    || !["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId"].every((key) => identifier(scope[key]))
    || !Number.isInteger(scope.expectedStatusVersion) || scope.expectedStatusVersion < 1) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
}

function sourceReference(parentPlan, scope) {
  if (!parentPlan || typeof parentPlan !== "object" || Array.isArray(parentPlan)
    || parentPlan.id !== scope.parentPlanId || parentPlan.sourceAccountId !== scope.accountId
    || parentPlan.jobId !== scope.jobId || parentPlan.itemId !== scope.itemId
    || !identifier(parentPlan.sourceSnapshotId)
    || !HASH.test(parentPlan.sourceHash || "") || !HASH.test(parentPlan.planHash || "")
    || sha256(parentPlan.plan) !== parentPlan.planHash
    || parentPlan.visualGroupsHash !== parentPlan.visualGroups?.visualGroupsHash) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  try { verifyVisualGroupsCapture(parentPlan.visualGroups, parentPlan.sourceHash); } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const matches = parentPlan.visualGroups.groups
    .flatMap((group) => group.referenceImages)
    .filter((reference) => reference.assetId === scope.sourceAssetId);
  if (!matches.length) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  if (matches.every((reference) => reference.evidenceKind === "CONTENT_HASH")) {
    throw materializationError("AUTO_LISTING_SOURCE_ALREADY_MATERIALIZED");
  }
  const first = matches[0];
  if (first.evidenceKind !== "SOURCE_REF_HASH" || !HASH.test(first.sourceRefHash || "")
    || first.contentHash !== null || first.sourceRef !== null
    || matches.some((reference) => JSON.stringify(reference) !== JSON.stringify(first))) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  return first;
}

function canonicalSourceUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8192) return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.toString();
}

function resolveFrozenSourceUrl(frozenSource, parentPlan, scope, reference) {
  if (!exactKeys(frozenSource, FROZEN_SOURCE_KEYS)
    || frozenSource.accountId !== scope.accountId || frozenSource.jobId !== scope.jobId
    || frozenSource.itemId !== scope.itemId || frozenSource.sourceSnapshotId !== parentPlan.sourceSnapshotId) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  let verified;
  try { verified = verifyAutoListingSourceSnapshot(frozenSource.sourceCapture); } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  if (verified.snapshotHash !== parentPlan.sourceHash
    || verified.snapshot.identity.accountId !== scope.accountId) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const candidates = new Set();
  const mediaValues = [
    ...verified.snapshot.variants.flatMap((variant) => variant.media),
    ...verified.snapshot.media.images,
  ];
  for (const value of mediaValues) {
    const sourceUrl = canonicalSourceUrl(value);
    if (!sourceUrl) continue;
    const sourceRefHash = hashSourceRef(sourceUrl);
    const sourceAssetId = `source-url-${sourceRefHash.slice(0, 24)}`;
    if (sourceRefHash === reference.sourceRefHash && sourceAssetId === reference.assetId) candidates.add(sourceUrl);
  }
  if (candidates.size !== 1) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  return [...candidates][0];
}

function policyEvidence(policy) {
  const value = policy || AUTO_LISTING_SOURCE_DOWNLOAD_POLICY;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== POLICY_KEYS.size || Object.keys(value).some((key) => !POLICY_KEYS.has(key))
    || value.policyVersion !== "SOURCE_DOWNLOAD_V1"
    || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 250 || value.timeoutMs > 60_000
    || !Number.isInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxBytes
    || !Number.isInteger(value.maxPixels) || value.maxPixels < 1 || value.maxPixels > AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxPixels
    || !Number.isInteger(value.maxRedirects) || value.maxRedirects < 0 || value.maxRedirects > AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxRedirects
    || value.maxAttempts !== AUTO_LISTING_SOURCE_DOWNLOAD_POLICY.maxAttempts
    || value.forbidHttpsDowngrade !== true) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  return {
    policyVersion: value.policyVersion,
    timeoutMs: value.timeoutMs,
    maxBytes: value.maxBytes,
    maxPixels: value.maxPixels,
    maxRedirects: value.maxRedirects,
    maxAttempts: value.maxAttempts,
    forbidHttpsDowngrade: true,
  };
}

function deriveSourceMaterializationInput({ scope, parentPlan, policy } = {}) {
  validateScope(scope);
  const reference = sourceReference(parentPlan, scope);
  const frozenPolicy = policyEvidence(policy);
  const sourceRefHash = reference.sourceRefHash;
  const inputHash = sha256({
    contractVersion: 1,
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    parentPlanId: scope.parentPlanId,
    expectedStatusVersion: scope.expectedStatusVersion,
    parentPlanHash: parentPlan.planHash,
    parentVisualGroupsHash: parentPlan.visualGroupsHash,
    sourceAssetId: scope.sourceAssetId,
    sourceRefHash,
    policy: frozenPolicy,
  });
  return { sourceRefHash, inputHash, policy: Object.freeze(frozenPolicy) };
}

export function buildSourceMaterializationInput(input = {}) {
  const derived = deriveSourceMaterializationInput(input);
  return Object.freeze({ sourceRefHash: derived.sourceRefHash, inputHash: derived.inputHash, policy: derived.policy });
}

function validLeaseRecord(record, expected, expectedStatus) {
  return record && record.status === expectedStatus
    && sameFields(record, expected, LEASE_KEYS)
    && identifier(record.attemptId) && Number.isInteger(record.attemptNo) && record.attemptNo >= 1 && record.attemptNo <= expected.maxAttempts
    && identifier(record.leaseToken) && validTimestamp(record.leaseExpiresAt);
}

function storedEvidence(record, expected, { requireLease }) {
  return record && sameFields(record, expected, LEASE_KEYS)
    && identifier(record.attemptId) && Number.isInteger(record.attemptNo) && record.attemptNo >= 1 && record.attemptNo <= expected.maxAttempts
    && (!requireLease || (identifier(record.leaseToken) && validTimestamp(record.leaseExpiresAt)))
    && record.objectKeyVersion === "SOURCE_V1" && HASH.test(record.contentHash || "")
    && ["image/png", "image/jpeg", "image/webp"].includes(record.contentType)
    && Number.isInteger(record.width) && record.width > 0
    && Number.isInteger(record.height) && record.height > 0
    && Number.isInteger(record.sizeBytes) && record.sizeBytes > 0
    && verifySourceAssetObjectKey(record);
}

function validAccepted(record, expected) {
  return record?.status === "ACCEPTED" && storedEvidence(record, expected, { requireLease: false })
    && record.leaseToken == null && record.leaseExpiresAt == null && validTimestamp(record.acceptedAt)
    && (record.errorCode == null) && (record.errorRetryable == null);
}

function acceptedOutput(record) {
  const result = {
    status: "ACCEPTED",
    accountId: record.accountId,
    jobId: record.jobId,
    itemId: record.itemId,
    parentPlanId: record.parentPlanId,
    sourceAssetId: record.sourceAssetId,
    sourceRefHash: record.sourceRefHash,
    inputHash: record.inputHash,
    attemptId: record.attemptId,
    attemptNo: record.attemptNo,
    objectKeyVersion: record.objectKeyVersion,
    objectKey: record.objectKey,
    contentHash: record.contentHash,
    contentType: record.contentType,
    width: record.width,
    height: record.height,
    sizeBytes: record.sizeBytes,
    acceptedAt: record.acceptedAt,
  };
  return Object.freeze(result);
}

function completionInput(record) {
  return {
    accountId: record.accountId,
    jobId: record.jobId,
    itemId: record.itemId,
    parentPlanId: record.parentPlanId,
    sourceAssetId: record.sourceAssetId,
    sourceRefHash: record.sourceRefHash,
    inputHash: record.inputHash,
    expectedStatusVersion: record.expectedStatusVersion,
    attemptId: record.attemptId,
    attemptNo: record.attemptNo,
    leaseToken: record.leaseToken,
    objectKeyVersion: record.objectKeyVersion,
    objectKey: record.objectKey,
    contentHash: record.contentHash,
    contentType: record.contentType,
    width: record.width,
    height: record.height,
    sizeBytes: record.sizeBytes,
  };
}

async function completeStored(repository, stored, expected) {
  let completed;
  try { completed = await repository.completeSourceMaterialization(completionInput(stored)); } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") throw materializationError(caught.code);
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  }
  if (!validAccepted(completed, expected)) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  return acceptedOutput(completed);
}

function stableExternalFailure(error) {
  const code = CLOSED_FAILURE_CODES.has(error?.code) ? error.code : "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED";
  const retryable = code === "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED" ? true : error?.retryable === true;
  return materializationError(code, retryable);
}

async function recordFailure(repository, lease, failure) {
  const request = {
    accountId: lease.accountId,
    jobId: lease.jobId,
    itemId: lease.itemId,
    parentPlanId: lease.parentPlanId,
    sourceAssetId: lease.sourceAssetId,
    sourceRefHash: lease.sourceRefHash,
    inputHash: lease.inputHash,
    expectedStatusVersion: lease.expectedStatusVersion,
    attemptId: lease.attemptId,
    attemptNo: lease.attemptNo,
    leaseToken: lease.leaseToken,
    errorCode: failure.code,
    errorRetryable: failure.retryable === true,
  };
  let failed;
  try { failed = await repository.failSourceMaterialization(request); } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
      throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
    }
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  }
  if (!sameFields(failed, request, Object.keys(request).filter((key) => !["leaseToken", "leaseExpiresAt"].includes(key)))
    || failed.status !== "FAILED" || failed.leaseToken != null || failed.leaseExpiresAt != null) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  }
}

export async function materializeSourceAsset({ scope, parentPlan, sourceSnapshot, policy, repository, downloader, storage, logger = null } = {}) {
  const built = deriveSourceMaterializationInput({ scope, parentPlan, policy });
  const reference = sourceReference(parentPlan, scope);
  const sourceUrl = resolveFrozenSourceUrl(sourceSnapshot, parentPlan, scope, reference);
  if (typeof repository?.reserveSourceMaterialization !== "function") {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const reserveRequest = {
    ...scope,
    sourceRefHash: built.sourceRefHash,
    inputHash: built.inputHash,
    maxAttempts: built.policy.maxAttempts,
  };
  let reservation;
  try { reservation = await repository.reserveSourceMaterialization(reserveRequest); } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  }
  if (reservation?.status === "CANCELLED" || reservation?.status === "STALE") {
    return Object.freeze({
      status: "SKIPPED",
      reasonCode: reservation.status === "CANCELLED"
        ? "AUTO_LISTING_SOURCE_MATERIALIZATION_CANCELLED"
        : "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE",
    });
  }
  if (reservation?.status === "IN_PROGRESS") {
    return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_IN_PROGRESS" });
  }
  if (reservation?.status === "ATTEMPTS_EXHAUSTED") {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_ATTEMPTS_EXHAUSTED");
  }
  if (reservation?.status === "EXISTING_ACCEPTED") {
    if (!validAccepted(reservation.record, reserveRequest)) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
    return acceptedOutput(reservation.record);
  }
  if (reservation?.status === "RESERVED_STORED") {
    if (!storedEvidence(reservation.record, reserveRequest, { requireLease: true }) || reservation.record.status !== "STORED") {
      throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
    }
    try {
      await verifyStoredSourceAsset({ stored: reservation.record, storage });
    } catch (caught) {
      const failure = stableExternalFailure(caught);
      try {
        await cleanupStoredSourceAsset({
          scope: reservation.record,
          stored: reservation.record,
          storage,
          repository,
          originalErrorCode: failure.code,
          logger,
        });
      } catch (cleanupError) {
        throw stableExternalFailure(cleanupError);
      }
      try { await recordFailure(repository, reservation.record, failure); } catch (recordError) {
        if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
          return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
        }
        throw recordError;
      }
      throw failure;
    }
    return completeStored(repository, reservation.record, reserveRequest);
  }
  if (!validLeaseRecord(reservation, reserveRequest, "RESERVED")) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_RESERVATION_FAILED", true);
  }
  if (typeof downloader?.downloadSourceImage !== "function" || typeof repository?.recordStoredSourceMaterialization !== "function"
    || typeof repository?.recordSourceObjectCleanupRequired !== "function" || typeof repository?.completeSourceMaterialization !== "function"
    || typeof repository?.failSourceMaterialization !== "function") {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const lease = {
    accountId: reservation.accountId,
    jobId: reservation.jobId,
    itemId: reservation.itemId,
    parentPlanId: reservation.parentPlanId,
    sourceAssetId: reservation.sourceAssetId,
    sourceRefHash: reservation.sourceRefHash,
    inputHash: reservation.inputHash,
    expectedStatusVersion: reservation.expectedStatusVersion,
    attemptId: reservation.attemptId,
    attemptNo: reservation.attemptNo,
    leaseToken: reservation.leaseToken,
    leaseExpiresAt: reservation.leaseExpiresAt,
  };
  let downloaded;
  try {
    downloaded = await downloader.downloadSourceImage({
      sourceUrl,
      timeoutMs: built.policy.timeoutMs,
      maxBytes: built.policy.maxBytes,
      maxPixels: built.policy.maxPixels,
      maxRedirects: built.policy.maxRedirects,
      forbidHttpsDowngrade: true,
    });
  } catch (caught) {
    const failure = stableExternalFailure(caught);
    try { await recordFailure(repository, lease, failure); } catch (recordError) {
      if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
        return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
      }
      throw recordError;
    }
    throw failure;
  }
  let stored;
  try {
    stored = await storeMaterializedSourceAsset({ scope: lease, downloaded, storage, repository, logger });
  } catch (caught) {
    const failure = stableExternalFailure(caught);
    if (failure.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
      return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
    }
    if (failure.code !== "AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED") {
      try { await recordFailure(repository, lease, failure); } catch (recordError) {
        if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
          return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
        }
        throw recordError;
      }
    }
    throw failure;
  }
  try {
    return await completeStored(repository, stored, reserveRequest);
  } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
      await cleanupStoredSourceAsset({ scope: lease, stored, storage, repository, originalErrorCode: caught.code, logger });
      return Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });
    }
    throw caught;
  }
}
