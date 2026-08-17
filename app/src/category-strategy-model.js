const UI_ERROR = "CATEGORY_STRATEGY_UI_DATA_INVALID";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DRAFT_STATUSES = new Set([
  "NOT_CONFIGURED", "COLLECTING", "SAMPLES_READY", "ANALYZING", "DRAFT_READY", "PUBLISHED", "NEEDS_REVIEW",
]);
const SAMPLE_STATUSES = new Set(["READY", "EXCLUDED", "PENDING"]);
const TEXT_DENSITIES = new Set(["NONE", "LIGHT", "MEDIUM", "HEAVY"]);

export const CATEGORY_STRATEGY_ROLES = Object.freeze([
  "MAIN", "SELLING_POINT", "DETAIL", "SCENE", "SPECIFICATION", "INFOGRAPHIC",
]);

export const CATEGORY_STRATEGY_RESUME_STORAGE_PREFIX = "zongzi:auto-listing:category-strategy-resume:v1";

const ROLE_SET = new Set(CATEGORY_STRATEGY_ROLES);

function uiError() {
  return Object.assign(new Error(UI_ERROR), { code: UI_ERROR });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function descriptors(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw uiError();
    const result = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(result);
    if (keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || result[key]?.enumerable !== true || !Object.hasOwn(result[key], "value"))) throw uiError();
    return { result, keys };
  } catch (error) {
    if (error?.code === UI_ERROR) throw error;
    throw uiError();
  }
}

function closed(raw, allowed, required = allowed) {
  const { result, keys } = descriptors(raw);
  if (keys.some((key) => !allowed.has(key)) || [...required].some((key) => !Object.hasOwn(result, key))) {
    throw uiError();
  }
  return Object.fromEntries(keys.map((key) => [key, result[key].value]));
}

function array(raw, minimum = 0, maximum = 100) {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length < minimum || raw.length > maximum) throw uiError();
    const result = Object.getOwnPropertyDescriptors(raw);
    const keys = Reflect.ownKeys(result);
    if (keys.length !== raw.length + 1 || result.length?.value !== raw.length) throw uiError();
    return Array.from({ length: raw.length }, (_, index) => {
      const descriptor = result[String(index)];
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw uiError();
      return descriptor.value;
    });
  } catch (error) {
    if (error?.code === UI_ERROR) throw error;
    throw uiError();
  }
}

function text(value, maximum = 500, { empty = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if ((!result && !empty) || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) throw uiError();
  return result;
}

function id(value) {
  const result = text(value, 240);
  if (!SAFE_ID.test(result)) throw uiError();
  return result;
}

function positive(value, { zero = false, maximum = 2_147_483_646 } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > maximum) throw uiError();
  return value;
}

function iso(value) {
  if (typeof value !== "string") throw uiError();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw uiError();
  return value;
}

function nullable(value, projector) {
  return value === null ? null : projector(value);
}

function scope(raw) {
  const value = closed(raw, new Set(["taxonomyScope", "descriptionCategoryId", "typeId"]));
  if (value.taxonomyScope !== "OZON:DEFAULT") throw uiError();
  return Object.freeze({
    taxonomyScope: value.taxonomyScope,
    descriptionCategoryId: positive(value.descriptionCategoryId),
    typeId: positive(value.typeId),
  });
}

function summary(raw) {
  const value = closed(raw, new Set(["draftId", "scope", "draftVersion", "status", "sampleCount"]));
  if (!DRAFT_STATUSES.has(value.status)) throw uiError();
  return Object.freeze({
    draftId: id(value.draftId), scope: scope(value.scope), draftVersion: positive(value.draftVersion),
    status: value.status, sampleCount: positive(value.sampleCount, { zero: true, maximum: 20 }),
  });
}

export function projectCategoryStrategyList(raw) {
  return deepFreeze(array(raw, 0, 1_000).map(summary));
}

export function projectCategoryStrategyDetail(raw) {
  const value = closed(raw, new Set([
    "draftId", "scope", "draftVersion", "status", "sampleCount",
    "sourceCollectItemId", "expectedSourceVersion",
  ]));
  return Object.freeze({
    ...summary({ draftId: value.draftId, scope: value.scope, draftVersion: value.draftVersion,
      status: value.status, sampleCount: value.sampleCount }),
    sourceCollectItemId: id(value.sourceCollectItemId),
    expectedSourceVersion: id(value.expectedSourceVersion),
  });
}

function safeOzonBrowserUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) throw uiError();
  let parsed;
  try { parsed = new URL(value); } catch { throw uiError(); }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash
    || !(host === "ozon.ru" || host.endsWith(".ozon.ru"))) throw uiError();
  return parsed.href;
}

export function projectCategoryStrategySession(raw) {
  const value = closed(raw, new Set([
    "sessionId", "expiresAt", "browserUrl", "extensionMode", "scope", "duplicate",
  ]));
  if (value.extensionMode !== "CATEGORY_STRATEGY_SAMPLING" || typeof value.duplicate !== "boolean") throw uiError();
  return Object.freeze({
    sessionId: id(value.sessionId), expiresAt: iso(value.expiresAt), browserUrl: safeOzonBrowserUrl(value.browserUrl),
    extensionMode: value.extensionMode, scope: scope(value.scope), duplicate: value.duplicate,
  });
}

function safeThumbnail(value) {
  const result = text(value, 2_048);
  if (!result.startsWith("/api/") || result.includes("?") || result.includes("#") || result.includes("\\")) throw uiError();
  return result;
}

export function projectCategoryStrategySample(raw) {
  const value = closed(raw, new Set([
    "sampleId", "sku", "title", "thumbnailUrl", "imageCount", "status", "excludedReasons",
  ]));
  if (!SAMPLE_STATUSES.has(value.status)) throw uiError();
  const excludedReasons = array(value.excludedReasons, 0, 20).map((entry) => text(entry, 240));
  return deepFreeze({
    sampleId: id(value.sampleId), sku: id(value.sku), title: value.title === null ? null : text(value.title, 500),
    thumbnailUrl: safeThumbnail(value.thumbnailUrl), imageCount: positive(value.imageCount, { maximum: 6 }),
    status: value.status, excludedReasons,
  });
}

function guidance(raw) {
  const value = closed(raw, new Set(["overallStyle", "prohibitedPatterns", "roles"]));
  const roles = closed(value.roles, ROLE_SET);
  const projectedRoles = {};
  for (const role of CATEGORY_STRATEGY_ROLES) {
    const item = closed(roles[role], new Set(["composition", "background", "textDensity", "layout"]));
    if (!TEXT_DENSITIES.has(item.textDensity)) throw uiError();
    projectedRoles[role] = Object.freeze({
      composition: text(item.composition, 4_000), background: text(item.background, 4_000),
      textDensity: item.textDensity, layout: text(item.layout, 4_000),
    });
  }
  return deepFreeze({
    overallStyle: text(value.overallStyle, 4_000),
    prohibitedPatterns: array(value.prohibitedPatterns, 0, 50).map((entry) => text(entry, 4_000)),
    roles: projectedRoles,
  });
}

function evidenceIds(raw, minimum = 0) {
  return array(raw, minimum, 100).map(id);
}

function evidenceSummary(raw) {
  if (raw === null) return null;
  const value = closed(raw, new Set(["roleEvidence", "commonPatterns", "differences", "cautions"]));
  const roleValue = closed(value.roleEvidence, ROLE_SET);
  const roleEvidence = Object.fromEntries(CATEGORY_STRATEGY_ROLES.map((role) => {
    const item = closed(roleValue[role], new Set(["evidenceIds", "confidence"]));
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) throw uiError();
    return [role, { evidenceIds: evidenceIds(item.evidenceIds), confidence: item.confidence }];
  }));
  const commonPatterns = array(value.commonPatterns, 0, 50).map((entry) => {
    const item = closed(entry, new Set(["pattern", "evidenceIds", "confidence"]));
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) throw uiError();
    return { pattern: text(item.pattern, 4_000), evidenceIds: evidenceIds(item.evidenceIds, 2), confidence: item.confidence };
  });
  const differences = array(value.differences, 0, 50).map((entry) => {
    const item = closed(entry, new Set(["pattern", "evidenceIds"]));
    return { pattern: text(item.pattern, 4_000), evidenceIds: evidenceIds(item.evidenceIds, 1) };
  });
  const cautions = array(value.cautions, 0, 50).map((entry) => text(entry, 4_000));
  return deepFreeze({ roleEvidence, commonPatterns, differences, cautions });
}

