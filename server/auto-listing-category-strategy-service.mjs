import crypto from "node:crypto";
import { types } from "node:util";

import { assertPermission, PERMISSIONS } from "./permissions.mjs";
import {
  projectCategoryStrategyGuidanceV2,
  projectCategoryStrategyScope,
} from "./auto-listing-category-strategy-contract.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MODES = new Set(["LEGACY_FALLBACK", "REQUIRE_EXACT_STRATEGY"]);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const REPLAY_CACHE_TTL_MS = 30 * 60 * 1000;
const FACTORY_KEYS = new Set([
  "repository", "readModel", "sampleStore", "exactProductFacts", "extensionSessionChannel",
  "publicationService", "analyzer", "objectStorage", "now", "deriveSessionIdentity",
]);
const FACTORY_KEYS_WITHOUT_ANALYZER = new Set([...FACTORY_KEYS].filter((key) => key !== "analyzer"));

function failure(code, status = 422, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

function invalid() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID", 400);
}

function dataBoundary() {
  return failure("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
}

function dependencyDto(project) {
  try {
    return project();
  } catch {
    throw dataBoundary();
  }
}

function closed(raw, keys) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.size || own.some((key) => typeof key !== "string" || !keys.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) throw invalid();
    return Object.fromEntries(own.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") throw error;
    throw invalid();
  }
}

function closedArray(raw, minimum, maximum) {
  try {
    if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length < minimum || raw.length > maximum) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== raw.length + 1 || descriptors.length?.value !== raw.length) throw invalid();
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw invalid();
      return descriptor.value;
    });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") throw error;
    throw invalid();
  }
}

function identifier(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(text)) throw invalid();
  return text;
}

function secret(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length < 32 || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text)) throw invalid();
  return text;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function productId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function operationId(prefix, ...identity) {
  return `${prefix}-${hash(identity.join("\0")).slice(0, 40)}`;
}

function actorAccount(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (descriptors.id?.enumerable !== true || !Object.hasOwn(descriptors.id, "value")
      || descriptors.role?.enumerable !== true || !Object.hasOwn(descriptors.role, "value")) throw invalid();
    const actor = Object.freeze({ id: identifier(descriptors.id.value), role: descriptors.role.value });
    assertPermission(actor, PERMISSIONS.AI_CONTENT_MANAGE);
    return actor.id;
  } catch (error) {
    if (error?.code === "PERMISSION_FORBIDDEN" || error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_REQUEST_INVALID") {
      throw error;
    }
    throw invalid();
  }
}

function scopeFor(accountId, raw, includesAccount = false) {
  let input;
  if (includesAccount) input = closed(raw,
    new Set(["accountId", "taxonomyScope", "descriptionCategoryId", "typeId"]));
  else {
    const value = closed(raw, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
    input = { accountId, ...value };
  }
  let scope;
  try { scope = projectCategoryStrategyScope(input); } catch { throw invalid(); }
  if (scope.accountId !== accountId) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
  }
  return scope;
}

function publicScope(scope) {
  return Object.freeze({ taxonomyScope: scope.taxonomyScope,
    descriptionCategoryId: scope.descriptionCategoryId, typeId: scope.typeId });
}

function browserUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2048) throw invalid();
  let parsed;
  try { parsed = new URL(value); } catch { throw invalid(); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
    || !(host === "ozon.ru" || host.endsWith(".ozon.ru"))) throw invalid();
  parsed.search = "";
  return parsed.href;
}

function samplingBrowserUrl(value, sessionId) {
  const url = new URL(browserUrl(value));
  url.searchParams.set("zongziCategoryStrategySession", identifier(sessionId));
  return url.href;
}

function exactIsoDate(value) {
  if (typeof value !== "string") throw invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalid();
  return value;
}

function duplicate(value) {
  if (typeof value !== "boolean") throw invalid();
  return value;
}

function sameScope(left, right) {
  return left.accountId === right.accountId && left.taxonomyScope === right.taxonomyScope
    && left.descriptionCategoryId === right.descriptionCategoryId && left.typeId === right.typeId;
}

function policyRow(raw, accountId, expectedMode = null, expectedVersion = null) {
  return dependencyDto(() => {
    const value = closed(raw, new Set(["accountId", "mode", "version", "duplicate"]));
    const mode = value.mode;
    const version = positive(value.version);
    if (identifier(value.accountId) !== accountId || !MODES.has(mode)
      || (expectedMode !== null && mode !== expectedMode)
      || (expectedVersion !== null && version !== expectedVersion)) throw invalid();
    return Object.freeze({ mode, version, duplicate: duplicate(value.duplicate) });
  });
}

function createdDraftRow(raw, accountId, expectedScope, expectedSourceCollectItemId, expectedSourceVersion) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "draftId", "accountId", "scope", "draftVersion", "status", "sourceCollectItemId",
      "expectedSourceVersion", "duplicate",
    ]));
    const scope = scopeFor(accountId, value.scope, true);
    if (identifier(value.accountId) !== accountId || !sameScope(scope, expectedScope)
      || value.status !== "COLLECTING"
      || identifier(value.sourceCollectItemId) !== expectedSourceCollectItemId
      || identifier(value.expectedSourceVersion) !== expectedSourceVersion) throw invalid();
    return Object.freeze({ draftId: identifier(value.draftId), scope, draftVersion: positive(value.draftVersion),
      status: value.status, duplicate: duplicate(value.duplicate) });
  });
}

