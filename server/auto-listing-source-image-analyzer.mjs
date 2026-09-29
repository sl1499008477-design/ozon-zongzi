import crypto from "node:crypto";
import { types } from "node:util";

import { createSourceImageAnalysisAiAdapter } from "./auto-listing-source-image-ai-adapter.mjs";
import {
  SOURCE_IMAGE_CONFIDENCE,
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION,
  SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS,
  SOURCE_IMAGE_TEXT_SEMANTIC_KINDS,
  partitionSourceImageAnalysisBatches,
  verifySourceImageAssessment,
} from "./auto-listing-source-image-intelligence-contract.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const REASON = /^[A-Z0-9][A-Z0-9_:-]{0,119}$/u;
const CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CONTENT_KINDS = new Set(["PRODUCT_VIEW", "PRODUCT_DETAIL", "USAGE_SCENE", "PACKAGE", "TEXT_ONLY", "MIXED", "OTHER"]);
const VIEWPOINTS = new Set(["FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4", "BACK_LEFT_3_4", "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR", "DETAIL", "SCENE", "PACKAGE", "UNKNOWN"]);
const MARKINGS = new Set(["PRODUCT_MARKING", "EXTERNAL_OVERLAY", "UNCERTAIN_MARKING"]);
const ELIGIBLE_USES = new Set(["IDENTITY_ANCHOR", "TARGET_VIEW", "DETAIL", "SCENE", "PACKAGE", "TEXT_FACT", "UNUSABLE"]);
const APPEARANCE_CONTENT_KINDS = new Set(["PRODUCT_VIEW", "PRODUCT_DETAIL", "USAGE_SCENE", "PACKAGE", "MIXED"]);
const COMPLETE_VIEWPOINTS = new Set([
  "FRONT", "BACK", "LEFT", "RIGHT", "FRONT_LEFT_3_4", "FRONT_RIGHT_3_4",
  "BACK_LEFT_3_4", "BACK_RIGHT_3_4", "TOP", "BOTTOM", "INTERIOR",
]);
const SEMANTIC_KINDS = new Set(SOURCE_IMAGE_TEXT_SEMANTIC_KINDS);
const OBSERVATION_KEYS_V1 = new Set(["sourceAssetId", "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions", "markings", "perceptualDuplicateGroup", "eligibleUses", "reasonCodes"]);
const OBSERVATION_KEYS_V2 = new Set(["sourceAssetId", "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions", "semanticTextRegions", "markings", "perceptualDuplicateGroup", "eligibleUses", "reasonCodes"]);
const RESULT_KEYS = new Set(["observations"]);
const GATEWAY_EXECUTION_KEYS = new Set(["channelId", "connectionId", "connectionVersion", "idleTimeoutMs"]);
const MATERIALIZED_PROJECTION_KEYS = ["sourceAssetId", "sourceOrdinal", "sizeBytes", "contentHash", "objectKey", "contentType"];
const SOURCE_IMAGE_ANALYSIS_BATCH_MAX_IMAGES = 2;
const SOURCE_IMAGE_ANALYSIS_RESULT_MAX_ATTEMPTS = 3;
const PRODUCT_MARKING_CENTER_TOLERANCE = 0.02;
const DIMENSION_REASON = /(?:^|_)(?:DIMENSION|MEASUREMENT|SIZE)(?:_|$)/u;
const NUMERIC_TEXT = /\p{Number}/u;
const FORBIDDEN_FACT_KEY = /(?:url|uri|object.?key|credential|secret|token|authorization|api.?key)/iu;
const URL_VALUE = /(?:https?|ftp|file|data):|www\./iu;

function inputFailure() {
  return Object.assign(new Error("来源图片分析输入无效"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_INPUT_INVALID", retryable: false,
  });
}

function resultFailure() {
  return Object.assign(new Error("来源图片分析结果无效"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID", retryable: true,
  });
}

function repositoryFailure() {
  return Object.assign(new Error("来源图片分析记录暂时无法保存"), {
    code: "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_REPOSITORY_FAILED", retryable: true,
  });
}

