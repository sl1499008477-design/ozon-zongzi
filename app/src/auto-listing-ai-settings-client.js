import { apiRequest } from "./client-transport.js";

const BASE = "/admin/auto-listing/ai-settings";
const MAX_BYTES = 64 * 1024;
const MAX_CATALOG_BYTES = 1536 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SECRET_KEYS = new Set([
  "gatewayKey", "apiKey", "api_key", "secret", "encryptedSecret", "ciphertext", "iv", "authTag",
  "authorization", "leaseToken", "lease_token", "apiKeyEnvName", "api_key_env_name",
]);
const CONNECTION_KEYS = ["id", "accountId", "version", "displayName", "baseUrl", "fingerprint", "keyVersion",
  "status", "statusVersion", "validationResult", "validatedAt", "activatedAt", "retiredAt", "createdAt", "duplicate"];
const TASK_KEYS = ["id", "accountId", "connectionId", "connectionVersion", "syncPurpose", "targetConnectionStatusVersion",
  "status", "statusVersion", "attemptCount", "maxAttempts", "leaseVersion", "availableAt", "completedAt",
  "lastErrorCode", "lastErrorSafe", "createdAt", "duplicate"];
const PROFILE_KEYS = ["id", "accountId", "displayName", "configVersion", "baseUrl", "textProtocol", "imageProtocol",
  "textModel", "imageModel", "enabled", "capabilityResult", "capabilityCheckedAt", "connectionId", "connectionVersion",
  "activation", "createdAt", "duplicate"];
const CATALOG_KEYS = ["id", "accountId", "connectionId", "connectionVersion", "syncTaskId", "catalog", "catalogHash",
  "capabilityResult", "capabilityHash", "rollbackEvidenceIdentity", "testedAt", "createdAt"];
const CAPABILITY_KEYS = ["profileId", "configVersion", "outcome", "features", "latencyMs", "models", "checkedAt", "errorCode", "enabled"];
const ACTION_KEYS = ["canCreateConnection", "syncableConnectionIds", "profileCreatableCatalogIds",
  "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"];
const PAGINATION_KEYS = ["pageSize", "hasMore", "nextCursor"];
const CATALOG_SUMMARY_KEYS = ["schemaVersion", "connectionVersion", "syncedAt", "requestIdHash",
  "activeSelectionState", "activeSelection", "modelCount"];
