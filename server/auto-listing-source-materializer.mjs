import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import { sha256 } from "./auto-listing-asset-store.mjs";
import {
  cleanupStoredSourceAsset,
  isSafeSourceScopeIdentifier,
  storeMaterializedSourceAsset,
  verifyStoredSourceAsset,
  verifySourceAssetObjectKey,
} from "./auto-listing-source-asset-store.mjs";
import { AUTO_LISTING_SOURCE_DOWNLOAD_POLICY } from "./auto-listing-source-downloader.mjs";
import { enumerateSourceImageAssets } from "./auto-listing-source-image-intelligence-contract.mjs";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";
import { verifyVisualGroupsCapture } from "./auto-listing-visual-groups.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const hashSourceRef = (value) => crypto.createHash("sha256").update(value).digest("hex");
const SCOPE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "expectedStatusVersion"]);
const LEASE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "sourceRefHash", "inputHash", "expectedStatusVersion"]);
const ANALYSIS_SCOPE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "expectedStatusVersion"]);
const ANALYSIS_SCOPED_RUN_KEYS = Object.freeze([...ANALYSIS_SCOPE_KEYS, "analysisRunId"]);
const ANALYSIS_LEASE_KEYS = Object.freeze(["accountId", "jobId", "itemId", "owner", "sourceAssetId", "sourceRefHash", "inputHash", "expectedStatusVersion"]);
const EXECUTION_KEYS = Object.freeze(["attemptNo", "maxAttempts"]);
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
const TERMINAL_ANALYSIS_FAILURE_CODES = new Set([
  "AUTO_LISTING_SOURCE_DOWNLOAD_BLOCKED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_FAILED",
  "AUTO_LISTING_SOURCE_DOWNLOAD_INPUT_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_INVALID",
  "AUTO_LISTING_SOURCE_IMAGE_TOO_LARGE",
  "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED",
]);
const ANALYSIS_TERMINAL_FAILURE = Symbol("analysisTerminalFailure");

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
    && fields.every((field) => field === "owner"
      ? actual.owner?.kind === expected.owner?.kind && actual.owner?.id === expected.owner?.id
      : actual[field] === expected[field]);
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

function validateAnalysisScope(scope, analysisRun) {
  if ((!exactKeys(scope, ANALYSIS_SCOPE_KEYS) && !exactKeys(scope, ANALYSIS_SCOPED_RUN_KEYS))
    || !["accountId", "jobId", "itemId"].every((key) => identifier(scope[key]))
    || !Number.isInteger(scope.expectedStatusVersion) || scope.expectedStatusVersion < 1
    || !analysisRun || typeof analysisRun !== "object" || Array.isArray(analysisRun)
    || !identifier(analysisRun.id) || analysisRun.accountId !== scope.accountId
    || analysisRun.jobId !== scope.jobId || analysisRun.itemId !== scope.itemId
    || analysisRun.expectedStatusVersion !== scope.expectedStatusVersion
    || (Object.hasOwn(scope, "analysisRunId") && scope.analysisRunId !== analysisRun.id)
    || !identifier(analysisRun.sourceSnapshotId) || !HASH.test(analysisRun.sourceSnapshotHash || "")) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
}