function plain(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !types.isProxy(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}

function closed(raw, keys, error = inputFailure) {
  try {
    if (!plain(raw)) throw error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw error();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (caught) {
    if (caught?.code) throw caught;
    throw error();
  }
}

function projected(raw, keys, error = inputFailure) {
  try {
    if (!plain(raw)) throw error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (keys.some((key) => descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw error();
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  } catch (caught) {
    if (caught?.code) throw caught;
    throw error();
  }
}

function identifier(value) {
  return typeof value === "string" && value === value.trim() && SAFE_ID.test(value);
}

function compareCodePoints(left, right) {
  const a = Array.from(String(left), (character) => character.codePointAt(0));
  const b = Array.from(String(right), (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function contentDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function scopeFor(rawScope, rawRun) {
  if (!plain(rawScope) || !plain(rawRun)) throw inputFailure();
  const scope = projected(rawScope, ["accountId", "jobId", "itemId", "expectedStatusVersion"]);
  const run = projected(rawRun, ["id", "accountId", "jobId", "itemId", "expectedStatusVersion", "contractVersion", "inputHash", "profileId", "profileVersion", "modelName"]);
  if (![scope.accountId, scope.jobId, scope.itemId, run.id, run.profileId, run.modelName].every(identifier)
    || !Number.isSafeInteger(scope.expectedStatusVersion) || scope.expectedStatusVersion < 1
    || run.accountId !== scope.accountId || run.jobId !== scope.jobId || run.itemId !== scope.itemId
    || run.expectedStatusVersion !== scope.expectedStatusVersion
    || !Object.values(SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS).includes(run.contractVersion)
    || !HASH.test(run.inputHash || "")
    || !Number.isSafeInteger(run.profileVersion) || run.profileVersion < 1) throw inputFailure();
  return { scope: Object.freeze(scope), run: Object.freeze(run) };
}

function materializedAssets(rawAssets) {
  if (!Array.isArray(rawAssets) || types.isProxy(rawAssets)) throw inputFailure();
  return rawAssets.map((asset) => projected(asset, MATERIALIZED_PROJECTION_KEYS));
}

export function buildSourceImageAnalysisBatches({ materializedAssets: rawAssets, terminalAssessments } = {}) {
  if (!Array.isArray(terminalAssessments) || types.isProxy(terminalAssessments)) throw inputFailure();
  const assets = materializedAssets(rawAssets);
  const terminalIds = terminalAssessments.map((row) => {
    if (!plain(row)) throw inputFailure();
    const value = projected(row, ["sourceAssetId", "terminalStatus"]);
    if (!identifier(value.sourceAssetId) || !["DOWNLOAD_FAILED", "UNSUPPORTED_MEDIA"].includes(value.terminalStatus)) throw inputFailure();
    return value.sourceAssetId;
  });
  const allIds = [...assets.map(({ sourceAssetId }) => sourceAssetId), ...terminalIds];
  if (new Set(allIds).size !== allIds.length) throw inputFailure();
  try { return partitionSourceImageAnalysisBatches({
    assets,
    maxImages: SOURCE_IMAGE_ANALYSIS_BATCH_MAX_IMAGES,
  }); }
  catch { throw inputFailure(); }
}

function batchFor(rawBatch) {
  const batch = closed(rawBatch, new Set(["analysisBatchId", "assets", "aggregateBytes"]));
  const assets = materializedAssets(batch.assets);
  let expected;
  try {
    expected = partitionSourceImageAnalysisBatches({
      assets,
      maxImages: SOURCE_IMAGE_ANALYSIS_BATCH_MAX_IMAGES,
    });
  } catch { throw inputFailure(); }
  if (expected.length !== 1 || expected[0].analysisBatchId !== batch.analysisBatchId
    || expected[0].aggregateBytes !== batch.aggregateBytes || !same(expected[0].assets, assets)) throw inputFailure();
  return expected[0];
}

function executionFor(value, profile) {
  if (value === null) {
    if (profile.connectionId !== null || profile.connectionVersion !== null) throw inputFailure();
    return null;
  }
  const execution = closed(value, GATEWAY_EXECUTION_KEYS);
  if (!identifier(execution.channelId) || !identifier(execution.connectionId)
    || !Number.isSafeInteger(execution.connectionVersion) || execution.connectionVersion < 1
    || execution.idleTimeoutMs !== 300_000
    || profile.connectionId !== execution.connectionId || profile.connectionVersion !== execution.connectionVersion) throw inputFailure();
  return Object.freeze(execution);
}

function profileFor(raw, scope, run) {
  if (!plain(raw)) throw inputFailure();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw inputFailure();
  const value = Object.fromEntries(Object.keys(descriptors).map((key) => [key, descriptors[key].value]));
  const legacyConnection = value.connectionId === null && value.connectionVersion === null;
  const channelConnection = identifier(value.connectionId) && Number.isSafeInteger(value.connectionVersion)
    && value.connectionVersion >= 1;
  if (value.accountId !== scope.accountId || value.id !== run.profileId
    || value.configVersion !== run.profileVersion || value.textModel !== run.modelName
    || (!legacyConnection && !channelConnection)) throw inputFailure();
  return Object.freeze(value);
}

function boundedArray(value, maximum, mapper, error = resultFailure) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum) throw error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw error();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw error();
    return mapper(descriptor.value);
  });
}

function reasonCodes(value) {
  const output = boundedArray(value, 20, (reason) => {
    if (typeof reason !== "string" || !REASON.test(reason)) throw resultFailure();
    return reason;
  });
  if (new Set(output).size !== output.length) throw resultFailure();
  return output;
}

function bounds(value) {
  if (value === null) return null;
  const region = closed(value, new Set(["x", "y", "width", "height"]), resultFailure);
  const values = [region.x, region.y, region.width, region.height];
  const normalizedDomain = values.every((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 1);
  if (normalizedDomain && region.width > 0 && region.height > 0) {
    const normalizedSpan = (start, spanOrEndpoint) => {
      if (start + spanOrEndpoint <= 1) return spanOrEndpoint;
      const span = spanOrEndpoint > start ? spanOrEndpoint - start : 1 - start;
      return Math.round(span * 1_000_000_000_000) / 1_000_000_000_000;
    };
    const width = normalizedSpan(region.x, region.width);
    const height = normalizedSpan(region.y, region.height);
    if (width <= 0 || height <= 0) throw resultFailure();
    return {
      x: region.x,
      y: region.y,
      width,
      height,
    };
  }
  const integerGridDomain = values.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000)
    && values.some((entry) => entry > 1);
  if (integerGridDomain
    && region.width > 0 && region.height > 0
    && region.x + region.width <= 1_000 && region.y + region.height <= 1_000) {
    return {
      x: region.x / 1_000,
      y: region.y / 1_000,
      width: region.width / 1_000,
      height: region.height / 1_000,
    };
  }
  if (integerGridDomain && region.width > region.x && region.height > region.y
    && (region.x + region.width > 1_000 || region.y + region.height > 1_000)) {
    return {
      x: region.x / 1_000,
      y: region.y / 1_000,
      width: (region.width - region.x) / 1_000,
      height: (region.height - region.y) / 1_000,
    };
  }
  throw resultFailure();
}

function confidence(value) {
  if (!SOURCE_IMAGE_CONFIDENCE.includes(value)) throw resultFailure();
  return value;
}

function repairedEligibleUses({ eligibleUses, contentKinds, viewpoints, subjectBounds, quality }) {
  if (quality?.usable !== true || subjectBounds === null
    || !contentKinds.some((kind) => APPEARANCE_CONTENT_KINDS.has(kind))) return eligibleUses;
  const confirmedKinds = new Set(viewpoints
    .filter(({ confidence: value }) => value === "CONFIRMED")
    .map(({ kind }) => kind));
  let derivedUse = null;
  if ([...confirmedKinds].some((kind) => COMPLETE_VIEWPOINTS.has(kind))) derivedUse = "TARGET_VIEW";
  else if (confirmedKinds.has("SCENE")) derivedUse = "SCENE";
  else if (confirmedKinds.has("PACKAGE")) derivedUse = "PACKAGE";
  else if (confirmedKinds.has("DETAIL")) derivedUse = "DETAIL";
  if (derivedUse === null) return eligibleUses;
  const repaired = eligibleUses.filter((use) => use !== "UNUSABLE");
  if (!repaired.includes(derivedUse)) repaired.push(derivedUse);
  return repaired;
}

function observation(raw, expectedIds, contractVersion) {
  const value = closed(raw, contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
    ? OBSERVATION_KEYS_V2 : OBSERVATION_KEYS_V1, resultFailure);
  if (!expectedIds.has(value.sourceAssetId)) throw resultFailure();
  const contentKinds = boundedArray(value.contentKinds, 7, (kind) => {
    if (!CONTENT_KINDS.has(kind)) throw resultFailure(); return kind;
  });
  const viewpoints = boundedArray(value.viewpoints, 12, (rawViewpoint) => {
    const viewpoint = closed(rawViewpoint, new Set(["kind", "confidence", "reasonCodes"]), resultFailure);
    if (!VIEWPOINTS.has(viewpoint.kind)) throw resultFailure();
    return { kind: viewpoint.kind, confidence: confidence(viewpoint.confidence), reasonCodes: reasonCodes(viewpoint.reasonCodes) };
  });
  let quality = null;
  if (value.quality !== null) {
    const rawQuality = closed(value.quality, new Set(["confidence", "usable", "reasonCodes"]), resultFailure);
    if (typeof rawQuality.usable !== "boolean") throw resultFailure();
    quality = { confidence: confidence(rawQuality.confidence), usable: rawQuality.usable,
      reasonCodes: reasonCodes(rawQuality.reasonCodes) };
  }
  const ocrRegions = boundedArray(value.ocrRegions, 20, (rawRegion) => {
    const region = closed(rawRegion, new Set(["text", "region", "language", "confidence"]), resultFailure);
    if (typeof region.text !== "string" || !region.text.trim() || region.text !== region.text.trim()
      || region.text.length > 500 || /[\u0000-\u001f\u007f]/u.test(region.text)
      || !(region.language === null || (typeof region.language === "string" && region.language.length <= 32))) throw resultFailure();
    return { text: region.text, region: bounds(region.region), language: region.language,
      confidence: confidence(region.confidence) };
  });
  let semanticTextRegions;
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) {
    semanticTextRegions = boundedArray(value.semanticTextRegions, 20, (rawRegion) => {
      const region = closed(rawRegion, new Set([
        "sourceText", "language", "region", "confidence", "semanticKind", "normalizedMeaning", "sequence", "reasonCodes",
      ]), resultFailure);
      if (typeof region.sourceText !== "string" || !region.sourceText.trim() || region.sourceText !== region.sourceText.trim()
        || region.sourceText.length > 500 || /[\u0000-\u001f\u007f]/u.test(region.sourceText)
        || typeof region.language !== "string" || !region.language.trim() || region.language !== region.language.trim()
        || region.language.length > 32 || /[\u0000-\u001f\u007f]/u.test(region.language)
        || !SEMANTIC_KINDS.has(region.semanticKind)
        || typeof region.normalizedMeaning !== "string" || !region.normalizedMeaning.trim()
        || region.normalizedMeaning !== region.normalizedMeaning.trim() || region.normalizedMeaning.length > 500
        || /[\u0000-\u001f\u007f]/u.test(region.normalizedMeaning)
        || (region.semanticKind === "USAGE_STEP"
          ? !Number.isSafeInteger(region.sequence) || region.sequence < 1 || region.sequence > 100
          : region.sequence !== null)) throw resultFailure();
      return {
        sourceText: region.sourceText,
        language: region.language,
        region: bounds(region.region),
        confidence: confidence(region.confidence),
        semanticKind: region.semanticKind,
        normalizedMeaning: region.normalizedMeaning,
        sequence: region.sequence,
        reasonCodes: reasonCodes(region.reasonCodes),
      };
    });
    if (semanticTextRegions.length !== ocrRegions.length
      || semanticTextRegions.some((semantic, index) => semantic.sourceText !== ocrRegions[index].text
        || semantic.confidence !== ocrRegions[index].confidence
        || (ocrRegions[index].language !== null && semantic.language !== ocrRegions[index].language)
        || !same(semantic.region, ocrRegions[index].region))) throw resultFailure();
    const stepSequences = semanticTextRegions.filter(({ semanticKind }) => semanticKind === "USAGE_STEP")
      .map(({ sequence }) => sequence);
    if (stepSequences.some((sequence, index) => sequence !== index + 1)) throw resultFailure();
  }
  let markings = boundedArray(value.markings, 20, (rawMarking) => {
    const marking = closed(rawMarking, new Set(["kind", "region", "confidence", "reasonCodes"]), resultFailure);
    if (!MARKINGS.has(marking.kind)) throw resultFailure();
    return { kind: marking.kind, region: bounds(marking.region), confidence: confidence(marking.confidence),
      reasonCodes: reasonCodes(marking.reasonCodes) };
  });
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2) {
    if (markings.length < ocrRegions.length) throw resultFailure();
    markings = markings.map((marking, index) => index < ocrRegions.length
      ? { ...marking, region: ocrRegions[index].region }
      : marking);
    if (markings.some((marking, index) => {
      const semantic = semanticTextRegions[index];
      return semantic !== undefined && marking.kind === "EXTERNAL_OVERLAY"
        && marking.confidence === "CONFIRMED" && semantic.confidence === "CONFIRMED"
        && semantic.semanticKind === "PRODUCT_IDENTITY"
        && marking.reasonCodes.some((reasonCode) => DIMENSION_REASON.test(reasonCode))
        && !NUMERIC_TEXT.test(`${semantic.sourceText} ${semantic.normalizedMeaning}`);
    })) throw resultFailure();
  }
  const rawEligibleUses = boundedArray(value.eligibleUses, 8, (use) => {
    if (!ELIGIBLE_USES.has(use)) throw resultFailure(); return use;
  });
  const subjectBounds = bounds(value.subjectBounds);
  const observationReasonCodes = reasonCodes(value.reasonCodes);
  const isMultiViewCollage = (observationReasonCodes.includes("COLLAGE_LAYOUT")
      || quality?.reasonCodes.includes("COLLAGE_LAYOUT"))
    && (observationReasonCodes.includes("MULTIPLE_VIEWS")
      || viewpoints.filter(({ confidence: certainty, kind }) => certainty === "CONFIRMED"
        && !["SCENE", "TEXT_ONLY"].includes(kind)).length > 1);
  if (contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 && subjectBounds !== null
    && !isMultiViewCollage
    && markings.some((marking, index) => {
      if (index >= ocrRegions.length || marking.kind !== "PRODUCT_MARKING"
        || marking.confidence !== "CONFIRMED" || marking.region === null) return false;
      const centerX = marking.region.x + marking.region.width / 2;
      const centerY = marking.region.y + marking.region.height / 2;
      return centerX < subjectBounds.x - PRODUCT_MARKING_CENTER_TOLERANCE
        || centerX > subjectBounds.x + subjectBounds.width + PRODUCT_MARKING_CENTER_TOLERANCE
        || centerY < subjectBounds.y - PRODUCT_MARKING_CENTER_TOLERANCE
        || centerY > subjectBounds.y + subjectBounds.height + PRODUCT_MARKING_CENTER_TOLERANCE;
    })) throw resultFailure();
  const eligibleUses = repairedEligibleUses({
    eligibleUses: rawEligibleUses, contentKinds, viewpoints, subjectBounds, quality,
  });
  if (new Set(contentKinds).size !== contentKinds.length || new Set(rawEligibleUses).size !== rawEligibleUses.length
    || !(value.perceptualDuplicateGroup === null || identifier(value.perceptualDuplicateGroup))) throw resultFailure();
  return {
    sourceAssetId: value.sourceAssetId, contentKinds, viewpoints, subjectBounds, quality,
    ocrRegions,
    ...(contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 ? { semanticTextRegions } : {}),
    markings, perceptualDuplicateGroup: value.perceptualDuplicateGroup,
    eligibleUses, reasonCodes: observationReasonCodes,
  };
}

function observationsFor(raw, representatives, contractVersion) {
  const result = closed(raw, RESULT_KEYS, resultFailure);
  const expectedIds = new Set(representatives.map(({ sourceAssetId }) => sourceAssetId));
  const observations = boundedArray(result.observations, 6, (entry) => observation(entry, expectedIds, contractVersion));
  if (observations.length !== representatives.length
    || new Set(observations.map(({ sourceAssetId }) => sourceAssetId)).size !== observations.length
    || observations.some(({ sourceAssetId }) => !expectedIds.has(sourceAssetId))) throw resultFailure();
  return observations;
}

function assessmentFor(asset, value, duplicateOfSourceAssetId = null, contractVersion = SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSION) {
  const assessment = {
    contractVersion,
    sourceAssetId: asset.sourceAssetId,
    sourceOrdinal: asset.sourceOrdinal,
    objectKey: asset.objectKey,
    contentHash: asset.contentHash,
    parentSourceAssetId: null,
    terminalStatus: duplicateOfSourceAssetId === null ? "ANALYZED" : "DUPLICATE_REUSED",
    contentKinds: value.contentKinds,
    viewpoints: value.viewpoints,
    subjectBounds: value.subjectBounds,
    quality: value.quality,
    ocrRegions: value.ocrRegions,
    ...(contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2
      ? { semanticTextRegions: value.semanticTextRegions } : {}),
    markings: value.markings,
    perceptualDuplicateGroup: value.perceptualDuplicateGroup,
    duplicateOfSourceAssetId,
    eligibleUses: value.eligibleUses,
    reasonCodes: duplicateOfSourceAssetId === null ? value.reasonCodes : [...value.reasonCodes, "EXACT_CONTENT_DUPLICATE_REUSED"],
  };
  try { return verifySourceImageAssessment({ ...assessment, assessmentHash: digest(assessment) }); }
  catch { throw resultFailure(); }
}

async function lease(input) {
  if (typeof input.assertLeaseActive !== "function") throw inputFailure();
  await input.assertLeaseActive();
}

function sourceFactsFor(scope, run) {
  const optional = (value) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, "sourceFacts");
    if (!descriptor) return undefined;
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw inputFailure();
    return descriptor.value;
  };
  const facts = optional(run) ?? optional(scope) ?? {};
  const active = new Set();
  const clone = (value) => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 4_000 && !URL_VALUE.test(value)
      && !/[\u0000-\u001f\u007f]/u.test(value)) return value;
    if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) throw inputFailure();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100) throw inputFailure();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw inputFailure();
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw inputFailure();
          return clone(descriptor.value);
        });
      }
      if (!plain(value)) throw inputFailure();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > 100 || keys.some((key) => typeof key !== "string" || FORBIDDEN_FACT_KEY.test(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw inputFailure();
      return Object.fromEntries(keys.map((key) => [key, clone(descriptors[key].value)]));
    } finally { active.delete(value); }
  };
  const safe = clone(facts);
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > 64 * 1024) throw inputFailure();
  return safe;
}

