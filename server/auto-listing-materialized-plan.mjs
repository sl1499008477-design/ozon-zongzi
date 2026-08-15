import crypto from "node:crypto";
import { verifySourceMaterializationObjectKey } from "./auto-listing-source-materialization-repository.mjs";
import { buildSourceMaterializationInput } from "./auto-listing-source-materializer.mjs";
import { verifyVisualGroupsCapture } from "./auto-listing-visual-groups.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_PARENT_BYTES = 4 * 1024 * 1024;
const SCOPE_KEYS = new Set(["accountId", "jobId", "itemId", "parentPlanId", "expectedStatusVersion"]);
const BUILD_KEYS = new Set(["scope", "parentPlan", "acceptedMaterializations"]);
const FINALIZE_KEYS = new Set(["scope", "parentPlan", "repository"]);
const PARENT_KEYS = new Set([
  "id", "sourceAccountId", "jobId", "itemId", "sourceSnapshotId", "strategyVersionId", "profileId",
  "strategyHash", "configHash", "sourceHash", "inputHash", "plannerModel", "profileVersion",
  "promptTemplateVersion", "plan", "planHash", "visualGroupsHash", "visualGroups", "factRegistry", "regeneration",
  "gatewayRequestId", "planningContract", "skeletonHash",
]);
const MATERIALIZATION_KEYS = new Set([
  "accountId", "jobId", "itemId", "parentPlanId", "sourceAssetId", "sourceRefHash", "inputHash",
  "expectedStatusVersion", "attemptId", "attemptNo", "status", "leaseOwner", "leaseToken",
  "leaseExpiresAt", "objectKeyVersion", "objectKey", "contentHash", "contentType", "width", "height",
  "sizeBytes", "acceptedAt", "errorCode", "errorRetryable", "createdAt", "updatedAt",
]);
const DERIVED_KEYS = new Set([...PARENT_KEYS, "parentPlanId", "derivationKind", "materializationSetHash"]);
const REGENERATION_KEYS = new Set(["requestId", "reason"]);
const PLAN_KEYS = new Set(["version", "language", "slots"]);
const SLOT_KEYS = new Set([
  "slotKey", "visualGroupKey", "role", "order", "textDensity", "claims", "sourceFactIds",
  "referenceAssetIds", "preserve", "prohibitedClaims",
]);
const CLAIM_KEYS = new Set(["text", "claimType", "sourceFactIds"]);
const FACT_KEYS = new Set([
  "factId", "field", "kind", "value", "numericValue", "unit", "sourcePath", "dictionaryValueId", "visualGroupKeys",
]);

function materializedPlanError(code = "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID", retryable = false) {
  const messages = {
    AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID: "自动上架派生计划输入无效",
    AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID: "自动上架来源图片证据不完整",
    AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_FAILED: "自动上架派生计划暂时无法保存",
    AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_CONFLICT: "自动上架派生计划记录不一致",
  };
  const error = new Error(messages[code] || messages.AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID);
  error.code = code;
  error.retryable = retryable;
  return error;
}

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
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 240 && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/(?:https?|ftp|file|data):|www\.|@|api[_-]?key|password|passwd|secret|bearer|authorization|cookie|credential|private[_-]?key|access[_-]?token|refresh[_-]?token/iu.test(value);
}

function safeOptionalText(value) {
  return value === null || (typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 240 && !/[\u0000-\u001f\u007f]/u.test(value));
}