function analysisReference(sourceAsset) {
  if (!sourceAsset || typeof sourceAsset !== "object" || Array.isArray(sourceAsset)
    || !identifier(sourceAsset.sourceAssetId)
    || !Number.isSafeInteger(sourceAsset.sourceOrdinal) || sourceAsset.sourceOrdinal < 0 || sourceAsset.sourceOrdinal > 9999
    || !HASH.test(sourceAsset.sourceRefHash || "") || sourceAsset.contentHash !== null
    || !Array.isArray(sourceAsset.memberships)) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  return {
    assetId: sourceAsset.sourceAssetId,
    sourceOrdinal: sourceAsset.sourceOrdinal,
    sourceRefHash: sourceAsset.sourceRefHash,
    contentHash: null,
    sourceRef: null,
    evidenceKind: "SOURCE_REF_HASH",
  };
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

function cloneAnalysisSourceAsset(value) {
  const assetKeys = ["sourceAssetId", "sourceOrdinal", "sourceRefHash", "contentHash", "memberships"];
  const membershipKeys = ["variantId", "sku", "mediaOrdinal"];
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error("invalid source asset");
    }
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.length !== assetKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !assetKeys.includes(key))
      || assetKeys.some((key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
      throw new Error("invalid source asset");
    }
    const memberships = descriptors.memberships.value;
    if (!Array.isArray(memberships) || utilTypes.isProxy(memberships)
      || Object.getPrototypeOf(memberships) !== Array.prototype) {
      throw new Error("invalid memberships");
    }
    const membershipOwnKeys = Reflect.ownKeys(memberships);
    const membershipDescriptors = Object.getOwnPropertyDescriptors(memberships);
    if (membershipOwnKeys.length !== memberships.length + 1
      || membershipOwnKeys.some((key) => key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(String(key))
        || Number(key) >= memberships.length))) {
      throw new Error("invalid memberships");
    }
    const clonedMemberships = [];
    for (let index = 0; index < memberships.length; index += 1) {
      const entryDescriptor = membershipDescriptors[String(index)];
      if (!entryDescriptor || entryDescriptor.enumerable !== true || !Object.hasOwn(entryDescriptor, "value")) {
        throw new Error("invalid membership");
      }
      const membership = entryDescriptor.value;
      if (!membership || typeof membership !== "object" || Array.isArray(membership) || utilTypes.isProxy(membership)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(membership))) {
        throw new Error("invalid membership");
      }
      const keys = Reflect.ownKeys(membership);
      const fields = Object.getOwnPropertyDescriptors(membership);
      if (keys.length !== membershipKeys.length
        || keys.some((key) => typeof key !== "string" || !membershipKeys.includes(key))
        || membershipKeys.some((key) => fields[key]?.enumerable !== true || !Object.hasOwn(fields[key], "value"))
        || typeof fields.variantId.value !== "string" || typeof fields.sku.value !== "string"
        || !Number.isSafeInteger(fields.mediaOrdinal.value)) {
        throw new Error("invalid membership");
      }
      clonedMemberships.push(Object.freeze(Object.fromEntries(membershipKeys.map((key) => [key, fields[key].value]))));
    }
    if (typeof descriptors.sourceAssetId.value !== "string"
      || !Number.isSafeInteger(descriptors.sourceOrdinal.value)
      || ![null, "string"].includes(descriptors.sourceRefHash.value === null ? null : typeof descriptors.sourceRefHash.value)
      || ![null, "string"].includes(descriptors.contentHash.value === null ? null : typeof descriptors.contentHash.value)) {
      throw new Error("invalid source asset");
    }
    return Object.freeze({
      sourceAssetId: descriptors.sourceAssetId.value,
      sourceOrdinal: descriptors.sourceOrdinal.value,
      sourceRefHash: descriptors.sourceRefHash.value,
      contentHash: descriptors.contentHash.value,
      memberships: Object.freeze(clonedMemberships),
    });
  } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
}

function sameEnumeratedSourceAsset(actual, expected) {
  const assetKeys = ["sourceAssetId", "sourceOrdinal", "sourceRefHash", "contentHash", "memberships"];
  const membershipKeys = ["variantId", "sku", "mediaOrdinal"];
  return exactKeys(actual, assetKeys) && exactKeys(expected, assetKeys)
    && ["sourceAssetId", "sourceOrdinal", "sourceRefHash", "contentHash"].every((key) => actual[key] === expected[key])
    && actual.memberships.length === expected.memberships.length
    && actual.memberships.every((membership, index) => exactKeys(membership, membershipKeys)
      && exactKeys(expected.memberships[index], membershipKeys)
      && membershipKeys.every((key) => membership[key] === expected.memberships[index][key]));
}