function existingBatch(records, batch, inputHash) {
  if (!Array.isArray(records)) throw repositoryFailure();
  const rows = records.filter((row) => row?.analysisBatchId === batch.analysisBatchId && row?.inputHash === inputHash);
  if (rows.length === 0) return null;
  if (rows.length !== batch.assets.length) throw repositoryFailure();
  const byAsset = new Map(rows.map((row) => [row?.sourceAssetId, row]));
  const assessments = batch.assets.map((asset) => {
    const row = byAsset.get(asset.sourceAssetId);
    if (!row?.assessment) throw repositoryFailure();
    let verified;
    try { verified = verifySourceImageAssessment(row.assessment); } catch { throw repositoryFailure(); }
    if (verified.sourceOrdinal !== asset.sourceOrdinal || verified.objectKey !== asset.objectKey
      || verified.contentHash !== asset.contentHash || row.resultHash !== verified.assessmentHash) throw repositoryFailure();
    return verified;
  });
  return { status: "EXISTING_ACCEPTED", analysisBatchId: batch.analysisBatchId, inputHash,
    resultHash: digest(assessments.map(({ assessmentHash }) => assessmentHash)), assessments };
}

function observationFromAssessment(assessment) {
  return Object.fromEntries([
    "contentKinds", "viewpoints", "subjectBounds", "quality", "ocrRegions",
    ...(assessment.contractVersion === SOURCE_IMAGE_INTELLIGENCE_CONTRACT_VERSIONS.V2 ? ["semanticTextRegions"] : []),
    "markings",
    "perceptualDuplicateGroup", "eligibleUses", "reasonCodes",
  ].map((key) => [key, assessment[key]]));
}