const CONNECTION_STATUS = new Set(["PENDING", "VALIDATED", "ACTIVE", "RETIRED"]);
const TASK_STATUS = new Set(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "DEAD"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const PAID_FEATURES = new Set([
  "STRUCTURED_TEXT", "IMAGE_GENERATION", "IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP",
]);
const DECODE_FEATURES = new Set(["IMAGE_DECODE_PNG", "IMAGE_DECODE_JPEG", "IMAGE_DECODE_WEBP"]);
const PAID_ERROR_CODES = new Set([
  "AI_GATEWAY_CAPABILITY_FAILED", "AI_GATEWAY_PROFILE_INVALID", "AI_GATEWAY_PROFILE_DISABLED",
  "AI_GATEWAY_REQUEST_INVALID", "AI_GATEWAY_SECRET_MISSING", "AI_GATEWAY_PROTOCOL_UNSUPPORTED",
  "AI_GATEWAY_MODEL_MISMATCH", "AI_GATEWAY_INPUT_UNSUPPORTED", "GATEWAY_REDIRECT_BLOCKED",
  "GATEWAY_TIMEOUT", "GATEWAY_CANCELLED", "RETRYABLE_GATEWAY", "NON_RETRYABLE_AUTH",
  "NON_RETRYABLE_GATEWAY", "INVALID_GATEWAY_RESPONSE",
]);
const RECOMMENDATION_WARNINGS = new Set([
  "RECOMMENDATIONS_UNVERIFIED", "NO_TEXT_MODEL_CANDIDATE", "NO_IMAGE_MODEL_CANDIDATE",
]);
const TEXT_REASONS = Object.freeze({
  DECLARED_STRUCTURED_TEXT: 100, DECLARED_RESPONSES_PROTOCOL: 60, MODEL_ID_TEXT_HINT: 10,
});
const IMAGE_REASONS = Object.freeze({
  DECLARED_IMAGE_GENERATION: 100, DECLARED_REFERENCE_IMAGE: 40,
  DECLARED_TARGET_RESOLUTION: 20, MODEL_ID_IMAGE_HINT: 10,
});
const TEXT_RECOMMENDATION = Object.freeze({ reasons: TEXT_REASONS,
  declarations: Object.freeze([["structured_text", "DECLARED_STRUCTURED_TEXT"], ["responses_protocol", "DECLARED_RESPONSES_PROTOCOL"]]),
  hint: /(?:^|[-_.\/])(chat|claude|gpt|instruct|llama|mistral|qwen|text)(?:$|[-_.\/])/iu, hintReason: "MODEL_ID_TEXT_HINT",
  missingWarning: "NO_TEXT_MODEL_CANDIDATE" });
const IMAGE_RECOMMENDATION = Object.freeze({ reasons: IMAGE_REASONS,
  declarations: Object.freeze([["image_generation", "DECLARED_IMAGE_GENERATION"], ["image_edit", "DECLARED_REFERENCE_IMAGE"],
    ["target_resolution", "DECLARED_TARGET_RESOLUTION"]]),
  hint: /(?:^|[-_.\/])(dall-?e|flux|image|midjourney|sdxl|stable-diffusion)(?:$|[-_.\/])/iu,
  hintReason: "MODEL_ID_IMAGE_HINT", missingWarning: "NO_IMAGE_MODEL_CANDIDATE" });
const intentOwners = new Map();
export const AI_SETTINGS_SAFE_ERROR_CODES = Object.freeze(["AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED", "AUTO_LISTING_AI_SETTINGS_REQUEST_INVALID",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_FOUND", "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_SYNCABLE",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_VERSION_CONFLICT", "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_ACTIVE",
  "AUTO_LISTING_AI_SETTINGS_CONNECTION_NOT_VALIDATED", "AUTO_LISTING_AI_SETTINGS_CATALOG_NOT_FOUND",
  "AUTO_LISTING_AI_SETTINGS_MODEL_SELECTION_INVALID", "AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_AI_SETTINGS_COST_CONFIRMATION_REQUIRED", "AUTO_LISTING_AI_PROFILE_NOT_FOUND",
  "AUTO_LISTING_AI_PROFILE_CAPABILITY_REQUIRED", "AUTO_LISTING_AI_SETTINGS_BASE_URL_INVALID", "AUTO_LISTING_AI_SETTINGS_SYNC_ALREADY_RUNNABLE",
  "AUTO_LISTING_AI_SETTINGS_ROLLBACK_CAPABILITY_REQUIRED", "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT",
  "AUTO_LISTING_AI_PROFILE_CONNECTION_NOT_VALIDATED", "AUTO_LISTING_AI_PROFILE_ROLLBACK_NOT_READY", "AUTO_LISTING_AI_PROFILE_AMBIGUOUS",
  "AUTO_LISTING_AI_PROFILE_VERSION_CONFLICT", "AUTO_LISTING_AI_ADMIN_DATABASE_FAILED", "AI_GATEWAY_COST_CONFIRMATION_REQUIRED",
  "AUTO_LISTING_AI_ADMIN_CAPABILITY_SUBCALL_CONFLICT", "AUTO_LISTING_AI_ADMIN_LEGACY_CAPABILITY_QUARANTINED",
  "AUTO_LISTING_AI_SETTINGS_CAPABILITY_SUBCALL_CONFLICT", "AI_GATEWAY_PROFILE_NOT_FOUND", "AI_GATEWAY_PROFILE_VERSION_CONFLICT",
  "AI_GATEWAY_CAPABILITY_IN_PROGRESS", "AI_GATEWAY_CAPABILITY_REQUEST_INVALID", "AI_GATEWAY_CAPABILITY_RESULT_UNKNOWN", "PERMISSION_FORBIDDEN",
  "AUTO_LISTING_AI_SETTINGS_RESPONSE_TOO_LARGE", "REQUEST_ABORTED", "REQUEST_TIMEOUT", "RESPONSE_TOO_LARGE",
  "AI_SETTINGS_CLIENT_RESPONSE_INVALID", "AI_SETTINGS_CLIENT_REQUEST_INVALID"]);
const SAFE_ERROR_CODES = new Set(AI_SETTINGS_SAFE_ERROR_CODES);
const SAFE_ERROR_LABELS = Object.freeze({ AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED: "AI 模型设置暂时不可用",
  REQUEST_ABORTED: "请求已取消", REQUEST_TIMEOUT: "请求超时，请稍后重试", RESPONSE_TOO_LARGE: "服务响应过大，已拒绝处理",
  AUTO_LISTING_AI_SETTINGS_RESPONSE_TOO_LARGE: "模型设置数据超出安全读取范围，请联系管理员排查",
  PERMISSION_FORBIDDEN: "没有 AI 配置管理权限" });

function invalid(kind) {
  return Object.assign(new Error(kind), { code: kind });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function plainRecord(value) {
  try {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function closed(raw, keys, { optional = [] } = {}) {
  try {
    if (!plainRecord(raw)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
    const ownKeys = Reflect.ownKeys(raw);
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const allowed = new Set([...keys, ...optional]);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)
      || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))
      || keys.some((key) => !Object.hasOwn(descriptors, key))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
    return Object.fromEntries(ownKeys.map((key) => [key, descriptors[key].value]));
  } catch (error) {
    if (error?.code) throw error;
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
}

function text(value, maximum = 2048) {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > maximum) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return value.trim();
}

function id(value) {
  if (typeof value !== "string" || value !== value.trim() || value.includes("..")) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  const result = text(value, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(result)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return result;
}

function modelId(value) {
  if (typeof value !== "string" || value !== value.trim()) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  const result = text(value, 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u.test(result)
    || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return result;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_646) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return value;
}

function exactIntent(raw, { idempotency = true } = {}) {
  const result = closed(raw, idempotency ? ["idempotencyKey", "correlationId"] : ["correlationId"], { optional: ["intentId", "signal", "timeoutMs"] });
  if (result.signal !== undefined && (!globalThis.AbortSignal || !(result.signal instanceof globalThis.AbortSignal))) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  if (result.timeoutMs !== undefined && (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 120_000)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return Object.freeze({ ...(idempotency ? { idempotencyKey: id(result.idempotencyKey) } : {}), correlationId: id(result.correlationId), intentId: result.intentId === undefined ? "" : id(result.intentId), signal: result.signal, timeoutMs: result.timeoutMs ?? DEFAULT_TIMEOUT_MS });
}

function safeJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return value;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => safeJson(entry, seen));
    if (!plainRecord(value)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || SECRET_KEYS.has(key) || ["__proto__", "constructor", "prototype"].includes(key)
        || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value")) {
        throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
      }
      result[key] = safeJson(descriptors[key].value, seen);
    }
    return result;
  } catch (error) {
    if (error?.code) throw error;
    throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  } finally {
    seen.delete(value);
  }
}