function samplingSessionRow(raw, accountId, draftId) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "sessionId", "draftId", "accountId", "state", "createdAt", "expiresAt", "duplicate",
    ]));
    if (identifier(value.accountId) !== accountId || identifier(value.draftId) !== draftId
      || value.state !== "ACTIVE") throw invalid();
    exactIsoDate(value.createdAt);
    return Object.freeze({ sessionId: identifier(value.sessionId), expiresAt: exactIsoDate(value.expiresAt),
      duplicate: duplicate(value.duplicate) });
  });
}

function derivedSessionIdentity(raw) {
  return dependencyDto(() => {
    const value = closed(raw, new Set(["sessionId", "sessionSecret"]));
    return Object.freeze({ sessionId: identifier(value.sessionId), sessionSecret: secret(value.sessionSecret) });
  });
}

function committedSampleSetRow(raw, expected) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "sampleSetId", "draftId", "accountId", "sampleSetHash", "sampleCount", "draftVersion",
      "status", "idempotencyKey", "duplicate",
    ]));
    const sampleSetId = identifier(value.sampleSetId);
    if (identifier(value.accountId) !== expected.accountId
      || identifier(value.draftId) !== expected.draftId
      || (expected.sampleSetId !== undefined && sampleSetId !== expected.sampleSetId)
      || identifier(value.idempotencyKey) !== expected.idempotencyKey
      || typeof value.sampleSetHash !== "string" || !SHA256.test(value.sampleSetHash)
      || value.sampleCount !== expected.sampleCount || value.draftVersion !== expected.draftVersion
      || value.status !== "SAMPLES_READY") throw invalid();
    return Object.freeze({ sampleSetId, sampleSetHash: value.sampleSetHash,
      sampleCount: value.sampleCount, draftVersion: value.draftVersion, status: value.status,
      duplicate: duplicate(value.duplicate) });
  });
}

function readDraftRow(raw, accountId) {
  let row;
  let rowAccountId;
  try {
    row = closed(raw, new Set([
      "draftId", "accountId", "scope", "draftVersion", "status", "sampleCount",
      "sourceCollectItemId", "expectedSourceVersion", "browserUrl",
    ]));
    rowAccountId = identifier(row.accountId);
  } catch {
    throw dataBoundary();
  }
  if (rowAccountId !== accountId) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
  }
  try {
    const scope = scopeFor(accountId, row.scope, true);
    if (!["COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW"].includes(row.status)
      || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < 0 || row.sampleCount > 20) throw invalid();
    return Object.freeze({
      draftId: identifier(row.draftId), scope, draftVersion: positive(row.draftVersion), status: row.status,
      sampleCount: row.sampleCount, sourceCollectItemId: identifier(row.sourceCollectItemId),
      expectedSourceVersion: identifier(row.expectedSourceVersion), browserUrl: browserUrl(row.browserUrl),
    });
  } catch {
    throw dataBoundary();
  }
}

function publicDraft(row, { includeSource = false } = {}) {
  return Object.freeze({ draftId: row.draftId, scope: publicScope(row.scope),
    draftVersion: row.draftVersion, status: row.status, sampleCount: row.sampleCount,
    ...(includeSource ? { sourceCollectItemId: row.sourceCollectItemId,
      expectedSourceVersion: row.expectedSourceVersion } : {}),
  });
}

function safeText(value, maximum = 4_000, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  const normalized = value.trim();
  if (!normalized && !nullable) throw invalid();
  return normalized;
}

function publicEvidenceSummary(raw) {
  if (raw === null) return null;
  const value = closed(raw, new Set(["roleEvidence", "commonPatterns", "differences", "cautions"]));
  const roles = ["MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC"];
  const roleInput = closed(value.roleEvidence, new Set(roles));
  const evidenceIds = (items, minimum = 0) => closedArray(items, minimum, 100).map(identifier);
  const roleEvidence = Object.fromEntries(roles.map((role) => {
    const item = closed(roleInput[role], new Set(["evidenceIds", "confidence"]));
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) throw invalid();
    return [role, { evidenceIds: evidenceIds(item.evidenceIds), confidence: item.confidence }];
  }));
  const commonPatterns = closedArray(value.commonPatterns, 0, 50).map((entry) => {
    const item = closed(entry, new Set(["pattern", "evidenceIds", "confidence"]));
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) throw invalid();
    return { pattern: safeText(item.pattern), evidenceIds: evidenceIds(item.evidenceIds, 2), confidence: item.confidence };
  });
  const differences = closedArray(value.differences, 0, 50).map((entry) => {
    const item = closed(entry, new Set(["pattern", "evidenceIds"]));
    return { pattern: safeText(item.pattern), evidenceIds: evidenceIds(item.evidenceIds, 1) };
  });
  const cautions = closedArray(value.cautions, 0, 50).map((entry) => safeText(entry));
  return freeze({ roleEvidence, commonPatterns, differences, cautions });
}