function compareText(left, right) {
  return Buffer.from(String(left), "utf8").compare(Buffer.from(String(right), "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]))
}

const canonicalText = (value) => JSON.stringify(canonical(value));
const sha256 = (value) => crypto.createHash("sha256").update(canonicalText(value)).digest("hex");
const sameJson = (left, right) => canonicalText(left) === canonicalText(right);

function assertJsonSafe(value, active = new Set(), depth = 0) {
  if (depth > 64) throw materializedPlanError();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw materializedPlanError();
    return;
  }
  if (!Array.isArray(value) && !plainObject(value)) throw materializedPlanError();
  if (active.has(value)) throw materializedPlanError();
  active.add(value);
  try {
    if (Array.isArray(value)) value.forEach((entry) => assertJsonSafe(entry, active, depth + 1));
    else for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw materializedPlanError();
      assertJsonSafe(entry, active, depth + 1);
    }
  } finally {
    active.delete(value);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function validIsoTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateScope(value) {
  if (!exactObject(value, SCOPE_KEYS)
    || !["accountId", "jobId", "itemId", "parentPlanId"].every((key) => safeIdentifier(value[key]))
    || !Number.isInteger(value.expectedStatusVersion) || value.expectedStatusVersion < 1
    || value.expectedStatusVersion > 2_147_483_647) throw materializedPlanError();
  return value;
}

function validateParentPlan(value, scope) {
  try {
    assertJsonSafe(value);
    if (!exactObject(value, PARENT_KEYS)
      || !["id", "sourceAccountId", "jobId", "itemId", "sourceSnapshotId", "strategyVersionId", "profileId", "plannerModel", "promptTemplateVersion"]
        .every((key) => safeIdentifier(value[key]))
      || value.id !== scope.parentPlanId || value.sourceAccountId !== scope.accountId
      || value.jobId !== scope.jobId || value.itemId !== scope.itemId
      || !["strategyHash", "configHash", "sourceHash", "inputHash", "planHash", "visualGroupsHash"].every((key) => HASH.test(value[key] || ""))
      || !["LEGACY_FULL_PLAN_V3", "FIXED_SKELETON_V1"].includes(value.planningContract)
      || (value.planningContract === "LEGACY_FULL_PLAN_V3" && value.skeletonHash !== null)
      || (value.planningContract === "FIXED_SKELETON_V1" && !HASH.test(value.skeletonHash || ""))
      || !Number.isInteger(value.profileVersion) || value.profileVersion < 1
      || !exactObject(value.plan, PLAN_KEYS) || value.plan.version !== 1 || value.plan.language !== "ru"
      || sha256(value.plan) !== value.planHash
      || !Array.isArray(value.factRegistry) || value.factRegistry.length < 1 || value.factRegistry.length > 10_000
      || !safeOptionalText(value.gatewayRequestId)
      || !(value.regeneration === null || (exactObject(value.regeneration, REGENERATION_KEYS)
        && safeIdentifier(value.regeneration.requestId) && safeIdentifier(value.regeneration.reason)))
      || Buffer.byteLength(canonicalText(value), "utf8") > MAX_PARENT_BYTES) throw materializedPlanError();
    verifyVisualGroupsCapture(value.visualGroups, value.sourceHash);
    if (value.visualGroupsHash !== value.visualGroups.visualGroupsHash) throw materializedPlanError();

    const groupByKey = new Map(value.visualGroups.groups.map((group) => [group.visualGroupKey, group]));
    const evidenceByAssetId = new Map();
    for (const group of value.visualGroups.groups) for (const reference of group.referenceImages) {
      const known = evidenceByAssetId.get(reference.assetId);
      if (known && !sameJson(known, reference)) throw materializedPlanError();
      evidenceByAssetId.set(reference.assetId, reference);
    }
    const factIds = new Set();
    for (const fact of value.factRegistry) {
      if (!plainObject(fact) || Object.keys(fact).some((key) => !FACT_KEYS.has(key))
        || !safeIdentifier(fact.factId) || factIds.has(fact.factId)
        || typeof fact.kind !== "string" || !fact.kind.trim()
        || typeof fact.value !== "string" || !fact.value.trim()
        || typeof fact.sourcePath !== "string" || !fact.sourcePath.trim()
        || (Object.hasOwn(fact, "field") && (typeof fact.field !== "string" || !fact.field.trim()))
        || (Object.hasOwn(fact, "numericValue") && fact.numericValue !== null
          && (typeof fact.numericValue !== "number" || !Number.isFinite(fact.numericValue)))
        || (Object.hasOwn(fact, "unit") && fact.unit !== null && (typeof fact.unit !== "string" || !fact.unit.trim()))
        || (Object.hasOwn(fact, "dictionaryValueId") && fact.dictionaryValueId !== null
          && !safeIdentifier(String(fact.dictionaryValueId)))
        || !Array.isArray(fact.visualGroupKeys)
        || fact.visualGroupKeys.some((groupKey) => !safeIdentifier(groupKey) || !groupByKey.has(groupKey))) {
        throw materializedPlanError();
      }
      factIds.add(fact.factId);
    }
    if (!Array.isArray(value.plan.slots)) throw materializedPlanError();
    for (const slot of value.plan.slots) {
      const group = groupByKey.get(slot?.visualGroupKey);
      if (!exactObject(slot, SLOT_KEYS) || !safeIdentifier(slot.slotKey) || !safeIdentifier(slot.visualGroupKey)
        || !group || !Array.isArray(slot.referenceAssetIds) || !slot.referenceAssetIds.length
        || !Array.isArray(slot.sourceFactIds) || !slot.sourceFactIds.length
        || slot.sourceFactIds.some((factId) => !factIds.has(factId)) || !Array.isArray(slot.claims)) throw materializedPlanError();
      for (const claim of slot.claims) {
        if (!exactObject(claim, CLAIM_KEYS) || typeof claim.text !== "string" || !claim.text.trim()
          || typeof claim.claimType !== "string" || !claim.claimType.trim()
          || !Array.isArray(claim.sourceFactIds) || !claim.sourceFactIds.length
          || claim.sourceFactIds.some((factId) => !slot.sourceFactIds.includes(factId))) throw materializedPlanError();
      }
      const available = new Set(group.referenceImages.map((entry) => entry.assetId));
      if (slot.referenceAssetIds.some((assetId) => !safeIdentifier(assetId) || !available.has(assetId))) throw materializedPlanError();
    }
    return value;
  } catch (error) {
    if (error?.code === "AUTO_LISTING_MATERIALIZED_PLAN_INPUT_INVALID") throw error;
    throw materializedPlanError();
  }
}

function sourceEvidence(parentPlan) {
  const byId = new Map();
  for (const group of parentPlan.visualGroups.groups) {
    for (const reference of group.referenceImages) {
      if (reference.evidenceKind !== "SOURCE_REF_HASH") continue;
      const known = byId.get(reference.assetId);
      if (known && !sameJson(known, reference)) throw materializedPlanError();
      if (!safeIdentifier(reference.assetId) || !HASH.test(reference.sourceRefHash || "")
        || reference.sourceRef !== null || reference.contentHash !== null) throw materializedPlanError();
      byId.set(reference.assetId, reference);
    }
  }
  if (!byId.size || byId.size > 100) throw materializedPlanError();
  return byId;
}

function validateAcceptedRecord(record, scope, source) {
  if (!exactObject(record, MATERIALIZATION_KEYS)
    || record.accountId !== scope.accountId || record.jobId !== scope.jobId || record.itemId !== scope.itemId
    || record.parentPlanId !== scope.parentPlanId || record.sourceAssetId !== source.assetId
    || record.sourceRefHash !== source.sourceRefHash || !HASH.test(record.inputHash || "")
    || record.expectedStatusVersion !== scope.expectedStatusVersion
    || !safeIdentifier(record.attemptId) || !Number.isInteger(record.attemptNo) || record.attemptNo < 1 || record.attemptNo > 3
    || record.status !== "ACCEPTED" || record.leaseOwner !== null || record.leaseToken !== null || record.leaseExpiresAt !== null
    || record.objectKeyVersion !== "SOURCE_V1" || !verifySourceMaterializationObjectKey(record)
    || !HASH.test(record.contentHash || "") || !CONTENT_TYPES.has(record.contentType)
    || !Number.isInteger(record.width) || record.width < 1 || !Number.isInteger(record.height) || record.height < 1
    || record.width * record.height > MAX_SOURCE_PIXELS
    || !Number.isInteger(record.sizeBytes) || record.sizeBytes < 1 || record.sizeBytes > MAX_SOURCE_BYTES
    || !validIsoTimestamp(record.acceptedAt) || !validIsoTimestamp(record.createdAt) || !validIsoTimestamp(record.updatedAt)
    || record.errorCode !== null || record.errorRetryable !== null) {
    throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
  }
  return record;
}

function materializationIdentity(record) {
  return {
    sourceAssetId: record.sourceAssetId,
    sourceRefHash: record.sourceRefHash,
    inputHash: record.inputHash,
    expectedStatusVersion: record.expectedStatusVersion,
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
}

function validateMaterializationSet(values, scope, parentPlan) {
  if (!Array.isArray(values) || values.length > 100) {
    throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
  }
  const expected = sourceEvidence(parentPlan);
  if (values.length !== expected.size) throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
  const byAsset = new Map();
  for (const record of values) {
    const source = expected.get(record?.sourceAssetId);
    if (!source || byAsset.has(record.sourceAssetId)) {
      throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
    }
    validateAcceptedRecord(record, scope, source);
    let canonicalInput;
    try {
      canonicalInput = buildSourceMaterializationInput({
        scope: { ...scope, sourceAssetId: source.assetId },
        parentPlan,
      });
    } catch {
      throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
    }
    if (record.sourceRefHash !== canonicalInput.sourceRefHash || record.inputHash !== canonicalInput.inputHash) {
      throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
    }
    byAsset.set(record.sourceAssetId, record);
  }
  const ordered = [...byAsset.values()].sort((left, right) => compareText(left.sourceAssetId, right.sourceAssetId));
  return { byAsset, ordered, materializationSetHash: sha256(ordered.map(materializationIdentity)) };
}

function deriveVisualGroups(parentPlan, byAsset) {
  const visualGroups = structuredClone(parentPlan.visualGroups);
  for (const group of visualGroups.groups) {
    group.referenceImages = group.referenceImages.map((reference) => {
      if (reference.evidenceKind === "CONTENT_HASH") return reference;
      const materialization = byAsset.get(reference.assetId);
      if (!materialization) throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_EVIDENCE_INVALID");
      return {
        assetId: reference.assetId,
        sourceRefHash: reference.sourceRefHash,
        contentHash: materialization.contentHash,
        sourceRef: null,
        evidenceKind: "CONTENT_HASH",
      };
    });
  }
  const base = { sourceHash: visualGroups.sourceHash, groups: visualGroups.groups, reasonCodes: visualGroups.reasonCodes };
  visualGroups.visualGroupsHash = sha256(base);
  verifyVisualGroupsCapture(visualGroups, parentPlan.sourceHash);
  return visualGroups;
}

function verifyDerivedPlan(value, expected) {
  if (!exactObject(value, DERIVED_KEYS) || !sameJson(value, expected)) {
    throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_CONFLICT");
  }
  return deepFreeze(structuredClone(value));
}

export function buildMaterializedPlan(input = {}) {
  if (!exactObject(input, BUILD_KEYS)) throw materializedPlanError();
  const scope = validateScope(input.scope);
  const parentPlan = validateParentPlan(input.parentPlan, scope);
  const materializations = validateMaterializationSet(input.acceptedMaterializations, scope, parentPlan);
  const visualGroups = deriveVisualGroups(parentPlan, materializations.byAsset);
  const inputHash = sha256({
    contractVersion: "MATERIALIZED_PLAN_V1",
    parentPlanId: parentPlan.id,
    parentInputHash: parentPlan.inputHash,
    parentPlanHash: parentPlan.planHash,
    parentVisualGroupsHash: parentPlan.visualGroupsHash,
    visualGroupsHash: visualGroups.visualGroupsHash,
    materializationSetHash: materializations.materializationSetHash,
  });
  const id = `auto-listing-materialized-${sha256({
    accountId: scope.accountId, jobId: scope.jobId, itemId: scope.itemId, parentPlanId: parentPlan.id, inputHash,
  }).slice(0, 40)}`;
  const derived = {
    ...structuredClone(parentPlan),
    id,
    inputHash,
    visualGroupsHash: visualGroups.visualGroupsHash,
    visualGroups,
    parentPlanId: parentPlan.id,
    derivationKind: "SOURCE_MATERIALIZATION",
    materializationSetHash: materializations.materializationSetHash,
  };
  return deepFreeze(derived);
}

export async function finalizeMaterializedPlan(input = {}) {
  if (!exactObject(input, FINALIZE_KEYS)
    || typeof input.repository?.listAcceptedSourceMaterializations !== "function"
    || typeof input.repository?.createDerivedMaterializedPlan !== "function") throw materializedPlanError();
  const scope = validateScope(input.scope);
  validateParentPlan(input.parentPlan, scope);
  let accepted;
  try {
    accepted = await input.repository.listAcceptedSourceMaterializations({
      accountId: scope.accountId,
      jobId: scope.jobId,
      itemId: scope.itemId,
      parentPlanId: scope.parentPlanId,
      expectedStatusVersion: scope.expectedStatusVersion,
    });
  } catch {
    throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_FAILED", true);
  }
  const derived = buildMaterializedPlan({ scope, parentPlan: input.parentPlan, acceptedMaterializations: accepted });
  let stored;
  try {
    stored = await input.repository.createDerivedMaterializedPlan({
      scope: structuredClone(scope),
      derivedPlan: structuredClone(derived),
    });
  } catch {
    throw materializedPlanError("AUTO_LISTING_MATERIALIZED_PLAN_REPOSITORY_FAILED", true);
  }
  return verifyDerivedPlan(stored, derived);
}