function acceptedHistoricalObservations(records, batch, repositoryScope) {
  const byHash = new Map();
  const batchContentHashes = new Set(batch.assets.map(({ contentHash }) => contentHash));
  for (const rawRow of records) {
    let row;
    let assessment;
    try {
      row = projected(rawRow, [
        "accountId", "jobId", "itemId", "analysisRunId", "expectedStatusVersion", "sourceAssetId",
        "sourceOrdinal", "terminalStatus", "analysisBatchId", "inputHash", "resultHash", "assessment",
      ]);
      assessment = verifySourceImageAssessment(row.assessment);
    } catch { continue; }
    if (row.accountId !== repositoryScope.accountId || row.jobId !== repositoryScope.jobId
      || row.itemId !== repositoryScope.itemId || row.analysisRunId !== repositoryScope.analysisRunId
      || row.expectedStatusVersion !== repositoryScope.expectedStatusVersion
      || row.analysisBatchId === batch.analysisBatchId || !HASH.test(row.analysisBatchId || "")
      || !HASH.test(row.inputHash || "") || row.resultHash !== assessment.assessmentHash
      || row.sourceAssetId !== assessment.sourceAssetId || row.sourceOrdinal !== assessment.sourceOrdinal
      || row.terminalStatus !== "ANALYZED" || assessment.terminalStatus !== "ANALYZED"
      || assessment.parentSourceAssetId !== null || assessment.duplicateOfSourceAssetId !== null
      || typeof assessment.objectKey !== "string" || assessment.sourceOrdinal > 9999
      || !HASH.test(assessment.contentHash || "") || !batchContentHashes.has(assessment.contentHash)
      || batch.assets.some(({ sourceOrdinal }) => sourceOrdinal <= assessment.sourceOrdinal)
      || batch.assets.some(({ sourceAssetId }) => sourceAssetId === assessment.sourceAssetId)) continue;
    const found = byHash.get(assessment.contentHash) || [];
    found.push({ assessment, observation: observationFromAssessment(assessment) });
    byHash.set(assessment.contentHash, found);
  }
  return new Map([...byHash].flatMap(([contentHash, candidates]) => candidates.length === 1
    ? [[contentHash, candidates[0]]] : []));
}