function publicReadAnalysis(raw) {
  if (raw === null) return null;
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "attemptId", "resultId", "status", "draftVersion", "duplicate", "safeCode", "guidance",
      "evidenceSummary", "provenance", "editedAt", "baseAnalysisAttemptId",
    ]));
    if (!new Set(["DRAFT_READY", "NEEDS_REVIEW"]).has(value.status)
      || value.duplicate !== false || !new Set(["AI", "MANUAL"]).has(value.provenance)
      || !(value.safeCode === null || (typeof value.safeCode === "string"
        && /^AUTO_LISTING_CATEGORY_STRATEGY_[A-Z0-9_:-]+$/u.test(value.safeCode)))) throw invalid();
    const manual = value.provenance === "MANUAL";
    if (manual !== (value.editedAt !== null && value.baseAnalysisAttemptId !== null)) throw invalid();
    return freeze({ attemptId: identifier(value.attemptId), resultId: identifier(value.resultId),
      status: value.status, draftVersion: positive(value.draftVersion), duplicate: false,
      safeCode: value.safeCode, guidance: projectCategoryStrategyGuidanceV2(value.guidance),
      evidenceSummary: publicEvidenceSummary(value.evidenceSummary), provenance: value.provenance,
      editedAt: value.editedAt === null ? null : exactIsoDate(value.editedAt),
      baseAnalysisAttemptId: value.baseAnalysisAttemptId === null ? null : identifier(value.baseAnalysisAttemptId) });
  });
}

function publicVersion(raw, { publishedOnly = false } = {}) {
  const value = closed(raw, new Set(["id", "strategyKey", "version", "status"]));
  if (!(publishedOnly ? value.status === "PUBLISHED" : ["DRAFT", "PUBLISHED", "RETIRED"].includes(value.status))) {
    throw invalid();
  }
  return Object.freeze({ id: identifier(value.id), strategyKey: identifier(value.strategyKey),
    version: positive(value.version), status: value.status });
}

function publicDraftDetail(raw, accountId) {
  try {
    const value = closed(raw, new Set(["draft", "session", "samples", "analysis", "published", "versions"]));
    const draft = readDraftRow(value.draft, accountId);
    const session = value.session === null ? null : (() => {
      const item = closed(value.session, new Set(["sessionId", "state", "expiresAt"]));
      if (item.state !== "ACTIVE") throw invalid();
      return Object.freeze({ sessionId: identifier(item.sessionId), expiresAt: exactIsoDate(item.expiresAt),
        browserUrl: samplingBrowserUrl(draft.browserUrl, item.sessionId),
        extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: publicScope(draft.scope), duplicate: false });
    })();
    const samples = closedArray(value.samples, 0, 20).map((entry) => {
      const item = closed(entry, new Set([
        "sampleId", "sku", "title", "imageCount", "status", "excludedReasons", "thumbnailImageId",
      ]));
      if (!["READY", "EXCLUDED", "PENDING"].includes(item.status)
        || !Number.isSafeInteger(item.imageCount) || item.imageCount < 1 || item.imageCount > 6) throw invalid();
      const sampleId = identifier(item.sampleId);
      const imageId = identifier(item.thumbnailImageId);
      return Object.freeze({ sampleId, sku: identifier(item.sku), title: safeText(item.title, 500, true),
        thumbnailUrl: `/api/admin/auto-listing/category-strategies/${encodeURIComponent(draft.draftId)}`
          + `/samples/${encodeURIComponent(sampleId)}/images/${encodeURIComponent(imageId)}/thumbnail`,
        imageCount: item.imageCount, status: item.status,
        excludedReasons: Object.freeze(closedArray(item.excludedReasons, 0, 20).map((reason) => {
          const safe = safeText(reason, 160);
          if (!/^AUTO_LISTING_CATEGORY_STRATEGY_[A-Z0-9_:-]+$/u.test(safe)) throw invalid();
          return safe;
        })) });
    });
    if (samples.length !== draft.sampleCount || new Set(samples.map((sample) => sample.sampleId)).size !== samples.length
      || new Set(samples.map((sample) => sample.sku)).size !== samples.length) throw invalid();
    const versions = Object.freeze(closedArray(value.versions, 0, 1_000).map((item) => publicVersion(item)));
    const published = value.published === null ? null : publicVersion(value.published, { publishedOnly: true });
    if ((published === null) !== !versions.some((item) => item.status === "PUBLISHED")
      || (published && !versions.some((item) => item.id === published.id && item.status === "PUBLISHED"))) throw invalid();
    return freeze({ draft: publicDraft(draft, { includeSource: true }), session, samples,
      analysis: publicReadAnalysis(value.analysis), published, versions });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND") throw error;
    throw dataBoundary();
  }
}

function thumbnailEvidence(raw, expected) {
  if (raw === null) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND", 404);
  try {
    const value = closed(raw, new Set([
      "accountId", "draftId", "sampleId", "imageId", "objectKey", "contentHash",
    ]));
    if (identifier(value.accountId) !== expected.accountId || identifier(value.draftId) !== expected.draftId
      || identifier(value.sampleId) !== expected.sampleId || identifier(value.imageId) !== expected.imageId) {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND", 404);
    }
    const prefix = `category-strategy/${expected.accountId}/${expected.draftId}/`;
    if (typeof value.objectKey !== "string" || value.objectKey.length > 1_024
      || value.objectKey.includes("..") || !value.objectKey.startsWith(prefix)
      || typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) throw invalid();
    return Object.freeze({ objectKey: value.objectKey, contentHash: value.contentHash });
  } catch (error) {
    if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND") throw error;
    throw dataBoundary();
  }
}