export function projectCategoryStrategyAnalysis(raw) {
  const value = closed(raw, new Set([
    "attemptId", "resultId", "status", "draftVersion", "duplicate", "safeCode", "guidance",
    "evidenceSummary", "provenance", "editedAt", "baseAnalysisAttemptId",
  ]));
  if (!new Set(["DRAFT_READY", "NEEDS_REVIEW"]).has(value.status) || typeof value.duplicate !== "boolean"
    || !new Set(["AI", "MANUAL"]).has(value.provenance)
    || !(value.safeCode === null || /^AUTO_LISTING_CATEGORY_STRATEGY_[A-Z0-9_:-]{1,160}$/u.test(value.safeCode))) {
    throw uiError();
  }
  const manual = value.provenance === "MANUAL";
  if (manual !== (value.editedAt !== null && value.baseAnalysisAttemptId !== null)) throw uiError();
  return deepFreeze({
    attemptId: id(value.attemptId), resultId: id(value.resultId), status: value.status,
    draftVersion: positive(value.draftVersion), duplicate: value.duplicate, safeCode: value.safeCode,
    guidance: guidance(value.guidance), evidenceSummary: evidenceSummary(value.evidenceSummary),
    provenance: value.provenance, editedAt: nullable(value.editedAt, iso),
    baseAnalysisAttemptId: nullable(value.baseAnalysisAttemptId, id),
  });
}

export function projectCategoryStrategyDetailBundle(raw) {
  const value = closed(raw, new Set(["draft", "session", "samples", "analysis", "published", "versions"]));
  const draft = projectCategoryStrategyDetail(value.draft);
  const samples = array(value.samples, 0, 20).map(projectCategoryStrategySample);
  if (samples.length !== draft.sampleCount || new Set(samples.map((sample) => sample.sampleId)).size !== samples.length
    || new Set(samples.map((sample) => sample.sku)).size !== samples.length) throw uiError();
  return deepFreeze({
    draft,
    session: nullable(value.session, projectCategoryStrategySession),
    samples,
    analysis: nullable(value.analysis, projectCategoryStrategyAnalysis),
    published: nullable(value.published, projectCategoryStrategyPublishedVersion),
    versions: projectCategoryStrategyVersionHistory(value.versions),
  });
}

export function projectCategoryStrategyPublishedVersion(raw) {
  const allowed = new Set(["id", "strategyKey", "version", "status", "duplicate"]);
  const value = closed(raw, allowed, new Set(["id", "strategyKey", "version", "status"]));
  if (value.status !== "PUBLISHED" || (value.duplicate !== undefined && typeof value.duplicate !== "boolean")) throw uiError();
  return Object.freeze({
    id: id(value.id), strategyKey: id(value.strategyKey), version: positive(value.version), status: value.status,
    ...(value.duplicate === undefined ? {} : { duplicate: value.duplicate }),
  });
}

function discardClosedJson(raw, state = { nodes: 0 }, depth = 0) {
  if (raw === null || typeof raw === "boolean") return;
  if (typeof raw === "string") { if (raw.length > 100_000) throw uiError(); return; }
  if (typeof raw === "number") { if (!Number.isFinite(raw)) throw uiError(); return; }
  if (!raw || typeof raw !== "object" || depth > 32 || ++state.nodes > 10_000) throw uiError();
  if (Array.isArray(raw)) {
    for (const entry of array(raw, 0, 1_000)) discardClosedJson(entry, state, depth + 1);
    return;
  }
  const { result, keys } = descriptors(raw);
  if (keys.length > 1_000) throw uiError();
  for (const key of keys) discardClosedJson(result[key].value, state, depth + 1);
}

export function projectCategoryStrategyVersionHistory(raw) {
  return deepFreeze(array(raw, 0, 1_000).map((entry) => {
    const value = closed(entry, new Set(["id", "strategyKey", "version", "status", "content", "rules", "duplicate"]),
      new Set(["id", "strategyKey", "version", "status"]));
    if (!new Set(["DRAFT", "PUBLISHED", "RETIRED"]).has(value.status)
      || (value.duplicate !== undefined && typeof value.duplicate !== "boolean")) throw uiError();
    if (value.content !== undefined) discardClosedJson(value.content);
    if (value.rules !== undefined) discardClosedJson(value.rules);
    return Object.freeze({ id: id(value.id), strategyKey: id(value.strategyKey),
      version: positive(value.version), status: value.status });
  }));
}

