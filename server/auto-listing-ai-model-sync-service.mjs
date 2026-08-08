import crypto from "node:crypto";

import { recommendAutoListingModels } from "./auto-listing-ai-model-recommendation.mjs";

const FACTORY_KEYS = new Set([
  "clock", "gateway", "recommendModels", "repository", "timeoutMs", "workerId",
]);
const COMMAND_KEYS = new Set([
  "accountId", "attemptCount", "connectionId", "connectionVersion", "correlationId",
  "leaseExpiresAt", "leaseToken", "leaseVersion", "maxAttempts", "syncPurpose",
  "targetConnectionStatusVersion", "taskId",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,299}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 45_000, 135_000]);
const RETRYABLE_CODES = new Set([
  "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED",
  "GATEWAY_TIMEOUT",
  "RETRYABLE_GATEWAY",
  "SUB2API_GATEWAY_DNS_FAILED",
]);
const AUTH_CODES = new Set(["AI_GATEWAY_SECRET_MISSING", "NON_RETRYABLE_AUTH"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function serviceError(code, retryable = false) {
  const error = new Error("AI 模型目录同步暂时不可用");
  error.code = code;
  error.status = retryable ? 503 : 422;
  error.retryable = retryable;
  return error;
}

function plainRecord(value) {
  try {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch { return false; }
}

function dataProperties(value, allowed, code) {
  if (!plainRecord(value)) throw serviceError(code);
  let keys;
  let descriptors;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw serviceError(code); }
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || descriptors[key]?.enumerable !== true || !Object.hasOwn(descriptors[key], "value"))) {
    throw serviceError(code);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function id(value, code = "AUTO_LISTING_AI_MODEL_SYNC_COMMAND_INVALID") {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_ID.test(value)) throw serviceError(code);
  return value;
}

function positiveInteger(value, maximum = 2_147_483_646) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw serviceError("AUTO_LISTING_AI_MODEL_SYNC_COMMAND_INVALID");
  }
  return value;
}

function timestamp(value, code) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw serviceError(code);
  return new Date(milliseconds).toISOString();
}

function ownValue(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch { return undefined; }
}

function safeCode(error, fallback = "AUTO_LISTING_AI_MODEL_SYNC_GATEWAY_FAILED") {
  const code = ownValue(error, "code");
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,119}$/u.test(code) ? code : fallback;
}

function retryable(error, code) {
  return RETRYABLE_CODES.has(code) || ownValue(error, "retryable") === true;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw serviceError("INVALID_GATEWAY_RESPONSE");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw serviceError("INVALID_GATEWAY_RESPONSE");
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
    throw serviceError("INVALID_GATEWAY_RESPONSE");
  }
  const result = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (DANGEROUS_KEYS.has(key) || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")) throw serviceError("INVALID_GATEWAY_RESPONSE");
    result[key] = canonicalJson(descriptor.value);
  }
  return result;
}

function normalizeModels(result) {
  if (!plainRecord(result)) throw serviceError("INVALID_GATEWAY_RESPONSE");
  const requestId = ownValue(result, "requestId");
  const source = ownValue(result, "models");
  if (typeof requestId !== "string" || (requestId !== "" && !REQUEST_ID.test(requestId))
    || !Array.isArray(source) || source.length > 2_000) throw serviceError("INVALID_GATEWAY_RESPONSE");
  const seen = new Set();
  const models = source.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw serviceError("INVALID_GATEWAY_RESPONSE");
    const modelId = ownValue(raw, "id");
    const ownedBy = ownValue(raw, "ownedBy");
    const metadata = ownValue(raw, "metadata");
    if (typeof modelId !== "string" || modelId !== modelId.trim() || !MODEL_ID.test(modelId)
      || modelId.split("/").some((part) => !part || part === "." || part === "..")
      || typeof ownedBy !== "string" || ownedBy !== ownedBy.trim() || ownedBy.length > 200
      || seen.has(modelId)) throw serviceError("INVALID_GATEWAY_RESPONSE");
    seen.add(modelId);
    const safeMetadata = canonicalJson(metadata);
    if (!plainRecord(safeMetadata)) throw serviceError("INVALID_GATEWAY_RESPONSE");
    return { id: modelId, ownedBy, metadata: safeMetadata };
  });
  models.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { requestId, models };
}

function commandInput(raw) {
  const input = dataProperties(raw, COMMAND_KEYS, "AUTO_LISTING_AI_MODEL_SYNC_COMMAND_INVALID");
  const attemptCount = positiveInteger(input.attemptCount, 20);
  const maxAttempts = positiveInteger(input.maxAttempts, 20);
  if (attemptCount > maxAttempts || input.syncPurpose !== "CATALOG_SYNC") {
    throw serviceError("AUTO_LISTING_AI_MODEL_SYNC_COMMAND_INVALID");
  }
  return {
    accountId: id(input.accountId),
    connectionId: id(input.connectionId),
    connectionVersion: positiveInteger(input.connectionVersion),
    syncPurpose: "CATALOG_SYNC",
    targetConnectionStatusVersion: positiveInteger(input.targetConnectionStatusVersion),
    taskId: id(input.taskId),
    attemptCount,
    maxAttempts,
    leaseVersion: positiveInteger(input.leaseVersion),
    leaseToken: id(input.leaseToken),
    leaseExpiresAt: timestamp(input.leaseExpiresAt, "AUTO_LISTING_AI_MODEL_SYNC_COMMAND_INVALID"),
    correlationId: id(input.correlationId),
  };
}

function connectionMatches(connection, input) {
  return connection?.id === input.connectionId
    && connection?.accountId === input.accountId
    && connection?.version === input.connectionVersion
    && connection?.status === "ACTIVE";
}