function sourceReference(raw) {
  const value = closed(raw, new Set(["imageId", "role", "ordinal", "sourceUrl", "sourceResponseHash"]));
  if (!["MAIN", "DETAIL"].includes(value.role) || !Number.isInteger(value.ordinal)
    || (value.role === "MAIN") !== (value.ordinal === 0)
    || typeof value.sourceResponseHash !== "string" || !SHA256.test(value.sourceResponseHash)) throw invalid();
  return Object.freeze({ imageId: identifier(value.imageId), role: value.role, ordinal: value.ordinal,
    sourceUrl: value.sourceUrl, sourceResponseHash: value.sourceResponseHash });
}

function verifiedFact(raw, claimed, scope) {
  const value = closed(raw, new Set([
    "sku", "sourceProductId", "sourceProductRef", "sourceProductResponseHash", "pageScope",
    "productScope", "sourceReferences",
  ]));
  const pageScope = evidenceScope(value.pageScope);
  const productScope = evidenceScope(value.productScope);
  if (identifier(value.sku) !== claimed.sku || productId(value.sourceProductId) !== claimed.sourceProductId
    || identifier(value.sourceProductRef) !== claimed.sourceProductRef
    || typeof value.sourceProductResponseHash !== "string" || !SHA256.test(value.sourceProductResponseHash)
    || [pageScope, productScope].some((candidate) => candidate.taxonomyScope !== scope.taxonomyScope
      || candidate.descriptionCategoryId !== scope.descriptionCategoryId || candidate.typeId !== scope.typeId)) {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_SCOPE_CONFLICT", 409);
  }
  const references = closedArray(value.sourceReferences, 1, 6).map(sourceReference);
  if (references.some((entry, ordinal) => entry.ordinal !== ordinal
    || entry.role !== (ordinal === 0 ? "MAIN" : "DETAIL"))) throw invalid();
  return Object.freeze({ sku: claimed.sku, sourceProductId: claimed.sourceProductId,
    sourceProductRef: claimed.sourceProductRef, sourceProductResponseHash: value.sourceProductResponseHash,
    sourceReferences: Object.freeze(references) });
}

function sampleSelection(raw) {
  const value = closed(raw, new Set(["sku", "sourceProductId", "sourceProductRef"]));
  return Object.freeze({ sku: identifier(value.sku), sourceProductId: productId(value.sourceProductId),
    sourceProductRef: identifier(value.sourceProductRef) });
}

function evidenceScope(raw) {
  const value = closed(raw, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (value.taxonomyScope !== "OZON:DEFAULT" || !Number.isSafeInteger(value.descriptionCategoryId)
    || value.descriptionCategoryId < 1 || !Number.isSafeInteger(value.typeId) || value.typeId < 1) throw invalid();
  return Object.freeze({ taxonomyScope: value.taxonomyScope,
    descriptionCategoryId: value.descriptionCategoryId, typeId: value.typeId });
}

function dependencyError(error) {
  if (typeof error?.code === "string" && (error.code === "PERMISSION_FORBIDDEN"
    || error.code.startsWith("AUTO_LISTING_CATEGORY_STRATEGY_"))) throw error;
  throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SERVICE_FAILED", 503, true);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function discardClosedJson(raw, state = { nodes: 0 }, depth = 0) {
  if (raw === null || typeof raw === "boolean") return;
  if (typeof raw === "string") {
    if (raw.length > 1_048_576) throw new Error("boundary");
    return;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error("boundary");
    return;
  }
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || depth > 32
    || ++state.nodes > 100_000) throw new Error("boundary");
  const isArray = Array.isArray(raw);
  if (!isArray && ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("boundary");
  if (isArray && Object.getPrototypeOf(raw) !== Array.prototype) throw new Error("boundary");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const own = Reflect.ownKeys(descriptors);
  if (isArray) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 10_000 || own.length !== length + 1) {
      throw new Error("boundary");
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
        throw new Error("boundary");
      }
      discardClosedJson(descriptor.value, state, depth + 1);
    }
    return;
  }
  if (own.length > 10_000) throw new Error("boundary");
  for (const key of own) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || key.length > 1_024 || descriptor?.enumerable !== true
      || !Object.hasOwn(descriptor, "value")) throw new Error("boundary");
    discardClosedJson(descriptor.value, state, depth + 1);
  }
}

function publicationDto(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || types.isProxy(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("boundary");
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = Reflect.ownKeys(descriptors);
    const required = new Set(["id", "strategyKey", "version", "status", "content", "rules"]);
    const allowed = new Set([...required, "duplicate"]);
    if (![6, 7].includes(own.length) || own.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))
      || [...required].some((key) => !Object.hasOwn(descriptors, key))) throw new Error("boundary");
    const id = typeof descriptors.id.value === "string" ? descriptors.id.value.trim() : "";
    const strategyKey = typeof descriptors.strategyKey.value === "string" ? descriptors.strategyKey.value.trim() : "";
    const status = typeof descriptors.status.value === "string" ? descriptors.status.value.trim() : "";
    const version = descriptors.version.value;
    if (!descriptors.content.value || typeof descriptors.content.value !== "object"
      || !Array.isArray(descriptors.rules.value)) throw new Error("boundary");
    discardClosedJson(descriptors.content.value);
    discardClosedJson(descriptors.rules.value);
    if (!SAFE_ID.test(id) || !SAFE_ID.test(strategyKey) || status !== "PUBLISHED"
      || !Number.isSafeInteger(version) || version < 1
      || (Object.hasOwn(descriptors, "duplicate") && typeof descriptors.duplicate.value !== "boolean")) {
      throw new Error("boundary");
    }
    return Object.freeze({ id, strategyKey, version, status,
      ...(Object.hasOwn(descriptors, "duplicate") ? { duplicate: descriptors.duplicate.value } : {}) });
  } catch {
    throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DATA_BOUNDARY", 500);
  }
}