export function projectStrategyRequired(raw) {
  const value = closed(raw, new Set(["ok", "code", "message", "correlationId", "details"]));
  if (value.ok !== false || value.code !== "AUTO_LISTING_CATEGORY_STRATEGY_REQUIRED") throw uiError();
  text(value.message, 500);
  id(value.correlationId);
  const details = closed(value.details, new Set(["scope", "status", "canManage", "draftId"]),
    new Set(["scope", "status", "canManage"]));
  if (!DRAFT_STATUSES.has(details.status) || typeof details.canManage !== "boolean"
    || (!details.canManage && details.draftId !== undefined)) throw uiError();
  return Object.freeze({
    scope: scope(details.scope), status: details.status, canManage: details.canManage,
    ...(details.draftId === undefined ? {} : { draftId: id(details.draftId) }),
  });
}

function formRoles(raw) {
  const keys = new Set(["main", "sellingPoint", "detail", "scene", "specification", "infographic"]);
  const value = closed(raw, keys);
  const ranges = { main: [1, 1], sellingPoint: [2, 5], detail: [1, 2], scene: [1, 2], specification: [0, 1], infographic: [1, 2] };
  return Object.freeze(Object.fromEntries(Object.entries(ranges).map(([role, [minimum, maximum]]) => {
    const count = value[role];
    if (!Number.isInteger(count) || count < minimum || count > maximum) throw uiError();
    return [role, count];
  })));
}

function resumeForm(raw) {
  const value = closed(raw, new Set([
    "targetStoreId", "targetWarehouseId", "stock", "priceAdjustmentAmount", "ratio", "resolution", "quality",
    "language", "roles",
  ]));
  if (value.language !== "ru") throw uiError();
  return deepFreeze({
    targetStoreId: id(value.targetStoreId), targetWarehouseId: id(value.targetWarehouseId),
    stock: positive(value.stock), priceAdjustmentAmount: text(value.priceAdjustmentAmount, 80),
    ratio: text(value.ratio, 20), resolution: text(value.resolution, 20), quality: text(value.quality, 20),
    language: value.language, roles: formRoles(value.roles),
  });
}

export function projectStrategyResumeDraft(raw) {
  const value = closed(raw, new Set([
    "schemaVersion", "createdAt", "expiresAt", "accountId", "source", "collectIds", "sourceVersions", "form",
    "currency", "required", "state",
  ]));
  if (value.schemaVersion !== 1 || value.source !== "collect"
    || !new Set(["CONFIGURING", "READY_TO_CONTINUE"]).has(value.state)) throw uiError();
  const collectIds = array(value.collectIds, 1, 100).map(id);
  if (new Set(collectIds).size !== collectIds.length) throw uiError();
  const sourceVersions = array(value.sourceVersions, 1, 100).map((entry) => {
    const item = closed(entry, new Set(["collectItemId", "expectedSourceVersion"]));
    return Object.freeze({ collectItemId: id(item.collectItemId), expectedSourceVersion: id(item.expectedSourceVersion) });
  });
  if (sourceVersions.length !== collectIds.length
    || sourceVersions.some((entry, index) => entry.collectItemId !== collectIds[index])) throw uiError();
  const currency = text(value.currency, 3).toUpperCase();
  if (!new Set(["CNY", "RUB"]).has(currency)) throw uiError();
  const createdAt = iso(value.createdAt);
  const expiresAt = iso(value.expiresAt);
  if (new Date(expiresAt).getTime() <= new Date(createdAt).getTime()
    || new Date(expiresAt).getTime() - new Date(createdAt).getTime() > 24 * 60 * 60 * 1_000) throw uiError();
  return deepFreeze({
    schemaVersion: 1, createdAt, expiresAt, accountId: id(value.accountId), source: value.source, collectIds, sourceVersions,
    form: resumeForm(value.form), currency, required: (() => {
      const details = value.required;
      const safe = closed(details, new Set(["scope", "status", "canManage", "draftId"]),
        new Set(["scope", "status", "canManage"]));
      if (!DRAFT_STATUSES.has(safe.status) || typeof safe.canManage !== "boolean") throw uiError();
      return Object.freeze({ scope: scope(safe.scope), status: safe.status, canManage: safe.canManage,
        ...(safe.draftId === undefined ? {} : { draftId: id(safe.draftId) }) });
    })(), state: value.state,
  });
}

