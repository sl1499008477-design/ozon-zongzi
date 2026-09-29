import crypto from "node:crypto";
import { types } from "node:util";
import {
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  verifySourceImageAssessment,
} from "./auto-listing-source-image-intelligence-contract.mjs";

export const SOURCE_IMAGE_CLEANUP_CONTRACT_VERSION = "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_V1";
export const SOURCE_IMAGE_CLEANUP_CHECK_CONTRACT_VERSION = "AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_V1";

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,119}$/u;
const REGION_KEYS = new Set(["x", "y", "width", "height"]);
const INPUT_KEYS = new Set([
  "contractVersion", "derivativeAttemptId", "sourceAssetId", "originalContentHash", "attemptNo",
  "externalRegions", "protectedRegions", "previousReasonCodes",
]);
const CHECK_KEYS = new Set([
  "contractVersion", "derivativeAttemptId", "sourceAssetId", "originalContentHash",
  "candidateContentHash", "overlayRemoved", "productIdentityPreserved", "nativeMarksPreserved",
  "geometryPreserved", "noInventedContent", "reasonCodes",
]);
const MAX_REGION_OVERLAP_RATIO = 0.05;
const DERIVE_KEYS = new Set([
  "accountId", "jobId", "itemId", "analysisRunId", "expectedStatusVersion",
  "assessment", "attemptNo", "previousReasonCodes",
]);
const APPEARANCE_KINDS = new Set(["PRODUCT_VIEW", "PRODUCT_DETAIL", "USAGE_SCENE", "PACKAGE", "MIXED"]);
const APPEARANCE_USES = new Set(["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL", "SCENE", "PACKAGE"]);

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, keys) {
  try {
    return plain(value) && Reflect.ownKeys(value).length === keys.size
      && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
  } catch { return false; }
}