function analysisDto(raw, accountId) {
  return dependencyDto(() => {
    const value = closed(raw, new Set([
      "attemptId", "resultId", "status", "draftVersion", "duplicate", "safeCode", "guidance",
      "evidenceSummary", "editedBy", "editedAt", "baseAnalysisAttemptId",
    ]));
    if (!["DRAFT_READY", "NEEDS_REVIEW"].includes(value.status)
      || typeof value.duplicate !== "boolean"
      || !(value.safeCode === null || (typeof value.safeCode === "string"
        && /^AUTO_LISTING_CATEGORY_STRATEGY_[A-Z0-9_:-]+$/u.test(value.safeCode)))) throw invalid();
    let guidance;
    try { guidance = projectCategoryStrategyGuidanceV2(value.guidance); } catch { throw invalid(); }
    let evidenceSummary = null;
    if (value.evidenceSummary !== null) {
      discardClosedJson(value.evidenceSummary);
      evidenceSummary = JSON.parse(JSON.stringify(value.evidenceSummary));
    }
    const editedBy = value.editedBy === null ? null : identifier(value.editedBy);
    const editedAt = value.editedAt === null ? null : exactIsoDate(value.editedAt);
    const baseAnalysisAttemptId = value.baseAnalysisAttemptId === null
      ? null : identifier(value.baseAnalysisAttemptId);
    if ((editedBy === null) !== (editedAt === null) || (editedBy === null) !== (baseAnalysisAttemptId === null)
      || (editedBy !== null && editedBy !== accountId)) {
      throw invalid();
    }
    return freeze({ attemptId: identifier(value.attemptId), resultId: identifier(value.resultId),
      status: value.status, draftVersion: positive(value.draftVersion), duplicate: value.duplicate,
      safeCode: value.safeCode, guidance, evidenceSummary,
      provenance: editedBy === null ? "AI" : "MANUAL", editedAt, baseAnalysisAttemptId });
  });
}

function absentAnalyzer() {
  const notReady = () => { throw failure("AUTO_LISTING_CATEGORY_STRATEGY_ANALYSIS_NOT_READY", 409); };
  return Object.freeze({ analyze: notReady, editGuidance: notReady });
}