function responseSize(value, maximum = MAX_BYTES) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
  if (new TextEncoder().encode(serialized).byteLength > maximum) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  return value;
}

function exactResponse(raw, keys, maximum = MAX_BYTES) {
  const value = safeJson(raw);
  if (!plainRecord(value) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  }
  return deepFreeze(responseSize(value, maximum));
}

function nullableText(value) {
  return value === null || typeof value === "string";
}

function isoTimestamp(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
}

function exactRecord(value, keys) {
  return plainRecord(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function paidCapabilityResult(value) {
  const keys = ["outcome", "features", "latencyMs", "models", "checkedAt", "errorCode"];
  if (!exactRecord(value, keys) || !["PASSED", "FAILED"].includes(value.outcome)
    || !Array.isArray(value.features) || new Set(value.features).size !== value.features.length
    || value.features.some((feature) => !PAID_FEATURES.has(feature))
    || !exactRecord(value.models, ["text", "image"]) || !modelId(value.models.text) || !modelId(value.models.image)
    || !isoTimestamp(value.checkedAt)) return false;
  if (value.outcome === "PASSED") {
    return value.features.length === 3 && value.features.includes("STRUCTURED_TEXT")
      && value.features.includes("IMAGE_GENERATION") && value.features.filter((feature) => DECODE_FEATURES.has(feature)).length === 1
      && Number.isInteger(value.latencyMs) && value.latencyMs >= 0 && value.errorCode === null;
  }
  return value.features.length === 0 && value.latencyMs === null && PAID_ERROR_CODES.has(value.errorCode);
}

function catalogCapabilityResult(value) {
  return exactRecord(value, ["outcome", "checkedAt", "text", "image"])
    && value.outcome === "NOT_TESTED" && isoTimestamp(value.checkedAt)
    && value.text === false && value.image === false;
}

function rollbackCapabilityResult(value, connectionId, connectionVersion) {
  return exactRecord(value, ["schemaVersion", "outcome", "checkedAt", "connectionId", "connectionVersion", "checks"])
    && value.schemaVersion === "AI_GATEWAY_ROLLBACK_TEST_RESULT_V1" && value.outcome === "PASSED"
    && isoTimestamp(value.checkedAt) && id(value.connectionId) === connectionId
    && value.connectionVersion === connectionVersion
    && exactRecord(value.checks, ["authentication", "modelsEndpoint"])
    && value.checks.authentication === true && value.checks.modelsEndpoint === true;
}

function profileCapabilityResult(value) {
  return exactRecord(value, []) || catalogCapabilityResult(value) || paidCapabilityResult(value);
}

function profileRollbackConnectionValidationResult(value) {
  return paidCapabilityResult(value) && value.outcome === "PASSED";
}

function connectionValidationResult(value, connectionId, connectionVersion) {
  if (value === null) return true;
  if (rollbackCapabilityResult(value, connectionId, connectionVersion)) return true;
  if (profileRollbackConnectionValidationResult(value)) return true;
  if (!exactRecord(value, ["schemaVersion", "outcome", "checkedAt", "checks", "catalogId", "catalogHash"])
    || value.schemaVersion !== "AI_GATEWAY_CONNECTION_TEST_V1" || value.outcome !== "PASSED"
    || !isoTimestamp(value.checkedAt) || !exactRecord(value.checks, ["authentication", "modelsEndpoint"])) return false;
  return value.checks.authentication === true && value.checks.modelsEndpoint === true
    && Boolean(id(value.catalogId)) && SHA256.test(value.catalogHash);
}

function recommendationCandidate(value, expected, reasons) {
  if (!exactRecord(value, ["modelId", "score", "confidence", "verified", "reasonCodes"])
    || !modelId(value.modelId) || !Number.isSafeInteger(value.score) || value.score < 1
    || !["DECLARED", "LOW"].includes(value.confidence) || value.verified !== false
    || !Array.isArray(value.reasonCodes) || value.reasonCodes.length === 0
    || new Set(value.reasonCodes).size !== value.reasonCodes.length
    || value.reasonCodes.some((reason) => !Object.hasOwn(reasons, reason))) return false;
  const expectedScore = value.reasonCodes.reduce((sum, reason) => sum + reasons[reason], 0);
  const hint = Object.keys(reasons).find((reason) => reason.startsWith("MODEL_ID_"));
  return value.score === expectedScore && (value.confidence === "LOW"
    ? value.reasonCodes.length === 1 && value.reasonCodes[0] === hint
    : value.reasonCodes.every((reason) => reason.startsWith("DECLARED_")))
    && Boolean(expected) && value.modelId === expected.modelId && value.score === expected.score
    && value.confidence === expected.confidence && value.reasonCodes.length === expected.reasonCodes.length
    && value.reasonCodes.every((reason, index) => reason === expected.reasonCodes[index]);
}

function expectedRecommendationCandidate(model, specification) {
  const capabilities = Array.isArray(model.metadata.capabilities)
    ? new Set(model.metadata.capabilities.filter((value) => typeof value === "string")) : new Set();
  const incompatible = Array.isArray(model.metadata.incompatibleCapabilities)
    ? new Set(model.metadata.incompatibleCapabilities.filter((value) => typeof value === "string")) : new Set();
  if (specification.declarations.some(([capability]) => incompatible.has(capability))) return null;
  const reasonCodes = specification.declarations
    .filter(([capability]) => capabilities.has(capability)).map(([, reason]) => reason);
  if (reasonCodes.length === 0 && capabilities.size === 0 && specification.hint.test(model.id)) {
    reasonCodes.push(specification.hintReason);
  }
  if (reasonCodes.length === 0) return null;
  return { modelId: model.id, score: reasonCodes.reduce((sum, reason) => sum + specification.reasons[reason], 0),
    confidence: reasonCodes[0].startsWith("DECLARED_") ? "DECLARED" : "LOW", reasonCodes };
}

function expectedCandidates(models, specification) {
  return models.map((model) => expectedRecommendationCandidate(model, specification)).filter(Boolean)
    .sort((left, right) => right.score - left.score
      || (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0)).slice(0, 50);
}

function recommendationResult(value, models) {
  if (!exactRecord(value, ["ruleVersion", "verified", "warnings", "textCandidates", "imageCandidates"])
    || value.ruleVersion !== "AUTO_LISTING_MODEL_RECOMMENDATION_V1" || value.verified !== false
    || !Array.isArray(value.warnings) || value.warnings[0] !== "RECOMMENDATIONS_UNVERIFIED"
    || new Set(value.warnings).size !== value.warnings.length
    || value.warnings.some((warning) => !RECOMMENDATION_WARNINGS.has(warning))) return false;
  const expectedWarnings = ["RECOMMENDATIONS_UNVERIFIED"];
  for (const [key, specification] of [
    ["textCandidates", TEXT_RECOMMENDATION],
    ["imageCandidates", IMAGE_RECOMMENDATION],
  ]) {
    const candidates = value[key];
    const expected = expectedCandidates(models, specification);
    if (!Array.isArray(candidates) || candidates.length > 50 || !uniqueIds(candidates, "modelId")
      || candidates.length !== expected.length
      || candidates.some((candidate, index) => !recommendationCandidate(candidate, expected[index], specification.reasons))) return false;
    if (candidates.length === 0) expectedWarnings.push(specification.missingWarning);
  }
  return value.warnings.length === expectedWarnings.length
    && value.warnings.every((warning, index) => warning === expectedWarnings[index]);
}

function catalogEnvelope(value) {
  const keys = ["schemaVersion", "connectionVersion", "syncedAt", "requestIdHash", "activeSelectionState", "activeSelection", "models", "recommendation"];
  if (!exactRecord(value, keys) || value.schemaVersion !== "AUTO_LISTING_AI_MODEL_CATALOG_V1"
    || !Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1
    || !isoTimestamp(value.syncedAt) || !SHA256.test(value.requestIdHash)
    || !["AVAILABLE", "MISSING", "NOT_SELECTED"].includes(value.activeSelectionState)
    || !Array.isArray(value.models) || value.models.length > 2_000) return false;
  const modelIds = new Set();
  for (const [index, model] of value.models.entries()) {
    if (!exactRecord(model, ["id", "ownedBy", "metadata"]) || !modelId(model.id) || modelIds.has(model.id)
      || (index > 0 && value.models[index - 1].id >= model.id)
      || typeof model.ownedBy !== "string" || model.ownedBy !== model.ownedBy.trim()
      || model.ownedBy.length > 200 || !plainRecord(model.metadata)) return false;
    modelIds.add(model.id);
  }
  if (value.activeSelectionState === "NOT_SELECTED") {
    if (value.activeSelection !== null) return false;
  } else {
    const selection = value.activeSelection;
    if (!exactRecord(selection, ["profileId", "configVersion", "textModel", "imageModel"])
      || !id(selection.profileId) || !Number.isSafeInteger(selection.configVersion) || selection.configVersion < 1
      || !modelId(selection.textModel) || !modelId(selection.imageModel)) return false;
    const available = modelIds.has(selection.textModel) && modelIds.has(selection.imageModel);
    if (available !== (value.activeSelectionState === "AVAILABLE")) return false;
  }
  return recommendationResult(value.recommendation, value.models);
}

function rollbackCatalogEnvelope(value) {
  return exactRecord(value, ["models"]) && Array.isArray(value.models) && value.models.length === 0;
}

function catalogSummaryEnvelope(value) {
  if (!exactRecord(value, CATALOG_SUMMARY_KEYS)
    || value.schemaVersion !== "AUTO_LISTING_AI_MODEL_CATALOG_V1"
    || !Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1
    || !isoTimestamp(value.syncedAt) || !SHA256.test(value.requestIdHash)
    || !["AVAILABLE", "MISSING", "NOT_SELECTED"].includes(value.activeSelectionState)
    || !Number.isSafeInteger(value.modelCount) || value.modelCount < 0 || value.modelCount > 2_000) return false;
  if (value.activeSelectionState === "NOT_SELECTED") return value.activeSelection === null;
  const selection = value.activeSelection;
  return exactRecord(selection, ["profileId", "configVersion", "textModel", "imageModel"])
    && Boolean(id(selection.profileId)) && Number.isSafeInteger(selection.configVersion) && selection.configVersion > 0
    && Boolean(modelId(selection.textModel)) && Boolean(modelId(selection.imageModel));
}

function uniqueIds(values, field = "id") {
  if (!Array.isArray(values)) return false;
  const seen = new Set();
  return values.every((value) => typeof value?.[field] === "string" && !seen.has(value[field]) && (seen.add(value[field]), true));
}

function cursor(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 1024
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return value;
}

function validatePage(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, PAGINATION_KEYS);
    if (!Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 10
      || typeof value.hasMore !== "boolean" || (value.hasMore !== (value.nextCursor !== null))
      || (value.nextCursor !== null && cursor(value.nextCursor) !== value.nextCursor)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return value;
  });
}