function safeId(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function validRegion(value) {
  return exact(value, REGION_KEYS)
    && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= 1 && value.y + value.height <= 1;
}

function validRegions(value, { minimum = 0 } = {}) {
  return Array.isArray(value) && !types.isProxy(value) && value.length >= minimum && value.length <= 20
    && value.every(validRegion)
    && new Set(value.map((region) => JSON.stringify(region))).size === value.length;
}

function validReasons(value) {
  return Array.isArray(value) && !types.isProxy(value) && value.length <= 20
    && new Set(value).size === value.length && value.every((reason) => REASON.test(reason));
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function overlapsProtected(externalRegions, protectedRegions) {
  return externalRegions.some((external) => protectedRegions.some((protectedRegion) =>
    intersectionArea(external, protectedRegion) / (external.width * external.height) > MAX_REGION_OVERLAP_RATIO));
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function uniqueRegions(regions) {
  const seen = new Set();
  const output = [];
  for (const region of regions) {
    if (!validRegion(region)) continue;
    const key = JSON.stringify(region);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(structuredClone(region));
    }
  }
  return output;
}

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(canonical(value))).digest("hex");

export function verifySourceImageCleanupInput(value) {
  if (!exact(value, INPUT_KEYS) || value.contractVersion !== SOURCE_IMAGE_CLEANUP_CONTRACT_VERSION
    || !safeId(value.derivativeAttemptId) || !safeId(value.sourceAssetId)
    || !HASH.test(value.originalContentHash || "")
    || !Number.isInteger(value.attemptNo) || value.attemptNo < 1 || value.attemptNo > 3
    || !validRegions(value.externalRegions, { minimum: 1 }) || !validRegions(value.protectedRegions)
    || !validReasons(value.previousReasonCodes)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_INPUT_INVALID");
  }
  if (overlapsProtected(value.externalRegions, value.protectedRegions)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_PROTECTED_REGION_OVERLAP");
  }
  return freeze(structuredClone(value));
}

export function sourceImageCleanupInputHash(value) {
  return digest(verifySourceImageCleanupInput(value));
}

export function sourceImageCleanupCandidate(rawAssessment) {
  const assessment = verifySourceImageAssessment(rawAssessment);
  if (assessment.contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
    || assessment.quality?.usable === false
    || !assessment.contentKinds.some((kind) => APPEARANCE_KINDS.has(kind))
    || !assessment.eligibleUses.some((use) => APPEARANCE_USES.has(use))
    || !assessment.viewpoints.some(({ confidence, kind }) => confidence === "CONFIRMED" && kind !== "UNKNOWN")) {
    return null;
  }
  const externalRegions = uniqueRegions(assessment.markings
    .filter(({ kind, confidence }) => kind === "EXTERNAL_OVERLAY" && confidence === "CONFIRMED")
    .map(({ region }) => region));
  if (externalRegions.length === 0) return null;
  const protectedRegions = uniqueRegions(assessment.markings
    .filter(({ kind, confidence }) => kind === "PRODUCT_MARKING" && confidence === "CONFIRMED")
    .map(({ region }) => region));
  if (overlapsProtected(externalRegions, protectedRegions)) return null;
  return freeze({
    sourceAssetId: assessment.sourceAssetId,
    originalContentHash: assessment.contentHash,
    externalRegions,
    protectedRegions,
  });
}

export function deriveSourceImageCleanupAttempt(raw = {}) {
  if (!exact(raw, DERIVE_KEYS)
    || ![raw.accountId, raw.jobId, raw.itemId, raw.analysisRunId].every(safeId)
    || !Number.isInteger(raw.expectedStatusVersion) || raw.expectedStatusVersion < 1
    || !Number.isInteger(raw.attemptNo) || raw.attemptNo < 1 || raw.attemptNo > 3
    || !validReasons(raw.previousReasonCodes)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_INPUT_INVALID");
  }
  const candidate = sourceImageCleanupCandidate(raw.assessment);
  if (!candidate) throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_NOT_REQUIRED");
  const overlayDecisionHash = digest(candidate);
  const derivativeAttemptId = `source-image-derivative-${digest({
    accountId: raw.accountId,
    jobId: raw.jobId,
    itemId: raw.itemId,
    analysisRunId: raw.analysisRunId,
    sourceAssetId: candidate.sourceAssetId,
    overlayDecisionHash,
    attemptNo: raw.attemptNo,
    previousReasonCodes: raw.previousReasonCodes,
  }).slice(0, 32)}`;
  const cleanupInput = verifySourceImageCleanupInput({
    contractVersion: SOURCE_IMAGE_CLEANUP_CONTRACT_VERSION,
    derivativeAttemptId,
    sourceAssetId: candidate.sourceAssetId,
    originalContentHash: candidate.originalContentHash,
    attemptNo: raw.attemptNo,
    externalRegions: candidate.externalRegions,
    protectedRegions: candidate.protectedRegions,
    previousReasonCodes: structuredClone(raw.previousReasonCodes),
  });
  return freeze({
    accountId: raw.accountId,
    jobId: raw.jobId,
    itemId: raw.itemId,
    analysisRunId: raw.analysisRunId,
    sourceAssetId: candidate.sourceAssetId,
    expectedStatusVersion: raw.expectedStatusVersion,
    derivativeAttemptId,
    inputHash: sourceImageCleanupInputHash(cleanupInput),
    attemptNo: raw.attemptNo,
    originalContentHash: candidate.originalContentHash,
    overlayDecisionHash,
    promptVersion: SOURCE_IMAGE_CLEANUP_CONTRACT_VERSION,
    cleanupInput,
  });
}

export function sourceImageCleanupCheckAccepted(value) {
  const checked = verifySourceImageCleanupCheck(value);
  return checked.overlayRemoved && checked.productIdentityPreserved && checked.nativeMarksPreserved
    && checked.geometryPreserved && checked.noInventedContent;
}

export function verifySourceImageCleanupCheck(value) {
  if (!exact(value, CHECK_KEYS) || value.contractVersion !== SOURCE_IMAGE_CLEANUP_CHECK_CONTRACT_VERSION
    || !safeId(value.derivativeAttemptId) || !safeId(value.sourceAssetId)
    || !HASH.test(value.originalContentHash || "") || !HASH.test(value.candidateContentHash || "")
    || ![value.overlayRemoved, value.productIdentityPreserved, value.nativeMarksPreserved,
      value.geometryPreserved, value.noInventedContent].every((entry) => typeof entry === "boolean")
    || !validReasons(value.reasonCodes)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_INVALID");
  }
  const accepted = value.overlayRemoved && value.productIdentityPreserved && value.nativeMarksPreserved
    && value.geometryPreserved && value.noInventedContent;
  if ((accepted && value.reasonCodes.length !== 0) || (!accepted && value.reasonCodes.length === 0)) {
    throw failure("AUTO_LISTING_SOURCE_IMAGE_CLEANUP_CHECK_INVALID");
  }
  return freeze(structuredClone(value));
}

export function sourceImageCleanupEvidenceHash(value) {
  return digest(verifySourceImageCleanupCheck(value));
}
