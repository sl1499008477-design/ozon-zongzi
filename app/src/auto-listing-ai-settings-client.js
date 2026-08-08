import { apiRequest } from "./client-transport.js";

const BASE = "/admin/auto-listing/ai-settings";
const MAX_BYTES = 64 * 1024;
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
  "createdAt", "duplicate"];
const CATALOG_KEYS = ["id", "accountId", "connectionId", "connectionVersion", "syncTaskId", "catalog", "catalogHash",
  "capabilityResult", "capabilityHash", "rollbackEvidenceIdentity", "testedAt", "createdAt"];
const CAPABILITY_KEYS = ["profileId", "configVersion", "outcome", "features", "latencyMs", "models", "checkedAt", "errorCode", "enabled"];
const ACTION_KEYS = ["canCreateConnection", "syncableConnectionIds", "testableProfileIds", "publishableProfileIds", "rollbackProfileIds"];
const CONNECTION_STATUS = new Set(["PENDING", "VALIDATED", "ACTIVE", "RETIRED"]);
const TASK_STATUS = new Set(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "DEAD"]);
const CAPABILITY_OUTCOME = new Set(["PASSED", "FAILED", "NOT_TESTED", "MISSING", "UNKNOWN", "STALE"]);
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
  "REQUEST_ABORTED", "REQUEST_TIMEOUT", "RESPONSE_TOO_LARGE", "AI_SETTINGS_CLIENT_RESPONSE_INVALID", "AI_SETTINGS_CLIENT_REQUEST_INVALID"]);
const SAFE_ERROR_CODES = new Set(AI_SETTINGS_SAFE_ERROR_CODES);
const SAFE_ERROR_LABELS = Object.freeze({ AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED: "AI 模型设置暂时不可用",
  REQUEST_ABORTED: "请求已取消", REQUEST_TIMEOUT: "请求超时，请稍后重试", RESPONSE_TOO_LARGE: "服务响应过大，已拒绝处理",
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
  const result = text(value, 240);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(result)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  return result;
}

function modelId(value) {
  const result = text(value, 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u.test(result)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
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

function responseSize(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  return value;
}

function exactResponse(raw, keys) {
  const value = safeJson(raw);
  if (!plainRecord(value) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
  }
  return deepFreeze(responseSize(value));
}

function nullableText(value) {
  return value === null || typeof value === "string";
}

function isoTimestamp(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
}

function responseValidation(validate) {
  try { return validate(); } catch { throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID"); }
}

function validateConnection(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CONNECTION_KEYS);
    if (!id(value.id) || !id(value.accountId) || version(value.version) < 1 || !text(value.displayName, 200)
    || !text(value.baseUrl) || !text(value.fingerprint, 512) || !id(value.keyVersion) || !CONNECTION_STATUS.has(value.status)
    || version(value.statusVersion) < 1 || !isoTimestamp(value.validatedAt, true) || !isoTimestamp(value.activatedAt, true)
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
    || !TASK_STATUS.has(value.status) || version(value.statusVersion) < 1 || !Number.isSafeInteger(value.attemptCount)
    || !Number.isSafeInteger(value.maxAttempts) || !Number.isSafeInteger(value.leaseVersion) || !nullableText(value.availableAt)
    || !isoTimestamp(value.completedAt, true) || !nullableText(value.lastErrorCode) || !nullableText(value.lastErrorSafe)
      || !isoTimestamp(value.createdAt) || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateProfile(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, PROFILE_KEYS);
    if (!id(value.id) || !id(value.accountId) || !text(value.displayName, 200) || version(value.configVersion) < 1
    || !text(value.baseUrl) || value.textProtocol !== "SUB2API_RESPONSES"
    || !["SUB2API_RESPONSES_IMAGE_TOOL", "SUB2API_OPENAI_IMAGES"].includes(value.imageProtocol)
    || !modelId(value.textModel) || !modelId(value.imageModel) || typeof value.enabled !== "boolean" || !isoTimestamp(value.capabilityCheckedAt, true)
    || !nullableText(value.connectionId) || (value.connectionVersion !== null && (!Number.isSafeInteger(value.connectionVersion) || value.connectionVersion < 1))
    || ((value.connectionId === null) !== (value.connectionVersion === null))
      || !isoTimestamp(value.createdAt) || typeof value.duplicate !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateCapability(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CAPABILITY_KEYS);
    if (!id(value.profileId) || version(value.configVersion) < 1 || !CAPABILITY_OUTCOME.has(value.outcome)
    || !Array.isArray(value.features) || !Number.isFinite(value.latencyMs) && value.latencyMs !== null
    || !plainRecord(value.models) || !modelId(value.models.text) || !modelId(value.models.image) || !isoTimestamp(value.checkedAt)
      || !nullableText(value.errorCode) || typeof value.enabled !== "boolean") throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateActions(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, ACTION_KEYS);
    if (typeof value.canCreateConnection !== "boolean" || ACTION_KEYS.slice(1).some((key) => !Array.isArray(value[key]) || value[key].some((entry) => {
    try { id(entry); return false; } catch { return true; }
    }))) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return Object.freeze(value);
  });
}

function validateCatalog(raw) {
  return responseValidation(() => {
    const value = exactResponse(raw, CATALOG_KEYS);
    if (!id(value.id) || !id(value.accountId) || !id(value.connectionId) || version(value.connectionVersion) < 1
    || !id(value.syncTaskId) || !plainRecord(value.catalog) || !text(value.catalogHash, 128) || !text(value.capabilityHash, 128)
    || !nullableText(value.rollbackEvidenceIdentity) || !isoTimestamp(value.testedAt, true) || !isoTimestamp(value.createdAt)) {
      throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    }
    return Object.freeze(value);
  });
}

function unwrap(raw, validator) {
  const envelope = exactResponse(raw, ["ok", "data"]);
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
  const options = closed(rawOptions, [], { optional: ["signal", "timeoutMs"] });
  if (options.signal !== undefined && (!globalThis.AbortSignal || !(options.signal instanceof globalThis.AbortSignal))) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw invalid("AI_SETTINGS_CLIENT_REQUEST_INVALID");
  if (options.signal?.aborted) throw invalid("REQUEST_ABORTED");
  try { const raw = await apiRequest(BASE, { signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResponseBytes: MAX_BYTES }); return unwrap(raw, (data) => {
    const value = exactResponse(data, ["accountId", "activeConnection", "connections", "catalogs", "syncTasks", "profiles", "actions"]);
    if (!id(value.accountId) || (value.activeConnection !== null && !validateConnection(value.activeConnection))
      || !Array.isArray(value.connections) || !Array.isArray(value.catalogs) || !Array.isArray(value.syncTasks)
      || !Array.isArray(value.profiles)) throw invalid("AI_SETTINGS_CLIENT_RESPONSE_INVALID");
    return deepFreeze({ ...value, connections: value.connections.map(validateConnection), catalogs: value.catalogs.map(validateCatalog),
      syncTasks: value.syncTasks.map(validateTask), profiles: value.profiles.map(validateProfile), actions: validateActions(value.actions) });
  }); } catch (error) { throw safeRemoteError(error); }
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