function activeSelectionState(overview, input, models) {
  if (!plainRecord(overview) || !Array.isArray(overview.profiles)) {
    throw serviceError("AUTO_LISTING_AI_MODEL_SYNC_OVERVIEW_INVALID");
  }
  const selected = overview.profiles.find((profile) => profile?.enabled === true
    && profile?.accountId === input.accountId
    && profile?.connectionId === input.connectionId
    && profile?.connectionVersion === input.connectionVersion);
  if (!selected) return "NOT_SELECTED";
  const ids = new Set(models.map((model) => model.id));
  return typeof selected.textModel === "string" && typeof selected.imageModel === "string"
    && ids.has(selected.textModel) && ids.has(selected.imageModel) ? "AVAILABLE" : "MISSING";
}

function hashText(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function failureDetails(error, input) {
  const sourceCode = safeCode(error);
  if (AUTH_CODES.has(sourceCode)) return {
    errorCode: sourceCode,
    errorSafe: "gateway authentication failed",
    retryable: false,
    retryDelayMs: 0,
  };
  const canRetry = retryable(error, sourceCode);
  const hasAnotherAttempt = input.attemptCount < input.maxAttempts;
  return {
    errorCode: sourceCode,
    errorSafe: sourceCode === "GATEWAY_TIMEOUT" ? "gateway request timed out" : "gateway catalog request failed",
    retryable: canRetry,
    retryDelayMs: canRetry && hasAnotherAttempt ? RETRY_DELAYS_MS[input.attemptCount - 1] ?? 0 : 0,
  };
}

async function replayDatabaseResponse(operation) {
  try { return await operation(); } catch (error) {
    if (safeCode(error, "") !== "AUTO_LISTING_AI_SETTINGS_DATABASE_FAILED") throw error;
    return operation();
  }
}

export function createAutoListingAiModelSyncService(rawOptions = {}) {
  const options = dataProperties(rawOptions, FACTORY_KEYS, "AUTO_LISTING_AI_MODEL_SYNC_SERVICE_INVALID");
  const repository = options.repository;
  const gateway = options.gateway;
  const recommendModels = options.recommendModels ?? recommendAutoListingModels;
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const workerId = id(options.workerId, "AUTO_LISTING_AI_MODEL_SYNC_SERVICE_INVALID");
  if (!["loadConnectionForSecretResolution", "loadSettingsOverview", "completeModelSync", "failModelSync"]
    .every((key) => typeof repository?.[key] === "function")
    || typeof gateway?.listModels !== "function" || typeof recommendModels !== "function"
    || typeof clock !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw serviceError("AUTO_LISTING_AI_MODEL_SYNC_SERVICE_INVALID");
  }

  async function fail(input, details) {
    const failure = {
      accountId: input.accountId,
      workerId,
      taskId: input.taskId,
      leaseVersion: input.leaseVersion,
      leaseToken: input.leaseToken,
      correlationId: input.correlationId,
      ...details,
    };
    return replayDatabaseResponse(() => repository.failModelSync(failure));
  }

  return Object.freeze({
    async syncModelCatalog(rawCommand = {}) {
      const input = commandInput(rawCommand);
      let connection;
      try {
        connection = await repository.loadConnectionForSecretResolution({
          accountId: input.accountId,
          connectionId: input.connectionId,
          connectionVersion: input.connectionVersion,
        });
      } catch (error) {
        return fail(input, failureDetails(error, input));
      }
      if (!connectionMatches(connection, input)) {
        return fail(input, {
          errorCode: "AUTO_LISTING_AI_MODEL_SYNC_CONNECTION_STALE",
          errorSafe: "active gateway connection changed",
          retryable: false,
          retryDelayMs: 0,
        });
      }

      let normalized;
      let recommendation;
      let selectionState;
      try {
        normalized = normalizeModels(await gateway.listModels({
          connection,
          correlationId: input.correlationId,
          requestKey: `model-sync:${input.taskId}:${input.leaseVersion}`,
          timeoutMs,
        }));
        recommendation = canonicalJson(recommendModels({ models: normalized.models }));
        selectionState = activeSelectionState(await repository.loadSettingsOverview({
          accountId: input.accountId,
        }), input, normalized.models);
      } catch (error) {
        return fail(input, failureDetails(error, input));
      }

      const syncedAt = timestamp(clock(), "AUTO_LISTING_AI_MODEL_SYNC_CLOCK_INVALID");
      const catalog = {
        schemaVersion: "AUTO_LISTING_AI_MODEL_CATALOG_V1",
        connectionVersion: input.connectionVersion,
        syncedAt,
        requestIdHash: hashText(normalized.requestId),
        activeSelectionState: selectionState,
        models: normalized.models,
        recommendation,
      };
      const completion = {
        accountId: input.accountId,
        workerId,
        taskId: input.taskId,
        leaseVersion: input.leaseVersion,
        leaseToken: input.leaseToken,
        correlationId: input.correlationId,
        catalog,
        capabilityResult: {
          outcome: "NOT_TESTED",
          checkedAt: syncedAt,
          text: false,
          image: false,
        },
      };
      const result = await replayDatabaseResponse(() => repository.completeModelSync(completion));
      if (!result || result.status !== "SUCCEEDED" || typeof result.catalog?.id !== "string") {
        throw serviceError("AUTO_LISTING_AI_MODEL_SYNC_RESULT_INVALID");
      }
      return Object.freeze({
        taskId: input.taskId,
        status: "SUCCEEDED",
        modelCount: normalized.models.length,
        catalogId: result.catalog.id,
        syncedAt,
        activeSelectionState: selectionState,
      });
    },
  });
}
