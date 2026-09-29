import crypto from "node:crypto";
import { types as utilTypes } from "node:util";
import { verifyAutoListingSourceSnapshot } from "./auto-listing-source-snapshot.mjs";

export const SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS = Object.freeze({
  V1: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V1",
  V2: "AUTO_LISTING_SOURCE_IMAGE_INTELLIGENCE_V2",
});
export const SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION = SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V1;
export const SOURCE_IMAGE_CONFIDENCE = Object.freeze(["CONFIRMED", "TENTATIVE", "UNCERTAIN"]);
export const SOURCE_IMAGE_TERMINAL_STATUS = Object.freeze(["ANALYZED", "DUPLICATE_REUSED", "DOWNLOAD_FAILED", "UNSUPPORTED_MEDIA", "CONFIRMATION_REQUIRED"]);
export const SOURCE_IMAGE_EVIDENCE_MODES = Object.freeze([
  "DIRECT", "ADJACENT", "COMPOSITION_ONLY", "SUBSTITUTED", "SYNTHESIZED_SAFE",
]);
export const SOURCE_IMAGE_TEXT_SEMANTIC_KINDS = Object.freeze([
  "SELLING_POINT", "USAGE", "USAGE_STEP", "SPECIFICATION", "PACKAGE_CONTENT", "CAUTION",
  "PRODUCT_IDENTITY", "EXTERNAL_OVERLAY", "PROMOTION", "CONTACT", "OTHER",
]);

const HASH = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const MAX_JSON_BYTES = 512 * 1024;
const ASSESSMENT_KEYS_V1 = Object.freeze([
  "contractVersion", "sourceAssetId", "sourceOrdinal", "objectKey", "contentHash", "parentSourceAssetId",
  "terminalStatus", "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions", "markings",
  "perceptualDuplicateGroup", "duplicateOfSourceAssetId", "eligibleUses", "reasonCodes", "assessmentHash",
]);
const ASSESSMENT_KEYS_V2 = Object.freeze([
  "contractVersion", "sourceAssetId", "sourceOrdinal", "objectKey", "contentHash", "parentSourceAssetId",
  "terminalStatus", "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions", "semanticTextRegions",
  "markings", "perceptualDuplicateGroup", "duplicateOfSourceAssetId", "eligibleUses", "reasonCodes", "assessmentHash",
]);
const SUMMARY_KEYS_V1 = Object.freeze([
  "contractVersion", "coverageMap", "factCandidates", "markingDecisions", "eligibleAssetIds", "excludedAssetIds",
  "requiredConfirmations", "symmetryClass", "reasonCodes", "summaryHash",
]);
const SUMMARY_KEYS_V2 = Object.freeze([
  "contractVersion", "coverageMap", "factCandidates", "markingDecisions", "eligibleAssetIds", "excludedAssetIds",
  "requiredConfirmations", "symmetryClass", "reasonCodes", "appearanceAssetBindings", "summaryHash",
]);
const BATCH_KEYS = Object.freeze(["sourceAssetId", "sourceOrdinal", "sizeBytes", "contentHash", "objectKey", "contentType"]);
const VIEWPOINTS = Object.freeze([
  "FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4", "BACK_LEFT_3_4",
  "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE", "UNKNOWN",
]);
const COVERAGE_FAMILIES = Object.freeze([
  "FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE", "ROTATIONAL",
]);
const COMPLETE_VIEW_FAMILIES = Object.freeze(["FRONT", "BACK", "LEFT", "RIGHT", "TOP", "BOTTOM", "INTERIOR"]);
const COMPLETE_PRODUCT_FAMILIES = new Set([...COMPLETE_VIEW_FAMILIES, "ROTATIONAL"]);
const COVERAGE_ENTRY_KEYS = Object.freeze(["assetIds", "preciseViewpoints", "tentativeAssetIds"]);
const COMPLETE_PRODUCT_KEYS = Object.freeze(["confirmedFamilyCount", "confirmedFamilies", "requiredFamilyCount", "prohibitedViews"]);
const FACT_KEYS = Object.freeze(["sourceFactId", "kind", "value", "status", "sources", "confirmationMethod", "reasonCodes"]);
const FACT_SOURCE_KEYS_V1 = Object.freeze(["sourceAssetId", "region"]);
const FACT_SOURCE_KEYS_V2 = Object.freeze(["sourceAssetId", "region", "sourceText", "semanticKind", "sequence"]);
const MARKING_DECISION_KEYS = Object.freeze(["sourceAssetId", "kind", "regions", "decisionMethod", "reasonCodes"]);
const CONFIRMATION_KEYS = Object.freeze(["sourceAssetId", "kind", "regions", "reasonCodes"]);
const REGION_KEYS = Object.freeze(["x", "y", "width", "height"]);
const SEMANTIC_TEXT_REGION_KEYS = Object.freeze([
  "sourceText", "language", "region", "confidence", "semanticKind", "normalizedMeaning", "sequence", "reasonCodes",
]);
const APPEARANCE_ASSET_BINDING_KEYS = Object.freeze([
  "sourceAssetId", "mode", "effectiveContentHash", "derivativeAttemptId", "cleanupEvidenceHash",
]);
const REASON_CODE = /^[A-Z0-9][A-Z0-9_:-]{0,119}$/u;
const FACT_KIND = /^[A-Z][A-Z0-9_]{0,119}$/u;
const SOURCE_FACT_ID = /^source-fact-[a-f0-9]{24}$/u;