export async function analyzeSourceImageBatch(input = {}) {
  const { scope, run } = scopeFor(input.scope, input.run);
  const batch = batchFor(input.batch);
  const profile = profileFor(input.profile, scope, run);
  const gatewayExecution = executionFor(input.gatewayExecution, profile);
  if (!input.repository || typeof input.repository.listRunAssessments !== "function"
    || typeof input.repository.recordBatchAssessments !== "function"
    || !input.sourceAssetLoader || typeof input.sourceAssetLoader.loadSourceAsset !== "function"
    || !input.gateway || !(typeof input.gateway.analyzeSourceImages === "function"
      || typeof input.gateway.createTextResponse === "function")) throw inputFailure();
  const sourceFacts = sourceFactsFor(input.scope, input.run);
  const representativeByHash = new Map();
  for (const asset of batch.assets) if (!representativeByHash.has(asset.contentHash)) representativeByHash.set(asset.contentHash, asset);
  const repositoryScope = { ...scope, analysisRunId: run.id };
  let records;
  try { records = await input.repository.listRunAssessments(repositoryScope); }
  catch { throw repositoryFailure(); }
  const inputHashFor = (assets, reusedAssessments = []) => digest({
    contractVersion: run.contractVersion,
    runInputHash: run.inputHash,
    analysisBatchId: batch.analysisBatchId,
    sourceFacts,
    images: assets.map(({ sourceAssetId, sourceOrdinal, contentType, contentHash }) => ({
      sourceAssetId, sourceOrdinal, contentType, contentHash,
    })),
    ...(reusedAssessments.length > 0 ? { reusedAssessments } : {}),
    profile: { id: profile.id, version: profile.configVersion, model: profile.textModel },
  });
  const legacyInputHash = inputHashFor([...representativeByHash.values()]);
  const legacyReplay = existingBatch(records, batch, legacyInputHash);
  if (legacyReplay) return Object.freeze(legacyReplay);

  const historicalByHash = acceptedHistoricalObservations(records, batch, repositoryScope);
  const representatives = [...representativeByHash.values()].filter((asset) => !historicalByHash.has(asset.contentHash));
  const reusedAssessments = [...historicalByHash].sort(([left], [right]) => compareCodePoints(left, right))
    .map(([contentHash, { assessment }]) => ({
      contentHash, sourceAssetId: assessment.sourceAssetId, assessmentHash: assessment.assessmentHash,
    }));
  const inputHash = inputHashFor(representatives, reusedAssessments);
  if (inputHash !== legacyInputHash) {
    const replay = existingBatch(records, batch, inputHash);
    if (replay) return Object.freeze(replay);
  }

  await lease(input);
  const images = [];
  for (const asset of representatives) {
    await lease(input);
    let loaded;
    try {
      loaded = await input.sourceAssetLoader.loadSourceAsset({
        scope, run, materializedAsset: asset,
      });
    } catch { throw inputFailure(); }
    const bytes = Buffer.isBuffer(loaded?.bytes) ? Buffer.from(loaded.bytes) : null;
    if (!bytes || bytes.length !== asset.sizeBytes || contentDigest(bytes) !== asset.contentHash
      || loaded.contentType !== asset.contentType || !CONTENT_TYPES.has(loaded.contentType)) throw inputFailure();
    images.push(Object.freeze({ sourceAssetId: asset.sourceAssetId, sourceOrdinal: asset.sourceOrdinal,
      contentType: asset.contentType, bytes }));
  }
  let observations = [];
  if (representatives.length > 0) {
    const aiInput = Object.freeze({ contractVersion: run.contractVersion,
      sourceFacts, images: Object.freeze(images) });
    for (let resultAttemptNo = 1; resultAttemptNo <= SOURCE_IMAGE_ANALYSIS_RESULT_MAX_ATTEMPTS; resultAttemptNo += 1) {
      const requestKey = resultAttemptNo === 1
        ? inputHash : digest({ inputHash, resultAttemptNo });
      const gateway = typeof input.gateway.analyzeSourceImages === "function" ? input.gateway
        : createSourceImageAnalysisAiAdapter({
            gateway: input.gateway, profile, gatewayExecution,
            requestIdentity: {
              correlationId: `source-image:${scope.jobId}:${scope.itemId}:${batch.analysisBatchId.slice(0, 16)}`,
              requestKey,
            },
          });
      await lease(input);
      try {
        const rawResult = await gateway.analyzeSourceImages(aiInput);
        observations = observationsFor(rawResult, representatives, run.contractVersion);
        break;
      } catch (error) {
        if (error?.code !== "AUTO_LISTING_SOURCE_IMAGE_ANALYSIS_RESULT_INVALID"
          || resultAttemptNo === SOURCE_IMAGE_ANALYSIS_RESULT_MAX_ATTEMPTS) throw error;
      }
    }
  }
  const byObservation = new Map(observations.map((entry) => [entry.sourceAssetId, entry]));
  const representativeIdByHash = new Map(representatives.map((asset) => [asset.contentHash, asset.sourceAssetId]));
  const assessments = batch.assets.map((asset) => {
    const historical = historicalByHash.get(asset.contentHash);
    if (historical) return assessmentFor(asset, historical.observation, historical.assessment.sourceAssetId, run.contractVersion);
    const representativeId = representativeIdByHash.get(asset.contentHash);
    return assessmentFor(asset, byObservation.get(representativeId),
      representativeId === asset.sourceAssetId ? null : representativeId, run.contractVersion);
  });
  const resultHash = digest(assessments.map(({ assessmentHash }) => assessmentHash));
  await lease(input);
  let stored;
  try {
    stored = await input.repository.recordBatchAssessments({
      ...repositoryScope,
      analysisBatchId: batch.analysisBatchId,
      inputHash,
      resultHash,
      assessments,
    });
  } catch { throw repositoryFailure(); }
  if (!plain(stored) || !["ACCEPTED", "EXISTING_ACCEPTED"].includes(stored.status)
    || stored.analysisBatchId !== batch.analysisBatchId || stored.inputHash !== inputHash
    || stored.resultHash !== resultHash || stored.assessmentCount !== assessments.length) throw repositoryFailure();
  return Object.freeze({ ...stored, assessments });
}