function validatePagination(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, ["connections", "profiles"]);
    return Object.freeze({ connections: validatePage(value.connections), profiles: validatePage(value.profiles) });
  });
}

function responseValidation(validate) {
  try { return validate(); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
}

function validateConnection(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CONNECTION_KEYS);
    if (!id(value.id) || !id(value.accountId) || version(value.version) < 1 || !text(value.displayName, 200)
    || !text(value.baseUrl) || !text(value.fingerprint, 512) || !id(value.keyVersion) || !CONNECTION_STATUS.has(value.status)
    || version(value.statusVersion) < 1 || !connectionValidationResult(value.validationResult, value.id, value.version)
    || !isoTimestamp(value.validatedAt, true) || !isoTimestamp(value.activatedAt, true)
    || !isoTimestamp(value.retiredAt, true) || !isoTimestamp(value.createdAt) || typeof value.duplicate !== "boolean") {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function validateTask(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, TASK_KEYS);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
    || !["CATALOG_SYNC", "ROLLBACK_CAPABILITY"].includes(value.syncPurpose) || version(value.targetConnectionStatusVersion) < 1
    || !TASK_STATUS.has(value.status) || version(value.statusVersion) < 1 || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0
    || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1 || value.attemptCount > value.maxAttempts
    || !Number.isSafeInteger(value.leaseVersion) || value.leaseVersion < 0 || !isoTimestamp(value.availableAt)
    || !isoTimestamp(value.completedAt, true) || !nullableText(value.lastErrorCode) || !nullableText(value.lastErrorSafe)
      || !isoTimestamp(value.createdAt) || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function profileActivation(value) {
  if (value === null) return true;
  return exactRecord(value, ["kind", "occurredAt", "actorId"])
    && ["PUBLISH", "ROLLBACK"].includes(value.kind)
    && isoTimestamp(value.occurredAt) && Boolean(id(value.actorId));
}

function validateProfile(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, PROFILE_KEYS);
    if (!id(value.id) || !id(value.accountId) || !text(value.displayName, 200) || version(value.configVersion) < 1
    || !text(value.baseUrl) || value.textProtocol !== "SUB2API_RESPONSES"
    || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(value.imageProtocol)
    || !modelId(value.textModel) || !modelId(value.imageModel) || typeof value.enabled !== "boolean" || !profileCapabilityResult(value.capabilityResult)
    || !isoTimestamp(value.capabilityCheckedAt, true)
    || (!exactRecord(value.capabilityResult, []) && value.capabilityCheckedAt !== value.capabilityResult.checkedAt)
    || (exactRecord(value.capabilityResult, []) && value.capabilityCheckedAt !== null)
    || (value.capabilityResult.outcome === "FAILED" && value.enabled !== false)
    || (value.connectionId !== null && !id(value.connectionId)) || (value.connectionVersion !== null && (!Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1))
    || ((value.connectionId === null) !== (value.connectionVersion === null))
      || !profileActivation(value.activation) || !isoTimestamp(value.createdAt)
      || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateCapability(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CAPABILITY_KEYS);
    const paid = { outcome: value.outcome, features: value.features, latencyMs: value.latencyMs,
      models: value.models, checkedAt: value.checkedAt, errorCode: value.errorCode };
    if (!id(value.profileId) || version(value.configVersion) < 1 || !paidCapabilityResult(paid)
      || typeof value.enabled !== "boolean" || (value.outcome === "FAILED" && value.enabled !== false)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function validateActions(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, ACTION_KEYS);
    if (typeof value.canCreateConnection !== "boolean" || ACTION_KEYS.slice(1).some((key) => !Array.isArray(value[key])
      || new Set(value[key]).size !== value[key].length
      || value[key].some((entry) => { try { id(entry); return false; } catch { return true; } }))) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function validateCatalog(raw, maximum = MAX_BYTES) {
  return responseValidation(() => {
    const value = exactResponse(raw, CATALOG_KEYS, maximum);
    const catalogSyncEvidence = catalogEnvelope(value.catalog)
      && value.catalog.connectionVersion === value.connectionVersion
      && catalogCapabilityResult(value.capabilityResult)
      && value.catalog.syncedAt === value.capabilityResult.checkedAt
      && value.rollbackEvidenceIdentity === null;
    const rollbackEvidence = rollbackCatalogEnvelope(value.catalog)
      && rollbackCapabilityResult(value.capabilityResult, value.connectionId, value.connectionVersion)
      && SHA256.test(value.rollbackEvidenceIdentity);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
    || !id(value.syncTaskId) || !SHA256.test(value.catalogHash) || !SHA256.test(value.capabilityHash)
    || (!catalogSyncEvidence && !rollbackEvidence) || value.testedAt !== value.capabilityResult.checkedAt
    || !isoTimestamp(value.testedAt) || !isoTimestamp(value.createdAt)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function validateCatalogSummary(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CATALOG_KEYS);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
      || !id(value.syncTaskId) || !catalogSummaryEnvelope(value.catalog)
      || value.catalog.connectionVersion !== value.connectionVersion
      || !catalogCapabilityResult(value.capabilityResult)
      || value.catalog.syncedAt !== value.capabilityResult.checkedAt
      || !SHA256.test(value.catalogHash) || !SHA256.test(value.capabilityHash)
      || value.rollbackEvidenceIdentity !== null || value.testedAt !== value.capabilityResult.checkedAt
      || !isoTimestamp(value.testedAt) || !isoTimestamp(value.createdAt)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function unwrap(raw, validator, maximum = MAX_BYTES) {
  const envelope = exactResponse(raw, ["ok", "data"], maximum);
  if (envelope.ok !== true) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  return validator(envelope.data);
}

function serialize(body) {
  let serialized;
  try { serialized = JSON.stringify(body); } catch { throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return serialized;
}

function safeRemoteError(error) {
  try { if (error?.body) safeJson(error.body); } catch { return invalid("AI_SETTINGS_CLIENT_REQUEST_FAILED"); }
  const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "AI_SETTINGS_CLIENT_REQUEST_FAILED";
  return Object.assign(new Error(SAFE_ERROR_LABELS[code] || "AI 模型设置请求未完成"), { code });
}

async function request(path, body, signal, timeoutMs, validator) {
  if (signal?.aborted) throw invalid("REQUEST_ABORTED");
  try {
    const raw = await apiRequest(path, { method: "POST", serializedBody: serialize(body), maxSerializedBodyBytes: MAX_BYTES,
      maxResponseBytes: MAX_BYTES, headers: { "X-Client-Ai-Settings": "1" }, signal, timeoutMs });
    return unwrap(raw, validator);
  } catch (error) { throw safeRemoteError(error); }
}

function connectionInput(raw) {
  const value = closed(raw, ["displayName", "baseUrl", "gatewayKey"], { optional: ["gatewayKeyInput"] });
  if (value.gatewayKeyInput !== undefined && (!plainRecord(value.gatewayKeyInput) || Object.keys(value.gatewayKeyInput).length !== 1
    || !Object.hasOwn(value.gatewayKeyInput, "value") || typeof value.gatewayKeyInput.value !== "string")) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  return { displayName: text(value.displayName, 200), baseUrl: text(value.baseUrl), gatewayKey: text(value.gatewayKey, 16_384), gatewayKeyInput: value.gatewayKeyInput };
}

function randomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `intent${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function storageKey(input) {
  return `ozon-ai-settings:connection:${encodeURIComponent(input.displayName)}:${encodeURIComponent(input.baseUrl)}`;
}

export function createAiSettingsIntentStore(storage = globalThis.sessionStorage) {
  if (!storage || ["getItem", "setItem", "removeItem"].some((method) => typeof storage[method] !== "function")) {
    throw new TypeError("AI settings intent storage is required");
  }
  function read(input) {
    const key = storageKey(input);
    let saved = null;
    try { saved = JSON.parse(storage.getItem(key) || "null"); } catch { storage.removeItem(key); }
    if (!plainRecord(saved) || Reflect.ownKeys(saved).length !== 3 || typeof saved.idempotencyKey !== "string" || typeof saved.correlationId !== "string" || typeof saved.intentId !== "string") {
      saved = { intentId: randomId(), idempotencyKey: randomId(), correlationId: randomId() };
      storage.setItem(key, JSON.stringify(saved));
    }
    const serialized = JSON.stringify(saved);
    const intent = Object.freeze({ intentId: id(saved.intentId), idempotencyKey: id(saved.idempotencyKey), correlationId: id(saved.correlationId) });
    intentOwners.set(intent.intentId, { storage, key, serialized });
    return intent;
  }
  return Object.freeze({ connectionIntent(raw) {
    const value = closed(raw, ["displayName", "baseUrl"]);
    return read({ displayName: text(value.displayName, 200), baseUrl: text(value.baseUrl) });
  }, commandIntent(raw) {
    const value = closed(raw, ["operation", "targetId"]);
    const operation = ["sync", "profile", "publish", "rollback", "test"].includes(value.operation) ? value.operation : "";
    if (!operation) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
    return read({ displayName: operation, baseUrl: id(value.targetId) });
  } });
}

function settleIntent(rawIntent, error = null) {
  if (!error || ["AUTO_LISTING_AI_SETTINGS_IDEMPOTENCY_CONFLICT", "AUTO_LISTING_AI_ADMIN_IDEMPOTENCY_CONFLICT"].includes(error.code)) {
    const intentId = typeof rawIntent?.intentId === "string" ? rawIntent.intentId : "";
    const owner = intentOwners.get(intentId);
    if (owner) {
      if (owner.storage.getItem(owner.key) === owner.serialized) owner.storage.removeItem(owner.key);
      intentOwners.delete(intentId);
    }
  }
}

export async function loadAiSettings(rawOptions = {}) {
  const options = closed(rawOptions, [], { optional: ["signal", "timeoutMs", "connectionCursor", "profileCursor"] });
  if (options.signal !== undefined && (!globalThis.AbortSignal || !(options.signal instanceof globalThis.AbortSignal))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  const connectionCursor = options.connectionCursor === undefined || options.connectionCursor === null
    ? null : cursor(options.connectionCursor);
  const profileCursor = options.profileCursor === undefined || options.profileCursor === null
    ? null : cursor(options.profileCursor);
  if (options.signal?.aborted) throw invalid("REQUEST_ABORTED");
  const query = new URLSearchParams();
  if (connectionCursor !== null) query.set("connectionCursor", connectionCursor);
  if (profileCursor !== null) query.set("profileCursor", profileCursor);
  const path = query.size ? `${BASE}?${query.toString()}` : BASE;
  try { const raw = await apiRequest(path, { signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResponseBytes: MAX_BYTES }); return unwrap(raw, (data) => {
    const value = exactResponse(data, ["accountId", "activeConnection", "activeProfile", "connections", "catalogs", "syncTasks", "profiles", "pagination", "actions"]);
    if (!id(value.accountId) || (value.activeConnection !== null && !validateConnection(value.activeConnection))
      || (value.activeProfile !== null && !validateProfile(value.activeProfile))
      || !Array.isArray(value.connections) || !Array.isArray(value.catalogs) || !Array.isArray(value.syncTasks)
      || !Array.isArray(value.profiles) || !uniqueIds(value.connections) || !uniqueIds(value.catalogs) || !uniqueIds(value.syncTasks) || !uniqueIds(value.profiles)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return deepFreeze({ ...value, connections: value.connections.map(validateConnection), catalogs: value.catalogs.map(validateCatalogSummary),
      syncTasks: value.syncTasks.map(validateTask), profiles: value.profiles.map(validateProfile),
      pagination: validatePagination(value.pagination), actions: validateActions(value.actions) });
  }); } catch (error) { throw safeRemoteError(error); }
}

export async function loadAiSettingsCatalog(rawCatalogId, rawOptions = {}) {
  const catalogId = id(rawCatalogId);
  const options = closed(rawOptions, [], { optional: ["signal", "timeoutMs"] });
  if (options.signal !== undefined && (!globalThis.AbortSignal || !(options.signal instanceof globalThis.AbortSignal))) {
    throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (options.signal?.aborted) throw invalid("REQUEST_ABORTED");
  try {
    const raw = await apiRequest(`${BASE}/catalogs/${encodeURIComponent(catalogId)}`, {
      signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: MAX_CATALOG_BYTES,
    });
    return unwrap(raw, (data) => {
      const value = exactResponse(data, ["accountId", "catalog", "actions"], MAX_CATALOG_BYTES);
      const catalog = validateCatalog(value.catalog, MAX_CATALOG_BYTES);
      if (!id(value.accountId) || catalog.accountId !== value.accountId
        || !exactRecord(value.actions, ["canCreateProfile"])
        || typeof value.actions.canCreateProfile !== "boolean") {
        throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
      }
      return deepFreeze({ accountId: value.accountId, catalog, actions: value.actions });
    }, MAX_CATALOG_BYTES);
  } catch (error) { throw safeRemoteError(error); }
}

export function createLatestAiSettingsLoader(operation) {
  if (typeof operation !== "function") throw new TypeError("AI settings latest loader operation is required");
  let generation = 0;
  return Object.freeze({
    async run(...args) {
      const current = ++generation;
      try {
        const value = await operation(...args);
        return current === generation ? { accepted: true, value } : { accepted: false, value: null };
      } catch (error) {
        if (current !== generation) return { accepted: false, value: null };
        throw error;
      }
    },
    invalidate() { generation += 1; },
  });
}

export async function createGatewayConnection(raw, rawIntent) {
  const input = connectionInput(raw); const intent = exactIntent(rawIntent);
  try {
    const result = await request(`${BASE}/connections`, { idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId,
      displayName: input.displayName, baseUrl: input.baseUrl, gatewayKey: input.gatewayKey }, intent.signal, intent.timeoutMs, validateConnection);
    if (input.gatewayKeyInput) input.gatewayKeyInput.value = "";
    settleIntent(rawIntent);
    return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function requestModelSync(raw, rawIntent) {
  const input = closed(raw, ["connectionId", "connectionVersion"]); const intent = exactIntent(rawIntent);
  try { const result = await request(`${BASE}/connections/${encodeURIComponent(id(input.connectionId))}/sync`, { connectionVersion: version(input.connectionVersion),
    idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, intent.timeoutMs, validateTask); settleIntent(rawIntent); return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function createModelProfile(raw, rawIntent) {
  const input = closed(raw, ["connectionId", "connectionVersion", "catalogId", "displayName", "textModel", "imageModel", "textProtocol", "imageProtocol"]); const intent = exactIntent(rawIntent);
  if (input.textProtocol !== "SUB2API_RESPONSES" || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(input.imageProtocol)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  try { const result = await request(`${BASE}/profiles`, { connectionId: id(input.connectionId), connectionVersion: version(input.connectionVersion), catalogId: id(input.catalogId),
    displayName: text(input.displayName, 200), textModel: modelId(input.textModel), imageModel: modelId(input.imageModel), textProtocol: input.textProtocol,
    imageProtocol: input.imageProtocol, idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, intent.timeoutMs, validateProfile); settleIntent(rawIntent); return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function testModelProfile(raw, rawIntent = null) {
  const input = closed(raw, rawIntent ? ["profileId", "configVersion", "costConfirmed"] : ["profileId", "configVersion", "costConfirmed", "correlationId"], { optional: ["signal", "timeoutMs"] });
  const owned = rawIntent ? exactIntent(rawIntent) : null;
  const intent = Object.freeze({ correlationId: owned?.correlationId ?? id(input.correlationId), signal: input.signal ?? owned?.signal, timeoutMs: input.timeoutMs ?? owned?.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  if (intent.signal !== undefined && (!globalThis.AbortSignal || !(intent.signal instanceof globalThis.AbortSignal))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (intent.timeoutMs !== undefined && (!Number.isSafeInteger(intent.timeoutMs) || intent.timeoutMs < 1 || intent.timeoutMs > 120_000)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (input.costConfirmed !== true) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  try { const result = await request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/test`, { configVersion: version(input.configVersion), correlationId: intent.correlationId, costConfirmed: true }, intent.signal, intent.timeoutMs, validateCapability); settleIntent(rawIntent); return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function publishModelProfile(raw, rawIntent) {
  const input = closed(raw, ["profileId", "configVersion"]); const intent = exactIntent(rawIntent);
  try { const result = await request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/publish`, { configVersion: version(input.configVersion), idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId }, intent.signal, intent.timeoutMs, validateProfile); settleIntent(rawIntent); return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function rollbackModelProfile(raw, rawIntent) {
  const input = closed(raw, ["profileId", "configVersion", "costConfirmed"]); const intent = exactIntent(rawIntent);
  if (input.costConfirmed !== true) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  try { const result = await request(`${BASE}/profiles/${encodeURIComponent(id(input.profileId))}/rollback`, { configVersion: version(input.configVersion), idempotencyKey: intent.idempotencyKey, correlationId: intent.correlationId, costConfirmed: true }, intent.signal, intent.timeoutMs, validateProfile); settleIntent(rawIntent); return result;
  } catch (error) { settleIntent(rawIntent, error); throw error; }
}

export async function pollAiSettingsUntil(predicate, { signal, timeoutMs } = {}) {
  if (typeof predicate !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || (signal !== undefined && (!globalThis.AbortSignal || !(signal instanceof globalThis.AbortSignal)))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) throw invalid("REQUEST_ABORTED");
    if (Date.now() >= deadline) throw invalid("AI_SETTINGS_CLIENT_POLL_TIMEOUT");
    const current = await loadAiSettings({ signal, timeoutMs: Math.max(1, deadline - Date.now()) });
    if (Date.now() >= deadline) throw invalid("AI_SETTINGS_CLIENT_POLL_TIMEOUT");
    if (predicate(current) === true) return current;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw invalid("AI_SETTINGS_CLIENT_POLL_TIMEOUT");
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(invalid("REQUEST_ABORTED")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.min(250, remaining));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