function contractError(code = "AUTO_LISTING_SOURCE_IMAGE_CONTRACT_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function inputError(code = "AUTO_LISTING_SOURCE_IMAGE_INPUT_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(String(left), (character) => character.codePointAt(0));
  const rightPoints = Array.from(String(right), (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function scalarUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point >= 0xD800 && point <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (point >= 0xDC00 && point <= 0xDFFF) return false;
  }
  return true;
}

function exactDataObject(value, keys, failure) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure();
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (caught) {
    if (caught?.code) throw caught;
    throw failure();
  }
}

function optionalDataObject(value, required, optional, failure) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure();
    const own = Reflect.ownKeys(value);
    if (own.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
      || required.some((key) => !own.includes(key))) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (own.some((key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (caught) {
    if (caught?.code) throw caught;
    throw failure();
  }
}

function safeJson(value, failure, active = new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!scalarUnicode(value)) throw failure();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure();
    return value;
  }
  try {
    if (!value || typeof value !== "object" || utilTypes.isProxy(value) || active.has(value)) throw failure();
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw failure();
      active.add(value);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(value).some((key) => key !== "length" && (!/^0$|^[1-9][0-9]*$/u.test(String(key))
          || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")))) throw failure();
        const output = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure();
          output.push(safeJson(descriptor.value, failure, active));
        }
        return output;
      } finally { active.delete(value); }
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure();
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || !scalarUnicode(key) || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw failure();
      const output = Object.create(null);
      for (const key of keys.sort(compareCodePoints)) output[key] = safeJson(descriptors[key].value, failure, active);
      return output;
    } finally { active.delete(value); }
  } catch (caught) {
    if (caught?.code) throw caught;
    throw failure();
  }
}

function canonicalJson(value) {
  const canonical = (entry) => Array.isArray(entry) ? entry.map(canonical)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.keys(entry).sort(compareCodePoints).map((key) => [key, canonical(entry[key])]))
      : entry;
  return JSON.stringify(canonical(value));
}

const hash = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validText(value, { nullable = false, maxBytes = 2048 } = {}) {
  return (nullable && value === null) || (typeof value === "string" && value === value.trim() && value.length > 0
    && scalarUnicode(value) && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value));
}

function safeIdentifier(value, options = {}) {
  return validText(value, options) && (value === null || (OPAQUE_ID.test(value)
    && !/^(?:https?|ftp|file|data):|^www\./iu.test(value)));
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key));
}

function uniqueArray(value, predicate, { minimum = 0 } = {}) {
  return Array.isArray(value) && value.length >= minimum && value.every(predicate)
    && new Set(value.map((entry) => typeof entry === "string" ? entry : canonicalJson(entry))).size === value.length;
}