function resolveFrozenSourceUrlForEvidence(frozenSource, { scope, sourceSnapshotId, sourceHash, reference }) {
  if (!exactKeys(frozenSource, FROZEN_SOURCE_KEYS)
    || frozenSource.accountId !== scope.accountId || frozenSource.jobId !== scope.jobId
    || frozenSource.itemId !== scope.itemId || frozenSource.sourceSnapshotId !== sourceSnapshotId) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  let verified;
  try { verified = verifyAutoListingSourceSnapshot(frozenSource.sourceCapture); } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  if (verified.snapshotHash !== sourceHash
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

function resolveFrozenSourceUrl(frozenSource, parentPlan, scope, reference) {
  return resolveFrozenSourceUrlForEvidence(frozenSource, {
    scope,
    sourceSnapshotId: parentPlan.sourceSnapshotId,
    sourceHash: parentPlan.sourceHash,
    reference,
  });
}

function resolveFrozenAnalysisSource(frozenSource, { scope, analysisRun, sourceAsset }) {
  if (!exactKeys(frozenSource, FROZEN_SOURCE_KEYS)
    || frozenSource.accountId !== scope.accountId || frozenSource.jobId !== scope.jobId
    || frozenSource.itemId !== scope.itemId || frozenSource.sourceSnapshotId !== analysisRun.sourceSnapshotId) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  let verified;
  let enumerated;
  try {
    verified = verifyAutoListingSourceSnapshot(frozenSource.sourceCapture);
    enumerated = enumerateSourceImageAssets({ sourceCapture: frozenSource.sourceCapture });
  } catch {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  if (verified.snapshotHash !== analysisRun.sourceSnapshotHash
    || verified.snapshot.identity.accountId !== scope.accountId) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const matches = enumerated.filter((candidate) => candidate.sourceAssetId === sourceAsset.sourceAssetId);
  if (matches.length !== 1 || !sameEnumeratedSourceAsset(sourceAsset, matches[0])) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const trusted = matches[0];
  const candidates = new Set();
  for (const membership of trusted.memberships) {
    const membershipCandidates = new Set();
    for (const variant of verified.snapshot.variants) {
      const variantId = typeof variant.evidence?.variantId === "string" && variant.evidence.variantId.trim()
        ? variant.evidence.variantId.trim() : variant.sku;
      if (variantId !== membership.variantId || variant.sku !== membership.sku) continue;
      const sourceUrl = canonicalSourceUrl(variant.media[membership.mediaOrdinal]);
      if (!sourceUrl) continue;
      const sourceRefHash = hashSourceRef(sourceUrl);
      if (sourceRefHash === trusted.sourceRefHash
        && `source-url-${sourceRefHash.slice(0, 24)}` === trusted.sourceAssetId) {
        membershipCandidates.add(sourceUrl);
      }
    }
    if (membershipCandidates.size !== 1) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
    candidates.add([...membershipCandidates][0]);
  }
  if (candidates.size !== 1) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  return Object.freeze({ sourceUrl: [...candidates][0], sourceAsset: trusted });
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

function deriveAnalysisMaterializationInput({ scope, analysisRun, sourceAsset, policy } = {}) {
  validateAnalysisScope(scope, analysisRun);
  const reference = analysisReference(sourceAsset);
  const frozenPolicy = policyEvidence(policy);
  const owner = Object.freeze({ kind: "SOURCE_IMAGE_ANALYSIS", id: analysisRun.id });
  const inputHash = sha256({
    contractVersion: 2,
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    owner,
    expectedStatusVersion: scope.expectedStatusVersion,
    sourceSnapshotId: analysisRun.sourceSnapshotId,
    sourceSnapshotHash: analysisRun.sourceSnapshotHash,
    sourceAssetId: sourceAsset.sourceAssetId,
    sourceOrdinal: sourceAsset.sourceOrdinal,
    sourceRefHash: sourceAsset.sourceRefHash,
    policy: frozenPolicy,
  });
  return {
    owner,
    reference,
    sourceRefHash: sourceAsset.sourceRefHash,
    inputHash,
    policy: Object.freeze(frozenPolicy),
  };
}

function validateExecution(execution, maxAttempts) {
  if (!exactKeys(execution, EXECUTION_KEYS)
    || !Number.isInteger(execution.attemptNo) || execution.attemptNo < 1
    || !Number.isInteger(execution.maxAttempts) || execution.maxAttempts < 1
    || execution.attemptNo > execution.maxAttempts || execution.maxAttempts !== maxAttempts) {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  return execution;
}

const leaseFields = (value) => value?.owner?.kind === "SOURCE_IMAGE_ANALYSIS" ? ANALYSIS_LEASE_KEYS : LEASE_KEYS;

function validLeaseRecord(record, expected, expectedStatus) {
  return record && record.status === expectedStatus
    && sameFields(record, expected, leaseFields(expected))
    && identifier(record.attemptId) && Number.isInteger(record.attemptNo) && record.attemptNo >= 1 && record.attemptNo <= expected.maxAttempts
    && identifier(record.leaseToken) && validTimestamp(record.leaseExpiresAt);
}

function storedEvidence(record, expected, { requireLease }) {
  const expectedVersion = expected?.owner?.kind === "SOURCE_IMAGE_ANALYSIS" ? "SOURCE_V2" : "SOURCE_V1";
  return record && sameFields(record, expected, leaseFields(expected))
    && identifier(record.attemptId) && Number.isInteger(record.attemptNo) && record.attemptNo >= 1 && record.attemptNo <= expected.maxAttempts
    && (!requireLease || (identifier(record.leaseToken) && validTimestamp(record.leaseExpiresAt)))
    && record.objectKeyVersion === expectedVersion && HASH.test(record.contentHash || "")
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

function validExhaustedSafeFailure(record, expected) {
  return expected.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
    && record?.status === "FAILED"
    && sameFields(record, expected, ANALYSIS_LEASE_KEYS)
    && identifier(record.attemptId) && record.attemptNo === expected.maxAttempts
    && record.leaseOwner == null && record.leaseToken == null && record.leaseExpiresAt == null
    && record.objectKeyVersion == null && record.objectKey == null
    && record.contentHash == null && record.contentType == null
    && record.width == null && record.height == null && record.sizeBytes == null
    && record.acceptedAt == null
    && TERMINAL_ANALYSIS_FAILURE_CODES.has(record.errorCode)
    && typeof record.errorRetryable === "boolean";
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

function analysisAcceptedOutput(record, sourceOrdinal) {
  return Object.freeze({
    status: "ACCEPTED",
    accountId: record.accountId,
    jobId: record.jobId,
    itemId: record.itemId,
    owner: Object.freeze({ kind: record.owner.kind, id: record.owner.id }),
    sourceAssetId: record.sourceAssetId,
    sourceOrdinal,
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
  });
}

function completionInput(record) {
  return {
    accountId: record.accountId,
    jobId: record.jobId,
    itemId: record.itemId,
    ...(record.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
      ? { owner: { ...record.owner } }
      : { parentPlanId: record.parentPlanId }),
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

async function completeStored(repository, stored, expected, toAccepted = acceptedOutput) {
  let completed;
  try { completed = await repository.completeSourceMaterialization(completionInput(stored)); } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") throw materializationError(caught.code);
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  }
  if (!validAccepted(completed, expected)) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPOSITORY_FAILED", true);
  return toAccepted(completed);
}

function stableExternalFailure(error, analysisFailures = false) {
  const code = (CLOSED_FAILURE_CODES.has(error?.code)
    || (analysisFailures && TERMINAL_ANALYSIS_FAILURE_CODES.has(error?.code)))
    ? error.code : "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED";
  const retryable = code === "AUTO_LISTING_SOURCE_MATERIALIZATION_FAILED" ? true : error?.retryable === true;
  return materializationError(code, retryable);
}

async function recordFailure(repository, lease, failure) {
  const request = {
    accountId: lease.accountId,
    jobId: lease.jobId,
    itemId: lease.itemId,
    ...(lease.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
      ? { owner: { ...lease.owner } }
      : { parentPlanId: lease.parentPlanId }),
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

const skippedStale = () => Object.freeze({ status: "SKIPPED", reasonCode: "AUTO_LISTING_SOURCE_MATERIALIZATION_STALE" });

function claimConflictResult(claimConflictsAreErrors) {
  if (claimConflictsAreErrors) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED");
  return skippedStale();
}

async function materializeResolvedSourceAsset({
  scope,
  sourceUrl,
  built,
  repository,
  downloader,
  storage,
  logger,
  toAccepted = acceptedOutput,
  claimConflictsAreErrors = false,
}) {
  if (typeof repository?.reserveSourceMaterialization !== "function") {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const reserveRequest = {
    ...scope,
    sourceRefHash: built.sourceRefHash,
    inputHash: built.inputHash,
    maxAttempts: built.policy.maxAttempts,
  };
  const analysisFailures = scope.owner?.kind === "SOURCE_IMAGE_ANALYSIS";
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
  if (reservation?.status === "EXHAUSTED_SAFE_FAILURE") {
    if (!validExhaustedSafeFailure(reservation.record, reserveRequest)) {
      throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
    }
    const failure = materializationError(reservation.record.errorCode, reservation.record.errorRetryable);
    failure[ANALYSIS_TERMINAL_FAILURE] = true;
    throw failure;
  }
  if (reservation?.status === "EXISTING_ACCEPTED") {
    if (!validAccepted(reservation.record, reserveRequest)) throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
    return toAccepted(reservation.record);
  }
  if (reservation?.status === "RESERVED_STORED") {
    if (!storedEvidence(reservation.record, reserveRequest, { requireLease: true }) || reservation.record.status !== "STORED") {
      throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_REPLAY_INVALID");
    }
    try {
      await verifyStoredSourceAsset({ stored: reservation.record, storage });
    } catch (caught) {
      const failure = stableExternalFailure(caught, analysisFailures);
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
        throw stableExternalFailure(cleanupError, analysisFailures);
      }
      try { await recordFailure(repository, reservation.record, failure); } catch (recordError) {
        if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
          return claimConflictResult(claimConflictsAreErrors);
        }
        throw recordError;
      }
      throw failure;
    }
    return completeStored(repository, reservation.record, reserveRequest, toAccepted);
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
    ...(reservation.owner?.kind === "SOURCE_IMAGE_ANALYSIS"
      ? { owner: Object.freeze({ ...reservation.owner }) }
      : { parentPlanId: reservation.parentPlanId }),
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
    const failure = stableExternalFailure(caught, analysisFailures);
    if (analysisFailures && TERMINAL_ANALYSIS_FAILURE_CODES.has(failure.code)) {
      failure[ANALYSIS_TERMINAL_FAILURE] = true;
    }
    try { await recordFailure(repository, lease, failure); } catch (recordError) {
      if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
        return claimConflictResult(claimConflictsAreErrors);
      }
      throw recordError;
    }
    throw failure;
  }
  let stored;
  try {
    stored = await storeMaterializedSourceAsset({ scope: lease, downloaded, storage, repository, logger });
  } catch (caught) {
    const failure = stableExternalFailure(caught, analysisFailures);
    if (failure.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
      return claimConflictResult(claimConflictsAreErrors);
    }
    if (failure.code !== "AUTO_LISTING_SOURCE_ASSET_CLEANUP_PERSIST_FAILED") {
      try { await recordFailure(repository, lease, failure); } catch (recordError) {
        if (recordError?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
          return claimConflictResult(claimConflictsAreErrors);
        }
        throw recordError;
      }
    }
    throw failure;
  }
  try {
    return await completeStored(repository, stored, reserveRequest, toAccepted);
  } catch (caught) {
    if (caught?.code === "AUTO_LISTING_SOURCE_MATERIALIZATION_CLAIM_REJECTED") {
      await cleanupStoredSourceAsset({ scope: lease, stored, storage, repository, originalErrorCode: caught.code, logger });
      return claimConflictResult(claimConflictsAreErrors);
    }
    throw caught;
  }
}

export async function materializeSourceAsset({ scope, parentPlan, sourceSnapshot, policy, repository, downloader, storage, logger = null } = {}) {
  const built = deriveSourceMaterializationInput({ scope, parentPlan, policy });
  const reference = sourceReference(parentPlan, scope);
  const sourceUrl = resolveFrozenSourceUrl(sourceSnapshot, parentPlan, scope, reference);
  return materializeResolvedSourceAsset({
    scope,
    sourceUrl,
    built,
    repository,
    downloader,
    storage,
    logger,
  });
}

export async function materializeSourceImageForAnalysis({
  scope,
  analysisRun,
  sourceAsset,
  sourceSnapshot,
  execution,
  policy,
  repository,
  intelligenceRepository,
  downloader,
  storage,
  logger = null,
} = {}) {
  const candidateSourceAsset = cloneAnalysisSourceAsset(sourceAsset);
  const resolved = resolveFrozenAnalysisSource(sourceSnapshot, { scope, analysisRun, sourceAsset: candidateSourceAsset });
  const trustedSourceAsset = resolved.sourceAsset;
  const built = deriveAnalysisMaterializationInput({ scope, analysisRun, sourceAsset: trustedSourceAsset, policy });
  const currentExecution = validateExecution(execution, built.policy.maxAttempts);
  if (typeof intelligenceRepository?.markAssetMaterialized !== "function"
    || typeof intelligenceRepository?.markAssetUnavailable !== "function") {
    throw materializationError("AUTO_LISTING_SOURCE_MATERIALIZATION_INPUT_INVALID");
  }
  const materializationScope = {
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    owner: built.owner,
    sourceAssetId: trustedSourceAsset.sourceAssetId,
    expectedStatusVersion: scope.expectedStatusVersion,
  };
  let outcome;
  try {
    outcome = await materializeResolvedSourceAsset({
      scope: materializationScope,
      sourceUrl: resolved.sourceUrl,
      built,
      repository,
      downloader,
      storage,
      logger,
      toAccepted: (record) => analysisAcceptedOutput(record, trustedSourceAsset.sourceOrdinal),
      claimConflictsAreErrors: true,
    });
  } catch (caught) {
    if (caught?.[ANALYSIS_TERMINAL_FAILURE] !== true
      || !TERMINAL_ANALYSIS_FAILURE_CODES.has(caught?.code)
      || (caught.retryable !== false && currentExecution.attemptNo < currentExecution.maxAttempts)) {
      throw caught;
    }
    const terminalStatus = caught.code === "AUTO_LISTING_SOURCE_MEDIA_UNSUPPORTED"
      ? "UNSUPPORTED_MEDIA"
      : "DOWNLOAD_FAILED";
    await intelligenceRepository.markAssetUnavailable({
      accountId: scope.accountId,
      jobId: scope.jobId,
      itemId: scope.itemId,
      analysisRunId: analysisRun.id,
      expectedStatusVersion: scope.expectedStatusVersion,
      sourceAssetId: trustedSourceAsset.sourceAssetId,
      sourceOrdinal: trustedSourceAsset.sourceOrdinal,
      terminalStatus,
      errorCode: caught.code,
    });
    return Object.freeze({ status: "TERMINAL", sourceAssetId: trustedSourceAsset.sourceAssetId, terminalStatus });
  }
  if (outcome.status !== "ACCEPTED") return outcome;
  await intelligenceRepository.markAssetMaterialized({
    accountId: scope.accountId,
    jobId: scope.jobId,
    itemId: scope.itemId,
    analysisRunId: analysisRun.id,
    expectedStatusVersion: scope.expectedStatusVersion,
    sourceAssetId: trustedSourceAsset.sourceAssetId,
    sourceOrdinal: trustedSourceAsset.sourceOrdinal,
    sourceRefHash: outcome.sourceRefHash,
    objectKey: outcome.objectKey,
    contentHash: outcome.contentHash,
    contentType: outcome.contentType,
    sizeBytes: outcome.sizeBytes,
  });
  return outcome;
}