export function createAutoListingCategoryStrategyService(rawOptions = {}) {
  const analyzerDescriptor = !types.isProxy(rawOptions)
    ? Object.getOwnPropertyDescriptor(rawOptions, "analyzer") : null;
  const options = closed(rawOptions, analyzerDescriptor ? FACTORY_KEYS : FACTORY_KEYS_WITHOUT_ANALYZER);
  const { repository, readModel, sampleStore, exactProductFacts, extensionSessionChannel,
    publicationService, analyzer, objectStorage, now, deriveSessionIdentity } = options;
  const analysisPort = analyzer ?? absentAnalyzer();
  if (!["getDraftReplay", "createDraft", "startSamplingSession", "getSamplingSessionReplay", "validateSamplingSession",
    "getCommittedSampleSetReplay", "commitSampleSetCanonical", "transitionAccountPolicy",
    "getAccountPolicy"].every((method) => typeof repository?.[method] === "function")
    || typeof readModel?.listStrategies !== "function" || typeof readModel?.getDraft !== "function"
    || typeof readModel?.getDraftDetail !== "function" || typeof readModel?.getThumbnailEvidence !== "function"
    || typeof sampleStore?.persistSampleImages !== "function" || typeof exactProductFacts?.verify !== "function"
    || typeof extensionSessionChannel?.assertReady !== "function"
    || typeof extensionSessionChannel?.putSession !== "function"
    || typeof publicationService?.publishCategoryStrategyDraft !== "function"
    || typeof publicationService?.rollbackCategoryStrategyVersion !== "function"
    || typeof objectStorage?.readObjectExpected !== "function"
    || typeof analysisPort?.analyze !== "function" || typeof analysisPort?.editGuidance !== "function"
    || typeof now !== "function" || typeof deriveSessionIdentity !== "function") {
    throw new TypeError("Auto-listing category strategy service dependencies are required");
  }
  const sessionReplays = new Map();
  const sampleReplays = new Map();

  function replayCacheTime() {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }

  function pruneReplayCache(cache, currentTime) {
    for (const [key, record] of cache) {
      if (record.settled === true && record.cachedAt + REPLAY_CACHE_TTL_MS <= currentTime) {
        cache.delete(key);
      }
    }
  }

  function markReplaySettled(record) {
    const value = new Date(now()).getTime();
    if (Number.isFinite(value)) record.cachedAt = value;
    record.settled = true;
  }

  async function ownDraft(accountId, draftId) {
    let raw;
    try { raw = await readModel.getDraft({ accountId, draftId }); } catch (error) { dependencyError(error); }
    if (!raw) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
    return readDraftRow(raw, accountId);
  }

  async function accountPolicy(accountId) {
    let row;
    try { row = await repository.getAccountPolicy({ accountId }); } catch (error) { dependencyError(error); }
    return policyRow(row, accountId);
  }

  async function requireEnabled(accountId) {
    const policy = await accountPolicy(accountId);
    if (policy.mode !== "REQUIRE_EXACT_STRATEGY") {
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_READ_ONLY", 409);
    }
    return policy;
  }

  return Object.freeze({
    async listStrategies(raw = {}) {
      const input = closed(raw, new Set(["actor"]));
      const accountId = actorAccount(input.actor);
      let rows;
      try { rows = await readModel.listStrategies({ accountId }); } catch (error) { dependencyError(error); }
      return freeze(closedArray(rows, 0, 1_000).map((row) => publicDraft(readDraftRow(row, accountId))));
    },

    async getSettings(raw = {}) {
      const input = closed(raw, new Set(["actor"]));
      const accountId = actorAccount(input.actor);
      const value = await accountPolicy(accountId);
      return Object.freeze({ mode: value.mode, version: value.version });
    },

    async updateSettings(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "expectedVersion", "mode", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      if (!MODES.has(input.mode)) throw invalid();
      let row;
      try {
        row = await repository.transitionAccountPolicy({ accountId, actorId: accountId,
          expectedVersion: positive(input.expectedVersion), mode: input.mode,
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) });
      } catch (error) { dependencyError(error); }
      return policyRow(row, accountId, input.mode, positive(input.expectedVersion) + 1);
    },

    async getDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId"]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      let detail;
      try { detail = await readModel.getDraftDetail({ accountId, draftId }); } catch (error) { dependencyError(error); }
      if (!detail) throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_NOT_FOUND", 404);
      return publicDraftDetail(detail, accountId);
    },

    async readSampleThumbnail(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "sampleId", "imageId"]));
      const expected = { accountId: actorAccount(input.actor), draftId: identifier(input.draftId),
        sampleId: identifier(input.sampleId), imageId: identifier(input.imageId) };
      let evidence;
      try { evidence = thumbnailEvidence(await readModel.getThumbnailEvidence(expected), expected); } catch (error) {
        if (error?.code === "AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND") throw error;
        dependencyError(error);
      }
      try {
        const bytes = await objectStorage.readObjectExpected({ accountId: expected.accountId,
          key: evidence.objectKey, expectedSha256: evidence.contentHash, maxBytes: 16 * 1024 * 1024 });
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024) {
          throw new Error("invalid thumbnail bytes");
        }
        return Buffer.from(bytes);
      } catch (error) {
        if (error?.code === "EXPECTED_HASH_OBJECT_STORAGE_NOT_FOUND") {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_NOT_FOUND", 404);
        }
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_THUMBNAIL_HASH_MISMATCH", 409);
      }
    },

    async createDraft(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "scope", "sourceCollectItemId", "expectedSourceVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const scope = scopeFor(accountId, input.scope);
      const sourceCollectItemId = identifier(input.sourceCollectItemId);
      const expectedSourceVersion = identifier(input.expectedSourceVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      let replay;
      try {
        replay = await repository.getDraftReplay({ accountId, actorId: accountId, scope,
          sourceCollectItemId, expectedSourceVersion, idempotencyKey, correlationId });
      } catch (error) { dependencyError(error); }
      if (replay) {
        const value = createdDraftRow(replay, accountId, scope, sourceCollectItemId, expectedSourceVersion);
        return Object.freeze({ draftId: value.draftId, scope: publicScope(value.scope),
          draftVersion: value.draftVersion, status: value.status, duplicate: true });
      }
      await requireEnabled(accountId);
      let row;
      try {
        row = await repository.createDraft({ accountId, actorId: accountId, scope,
          sourceCollectItemId, expectedSourceVersion,
          idempotencyKey, correlationId });
      } catch (error) { dependencyError(error); }
      const value = createdDraftRow(row, accountId, scope, sourceCollectItemId, expectedSourceVersion);
      return Object.freeze({ draftId: value.draftId, scope: publicScope(value.scope),
        draftVersion: value.draftVersion, status: value.status, duplicate: value.duplicate });
    },

    async startSamplingSession(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "draftId", "expectedDraftVersion", "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      const expectedDraftVersion = positive(input.expectedDraftVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      const fingerprint = hash(JSON.stringify({ accountId, draftId, expectedDraftVersion,
        idempotencyKey, correlationId }));
      const replayKey = `${accountId}\\0${idempotencyKey}`;
      const currentTime = replayCacheTime();
      pruneReplayCache(sessionReplays, currentTime);
      let replay = sessionReplays.get(replayKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        if (replay.promise) return replay.promise;
        try { await extensionSessionChannel.assertReady({ accountId }); } catch (error) { dependencyError(error); }
      } else {
        try { await extensionSessionChannel.assertReady({ accountId }); } catch (error) { dependencyError(error); }
        const candidateExpiry = new Date(new Date(now()).getTime() + TWO_HOURS_MS);
        if (Number.isNaN(candidateExpiry.getTime())) throw invalid();
        let identity;
        try {
          identity = derivedSessionIdentity(await deriveSessionIdentity({ accountId, draftId,
            expectedDraftVersion, idempotencyKey, correlationId }));
        } catch (error) { dependencyError(error); }
        replay = {
          fingerprint,
          sessionId: identity.sessionId,
          sessionSecret: identity.sessionSecret,
          expiresAt: candidateExpiry.toISOString(),
          promise: null,
          settled: false,
          cachedAt: currentTime,
        };
        sessionReplays.set(replayKey, replay);
      }
      replay.settled = false;
      const promise = (async () => {
        const draft = await ownDraft(accountId, draftId);
        let durable;
        try {
          durable = await repository.getSamplingSessionReplay({ accountId, actorId: accountId, draftId,
            expectedDraftVersion, sessionId: replay.sessionId,
            sessionSecretHash: hash(replay.sessionSecret), idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        if (durable) {
          const row = samplingSessionRow(durable, accountId, draftId);
          try {
            await extensionSessionChannel.putSession({ accountId, actorId: accountId, draftId,
              expectedDraftVersion,
              sessionId: row.sessionId, sessionSecret: replay.sessionSecret, expiresAt: row.expiresAt,
              extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: publicScope(draft.scope) });
          } catch (error) { dependencyError(error); }
          replay.sessionSecret = null;
          return Object.freeze({ sessionId: row.sessionId, expiresAt: row.expiresAt,
            browserUrl: samplingBrowserUrl(draft.browserUrl, row.sessionId), extensionMode: "CATEGORY_STRATEGY_SAMPLING",
            scope: publicScope(draft.scope), duplicate: true });
        }
        await requireEnabled(accountId);
        let row;
        try {
          const stored = await repository.startSamplingSession({ accountId, actorId: accountId, draftId,
            expectedDraftVersion, sessionId: replay.sessionId, sessionSecretHash: hash(replay.sessionSecret),
            expiresAt: replay.expiresAt, idempotencyKey, correlationId });
          row = samplingSessionRow(stored, accountId, draftId);
          await extensionSessionChannel.putSession({ accountId, actorId: accountId, draftId,
            expectedDraftVersion,
            sessionId: row.sessionId, sessionSecret: replay.sessionSecret, expiresAt: row.expiresAt,
            extensionMode: "CATEGORY_STRATEGY_SAMPLING", scope: publicScope(draft.scope) });
          replay.sessionSecret = null;
        } catch (error) { dependencyError(error); }
        return Object.freeze({ sessionId: row.sessionId, expiresAt: row.expiresAt,
          browserUrl: samplingBrowserUrl(draft.browserUrl, row.sessionId), extensionMode: "CATEGORY_STRATEGY_SAMPLING",
          scope: publicScope(draft.scope), duplicate: row.duplicate });
      })();
      replay.promise = promise;
      promise.then(() => { markReplaySettled(replay); }, () => { markReplaySettled(replay); });
      promise.catch(() => {
        const current = sessionReplays.get(replayKey);
        if (current === replay && current.promise === promise) current.promise = null;
      });
      return promise;
    },

    async confirmSampleSet(raw = {}) {
      const input = closed(raw, new Set([
        "actor", "draftId", "expectedDraftVersion", "sessionId", "sessionSecret", "samples",
        "idempotencyKey", "correlationId",
      ]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      const sessionId = identifier(input.sessionId);
      const sessionSecret = secret(input.sessionSecret);
      const expectedDraftVersion = positive(input.expectedDraftVersion);
      const idempotencyKey = identifier(input.idempotencyKey);
      const correlationId = identifier(input.correlationId);
      const sampleSetId = operationId("sample-set", accountId, draftId, idempotencyKey);
      const selections = closedArray(input.samples, 5, 20).map(sampleSelection);
      if (new Set(selections.map((entry) => entry.sku)).size !== selections.length
        || new Set(selections.map((entry) => entry.sourceProductId)).size !== selections.length) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_DUPLICATE", 409);
      }
      const fingerprint = hash(JSON.stringify({ accountId, draftId, expectedDraftVersion, sessionId,
        sessionSecretHash: hash(sessionSecret), selections, idempotencyKey, correlationId }));
      const replayKey = `${accountId}\0${idempotencyKey}`;
      const currentTime = replayCacheTime();
      pruneReplayCache(sampleReplays, currentTime);
      const existing = sampleReplays.get(replayKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_IDEMPOTENCY_CONFLICT", 409);
        }
        return existing.promise;
      }
      const promise = (async () => {
        let durable;
        try {
          durable = await repository.getCommittedSampleSetReplay({ accountId, actorId: accountId, draftId,
            sessionId, sessionSecretHash: hash(sessionSecret), expectedDraftVersion,
            selections, idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        if (durable) {
          const value = committedSampleSetRow(durable, { accountId, draftId,
            idempotencyKey,
            sampleCount: selections.length, draftVersion: expectedDraftVersion + 1 });
          return Object.freeze({ draftId, ...value });
        }
        await requireEnabled(accountId);
        const draft = await ownDraft(accountId, draftId);
        if (draft.draftVersion !== expectedDraftVersion || draft.status !== "COLLECTING") {
          throw failure("AUTO_LISTING_CATEGORY_STRATEGY_DRAFT_VERSION_CONFLICT", 409);
        }
        try {
          samplingSessionRow(await repository.validateSamplingSession({ accountId, actorId: accountId,
            draftId, expectedDraftVersion, sessionId, sessionSecretHash: hash(sessionSecret) }),
          accountId, draftId);
        } catch (error) { dependencyError(error); }
        const verified = [];
        for (const selected of selections) {
          let fact;
          try {
            fact = await exactProductFacts.verify({ accountId, draftId, sessionId,
              sessionSecretHash: hash(sessionSecret), scope: publicScope(draft.scope),
              ...selected, correlationId });
          } catch (error) { dependencyError(error); }
          verified.push(verifiedFact(fact, selected, draft.scope));
        }
        const samples = [];
        for (const [ordinal, fact] of verified.entries()) {
          const sampleId = operationId("sample", accountId, draftId, idempotencyKey,
            String(ordinal), fact.sku, String(fact.sourceProductId));
          let images;
          try {
            images = await sampleStore.persistSampleImages({ accountId, draftId, sampleSetId, sampleId,
              correlationId, sourceReferences: fact.sourceReferences });
          } catch (error) { dependencyError(error); }
          samples.push({ sampleSetId, sampleId, sku: fact.sku, sourceProductId: fact.sourceProductId,
            sourceProductRef: fact.sourceProductRef,
            sourceProductResponseHash: fact.sourceProductResponseHash,
            taxonomyScope: draft.scope.taxonomyScope,
            descriptionCategoryId: draft.scope.descriptionCategoryId,
            typeId: draft.scope.typeId, images });
        }
        let row;
        try {
          row = await repository.commitSampleSetCanonical({ accountId, actorId: accountId, draftId,
            sessionId, sessionSecretHash: hash(sessionSecret), expectedDraftVersion,
            samples, idempotencyKey, correlationId });
        } catch (error) { dependencyError(error); }
        const value = committedSampleSetRow(row, { accountId, draftId, sampleSetId,
          idempotencyKey, sampleCount: samples.length, draftVersion: expectedDraftVersion + 1 });
        return Object.freeze({ draftId, ...value });
      })();
      const replay = { fingerprint, promise, settled: false, cachedAt: currentTime };
      sampleReplays.set(replayKey, replay);
      promise.then(() => { markReplaySettled(replay); }, () => { markReplaySettled(replay); });
      promise.catch(() => { if (sampleReplays.get(replayKey)?.promise === promise) sampleReplays.delete(replayKey); });
      return promise;
    },

    async removeSample(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "sampleId", "expectedDraftVersion", "idempotencyKey", "correlationId"]));
      await requireEnabled(actorAccount(input.actor));
      throw failure("AUTO_LISTING_CATEGORY_STRATEGY_SAMPLE_CHANGE_NOT_READY", 409);
    },

    async createAnalysisAttempt(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "costConfirmed", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      if (input.costConfirmed !== true) {
        throw failure("AUTO_LISTING_CATEGORY_STRATEGY_COST_CONFIRMATION_REQUIRED", 409);
      }
      await requireEnabled(accountId);
      try {
        return analysisDto(await analysisPort.analyze({ accountId, actorId: accountId,
          draftId: identifier(input.draftId), costConfirmed: true,
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }), accountId);
      } catch (error) { dependencyError(error); }
    },

    async updateDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "expectedDraftVersion", "patch", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      const patch = closed(input.patch, new Set(["guidance", "baseAnalysisAttemptId"]));
      await requireEnabled(accountId);
      try {
        return analysisDto(await analysisPort.editGuidance({ accountId, actorId: accountId,
          draftId: identifier(input.draftId), expectedDraftVersion: positive(input.expectedDraftVersion),
          baseAnalysisAttemptId: identifier(patch.baseAnalysisAttemptId), guidance: patch.guidance,
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }), accountId);
      } catch (error) { dependencyError(error); }
    },

    async publishDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "expectedDraftVersion",
        "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      const draftId = identifier(input.draftId);
      await ownDraft(accountId, draftId);
      try {
        return publicationDto(await publicationService.publishCategoryStrategyDraft({ actor: { id: accountId, role: "admin" },
          draftId, expectedDraftVersion: positive(input.expectedDraftVersion),
          expectedPublishedStrategyVersionId: identifier(input.expectedPublishedStrategyVersionId),
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }));
      } catch (error) { dependencyError(error); }
    },

    async rollbackDraft(raw = {}) {
      const input = closed(raw, new Set(["actor", "draftId", "targetStrategyVersionId",
        "expectedPublishedStrategyVersionId", "idempotencyKey", "correlationId"]));
      const accountId = actorAccount(input.actor);
      await ownDraft(accountId, identifier(input.draftId));
      try {
        return publicationDto(await publicationService.rollbackCategoryStrategyVersion({ actor: { id: accountId, role: "admin" },
          targetStrategyVersionId: identifier(input.targetStrategyVersionId),
          expectedPublishedStrategyVersionId: identifier(input.expectedPublishedStrategyVersionId),
          idempotencyKey: identifier(input.idempotencyKey), correlationId: identifier(input.correlationId) }));
      } catch (error) { dependencyError(error); }
    },
  });
}