function validRegion(region) {
  return region === null || (exactKeys(region, REGION_KEYS)
    && [region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    && region.width > 0 && region.height > 0 && region.x + region.width <= 1 && region.y + region.height <= 1);
}

const validReasonCodes = (value) => uniqueArray(value, (entry) => typeof entry === "string" && REASON_CODE.test(entry));

function viewpointFamilies(viewpoint) {
  if (viewpoint === "FRONT_LEFT_3_4") return ["FRONT", "LEFT"];
  if (viewpoint === "FRONT_RIGHT_3_4") return ["FRONT", "RIGHT"];
  if (viewpoint === "BACK_LEFT_3_4") return ["BACK", "LEFT"];
  if (viewpoint === "BACK_RIGHT_3_4") return ["BACK", "RIGHT"];
  return COVERAGE_FAMILIES.includes(viewpoint) && viewpoint !== "ROTATIONAL" ? [viewpoint] : [];
}

function verifyReconciledSummary(summary, contractVersion) {
  if (!summary.coverageMap || typeof summary.coverageMap !== "object" || Array.isArray(summary.coverageMap)
    || !exactKeys(summary.coverageMap.COMPLETE_PRODUCT, COMPLETE_PRODUCT_KEYS)) throw contractError();
  const coverageKeys = Object.keys(summary.coverageMap);
  if (coverageKeys.some((key) => key !== "COMPLETE_PRODUCT" && !COVERAGE_FAMILIES.includes(key))) throw contractError();
  const eligible = summary.eligibleAssetIds;
  const excluded = summary.excludedAssetIds;
  if (!uniqueArray(eligible, (entry) => safeIdentifier(entry)) || !uniqueArray(excluded, (entry) => safeIdentifier(entry))
    || eligible.some((assetId) => excluded.includes(assetId))) throw contractError();
  for (const family of coverageKeys.filter((key) => key !== "COMPLETE_PRODUCT")) {
    const entry = summary.coverageMap[family];
    if (!exactKeys(entry, COVERAGE_ENTRY_KEYS)
      || !uniqueArray(entry.assetIds, (assetId) => safeIdentifier(assetId), { minimum: 1 })
      || entry.assetIds.some((assetId) => !eligible.includes(assetId))
      || !uniqueArray(entry.preciseViewpoints, (viewpoint) => VIEWPOINTS.includes(viewpoint), { minimum: 1 })
      || !uniqueArray(entry.tentativeAssetIds, (assetId) => safeIdentifier(assetId))
      || entry.preciseViewpoints.some((viewpoint) => family === "ROTATIONAL"
        ? !viewpointFamilies(viewpoint).every((mapped) => ["FRONT", "BACK", "LEFT", "RIGHT"].includes(mapped))
          || viewpointFamilies(viewpoint).length === 0
        : !viewpointFamilies(viewpoint).includes(family))) throw contractError();
  }
  for (const family of coverageKeys.filter((key) => key !== "COMPLETE_PRODUCT")) {
    const entry = summary.coverageMap[family];
    for (const viewpoint of entry.preciseViewpoints) {
      const requiredFamilies = viewpointFamilies(viewpoint).map((mapped) => summary.symmetryClass === "ROTATIONAL"
        && ["FRONT", "BACK", "LEFT", "RIGHT"].includes(mapped) ? "ROTATIONAL" : mapped);
      for (const requiredFamily of new Set(requiredFamilies)) {
        const requiredEntry = summary.coverageMap[requiredFamily];
        if (!requiredEntry || !requiredEntry.preciseViewpoints.includes(viewpoint)
          || !entry.assetIds.some((assetId) => requiredEntry.assetIds.includes(assetId))) throw contractError();
      }
    }
  }
  const complete = summary.coverageMap.COMPLETE_PRODUCT;
  if (!Number.isSafeInteger(complete.confirmedFamilyCount) || complete.confirmedFamilyCount < 0
    || !uniqueArray(complete.confirmedFamilies, (family) => COMPLETE_PRODUCT_FAMILIES.has(family))
    || complete.confirmedFamilyCount !== complete.confirmedFamilies.length
    || !Number.isSafeInteger(complete.requiredFamilyCount) || complete.requiredFamilyCount < 0
    || complete.requiredFamilyCount > 3 || complete.requiredFamilyCount > complete.confirmedFamilyCount
    || !uniqueArray(complete.prohibitedViews, (viewpoint) => VIEWPOINTS.includes(viewpoint))) throw contractError();
  const coveredCompleteFamilies = coverageKeys.filter((family) => COMPLETE_PRODUCT_FAMILIES.has(family));
  const expectedProhibitedViews = summary.symmetryClass === "ROTATIONAL"
    ? COMPLETE_VIEW_FAMILIES.filter((viewpoint) => ["FRONT", "BACK", "LEFT", "RIGHT"].includes(viewpoint)
      ? viewpoint !== "FRONT" || !coverageKeys.includes("ROTATIONAL")
      : !coverageKeys.includes(viewpoint))
    : COMPLETE_VIEW_FAMILIES.filter((family) => !coverageKeys.includes(family));
  if (canonicalJson(coveredCompleteFamilies.slice().sort(compareCodePoints))
      !== canonicalJson(complete.confirmedFamilies.slice().sort(compareCodePoints))
    || complete.requiredFamilyCount !== Math.min(complete.confirmedFamilyCount, 3)
    || canonicalJson(complete.prohibitedViews) !== canonicalJson(expectedProhibitedViews)) throw contractError();

  if (!Array.isArray(summary.factCandidates) || !Array.isArray(summary.markingDecisions)
    || !Array.isArray(summary.requiredConfirmations)) throw contractError();
  for (const fact of summary.factCandidates) {
    if (!exactKeys(fact, FACT_KEYS) || !SOURCE_FACT_ID.test(fact.sourceFactId || "")
      || !FACT_KIND.test(fact.kind || "") || !validText(fact.value)
      || !["CONFIRMED", "REJECTED"].includes(fact.status)
      || !["STRUCTURED_FACT_MATCH", "INDEPENDENT_IMAGE_REPEAT", "PRODUCT_OR_PACKAGE_MARKING",
        "REJECTED_FORBIDDEN_TEXT", "INSUFFICIENT_INDEPENDENT_EVIDENCE", "UNCONFIRMED_OCR",
        "CONFLICTING_EVIDENCE", "SOURCE_TEXT_EXPLICIT_LOW_RISK"].includes(fact.confirmationMethod)
      || !uniqueArray(fact.sources, (source) => {
        const sourceKeys = contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
          ? FACT_SOURCE_KEYS_V2 : FACT_SOURCE_KEYS_V1;
        return exactKeys(source, sourceKeys) && safeIdentifier(source.sourceAssetId) && validRegion(source.region)
          && (contractVersion !== SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
            || (validText(source.sourceText, { maxBytes: 4096 })
              && SOURCE_IMAGE_TEXT_SEMANTIC_KINDS.includes(source.semanticKind)
              && (source.semanticKind === "USAGE_STEP"
                ? Number.isSafeInteger(source.sequence) && source.sequence >= 1 && source.sequence <= 100
                : source.sequence === null)));
      }, { minimum: 1 })
      || !validReasonCodes(fact.reasonCodes)) throw contractError();
  }
  if (new Set(summary.factCandidates.map(({ sourceFactId }) => sourceFactId)).size !== summary.factCandidates.length) throw contractError();
  for (const decision of summary.markingDecisions) {
    if (!exactKeys(decision, MARKING_DECISION_KEYS) || !safeIdentifier(decision.sourceAssetId)
      || !["PRODUCT_MARKING", "EXTERNAL_OVERLAY", "UNCERTAIN_MARKING"].includes(decision.kind)
      || !uniqueArray(decision.regions, validRegion)
      || !["MANUAL_DECISION", "OBSERVED_PRODUCT_MARKING", "REPEATED_PHYSICAL_LOCATION",
        "BACKGROUND_CANVAS_OVERLAY", "UNCERTAIN"].includes(decision.decisionMethod)
      || !validReasonCodes(decision.reasonCodes)) throw contractError();
  }
  for (const confirmation of summary.requiredConfirmations) {
    if (!exactKeys(confirmation, CONFIRMATION_KEYS) || !safeIdentifier(confirmation.sourceAssetId)
      || !(confirmation.kind === "UNCERTAIN_MARKING"
        || (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
          && confirmation.kind === "EXTERNAL_OVERLAY"))
      || !uniqueArray(confirmation.regions, validRegion)
      || !validReasonCodes(confirmation.reasonCodes) || !excluded.includes(confirmation.sourceAssetId)) throw contractError();
  }
  if (new Set(summary.requiredConfirmations.map(({ sourceAssetId }) => sourceAssetId)).size !== summary.requiredConfirmations.length
    || !["ASYMMETRIC", "ROTATIONAL", "BILATERAL", "SPHERICAL"].includes(summary.symmetryClass)
    || !validReasonCodes(summary.reasonCodes)) throw contractError();
}

function normalizeMedia(media, failure) {
  if (typeof media === "string") {
    let sourceUrl;
    try { sourceUrl = new URL(media); } catch { throw failure(); }
    if (!['http:', 'https:'].includes(sourceUrl.protocol) || Buffer.byteLength(media, "utf8") > 8192) throw failure();
    const sourceRefHash = crypto.createHash("sha256").update(sourceUrl.toString()).digest("hex");
    return { sourceAssetId: `source-url-${sourceRefHash.slice(0, 24)}`, sourceRefHash, contentHash: null };
  }
  const image = exactDataObject(media, ["assetId", "contentHash"], failure);
  if (!safeIdentifier(image.assetId) || !HASH.test(image.contentHash || "")) throw failure();
  return { sourceAssetId: image.assetId, sourceRefHash: null, contentHash: image.contentHash };
}

export function enumerateSourceImageAssets(raw = {}) {
  const input = exactDataObject(raw, ["sourceCapture"], inputError);
  const capture = safeJson(input.sourceCapture, inputError);
  let snapshot;
  try { snapshot = verifyAutoListingSourceSnapshot(capture).snapshot; } catch { throw inputError(); }
  const byId = new Map();
  for (const variant of snapshot.variants) {
    const variantId = typeof variant.evidence?.variantId === "string" && variant.evidence.variantId.trim()
      ? variant.evidence.variantId.trim() : variant.sku;
    for (const [mediaOrdinal, media] of variant.media.entries()) {
      const image = normalizeMedia(media, inputError);
      const known = byId.get(image.sourceAssetId);
      if (known && (known.sourceRefHash !== image.sourceRefHash || known.contentHash !== image.contentHash)) throw inputError();
      const membership = Object.freeze({ variantId, sku: variant.sku, mediaOrdinal });
      if (known) known.memberships.push(membership);
      else byId.set(image.sourceAssetId, { ...image, sourceOrdinal: byId.size, memberships: [membership] });
    }
  }
  return freeze([...byId.values()].map((entry) => ({
    sourceAssetId: entry.sourceAssetId, sourceOrdinal: entry.sourceOrdinal, sourceRefHash: entry.sourceRefHash,
    contentHash: entry.contentHash, memberships: entry.memberships,
  })));
}

function materializedAsset(value) {
  const asset = exactDataObject(value, BATCH_KEYS, inputError);
  if (!safeIdentifier(asset.sourceAssetId) || !Number.isSafeInteger(asset.sourceOrdinal) || asset.sourceOrdinal < 0
    || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || !HASH.test(asset.contentHash || "")
    || !validText(asset.objectKey) || /(?:https?|ftp|file|data):|[?#]/iu.test(asset.objectKey)
    || !["image/png", "image/jpeg", "image/webp"].includes(asset.contentType)) throw inputError();
  return asset;
}

export function partitionSourceImageAnalysisBatches(raw = {}) {
  const input = optionalDataObject(raw, ["assets"], ["maxImages", "maxAggregateBytes"], inputError);
  const maxImages = input.maxImages === undefined ? 6 : input.maxImages;
  const maxAggregateBytes = input.maxAggregateBytes === undefined ? 32 * 1024 * 1024 : input.maxAggregateBytes;
  if (!Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 6
    || !Number.isSafeInteger(maxAggregateBytes) || maxAggregateBytes < 1 || maxAggregateBytes > 32 * 1024 * 1024
    || !Array.isArray(input.assets) || utilTypes.isProxy(input.assets)) throw inputError();
  const assets = input.assets.map(materializedAsset).sort((left, right) => left.sourceOrdinal - right.sourceOrdinal
    || compareCodePoints(left.sourceAssetId, right.sourceAssetId));
  if (new Set(assets.map((asset) => asset.sourceAssetId)).size !== assets.length
    || new Set(assets.map((asset) => asset.sourceOrdinal)).size !== assets.length) throw inputError();
  const batches = [];
  let current = [];
  let aggregateBytes = 0;
  for (const asset of assets) {
    if (asset.sizeBytes > maxAggregateBytes) throw inputError("AUTO_LISTING_SOURCE_IMAGE_INPUT_TOO_LARGE");
    if (current.length === maxImages || aggregateBytes + asset.sizeBytes > maxAggregateBytes) {
      batches.push(freeze({ analysisBatchId: hash({ assets: current, maxImages, maxAggregateBytes }), assets: current, aggregateBytes }));
      current = [];
      aggregateBytes = 0;
    }
    current.push(Object.freeze({ ...asset }));
    aggregateBytes += asset.sizeBytes;
  }
  if (current.length) batches.push(freeze({ analysisBatchId: hash({ assets: current, maxImages, maxAggregateBytes }), assets: current, aggregateBytes }));
  return freeze(batches);
}

function verifyHashedContract(value, keys, hashKey) {
  const input = exactDataObject(value, keys, contractError);
  const safe = safeJson(input, contractError);
  if (Buffer.byteLength(canonicalJson(safe), "utf8") > MAX_JSON_BYTES) throw contractError();
  const expectedHash = safe[hashKey];
  delete safe[hashKey];
  if (!HASH.test(expectedHash || "") || hash(safe) !== expectedHash) throw contractError();
  return safe;
}

function declaredContractVersion(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw contractError();
    const descriptor = Object.getOwnPropertyDescriptor(value, "contractVersion");
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw contractError();
    return descriptor.value;
  } catch (caught) {
    if (caught?.code) throw caught;
    throw contractError();
  }
}

function verifySemanticTextRegions(assessment) {
  if (!uniqueArray(assessment.semanticTextRegions, (region) => exactKeys(region, SEMANTIC_TEXT_REGION_KEYS)
    && validText(region.sourceText, { maxBytes: 4096 })
    && validText(region.language, { maxBytes: 32 })
    && validRegion(region.region)
    && SOURCE_IMAGE_CONFIDENCE.includes(region.confidence)
    && SOURCE_IMAGE_TEXT_SEMANTIC_KINDS.includes(region.semanticKind)
    && validText(region.normalizedMeaning, { maxBytes: 4096 })
    && (region.semanticKind === "USAGE_STEP"
      ? Number.isSafeInteger(region.sequence) && region.sequence >= 1 && region.sequence <= 100
      : region.sequence === null)
    && validReasonCodes(region.reasonCodes))
    || !Array.isArray(assessment.ocrRegions)
    || assessment.semanticTextRegions.length !== assessment.ocrRegions.length) throw contractError();
}

function verifyAppearanceAssetBindings(summary) {
  if (!uniqueArray(summary.appearanceAssetBindings, (binding) => exactKeys(binding, APPEARANCE_ASSET_BINDING_KEYS)
    && safeIdentifier(binding.sourceAssetId)
    && ["ORIGINAL", "CLEANED"].includes(binding.mode)
    && HASH.test(binding.effectiveContentHash || "")
    && (binding.mode === "ORIGINAL"
      ? binding.derivativeAttemptId === null && binding.cleanupEvidenceHash === null
      : safeIdentifier(binding.derivativeAttemptId) && HASH.test(binding.cleanupEvidenceHash || "")))) throw contractError();
  if (canonicalJson(summary.appearanceAssetBindings.map(({ sourceAssetId }) => sourceAssetId))
    !== canonicalJson(summary.eligibleAssetIds)) throw contractError();
}

export function verifySourceImageAssessment(value) {
  const contractVersion = declaredContractVersion(value);
  const keys = contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V1
    ? ASSESSMENT_KEYS_V1
    : contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 ? ASSESSMENT_KEYS_V2 : null;
  if (!keys) throw contractError();
  const assessment = verifyHashedContract(value, keys, "assessmentHash");
  if (assessment.contractVersion !== contractVersion
    || !safeIdentifier(assessment.sourceAssetId) || !Number.isSafeInteger(assessment.sourceOrdinal) || assessment.sourceOrdinal < 0
    || !validText(assessment.objectKey, { nullable: true }) || !((assessment.contentHash === null) || HASH.test(assessment.contentHash || ""))
    || !safeIdentifier(assessment.parentSourceAssetId, { nullable: true })
    || !SOURCE_IMAGE_TERMINAL_STATUS.includes(assessment.terminalStatus)) throw contractError();
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) verifySemanticTextRegions(assessment);
  return freeze({ ...assessment, assessmentHash: value.assessmentHash });
}

export function verifySourceImageIntelligenceSummary(value) {
  const contractVersion = declaredContractVersion(value);
  const keys = contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V1
    ? SUMMARY_KEYS_V1
    : contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 ? SUMMARY_KEYS_V2 : null;
  if (!keys) throw contractError();
  const summary = verifyHashedContract(value, keys, "summaryHash");
  if (summary.contractVersion !== contractVersion) throw contractError();
  if (Object.hasOwn(summary.coverageMap || {}, "COMPLETE_PRODUCT")) verifyReconciledSummary(summary, contractVersion);
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) verifyAppearanceAssetBindings(summary);
  return freeze({ ...summary, summaryHash: value.summaryHash });
}