function resumeStorageKey(accountId) {
  return `${CATEGORY_STRATEGY_RESUME_STORAGE_PREFIX}:${id(accountId)}`;
}

export function readStrategyResumeDraft(storage, accountId, { now = new Date().toISOString(), sourceVersionOf } = {}) {
  try {
    if (!storage || typeof storage.getItem !== "function") return null;
    const raw = storage.getItem(resumeStorageKey(accountId));
    if (!raw || raw.length > 128 * 1024) return null;
    const value = projectStrategyResumeDraft(JSON.parse(raw));
    if (value.accountId !== accountId || new Date(value.expiresAt).getTime() <= new Date(iso(now)).getTime()
      || typeof sourceVersionOf !== "function"
      || value.sourceVersions.some((entry) => sourceVersionOf(entry.collectItemId) !== entry.expectedSourceVersion)) {
      storage.removeItem?.(resumeStorageKey(accountId));
      return null;
    }
    return value;
  } catch {
    try { storage?.removeItem?.(resumeStorageKey(accountId)); } catch { /* fail-closed cleanup */ }
    return null;
  }
}

export function writeStrategyResumeDraft(storage, raw) {
  const value = projectStrategyResumeDraft(raw);
  if (!storage || typeof storage.setItem !== "function") throw uiError();
  storage.setItem(resumeStorageKey(value.accountId), JSON.stringify(value));
  return value;
}

export function updateStrategyResumeState(storage, raw, state) {
  const current = projectStrategyResumeDraft(raw);
  return writeStrategyResumeDraft(storage, { ...current, state });
}

export function clearStrategyResumeDraft(storage, accountId) {
  try {
    if (!storage || typeof storage.removeItem !== "function" || typeof storage.getItem !== "function") return false;
    const key = resumeStorageKey(accountId);
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    return false;
  }
}

export function categoryStrategyCountdown({ expiresAt, now = new Date().toISOString() } = {}) {
  const end = new Date(iso(expiresAt)).getTime();
  const start = new Date(iso(now)).getTime();
  const seconds = Math.max(0, Math.ceil((end - start) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return Object.freeze({
    expired: seconds === 0,
    seconds,
    label: `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`,
  });
}

export function categoryStrategyPageModel({ detail, session = null, analysis = null, published = null,
  now = new Date().toISOString() } = {}) {
  const safeDetail = projectCategoryStrategyDetail(detail);
  const safeSession = nullable(session, projectCategoryStrategySession);
  const safeAnalysis = nullable(analysis, projectCategoryStrategyAnalysis);
  const safePublished = nullable(published, projectCategoryStrategyPublishedVersion);
  const countdown = safeSession ? categoryStrategyCountdown({ expiresAt: safeSession.expiresAt, now }) : null;
  const analysisIsCurrent = safeAnalysis !== null && safeDetail.status === "DRAFT_READY"
    && safeAnalysis.status === "DRAFT_READY" && safeAnalysis.draftVersion === safeDetail.draftVersion;
  return deepFreeze({
    detail: safeDetail, session: safeSession, analysis: safeAnalysis, published: safePublished, countdown,
    canCreateDraft: safeDetail.status === "PUBLISHED",
    canStartSampling: new Set(["COLLECTING", "SAMPLES_READY", "DRAFT_READY", "NEEDS_REVIEW"]).has(safeDetail.status),
    canAnalyze: safeDetail.sampleCount >= 5 && safeDetail.sampleCount <= 20
      && new Set(["SAMPLES_READY", "NEEDS_REVIEW"]).has(safeDetail.status),
    analysisIsCurrent,
    canPublish: analysisIsCurrent,
    impactText: "发布后供当前账号内命中此精确类目的商品共用，不影响其他账号。",
  });
}
